# 知识库重新设计 —— 决策记录

2026-09-02

## 0. 一句话

知识库的代码是完整的（`tsc` 零错误、196 个测试全绿），但它**从未被编译进运行的构建**，也**从未装进过一份文件**。
这两件事的原因不同：前者是发布事故，后者是设计问题。这份文档只解决后者，前者见 §1。

---

## 1. 诊断

### 1.1 页面上的 404 是发布事故，不是 bug

| 事实 | 证据 |
|---|---|
| 守护进程跑的是 8-31 17:36 编译出的 `ts/dist` | PID 99130，`node --env-file=.env ts/dist/src/main.js`，启动于 8-31 17:38 |
| 知识库全部代码写于 9-1 / 9-2，且未提交 git | `ts/src/document/`（21 文件）、3 个 route 文件，`git status` 全是 `??` |
| dist 里根本没有这些路由 | `grep -c registerDocumentRoutes ts/dist/src/serve.js` → 0；`ts/dist/src/document/` 不存在 |
| 但前端是新的 | `ui/index.html`（9-2 12:31）与守护进程实际吐出的字节 sha256 一致 |

`npm run build:ui` 跑了，`npm run build`（tsc）没跑 → **新前端打旧后端**，请求落到 Hono 默认 handler，
返回纯文本 `404 Not Found`，被 UI 错误框原样显示。

已用同一份 dist 在 8799 端口起一次性实例复现，`/documents` 系列全 404 而 `/api/sessions` 200，随即销毁。真实守护进程未触碰。

### 1.2 修好构建之后，页面**仍然**打不开

43 个知识库接口全部挂在 `/api/sessions/:sid/…`，`routeScope` 在 `session.projectId` 为空时抛 409。
真实库里 **33/42 个会话 `project_id IS NULL`**。所以编译一跑，错误只会从「404 Not Found」变成
「这个会话还没有归入项目」——看起来像修失败了。

### 1.3 四个结构问题

1. **它不是「项目」知识库。** `DocumentScope = {projectId, owner}`，`owner` 取自当前登录账号，
   进了每一条 WHERE，还进了 ACL 与 Wiki 表的**主键**。而 `project` 本身只有一个 owner、没有成员表。
   结果：一个人的私人文件夹挂了项目的牌子；ACL 是同义反复（主体就是边界键，给别人开的规则永远不可能命中）。
   附带一条数据丢失路径：`adoptLocalSessions` 在建号时把 session 和 project 改姓，但**不改 document**。

2. **它从来没装过东西。** `onto_document` = 0 行，`session_file` = 55 行。
   入库要人工点「保存到项目库」，用起来还要再点「用于本次分析」；而这两步走完，
   同一份材料会被**索引两遍**（`preparse` 解析 `s.files` 一次，附加的 KB 文档再追加一次，无去重），
   污染 BM25 词频。没有人会为每个文件点两次按钮。

3. **五个 Tab 是后端五个路由文件的镜像，不是用户的五件事。**
   处理任务 / 数据源 / 权限审计三个 Tab 是内部机器：数据源列了 6 个企业连接器但 sink 永远抛异常；
   权限审计要用户手填 chunk id。而**存进去的文件没有任何打开/预览入口**——只能猜关键词去搜。

4. **页面与聊天零连接。** 五个知识库文件里没有一处 `prefillComposer` / `sendContextToChat`（右侧栏有 10 处）。
   唯一通道「用于本次分析」**点了不生效**：它只写一行 `session_document`，
   而 `reconcileDocumentEvidence` 只对已缓存的 `_chunks` 做过滤、从不加载新挂载版本的正文。
   更糟的是严格材料门这时会认为材料存在却检索不到，助手会变得**更闪烁**，不是更准。

---

## 2. 用户意图（原话）

> 项目文件管理知识库，用户自己不光可以手动管理，也可以通过与 Copilot 互动，来管理知识库，
> 搜索相关文章或者知识。Copilot 在运行过程中，也可以自己判断是否去知识库里检索相关知识文件等等。

拆成三条可验收的能力：

- **A. 手动管理** —— 传、看、改、归档、比版本。今天「看」完全缺失。
- **B. 对话管理** —— 在对话里让 Copilot 帮你管库和找料。今天完全不存在。
- **C. 自主检索** —— Copilot 运行中自己判断要不要查库。今天 work 模式没有 ContextManager，
  模型只能靠自己主动调工具，而系统提示里没有任何触发指引。

