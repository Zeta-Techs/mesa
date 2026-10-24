import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { ArrowUpRight, Crop, EyeOff, PenLine, Ratio, SquareDashedMousePointer, Trash2, Undo2, WandSparkles, X } from "lucide-react";
import {
  HALO_COLOR,
  MARK_COLOR,
  MASK_COLOR,
  addMark,
  arrowHead,
  badgeGeometry,
  clampToImage,
  cropOf,
  markLineWidth,
  markTooSmall,
  rectFromPoints,
  type Mark,
  type MarkTool,
  type Markup,
} from "../image-markup";
import { IS_MAC } from "../hotkeys";

const TOOLS: { id: MarkTool; label: string; icon: ReactNode; hint: string }[] = [
  {
    id: "box",
    label: "意见框",
    icon: <SquareDashedMousePointer size={14} strokeWidth={1.8} aria-hidden="true" />,
    hint: "框出要改的地方，编号会接在下面的消息里，接着写意见",
  },
  {
    id: "pen",
    label: "画笔",
    icon: <PenLine size={14} strokeWidth={1.8} aria-hidden="true" />,
    hint: "按住拖动随手画",
  },
  {
    id: "arrow",
    label: "箭头",
    icon: <ArrowUpRight size={14} strokeWidth={1.8} aria-hidden="true" />,
    hint: "从起点拖到要指的地方",
  },
  {
    id: "mask",
    label: "打码",
    icon: <EyeOff size={14} strokeWidth={1.8} aria-hidden="true" />,
    hint: "框住要遮掉的内容（密钥、姓名），发出去的图上是实心色块",
  },
  {
    id: "crop",
    label: "裁剪",
    icon: <Crop size={14} strokeWidth={1.8} aria-hidden="true" />,
    hint: "框出要留下的部分，发出去只带这一块",
  },
];

const IDLE_HINT = "选一样工具在图上标；消息照常在下面写，标好的图随消息发出，原图不动";
/** 点 AI 回复里的图进来（接着改这张图）：说清发出去会怎样 */
const EDIT_HINT = "在下面写怎么改，要改的地方可以先框出来；发出去由 AI 用出图模型在原图上改，原图不动";

/** 改图时的常用说法：点一下写进输入框，照常可改（不直接发） */
const EDIT_QUICK: { label: string; text: string; icon: ReactNode }[] = [
  {
    label: "移除背景",
    text: "去掉背景，只留主体（透明或纯白底），其余不变",
    icon: <WandSparkles size={14} strokeWidth={1.8} aria-hidden="true" />,
  },
  {
    label: "调整画幅",
    text: "改成 16:9 横图，主体和风格不变，两边自然补全",
    icon: <Ratio size={14} strokeWidth={1.8} aria-hidden="true" />,
  },
];

/** 标注画成 SVG（放在 viewBox = 原图尺寸的 svg 里）：与导出的 paintMarkup 同一套几何 */
export function MarkupLayer({ markup, draft = null }: { markup: Markup; draft?: Mark | null }) {
  const { width: W, height: H } = markup;
  const lw = markLineWidth(W, H);
  const marks = draft ? [...markup.marks, draft] : markup.marks;
  const strokeOf = (m: Mark, color: string, width: number, key: string) => {
    const common = {
      fill: "none",
      stroke: color,
      strokeWidth: width,
      strokeLinejoin: "round" as const,
      strokeLinecap: "round" as const,
    };
    if (m.kind === "box") return <rect key={key} {...common} x={m.x} y={m.y} width={m.w} height={m.h} />;
    if (m.kind === "pen") {
      const pts: string[] = [];
      for (let i = 0; i + 1 < m.points.length; i += 2) pts.push(`${m.points[i]},${m.points[i + 1]}`);
      return <polyline key={key} {...common} points={pts.join(" ")} />;
    }
    if (m.kind === "arrow") {
      const head = arrowHead(m.x1, m.y1, m.x2, m.y2, lw * 4)
        .map(([x, y]) => `${x},${y}`)
        .join(" ");
      return (
        <g key={key}>
          <line {...common} x1={m.x1} y1={m.y1} x2={m.x2} y2={m.y2} />
          <polyline {...common} points={head} />
        </g>
      );
    }
    return null;
  };
  const crop = cropOf(marks);
  return (
    <>
      {marks.map((m, i) =>
        m.kind === "mask" ? <rect key={`m${i}`} x={m.x} y={m.y} width={m.w} height={m.h} fill={MASK_COLOR} /> : null,
      )}
      {marks.map((m, i) => strokeOf(m, HALO_COLOR, lw * 2, `h${i}`))}
      {marks.map((m, i) => strokeOf(m, MARK_COLOR, lw, `s${i}`))}
      {marks.map((m, i) => {
        if (m.kind !== "box") return null;
        const { cx, cy, r, fontSize } = badgeGeometry(m, lw, W, H);
        return (
          <g key={`b${i}`}>
            <circle cx={cx} cy={cy} r={r} fill={MARK_COLOR} stroke="#ffffff" strokeWidth={Math.max(1.5, lw * 0.6)} />
            <text
              x={cx}
              y={cy}
              fill="#ffffff"
              fontSize={fontSize}
              fontWeight={600}
              textAnchor="middle"
              dominantBaseline="central"
            >
              {m.n}
            </text>
          </g>
        );
      })}
      {crop && (
        <>
          <path
            d={`M0 0H${W}V${H}H0Z M${crop.x} ${crop.y}h${crop.w}v${crop.h}h${-crop.w}Z`}
            fill="rgba(0,0,0,0.55)"
            fillRule="evenodd"
          />
          <rect
            x={crop.x}
            y={crop.y}
            width={crop.w}
            height={crop.h}
            fill="none"
            stroke="#ffffff"
            strokeWidth={lw}
            strokeDasharray={`${lw * 3} ${lw * 2}`}
          />
        </>
      )}
    </>
  );
}

