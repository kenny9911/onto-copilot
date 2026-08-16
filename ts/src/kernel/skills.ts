/**
 * Skills —— 打包好的领域程序性知识。移植自 Python 侧 `kernel/skills.py`，
 * 由 `golden/skills.json` 钉住（十二条规程的每一个字节、catalog/load/select 的
 * 每条分支、parse_skill_md 的解析规则）。
 *
 * 一个 Skill 是"这类活该怎么干"的成文办法：口径怎么对齐、命名怎么归一、
 * ActionType 怎么从 OpenAPI 反推。它不是提示词模板，而是**带检查清单的操作规程**。
 *
 * **渐进披露是这个机制的全部意义。** 默认只有一句 description 在上下文里；模型
 * 判断相关时才载入正文。全量塞进去就退化成一个巨大的系统提示词 —— 那样既贵，又会
 * 把真正相关的那条淹掉。
 *
 * 三类内容缺一不可：
 *
 * * `whenToUse` —— 触发条件。写不清楚触发条件的 skill 要么不被用、要么滥用。
 * * `procedure` —— 步骤。给做法，不给背景知识。
 * * `checklist` —— 完成判据。没有判据的规程无法验收，也无法进 critic。
 *
 * ── 移植期的形态选择 ──────────────────────────────────────────────
 *
 * 1. **`Skill` 是 interface + 自由函数，不是 class。** 它要能 JSON 往返
 *    （`from_dir` 解析出来、进 prompt、写日志），而 `tokens` / `brief()` /
 *    `render()` 三者都是**纯派生**，没有状态。按契约 §1，纯数据用 interface。
 * 2. **正则里的 `\s` 与 `strip()` 都按 Python 的字符集重写**（见 `PY_SPACE`）。
 *    JS 的 `\s` 含 U+FEFF 而不含 U+001C–U+001F / U+0085，两边差的正好是"看不见的
 *    字符"—— markdown 是人手写的，这类字符真的会出现在从 Word 粘出来的段落里。
 * 3. **`^` / `$` 用前后瞻手写，不用 `m` 标志。** JS 的 `m` 会把 `\r` / U+2028 /
 *    U+2029 也当行首行尾，Python 的 `re.MULTILINE` 只认 `\n`。差异会让一份
 *    CRLF 的 skill 文件在两边解析出不同的正文。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { pyRepr } from "./errors.js";
import { estTokens } from "./memory/types.js";

// ══════════════════════════════════════════════════════════════════
//  Python 语义小工具
// ══════════════════════════════════════════════════════════════════

/** Python `str` 的 `\s`（== `str.isspace()` 的字符集）。
 * 与 JS 内建 `\s` 的差集：Python 多 `\x1c-\x1f` 与 `\x85`，JS 多 `﻿`。 */
const PY_SPACE =
  " \\t\\n\\r\\f\\v\\x1c-\\x1f\\x85\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029" +
  "\\u202f\\u205f\\u3000";

const PY_SPACE_RE = new RegExp(`[${PY_SPACE}]`);

/** Python `str.strip()`：按上面的字符集剥两端。
 * agents.ts 的 `render_system` 也用它 —— 同一个 `strip()` 语义留两份实现，
 * 迟早在某个不可见字符上分叉。 */
export function pyStrip(s: string): string {
  let i = 0;
  let j = s.length;
  while (i < j && PY_SPACE_RE.test(s[i]!)) i++;
  while (j > i && PY_SPACE_RE.test(s[j - 1]!)) j--;
  return s.slice(i, j);
}

/** Python `str.strip(chars)`：剥的是**字符集合**，不是前缀串。
 * `"- [x] a".strip(" -[]x")` → `"a"`（末尾的 `x` 也会被剥掉，这不是 bug）。 */
function stripChars(s: string, chars: string): string {
  const set = new Set(chars);
  let i = 0;
  let j = s.length;
  while (i < j && set.has(s[i]!)) i++;
  while (j > i && set.has(s[j - 1]!)) j--;
  return s.slice(i, j);
}

/** Python `str.splitlines()`。JS 的 `split("\n")` 少认七种分隔符，而 `\v` / `\f` /
 * U+2028 恰恰是从富文本粘贴过来的 markdown 里的常客。 */
