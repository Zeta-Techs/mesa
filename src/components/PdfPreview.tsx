import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import PreviewErrorState from "./PreviewErrorState";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
// textLayer 的官方样式（选区/定位规则）；随本组件进懒加载 chunk
import "pdfjs-dist/web/pdf_viewer.css";
import SelectionFloatBar, { DistillSkillButton } from "./SelectionFloatBar";
import { HoverTip, useHoverTip } from "./HoverTip";
import { IS_MAC, IS_WINDOWS } from "../hotkeys";
import { usePdfGestureZoom } from "./use-pdf-zoom";
import { RenderGate } from "../render-gate";
import {
  PDF_ZOOM_STEP,
  clampPdfScale,
  findGlossaryMatches,
  nextFitScale,
  pdfCanvasOutputScale,
  type GlossaryEntry,
} from "../reader";
import {
  buildSearchStream,
  findAllInStream,
  matchSegments,
  mergeLineRects,
  quoteSearchCandidates,
  type PdfMarkRect,
  type PdfTextPiece,
} from "../pdf-search";
import { InlineNotice } from "./PageFrame";

// vite 惯例：worker 走 ?url 资源，不进主包（本组件整体被动态 import）
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** 打开 PDF 文档的单一入口（预览与连续滚动共用）。
 *  Windows WebView2 的 ImageDecoder 会把部分 JPEG/JBIG2 解成空白位图（整页白屏），
 *  关掉后走 pdf.js 自带解码；macOS WKWebView 无此问题，保持默认加速。 */
export function openPdfDocument(
  data: Uint8Array,
): pdfjs.PDFDocumentLoadingTask {
  return pdfjs.getDocument({
    data,
    isImageDecoderSupported: !IS_WINDOWS,
  });
}

export interface PdfBytesDto {
  data: string; // base64（macOS WKWebView 的 raw bytes 响应会退化成数字数组，故走字符串）
  size: number;
}

/** 模块级 PDF 字节缓存：path→已解码字节（上限 8 份 LRU）。
 *  阅读区/文件页预览/项目页文件页各自新挂载 PdfContinuousView/PdfPreview 时，
 *  read_pdf_bytes 的大文件 IPC（Rust 读盘→base64 传输）+ atob 解码 + pdf.js 解析
 *  都是整栏骨架期；字节缓存命中后只剩 pdf.js 解析一程，打开感知接近即时。
 *  缓存命中必须复制再返回：pdf.js getDocument 会把传入的 buffer 转给 worker
 *  （transfer，原数组被 neuter），同一 Uint8Array 第二次打开同文件时已是
 *  失效对象，再传会抛 DataCloneError（The object can not be cloned） */
const PDF_BYTES_CACHE_MAX = 8;
const pdfBytesCache = new Map<string, Uint8Array>();

/** 读 PDF 字节：先查缓存，miss 走 read_pdf_bytes 白名单，命中后把键挪到队尾 */
export async function loadPdfBytes(
  path: string,
  cwdHint: string | null,
): Promise<Uint8Array> {
  const key = `${cwdHint ?? ""}${path}`;
  const hit = pdfBytesCache.get(key);
  if (hit) {
    pdfBytesCache.delete(key);
    pdfBytesCache.set(key, hit);
    // 复制一份：pdf.js 会 neuter 传入的 buffer，缓存里的原件必须保持可用
    return hit.slice();
  }
  const dto = await invoke<PdfBytesDto>("read_pdf_bytes", { path, cwdHint });
  const bytes = base64ToBytes(dto.data);
  pdfBytesCache.set(key, bytes);
  while (pdfBytesCache.size > PDF_BYTES_CACHE_MAX) {
    const oldest = pdfBytesCache.keys().next().value;
    if (oldest === undefined) break;
    pdfBytesCache.delete(oldest);
  }
  return bytes.slice();
}

