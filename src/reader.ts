/** 沉浸式阅读区的纯逻辑：分栏百分比钳制/像素换算、阅读会话复用键、
 *  PDF 选段注入格式（B1）；圈选矩形映射/命中判定、md 图片与相对链接判定、截图注入格式（B2）；
 *  划词翻译 prompt、生词本表格契约、段落边界提取、术语匹配、进度/护眼存储键（B3）；
 *  PDF 适配宽度 nextFitScale（预览与连续滚动共用，防滚动条槽振荡）；
 *  手势缩放（⌘/Ctrl+滚轮、触控板 pinch）连续倍率/钳制/锚点实测修正
 *  （组件绑定共享在 components/use-pdf-zoom.ts：布局倍率即时、渲染倍率延迟）；
 *  画布 backing store 上限 pdfCanvasOutputScale（防高倍缩放黑屏）。
 *  布局常量与换算全部集中这里，组件（ReaderOverlay/PdfContinuousView/FilePreviewEditor）只做绑定。 */

import { escapeShellPath } from "./terminal-input.ts";
import { pathKey } from "./path-utils.ts";

export const READER_SPLIT_L_KEY = "ccode.readerSplitL";
export const READER_SPLIT_R_KEY = "ccode.readerSplitR";
/** 译文浮窗显式尺寸（px；未拖过右下角不落键 = 宽 26rem、高按内容自适应） */
export const READER_TL_CARD_KEY = "ccode.readerTlCard";
/** 悬浮卡尺寸下限：再窄动作钮排不下、再矮表头都不够 */
export const READER_TL_CARD_MIN_W = 240;
export const READER_TL_CARD_MIN_H = 140;
/** 译文悬浮球位置（PDF 栏里的百分比 "xp,yp"，换窗口宽高不失位）；缺省右缘中部 */
export const READER_TL_BALL_KEY = "ccode.readerTlBall";
export const READER_TL_BALL_DEFAULT = { xp: 100, yp: 45 };
/** 球的边长（px）：钳位按半边算 */
export const READER_TL_BALL_SIZE = 36;
/** 侧栏宽度百分比的可拖范围（相对三栏总宽） */
export const READER_PCT_MIN = 12;
export const READER_PCT_MAX = 40;
/** 侧栏（笔记/Agent）最小像素宽：窗口再小也不压缩到不可用 */
export const READER_SIDE_MIN_PX = 240;
/** 分隔条抓取热区宽（splitter 外层）：与收起滑出量同源，改一处必改另一处 */
export const READER_SPLITTER_PX = 6;
/** PDF 栏保底宽度：两侧合计不得把它压到这条线以下 */
export const READER_PDF_MIN_PX = 280;
/** 侧栏缺省百分比（笔记栏窄些、Agent 栏宽些——对话内容比笔记目录长） */
export const READER_PCT_DEFAULT_L = 22;
export const READER_PCT_DEFAULT_R = 28;
/** 抽查核对档（2026-10-23 用户：问题单窄一点、左侧保留阅读宽度）：栏宽另记一套，
 *  拖动不影响平时读文献的三栏；笔记栏给到正常阅读的宽度，问题单只要放得下卡片 */
export const SPOT_SPLIT_L_KEY = "ccode.spotSplitL";
export const SPOT_SPLIT_R_KEY = "ccode.spotSplitR";
export const SPOT_PCT_DEFAULT_L = 34;
export const SPOT_PCT_DEFAULT_R = 18;

/**
 * 适配宽度：新 scale 换算回页面 CSS 宽度后与当前差不到半像素则保持原值。
 * Windows 经典滚动条出现/消失会让 clientWidth 跳约 17px；每次都改 scale
 * 会拆掉 canvas 重渲，PDF 预览表现为闪白屏。
 */
export function nextFitScale(
  pageWidth: number,
  availWidth: number,
  current: number,
): number | null {
  if (pageWidth <= 0 || availWidth <= 0) return null;
  const next = availWidth / pageWidth;
  if (Math.abs(next - current) * pageWidth < 0.5) return null;
  return next;
}

/** PDF 手势/按钮缩放范围：与顶栏 −/＋ 同一钳制 */
export const PDF_SCALE_MIN = 0.25;
export const PDF_SCALE_MAX = 4;
/** 顶栏 −/＋ 每档倍率（手势走连续倍率，不对齐这一档） */
export const PDF_ZOOM_STEP = 1.2;
/** 滚轮/pinch 像素：这么多 deltaY ≈ 缩小到一半（连续指数，不按档跳） */
export const PDF_WHEEL_ZOOM_HALVE_PX = 400;
/** pdf.js 画布像素上限（与官方 viewer 同 4096²）。超限 WKWebView/GPU 会整页涂黑 */
export const PDF_MAX_CANVAS_PIXELS = 4096 * 4096;
/** 单边上限：Safari/WKWebView 大画布会合成失败 */
export const PDF_MAX_CANVAS_SIDE = 8192;

/** ⌘/Ctrl + 滚轮才缩放（触控板 pinch 在 Chromium/WebKit 也带 ctrlKey）；未按修饰键仍翻页 */
export function pdfWheelShouldZoom(mods: {
  ctrlKey: boolean;
  metaKey: boolean;
}): boolean {
  return Boolean(mods.ctrlKey || mods.metaKey);
}

/**
 * 滚轮/pinch 增量 → 连续倍率。deltaY>0 缩小。
 * line/page 模式先折成像素；单次夹到 ±HALVE_PX（最多一倍/一半），避免一格跳到极限。
 */
export function pdfWheelZoomFactor(
  deltaY: number,
  deltaMode = 0,
): number | null {
  if (!Number.isFinite(deltaY) || deltaY === 0) return null;
  let dy = deltaY;
  if (deltaMode === 1) dy *= 16;
  else if (deltaMode === 2) dy *= 400;
  dy = Math.max(
    -PDF_WHEEL_ZOOM_HALVE_PX,
    Math.min(PDF_WHEEL_ZOOM_HALVE_PX, dy),
  );
  return 2 ** -(dy / PDF_WHEEL_ZOOM_HALVE_PX);
}

export function clampPdfScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.min(PDF_SCALE_MAX, Math.max(PDF_SCALE_MIN, scale));
}

