/**
 * Python sidecar 的客户端 —— 迁移约定 §2.3 里那三样不迁的东西的唯一入口。
 *
 * 为什么有这个进程（判断在 `sidecar/app.py` 的文件头，这里只记结论）：
 *   · `code.exec` 跑的**就是** Python（模型写 pandas 做数据变换），换宿主语言
 *     不消除这个依赖；沙箱因此必须留在 Python，sidecar 跑不掉。
 *   · 既然进程跑不掉，`sqlglot`（DDL 多方言）和 `pymupdf`（PDF→图）搭车几乎免费。
 *
 * ── 这一层的三条纪律 ──────────────────────────────────────────
 *
 * 1. **不在这里重新实现任何逻辑。** 它只做序列化和错误映射。sidecar 那边直接调
 *    `ontocopilot.*` 的现成模块，两个宿主因此看到同一份行为。
 *
 * 2. **失败要能区分「没起来」和「跑错了」。** 前者是部署问题（提示用户起进程），
 *    后者是业务错误（照常进 journal）。混在一起的话，一次忘启 sidecar 会以
 *    「DDL 解析失败」的形态出现在用户面前，排查方向整个跑偏。
 *
 * 3. **token 不进日志、不进错误消息。** 它是本机任意代码执行的钥匙。
 */

import { SandboxError } from "../kernel/errors.js";

/** 与 Python `ExecResult.to_dict()` 逐字段一致 —— 字段名保持 snake_case，
 *  因为这份 dict 会**原样**作为 `code.exec` 的工具返回值进模型上下文和 journal。
 *  在这里改成 camelCase 等于把工具的对外契约改了。 */
export interface ExecResult {
  readonly ok: boolean;
  readonly exit_code: number | null;
  readonly duration_ms: number;
  readonly stdout: string;
  readonly stderr: string;
  /** 产物文件名列表（Python 侧 `list(self.artifacts)` 只取键）。 */
  readonly artifacts: readonly string[];
  /** `/out/result.json` 的内容，也就是沙箱里 `emit()` 交回的东西。 */
  readonly result: unknown;
  /** 静态扫描命中的可疑模式。**不是安全边界**，是记账与告警。 */
  readonly flags: readonly string[];
}

/** `ParsedDoc` 的线上形态。同样保持 snake_case —— 下游 evidence 层按这些键存。 */
export interface ParsedChunk {
  readonly chunk_id: string;
  readonly locator: string;
  readonly render: string;
  readonly raw: string;
  readonly order: number;
  readonly tags: Readonly<Record<string, unknown>>;
}

export interface ParsedFinding {
  readonly kind: string;
  readonly message: string;
  readonly locator: string;
  readonly severity: string;
}

export interface ParsedDoc {
  readonly file_id: string;
  readonly file_name: string;
  readonly kind: string;
  readonly structured: Readonly<Record<string, unknown>>;
  readonly chunks: readonly ParsedChunk[];
  readonly findings: readonly ParsedFinding[];
}

/**
 * sidecar 进程本身不可用（没起、起错端口、token 不对、网络层报错）。
 *
 * 与业务错误分开的理由见文件头 2：这条对应的动作是「去起进程」，不是「改材料」。
 */
export class SidecarUnavailable extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "SidecarUnavailable";
    Object.setPrototypeOf(this, SidecarUnavailable.prototype);
  }
}

export interface SidecarConfig {
  readonly baseUrl: string;
  readonly token: string;
  /** 单次请求的超时（毫秒）。默认给沙箱墙钟上限（180s）留足余量。 */
  readonly timeoutMs: number;
}

export const SIDECAR_DEFAULTS = {
  baseUrl: "http://127.0.0.1:8712",
  timeoutMs: 200_000,
} as const;

/**
 * 从环境变量装配。**token 缺失直接抛**，不给一个「反正会 401」的半成品实例 ——
 * 让配置错误在启动时炸，而不是在用户点了「解析 DDL」之后炸。
 */
export function sidecarFromEnv(env: NodeJS.ProcessEnv = process.env): SidecarConfig {
  const token = env["ONTOCOPILOT_SIDECAR_TOKEN"] ?? "";
  if (!token) {
    throw new SidecarUnavailable(
      "ONTOCOPILOT_SIDECAR_TOKEN 未设置 —— sidecar 承载沙箱/DDL/PDF，必须配 token",
    );
  }
  const port = env["ONTOCOPILOT_SIDECAR_PORT"];
  return {
    baseUrl: port ? `http://127.0.0.1:${port}` : SIDECAR_DEFAULTS.baseUrl,
    token,
    timeoutMs: SIDECAR_DEFAULTS.timeoutMs,
  };
}

