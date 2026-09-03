/**
 * 声明式数据整理（R2）—— 动词管道，不是代码执行。
 *
 * converse 作用域**故意没有** code.exec（agents.ts:861：不给读客户材料的 agent
 * 任意代码权限 —— 间接注入的防线）。数据整理的需求真实存在，但答案不是开洞，
 * 是把动作收敛成**有限动词集**：模型只能选动词和列名，翻译成确定性代码的是
 * 我们，不是它。要新能力就加动词，每个动词带测试。
 *
 * 三条纪律：
 *   1. **逐步行数账**：进 N 行、出 M 行、坏 K 行及样例 —— 静默丢行是数据整理
 *      最不能出的错（业务方问"我那 300 条呢"的时候必须答得上来）。
 *   2. **事务性**：全程在副本上跑，任一步不合法整批不落，报错点名是哪一步、
 *      哪一列、现有列有哪些（与 apply_patch/add_batch 同一口径）。
 *   3. **coerce 不丢行**：类型规不上的行保留原值、进坏行账 —— 删数据要用
 *      显式的 filter，不许借类型转换之手。
 */

export interface StepAccount {
  readonly step: number;
  readonly op: string;
  readonly in: number;
  readonly out: number;
  /** 本步丢弃/规整失败的行数（dedupe/filter 是丢弃，coerce 是失败但保留）。 */
  readonly affected: number;
  readonly note: string;
}

export interface TransformResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly accounts: readonly StepAccount[];
}

export interface TransformTable {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

type Dict = Record<string, unknown>;

export class TransformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransformError";
    Object.setPrototypeOf(this, TransformError.prototype);
  }
}

const OPS = [
  "select", "rename", "coerce", "dedupe", "filter", "join",
  // T1 补的五个：多表并 / 横转长 / 拆列 / 汇总 / 两级表头并入列名。
  // 四类高频需求以前直接失败：12 个月 12 个 sheet 并不成一张表、
  // 行=部门列=月份的矩阵表进不了建模、「省/市/区」拆不开、两级表头读成数据行。
  "union", "unpivot", "split", "aggregate", "merge_header",
] as const;
export const TRANSFORM_OPS: readonly string[] = OPS;

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

function need(step: Dict, key: string, at: number): string {
  const v = str(step[key]).trim();
  if (!v) throw new TransformError(`steps[${at}]（${str(step["op"])}）缺 ${key}。`);
  return v;
}

function colIndex(columns: readonly string[], name: string, at: number, op: string): number {
  const i = columns.indexOf(name);
  if (i < 0) {
    throw new TransformError(
      `steps[${at}]（${op}）：没有列「${name}」。现有列：${columns.join("、")}`,
    );
  }
  return i;
}

/** 金额/数值常见写法的确定性归一：￥1,234.50 → 1234.50。规不上返回 null。 */
export function coerceValue(raw: string, type: string): string | null {
  const v = raw.trim();
  if (v === "") return ""; // 空值不算失败 —— 空是缺数据，不是坏数据
  if (type === "STRING") return v;
  if (type === "DECIMAL" || type === "INTEGER") {
    const cleaned = v.replace(/[￥¥$,，\s]/gu, "").replace(/%$/u, "");
    if (!/^-?\d+(?:\.\d+)?$/u.test(cleaned)) return null;
    if (type === "INTEGER") {
      return /^-?\d+$/u.test(cleaned) ? cleaned : null; // 3.5 不是整数，不悄悄截断
    }
    return cleaned;
  }
  if (type === "DATE") {
    const m = v.replace(/[.年月/]/gu, "-").replace(/日/gu, "").match(/^(\d{4})-(\d{1,2})-(\d{1,2})/u);
    if (!m) return null;
    return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  }
  if (type === "BOOLEAN") {
    if (/^(?:是|真|y|yes|true|1)$/iu.test(v)) return "true";
    if (/^(?:否|假|n|no|false|0)$/iu.test(v)) return "false";
    return null;
  }
  throw new TransformError(`不认识的类型「${type}」。可用：STRING/DECIMAL/INTEGER/DATE/BOOLEAN`);
}

/**
 * 主入口。`lookup` 给 join 取第二张表 —— 由调用方（工具层）绑到 materialTable，
 * 本模块保持纯函数、可脱离服务单测。
 */
