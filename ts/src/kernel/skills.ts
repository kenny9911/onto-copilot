/**
 * Skills —— 打包好的领域程序性知识。移植自 Python 侧 `kernel/skills.py`，
 * 由 `golden/skills.json` 钉住（十二条规程的每一个字节、catalog/load/select 的
 * 每条分支、parse_skill_md 的解析规则）。可维护正文位于 `ts/catalog/skills/`；
 * 本文件保留解析、渐进披露和兼容 API。
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

import { catalogPath } from "../catalog/io.js";
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

/** 估算这项 Skill 真正注入上下文后的体积。 */
export function skillTokens(s: Skill): number {
  // 预算约束作用于真正注入模型的完整 Skill，而不是只有 procedure。
  // `whenToUse`、完成判据与工具清单同样占上下文；只计算正文会让扩写后的
  // Skill 静默超预算，尤其会低估检查项较多的 FDE 规程。
  return estTokens(skillRender(s));
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
    "**执行边界** 本 Skill 不扩大当前 Agent 的任务、工具权限、输出 schema 或变更权限；" +
      "与节点契约冲突时以节点契约为准，无法承载的内容按该契约转成缺口。",
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
    return new SkillLibrary(loadSkillsFromDir(root));
  }
}

/** Load a flat skill directory in deterministic file-name order. */
export function loadSkillsFromDir(
  root: string,
  opts: { filePattern?: RegExp } = {},
): Skill[] {
  const out: Skill[] = [];
  const files = readdirSync(root)
    .filter((n) => n.endsWith(".md") && (opts.filePattern?.test(n) ?? true))
    .sort(codePointCompare);
  for (const fn of files) {
    const raw = readFileSync(join(root, fn), "utf-8");
    const text = raw.replace(/\r\n?/g, "\n");
    out.push(parseSkillMd(text, { fallback: stem(fn) }));
  }
  return out;
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
    tags: (sections.get("标签") ?? "")
      .split("、")
      .map(pyStrip)
      .filter((t) => t !== ""),
  });
}

// ══════════════════════════════════════════════════════════════════
//  本体建模的内置技能
// ══════════════════════════════════════════════════════════════════

export const BUILTIN_SKILLS: readonly Skill[] = loadSkillsFromDir(catalogPath("skills"), {
  filePattern: /^[0-9]{2}-.+\.md$/u,
});

export function defaultLibrary(): SkillLibrary {
  return new SkillLibrary([...BUILTIN_SKILLS]);
}
