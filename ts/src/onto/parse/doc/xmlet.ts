/**
 * `xml.etree.ElementTree` 的最小等价物 —— **零依赖，手写**。
 *
 * 选型理由（bpmn/pptx 两个解析器都靠它）：
 *
 * 1. **不引第三方 XML 库。** 迁移期六个 track 并行改同一个 `package.json`，加依赖
 *    等于制造合并冲突；而且 fast-xml-parser / sax 之流给的都是"自己那一套"的树，
 *    Python 原件里到处是 `element.iter()` / `itertext()` / `attrib` 的精确语义，
 *    转译一层反而更容易错。
 * 2. **必须做命名空间展开。** `bpmn.py` 的 `_namespace(root.tag)` 直接进
 *    `doc.meta["namespace"]`，`presentation.py` 靠 `key.startswith("{")` 找
 *    `r:id` —— 两处都要求标签/属性名被展开成 ET 的 `{uri}local` 形态。前缀不展开，
 *    `p:sldIdLst` 里的 `r:id` 就找不到，**页码会退回按 slideN 猜**，于是
 *    "第 1 页"指向的是物理第一片而不是业务第一页。
 * 3. **text / tail 要与 ET 的 TreeBuilder 逐字一致。** `itertext()` 是把文本框、
 *    表格单元、documentation 拼回来的唯一途径；少一段 tail 就少一段材料。
 *
 * **不支持 DTD/ENTITY** —— 三个调用点都在解析前就按字节拒绝了含 DTD 的输入
 * （实体展开攻击），这里遇到直接抛，属于不可达分支的兜底。
 *
 * **只按 UTF-8 解码**。XML 声明里写别的编码不认，见 notes 的已知差异。
 */

/** 与 `ET.ParseError` 对齐：`position` 是 (行, 列)，bpmn 的 parse_failed 用它做 locator。
 *
 * 行列号来自本解析器自己的扫描位置，**与 expat 不是同一个基准** —— 消息文案也不同。
 * 这是引擎差异，钉在测试里而不是假装一致。 */
export class XmlParseError extends Error {
  readonly position: readonly [number, number];

  constructor(message: string, line: number, column: number) {
    super(`${message}: line ${line}, column ${column}`);
    this.name = "XmlParseError";
    this.position = [line, column];
    Object.setPrototypeOf(this, XmlParseError.prototype);
  }
}

/** 一个元素。字段名照搬 ET —— 移植时逐行对照的成本比"起个 TS 味的名字"低得多。 */
export interface XElement {
  /** 展开后的名字：有命名空间时是 `{uri}local`，否则就是 `local`。 */
  readonly tag: string;
  /** 属性，**保持文档顺序**（bpmn 的 `node.attributes` 直接由它派生）。 */
  readonly attrib: Record<string, string>;
  text: string | null;
  tail: string | null;
  readonly children: XElement[];
}

const XML_NS = "http://www.w3.org/XML/1998/namespace";

/** == Python 两个模块里各写一遍的 `_local(tag)`。 */
export function localName(tag: string): string {
  const afterBrace = tag.slice(tag.lastIndexOf("}") + 1);
  return afterBrace.slice(afterBrace.lastIndexOf(":") + 1);
}

/** == `bpmn.py` 的 `_namespace(tag)`：只有 `{uri}local` 形态才有命名空间。 */
export function namespaceOf(tag: string): string {
  if (!tag.startsWith("{")) return "";
  const close = tag.indexOf("}");
  return close < 0 ? "" : tag.slice(1, close);
}

/** == `Element.iter()`：**先自己再子树**的文档序，包含 element 本身。 */
export function* iterElements(element: XElement): Generator<XElement> {
  yield element;
  for (const child of element.children) yield* iterElements(child);
}

/** == `Element.itertext()`：自身 text + 每个子树的 itertext + 该子元素的 tail。
 *  注意**不含 element 自己的 tail** —— 这条在 `_notes_text` 里是有意义的。 */
export function itertext(element: XElement): string {
  const out: string[] = [];
  const walk = (el: XElement): void => {
    if (el.text) out.push(el.text);
    for (const child of el.children) {
      walk(child);
      if (child.tail) out.push(child.tail);
    }
  };
  walk(element);
  return out.join("");
}

/** 后代里第一个 local name 匹配的（含自身）—— == `_first_descendant`。 */
export function firstDescendant(element: XElement, local: string): XElement | null {
  for (const node of iterElements(element)) {
    if (localName(node.tag) === local) return node;
  }
  return null;
}

