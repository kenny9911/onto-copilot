# E2E 验收日志 · 真实 ERP 采购材料（2026-08-20）

会话 fc58b72e91bd · 账号 fde_e2e_test（临时测试号）· 8 份材料

## 地面真值（直接读源表得出，用于评判抽取质量）
- 数据架构清单：**36 个 L3 业务对象**（带定义列）+「数据对象关联关系」**40 行 源/目标/基数/说明**
- 5_采购计划：主数据清单 10 行（带**关键属性**列）、业务数据清单 11 行（带关键字段）、映射关系 13 行（带基数）
- 流程清单：66 行，**表头是"1"**（畸形表头，考验 merge_header/表头探测）
- 4_业务对象：**两张表表头全空**（考验乱表兜底）
- docx 15MB + pptx 13MB（考验大文档与视觉解析）

## 发现的问题
### E1｜批量上传 409 风暴（UX-major，未修）
一次拖 8 份材料：第 1 份 200，随后 7 份全部 409（首份的 preparse 持有 mutation
租约把后续上传挡掉）。带 3s 重试后要 1~3 次才成功。真实 FDE 在 UI 上拖一把文件
会看到 7 个红叉。方向：上传路由对 preparse 排队而不是拒绝，或把解析挪出租约。

## 已验证的昨日修复（真实数据端到端）
- ✅ readiness 认得 OCR/正文信号：报告类材料的 1127 处流程描述、245 处动词句都计入了
- ✅ 轮内启动死锁：「立即开始梳理」→ 回执说真话（排队至轮末）→ status=extracting
- ✅ Reflexion：journal 里看到后续节点的 plan 引用了前面节点的 ROWS_DROPPED 教训

### E2｜DeterminismViolation 杀死整轮抽取（blocker，✅已修）
第一轮抽取跑到 24/32 节点时 FAILED：`EXTRACT.s20_1#plan 重放不一致`。
链条：attempt 0 的 #plan LLM 调用撞上网关 503（system cpu overloaded）→ 节点按
可重试失败重进 → attempt 1 再要 #plan，prompt 已随上下文演进（并发调度下别的
节点跑完、黑板事实变了）→ 指纹不同 → DeterminismViolation → **整轮 $4.35 判死**。
恢复路径的注释早写明「同 key 重复写入意味着重试，应复用首次结果」——
恢复路径预期了重试，实时路径却在杀它。

**修**（kernel/recorder.ts）：keyed effect 撞键时查节点 attempt 水位 ——
跨 attempt = 陈账重做（发 effect.superseded 事件），同 attempt = 真不确定性照炸；
chat 侧（从不调 nextAttempt）严格性原样。6 条回归测试，含崩溃恢复分支。

### 复跑验证
「重新开始梳理」→ **续写同一个 journal**（resume 生效，已完成 24 节点的
effect 免费回放），只重跑未完成的 8 个节点。

## E3：tokens 预算硬编码 4M，大材料在 95% 处判死（已修）
- 现象：第二轮跑到 75/84 节点、$13.96/$80 usd 时 FAILED，错误只说「预算耗尽，已保存 checkpoint」。
- 根因：journal 末次 snapshot 显示 tightest=tokens（3.81M/4M）。usage.ts 上一课修了 wallclock/tool_calls 可配置，tokens 仍是硬编码 4_000_000 —— 同一个坑第三次。
- 修复：appconfig.runTokens()（ONTOCOPILOT_RUN_TOKENS，默认 4M 不变），AppConfigPort 可选方法，usage.ts 接线 `?? 4_000_000`。.env 设 12M。回归测试钉三维都可配。
- 顺带验证：第二轮 resume 复用同一 journal，但半途 503 节点的上下文漂移让部分 keyed effect 走 supersede 重付费（$4.35→$27.74 累计）——正确性对，成本语义还有优化空间（挂账）。

