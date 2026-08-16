/**
 * 这一批胶水共用的运行时接缝。
 *
 * Python 侧它们全住在 `server.py` 这一个 7051 行的模块里，互相直接调用；TS 侧
 * 拆成了 `server/glue/*.ts`，于是"谁提供 repo、谁提供 `_persist`"必须写出来。
 *
 * **不是 DI 框架**（约定 §10 禁的是给 `Depends()` 造一套 DI）。就是一个普通参数
 * 对象，`serve.ts` 的 `wireServer()` 里现取一次 —— 现取是有意的：`_persist`
 * 背后的租约 TTL 在 lifespan 里会被重算，缓存一份就会继续用旧值。
 */

import type { Repo } from "../../store/repo/protocol.js";
import type { PersistOptions } from "../pipeline/persist.js";
import type { Session } from "../session.js";
import type { ProjectMemory } from "../../kernel/memory/project.js";

/** `kernel.intent.IntentMatch` —— `_drain_queue` 造出来喂给 `_act` 的那个。 */
export interface IntentMatchLike {
  readonly intent: string;
  readonly confidence: number;
  readonly slots: Record<string, unknown>;
  readonly span: string;
  readonly by: string;
}

export interface GlueDeps {
  /** `get_repo()`。**每次调用现取** —— lifespan 会换实例。 */
  readonly repo: () => Repo;
  /** `time.time()`，epoch 秒。可注入只为测试。 */
  readonly now: () => number;
  /** `_persist(s, …)`（`server/pipeline/persist.ts`，接线方绑好 persistDecisions）。 */
  readonly persist: (s: Session, opts?: PersistOptions) => Promise<void>;
  /** `_project_memory(pid)`（`server/routes/projects.ts`）。 */
  readonly projectMemory: (pid: string) => Promise<ProjectMemory>;
  /** `asyncio.create_task(_emit_ai_prompts(s, slot=…))` —— **不等**，但必须挂 catch。 */
  readonly emitAiPrompts: (s: Session, slot: string) => void;
  /**
   * `_act(s, m)`（段 F，`server.py:6416`）—— 意图执行器（真身在 `glue/act.ts`）。
   *
   * **返回类型是 `string | dict`，这是原件的形状**：`_act` 声明的是 `-> str`，
   * 但走 `_outcome(...)` 的那几个分支返回的是 `{kind, facts, fallback}`。
   * 见 `glue/act.ts` 的文件头。
   */
  readonly act: (s: Session, m: IntentMatchLike) => Promise<string | Record<string, unknown>>;
  /** `_publish_turn(s, Speaker.ASSISTANT, text)`（`server/dialogue/memory.ts`）。 */
  readonly publishAssistant: (s: Session, text: string) => void;
  /** `async with _session_mutation(s, kind)` —— 跨 worker 串行一次领域修改。 */
  readonly sessionMutation: <T>(s: Session, kind: string, body: () => Promise<T>) => Promise<T>;
  /** `_restore_dialogue`（`serve.ts` 已落地那一份）。 */
  readonly restoreDialogue: (s: Session) => Promise<void>;
  /**
   * `_preparse`（`glue/preparse.ts`）。**不带 vision** —— hydrate 这条路上重解析是
   * 白跑的（`_preparse` 的默认就是"扫描件只登记不识别"）；带上视觉网关等于每次打开
   * 一个旧会话都重新付费 OCR 一遍。要识别得由用户显式发起。
   */
  readonly preparse: (s: Session) => Promise<void>;
}

/**
 * 跨段的类型接缝。**只是 cast，运行时是同一个对象。**
 *
 * 六个段并行开发时谁也 import 不到别人的 `Session`，于是各自声明了一份结构化的
 * `SessionLike`。它们与 `server/session.ts` 的 `Session` 在**运行时完全一致**，
 * 但结构类型上对不上一处：段 D/E 把 `files` 声明成 `Record<string, unknown> &
 * {name: string}`，而 `SessionFile` 是个没有索引签名的 interface。
 *
 * 写成一个**具名**的接缝而不是散落各处的 `as never`：这样"这里有一处类型没接上"
 * 是能被 grep 出来的一件事。各段合并成一份共同的 `Session` 之后删掉它，就是那次
 * 重构的验收标准。（`serve.ts` 里有同名同义的一份，那是接线层自己的。）
 */
export function seam<T>(v: unknown): T {
  return v as T;
}
