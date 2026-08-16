/**
 * AgentBus —— agent 之间的三种通信方式，全部记账。移植自 Python 侧
 * `kernel/bus/bus.py`。
 *
 * 本内核里 agent 之间**只有三条合法通路**，没有自由对话：
 *
 *   1. **DAG 边**（主通路）—— 上游节点的结构化产出流向下游。由 WorkingSet 承载，
 *      不经过本模块。这是绝大多数通信应该走的路。
 *
 *   2. **黑板**（旁路事实）—— 很多节点都要、但不在直接路径上的共享事实。
 *      append-only、带出处、冲突不覆盖。见 `./blackboard.js`。
 *
 *   3. **定向请求 / 广播**（本模块）—— 需要即时往返的场景：Critic 要求 Actor 为
 *      某个断言举证；调度器广播降级信号。
 *
 * 三者都写事件日志，所以整条协作链路可重放、可审计、可在 UI 上展开。
 *
 * **为什么要这么克制。** 让 agent 自由聊天在 demo 里很好看，在生产上会同时坏掉
 * 三件事：消息顺序不确定 → 重放失效；上下文无界增长 → 成本失控；事后无法回答
 * "谁认定了这件事" → 交付物不可辩护。对 FDE 场景来说第三条是致命的。
 *
 * ── 取消 ──
 * 契约 §2.2：Node 没有真正的任务取消，**不假装有**。这一层留到 scheduler 阶段
 * 统一设计 —— 本模块里没有 `Promise.race`、没有超时、没有 abort 信号。
 */

import { HarnessError, pyRepr } from "../errors.js";
import { EventKind, type Event } from "../events.js";
import { fingerprint } from "../ids.js";
import {
  Blackboard,
  codePointCompare,
  fnmatchcase,
  revisionToDict,
  type Entry,
  type Revision,
} from "./blackboard.js";

/** 通信错误：收件人未注册、消息类型未声明。 */
export class BusError extends HarnessError {
  constructor(message: string) {
    super(message);
    this.name = "BusError";
    Object.setPrototypeOf(this, BusError.prototype);
  }
}

/** 消息信封。 */
export interface Message {
  /** 发件人。字段名沿用 Python 的 `frm`（那边是为了避开关键字 `from`）——
   * TS 本可以叫 `from`，但两侧字段名一一对应比"更好看"值钱。 */
  readonly frm: string;
  readonly to: string; // 定向请求的收件人；广播时是 topic
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly replyTo: string | null;
}

export interface MessageInit {
  readonly frm: string;
  readonly to: string;
  readonly kind: string;
  readonly payload?: Record<string, unknown>;
  readonly replyTo?: string | null;
}

export function makeMessage(p: MessageInit): Message {
  return Object.freeze({
    frm: p.frm,
    to: p.to,
    kind: p.kind,
    payload: p.payload ?? {},
    replyTo: p.replyTo ?? null,
  });
}

/** 定向请求处理器。同步异步均可。 */
export type Handler = (msg: Message) => unknown | Promise<unknown>;
/** 广播订阅者。**必须无副作用地处理**（只更新本地状态），否则会破坏重放。 */
export type Subscriber = (msg: Message) => void;

/**
 * Recorder 里被 bus 用到的那一小块。
 *
 * **为什么是结构化接口而不是 `import { Recorder }`**：`kernel/recorder.ts` 与本
 * 文件在同一波并行迁移里，各自独立落地。这里声明 bus 真正依赖的最小面，等
 * Recorder 落地后它应当**结构上**满足这个接口，不需要改本文件。若届时签名对不上
 * （最可能的分歧点：`emit` 的关键字参数怎么退化、`journal.read` 是否异步），
 * 以 Recorder 为准改这里的接口声明，别去改 Recorder。
 */
