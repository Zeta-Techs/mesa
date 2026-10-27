import type { MouseEvent, ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, CircleCheck, CircleX, Info, TriangleAlert } from "lucide-react";
import { splitNoticeText } from "../notice-text";
import { HoverTip, useHoverTip } from "./HoverTip";
import { nextTabIndex, tabNavDelta, tabStopIndex } from "../tab-keys";
import {
  COLLAPSE_MS,
  nextCollapsePhase,
  prefersReducedMotion,
  settledCollapsePhase,
  useExitRender,
  type CollapsePhase,
} from "../exit-animation";

const WIDTHS = {
  narrow: "max-w-2xl",
  standard: "max-w-4xl",
  /** 可选中宽外壳（约 1080px）。当前无使用方，保留给以后要限宽的阅读页。 */
  settings: "max-w-[1080px]",
  /** 资源管理五页（连接/技能/MCP/用量/设置）与工作台居中档（2026-10-13 拍板，工作台 2026-10-27 加入）：留白以热力图
   *  16px 格顶格 + 统计栏右挂为度，页内响应布局不变，只封外壳顶。 */
  wide: "max-w-[1440px]",
  /** 连续工作区页面（项目页）：使用主区全部可用宽度，内容自身维持固定密度。工作台 2026-10-27 起改用 wide。 */
  fluid: "max-w-none",
} as const;

export function PageFrame({
  children,
  className = "",
  width = "wide",
  surface = "canvas",
  fill = false,
}: {
  children: ReactNode;
  className?: string;
  width?: keyof typeof WIDTHS;
  /** workspace = 项目页工作面，与项目栏同底（rail2），对象统一用 ccode-well 浮起。 */
  surface?: "canvas" | "workspace";
  /** 占满父级高度。页头留在外面，滚动交给内部区域。 */
  fill?: boolean;
}) {
  return (
    <div
      data-surface={surface}
      className={`ccode-page-frame px-6 pt-1 ${
        fill ? "flex min-h-0 flex-1 flex-col overflow-hidden" : "min-h-full pb-6"
      } ${surface === "workspace" ? "bg-rail2" : "bg-canvas"}`}
    >
      <div
        className={`ccode-page-content mx-auto w-full ${WIDTHS[width]} ${
          fill ? "flex min-h-0 flex-1 flex-col" : ""
        } ${className}`}
      >
        {children}
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  meta,
  actions,
  leading,
}: {
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
  /** 页面级标题前的轻量入口（例如工作区页收起后的项目列表恢复按钮）。 */
  leading?: ReactNode;
}) {
  // 内容滚到页头下面时，页头底边出一根细线：玻璃页头只靠磨砂，滚动后卡片顶像被切掉一截（2026-10-23 审查）
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const header = ref.current;
    let scroller: HTMLElement | null = header?.parentElement ?? null;
    while (scroller) {
      const oy = getComputedStyle(scroller).overflowY;
      if (oy === "auto" || oy === "scroll") break;
      scroller = scroller.parentElement;
    }
    if (!header || !scroller) return;
    const target = scroller;
    const sync = () => header.toggleAttribute("data-stuck", target.scrollTop > 0);
    sync();
    target.addEventListener("scroll", sync, { passive: true });
    return () => target.removeEventListener("scroll", sync);
  }, []);
  return (
    <header
      ref={ref}
      className="ccode-page-header sticky top-0 z-20 mb-4 flex h-12 items-center justify-between gap-4"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        {leading}
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h1 className="shrink-0 text-2xl font-semibold tracking-tight text-l1">
            {title}
          </h1>
          {meta && <span className="truncate text-micro text-l4">{meta}</span>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </header>
  );
}

export const primaryActionClass =
  "ccode-action-primary inline-flex h-8 items-center justify-center rounded-lg border border-cta-bd bg-cta px-3 text-xs font-medium text-cta-text transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50";

/** 危险主按钮（删除/清除这类不可逆动作的确认钮）：实心错误色 + 画布色字，深浅主题都够对比。
 *  替代旧「bg-err + text-err-text」淡粉小块——那是状态 pill 的配方，放在按钮上读不出「这下点了收不回」。
 *  与之配对的取消钮用 secondaryActionClass，且焦点默认给取消（HIG：破坏性动作不做默认按钮）。 */
export const dangerActionClass =
  "ccode-action-danger inline-flex h-8 items-center justify-center rounded-lg bg-err-text px-3 text-xs font-medium text-canvas transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50";

export const secondaryActionClass =
  "ccode-action-secondary inline-flex h-8 items-center justify-center rounded-lg border border-field bg-strip px-3 text-xs text-l2 transition-colors hover:bg-inset hover:text-l1 disabled:cursor-not-allowed disabled:opacity-50";

