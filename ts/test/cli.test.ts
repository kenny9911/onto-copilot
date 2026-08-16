/**
 * `cli.ts` —— 与 `cli.py` 的对齐。
 *
 * **这套断言的期望值不是我推出来的，是 Python CLI 真跑出来的。** 账号那五条
 * 命令在同一个临时 workspace 上，用同一串参数在两侧各跑一遍，逐字节对过；
 * argparse 那几条错误消息同样是从 Python 3.12 的 argparse 上抄回来的原文。
 *
 * 为什么这个文件值得写细：命令名、参数名、退出码、stdout/stderr 的分工是
 * **有人写脚本在调**的接口。改一个字不会有任何测试变红，但别人的 CI 会在下一次
 * 部署时静默走错分支 —— 尤其是 `audit` 的三态退出码（0/2/1）。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CliExit,
  KeyboardInterrupt,
  buildParser,
  expandFiles,
  loadOir,
  main,
} from "../src/cli.js";
import { OIR, extracted, inferred, makeObjectType, makePropertyType } from "../src/onto/oir.js";
import { BaseType } from "../src/onto/oir.js";
import { compileTemplate, writeXlsx } from "../src/onto/template.js";

// ══════════════════════════════════════════════════════════════════
//  抓 stdout / stderr
// ══════════════════════════════════════════════════════════════════

interface Captured {
  code: number;
  out: string;
  err: string;
}

async function run(argv: string[]): Promise<Captured> {
  let out = "";
  let err = "";
  const so = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
    out += String(c);
    return true;
  });
  const se = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
    err += String(c);
    return true;
  });
  try {
    const code = await main(argv);
    return { code, out, err };
  } finally {
    so.mockRestore();
    se.mockRestore();
  }
}

let workspace = "";

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "oc-cli-"));
  process.env["ONTOCOPILOT_WORKSPACE"] = workspace;
  delete process.env["DATABASE_URL"];
});

afterEach(() => {
  delete process.env["ONTOCOPILOT_WORKSPACE"];
  rmSync(workspace, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════
//  参数解析
// ══════════════════════════════════════════════════════════════════

describe("argparse 对等物", () => {
  it("八条命令、一条不多一条不少", () => {
    expect(buildParser().commands.map((c) => c.name)).toEqual([
      "doctor",
      "parse",
      "build",
      "audit",
      "useradd",
      "passwd",
      "role",
      "users",
    ]);
  });

  it("默认值与 cli.py 的 add_argument 逐个对上", () => {
    const parser = buildParser();
    const b = parser.parse(["build", "材料"]).args;
    expect(b["files"]).toEqual(["材料"]);
    expect(b["out"]).toBe("out");
    expect(b["project"]).toBe("");
    expect(b["round"]).toBe(1);
    expect(b["run_id"]).toBe("run_build");
    expect(b["dialect"]).toBe(null);
    expect(b["max_questions"]).toBe(3);
    expect(b["evidence_top_k"]).toBe(60);
    expect(b["extract_tokens"]).toBe(12000);
    expect(b["max_tokens"]).toBe(2_000_000);
    expect(b["max_usd"]).toBe(5.0);

    const a = parser.parse(["audit", "s.json", "r.xlsx"]).args;
    expect([a["spec"], a["returned"], a["target"]]).toEqual(["s.json", "r.xlsx", 0.95]);

    const pz = parser.parse(["parse", "x", "y"]).args;
    expect(pz["files"]).toEqual(["x", "y"]);
    expect(pz["json"]).toBe(null);

    expect(parser.parse(["doctor"]).args["production"]).toBe(false);
    expect(parser.parse(["doctor", "--production"]).args["production"]).toBe(true);
    expect(parser.parse(["useradd", "u"]).args["admin"]).toBe(false);
    expect(parser.parse(["useradd", "u", "--admin"]).args["admin"]).toBe(true);
    expect(parser.parse(["passwd", "u", "--password-stdin"]).args["password_stdin"]).toBe(true);
  });

  it("`--x=v` 与 `--x v` 等价，`-o` 是 `--out` 的短名", () => {
    const parser = buildParser();
    expect(parser.parse(["build", "f", "--out=zz"]).args["out"]).toBe("zz");
    expect(parser.parse(["build", "f", "--out", "zz"]).args["out"]).toBe("zz");
    expect(parser.parse(["build", "f", "-o", "zz"]).args["out"]).toBe("zz");
    // 选项可以出现在位置参数前面
    expect(parser.parse(["build", "--round", "3", "f", "g"]).args["files"]).toEqual(["f", "g"]);
  });

  it("`--` 之后一律当位置参数（文件名叫 --admin 的那天才不会崩）", () => {
    expect(buildParser().parse(["parse", "--", "--dialect"]).args["files"]).toEqual(["--dialect"]);
  });

  it("用法错误：stderr + 退出码 2，消息与 Python 的 argparse 逐字相同", async () => {
    const cases: [string[], string][] = [
      [[], "ontocopilot: error: the following arguments are required: cmd"],
      [
        ["badcmd"],
        "ontocopilot: error: argument cmd: invalid choice: 'badcmd' " +
          "(choose from doctor, parse, build, audit, useradd, passwd, role, users)",
      ],
      [["role", "root"], "ontocopilot role: error: one of the arguments --admin --user is required"],
      [["build", "--round", "x", "a"], "ontocopilot build: error: argument --round: invalid int value: 'x'"],
      [["audit", "s", "r", "--target", "z"], "ontocopilot audit: error: argument --target: invalid float value: 'z'"],
      [["useradd"], "ontocopilot useradd: error: the following arguments are required: username"],
      [["parse"], "ontocopilot parse: error: the following arguments are required: files"],
    ];
    for (const [argv, msg] of cases) {
      const r = await run(argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.err.trimEnd().split("\n").at(-1), argv.join(" ")).toBe(msg);
      // 用法错误一个字都不该进 stdout —— 脚本靠 stdout 拿结果。
      expect(r.out, argv.join(" ")).toBe("");
    }
  });

  it("`--round 2.5` 也是 invalid int（argparse 的 type=int 就是 Python 的 int()）", async () => {
    const r = await run(["build", "--round", "2.5", "a"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("invalid int value: '2.5'");
  });

  it("role 的两个开关互斥", async () => {
    const r = await run(["role", "u", "--admin", "--user"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("not allowed with argument --admin");
  });

  it("-h 走 stdout 且退 0（别让脚本把帮助当错误）", async () => {
    for (const argv of [["-h"], ["--help"], ["build", "-h"], ["users", "--help"]]) {
      const r = await run(argv);
      expect(r.code, argv.join(" ")).toBe(0);
      expect(r.out, argv.join(" ")).toContain("usage: ontocopilot");
      expect(r.err, argv.join(" ")).toBe("");
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  尚未迁移的三条
// ══════════════════════════════════════════════════════════════════

describe("doctor / parse / build", () => {
  it("如实报「尚未迁移」并退 1，且**不占用 stdout**", async () => {
    for (const argv of [["doctor"], ["parse", "x"], ["build", "x"]]) {
      const r = await run(argv);
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.out, argv.join(" ")).toBe("");
      expect(r.err, argv.join(" ")).toContain("尚未迁移到 TS");
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  账号命令 —— 期望值是 Python CLI 真跑出来的字节
// ══════════════════════════════════════════════════════════════════

/** `--password-stdin` 读的是**一行标准输入**。这里把 stdin 换成一个内存流。 */
function withStdin<T>(text: string, body: () => Promise<T>): Promise<T> {
  const fake = Readable.from([text]) as unknown as NodeJS.ReadStream;
  const real = Object.getOwnPropertyDescriptor(process, "stdin")!;
  Object.defineProperty(process, "stdin", { value: fake, configurable: true });
  return body().finally(() => {
    Object.defineProperty(process, "stdin", real);
  });
}

