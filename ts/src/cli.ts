/**
 * 命令行入口 —— 在真实文件上跑完整流程。移植自 `cli.py`。
 *
 * ```
 * ontocopilot doctor                          # 检查配置、模型连通性、沙箱隔离等级
 * ontocopilot parse 材料/*.xlsx 材料/*.ddl      # 只解析，看看读到了什么
 * ontocopilot build 材料/* -o out/             # 全流程：解析→抽取→对齐→冲突→模板
 * ontocopilot audit out/template.spec.json 回传.xlsx
 * ```
 *
 * `build` 与 `audit` 通常隔着几天（中间是业务方在填表），所以模板规格会随
 * xlsx 一起落盘，审核时从盘上读回 —— 两边对不上是最难查的一类 bug。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  这是一个**有人写脚本在调**的接口
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 命令名、参数名、退出码、stdout/stderr 的分工一个字都没改：
 *   * 所有正常输出（含 `✗ …` 这类失败说明）走 **stdout**，与 `cli.py` 的 `_p()`
 *     一致；只有 argparse 那一层的用法错误走 **stderr** 并退 **2**。
 *   * `audit` 的退出码是三态：0 达标 / 2 未达标 / 1 出错。**别把 2 归到"错误"** ——
 *     CI 里 `|| exit 1` 那种写法会把"需要再走一轮"和"程序崩了"混成一件事。
 *   * `Ctrl-C` 退 130。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  分叉：doctor / parse / build 依赖尚未迁移的模块
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 这三条命令要用的 `onto/parse/__init__`（`default_registry` / `build_index` /
 * `collect_endpoints` / `collect_profiles` / `corpus_summary`）、`kernel/skills`、
 * `kernel/agents` 在 TS 侧**还不存在**。
 *
 * 所以它们现在**如实报"尚未迁移"并退 1**，而不是：
 *   * 假装成功 —— 那会让 `build` 静默产出空模板；
 *   * 现在就照猜出来的形状写一层适配器 —— 那五个模块落地时形状必然对不上，
 *     而一层没人验证过的适配器比没有更糟。
 * 参数解析、退出码、其余五条命令都是完整的；那三条只差把真实现接进
 * {@link cmdDoctor} / {@link cmdParse} / {@link cmdBuild} 的函数体。
 */

import { randomUUID } from "node:crypto";
import { readFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename, join, resolve } from "node:path";

import { readReturned, ReturnAuditor, auditCounts, auditSummary, mergeIntoOir, slipToDict } from "./onto/audit.js";
import type { AuditResult } from "./onto/audit.js";
import { diffChanged } from "./onto/audit.js";
import { OIR, makeObjectType, makePropertyType, parseOrigin } from "./onto/oir.js";
import type { Assertion, BaseType } from "./onto/oir.js";
import { TemplateSpec } from "./onto/template.js";
import { hashPassword, normalizeUsername } from "./auth.js";
import { adoptLocalSessions } from "./authgate.js";
import { Store, databaseUrl } from "./store/engine.js";
import { MemoryRepo } from "./store/repo/memory.js";
import { PgRepo } from "./store/repo/pg.js";
import type { Repo } from "./store/repo/protocol.js";
import { DuplicateUsername, makeUserRow } from "./store/types.js";

export const OK = "✓";
export const WARN = "!";
export const BAD = "✗";

/** `print(*a, flush=True)`。**所有**命令的正常输出都走这里（= stdout）。 */
function p(...a: unknown[]): void {
  process.stdout.write(a.map((x) => String(x)).join(" ") + "\n");
}

function rule(title = ""): void {
  p(`\n${"─".repeat(72)}` + (title ? `\n${title}` : ""));
}

/** Python 的 `f"{s:16}"`：按**码点**补空格，一个汉字算一个。
 * 用 `padEnd` 会按 UTF-16 单元算，emoji 名字会少补两格。 */
function ljust(s: string, width: number): string {
  const n = [...s].length;
  return n >= width ? s : s + " ".repeat(width - n);
}

// ══════════════════════════════════════════════════════════════════
//  argparse 的最小对等物
// ══════════════════════════════════════════════════════════════════
//
// 只做这个 CLI 真正用到的那几种：store_true、str/int/float 选项、
// `nargs="+"` 位置参数、必填的互斥组、必填子命令。行为上对齐的三处：
//   * 用法错误 → **stderr** + 退出码 **2**；
//   * `-h/--help` → stdout + 退出码 0；
//   * `--x=v` 与 `--x v` 等价。
// **不对齐**的一处：帮助文本的排版不是 argparse 的字节（那份排版没人 grep）。

/** `parse_args` 里的 `sys.exit(n)`。Python 抛的是 `SystemExit`，它是
 * `BaseException`，所以 `main` 里那个 `except Exception` 接不住 —— 这里也一样，
 * 由 {@link main} 显式识别后原样返回码。 */
