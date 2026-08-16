/**
 * 鉴权原语 —— 口令散列、登录令牌、用户名规范化。移植自 `auth.py`。
 *
 * 纪律沿用 `kernel/config`：**明文永不落库、永不进日志**。口令只存 scrypt
 * 自描述散列，登录令牌只存 sha256（明文令牌只活在浏览器的 HttpOnly cookie 里）。
 *
 * ── 算法必须与 Python 侧逐位一致 ─────────────────────────────────────────
 *
 * Python 用的是 `hashlib.scrypt(N=2**14, r=8, p=1, dklen=32, maxmem=64MB)`，散列串
 * 形态 `scrypt$N$r$p$salt_hex$hash_hex`。Node 的 `crypto.scrypt` 是同一份 RFC 7914，
 * 同样的参数给出同样的字节 —— 所以 **Python 时代建的账号在 TS 侧照样登得进来**。
 * 这一条由 `test/authgate.test.ts` 用 Python 真跑出来的散列钉住（golden/auth.json）。
 * `maxmem` 必须显式给 64 MB：Node 默认上限 32 MB 虽然够 16 MB 的工作集，但一旦有人
 * 调大 N，默认值会先炸 —— 而 Python 侧那行注释记的正是同一件事的另一面。
 *
 * ── 同步与异步两套 ───────────────────────────────────────────────────────
 *
 * Python 侧本模块只给**纯同步**函数，由调用方（authgate）用 `run_in_threadpool`
 * 丢线程池 —— 因为 scrypt 是 CPU 密集（几十毫秒），直接在 async 路由里调会卡住整个
 * 事件循环、冻住所有 SSE 流。TS 这边对应物是 `crypto.scrypt` 的**回调版**（跑在
 * libuv 线程池里），所以这里给两套：
 *   * `hashPassword` / `verifyPassword`  —— 同步，与 Python 的函数一一对应（CLI 用）；
 *   * `hashPasswordAsync` / `verifyPasswordAsync` —— 异步，== Python 的
 *     `run_in_threadpool(...)`（HTTP 路由必须用这一套）。
 * 本模块**不替调用方决定并发模型**，和 Python 侧一样。
 */

import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";

// Python 的 `ValueError` 在 TS 侧只有一份（`onto/questions.ts`），复用它 ——
// 再定义一个同名类会让 `instanceof` 在跨模块调用时静默失效。
import { ValueError } from "./onto/questions.js";

// scrypt 参数。内存 ≈ 128·N·r ≈ 16 MB —— 对交互式登录足够硬，又不至于拖垮机器。
// 参数写进散列串本身，日后调参不影响旧散列的校验。
const SCRYPT_N = 2 ** 14;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_DKLEN = 32;
// 给足 maxmem（默认上限在某些 OpenSSL 上会顶到 N=2^14 的边界而抛错）。
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** 登录标识统一 `strip().lower()` —— 唯一约束与查找都基于规范化后的值。
 *
 * Python 的 `str.lower()` 与 JS 的 `toLowerCase()` 对绝大多数字符一致；已知分叉是
 * 土耳其语点 I 之类的特殊映射，两边都**不做**语言敏感的折叠（JS 用的是
 * `toLowerCase` 而不是 `toLocaleLowerCase`），所以行为相同。
 * `trim()` 与 `strip()` 的保留集等价见 `kernel/ids.ts` 的说明。 */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/** Python 的 `bytes.fromhex`：允许字节之间夹 ASCII 空白，其余一律 ValueError。
 *
 * **不能用裸的 `Buffer.from(hex, "hex")`** —— 它遇到非法字符会**静默截断**，
 * 于是一个损坏的散列串会被解成一个短 buffer，再跟一段同样短的派生密钥比出
 * `true`。那是一条实打实的越权路径，所以这里先严格校验再解码。 */
function fromHex(s: string): Buffer {
  const compact = s.replace(/[ \t\n\r\v\f]/g, "");
  if (compact.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(compact)) {
    throw new TypeError("non-hexadecimal number found in fromhex() arg");
  }
  return Buffer.from(compact, "hex");
}

/** Python 的 `int(s)`（十进制）。认不出来就抛 —— 与 `int()` 一样，不静默当 NaN。 */
function pyInt(s: string): number {
  const t = s.trim();
  if (!/^[+-]?\d(_?\d)*$/.test(t)) {
    throw new TypeError(`invalid literal for int() with base 10: '${s}'`);
  }
  return Number(t.replaceAll("_", ""));
}

function derive(password: string, salt: Buffer, n: number, r: number, p: number, dklen: number): Buffer {
  return scryptSync(Buffer.from(password, "utf8"), salt, dklen, {
    N: n,
    r,
    p,
    maxmem: SCRYPT_MAXMEM,
  });
}