async function runWithPassword(argv: string[], pw: string): Promise<Captured> {
  return withStdin(pw + "\n", () => run(argv));
}

describe("账号命令", () => {
  it("整条流水线的 stdout 与退出码与 Python CLI 逐字节相同", async () => {
    // 下面每一对 [argv, 期望 stdout, 期望退出码] 都在 Python 侧跑过一次，
    // 输出原样抄回来。顺序有意义（后面的用例依赖前面建出来的账号）。
    expect(await run(["users"])).toMatchObject({
      code: 0,
      out: "还没有账号（实例处于开放模式）\n",
    });

    expect(await runWithPassword(["useradd", "root", "--admin", "--password-stdin"], "pw123456"))
      .toMatchObject({ code: 0, out: "✓ 已创建admin账号：root\n" });

    expect(await run(["users"])).toMatchObject({ code: 0, out: "  root             管理员\n" });

    expect(await runWithPassword(["useradd", "bob", "--password-stdin"], "pw123456")).toMatchObject({
      code: 0,
      out: "✓ 已创建user账号：bob\n",
    });

    expect(await run(["users"])).toMatchObject({
      code: 0,
      out: "  root             管理员\n  bob              普通用户\n",
    });

    expect(await run(["role", "bob", "--admin"])).toMatchObject({
      code: 0,
      out: "✓ bob 现在是管理员\n",
    });
    // 幂等的那一句用的是**英文角色名**（"已经是admin"），不是"已经是管理员"。
    expect(await run(["role", "bob", "--admin"])).toMatchObject({
      code: 0,
      out: "✓ bob 已经是admin，无需改动\n",
    });
    expect(await run(["role", "root", "--user"])).toMatchObject({
      code: 0,
      out: "✓ root 现在是普通用户\n",
    });
    expect(await run(["role", "nobody", "--admin"])).toMatchObject({
      code: 1,
      out: "✗ 没有这个账号：nobody\n",
    });

    expect(await runWithPassword(["passwd", "bob", "--password-stdin"], "short")).toMatchObject({
      code: 1,
      out: "✗ 密码至少 6 位\n",
    });
    expect(await runWithPassword(["passwd", "bob", "--password-stdin"], "newpw123")).toMatchObject({
      code: 0,
      out: "✓ 已重设 bob 的密码\n",
    });

    expect(await runWithPassword(["useradd", "root", "--password-stdin"], "x")).toMatchObject({
      code: 1,
      out: "✗ 用户名已存在：root\n",
    });
    expect(await runWithPassword(["useradd", "zzz", "--password-stdin"], "")).toMatchObject({
      code: 1,
      out: "✗ 密码不能为空\n",
    });
    expect(await runWithPassword(["useradd", "  ", "--password-stdin"], "pw123456")).toMatchObject({
      code: 1,
      out: "✗ 用户名不能为空\n",
    });
  }, 60_000);

  it("首个管理员会把 __local__ 的会话认领过来", async () => {
    // 先用开放模式建一个会话（== 界面上还没账号时干的活）。
    const { Store } = await import("../src/store/engine.js");
    const { PgRepo } = await import("../src/store/repo/pg.js");
    const { makeSessionRow } = await import("../src/store/types.js");
    const dbUrl = `sqlite+aiosqlite:///${join(workspace, "ontocopilot.db")}`;
    const seed = await Store.open(dbUrl, { createAll: true });
    await new PgRepo(seed.engine!).createSession(makeSessionRow({ id: "old1", owner: "__local__" }));
    await new PgRepo(seed.engine!).createSession(makeSessionRow({ id: "old2", owner: "" }));
    await seed.close();

    const r = await runWithPassword(["useradd", "root", "--admin", "--password-stdin"], "pw123456");
    expect(r.code).toBe(0);
    // **这一行是这条命令存在的理由**：不认领的话，建号那一秒他昨天梳理的东西
    // 从列表里集体消失，而磁盘上还都在。
    expect(r.out).toBe("✓ 已创建admin账号：root\n✓ 已把 2 个原有会话归到 root 名下\n");

    const after = await Store.open(dbUrl);
    const repo = new PgRepo(after.engine!);
    const u = await repo.getUserByUsername("root");
    expect((await repo.getSession("old1"))?.owner).toBe(u!.id);
    expect((await repo.getSession("old2"))?.owner).toBe(u!.id);
    await after.close();
  }, 60_000);

  it("useradd 建的账号，密码能被 auth.ts 验过（CLI 建号 → 网页登录这条路）", async () => {
    await runWithPassword(["useradd", "root", "--admin", "--password-stdin"], "pw123456");
    const { Store } = await import("../src/store/engine.js");
    const { PgRepo } = await import("../src/store/repo/pg.js");
    const { verifyPassword } = await import("../src/auth.js");
    const store = await Store.open(`sqlite+aiosqlite:///${join(workspace, "ontocopilot.db")}`);
    const u = await new PgRepo(store.engine!).getUserByUsername("root");
    expect(u).not.toBe(null);
    expect(verifyPassword("pw123456", u!.password_hash)).toBe(true);
    expect(verifyPassword("pw12345", u!.password_hash)).toBe(false);
    // CLI 建号不填名字 —— 界面回落到 username。
    expect(u!.display_name).toBe("");
    await store.close();
  }, 60_000);

  it("不能把最后一个管理员降级（降了就没人能管这个实例）", async () => {
    await runWithPassword(["useradd", "root", "--admin", "--password-stdin"], "pw123456");
    const r = await run(["role", "root", "--user"]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("✗ root 是唯一的管理员，降级后没人能管理这个实例了\n");
  }, 60_000);

  it("passwd 会顺带登出已登录的会话，并把数量写进那句话", async () => {
    await runWithPassword(["useradd", "root", "--admin", "--password-stdin"], "pw123456");
    const { Store } = await import("../src/store/engine.js");
    const { PgRepo } = await import("../src/store/repo/pg.js");
    const { makeAuthSessionRow } = await import("../src/store/types.js");
    const dbUrl = `sqlite+aiosqlite:///${join(workspace, "ontocopilot.db")}`;
    const s1 = await Store.open(dbUrl);
    const repo = new PgRepo(s1.engine!);
    const u = (await repo.getUserByUsername("root"))!;
    for (const th of ["th1", "th2"]) {
      await repo.createAuthSession(makeAuthSessionRow({ token_hash: th, user_id: u.id, expires: 9e9 }));
    }
    await s1.close();

    const r = await runWithPassword(["passwd", "root", "--password-stdin"], "brandnew");
    expect(r.code).toBe(0);
    expect(r.out).toBe("✓ 已重设 root 的密码（顺带登出了 2 个已登录会话）\n");
  }, 60_000);
});

// ══════════════════════════════════════════════════════════════════
//  audit
// ══════════════════════════════════════════════════════════════════

function tinyOir(): OIR {
  const oir = new OIR();
  oir.addObject(
    makeObjectType({
      rid: "ot.order",
      apiName: extracted("Order"),
      displayName: extracted("订单"),
      description: inferred(""),
      primaryKey: inferred(["pt.order_id"]),
    }),
  );
  oir.addProperty(
    makePropertyType({
      rid: "pt.order_id",
      parent: "ot.order",
      apiName: extracted("orderId"),
      displayName: extracted("订单号"),
      baseType: extracted(BaseType.STRING),
      definition: inferred(""),
    }),
  );
  oir.addProperty(
    makePropertyType({
      rid: "pt.amount",
      parent: "ot.order",
      apiName: extracted("amount"),
      displayName: extracted("金额"),
      baseType: extracted(BaseType.DECIMAL),
      definition: inferred(""),
    }),
  );
  return oir;
}

describe("audit", () => {
  it("原样交回 ⇒ 未达标 ⇒ **退出码 2**（不是 1），并写出 .audit.json", async () => {
    const dir = join(workspace, "out");
    mkdirSync(dir, { recursive: true });
    const oir = tinyOir();
    const spec = compileTemplate(oir, [], { roundNo: 1 });
    const specPath = spec.save(join(dir, "template.spec.json"));
    writeFileSync(join(dir, "oir.json"), JSON.stringify(oir.toDict(), null, 1), "utf8");
    const xlsx = await writeXlsx(spec, join(dir, "模板_v1.xlsx"), { project: "P" });

    const r = await run(["audit", specPath, xlsx]);
    // **三态退出码里最容易被写错的一个**：未达标是 2，程序出错才是 1。
    expect(r.code).toBe(2);
    expect(r.err).toBe("");
    expect(r.out).toContain("回传审核 · 完成度");
    expect(r.out).toContain("未达标，需再走一轮");
    expect(r.out).toContain("写回 OIR"); // oir.json 在旁边 ⇒ 走回写分支

    // `.audit.json` 与回传件同名同目录，只换后缀。
    const auditPath = join(dir, "模板_v1.audit.json");
    const raw = readFileSync(auditPath, "utf8");
    const summary = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(summary)).toContain("completeness");
    // Python 的 `json.dumps` 对 float 一定带小数点。这一整份文件与 Python CLI
    // 在同一组输入上跑出来的**逐字节相同**，`0` 与 `0.0` 是唯一会漂的一处。
    expect(raw).toContain('"completeness": 0.0');
    expect(r.out).toContain(auditPath);
  }, 60_000);

  it("没有 oir.json 时照跑，只是不写回模型", async () => {
    const dir = join(workspace, "out2");
    mkdirSync(dir, { recursive: true });
    const spec = compileTemplate(tinyOir(), [], { roundNo: 1 });
    const specPath = spec.save(join(dir, "template.spec.json"));
    const xlsx = await writeXlsx(spec, join(dir, "r.xlsx"));
    const r = await run(["audit", specPath, xlsx]);
    expect(r.code).toBe(2);
    expect(r.out).not.toContain("写回 OIR");
  }, 60_000);

  it("spec 文件不存在 ⇒ 退 1 并把异常类名打出来（不是 2）", async () => {
    const r = await run(["audit", join(workspace, "nope.json"), join(workspace, "nope.xlsx")]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("✗ Error:");
    expect(r.err).toBe("");
  });
});

// ══════════════════════════════════════════════════════════════════
//  辅助函数
// ══════════════════════════════════════════════════════════════════

describe("辅助", () => {
  it("expandFiles：目录递归、过滤 Excel 的 ~$ 锁文件", () => {
    const root = join(workspace, "mat");
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "a.xlsx"), "x");
    writeFileSync(join(root, "~$a.xlsx"), "x"); // Excel 打开时留下的残缺锁文件
    writeFileSync(join(root, "sub", "b.ddl"), "x");
    const got = expandFiles([root]).map((f) => f.slice(root.length + 1));
    expect(got.sort()).toEqual(["a.xlsx", "sub/b.ddl"]);
    // 直接给存在的路径就直接收，不 glob
    expect(expandFiles([join(root, "a.xlsx")])).toEqual([join(root, "a.xlsx")]);
    // 不存在也不匹配任何 glob ⇒ 空
    expect(expandFiles([join(root, "缺失.xlsx")])).toEqual([]);
  });

  it("loadOir 只恢复审核需要的字段（与 Python 同一份取舍）", () => {
    const oir = tinyOir();
    const pth = join(workspace, "oir.json");
    writeFileSync(pth, JSON.stringify(oir.toDict(), null, 1), "utf8");
    const back = loadOir(pth);
    expect([...back.objects.keys()]).toEqual(["ot.order"]);
    expect(back.objects.get("ot.order")!.displayName.value).toBe("订单");
    expect([...back.properties.keys()].sort()).toEqual(["pt.amount", "pt.order_id"]);
    // evidence 一律丢掉 —— Python 的 `asrt()` 就是 `[]`。
    expect(back.objects.get("ot.order")!.apiName.evidence).toEqual([]);
  });

  it("CliExit / KeyboardInterrupt 的 instanceof 跨模块成立", () => {
    expect(new CliExit(2)).toBeInstanceOf(CliExit);
    expect(new CliExit(2).code).toBe(2);
    expect(new KeyboardInterrupt()).toBeInstanceOf(KeyboardInterrupt);
  });
});
