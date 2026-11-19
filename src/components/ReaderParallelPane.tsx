import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import type * as pdfjs from "pdfjs-dist";
import { documentParagraphs, pageParagraphs, type PdfFracBox, type PdfParagraph, type PdfTextItem } from "../pdf-paragraphs";
import {
  anchorForViewport,
  batchNeighbors,
  paragraphAt,
  parallelProgress,
  planBatches,
  translatable,
  translationOrder,
  type ParaState,
  type ParaStatus,
} from "../reader-parallel";
import { buildParallelBatchPrompt, parseParallelBatch, type GlossaryEntry } from "../reader";
import { TranslatedText } from "./ReaderTranslatePanel";

/** PDF 栏交来的事件（ReaderOverlay 转给对照栏） */
export interface ParallelPaneApi {
  onViewport: (page: number, frac: number) => void;
  /** 鼠标在 PDF 第 page 页 (fx, fy)；page = 0 表示移出页面。click 时返回 true = 接住了 */
  onPointer: (page: number, fx: number, fy: number, click: boolean) => boolean;
}

export type ParallelMark = { page: number; boxes: readonly PdfFracBox[]; tone: "hover" | "focus" };

/** 同时在翻几批 */
const CONCURRENCY = 3;
/** 切段最多读多少页（再长的书按需另说） */
const MAX_PAGES = 500;
/** 本次打开 Mesa 内的译文（按 PDF 路径，再按段落哈希）；换篇、关双语、重进都不丢。持久的那份在项目
 *  `.ccode/reader-translations/`（loadCache / saveCache，Rust reader_tl_cache_*），打开时并进来 */
const sessionCache = new Map<string, Map<string, string>>();
const SHOW_ORIGINAL_KEY = "ccode.readerParallelOriginal";

function loadShowOriginal(): boolean {
  try {
    return localStorage.getItem(SHOW_ORIGINAL_KEY) === "1";
  } catch {
    return false;
  }
}

/** getTextContent 文本项 → 切段要的 scale=1 视口坐标 */
async function pageItems(doc: pdfjs.PDFDocumentProxy, n: number) {
  const page = await doc.getPage(n);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const items: PdfTextItem[] = [];
  for (const raw of tc.items as { str?: string; transform?: number[]; width?: number; height?: number; hasEOL?: boolean }[]) {
    if (typeof raw.str !== "string" || !raw.transform) continue;
    const t = raw.transform;
    const [x, y] = vp.convertToViewportPoint(t[4], t[5]) as number[];
    items.push({
      str: raw.str,
      x,
      y,
      w: raw.width ?? 0,
      h: Math.hypot(t[2], t[3]) || (raw.height ?? 0),
      eol: Boolean(raw.hasEOL),
      upright: Math.abs(t[1]) < 1e-3 && Math.abs(t[2]) < 1e-3,
    });
  }
  return { items, w: vp.width, h: vp.height };
}

