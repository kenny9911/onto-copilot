import { describe, expect, it } from "vitest";

import {
  diffDocumentVersions,
  extractDocumentSchema,
  type DiffableDocumentVersion,
} from "../src/document/diff.js";
import { makeChunk, makeParsedDoc, type ParsedDoc } from "../src/onto/parse/base.js";

interface ChunkInput {
  readonly id: string;
  readonly text: string;
  readonly order: number;
}

interface ColumnInput {
  readonly name: string;
  readonly type: string;
}

interface TableInput {
  readonly name: string;
  readonly columns: readonly ColumnInput[];
}

function parsed(versionId: string, chunks: readonly ChunkInput[], tables: readonly TableInput[]): ParsedDoc {
  const doc = makeParsedDoc({ fileId: versionId, fileName: "采购规则.sql", kind: "ddl" });
  doc.chunks = chunks.map((item) => makeChunk({
    docId: item.id,
    fileId: versionId,
    fileName: doc.file_name,
    locator: { section: item.id, line: item.order + 1, _version_id: versionId },
    render: item.text,
    raw: { text: item.text },
    order: item.order,
    tags: ["rule"],
  }));
  doc.structured = {
    tables: tables.map((table) => ({
      name: table.name,
      columns: table.columns.map((column) => ({
        name: column.name,
        type: column.type,
        nullable: false,
        comment: "",
      })),
      primary_key: [],
      foreign_keys: [],
    })),
  };
  return doc;
}

function fixture(): { before: DiffableDocumentVersion; after: DiffableDocumentVersion } {
  return {
    before: {
      documentId: "doc_purchase",
      versionId: "ver_1",
      versionNo: 1,
      parsedDoc: parsed("ver_1", [
        { id: "rule", text: "金额上限为 100", order: 0 },
        { id: "same", text: "供应商必须有效", order: 1 },
        { id: "removed", text: "旧审批规则", order: 2 },
      ], [
        { name: "purchase", columns: [{ name: "amount", type: "DECIMAL" }, { name: "legacy", type: "TEXT" }] },
        { name: "supplier", columns: [{ name: "id", type: "TEXT" }] },
        { name: "old_table", columns: [{ name: "old_id", type: "TEXT" }] },
      ]),
    },
    after: {
      documentId: "doc_purchase",
      versionId: "ver_2",
      versionNo: 2,
      parsedDoc: parsed("ver_2", [
        { id: "rule", text: "金额上限为 200", order: 0 },
        { id: "same", text: "供应商必须有效", order: 1 },
        { id: "added", text: "新增财务复核", order: 2 },
      ], [
        { name: "purchase", columns: [{ name: "amount", type: "INTEGER" }, { name: "approver", type: "TEXT" }] },
        { name: "supplier", columns: [{ name: "id", type: "TEXT" }] },
        { name: "new_table", columns: [{ name: "new_id", type: "TEXT" }] },
      ]),
    },
  };
}

describe("OntoDocument deterministic version diff", () => {
  it("逐一报告 chunk、表和字段的新增、删除、修改与未变化数量", () => {
    const { before, after } = fixture();
    const oldBytes = JSON.stringify(before);
    const newBytes = JSON.stringify(after);
    const result = diffDocumentVersions(before, after);

    expect(result.summary.chunks).toEqual({ added: 1, removed: 1, modified: 1, unchanged: 1 });
    expect(result.summary.tables).toEqual({ added: 1, removed: 1, modified: 1, unchanged: 1 });
    expect(result.summary.fields).toEqual({ added: 2, removed: 2, modified: 1, unchanged: 1 });
    expect(result.chunks.map((item) => [item.key, item.kind])).toEqual([
      ["chunk:added", "added"],
      ["chunk:removed", "removed"],
      ["chunk:rule", "modified"],
    ]);
    expect(result.tables.find((item) => item.key === "table:purchase")).toMatchObject({
      kind: "modified",
      changedParts: expect.arrayContaining(["fieldOrder", "fieldFingerprints"]),
    });
    expect(result.fields.find((item) => item.key === "table:purchase::field:amount")).toMatchObject({
      kind: "modified",
      changedParts: ["definition"],
    });
    expect(result.fields.map((item) => [item.key, item.kind])).toEqual(expect.arrayContaining([
      ["table:purchase::field:legacy", "removed"],
      ["table:purchase::field:approver", "added"],
    ]));
    expect(result.inventory.from.chunkIds).toEqual(["ver_1:removed", "ver_1:rule", "ver_1:same"]);
    expect(result.inventory.from.tableKeys).toContain("table:supplier");
    expect(JSON.stringify(before)).toBe(oldBytes);
    expect(JSON.stringify(after)).toBe(newBytes);
  });

  it("同一输入始终得到同一 change id 和指纹，版本注入 locator 不制造假变化", () => {
    const { before, after } = fixture();
    const first = diffDocumentVersions(before, after);
    const second = diffDocumentVersions(structuredClone(before), structuredClone(after));

    expect(second).toEqual(first);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{32}$/u);
    const unchangedOnly = diffDocumentVersions(
      { ...before, parsedDoc: parsed("ver_1", [{ id: "same", text: "相同", order: 0 }], []) },
      { ...after, parsedDoc: parsed("ver_2", [{ id: "same", text: "相同", order: 0 }], []) },
    );
    expect(unchangedOnly.hasChanges).toBe(false);
    expect(unchangedOnly.summary.chunks.unchanged).toBe(1);
  });

  it("重复表名和重复字段不会被 Map 静默覆盖", () => {
    const doc = parsed("ver_1", [], [
      { name: "line", columns: [{ name: "id", type: "TEXT" }, { name: "id", type: "INTEGER" }] },
      { name: "line", columns: [{ name: "other", type: "TEXT" }] },
    ]);
    const schema = extractDocumentSchema(doc);

    expect(schema.tables).toHaveLength(2);
    expect(new Set(schema.tables.map((item) => item.key)).size).toBe(2);
    expect(schema.fields).toHaveLength(3);
    expect(new Set(schema.fields.map((item) => item.key)).size).toBe(3);
  });

  it("拒绝跨文档比较，也拒绝循环结构冒充可持久化 ParsedDoc", () => {
    const { before, after } = fixture();
    expect(() => diffDocumentVersions(before, { ...after, documentId: "doc_other" }))
      .toThrow(/同一 documentId/u);

    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    const bad = structuredClone(before.parsedDoc);
    bad.structured = { tables: cyclic };
    expect(() => diffDocumentVersions({ ...before, parsedDoc: bad }, after)).toThrow(/循环引用/u);
  });
});
