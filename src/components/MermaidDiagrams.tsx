import { useEffect, useRef, useState } from "react";
import { sanitizeMermaidSvg } from "../mermaid-sanitize";
import { isLightTheme } from "../themes";
import { useAppStore } from "../store";

type MermaidApi = {
  initialize: (opts: Record<string, unknown>) => void;
  render: (id: string, code: string) => Promise<{ svg: string }>;
};

let mermaidPromise: Promise<MermaidApi> | null = null;
let mermaidSeq = 0;

function loadMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= import("mermaid").then((mod) => {
    const mermaid = (mod.default ?? mod) as MermaidApi;
    return mermaid;
  });
  return mermaidPromise;
}

function sourceOf(pre: HTMLElement): string {
  return (pre.querySelector("code")?.textContent ?? pre.textContent ?? "").trim();
}

async function renderOne(
  mermaid: MermaidApi,
  pre: HTMLElement,
  light: boolean,
): Promise<void> {
  const code = sourceOf(pre);
  const wrap = document.createElement("div");
  wrap.className = "md-mermaid";
  wrap.setAttribute("data-mermaid-diagram", "1");
  if (!code) {
    wrap.innerHTML = `<pre class="md-mermaid-fallback">${pre.innerHTML}</pre>`;
    pre.replaceWith(wrap);
    return;
  }
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    theme: light ? "neutral" : "dark",
  });
  try {
    const id = `md-mermaid-${++mermaidSeq}`;
    const { svg } = await mermaid.render(id, code);
    const clean = sanitizeMermaidSvg(svg, document);
    if (!clean) throw new Error("清洗拒绝");
    wrap.innerHTML = clean;
    wrap.title = "点击放大";
  } catch (e) {
    wrap.innerHTML = "";
    const bar = document.createElement("p");
    bar.className = "md-mermaid-error";
    bar.textContent = `图无法渲染：${String(e)}`;
    wrap.append(bar, pre.cloneNode(true));
  }
  pre.replaceWith(wrap);
}

function MermaidLightbox({
  svg,
  onClose,
}: {
  svg: string;
  onClose: () => void;
}) {
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(
    null,
  );

  useEffect(() => {
    // 捕获阶段 + preventDefault：大图开着时 ⌘= / ⌘- 缩的是图，不再连带全局的界面缩放（App.tsx 见 defaultPrevented 让路）
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        setScale((s) => Math.min(6, s * 1.2));
      }
      if (e.key === "-") {
        e.preventDefault();
        setScale((s) => Math.max(0.25, s / 1.2));
      }
      if (e.key === "0") {
        setScale(1);
        setTx(0);
        setTy(0);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      data-mermaid-modal=""
      onClick={onClose}
    >
      <div
        className="relative max-h-[90vh] max-w-[90vw] overflow-hidden rounded-md border border-hairline bg-canvas"
        onClick={(e) => e.stopPropagation()}
        onWheel={(e) => {
          e.preventDefault();
          const factor = e.deltaY > 0 ? 1 / 1.1 : 1.1;
          setScale((s) => Math.min(6, Math.max(0.25, s * factor)));
        }}
        onMouseDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY, tx, ty };
        }}
        onMouseMove={(e) => {
          const d = drag.current;
          if (!d) return;
          setTx(d.tx + e.clientX - d.x);
          setTy(d.ty + e.clientY - d.y);
        }}
        onMouseUp={() => {
          drag.current = null;
        }}
        onMouseLeave={() => {
          drag.current = null;
        }}
      >
        <div className="flex h-8 items-center justify-end gap-1 border-b border-hairline bg-strip px-2 text-xs">
          <button type="button" className="px-1.5 text-l3 hover:text-l1" onClick={() => setScale((s) => Math.max(0.25, s / 1.2))}>−</button>
          <button type="button" className="px-1.5 text-l3 hover:text-l1" onClick={() => setScale((s) => Math.min(6, s * 1.2))}>+</button>
          <button type="button" className="px-1.5 text-l3 hover:text-l1" onClick={() => { setScale(1); setTx(0); setTy(0); }}>⟳</button>
          <button type="button" className="px-1.5 text-l3 hover:text-l1" onClick={onClose}>✕</button>
        </div>
        <div
          className="max-h-[80vh] max-w-[90vw] overflow-hidden p-4"
          dangerouslySetInnerHTML={{ __html: svg }}
          style={{
            transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
            transformOrigin: "center center",
          }}
        />
      </div>
    </div>
  );
}

/** 扫描 `[data-md-mermaid]` 围栏，换成清洗后的 SVG。无围栏时不加载 mermaid。 */
export default function MermaidDiagrams({
  hostRef,
  html,
}: {
  hostRef: { current: HTMLElement | null };
  html: string;
}) {
  const themeId = useAppStore((s) => s.settings?.theme);
  const light = isLightTheme(themeId);
  const [modal, setModal] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const fences = [...host.querySelectorAll<HTMLElement>("[data-md-mermaid]")];
    if (fences.length === 0) return;
    let cancelled = false;
    void loadMermaid().then(async (mermaid) => {
      if (cancelled) return;
      for (const pre of fences) {
        if (cancelled) return;
        if (!pre.isConnected) continue;
        await renderOne(mermaid, pre, light);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [hostRef, html, light]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      const diagram = t.closest("[data-mermaid-diagram]");
      const svg = diagram?.querySelector("svg");
      if (!svg) return;
      setModal(svg.outerHTML);
    };
    host.addEventListener("click", onClick);
    return () => host.removeEventListener("click", onClick);
  }, [hostRef, html]);

  if (!modal) return null;
  return <MermaidLightbox svg={modal} onClose={() => setModal(null)} />;
}