/**
 * 输入框上方的看图标注台（2026-10-23 用户：点图只能放大、看不着编辑消息）：
 * 盖住对话区、不挡输入框——人看着图在下面照常写消息。工具可选：意见框（编号接进消息）/ 画笔 / 箭头 / 打码 / 裁剪。
 * 标注只存原图坐标（markup），发送时由输入框按 paintMarkup 生成新图，原图不动。
 */
export default function ChatImageStage({
  name,
  url,
  markup,
  nextNumber,
  height,
  onChange,
  onBoxAdded,
  onClose,
  onQuickText,
}: {
  name: string;
  url: string;
  markup: Markup | null;
  /** 下一个意见框编号（整条消息连着编，输入框给） */
  nextNumber: number;
  /** 输入框上沿到对话区顶的高度 */
  height: number;
  onChange: (markup: Markup) => void;
  /** 画好一个意见框：输入框在消息末尾接上它的圈码 */
  onBoxAdded: (n: number) => void;
  onClose: () => void;
  /** 给了 = 这张是从 AI 回复里点进来接着改的：提示换成改图说明、工具条后面多「移除背景 / 调整画幅」，点了把说法写进输入框 */
  onQuickText?: (text: string) => void;
}) {
  const [tool, setTool] = useState<MarkTool | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(
    markup ? { w: markup.width, h: markup.height } : null,
  );
  const [area, setArea] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const areaRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const draftRef = useRef<Mark | null>(null);
  const [draft, setDraftState] = useState<Mark | null>(null);
  const setDraft = (m: Mark | null) => {
    draftRef.current = m;
    setDraftState(m);
  };

  // 换图由调用方按图换 key 重挂（不在 effect 里重置尺寸：缓存里的图 load 可能先于 effect，被清掉就再也等不到 load）
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const measure = () => setArea({ w: el.clientWidth - 32, h: el.clientHeight - 16 });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const current: Markup | null = natural
    ? markup ?? { width: natural.w, height: natural.h, marks: [] }
    : null;
  const lw = current ? markLineWidth(current.width, current.height) : 2;
  // 适配显示区，最多放大到 2 倍（小截图也好下笔）
  const scale = natural && area.w > 0 && area.h > 0 ? Math.min(area.w / natural.w, area.h / natural.h, 2) : 0;
  const shown = natural && scale > 0 ? { w: natural.w * scale, h: natural.h * scale } : null;

  function toImage(e: ReactPointerEvent) {
    const svg = svgRef.current;
    if (!svg || !current) return null;
    const r = svg.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return clampToImage(
      { x: ((e.clientX - r.left) / r.width) * current.width, y: ((e.clientY - r.top) / r.height) * current.height },
      current.width,
      current.height,
    );
  }

  function onPointerDown(e: ReactPointerEvent<SVGSVGElement>) {
    if (!tool || e.button !== 0) return;
    const p = toImage(e);
    if (!p) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // 指针已不在（合成事件 / 刚抬起）：不捕获也能画，只是拖出图外会断
    }
    startRef.current = p;
    const at = { x: p.x, y: p.y, w: 0, h: 0 };
    setDraft(
      tool === "box"
        ? { kind: "box", n: nextNumber, ...at }
        : tool === "pen"
          ? { kind: "pen", points: [p.x, p.y] }
          : tool === "arrow"
            ? { kind: "arrow", x1: p.x, y1: p.y, x2: p.x, y2: p.y }
            : { kind: tool, ...at },
    );
  }

  function onPointerMove(e: ReactPointerEvent<SVGSVGElement>) {
    const start = startRef.current;
    const d = draftRef.current;
    if (!start || !d) return;
    const p = toImage(e);
    if (!p) return;
    if (d.kind === "pen") {
      const n = d.points.length;
      if (Math.hypot(p.x - d.points[n - 2], p.y - d.points[n - 1]) < lw * 0.75) return;
      setDraft({ ...d, points: [...d.points, p.x, p.y] });
    } else if (d.kind === "arrow") {
      setDraft({ ...d, x2: p.x, y2: p.y });
    } else {
      setDraft({ ...d, ...rectFromPoints(start, p) });
    }
  }

  function onPointerUp() {
    const d = draftRef.current;
    startRef.current = null;
    setDraft(null);
    if (!d || !current || markTooSmall(d, lw)) return;
    onChange({ ...current, marks: addMark(current.marks, d) });
    if (d.kind === "box") onBoxAdded(d.n);
  }

  function undo() {
    if (!current || current.marks.length === 0) return;
    onChange({ ...current, marks: current.marks.slice(0, -1) });
  }

  function onKeyDown(e: ReactKeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undo();
    }
  }

  const hint = tool ? TOOLS.find((t) => t.id === tool)?.hint : onQuickText ? EDIT_HINT : IDLE_HINT;
  const hasMarks = (current?.marks.length ?? 0) > 0;
  const toolBtn = (on: boolean) =>
    `flex h-7 items-center gap-1 rounded-full px-2.5 text-xs transition-colors ${
      on ? "bg-seg-sel text-l1" : "text-l3 hover:text-l1"
    }`;

  return (
    <div
      role="region"
      aria-label="看图与标注"
      className="ccode-fade absolute inset-x-0 bottom-full z-10 flex flex-col bg-canvas"
      style={{ height }}
      onKeyDown={onKeyDown}
    >
      <div className="flex shrink-0 items-center gap-2 px-4 pt-2.5 text-xs">
        <span className="max-w-[40%] shrink-0 truncate text-l2" title={name}>
          {name}
        </span>
        <span className="min-w-0 truncate text-l4">{hint}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="收起图片"
          title="收起图片（Esc）"
          className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-l3 transition-colors hover:bg-hover hover:text-l1"
        >
          <X size={15} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
      <div ref={areaRef} className="flex min-h-0 flex-1 items-center justify-center px-4 py-2">
        {!shown || !current ? (
          <img
            src={url}
            alt={name}
            draggable={false}
            className="max-h-full max-w-full rounded-md border border-hairline object-contain"
            ref={(img) => {
              // 已在缓存里解码好的图不一定再发 load
              if (img?.complete && img.naturalWidth && img.naturalHeight && !natural)
                setNatural({ w: img.naturalWidth, h: img.naturalHeight });
            }}
            onLoad={(e) => {
              const img = e.currentTarget;
              if (img.naturalWidth && img.naturalHeight) setNatural({ w: img.naturalWidth, h: img.naturalHeight });
            }}
          />
        ) : (
          <div className="relative shrink-0" style={{ width: shown.w, height: shown.h }}>
            <img
              src={url}
              alt={name}
              draggable={false}
              className="block h-full w-full select-none rounded-md border border-hairline"
            />
            <svg
              ref={svgRef}
              role="img"
              aria-label="标注"
              className="absolute inset-0 h-full w-full"
              viewBox={`0 0 ${current.width} ${current.height}`}
              preserveAspectRatio="none"
              style={{ cursor: tool ? "crosshair" : "default", touchAction: "none" }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => {
                startRef.current = null;
                setDraft(null);
              }}
            >
              <MarkupLayer markup={current} draft={draft} />
            </svg>
          </div>
        )}
      </div>
      <div className="flex shrink-0 justify-center px-4 pb-2.5">
        <div className="ccode-float-surface flex items-center gap-0.5 rounded-full border border-field px-1 py-1">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={tool === t.id}
              title={t.hint}
              onClick={() => setTool((cur) => (cur === t.id ? null : t.id))}
              className={toolBtn(tool === t.id)}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
          <span aria-hidden="true" className="mx-1 h-4 w-px bg-hairline" />
          <button
            type="button"
            disabled={!hasMarks}
            onClick={undo}
            title={`撤销上一笔（${IS_MAC ? "⌘Z" : "Ctrl+Z"}）`}
            className={`${toolBtn(false)} disabled:cursor-not-allowed disabled:opacity-40`}
          >
            <Undo2 size={14} strokeWidth={1.8} aria-hidden="true" />
            撤销
          </button>
          <button
            type="button"
            disabled={!hasMarks}
            onClick={() => current && onChange({ ...current, marks: [] })}
            title="清掉这张图上的全部标注（消息里写的字不动）"
            className={`${toolBtn(false)} disabled:cursor-not-allowed disabled:opacity-40`}
          >
            <Trash2 size={14} strokeWidth={1.8} aria-hidden="true" />
            清空
          </button>
          {onQuickText && (
            <>
              <span aria-hidden="true" className="mx-1 h-4 w-px bg-hairline" />
              {EDIT_QUICK.map((q) => (
                <button
                  key={q.label}
                  type="button"
                  title={`在消息里写上「${q.text}」，可以再改`}
                  onClick={() => onQuickText(q.text)}
                  className={toolBtn(false)}
                >
                  {q.icon}
                  {q.label}
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
