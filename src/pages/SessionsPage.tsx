import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  AppWindow,
  Archive,
  ArchiveRestore,
  Copy,
  Download,
  FileText,
  Forward,
  Package,
  Pencil,
  Pin,
  PinOff,
  Scissors,
  ScrollText,
  SquareArrowOutUpRight,
  SquareStack,
  SquareTerminal,
  ChevronDown,
  Trash2,
  Upload,
  WandSparkles,
  X,
} from "lucide-react";
import ContextMenu, { type ContextMenuItem } from "../components/ContextMenu";
import { toast } from "../toast";
import { IS_WINDOWS } from "../hotkeys";
import { useClientOpen } from "../components/ClientOpenDialog";
import { openButtonLabel } from "../client-open";
import { sessionRuntimeKey, useAppStore } from "../store";
import { absTime, relTime } from "../rel-time";
import { agentBrandBadgeStyle } from "../agent-colors";
import { groupSessionsByTask } from "../task-cards";
import {
  QUICK_FILTERS,
  SCOPE_KIND_LABEL,
  applySessionFilters,
  sessionFilterQuickForSearch,
  groupSearchHitsByArchive,
  SEARCH_ARCHIVED_HEADER,
  buildScopeSuggestions,
  groupSessionsByProjectPath,
  sessionLooksInternal,
  sessionProjectLabel,
  scopeDirRows,
  type QuickFilterId,
  type ScopeChip,
} from "../session-filter";
import {
  applySearchHits,
  describeSearchFilters,
  findFocusMessageIndex,
  focusFromMatch,
  parseSearchQuery,
  searchHitKey,
  type SearchFocus,
} from "../session-search";
import { pathKey, samePath } from "../path-utils";
import {
  projectSessionLabel,
  tidySessionTitle,
} from "../session-title";
import { AGENTS } from "../types";
import {
  codexSessionChannelChip,
  pickResumeProfile,
} from "../resume-profile";
import ConversationView from "../components/ConversationView";
import { firstCompleteTurnIndex } from "../conversation-tools";
import { useAutoLoadOlder } from "../auto-load-older";
import GitPanel from "../components/GitPanel";
import HandoffPicker from "../components/HandoffPicker";
import DigestPicker from "../components/DigestPicker";
import { alertDialog, confirmDialog } from "../components/ConfirmDialog";
import { openQuickChat, resumeSessionInTerminal } from "../quick-chat-launch";
import { isScratchCwd } from "../quick-chat";
import SessionImportModal from "../components/SessionImportModal";
import SessionSlimDialog from "../components/SessionSlimDialog";
import { slimMenuAvailable, slimNotice } from "../session-slim";
import { SECRET_EXPORT_WARNING } from "../session-transfer";
import {
  Checkbox,
  dangerActionClass,
  EmptyState,
  fieldClass,
  FoldMark,
  ghostActionClass,
  LoadingRows,
  rowActionClass,
  searchFieldClass,
  InlineNotice,
} from "../components/PageFrame";
import type {
  ChatMessageDto,
  ConversationPageDto,
  OfficialAccountStatusDto,
  SessionExportKey,
  SessionMetaDto,
  SessionMatchDto,
  SessionMatchesDto,
  SessionSearchHitDto,
  SessionSearchResultDto,
  SlimInspectDto,
  TokenUsageDto,
} from "../types";

/** GitPanel 的 onTotals 占位（会话页不消费改动总量；稳定引用避免击穿 memo） */
const NOOP_TOTALS = () => {};

/** 复制恢复命令：Windows 默认交互 shell 是 PowerShell，后端产出的也是该方言。
 *  命令刻意不带密钥（session_resume_command），粘到终端里跑用的是那个终端的全局配置——不能写「粘贴即可」：
 *  Mesa 连接开的 Codex 对话缺 CODEX_API_KEY 接不上，Claude 对话会换到全局配置的网关 / 模型上（2026-10-17 核对） */
const COPY_RESUME_LABEL = IS_WINDOWS
  ? "复制恢复命令（PowerShell）"
  : "复制恢复命令";
const COPY_RESUME_HINT =
  (IS_WINDOWS ? "复制 PowerShell 命令（粘贴到 PowerShell，不要粘到 cmd）。" : "复制一条恢复命令。") +
  "在终端里运行时用的是终端自己的全局配置，不带 Mesa 的连接和密钥；要接着用这段对话原来的连接，选「在外部终端恢复」";
const COPY_RESUME_DONE = IS_WINDOWS
  ? "已复制恢复命令（PowerShell）。它用 PowerShell 里的全局配置，不带 Mesa 的连接"
  : "已复制恢复命令。它用终端里的全局配置，不带 Mesa 的连接";
const EXTERNAL_RESUME_HINT =
  "用这段对话原来的连接（密钥随一次性启动脚本带过去），在设置「终端 → 外部终端」选的终端里接着聊";

function deleteSessionPrompt(s: SessionMetaDto): string {
  if (s.agent === "opencode") {
    return "删除该 OpenCode 对话？将从共享数据库抹掉记录，不能进回收站。整理数据和保留的快照会一并清掉。";
  }
  return "删除该对话的本地文件？源文件将移入系统回收站（可找回）；整理数据和保留的快照会一并清掉。";
}

function deleteProjectSessionsPrompt(
  agent: string,
  path: string,
  count: number,
  extra: number,
): string {
  const extraHint =
    extra > 0
      ? `该项目另有 ${extra} 个已归档/内部对话不在当前列表中，也会被一并删除。`
      : "";
  if (agent === "opencode") {
    return `将从 OpenCode 数据库删除 ${agentLabel(agent)} 下 ${basename(path)} 的 ${count} 条记录（不能进回收站）。${extraHint}继续？`;
  }
  return `将删除 ${agentLabel(agent)} 下 ${basename(path)} 的 ${count} 个对话文件（源文件进回收站，可找回）。${extraHint}继续？`;
}

/** 常驻行内的快筛（其余收进「更多 ▾」，激活的会提到行内常显） */
const PRIMARY_QUICK: ReadonlySet<string> = new Set(["pinned", "live", "today"]);

type Filter =
  | { kind: "all" }
  | { kind: "internal" }
  | { kind: "agent"; agent: string }
  // 项目挂在 agent 下，筛选必须同时限定 agent 和路径（同名目录可能跨 agent）
  | { kind: "project"; agent: string; path: string }
  // 「范围 → 按项目」：只按路径、跨 Agent
  | { kind: "projectPath"; path: string }
  | { kind: "scratch" };

function projectScopePath(f: Filter): string | null {
  return f.kind === "project" || f.kind === "projectPath" ? f.path : null;
}

function fmtTokens(u: TokenUsageDto | null): string {
  if (!u) return "";
  const k = (n: number) =>
    n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
  return `↑${k(u.input)} ↓${k(u.output)}`;
}

function agentLabel(id: string): string {
  return AGENTS.find((a) => a.id === id)?.label ?? id;
}

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

const SEARCH_SYNTAX_HINT = [
  "几个词用空格隔开。还可以这样写：",
  "\"整句\" 或 「整句」：这句话必须原样出现",
  "agent:codex（或 来自:codex）：只看这家 AI 的对话",
  "role:我 / role:ai（或 角色:我）：只搜你说的 / 只搜 AI 的回复",
  "after:2026-10 / before:2026-10-20（或 从: / 到:）：按对话更新日期",
].join("\n");

function sessionTitle(s: SessionMetaDto): string {
  return projectSessionLabel(tidySessionTitle(s));
}