export class CliExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
    this.name = "CliExit";
    Object.setPrototypeOf(this, CliExit.prototype);
  }
}

/** `Ctrl-C`。Python 的 `KeyboardInterrupt` 同样是 `BaseException`，
 * `main` 单独接它并退 130。 */
export class KeyboardInterrupt extends Error {
  constructor() {
    super("KeyboardInterrupt");
    this.name = "KeyboardInterrupt";
    Object.setPrototypeOf(this, KeyboardInterrupt.prototype);
  }
}

type OptKind = "flag" | "str" | "int" | "float";

interface OptSpec {
  readonly flags: readonly string[];
  readonly dest: string;
  readonly kind: OptKind;
  readonly dflt: unknown;
  readonly help?: string;
  /** 属于哪个必填互斥组（本 CLI 只有 role 一处）。 */
  readonly mutex?: string;
}

interface PosSpec {
  readonly dest: string;
  /** `nargs="+"`：至少一个，收成数组。 */
  readonly many?: boolean;
  readonly help?: string;
}

export interface CmdArgs {
  readonly cmd: string;
  readonly [k: string]: unknown;
}

interface CmdSpec {
  readonly name: string;
  readonly help: string;
  readonly positionals: readonly PosSpec[];
  readonly options: readonly OptSpec[];
  /** 必填互斥组的名字 → 组内的 dest 列表。 */
  readonly mutex?: { readonly name: string; readonly flags: readonly string[] };
  readonly run: (args: CmdArgs) => Promise<number> | number;
}

const PROG = "ontocopilot";
const DESCRIPTION = "面向 FDE 的本体建模副驾";
const COMMAND_NAMES = ["doctor", "parse", "build", "audit", "useradd", "passwd", "role", "users"] as const;

/** argparse 的用法错误：**stderr + 退出码 2**。
 *
 * `error:` 那一行与 Python 逐字相同（脚本会 grep 它）；上面那段 usage 的**折行**
 * 不追 —— argparse 按终端宽度折，同一条命令在不同终端里就不是同一份字节。 */
function usageError(cmd: string | null, msg: string): never {
  const who = cmd === null ? PROG : `${PROG} ${cmd}`;
  process.stderr.write(`usage: ${who} ${cmd === null ? "[-h] {" + COMMAND_NAMES.join(",") + "} ..." : "[-h] ..."}\n`);
  process.stderr.write(`${who}: error: ${msg}\n`);
  throw new CliExit(2);
}

function optHelpLine(o: OptSpec): string {
  const arg = o.kind === "flag" ? "" : " " + o.dest.toUpperCase();
  return `  ${o.flags.map((f) => f + arg).join(", ")}${o.help === undefined ? "" : "\n      " + o.help}`;
}

function printCmdHelp(c: CmdSpec): void {
  p(`usage: ${PROG} ${c.name} [-h] ...`);
  p(`\n${c.help}\n`);
  for (const pos of c.positionals) {
    p(`  ${pos.dest}${pos.help === undefined ? "" : "\n      " + pos.help}`);
  }
  p("  -h, --help\n      显示这条帮助并退出");
  for (const o of c.options) p(optHelpLine(o));
}

function printRootHelp(cmds: readonly CmdSpec[]): void {
  p(`usage: ${PROG} [-h] {${cmds.map((c) => c.name).join(",")}} ...`);
  p(`\n${DESCRIPTION}\n`);
  for (const c of cmds) p(`  ${ljust(c.name, 10)} ${c.help}`);
  p("  -h, --help  显示这条帮助并退出");
}

function toNumber(kind: "int" | "float", raw: string, flag: string, cmd: string): number {
  if (kind === "int") {
    // argparse 的 `type=int` 就是 Python 的 `int()`：小数点一律拒。
    if (!/^[+-]?\d(_?\d)*$/.test(raw.trim())) {
      usageError(cmd, `argument ${flag}: invalid int value: '${raw}'`);
    }
    return Number(raw.trim().replaceAll("_", ""));
  }
  const v = Number(raw.trim());
  if (raw.trim() === "" || Number.isNaN(v)) {
    usageError(cmd, `argument ${flag}: invalid float value: '${raw}'`);
  }
  return v;
}

export class Parser {
  constructor(readonly commands: readonly CmdSpec[]) {}