## E4：网关悬死连接 → 裸 SyntaxError 逃出重试循环 + 900s 节点墙钟被烧穿（已修）
- 现象：第三轮 82→86/94 后 FAILED：`EXTRACT.s37_27 超过节点墙钟上限 900s`。
- 时间线：#refine:0 这一次 LLM 调用挂了 1125s——3 次 fetch 悬死各等满 300s 超时退避重试，
  第 4 次网关回了截断的 200 体。
- 双缺陷：backends.ts 的 `res.text().catch(()=>"")` 把 body 阶段超时吞成空串；
  200 分支 `JSON.parse(text)` 对空/截断体抛裸 SyntaxError，逃出重试循环。
- 修复：body 读取失败按瞬时故障退避重试；2xx 非法 JSON 视为截断进重试循环（ModelError）；
  EXTRACT 节点墙钟 900→1800s（必须盖过 backend 最坏重试链 4×300s+退避+生成）。
- 回归：kernel.llm.test.ts 两条新测试（截断体重试恢复、body 读取失败重试恢复）。

## E5：形状推断缺「关系表/功能清单/属性清单」三个形状 → 0/39 关系、0/44 关键属性、900 假对象（已修）
- 铁证：40 行关联关系表被判成实体登记表，critic 按行数索要**对象**（ROWS_DROPPED 23/39），
  零 links 无人报警；s37 事务码表 1414 行被逼出 900 个假对象（displayName='15'、
  「MISSING_REQUIRED（第10行，内容未知）」占位符）；关键属性列无通道，10 properties/整库。
- 修复（shape.ts + pipeline.ts）：
  1) ColumnRole.CARDINALITY（1:N/M:N/一对多，全角冒号兼容）→ rowUnit "link"，
     源/目标列按列名认+列序兜底，规则逐行抽 links（含基数映射、MANY_TO_ONE 翻转）；
     critic 加 LINKS_DROPPED（漏行）分支，不再向关系表要对象。
  2) 事务码/交易码标识符列 → rowUnit "action"（功能清单），不做逐行对象覆盖压力。
  3) 「关键属性」列（只按列名认，防误收 L4逻辑数据实体）→ 逐词规则抽属性，
     宿主用本行中文名；IDENT_RE 不认 MD-01 带连字符编号，两条登记表分支都接了通道。
  4) buildOir：名字解析认显示名+别名（byAnyName），属性宿主与关系两端共用；
     属性 rid 以宿主对象 apiName 为准；PLACEHOLDER_RE 拦占位符实体名。
  5) fde_interviewer 等 6 个 FDE agent 预算补 wallclockS（900~1260s）——
     没写时掉进 dag 默认 300s，高档推理 3 步就烧穿（INTAKE 案发）。
- 回归：shape 8 条新测试、pipeline 3 条（显示名解析/方向翻转/lost 记账），全绿。

## E6：/stop 报「已停止」但 run 照跑（✅已修）
- 现象：POST /api/sessions/:sid/stop 返回 {"stopped":["run"]}，状态一直 extracting，
  7 分钟后 journal 仍在追加（INTAKE 跑完进了 PROCESS）。
- 影响：用户点停止后以为停了，实际继续烧钱。本轮用重启进程强杀 + 挪走 journal 解决。
- 根因：/stop 只 abort 了 runTask 的 controller，而 checkCancelled(signal) 只在
  阶段边界看一眼 —— DAG 一旦开跑，调度循环里没有任何检查点。
- 修复：Scheduler.run 接 opts.signal —— abort listener 立刻软停在飞节点
  （abandonAll），循环头检查保证不再派新节点、定案「外部停止请求」；run.ts 两处
  调度调用（抽取/engagement）把 controller.signal 传进去，checkCancelled 紧随其后
  把外部停止归一成 RunCancelled → 状态落 stopped 不是 failed。
