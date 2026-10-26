import { invoke } from "@tauri-apps/api/core";
import { docThumb, docThumbKind, htmlPageThumb, sheetThumbHtml } from "./doc-thumb.ts";
import { isPreviewableImagePath } from "./file-icons.ts";

/**
 * 任意项目文件的缩略图（2026-10-26，「引用项目文件」弹层；用户：不可以以缩略图的形式展示吗）：
 * 图片读原图；PDF / Word / 表格走 doc-thumb（首页 / 前几行排进一张纸）；CSV 排成小表；
 * Markdown、代码、纯文本取开头几十行排进一张纸。读不了（PPT、二进制、太大）返回 null，调用方画类型色块。
 * 读取一律走后端白名单（项目根内）；同一文件同一修改时间只读一次，同时最多读三个。
 */

function extOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

const PROSE_EXTS = new Set(["md", "markdown", "mdx", "qmd", "rmd", "txt", "rst", "org", "tex", "bib", "log"]);
const CODE_EXTS = new Set([
  "py", "r", "jl", "m", "js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "yaml", "yml", "toml", "ini", "cfg",
  "html", "htm", "css", "scss", "sh", "bash", "zsh", "ps1", "bat", "rs", "go", "java", "kt", "swift", "c", "h",
  "cpp", "hpp", "cc", "cs", "rb", "php", "lua", "sql", "xml", "vue", "svelte",
]);

export type TextThumbKind = "prose" | "code" | "csv" | "tsv";

/** 哪些文件按文字出缩略图（图片、PDF、Word、表格另走） */
export function textThumbKind(path: string): TextThumbKind | null {
  const ext = extOf(path);
  if (ext === "csv") return "csv";
  if (ext === "tsv") return "tsv";
  if (PROSE_EXTS.has(ext)) return "prose";
  if (CODE_EXTS.has(ext)) return "code";
  return null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** CSV / TSV 开头几行拆成格子（不处理引号里的分隔符，缩略图看个样子就够） */
export function delimitedRows(text: string, sep: string, maxRows = 24): string[][] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(0, maxRows)
    .map((line) => line.split(sep).map((cell) => cell.trim().replace(/^"(.*)"$/, "$1")));
}

/** 文字缩略图的版面：文章用正文字体、代码用等宽，只取开头几十行 */
export function textThumbHtml(text: string, kind: "prose" | "code", maxLines = 48): string {
  const head = text.split(/\r?\n/).slice(0, maxLines).join("\n");
  const font =
    kind === "code"
      ? "13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"
      : "15px/1.6 -apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif";
  return `<div style="white-space:pre-wrap;font:${font}">${escapeHtml(head)}</div>`;
}

async function readText(path: string, root: string): Promise<string | null> {
  try {
    const dto = await invoke<{ text: string }>("read_file_preview", { path, root, requireWithinRoot: true });
    return dto.text;
  } catch {
    return null;
  }
}

/** 文字 / CSV 用的小纸：4:3 横版，和网格格子同比例，缩下去字比整页 A4 大三倍 */
const SMALL_PAGE = { width: 360, height: 270, padding: "18px 20px" };

async function renderThumb(path: string, cwd: string): Promise<string | null> {
  if (isPreviewableImagePath(path)) {
    try {
      const img = await invoke<{ mime: string; data: string }>("read_image_bytes", { path, cwdHint: cwd });
      return `data:${img.mime};base64,${img.data}`;
    } catch {
      return null;
    }
  }
  const doc = docThumbKind(path);
  // 表格和 CSV 一样排小纸（整页 A4 缩到格子里只剩几道线）；PDF / Word 本来就是一页纸，照整页
  if (doc === "sheet") {
    try {
      const dto = await invoke<{ rows: string[][] }>("read_sheet_preview", { path, cwdHint: cwd, sheet: null });
      return dto.rows.length > 0 ? htmlPageThumb(sheetThumbHtml(dto.rows, 12, 5), SMALL_PAGE) : null;
    } catch {
      return null;
    }
  }
  if (doc) return docThumb(path, cwd);
  const kind = textThumbKind(path);
  if (!kind) return null;
  const text = await readText(path, cwd);
  if (text === null || text.trim() === "") return null;
  if (kind === "csv" || kind === "tsv") {
    const rows = delimitedRows(text, kind === "csv" ? "," : "\t");
    return rows.length > 0 ? htmlPageThumb(sheetThumbHtml(rows, 12, 5), SMALL_PAGE) : null;
  }
  return htmlPageThumb(textThumbHtml(text, kind, 16), SMALL_PAGE);
}

/** 缩略图缓存（键带修改时间：文件改了重画）；最多留这么多张 */
const CACHE_MAX = 300;
const cache = new Map<string, Promise<string | null>>();

/** 同时最多画三张（PDF 要 pdf.js 排版，一屏十几张一起读会卡） */
const MAX_RUNNING = 3;
let running = 0;
const waiting: (() => void)[] = [];

async function limited<T>(job: () => Promise<T>): Promise<T> {
  if (running >= MAX_RUNNING) await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
  try {
    return await job();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

/** 文件缩略图（图片地址），读不了 null。modified 变了视为新文件 */
export function fileThumb(path: string, cwd: string, modified: string | null): Promise<string | null> {
  const key = `${path}\n${modified ?? ""}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const task = limited(() => renderThumb(path, cwd)).catch(() => null);
  cache.set(key, task);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return task;
}

/** 这个文件能不能出缩略图（不能的就别去读） */
export function hasFileThumb(path: string): boolean {
  return isPreviewableImagePath(path) || docThumbKind(path) !== null || textThumbKind(path) !== null;
}
