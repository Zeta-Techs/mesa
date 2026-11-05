import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type * as pdfjs from "pdfjs-dist";
import { X } from "lucide-react";
import {
  PDF_MAX_CANVAS_PIXELS,
  PDF_ZOOM_STEP,
  clampPdfPeekWin,
  defaultPdfPeekWin,
  loadPdfPeekWin,
  pdfPeekScrollTop,
  pdfWheelShouldZoom,
  pdfWheelZoomFactor,
  savePdfPeekWin,
  type PdfPeekItem,
  type PdfPeekWin,
} from "../reader";

/**
 * 对照窗（2026-11-05 用户：读文献时想对照着图看，图一般在后面几页）：
 * 把一块 PDF 区域钉在 PDF 栏上方，正文照常滚、窗不动。两种来源——圈选后「钉住对照」（框哪块显示哪块），
 * 正文 / 笔记里点 Fig. N（显示那张图所在的整页，先滚到图注）。几项并存时窗顶是标签。
 * 挂在 PDF 栏根（不在滚动层里）；拖窗头换位、拖右下角改大小，松手记 localStorage。
 * 窗内按区域单独渲染：适配窗宽 × 窗内倍率，⌘/Ctrl+滚轮与 − / ＋ 缩放，不影响正文的倍率。
 */
