import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { PenLine } from "lucide-react";
import { pdfWheelShouldZoom, pdfWheelZoomFactor } from "../reader";
import { imageEditActionLabel } from "../chat-image";
import PreviewErrorState from "./PreviewErrorState";
import { useFileVersion } from "../file-watch";
import type { ReviewAnnotate } from "../draft-review";
import ImageMarkDialog from "./ImageMarkDialog";
import { formatBytes, imageFitScale } from "../image-view";
import { cachedImageBytes, cachedImageDims, cachedImageUrl, loadImageUrl, revalidateImageUrl } from "../image-cache";

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

const MIN_SCALE = 0.05;
const MAX_SCALE = 8;
const clampScale = (v: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, v));

/**
 * 图片只读预览：png/jpg/gif/webp/svg 经 read_image_bytes（与 md 内嵌图同一通道）。
 * 2026-10-26 重做缩放：原先 transform: scale 放在居中的滚动框里，放大后左边和上边那部分滚不过去；
 * 现在按倍率改真实宽高（布局尺寸跟着变，滚动范围完整），默认「适应窗口」，可切 100%，
 * ⌘/Ctrl+滚轮或触控板捏合以指针处为锚缩放，放大后按住拖动平移，双击在适应 / 100% 间切换。
 */
function ImagePreview({
  path,
  cwdHint,
  onAnnotate,
  onEditInChat,
  hideName = false,
}: {
  path: string;
  cwdHint: string | null;
  /** 审阅：在图上框出问题位置并加一条意见（带红框的图随意见交出去） */
  onAnnotate?: ReviewAnnotate;
  /** 对话页右栏预览：把当前图送进左侧聊天标注台，红框圈出位置直接发给 AI */
  onEditInChat?: () => void;
  /** 外层弹窗标题已显示文件名时隐藏工具条里的重复文件名 */
  hideName?: boolean;
}) {
  const [annotating, setAnnotating] = useState(false);
  const [annotateMsg, setAnnotateMsg] = useState<string | null>(null);
  // 读图走聊天同一份缓存（image-cache，二进制通道 + 预解码）：聊天里看过的图首帧就有，宽高也已知，
  // 不再另走 base64 通道重读一遍、先闪「正在加载图片…」（2026-11-24 用户：点开图闪一下再呈现）
  const [url, setUrl] = useState<string | null>(() => cachedImageUrl(path) ?? null);
  const [bytes, setBytes] = useState(() => cachedImageBytes(path) ?? 0);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  /** "fit" = 跟着框大小走；数字 = 固定倍率 */
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(() => cachedImageDims(path) ?? null);
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 缩放锚点：缩放前指针下的图片坐标（图片像素）与指针在框内的位置，布局后据此回正滚动 */
  const anchorRef = useRef<{ ix: number; iy: number; px: number; py: number } | null>(null);
  const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // 磁盘上换了一版（重新出图）：换图，缩放与滚动不动
  const fileVersion = useFileVersion(path);

  const shownPathRef = useRef(path);
  useEffect(() => {
    if (shownPathRef.current === path) return;
    shownPathRef.current = path;
    setAnnotating(false);
    setAnnotateMsg(null);
    setUrl(cachedImageUrl(path) ?? null);
    setNatural(cachedImageDims(path) ?? null);
    setBytes(cachedImageBytes(path) ?? 0);
    setZoom("fit");
  }, [path, cwdHint]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        // 缓存里有就核一次磁盘戳（重新出图后换新图），没有就读进缓存
        const fresh = cachedImageUrl(path) ? await revalidateImageUrl(path, cwdHint) : null;
        const next = fresh ?? cachedImageUrl(path) ?? (await loadImageUrl(path, cwdHint));
        if (cancelled) return;
        setUrl(next);
        const d = cachedImageDims(path);
        if (d) setNatural(d);
        setBytes(cachedImageBytes(path) ?? 0);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, cwdHint, retry, fileVersion]);

  // 框的大小（适应窗口要用；分栏拖动、开窗口都会变）。在上屏前量（layout effect）：
  // 量之前框是 0，适应倍率会按 100% 算，图先按原尺寸画一帧再缩
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [url]);

  const fit = natural ? imageFitScale(natural, box, 24) : 1;
  const scale = zoom === "fit" ? fit : zoom;

  // 缩放后按锚点回正：让缩放前指针下的那一点仍在指针下
  useLayoutEffect(() => {
    const a = anchorRef.current;
    const el = scrollRef.current;
    const img = el?.querySelector("img");
    if (!a || !el || !img) return;
    anchorRef.current = null;
    const ir = img.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    el.scrollLeft += ir.left - er.left + a.ix * scale - a.px;
    el.scrollTop += ir.top - er.top + a.iy * scale - a.py;
  }, [scale]);

  function zoomTo(next: number, pointer?: { x: number; y: number }) {
    const el = scrollRef.current;
    const img = el?.querySelector("img");
    if (el && img) {
      const er = el.getBoundingClientRect();
      const ir = img.getBoundingClientRect();
      const px = pointer ? pointer.x - er.left : el.clientWidth / 2;
      const py = pointer ? pointer.y - er.top : el.clientHeight / 2;
      anchorRef.current = {
        ix: (px + er.left - ir.left) / scale,
        iy: (py + er.top - ir.top) / scale,
        px,
        py,
      };
    }
    setZoom(clampScale(next));
  }

  const overflowing =
    natural !== null &&
    (natural.w * scale > box.w + 1 || natural.h * scale > box.h + 1);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <div className="flex shrink-0 items-center gap-2 bg-strip px-3 py-1.5 text-xs">
        {!hideName && (
          <span className="truncate text-l3" title={path}>
            {basename(path)}
          </span>
        )}
        {natural && (
          <span className="shrink-0 tabular-nums text-l4" title={hideName ? path : undefined}>
            {natural.w} × {natural.h}
            {bytes ? ` · ${formatBytes(bytes)}` : ""}
          </span>
        )}
        {url && (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {onAnnotate && (
              <button
                type="button"
                className="mr-1 rounded-sm border border-cta-bd bg-cta px-1.5 text-cta-text hover:brightness-110"
                onClick={() => {
                  setAnnotating(true);
                  setAnnotateMsg(null);
                }}
                title="在图上拖出红框指出问题（如拼图错误），写一句意见"
              >
                框选加意见
              </button>
            )}
            {onEditInChat && !onAnnotate && (
              <button
                type="button"
                className="mr-1 inline-flex items-center gap-1 rounded-sm border border-field bg-canvas px-1.5 py-0.5 text-l1 transition-colors hover:bg-hover"
                onClick={onEditInChat}
                title="把这张图打开到左侧聊天标注台，红框圈出位置直接发给 AI"
              >
                <PenLine size={11} strokeWidth={1.8} aria-hidden="true" />
                {imageEditActionLabel(path)}
              </button>
            )}
            <button
              type="button"
              className={`rounded-sm px-1.5 hover:bg-hover hover:text-l1 ${zoom === "fit" ? "text-l1" : "text-l3"}`}
              onClick={() => setZoom("fit")}
              title="整张图放进框里"
            >
              适应
            </button>
            <button
              type="button"
              className={`rounded-sm px-1.5 hover:bg-hover hover:text-l1 ${zoom === 1 ? "text-l1" : "text-l3"}`}
              onClick={() => zoomTo(1)}
              title="原始大小（一个图片像素对一个屏幕点）"
            >
              100%
            </button>
            <button
              type="button"
              className="rounded-sm px-1.5 text-l3 hover:bg-hover hover:text-l1"
              onClick={() => zoomTo(scale / 1.25)}
              title="缩小"
              aria-label="缩小"
            >
              −
            </button>
            <span className="w-11 text-center font-mono tabular-nums text-l3">
              {Math.round(scale * 100)}%
            </span>
            <button
              type="button"
              className="rounded-sm px-1.5 text-l3 hover:bg-hover hover:text-l1"
              onClick={() => zoomTo(scale * 1.25)}
              title="放大"
              aria-label="放大"
            >
              +
            </button>
          </span>
        )}
      </div>
      {annotateMsg && <p className="shrink-0 bg-strip px-3 pb-1.5 text-micro text-l3">{annotateMsg}</p>}
      {annotating && onAnnotate && url && (
        <ImageMarkDialog
          url={url}
          name={basename(path)}
          fileName={basename(path)}
          onAnnotate={(text, fileName, note, markPath) => {
            const err = onAnnotate(text, fileName, note, markPath);
            setAnnotateMsg(err ?? "已加进上面的意见");
            return err;
          }}
          onClose={() => setAnnotating(false)}
        />
      )}
      {error ? (
        <PreviewErrorState error={error} kind="图片" path={path} onRetry={() => {
          setRetry((v) => v + 1);
        }} />
      ) : url === null ? (
        <div className="p-3">
          <p className="text-sm text-l4">正在加载图片…</p>
        </div>
      ) : (
        <div
          ref={scrollRef}
          className={`min-h-0 flex-1 overflow-auto ${overflowing ? (dragging ? "cursor-grabbing" : "cursor-grab") : ""}`}
          style={{
            backgroundImage:
              "repeating-conic-gradient(var(--color-inset) 0% 25%, transparent 0% 50%)",
            backgroundSize: "16px 16px",
          }}
          onWheel={(e) => {
            if (!pdfWheelShouldZoom(e)) return;
            const factor = pdfWheelZoomFactor(e.deltaY, e.deltaMode);
            if (!factor) return;
            e.preventDefault();
            zoomTo(scale * factor, { x: e.clientX, y: e.clientY });
          }}
          onPointerDown={(e) => {
            const el = scrollRef.current;
            // 点在滚动条上（target 是滚动框自己）交给原生拖滚动条
            if (!overflowing || !el || e.button !== 0 || e.target === el) return;
            dragRef.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
            el.setPointerCapture(e.pointerId);
            setDragging(true);
          }}
          onPointerMove={(e) => {
            const d = dragRef.current;
            const el = scrollRef.current;
            if (!d || !el) return;
            el.scrollLeft = d.left - (e.clientX - d.x);
            el.scrollTop = d.top - (e.clientY - d.y);
          }}
          onPointerUp={() => {
            dragRef.current = null;
            setDragging(false);
          }}
          onPointerCancel={() => {
            dragRef.current = null;
            setDragging(false);
          }}
        >
          {/* min-w/h-full + w-max + m-auto：比框小时居中，比框大时从左上角铺开、四边都滚得到。
              宽高已知时等框量好再画，首帧就是最终大小；读不出宽高（svg 等）照旧先画再按 onLoad 定 */}
          <div className="flex min-h-full min-w-full w-max p-3">
            {(!natural || box.w > 0) && <img
              src={url}
              alt={basename(path)}
              draggable={false}
              onLoad={(e) => {
                const img = e.currentTarget;
                // 没写宽高的 svg 自然尺寸可能是 0：按浏览器默认 300×150 兜底
                setNatural({ w: img.naturalWidth || 300, h: img.naturalHeight || 150 });
              }}
              onDoubleClick={(e) =>
                zoom === "fit" ? zoomTo(1, { x: e.clientX, y: e.clientY }) : setZoom("fit")
              }
              className="m-auto block max-w-none select-none"
              style={
                natural
                  ? { width: natural.w * scale, height: natural.h * scale }
                  : { maxWidth: "100%", maxHeight: "100%" }
              }
            />}
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(ImagePreview);
