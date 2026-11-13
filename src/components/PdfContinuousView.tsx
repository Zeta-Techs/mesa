import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import SelectionFloatBar, { FloatBarOverflow, FLOAT_BTN, FLOAT_BTN_PRIMARY } from "./SelectionFloatBar";
import { HoverTip } from "./HoverTip";
import { IS_MAC } from "../hotkeys";
import { createImeLock } from "../ime-guard";
import {
  PdfPageView,
  loadPdfBytes,
  openPdfDocument,
  type PdfActionResult,
  type PdfPageMark,
} from "./PdfPreview";
import { usePdfGestureZoom } from "./use-pdf-zoom";
import PdfFigurePeek from "./PdfFigurePeek";
import { useFileVersion } from "../file-watch";
import {
  PDF_ZOOM_STEP,
  captureRectToCanvasPixels,
  captureRectUsable,
  clampPdfScale,
  groupTextLines,
  hitTestCapture,
  joinParagraphLines,
  loadReaderProgress,
  nearestLineIndex,
  nextFitScale,
  normCaptureRect,
  paragraphBounds,
  pdfZoomCap,
  saveReaderProgress,
  type CaptureRect,
  type GlossaryEntry,
  type PageBox,
  type RawTextSpan,
  type ReaderTranslateResult,
  pdfRenderWindow,
  captureRectToPageRegion,
  loadFigRegion,
  saveFigRegion,
  type PdfPeekItem,
} from "../reader";
import { cropFigureRegion, graphicBoxesFromOps, type Rect } from "../pdf-figure-crop";
import { PdfRegionThumb } from "./PdfFigurePeek";
import {
  findAllIn,
  flattenPdfOutline,
  locateFigure,
  captionItemIndex,
  normalizeSearchQuery,
  pageSearchLines,
  pageSearchText,
  pdfDestTop,
  type PdfOutlineEntry,
} from "../pdf-search";
import type { PdfAnnotation, PdfJumpReq } from "../reader-note";

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** 生词出处里的文献名（《stem》第 N 页） */
function fileStem(name: string): string {
  return name.replace(/\.pdf$/i, "");
}

/** 选区长度门槛（≤ max 字符才放行「＋ 生词」）：挂在 SelectionFloatBar 里自己订阅
 *  selectionchange 重渲染——父组件不随选区变化重渲染，不能在其 JSX 里现读 getSelection() */
function SelectionGate({
  max,
  children,
}: {
  max: number;
  children: React.ReactNode;
}) {
  const [len, setLen] = useState(0);
  useEffect(() => {
    const onChange = () =>
      setLen(window.getSelection()?.toString().trim().length ?? 0);
    document.addEventListener("selectionchange", onChange);
    onChange();
    return () => document.removeEventListener("selectionchange", onChange);
  }, []);
  return len > 0 && len <= max ? <>{children}</> : null;
}

/** 未标记页的稳定空表（PdfPageView 是 memo，每次新建空数组会让所有页白重渲） */
const NO_PAGE_MARKS: readonly PdfPageMark[] = [];

/** 文字索引的一页：查找用的归一页文本 + 图注定位用的行 */
interface IndexedPage {
  text: string;
  lines: string[];
}

/** 首页尺寸实测前的占位估算（A4 scale=1）；实测后逐页缓存修正 */
const FALLBACK_PAGE = { w: 595, h: 842 };
/** 离窗页的预渲染带宽：可视窗口上下各扩展的页数 */
const RENDER_MARGIN = 2;
/** 已画好的页滚出 ±RENDER_MARGIN 后先留着，出了 ±KEEP_MARGIN 才卸载：来回滚不重画（2026-11-05 用户：滚动卡） */
const KEEP_MARGIN = 5;
/** 适配宽度重算的停稳阈值：容器宽度连续变化（侧栏收起动画/分隔条拖拽）期间
 *  RO 逐帧连发，等停稳这么多毫秒才重算换挡（与 use-pdf-zoom 的 120ms 位图
 *  去抖同量级，衔接成「布局停稳 → 位图追平」两段收口） */
const FIT_SETTLE_MS = 150;

/**
 * PDF 连续滚动视图（阅读区中栏）：全部页按自然高度纵向排布，
 * IntersectionObserver 只渲染可视窗口 ±2 页（canvas + textLayer 可选段），
 * 离窗页按已测页比例给骨架占位；加载链路与 PdfPreview 同一条 read_pdf_bytes 白名单。
 * 缩放：顶栏 −/＋ 之外，⌘/Ctrl+滚轮与触控板双指捏合对准指针位置改倍率。
 */