export default function PdfFigurePeek({
  doc,
  items,
  activeKey,
  dark,
  onActivate,
  onClose,
  onJump,
}: {
  doc: pdfjs.PDFDocumentProxy;
  items: readonly PdfPeekItem[];
  activeKey: string;
  dark?: boolean;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  /** 正文跳到这一项的页 */
  onJump: (page: number) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [win, setWin] = useState<PdfPeekWin | null>(null);
  const winRef = useRef(win);
  winRef.current = win;
  const [zoom, setZoom] = useState(1);
  const [bodyW, setBodyW] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const item = items.find((i) => i.key === activeKey) ?? items[0];

  // 量父容器（PDF 栏根）：窗位置 / 大小都收在里面；栏变窄时跟着收
  useLayoutEffect(() => {
    const host = rootRef.current?.parentElement;
    if (!host) return;
    const measure = () => {
      const next = { w: host.clientWidth, h: host.clientHeight };
      setBox((prev) => (prev && prev.w === next.w && prev.h === next.h ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!box || box.w === 0 || box.h === 0) return;
    setWin((prev) => clampPdfPeekWin(prev ?? loadPdfPeekWin() ?? defaultPdfPeekWin(box), box));
  }, [box]);

  // 窗内容宽（适配倍率按它算）
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () => setBodyW(body.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(body);
    return () => ro.disconnect();
  }, [win !== null]);

  // 换一项就回到适配宽度
  useEffect(() => setZoom(1), [item?.key]);

  // 渲染这一项的区域：适配窗宽 × zoom；整页且有图注位置时，首次画好滚到图注
  const scrolledKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!item || bodyW <= 0) return;
    let cancelled = false;
    let task: pdfjs.RenderTask | null = null;
    const t = setTimeout(() => {
      void (async () => {
        try {
          setError(null);
          const page = await doc.getPage(item.page);
          if (cancelled) return;
          const base = page.getViewport({ scale: 1 });
          const r = item.region ?? { x: 0, y: 0, w: 1, h: 1 };
          const regionW = r.w * base.width;
          const regionH = r.h * base.height;
          const scale = (Math.max(40, bodyW - 2) / regionW) * zoom;
          const cssW = Math.floor(regionW * scale);
          const cssH = Math.floor(regionH * scale);
          let out = window.devicePixelRatio || 1;
          // 画布像素上限（同正文）：放太大时降清晰度，不整块涂黑
          if (cssW * cssH * out * out > PDF_MAX_CANVAS_PIXELS) {
            out = Math.sqrt(PDF_MAX_CANVAS_PIXELS / (cssW * cssH));
          }
          const viewport = page.getViewport({ scale });
          const canvas = canvasRef.current;
          if (!canvas) return;
          const off = document.createElement("canvas");
          off.width = Math.max(1, Math.floor(cssW * out));
          off.height = Math.max(1, Math.floor(cssH * out));
          // 先绑 alpha:true（Windows WebView2 深色下不透明画布会合成白块，同正文）
          off.getContext("2d", { alpha: true });
          task = page.render({
            canvas: off,
            viewport,
            transform: [out, 0, 0, out, -r.x * viewport.width * out, -r.y * viewport.height * out],
          });
          await task.promise;
          if (cancelled) return;
          canvas.width = off.width;
          canvas.height = off.height;
          canvas.style.width = `${cssW}px`;
          canvas.style.height = `${cssH}px`;
          canvas.getContext("2d", { alpha: true })?.drawImage(off, 0, 0);
          const body = bodyRef.current;
          if (body && item.focusY != null && !item.region && scrolledKeyRef.current !== item.key) {
            scrolledKeyRef.current = item.key;
            body.scrollTop = pdfPeekScrollTop(item.focusY, cssH, body.clientHeight);
          }
        } catch (e) {
          if (!cancelled && (e as { name?: string })?.name !== "RenderingCancelledException") {
            setError(String(e));
          }
        }
      })();
    }, 60);
    return () => {
      cancelled = true;
      clearTimeout(t);
      task?.cancel();
    };
  }, [doc, item?.key, item?.page, item?.region, item?.focusY, bodyW, zoom]);

  // 窗内 ⌘/Ctrl+滚轮、触控板捏合只缩这扇窗（拦在这里，不冒到正文的缩放）
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const onWheel = (e: WheelEvent) => {
      if (!pdfWheelShouldZoom(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const f = pdfWheelZoomFactor(e.deltaY, e.deltaMode);
      if (f != null) setZoom((z) => Math.min(6, Math.max(0.5, z * f)));
    };
    body.addEventListener("wheel", onWheel, { passive: false });
    return () => body.removeEventListener("wheel", onWheel);
  }, [win !== null]);

  /** 拖窗头 / 拖右下角：逐帧改位置，松手按容器收边并记下 */
  function startDrag(e: React.PointerEvent, mode: "move" | "resize") {
    if (e.button !== 0 || !win || !box) return;
    if ((e.target as HTMLElement).closest("button") && mode === "move") return;
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const start = win;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      setWin(
        clampPdfPeekWin(
          mode === "move"
            ? { ...start, x: start.x + dx, y: start.y + dy }
            : { ...start, w: start.w + dx, h: start.h + dy },
          box,
        ),
      );
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (winRef.current) savePdfPeekWin(winRef.current);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  const btn =
    "flex h-6 min-w-6 shrink-0 items-center justify-center rounded-sm px-1 text-l3 hover:bg-hover hover:text-l1";
  if (!item) return null;
  return (
    <div
      ref={rootRef}
      data-figure-peek
      role="dialog"
      aria-label={`对照：${item.label}`}
      className="ccode-float-surface absolute z-30 flex flex-col overflow-hidden rounded-md border border-field"
      style={
        win
          ? { left: win.x, top: win.y, width: win.w, height: win.h }
          : { left: 0, top: 0, width: 0, height: 0, visibility: "hidden" }
      }
    >
      <div
        className="flex h-8 shrink-0 cursor-grab items-center gap-1 border-b border-hairline px-1.5 active:cursor-grabbing"
        onPointerDown={(e) => startDrag(e, "move")}
        title="拖动换位置"
      >
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              onClick={() => onActivate(it.key)}
              title={`第 ${it.page} 页`}
              className={`group/tab flex h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 ${
                it.key === item.key ? "bg-seg-sel text-l1" : "text-l3 hover:text-l1"
              }`}
            >
              <span className="text-xs">{it.label}</span>
              {items.length > 1 && (
                <span
                  role="button"
                  aria-label={`关掉 ${it.label}`}
                  className="text-micro opacity-60 hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(it.key);
                  }}
                >
                  ×
                </span>
              )}
            </button>
          ))}
        </div>
        <button type="button" className={btn} title="缩小" onClick={() => setZoom((z) => Math.max(0.5, z / PDF_ZOOM_STEP))}>
          <span className="text-xs">−</span>
        </button>
        <button type="button" className={btn} title="适配窗宽" onClick={() => setZoom(1)}>
          <span className="text-micro tabular-nums">{Math.round(zoom * 100)}%</span>
        </button>
        <button type="button" className={btn} title="放大（窗里 ⌘/Ctrl+滚轮也行）" onClick={() => setZoom((z) => Math.min(6, z * PDF_ZOOM_STEP))}>
          <span className="text-xs">＋</span>
        </button>
        <button type="button" className={btn} title="正文跳到这一页" onClick={() => onJump(item.page)}>
          <span className="text-xs">p.{item.page}</span>
        </button>
        <button type="button" className={btn} aria-label="关掉对照窗" title="关掉" onClick={() => onClose(item.key)}>
          <X size={13} strokeWidth={1.8} />
        </button>
      </div>
      <div ref={bodyRef} className={`relative min-h-0 flex-1 overflow-auto bg-inset ${dark ? "ccode-reader-dark" : ""}`}>
        {error ? (
          <p className="p-3 text-xs text-err-text">{error}</p>
        ) : (
          <div data-page-num={item.page} className="w-max bg-white">
            <canvas ref={canvasRef} className="block" />
          </div>
        )}
      </div>
      <div
        aria-hidden="true"
        className="absolute right-0 bottom-0 h-3.5 w-3.5 cursor-nwse-resize"
        onPointerDown={(e) => startDrag(e, "resize")}
        title="拖动改大小"
      />
    </div>
  );
}
