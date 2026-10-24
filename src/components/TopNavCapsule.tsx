import { Fragment, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { PanelLeftOpen } from "lucide-react";
import { NAV_GROUPS, NAV_BOTTOM, type NavItem } from "../navigation";
import {
  INITIAL_NAV_ISLAND,
  isNavCapsuleItemVisible,
  normalizeNavCapsuleDelay,
  normalizeNavCapsuleDisplayMode,
  normalizeNavCapsuleVisibleItems,
  reconcileIsland,
  type NavIslandEvent,
} from "../nav-capsule";
import { NAV_ICONS } from "../navigation-icons";
import { announceLine, type RunAnnouncement } from "../run-announce";
import {
  RunActivityButton,
  RunActivityStatus,
  useRunActivity,
} from "./RunActivity";

const HINT_KEY = "ccode.navIslandHintSeen";

export default function TopNavCapsule({
  page,
  onPage,
  onQuickChat,
  onRestore,
  hideDelayMs,
  displayMode,
  visibleItems,
  announcement,
  onAnnouncementClick,
  onExpandedChange,
}: {
  page: string;
  onPage: (id: string) => void;
  onQuickChat: () => void;
  onRestore: () => void;
  hideDelayMs: number;
  displayMode?: string;
  visibleItems?: unknown;
  /** 跑完/跑挂播报。只是一段文本，不是岛的第三态——宽度由休眠面自己量。 */
  announcement?: RunAnnouncement | null;
  onAnnouncementClick?: (item: RunAnnouncement) => void;
  /** 展开态变化时通知外层：标题栏两侧的上下文靠它让位。 */
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const delay = normalizeNavCapsuleDelay(hideDelayMs);
  const mode = normalizeNavCapsuleDisplayMode(displayMode);
  const configuredItems = normalizeNavCapsuleVisibleItems(visibleItems);
  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) =>
      isNavCapsuleItemVisible(item.id, page, configuredItems),
    ),
  })).filter((group) => group.items.length > 0);
  const bottomItems = NAV_BOTTOM.filter((item) =>
    isNavCapsuleItemVisible(item.id, page, configuredItems),
  );
  const showQuickChat = configuredItems.includes("quick-chat");
  // 运行活动胶囊在不在（展开面里要不要补一根分隔线）；胶囊本身自己读同一份摘要
  const activityVisible = useRunActivity().tone !== "idle";

  const [island, dispatchIsland] = useReducer(
    reconcileIsland,
    INITIAL_NAV_ISLAND,
  );
  const expanded = island.phase === "expanded";
  /* 展开态报给外层：标题栏左右两侧的上下文（项目、运行数、⌘K、收件箱）要靠它让位。
     放在这里而不是让外层去读岛的 DOM 状态——岛自己在开，就该由岛说，外层不该反向
     去观察一个子元素长什么样。归位交给外层：岛只在 chromeHidden 时挂载，切回有
     侧栏时外层那一帧就把让位状态清了，这里不必再补一个卸载回调（两套机制描述同
     一件事，读的人还得判断哪个先跑）。 */
  useEffect(() => {
    onExpandedChange?.(expanded);
  }, [expanded, onExpandedChange]);
  const [hintVisible, setHintVisible] = useState(false);
  const [dormantWidth, setDormantWidth] = useState(0);
  const [expandedWidth, setExpandedWidth] = useState(0);
  const [rowHeight, setRowHeight] = useState(0);
  const timerRef = useRef<number | null>(null);
  const islandRef = useRef<HTMLElement>(null);
  const dormantRowRef = useRef<HTMLDivElement>(null);
  const expandedRowRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const send = (event: NavIslandEvent) => dispatchIsland(event);

  const clearHideTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  /** 离开后等一会儿再收；收不收由状态机按「指针/焦点是否还在」当场决定。 */
  const collapseLater = () => {
    clearHideTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      send("delay-expired");
    }, delay);
  };

  const reveal = () => {
    clearHideTimer();
    send("pointer-enter");
  };

  const conceal = () => {
    clearHideTimer();
    send("close");
  };

  // Esc 收起。不做自定义 Tab 焦点环：岛在 DOM 顺序上排在页面内容之前，
  // 岛内最后一个按钮 Tab 出去自然进页面；焦点离开岛时 onBlur 会收起。
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    conceal();
  };

  const revealForKeyboard = () => {
    clearHideTimer();
    send("focus");
    window.requestAnimationFrame(() => {
      itemRefs.current["restore"]?.focus();
    });
  };

  // 换页不收起：早先有一条「换页即回休眠」的效应，理由是「不再占着顶部」——
  // 那是岛还浮在内容上方时的顾虑。岛现在嵌在标题栏里、不占内容，而连着切几页
  // 是常规操作，点一下就把岛收掉会把「接着看下一个入口」掐断。
  // 收不收仍由状态机按指针/焦点判：鼠标离开或焦点离开后照旧按 delay 收起。

  useEffect(() => {
    if (localStorage.getItem(HINT_KEY) === "1") return;
    localStorage.setItem(HINT_KEY, "1");
    setHintVisible(true);
    const id = window.setTimeout(() => setHintVisible(false), 3200);
    return () => window.clearTimeout(id);
  }, []);

  // 首次真正展开过就撤掉提示，不用纯计时器收尾
  useEffect(() => {
    if (hintVisible && expanded) setHintVisible(false);
  }, [hintVisible, expanded]);

  /* 岛收回休眠时，把「指针点出来的焦点」从展开面里摘掉。
     Chromium 点按钮会留下 DOM 焦点，展开面收起后它是 aria-hidden 的——
     焦点留在里面等于留了个看不见、却还能被 Enter/Space 触发的按钮。
     键盘焦点不在此列：它由 onBlur 自己交接，休眠态里也还要能继续 Tab。 */
  useEffect(() => {
    if (expanded) return;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    if (!islandRef.current?.contains(active)) return;
    if (active.matches(":focus-visible")) return;
    active.blur();
  }, [expanded]);

  /* 两副面孔各量各的自然宽度，容器再按目标宽度做形变。
     量的是面孔内部的行（不受容器宽度约束），不是被夹住的容器本身——
     否则「容器宽度由量值决定、量值又被容器夹住」会形成自反馈环。 */
  useLayoutEffect(() => {
    const sync = () => {
      const d = dormantRowRef.current;
      const e = expandedRowRef.current;
      if (d) {
        const w = Math.ceil(d.getBoundingClientRect().width);
        const h = Math.ceil(d.getBoundingClientRect().height);
        setDormantWidth((prev) => (prev === w ? prev : w));
        setRowHeight((prev) => (prev === h ? prev : h));
      }
      if (e) {
        const w = Math.ceil(e.getBoundingClientRect().width);
        setExpandedWidth((prev) => (prev === w ? prev : w));
      }
    };
    sync();
    const observer = new ResizeObserver(sync);
    if (dormantRowRef.current) observer.observe(dormantRowRef.current);
    if (expandedRowRef.current) observer.observe(expandedRowRef.current);
    return () => observer.disconnect();
  });

  // 展开时把当前页滚进视野（窄窗口下展开面会被 max-width 夹住）
  useEffect(() => {
    if (!expanded) return;
    itemRefs.current[page]?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [page, expanded]);

  useEffect(() => clearHideTimer, []);

  const showIcon = mode !== "labels";
  const showLabel = mode !== "icons";
  const itemContent = (Icon: NavItem["Icon"], label: string) => (
    <>
      {showIcon && <Icon size={15} strokeWidth={1.8} aria-hidden="true" />}
      {showLabel && <span>{label}</span>}
    </>
  );
  /** 展开面的导航项。`interactive` 决定是否可聚焦——休眠时整面 aria-hidden 且不可 Tab。 */
  /** 新对话不是页：照侧栏的顺序插在「工作台」后面；工作台被隐藏时排在第一组最前（2026-10-24 侧栏改版同步） */
  const quickChatItem = (interactive: boolean) => (
    <button
      key="quick-chat"
      ref={(el) => {
        itemRefs.current["quick-chat"] = el;
      }}
      type="button"
      tabIndex={interactive ? 0 : -1}
      onClick={onQuickChat}
      aria-label="新对话"
      title="新对话：直接开一段空白对话，默认在随手聊里"
      className="ccode-top-nav-item shrink-0"
    >
      {itemContent(NAV_ICONS.quickChat, "新对话")}
    </button>
  );
  const quickChatAfterWorkbench = groups[0]?.items[0]?.id === "workbench";
  /** 展开面的导航项。`interactive` 决定是否可聚焦——休眠时整面 aria-hidden 且不可 Tab。 */
  const navItems = (interactive: boolean) => (
    <>
      {showQuickChat && groups.length === 0 && quickChatItem(interactive)}
      {groups.map((group, groupIndex) => (
        <span key={group.label} className="contents">
          {showQuickChat && groupIndex === 0 && !quickChatAfterWorkbench && quickChatItem(interactive)}
          {group.items.map((item) => {
            const active = page === item.id;
            const button = (
              <button
                key={item.id}
                ref={(el) => {
                  itemRefs.current[item.id] = el;
                }}
                type="button"
                tabIndex={interactive ? 0 : -1}
                onClick={() => onPage(item.id)}
                aria-current={active ? "page" : undefined}
                aria-label={item.label}
                title={item.label}
                className={`ccode-top-nav-item shrink-0 ${active ? "ccode-top-nav-item-active" : ""}`}
              >
                {itemContent(item.Icon, item.label)}
              </button>
            );
            return item.id === "workbench" && showQuickChat ? (
              <Fragment key={item.id}>
                {button}
                {quickChatItem(interactive)}
              </Fragment>
            ) : (
              button
            );
          })}
          {groupIndex < groups.length - 1 && (
            <span className="ccode-top-nav-separator" aria-hidden="true" />
          )}
        </span>
      ))}
      {(groups.length > 0 || showQuickChat) && bottomItems.length > 0 && (
        <span className="ccode-top-nav-separator" aria-hidden="true" />
      )}
      {bottomItems.map((item) => {
        const active = page === item.id;
        return (
          <button
            key={item.id}
            ref={(el) => {
              itemRefs.current[item.id] = el;
            }}
            type="button"
            tabIndex={interactive ? 0 : -1}
            onClick={() => onPage(item.id)}
            aria-current={active ? "page" : undefined}
            aria-label={item.label}
            title={item.label}
            className={`ccode-top-nav-item shrink-0 ${active ? "ccode-top-nav-item-active" : ""}`}
          >
            {itemContent(item.Icon, item.label)}
          </button>
        );
      })}
    </>
  );

  /* 恢复侧栏只在展开面，排第一：展开后键盘第一下就够得着（revealForKeyboard 聚焦它）。
     休眠面不再放它——那里只报状态（当前页 + 活动），见下方休眠面注释。 */
  const restoreItem = (interactive: boolean) => (
    <button
      ref={(el) => {
        itemRefs.current["restore"] = el;
      }}
      type="button"
      tabIndex={interactive ? 0 : -1}
      onClick={onRestore}
      aria-label="恢复侧栏"
      title="恢复侧栏"
      className="ccode-top-nav-item shrink-0"
    >
      {itemContent(PanelLeftOpen, "恢复侧栏")}
    </button>
  );

  // 休眠面的当前页：图标 + 页名（找不到的页回落「Mesa」）
  const allNav: readonly NavItem[] = [
    ...NAV_GROUPS.flatMap((g): readonly NavItem[] => g.items),
    ...NAV_BOTTOM,
  ];
  const currentNav = allNav.find((item) => item.id === page);

  const hasNav = showQuickChat || groups.length > 0 || bottomItems.length > 0;

  /** 跑完/跑挂播报（瞬时，停留时长由 App 管）：点了去运行页。 */
  const announceItem = (interactive: boolean) =>
    !announcement ? null : !interactive ? (
      // 休眠面：只读一句话（休眠面控件指针够不着，可点的那份在展开面）
      <span
        className={`ccode-nav-island-announce shrink-0 ${
          announcement.outcome === "failed"
            ? "ccode-nav-island-announce-failed"
            : ""
        }`}
      >
        <span className="ccode-nav-island-announce-dot" aria-hidden="true" />
        {announceLine(announcement)}
      </span>
    ) : (
      <button
        type="button"
        tabIndex={interactive ? 0 : -1}
        onClick={() => onAnnouncementClick?.(announcement)}
        aria-label={announceLine(announcement)}
        title={`${announceLine(announcement)}（点击去运行）`}
        className={`ccode-nav-island-announce shrink-0 ${
          announcement.outcome === "failed"
            ? "ccode-nav-island-announce-failed"
            : ""
        }`}
      >
        <span className="ccode-nav-island-announce-dot" aria-hidden="true" />
        {announceLine(announcement)}
      </button>
    );

  /* 目标宽度直接取量值：.ccode-nav-island 是 content-box，padding 与边框长在外侧，
     量到多宽就写多宽。用 border-box 反而要在这里加上 4+4+1+1，改 CSS 就会错位。 */
  const targetWidth = expanded
    ? expandedWidth
      ? `min(${expandedWidth}px, calc(100vw - 24px))`
      : "calc(100vw - 24px)"
    : dormantWidth
      ? `${dormantWidth}px`
      : undefined;

  return (
    <>
      {/* 键盘唤出入口：展开面里的按钮本身可聚焦，这里给「Tab 从岛尾走回岛头」一个落点 */}
      <button
        type="button"
        className="ccode-nav-capsule-sentinel"
        aria-label="显示顶部导航"
        onFocus={revealForKeyboard}
      />
      {hintVisible && (
        <div className="ccode-nav-island-hint" role="status">
          侧栏已隐藏 · 顶部岛悬停展开导航
        </div>
      )}
      {/* 岛不用 .ccode-float-surface：它带的 ccode-pop 动画会写 transform: scale()，
          和岛自己的 translateX(-50%) 居中打架——入场那 150ms 会先偏右再弹回来。
          玻璃底、边框和内高光都在 .ccode-nav-island 里自带，不需要那个类。 */}
      <nav
        ref={islandRef}
        aria-label="全局导航"
        data-state={island.phase}
        className="ccode-nav-island"
        style={{
          width: targetWidth,
          // content-box：写的就是内容盒高度，上下 4px padding 与 1px 边框由 CSS 加在外侧
          height: rowHeight ? `${rowHeight}px` : undefined,
        }}
        onMouseEnter={reveal}
        onMouseLeave={() => {
          send("pointer-leave");
          collapseLater();
        }}
        onFocus={(e) => {
          clearHideTimer();
          /* 只把「键盘来的焦点」记为键盘停驻。Chromium 上鼠标点按钮同样会给它焦点，
             若照收，指针离开后 focused 仍为真，岛就再也不收了——这个差异只在
             WebView2 上现形（macOS 的 WKWebView 不给按钮焦点，所以看着是好的）。
             :focus-visible 正是按输入方式判定的：键盘为真、指针为假。
             指针路径不需要这里补什么：鼠标还在岛上时 pointerInside 本来就托着岛。 */
          if (e.target instanceof Element && e.target.matches(":focus-visible")) {
            send("focus");
          }
        }}
        onBlur={(e) => {
          if (
            e.relatedTarget instanceof Node &&
            islandRef.current?.contains(e.relatedTarget)
          )
            return;
          send("blur");
          collapseLater();
        }}
        onKeyDown={onKeyDown}
      >
        {/* 两副面孔绝对叠放：容器做宽高形变，面孔只做淡入淡出。
            这样不必给每个导航项做位移动画，切换时也不会互相挤压。 */}
        <div className="ccode-nav-island-face">
          {/* 休眠面＝状态，展开面＝操作（灵动岛的本意）。休眠面只报两件事：在哪一页、
              正在发生什么（活动 / 刚跑完的播报）；项目归顶栏左侧芯片，不在这里重复。
              旧版休眠面只有一颗「恢复侧栏」：读起来是一个孤立按钮而不是一座岛，报的是
              「你能做什么」而不是「现在怎样」。当前页这一格是**状态不是开关**——点它/聚焦它
              只是把岛展开（旧版并排放可点的当前页块被否，是因为点它等于把页设成自己）。
              这里的东西指针够不着（一进岛就展开），所以除了键盘入口外一律只读，可点的在展开面。
              当前页始终带文字，不跟 displayMode 走：只剩图标时看不出这是入口。 */}
          <div
            ref={dormantRowRef}
            className="ccode-nav-island-row ccode-nav-island-row-dormant"
            aria-hidden={expanded}
          >
            <button
              type="button"
              tabIndex={!expanded ? 0 : -1}
              onClick={reveal}
              onFocus={revealForKeyboard}
              aria-label={`展开导航（当前：${currentNav?.page ?? currentNav?.label ?? "Mesa"}）`}
              className="ccode-top-nav-item ccode-nav-island-current shrink-0"
            >
              {currentNav && (
                <currentNav.Icon size={15} strokeWidth={1.8} aria-hidden="true" />
              )}
              <span>{currentNav?.page ?? currentNav?.label ?? "Mesa"}</span>
            </button>
            <RunActivityStatus />
            {announceItem(false)}
          </div>
          <div
            ref={expandedRowRef}
            className="ccode-nav-island-row ccode-nav-island-row-expanded"
            aria-hidden={!expanded}
          >
            {restoreItem(expanded)}
            {hasNav && (
              <span className="ccode-top-nav-separator" aria-hidden="true" />
            )}
            {navItems(expanded)}
            {/* 活动与播报在展开面里也要有：指针一进岛就展开、休眠面被藏起，
                只放在休眠面的东西鼠标根本点不到（旧版播报正是这样「看得见点不着」）。 */}
            {(activityVisible || announcement) && (
              <span className="ccode-top-nav-separator" aria-hidden="true" />
            )}
            <RunActivityButton variant="island" tabIndex={expanded ? 0 : -1} />
            {announceItem(expanded)}
          </div>
        </div>
      </nav>
    </>
  );
}
