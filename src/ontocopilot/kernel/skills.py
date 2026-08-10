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
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

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


_SECTION = re.compile(r"^##\s+(.+?)\s*$", re.M)


def parse_skill_md(text: str, *, fallback: str = "skill") -> Skill:
    name = m.group(1).strip() if (m := re.search(r"^#\s+(.+)$", text, re.M)) else fallback
    desc = m.group(1).strip() if (m := re.search(r"^>\s*(.+)$", text, re.M)) else ""

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
]


def default_library() -> SkillLibrary:
    return SkillLibrary(list(BUILTIN_SKILLS))
