import { loginScreenLabel, runBlocker, type RunBlocker } from "../run-blocker";
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";
import { sessionRuntimeKey, useAppStore, type PendingTerminal } from "../store";
import type { ProjectSurfaceTab } from "../project-surface";
import {
  DEFAULT_TOGGLE_SURFACE_HOTKEY,
  IS_MAC,
  IS_WINDOWS,
  closeChatCombo,
  comboLabel,
  eventMatchesCombo,
} from "../hotkeys";
import type { TerminalProgress } from "../terminal-notify";
import { forkChatMessages, forkPreviewCovered, sessionModeTier } from "../chat-handoff";
import { recordChatHandoff, switchState } from "../chat-handoff-log";
import { currentVerifiedVersion } from "../cli-verified";
import { chatFidelity, tierLabel, versionTrust } from "../chat-fidelity";
import {
  MISMATCH_EVENT,
  MISMATCH_TEMPLATE,
  mismatchSnapshot,
  mismatchTitle,
  type MismatchFrom,
  type MismatchReport,
} from "../chat-mismatch";
import { AGENTS } from "../types";
import { channelSourceNote, channelTurnOpen, type ChannelReplyDecision } from "../chat-channel";
import { normSep, pathWithin as pathWithinDialect, samePath, stripVerbatim } from "../path-utils";
import { cwdIsCodingWorktree } from "../coding-git";
import { loadCodingOverview } from "../components/CodingProjectView";
import { normalizeWorkMode } from "../work-mode";
import { confirmDialog, alertDialog, confirmDialogOpen } from "../components/ConfirmDialog";
import { markCoachTipSeen } from "../coach-tips";
import { noteMouseCloseChat, noteMouseToggleSurface } from "../components/shortcut-nudges";
import ContextMenu from "../components/ContextMenu";
import { isBlankChatTab, isThrowawayTab } from "../quick-chat";
import FileTree, { type DirEntryDto } from "../components/FileTree";
import GitPanel, { type GitSummary } from "../components/GitPanel";
import { LoadingRows, hoverRevealClass } from "../components/PageFrame";
import WorkspaceReviewView from "../components/WorkspaceReviewView";
import ReaderOverlay from "../components/ReaderOverlay";
import { buildWorkspaceTerminalRequest } from "../pipeline-start";
import type { SpotCheckSession } from "../spot-check";
import { formatPdfExcerptPrompt, readerReuseKey, readerSessionFor } from "../reader";
import { READER_BINDING_SLOT, taskBindingLaunch } from "../project-agents";
import { defaultCommitMessage } from "../git-commit-message";
import { pickResumeProfile, skipDisconnectedOfficial } from "../resume-profile";
import {
  findResumeHolderTab,
  resolveResumeLaunch,
  resumeProfileChoice,
  shouldRelaunchResumeTab,
} from "../terminal-resume";
import { toast } from "../toast";
import { CROSS_REVIEW_KEY_PREFIX, crossReviewDoneText } from "../cross-review";
import type { ChecksDto } from "../research-checks";
import { EXITED_GRACE_MS, exitedCollectPass, idleStopPass, isExitedAgentTab } from "../idle-stop";
import { closeAsksFirst } from "../run-caret";
import { runLayout } from "../run-layout";
import { sidebarChatTitle } from "../sidebar-chats";
import { tidySessionTitle } from "../session-title";
import { lastContextTokens, type MesaCommand } from "../composer-assist";
import { allLanesDone, FANOUT_EXPIRE_MS, FANOUT_STORAGE_PREFIX, lanesToHeal, type FanOutPending } from "../fan-out";
import { openTerminalInTurn } from "../terminal-queue";
import { slashCommandsFor } from "../slash-commands";
import { organizePdfExcerpt as organizePdfExcerptShared } from "../pdf-organize";
import { isPreviewableImagePath } from "../file-icons";
import { DEFAULT_THEME_ID } from "../themes";
import { runtimeModelSwitch } from "../model-switch";
import {
  Columns2,
  Eye,
  EyeOff,
  FolderTree,
  PanelTopOpen,
  RefreshCw,
  Search,
  Sparkles,
  FileDiff,
  MoreHorizontal,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import {
  attentionTransition,
  debounceAllows,
  NOTIFY_BODY,
  notifyTitle,
} from "../notify";
import {
  parseRecoverableTerminalState,
  serializeRecoverableTerminalState,
  TERMINAL_TABS_STORAGE_KEY,
} from "../terminal-tab-persistence";
import { launchSurface, openSurfaceDefault } from "../tab-surface";
import { tabRunInput, type RunOverviewInput } from "../run-overview";
import type {
  ChatMessageDto,
  CodingOpDto,
  CodingOverviewDto,
  ConversationPageDto,
  GitCommitResultDto,
  HandoffTargetDto,
  ProjectDto,
  RunDto,
  WorkspaceDto,
  WorkspaceHealthDto,
  SurfaceMode,
} from "../types";
import type { PdfActionResult } from "../components/PdfPreview";
import {
  TerminalView,
  agentLabel,
  basename,
  buildXtermTheme,
  CHAT_PEEK_RATIO,
  clampSplitPct,
  DocxPreview,
  FilePreviewEditor,
  FILES_PREVIEW_MIN_WIDTH,
  FILES_SPLIT_KEY,
  FILES_TREE_DEFAULT_WIDTH,
  FILES_TREE_MIN_WIDTH,
  FILES_TREE_WIDTH_KEY,
  fireAttentionNotification,
  ImagePreview,
  offerAddLitProject,
  pathWithin,
  PdfContinuousView,
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_WIDTH_KEY,
  SPLIT_PCT_KEY,
  StableChatSurface,
  StableTerminalStatusBar,
  UnsupportedPreview,
  XlsxPreview,
} from "./TerminalView";
import type {
  FilesView,
  FocusTabActions,
  NativePermissionMode,
  RightTab,
  SessionLinkState,
  TabLaunchPatch,
  TabStatus,
} from "./TerminalView";
export type {
  CliPermissionNote,
  ConnIssueState,
  FocusTabActions,
  LaunchPickState,
  NativePermissionMode,
  RelayPickState,
  SessionLinkState,
  TabLaunchPatch,
  TabStatus,
} from "./TerminalView";

interface Tab {
  id: string;
  /** 兜底空标签：不继承「上次启动」记录（关闭最后标签时使用） */
  skipSeed?: boolean;
  /** 从工作树「在此打开」/ 工作区创建时预填的启动目录 */
  initialCwd?: string;
  /** 工作区交接的附加 env（端口段） */
  initialExtraEnv?: Record<string, string>;
  /** 工作区交接的标签标题（工作区名 / run: 脚本名） */
  initialTitle?: string;
  /** 预填启动栏（会话恢复 / 工作区记住配置） */
  initialAgentId?: string;
  initialProfileId?: string;
  initialModel?: string;
  /** 会话恢复：pty_spawn 的 resumeSessionId */
  resumeSessionId?: string;
  /** 原生分叉的原会话（pty_spawn 的 forkSessionId）：第一次启动把它整段复制成新会话，launch 成功即清掉，不进持久化白名单 */
  forkSessionId?: string;
  /** 会话恢复：rollout 记下的 provider */
  resumeProvider?: string;
  /** 首次可见自动启动（会话恢复） */
  autoStart?: boolean;
  /** 已有 resume 标签但进程不在时，再点「继续」递增以重试启动 */
  resumeKick?: number;
  /** run 脚本：进入 shell 后立即写入的命令行 */
  prefillCommand?: string;
  /** run 脚本标签：自动开 shell 执行 prefillCommand */
  shellOnly?: boolean;
  /** 直接启动 Custom Runtime，不经过 shell */
  customRuntimeId?: string;
  /** 一键开步预填的首条指令（启动时注入，一次性；不进重启持久化白名单） */
  initialPrompt?: string;
  /** 「聊想法」只读模式标签：pty_spawn 注入只读/计划模式参数（不进持久化白名单） */
  readonly?: boolean;
  permission?: "discuss" | "write_tree";
  /** 只讨论是约定、不是这段对话的一档权限（2026-10-26）：目标不验收的「只讨论」、任务卡「聊想法」、MCP 登录。
      这类对话没有验收环，计划模式写完方案时方案卡不给开工、标签也不离开只讨论（要动手回项目页走开工 / 把目标改成可写）。
      仅内存标记，不进重启持久化白名单 */
  discussOnly?: boolean;
  /** 聊天权限徽标选的原生权限档（不进持久化白名单：完全访问不该跨重启自动带上）；null = 按本机设置 */
  permissionMode?: NativePermissionMode | null;
  /** 开工弹层的本次思考档覆盖（不进持久化白名单）：launch 经 pty_spawn
      effortOverride 注入；空 = 绑定逐模型策略/端点默认 */
  effort?: string | null;
  /** 分叉来源，仅用于解除只读时提示原会话是否仍在运行。 */
  forkSource?: { agent: string; sessionId: string };
  /** 应用重启后恢复出的元数据占位标签。 */
  restored?: boolean;
  /** 复用键（pendingTerminal.reuseKey 透传）：同 key 的重复开聊请求切换到本标签。
      仅内存标记，不进重启持久化白名单（恢复出的占位标签不参与复用——会话已断，新开更诚实） */
  reuseKey?: string;
  /** 步骤认领（pendingTerminal.stepName 透传）：launch 时以最终 agent/cwd 登记，
      让该标签产出的会话归到该步骤。仅内存标记，不进重启持久化白名单 */
  stepName?: string;
  runId?: string;
  taskId?: string;
  /** 递增则把已挂载标签的启动栏改成 initialAgent/Profile/Model（见 TerminalView） */
  launchSeed?: number;
  /** 列表里点开、只看没接的对话（pendingTerminal.resumeLazy）：发第一句前离开就收掉（isThrowawayTab）。
      仅内存标记，不进重启持久化白名单 */
  preview?: boolean;
}

export default function TerminalPage({ visible }: { visible: boolean }) {
  const setPage = useAppStore((s) => s.setPage);
  const liveSessions = useAppStore((s) => s.liveSessions);
  /** 对话头写标题用（与侧栏同一份会话列表） */
  const headSessions = useAppStore((s) => s.sessions);
  const [initialState] = useState(() => {
    const saved = parseRecoverableTerminalState(
      localStorage.getItem(TERMINAL_TABS_STORAGE_KEY),
    );
    if (saved.tabs.length === 0) {
      const tab: Tab = { id: crypto.randomUUID() };
      return { tabs: [tab], activeId: tab.id };
    }
    const restoredTabs: Tab[] = saved.tabs.map((tab) => ({
      id: tab.id ?? crypto.randomUUID(),
      initialCwd: tab.cwd,
      initialTitle: tab.label,
      initialProfileId: tab.profileId,
      initialModel: tab.model,
      initialAgentId: tab.customRuntimeId ? "custom" : tab.agentId,
      customRuntimeId: tab.customRuntimeId ?? undefined,
      // 原生分叉一句没发就关了 / 重启了：新会话还不存在，重启后再分一次（接它只会退回开一段没上下文的新对话）
      resumeSessionId: tab.customRuntimeId || tab.forkPending ? undefined : tab.sessionId ?? undefined,
      forkSessionId: tab.forkPending && tab.forkOf ? tab.forkOf : undefined,
      forkSource: tab.forkOf ? { agent: tab.agentId, sessionId: tab.forkOf } : undefined,
      runId: tab.runId ?? undefined,
      taskId: tab.taskId ?? undefined,
      reuseKey: tab.reuseKey ?? undefined,
      restored: true,
    }));
    return {
      tabs: restoredTabs,
      activeId: restoredTabs[saved.activeIndex]?.id ?? restoredTabs[0].id,
    };
  });
  const [tabs, setTabs] = useState<Tab[]>(initialState.tabs);
  const [activeId, setActiveId] = useState(initialState.activeId);
  // 启动时清一次孤儿回放：崩溃/强退残留的 replay-* 只保留本次恢复的标签，
  // 否则目录随历史标签无限堆积（2026-10-10 修；正常运行中关标签即 drop，不靠这里）
  useEffect(() => {
    void invoke("prune_terminal_replays", {
      tabIds: initialState.tabs.map((t) => t.id),
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 终端上报的任务进度（OSC 9;4，kimi/grok/codebuddy 发）→ 标签条小徽章 */
  const [tabProgress, setTabProgress] = useState<
    Record<string, TerminalProgress | null>
  >({});
  // 下面三个传给 TerminalView 的回调必须引用稳定：内联箭头每渲染换引用会击穿
  // memo(TerminalView)，kimi 的 1Hz 进度帧把全部终端标签拖着重渲染
  //（2026-10-11 三轮审查）。值判重：state/progress 都没变不落新对象。
  const handleTabProgress = useCallback((tabId: string, p: TerminalProgress | null) => {
    setTabProgress((prev) => {
      const cur = prev[tabId];
      if (cur?.state === p?.state && cur?.progress === p?.progress) return prev;
      if (p === null && cur === undefined) return prev;
      const next = { ...prev, [tabId]: p };
      if (p === null && cur !== undefined) delete next[tabId];
      return next;
    });
  }, []);
  const forkChatRef = useRef(forkChat);
  forkChatRef.current = forkChat;
  const handleTabForkChat = useCallback((tabId: string) => {
    void forkChatRef.current(tabId);
  }, []);
  const [statuses, setStatuses] = useState<Record<string, TabStatus>>({});
  // 关闭守卫（关标签/关窗）在异步链路里取最新状态，避免闭包过期
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  // 活跃标签兜底：关标签按渲染时的列表挑邻居，同一拍又加了标签时可能挑到已不在的 id，落到最后一个标签上
  useEffect(() => {
    if (tabs.length > 0 && !tabs.some((t) => t.id === activeId)) setActiveId(tabs[tabs.length - 1].id);
  }, [tabs, activeId]);
  // 分屏：splitTabId 非空即开启——左 pane 固定活跃标签，右 pane 为下拉选择的对照标签。
  // 状态只在内存（重启不恢复分屏），仅分隔比例像右栏宽度一样本地记忆。
  const [splitTabId, setSplitTabId] = useState<string | null>(null);
  /** 活跃 pane：右栏（文件/改动）与文件树跟随它，点击 pane 切换 */
  const [activePane, setActivePane] = useState<"left" | "right">("left");
  const [splitPct, setSplitPct] = useState(() => {
    const saved = Number(localStorage.getItem(SPLIT_PCT_KEY));
    return Number.isFinite(saved) && saved > 0 ? clampSplitPct(saved) : 50;
  });
  // 各标签的当前对话数据（TerminalView 轮询后镜像上来）
  const [sessionByTab, setSessionByTab] = useState<
    Record<string, SessionLinkState>
  >({});
  // 文件树（在右栏文件窗格里）：是否显示隐藏文件、刷新信号
  const [showHidden, setShowHidden] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  /** 最近项目「真进入」：待注入活动标签启动栏的目录 */
  const [enterCwd, setEnterCwd] = useState<string | null>(null);
  // 右侧成果工作台：文件、改动各开各的窗格（对话头两个按钮），聊天留在主工作区。
  // 收缩态启动行可整体隐藏（全局偏好，2026-09-13）：身份信息底部状态栏都有，
  // 隐藏后标签栏出现召回钮；hidden 时恢复提示等一并在召回行里
  const [compactBarHidden, setCompactBarHidden] = useState(() => {
    try {
      return localStorage.getItem("ccode.terminal.compactBar") === "1";
    } catch {
      return false;
    }
  });
  const toggleCompactBar = useCallback(() => {
    setCompactBarHidden((v) => {
      const next = !v;
      try {
        localStorage.setItem("ccode.terminal.compactBar", next ? "1" : "0");
      } catch {
        /* 存储不可用时仅本会话生效 */
      }
      return next;
    });
  }, []);
  // 右栏不跨重启恢复（2026-10-24）：它只在点了文件或 ± 改动时才有内容，启动时摆一块空的「文件」没有用
  const [rightOpen, setRightOpen] = useState(false);
  const [rightWidth, setRightWidth] = useState(() => {
    const saved = Number(localStorage.getItem(RIGHT_PANEL_WIDTH_KEY));
    const width =
      Number.isFinite(saved) && saved > 0 ? saved : RIGHT_PANEL_DEFAULT_WIDTH;
    // 上限由挂载时的窗口尺寸动态钳制（见下方 resize 副作用），这里只保下限
    return Math.max(RIGHT_PANEL_MIN_WIDTH, width);
  });
  const [rightExpanded, setRightExpanded] = useState(false);
  const terminalRootRef = useRef<HTMLDivElement>(null);
  // 两块宽度（run-layout.ts）：右栏宽度是偏好，实际宽度按运行页总宽现算，地方不够时只压右栏
  const [rootWidth, setRootWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const el = terminalRootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setRootWidth(el.clientWidth));
    ro.observe(el);
    setRootWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const normalRightWidthRef = useRef(rightWidth);
  // 各标签动作表（TerminalView 挂载时注册）：查找图标、聊天发送、改目录等
  const tabActionsRef = useRef(new Map<string, FocusTabActions>());
  const pendingChatInjectRef = useRef<{ tabId: string; prompt: string } | null>(
    null,
  );
  const [injectTick, setInjectTick] = useState(0);
  const registerActions = useCallback((id: string, a: FocusTabActions) => {
    tabActionsRef.current.set(id, a);
    if (pendingChatInjectRef.current?.tabId === id) {
      setInjectTick((n) => n + 1);
    }
  }, []);

  function persistRightOpen(next: boolean) {
    setRightOpen(next);
    try {
      localStorage.setItem("ccode.terminal.rightOpen", next ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  const [rightTab, setRightTab] = useState<RightTab>("preview");
  // 文件窗格停在树还是预览；没有预览时一律显示树（见 filesView 的派生值）
  const [filesViewPref, setFilesViewPref] = useState<FilesView>("tree");
  // 树与预览左右并排（偏好，记住）；并排时树栏宽度可拖
  const [filesSplit, setFilesSplit] = useState(() => {
    try {
      return localStorage.getItem(FILES_SPLIT_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [filesTreeWidth, setFilesTreeWidth] = useState(() => {
    const saved = Number(localStorage.getItem(FILES_TREE_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0
      ? Math.max(FILES_TREE_MIN_WIDTH, saved)
      : FILES_TREE_DEFAULT_WIDTH;
  });
  // 主工作区模式按标签隔离；切换只改变显示层，不改变标签/PTY/会话。
  const [surfaceModeByTab, setSurfaceModeByTab] = useState<Record<string, SurfaceMode>>({});
  // 稳定回调（conversationInsert）里读当前层，不随渲染重建
  const surfaceModeRef = useRef(surfaceModeByTab);
  surfaceModeRef.current = surfaceModeByTab;
  // 没切过的标签显示哪一层：设置「打开对话时先显示」（缺省聊天，tab-surface.ts）；人切过的按标签记住
  const defaultSurface = openSurfaceDefault(useAppStore((s) => s.settings?.openSurface));
  const defaultSurfaceRef = useRef(defaultSurface);
  defaultSurfaceRef.current = defaultSurface;
  const [peekByTab, setPeekByTab] = useState<Record<string, boolean>>({});
  // 聊天变体状态栏留给聊天层的两格（权限 · 项目 | 模型，2026-10-23）：状态栏挂上 / 卸下时报元素，ChatSurface 用 portal 挂进去。
  // ref 回调按标签缓存成稳定函数，否则每次渲染 React 先报 null 再报元素，setState 来回翻
  const [chatMetaSlots, setChatMetaSlots] = useState<
    Record<string, { left: HTMLElement | null; right: HTMLElement | null }>
  >({});
  const chatMetaRefs = useRef(new Map<string, (side: "left" | "right", el: HTMLElement | null) => void>());
  const chatMetaRefFor = (tabId: string) => {
    let fn = chatMetaRefs.current.get(tabId);
    if (!fn) {
      fn = (side, el) =>
        setChatMetaSlots((cur) => {
          const prev = cur[tabId] ?? { left: null, right: null };
          if (prev[side] === el) return cur;
          return { ...cur, [tabId]: { ...prev, [side]: el } };
        });
      chatMetaRefs.current.set(tabId, fn);
    }
    return fn;
  };
  const [peekLocked, setPeekLocked] = useState<Record<string, boolean>>({});
  const [writableForks, setWritableForks] = useState<Record<string, boolean>>({});
  const [chatBusy, setChatBusy] = useState(false);
  const [gitTotals, setGitTotals] = useState<GitSummary | null>(null);
  // 中带「可合并」状态 pill（P1b 参考图 2）：当前项目可合并工作区名列表，空 = 不显示
  const [mergeReadyWs, setMergeReadyWs] = useState<string[]>([]);
  // pill 刷新信号：工作区归档事件（合并保留工作区的场景走 reviewPath 关闭触发刷新）
  const [wsPillTick, setWsPillTick] = useState(0);
  const [preview, setPreview] = useState<{
    path: string;
    name: string;
    root: string | null;
  } | null>(null);
  const [previewFiles, setPreviewFiles] = useState<DirEntryDto[]>([]);
  /** 预览编辑器脏状态（预览页签的脏点） */
  const [previewDirty, setPreviewDirty] = useState(false);
  /** 终端路径点击的滚行请求。带路径绑定：打开别的文件时不串行号（2026-10-10 修）。 */
  const [previewReveal, setPreviewReveal] = useState<{
    path: string;
    line: number;
  } | null>(null);
  /** 文件系统变化信号：FileTree 的 fs-changed 事件触发 GitPanel 一并刷新 */
  const [fsChangeTick, setFsChangeTick] = useState(0);
  /** 全宽任务审阅覆盖层；底下所有 TerminalView 继续挂载。 */
  const [reviewPath, setReviewPath] = useState<string | null>(null);
  const [reviewAction, setReviewAction] = useState<
    "pr" | "archive" | "resolve-conflict" | null
  >(null);
  /** 从项目页签进来的评审：返回时回到那个项目的那个页签；没指定页签的回发起页。
   *  关评审的入口不止返回键（开新终端、开阅读、切目录都会盖掉它），
   *  ref 让这些入口清状态时不用逐个改依赖 */
  const reviewReturnRef = useRef<{
    target: { projectRoot: string; surface: ProjectSurfaceTab } | null;
    fromPage: string | null;
  } | null>(null);
  const setReviewReturn = (
    value: {
      target: { projectRoot: string; surface: ProjectSurfaceTab } | null;
      fromPage: string | null;
    } | null,
  ) => {
    reviewReturnRef.current = value;
  };
  const [reviewLocked, setReviewLocked] = useState(false);
  const [reviewRequestId, setReviewRequestId] = useState<string | null>(null);
  // 评审身份由入口显式携带；不能从 cwd 猜测是哪次 Run。
  const [reviewRunId, setReviewRunId] = useState<string | null>(null);
  /** 沉浸式阅读区（批次 B1）：非空即全屏覆盖（z-40 页面模态档），底下终端/右栏保持挂载；
      notePath 指定后笔记栏直接编辑该 md（精读笔记产物入口），不按 PDF slug 另建档 */
  const [reader, setReader] = useState<{
    pdfPath: string;
    projectRoot: string;
    notePath?: string;
    /** 跨页进入时的来源页（readerReq 自动记）：退出阅读区回那里；终端页自身入口无此字段 */
    fromPage?: string;
    /** 精读步「抽查 3 篇笔记」核对档：右栏是问题单、不派阅读会话 */
    spotCheck?: SpotCheckSession;
  } | null>(null);

  // 分屏开启时右栏/文件树/改动跟随「活跃 pane」（点击 pane 或点标签条切换），否则跟随活跃标签
  const splitActive =
    splitTabId != null &&
    splitTabId !== activeId &&
    tabs.some((t) => t.id === splitTabId);
  const focusedId =
    splitActive && activePane === "right" && splitTabId ? splitTabId : activeId;
  const focusedTab = tabs.find((t) => t.id === focusedId);
  const activeCwd =
    statuses[focusedId]?.cwd ?? focusedTab?.initialCwd ?? "~";
  const focusedSurfaceMode = surfaceModeByTab[focusedId] ?? defaultSurface;
  /** 文件树当前根（钻取/切根后与 activeCwd 分叉）：改动面板跟随它而不是终端标签 cwd，
      未分叉时为 null 回落 activeCwd（v3.82 口径：「我在看哪个目录，改动就显示哪个」） */
  const [treeRoot, setTreeRoot] = useState<string | null>(null);
  const gitPanelCwd = treeRoot ?? activeCwd;
  const [codingOverviews, setCodingOverviews] = useState<CodingOverviewDto[]>(
    [],
  );
  useEffect(() => {
    let cancelled = false;
    invoke<ProjectDto[]>("list_projects")
      .then((list) =>
        Promise.all(
          list
            .filter((p) => normalizeWorkMode(p.workMode) === "coding")
            .map((p) => loadCodingOverview(p.path).catch(() => null)),
        ),
      )
      .then((rows) => {
        if (cancelled) return;
        setCodingOverviews(rows.filter((r): r is CodingOverviewDto => !!r));
      })
      .catch(() => {
        if (!cancelled) setCodingOverviews([]);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, gitPanelCwd]);
  const gitPanelOpenPr = cwdIsCodingWorktree(
    gitPanelCwd,
    codingOverviews,
    IS_WINDOWS,
  )
    ? (cwd: string) =>
        invoke<CodingOpDto>("coding_open_pr", { repoPath: cwd, cwd }).then(
          (r) => {
            if (r.method === "compare-url" && r.url) {
              return openUrl(r.url);
            }
            if (!r.ok) return alertDialog(r.message);
          },
        ).catch((e) => alertDialog(String(e)))
    : undefined;
  // 切标签/分屏焦点变化时回到新标签 cwd：树若未挂载（右栏关着）就没人发 onRootNavigated，
  // 必须在这里清掉分叉，否则改动面板会停在旧标签的目录上
  useEffect(() => {
    setTreeRoot(null);
  }, [activeCwd]);
  /** 文件窗格正显示的：没有预览标签时只能是树 */
  const filesView: FilesView = preview ? filesViewPref : "tree";
  /** 并排：树和预览同时显示（没有预览时就是整栏树，并排无从谈起） */
  const filesSideBySide = filesSplit && !!preview;

  /** 标签激活：分屏时点到右 pane 的标签则左右互换（活跃标签始终固定在左 pane） */
  function activateTab(id: string) {
    if (splitActive && id === splitTabId) setSplitTabId(activeId);
    setActiveId(id);
    setActivePane("left");
  }

  /** 分屏开关：开启时右 pane 默认选第一个非活跃标签；不足两个标签不可用 */
  function toggleSplit() {
    if (splitActive) {
      setSplitTabId(null);
      setActivePane("left");
      return;
    }
    const candidate = tabs.find((t) => t.id !== activeId);
    if (!candidate) return;
    setSplitTabId(candidate.id);
    setActivePane("left");
  }

  /** 关闭分屏一侧 pane：关右 = 退出分屏保留当前标签；关左 = 退出分屏并把对照标签转为活跃。
      不走 activateTab：退出分屏与换活跃同事务，activateTab 的左右互换分支会误把 splitTabId 写回 */
  function closePane(side: "left" | "right") {
    const keepId = side === "left" ? splitTabId : null;
    setSplitTabId(null);
    setActivePane("left");
    if (keepId) {
      setActiveId(keepId);
    }
  }

  function switchSurface(mode: SurfaceMode) {
    if (mode === "chat" && splitActive) {
      setSplitTabId(null);
      setActivePane("left");
    }
    setSurfaceModeByTab((prev) => ({ ...prev, [focusedId]: mode }));
    // 上手引导「切到终端看看」：真切过一次就算会了
    if (mode === "terminal") useAppStore.getState().ackOnboarding("terminal");
  }

  /** 右上角 >_ 与快捷键同一动作：聊天 ↔ 终端 */
  function toggleSurface(via: "tab-bar" | "hotkey") {
    if (focusedSurfaceMode === "chat") {
      const st = statuses[focusedId];
      recordChatHandoff(st?.agentId, "user_switch", `${via}-${switchState(st)}`);
    }
    switchSurface(focusedSurfaceMode === "chat" ? "terminal" : "chat");
  }

  // 聊天层「Mesa」操作（斜杠面板上半组，docs/design-chat-layer.md §6）：由 Mesa 执行，不写进终端
  function mesaCommandsFor(tabId: string): MesaCommand[] {
    const st = statuses[tabId];
    const link = sessionByTab[tabId];
    const agent = st?.agentId ?? tabs.find((x) => x.id === tabId)?.initialAgentId ?? null;
    const list: MesaCommand[] = [
      {
        cmd: "/new",
        label: "新对话",
        hint: "在这个文件夹另开一段，原来的不动",
        run: () => {
          const id = addTab({
            cwd: st?.cwd ?? tabs.find((x) => x.id === tabId)?.initialCwd,
            agentId: st?.agentId,
            profileId: st?.profileId,
            model: st?.launchModel ?? undefined,
          });
          setSurfaceModeByTab((prev) => ({ ...prev, [id]: "chat" }));
        },
      },
    ];
    if (st?.running && agent && slashCommandsFor(agent).some((c) => c.cmd === "/compact")) {
      list.push({
        cmd: "/compact",
        label: "压缩上下文",
        hint: "把前面的对话压成摘要，腾出上下文",
        run: () => void tabActionsRef.current.get(tabId)?.sendMessage("/compact"),
      });
    }
    if (link?.file && link.sessionId) {
      list.push({
        cmd: "/fork",
        label: "分叉成新对话",
        hint: "把这段对话整段复制成新的一段接着聊，原对话不动",
        run: () => void forkChat(tabId),
      });
      list.push({
        cmd: "/export",
        label: "导出 Markdown",
        hint: "存到下载文件夹",
        run: () => {
          if (!link.agentId || !link.sessionId || !link.file) return;
          invoke<string>("export_session_markdown", {
            agent: link.agentId,
            sessionId: link.sessionId,
            filePath: link.file,
            title: link.title ?? null,
          })
            .then((path) => toast(`已导出：${path}`, "success"))
            .catch((e) => toast(`导出失败：${String(e)}`, "error"));
        },
      });
    }
    list.push(
      {
        cmd: "/diff",
        label: "查看改动",
        hint: "在右侧打开这个项目的改动",
        run: () => {
          setRightOpen(true);
          setRightTab("git");
        },
      },
      {
        cmd: "/terminal",
        label: "打开终端",
        hint: "切到这段对话的终端画面",
        run: () => {
          recordChatHandoff(agent, "user_switch", "slash");
          setSurfaceModeByTab((prev) => ({ ...prev, [tabId]: "terminal" }));
          useAppStore.getState().ackOnboarding("terminal");
        },
      },
    );
    return list;
  }

  // 终端选中文字交给对话（「Mesa内嵌终端优化」会话的右键菜单 / 选区浮条调 onConversationInsert）：
  // 这个标签在聊天层 → 进聊天输入框（send=true 直接发）；在终端层 → bracketed paste 写进 TUI 输入行，send 时补回车
  const [chatInsertByTab, setChatInsertByTab] = useState<
    Record<string, { text: string; send: boolean; token: number }>
  >({});
  const [chatSearchByTab, setChatSearchByTab] = useState<Record<string, number>>({});
  const openChatSearch = useCallback((id: string) => setChatSearchByTab((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 })), []);
  const conversationInsert = useCallback(
    (tabId: string, text: string, opts: { send: boolean }) => {
      const mode = surfaceModeRef.current[tabId] ?? defaultSurfaceRef.current;
      if (mode === "chat") {
        setChatInsertByTab((prev) => ({
          ...prev,
          [tabId]: { text, send: opts.send, token: Date.now() },
        }));
        return;
      }
      const actions = tabActionsRef.current.get(tabId);
      if (!actions) return;
      if (opts.send) void actions.sendMessage(text);
      else actions.writePty(`\x1b[200~${text}\x1b[201~`);
    },
    [],
  );

  // 终端启动栏「思考」「权限」与「这次启动」卡写回标签级选择——与聊天输入框写的是同一份（2026-10-18 终端层同步）
  const patchTabLaunch = useCallback((tabId: string, patch: TabLaunchPatch) => {
    setTabs((prev) => prev.map((x) => (x.id === tabId ? { ...x, ...patch } : x)));
  }, []);
  // 终端 ⋯ 里的「对话操作」：斜杠面板 Mesa 组去掉终端层用不着的（分叉已有「分叉成新对话」、「打开终端」），补「切到聊天」
  const mesaCommandsRef = useRef(mesaCommandsFor);
  mesaCommandsRef.current = mesaCommandsFor;
  const getConversationActions = useCallback(
    (tabId: string): MesaCommand[] => [
      ...mesaCommandsRef.current(tabId).filter((c) => c.cmd !== "/terminal" && c.cmd !== "/fork"),
      {
        cmd: "/chat",
        label: "切到聊天",
        hint: "同一段对话换成聊天的样子看",
        run: () => setSurfaceModeByTab((prev) => ({ ...prev, [tabId]: "chat" })),
      },
    ],
    [],
  );

  function setPeek(tabId: string, open: boolean, userToggle = false) {
    if (open && peekLocked[tabId] && !userToggle) return;
    setPeekByTab((prev) =>
      prev[tabId] === open ? prev : { ...prev, [tabId]: open },
    );
    if (userToggle) {
      setPeekLocked((prev) =>
        open
          ? (() => {
              const next = { ...prev };
              delete next[tabId];
              return next;
            })()
          : { ...prev, [tabId]: true },
      );
    }
  }

  // 终端里换了权限模式（cliModeSwitch）：标签的权限档跟上，聊天徽标与之后接着聊的启动参数都按新档。
  // 按序号只应用一次——用户随后在徽标里自己换档时，旧运行留下的值不能把它改回去。
  // 只讨论档也跟：Claude 计划模式里方案确认点了「按方案开工」，CLI 已换到选的那一档（会话文件记 permission-mode），
  // 徽标还写「只讨论」、接着聊又按计划模式重开就不对了（2026-10-26）。只有用户在 CLI 里亲手离开计划模式才会走到这里
  const appliedModeSwitchRef = useRef<Record<string, number>>({});
  useEffect(() => {
    const updates: Record<string, "ask" | "auto" | "full"> = {};
    for (const [tabId, snap] of Object.entries(sessionByTab)) {
      const sw = snap?.cliModeSwitch;
      if (!sw || appliedModeSwitchRef.current[tabId] === sw.seq) continue;
      appliedModeSwitchRef.current[tabId] = sw.seq;
      const tier = sessionModeTier(sw.agent, sw.mode);
      if (tier) updates[tabId] = tier;
    }
    if (Object.keys(updates).length === 0) return;
    setTabs((prev) =>
      prev.map((x) =>
        updates[x.id] && !(x.permission === "discuss" && x.discussOnly) && (x.permission === "discuss" || x.permissionMode !== updates[x.id])
          ? { ...x, permission: "write_tree", permissionMode: updates[x.id] }
          : x,
      ),
    );
  }, [sessionByTab]);

  useEffect(() => {
    const att = statuses[focusedId]?.attention;
    const sync = sessionByTab[focusedId]?.sync;
    if (att === "confirm" || sync === "waiting") return;
    setPeekLocked((prev) => {
      if (!prev[focusedId]) return prev;
      const next = { ...prev };
      delete next[focusedId];
      return next;
    });
  }, [statuses[focusedId]?.attention, sessionByTab[focusedId]?.sync, focusedId]);

  /** 分屏分隔条拖拽（沿用右栏拖拽的记忆宽度模式；双击恢复对半） */
  const splitAreaRef = useRef<HTMLDivElement>(null);
  function startSplitResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const rect = splitAreaRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const pctOf = (clientX: number) =>
      clampSplitPct(((clientX - rect.left) / rect.width) * 100);
    const onMove = (moveEvent: PointerEvent) => {
      setSplitPct(pctOf(moveEvent.clientX));
    };
    const onUp = (upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const finalPct = pctOf(upEvent.clientX);
      setSplitPct(finalPct);
      localStorage.setItem(SPLIT_PCT_KEY, String(Math.round(finalPct)));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function maxRightWidth(): number {
    return runLayout({
      total: terminalRootRef.current?.clientWidth ?? rootWidth,
      rightOpen: true,
      rightWidth,
    }).rightMax;
  }

  const layout = runLayout({
    total: rootWidth,
    rightOpen,
    rightWidth,
  });

  function clampRightWidth(width: number): number {
    return Math.min(maxRightWidth(), Math.max(RIGHT_PANEL_MIN_WIDTH, width));
  }

  function toggleRightExpanded() {
    if (rightExpanded) {
      setRightExpanded(false);
      setRightWidth(clampRightWidth(normalRightWidthRef.current));
      return;
    }
    expandRight();
  }

  /** 进入专注内容（右栏拉到窗口宽的约六成）；已在里面就不动 */
  function expandRight(ratio = 0.58) {
    if (rightExpanded) return;
    const total = terminalRootRef.current?.clientWidth ?? window.innerWidth;
    const target = clampRightWidth(Math.round(total * ratio));
    // 已经比目标宽（人自己拖宽过）就不动，不把人调好的宽度缩回去
    if (target <= rightWidth) return;
    normalRightWidthRef.current = rightWidth;
    setRightExpanded(true);
    setRightWidth(target);
  }

  function closeRightPanel() {
    if (rightExpanded) {
      setRightExpanded(false);
      setRightWidth(clampRightWidth(normalRightWidthRef.current));
    }
    persistRightOpen(false);
  }

  /** 对话头「文件」钮：亮着就收起右栏，否则打开右栏并停在文件窗格（树 / 预览停在上次的位置） */
  function toggleFilesPane() {
    if (rightOpen && rightTab === "preview") {
      closeRightPanel();
      return;
    }
    setRightTab("preview");
    persistRightOpen(true);
  }

  /** 关掉预览标签回到树；有未保存改动先确认 */
  async function closePreviewTab() {
    if (
      previewDirty &&
      !(await confirmDialog("当前预览文件有未保存改动。关闭预览将放弃这些改动，继续？", {
        danger: true,
      }))
    ) {
      return;
    }
    setPreview(null);
    setPreviewFiles([]);
    setPreviewDirty(false);
    setFilesViewPref("tree");
  }

  /** 文件窗格「树与预览左右并排」开关；右栏还窄时顺手拉宽（并排至少要放下树栏 + 预览栏） */
  function toggleFilesSplit() {
    const next = !filesSplit;
    setFilesSplit(next);
    try {
      localStorage.setItem(FILES_SPLIT_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
    if (next && layout.right < filesTreeWidth + FILES_PREVIEW_MIN_WIDTH + 40) expandRight();
  }

  /** 并排时拖树栏右缘调宽（预览栏至少留 FILES_PREVIEW_MIN_WIDTH） */
  function startFilesTreeResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = filesTreeWidth;
    const clampW = (w: number) =>
      Math.round(
        Math.max(
          FILES_TREE_MIN_WIDTH,
          Math.min(w, Math.max(FILES_TREE_MIN_WIDTH, layout.right - FILES_PREVIEW_MIN_WIDTH)),
        ),
      );
    const onMove = (e: PointerEvent) => setFilesTreeWidth(clampW(startWidth + e.clientX - startX));
    const onUp = (e: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const final = clampW(startWidth + e.clientX - startX);
      setFilesTreeWidth(final);
      localStorage.setItem(FILES_TREE_WIDTH_KEY, String(final));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function startRightResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = rightWidth;
    const expanded = rightExpanded;
    const onMove = (moveEvent: PointerEvent) => {
      setRightWidth(clampRightWidth(startWidth + startX - moveEvent.clientX));
    };
    const onUp = (upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const finalWidth = clampRightWidth(startWidth + startX - upEvent.clientX);
      setRightWidth(finalWidth);
      if (!expanded) {
        normalRightWidthRef.current = finalWidth;
        localStorage.setItem(
          RIGHT_PANEL_WIDTH_KEY,
          String(Math.round(finalWidth)),
        );
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }


  // Esc 退出专注内容：仅在右栏铺满时才挂监听并拦截，
  // 平时完全不碰 Esc，避免与终端内的 Esc 输入（如 vim）冲突
  useEffect(() => {
    if (!rightExpanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 沉浸阅读区在更外层：打开期间 Esc 先退阅读区（它自己的监听处理）
      if (reader) return;
      toggleRightExpanded();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightExpanded, reader]);

  /** TerminalView 上报状态；内容没变就返回原对象，避免无谓重渲染 */
  const reportStatus = useCallback((id: string, s: TabStatus) => {
    setStatuses((prev) => {
      const cur = prev[id];
      if (cur && JSON.stringify(cur) === JSON.stringify(s)) {
        return prev;
      }
      return { ...prev, [id]: s };
    });
  }, []);

  /** TerminalView 镜像当前对话数据；引用没变就不更新 */
  /** 聊天层「等你决定」卡上点了按钮：经这家 CLI 官方的回复通道送回（Qwen / OpenCode / Codex）；
   *  终端里已经答过的，CLI 会丢掉这条，卡片随「已处理」事件消失 */
  async function replyChannel(tabId: string, requestId: string, decision: ChannelReplyDecision) {
    try {
      await invoke("chat_channel_reply", { tabId, requestId, decision });
    } catch (e) {
      toast(`没能送到：${String(e)}，可以在终端里回答`, "error");
    }
  }

  const reportSession = useCallback((id: string, s: SessionLinkState) => {
    setSessionByTab((prev) => {
      const cur = prev[id];
      if (
        cur &&
        cur.file === s.file &&
        cur.sessionId === s.sessionId &&
        cur.title === s.title &&
        cur.agentId === s.agentId &&
        cur.state === s.state &&
        cur.sync === s.sync &&
        cur.conv === s.conv &&
        cur.pendingReply === s.pendingReply &&
        cur.convCursor === s.convCursor &&
        cur.loadingOlder === s.loadingOlder &&
        cur.confirmDetail === s.confirmDetail &&
        cur.trustPrompt === s.trustPrompt &&
        cur.menuPrompt === s.menuPrompt &&
        cur.liveReply === s.liveReply &&
        cur.liveTokens === s.liveTokens &&
        cur.liveThinking === s.liveThinking &&
        cur.promptSuggestion === s.promptSuggestion &&
        cur.tuiPanel === s.tuiPanel &&
        cur.tuiNotice === s.tuiNotice &&
        cur.waitScreen === s.waitScreen &&
        cur.firstRunNote === s.firstRunNote &&
        cur.launchFailure === s.launchFailure &&
        cur.launchBlock === s.launchBlock &&
        cur.specialScreen === s.specialScreen &&
        cur.connIssue === s.connIssue &&
        cur.grokLoginStuck === s.grokLoginStuck &&
        cur.ptyQuiet === s.ptyQuiet &&
        cur.stalled === s.stalled &&
        cur.launchPick === s.launchPick &&
        // 换 Agent 选中的接力目标：不比它，选了之后输入框上方那行和模型芯片要等别的字段变（发第一句）才刷新
        cur.relay === s.relay &&
        cur.skills === s.skills &&
        cur.mcps === s.mcps &&
        cur.channel === s.channel
      ) {
        return prev;
      }
      return { ...prev, [id]: s };
    });
  }, []);

  /** 成功拉起新 PTY 后，占位标签转为普通运行标签。 */
  const finishRestore = useCallback((id: string) => {
    setTabs((current) =>
      current.map((tab) => (tab.id === id ? { ...tab, restored: false } : tab)),
    );
  }, []);

  /** launch 已消费 resumeSessionId：从标签清掉，避免之后「启动」又接回旧会话 */
  const clearResumeSession = useCallback((id: string) => {
    setTabs((current) =>
      current.map((tab) =>
        tab.id === id && tab.resumeSessionId
          ? { ...tab, resumeSessionId: undefined }
          : tab,
      ),
    );
  }, []);

  // 只持久化可重新启动所需的白名单元数据；PTY、环境变量与脚本命令都不进入 localStorage。
  useEffect(() => {
    const snapshots = tabs.flatMap((tab) => {
      if (tab.shellOnly || tab.prefillCommand) return [];
      const status = statuses[tab.id];
      const profileId = status?.profileId ?? tab.initialProfileId ?? "";
      const sessionId = status?.sessionId ?? tab.resumeSessionId ?? null;
      const representsTask = tab.restored || status?.alive || !!sessionId;
      const isCustom = Boolean(tab.customRuntimeId);
      if (!representsTask || (!profileId && !sessionId && !isCustom)) return [];
      return [
        {
          tabId: tab.id,
          value: {
            id: tab.id,
            label:
              (status?.title ??
                tab.initialTitle ??
                basename(status?.cwd ?? tab.initialCwd ?? "")) ||
              "终端",
            cwd: status?.cwd ?? tab.initialCwd ?? "~",
            agentId: status?.agentId ?? tab.initialAgentId ?? "claude-code",
            customRuntimeId: tab.customRuntimeId ?? null,
            profileId,
            model: status?.model ?? tab.initialModel ?? "",
            sessionId,
            runId: status?.runId ?? tab.runId ?? null,
            taskId: tab.taskId ?? null,
            reuseKey: tab.reuseKey ?? null,
            forkOf: tab.forkSource?.sessionId ?? null,
            forkPending: Boolean(tab.forkSessionId),
          },
        },
      ];
    });
    if (snapshots.length === 0) {
      localStorage.removeItem(TERMINAL_TABS_STORAGE_KEY);
      return;
    }
    const activeIndex = Math.max(
      0,
      snapshots.findIndex((item) => item.tabId === activeId),
    );
    localStorage.setItem(
      TERMINAL_TABS_STORAGE_KEY,
      serializeRecoverableTerminalState({
        tabs: snapshots.map((item) => item.value),
        activeIndex,
      }),
    );
  }, [activeId, statuses, tabs]);

  /** GitPanel 上报改动摘要（页签 +N 徽标与标签条变更芯片共用）；内容没变就不更新（按签名比较，免 8s 轮询空转重渲染） */
  const reportGitTotals = useCallback((t: GitSummary) => {
    const sig = (s: GitSummary) =>
      `${s.add}|${s.del}|${s.isRepo}|${s.branch}|${s.ahead}|${s.behind}|${s.inWorkspace}|${s.files.map((f) => f.status + f.path).join(",")}`;
    setGitTotals((prev) => (prev && sig(prev) === sig(t) ? prev : t));
  }, []);

  /** FileTree 的 fs-changed 事件 → GitPanel 一并刷新（稳定回调） */
  const bumpFsChangeTick = useCallback(() => setFsChangeTick((t) => t + 1), []);

  /** 状态栏「Commit & Push」第一步：AI 生成提交信息（失败回落本地默认规则）。
      style = 分割菜单的风格偏好（空串 = 默认） */
  async function generateCommitMsg(style: string): Promise<string> {
    const s = gitTotals;
    if (!s?.isRepo || s.files.length === 0) throw new Error("没有可提交的改动");
    const paths = s.inWorkspace ? null : s.files.map((f) => f.path);
    return invoke<string>("ai_commit_message", {
      cwd: gitPanelCwd,
      paths,
      style: style || null,
    }).catch(() => defaultCommitMessage(s.files));
  }

  /** 状态栏「Commit & Push」第二步：以确认的信息全量提交并推送，
      返回结果（hash 给「✓ Pushed [a1b2c3d]」用）。与改动面板同一个 git_commit 命令 */
  async function commitPushMsg(message: string): Promise<GitCommitResultDto> {
    const s = gitTotals;
    if (!s?.isRepo) throw new Error("不是 git 仓库");
    const paths = s.inWorkspace ? null : s.files.map((f) => f.path);
    const res = await invoke<GitCommitResultDto>("git_commit", {
      cwd: gitPanelCwd,
      message,
      push: true,
      paths,
    });
    bumpFsChangeTick();
    return res;
  }

  /** 工作树单击文件 → 右侧「预览」页签（编辑器自行加载内容；路径限制在后端校验） */
  const openPreview = useCallback(
    (path: string, name: string, root?: string, files?: DirEntryDto[]) => {
      setRightOpen(true);
      setRightTab("preview");
      setFilesViewPref("preview");
      setPreview({ path, name, root: root ?? null });
      setPreviewFiles(files ?? []);
      setPreviewDirty(false);
    },
    [],
  );

  /** 终端路径点击 → 右侧预览 + 滚行。引用稳定（memo 友好）；root 给文件所在
   *  目录——cwd 之外的路径不被「超出项目根」守卫拒；根级文件目录为空时用 / 兜底。 */
  const handleTerminalOpenPath = useCallback(
    (path: string, line: number | null) => {
      const dir = path.replace(/[\\/][^\\/]*$/, "");
      openPreview(path, basename(path), dir || "/");
      setPreviewReveal(line && line > 0 ? { path, line } : null);
    },
    [openPreview],
  );

  const switchPreview = useCallback(
    (offset: number) => {
      if (!preview || previewFiles.length < 2) return;
      const index = previewFiles.findIndex((file) => file.path === preview.path);
      const next = previewFiles[index + offset];
      if (!next) return;
      setPreview({ path: next.path, name: next.name, root: preview.root });
      setPreviewDirty(false);
    },
    [preview, previewFiles],
  );

  useEffect(() => {
    if (!preview || previewFiles.length < 2) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      switchPreview(event.key === "ArrowUp" ? -1 : 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [preview, previewFiles, switchPreview]);

  /** 写入指定终端标签 Agent 输入的核心链路（pty_write；send=true 时末尾补 \r 直接发送，
      缺省不自动回车、用户检查后发送）。右栏选段（活跃标签）与阅读区（阅读会话标签）共用；
      返回 null 表示已写入，返回字符串为要展示给用户的提示。 */
  const injectToTab = useCallback(
    async (tabId: string, data: string, send?: boolean): Promise<string | null> => {
      const s = statuses[tabId];
      if (!s?.running || !s.ptyId) {
        return "这段对话的 AI 没在运行，请先发一句或启动再试";
      }
      try {
        // 直接发送走聊天层同一条发送链（pty_write_submit：正文按粘贴写入、提交键单独补写）。
        // 正文与 \r 一次写进去时，Claude Code 把整段连同回车当成粘贴——字留在输入行里没发出去，
        // 聊天层却已记成「正在回复」一直转（2026-10-18 阅读区简报实测）
        if (send) {
          const action = tabActionsRef.current.get(tabId);
          if (!action) return "这段对话还没准备好，稍等再试";
          return (await action.sendMessage(data)).error;
        }
        await invoke("pty_write", {
          ptyId: s.ptyId,
          data,
        });
        return null;
      } catch (reason) {
        return `终端输入失败：${String(reason)}`;
      }
    },
    [statuses],
  );

  /** 写入当前活跃终端标签 Agent 输入（PDF 问 AI 与 md 讨论/改写共用） */
  const injectToActiveAgent = useCallback(
    (data: string, send?: boolean): Promise<string | null> =>
      injectToTab(focusedId, data, send),
    [injectToTab, focusedId],
  );

  /** PDF 选段「◈ 问 AI」：选段 + 出处格式化后注入活跃终端（格式单一出处在 reader.ts，阅读区共用） */
  const askAiFromPdf = useCallback(
    (text: string, page: number, fileName: string, send?: boolean): Promise<string | null> => {
      return injectToActiveAgent(formatPdfExcerptPrompt(text, page, fileName), send);
    },
    [injectToActiveAgent],
  );

  /** md 阅读视图选段「◈ 讨论/改写此段」：引用块格式注入，末尾引导行让用户接着补指令 */
  const discussMdExcerpt = useCallback(
    (text: string, fileName: string, send?: boolean): Promise<string | null> => {
      // 注入上限保护：选段超过 4000 字截断
      const body = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
      const quoted = body
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
      const data = `> 引自《${fileName}》的选段：\n>\n${quoted}\n\n（在这里输入你的意见：讨论、提问或要求改写）`;
      return injectToActiveAgent(data, send);
    },
    [injectToActiveAgent],
  );

  /** 切换文件树根时关闭旧预览；脏文件先确认（异步内联确认框），且绝不映射新根下的同名文件。 */
  const closePreviewForRootChange = useCallback(async () => {
    if (!preview) return true;
    if (
      previewDirty &&
      !(await confirmDialog(
        "当前预览文件有未保存改动。切换文件树根目录将放弃这些改动，继续？",
        { danger: true },
      ))
    ) {
      return false;
    }
    setPreview(null);
    setPreviewFiles([]);
    setPreviewDirty(false);
    return true;
  }, [preview, previewDirty]);

  /** 全部子组件共享的稳定回调（memo 不被行内箭头击穿） */
  const consumeExternalCwd = useCallback(() => setEnterCwd(null), []);

  useEffect(() => {
    const pending = pendingChatInjectRef.current;
    if (!pending) return;
    const action = tabActionsRef.current.get(pending.tabId);
    if (!action) return;
    const st = statuses[pending.tabId];
    // 恢复会话要等进程起来再写意见；没起来就发会走「新开会话 + 首条指令」
    if (!st?.running && !st?.alive) return;
    pendingChatInjectRef.current = null;
    void action.sendMessage(pending.prompt);
  }, [injectTick, statuses]);

  async function sendChatToActive(text: string): Promise<string | null> {
    const action = tabActionsRef.current.get(focusedId);
    if (!action) return "这段对话还没准备好，稍等再试";
    setChatBusy(true);
    try {
      const result = await action.sendMessage(text);
      if (result.needsTerminal) switchSurface("terminal");
      return result.error;
    } finally {
      setChatBusy(false);
    }
  }

  /** 聊天层暂停当前生成：OpenCode 走官方停止接口，其余家往 PTY 写 Esc（不是 Ctrl+C 硬中断——不退出会话，
      Codex/Claude 等生成中按 Esc 是停下当前回合、回到可继续输入的提示符。
      Grok Build 走不到这里：非 prompt 态 Esc 会触发整进程退出确认，
      ChatComposer 按 escInterruptSafe 对 grok 不渲染停止钮） */
  const interruptBusyRef = useRef(new Set<string>());
  function chatInterrupt() {
    const tabId = focusedId;
    const agent = statuses[tabId]?.agentId ?? tabs.find((t) => t.id === tabId)?.initialAgentId;
    if (agent === "opencode") {
      if (interruptBusyRef.current.has(tabId)) return;
      const snap = sessionByTab[tabId]?.channel;
      if (!snap || snap.connection !== "connected" || !snap.sessionId || !snap.turn) {
        toast("实时通道不可用，请切到终端停止这一轮", "error");
        return;
      }
      if (!channelTurnOpen(snap)) return;
      interruptBusyRef.current.add(tabId);
      void invoke("chat_channel_interrupt", { tabId, sessionId: snap.sessionId, turnSeq: snap.turn.seq })
        .catch((e) => toast(`没能停止：${String(e)}，可以在终端里处理`, "error"))
        .finally(() => interruptBusyRef.current.delete(tabId));
      return;
    }
    tabActionsRef.current.get(tabId)?.writePty("\x1b");
  }

  /** 聊天层审批卡片按键：批准 y / 拒绝 n / 取消 Esc（单键热键，各 CLI TUI 通用形态；
      kimi 类 CSI-u 终端的 Enter 改写不涉及——审批热键不回车） */
  function chatApprovalKey(key: "y" | "n" | "esc" | "enter") {
    tabActionsRef.current
      .get(focusedId)
      ?.writePty(key === "esc" ? "\x1b" : key === "enter" ? "\r" : key);
  }

  async function allowWritableFork() {
    const tab = tabs.find((t) => t.id === focusedId);
    if (!tab?.readonly && tab?.permission !== "discuss") return;
    const sourceStillRunning = tab.forkSource
      ? Boolean(
          liveSessions[sessionRuntimeKey(tab.forkSource.agent, tab.forkSource.sessionId)],
        )
      : false;
    const warning = sourceStillRunning
      ? "原会话仍在运行。允许这个分叉修改同一目录，可能造成文件覆盖或 Git 冲突。确认后会重启当前分叉为可写会话。继续？"
      : "当前分叉会话将重启为可写会话。继续？";
    if (!(await confirmDialog(warning, { confirmText: "允许修改", danger: true }))) return;
    const action = tabActionsRef.current.get(focusedId);
    if (!action) return;
    setChatBusy(true);
    try {
      const result = await action.restartWritable();
      if (!result.error) {
        setWritableForks((prev) => ({ ...prev, [focusedId]: true }));
      }
      if (result.needsTerminal) switchSurface("terminal");
      if (result.error && !result.needsTerminal) {
        void alertDialog(result.error);
      }
    } finally {
      setChatBusy(false);
    }
  }

  const addTab = useCallback(
    (init?: {
      cwd?: string;
      extraEnv?: Record<string, string>;
      title?: string;
      agentId?: string;
      profileId?: string;
      model?: string;
      resumeSessionId?: string;
      resumeProvider?: string;
      autoStart?: boolean;
      prefillCommand?: string;
      shellOnly?: boolean;
      customRuntimeId?: string;
      initialPrompt?: string;
      /** 「聊想法」只读模式：pty_spawn 透传，支持的 CLI 注入只读/计划模式参数 */
      readonly?: boolean;
      permission?: "discuss" | "write_tree";
      /** 原生权限档（pendingTerminal.permissionMode 透传；阅读会话用「请求批准」） */
      permissionMode?: NativePermissionMode | null;
      /** 只讨论是约定（目标 / 聊想法 / MCP 登录）：方案卡不给开工（pendingTerminal.discussOnly 透传） */
      discussOnly?: boolean;
      effort?: string | null;
      forkSource?: { agent: string; sessionId: string };
      forkSessionId?: string;
      /** 复用键（pendingTerminal.reuseKey 透传）：重复入口切标签而不是新开 */
      reuseKey?: string;
      /** 步骤认领（pendingTerminal.stepName 透传）：launch 时登记会话归步骤 */
      stepName?: string;
      runId?: string;
      taskId?: string;
      preview?: boolean;
    }): string => {
      const t: Tab = {
        id: crypto.randomUUID(),
        initialCwd: init?.cwd,
        initialExtraEnv: init?.extraEnv,
        initialTitle: init?.title,
        initialAgentId: init?.agentId,
        initialProfileId: init?.profileId,
        initialModel: init?.model,
        resumeSessionId: init?.resumeSessionId,
        resumeProvider: init?.resumeProvider,
        autoStart: init?.autoStart,
        prefillCommand: init?.prefillCommand,
        shellOnly: init?.shellOnly,
        customRuntimeId: init?.customRuntimeId,
        initialPrompt: init?.initialPrompt,
        readonly: init?.readonly,
        permission: init?.permission,
        permissionMode: init?.permissionMode,
        discussOnly: init?.discussOnly,
        effort: init?.effort,
        forkSource: init?.forkSource,
        forkSessionId: init?.forkSessionId,
        reuseKey: init?.reuseKey,
        stepName: init?.stepName,
        runId: init?.runId,
        taskId: init?.taskId,
        preview: init?.preview,
      };
      setTabs((prev) => [...prev, t]);
      setActiveId(t.id);
      return t.id;
    },
    [],
  );

  function relativeBriefPath(filePath: string, cwd: string): string {
    // Tauri 在 Windows 返回反斜杠（偶尔带 \\?\ 前缀）路径；prompt 中统一用 `/`。
    // 落在 cwd 内才截成相对路径（方言层比较：Windows 不分大小写），超出时保留原路径
    const normalize = (value: string) =>
      normSep(stripVerbatim(value)).replace(/\/+$/, "");
    const root = normalize(cwd);
    const target = normalize(filePath);
    return target !== root && pathWithinDialect(target, root, IS_WINDOWS)
      ? target.slice(root.length + 1)
      : target;
  }

  /** 「聊天和终端对不上」（chat-mismatch.ts）：收齐这个标签两边当时的内容，后端脱敏截断后交给 App 打开反馈表单 */
  async function reportChatMismatch(
    tabId: string,
    from: MismatchFrom,
    card: { title: string; options: string[] } | null,
  ) {
    const sess = sessionByTab[tabId];
    const agentId = sess?.agentId ?? statuses[tabId]?.agentId ?? null;
    const label = AGENTS.find((a) => a.id === agentId)?.label ?? "这家 Agent";
    const installed = agents.find((a) => a.id === agentId)?.version ?? null;
    const verified = currentVerifiedVersion(agentId);
    const channel = sess?.channel ?? null;
    const fidelity = chatFidelity(agentId, IS_WINDOWS);
    const raw = mismatchSnapshot({
      from,
      agentLabel: label,
      installed,
      verified,
      newer: versionTrust(installed, verified) === "newer",
      platform: IS_WINDOWS ? "Windows" : IS_MAC ? "macOS" : "Linux",
      capability: fidelity ? `${tierLabel(fidelity.tier)}${fidelity.beta ? "（测试版）" : ""}` : null,
      sourceNote: channelSourceNote(channel),
      channel: channel ? { kind: channel.kind, connection: channel.connection ?? null } : null,
      messages: sess?.conv ?? [],
      liveReply: sess?.liveReply ?? null,
      card,
      terminal: tabActionsRef.current.get(tabId)?.terminalText(120) ?? "",
    });
    const snapshot = await invoke<string>("feedback_chat_snapshot", { text: raw }).catch(() => null);
    if (snapshot === null) toast("没能整理聊天和终端的内容，这次只发文字", "warning");
    const report: MismatchReport = { title: mismatchTitle(label, from), detail: MISMATCH_TEMPLATE, snapshot };
    window.dispatchEvent(new CustomEvent(MISMATCH_EVENT, { detail: report }));
  }
  /** untilText：聊天层「从这里分叉」——简报只取到这条助手回复为止（后端按正文认） */
  async function forkChat(fromTabId = focusedId, untilText?: string) {
    const source = sessionByTab[fromTabId];
    const status = statuses[fromTabId];
    if (!source?.file || !source.sessionId || !source.agentId || !status) return;
    await forkSession(
      {
        agentId: source.agentId,
        sessionId: source.sessionId,
        file: source.file,
        title: source.title,
        cwd: status.cwd,
        profileId: status.profileId,
        model: status.model,
      },
      untilText,
    );
  }

  /** 分叉的本体：只要会话记录就能分（侧栏 / 对话页 ⋯ 不必先把它开成标签，2026-10-31）。
   *  整段分叉、这家 CLI 有原生分叉（handoff_targets.nativeFork）：用 CLI 自己的 fork 把整段对话复制成新会话，
   *  带全部上下文、权限照常，开出来就接着聊（2026-10-31 用户：照 Claude 客户端的 fork）。
   *  「从这里分叉」（untilText，截到某条回复）或这家没有原生分叉：写到那里为止的简报另开一段同家对话，先出方案。
   *  两种都在标签认出新会话后登记分叉（record_session_fork），侧栏把它挂在原对话下面 */
  async function forkSession(
    source: {
      agentId: string;
      sessionId: string;
      file: string;
      title?: string | null;
      cwd: string;
      profileId?: string | null;
      model?: string | null;
      provider?: string | null;
    },
    untilText?: string,
  ) {
    setChatBusy(true);
    try {
      // 先挑连接再写简报：没连接时别在项目里留一份没人读的简报
      const hidden = useAppStore.getState().settings?.hiddenProfiles ?? [];
      const own = source.profileId
        ? profiles.find((p) => p.id === source.profileId && p.agent === source.agentId && !hidden.includes(p.id))
        : undefined;
      const profileId =
        own?.id ??
        pickResumeProfile(profiles, source.agentId, source.provider, null, hidden)?.id ??
        profiles.find((p) => p.agent === source.agentId)?.id;
      if (!profileId) {
        throw new Error(`找不到 ${agentLabel(source.agentId)} 的连接配置，请先在连接页创建或恢复配置`);
      }
      const target = await invoke<HandoffTargetDto[]>("handoff_targets")
        .then((targets) => targets.find((t) => t.id === source.agentId))
        .catch(() => undefined);
      if (untilText == null && target?.nativeFork) {
        const forkTabId = addTab({
          cwd: source.cwd,
          // 同 Claude 客户端：分出来的那段先沿用原标题，侧栏挂在原对话下面
          title: source.title || "分叉的对话",
          agentId: source.agentId,
          profileId,
          model: source.model ?? undefined,
          forkSessionId: source.sessionId,
          forkSource: { agent: source.agentId, sessionId: source.sessionId },
          autoStart: true,
        });
        setSurfaceModeByTab((prev) => ({ ...prev, [forkTabId]: "chat" }));
        // 分出来的新会话发第一句才落盘（Claude 等），之前聊天层没东西可画、只剩一片空白（2026-10-31 用户实测「黑屏」）：
        // 先把原对话最近一页摆上，新会话的记录出来就换成它
        void invoke<ConversationPageDto>("get_session_conversation_page", {
          agent: source.agentId,
          filePath: source.file,
          before: null,
          around: null,
        })
          .then((page) => setForkPreview((prev) => ({ ...prev, [forkTabId]: page.messages })))
          .catch(() => {});
        return forkTabId;
      }
      const brief = await invoke<{ filePath: string; summary: string }>(
        "build_handoff_brief",
        {
          agent: source.agentId,
          sessionId: source.sessionId,
          filePath: source.file,
          cwd: source.cwd,
          title: source.title ?? null,
          targetPath: null,
          untilText: untilText ?? null,
        },
      );
      await invoke("mark_handoff", {
        targetAgent: source.agentId,
        targetCwd: source.cwd,
        fromAgent: source.agentId,
        fromSessionId: source.sessionId,
      });
      const prompt = `读 ${relativeBriefPath(brief.filePath, source.cwd)} 分叉简报，在此基础上继续完成任务`;
      const promptSupported = target ? target.promptSupported : source.agentId !== "kimi";
      const forkTabId = addTab({
        cwd: source.cwd,
        title: `分叉 · ${source.title || "当前对话"}`,
        agentId: source.agentId,
        profileId,
        model: source.model ?? undefined,
        initialPrompt: prompt,
        readonly: true,
        permission: "discuss",
        forkSource: { agent: source.agentId, sessionId: source.sessionId },
        autoStart: true,
      });
      // 不支持启动注入的 CLI（当前为 Kimi）直接落到终端：分叉指令由终端等输入框就绪后自动写进去，
      // 写不进去会复制并在终端报错，留在终端面上看得见。
      setSurfaceModeByTab((prev) => ({
        ...prev,
        [forkTabId]: promptSupported === false ? "terminal" : "chat",
      }));
      return forkTabId;
    } catch (e) {
      void alertDialog(`分叉失败：${String(e)}`);
      return null;
    } finally {
      setChatBusy(false);
    }
  }

  // 分叉标签认出自己的新会话（第一次认出的那个；之后 /clear 换的不算）就登记分叉：
  // CLI 自己写的上游指针会让列表把分叉当成「接着聊」并进原对话，登记了才单列、挂在原对话下面
  const recordedForkTabsRef = useRef(new Set<string>());
  /** 原生分叉标签的「原对话」那一页：新会话记录出来之前聊天层先画它（Codex 的分叉记录不抄历史，一直垫在前面） */
  const [forkPreview, setForkPreview] = useState<Record<string, ChatMessageDto[]>>({});
  // 原生分叉的新会话有了记录文件：分叉这件事算做完了，从标签清掉（之前一直留着：一句没发就重启 Mesa / 重启 Agent 时再分一次，
  // 不去接那个还不存在的新会话——接不到会退回开一段没上下文的新对话）
  useEffect(() => {
    const done = tabs.filter((t) => t.forkSessionId && sessionByTab[t.id]?.file).map((t) => t.id);
    if (done.length === 0) return;
    setTabs((current) =>
      current.map((t) => (done.includes(t.id) ? { ...t, forkSessionId: undefined } : t)),
    );
  }, [tabs, sessionByTab]);

  // 新会话的记录读到原对话的内容了（抄了全部历史的家）：丢掉 preview，之后只画新会话
  useEffect(() => {
    const done = Object.keys(forkPreview).filter((id) => {
      const conv = sessionByTab[id]?.conv ?? [];
      return !tabs.some((t) => t.id === id) || (conv.length > 0 && forkPreviewCovered(conv, forkPreview[id]));
    });
    if (done.length === 0) return;
    setForkPreview((prev) => {
      const next = { ...prev };
      for (const id of done) delete next[id];
      return next;
    });
  }, [forkPreview, sessionByTab, tabs]);
  useEffect(() => {
    for (const t of tabs) {
      const src = t.forkSource;
      if (!src || recordedForkTabsRef.current.has(t.id)) continue;
      const link = sessionByTab[t.id];
      if (!link?.sessionId || link.agentId !== src.agent || link.sessionId === src.sessionId) continue;
      recordedForkTabsRef.current.add(t.id);
      invoke("record_session_fork", { agent: src.agent, childId: link.sessionId, parentId: src.sessionId })
        .then(() => useAppStore.getState().loadSessions(true))
        .catch(() => recordedForkTabsRef.current.delete(t.id));
    }
  }, [tabs, sessionByTab]);

  // 侧栏 / 对话页 ⋯「分叉成新对话」：发请求的那边已切到运行页，这里按会话记录分
  const forkSessionReq = useAppStore((s) => s.forkSessionReq);
  useEffect(() => {
    if (!forkSessionReq) return;
    useAppStore.getState().requestForkSession(null);
    const s = forkSessionReq.session;
    void forkSession({
      agentId: s.agent,
      sessionId: s.sessionId,
      file: s.filePath,
      title: tidySessionTitle(s).title,
      cwd: s.cwd || s.projectPath,
      profileId: s.profileId,
      provider: s.provider,
    }).then((tabId) => {
      if (tabId) useAppStore.getState().focusTab(tabId);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forkSessionReq]);

  // 对话页「换 Agent」：那边已打开这段对话，这里等持有它的标签挂好，把接力目标挂上（发下一句时才交接）
  const relayPickReq = useAppStore((s) => s.relayPickReq);
  useEffect(() => {
    if (!relayPickReq) return;
    if (Date.now() - relayPickReq.token > 15_000) {
      useAppStore.getState().setRelayPickReq(null);
      return;
    }
    const holder = tabs.find(
      (t) =>
        t.resumeSessionId === relayPickReq.sessionId ||
        (sessionByTab[t.id]?.agentId === relayPickReq.agent &&
          sessionByTab[t.id]?.sessionId === relayPickReq.sessionId),
    );
    const actions = holder ? tabActionsRef.current.get(holder.id) : undefined;
    if (!holder || !actions) return;
    useAppStore.getState().setRelayPickReq(null);
    actions.pickRelay(relayPickReq.target);
  }, [relayPickReq, tabs, sessionByTab]);

  /** 工作树「在此打开新终端」：新建标签并预填 cwd，用户选 agent/profile 后启动 */
  // 「在此打开新终端」：开一个纯终端（shell），侧栏所属文件夹下多一行「终端」；不是一段新对话
  const openTerminalAt = useCallback(
    (path: string) => {
      addTab({ cwd: path, title: basename(path), shellOnly: true });
    },
    [addTab],
  );

  // 从其他页面进入终端页：右栏默认收起，只剩终端——「默认可见」会在每次
  // 切回来时摊开一个此刻没用途的面板。只有明确交接才开：预览请求（资源面板
  // 「查看」）、pendingTerminal 指定右栏页签/预览（「主仓改动」提醒、问 AI 带文件）。
  // 必须声明在下方交接消费 effect 之前：交接与切页是同一批 store 更新，
  // 消费 effect 会立刻把 pendingTerminal/previewReq 置空——本 effect 用 getState 现查，
  // 顺序反了会把刚按交接打开的预览面板又收掉。
  const prevVisibleRef = useRef(visible);
  useEffect(() => {
    const was = prevVisibleRef.current;
    prevVisibleRef.current = visible;
    if (!visible || was) return;
    const st = useAppStore.getState();
    const handoff =
      st.previewReq !== null ||
      st.pendingTerminal?.rightTab != null ||
      st.pendingTerminal?.previewPath != null;
    if (!handoff) {
      let pinned = false;
      try {
        pinned = localStorage.getItem("ccode.terminal.rightOpen") === "1";
      } catch {
        pinned = false;
      }
      if (!pinned) setRightOpen(false);
    }
  }, [visible]);

  // 消费工作区页/会话页交来的终端启动请求（可见时才消费，保证标签能立刻聚焦启动栏）
  const pendingTerminal = useAppStore((s) => s.pendingTerminal);
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const workspaceReviewRequest = useAppStore((s) => s.workspaceReviewRequest);
  const setWorkspaceReviewRequest = useAppStore(
    (s) => s.setWorkspaceReviewRequest,
  );
  const setRunningScript = useAppStore((s) => s.setRunningScript);
  // closeTab 里取最新互斥登记表（避免闭包过期）
  const runningScripts = useAppStore((s) => s.runningScripts);
  const runningScriptsRef = useRef(runningScripts);
  runningScriptsRef.current = runningScripts;
  const profiles = useAppStore((s) => s.profiles);
  // 状态栏的模型/思考档槽位来自检测缓存（agents.rs DetectResult 随规格下发）
  const agents = useAppStore((s) => s.agents);
  // 状态栏配色与终端画面同底同色（buildXtermTheme 与 xterm 实例同一出处）
  const appSettings = useAppStore((s) => s.settings);
  const statusBarColors = (() => {
    const t = buildXtermTheme(
      appSettings?.theme ?? DEFAULT_THEME_ID,
      appSettings?.terminalPalette,
      appSettings?.customTheme,
    );
    return {
      background: t.background,
      foreground: t.foreground,
      green: t.green,
      red: t.red,
      yellow: t.yellow,
      blue: t.blue,
    };
  })();
  // StrictMode 首挂载会同步双跑本 effect：第二次闭包里的 pendingTerminal 仍是同一份旧值
  // （setPendingTerminal(null) 的重渲染还没发生），直接跑会开出两个同 reuseKey 的标签——
  // 「开工首跳终端」恰好在终端页首挂载时到达（visited 门控 + setPage 同拍），开发窗口必现。
  // 按对象身份记消费标记：双跑只消费一次，新 pendingTerminal（不同对象）不受影响。
  const consumedPendingRef = useRef<unknown>(null);
  useEffect(() => {
    if (
      !visible ||
      !pendingTerminal ||
      consumedPendingRef.current === pendingTerminal
    ) {
      return;
    }
    consumedPendingRef.current = pendingTerminal;
    {
      setPendingTerminal(null);
      // 显式打开另一任务的终端时，不让上一次任务审阅继续盖住新标签。
      setReviewPath(null);
      const pt = pendingTerminal;
      const prevActiveId = activeId;
      // 会话恢复：显式带了原配置（runId 恢复）时优先原配置；否则依次
      // autoLaunchProfileId → ccode.lastProfile → 该 Agent 首个配置；
      // Codex 三条渠道分开挑（网关 / ChatGPT 官方 / 客户端磁盘渠道），见 pickResumeProfile。
      const launchAgentId = pt.agentId ?? pt.resume?.agentId;
      let profileId = pt.profileId;
      let model = pt.model;
      // 列表里点开的对话（resumeLazy）只摆记录、不起进程，发第一句才接回
      let autoStart = (!!pt.resume && !pt.resumeLazy) || !!pt.autoStart;
      if (pt.resume && launchAgentId) {
        const pick = resolveResumeLaunch(
          profiles,
          {
            agentId: launchAgentId,
            provider: pt.resume.provider,
            profileId: pt.profileId,
            model: pt.model,
            autoLaunchProfileId: pt.autoLaunchProfileId,
          },
          appSettings?.hiddenProfiles,
          localStorage.getItem(`ccode.lastProfile.${pt.resume.agentId}`),
        );
        profileId = pick.profileId;
        model = pick.model;
        if (pick.reselectNeeded) {
          // 原配置已删除/停用：不静默替换成别的——只预填、不自动启动，
          // 由用户在启动栏确认或重选后手动启动
          autoStart = false;
          toast(
            "原配置已失效或已停用，请在启动栏重新选择连接后启动",
            "warning",
          );
        } else if (pick.channelChanged) {
          autoStart = false;
          toast(
            pt.resumeLazy
              ? "已换成项目默认的连接。这条对话上次用的渠道不同，发第一句时按这条连接接回。"
              : "已换成项目默认的连接。这条对话上次用的渠道不同，确认后点运行。",
            "info",
          );
        }
      }
      // 复用键：已有同 key 标签就切过去，不再新开（「快速开聊」「跟 AI 商量一下」等
      // 重复入口防标签堆积；恢复出的占位标签只留工作区键 ws:，别的不参与复用——会话已断，新开才诚实）。
      // 复用时不跳过右侧收尾：previewPath/rightTab 等交接对复用标签同样生效（重进即回到该有的布局）
      let tabId: string | null = null;
      const adoptExisting = (existing: (typeof tabs)[number]) => {
        tabId = existing.id;
        setActiveId(existing.id);
        // 认回的标签没有复用键（重开 Mesa / 热更新后恢复出的标签不带 reuseKey）：盖上这次请求的键，
        // 否则按键找标签的入口认不出它——阅读区按篇接回旧对话时认回了恢复出的那个标签，
        // 右栏却一直「阅读会话未在运行」，点重新启动也只是在那个标签里再拉起（2026-11-06 用户截图）
        if (pt.reuseKey && !existing.reuseKey) {
          const key = pt.reuseKey;
          setTabs((prev) => prev.map((t) => (t.id === existing.id && !t.reuseKey ? { ...t, reuseKey: key } : t)));
        }
        const prompt = pt.initialPrompt?.trim();
        if (prompt) {
          pendingChatInjectRef.current = { tabId: existing.id, prompt };
          setInjectTick((n) => n + 1);
        }
        const st = statusesRef.current[existing.id];
        // Agent 还在跑：只聚焦。回落 shell / 已退出：同一标签再 launch，不另开一套抢锁。
        // 只打开不接回（resumeLazy）的不重启：切过去看着，发第一句再接
        const kick = pt.resume
          ? !pt.resumeLazy && shouldRelaunchResumeTab(st)
          : Boolean(pt.autoStart && st && !st.running);
        // 闲置标签把启动栏改成这次交接的配置（步骤绑定或接回的原会话）。
        // 正在跑的不改，活会话仍是原来那家 Agent。
        const reseed = !st?.running && Boolean(launchAgentId || profileId);
        if (kick || reseed) {
          setTabs((prev) =>
            prev.map((t) => {
              if (t.id !== existing.id) return t;
              return {
                ...t,
                ...(kick ? { resumeKick: (t.resumeKick ?? 0) + 1 } : {}),
                ...(reseed
                  ? {
                      initialAgentId: launchAgentId ?? t.initialAgentId,
                      initialProfileId: profileId || t.initialProfileId,
                      initialModel: model ?? t.initialModel,
                      // 开工弹层选的权限档：同一工作区的标签复用时也换上（2026-11-06）
                      ...(pt.permissionMode ? { permission: "write_tree" as const, permissionMode: pt.permissionMode } : {}),
                      launchSeed: (t.launchSeed ?? 0) + 1,
                      resumeSessionId: pt.resume ? pt.resume.sessionId : undefined,
                      resumeProvider: pt.resume
                        ? (pt.resume.provider ?? undefined)
                        : undefined,
                    }
                  : {}),
              };
            }),
          );
        }
      };
      if (pt.reuseBlank) {
        // 快速开聊：只切到还没说过话的随手聊标签，不改它输入框里已经换过的选择；说过话的不复用（开新对话）
        const blank = tabsRef.current.find(
          (t) =>
            t.reuseKey?.startsWith(pt.reuseBlank!) &&
            isBlankChatTab(t, statusesRef.current[t.id]),
        );
        if (blank) {
          // 点名要某条连接（连接页「新对话」）时把空白标签的输入框改过去；快速开聊不改
          if (pt.reseedBlank) {
            adoptExisting(blank);
          } else {
            tabId = blank.id;
            setActiveId(blank.id);
          }
        }
      } else if (pt.reuseKey) {
        const existing = tabsRef.current.find((t) => t.reuseKey === pt.reuseKey);
        if (existing) adoptExisting(existing);
      }
      // 同一 Run 已经有标签：切过去。新开会 claim 同一把锁，报「此运行已在启动或执行中」。
      if (!tabId && pt.runId) {
        const byRun = tabsRef.current.find(
          (t) =>
            t.runId === pt.runId ||
            statusesRef.current[t.id]?.runId === pt.runId,
        );
        if (byRun) adoptExisting(byRun);
      }
      // resume 兜底：reuseKey/runId 没命中时，若某活标签正持有这条会话，聚焦它。
      // 只按 runId 或 agent+sessionId 认身份；cwd 相同不算数。
      if (!tabId && pt.resume) {
        const holder = findResumeHolderTab(tabsRef.current, statusesRef.current, {
          runId: pt.runId,
          agentId: pt.resume.agentId,
          sessionId: pt.resume.sessionId,
        });
        if (holder) adoptExisting(holder);
      }
      // 热更新/未挂载：标签还在但没报 alive。按会话 id 认回，避免再开一套去抢正在跑的 Codex。
      if (!tabId && pt.resume) {
        const bySession = tabsRef.current.find((t) => {
          const st = statusesRef.current[t.id];
          const agent = st?.agentId || t.initialAgentId;
          const sid = st?.sessionId || t.resumeSessionId;
          return agent === pt.resume?.agentId && sid === pt.resume?.sessionId;
        });
        if (bySession) adoptExisting(bySession);
      }
      // 这一步的对话还在跑：找到持有它的标签只聚焦，不另开一份（另开就是两个 CLI 抢同一会话）
      if (!tabId && pt.focusSession) {
        const holder = findResumeHolderTab(tabsRef.current, statusesRef.current, pt.focusSession);
        if (holder) adoptExisting(holder);
      }
      // 工作区入口的最后一道：会话 id 对不上（Claude 接续后换了新会话文件、老标签没带复用键）时，
      // 这棵工作树里正有 Agent 在跑的标签就是这一步的对话。工作树一步一棵，按目录认不会认错别的对话
      //（2026-10-22 实证：收件箱「去终端回答」在 Agent 还在跑时新开了一个终端）
      if (!tabId && !pt.parallelLane && (pt.focusSession || pt.reuseKey?.startsWith("ws:"))) {
        const running = tabsRef.current.find((t) => {
          const st = statusesRef.current[t.id];
          return st?.running && !st.shell && samePath(st.cwd ?? "", pt.cwd, IS_WINDOWS);
        });
        if (running) adoptExisting(running);
      }
      const reused = tabId !== null;
      tabId ??= addTab({
        cwd: pt.cwd,
        extraEnv: pt.extraEnv,
        title: pt.title,
        agentId: launchAgentId,
        profileId,
        model,
        resumeSessionId: pt.resume?.sessionId,
        resumeProvider: pt.resume?.provider ?? undefined,
        autoStart,
        prefillCommand: pt.prefillCommand,
        shellOnly: pt.shellOnly,
        customRuntimeId: pt.customRuntimeId,
        // 恢复会话时首条指令改聊天注入，spawn 会丢掉 initialPrompt
        initialPrompt: pt.resume ? undefined : pt.initialPrompt,
        readonly: pt.readonly ?? pt.permission === "discuss",
        permission: pt.permission ?? (pt.readonly ? "discuss" : "write_tree"),
        permissionMode: pt.permissionMode ?? null,
        discussOnly: pt.discussOnly,
        effort: pt.effort ?? null,
        reuseKey: pt.reuseKey,
        stepName: pt.stepName,
        runId: pt.runId,
        taskId: pt.taskId,
        preview: Boolean(pt.resume && pt.resumeLazy) || undefined,
      });
      // 从列表点开一段对话：刚才看着的那个标签若只是看了没说 / 还没说过话的空白新对话、输入框没字，切走后收掉
      // （等新标签切到前台再关，见 dropBlankAfterOpenRef）。
      // 「在右侧分屏打开」：正看着的那段留在左边（活跃标签固定在左 pane），这段放右边，谁都不收
      if (pt.split && prevActiveId && tabId && prevActiveId !== tabId) {
        setActiveId(prevActiveId);
        setSplitTabId(tabId);
        setActivePane("right");
      } else if (pt.resumeLazy && prevActiveId && prevActiveId !== tabId) {
        dropBlankAfterOpenRef.current = prevActiveId;
      }
      if (tabId && pt.resume && pt.initialPrompt?.trim()) {
        pendingChatInjectRef.current = {
          tabId,
          prompt: pt.initialPrompt.trim(),
        };
        setInjectTick((n) => n + 1);
      }
      // 显示哪一层（tab-surface.ts）：纯 shell / 脚本标签落终端；入口写死的照写；切回已开着的标签不动；
      // 新开的跟设置「打开对话时先显示」——新开时就钉住，之后改设置不把正在用的标签翻过去
      // 闭包不保留 let 的收窄：进回调前用 const 固定，否则 [tabId] 推宽回 string | null 报 TS2464
      const launchedTabId = tabId;
      const nextSurface = launchSurface({
        surface: pt.surface,
        shellOnly: pt.shellOnly,
        prefillCommand: pt.prefillCommand,
        reused,
        setting: useAppStore.getState().settings?.openSurface,
      });
      if (launchedTabId && nextSurface) {
        setSurfaceModeByTab((prev) => ({ ...prev, [launchedTabId]: nextSurface }));
      }
      // 放进聊天输入框不发送（研讨结论「带回商量」）：新开的标签聊天层挂上时照样消费（ChatSurface 按令牌处理一次）
      const carry = pt.composerInsert?.trim();
      if (launchedTabId && carry) {
        setChatInsertByTab((prev) => ({ ...prev, [launchedTabId]: { text: carry, send: false, token: Date.now() } }));
      }
      // run 脚本标签：登记 nonconcurrent 互斥追踪
      if (pt.wsId && tabId) setRunningScript(pt.wsId, tabId);
      // 「快速开聊」：落到最干净的终端——收起右栏，只剩标签条 + 终端。
      // 理由：随手聊没有项目上下文——文件是空目录、改动面板是「不是 git 仓库」、
      // 对话面板要等会话关联，三个面板都没东西可给，摆着只是噪音
      if (pt.clean) {
        setRightOpen(false);
      }
      // 指定右栏页签（如「主仓改动」提醒 → 改动面板）
      if (pt.rightTab === "git") {
        setRightOpen(true);
        setRightTab("git");
      }
      // 开聊自动带开文件预览（一次性交接，不落盘）：右栏落到预览页签，
      // 评审覆盖层已在上面统一关掉（同 previewReq 消费语义）
      if (pt.previewPath) {
        setRightOpen(true);
        setRightTab("preview");
        setFilesViewPref("preview");
        if (pt.previewPath.toLowerCase().endsWith(".pdf")) {
          expandRight();
        }
        setPreview({
          path: pt.previewPath,
          name: basename(pt.previewPath),
          root: pt.previewRoot ?? null,
        });
        setPreviewDirty(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, pendingTerminal, setPendingTerminal, setRunningScript]);

  // 工作区页交来的评审请求：只打开覆盖层，不新建/切换/卸载终端标签。
  useEffect(() => {
    if (!visible || !workspaceReviewRequest) return;
    setReviewPath(workspaceReviewRequest.worktreePath);
    setReviewRunId(workspaceReviewRequest.runId ?? null);
    setReviewAction(workspaceReviewRequest.action ?? null);
    setReviewRequestId(workspaceReviewRequest.requestId);
    setReviewReturn({
      target: workspaceReviewRequest.returnTo ?? null,
      fromPage: workspaceReviewRequest.fromPage ?? null,
    });
    setReviewLocked(!!workspaceReviewRequest.locked);
    setWorkspaceReviewRequest(null);
  }, [visible, workspaceReviewRequest, setWorkspaceReviewRequest]);

  // 首页「待你处理」交来的标签激活请求：跳到终端页并激活该标签（已关闭的标签静默忽略）
  const focusTabReq = useAppStore((s) => s.focusTabReq);
  const setFocusTabReq = useAppStore((s) => s.setFocusTabReq);
  useEffect(() => {
    if (!visible || !focusTabReq) return;
    if (tabs.some((t) => t.id === focusTabReq)) activateTab(focusTabReq);
    setFocusTabReq(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, focusTabReq, tabs, setFocusTabReq]);

  // 上手引导「切到终端」交来的请求：当前标签切聊天 / 终端（与标签栏切换钮同一个动作）
  const surfaceSwitchReq = useAppStore((s) => s.surfaceSwitchReq);
  useEffect(() => {
    if (!visible || !surfaceSwitchReq) return;
    useAppStore.getState().setSurfaceSwitchReq(null);
    switchSurface(surfaceSwitchReq.mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, surfaceSwitchReq]);

  // 「新建项目…」从某个标签发起：建好后回到这个标签，目录换成新项目（还没启动才换得了）
  const tabCwdReq = useAppStore((s) => s.tabCwdReq);
  const setTabCwdReq = useAppStore((s) => s.setTabCwdReq);
  useEffect(() => {
    if (!visible || !tabCwdReq) return;
    const req = tabCwdReq;
    setTabCwdReq(null);
    if (!tabs.some((t) => t.id === req.tabId)) return;
    activateTab(req.tabId);
    tabActionsRef.current.get(req.tabId)?.setCwd(req.cwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, tabCwdReq, tabs, setTabCwdReq]);

  // 资源面板「查看」交来的预览请求：绝对路径（未必在任何文件树根内），
  // root 留空——PDF 走后端白名单校验，不需要预览根
  const diffFocusReq = useAppStore((s) => s.diffFocusReq);
  const setDiffFocusReq = useAppStore((s) => s.setDiffFocusReq);
  useEffect(() => {
    if (!visible || !diffFocusReq) return;
    if (diffFocusReq.cwd !== gitPanelCwd && diffFocusReq.cwd !== activeCwd) {
      // 目录对不上（会话浏览页/别的项目）：清掉，避免请求滞留后误触发
      setDiffFocusReq(null);
      return;
    }
    setRightOpen(true);
    setRightTab("git");
  }, [visible, diffFocusReq, gitPanelCwd, activeCwd, setDiffFocusReq]);

  const previewReq = useAppStore((s) => s.previewReq);
  const setPreviewReq = useAppStore((s) => s.setPreviewReq);
  useEffect(() => {
    if (!visible || !previewReq) return;
    setPreviewReq(null);
    // 评审覆盖层会挡住预览，先关掉（同 pendingTerminal 消费语义）
    setReviewPath(null);
    setReviewRunId(null);
    setReviewAction(null);
    setRightOpen(true);
    setRightTab("preview");
    setFilesViewPref("preview");
    // PDF 是阅读动作：打开时自动把右栏拉宽（专注内容），用户可随时 ⇲/Esc 还原
    // PDF 是阅读动作，打开时右栏放宽一些——到窗口宽的四成半就够（2026-11-06 用户：原先拉到约六成太宽，对话挤没了）；
    // 要更宽点「专注内容」（约六成）或自己拖
    if (previewReq.path.toLowerCase().endsWith(".pdf")) expandRight(0.45);
    setPreview({
      path: previewReq.path,
      name: previewReq.name,
      root: previewReq.root ?? null,
    });
    setPreviewFiles([]);
    setPreviewDirty(false);
  }, [visible, previewReq, setPreviewReq]);

  // ===== 沉浸式阅读区（批次 B1）=====
  // store 一次性请求消费（雷达卡「开读」等跨页入口）；终端页内部入口（预览工具条/文件树右键）直接 setReader
  const readerReq = useAppStore((s) => s.readerReq);
  const setReaderReq = useAppStore((s) => s.setReaderReq);
  useEffect(() => {
    if (!visible || !readerReq) return;
    setReaderReq(null);
    // 评审覆盖层会挡住阅读区，先关掉（同 previewReq 消费语义）；
    // 右栏若正在预览同一 PDF 保持原样不动它
    setReviewPath(null);
    setReviewRunId(null);
    setReviewAction(null);
    setReader({
      pdfPath: readerReq.pdfPath,
      projectRoot: readerReq.projectRoot,
      notePath: readerReq.notePath,
      fromPage: readerReq.fromPage,
      spotCheck: readerReq.spotCheck,
    });
  }, [visible, readerReq, setReaderReq]);

  // 抽查核对档不派阅读会话：阅读会话在项目根运行，改的是主仓里的笔记，不是工作区里待评审的那份
  const readerKey =
    reader && !reader.spotCheck ? readerReuseKey(reader.projectRoot, reader.pdfPath) : null;
  /** 阅读会话标签（reuseKey 找回：退出再进接着聊；恢复出的占位标签不带 reuseKey 不参与复用） */
  const readerTabId = readerKey
    ? (tabs.find((t) => t.reuseKey === readerKey)?.id ?? null)
    : null;
  const [readerNeedsProfile, setReaderNeedsProfile] = useState(false);
  /** 接回的是这篇以前那段对话时记下它的复用键：那段对话本来就知道读的哪篇、笔记在哪，阅读区不再发开场简报 */
  const [readerResumedKey, setReaderResumedKey] = useState<string | null>(null);
  /** 自动起会话的一次性标记：用户手动关掉阅读会话标签后不连环重建（栏内给「重新启动」入口） */
  const readerTriedRef = useRef<string | null>(null);
  const [readerAgentTick, setReaderAgentTick] = useState(0);
  useEffect(() => {
    if (!reader) readerTriedRef.current = null;
  }, [reader]);

  /** 阅读会话的启动配置：项目 Agents「专属绑定 · 沉浸阅读对话」优先（现读注册表；
      agent 跟随绑定连接所属 CLI，停用项照常尊重——显式绑定；连接被删/读失败按
      未绑定回落自动链）；否则 Agent 跟随启动栏上次选择，profile 按既有解析顺序
      （显式默认 settings.defaultProfiles > 上次使用 > 首个可见 > 首个，与启动栏一致） */
  async function resolveReaderLaunch(projectRoot: string): Promise<{
    agentId: string;
    profileId: string;
    model: string | null;
  }> {
    const st = useAppStore.getState();
    let research = true;
    try {
      const read = await invoke<{ config: { workMode?: string | null } }>(
        "read_project_config",
        { path: projectRoot },
      );
      research = normalizeWorkMode(read.config.workMode) === "research";
    } catch {
      /* 读不到工作方式时仍尝试槽位，避免科研项目开不了阅读区 */
    }
    if (research) {
      try {
        const binding = await invoke<{ profile: string; model?: string | null } | null>(
          "get_project_agent_binding",
          { projectRoot, slot: READER_BINDING_SLOT },
        );
        const bound = taskBindingLaunch(st.profiles, binding);
        if (bound) return bound;
      } catch {
        /* 读不到按未绑定回落自动链，不让阅读区因注册表读取失败开不了会话 */
      }
    }
    let agentId = "claude-code";
    try {
      const saved = JSON.parse(
        localStorage.getItem("ccode.lastLaunch") ?? "{}",
      ) as Partial<{ agentId: string }>;
      if (saved.agentId && AGENTS.some((a) => a.id === saved.agentId))
        agentId = saved.agentId;
    } catch {
      /* 损坏按默认 */
    }
    const pick =
      st.settings?.defaultProfiles?.[agentId] ||
      localStorage.getItem(`ccode.lastProfile.${agentId}`) ||
      "";
    const remembered = st.profiles.find(
      (p) => p.id === pick && p.agent === agentId,
    );
    const ok =
      remembered && remembered.accountType !== "official"
        ? remembered.id
        : undefined;
    // 兜底挑首个时跳过停用项（同启动栏口径）；全被停用时仍从停用项里取，好过留空
    const hidden = st.settings?.hiddenProfiles ?? [];
    const visibleProfiles = st.profiles.filter(
      (p) => p.agent === agentId && !hidden.includes(p.id),
    );
    const auto = skipDisconnectedOfficial(visibleProfiles, false);
    return {
      agentId,
      profileId:
        ok ??
        auto[0]?.id ??
        visibleProfiles[0]?.id ??
        st.profiles.find((p) => p.agent === agentId)?.id ??
        "",
      model: null,
    };
  }

  /** 派一个阅读会话标签（项目根 + 专属绑定/默认配置 + autoStart + reuseKey，快速开聊
      同款机制）；返回 false = 无可用配置（Agent 栏显示引导卡）。绑定要现读注册表，
      异步——由 effect 侧接住 */
  async function dispatchReaderSession(r: {
    pdfPath: string;
    projectRoot: string;
  }): Promise<boolean> {
    const launch = await resolveReaderLaunch(r.projectRoot);
    const title = `阅读 · ${basename(r.pdfPath).replace(/\.pdf$/i, "")}`;
    const reuseKey = readerReuseKey(r.projectRoot, r.pdfPath);
    const askMode = (agentId: string) =>
      useAppStore.getState().agents.find((a) => a.id === agentId)?.permissionModes.includes("ask")
        ? { permissionMode: "ask" as const }
        : {};
    // 这篇以前读过、那段对话还在：接回它，不另开（2026-11-06 用户：之前精读过的文献直接打开之前的会话）。
    // 连接默认用那段对话自己的；同一家时人在项目 Agents 里给精读绑的连接作候补（与侧栏接着聊同一套 resumeProfileChoice）
    let sessions = useAppStore.getState().sessions;
    try {
      sessions = await useAppStore.getState().loadSessions(true);
    } catch {
      /* 拉不到就按手上的列表认，认不出照常新开 */
    }
    const prev = readerSessionFor(sessions, r.projectRoot, r.pdfPath, IS_WINDOWS);
    if (prev) {
      const run = await invoke<RunDto | null>("run_find", {
        agent: prev.agent,
        sessionId: prev.sessionId,
      }).catch(() => null);
      const st = useAppStore.getState();
      const choice = resumeProfileChoice({
        agentId: prev.agent,
        own: prev.profileId ?? run?.profileId,
        preferred: launch.agentId === prev.agent ? launch.profileId : null,
        profiles: st.profiles,
        hidden: st.settings?.hiddenProfiles,
      });
      if (choice.profileId || choice.autoLaunchProfileId) {
        setReaderResumedKey(reuseKey);
        setPendingTerminal({
          cwd: prev.cwd ?? r.projectRoot,
          extraEnv: {},
          title,
          resume: { agentId: prev.agent, sessionId: prev.sessionId, provider: prev.provider },
          agentId: prev.agent,
          ...choice,
          ...askMode(prev.agent),
          runId: run?.id,
          autoStart: true,
          reuseKey,
        });
        return true;
      }
    }
    if (!launch.profileId) return false;
    setReaderResumedKey(null);
    // 阅读会话按「请求批准」起（本机设成完全访问也收窄）：改笔记以外的文件先问；
    // Claude Code 另由 pty_spawn 预放行 notes/（reuseKey reader: 识别）。没有这一档的 CLI 按本机设置
    setPendingTerminal({
      cwd: r.projectRoot,
      extraEnv: {},
      title,
      agentId: launch.agentId,
      profileId: launch.profileId,
      ...(launch.model ? { model: launch.model } : {}),
      ...askMode(launch.agentId),
      autoStart: true,
      reuseKey,
    });
    return true;
  }

  // 进入阅读区：还没有绑定本项目的阅读会话标签就自动起一个
  useEffect(() => {
    if (!visible || !reader || !readerKey) return;
    if (readerTabId) {
      setReaderNeedsProfile(false);
      return;
    }
    if (readerTriedRef.current === readerKey) return;
    let cancelled = false;
    void (async () => {
      const ok = await dispatchReaderSession(reader);
      if (cancelled) return;
      // 无配置不记一次性标记：配置页加好配置后 profiles 变化会自然重试
      readerTriedRef.current = ok ? readerKey : null;
      setReaderNeedsProfile(!ok);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, reader, readerKey, readerTabId, profiles, readerAgentTick]);

  // 阅读区开着换了一篇（复用键按篇）：上一篇的阅读会话标签照「退出即关」收掉，不留在标签里堆积
  useEffect(() => {
    if (!readerKey) return;
    for (const t of tabs) {
      if (t.reuseKey?.startsWith("reader:") && t.reuseKey !== readerKey) doCloseTab(t.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readerKey, tabs]);

  /** 阅读区注入（选段「↵ 直接发送」/ 输入框回车）：走与右栏选段同一条 injectToTab 链路，目标换成阅读会话标签 */
  const injectToReader = useCallback(
    (data: string, send?: boolean): Promise<string | null> => {
      if (!readerTabId) return Promise.resolve("阅读会话还没建好，稍等片刻再试");
      // 聊天层时「放进输入框、不发送」要进聊天输入框（终端输入行被聊天层盖着，看不见）；
      // 直接发送两层都走 PTY，出错能报回来（简报失败要重试）
      if (!send && (surfaceModeRef.current[readerTabId] ?? defaultSurfaceRef.current) === "chat") {
        setChatInsertByTab((prev) => ({
          ...prev,
          [readerTabId]: { text: data, send: false, token: Date.now() },
        }));
        return Promise.resolve(null);
      }
      return injectToTab(readerTabId, data, send);
    },
    [injectToTab, readerTabId],
  );

  /** 阅读区右栏切聊天层 / 终端画面：只动阅读会话标签（不走 switchSurface——它按焦点标签改、
      切聊天还会退出分屏）。只管这一次的会话，下次进入照设置「打开对话时先显示」（2026-10-22） */
  const readerSurface: SurfaceMode = readerTabId
    ? (surfaceModeByTab[readerTabId] ?? defaultSurface)
    : defaultSurface;
  const setReaderSurface = useCallback(
    (mode: SurfaceMode) => {
      if (!readerTabId) return;
      setSurfaceModeByTab((prev) => ({ ...prev, [readerTabId]: mode }));
    },
    [readerTabId],
  );

  /** 阅读会话标签被手动关掉后的「重新启动」：清一次性标记再派一次 */
  const restartReaderAgent = useCallback(() => {
    readerTriedRef.current = null;
    setReaderAgentTick((t) => t + 1);
  }, []);

  // 跨页进入（文件页/产物核验/资源面板）退出时回到来源页，别把人留在运行页；
  // 终端页自己的入口（预览工具条/文件树右键）没有 fromPage，退出原地不动。
  // 阅读会话标签随阅读区一起直接关（2026-09-20 用户拍板）：它是为阅读区派的临时
  // 会话，退出留着只会在标签条上积累「阅读 · xxx」；不弹任何确认——正在生成的
  // 回应一并中断，退出就是退干净。也不走 requestCloseTab：它按「PTY 进程活着」拦，
  // 交互式 CLI 坐在输入提示符上也活着，每次退出都会弹确认
  const closeReader = useCallback(() => {
    const back = reader?.fromPage;
    const tabId = readerTabId;
    setReader(null);
    if (tabId) doCloseTab(tabId);
    if (back && back !== "terminal" && back !== useAppStore.getState().page) {
      setPage(back);
    }
  }, [reader, readerTabId, setPage]);

  /** 抽查问题单交回这一步的 AI：走步骤「继续」同一条链（接回原对话；还在跑就认回持有它的标签，
      消息注入那个标签），关掉阅读区留在运行页看 AI 改。返回 null 成功，否则为提示 */
  const sendSpotCheck = useCallback(
    async (prompt: string): Promise<string | null> => {
      const ws = reader?.spotCheck?.ws;
      if (!ws) return "这一步没有可以接着改的对话";
      try {
        const req = await buildWorkspaceTerminalRequest(ws, prompt, {
          autoStart: true,
          resumeSession: true,
        });
        setReader(null);
        setPendingTerminal(req);
        return null;
      } catch (e) {
        return `没交回去：${String(e)}`;
      }
    },
    [reader],
  );

  /** 抽查都没问题：勾上这一项、通知流程页重取，回来源页 */
  const clearSpotCheck = useCallback(async (): Promise<string | null> => {
    const spot = reader?.spotCheck;
    if (!spot) return null;
    try {
      await invoke("set_human_task_check", {
        projectRoot: spot.projectRoot,
        step: spot.stepName,
        title: spot.taskTitle,
        checked: true,
      });
    } catch (e) {
      return `没勾上：${String(e)}`;
    }
    useAppStore.getState().bumpHumanTasks();
    closeReader();
    return null;
  }, [reader, closeReader]);

  // 阅读区打开时把阅读会话标签提到活跃（右栏 xterm 就是那个标签的画面；
  // 退出阅读区时该标签随 closeReader 一起关掉，不再「正好落在它上面」）
  // 按 focusedId 判：分屏时焦点在右 pane 也要拉回来——聊天层发送/打断/审批都发给焦点标签
  useEffect(() => {
    if (!reader || !readerTabId || focusedId === readerTabId) return;
    activateTab(readerTabId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reader, readerTabId, focusedId]);

  // 阅读区打开期间：阅读会话标签的 xterm 宿主节点移进覆盖层右栏槽位，关闭时移回原标签槽位
  // （Monaco 宿主移动同款先例：DOM 搬移不重建，PTY/xterm/scrollback 全程不丢；
  // 容器上的 ResizeObserver 在尺寸变化时自动 fit，无需额外触发）。
  // 槽位用回调 ref + state。右栏收起/展开不再卸载槽位（栏体滑出隐藏、宽度不变，
  // 宿主不搬不 fit），effect 只在覆盖层开/关、标签更替时复位/再搬。
  const [readerTermSlot, setReaderTermSlot] = useState<HTMLDivElement | null>(
    null,
  );
  const bindReaderTermSlot = useCallback(
    (el: HTMLDivElement | null) => setReaderTermSlot(el),
    [],
  );
  const [readerStatusSlot, setReaderStatusSlot] =
    useState<HTMLDivElement | null>(null);
  const bindReaderStatusSlot = useCallback(
    (el: HTMLDivElement | null) => setReaderStatusSlot(el),
    [],
  );
  useLayoutEffect(() => {
    if (!reader || !readerTabId) return;
    const root = terminalRootRef.current;
    // host 与状态栏独立判定、分别搬运：两个槽位的挂载时机可能不同步
    // （右栏收起/展开会重建槽位），早退会漏搬后到的那一个
    const host = root?.querySelector<HTMLElement>(
      `[data-terminal-host="${readerTabId}"]`,
    );
    let hostHome: HTMLElement | null = null;
    if (host && readerTermSlot) {
      const home = host.parentElement;
      if (home && home !== readerTermSlot) {
        readerTermSlot.appendChild(host);
        hostHome = home;
      }
    }
    // 聊天层宿主跟着搬进同一个槽位（叠在 xterm 之上，显隐与摆位由标签的 surface/peek 决定，
    // 见 pane 里 data-chat-host 的类名）：右栏可以在聊天层与终端画面之间切换
    const chat = root?.querySelector<HTMLElement>(
      `[data-chat-host="${readerTabId}"]`,
    );
    let chatHome: HTMLElement | null = null;
    if (chat && readerTermSlot) {
      const home = chat.parentElement;
      if (home && home !== readerTermSlot) {
        readerTermSlot.appendChild(chat);
        chatHome = home;
      }
    }
    // 状态栏随宿主一起搬（同 DOM 搬移口径）：右栏底部槽位存在才搬，槽位缺席（引导卡等）留在原 pane
    const bar = root?.querySelector<HTMLElement>(
      `[data-statusbar-host="${readerTabId}"]`,
    );
    let barHome: HTMLElement | null = null;
    if (bar && readerStatusSlot) {
      const home = bar.parentElement;
      if (home && home !== readerStatusSlot) {
        readerStatusSlot.appendChild(bar);
        barHome = home;
      }
    }
    return () => {
      // 移回原槽位：host 原是容器第一个孩子；状态栏原是 pane-body 最后一个孩子。
      // 标签被关时 TerminalView 卸载、home 已不在文档里（React 只卸其自身子树，
      // 搬走的节点不在其中），isConnected 跳过硬挂
      if (host && hostHome?.isConnected)
        hostHome.insertBefore(host, hostHome.firstChild);
      // 聊天层宿主原是包装层唯一的孩子
      if (chat && chatHome?.isConnected) chatHome.appendChild(chat);
      if (bar && barHome?.isConnected) barHome.appendChild(bar);
    };
  }, [reader, readerTabId, readerTermSlot, readerStatusSlot]);

  /** 「⛶ 沉浸阅读」入口（PDF 预览工具条 / 文件树右键共用）：反查归属项目后开覆盖层 */
  async function openReaderForPdf(pdfPath: string) {
    try {
      let owner = await invoke<ProjectDto | null>("pdf_owner_project", {
        pdfPath,
      });
      if (!owner) {
        const cwdHint = statuses[focusedId]?.cwd ?? preview?.root ?? null;
        const root = await offerAddLitProject(pdfPath, cwdHint);
        if (!root) return;
        setReviewPath(null);
        setReviewAction(null);
        setReader({ pdfPath, projectRoot: root });
        return;
      }
      setReviewPath(null);
      setReviewAction(null);
      setReader({ pdfPath, projectRoot: owner.path });
    } catch (e) {
      void alertDialog(String(e));
    }
  }

  /** md 笔记「⛶ 沉浸阅读」入口（文件树右键 / 预览工具条）：reader_for_note 一次给齐
      归属项目根 + 配对 PDF + 实际笔记路径（工作区笔记映射回主仓副本；失败原因直接弹给用户） */
  async function openReaderForNote(notePath: string) {
    try {
      const r = await invoke<{
        projectRoot: string;
        pdfPath: string;
        notePath: string;
      }>("reader_for_note", { notePath });
      setReviewPath(null);
      setReviewAction(null);
      setReader({
        pdfPath: r.pdfPath,
        projectRoot: r.projectRoot,
        notePath: r.notePath,
      });
    } catch (e) {
      void alertDialog(String(e));
    }
  }

  // 别处交来的「进这个目录」（工作台继续、未添加目录等）：正看着的是还没说话的空白对话，就把它挪过去
  // （复用 enterCwd/externalCwd「真进入」机制）；正看着的已经在聊 / 开着终端，另开一段落在那个目录，
  // 不去动正在用的那段（2026-10-24 起：一段对话只属于一个目录，文件树跟着对话的目录走）
  const enterCwdReq = useAppStore((s) => s.enterCwdReq);
  const setEnterCwdReq = useAppStore((s) => s.setEnterCwdReq);
  useEffect(() => {
    if (!visible || !enterCwdReq) return;
    setEnterCwdReq(null);
    // 评审覆盖层会挡住文件树，先退出（同 previewReq 消费语义）
    setReviewPath(null);
    setReviewRunId(null);
    setReviewAction(null);
    const focused = tabsRef.current.find((t) => t.id === focusedId);
    if (focused && isBlankChatTab(focused, statusesRef.current[focusedId])) {
      setEnterCwd(enterCwdReq);
    } else {
      addTab({ cwd: enterCwdReq, title: basename(enterCwdReq) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, enterCwdReq, setEnterCwdReq]);

  /** PDF 选段「整理为笔记」（§11.4 P2b）：精读步骤的工作区正在跑就写进它的 notes/excerpts.md
      并预填终端；没在跑（或没有研究流程）就写项目根 notes/excerpts.md，开工时随接驳带进工作区。
      2026-10-17 审查修复：不再替人提前建精读工作区（绕开开工弹层、基线可能还没合并检索结果，
      之后正式开工撞「工作区已存在」），也不再写 notes/inbox.md（那是文献雷达的收件箱）。 */
  const organizePdfExcerpt = useCallback(
    async (
      text: string,
      page: number,
      fileName: string,
    ): Promise<PdfActionResult> => {
      const pdfPath = preview?.path;
      if (!pdfPath) return { ok: false, msg: "预览已关闭，请重新打开 PDF" };
      // 整理为笔记的落点与开工逻辑与项目文件页共用（pdf-organize.ts）
      return organizePdfExcerptShared({
        pdfPath,
        text,
        page,
        fileName,
        offerAddProject: () => offerAddLitProject(pdfPath, statuses[focusedId]?.cwd ?? preview?.root),
      });
    },
    [preview, focusedId, statuses],
  );

  // 会话页「进行中」反向跳转：聚焦指定标签
  const focusTabId = useAppStore((s) => s.focusTabId);
  const focusTab = useAppStore((s) => s.focusTab);
  useEffect(() => {
    if (visible && focusTabId) {
      if (tabs.some((t) => t.id === focusTabId)) {
        // 从侧栏点一段已经开着的对话：刚才只看没说的那个标签同样收掉（同列表点开）
        if (activeId !== focusTabId) dropBlankAfterOpenRef.current = activeId;
        activateTab(focusTabId);
      }
      focusTab(null);
    }
  }, [visible, focusTabId, tabs, focusTab]);

  // 长任务 OS 通知（P3）：attention 跃迁（非→待确认）且窗口未聚焦时发系统通知。
  // 「已回复」不通知——回合结束每轮都发生、不阻塞决策。只 watch 终端标签 statuses；
  // 对话页/工作区页的状态变化 v1 不通知。
  const notificationsEnabled = useAppStore(
    (s) => s.settings?.notificationsEnabled ?? true,
  );
  // 每标签上一次 attention（undefined = 基线未建立）与上次通知时间（去抖）
  const attentionPrevRef = useRef(new Map<string, TabStatus["attention"]>());
  const notifySentAtRef = useRef(new Map<string, number>());
  // macOS 切到别的应用时 document.hidden 不变，必须另跟 window focus/blur
  const windowFocusedRef = useRef(document.hasFocus());
  useEffect(() => {
    const onFocus = () => {
      windowFocusedRef.current = true;
    };
    const onBlur = () => {
      windowFocusedRef.current = false;
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  useEffect(() => {
    // 标签关闭后清掉基线/去抖记录，防 id 复用时沿用旧状态
    for (const id of [...attentionPrevRef.current.keys()]) {
      if (!(id in statuses)) {
        attentionPrevRef.current.delete(id);
        notifySentAtRef.current.delete(id);
      }
    }
    for (const [tabId, s] of Object.entries(statuses)) {
      const prev = attentionPrevRef.current.get(tabId);
      attentionPrevRef.current.set(tabId, s.attention);
      if (!attentionTransition(prev, s.attention)) continue;
      // 设置开关关闭时完全不请求权限、不发通知
      if (!notificationsEnabled) continue;
      if (!document.hidden && windowFocusedRef.current) continue;
      const now = Date.now();
      if (!debounceAllows(notifySentAtRef.current.get(tabId), now)) continue;
      notifySentAtRef.current.set(tabId, now);
      void fireAttentionNotification(
        notifyTitle(s.title, agentLabel(s.agentId)),
        NOTIFY_BODY,
        { tabId, cwd: s.cwd },
      );
    }
  }, [statuses, notificationsEnabled]);

  // 目标 Run 回合结束（→ 已回复）即冻结当前成果并提升待验收（审计 §4.4 实机验证：
  // 交互式 CLI 交付后停在提示符不退出，验收不能等进程死亡）。只发 invoke，
  // 是否可审/要不要提升由后端按 task 判定；旧 Run 无基线时后端直接跳过。
  const turnPrevRef = useRef(new Map<string, TabStatus["attention"]>());
  useEffect(() => {
    for (const id of [...turnPrevRef.current.keys()]) {
      if (!(id in statuses)) turnPrevRef.current.delete(id);
    }
    for (const [tabId, s] of Object.entries(statuses)) {
      const prev = turnPrevRef.current.get(tabId);
      turnPrevRef.current.set(tabId, s.attention);
      if (prev === undefined || prev === "done" || s.attention !== "done") continue;
      if (!s.runId) continue;
      invoke("task_freeze_turn", { runId: s.runId }).catch(() => {});
    }
  }, [statuses]);

  // 交叉复核说完（2026-11-11 用户：用 Codex 复核完只看到对话结束，不知道结果在哪）：复核标签这一轮说完时读一遍
  // 这一步的核验清单，右下角报它记了几条，点「去评审看」打开这一步的评审
  const crossPrevRef = useRef(new Map<string, TabStatus["attention"]>());
  useEffect(() => {
    for (const id of [...crossPrevRef.current.keys()]) {
      if (!(id in statuses)) crossPrevRef.current.delete(id);
    }
    for (const [tabId, s] of Object.entries(statuses)) {
      const key = tabsRef.current.find((t) => t.id === tabId)?.reuseKey;
      if (!key?.startsWith(CROSS_REVIEW_KEY_PREFIX)) continue;
      const prev = crossPrevRef.current.get(tabId);
      crossPrevRef.current.set(tabId, s.attention);
      if (prev === undefined || prev === "done" || s.attention !== "done") continue;
      const worktreePath = key.slice(CROSS_REVIEW_KEY_PREFIX.length);
      void invoke<ChecksDto>("research_checks_read", { path: worktreePath })
        .catch(() => ({ items: [], files: [], skipped: 0 }) as ChecksDto)
        .then((dto) => {
          toast(crossReviewDoneText(dto.items), "info", {
            actions: [
              {
                label: "去评审看",
                primary: true,
                onClick: () =>
                  useAppStore.getState().setWorkspaceReviewRequest({ worktreePath, requestId: crypto.randomUUID() }),
              },
            ],
          });
        });
    }
  }, [statuses]);

  // 可见性门控（优化 2）：只有可见 pane 的 PTY 推流，其余（含整页隐藏时全部）进后台缓冲。
  // 分屏时左右两个 pane 都可见，都推流。PTY 被替换（agent→shell 回落换新 id）时
  // statuses 变化会触发重新标记。
  useEffect(() => {
    for (const [tabId, s] of Object.entries(statuses)) {
      if (s.ptyId) {
        invoke("pty_set_visible", {
          ptyId: s.ptyId,
          visible:
            visible &&
            (tabId === activeId || (splitActive && tabId === splitTabId)),
        }).catch(() => {});
      }
    }
  }, [activeId, splitActive, splitTabId, statuses, visible]);

  /** 关闭标签守卫：只有 Agent 在干活 / 等你确认（或还不知道）的标签弹确认；回完话在等下一句的、shell / 已退出 / 未启动的直接关
      （closeAsksFirst）。存活判定以后端 pty_has_running_process 为准；命令不存在或报错时守卫静默跳过，不阻塞关闭。 */
  async function requestCloseTab(id: string) {
    const s = statusesRef.current[id];
    if (s?.running && s.ptyId && closeAsksFirst(s.attention)) {
      try {
        const alive = await invoke<boolean>("pty_has_running_process", {
          ptyId: s.ptyId,
        });
        if (
          alive &&
          !(await confirmDialog("关掉这段对话？\n\nAgent 还在干活，关掉会停下它；记录还在侧栏，点开就能接着聊。", {
            danger: true,
          }))
        )
          return;
      } catch {
        /* 后端命令未就绪：静默跳过守卫 */
      }
    }
    void invoke("drop_terminal_replay", { tabId: id }).catch(() => {});
    doCloseTab(id);
  }

  /** 从列表点开一段对话（或从别处跳到某个标签）时，刚才看着的那个标签若只是看了没说、或是还没说过话的空白新对话，
   *  输入框里也没字，切走后顺手收掉，免得一路点下来留一排标签（isThrowawayTab）。
   *  等新标签切到前台再关（doCloseTab 读当次渲染的 tabs，同拍关会把刚加的标签一起丢掉）；分屏右栏里那个不收 */
  const dropBlankAfterOpenRef = useRef<string | null>(null);
  /** 各标签输入框里有没有没发的字 / 图（ChatSurface 报上来）：有就不收 */
  const draftByTabRef = useRef<Record<string, boolean>>({});
  const reportDraft = useCallback((tabId: string, has: boolean) => {
    draftByTabRef.current[tabId] = has;
  }, []);
  // 项目内传话（2026-11-03 项目内协作二期，project_mail.rs）：同项目另一段工作给这个标签留了话，等它空闲
  //（Agent 开着、不在干活、不在等你确认）、输入框里没有你没发的字时，经这个标签自己的发送链送进对话，聊天里看得见；
  // 送不出退回等送。回落成 shell 的标签不送（sendMessage 在那时会接回会话，不能为一条留话替人重开对话）
  const mailBusyRef = useRef(false);
  const pageVisibleRef = useRef(visible);
  pageVisibleRef.current = visible;
  useEffect(() => {
    const tick = async () => {
      if (mailBusyRef.current) return;
      mailBusyRef.current = true;
      try {
        for (const [tabId, st] of Object.entries(statusesRef.current)) {
          if (!st?.running || st.shell || !st.runId || st.attention === "working" || st.attention === "confirm") continue;
          if (draftByTabRef.current[tabId]) continue;
          // 你正对着它的终端层：可能在 TUI 里直接打字（聊天框草稿管不到），这一轮不送，免得粘进你没打完的那行（2026-11-03 自查）
          if (
            pageVisibleRef.current &&
            tabId === focusedIdRef.current &&
            (surfaceModeRef.current[tabId] ?? defaultSurfaceRef.current) === "terminal"
          )
            continue;
          const action = tabActionsRef.current.get(tabId);
          if (!action) continue;
          const got = await invoke<[string[], string] | null>("mail_take", { runId: st.runId }).catch(() => null);
          if (!got) continue;
          const [ids, text] = got;
          const res = await action.sendMessage(text).catch((e) => ({ error: String(e) }));
          if (res.error) await invoke("mail_requeue", { ids }).catch(() => {});
        }
      } finally {
        mailBusyRef.current = false;
      }
    };
    const timer = window.setInterval(() => void tick(), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  // 一步分几路（2026-11-03 协作四期，fan-out.ts）：各路都写了做完标记，用这一步本来的复用键开收尾一路
  //（开工时拼好、存在 localStorage）；开了就删记录，三天还没到齐的不再等
  useEffect(() => {
    const tick = async () => {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key?.startsWith(FANOUT_STORAGE_PREFIX)) keys.push(key);
      }
      for (const key of keys) {
        let pending: FanOutPending;
        try {
          pending = JSON.parse(localStorage.getItem(key) ?? "") as FanOutPending;
        } catch {
          localStorage.removeItem(key);
          continue;
        }
        if (pending.mergeStarted || (pending.createdAt && Date.now() - pending.createdAt > FANOUT_EXPIRE_MS)) {
          localStorage.removeItem(key);
          continue;
        }
        const done = await invoke<number[]>("fan_out_done", { dir: pending.worktreePath }).catch(() => null);
        if (!done) continue;
        // 开工时没起来的路补开一次：没做完、没标签、也从没起过运行（2026-11-10 HER：第 1 路的标签被同一拍收标签抹掉，收尾永远等不齐）
        if (!allLanesDone(done, pending.lanes) && pageVisibleRef.current && pending.laneRequests?.length) {
          const reqs = pending.laneRequests as PendingTerminal[];
          const runs = await invoke<RunDto[]>("run_list", { projectRoot: null }).catch(() => null);
          if (runs) {
            const heal = lanesToHeal({
              lanes: pending.lanes,
              done,
              laneKeys: reqs.map((r) => r.reuseKey),
              openKeys: new Set(tabsRef.current.map((t) => t.reuseKey).filter((k): k is string => !!k)),
              ranKeys: new Set(runs.map((r) => r.reuseKey).filter((k): k is string => !!k)),
              healed: pending.healed ?? [],
            });
            for (const k of heal) {
              if (await openTerminalInTurn(reqs[k - 1]!)) {
                pending.healed = [...(pending.healed ?? []), k];
                localStorage.setItem(key, JSON.stringify(pending));
                toast(`「${pending.stepName}」第 ${k} 路刚才没开起来，已补开。`, "info");
              }
            }
          }
        }
        if (!allLanesDone(done, pending.lanes)) continue;
        // 终端页不在前台时收不下开工请求：等人回到对话页再开，记录留着（2026-11-03 自查：原先先删记录再交请求，没收下就丢了收尾）
        if (!pageVisibleRef.current) continue;
        if (!(await openTerminalInTurn(pending.merge as PendingTerminal))) continue;
        localStorage.removeItem(key);
        toast(`「${pending.stepName}」${pending.lanes} 路都做完了，开了收尾一路写共享文件和验收摘要。`, "info");
      }
    };
    const timer = window.setInterval(() => void tick(), 20_000);
    return () => window.clearInterval(timer);
  }, []);
  // 只看没接的标签发出第一句、Agent 起来了：它就是一段正在用的对话，不再算「只看」——
  // 不然 Agent 之后退出、切走时会被当成看了没说的顺手收掉
  useEffect(() => {
    if (!tabs.some((t) => t.preview && statuses[t.id]?.running)) return;
    setTabs((prev) =>
      prev.map((t) => (t.preview && statuses[t.id]?.running ? { ...t, preview: undefined } : t)),
    );
  }, [tabs, statuses]);
  useEffect(() => {
    const id = dropBlankAfterOpenRef.current;
    if (!id || activeId === id) return;
    dropBlankAfterOpenRef.current = null;
    const tab = tabs.find((t) => t.id === id);
    if (
      tab &&
      id !== splitTabId &&
      isThrowawayTab(tab, statusesRef.current[id], Boolean(draftByTabRef.current[id]))
    ) {
      delete draftByTabRef.current[id];
      doCloseTab(id);
    } else if (
      tab &&
      id !== splitTabId &&
      !draftByTabRef.current[id] &&
      isExitedAgentTab(tab, statusesRef.current[id]) &&
      Date.now() - (exitedSinceRef.current[id] ?? Date.now()) >= EXITED_GRACE_MS
    ) {
      // Agent 已经退出、退回 shell 的那段，切走也收（shell 里有命令在跑的不收，collectExitedTab 先问后端）
      void collectExitedTab(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, tabs]);

  /** Agent 退出、退回 shell 的标签（2026-10-26 用户定）：侧栏那一行没有光标也不给 ×，Mesa 自己收——切走时（上面）、
   *  没人看着时每分钟（idleTick）。退回满 EXITED_GRACE_MS 才收：换模型 / 换权限中间那一下也是退回 shell。
   *  shell 里有命令在跑（pty_shell_busy）不收，等跑完、下一分钟再看 */
  const exitedSinceRef = useRef<Record<string, number>>({});
  useEffect(() => {
    exitedSinceRef.current = exitedCollectPass({
      tabs,
      statuses,
      kept: new Set(),
      since: exitedSinceRef.current,
      now: Date.now(),
    }).since;
  }, [tabs, statuses]);
  const doCloseTabRef = useRef(doCloseTab);
  doCloseTabRef.current = doCloseTab;
  const splitTabIdRef = useRef(splitTabId);
  splitTabIdRef.current = splitTabId;
  const collectingExitedRef = useRef(new Set<string>());
  async function collectExitedTab(id: string) {
    const ptyId = statusesRef.current[id]?.ptyId;
    if (!ptyId || collectingExitedRef.current.has(id)) return;
    collectingExitedRef.current.add(id);
    try {
      const busy = await invoke<boolean>("pty_shell_busy", { ptyId }).catch(() => true);
      if (busy) return;
      // 问后端这一会儿可能又切回来了、写了字、或者接回了：按最新状态再判一次
      const tab = tabsRef.current.find((t) => t.id === id);
      if (
        !tab ||
        id === activeIdRef.current ||
        id === splitTabIdRef.current ||
        draftByTabRef.current[id] ||
        !isExitedAgentTab(tab, statusesRef.current[id])
      )
        return;
      delete exitedSinceRef.current[id];
      void invoke("drop_terminal_replay", { tabId: id }).catch(() => {});
      doCloseTabRef.current(id);
    } finally {
      collectingExitedRef.current.delete(id);
    }
  }

  // —— 标签条撤掉之后（2026-10-24 侧栏挂对话第二期）：开着的东西列在侧栏，关、切、收都不靠标签条 ——
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  /** 对话头 ⋯ 菜单的位置 */
  const [headMenu, setHeadMenu] = useState<{ x: number; y: number } | null>(null);

  // 侧栏发来的「关掉这个标签」（在跑的照旧先确认）
  const closeTabReq = useAppStore((s) => s.closeTabReq);
  useEffect(() => {
    if (!closeTabReq) return;
    useAppStore.getState().requestCloseTab(null);
    if (tabs.some((t) => t.id === closeTabReq.tabId)) void requestCloseTab(closeTabReq.tabId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeTabReq]);

  // 空闲对话的后台进程自动收（idle-stop.ts）：回完话、你也没在看的普通对话，空闲满 30 分钟停掉进程、收掉标签，
  // 记录还在侧栏，再点开发一句就接回。每分钟看一次，一次收一个（doCloseTab 读当次渲染的 tabs，连收会互相覆盖）
  const idleSinceRef = useRef<Record<string, number>>({});
  const idleTickRef = useRef<() => void>(() => {});
  idleTickRef.current = () => {
    const kept = new Set<string>([activeId]);
    if (splitTabId) kept.add(splitTabId);
    for (const [id, has] of Object.entries(draftByTabRef.current)) if (has) kept.add(id);
    const { since, stop } = idleStopPass({
      tabs,
      statuses,
      kept,
      since: idleSinceRef.current,
      now: Date.now(),
    });
    idleSinceRef.current = since;
    const id = stop[0];
    if (!id) {
      // 这一分钟没有要停的在跑对话，再看有没有 Agent 已退出、没人看着的（一次收一个，同上）
      const exited = exitedCollectPass({
        tabs,
        statuses,
        kept,
        since: exitedSinceRef.current,
        now: Date.now(),
      });
      exitedSinceRef.current = exited.since;
      if (exited.collect[0]) void collectExitedTab(exited.collect[0]);
      return;
    }
    delete idleSinceRef.current[id];
    const title = statuses[id]?.title;
    void invoke("drop_terminal_replay", { tabId: id }).catch(() => {});
    doCloseTab(id);
    toast(
      `${title && title !== "终端" ? `「${title}」` : "一段对话"}空闲了 30 分钟，已停下 Agent；记录在侧栏，点开发一句就接回`,
      "info",
    );
  };
  useEffect(() => {
    const timer = window.setInterval(() => idleTickRef.current(), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // 重启后只回到上次看的那段：别的恢复占位若进程已经不在（应用重启过），收掉——它们的记录都在侧栏；
  // 网页重载（开发热更新）时进程还活着的照旧接回（pty_id_for_run 认得出）
  useEffect(() => {
    const others = initialState.tabs.filter((t) => t.restored && t.id !== initialState.activeId);
    if (others.length === 0) return;
    let cancelled = false;
    void (async () => {
      const drop = new Set<string>();
      for (const t of others) {
        const live = t.runId
          ? await invoke<string | null>("pty_id_for_run", { runId: t.runId }).catch(() => null)
          : null;
        if (!live) drop.add(t.id);
      }
      if (cancelled || drop.size === 0) return;
      for (const id of drop) void invoke("drop_terminal_replay", { tabId: id }).catch(() => {});
      setTabs((prev) => {
        const keep = prev.filter((t) => !(drop.has(t.id) && t.restored && t.id !== activeIdRef.current));
        return keep.length > 0 ? keep : prev;
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ⌃Tab / ⌃⇧Tab：在最近看过的对话之间切（上一段 / 最早那段）
  const mruRef = useRef<string[]>([]);
  useEffect(() => {
    mruRef.current = [activeId, ...mruRef.current.filter((id) => id !== activeId)];
  }, [activeId]);
  const activateTabRef = useRef(activateTab);
  activateTabRef.current = activateTab;
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.key !== "Tab") return;
      const open = new Set(tabsRef.current.map((t) => t.id));
      const order = mruRef.current.filter((id) => open.has(id));
      if (order.length < 2) return;
      e.preventDefault();
      e.stopPropagation();
      // 会用了：侧栏来回点的提醒不用再出（coach-tips.ts）
      markCoachTipSeen("switchBack");
      activateTabRef.current(e.shiftKey ? order[order.length - 1] : order[1]);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [visible]);

  // 聊天 / 终端来回切（默认 ⌘⇧T / Ctrl+Shift+T，设置页可改）：捕获阶段挂 window，光标在终端里也先于 xterm 拿到
  const toggleSurfaceCombo = useAppStore(
    (s) => s.settings?.hotkeyToggleSurface ?? DEFAULT_TOGGLE_SURFACE_HOTKEY,
  );
  const toggleSurfaceRef = useRef(toggleSurface);
  toggleSurfaceRef.current = toggleSurface;
  useEffect(() => {
    if (!visible || !toggleSurfaceCombo) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || !eventMatchesCombo(e, toggleSurfaceCombo)) return;
      e.preventDefault();
      e.stopPropagation();
      // 切回聊天时光标还在被盖住的终端里，接着打的字会进 PTY：先放掉，聊天输入框随后自己要焦点
      const el = document.activeElement;
      if (el instanceof HTMLElement && el.closest(".xterm")) el.blur();
      markCoachTipSeen("surfaceKey");
      toggleSurfaceRef.current("hotkey");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [visible, toggleSurfaceCombo]);

  // 关掉正看着的这段（Windows / Linux Ctrl+Shift+W；分屏时是光标所在那一侧）。macOS 的 ⌘W 是「文件 → 关闭对话」
  // 菜单加速键，先被菜单接走、经 menu:action 到 App.tsx，这里不再接，免得一次按键关两回
  const focusedIdRef = useRef(focusedId);
  focusedIdRef.current = focusedId;
  const requestCloseTabRef = useRef(requestCloseTab);
  requestCloseTabRef.current = requestCloseTab;
  useEffect(() => {
    if (!visible || IS_MAC) return;
    const combo = closeChatCombo(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || !eventMatchesCombo(e, combo)) return;
      e.preventDefault();
      e.stopPropagation();
      // 确认框开着时不接（同 App.tsx ⌘W）：再弹会把正在问的那件事顶掉
      if (confirmDialogOpen()) return;
      markCoachTipSeen("closeKey");
      void requestCloseTabRef.current(focusedIdRef.current);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [visible]);

  function doCloseTab(id: string) {
    // 按最新的标签列表算、用函数式更新提交：自动收标签（空闲 / 已退出 / 空白新对话）和新开标签同一拍发生时，
    // 拿当次渲染的旧列表 setTabs(next) 会把刚加的标签一起抹掉（2026-11-10 HER：Mesa 重启后首次开工分 4 路，第 1 路的标签凭空没了）
    const latest = tabsRef.current;
    const idx = latest.findIndex((t) => t.id === id);
    const remaining = latest.filter((t) => t.id !== id);
    const fresh: Tab = {
      id: crypto.randomUUID(),
      skipSeed: true,
    };
    let nextActiveId = activeId;
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      // 至少保留一个标签
      return next.length > 0 ? next : [fresh];
    });
    if (remaining.length === 0) {
      nextActiveId = fresh.id;
      setActiveId(fresh.id);
    } else if (id === activeId) {
      nextActiveId = remaining[Math.max(0, idx - 1)].id;
      setActiveId(nextActiveId);
    }
    // 分屏修正：被关的是右 pane 标签，或关闭后活跃标签与右 pane 撞车时退出分屏
    if (splitTabId === id || splitTabId === nextActiveId) {
      setSplitTabId(null);
      setActivePane("left");
    }
    // 被关标签的 TerminalView 卸载时会自行杀掉 PTY（其 unmount 清理路径）
    setStatuses((prev) => {
      const n = { ...prev };
      delete n[id];
      return n;
    });
    setSessionByTab((prev) => {
      const n = { ...prev };
      delete n[id];
      return n;
    });
    setWritableForks((prev) => {
      if (!(id in prev)) return prev;
      const n = { ...prev };
      delete n[id];
      return n;
    });
    setSurfaceModeByTab((prev) => {
      if (!(id in prev)) return prev;
      const n = { ...prev };
      delete n[id];
      return n;
    });
    setTabProgress((prev) => {
      if (!(id in prev)) return prev;
      const n = { ...prev };
      delete n[id];
      return n;
    });
    // run 脚本互斥登记随标签关闭释放
    for (const [wsId, tabId] of Object.entries(runningScriptsRef.current)) {
      if (tabId === id) setRunningScript(wsId, null);
    }
  }

  // 退出前存回放：退出确认在 App.tsx（mesa:quit-requested），关窗口默认只藏到后台（window_close.rs）
  useEffect(() => {
    let disposed = false;
    // Rust 侧的退出前置信号（lib.rs ExitRequested）：发这条事件、等 350ms 再收尾退出——
    // 这里接住并分发各标签的回放存盘（JS onCloseRequested 实机不执行，2026-10-11 探针实证）
    let unlistenFlush: (() => void) | undefined;
    void listen("mesa:flush-before-close", () => {
      window.dispatchEvent(new CustomEvent("mesa:save-terminal-replays"));
    }).then((u) => {
      if (disposed) u();
      else unlistenFlush = u;
    });
    return () => {
      disposed = true;
      unlistenFlush?.();
    };
  }, []);

  const railBtn =
    "flex h-7 w-7 items-center justify-center rounded-sm text-xs text-l4 hover:bg-hover hover:text-l2";

  // 运行中输入汇总（P5）：状态全部来自现有 statuses 上报，不新增轮询；
  // inputs 镜像进 store（terminalRunInputs），供工作区首页「待你处理」跨页聚合只读
  // （排序/分类由首页自行用 buildRunOverview 完成）。
  const setTerminalRunInputs = useAppStore((s) => s.setTerminalRunInputs);
  // 卡在哪（2026-11-06 run-blocker.ts）：十几个判断归成一个，调度台、收件箱、手机只读它；只按卡法本身变化重算，不跟着对话刷新
  const blockerOf = (t: (typeof tabs)[number]): RunBlocker | null => {
    const st = statuses[t.id];
    const ss = sessionByTab[t.id];
    const p = ss?.trustPrompt;
    const input = tabRunInput(t, st);
    return runBlocker({
      running: input.running,
      shell: input.shell,
      attention: input.attention,
      isGoal: !!input.taskId,
      trust: p ? { yes: p.options[p.yesIndex] ?? "", no: p.options[p.noIndex] ?? "", path: p.path } : null,
      menuQuestion: ss?.menuPrompt?.question ?? null,
      hasMenu: !!ss?.menuPrompt,
      waitTitle: ss?.waitScreen?.title ?? null,
      launchFailureCode: ss?.launchFailure?.code ?? null,
      loginScreen: loginScreenLabel(ss?.specialScreen ?? null, !!ss?.grokLoginStuck),
      connIssue: !!ss?.connIssue,
      stalled: !!ss?.stalled,
    });
  };
  const blockerSig = tabs.map((t) => JSON.stringify(blockerOf(t))).join("\u0002");
  const runInputs: RunOverviewInput[] = useMemo(
    () =>
      tabs.map((t) => {
        const input = tabRunInput(t, statuses[t.id]);
        const blocker = blockerOf(t);
        return blocker ? { ...input, blocker } : input;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabs, statuses, blockerSig],
  );
  useEffect(() => {
    setTerminalRunInputs(runInputs);
  }, [runInputs, setTerminalRunInputs]);
  // 别处（调度台、手机上的项目助手）要替人按信任菜单：仍是人点的那一下，只是从别处点；交给那个标签按原来的读屏核对再回车
  const trustAnswerReq = useAppStore((s) => s.trustAnswerReq);
  useEffect(() => {
    if (!trustAnswerReq) return;
    useAppStore.getState().setTrustAnswerReq(null);
    tabActionsRef.current.get(trustAnswerReq.tabId)?.answerTrust(trustAnswerReq.accept);
  }, [trustAnswerReq]);
  // 正看着的标签（分屏时是活跃那一栏）：侧栏项目树据此高亮「正在看的这段对话」、默认展开它的文件夹
  const setTerminalActiveTabId = useAppStore((s) => s.setTerminalActiveTabId);
  useEffect(() => {
    setTerminalActiveTabId(focusedId);
  }, [focusedId, setTerminalActiveTabId]);

  // 可合并 pill 数据：归属口径与 ProjectRail 一致（cwd 落工作树→其 repo；落 repo→该仓；
  // 注册项目兜底），健康检查只对当前项目的活跃工作区做（同工作区页 Promise.all 模式）
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void (async () => {
      try {
        const active = (await invoke<WorkspaceDto[]>("list_workspaces")).filter(
          (w) => w.status === "active",
        );
        let root: string | null = null;
        for (const w of active) {
          if (pathWithin(activeCwd, w.worktreePath)) {
            root = w.repoPath;
            break;
          }
        }
        if (!root) {
          for (const w of active) {
            if (pathWithin(activeCwd, w.repoPath)) {
              root = w.repoPath;
              break;
            }
          }
        }
        if (!root) {
          const projects = await invoke<ProjectDto[]>("list_projects").catch(
            () => [] as ProjectDto[],
          );
          for (const p of projects) {
            if (pathWithin(activeCwd, p.path)) {
              root = p.path;
              break;
            }
          }
        }
        const rootPath = root;
        const candidates = rootPath
          ? active.filter(
              (w) =>
                pathWithin(w.repoPath, rootPath) &&
                pathWithin(rootPath, w.repoPath),
            )
          : [];
        const names = (
          await Promise.all(
            candidates.map(async (w) => {
              try {
                const h = await invoke<WorkspaceHealthDto>("workspace_health", {
                  id: w.id,
                });
                return h.readyToMerge ? w.name : null;
              } catch {
                return null;
              }
            }),
          )
        ).filter((n): n is string => n != null);
        if (!cancelled) setMergeReadyWs(names);
      } catch {
        if (!cancelled) setMergeReadyWs([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeCwd, visible, refreshKey, fsChangeTick, reviewPath, wsPillTick]);

  // 工作区归档后刷新 pill（工作区集合已变）
  useEffect(() => {
    let un: (() => void) | undefined;
    listen("ws-archived", () => setWsPillTick((t) => t + 1)).then(
      (u) => (un = u),
    );
    return () => un?.();
  }, []);

  return (
    <div
      ref={terminalRootRef}
      className="terminal-workbench relative flex h-full bg-canvas"
      onKeyDownCapture={(event) => {
        if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "f") return;
        const target = event.target as HTMLElement;
        if (target.closest(".monaco-editor, .md-find-scope, .xterm, [data-terminal-search]")) return;
        const chatId = target.closest<HTMLElement>("[data-chat-host]")?.dataset.chatHost;
        if (!chatId && focusedSurfaceMode !== "chat") return;
        event.preventDefault();
        event.stopPropagation();
        openChatSearch(chatId ?? focusedId);
      }}
    >
      {/* 中带：终端标签区。向上盖 1px，挡住顶栏透出的那条窗口黑缝。 */}
      <div className="@container/chat-head relative -mt-px flex min-w-0 flex-1 flex-col bg-canvas">
        {/* 对话头（2026-10-24 侧栏挂对话第二期）：标签条撤掉，侧栏就是对话列表——切换、新开、看谁在跑都在侧栏。
            这里只写正看着的这段：生成中 / 等你确认、标题、终端上报的进度。不放 ×（同日用户问「× 的作用是什么」）：
            对话没有「关」，AI 进程空闲 30 分钟自己收，要立刻停走侧栏对话 ⋯「停下 Agent」 */}
        <div className="flex h-9 items-center gap-1 overflow-hidden px-2">
          {(() => {
            const s = statuses[focusedId];
            // 写这段对话的标题（和侧栏同一个：自动起名去掉「MMDD|类型|」）；还没说话的写「新对话」，纯终端写终端名
            const meta =
              s?.sessionId
                ? headSessions.find((x) => x.agent === s.agentId && x.sessionId === s.sessionId)
                : undefined;
            const fallback = s?.title && s.title !== "终端" ? s.title : "终端";
            const title = meta
              ? sidebarChatTitle(tidySessionTitle(meta).title)
              : s && !s.shell && !s.running && !s.sessionId
                ? "新对话"
                : fallback;
            const p = tabProgress[focusedId];
            return (
              <div className="flex h-8 min-w-0 flex-1 items-center gap-1.5 px-1.5 text-xs text-l2">
                {/* 标题不加粗、不顶到最亮（l2）：它是「现在在哪」的提示，不是页面主角（2026-10-24 用户） */}
                <span className="min-w-0 truncate text-l2" title={title}>
                  {title}
                </span>
                {/* 标题后不画运行状态光标：侧栏这一行已经有，下面的回合进度也看得见（2026-10-25 用户） */}
                {/* 任务进度徽章（终端 OSC 9;4 上报）：state 0 = 结束不显示，1 带百分比，2 = 错误（!），3/4 = 进行中/暂停（…） */}
                {p && p.state !== 0 && (
                  <span
                    className={`shrink-0 text-micro ${p.state === 2 ? "text-err-text" : "text-l4"}`}
                    title={p.state === 2 ? "任务报错（终端上报）" : "任务进度（终端上报）"}
                  >
                    {p.state === 1 && p.progress != null ? `${Math.round(p.progress)}%` : p.state === 2 ? "!" : "…"}
                  </span>
                )}
                {/* 聊天层不放 ✦：输入框「＋」里有同一份「插入技能 / MCP」（2026-10-21 用户拍板） */}
                {s?.ptyId && (surfaceModeByTab[focusedId] ?? defaultSurface) !== "chat" && (
                  <button
                    type="button"
                    title="插入技能或 MCP"
                    aria-label="插入技能或 MCP"
                    onClick={(event) => {
                      const r = event.currentTarget.getBoundingClientRect();
                      tabActionsRef.current
                        .get(focusedId)
                        ?.toggleInsert({ left: r.left, bottom: r.bottom });
                    }}
                    className="flex size-5 shrink-0 items-center justify-center rounded-full text-l4 hover:bg-hover hover:text-l2"
                  >
                    <Sparkles size={13} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                )}
              </div>
            );
          })()}
          {/* 右上角三个（2026-10-24 照 Claude 客户端「一个图标管一块，亮着就是开着」重做，原 聊天/终端 · 成果面板 · 分屏 · 查找 四个）：
              >_ 终端（亮着 = 正看着这段对话的终端）、± 改动（右栏改动窗格，有改动带数字）、⋯ 更多（分屏、查找、启动配置行、文件预览）。
              「成果面板」一词取消：文件预览由左边点文件打开，改动由 ± 打开，右栏自己带收起 */}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={(e) => {
                // 用鼠标来回切到第 3 下时提醒快捷键（shortcut-nudges.tsx）：挂在按钮下面
                noteMouseToggleSurface(e.currentTarget.getBoundingClientRect(), toggleSurfaceCombo);
                toggleSurface("tab-bar");
              }}
              aria-pressed={focusedSurfaceMode !== "chat"}
              title={`${focusedSurfaceMode === "chat" ? "看这段对话的终端" : "回到聊天"}${
                toggleSurfaceCombo ? `（${comboLabel(toggleSurfaceCombo)}）` : ""
              }`}
              aria-label={focusedSurfaceMode === "chat" ? "看这段对话的终端" : "回到聊天"}
              className={`flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-md px-1.5 transition-colors ${
                focusedSurfaceMode !== "chat" ? "bg-seg-sel text-l1" : "text-l4 hover:bg-hover hover:text-l2"
              }`}
            >
              <TerminalIcon size={15} strokeWidth={1.8} aria-hidden="true" />
            </button>
            {(() => {
              const changesOpen = rightOpen && rightTab === "git";
              const count = gitTotals && gitTotals.add + gitTotals.del > 0 ? gitTotals.files.length : 0;
              return (
                <button
                  type="button"
                  onClick={() => {
                    if (changesOpen) closeRightPanel();
                    else {
                      setRightTab("git");
                      persistRightOpen(true);
                    }
                  }}
                  aria-pressed={changesOpen}
                  title={
                    changesOpen
                      ? "收起改动"
                      : count > 0
                        ? `改动：这个文件夹里 ${count} 个文件没提交（+${gitTotals!.add} −${gitTotals!.del}）`
                        : "改动"
                  }
                  aria-label={changesOpen ? "收起改动" : "看改动"}
                  className={`relative flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-md px-1.5 transition-colors ${
                    changesOpen ? "bg-seg-sel text-l1" : "text-l4 hover:bg-hover hover:text-l2"
                  }`}
                >
                  <FileDiff size={15} strokeWidth={1.8} aria-hidden="true" />
                  {/* 有改动只点一个小点，个数放悬停（文件夹里别的会话的改动也算在内，写个大数字像是这段对话改的） */}
                  {count > 0 && !changesOpen && (
                    <span className="absolute right-1 top-1 size-1.5 rounded-full bg-l3" aria-hidden="true" />
                  )}
                </button>
              );
            })()}
            {(() => {
              const filesOpen = rightOpen && rightTab === "preview";
              return (
                <button
                  type="button"
                  onClick={toggleFilesPane}
                  aria-pressed={filesOpen}
                  title={filesOpen ? "收起文件" : "文件：这段对话文件夹里的文件，点开就在右边看"}
                  aria-label={filesOpen ? "收起文件" : "看文件"}
                  className={`flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-md px-1.5 transition-colors ${
                    filesOpen ? "bg-seg-sel text-l1" : "text-l4 hover:bg-hover hover:text-l2"
                  }`}
                >
                  <FolderTree size={15} strokeWidth={1.8} aria-hidden="true" />
                </button>
              );
            })()}
            <button
              type="button"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setHeadMenu({ x: r.right, y: r.bottom + 4 });
              }}
              aria-haspopup="menu"
              aria-expanded={headMenu != null}
              title="更多：分屏对照、查找终端输出、关掉这段对话…"
              aria-label="更多操作"
              className={`flex size-7 items-center justify-center rounded-md transition-colors ${
                headMenu ? "bg-hover text-l1" : "text-l4 hover:bg-hover hover:text-l2"
              }`}
            >
              <MoreHorizontal size={15} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </span>
          {headMenu && (
            <ContextMenu
              x={headMenu.x}
              y={headMenu.y}
              alignRight
              onClose={() => setHeadMenu(null)}
              items={[
                {
                  label: "搜索聊天",
                  icon: Search,
                  title: "在这段对话的消息、命令和输出里找字",
                  onSelect: () => { if (focusedSurfaceMode !== "chat") switchSurface("chat"); openChatSearch(focusedId); },
                },
                {
                  label: splitActive ? "退出分屏" : "分屏对照",
                  icon: Columns2,
                  disabled: !splitActive && tabs.length < 2,
                  title:
                    !splitActive && tabs.length < 2
                      ? "先开着两段对话；或在侧栏对话 ⋯ 里选「在右侧分屏打开」"
                      : splitActive
                        ? "回到一段"
                        : "左右两段对着看",
                  onSelect: () => {
                    if (focusedSurfaceMode === "chat") switchSurface("terminal");
                    toggleSplit();
                  },
                },
                {
                  label: "查找终端输出",
                  icon: Search,
                  title: "在这段对话的终端输出里找字（会切到终端）",
                  onSelect: () => {
                    if (focusedSurfaceMode === "chat" && !peekByTab[focusedId]) {
                      switchSurface("terminal");
                    }
                    tabActionsRef.current.get(focusedId)?.search();
                  },
                },
                ...(compactBarHidden
                  ? [
                      {
                        label: "显示启动配置行",
                        icon: PanelTopOpen,
                        title: "终端上方那一行（插入 / 修改 / 更多操作）",
                        onSelect: toggleCompactBar,
                      },
                    ]
                  : []),
                // 关掉放最后、和上面隔开：停下 Agent 不是查看类动作（2026-10-26 用户定三处入口之一，主要让人发现快捷键）
                { separator: true },
                {
                  label: "关掉这段对话",
                  icon: X,
                  hint: comboLabel(closeChatCombo(IS_MAC)),
                  title: "停下这段对话的 Agent、收起它；记录还在侧栏，再点开发一句就接回（在干活或等你确认的会先问你）",
                  onSelect: () => {
                    // 用鼠标关到第 2 段时提醒快捷键（shortcut-nudges.tsx）：挂在 ⋯ 下面
                    noteMouseCloseChat(
                      { left: headMenu.x - 28, right: headMenu.x, top: headMenu.y - 32, bottom: headMenu.y - 4 },
                      "below",
                    );
                    void requestCloseTab(focusedId);
                  },
                },
              ]}
            />
          )}
        </div>
        <div
          ref={splitAreaRef}
          className={`min-h-0 flex-1${splitActive ? " flex" : ""}`}
        >
          {/* 所有标签保持挂载，仅隐藏不可见标签，运行中的会话与 scrollback 得以保留。
              分屏时靠 flex order 把活跃标签（左）与对照标签（右）排到分隔条两侧，
              标签在 pane 间切换只是显隐与排序变化，TerminalView 不重挂载、xterm 不重建 */}
          {tabs.map((t) => {
            const isLeftPane = splitActive && t.id === activeId;
            const isRightPane = splitActive && t.id === splitTabId;
            const tabVisible =
              visible &&
              (splitActive ? isLeftPane || isRightPane : t.id === activeId);
            // 可见 pane 统一 flex 纵排：pane 小头 + 终端主体；单标签时小头不渲染，布局不变
            const paneClass = !tabVisible
              ? "hidden"
              : isLeftPane
                ? "flex h-full min-w-0 shrink-0 flex-col"
                : isRightPane
                  ? "flex h-full min-w-0 flex-1 flex-col"
                  : "flex h-full flex-col";
            const paneStyle = isLeftPane
              ? { order: 0, width: `${splitPct}%` }
              : isRightPane
                ? { order: 2 }
                : undefined;
            const view = (
              <TerminalView
                visible={tabVisible}
                primaryFocus={t.id === focusedId}
                rightOpen={rightOpen}
                compactBarHidden={compactBarHidden}
                onToggleCompactBar={toggleCompactBar}
                layoutKey={`${rightOpen}-${layout.right}-${rightExpanded}-${splitActive ? `split${Math.round(splitPct)}` : "single"}-${(surfaceModeByTab[t.id] ?? defaultSurface) === "chat" && peekByTab[t.id] ? "peek" : "full"}-${reader && readerTabId === t.id ? "reader" : "pane"}-${appSettings?.statusBar === false ? "nostatus" : "status"}`}
                embedInPeek={
                  (surfaceModeByTab[t.id] ?? defaultSurface) === "chat" &&
                  Boolean(peekByTab[t.id])
                }
                coveredByChat={
                  (surfaceModeByTab[t.id] ?? defaultSurface) === "chat" &&
                  !peekByTab[t.id]
                }
                gitTotals={t.id === focusedId ? gitTotals : null}
                termBg={statusBarColors.background}
                statusBarOn={appSettings?.statusBar ?? true}
                tabId={t.id}
                skipSeed={t.skipSeed}
                initialCwd={t.initialCwd}
                initialExtraEnv={t.initialExtraEnv}
                initialTitle={t.initialTitle}
                initialAgentId={t.initialAgentId}
                initialProfileId={t.initialProfileId}
                initialModel={t.initialModel}
                resumeSessionId={t.resumeSessionId}
                forkSessionId={t.forkSessionId}
                resumeProvider={t.resumeProvider}
                autoStart={t.autoStart}
                resumeKick={t.resumeKick}
                prefillCommand={t.prefillCommand}
                shellOnly={t.shellOnly}
                customRuntimeId={t.customRuntimeId}
                initialPrompt={t.initialPrompt}
                readonly={t.readonly && !writableForks[t.id]}
                permission={
                  writableForks[t.id]
                    ? "write_tree"
                    : t.permission ?? (t.readonly ? "discuss" : "write_tree")
                }
                effortOverride={t.effort ?? undefined}
                permissionMode={writableForks[t.id] ? null : (t.permissionMode ?? null)}
                submitCsiU={
                  agents.find(
                    (a) => a.id === (statuses[t.id]?.agentId ?? t.initialAgentId),
                  )?.submitCsiU ?? false
                }
                restored={t.restored}
                stepClaimName={t.stepName}
                reuseKey={t.reuseKey}
                initialRunId={t.runId}
                taskId={t.taskId}
                launchSeed={t.launchSeed}
                externalCwd={t.id === focusedId ? enterCwd : null}
                onConsumeExternalCwd={consumeExternalCwd}
                onStatus={reportStatus}
                onSessionUpdate={reportSession}
                onActions={registerActions}
                onRestoreComplete={finishRestore}
                onConsumeResume={clearResumeSession}
                onForkChat={handleTabForkChat}
                onConversationInsert={conversationInsert}
                onSearchChat={openChatSearch}
                onPatchLaunch={patchTabLaunch}
                getConversationActions={getConversationActions}
                onOpenPath={handleTerminalOpenPath}
                onProgress={handleTabProgress}
              />
            );
            return (
              <div
                key={t.id}
                className={paneClass}
                style={
                  tabVisible
                    ? { ...paneStyle, background: statusBarColors.background }
                    : paneStyle
                }
                onPointerDownCapture={
                  splitActive && tabVisible
                    ? () => setActivePane(isRightPane ? "right" : "left")
                    : undefined
                }
              >
                {/* pane 小头（32px，仅分屏时渲染）：左 pane 标签名 / 右 pane 对照选择器，
                    各带「关闭该 pane」；pane 级操作集中在这里，全局工具行不变。
                    小头与主体都带固定 key，进出分屏只是插入/移除兄弟节点，
                    pane-body 与其中的 TerminalView 始终原位更新、不重挂载 */}
                {(isLeftPane || isRightPane) && (
                  <div
                    key="pane-head"
                    className="flex h-8 shrink-0 items-center gap-1.5 bg-strip px-2"
                  >
                    {isRightPane ? (
                      <>
                        <span className="shrink-0 text-micro text-l4">
                          对照
                        </span>
                        <select
                          value={splitTabId ?? ""}
                          onChange={(e) => setSplitTabId(e.target.value)}
                          className="h-6 min-w-0 flex-1 rounded-sm border border-field bg-inset px-1.5 text-xs text-l2 outline-none focus:border-l4"
                          title="选右边对照的那段（开着的对话；别的从侧栏对话 ⋯「在右侧分屏打开」）"
                        >
                          {tabs
                            .filter((other) => other.id !== activeId)
                            .map((other) => (
                              <option key={other.id} value={other.id}>
                                {statuses[other.id]?.title ?? "终端"}
                              </option>
                            ))}
                        </select>
                      </>
                    ) : (
                      <>
                        <span className="shrink-0 text-micro text-l4">
                          当前
                        </span>
                        <span className="min-w-0 flex-1 truncate text-xs text-l2">
                          {statuses[t.id]?.title ?? "终端"}
                        </span>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => closePane(isRightPane ? "right" : "left")}
                      title={
                        isRightPane
                          ? "关掉右边这栏（退出分屏，留左边这段）"
                          : "关掉左边这栏（退出分屏，换成右边那段）"
                      }
                      aria-label="关闭此 pane"
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-xs text-l4 hover:bg-hover hover:text-l1"
                    >
                      ×
                    </button>
                  </div>
                )}
                <div key="pane-body" className="flex min-h-0 flex-1 flex-col">
                  {(() => {
                    const chatOn =
                      (surfaceModeByTab[t.id] ?? defaultSurface) ===
                      "chat";
                    const peek = Boolean(peekByTab[t.id]);
                    // 阅读区打开时聊天层宿主搬进右栏槽位：在那里要自己定位（pane 里交给包装层）
                    const inReader = Boolean(reader) && readerTabId === t.id;
                    const agentKey =
                      sessionByTab[t.id]?.agentId ??
                      statuses[t.id]?.agentId ??
                      t.initialAgentId;
                    const det = agents.find((a) => a.id === agentKey);
                    return (
                  <div
                    className={
                      chatOn && peek
                        ? "relative flex min-h-0 flex-1 flex-col"
                        : "relative min-h-0 flex-1"
                    }
                  >
                    {/* 窥视 = 底栏真实分栏（终端按此高度 fit）。不能只裁全高 xterm 的
                        底部：Codex 主对话是 inline，内容靠上、底下空行，裁底就是白板。
                        切聊天/终端仍用绝对铺满。进程起来之后不再通知改行列。 */}
                    <div
                      className={
                        chatOn && peek
                          ? "relative order-2 min-h-[7.5rem] shrink-0 overflow-hidden border-t border-hairline"
                          : "absolute inset-0"
                      }
                      style={
                        chatOn && peek
                          ? { height: `${Math.round(CHAT_PEEK_RATIO * 100)}%` }
                          : undefined
                      }
                    >
                      {view}
                    </div>
                    <div
                      className={
                        !chatOn
                          ? "hidden"
                          : peek
                            ? "relative order-1 min-h-0 min-w-0 flex-1"
                            : "absolute inset-0 z-20"
                      }
                    >
                      <div
                        data-chat-host={t.id}
                        className={
                          !inReader
                            ? "h-full"
                            : !chatOn
                              ? "hidden"
                              : peek
                                ? "relative order-1 min-h-0 min-w-0 flex-1"
                                : "absolute inset-0 z-20"
                        }
                      >
                      <StableChatSurface
                        // 藏着的标签（没在看、也不在阅读区右栏）：记录照常刷新，不重画，露出来那一下再画
                        frozen={!tabVisible && !inReader}
                        searchRequest={chatSearchByTab[t.id] ?? 0}
                        metaSlots={chatMetaSlots[t.id] ?? null}
                        messages={forkChatMessages(
                          sessionByTab[t.id]?.conv ?? [],
                          forkPreview[t.id],
                        )}
                        state={
                          forkPreview[t.id]?.length && !sessionByTab[t.id]?.conv.length
                            ? "linked"
                            : (sessionByTab[t.id]?.state ?? "idle")
                        }
                        syncState={sessionByTab[t.id]?.sync ?? "waiting"}
                        loading={sessionByTab[t.id]?.pendingReply ?? false}
                        cwd={statuses[t.id]?.cwd ?? t.initialCwd ?? null}
                        discussKey={t.reuseKey?.startsWith("discuss:") ? t.reuseKey : null}
                        discussStepName={t.stepName ?? null}
                        running={statuses[t.id]?.running ?? false}
                        canResume={statuses[t.id]?.canResume ?? false}
                        attention={statuses[t.id]?.attention ?? null}
                        readOnly={Boolean(t.readonly && !writableForks[t.id])}
                        readonlySupported={det?.readonlySupported ?? false}
                        busy={chatBusy}
                        skills={sessionByTab[t.id]?.skills ?? []}
                        mcps={sessionByTab[t.id]?.mcps ?? []}
                        onSend={sendChatToActive}
                        onAllowWrite={() => void allowWritableFork()}
                        onOpenTerminal={() =>
                          inReader ? setReaderSurface("terminal") : switchSurface("terminal")
                        }
                        active={chatOn}
                        agentId={agentKey ?? null}
                        confirmDetail={
                          sessionByTab[t.id]?.confirmDetail ?? null
                        }
                        trustPrompt={sessionByTab[t.id]?.trustPrompt ?? null}
                        ptyQuiet={sessionByTab[t.id]?.ptyQuiet ?? false}
                        launchPick={sessionByTab[t.id]?.launchPick ?? null}
                        relay={sessionByTab[t.id]?.relay ?? null}
                        onRelayPick={(target) => tabActionsRef.current.get(t.id)?.pickRelay(target)}
                        onRelayLoad={() => tabActionsRef.current.get(t.id)?.loadRelayOptions()}
                        recordPending={Boolean(t.resumeSessionId && !t.customRuntimeId && !sessionByTab[t.id])}
                        onRestore={() => tabActionsRef.current.get(t.id)?.restoreHere()}
                        onDraftChange={(has) => reportDraft(t.id, has)}
                        onPickDir={(pick) => tabActionsRef.current.get(t.id)?.pickDir(pick)}
                        onNewProject={() => tabActionsRef.current.get(t.id)?.newProject()}
                        onPickLaunch={{
                          agent: (id) => tabActionsRef.current.get(t.id)?.pickLaunchAgent(id),
                          profile: (id) => tabActionsRef.current.get(t.id)?.pickLaunchProfile(id),
                          model: (m) => tabActionsRef.current.get(t.id)?.pickLaunchModel(m),
                          // 思考档与权限是标签级的本次选择（开工弹层同口径），写回标签、下次启动生效
                          effort: (lv) =>
                            setTabs((prev) =>
                              prev.map((x) => (x.id === t.id ? { ...x, effort: lv || null } : x)),
                            ),
                          permission: (perm, mode) =>
                            setTabs((prev) =>
                              prev.map((x) =>
                                x.id === t.id
                                  ? { ...x, permission: perm, permissionMode: mode ?? null }
                                  : x,
                              ),
                            ),
                          // 「最近用过」的搭配：Agent / 连接 / 模型写进标签的启动栏，思考档是标签级的本次选择
                          combo: (c) => {
                            tabActionsRef.current.get(t.id)?.applyLaunchCombo(c);
                            setTabs((prev) =>
                              prev.map((x) => (x.id === t.id ? { ...x, effort: c.effort || null } : x)),
                            );
                          },
                        }}
                        onAnswerTrust={(accept) => {
                          tabActionsRef.current.get(t.id)?.answerTrust(accept);
                        }}
                        onInterrupt={chatInterrupt}
                        onSendNow={(keys) => tabActionsRef.current.get(t.id)?.writePty(keys)}
                        waitScreen={sessionByTab[t.id]?.waitScreen ?? null}
                        onWaitKey={(key) => tabActionsRef.current.get(t.id)?.pressWaitKey(key)}
                        onOpenLink={(url) => void openUrl(url).catch(() => {})}
                        firstRunNote={sessionByTab[t.id]?.firstRunNote ?? null}
                        launchFailure={sessionByTab[t.id]?.launchFailure ?? null}
                        onLaunchAgain={() => tabActionsRef.current.get(t.id)?.launchAgain()}
                        onDismissLaunchFailure={() => tabActionsRef.current.get(t.id)?.dismissLaunchFailure()}
                        launchBlock={sessionByTab[t.id]?.launchBlock ?? null}
                        onFixGeminiAuth={() => tabActionsRef.current.get(t.id)?.fixGeminiAuth()}
                        onDismissLaunchBlock={() => tabActionsRef.current.get(t.id)?.dismissLaunchBlock()}
                        specialScreen={sessionByTab[t.id]?.specialScreen ?? null}
                        onApprovalKey={(key) => {
                          chatApprovalKey(key);
                        }}
                        peek={peek}
                        onTogglePeek={() => setPeek(t.id, !peek, true)}
                        modelSwitch={runtimeModelSwitch(
                          det?.modelSwitch ?? null,
                          agentKey,
                          profiles.find((p) => p.id === statuses[t.id]?.profileId)?.accountType,
                        )}
                        hooksEnabled={Boolean(
                          appSettings?.hooksAttention?.[agentKey ?? ""] || sessionByTab[t.id]?.channel,
                        )}
                        channel={sessionByTab[t.id]?.channel ?? null}
                        onChannelReply={(requestId, decision) => {
                          void replyChannel(t.id, requestId, decision);
                        }}
                        hasOlder={sessionByTab[t.id]?.convCursor != null}
                        loadingOlder={sessionByTab[t.id]?.loadingOlder ?? false}
                        onLoadOlder={(settle) =>
                          tabActionsRef.current
                            .get(t.id)
                            ?.loadOlderConversation(settle)
                        }
                        onChooseCwd={() =>
                          tabActionsRef.current.get(t.id)?.chooseCwd()
                        }
                        runtime={(() => {
                          const st = statuses[t.id] ?? null;
                          const runDet = st ? agents.find((a) => a.id === st.agentId) : null;
                          return {
                            status: st,
                            profileModels:
                              (st && profiles.find((p) => p.id === st.profileId)?.models) ?? [],
                            effort: runDet?.effort ?? null,
                            submitCsiU: runDet?.submitCsiU ?? false,
                            onRelaunch: (patch: { model?: string; effort?: string | null }) =>
                              tabActionsRef.current.get(t.id)?.relaunchWith(patch),
                          };
                        })()}
                        onTuiCommand={(cmd) =>
                          tabActionsRef.current.get(t.id)?.runTuiCommand(cmd)
                        }
                        menuPrompt={sessionByTab[t.id]?.menuPrompt ?? null}
                        tuiPanel={sessionByTab[t.id]?.tuiPanel ?? false}
                        tuiNotice={sessionByTab[t.id]?.tuiNotice ?? null}
                        liveReply={sessionByTab[t.id]?.liveReply ?? null}
                        liveTokens={sessionByTab[t.id]?.liveTokens ?? null}
                        liveThinking={sessionByTab[t.id]?.liveThinking ?? null}
                        promptSuggestion={sessionByTab[t.id]?.promptSuggestion ?? null}
                        mesaCommands={mesaCommandsFor(t.id)}
                        externalInsert={chatInsertByTab[t.id] ?? null}
                        onExternalInsertConsumed={() =>
                          setChatInsertByTab((prev) => {
                            const next = { ...prev };
                            delete next[t.id];
                            return next;
                          })
                        }
                        onRestartPermission={() =>
                          // 先让上面的 permission 写进标签、下一帧再重开：重开时读的是新 props
                          window.setTimeout(
                            () => tabActionsRef.current.get(t.id)?.restartWithPermission(),
                            0,
                          )
                        }
                        onInlinePermission={(tier) => {
                          void tabActionsRef.current.get(t.id)?.switchPermissionInSession(tier);
                        }}
                        onAnswerMenu={(i, opts) => {
                          tabActionsRef.current.get(t.id)?.answerMenu(i, opts);
                        }}
                        planStartBlocked={Boolean(t.discussOnly && t.permission === "discuss")}
                        onPlanLeft={(tier) =>
                          // 方案确认上点了开工：CLI 已离开计划模式，标签不再是先出方案（徽标、接着聊的启动参数都跟上）。
                          // tier = null 是回到这家 CLI 自己的设置（Kimi Approve、CodeBuddy Yes）；只讨论的目标 / 想法不动
                          setTabs((prev) =>
                            prev.map((x) =>
                              x.id === t.id && x.permission === "discuss" && !x.discussOnly
                                ? { ...x, permission: "write_tree", permissionMode: tier }
                                : x,
                            ),
                          )
                        }
                        onAnswerAsk={(a) => {
                          tabActionsRef.current.get(t.id)?.answerAsk(a);
                        }}
                        onForkFrom={(text) => void forkChat(t.id, text)}
                        onReportMismatch={(from, card) => void reportChatMismatch(t.id, from, card ?? null)}
                        connIssue={sessionByTab[t.id]?.connIssue ?? null}
                        onSwitchConnection={(id) =>
                          tabActionsRef.current.get(t.id)?.switchConnection(id)
                        }
                        onDismissConnIssue={() =>
                          tabActionsRef.current.get(t.id)?.dismissConnIssue()
                        }
                        grokLoginStuck={sessionByTab[t.id]?.grokLoginStuck ?? false}
                        onGrokLogout={() => tabActionsRef.current.get(t.id)?.grokLogout()}
                        onDismissGrokLogin={() => tabActionsRef.current.get(t.id)?.dismissGrokLogin()}
                        onOpenProfiles={() => setPage("profiles")}
                      />
                      </div>
                    </div>
                  </div>
                      );
                    })()}
                  {/* 终端底部状态栏：在 pane 内部、贴 xterm 画面下缘，与终端同底同色
                      （视觉上是终端自己画的状态行）。常驻渲染——未启动也有 cwd/未启动态，
                      高度恒定不跳动；ResizeObserver 兜底尺寸变化后的 fit。
                      设置页「底部状态栏」统一开关（终端/聊天两层同进退，默认开）：开关只影响
                      栏的存在与否，两层一致 → 切层时终端几何不变、不触发 codex resize
                      reflow（每次 SIGWINCH 重放整个 transcript，上游恒开）；关掉后新 fit 的
                      终端约多两行。
                      分屏时各 pane 显示各标签；git 段只跟随活跃 pane（数据是 focusedId 的）。
                      聊天层（非 peek）状态栏走 chat 变体：底色涂 var(--color-canvas) 与聊天画布同源、
                      内容与输入卡同一条 max-w-4xl 中轴、模型胶囊灰调（蓝强调只留状态点）——
                      终端层不变（与 xterm 同底拼无缝卡）。
                      data-statusbar-host：阅读区打开时随 xterm 宿主一并搬进覆盖层右栏槽位 */}
                  {(() => {
                    // 统一「底部状态栏」开关（默认开）：关 = 终端/聊天两层都不渲染。
                    // 两层同进退 → 切层时栏的有无不变化，终端行列数稳定，无需旧聊天页
                    // 的 invisible 占位（statusBarInChat 已迁移为 status_bar；2026-09-19）
                    if (!(appSettings?.statusBar ?? true)) return null;
                    return (
                  <div data-statusbar-host={t.id} className="shrink-0">
                  {(() => {
                    const st = statuses[t.id] ?? null;
                    const prof = st
                      ? profiles.find((p) => p.id === st.profileId)
                      : null;
                    const det = st
                      ? agents.find((a) => a.id === st.agentId)
                      : null;
                    const focused = t.id === focusedId;
                    // 阅读会话的状态栏搬进了阅读区右栏：读文献时用不上提交推送，git 胶囊不出
                    const gitOk = focused && !(reader && readerTabId === t.id);
                    // 聊天原生变体：聊天层且 peek 未开（peek 里嵌的是终端画面，仍用终端同底语言）
                    const chatBar =
                      (surfaceModeByTab[t.id] ?? defaultSurface) ===
                        "chat" && !peekByTab[t.id];
                    return (
                      <StableTerminalStatusBar
                        frozen={!tabVisible}
                        variant={chatBar ? "chat" : "terminal"}
                        status={st}
                        fallbackCwd={t.initialCwd ?? ""}
                        profileId={st?.profileId ?? null}
                        profileName={prof?.name ?? null}
                        profileModels={prof?.models ?? []}
                        launchModel={st?.launchModel ?? null}
                        modelSwitch={runtimeModelSwitch(
                          det?.modelSwitch ?? null,
                          st?.agentId,
                          prof?.accountType,
                        )}
                        effort={det?.effort ?? null}
                        git={gitOk ? gitTotals : null}
                        mergeReady={gitOk ? mergeReadyWs : []}
                        gitCwd={gitPanelCwd}
                        submitCsiU={det?.submitCsiU ?? false}
                        onOpenGit={() => {
                          setRightOpen(true);
                          setRightTab("git");
                        }}
                        onGenerateMsg={generateCommitMsg}
                        onCommitPush={commitPushMsg}
                        onCwdChange={(c) =>
                          tabActionsRef.current.get(t.id)?.setCwd(c)
                        }
                        onTermLog={(line) =>
                          tabActionsRef.current.get(t.id)?.logLine(line)
                        }
                        onTuiCommand={(cmd) =>
                          tabActionsRef.current.get(t.id)?.runTuiCommand(cmd)
                        }
                        contextUsed={lastContextTokens(sessionByTab[t.id]?.conv ?? [])}
                        onRelaunch={(patch) => tabActionsRef.current.get(t.id)?.relaunchWith(patch)}
                        colors={statusBarColors}
                        chatMetaRef={chatBar ? chatMetaRefFor(t.id) : undefined}
                      />
                    );
                  })()}
                  </div>
                    );
                  })()}
                </div>
              </div>
            );
          })}
          {splitActive && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="调整分屏比例"
              title="拖动调整分屏比例；双击恢复对半"
              style={{ order: 1 }}
              onPointerDown={startSplitResize}
              onDoubleClick={() => {
                setSplitPct(50);
                localStorage.setItem(SPLIT_PCT_KEY, "50");
              }}
              className="group relative w-1.5 shrink-0 cursor-col-resize"
            >
              {/* 平时透明极细（w-0.5），悬停才显色（waveterm 手法）；外层 w-1.5 只是抓取热区，拖拽逻辑不变 */}
              <span className="absolute inset-y-0 left-0.5 w-0.5 bg-transparent transition-colors group-hover:bg-cta" />
            </div>
          )}
        </div>
        {/* 专注内容：右栏铺满即表达主次，中带不加压暗遮罩（v3.44 用户否决压黑） */}
      </div>

      {/* 右栏关闭时改动面板随右栏卸载、轮询停止，标签条变更芯片与页签徽标需要数据：
          挂一个 display:none 的实例在同一 cwd 上持续轮询（与右栏内的面板实例互斥，永不同存） */}
      {!rightOpen && (
        <div className="hidden">
          <GitPanel
            cwd={gitPanelCwd}
            visible={visible}
            refreshKey={fsChangeTick}
            onTotals={reportGitTotals}
            onOpenPr={gitPanelOpenPr}
          />
        </div>
      )}

      {/* 右侧面板：文件预览 / 改动（聊天在主工作区） */}
      {rightOpen && (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="调整右侧面板宽度"
            title="拖动调整宽度；双击恢复默认宽度"
            onPointerDown={startRightResize}
            onDoubleClick={() => {
              const width = clampRightWidth(RIGHT_PANEL_DEFAULT_WIDTH);
              setRightExpanded(false);
              setRightWidth(width);
              normalRightWidthRef.current = width;
              localStorage.setItem(
                RIGHT_PANEL_WIDTH_KEY,
                String(Math.round(width)),
              );
            }}
            className="group relative w-1.5 shrink-0 cursor-col-resize"
          >
            {/* 平时透明极细（w-0.5），悬停才显色（waveterm 手法）；外层 w-1.5 只是抓取热区，拖拽逻辑不变 */}
            <span className="absolute inset-y-0 left-0.5 w-0.5 bg-transparent transition-colors group-hover:bg-cta" />
          </div>
          <div
            style={{ width: layout.right }}
            className="flex shrink-0 flex-col border-l border-hairline bg-raised/70"
          >
            {/* 窗格头（2026-10-24）：右栏一次只显示一个窗格，由对话头的「文件」「± 改动」两个钮开关。
                文件窗格头 = 固定的「树」标签 + 点开文件后出现的斜体预览标签（再点别的文件就替换它，× 关掉回到树）；
                改动窗格头只写「改动」+ 汇总。 */}
            <div className="group flex h-8 shrink-0 items-center gap-1 bg-raised/70 px-2">
              {rightTab === "preview" ? (
                <>
                  <button
                    type="button"
                    onClick={() => setFilesViewPref("tree")}
                    aria-pressed={filesView === "tree" || filesSideBySide}
                    title="文件树"
                    aria-label="文件树"
                    className={`flex h-7 shrink-0 items-center rounded-sm px-2 ${
                      filesView === "tree" || filesSideBySide ? "bg-seg-sel text-l1" : "text-l3 hover:text-l1"
                    }`}
                  >
                    <FolderTree size={14} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                  {preview && (
                    <span
                      className={`flex h-7 min-w-0 max-w-[60%] items-center gap-1 rounded-sm pl-2.5 pr-1 text-xs ${
                        filesView === "preview" || filesSideBySide ? "bg-seg-sel text-l1" : "text-l3 hover:text-l1"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => setFilesViewPref("preview")}
                        title={preview.path}
                        className="min-w-0 truncate italic"
                      >
                        {preview.name}
                      </button>
                      {previewDirty && (
                        <span className="shrink-0 text-l3" title="有未保存的修改">
                          ●
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => void closePreviewTab()}
                        title="关闭预览，回到文件树"
                        aria-label="关闭预览"
                        className="flex size-5 shrink-0 items-center justify-center rounded-sm text-l4 hover:bg-hover hover:text-l1"
                      >
                        ×
                      </button>
                    </span>
                  )}
                  {(filesView === "preview" || filesSideBySide) && preview && previewFiles.length > 1 && (
                    <span className="ml-1 flex items-center gap-0.5 text-micro text-l4">
                      <button type="button" onClick={() => switchPreview(-1)} disabled={previewFiles[0]?.path === preview.path} className="rounded px-1 hover:bg-hover disabled:opacity-30" title="上一个文件（↑）">↑</button>
                      <button type="button" onClick={() => switchPreview(1)} disabled={previewFiles[previewFiles.length - 1]?.path === preview.path} className="rounded px-1 hover:bg-hover disabled:opacity-30" title="下一个文件（↓）">↓</button>
                    </span>
                  )}
                </>
              ) : (
                <span
                  onDoubleClick={toggleRightExpanded}
                  title={`改动；双击${rightExpanded ? "退出专注内容" : "进入专注内容"}`}
                  className="flex h-7 shrink-0 items-center gap-1 px-2 text-xs text-l1"
                >
                  <span className="text-micro text-l4">±</span>
                  改动
                  {gitTotals && gitTotals.add + gitTotals.del > 0 && (
                    <span className="ml-1 rounded-sm bg-ok px-1 text-ok-text">
                      +{gitTotals.add + gitTotals.del}
                    </span>
                  )}
                </span>
              )}
              {/* 右侧动作区：（文件窗格）树与预览并排 + 专注内容 + 收起。 */}
              <span className="ml-auto flex min-w-0 items-center gap-1 pl-1">
                {rightTab === "preview" && (
                  <button
                    type="button"
                    onClick={toggleFilesSplit}
                    aria-pressed={filesSplit}
                    title={
                      filesSplit
                        ? "树与预览改回一次看一个"
                        : "树与预览左右并排（点开文件后左边是树、右边是预览）"
                    }
                    aria-label={filesSplit ? "取消左右并排" : "树与预览左右并排"}
                    className={`flex size-7 shrink-0 items-center justify-center rounded-sm hover:bg-hover ${
                      filesSplit ? "bg-seg-sel text-l1" : "text-l4 hover:text-l1"
                    }`}
                  >
                    <Columns2 size={14} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={toggleRightExpanded}
                  title={
                    rightExpanded
                      ? "退出铺满（Esc）"
                      : "右栏铺满（对话只留一窄条，Esc 退出）"
                  }
                  className={`flex size-7 shrink-0 items-center justify-center rounded-sm text-xs text-l4 hover:bg-hover hover:text-l1 ${hoverRevealClass}`}
                >
                  {rightExpanded ? "⇲" : "⇱"}
                </button>
                <button
                  onClick={closeRightPanel}
                  title="收起右栏"
                  aria-label="收起右栏"
                  className={`flex size-7 shrink-0 items-center justify-center rounded-sm text-xs text-l4 hover:bg-hover hover:text-l1 ${hoverRevealClass}`}
                >
                  ×
                </button>
              </span>
            </div>
            {/* 文件窗格：树和预览都保持挂载（树的展开状态、预览编辑器的撤销栈不因切换丢）；
                默认一次只显示一个，开了「左右并排」就是左树右预览 */}
            <div
              className={
                rightTab === "preview"
                  ? filesSideBySide
                    ? "flex min-h-0 flex-1 flex-row"
                    : "flex min-h-0 flex-1 flex-col"
                  : "hidden"
              }
            >
              <div
                style={filesSideBySide ? { width: filesTreeWidth } : undefined}
                className={
                  filesSideBySide
                    ? "relative flex min-h-0 shrink-0 flex-col border-r border-hairline"
                    : filesView === "tree"
                      ? "flex min-h-0 flex-1 flex-col"
                      : "hidden"
                }
              >
                {filesSideBySide && (
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="调整文件树宽度"
                    title="拖动调整树的宽度"
                    onPointerDown={startFilesTreeResize}
                    className="group absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize"
                  >
                    <span className="absolute inset-y-0 left-[3px] w-0.5 bg-transparent transition-colors group-hover:bg-cta" />
                  </div>
                )}
                <FileTree
                  cwd={activeCwd}
                  showHidden={showHidden}
                  onShowHidden={setShowHidden}
                  refreshKey={refreshKey}
                  onOpenFile={openPreview}
                  onOpenTerminal={openTerminalAt}
                  onFsEvent={bumpFsChangeTick}
                  onRootChange={closePreviewForRootChange}
                  onRootNavigated={setTreeRoot}
                  onRecoverDirectory={() => tabActionsRef.current.get(focusedId)?.chooseCwd()}
                  onOpenReader={(path) =>
                    void (/\.pdf$/i.test(path) ? openReaderForPdf(path) : openReaderForNote(path))
                  }
                  actions={
                    <>
                      <button
                        type="button"
                        onClick={() => setShowHidden((v) => !v)}
                        title={showHidden ? "不显示隐藏文件" : "显示隐藏文件（. 开头的）"}
                        aria-label={showHidden ? "不显示隐藏文件" : "显示隐藏文件"}
                        aria-pressed={showHidden}
                        className={`flex h-7 w-7 items-center justify-center rounded-sm hover:bg-hover ${
                          showHidden ? "text-l1" : "text-l4 hover:text-l2"
                        }`}
                      >
                        {showHidden ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                      <button
                        type="button"
                        onClick={() => setRefreshKey((k) => k + 1)}
                        title="刷新文件树"
                        aria-label="刷新文件树"
                        className={railBtn}
                      >
                        <RefreshCw size={14} />
                      </button>
                    </>
                  }
                />
              </div>
              <div
                className={
                  filesSideBySide || filesView === "preview"
                    ? "flex min-h-0 min-w-0 flex-1 flex-col"
                    : "hidden"
                }
              >
              {preview ? (
                <Suspense
                  fallback={
                    <div className="min-h-0 flex-1 px-4">
                      <LoadingRows />
                    </div>
                  }
                >
                  {/\.pdf$/i.test(preview.path) ? (
                    <PdfContinuousView
                      path={preview.path}
                      cwdHint={preview.root ?? activeCwd}
                      onAskAi={askAiFromPdf}
                      onOrganize={organizePdfExcerpt}
                      onOpenReader={() => void openReaderForPdf(preview.path)}
                    />
                  ) : /\.docx$/i.test(preview.path) ? (
                    <DocxPreview
                      path={preview.path}
                      cwdHint={preview.root ?? activeCwd}
                    />
                  ) : /\.(xlsx|xlsm|xls|ods|csv|tsv)$/i.test(preview.path) ? (
                    <XlsxPreview
                      path={preview.path}
                      cwdHint={preview.root ?? activeCwd}
                    />
                  ) : /\.(doc|rtf)$/i.test(preview.path) ? (
                    <UnsupportedPreview
                      path={preview.path}
                      cwdHint={preview.root ?? activeCwd}
                      convertible
                      hint="旧版 Word / RTF 文档：用 Word 另存为 .docx 后可以在这里预览。"
                    />
                  ) : isPreviewableImagePath(preview.path) ? (
                    <ImagePreview
                      path={preview.path}
                      cwdHint={preview.root ?? activeCwd}
                    />
                  ) : (
                    <FilePreviewEditor
                      path={preview.path}
                      root={preview.root ?? activeCwd}
                      revealLine={
                        previewReveal && previewReveal.path === preview.path
                          ? previewReveal.line
                          : null
                      }
                      onDirtyChange={setPreviewDirty}
                      onDiscuss={discussMdExcerpt}
                      onOpenReader={
                        /\.(md|markdown)$/i.test(preview.path)
                          ? () => void openReaderForNote(preview.path)
                          : undefined
                      }
                    />
                  )}
                </Suspense>
              ) : null}
              </div>
            </div>
            {/* 改动面板保持挂载：右栏打开期间持续轮询，页签徽标才有数据 */}
            <div
              className={
                rightTab === "git" ? "flex min-h-0 flex-1 flex-col" : "hidden"
              }
            >
              <GitPanel
                cwd={gitPanelCwd}
                visible={visible && rightOpen}
                refreshKey={fsChangeTick}
                onTotals={reportGitTotals}
                onOpenPr={gitPanelOpenPr}
                onOpenReview={(path, runId) => {
                  setReviewAction(null);
                  setReviewReturn(null);
                  setReviewPath(path);
                  setReviewRunId(runId ?? null);
                }}
              />
            </div>
          </div>
        </>
      )}

      {reviewPath && (
        <WorkspaceReviewView
          worktreePath={reviewPath}
          runId={reviewRunId}
          reviewLocked={reviewLocked}
          initialAction={reviewAction}
          initialActionKey={reviewRequestId}
          onClose={() => {
            const back = reviewReturnRef.current;
            setReviewPath(null);
            setReviewRunId(null);
            setReviewAction(null);
            setReviewRequestId(null);
            setReviewReturn(null);
            setReviewLocked(false);
            const s = useAppStore.getState();
            // 「回给 Agent」「看复现日志」先交终端请求再关评审：人要看的就是这页的终端，不回跳
            if (!back || s.pendingTerminal) return;
            if (back.target) {
              s.setSelectProjectReq(back.target.projectRoot);
              s.setProjectSurfaceReq(back.target.surface);
              s.setPage("workspaces");
            } else if (
              back.fromPage &&
              back.fromPage !== "terminal" &&
              back.fromPage !== s.page
            ) {
              s.setPage(back.fromPage);
            }
          }}
        />
      )}

      {/* 沉浸式阅读区（z-40 页面模态档）：底下终端/PTY/右栏全程保持挂载，只是被盖住；
          右栏 xterm 由上面的 useLayoutEffect 把阅读会话标签的宿主节点搬进 termSlot */}
      {reader && (
        <ReaderOverlay
          // 抽查核对档与平时阅读各有一套栏宽记忆，换档要重挂才按各自的读
          key={reader.spotCheck ? "spot" : "read"}
          pdfPath={reader.pdfPath}
          projectRoot={reader.projectRoot}
          notePath={reader.notePath ?? null}
          hasAgentTab={readerTabId !== null}
          agentTabId={readerTabId}
          agentResumed={readerKey !== null && readerResumedKey === readerKey}
          agentStatus={readerTabId ? (statuses[readerTabId] ?? null) : null}
          agentSession={
            readerTabId ? (sessionByTab[readerTabId] ?? null) : null
          }
          needsProfile={readerNeedsProfile}
          onInject={injectToReader}
          onRestartAgent={restartReaderAgent}
          onGoProfiles={() => setPage("profiles")}
          onClose={closeReader}
          termSlot={bindReaderTermSlot}
          statusBarSlot={bindReaderStatusSlot}
          agentSurface={readerSurface}
          agentPeek={Boolean(readerTabId && peekByTab[readerTabId])}
          onAgentSurface={setReaderSurface}
          spotCheck={reader.spotCheck ?? null}
          onSpotSend={sendSpotCheck}
          onSpotAllClear={clearSpotCheck}
        />
      )}
    </div>
  );
}
