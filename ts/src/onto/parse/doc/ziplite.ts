/**
 * `zipfile.ZipFile` 的只读最小等价物 —— pptx 就是一个 zip。
 *
 * 同样零依赖（`node:zlib` 是标准库）。要与 Python 对齐的只有三件事：
 *
 *   · `infolist()` 的**顺序和 file_size** —— `presentation.py` 的体积闸门按
 *     解压后大小求和，用压缩后大小会让 zip 炸弹直接穿过闸门；
 *   · 成员缺失时的错误形态 —— Python 抛 `KeyError`，而 `str(KeyError(msg))`
 *     带一层引号，`unparsed_part` 的 finding 文案里能看见；
 *   · 不是 zip 时的消息 —— `"File is not a zip file"`，golden 里钉着。
 *
 * **不支持 Zip64、加密、多卷**。真实 pptx 超过 4 GiB 或 65535 个成员之前，
 * `_MAX_TOTAL_BYTES` 那道 100 MiB 闸门早就先拦下了。
 */

import { inflateRawSync } from "node:zlib";

/** == `zipfile.BadZipFile`。消息文案与 CPython 一致，因为它进 finding。 */
export class BadZipFile extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadZipFile";
    Object.setPrototypeOf(this, BadZipFile.prototype);
  }
}

/** == `archive.read()` 找不到成员时的 `KeyError`。 */
export class ZipMemberMissing extends Error {
  constructor(readonly member: string) {
    super(`There is no item named '${member}' in the archive`);
    this.name = "ZipMemberMissing";
    Object.setPrototypeOf(this, ZipMemberMissing.prototype);
  }
}

/** == `zipfile.ZipInfo` 里本模块真正用到的三个字段。 */
export interface ZipInfo {
  readonly filename: string;
  /** **解压后**大小。体积闸门按它算。 */
  readonly fileSize: number;
  readonly compressSize: number;
  readonly compressType: number;
  readonly headerOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export class ZipArchive {
  private readonly byName = new Map<string, ZipInfo>();

  private constructor(
    private readonly buf: Buffer,
    private readonly infos: readonly ZipInfo[],
  ) {
    for (const info of infos) this.byName.set(info.filename, info);
  }

  static open(buf: Buffer): ZipArchive {
    // EOCD 从尾部倒着找：zip 允许结尾带注释，签名不一定在最后 22 字节。
    const scanFrom = Math.max(0, buf.length - (22 + 0xffff));
    let eocd = -1;
    for (let i = buf.length - 22; i >= scanFrom; i--) {
      if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new BadZipFile("File is not a zip file");

    const count = buf.readUInt16LE(eocd + 10);
    const centralOffset = buf.readUInt32LE(eocd + 16);
    const infos: ZipInfo[] = [];
    let at = centralOffset;
    for (let n = 0; n < count; n++) {
      if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
        throw new BadZipFile("Bad magic number for central directory");
      }
      const nameLen = buf.readUInt16LE(at + 28);
      const extraLen = buf.readUInt16LE(at + 30);
      const commentLen = buf.readUInt16LE(at + 32);
      // general purpose bit 11 表示名字是 UTF-8；没置位时 Python 按 cp437 解。
      // OOXML 的部件名全是 ASCII，两种解码在 ASCII 上等价，所以统一按 UTF-8。
      const nameBytes = buf.subarray(at + 46, at + 46 + nameLen);
      infos.push({
        filename: nameBytes.toString("utf8"),
        compressType: buf.readUInt16LE(at + 10),
        compressSize: buf.readUInt32LE(at + 20),
        fileSize: buf.readUInt32LE(at + 24),
        headerOffset: buf.readUInt32LE(at + 42),
      });
      at += 46 + nameLen + extraLen + commentLen;
    }
    return new ZipArchive(buf, infos);
  }

  /** == `archive.infolist()`：中央目录顺序，就是写入顺序。 */
  infolist(): readonly ZipInfo[] {
    return this.infos;
  }

  /** == `{info.filename for info in infos}`。 */
  nameSet(): Set<string> {
    return new Set(this.infos.map((info) => info.filename));
  }

  /** == `archive.read(name)`。找不到抛 {@link ZipMemberMissing}。 */
  read(name: string): Buffer {
    const info = this.byName.get(name);
    if (info === undefined) throw new ZipMemberMissing(name);
    const at = info.headerOffset;
    if (this.buf.readUInt32LE(at) !== LOCAL_SIGNATURE) {
      throw new BadZipFile(`Bad magic number for file header (${name})`);
    }
    // 本地头里的 name/extra 长度**可以与中央目录不同**（extra 常见不一致），
    // 所以数据偏移只能按本地头自己的两个长度算。
    const dataAt = at + 30 + this.buf.readUInt16LE(at + 26) + this.buf.readUInt16LE(at + 28);
    const raw = this.buf.subarray(dataAt, dataAt + info.compressSize);
    if (info.compressType === 0) return Buffer.from(raw);
    if (info.compressType === 8) return inflateRawSync(raw);
    throw new BadZipFile(`compression type ${info.compressType} is unsupported`);
  }
}

/**
 * == `data[:min(len(data), 64*1024)].upper()` 里对 `<!DOCTYPE` / `<!ENTITY` 的检测。
 *
 * 必须在**字节**上做而不是解码后做：解码一份含实体炸弹的文档本身就是要避免的事。
 * `bytes.upper()` 只大写 ASCII，所以这里也只翻 a–z，非 ASCII 字节原样留着。
 */
export function hasDtdMarker(data: Buffer): boolean {
  const head = Buffer.from(data.subarray(0, Math.min(data.length, 64 * 1024)));
  for (let i = 0; i < head.length; i++) {
    const b = head[i] as number;
    if (b >= 0x61 && b <= 0x7a) head[i] = b - 32;
  }
  return head.includes("<!DOCTYPE", 0, "latin1") || head.includes("<!ENTITY", 0, "latin1");
}