export default function SessionsPage({ visible }: { visible: boolean }) {
  const sessions = useAppStore((s) => s.sessions);
  const loadSessions = useAppStore((s) => s.loadSessions);
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setPage = useAppStore((s) => s.setPage);
  const openSessionReq = useAppStore((s) => s.openSessionReq);
  const setOpenSessionReq = useAppStore((s) => s.setOpenSessionReq);
  const liveSessions = useAppStore((s) => s.liveSessions);
  // 终端里正停在「等你确认」的标签（审批 / 信任 / 切换确认，读屏或 hooks 认出）：列表与详情把「进行中」换成「等你确认」
  const terminalRunInputs = useAppStore((s) => s.terminalRunInputs);
  const waitingTabs = useMemo(
    () => new Set(terminalRunInputs.filter((r) => r.attention === "confirm").map((r) => r.tabId)),
    [terminalRunInputs],
  );
  const profiles = useAppStore((s) => s.profiles);
  const appSettings = useAppStore((s) => s.settings);
  const currentPage = useAppStore((s) => s.page);
  const focusTab = useAppStore((s) => s.focusTab);
  const sessionsQuery = useAppStore((s) => s.sessionsQuery);
  const sessionScopeReq = useAppStore((s) => s.sessionScopeReq);
  const setSessionScopeReq = useAppStore((s) => s.setSessionScopeReq);
  const setSessionsQuery = useAppStore((s) => s.setSessionsQuery);
  const sessionsScratchReq = useAppStore((s) => s.sessionsScratchReq);
  const setSessionsScratchReq = useAppStore((s) => s.setSessionsScratchReq);
  // 话题：移到卡片菜单的候选列表（按项目根缓存）+ 卡片 chip 跳工作区页的一次性请求
  const taskCards = useAppStore((s) => s.taskCards);
  const loadTaskCards = useAppStore((s) => s.loadTaskCards);
  const assignSessionTask = useAppStore((s) => s.assignSessionTask);
  const setSelectProjectReq = useAppStore((s) => s.setSelectProjectReq);
  // 「移到卡片…」子面板：依附会话 ⋯ 菜单，仅项目筛选下可进（此时才知道 project_root）
  const [taskPickerFor, setTaskPickerFor] = useState<SessionMetaDto | null>(
    null,
  );
  // 「移到卡片…」就地弹在右键位置（原居中面板与触发点脱节）
  const [taskPickerPos, setTaskPickerPos] = useState({ x: 0, y: 0 });
  const [query, setQuery] = useState("");
  const [contentHits, setContentHits] = useState<SessionSearchHitDto[] | null>(
    null,
  );
  const [searchingBody, setSearchingBody] = useState(false);
  const searchGenRef = useRef(0);
  // 后台还在建索引时隔一会儿重搜一次；只换结果，不清空列表
  const [indexPending, setIndexPending] = useState(0);
  const [searchTick, setSearchTick] = useState(0);
  const searchedQueryRef = useRef("");
  const searchPollRef = useRef<number | null>(null);
  const [searchFocus, setSearchFocus] = useState<SearchFocus | null>(null);
  const searchFocusRef = useRef<SearchFocus | null>(null);
  searchFocusRef.current = searchFocus;
  // 打开搜索结果时这段对话里的全部命中（上一处 / 下一处按对话先后走）
  const [searchMatches, setSearchMatches] = useState<{
    query: string;
    list: SessionMatchDto[];
    index: number;
    truncated: boolean;
    keywords: string[];
  } | null>(null);
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [showArchived, setShowArchived] = useState(false);
  // 一行 chip 快筛 + 搜索建议落成的作用域 chip（v3.88，纯逻辑在 session-filter.ts）
  const [quick, setQuick] = useState<Set<QuickFilterId>>(() => new Set());
  // 「更多 ▾」收纳的次常用快筛（v3.92 控制区瘦身）：近 7 天 / 内部 AI / 已归档
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const [mobileRailOpen, setMobileRailOpen] = useState(false);
  /** 快筛开关统一入口：archived chip 与 showArchived 是同一件事，必须同步两边
      （此前只有页头按钮同步，单独点 chip 会被 archiveVisible 兜底过滤掉——等于无效） */
  function toggleQuick(id: QuickFilterId) {
    const next = new Set(quick);
    const on = !next.has(id);
    if (on) next.add(id);
    else next.delete(id);
    setQuick(next);
    if (id === "archived") setShowArchived(on);
  }
  const [scopes, setScopes] = useState<ScopeChip[]>([]);  // 分类筛选折叠收进列表栏（默认收起），展开为单列纵向手风琴：点 agent 只展开/收起其项目
  // 子列表（不动列表筛选、不关回放）；「全部项目」/单项目行落筛选且**面板保持展开**（v3.43：
  // 用户要边筛边浏览，选中不收起），手动点标题行或 × 清除才收。
  const [treeOpen, setTreeOpen] = useState(false);
  // 当前展开项目子列表的 agent：只认显式点开/点收，不跟当前筛选（否则选中的 Agent 永远收不回去）
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  /** 「范围」里「按项目」段默认展开，让项目分类不用再点一层 */
  const [projectsOpen, setProjectsOpen] = useState(false);
  // 「主目录」行要认出家目录（问一次就够）
  const [homeDir, setHomeDir] = useState("");
  useEffect(() => {
    void invoke<string>("home_dir")
      .then(setHomeDir)
      .catch(() => {});
  }, []);
  // 批量删除：选择模式 + 勾选集合（键为 agent+sessionId 复合键，防跨 agent 撞 id）
  const [selecting, setSelecting] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [confirmBatch, setConfirmBatch] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [selected, setSelected] = useState<SessionMetaDto | null>(null);
  const [registeredProjectPaths, setRegisteredProjectPaths] = useState<Set<string>>(
    () => new Set(),
  );
  /** 已添加项目路径 → 注册名：列表 meta 行与回放头部写「哪个项目」 */
  const [projectNames, setProjectNames] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const clientOpen = useClientOpen(visible);
  const [codexOfficialConnected, setCodexOfficialConnected] = useState<
    boolean | undefined
  >(undefined);
  const [messages, setMessages] = useState<ChatMessageDto[]>([]);
  const [conversationCursor, setConversationCursor] = useState<number | null>(
    null,
  );
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingConv, setLoadingConv] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 行内编辑中的会话（编辑期间暂停轮询，避免覆盖输入）
  const [editing, setEditing] = useState<{
    agent: string;
    sessionId: string;
    title: string;
    tags: string;
  } | null>(null);
  // 右键菜单：会话行或树里的项目节点
  const [menu, setMenu] = useState<
    | { x: number; y: number; kind: "session"; session: SessionMetaDto }
    | {
        x: number;
        y: number;
        kind: "project";
        agent: string;
        path: string;
        // count 与列表所见口径一致；extra 为口径外但后端会一并删除的数量（归档/内部）
        count: number;
        extra: number;
      }
    | null
  >(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const conversationRequestRef = useRef(0);
  // 回放区「加载更早对话」前插的消息条数：轮询刷新只替换最新一页，靠前缀条数保住已加载的旧消息
  const olderCountRef = useRef(0);
  const editingRef = useRef(false);
  editingRef.current = editing !== null;
  const selectedRef = useRef<SessionMetaDto | null>(null);
  selectedRef.current = selected;
  const retitleAllTriedRef = useRef(false);

  // 打开对话页时按新规则补起名：过短、空泛、缺 Mesa 标题、或互相撞车。手改过的不覆盖。
  // 设置页「会话自动命名」关掉时跳过（后端命令另有闸门）；不置 retitleAllTriedRef，
  // 同一次停留里重新打开开关后，随列表刷新还能补跑。
  useEffect(() => {
    if (!visible || retitleAllTriedRef.current) return;
    if (sessions.length === 0) return;
    if (appSettings?.autoTitleSessions === false) return;
    retitleAllTriedRef.current = true;
    let cancelled = false;
    void invoke<{ renamed: number; skipped: number; failed: number }>(
      "ai_retitle_all_sessions",
    )
      .then(async (result) => {
        if (cancelled) return;
        if (result.renamed > 0) await loadSessions(true);
        if (result.failed > 0) retitleAllTriedRef.current = false;
      })
      .catch(() => {
        if (!cancelled) retitleAllTriedRef.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [visible, sessions.length, loadSessions]);

  // 只有已注册项目才提供「查看项目」；随手聊和内部 AI 不伪装成项目。
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void invoke<{ path: string; name: string }[]>("list_projects")
      .then((projects) => {
        if (cancelled) return;
        setRegisteredProjectPaths(new Set(projects.map((p) => p.path)));
        setProjectNames(new Map(projects.map((p) => [p.path, p.name])));
      })
      .catch((reason) => {
        if (!cancelled) {
          setRegisteredProjectPaths(new Set());
          setProjectNames(new Map());
          setError(`项目范围加载失败：${String(reason)}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const q = query.trim().toLowerCase();
  // 工作区页「会话」跳转：接管搜索词（消费并清空）
  useEffect(() => {
    if (sessionsQuery != null) {
      setQuery(sessionsQuery);
      setSessionsQuery(null);
    }
  }, [sessionsQuery, setSessionsQuery]);

  useEffect(() => {
    if (!sessionsScratchReq) return;
    setFilter({ kind: "scratch" });
    setQuery("");
    setScopes([]);
    setSessionsScratchReq(false);
  }, [sessionsScratchReq, setSessionsScratchReq]);

  useEffect(() => {
    const clearPoll = () => {
      if (searchPollRef.current != null) {
        window.clearTimeout(searchPollRef.current);
        searchPollRef.current = null;
      }
    };
    clearPoll();
    if (!q) {
      searchGenRef.current += 1;
      searchedQueryRef.current = "";
      setContentHits(null);
      setSearchingBody(false);
      setIndexPending(0);
      return;
    }
    const text = query.trim();
    const fresh = searchedQueryRef.current !== text;
    if (fresh) {
      setContentHits(null);
      setSearchingBody(true);
    }
    const gen = ++searchGenRef.current;
    const timer = window.setTimeout(
      () => {
        void invoke<SessionSearchResultDto>("search_sessions", { query: text })
          .then((res) => {
            if (searchGenRef.current !== gen) return;
            searchedQueryRef.current = text;
            setContentHits(res.hits);
            setIndexPending(res.pending);
            setSearchingBody(false);
            setError(null);
            if (res.pending > 0) {
              searchPollRef.current = window.setTimeout(
                () => setSearchTick((t) => t + 1),
                2500,
              );
            }
          })
          .catch((reason) => {
            if (searchGenRef.current !== gen) return;
            setContentHits(null);
            setSearchingBody(false);
            setError(`会话内容搜索失败：${String(reason)}`);
          });
      },
      fresh ? 280 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      clearPoll();
    };
  }, [query, q, searchTick]);

  // 一次性作用域请求：落成 chip（结构化筛选，不是往搜索框塞字符串）
  useEffect(() => {
    if (!sessionScopeReq) return;
    const req = sessionScopeReq;
    setScopes((prev) =>
      prev.some((x) => x.kind === req.kind && x.value === req.value)
        ? prev
        : [...prev, req],
    );
    setSessionScopeReq(null);
  }, [sessionScopeReq, setSessionScopeReq]);
  const searchedResult = useMemo(
    () => applySearchHits(sessions, query, contentHits),
    [sessions, query, contentHits],
  );
  const searched = searchedResult.list;
  const searchSnippets = searchedResult.snippets;
  const hitByKey = useMemo(() => {
    const m = new Map<string, SessionSearchHitDto>();
    for (const h of contentHits ?? []) {
      m.set(searchHitKey(h.agent, h.sessionId), h);
    }
    return m;
  }, [contentHits]);

  function forkSource(s: SessionMetaDto): SessionMetaDto | undefined {
    if (!s.forkedFrom) return undefined;
    return sessions.find((x) => x.agent === s.agent && x.sessionId === s.forkedFrom);
  }

  function forkSourceTitle(s: SessionMetaDto): string {
    const parent = forkSource(s);
    return parent ? sessionTitle(parent) : "已不在的对话";
  }

  function forkHint(s: SessionMetaDto): string {
    return `从「${forkSourceTitle(s)}」中途分出来的对话，分开之后两边各自继续`;
  }

  /** 正文有命中的结果才带焦点；具体落在哪几处，打开时再现算 */
  function focusFor(s: SessionMetaDto): SearchFocus | null {
    const h = hitByKey.get(searchHitKey(s.agent, s.sessionId));
    if (!h || !h.snippet) return null;
    return {
      around: null,
      matchTimestamp: null,
      matchRole: null,
      snippet: h.snippet,
      matchedKeywords: h.matchedKeywords,
    };
  }

  // 搜索建议从「已按文本命中」的集合里提，输入越具体建议越准
  const suggestions = useMemo(
    () => buildScopeSuggestions(searched, query),
    [searched, query],
  );

  /** A. 会话恢复：把会话交给终端页以 resume 语义自动重启 */
  function resumeInTerminal(s: SessionMetaDto) {
    resumeSessionInTerminal(s);
  }

  /** 恢复用的兼容配置（codex 内联 provider 会话只认带 Base URL 的）；
   *  外部恢复命令需要它补 -c provider 定义（定义不含密钥） */
  function resumeProfile(s: SessionMetaDto) {
    if (s.profileId) {
      const exact = profiles.find((p) => p.id === s.profileId && p.agent === s.agent);
      if (exact) return exact;
    }
    let wished = localStorage.getItem(`ccode.lastProfile.${s.agent}`);
    try {
      const last = JSON.parse(localStorage.getItem("ccode.lastLaunch") ?? "null") as
        | { agentId?: string; profileId?: string }
        | null;
      if (last?.agentId === s.agent && last.profileId) wished = last.profileId;
    } catch {
      /* 损坏的本地记忆不阻断恢复 */
    }
    return pickResumeProfile(
      profiles,
      s.agent,
      s.provider,
      wished,
      appSettings?.hiddenProfiles,
      s.agent === "codex"
        ? { officialConnected: codexOfficialConnected }
        : undefined,
    );
  }

  function resumeBaseUrl(s: SessionMetaDto): string | null {
    return resumeProfile(s)?.baseUrl ?? null;
  }

  function resumeModel(s: SessionMetaDto): string | null {
    try {
      const last = JSON.parse(localStorage.getItem("ccode.lastLaunch") ?? "null") as
        | { agentId?: string; profileId?: string; model?: string }
        | null;
      if (
        last?.agentId === s.agent &&
        last.model?.trim() &&
        (!last.profileId || last.profileId === resumeProfile(s)?.id)
      )
        return last.model.trim();
    } catch {
      /* 损坏的本地记忆不阻断恢复 */
    }
    return resumeProfile(s)?.models?.[0] ?? null;
  }

  /** A2. 复制恢复命令（cc-switch 风格）：粘贴到任意终端即可恢复该会话 */
  async function copyResumeCommand(s: SessionMetaDto) {
    try {
      const cmd = await invoke<string>("session_resume_command", {
        agentId: s.agent,
        sessionId: s.sessionId,
        cwd: s.cwd ?? s.projectPath,
        baseUrl: resumeBaseUrl(s),
        provider: s.provider ?? null,
      });
      await navigator.clipboard.writeText(cmd);
      // 菜单点完即关，行内反馈看不到——走 toast。Mesa 连接开的 Codex 对话：命令里的渠道定义按名字取
      // CODEX_API_KEY，终端里没设就接不上，要说在前面
      const needsKey = s.agent === "codex" && Boolean(resumeBaseUrl(s));
      toast(
        needsKey
          ? "已复制恢复命令。这段对话走的是 Mesa 的连接，终端里要先设好 CODEX_API_KEY 才能接上；直接用「在外部终端恢复」更省事"
          : COPY_RESUME_DONE,
        needsKey ? "warning" : "success",
      );
    } catch (e) {
      await alertDialog(`复制失败：${e}`);
    }
  }

  /** A3. 在外部终端应用（Ghostty/iTerm/终端）中恢复会话 */
  async function resumeExternal(s: SessionMetaDto) {
    try {
      await invoke("resume_external_terminal", {
        agentId: s.agent,
        sessionId: s.sessionId,
        cwd: s.cwd ?? s.projectPath,
        profileId: resumeProfile(s)?.id ?? null,
        model: resumeModel(s),
        provider: s.provider ?? null,
        baseUrl: resumeBaseUrl(s),
      });
    } catch (e) {
      await alertDialog(`打开外部终端失败：${e}`);
    }
  }

  /** A4. 交给该 agent 自己的 GUI 客户端继续（预检与修复都在 useClientOpen / 后端 client_open.rs）。
   *  客户端与 CLI 共享本地会话存储，CLI 发起的对话同样能跳过去继续聊 */
  function openInClient(s: SessionMetaDto, clientId?: string) {
    clientOpen.openSession(
      s,
      !!liveSessions[sessionRuntimeKey(s.agent, s.sessionId)],
      clientId,
    );
  }

  // 页面保持挂载：每次回切本页都重查官方账号连接状态（连接页改动后回来立即生效）
  useEffect(() => {
    if (!visible) return;
    invoke<OfficialAccountStatusDto>("official_account_status", {
      agentId: "codex",
    })
      .then((st) => setCodexOfficialConnected(st.connected))
      .catch(() => setCodexOfficialConnected(undefined));
  }, [visible]);

  /** B. 「进行中」反向跳转：聚焦该会话所在的终端标签 */
  function jumpToLive(s: SessionMetaDto) {
    const tabId = liveSessions[sessionRuntimeKey(s.agent, s.sessionId)];
    if (!tabId) return;
    setPage("terminal");
    focusTab(tabId);
  }

  // 快筛 + 作用域 chip（v3.88）先过一道；archived/internal 口径由 applySessionFilters 统一裁决，
  // 下游 archiveVisible 保留原表达式做兜底（showArchived 与 archived chip 已同步）
  const liveKeys = useMemo(
    () => new Set(Object.keys(liveSessions)),
    [liveSessions],
  );
  const quickFiltered = useMemo(
    () => applySessionFilters(searched, quick, scopes, liveKeys),
    [searched, quick, scopes, liveKeys],
  );
  const archiveVisible = useMemo(
    () => quickFiltered.filter((s) => showArchived || !s.archived),
    [quickFiltered, showArchived],
  );
  const regularVisible = useMemo(
    () => archiveVisible.filter((s) => !sessionLooksInternal(s)),
    [archiveVisible],
  );
  // 内部 AI 入口不能吃 applySessionFilters 的默认排除（否则计数恒为 0）。
  // 无头 AI 临时目录在 provenance 过期后 DTO.internal 仍可能是 false。
  const internalVisible = useMemo(
    () =>
      searched.filter(
        (s) => (showArchived || !s.archived) && sessionLooksInternal(s),
      ),
    [searched, showArchived],
  );

  // 分类树：agent → 项目分组；内部 AI 会话固定归并到一个独立入口，不污染普通项目树。
  const tree = useMemo(() => {
    const byAgent = new Map<string, SessionMetaDto[]>();
    for (const s of regularVisible) {
      const g = byAgent.get(s.agent);
      if (g) g.push(s);
      else byAgent.set(s.agent, [s]);
    }
    return [...byAgent.entries()]
      .map(([agent, list]) => {
        const byProject = new Map<string, SessionMetaDto[]>();
        for (const s of list) {
          const g = byProject.get(s.projectPath);
          if (g) g.push(s);
          else byProject.set(s.projectPath, [s]);
        }
        const projects = [...byProject.entries()]
          .map(([path, pl]) => ({ path, list: pl }))
          .sort((a, b) =>
            (b.list[0]?.updatedAt ?? "").localeCompare(
              a.list[0]?.updatedAt ?? "",
            ),
          );
        return { agent, list, projects };
      })
      .sort(
        (a, b) =>
          AGENTS.findIndex((x) => x.id === a.agent) -
          AGENTS.findIndex((x) => x.id === b.agent),
      );
  }, [regularVisible]);

  const projectGroups = useMemo(
    () => groupSessionsByProjectPath(regularVisible, IS_WINDOWS),
    [regularVisible],
  );

  // 展开哪个 agent 的项目子列表：只跟手风琴开关，该 agent 已无会话则视为收起
  const expandedGroup = useMemo(() => {
    if (!expandedAgent) return null;
    return tree.find((g) => g.agent === expandedAgent) ?? null;
  }, [expandedAgent, tree]);

  // 范围已限定到单个项目（分类筛选或范围 chip）：列表行不再逐条写项目名
  const projectScoped =
    filter.kind === "project" ||
    filter.kind === "projectPath" ||
    filter.kind === "scratch" ||
    scopes.some((chip) => chip.kind === "project");
  const sessionList = useMemo(() => {
    let src: SessionMetaDto[];
    if (q) {
      if (filter.kind === "internal") {
        src = searched.filter((s) => sessionLooksInternal(s));
      } else {
        src = applySessionFilters(
          searched,
          sessionFilterQuickForSearch(quick, true),
          scopes,
          liveKeys,
        ).filter((s) => !sessionLooksInternal(s));
      }
    } else {
      src = filter.kind === "internal" ? internalVisible : regularVisible;
    }
    if (filter.kind === "agent")
      src = src.filter((s) => s.agent === filter.agent);
    else if (filter.kind === "project")
      src = src.filter(
        (s) => s.agent === filter.agent && s.projectPath === filter.path,
      );
    else if (filter.kind === "projectPath")
      src = src.filter((s) => samePath(s.projectPath, filter.path, IS_WINDOWS));
    else if (filter.kind === "scratch")
      src = src.filter(
        (s) => isScratchCwd(s.projectPath, IS_WINDOWS) && s.workspace == null,
      );
    return src;
  }, [
    q,
    searched,
    quick,
    scopes,
    liveKeys,
    regularVisible,
    internalVisible,
    filter,
  ]);

  // 项目筛选下按话题分组（对话归入卡片；无卡片的收「未归置」恒在最前，与原「无工作区会话
  // 排最前」同口径）：组内保持时间降序，组按各自最近活跃排序；其余筛选保持纯时间序（跨项目分组无意义）。
  // header 只挂在每组首条上，渲染时据此插组名小标题。
  const displayList = useMemo(() => {
    // 搜索时按相关度排，已归档命中沉底挂「已归档」组头
    if (q) return groupSearchHitsByArchive(sessionList);
    if (projectScopePath(filter) == null)
      return sessionList.map((s) => ({ header: null as string | null, s }));
    return groupSessionsByTask(sessionList).flatMap((g) =>
      g.list.map((s, i) => ({ header: i === 0 ? g.name : null, s })),
    );
  }, [sessionList, filter, q]);
  const shownSessionRows = displayList;

  /** 切换树筛选：同时退出回放态回到列表，保证右栏与所选节点对应 */
  function selectFilter(f: Filter) {
    conversationRequestRef.current += 1;
    setFilter(f);
    setSelected(null);
  }

  /** 分类选择：选到项目/全部即关掉选择面回到列表。Agent 行自己负责展开/收起，不走这里。 */
  function pickScope(f: Filter, keepOpen = false) {
    selectFilter(f);
    if (f.kind === "agent") setExpandedAgent(f.agent);
    setTreeOpen(keepOpen);
  }

  // 项目筛选激活时预取该项目话题（「移到卡片…」菜单候选；非项目目录后端返回空表）
  const projectFilterPath = projectScopePath(filter);
  useEffect(() => {
    if (!projectFilterPath) return;
    void loadTaskCards(projectFilterPath).catch((reason) => {
      setError(`话题加载失败：${String(reason)}`);
    });
  }, [projectFilterPath, loadTaskCards]);

  const [summary, setSummary] = useState<string | null>(null);
  const [aiSummarizing, setAiSummarizing] = useState(false);
  // 导出 Markdown 结果路径（小字提示，随切换会话清空）
  const [exporting, setExporting] = useState(false);
  const [exportPath, setExportPath] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [exportingPack, setExportingPack] = useState(false);
  /** 回放区页签：对话 / 当前项目改动（只读当前磁盘状态，不是历史快照） */
  const [replayTab, setReplayTab] = useState<"chat" | "diff">("chat");

  /** ◈ AI 摘要：生成/重新生成当前回放会话的摘要块 */
  async function onSummarize() {
    if (!selected) return;
    setAiSummarizing(true);
    try {
      const text = await invoke<string>("ai_summarize_session", {
        agent: selected.agent,
        sessionId: selected.sessionId,
        filePath: selected.filePath,
      });
      setSummary(text);
      setError(null);
    } catch (e) {
      setError(`${e}（检查设置页「AI 专用配置」是否可用，或换更快的模型）`);
    } finally {
      setAiSummarizing(false);
    }
  }

  /** 导出当前回放会话为 Markdown（落 ~/Downloads/ccode-exports/，路径由后端返回） */
  async function onExport() {
    if (!selected) return;
    setExporting(true);
    setExportPath(null);
    try {
      const path = await invoke<string>("export_session_markdown", {
        agent: selected.agent,
        sessionId: selected.sessionId,
        filePath: selected.filePath,
        title: sessionTitle(selected),
      });
      setExportPath(path);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  }

  function toExportKey(s: SessionMetaDto): SessionExportKey {
    return {
      agent: s.agent,
      sessionId: s.sessionId,
      filePath: s.filePath,
      title: s.customTitle || s.title,
      projectPath: s.projectPath,
      provider: s.provider ?? null,
      pinned: s.pinned,
      customTitle: s.customTitle,
      tags: s.tags,
      summary: s.summary,
    };
  }

  /** 导出会话包（.ccode-sessions.zip），原文拷贝不含密钥/连接 */
  async function onExportPack(targets: SessionMetaDto[]) {
    const packable = targets.filter((s) => s.agent !== "opencode");
    if (packable.length === 0) {
      setError("OpenCode 会话不能打进会话包（会话在 SQLite 里，留到下一版）");
      return;
    }
    if (
      !(await confirmDialog(SECRET_EXPORT_WARNING, {
        confirmText: "仍要导出",
      }))
    )
      return;
    const dest = await save({
      defaultPath: "ccode-sessions.zip",
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    });
    if (!dest) return;
    setExportingPack(true);
    setError(null);
    try {
      const path = await invoke<string>("export_sessions", {
        entries: packable.map(toExportKey),
        destPath: dest,
      });
      setExportPath(path);
      if (packable.length < targets.length) {
        setError("已跳过 OpenCode 会话（不能打进会话包）");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setExportingPack(false);
    }
  }

  async function openExported() {
    if (!exportPath) return;
    try {
      await revealItemInDir(exportPath);
      setError(null);
    } catch (e) {
      setError(`无法打开：${String(e)}`);
    }
  }

  // 终端页「⤴对话」/「完整回放」跳转：先刷新索引，再按 agent+sessionId 精确打开。
  useEffect(() => {
    if (!openSessionReq) return;
    let cancelled = false;
    void loadSessions(true)
      .then((fresh) => {
        if (cancelled) return;
        const hit = fresh.find(
          (x) =>
            x.agent === openSessionReq.agent &&
            x.sessionId === openSessionReq.sessionId,
        );
        setOpenSessionReq(null);
        if (hit) {
          setFilter(hit.internal ? { kind: "internal" } : { kind: "all" });
          // 目标已归档时同步打开归档开关，保证跳转后在列表中可见
          if (hit.archived) setShowArchived(true);
          void openSession(hit, null);
        } else {
          setError("未找到该对话，可能尚未写入完成或已被 CLI 清理");
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSessionReq, loadSessions]);

  async function openSession(s: SessionMetaDto, focus: SearchFocus | null = null) {
    // 源文件已删除且无快照，无法回放
    if (!s.alive && !s.pinned) {
      setError("该会话的源文件已被删除且没有快照，无法回放");
      return;
    }
    // 选中具体会话 = 浏览结束：收起分类下拉（筛选过程中的点选不收起，见 v3.43）
    setTreeOpen(false);
    setSelected(s);
    setReplayTab("chat");
    setSearchFocus(focus);
    setSearchMatches(null);
    // 摘要缓存命中：已有 summary 直接展示，不再调用 AI
    setSummary(s.summary ?? null);
    setExportPath(null);
    setConversationCursor(null);
    setLoadingConv(true);
    setError(null);
    const request = ++conversationRequestRef.current;
    let target = focus;
    const text = query.trim();
    if (focus && text) {
      // 先在这段对话里找全部命中，从最该看的那处打开；定位失败照常打开，退回按摘录/关键词找
      try {
        const r = await invoke<SessionMatchesDto>("locate_session_matches", {
          agent: s.agent,
          filePath: s.filePath,
          query: text,
        });
        if (request !== conversationRequestRef.current) return;
        if (r.matches.length > 0) {
          const index = r.best ?? 0;
          const keywords = focus.matchedKeywords.length > 0 ? focus.matchedKeywords : r.keywords;
          setSearchMatches({
            query: text,
            list: r.matches,
            index,
            truncated: r.truncated,
            keywords,
          });
          target = focusFromMatch(r.matches[index], keywords);
          setSearchFocus(target);
        }
      } catch {
        // 留着 focus 原样
      }
    }
    try {
      const page = await invoke<ConversationPageDto>(
        "get_session_conversation_page",
        {
          agent: s.agent,
          filePath: s.filePath,
          before: null,
          around: target?.around ?? null,
        },
      );
      if (request !== conversationRequestRef.current) return;
      olderCountRef.current = 0;
      setMessages(page.messages);
      setConversationCursor(page.cursor);
      if (!target) {
        requestAnimationFrame(() => {
          const el = scrollRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        });
      }
    } catch (e) {
      if (request === conversationRequestRef.current) setError(String(e));
    } finally {
      if (request === conversationRequestRef.current) setLoadingConv(false);
    }
  }

  /** 跳到这段对话里的第 i 处命中：按那处的位置重新取一页 */
  async function jumpToMatch(i: number) {
    const s = selected;
    const sm = searchMatches;
    if (!s || !sm) return;
    const m = sm.list[i];
    if (!m) return;
    const focus = focusFromMatch(m, sm.keywords);
    setSearchMatches({ ...sm, index: i });
    setSearchFocus(focus);
    setConversationCursor(null);
    setLoadingConv(true);
    const request = ++conversationRequestRef.current;
    try {
      const page = await invoke<ConversationPageDto>("get_session_conversation_page", {
        agent: s.agent,
        filePath: s.filePath,
        before: null,
        around: m.around,
      });
      if (request !== conversationRequestRef.current) return;
      olderCountRef.current = 0;
      setMessages(page.messages);
      setConversationCursor(page.cursor);
    } catch (e) {
      if (request === conversationRequestRef.current) setError(String(e));
    } finally {
      if (request === conversationRequestRef.current) setLoadingConv(false);
    }
  }

  // ↑/↓ 在列表中切换对话（v3.92）：仅本页可见、无右键菜单/批量管理、非打字焦点时生效；
  // 顺序 = 当前渲染的 displayList（与鼠标点选同一口径），失效且无快照的不可回放行跳过
  useEffect(() => {
    if (currentPage !== "sessions") return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      // 输入法组词中用 ↑/↓ 选候选词，不切换会话
      if (e.isComposing) return;
      if (menu || selecting) return;
      // 上一次解析还没回时不连发（长按方向键扫列表 = 每次按键一次后端全量解析）
      if (loadingConv) return;
      const el = document.activeElement as HTMLElement | null;
      if (el) {
        const tag = el.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          el.isContentEditable
        )
          return;
      }
      const rows = displayList
        .map((d) => d.s)
        .filter((s) => s.alive || s.pinned);
      if (rows.length === 0) return;
      e.preventDefault();
      const idx = rows.findIndex(
        (s) =>
          selected?.agent === s.agent && selected?.sessionId === s.sessionId,
      );
      const delta = e.key === "ArrowDown" ? 1 : -1;
      const next =
        idx === -1
          ? delta > 0
            ? rows[0]
            : rows[rows.length - 1]
          : rows[Math.min(rows.length - 1, Math.max(0, idx + delta))];
      if (next && (selected?.agent !== next.agent || selected?.sessionId !== next.sessionId))
        void openSession(next, focusFor(next));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // loadingConv 必须在依赖里：否则打开会话期间注册的闭包永久捕获 true，↑/↓ 被一直挡住
  }, [currentPage, displayList, selected, menu, selecting, loadingConv, hitByKey]);

  useEffect(() => {
    if (!treeOpen && !moreFiltersOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setTreeOpen(false);
      setMoreFiltersOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [treeOpen, moreFiltersOpen]);

  // 键盘切换/外部跳转后把选中行滚进可视区（block:nearest，在视野内则不动）
  useEffect(() => {
    if (!selected) return;
    const el = document.querySelector(
      `[data-session-key="${CSS.escape(`${selected.agent}:${selected.sessionId}`)}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  async function loadOlderMessages(settle?: () => Promise<void>) {
    if (!selected || conversationCursor === null || loadingOlder) return;
    const selectedKey = `${selected.agent}\n${selected.sessionId}`;
    setLoadingOlder(true);
    try {
      const page = await invoke<ConversationPageDto>(
        "get_session_conversation_page",
        {
          agent: selected.agent,
          filePath: selected.filePath,
          before: conversationCursor,
          around: null,
        },
      );
      // 等手停下来再接到上面，滑动途中插入会顿一下
      await settle?.();
      const currentSelected = selectedRef.current;
      if (
        !currentSelected ||
        `${currentSelected.agent}\n${currentSelected.sessionId}` !== selectedKey
      )
        return;
      const scroller = scrollRef.current;
      if (scroller)
        prependRestoreRef.current = {
          height: scroller.scrollHeight,
          top: scroller.scrollTop,
        };
      setMessages((current) => [...page.messages, ...current]);
      olderCountRef.current += page.messages.length;
      setConversationCursor(page.cursor);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingOlder(false);
    }
  }

  // 前插更早一页后在绘制前把阅读位置挪回原处（放到 rAF 里会先画一帧跳位，滑动时一闪一闪）
  const prependRestoreRef = useRef<{ height: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const restore = prependRestoreRef.current;
    const el = scrollRef.current;
    prependRestoreRef.current = null;
    if (restore && el) el.scrollTop = restore.top + el.scrollHeight - restore.height;
  }, [messages]);

  useAutoLoadOlder(scrollRef, {
    enabled: !loadingConv && conversationCursor !== null,
    busy: loadingOlder,
    onLoad: loadOlderMessages,
    fillKey: messages.length,
  });

  // 页面可见时每 8s 轮询（后端扫描结果缓存 10s，更密的轮询无意义）；
  // 当前打开的会话 updatedAt 变了就重拉对话
  useEffect(() => {
    if (!visible) return;
    let stopped = false;
    const timer = setInterval(async () => {
      if (stopped || editingRef.current) return;
      try {
        const fresh = await loadSessions();
        const cur = selectedRef.current;
        if (!cur) return;
        const updated = fresh.find(
          (s) => s.agent === cur.agent && s.sessionId === cur.sessionId,
        );
        if (updated && updated.updatedAt !== cur.updatedAt) {
          setSelected(updated);
          if (searchFocusRef.current) return;
          const page = await invoke<ConversationPageDto>(
            "get_session_conversation_page",
            {
              agent: updated.agent,
              filePath: updated.filePath,
              before: null,
              around: null,
            },
          );
          const stillSelected = selectedRef.current;
          if (
            !stopped &&
            stillSelected?.agent === updated.agent &&
            stillSelected.sessionId === updated.sessionId
          ) {
            // 只替换最新一页：已前插的更早消息（olderCountRef 条）保留，
            // cursor 维持旧边界不动（否则「加载更早」会重复拉已显示的页）。
            // 前插在上方、新消息追加在下方，阅读位置天然不动；贴底用户跟随到底
            const scroller = scrollRef.current;
            const atBottom = scroller
              ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40
              : false;
            setMessages((current) => [
              ...current.slice(0, Math.min(olderCountRef.current, current.length)),
              ...page.messages,
            ]);
            if (atBottom)
              requestAnimationFrame(() => {
                const el = scrollRef.current;
                if (el) el.scrollTop = el.scrollHeight;
              });
          }
        }
      } catch {
        // 轮询失败静默，下轮再试
      }
    }, 8000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [visible, loadSessions]);

  // 右键菜单打开时：Escape / 任意滚动关闭；点击空白由遮罩处理

  // 批量删除二次确认 4s 后自动复原
  useEffect(() => {
    if (!confirmBatch) return;
    const t = setTimeout(() => setConfirmBatch(false), 4000);
    return () => clearTimeout(t);
  }, [confirmBatch]);

  async function togglePin(s: SessionMetaDto) {
    setError(null);
    try {
      if (s.pinned) {
        if (!(await confirmDialog("取消保留并删除本地快照？", { danger: true })))
          return;
        await invoke("unpin_session", {
          agent: s.agent,
          sessionId: s.sessionId,
          deleteSnapshot: true,
        });
      } else {
        await invoke("pin_session", {
          agent: s.agent,
          sessionId: s.sessionId,
          filePath: s.filePath,
        });
      }
      const fresh = await loadSessions(true);
      // 头部按钮状态随最新数据刷新
      const cur = selectedRef.current;
      if (cur) {
        setSelected(
          fresh.find(
            (x) => x.agent === cur.agent && x.sessionId === cur.sessionId,
          ) ?? cur,
        );
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function toggleArchive(s: SessionMetaDto) {
    setError(null);
    try {
      await invoke("set_session_meta", {
        agent: s.agent,
        sessionId: s.sessionId,
        customTitle: s.customTitle,
        tags: s.tags,
        archived: !s.archived,
      });
      await loadSessions(true);
    } catch (e) {
      setError(String(e));
    }
  }

  /** 删除单个会话（源文件+快照+整理数据，后端一并处理）；正在回放的被删则退出回放 */
  async function deleteSession(s: SessionMetaDto) {
    setError(null);
    if (
      !(await confirmDialog(
        deleteSessionPrompt(s),
        { danger: true },
      ))
    )
      return;
    try {
      await invoke("delete_session", {
        agent: s.agent,
        sessionId: s.sessionId,
        filePath: s.filePath,
      });
      const cur = selectedRef.current;
      if (cur && cur.agent === s.agent && cur.sessionId === s.sessionId) {
        setSelected(null);
        olderCountRef.current = 0;
        setMessages([]);
        setConversationCursor(null);
      }
      await loadSessions(true);
    } catch (e) {
      setError(String(e));
    }
  }

  /** 删除某 agent 下某项目的全部会话（后端按 agent+path 全删，extra 提示口径外数量） */
  async function deleteProjectSessions(
    agent: string,
    path: string,
    count: number,
    extra: number,
  ) {
    setError(null);
    if (
      !(await confirmDialog(
        deleteProjectSessionsPrompt(agent, path, count, extra),
        { danger: true },
      ))
    )
      return;
    try {
      await invoke("delete_project_sessions", { agent, projectPath: path });
      const cur = selectedRef.current;
      if (cur && cur.agent === agent && cur.projectPath === path) {
        setSelected(null);
        olderCountRef.current = 0;
        setMessages([]);
        setConversationCursor(null);
      }
      await loadSessions(true);
    } catch (e) {
      setError(String(e));
    }
  }

  const skey = (s: SessionMetaDto) => `${s.agent}\n${s.sessionId}`;

  function toggleChecked(s: SessionMetaDto) {
    setConfirmBatch(false);
    setChecked((prev) => {
      const next = new Set(prev);
      const k = skey(s);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  /** 全选/取消全选当前筛选结果（sessionList 已含搜索、树筛选、归档开关） */
  const allChecked =
    sessionList.length > 0 && sessionList.every((s) => checked.has(skey(s)));
  // 只统计/删除当前筛选结果内的勾选项，防止误删不可见行
  const checkedInView = sessionList.reduce(
    (n, s) => n + (checked.has(skey(s)) ? 1 : 0),
    0,
  );
  function toggleSelectAll() {
    setConfirmBatch(false);
    setChecked(allChecked ? new Set() : new Set(sessionList.map(skey)));
  }

  function exitSelectMode() {
    setSelecting(false);
    setChecked(new Set());
    setConfirmBatch(false);
  }

  /** 批量删除：逐个走 delete_session，语义与单个删除一致（pin 快照/整理数据由后端一并清理） */
  async function batchDelete() {
    const targets = sessionList.filter((s) => checked.has(skey(s)));
    if (targets.length === 0) return;
    setBatchDeleting(true);
    setError(null);
    const failed: string[] = [];
    for (const s of targets) {
      try {
        await invoke("delete_session", {
          agent: s.agent,
          sessionId: s.sessionId,
          filePath: s.filePath,
        });
      } catch {
        failed.push(sessionTitle(s));
      }
    }
    // 正在回放的会话被删则退出回放
    const cur = selectedRef.current;
    if (cur && checked.has(skey(cur))) {
      setSelected(null);
      olderCountRef.current = 0;
      setMessages([]);
      setConversationCursor(null);
    }
    setBatchDeleting(false);
    exitSelectMode();
    await loadSessions(true);
    if (failed.length > 0)
      setError(
        `已删除 ${targets.length - failed.length} 项，${failed.length} 项失败：${failed.join("、")}`,
      );
  }

  async function saveEdit() {
    if (!editing) return;
    setError(null);
    const cur = sessions.find(
      (s) => s.agent === editing.agent && s.sessionId === editing.sessionId,
    );
    try {
      await invoke("set_session_meta", {
        agent: editing.agent,
        sessionId: editing.sessionId,
        customTitle: editing.title.trim() || null,
        tags: editing.tags
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter(Boolean),
        archived: cur?.archived ?? false,
      });
      setEditing(null);
      await loadSessions(true);
    } catch (e) {
      setError(String(e));
    }
  }

  // 编辑表单输入框：走共享 fieldClass（原为逐字复制的本地类，圆角/焦点与全站不齐）
  const input = fieldClass;
  // 回放头部「恢复 ▾」下拉（外部恢复/复制命令），坐标定位 + 全屏遮罩点击关闭
  const [resumeMenu, setResumeMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  // 会话瘦身：选中 Claude Code 会话时只读估算请求体（撞网关 413 的前兆）；瘦身成功后 tick+1 重测
  const [slimInspect, setSlimInspect] = useState<SlimInspectDto | null>(null);
  const [slimOpen, setSlimOpen] = useState(false);
  const [slimTick, setSlimTick] = useState(0);
  useEffect(() => {
    setSlimInspect(null);
    if (
      !selected ||
      selected.agent !== "claude-code" ||
      !selected.alive ||
      selected.internal
    ) {
      return;
    }
    let cancelled = false;
    invoke<SlimInspectDto>("session_slim_inspect", {
      agent: selected.agent,
      filePath: selected.filePath,
    })
      .then((r) => {
        if (!cancelled) setSlimInspect(r);
      })
      .catch(() => {
        /* 检测只是提示，失败不打扰 */
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.agent, selected?.filePath, selected?.alive, selected?.internal, slimTick]);
  // 「◈ 接力到…」目标选择器（回放头部 ⋯ 菜单进入）
  const [handoffFor, setHandoffFor] = useState<SessionMetaDto | null>(null);
  // 「◈ 提炼接力…」目标选择器（AI 蒸馏简报；回放头部下拉与行内 ⋯ 菜单进入）
  const [digestFor, setDigestFor] = useState<SessionMetaDto | null>(null);

  // 收件箱「接力简报待发送 → 去发送」：按后台任务定位会话并重开 DigestPicker（复用已生成简报）
  const digestOpenReq = useAppStore((s) => s.digestOpenReq);
  const setDigestOpenReq = useAppStore((s) => s.setDigestOpenReq);
  const digestJob = useAppStore((s) => s.digestJob);
  useEffect(() => {
    if (!digestOpenReq) return;
    setDigestOpenReq(null);
    if (!digestJob) return;
    const hit = sessions.find(
      (s) => s.agent === digestJob.agent && s.sessionId === digestJob.sessionId,
    );
    if (hit) setDigestFor(hit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digestOpenReq]);

  /** 移到卡片 / 移出卡片：assign_session_task 落库后刷新列表（store 动作内完成） */
  async function assignTask(s: SessionMetaDto, taskId: string | null) {
    setTaskPickerFor(null);
    setError(null);
    try {
      await assignSessionTask(s.agent, s.sessionId, taskId);
    } catch (e) {
      setError(String(e));
    }
  }

  // 「未归置」组标题行右侧的归类提示：仅项目筛选下且该项目已有卡片时显示
  // （没有卡片时不教用户做还做不了的事）
  const scopePath = projectScopePath(filter);
  const projectHasCards =
    scopePath != null && (taskCards[scopePath] ?? []).length > 0;

  const filterActive = (f: Filter) =>
    (filter.kind === "all" && f.kind === "all") ||
    (filter.kind === "internal" && f.kind === "internal") ||
    (filter.kind === "agent" &&
      f.kind === "agent" &&
      filter.agent === f.agent) ||
    (filter.kind === "project" &&
      f.kind === "project" &&
      filter.agent === f.agent &&
      filter.path === f.path) ||
    (filter.kind === "projectPath" &&
      f.kind === "projectPath" &&
      samePath(filter.path, f.path, IS_WINDOWS)) ||
    (filter.kind === "scratch" && f.kind === "scratch");
  const filterChipLabel =
    filter.kind === "internal"
      ? "Mesa 内部 AI"
      : filter.kind === "scratch"
        ? "随手聊"
        : filter.kind === "agent"
        ? agentLabel(filter.agent)
        : filter.kind === "project"
          ? `${agentLabel(filter.agent)} · ${sessionProjectLabel(filter.path, projectNames, IS_WINDOWS) ?? basename(filter.path)}`
          : filter.kind === "projectPath"
            ? (sessionProjectLabel(filter.path, projectNames, IS_WINDOWS) ?? basename(filter.path))
            : null;

  return (
    <div className="relative flex h-full bg-canvas">
      {/* 会话列表栏（P1a：375px 固定宽，rail2 底）：标题/计数 + 次按钮 + 搜索 + 折叠分类树 + 会话行 */}
      <div className={`ccode-sessions-rail flex w-[375px] shrink-0 flex-col border-r border-hairline bg-rail2 ${mobileRailOpen ? "ccode-mobile-rail-open" : ""}`}>
        <div className="shrink-0 px-3 pb-2.5 pt-3">
          <button
            type="button"
            className="mb-2 ml-auto flex h-7 items-center rounded-md px-2 text-xs text-l3 hover:bg-hover hover:text-l1 md:hidden"
            onClick={() => setMobileRailOpen(false)}
          >
            关闭列表
          </button>
          {selecting ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex min-h-7 items-center justify-between gap-2">
                <span className="whitespace-nowrap text-xs text-l3">已选 {checkedInView} 项</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={toggleSelectAll}
                    className={`${ghostActionClass} whitespace-nowrap`}
                    title="对当前筛选结果全选或取消"
                  >
                    {allChecked ? "取消全选" : "全选筛选结果"}
                  </button>
                  <button
                    onClick={exitSelectMode}
                    className={`${ghostActionClass} whitespace-nowrap`}
                  >
                    取消
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  disabled={checkedInView === 0 || batchDeleting}
                  onClick={() => {
                    if (confirmBatch) {
                      setConfirmBatch(false);
                      void batchDelete();
                    } else {
                      setConfirmBatch(true);
                    }
                  }}
                  className={`whitespace-nowrap ${
                    confirmBatch
                      ? `${dangerActionClass.replace("h-8", "h-7").replace("px-3", "px-2")} min-w-0 flex-1`
                      : "inline-flex h-7 items-center justify-center rounded-md px-2 text-xs text-err-text hover:bg-hover disabled:opacity-50"
                  }`}
                >
                  {batchDeleting
                    ? "删除中…"
                    : confirmBatch
                      ? `确认删除 ${checkedInView} 项（含 pin 快照）`
                      : `删除 ${checkedInView} 项`}
                </button>
                <button
                  disabled={checkedInView === 0 || exportingPack}
                  onClick={() => {
                    const targets = sessionList.filter((s) =>
                      checked.has(skey(s)),
                    );
                    void onExportPack(targets);
                  }}
                  className={`${ghostActionClass} gap-1 whitespace-nowrap`}
                >
                  {exportingPack ? (
                    "导出中…"
                  ) : (
                    <>
                      <Upload size={14} strokeWidth={1.8} aria-hidden="true" />
                      导出
                    </>
                  )}
                </button>
                {exportPath && (
                  <button
                    type="button"
                    onClick={() => void openExported()}
                    className={`${ghostActionClass} whitespace-nowrap`}
                    title={exportPath}
                  >
                    打开
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-baseline gap-2">
                <h1 className="shrink-0 text-base font-semibold text-l1">对话</h1>
                {/* 计数副题：与既有口径一致，搜索时透出命中数 */}
                <span className="truncate text-micro text-l4">
                  当前 {sessionList.length}
                  {q ? ` · 搜索命中 ${searched.length}` : ""} · 总计{" "}
                  {sessions.length}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {/* 「显示已归档」已并入快筛 chip（toggleQuick 单控点，v3.92），页头不再重复 */}
                <button
                  type="button"
                  onClick={() => setImportOpen(true)}
                  className={`${rowActionClass} gap-1`}
                  title="从另一台机器导入会话包"
                >
                  <Download size={14} strokeWidth={1.8} aria-hidden="true" />
                  导入
                </button>
                <button
                  type="button"
                  onClick={() => setSelecting(true)}
                  className={rowActionClass}
                >
                  批量管理
                </button>
              </div>
            </div>
          )}
          {/* 搜索框：inset 底色分层（无描边），共享 searchFieldClass */}
          <input
            className={`mt-2 w-full ${searchFieldClass}`}
            placeholder="搜索标题、标签，或对话里说过的话"
            title={SEARCH_SYNTAX_HINT}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {/* 搜索建议（v3.88）：输入即给出结构化维度，点一下落成可叠加 chip——
              取代「展开手风琴 → 找 agent → 展开 → 找项目」的三次点击钻取 */}
          {!selecting && q && suggestions.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {suggestions.map((c) => (
                <button
                  key={`${c.kind}:${c.value}`}
                  type="button"
                  onClick={() => {
                    setScopes((prev) =>
                      prev.some(
                        (x) => x.kind === c.kind && x.value === c.value,
                      )
                        ? prev
                        : [...prev, c],
                    );
                    setQuery("");
                  }}
                  title={`${SCOPE_KIND_LABEL[c.kind]}：${c.value}`}
                  className="max-w-56 truncate rounded-sm px-1.5 py-0.5 text-xs text-l2 hover:bg-hover hover:text-l1"
                >
                  <span className="text-l4">{SCOPE_KIND_LABEL[c.kind]} </span>
                  {c.label}
                </button>
              ))}
            </div>
          )}
          {!selecting && q && (
            <div className="mt-2 flex flex-wrap items-center gap-1">
              <button
                type="button"
                onClick={() => setQuery("")}
                className="max-w-48 truncate rounded-sm px-1.5 py-0.5 text-xs text-l2 hover:bg-hover hover:text-l1"
                title="清除搜索"
              >
                搜索：{query.trim()} ×
              </button>
              {describeSearchFilters(parseSearchQuery(query)).map((d) => (
                <span key={d} className="text-micro text-l3" title={SEARCH_SYNTAX_HINT}>
                  {d}
                </span>
              ))}
              {searchingBody && (
                <span className="text-micro text-l4">正在搜正文…</span>
              )}
              {!searchingBody && indexPending > 0 && (
                <span
                  className="text-micro text-l4"
                  title="第一次搜索或很多对话有更新时，Mesa 在后台给对话正文建索引；建好的会自动补进结果"
                >
                  还有 {indexPending} 条对话在建索引，结果会自动补全
                </span>
              )}
            </div>
          )}
          {/* 已落作用域 chip（可叠加、可逐个 ×） */}
          {!selecting && scopes.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {scopes.map((c) => (
                <button
                  key={`${c.kind}:${c.value}`}
                  type="button"
                  onClick={() =>
                    setScopes((prev) =>
                      prev.filter(
                        (x) => !(x.kind === c.kind && x.value === c.value),
                      ),
                    )
                  }
                  title={`移除筛选：${SCOPE_KIND_LABEL[c.kind]} ${c.value}`}
                  className="max-w-56 truncate rounded-sm bg-seg-sel px-1.5 py-0.5 text-xs text-l1"
                >
                  <span className="opacity-70">{SCOPE_KIND_LABEL[c.kind]} </span>
                  {c.label} ×
                </button>
              ))}
            </div>
          )}
          {/* 一行 chip 快筛 + 当前分类下拉（不挤会话列表）：
              常用 3 个常驻；近 7 天/已归档收进「更多 ▾」，激活的提到行内常显（内部 AI 只在「范围 → 其他」一处）。
              分类是下拉而不是内嵌手风琴：展开时列表高度不变，点选项目后面板保持开（边筛边浏览）。 */}
          <div className="relative mt-2">
          <div className="flex flex-wrap items-center gap-1">
            {!selecting && (
              <>
                {QUICK_FILTERS.filter(
                  (f) => PRIMARY_QUICK.has(f.id) || quick.has(f.id),
                ).map((f) => {
                  const on = quick.has(f.id);
                  return (
                    <button
                      key={f.id}
                      type="button"
                      aria-pressed={on}
                      title={f.title}
                      onClick={() => toggleQuick(f.id)}
                      className={`rounded-full px-2 py-0.5 text-micro ${
                        on
                          ? "bg-seg-sel text-l1"
                          : "text-l3 hover:bg-hover hover:text-l1"
                      }`}
                    >
                      {f.label}
                    </button>
                  );
                })}
                <span className="relative">
                  <button
                    type="button"
                    onClick={() => setMoreFiltersOpen((v) => !v)}
                    aria-expanded={moreFiltersOpen}
                    title="更多快筛（近 7 天 / 已归档）"
                    className="rounded-full px-2 py-0.5 text-micro text-l3 hover:bg-hover hover:text-l1"
                  >
                    更多 ▾
                  </button>
                  {moreFiltersOpen && (
                    <>
                      <div
                        className="fixed inset-0 z-40"
                        onClick={() => setMoreFiltersOpen(false)}
                      />
                      <div className="ccode-float-surface absolute left-0 top-full z-50 mt-1 w-36 rounded-md border border-field p-1">
                        {QUICK_FILTERS.filter(
                          (f) => !PRIMARY_QUICK.has(f.id) && f.id !== "internal",
                        ).map((f) => {
                          const on = quick.has(f.id);
                          return (
                            <button
                              key={f.id}
                              type="button"
                              aria-pressed={on}
                              title={f.title}
                              onClick={() => {
                                toggleQuick(f.id);
                                setMoreFiltersOpen(false);
                              }}
                              className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-xs hover:bg-hover"
                            >
                              <span
                                className={`w-3 shrink-0 text-cta ${on ? "" : "opacity-0"}`}
                              >
                                ✓
                              </span>
                              <span className={on ? "text-l1" : "text-l3"}>
                                {f.label}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </span>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => setTreeOpen((v) => !v)}
            aria-expanded={treeOpen}
            title="按 Agent / 项目筛选"
            className={`mt-1.5 flex h-7 w-full items-center gap-1 rounded-md px-2 text-xs ${
              filterChipLabel || treeOpen
                ? "bg-seg-sel text-l1"
                : "text-l3 hover:bg-hover hover:text-l1"
            }`}
          >
            <span className="shrink-0 text-l4">范围</span>
            <span className="min-w-0 flex-1 truncate text-left">
              {filterChipLabel ?? "全部对话"}
            </span>
            {filterChipLabel && (
              <span
                role="button"
                title="清除分类筛选"
                onClick={(e) => {
                  e.stopPropagation();
                  selectFilter({ kind: "all" });
                  setTreeOpen(false);
                }}
                className="px-1 text-l4 hover:text-l1"
              >
                ×
              </span>
            )}
            <ChevronDown
              size={13}
              strokeWidth={1.8}
              aria-hidden="true"
              className={`shrink-0 text-l4 transition-transform ${treeOpen ? "rotate-180" : ""}`}
            />
          </button>
          </div>
        </div>
        {error && !selected && (
          <p className="shrink-0 px-3 py-1 text-xs text-err-text">{error}</p>
        )}
        {treeOpen ? (
            // 范围选择面（2026-10-17 重排）：按「先找项目、再按 Agent、最后是特殊来源」分段，段头只是标题不带计数；
            // 每行右侧数字统一是「对话条数」。原先 Agent 在上、项目在下且组头计数是项目个数，
            // 已添加项目与家目录 / tmp 混排、名字用目录名，内部 AI 又和「更多」里的快筛重复。
            <div className="min-h-0 flex-1 overflow-auto py-1">
              <div className="mb-1 flex items-center justify-between px-3">
                <span className="text-micro text-l4">选择范围</span>
                <button
                  type="button"
                  className={ghostActionClass}
                  onClick={() => setTreeOpen(false)}
                >
                  完成
                </button>
              </div>
              {(() => {
                const rowCls = (on: boolean) =>
                  `mx-1 flex h-7 w-[calc(100%-8px)] items-center justify-between gap-2 rounded-md px-2 text-left text-xs ${
                    on ? "bg-rail-sel text-l1" : "text-l2 hover:bg-hover"
                  }`;
                const countCls = (on: boolean) =>
                  `shrink-0 text-xs tabular-nums ${on ? "text-l2" : "text-l4"}`;
                const sectionCls = "mx-3 mb-0.5 mt-3 text-micro text-l4";
                const scratchCount = regularVisible.filter(
                  (s) => isScratchCwd(s.projectPath, IS_WINDOWS) && s.workspace == null,
                ).length;
                const dirs = scopeDirRows(projectGroups, projectNames, homeDir, IS_WINDOWS);
                const dirRow = (row: { path: string; label: string; count: number }) => {
                  const on = filterActive({ kind: "projectPath", path: row.path });
                  return (
                    <button
                      key={pathKey(row.path, IS_WINDOWS)}
                      type="button"
                      onClick={() => pickScope({ kind: "projectPath", path: row.path })}
                      title={row.path}
                      className={rowCls(on)}
                    >
                      <span className="truncate">{row.label}</span>
                      <span className={countCls(on)}>{row.count}</span>
                    </button>
                  );
                };
                return (
                  <>
                    <button
                      type="button"
                      onClick={() => pickScope({ kind: "all" })}
                      className={rowCls(filterActive({ kind: "all" }))}
                    >
                      <span className="truncate">全部对话</span>
                      <span className={countCls(filterActive({ kind: "all" }))}>
                        {regularVisible.length}
                      </span>
                    </button>
                    {scratchCount > 0 && (
                      <button
                        type="button"
                        onClick={() => pickScope({ kind: "scratch" })}
                        title="不属于任何项目的对话（新对话默认放在 ~/ccode/scratch）"
                        className={rowCls(filterActive({ kind: "scratch" }))}
                      >
                        <span className="truncate">随手聊</span>
                        <span className={countCls(filterActive({ kind: "scratch" }))}>
                          {scratchCount}
                        </span>
                      </button>
                    )}

                    {dirs.projects.length > 0 && (
                      <>
                        <div className={sectionCls}>项目</div>
                        {dirs.projects.map(dirRow)}
                      </>
                    )}
                    {dirs.others.length > 0 && (
                      <>
                        <button
                          type="button"
                          onClick={() => setProjectsOpen((v) => !v)}
                          aria-expanded={projectsOpen}
                          title="没添加到 Mesa 的目录：主目录、临时目录、外部仓库"
                          className="mx-1 mt-0.5 flex h-7 w-[calc(100%-8px)] items-center gap-1.5 rounded-md px-2 text-left text-xs text-l3 hover:bg-hover"
                        >
                          <FoldMark open={projectsOpen} />
                          <span className="min-w-0 flex-1 truncate">其他目录</span>
                          <span className="shrink-0 text-micro text-l4">{dirs.others.length} 个</span>
                        </button>
                        {projectsOpen && (
                          <div className="ml-4 border-l border-hairline pl-1">
                            {dirs.others.map(dirRow)}
                          </div>
                        )}
                      </>
                    )}

                    {tree.length > 0 && <div className={sectionCls}>Agent</div>}
                    {tree.map((g) => {
                      const on = filterActive({ kind: "agent", agent: g.agent });
                      // 该 agent 下某个项目是当前筛选：行上弱提示，不抢「选中」填充
                      const childOn = filter.kind === "project" && filter.agent === g.agent;
                      const open = expandedGroup?.agent === g.agent;
                      return (
                        <div key={g.agent}>
                          <div
                            className={`mx-1 flex h-7 w-[calc(100%-8px)] items-center rounded-md text-xs ${
                              on ? "bg-rail-sel text-l1" : "text-l2 hover:bg-hover"
                            }`}
                          >
                            {/* 展开钮单独一格：点名字就是筛这家（原先点名字只展开，还要再点一层「全部项目」） */}
                            <button
                              type="button"
                              onClick={() => setExpandedAgent(open ? null : g.agent)}
                              aria-expanded={open}
                              aria-label={open ? `收起 ${agentLabel(g.agent)} 的项目` : `展开 ${agentLabel(g.agent)} 的项目`}
                              title="按项目细分"
                              className="flex h-7 w-6 shrink-0 items-center justify-center rounded-md text-l4 hover:text-l1"
                            >
                              <FoldMark open={open} />
                            </button>
                            <button
                              type="button"
                              onClick={() => pickScope({ kind: "agent", agent: g.agent })}
                              className="flex h-7 min-w-0 flex-1 items-center justify-between gap-2 pr-2 text-left"
                            >
                              <span className={`truncate ${childOn ? "text-l1" : ""}`}>
                                {agentLabel(g.agent)}
                              </span>
                              <span className={countCls(on)}>{g.list.length}</span>
                            </button>
                          </div>
                          {open && (
                            <div className="mb-0.5 ml-6 border-l border-hairline pl-1">
                              {g.projects.map((p) => {
                                const pActive = filterActive({
                                  kind: "project",
                                  agent: g.agent,
                                  path: p.path,
                                });
                                return (
                                  <button
                                    key={p.path}
                                    type="button"
                                    onClick={() => {
                                      pickScope({
                                        kind: "project",
                                        agent: g.agent,
                                        path: p.path,
                                      });
                                    }}
                                    onContextMenu={(e) => {
                                      e.preventDefault();
                                      // count 与列表所见口径一致（排除 internal、跟随归档开关）；
                                      // 后端按 agent+path 全删，口径外数量单独透出给确认文案
                                      const all = sessions.filter(
                                        (session) =>
                                          session.agent === g.agent &&
                                          session.projectPath === p.path,
                                      );
                                      const visible = all.filter(
                                        (session) =>
                                          !session.internal &&
                                          (showArchived || !session.archived),
                                      );
                                      setMenu({
                                        x: e.clientX,
                                        y: e.clientY,
                                        kind: "project",
                                        agent: g.agent,
                                        path: p.path,
                                        count: visible.length,
                                        extra: all.length - visible.length,
                                      });
                                    }}
                                    title={`${p.path}\n右键可删除这家 Agent 在此目录的对话`}
                                    className={rowCls(pActive)}
                                  >
                                    <span className="truncate">
                                      {sessionProjectLabel(p.path, projectNames, IS_WINDOWS) ??
                                        basename(p.path)}
                                    </span>
                                    <span className={countCls(pActive)}>{p.list.length}</span>
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {internalVisible.length > 0 && (
                      <>
                        <div className={sectionCls}>其他</div>
                        <button
                          type="button"
                          onClick={() => pickScope({ kind: "internal" })}
                          title="Mesa 自己调用 AI 生成提交信息、摘要、雷达解读等产生的后台对话，默认不在列表里。超过保留期（默认 30 天）的会自动清理，在 设置 → 数据与存储 里改"
                          className={rowCls(filterActive({ kind: "internal" }))}
                        >
                          <span className="truncate">Mesa 内部 AI</span>
                          <span className={countCls(filterActive({ kind: "internal" }))}>
                            {internalVisible.length}
                          </span>
                        </button>
                      </>
                    )}
                  </>
                );
              })()}
              {tree.length === 0 && (
                <EmptyState
                  title="还没有对话"
                  detail="各项目里 Agent 做过的记录会列在这里。定时巡检等后台跑的不进这份列表。"
                />
              )}
            </div>
        ) : (
        <div className="min-h-0 flex-1 overflow-auto">
            {shownSessionRows.map(({ header, s }) => {
              const isEditing =
                editing?.agent === s.agent && editing.sessionId === s.sessionId;
              if (isEditing && editing) {
                return (
                  <Fragment key={skey(s)}>
                    {header && (
                      <div className="flex items-center justify-between gap-2 border-b border-hairline bg-strip px-4 pb-1 pt-2 text-xs text-l3">
                        <span>{header === "未归置" ? header : `▤ ${header}`}</span>
                        {header === "未归置" && projectHasCards && (
                          <span className="text-micro text-l4">
                            ⋯ 可移到卡片归类
                          </span>
                        )}
                      </div>
                    )}
                    <div className="space-y-2 border-b border-hairline bg-inset p-4">
                    <input
                      className={input}
                      placeholder="自定义标题（留空则用原标题）"
                      value={editing.title}
                      onChange={(e) =>
                        setEditing({ ...editing, title: e.target.value })
                      }
                      autoFocus
                    />
                    <input
                      className={input}
                      placeholder="标签，逗号分隔"
                      value={editing.tags}
                      onChange={(e) =>
                        setEditing({ ...editing, tags: e.target.value })
                      }
                    />
                    <div className="flex justify-end gap-2 text-sm">
                      <button
                        onClick={() => setEditing(null)}
                        className="text-l3 hover:text-l1"
                      >
                        取消
                      </button>
                      <button
                        onClick={saveEdit}
                        className="text-l1 hover:underline"
                      >
                        保存
                      </button>
                    </div>
                  </div>
                  </Fragment>
                );
              }
              const clickable = s.alive || s.pinned;
              const isLive =
                s.live ||
                !!liveSessions[sessionRuntimeKey(s.agent, s.sessionId)];
              // 选中行浅填充（rail-sel 令牌）
              const isSelected =
                selected?.agent === s.agent &&
                selected?.sessionId === s.sessionId;
              return (
                <Fragment key={skey(s)}>
                  {header && (
                    <div className="flex items-center justify-between gap-2 border-b border-hairline bg-strip px-3 pb-1 pt-2 text-xs text-l3">
                      <span>
                        {header === "未归置" || header === SEARCH_ARCHIVED_HEADER
                          ? header
                          : `▤ ${header}`}
                      </span>
                      {header === "未归置" && projectHasCards && (
                        <span className="text-micro text-l4">
                          ⋯ 可移到卡片归类
                        </span>
                      )}
                    </div>
                  )}
                <div
                  data-session-key={`${s.agent}:${s.sessionId}`}
                  onClick={() => {
                    if (selecting) toggleChecked(s);
                    else if (clickable) void openSession(s, focusFor(s));
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (selecting) return;
                    setMenu({
                      x: event.clientX,
                      y: event.clientY,
                      kind: "session",
                      session: s,
                    });
                  }}
                  className={`group border-b border-hairline px-3 py-1.5 text-sm ${
                    selecting || clickable
                      ? "cursor-pointer hover:bg-hover"
                      : "opacity-60"
                  } ${isSelected ? "bg-rail-sel" : ""}`}
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    {selecting && (
                      <span
                        onClick={(event) => event.stopPropagation()}
                        className="mr-1 shrink-0"
                      >
                        <Checkbox
                          checked={checked.has(skey(s))}
                          onChange={() => toggleChecked(s)}
                          label={
                            <span className="sr-only">
                              选择 {sessionTitle(s)}
                            </span>
                          }
                        />
                      </span>
                    )}
                    {isLive && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          jumpToLive(s);
                        }}
                        disabled={
                          !liveSessions[sessionRuntimeKey(s.agent, s.sessionId)]
                        }
                        title={
                          waitingTabs.has(liveSessions[sessionRuntimeKey(s.agent, s.sessionId)] ?? "")
                            ? "在等你确认（批准一个操作或选一项），点击跳到终端"
                            : liveSessions[sessionRuntimeKey(s.agent, s.sessionId)]
                              ? "正在终端中进行，点击跳转"
                              : "CLI 仍在外部终端中运行"
                        }
                        className="-ml-1 flex h-6 w-4 shrink-0 items-center justify-center rounded-sm disabled:cursor-default"
                      >
                        <span
                          className={`size-2 rounded-full ${
                            waitingTabs.has(liveSessions[sessionRuntimeKey(s.agent, s.sessionId)] ?? "")
                              ? "bg-warn-text"
                              : "bg-ok-text"
                          }`}
                        />
                      </button>
                    )}
                    {s.pinned && (
                      // 常驻状态标记本身可点（取消保留）——不再在 hover 区重复一个 ⚑
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void togglePin(s);
                        }}
                        title="已保留（点击取消）"
                        className="shrink-0 rounded-sm px-0.5 text-l2 hover:text-cta"
                      >
                        ⚑
                      </button>
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm font-medium leading-7 text-l1">
                      {sessionTitle(s)}
                    </span>
                    {s.chainCount > 1 && (
                      <span
                        className="shrink-0 px-1 text-xs text-l3"
                        title="同一段对话接着聊时存成了多个文件，这里合并成一条，打开和继续都接最新那份"
                      >
                        {s.chainCount} 次继续
                      </span>
                    )}
                    {s.forkedFrom && (
                      <span
                        className="shrink-0 px-1 text-xs text-l3"
                        title={forkHint(s)}
                      >
                        分支
                      </span>
                    )}
                    {!s.alive && (
                      <span
                        className="shrink-0 rounded-sm bg-warn px-1 text-xs text-warn-text"
                        title="源文件已失效"
                      >
                        失效
                      </span>
                    )}
                    {/* 右侧：平时相对时间，悬停换成操作（同一槽，不留空） */}
                    <span
                      className={`shrink-0 font-mono text-micro text-l4 ${
                        selecting
                          ? ""
                          : "group-hover:hidden group-focus-within:hidden"
                      }`}
                      title={absTime(s.updatedAt)}
                    >
                      {relTime(s.updatedAt)}
                    </span>
                    {!selecting && (
                      <div className="ml-1 hidden shrink-0 items-center gap-1 group-hover:flex group-focus-within:flex">
                        {clickable && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              resumeInTerminal(s);
                            }}
                            className={`${ghostActionClass} text-l2`}
                          >
                            恢复
                          </button>
                        )}
                        {!s.pinned && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              void togglePin(s);
                            }}
                            title="保留（并生成快照，防 CLI 自动清理）"
                            className={`${ghostActionClass} text-l3`}
                          >
                            ⚑
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void deleteSession(s);
                          }}
                          title="删除"
                          aria-label={`删除：${sessionTitle(s)}`}
                          className={`${ghostActionClass} text-l3 hover:text-err-text`}
                        >
                          <Trash2 size={14} strokeWidth={1.8} />
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setMenu({
                              x: event.clientX - 160,
                              y: event.clientY + 4,
                              kind: "session",
                              session: s,
                            });
                          }}
                          title="更多操作"
                          aria-label={`更多操作：${sessionTitle(s)}`}
                          className="flex h-7 w-7 items-center justify-center rounded-sm text-sm text-l3 hover:bg-hover hover:text-l1"
                        >
                          ⋯
                        </button>
                      </div>
                    )}
                  </div>
                  {/* meta 行：agent 品牌色胶囊（扫一眼分家）· token mono 小字 + 步骤/接力/标签 chip，AI 摘要截断尾随 */}
                  <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-micro text-l4">
                    <span
                      className="shrink-0 rounded-full px-1.5 py-px font-medium"
                      style={agentBrandBadgeStyle(s.agent)}
                    >
                      {agentLabel(s.agent)}
                    </span>
                    {/* 哪个项目：范围已限定到单个项目时不写（同一事实不重复）；
                        原先 meta 行常常只剩一枚 agent 胶囊，第二行几乎是空的 */}
                    {!projectScoped && (() => {
                      const label = sessionProjectLabel(s.projectPath, projectNames, IS_WINDOWS);
                      return label ? (
                        <span className="max-w-32 shrink-0 truncate text-l3" title={s.projectPath}>
                          {label}
                        </span>
                      ) : null;
                    })()}
                    {s.workspace && (
                      // 反向跳转（v3.88）：这个 badge 以前只能看不能点——会话与项目/步骤的
                      // 四条关联全是单向的。点它回工作区页并选中该项目
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectProjectReq(s.projectPath);
                          setPage("workspaces");
                        }}
                        className="max-w-28 truncate rounded-sm px-1 text-l3 hover:text-l1"
                        title={
                          (s.stepName
                            ? `研究步骤：${s.stepName}（工作区：${s.workspace}）`
                            : `工作区：${s.workspace}`) + "\n点击回项目页"
                        }
                      >
                        ⎇ {s.stepName ?? s.workspace}
                      </button>
                    )}
                    {s.taskName && (
                      <button
                        type="button"
                        className="max-w-28 shrink-0 truncate rounded-sm px-1 text-l3 hover:text-l1"
                        title={`目标：${s.taskName}（点击回项目页）`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectProjectReq(s.projectPath);
                          setPage("workspaces");
                        }}
                      >
                        ▤ {s.taskName}
                      </button>
                    )}
                    {s.handoffFromAgent && (
                      <span
                        className="max-w-36 shrink-0 truncate px-1 text-l3"
                        title={`接自 ${agentLabel(s.handoffFromAgent)} 的对话（简报接力，非记忆转移）`}
                      >
                        ⇄ 接自 {agentLabel(s.handoffFromAgent)}
                      </span>
                    )}
                    {s.tags.slice(0, 2).map((tag) => (
                      <span
                        key={tag}
                        className="max-w-28 truncate px-1 text-l3"
                      >
                        {tag}
                      </span>
                    ))}
                    {s.tags.length > 2 && (
                      <span className="shrink-0 text-l4">
                        +{s.tags.length - 2}
                      </span>
                    )}
                    {s.summary && (
                      <span
                        className="min-w-0 flex-1 truncate text-l3"
                        title={s.summary}
                      >
                        · {s.summary}
                      </span>
                    )}
                  </div>
                  {searchSnippets[searchHitKey(s.agent, s.sessionId)] && (
                    <p
                      className="mt-0.5 truncate text-micro text-l4"
                      title={searchSnippets[searchHitKey(s.agent, s.sessionId)]}
                    >
                      正文 {searchSnippets[searchHitKey(s.agent, s.sessionId)]}
                    </p>
                  )}
                </div>
                </Fragment>
              );
            })}
            {sessionList.length === 0 && (
              <EmptyState
                title={
                  q || filter.kind !== "all"
                    ? "筛选没有命中对话"
                    : showArchived
                      ? "还没有对话"
                      : "还没有对话（已归档的被隐藏）"
                }
                detail={
                  q || filter.kind !== "all"
                    ? "换个词试试。多个词用空格分开，会按相关程度和时间排。也可以搜对话里说过的话。"
                    : "开一段新对话聊几句，回来就能在这里翻记录。"
                }
                action={
                  q || filter.kind !== "all" ? (
                    <button
                      type="button"
                      onClick={() => {
                        setQuery("");
                        setFilter({ kind: "all" });
                      }}
                      className={rowActionClass}
                    >
                      清除筛选
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void openQuickChat()}
                      className={rowActionClass}
                    >
                      新对话
                    </button>
                  )
                }
              />
            )}
        </div>
        )}
      </div>

      {/* 回放区（canvas 底）：与列表栏并列常驻，未选中显示空态 */}
      <div className="flex min-w-0 flex-1 flex-col bg-canvas">
        {selected ? (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* 回放头部两行：上行「这是哪条对话 + 能做什么」，下行「谁、在哪个项目、多久前」+ 页签。
                原先一行 flex-wrap，页签被挤到第二行最左、agent 名在头部和底栏各写一遍 */}
            <div className="bg-strip px-4 pb-1.5 pt-2">
              <div className="flex min-w-0 items-center gap-2">
                <button
                  type="button"
                  className="flex h-7 shrink-0 items-center rounded-md px-2 text-xs text-l3 hover:bg-hover hover:text-l1 md:hidden"
                  onClick={() => setMobileRailOpen(true)}
                  aria-label="打开会话列表"
                >
                  ☰ 列表
                </button>
                <span
                  className="min-w-0 truncate text-sm font-medium text-l1"
                  title={sessionTitle(selected)}
                >
                  {sessionTitle(selected)}
                </span>
                {waitingTabs.has(liveSessions[sessionRuntimeKey(selected.agent, selected.sessionId)] ?? "") ? (
                  <button
                    type="button"
                    onClick={() => jumpToLive(selected)}
                    className="flex shrink-0 items-center gap-1 rounded-sm bg-inset px-1.5 py-0.5 text-xs text-warn-text hover:bg-hover"
                    title="终端里在等你确认（批准一个操作或选一项），点击跳过去"
                  >
                    <span className="size-2 rounded-full bg-warn-text" />
                    等你确认
                  </button>
                ) : (
                  selected.live && (
                    <span
                      className="flex shrink-0 items-center gap-1 rounded-sm bg-inset px-1.5 py-0.5 text-xs text-l2"
                      title="该对话的 CLI 进程仍在运行（外部探测）"
                    >
                      <span className="size-2 rounded-full bg-ok-text" />
                      进行中
                    </span>
                  )
                )}
                <span className="ml-auto flex shrink-0 items-center">
                  <button
                    onClick={() => resumeInTerminal(selected)}
                    disabled={!selected.alive && !selected.pinned}
                    className="inline-flex h-7 items-center justify-center rounded-md bg-cta px-2.5 text-xs text-cta-text hover:brightness-110 disabled:opacity-50"
                  >
                    继续
                  </button>
                  <button
                    onClick={() => setDigestFor(selected)}
                    disabled={!selected.alive && !selected.pinned}
                    className="ml-1 inline-flex h-7 items-center justify-center rounded-md px-2 text-xs text-l2 hover:bg-hover disabled:opacity-50"
                    title="提炼成紧凑简报，供新会话继续"
                  >
                    ◈ 提炼简报
                  </button>
                  <button
                    onClick={() => void onExport()}
                    disabled={exporting || (!selected.alive && !selected.pinned)}
                    className="ml-1 inline-flex h-7 items-center justify-center rounded-md px-2 text-xs text-l2 hover:bg-hover disabled:opacity-50"
                  >
                    {exporting ? "导出中…" : "导出"}
                  </button>
                  {exportPath && (
                    <button
                      type="button"
                      onClick={() => void openExported()}
                      className="ml-1 inline-flex h-7 items-center justify-center rounded-md px-2 text-xs text-l2 hover:bg-hover"
                      title={exportPath}
                    >
                      打开
                    </button>
                  )}
                  <button
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      setResumeMenu({ x: r.right - 176, y: r.bottom + 4 });
                    }}
                    title="更多对话操作"
                    className="ml-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-xs text-l4 hover:bg-hover hover:text-l1"
                  >
                    ⋯
                  </button>
                </span>
              </div>
              <div className="mt-1 flex min-w-0 items-center gap-2 text-micro text-l3">
                <span
                  className="shrink-0 rounded-full px-1.5 py-px font-medium"
                  style={agentBrandBadgeStyle(selected.agent)}
                >
                  {agentLabel(selected.agent)}
                </span>
                {(() => {
                  const label = sessionProjectLabel(selected.projectPath, projectNames, IS_WINDOWS);
                  if (!label) return null;
                  // 已添加项目可点回项目页（原底栏「查看项目」挪到这里，就近于项目名）
                  return registeredProjectPaths.has(selected.projectPath) ? (
                    <button
                      type="button"
                      className="max-w-40 shrink-0 truncate rounded-sm hover:text-l1 hover:underline"
                      title={`${selected.projectPath}\n点击回项目页`}
                      onClick={() => {
                        setSelectProjectReq(selected.projectPath);
                        setPage("workspaces");
                      }}
                    >
                      {label}
                    </button>
                  ) : (
                    <span className="max-w-40 shrink-0 truncate" title={selected.projectPath}>
                      {label}
                    </span>
                  );
                })()}
                {selected.agent === "codex" &&
                  (() => {
                    const chip = codexSessionChannelChip(selected.provider);
                    if (!chip) return null;
                    return (
                      <span
                        className="shrink-0 rounded-sm bg-inset px-1.5 py-px text-l2"
                        title={chip.tip}
                      >
                        {chip.label}
                      </span>
                    );
                  })()}
                {selected.workspace && (
                  <span
                    className="max-w-40 shrink-0 truncate rounded-sm bg-inset px-1.5 py-px text-l2"
                    title={
                      selected.stepName
                        ? `研究步骤：${selected.stepName}（工作区：${selected.workspace}）`
                        : `工作区：${selected.workspace}`
                    }
                  >
                    ⎇ {selected.stepName ?? selected.workspace}
                  </span>
                )}
                {selected.forkedFrom && (
                  <button
                    type="button"
                    className="max-w-56 shrink-0 truncate rounded-sm bg-inset px-1.5 py-px text-l2 hover:text-l1"
                    title={`${forkHint(selected)}。点击打开原对话`}
                    disabled={!forkSource(selected)}
                    onClick={() => {
                      const parent = forkSource(selected);
                      if (parent) void openSession(parent);
                    }}
                  >
                    分支自「{forkSourceTitle(selected)}」
                  </button>
                )}
                {selected.handoffFromAgent && (
                  <span
                    className="shrink-0 rounded-sm bg-inset px-1.5 py-px text-l2"
                    title={`该对话由 ${agentLabel(selected.handoffFromAgent)} 会话接力生成（简报接力，非记忆转移）`}
                  >
                    ⇄ 接自 {agentLabel(selected.handoffFromAgent)}
                  </span>
                )}
                <span
                  className="min-w-0 truncate text-l4"
                  title={
                    selected.tokenUsage
                      ? `${absTime(selected.updatedAt)} · ${fmtTokens(selected.tokenUsage)}`
                      : absTime(selected.updatedAt)
                  }
                >
                  {relTime(selected.updatedAt)}
                </span>
                {/* 对话 / 当前项目改动 页签：固定在第二行右端 */}
                <div className="ml-auto flex shrink-0 gap-1">
                  {(["chat", "diff"] as const).map((k) => (
                    <button
                      key={k}
                      onClick={() => setReplayTab(k)}
                      className={`inline-flex h-6 items-center justify-center rounded-md px-2 text-xs ${
                        replayTab === k
                          ? "bg-seg-sel text-l1"
                          : "text-l3 hover:text-l1"
                      }`}
                    >
                      {k === "chat" ? "对话" : "当前项目改动"}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {error && (
              <InlineNotice tone="err" className="px-4 py-1">{error}</InlineNotice>
            )}
            {replayTab === "diff" ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex shrink-0 items-center gap-2 border-b border-hairline bg-inset px-3 py-1.5 text-xs text-l3">
                  <span className="min-w-0 flex-1 truncate">
                    当前磁盘状态，不是该历史对话的改动快照
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setPendingTerminal({
                        cwd: selected.projectPath,
                        extraEnv: {},
                        title: basename(selected.projectPath),
                      });
                      setPage("terminal");
                    }}
                    className="inline-flex h-7 shrink-0 items-center justify-center rounded-md px-2 text-l2 hover:bg-hover hover:text-l1"
                  >
                    前往终端处理
                  </button>
                </div>
                <GitPanel
                  cwd={selected.projectPath}
                  visible={replayTab === "diff"}
                  onTotals={NOOP_TOTALS}
                  readOnly
                />
              </div>
            ) : (
              <>
                {(() => {
                  const notice = slimNotice(slimInspect);
                  if (!notice) return null;
                  return (
                    <div className="px-4">
                      <div className="mx-auto mt-2 flex max-w-3xl items-start gap-3 rounded-sm ccode-well p-3">
                        <InlineNotice tone={notice.tone} className="min-w-0 flex-1">
                          <span>
                            <span className="font-medium">{notice.title}。</span>
                            {notice.detail}
                          </span>
                        </InlineNotice>
                        <button
                          type="button"
                          onClick={() => setSlimOpen(true)}
                          className={`${rowActionClass} shrink-0`}
                        >
                          瘦身…
                        </button>
                      </div>
                    </div>
                  );
                })()}
                {summary && (
                  <div className="px-4">
                    <div className="mx-auto mt-2 max-w-3xl rounded-sm ccode-well p-3 text-sm text-l2">
                      <span className="mr-1">◈</span>
                      <span className="whitespace-pre-wrap">{summary}</span>
                    </div>
                  </div>
                )}
                {searchMatches && (
                  <div className="px-4">
                    <div className="mx-auto mt-2 flex max-w-3xl items-center gap-1 text-xs text-l3">
                      <span className="min-w-0 flex-1 truncate">
                        搜索「{searchMatches.query}」：这段对话里{" "}
                        {searchMatches.list.length}
                        {searchMatches.truncated ? "+" : ""} 处，第{" "}
                        {searchMatches.index + 1} 处 ·{" "}
                        {searchMatches.list[searchMatches.index]?.role === "user"
                          ? "你说的"
                          : "AI 回复"}
                      </span>
                      <button
                        type="button"
                        className={rowActionClass}
                        disabled={searchMatches.index <= 0 || loadingConv}
                        onClick={() => void jumpToMatch(searchMatches.index - 1)}
                        title="上一处（按对话先后）"
                      >
                        ↑ 上一处
                      </button>
                      <button
                        type="button"
                        className={rowActionClass}
                        disabled={
                          searchMatches.index >= searchMatches.list.length - 1 || loadingConv
                        }
                        onClick={() => void jumpToMatch(searchMatches.index + 1)}
                        title="下一处（按对话先后）"
                      >
                        ↓ 下一处
                      </button>
                      <button
                        type="button"
                        className={rowActionClass}
                        onClick={() => setSearchMatches(null)}
                        title="收起命中导航"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                )}
                <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
                  {/* 阅读栏居中限宽：气泡与排版不随宽窗拉成超长行；scrollRef 仍挂滚动容器，分页语义不变 */}
                  <div className="mx-auto max-w-3xl p-4">
                    {loadingConv ? (
                      <LoadingRows compact />
                    ) : (
                      <>
                        {messages.length === 0 ? (
                          <EmptyState
                            title="这条会话没有可回放的内容"
                            detail={
                              conversationCursor !== null
                                ? "这一段里没有解析出消息，正在往前找。"
                                : "本地会话文件里没有解析出消息记录。"
                            }
                          />
                        ) : (
                          (() => {
                            // 被分页切断的半轮先不显示，加载到它的提问再一起出来（收起行的时长 / 条数不再变）
                            const focusAt = findFocusMessageIndex(messages, searchFocus);
                            const from = firstCompleteTurnIndex(
                              messages,
                              conversationCursor !== null,
                              focusAt,
                            );
                            return (
                              <ConversationView
                                key={`${selected?.sessionId ?? "none"}:${searchFocus?.around ?? "tail"}`}
                                messages={from ? messages.slice(from) : messages}
                                cwd={selected?.projectPath ?? null}
                                focusIndex={focusAt >= 0 ? focusAt - from : focusAt}
                                focusKeywords={searchFocus?.matchedKeywords ?? []}
                              />
                            );
                          })()
                        )}
                      </>
                    )}
                  </div>
                </div>
                {/* 底部只读操作条：继续由头部主 CTA 负责；项目跳转与 agent 已在头部第二行，这里只留外部续聊 */}
                <div className="shrink-0 px-4 pb-2 pt-2.5">
                  <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-2 rounded-xl bg-inset px-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-xs text-l4">
                      历史回放 · 只读
                    </span>
                    <button
                      type="button"
                      onClick={() => void resumeExternal(selected)}
                      disabled={!selected.alive && !selected.pinned}
                      title={EXTERNAL_RESUME_HINT}
                      className={ghostActionClass}
                    >
                      在外部继续
                    </button>
                    {clientOpen.sessionClients(selected.agent).map((c) => (
                      <button
                        key={c.clientId}
                        type="button"
                        onClick={() => openInClient(selected, c.clientId)}
                        title={`交给 ${c.display} 接着聊。打开前会先检查渠道等是否对得上，需要时在弹层里一并处理`}
                        className={ghostActionClass}
                      >
                        {openButtonLabel(c, "session")}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-center text-micro text-l4">
                    内容由 AI 生成，请核对后使用
                  </p>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <EmptyState
              title="从左侧选择一条对话"
              detail="回放为只读历史记录；选中后可在回放头部恢复、保留、归档或导出。按 ↑ / ↓ 可在列表中快速切换对话。"
            />
          </div>
        )}
      </div>

      {/* 回放头部更多操作：分三组——继续（外部恢复/复制命令）、AI（摘要/接力/提炼）、整理（导出/保留） */}
      {resumeMenu && selected && (() => {
        const readable = selected.alive || selected.pinned;
        return (
          <ContextMenu
            x={resumeMenu.x}
            y={resumeMenu.y}
            onClose={() => setResumeMenu(null)}
            items={[
              {
                label: "在外部终端恢复",
                icon: SquareArrowOutUpRight,
                disabled: !readable,
                title: EXTERNAL_RESUME_HINT,
                onSelect: () => void resumeExternal(selected),
              },
              {
                label: COPY_RESUME_LABEL,
                icon: Copy,
                disabled: !readable,
                title: COPY_RESUME_HINT,
                onSelect: () => void copyResumeCommand(selected),
              },
              { separator: true },
              {
                label: aiSummarizing ? "摘要中…" : "生成摘要",
                icon: WandSparkles,
                hint: "AI",
                disabled: aiSummarizing || !readable,
                onSelect: () => void onSummarize(),
              },
              {
                label: "接力到…",
                icon: Forward,
                hint: "AI",
                disabled: !readable,
                title: "把这段对话交给另一个 Agent 接着做",
                onSelect: () => setHandoffFor(selected),
              },
              {
                label: "提炼接力…",
                icon: ScrollText,
                hint: "AI",
                disabled: !readable,
                title: "AI 提炼全会话成紧凑简报，新会话读简报续作（不带旧上下文）",
                onSelect: () => setDigestFor(selected),
              },
              { separator: true },
              ...(slimMenuAvailable(slimInspect)
                ? [
                    {
                      label: "瘦身会话…",
                      icon: Scissors,
                      title:
                        "把较早的截图换成文字占位、只留最近几张，缩小每次发送的请求体（撞网关 413 时用）；写入前先备份",
                      onSelect: () => setSlimOpen(true),
                    },
                  ]
                : []),
              {
                label: exporting ? "导出中…" : "导出 Markdown",
                icon: FileText,
                disabled: exporting || !readable,
                onSelect: () => void onExport(),
              },
              {
                label: exportingPack ? "导出中…" : "导出会话包",
                icon: Package,
                disabled: exportingPack || !readable,
                onSelect: () => void onExportPack([selected]),
              },
              {
                label: selected.pinned ? "取消保留" : "保留",
                icon: selected.pinned ? PinOff : Pin,
                title: "保留＝即使 CLI 清掉源文件，这条对话也留快照可读",
                onSelect: () => void togglePin(selected),
              },
            ]}
          />
        );
      })()}

      {slimOpen && selected && slimInspect && (
        <SessionSlimDialog
          agent={selected.agent}
          filePath={selected.filePath}
          inspect={slimInspect}
          runningInMesaTab={
            !!liveSessions[sessionRuntimeKey(selected.agent, selected.sessionId)]
          }
          onClose={() => setSlimOpen(false)}
          onApplied={() => {
            setSlimTick((t) => t + 1);
            void loadSessions(true);
          }}
          onResume={() => resumeInTerminal(selected)}
        />
      )}

      {/* 「◈ 接力到…」目标选择器 */}
      {handoffFor && (
        <HandoffPicker
          source={{
            agent: handoffFor.agent,
            sessionId: handoffFor.sessionId,
            filePath: handoffFor.filePath,
            cwd: handoffFor.projectPath,
            title: handoffFor.customTitle || handoffFor.title,
          }}
          onClose={() => setHandoffFor(null)}
        />
      )}

      {clientOpen.dialog}

      {/* 「◈ 提炼接力…」目标选择器（AI 蒸馏简报，三路径续作） */}
      {digestFor && (
        <DigestPicker
          source={{
            agent: digestFor.agent,
            sessionId: digestFor.sessionId,
            filePath: digestFor.filePath,
            cwd: digestFor.projectPath,
            title: digestFor.customTitle || digestFor.title,
          }}
          onClose={() => setDigestFor(null)}
        />
      )}

      {/* 右键菜单：会话 = 整理 / 继续 / 删除三组（v3.88 分组口径不变，改走共用菜单）；项目 = 删除全部 */}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={
            menu.kind === "session"
              ? (() => {
                  const ss = menu.session;
                  const items: ContextMenuItem[] = [
                    { header: "整理" },
                    {
                      label: ss.pinned ? "取消保留" : "保留",
                      icon: ss.pinned ? PinOff : Pin,
                      onSelect: () => void togglePin(ss),
                    },
                    {
                      label: ss.archived ? "取消归档" : "归档",
                      icon: ss.archived ? ArchiveRestore : Archive,
                      onSelect: () => void toggleArchive(ss),
                    },
                    {
                      label: "编辑标题与标签",
                      icon: Pencil,
                      onSelect: () => {
                        // 编辑表单在列表栏，先退出回放态
                        setSelected(null);
                        setEditing({
                          agent: ss.agent,
                          sessionId: ss.sessionId,
                          title: ss.customTitle ?? "",
                          tags: ss.tags.join(", "),
                        });
                      },
                    },
                    // 移到卡片：仅项目筛选下可用（此时才知道 project_root）
                    ...(projectScopePath(filter) != null
                      ? [
                          {
                            label: "移到卡片…",
                            icon: SquareStack,
                            title: "把该对话归入本项目的一张话题",
                            onSelect: () => {
                              setTaskPickerPos({ x: menu.x, y: menu.y });
                              setTaskPickerFor(ss);
                            },
                          },
                        ]
                      : []),
                    {
                      label: "导出会话包",
                      icon: Package,
                      disabled: exportingPack || (!ss.alive && !ss.pinned),
                      onSelect: () => void onExportPack([ss]),
                    },
                  ];
                  if (ss.alive || ss.pinned) {
                    items.push(
                      { header: "继续" },
                      {
                        label: "在终端恢复",
                        icon: SquareTerminal,
                        onSelect: () => resumeInTerminal(ss),
                      },
                      {
                        label: "在外部终端恢复",
                        icon: SquareArrowOutUpRight,
                        title: "在外部终端应用里恢复（同一件事的另一个出口，下面是复制命令自己粘）",
                        onSelect: () => void resumeExternal(ss),
                      },
                      {
                        label: COPY_RESUME_LABEL,
                        icon: Copy,
                        title: COPY_RESUME_HINT,
                        onSelect: () => void copyResumeCommand(ss),
                      },
                      ...clientOpen.sessionClients(ss.agent).map((c) => ({
                        label: openButtonLabel(c, "session"),
                        icon: AppWindow,
                        title: `交给 ${c.display} 接着聊`,
                        onSelect: () => openInClient(ss, c.clientId),
                      })),
                      {
                        label: "提炼接力…",
                        icon: ScrollText,
                        hint: "AI",
                        title: "AI 提炼全会话成紧凑简报，新会话读简报续作（不带旧上下文）",
                        onSelect: () => setDigestFor(ss),
                      },
                    );
                  }
                  items.push({
                    label: "删除对话…",
                    icon: Trash2,
                    danger: true,
                    onSelect: () => void deleteSession(ss),
                  });
                  return items;
                })()
              : [
                  {
                    label: `删除该项目全部对话…`,
                    icon: Trash2,
                    danger: true,
                    title: `列表里 ${menu.count} 条${menu.extra ? `，另有 ${menu.extra} 条归档/内部对话一并删除` : ""}`,
                    onSelect: () =>
                      void deleteProjectSessions(
                        menu.agent,
                        menu.path,
                        menu.count,
                        menu.extra,
                      ),
                  },
                ]
          }
        />
      )}
      {/* 「移到卡片…」：就地弹在右键位置；当前卡片打勾，已在卡片里时末尾给「移出卡片」 */}
      {taskPickerFor && scopePath != null && (
        <ContextMenu
          x={taskPickerPos.x}
          y={taskPickerPos.y}
          onClose={() => setTaskPickerFor(null)}
          items={[
            { header: `移到卡片 · ${basename(scopePath)}` },
            ...((taskCards[scopePath] ?? []).length === 0
              ? [
                  {
                    label: "这个项目还没有话题",
                    disabled: true,
                    title: "可在项目页新建话题卡",
                  },
                ]
              : (taskCards[scopePath] ?? []).map((c) => ({
                  label: c.name,
                  icon: SquareStack,
                  checked: taskPickerFor.taskId === c.id,
                  onSelect: () => void assignTask(taskPickerFor, c.id),
                }))),
            ...(taskPickerFor.taskId
              ? [
                  { separator: true },
                  {
                    label: "移出卡片",
                    icon: X,
                    onSelect: () => void assignTask(taskPickerFor, null),
                  },
                ]
              : []),
          ]}
        />
      )}
      {importOpen && (
        <SessionImportModal
          registeredPaths={[...registeredProjectPaths]}
          onClose={() => setImportOpen(false)}
          onImported={() => {
            void loadSessions(true);
          }}
        />
      )}
    </div>
  );
}
