/**
 * Kernel 异常 —— 与 Python 侧 `kernel/errors.py` 一一对应，消息字节由
 * golden/errors.json 钉住。
 *
 * 分两类：
 *   - HarnessError 及其子类：编排层自己的问题，通常是 bug 或配置错误，不重试。
 *   - NodeFailure：节点执行失败，调度器可按策略重试或降级。
 *
 * **NodeFailure / HumanInputRequired 不是 HarnessError 的子类**（Python 侧它们
 * 直接继承 Exception）。scheduler 靠这个区分来分派 catch 分支，别顺手把它们挂到
 * HarnessError 下面"整齐一点" —— 那会让 `except HarnessError` 那一路开始吞掉
 * 本该重试的节点失败。golden 里的 hierarchy 就是钉这个的。
 *
 * 每个类都写 `Object.setPrototypeOf` —— 目标是 ES2023、原生 class 本来不需要，
 * 但只要有一天构建目标降到 ES5（或被 esbuild 的 downlevel 处理），少了这行
 * `instanceof` 会静默失效：所有 catch 分支一起失灵，而且不报错。这行的成本是零。
 */

// ── Python 格式化原语的移植 ────────────────────────────────────────
// 消息里有两个 Python 专属的格式化：`{x:.0f}` 和 `{s!r}`。JS 的"看起来一样"的
// 那两个（toFixed / JSON.stringify）在每一处细节上都不一样，直接用必错。

/**
 * Python `format(x, ".0f")`。**不要**用 `x.toFixed(0)` 代替，四处都不同：
 *
 *   x        CPython .0f              JS toFixed(0)
 *   0.5      "0"（round-half-even）    "1"（half away from zero）
 *   -2.5     "-2"                      "-3"
 *   1e21     "1000000000000000000000"  "1e+21"（≥1e21 转指数）
 *   1.23e20  "123456789012345683968"   String() 给 shortest round-trip，位数不同
 *   inf/nan  "inf" / "nan"             "Infinity" / "NaN"
 *
 * 最后一行看着无所谓，但 server.py:799 是拿**整条消息做子串匹配**来判"欠费"的，
 * 消息里混进 "Infinity" 不会让匹配失败，可它会原样出现在用户看到的文案里。
 *
 * `.5` 恰好落在半整数上时才需要 round-half-even，而半整数在 |x| < 2^52 内是精确
 * 可表示的，所以 `frac === 0.5` 这个判据是精确的、不存在浮点误差。
 */
export function formatFixed0(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";

  const f = Math.floor(x);
  const frac = x - f; // f 精确，且 frac 是 x 的低位残余，这个减法无误差
  let r: number;
  if (frac > 0.5) r = f + 1;
  else if (frac < 0.5) r = f;
  else r = f % 2 === 0 ? f : f + 1; // 恰好半整数：向偶数舍入（银行家舍入）

  // Python 对 -0.4 / -0.0 / -0.5 都给 "-0"：符号来自输入而不是结果。
  if (r === 0) return x < 0 || Object.is(x, -0) ? "-0" : "0";

  // 超出安全整数范围就走 BigInt：String(number) 给的是 shortest round-trip
  // （"123456789012345680000"），而 Python 打印的是 double 的**精确值**
  // （"123456789012345683968"）。顺带解决 ≥1e21 转指数记号的问题。
  return Number.isSafeInteger(r) ? String(r) : BigInt(r).toString();
}

/**
 * Python 的 `str.isprintable()`。
 *
 * CPython 的判据是 Unicode 分类落在 Cc/Cf/Cs/Co/Cn/Zl/Zp/Zs —— 恰好就是
 * `\p{C}` ∪ `\p{Z}`，唯一的例外是 ASCII 空格（Zs 但可打印）。
 * 已对 0..0x10FFFF 全量比对过 CPython（跳过代理区），零个不一致，所以这不是
 * 近似，是等价 —— 不需要拖一张 unicodedata 分类表进来。
 *
 * 代理区在 JS 里要单独判：串里可能存在落单的代理码元，`for...of` 会原样吐出来，
 * 而它属于 Cs，Python 侧同样算不可打印。
 */