/** 宿主缩放上限：fit 倍率的倍数（弹层限制深缩放用，页宽 ≈ 倍数 × 栏宽），仍夹全局范围 */
export function pdfZoomCap(
  fitScale: number,
  maxFitMultiplier?: number,
): number {
  if (!maxFitMultiplier || !(fitScale > 0)) return PDF_SCALE_MAX;
  return clampPdfScale(fitScale * maxFitMultiplier);
}

/** WebKit `gesturechange.scale` 相对手势起点（1 = 没变） */
export function pdfPinchScale(
  startScale: number,
  gestureScale: number,
): number {
  const start =
    Number.isFinite(startScale) && startScale > 0 ? startScale : 1;
  if (!Number.isFinite(gestureScale) || gestureScale <= 0) {
    return clampPdfScale(start);
  }
  return clampPdfScale(start * gestureScale);
}

/**
 * 画布 backing store 相对 CSS 尺寸的输出倍率。
 * 先按 devicePixelRatio，再按总像素/单边上限缩小——高倍缩放时 CSS 拉大、像素不涨，避免黑屏。
 */
export function pdfCanvasOutputScale(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
  maxPixels = PDF_MAX_CANVAS_PIXELS,
  maxSide = PDF_MAX_CANVAS_SIDE,
): { sx: number; sy: number } {
  if (!(cssWidth > 0) || !(cssHeight > 0)) return { sx: 1, sy: 1 };
  const px = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  let sx = px;
  let sy = px;
  const w = cssWidth * sx;
  const h = cssHeight * sy;
  let shrink = 1;
  const pixels = w * h;
  if (Number.isFinite(maxPixels) && maxPixels > 0 && pixels > maxPixels) {
    shrink = Math.min(shrink, Math.sqrt(maxPixels / pixels));
  }
  if (Number.isFinite(maxSide) && maxSide > 0) {
    if (w * shrink > maxSide) shrink = Math.min(shrink, maxSide / w);
    if (h * shrink > maxSide) shrink = Math.min(shrink, maxSide / h);
  }
  return { sx: sx * shrink, sy: sy * shrink };
}

/** 栏宽百分比钳制：非有限数/非正数回落 fallback，其余夹到 [min, max] */
export function clampReaderPct(pct: number, fallback: number): number {
  if (!Number.isFinite(pct) || pct <= 0) return fallback;
  return Math.min(READER_PCT_MAX, Math.max(READER_PCT_MIN, pct));
}

/** 打开时读本地记忆的栏宽百分比（坏值/缺省回落 fallback；localStorage 不可用时静默回落） */
export function loadReaderPct(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? clampReaderPct(v, fallback) : fallback;
  } catch {
    return fallback;
  }
}

/** PDF 栏离覆盖层根四边的距离（px）：译文浮窗只在 PDF 栏里活动 */
export interface ReaderPdfBounds {
  left: number;
  right: number;
  top?: number;
  bottom?: number;
}

/** 悬浮球位置归一：0–100 百分比（可贴边），真出界由 readerTlBallOffset 按球半边钳住 */
export function clampReaderTlBall(xp: number, yp: number): { xp: number; yp: number } {
  const c = (v: number) => (Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 50);
  return { xp: c(xp), yp: c(yp) };
}

/** 球心离某一侧的距离（CSS 长度，挂覆盖层根的 left/top 用）：near = 这一侧栏外的距离，
 *  span = 两侧栏外距离之和；按球半边兜在 PDF 栏里（球不跑到笔记栏 / 对话栏上） */
export function readerTlBallOffset(pct: number, near: number, span: number): string {
  const r = READER_TL_BALL_SIZE / 2;
  return `calc(${near}px + clamp(${r}px, calc((100% - ${span}px) * ${pct / 100}), calc(100% - ${span}px - ${r}px)))`;
}

/** 读悬浮球位置记忆（坏值 / 缺省回落右缘中部） */
export function loadReaderTlBall(): { xp: number; yp: number } {
  try {
    const raw = localStorage.getItem(READER_TL_BALL_KEY);
    if (!raw) return { ...READER_TL_BALL_DEFAULT };
    const [xp, yp] = raw.split(",").map(Number);
    return clampReaderTlBall(xp, yp);
  } catch {
    return { ...READER_TL_BALL_DEFAULT };
  }
}

/** 写悬浮球位置记忆（取整百分比 "xp,yp"） */
export function saveReaderTlBall(xp: number, yp: number): void {
  try {
    localStorage.setItem(READER_TL_BALL_KEY, `${Math.round(xp)},${Math.round(yp)}`);
  } catch {
    /* 存不进就不记 */
  }
}

/** 译文浮窗摆哪（覆盖层根坐标 px，2026-11-06 用户选「只留浮窗」）：有原文段 / 选区外框时左缘对齐它，
 *  放在它下方（放得下）或上方，都放不下就放空间大的那边、贴 PDF 栏边（可能压到一点原文）；
 *  没有外框时放 PDF 栏右上角。全程钳在 PDF 栏里（各留 8px） */
export function readerTlWinPlace(
  src: { top: number; bottom: number; left: number } | null,
  bounds: ReaderPdfBounds,
  host: { width: number; height: number },
  win: { w: number; h: number },
): { x: number; y: number } {
  const L = bounds.left + 8;
  const R = host.width - bounds.right - 8;
  const T = (bounds.top ?? 0) + 8;
  const B = host.height - (bounds.bottom ?? 0) - 8;
  const cx = (x: number) => Math.round(Math.max(L, Math.min(x, R - win.w)));
  const cy = (y: number) => Math.round(Math.max(T, Math.min(y, B - win.h)));
  if (!src) return { x: cx(R - win.w), y: T };
  const x = cx(src.left);
  const below = B - (src.bottom + 8);
  const above = src.top - 8 - T;
  if (below >= win.h) return { x, y: Math.round(src.bottom + 8) };
  if (above >= win.h) return { x, y: Math.round(src.top - 8 - win.h) };
  return { x, y: cy(below >= above ? src.bottom + 8 : src.top - 8 - win.h) };
}

