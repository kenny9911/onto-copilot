/**
 * 主动建议 —— Copilot 里"副驾"的那一半。移植自 `src/ontocopilot/onto/suggest.py`，
 * 由 `golden/onto.suggest.json`（`tools/golden/onto_suggest.py` 导出）钉住。
 *
 * 反问（`clarify.ts`）解决的是"我不确定，你来定"；建议解决的是"我看出来了，
 * 你要不要"。两者的区别不是语气，是**代价结构**：
 * 反问必须先停下来等人，所以问多了就是骚扰，`thetaAsk` 卡得很紧；
 * 建议不阻塞任何事，代价只有一行字，所以可以给得多，但**每条都必须能立刻执行**。
 * "这里可以再优化一下"不是建议，是废话。
 *
 * 因此这里每条建议都带三样东西：
 *     · 依据（citations）—— 指回材料里的真实位置，人能自己核；
 *     · 影响面（impact）—— 采纳会动多少个对象，决定排序；
 *     · 动作（kind + payload）—— 前端能直接调的一次调用，不需要人再翻译一遍。
 *
 * 全部由规则推导。这类判断（命名后缀、孤儿聚集、临时表）规则判得比模型准，也不
 * 花钱 —— ADR-5。
 *
 * ── 移植时被钉住的 Python/JS 分叉 ────────────────────────────────
 *
 *  1. **`$` 与串尾换行**：Python 的 `$`（不带 MULTILINE）除了串尾，也匹配
 *     **串尾换行之前**。`_TECHNICAL` 靠 `$` 认后缀，而从 xlsx 抽出来的对象名
 *     末尾带 `\n` 是常态（单元格里的回车没清干净）。照 JS 的 `$` 写，
 *     `orderLog\n` 这一整类技术表会被漏掉。见 `TECHNICAL`。
 *  2. **空容器的真值**：Python 里 `[]` / `{}` 是假，JS 里是真。
 *     `hot or bare`、`not o.properties`、`not r.applies_to` 三处全靠它，
 *     写成 `hot ?? bare` 会永远走 `hot`（哪怕它是空的），文案跟着错。
 *  3. **`round(x, 2)`**：Python 是 round-half-**even**。复用 `shape.ts` 的
 *     `pyRound`，不要用 `toFixed`。
 *  4. **字符串切片**：`statement[:120]` 按 code point 切；规则正文全是中文。
 *
 * ── 关于"写死的清单" ────────────────────────────────────────────
 *
 * `HEAD` / `LINE` / `REL` / `TECHNICAL` 是 Python 原件里就有的固定词表，
 * 五条规则的标题与措辞也是固定中文。这里**照实迁**，没有新增也没有"修好" ——
 * 迁移期唯一的目标是行为等价。它们值不值得改成从证据推导，是迁移之后另一件事。
 */

import { pyRepr } from "../kernel/errors.js";
import {
  Cardinality,
  Status,
  byUser,
  cite,
  inferred,
  makeLinkType,
  makeRid,
  parseCardinality,
  type Assertion,
  type BusinessRule,
  type ObjectType,
  type OIR,
} from "./oir.js";
import { pyRound } from "./shape.js";

// ══════════════════════════════════════════════════════════════════
//  Python 语义垫片
// ══════════════════════════════════════════════════════════════════

/** `str(x)`。`str(None)` 是 `"None"` —— `apply_suggestion` 里
 * `str(spec.get("cardinality", "ONE_TO_MANY"))` 拿到 None 时会去解析 `"None"`
 * 然后落进 ValueError 兜底，而 `String(null)` 给的是 `"null"`。这条路径上两者
 * 都会兜底，但兜底之外的字符串（比如 `1`）必须一致。 */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  return String(v);
}

/** `s[:n]`：按 code point 切。规则正文、对象名全是中文，按 UTF-16 切会短一半，
 * 遇到 emoji 还会切出半个代理对。 */
