"""Kernel 异常。

分两类：
  - HarnessError 及其子类：编排层自己的问题，通常是 bug 或配置错误，不重试。
  - NodeFailure：节点执行失败，调度器可按策略重试或降级。
"""

from __future__ import annotations


class HarnessError(Exception):
    """内核层错误基类。"""


class DagError(HarnessError):
    """DAG 定义非法：环、悬空依赖、重复节点 id。"""


class FrozenPlanViolation(HarnessError):
    """计划冻结后仍试图修改拓扑。

    这是安全边界而非普通错误 —— 间接提示注入的主要防线就是让材料内容
    无法改变 DAG 结构（见架构文档 §4.5.1）。
    """


class DeterminismViolation(HarnessError):
    """重放时重算出的 effect 请求与历史记录不一致。

    说明工作流代码里混进了未经记账的非确定性（时间、随机、字典序、
    直接调用外部服务），必须修代码而不是放宽检查。
    """

    def __init__(self, key: str, recorded: str, replayed: str) -> None:
        super().__init__(
            f"effect {key!r} 重放不一致\n  已记录: {recorded}\n  重算出: {replayed}"
        )
        self.key = key
        self.recorded = recorded
        self.replayed = replayed


class BudgetExhausted(HarnessError):
    """预算耗尽。"""

    def __init__(self, dimension: str, limit: float, spent: float) -> None:
        super().__init__(f"{dimension} 预算耗尽: {spent:.0f} / {limit:.0f}")
        self.dimension = dimension
        self.limit = limit
        self.spent = spent


class ToolDenied(HarnessError):
    """工具被安全闸拒绝（未注册、描述指纹变更、参数越权）。"""


class SandboxError(HarnessError):
    """沙箱执行失败（超时、越权、产物校验不过）。"""


class NodeFailure(Exception):
    """节点执行失败。调度器据 retryable 决定是否重试。"""

    def __init__(self, node_id: str, reason: str, *, retryable: bool = True) -> None:
        super().__init__(f"[{node_id}] {reason}")
        self.node_id = node_id
        self.reason = reason
        self.retryable = retryable


class HumanInputRequired(Exception):
    """节点需要人的决策才能继续。

    不是错误 —— 调度器捕获后挂起整个 Run，等 HumanDecisionRecorded 事件到达
    再从当前 checkpoint 恢复。
    """

    def __init__(self, node_id: str, request_id: str, payload: dict) -> None:
        super().__init__(f"[{node_id}] 等待人工决策 {request_id}")
        self.node_id = node_id
        self.request_id = request_id
        self.payload = payload
