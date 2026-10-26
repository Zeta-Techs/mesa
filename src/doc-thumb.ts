import { invoke } from "@tauri-apps/api/core";

/**
 * 聊天附件卡的文档预览（2026-10-23 用户：拖进来的 PDF 有首页，Word 那些文件呢）。
 * PDF 走 pdf.js 画第一页（pdf-thumb.ts）；Word（docx）由 mammoth 转出 HTML、表格（xlsx/xls/ods）取前几行，
 * 都排进一张「纸」，用 SVG foreignObject 包成图片地址——卡片只认一张图，不在输入框里挂活的文档 DOM，
 * 图里的内容也不会执行。PPT、旧版 .doc 等读不出来的，卡片画类型色块。读取一律走后端白名单。
 */

export type DocThumbKind = "pdf" | "docx" | "sheet";

function extOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** 哪些附件能出预览（csv 不在内：它的读取通道要项目根，项目外拖进来的读不到） */
export function docThumbKind(path: string): DocThumbKind | null {
  const ext = extOf(path);
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "xlsx" || ext === "xlsm" || ext === "xls" || ext === "ods") return "sheet";
  return null;
}

/** 卡片上文件名下面那行类型字 */
export function docTypeLabel(path: string): string {
  const ext = extOf(path);
  if (ext === "pdf") return "PDF";
  if (ext === "docx" || ext === "doc" || ext === "rtf") return "Word 文档";
  if (ext === "xlsx" || ext === "xlsm" || ext === "xls" || ext === "ods") return "Excel 表格";
  if (ext === "csv" || ext === "tsv") return "CSV 表格";
  if (ext === "pptx" || ext === "ppt" || ext === "odp") return "PPT 演示";
  if (ext === "key") return "Keynote 演示";
  return ext ? ext.toUpperCase() : "文件";
}

const XHTML = "http://www.w3.org/1999/xhtml";
/** 纸面尺寸（A4 比例），缩到卡片里只看版面 */
const PAGE_W = 600;
const PAGE_H = 849;
/** 只排第一页用得上的前几十个块，别把整本书塞进图片地址 */
const MAX_BLOCKS = 40;

/** 一段（已清洗的）HTML 排进一张白纸，出 SVG 图片地址。page 不给就是 A4 比例的整页；
 *  「引用项目文件」网格里的文字 / CSV 用小一号的横版纸（缩到格子里字还认得出） */
export function htmlPageThumb(
  html: string,
  page: { width: number; height: number; padding: string } = { width: PAGE_W, height: PAGE_H, padding: "56px 60px" },
): string {
  const sheet = document.createElementNS(XHTML, "div") as HTMLDivElement;
  sheet.innerHTML = html;
  while (sheet.children.length > MAX_BLOCKS) sheet.lastElementChild!.remove();
  sheet.setAttribute(
    "style",
    `box-sizing:border-box;width:${page.width}px;height:${page.height}px;overflow:hidden;padding:${page.padding};` +
      "background:#fff;color:#1f1f1f;font:15px/1.55 -apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',serif;word-break:break-word",
  );
  sheet.querySelectorAll("img").forEach((img) => img.setAttribute("style", "max-width:100%;height:auto"));
  sheet.querySelectorAll("table").forEach((t) => t.setAttribute("style", "border-collapse:collapse;width:100%"));
  sheet.querySelectorAll("td,th").forEach((c) => c.setAttribute("style", "border:1px solid #ccc;padding:2px 6px"));
  const body = new XMLSerializer().serializeToString(sheet);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}" height="${page.height}">` +
    `<foreignObject width="100%" height="100%">${body}</foreignObject></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** 表格前几行 → 一张纸上的小表（行列都截，看个样子） */
export function sheetThumbHtml(rows: readonly (readonly string[])[], maxRows = 24, maxCols = 6): string {
  const body = rows
    .slice(0, maxRows)
    .map((r) => `<tr>${r.slice(0, maxCols).map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<table>${body}</table>`;
}

/** 表格附件预览：read_sheet_preview（同一读取白名单）取第一个工作表；失败 null */
export async function sheetThumb(path: string, cwdHint: string | null): Promise<string | null> {
  try {
    const dto = await invoke<{ rows: string[][] }>("read_sheet_preview", { path, cwdHint, sheet: null });
    if (dto.rows.length === 0) return null;
    return htmlPageThumb(sheetThumbHtml(dto.rows));
  } catch {
    return null;
  }
}

/** 按类型取预览；pdf.js / mammoth 各自按需加载，不进主包 */
export async function docThumb(path: string, cwdHint: string | null): Promise<string | null> {
  const kind = docThumbKind(path);
  if (kind === "pdf") return (await import("./pdf-thumb")).pdfFirstPageThumb(path, cwdHint);
  if (kind === "docx") return (await import("./docx-thumb")).docxFirstPageThumb(path, cwdHint);
  if (kind === "sheet") return sheetThumb(path, cwdHint);
  return null;
}
