import { useCallback, useEffect, useState } from "react";
import {
  headingsFromElement,
  MD_TOC_MIN,
  revealMdHeading,
  type MdHeading,
} from "../md-toc";

/** 工具栏内联「目录」下拉：标题数达标（≥3）时才展示，不遮挡正文首行。 */
export default function MdToc({
  bodyRef,
  watchKey,
}: {
  bodyRef: { current: HTMLElement | null };
  watchKey?: unknown;
}) {
  const [headings, setHeadings] = useState<MdHeading[]>([]);
  const [open, setOpen] = useState(false);

  const scan = useCallback(() => {
    const host = bodyRef.current;
    if (!host) {
      setHeadings([]);
      return;
    }
    setHeadings(headingsFromElement(host));
  }, [bodyRef]);

  useEffect(() => {
    scan();
    const host = bodyRef.current;
    if (!host) return;
    const obs = new MutationObserver(scan);
    obs.observe(host, { childList: true, subtree: true, characterData: true });
    return () => obs.disconnect();
  }, [scan, bodyRef, watchKey]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointer = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest("[data-md-toc]")) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  if (headings.length < MD_TOC_MIN) return null;

  return (
    <div data-md-toc="" className="relative inline-flex shrink-0 items-center">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex h-6 shrink-0 items-center rounded-md px-2 text-xs transition-colors ${
          open
            ? "bg-seg-sel font-medium text-l1"
            : "text-l3 hover:bg-hover hover:text-l1"
        }`}
        title="章节目录"
      >
        目录
      </button>
      {open && (
        <div className="ccode-float-surface absolute right-0 top-7 z-30 max-h-80 w-64 overflow-y-auto py-1">
          {headings.map((h) => (
            <button
              key={h.id}
              type="button"
              onClick={() => {
                const host = bodyRef.current;
                if (!host) return;
                revealMdHeading(host, h.id);
                setOpen(false);
              }}
              className="block w-full truncate px-2.5 py-1 text-left text-xs text-l2 hover:bg-hover hover:text-l1"
              style={{ paddingLeft: 10 + (h.level - 1) * 10 }}
              title={h.text}
            >
              {h.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
