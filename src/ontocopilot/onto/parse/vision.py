"""扫描件与 PDF 解析 —— 用视觉模型做 OCR。

扫描件是本体建模里最难的一类材料：ER 图、手绘表格、拍照的纸质台账。传统 OCR
只出文字流，丢掉版式和框线关系；而 ER 图里**框与框之间的连线就是 LinkType**，
丢了关系就等于什么都没读到。

所以这里让视觉模型直接输出**结构化的版式结果**：文本块、表格、实体框、连线，
每项带归一化 bbox。bbox 让每条断言都能点回图上的确切位置 —— 与其它格式一样，
没有 locator 的结论在这个产品里没有价值。

**能力是硬要求，不做降级。** 没有具备 VISION 的模型时直接报错，而不是退回到
"凭文件名猜内容" —— 后者会产出一份看起来正常、实际全是编的结果。
"""

from __future__ import annotations

import asyncio
import base64
import io
from pathlib import Path
from typing import Any

from ...kernel.catalog import Capability
from .base import Finding, ParsedDoc, Parser, make_chunk

#: 送进模型前的长边上限。再大不会更准，只会更贵 —— 当前一代视觉模型的
#: 有效分辨率大约到这个量级。
MAX_EDGE = 2000

#: PDF 渲染倍率。2.0 对应约 144 DPI，中文小字够认。
PDF_ZOOM = 2.0

OCR_SCHEMA = {
    "type": "object",
    "required": ["blocks", "tables", "relations"],
    "properties": {
        "blocks": {
            "type": "array",
            "description": "页面上的文本块，按阅读顺序",
            "items": {
                "type": "object",
                "required": ["text", "bbox", "kind"],
                "properties": {
                    "text": {"type": "string"},
                    "kind": {"type": "string",
                             "enum": ["title", "entity_box", "field", "note", "paragraph"]},
                    "bbox": {"type": "array", "items": {"type": "number"},
                             "description": "归一化 [x0,y0,x1,y1]，取值 0~1"},
                },
            },
        },
        "tables": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["rows", "bbox"],
                "properties": {
                    "caption": {"type": "string"},
                    "rows": {"type": "array",
                             "items": {"type": "array", "items": {"type": "string"}}},
                    "bbox": {"type": "array", "items": {"type": "number"}},
                },
            },
        },
        "relations": {
            "type": "array",
            "description": "实体框之间的连线。ER 图里这些就是 LinkType。",
            "items": {
                "type": "object",
                "required": ["from_entity", "to_entity"],
                "properties": {
                    "from_entity": {"type": "string"},
                    "to_entity": {"type": "string"},
                    "label": {"type": "string", "description": "线上的标注，如 1:N"},
                },
            },
        },
    },
}

OCR_SYSTEM = """你是版式识别器。把图片里的内容原样读出来，输出结构化结果。

规则：
- **原样转录**，不要翻译、不要补全、不要纠正你认为写错的地方。看不清的字用 ⿰ 代替。
- bbox 用归一化坐标 [x0,y0,x1,y1]，左上为原点，取值 0~1。
- ER 图里的方框是 entity_box，框内字段是 field，框之间的连线进 relations。
- 连线上的基数标注（1:N、1..*、多对多）一定要读进 relations.label —— 那是建模的关键信息。
- 表格进 tables，第一行按表头处理。
- 图里没有的东西一个字都不要加。"""


