# ActionType反推
> 从 OpenAPI 的业务状态变更端点形成可追溯的 ActionType 候选，供业务确认而不是直接入模

## 何时用
OIR 缺少 ActionType，且材料中存在 OpenAPI、接口清单或端点定义时使用；纯查询、
技术运维接口和无法证明业务状态变化的 CRUD 端点不直接生成 ActionType

## 步骤
1. 用 `evidence.search` 和 `evidence.rows` 找到端点原文，记录 HTTP method、path、
   operationId、请求体判别字段、响应、错误码及 JSON Pointer。
2. HTTP method 只作候选过滤，不作业务结论：
   - GET/HEAD 通常是查询；若材料显示有副作用，标为接口设计异常并提问；
   - POST 可能是创建、命令或搜索；
   - PUT/PATCH 可能只是技术更新，也可能承载状态迁移；
   - DELETE 要区分物理删除、作废、取消和归档。
3. 排除健康检查、登录、上传、分页查询、缓存刷新等技术动作，除非材料明确证明
   它们改变业务对象状态。
4. 拆解 path、operationId 和请求判别字段，将候选映射到 `oir.query` 中已有对象，
   并写出动作主体、业务对象、前置状态、后置状态、输入、结果或事件。无法说明状态
   变化的只保留为待验证端点。
5. 不假设“一端点一动作”：一个端点可能由判别字段承载多个业务动作，一个业务动作
   也可能由多个端点共同完成。按业务状态迁移聚类，而不是按 URL 数量计数。
6. 每条候选标记 `DRAFT_FROM_API`，包含候选名称、对象 ID、端点定位、状态变化、
   证据、置信度和未决项。
7. 按业务域和决策人聚合确认问题；未经确认的候选不得变成已确认 ActionType。

## 完成判据
- 每个候选都能定位到端点和 JSON Pointer
- 技术写接口、查询接口和业务状态变更已区分
- 每个候选都说明了对象及可验证的状态变化
- 一端点多动作和多端点一动作已被检查
- 所有候选均标记 DRAFT_FROM_API，且未被伪装成业务事实
- 确认问题按业务域聚合，没有对每个端点机械提问

## 工具
evidence.search、evidence.rows、oir.query

## 标签
ActionType、action、OpenAPI、写端点、状态迁移