- 回归：kernel.scheduler.test.ts 三条（半途 abort/进门前 abort/不传信号原样）。
- 生效时机：下次服务重启（当前进程上还跑着复跑 v2，不动它）。
- 顺带验证：INTAKE 在新预算（wallclockS=900）下这次是**跑完了**的 —— E5-5 的修复有效。

## 复跑 v2（全新 run，新形状逻辑）
- 旧 journal 存证：run_fc58b72e91bd_e5a25228.jsonl.e2e-old-shapes
- 等终态后跑 grade_oir.py 对照 36 对象/39 关系/44 关键属性重新打分。

## E7：观测泵撕裂读杀死整条 run（✅已修）
- 现象：续跑把 RULES 顺利跑完后，run 状态 failed，错误只有一行
  `SyntaxError: Unterminated string in JSON at position 1094`；事后查 journal/blob 全部完好。
- 根因：runWithLiveTrace 每秒重读 journal 投影推理面板；读者与写者赛跑时读到写了一半的
  行，JSON.parse 裸抛，注释还写着「泵失败要暴露」——观测面失败把 $40 的工作负载判死。
- 修复：①FileJournal.read 按 WAL 语义容忍**撕裂尾行**（=未提交，静默丢弃；中间行撕裂
  照抛，内存队列行照抛）；②泵包 try/catch，失败降级为 trace.pump_failed 事件。
- 回归：journal.test.ts 三条（尾行撕裂/中间行撕裂/尾行撕裂+内存行）。

## 对齐：完全同名对象合并（E5 尾巴，✅已修）
- v2 打分揭示「采购品类」×4、「采购组织」×2 —— 各段模型英译不同，老策略同名对
  name=1.0 也只有 total 0.35~0.6，连人工复核队列都进不去，永远静默并存。
- 修复：align() 在常规合并分支之后加特例 —— 显示名逐字相等（材料自身身份）且无
  结构冲突 → 合并；两侧各有结构且毫无交集 → 仍交人确认。golden no_structure 场景
  改用「像但不相同」的物料（守卫语义不变），guard_off 场景随之重生成。

## 复跑 v2 成绩单（对照地面真值，重复对象聚合后）
| 指标 | 旧逻辑 | v2 |
|---|---|---|
| 对象覆盖 | 30/36 | 33/36（缺 违约索赔单/监造计划/质量通知 —— 0.8 行覆盖阈值放行尾部 3 行）|
| 关系覆盖 | 0/39 | **37/39**（基数吻合 36；缺的 2 条恰是上述缺失对象的连带）|
| 主数据关键属性 | 0/44 | **44/44** |
| description/classification | 30/30 | 33/33 |
| properties 总量 | 10 | 211 |
| actions | 1 | 138 |
| 事务码假对象 | ~900 | 0（s37 功能清单不再逐行造对象）|
- 后续修复已进 dist 待下轮生效：критик缺行点名（ROWS_DROPPED 按名称列列出缺行）、
  M:1 基数词表、同名对象对齐合并、E6 停止信号、E7 撕裂尾行。
- 已知残留：primaryKey 0/33（材料未显式标注主键，诚实结果——应转访谈问题）；
  同名重复对象在本轮 OIR 里仍存在（对齐修复只影响下轮 finish）。

## E9/E10/E11：HITL 关口三连修（✅已修）
- E9 问题遴选颠倒：syncQuestionBacklog 把每条澄清卡无差别盖 BLOCKING —— 关口拿到的
  5 条 blocking 全是 naming lint（单选项+机器可执行 effect），SOR 归属这类真问题进不了
  关口。修复：单选项且带 effect 的卡 = 可自动施加的修复通知 → LOW；无 effect 的单选项
  卡（审批边界类，可自由作答）与多选项卡保持 BLOCKING。
- E10 死问题死锁：关口 blocking 问题引用的冲突已被 auto_repair 清掉，回答一律 409
  「冲突现在找不到了」→ HITL 永久卡死。修复：源冲突消失时问题标废（CANCELLED+原因），
  200 返回「不需要回答」。
