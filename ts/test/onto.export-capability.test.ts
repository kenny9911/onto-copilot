/**
 * 导出能力的**运行时诚实**。
 *
 * `SPECS` 里 pdf 和 md/csv/xlsx/docx 并列，但生产进程从来没有调过
 * `registerPdfRenderer`（全仓库只有测试调过）—— 于是模型会照着格式表，
 * 自信地对用户说「给你导成 PDF」，用户点了才发现导不出来。
 *
 * 失败时的文案本来就是对的（"这台机器上导不出 pdf"）。问题在**广告时**：
 * 宣称的能力必须等于运行时真有的能力，否则每一次 PDF 请求都是一轮白跑
 * 加一次失信。
 *
 * 有一条边界要一起钉住：**不能靠"把 pdf 从 SPECS 里删掉"来实现诚实**。
 * 删了之后 `resolveFormat("pdf")` 返回空，用户再问 PDF 拿到的是泛泛的
 * "不支持的格式"，比现在那句具体的"这台机器上没接排版器"更差。
 * 正确做法是：**照常能解析，只是不宣传。**
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import * as exportApi from "../src/onto/export.js";
import { ToolRegistry } from "../src/kernel/tools.js";
import { AsyncLock } from "../src/server/pipeline/types.js";
import { converseTools } from "../src/server/dialogue.js";
import type { SessionEvent } from "../src/session_events.js";
import type { DialogueDeps, SessionLike } from "../src/server/dialogue/ports.js";

import {
  FORMATS,
  availableFormats,
  registerPdfRenderer,
  resolveFormat,
  unavailableFormats,
} from "../src/onto/export.js";

afterEach(() => registerPdfRenderer(null));

describe("导出能力矩阵", () => {
  it("没接排版器时，pdf **不进**可用格式", () => {
    registerPdfRenderer(null);
    expect(availableFormats()).not.toContain("pdf");
    expect(availableFormats()).toContain("docx");
    expect(availableFormats()).toContain("xlsx");
  });

  it("接上排版器之后 pdf 立刻可用 —— 能力矩阵是**运行时**算的，不是启动时冻的", () => {
    registerPdfRenderer(() => new Uint8Array([1, 2, 3]));
    expect(availableFormats()).toContain("pdf");
    expect(unavailableFormats()).toEqual([]);
  });

  it("不可用的格式要说得出**为什么**，不是从清单里静默消失", () => {
    registerPdfRenderer(null);
    expect(unavailableFormats()).toContain("pdf");
  });

  it("**照常能解析，只是不宣传** —— resolveFormat 仍认 pdf", () => {
    registerPdfRenderer(null);
    // 认得出来，才能给出"这台机器上导不出 pdf"这句具体的话；
    // 认不出就退化成泛泛的"不支持的格式"，那是更差的失败。
    expect(resolveFormat("pdf")).toBe("pdf");
    expect(FORMATS).toContain("pdf");
  });
});

// ══════════════════════════════════════════════════════════════════
//  广告口径：export.file 只能宣传真有的格式
// ══════════════════════════════════════════════════════════════════

function makeSession(): SessionLike {
  const dir = mkdtempSync(join(tmpdir(), "onto-cap-"));
  const s: SessionLike = {
    id: "s1", title: "新建会话", project: "", projectId: "", created: 1700000000,
    files: [], status: "idle", error: "", dir, events: [], state: {}, stateVersion: 0,
    owner: "", buildLeaseOwner: "", mutationLeaseOwner: "",
    buildLock: new AsyncLock(), chatTask: null, runTask: null, lang: "zh",
    emit(kind, payload = {}) {
      const ev = { ...payload, kind } as unknown as SessionEvent;
      (s.events as unknown[]).push(ev);
      return ev;
    },
    async emitDurable(kind, payload = {}) { return s.emit(kind, payload); },
  } as SessionLike;
  return s;
}

function makeDeps(): DialogueDeps {
  const impl: Partial<DialogueDeps> = {
    builtinRegistry: () => new ToolRegistry(),
    exportApi: exportApi as unknown as DialogueDeps["exportApi"],
  };
  return new Proxy(impl as Record<string, unknown>, {
    get(t, k: string) {
      if (k in t) return t[k];
      throw new Error(`fake deps：不该碰 ${k}`);
    },
  }) as unknown as DialogueDeps;
}

function exportFileSpec(): Record<string, unknown> {
  const reg = converseTools(makeSession(), makeDeps());
  const tool = reg.forScope("converse").find((t) => t.spec.name === "export.file")!;
  return tool.spec as unknown as Record<string, unknown>;
}

describe("export.file 的广告口径", () => {
  // 要求不是「pdf 三个字不许出现」—— 用户**确实**会说「导出成 pdf」，
  // 触发例子里留着它，模型才认得出这个意图。要求是两条：
  // 合法值清单里没有它（不能当成可选项推荐），以及**明说导不出**。

  it("没接排版器时，format 的合法值清单里**没有 pdf**", () => {
    registerPdfRenderer(null);
    const spec = exportFileSpec();
    const props = (spec["inputSchema"] as Record<string, Record<string, Record<string, string>>>)[
      "properties"
    ]!;
    expect(props["format"]!["description"]).not.toContain("pdf");
    expect(props["format"]!["description"]).toContain("docx");
  });

  it("没接排版器时**不推荐** pdf —— 挑格式的那句话里不能有它", () => {
    registerPdfRenderer(null);
    const desc = String((exportFileSpec() as Record<string, string>)["description"]);
    // 只取推荐句本身：它后面那句「导不出 pdf」的提示**应该**提到 pdf，
    // 切进来会把两个相反的要求混成一个。
    const from = desc.indexOf("格式挑不准");
    const nl = desc.indexOf("\n", from);
    const 推荐句 = nl === -1 ? desc.slice(from) : desc.slice(from, nl);
    expect(推荐句).not.toContain("pdf");
    expect(推荐句).toContain("docx");
  });

  it("**明说导不出**，并给出该怎么办 —— 静默消失会让模型以为是自己漏了", () => {
    registerPdfRenderer(null);
    const desc = String((exportFileSpec() as Record<string, string>)["description"]);
    expect(desc).toContain("导不出");
    expect(desc).toContain("pdf");
  });

  it("接上之后 pdf 回到合法值清单，且不再有「导不出」的提示", () => {
    registerPdfRenderer(() => new Uint8Array([1]));
    const spec = exportFileSpec();
    const props = (spec["inputSchema"] as Record<string, Record<string, Record<string, string>>>)[
      "properties"
    ]!;
    expect(props["format"]!["description"]).toContain("pdf");
    expect(String((spec as Record<string, string>)["description"])).not.toContain("导不出");
  });
});
