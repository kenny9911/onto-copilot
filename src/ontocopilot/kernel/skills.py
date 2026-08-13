"""Skills —— 打包好的领域程序性知识。

一个 Skill 是"这类活该怎么干"的成文办法：口径怎么对齐、命名怎么归一、
ActionType 怎么从 OpenAPI 反推。它不是提示词模板，而是**带检查清单的操作规程**。

**渐进披露是这个机制的全部意义。** 默认只有一句 description 在上下文里；模型
判断相关时才载入正文。全量塞进去就退化成一个巨大的系统提示词 —— 那样既贵，又会
把真正相关的那条淹掉。

三类内容缺一不可：

* ``when_to_use`` —— 触发条件。写不清楚触发条件的 skill 要么不被用、要么滥用。
* ``procedure`` —— 步骤。给做法，不给背景知识。
* ``checklist`` —— 完成判据。没有判据的规程无法验收，也无法进 critic。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from .memory.types import est_tokens


@dataclass(frozen=True, slots=True)
class Skill:
    name: str
    description: str  # 一句话，常驻上下文
    when_to_use: str
    procedure: str  # 正文，按需载入
    checklist: tuple[str, ...] = ()
    tools: tuple[str, ...] = ()  # 这个 skill 需要哪些工具
    tags: tuple[str, ...] = ()

    @property
    def tokens(self) -> int:
        return est_tokens(self.procedure)

    def brief(self) -> str:
        """常驻形态 —— 只够模型判断"要不要载入"。"""
        return f"- **{self.name}**：{self.description}　（何时用：{self.when_to_use}）"

    def render(self) -> str:
        """载入形态。"""
        parts = [f"## Skill: {self.name}", f"**何时用** {self.when_to_use}", "",
                 self.procedure.strip()]
        if self.checklist:
            parts += ["", "**完成判据**（逐条自查，做不到就说明做不到，不要含糊过去）"]
            parts += [f"- [ ] {c}" for c in self.checklist]
        if self.tools:
            parts += ["", f"**需要的工具** {'、'.join(self.tools)}"]
        return "\n".join(parts)


class SkillLibrary:
    """技能库。按需载入，不全量塞。"""

    def __init__(self, skills: list[Skill] | None = None) -> None:
        self._skills: dict[str, Skill] = {s.name: s for s in (skills or [])}

    def register(self, skill: Skill) -> SkillLibrary:
        self._skills[skill.name] = skill
        return self

    def get(self, name: str) -> Skill:
        if name not in self._skills:
            raise KeyError(f"没有名为 {name!r} 的 skill（已注册：{sorted(self._skills)}）")
        return self._skills[name]

    def __len__(self) -> int:
        return len(self._skills)

    def names(self) -> list[str]:
        return sorted(self._skills)

    # ── 渐进披露 ────────────────────────────────────────────────
    def catalog(self, names: list[str] | None = None) -> str:
        """常驻目录。只有 description + 触发条件，没有正文。"""
        picked = [self._skills[n] for n in (names or self.names()) if n in self._skills]
        if not picked:
            return ""
        return "## 可用技能（需要时按名载入，不要凭印象照做）\n" + "\n".join(
            s.brief() for s in picked)

    def load(self, names: list[str], *, budget_tokens: int | None = None) -> str:
        """载入若干 skill 正文。超预算就截断并明说截了 —— 悄悄少载入一条规程，
        产物会以看不出来的方式变差。"""
        out: list[str] = []
        spent = 0
        dropped: list[str] = []
        for n in names:
            s = self._skills.get(n)
            if s is None:
                continue
            if budget_tokens is not None and spent + s.tokens > budget_tokens:
                dropped.append(n)
                continue
            out.append(s.render())
            spent += s.tokens
        if dropped:
            out.append(f"〔注意：因上下文预算不足，未载入技能 {'、'.join(dropped)}〕")
        return "\n\n".join(out)

    def select(self, task: str, *, limit: int = 3) -> list[str]:
        """按任务文本挑相关 skill。

        词元重叠 + tag 命中，故意做得简单：**skill 选错的代价远小于选不到**，
        而复杂的选择器本身会引入难以调试的失败模式。
        """
        q = set(_tok(task))
        if not q:
            return []
        scored: list[tuple[float, str]] = []
        for s in self._skills.values():
            hay = set(_tok(f"{s.name} {s.description} {s.when_to_use} {' '.join(s.tags)}"))
            if not hay:
                continue
            overlap = len(q & hay)
            if overlap:
                scored.append((overlap / len(q | hay), s.name))
        scored.sort(key=lambda p: -p[0])
        return [n for _, n in scored[:limit]]

    # ── 磁盘 ────────────────────────────────────────────────────
    @classmethod
    def from_dir(cls, root: Path | str) -> SkillLibrary:
        """从目录载入 markdown skill。每个 ``*.md`` 一个 skill。

        格式：H1 是名字，紧随其后的引用块是 description，``## 何时用`` /
        ``## 步骤`` / ``## 完成判据`` 三节。
        """
        lib = cls()
        for p in sorted(Path(root).glob("*.md")):
            lib.register(parse_skill_md(p.read_text(encoding="utf-8"), fallback=p.stem))
        return lib


def _tok(text: str) -> list[str]:
    return [t.lower() for t in re.findall(r"[a-zA-Z]+|[㐀-鿿]", text or "")]


_SECTION = re.compile(r"^##\s+(.+?)\s*$", re.MULTILINE)


def parse_skill_md(text: str, *, fallback: str = "skill") -> Skill:
    name = (
        m.group(1).strip()
        if (m := re.search(r"^#\s+(.+)$", text, re.MULTILINE))
        else fallback
    )
    desc = (
        m.group(1).strip()
        if (m := re.search(r"^>\s*(.+)$", text, re.MULTILINE))
        else ""
    )

    sections: dict[str, str] = {}
    marks = list(_SECTION.finditer(text))
    for i, mk in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        sections[mk.group(1).strip()] = text[mk.end():end].strip()

    checklist = tuple(
        line.strip(" -[]x").strip()
        for line in sections.get("完成判据", "").splitlines()
        if line.strip().startswith(("- ", "* ", "- ["))
    )
    return Skill(
        name=name, description=desc,
        when_to_use=sections.get("何时用", ""),
        procedure=sections.get("步骤", ""),
        checklist=tuple(c for c in checklist if c),
        tools=tuple(t.strip() for t in sections.get("工具", "").split("、") if t.strip()),
    )


# ══════════════════════════════════════════════════════════════════
#  本体建模的内置技能
# ══════════════════════════════════════════════════════════════════
BUILTIN_SKILLS = [
    Skill(
        name="口径对齐",
        description="同名字段在多处出现且口径不一致时，判定差在哪个轴上并给出处置选项",
        when_to_use="发现两处对同一个字段的定义不同，或字段名相同但描述里出现"
                    "含税/不含税、年度/单次、计划/执行这类限定词",
        procedure="""口径不是自由文本，它由若干正交的轴构成。逐轴比对，不要读两段中文