/** 浮窗尺寸钳制：下限常量、上限传栏内可用空间；坏值回落下限 */
export function clampReaderTlCard(
  w: number,
  h: number,
  maxW: number,
  maxH: number,
): { w: number; h: number } {
  const cw = Math.min(
    Math.max(READER_TL_CARD_MIN_W, Math.round(Number.isFinite(w) ? w : 0)),
    Math.max(READER_TL_CARD_MIN_W, Math.floor(maxW)),
  );
  const ch = Math.min(
    Math.max(READER_TL_CARD_MIN_H, Math.round(Number.isFinite(h) ? h : 0)),
    Math.max(READER_TL_CARD_MIN_H, Math.floor(maxH)),
  );
  return { w: cw, h: ch };
}

/** 读浮窗显式尺寸（"w,h" px；未拖过/坏值 = null，内容自适应） */
export function loadReaderTlCard(): { w: number; h: number } | null {
  try {
    const raw = localStorage.getItem(READER_TL_CARD_KEY);
    if (!raw) return null;
    const [w, h] = raw.split(",").map(Number);
    if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
    return { w: Math.round(w), h: Math.round(h) };
  } catch {
    return null;
  }
}

/** 写浮窗显式尺寸；null 清键回自适应（双击右下角复位） */
export function saveReaderTlCard(size: { w: number; h: number } | null): void {
  try {
    if (size) {
      localStorage.setItem(READER_TL_CARD_KEY, `${size.w},${size.h}`);
    } else {
      localStorage.removeItem(READER_TL_CARD_KEY);
    }
  } catch {
    /* 存不进就不记 */
  }
}

/** 三栏像素换算：侧栏按百分比取整后保底 240px；两侧合计超出「总宽 − PDF 保底」时按比例压缩；
 *  窗口窄到 PDF 保底都拿不出时侧栏归零让位（PDF 全宽）。
 *  keepLeft（抽查核对档）：放不下时先把右栏压到保底，左栏的阅读宽度最后才让 */
export function readerColumnWidths(
  totalPx: number,
  pctL: number,
  pctR: number,
  keepLeft = false,
): { left: number; right: number } {
  const budget = totalPx - READER_PDF_MIN_PX;
  if (budget <= 0) return { left: 0, right: 0 };
  const left = Math.max(READER_SIDE_MIN_PX, Math.round((pctL / 100) * totalPx));
  let right = Math.max(READER_SIDE_MIN_PX, Math.round((pctR / 100) * totalPx));
  if (left + right <= budget) return { left, right };
  if (keepLeft) {
    right = Math.max(READER_SIDE_MIN_PX, budget - left);
    if (left + right <= budget) return { left, right };
  }
  const k = budget / (left + right);
  return { left: Math.floor(left * k), right: Math.floor(right * k) };
}

/** 侧栏收起滑动量：整块（栏宽 + 分隔条热区）用负 margin 滑出窗口外，展开归 0。
 *  栏体宽度全程不变——内容（Monaco/xterm 宿主）零重排，只有 PDF 栏随布局伸缩；
 *  收起态配合 visibility 过渡收尾（滑动期间保持可见，滑完才隐） */
export function readerPanelSlideMargin(panelPx: number, open: boolean): number {
  return open ? 0 : -(panelPx + READER_SPLITTER_PX);
}

/** 阅读会话终端标签的复用键（TerminalPage 与覆盖层同一出处）：按篇一个（2026-11-06 用户：读过的文献再点精读接回原来那段对话）。
 *  格式 `reader:<项目根>\n<PDF 路径>`，与后端 runs.rs READER_KEY_SEP / reader_pdf_of_key 双端镜像（后端靠它认出读的哪篇） */
export function readerReuseKey(projectRoot: string, pdfPath: string): string {
  return `reader:${projectRoot}\n${pdfPath}`;
}

/** 这篇以前的精读对话（接回它，不另开）：同项目、读的同一篇、源文件还在、没归档，取最近的一段 */
export function readerSessionFor<
  T extends {
    reader?: boolean;
    readerPdf?: string | null;
    projectPath: string;
    alive: boolean;
    archived: boolean;
    updatedAt: string | null;
  },
>(sessions: readonly T[], projectRoot: string, pdfPath: string, isWindows = false): T | null {
  const root = pathKey(projectRoot, isWindows);
  const pdf = pathKey(pdfPath, isWindows);
  let best: T | null = null;
  for (const s of sessions) {
    if (!s.reader || !s.readerPdf || !s.alive || s.archived) continue;
    if (pathKey(s.projectPath, isWindows) !== root || pathKey(s.readerPdf, isWindows) !== pdf) continue;
    if (!best || (s.updatedAt ?? "") > (best.updatedAt ?? "")) best = s;
  }
  return best;
}

/** PDF 选段「◈ 问 AI」的注入格式（与 TerminalPage.askAiFromPdf 同一出处，勿分叉）：
 *  `> 「≤60 字摘要」（file，第 N 页）` + 空行 + 正文（>6000 截断） */
export function formatPdfExcerptPrompt(
  text: string,
  page: number,
  fileName: string,
): string {
  // 注入上限保护：选段过长时截断正文，避免把整页灌进输入框
  const body = text.length > 6000 ? `${text.slice(0, 6000)}…` : text;
  const brief = text.replace(/\s+/g, " ").slice(0, 60);
  return `> 「${brief}${text.length > 60 ? "…" : ""}」（${fileName}，第 ${page} 页）\n\n${body}`;
}

// ===== 批次 B2：圈选截图、md 图片/相对链接 =====

/** 圈选矩形（CSS px；命中判定与 canvas 映射都在同一坐标系内做） */
export interface CaptureRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 小于 8×8 CSS px 视为误触，不成框 */
export const CAPTURE_MIN_PX = 8;

/** 两个指针点归一化成矩形（任意方向拖拽） */
export function normCaptureRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): CaptureRect {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    w: Math.abs(x1 - x0),
    h: Math.abs(y1 - y0),
  };
}

/** 矩形是否达到成框尺寸（误触过滤） */
export function captureRectUsable(r: CaptureRect): boolean {
  return r.w >= CAPTURE_MIN_PX && r.h >= CAPTURE_MIN_PX;
}