export function applyTransform(
  input: TransformTable,
  steps: readonly Dict[],
  lookup?: (file: string, sheet: string) => TransformTable,
): TransformResult {
  if (steps.length === 0) throw new TransformError("steps 是空的 —— 至少要一步。");
  let columns = [...input.columns];
  let rows = input.rows.map((r) => columns.map((_, i) => str(r[i])));
  const accounts: StepAccount[] = [];

  steps.forEach((step, at) => {
    const op = str(step["op"]);
    const before = rows.length;
    if (!TRANSFORM_OPS.includes(op)) {
      throw new TransformError(`steps[${at}]：不认识的动词「${op}」。可用：${TRANSFORM_OPS.join("/")}`);
    }

    if (op === "select") {
      const wanted = Array.isArray(step["columns"]) ? (step["columns"] as unknown[]).map(str) : [];
      if (wanted.length === 0) throw new TransformError(`steps[${at}]（select）缺 columns。`);
      const idx = wanted.map((c) => colIndex(columns, c, at, "select"));
      rows = rows.map((r) => idx.map((i) => r[i]!));
      columns = wanted;
      accounts.push({ step: at, op, in: before, out: rows.length, affected: 0,
        note: `保留 ${wanted.length} 列` });
      return;
    }

    if (op === "rename") {
      const map = (typeof step["map"] === "object" && step["map"] !== null ? step["map"] : null) as
        Record<string, unknown> | null;
      if (map === null || Object.keys(map).length === 0) {
        throw new TransformError(`steps[${at}]（rename）缺 map（{旧列名: 新列名}）。`);
      }
      for (const from of Object.keys(map)) colIndex(columns, from, at, "rename");
      columns = columns.map((c) => (c in map ? str(map[c]) : c));
      accounts.push({ step: at, op, in: before, out: before, affected: 0,
        note: Object.entries(map).map(([a, b]) => `${a}→${str(b)}`).join("、") });
      return;
    }

    if (op === "coerce") {
      const column = need(step, "column", at);
      const type = need(step, "type", at).toUpperCase();
      const i = colIndex(columns, column, at, "coerce");
      const badSamples: string[] = [];
      let bad = 0;
      rows = rows.map((r, rowNo) => {
        const coerced = coerceValue(r[i]!, type);
        if (coerced === null) {
          bad += 1;
          if (badSamples.length < 5) badSamples.push(`第 ${rowNo + 2} 行「${r[i]}」`);
          return r; // 保留原值 —— 删数据要用显式 filter
        }
        const next = [...r];
        next[i] = coerced;
        return next;
      });
      accounts.push({ step: at, op, in: before, out: before, affected: bad,
        note: bad === 0
          ? `「${column}」全部规整为 ${type}`
          : `「${column}」有 ${bad} 行规不上 ${type}（保留原值）：${badSamples.join("；")}` });
      return;
    }

    if (op === "dedupe") {
      const by = Array.isArray(step["by"]) ? (step["by"] as unknown[]).map(str) : [];
      if (by.length === 0) throw new TransformError(`steps[${at}]（dedupe）缺 by（按哪些列判重）。`);
      const idx = by.map((c) => colIndex(columns, c, at, "dedupe"));
      const seen = new Set<string>();
      rows = rows.filter((r) => {
        const key = idx.map((i) => r[i]).join("\u0000");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      accounts.push({ step: at, op, in: before, out: rows.length, affected: before - rows.length,
        note: `按 ${by.join("+")} 去重，丢 ${before - rows.length} 行` });
      return;
    }

    if (op === "filter") {
      const column = need(step, "column", at);
      const i = colIndex(columns, column, at, "filter");
      const notEmpty = step["not_empty"] === true;
      const equals = step["equals"] === undefined ? null : str(step["equals"]);
      const contains = step["contains"] === undefined ? null : str(step["contains"]);
      if (!notEmpty && equals === null && contains === null) {
        throw new TransformError(`steps[${at}]（filter）要给 not_empty / equals / contains 之一。`);
      }
      rows = rows.filter((r) => {
        const v = r[i]!;
        if (notEmpty && v.trim() === "") return false;
        if (equals !== null && v !== equals) return false;
        if (contains !== null && !v.includes(contains)) return false;
        return true;
      });
      accounts.push({ step: at, op, in: before, out: rows.length, affected: before - rows.length,
        note: `按「${column}」过滤，丢 ${before - rows.length} 行` });
      return;
    }

    if (op === "union") {
      // 多表并。列按**本表**的列名对齐：对方缺的列补空、多的列丢弃并记账 ——
      // 静默按位置对齐是并表最危险的错（1 月表和 2 月表列序不同就串列）。
      const withFile = need(step, "with", at);
      if (lookup === undefined) {
        throw new TransformError(`steps[${at}]（union）：这个调用方没有提供第二张表的读取通道。`);
      }
      const other = lookup(withFile, str(step["sheet"] ?? ""));
      const extra = other.columns.filter((c) => !columns.includes(c));
      const idxMap = columns.map((c) => other.columns.indexOf(c));
      const appended = other.rows.map((r) => idxMap.map((i) => (i < 0 ? "" : str(r[i]))));
      rows = [...rows, ...appended];
      accounts.push({ step: at, op, in: before, out: rows.length, affected: appended.length,
        note: `并入「${withFile}」${appended.length} 行`
          + (extra.length > 0 ? `；对方多出的列被丢弃：${extra.join("、")}` : "")
          + (idxMap.some((i) => i < 0) ? `；对方缺的列补空：${columns.filter((_, i) => idxMap[i]! < 0).join("、")}` : "") });
      return;
    }

    if (op === "unpivot") {
      // 横转长：保留 keep 列，其余列名变成一列、值变成一列。
      const keep = Array.isArray(step["keep"]) ? (step["keep"] as unknown[]).map(str) : [];
      if (keep.length === 0) throw new TransformError(`steps[${at}]（unpivot）缺 keep（保留哪些列不转）。`);
      const keepIdx = keep.map((c) => colIndex(columns, c, at, "unpivot"));
      const nameCol = str(step["name_to"] ?? "") || "名目";
      const valueCol = str(step["value_to"] ?? "") || "值";
      const meltIdx = columns.map((_, i) => i).filter((i) => !keepIdx.includes(i));
      if (meltIdx.length === 0) throw new TransformError(`steps[${at}]（unpivot）：keep 把所有列都留下了，没有可转的列。`);
      const out: string[][] = [];
      for (const r of rows) {
        for (const mi of meltIdx) {
          out.push([...keepIdx.map((i) => r[i]!), columns[mi]!, r[mi]!]);
        }
      }
      rows = out;
      columns = [...keep, nameCol, valueCol];
      accounts.push({ step: at, op, in: before, out: rows.length, affected: 0,
        note: `${meltIdx.length} 列转成长表（${nameCol}/${valueCol}），${before} 行 → ${rows.length} 行` });
      return;
    }

    if (op === "split") {
      // 拆复合列：「省/市/区」「张三(工号1001)」。按分隔符或正则捕获组。
      const column = need(step, "column", at);
      const i = colIndex(columns, column, at, "split");
      const into = Array.isArray(step["into"]) ? (step["into"] as unknown[]).map(str) : [];
      if (into.length < 2) throw new TransformError(`steps[${at}]（split）的 into 至少要两个新列名。`);
      const sep = str(step["separator"] ?? "");
      if (!sep) throw new TransformError(`steps[${at}]（split）缺 separator。`);
      let bad = 0;
      const badSamples: string[] = [];
      rows = rows.map((r, rowNo) => {
        const parts = r[i]!.split(sep);
        if (r[i]!.trim() !== "" && parts.length !== into.length) {
          bad += 1;
          if (badSamples.length < 5) badSamples.push(`第 ${rowNo + 2} 行「${r[i]}」`);
        }
        const filled = into.map((_, k) => str(parts[k] ?? ""));
        const next = [...r];
        next.splice(i, 1, ...filled);
        return next;
      });
      const nextCols = [...columns];
      nextCols.splice(i, 1, ...into);
      columns = nextCols;
      accounts.push({ step: at, op, in: before, out: rows.length, affected: bad,
        note: bad === 0
          ? `「${column}」按「${sep}」拆成 ${into.join("、")}`
          : `「${column}」有 ${bad} 行段数对不上（保留能拆出的部分）：${badSamples.join("；")}` });
      return;
    }

    if (op === "aggregate") {
      // 按键汇总。fn 只有 sum/count/first —— 平均值让下游算（sum+count 都有了）。
      const by = Array.isArray(step["by"]) ? (step["by"] as unknown[]).map(str) : [];
      if (by.length === 0) throw new TransformError(`steps[${at}]（aggregate）缺 by（按哪些列分组）。`);
      const byIdx = by.map((c) => colIndex(columns, c, at, "aggregate"));
      const fn = str(step["fn"] ?? "sum").toLowerCase();
      if (!["sum", "count", "first"].includes(fn)) {
        throw new TransformError(`steps[${at}]（aggregate）的 fn 只能是 sum/count/first。`);
      }
      const target = fn === "count" ? "" : need(step, "column", at);
      const ti = fn === "count" ? -1 : colIndex(columns, target, at, "aggregate");
      const groups = new Map<string, { key: string[]; vals: string[] }>();
      for (const r of rows) {
        const k = byIdx.map((i) => r[i]!).join("\u0000");
        if (!groups.has(k)) groups.set(k, { key: byIdx.map((i) => r[i]!), vals: [] });
        if (ti >= 0) groups.get(k)!.vals.push(r[ti]!);
      }
      let bad = 0;
      const outRows: string[][] = [];
      for (const g of groups.values()) {
        let v: string;
        if (fn === "count") v = String(g.vals.length || rows.filter((r) => byIdx.map((i) => r[i]!).join("\u0000") === g.key.join("\u0000")).length);
        else if (fn === "first") v = g.vals[0] ?? "";
        else {
          let sum = 0;
          for (const raw of g.vals) {
            const c = coerceValue(raw, "DECIMAL");
            if (c === null) { bad += 1; continue; }  // 规不上的不进和，进坏行账
            if (c !== "") sum += Number(c);
          }
          v = String(sum);
        }
        outRows.push([...g.key, v]);
      }
      rows = outRows;
      columns = [...by, fn === "count" ? "计数" : `${target}_${fn}`];
      accounts.push({ step: at, op, in: before, out: rows.length, affected: bad,
        note: `按 ${by.join("+")} ${fn === "count" ? "计数" : fn === "first" ? "取首值" : "求和"}`
          + `，${before} 行 → ${rows.length} 组` + (bad > 0 ? `；${bad} 个值规不上数字，未计入` : "") });
      return;
    }

    if (op === "merge_header") {
      // 两级表头：解析层只认单行表头时，第二行表头会变成第一行数据。
      // 把当前第一行**数据**并进列名（新列名 = 旧列名·首行值），然后删掉那一行。
      const joiner = str(step["join"] ?? "") || "·";
      const first = rows[0];
      if (first === undefined) throw new TransformError(`steps[${at}]（merge_header）：表是空的，没有可并的表头行。`);
      columns = columns.map((c, i) => {
        const cell = str(first[i] ?? "").trim();
        return cell === "" ? c : `${c}${joiner}${cell}`;
      });
      rows = rows.slice(1);
      accounts.push({ step: at, op, in: before, out: rows.length, affected: 1,
        note: `表头并入 1 行（连接符「${joiner}」）` });
      return;
    }

    // join
    const withFile = need(step, "with", at);
    const on = (typeof step["on"] === "object" && step["on"] !== null ? step["on"] : null) as
      Record<string, unknown> | null;
    if (on === null || Object.keys(on).length !== 1) {
      throw new TransformError(`steps[${at}]（join）的 on 要恰好一对 {本表列: 对方列}。`);
    }
    if (lookup === undefined) {
      throw new TransformError(`steps[${at}]（join）：这个调用方没有提供第二张表的读取通道。`);
    }
    const [leftCol, rightColRaw] = Object.entries(on)[0]!;
    const rightCol = str(rightColRaw);
    const other = lookup(withFile, str(step["sheet"] ?? ""));
    const li = colIndex(columns, leftCol, at, "join");
    const ri = other.columns.indexOf(rightCol);
    if (ri < 0) {
      throw new TransformError(
        `steps[${at}]（join）：「${withFile}」里没有列「${rightCol}」。对方现有列：${other.columns.join("、")}`,
      );
    }
    const rightRest = other.columns.map((c, idx2) => [c, idx2] as const).filter(([, idx2]) => idx2 !== ri);
    const index = new Map<string, readonly string[]>();
    for (const r of other.rows) {
      const key = str(r[ri]);
      if (!index.has(key)) index.set(key, r.map(str)); // 多条命中取第一条 —— join 账里说明
    }
    let matched = 0;
    rows = rows.map((r) => {
      const hit = index.get(r[li]!);
      if (hit !== undefined) matched += 1;
      return [...r, ...rightRest.map(([, idx2]) => (hit === undefined ? "" : str(hit[idx2])))];
    });
    // 撞名列加前缀，不静默覆盖
    columns = [...columns, ...rightRest.map(([c]) => (columns.includes(c) ? `${withFile}.${c}` : c))];
    accounts.push({ step: at, op, in: before, out: rows.length, affected: before - matched,
      note: `左连「${withFile}」，命中 ${matched}/${before} 行（未命中留空；对方重复键取首条）` });
  });

  return { columns, rows, accounts };
}