class VisionParser(Parser):
    """扫描件 / 图片 / PDF。

    Args:
        gateway: :class:`~ontocopilot.kernel.catalog.SmartGateway`。
            按 VISION 能力选型并在失败时自动换模型。
        prefer: ``quality`` 或 ``cost``。整本扫描件 PDF 用 ``cost``（几十页
            × 旗舰模型会很贵），关键的 ER 图用 ``quality``。
        max_pages: PDF 最多处理多少页。超出的页会在 findings 里明说 ——
            **不静默截断**。
    """

    kind = "scan"
    extensions = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".pdf")

    def __init__(self, gateway: Any = None, *, prefer: str = "quality",
                 max_pages: int = 20, node_id: str = "PARSE.scan") -> None:
        self.gateway = gateway
        self.prefer = prefer
        self.max_pages = max_pages
        self.node_id = node_id

    def parse(self, path: Path, *, file_id: str) -> ParsedDoc:
        raise RuntimeError(
            f"{path.name} 需要视觉模型识别，请用 aparse()（异步）。"
            "同步入口不支持 —— 悄悄跳过扫描件会让产物少掉一整个来源。")

    async def aparse(self, path: Path, *, file_id: str) -> ParsedDoc:
        doc = ParsedDoc(file_id=file_id, file_name=path.name, kind=self.kind)
        if self.gateway is None:
            # 上传时这条路是**故意**不带视觉网关的：识别要调模型、要花钱，不该由
            # "拖了个文件进来"触发，留到梳理时做。以前这里一律报"没有配置视觉网关"，
            # 读起来像配置坏了 —— 用户会去查网关，而其实什么都没坏，只是还没到时候。
            doc.findings.append(Finding(
                "vision_pending",
                f"{path.name} 是图片/扫描件，要用视觉模型识别。**点「开始梳理」时"
                f"才会识别**（识别要调模型），现在只登记了文件、还没读内容。",
                {}, severity="info"))
            return doc

        pages = render_pages(path, max_pages=self.max_pages)
        if len(pages) == self.max_pages:
            doc.findings.append(Finding(
                "page_limit", f"只识别了前 {self.max_pages} 页，其余未处理", {},
                severity="warn"))

        order = 0
        all_relations: list[dict[str, Any]] = []
        for pno, data_uri in enumerate(pages, start=1):
            # 视觉调用必须**有超时、且失败不炸整条 build**。否则网关上没有可用视觉模型
            # （require 抛错）或调用卡住时，PARSE 会一直挂在这里 —— 界面上就是「一直
            # 正在梳理」，而根因（没有视觉模型）被埋在一个永不返回的 await 里。
            try:
                comp = await asyncio.wait_for(
                    self.gateway.call(
                        self.node_id,
                        f"识别第 {pno} 页的全部内容。",
                        needs={Capability.VISION, Capability.STRUCTURED},
                        prefer=self.prefer, system=OCR_SYSTEM, schema=OCR_SCHEMA,
                        max_tokens=8000, images=[data_uri], key=f"ocr:p{pno}"),
                    timeout=150)
            except Exception as exc:  # noqa: BLE001 — 视觉失败如实登记，不拖垮/卡住 build
                why = "网关上没有可用的视觉模型" if isinstance(exc, LookupError) \
                    else ("视觉识别超时" if isinstance(exc, asyncio.TimeoutError)
                          else f"视觉识别失败（{type(exc).__name__}）")
                doc.findings.append(Finding(
                    "vision_failed",
                    f"扫描件第 {pno} 页{why}。请在网关上确认有带视觉的模型"
                    f"（gemini-* / gpt-4o / claude-3 等），这份材料的内容没有进入产物。",
                    {}, severity="warn"))
                break   # 一页就失败，后面多半也一样 —— 别把超时乘以页数
            page = comp.data or {}

            for b in page.get("blocks", ()):
                text = (b.get("text") or "").strip()
                if not text:
                    continue
                doc.chunks.append(make_chunk(
                    doc_id=f"p{pno}b{order}", file_id=file_id, file_name=path.name,
                    locator={"kind": "page", "page": pno,
                             "bbox": _bbox(b.get("bbox")), "role": b.get("kind", "")},
                    render=f"〔{b.get('kind', 'text')}〕{text}",
                    raw=b, order=order,
                    tags=["ocr", b.get("kind", "paragraph")]))
                order += 1

            for ti, t in enumerate(page.get("tables", ())):
                rows = t.get("rows") or []
                if not rows:
                    continue
                header, body = rows[0], rows[1:]
                for ri, row in enumerate(body):
                    doc.chunks.append(make_chunk(
                        doc_id=f"p{pno}t{ti}r{ri}", file_id=file_id, file_name=path.name,
                        locator={"kind": "page", "page": pno,
                                 "bbox": _bbox(t.get("bbox")), "table": ti, "row": ri + 1},
                        render=" | ".join(f"{header[i]}={v}" for i, v in enumerate(row)
                                          if i < len(header) and v),
                        raw={"header": header, "row": row}, order=order,
                        tags=["ocr", "table"]))
                    order += 1

            for r in page.get("relations", ()):
                label = r.get("label", "")
                all_relations.append({**r, "page": pno})
                doc.chunks.append(make_chunk(
                    doc_id=f"p{pno}rel{order}", file_id=file_id, file_name=path.name,
                    locator={"kind": "page", "page": pno, "bbox": [0, 0, 1, 1]},
                    render=f"〔关系〕{r.get('from_entity')} —{label}— {r.get('to_entity')}"
                           + ("　（图中标注的基数，可作 LinkType 依据）" if label else ""),
                    raw=r, order=order, tags=["ocr", "relation", "rule"]))
                order += 1

        doc.structured = {"pages": len(pages), "relations": all_relations,
                          "blocks": sum(1 for c in doc.chunks if "ocr" in c.tags)}
        if not doc.chunks:
            doc.findings.append(Finding(
                "empty_ocr", "视觉模型没有从这份材料里读出任何内容", {}, severity="warn"))
        else:
            # **识别成功也要明说。** 只在失败时说话，用户看到的是一片沉默 ——
            # 分不清"读出来了"和"又卡住了"。
            doc.findings.append(Finding(
                "vision_ok",
                f"已识别 {path.name}：{len(pages)} 页、{len(doc.chunks)} 段内容"
                + (f"、{len(all_relations)} 条连线关系" if all_relations else ""),
                {}, severity="info"))
        return doc