function PdfContinuousView({
  path,
  cwdHint,
  onAskAi,
  askAs,
  onBack,
  onCaptureAgent,
  onCaptureNote,
  glossTerms,
  dark,
  onTranslate,
  translations,
  onRequestTranslate,
  onAddGlossary,
  onOrganize,
  onOpenReader,
  maxFitMultiplier,
  annotations,
  onAddAnnotation,
  onCaptureReview,
  onRemoveAnnotation,
  onRevealAnnotation,
  jumpReq,
  findHotkey,
  sourceMark,
}: {
  path: string;
  /** 项目根：后端白名单的来源之一（同 PdfPreview 的 cwdHint） */
  cwdHint: string | null;
  /** 选段「◈ 问 AI」/「↵ 直接发送」：返回 null 成功，否则为要展示的提示 */
  onAskAi?: (
    text: string,
    page: number,
    fileName: string,
    send?: boolean,
  ) => string | null | Promise<string | null>;
  /** 选段主钮改作别的用途（阅读区抽查 =「记下」）：换按钮字与回执，且不出「↵ 直接发送」 */
  askAs?: { label: string; done: string };
  /** 加载失败/被白名单拒绝时错误条上的「← 返回」 */
  onBack?: () => void;
  /** 圈选截图「◈ 发给 Agent」：返回 null 成功，否则为要展示的提示（批次 B2） */
  onCaptureAgent?: (
    blob: Blob,
    page: number,
    fileName: string,
  ) => Promise<string | null>;
  /** 圈选截图「＋ 插入笔记」（批次 B2），口径同上 */
  onCaptureNote?: (
    blob: Blob,
    page: number,
    fileName: string,
  ) => Promise<string | null>;
  /** 审阅：圈选一块区域连同一句意见交出去（截图由宿主存成图，随意见交给 AI）；返回 null 成功 */
  onCaptureReview?: (
    blob: Blob,
    page: number,
    fileName: string,
    comment: string,
  ) => Promise<string | null>;
  /** 生词高亮术语表（阅读区打开时加载一次，增删后刷新） */
  glossTerms?: readonly GlossaryEntry[];
  /** 护眼反色开关（只反 canvas 层，CSS filter，不动 canvas 数据） */
  dark?: boolean;
  /** 翻译触发（选段「译」/ ⌘+点击段落）：状态机与译文浮窗都在上层（ReaderOverlay），本组件只上送原文与页码 */
  onTranslate?: (text: string, page: number) => void;
  /** 顶栏「译文 N」：本篇有翻译才出，点了开 / 关译文浮窗（2026-11-06：浮窗 × 彻底关掉，从这里再打开） */
  translations?: { count: number; open: boolean; onToggle: () => void };
  /** 纯文本翻译请求（＋生词预填要的是释义）；面板翻译走 onTranslate，不经本回调 */
  onRequestTranslate?: (
    text: string,
    page: number,
  ) => Promise<ReaderTranslateResult>;
  /** 写入生词本（返回 null 成功，否则提示） */
  onAddGlossary?: (
    term: string,
    meaning: string,
    source: string,
  ) => Promise<string | null>;
  onOrganize?: (
    text: string,
    page: number,
    fileName: string,
  ) => Promise<PdfActionResult>;
  /** 预览顶栏「⛶ 沉浸阅读」 */
  onOpenReader?: () => void;
  /** 缩放上限 = 适配倍率 × 该倍数（窄宿主如弹层限深用；缺省不限到全局 4×） */
  maxFitMultiplier?: number;
  /** 笔记「## 标注」里的高亮与批注（阅读区接线）：页内按摘句重定位，不存坐标 */
  annotations?: readonly PdfAnnotation[];
  /** 选段「高亮」/「批注…」：记进笔记，返回 null 成功，否则为提示 */
  onAddAnnotation?: (
    text: string,
    page: number,
    comment: string,
  ) => Promise<string | null>;
  onRemoveAnnotation?: (a: PdfAnnotation) => Promise<string | null>;
  /** 点高亮后的「在笔记里看」 */
  onRevealAnnotation?: (a: PdfAnnotation) => void;
  /** 笔记里点 p.3 / Fig. 2 交来的跳转（nonce 递增即执行一次） */
  jumpReq?: PdfJumpReq | null;
  /** 译文卡正在显示的那段原文：常驻淡高亮（卡收起即撤），宿主据此让卡避开它 */
  sourceMark?: { page: number; quote: string } | null;
  /** ⌘/Ctrl+F 呼出查找（阅读区接线；其他宿主只有工具条按钮） */
  findHotkey?: boolean;
}) {
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);
  /** null = 适配宽度模式（随容器宽度换算，默认） */
  const [fixedScale, setFixedScale] = useState<number | null>(null);
  const [fitScale, setFitScale] = useState(1);
  /** 各页 scale=1 的原始尺寸缓存：占位高度与缩放后真实高度都从这里换算（缩放不 invalidate） */
  const [pageSizes, setPageSizes] = useState<
    Record<number, { w: number; h: number }>
  >({});
  /** 当前处于可视带内的页号（IntersectionObserver 汇报） */
  const [seenPages, setSeenPages] = useState<ReadonlySet<number>>(new Set([1]));
  const [hint, setHint] = useState<string | null>(null);
  const [organizing, setOrganizing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fitScaleRef = useRef(fitScale);
  fitScaleRef.current = fitScale;
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scale = fixedScale ?? fitScale;
  // 宿主缩放上限（弹层限深：页宽 ≈ 倍数 × 栏宽）；手势与按钮同一钳制
  const zoomCap = pdfZoomCap(fitScale, maxFitMultiplier);
  const clampZoom = (v: number) => Math.min(zoomCap, clampPdfScale(v));

  const fileName = basename(path);

  // ===== 圈选截图（批次 B2）：模式开关 → 拖矩形 → 定格小条（发给 Agent / 插入笔记） =====
  const captureSupported = Boolean(onCaptureAgent || onCaptureNote || onCaptureReview);
  const [captureComment, setCaptureComment] = useState("");
  const [captureOn, setCaptureOn] = useState(false);
  /** 拖拽中的矩形（内容层坐标）；松手后清空 */
  const [dragRect, setDragRect] = useState<CaptureRect | null>(null);
  /** 松手后定格：矩形 + 裁好的 PNG + 命中页号，等用户在浮条上选去向 */
  const [frozen, setFrozen] = useState<{
    rect: CaptureRect;
    blob: Blob;
    page: number;
    /** 框住的页内区域（0–1）：「钉住对照」按它在对照窗里重新渲染，放大不糊 */
    region: { x: number; y: number; w: number; h: number } | null;
  } | null>(null);
  // ===== 对照窗（2026-11-05）：圈选钉住 / 点正文或笔记里的 Fig. N，把图钉在 PDF 栏上方对照着读 =====
  const [peeks, setPeeks] = useState<PdfPeekItem[]>([]);
  const [peekActive, setPeekActive] = useState("");
  const openPeek = useCallback((item: PdfPeekItem) => {
    setPeeks((cur) => {
      const rest = cur.filter((p) => p.key !== item.key);
      return [...rest, item].slice(-6);
    });
    setPeekActive(item.key);
  }, []);
  const closePeek = useCallback((key: string) => {
    setPeeks((cur) => {
      const next = cur.filter((p) => p.key !== key);
      setPeekActive((a) => (a === key ? (next[next.length - 1]?.key ?? "") : a));
      return next;
    });
  }, []);
  const [captureBusy, setCaptureBusy] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // 手势缩放（⌘/Ctrl+滚轮 + 触控板 pinch）：共享绑定在 use-pdf-zoom；
  // 页盒按布局倍率即时重排，renderScale 停稳才追上（PdfPageView 渲染倍率）。
  // liveZoomingRef 供适配宽度重算 / IntersectionObserver / 滚动副作用在缩放期让路
  const { renderScale, liveZoomingRef } = usePdfGestureZoom({
    scrollRef,
    scale,
    enabled: Boolean(doc),
    onCommit: (next) => setFixedScale(next),
    anchorSelector: "[data-page-box]",
    maxScale: zoomCap,
  });

  /** 定格条收掉：连同写了一半的审阅意见一起清，别带进下一次圈选 */
  function dismissFrozen() {
    setFrozen(null);
    setCaptureComment("");
  }

  function exitCapture() {
    setCaptureOn(false);
    setDragRect(null);
    dismissFrozen();
  }

  // ===== 批次 B3：划词翻译 / 生词卡 / ⌘+点击段落 / 大纲 / 进度记忆 / 术语悬停 =====
  // （v2 形态修正：翻译结果不再弹选区旁浮卡，统一进顶部常驻翻译面板承载——含翻译中
  //   骨架与失败重试；生词卡是带输入框的表单，浮卡保留）
  /** 生词浮卡（＋ 生词 唯一保留的浮卡）：anchor 相对滚动容器（同 SelectionFloatBar 坐标系） */
  const [floatCard, setFloatCard] = useState<{
    anchor: { x: number; y: number };
    text: string;
    page: number;
  } | null>(null);
  /** 生词卡：释义输入 + 预填中 + 提交中 */
  const [glossMeaning, setGlossMeaning] = useState("");
  const [glossPrefilling, setGlossPrefilling] = useState(false);
  const [glossBusy, setGlossBusy] = useState(false);
  /** 术语悬停释义（事件代理，命中 .ccode-gloss 时定位 HoverTip） */
  const [glossTip, setGlossTip] = useState<{ x: number; y: number; text: string } | null>(null);
  /** 生词卡预填的请求序号（独立——此前与翻译共用，开生词卡会误杀在途翻译） */
  const glossReqRef = useRef(0);
  /** 进度恢复只跑一次（换文档重置）；恢复前的初始页不落盘 */
  const restoredRef = useRef(false);

  // 换文档时连同会话态一起重置（浮卡/术语悬停/进度恢复标记）
  useEffect(() => {
    restoredRef.current = false;
    setFloatCard(null);
    setGlossTip(null);
  }, [path]);

  /** 选区锚点 → 滚动容器坐标（生词卡锚点；同 SelectionFloatBar 的换算口径，右缘预留浮卡宽 288px） */
  function anchorFromSelection(): { x: number; y: number } | null {
    const scroll = scrollRef.current;
    const sel = window.getSelection();
    if (!scroll || !sel || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    const sr = scroll.getBoundingClientRect();
    return {
      x: Math.max(
        8,
        Math.min(r.left - sr.left + scroll.scrollLeft, sr.width - 296),
      ),
      y: r.bottom - sr.top + scroll.scrollTop + 6,
    };
  }

  /** 「译」：选段译文交给上层翻译面板（右栏终端上方；触发即清选区） */
  function translateSelection() {
    const excerpt = selectedExcerpt();
    if (!excerpt || !onTranslate) return;
    clearSelection();
    onTranslate(excerpt.text, excerpt.page);
  }

  /** 「＋ 生词」：浮卡 = 术语（选中词）+ 释义（自动预填，手改不覆盖）+ 出处自动记 */
  function openGlossaryCard() {
    const excerpt = selectedExcerpt();
    if (!excerpt || !onAddGlossary) return;
    const anchor = anchorFromSelection();
    if (!anchor) return;
    clearSelection();
    setFloatCard({ anchor, text: excerpt.text.slice(0, 60), page: excerpt.page });
    setGlossMeaning("");
    setGlossBusy(false);
    // 自动调 translate 预填释义（结果只进这张卡，不做别的记录；独立序号，不打扰在途翻译）
    if (onRequestTranslate) {
      const my = ++glossReqRef.current;
      setGlossPrefilling(true);
      void onRequestTranslate(excerpt.text, excerpt.page).then((r) => {
        if (my !== glossReqRef.current) return;
        setGlossPrefilling(false);
        if (r.ok) setGlossMeaning((prev) => (prev.trim() ? prev : r.text));
      });
    }
  }

  async function confirmGlossary() {
    const meaning = glossMeaning.trim();
    if (!floatCard || !meaning || glossBusy) return;
    setGlossBusy(true);
    const err =
      (await onAddGlossary?.(
        floatCard.text,
        meaning,
        `《${fileStem(fileName)}》第 ${floatCard.page} 页`,
      )) ?? "当前环境不支持生词本";
    setGlossBusy(false);
    if (err) showHint(err);
    else setFloatCard(null); // 成功：收卡（列表/高亮刷新与 toast 由 ReaderOverlay 负责）
  }

  /** ⌘/Ctrl + 点击正文段落：从点击行按 y 连续性向上下扩展提取整段 → 交上层翻译面板。
      与圈选模式互斥（圈选交互层盖住内容层，这里再守一道） */
  function onContentClick(e: React.MouseEvent<HTMLDivElement>) {
    if (captureOn) return;
    const figRef = (e.target as HTMLElement).closest?.<HTMLElement>(".ccode-figref");
    if (figRef && window.getSelection()?.isCollapsed !== false && !e.metaKey && !e.ctrlKey) {
      const kind = figRef.dataset.figKind === "table" ? "table" : "figure";
      onFigRefHover(null);
      void openFigurePeek(kind, figRef.dataset.figLabel ?? "");
      return;
    }
    if (!e.metaKey && !e.ctrlKey) {
      // 普通单击：落在高亮上（且不是拖选收尾）就出那条标注的小卡
      if (!annotations?.length || !window.getSelection()?.isCollapsed) return;
      const index = noteMarkAt(e.clientX, e.clientY);
      const scroll = scrollRef.current;
      if (index === null || !scroll) {
        setMarkPop(null);
        return;
      }
      const sr = scroll.getBoundingClientRect();
      setMarkPop({
        index,
        anchor: {
          x: Math.max(8, Math.min(e.clientX - sr.left + scroll.scrollLeft, sr.width - 296)),
          y: e.clientY - sr.top + scroll.scrollTop + 10,
        },
      });
      return;
    }
    if (!onTranslate) return;
    const host = (e.target as HTMLElement).closest("[data-page-num]");
    const layer = host?.querySelector(".textLayer");
    if (!host || !layer) return;
    const page = Number(host.getAttribute("data-page-num")) || currentPage;
    // 只取叶子 span：markedContent 包装 span 的 textContent 会把子文本重复计入
    const spans: RawTextSpan[] = [];
    layer.querySelectorAll("span").forEach((s) => {
      if (s.children.length > 0) return;
      const text = s.textContent ?? "";
      if (!text.trim()) return;
      const r = s.getBoundingClientRect();
      if (r.height <= 0) return;
      spans.push({ top: r.top, left: r.left, height: r.height, text });
    });
    const lines = groupTextLines(spans);
    if (lines.length === 0) return;
    const idx = nearestLineIndex(lines, e.clientY);
    const { start, end } = paragraphBounds(lines, idx);
    const text = joinParagraphLines(lines.slice(start, end + 1));
    if (!text) return;
    e.preventDefault();
    onTranslate(text, page);
  }

  /** 术语悬停释义：事件代理命中 .ccode-gloss（HoverTip 横向钳制同 useHoverTip 口径） */
  function onContentMouseOver(e: React.MouseEvent<HTMLDivElement>) {
    onFigRefHover((e.target as HTMLElement).closest?.<HTMLElement>(".ccode-figref") ?? null);
    const el = (e.target as HTMLElement).closest?.(".ccode-gloss");
    const meaning = el?.getAttribute("data-meaning") ?? "";
    if (el && meaning) {
      const r = el.getBoundingClientRect();
      const x = Math.min(
        Math.max(r.left + r.width / 2, 150),
        window.innerWidth - 150,
      );
      const y = r.bottom + 6;
      setGlossTip((prev) =>
        prev && prev.x === x && prev.y === y && prev.text === meaning
          ? prev
          : { x, y, text: meaning },
      );
    } else {
      setGlossTip(null);
    }
  }

  // Esc 退出圈选（capture 相监听 + stopPropagation：抢在 ReaderOverlay 的 Esc 关阅读区之前；
  // 组词中或 WKWebView 刚结束组词那一帧的 Esc 是取消候选，不退出圈选）
  const captureImeRef = useRef(createImeLock());
  useEffect(() => {
    const ime = captureImeRef.current;
    if (!captureOn) {
      ime.dispose();
      return;
    }
    const onCompStart = () => ime.onCompositionStart();
    const onCompEnd = () => ime.onCompositionEnd();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || ime.blocksKey(e)) return;
      e.stopPropagation();
      exitCapture();
    };
    window.addEventListener("compositionstart", onCompStart, true);
    window.addEventListener("compositionend", onCompEnd, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("compositionstart", onCompStart, true);
      window.removeEventListener("compositionend", onCompEnd, true);
      window.removeEventListener("keydown", onKey, true);
      ime.dispose();
    };
  }, [captureOn]);

  // 磁盘上换了一版（Agent 重新渲染出同名 PDF）：重载并回到原来的滚动位置、保留缩放
  const fileVersion = useFileVersion(path);
  const loadedKeyRef = useRef<string | null>(null);
  /** 重载后要回到的滚动位置（等新文档的页盒排出来再落） */
  const restoreTopRef = useRef<number | null>(null);

  // 加载文档（路径切换整体重来；同一路径换版只重载内容）
  useEffect(() => {
    let cancelled = false;
    let task: pdfjs.PDFDocumentLoadingTask | null = null;
    const key = `${cwdHint ?? ""}\u0000${path}`;
    const reload = loadedKeyRef.current === key;
    loadedKeyRef.current = key;
    restoreTopRef.current = reload ? (scrollRef.current?.scrollTop ?? null) : null;
    setDoc(null);
    setError(null);
    setPageCount(0);
    setPageSizes({});
    setSeenPages(new Set([1]));
    if (!reload) setFixedScale(null);
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
  }, [path, cwdHint, fileVersion]);

  // 换版重载后回到原位：页盒高度按首页实测估出来后再落（落不下就多等几帧）
  useEffect(() => {
    const top = restoreTopRef.current;
    const el = scrollRef.current;
    if (top === null || !doc || !el || !pageSizes[1]) return;
    let tries = 0;
    let raf = 0;
    const step = () => {
      el.scrollTop = top;
      if (Math.abs(el.scrollTop - top) <= 2 || ++tries >= 10) {
        restoreTopRef.current = null;
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [doc, pageSizes]);

  // 适配宽度：量首页原始宽度换算 scale；容器尺寸变化停稳后重算并重渲染。
  // 停稳防抖（FIT_SETTLE_MS）：侧栏收起/展开动画与分隔条拖拽期间 RO 逐帧连发，
  // 每帧 setFitScale 会整树重渲 + 页盒逐帧 reflow——防抖后动画期间零重排，
  // 停稳一次重算，位图重渲另由 use-pdf-zoom 的 120ms 去抖收口
  useEffect(() => {
    if (!doc || fixedScale !== null) return;
    const el = scrollRef.current;
    if (!el) return;
    let cancelled = false;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const compute = async () => {
      try {
        const page = await doc.getPage(1);
        if (cancelled) return;
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
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => void compute(), FIT_SETTLE_MS);
    });
    ro.observe(el);
    return () => {
      cancelled = true;
      clearTimeout(settleTimer);
      ro.disconnect();
    };
  }, [doc, fixedScale]);

  // 首页尺寸尽早实测：离窗页占位高度按已测页比例估算
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    void (async () => {
      try {
        const page = await doc.getPage(1);
        if (cancelled) return;
        const v = page.getViewport({ scale: 1 });
        setPageSizes((prev) => ({ ...prev, 1: { w: v.width, h: v.height } }));
      } catch {
        /* 估算失败就用 A4 兜底比例 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc]);

  // 渲染窗口 = 可视页 ±2，画过的页 ±5 内不卸载（pdfRenderWindow，reader.ts；离窗页只留骨架占位）
  const mountedPagesRef = useRef<ReadonlySet<number>>(new Set());
  const { renderRange, mounted: mountedPages } = pdfRenderWindow(
    doc ? seenPages : null,
    mountedPagesRef.current,
    pageCount,
    RENDER_MARGIN,
    KEEP_MARGIN,
  );
  mountedPagesRef.current = mountedPages;

  // 进入渲染窗口的页补测原始尺寸（pdfjs 的 getPage 有内部缓存，代价低）
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    void (async () => {
      const got: Record<number, { w: number; h: number }> = {};
      for (let n = renderRange.lo; n <= renderRange.hi; n++) {
        if (pageSizes[n]) continue;
        try {
          const page = await doc.getPage(n);
          if (cancelled) return;
          const v = page.getViewport({ scale: 1 });
          got[n] = { w: v.width, h: v.height };
        } catch {
          return; // 单页读取失败：保持估算占位，渲染层各自报错
        }
      }
      if (!cancelled && Object.keys(got).length > 0) {
        setPageSizes((prev) => ({ ...prev, ...got }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, renderRange.lo, renderRange.hi]);

  // 缩放期间攒下的可见性变化：renderScale 追上（= 停稳）时一次并进 seenPages
  const pendingVisRef = useRef<Map<number, boolean>>(new Map());
  useEffect(() => {
    const pending = pendingVisRef.current;
    if (pending.size === 0) return;
    pendingVisRef.current = new Map();
    setSeenPages((prev) => {
      const next = new Set(prev);
      for (const [n, vis] of pending) {
        if (vis) next.add(n);
        else next.delete(n);
      }
      return next;
    });
  }, [renderScale]);

  // 可视窗口跟踪：slot 全部常驻（占位或真渲染），IO 只汇报可见性
  useEffect(() => {
    const rootEl = scrollRef.current;
    if (!rootEl || !doc) return;
    const io = new IntersectionObserver(
      (entries) => {
        // 缩放中先攒着、停稳再并进去（2026-11-05 修：旧写法直接丢，IO 不会为同一状态再报一次——
        // 缩小后新露出的页一直是占位、放大后滚出去的页不卸载，停稳那一下多画好几页）
        if (liveZoomingRef.current) {
          for (const e of entries) {
            const n = Number((e.target as HTMLElement).dataset.pageSlot);
            if (n) pendingVisRef.current.set(n, e.isIntersecting);
          }
          return;
        }
        setSeenPages((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const n = Number((e.target as HTMLElement).dataset.pageSlot);
            if (!n) continue;
            if (e.isIntersecting) next.add(n);
            else next.delete(n);
          }
          return next;
        });
      },
      // 上下各半屏预取带：滚动快时渲染窗口来得及跟上
      { root: rootEl, rootMargin: "50% 0px" },
    );
    rootEl
      .querySelectorAll("[data-page-slot]")
      .forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [doc, pageCount]);

  /** 当前页指示：可视带内最靠上的一页（缩放浮控的页码与进度记忆同源） */
  const currentPage = (() => {
    let min = Infinity;
    for (const n of seenPages) min = Math.min(min, n);
    return min === Infinity ? 1 : min;
  })();

  // 进度记忆：当前页稳定 2s 才落盘（滚动中不写；恢复完成前的初始页不写）
  useEffect(() => {
    if (!doc || !restoredRef.current) return;
    const t = setTimeout(() => saveReaderProgress(path, currentPage), 2000);
    return () => clearTimeout(t);
  }, [doc, path, currentPage]);

  // 进度恢复：文档就绪后滚到记忆页 + 顶栏短暂提示（showHint 自带 3s 淡出）
  useEffect(() => {
    if (!doc || pageCount === 0 || restoredRef.current) return;
    restoredRef.current = true;
    const saved = loadReaderProgress(path);
    if (saved && saved > 1 && saved <= pageCount) {
      // 页槽恒渲染（占位骨架也能定位），等首帧铺出来再跳
      requestAnimationFrame(() => {
        scrollRef.current
          ?.querySelector(`[data-page-slot="${saved}"]`)
          ?.scrollIntoView({ block: "start" });
      });
      showHint(`已回到第 ${saved} 页`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, pageCount, path]);

  function showHint(msg: string) {
    setHint(msg);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setHint(null), 3000);
  }
  useEffect(
    () => () => {
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    },
    [],
  );

  // ===== 跳转、查找、目录、标注（2026-10-18 阅读区补齐） =====
  const currentPageRef = useRef(currentPage);
  currentPageRef.current = currentPage;
  /** 跳转一次一个 nonce：页内标记落地后由 PdfPageView 滚到视野中央 */
  const nonceRef = useRef(0);
  const [scrollMark, setScrollMark] = useState<{
    page: number;
    id: string;
    nonce: number;
  } | null>(null);
  /** 页内标记滚到位后清掉这次跳转（稳定引用：PdfPageView 是 memo） */
  const markScrolled = useCallback((nonce: number) => {
    setScrollMark((m) => (m && m.nonce === nonce ? null : m));
  }, []);
  /** 跳转时闪一下的原文（2.4s 后淡出，状态随后清掉） */
  const [flash, setFlash] = useState<{ page: number; quote: string } | null>(null);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2600);
    return () => clearTimeout(t);
  }, [flash]);

  /** 滚到某页（pdfTop = 目录落点在页内的高度，PDF 坐标原点在页底；null = 页首） */
  function scrollToPage(n: number, pdfTop: number | null = null) {
    const scroll = scrollRef.current;
    const box = scroll?.querySelector<HTMLElement>(`[data-page-box="${n}"]`);
    if (!scroll || !box) return;
    const sr = scroll.getBoundingClientRect();
    const br = box.getBoundingClientRect();
    const natural = pageSizes[n] ?? pageSizes[1] ?? FALLBACK_PAGE;
    const offset = pdfTop === null ? 0 : Math.max(0, (natural.h - pdfTop) * scale);
    scroll.scrollTo({ top: scroll.scrollTop + br.top - sr.top + offset - 8 });
  }

  /** 页不在视野里才先滚过去（让它进渲染窗口）；在视野里交给标记自己居中 */
  function revealPage(n: number) {
    const scroll = scrollRef.current;
    const box = scroll?.querySelector<HTMLElement>(`[data-page-box="${n}"]`);
    if (!scroll || !box) return;
    const sr = scroll.getBoundingClientRect();
    const br = box.getBoundingClientRect();
    if (br.bottom < sr.top + 40 || br.top > sr.bottom - 40) scrollToPage(n);
  }

  /** 跳到某页的一段原文并闪一下（原文在页内找不到时停在该页） */
  function flashAt(page: number, quote: string) {
    revealPage(page);
    setFlash({ page, quote });
    setScrollMark({ page, id: "flash", nonce: ++nonceRef.current });
  }

  /** 文字索引（查找/图表定位共用）：首次用到时逐页取文本，按文档缓存 */
  const textIndexRef = useRef<{
    doc: pdfjs.PDFDocumentProxy;
    job: Promise<IndexedPage[] | null>;
  } | null>(null);
  function ensureTextIndex(): Promise<IndexedPage[] | null> {
    if (!doc) return Promise.resolve(null);
    const cached = textIndexRef.current;
    if (cached && cached.doc === doc) return cached.job;
    const d = doc;
    const job = (async () => {
      const pages: IndexedPage[] = [];
      for (let n = 1; n <= d.numPages; n++) {
        const page = await d.getPage(n);
        const tc = await page.getTextContent();
        const items = tc.items as { str?: string; hasEOL?: boolean }[];
        pages.push({ text: pageSearchText(items), lines: pageSearchLines(items) });
      }
      return pages;
    })().catch(() => null);
    textIndexRef.current = { doc: d, job };
    return job;
  }

  // ----- 查找（⌘/Ctrl+F 或工具条放大镜）：大小写不敏感，弯引号/各式短横线/行尾断词都认 -----
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  /** 已归一的查询（输入停 200ms 才算） */
  const [findQuery, setFindQuery] = useState("");
  const [findHits, setFindHits] = useState<{ page: number; nth: number }[]>([]);
  const [findIdx, setFindIdx] = useState(0);
  const [findBusy, setFindBusy] = useState(false);
  /** 全文都抽不出字（扫描版）：查找给明确说法 */
  const [findNoText, setFindNoText] = useState(false);
  const findInputRef = useRef<HTMLInputElement>(null);

  function openFind() {
    setFindOpen(true);
    requestAnimationFrame(() => findInputRef.current?.select());
  }
  function closeFind() {
    setFindOpen(false);
    setFindHits([]);
    setFindQuery("");
  }

  function goToHit(idx: number, hits = findHits) {
    const hit = hits[idx];
    if (!hit) return;
    setFindIdx(idx);
    revealPage(hit.page);
    setScrollMark({ page: hit.page, id: "find-active", nonce: ++nonceRef.current });
  }

  useEffect(() => {
    if (!findOpen) return;
    const q = normalizeSearchQuery(findText);
    if (!q) {
      setFindQuery("");
      setFindHits([]);
      setFindNoText(false);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      setFindBusy(true);
      void ensureTextIndex().then((pages) => {
        if (cancelled) return;
        setFindBusy(false);
        const list = pages ?? [];
        const hits: { page: number; nth: number }[] = [];
        list.forEach((p, i) => {
          findAllIn(p.text, q).forEach((_, nth) => hits.push({ page: i + 1, nth }));
        });
        setFindNoText(list.length > 0 && list.every((p) => !p.text.trim()));
        setFindQuery(q);
        setFindHits(hits);
        // 从当前页往后找第一处，没有再绕回开头
        const from = hits.findIndex((h) => h.page >= currentPageRef.current);
        if (hits.length > 0) goToHit(from < 0 ? 0 : from, hits);
        else setFindIdx(0);
      });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findText, findOpen, doc]);

  // ⌘/Ctrl+F：capture 相拦截并止住传播——终端页对活跃标签也挂了 ⌘F（呼出它自己的搜索条，
  // 在阅读区里看不见）。焦点在编辑器（笔记栏 Monaco）或终端里时不拦，各用各的查找
  useEffect(() => {
    if (!findHotkey) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== "f") return;
      if (e.target instanceof Element && e.target.closest(".monaco-editor, .xterm, .md-find-scope")) return;
      e.preventDefault();
      e.stopPropagation();
      openFind();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findHotkey]);

  // 查找条开着时 Esc 先关查找条（同圈选：capture 相抢在关阅读区之前；焦点在终端/编辑器里不拦）
  useEffect(() => {
    if (!findOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      if (e.target instanceof Element && e.target.closest(".monaco-editor, .xterm, .md-find-scope")) return;
      e.stopPropagation();
      closeFind();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen]);

  // ----- 目录（PDF 自带书签；没有就不出按钮） -----
  const [outline, setOutline] = useState<PdfOutlineEntry[]>([]);
  const [outlineOpen, setOutlineOpen] = useState(false);
  useEffect(() => {
    setOutline([]);
    setOutlineOpen(false);
    if (!doc) return;
    let cancelled = false;
    doc
      .getOutline()
      .then((o) => {
        if (!cancelled) setOutline(flattenPdfOutline(o));
      })
      .catch(() => {
        /* 读不到目录就不出按钮 */
      });
    return () => {
      cancelled = true;
    };
  }, [doc]);

  async function goOutline(entry: PdfOutlineEntry) {
    setOutlineOpen(false);
    if (!doc) return;
    try {
      const explicit =
        typeof entry.dest === "string" ? await doc.getDestination(entry.dest) : entry.dest;
      if (!Array.isArray(explicit) || explicit.length === 0) throw new Error("no dest");
      const ref = explicit[0];
      const index =
        typeof ref === "number"
          ? ref
          : await doc.getPageIndex(ref as Parameters<typeof doc.getPageIndex>[0]);
      scrollToPage(index + 1, pdfDestTop(explicit));
    } catch {
      showHint("这个目录项没有可跳转的位置");
    }
  }

  // ----- 跳页（点页码输入） -----
  const [pageEdit, setPageEdit] = useState<string | null>(null);
  function commitPageEdit() {
    const n = Number(pageEdit);
    setPageEdit(null);
    if (!Number.isInteger(n) || n < 1) return;
    scrollToPage(Math.min(pageCount, n));
  }

  /** 找一张图 / 表：图注所在页 → 自动框出图（第二期；用户重新框过的以它为准）→ 框不出就整页并记下图注高度。
   *  按文档缓存（悬停预览和点击共用一次计算） */
  const figCacheRef = useRef<{ doc: pdfjs.PDFDocumentProxy | null; map: Map<string, Promise<PdfPeekItem | null>> }>({
    doc: null,
    map: new Map(),
  });
  function resolveFigure(kind: "figure" | "table", label: string): Promise<PdfPeekItem | null> {
    if (figCacheRef.current.doc !== doc) figCacheRef.current = { doc, map: new Map() };
    const figKey = `${kind}:${label.toLowerCase()}`;
    const cached = figCacheRef.current.map.get(figKey);
    if (cached) return cached;
    const d = doc;
    const job = (async (): Promise<PdfPeekItem | null> => {
      const pages = await ensureTextIndex();
      const hit = pages ? locateFigure(pages.map((p) => p.lines), kind, label) : null;
      if (!hit || !d) return null;
      const name = `${kind === "figure" ? "Fig." : "Table"} ${label}`;
      const base: PdfPeekItem = { key: `fig:${figKey}`, page: hit.page, label: name, region: null, focusY: null };
      const saved = loadFigRegion(path, figKey);
      if (saved) return { ...base, region: saved, auto: false };
      try {
        const page = await d.getPage(hit.page);
        const vp = page.getViewport({ scale: 1 });
        const toPage = (r: readonly number[]): Rect => {
          const [ax, ay] = vp.convertToViewportPoint(r[0], r[1]) as number[];
          const [bx, by] = vp.convertToViewportPoint(r[2], r[3]) as number[];
          return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
        };
        const tc = await page.getTextContent();
        const items = tc.items as { str?: string; hasEOL?: boolean; transform?: number[]; width?: number; height?: number }[];
        const textBox = (it: (typeof items)[number]): Rect | null => {
          const tr = it.transform;
          if (!tr || !it.str?.trim()) return null;
          const fh = Math.hypot(tr[2], tr[3]) || it.height || 0;
          return toPage([tr[4], tr[5] - fh * 0.2, tr[4] + (it.width ?? 0), tr[5] + fh * 0.8]);
        };
        const idx = captionItemIndex(items, hit.quote);
        if (idx == null) return base;
        // 图注第一行：从命中的文本项到行尾
        let caption: Rect | null = null;
        for (let i = idx; i < items.length; i++) {
          const b = textBox(items[i]);
          if (b) caption = caption ? [Math.min(caption[0], b[0]), Math.min(caption[1], b[1]), Math.max(caption[2], b[2]), Math.max(caption[3], b[3])] : b;
          if (items[i].hasEOL) break;
        }
        if (!caption) return base;
        const focusY = Math.min(1, Math.max(0, caption[1] / vp.height));
        const ops = await page.getOperatorList();
        const region = cropFigureRegion({
          page: { w: vp.width, h: vp.height },
          caption,
          graphics: graphicBoxesFromOps(ops.fnArray, ops.argsArray).map((g) => ({ rect: toPage(g.rect), kind: g.kind })),
          texts: items.map(textBox).filter((b): b is Rect => b !== null),
          kind,
        });
        return { ...base, region, focusY, auto: region !== null };
      } catch {
        return base;
      }
    })();
    figCacheRef.current.map.set(figKey, job);
    return job;
  }

  /** 打开某张图 / 表的对照窗（第二期：自动框出图，框不出就整页滚到图注） */
  async function openFigurePeek(kind: "figure" | "table", label: string) {
    const item = await resolveFigure(kind, label);
    if (!item) {
      showHint(`没在这篇 PDF 里找到「${kind === "figure" ? "Fig." : "Table"} ${label}」`);
      return;
    }
    openPeek(item);
  }

  /** 对照窗里重新框：更新这一项；图号项按篇记住，下次自动框直接用它 */
  const reframePeek = useCallback(
    (key: string, region: { x: number; y: number; w: number; h: number }) => {
      setPeeks((cur) => cur.map((p) => (p.key === key ? { ...p, region, auto: false } : p)));
      if (key.startsWith("fig:")) {
        const figKey = key.slice(4);
        saveFigRegion(path, figKey, region);
        figCacheRef.current.map.delete(figKey);
      }
    },
    [path],
  );

  /** 对照窗里「插入笔记 / 发给 Agent」：沿用圈选的两个去向 */
  const sendPeek = useCallback(
    async (target: "agent" | "note", blob: Blob, page: number) => {
      const handler = target === "agent" ? onCaptureAgent : onCaptureNote;
      const err = await (handler?.(blob, page, fileName) ?? Promise.resolve("当前环境不支持"));
      showHint(err ?? (target === "agent" ? "已放进对话的输入框，检查后发送" : "已贴进笔记"));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onCaptureAgent, onCaptureNote, fileName],
  );

  // 正文图号悬停预览：停 0.45 秒出一张小图，移开就收；点击照旧钉成对照窗
  const [figPreview, setFigPreview] = useState<{ item: PdfPeekItem; x: number; y: number; below: boolean } | null>(null);
  const figHoverRef = useRef<{ el: Element | null; timer: ReturnType<typeof setTimeout> | null }>({ el: null, timer: null });
  function onFigRefHover(el: HTMLElement | null) {
    const st = figHoverRef.current;
    if (st.el === el) return;
    if (st.timer) clearTimeout(st.timer);
    st.el = el;
    st.timer = null;
    if (!el) {
      setFigPreview(null);
      return;
    }
    st.timer = setTimeout(() => {
      const kind = el.dataset.figKind === "table" ? "table" : "figure";
      void resolveFigure(kind, el.dataset.figLabel ?? "").then((item) => {
        if (!item || figHoverRef.current.el !== el) return;
        const r = el.getBoundingClientRect();
        const below = r.bottom + 300 < window.innerHeight;
        setFigPreview({
          item,
          x: Math.min(Math.max(8, r.left), window.innerWidth - 380),
          y: below ? r.bottom + 6 : r.top - 6,
          below,
        });
      });
    }, 450);
  }
  useEffect(
    () => () => {
      if (figHoverRef.current.timer) clearTimeout(figHoverRef.current.timer);
    },
    [],
  );

  // ----- 外部跳转（笔记里点 p.3 / Fig. 2）-----
  const jumpDoneRef = useRef(0);
  useEffect(() => {
    if (!jumpReq || !doc || pageCount === 0) return;
    if (jumpDoneRef.current === jumpReq.nonce) return;
    jumpDoneRef.current = jumpReq.nonce;
    const req = jumpReq;
    void (async () => {
      const label = req.figure ?? req.table;
      if (label) {
        // 笔记里点 Fig. 2：打开对照窗，正文停在原处（读到哪不丢）
        await openFigurePeek(req.figure ? "figure" : "table", label);
        return;
      }
      if (!req.page) return;
      if (req.page > pageCount) {
        showHint(`这篇 PDF 只有 ${pageCount} 页，没有「${req.label}」`);
        return;
      }
      if (req.quote) flashAt(req.page, req.quote);
      else scrollToPage(req.page);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpReq, doc, pageCount]);

  // ----- 标注：高亮/批注写进笔记，页内按摘句重定位；点高亮出小卡 -----
  const [annotCard, setAnnotCard] = useState<{
    anchor: { x: number; y: number };
    text: string;
    page: number;
  } | null>(null);
  const [annotComment, setAnnotComment] = useState("");
  const [annotBusy, setAnnotBusy] = useState(false);
  /** 点中的高亮（annotations 下标）+ 卡片锚点（滚动容器坐标） */
  const [markPop, setMarkPop] = useState<{
    index: number;
    anchor: { x: number; y: number };
  } | null>(null);
  const [annotListOpen, setAnnotListOpen] = useState(false);
  useEffect(() => {
    setAnnotCard(null);
    setMarkPop(null);
    setAnnotListOpen(false);
    closeFind();
    setFindText("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  // 标注表变了（删掉/笔记里手改）：卡片指向的下标可能已失效
  useEffect(() => setMarkPop(null), [annotations]);

  async function annotateSelection() {
    const excerpt = selectedExcerpt();
    if (!excerpt || !onAddAnnotation) return;
    const err = await onAddAnnotation(excerpt.text, excerpt.page, "");
    if (err) showHint(err);
    else clearSelection();
  }

  function openAnnotCard() {
    const excerpt = selectedExcerpt();
    if (!excerpt || !onAddAnnotation) return;
    const anchor = anchorFromSelection();
    if (!anchor) return;
    clearSelection();
    setAnnotCard({ anchor, text: excerpt.text, page: excerpt.page });
    setAnnotComment("");
  }

  async function confirmAnnotCard() {
    if (!annotCard || !onAddAnnotation || annotBusy) return;
    setAnnotBusy(true);
    const err = await onAddAnnotation(annotCard.text, annotCard.page, annotComment.trim());
    setAnnotBusy(false);
    if (err) showHint(err);
    else setAnnotCard(null);
  }

  /** 点击位置落在哪条高亮上（高亮层不接指针，这里按矩形自己判） */
  function noteMarkAt(x: number, y: number): number | null {
    const els = contentRef.current?.querySelectorAll<HTMLElement>(".ccode-mark-note") ?? [];
    for (const el of Array.from(els)) {
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        const index = Number(el.dataset.markId?.slice(1));
        if (Number.isInteger(index)) return index;
      }
    }
    return null;
  }

  /** 每页的标记（标注常驻；查找命中只在查找条开着时画；跳转闪一下） */
  const marksByPage = useMemo(() => {
    const m = new Map<number, PdfPageMark[]>();
    const add = (page: number, mark: PdfPageMark) => {
      const list = m.get(page);
      if (list) list.push(mark);
      else m.set(page, [mark]);
    };
    annotations?.forEach((a, i) =>
      add(a.page, { id: `n${i}`, quote: a.quote, nth: 0, kind: "note" }),
    );
    if (findOpen && findQuery) {
      for (const p of new Set(findHits.map((h) => h.page))) {
        add(p, { id: "find", quote: findQuery, nth: "all", kind: "find" });
      }
      const cur = findHits[findIdx];
      if (cur) {
        add(cur.page, { id: "find-active", quote: findQuery, nth: cur.nth, kind: "find-active" });
      }
    }
    if (sourceMark?.quote.trim()) {
      add(sourceMark.page, { id: "tl-source", quote: sourceMark.quote, nth: 0, kind: "source" });
    }
    if (flash) add(flash.page, { id: "flash", quote: flash.quote, nth: 0, kind: "flash" });
    return m;
  }, [annotations, findOpen, findQuery, findHits, findIdx, flash, sourceMark]);

  // 工具条下拉（目录/标注列表）与高亮小卡：点外面或 Esc 收起（capture 相抢在关阅读区之前）
  const toolsRef = useRef<HTMLDivElement>(null);
  const markPopRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!outlineOpen && !annotListOpen && !markPop) return;
    const close = () => {
      setOutlineOpen(false);
      setAnnotListOpen(false);
      setMarkPop(null);
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (toolsRef.current?.contains(t) || markPopRef.current?.contains(t)) return;
      // 点在高亮上换卡交给 onContentClick；这里只收下拉
      setOutlineOpen(false);
      setAnnotListOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.stopPropagation();
      close();
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [outlineOpen, annotListOpen, markPop]);

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
      currentPage;
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
      showHint(
        err ??
          (askAs ? askAs.done : send ? "已发送给阅读会话" : "已放进对话的输入框，检查后发送"),
      );
      if (!err) clearSelection();
    });
  }

  async function organize() {
    if (organizing || !onOrganize) return;
    const excerpt = selectedExcerpt();
    if (!excerpt) return;
    setOrganizing(true);
    try {
      const r = await onOrganize(excerpt.text, excerpt.page, fileName);
      showHint(r.msg);
      if (r.ok) clearSelection();
    } catch (e) {
      showHint(`整理为笔记失败：${String(e)}`);
    } finally {
      setOrganizing(false);
    }
  }

  // 换文档时退出圈选模式（矩形/定格都只对当前文档有意义）
  useEffect(() => {
    exitCapture();
    setPeeks([]); // 对照窗只对当前这篇有意义
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  /** 圈选松手收尾：命中页槽 → 映射到该页 canvas 像素 → 裁出 PNG 定格等去向 */
  async function finishCapture(r: CaptureRect) {
    const wrapper = contentRef.current;
    if (!wrapper) return;
    if (!captureRectUsable(r)) return; // 误触不成框
    // 命中判定与 canvas 映射用 client 坐标系（getBoundingClientRect 同刻快照）
    const wr = wrapper.getBoundingClientRect();
    const client: CaptureRect = {
      x: r.x + wr.left,
      y: r.y + wr.top,
      w: r.w,
      h: r.h,
    };
    const slots: PageBox[] = Array.from(
      wrapper.querySelectorAll<HTMLElement>("[data-page-slot]"),
    ).map((el) => {
      const b = el.getBoundingClientRect();
      return {
        page: Number(el.dataset.pageSlot),
        x: b.left,
        y: b.top,
        w: b.width,
        h: b.height,
      };
    });
    const hit = hitTestCapture(client, slots);
    if (hit.kind === "none") return;
    if (hit.kind === "cross") {
      showHint("请在一页内圈选");
      return;
    }
    const canvas = wrapper.querySelector<HTMLCanvasElement>(
      `[data-page-num="${hit.page}"] canvas`,
    );
    if (!canvas) {
      showHint("这一页还没渲染，滚动让它显示出来再圈选");
      return;
    }
    const cr = canvas.getBoundingClientRect();
    const px = captureRectToCanvasPixels(
      client,
      { x: cr.left, y: cr.top, w: cr.width, h: cr.height },
      canvas.width,
      canvas.height,
    );
    if (!px) return; // 只框住了页间分隔带等 canvas 之外的区域
    const out = document.createElement("canvas");
    out.width = px.sw;
    out.height = px.sh;
    const ctx = out.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(canvas, px.sx, px.sy, px.sw, px.sh, 0, 0, px.sw, px.sh);
    const blob = await new Promise<Blob | null>((resolve) =>
      out.toBlob(resolve, "image/png"),
    );
    if (!blob) {
      showHint("截图失败，请重试");
      return;
    }
    setFrozen({
      rect: r,
      blob,
      page: hit.page,
      region: captureRectToPageRegion(client, { x: cr.left, y: cr.top, w: cr.width, h: cr.height }),
    });
  }

  /** 圈选拖拽：内容层上按下起框，pointer 全程在 window 上跟（出层也不断） */
  function startCaptureDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const wrapper = contentRef.current;
    if (!wrapper) return;
    e.preventDefault();
    dismissFrozen(); // 有定格条时起新框即丢弃
    const wr = wrapper.getBoundingClientRect();
    const x0 = e.clientX - wr.left;
    const y0 = e.clientY - wr.top;
    const onMove = (ev: PointerEvent) =>
      setDragRect(normCaptureRect(x0, y0, ev.clientX - wr.left, ev.clientY - wr.top));
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setDragRect(null);
      void finishCapture(
        normCaptureRect(x0, y0, ev.clientX - wr.left, ev.clientY - wr.top),
      );
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  /** 圈选位置写进意见：这一页横向 / 纵向的百分之几，AI 不看图也知道指的是哪一块 */
  function captureWithPlace(
    comment: string,
    region: { x: number; y: number; w: number; h: number } | null | undefined,
  ): string {
    if (!region) return comment;
    const p = (v: number) => Math.round(v * 100);
    return `${comment.trim()} 〔本页横向 ${p(region.x)}%–${p(region.x + region.w)}%、纵向 ${p(region.y)}%–${p(region.y + region.h)}%〕`.trim();
  }

  /** 定格浮条两去向：成功即收条（模式保持，Esc/再点「▦ 圈选」退出） */
  async function resolveCapture(target: "agent" | "note" | "review") {
    if (!frozen || captureBusy) return;
    setCaptureBusy(true);
    try {
      const call =
        target === "review"
          ? onCaptureReview?.(frozen.blob, frozen.page, fileName, captureWithPlace(captureComment, frozen.region))
          : (target === "agent" ? onCaptureAgent : onCaptureNote)?.(frozen.blob, frozen.page, fileName);
      const err = await (call ?? Promise.resolve("当前环境不支持截图"));
      showHint(
        err ??
          (target === "agent"
            ? "已放进对话的输入框，检查后发送"
            : target === "review"
              ? "已加进审阅意见"
              : "已贴进笔记"),
      );
      if (!err) dismissFrozen();
    } finally {
      setCaptureBusy(false);
    }
  }

  /** 图标钮规格同阅读区顶栏 topBtn：28px 热区（设计系统下限），层级靠文字色 */
  const zoomBtn =
    "flex h-7 min-w-7 items-center justify-center rounded-sm px-0.5 text-xs text-l3 hover:bg-hover hover:text-l1 disabled:opacity-40";
  const zoomGestureHint = IS_MAC
    ? "⌘/Ctrl+滚轮或双指捏合缩放，中键拖动平移"
    : "Ctrl+滚轮或触控板捏合缩放，中键拖动平移";
  const firstSize = pageSizes[1] ?? FALLBACK_PAGE;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {doc && peeks.length > 0 && (
        <PdfFigurePeek
          doc={doc}
          items={peeks}
          activeKey={peekActive}
          dark={dark}
          onActivate={setPeekActive}
          onClose={closePeek}
          onJump={scrollToPage}
          onReframe={reframePeek}
          onSend={captureSupported ? sendPeek : undefined}
        />
      )}
      {doc && figPreview && (
        <div
          role="tooltip"
          className="ccode-float-surface pointer-events-none fixed z-50 w-[372px] overflow-hidden rounded-md border border-field p-1.5 shadow-lg"
          style={
            figPreview.below
              ? { left: figPreview.x, top: figPreview.y }
              : { left: figPreview.x, bottom: window.innerHeight - figPreview.y }
          }
        >
          <PdfRegionThumb doc={doc} item={figPreview.item} width={360} maxHeight={280} dark={dark} />
          <p className="mt-1 px-0.5 text-micro text-l3">
            {figPreview.item.label} · p.{figPreview.item.page} · 点一下钉成对照窗
          </p>
        </div>
      )}
      {hint && (
        <p className="shrink-0 bg-inset px-3 py-1 text-xs text-l2">{hint}</p>
      )}
      {error ? (
        <div className="p-3">
          <p className="text-sm text-err-text">{error}</p>
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="mt-2 rounded-sm border border-field bg-strip px-2.5 py-1 text-xs text-l2 hover:bg-inset hover:text-l1"
            >
              ← 返回
            </button>
          )}
        </div>
      ) : !doc ? (
        // 加载骨架：pdf.js 传输+解析期间给页形占位（与离屏页同一套 pulse 语言），
        // 别让整栏裸露底色——深色主题下就是一片黑闪（阅读区/文件页预览/终端预览共用）
        <div className="flex flex-1 flex-col items-center gap-3 overflow-hidden p-4">
          <p className="text-sm text-l4">正在加载 PDF…</p>
          <div className="flex w-full max-w-md flex-col items-center gap-4 py-2">
            <div className="aspect-[1/1.414] w-full animate-pulse rounded-sm bg-inset" />
            <div className="aspect-[1/1.414] w-full animate-pulse rounded-sm bg-inset" />
          </div>
        </div>
      ) : (
        <>
          {/* 常驻细工具条（Zotero 式收敛：图标化按钮、页码居中、圈选右置）：
              原是滚动层内的 sticky 浮块，会挡住右上角的正文与圈选画面；
              与左右栏顶条同高（h-8）同底部分隔线，三栏严丝合缝 */}
          <div className="grid h-8 shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-hairline bg-strip px-2">
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                className={zoomBtn}
                title={`缩小（${zoomGestureHint}）`}
                onClick={() =>
                  setFixedScale((s) =>
                    clampZoom((s ?? fitScale) / PDF_ZOOM_STEP),
                  )
                }
              >
                −
              </button>
              <button
                type="button"
                className={zoomBtn}
                title={`放大（${zoomGestureHint}）`}
                onClick={() =>
                  setFixedScale((s) =>
                    clampZoom((s ?? fitScale) * PDF_ZOOM_STEP),
                  )
                }
              >
                ＋
              </button>
              <button
                type="button"
                className={`${zoomBtn} px-1.5 text-micro tabular-nums`}
                title="适配宽度"
                onClick={() => setFixedScale(null)}
              >
                {fixedScale === null
                  ? "适配宽度"
                  : `${Math.round(scale * 100)}%`}
              </button>
            </div>
            <span className="text-center text-micro text-l4 tabular-nums">
              {pageEdit !== null ? (
                <input
                  autoFocus
                  value={pageEdit}
                  onChange={(e) => setPageEdit(e.target.value.replace(/\D/g, ""))}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === "Enter") commitPageEdit();
                    if (e.key === "Escape") {
                      // 只退出跳页输入，不连带关阅读区
                      e.stopPropagation();
                      setPageEdit(null);
                    }
                  }}
                  onBlur={() => setPageEdit(null)}
                  className="w-10 rounded-sm border border-field bg-canvas px-1 py-0.5 text-center text-micro text-l2 outline-none focus:border-l4"
                />
              ) : (
                <button
                  type="button"
                  title="跳到第几页"
                  onClick={() => setPageEdit(String(currentPage))}
                  className="rounded-sm px-1.5 py-0.5 hover:bg-hover hover:text-l2"
                >
                  {currentPage}
                </button>
              )}{" "}
              / {pageCount}
            </span>
            <div ref={toolsRef} className="relative flex items-center justify-end gap-0.5">
              {outline.length > 0 && (
                <button
                  type="button"
                  title="目录（PDF 自带的章节书签）"
                  className={`${zoomBtn} px-1.5 text-micro ${outlineOpen ? "bg-seg-sel text-l1" : ""}`}
                  onClick={() => {
                    setOutlineOpen((v) => !v);
                    setAnnotListOpen(false);
                  }}
                >
                  目录
                </button>
              )}
              {annotations && annotations.length > 0 && (
                <button
                  type="button"
                  title="这篇的高亮与批注（记在笔记「标注」里）"
                  className={`${zoomBtn} px-1.5 text-micro tabular-nums ${annotListOpen ? "bg-seg-sel text-l1" : ""}`}
                  onClick={() => {
                    setAnnotListOpen((v) => !v);
                    setOutlineOpen(false);
                  }}
                >
                  标注 {annotations.length}
                </button>
              )}
              {translations && translations.count > 0 && (
                <button
                  type="button"
                  title={translations.open ? "关掉译文" : "打开译文（本篇翻过的段落）"}
                  className={`${zoomBtn} px-1.5 text-micro tabular-nums ${translations.open ? "bg-seg-sel text-l1" : ""}`}
                  onClick={translations.onToggle}
                >
                  译文 {translations.count}
                </button>
              )}
              <button
                type="button"
                aria-label="在 PDF 里查找"
                title={findHotkey ? `查找（${IS_MAC ? "⌘" : "Ctrl+"}F）` : "查找"}
                className={`${zoomBtn} ${findOpen ? "bg-seg-sel text-l1" : ""}`}
                onClick={() => (findOpen ? closeFind() : openFind())}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <circle cx="7" cy="7" r="4.5" />
                  <path d="M10.5 10.5l3.5 3.5" />
                </svg>
              </button>
              {outlineOpen && (
                <div className="absolute right-0 top-full z-40 mt-1 max-h-[60vh] w-72 overflow-y-auto rounded-md border border-hairline ccode-float-surface p-1">
                  {outline.map((entry, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => void goOutline(entry)}
                      style={{ paddingLeft: 8 + entry.depth * 12 }}
                      className={`block w-full truncate rounded-sm py-1 pr-2 text-left text-xs hover:bg-hover hover:text-l1 ${
                        entry.depth === 0 ? "text-l2" : "text-l3"
                      }`}
                    >
                      {entry.title}
                    </button>
                  ))}
                </div>
              )}
              {annotListOpen && annotations && (
                <div className="absolute right-0 top-full z-40 mt-1 max-h-[60vh] w-80 overflow-y-auto rounded-md border border-hairline ccode-float-surface p-1">
                  {annotations
                    .map((a, i) => ({ a, i }))
                    .sort((x, y) => x.a.page - y.a.page || x.i - y.i)
                    .map(({ a, i }) => (
                      <div
                        key={i}
                        className="group flex items-start gap-1 rounded-sm px-2 py-1 hover:bg-hover"
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setAnnotListOpen(false);
                            flashAt(a.page, a.quote);
                          }}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className="text-micro text-l4">第 {a.page} 页</span>
                          <span className="line-clamp-2 text-xs text-l2">{a.quote}</span>
                          {a.comment && (
                            <span className="line-clamp-2 text-xs text-l1">{a.comment}</span>
                          )}
                        </button>
                        {onRemoveAnnotation && (
                          <button
                            type="button"
                            aria-label="删除这条标注"
                            onClick={() => {
                              void onRemoveAnnotation(a).then((err) => {
                                if (err) showHint(err);
                              });
                            }}
                            className="shrink-0 rounded-sm px-1 text-xs text-l4 opacity-0 hover:text-err-text group-hover:opacity-100 focus-visible:opacity-100"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    ))}
                </div>
              )}
              {onOpenReader && (
                <button
                  type="button"
                  className={`${zoomBtn} px-1.5 text-micro`}
                  onClick={onOpenReader}
                >
                  ⛶ 沉浸阅读
                </button>
              )}
              {captureSupported && (
                <button
                  type="button"
                  className={`${zoomBtn} gap-1 px-1.5 text-micro ${captureOn ? "bg-seg-sel text-l1" : ""}`}
                  onClick={() => (captureOn ? exitCapture() : setCaptureOn(true))}
                >
                  {/* 框选图标（四角框，TerminalStatusBar 同款内联 SVG 细线风格）；原 ▦ 字符太丑 */}
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <path d="M5.5 1.5h-4v4M10.5 1.5h4v4M14.5 10.5v4h-4M1.5 10.5v4h4" />
                  </svg>
                  圈选
                </button>
              )}
            </div>
          </div>
          {findOpen && (
            // 查找条：Enter 下一处、Shift+Enter 上一处、Esc 关（只关查找条，不连带关阅读区）
            <div className="flex h-8 shrink-0 items-center gap-1 border-b border-hairline bg-strip px-2">
              <input
                ref={findInputRef}
                autoFocus
                value={findText}
                onChange={(e) => setFindText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    closeFind();
                    return;
                  }
                  if (e.key === "Enter" && findHits.length > 0) {
                    e.preventDefault();
                    const n = findHits.length;
                    goToHit(e.shiftKey ? (findIdx - 1 + n) % n : (findIdx + 1) % n);
                  }
                }}
                placeholder="在这篇 PDF 里查找"
                className="min-w-0 flex-1 rounded-sm border border-field bg-canvas px-2 py-0.5 text-xs text-l1 outline-none placeholder:text-l4 focus:border-l4"
              />
              <span className="shrink-0 px-1 text-micro tabular-nums text-l4">
                {findBusy
                  ? "查找中…"
                  : !findQuery
                    ? ""
                    : findHits.length > 0
                      ? `${findIdx + 1} / ${findHits.length}`
                      : findNoText
                        ? "这篇是扫描件，没有文字可查"
                        : "没找到"}
              </span>
              <button
                type="button"
                aria-label="上一处"
                title="上一处（Shift+Enter）"
                disabled={findHits.length === 0}
                onClick={() =>
                  goToHit((findIdx - 1 + findHits.length) % findHits.length)
                }
                className={zoomBtn}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label="下一处"
                title="下一处（Enter）"
                disabled={findHits.length === 0}
                onClick={() => goToHit((findIdx + 1) % findHits.length)}
                className={zoomBtn}
              >
                ↓
              </button>
              <button
                type="button"
                aria-label="关闭查找"
                onClick={closeFind}
                className={zoomBtn}
              >
                ×
              </button>
            </div>
          )}
          <div
            ref={scrollRef}
            onScroll={() => {
              if (liveZoomingRef.current) return;
              setGlossTip(null);
              if (figHoverRef.current.el) onFigRefHover(null);
            }}
            onMouseOver={onContentMouseOver}
            className="ccode-pdf-scroll relative min-h-0 flex-1 overflow-auto [overflow-anchor:none]"
          >
          <div
            ref={contentRef}
            onClick={onContentClick}
            className={`relative flex min-w-max flex-col p-3 ${dark ? "ccode-reader-dark" : ""}`}
          >
            {Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => {
              const natural = pageSizes[n] ?? firstSize;
              const shouldRender = mountedPages.has(n);
              const boxW = Math.floor(natural.w * scale);
              const boxH = Math.floor(natural.h * scale);
              return (
                <div
                  key={n}
                  data-page-slot={n}
                  className="flex flex-col items-center"
                >
                  {n > 1 && (
                    // 页间 hairline + 页码小标
                    <div className="my-2 flex w-full min-w-40 items-center gap-2 text-micro text-l4">
                      <span className="h-px flex-1 bg-hairline" />
                      第 {n} 页
                      <span className="h-px flex-1 bg-hairline" />
                    </div>
                  )}
                  {/* 页盒按布局倍率即时重排；canvas/textLayer 按 renderScale 停稳才重绘（use-pdf-zoom） */}
                  <div
                    data-page-box={n}
                    className={
                      shouldRender
                        ? "overflow-hidden bg-white"
                        : "rounded-sm bg-inset"
                    }
                    style={{ width: boxW, height: boxH }}
                  >
                    {shouldRender ? (
                      <PdfPageView
                        doc={doc}
                        pageNum={n}
                        scale={scale}
                        renderScale={renderScale}
                        fillParent
                        active
                        glossTerms={glossTerms}
                        figRefs
                        marks={marksByPage.get(n) ?? NO_PAGE_MARKS}
                        scrollTo={scrollMark?.page === n ? scrollMark : null}
                        onScrolledTo={markScrolled}
                      />
                    ) : null}
                  </div>
                </div>
              );
            })}
            {captureOn && (
              // 圈选交互层：盖全内容（随内容滚动），十字光标 + 禁文本选择；松手在 finishCapture 裁切
              <div
                className="absolute inset-0 z-20 cursor-crosshair select-none"
                onPointerDown={startCaptureDrag}
              />
            )}
            {(dragRect || frozen) && (
              // 拖拽中/定格的选区框（半透明 CTA 底）
              <div
                className="pointer-events-none absolute z-20 rounded-sm border border-cta bg-cta/15"
                style={{
                  left: (dragRect ?? frozen!.rect).x,
                  top: (dragRect ?? frozen!.rect).y,
                  width: (dragRect ?? frozen!.rect).w,
                  height: (dragRect ?? frozen!.rect).h,
                }}
              />
            )}
            {frozen && !dragRect && (
              // 定格后的去向浮条（右缘防溢出：约 260px 预留）
              <div
                className="absolute z-30 flex items-center gap-1 rounded-md ccode-float-surface p-1"
                style={{
                  left: Math.max(
                    4,
                    Math.min(
                      frozen.rect.x,
                      (contentRef.current?.clientWidth ?? 400) - (onCaptureReview ? 340 : 260),
                    ),
                  ),
                  top: frozen.rect.y + frozen.rect.h + 6,
                }}
              >
                {onCaptureReview && (
                  <form
                    className="flex items-center gap-1"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const bySubmitter = Boolean((event.nativeEvent as SubmitEvent | undefined)?.submitter);
                      if (!bySubmitter && captureImeRef.current.locked) return;
                      void resolveCapture("review");
                    }}
                  >
                    <input
                      autoFocus
                      value={captureComment}
                      onChange={(event) => setCaptureComment(event.target.value)}
                      onCompositionStart={captureImeRef.current.onCompositionStart}
                      onCompositionEnd={captureImeRef.current.onCompositionEnd}
                      onKeyDown={(event) => {
                        if (!captureImeRef.current.blocksKey(event)) return;
                        if (event.key === "Escape") event.stopPropagation();
                        if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                          event.preventDefault();
                        }
                      }}
                      placeholder="这一块哪里不对"
                      className="w-48 rounded-sm border border-field bg-canvas px-2 py-1 text-xs text-l2 outline-none placeholder:text-l4 focus:border-l4"
                    />
                    <button
                      type="submit"
                      disabled={captureBusy}
                      className="rounded-sm border border-cta-bd bg-cta px-2 py-1 text-xs text-cta-text hover:brightness-110 disabled:opacity-60"
                    >
                      加入意见
                    </button>
                  </form>
                )}
                {onCaptureAgent && (
                  <button
                    type="button"
                    disabled={captureBusy}
                    onClick={() => void resolveCapture("agent")}
                    className="rounded-sm border border-cta-bd bg-cta px-2 py-1 text-xs text-cta-text hover:brightness-110 disabled:opacity-60"
                  >
                    ◈ 发给 agent
                  </button>
                )}
                {onCaptureNote && (
                  <button
                    type="button"
                    disabled={captureBusy}
                    onClick={() => void resolveCapture("note")}
                    className="rounded-sm border border-field bg-strip px-2 py-1 text-xs text-l2 hover:bg-inset hover:text-l1 disabled:opacity-60"
                  >
                    ＋ 插入笔记
                  </button>
                )}
                {frozen.region && (
                  <button
                    type="button"
                    disabled={captureBusy}
                    title="把框住的这块钉在 PDF 上方，滚动正文时对照着看"
                    onClick={() => {
                      const f = frozen;
                      openPeek({
                        key: `cap:${f.page}:${f.region!.x.toFixed(3)}:${f.region!.y.toFixed(3)}`,
                        page: f.page,
                        label: `p.${f.page} 圈选`,
                        region: f.region,
                      });
                      dismissFrozen();
                    }}
                    className="rounded-sm border border-field bg-strip px-2 py-1 text-xs text-l2 hover:bg-inset hover:text-l1 disabled:opacity-60"
                  >
                    钉住对照
                  </button>
                )}
                <button
                  type="button"
                  disabled={captureBusy}
                  onClick={dismissFrozen}
                  className="flex h-6 w-6 items-center justify-center rounded-sm text-xs text-l3 hover:bg-hover hover:text-l1 disabled:opacity-60"
                >
                  ×
                </button>
              </div>
            )}
          </div>
          {floatCard && (
            // 生词卡（＋ 生词 唯一保留的浮卡：带输入框的表单；翻译结果 v2 起进顶部面板）
            <div
              className="absolute z-30 w-72 rounded-md ccode-float-surface p-2.5"
              style={{ left: floatCard.anchor.x, top: floatCard.anchor.y }}
            >
              <>
                  {/* 生词卡：术语（选中词）+ 释义（自动预填可改）+ 出处自动记 */}
                  <p className="break-words text-xs font-medium text-l1">
                    {floatCard.text}
                  </p>
                  <input
                    value={glossMeaning}
                    onChange={(e) => setGlossMeaning(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        void confirmGlossary();
                      }
                    }}
                    placeholder={glossPrefilling ? "正在预填释义…" : "释义"}
                    autoFocus
                    className="mt-1.5 w-full rounded-sm border border-field bg-canvas px-2 py-1 text-xs text-l1 outline-none placeholder:text-l4 focus:border-l4"
                  />
                  <p className="mt-1.5 text-micro text-l4">
                    出处：《{fileStem(fileName)}》第 {floatCard.page} 页
                  </p>
                  <div className="mt-2 flex items-center gap-1">
                    <button
                      type="button"
                      disabled={!glossMeaning.trim() || glossBusy}
                      onClick={() => void confirmGlossary()}
                      className="rounded-sm border border-cta-bd bg-cta px-2 py-1 text-xs text-cta-text hover:brightness-110 disabled:opacity-60"
                    >
                      {glossBusy ? "写入中…" : "加入生词本"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setFloatCard(null)}
                      className="ml-auto flex h-6 w-6 items-center justify-center rounded-sm text-xs text-l3 hover:bg-hover hover:text-l1"
                    >
                      ×
                    </button>
                  </div>
              </>
            </div>
          )}
          {annotCard && (
            // 批注卡：摘句 + 一句批注，记进笔记「标注」（同生词卡的浮卡形态）
            <div
              className="absolute z-30 w-72 rounded-md ccode-float-surface p-2.5"
              style={{ left: annotCard.anchor.x, top: annotCard.anchor.y }}
            >
              <p className="line-clamp-3 break-words text-xs text-l3">
                「{annotCard.text.replace(/\s+/g, " ")}」
              </p>
              <input
                value={annotComment}
                onChange={(e) => setAnnotComment(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void confirmAnnotCard();
                  }
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setAnnotCard(null);
                  }
                }}
                placeholder="写一句批注"
                autoFocus
                className="mt-1.5 w-full rounded-sm border border-field bg-canvas px-2 py-1 text-xs text-l1 outline-none placeholder:text-l4 focus:border-l4"
              />
              <div className="mt-2 flex items-center gap-1">
                <button
                  type="button"
                  disabled={annotBusy}
                  onClick={() => void confirmAnnotCard()}
                  className="rounded-sm border border-cta-bd bg-cta px-2 py-1 text-xs text-cta-text hover:brightness-110 disabled:opacity-60"
                >
                  {annotBusy ? "写入中…" : "记进笔记"}
                </button>
                <span className="text-micro text-l4">第 {annotCard.page} 页</span>
                <button
                  type="button"
                  onClick={() => setAnnotCard(null)}
                  className="ml-auto flex h-6 w-6 items-center justify-center rounded-sm text-xs text-l3 hover:bg-hover hover:text-l1"
                >
                  ×
                </button>
              </div>
            </div>
          )}
          {markPop && annotations?.[markPop.index] && (
            // 点高亮出的小卡：这条标注的批注 + 去笔记里看 / 删掉
            <div
              ref={markPopRef}
              className="absolute z-30 w-72 rounded-md ccode-float-surface p-2.5"
              style={{ left: markPop.anchor.x, top: markPop.anchor.y }}
            >
              <p className="line-clamp-3 break-words text-xs text-l3">
                「{annotations[markPop.index].quote}」
              </p>
              <p className={`mt-1 break-words text-xs ${annotations[markPop.index].comment ? "text-l1" : "text-l4"}`}>
                {annotations[markPop.index].comment || "没有写批注"}
              </p>
              <div className="mt-2 flex items-center gap-1">
                {onRevealAnnotation && (
                  <button
                    type="button"
                    onClick={() => {
                      onRevealAnnotation(annotations[markPop.index]);
                      setMarkPop(null);
                    }}
                    className="rounded-sm border border-field bg-strip px-2 py-1 text-xs text-l2 hover:bg-inset hover:text-l1"
                  >
                    在笔记里看
                  </button>
                )}
                {onRemoveAnnotation && (
                  <button
                    type="button"
                    onClick={() => {
                      const a = annotations[markPop.index];
                      setMarkPop(null);
                      void onRemoveAnnotation(a).then((err) => {
                        if (err) showHint(err);
                      });
                    }}
                    className="rounded-sm px-2 py-1 text-xs text-l3 hover:bg-hover hover:text-err-text"
                  >
                    删掉高亮
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setMarkPop(null)}
                  className="ml-auto flex h-6 w-6 items-center justify-center rounded-sm text-xs text-l3 hover:bg-hover hover:text-l1"
                >
                  ×
                </button>
              </div>
            </div>
          )}
          {(onAskAi || onTranslate || onAddGlossary || onOrganize || onAddAnnotation) && (
            // 主钮（译 / 高亮 / ◈ 问 AI / ＋生词 / ⋯）并排的宽度预留约 320px，避免右缘溢出
            <SelectionFloatBar
              containerRef={scrollRef}
              withinSelector="[data-page-num]"
              reserveWidth={320}
            >
              {onTranslate && (
                <button
                  type="button"
                  // preventDefault 保住选区，click 时才读文字
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={translateSelection}
                  className={FLOAT_BTN}
                >
                  译
                </button>
              )}
              {onAddAnnotation && (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void annotateSelection()}
                  className={FLOAT_BTN}
                >
                  高亮
                </button>
              )}
              {onAskAi && (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => askAi()}
                  className={FLOAT_BTN_PRIMARY}
                >
                  {askAs?.label ?? "◈ 问 AI"}
                </button>
              )}
              {onAddGlossary && (
                <SelectionGate max={60}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={openGlossaryCard}
                    className={FLOAT_BTN}
                  >
                    ＋ 生词
                  </button>
                </SelectionGate>
              )}
              <FloatBarOverflow
                items={[
                  ...(onAddAnnotation ? [{ label: "＋ 批注…", run: openAnnotCard }] : []),
                  ...(onAskAi && !askAs ? [{ label: "↵ 直接发送", run: () => askAi(true) }] : []),
                ]}
              />
              {onOrganize && (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void organize()}
                  disabled={organizing}
                  className={`${FLOAT_BTN_PRIMARY} disabled:opacity-60`}
                >
                  {organizing ? "整理中…" : "整理为笔记"}
                </button>
              )}
            </SelectionFloatBar>
          )}
          {/* 术语悬停释义（HoverTip 应用内 tooltip，禁原生 title） */}
          <HoverTip tip={glossTip} text={glossTip?.text ?? ""} />
          </div>
        </>
      )}
    </div>
  );
}

/** memo：父级重渲染不级联到 pdf.js 渲染管线（同 PdfPreview 口径） */
export default memo(PdfContinuousView);
