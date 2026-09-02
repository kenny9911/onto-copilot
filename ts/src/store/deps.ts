/**
 * 接线 —— 路由怎么拿到仓储。移植自 `store/deps.py`。
 *
 * **依赖注入，不是全局池。** 具体说：引擎是模块级单例（连接池本来就该是进程级的），
 * 但路由拿到的是 `getRepo()` 的产物，而不是 `import { POOL }`。差别只在一件事上，
 * 而这件事是决定性的：测试要能把整条数据库路径换掉（Python 侧靠
 * `app.dependency_overrides[get_repo]`，这里靠 `setRepoForTests`），
 * 254 个测试一个库都不连的前提就靠这一层。
 *
 * **为什么注入 repo 而不是注入一条 connection**：路由里管理连接生命周期意味着每个
 * 路由都要背一遍 begin/commit 的纪律，而这个服务里 `_run_pipeline` 是后台任务
 * （server.py:255 的 `asyncio.create_task`）—— 它压根不在请求作用域里，拿不到请求级
 * 连接。两条路径用同一个 repo 对象、各自开事务，才不会出现"后台任务用了一个早已被
 * 请求结束时归还的连接"。
 *
 * ── 分叉：repo 还没迁 ──────────────────────────────────────────────────────
 *
 * Python 侧 `deps.py` 直接 `from .repo import Repo, build_repo`。TS 侧 `repo.ts` 还
 * 不存在（repo.py 15 万字节，是另一条 track），所以这里把 `build_repo` 做成一个
 * **注册点**：repo 落地后调一次 `registerRepoBuilder(buildRepo)`，本文件的选路逻辑
 * 一个字都不用改。没注册时 `getRepo()` 抛的错与 Python 侧"仓储未初始化"同形 ——
 * 失败是显式的，不会拿到一个半吊子的 repo。
 */

import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import { Store, databaseUrl } from "./engine.js";

/** repo 落地前的占位类型。`repo.ts` 到位后把这里换成 `export type { Repo } from "./repo.js"`。 */
export type Repo = object;

export type RepoBuilder = (store: Store) => Repo;

//: 进程级单例。连接池就该是进程级的 —— 每请求建池会把 Postgres 的 max_connections 打爆。
let _store: Store | null = null;
let _repo: Repo | null = null;
let _buildRepo: RepoBuilder | null = null;

/** 见文件头的分叉说明：repo track 落地后调一次。 */
export function registerRepoBuilder(builder: RepoBuilder | null): void {
  _buildRepo = builder;
}

function buildRepo(store: Store): Repo | null {
  return _buildRepo === null ? null : _buildRepo(store);
}

/** 材料与产物的落盘根。
 *
 * 容器里挂在 /data/workspace，宿主机上还是 ./workspace —— 所以 session_file 存的必须是
 * **相对路径**，绝对路径换个环境就失效（现状 server.py:187 存的是 `str(dest)`）。 */
export function workspaceRoot(): string {
  const raw = process.env["ONTOCOPILOT_WORKSPACE"];
  if (raw === undefined) return "workspace";
  // Python 侧是 `Path(os.getenv(..., "workspace"))`，而 `Path("")` 就是 `Path(".")`；
  // TS 这边 `""` 会一路传到 mkdir 才炸，所以在这里折平。
  return raw === "" ? "." : raw;
}

/** 对应 Python 的 `lifespan(app)` 前半段：建 workspace 根、选路（库/内存）、把选路结果
 * 讲清楚。**不在这里跑迁移** —— 迁移是独立的一次性任务（compose 里的 migrate 服务）。
 * 应用进程自己迁移的话，滚动发布时 N 个副本会同时改 schema。 */
