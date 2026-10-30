import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AppWindow,
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  Columns2,
  Copy,
  Eraser,
  Folder,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  MessageCircle,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  SquarePen,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import { createPortal } from "react-dom";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import {
  groupByWorkMode,
  normalizeWorkMode,
  RAIL_WORK_MODE_LABEL,
} from "../work-mode";
import { useAnimatedDismiss } from "../exit-animation";
import { pathKey, revealFolderLabel, samePath } from "../path-utils";
import { IS_MAC, IS_WINDOWS } from "../hotkeys";
import {
  applyOrder,
  isPinned,
  parsePins,
  PROJECT_ORDER_KEY,
  PROJECT_PINS_KEY,
  reorderGroup,
  splitPinned,
  togglePin,
} from "../project-tree";
import {
  clampTabDragDx,
  rubberbandTabDx,
  tabDragSettleDx,
  tabDragShift,
  tabDragTarget,
} from "../tab-drag";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";
import { confirmDialog } from "./ConfirmDialog";
import RunCaret from "./RunCaret";
import { RUN_CARET_LABEL, strongestCaret, withUnread } from "../run-caret";
import { unreadKeyOf } from "../chat-unread";
import RenameProjectModal from "./RenameProjectModal";
import CoachTip, { showFloatingCoach } from "./CoachTip";
import { noteMouseCloseChat } from "./shortcut-nudges";
import { toast } from "../toast";
import { AGENTS, type ProjectDto, type SessionMetaDto, type WorkspaceDto } from "../types";
import {
  CHAT_PINS_KEY,
  chatDot,
  currentFolderKey,
  parseChatPins,
  nextPicked,
  nudgeAnchor,
  pinnedChats,
  pinPicked,
  railNavIndex,
  toggleChatPin,
  folderDot,
  folderOpen,
  projectChats,
  SCRATCH_FOLDER_KEY,
  SCRATCH_STALE_DAYS,
  scratchChats,
  scratchDot,
  staleScratchChats,
  SIDEBAR_CHAT_LIMIT,
  SIDEBAR_CHAT_STEP,
  sidebarChatTitle,
  chatQuotas,
  chatSlots,
  expandedExtra,
  openTabRows,
  type ChatDot,
  type OpenTabRow,
} from "../sidebar-chats";
import {
  canShowCoachTip,
  markCoachTipSeen,
  markCoachTipShown,
  noteChatOpen,
  noteSingleAct,
  type ChatOpen,
  type SingleAct,
} from "../coach-tips";
import { tidySessionTitle } from "../session-title";
import { openConversation, openQuickChat, prefetchConversation } from "../quick-chat-launch";
import { projectResumeProfileId } from "../project-agents";
import { startProjectChat } from "./AskAiModal";
import { imeBlocksEnter } from "../ime-guard";
import { relTime } from "../rel-time";
import RailSearchPalette from "./RailSearchPalette";
import type { RailSearchChat, RailSearchProject } from "../rail-search";
import { usePolling } from "../polling";
import { useClientOpen } from "./ClientOpenDialog";
import { openButtonLabel } from "../client-open";

const GROUPS_KEY = "ccode.projectTreeGroups";
/** 各文件夹（项目 / 随手聊）对话展开与否：人手开关过的才记，没碰过的只展开正在聊的那个（sidebar-chats.ts folderOpen） */
const CHAT_OPEN_KEY = "ccode.projectTreeChats";
const COLLAPSED_SECTIONS_KEY = "ccode.railCollapsedSections";
type RailSection = "pinned" | "other";
/** 侧栏里的分节标签（「项目」「置顶」「其他打开的」）：小一号、灰、字距拉开；项目是标签，置顶与其他打开的是折叠按钮（2026-10-24 侧栏三层） */
// 分节标题（置顶 / 其他打开的 / 项目）：同对话 13px、加粗、l2（2026-10-28 用户：照 Claude 客户端，标题是骨架不是注脚）
const RAIL_SECTION_LABEL = "ccode-rail-text font-medium text-l2";

/** 对话行尾的运行状态光标的说明（run-caret.ts：干活 / 闲着 / 等你确认） */
function dotTitle(dot: ChatDot): string | undefined {
  return dot ? RUN_CARET_LABEL[dot] : undefined;
}
/** 树行：注册项目（project 非空）与未添加仓库（沉底「未添加」段）统一形状 */
type TreeRow = {
  key: string;
  repoPath: string;
  name: string;
  project: ProjectDto | null;
};

/** 项目树（侧栏展开态）：「项目」标签行 + 搜索 + 按工作方式分组的课题列表。
 *  行点击 = onSelect(repoPath)（App 侧 setSelectProjectReq + setPage("workspaces")，
 *  与收件箱/对话页卡片同一跳转链）；行右键 = 重命名 / 复制路径 / 从 Mesa 移除 /
 *  清除痕迹 / 删除目录，动作自持，完成后 bump projectsVersion 通知本树与项目页重拉。
 *  选中高亮吃 contextLabel.projectPath（项目页唯一写入方的「当前项目」镜像）。
 *  行首状态点只认「此刻有 Agent 在跑」（绿点）；待处理黄点归顶栏收件箱与工作台，不在此重复计算。 */
/** 派发切换后还没轮到「正看着的标签」接过高亮时，点下去的高亮最多再留这么久（ms），免得闪回原来那行 */
const PRESSED_HOLD_MS = 1500;
/** 多选的修饰键怎么写（提示文字用；Mac 上 Ctrl 点是右键，所以是 ⌘） */
const PICK_TOGGLE_KEY = IS_MAC ? "⌘" : "Ctrl";
const PICK_RANGE_KEY = IS_MAC ? "⇧" : "Shift";

