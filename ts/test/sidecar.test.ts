/**
 * sidecar 客户端 —— 这一层没有算法，只有**错误分类**和**契约字段名**，测试就盯这两样。
 *
 * 1. 「进程没起」必须与「业务失败」分开。混在一起的话，一次忘启 sidecar 会以
 *    「DDL 解析失败」的形态出现在用户面前，排查方向整个跑偏。
 * 2. 返回体的字段名是 snake_case 且**不许改** —— `code.exec` 的返回值原样进模型
 *    上下文和 journal，改字段名等于改工具的对外契约。
 * 3. token 不进任何错误消息。它是本机任意代码执行的钥匙。
 *
 * 末尾还有一组**真打 Python 进程**的用例：sidecar 没起时自动跳过，起了就跑，
 * 用来证明「行为零漂移」不是口号。起法见用例里的注释。
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  SidecarClient,
  SidecarUnavailable,
  sandboxViaSidecar,
  sidecarFromEnv,
  type SidecarConfig,
} from "../src/sidecar/client.js";

const CFG: SidecarConfig = {
  baseUrl: "http://127.0.0.1:9",
  token: "s3cr3t-token-do-not-leak",
  timeoutMs: 500,
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** 用一个假的 fetch 顶掉真的，返回它收到的请求供断言。 */
type FetchInput = Parameters<typeof fetch>[0];

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const seen: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    const url = String(input);
    seen.push(init === undefined ? { url } : { url, init });
    return handler(url, init);
  }) as typeof fetch;
  return seen;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("配置装配", () => {
  it("没有 token 直接抛 —— 不给一个「反正会 401」的半成品", () => {
    // 让配置错误在启动时炸，而不是在用户点了「解析 DDL」之后炸。
    expect(() => sidecarFromEnv({})).toThrow(SidecarUnavailable);
    expect(() => sidecarFromEnv({})).toThrow(/ONTOCOPILOT_SIDECAR_TOKEN/);
  });

  it("端口默认 8712（不是特权端口）", () => {
    const cfg = sidecarFromEnv({ ONTOCOPILOT_SIDECAR_TOKEN: "t" });
    expect(cfg.baseUrl).toBe("http://127.0.0.1:8712");
    // <1024 需要 root。一个只监听回环的辅助进程没有理由要 root。
    expect(Number(new URL(cfg.baseUrl).port)).toBeGreaterThan(1023);
  });

  it("只监听回环 —— 默认地址不能是 0.0.0.0 或外部主机", () => {
    const cfg = sidecarFromEnv({ ONTOCOPILOT_SIDECAR_TOKEN: "t", ONTOCOPILOT_SIDECAR_PORT: "9001" });
    expect(new URL(cfg.baseUrl).hostname).toBe("127.0.0.1");
  });
});

describe("错误分类：部署问题 vs 业务失败", () => {
  it("401（token 不匹配）算进程不可用", async () => {
    stubFetch(() => json({ detail: "sidecar token 不匹配" }, 401));
    await expect(new SidecarClient(CFG).exec("x")).rejects.toThrow(SidecarUnavailable);
  });

  it("500（sidecar 那边没配 token）也算进程不可用", async () => {
    stubFetch(() => json({ detail: "ONTOCOPILOT_SIDECAR_TOKEN 未设置" }, 500));
    await expect(new SidecarClient(CFG).parseSql("CREATE TABLE t (a INT);")).rejects.toThrow(
      SidecarUnavailable,
    );
  });

  it("连不上（进程没起）算进程不可用，且带上地址方便排查", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(new SidecarClient(CFG).exec("x")).rejects.toThrow(SidecarUnavailable);
    await expect(new SidecarClient(CFG).exec("x")).rejects.toThrow(/127\.0\.0\.1:9/);
  });

  it("422 这类校验失败是**业务错误**，不能被归成进程不可用", async () => {
    // 归错了的后果：用户被告知「去起 sidecar」，而进程明明好好跑着。
    stubFetch(() => json({ detail: "bad field" }, 422));
    const p = new SidecarClient(CFG).exec("x");
    await expect(p).rejects.toThrow(/HTTP 422/);
    await expect(p).rejects.not.toThrow(SidecarUnavailable);
  });

  it("原始异常挂在 cause 上，不丢诊断信息", async () => {
    const boom = new TypeError("ECONNREFUSED");
    stubFetch(() => {
      throw boom;
    });
    await new SidecarClient(CFG).exec("x").catch((e: unknown) => {
      expect(e).toBeInstanceOf(SidecarUnavailable);
      expect((e as SidecarUnavailable).cause).toBe(boom);
    });
  });
});

