import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { pdfWheelShouldZoom, pdfWheelZoomFactor } from "../reader";
import PreviewErrorState from "./PreviewErrorState";
import { useFileVersion } from "../file-watch";
import { formatBytes, imageFitScale } from "../image-view";

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
}: {
  path: string;
  cwdHint: string | null;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [bytes, setBytes] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  /** "fit" = 跟着框大小走；数字 = 固定倍率 */
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 缩放锚点：缩放前指针下的图片坐标（图片像素）与指针在框内的位置，布局后据此回正滚动 */
  const anchorRef = useRef<{ ix: number; iy: number; px: number; py: number } | null>(null);
  const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // 磁盘上换了一版（重新出图）：换图，缩放与滚动不动
  const fileVersion = useFileVersion(path);

  useEffect(() => {
    setUrl(null);
    setNatural(null);
    setZoom("fit");
  }, [path, cwdHint]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const dto = await invoke<{ mime: string; data: string }>(
          "read_image_bytes",
          { path, cwdHint },
        );
        if (cancelled) return;
        setBytes(Math.floor((dto.data.length * 3) / 4));
        setUrl(`data:${dto.mime};base64,${dto.data}`);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, cwdHint, retry, fileVersion]);

  // 框的大小（适应窗口要用；分栏拖动、开窗口都会变）
  useEffect(() => {
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 bg-strip px-3 py-1.5 text-xs">
        <span className="truncate text-l3" title={path}>
          {basename(path)}
        </span>
        {natural && (
          <span className="shrink-0 tabular-nums text-l4">
            {natural.w} × {natural.h}
            {bytes ? ` · ${formatBytes(bytes)}` : ""}
          </span>
        )}
        {url && (
          <span className="ml-auto flex shrink-0 items-center gap-1">
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
          {/* min-w/h-full + w-max + m-auto：比框小时居中，比框大时从左上角铺开、四边都滚得到 */}
          <div className="flex min-h-full min-w-full w-max p-3">
            <img
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
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(ImagePreview);
