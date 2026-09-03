/**
 * 最小的 ZIP 写入器 —— 只为测试造 `.pptx`（OOXML 就是一个 zip）。
 *
 * 只写 **stored（不压缩）** 条目：解析器读的是内容，不是压缩率，而 stored 让
 * 这个文件保持在几十行、没有依赖、出错时肉眼可查。
 *
 * 仓库里没有 zip 写入能力（`ziplite.ts` 只读），而 pptx 解析的接线要证明「真的
 * 跑到了」，就必须有一份带连接线的真 pptx —— golden 里那几份都没有连接线。
 */
import { crc32 } from "node:zlib";

interface Entry {
  readonly name: string;
  readonly data: Buffer;
}

/** 造一个 stored-only 的 zip。 */
export function zipOf(files: Record<string, string>): Buffer {
  const entries: Entry[] = Object.entries(files)
    .map(([name, text]) => ({ name, data: Buffer.from(text, "utf8") }));

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const sum = crc32(e.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // 本地文件头签名
    local.writeUInt16LE(20, 4);           // 需要的版本
    local.writeUInt16LE(0, 6);            // 标志位
    local.writeUInt16LE(0, 8);            // 压缩方法 0 = stored
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, e.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    central.writeUInt16LE(20, 4);         // 创建版本
    central.writeUInt16LE(20, 6);         // 需要的版本
    central.writeUInt16LE(0, 10);         // 压缩方法
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);    // 本地头偏移
    centrals.push(central, name);

    offset += local.length + name.length + e.data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // 中央目录结束记录
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, end]);
}

/** 一份能被解析器接受的最小 pptx，`slideXml` 是第一页的 `p:sld` 全文。 */
export function pptxOf(slideXml: string): Buffer {
  return zipOf({
    "[Content_Types].xml":
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + `<Default Extension="xml" ContentType="application/xml"/></Types>`,
    "_rels/.rels":
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Target="ppt/presentation.xml"`
      + ` Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"/></Relationships>`,
    "ppt/presentation.xml":
      `<?xml version="1.0"?><p:presentation`
      + ` xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`
      + ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
      + `<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels":
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Target="slides/slide1.xml"`
      + ` Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"/></Relationships>`,
    "ppt/slides/slide1.xml": slideXml,
  });
}
