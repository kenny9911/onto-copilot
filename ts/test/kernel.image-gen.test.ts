/**
 * 图像生成 —— images 端点，与 chat completions 不是一条路。
 *
 * 设计约束（评审压出来的）：
 * - `generateImage` 是 LLMBackend 的**可选**方法：现有后端（Anthropic、Scripted、
 *   各测试替身）一个都不用改；调用方先探测再调。
 * - 返回 base64。调用方把它包进 `rec.effect()` 时，Recorder 对超过 2048 码位的
 *   payload **自动落 BlobStore**（INLINE_LIMIT 的既有机制），所以一张 PNG 不会
 *   撑爆事件日志，重放也免费 —— 不需要为图像发明新的持久化。
 * - 网关没有图像模型时要报**能看懂的错**，不是 404 透传。
 */
import { describe, expect, it } from "vitest";

import { OpenAICompatBackend } from "../src/kernel/backends.js";
import { InMemoryBlobStore, InMemoryJournal } from "../src/kernel/journal.js";
import { ModelGateway, stubRouting } from "../src/kernel/llm.js";
import type { LLMBackend } from "../src/kernel/llm.js";
import { Recorder } from "../src/kernel/recorder.js";

function backend(handler: (url: string, init: RequestInit) => Promise<Response>) {
  return new OpenAICompatBackend("http://gw/v1", "k", {
    fetchImpl: handler,
    sleep: async () => {},
    maxRetries: 0,
  });
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenAICompatBackend.generateImage", () => {
  it("打的是 /images/generations，不是 chat completions", async () => {
    let hitUrl = "";
    const b = backend(async (url) => {
      hitUrl = url;
      return jsonRes(200, { data: [{ b64_json: "aGVsbG8=" }] });
    });

    await b.generateImage({ model: "img-1", prompt: "画一张流程图" });

    expect(hitUrl).toBe("http://gw/v1/images/generations");
  });

  it("返回 base64 数据", async () => {
    const b = backend(async () => jsonRes(200, { data: [{ b64_json: "aGVsbG8=" }] }));

    const r = await b.generateImage({ model: "img-1", prompt: "画" });

    expect(r.b64).toBe("aGVsbG8=");
  });

  it("请求体带上 model 和 prompt", async () => {
    let sent: Record<string, unknown> = {};
    const b = backend(async (_u, init) => {
      sent = JSON.parse(String(init.body));
      return jsonRes(200, { data: [{ b64_json: "eA==" }] });
    });

    await b.generateImage({ model: "img-1", prompt: "按结构画" });

    expect(sent["model"]).toBe("img-1");
    expect(sent["prompt"]).toBe("按结构画");
  });

  it("网关说没有这个模型 —— 错误信息要说人话，并点名是图像生成", async () => {
    const b = backend(async () => jsonRes(404, { error: { message: "model not found" } }));

    await expect(b.generateImage({ model: "img-1", prompt: "画" }))
      .rejects.toThrow(/图像生成|image/iu);
  });

  it("响应里没有图 —— 报错，不给空串装成功", async () => {
    const b = backend(async () => jsonRes(200, { data: [] }));

    await expect(b.generateImage({ model: "img-1", prompt: "画" }))
      .rejects.toThrow(/没有|空|no image/iu);
  });

  it("凭证走 Authorization 头，与 chat 同一份", async () => {
    let auth = "";
    const b = backend(async (_u, init) => {
      auth = String((init.headers as Record<string, string>)["Authorization"]);
      return jsonRes(200, { data: [{ b64_json: "eA==" }] });
    });

    await b.generateImage({ model: "img-1", prompt: "画" });

    expect(auth).toBe("Bearer k");
  });
});

/**
 * 网关层：所有出图调用的唯一收口，包进 `rec.effect` ——
 * 重放时**不再打后端**（同一张图不付两次钱），而且 base64 超过 INLINE_LIMIT
 * 会走 Recorder 既有的 BlobStore 溢出，不撑爆事件日志。
 */
describe("ModelGateway.generateImage", () => {
  function stubBackend(counter: { calls: number }): LLMBackend {
    return {
      async generate() {
        throw new Error("这个测试不该走文本调用");
      },
      async generateImage() {
        counter.calls += 1;
        // 超过 INLINE_LIMIT（2048 码位）的 payload，逼出 blob 溢出路径
        return { b64: "QUJD".repeat(1024) };
      },
    };
  }

  async function runOnce(
    journal: InMemoryJournal,
    blobs: InMemoryBlobStore,
    counter: { calls: number },
    resume: boolean,
  ) {
    const rec = new Recorder("run-img", journal, blobs, { resume });
    const gw = new ModelGateway(stubBackend(counter), rec, { routing: stubRouting() });
    const r = await gw.generateImage("FLOW_RENDER", { model: "openai/gpt-image-2", prompt: "按结构画" });
    await journal.flush();
    return r;
  }

  it("第一次真打后端，重放第二次不打 —— 同一张图不付两次钱", async () => {
    const journal = new InMemoryJournal();
    const blobs = new InMemoryBlobStore();
    const counter = { calls: 0 };

    const first = await runOnce(journal, blobs, counter, false);
    expect(counter.calls).toBe(1);

    const second = await runOnce(journal, blobs, counter, true);
    expect(counter.calls).toBe(1); // 没有第二次
    expect(second.b64).toBe(first.b64);
  });

  it("后端不支持出图 —— 报能看懂的错，不是 undefined is not a function", async () => {
    const rec = new Recorder("run-img2", new InMemoryJournal(), new InMemoryBlobStore(), {});
    const textOnly: LLMBackend = {
      async generate() { throw new Error("nope"); },
    };
    const gw = new ModelGateway(textOnly, rec, { routing: stubRouting() });

    await expect(gw.generateImage("N", { model: "m", prompt: "画" }))
      .rejects.toThrow(/不支持出图|图像/u);
  });
});
