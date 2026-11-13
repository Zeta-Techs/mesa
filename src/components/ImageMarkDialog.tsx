import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { saveClipboardImage } from "../clipboard-image";
import { imageAnnotationExcerpt, type ReviewAnnotate } from "../draft-review";
import { createImeLock } from "../ime-guard";
import {
  addMark,
  clampToImage,
  describeBoxes,
  exportMarkup,
  markLineWidth,
  markTooSmall,
  nextMarkNumber,
  rectFromPoints,
  type Mark,
  type Rect,
} from "../image-markup";

/**
 * 审阅里给一张图加意见：在图上拖出红框（可多个），写一句话，加入意见时把「带红框的图」存成一张图、
 * 路径随意见一起交给 AI（拼图拼错、子图错位这类问题，划字说不清）。不拖框 = 整张图有问题。
 * 标注只存在原图像素坐标里，导出沿用聊天图片标注同一套几何（image-markup.ts）。
 */
export default function ImageMarkDialog({
  url,
  name,
  fileName,
  onAnnotate,
  onClose,
}: {
  url: string;
  /** 图自己的名字（文件名或图注），写进意见行 */
  name: string;
  /** 这条意见属于哪份稿件 / 文件 */
  fileName: string;
  onAnnotate: ReviewAnnotate;
  onClose: () => void;
}) {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [drag, setDrag] = useState<Rect | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const imeRef = useRef(createImeLock());
  const [area, setArea] = useState({ w: 0, h: 0 });

  useEffect(() => {
    setNatural(null);
    setError(null);
  }, [url]);

  // 图随窗口大小等比铺满（窗口可拖右下角改大小）
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setArea({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setArea({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const shown = natural && area.w > 0 && area.h > 0
    ? (() => {
        const k = Math.min((area.w - 24) / natural.w, (area.h - 24) / natural.h, 2);
        return k > 0 ? { w: Math.round(natural.w * k), h: Math.round(natural.h * k) } : null;
      })()
    : null;

  useEffect(() => {
    const ime = imeRef.current;
    const onCompStart = () => ime.onCompositionStart();
    const onCompEnd = () => ime.onCompositionEnd();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || ime.blocksKey(event)) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
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
  }, [onClose]);

  /** 指针位置 → 原图像素坐标 */
  function toImagePoint(event: { clientX: number; clientY: number }) {
    const box = boxRef.current;
    if (!box || !natural) return null;
    const r = box.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return clampToImage(
      {
        x: ((event.clientX - r.left) / r.width) * natural.w,
        y: ((event.clientY - r.top) / r.height) * natural.h,
      },
      natural.w,
      natural.h,
    );
  }

  function startDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !natural || busy) return;
    const start = toImagePoint(event);
    if (!start) return;
    event.preventDefault();
    const lw = markLineWidth(natural.w, natural.h);
    const onMove = (ev: PointerEvent) => {
      const p = toImagePoint(ev);
      if (p) setDrag(rectFromPoints(start, p));
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setDrag(null);
      const p = toImagePoint(ev);
      if (!p) return;
      const rect = rectFromPoints(start, p);
      setMarks((current) => {
        const mark: Mark = {
          kind: "box",
          n: nextMarkNumber([{ width: natural.w, height: natural.h, marks: current }]),
          ...rect,
        };
        return markTooSmall(mark, lw) ? current : addMark(current, mark);
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  async function submit() {
    if (!natural || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { bytes, ext } = await exportMarkup(url, name, {
        width: natural.w,
        height: natural.h,
        marks,
      });
      const path = await saveClipboardImage(bytes, ext);
      const boxes = marks.filter((m) => m.kind === "box").length;
      const excerpt = boxes
        ? `${imageAnnotationExcerpt(name)}（框了 ${boxes} 处）`
        : imageAnnotationExcerpt(name);
      const where = describeBoxes(marks, natural.w, natural.h);
      const note = where ? `${comment.trim()} 〔${where}〕`.trim() : comment;
      const err = onAnnotate(excerpt, fileName, note, path);
      if (err) setError(err);
      else onClose();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  const lw = natural ? markLineWidth(natural.w, natural.h) : 2;
  // 这个弹层只画框：按 box 变体窄化，pen / mask 那些没有 x/y/n 的不进渲染
  const drawnBoxes = marks.filter((m): m is { kind: "box"; n: number } & Rect => m.kind === "box");
  const boxes = drag ? [...drawnBoxes, { kind: "box" as const, n: 0, ...drag }] : drawnBoxes;

  // 挂到 body：评审面板带裁切与定位上下文，弹层留在里面 fixed 只铺满面板、左半张图被裁掉（2026-11-13 用户实测）
  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/60"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {/* 默认居中取个合适的大小，右下角可拖动改大小（左上角固定，拖起来跟手） */}
      <div
        className="ccode-float-surface absolute flex flex-col overflow-hidden rounded-md"
        style={{
          left: "20vw",
          top: "16vh",
          width: "60vw",
          height: "68vh",
          minWidth: 480,
          minHeight: 360,
          maxWidth: "80vw",
          maxHeight: "84vh",
          resize: "both",
        }}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-2 text-xs">
          <span className="min-w-0 flex-1 truncate text-l2" title={name}>
            {name}
          </span>
          <span className="shrink-0 text-l4">在图上拖出红框指出问题位置；不框 = 整张图；右下角可拖动改大小</span>
          <button
            type="button"
            disabled={marks.length === 0 || busy}
            onClick={() => setMarks((current) => current.slice(0, -1))}
            className="shrink-0 rounded-sm px-1.5 py-0.5 text-l3 hover:bg-hover hover:text-l1 disabled:opacity-40"
          >
            撤销一个框
          </button>
        </div>
        <div
          ref={areaRef}
          className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-inset"
        >
          <div
            ref={boxRef}
            className="relative shrink-0 cursor-crosshair select-none"
            style={shown ? { width: shown.w, height: shown.h } : { visibility: "hidden", width: 1, height: 1 }}
            onPointerDown={startDrag}
          >
            <img
              src={url}
              alt={name}
              draggable={false}
              onLoad={(event) => {
                const img = event.currentTarget;
                setError(null);
                setNatural({
                  w: img.naturalWidth > 0 ? img.naturalWidth : 800,
                  h: img.naturalHeight > 0 ? img.naturalHeight : 600,
                });
              }}
              onError={() => {
                setNatural(null);
                setError("图片加载失败，无法标注");
              }}
              className="block h-full w-full"
            />
            {natural &&
              boxes.map((m, index) => (
                <div
                  key={index}
                  className="pointer-events-none absolute border-2 border-[#ff3b30] bg-[#ff3b30]/10"
                  style={{
                    left: `${(m.x / natural.w) * 100}%`,
                    top: `${(m.y / natural.h) * 100}%`,
                    width: `${(m.w / natural.w) * 100}%`,
                    height: `${(m.h / natural.h) * 100}%`,
                    borderWidth: Math.max(2, lw / 2),
                  }}
                >
                  {m.n > 0 && (
                    <span className="absolute -left-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-[#ff3b30] text-micro font-semibold text-white">
                      {m.n}
                    </span>
                  )}
                </div>
              ))}
          </div>
        </div>
        <form
          className="shrink-0 border-t border-hairline px-3 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            const bySubmitter = Boolean((event.nativeEvent as SubmitEvent | undefined)?.submitter);
            if (!bySubmitter && imeRef.current.locked) return;
            void submit();
          }}
        >
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              onCompositionStart={imeRef.current.onCompositionStart}
              onCompositionEnd={imeRef.current.onCompositionEnd}
              onKeyDown={(event) => {
                if (!imeRef.current.blocksKey(event)) return;
                if (event.key === "Escape") event.stopPropagation();
                if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                  event.preventDefault();
                }
              }}
              placeholder="哪里不对，要怎么改（多个框可以写 1 … 2 …）"
              className="min-w-0 flex-1 rounded-sm border border-field bg-canvas px-2 py-1 text-xs text-l2 outline-none placeholder:text-l4 focus:border-l4"
            />
            <button
              type="submit"
              disabled={!natural || busy}
              className="shrink-0 rounded-sm border border-cta-bd bg-cta px-2 py-1 text-xs text-cta-text hover:brightness-110 disabled:opacity-60"
            >
              {busy ? "处理中…" : "加入意见"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-sm px-2 py-1 text-xs text-l3 hover:bg-hover hover:text-l1"
            >
              取消
            </button>
          </div>
          {error && <p className="mt-1 text-micro text-danger">{error}</p>}
        </form>
      </div>
    </div>,
    document.body,
  );
}