凭感觉判断"像不像"。

1. 对每一处定义，抽出四个轴的取值：**税**（含税/不含税）、**时间粒度**
   （年度累计/单次/月度）、**口径主体**（计划/执行）、**币种**。
2. 只比对**两边都识别出来**的轴。一边缺失不是矛盾，是信息缺失 —— 那走
   MISSING_REQUIRED，不走口径冲突。
3. 有轴冲突时给出四个选项，每个都必须附证据出处：
   拆成两个属性 / 统一为 A / 统一为 B / 转为模板中的业务必填项。
4. **绝不自行裁决。** 口径是业务事实，统一哪个口径会丢信息，必须人拍板。""",
        checklist=("每处口径都标出了它来自哪个文件的哪个位置",
                   "指出了具体差在哪个轴上，而不是笼统说不一致",
                   "四个选项都给了，且都能点回原文",
                   "没有替业务方选择口径"),
        tools=("evidence.search",),
        tags=("口径", "冲突", "金额", "含税"),
    ),
    Skill(
        name="ActionType反推",
        description="没人填 ActionType 时，从 OpenAPI 写操作端点反推草稿让业务确认",
        when_to_use="梳理表里 ActionType 一栏是空的，但材料里有 OpenAPI 或接口清单",
        procedure="""让业务方从"改"开始比从"写"开始完成率高得多，这是这一步的全部理由。

1. 只看**写操作**端点（POST/PUT/PATCH/DELETE）。GET 是读，不改变世界状态，
   不是 Action。