export async function startStore(): Promise<Store> {
  const root = workspaceRoot();
  mkdirSync(root, { recursive: true });
  const url = databaseUrl();

  if (!url) {
    // 没配 DATABASE_URL **不该等于丢数据**。这是个本地工具，一个 SQLite 文件就够了，
    // 零配置。"默认丢失、要配置才保存"是把运维负担摊给用户，而他多半到重启那一刻才
    // 发现。
    //
    // 真要纯内存（跑测试、临时试用）用 ONTOCOPILOT_NO_DB=1 显式关掉。
    if (process.env["ONTOCOPILOT_NO_DB"]) {
      _store = await Store.open("");
      _repo = buildRepo(_store);
      console.log("[store] ONTOCOPILOT_NO_DB=1 → 纯内存，重启即丢");
      return _store;
    }
    // Python 侧是 `(root / "ontocopilot.db").resolve()`（跟符号链接），mkdir 已经跑过
    // 所以 realpath 一定成得了。
    const dbPath = join(realpathSync(resolve(root)), "ontocopilot.db");
    // SQLite 走 create_all：它没有滚动发布，也没有多副本同时改 schema 的问题，单独维护
    // 一套迁移不值得。若这里仍失败，必须 fail closed —— 静默换成易失内存会把启动故障
    // 伪装成数小时后的数据丢失。
    try {
      _store = await Store.open(`sqlite+aiosqlite:///${dbPath}`, { createAll: true });
    } catch (e) {
      // 转成包含落盘路径的可诊断错误
      const name = e instanceof Error ? e.name : typeof e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `本地 SQLite 无法启动（${join(root, "ontocopilot.db")}）：${name}: ${msg}。` +
          "若确需临时内存模式，请显式设置 ONTOCOPILOT_NO_DB=1。",
        { cause: e },
      );
    }
    console.log(`[store] 本地 SQLite → ${join(root, "ontocopilot.db")}`);
    _repo = buildRepo(_store);
  } else {
    // 显式 DATABASE_URL 也允许指向 SQLite（本地开发、桌面部署和测试常用）。一个全新的
    // SQLite 文件与零配置路径应有相同的建表语义；否则连接本身 healthcheck 会成功，
    // 随后应用第一次读取 app_setting 才以"no such table"崩溃。PostgreSQL 仍只走独立
    // 迁移，绝不由应用副本 create_all。
    _store = await Store.open(url, { createAll: url.startsWith("sqlite") });
    _repo = buildRepo(_store);
  }

  if (_store.enabled) {
    const health = await _store.healthcheck();
    if (!health.ok) {
      // **显式配了** DATABASE_URL 却连不上 → 直接失败，不偷偷回落到内存。和
      // llm_config() 拒绝静默换端点是同一条纪律：用户指定了一个后端，我们换了另一个
      // 而不告诉他，是最难查的一类问题。
      if (databaseUrl()) {
        await _store.close();
        _store = null;
        _repo = null;
        throw new Error(`DATABASE_URL 已配置但连不上：${health.error}`);
      }
      console.log(`[store] 本地库异常：${health.error}`);
    }
  }
  return _store;
}

/** 对应 lifespan 的 finally 半段。 */
export async function shutdownStore(): Promise<void> {
  const store = _store;
  _store = null;
  _repo = null;
  if (store !== null) await store.close();
}

/** 对应 Python 的 `@asynccontextmanager lifespan(app)`：整个应用生命周期包在里面。 */
export async function lifespan<T>(body: (store: Store) => Promise<T>): Promise<T> {
  const store = await startStore();
  try {
    return await body(store);
  } finally {
    await shutdownStore();
  }
}

/** 路由用的依赖。测试里用 `setRepoForTests` 换掉。 */
export function getRepo(): Repo {
  if (_repo === null) throw new Error("仓储未初始化 —— app 的 lifespan 没跑起来");
  return _repo;
}

export function getStore(): Store {
  if (_store === null) throw new Error("Store 未初始化");
  return _store;
}

/** 给不走 HTTP 的单元测试用。 */
export function setRepoForTests(repo: Repo | null): void {
  _repo = repo;
}

/**
 * Store/lifespan 还没起来时返回 null，而不是抛。
 *
 * 和 `document/deps.ts` 的 `getDocumentServiceOptional()` 同一个理由与同一种写法：
 * 窄单测（不起 HTTP、不起 lifespan）里「仓储不存在」是正常状态，不是接线 bug，
 * 调用方按「这条信息拿不到」降级即可。**只**吞这一种错误，其余照抛。
 */
export function getRepoOptional(): Repo | null {
  return _repo;
}