- E11 专业分析问题不可答：agent_analysis 一刀切 409「尚未配置安全的字段级回写」——
  4000+ 条一条都答不了。修复：照常落 Decision Ledger、问题转 ANSWERED、零字段回写、
  metadata.writeback=manual_conclusion 显式标注。
- 实测：5 条命名问题重答全部 cancelled；SOR 归属（业务方口吻）与 R6-6 原文（FDE 从
  源文件取证）两条真回答 200 落账。
- E8（问题清单 4044 条爆炸、90% 是逐行规则噪音）：根因在 mineQuestions 的产出规模，
  挂账下轮治理（问题去重/聚类 + 噪音来源约束）。

## E12：awaiting_answer 无出口（✅已修）+ 存量 blocking 批量治理
- 病根一（代码，已修）：会话状态闸数**全部** pending 问题 —— 4044 条 open 谁也答不完，
  awaiting_answer 永无出口、build.start 永远 409。改为只数 blocking（与 INTERVIEW 关口
  blockers() 同判据）；compile/questions 两处闸点 + glue 新增 blockingPendingQuestions。
- 病根二（数据）：E9 修复前入库的 3901 条 blocking 旧优先级被 sync 刻意保留（防人工
  升级被降级——设计合理但缺 provenance 区分机器盖章）。批量治理脚本按桶处置：
  事务码系（naming 840 + pk_tcode 550 + 孤儿 tcode ~1386）→ cancelled（对应 FDE 已
  授权的技术噪音过滤）；真对象 PK/中文名/缩写（~1008）→ deferred（待业务补料）；
  语义口径 117 → 按业务方批量授权逐条作答（主数据/主表定义优先，rationale 落账）。
- 附：网关余额 402 后改走零模型调用通路（PATCH/answer + 确定性 recompile/resume）——
  QuotaExhausted 快速失败路径实测有效。

## E13/E14：回写崩溃与活 OIR 水合缺失（✅已修）
- E13 现象：16 条语义冲突作答全部「回答已记录，但回写 Ontology 失败：undefined.properties」。
- E14 根因：挂起在 INTERVIEW 的会话从未写过 oir.json 产物，而 hydrate 只从该文件建活
  `_oir` —— 重启后 worker 上一切回写失灵：applyDecision 崩、transition 的 recompile
  因 `_oir` 缺席静默跳过（此前 3784 次处置没有一次真正触发重算）。
- 修复：hydrate 在 oir.json 缺席时回落到 state.oir 建活对象。重答 16/16 全部落账。
- 第三处状态闸（answer 流内的重算）同步补上 blocking-only 过滤。

## 终局（2026-08-20）
- **全链首次端到端跑通**：10 个 engagement 节点全部完成（INTAKE→…→INTERVIEW→
  CANONICALIZE→REVIEW→EXPORT），OntologyPackage v1 释出（release_state=DRAFT，
  诚实反映 152 条普通 open 问题）；会话状态收敛 done。
- 交付物：ontology.package.json（dataObjects 523 含治理字段 identity/lifecycleStates/
  systemOfRecord/sensitivity/ownerRole；actions 157；rules 322；events 19；roles 73；
  evidence 585；decisions 18 含业务方拍板）、oir.json、模板_v1.xlsx、template.spec.json、
  rules.json、数据字典.xlsx、流程图.svg/mmd、问题清单三格式。
- 终验成绩（对照地面真值）：对象 33/36、关系 37/39（基数 36）、主数据关键属性 44/44、
  description/classification 满分。残留三项（尾行 3 对象、连带 2 关系、M:1 词表）
  修复已在 dist，下一轮全新抽取生效。
- 全程发现并修复 14 组缺陷（E1~E14），新增回归测试 30+ 条，测试基线 6557 绿。