2. 按 camelCase 拆词匹配端点与对象。物理名与业务名混用是常态，整串比对基本
   匹配不上。
3. 每条草稿标 `DRAFT_FROM_API`，并带上端点的 JSON Pointer 作为出处。
4. **聚合成一个决策问题**，不要每个对象问一次 —— 23 个对象缺 ActionType 时，
   "要不要反推"是一次决策，逐个问会瞬间耗尽 FDE 的耐心。
5. 草稿未经确认不算数，这一点要在模板里写清楚。""",
        checklist=("只用了写操作端点", "每条草稿都能点回 OpenAPI 的具体位置",
                   "标了 DRAFT_FROM_API", "聚合成了一个问题而不是 N 个"),
        tools=("evidence.search",),
        tags=("action", "openapi", "端点", "草稿"),
    ),
    Skill(
        name="命名归一",
        description="把各种命名风格归一成 lowerCamelCase，并识别哪些不能自动改",
        when_to_use="apiName 出现下划线、中文、大驼峰或未登记缩写",
        procedure="""能自动修的只有**可逆、零语义损失、可完整记账**的那部分。

1. `plan_amount` → `planAmount`，`Plan Amount` → `planAmount`：可自动修。
2. **中文名不自动改。** 机器给的音译或直译几乎一定不是业务方想要的术语，
   要留给人填，并在模板里标黄。
3. 三个字符以内的缩写除非在术语表里登记过，否则标为存疑，不自动展开。
4. 每次自动修都要留下 `from → to` 的账，并标 `AUTO_REPAIRED`，可一键回滚。""",
        checklist=("自动修的都是可逆的", "中文名没有被机器直译",
                   "每处修改都有记账", "未登记的缩写被标出而不是猜着展开"),
        tags=("命名", "camelcase", "规范"),
    ),
    Skill(
        name="实体对齐",
        description="判断多份材料里的不同名字是否指同一个业务概念",
        when_to_use="同一个概念在梳理表、DDL、OpenAPI 里有不同的名字",
        procedure="""`采购需求计划` / `pbpHeader` / `PurchasePlan` 常常是同一个东西。

1. 先做**结构证据**：主键类型是否一致、字段集合重叠率、行数量级是否接近。
   结构证据比名字相似度可靠得多。
2. 再做**名称证据**：camelCase 拆词后的词元重叠、编辑距离、术语表里的已知别名。
3. 两类证据都指向同一结论才合并；只有名字像、结构对不上的，**标为存疑交人判**，
   不要合并 —— 错误合并会把两个对象的属性混在一起，后面极难拆开。
4. 合并后选代表：`apiName` 取有 DDL 支撑的物理名，`displayName` 取业务表述，
   其余进 aliases。""",
        checklist=("用了结构证据不只看名字", "存疑的没有被强行合并",
                   "别名都保留在 aliases 里", "代表名的选择有依据"),
        tools=("evidence.search", "oir.query", "profile.column"),
        tags=("对齐", "去重", "别名", "实体"),
    ),
    Skill(
        name="回传审核",
        description="审业务方填回来的模板，算完成度并按责任人生成打回单",
        when_to_use="收到业务方回传的填写模板",
        procedure="""1. 按隐藏的 `_oir_rid` 锚点对齐。业务方会打乱行序、插行、删行，
   按行号对齐必然错位。
2. 用 `_oir_hash` 判断每格有没有被动过。**AI 预填被原样交回 = 这格没被审过**，
   不算已填 —— 不抓这个，整个往返闭环就是自欺欺人。
3. 规则先行：必填缺失、枚举越界、命名违规、引用完整性。秒级、零成本、零方差。
4. 只有口径矛盾和疑似敷衍才交模型，且先用启发式收窄候选。
5. 完成度按字段加权算（主键 > 口径 > 描述 > 备注），且**只统计业务必填格** ——
   把系统自己填好的算进去会让数字虚高，而 FDE 要靠这个数字决定要不要再发一轮。
6. 打回单按**责任人**分组。打回给"团队"等于打回给没有人。""",
        checklist=("按锚点对齐而不是行号", "抓出了原样交回的预填",
                   "能规则化的没交给模型", "完成度只算业务必填格",
                   "打回单落到了具体的人"),
        tags=("回传", "审核", "打回", "完成度"),
    ),
    Skill(
        name="访谈盘点",
        description="在进场前盘清业务边界、参与角色、系统和可验证的成功标准",
        when_to_use="FDE 刚进场、换了流程负责人，或新一轮访谈尚未建立范围基线时",
        procedure="""1. 用一句话写清本轮要解决的业务结果，同时列明确的范围外事项。