/** 页槽/页 canvas 的包围盒（page 为页号；坐标与 CaptureRect 同一坐标系） */
export interface PageBox {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

function boxesIntersect(a: CaptureRect, b: CaptureRect): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

export type CaptureHit =
  | { kind: "ok"; page: number }
  | { kind: "cross" }
  | { kind: "none" };

/** 圈选命中判定（页槽为判定口径，含页间分隔带）：
 *  与 ≥2 个页槽相交 → cross（拒绝跨页）；恰好 1 个 → ok；0 个 → none（空白处松手） */
export function hitTestCapture(rect: CaptureRect, slots: PageBox[]): CaptureHit {
  const hit = slots.filter((s) => boxesIntersect(rect, s));
  if (hit.length === 0) return { kind: "none" };
  if (hit.length > 1) return { kind: "cross" };
  return { kind: "ok", page: hit[0].page };
}

/** CSS px 圈选矩形 → 页 canvas 像素矩形（DPR/缩放换算：比例 = canvas 像素宽 / CSS 宽）。
 *  先与 canvas 的 CSS 包围盒求交（出圈部分裁掉），再按比例换算；交集为空返回 null。 */
export function captureRectToCanvasPixels(
  rect: CaptureRect,
  canvasCss: CaptureRect,
  canvasW: number,
  canvasH: number,
): { sx: number; sy: number; sw: number; sh: number } | null {
  const ix = Math.max(rect.x, canvasCss.x);
  const iy = Math.max(rect.y, canvasCss.y);
  const ir = Math.min(rect.x + rect.w, canvasCss.x + canvasCss.w);
  const ib = Math.min(rect.y + rect.h, canvasCss.y + canvasCss.h);
  if (canvasCss.w <= 0 || canvasCss.h <= 0) return null;
  const ratioX = canvasW / canvasCss.w;
  const ratioY = canvasH / canvasCss.h;
  const sx = Math.max(0, Math.round((ix - canvasCss.x) * ratioX));
  const sy = Math.max(0, Math.round((iy - canvasCss.y) * ratioY));
  // 右/下缘按像素边界换算后再与 canvas 尺寸取小，round 出界由这里兜底
  const ex = Math.min(canvasW, Math.round((ir - canvasCss.x) * ratioX));
  const ey = Math.min(canvasH, Math.round((ib - canvasCss.y) * ratioY));
  if (ex - sx < 1 || ey - sy < 1) return null;
  return { sx, sy, sw: ex - sx, sh: ey - sy };
}

/** 圈选截图「发给 Agent」的注入格式：转义路径（终端粘贴图片同一口径）+ 预填 prompt 与出处。
 *  isWindows 由调用方显式传入而不是在这里读 IS_WINDOWS——本模块是纯逻辑层，
 *  隐式依赖平台会让单测结果随宿主机器变化（Node 的 navigator.platform 在 Windows 上是 Win32）。 */
export function formatReaderCapturePrompt(
  absPath: string,
  page: number,
  fileName: string,
  isWindows = false,
): string {
  return `${escapeShellPath(absPath, isWindows)}\n这张图/这段讲了什么？请结合论文解释。（${fileName}，第 ${page} 页圈选）`;
}

/** Uint8Array → base64（分块 btoa，避免大参数上限；btoa 只接受 latin1 串） */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export type MdHrefKind = "anchor" | "external" | "other" | "local";

function matchHtmlAttr(attrs: string, name: string): string | null {
  const re = new RegExp(
    `\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  );
  const m = re.exec(` ${attrs}`);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * 把 md HTML 里需要后处理的 &lt;img&gt; 换成带 data-md-src 的占位 span。
 * 不能留「无 src 的 img」：WKWebView 会立刻画裂图问号；相对路径/绝对本地路径
 * 若仍写在 src 上，又会被当成 localhost 地址 404。data:/blob: 原样保留。
 */
export function rewriteMdImageHtml(html: string): string {
  return html.replace(/<img\b([^>]*?)\/?\s*>/gi, (_full, attrs: string) => {
    const src = matchHtmlAttr(attrs, "src");
    if (!src || /^(data:|blob:)/i.test(src)) return _full;
    const alt = matchHtmlAttr(attrs, "alt") ?? "";
    // ![读音](mesa.aiff) 这种把音频写成图片的：不去读图（必报「只支持图片」），留文字，聊天层在下方给播放条
    if (/\.(?:mp3|wav|m4a|aac|aiff?|aifc|flac|ogg|oga|opus)$/i.test(src.split(/[?#]/)[0])) {
      return `<span>🔊 ${escapeHtmlAttr(alt || src)}</span>`;
    }
    return `<span class="md-img-pending" data-md-src="${escapeHtmlAttr(src)}" data-md-alt="${escapeHtmlAttr(alt)}">图片加载中…</span>`;
  });
}

/** file:///Users/x.png 或 file:///C:/x.png → 本地路径；不是 file: 返回 null */
export function fileUrlToPath(src: string): string | null {
  const t = src.trim();
  if (!/^file:/i.test(t)) return null;
  try {
    let p = decodeURIComponent(t.replace(/^file:\/\/(localhost)?/i, ""));
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
    return p || null;
  } catch {
    return null;
  }
}

/** md 图片 src → 本地绝对路径；http(s) 返回 null（由调用方决定是否直链显示） */
export function mdImageAbsPath(src: string, fromFile: string): string | null {
  const fromFileUrl = fileUrlToPath(src);
  if (fromFileUrl) return fromFileUrl;
  if (classifyMdHref(src) !== "local") return null;
  return resolveMdPath(fromFile, src);
}

/** md 链接分类：# 锚点 / http(s) 与协议相对 // 外链 / mailto: 等其它协议 / 本地路径（相对与绝对） */
export function classifyMdHref(href: string): MdHrefKind {
  const t = href.trim();
  if (t.startsWith("#")) return "anchor";
  if (/^https?:\/\//i.test(t) || t.startsWith("//")) return "external";
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return "other";
  return "local";
}

/** 去掉 href 的 ?query/#fragment 并 URI 解码（解码失败保留原样） */
export function stripMdHrefSuffix(href: string): string {
  const cut = href.split(/[?#]/, 1)[0];
  try {
    return decodeURIComponent(cut);
  } catch {
    return cut;
  }
}

function isAbsPath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:\//.test(p);
}

/** 折叠 . 与 ..（绝对路径口径：.. 到根/盘符为止不再上爬） */
function foldPathSegments(segs: string[]): string[] {
  const out: string[] = [];
  for (const s of segs) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      // 盘符段不可被 .. 弹掉（C:/.. 仍在盘符根）
      const min = out.length > 0 && /^[A-Za-z]:$/.test(out[0]) ? 1 : 0;
      if (out.length > min && out[out.length - 1] !== "..") out.pop();
      continue;
    }
    out.push(s);
  }
  return out;
}

/** 相对当前 md 文件目录把 href 解析成绝对路径（分隔符归一为 /） */
export function resolveMdPath(fromFile: string, href: string): string {
  const target = stripMdHrefSuffix(href.replace(/\\/g, "/"));
  if (isAbsPath(target)) {
    const segs = foldPathSegments(target.split("/"));
    return `/${segs.join("/")}`.replace(/^\/(?=[A-Za-z]:\/)/, "");
  }
  const dirSegs = fromFile.replace(/\\/g, "/").split("/").slice(0, -1);
  const joined = foldPathSegments([...dirSegs, ...target.split("/")]);
  const prefix = fromFile.startsWith("/") ? "/" : "";
  return `${prefix}${joined.join("/")}`;
}

/** 目标绝对路径 → 相对 fromFile 所在目录的 md 链接路径（../ 回退；跨盘/不同根给绝对路径） */
export function relMdLinkPath(fromFile: string, targetAbs: string): string {
  const normTarget = targetAbs.replace(/\\/g, "/");
  const dir = fromFile.replace(/\\/g, "/").split("/").slice(0, -1);
  const tgt = normTarget.split("/");
  // 前导空段（/ 开头）对齐剔除，盘符段保留用于比较
  const dirSegs = dir.filter((s) => s !== "");
  const tgtSegs = tgt.filter((s) => s !== "");
  if (
    dirSegs.length > 0 &&
    tgtSegs.length > 0 &&
    dirSegs[0] !== tgtSegs[0] &&
    (/^[A-Za-z]:$/.test(dirSegs[0]) || /^[A-Za-z]:$/.test(tgtSegs[0]))
  ) {
    return normTarget; // Windows 跨盘符无法相对
  }
  let i = 0;
  while (i < dirSegs.length && i < tgtSegs.length && dirSegs[i] === tgtSegs[i]) {
    i += 1;
  }
  const ups = dirSegs.length - i;
  const parts = [...Array(ups).fill(".."), ...tgtSegs.slice(i)];
  return parts.length > 0 ? parts.join("/") : normTarget;
}

// ===== 批次 B3：划词翻译 / 生词本 / 段落对照 / 进度记忆 =====

/** 划词/段落翻译的统一 prompt（ai_prompt fnKey="translate"，设置页可配专用小模型）：
 *  纯文本输出（曾有的 bilingual 逐句对照模式已随块级对照改版下线——原文整段由
 *  历史条目的 original 字段承担，不再需要模型输出标记） */
export function buildReaderTranslatePrompt(text: string): string {
  return `把以下学术文献内容翻译为中文。要求：学术语境直译，专业术语保留原词（必要时括注原文），不增减内容，只输出译文，不要任何解释：\n\n${text}`;
}

/** 逐句对照的一对（原句 + 译句） */
export interface BilingualPair {
  src: string;
  zh: string;
}

/** 【兼容 shim，只为旧历史条目服务】bilingual 模式下线前，`ccode.readerTlHistory:*`
 *  里存过带「原：/译：」标记的 raw；渲染/复制/存进笔记时经本函数识别并转纯译文。
 *  新条目永远是纯译文，不会命中。严格校验：至少 1 对、「原」「译」行严格交替成对
 *  （空行只允许出现在对之间；缺对/乱序/空句/混入其他行 → null） */
export function parseBilingual(raw: string): BilingualPair[] | null {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const pairs: BilingualPair[] = [];
  let pendingSrc: string | null = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      if (pendingSrc !== null) return null; // 空行把一对拆开了 = 缺译行
      continue;
    }
    const m = /^(原|译)\s*[:：]\s*(\S[\s\S]*)$/.exec(t);
    if (!m) return null;
    if (m[1] === "原") {
      if (pendingSrc !== null) return null; // 「原」接「原」：上一对缺译
      pendingSrc = m[2];
    } else {
      if (pendingSrc === null) return null; // 「译」在「原」前/多余译行
      pairs.push({ src: pendingSrc, zh: m[2] });
      pendingSrc = null;
    }
  }
  if (pendingSrc !== null) return null; // 末尾缺译行
  return pairs.length > 0 ? pairs : null;
}

/** 【兼容 shim，同上】对照对 → 纯译文（旧条目的渲染/复制/存进笔记都用纯译文，
 *  不把「原：/译：」标记带出去；逐句换行拼接） */
export function plainFromBilingual(pairs: readonly BilingualPair[]): string {
  return pairs.map((p) => p.zh).join("\n");
}

/** 块文本回流（翻译面板/译段用）：PDF 文本层的硬换行与断词是排版产物，阅读时不保留——
 *  `-\n` 断词直接接回（com-\nprised → comprised）；段内单换行英文（cjk:false）合成一个
 *  空格、中文（cjk:true）直接相连不加空格；连续空行压成单个换行（任何情况不留空行）；
 *  每行首尾 trim */
export function reflowBlockText(text: string, opts: { cjk: boolean }): string {
  const joiner = opts.cjk ? "" : " ";
  return text
    .replace(/\r\n/g, "\n")
    .replace(/-\n/g, "")
    .split(/\n\s*\n+/) // 连续空行 = 段落界
    .map((para) =>
      para
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .join(joiner),
    )
    .filter(Boolean)
    .join("\n"); // 段间只留单换行
}

/** 保存译段成功的 toast 口径：笔记栏停在编辑态且有未保存改动时 watcher 停订、
 *  界面不会回显刚写入的译段——文案里明说，否则看起来像「没反应」 */
export function translationSavedToast(noteDirty: boolean): string {
  return noteDirty
    ? "已存到笔记「译段」（笔记栏有未保存改动，保存后可见）"
    : "已存到笔记「译段」";
}

export type ReaderTranslateResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/** 生词本条目（与 Rust GlossaryEntryDto 同形，camelCase 直出） */
export interface GlossaryEntry {
  term: string;
  meaning: string;
  source: string;
}

// ----- 进度记忆与护眼（localStorage，按文件记忆） -----

export const READER_PROGRESS_PREFIX = "ccode.readerProgress.";
export const READER_DARK_PREFIX = "ccode.readerDark.";

export function readerProgressKey(pdfPath: string): string {
  return `${READER_PROGRESS_PREFIX}${pdfPath}`;
}

export function readerDarkKey(pdfPath: string): string {
  return `${READER_DARK_PREFIX}${pdfPath}`;
}

/** 读取记忆的页码（坏值/缺省/localStorage 不可用 → null） */
export function loadReaderProgress(pdfPath: string): number | null {
  try {
    const v = Number(localStorage.getItem(readerProgressKey(pdfPath)));
    return Number.isFinite(v) && v >= 1 ? Math.floor(v) : null;
  } catch {
    return null;
  }
}

export function saveReaderProgress(pdfPath: string, page: number): void {
  try {
    localStorage.setItem(readerProgressKey(pdfPath), String(page));
  } catch {
    /* 隐私模式等写不进就静默 */
  }
}

export function loadReaderDark(pdfPath: string): boolean {
  try {
    return localStorage.getItem(readerDarkKey(pdfPath)) === "1";
  } catch {
    return false;
  }
}

export function saveReaderDark(pdfPath: string, on: boolean): void {
  try {
    localStorage.setItem(readerDarkKey(pdfPath), on ? "1" : "0");
  } catch {
    /* 同上静默 */
  }
}

// ----- 翻译历史（最近翻译条 + 历史抽屉；localStorage 按文件记忆） -----

export const READER_TL_HISTORY_PREFIX = "ccode.readerTlHistory:";
/** 历史上限：先进先出 */
export const READER_TL_HISTORY_MAX = 50;

export interface TlHistoryEntry {
  /** 原文（去重键：同一原文重新翻译 = 替换旧条目并置顶） */
  original: string;
  translated: string;
  page: number;
  /** 「存进笔记」成功的持久标记（跨重开保留 ✓） */
  saved: boolean;
  /** ISO 时间戳（历史抽屉相对时间用 relTime 展示） */
  at: string;
}

export function readerTlHistoryKey(pdfPath: string): string {
  return `${READER_TL_HISTORY_PREFIX}${pdfPath}`;
}

/** 读历史（坏 JSON/非数组/缺字段的脏条目丢弃；localStorage 不可用 → 空） */
export function loadTlHistory(pdfPath: string): TlHistoryEntry[] {
  try {
    const raw = localStorage.getItem(readerTlHistoryKey(pdfPath));
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (e): e is TlHistoryEntry =>
        !!e &&
        typeof e === "object" &&
        typeof (e as TlHistoryEntry).original === "string" &&
        typeof (e as TlHistoryEntry).translated === "string" &&
        typeof (e as TlHistoryEntry).page === "number" &&
        typeof (e as TlHistoryEntry).at === "string",
    );
  } catch {
    return [];
  }
}

export function saveTlHistory(
  pdfPath: string,
  entries: readonly TlHistoryEntry[],
): void {
  try {
    localStorage.setItem(readerTlHistoryKey(pdfPath), JSON.stringify(entries));
  } catch {
    /* 写不进就静默（容量满/隐私模式），历史条降级为当次会话内 */
  }
}

/** 追加/更新一条：同原文 → 替换并置顶（saved 标记沿旧条目保留，重翻不洗掉已存状态）；
 *  新条目置顶；超出上限从尾部（最旧）裁掉。返回新数组（不改入参） */
export function upsertTlEntry(
  entries: readonly TlHistoryEntry[],
  entry: TlHistoryEntry,
): TlHistoryEntry[] {
  const kept = entries.filter((e) => e.original !== entry.original);
  const prev = entries.find((e) => e.original === entry.original);
  const next = { ...entry, saved: prev?.saved ?? entry.saved };
  return [next, ...kept].slice(0, READER_TL_HISTORY_MAX);
}

/** 标记某条「已存进笔记」（按原文定位；找不到原样返回） */
export function markTlEntrySaved(
  entries: readonly TlHistoryEntry[],
  original: string,
): TlHistoryEntry[] {
  return entries.map((e) => (e.original === original ? { ...e, saved: true } : e));
}


// ----- 生词本表格格式（notes/glossary.md） -----
// 格式契约与 src-tauri/src/reader.rs 双端镜像（Rust 负责落盘读写），改动需同步；
// 前端不直接写文件，这组函数是格式的单一可读规格 + 测试锚点。

export const GLOSSARY_HEADER = "| 术语 | 释义 | 出处 |";
export const GLOSSARY_SEP = "| --- | --- | --- |";

/** 单元格转义：| → \|、换行折成空格（表格单行约束） */
export function escapeGlossaryCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/[\r\n]/g, " ");
}

/** 按未转义的 | 切分行（\| 还原为 |），单元格 trim；非 | 起头的行返回空数组 */
export function splitGlossaryRow(line: string): string[] {
  const t = line.trim();
  if (!t.startsWith("|")) return [];
  const cells: string[] = [];
  let cur = "";
  for (let i = 1; i < t.length; i++) {
    const c = t[i];
    if (c === "\\" && t[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  cells.push(cur.trim());
  // 行尾 | 会多收一个空尾单元，去掉
  if (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

/** 分隔行判定：所有单元格只由 - : 空格组成且至少含一个 - */
export function isGlossarySepRow(cells: readonly string[]): boolean {
  return (
    cells.length > 0 &&
    cells.every((c) => c.length > 0 && c.includes("-") && /^[-: ]+$/.test(c))
  );
}

/** 解析 glossary.md 表格行（容错：非表行/表头/分隔行/不足 3 列/空术语一律跳过） */
export function parseGlossaryTable(text: string): GlossaryEntry[] {
  const out: GlossaryEntry[] = [];
  for (const line of text.split("\n")) {
    const cells = splitGlossaryRow(line);
    if (cells.length < 3 || cells[0] === "") continue;
    if (cells[0] === "术语" || isGlossarySepRow(cells.slice(0, 3))) continue;
    out.push({ term: cells[0], meaning: cells[1], source: cells[2] });
  }
  return out;
}

/** 整表渲染（表头 + 分隔 + 数据行，末尾换行收尾） */
export function renderGlossaryTable(entries: readonly GlossaryEntry[]): string {
  const rows = entries.map(
    (e) =>
      `| ${escapeGlossaryCell(e.term)} | ${escapeGlossaryCell(e.meaning)} | ${escapeGlossaryCell(e.source)} |`,
  );
  return `${[GLOSSARY_HEADER, GLOSSARY_SEP, ...rows].join("\n")}\n`;
}

// ----- 段落对照：textLayer 行分组与段边界提取 -----

/** 一条视觉行（top/height 为渲染坐标，text 为该同行文本片拼接） */
export interface PdfTextLine {
  top: number;
  height: number;
  text: string;
}

/** textLayer 原始文本片（left 参与同行内排序） */
export interface RawTextSpan extends PdfTextLine {
  left: number;
}

/** 同一视觉行的 top 容差（px） */
export const LINE_GROUP_TOLERANCE_PX = 2;
/** 行间垂直间隙 > 行高 × 此倍数视为段界 */
export const PARAGRAPH_GAP_RATIO = 1.4;

/** 文本片 → 视觉行：按 top 分组（容差 2px），组内按 left 顺序拼接 */
export function groupTextLines(spans: readonly RawTextSpan[]): PdfTextLine[] {
  const sorted = [...spans].sort((a, b) => a.top - b.top || a.left - b.left);
  const lines: PdfTextLine[] = [];
  for (const s of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(s.top - last.top) <= LINE_GROUP_TOLERANCE_PX) {
      last.text += s.text;
      last.top = Math.min(last.top, s.top);
      last.height = Math.max(last.height, s.height);
    } else {
      lines.push({ top: s.top, height: s.height, text: s.text });
    }
  }
  return lines;
}

/** 相邻两行是否构成段界（垂直间隙 > 1.4 × 较小行高；负间隙 = 行重叠，不算段界） */
export function isParagraphBreak(a: PdfTextLine, b: PdfTextLine): boolean {
  const gap = b.top - (a.top + a.height);
  return gap > PARAGRAPH_GAP_RATIO * Math.min(a.height, b.height);
}

/** 从点击行向上下扩展出段边界（返回闭区间行号） */
export function paragraphBounds(
  lines: readonly PdfTextLine[],
  index: number,
): { start: number; end: number } {
  if (lines.length === 0) return { start: 0, end: -1 };
  const i = Math.min(Math.max(index, 0), lines.length - 1);
  let start = i;
  let end = i;
  while (start > 0 && !isParagraphBreak(lines[start - 1], lines[start])) {
    start--;
  }
  while (end < lines.length - 1 && !isParagraphBreak(lines[end], lines[end + 1])) {
    end++;
  }
  return { start, end };
}

/** 点击 y 坐标命中的行：含则命中，否则取垂直距离最近的行 */
export function nearestLineIndex(lines: readonly PdfTextLine[], y: number): number {
  let best = 0;
  let bestDist = Infinity;
  lines.forEach((l, i) => {
    const dist =
      y < l.top ? l.top - y : y > l.top + l.height ? y - (l.top + l.height) : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  return best;
}

/** 段内视觉行拼成段落全文（行间换行，行尾空白收掉） */
export function joinParagraphLines(lines: readonly PdfTextLine[]): string {
  return lines
    .map((l) => l.text.replace(/\s+$/u, ""))
    .filter((t) => t.length > 0)
    .join("\n")
    .trim();
}

// ----- 术语高亮匹配 -----

export interface GlossaryMatch {
  start: number;
  end: number;
  meaning: string;
}

const WORD_CHAR = /[A-Za-z0-9_]/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 在一段文本里找术语命中（大小写不敏感）：
 *  词首/尾是英文单词字符的术语要求整词边界（相邻不得是单词字符）；
 *  CJK 术语无单词边界概念，按子串命中。长术语优先，命中不重叠。 */
export function findGlossaryMatches(
  text: string,
  terms: readonly Pick<GlossaryEntry, "term" | "meaning">[],
): GlossaryMatch[] {
  if (!text || terms.length === 0) return [];
  // 小写去重（先来的赢）+ 长按降：交替匹配长词优先
  const byLower = new Map<string, string>();
  for (const t of terms) {
    const term = t.term.trim();
    if (!term) continue;
    const key = term.toLowerCase();
    if (!byLower.has(key)) byLower.set(key, t.meaning);
  }
  if (byLower.size === 0) return [];
  const words = [...byLower.keys()].sort((a, b) => b.length - a.length);
  const re = new RegExp(words.map(escapeRegExp).join("|"), "gi");
  const out: GlossaryMatch[] = [];
  let lastEnd = -1;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const hit = m[0];
    const start = m.index;
    const end = start + hit.length;
    const headOk =
      !WORD_CHAR.test(hit[0]) || start === 0 || !WORD_CHAR.test(text[start - 1]);
    const tailOk =
      !WORD_CHAR.test(hit[hit.length - 1]) ||
      end === text.length ||
      !WORD_CHAR.test(text[end]);
    if (headOk && tailOk && start >= lastEnd) {
      out.push({ start, end, meaning: byLower.get(hit.toLowerCase()) ?? "" });
      lastEnd = end;
    }
    if (hit.length === 0) re.lastIndex++; // 空词防死循环（正常到不了这里）
  }
  return out;
}

/**
 * 连续阅读的渲染窗口（2026-11-05 用户：滚动卡）：可见页 ±margin 挂 canvas + 文本层；已画过的页滚出去后
 * 在 ±keep 内先留着（来回滚不重画），出了才卸载。seen = null 表示文档还没打开。
 * 旧写法下界从 1 起算再取 min，恒为第 1 页——滚到第 N 页时 1…N+2 页全挂着，越往后越卡。
 */
export function pdfRenderWindow(
  seen: ReadonlySet<number> | null,
  prevMounted: ReadonlySet<number>,
  pageCount: number,
  margin: number,
  keep: number,
): { renderRange: { lo: number; hi: number }; mounted: ReadonlySet<number> } {
  const mounted = new Set<number>();
  if (!seen) return { renderRange: { lo: 1, hi: 0 }, mounted };
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const n of seen) {
    lo = Math.min(lo, n);
    hi = Math.max(hi, n);
  }
  if (lo === Number.POSITIVE_INFINITY) lo = hi = 1;
  const renderRange = { lo: Math.max(1, lo - margin), hi: Math.min(pageCount, hi + margin) };
  for (const n of prevMounted) {
    if (n >= lo - keep && n <= hi + keep && n >= 1 && n <= pageCount) mounted.add(n);
  }
  for (let n = renderRange.lo; n <= renderRange.hi; n++) mounted.add(n);
  return { renderRange, mounted };
}

// ===== 对照窗（2026-11-05 用户：读文献时想对照着图看，图一般在后面几页）=====
// 把一块 PDF 区域（圈选钉住的，或某张图所在的整页）钉在 PDF 栏上方的小窗里，正文照常滚、窗不动。

/** 对照窗里的一项：页号 + 页内区域（0–1 比例，null = 整页）+ 整页时先滚到的高度（图注位置，0–1） */
export interface PdfPeekItem {
  key: string;
  page: number;
  label: string;
  region: { x: number; y: number; w: number; h: number } | null;
  focusY?: number | null;
  /** 区域是自动框出来的（窗顶提示「不对就重新框」）；用户框过 / 圈选的为 false */
  auto?: boolean;
}

/** 对照窗位置与大小（窗口 px，2026-11-05 用户：钉在 PDF 栏里太小，改成整窗可拖的浮窗），记在 localStorage，换篇不丢 */
export interface PdfPeekWin {
  x: number;
  y: number;
  w: number;
  h: number;
}
// 改了坐标域（PDF 栏 → 整窗）换新键，旧的栏内坐标不再沿用
export const PDF_PEEK_WIN_KEY = "ccode.readerPeekFloat";
export const PDF_PEEK_MIN_W = 220;
export const PDF_PEEK_MIN_H = 160;
/** 顶部留给阅读区顶栏，窗头不压住「← 返回」那一行 */
export const PDF_PEEK_TOP = 44;

/** 把窗收进容器：先限大小（不超过容器、不小于下限），再限位置（窗头始终可抓） */
export function clampPdfPeekWin(win: PdfPeekWin, box: { w: number; h: number }): PdfPeekWin {
  const maxW = Math.max(PDF_PEEK_MIN_W, box.w - 8);
  const maxH = Math.max(PDF_PEEK_MIN_H, box.h - PDF_PEEK_TOP - 4);
  const w = Math.min(maxW, Math.max(PDF_PEEK_MIN_W, Math.round(win.w)));
  const h = Math.min(maxH, Math.max(PDF_PEEK_MIN_H, Math.round(win.h)));
  const x = Math.min(Math.max(4, Math.round(win.x)), Math.max(4, box.w - w - 4));
  const y = Math.min(Math.max(PDF_PEEK_TOP, Math.round(win.y)), Math.max(PDF_PEEK_TOP, box.h - h - 4));
  return { x, y, w, h };
}

/** 没记过的默认：窗口一半宽、六成高，横向居中、靠上 */
export function defaultPdfPeekWin(box: { w: number; h: number }): PdfPeekWin {
  const w = Math.max(420, Math.round(box.w * 0.5));
  const h = Math.max(320, Math.round(box.h * 0.6));
  return clampPdfPeekWin({ x: (box.w - w) / 2, y: PDF_PEEK_TOP + box.h * 0.08, w, h }, box);
}

/** 窗里的适配倍率：圈选的区域整块装进窗里（宽高都不超）；整页按窗宽（再滚到图注） */
export function pdfPeekFitScale(
  region: { w: number; h: number },
  body: { w: number; h: number },
  wholePage: boolean,
): number {
  const byW = Math.max(40, body.w - 2) / region.w;
  if (wholePage) return byW;
  return Math.min(byW, Math.max(40, body.h - 2) / region.h);
}

export function loadPdfPeekWin(): PdfPeekWin | null {
  try {
    const raw = JSON.parse(localStorage.getItem(PDF_PEEK_WIN_KEY) ?? "null");
    if (raw && [raw.x, raw.y, raw.w, raw.h].every((v) => Number.isFinite(v))) return raw as PdfPeekWin;
  } catch {
    /* 坏值当没记过 */
  }
  return null;
}

export function savePdfPeekWin(win: PdfPeekWin): void {
  try {
    localStorage.setItem(PDF_PEEK_WIN_KEY, JSON.stringify(win));
  } catch {
    /* 存不下只是下次回默认 */
  }
}

/** 圈选框（client 坐标）→ 页内 0–1 区域，按页 canvas 的 client 矩形换算；夹在页内 */
export function captureRectToPageRegion(
  sel: { x: number; y: number; w: number; h: number },
  pageRect: { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number } | null {
  if (pageRect.w <= 0 || pageRect.h <= 0) return null;
  const x0 = Math.max(0, (sel.x - pageRect.x) / pageRect.w);
  const y0 = Math.max(0, (sel.y - pageRect.y) / pageRect.h);
  const x1 = Math.min(1, (sel.x + sel.w - pageRect.x) / pageRect.w);
  const y1 = Math.min(1, (sel.y + sel.h - pageRect.y) / pageRect.h);
  if (x1 - x0 <= 0.005 || y1 - y0 <= 0.005) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 整页对照时先滚到哪：图注多在图下方，让图注落在窗下方约八成处，上面露出图 */
export function pdfPeekScrollTop(focusY: number, contentH: number, viewH: number): number {
  const target = focusY * contentH - viewH * 0.8;
  return Math.max(0, Math.min(Math.round(target), Math.max(0, contentH - viewH)));
}

/** 用户在对照窗里「重新框」的图区域：按 PDF 路径 + 图号记（第二期，自动框认错了以它为准） */
export const PDF_FIG_REGION_KEY = "ccode.readerFigRegions";
type FigRegion = { x: number; y: number; w: number; h: number };

function readFigRegions(): Record<string, Record<string, FigRegion>> {
  try {
    const raw = JSON.parse(localStorage.getItem(PDF_FIG_REGION_KEY) ?? "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function loadFigRegion(pdfPath: string, figKey: string): FigRegion | null {
  const r = readFigRegions()[pdfPath]?.[figKey];
  return r && [r.x, r.y, r.w, r.h].every((v) => Number.isFinite(v)) ? r : null;
}

export function saveFigRegion(pdfPath: string, figKey: string, region: FigRegion): void {
  const all = readFigRegions();
  all[pdfPath] = { ...(all[pdfPath] ?? {}), [figKey]: region };
  // 只留最近 200 篇
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete all[k];
  try {
    localStorage.setItem(PDF_FIG_REGION_KEY, JSON.stringify(all));
  } catch {
    /* 存不下只是下次再自动框 */
  }
}
