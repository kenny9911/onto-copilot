/**
 * ER 图（对象关系图）—— Ontology 的主体是对象和关系，可视化却一直只有一张
 * 业务流程图：「对象长什么样、谁关联谁、一对多还是多对多」只能翻 JSON 或 xlsx。
 * **对客户讲 Ontology 时最需要的那张图，以前不存在。**
 *
 * 产物是 mermaid `erDiagram`：右栏/聊天里已经会渲染 mermaid，导出 md 也认。
 * 照 diagram.ts 的纪律：
 *   - 标识符与标签都要转义（客户对象名什么字符都可能有）；
 *   - 属性只铺前 N 个（图是拿来讲的，不是拿来读全表的）；
 *   - 主键标 PK、必填标 "NN"（mermaid ER 的注释位），
 *     **有值域的属性用值域首几项当注释** —— 那是讲解时最常被问的。
 */

import { mlabel } from "./diagram.js";
import { cpSlice } from "./parse/base.js";
import { Cardinality, type OIR } from "./oir.js";

/** mermaid erDiagram 的实体名：只留字母数字下划线，中文转拼音式下划线会丢信息，
 *  所以**实体名用 apiName**（它本来就是 lowerCamel），中文名放 alias 注释行。 */
function eid(name: string): string {
  let out = "";
  for (const c of name) out += /[A-Za-z0-9_]/u.test(c) ? c : "_";
  return out === "" ? "X" : cpSlice(out, 0, 40);
}

/** 关系记号。mermaid erDiagram：`||` 恰一，`o{` 零或多，`|{` 一或多。 */
function edgeMark(card: string): string {
  switch (card) {
    case Cardinality.ONE_TO_ONE: return "||--||";
    case Cardinality.MANY_TO_MANY: return "}o--o{";
    // ONE_TO_MANY 与兜底：源一对多目标
    default: return "||--o{";
  }
}

export interface ErOptions {
  /** 每个实体铺几个属性。默认 8 —— 图是拿来讲的。 */
  readonly maxAttrs?: number;
  /** 只画这些对象（rid / apiName）。空 = 全画。 */
  readonly only?: readonly string[];
}

export function toErMermaid(oir: OIR, opts: ErOptions = {}): string {
  const maxAttrs = opts.maxAttrs ?? 8;
  const wanted = new Set((opts.only ?? []).map((x) => x.toLowerCase()));
  const lines: string[] = ["erDiagram"];

  const included = new Set<string>();
  for (const o of oir.objects.values()) {
    const api = o.apiName.value || o.rid;
    if (wanted.size > 0
      && !wanted.has(o.rid.toLowerCase())
      && !wanted.has(api.toLowerCase())) continue;
    included.add(o.rid);
    const ent = eid(api);
    // 中文名当 alias 展示（mermaid 支持 `实体名["展示名"]`）
    const display = o.displayName.value && o.displayName.value !== api
      ? `${ent}["${mlabel(o.displayName.value)}"]`
      : ent;
    lines.push(`  ${display} {`);
    const pk = new Set(o.primaryKey.value);
    const props = o.properties
      .map((rid) => oir.properties.get(rid))
      .filter((p) => p !== undefined);
    for (const p of props.slice(0, maxAttrs)) {
      const type = String(p!.baseType.value || "STRING");
      const name = eid(p!.apiName.value || p!.rid);
      const marks: string[] = [];
      if (pk.has(p!.rid)) marks.push("PK");
      // 注释位：口径优先，其次值域（讲解时最常被问）；都没有就必填标记
      const domain = p!.valueDomain.value;
      const note = p!.definition.value
        || (Array.isArray(domain) && domain.length > 0 ? `取值 ${domain.slice(0, 3).join("/")}` : "")
        || (p!.required.value ? "必填" : "");
      lines.push(`    ${type} ${name}${marks.length > 0 ? ` ${marks.join(",")}` : ""}`
        + (note ? ` "${mlabel(cpSlice(note, 0, 24))}"` : ""));
    }
    if (props.length > maxAttrs) {
      lines.push(`    STRING _more "还有 ${props.length - maxAttrs} 个属性"`);
    }
    lines.push("  }");
  }

  for (const l of oir.links.values()) {
    // 只画两端都在图里的关系 —— 画到图外的悬空线比不画更误导
    if (!included.has(l.source) || !included.has(l.target)) continue;
    const src = oir.objects.get(l.source);
    const tgt = oir.objects.get(l.target);
    if (src === undefined || tgt === undefined) continue;
    const jk = l.joinKey.value;
    const label = jk !== null && Object.keys(jk).length > 0
      ? Object.entries(jk).map(([a, b]) => `${a}=${b}`).join(",")
      : (l.apiName.value || "");
    lines.push(`  ${eid(src.apiName.value || src.rid)} ${edgeMark(String(l.cardinality.value))} `
      + `${eid(tgt.apiName.value || tgt.rid)} : "${mlabel(cpSlice(label, 0, 30)) || "关联"}"`);
  }

  // 事件一并画上（A1 之后它是一等公民）：事件→载荷对象 用虚线语义表达不了，
  // erDiagram 没有虚线 —— 用弱关系记号 + 「载荷」标签。产生它的 Action 是行为
  // 不是实体，不进 ER 图（那是流程图的事）。
  for (const e of oir.events.values()) {
    for (const objRid of e.payload) {
      if (!included.has(objRid)) continue;
      const obj = oir.objects.get(objRid);
      if (obj === undefined) continue;
      const ent = eid(e.apiName.value || e.rid);
      lines.push(`  ${ent}["${mlabel(e.displayName.value || e.apiName.value)}"] `
        + `}o..o{ ${eid(obj.apiName.value || obj.rid)} : "载荷"`);
    }
  }
  return lines.join("\n");
}
