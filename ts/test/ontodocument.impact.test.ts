import { describe, expect, it } from "vitest";

import { diffDocumentVersions } from "../src/document/diff.js";
import {
  analyzeDocumentImpact,
  collectDocumentReferences,
  decodeDocumentEvidenceRef,
} from "../src/document/impact.js";
import type { DocumentManifestEntry } from "../src/document/types.js";
import { makeChunk, makeParsedDoc } from "../src/onto/parse/base.js";

function encoded(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function evidence(documentId: string, versionId: string, chunkId: string): string {
  return `odoc.v1.${encoded(documentId)}.${encoded(versionId)}.${encoded(chunkId)}`;
}

function parsed(versionId: string, amountType: string) {
  const doc = makeParsedDoc({ fileId: versionId, fileName: "采购.sql", kind: "ddl" });
  doc.chunks = [
    makeChunk({
      docId: "rule", fileId: versionId, fileName: doc.file_name,
      locator: { line: 1 }, render: amountType === "DECIMAL" ? "金额为小数" : "金额为整数",
      raw: { type: amountType }, order: 0,
    }),
    makeChunk({
      docId: "same", fileId: versionId, fileName: doc.file_name,
      locator: { line: 2 }, render: "供应商规则不变", raw: { rule: "same" }, order: 1,
    }),
  ];
  doc.structured = {
    tables: [{
      name: "purchase",
      columns: [
        { name: "amount", type: amountType, nullable: false, comment: "" },
        { name: "note", type: "TEXT", nullable: true, comment: "" },
      ],
      primary_key: [],
      foreign_keys: [],
    }],
  };
  return doc;
}

function manifest(versionId: string): DocumentManifestEntry {
  return {
    project_id: "project_A",
    document_id: "doc_purchase",
    version_id: versionId,
    sha256: "a".repeat(64),
    index_revision: "idx_1",
    acl_revision: 1,
    title: "采购规则",
    file_name: "采购.sql",
    version_no: 1,
    parse_status: "ready",
    parser_version: "1",
  };
}

describe("OntoDocument dependency impact analysis", () => {
  it("从回答、manifest、模型产物反查旧版本依赖，但只标 stale_candidate", () => {
    const diff = diffDocumentVersions(
      { documentId: "doc_purchase", versionId: "ver_1", parsedDoc: parsed("ver_1", "DECIMAL") },
      { documentId: "doc_purchase", versionId: "ver_2", parsedDoc: parsed("ver_2", "INTEGER") },
    );
    const changedRef = evidence("doc_purchase", "ver_1", "ver_1:rule");
    const sameRef = evidence("doc_purchase", "ver_1", "ver_1:same");
    const missingRef = evidence("doc_purchase", "ver_1", "ver_1:missing");
    const report = analyzeDocumentImpact(diff, {
      answers: [
        { id: "answer_changed", evidenceRefs: [changedRef] },
        { id: "answer_same", citations: [`原文：${sameRef}`] },
        { id: "answer_missing", payload: { evidence_ref: missingRef } },
        { id: "answer_other", evidenceRefs: [evidence("doc_other", "ver_x", "ver_x:rule")] },
        { id: "answer_plain", citations: ["采购规则.sql#第 1 行"] },
      ],
      manifests: [{ id: "manifest_session", entries: [manifest("ver_1")] }],
      artifacts: [
        {
          id: "artifact_field_changed", artifactKind: "ontology",
          payload: { document_id: "doc_purchase", version_id: "ver_1", field_key: "table:purchase::field:amount" },
        },
        {
          id: "artifact_field_same", artifactKind: "ontology",
          payload: { documentId: "doc_purchase", versionId: "ver_1", fieldKey: "table:purchase::field:note" },
        },
        {
          id: "artifact_old_unknown", artifactKind: "model",
          payload: { document_id: "doc_purchase", version_id: "ver_0" },
        },
        {
          id: "artifact_new", artifactKind: "model",
          payload: { document_id: "doc_purchase", version_id: "ver_2", field_key: "table:purchase::field:amount" },
        },
      ],
      wikiClaims: [{ id: "claim_changed", payload: { note: changedRef } }],
    });

    expect(report.staleCandidates.map((item) => item.consumerId)).toEqual([
      "answer_changed",
      "artifact_field_changed",
      "claim_changed",
      "manifest_session",
    ]);
    expect(report.unresolved.map((item) => item.consumerId)).toEqual([
      "answer_missing",
      "artifact_old_unknown",
    ]);
    expect(report.consumers.find((item) => item.consumerId === "answer_same")?.status).toBe("unaffected");
    expect(report.consumers.find((item) => item.consumerId === "artifact_field_same")?.status).toBe("unaffected");
    expect(report.consumers.find((item) => item.consumerId === "artifact_new")?.status).toBe("unaffected");
    expect(report.consumers.some((item) => item.consumerId === "answer_other")).toBe(false);
    expect(report.consumers.some((item) => item.consumerId === "answer_plain")).toBe(false);
    expect(report.consumers.every((item) => !(["stale", "invalid"] as string[]).includes(item.status))).toBe(true);

    const changedChunk = diff.chunks.find((item) => item.key === "chunk:rule")!;
    expect(report.reverseDependencies.find((item) => item.changeId === changedChunk.id)?.consumerIds)
      .toEqual(["answer_changed", "claim_changed"]);
    expect(report.fingerprint).toMatch(/^[a-f0-9]{32}$/u);
  });

  it("未知旧 chunk/表/字段一律 unresolved，不把不存在的依赖幻觉成未变化", () => {
    const diff = diffDocumentVersions(
      { documentId: "doc_purchase", versionId: "ver_1", parsedDoc: parsed("ver_1", "DECIMAL") },
      { documentId: "doc_purchase", versionId: "ver_2", parsedDoc: parsed("ver_2", "INTEGER") },
    );
    const report = analyzeDocumentImpact(diff, {
      artifacts: [
        { id: "missing_table", artifactKind: "x", payload: { document_id: "doc_purchase", version_id: "ver_1", table_key: "table:invented" } },
        { id: "missing_field", artifactKind: "x", payload: { document_id: "doc_purchase", version_id: "ver_1", field_key: "table:purchase::field:invented" } },
        { id: "missing_chunk", artifactKind: "x", payload: { document_id: "doc_purchase", version_id: "ver_1", chunk_id: "ver_1:invented" } },
      ],
    });
    expect(report.unresolved.map((item) => item.consumerId)).toEqual([
      "missing_chunk", "missing_field", "missing_table",
    ]);
    expect(report.unresolved.every((item) => item.reasons.every((reason) => reason.changeId === null))).toBe(true);
  });

  it("只接受可解码的稳定 evidence_ref 或显式结构引用，并能安全扫描循环对象", () => {
    const ref = evidence("文档一", "版本二", "切片三");
    expect(decodeDocumentEvidenceRef(ref)).toMatchObject({
      documentId: "文档一", versionId: "版本二", chunkId: "切片三",
    });
    expect(decodeDocumentEvidenceRef(`${ref}=`)).toBeNull();
    expect(decodeDocumentEvidenceRef("采购规则.sql#第1行")).toBeNull();

    const cyclic: Record<string, unknown> = { text: `证据 ${ref}` };
    cyclic["self"] = cyclic;
    expect(collectDocumentReferences(cyclic)).toHaveLength(1);
    expect(collectDocumentReferences({ document_id: "doc", version_id: "ver", chunk_id: "chunk" }))
      .toMatchObject([{ documentId: "doc", versionId: "ver", chunkId: "chunk" }]);
    expect(collectDocumentReferences("document_id=doc, version_id=ver")).toEqual([]);
  });
});