  /** **返回值不能是 `args & {spec}` 的合并对象** —— `audit` 有一个叫 `spec` 的
   * 位置参数（`template.spec.json` 的路径），合并会让命令定义把它顶掉，然后
   * `TemplateSpec.load()` 收到一个 `[object Object]`。分成两格。 */
  parse(argv: readonly string[]): { readonly args: CmdArgs; readonly spec: CmdSpec } {
    if (argv.includes("-h") && !argv.some((a) => this.commands.some((c) => c.name === a))) {
      printRootHelp(this.commands);
      throw new CliExit(0);
    }
    const first = argv[0];
    if (first === undefined) {
      usageError(null, "the following arguments are required: cmd");
    }
    if (first === "-h" || first === "--help") {
      printRootHelp(this.commands);
      throw new CliExit(0);
    }
    const spec = this.commands.find((c) => c.name === first);
    if (spec === undefined) {
      // Python 3.12+ 的 argparse 不给候选项加引号，只有那个非法值带引号。
      const choices = this.commands.map((c) => c.name).join(", ");
      usageError(null, `argument cmd: invalid choice: '${first}' (choose from ${choices})`);
    }
    return { args: this.parseCommand(spec, argv.slice(1)), spec };
  }

  private parseCommand(spec: CmdSpec, rest: readonly string[]): CmdArgs {
    const out: Record<string, unknown> = { cmd: spec.name };
    for (const o of spec.options) out[o.dest] = o.dflt;
    const positional: string[] = [];
    const seenMutex: string[] = [];
    let noMoreOptions = false;

    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i]!;
      if (!noMoreOptions && tok === "--") {
        noMoreOptions = true;
        continue;
      }
      if (!noMoreOptions && tok === "-h") {
        printCmdHelp(spec);
        throw new CliExit(0);
      }
      if (!noMoreOptions && tok === "--help") {
        printCmdHelp(spec);
        throw new CliExit(0);
      }
      if (!noMoreOptions && tok.startsWith("-") && tok !== "-") {
        const eq = tok.indexOf("=");
        const flag = eq < 0 ? tok : tok.slice(0, eq);
        const inline = eq < 0 ? undefined : tok.slice(eq + 1);
        const o = spec.options.find((x) => x.flags.includes(flag));
        if (o === undefined) usageError(spec.name, `unrecognized arguments: ${tok}`);
        if (o.mutex !== undefined) seenMutex.push(flag);
        if (o.kind === "flag") {
          if (inline !== undefined) {
            usageError(spec.name, `argument ${flag}: ignored explicit argument '${inline}'`);
          }
          out[o.dest] = true;
          continue;
        }
        let raw = inline;
        if (raw === undefined) {
          const next = rest[i + 1];
          if (next === undefined) usageError(spec.name, `argument ${flag}: expected one argument`);
          raw = next;
          i += 1;
        }
        out[o.dest] = o.kind === "str" ? raw : toNumber(o.kind, raw, flag, spec.name);
        continue;
      }
      positional.push(tok);
    }

    // 位置参数：`nargs="+"` 一定排在最后（本 CLI 就这一种形状）。
    let idx = 0;
    for (const pos of spec.positionals) {
      if (pos.many === true) {
        const got = positional.slice(idx);
        if (got.length === 0) {
          usageError(spec.name, `the following arguments are required: ${pos.dest}`);
        }
        out[pos.dest] = got;
        idx = positional.length;
        continue;
      }
      const v = positional[idx];
      if (v === undefined) {
        usageError(spec.name, `the following arguments are required: ${pos.dest}`);
      }
      out[pos.dest] = v;
      idx += 1;
    }
    if (idx < positional.length) {
      usageError(spec.name, `unrecognized arguments: ${positional.slice(idx).join(" ")}`);
    }
    if (spec.mutex !== undefined) {
      if (seenMutex.length === 0) {
        usageError(spec.name, `one of the arguments ${spec.mutex.flags.join(" ")} is required`);
      }
      if (seenMutex.length > 1) {
        usageError(spec.name, `argument ${seenMutex[1]!}: not allowed with argument ${seenMutex[0]!}`);
      }
    }
    return out as CmdArgs;
  }
}

// ══════════════════════════════════════════════════════════════════
//  doctor / parse / build —— 依赖尚未迁移的模块
// ══════════════════════════════════════════════════════════════════

/** 缺哪些模块**逐条说清**。"暂不支持"这种话会让人以为是设计选择，
 * 而这里的真相是"另外几条 track 还没落地"。 */
function notMigrated(command: string, needs: readonly string[]): number {
  process.stderr.write(
    `${BAD} ${PROG} ${command} 尚未迁移到 TS：还缺 ${needs.join("、")}。\n` +
      `  这几个模块落地之前请继续用 Python 侧的 \`python -m ontocopilot.cli ${command} …\`。\n`,
  );
  return 1;
}

export function cmdDoctor(_args: CmdArgs): number {
  return notMigrated("doctor", [
    "kernel/skills.ts",
    "kernel/agents.ts",
    "sandbox（kernel/sandbox.ts 已落地，doctor 这条路还没接）",
  ]);
}

