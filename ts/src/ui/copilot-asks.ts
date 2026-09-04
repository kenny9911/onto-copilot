// 界面上那些「让 Copilot 来做」按钮，预填进输入框的**原话**。
//
// ## 这些字符串是有功能的，不是文案
//
// 模型侧的知识库写操作要过一道意图闸（server/dialogue/document_tools.ts 的
// `explicitDocumentActions`）：整句话必须**全句匹配** `DOCUMENT_ACTION_COMMANDS`
// 里对应动作的正则，批量动作还要另外命中 `BATCH_QUANTIFIER` 的量词。
// 闸是全句锚定的（`^…$`），也就是说多一句寒暄、少一个「把」字都可能不匹配。
//
// 所以「把这 6 份材料存入知识库」不是一种说法，是**唯一能让这件事真的发生**的
// 那一种。改成「一键导入」「同步材料到知识库」都会让同一件事在人手上能做、
// 在模型手上做不了 —— 而用户会以为是 Copilot 不听话。
//
// ts/test/dialogue.copilot-asks.test.ts 把每一句都拿真闸跑了一遍。改这里的字，
// 那个测试会告诉你还过不过得去。
//
// ## 为什么是预填而不是直接发
//
// 和右栏那十来个引用按钮同一条纪律（context-sync.ts）：用户没审过的话，
// 不替他调用模型。这里尤其重要 —— 这些句子一旦发出去就会**改动知识库**。
// 预填让他看得见自己将要说什么，也能改。
//
// 这个文件保持零 import：它被 UI 组件和服务端测试两边引用。

/** 把这次会话里还没入库的材料一次性存进知识库。 */
export function askIngestAll(count: number): string {
  // 「这 N 份材料」同时满足 promote 的动词位和 BATCH_QUANTIFIER 的 `这\s*\d+\s*份`。
  return `请把这 ${count} 份材料存入知识库`;
}

/** 把一份指定的会话文件存进知识库。 */
export function askIngestOne(fileName: string): string {
  return `请把${fileName}保存到项目知识库`;
}

/** 把知识库里的一份材料固定到本次分析。 */
export function askAttach(title: string): string {
  return `请把${title}固定到本次分析`;
}

/** 归档当前选中的这份材料。 */
export function askArchive(): string {
  // manage_archive 的正则没有自由目标位，只吃 DOCUMENT_REF 那几种指代写法，
  // 所以这里只能说「这份文档」——它指的是用户当前选中的那一份。
  return "请归档这份文档";
}

/** 在知识库里查一件事。检索是只读的，不过意图闸；这句只是省得用户自己组织。 */
export function askSearch(topic: string): string {
  return `在项目知识库里查一下${topic}，把原文出处一起给我`;
}

/** 让 Copilot 看看现在的目录结构、提一份整理建议。 */
export function askOrganize(): string {
  // 只读工具（document.folders / document.list），不过意图闸。
  // 措辞刻意是「给我一份建议」而不是「帮我整理」：建目录和移动材料是人的动作，
  // 模型没有这两个工具（那是刻意的 —— 材料怎么归类是用户对自己东西的编排意图）。
  return "看一下知识库现在的文件夹结构和每份材料的位置，给我一份整理建议："
    + "该建哪些文件夹、哪份材料该放进哪个，说明理由。不要直接改，我确认后自己动手。";
}

/** 把一条结论记进项目知识（草稿，等人确认）。 */
export function askRemember(subject: string): string {
  return `把关于「${subject}」的结论记进项目知识，带上材料出处`;
}