describe("token 不泄露", () => {
  it("token 走请求头，且不出现在任何错误消息里", async () => {
    const seen = stubFetch(() => json({ detail: "nope" }, 401));
    let err: Error | undefined;
    try {
      await new SidecarClient(CFG).exec("x");
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(SidecarUnavailable); // 没抛的话下面全是空断言

    // 确实发出去了
    const headers = seen[0]!.init!.headers as Record<string, string>;
    expect(headers["x-sidecar-token"]).toBe(CFG.token);
    // 但不出现在错误里 —— 错误消息会进日志、进 journal、可能进用户界面
    expect(err!.message).not.toContain(CFG.token);
    expect(String(err!.stack ?? "")).not.toContain(CFG.token);
  });
});

describe("请求体与返回体的字段名（== Python 的对外契约）", () => {
  it("exec 的返回体保持 snake_case —— 它原样进模型上下文和 journal", async () => {
    const body = {
      ok: true,
      exit_code: 0,
      duration_ms: 12,
      stdout: "",
      stderr: "",
      artifacts: [],
      result: { n: 6 },
      flags: [],
    };
    stubFetch(() => json(body));
    const res = await new SidecarClient(CFG).exec("emit({'n': 6})", { xs: [1, 2, 3] });
    // 逐字段，不用 toMatchObject —— 少一个字段下游就静默拿到 undefined
    expect(res).toEqual(body);
  });

  it("exec 请求体的键是 code / inputs", async () => {
    const seen = stubFetch(() => json({ ok: true }));
    await new SidecarClient(CFG).exec("CODE", { a: 1 });
    expect(JSON.parse(seen[0]!.init!.body as string)).toEqual({ code: "CODE", inputs: { a: 1 } });
  });

  it("parseSql 请求体的键是 sql / dialect / file_name（不是 camelCase）", async () => {
    const seen = stubFetch(() => json({ chunks: [] }));
    await new SidecarClient(CFG).parseSql("SELECT 1", { dialect: "postgres", fileName: "a.ddl" });
    expect(JSON.parse(seen[0]!.init!.body as string)).toEqual({
      sql: "SELECT 1",
      dialect: "postgres",
      file_name: "a.ddl",
    });
  });

  it("renderPdf 把字节 base64 化后走 body（两个进程未必共享文件系统）", async () => {
    const seen = stubFetch(() => json({ pages: [], truncated: false }));
    await new SidecarClient(CFG).renderPdf(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    const sent = JSON.parse(seen[0]!.init!.body as string) as { pdf_b64: string };
    expect(Buffer.from(sent.pdf_b64, "base64")).toEqual(Buffer.from([0x25, 0x50, 0x44, 0x46]));
  });
});

describe("sandboxViaSidecar：没起就不注册工具", () => {
  // tools.py:610 是 `if sandbox is not None`，所以「sidecar 没起」的正确表现是
  // code.exec **不出现在动作空间里**，而不是出现之后调用时报错 —— 后者会让模型
  // 反复重试一个永远不会成功的工具，把预算烧光。
  it("探活失败 → null", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    expect(await sandboxViaSidecar(CFG)).toBeNull();
  });

  it("探活通了但 sandbox 能力缺失 → 同样 null", async () => {
    stubFetch(() => json({ ok: true, capabilities: { sandbox: false, sql: true, pdf: true } }));
    expect(await sandboxViaSidecar(CFG)).toBeNull();
  });

  it("能力齐 → 给出可用的 exec", async () => {
    stubFetch((url) =>
      url.endsWith("/health")
        ? json({ ok: true, capabilities: { sandbox: true, sql: true, pdf: true } })
        : json({ ok: true, result: 42 }),
    );
    const sb = await sandboxViaSidecar(CFG);
    expect(sb).not.toBeNull();
    expect((await sb!.exec("x")).result).toBe(42);
  });

  it("health 自己不抛 —— 调用方要的是布尔，不是异常控制流", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(new SidecarClient(CFG).health()).resolves.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
//  真打 Python 进程 —— 证明「行为零漂移」
// ══════════════════════════════════════════════════════════════════
//
// 起法：
//   ONTOCOPILOT_SIDECAR_TOKEN=dev-token .venv/bin/python -m sidecar.app
// 然后带同一个 token 跑：
//   ONTOCOPILOT_SIDECAR_TOKEN=dev-token npx vitest run test/sidecar.test.ts
//
// 没起就整组跳过 —— CI 里不该因为少一个可选进程而全红，但本地一起就必须真跑。

const LIVE_TOKEN = process.env["ONTOCOPILOT_SIDECAR_TOKEN"];

describe.skipIf(!LIVE_TOKEN)("端到端（需要 sidecar 在跑）", () => {
  const live = new SidecarClient({
    baseUrl: process.env["ONTOCOPILOT_SIDECAR_PORT"]
      ? `http://127.0.0.1:${process.env["ONTOCOPILOT_SIDECAR_PORT"]}`
      : "http://127.0.0.1:8712",
    token: LIVE_TOKEN ?? "",
    timeoutMs: 30_000,
  });

  it("探活报出三个钉子", async () => {
    const h = await live.health();
    expect(h?.ok).toBe(true);
    expect(Object.keys(h!.capabilities).sort()).toEqual(["pdf", "sandbox", "sql"]);
  });

  it("沙箱真跑 Python 并把 emit 的结果交回来", async () => {
    const res = await live.exec("emit({'n': sum(INPUTS['xs'])})", { xs: [1, 2, 3, 4] });
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ n: 10 });
  });

  it("DDL 的行内注释必须保住 —— 丢了这个 sidecar 就没有存在的意义", async () => {
    // plan_amount DECIMAL(18,2) 在两张表里长得一模一样，区别全在注释里。
    const doc = await live.parseSql(
      [
        "CREATE TABLE purchase_plan (",
        "  plan_amount DECIMAL(18,2),  -- 含税·年度累计",
        "  dept_code   VARCHAR(32)     -- 归口部门",
        ");",
      ].join("\n"),
    );
    expect(JSON.stringify(doc)).toContain("含税·年度累计");
    expect(JSON.stringify(doc)).toContain("归口部门");
  });

  it("已知缺口：列与 CREATE TABLE 挤在同一行时，注释会丢", async () => {
    // Python 侧 _column_comments 是按行扫描的，命中 `create table` 那行就 continue，
    // 于是同一行上的列注释被跳过（sql.py:174-180）。sqlglot 自己其实**没丢** ——
    // 那条注释好好挂在 ColumnDef.comments 上，是提取逻辑没去拿。
    //
    // 这里钉住现状而不是绕过：这是 Python 原件的既有行为，迁移期不动它（两个宿主
    // 共用同一份解析代码，改了要一起改）。真实导出的 DDL 都是一列一行，所以影响面
    // 很窄 —— 但它静默丢的正是这个模块唯一要保的东西，所以必须留个记号。
    const doc = await live.parseSql("CREATE TABLE t (a DECIMAL(18,2) -- 含税·年度累计\n);");
    expect(JSON.stringify(doc)).not.toContain("含税·年度累计");
  });
});