function isUnprintable(cp: number): boolean {
  if (cp === 0x20) return false; // ASCII 空格：Zs 但可打印
  if (cp >= 0xd800 && cp <= 0xdfff) return true; // 落单代理 = Cs
  return /[\p{C}\p{Z}]/u.test(String.fromCodePoint(cp));
}

/**
 * Python `repr(s)`（str 专用）。**不要**用 `JSON.stringify` 代替：Python 默认用
 * 单引号，且只在"串里有 ' 而没有 \"" 时才改用双引号来少转义一次。effect key
 * 形如 `EXTRACT#0`，最常见的路径上两者就已经不一样了。
 *
 * 不可打印字符按 CPython 的宽度规则转义：`\xNN` / `\uNNNN` / `\UNNNNNNNN`。
 * 这一条最初被当作「不值得为诊断消息拖进 Unicode 表」的已知分叉放过了，后来
 * dag 的环检测消息要 repr 一串节点 id，分叉就有了第二个宿主 —— 而判据本身
 * 只有一行正则。修在这里，两边同时受益。
 */
export function pyRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += "\\" + ch;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else {
      const cp = ch.codePointAt(0)!;
      if (cp < 0x20 || cp === 0x7f) out += "\\x" + cp.toString(16).padStart(2, "0");
      else if (!isUnprintable(cp)) out += ch;
      else if (cp < 0x100) out += "\\x" + cp.toString(16).padStart(2, "0");
      else if (cp < 0x10000) out += "\\u" + cp.toString(16).padStart(4, "0");
      else out += "\\U" + cp.toString(16).padStart(8, "0");
    }
  }
  return out + quote;
}

// ── 异常类 ─────────────────────────────────────────────────────────
/**
 * Python 的 `ValueError`。
 *
 * 收在这里而不是各模块自己定义：**两份同名类就是两个类身份**，
 * `instanceof ValueError` 会漏掉其中一份，而且不报错 —— onto/canonical.ts 与
 * onto/questions.ts 一度各有一份，正是这个形状。
 *
 * message 必须与 Python 逐字节对齐：server 层是拿 message 做子串匹配来分辨
 * 「输入非法」与「内部炸了」的。
 */
export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
    Object.setPrototypeOf(this, ValueError.prototype); // 保住 instanceof
  }
}


/** 内核层错误基类。 */
export class HarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessError";
    Object.setPrototypeOf(this, HarnessError.prototype);
  }
}

/** DAG 定义非法：环、悬空依赖、重复节点 id。 */
export class DagError extends HarnessError {
  constructor(message: string) {
    super(message);
    this.name = "DagError";
    Object.setPrototypeOf(this, DagError.prototype);
  }
}

/**
 * 计划冻结后仍试图修改拓扑。
 *
 * 这是安全边界而非普通错误 —— 间接提示注入的主要防线就是让材料内容
 * 无法改变 DAG 结构（见架构文档 §4.5.1）。
 */
export class FrozenPlanViolation extends HarnessError {
  constructor(message: string) {
    super(message);
    this.name = "FrozenPlanViolation";
    Object.setPrototypeOf(this, FrozenPlanViolation.prototype);
  }
}

/**
 * 重放时重算出的 effect 请求与历史记录不一致。
 *
 * 说明工作流代码里混进了未经记账的非确定性（时间、随机、字典序、
 * 直接调用外部服务），必须修代码而不是放宽检查。
 */
export class DeterminismViolation extends HarnessError {
  readonly key: string;
  readonly recorded: string;
  readonly replayed: string;

  constructor(key: string, recorded: string, replayed: string) {
    super(`effect ${pyRepr(key)} 重放不一致\n  已记录: ${recorded}\n  重算出: ${replayed}`);
    this.key = key;
    this.recorded = recorded;
    this.replayed = replayed;
    this.name = "DeterminismViolation";
    Object.setPrototypeOf(this, DeterminismViolation.prototype);
  }
}

