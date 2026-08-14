import { describe, expect, it } from "vitest";

import { materialStatus } from "../src/server/material_status.js";

function state(
  file: string,
  chunks: unknown[],
  findings: Array<Record<string, unknown>> = [],
  opts: { parsed?: boolean } = {},
): { state: Record<string, unknown> } {
  return {
    state: {
      _chunks: { [file]: chunks },
      corpus: {
        files: opts.parsed === false ? [] : [{ file, chunks: chunks.length }],
        findings: findings.map((f) => ({ file, severity: "warn", locator: {}, ...f })),
      },
    },
  };
}

describe("materialStatus", () => {
  it("电子 PDF 已直接读到文本层 → parsed", () => {
    const s = state("电子发票.pdf", [{ text: "发票正文" }], [
      { kind: "pdf_text_ok", message: "已直接读取文本层", severity: "info" },
    ]);
    expect(materialStatus(s, "电子发票.pdf")).toMatchObject({ state: "parsed", chunks: 1 });
  });

  it("混合 PDF 有切片但仍有页待识别 → partial，而不是 parsed", () => {
    const s = state("混合.pdf", [{ text: "第一页" }], [
      { kind: "vision_pending", message: "第 2 页待识别", severity: "info" },
    ]);
    expect(materialStatus(s, "混合.pdf")).toEqual({
      state: "partial", chunks: 1, issue: "第 2 页待识别", issue_kind: "vision_pending",
    });
  });

  it("解析失败与不支持是两个终态", () => {
    const failed = state("坏.docx", [], [{ kind: "parse_failed", message: "包损坏" }]);
    const unsupported = state("旧.xls", [], [{ kind: "unsupported", message: "旧格式" }]);
    expect(materialStatus(failed, "坏.docx").state).toBe("failed");
    expect(materialStatus(unsupported, "旧.xls").state).toBe("unsupported");
  });

  it("成功解析的空文件看 corpus.files → parsed；从未解析的文本 → unread", () => {
    expect(materialStatus(state("空.txt", []), "空.txt").state).toBe("parsed");
    expect(materialStatus(state("新.txt", [], [], { parsed: false }), "新.txt").state).toBe("unread");
  });
});