2. 建立干系人表：流程负责人、步骤执行人、数据负责人、ERP 顾问、
   审批人与最终验收人；不要把“业务部门”当作一个人。
3. 盘点每个环节使用的系统、模块、表单/接口、权威数据源及已有材料。
4. 把业务方的陈述分成已知事实、待验证假设、未知项；每条事实挂证据。
5. 约定验收产物、决策权归属、问题回复时限与下一次访谈节点。""",
        checklist=("范围内、范围外和成功标准都可被验收",
                   "每个关键角色都落到具体负责人或明确待定",
                   "已知事实有证据，假设与事实没有混写",
                   "已记录决策权、回复时限和验收人"),
        tools=("evidence.search", "evidence.rows", "oir.query"),
        tags=("FDE", "访谈", "范围", "干系人", "intake"),
    ),
    Skill(
        name="缺口追问路由",
        description="把流程、数据、规则与系统缺口变成可回答、可排序、可指派的问题清单",
        when_to_use="已有初版流程或本体草稿，需要决定下一轮问谁、问什么、先问哪些时",
        procedure="""1. 用结构完整性检查缺口：触发、前置条件、执行人、输入、输出、分支条件、
   异常、时限、权限、系统落点和证据。
2. 一个问题只解一个决策。把“请补充流程”改写成带上下文、字段约束与
   2~4 个有证据选项的可回答问题。
3. 按下游阻塞度、影响范围、不可逆性和证据缺口排序；不按“模型最好奇”排序。
4. 路由到有决策权的角色，指定负责人、截止时间、预期回答结构和被阻塞产物。
5. 小批次提问：每次先提交能解锁最多下游的问题；已回答、已延后和已取消的
   问题保留决策记录，不重复问。""",
        checklist=("每个问题只对应一个可记录的决策",
                   "问题带来源证据、影响范围和被阻塞产物",
                   "负责角色、负责人、优先级和回答 schema 都已声明",
                   "当前批次的每个问题都能解锁一项下游工作"),
        tools=("evidence.search", "oir.query"),
        tags=("缺口", "追问", "问题清单", "路由", "HITL"),
    ),
    Skill(
        name="流程建模",
        description="把访谈和材料拆成有参与者、网关、异常与证据的可验证流程图",
        when_to_use="需要从业务陈述中建立现状/目标流程，或现有流程只有顺序步骤没有语义时",
        procedure="""1. 分开 AS-IS 与 TO-BE；未被确认的改进建议不得写成现状事实。
2. 对每个步骤记录稳定 ID、动作、执行角色、触发、前置条件、输入/输出 DataObject、
   使用系统、时限与证据。
3. 显式建模排他/并行分支、回退、取消、超时和人工介入；不把异常塞进备注。
4. 为每条连线标明事件或条件，并检查开始、正常终止与异常终止可达。
5. 输出结构化流程和可视化图；图与 JSON 共用同一组 ID，不维护两份真相。""",
        checklist=("AS-IS 和 TO-BE 没有混写",
                   "每个步骤都有角色、输入输出、系统和证据",
                   "分支、回退、超时和异常路径被显式建模",
                   "图与结构化输出使用相同的稳定 ID"),
        tools=("evidence.search", "evidence.rows", "oir.query"),
        tags=("流程", "BPMN", "步骤", "游道", "分支", "异常"),
    ),
    Skill(
        name="ERP映射",
        description="将业务步骤和对象对齐到 ERP 模块、业务对象、交易和字段",
        when_to_use="流程涉及 SAP、Oracle、用友、金蝶或其他 ERP，需要识别标准能力与客制落点时",
        procedure="""1. 先确认产品、版本、模块、组织范围与系统别名；不用“ERP 一般如此”代替证据。