export default function ProjectTree({
  selectedRoot,
  active,
  liftCurrent = false,
  onSelect,
}: {
  selectedRoot: string | null;
  /** 主区此刻就在项目页：当前课题铺选中底；在别的页时只留「当前课题」弱提示（加粗、不铺底），
   *  不和系统段的选中项抢成两处选中 */
  active: boolean;
  /** 正聊着的项目整块提到最上面（随手聊上面）：只给收起侧栏时弹出的那份用——展开的侧栏点来点去，位置不动 */
  liftCurrent?: boolean;
  onSelect: (repoPath: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [repos, setRepos] = useState<
    Pick<WorkspaceDto, "repoPath" | "repoName" | "worktreePath">[]
  >([]);
  // 「搜索对话和项目」弹层（RailSearchPalette，2026-10-24 照 Claude 客户端），树本身不再就地筛。
  // 入口 2026-10-27 挪到标题栏放大镜 / 快捷键，经 store 的 railSearchReq 打开（树里不再占一行）。
  // 挂载时也要看：侧栏收着时这棵树是点放大镜才探出来新挂的，请求比树先到
  const [searchOpen, setSearchOpen] = useState(false);
  const railSearchReq = useAppStore((s) => s.railSearchReq);
  useEffect(() => {
    if (railSearchReq && useAppStore.getState().takeRailSearch()) setSearchOpen(true);
  }, [railSearchReq]);
  // 对话菜单「在 X 客户端打开」：哪家的会话交给哪家自己的 GUI 客户端（预检与确认层同对话页）
  const clientOpen = useClientOpen(true);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    row: TreeRow;
    /** ⋯ 按钮打开时菜单右缘对齐按钮；右键打开时贴光标 */
    alignRight?: boolean;
  } | null>(null);
  // 置顶：界面偏好记本机（同分组折叠态），置顶课题单列最上「置顶」段
  const [pins, setPins] = useState<string[]>(() => {
    try {
      return parsePins(localStorage.getItem(PROJECT_PINS_KEY));
    } catch {
      return [];
    }
  });
  function togglePinFor(row: TreeRow) {
    setPins((prev) => {
      const next = togglePin(prev, row.repoPath, IS_WINDOWS);
      try {
        localStorage.setItem(PROJECT_PINS_KEY, JSON.stringify(next));
      } catch {
        /* 存不下只影响下次启动 */
      }
      return next;
    });
  }
  // 组内顺序（拖动排序）：同置顶，界面偏好记本机；置顶段的顺序就是 pins 表本身
  const [order, setOrder] = useState<string[]>(() => {
    try {
      return parsePins(localStorage.getItem(PROJECT_ORDER_KEY));
    } catch {
      return [];
    }
  });
  function saveList(key: string, next: string[]) {
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* 存不下只影响下次启动 */
    }
  }
  // 组内拖动排序（同运行页标签拖动：pointer 事件自实现，不用 HTML5 拖放——Tauri 原生文件拖放会拦掉
  // WKWebView 的拖拽手势）：竖向位移超 6px 进拖拽，源行跟手、其余行滑动让位，松手先吸附再落定。
  // 只在同一段（置顶 / 某个工作方式组）里拖，不能跨组：分组由工作方式决定。搜索时不拖。
  const [drag, setDrag] = useState<{
    section: string;
    key: string;
    from: number;
    target: number;
    dy: number;
    /** 拖拽开始时本段各行的测量值（复用标签条的一维槽位：left=top、width=height） */
    slots: { left: number; width: number }[];
    settling: boolean;
  } | null>(null);
  // 拖完松手的那次 click 吞掉（拖排序不该顺手打开课题）
  const suppressClickRef = useRef(false);
  function onRowPointerDown(
    e: React.PointerEvent,
    section: string,
    paths: string[],
    key: string,
  ) {
    if (e.button !== 0 || paths.length < 2) return;
    // 一个课题是「行 + 展开的对话」一整块：量和挪都按整块（data-tree-row 挂在块上）
    const rowEl =
      (e.currentTarget as HTMLElement).closest<HTMLElement>("[data-tree-row]") ??
      (e.currentTarget as HTMLElement);
    const startY = e.clientY;
    let active = false;
    let slots: { left: number; width: number }[] = [];
    let from = 0;
    let lastTarget = 0;
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    const finish = () => {
      cleanup();
      if (!active) return;
      suppressClickRef.current = true;
      // 吞 click 只管紧随的这一次；松手落在行外就没有 click，别让它留到下次真点击
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
      const target = lastTarget;
      if (target === from) {
        setDrag(null);
        return;
      }
      setDrag((cur) =>
        cur ? { ...cur, dy: tabDragSettleDx(cur.slots, from, target), settling: true } : null,
      );
      window.setTimeout(() => {
        if (section === "pinned") {
          setPins((prev) => {
            const next = reorderGroup(prev, paths, from, target, IS_WINDOWS);
            saveList(PROJECT_PINS_KEY, next);
            return next;
          });
        } else {
          setOrder((prev) => {
            const next = reorderGroup(prev, paths, from, target, IS_WINDOWS);
            saveList(PROJECT_ORDER_KEY, next);
            return next;
          });
        }
        setDrag(null);
      }, 170);
    };
    const onMove = (ev: PointerEvent) => {
      if (!active) {
        if (Math.abs(ev.clientY - startY) <= 6) return;
        active = true;
        // 进入拖拽态才测量（此刻布局未变）；querySelectorAll 顺序 = 本段显示顺序
        const els = Array.from(
          (rowEl.parentElement ?? rowEl).querySelectorAll<HTMLElement>("[data-tree-row]"),
        );
        slots = els.map((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.top, width: r.height };
        });
        from = Math.max(0, els.findIndex((el) => el.getAttribute("data-tree-row") === key));
        lastTarget = from;
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
        setMenu(null);
      }
      const raw = ev.clientY - startY;
      const target = tabDragTarget(slots, from, clampTabDragDx(slots, from, raw));
      lastTarget = target;
      setDrag({
        section,
        key,
        from,
        target,
        dy: rubberbandTabDx(slots, from, raw),
        slots,
        settling: false,
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }
  const [renameTarget, setRenameTarget] = useState<{
    path: string;
    name: string;
  } | null>(null);
  const projectsVersion = useAppStore((s) => s.projectsVersion);
  const pathsSig = useAppStore((s) => s.projectPaths.join("\n"));
  const terminalRunInputs = useAppStore((s) => s.terminalRunInputs);

  // —— 对话挂在文件夹下面（2026-10-23 侧栏挂对话第一期，纯逻辑 sidebar-chats.ts）——
  // 对话是唯一的对象，每段只归一个文件夹；点一段进运行页能直接写，只看不起进程
  const sessions = useAppStore((s) => s.sessions);
  const profiles = useAppStore((s) => s.profiles);
  // 跑完了没看的（chat-unread.ts，App 维护）：那一行标题亮到 l1，收着的课题名也亮
  const unreadChats = useAppStore((s) => s.unreadChats);
  const unreadSet = useMemo(() => new Set(unreadChats), [unreadChats]);
  // 置顶的对话（sidebar-chats.ts CHAT_PINS_KEY）：钉在树最上面「置顶」一节，原课题下不重复列
  const [chatPins, setChatPins] = useState<string[]>(() => {
    try {
      return parseChatPins(localStorage.getItem(CHAT_PINS_KEY));
    } catch {
      return [];
    }
  });
  function toggleChatPinFor(key: string) {
    setChatPins((prev) => {
      const next = toggleChatPin(prev, key);
      try {
        localStorage.setItem(CHAT_PINS_KEY, JSON.stringify(next));
      } catch {
        /* 存不下只影响下次启动 */
      }
      return next;
    });
  }
  /** 多选里几段一起置顶 / 取消置顶 */
  function pinPickedFor(keys: string[]) {
    setChatPins((prev) => {
      const next = pinPicked(prev, keys);
      try {
        localStorage.setItem(CHAT_PINS_KEY, JSON.stringify(next));
      } catch {
        /* 存不下只影响下次启动 */
      }
      return next;
    });
  }
  // 多选（2026-10-27）：⌘（Windows 上 Ctrl）点 / ⇧ 点 / ⇧↑↓ 选几段，一起置顶或归档；不点修饰键照旧打开并清掉选择
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const pickAnchor = useRef<string | null>(null);
  const [pickMenu, setPickMenu] = useState<{ x: number; y: number; alignRight?: boolean } | null>(null);
  const pinnedList = useMemo(() => pinnedChats(sessions, chatPins), [sessions, chatPins]);
  const pinnedKeys = useMemo(
    () => new Set(pinnedList.map((s) => `${s.agent}\n${s.sessionId}`)),
    [pinnedList],
  );
  const page = useAppStore((s) => s.page);
  const projectPaths = useAppStore((s) => s.projectPaths);
  const terminalActiveTabId = useAppStore((s) => s.terminalActiveTabId);
  const [chatOpenPrefs, setChatOpenPrefs] = useState<Record<string, boolean>>(() => {
    try {
      const v: unknown = JSON.parse(localStorage.getItem(CHAT_OPEN_KEY) ?? "{}");
      return v && typeof v === "object" ? (v as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });
  const sectionId = useId();
  const [collapsedSections, setCollapsedSections] = useState<RailSection[]>(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(COLLAPSED_SECTIONS_KEY) ?? "[]");
      return Array.isArray(value) ? value.filter((key): key is RailSection => key === "pinned" || key === "other") : [];
    } catch { return []; }
  });
  function toggleSection(key: RailSection) {
    const collapsing = !collapsedSections.includes(key);
    setCollapsedSections((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      saveList(COLLAPSED_SECTIONS_KEY, next);
      return next;
    });
    // 收起时撤掉这一节的多选，避免对看不见的行执行批量操作。
    if (collapsing && key === "pinned") {
      const hidden = new Set(pinnedList.map(chatKey));
      setPicked((prev) => new Set([...prev].filter((k) => !hidden.has(k))));
      if (pickAnchor.current && hidden.has(pickAnchor.current)) pickAnchor.current = null;
      setPickMenu(null);
    }
  }
  function toggleFolder(key: string, open: boolean) {
    setChatOpenPrefs((prev) => {
      if (prev[key] === !open) return prev;
      const next = { ...prev, [key]: !open };
      try {
        localStorage.setItem(CHAT_OPEN_KEY, JSON.stringify(next));
      } catch {
        /* 存不下只影响下次启动 */
      }
      return next;
    });
    // 展开时拉一次：外部终端里刚聊的、自动起好的名字都跟上
    if (!open) void useAppStore.getState().loadSessions();
  }
  // 侧栏常驻，会话列表要自己保鲜（App 聚焦时不拉会话，见 App.tsx 那段约定）：窗口看得见时每分钟拉一次。
  // Mesa 里开的对话不靠它：终端页接上 / 停下时就强刷了
  usePolling(() => useAppStore.getState().loadSessions(), 60_000);
  const [chatMenu, setChatMenu] = useState<{
    x: number;
    y: number;
    s: SessionMetaDto;
    project: ProjectDto | null;
    /** ⋯ 打开时菜单右缘对齐按钮；右键打开时贴光标 */
    alignRight?: boolean;
  } | null>(null);
  /** 随手聊节头 ⋯ 的菜单（随手聊不是项目，没有项目那一份菜单） */
  const [scratchMenu, setScratchMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<{ key: string; value: string } | null>(null);
  const composingRef = useRef(false);
  /** 刚点下去、还没切过去的那段（2026-10-26 实测：高亮要等切换那一帧画完，晚 100–200ms） */
  const [pressedChatKey, setPressedChatKey] = useState<string | null>(null);

  function chatKey(s: SessionMetaDto): string {
    return `${s.agent}\n${s.sessionId}`;
  }
  /** 置顶一节里的那段属于哪个课题（接回时带这个课题给这家设的连接；随手聊 / 认不出的为 null） */
  function projectOfChat(s: SessionMetaDto): ProjectDto | null {
    const key = currentFolderKey(s.projectPath, folders, projectPaths, IS_WINDOWS);
    return key ? (rows.find((r) => pathKey(r.repoPath, IS_WINDOWS) === key)?.project ?? null) : null;
  }
  /** 一段对话属于哪个文件夹（课题名 / 随手聊）；不在任何一个里的给 null */
  function originOfChat(s: SessionMetaDto): string | null {
    const key = currentFolderKey(s.projectPath, folders, projectPaths, IS_WINDOWS);
    if (key === SCRATCH_FOLDER_KEY) return "随手聊";
    return key ? (rows.find((r) => pathKey(r.repoPath, IS_WINDOWS) === key)?.name ?? null) : null;
  }
  function openChat(s: SessionMetaDto, project: ProjectDto | null, split = false) {
    // 点下去这一行先亮（分屏打开时左边正看着的那段不变，不抢高亮）。切过去后高亮交回「正看着的标签」；
    // 没切成（确认框里取消、没真正切过去）就收回
    const key = chatKey(s);
    if (!split) {
      setPressedChatKey(key);
      openedChats.current.set(key, { s, project });
      noteSwitch(key);
    }
    openConversation(s, {
      preferredProfileId: project ? projectResumeProfileId(profiles, project, s.agent) : undefined,
      ...(split ? { split: true } : {}),
      ...(split
        ? {}
        : {
            onOpened: () =>
              window.setTimeout(() => setPressedChatKey((k) => (k === key ? null : k)), PRESSED_HOLD_MS),
            onSkipped: () => setPressedChatKey((k) => (k === key ? null : k)),
          }),
    });
  }
  /** 改名 / 归档：写会话元数据（不碰 CLI 源文件），先改本地镜像再强刷 */
  async function writeChatMeta(
    s: SessionMetaDto,
    patch: { customTitle?: string | null; archived?: boolean },
  ) {
    const customTitle = patch.customTitle !== undefined ? patch.customTitle : s.customTitle;
    const archived = patch.archived ?? s.archived;
    try {
      await invoke("set_session_meta", {
        agent: s.agent,
        sessionId: s.sessionId,
        customTitle,
        tags: s.tags,
        archived,
      });
      useAppStore.setState({
        sessions: useAppStore
          .getState()
          .sessions.map((x) =>
            x.agent === s.agent && x.sessionId === s.sessionId ? { ...x, customTitle, archived } : x,
          ),
      });
      void useAppStore.getState().loadSessions(true);
    } catch (reason) {
      toast(`${patch.archived ? "归档" : "改名"}失败：${String(reason)}`, "error");
    }
  }
  function commitRename(s: SessionMetaDto) {
    const cur = renaming;
    setRenaming(null);
    if (!cur || cur.key !== chatKey(s)) return;
    const next = cur.value.trim();
    const shown = tidySessionTitle(s).title;
    if (next === shown || (!next && !s.customTitle)) return;
    void writeChatMeta(s, { customTitle: next || null });
  }
  function chatMenuItems(s: SessionMetaDto, project: ProjectDto | null): ContextMenuItem[] {
    const holder = useAppStore
      .getState()
      .terminalRunInputs.find((r) => r.agentId === s.agent && r.sessionId === s.sessionId);
    return [
      {
        label: "在右侧分屏打开",
        icon: Columns2,
        title: "正看着的那段留在左边，这段放右边对照",
        onSelect: () => openChat(s, project, true),
      },
      // 只在 AI 开着时给（同行尾 ×）：退出了的 Mesa 自己收，没东西可关
      ...(holder?.running && !holder.shell
        ? [
            {
              label: "关掉这段对话",
              icon: X,
              title: "停下这段对话的 Agent、收起它；记录还在，再点开发一句就接回（在干活的会先问你）",
              onSelect: () => {
                const row = rowOf(chatKey(s));
                if (row) noteMouseCloseChat(row.getBoundingClientRect(), "right", listRef.current);
                useAppStore.getState().requestCloseTab(holder.tabId);
              },
            },
          ]
        : []),
      { separator: true },
      chatPins.includes(chatKey(s))
        ? {
            label: "取消置顶",
            icon: PinOff,
            title: "放回它所在的课题下面",
            onSelect: () => toggleChatPinFor(chatKey(s)),
          }
        : {
            label: "置顶",
            icon: Pin,
            title: "钉到侧栏最上面「置顶」一节，不管它在哪个课题",
            onSelect: () => {
              noteSingle("pin", s);
              toggleChatPinFor(chatKey(s));
            },
          },
      {
        label: "重命名",
        icon: Pencil,
        onSelect: () => setRenaming({ key: chatKey(s), value: tidySessionTitle(s).title }),
      },
      {
        label: "归档",
        icon: Archive,
        title: "从这里收起；对话页筛「已归档」还能找到",
        onSelect: () => {
          noteSingle("archive", s);
          void writeChatMeta(s, { archived: true });
        },
      },
      { separator: true },
      {
        label: "在对话页查看",
        icon: MessagesSquare,
        title: "看完整过程，导出、提炼接力这些也在那里",
        onSelect: () => {
          const st = useAppStore.getState();
          st.setOpenSessionReq({ agent: s.agent, sessionId: s.sessionId });
          st.setPage("sessions");
        },
      },
      ...clientOpen.sessionClients(s.agent).map((c) => ({
        label: openButtonLabel(c, "session"),
        icon: AppWindow,
        title: `交给 ${c.display} 接着聊`,
        onSelect: () => clientOpen.openSession(s, !!holder?.running, c.clientId),
      })),
      {
        label: "删除…",
        icon: Trash2,
        danger: true,
        disabled: chatRunning(s),
        title: chatRunning(s)
          ? "AI 还开着，先关掉这段对话再删"
          : "源文件移入系统回收站（可找回）；整理数据和快照一并清掉",
        onSelect: () => void deleteChats([s]),
      },
    ];
  }

  // 列表数据：注册表 + 工作区清单（后者推「未添加」段与工作区计数）。重拉触发：
  // 管理动作后的 projectsVersion、跨实例/终端侧注册落盘后的 projectPaths 签名变化、
  // 开着的对话里有认不出归属的目录（reposTick，见下方 unmatchedCwdSig）
  const [reposTick, setReposTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    invoke<ProjectDto[]>("list_projects")
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      .catch(() => {
        /* 下一次版本变化重试 */
      });
    invoke<Pick<WorkspaceDto, "repoPath" | "repoName" | "worktreePath">[]>(
      "list_workspaces",
    )
      .then((list) => {
        if (!cancelled) setRepos(list);
      })
      .catch(() => {
        /* 未添加段缺席不阻塞注册项目 */
      });
    return () => {
      cancelled = true;
    };
  }, [projectsVersion, pathsSig, reposTick]);

  const rows = useMemo<TreeRow[]>(() => {
    const unregistered: TreeRow[] = [];
    const seen: string[] = [];
    for (const w of repos) {
      if (projects.some((p) => samePath(p.path, w.repoPath, IS_WINDOWS)))
        continue;
      if (seen.some((s) => samePath(s, w.repoPath, IS_WINDOWS))) continue;
      seen.push(w.repoPath);
      unregistered.push({
        key: `r:${w.repoPath}`,
        repoPath: w.repoPath,
        name: w.repoName,
        project: null,
      });
    }
    return [
      ...projects.map((p) => ({
        key: `p:${p.path}`,
        repoPath: p.path,
        name: p.name,
        project: p,
      })),
      ...unregistered,
    ];
  }, [projects, repos]);

  const grouped = useMemo(() => {
    const { pinned, rest } = splitPinned(rows, pins, IS_WINDOWS);
    // 不再按科研 / 编程 / 工作分组（2026-10-23 照 Claude 客户端侧栏）：置顶的在前，其余按最近打开 / 拖过的顺序，
    // 没添加到 Mesa 的仓库沉底
    return {
      pinned,
      projects: applyOrder(
        rest.filter((r) => r.project),
        order,
        (r) => r.repoPath,
        IS_WINDOWS,
      ),
      unregistered: rest.filter((r) => !r.project),
    };
  }, [rows, pins, order]);

  // 每个课题的工作区 / 工作树目录（对话归属、状态点都要把它们算成这个课题）
  const worktreesOf = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const w of repos) {
      const k = pathKey(w.repoPath, IS_WINDOWS);
      const list = m.get(k) ?? [];
      list.push(w.worktreePath);
      m.set(k, list);
    }
    return m;
  }, [repos]);
  // 运行页正看着的那个标签：它的文件夹默认展开、它那段对话铺选中底（只在运行页时铺）
  const activeRun = terminalRunInputs.find((r) => r.tabId === terminalActiveTabId) ?? null;
  const folders = useMemo(
    () =>
      rows.map((r) => ({
        root: r.repoPath,
        worktrees: worktreesOf.get(pathKey(r.repoPath, IS_WINDOWS)) ?? [],
      })),
    [rows, worktreesOf],
  );
  const currentKey = useMemo(
    () => currentFolderKey(activeRun?.cwd, folders, projectPaths, IS_WINDOWS),
    [activeRun?.cwd, folders, projectPaths],
  );
  // 弹出列表里正聊着的那个项目整块提到最上面（2026-10-25 用户：展开的侧栏点击不动，只改弹出列表）；
  // 随手聊里的对话不提（随手聊本来就在项目前面）
  const currentRow = useMemo(
    () =>
      liftCurrent && currentKey && currentKey !== SCRATCH_FOLDER_KEY
        ? (rows.find((r) => pathKey(r.repoPath, IS_WINDOWS) === currentKey) ?? null)
        : null,
    [rows, currentKey, liftCurrent],
  );
  // 开步刚建的工作副本这里还不认识（工作区清单只在项目有变动时重读）：那段对话会先挂到最上面「其他打开的」，
  // 等后台认出会话才挪回课题下（2026-10-24 用户「修掉」）。开着的对话里出现认不出归属的目录就重读一次清单；
  // 重读后还认不出的（主目录里的终端这类）签名不变，不会反复读
  const unmatchedCwdSig = useMemo(
    () =>
      [...new Set(terminalRunInputs.map((r) => r.cwd).filter(Boolean))]
        .filter((cwd) => currentFolderKey(cwd, folders, projectPaths, IS_WINDOWS) === null)
        .sort()
        .join("\n"),
    [terminalRunInputs, folders, projectPaths],
  );
  const lastUnmatchedSig = useRef("");
  useEffect(() => {
    if (!unmatchedCwdSig) {
      lastUnmatchedSig.current = "";
      return;
    }
    if (unmatchedCwdSig === lastUnmatchedSig.current) return;
    lastUnmatchedSig.current = unmatchedCwdSig;
    setReposTick((t) => t + 1);
  }, [unmatchedCwdSig]);
  const selectedChatKey =
    page === "terminal" && activeRun?.sessionId
      ? `${activeRun.agentId}\n${activeRun.sessionId}`
      : null;
  // 正看着的标签跟上了点下去的那段，就交回它管高亮（先切页、后换标签时中间那一下不能亮回原来那行）
  useEffect(() => {
    if (selectedChatKey) setPressedChatKey((k) => (k === selectedChatKey ? null : k));
  }, [selectedChatKey]);
  const highlightChatKey = pressedChatKey ?? selectedChatKey;
  // 置顶的不在原课题下重复列
  const unpinnedSessions = useMemo(
    () => (pinnedKeys.size ? sessions.filter((s) => !pinnedKeys.has(`${s.agent}\n${s.sessionId}`)) : sessions),
    [sessions, pinnedKeys],
  );
  const chatsByRoot = useMemo(() => {
    const m = new Map<string, SessionMetaDto[]>();
    for (const r of rows) {
      const k = pathKey(r.repoPath, IS_WINDOWS);
      m.set(k, projectChats(unpinnedSessions, r.repoPath, worktreesOf.get(k) ?? [], IS_WINDOWS));
    }
    return m;
  }, [rows, unpinnedSessions, worktreesOf]);
  const scratchList = useMemo(
    () => scratchChats(unpinnedSessions, projectPaths, IS_WINDOWS),
    [unpinnedSessions, projectPaths],
  );
  // 运行页开着、但列表里还没有的（新对话、纯终端、刚起来还没认出会话的…）：挂在所属文件夹最上面，
  // 不在任何项目里的放「其他打开的」（标签条撤掉后开着的东西都在这里能找到，2026-10-24 第二期）
  const openByFolder = useMemo(() => {
    const listed = new Set<string>(pinnedKeys);
    for (const s of scratchList) listed.add(chatKey(s));
    for (const list of chatsByRoot.values()) for (const s of list) listed.add(chatKey(s));
    const m = new Map<string | null, OpenTabRow[]>();
    for (const r of openTabRows({
      runs: terminalRunInputs,
      listed,
      focusedTabId: terminalActiveTabId,
      folderOf: (cwd) => currentFolderKey(cwd, folders, projectPaths, IS_WINDOWS),
    })) {
      const list = m.get(r.folderKey) ?? [];
      list.push(r);
      m.set(r.folderKey, list);
    }
    return m;
  }, [scratchList, chatsByRoot, pinnedKeys, terminalRunInputs, terminalActiveTabId, folders, projectPaths]);

  // 「展开更多」点过的文件夹多列几段（只记这次打开 Mesa 期间；收起即删）
  const [chatExtra, setChatExtra] = useState<Record<string, number>>({});
  // 树的滚动区有多高：侧栏还有空位就多列几段对话（chatQuotas），窗口拉高拉矮跟着变
  const listRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(0);
  // 滚动条静止时不显示：滚动期间打标，停 0.9s 摘掉（样式见 App.css .ccode-rail-scroll）
  const scrollFadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (scrollFadeTimer.current) clearTimeout(scrollFadeTimer.current);
    },
    [],
  );

  // —— 一次性提醒气泡（规矩与计数在 coach-tips.ts：看得出在绕远路才出、各出一次、一次打开 Mesa 最多主动出一条）——
  /** 侧栏里这一段（对话行按 chatKey，开着的标签行按 tab:标签 id）的那一行 */
  function rowOf(key: string): HTMLElement | null {
    const els = listRef.current?.querySelectorAll<HTMLElement>("[data-chat-key],[data-open-tab]") ?? [];
    return (
      Array.from(els).find((el) => (el.dataset.chatKey ?? `tab:${el.dataset.openTab}`) === key)?.parentElement ?? null
    );
  }
  // 多选（2026-10-27 用户选 B + D，设计稿 docs/design-rail-multiselect-tip-mockup.html）：
  // B：用 ⋯ / 右键一段段归档或置顶，1 分钟内第 2 次时，贴在下一段那行右边提醒能多选；
  // D：选上第一段时，贴在树底「已选 1 段」上面教怎么接着选，选到第 2 段或取消就收（followUp，不占名额）
  const singleActs = useRef<SingleAct[]>([]);
  const [nextTip, setNextTip] = useState(false);
  function noteSingle(kind: SingleAct["kind"], s: SessionMetaDto) {
    const r = noteSingleAct(singleActs.current, kind, Date.now());
    singleActs.current = r.acts;
    if (!r.nudge || !canShowCoachTip("pickNudge")) return;
    // 趁这一段还在侧栏里先取它的下一段；等归档 / 置顶后侧栏重排完再量那一行
    const anchor = nudgeAnchor(pickOrder(), chatKey(s));
    if (!anchor) return;
    const count = r.acts.filter((a) => a.kind === kind).length;
    const verb = kind === "archive" ? "归档" : "置顶";
    window.setTimeout(() => {
      const row = rowOf(anchor);
      if (!row || !canShowCoachTip("pickNudge")) return;
      markCoachTipShown("pickNudge");
      showFloatingCoach({
        anchor: row.getBoundingClientRect(),
        place: "right",
        scrollRoot: listRef.current,
        title: `刚${verb}了 ${count} 段`,
        body: (
          <>
            要一次收拾好几段，按住 <kbd>{PICK_TOGGLE_KEY}</kbd> 点选它们，侧栏底下会出现「已选 N 段」，一起{verb}。
          </>
        ),
        actions: [
          { label: "不用了", onClick: () => {} },
          { label: "从这段开始选", onClick: () => pick(anchor, "toggle") },
        ],
      });
    }, 400);
  }
  useEffect(() => {
    if (picked.size >= 2) {
      // 会多选了：两条都不用再出
      markCoachTipSeen("pickNext");
      markCoachTipSeen("pickNudge");
      setNextTip(false);
    } else if (picked.size === 1) {
      if (canShowCoachTip("pickNext", true)) {
        markCoachTipShown("pickNext", true);
        setNextTip(true);
      }
    } else setNextTip(false);
  }, [picked]);
  // 来回看两段（2026-10-27 用户定）：在侧栏 A → B → A → B 地点，贴在刚点的那行右边提醒 ⌃Tab / Ctrl+Tab
  // （运行页按最近看过的顺序切，TerminalPage）；「并排看」把刚离开的那段放到右侧分屏
  const chatOpens = useRef<ChatOpen[]>([]);
  const openedChats = useRef(new Map<string, { s: SessionMetaDto; project: ProjectDto | null }>());
  function noteSwitch(key: string) {
    const r = noteChatOpen(chatOpens.current, key, Date.now());
    chatOpens.current = r.opens;
    const other = r.other;
    if (!other || !canShowCoachTip("switchBack")) return;
    // 等切过去：只看了没说的那段离开时会自己收掉，⌃Tab 就回不去了，那就不提
    window.setTimeout(() => {
      const runs = useAppStore.getState().terminalRunInputs;
      const open = runs.some((x) => (other.startsWith("tab:") ? `tab:${x.tabId}` : `${x.agentId}\n${x.sessionId}`) === other);
      const row = rowOf(key);
      if (!open || !row || !canShowCoachTip("switchBack")) return;
      markCoachTipShown("switchBack");
      const back = openedChats.current.get(other);
      showFloatingCoach({
        anchor: row.getBoundingClientRect(),
        place: "right",
        scrollRoot: listRef.current,
        title: "在这两段之间来回看？",
        body: (
          <>
            按 <kbd>{IS_MAC ? "Control" : "Ctrl"}</kbd> + <kbd>Tab</kbd> 回到刚才看的那段，不用回侧栏找。
          </>
        ),
        actions: [
          ...(back ? [{ label: "并排看", onClick: () => openChat(back.s, back.project, true) }] : []),
          { label: "知道了", onClick: () => {} },
        ],
      });
    }, 400);
  }
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setListHeight(el.clientHeight));
    ro.observe(el);
    setListHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  const quotaOf = useMemo(() => {
    const sections = [...grouped.pinned, ...grouped.projects, ...grouped.unregistered];
    const open: { key: string; count: number }[] = [];
    if (folderOpen(SCRATCH_FOLDER_KEY, chatOpenPrefs, currentKey)) {
      open.push({ key: SCRATCH_FOLDER_KEY, count: scratchList.length });
    }
    for (const r of sections) {
      const k = pathKey(r.repoPath, IS_WINDOWS);
      if (folderOpen(k, chatOpenPrefs, currentKey)) open.push({ key: k, count: chatsByRoot.get(k)?.length ?? 0 });
    }
    // 行高按 rem 折算（Mac 根 14px、Windows 16px）。2026-10-28 用户嫌挤、照 Claude 客户端放松：对话行 h-8 + 3px 行距；
    // 节头 h-8，收着的之间隔 3px，展开的上下各留 pt-3；展开的文件夹头下垫 3px，再留一行「还有 N 段」（h-6）与底边距 pb-1；
    // 三段容器各 pt-2；置顶 / 其他打开的一节 = 节头 h-8 + 底 pb-4
    const rem = parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 14;
    const headers = sections.length + 1;
    // 「置顶」一节（节头 + 每段一行）也占地方，先扣掉
    const pinnedRows = pinnedList.length > 0 ? 3 * rem + (collapsedSections.includes("pinned") ? 0 : 3 + pinnedList.length * (2 * rem + 3)) : 0;
    const otherCount = openByFolder.get(null)?.length ?? 0;
    const otherRows = otherCount > 0 ? 3 * rem + (collapsedSections.includes("other") ? 0 : 3 + otherCount * (2 * rem + 3)) : 0;
    // 「项目」标签行（mt-4 + h-8）占 3rem，紧跟它的第一段省掉 pt-2
    const fixed =
      headers * (2 * rem + 3) + open.length * (3.25 * rem + 3) + 1.5 * rem + pinnedRows + otherRows + 2.5 * rem;
    const slots = chatSlots({ available: listHeight, fixed, rowHeight: 2 * rem + 3 });
    const shown = chatQuotas({
      counts: open.map((o) => o.count),
      extra: open.map((o) => chatExtra[o.key] ?? 0),
      slots,
    });
    return new Map(open.map((o, i) => [o.key, shown[i]]));
  }, [grouped, chatOpenPrefs, currentKey, scratchList, chatsByRoot, listHeight, chatExtra, pinnedList.length, collapsedSections, openByFolder]);

  /** 一段对话（2026-10-23 照 Claude 客户端侧栏）：与所属文件夹的名字左对齐、不再缩进，只写主题（去掉「MMDD|类型|」，
   *  完整标题放悬停），状态点放行尾；右键改名 / 归档 / 去对话页 */
  /** 对话不缩进，左缘对齐课题行的图标（2026-10-25 用户对照 Claude 客户端：课题名降成小号灰字的分组标题，
   *  项目和对话靠字号、字色分层，不再靠缩进；原 2026-10-24 缩进到名字起点） */
  function renderChat(
    s: SessionMetaDto,
    project: ProjectDto | null,
    folderName?: string,
    origin?: string | null,
    originTag = true,
  ) {
    const key = chatKey(s);
    const full = tidySessionTitle(s).title;
    // 挂在课题下时去掉开头重复的课题名（置顶一节不给，那里看不出属于谁）
    const short = sidebarChatTitle(full, folderName);
    const runDot = chatDot(s, terminalRunInputs);
    // × 只跟着光标走（2026-10-26 用户定）：Mesa 里开着、AI 在跑的才给。Mesa 外终端在写的只亮光标，关不了；
    // Agent 已退出、标签还开着的不给，Mesa 切走 / 没人看时自己收（TerminalPage collectExitedTab）。
    // 看的是运行光标本身，不算叠上去的「做完了没看」
    const holder = runDot
      ? terminalRunInputs.find((r) => r.agentId === s.agent && r.sessionId === s.sessionId && r.running && !r.shell)
      : undefined;
    const selected = key === highlightChatKey;
    // 跑完了没看：标题亮到 l1（同正看着的那段的字色，但不铺底）、行尾蓝光标，点开就消
    const unread = !selected && unreadSet.has(key);
    const dot = withUnread(runDot, unread);
    const agent = AGENTS.find((a) => a.id === s.agent)?.label ?? s.agent;
    if (renaming?.key === key) {
      return (
        <div key={key} className="flex h-8 items-center rounded-md bg-hover px-2">
          <input
            autoFocus
            value={renaming.value}
            aria-label="对话名称"
            onChange={(e) => setRenaming({ key, value: e.target.value })}
            onFocus={(e) => e.currentTarget.select()}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              requestAnimationFrame(() => {
                composingRef.current = false;
              });
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setRenaming(null);
                return;
              }
              if (e.key !== "Enter") return;
              if (
                imeBlocksEnter({
                  isComposing: e.nativeEvent.isComposing,
                  keyCode: e.keyCode,
                  composingLock: composingRef.current,
                })
              )
                return;
              e.preventDefault();
              commitRename(s);
            }}
            onBlur={() => commitRename(s)}
            className="min-w-0 flex-1 bg-transparent text-l1 outline-none"
          />
        </div>
      );
    }
    const menuOpen = chatMenu != null && chatKey(chatMenu.s) === key;
    const isPicked = picked.has(key);
    // 选了好几段时，在其中一段上右键 / 点 ⋯ 出的是对这几段的菜单
    const forPicked = isPicked && picked.size > 1;
    return (
      <div
        key={key}
        className={`group/chat relative grid h-8 grid-cols-[1fr_auto] items-center rounded-md transition-colors ${
          isPicked
            ? `ccode-rail-picked${selected ? " ccode-rail-active" : ""}`
            : selected
              ? "ccode-rail-active bg-rail-sel"
              : menuOpen
                ? "bg-hover"
                : "hover:bg-hover"
        }`}
        onContextMenu={(e) => {
          e.preventDefault();
          if (forPicked) setPickMenu({ x: e.clientX, y: e.clientY });
          else setChatMenu({ x: e.clientX, y: e.clientY, s, project });
        }}
      >
        <button
          type="button"
          data-rail-nav
          // 点下去就开、不等松手（2026-10-24 用户：切对话要和 Claude 客户端一样点了就出来）；
          // 键盘回车 / 空格触发的 click（detail 为 0）照旧开。鼠标移上来 / 键盘走到这行就先取点开要等的东西
          onMouseDown={(e) => {
            if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) openChat(s, project);
          }}
          // 不按修饰键点下去 = 打开这一段，同时清掉多选
          onPointerDown={(e) => {
            if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) clearPicked();
          }}
          onClick={(e) => {
            // ⌘ 点（Windows 上 Ctrl；Mac 上 Ctrl 点是右键）加进 / 拿出，⇧ 点整段选上：只选不开
            if (IS_MAC ? e.metaKey : e.ctrlKey) pick(key, "toggle");
            else if (e.shiftKey) pick(key, "range");
            else if (e.detail === 0) {
              clearPicked();
              openChat(s, project);
            }
          }}
          data-chat-key={key}
          data-picked={isPicked ? "1" : undefined}
          aria-description={picked.size > 0 ? (isPicked ? "已选中，可批量置顶或归档" : "未选中") : undefined}
          onPointerEnter={() => prefetchConversation(s)}
          onFocus={() => prefetchConversation(s)}
          aria-current={selected ? "true" : undefined}
          title={`${full}\n${origin ? `${origin} · ` : ""}${agent} · ${relTime(s.updatedAt)}${dot ? ` · ${dotTitle(dot)}` : ""}\n点一下接着聊`}
          className={`flex h-8 min-w-0 items-center gap-2 rounded-md pl-2 pr-1 ${
            "text-l1"
          }`}
        >
          {/* 字号 13px（.ccode-rail-text，2026-10-24 用户：比「工作台 / 对话管理」的 14px 再小一点点）。写在内层 span 上：
              按钮上写字号会被全站 button { font: inherit } 吞掉。
              字色一律 l1（2026-10-28 用户照 Claude 客户端，推翻 10-24「标题不用全亮着」）：正看着的靠底色，未读靠行尾蓝色光标，不靠变亮 */}
          <span className="ccode-rail-text ccode-rail-fade min-w-0 flex-1 text-left">{short}</span>
          {isPicked && <Check size={13} strokeWidth={2} aria-hidden="true" data-pick-mark className="shrink-0 text-l2" />}
        </button>
        <div className="flex shrink-0 items-center gap-0.5 pr-0.5">
          {/* 置顶一节跨课题：行尾小字写它属于哪个课题（2026-10-26 用户：置顶的看不出是谁的）。
              悬停 / 聚焦时让位给 ⋯，标题宽度大致不变；课题名长了自己截断，不挤标题。
              置顶的全是同一个课题时不写（2026-10-30 用户：都写同一个名字分不出谁，白挤标题），悬停里照写 */}
          {origin && originTag && (
            <span
              className="max-w-[6.5rem] truncate pl-1 pr-1.5 text-micro text-l3 group-hover/chat:hidden group-focus-within/chat:hidden"
              data-chat-origin
            >
              {origin}
            </span>
          )}
          {/* 运行状态光标（2026-10-24 用户：绿点换成 Mesa 的光标）。有光标才占一格、标题在它前面淡出；
              没光标的行标题写到行尾（2026-10-26 用户：右边这一列要干净，同 Claude 客户端侧栏；空格位让标题早早淡掉、右边空一截）；Mesa 外在跑的悬停时不让位，⋯ 出现在它右边。
              干活时的呼吸在悬停时停下、常亮（App.css .ccode-run-caret） */}
          {/* 关掉（2026-10-26 用户定）：Mesa 里开着、AI 在跑的行，悬停时 × 顶替光标那一格，⋯ 固定在最右；行宽不变 */}
          {dot && (
            <span className="flex h-6 w-6 items-center justify-center" data-run-slot>
              <span
                className={`flex items-center justify-center${
                  holder ? " group-hover/chat:hidden group-focus-within/chat:hidden" : ""
                }`}
              >
                <RunCaret state={dot} />
              </span>
              {holder && (
                <button
                  type="button"
                  aria-label={`关掉「${short}」`}
                  title={`关掉：停下它，记录还在（在干活的会先问你）\n现在：${dotTitle(dot)}`}
                  onClick={() => {
                    const row = rowOf(key);
                    if (row) noteMouseCloseChat(row.getBoundingClientRect(), "right", listRef.current);
                    useAppStore.getState().requestCloseTab(holder.tabId);
                  }}
                  className="hidden h-6 w-6 shrink-0 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1 group-hover/chat:flex group-focus-within/chat:flex"
                >
                  <X size={13} strokeWidth={1.8} aria-hidden="true" />
                </button>
              )}
            </span>
          )}
          <button
            type="button"
            aria-label={`「${short}」的更多操作`}
            title="更多操作"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              if (forPicked) setPickMenu({ x: r.right, y: r.bottom + 4, alignRight: true });
              else setChatMenu({ x: r.right, y: r.bottom + 4, s, project, alignRight: true });
            }}
            className={`h-6 w-6 shrink-0 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1 ${
              menuOpen ? "flex" : "hidden group-hover/chat:flex group-focus-within/chat:flex"
            }`}
          >
            <MoreHorizontal size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  /** 开着、但列表里还没有的一行（openTabRows）：点了切过去，行尾 × 关掉（在跑的会先问）。
   *  新对话 / 纯终端前面带个小图标，和对话行区分开；不缩进同 renderChat */
  function renderOpenRow(r: OpenTabRow) {
    const selected = page === "terminal" && r.tabId === terminalActiveTabId;
    const run = terminalRunInputs.find((x) => x.tabId === r.tabId);
    const unread = !selected && run != null && unreadSet.has(unreadKeyOf(run));
    const rowDot = withUnread(r.dot, unread);
    const Icon = r.kind === "terminal" ? SquareTerminal : r.kind === "new" ? SquarePen : null;
    return (
      <div
        key={`tab:${r.tabId}`}
        className={`group/chat relative grid h-8 grid-cols-[1fr_auto] items-center rounded-md transition-colors ${
          selected ? "ccode-rail-active bg-rail-sel" : "hover:bg-hover"
        }`}
      >
        <button
          type="button"
          data-rail-nav
          data-open-tab={r.tabId}
          onClick={() => {
            const st = useAppStore.getState();
            st.setPage("terminal");
            st.focusTab(r.tabId);
            noteSwitch(`tab:${r.tabId}`);
          }}
          aria-current={selected ? "true" : undefined}
          title={
            r.kind === "new"
              ? "还没说话的新对话：发第一句才启动"
              : r.kind === "terminal"
                ? `${r.label}\n开着的终端`
                : `${r.label}${rowDot ? ` · ${dotTitle(rowDot)}` : ""}`
          }
          className={`flex h-8 min-w-0 items-center gap-2 rounded-md pl-2 pr-1 ${
            "text-l1"
          }`}
        >
          {Icon && <Icon size={13} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-l4" />}
          <span className="ccode-rail-text ccode-rail-fade min-w-0 flex-1 text-left">{r.label}</span>
        </button>
        {/* 状态列同对话行：有光标才占一格，标题不进来 */}
        <div className="flex shrink-0 items-center gap-0.5 pr-0.5">
          {rowDot && (
            <span className="flex h-6 w-6 items-center justify-center" data-run-slot>
              <RunCaret state={rowDot} />
            </span>
          )}
          <button
            type="button"
            aria-label={`关掉「${r.label}」`}
            title={r.kind === "new" ? "不要这段新对话了" : "关掉：停下它，记录还在（在跑的会先问你）"}
            onClick={(e) => {
              noteMouseCloseChat(e.currentTarget.parentElement!.getBoundingClientRect(), "right", listRef.current);
              useAppStore.getState().requestCloseTab(r.tabId);
            }}
            className="hidden h-6 w-6 shrink-0 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1 group-hover/chat:flex group-focus-within/chat:flex"
          >
            <X size={13} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  /** 文件夹展开后的那一串：列几段由 chatQuotas 按侧栏空位算（至少 5 段），没列完的点「展开更多」在原地多列 10 段；
   *  点过展开更多的给「收起」回到按空位列。要看全部、搜、整理，去对话页（节头 ⋯ 里有入口） */
  function renderChats(chats: SessionMetaDto[], project: ProjectDto | null, name: string, folderKey: string) {
    const shown = quotaOf.get(folderKey) ?? Math.min(chats.length, SIDEBAR_CHAT_LIMIT);
    const folded = (chatExtra[folderKey] ?? 0) > 0;
    // 「还有 N 段 / 收起」是动作不是对话：比对话行矮、再小一号、最淡（l4），读作挂在最后一段下面的注脚
    // （2026-10-25 用户：原「展开更多」整行和对话一样高，读着像一段对话）
    const linkCls = "flex h-6 items-center rounded-md pl-2 pr-2 text-left text-l3 hover:bg-hover hover:text-l1";
    const opened = openByFolder.get(folderKey) ?? [];
    // 正看着的那段排得比较靠后（从对话页点开的旧对话）：也摆出来，不然侧栏里找不到「现在在哪」
    const selIdx = selectedChatKey ? chats.findIndex((s) => chatKey(s) === selectedChatKey) : -1;
    const visible = selIdx >= shown ? [...chats.slice(0, shown), chats[selIdx]] : chats.slice(0, shown);
    const remaining = chats.length - visible.length;
    const more = remaining > 0;
    return (
      <div role="group" aria-label={`${name} 的对话`} className="space-y-[3px] pb-1 pt-[3px]">
        {opened.map((r) => renderOpenRow(r))}
        {chats.length === 0 ? (
          opened.length === 0 && <p className="py-1 pl-2 pr-2 text-xs text-l4">还没有对话</p>
        ) : (
          visible.map((s) => renderChat(s, project, name))
        )}
        {(more || folded) && (
          <div className="flex items-center">
            {more && (
              <button
                type="button"
                onClick={() =>
                  setChatExtra((prev) => ({ ...prev, [folderKey]: expandedExtra(shown) }))
                }
                title={`还有 ${remaining} 段，在这里多列 ${Math.min(SIDEBAR_CHAT_STEP, remaining)} 段`}
                data-rail-nav
                className={linkCls}
              >
                <span className="text-micro">还有 {remaining} 段</span>
              </button>
            )}
            {folded && (
              <button
                type="button"
                onClick={() =>
                  setChatExtra((prev) => {
                    const next = { ...prev };
                    delete next[folderKey];
                    return next;
                  })
                }
                title="收回到按侧栏空位列的段数"
                data-rail-nav
                className={linkCls}
              >
                <span className="text-micro">收起</span>
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  /** 节头最前的图标格（2026-10-24 用户：「分不清哪些是项目、哪些是会话」）：平时是文件夹（收着 Folder、展开 FolderOpen；
   *  随手聊是单个圆气泡 MessageCircle，同输入框项目按钮里的随手聊、同「新对话」那一家；两个方气泡留给「对话管理」，2026-10-27），一眼看出这一行是装对话的；鼠标移到这一行上换成箭头，点它只开合对话（点名字是进项目页）。
   *  原先的名字后小箭头撤掉，状态由图标本身带 */
  function renderFolderToggle(name: string, open: boolean, onToggle: () => void, kind: "project" | "scratch" | "unregistered") {
    const Icon = kind === "scratch" ? MessageCircle : open ? FolderOpen : Folder;
    return (
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? `收起「${name}」的对话` : `展开「${name}」的对话`}
        title={open ? "收起对话" : "展开对话"}
        // 图标上按下不起拖
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onToggle}
        className={`relative ml-1 flex size-6 shrink-0 items-center justify-center rounded text-l4 hover:text-l1 ${
          kind === "unregistered" ? "opacity-70" : ""
        }`}
      >
        <Icon size={13} strokeWidth={1.8} aria-hidden="true" className="group-hover:invisible group-focus-within:invisible" />
        <span className="absolute inset-0 hidden items-center justify-center group-hover:flex group-focus-within:flex" aria-hidden="true">
          {open ? <ChevronDown size={14} strokeWidth={1.8} /> : <ChevronRight size={14} strokeWidth={1.8} />}
        </span>
      </button>
    );
  }

  /** 树里能用键盘走到的行，按屏上顺序（收着的课题下面的对话本来就不画，不用另判可见） */
  function railNavRows(): HTMLElement[] {
    const root = listRef.current;
    return root ? Array.from(root.querySelectorAll<HTMLElement>("[data-rail-nav]")) : [];
  }
  function focusRailRow(el: HTMLElement | null | undefined) {
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView?.({ block: "nearest" });
  }
  function onRailKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement;
    // 改名输入框里的方向键归输入框
    if (target.tagName === "INPUT") return;
    if (e.key === "Escape" && picked.size > 0) {
      e.preventDefault();
      clearPicked();
      return;
    }
    const rows = railNavRows();
    const current = rows.indexOf(target);
    const next = railNavIndex(e.key, current, rows.length);
    // ⇧↑ / ⇧↓ 在对话上：从起点（第一次按时是这一段）整段选到下一段（2026-10-27 多选）
    const fromKey = target.dataset.chatKey;
    const toKey = next != null ? rows[next]?.dataset.chatKey : undefined;
    if (e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && fromKey && toKey) {
      e.preventDefault();
      if (pickAnchor.current == null) pickAnchor.current = fromKey;
      const anchor = pickAnchor.current;
      setPicked((prev) => nextPicked(prev, pickOrder(), toKey, anchor, "range"));
      focusRailRow(rows[next!]);
      return;
    }
    if (next != null) {
      e.preventDefault();
      focusRailRow(rows[next]);
      return;
    }
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const section = target.dataset.railSection as RailSection | undefined;
    if (section) {
      if ((e.key === "ArrowRight") === collapsedSections.includes(section)) {
        e.preventDefault();
        toggleSection(section);
      }
      return;
    }
    const folder = target.dataset.railFolder;
    if (folder != null) {
      const open = target.dataset.railOpen === "1";
      // → 展开、← 收起；已经是那个状态就不动
      if ((e.key === "ArrowRight") !== open) {
        e.preventDefault();
        toggleFolder(folder, open);
      }
      return;
    }
    // 在一段对话上按 ←：回到它所在课题的节头
    if (e.key === "ArrowLeft") {
      const head = target.closest<HTMLElement>("[data-rail-group]")?.querySelector<HTMLElement>("[data-rail-folder],[data-rail-section]");
      if (head && head !== target) {
        e.preventDefault();
        focusRailRow(head);
      }
    }
  }
  // ⌘0（设置里可改，App 发 requestFocusRail）：光标落到正看着的那段；没有就落到它的课题、再没有落第一行。
  // 侧栏刚从收着展开时树还没画出来，等两帧
  const focusRailReq = useAppStore((s) => s.focusRailReq);
  // 请求是 store 里的待办，领走即清：探出层的树比请求晚挂，挂上时也要领；领过就没了，
  // 之后鼠标路过图标栏再新挂一棵树不会把光标从输入框里拽走。
  // 帧号放 ref、只在卸载时取消：领走会把 focusRailReq 翻回 false，按依赖清理会把刚排的两帧掐掉
  const focusRailRaf = useRef(0);
  useEffect(() => () => cancelAnimationFrame(focusRailRaf.current), []);
  useEffect(() => {
    if (!focusRailReq || !useAppStore.getState().takeFocusRail()) return;
    cancelAnimationFrame(focusRailRaf.current);
    focusRailRaf.current = requestAnimationFrame(() => {
      focusRailRaf.current = requestAnimationFrame(() => {
        const root = listRef.current;
        const rows = railNavRows();
        const pick =
          root?.querySelector<HTMLElement>('[data-rail-nav][aria-current="true"]') ??
          (pinnedList.some((s) => chatKey(s) === selectedChatKey) ? root?.querySelector<HTMLElement>('[data-rail-section="pinned"]') : null) ??
          (openByFolder.get(null)?.some((r) => r.tabId === terminalActiveTabId) ? root?.querySelector<HTMLElement>('[data-rail-section="other"]') : null) ??
          (currentKey ? root?.querySelector<HTMLElement>(`[data-rail-folder="${CSS.escape(currentKey)}"]`) : null) ??
          rows[0];
        focusRailRow(pick);
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRailReq]);

  /** 这个文件夹里有没有跑完没看的（列表里的对话 + 挂在它下面开着的） */
  function folderHasUnread(fkey: string, chats: readonly SessionMetaDto[]): boolean {
    if (unreadSet.size === 0) return false;
    if (chats.some((c) => unreadSet.has(chatKey(c)))) return true;
    return (openByFolder.get(fkey) ?? []).some((r) => {
      const run = terminalRunInputs.find((x) => x.tabId === r.tabId);
      return run != null && unreadSet.has(unreadKeyOf(run));
    });
  }

  /** 节头名字右边到行尾的空白（连同收着时的状态光标）：点了开合对话（2026-10-24 用户：「点击项目名字右边的空白区域无法展开收起」）。
   *  点名字是进项目页，点空白和最前的图标是开合。不进键盘顺序（键盘有图标钮与 ← →）；拖动排序松手那一下不算点 */
  function renderToggleSpace(open: boolean, dot: ChatDot, onToggle: () => void) {
    return (
      <div
        aria-hidden="true"
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          onToggle();
        }}
        className="flex h-7 min-w-0 flex-1 items-center justify-end"
      >
        {renderHeadDot(open, dot)}
      </div>
    );
  }

  /** 收着的文件夹在节头行尾报状态（展开时各段对话自己报） */
  function renderHeadDot(open: boolean, dot: ChatDot) {
    if (open || !dot) return null;
    // 悬停时不让位：＋ 与 ⋯ 出现在它右边。mr-2.5 = 对话行的 pr-1 + mr-1.5，平时两种行的光标竖着对齐
    return <RunCaret state={dot} className="mr-2.5" />;
  }

  /** 行尾悬停的「＋」：在这个文件夹里开一段新对话。
   *  平时不占宽（侧栏窄，名字要这点地方），悬停 / 键盘聚焦到这一行才出来（⋯ 同） */
  function renderNewChat(label: string, title: string, onClick: (e: React.MouseEvent) => void) {
    return (
      <button
        type="button"
        aria-label={label}
        title={title}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onClick}
        className="hidden h-6 w-6 shrink-0 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1 group-hover:flex group-focus-within:flex"
      >
        <Plus size={13} strokeWidth={1.8} aria-hidden="true" />
      </button>
    );
  }

  function reload() {
    const s = useAppStore.getState();
    s.loadProjects().catch(() => {});
    s.bumpProjectsVersion();
  }

  function menuItems(row: TreeRow): ContextMenuItem[] {
    const wsCount = repos.filter((w) =>
      samePath(w.repoPath, row.repoPath, IS_WINDOWS),
    ).length;
    const pinned = isPinned(pins, row.repoPath, IS_WINDOWS);
    return [
      {
        label: pinned ? "取消置顶" : "置顶",
        icon: pinned ? PinOff : Pin,
        onSelect: () => togglePinFor(row),
      },
      {
        label: "在对话页看全部对话",
        icon: MessagesSquare,
        title: "对话页只列这个课题的对话，能搜、能整理",
        onSelect: () => {
          const st = useAppStore.getState();
          st.setSessionsProjectPathReq(row.repoPath);
          st.setPage("sessions");
        },
      },
      {
        label: "在终端打开",
        icon: SquareTerminal,
        title: "在运行页开一个终端，目录就是这个课题（侧栏这个课题下多一行「终端」）",
        onSelect: () => {
          const st = useAppStore.getState();
          st.setPendingTerminal({ cwd: row.repoPath, extraEnv: {}, title: row.name, shellOnly: true });
          st.setPage("terminal");
        },
      },
      {
        label: "重命名项目",
        icon: Pencil,
        disabled: !row.project,
        title: row.project ? undefined : "这个文件夹还没添加到 Mesa",
        onSelect: () =>
          row.project &&
          setRenameTarget({ path: row.repoPath, name: row.project!.name }),
      },
      {
        label: revealFolderLabel(IS_MAC, IS_WINDOWS),
        icon: FolderOpen,
        onSelect: () => {
          void revealItemInDir(row.repoPath).catch((e) =>
            toast(`打不开文件夹：${String(e)}`, "error"),
          );
        },
      },
      {
        label: "复制项目路径",
        icon: Copy,
        onSelect: () => {
          void navigator.clipboard
            .writeText(row.repoPath)
            .then(() => toast("已复制项目路径"))
            .catch(() => toast("复制项目路径失败", "error"));
        },
      },
      { separator: true },
      {
        label: "从 Mesa 移除",
        icon: FolderMinus,
        disabled: !row.project,
        title: row.project
          ? "只移除注册记录，文件夹与工作区都保留"
          : "这个文件夹还没添加到 Mesa",
        onSelect: () => row.project && void removeRegistration(row),
      },
      {
        label: "清除 Mesa 痕迹…",
        icon: Eraser,
        danger: true,
        title: "保留文件夹与你的全部文件；清掉工作区、.ccode 与注册记录",
        onSelect: () => void purgeTraces(row),
      },
      {
        label: "删除项目目录…",
        icon: Trash2,
        danger: true,
        title: "目录移入回收站（可找回）；工作区与分支彻底删除",
        onSelect: () => void deleteProjectDir(row, wsCount),
      },
    ];
  }

  /** 移除项目注册（只删注册记录，不动磁盘目录与工作区） */
  async function removeRegistration(row: TreeRow) {
    if (
      !(await confirmDialog(
        `只移除「${row.name}」的项目注册，不删除磁盘目录；项目内工作区保留。继续？`,
      ))
    )
      return;
    try {
      await invoke("remove_project", { path: row.repoPath });
      reload();
    } catch (reason) {
      toast(`移除失败：${String(reason)}`, "error");
    }
  }

  /** 清除 Mesa 痕迹（中间档）：文件夹与用户文件保留；工作区/分支彻底删，.ccode 入回收站，注册摘除 */
  async function purgeTraces(row: TreeRow) {
    if (
      !(await confirmDialog(
        `清除「${row.name}」的 Mesa 痕迹？\n\n` +
          `文件夹与你的文件：保留\n` +
          `.ccode/（档案卡、任务卡、各步骤 TASK.md 内容）：移入回收站（可找回）\n` +
          `工作区 worktree 与分支、注册记录：彻底删除\n\n` +
          `注意：如果 .ccode 曾被 git 跟踪，改动面板会显示对应删除，需要你自行提交。请先关闭该项目内正在运行的终端标签。`,
        { danger: true },
      ))
    )
      return;
    try {
      const msg = await invoke<string>("purge_project_traces", {
        path: row.repoPath,
      });
      toast(msg);
      reload();
    } catch (reason) {
      toast(String(reason), "error");
    }
  }

  /** 删除项目：工作区（彻底删）+ 主目录（移入回收站）+ 注册记录（未添加仓库同样可用） */
  async function deleteProjectDir(row: TreeRow, wsCount: number) {
    if (
      !(await confirmDialog(
        `删除项目「${row.name}」？\n\n目录：${row.repoPath}\n工作区：${wsCount} 个\n\n目录将移入系统回收站（可找回）；工作区的 worktree 与分支将彻底删除、不可恢复。请先关闭该项目内正在运行的终端标签。`,
        { danger: true },
      ))
    )
      return;
    try {
      await invoke<string>("delete_project_dir", { path: row.repoPath });
      reload();
    } catch (reason) {
      toast(String(reason), "error");
    }
  }

  /** 一节课题（2026-10-23 照 Claude 客户端侧栏，去掉科研 / 编程 / 工作分组）：节头是课题名（点名字进项目页，名字后的箭头开合对话，
   *  行尾悬停出 ＋ 与 ⋯，右键同 ⋯），展开时下面平铺它的对话。拖动排序按整节挪（data-tree-row 挂在节上）。 */
  function renderRow(row: TreeRow, index: number, section: string, paths: string[], pinned = false) {
    const selected =
      selectedRoot != null && samePath(selectedRoot, row.repoPath, IS_WINDOWS);
    const fkey = pathKey(row.repoPath, IS_WINDOWS);
    const open = folderOpen(fkey, chatOpenPrefs, currentKey);
    // 收着、里面有跑完没看的：课题名亮到 l1（展开时各段自己亮）
    const unreadInside = !open && folderHasUnread(fkey, chatsByRoot.get(fkey) ?? []);
    // 收着时节头行尾报状态（这个课题里最要紧的那个：等确认 > 做完没看 > 在干活 > 闲着）
    const dot = strongestCaret([
      folderDot([row.repoPath, ...(worktreesOf.get(fkey) ?? [])], terminalRunInputs, IS_WINDOWS),
      unreadInside ? "unread" : null,
    ]);
    const menuOpen = menu?.row.key === row.key;
    // 拖动：源节跟手；落在「原位 → 目标」之间的节各让出源那么高（节高矮不一，见 tabDragShift）
    const inSection = drag?.section === section ? drag : null;
    const isSource = inSection?.key === row.key;
    const shift =
      inSection && !isSource ? tabDragShift(inSection.slots, inSection.from, inSection.target, index) : 0;
    // 节与节之间：收着的课题一行挨一行（只隔 1px，2026-10-27 用户：收起的文件夹太高）；
    // 自己或上一节展开着才留 pt-3，节头读作分节标题，不和上一节的对话挤成一串
    const prevOpen = index > 0 && folderOpen(pathKey(paths[index - 1], IS_WINDOWS), chatOpenPrefs, currentKey);
    const gap = index === 0 ? "" : open || prevOpen ? "pt-3" : "pt-[3px]";
    return (
      <div
        key={row.key}
        data-tree-row={row.key}
        data-rail-group
        style={
          inSection
            ? {
                transform: `translateY(${isSource ? inSection.dy : shift}px)`,
                transition:
                  !isSource || inSection.settling ? "transform 150ms ease" : "none",
              }
            : undefined
        }
        className={`${gap} ${isSource ? "relative z-10 rounded-md bg-raised" : ""}`}
      >
        <div
          onPointerDown={(e) => onRowPointerDown(e, section, paths, row.key)}
          className={`group relative flex h-8 items-center rounded-md transition-colors ${
            selected && active
              ? "ccode-rail-active bg-rail-sel"
              : menuOpen
                ? "bg-hover"
                : "hover:bg-hover"
          }`}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, row });
          }}
        >
          {renderFolderToggle(row.name, open, () => toggleFolder(fkey, open), row.project ? "project" : "unregistered")}
          <button
            type="button"
            onClick={() => {
              if (suppressClickRef.current) {
                suppressClickRef.current = false;
                return;
              }
              onSelect(row.repoPath);
              // 进项目页的同时把它的对话展开（2026-10-24 用户）；收起只走名字后的箭头
              if (!open) toggleFolder(fkey, false);
            }}
            data-rail-nav
            data-rail-folder={fkey}
            data-rail-open={open ? "1" : "0"}
            title={row.project ? row.repoPath : `${row.repoPath}\n这个文件夹还没添加到 Mesa`}
            aria-current={selected && active ? "page" : undefined}
            // 课题名是分组标题（2026-10-25 用户对照 Claude 客户端；2026-10-27 用户：比 Claude 客户端看着糊）：13px 加粗、字色 l2，对话同字号 l2 常重，对话 13px 不缩进，靠图标与字重分层
            // 2026-10-28：课题名与分节标题同一档 l2 加粗，正看着的课题亮到 l1；里面有未读不再变亮（收着时节头行尾的蓝色光标在报）
            className={`flex h-8 min-w-0 items-center gap-1 rounded-md pr-0.5 ${
              selected && active ? "text-l1" : "text-l2 group-hover:text-l1"
            }`}
          >
            <span className="ccode-rail-text min-w-0 truncate text-left font-medium">{row.name}</span>
            {pinned && <Pin size={10} strokeWidth={1.8} aria-label="已置顶" className="shrink-0 text-l4" />}
          </button>
          {renderToggleSpace(open, dot, () => toggleFolder(fkey, open))}
          {row.project &&
            renderNewChat(
              `在「${row.name}」里开新对话`,
              `在这个项目里开一段新对话（发第一句才启动）`,
              () => startProjectChat(row.project!),
            )}
          <button
            type="button"
            aria-label={`${row.name} 的更多操作`}
            title="更多操作"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            // ⋯ 上按下不起拖
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.right, y: r.bottom + 4, row, alignRight: true });
            }}
            className={`mr-0.5 h-6 w-6 shrink-0 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1 ${
              menuOpen ? "flex" : "hidden group-hover:flex group-focus-within:flex"
            }`}
          >
            <MoreHorizontal size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
        {open && renderChats(chatsByRoot.get(fkey) ?? [], row.project, row.name, fkey)}
      </div>
    );
  }

  /** 随手聊：不挂在项目下的对话，排在最上面。没有项目页，点名字也只开合 */
  function renderScratch() {
    const open = folderOpen(SCRATCH_FOLDER_KEY, chatOpenPrefs, currentKey);
    const unreadInside = !open && folderHasUnread(SCRATCH_FOLDER_KEY, scratchList);
    const dot = strongestCaret([scratchDot(terminalRunInputs, IS_WINDOWS), unreadInside ? "unread" : null]);
    const toggle = () => toggleFolder(SCRATCH_FOLDER_KEY, open);
    return (
      <div data-rail-group>
        <div className="group relative flex h-8 items-center rounded-md transition-colors hover:bg-hover">
          {renderFolderToggle("随手聊", open, toggle, "scratch")}
          <button
            type="button"
            onClick={toggle}
            data-rail-nav
            data-rail-folder={SCRATCH_FOLDER_KEY}
            data-rail-open={open ? "1" : "0"}
            title="不挂在项目下的对话（新对话默认开在这里）"
            className="flex h-8 min-w-0 items-center rounded-md pr-0.5 text-l2 group-hover:text-l1"
          >
            <span className="ccode-rail-text min-w-0 truncate text-left font-medium">随手聊</span>
          </button>
          {renderToggleSpace(open, dot, toggle)}
          {renderNewChat("开一段新的随手聊", "开一段新的随手聊（同侧栏「新对话」）", () => void openQuickChat())}
          <button
            type="button"
            aria-label="随手聊的更多操作"
            title="更多操作"
            aria-haspopup="menu"
            aria-expanded={scratchMenu != null}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setScratchMenu({ x: r.right, y: r.bottom + 4 });
            }}
            className={`mr-0.5 h-6 w-6 shrink-0 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1 ${
              scratchMenu ? "flex" : "hidden group-hover:flex group-focus-within:flex"
            }`}
          >
            <MoreHorizontal size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
        {open && renderChats(scratchList, null, "随手聊", SCRATCH_FOLDER_KEY)}
      </div>
    );
  }

  /** 随手聊节头 ⋯：去对话页看全部 / 一键归档多少天没动的（2026-10-26 用户：随手聊被试手的对话占满） */
  function scratchMenuItems(): ContextMenuItem[] {
    const openKeys = new Set(
      terminalRunInputs.filter((r) => r.sessionId).map((r) => `${r.agentId}\n${r.sessionId}`),
    );
    const stale = staleScratchChats(unpinnedSessions, projectPaths, openKeys, Date.now(), SCRATCH_STALE_DAYS, IS_WINDOWS);
    return [
      {
        label: "在对话页看全部随手聊",
        icon: MessagesSquare,
        title: "对话页只列随手聊，能搜、能整理、能批量删",
        onSelect: () => {
          const st = useAppStore.getState();
          st.setSessionsScratchReq(true);
          st.setPage("sessions");
        },
      },
      {
        label: stale.length > 0 ? `归档 ${SCRATCH_STALE_DAYS} 天没动的（${stale.length} 段）` : `归档 ${SCRATCH_STALE_DAYS} 天没动的`,
        icon: Archive,
        disabled: stale.length === 0,
        title:
          stale.length > 0
            ? "连侧栏没列的空对话一起；置顶的、开着的、外面还在跑的不动。归档后在对话页「更多 → 已归档」里找回"
            : `没有 ${SCRATCH_STALE_DAYS} 天没动的随手聊`,
        onSelect: () => void archiveStale(stale),
      },
    ];
  }

  async function archiveStale(stale: SessionMetaDto[]) {
    if (
      !(await confirmDialog(
        `归档 ${stale.length} 段 ${SCRATCH_STALE_DAYS} 天没动的随手聊？\n\n` +
          `归档后侧栏不再列，对话记录不删；在对话页「更多 → 已归档」里能找回、取消归档。置顶的、开着的不动。`,
      ))
    )
      return;
    await archiveChats(stale, "随手聊");
  }

  /** 逐条写归档（不碰 CLI 源文件），先改本地镜像再强刷；what 是 toast 里的量词后缀 */
  async function archiveChats(list: SessionMetaDto[], what = "对话") {
    const done = new Set<string>();
    const failed: string[] = [];
    for (const s of list) {
      try {
        await invoke("set_session_meta", {
          agent: s.agent,
          sessionId: s.sessionId,
          customTitle: s.customTitle,
          tags: s.tags,
          archived: true,
        });
        done.add(chatKey(s));
      } catch (reason) {
        failed.push(`${tidySessionTitle(s).title}：${String(reason)}`);
      }
    }
    useAppStore.setState({
      sessions: useAppStore.getState().sessions.map((x) => (done.has(chatKey(x)) ? { ...x, archived: true } : x)),
    });
    void useAppStore.getState().loadSessions(true);
    if (failed.length > 0) toast(`已归档 ${done.size} 段，${failed.length} 段失败：${failed[0]}`, "error");
    else toast(`已归档 ${done.size} 段${what}`);
  }

  /** 眼下侧栏里列着的对话，从上到下（⇧ 点整段选用） */
  function pickOrder(): string[] {
    const root = listRef.current;
    return root ? Array.from(root.querySelectorAll<HTMLElement>("[data-chat-key]")).map((el) => el.dataset.chatKey!) : [];
  }
  function pick(key: string, mode: "toggle" | "range") {
    // ⇧ 点的起点：上回 ⌘ 点的那段，没有就是正看着的那段
    const anchor = pickAnchor.current ?? selectedChatKey;
    setPicked((prev) => nextPicked(prev, pickOrder(), key, anchor, mode));
    if (mode === "toggle") pickAnchor.current = key;
    else if (pickAnchor.current == null) pickAnchor.current = anchor ?? key;
  }
  function clearPicked() {
    setPicked((prev) => (prev.size ? new Set() : prev));
    pickAnchor.current = null;
    setPickMenu(null);
  }
  /** 选中的几段，按侧栏里从上到下 */
  function pickedSessions(): SessionMetaDto[] {
    const byKey = new Map(sessions.map((s) => [chatKey(s), s]));
    const order = pickOrder();
    const keys = [...picked].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return keys.map((k) => byKey.get(k)).filter((s): s is SessionMetaDto => s != null);
  }
  function pickMenuItems(): ContextMenuItem[] {
    const list = pickedSessions();
    const keys = list.map(chatKey);
    const allPinned = keys.length > 0 && keys.every((k) => chatPins.includes(k));
    return [
      {
        label: allPinned ? `取消置顶这 ${keys.length} 段` : `置顶这 ${keys.length} 段`,
        icon: allPinned ? PinOff : Pin,
        disabled: keys.length === 0,
        onSelect: () => {
          pinPickedFor(keys);
          clearPicked();
        },
      },
      {
        label: `归档这 ${keys.length} 段…`,
        icon: Archive,
        disabled: keys.length === 0,
        title: "归档后侧栏不再列，对话记录不删；在对话页「更多 → 已归档」里能找回",
        onSelect: () => void archivePicked(list),
      },
      { label: "取消选择", icon: X, onSelect: clearPicked },
      {
        label: `删除这 ${keys.length} 段…`,
        icon: Trash2,
        danger: true,
        disabled: keys.length === 0,
        title: "源文件移入系统回收站（可找回）；AI 还开着的不删",
        onSelect: () => void deleteChats(list),
      },
    ];
  }
  /** AI 还开着的对话不删（CLI 会接着往源文件里写）：先关掉再删 */
  function chatRunning(s: SessionMetaDto): boolean {
    return useAppStore
      .getState()
      .terminalRunInputs.some((r) => r.agentId === s.agent && r.sessionId === s.sessionId && r.running && !r.shell);
  }
  /** 删除（同对话页：源文件进回收站、OpenCode 从库里抹掉，整理数据与快照后端一并清）。
   *  确认后这几行当场从侧栏拿掉，删在后台逐条做，删失败的随刷新回来并报错 */
  async function deleteChats(list: SessionMetaDto[]) {
    const running = list.filter(chatRunning);
    const targets = list.filter((s) => !chatRunning(s));
    if (targets.length === 0) {
      toast("这几段对话的 AI 还开着，先关掉再删", "error");
      return;
    }
    const head = targets
      .slice(0, 3)
      .map((s) => `「${sidebarChatTitle(tidySessionTitle(s).title)}」`)
      .join("、");
    const one = targets.length === 1;
    const hasOpencode = targets.some((s) => s.agent === "opencode");
    const what = one
      ? `删除对话${head}？`
      : `删除这 ${targets.length} 段对话？\n\n${head}${targets.length > 3 ? ` 等 ${targets.length} 段` : ""}`;
    if (
      !(await confirmDialog(
        `${what}\n\n` +
          `源文件移入系统回收站（可找回）${hasOpencode ? "；OpenCode 的对话从它的数据库抹掉，不能进回收站" : ""}。整理数据和保留的快照会一并清掉。` +
          (running.length > 0 ? `\n\n另有 ${running.length} 段的 AI 还开着，这次不删，关掉后再删。` : ""),
        { danger: true },
      ))
    )
      return;
    clearPicked();
    const release = useAppStore.getState().hideSessionsWhileDeleting(targets.map(chatKey));
    const failed: string[] = [];
    for (const s of targets) {
      try {
        await invoke("delete_session", { agent: s.agent, sessionId: s.sessionId, filePath: s.filePath });
      } catch (reason) {
        failed.push(`${tidySessionTitle(s).title}：${String(reason)}`);
      }
    }
    release();
    await useAppStore.getState().loadSessions(true).catch(() => {});
    if (failed.length > 0) toast(`已删除 ${targets.length - failed.length} 段，${failed.length} 段失败：${failed[0]}`, "error");
    else toast(`已删除 ${targets.length} 段对话`);
  }
  async function archivePicked(list: SessionMetaDto[]) {
    const head = list
      .slice(0, 3)
      .map((s) => `「${sidebarChatTitle(tidySessionTitle(s).title)}」`)
      .join("、");
    if (
      !(await confirmDialog(
        `归档这 ${list.length} 段对话？\n\n${head}${list.length > 3 ? ` 等 ${list.length} 段` : ""}\n\n` +
          `归档后侧栏不再列，对话记录不删；在对话页「更多 → 已归档」里能找回、取消归档。开着的对话照样开着。`,
      ))
    )
      return;
    clearPicked();
    await archiveChats(list);
  }

  /** 搜索弹层的料：侧栏能列出的全部对话（置顶 / 随手聊 / 各课题，不受「展开更多」限额）+ 全部课题 */
  function searchSources() {
    type ChatRef = { s: SessionMetaDto; project: ProjectDto | null };
    const chats: RailSearchChat<ChatRef>[] = [];
    const push = (s: SessionMetaDto, project: ProjectDto | null, folder: string) => {
      const fullTitle = tidySessionTitle(s).title;
      chats.push({
        key: chatKey(s),
        title: sidebarChatTitle(fullTitle, folder),
        fullTitle,
        folder,
        updatedAt: s.updatedAt,
        state: withUnread(chatDot(s, terminalRunInputs), chatKey(s) !== highlightChatKey && unreadSet.has(chatKey(s))),
        data: { s, project },
      });
    };
    for (const s of pinnedList) {
      const key = currentFolderKey(s.projectPath, folders, projectPaths, IS_WINDOWS);
      const row = key ? rows.find((r) => pathKey(r.repoPath, IS_WINDOWS) === key) : undefined;
      push(s, row?.project ?? null, row?.name ?? "随手聊");
    }
    for (const s of scratchList) push(s, null, "随手聊");
    for (const r of rows) {
      for (const s of chatsByRoot.get(pathKey(r.repoPath, IS_WINDOWS)) ?? []) push(s, r.project, r.name);
    }
    const projectItems: RailSearchProject<TreeRow>[] = rows.map((r) => ({
      key: r.key,
      name: r.name,
      path: r.repoPath,
      data: r,
    }));
    return { chats, projects: projectItems };
  }

  function renderSectionHeader(key: RailSection, label: string, count: number, dot: ChatDot) {
    const open = !collapsedSections.includes(key);
    const Chevron = open ? ChevronDown : ChevronRight;
    return (
      <button
        type="button"
        data-rail-nav
        data-rail-section={key}
        aria-label={`${open ? "收起" : "展开"}「${label}」`}
        aria-expanded={open}
        aria-controls={`${sectionId}-${key}`}
        aria-description={`${count} 段${!open && dot ? `，${dotTitle(dot)}` : ""}`}
        onClick={() => toggleSection(key)}
        className="group/sec flex h-8 w-full items-center gap-1.5 rounded-md px-2 hover:bg-hover"
      >
        <Chevron size={12} aria-hidden="true" className="shrink-0 text-l3 group-hover/sec:text-l2" />
        <span className={RAIL_SECTION_LABEL}>{label}</span>
        {!open && dot && <span className="ml-auto flex h-6 w-6 items-center justify-center"><RunCaret state={dot} /></span>}
      </button>
    );
  }

  /** 项目标签行：只一个「项目」字，不写数字（2026-10-28 用户：置顶 / 项目后面的数字删掉；节头的段数只留给读屏）。
   *  添加入口在侧栏顶部「新项目」（2026-10-27 用户：同一件事不放两处）。
   *  放在随手聊下面、课题上面（2026-10-26 用户：置顶的对话和随手聊都不是项目，原先压在「项目 N」下面读不通） */
  function renderProjectsLabel() {
    return (
      <div className="mt-4 flex h-8 items-center pl-2.5 pr-0.5">
        <span className={RAIL_SECTION_LABEL}>
          项目
        </span>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-rail-search-open={searchOpen || undefined}>
      {clientOpen.dialog}
      {/* 顶边 6px、底边 12px 渐隐：往下滚时上面的行淡出，不在上面的导航下面硬切半行，底下的行也不撞上工具栏分隔线；
          底部留 12px 内边距，滚到底时最后一行落在渐隐区上面。分节标签（置顶 / 其他打开的 / 项目）的左缘对齐上面导航图标的左缘（16px）。
          键盘（2026-10-24）：光标在树里时 ↑↓ / Home / End 走行，回车打开，← → 收起 / 展开课题，在对话上按 ← 回到它的课题 */}
      <div
        ref={listRef}
        onKeyDown={onRailKeyDown}
        onScroll={(e) => {
          const el = e.currentTarget;
          el.dataset.scrolling = "1";
          if (scrollFadeTimer.current) clearTimeout(scrollFadeTimer.current);
          scrollFadeTimer.current = setTimeout(() => {
            delete el.dataset.scrolling;
          }, 900);
        }}
        className="ccode-rail-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1.5 pb-3 pt-3 [mask-image:linear-gradient(to_bottom,transparent,black_6px,black_calc(100%_-_12px),transparent)]"
      >
        {/* 置顶的对话（2026-10-24）：跨课题钉在最上面，原课题下不重复列 */}
        {pinnedList.length > 0 && (
          <div className="pb-4" data-rail-group>
            {renderSectionHeader("pinned", "置顶", pinnedList.length, strongestCaret(pinnedList.map((s) =>
              withUnread(chatDot(s, terminalRunInputs), chatKey(s) !== highlightChatKey && unreadSet.has(chatKey(s))),
            )))}
            <div id={`${sectionId}-pinned`} role="group" aria-label="置顶的对话" hidden={collapsedSections.includes("pinned")} className="space-y-[3px] pt-[3px]">
              {!collapsedSections.includes("pinned") && (() => {
                const origins = pinnedList.map(originOfChat);
                const mixed = new Set(origins).size > 1;
                return pinnedList.map((s, i) => renderChat(s, projectOfChat(s), undefined, origins[i], mixed));
              })()}
            </div>
          </div>
        )}
        {/* 开着、但不在任何项目里也不是随手聊的（主目录、别的文件夹里开的终端 / 对话）：单列一节放最上 */}
        {(openByFolder.get(null)?.length ?? 0) > 0 && (
          <div className="pb-4" data-rail-group>
            {renderSectionHeader("other", "其他打开的", openByFolder.get(null)!.length, strongestCaret(openByFolder.get(null)!.map((r) => {
              const run = terminalRunInputs.find((x) => x.tabId === r.tabId);
              return withUnread(r.dot, r.tabId !== terminalActiveTabId && !!run && unreadSet.has(unreadKeyOf(run)));
            })))}
            <div id={`${sectionId}-other`} role="group" aria-label="其他打开的" hidden={collapsedSections.includes("other")} className="space-y-[3px] pt-[3px]">
              {!collapsedSections.includes("other") && openByFolder.get(null)!.map((r) => renderOpenRow(r))}
            </div>
          </div>
        )}
        {/* 弹出列表：正聊着的项目提到随手聊上面；它是单独一块，不参与拖动排序 */}
        {currentRow && (
          <div className="pb-4">
            {renderRow(
              currentRow,
              0,
              "current",
              [currentRow.repoPath],
              grouped.pinned.some((r) => r.key === currentRow.key),
            )}
          </div>
        )}
        {/* 随手聊排最上 */}
        {renderScratch()}
        {renderProjectsLabel()}
        {rows.length === 0 ? (
          <p className="px-2.5 py-2 text-xs text-l4">
            还没有项目，点上面的「新项目」添加
          </p>
        ) : (
          // 三段各自一个容器：拖动只在同一段里挪（置顶段的顺序是置顶表本身）；紧跟「项目」标签的第一段不再垫 pt-2
          <>
            {(
              [
                ["pinned", grouped.pinned],
                ["projects", grouped.projects],
                ["unregistered", grouped.unregistered],
              ] as const
            ).map(([section, all], _, sections) => {
              const list = currentRow ? all.filter((r) => r.key !== currentRow.key) : all;
              const first = sections.find(([, a]) => a.some((r) => r.key !== currentRow?.key))?.[0] === section;
              return list.length === 0 ? null : (
                <div key={section} className={first ? undefined : "pt-2"}>
                  {list.map((r, i, rest) =>
                    renderRow(r, i, section, rest.map((x) => x.repoPath), section === "pinned"),
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>

      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {picked.size > 0 ? `已选 ${picked.size} 段对话` : "未选择对话"}
      </span>
      {/* 选了对话时树底下一条：几段、一起置顶 / 归档、取消（右键选中的行是同一份菜单）。薄雾底，不画横线 */}
      {picked.size > 0 && (() => {
        const keys = pickedSessions().map(chatKey);
        const allPinned = keys.length > 0 && keys.every((k) => chatPins.includes(k));
        const action = "flex h-6 items-center gap-1 rounded-md px-1.5 text-l2 hover:bg-hover hover:text-l1 disabled:opacity-40";
        return (
          <div
            role="toolbar"
            aria-label="选中的对话"
            className="relative mx-1.5 mb-1 flex h-8 shrink-0 items-center gap-0.5 rounded-md bg-hover pl-2.5 pr-0.5"
          >
            {/* 第一次选上一段：气泡贴在这条上面教怎么接着选（设计稿 D） */}
            {nextTip && keys.length === 1 && (
              <CoachTip arrow="down" arrowAt={26} className="absolute right-0.5 bottom-[calc(100%+8px)] left-0">
                再按住 <kbd>{PICK_TOGGLE_KEY}</kbd> 点几段加进来；按住 <kbd>{PICK_RANGE_KEY}</kbd> 点，从这段连着选到那段。
              </CoachTip>
            )}
            <span className="mr-auto text-xs text-l2">已选 {keys.length} 段</span>
            <button
              type="button"
              disabled={keys.length === 0}
              onClick={() => {
                pinPickedFor(keys);
                clearPicked();
              }}
              className={action}
            >
              {allPinned ? <PinOff size={13} strokeWidth={1.8} aria-hidden="true" /> : <Pin size={13} strokeWidth={1.8} aria-hidden="true" />}
              <span className="text-xs">{allPinned ? "取消置顶" : "置顶"}</span>
            </button>
            <button
              type="button"
              disabled={keys.length === 0}
              onClick={() => void archivePicked(pickedSessions())}
              className={action}
            >
              <Archive size={13} strokeWidth={1.8} aria-hidden="true" />
              <span className="text-xs">归档</span>
            </button>
            <button
              type="button"
              disabled={keys.length === 0}
              aria-label="删除选中的对话"
              title="删除（源文件移入系统回收站）"
              onClick={() => void deleteChats(pickedSessions())}
              className={`${action} hover:text-err-text`}
            >
              <Trash2 size={13} strokeWidth={1.8} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="取消选择"
              title="取消选择（Esc）"
              onClick={clearPicked}
              className="flex h-6 w-6 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1"
            >
              <X size={13} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>
        );
      })()}


      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          alignRight={menu.alignRight}
          onClose={() => setMenu(null)}
          items={menuItems(menu.row)}
        />
      )}
      {pickMenu && (
        <ContextMenu
          x={pickMenu.x}
          y={pickMenu.y}
          alignRight={pickMenu.alignRight}
          onClose={() => setPickMenu(null)}
          items={pickMenuItems()}
        />
      )}
      {scratchMenu && (
        <ContextMenu
          x={scratchMenu.x}
          y={scratchMenu.y}
          alignRight
          onClose={() => setScratchMenu(null)}
          items={scratchMenuItems()}
        />
      )}
      {chatMenu && (
        <ContextMenu
          x={chatMenu.x}
          y={chatMenu.y}
          alignRight={chatMenu.alignRight}
          onClose={() => setChatMenu(null)}
          items={chatMenuItems(chatMenu.s, chatMenu.project)}
        />
      )}
      {searchOpen && (() => {
        const { chats, projects: projectItems } = searchSources();
        return (
          <RailSearchPalette
            chats={chats}
            projects={projectItems}
            onClose={() => setSearchOpen(false)}
            onOpenChat={(c) => openChat(c.data.s, c.data.project)}
            onOpenProject={(p) => {
              // 同点课题行：进项目页并展开它的对话
              const fkey = pathKey(p.path, IS_WINDOWS);
              onSelect(p.path);
              if (!folderOpen(fkey, chatOpenPrefs, currentKey)) toggleFolder(fkey, false);
            }}
          />
        );
      })()}
      {renameTarget && (
        <RenameProjectModal
          path={renameTarget.path}
          initialName={renameTarget.name}
          onClose={() => setRenameTarget(null)}
          onRenamed={() => {
            setRenameTarget(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

/** 切换面板「最近」段：课题超过这个数才单列最近打开的几个（少时分组本身一眼看完） */
const RECENT_MIN_TOTAL = 8;
const RECENT_COUNT = 5;

type SwitchRow = {
  project: ProjectDto;
  /** 这个课题里开着的 Agent 最要紧的状态（folderDot 同口径） */
  caret: ChatDot;
  current: boolean;
};

/** 命中片段加亮：不区分大小写，只亮第一处（课题名短，多处命中少见） */
function HighlightName({ name, query }: { name: string; query: string }) {
  const q = query.trim().toLowerCase();
  const at = q ? name.toLowerCase().indexOf(q) : -1;
  if (at < 0) return <>{name}</>;
  return (
    <>
      {name.slice(0, at)}
      <span className="font-semibold text-l1">
        {name.slice(at, at + q.length)}
      </span>
      {name.slice(at + q.length)}
    </>
  );
}

/** 项目切换面板的开关与数据：打开时现拉课题清单与工作区（运行绿点要认工作树），
 *  返回 open(锚点) 与要挂载的面板元素。由顶栏项目芯片使用（侧栏收起 / 隐藏时的唯一切换入口）。 */
export function useProjectSwitch(
  selectedRoot: string | null,
  onSelect: (repoPath: string) => void,
) {
  const [panel, setPanel] = useState<{
    left: number;
    top: number;
    rows: SwitchRow[];
  } | null>(null);

  async function open(pos: { left: number; top: number }) {
    try {
      const [projects, workspaces] = await Promise.all([
        invoke<ProjectDto[]>("list_projects"),
        invoke<Pick<WorkspaceDto, "repoPath" | "worktreePath">[]>(
          "list_workspaces",
        ).catch(() => []),
      ]);
      const runs = useAppStore.getState().terminalRunInputs;
      const rows = projects.map((p) => ({
        project: p,
        current:
          selectedRoot != null && samePath(selectedRoot, p.path, IS_WINDOWS),
        caret: folderDot(
          [
            p.path,
            ...workspaces
              .filter((w) => samePath(w.repoPath, p.path, IS_WINDOWS))
              .map((w) => w.worktreePath),
          ],
          runs,
          IS_WINDOWS,
        ),
      }));
      setPanel({ ...pos, rows });
    } catch (reason) {
      toast(`读取项目列表失败：${String(reason)}`, "error");
    }
  }

  const element = panel ? (
    <ProjectSwitchPanel
      left={panel.left}
      top={panel.top}
      rows={panel.rows}
      onClose={() => setPanel(null)}
      onPick={(path) => {
        setPanel(null);
        onSelect(path);
      }}
    />
  ) : null;
  return { open, isOpen: !!panel, element };
}

/** 顶栏左侧的项目芯片（侧栏收起 / 隐藏时才出现，规则见 shell-context.ts）：
 *  点名字＝回到这个课题（已在项目页时改为打开切换面板），点 ⌄＝切换面板。
 *  没有当前课题时只剩「选择项目」，点开即切换面板。 */
export function TitlebarProjectChip({
  name,
  path,
  onProjectPage,
  onSelect,
}: {
  name: string | null;
  path: string | null;
  onProjectPage: boolean;
  onSelect: (repoPath: string) => void;
}) {
  const sw = useProjectSwitch(path, onSelect);
  const anchorRef = useRef<HTMLDivElement>(null);
  const openSwitch = () => {
    const r = anchorRef.current?.getBoundingClientRect();
    if (r) void sw.open({ left: r.left, top: r.bottom + 6 });
  };
  return (
    <div
      ref={anchorRef}
      className={`flex h-6 min-w-0 shrink items-center rounded-md ${
        sw.isOpen ? "bg-hover" : ""
      }`}
    >
      <button
        type="button"
        onClick={() => {
          if (path && !onProjectPage) onSelect(path);
          else openSwitch();
        }}
        title={
          path
            ? onProjectPage
              ? `当前项目：${name}（点击切换）`
              : `回到「${name}」`
            : "选择项目"
        }
        className="flex h-6 min-w-0 shrink items-center gap-1.5 rounded-l-md pl-2 pr-1 text-micro text-l2 hover:bg-hover hover:text-l1"
      >
        <Folder size={13} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-l3" />
        <span className="min-w-0 truncate">{name ?? "选择项目"}</span>
      </button>
      <button
        type="button"
        onClick={openSwitch}
        aria-label="切换项目"
        aria-haspopup="dialog"
        aria-expanded={sw.isOpen}
        className="flex h-6 shrink-0 items-center rounded-r-md px-1 text-l3 hover:bg-hover hover:text-l1"
      >
        <ChevronDown size={12} strokeWidth={1.8} aria-hidden="true" />
      </button>
      {sw.element}
    </div>
  );
}

function ProjectSwitchPanel({
  left,
  top,
  rows,
  onClose,
  onPick,
}: {
  left: number;
  top: number;
  rows: SwitchRow[];
  onClose: () => void;
  onPick: (path: string) => void;
}) {
  const { dismiss, exiting } = useAnimatedDismiss(onClose);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(GROUPS_KEY);
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch {
      /* 缺省全展开 */
    }
    return new Set(["research", "coding", "office"]);
  });
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left, top });

  // 实测面板高度后钳进视口（按钮靠下时整块上移，不被窗口底切掉）
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    setPos({
      left: Math.min(left, window.innerWidth - el.offsetWidth - 8),
      top: Math.max(8, Math.min(top, window.innerHeight - el.offsetHeight - 8)),
    });
  }, [left, top]);

  const q = query.trim().toLowerCase();
  // 段落模型：搜索时一段扁平结果；否则「最近」(课题多时) + 各工作方式分组
  const sections = useMemo(() => {
    if (q) {
      return [
        {
          key: "result",
          label: null as string | null,
          collapsible: false,
          items: rows.filter(
            (r) =>
              r.project.name.toLowerCase().includes(q) ||
              r.project.path.toLowerCase().includes(q),
          ),
        },
      ];
    }
    const out: {
      key: string;
      label: string | null;
      collapsible: boolean;
      items: SwitchRow[];
    }[] = [];
    if (rows.length > RECENT_MIN_TOTAL) {
      // list_projects 已按最近打开降序
      out.push({
        key: "recent",
        label: "最近",
        collapsible: false,
        items: rows.slice(0, RECENT_COUNT),
      });
    }
    // 分组内顺序与侧栏项目树同一张表（拖动排序的结果），两边不各排各的；「最近」段仍按打开时间
    let order: string[] = [];
    try {
      order = parsePins(localStorage.getItem(PROJECT_ORDER_KEY));
    } catch {
      /* 读不出就按最近打开 */
    }
    const ordered = applyOrder(rows, order, (r) => r.project.path, IS_WINDOWS);
    for (const g of groupByWorkMode(ordered, (r) => r.project.workMode)) {
      out.push({
        key: g.mode,
        label: RAIL_WORK_MODE_LABEL[g.mode],
        collapsible: true,
        items: g.items,
      });
    }
    return out;
  }, [rows, q]);

  // 键盘可达的行（折叠组里的不算）
  const flat = sections.flatMap((sec) =>
    sec.collapsible && !expanded.has(sec.key)
      ? []
      : sec.items.map((r) => ({ sec: sec.key, row: r })),
  );
  const clamped = Math.min(cursor, Math.max(flat.length - 1, 0));

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${clamped}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [clamped]);

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(GROUPS_KEY, JSON.stringify([...next]));
      } catch {
        /* 存不下只影响下次 */
      }
      return next;
    });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (query) setQuery("");
      else dismiss();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!flat.length) return;
      const d = e.key === "ArrowDown" ? 1 : -1;
      setCursor((clamped + d + flat.length) % flat.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = flat[clamped];
      if (hit) onPick(hit.row.project.path);
    }
  }

  let idx = -1;
  // 挂到 body：顶栏芯片 / 侧栏按钮的祖先可能带 transform 或 backdrop-filter（会改 fixed 定位基准）
  return createPortal(
    <div
      className={`fixed inset-0 z-50${exiting ? " ccode-exiting" : ""}`}
      onClick={dismiss}
      onContextMenu={(e) => {
        e.preventDefault();
        dismiss();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-label="切换项目"
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        style={pos}
        className={`ccode-anchor-topleft ccode-float-surface absolute flex w-72 flex-col rounded-lg border border-field${exiting ? " ccode-exiting" : ""}`}
      >
        <div className="flex h-10 shrink-0 items-center gap-1.5 px-3">
          <span className="text-xs font-medium text-l1">项目</span>
          <span className="text-micro text-l3">{rows.length}</span>
          <button
            type="button"
            onClick={() => {
              onClose();
              const s = useAppStore.getState();
              s.setPage("workspaces");
              s.setAddProjectOpenReq(Date.now());
            }}
            title="添加项目"
            aria-label="添加项目"
            className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1"
          >
            <FolderPlus size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
        <div className="shrink-0 px-2 pb-2">
          <div className="ccode-rail-search ccode-search-shell flex h-8 items-center gap-2 rounded-md px-2.5">
            <Search size={13} strokeWidth={1.8} className="shrink-0 text-l3" />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setCursor(0);
              }}
              placeholder="搜索项目…"
              aria-label="搜索项目"
              className="min-w-0 flex-1 bg-transparent text-xs text-l1 outline-none placeholder:text-l3"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="清除"
                className="shrink-0 text-l3 hover:text-l1"
              >
                <X size={13} strokeWidth={1.8} />
              </button>
            )}
          </div>
        </div>
        <div
          ref={listRef}
          className="max-h-[min(26rem,62vh)] overflow-y-auto border-t border-hairline px-1.5 pb-1.5 pt-1"
        >
          {rows.length === 0 ? (
            <p className="px-2.5 py-6 text-center text-xs text-l3">
              还没有项目，点右上角添加
            </p>
          ) : flat.length === 0 && q ? (
            <p className="px-2.5 py-6 text-center text-xs text-l3">
              没有匹配「{query.trim()}」的项目
            </p>
          ) : (
            sections.map((sec) => {
              const open = !sec.collapsible || expanded.has(sec.key);
              return (
                <div key={sec.key} className="pt-1">
                  {sec.label &&
                    (sec.collapsible ? (
                      <button
                        type="button"
                        onClick={() => toggle(sec.key)}
                        aria-expanded={open}
                        className="flex h-6 w-full items-center gap-1 rounded-md px-2 text-micro text-l3 hover:text-l1"
                      >
                        {open ? (
                          <ChevronDown size={12} strokeWidth={1.8} />
                        ) : (
                          <ChevronRight size={12} strokeWidth={1.8} />
                        )}
                        <span className="flex-1 text-left">{sec.label}</span>
                        <span>{sec.items.length}</span>
                      </button>
                    ) : (
                      <div className="flex h-6 items-center px-2 text-micro text-l3">
                        {sec.label}
                      </div>
                    ))}
                  {open &&
                    sec.items.map((r) => {
                      idx += 1;
                      const i = idx;
                      const on = i === clamped;
                      return (
                        <button
                          key={`${sec.key}:${r.project.path}`}
                          type="button"
                          data-idx={i}
                          title={r.project.path}
                          onMouseMove={() => {
                            if (cursor !== i) setCursor(i);
                          }}
                          onClick={() => onPick(r.project.path)}
                          className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs ${
                            on ? "bg-hover" : ""
                          } ${r.current ? "font-medium text-l1" : "text-l2"}`}
                        >
                          <Folder
                            size={13}
                            strokeWidth={1.8}
                            aria-hidden="true"
                            className={`shrink-0 ${r.current ? "text-nav-accent" : "text-l3"}`}
                          />
                          <span className="min-w-0 flex-1 truncate">
                            <HighlightName name={r.project.name} query={query} />
                          </span>
                          {q && (
                            <span className="shrink-0 text-micro text-l3">
                              {
                                RAIL_WORK_MODE_LABEL[
                                  normalizeWorkMode(r.project.workMode)
                                ]
                              }
                            </span>
                          )}
                          {r.caret && <RunCaret state={r.caret} />}
                          {r.current && (
                            <Check
                              size={13}
                              strokeWidth={1.8}
                              aria-hidden="true"
                              className="shrink-0 text-l3"
                            />
                          )}
                        </button>
                      );
                    })}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
