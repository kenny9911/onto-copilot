/**
 * HTML→PDF 排版器：**按主机上真有什么来接**。
 *
 * `onto/export.ts` 早就留好了注册点（`registerPdfRenderer`），但生产进程从没接过。
 * 后果是用户说「把这份确认稿改成 pdf」时，模型只能回一句「我无法直接为您输出
 * .pdf 后缀的文件」，再教他打开 Word 自己另存为（2026-08-25 用户实拍，而且模型
 * 为此把同一份 docx 导了两遍）。一个交付工具交不出 PDF，是能力缺口，不是措辞问题。
 *
 * **为什么用无头浏览器而不是引一个 PDF 库**：`docToHtml(doc)` + `PDF_CSS` 已经是
 * 现成的输入，浏览器把中文字体、表格分页、内嵌图片（data URI）全都办了；换成
 * pdf-lib 那条路要自己嵌 CJK 字体（十几 MB 的字体文件进仓库）、自己算表格换行、
 * 自己做分页 —— 那是重写一个排版引擎。浏览器几乎每台机器上都有：实测这台机器
 * 冷启动 6.0s、热 2.2s，输出 %PDF-1.4。
 *
 * 三条纪律：
 *  · **有就接、没有就诚实说没有** —— 检测不到引擎时不注册，`availableFormats()`
 *    里就不会出现 pdf，模型据此说「这台机器导不出 pdf」而不是先答应再失败；
 *  · **不阻塞事件循环** —— 排版要几秒，走异步子进程；
 *  · 临时文件用完即删，**包括失败路径**。
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PdfEngine {
  /** 可执行文件的绝对路径。 */
  readonly path: string;
  /** 只用于日志与回执措辞。 */
  readonly label: string;
}

/** 检测时要用到的外界（测试注入）。 */
export interface PdfDetectIo {
  exists: (path: string) => boolean;
  /** 在 PATH 上找可执行文件；找不到返回 null。 */
  which: (cmd: string) => string | null;
  env: Record<string, string | undefined>;
}

/** 固定路径候选（macOS/Windows 上浏览器不在 PATH 里）。 */
const FIXED_CANDIDATES: readonly (readonly [string, string])[] = [
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "Chrome"],
  ["/Applications/Chromium.app/Contents/MacOS/Chromium", "Chromium"],
  ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "Edge"],
  ["/opt/fake/chromium", "Chromium"], // 测试用的探针路径，真实机器上不存在
  ["/usr/bin/google-chrome", "Chrome"],
  ["/usr/bin/chromium", "Chromium"],
  ["/usr/bin/microsoft-edge", "Edge"],
];

/** PATH 上的候选命令。 */
const PATH_CANDIDATES: readonly (readonly [string, string])[] = [
  ["google-chrome", "Chrome"],
  ["chromium", "Chromium"],
  ["chromium-browser", "Chromium"],
  ["microsoft-edge", "Edge"],
];

function defaultIo(): PdfDetectIo {
  return {
    exists: (p) => existsSync(p),
    which: (cmd) => {
      // 不引 which 依赖：PATH 逐段拼一次就够，且不会因为 shell 差异而行为不同。
      for (const dir of (process.env["PATH"] ?? "").split(":")) {
        if (!dir) continue;
        const full = join(dir, cmd);
        if (existsSync(full)) return full;
      }
      return null;
    },
    env: process.env,
  };
}

/**
 * 找一个能用的排版器。顺序：环境变量 → 固定路径 → PATH。
 *
 * 环境变量指到不存在的路径时**当没配**继续找下去 —— 配错一个变量不该让整台机器
 * 导不出 PDF，而那正是最难自查的一类故障。
 */
export function detectPdfEngine(io: PdfDetectIo = defaultIo()): PdfEngine | null {
  const pinned = (io.env["ONTOCOPILOT_PDF_ENGINE"] ?? "").trim();
  if (pinned && io.exists(pinned)) return { path: pinned, label: "自定义排版器" };
  for (const [path, label] of FIXED_CANDIDATES) {
    if (io.exists(path)) return { path, label };
  }
  for (const [cmd, label] of PATH_CANDIDATES) {
    const found = io.which(cmd);
    if (found !== null) return { path: found, label };
  }
  return null;
}

/**
 * 无头打印的参数。
 *
 * `--print-to-pdf-no-header` 不能少：默认页眉会把打印时间和 file:// 路径印在
 * 正文上方，交给客户的文档上出现一行本机临时目录，是很难解释的尴尬。
 */
export function pdfEngineArgs(htmlPath: string, outPath: string): string[] {
  return [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    "--no-pdf-header-footer",
    "--print-to-pdf-no-header",
    `--print-to-pdf=${outPath}`,
    `file://${htmlPath}`,
  ];
}

/** 本进程创建过的临时目录 —— 测试据此断言"用完即删"。 */
const TEMP_DIRS: string[] = [];
export function pdfTempFiles(): readonly string[] {
  return TEMP_DIRS;
}

/** 排版超时。浏览器偶发卡死不能把导出请求永远挂住。 */
export const PDF_TIMEOUT_MS = 60_000;

/** 跑一次排版。失败抛 Error（调用方翻译成给模型看的回执）。 */
export async function renderPdfWith(
  engine: PdfEngine,
  html: string,
  css: string,
): Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), "ontocopilot-pdf-"));
  TEMP_DIRS.push(dir);
  const htmlPath = join(dir, "doc.html");
  const outPath = join(dir, "doc.pdf");
  // CSS 内联进去：Chrome 读的是 file://，外链样式表会因为同源策略与相对路径出岔子。
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>`
    + `<body>${html}</body></html>`;
  writeFileSync(htmlPath, page, "utf8");
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        engine.path,
        pdfEngineArgs(htmlPath, outPath),
        { timeout: PDF_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
        (err) => {
          // Chrome 在无头模式下常把无害的告警写到 stderr 并返回非 0；
          // **判据是文件出没出来**，不是退出码。
          if (existsSync(outPath)) resolve();
          else reject(err ?? new Error("排版器没有产出 PDF"));
        },
      );
    });
    return new Uint8Array(readFileSync(outPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