function pySplitlines(s: string): string[] {
  if (s === "") return [];
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const code = c.charCodeAt(0);
    const isBreak =
      code === 0x0a || code === 0x0b || code === 0x0c || code === 0x0d ||
      code === 0x1c || code === 0x1d || code === 0x1e || code === 0x85 ||
      code === 0x2028 || code === 0x2029;
    if (!isBreak) {
      cur += c;
      continue;
    }
    out.push(cur);
    cur = "";
    if (code === 0x0d && s[i + 1] === "\n") i++; // \r\n 算一个
  }
  if (cur !== "") out.push(cur);
  return out;
}

/** Python str 比较按 code point；JS `Array.sort()` 按 UTF-16 code unit。
 * skill 名字全是 BMP 内的中文，但 `from_dir` 载入的名字来自用户文件，
 * emoji 完全可能出现 —— `names()` 的顺序进 prompt，一漂就是不同的输入。 */
function codePointCompare(a: string, b: string): number {
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

/** `sorted(xs)` 的等价物。 */
function sortedCp(xs: Iterable<string>): string[] {
  return [...xs].sort(codePointCompare);
}

/** Python `f"{list_of_str}"` —— `str(list)` 用元素的 `repr`。 */
function pyReprList(items: readonly string[]): string {
  return `[${items.map(pyRepr).join(", ")}]`;
}

/**
 * Python `KeyError` 的替身。
 *
 * **不新起一个导出类**：TS 侧已经有两份 `KeyError`（`onto/canonical.ts` 与
 * `onto/questions.ts`），kernel 再加第三份只会让 `instanceof` 更不可靠；而
 * kernel 反过来 import onto 是层级倒挂。全仓没有任何地方 catch 这两个 library
 * 的缺键异常（Python 侧同样只在测试里断言消息），所以这里只保证 **name 与消息**
 * 与 Python 一致，不制造新的类身份。
 */
export function keyError(message: string): Error {
  const e = new Error(message);
  e.name = "KeyError";
  return e;
}

// ══════════════════════════════════════════════════════════════════
//  Skill
// ══════════════════════════════════════════════════════════════════

export interface Skill {
  readonly name: string;
  /** 一句话，常驻上下文。 */
  readonly description: string;
  readonly whenToUse: string;
  /** 正文，按需载入。 */
  readonly procedure: string;
  readonly checklist: readonly string[];
  /** 这个 skill 需要哪些工具。 */
  readonly tools: readonly string[];
  readonly tags: readonly string[];
}

/** 默认值写成模块级常量而不是 class field —— 见契约 §1。 */
export const SKILL_DEFAULTS = {
  checklist: [] as readonly string[],
  tools: [] as readonly string[],
  tags: [] as readonly string[],
} as const;

export function makeSkill(
  init: Partial<Skill> & Pick<Skill, "name" | "description" | "whenToUse" | "procedure">,
): Skill {
  return {
    name: init.name,
    description: init.description,
    whenToUse: init.whenToUse,
    procedure: init.procedure,
    // 每次新数组：共享引用会让一处 push 悄悄改掉另一个 skill 的清单。
    checklist: [...(init.checklist ?? SKILL_DEFAULTS.checklist)],
    tools: [...(init.tools ?? SKILL_DEFAULTS.tools)],
    tags: [...(init.tags ?? SKILL_DEFAULTS.tags)],
  };
}

/** Python 侧是 `@property tokens`。 */
export function skillTokens(s: Skill): number {
  return estTokens(s.procedure);
}

/** 常驻形态 —— 只够模型判断"要不要载入"。 */
export function skillBrief(s: Skill): string {
  return `- **${s.name}**：${s.description}　（何时用：${s.whenToUse}）`;
}

/** 载入形态。 */
export function skillRender(s: Skill): string {
  const parts = [
    `## Skill: ${s.name}`,
    `**何时用** ${s.whenToUse}`,
    "",
    pyStrip(s.procedure),
  ];
  if (s.checklist.length > 0) {
    parts.push("", "**完成判据**（逐条自查，做不到就说明做不到，不要含糊过去）");
    for (const c of s.checklist) parts.push(`- [ ] ${c}`);
  }
  if (s.tools.length > 0) {
    parts.push("", `**需要的工具** ${s.tools.join("、")}`);
  }
  return parts.join("\n");
}

// ══════════════════════════════════════════════════════════════════
//  SkillLibrary
// ══════════════════════════════════════════════════════════════════

/** 技能库。按需载入，不全量塞。 */
export class SkillLibrary {
  private readonly skills = new Map<string, Skill>();

  constructor(skills?: readonly Skill[] | null) {
    for (const s of skills ?? []) this.skills.set(s.name, s);
  }

  register(skill: Skill): this {
    this.skills.set(skill.name, skill);
    return this;
  }

  get(name: string): Skill {
    const s = this.skills.get(name);
    if (s === undefined) {
      throw keyError(
        `没有名为 ${pyRepr(name)} 的 skill（已注册：${pyReprList(this.names())}）`,
      );
    }
    return s;
  }

  /** Python 的 `__len__`。 */
  get size(): number {
    return this.skills.size;
  }

  names(): string[] {
    return sortedCp(this.skills.keys());
  }

  // ── 渐进披露 ────────────────────────────────────────────────
  /**
   * 常驻目录。只有 description + 触发条件，没有正文。
   *
   * **空列表等于不筛选。** Python 写的是 `names or self.names()`，`[]` 落到 `or`
   * 的假分支，返回的是**全量**目录。按类型签名想当然地写成"给了列表就按列表过滤"，
   * 会让一个 skills 为空的 agent 从"没有目录"变成"拿到全部目录"，反过来也一样。
   */
  catalog(names?: readonly string[] | null): string {
    const wanted = names === undefined || names === null || names.length === 0
      ? this.names()
      : names;
    const picked = wanted
      .map((n) => this.skills.get(n))
      .filter((s): s is Skill => s !== undefined);
    if (picked.length === 0) return "";
    return (
      "## 可用技能（需要时按名载入，不要凭印象照做）\n" +
      picked.map(skillBrief).join("\n")
    );
  }

  /**
   * 载入若干 skill 正文。超预算就截断并明说截了 —— 悄悄少载入一条规程，
   * 产物会以看不出来的方式变差。
   *
   * 判据是 `spent + tokens > budget`（严格大于），所以**恰好用完预算的那条会被
   * 载入**；也不是丢掉一整个后缀 —— 后面更短的 skill 仍可能挤进来。
   */
  load(names: readonly string[], opts: { budgetTokens?: number | null } = {}): string {
    const budget = opts.budgetTokens ?? null;
    const out: string[] = [];
    const dropped: string[] = [];
    let spent = 0;
    for (const n of names) {
      const s = this.skills.get(n);
      if (s === undefined) continue; // 未注册的静默跳过（Python 同）
      const t = skillTokens(s);
      if (budget !== null && spent + t > budget) {
        dropped.push(n);
        continue;
      }
      out.push(skillRender(s));
      spent += t;
    }
    if (dropped.length > 0) {
      out.push(`〔注意：因上下文预算不足，未载入技能 ${dropped.join("、")}〕`);
    }
    return out.join("\n\n");
  }

  /**
   * 按任务文本挑相关 skill。
   *
   * 词元重叠 + tag 命中，故意做得简单：**skill 选错的代价远小于选不到**，
   * 而复杂的选择器本身会引入难以调试的失败模式。
   *
   * `overlap / len(q | hay)` 是**真除**不是整除；分数并列时靠注册顺序决定先后
   * （Python 的 `list.sort` 稳定，JS 的 `Array.sort` 自 ES2019 起也稳定），
   * golden 里 `"对齐"` 那条专门钉这个。
   */
  select(task: string, opts: { limit?: number } = {}): string[] {
    const limit = opts.limit ?? 3;
    const q = new Set(tok(task));
    if (q.size === 0) return [];
    const scored: { score: number; name: string }[] = [];
    for (const s of this.skills.values()) {
      const hay = new Set(
        tok(`${s.name} ${s.description} ${s.whenToUse} ${s.tags.join(" ")}`),
      );
      if (hay.size === 0) continue;
      let overlap = 0;
      for (const t of q) if (hay.has(t)) overlap++;
      if (overlap > 0) {
        const union = new Set([...q, ...hay]).size;
        scored.push({ score: overlap / union, name: s.name });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((p) => p.name);
  }

  // ── 磁盘 ────────────────────────────────────────────────────
  /**
   * 从目录载入 markdown skill。每个 `*.md` 一个 skill。
   *
   * 格式：H1 是名字，紧随其后的引用块是 description，`## 何时用` / `## 步骤` /
   * `## 完成判据` 三节。
   *
   * 两处 Python 语义要照搬：`sorted(glob("*.md"))` 决定注册顺序（同名 H1 后来者
   * 覆盖前者），以及 `read_text` 的**通用换行**转换（文本模式会把 `\r\n` / `\r`
   * 折成 `\n`，Node 不会 —— 不补这一步，CRLF 文件的正文里会多出一串 `\r`）。
   */
  static fromDir(root: string): SkillLibrary {
    const lib = new SkillLibrary();
    const files = readdirSync(root)
      .filter((n) => n.endsWith(".md"))
      .sort(codePointCompare);
    for (const fn of files) {
      const raw = readFileSync(join(root, fn), "utf-8");
      const text = raw.replace(/\r\n?/g, "\n");
      lib.register(parseSkillMd(text, { fallback: stem(fn) }));
    }
    return lib;
  }
}

/** Python `Path.stem`：去掉最后一个后缀。 */
function stem(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i <= 0 ? filename : filename.slice(0, i);
}

/** Python 侧的 `_tok`：拉丁词整串、CJK 逐字。
 *
 * `[㐀-鿿]` 是 U+3400–U+9FFF —— **只有这一段**。U+3007（〇）、扩展 B（U+20000+）
 * 都落不进去，所以"〇"这种字在打分里根本不存在。别顺手扩大区间：那会改变
 * `select` 的分母（并集大小），从而改变整张排序。 */
function tok(text: string): string[] {
  const out: string[] = [];
  const re = /[a-zA-Z]+|[㐀-鿿]/gu;
  for (const m of (text || "").matchAll(re)) out.push(m[0].toLowerCase());
  return out;
}

// ══════════════════════════════════════════════════════════════════
//  markdown 解析
// ══════════════════════════════════════════════════════════════════

// Python `^`(MULTILINE) == 串首或紧跟 `\n`；`$`(MULTILINE) == 串尾或紧邻 `\n`。
// 用前后瞻手写而不是开 `m` 标志：JS 的 `m` 还认 `\r` / U+2028 / U+2029。
const BOL = "(?<![^\\n])";
const EOL = "(?=\\n|$)";

const H1_RE = new RegExp(`${BOL}#[${PY_SPACE}]+([^\\n]+)${EOL}`);
const QUOTE_RE = new RegExp(`${BOL}>[${PY_SPACE}]*([^\\n]+)${EOL}`);
// `(.+?)\s*$`：`\s` 含换行，所以这个匹配的**结束位置**可能跨过行尾的空行 ——
// 正文切片用的正是 `match.end()`，翻译时不能"顺手"把 `\s*` 收窄成同行空白。
const SECTION_RE = new RegExp(`${BOL}##[${PY_SPACE}]+([^\\n]+?)[${PY_SPACE}]*${EOL}`, "g");

export function parseSkillMd(text: string, opts: { fallback?: string } = {}): Skill {
  const fallback = opts.fallback ?? "skill";
  const h1 = H1_RE.exec(text);
  const name = h1 !== null ? pyStrip(h1[1]!) : fallback;
  const quote = QUOTE_RE.exec(text);
  const desc = quote !== null ? pyStrip(quote[1]!) : "";

  // 同名小节后者覆盖前者（Python 是 dict 赋值）。
  const sections = new Map<string, string>();
  const marks = [...text.matchAll(SECTION_RE)];
  for (let i = 0; i < marks.length; i++) {
    const mk = marks[i]!;
    const start = mk.index + mk[0].length;
    const next = marks[i + 1];
    const end = next !== undefined ? next.index : text.length;
    sections.set(pyStrip(mk[1]!), pyStrip(text.slice(start, end)));
  }

  const checklist: string[] = [];
  for (const line of pySplitlines(sections.get("完成判据") ?? "")) {
    const t = pyStrip(line);
    if (!(t.startsWith("- ") || t.startsWith("* ") || t.startsWith("- ["))) continue;
    // 剥的是**字符集合**：`"* 星号"` 里的 `*` 不在集合里，所以会原样留下。
    const c = pyStrip(stripChars(line, " -[]x"));
    if (c !== "") checklist.push(c);
  }

  return makeSkill({
    name,
    description: desc,
    whenToUse: sections.get("何时用") ?? "",
    procedure: sections.get("步骤") ?? "",
    checklist,
    tools: (sections.get("工具") ?? "")
      .split("、")
      .map(pyStrip)
      .filter((t) => t !== ""),
  });
}

// ══════════════════════════════════════════════════════════════════
//  本体建模的内置技能
// ══════════════════════════════════════════════════════════════════

export const BUILTIN_SKILLS: readonly Skill[] = [
  makeSkill({
    name: "口径对齐",
    description: "同名字段在多处出现且口径不一致时，判定差在哪个轴上并给出处置选项",
    whenToUse:
      "发现两处对同一个字段的定义不同，或字段名相同但描述里出现" +
      "含税/不含税、年度/单次、计划/执行这类限定词",
    procedure: `口径不是自由文本，它由若干正交的轴构成。逐轴比对，不要读两段中文
凭感觉判断"像不像"。

1. 对每一处定义，抽出四个轴的取值：**税**（含税/不含税）、**时间粒度**
   （年度累计/单次/月度）、**口径主体**（计划/执行）、**币种**。
2. 只比对**两边都识别出来**的轴。一边缺失不是矛盾，是信息缺失 —— 那走
   MISSING_REQUIRED，不走口径冲突。
3. 有轴冲突时给出四个选项，每个都必须附证据出处：
   拆成两个属性 / 统一为 A / 统一为 B / 转为模板中的业务必填项。
4. **绝不自行裁决。** 口径是业务事实，统一哪个口径会丢信息，必须人拍板。`,
    checklist: [
      "每处口径都标出了它来自哪个文件的哪个位置",
      "指出了具体差在哪个轴上，而不是笼统说不一致",
      "四个选项都给了，且都能点回原文",
      "没有替业务方选择口径",
    ],
    tools: ["evidence.search"],
    tags: ["口径", "冲突", "金额", "含税"],
  }),
  makeSkill({
    name: "ActionType反推",
    description: "没人填 ActionType 时，从 OpenAPI 写操作端点反推草稿让业务确认",
    whenToUse: "梳理表里 ActionType 一栏是空的，但材料里有 OpenAPI 或接口清单",
    procedure: `让业务方从"改"开始比从"写"开始完成率高得多，这是这一步的全部理由。

1. 只看**写操作**端点（POST/PUT/PATCH/DELETE）。GET 是读，不改变世界状态，
   不是 Action。
2. 按 camelCase 拆词匹配端点与对象。物理名与业务名混用是常态，整串比对基本
   匹配不上。
3. 每条草稿标 \`DRAFT_FROM_API\`，并带上端点的 JSON Pointer 作为出处。
4. **聚合成一个决策问题**，不要每个对象问一次 —— 23 个对象缺 ActionType 时，
   "要不要反推"是一次决策，逐个问会瞬间耗尽 FDE 的耐心。
5. 草稿未经确认不算数，这一点要在模板里写清楚。`,
    checklist: [
      "只用了写操作端点",
      "每条草稿都能点回 OpenAPI 的具体位置",
      "标了 DRAFT_FROM_API",
      "聚合成了一个问题而不是 N 个",
    ],
    tools: ["evidence.search"],
    tags: ["action", "openapi", "端点", "草稿"],
  }),
  makeSkill({
    name: "命名归一",
    description: "把各种命名风格归一成 lowerCamelCase，并识别哪些不能自动改",
    whenToUse: "apiName 出现下划线、中文、大驼峰或未登记缩写",
    procedure: `能自动修的只有**可逆、零语义损失、可完整记账**的那部分。

1. \`plan_amount\` → \`planAmount\`，\`Plan Amount\` → \`planAmount\`：可自动修。
2. **中文名不自动改。** 机器给的音译或直译几乎一定不是业务方想要的术语，
   要留给人填，并在模板里标黄。
3. 三个字符以内的缩写除非在术语表里登记过，否则标为存疑，不自动展开。
4. 每次自动修都要留下 \`from → to\` 的账，并标 \`AUTO_REPAIRED\`，可一键回滚。`,
    checklist: [
      "自动修的都是可逆的",
      "中文名没有被机器直译",
      "每处修改都有记账",
      "未登记的缩写被标出而不是猜着展开",
    ],
    tags: ["命名", "camelcase", "规范"],
  }),
  makeSkill({
    name: "实体对齐",
    description: "判断多份材料里的不同名字是否指同一个业务概念",
    whenToUse: "同一个概念在梳理表、DDL、OpenAPI 里有不同的名字",
    procedure: `\`采购需求计划\` / \`pbpHeader\` / \`PurchasePlan\` 常常是同一个东西。

1. 先做**结构证据**：主键类型是否一致、字段集合重叠率、行数量级是否接近。
   结构证据比名字相似度可靠得多。
2. 再做**名称证据**：camelCase 拆词后的词元重叠、编辑距离、术语表里的已知别名。
3. 两类证据都指向同一结论才合并；只有名字像、结构对不上的，**标为存疑交人判**，
   不要合并 —— 错误合并会把两个对象的属性混在一起，后面极难拆开。
4. 合并后选代表：\`apiName\` 取有 DDL 支撑的物理名，\`displayName\` 取业务表述，
   其余进 aliases。`,
    checklist: [
      "用了结构证据不只看名字",
      "存疑的没有被强行合并",
      "别名都保留在 aliases 里",
      "代表名的选择有依据",
    ],
    tools: ["evidence.search", "oir.query", "profile.column"],
    tags: ["对齐", "去重", "别名", "实体"],
  }),
  makeSkill({
    name: "回传审核",
    description: "审业务方填回来的模板，算完成度并按责任人生成打回单",
    whenToUse: "收到业务方回传的填写模板",
    procedure: `1. 按隐藏的 \`_oir_rid\` 锚点对齐。业务方会打乱行序、插行、删行，
   按行号对齐必然错位。
2. 用 \`_oir_hash\` 判断每格有没有被动过。**AI 预填被原样交回 = 这格没被审过**，
   不算已填 —— 不抓这个，整个往返闭环就是自欺欺人。
3. 规则先行：必填缺失、枚举越界、命名违规、引用完整性。秒级、零成本、零方差。
4. 只有口径矛盾和疑似敷衍才交模型，且先用启发式收窄候选。
5. 完成度按字段加权算（主键 > 口径 > 描述 > 备注），且**只统计业务必填格** ——
   把系统自己填好的算进去会让数字虚高，而 FDE 要靠这个数字决定要不要再发一轮。
6. 打回单按**责任人**分组。打回给"团队"等于打回给没有人。`,
    checklist: [
      "按锚点对齐而不是行号",
      "抓出了原样交回的预填",
      "能规则化的没交给模型",
      "完成度只算业务必填格",
      "打回单落到了具体的人",
    ],
    tags: ["回传", "审核", "打回", "完成度"],
  }),
  makeSkill({
    name: "访谈盘点",
    description: "在进场前盘清业务边界、参与角色、系统和可验证的成功标准",
    whenToUse: "FDE 刚进场、换了流程负责人，或新一轮访谈尚未建立范围基线时",
    procedure: `1. 用一句话写清本轮要解决的业务结果，同时列明确的范围外事项。
2. 建立干系人表：流程负责人、步骤执行人、数据负责人、ERP 顾问、
   审批人与最终验收人；不要把“业务部门”当作一个人。
3. 盘点每个环节使用的系统、模块、表单/接口、权威数据源及已有材料。
4. 把业务方的陈述分成已知事实、待验证假设、未知项；每条事实挂证据。
5. 约定验收产物、决策权归属、问题回复时限与下一次访谈节点。`,
    checklist: [
      "范围内、范围外和成功标准都可被验收",
      "每个关键角色都落到具体负责人或明确待定",
      "已知事实有证据，假设与事实没有混写",
      "已记录决策权、回复时限和验收人",
    ],
    tools: ["evidence.search", "evidence.rows", "oir.query"],
    tags: ["FDE", "访谈", "范围", "干系人", "intake"],
  }),
  makeSkill({
    name: "缺口追问路由",
    description: "把流程、数据、规则与系统缺口变成可回答、可排序、可指派的问题清单",
    whenToUse: "已有初版流程或本体草稿，需要决定下一轮问谁、问什么、先问哪些时",
    procedure: `1. 用结构完整性检查缺口：触发、前置条件、执行人、输入、输出、分支条件、
   异常、时限、权限、系统落点和证据。
2. 一个问题只解一个决策。把“请补充流程”改写成带上下文、字段约束与
   2~4 个有证据选项的可回答问题。
3. 按下游阻塞度、影响范围、不可逆性和证据缺口排序；不按“模型最好奇”排序。
4. 路由到有决策权的角色，指定负责人、截止时间、预期回答结构和被阻塞产物。
5. 小批次提问：每次先提交能解锁最多下游的问题；已回答、已延后和已取消的
   问题保留决策记录，不重复问。`,
    checklist: [
      "每个问题只对应一个可记录的决策",
      "问题带来源证据、影响范围和被阻塞产物",
      "负责角色、负责人、优先级和回答 schema 都已声明",
      "当前批次的每个问题都能解锁一项下游工作",
    ],
    tools: ["evidence.search", "oir.query"],
    tags: ["缺口", "追问", "问题清单", "路由", "HITL"],
  }),
  makeSkill({
    name: "流程建模",
    description: "把访谈和材料拆成有参与者、网关、异常与证据的可验证流程图",
    whenToUse: "需要从业务陈述中建立现状/目标流程，或现有流程只有顺序步骤没有语义时",
    procedure: `1. 分开 AS-IS 与 TO-BE；未被确认的改进建议不得写成现状事实。
2. 对每个步骤记录稳定 ID、动作、执行角色、触发、前置条件、输入/输出 DataObject、
   使用系统、时限与证据。
3. 显式建模排他/并行分支、回退、取消、超时和人工介入；不把异常塞进备注。
4. 为每条连线标明事件或条件，并检查开始、正常终止与异常终止可达。
5. 输出结构化流程和可视化图；图与 JSON 共用同一组 ID，不维护两份真相。`,
    checklist: [
      "AS-IS 和 TO-BE 没有混写",
      "每个步骤都有角色、输入输出、系统和证据",
      "分支、回退、超时和异常路径被显式建模",
      "图与结构化输出使用相同的稳定 ID",
    ],
    tools: ["evidence.search", "evidence.rows", "oir.query"],
    tags: ["流程", "BPMN", "步骤", "游道", "分支", "异常"],
  }),
  makeSkill({
    name: "ERP映射",
    description: "将业务步骤和对象对齐到 ERP 模块、业务对象、交易和字段",
    whenToUse: "流程涉及 SAP、Oracle、用友、金蝶或其他 ERP，需要识别标准能力与客制落点时",
    procedure: `1. 先确认产品、版本、模块、组织范围与系统别名；不用“ERP 一般如此”代替证据。
2. 对每个流程步骤建立映射：业务能力 → 模块/交易/接口 → ERP 对象/表/字段。
3. 标准、配置、增强、客制与外部系统映射分类；不确定的映射标注置信度。
4. 记录组织层级、主数据键、编码转换、单位/币种/时区转换和同步方向。
5. 将缺版本、缺字段定义、不能证实的客制逻辑路由给 ERP 顾问，不自行补全。`,
    checklist: [
      "每条映射都声明产品版本和组织范围",
      "步骤、ERP 能力、对象与字段可相互追溯",
      "标准、配置、增强、客制与外部落点已区分",
      "低置信映射已转成指派给 ERP 顾问的问题",
    ],
    tools: ["evidence.search", "evidence.rows", "oir.query", "profile.column"],
    tags: ["ERP", "SAP", "Oracle", "用友", "金蝶", "字段映射"],
  }),
  makeSkill({
    name: "规则结构化",
    description: "把散文政策和专家口径转成可判定、可溯源、可测试的 Rules",
    whenToUse: "材料或访谈出现应当、不得、只有、必须、超过、按公式计算等约束时",
    procedure: `1. 把复合句拆成原子规则，每条只有一个可判定结果。
2. 声明规则类型、触发事件、适用对象、前置条件、逻辑表达式、执行结果、
   优先级、例外和生效期。
3. 用决策表检查重叠、缺口与冲突；法规、集团政策和本地口径分开记录优先级。
4. 每条规则绑定 Action/Event/DataObject 稳定 ID 与原文证据；未绑定的产生缺口问题。
5. 为正例、边界、反例与例外分别给出验收用例，不将不可判定的目标写成规则。`,
    checklist: [
      "每条规则是原子的且有可判定结果",
      "触发、条件、结果、例外和生效期已声明",
      "规则可追溯到本体 ID 与原文证据",
      "正例、边界、反例和例外均有验收用例",
    ],
    tools: ["evidence.search", "evidence.rows", "oir.query"],
    tags: ["规则", "决策表", "DMN", "条件", "例外", "rule"],
  }),
  makeSkill({
    name: "数据对象治理",
    description: "定义 DataObject 的身份、生命周期、数据质量、敏感性和系统权威",
    whenToUse: "流程已识别输入输出，但对象定义、主键、状态、责任人或权威源不完整时",
    procedure: `1. 区分业务对象、单据、主数据、事务数据和派生数据；不按表名一对一造对象。
2. 为对象记录业务键、属性、类型/单位、基数、状态机、创建/更新事件与保留周期。
3. 标明 System of Record、复制系统、同步方向、新鲜度 SLA、数据负责人和消费者。
4. 对完整性、唯一性、有效性、一致性与及时性声明可执行规则，不只写“数据质量高”。
5. 标记个人/敏感数据、最小访问角色、脱敏与保留政策；无证据的分类转问题。`,
    checklist: [
      "对象不是从数据库表名机械复制而来",
      "业务键、状态机、权威源、负责人和生命周期已声明",
      "数据质量规则是可计算、可告警的",
      "敏感性、最小访问范围和保留政策有证据",
    ],
    tools: ["evidence.search", "evidence.rows", "oir.query", "profile.column"],
    tags: ["DataObject", "数据治理", "主数据", "数据质量", "敏感"],
  }),
  makeSkill({
    name: "交付审查",
    description: "在交付前审查流程、本体、问题决策、证据和可下载产物的一致性",
    whenToUse: "准备向 FDE、业务负责人或 ERP 顾问提交阶段产物之前",
    procedure: `1. 先运行确定性检查：JSON Schema、引用完整性、稳定 ID、重名、悬空边、状态可达性。
2. 从流程步骤双向追踪 Action、Event、DataObject、Rule 和 ERP 映射；检查可视化图与 JSON 数量、ID 一致。
3. 抽样核验证据引用，区分已确认事实、推断、未回答缺口与已延后项。
4. 检查决策记录是否有决策人、时间、原问题、回答、影响范围和被取代版本。
5. 按 blocking / warning / accepted-risk 生成交付门报告；只有 blocking 为零且必需产物
   可打开、可下载时才建议通过。`,
    checklist: [
      "Schema、引用、稳定 ID 和流程可达性检查已通过",
      "流程图与 Action/Event/DataObject/Rule JSON 可双向追踪",
      "推断、未回答问题和已接受风险均未伪装成事实",
      "每个阻断项有责任人，所有交付件均可打开和下载",
    ],
    tools: ["evidence.search", "evidence.rows", "oir.query"],
    tags: ["交付", "审查", "验收", "追溯", "质量门"],
  }),
];

export function defaultLibrary(): SkillLibrary {
  return new SkillLibrary([...BUILTIN_SKILLS]);
}