export function cmdParse(_args: CmdArgs): number {
  return notMigrated("parse", ["onto/parse 的 default_registry / corpus_summary"]);
}

export function cmdBuild(_args: CmdArgs): number {
  return notMigrated("build", [
    "onto/parse 的 default_registry / build_index / collect_endpoints / collect_profiles / corpus_summary",
    "kernel/skills.ts",
    "kernel/agents.ts",
  ]);
}

// ══════════════════════════════════════════════════════════════════
//  audit
// ══════════════════════════════════════════════════════════════════

export async function cmdAudit(args: CmdArgs): Promise<number> {
  const specPath = String(args["spec"]);
  const returnedPath = String(args["returned"]);
  const target = Number(args["target"]);

  const spec = TemplateSpec.load(specPath);
  // `oir.json` 与 spec 同目录 —— build 就是这么写出去的。缺了不算错（审核照跑，
  // 只是不回写模型）。
  const oirPath = join(dirname_(specPath), "oir.json");
  const oir = existsFile(oirPath) ? loadOir(oirPath) : null;

  const result: AuditResult = new ReturnAuditor({ target }).audit(
    spec,
    readReturned(readFileSync(returnedPath)),
    { oir },
  );

  rule(`回传审核 · 完成度 ${pct0(result.completeness)}（达标线 ${pct0(target)}）`);
  p(`  比对 ${result.diffs.length} 格 · 改动 ${result.diffs.filter(diffChanged).length} 格`);
  p(`  问题 ${pyDict(auditCounts(result))}`);
  p(`  自动修 ${result.autoRepaired.length} 处`);
  if (result.unmatchedRows.length > 0) {
    p(
      `  ${WARN} 回传件里缺了 ${result.unmatchedRows.length} 行：` +
        `${pyList(result.unmatchedRows.slice(0, 6))}`,
    );
  }
  if (result.newRows.length > 0) {
    p(`  ${WARN} 回传件里多了 ${result.newRows.length} 行（业务方新增）`);
  }

  if (result.slips.length > 0) {
    rule("打回单");
    for (const slip of result.slips) {
      p(`\n  ${slip.owner} · ${slip.items.length} 项`);
      const byKind = slipToDict(slip)["by_kind"] as Record<string, string[]>;
      for (const [kind, items] of Object.entries(byKind)) {
        p(`    ${kind}（${items.length}）`);
        for (const it of items.slice(0, 3)) p(`      · ${it}`);
      }
    }
  }

  if (oir !== null) {
    const [merged, dropped] = mergeIntoOir(oir, result.diffs);
    p(`\n  写回 OIR ${merged.length} 处（原样交回的预填不算填写）`);
    if (dropped.length > 0) {
      // 读到了却没地方放，必须报出来。不报的话填表的人以为答案生效了、
      // FDE 看到完成度上升，而模型里什么都没变。
      p(`  ${WARN} 另有 ${dropped.length} 处填了但没有回写路径：`);
      for (const it of dropped.slice(0, 6)) p(`      · ${it}`);
    }
  }

  const out = withSuffix(returnedPath, ".audit.json");
  await writeJson(out, auditSummary(result));
  p(`\n  审核结果 ${out}`);

  const passed = result.completeness >= target && result.slips.length === 0;
  p(`\n  ${passed ? OK + " 达标，可进入发布门" : WARN + " 未达标，需再走一轮"}`);
  // **三态退出码**：0 达标 / 2 未达标。别把 2 改成 1。
  return passed ? 0 : 2;
}

// ══════════════════════════════════════════════════════════════════
//  辅助
// ══════════════════════════════════════════════════════════════════

/** Python 的 `f"{x:.0%}"`：先 ×100 再按 `.0f` 四舍五入（**banker's rounding**）。 */
function pct0(x: number): string {
  return `${formatFixed0(x * 100)}%`;
}

/** `format(v, '.0f')` —— Python 用的是 round-half-even，`0.5` 给 `0` 而不是 `1`。 */
function formatFixed0(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  const floor = Math.floor(x);
  const frac = x - floor;
  let n: number;
  if (frac > 0.5) n = floor + 1;
  else if (frac < 0.5) n = floor;
  else n = floor % 2 === 0 ? floor : floor + 1; // 半数入偶
  return Object.is(n, -0) ? "-0" : String(n);
}

/** `str(dict)` —— `{'a': 1, 'b': 2}`，键按插入序，字符串用单引号。 */
function pyDict(d: Record<string, number>): string {
  const items = Object.entries(d).map(([k, v]) => `'${k}': ${v}`);
  return `{${items.join(", ")}}`;
}

/** `str(list[str])` —— `['a', 'b']`。 */
function pyList(xs: readonly string[]): string {
  return `[${xs.map((x) => `'${x}'`).join(", ")}]`;
}

