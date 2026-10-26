import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { REPO_URL } from "./help-links";
import {
  Activity,
  BookOpen,
  BookText,
  CheckCheck,
  ChevronsLeft,
  CircleHelp,
  Compass,
  ExternalLink,
  Inbox,
  Info,
  Megaphone,
  ChevronRight,
  RefreshCw,
  Search,
  ShieldAlert,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  isPermissionGranted,
  onAction,
  registerActionTypes,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { LIT_WATCH_SLOT } from "./skill-slots.ts";
import ErrorBoundary from "./components/ErrorBoundary";
import CommandPalette from "./components/CommandPalette";
import { openQuickChat } from "./quick-chat-launch";
import { LAST_PROJECT_KEY, projectOfCwd, resolveStartAction } from "./start-page";
import { parseRecoverableTerminalState, TERMINAL_TABS_STORAGE_KEY } from "./terminal-tab-persistence";
import { nextUnread, sameKeys } from "./chat-unread";
import { clampRailWidth, parseRailWidth, RAIL_DEFAULT_REM, RAIL_WIDTH_KEY } from "./rail-width";
import AskAiModal from "./components/AskAiModal";
import FeedbackModal from "./components/FeedbackModal";
import {
  HelpAboutDialog,
  HelpDiagnosticsDialog,
  HelpUpdateDialog,
  type HelpDialogKind,
} from "./components/HelpDialogs";
import TopNavCapsule from "./components/TopNavCapsule";
import { ConfirmDialogHost } from "./components/ConfirmDialog";
import { HoverTip, useHoverTip } from "./components/HoverTip";
import { LoadingRows, rowActionClass } from "./components/PageFrame";
import "./App.css";
import { useAppStore, runInboxAction, visibleInboxItems } from "./store";
import { bulkReadableItems } from "./inbox";
import { groupInbox, type InboxCategory } from "./inbox";
import {
  RUN_ANNOUNCE_LINGER_MS,
  announceLabel,
  mergeAnnouncements,
  runFinished,
  type RunAnnouncement,
} from "./run-announce";
import type { RunOverviewInput } from "./run-overview";
import {
  catchupNotify,
  runDoneNotifyBody,
  runDoneNotifyTitle,
  shouldNotifyRunDone,
} from "./schedule-tasks";
import type {
  SchedulerRunDonePayload,
  SchedulerRunStartedPayload,
} from "./types";
import {
  eventMatchesCombo,
  comboLabel,
  DEFAULT_FOCUS_RAIL_HOTKEY,
  DEFAULT_NEW_CHAT_HOTKEY,
  globalHotkeyAllowed,
  PAGE_HOTKEY_DEFS,
  IS_MAC,
  IS_WINDOWS,
} from "./hotkeys";
import { NAV_ICONS } from "./navigation-icons";
import { NAV_GROUPS, NAV_BOTTOM } from "./navigation";
import { isLightTheme } from "./themes";
import ProjectTree, { TitlebarProjectChip } from "./components/ProjectTree";
import { RunActivityButton } from "./components/RunActivity";
import { shellContextPlacement, shellMode } from "./shell-context";
import RunCaret from "./components/RunCaret";
import { RailPeek, useRailPeekTrigger } from "./components/RailPeek";
import { useExitRender } from "./exit-animation";
import { normalizeNavCapsuleDelay, resolveStartupNavMode } from "./nav-capsule";
import { chromeOpacityScale } from "./chrome-opacity";
import {
  chatStyleVars,
  normalizeChatAccent,
  normalizeChatScrollbar,
} from "./chat-style";
import { macOverlayPadClass, useMacFullscreenState } from "./mac-titlebar";
import ToastHost from "./components/ToastHost";
import {
  OnboardingHost,
  OnboardingRing,
  openOnboardingGuide,
  useOnboardingRail,
} from "./components/OnboardingGuide";
import WindowControls from "./components/WindowControls";
import PhoneDropDialog from "./components/PhoneDropDialog";
import { usePhoneDropEvents, usePhoneDropStore } from "./phone-drop-store";
import { phonePendingCount } from "./phone-drop";
import { toast } from "./toast";
import { formatUiZoom, normalizeUiZoom, stepUiZoom, uiZoomKeyDirection, UI_ZOOM_DEFAULT } from "./ui-zoom";
import { isCancellationRejection } from "./diagnostics";
import { browserIdleScheduler, preloadInIdle } from "./idle-preload";

// 页面懒加载：首屏只拉当前页 chunk，其余页首次访问时才加载
const ProfilesPage = lazy(() => import("./pages/ProfilesPage"));
const McpPage = lazy(() => import("./pages/McpPage"));
const SessionsPage = lazy(() => import("./pages/SessionsPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const SkillsPage = lazy(() => import("./pages/SkillsPage"));
const StatsPage = lazy(() => import("./pages/StatsPage"));
const TerminalPage = lazy(() => import("./pages/TerminalPage"));
const WorkspacesPage = lazy(() => import("./pages/WorkspacesPage"));
const WorkbenchPage = lazy(() => import("./pages/WorkbenchPage"));
// 启动后空闲时依次先载进来的大块（idle-preload.ts）：运行页、项目页最常去，文件预览编辑器（monaco）与 PDF 阅读第一次打开最慢
const IDLE_PRELOADS = [
  () => import("./pages/TerminalPage"),
  () => import("./pages/WorkspacesPage"),
  () => import("./components/FilePreviewEditor"),
  () => import("./components/PdfContinuousView"),
];

function PageLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl px-8 py-10">
      <LoadingRows />
    </div>
  );
}

/** 展开侧栏底部平时收着、鼠标移上去才展开的页（平时只留连接、设置两个图标） */
const RAIL_MORE_PAGES: readonly string[] = ["skills", "mcp", "stats"];


/** 侧栏收起态的应用内 tooltip：展开态已有文字，不再重复弹提示。 */
function RailTooltip({
  label,
  collapsed,
  up = false,
  children,
}: {
  label: string;
  collapsed: boolean;
  /** 展开态底部图标排：没有文字，悬停常显名字、往上弹（下面是窗口底边） */
  up?: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const on = collapsed || up;
  const { tip, show, hide } = useHoverTip(ref, up && !collapsed, collapsed);
  return (
    <span
      ref={ref}
      className="block"
      onMouseEnter={on ? show : undefined}
      onMouseLeave={on ? hide : undefined}
      onFocus={on ? show : undefined}
      onBlur={on ? hide : undefined}
    >
      {children}
      {on && (
        <HoverTip tip={tip} text={label} side={collapsed} up={up && !collapsed} />
      )}
    </span>
  );
}

/** 路径末段作项目名（通知标题用；与 WorkspacesPage pathBaseName 同口径） */
function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 定时雷达运行完成的系统通知：复用通知权限申请模式（首次系统级弹窗，被拒静默跳过）。
 *  遵守「长任务 OS 通知」设置开关（notificationsEnabled），不新增设置项。 */
async function fireScheduleNotification(
  title: string,
  body: string,
  extra: Record<string, unknown>,
) {
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  if (!granted) return;
  sendNotification({ title, body, actionTypeId: "ccode.schedule", extra });
}

/** 收货反馈横幅（2026-09-17 审计）：收货成功/失败/需注意的应用内通道——OS 通知
 *  权限被拒（macOS 一次拒绝永久静默）时不再全静默；「文件名没对上号的兜底关联」
 *  「下载晚了错过 90 秒窗」在这里给出补救入口 */
type RelayToast = {
  id: number;
  kind: "ok" | "err" | "attention";
  text: string;
  detail?: string;
  /** attention 专属：一键把留在下载夹的文件收进项目（attach_paper_pdf 复制语义） */
  collect?: { projectRoot: string; path: string; title: string };
  /** 开了多篇对不上号：列出候选让人点 */
  choices?: { projectRoot: string; path: string; title: string }[];
};

function RelayToasts(props: {
  toasts: RelayToast[];
  onDismiss: (id: number) => void;
  onCollect: (t: RelayToast) => void;
}) {
  const [raised, setRaised] = useState<number | null>(null);
  if (!props.toasts.length) return null;
  const ordered =
    raised == null
      ? props.toasts
      : [
          ...props.toasts.filter((t) => t.id === raised),
          ...props.toasts.filter((t) => t.id !== raised),
        ];
  return (
    <div className="pointer-events-none fixed bottom-16 right-4 z-50 flex w-80 flex-col gap-1">
      {ordered.map((t) => {
        const actionable = Boolean(
          t.collect || (t.choices && t.choices.length > 0),
        );
        const open = actionable || raised === t.id;
        return (
          <div
            key={t.id}
            className={`pointer-events-auto rounded-md border px-3 py-1.5 text-xs leading-5 shadow-lg ${
              t.kind === "err"
                ? "border-err-text/40 bg-rail text-err-text"
                : t.kind === "attention"
                  ? "border-cta-bd bg-rail text-l2"
                  : "border-hairline bg-rail text-l2"
            }`}
            onMouseEnter={() => setRaised(t.id)}
            onMouseLeave={() => setRaised((cur) => (cur === t.id ? null : cur))}
          >
            <div className="flex items-start gap-2">
              <span
                className={`min-w-0 flex-1 ${open ? "whitespace-pre-wrap" : "truncate"}`}
              >
                {t.text}
                {open && t.detail ? (
                  <span className="block text-micro text-l4">{t.detail}</span>
                ) : null}
              </span>
              <button
                type="button"
                className="shrink-0 text-l4 hover:text-l1"
                aria-label="关闭"
                onClick={() => props.onDismiss(t.id)}
              >
                ×
              </button>
            </div>
            {open && t.choices && t.choices.length > 0 ? (
              <div className="mt-1 flex flex-col gap-1">
                {t.choices.map((c, i) => (
                  <button
                    key={`${c.title}-${i}`}
                    type="button"
                    className="rounded-sm border border-cta-bd bg-cta px-2 py-0.5 text-left text-micro text-cta-text hover:brightness-110"
                    onClick={() => props.onCollect({ ...t, collect: c })}
                  >
                    收进「{c.title.slice(0, 28)}」
                  </button>
                ))}
              </div>
            ) : open && t.collect ? (
              <button
                type="button"
                className="mt-1 rounded-sm border border-cta-bd bg-cta px-2 py-0.5 text-micro text-cta-text hover:brightness-110"
                onClick={() => props.onCollect(t)}
              >
                收进「{t.collect.title.slice(0, 24)}」
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** 页切顺序/逐页绑定/默认值的单一出处在 hotkeys.ts PAGE_HOTKEY_DEFS（与展开的侧栏顺序一致，不含「运行」） */

/** 仓库对外地址：帮助菜单外链（文档 / 安全报告）都挂在这里，转 org 时同步 */

/** 顶栏帮助菜单清单：外链（文档/安全报告，带 ↗ 标记）与应用内弹窗（反馈表单、诊断、
 *  检查更新、关于）分组混排。
 *  入口选型口径：只放「新用户第一次卡住时会找的东西」——文档、反馈、诊断、更新、关于；
 *  能装进弹窗的就地弹窗，弹窗里留去设置完整页的出口。 */
const HELP_MENU: {
  label: string;
  items: {
    icon: typeof BookOpen;
    text: string;
    url?: string;
    /** 应用内反馈表单（FeedbackModal）——不落外链也不跳设置分区 */
    feedback?: boolean;
    /** 应用内弹窗（HelpDialogs）：诊断与日志 / 检查更新 / 关于 */
    dialog?: HelpDialogKind;
    /** 上手引导清单（OnboardingGuide；收起过的会重新打开） */
    guide?: boolean;
  }[];
}[] = [
  {
    label: "使用",
    items: [
      { icon: Compass, text: "上手引导", guide: true },
      {
        icon: BookOpen,
        text: "使用教程",
        url: `${REPO_URL}/blob/main/docs/guide/tutorial.md`,
      },
      {
        icon: BookText,
        text: "产品说明书",
        url: `${REPO_URL}/blob/main/docs/guide/user-guide.md`,
      },
    ],
  },
  {
    label: "支持",
    items: [
      { icon: Megaphone, text: "反馈与提需求", feedback: true },
      { icon: ShieldAlert, text: "报告安全问题", url: `${REPO_URL}/security` },
      { icon: Activity, text: "诊断与日志", dialog: "diag" },
    ],
  },
  {
    label: "应用",
    items: [
      { icon: RefreshCw, text: "检查更新", dialog: "update" },
      { icon: Info, text: "关于 Mesa", dialog: "about" },
    ],
  },
];

function App() {
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);
  const collapsed = useAppStore((s) => s.navCollapsed);
  const cycleNavState = useAppStore((s) => s.cycleNavState);
  const chromeHidden = useAppStore((s) => s.chromeHidden);
  const exitChromeHidden = useAppStore((s) => s.exitChromeHidden);
  const toggleChromeHidden = useAppStore((s) => s.toggleChromeHidden);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { fullscreen: macFullscreen, animating: macFullscreenAnimating } =
    useMacFullscreenState(IS_MAC);
  // 收货反馈横幅（成功 8s 自动消失；失败/需注意常驻直到处理）
  const [relayToasts, setRelayToasts] = useState<RelayToast[]>([]);
  const relayToastId = useRef(0);
  const pushRelayToast = (
    t: Omit<RelayToast, "id">,
    autoDismissMs?: number,
  ) => {
    const id = ++relayToastId.current;
    setRelayToasts((cur) => {
      // 满员先挤最旧的自动消失类（ok）；attention/err 是「常驻直到处理」的补救
      // 入口，只在全是非常驻时才挤最旧一条（终检二轮：一刀切 slice 会静默丢掉
      // 带一键收进按钮的横幅）
      let next = [...cur];
      if (next.length >= 4) {
        const disposable = next.findIndex((x) => x.kind === "ok");
        if (disposable >= 0) next.splice(disposable, 1);
        else next = next.slice(-3);
      }
      return [...next, { ...t, id }];
    });
    if (autoDismissMs) {
      window.setTimeout(
        () => setRelayToasts((cur) => cur.filter((x) => x.id !== id)),
        autoDismissMs,
      );
    }
  };
  const dismissRelayToast = (id: number) =>
    setRelayToasts((cur) => cur.filter((x) => x.id !== id));
  const collectRelayToast = (t: RelayToast) => {
    if (!t.collect) return;
    const { projectRoot, path, title } = t.collect;
    void invoke<{ name: string }>("attach_paper_pdf", {
      projectRoot,
      sourcePath: path,
      title,
    })
      .then((res) => {
        pushRelayToast(
          { kind: "ok", text: `已收进 papers/：${res.name}` },
          8000,
        );
      })
      .catch((e) => {
        pushRelayToast({ kind: "err", text: "收进失败", detail: String(e) });
      });
    dismissRelayToast(t.id);
  };
  // 运行状态镜像（任意页面可见）：播报与待确认提醒用；运行计数统一走 useRunActivity（shell-context 口径）
  const terminalRunInputs = useAppStore((s) => s.terminalRunInputs);

  // 跑完了没看的对话（chat-unread.ts，2026-10-24）：这一轮做完那一刻你没在看它就记一笔，看到就消。
  // 「在看」= 在运行页、是正看着的那段、Mesa 在前台；切回前台的那一下也要再算一次
  const terminalActiveTabId = useAppStore((s) => s.terminalActiveTabId);
  const [appInFront, setAppInFront] = useState(() => document.hasFocus());
  useEffect(() => {
    // 等启动时的数据加载先过去，再趁空闲一块一块载
    let stop: (() => void) | null = null;
    const timer = window.setTimeout(() => {
      stop = preloadInIdle(IDLE_PRELOADS, browserIdleScheduler());
    }, 2000);
    return () => {
      window.clearTimeout(timer);
      stop?.();
    };
  }, []);
  useEffect(() => {
    const sync = () => setAppInFront(document.hasFocus() && document.visibilityState === "visible");
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);
  // 「启动时进入 → 上次的项目」= 最后看的那段对话所在的项目（start-page.ts）：运行页正看着的对话目录落在已添加项目里就记下
  const projectPathsForLast = useAppStore((s) => s.projectPaths);
  useEffect(() => {
    if (page !== "terminal") return;
    const cwd = terminalRunInputs.find((r) => r.tabId === terminalActiveTabId)?.cwd;
    const project = cwd ? projectOfCwd(cwd, projectPathsForLast, IS_WINDOWS) : null;
    if (!project) return;
    try {
      localStorage.setItem(LAST_PROJECT_KEY, project);
    } catch {
      /* 存不进只影响下次启动的去处 */
    }
  }, [page, terminalRunInputs, terminalActiveTabId, projectPathsForLast]);
  const unreadBeforeRef = useRef<RunOverviewInput[]>([]);
  useEffect(() => {
    const st = useAppStore.getState();
    const next = nextUnread({
      prev: st.unreadChats,
      before: unreadBeforeRef.current,
      now: terminalRunInputs,
      viewingTabId: page === "terminal" && appInFront ? terminalActiveTabId : null,
    });
    unreadBeforeRef.current = terminalRunInputs;
    if (!sameKeys(next, st.unreadChats)) st.setUnreadChats(next);
  }, [terminalRunInputs, page, terminalActiveTabId, appInFront]);

  const [islandExpanded, setIslandExpanded] = useState(false);
  /* 岛收起 / 切回有侧栏时归位。有侧栏（!chromeHidden）时岛整个不挂载，
     它卸载时的回调会把这里清成 false；这一条兜住另一个方向：切形态这一帧
     chromeHidden 先变、岛后卸载，中间会留一帧淡着的两侧。 */
  useEffect(() => {
    if (!chromeHidden) setIslandExpanded(false);
  }, [chromeHidden]);

  /* 跑完 / 跑挂播报。检测放这里而不是 TerminalPage：那边是懒挂载页，
     让一个「可能没打开过」的页面持有全应用的事件检测，等于把功能的成立条件
     押在别人身上。terminalRunInputs 是标签状态的实时镜像，跟页面可见性无关，
     谁在这读都一样，而在 App 读就与「用户此刻在哪一页」彻底解耦。

     基线 ref 存上一次的 attention/running，与 TerminalPage 里系统通知那条
     （attentionPrevRef）同构：首帧只建基线不播报，否则开机会把历史状态全报一遍。 */
  const announceEnabled = useAppStore(
    (s) => s.settings?.navCapsuleRunAnnounce !== false,
  );
  const [announcements, setAnnouncements] = useState<RunAnnouncement[]>([]);
  const runBaselineRef = useRef(new Map<string, RunOverviewInput>());
  const announceTimersRef = useRef(new Map<string, number>());
  useEffect(() => {
    const seen = runBaselineRef.current;
    const live = new Set<string>();
    const arrived: RunAnnouncement[] = [];
    for (const input of terminalRunInputs) {
      live.add(input.tabId);
      const prev = seen.get(input.tabId);
      seen.set(input.tabId, input);
      const outcome = runFinished(prev, input);
      if (!outcome) continue;
      arrived.push({
        kind: "run",
        outcome,
        label: announceLabel(input.title, input.cwd),
        tabId: input.tabId,
        count: 1,
        at: Date.now(),
      });
    }
    // 关掉的标签清掉基线，防 id 复用时沿用旧状态（同 attentionPrevRef 口径）
    for (const id of [...seen.keys()]) if (!live.has(id)) seen.delete(id);
    if (!arrived.length || !announceEnabled) return;
    setAnnouncements((cur) =>
      arrived.reduce(
        (acc, item) => mergeAnnouncements(acc, item, item.at),
        cur,
      ),
    );
  }, [terminalRunInputs, announceEnabled]);
  // 每条播报到期自清。停留时长用 run-announce 自己的常量，不跟用户的收起延时——
  // 那个档位是导航的节奏，选「立即」时会把刚出来的播报一并瞬杀掉。
  useEffect(() => {
    const timers = announceTimersRef.current;
    for (const item of announcements) {
      const key = `${item.tabId}:${item.at}`;
      if (timers.has(key)) continue;
      timers.set(
        key,
        window.setTimeout(() => {
          timers.delete(key);
          setAnnouncements((cur) =>
            cur.filter((a) => !(a.tabId === item.tabId && a.at === item.at)),
          );
        }, RUN_ANNOUNCE_LINGER_MS),
      );
    }
    for (const [key, timer] of [...timers]) {
      if (!announcements.some((a) => `${a.tabId}:${a.at}` === key)) {
        window.clearTimeout(timer);
        timers.delete(key);
      }
    }
  }, [announcements]);
  useEffect(() => {
    const timers = announceTimersRef.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);
  /* 抑制规则：岛只在收侧栏时存在（chromeHidden 由渲染门控兜住），运行页自己就在
     跑这件事、不会再需要岛报一次；窗口失焦时 OS 通知已经在喊，岛是被挡在后面的。
     只留最新一条——岛上是「刚发生了什么」，不是队列。 */
  const runAnnouncement =
    chromeHidden && page !== "terminal" && announcements.length > 0
      ? announcements[announcements.length - 1]
      : null;
  // 「待你处理」收件箱：业务条目由 WorkspacesPage 写入，应用更新由 visibleInboxItems 现算合并
  const rawInboxItems = useAppStore((s) => s.inboxItems);
  const appUpdate = useAppStore((s) => s.appUpdate);
  const inboxDismissed = useAppStore((s) => s.inboxDismissed);
  // 从手机添加：后端事件全局接一次；弹层开着时不在收件箱重复提醒
  usePhoneDropEvents((item) => {
    // 手机直接发来（不在往输入框送）：弹窗已弹出；窗口不在前台时再发一条系统通知，同「长任务 OS 通知」开关
    if (document.hasFocus()) return;
    if (!(useAppStore.getState().settings?.notificationsEnabled ?? true)) return;
    void (async () => {
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
      if (granted) sendNotification({ title: "手机发来了东西", body: item.name });
    })();
  });
  const phonePending = usePhoneDropStore((s) => (s.open ? 0 : phonePendingCount(s.items)));
  const inboxItems = visibleInboxItems(
    rawInboxItems,
    appUpdate
      ? { version: appUpdate.version, currentVersion: appUpdate.currentVersion }
      : null,
    inboxDismissed,
    phonePending,
  );
  const inboxCount = inboxItems.length;
  const contextLabel = useAppStore((s) => s.contextLabel);
  const shellPlacement = shellContextPlacement(
    shellMode(collapsed, chromeHidden),
    page,
  );
  // 侧栏宽度（rail-width.ts）：拖右边缘改、双击回默认，记本机；窗口变小时实际宽度跟着收（偏好不改）
  const rootRem = () => parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 14;
  const [railPref, setRailPref] = useState(() => parseRailWidth(localStorage.getItem(RAIL_WIDTH_KEY), rootRem()));
  const [winWidth, setWinWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setWinWidth(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const railWidth = clampRailWidth(railPref, rootRem(), winWidth);
  // 探出整栏（RailPeek）：只在图标态 / 完全隐藏时有意义，展开侧栏时一律不画
  const railRef = useRef<HTMLElement>(null);
  const railPeekOpen = useAppStore((s) => s.railPeekOpen);
  const setRailPeekOpen = useAppStore((s) => s.setRailPeekOpen);
  const peekVisible = railPeekOpen && (collapsed || chromeHidden);
  // 收起也要有动画：关掉后再挂 180ms 播退场（重开会接着从当前位置滑回来，见 RailPeek / App.css .ccode-rail-peek）
  const peekRender = useExitRender(peekVisible, 180);
  // 图标栏中段 0.12 秒（2026-10-24 用户两次「再快一点」：0.32 → 0.2 → 0.12）；完全隐藏时的左边缘留 0.32 秒——鼠标常往窗口左边甩，太快会误弹
  const peekTrigger = useRailPeekTrigger(120);
  const peekEdgeTrigger = useRailPeekTrigger(320);
  useEffect(() => {
    if (!collapsed && !chromeHidden) setRailPeekOpen(false);
  }, [collapsed, chromeHidden, setRailPeekOpen]);
  const [railDragging, setRailDragging] = useState(false);
  function startRailResize(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = railWidth;
    let last = startW;
    setRailDragging(true);
    const move = (ev: PointerEvent) => {
      last = clampRailWidth(startW + ev.clientX - startX, rootRem(), window.innerWidth);
      setRailPref(last);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      setRailDragging(false);
      try {
        localStorage.setItem(RAIL_WIDTH_KEY, String(last));
      } catch {
        /* 存不下只影响下次启动 */
      }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }
  function resetRailWidth() {
    const w = RAIL_DEFAULT_REM * rootRem();
    setRailPref(w);
    try {
      localStorage.removeItem(RAIL_WIDTH_KEY);
    } catch {
      /* 同上 */
    }
  }
  // 侧栏入口悬停里带上快捷键（跟设置页的绑定走，禁用 / 页切总开关关掉时不写）
  const keyHint = (id: string): string => {
    const combo =
      id === "new-chat"
        ? (settings?.hotkeyNewChat ?? DEFAULT_NEW_CHAT_HOTKEY)
        : settings?.hotkeyPageSwitch === false
          ? ""
          : PAGE_HOTKEY_DEFS.some((p) => p.id === id)
            ? (settings?.hotkeyPages?.[id] ?? PAGE_HOTKEY_DEFS.find((p) => p.id === id)?.combo ?? "")
            : ""; // 「运行」没有页面快捷键（2026-10-24），存过的旧覆盖值也不算
    return combo ? `（${comboLabel(combo)}）` : "";
  };
  // 侧栏「上手引导」行：引导进行中才有（进度 + 下一步，点开清单浮层）
  const onboardingRail = useOnboardingRail();
  const setOnboardingPanelOpen = useAppStore((s) => s.setOnboardingPanelOpen);
  const dismissHelpRequest = useAppStore((s) => s.dismissHelpRequest);
  const dismissInbox = useAppStore((s) => s.dismissInbox);
  const dismissInboxBulk = useAppStore((s) => s.dismissInboxBulk);
  // 类别胶囊：按 key 前缀分组（固定顺序，空类不渲染）
  const inboxGroups = groupInbox(inboxItems);
  const bulkInboxItems = bulkReadableItems(inboxItems);
  // 标题栏收件箱的展开态：当前展开的类别（Ghostty 式下拉；遮罩/Esc/再点关闭）
  const [titleInboxCat, setTitleInboxCat] = useState<InboxCategory | null>(
    null,
  );
  // 展开中的类别被清空（如最后一条 help 被忽略）时收起下拉
  useEffect(() => {
    if (
      titleInboxCat !== null &&
      !inboxGroups.some((g) => g.category === titleInboxCat)
    )
      setTitleInboxCat(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [titleInboxCat, inboxItems]);
  useEffect(() => {
    if (titleInboxCat === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTitleInboxCat(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [titleInboxCat]);
  // 顶栏帮助菜单：开关态 + Esc 关闭，关闭范式与收件箱下拉一致（遮罩在 JSX 尾部 z-20）
  const [helpOpen, setHelpOpen] = useState(false);
  // 展开侧栏底部那一排：鼠标在上面（或键盘焦点在里面）时把技能 / MCP / 用量也摆出来
  const [railBarOpen, setRailBarOpen] = useState(false);
  // 帮助菜单/关于页共用的反馈表单弹层（FeedbackModal，通道见 feedback.ts）
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // 诊断弹窗「附到反馈」带进反馈表单的诊断包路径（表单关闭即清）
  const [feedbackDiag, setFeedbackDiag] = useState<string | null>(null);
  // 帮助菜单的三个内容弹窗（HelpDialogs）：诊断与日志 / 检查更新 / 关于
  const [helpDialog, setHelpDialog] = useState<HelpDialogKind | null>(null);
  const appUpdateVersion = useAppStore((s) => s.appUpdate?.version ?? null);
  // 帮助菜单/收件箱下拉的包裹层 ref：「点外面关闭」要放行菜单与触发钮自身的按下
  const helpRootRef = useRef<HTMLDivElement | null>(null);
  const inboxRootRef = useRef<HTMLDivElement | null>(null);
  // 遮罩 z-20 盖不住标题栏自身（.ccode-titlebar z-39，点标题栏空白——含 macOS
  // 拖拽区——永远打不到遮罩，菜单不消失）。补 document 捕获阶段 mousedown：落点
  // 不在对应包裹层内即关；捕获先于拖拽区处理，按下不动它也不会误拖窗口。
  useEffect(() => {
    if (!helpOpen && titleInboxCat === null) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (helpOpen && !helpRootRef.current?.contains(t)) setHelpOpen(false);
      if (titleInboxCat !== null && !inboxRootRef.current?.contains(t))
        setTitleInboxCat(null);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [helpOpen, titleInboxCat]);
  // 菜单打开时聚焦首项（方向键立即可用）。放 effect 而不是内联 ref 回调：
  // App 重渲染会重挂 ref 回调、把焦点反复拉回首项，打断方向键导航。
  useEffect(() => {
    if (!helpOpen) return;
    helpRootRef.current
      ?.querySelector<HTMLElement>('[role="menuitem"]')
      ?.focus();
  }, [helpOpen]);
  useEffect(() => {
    if (!helpOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHelpOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [helpOpen]);
  const setSettingsSectionReq = useAppStore((s) => s.setSettingsSectionReq);
  /** 帮助菜单 → 外链（文档 / 安全报告）：关菜单再交系统浏览器打开 */
  const openHelpUrl = (url: string) => {
    setHelpOpen(false);
    openUrl(url).catch(() => toast("浏览器没打开，稍后再试", "warning"));
  };
  const loadAll = useAppStore((s) => s.loadAll);
  const loadSessions = useAppStore((s) => s.loadSessions);
  const loadProjects = useAppStore((s) => s.loadProjects);
  const loadRecentRepos = useAppStore((s) => s.loadRecentRepos);
  const loadSettings = useAppStore((s) => s.loadSettings);
  const checkAppUpdate = useAppStore((s) => s.checkAppUpdate);

  // 记录访问过的页面：懒加载的页面首次访问后才挂载，之后保持挂载（切回状态不丢、终端不断线）
  const [visited, setVisited] = useState<ReadonlySet<string>>(
    () => new Set([page]),
  );
  useEffect(() => {
    setVisited((v) => (v.has(page) ? v : new Set(v).add(page)));
  }, [page]);
  // 项目页是收件箱条目与顶栏项目上下文的唯一写入方：首屏画出后就隐藏挂上，
  // 否则停在默认首页（工作台）时「待你处理」与顶栏待处理恒空（2026-10-17 修）
  useEffect(() => {
    setVisited((v) => (v.has("workspaces") ? v : new Set(v).add("workspaces")));
  }, []);

  useEffect(() => {
    if (page !== "schedules") return;
    useAppStore.getState().setProjectSurfaceReq("schedules");
    setPage("workspaces");
  }, [page, setPage]);

  // 侧栏收展完全由用户手动控制（品牌区点击）；曾有的按页面自动收展被用户否决（v3.43）

  // 全局快捷键（设置页可自定义，存 settings.json）：新对话（默认 ⌘N）、光标移到侧栏（默认 ⌘0）、命令面板（默认 ⌘K）、
  // 隐藏/显示侧栏（默认 ⌘\）、页切逐页绑定（默认 ⌘1–⌘8，hotkeyPages 按页覆盖 + 整组总开关，顺序同展开的侧栏，没有「运行」）。
  // 空串 = 禁用；⌘F 已被终端搜索占用故不用。
  const settings = useAppStore((s) => s.settings);
  const lightChrome = isLightTheme(settings?.theme);
  // 原生窗口外观**不在这里下发**：单一写手是 store.ts 的 applyTheme（loadSettings /
  // updateSettings / 设置页切主题都会走它）。曾经这里也写一次，结果两个写手互相覆盖——
  // updateSettings 每次调 applyTheme 都会把外观刷一遍，紧接着本 effect 因 settings
  // 换引用而重跑再刷回来，表现就是调一下「侧栏 / 顶栏透明度」窗口闪一下（只有浅色模式
  // 看得出，深色模式下两个写手写的是同一个值）。
  // 开机态由 Rust setup 侧先定（settings::current_theme_is_light + set_theme），见 lib.rs。
  // 原生红绿灯不随缩放变：标题栏让位按缩放反算（mac-titlebar.ts MAC_TRAFFIC_PAD）
  useEffect(() => {
    document.documentElement.style.setProperty("--ccode-ui-zoom", String(normalizeUiZoom(settings?.uiZoom)));
  }, [settings?.uiZoom]);
  // 连按 ⌘= 时 settings 还没回来：从上一次要的值接着挪，不从旧值重算（否则连按两下只挪一档）
  const uiZoomRef = useRef<number | null>(null);
  useEffect(() => {
    uiZoomRef.current = settings?.uiZoom ?? UI_ZOOM_DEFAULT;
  }, [settings?.uiZoom]);
  const setUiZoomStep = useCallback((dir: 1 | -1) => {
    const cur = uiZoomRef.current ?? UI_ZOOM_DEFAULT;
    const next = stepUiZoom(cur, dir);
    if (next === cur) {
      toast(`界面大小已经是${dir > 0 ? "最大" : "最小"}（${formatUiZoom(next)}）`, "info", { key: "ui-zoom" });
      return;
    }
    uiZoomRef.current = next;
    const st = useAppStore.getState();
    st.updateSettings({ uiZoom: next }).catch((err) => toast(`界面大小没改成：${String(err)}`, "warning"));
    toast(`界面大小 ${formatUiZoom(next)}`, "info", {
      key: "ui-zoom",
      actions:
        next === UI_ZOOM_DEFAULT
          ? undefined
          : [
              {
                label: "恢复 100%",
                onClick: () => {
                  uiZoomRef.current = UI_ZOOM_DEFAULT;
                  void useAppStore.getState().updateSettings({ uiZoom: UI_ZOOM_DEFAULT });
                },
              },
            ],
    });
  }, []);
  const navCapsuleDelay = normalizeNavCapsuleDelay(
    settings?.navCapsuleHideDelayMs,
  );
  // 顶栏命令面板入口的键位标签：跟随设置页自定义绑定；禁用（空串）时回落默认展示
  const paletteComboLabel = comboLabel(settings?.hotkeyPalette || "mod+k");
  useEffect(() => {
    const paletteCombo = settings?.hotkeyPalette ?? "mod+k";
    const chromeCombo = settings?.hotkeyHideChrome ?? "mod+\\";
    const newChatCombo = settings?.hotkeyNewChat ?? DEFAULT_NEW_CHAT_HOTKEY;
    const focusRailCombo = settings?.hotkeyFocusRail ?? DEFAULT_FOCUS_RAIL_HOTKEY;
    const pageSwitchOn = settings?.hotkeyPageSwitch !== false;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      // ⌘,/Ctrl+, 设置：全局命令，输入框内也生效（macOS 惯例；
      // macOS 上菜单加速键先行消费，这条主要服务 Windows/Linux）
      if (eventMatchesCombo(e, "mod+,")) {
        e.preventDefault();
        setPage("settings");
        return;
      }
      const target = e.target as HTMLElement | null;
      // 新对话（默认 ⌘N）与「光标移到侧栏」（默认 ⌘0）在输入框里也生效——正写着一句时最常想开新的；
      // 只有 Windows / Linux 上焦点在终端里时让给 shell（Ctrl+N 是下一条历史，globalHotkeyAllowed）
      const allowed = globalHotkeyAllowed(Boolean(target?.closest?.(".xterm")), IS_MAC);
      if (allowed && eventMatchesCombo(e, newChatCombo)) {
        e.preventDefault();
        setPaletteOpen(false);
        void openQuickChat();
        return;
      }
      // 编辑器里 ⌘0 是「字号还原」（FilePreviewEditor 先 preventDefault），这里让给它，同界面缩放
      if (allowed && !e.defaultPrevented && eventMatchesCombo(e, focusRailCombo)) {
        e.preventDefault();
        setPaletteOpen(false);
        // 侧栏收成图标 / 完全隐藏时不改形态，把项目树探出来（2026-10-24 用户定 A+D+E）；
        // 探出层是新挂的树，等它挂上再要焦点（ProjectTree 只认挂载之后的请求）
        const st = useAppStore.getState();
        if (st.chromeHidden || st.navCollapsed) {
          st.setRailPeekOpen(true);
          requestAnimationFrame(() => useAppStore.getState().requestFocusRail());
        } else {
          st.requestFocusRail();
        }
        return;
      }
      // 界面缩放（⌘= / ⌘-）：输入框里也生效（同浏览器）。编辑器 / 图表大图自己接了这组键时
      // 会先 preventDefault（FilePreviewEditor 调字号、Mermaid 大图缩放），这里让给它们
      const zoomDir = allowed && !e.defaultPrevented ? uiZoomKeyDirection(e) : null;
      if (zoomDir) {
        e.preventDefault();
        setUiZoomStep(zoomDir);
        return;
      }
      const isEditable =
        target?.isContentEditable ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT";
      if (isEditable) return;
      if (eventMatchesCombo(e, paletteCombo)) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (paletteOpen) return;
      if (eventMatchesCombo(e, chromeCombo)) {
        e.preventDefault();
        toggleChromeHidden();
        return;
      }
      // 页切：逐页绑定（缺省回落默认 mod+1..9），冲突由设置页录制时拒绝兜底
      if (pageSwitchOn) {
        const hit = PAGE_HOTKEY_DEFS.find((p) =>
          eventMatchesCombo(e, settings?.hotkeyPages?.[p.id] ?? p.combo),
        );
        if (hit) {
          e.preventDefault();
          useAppStore.getState().goEntry(hit.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen, setPage, toggleChromeHidden, settings, setUiZoomStep]);

  // macOS 菜单栏入口（v3.259）：Rust on_menu_event 经 "menu:action" 转发，
  // 设置/命令面板/反馈与侧栏、⌘K、帮助菜单同一动作出口。Windows/Linux 无菜单栏，不挂监听。
  // listen 是异步注册：StrictMode 双挂载时若清理先于注册完成，必须补注销，
  // 否则孤儿监听 + 第二次挂载 = 每个事件触发两次（palette 这类 toggle 会被抵消）。
  useEffect(() => {
    if (!IS_MAC) return;
    let un: (() => void) | undefined;
    let cancelled = false;
    listen<string>("menu:action", (e) => {
      if (e.payload === "settings") setPage("settings");
      else if (e.payload === "new-chat") void openQuickChat();
      else if (e.payload === "palette") setPaletteOpen((v) => !v);
      else if (e.payload === "feedback") setFeedbackOpen(true);
    }).then((f) => {
      if (cancelled) f();
      else un = f;
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }, [setPage]);

  // 托盘「设为全局」被 cc-switch 挡路（三平台都有托盘）：跳连接页，由连接页弹该连接的二次确认
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    listen<{ agent: string; profileId: string | null }>("tray:set-global", (e) => {
      setPage("profiles");
      useAppStore
        .getState()
        .setTrayGlobalReq({ agent: e.payload.agent, profileId: e.payload.profileId, token: Date.now() });
    }).then((f) => {
      if (cancelled) f();
      else un = f;
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }, [setPage]);

  // 通知动作：注册「去处理」按钮类型；点击后聚焦对应终端标签（通知只有「待确认」一种），
  // 无 extra（旧通知）→ 回首页收件箱。**桌面端这是死代码**：插件桌面实现没有动作命令、
  // show() 发完即弃——按钮与 onAction 只有移动端生效（2026-09-15 核对插件源码）。
  // 桌面上点通知（无论正文还是横幅）= 仅激活窗口，跳转由下方「待确认提醒条」补位。
  const setFocusTabReq = useAppStore((s) => s.setFocusTabReq);
  useEffect(() => {
    let unregister: (() => void) | undefined;
    registerActionTypes([
      {
        id: "ccode.attention",
        actions: [{ id: "open", title: "去处理", foreground: true }],
      },
      {
        id: "ccode.schedule",
        actions: [{ id: "open", title: "去查看", foreground: true }],
      },
    ]).catch(() => {});
    onAction((notification) => {
      getCurrentWindow()
        .setFocus()
        .catch(() => {});
      const extra = (notification.extra ?? {}) as {
        tabId?: string;
        cwd?: string;
        projectRoot?: string;
        focus?: "lit" | "schedule";
      };
      void (async () => {
        if (extra.tabId) {
          setPage("terminal");
          setFocusTabReq(extra.tabId);
          return;
        }
        if (extra.projectRoot) {
          useAppStore.getState().setSelectProjectReq(extra.projectRoot);
          useAppStore.getState().setProjectFocusReq({
            projectRoot: extra.projectRoot,
            focus: extra.focus ?? "schedule",
            token: Date.now(),
          });
          setPage("workspaces");
          return;
        }
        setPage("workspaces");
      })();
    })
      .then((listener) => {
        unregister = () => listener.unregister();
      })
      .catch(() => {});
    return () => unregister?.();
  }, [setPage, setFocusTabReq]);

  // 待确认跳转提醒条（2026-09-15）：插件桌面端的通知是 fire-and-forget——没有动作按钮、
  // 正文点击也没有回调（registerActionTypes/onAction 仅移动端生效，桌面是死代码），
  // 点通知只会激活窗口。改为在窗口获得焦点瞬间检查全局标签注意力：有待确认就在
  // 右下角弹一枚可点的提醒条，点「去处理」直达对应终端标签。按待确认集合去重
  // （全部处理完才重置），避免反复聚焦被同一件事骚扰。
  const [confirmHint, setConfirmHint] = useState<{
    tabId: string;
    count: number;
  } | null>(null);
  const shownConfirmSigRef = useRef("");
  useEffect(() => {
    if (!terminalRunInputs.some((r) => r.attention === "confirm")) {
      shownConfirmSigRef.current = "";
    }
  }, [terminalRunInputs]);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let timer: number | undefined;
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused) return;
        const confirms = useAppStore
          .getState()
          .terminalRunInputs.filter((r) => r.attention === "confirm");
        if (confirms.length === 0) return;
        const sig = confirms
          .map((r) => r.tabId)
          .sort()
          .join("|");
        if (sig === shownConfirmSigRef.current) return;
        shownConfirmSigRef.current = sig;
        setConfirmHint({ tabId: confirms[0].tabId, count: confirms.length });
        window.clearTimeout(timer);
        timer = window.setTimeout(() => setConfirmHint(null), 10_000);
      })
      .then((fn) => {
        unlisten = () => fn();
      })
      .catch(() => {});
    return () => {
      unlisten?.();
      window.clearTimeout(timer);
    };
  }, []);

  // 定时雷达运行完成 → OS 通知（scheduler.rs 的 scheduler-run-done；summary 后端已脱敏）。
  // 只负责通知：工作区页 ScheduleSection 自行监听同一事件刷新列表。
  // 跑完但没有新内容不弹（2026-10-23）；被自动暂停一定弹，正文写原因。
  // 补跑开始（scheduler-run-started 且 trigger=catchup）另弹一条，说明原定时刻。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let unlistenStarted: (() => void) | undefined;
    listen<SchedulerRunDonePayload>("scheduler-run-done", (e) => {
      const enabled =
        useAppStore.getState().settings?.notificationsEnabled ?? true;
      if (!enabled || !shouldNotifyRunDone(e.payload)) return;
      void fireScheduleNotification(
        runDoneNotifyTitle(
          baseName(e.payload.projectRoot),
          e.payload.status,
          e.payload.scheduleName ||
            (e.payload.skill === LIT_WATCH_SLOT ? "文献雷达" : "定时任务"),
          Boolean(e.payload.autoPaused),
        ),
        runDoneNotifyBody(e.payload.autoPaused || e.payload.summary),
        {
          projectRoot: e.payload.projectRoot,
          scheduleId: e.payload.scheduleId,
          skill: e.payload.skill,
          focus:
            e.payload.skill === LIT_WATCH_SLOT && !e.payload.autoPaused
              ? "lit"
              : "schedule",
        },
      );
    })
      .then((u) => (unlisten = u))
      .catch(() => {});
    listen<SchedulerRunStartedPayload>("scheduler-run-started", (e) => {
      if (e.payload.trigger !== "catchup") return;
      const enabled =
        useAppStore.getState().settings?.notificationsEnabled ?? true;
      if (!enabled || !e.payload.projectRoot) return;
      const note = catchupNotify(
        e.payload.scheduleName || "定时任务",
        baseName(e.payload.projectRoot),
        e.payload.scheduledFor,
        e.payload.missed ?? 0,
      );
      void fireScheduleNotification(note.title, note.body, {
        projectRoot: e.payload.projectRoot,
        scheduleId: e.payload.scheduleId,
        focus: "schedule",
      });
    })
      .then((u) => (unlistenStarted = u))
      .catch(() => {});
    return () => {
      unlisten?.();
      unlistenStarted?.();
    };
  }, []);

  // 机构窗口「⤓ 保存 PDF 到 Mesa」→ 自动入库（inst_access 中继）。带落盘语境的
  // （从清单/雷达「窗口打开」进入）直接写进对应项目 papers/ 并登记资源；无语境的
  // 只暂存，提示回项目手动「关联本地 PDF」。反馈双通道：OS 通知（锦上添花）+
  // 应用内横幅（权限被拒时不静默，2026-09-17 审计）；失败必须可见——原文件已
  // 进回收站，用户得知道去哪儿找回
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<{
      path: string;
      size: number;
      projectRoot: string;
      fileNameHint: string;
    }>("inst-pdf-relayed", (e) => {
      const { path, projectRoot, fileNameHint } = e.payload;
      if (!projectRoot) {
        void fireScheduleNotification(
          "PDF 已在 Mesa 暂存",
          "回到项目页用「关联本地 PDF」选中导入这份文件",
          {},
        );
        pushRelayToast(
          {
            kind: "attention",
            text: "PDF 已在 Mesa 暂存",
            detail: "回到项目页用「关联本地 PDF」选中导入这份文件",
          },
          15000,
        );
        return;
      }
      void invoke<{ name: string }>("inst_save_relayed_pdf", {
        projectRoot,
        path,
        fileNameHint: fileNameHint || "paper",
      })
        .then((res) => {
          fireScheduleNotification(
            `已存进 papers/：${res.name}`,
            "文献全文已落盘并登记进项目资源",
            { projectRoot },
          );
          pushRelayToast(
            { kind: "ok", text: `已存进 papers/：${res.name}` },
            8000,
          );
        })
        .catch((err) => {
          fireScheduleNotification("PDF 入库失败", String(err), {
            projectRoot,
          });
          pushRelayToast({
            kind: "err",
            text: "PDF 入库失败",
            detail: `${String(err)}——原文件在回收站（收货通道）或下载文件夹，可用「关联本地 PDF」重新导入`,
          });
        });
    })
      .then((u) => {
        if (cancelled) {
          u();
          return;
        }
        unlisten = u;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // 收货需人知道的事：文件名没对上号的兜底关联（原件留在下载夹）、下载晚了
  // 错过 90 秒窗——横幅给「一键收进」/指引，不再零反馈（2026-09-17 审计）
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<{
      reason: string;
      path: string;
      projectRoot: string;
      title: string;
      fileName: string;
      candidates?: { title: string; projectRoot: string }[];
    }>("inst-pdf-attention", (e) => {
      const { reason, path, projectRoot, title, fileName, candidates } =
        e.payload;
      if (reason === "fallback") {
        pushRelayToast(
          {
            kind: "attention",
            text: `窗内只开了这一篇，已收进「${title.slice(0, 30)}」`,
            detail: `文件名 ${fileName} 与清单没对上号（原件保留在下载文件夹）；收错了就删掉 papers/ 里这份，再用「关联本地 PDF」按正确篇目导入`,
          },
          30000,
        );
      } else if (reason === "ambiguous") {
        const picks = (candidates ?? []).slice(0, 6);
        pushRelayToast({
          kind: "attention",
          text: `收到 ${fileName}，刚才开了多篇，挂到哪篇？`,
          detail: "文件还在下载文件夹，点一篇才收进；不对就关掉用行上「关联」",
          choices: picks.map((c) => ({
            projectRoot: c.projectRoot,
            path,
            title: c.title,
          })),
        });
      } else {
        pushRelayToast({
          kind: "attention",
          text: `下载晚了，${fileName} 没被自动收进（90 秒窗已过）`,
          detail:
            "文件还在下载文件夹；确认无误可一键收进，或到清单行用「关联本地 PDF」",
          collect: { projectRoot, path, title },
        });
      }
    })
      .then((u) => {
        if (cancelled) {
          u();
          return;
        }
        unlisten = u;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // 目标产出待验收 → OS 通知（runs.rs 的 goal-review-ready；回合结束冻结后提升待验收时发出）。
  // 交互式 CLI 交付后不退出进程，没有这个通知用户无从知道可以验收了。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{
      taskId: string;
      runId: string;
      goalName: string;
      projectRoot: string;
    }>("goal-review-ready", (e) => {
      const enabled =
        useAppStore.getState().settings?.notificationsEnabled ?? true;
      if (!enabled) return;
      void fireScheduleNotification(
        `目标「${e.payload.goalName}」的产出待验收`,
        "Agent 已完成一轮，去看看要不要写进项目",
        { projectRoot: e.payload.projectRoot, taskId: e.payload.taskId },
      );
    })
      .then((u) => (unlisten = u))
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  // 启动底色跟随主题：把「浅色与否」持久化给 index.html 首帧前的同步脚本读
  //（下次启动过渡与主题同色系，不深浅跳变；没存过值时脚本回落系统外观）。
  // settings 未载入时不写——isLightTheme(undefined) 恒 false，会把浅色用户错记成深色
  useEffect(() => {
    if (!settings) return;
    try {
      localStorage.setItem("ccodeBootTheme", lightChrome ? "light" : "dark");
    } catch {
      /* 隐私模式写不进：下次启动回落系统外观 */
    }
  }, [settings, lightChrome]);

  // 导航形态（设置页可选）：设置载入后只应用一次，之后用户手动切换不受影响。启动去处见下面 bootDataReady 之后那段
  const startPageAppliedRef = useRef(false);
  useEffect(() => {
    if (startPageAppliedRef.current || !settings) return;
    startPageAppliedRef.current = true;
    const legacyCollapsed = localStorage.getItem("ccode.navCollapsed") === "1";
    const mode = resolveStartupNavMode(
      settings.startupNavMode,
      legacyCollapsed,
    );
    const store = useAppStore.getState();
    if (mode === "hidden") {
      store.enterChromeHidden();
    } else {
      store.setNavCollapsed(mode === "collapsed");
      if (store.chromeHidden) store.exitChromeHidden();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  // 启动过渡（2026-10-16 用户拍板）：首屏数据（连接/会话/项目/最近目录/设置）就位前
  // 保持 index.html 同款字标占位，就位后应用树才挂载——工作台的项目和最近会话不再
  // 先出空列表再弹出。2.5s 硬顶：后端卡死也放行（宁可空列表，不困在过渡里）。
  // 更新检查/依赖体检不进闸（网络/外部命令不该拖长过渡）。
  const [bootDataReady, setBootDataReady] = useState(false);
  const [bootCapReached, setBootCapReached] = useState(false);
  useEffect(() => {
    const cap = setTimeout(() => setBootCapReached(true), 2500);
    return () => clearTimeout(cap);
  }, []);

  // 启动时进入（设置 → 通用，start-page.ts）：工作台 / 上次的对话 / 上次的项目 / 新对话。
  // 等首屏数据就位再定——「上次的项目」要项目列表，「新对话」要连接列表挑默认 Agent。只做一次
  const startActionAppliedRef = useRef(false);
  useEffect(() => {
    if (startActionAppliedRef.current || !settings || !(bootDataReady || bootCapReached)) return;
    startActionAppliedRef.current = true;
    const read = (key: string) => {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    };
    const store = useAppStore.getState();
    const action = resolveStartAction(settings.startPage, {
      hasLastChat: parseRecoverableTerminalState(read(TERMINAL_TABS_STORAGE_KEY)).tabs.length > 0,
      lastProjectPath: read(LAST_PROJECT_KEY),
      projectPaths: store.projectPaths,
    });
    if (action.kind === "last-chat") setPage("terminal");
    else if (action.kind === "project") {
      if (action.path) store.setSelectProjectReq(action.path);
      setPage("workspaces");
    } else if (action.kind === "new-chat") void openQuickChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, bootDataReady, bootCapReached]);

  useEffect(() => {
    // 各加载的 catch 已就地弹 toast 并把 promise 救回 resolved，allSettled 只等完成
    void Promise.allSettled([
      loadAll().catch((e) => toast(`连接加载失败：${String(e)}`, "warning")),
      loadSessions().catch((e) =>
        toast(`会话加载失败：${String(e)}`, "warning"),
      ),
      loadProjects().catch(() =>
        toast("项目列表加载失败，可稍后重试", "warning"),
      ),
      loadRecentRepos().catch(() =>
        toast("最近目录加载失败，可稍后重试", "warning"),
      ),
      // 设置（含主题）在启动时加载并应用——主题就位后应用树才亮相，无明暗闪变
      loadSettings()
        .then(() => {
          // 设置失败时不绕过原代理策略出网；修复设置后再由用户检查更新。
          checkAppUpdate().catch(() =>
            toast("应用更新检查失败，可稍后重试", "warning"),
          );
        })
        .catch((e) => toast(`设置加载失败：${String(e)}`, "warning")),
    ]).then(() => setBootDataReady(true));
    // 依赖体检（git/node/安装渠道）：缺 git 时收件箱常驻「依赖」条目；失败静默不阻塞首屏
    useAppStore.getState().refreshDepCheck();
  }, [
    loadAll,
    loadSessions,
    loadProjects,
    loadRecentRepos,
    loadSettings,
    checkAppUpdate,
  ]);

  // 前端未捕获异常上报到进程内日志缓冲（设置页「诊断」可见）；同消息 5s 去重防刷屏
  useEffect(() => {
    const last = new Map<string, number>();
    const report = (source: string, message: string) => {
      const now = Date.now();
      if (now - (last.get(message) ?? 0) < 5000) return;
      last.set(message, now);
      // 顺手淘汰 1 分钟前的旧条目，避免 Map 只增不清
      for (const [m, t] of last) {
        if (now - t > 60_000) last.delete(m);
      }
      invoke("log_event", { level: "error", source, message }).catch(() => {});
    };
    const onError = (e: ErrorEvent) => {
      report("onerror", `${e.message} @ ${e.filename}:${e.lineno}`);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      if (isCancellationRejection(e.reason)) {
        e.preventDefault();
        return;
      }
      const r = e.reason;
      report(
        "unhandledrejection",
        r instanceof Error ? (r.stack ?? r.message) : String(r),
      );
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  // 跨实例同步：窗口重新聚焦/可见时重拉配置、设置与会话（2s 节流）。
  // 双开场景（worktree 演示）里另一个实例的改动能即时反映过来。
  // 分级：聚焦只拉轻量（配置/设置/项目/最近目录）；会话列表不在这里拉——
  // 一次聚焦全量重扫九个 agent 的会话文件（10s 缓存过期时含 zstd 解压）会周期性
  // 打满 CPU、把打字卡死（2026-09-13 排查结论）。会话新鲜度由各消费方各自负责：
  //   对话页 SessionsPage 可见期 8s 轮询 + 归档/改名等操作后 loadSessions(true)；
  //   终端页 TerminalPage 会话落盘/停止时 loadSessions(true)；
  //   工作台/项目页读 store 里最近一份，不追求聚焦即时。
  // 新增会话消费方时请遵守同一约定（自己轮询或操作后强刷），不要把 loadSessions
  // 加回本 effect。
  useEffect(() => {
    let last = 0;
    const sync = () => {
      const now = Date.now();
      if (now - last < 2000) return;
      last = now;
      loadAll().catch(() => toast("配置同步失败，可稍后重试", "warning"));
      loadSettings().catch(() => toast("设置同步失败，可稍后重试", "warning"));
      loadProjects().catch(() => toast("项目同步失败，可稍后重试", "warning"));
      loadRecentRepos().catch(() =>
        toast("最近目录同步失败，可稍后重试", "warning"),
      );
    };
    const onVis = () => {
      if (document.visibilityState === "visible") sync();
    };
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [loadAll, loadProjects, loadRecentRepos, loadSettings]);

  return (
    <BootGate ready={bootDataReady || bootCapReached}>
      <ErrorBoundary>
        <div
          className="ccode-app-shell relative flex h-full flex-col overflow-hidden text-l2"
          data-nav={collapsed ? "icons" : "expanded"}
          data-chrome={lightChrome ? "light" : "dark"}
          data-nav-hidden={chromeHidden ? "true" : undefined}
          /* macOS 全屏：壳改实心底（App.css 同名规则）。全屏空间里窗口后面只剩桌面壁纸，
             材质透上来的就是整面壁纸色 */
          data-fullscreen={macFullscreen ? "true" : undefined}
          /* 进 / 出全屏的系统动画期间底色淡变，过后撤掉（换主题等不跟着慢） */
          data-fullscreen-anim={macFullscreenAnimating ? "true" : undefined}
          data-chat-accent={normalizeChatAccent(settings?.chatAccent)}
          data-chat-scrollbar={normalizeChatScrollbar(settings?.chatScrollbar)}
          /* 侧栏 / 顶栏罩色的系数。只写这一个变量，各主题的基数留在 App.css 里乘——
           深浅、图标态三套基数不同，JS 不该持有它们（见 chrome-opacity.ts）。
           值经 normalize 过：存量配置里可能是白名单外的数，直接乘会让罩色跑飞。 */
          style={
            {
              "--ccode-chrome-scale": chromeOpacityScale(
                settings?.chromeOpacity,
              ),
              ...chatStyleVars(settings ?? {}),
            } as React.CSSProperties
          }
        >
          {/* 收货反馈横幅：成功自动消失，失败/需注意常驻可处理（见 RelayToasts 注释） */}
          <RelayToasts
            toasts={relayToasts}
            onDismiss={dismissRelayToast}
            onCollect={collectRelayToast}
          />
          {/* macOS 自绘标题栏（titleBarStyle: Overlay + hiddenTitle）：纯拖拽区 +
            Ghostty 式标题栏收件箱（按类别拆胶囊，点胶囊向下展开该类明细，遮罩/Esc/再点关闭）。
            窗口标题不在界面渲染（用户拍板删除，标题字符串仍保留在 tauri 配置里供自动化定位窗口）。
            Windows 去掉原生标题栏、与 macOS 同构（自绘拖拽区 + 右侧自绘窗口按钮）；Linux 仍用原生标题栏；客户端上下文栏仍统一承载项目、运行、命令面板与收件箱。
            执行态（chromeHidden）下也必须保留这条栏：窗口态 Overlay 红绿灯靠 pl-[78px] 让位；
            全屏时系统收起三个按钮，让位取消（否则左边空一块）。整条隐藏会导致岛消失。
            顶栏横贯整窗、压在侧栏上方（原结构），高度 h-9。侧栏是圆角玻璃，顶上给红绿灯留空。
            定位上下文与层级（position: relative + z-index）由 App.css 的 .ccode-titlebar 提供：
            导航岛嵌在这条栏里绝对定位居中，栏不构成层叠上下文时岛会掉进页面内容的层级里。 */}
          <header
            data-tauri-drag-region={IS_MAC || IS_WINDOWS ? true : undefined}
            data-island={
              chromeHidden
                ? islandExpanded
                  ? "expanded"
                  : "hidden"
                : undefined
            }
            className={`ccode-titlebar flex h-9 shrink-0 items-center gap-2.5 ${
              IS_WINDOWS ? "pr-0" : "pr-3"
            } ${macOverlayPadClass(
              IS_MAC,
              macFullscreen,
              "pl-3",
            )}`}
          >
            {/* 层级：左组在岛之下（岛 z-1），岛展开时被盖住；右组 z-3 在岛之上，命令面板与收件箱
                永不被挡。两组让位由 CSS 统一处理（.ccode-titlebar[data-island=expanded] 兄弟选择器）：
                岛一展开两侧一起淡出并停止接受指针——岛压着的时候本来也点不到。 */}
            {/* 左侧「位置与活动」：同一件事每种侧栏形态只出现一处（规则与单测见 shell-context.ts）。
                展开态侧栏已有项目树（在跑的对话行尾有点），这里留空，只做拖拽区；图标态补项目芯片（不在
                项目页时）与活动芯片；全隐藏时项目芯片常驻（唯一切项目入口），活动挪进灵动岛。 */}
            <div className="ccode-titlebar-side relative flex min-w-0 shrink items-center gap-1.5">
              {shellPlacement.projectChip && (
                <TitlebarProjectChip
                  name={contextLabel?.project ?? null}
                  path={contextLabel?.projectPath ?? null}
                  onProjectPage={page === "workspaces"}
                  onSelect={(repoPath) => {
                    useAppStore.getState().setSelectProjectReq(repoPath);
                    setPage("workspaces");
                  }}
                />
              )}
              {shellPlacement.activity === "titlebar" && (
                <RunActivityButton variant="titlebar" />
              )}
            </div>
            <div className="ccode-titlebar-side relative z-3 ml-auto flex min-w-0 shrink-0 items-center gap-1.5">
              {/* 帮助：命令面板左侧常驻入口。文档/支持走外链（↗ 标记），应用内
                  目标跳设置分区；下拉结构与关闭范式对齐收件箱（Esc / 遮罩 / 再点），
                  与收件箱/命令面板互斥（同锚区三个浮层不同时开）。
                  浮层面板上的次级文字用 l3 不用 l4：l4 压在 ccode-float-surface 上
                  对比度只有 2.3–2.9:1，低于项目 3.0 底线（2026-10-12 HIG 复审）。 */}
              <div className="relative flex items-center" ref={helpRootRef}>
                <button
                  type="button"
                  onClick={() => {
                    setHelpOpen((v) => !v);
                    setTitleInboxCat(null);
                  }}
                  title="帮助"
                  aria-label="帮助"
                  aria-expanded={helpOpen}
                  aria-haspopup="menu"
                  // 只留图标（2026-10-25 用户对照 Claude 客户端：顶栏三组文字太挤），悬停写「帮助」
                  className="flex size-6 shrink-0 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1"
                >
                  <CircleHelp
                    size={14.5}
                    strokeWidth={1.8}
                    className="shrink-0"
                    aria-hidden="true"
                  />
                </button>
                {helpOpen && (
                  <div
                    role="menu"
                    aria-label="帮助菜单"
                    onKeyDown={(e) => {
                      if (
                        e.key !== "ArrowDown" &&
                        e.key !== "ArrowUp" &&
                        e.key !== "Home" &&
                        e.key !== "End"
                      )
                        return;
                      e.preventDefault();
                      const items = Array.from(
                        e.currentTarget.querySelectorAll<HTMLElement>(
                          '[role="menuitem"]',
                        ),
                      );
                      if (!items.length) return;
                      const idx = items.indexOf(
                        document.activeElement as HTMLElement,
                      );
                      const next =
                        e.key === "Home"
                          ? items[0]
                          : e.key === "End"
                            ? items[items.length - 1]
                            : e.key === "ArrowDown"
                              ? items[(idx + 1 + items.length) % items.length]
                              : items[(idx - 1 + items.length) % items.length];
                      next.focus();
                    }}
                    className="absolute right-0 top-full z-40 mt-1.5 w-64 rounded-md border border-field ccode-float-surface p-1"
                  >
                    {HELP_MENU.map((group) => (
                      <div key={group.label}>
                        <div className="px-2.5 pb-0.5 pt-1.5 text-micro text-l3">
                          {group.label}
                        </div>
                        {group.items.map((item) => (
                          <button
                            key={item.text}
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              if (item.feedback) {
                                setHelpOpen(false);
                                setFeedbackOpen(true);
                              } else if (item.guide) {
                                setHelpOpen(false);
                                openOnboardingGuide();
                              } else if (item.url) {
                                openHelpUrl(item.url);
                              } else if (item.dialog) {
                                setHelpOpen(false);
                                setHelpDialog(item.dialog);
                              }
                            }}
                            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-xs text-l2 hover:bg-hover hover:text-l1"
                          >
                            <item.icon
                              size={13}
                              strokeWidth={1.8}
                              className="shrink-0 text-l3"
                              aria-hidden="true"
                            />
                            <span className="min-w-0 flex-1">{item.text}</span>
                            {item.url && (
                              <ExternalLink
                                size={11}
                                strokeWidth={1.8}
                                className="shrink-0 text-l3"
                                aria-hidden="true"
                              />
                            )}
                            {/* 已知有新版：「检查更新」行尾直接标出版本，点开就是安装弹窗 */}
                            {item.dialog === "update" && appUpdateVersion && (
                              <span className="flex shrink-0 items-center gap-1 text-micro text-l3">
                                <span className="size-1.5 rounded-full bg-ok-text" aria-hidden="true" />
                                v{appUpdateVersion} 可更新
                              </span>
                            )}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  setHelpOpen(false);
                  setTitleInboxCat(null);
                  setPaletteOpen(true);
                }}
                title={`打开命令面板（${paletteComboLabel}）`}
                aria-label="打开命令面板"
                className="flex h-6 items-center gap-1.5 rounded-md px-2 text-micro text-l3 hover:bg-hover hover:text-l1"
              >
                <span className="font-mono">{paletteComboLabel}</span>
                <span className="hidden sm:inline">命令面板</span>
              </button>
              {inboxGroups.length > 0 && (
                <div
                  className="relative flex items-center gap-1.5"
                  ref={inboxRootRef}
                >
                  <button
                    type="button"
                    onClick={() => {
                      // 与帮助菜单互斥：同锚区两个下拉不同时开
                      setHelpOpen(false);
                      setTitleInboxCat((v) =>
                        v ? null : inboxGroups[0].category,
                      );
                    }}
                    aria-expanded={titleInboxCat !== null}
                    className="flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-micro text-l3 hover:bg-hover hover:text-l1"
                    title="待处理"
                  >
                    <Inbox
                      size={13}
                      strokeWidth={1.8}
                      className="shrink-0"
                      aria-hidden="true"
                    />
                    <span className="hidden sm:inline">待处理</span>
                    {inboxCount}
                  </button>
                  {titleInboxCat !== null && (
                    <ul className="absolute right-0 top-full z-40 mt-1.5 max-h-80 w-[360px] max-w-[80vw] space-y-2 overflow-auto rounded-md border border-field ccode-float-surface p-1">
                      {/* 计数只在不重复时出（2026-10-26 用户）：只有一类时「共 N 条」与分类小标题同数，
                          一类只一条时小标题的数字与那一行同义——都不挂；表头只剩全部已读或干脆不出 */}
                      {(inboxGroups.length > 1 || bulkInboxItems.length > 0) && (
                      <li className="flex items-center justify-between border-b border-hairline px-1.5 pb-1">
                        <span className="text-micro text-l4">
                          {inboxGroups.length > 1 ? `共 ${inboxItems.length} 条` : ""}
                        </span>
                        {bulkInboxItems.length > 0 && (
                          <button
                            type="button"
                            className="rounded-sm p-1 text-l3 hover:bg-hover hover:text-l1"
                            title="全部已读：一键收起信息类通报（文献 / 可合并 / 待核验 / 待发送 / 技能）；冲突、待确认这类要你拍板的不受影响，被收起的条目状态一变还会回来"
                            aria-label="全部已读（仅信息类）"
                            onClick={() => dismissInboxBulk(bulkInboxItems)}
                          >
                            <CheckCheck size={13} strokeWidth={1.8} aria-hidden="true" />
                          </button>
                        )}
                      </li>
                      )}
                      {inboxGroups.map((group) => (
                        <li key={group.category}>
                          <div className="px-2.5 py-1 text-micro text-l3">
                            {group.label}
                            {group.items.length > 1 && ` ${group.items.length}`}
                          </div>
                          {group.items.map((item) => (
                            <div
                              key={item.key}
                              className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-xs hover:bg-hover"
                            >
                              <span
                                className={`size-2 shrink-0 rounded-full ${item.dot}`}
                              />
                              <span className="min-w-0 flex-1 truncate text-l2">
                                {item.text}
                              </span>
                              <button
                                type="button"
                                title="忽略（状态变化后会重新出现）"
                                onClick={() =>
                                  item.key.startsWith("help:")
                                    ? dismissHelpRequest(
                                        item.key.slice("help:".length),
                                        item.dismissSignature ?? "",
                                      )
                                    : dismissInbox(item)
                                }
                                className="shrink-0 text-l4 hover:text-l1"
                              >
                                ✕
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setTitleInboxCat(null);
                                  runInboxAction(item);
                                }}
                                className={rowActionClass}
                              >
                                {item.actionLabel}
                              </button>
                            </div>
                          ))}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
            {/* Windows 去掉了原生标题栏，窗口按钮自绘在命令面板/收件箱右侧；
                不进上面的右组，岛展开时那组会淡出，窗口按钮必须始终可点。 */}
            {IS_WINDOWS && <WindowControls className="relative z-3 ml-1" />}
            {/* 导航岛嵌在标题栏内部居中：栏本身始终横贯整窗，隐藏侧栏只改内容区，
              栏宽不变，岛因此不会挪位；岛也不越出栏高，内容区不必再让位。 */}
            {chromeHidden && (
              <TopNavCapsule
                page={page}
                onPage={(p) => useAppStore.getState().goEntry(p)}
                onQuickChat={() => void openQuickChat()}
                onRestore={exitChromeHidden}
                hideDelayMs={navCapsuleDelay}
                displayMode={settings?.navCapsuleDisplayMode}
                visibleItems={settings?.navCapsuleVisibleItems}
                announcement={runAnnouncement}
                onAnnouncementClick={() => setPage("terminal")}
                onExpandedChange={setIslandExpanded}
              />
            )}
          </header>
          <div className="relative flex min-h-0 flex-1 gap-[5px] px-[5px] pb-[5px]">
            {/* 完全隐藏时窗口左边缘一条看不见的触发带：贴边停一下探出整栏（2026-10-24 用户定 A+D+E） */}
            {chromeHidden && (
              <div {...peekEdgeTrigger} aria-hidden="true" className="absolute bottom-0 left-0 top-0 z-20 w-2" />
            )}
            {peekRender.render && (
              <RailPeek
                closing={peekRender.exiting}
                // 图标态贴着图标栏右边（行容器左内边距 5 + 图标栏宽 + 间隙 5）；完全隐藏时贴窗口左边。宽度同展开侧栏
                left={chromeHidden ? 5 : 5 + (railRef.current?.offsetWidth ?? 49) + 5}
                width={railWidth}
                onClose={() => setRailPeekOpen(false)}
              >
                <div className="flex min-h-0 flex-1 flex-col">
                  <ProjectTree
                    selectedRoot={contextLabel?.projectPath ?? null}
                    active={page === "workspaces"}
                    liftCurrent
                    onSelect={(repoPath) => {
                      useAppStore.getState().setSelectProjectReq(repoPath);
                      setPage("workspaces");
                    }}
                  />
                </div>
              </RailPeek>
            )}
            {!chromeHidden && (
              <aside
                ref={railRef}
                // 展开时宽度可拖（rail-width.ts，2026-10-24）：拖着时关掉宽度过渡，不然跟手慢半拍
                style={collapsed ? undefined : { width: railWidth }}
                className={`ccode-app-rail relative flex min-h-0 shrink-0 flex-col overflow-hidden rounded-lg ${
                  railDragging ? "" : "transition-[width] duration-150"
                } ${collapsed ? "w-14" : ""}`}
              >
                {/* 品牌区 */}
                <button
                  type="button"
                  onClick={cycleNavState}
                  title={collapsed ? "展开侧栏" : "收起为图标"}
                  className={`ccode-brand-bar group mx-1.5 mt-1 flex h-[34px] shrink-0 select-none items-center rounded-md text-left transition-colors hover:bg-hover ${
                    collapsed ? "justify-center" : "px-2"
                  }`}
                >
                  <span className="ccode-brand-mark">
                    {collapsed ? "M" : "Mesa"}
                  </span>
                  {!collapsed && (
                    <ChevronsLeft
                      size={13}
                      strokeWidth={1.8}
                      className="ml-auto shrink-0 text-l3 opacity-0 transition-opacity group-hover:opacity-100"
                    />
                  )}
                </button>

                {/* 快速入口：贴品牌区（2026-10-16 用户拍板：工作台/新对话在 Mesa 下、项目标签之上；「新对话」原名「快速开聊」，2026-10-18 改） */}
                <div className="shrink-0 px-1.5 pt-1">
                  <RailTooltip label="工作台" collapsed={collapsed}>
                    <button
                      type="button"
                      onClick={() => setPage("workbench")}
                      aria-current={page === "workbench" ? "page" : undefined}
                      aria-label="工作台"
                      title={`工作台${keyHint("workbench")}`}
                      className={`relative mb-0.5 flex h-8 w-full items-center rounded-md text-sm transition-colors ${
                        collapsed ? "justify-center" : "px-2.5"
                      } ${
                        page === "workbench"
                          ? "ccode-rail-active bg-rail-sel text-l1"
                          : "text-l3 hover:bg-hover hover:text-l2"
                      }`}
                    >
                      <NAV_ICONS.workbench
                        size={16}
                        strokeWidth={1.8}
                        className={`${collapsed ? "" : "mr-2 shrink-0"} ${page === "workbench" ? "text-nav-accent" : ""}`}
                        aria-hidden="true"
                      />
                      {!collapsed && <span className="truncate">工作台</span>}
                    </button>
                  </RailTooltip>
                  <RailTooltip label="新对话" collapsed={collapsed}>
                    <button
                      type="button"
                      onClick={() => void openQuickChat()}
                      aria-label="新对话"
                      title={`新对话：直接开一段空白对话，默认在随手聊里，可在输入框下换项目${keyHint("new-chat")}`}
                      className={`relative mb-0.5 flex h-8 w-full items-center rounded-md text-sm text-l3 transition-colors hover:bg-hover hover:text-l2 ${
                        collapsed ? "justify-center" : "px-2.5"
                      }`}
                    >
                      <NAV_ICONS.quickChat
                        size={16}
                        strokeWidth={1.8}
                        className={collapsed ? "" : "mr-2 shrink-0"}
                        aria-hidden="true"
                      />
                      {!collapsed && <span className="truncate">新对话</span>}
                    </button>
                  </RailTooltip>
                  {/* 图标态的「运行」图标 2026-10-24 撤掉（用户定 A+D+E）：回到对话改走探出整栏——悬停下面那段空白或按 ⌘0，
                      项目树盖在内容上滑出来；在跑的看顶栏活动芯片 */}
                  {/* 「搜对话」（2026-10-23 侧栏挂对话第一期，原「全部对话」）：日常找对话在下面项目树里，
                      对话页管跨项目搜索与整理（归档、导出），点进去光标直接在搜索框 */}
                  <RailTooltip label="搜对话" collapsed={collapsed}>
                    <button
                      type="button"
                      onClick={() => useAppStore.getState().goEntry("sessions")}
                      aria-current={page === "sessions" ? "page" : undefined}
                      aria-label="搜对话"
                      title={`搜对话：在所有项目的对话里找，也在那里归档、导出${keyHint("sessions")}`}
                      className={`relative mb-0.5 flex h-8 w-full items-center rounded-md text-sm transition-colors ${
                        collapsed ? "justify-center" : "px-2.5"
                      } ${
                        page === "sessions"
                          ? "ccode-rail-active bg-rail-sel text-l1"
                          : "text-l3 hover:bg-hover hover:text-l2"
                      }`}
                    >
                      <Search
                        size={16}
                        strokeWidth={1.8}
                        className={`${collapsed ? "" : "mr-2 shrink-0"} ${page === "sessions" ? "text-nav-accent" : ""}`}
                        aria-hidden="true"
                      />
                      {!collapsed && <span className="truncate">搜对话</span>}
                    </button>
                  </RailTooltip>
                  {/* 图标态：项目树不可见，文件夹与其他图标一样只管「去项目页」；
                      切换项目统一交给顶栏项目芯片（图标态下常驻，规则见 shell-context.ts） */}
                  {collapsed && (
                    <RailTooltip
                      label={
                        contextLabel?.project
                          ? `项目 · ${contextLabel.project}`
                          : "项目"
                      }
                      collapsed={collapsed}
                    >
                      <button
                        type="button"
                        onClick={() => setPage("workspaces")}
                        aria-current={page === "workspaces" ? "page" : undefined}
                        aria-label="项目"
                        className={`relative mb-0.5 flex h-8 w-full items-center justify-center rounded-md transition-colors ${
                          page === "workspaces"
                            ? "ccode-rail-active bg-rail-sel text-l1"
                            : "text-l3 hover:bg-hover hover:text-l2"
                        }`}
                      >
                        <NAV_ICONS.workspaces
                          size={16}
                          strokeWidth={1.8}
                          aria-hidden="true"
                          className={page === "workspaces" ? "text-nav-accent" : ""}
                        />
                      </button>
                    </RailTooltip>
                  )}
                </div>

                {/* 项目区（展开态）：「项目」标签在搜索框上面，列表/搜索/右键管理都在 ProjectTree；
                    flex 列容器让树拿到受限高度，课题多时在树内滚动而不是被侧栏裁掉 */}
                {!collapsed && (
                  <div className="flex min-h-0 flex-1 flex-col pt-1.5">
                    <ProjectTree
                      selectedRoot={contextLabel?.projectPath ?? null}
                      active={page === "workspaces"}
                      onSelect={(repoPath) => {
                        useAppStore.getState().setSelectProjectReq(repoPath);
                        setPage("workspaces");
                      }}
                    />
                  </div>
                )}
                {/* 图标态中段空白 = 探出整栏的触发区（悬停停一下）；探出层画在下面那一行容器里 */}
                {collapsed && <div {...peekTrigger} className="min-h-0 flex-1" />}

                {/* 上手引导（新装才有，做完 / 收起即消失）：贴在系统段上方，进度环 + 下一步，
                    点开清单浮层向右展开（OnboardingGuide 按 data-onboarding-anchor 定位） */}
                {onboardingRail && (
                  <div className="shrink-0 px-1.5 pb-1.5">
                    <RailTooltip
                      label={`上手引导 ${onboardingRail.done}/${onboardingRail.total}${
                        onboardingRail.next ? ` · 下一步：${onboardingRail.phase} · ${onboardingRail.next}` : ""
                      }`}
                      collapsed={collapsed}
                    >
                      <button
                        type="button"
                        data-onboarding-anchor
                        onClick={() => setOnboardingPanelOpen(!onboardingRail.open)}
                        aria-expanded={onboardingRail.open}
                        aria-label="上手引导"
                        className={`relative flex w-full items-center rounded-md text-left transition-colors ${
                          collapsed ? "h-8 justify-center" : "gap-2 px-2.5 py-1.5"
                        } ${
                          onboardingRail.open
                            ? "bg-rail-sel text-l1"
                            : "text-l2 hover:bg-hover hover:text-l1"
                        }`}
                      >
                        {/* 环比原先大一号（同清单头的大环），收成图标时也好认 */}
                        <OnboardingRing
                          done={onboardingRail.done}
                          total={onboardingRail.total}
                          size={20}
                        />
                        {!collapsed && (
                          <span className="min-w-0 flex-1">
                            <span className="flex items-baseline justify-between gap-2 text-sm">
                              <span className="truncate">上手引导</span>
                              <span className="shrink-0 text-micro tabular-nums text-l3">
                                {onboardingRail.done}/{onboardingRail.total}
                              </span>
                            </span>
                            {onboardingRail.next && (
                              <span className="block truncate text-micro text-l3">
                                下一步：{onboardingRail.next}
                              </span>
                            )}
                          </span>
                        )}
                      </button>
                    </RailTooltip>
                  </div>
                )}

                {/* 资源与管理段：连接/技能/MCP/用量/设置（对话已归上面的工作入口）。
                    展开态平时只留连接、设置两个图标 + 一个 ›（2026-10-25 用户对照 Claude 客户端：五个没字的图标只能靠猜）；
                    鼠标移到这一排上（或键盘 Tab 进来）技能 / MCP / 用量从 › 的位置向右滑出、一个接一个淡入，移开收回
                    （同日用户：点 ⋯ 再选太麻烦；⋯ 读作「更多菜单」，换成往右指的 ›，说明是往这边展开；动画别直接出现）。
                    连接、设置位置不动，展开时光标底下的图标不跳；正在这三页之一时一直展开，选中的那个看得见。
                    悬停出名字。图标态侧栏照旧竖排五个 */}
                {(() => {
                  const all = [...NAV_GROUPS.find((g) => g.label === "资源")!.items, ...NAV_BOTTOM];
                  const barOpen = railBarOpen || RAIL_MORE_PAGES.includes(page);
                  const railIcon = (n: (typeof all)[number], extra?: { index: number }) => (
                    <RailTooltip key={n.id} label={n.label} collapsed={collapsed} up={!collapsed}>
                      <button
                        type="button"
                        onClick={() => setPage(n.id)}
                        aria-current={page === n.id ? "page" : undefined}
                        aria-label={n.label}
                        // 收着时滑出来的三个不进键盘顺序（Tab 到「连接」时整排已经展开）
                        tabIndex={extra && !barOpen ? -1 : undefined}
                        style={extra ? { transitionDelay: barOpen ? `${40 + extra.index * 35}ms` : "0ms" } : undefined}
                        className={`relative flex h-8 shrink-0 items-center justify-center rounded-md ${
                          extra
                            ? `ccode-rail-drawer-item transition-[opacity,translate,background-color,color] duration-200 ${
                                barOpen ? "translate-x-0 opacity-100" : "-translate-x-1.5 opacity-0"
                              }`
                            : "transition-colors"
                        } ${collapsed ? "mb-0.5 w-11" : "w-9"} ${
                          page === n.id
                            ? `${collapsed ? "ccode-rail-active" : "ccode-rail-active-under"} bg-rail-sel text-l1`
                            : "text-l3 hover:bg-hover hover:text-l2"
                        }`}
                      >
                        <n.Icon
                          size={16}
                          strokeWidth={1.8}
                          className={page === n.id ? "text-nav-accent" : ""}
                          aria-hidden="true"
                        />
                      </button>
                    </RailTooltip>
                  );
                  if (collapsed) {
                    return (
                      <div className="shrink-0 border-t border-white/5 px-1.5 py-2">{all.map((n) => railIcon(n))}</div>
                    );
                  }
                  const extras = all.filter((n) => RAIL_MORE_PAGES.includes(n.id));
                  return (
                    <div
                      onMouseEnter={() => setRailBarOpen(true)}
                      onMouseLeave={() => setRailBarOpen(false)}
                      onFocus={() => setRailBarOpen(true)}
                      onBlur={(e) => {
                        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setRailBarOpen(false);
                      }}
                      className="flex shrink-0 items-center gap-0.5 border-t border-white/5 px-1.5 py-2"
                    >
                      {all.filter((n) => !RAIL_MORE_PAGES.includes(n.id)).map((n) => railIcon(n))}
                      {/* 抽屉：› 与三个图标叠在同一处，宽度从一个 › 的宽度滑到三个图标的宽度 */}
                      <div
                        className={`ccode-rail-drawer relative flex items-center gap-0.5 overflow-hidden transition-[max-width] duration-200 ${
                          barOpen ? "max-w-[7rem]" : "max-w-9"
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className={`ccode-rail-drawer-item pointer-events-none absolute left-0 top-0 flex h-8 w-9 items-center justify-center text-l4 transition-[opacity,translate] duration-150 ${
                            barOpen ? "translate-x-1.5 opacity-0" : "translate-x-0 opacity-100"
                          }`}
                        >
                          <ChevronRight size={15} strokeWidth={1.8} />
                        </span>
                        {extras.map((n, index) => railIcon(n, { index }))}
                      </div>
                    </div>
                  );
                })()}
                {/* 右边缘拖动改宽、双击回默认（只在展开时有） */}
                {!collapsed && (
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="拖动改侧栏宽度，双击回默认"
                    title="拖动改侧栏宽度，双击回默认"
                    onPointerDown={startRailResize}
                    onDoubleClick={resetRailWidth}
                    className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize transition-colors hover:bg-hairline"
                  />
                )}
              </aside>
            )}
            {titleInboxCat !== null && (
              <div
                className="fixed inset-0 z-20"
                onClick={() => setTitleInboxCat(null)}
              />
            )}
            {helpOpen && (
              <div
                className="fixed inset-0 z-20"
                onClick={() => setHelpOpen(false)}
              />
            )}
            <main className="ccode-app-main min-h-0 min-w-0 flex-1">
              {/* 页面保持挂载，切换标签不销毁终端；未访问过的页不挂载（懒加载）。
                  工作台=概览、项目=选中课题详情（选中经 selectProjectReq 一次性请求，
                  由项目页消费选分组，与收件箱/对话页跳转同一条链） */}
              <div
                className={
                  page === "workbench" ? "h-full overflow-auto" : "hidden"
                }
              >
                {visited.has("workbench") && (
                  <Suspense fallback={<PageLoading />}>
                    <WorkbenchPage visible={page === "workbench"} />
                  </Suspense>
                )}
              </div>
              <div className={page === "workspaces" ? "h-full" : "hidden"}>
                {visited.has("workspaces") && (
                  <Suspense fallback={<PageLoading />}>
                    <WorkspacesPage visible={page === "workspaces"} />
                  </Suspense>
                )}
              </div>
              <div
                className={
                  page === "profiles" ? "h-full overflow-auto" : "hidden"
                }
              >
                {visited.has("profiles") && (
                  <Suspense fallback={<PageLoading />}>
                    <ProfilesPage visible={page === "profiles"} />
                  </Suspense>
                )}
              </div>
              <div className={page === "terminal" ? "h-full" : "hidden"}>
                {visited.has("terminal") && (
                  <Suspense fallback={<PageLoading />}>
                    <TerminalPage visible={page === "terminal"} />
                  </Suspense>
                )}
              </div>
              <div className={page === "sessions" ? "h-full" : "hidden"}>
                {visited.has("sessions") && (
                  <Suspense fallback={<PageLoading />}>
                    <SessionsPage visible={page === "sessions"} />
                  </Suspense>
                )}
              </div>
              <div className={page === "skills" ? "h-full" : "hidden"}>
                {visited.has("skills") && (
                  <Suspense fallback={<PageLoading />}>
                    <SkillsPage visible={page === "skills"} />
                  </Suspense>
                )}
              </div>
              <div
                className={page === "mcp" ? "h-full overflow-auto" : "hidden"}
              >
                {visited.has("mcp") && (
                  <Suspense fallback={<PageLoading />}>
                    <McpPage visible={page === "mcp"} />
                  </Suspense>
                )}
              </div>
              <div
                className={page === "stats" ? "h-full overflow-auto" : "hidden"}
              >
                {visited.has("stats") && (
                  <Suspense fallback={<PageLoading />}>
                    <StatsPage visible={page === "stats"} />
                  </Suspense>
                )}
              </div>
              <div
                className={
                  page === "settings" ? "h-full overflow-auto" : "hidden"
                }
              >
                {visited.has("settings") && (
                  <Suspense fallback={<PageLoading />}>
                    <SettingsPage visible={page === "settings"} />
                  </Suspense>
                )}
              </div>
            </main>
          </div>
          {paletteOpen && (
            <CommandPalette
              onClose={() => setPaletteOpen(false)}
              onQuickChat={() => void openQuickChat()}
              onHelp={(target) => {
                if (target === "feedback") setFeedbackOpen(true);
                else setHelpDialog(target);
              }}
            />
          )}
          <PhoneDropDialog />
          <FeedbackModal
            open={feedbackOpen}
            attachDiagnostics={feedbackDiag}
            onClose={() => {
              setFeedbackOpen(false);
              setFeedbackDiag(null);
            }}
          />
          <HelpDiagnosticsDialog
            open={helpDialog === "diag"}
            onClose={() => setHelpDialog(null)}
            onOpenFull={() => {
              setHelpDialog(null);
              setSettingsSectionReq("diag");
              setPage("settings");
            }}
            onAttachToFeedback={(path) => {
              setHelpDialog(null);
              setFeedbackDiag(path);
              setFeedbackOpen(true);
            }}
          />
          <HelpUpdateDialog
            open={helpDialog === "update"}
            onClose={() => setHelpDialog(null)}
          />
          <HelpAboutDialog
            open={helpDialog === "about"}
            onClose={() => setHelpDialog(null)}
            onFeedback={() => {
              setHelpDialog(null);
              setFeedbackOpen(true);
            }}
            onCheckUpdate={() => setHelpDialog("update")}
          />
          <AskAiModal />
          {/* 全局确认框宿主（confirmDialog）：z-70，压过一切覆盖层 */}
          <ConfirmDialogHost />
          {/* 上手引导：首次判定、欢迎页、清单浮层、每做完一步的「下一步」提示 */}
          <OnboardingHost ready={bootDataReady} />
          <ToastHost />
          {/* 待确认跳转提醒条：通知正文点击无回调（桌面插件限制）的补位——
            窗口激活时有待确认就出现在右下角，点「去处理」直达终端标签 */}
          {confirmHint && (
            <div className="pointer-events-none fixed bottom-5 right-5 z-100 flex flex-col items-end">
              <div className="pointer-events-auto flex items-center gap-2.5 rounded-lg border border-field bg-raised px-3.5 py-2.5 shadow-lg">
                {/* 等确认的琥珀光标放在最前（原先是一颗闪的黄点）：夹在句子中间读成破折号 */}
                <RunCaret state="confirm" decorative />
                <button
                  type="button"
                  className="min-w-0 text-left text-sm text-l1 hover:text-cta"
                  onClick={() => {
                    setPage("terminal");
                    setFocusTabReq(confirmHint.tabId);
                    setConfirmHint(null);
                  }}
                >
                  {confirmHint.count > 1
                    ? `${confirmHint.count} 个 Agent 在等确认`
                    : "Agent 在等确认"}
                  <span className="ml-1.5 text-micro text-l4">点此去处理</span>
                </button>
                <button
                  type="button"
                  aria-label="关闭提醒"
                  className="ml-1 shrink-0 rounded px-1 text-l4 hover:bg-hover hover:text-l1"
                  onClick={() => setConfirmHint(null)}
                >
                  ×
                </button>
              </div>
            </div>
          )}
        </div>
      </ErrorBoundary>
    </BootGate>
  );
}

/** 启动过渡闸（2026-10-16 用户拍板）：首屏数据未就位时渲染与 index.html 相同的
 *  字标占位——同 class 让 html:has 选择器仍走实心底，与 pre-React 占位无缝衔接；
 *  就位/硬顶后才挂载应用树，工作台的项目与最近会话直接满屏出现，不再先空后弹。
 *  换手时字标留一层 .boot-handoff 盖在应用上淡出，与应用淡入叠在一起（2026-10-23）。 */
function BootGate({
  ready,
  children,
}: {
  ready: boolean;
  children: React.ReactNode;
}) {
  if (ready)
    return (
      <>
        {children}
        <BootHandoff />
      </>
    );
  return <BootMark />;
}

// 与 index.html 的 boot-show（0.2s 延迟）/ boot-blink（1.1s 周期）同步改
const BOOT_SHOW_DELAY_MS = 200;
const BOOT_BLINK_MS = 1100;

/** 字标 Mesa + 琥珀光标。HTML 占位的动画从文档开始算起，React 换上的这一份用负
 *  animation-delay 接着它的进度走：淡入没到点就照样等、到了就停在显示态，光标接同一相位。
 *  挂载时刻只取一次——重渲染再改 delay 不会重启动画，只会让进度跳一截。 */
function BootMark() {
  const [now] = useState(() => performance.now());
  return (
    <div
      className="boot-splash"
      style={{ animationDelay: `${BOOT_SHOW_DELAY_MS - now}ms` }}
    >
      <span>
        Mesa
        <i
          className="boot-caret"
          style={{ animationDelay: `${-(now % BOOT_BLINK_MS)}ms` }}
        />
      </span>
    </div>
  );
}

/** 换手层：只活一次淡出的时间，不接点击；用计时器卸载而不是 animationend——
 *  后者遇到动画被关掉就永远等不到，字会一直压在应用上。 */
function BootHandoff() {
  const [done, setDone] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDone(true), 400);
    return () => clearTimeout(t);
  }, []);
  if (done) return null;
  return (
    <div className="boot-handoff" aria-hidden="true">
      <BootMark />
    </div>
  );
}

export default App;
