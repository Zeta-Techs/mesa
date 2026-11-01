import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft } from "lucide-react";
import { confirmDialogOpen } from "./ConfirmDialog";

/**
 * 整页面板（2026-11-01 用户拍板，取代连接页的添加 / 编辑连接与网关库弹层）：
 * 盖住整个内容区（左侧主导航留着），实底无遮罩，从右侧滑入（ccode-sheet-right，220ms，设计系统侧滑抽屉口径）；
 * 顶部「‹ 标题」返回，左侧分区目录（可选），右侧内容滚动，底部操作条常驻。Esc = 返回（onBack，由调用方决定要不要先确认）。
 *
 * 定位：连接页容器本身会滚动、内容区 main 没有定位，所以面板 fixed 到 body、按 `.ccode-app-main` 的位置与圆角实时对齐，
 * 不改 App 外壳。z-30（页内抽屉档）：Modal（z-40）、菜单（z-50）、确认框（z-70）都在它上面。
 */
export default function PagePanel({
  title,
  subtitle,
  backLabel = "返回",
  onBack,
  actions,
  footer,
  footerNote,
  sections = false,
  animate = true,
  hidden = false,
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
  /** 左侧分区目录：按内容里的 `[data-panel-section]` 锚点自动生成 */
  sections?: boolean;
  /** 返回上一层时重开（如从连接回到网关库）不再播滑入 */
  animate?: boolean;
  /** 所在页面切走了（左侧导航还能点）：藏起来但不卸载，填了一半的内容留着 */
  hidden?: boolean;
  children: ReactNode;
}) {
  const rect = useMainRect();
  const panelRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const [scrolled, setScrolled] = useState(false);
  const [atBottom, setAtBottom] = useState(true);

  // 打开时把焦点移进面板，关掉还给打开前的元素
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    panelRef.current?.focus({ preventScroll: true });
    return () => prev?.focus?.({ preventScroll: true });
  }, []);

  // 底下的页面内容设 inert：Tab 不会跑到被盖住的列表上、读屏也不念（原 Modal 的焦点圈住由它顶替）
  useEffect(() => {
    if (hidden) return;
    const main = document.querySelector<HTMLElement>(".ccode-app-main");
    if (!main || main.inert) return;
    main.inert = true;
    return () => {
      main.inert = false;
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
      className={`fixed z-30 flex flex-col overflow-hidden bg-canvas outline-none ${animate ? "ccode-sheet-right" : ""}`}
      style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height, borderRadius: rect.radius }}
    >
      <header
        className={`flex h-12 shrink-0 items-center gap-2 px-3 ${scrolled ? "shadow-[inset_0_-0.5px_0_var(--color-hairline)]" : ""}`}
      >
        <button
          type="button"
          onClick={() => onBackRef.current()}
          title={`${backLabel}（Esc）`}
          aria-label={backLabel}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-l2 hover:bg-hover hover:text-l1"
        >
          <ChevronLeft size={18} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <h2 className="min-w-0 truncate text-lg font-semibold text-l1">{title}</h2>
        {subtitle && <span className="min-w-0 shrink truncate text-sm text-l3">{subtitle}</span>}
        <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>
      </header>
      {/* 目录与内容作为一组居中（目录贴着内容、滚动时吸顶），不是目录贴边、内容在剩余宽度里居中 */}
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex w-full max-w-5xl gap-8 px-8 pb-10 pt-4">
          {sections && <SectionNav scrollRef={scrollRef} />}
          <div className="mx-auto min-w-0 max-w-3xl flex-1">{children}</div>
        </div>
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
    document.body,
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

/** 内容里的分区锚点：`<span data-panel-section="id" data-panel-label="名称" />`，放在每一段开头。
 *  锚点后面紧跟的不是内容（这一段没渲染）就不进目录 */
export function PanelAnchor({ id, label }: { id: string; label: string }) {
  return <span data-panel-section={id} data-panel-label={label} aria-hidden="true" className="block h-0" />;
}

function SectionNav({ scrollRef }: { scrollRef: React.RefObject<HTMLDivElement | null> }) {
  const [items, setItems] = useState<{ id: string; label: string }[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [wide, setWide] = useState(true);

  // 目录随内容变（换 Agent、展开高级设置……）：观察子树变化重算
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const collect = () => {
      const found = [...root.querySelectorAll<HTMLElement>("[data-panel-section]")]
        .filter((el) => {
          const next = el.nextElementSibling as HTMLElement | null;
          return !!next && !next.hasAttribute("data-panel-section") && !next.closest("[hidden]") && !el.closest("[hidden]");
        })
        .map((el) => ({ id: el.dataset.panelSection!, label: el.dataset.panelLabel ?? el.dataset.panelSection! }));
      setItems((prev) =>
        prev.length === found.length && prev.every((p, i) => p.id === found[i].id && p.label === found[i].label) ? prev : found,
      );
    };
    collect();
    const mo = new MutationObserver(collect);
    mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
    return () => mo.disconnect();
  }, [scrollRef]);

  // 当前分区：滚动位置之上最后一个锚点
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const update = () => {
      const top = root.getBoundingClientRect().top + 24;
      let current: string | null = items[0]?.id ?? null;
      for (const it of items) {
        const el = root.querySelector<HTMLElement>(`[data-panel-section="${it.id}"]`);
        if (el && el.getBoundingClientRect().top <= top) current = it.id;
      }
      // 滚到底时最后几段顶不到上沿，直接算最后一段（内容不需要滚动时不算）
      const scrollable = root.scrollHeight > root.clientHeight + 2;
      if (scrollable && root.scrollTop + root.clientHeight >= root.scrollHeight - 2 && items.length) {
        current = items[items.length - 1].id;
      }
      setActive(current);
    };
    update();
    root.addEventListener("scroll", update, { passive: true });
    return () => root.removeEventListener("scroll", update);
  }, [items, scrollRef]);

  // 内容区窄于 48rem 时目录藏起（与连接页左栏同口径）
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const ro = new ResizeObserver(([e]) => setWide(e.contentRect.width >= 768));
    ro.observe(root);
    return () => ro.disconnect();
  }, [scrollRef]);

  if (!wide || items.length < 2) return null;
  return (
    <nav aria-label="分区" className="sticky top-0 w-40 shrink-0 self-start">
      <ul className="flex flex-col gap-0.5">
        {items.map((it) => (
          <li key={it.id}>
            <button
              type="button"
              aria-current={active === it.id ? "true" : undefined}
              onClick={() => {
                const root = scrollRef.current;
                const el = root?.querySelector<HTMLElement>(`[data-panel-section="${it.id}"]`);
                if (root && el) {
                  const top = el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
                  root.scrollTo({ top: top - 16, behavior: "smooth" });
                  setActive(it.id);
                }
              }}
              className={`flex h-8 w-full items-center rounded-sm px-2.5 text-left text-sm ${
                active === it.id ? "bg-hover font-medium text-l1" : "text-l3 hover:bg-hover hover:text-l2"
              }`}
            >
              {it.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