---

## 3. 决策

### D0 两级：总知识库 + 项目知识库

> 产品负责人原话（2026-09-02）：「知识库，不应该是项目库，这个知识库是应该可以直接去访问的，
> 应该有一个总的知识库，然后分不同项目还有不同项目的知识库。」

- **总知识库**：一个部署一个，**直接访问**，既不依赖会话也不依赖项目。
  装跨项目复用的东西 —— 行业标准、通用制度、模板、历史沉淀。
- **项目知识库**：每个项目一个，装这个项目自己的材料。
- **检索两层一起搜，每条命中必须标明层级。** 把一份行业通用制度当成这个客户自己的规定，
  是这个产品最不能出的错。
- **写入总库是显式的人的动作**（「设为通用知识」），不自动。AI 只能建议 —— 与既有纪律一致。
  否则总库三个月后就是垃圾场。

实现上复用同一套表，用保留边界 `project_id = owner = "__global__"`
（真项目 id 是 12 位十六进制，撞不上；和侧栏 `__unfiled__` 哨兵同一手法）。
**现在做零迁移成本**：所有 `onto_document_*` 表都是 0 行。晚做就要回填。

### D1 入库模型 = 项目优先 + 临时材料逃生口

- 会话里上传 → **自动进项目知识库**（document + version + chunks），并自动 pin 到当前会话。
- 上传时可勾「只在本次会话用」→ 保持今天的 `session_file` 行为，不入库；之后可一键转正。
- 删掉「保存到项目库」这个动作（已自动化），保留「归档」。

**推翻了** `docs/OntoDocument-产品与技术方案-2026-09-01.md` 规定的双人工按钮模型。
理由：那个模型就是 `55 : 0` 的直接原因。这是明知的分歧，不是疏忽。

### D2 `scope.owner` 改成「项目的 owner」，而不是「当前登录的人」

不删列、不改表形状——只改取值来源。一处改动换来三件事：
知识库真正属于项目；ACL 终于有东西可管；关掉建号即蒸发的数据丢失路径。

### D3 没有项目的会话惰性落到默认项目

`routeScope` 不再 409，而是找到或创建该 owner 的默认项目并把会话归进去。杜绝 §1.2 的伪修复。

### D4 项目级地址

新增项目级路由与可 bookmark 的页面地址；切换同项目下的会话不再把用户踢出知识库。
会话级路由保留兼容。

### D5 Copilot 工具集（用户最强调的那一半）

- **读**：`document.outline` / `document.open` —— 今天完全没有，模型只能猜关键词。
- **列**：枚举项目材料（标题、标签、版本、解析状态），回答「我们项目里有哪些材料」。
- **管**：改名 / 打标签 / 归档 / 合并重复。写操作走**代码库里已有的**人工确认机制，
  不新造一套——产品纪律是「AI 只能起草，不能替人确认」。
- **自主**：每轮注入一行知识库摘要（N 份材料，涵盖 X/Y/Z），并在系统提示里写明触发条件。
  否则模型不知道有库可查。

### D6 修「用于本次分析」不生效 + 消除双重索引

挂载后必须真把该版本的正文喂进活会话的 `EvidenceIndex`；`preparse` 必须跳过已入库的同一份材料。

### D7 页面重做：五个后端 Tab → 用户的三件事

- **材料**（可读！能展开看解析后的正文与切片）/ **检索**（证据卡，可「发到对话」）/ **整理**（Wiki，AI 起草人工确认）
- 处理任务 → 材料卡上的状态角标 + 折叠抽屉；数据源 → 收进「添加材料」下拉；权限审计 → 移到项目设置。
- **知识库页面保留对话输入框。** 今天 `body.knowledge-page-open` 把 `.comp` 藏了——
  而用户要的正是「在知识库里跟 Copilot 说话」。这条 CSS 与 D5 直接冲突，必须改。
- 视觉语言不动：复用 `ui/index.html` 现有 class 与组件惯例，不做视觉重设计。

---

## 4. 明确不做

