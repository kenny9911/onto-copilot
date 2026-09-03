/**
 * 引文核验 —— 让「模型抽出来的流程」能算实证档的那一道闸。
 *
 * 模型交上来的是 `{chunk_id, quote}`，**不是** `Provenance`。出处对象只能由代码
 * 构造：模型能写出处，就等于能给自己发合格证。
 *
 * ── 三层，缺一不可 ────────────────────────────────────────────
 * 1. **存在**：chunk_id 在语料里。
 * 2. **真伪**：quote 确实出现在那个 chunk 里（归一化空白后比对）。
 * 3. **相关**：这句话真的支撑这个节点。
 *
 * 第 3 层是设计评审揪出来的漏洞。只做前两层，模型可以从材料里挑一句**真话**，
 * 贴到一个凭空捏造的节点上 —— chunk 在、原文对得上，于是拿到
 * `origin=extracted` + 非空 evidence，混进实证档、被 `mainPath()` 当骨架、
 * 进交付包。前两层一个字都拦不住这种编造。
 *
 * 相关性判据只看结构：节点名里的字符有没有落在引文里。不引入业务词表，
 * 换个行业照样成立。它是启发式，所以 S4 只记**半实证**档，不与 BPMN、
 * PPT 连线那种"文件里写着"的实证同级。
 */

import { pyNormalizeSpaces, pyStrip } from "./parse/doc/pycompat.js";

/** 模型交上来的一条引文主张。 */
export interface CitationClaim {
  /** 这条引文要支撑的节点名。 */
  readonly label: string;
  readonly chunkId: string;
  readonly quote: string;
}

export interface CitationVerdict {
  readonly ok: boolean;
  /** 不过时的理由，写成能直接回给模型自纠的一句话。 */
  readonly reason: string;
}

/**
 * 引文至少要有这么多个字符才算数。
 *
 * 不是魔数：低于这个长度的引文在任何一段中文里都几乎必然命中（单字、双字），
 * 于是第 2 层形同虚设。取 4 是"能构成一个最短业务短语"的下限
 * （「提交申请」「完成付款」都是 4 字）。
 */
const MIN_QUOTE = 4;

/** 归一化空白 —— 材料里的换行和多空格不该被当成编造。 */
function norm(s: string): string {
  return pyStrip(pyNormalizeSpaces(s)).replace(/\s+/gu, "");
}

/**
 * 节点名与引文的重合度。
 *
 * 用**字符集合**的重合比例，不做分词：分词器要么带词表（换行业失效），
 * 要么要额外依赖。中文里节点名与支撑它的句子必然共用相当一部分字。
 */
function overlapRatio(label: string, quote: string): number {
  const l = [...new Set([...norm(label)])];
  if (l.length === 0) return 0;
  const q = new Set([...norm(quote)]);
  let hit = 0;
  for (const ch of l) if (q.has(ch)) hit += 1;
  return hit / l.length;
}

/**
 * 相关性的门槛。
 *
 * 取"过半"：节点名多半是从原句里提炼的短语，共用字符通常远超一半；
 * 而随手贴一句不相干的话，重合的一般只是「的」「已」这类零星字符。
 */
const MIN_OVERLAP = 0.5;

export function verifyCitation(
  claim: CitationClaim,
  chunks: ReadonlyMap<string, string>,
): CitationVerdict {
  const { label, chunkId, quote } = claim;

  // 第 1 层：chunk 在不在
  const text = chunks.get(chunkId);
  if (text === undefined) {
    return {
      ok: false,
      reason: `「${label}」引的 chunk_id=${chunkId} 不存在。只能引用给你的那批 chunk。`,
    };
  }

  // 第 2 层：这句话是不是真的在那段里
  const q = norm(quote);
  if ([...q].length < MIN_QUOTE) {
    return {
      ok: false,
      reason: `「${label}」的引文太短（${[...q].length} 字），支撑不了一个环节。`
        + "请引一句完整的话。",
    };
  }
  if (!norm(text).includes(q)) {
    return {
      ok: false,
      reason: `「${label}」的引文在 ${chunkId} 的原文里找不到。`
        + "请原样抄材料里的句子，不要复述、不要改写。",
    };
  }

  // 第 3 层：这句话是不是真的在讲这个环节
  const ratio = overlapRatio(label, quote);
  if (ratio < MIN_OVERLAP) {
    return {
      ok: false,
      reason: `「${label}」和它的引文对不上：引文确实在材料里，但它讲的不是这个环节。`
        + "每个环节要引**支撑这个环节本身**的那句话。",
    };
  }

  return { ok: true, reason: "" };
}