/** 内容卡统一底色：由所在 PageFrame 画布派生，保留现有项目页公共类名 */
export const projectWellClass = "ccode-well rounded-lg p-3";

/** 行内 28px 描边次按钮：列表行/工具栏次级操作统一口径（原各页 secBtn 逐字复制的收敛点） */
export const rowActionClass =
  "inline-flex h-7 items-center justify-center rounded-lg border border-field bg-strip px-2.5 text-xs text-l2 transition-colors hover:bg-inset hover:text-l1 disabled:opacity-50";

/** 弹窗页脚里的低调动作（跳过 / 忽略 / 稍后）：无框、与主次按钮同为 32px 高——
 *  ghostActionClass 是 28px 行内尺寸，放进弹窗页脚会和旁边的主按钮高低不齐 */
export const quietActionClass =
  "ccode-action-quiet inline-flex h-8 items-center justify-center rounded-lg px-3 text-xs text-l3 transition-colors hover:bg-hover hover:text-l1 disabled:cursor-not-allowed disabled:opacity-50";

/** 设置页按钮（2026-10-18，借鉴 Codex 设置页）：抬底胶囊，行内操作与卡头动作统一一档 */
export const settingsPillClass =
  "inline-flex h-8 items-center justify-center rounded-lg border border-hairline bg-raised px-3.5 text-xs font-medium text-l1 transition-colors hover:bg-seg-sel disabled:cursor-not-allowed disabled:opacity-50";

/** 行内 28px 无框低调按钮：辅助/低频动作 */
export const ghostActionClass =
  "inline-flex h-7 items-center justify-center rounded-lg px-2 text-xs text-l3 transition-colors hover:bg-hover hover:text-l1 disabled:opacity-50";

/** 流程卡片内的轻量操作：与列表行操作共用 28px 热区，但不带描边。 */
export const inlineActionClass =
  "inline-flex h-7 items-center justify-center rounded-lg px-2 text-xs text-l2 transition-colors hover:bg-hover hover:text-l1 disabled:opacity-50";

/** 流程卡片内的紧凑主动作：仅用于卡片内部，不与页面主 CTA 抢层级。 */
export const compactPrimaryActionClass =
  "inline-flex h-7 items-center justify-center rounded-lg border border-cta-bd bg-cta px-2 text-xs text-cta-text transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50";

/** 紧凑表单控件：与标准 field 同源，只收窄高度和字号。 */
export const compactFieldClass =
  "h-7 rounded-lg border border-field bg-canvas px-2 text-xs text-l2 outline-none placeholder:text-l4 focus:border-l4";

/** 表单输入框：模态与内联表单统一（canvas 底 + field 边） */
export const fieldClass =
  "w-full rounded-lg border border-field bg-canvas px-2 py-1.5 text-sm text-l2 outline-none placeholder:text-l4 focus:border-l4";

/** 浮层/卡片上的输入：跟表面同底，避免 canvas 在 raised 上挖出一块黑。 */
export const surfaceFieldClass =
  "w-full rounded-lg border border-field bg-strip px-2 py-1.5 text-sm text-l2 outline-none placeholder:text-l4 focus:border-l4";