export default function ReaderParallelPane({
  apiRef,
  doc,
  pdfPath,
  title,
  glossary,
  translate,
  loadCache,
  saveCache,
  unavailable,
  onMarks,
  onScrollPdf,
  onSaveToNote,
  onAsk,
  onClose,
  roomy,
  onToggleRoom,
  hidden = false,
}: {
  apiRef: Ref<ParallelPaneApi | null>;
  doc: pdfjs.PDFDocumentProxy | null;
  pdfPath: string;
  title: string | null;
  glossary: readonly GlossaryEntry[];
  /** 送一次翻译（ai_prompt fnKey="translate"），返回模型原文 */
  translate: (prompt: string) => Promise<string>;
  /** 读这篇存在项目里的译文（{ 段落哈希: 译文 }）；读完才开始翻，免得把存过的又翻一遍 */
  loadCache?: () => Promise<Record<string, string>>;
  /** 翻好一批就存进项目 */
  saveCache?: (entries: { hash: string; zh: string }[]) => void;
  /** 没有能用的翻译配置时的说法（null = 能用） */
  unavailable: string | null;
  onMarks: (marks: ParallelMark[]) => void;
  onScrollPdf: (page: number, frac: number) => void;
  onSaveToNote?: (original: string, translated: string, page: number) => void;
  onAsk?: (translated: string, page: number) => void;
  onClose: () => void;
  /** 笔记栏与对话栏都收起了（给对照让出宽度） */
  roomy: boolean;
  onToggleRoom: () => void;
  /** 双语没开：不画界面，只在后台切段、翻译、存进项目（打开文献就翻全文，点开双语时已经翻好） */
  hidden?: boolean;
}) {
  const [pages, setPages] = useState<Map<number, PdfParagraph[]>>(new Map());
  const [reading, setReading] = useState<{ done: number; total: number } | null>(null);
  const cache = useMemo(() => {
    let m = sessionCache.get(pdfPath);
    if (!m) {
      m = new Map();
      sessionCache.set(pdfPath, m);
    }
    return m;
  }, [pdfPath]);
  const statesRef = useRef(new Map<string, ParaState>());
  const [cacheReady, setCacheReady] = useState(!loadCache);
  useEffect(() => {
    if (!loadCache) return;
    let live = true;
    setCacheReady(false);
    loadCache()
      .then((stored) => {
        if (!live) return;
        for (const [h, zh] of Object.entries(stored)) if (!cache.has(h)) cache.set(h, zh);
      })
      .catch(() => {
        /* 读不到就当没存过 */
      })
      .finally(() => {
        if (live) setCacheReady(true);
      });
    return () => {
      live = false;
    };
    // loadCache 跟 PDF 走（ReaderOverlay 按 pdfPath 稳住）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache]);
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);
  const [showOriginal, setShowOriginal] = useState(loadShowOriginal);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const silentUntilRef = useRef(0);
  const viewRef = useRef<{ page: number; frac: number }>({ page: 1, frac: 0 });
  const genRef = useRef(0);
  const runningRef = useRef(0);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  /** 还在读页时读到了第几页（读完 = 0）：这页最后一段可能要并下一页的开头，先不翻 */
  const readUpToRef = useRef(0);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;

  const stateOf = useCallback(
    (hash: string): ParaStatus => statesRef.current.get(hash)?.status ?? (cache.has(hash) ? "done" : "idle"),
    [cache],
  );
  const zhOf = (hash: string) => statesRef.current.get(hash)?.zh ?? cache.get(hash);

  // ----- 切段：文档到手就从第 1 页逐页读，读一批画一批；每批整篇再过一遍（题录、参考文献、跨页并段） -----
  useEffect(() => {
    const gen = ++genRef.current;
    statesRef.current = new Map();
    setPages(new Map());
    setFocusId(null);
    setHoverId(null);
    if (!doc) return;
    const total = Math.min(doc.numPages, MAX_PAGES);
    readUpToRef.current = 0;
    setReading({ done: 0, total });
    void (async () => {
      const acc = new Map<number, PdfParagraph[]>();
      for (let n = 1; n <= total; n++) {
        if (gen !== genRef.current) return;
        try {
          const { items, w, h } = await pageItems(doc, n);
          acc.set(n, pageParagraphs(items, w, h, n));
        } catch {
          acc.set(n, []);
        }
        if (n % 4 === 0 || n === total) {
          if (gen !== genRef.current) return;
          readUpToRef.current = n < total ? n : 0;
          setPages(documentParagraphs(acc, total));
          setReading({ done: n, total });
        }
      }
      if (gen === genRef.current) setReading(null);
    })();
  }, [doc]);

  // ----- 翻译调度：全文，从当前页往后再回头，几批并行，同一段原文只翻一次 -----
  const pump = useCallback(() => {
    if (unavailable || !cacheReady) return;
    const gen = genRef.current;
    const all = pagesRef.current;
    const pageCount = Math.max(0, ...all.keys());
    if (pageCount === 0) return;
    // 页还没读完时视口可能在已读范围之后：夹进已读的页
    const cur = Math.min(Math.max(1, viewRef.current.page), pageCount);
    const upTo = readUpToRef.current;
    const order = translationOrder(cur, pageCount).filter((n) => !upTo || n < upTo);
    while (runningRef.current < CONCURRENCY) {
      const [batch] = planBatches(all, order, stateOf);
      if (!batch) return;
      runningRef.current++;
      for (const p of batch.paras) statesRef.current.set(p.hash, { status: "loading" });
      bump();
      const items = batch.paras.map((p, i) => ({ id: `P${i + 1}`, text: p.text }));
      const prompt = buildParallelBatchPrompt(items, { title, glossary, ...batchNeighbors(all, batch) });
      void translate(prompt)
        .then((raw) => {
          if (gen !== genRef.current) return;
          const got = parseParallelBatch(raw, items.map((i) => i.id));
          const saved: { hash: string; zh: string }[] = [];
          batch.paras.forEach((p, i) => {
            const zh = got.get(`P${i + 1}`);
            if (zh) {
              cache.set(p.hash, zh);
              saved.push({ hash: p.hash, zh });
              statesRef.current.set(p.hash, { status: "done", zh });
            } else {
              statesRef.current.set(p.hash, { status: "failed", error: "这段没有译文返回" });
            }
          });
          if (saved.length > 0) saveCache?.(saved);
        })
        .catch((e: unknown) => {
          if (gen !== genRef.current) return;
          for (const p of batch.paras) statesRef.current.set(p.hash, { status: "failed", error: String(e) });
        })
        .finally(() => {
          if (gen !== genRef.current) return;
          runningRef.current--;
          bump();
          pump();
        });
    }
  }, [unavailable, cacheReady, stateOf, title, glossary, translate, cache, bump, saveCache]);
  useEffect(() => {
    runningRef.current = 0;
  }, [doc]);
  useEffect(() => {
    pump();
  }, [pages, pump]);

  const retry = useCallback(
    (hashes: readonly string[]) => {
      for (const h of hashes) {
        statesRef.current.delete(h);
        cache.delete(h);
      }
      bump();
      pump();
    },
    [cache, bump, pump],
  );

  // ----- 两边对齐 -----
  const scrollPaneTo = useCallback((id: string, block: "top" | "center") => {
    const body = bodyRef.current;
    const el = body?.querySelector<HTMLElement>(`[data-para-id="${CSS.escape(id)}"]`);
    if (!body || !el || hiddenRef.current) return;
    silentUntilRef.current = Date.now() + 250;
    const top =
      block === "top"
        ? el.offsetTop - 8
        : el.offsetTop - Math.max(8, (body.clientHeight - el.offsetHeight) / 2);
    body.scrollTo({ top: Math.max(0, top) });
  }, []);
  const paraById = useCallback((id: string | null): PdfParagraph | null => {
    if (!id) return null;
    const page = Number(id.split(":")[0]);
    return pagesRef.current.get(page)?.find((p) => p.id === id) ?? null;
  }, []);

  useImperativeHandle(
    apiRef,
    () => ({
      onViewport(page, frac) {
        const prevPage = viewRef.current.page;
        viewRef.current = { page, frac };
        if (page !== prevPage) pump();
        const a = anchorForViewport(pagesRef.current, page, frac);
        if (a) scrollPaneTo(a.id, "top");
      },
      onPointer(page, fx, fy, click) {
        const p = page > 0 ? paragraphAt(pagesRef.current, page, fx, fy) : null;
        if (!click) {
          setHoverId(p?.id ?? null);
          return false;
        }
        if (!p) return false;
        setFocusId(p.id);
        scrollPaneTo(p.id, "center");
        return true;
      },
    }),
    [pump, scrollPaneTo],
  );

  // 译文栏自己滚：把最上面那段对到 PDF 视口顶（每帧最多一次）
  const bodyRafRef = useRef(0);
  function onBodyScroll() {
    if (Date.now() < silentUntilRef.current || bodyRafRef.current) return;
    bodyRafRef.current = requestAnimationFrame(() => {
      bodyRafRef.current = 0;
      const body = bodyRef.current;
      if (!body || Date.now() < silentUntilRef.current) return;
      const top = body.scrollTop + 8;
      for (const el of body.querySelectorAll<HTMLElement>("[data-para-id]")) {
        if (el.offsetTop + el.offsetHeight > top) {
          const p = paraById(el.dataset.paraId ?? null);
          if (p) onScrollPdf(p.page, Math.max(0, (p.boxes[0]?.y ?? 0) - 0.01));
          return;
        }
      }
    });
  }
  useEffect(() => () => cancelAnimationFrame(bodyRafRef.current), []);

  // PDF 上画框：鼠标指着的一段（淡）+ 点中的一段（深）；跨页并过的段，续写的那几截一起画
  useEffect(() => {
    const marks: ParallelMark[] = [];
    const add = (p: PdfParagraph | null, tone: ParallelMark["tone"]) => {
      if (!p) return;
      marks.push({ page: p.page, boxes: p.boxes, tone });
      for (const t of p.tail ?? []) marks.push({ page: t.page, boxes: t.boxes, tone });
    };
    add(paraById(focusId), "focus");
    if (hoverId !== focusId) add(paraById(hoverId), "hover");
    onMarks(marks);
  }, [hoverId, focusId, paraById, onMarks, pages]);
  useEffect(() => () => onMarks([]), [onMarks]);
  // 点中的那段闪一下就淡掉
  useEffect(() => {
    if (!focusId) return;
    const t = setTimeout(() => setFocusId(null), 2400);
    return () => clearTimeout(t);
  }, [focusId]);

  const progress = parallelProgress(pages, stateOf);
  const failedHashes = useMemo(() => {
    const out: string[] = [];
    for (const paras of pages.values()) for (const p of paras) if (stateOf(p.hash) === "failed") out.push(p.hash);
    return [...new Set(out)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, progress.failed]);
  if (hidden) return null;
  const sortedPages = [...pages.keys()].sort((a, b) => a - b);
  const btn = "rounded-sm px-1.5 py-0.5 text-micro text-l3 hover:bg-hover hover:text-l1";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-raised" data-reader-parallel>
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-hairline px-2 text-xs">
        <span className="text-l2">译文</span>
        <span className="min-w-0 flex-1 truncate text-micro tabular-nums text-l4">
          {unavailable
            ? unavailable
            : reading
              ? `正在读取第 ${reading.done} / ${reading.total} 页…`
              : !cacheReady
                ? "正在读取已存的译文…"
              : `已译 ${progress.done} / ${progress.total} 段${progress.busy > 0 ? ` · 正在翻 ${progress.busy} 段` : ""}${
                  progress.failed > 0 ? ` · ${progress.failed} 段没翻成` : ""
                }`}
        </span>
        {progress.failed > 0 && (
          <button type="button" className={btn} onClick={() => retry(failedHashes)}>
            重试
          </button>
        )}
        <button
          type="button"
          aria-pressed={showOriginal}
          title="在每段译文下面显示原文"
          className={`${btn} ${showOriginal ? "bg-seg-sel text-l1" : ""}`}
          onClick={() =>
            setShowOriginal((v) => {
              try {
                localStorage.setItem(SHOW_ORIGINAL_KEY, v ? "0" : "1");
              } catch {
                /* 记不住就算了 */
              }
              return !v;
            })
          }
        >
          原文
        </button>
        <button
          type="button"
          title={roomy ? "展开笔记栏和对话栏" : "收起笔记栏和对话栏，给双语对照让出宽度"}
          className={btn}
          onClick={onToggleRoom}
        >
          {roomy ? "还原两栏" : "腾出宽度"}
        </button>
        <button type="button" aria-label="关掉双语对照，只看原文" title="关掉双语对照，只看原文" className={btn} onClick={onClose}>
          ×
        </button>
      </div>
      <div ref={bodyRef} onScroll={onBodyScroll} className="relative min-h-0 flex-1 overflow-y-auto px-4 pb-10">
        {/* 一行四十来个字最好读：栏再宽，正文也不铺满 */}
        <div className="relative mx-auto max-w-[40em]">
        {sortedPages.map((n) => {
          const all = pages.get(n) ?? [];
          const paras = all.filter(translatable);
          const refStart = all.findIndex((p) => p.kind === "reference");
          // 参考文献起往后的页整页不列，只在开头那页留一句
          if (paras.length === 0 && refStart === 0 && pages.get(n - 1)?.some((p) => p.kind === "reference")) return null;
          return (
            <section key={n}>
              <div className="my-3 flex items-center gap-2 text-micro text-l4">
                <span className="h-px flex-1 bg-hairline" />第 {n} 页<span className="h-px flex-1 bg-hairline" />
              </div>
              {all.length === 0 && <p className="py-1 text-micro text-l4">这一页没有可读的文字（扫描页或整页是图）</p>}
              {paras.map((p) => {
                const st = stateOf(p.hash);
                const zh = zhOf(p.hash);
                const err = statesRef.current.get(p.hash)?.error;
                const lit = p.id === focusId ? "bg-cta/12" : p.id === hoverId ? "bg-hover" : "";
                return (
                  <div
                    key={p.id}
                    data-para-id={p.id}
                    onMouseEnter={() => setHoverId(p.id)}
                    onMouseLeave={() => setHoverId((h) => (h === p.id ? null : h))}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest("button") || window.getSelection()?.isCollapsed === false) return;
                      setFocusId(p.id);
                      onScrollPdf(p.page, Math.max(0, (p.boxes[0]?.y ?? 0) - 0.02));
                    }}
                    className={`group relative -mx-2 my-2 cursor-default rounded-md px-2 py-1.5 transition-colors ${lit}`}
                  >
                    {st === "done" && zh ? (
                      <TranslatedText
                        style={{ lineHeight: 1.75 }}
                        className={`whitespace-pre-line text-justify text-l1 ${p.kind === "heading" ? "text-sm font-semibold" : "text-sm"}`}
                        text={zh}
                      />
                    ) : (
                      <p className={`text-justify text-xs leading-5 text-l4 ${p.kind === "heading" ? "font-semibold" : ""}`}>{p.text}</p>
                    )}
                    {st === "done" && showOriginal && (
                      <p className="mt-1 text-justify text-micro leading-[1.6] text-l4">{p.text}</p>
                    )}
                    {(st === "loading" || st === "queued") && (
                      <p className="mt-1 animate-pulse text-micro text-l3">正在翻译…</p>
                    )}
                    {st === "idle" && !unavailable && (
                      <p className="mt-1 text-micro text-l4">排队等着翻</p>
                    )}
                    {st === "failed" && (
                      <p className="mt-1 flex items-center gap-2 text-micro text-err-text">
                        <span className="min-w-0 truncate">没翻成：{err ?? "未知原因"}</span>
                        <button type="button" className={btn} onClick={() => retry([p.hash])}>
                          重试
                        </button>
                      </p>
                    )}
                    {st === "done" && zh && (
                      // 浮在这段上沿外面（落在上一段末行右侧的空白里），不压这段的字
                      <div className="ccode-float-surface absolute -top-4 right-1 z-10 hidden items-center gap-0.5 rounded-sm border border-field px-0.5 shadow group-hover:flex">
                        {onSaveToNote && (
                          <button type="button" className={btn} onClick={() => onSaveToNote(p.text, zh, p.page)}>
                            存进笔记
                          </button>
                        )}
                        {onAsk && (
                          <button type="button" className={btn} onClick={() => onAsk(zh, p.page)}>
                            问这段
                          </button>
                        )}
                        <button type="button" className={btn} title="不满意，重新翻这一段" onClick={() => retry([p.hash])}>
                          重译
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
              {refStart >= 0 && !pages.get(n - 1)?.some((p) => p.kind === "reference") && (
                <p className="my-3 text-center text-micro text-l4">参考文献从这里开始，不翻译</p>
              )}
            </section>
          );
        })}
        {sortedPages.length === 0 && (
          <p className="py-6 text-center text-xs text-l4">{doc ? "正在读取 PDF 的文字…" : "PDF 还没打开"}</p>
        )}
        </div>
      </div>
    </div>
  );
}