function cpSlice(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

// ══════════════════════════════════════════════════════════════════
//  建议
// ══════════════════════════════════════════════════════════════════

/** 建议类型。决定前端渲染成什么按钮。 */
export const SuggestionKind = {
  ADD_LINK: "ADD_LINK", // 补一条关系
  ASK_MATERIAL: "ASK_MATERIAL", // 找客户要缺失的材料
  EXCLUDE: "EXCLUDE", // 把不该建模的东西排除出去
  NAMING: "NAMING", // 命名规范
  BIND_RULE: "BIND_RULE", // 把悬空的业务规则挂到对象上
  REVIEW: "REVIEW", // 人工复核一批
} as const;
export type SuggestionKind = (typeof SuggestionKind)[keyof typeof SuggestionKind];

export function parseSuggestionKind(v: unknown): SuggestionKind {
  const s = pyStr(v);
  for (const x of Object.values(SuggestionKind)) if (x === s) return x;
  throw new RangeError(`${pyRepr(s)} is not a valid SuggestionKind`);
}

/** 一条可执行的建议。
 *
 * 纯数据 + 自由函数，不是 class：它要 JSON 往返（进 events、进前端），
 * class 的原型在 `JSON.parse` 之后就没了。 */
export interface Suggestion {
  sid: string;
  kind: SuggestionKind;
  title: string;
  rationale: string;
  /** 采纳后会影响多少个对象 —— 排序的主轴 */
  impact: number;
  /** 0~1，规则判定的把握。低于 0.5 的措辞要保守。 */
  confidence: number;
  citations: string[];
  /** 前端可直接执行的动作载荷 */
  payload: Record<string, unknown>;
}

export function makeSuggestion(
  p: Pick<Suggestion, "sid" | "kind" | "title" | "rationale"> &
    Partial<Omit<Suggestion, "sid" | "kind" | "title" | "rationale">>,
): Suggestion {
  return {
    sid: p.sid,
    kind: p.kind,
    title: p.title,
    rationale: p.rationale,
    impact: p.impact ?? 0,
    confidence: p.confidence ?? 0.8,
    citations: [...(p.citations ?? [])],
    payload: { ...(p.payload ?? {}) },
  };
}

/** 排序主轴。影响面 × 把握 —— 影响一片但没把握，和影响一个但很确定，都不该排前面。 */
export function suggestionScore(s: Suggestion): number {
  return s.impact * s.confidence;
}

export function suggestionToDict(s: Suggestion): Record<string, unknown> {
  return {
    id: s.sid,
    kind: s.kind,
    title: s.title,
    rationale: s.rationale,
    impact: s.impact,
    confidence: pyRound(s.confidence, 2),
    citations: s.citations.slice(0, 6),
    payload: s.payload,
  };
}

// ══════════════════════════════════════════════════════════════════
//  结构信号
// ══════════════════════════════════════════════════════════════════
/** 主从结构的命名后缀。头/行/明细/关系是国内 ERP 类系统里最稳定的一组约定。 */
const HEAD: ReadonlySet<string> = new Set(["header", "head", "hdr", "main", "master"]);
const LINE: ReadonlySet<string> = new Set([
  "line",
  "lines",
  "detail",
  "details",
  "item",
  "items",
  "dtl",
]);
const REL: ReadonlySet<string> = new Set([
  "rel",
  "relation",
  "ref",
  "map",
  "mapping",
  "link",
]);

/** 不该进本体的技术性表。抽出来了不等于该建模 —— 临时表、日志表、快照表进了
 * 本体，客户在模板里看到一堆看不懂的名字，回填率立刻塌掉。
 *
 * `(?=\n?$)` 不是画蛇添足：Python 的 `$` 本来就匹配"串尾"**或**"串尾换行之前"，
 * 而 JS 不带 `m` 的 `$` 只匹配串尾。对象名末尾带 `\n` 在 xlsx 抽出来的材料里
 * 太常见了（`orderLog\n`），少这一条会静默漏掉一整类技术表。
 *
 * Python 侧是私有的 `_TECHNICAL`；这里导出是为了让 golden 的单元向量直接断言
 * 这条正则本身，而不是隔着五条规则去推它。 */
export const TECHNICAL =
  /(tmp|temp|log|logs|his|hist|history|bak|backup|snapshot|stg|staging|middle|mid|sync|job|task|batch)(?=\n?$)/i;

/** 把 `pbpHeader` 拆成 `['pbp', 'header']`。拆不出来返回 null。
 * （Python 侧的 `_split_suffix`，同样为了让 golden 的单元向量能直接断言而导出。） */
export function splitSuffix(api: string): [string, string] | null {
  // 字符类全是 ASCII 显式区间，两边的正则引擎在这里没有分歧。
  const parts = api.match(/[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])/g) ?? [];
  if (parts.length < 2) return null;
  return [parts.slice(0, -1).join(""), parts[parts.length - 1]!.toLowerCase()];
}