export class SidecarClient {
  constructor(private readonly cfg: SidecarConfig) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    // AbortSignal.timeout 而不是自己 setTimeout：后者会把进程的事件循环拖住
    // （Node 上一个未 unref 的 timer 足以让进程不退出）。
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-sidecar-token": this.cfg.token },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (e) {
      // 连不上 / 超时 —— 一律算进程不可用。**不带 token**，只带地址。
      throw new SidecarUnavailable(`连不上 sidecar (${this.cfg.baseUrl}${path})`, e);
    }
    if (res.status === 401 || res.status === 500) {
      // 401=token 不匹配，500=sidecar 那边没配 token。两者都是部署问题。
      throw new SidecarUnavailable(`sidecar 拒绝请求 (HTTP ${res.status})`);
    }
    if (!res.ok) {
      // 其余状态码是业务错误（422 校验失败之类），照常往上抛。
      throw new Error(`sidecar ${path} 失败 (HTTP ${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  /** 探活。**不抛** —— 调用方要的是「能不能用」这个布尔，不是异常控制流。 */
  async health(): Promise<{ ok: boolean; capabilities: Record<string, boolean> } | null> {
    try {
      const res = await fetch(`${this.cfg.baseUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return null;
      return (await res.json()) as { ok: boolean; capabilities: Record<string, boolean> };
    } catch {
      return null;
    }
  }

  /**
   * 在沙箱里跑一段 Python。
   *
   * 与 Python 侧 `Sandbox.exec` 的差别只有一处：**不支持 `files` 参数**。
   * 盘点确认 `tools.py` 的 `code.exec` 从来只传 `code` 和 `inputs`（sandbox.py:625），
   * 而跨进程传文件要么共享文件系统、要么把内容塞进 body —— 两条都是为一个没有
   * 调用方的参数付代价。真需要时再加，别先摆一个没人用的通道。
   */
  async exec(code: string, inputs: Record<string, unknown> = {}): Promise<ExecResult> {
    return this.post<ExecResult>("/sandbox/exec", { code, inputs });
  }

  /** 解析 DDL。行内注释是这个解析器最重要的产出（口径冲突全靠它），别丢。 */
  async parseSql(sql: string, opts: { dialect?: string; fileName?: string } = {}) {
    return this.post<ParsedDoc>("/sql/parse", {
      sql,
      dialect: opts.dialect ?? "",
      file_name: opts.fileName ?? "schema.ddl",
    });
  }

  /** PDF 每页渲染成 PNG。返回 base64，调用方自己决定落盘还是直接喂视觉模型。 */
  async renderPdf(pdf: Uint8Array, opts: { maxPages?: number; zoom?: number } = {}) {
    return this.post<{ pages: string[]; truncated: boolean }>("/pdf/render", {
      pdf_b64: Buffer.from(pdf).toString("base64"),
      max_pages: opts.maxPages ?? 20,
      zoom: opts.zoom ?? 2.0,
    });
  }
}

/**
 * 把 sidecar 包装成 `tools.ts` 期望的 sandbox 形状。
 *
 * `code.exec` 那个工具只认一个 `exec(code, inputs) -> dict` 的对象，注册与否取决于
 * 传没传 sandbox（`tools.py:610` 的 `if sandbox is not None`）。所以「sidecar 没起」
 * 的正确表现是**这个工具不出现在动作空间里**，而不是出现之后调用时报错 ——
 * 后者会让模型反复重试一个永远不会成功的工具，把预算烧光。
 */
export interface SandboxLike {
  exec(code: string, inputs?: Record<string, unknown>): Promise<ExecResult>;
}

export async function sandboxViaSidecar(cfg: SidecarConfig): Promise<SandboxLike | null> {
  const client = new SidecarClient(cfg);
  const h = await client.health();
  if (!h?.capabilities["sandbox"]) return null;
  return { exec: (code, inputs) => client.exec(code, inputs ?? {}) };
}

/** `SandboxError` 从内核层复用 —— 沙箱拒绝执行（命中可疑模式）走这个类型。 */
export { SandboxError };