2. 对每个流程步骤建立映射：业务能力 → 模块/交易/接口 → ERP 对象/表/字段。
3. 标准、配置、增强、客制与外部系统映射分类；不确定的映射标注置信度。
4. 记录组织层级、主数据键、编码转换、单位/币种/时区转换和同步方向。
5. 将缺版本、缺字段定义、不能证实的客制逻辑路由给 ERP 顾问，不自行补全。""",
        checklist=("每条映射都声明产品版本和组织范围",
                   "步骤、ERP 能力、对象与字段可相互追溯",
                   "标准、配置、增强、客制与外部落点已区分",
                   "低置信映射已转成指派给 ERP 顾问的问题"),
        tools=("evidence.search", "evidence.rows", "oir.query", "profile.column"),
        tags=("ERP", "SAP", "Oracle", "用友", "金蝶", "字段映射"),
    ),
    Skill(
        name="规则结构化",
        description="把散文政策和专家口径转成可判定、可溯源、可测试的 Rules",
        when_to_use="材料或访谈出现应当、不得、只有、必须、超过、按公式计算等约束时",
        procedure="""1. 把复合句拆成原子规则，每条只有一个可判定结果。
2. 声明规则类型、触发事件、适用对象、前置条件、逻辑表达式、执行结果、
   优先级、例外和生效期。
3. 用决策表检查重叠、缺口与冲突；法规、集团政策和本地口径分开记录优先级。
4. 每条规则绑定 Action/Event/DataObject 稳定 ID 与原文证据；未绑定的产生缺口问题。
5. 为正例、边界、反例与例外分别给出验收用例，不将不可判定的目标写成规则。""",
        checklist=("每条规则是原子的且有可判定结果",
                   "触发、条件、结果、例外和生效期已声明",
                   "规则可追溯到本体 ID 与原文证据",
                   "正例、边界、反例和例外均有验收用例"),
        tools=("evidence.search", "evidence.rows", "oir.query"),
        tags=("规则", "决策表", "DMN", "条件", "例外", "rule"),
    ),
    Skill(
        name="数据对象治理",
        description="定义 DataObject 的身份、生命周期、数据质量、敏感性和系统权威",
        when_to_use="流程已识别输入输出，但对象定义、主键、状态、责任人或权威源不完整时",
        procedure="""1. 区分业务对象、单据、主数据、事务数据和派生数据；不按表名一对一造对象。
2. 为对象记录业务键、属性、类型/单位、基数、状态机、创建/更新事件与保留周期。
3. 标明 System of Record、复制系统、同步方向、新鲜度 SLA、数据负责人和消费者。
4. 对完整性、唯一性、有效性、一致性与及时性声明可执行规则，不只写“数据质量高”。
5. 标记个人/敏感数据、最小访问角色、脱敏与保留政策；无证据的分类转问题。""",
        checklist=("对象不是从数据库表名机械复制而来",
                   "业务键、状态机、权威源、负责人和生命周期已声明",
                   "数据质量规则是可计算、可告警的",
                   "敏感性、最小访问范围和保留政策有证据"),
        tools=("evidence.search", "evidence.rows", "oir.query", "profile.column"),
        tags=("DataObject", "数据治理", "主数据", "数据质量", "敏感"),
    ),
    Skill(
        name="交付审查",
        description="在交付前审查流程、本体、问题决策、证据和可下载产物的一致性",
        when_to_use="准备向 FDE、业务负责人或 ERP 顾问提交阶段产物之前",
        procedure="""1. 先运行确定性检查：JSON Schema、引用完整性、稳定 ID、重名、悬空边、状态可达性。
2. 从流程步骤双向追踪 Action、Event、DataObject、Rule 和 ERP 映射；检查可视化图与 JSON 数量、ID 一致。
3. 抽样核验证据引用，区分已确认事实、推断、未回答缺口与已延后项。
4. 检查决策记录是否有决策人、时间、原问题、回答、影响范围和被取代版本。
5. 按 blocking / warning / accepted-risk 生成交付门报告；只有 blocking 为零且必需产物
   可打开、可下载时才建议通过。""",
        checklist=("Schema、引用、稳定 ID 和流程可达性检查已通过",
                   "流程图与 Action/Event/DataObject/Rule JSON 可双向追踪",
                   "推断、未回答问题和已接受风险均未伪装成事实",
                   "每个阻断项有责任人，所有交付件均可打开和下载"),
        tools=("evidence.search", "evidence.rows", "oir.query"),
        tags=("交付", "审查", "验收", "追溯", "质量门"),
    ),
]


def default_library() -> SkillLibrary:
    return SkillLibrary(list(BUILTIN_SKILLS))
