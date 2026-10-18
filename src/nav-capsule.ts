/* 收起延时档位。0 = 立即：指针一离开就收，不做等待。
   0 走的是普通分支而非特例——collapseLater 里 setTimeout(fn, 0) 排的是下一个宏任务，
   指针从岛边掠过时 mouseleave 排的任务会被 mouseenter 的 clearHideTimer 取消，
   反而比"同步收起再展开"少一次闪烁。 */
export const NAV_CAPSULE_DELAYS = [0, 500, 1000, 2000, 5000] as const;
export type NavCapsuleDelayMs = (typeof NAV_CAPSULE_DELAYS)[number];

export const NAV_CAPSULE_DISPLAY_MODES = ["both", "icons", "labels"] as const;
export type NavCapsuleDisplayMode = (typeof NAV_CAPSULE_DISPLAY_MODES)[number];

/** 可由用户配置的胶囊入口；恢复侧栏不在此列，始终保留。 */
export const NAV_CAPSULE_ITEM_IDS = [
  "quick-chat",
  "workbench",
  "workspaces",
  "terminal",
  "sessions",
  "profiles",
  "skills",
  "mcp",
  "stats",
  "settings",
] as const;
export type NavCapsuleItemId = (typeof NAV_CAPSULE_ITEM_IDS)[number];
export const DEFAULT_NAV_CAPSULE_VISIBLE_ITEMS = [...NAV_CAPSULE_ITEM_IDS];

export type StartupNavMode = "expanded" | "collapsed" | "hidden";

export interface NavShellState {
  navCollapsed: boolean;
  chromeHidden: boolean;
  chromeHiddenReturnCollapsed: boolean | null;
}

export function normalizeNavCapsuleDelay(value: unknown): NavCapsuleDelayMs {
  return NAV_CAPSULE_DELAYS.includes(value as NavCapsuleDelayMs)
    ? (value as NavCapsuleDelayMs)
    : 1000;
}

export function normalizeNavCapsuleDisplayMode(
  value: unknown,
): NavCapsuleDisplayMode {
  return NAV_CAPSULE_DISPLAY_MODES.includes(value as NavCapsuleDisplayMode)
    ? (value as NavCapsuleDisplayMode)
    : "both";
}

export function normalizeNavCapsuleVisibleItems(value: unknown): NavCapsuleItemId[] {
  if (!Array.isArray(value)) return [...DEFAULT_NAV_CAPSULE_VISIBLE_ITEMS];
  const allowed = new Set<string>(NAV_CAPSULE_ITEM_IDS);
  return value.filter(
    (id): id is NavCapsuleItemId => typeof id === "string" && allowed.has(id),
  );
}

/** 当前页即使被用户隐藏，也临时保留入口，避免完全隐藏后无法回到该页。 */
export function isNavCapsuleItemVisible(
  id: string,
  page: string,
  visibleItems: readonly string[],
): boolean {
  return id === page || visibleItems.includes(id);
}

export function resolveStartupNavMode(
  value: unknown,
  legacyCollapsed: boolean,
): StartupNavMode {
  if (value === "expanded" || value === "collapsed" || value === "hidden") {
    return value;
  }
  return legacyCollapsed ? "collapsed" : "expanded";
}

export function enterChromeHidden(state: NavShellState): NavShellState {
  if (state.chromeHidden) return state;
  return {
    ...state,
    chromeHidden: true,
    chromeHiddenReturnCollapsed: state.navCollapsed,
  };
}

export function exitChromeHidden(state: NavShellState): NavShellState {
  if (!state.chromeHidden) return state;
  return {
    ...state,
    navCollapsed:
      state.chromeHiddenReturnCollapsed ?? state.navCollapsed,
    chromeHidden: false,
    chromeHiddenReturnCollapsed: null,
  };
}

export function toggleChromeHiddenState(state: NavShellState): NavShellState {
  return state.chromeHidden ? exitChromeHidden(state) : enterChromeHidden(state);
}

