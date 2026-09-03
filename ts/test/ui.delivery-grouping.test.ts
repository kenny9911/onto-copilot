/**
 * 交付页的产物分组。
 *
 * 2026-08-25 用户实拍：交付页 16 个产物平铺成 16 行一模一样的「JSON 文件名 ready 预览」——
 * 其中真正要交给客户的只有两份文档（数据字典、问题清单），其余 11 个是同一份草案包
 * 切出来的机器视图（含一个 *.schema.json），而同一份文档的多种格式又各占一行。
 * 主次全无：FDE 想拿去发给业务方的那两份，埋在一堆 draft.json 中间。
 *
 * 分组判据必须是**数据**，不是文件名猜测：机器视图有一份注册表
 * （onto/ontology_package.ts 的 ONTOLOGY_PACKAGE_V1_ARTIFACT_NAMES）。
 * UI 不能 import 那个 2750 行的模块（前端包已经 1.1MB），所以这里复制一份，
 * 并由本文件最后一条用例钉住两边不许漂。
 */
import { describe, expect, it } from "vitest";

import { MACHINE_VIEW_NAMES, groupDeliveryArtifacts } from "../src/ui/delivery-group.js";

describe("groupDeliveryArtifacts", () => {
  // 用户那个会话里真实的 16 个产物，顺序照抄
  const REAL = [
    "数据字典.json", "数据字典.xlsx", "问题清单.json", "问题清单.md", "问题清单.xlsx",
    "ontology.package.draft.json", "ontology-package.v1.schema.json",
    "data-objects.draft.json", "links.draft.json", "actions.draft.json", "events.draft.json",
    "workflows.draft.json", "rules.draft.json", "integrations.draft.json",
    "gaps.draft.json", "questions.draft.json",
  ];

  it("同一份文档的多种格式并成一行，格式列在一起", () => {
    const { documents } = groupDeliveryArtifacts(REAL);
    expect(documents.map((d) => d.title)).toEqual(["数据字典", "问题清单"]);
    expect(documents[0]!.formats.map((f) => f.ext)).toEqual(["XLSX", "JSON"]);
    expect(documents[1]!.formats.map((f) => f.ext)).toEqual(["XLSX", "MD", "JSON"]);
    // 每种格式都要留着原文件名 —— 预览和下载都按名字走
    expect(documents[0]!.formats.map((f) => f.name)).toEqual(["数据字典.xlsx", "数据字典.json"]);
    // 原始产物（可能是带 downloadPath 的对象）要跟着走
    expect(documents[0]!.formats[0]!.artifact).toBe("数据字典.xlsx");
  });

  it("机器视图归到一组，16 行收成 2 份文档 + 1 组快照", () => {
    const { documents, snapshots } = groupDeliveryArtifacts(REAL);
    expect(documents).toHaveLength(2);
    expect(snapshots).toHaveLength(11);
    expect(snapshots).toContain("ontology-package.v1.schema.json");
    expect(documents.flatMap((d) => d.formats.map((f) => f.name))).not.toContain("gaps.draft.json");
  });

  it("认不出的产物按文档处理 —— 不许因为不认识就藏起来", () => {
    const { documents, snapshots } = groupDeliveryArtifacts(["流程图.svg", "流程图.mmd", "自定义交付物.docx"]);
    expect(snapshots).toEqual([]);
    expect(documents.map((d) => d.title)).toEqual(["流程图", "自定义交付物"]);
    expect(documents[0]!.formats.map((f) => f.ext)).toEqual(["SVG", "MMD"]);
  });

  it("顺序稳定：按首次出现排，进来两次结果一样", () => {
    const a = groupDeliveryArtifacts(REAL).documents.map((d) => d.title);
    const b = groupDeliveryArtifacts([...REAL]).documents.map((d) => d.title);
    expect(a).toEqual(b);
    // 打乱输入不会让已有分组互换位置（首次出现序）
    const shuffled = groupDeliveryArtifacts(["问题清单.md", "数据字典.json", "问题清单.xlsx"]);
    expect(shuffled.documents.map((d) => d.title)).toEqual(["问题清单", "数据字典"]);
  });

  it("没有扩展名 / 空输入不炸", () => {
    expect(groupDeliveryArtifacts([]).documents).toEqual([]);
    const { documents } = groupDeliveryArtifacts(["README"]);
    expect(documents[0]!.title).toBe("README");
    expect(documents[0]!.formats[0]!.ext).toBe("FILE");
  });

  it("**原样保留产物对象**：虚拟产物的 URL 在另一条路由上，丢了就点不开", () => {
    // 服务端 /context 给虚拟草案产物的是 /ontology/draft/artifacts/… 这条路由，
    // 与普通产物的 /artifacts/… 不同。分组只做归类，绝不能把对象降级成名字 ——
    // 那样下游 artifactUrl 会回落到默认路由，11 个机器视图的预览和下载一起坏掉。
    const virtualPkg = {
      name: "ontology.package.draft.json",
      virtual: true,
      downloadPath: "/api/sessions/s1/ontology/draft/artifacts/ontology.package.draft.json?download=1",
    };
    const plain = { name: "数据字典.xlsx", downloadPath: "/api/sessions/s1/artifacts/x.xlsx" };
    const { documents, snapshots } = groupDeliveryArtifacts([virtualPkg, plain]);
    expect(snapshots[0]).toBe(virtualPkg);                      // 同一个对象，不是名字
    expect(documents[0]!.formats[0]!.artifact).toBe(plain);
  });

  it("对象形态的产物（{name}）也认", () => {
    const { documents } = groupDeliveryArtifacts([{ name: "数据字典.xlsx" }, { name: "数据字典.json" }]);
    expect(documents).toHaveLength(1);
    expect(documents[0]!.formats).toHaveLength(2);
  });
});

describe("机器视图名单不许和服务端漂开", () => {
  it("与 ONTOLOGY_PACKAGE_V1_ARTIFACT_NAMES 逐字相同", async () => {
    // 测试里可以随便 import 服务端模块（不进前端包）——这就是这条用例存在的意义：
    // UI 侧那份副本一旦和真身漂开，交付页会把某个机器视图当成客户文档摆在最前面。
    const { ONTOLOGY_PACKAGE_V1_ARTIFACT_NAMES } = await import("../src/onto/ontology_package.js");
    expect([...MACHINE_VIEW_NAMES].sort())
      .toEqual(Object.values(ONTOLOGY_PACKAGE_V1_ARTIFACT_NAMES).sort());
  });
});
