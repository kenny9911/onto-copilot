/**
 * 交付页的产物分组。
 *
 * 一次真实会话会产出 16 个产物，而其中**真正要交给客户的只有两份文档**
 * （数据字典、问题清单），其余 11 个是同一份草案包切出来的机器视图
 * （`*.draft.json` 加一个 `*.schema.json`）。平铺成 16 行一模一样的
 * 「JSON 文件名 ready 预览」之后，FDE 想发给业务方的那两份埋在中间 ——
 * 2026-08-25 用户原话：「有点杂乱无顺序」。
 *
 * 两条规则，都只看数据不看语气：
 *  · 机器视图有一份**注册表**（服务端 `ONTOLOGY_PACKAGE_V1_ARTIFACT_NAMES`），
 *    按名单归组、默认折叠；认不出的一律当客户文档，不许因为不认识就藏起来。
 *  · 同一份文档的多种格式（数据字典.xlsx/.json）并成一行，格式做成并列的入口 ——
 *    它们是同一份东西的不同拿法，不是三件不同的交付物。
 *
 * **为什么在这里复制一份名单**：UI 不能 import `onto/ontology_package.ts`
 * （2750 行，前端包已经 1.1MB）。副本与真身的一致性由
 * `test/ui.delivery-grouping.test.ts` 最后一条用例逐字钉住 —— 漂开了那条会红。
 */

/** 与服务端 `ONTOLOGY_PACKAGE_V1_ARTIFACT_NAMES` 逐字相同（测试钉住）。 */
export const MACHINE_VIEW_NAMES: readonly string[] = [
  "ontology.package.draft.json",
  "ontology-package.v1.schema.json",
  "data-objects.draft.json",
  "links.draft.json",
  "actions.draft.json",
  "events.draft.json",
  "workflows.draft.json",
  "rules.draft.json",
  "integrations.draft.json",
  "gaps.draft.json",
  "questions.draft.json",
];

const MACHINE_VIEWS = new Set(MACHINE_VIEW_NAMES);

/**
 * 格式的展示优先序：**能直接给业务方用的排前面**。
 * xlsx 能填能回传，md/docx 能读，json 是给机器的 —— 同一份文档并排时，
 * 第一个入口应该是人最可能点的那个。
 */
const FORMAT_ORDER = ["XLSX", "XLSM", "CSV", "DOCX", "PDF", "MD", "SVG", "PNG", "MMD", "JSON"];

export interface DeliveryFormat {
  /** 大写扩展名；没有扩展名时是 FILE。 */
  readonly ext: string;
  /** 原始产物名。 */
  readonly name: string;
  /**
   * **原样的产物条目**（字符串或对象），一定要带着走。
   *
   * 虚拟草案产物的 URL 在另一条路由上（`/ontology/draft/artifacts/…`，服务端
   * 放在 `downloadPath` 里），下游 `artifactUrl` 认的就是这个字段。分组若把对象
   * 降级成名字，URL 会回落到默认的 `/artifacts/…`，11 个机器视图的预览和下载
   * 一起坏掉 —— 分组只该改**怎么排**，不该改**是什么**。
   */
  readonly artifact: unknown;
}

export interface DeliveryDocument {
  /** 去掉扩展名的文档名，一行的标题。 */
  readonly title: string;
  readonly formats: DeliveryFormat[];
}

export interface DeliveryGroups {
  readonly documents: DeliveryDocument[];
  /** 机器视图，**原样的产物条目**（理由同 DeliveryFormat.artifact），按输入顺序。 */
  readonly snapshots: unknown[];
}

function nameOf(artifact: unknown): string {
  if (typeof artifact === "string") return artifact;
  if (artifact !== null && typeof artifact === "object") {
    const o = artifact as Record<string, unknown>;
    for (const k of ["name", "filename", "file"]) {
      const v = o[k];
      if (typeof v === "string" && v) return v;
    }
  }
  return String(artifact ?? "");
}

function splitName(name: string): { title: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { title: name, ext: "FILE" };
  return { title: name.slice(0, dot), ext: name.slice(dot + 1).toUpperCase() };
}

function formatRank(ext: string): number {
  const i = FORMAT_ORDER.indexOf(ext);
  return i === -1 ? FORMAT_ORDER.length : i;
}

/**
 * 分组。**顺序按首次出现**，不做重排 —— 每次进来看到的次序必须一样，
 * 否则「上次那份在第三行」这种肌肉记忆全废。
 */
export function groupDeliveryArtifacts(artifacts: readonly unknown[]): DeliveryGroups {
  const documents: DeliveryDocument[] = [];
  const byTitle = new Map<string, DeliveryFormat[]>();
  const snapshots: unknown[] = [];
  for (const artifact of artifacts) {
    const name = nameOf(artifact);
    if (!name) continue;
    if (MACHINE_VIEWS.has(name)) {
      snapshots.push(artifact);
      continue;
    }
    const { title, ext } = splitName(name);
    let formats = byTitle.get(title);
    if (formats === undefined) {
      formats = [];
      byTitle.set(title, formats);
      documents.push({ title, formats });
    }
    if (!formats.some((f) => f.name === name)) formats.push({ ext, name, artifact });
  }
  for (const doc of documents) {
    doc.formats.sort((a, b) => formatRank(a.ext) - formatRank(b.ext));
  }
  return { documents, snapshots };
}