# ══════════════════════════════════════════════════════════════════
#  渲染
# ══════════════════════════════════════════════════════════════════
def render_pages(path: Path, *, max_pages: int = 20) -> list[str]:
    """把材料渲染成 base64 data URI 列表。PDF 逐页渲染，图片就是一页。"""
    if path.suffix.lower() == ".pdf":
        return _pdf_pages(path, max_pages)
    return [_image_uri(path)]


def _pdf_pages(path: Path, max_pages: int) -> list[str]:
    import fitz  # pymupdf

    out: list[str] = []
    with fitz.open(path) as pdf:
        for i, page in enumerate(pdf):
            if i >= max_pages:
                break
            pix = page.get_pixmap(matrix=fitz.Matrix(PDF_ZOOM, PDF_ZOOM))
            out.append(_downscale(pix.tobytes("png")))
    return out


def _image_uri(path: Path) -> str:
    return _downscale(path.read_bytes())


def _downscale(png_bytes: bytes) -> str:
    """按长边缩到上限。再大不会更准，只会更贵。"""
    from PIL import Image

    img = Image.open(io.BytesIO(png_bytes))
    if max(img.size) > MAX_EDGE:
        scale = MAX_EDGE / max(img.size)
        img = img.resize((int(img.width * scale), int(img.height * scale)),
                         Image.LANCZOS)
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def _bbox(raw: Any) -> list[float]:
    """归一化 bbox，坏值退回整页 —— 位置不准好过没有位置。"""
    try:
        vals = [max(0.0, min(1.0, float(x))) for x in (raw or [])][:4]
        return vals if len(vals) == 4 else [0.0, 0.0, 1.0, 1.0]
    except (TypeError, ValueError):
        return [0.0, 0.0, 1.0, 1.0]