function deriveAsync(
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
  dklen: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      Buffer.from(password, "utf8"),
      salt,
      dklen,
      { N: n, r, p, maxmem: SCRYPT_MAXMEM },
      (err, dk) => {
        if (err) reject(err);
        else resolve(dk);
      },
    );
  });
}

function encode(salt: Buffer, dk: Buffer): string {
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${dk.toString("hex")}`;
}

/** 拆散列串。任何一处不合规都抛 —— 由调用方转成 `false`（Python 是同一个形状：
 * 拆解与派生都在同一个 try 里，`except (ValueError, TypeError): return False`）。 */
function decode(encoded: string): { salt: Buffer; expected: Buffer; n: number; r: number; p: number } {
  const parts = encoded.split("$");
  if (parts.length !== 6) throw new TypeError("not enough values to unpack");
  const [scheme, n, r, p, saltHex, hashHex] = parts as [string, string, string, string, string, string];
  if (scheme !== "scrypt") throw new TypeError("unknown scheme");
  const expected = fromHex(hashHex);
  // **零长度散列必须当场拒**。Python 那边 `hashlib.scrypt(dklen=0)` 会抛
  // ValueError（于是 verify_password 回 False），Node 的 `scryptSync(keylen=0)`
  // 却老老实实返回一个空 buffer —— 再跟同样为空的 expected 比，`任何口令`都能
  // 验过 `scrypt$16384$8$1$$`。这不是理论风险：谁往 password_hash 列里写了个
  // 半截串（迁移脚本、手工改库），那个账号就对全世界敞开。
  if (expected.length === 0) throw new TypeError("empty digest");
  return {
    salt: fromHex(saltHex),
    expected,
    n: pyInt(n),
    r: pyInt(r),
    p: pyInt(p),
  };
}

/** 常数时间比对。长度不同直接 `false` —— `timingSafeEqual` 长度不等会**抛**，
 * 而 Python 的 `hmac.compare_digest` 只是返回 False。 */
function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 返回自描述散列串 `scrypt$N$r$p$salt_hex$hash_hex`。
 *
 * @throws 口令为空。空口令永远不该产生一个"看起来有效"的散列。 */
export function hashPassword(password: string): string {
  if (!password) throw new ValueError("口令不能为空");
  const salt = randomBytes(16);
  return encode(salt, derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_DKLEN));
}

/** {@link hashPassword} 的线程池版 == Python 的 `run_in_threadpool(hash_password, …)`。 */
export async function hashPasswordAsync(password: string): Promise<string> {
  if (!password) throw new ValueError("口令不能为空");
  const salt = randomBytes(16);
  const dk = await deriveAsync(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_DKLEN);
  return encode(salt, dk);
}

/** 常数时间比对。散列串损坏 / 方案不认识一律返回 `false`，不抛。 */
export function verifyPassword(password: string, encoded: string): boolean {
  let dk: Buffer;
  let expected: Buffer;
  try {
    const d = decode(encoded);
    expected = d.expected;
    dk = derive(password, d.salt, d.n, d.r, d.p, expected.length);
  } catch {
    // Python 只吞 ValueError/TypeError；Node 的 scrypt 参数错抛的是普通 Error
    // （ERR_CRYPTO_INVALID_SCRYPT_PARAMS），语义上属于同一类"散列串不可用"。
    return false;
  }
  return constantTimeEqual(dk, expected);
}

/** {@link verifyPassword} 的线程池版 == Python 的 `run_in_threadpool(verify_password, …)`。 */
export async function verifyPasswordAsync(password: string, encoded: string): Promise<boolean> {
  let dk: Buffer;
  let expected: Buffer;
  try {
    const d = decode(encoded);
    expected = d.expected;
    dk = await deriveAsync(password, d.salt, d.n, d.r, d.p, expected.length);
  } catch {
    return false;
  }
  return constantTimeEqual(dk, expected);
}

/** 铸一个登录令牌。返回 `[明文令牌, tokenHash]`。
 *
 * 明文进 cookie，只有 {@link tokenHash} 入库 —— 库泄了也换不出 cookie。
 * `secrets.token_urlsafe(32)` == 32 随机字节的 base64url（去掉填充），43 个字符。 */
export function mintToken(): [string, string] {
  const token = randomBytes(32).toString("base64url");
  return [token, tokenHash(token)];
}

/** cookie 明文令牌 → 入库主键（sha256 十六进制）。 */
export function tokenHash(token: string): string {
  return createHash("sha256").update(Buffer.from(token, "utf8")).digest("hex");
}
