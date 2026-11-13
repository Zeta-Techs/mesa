import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { imageFitScale } from "../image-view";
import { pdfWheelShouldZoom, pdfWheelZoomFactor } from "../reader";

export default function ImageVersionCompare({ before, after }: { before: string; after: string }) {
  const [urls, setUrls] = useState<string[]>([]);
  const [sizes, setSizes] = useState<Array<{ w: number; h: number } | null>>([null, null]);
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [boxes, setBoxes] = useState([{ w: 0, h: 0 }, { w: 0, h: 0 }]);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const panes = useRef<Array<HTMLDivElement | null>>([]);
  const position = useRef({ x: 0, y: 0 });
  const pendingScroll = useRef(new Map<HTMLDivElement, { left: number; top: number }>());
  const drag = useRef<{ x: number; y: number; left: number; top: number; index: number } | null>(null);
  useEffect(() => {
    let stale = false;
    setUrls([]); setSizes([null, null]); setZoom("fit"); setError(null); position.current = { x: 0, y: 0 }; pendingScroll.current.clear();
    Promise.all([before, after].map((path) => invoke<{ mime: string; data: string }>("read_image_bytes", { path, cwdHint: path.replace(/[/\\][^/\\]+$/, "") })))
      .then((images) => { if (!stale) setUrls(images.map((image) => `data:${image.mime};base64,${image.data}`)); })
      .catch((reason) => { if (!stale) setError(String(reason)); });
    return () => { stale = true; };
  }, [before, after, retry]);
  useEffect(() => {
    const measure = () => setBoxes(panes.current.map((pane) => ({ w: pane?.clientWidth ?? 0, h: pane?.clientHeight ?? 0 })));
    const observer = new ResizeObserver(measure);
    for (const pane of panes.current) if (pane) observer.observe(pane);
    measure(); return () => observer.disconnect();
  }, [urls]);
  const scale = zoom === "fit" ? Math.min(...sizes.map((size, index) => size ? imageFitScale(size, boxes[index] ?? { w: 0, h: 0 }, 24) : 1)) : zoom;
  useLayoutEffect(() => {
    for (const pane of panes.current) {
      if (!pane) continue;
      const left = position.current.x * Math.max(0, pane.scrollWidth - pane.clientWidth);
      const top = position.current.y * Math.max(0, pane.scrollHeight - pane.clientHeight);
      pendingScroll.current.set(pane, { left, top });
      pane.scrollLeft = left; pane.scrollTop = top;
    }
  }, [scale]);
  function zoomTo(next: "fit" | number) { setZoom(next === "fit" ? next : Math.max(0.05, Math.min(8, next))); }
  // React 的 onWheel 是被动监听，preventDefault 拦不住触控板捏合时整页跟着缩放 / 滚动，这里挂原生非被动监听
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      if (!pdfWheelShouldZoom(event)) return;
      const factor = pdfWheelZoomFactor(event.deltaY, event.deltaMode);
      if (!factor) return;
      event.preventDefault();
      setZoom(Math.max(0.05, Math.min(8, scaleRef.current * factor)));
    };
    const attached = panes.current.filter((pane): pane is HTMLDivElement => pane !== null);
    for (const pane of attached) pane.addEventListener("wheel", onWheel, { passive: false });
    return () => { for (const pane of attached) pane.removeEventListener("wheel", onWheel); };
  }, [urls]);
  function syncScroll(source: HTMLDivElement) {
    const pending = pendingScroll.current.get(source);
    pendingScroll.current.delete(source);
    if (pending && Math.abs(source.scrollLeft - pending.left) < 1 && Math.abs(source.scrollTop - pending.top) < 1) return;
    const x = source.scrollLeft / Math.max(1, source.scrollWidth - source.clientWidth);
    const y = source.scrollTop / Math.max(1, source.scrollHeight - source.clientHeight);
    if (Math.abs(x - position.current.x) < 0.0001 && Math.abs(y - position.current.y) < 0.0001) return;
    position.current = { x, y };
    for (const pane of panes.current) {
      if (!pane || pane === source) continue;
      const left = x * Math.max(0, pane.scrollWidth - pane.clientWidth);
      const top = y * Math.max(0, pane.scrollHeight - pane.clientHeight);
      pendingScroll.current.set(pane, { left, top });
      pane.scrollLeft = left; pane.scrollTop = top;
    }
  }
  if (error) return <div className="px-2 text-xs text-err-text">{error}<button type="button" className="ml-2 text-l3 hover:text-l1" onClick={() => setRetry((current) => current + 1)}>重试</button></div>;
  return <div className="flex min-h-0 flex-1 flex-col gap-1">
    <div className="flex shrink-0 flex-wrap items-center gap-2 px-2 text-xs text-l3">
      <span>同步缩放与移动</span>
      <button type="button" className="h-7 rounded-sm px-1.5 hover:bg-hover" onClick={() => zoomTo("fit")}>适应</button>
      <button type="button" className="h-7 rounded-sm px-1.5 hover:bg-hover" onClick={() => zoomTo(1)}>100%</button>
      <button type="button" aria-label="两图缩小" className="h-7 rounded-sm px-1.5 hover:bg-hover" onClick={() => zoomTo(scale / 1.25)}>−</button>
      <span className="tabular-nums">{Math.round(scale * 100)}%</span>
      <button type="button" aria-label="两图放大" className="h-7 rounded-sm px-1.5 hover:bg-hover" onClick={() => zoomTo(scale * 1.25)}>+</button>
    </div>
    <div className="grid min-h-0 flex-1 grid-cols-2 gap-2">
      {urls.length === 0 ? <p className="text-xs text-l3">读取图片…</p> : urls.map((url, index) => <div key={index} ref={(pane) => { panes.current[index] = pane; }} aria-label={index === 0 ? "左图" : "右图"} className="min-h-0 overflow-auto" style={{ backgroundImage: "repeating-conic-gradient(var(--color-inset) 0% 25%, transparent 0% 50%)", backgroundSize: "16px 16px" }}
        onScroll={(event) => syncScroll(event.currentTarget)}
        onPointerDown={(event) => { if (event.button !== 0 || event.target === event.currentTarget) return; drag.current = { index, x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={(event) => { const active = drag.current; if (!active || active.index !== index) return; event.currentTarget.scrollLeft = active.left - event.clientX + active.x; event.currentTarget.scrollTop = active.top - event.clientY + active.y; syncScroll(event.currentTarget); }}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
        <div className="flex min-h-full min-w-full w-max p-3"><img src={url} alt={index === 0 ? "旧版图片" : "对照图片"} draggable={false} className="m-auto block max-w-none select-none" onLoad={(event) => { const image = event.currentTarget; setSizes((current) => current.map((size, at) => at === index ? { w: image.naturalWidth || 300, h: image.naturalHeight || 150 } : size)); }} style={sizes[index] ? { width: sizes[index]!.w * scale, height: sizes[index]!.h * scale } : { maxWidth: "100%" }} /></div>
      </div>)}
    </div>
  </div>;
}