export interface RecorderLike {
  readonly runId: string;
  readonly journal: {
    /** 同步返回或返回 Promise 都能接：一次 Run 只在 resume 时读一次，
     * 到底走 `readFileSync` 还是异步 IO 由 journal 那边定。 */
    read(runId: string): Iterable<Event> | PromiseLike<Iterable<Event>>;
  };
  emit(
    kind: EventKind,
    opts?: {
      nodeId?: string | null;
      payload?: Record<string, unknown>;
      ref?: string | null;
    },
  ): Event;
  effect(
    nodeId: string,
    kind: string,
    request: Record<string, unknown>,
    fn: () => unknown | Promise<unknown>,
    opts?: { key?: string | null },
  ): Promise<unknown>;
}

export interface PostOptions {
  readonly by: string;
  readonly support?: readonly string[];
  readonly confidence?: number;
  readonly note?: string;
}

export interface RequestOptions {
  readonly frm: string;
  readonly to: string;
  readonly kind: string;
  readonly payload?: Record<string, unknown> | null;
  /** 同一节点内并发发多个请求时必须给，否则计数器顺序不稳定。 */
  readonly key?: string | null;
}

export interface BroadcastOptions {
  readonly frm: string;
  readonly topic: string;
  readonly payload?: Record<string, unknown> | null;
}

/** 把黑板、定向请求、广播统一到一个入口，并全部接到事件日志上。 */
export class AgentBus {
  readonly rec: RecorderLike;
  board: Blackboard;
  private readonly handlers = new Map<string, Handler>();
  private readonly subs: [string, Subscriber][] = [];

  constructor(recorder: RecorderLike, blackboard?: Blackboard) {
    this.rec = recorder;
    // Python 侧这行写的是 `Blackboard() if blackboard is None else blackboard`，
    // 注释解释了原因：Blackboard 定义了 `__len__`，空黑板是 falsy，用 `or` 会把
    // 调用方传进来的共享黑板悄悄替换成一个新的空黑板。JS 里对象恒为真值，这个
    // 坑不存在 —— 但 `??` 仍然是对的写法，注释留着是因为那条经验对任何"用真值性
    // 代替 None 判断"的地方都成立。
    this.board = blackboard ?? new Blackboard();
  }

  // ══════════════════════════════════════════════════════════
  //  黑板
  // ══════════════════════════════════════════════════════════
  /**
   * 写黑板并记事件。
   *
   * 返回 `[revision, newlyContested]`。新产生分歧时事件里带 `contested: true`，
   * 调度器据此把这个 key 推进冲突队列。
   */
  post(key: string, value: unknown, opts: PostOptions): [Revision, boolean] {
    const [rev, newly] = this.board.write(key, value, {
      by: opts.by,
      support: opts.support ?? [],
      confidence: opts.confidence ?? 0.5,
      note: opts.note ?? "",
    });
    this.rec.emit(EventKind.BLACKBOARD_WRITE, {
      nodeId: opts.by,
      // `contested` 放在最后：它会覆盖同名键（Revision 没有这个字段，所以实际
      // 只是追加），键序与 Python 的 `{**rev.to_dict(), "contested": newly}` 一致。
      payload: { ...revisionToDict(rev), contested: newly },
    });
    return [rev, newly];
  }

  read(key: string, defaultValue: unknown = null): unknown {
    return this.board.read(key, defaultValue);
  }

  contested(): Entry[] {
    return this.board.contested();
  }

  /**
   * 从事件日志重建黑板。恢复 Run 时调用一次。
   *
   * **与 Python 的形态差异**：那边是同步方法，这里返回 Promise —— journal 的读
   * 在 Node 上可能是异步 IO，而这是每个 Run 只调一次的冷路径，把 async 收在这里
   * 比逼 journal 提供一个同步读要干净。
   */
  async restoreBoard(): Promise<number> {
    const events = await this.rec.journal.read(this.rec.runId);
    const revs: Record<string, unknown>[] = [];
    for (const ev of events) {
      if (ev.kind === EventKind.BLACKBOARD_WRITE) revs.push(ev.payload);
    }
    this.board = new Blackboard();
    this.board.replay(revs);
    return revs.length;
  }

  // ══════════════════════════════════════════════════════════
  //  定向请求 / 响应
  // ══════════════════════════════════════════════════════════
  /** 注册一个可被定向请求的 agent。 */
  register(name: string, handler: Handler): void {
    this.handlers.set(name, handler);
  }