/** base64 → Uint8Array（atob 分块，避免大文件一次性函数调用栈/参数上限） */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  const CHUNK = 0x8000;
  for (let i = 0; i < bin.length; i += CHUNK) {
    const slice = bin.slice(i, i + CHUNK);
    for (let j = 0; j < slice.length; j++) out[i + j] = slice.charCodeAt(j);
  }
  return out;
}

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** 单页视图：canvas 渲染 + textLayer 选区层；display:none 时保持已渲染内容不销毁。
 *  export：阅读区的连续滚动视图（PdfContinuousView）按页复用（active 恒 true）。
 *  fillParent：宿主 100% 填页盒（页盒尺寸由父级按布局倍率给）。
 *  renderScale：渲染倍率（缺省 = scale）。缩放期间布局倍率 scale 先行、渲染倍率
 *  停稳才跟上——旧位图 CSS 拉伸兜底，定格时布局零变化只换清晰位图（官方 viewer
 *  drawingDelay 同款，见 use-pdf-zoom.ts）。 */
/** PDF 位图渲染闸：同一时刻最多 2 页在渲——换挡（栏收起/拖拽/缩放停稳）后的
 *  补渲爆发被拆到不同帧，等闸页旧位图 CSS 拉伸兜底（机制见 render-gate.ts） */
const pageRenderGate = new RenderGate(2);

/** 页内高亮：查找命中、笔记标注、跳转时的一闪、译文卡开着时它的原文段（source）。
 *  quote 为原文摘句（页内按 pdf-search 口径重定位，不存坐标——缩放、重渲后都能重新落位）；
 *  nth = 第几处命中（0 起），"all" = 本页全部 */
export interface PdfPageMark {
  id: string;
  quote: string;
  nth: number | "all";
  kind: "find" | "find-active" | "note" | "flash" | "source";
}

/** 页内高亮的矩形（页内百分比坐标） */
interface MarkBox {
  id: string;
  kind: PdfPageMark["kind"];
  rects: PdfMarkRect[];
}

/** 文本层里一个文本片内 [from, to) 的 Range（片内可能被生词高亮拆成多个文本节点） */
function rangeInSpan(span: Element, from: number, to: number): Range | null {
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let startNode: Text | null = null;
  let startOff = 0;
  const range = document.createRange();
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const len = node.data.length;
    if (!startNode && from < pos + len) {
      startNode = node;
      startOff = from - pos;
      range.setStart(node, startOff);
    }
    if (startNode && to <= pos + len) {
      range.setEnd(node, to - pos);
      return range;
    }
    pos += len;
  }
  return null;
}

/** 在已渲染的文本层里给标记算矩形（页宿主百分比坐标）。找不到的标记跳过；
 *  摘句按 quoteCandidates 依次试（原样 → 去掉词内连字符 → 前 60 字） */
function measureMarks(
  host: HTMLElement,
  layer: HTMLElement,
  marks: readonly PdfPageMark[],
): MarkBox[] {
  const pieces: PdfTextPiece[] = [];
  const spans: Element[] = [];
  layer
    .querySelectorAll('span[role="presentation"], br[role="presentation"]')
    .forEach((el) => {
      if (el.tagName === "BR") {
        if (pieces.length > 0) pieces[pieces.length - 1].eol = true;
        return;
      }
      pieces.push({ text: el.textContent ?? "", eol: false });
      spans.push(el);
    });
  if (pieces.length === 0) return [];
  const stream = buildSearchStream(pieces);
  const hr = host.getBoundingClientRect();
  if (hr.width <= 0 || hr.height <= 0) return [];
  const out: MarkBox[] = [];
  for (const mark of marks) {
    let q = "";
    let starts: number[] = [];
    // 查找命中只认原样（第 k 处要与页级计数对齐）；标注/一闪按候选写法依次试
    const exact = mark.kind === "find" || mark.kind === "find-active";
    for (const cand of quoteSearchCandidates(mark.quote, exact)) {
      starts = findAllInStream(stream, cand);
      if (starts.length > 0) {
        q = cand;
        break;
      }
    }
    const picked =
      mark.nth === "all" ? starts : starts[mark.nth] === undefined ? [] : [starts[mark.nth]];
    for (const at of picked) {
      const px: PdfMarkRect[] = [];
      for (const seg of matchSegments(stream, at, q.length)) {
        const range = rangeInSpan(spans[seg.piece], seg.from, seg.to);
        if (!range) continue;
        for (const r of Array.from(range.getClientRects())) {
          px.push({ x: r.left - hr.left, y: r.top - hr.top, w: r.width, h: r.height });
        }
      }
      const rects = mergeLineRects(px).map((r) => ({
        x: (r.x / hr.width) * 100,
        y: (r.y / hr.height) * 100,
        w: (r.w / hr.width) * 100,
        h: (r.h / hr.height) * 100,
      }));
      if (rects.length > 0) out.push({ id: mark.id, kind: mark.kind, rects });
    }
  }
  return out;
}