function dirname_(pth: string): string {
  const i = Math.max(pth.lastIndexOf("/"), pth.lastIndexOf("\\"));
  return i < 0 ? "." : pth.slice(0, i) || "/";
}

/** `Path(x).with_suffix(".audit.json")`：换掉**最后一个**后缀，没有后缀就追加。 */
function withSuffix(pth: string, suffix: string): string {
  const dir = dirname_(pth);
  const base = basename(pth);
  const dot = base.lastIndexOf(".");
  const stem = dot <= 0 ? base : base.slice(0, dot);
  return (dir === "." && !pth.includes("/") && !pth.includes("\\") ? "" : dir + "/") + stem + suffix;
}

function existsFile(pth: string): boolean {
  try {
    return statSync(pth).isFile();
  } catch {
    return false;
  }
}

async function writeJson(pth: string, value: unknown): Promise<void> {
  // Python 是 `json.dumps(..., ensure_ascii=False, indent=1)` —— 缩进 1 个空格，
  // 非 ASCII 原样。`JSON.stringify(v, null, 1)` 逐字相同，**只差浮点数**：
  // Python 的 float 一定带小数点（`0.0`），JS 的 `JSON.stringify(0)` 给 `0`。
  //
  // `.audit.json` 是要落盘、被 diff、被别的脚本读的产物，所以这一处按 Python 的
  // 字节来。**点名修 `completeness`**（`auditSummary` 里唯一的 float，其余是
  // int / str / list / bool），而不是给整棵树发明一条"猜哪个是浮点"的规则 ——
  // 那种规则必然在某个恰好是整数的金额上猜错。
  const text = JSON.stringify(value, null, 1).replace(
    /^( "completeness": )(-?\d+)(,?)$/m,
    "$1$2.0$3",
  );
  await writeFile(pth, text, "utf8");
}

/** `_expand`：目录递归、存在的路径直接收、否则当 glob 试一次。
 *
 * `~$` 开头的是 Excel 打开文件时留下的锁文件，**必须过滤** —— 它是个残缺的
 * xlsx，解析器会在上面炸，而用户根本不知道它存在。 */
