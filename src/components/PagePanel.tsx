import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft } from "lucide-react";
import { confirmDialogOpen } from "./ConfirmDialog";
import { iconActionClass } from "./PageFrame";

/**
 * 整页面板（2026-11-01 用户拍板，取代连接页的添加 / 编辑连接与网关库弹层）：
 * 盖住整个内容区（左侧主导航留着），实底无遮罩，从右侧滑入（ccode-page-in，220ms，只滑不淡——实底整块盖住内容区，淡入等于和底下页面交叉淡化）；
 * 顶部「‹ 标题」返回，内容居中单列滚动，底部操作条常驻（分区目录 2026-11-01 试过，用户：没啥用，撤掉）。Esc = 返回（onBack，由调用方决定要不要先确认）。
 *
 * 定位：连接页容器本身会滚动、内容区 main 没有定位，所以面板 fixed 到 body、按 `.ccode-app-main` 的位置与圆角实时对齐，
 * 不改 App 外壳。z-30（页内抽屉档）：Modal（z-40）、菜单（z-50）、确认框（z-70）都在它上面。
 */
/** 滑入时长（ccode-page-in 220ms）稍多一点：打开后要做的重活（聚焦、设 inert、重拉列表）放在它之后，不在滑入的帧里插活 */
export const PAGE_PANEL_SLIDE_MS = 240;

export default function PagePanel({
  title,
  subtitle,
  backLabel = "返回",
  onBack,
  actions,
  footer,
  footerNote,
  animate = true,
  hidden = false,
  wide = false,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** 返回钮的读屏文字与悬停提示（如「返回连接」「返回网关库」） */
  backLabel?: string;
  onBack: () => void;
  /** 标题栏右侧（如「表单 / 配置」切换） */
  actions?: ReactNode;
  /** 底部操作条右侧按钮（次 → 主） */
  footer?: ReactNode;
  /** 底部操作条左侧的一行说明 / 报错 */
  footerNote?: ReactNode;
  /** 返回上一层时重开（如从连接回到网关库）不再播滑入 */
  animate?: boolean;
  /** 所在页面切走了（左侧导航还能点）：藏起来但不卸载，填了一半的内容留着 */
  hidden?: boolean;
  /** 列表页（如网关库列表）放宽到 72rem；表单页保持 48rem 单列好读 */
  wide?: boolean;
  children: ReactNode;
}) {
  const rect = useMainRect();
  const panelRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const [scrolled, setScrolled] = useState(false);
  const [atBottom, setAtBottom] = useState(true);

  // 打开时把焦点移进面板，关掉还给打开前的元素。移焦点会强制排版：等滑入走完再做，不在滑入的帧里插活
  // （2026-11-07 WKWebView 实测：聚焦 + 底下设 inert 约 15ms，放第一帧拖慢第一帧、放第二帧就卡第二帧）
  const slideMs = animate ? PAGE_PANEL_SLIDE_MS : 0;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => panelRef.current?.focus({ preventScroll: true }), slideMs);
    return () => {
      window.clearTimeout(timer);
      prev?.focus?.({ preventScroll: true });
    };
    // 只在打开时跑一次；slideMs 是打开那一刻的值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 底下的页面内容设 inert：Tab 不会跑到被盖住的列表上、读屏也不念（原 Modal 的焦点圈住由它顶替）
  useEffect(() => {
    if (hidden) return;
    const main = document.querySelector<HTMLElement>(".ccode-app-main");
    if (!main || main.inert) return;
    // 设 inert 会让底下整页重算样式（连接页很大），同样等滑入走完；所在页切回来（hidden → false）时不再播动画，立刻设
    let set = false;
    const timer = window.setTimeout(() => {
      main.inert = true;
      set = true;
    }, slideMs);
    return () => {
      window.clearTimeout(timer);
      if (set) main.inert = false;
    };
  }, [hidden]);

  // Esc = 返回。上面还有弹层（确认框、Modal、菜单）或别人已处理过这次 Esc 时不动
  useEffect(() => {
    if (hidden) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      if (confirmDialogOpen() || document.querySelector('[aria-modal="true"]')) return;
      // 展开着的下拉 / 右键菜单先吃这次 Esc（它们挂在 document / window 上、不标记已处理，只能看它们还在不在）。
      // 只认看得见、且不在被盖住的主内容区里的：别的页面藏着的列表、底下页面常驻的 listbox 不算
      const main = document.querySelector(".ccode-app-main");
      const openMenu = [...document.querySelectorAll<HTMLElement>('[role="menu"],[role="listbox"]')].some(
        (el) => !main?.contains(el) && el.getClientRects().length > 0,
      );
      if (openMenu) return;
      e.preventDefault();
      onBackRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hidden]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setScrolled(el.scrollTop > 2);
    setAtBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - 2);
  }, []);
  useEffect(() => {
    onScroll();
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [onScroll]);

  if (!rect) return null;
  return createPortal(
    <section
      ref={panelRef}
      hidden={hidden}
      tabIndex={-1}
      aria-label={typeof title === "string" ? title : undefined}
      data-surface="canvas"
      className={`fixed z-30 flex flex-col overflow-hidden bg-canvas outline-none ${animate ? "ccode-page-in" : ""}`}
      style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height, borderRadius: rect.radius }}
    >
      {/* 与 PageHeader 同一套：ccode-page-header 的 0.5px 细线滚动后淡入（data-stuck）、页名 text-lg 粗体、副标题 micro / l4 基线对齐 */}
      <header
        data-stuck={scrolled ? "" : undefined}
        className="ccode-page-header relative flex h-12 shrink-0 items-center gap-2.5 px-4"
      >
        <button
          type="button"
          onClick={() => onBackRef.current()}
          title={`${backLabel}（Esc）`}
          aria-label={backLabel}
          className={iconActionClass}
        >
          <ChevronLeft size={16} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h2 className="shrink-0 text-lg font-semibold text-l1">{title}</h2>
          {subtitle && <span className="truncate text-micro text-l4">{subtitle}</span>}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>
      </header>
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className={`mx-auto w-full px-8 pb-10 pt-4 ${wide ? "max-w-6xl" : "max-w-3xl"}`}>{children}</div>
      </div>
      {(footer || footerNote) && (
        <footer
          className={`flex h-14 shrink-0 items-center gap-2 px-6 ${atBottom ? "" : "shadow-[inset_0_0.5px_0_var(--color-hairline)]"}`}
        >
          <div className="mr-auto min-w-0 flex-1 text-xs">{footerNote}</div>
          {footer}
        </footer>
      )}
    </section>,
    // 挂进 App 外壳（.ccode-app-shell 设了 isolation: isolate、自成层叠上下文）：挂到 body 会整体压在外壳上面，
    // 外壳里的确认框（z-70）、提示条都被盖在面板底下——2026-11-01 用户：添加连接「返回不了」，就是「放弃没保存的内容？」
    // 被挡住看不见。挂在外壳里还能继承外壳上的圆角等令牌
    document.querySelector(".ccode-app-shell") ?? document.body,
  );
}

/** `.ccode-app-main` 的位置、大小与圆角；窗口 / 侧栏宽度一变就跟着变 */
function useMainRect() {
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number; radius: string } | null>(
    null,
  );
  useLayoutEffect(() => {
    const main = document.querySelector<HTMLElement>(".ccode-app-main");
    if (!main) return;
    const measure = () => {
      const r = main.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height, radius: getComputedStyle(main).borderRadius });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(main);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  return rect;
}
