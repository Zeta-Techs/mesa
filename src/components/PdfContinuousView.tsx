import { memo, useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import SelectionFloatBar from "./SelectionFloatBar";
import { HoverTip } from "./HoverTip";
import { IS_MAC } from "../hotkeys";
import {
  PdfPageView,
  loadPdfBytes,
  openPdfDocument,
  type PdfActionResult,
} from "./PdfPreview";
import { usePdfGestureZoom } from "./use-pdf-zoom";
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
} from "../reader";

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

/** 浮动条 ⋯ 溢出菜单（↵ 直接发送收在这里，主条保持 4 钮）：
 *  开关状态随浮动条卸载自动复位（选区收起即关，不会在下次选区时残留展开） */
function FloatBarOverflow({ onSend }: { onSend: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative">
      <button
        type="button"
        // preventDefault 保住选区，click 时才读文字
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        className="flex h-6 w-6 items-center justify-center rounded-sm text-xs text-l3 hover:bg-hover hover:text-l1"
      >
        ⋯
      </button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 rounded-md border border-hairline ccode-float-surface p-1">
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setOpen(false);
              onSend();
            }}
            className="whitespace-nowrap rounded-sm px-2 py-1 text-xs text-l2 hover:bg-hover hover:text-l1"
          >
            ↵ 直接发送
          </button>
        </div>
      )}
    </span>
  );
}

