import { useCallback, useEffect, useState } from "react";
import {
  headingsFromElement,
  MD_TOC_MIN,
  revealMdHeading,
  type MdHeading,
} from "../md-toc";

/** 零高度 sticky 条：自身 ref 取 parent 当滚动容器（子 layout 时父 ref 还没挂）。 */
export default function MdToc({
  bodyRef,
}: {
  bodyRef: { current: HTMLElement | null };
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
  }, [scan, bodyRef]);

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
    <div
      data-md-toc=""
      className="pointer-events-none sticky top-0 z-20 h-7"
    >
      <div className="pointer-events-auto absolute right-2 top-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded-sm border border-hairline bg-strip px-2 py-0.5 text-micro text-l3 hover:bg-hover hover:text-l1"
          title="目录"
        >
          目录
        </button>
        {open && (
          <div className="ccode-float-surface absolute right-0 top-7 max-h-72 w-56 overflow-y-auto py-1">
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
                className="block w-full truncate px-2 py-1 text-left text-xs text-l2 hover:bg-hover hover:text-l1"
                style={{ paddingLeft: 8 + (h.level - 1) * 10 }}
                title={h.text}
              >
                {h.text}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