export function expandFiles(patterns: readonly string[]): string[] {
  const out: string[] = [];
  for (const pat of patterns) {
    let st: ReturnType<typeof statSync> | null = null;
    try {
      st = statSync(pat);
    } catch {
      st = null;
    }
    if (st !== null && st.isDirectory()) {
      out.push(...walk(pat).sort());
    } else if (st !== null) {
      out.push(pat);
    } else {
      out.push(...globCwd(pat).sort());
    }
  }
  return out.filter((f) => existsFile(f) && !basename(f).startsWith("~$"));
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** `Path().glob(pat)` 的最小对等物：只支持 `*` / `?` / `**`，与本 CLI 的用法一致
 * （shell 通常已经展开过了，这条路径只在 shell 没展开时才走到）。 */
function globCwd(pat: string): string[] {
  const parts = pat.split("/").filter((x) => x !== "");
  if (parts.length === 0) return [];
  const walkGlob = (dir: string, i: number): string[] => {
    const seg = parts[i];
    if (seg === undefined) return [dir];
    let entries: string[];
    try {
      entries = readdirSync(dir === "" ? "." : dir);
    } catch {
      return [];
    }
    const re = globToRegExp(seg);
    const hits = entries.filter((e) => re.test(e));
    const out: string[] = [];
    for (const h of hits) out.push(...walkGlob(dir === "" ? h : `${dir}/${h}`, i + 1));
    return out;
  };
  return walkGlob("", 0);
}

function globToRegExp(seg: string): RegExp {
  let re = "^";
  for (const ch of seg) {
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(re + "$");
}

/** 从 `oir.json` 读回。**只恢复审核需要的字段** —— 与 Python 逐字相同的取舍。 */
export function loadOir(pth: string): OIR {
  const d = JSON.parse(readFileSync(pth, "utf8")) as Record<string, unknown>;
  const oir = new OIR();

  const asrt = <T>(x: unknown): Assertion<T> => {
    const o = x as { value: T; origin: unknown; confidence?: number };
    return {
      value: o.value,
      origin: parseOrigin(o.origin),
      evidence: [],
      confidence: o.confidence ?? 0.5,
    };
  };

  for (const raw of (d["objects"] as unknown[]) ?? []) {
    const o = raw as Record<string, unknown>;
    oir.addObject(
      makeObjectType({
        rid: String(o["rid"]),
        apiName: asrt<string>(o["apiName"]),
        displayName: asrt<string>(o["displayName"]),
        description: asrt<string>(o["description"]),
        primaryKey: asrt<string[]>(o["primaryKey"]),
        properties: [...((o["properties"] as string[]) ?? [])],
        aliases: [...((o["aliases"] as string[]) ?? [])],
        owner: (o["owner"] as string | null) ?? null,
      }),
    );
  }
  for (const raw of (d["properties"] as unknown[]) ?? []) {
    const pr = raw as Record<string, unknown>;
    // `baseType` 这里**不校验**，与 Python 一致：那边 `asrt()` 也是原样收下字符串，
    // 不过 `BaseType(...)`。这份 JSON 是我们自己 `oir.to_dict()` 写出去的，
    // 在这里加一道更严的门只会让一个手改过的文件从"能审"变成"直接崩"。
    oir.properties.set(
      String(pr["rid"]),
      makePropertyType({
        rid: String(pr["rid"]),
        parent: String(pr["parent"]),
        apiName: asrt<string>(pr["apiName"]),
        displayName: asrt<string>(pr["displayName"]),
        baseType: asrt<BaseType>(pr["baseType"]),
        definition: asrt<string>(pr["definition"]),
        owner: (pr["owner"] as string | null) ?? null,
      }),
    );
  }
  return oir;
}

// ══════════════════════════════════════════════════════════════════
//  账号
// ══════════════════════════════════════════════════════════════════

/** `build_repo(store)` —— **唯一的选路点**。Python 侧住在 `store/repo/__init__`，
 * TS 侧那个汇总模块还没建，所以先落在这里（一行，落地后换成 import）。 */
function buildRepo(store: Store): Repo {
  return store.enabled ? new PgRepo(store.engine!) : new MemoryRepo();
}

/** 打开库并返回 `[store, repo]`。四个账号命令共用同一段引导逻辑。 */
async function openRepo(): Promise<[Store, Repo]> {
  const url = databaseUrl();
  if (url) {
    const store = await Store.open(url);
    return [store, buildRepo(store)];
  }
  const root = process.env["ONTOCOPILOT_WORKSPACE"] || "workspace";
  mkdirSync(root, { recursive: true });
  const store = await Store.open(`sqlite+aiosqlite:///${join(resolve(root), "ontocopilot.db")}`, {
    createAll: true,
  });
  return [store, buildRepo(store)];
}

/** 建一个登录账号。**首个管理员只能用它创建** —— 没有公开的 bootstrap 路由，
 * 杜绝"谁先访问谁当管理员"的抢注竞态。助手绝不代设密码。 */
export async function cmdUseradd(args: CmdArgs): Promise<number> {
  const username = normalizeUsername(String(args["username"]));
  if (!username) {
    p(`${BAD} 用户名不能为空`);
    return 1;
  }

  // 密码来源：--password-stdin（脚本/CI）读一行；否则交互式两次确认。
  let pw: string;
  if (args["password_stdin"] === true) {
    pw = await readLineFromStdin();
  } else {
    pw = await getpass("设置密码: ");
    if (pw !== (await getpass("再输一次: "))) {
      p(`${BAD} 两次输入不一致`);
      return 1;
    }
  }
  if (!pw) {
    p(`${BAD} 密码不能为空`);
    return 1;
  }

  const [store, repo] = await openRepo();
  const role = args["admin"] === true ? "admin" : "user";
  try {
    const first = (await repo.countUsers()) === 0;
    const user = makeUserRow({
      id: hex32(),
      username,
      password_hash: hashPassword(pw),
      role,
    });
    await repo.createUser(user);
    p(`${OK} 已创建${role}账号：${username}`);
    // 建第一个账号会把实例翻进强制鉴权，而之前所有会话归属都是 __local__ ——
    // 不认领的话，下一次登录进来会话列表是空的，而磁盘上东西都还在。
    if (first && role === "admin") {
      const n = await adoptLocalSessions(repo, user);
      if (n) p(`${OK} 已把 ${n} 个原有会话归到 ${username} 名下`);
    }
    return 0;
  } catch (e) {
    if (e instanceof DuplicateUsername) {
      p(`${BAD} 用户名已存在：${username}`);
      return 1;
    }
    throw e;
  } finally {
    await store.close();
  }
}

/** 重设某个账号的密码。**在宿主机上跑，密码由人自己敲。**
 *
 * 这条命令原本不存在，于是"忘了首个管理员的密码"是一个**没有出口的死结**：
 * 改密码的接口要先登录，管理员重置别人密码的接口也要先登录，而登录正是进不去
 * 的那一步。补上它 —— 助手绝不代设密码，和 `useradd` 同一条规矩。 */
export async function cmdPasswd(args: CmdArgs): Promise<number> {
  const username = normalizeUsername(String(args["username"]));
  const [store, repo] = await openRepo();
  try {
    const user = await repo.getUserByUsername(username);
    if (user === null) {
      p(`${BAD} 没有这个账号：${username}`);
      return 1;
    }
    let pw: string;
    if (args["password_stdin"] === true) {
      pw = await readLineFromStdin();
    } else {
      pw = await getpass(`给 ${username} 设置新密码: `);
      if (pw !== (await getpass("再输一次: "))) {
        p(`${BAD} 两次输入不一致`);
        return 1;
      }
    }
    if ([...pw].length < 6) {
      p(`${BAD} 密码至少 6 位`);
      return 1;
    }
    await repo.updateUser(user.id, { passwordHash: hashPassword(pw) });
    // 改完踢掉这个账号所有已登录的会话 —— 和 /api/me/password 一致：
    // 密码换了而旧 cookie 还能用，等于没换。
    const n = await repo.deleteUserAuthSessions(user.id);
    p(`${OK} 已重设 ${username} 的密码` + (n ? `（顺带登出了 ${n} 个已登录会话）` : ""));
    return 0;
  } finally {
    await store.close();
  }
}

/** 改某个账号的角色。管理员才看得到网关设置与账户管理。 */
export async function cmdRole(args: CmdArgs): Promise<number> {
  const role = args["admin"] === true ? "admin" : "user";
  const username = normalizeUsername(String(args["username"]));
  const [store, repo] = await openRepo();
  try {
    const user = await repo.getUserByUsername(username);
    if (user === null) {
      p(`${BAD} 没有这个账号：${username}`);
      return 1;
    }
    if (user.role === role) {
      p(`${OK} ${username} 已经是${role}，无需改动`);
      return 0;
    }
    if (role === "user") {
      // 把最后一个管理员降级 = 把自己锁在门外，且没有任何界面能救回来
      const admins = (await repo.listUsers()).filter((u) => u.role === "admin" && u.active);
      if (admins.length <= 1 && user.role === "admin") {
        p(`${BAD} ${username} 是唯一的管理员，降级后没人能管理这个实例了`);
        return 1;
      }
    }
    await repo.updateUser(user.id, { role });
    p(`${OK} ${username} 现在是${role === "admin" ? "管理员" : "普通用户"}`);
    return 0;
  } finally {
    await store.close();
  }
}

/** 列出账号。忘了自己建过谁、谁是管理员时用它。 */
export async function cmdUserlist(_args: CmdArgs): Promise<number> {
  const [store, repo] = await openRepo();
  try {
    const users = await repo.listUsers();
    if (users.length === 0) {
      p("还没有账号（实例处于开放模式）");
      return 0;
    }
    for (const u of users) {
      const tag = u.role === "admin" ? "管理员" : "普通用户";
      p(`  ${ljust(u.username, 16)} ${tag}${u.active ? "" : "（已停用）"}`);
    }
    return 0;
  } finally {
    await store.close();
  }
}

/** `uuid.uuid4().hex` 的对等物：32 个十六进制字符，没有连字符。 */
function hex32(): string {
  return randomUUID().replaceAll("-", "");
}

// ══════════════════════════════════════════════════════════════════
//  口令输入
// ══════════════════════════════════════════════════════════════════

/** `sys.stdin.readline().rstrip("\n")`。 */
export async function readLineFromStdin(): Promise<string> {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin });
    let done = false;
    rl.once("line", (line: string) => {
      done = true;
      rl.close();
      res(line.replace(/\n$/, ""));
    });
    rl.once("close", () => {
      if (!done) res("");
    });
  });
}