export function MenuSelect({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
  placeholder?: string;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(
    null,
  );
  // 关闭后保持挂载 150ms 播退场（pos 不清空，退场期间位置不动）；
  // 选中项走 closeNow 即时消失（macOS 菜单口径），Esc/点外才有退场
  const { render, exiting, closeNow } = useExitRender(open);
  const current = options.find((item) => item.value === value);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    };
    place();
    const onDoc = (event: globalThis.MouseEvent) => {
      const t = event.target as Node;
      if (wrapRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className={`${surfaceFieldClass} flex h-8 items-center justify-between gap-2 py-0 text-left ${
          current ? "text-l1" : "text-l4"
        }`}
        onClick={() => setOpen((next) => !next)}
      >
        <span className="min-w-0 truncate">
          {current?.label ?? placeholder ?? "请选择"}
        </span>
        <ChevronDown
          size={14}
          strokeWidth={1.8}
          className="shrink-0 text-l4"
          aria-hidden="true"
        />
      </button>
      {render &&
        pos &&
        typeof document !== "undefined" &&
        document.body &&
        createPortal(
          <ul
            ref={menuRef}
            role="listbox"
            style={{ top: pos.top, left: pos.left, width: pos.width }}
            className={`ccode-anchor-topleft ccode-float-surface fixed z-50 max-h-64 overflow-auto py-1${exiting ? " ccode-exiting" : ""}`}
          >
            {options.map((item) => {
              const selected = item.value === value;
              return (
                <li key={item.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={item.disabled}
                    className={`flex h-8 w-full items-center px-2.5 text-left text-sm disabled:opacity-40 ${
                      selected
                        ? "bg-hover text-l1"
                        : "text-l2 hover:bg-hover hover:text-l1"
                    }`}
                    onClick={() => {
                      onChange(item.value);
                      closeNow();
                      setOpen(false);
                    }}
                  >
                    <span className="truncate">{item.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>,
          document.body,
        )}
    </div>
  );
}

/** 搜索输入框：inset 底色分层（无描边，聚焦时底色加深一档），与表单输入区分开。
 *  占位字用 l3：l4 在 inset 上只有 3.16:1，低于 4.5:1（2026-10-23） */
export const searchFieldClass =
  "h-8 rounded-lg bg-inset px-2.5 text-xs text-l2 outline-none transition-colors placeholder:text-l3 focus:bg-raised";

/** hover 才现的低频操作：行挂 group，按钮用此类；键盘 Tab 聚焦（focus-visible）同样显示 */
export const hoverRevealClass =
  "opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100";

/** 行内 28px 图标按钮：文件行 / 雷达条目 / 筛选工具 */
export const iconActionClass =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-l3 hover:bg-hover hover:text-l1 disabled:cursor-not-allowed disabled:opacity-50";

/** 行内悬浮操作钮（v3.93）：自带「锚点上方」应用内 tooltip——原生 title 渲染在光标下方，
 *  与胶囊动作栏视觉脱节；点击先收 tooltip 再透传事件（⋯ 要取按钮锚点定位菜单）。
 *  点击区保持 h-7 w-7（≥28px 硬约束）。 */
export function RowAction({
  icon,
  tip,
  label,
  onClick,
}: {
  /** Lucide 线框图标（14px / 1.8，与侧栏同套）；旧的 ✎ ◈ ↯ 文字符号已换掉（2026-10-23） */
  icon: ReactNode;
  tip: string;
  label: string;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const { tip: pos, show, hide } = useHoverTip(ref, true);
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      onMouseEnter={show}
      onMouseLeave={hide}
      onClick={(e) => {
        hide();
        onClick(e);
      }}
      className="flex h-7 w-7 items-center justify-center rounded-sm text-xs text-l3 hover:bg-hover hover:text-l1"
    >
      {icon}
      <HoverTip tip={pos} text={tip} up />
    </button>
  );
}

/** 分段切换（状态筛选/时间范围）：胶囊行，选中 bg-seg-sel，未选中灰字 */
export function SegTabs<T extends string>({
  items,
  value,
  onChange,
  className = "",
}: {
  items: readonly { id: T; label: ReactNode }[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  const selectedIndex = items.findIndex((item) => item.id === value);
  return (
    <div
      className={`flex items-center gap-1 ${className}`}
      role="tablist"
      onKeyDown={(event) => {
        if (!items.length) return;
        const delta = tabNavDelta(event.key);
        if (!delta) return;
        event.preventDefault();
        onChange(items[nextTabIndex(selectedIndex, delta, items.length)].id);
      }}
    >
      {items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={value === item.id}
          tabIndex={tabStopIndex(index, selectedIndex)}
          onClick={() => onChange(item.id)}
          onFocus={() => {
            if (value !== item.id) onChange(item.id);
          }}
          className={`flex h-7 items-center rounded-full px-3 text-xs transition-colors ${
            value === item.id ? "bg-seg-sel text-l1" : "text-l3 hover:text-l1"
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function PageToolbar({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`ccode-page-toolbar mb-5 flex min-h-11 flex-wrap items-center justify-between gap-2 py-1 ${className}`}
    >
      {children}
    </div>
  );
}

export function EmptyState({
  title,
  detail,
  action,
  compact = false,
}: {
  title: string;
  detail?: ReactNode;
  action?: ReactNode;
  /** 页面内嵌卡片使用的紧凑空态，不改变管理页默认留白。 */
  compact?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center px-6 text-center ${
        compact ? "min-h-32 py-6" : "min-h-48 py-10"
      }`}
    >
      {/* 原来这里有个空心圆图标：它不表达任何东西，纯占位。去掉后标题自然成为视觉起点 */}
      <p className="text-base font-medium text-l1">{title}</p>
      {detail && (
        <div className="mt-2 max-w-lg text-xs leading-6 text-l3">{detail}</div>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
        checked ? "border-cta-bd bg-cta" : "border-field bg-switch-off"
      }`}
    >
      {/* 滑块用专用令牌而非 bg-l1：l1 是「文字最亮档」，在浅色主题是近黑 #171a26，
          直接当滑块会渲染成白底上的黑疙瘩（v3.85 修）。滑块永远是浅色，状态由轨道表达。
          开启态轨道 = 品牌色 bg-cta（随主题；2026-08-25 试过降调柔绿 bg-ok-text，用户拍板改回） */}
      <span
        className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-switch-knob transition-[left] ${
          checked ? "left-[18px]" : "left-0.5"
        }`}
      />
    </button>
  );
}

/** 折叠指示：旋转 chevron，替代 ▸/▾ 小字。
 *  boxed = 分区/组头用的 28px 模块；列表行、树节点用默认紧凑档。 */
export function FoldMark({
  open,
  boxed = false,
}: {
  open: boolean;
  boxed?: boolean;
}) {
  const svg = (
    <svg
      aria-hidden="true"
      width={boxed ? 12 : 10}
      height={boxed ? 12 : 10}
      viewBox="0 0 12 12"
      fill="none"
      className={`shrink-0 transition-transform duration-150 ${open ? "rotate-0" : "-rotate-90"}`}
    >
      <path
        d="M2.75 4.25 L6 8 L9.25 4.25"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
  return (
    <span
      aria-hidden="true"
      className={
        boxed
          ? "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-inset text-l2"
          : "inline-flex h-5 w-5 shrink-0 items-center justify-center text-l3"
      }
    >
      {svg}
    </span>
  );
}

/**
 * 折叠区的内容：展开 / 收起走 grid 行轨 0fr ↔ 1fr 过渡，不用 JS 量高度。收起完才卸载（长对话里收着的过程不常驻 DOM），
 * 过渡中的内容 inert；reduced-motion 下直接切。className 落在内容层上，外边距在过渡里一起收
 */
export function Collapse({ open, className = "", children }: { open: boolean; className?: string; children: ReactNode }) {
  const [phase, setPhase] = useState<CollapsePhase>(open ? "open" : "closed");
  const ref = useRef<HTMLDivElement>(null);
  const next = nextCollapsePhase(phase, open, prefersReducedMotion());
  if (next !== phase) setPhase(next);
  useLayoutEffect(() => {
    if (phase !== "pre") return;
    // 先让 0fr 落定一次，过渡才有起点
    void ref.current?.offsetHeight;
    setPhase("opening");
  }, [phase]);
  useEffect(() => {
    const settled = settledCollapsePhase(phase);
    if (!settled) return;
    const t = window.setTimeout(() => setPhase(settled), COLLAPSE_MS);
    return () => window.clearTimeout(t);
  }, [phase]);
  if (phase === "closed") return null;
  return (
    <div ref={ref} className="ccode-collapse" data-phase={phase}>
      <div inert={phase !== "open"}>
        <div className={className}>{children}</div>
      </div>
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  className = "",
  align = "center",
  disabled = false,
  title,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  className?: string;
  align?: "center" | "start";
  disabled?: boolean;
  title?: string;
}) {
  return (
    // relative：sr-only 的 input 是绝对定位，必须以本 label 为定位基准。否则它落在外层
    // 定位祖先的静态位置（不随列表滚动），点勾选聚焦时浏览器会去滚 overflow:hidden 的主面板，
    // 整页被推走只剩空白（对话页批量管理实证）。
    <label
      title={title}
      className={`relative flex gap-1.5 ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"} ${align === "start" ? "items-start" : "items-center"} ${className}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only"
      />
      <span
        aria-hidden="true"
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border text-micro ${align === "start" ? "mt-0.5" : ""} ${
          checked
            ? "border-cta-bd bg-cta text-cta-text"
            : "border-field bg-transparent text-transparent"
        }`}
      >
        {checked ? "✓" : ""}
      </span>
      {label}
    </label>
  );
}

export function LoadingRows({ compact = false }: { compact?: boolean }) {
  return (
    <div
      role="status"
      aria-label="加载中"
      className={`animate-pulse space-y-3 ${compact ? "py-2" : "py-6"}`}
    >
      {["w-3/5", "w-full", "w-4/5"].map((width, index) => (
        <div key={index} className={`h-3 rounded-sm bg-inset ${width}`} />
      ))}
    </div>
  );
}

/** 一次性提示条（注册结果、模板已应用、git 引导等）：全站同一副长相。
 *  原先各页各写一份裸文字或自制 div——ProjectGroup 一个文件里就有 5 份「知道了」条，
 *  文案长了就散架（顶部 notice 是一行绿字，塞进两句话后既挤又刺眼）。
 *  版式取自工作区创建成功条：inset 卡片 + 语义色仅用在图标上，正文保持正常前景色。 */
export function NoticeBar({
  tone = "ok",
  children,
  onDismiss,
  className = "",
}: {
  /** ok = 完成；info = 中性说明；warn = 需留意；err = 失败（2026-10-17 加，替代整段红字） */
  tone?: "ok" | "info" | "warn" | "err";
  children: React.ReactNode;
  /** 给了才显示「知道了」——不给就是随时间自动消失的那种 */
  onDismiss?: () => void;
  className?: string;
}) {
  // 语义色只上图标，正文保持中性前景色（整段绿字 / 红字读着刺眼，也分不出主次）
  const Glyph =
    tone === "ok" ? CircleCheck : tone === "warn" ? TriangleAlert : tone === "err" ? CircleX : Info;
  const iconCls =
    tone === "ok"
      ? "text-ok-text"
      : tone === "warn"
        ? "text-warn-text"
        : tone === "err"
          ? "text-err-text"
          : "text-l4";
  // 纯文本自动分层：首句是结果（标题），其余按句成行（说明）
  const parts = typeof children === "string" ? splitNoticeText(children) : null;
  return (
    <div
      role={tone === "err" ? "alert" : "status"}
      className={`flex items-start gap-2 rounded-md ccode-well px-3 py-2.5 text-xs leading-5 text-l2 ${className}`}
    >
      <span className="ccode-icon-line">
        <Glyph size={14} strokeWidth={1.8} aria-hidden="true" className={iconCls} />
      </span>
      <span className="min-w-0 flex-1 break-words">
        {parts ? (
          <>
            <span className={parts.details.length ? "block font-medium text-l1" : undefined}>
              {parts.headline}
            </span>
            {parts.details.map((line, i) => (
              <span key={i} className="mt-0.5 block text-l3">
                {line}
              </span>
            ))}
          </>
        ) : (
          children
        )}
      </span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded-sm px-1.5 py-0.5 text-l4 hover:bg-hover hover:text-l1"
        >
          知道了
        </button>
      )}
    </div>
  );
}

/** 行内结果 / 错误 / 提醒（2026-10-17）：放在列表行、卡片角落、表单底部这类挤的地方，
 *  不铺底色块（那是 NoticeBar 的事）。同一口径：语义色只上图标，正文中性色；
 *  纯文本同样按「结果 + 说明行」分层。替代原来散落各处的整段 text-err-text / text-ok-text。 */
export function InlineNotice({
  tone = "err",
  size = "xs",
  children,
  className = "",
}: {
  tone?: "ok" | "info" | "warn" | "err";
  /** xs = 表单/面板；micro = 列表行内 */
  size?: "xs" | "micro";
  children: React.ReactNode;
  className?: string;
}) {
  const Glyph =
    tone === "ok" ? CircleCheck : tone === "warn" ? TriangleAlert : tone === "err" ? CircleX : Info;
  const iconCls =
    tone === "ok"
      ? "text-ok-text"
      : tone === "warn"
        ? "text-warn-text"
        : tone === "err"
          ? "text-err-text"
          : "text-l4";
  const parts = typeof children === "string" ? splitNoticeText(children) : null;
  const micro = size === "micro";
  return (
    <div
      role={tone === "err" ? "alert" : undefined}
      className={`flex items-start gap-1.5 ${micro ? "text-micro leading-4 text-l3" : "text-xs leading-5 text-l2"} ${className}`}
    >
      <Glyph
        size={micro ? 11 : 13}
        strokeWidth={1.9}
        aria-hidden="true"
        className={`shrink-0 ${micro ? "mt-[2px]" : "mt-[3px]"} ${iconCls}`}
      />
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
        {parts ? (
          <>
            {parts.headline}
            {parts.details.map((line, i) => (
              <span key={i} className="block text-l4">
                {line}
              </span>
            ))}
          </>
        ) : (
          children
        )}
      </span>
    </div>
  );
}

/** 步骤角色标记（v3.89）：you = 要你出场 / both = 协作。
 *  步骤名保留学术术语；「AI 做」与流程线「AI 干活」重复，默认不标。 */
export function RoleBadge({ role }: { role?: string }) {
  if (role !== "you" && role !== "both") return null;
  const meta =
    role === "you"
      ? { text: "你来", cls: "text-cta", title: "这一步主要靠你，AI 打下手" }
      : { text: "一起", cls: "text-l3", title: "这一步你和 AI 一起定" };
  return (
    <span
      className={`shrink-0 rounded-sm bg-raised px-1.5 py-0.5 text-micro ${meta.cls}`}
      title={meta.title}
    >
      {meta.text}
    </span>
  );
}