const NO_MARKS: readonly PdfPageMark[] = [];

export const PdfPageView = memo(function PdfPageView({
  doc,
  pageNum,
  scale,
  renderScale,
  active,
  glossTerms,
  fillParent,
  marks = NO_MARKS,
  scrollTo,
  onScrolledTo,
}: {
  doc: pdfjs.PDFDocumentProxy;
  pageNum: number;
  /** 布局倍率：页盒尺寸立即跟随 */
  scale: number;
  /** 渲染倍率：canvas/textLayer 重建按它；缺省 = scale */
  renderScale?: number;
  active: boolean;
  /** 生词高亮术语表（阅读区 B3；空/缺省不高亮） */
  glossTerms?: readonly GlossaryEntry[];
  /** 连续滚动页盒已定尺寸时填满父级，backing store 仍按渲染倍率渲染 */
  fillParent?: boolean;
  /** 页内高亮（查找/标注/跳转一闪），同内容换引用不重算 */
  marks?: readonly PdfPageMark[];
  /** 把某个标记滚到视野中央（nonce 每次跳转递增，同一处再跳也生效） */
  scrollTo?: { id: string; nonce: number } | null;
  /** 滚过去了：上层据此清掉这次跳转——否则页离窗卸载、再滚回来重挂时会又被拽一次 */
  onScrolledTo?: (nonce: number) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  /** textLayer 渲染完成信号（计数器）：术语高亮等它落地后再跑 */
  const [textRendered, setTextRendered] = useState(0);
  /** scale=1 的页尺寸缓存：布局倍率变化时同步换算页盒，不等渲染链路 */
  const baseSizeRef = useRef<{ w: number; h: number } | null>(null);
  const rs = renderScale ?? scale;
  const [markBoxes, setMarkBoxes] = useState<MarkBox[]>([]);
  const marksKey = JSON.stringify(marks);
  const scrolledNonceRef = useRef(0);

  // 页盒尺寸立即跟随布局倍率（不等 canvas 重绘，缩放手感的跟手性来自这里）
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (fillParent) {
      host.style.width = "100%";
      host.style.height = "100%";
      return;
    }
    const base = baseSizeRef.current;
    if (!base) return; // 首页尚未量到，等渲染链路补尺寸
    host.style.width = `${Math.floor(base.w * scale)}px`;
    host.style.height = `${Math.floor(base.h * scale)}px`;
  }, [scale, fillParent]);

  // 缩放进行中（渲染倍率未跟上布局倍率）藏起 textLayer：旧文本片坐标已不匹配
  // 新页盒，错位叠在拉伸位图上比暂时不显示更脏；选段/高亮等重渲落地即恢复
  useEffect(() => {
    const layer = textRef.current;
    if (!layer) return;
    layer.style.visibility = rs === scale ? "" : "hidden";
  }, [scale, rs, textRendered]);

  // 拖选时给 textLayer 挂 selecting 类（官方 viewer 的 TextLayerBuilder 同款）：
  // pdf_viewer.css 里 .selecting 的 endOfContent 会撑满整层接住指针，
  // 拖过末行之下选区仍能扩到页尾
  useEffect(() => {
    const layer = textRef.current;
    if (!layer) return;
    const on = () => layer.classList.add("selecting");
    const off = () => layer.classList.remove("selecting");
    layer.addEventListener("mousedown", on);
    document.addEventListener("pointerup", off);
    window.addEventListener("blur", off);
    return () => {
      layer.removeEventListener("mousedown", on);
      document.removeEventListener("pointerup", off);
      window.removeEventListener("blur", off);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let renderTask: pdfjs.RenderTask | null = null;
    let textLayer: pdfjs.TextLayer | null = null;
    let drawLayer: pdfjs.DrawLayer | null = null;
    void (async () => {
      let releaseSlot: (() => void) | null = null;
      try {
        // 换挡重渲从排队起先藏 textLayer：旧坐标错位叠在新拉伸位图上更脏，
        // 等闸会拉长这个窗口；本页重建完成后由 textRendered 触发既有可见性效果恢复
        if (textRef.current) textRef.current.style.visibility = "hidden";
        const page = await doc.getPage(pageNum);
        if (cancelled) return;
        releaseSlot = await pageRenderGate.acquire();
        if (cancelled) return;
        const viewport = page.getViewport({ scale: rs });
        const baseVp = page.getViewport({ scale: 1 });
        baseSizeRef.current = { w: baseVp.width, h: baseVp.height };
        const dpr = window.devicePixelRatio || 1;
        const cssW = Math.floor(viewport.width);
        const cssH = Math.floor(viewport.height);
        const out = pdfCanvasOutputScale(cssW, cssH, dpr);
        // 离屏画完再换上：一改可见 canvas.width 会立刻清空当前帧，缩放提交时闪/抖
        const off = document.createElement("canvas");
        off.width = Math.max(1, Math.floor(cssW * out.sx));
        off.height = Math.max(1, Math.floor(cssH * out.sy));
        const offCtx = off.getContext("2d", {
          alpha: true,
          willReadFrequently: true,
        });
        if (!offCtx) throw new Error("无法创建画布");
        const needScale =
          Math.abs(out.sx - 1) > 1e-6 || Math.abs(out.sy - 1) > 1e-6;
        renderTask = page.render({
          canvas: off,
          viewport,
          transform: needScale ? [out.sx, 0, 0, out.sy, 0, 0] : undefined,
        });
        await renderTask.promise;
        if (cancelled) return;
        const canvas = canvasRef.current;
        const host = hostRef.current;
        if (!canvas || !host) return;
        const visCtx = canvas.getContext("2d", {
          alpha: true,
          willReadFrequently: true,
        });
        if (!visCtx) throw new Error("无法创建画布");
        canvas.width = off.width;
        canvas.height = off.height;
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        visCtx.drawImage(off, 0, 0);
        // 页盒尺寸由 layout effect 按布局倍率即时维护；这里只兜底首量前的情况
        if (fillParent) {
          host.style.width = "100%";
          host.style.height = "100%";
        } else if (!host.style.width) {
          host.style.width = `${Math.floor(baseVp.width * scale)}px`;
          host.style.height = `${Math.floor(baseVp.height * scale)}px`;
        }
        // textLayer 字号按 --total-scale-factor 换算（pdf_viewer.css 变量约定 =
        // 名义倍率 × userUnit，即 viewport.scale × viewport.userUnit）
        host.style.setProperty(
          "--total-scale-factor",
          String(viewport.scale * viewport.userUnit),
        );
        // pdf.js 的 TextLayer 只往容器 append 不清空：重渲染前先清，
        // 否则缩放/重排后选段与高亮都会叠出重复文本片
        textRef.current!.replaceChildren();
        const text = new pdfjs.TextLayer({
          textContentSource: page.streamTextContent(),
          container: textRef.current!,
          viewport,
        });
        textLayer = text;
        // 选区高亮交给 pdf.js v6 的 DrawLayer 自绘（整页 div + SVG clip 贴字形）：
        // 原生 ::selection 在 scaleX 变换的文本片上溢出/错位，官方 viewer 因此默认
        // enableSelectionRendering 自绘并关掉原生高亮（.selectionRendering，pdf_viewer.css）
        drawLayer = new pdfjs.DrawLayer({
          pageIndex: pageNum - 1,
          textLayer: textRef.current!,
        });
        drawLayer.setParent(host);
        await text.render();
        if (!cancelled) {
          // 页尾捕手（官方 viewer 的 endOfContent，配合上面 selecting 类生效）；
          // DrawLayer 的 MutationObserver 也靠它感知重渲染后重算选区高亮
          const end = document.createElement("div");
          end.className = "endOfContent";
          textRef.current!.append(end);
          setTextRendered((c) => c + 1);
        }
      } catch (e) {
        // 取消渲染不算错误（翻页/缩放打断上一帧）
        if (!cancelled && !(e instanceof pdfjs.RenderingCancelledException)) {
          setError(String(e));
        }
      } finally {
        releaseSlot?.();
      }
    })();
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
      drawLayer?.destroy();
    };
  }, [doc, pageNum, rs, fillParent]);

  // 术语高亮：textLayer 落地后（或术语表增删后）对文本节点跑整词匹配，命中处包
  // <span class="ccode-gloss">（点状下划线，悬停释义由 PdfContinuousView 事件代理出 HoverTip）；
  // cleanup 先还原旧高亮再重包，幂等可重入
  useEffect(() => {
    const container = textRef.current;
    if (!container || textRendered === 0 || !glossTerms || glossTerms.length === 0) {
      return;
    }
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) {
      const n = walker.currentNode as Text;
      if (!n.data.trim()) continue;
      if (n.parentElement?.closest(".ccode-gloss")) continue;
      nodes.push(n);
    }
    for (const node of nodes) {
      const matches = findGlossaryMatches(node.data, glossTerms);
      if (matches.length === 0) continue;
      const frag = document.createDocumentFragment();
      let pos = 0;
      for (const m of matches) {
        if (m.start > pos) {
          frag.append(document.createTextNode(node.data.slice(pos, m.start)));
        }
        const span = document.createElement("span");
        span.className = "ccode-gloss";
        span.dataset.meaning = m.meaning;
        span.textContent = node.data.slice(m.start, m.end);
        frag.append(span);
        pos = m.end;
      }
      frag.append(document.createTextNode(node.data.slice(pos)));
      node.parentNode?.replaceChild(frag, node);
    }
    return () => {
      container.querySelectorAll(".ccode-gloss").forEach((el) => {
        el.replaceWith(...Array.from(el.childNodes));
      });
      container.normalize();
    };
  }, [textRendered, glossTerms]);

  // 页内高亮：textLayer 落地后（或标记变化后）按摘句重定位算矩形；矩形存页内百分比，
  // 布局倍率先行的缩放过程中不失位，重渲落地再按新文本层重算一次
  useEffect(() => {
    const host = hostRef.current;
    const layer = textRef.current;
    if (!host || !layer || textRendered === 0 || marks.length === 0) {
      setMarkBoxes((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    setMarkBoxes(measureMarks(host, layer, marks));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textRendered, marksKey]);

  // 跳转定位：目标标记落地后滚到视野中央（同一 nonce 只滚一次）
  useEffect(() => {
    if (!scrollTo || scrolledNonceRef.current === scrollTo.nonce) return;
    const el = hostRef.current?.querySelector(`[data-mark-id="${scrollTo.id}"]`);
    if (!el) return;
    scrolledNonceRef.current = scrollTo.nonce;
    el.scrollIntoView({ block: "center", inline: "nearest" });
    onScrolledTo?.(scrollTo.nonce);
  }, [scrollTo, markBoxes, onScrolledTo]);

  return (
    <div
      ref={hostRef}
      data-page-num={pageNum}
      className={`relative bg-white ${fillParent ? "h-full w-full" : ""} ${active ? "" : "hidden"}`}
    >
      <canvas ref={canvasRef} className="block h-full w-full bg-white" />
      {markBoxes.length > 0 && (
        // 高亮层在文本层之下、不接指针：选字/复制行为不变；缩放未停稳时与文本层同进退
        <div
          className="ccode-pdf-marks"
          style={{ visibility: rs === scale ? undefined : "hidden" }}
        >
          {markBoxes.flatMap((b) =>
            b.rects.map((r, i) => (
              <div
                key={`${b.id}-${i}`}
                data-mark-id={b.id}
                className={`ccode-mark ccode-mark-${b.kind}`}
                style={{
                  left: `${r.x}%`,
                  top: `${r.y}%`,
                  width: `${r.w}%`,
                  height: `${r.h}%`,
                }}
              />
            )),
          )}
        </div>
      )}
      {/* selectionRendering：关掉原生 ::selection（透明化），高亮由 DrawLayer 自绘 */}
      <div ref={textRef} className="textLayer selectionRendering" />
      {error && (
        <InlineNotice tone="err" className="absolute inset-x-0 top-0 bg-strip px-3 py-1">第 {pageNum} 页渲染失败：{error}</InlineNotice>
      )}
    </div>
  );
});

/** 「整理为笔记」结果：ok 决定是否清空选区；action 为可选快捷入口 */
export interface PdfActionResult {
  ok: boolean;
  msg: string;
  action?: { label: string; run: () => void };
}

/** 浮动按钮旁展示的轻量提示（可带一个快捷动作） */
interface Hint {
  msg: string;
  action?: { label: string; run: () => void };
}

/**
 * PDF 内嵌预览（§11.4 P2a）：pdf.js canvas + textLayer（可选区），
 * 只渲染当前页与相邻页（大 PDF 不做整本渲染）。
 * 字节经 read_pdf_bytes 加载（后端四类白名单约束）；选中文字出现浮动按钮：
 * 「◈ 问 AI」把选段 + 出处交给调用方写入活跃终端输入（「↵ 直接发送」立即回车发送）；
 * 「整理为笔记」把选段追加到归属项目的 notes/excerpts.md（P2b，由调用方实现：精读工作区在跑写工作区，否则写项目根）。
 */
function PdfPreview({
  path,
  cwdHint,
  onAskAi,
  onOrganize,
  onOpenReader,
}: {
  path: string;
  /** 终端标签 cwd / 文件树根：后端白名单的第四类来源 */
  cwdHint: string | null;
  /** 返回 null 表示已写入；返回字符串为要给用户看的提示（如无运行中 agent）。send=true 直接发送 */
  onAskAi?: (
    text: string,
    page: number,
    fileName: string,
    send?: boolean,
  ) => string | null | Promise<string | null>;
  /** P2b：整理为笔记；返回展示给用户的提示（ok 决定是否清空选区） */
  onOrganize?: (
    text: string,
    page: number,
    fileName: string,
  ) => Promise<PdfActionResult>;
  /** 「⛶ 沉浸阅读」入口（批次 B1 阅读区）：归属项目解析与失败提示由调用方负责 */
  onOpenReader?: () => void;
}) {
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [pageInput, setPageInput] = useState("1");
  /** null = 适配宽度模式（随容器宽度换算） */
  const [fixedScale, setFixedScale] = useState<number | null>(null);
  const [fitScale, setFitScale] = useState(1);
  const [hint, setHint] = useState<Hint | null>(null);
  const [organizing, setOrganizing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fitScaleRef = useRef(fitScale);
  fitScaleRef.current = fitScale;
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 「⛶ 沉浸阅读」钮的应用内 tooltip（原生 title 在 WKWebView 上行为不稳定）
  const readerBtnRef = useRef<HTMLButtonElement>(null);
  const readerTip = useHoverTip(readerBtnRef);
  const scale = fixedScale ?? fitScale;

  // 手势缩放（⌘/Ctrl+滚轮 + 触控板 pinch）：与阅读区连续滚动同一套共享绑定；
  // 布局倍率立即跟随，renderScale 停稳才追上（canvas/textLayer 重建按它）
  const { renderScale, liveZoomingRef } = usePdfGestureZoom({
    scrollRef,
    scale,
    enabled: Boolean(doc),
    onCommit: (next) => setFixedScale(next),
    anchorSelector: "[data-page-num]",
  });

  const fileName = basename(path);

  // 加载文档（路径切换整体重来）
  useEffect(() => {
    let cancelled = false;
    let task: pdfjs.PDFDocumentLoadingTask | null = null;
    setDoc(null);
    setError(null);
    setPageNum(1);
    setPageInput("1");
    setFixedScale(null);
    void (async () => {
      try {
        const bytes = await loadPdfBytes(path, cwdHint);
        if (cancelled) return;
        task = openPdfDocument(bytes);
        const loaded = await task.promise;
        if (cancelled) {
          void task.destroy();
          return;
        }
        setPageCount(loaded.numPages);
        setDoc(loaded);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [path, cwdHint, retry]);

  // 适配宽度：量首页原始宽度换算 scale；容器尺寸变化（分栏拖拽）时重算
  useEffect(() => {
    if (!doc || fixedScale !== null) return;
    const el = scrollRef.current;
    if (!el) return;
    let cancelled = false;
    const compute = async () => {
      try {
        const page = await doc.getPage(pageNum);
        if (cancelled) return;
        // 手势缩放进行中不重算适配（会改掉布局基准，锚点漂移）
        if (liveZoomingRef.current) return;
        const w = page.getViewport({ scale: 1 }).width;
        const avail = el.clientWidth - 24; // 左右留白
        const next = nextFitScale(w, avail, fitScaleRef.current);
        if (next !== null) setFitScale(next);
      } catch {
        /* 页读取失败交给渲染层报错 */
      }
    };
    void compute();
    const ro = new ResizeObserver(() => {
      void compute();
    });
    ro.observe(el);
    return () => {
      cancelled = true;
      ro.disconnect();
    };
  }, [doc, pageNum, fixedScale]);

  // 翻页后回到内容顶部（仅翻页；缩放提交由手势锚点接管，不回顶）
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageNum]);

  const showHint = useCallback((h: Hint) => {
    setHint(h);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setHint(null), 3000);
  }, []);
  useEffect(
    () => () => {
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    },
    [],
  );

  // 选区浮动按钮条的监听/定位已抽为共享组件 SelectionFloatBar（md 阅读视图同款复用）

  /** 抽取当前选段与所在页码（锚点落在 textLayer 的 data-page-num 节点上） */
  function selectedExcerpt(): { text: string; page: number } | null {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    if (!text || !sel) return null;
    const node = sel.anchorNode;
    const el =
      node?.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node?.parentElement;
    const page =
      Number(el?.closest("[data-page-num]")?.getAttribute("data-page-num")) ||
      pageNum;
    return { text, page };
  }

  // 清选区后 selectionchange 会自动收起浮动按钮条，无需手动隐藏
  function clearSelection() {
    window.getSelection()?.removeAllRanges();
  }

  function askAi(send?: boolean) {
    const excerpt = selectedExcerpt();
    if (!excerpt) return;
    void Promise.resolve(
      onAskAi?.(excerpt.text, excerpt.page, fileName, send) ??
        "当前页面不支持问 AI",
    ).then((err) => {
      showHint({
        msg:
          err ??
          (send ? "已发送到活跃终端" : "已写入活跃终端的输入框，检查后自行发送"),
      });
      if (!err) clearSelection();
    });
  }

  /** P2b：选段 → 归属项目的笔记工作区 notes/inbox.md；失败不静默（提示条展示原因） */
  async function organize() {
    if (organizing) return;
    const excerpt = selectedExcerpt();
    if (!excerpt || !onOrganize) return;
    setOrganizing(true);
    try {
      const r = await onOrganize(excerpt.text, excerpt.page, fileName);
      showHint({ msg: r.msg, action: r.action });
      if (r.ok) clearSelection();
    } catch (e) {
      showHint({ msg: `整理为笔记失败：${String(e)}` });
    } finally {
      setOrganizing(false);
    }
  }

  function goPage(n: number) {
    const next = Math.min(pageCount, Math.max(1, n));
    setPageNum(next);
    setPageInput(String(next));
  }

  const zoomBtn =
    "flex h-6 min-w-6 items-center justify-center rounded-sm px-1 text-xs text-l3 hover:bg-hover hover:text-l1 disabled:opacity-40";
  const zoomGestureHint = IS_MAC
    ? "⌘/Ctrl+滚轮或双指捏合缩放，中键拖动平移"
    : "Ctrl+滚轮或触控板捏合缩放，中键拖动平移";

  // 只挂载当前页 ±1（相邻页预渲染在隐藏状态，翻页即时可见），不整本渲染
  const pages = doc
    ? [pageNum - 1, pageNum, pageNum + 1].filter((n) => n >= 1 && n <= pageCount)
    : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 bg-strip px-3 py-1.5 text-xs">
        <span className="truncate text-l3" title={path}>
          {fileName}
        </span>
        <span className="shrink-0 rounded-sm bg-inset px-1 text-l4">PDF</span>
        {onOpenReader && (
          <>
            <button
              ref={readerBtnRef}
              type="button"
              aria-label="打开沉浸阅读"
              onMouseEnter={readerTip.show}
              onMouseLeave={readerTip.hide}
              onClick={onOpenReader}
              className="flex h-6 shrink-0 items-center rounded-sm px-1.5 text-xs text-l3 hover:bg-hover hover:text-l1"
            >
              ⛶ 沉浸阅读
            </button>
            <HoverTip tip={readerTip.tip} text="笔记 · PDF · 对话 三栏并排" />
          </>
        )}
        {doc && (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <button
              className={zoomBtn}
              aria-label="上一页"
              disabled={pageNum <= 1}
              onClick={() => goPage(pageNum - 1)}
              title="上一页"
            >
              ‹
            </button>
            <input
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && pageInput) goPage(Number(pageInput));
              }}
              onBlur={() => setPageInput(String(pageNum))}
              className="w-9 rounded-sm border border-field bg-canvas px-1 py-0.5 text-center text-xs text-l2 outline-none focus:border-l4"
            />
            <span className="text-l4">/ {pageCount}</span>
            <button
              className={zoomBtn}
              aria-label="下一页"
              disabled={pageNum >= pageCount}
              onClick={() => goPage(pageNum + 1)}
              title="下一页"
            >
              ›
            </button>
            <span className="mx-1 h-3 w-px bg-hairline" />
            <button
              className={zoomBtn}
              aria-label="缩小"
              onClick={() =>
                setFixedScale((s) =>
                  clampPdfScale((s ?? fitScale) / PDF_ZOOM_STEP),
                )
              }
              title={`缩小（${zoomGestureHint}）`}
            >
              −
            </button>
            <button
              className={`${zoomBtn} px-1.5 tabular-nums`}
              aria-label="适配宽度"
              onClick={() => setFixedScale(null)}
              title="适配宽度"
            >
              {fixedScale === null ? "适配" : `${Math.round(scale * 100)}%`}
            </button>
            <button
              className={zoomBtn}
              aria-label="放大"
              onClick={() =>
                setFixedScale((s) =>
                  clampPdfScale((s ?? fitScale) * PDF_ZOOM_STEP),
                )
              }
              title={`放大（${zoomGestureHint}）`}
            >
              +
            </button>
          </span>
        )}
      </div>
      {hint && (
        <p className="flex shrink-0 items-center gap-2 bg-inset px-3 py-1 text-xs text-l2">
          <span className="min-w-0 flex-1 truncate" title={hint.msg}>
            {hint.msg}
          </span>
          {hint.action && (
            <button
              type="button"
              className="shrink-0 rounded-sm border border-cta-bd bg-cta px-2 py-0.5 text-cta-text hover:brightness-110"
              onClick={() => {
                hint.action!.run();
                setHint(null);
              }}
            >
              {hint.action.label}
            </button>
          )}
        </p>
      )}
      {error ? (
        <PreviewErrorState error={error} kind="PDF" onRetry={() => setRetry((v) => v + 1)} />
      ) : !doc ? (
        <div className="p-3">
          <p className="text-sm text-l4">正在加载 PDF…</p>
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="ccode-pdf-scroll relative min-h-0 flex-1 overflow-auto [overflow-anchor:none]"
        >
          <div className="flex min-w-max flex-col items-center p-3">
            {pages.map((n) => (
              <PdfPageView
                key={n}
                doc={doc}
                pageNum={n}
                scale={scale}
                renderScale={renderScale}
                active={n === pageNum}
              />
            ))}
          </div>
          {(onAskAi || onOrganize) && (
            // 四个按钮并排的宽度预留约 350px，避免右缘溢出
            <SelectionFloatBar
              containerRef={scrollRef}
              withinSelector="[data-page-num]"
              reserveWidth={350}
            >
              {onAskAi && (
                <>
                  <button
                    type="button"
                    // preventDefault 保住选区，click 时才读文字
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => askAi()}
                    className="rounded-sm border border-cta-bd bg-cta px-2 py-1 text-xs text-cta-text hover:brightness-110"
                  >
                    ◈ 问 AI
                  </button>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => askAi(true)}
                    className="rounded-sm border border-field bg-strip px-2 py-1 text-xs text-l2 hover:bg-inset hover:text-l1"
                  >
                    ↵ 直接发送
                  </button>
                </>
              )}
              {onOrganize && (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void organize()}
                  disabled={organizing}
                  className="rounded-sm border border-cta-bd bg-cta px-2 py-1 text-xs text-cta-text hover:brightness-110 disabled:opacity-60"
                >
                  {organizing ? "整理中…" : "整理为笔记"}
                </button>
              )}
              <DistillSkillButton onHint={(m) => showHint({ msg: m })} />
            </SelectionFloatBar>
          )}
        </div>
      )}
    </div>
  );
}

/** memo：父级重渲染不级联到 pdf.js 渲染管线 */
export default memo(PdfPreview);