/** 全部后代里 local name 匹配的（含自身）—— == `_descendants`。 */
export function descendants(element: XElement, local: string): XElement[] {
  return [...iterElements(element)].filter((node) => localName(node.tag) === local);
}

/** 直接子元素里 local name 匹配的。ET 的 `for child in element` 只走一层。 */
export function childrenNamed(element: XElement, local: string): XElement[] {
  return element.children.filter((child) => localName(child.tag) === local);
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
};

interface Frame {
  readonly element: XElement;
  /** 本层是否压过一层命名空间作用域。出栈时按它撤销。 */
  readonly pushedScope: boolean;
}

class Scanner {
  private i = 0;

  constructor(private readonly src: string) {}

  /** 造一个带行列的 ParseError。**返回**而不是抛：TS 只在调用点看得见 `throw`
   *  时才收窄控制流，写成 never-返回的方法会让每个调用点后面都多出一段死代码。
   *  行列只在出错时才算 —— 正常路径上一个字符都不多扫。 */
  fail(message: string, at = this.i): XmlParseError {
    let line = 1;
    let lastBreak = -1;
    for (let k = 0; k < at && k < this.src.length; k++) {
      if (this.src.charCodeAt(k) === 10) {
        line++;
        lastBreak = k;
      }
    }
    return new XmlParseError(message, line, at - lastBreak - 1);
  }

  atEnd(): boolean {
    return this.i >= this.src.length;
  }

  /** 吃掉直到下一个 `<`（或结尾）的字符数据，返回原文。 */
  takeCharData(): string {
    const at = this.src.indexOf("<", this.i);
    const raw = at < 0 ? this.src.slice(this.i) : this.src.slice(this.i, at);
    this.i += raw.length;
    return raw;
  }

  length(): number {
    return this.src.length;
  }

  peek(offset = 0): string {
    return this.src[this.i + offset] ?? "";
  }

  startsWith(s: string): boolean {
    return this.src.startsWith(s, this.i);
  }

  advance(n: number): void {
    this.i += n;
  }

  pos(): number {
    return this.i;
  }

  /** 跳到 `end` 之后并返回中间的内容；找不到就抛。 */
  takeUntil(end: string, what: string): string {
    const at = this.src.indexOf(end, this.i);
    if (at < 0) throw this.fail(`unterminated ${what}`);
    const body = this.src.slice(this.i, at);
    this.i = at + end.length;
    return body;
  }

  skipSpace(): void {
    while (!this.atEnd() && " \t\r\n".includes(this.peek())) this.i++;
  }

  /** XML Name：不做完整的 NameStartChar 校验，只排除结构字符。 */
  takeName(): string {
    const start = this.i;
    while (!this.atEnd() && !" \t\r\n/>=<".includes(this.peek())) this.i++;
    if (this.i === start) throw this.fail("expected a tag or attribute name", start);
    return this.src.slice(start, this.i);
  }
}

/** 解析实体与字符引用。未知实体**抛** —— 静默丢掉等于静默丢材料。 */
function decodeEntities(raw: string, scanner: Scanner, at: number): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#\d+|[^;&\s]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return String.fromCodePoint(parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) return String.fromCodePoint(parseInt(body.slice(1), 10));
    const named = NAMED_ENTITIES[body];
    if (named === undefined) throw scanner.fail(`undefined entity ${whole}`, at);
    return named;
  });
}

/**
 * == `ET.fromstring(data)`。
 *
 * 文本累积/落位完全照抄 CPython `TreeBuilder._flush`：缓冲区里的字符要么进
 * "刚开始的那个元素"的 text，要么进"刚结束的那个元素"的 tail，由一个 tail 标志决定。
 * 自己写一套"当前节点有没有孩子"的判断看起来等价，实际在
 * `<a>x<b/>y</a>` 这种混合内容上就会分岔。
 */