/** `getpass.getpass(prompt)`。
 *
 * 没有 TTY（管道 / CI）时 Python 会打一条 `GetPassWarning` 再退回按行读；
 * 这里同形 —— 直接失败的话 `useradd --password-stdin` 之外的所有脚本路径都断了。
 * 提示语写 **stderr**（Python 的 getpass 优先写 /dev/tty，退回时写 stderr），
 * 这样 `ontocopilot users > f` 之类的重定向不会把提示语混进产物。 */
export async function getpass(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    process.stderr.write("Warning: Password input may be echoed.\n");
    process.stderr.write(prompt);
    return readLineFromStdin();
  }
  process.stderr.write(prompt);
  return new Promise<string>((res, rej) => {
    let buf = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stderr.write("\n");
          res(buf);
          return;
        }
        if (ch === "\x03") {
          // Ctrl-C：与 Python 的 KeyboardInterrupt 同一条路径。
          cleanup();
          process.stderr.write("\n");
          rej(new KeyboardInterrupt());
          return;
        }
        if (ch === "\x7f" || ch === "\b") buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on("data", onData);
  });
}

// ══════════════════════════════════════════════════════════════════
//  入口
// ══════════════════════════════════════════════════════════════════

export function buildParser(): Parser {
  return new Parser([
    {
      name: "doctor",
      help: "检查配置、模型连通性、沙箱隔离等级",
      positionals: [],
      options: [
        { flags: ["--production"], dest: "production", kind: "flag", dflt: false, help: "按生产配置检查沙箱" },
      ],
      run: cmdDoctor,
    },
    {
      name: "parse",
      help: "只解析材料，看看读到了什么",
      positionals: [{ dest: "files", many: true }],
      options: [
        { flags: ["--dialect"], dest: "dialect", kind: "str", dflt: null, help: "SQL 方言，默认自动" },
        { flags: ["--json"], dest: "json", kind: "str", dflt: null, help: "把解析概览写到这个文件" },
      ],
      run: cmdParse,
    },
    {
      name: "build",
      help: "全流程：解析→抽取→对齐→冲突→澄清→模板",
      positionals: [{ dest: "files", many: true }],
      options: [
        { flags: ["-o", "--out"], dest: "out", kind: "str", dflt: "out", help: "产物目录" },
        { flags: ["--project"], dest: "project", kind: "str", dflt: "", help: "项目代号（会写进模板首页）" },
        { flags: ["--round"], dest: "round", kind: "int", dflt: 1, help: "第几轮" },
        { flags: ["--run-id"], dest: "run_id", kind: "str", dflt: "run_build", help: "Run 标识，用于事件日志" },
        { flags: ["--dialect"], dest: "dialect", kind: "str", dflt: null },
        { flags: ["--max-questions"], dest: "max_questions", kind: "int", dflt: 3 },
        {
          flags: ["--evidence-top-k"],
          dest: "evidence_top_k",
          kind: "int",
          dflt: 60,
          help: "每份材料最多送多少切片给抽取",
        },
        { flags: ["--extract-tokens"], dest: "extract_tokens", kind: "int", dflt: 12000 },
        { flags: ["--max-tokens"], dest: "max_tokens", kind: "int", dflt: 2_000_000 },
        { flags: ["--max-usd"], dest: "max_usd", kind: "float", dflt: 5.0 },
      ],
      run: cmdBuild,
    },
    {
      name: "audit",
      help: "审业务方回传的模板",
      positionals: [
        { dest: "spec", help: "build 产出的 template.spec.json" },
        { dest: "returned", help: "业务方回传的 xlsx" },
      ],
      options: [{ flags: ["--target"], dest: "target", kind: "float", dflt: 0.95, help: "达标线" }],
      run: cmdAudit,
    },
    {
      name: "useradd",
      help: "创建登录账号（首个管理员只能用它创建）",
      positionals: [{ dest: "username" }],
      options: [
        { flags: ["--admin"], dest: "admin", kind: "flag", dflt: false, help: "创建为管理员" },
        {
          flags: ["--password-stdin"],
          dest: "password_stdin",
          kind: "flag",
          dflt: false,
          help: "从标准输入读一行作为密码（脚本/CI 用），否则交互式输入",
        },
      ],
      run: cmdUseradd,
    },
    {
      name: "passwd",
      help: "重设某个账号的密码（忘了管理员密码时用它）",
      positionals: [{ dest: "username" }],
      options: [
        {
          flags: ["--password-stdin"],
          dest: "password_stdin",
          kind: "flag",
          dflt: false,
          help: "从标准输入读一行作为密码（脚本/CI 用），否则交互式输入",
        },
      ],
      run: cmdPasswd,
    },
    {
      name: "role",
      help: "改账号角色（管理员才有网关设置与账户管理）",
      positionals: [{ dest: "username" }],
      options: [
        { flags: ["--admin"], dest: "admin", kind: "flag", dflt: false, help: "提为管理员", mutex: "role" },
        { flags: ["--user"], dest: "user", kind: "flag", dflt: false, help: "降为普通用户", mutex: "role" },
      ],
      mutex: { name: "role", flags: ["--admin", "--user"] },
      run: cmdRole,
    },
    {
      name: "users",
      help: "列出账号和角色",
      positionals: [],
      options: [],
      run: cmdUserlist,
    },
  ]);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let parsed: { args: CmdArgs; spec: CmdSpec };
  try {
    parsed = buildParser().parse(argv);
  } catch (e) {
    // argparse 的 SystemExit 在 Python 侧同样绕过 main 的 try（它是 BaseException）。
    if (e instanceof CliExit) return e.code;
    throw e;
  }
  try {
    return await parsed.spec.run(parsed.args);
  } catch (e) {
    if (e instanceof CliExit) return e.code;
    if (e instanceof KeyboardInterrupt) {
      p("\n已中断");
      return 130;
    }
    const name = e instanceof Error ? e.name : typeof e;
    const msg = e instanceof Error ? e.message : String(e);
    p(`\n${BAD} ${name}: ${msg}`);
    // Python 是 `if "--debug" in sys.argv: raise` —— 查的是**进程**的 argv，
    // 不是传进来的那份。照搬。
    if (process.argv.includes("--debug")) throw e;
    return 1;
  }
}