/**
 * 预算耗尽。
 *
 * 消息格式串**逐字锁死**：server.py:799 在异常链认不出类型时会退化成
 * `if "usd 预算耗尽" in text` 的文本兜底（真实场景：抽取节点里欠费，异常被
 * 中间层包过一层，链上认不出来）。改措辞、改空格、把 dimension 挪到后面，
 * 那条兜底就静默失效 —— 用户看到的不再是"余额不足"而是一条裸报错。
 *
 * 注意参数顺序：构造是 (limit, spent)，消息里是 **spent / limit**。
 */
export class BudgetExhausted extends HarnessError {
  readonly dimension: string;
  readonly limit: number;
  readonly spent: number;

  constructor(dimension: string, limit: number, spent: number) {
    super(`${dimension} 预算耗尽: ${formatFixed0(spent)} / ${formatFixed0(limit)}`);
    this.dimension = dimension;
    this.limit = limit;
    this.spent = spent;
    this.name = "BudgetExhausted";
    Object.setPrototypeOf(this, BudgetExhausted.prototype);
  }
}

/** 工具被安全闸拒绝（未注册、描述指纹变更、参数越权）。 */
export class ToolDenied extends HarnessError {
  constructor(message: string) {
    super(message);
    this.name = "ToolDenied";
    Object.setPrototypeOf(this, ToolDenied.prototype);
  }
}

/** 沙箱执行失败（超时、越权、产物校验不过）。 */
export class SandboxError extends HarnessError {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
    Object.setPrototypeOf(this, SandboxError.prototype);
  }
}

/** 节点执行失败。调度器据 retryable 决定是否重试。 */
export class NodeFailure extends Error {
  readonly nodeId: string;
  readonly reason: string;
  readonly retryable: boolean;

  // Python 侧 retryable 是 keyword-only（`*, retryable: bool = True`）。TS 没有
  // 关键字参数，这里退化成第三个位置参数 —— 调用点务必写全，别靠位置记忆。
  constructor(nodeId: string, reason: string, retryable = true) {
    super(`[${nodeId}] ${reason}`);
    this.nodeId = nodeId;
    this.reason = reason;
    this.retryable = retryable;
    this.name = "NodeFailure";
    Object.setPrototypeOf(this, NodeFailure.prototype);
  }
}

/**
 * 节点需要人的决策才能继续。
 *
 * 不是错误 —— 调度器捕获后挂起整个 Run，等 HumanDecisionRecorded 事件到达
 * 再从当前 checkpoint 恢复。
 *
 * **张力（明知故犯）**：它语义上是「挂起信号」，做成 Error 子类是在用异常做
 * 控制流。之所以照 Python 原样保留：scheduler 有四处 catch 分支按它分派
 * （scheduler.py:138 / 204 / 212 及外层的 RunOutcome 契约），改成非 Error 的
 * 返回值型信号要连带重写那四处的控制流。那是 scheduler 那一轮的事，不是这一
 * 轮的 —— 在异常层单方面改型只会让两边的行为在中途分叉。
 */
export class HumanInputRequired extends Error {
  readonly nodeId: string;
  readonly requestId: string;
  readonly payload: Record<string, unknown>;

  constructor(nodeId: string, requestId: string, payload: Record<string, unknown>) {
    super(`[${nodeId}] 等待人工决策 ${requestId}`);
    this.nodeId = nodeId;
    this.requestId = requestId;
    // 不复制：Python 侧存的就是同一个 dict 引用，调度器随后把它原样塞进事件
    // payload。这里一复制，调用方"抛出后再改 payload"的行为就和 Python 分叉了。
    this.payload = payload;
    this.name = "HumanInputRequired";
    Object.setPrototypeOf(this, HumanInputRequired.prototype);
  }
}