export function fromString(data: string | Uint8Array): XElement {
  const src = typeof data === "string"
    ? data
    : new TextDecoder("utf-8", { fatal: false }).decode(data);
  const scanner = new Scanner(src.charCodeAt(0) === 0xfeff ? src.slice(1) : src);

  const stack: Frame[] = [];
  const nsScope: Array<Map<string, string>> = [new Map([["xml", XML_NS]])];
  let root: XElement | null = null;
  let last: XElement | null = null;
  let inTail = false;
  let buffer = "";

  const flush = (): void => {
    if (buffer !== "" && last !== null) {
      if (inTail) last.tail = buffer;
      else last.text = buffer;
    }
    buffer = "";
  };

  const resolve = (prefix: string, isAttribute: boolean, at: number): string => {
    if (prefix === "" && isAttribute) return "";
    for (let k = nsScope.length - 1; k >= 0; k--) {
      const uri = nsScope[k]?.get(prefix);
      if (uri !== undefined) return uri;
    }
    if (prefix === "") return "";
    throw scanner.fail(`unbound prefix: ${prefix}`, at);
  };

  const qualify = (name: string, isAttribute: boolean, at: number): string => {
    const colon = name.indexOf(":");
    const prefix = colon < 0 ? "" : name.slice(0, colon);
    const local = colon < 0 ? name : name.slice(colon + 1);
    const uri = resolve(prefix, isAttribute, at);
    return uri === "" ? local : `{${uri}}${local}`;
  };

  while (!scanner.atEnd()) {
    if (scanner.peek() !== "<") {
      const at = scanner.pos();
      buffer += decodeEntities(scanner.takeCharData(), scanner, at);
      continue;
    }

    if (scanner.startsWith("<!--")) {
      scanner.advance(4);
      scanner.takeUntil("-->", "comment");
      continue;
    }
    if (scanner.startsWith("<![CDATA[")) {
      scanner.advance(9);
      buffer += scanner.takeUntil("]]>", "CDATA section");
      continue;
    }
    if (scanner.startsWith("<?")) {
      scanner.advance(2);
      scanner.takeUntil("?>", "processing instruction");
      continue;
    }
    if (scanner.startsWith("<!DOCTYPE") || scanner.startsWith("<!ENTITY")) {
      // 三个调用点都在解析前按字节拒了 DTD，这里只是兜底：绝不实现实体展开。
      throw scanner.fail("DTD/ENTITY declarations are refused");
    }

    if (scanner.startsWith("</")) {
      const at = scanner.pos();
      scanner.advance(2);
      const name = scanner.takeName();
      scanner.skipSpace();
      if (scanner.peek() !== ">") throw scanner.fail("expected '>' closing an end tag");
      scanner.advance(1);
      flush();
      const frame = stack.pop();
      if (frame === undefined) throw scanner.fail("unbalanced end tag", at);
      const expected = qualify(name, false, at);
      if (frame.element.tag !== expected) throw scanner.fail("mismatched tag", at);
      if (frame.pushedScope) nsScope.pop();
      last = frame.element;
      inTail = true;
      continue;
    }

    // 开始标签。
    const at = scanner.pos();
    scanner.advance(1);
    const name = scanner.takeName();
    const rawAttrs: Array<[string, string]> = [];
    const scope = new Map<string, string>();
    for (;;) {
      scanner.skipSpace();
      if (scanner.atEnd()) throw scanner.fail("unterminated start tag", at);
      if (scanner.peek() === ">" || scanner.startsWith("/>")) break;
      const attrAt = scanner.pos();
      const attrName = scanner.takeName();
      scanner.skipSpace();
      if (scanner.peek() !== "=") throw scanner.fail("expected '=' after attribute name", attrAt);
      scanner.advance(1);
      scanner.skipSpace();
      const quote = scanner.peek();
      if (quote !== '"' && quote !== "'") throw scanner.fail("expected a quoted attribute value");
      scanner.advance(1);
      const valueAt = scanner.pos();
      const value = decodeEntities(
        scanner.takeUntil(quote, "attribute value"), scanner, valueAt);
      if (attrName === "xmlns") {
        scope.set("", value);
      } else if (attrName.startsWith("xmlns:")) {
        scope.set(attrName.slice(6), value);
      } else {
        rawAttrs.push([attrName, value]);
      }
    }
    const selfClosing = scanner.startsWith("/>");
    scanner.advance(selfClosing ? 2 : 1);

    // xmlns 声明在**本元素自己的名字**上就生效，所以必须先入栈再展开。
    const pushedScope = scope.size > 0;
    if (pushedScope) nsScope.push(scope);
    const attrib: Record<string, string> = {};
    for (const [key, value] of rawAttrs) attrib[qualify(key, true, at)] = value;
    const element: XElement = {
      tag: qualify(name, false, at), attrib, text: null, tail: null, children: [],
    };

    flush();
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      if (root !== null) throw scanner.fail("junk after document element", at);
      root = element;
    } else {
      parent.element.children.push(element);
    }

    if (selfClosing) {
      if (pushedScope) nsScope.pop();
      last = element;
      inTail = true;
    } else {
      stack.push({ element, pushedScope });
      last = element;
      inTail = false;
    }
  }

  if (stack.length > 0) throw scanner.fail("no element found (unclosed tag)", scanner.length());
  if (root === null) throw scanner.fail("no element found", 0);
  return root;
}