/** 取一条断言的第一处出处。`evidence` 是列表 —— 一条断言可以由多处材料
 * 共同支撑，取第一处做展示即可，全列出来会把建议卡片撑爆。 */
function citeOf(a: Assertion<unknown> | undefined): string {
  const ev = a?.evidence ?? [];
  const first = ev[0];
  return first ? cite(first) : "";
}

/** `[c for x in xs if (c := _cite(...))]` —— 空串被 walrus 过滤掉。 */
function citesOf(items: readonly { apiName?: Assertion<unknown> }[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    const c = citeOf(it.apiName);
    if (c) out.push(c);
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════
//  引擎
// ══════════════════════════════════════════════════════════════════

/** 从 OIR 的结构里读出该说的话。
 *
 * @param minImpact 影响面小于这个数的建议不出 —— 只动一个对象的事，说了也是噪声。
 * @param limit 最多出几条。建议不阻塞，但一屏放不下就等于没给。
 */
export class SuggestionEngine {
  readonly minImpact: number;
  readonly limit: number;

  constructor(opts: { minImpact?: number; limit?: number } = {}) {
    this.minImpact = opts.minImpact ?? 1;
    this.limit = opts.limit ?? 8;
  }

  propose(oir: OIR): Suggestion[] {
    let out: Suggestion[] = [
      ...this.headLineLinks(oir),
      ...this.objectsWithoutFields(oir),
      ...this.technicalTables(oir),
      ...this.namingFamilies(oir),
      ...this.unboundRules(oir),
    ];
    out = out.filter((s) => s.impact >= this.minImpact);
    // Python 的 sort 稳定，key 是 `-score`；写成 `b.score - a.score` 才等价 ——
    // 写成 `a.score < b.score ? 1 : -1` 会在平分时把顺序打乱。
    out.sort((a, b) => suggestionScore(b) - suggestionScore(a));
    return out.slice(0, this.limit);
  }

  // ── 主从结构 ────────────────────────────────────────────────
  /** 同词根的 Header / Line 对，中间却没有关系。
   *
   * 这是登记表类材料最典型的缺口：实体清单一行一个，头和行都在，但"头包含行"
   * 这件事没有任何一行写出来 —— 它在写表的人脑子里。规则能看出来，因为词根
   * 相同、后缀一头一行，这不是巧合。 */
  private headLineLinks(oir: OIR): Suggestion[] {
    // Python 是 `{(src,tgt)} | {(tgt,src)}` 的元组集合；JS 的 Set 比引用，
    // 元组进不去，只能拼串。rid 是 slug，不会含 \u0000。
    const linked = new Set<string>();
    for (const l of oir.links.values()) {
      linked.add(`${l.source}\u0000${l.target}`);
      linked.add(`${l.target}\u0000${l.source}`);
    }

    const byStem = new Map<string, Map<string, ObjectType>>();
    for (const ot of oir.objects.values()) {
      const sp = splitSuffix(ot.apiName.value);
      if (!sp) continue;
      const [stem, suf] = sp;
      const role = HEAD.has(suf)
        ? "head"
        : LINE.has(suf)
          ? "line"
          : REL.has(suf)
            ? "rel"
            : "";
      if (!role) continue;
      const key = stem.toLowerCase();
      let roles = byStem.get(key);
      if (!roles) byStem.set(key, (roles = new Map()));
      if (!roles.has(role)) roles.set(role, ot); // setdefault：先来的赢
    }

    const pairs: [string, ObjectType, ObjectType][] = [];
    for (const stem of [...byStem.keys()].sort(cmpCodePoint)) {
      const roles = byStem.get(stem)!;
      const head = roles.get("head");
      const line = roles.get("line");
      if (head === undefined || line === undefined) continue;
      if (linked.has(`${head.rid}\u0000${line.rid}`)) continue;
      pairs.push([stem, head, line]);
    }
    if (pairs.length === 0) return [];

    const cites = citesOf(pairs.slice(0, 6).map(([, h]) => h));
    return [
      makeSuggestion({
        sid: "sg-headline",
        kind: SuggestionKind.ADD_LINK,
        title: `补 ${pairs.length} 组「头—行」包含关系`,
        rationale:
          "这些对象成对出现、词根相同、后缀一个是头一个是行（" +
          pairs
            .slice(0, 3)
            .map(([, h, l]) => `${h.apiName.value}↔${l.apiName.value}`)
            .join("、") +
          (pairs.length > 3 ? "……" : "") +
          "），但材料里没有任何一行写出它们的从属关系 —— " +
          "写表的人默认它是常识。不补上，下游生成的模型里行数据是游离的，" +
          "删掉一个头不会带走它的行。",
        impact: pairs.length * 2,
        confidence: 0.85,
        citations: cites,
        payload: {
          links: pairs.map(([stem, h, l]) => ({
            source: h.rid,
            target: l.rid,
            api_name: `${stem}Lines`,
            cardinality: "ONE_TO_MANY",
          })),
        },
      }),
    ];
  }

  // ── 有对象没字段 ────────────────────────────────────────────
  /** 对象抽全了、字段一个没有 —— 这不是抽漏，是材料里就没有。
   *
   * 区分这两件事很重要：抽漏该重试，材料缺该去要材料。判据是有没有行动 ——
   * 连接口都定义好了却没人写字段，说明字段表在另一份文件里。 */
  private objectsWithoutFields(oir: OIR): Suggestion[] {
    const bare = [...oir.objects.values()].filter(
      (o) => o.properties.length === 0 && o.status !== Status.REJECTED,
    );
    // `len(bare) < len(objects) * 0.8` 是**真除**。5 个对象 4 个光杆时
    // `4 < 4.0` 为假，建议照出 —— 写成整除或 `<=` 这条边界就翻了。
    if (bare.length === 0 || bare.length < oir.objects.size * 0.8) return [];

    const withAction = new Set<string>();
    for (const a of oir.actions.values()) for (const r of a.appliesTo) withAction.add(r);
    const hot = bare.filter((o) => withAction.has(o.rid));
    // Python 的 `hot or bare`：空列表是假值。`hot ?? bare` 永远拿 hot。
    const focus = hot.length > 0 ? hot : bare;
    const cites = citesOf(focus.slice(0, 5));
    return [
      makeSuggestion({
        sid: "sg-nofields",
        kind: SuggestionKind.ASK_MATERIAL,
        title: `${bare.length} 个对象没有任何字段，需要再要一份字段梳理表`,
        rationale:
          "当前材料是一份**实体清单**，一行一个对象，没有字段列 —— " +
          "所以零字段是材料的实情，不是抽取漏了。" +
          (hot.length > 0
            ? `其中 ${hot.length} 个对象已经定义了接口却没有字段，` +
              "说明字段定义在另一份文件里。"
            : "") +
          "没有字段就没有口径，模板发下去客户也没东西可确认。",
        impact: bare.length,
        confidence: 0.9,
        citations: cites,
        payload: {
          ask: "字段梳理表（每行一个字段：所属对象/字段名/类型/口径/是否必填）",
          objects: focus.slice(0, 50).map((o) => o.rid),
        },
      }),
    ];
  }

  // ── 技术表 ──────────────────────────────────────────────────
  private technicalTables(oir: OIR): Suggestion[] {
    // 已经标记排除的不再建议 —— 采纳完还挂在那里，用户会以为没生效，
    // 然后再点一次。
    const tech = [...oir.objects.values()].filter(
      (o) => TECHNICAL.test(o.apiName.value) && o.status !== Status.REJECTED,
    );
    if (tech.length === 0) return [];
    return [
      makeSuggestion({
        sid: "sg-technical",
        kind: SuggestionKind.EXCLUDE,
        title: `${tech.length} 个疑似临时/日志表，建议不进本体`,
        rationale:
          "命名以 Tmp/Log/His/Sync 之类结尾（" +
          tech
            .slice(0, 4)
            .map((o) => o.apiName.value)
            .join("、") +
          (tech.length > 4 ? "……" : "") +
          "），这类是技术实现产物，不是业务概念。放进模板会让客户在" +
          "一堆看不懂的名字里找自己那几个，回填率会明显下降。" +
          "**先别删，标记排除即可** —— 万一其中有个是业务表，删了不好找回来。",
        impact: tech.length,
        confidence: 0.7,
        citations: citesOf(tech.slice(0, 5)),
        payload: { objects: tech.map((o) => o.rid) },
      }),
    ];
  }

  // ── 命名家族 ────────────────────────────────────────────────
  /** 多个前缀家族并存，说明这份材料是多个系统拼出来的。 */
  private namingFamilies(oir: OIR): Suggestion[] {
    const fam = new Map<string, string[]>();
    for (const ot of oir.objects.values()) {
      const m = /^([a-z]{2,5})(?=[A-Z])/.exec(ot.apiName.value);
      if (!m) continue;
      const key = m[1]!;
      const bucket = fam.get(key);
      if (bucket) bucket.push(ot.apiName.value);
      else fam.set(key, [ot.apiName.value]);
    }
    const big = [...fam.entries()].filter(([, v]) => v.length >= 3);
    if (big.length < 2) return [];
    // `sorted(key=-len)` 是稳定排序：并列的按 dict 插入序，也就是 fam 的插入序。
    const top = [...big].sort((a, b) => b[1].length - a[1].length);
    const families: Record<string, string[]> = {};
    for (const [k, v] of top) families[k] = v.slice(0, 10);
    return [
      makeSuggestion({
        sid: "sg-naming",
        kind: SuggestionKind.NAMING,
        title: `存在 ${big.length} 套命名前缀，建议先定命名规范再回传`,
        rationale:
          "对象名分成了 " +
          top
            .slice(0, 4)
            .map(([k, v]) => `${k}*（${v.length} 个）`)
            .join("、") +
          " 几个家族 —— 通常意味着这份材料是几个子系统各写各的拼起来的。" +
          "跨家族的同名概念很可能是同一个东西，等模板发出去再发现，" +
          "客户已经按两套名字各填了一遍。",
        impact: big.reduce((n, [, v]) => n + v.length, 0),
        confidence: 0.6,
        citations: [],
        payload: { families },
      }),
    ];
  }

  // ── 悬空规则 ────────────────────────────────────────────────
  private unboundRules(oir: OIR): Suggestion[] {
    const loose: BusinessRule[] = [...oir.rules.values()].filter(
      (r) => r.appliesTo.length === 0 && r.status === Status.CANDIDATE,
    );
    if (loose.length === 0) return [];
    const cites: string[] = [];
    for (const r of loose.slice(0, 5)) {
      const c = citeOf(r.statement);
      if (c) cites.push(c);
    }
    return [
      makeSuggestion({
        sid: "sg-rules",
        kind: SuggestionKind.BIND_RULE,
        title: `${loose.length} 条业务规则还没挂到对象上`,
        rationale:
          "这些规则从散文里挖出来了，但材料没点名它约束哪个对象，" +
          "抽取时按规矩留空而不是猜。挂错比不挂更糟 —— " +
          "错误的约束会被下游当成真的执行。这一批适合一次性人工过一遍，" +
          "每条只需要选一个对象。",
        impact: loose.length,
        confidence: 0.95,
        citations: cites,
        payload: {
          rules: loose.slice(0, 30).map((r) => ({
            rid: r.rid,
            statement: cpSlice(r.statement.value, 120),
          })),
        },
      }),
    ];
  }
}

/** Python 的 `sorted()` 按 code point 比字符串；JS 默认 sort 按 UTF-16 码元。
 * 词根目前都是 ASCII，但 `_split_suffix` 的输入来自材料，不值得赌。 */
function cmpCodePoint(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const ra = ia.next();
    const rb = ib.next();
    if (ra.done === true && rb.done === true) return 0;
    if (ra.done === true) return -1;
    if (rb.done === true) return 1;
    const ca = ra.value.codePointAt(0)!;
    const cb = rb.value.codePointAt(0)!;
    if (ca !== cb) return ca - cb;
  }
}

/** 便捷入口。 */
export function suggest(oir: OIR, opts: { limit?: number } = {}): Record<string, unknown>[] {
  return new SuggestionEngine({ limit: opts.limit ?? 8 })
    .propose(oir)
    .map(suggestionToDict);
}

// ══════════════════════════════════════════════════════════════════
//  执行
// ══════════════════════════════════════════════════════════════════

export interface ApplyResult {
  kind: string;
  label: string;
  changed: string[];
}

/** 把一条建议真的落进 OIR。返回 `{kind, label, changed}`。
 *
 * 在此之前 `suggest()` 只产出数据，没有任何代码消费 payload —— 界面上
 * "采纳"一句话，产物纹丝不动。**一个采纳不了的建议不如不给**：它让人以为
 * 自己做了决定，而实际上什么都没发生，等到模板发出去才发现，返工代价最大。
 *
 * 落地的东西一律标 `Origin.USER`：这是人拍的板，后续任何自动逻辑不得覆盖它。 */
export function applySuggestion(
  oir: OIR,
  sug: Record<string, unknown>,
  opts: { note?: string } = {},
): ApplyResult {
  const note = opts.note ?? "";
  // `sug.get("kind") or ""`：None / "" / 0 都回落成空串。
  const kindRaw = sug["kind"];
  const kind = kindRaw === undefined || kindRaw === null || kindRaw === "" ? "" : pyStr(kindRaw);
  const payload = asRecord(sug["payload"]);
  const changed: string[] = [];

  if (kind === "ADD_LINK") {
    for (const specRaw of asArray(payload["links"])) {
      const spec = asRecord(specRaw);
      const src = spec["source"];
      const tgt = spec["target"];
      if (typeof src !== "string" || !oir.objects.has(src)) continue;
      if (typeof tgt !== "string" || !oir.objects.has(tgt)) continue;
      const apiRaw = spec["api_name"];
      const api = apiRaw === undefined || apiRaw === null || apiRaw === "" ? "" : pyStr(apiRaw);
      const rid = makeRid("lt", api);
      if (oir.links.has(rid)) continue;
      // `dict.get(k, default)` 只在**键不存在**时给默认值；键在但值是 None
      // 时拿到的是 None，`str(None)` = "None" → 解析失败 → 走兜底。
      const raw = "cardinality" in spec ? spec["cardinality"] : "ONE_TO_MANY";
      let card: Cardinality;
      try {
        card = parseCardinality(pyStr(raw).toUpperCase());
      } catch {
        card = Cardinality.ONE_TO_MANY;
      }
      oir.addLink(
        makeLinkType({
          rid,
          apiName: byUser(api, note || "采纳「补头—行关系」建议"),
          source: src,
          target: tgt,
          cardinality: byUser(card, note || "头一对多行"),
          joinKey: inferred(null),
        }),
      );
      changed.push(rid);
    }
  } else if (kind === "EXCLUDE") {
    // **标记而不是删除。** 万一其中有个是业务表，删了不好找回来 ——
    // 这正是这条建议自己的措辞里承诺过的。
    for (const rid of asArray(payload["objects"])) {
      if (typeof rid !== "string") continue;
      const ot = oir.objects.get(rid);
      if (ot === undefined || ot.status === Status.REJECTED) continue;
      ot.status = Status.REJECTED;
      changed.push(rid);
    }
  } else if (kind === "BIND_RULE") {
    // 挂规则要人一条条选对象，这里只能把它们标成待人处理，不能替人挂。
    for (const itemRaw of asArray(payload["rules"])) {
      const item = asRecord(itemRaw);
      const ridRaw = item["rid"];
      const key = ridRaw === undefined || ridRaw === null || ridRaw === "" ? "" : pyStr(ridRaw);
      const br = oir.rules.get(key);
      if (br !== undefined && br.status === Status.CANDIDATE) {
        br.status = Status.PROPOSED;
        changed.push(br.rid);
      }
    }
  }

  const titleRaw = sug["title"];
  const label =
    titleRaw === undefined || titleRaw === null || titleRaw === "" ? "" : pyStr(titleRaw);
  return { kind, label, changed };
}

/** `x or {}` —— 非 dict 的脏输入在 Python 侧会在 `.get()` 上炸；这里的调用方
 * 全是 JSON 反序列化的结果，统一按"取不到就当空"处理，与 `or {}` 同效。 */
function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** `x or []`。 */
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