/** Brand button cycle: expanded ↔ icon. Fully hidden is controlled separately. */
export function cycleBrandState(state: NavShellState): NavShellState {
  if (state.chromeHidden) return exitChromeHidden(state);
  return { ...state, navCollapsed: !state.navCollapsed };
}

/* ---------------------------------------------------------------------------
   完全隐藏侧栏时的顶部灵动岛。

   旧结构是「幽灵胶囊」：一条隐形热区 + 悬停唤出、随后自己跑掉。全收起后窗口顶部
   是空的，用户不主动去摸就以为导航没了。现在胶囊常驻，只在两态之间收缩/展开：

     dormant（休眠） 只报状态：当前页（图标+页名）· 运行活动 · 刚跑完的播报，始终可见
     expanded        完整操作：恢复侧栏、分组导航、新对话、可点的活动胶囊与播报

   休眠＝状态、展开＝操作，是灵动岛的本意。旧版休眠面只有一颗「恢复侧栏」，读起来是孤立
   按钮而不是一座岛（2026-10-17 用户点名「怪怪的」）。休眠面里的东西指针够不着（一进岛
   就展开），所以只放展示；当前页那一格聚焦/点击只展开岛，不是「回当前页」的开关。
   项目不在岛上报——隐藏侧栏时顶栏左侧项目芯片常驻，岛再报就重复了。

   状态机是纯函数，命名与 nav-capsule 其余部分一致：reconcileIsland 收口所有事件，
   reducer 只负责按事件改瞬时标志，避免「悬停中却因为定时器到点而收起」这类竞态。
--------------------------------------------------------------------------- */

export type NavIslandPhase = "dormant" | "expanded";

export interface NavIslandState {
  phase: NavIslandPhase;
  /** 指针是否停在岛上。收起前的等待期靠它兜住「鼠标刚离开又回来」。 */
  pointerInside: boolean;
  /** 岛内是否有键盘焦点。 */
  focused: boolean;
}

export const INITIAL_NAV_ISLAND: NavIslandState = {
  phase: "dormant",
  pointerInside: false,
  focused: false,
};

export type NavIslandEvent =
  | "pointer-enter"
  | "pointer-leave"
  | "focus"
  | "blur"
  /** 离开后的等待期到点：无人再指向岛上时收起。 */
  | "delay-expired"
  /** Esc / 点击岛外：立刻收起。 */
  | "close";

/**
 * 岛是否应当处于展开态。聚焦与悬停共用一条判据——
 * 「指针在岛上」「键盘焦点在岛上」任一成立即展开，两者都退出才允许收起。
 */
export function isIslandExpanded(state: NavIslandState): boolean {
  return state.focused || state.pointerInside;
}

/**
 * 岛状态机。只按事件改瞬时标志，收不收由 delay-expired 当场看标志决定——
 * 这样「悬停中定时器到点」不会误收，也不需要外部再判一遍。
 *
 * 注意这里没有「选中后立刻收起」事件：鼠标在岛上时它本来就该保持展开，
 * 键盘焦点在岛上时更要保持（否则焦点会落进非活动面）。收起统一交给
 * 指针/焦点离开后的等待期。
 */
export function reconcileIsland(
  state: NavIslandState,
  event: NavIslandEvent,
): NavIslandState {
  switch (event) {
    case "close":
      return INITIAL_NAV_ISLAND;
    case "pointer-enter":
      return { ...state, pointerInside: true, phase: "expanded" };
    case "focus":
      return { ...state, focused: true, phase: "expanded" };
    // 收起只在全部退出标志都清空后才生效，中途重新指向会把这几个事件打断
    case "pointer-leave":
      return { ...state, pointerInside: false };
    case "blur":
      return { ...state, focused: false };
    case "delay-expired":
      return isIslandExpanded(state) ? state : { ...state, phase: "dormant" };
  }
}
