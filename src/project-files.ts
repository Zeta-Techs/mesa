import { parentDir, pathWithin, samePath } from "./path-utils.ts";
import { officeDocKind, type OfficeDocKind } from "./work-mode.ts";

/** 项目文件页就地预览形态：与运行页右栏同一套分流。 */
export type ProjectFilePreviewKind =
  | "pdf"
  | "image"
  | "xlsx"
  | "docx"
  | "legacy-doc"
  | "slides"
  | "notebook"
  | "audio"
  | "video"
  | "text";

/** recent 是「最近修改」视图不是类型筛选：不参与按类型收窄 */
export type ProjectFileFilter = "all" | OfficeDocKind | "recent";

export function fileMatchesProjectFilter(
  path: string,
  filter: ProjectFileFilter,
): boolean {
  if (filter === "all" || filter === "recent") return true;
  return officeDocKind(path) === filter;
}

/**
 * 方向键是否该让给正在打字的控件（会话列表「↑/↓ 仅非打字焦点」同款口径）。
 * Monaco 的编辑面是 textarea，一并覆盖；target 为 null（焦点在 window/document）时视为可接管。
 */
const TYPING_SELECTOR =
  "input, textarea, select, [contenteditable='true'], [contenteditable=''], [role='textbox']";
export function inTypingContext(
  target: { closest(selector: string): unknown } | null,
): boolean {
  return !!target?.closest?.(TYPING_SELECTOR);
}

export function flattenVisibleFiles<T extends { path: string; isDir: boolean }>(
  cache: Record<string, readonly T[] | undefined>,
  root: string,
  expanded: ReadonlySet<string>,
): T[] {
  const out: T[] = [];
  const walk = (dir: string) => {
    for (const entry of cache[dir] ?? []) {
      if (entry.isDir) {
        if (expanded.has(entry.path)) walk(entry.path);
      } else {
        out.push(entry);
      }
    }
  };
  walk(root);
  return out;
}

/** 从项目根到文件父目录、需要展开的目录链（不含根）。路径不在根内则空。 */
export function ancestorDirsToReveal(
  root: string,
  filePath: string,
  isWindows = false,
): string[] {
  if (!pathWithin(filePath, root, isWindows)) return [];
  const out: string[] = [];
  let cur = parentDir(filePath);
  while (
    cur &&
    pathWithin(cur, root, isWindows) &&
    !samePath(cur, root, isWindows)
  ) {
    out.unshift(cur);
    cur = parentDir(cur);
  }
  return out;
}

export function neighborFile<T extends { path: string }>(
  files: readonly T[],
  currentPath: string | null | undefined,
  delta: -1 | 1,
): T | null {
  if (files.length === 0) return null;
  const index = currentPath
    ? files.findIndex((file) => file.path === currentPath)
    : -1;
  const next = index < 0 ? (delta > 0 ? 0 : files.length - 1) : index + delta;
  if (next < 0 || next >= files.length) return null;
  return files[next] ?? null;
}

/** 文件扩展名（小写、不含点）。无扩展名、点开头（.gitignore）或点结尾时返回 ""。 */
export function fileExt(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/**
 * 沉浸阅读入口是否可用。
 *
 * 面板有三处要判断这件事（文件行工具条、预览浮层、「显示」浮层），原先各写各的
 * 正则，其中一处多带了个 `markdown`——同一个 .markdown 文件在一边有入口、另一边
 * 没有。判据收在这里，谁都不许再手写一次。
 */
const IMMERSIVE_EXTS = new Set(["pdf", "md", "markdown"]);
export function supportsImmersiveReader(path: string): boolean {
  return IMMERSIVE_EXTS.has(fileExt(path));
}

/** PowerPoint（OOXML）：逐页大纲 + 装了 LibreOffice 时看原样 */
const SLIDE_EXTS = new Set(["pptx", "pptm", "ppsx", "potx"]);
/** 旧版 Office 与 OpenDocument：内嵌预览不了，装了 LibreOffice 时可转 PDF 看 */
/** 音视频：asset 协议流式播放（WebView 放不了的编码由播放器报错后提示系统打开） */
const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "aac", "flac", "ogg", "oga", "opus", "aif", "aiff"]);
const VIDEO_EXTS = new Set(["mp4", "m4v", "mov", "webm", "ogv", "mkv", "avi"]);
export const LEGACY_OFFICE_EXTS = new Set(["doc", "rtf", "odt", "ppt", "pps", "odp"]);

export function projectFilePreviewKind(path: string): ProjectFilePreviewKind {
  const ext = fileExt(path);
  if (ext === "pdf") return "pdf";
  if (
    ext === "png" ||
    ext === "jpg" ||
    ext === "jpeg" ||
    ext === "gif" ||
    ext === "webp" ||
    ext === "svg"
  ) {
    return "image";
  }
  if (
    ext === "xlsx" ||
    ext === "xlsm" ||
    ext === "xls" ||
    ext === "ods" ||
    ext === "csv" ||
    ext === "tsv"
  ) {
    return "xlsx";
  }
  if (ext === "docx") return "docx";
  if (SLIDE_EXTS.has(ext)) return "slides";
  if (ext === "ipynb") return "notebook";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (LEGACY_OFFICE_EXTS.has(ext)) return "legacy-doc";
  return "text";
}

const ARTIFACT_TEXT_EXTS = new Set(["md", "markdown", "txt", "ris", "bib"]);

/** 产物核验点开：文本走编辑弹层，pdf/docx/表格/图就地预览，其余才跳运行页。 */
export function artifactPreviewSurface(
  path: string,
): "text" | "media" | "jump" {
  const name = path.split(/[\\/]/).pop() ?? path;
  const ext = name.includes(".")
    ? name.slice(name.lastIndexOf(".") + 1).toLowerCase()
    : "";
  if (ARTIFACT_TEXT_EXTS.has(ext)) return "text";
  const kind = projectFilePreviewKind(path);
  if (
    kind === "pdf" ||
    kind === "docx" ||
    kind === "xlsx" ||
    kind === "image" ||
    kind === "slides"
  ) {
    return "media";
  }
  return "jump";
}

/** 收起的文件夹行尾写里面有几项：0 写「空」，封顶（后端数到 1000 停）写「999+」；没数（旧数据 / 读不了）不写 */
export function folderCountLabel(count: number | null | undefined): string | null {
  if (count == null) return null;
  if (count <= 0) return "空";
  if (count >= 1000) return "999+";
  return String(count);
}

/**
 * Shift 点选：从锚点到这一行（含两端，按当前看得见的文件顺序）。锚点不在当前列表里
 * （刚换了筛选 / 被删了）就只选这一行。
 */
export function rangeSelect(order: readonly string[], anchor: string | null, target: string): string[] {
  const to = order.indexOf(target);
  if (to < 0) return [];
  const from = anchor ? order.indexOf(anchor) : -1;
  if (from < 0) return [target];
  const [a, b] = from <= to ? [from, to] : [to, from];
  return order.slice(a, b + 1);
}

/** 多选后「问 AI」的开场白：一份一行，带空格的路径加引号（与单份「请看这份文件」同口径） */
export function batchAskPrompt(paths: readonly string[]): string {
  const lines = paths.map((p) => `- ${/\s/.test(p) ? `"${p}"` : p}`);
  return `请看这几份文件：\n${lines.join("\n")}`;
}
