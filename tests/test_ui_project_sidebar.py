"""侧栏项目文件夹的前端契约测试。

UI 是单文件应用、没有打包步骤，所以分组逻辑只能把真实的 JS 抠出来喂给 Node 跑。
纯字符串比对只能证明"写法在那儿"，证明不了"分组分对了"——这里两种都用：
形状用断言钉，行为用 Node 跑。
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
UI = ROOT / "ui" / "index.html"


def _html() -> str:
    return UI.read_text(encoding="utf-8")


def _script(html: str) -> str:
    start = html.index("<script>", html.index("</head>")) + len("<script>")
    return html[start : html.index("</script>", start)]


def _sidebar_js() -> str:
    """侧栏分组那一段的真身：转义函数 + paintSessions/convRow/loadProjects 一族。

    ``UNFILED`` 那一行单独取：它和 ``PJ_OFF`` 声明在一起（文件顶上），不在
    paintSessions 这一段里。**取真身而不是在 harness 里抄一个** —— 抄的话哪天
    源码换了字面量，测试还会照着旧值绿。
    """
    script = _script(_html())
    escapers = script[script.index("const esc =") : script.index("const j = async")]
    unfiled = script[script.index("const UNFILED = ") :]
    unfiled = unfiled[: unfiled.index("\n") + 1]
    sidebar = script[
        script.index("function paintSessions(){") : script.index("function closePopMenu()")
    ]
    return escapers + "\n" + unfiled + "\n" + sidebar


_HARNESS = """
const API = "";
let MODE = "work", PROJECTS = [], PROJECTS_OK = true, SESSION_LIST = [], S = null;
let PJ_OFF = new Set();
let FETCHED = 0;
globalThis.localStorage = {setItem(){}, getItem(){ return null; }};
// t() 在这里退化成"回显 key"——这些测试关心的是分组结构，不是文案本身
const t = (k, f, v) => {
  let s = String(k);
  if (v) for (const x in v) s = s.split("{" + x + "}").join(String(v[x]));
  return s;
};
const statusText = s => String(s);
const fmtWhen = x => String(x);
const DOM = {convs: {innerHTML: ""}, pjnewBtn: {hidden: true}};
const $ = id => DOM[id];
__SIDEBAR__
"""


def _run(body: str) -> dict:
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is not installed")
    program = _HARNESS.replace("__SIDEBAR__", _sidebar_js()) + "\n" + body
    result = subprocess.run(
        [node, "-"], input=program, text=True, capture_output=True, check=False
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


# ══════════════════════════════════════════════════════════════════
#  R5：聊天模式完全不进项目
# ══════════════════════════════════════════════════════════════════
def test_chat_mode_never_shows_a_project_anywhere_in_the_sidebar() -> None:
    """R5 在前端的形态：聊天模式的侧栏是平铺的，一个项目痕迹都没有。

    执行点在 loadProjects 里（MODE 不是 work 就直接清空返回），而不是散在画的
    地方——只要漏判一处，聊天模式就会长出一个工作模式的文件夹。
    """
    out = _run(
        """
        MODE = "chat";
        PROJECTS = [{id:"p1", name:"客户A"}];   // 上一轮工作模式留下的残留
        SESSION_LIST = [{id:"s1", title:"闲聊", project_id:"p1", files:0, status:"ready"}];
        globalThis.fetch = () => { FETCHED++; throw new Error("聊天模式不该拉项目"); };
        loadProjects().then(() => {
          paintSessions();
          console.log(JSON.stringify({
            html: DOM.convs.innerHTML, projects: PROJECTS, fetched: FETCHED,
            newBtnHidden: DOM.pjnewBtn.hidden,
          }));
        });
        """
    )
    assert out["projects"] == []
    assert out["fetched"] == 0, "聊天模式还是发了 /api/projects"
    assert out["newBtnHidden"] is True
    for trace in ("pjgroup", "pjhead", "pjsec", "project.unfiled", "客户A",
                  "sessionMenu"):
        assert trace not in out["html"], f"聊天模式侧栏里出现了 {trace}"
    assert "闲聊" in out["html"], "会话本身还是要在的"


# ══════════════════════════════════════════════════════════════════
#  渐进部署：后端还没有 /api/projects 时不许白屏、不许弹错
# ══════════════════════════════════════════════════════════════════
def test_a_backend_without_projects_degrades_to_todays_flat_list() -> None:
    """前端可以先于后端上线，所以 404 必须是"没有项目"，不是"出错了"。

    这条同时钉住"不走 j()"：j() 对非 2xx 直接抛，还会在 401 时弹登录框——
    对一个旧后端来说那两件事都是错的反应。
    """
    out = _run(
        """
        MODE = "work";
        PROJECTS_OK = true;   // 先假装支持，看 404 之后有没有翻回去
        SESSION_LIST = [{id:"s1", title:"会话一", project_id:"", files:2, status:"done"}];
        globalThis.fetch = async () => ({ok:false, status:404, json: async () => ({})});
        loadProjects().then(() => {
          paintSessions();
          console.log(JSON.stringify({
            html: DOM.convs.innerHTML, ok: PROJECTS_OK, projects: PROJECTS,
            newBtnHidden: DOM.pjnewBtn.hidden,
          }));
        });
        """
    )
    assert out["ok"] is False
    assert out["projects"] == []
    assert out["newBtnHidden"] is True, "后端不支持时还露着「新建项目」"
    assert "pjgroup" not in out["html"]
    assert "会话一" in out["html"], "退化后会话列表还得在，不能白屏"


def test_load_projects_swallows_the_failure_instead_of_raising() -> None:
    """网络直接断（不是 404）也一样：安静退回平铺。"""
    out = _run(
        """
        MODE = "work";
        globalThis.fetch = async () => { throw new Error("boom"); };
        loadProjects().then(() => console.log(JSON.stringify(
          {ok: PROJECTS_OK, projects: PROJECTS})));
        """
    )
    assert out["ok"] is False and out["projects"] == []


# ══════════════════════════════════════════════════════════════════
#  分组本身
# ══════════════════════════════════════════════════════════════════
def test_sessions_are_grouped_under_their_project_with_unfiled_last() -> None:
    out = _run(
        """
        MODE = "work"; PROJECTS_OK = true;
        PROJECTS = [{id:"p1", name:"客户A"}, {id:"p2", name:"客户B"}];
        SESSION_LIST = [
          {id:"s1", title:"甲", project_id:"p1", files:1, status:"done"},
          {id:"s2", title:"乙", project_id:"p2", files:1, status:"done"},
          {id:"s3", title:"丙", project_id:"",   files:1, status:"done"},
        ];
        paintSessions();
        console.log(JSON.stringify({html: DOM.convs.innerHTML}));
        """
    )
    html = out["html"]
    assert html.index("客户A") < html.index("甲") < html.index("客户B")
    assert html.index("客户B") < html.index("乙") < html.index("project.unfiled")
    assert html.index("project.unfiled") < html.index("丙"), "未归类段必须在最后"


def test_a_session_pointing_at_an_unknown_project_falls_back_to_unfiled() -> None:
    """项目在别处被删掉、或干脆不属于我时，会话不能从侧栏凭空消失。

    宁可让它多在「未归类」里露一次面——用户找不到自己的会话，比看到一个多余
    的分组要难受得多。
    """
    out = _run(
        """
        MODE = "work"; PROJECTS_OK = true;
        PROJECTS = [{id:"p1", name:"客户A"}];
        SESSION_LIST = [{id:"s9", title:"孤儿会话", project_id:"不存在的项目",
                         files:0, status:"done"}];
        paintSessions();
        console.log(JSON.stringify({html: DOM.convs.innerHTML}));
        """
    )
    html = out["html"]
    assert "孤儿会话" in html
    assert html.index("project.unfiled") < html.index("孤儿会话")


def test_collapsing_a_project_hides_its_sessions_but_keeps_the_count() -> None:
    """折叠是纯重画，不该再跑一次网络请求；数字还得在，否则看不出里面有没有东西。"""
    out = _run(
        """
        MODE = "work"; PROJECTS_OK = true;
        PROJECTS = [{id:"p1", name:"客户A"}];
        SESSION_LIST = [{id:"s1", title:"甲", project_id:"p1", files:1, status:"done"}];
        globalThis.fetch = () => { throw new Error("折叠不该发请求"); };
        toggleProject("p1");
        console.log(JSON.stringify({html: DOM.convs.innerHTML, off: [...PJ_OFF]}));
        """
    )
    assert out["off"] == ["p1"]
    assert "甲" not in out["html"]
    assert "客户A" in out["html"]
    assert '<span class="pjn">1</span>' in out["html"], "折叠后看不出里面有几条"


def test_a_hostile_project_name_cannot_break_out_of_the_row() -> None:
    """项目名是自由文本，而这一行是拼进 innerHTML 的。

    行内的 onclick 只收项目 id（用 earg），名字只走文本位置（esc）——
    这条按浏览器的真实顺序验一遍：解码属性、再当 JS 编译。
    """
    out = _run(
        """
        MODE = "work"; PROJECTS_OK = true;
        PROJECTS = [{id:"p'1", name:"<img src=x onerror=alert(1)>"}];
        SESSION_LIST = [];
        paintSessions();
        const html = DOM.convs.innerHTML;
        // 属性里的 id：解码回 JS 源码，看那个撇号有没有劈开字面量
        const m = html.match(/toggleProject\\('([^"]*?)'\\)/);
        const decoded = m[1].replace(/&#39;/g, "'").replace(/&quot;/g, '"')
          .replace(/&amp;/g, "&");
        let got = null;
        const sink = x => { got = x; };
        eval("sink('" + decoded + "')");
        console.log(JSON.stringify({html, got}));
        """
    )
    assert out["got"] == "p'1", "项目 id 被转义弄坏了，或者根本没转义"
    assert "<img" not in out["html"], "项目名带的标签原样进了 innerHTML"
    assert "&lt;img" in out["html"]


# ══════════════════════════════════════════════════════════════════
#  文案
# ══════════════════════════════════════════════════════════════════
def test_project_keys_exist_in_both_dictionaries() -> None:
    """t() 缺 key 时**静默**回落到中文——漏了 en 的表现是英文界面冒出中文，不报错。"""
    script = _script(_html())
    zh, en = script.index("\n  zh: {"), script.index("\n  en: {")
    assert zh < en, "字典顺序变了，下面的切片就不对了"
    zh_block, en_block = script[zh:en], script[en:]
    en_block = en_block[: en_block.index("\n};")]
    for key in ("project.new", "project.namePrompt", "project.rename",
                "project.renamePrompt", "project.delete", "project.confirmDelete",
                "project.unfiled", "project.noUnfiled", "project.empty",
                "project.moveTo", "project.moveOut", "project.none", "project.failed"):
        assert f'"{key}"' in zh_block, f"zh 少了 {key}"
        assert f'"{key}"' in en_block, f"en 少了 {key}"


def test_deleting_a_project_spells_out_both_consequences() -> None:
    """「删除项目？」这四个字会造成两种反向的误判：不敢删（怕会话没了）、
    乱删（不知道项目记忆会一起没）。两件事都得写在确认框里。"""
    script = _script(_html())
    zh = script[script.index('"project.confirmDelete"'):][:400]
    assert "未归类" in zh and "不会被删除" in zh, "没说清会话会掉回未归类"
    assert "记忆" in zh and "不可恢复" in zh, "没说清项目记忆会一起删掉"
    en = script[script.index('"project.confirmDelete"', script.index("\n  en: {")):][:400]
    assert "Unfiled" in en and "not deleted" in en
    assert "memory" in en and "cannot be recovered" in en


def test_a_session_can_be_dragged_into_a_project() -> None:
    """拖拽是快路：侧栏里"把这个会话丢进那个文件夹"本来就是个空间操作。"""
    html, script = _html(), _script(_html())
    assert 'draggable="true"' in html
    for fn in ("function dragSession(", "function dragOver(",
               "async function dropOnProject(", "async function dropOnUnfiled("):
        assert fn in script, f"缺 {fn}"
    # 不 preventDefault 就永远不会触发 drop —— 这是拖拽最常见的"看着做了其实没生效"
    assert script.count("ev.preventDefault()") >= 3
    # 「未归类」也必须能放：只进不出的文件夹是个陷阱
    assert "dropOnUnfiled(event)" in html


def test_the_menu_path_survives_alongside_drag() -> None:
    """拖拽**不能**取代菜单。

    键盘操作、触屏、读屏软件都拖不动一个 div；项目折叠起来时也没有可视放置目标。
    加快路不等于可以拆掉唯一那条所有人都走得通的路。
    """
    html, script = _html(), _script(_html())
    assert "function sessionMenu(" in script
    assert "sessionMenu(event," in html


def test_the_drop_target_is_visible_while_dragging() -> None:
    """看不出会掉进哪儿的拖拽，用户第一次就不敢松手。"""
    html = _html()
    assert ".pjhead.dragover" in html and ".conv.dragging" in html


def test_a_project_can_start_its_own_session() -> None:
    """点项目上的 ＋，心智是「在这个文件夹里新建」，不该让他建完再自己搬一次。"""
    html, script = _html(), _script(_html())
    assert "newSessionIn(" in html
    body = script[script.index("async function newSessionIn(pid){"):]
    body = body[:body.index("\n}")]
    assert "newSession()" in body and "moveSession(" in body


def test_work_mode_shows_the_project_section_even_with_no_projects() -> None:
    """一个项目都没有时，侧栏**不能**和从前一模一样。

    真实反馈就是这么来的：功能做完了，用户打开看到的还是那张平铺列表，于是判定
    「还是没改」。零项目是新用户的**必经状态**，这个状态下没有入口，功能就等于
    不存在 —— 唯一的 ＋ 按钮既小又在拉不到接口时是 hidden 的。
    """
    js = _script(_html())
    body = js[js.index("function paintSessions"):]
    body = body[:body.index("\nfunction ")]

    # 平铺只允许发生在两种情况：聊天模式、或后端没有 /api/projects
    assert 'if (MODE !== "work" || !PROJECTS_OK)' in body
    # 零项目走的是「分区标题 + 可点击的新建入口 + 未归类」，不是平铺
    zero = body[body.index("if (!PROJECTS.length)"):]
    assert "project.section" in zero
    assert "project.createFirst" in zero
    assert "newProject()" in zero, "空态必须是个能点的东西，不是一行灰字"


def test_the_empty_state_entry_is_a_button_not_a_caption() -> None:
    html = _html()
    assert ".pjcreate{" in html
    assert 'class="pjcreate" onclick="newProject()"' in html


def test_the_new_empty_state_keys_exist_in_both_dictionaries() -> None:
    script = _script(_html())
    zh, en = script.index("\n  zh: {"), script.index("\n  en: {")
    zh_block, en_block = script[zh:en], script[en:]
    en_block = en_block[: en_block.index("\n};")]
    for key in ("project.section", "project.createFirst"):
        assert f'"{key}"' in zh_block, f"zh 少了 {key}"
        assert f'"{key}"' in en_block, f"en 少了 {key}"
