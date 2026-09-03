/**
 * 会话 → 项目存储边界。
 *
 * 单独一个模块是为了避开循环依赖：`dialogue/document_tools.ts`、`glue/preparse.ts`
 * 和 `dialogue.ts` 三处都要它，而前两者之间本来就互相 import。
 *
 * 这段解析和兜底必须和 HTTP 侧的 `server/routes/document_scope.ts`
 * **逐字一致**。两条路径对同一个项目算出不同的 owner，就等于把一个项目劈成两个
 * 存储分区：页面里存进去的文档，模型工具和 DAG 流水线一份都看不见。
 */

import { sha256Hex } from "../../kernel/ids.js";
import type { DocumentScope } from "../../document/types.js";
import { globalLibraryScope } from "../../document/types.js";
import { getRepoOptional } from "../../store/deps.js";
import type { Repo } from "../../store/repo/protocol.js";
import { makeProjectRow } from "../../store/types.js";

/**
 * 解析作用域只需要会话的这几个字段。`projectId` 可写：会话还没归项目时，
 * 这里会惰性把它归进默认项目并就地写回。
 */
export interface ProjectScopeSessionLike {
  readonly id?: string;
  projectId: string;
  readonly owner: string;
}

/**
 * 自动建出来的默认项目名。**不能**叫「未归类」——侧栏那个是 project_id 为空的
 * 虚拟分组，真建一个同名项目会并排出现两个都叫「未归类」的东西。
 */
export const DEFAULT_PROJECT_NAME = "我的材料";
const DEFAULT_PROJECT_FLAG = "oc_default";

/** 默认项目 id 由 owner 推导：并发建只会撞主键，不会建出两个。 */
export function defaultProjectId(owner: string): string {
  return sha256Hex(`oc:default:${owner}`).slice(0, 12);
}

/**
 * 找到或创建这个 owner 的默认项目。
 *
 * 会话没归项目时不能直接拒绝 —— 真实库里 33/42 个会话 project_id 为空，
 * 拒绝等于知识库对多数会话根本不存在。模型侧尤其明显：用户说「把这几份材料放进
 * 知识库」，模型只能回一句「当前会话尚未关联任何项目，我暂时无法保存」，
 * 而用户根本不知道该去哪里关联。
 */
export async function ensureDefaultProject(
  repo: Repo,
  owner: string,
): Promise<{ id: string; name: string; owner: string; created: boolean }> {
  const id = defaultProjectId(owner);
  const mine = await repo.listProjects({ owner });
  // 按 prefs 标记找，不按名字 —— 用户可以把「我的材料」改成别的名字。
  const found = mine.find(
    (p) => (p.prefs as Record<string, unknown> | undefined)?.[DEFAULT_PROJECT_FLAG] === true,
  ) ?? mine.find((p) => p.id === id);
  if (found !== undefined) {
    return { id: found.id, name: found.name, owner: found.owner, created: false };
  }
  const row = makeProjectRow({
    id,
    name: DEFAULT_PROJECT_NAME,
    owner,
    prefs: { [DEFAULT_PROJECT_FLAG]: true },
  });
  try {
    await repo.createProject(row);
  } catch (exc) {
    // 冲突后重读，不去认错误形状：projects.ts 的 isDuplicateProject 只认 Postgres 的
    // 23505，而真库是 SQLite（那边抛 ERR_SQLITE_ERROR / errcode 1555）。
    const again = await repo.getProject(id);
    if (again === null) throw exc;
    return { id: again.id, name: again.name, owner: again.owner, created: false };
  }
  return { id: row.id, name: row.name, owner: row.owner, created: true };
}

/**
 * `owner` 是**项目的** owner，不是会话的 —— 知识库是项目资产，同一个项目下的人
 * 必须落在同一个存储分区。`actorId` 才是发起调用的人：`principalOf`
 * （document/service.ts:70）拿它去和 ACL 的 `boundary.owner` 比，两者合一时
 * `acl.ts:445` 的 `project_owner` 捷径恒真，整套规则形同虚设。
 *
 * 仓储没起来（窄单测、lifespan 之前）时退回 `session.owner`，也就是今天的行为 ——
 * 同 `document/deps.ts` 的 `getDocumentServiceOptional()` 那条纪律：
 * 「不存在」在窄单测里是正常状态，不是接线 bug。
 */
export async function documentScope(session: ProjectScopeSessionLike): Promise<DocumentScope> {
  // store/deps.ts 的 Repo 还是占位类型，和 session.ts:481 的 `getRepo() as Repo` 同处理。
  const repo = getRepoOptional() as Repo | null;
  // 会话还没归项目 → 惰性归入默认项目，而不是拒绝。和 HTTP 侧
  // （routes/document_scope.ts 的 resolveProjectScope）**逐字一致**的行为。
  if (!session.projectId && repo !== null && session.owner) {
    const ensured = await ensureDefaultProject(repo, session.owner);
    session.projectId = ensured.id;
    if (session.id) await repo.assignSession(session.id, ensured.id);
  }
  const project = repo === null ? null : await repo.getProject(session.projectId);
  return {
    projectId: session.projectId,
    owner: project?.owner || session.owner,
    actorId: session.owner,
  };
}

/**
 * 一个会话检索时该覆盖的**两层**作用域：项目库 + 总库。顺序有意义，项目库在前。
 *
 * ⚠️ **绝对不要「分别检索两次、再按 score 合并」。**
 *
 * BM25 的 `df` 和 `avgLength` 是**按本次装载的语料**现算的（service.ts 的 search：
 * `corpus` 就是本 scope 过完 ACL 的全部 chunk，`idf` 由 `corpus.length` 与 `df` 推出）。
 * 也就是说同一个词、同一段文字，在项目库（语料小）和总库（语料大）里算出的分数
 * 可以差一个数量级，差别**完全来自语料怎么切**，与相关性无关。按分数合并 = 把两把
 * 刻度不同的尺子读数相加。
 *
 * 用 RRF 按名次融合同样错，而且错得更隐蔽：k=60 时总库的第 1 名（1/61）恒定压过
 * 项目库的第 2 名（1/62）。总库是部署级、只增不减的，任何查询几乎都能在里面碰出一个
 * 勉强沾边的第 1 名 —— 于是客户自己那条高分规定被行业通用文本挤下去。这正是这个产品
 * 最不能出的错，而 RRF 会把它变成默认行为。
 *
 * 正确做法是**并集语料**：把两层的候选合并成一份 corpus，只算一次 df/avgLen、
 * 只跑一遍 BM25；ACL 仍然逐层裁决、逐层设 fence，安全边界一点不动。
 * 每条命中带上自己的 `level`（见 document/types.ts 的 KnowledgeLevel）。
 *
 * 会话还没归项目时只返回总库那一层。
 */
export async function layeredScopes(
  session: ProjectScopeSessionLike,
): Promise<readonly DocumentScope[]> {
  const global = globalLibraryScope(session.owner);
  if (!session.projectId) return [global];
  return [await documentScope(session), global];
}