/** 首页尺寸实测前的占位估算（A4 scale=1）；实测后逐页缓存修正 */
const FALLBACK_PAGE = { w: 595, h: 842 };
/** 离窗页的预渲染带宽：可视窗口上下各扩展的页数 */
const RENDER_MARGIN = 2;
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
  onBack,
  onCaptureAgent,
  onCaptureNote,
  glossTerms,
  dark,
  onTranslate,
  onRequestTranslate,
  onAddGlossary,
  onOrganize,
  onOpenReader,
  maxFitMultiplier,
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
  /** 加载失败/被白名单拒绝时错误条上的「← 返回」 */
  onBack?: () => void;
  /** 圈选截图「◈ 发给 agent」：返回 null 成功，否则为要展示的提示（批次 B2） */
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
  /** 生词高亮术语表（阅读区打开时加载一次，增删后刷新） */
  glossTerms?: readonly GlossaryEntry[];
  /** 护眼反色开关（只反 canvas 层，CSS filter，不动 canvas 数据） */
  dark?: boolean;
  /** 翻译触发（选段「译」/ ⌘+点击段落）：状态机与面板都在上层（ReaderOverlay
      翻译面板，右栏终端上方），本组件只上送原文与页码 */
  onTranslate?: (text: string, page: number) => void;
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

  // ===== 圈选截图（批次 B2）：模式开关 → 拖矩形 → 定格小条（发给 agent / 插入笔记） =====
  const captureSupported = Boolean(onCaptureAgent || onCaptureNote);
  const [captureOn, setCaptureOn] = useState(false);
  /** 拖拽中的矩形（内容层坐标）；松手后清空 */
  const [dragRect, setDragRect] = useState<CaptureRect | null>(null);
  /** 松手后定格：矩形 + 裁好的 PNG + 命中页号，等用户在浮条上选去向 */
  const [frozen, setFrozen] = useState<{
    rect: CaptureRect;
    blob: Blob;
    page: number;
  } | null>(null);
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

  function exitCapture() {
    setCaptureOn(false);
    setDragRect(null);
    setFrozen(null);
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
    if (!onTranslate || captureOn) return;
    if (!e.metaKey && !e.ctrlKey) return;
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

  // Esc 退出圈选（capture 相监听 + stopPropagation：抢在 ReaderOverlay 的 Esc 关阅读区之前）
  useEffect(() => {
    if (!captureOn) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.stopPropagation();
      exitCapture();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [captureOn]);

  // 加载文档（路径切换整体重来）
  useEffect(() => {
    let cancelled = false;
    let task: pdfjs.PDFDocumentLoadingTask | null = null;
    setDoc(null);
    setError(null);
    setPageCount(0);
    setPageSizes({});
    setSeenPages(new Set([1]));
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
  }, [path, cwdHint]);

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

  // 渲染窗口 = 可视页 ±2（离窗页只留骨架占位）
  const renderRange = (() => {
    if (!doc) return { lo: 1, hi: 0 };
    let lo = 1;
    let hi = 1;
    for (const n of seenPages) {
      lo = Math.min(lo, n);
      hi = Math.max(hi, n);
    }
    return {
      lo: Math.max(1, lo - RENDER_MARGIN),
      hi: Math.min(pageCount, hi + RENDER_MARGIN),
    };
  })();

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

  // 可视窗口跟踪：slot 全部常驻（占位或真渲染），IO 只汇报可见性
  useEffect(() => {
    const rootEl = scrollRef.current;
    if (!rootEl || !doc) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (liveZoomingRef.current) return;
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
        err ?? (send ? "已发送给阅读会话" : "已写入终端输入行，检查后回车发送"),
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
    setFrozen({ rect: r, blob, page: hit.page });
  }

  /** 圈选拖拽：内容层上按下起框，pointer 全程在 window 上跟（出层也不断） */
  function startCaptureDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const wrapper = contentRef.current;
    if (!wrapper) return;
    e.preventDefault();
    setFrozen(null); // 有定格条时起新框即丢弃
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

  /** 定格浮条两去向：成功即收条（模式保持，Esc/再点「▦ 圈选」退出） */
  async function resolveCapture(target: "agent" | "note") {
    if (!frozen || captureBusy) return;
    setCaptureBusy(true);
    try {
      const handler = target === "agent" ? onCaptureAgent : onCaptureNote;
      const err = await (handler?.(frozen.blob, frozen.page, fileName) ??
        Promise.resolve("当前环境不支持截图"));
      showHint(
        err ??
          (target === "agent" ? "已写入终端输入行，检查后回车发送" : "已贴进笔记"),
      );
      if (!err) setFrozen(null);
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
    <div className="flex min-h-0 flex-1 flex-col">
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
              {currentPage} / {pageCount}
            </span>
            <div className="flex items-center justify-end gap-0.5">
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
          <div
            ref={scrollRef}
            onScroll={() => {
              if (liveZoomingRef.current) return;
              setGlossTip(null);
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
              const shouldRender = n >= renderRange.lo && n <= renderRange.hi;
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
                        : "animate-pulse rounded-sm bg-inset"
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
                      (contentRef.current?.clientWidth ?? 400) - 260,
                    ),
                  ),
                  top: frozen.rect.y + frozen.rect.h + 6,
                }}
              >
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
                <button
                  type="button"
                  disabled={captureBusy}
                  onClick={() => setFrozen(null)}
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
          {(onAskAi || onTranslate || onAddGlossary || onOrganize) && (
            // 四个主钮（译 / ◈ 问 AI / ＋生词 / ⋯）并排的宽度预留约 260px，避免右缘溢出
            <SelectionFloatBar
              containerRef={scrollRef}
              withinSelector="[data-page-num]"
              reserveWidth={260}
            >
              {onTranslate && (
                <button
                  type="button"
                  // preventDefault 保住选区，click 时才读文字
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={translateSelection}
                  className="rounded-sm border border-field bg-strip px-2 py-1 text-xs text-l2 hover:bg-inset hover:text-l1"
                >
                  译
                </button>
              )}
              {onAskAi && (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => askAi()}
                  className="rounded-sm border border-cta-bd bg-cta px-2 py-1 text-xs text-cta-text hover:brightness-110"
                >
                  ◈ 问 AI
                </button>
              )}
              {onAddGlossary && (
                <SelectionGate max={60}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={openGlossaryCard}
                    className="rounded-sm border border-field bg-strip px-2 py-1 text-xs text-l2 hover:bg-inset hover:text-l1"
                  >
                    ＋ 生词
                  </button>
                </SelectionGate>
              )}
              {onAskAi && <FloatBarOverflow onSend={() => askAi(true)} />}
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