  /**
   * 向另一个 agent 发起请求并等待回复。
   *
   * 典型用途：Critic 发现某个断言可疑，请 Actor 为它举证（CRITIC 那篇论文的
   * "工具交互式批判"在多 agent 下的形态）。
   *
   * 走 `Recorder.effect`，所以重放时直接读回历史回复，不会二次调用对方
   * （对方内部可能是个昂贵的 LLM 调用）。
   */
  async request(opts: RequestOptions): Promise<unknown> {
    const { frm, to, kind } = opts;
    const handler = this.handlers.get(to);
    if (handler === undefined) {
      // 消息里两处 Python 专属格式化都要对齐，否则 `'不存在'` 会变成 `"不存在"`：
      //   `{to!r}`        → errors.ts 的 pyRepr（单引号、按 CPython 的转义宽度）
      //   `{sorted(...)}` → list 的 str()，即 `['a', 'b']`（逗号+空格，元素走 repr）
      // list repr 只有这一行，就地写；dag.ts 有个同形的 pyReprList，但从 bus 引
      // dag 会凭空造出一条 Python 侧不存在的模块依赖。
      const known = [...this.handlers.keys()].sort(codePointCompare);
      const knownRepr = `[${known.map(pyRepr).join(", ")}]`;
      throw new BusError(`收件人未注册: ${pyRepr(to)}（已注册: ${knownRepr}）`);
    }

    const payload = opts.payload ?? {};
    const msg = makeMessage({ frm, to, kind, payload });
    const req = { to, kind, payload };
    const ekey = opts.key ?? `msg:${to}:${kind}:${fingerprint(req)}`;

    this.rec.emit(EventKind.MESSAGE_SENT, {
      nodeId: frm,
      payload: { to, kind, mode: "request" },
    });

    // Python 是 `out = handler(msg); if hasattr(out, "__await__"): out = await out`。
    // JS 的 await 对非 thenable 直接放行，语义等价（只多一个微任务的延迟，
    // 而这里的返回值本来就要穿过 effect 的 await）。
    const call = async (): Promise<unknown> => handler(msg);

    return this.rec.effect(frm, "bus.request", req, call, { key: ekey });
  }

  // ══════════════════════════════════════════════════════════
  //  广播
  // ══════════════════════════════════════════════════════════
  /**
   * 按 glob 订阅广播。
   *
   * 订阅者**必须无副作用**（只改本地状态，不调外部服务、不产生新 effect），
   * 否则重放时会产生不一致。需要副作用的场景请走定向请求。
   */
  subscribe(topicPattern: string, sub: Subscriber): void {
    this.subs.push([topicPattern, sub]);
  }

  /**
   * 广播控制信号或事实通告。无回复。
   *
   * 用于降级通知、取消信号、"我发现了一个新术语"这类通告。
   */
  broadcast(opts: BroadcastOptions): number {
    const { frm, topic } = opts;
    const payload = opts.payload ?? {};
    const msg = makeMessage({ frm, to: topic, kind: "broadcast", payload });
    let n = 0;
    for (const [pattern, sub] of this.subs) {
      if (fnmatchcase(topic, pattern)) {
        sub(msg);
        n += 1;
      }
    }
    // payload 展开在最后 —— 它**可以覆盖** topic/mode/receivers。照抄 Python 的
    // `{"topic":…, "mode":…, "receivers": n, **(payload or {})}`：JS 的展开在
    // 覆盖同名键时保留键的原始位置，与 Python dict 的行为一致。
    this.rec.emit(EventKind.MESSAGE_SENT, {
      nodeId: frm,
      payload: { topic, mode: "broadcast", receivers: n, ...payload },
    });
    return n;
  }

  // ══════════════════════════════════════════════════════════
  //  渲染
  // ══════════════════════════════════════════════════════════
  /** 黑板事实的 prompt 形态，装进 L1 working 层。 */
  renderFacts(pattern = "*"): string {
    return this.board.render(pattern);
  }
}