- 不删 `owner` 列、不改表主键形状（D2 已用改语义达成目的，代价小一个数量级）。
- 不接向量检索。语义打分器的接缝留着不点亮，直到有 embedding 供给；先把词法检索的
  召回洞（只发 bigram、无 unigram 回退）补上，那才是「搜不到」的主因。
- 不修企业连接器的 sink（今天永远抛异常）。先让它不出现在 UI 上，而不是假装能用。

---

## 5. 分期

| 期 | 内容 | 状态 | 验收 |
|---|---|---|---|
| P0-a | D2（owner=项目 / actorId 分离）+ D3（默认项目）+ D6 半（reconcile 撤权范围、attach 真加载）+ contextBrief 库存概览 | **已完成，7579 测试全绿** | 见 §7 |
| P0-b | D0 两级：`__global__` 作用域、两级检索合并与来源标注 | 进行中 | 项目会话能搜到总库材料，且命中上写着「总库」 |
| P0-c | 可直接访问：非会话路由 + 可 bookmark 的页面地址 | 待做 | 不开会话也能打开总知识库 |
| P1 | D1 上传即入库 + D5 剩余（顺序读、合并重复） | 待做 | `onto_document` 不再是 0 |
| P2 | D7 页面重做（三件事 / 可读 / 引用到对话 / 保留 composer） | 待做 | 能读完一份材料并把某段引用进对话 |

---

## 6. 上线记录（2026-09-02 16:39）

`npm run build` + `npm run build:ui` 后 kill 守护进程（launchd KeepAlive 自动带新 dist 重生，
PID 99130 → 5762）。判据从 `grep -c registerDocumentRoutes ts/dist/src/serve.js` = **0 变成 2**，
`ts/dist/src/document/` 出现，三个路由文件编译产物齐全。

线上六组知识库端点从 `404 Not Found`（路由不存在）变为 `401`（鉴权门后面，路由存在）：
`/documents`、`/documents/wiki/pages`、`/documents/acl`、`/documents/audit`、
`/documents/jobs`、`/document-connectors`。首页 200，`/api/health` 返回
`{"ok":true,"database":{"ok":true,"schema_version":18}}`。

重启瞬间 stderr 有一条 `database is locked` —— 新旧进程重叠时的一次性竞争，之后未再出现。

三份 UI（`ui/index.html`、`ts/dist/src/server/ui/index.html`、服务实际吐出的字节）
sha256 一致。本轮没有改动 `ts/src/ui/*`，所以 bundle 与重建前逐字节相同，属预期。

推送：`fork`（stevenchengxy/onto-copilot）与 `origin`（stevenchengxy/OntoChat）已同步到 `b39c63b`；
`kenny9911/onto-copilot` 无推送权限（`permissions.push=false`），走 PR
[#3](https://github.com/kenny9911/onto-copilot/pull/3)（OPEN / MERGEABLE，597 文件）。

---

## 7. 附：验证纪律

改完必须两步都跑：`cd ts && npx tsc`（后端）与 `npm run build:ui`（前端，已自动同步 dist 副本）。
判据是 `grep -c registerDocumentRoutes ts/dist/src/serve.js`，不是文件时间戳。
只跑其中一个就会造出「半个功能」——本次事故正是如此。

---

## 8. 已完成部分的验收记录（2026-09-02）

| 改动 | 钉住它的测试 |
|---|---|
| `scope.owner` = 项目 owner；`actorId` 独立，`principalOf` 用它 | `test/document_scope.test.ts`「scope.owner 取项目 owner；发起调用的人只出现在 actorId 上」 |
| 项目行读不到时回落到会话 owner（不是 actor） | 同上「项目行读不到时回落到会话 owner」 |
| 无项目会话惰性归入默认项目 + 回执 | 同上两条「没有项目的会话不再 409」 |
| `reconcile` 只在真有项目正文时撤权 | `test/document_projection.reconcile.test.ts` 三条 |
| attach 之后正文真的进证据索引 | `test/dialogue.document-tools.test.ts`「attach 成功后刷新 _document_manifest 并持久化」 |

三处曾经互相打架的作用域解析（HTTP 三个入口、模型工具十三处、preparse/dialogue 两处）
现在收口在 `server/routes/document_scope.ts` 与 `server/glue/project_scope.ts`，
两者的兜底规则**逐字一致** —— 不一致就等于把一个项目劈成两个存储分区。
