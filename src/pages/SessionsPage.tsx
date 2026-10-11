import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { Download, Trash2, Upload } from "lucide-react";
import { IS_MAC, IS_WINDOWS } from "../hotkeys";
import { codexThreadDeeplink } from "../codex-client";
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
  type QuickFilterId,
  type ScopeChip,
} from "../session-filter";
import {
  applySearchHits,
  findFocusMessageIndex,
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
import GitPanel from "../components/GitPanel";
import HandoffPicker from "../components/HandoffPicker";
import DigestPicker from "../components/DigestPicker";
import { alertDialog, confirmDialog } from "../components/ConfirmDialog";
import { resumeSessionInTerminal } from "../components/QuickChatModal";
import { isScratchCwd } from "../quick-chat";
import SessionImportModal from "../components/SessionImportModal";
import { SECRET_EXPORT_WARNING } from "../session-transfer";
import {
  Checkbox,
  EmptyState,
  FoldMark,
  ghostActionClass,
  LoadingRows,
  rowActionClass,
  searchFieldClass,
} from "../components/PageFrame";
import type {
  ChatMessageDto,
  ConversationPageDto,
  OfficialAccountStatusDto,
  SessionExportKey,
  SessionMetaDto,
  SessionSearchHitDto,
  TokenUsageDto,
} from "../types";

/** GitPanel 的 onTotals 占位（会话页不消费改动总量；稳定引用避免击穿 memo） */
const NOOP_TOTALS = () => {};

/** 复制恢复命令：Windows 默认交互 shell 是 PowerShell，后端产出的也是该方言 */
const COPY_RESUME_LABEL = IS_WINDOWS
  ? "⧉ 复制恢复命令（PowerShell）"
  : "⧉ 复制恢复命令";
const COPY_RESUME_HINT = IS_WINDOWS
  ? "复制 PowerShell 命令（粘贴到 PowerShell，不要粘到 cmd）"
  : "复制恢复命令，粘贴到任意终端";
const COPY_RESUME_DONE = IS_WINDOWS ? "已复制（PowerShell）" : "已复制";
const COPY_RESUME_MENU = IS_WINDOWS
  ? "在外部继续 · 复制命令（PowerShell）"
  : "在外部继续 · 复制命令";

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
  const [query, setQuery] = useState("");
  const [contentHits, setContentHits] = useState<SessionSearchHitDto[] | null>(
    null,
  );
  const [searchingBody, setSearchingBody] = useState(false);
  const searchGenRef = useRef(0);
  const [searchFocus, setSearchFocus] = useState<SearchFocus | null>(null);
  const searchFocusRef = useRef<SearchFocus | null>(null);
  searchFocusRef.current = searchFocus;
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
  const [projectsOpen, setProjectsOpen] = useState(true);
  // 批量删除：选择模式 + 勾选集合（键为 agent+sessionId 复合键，防跨 agent 撞 id）
  const [selecting, setSelecting] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [confirmBatch, setConfirmBatch] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [selected, setSelected] = useState<SessionMetaDto | null>(null);
  const [registeredProjectPaths, setRegisteredProjectPaths] = useState<Set<string>>(
    () => new Set(),
  );
  // Codex 客户端跳转可行性：客户端打开会话时按记录的 provider 在 config.toml
  // 找定义，找不到报「Model provider not found」（见 openInClient/clientOpenable）
  const [codexClientProviders, setCodexClientProviders] = useState<Set<
    string
  > | null>(null);
  const [codexOfficialConnected, setCodexOfficialConnected] = useState<
    boolean | undefined
  >(undefined);
  // 「复制恢复命令」按钮的已复制反馈以 agent+sessionId 区分，避免跨 CLI 同 id 误显示。
  const [copiedId, setCopiedId] = useState<string | null>(null);
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
    void invoke<{ path: string }[]>("list_projects")
      .then((projects) => {
        if (!cancelled) setRegisteredProjectPaths(new Set(projects.map((p) => p.path)));
      })
      .catch((reason) => {
        if (!cancelled) {
          setRegisteredProjectPaths(new Set());
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
    if (!q) {
      searchGenRef.current += 1;
      setContentHits(null);
      setSearchingBody(false);
      return;
    }
    setContentHits(null);
    setSearchingBody(true);
    const gen = ++searchGenRef.current;
    const timer = window.setTimeout(() => {
      void invoke<SessionSearchHitDto[]>("search_sessions", { query: query.trim() })
        .then((hits) => {
          if (searchGenRef.current !== gen) return;
          setContentHits(hits);
          setSearchingBody(false);
          setError(null);
        })
        .catch(() => {
          if (searchGenRef.current !== gen) return;
          setContentHits(null);
          setSearchingBody(false);
          setError("会话内容搜索失败，请稍后重试");
        });
    }, 280);
    return () => window.clearTimeout(timer);
  }, [query, q]);

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

  function focusFor(s: SessionMetaDto): SearchFocus | null {
    const h = hitByKey.get(searchHitKey(s.agent, s.sessionId));
    if (!h) return null;
    if (!h.snippet && h.around == null) return null;
    return {
      around: h.around,
      matchTimestamp: h.matchTimestamp,
      matchRole: h.matchRole,
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
      setCopiedId(sessionRuntimeKey(s.agent, s.sessionId));
      window.setTimeout(() => setCopiedId(null), 1500);
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

  /** A4. 在 Codex 桌面客户端中打开该会话（codex://threads/<id> 深链，0.151 实测）。
   *  客户端与 CLI 共享本地 threads 库，CLI 发起的对话同样能跳过去继续聊 */
  async function openInClient(s: SessionMetaDto) {
    try {
      await openUrl(codexThreadDeeplink(s.sessionId));
    } catch (e) {
      await alertDialog(`唤起 Codex 客户端失败：${e}`);
    }
  }

  // 页面保持挂载：挂载与每次回切本页都重查（「注册到 Codex 客户端」在连接页写入后，
  // 回来要立即解禁「在客户端打开」；查询是本地 config.toml 只读解析，成本低）
  useEffect(() => {
    if (!visible) return;
    invoke<string[]>("codex_client_config_providers")
      .then((list) => setCodexClientProviders(new Set(list)))
      .catch(() => setCodexClientProviders(new Set()));
    invoke<OfficialAccountStatusDto>("official_account_status", {
      agentId: "codex",
    })
      .then((st) => setCodexOfficialConnected(st.connected))
      .catch(() => setCodexOfficialConnected(undefined));
  }, [visible]);

  /** 客户端打开会话时按 rollout 记录的 provider 在 config.toml 找定义，缺失即报
   *  「Model provider not found」无法继续（内置 openai / 无记录的旧会话恒可跳） */
  function clientOpenable(s: SessionMetaDto): boolean {
    if (s.agent !== "codex" || !(IS_MAC || IS_WINDOWS)) return false;
    if (!s.provider || s.provider === "openai") return true;
    return codexClientProviders?.has(s.provider) ?? false;
  }

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
    // 摘要缓存命中：已有 summary 直接展示，不再调用 AI
    setSummary(s.summary ?? null);
    setExportPath(null);
    setConversationCursor(null);
    setLoadingConv(true);
    setError(null);
    const request = ++conversationRequestRef.current;
    try {
      const page = await invoke<ConversationPageDto>(
        "get_session_conversation_page",
        {
          agent: s.agent,
          filePath: s.filePath,
          before: null,
          around: focus?.around ?? null,
        },
      );
      if (request !== conversationRequestRef.current) return;
      olderCountRef.current = 0;
      setMessages(page.messages);
      setConversationCursor(page.cursor);
      if (!focus) {
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

  async function loadOlderMessages() {
    if (!selected || conversationCursor === null || loadingOlder) return;
    const selectedKey = `${selected.agent}\n${selected.sessionId}`;
    setLoadingOlder(true);
    try {
      const scroller = scrollRef.current;
      const previousHeight = scroller?.scrollHeight ?? 0;
      const previousTop = scroller?.scrollTop ?? 0;
      const page = await invoke<ConversationPageDto>(
        "get_session_conversation_page",
        {
          agent: selected.agent,
          filePath: selected.filePath,
          before: conversationCursor,
          around: null,
        },
      );
      const currentSelected = selectedRef.current;
      if (
        !currentSelected ||
        `${currentSelected.agent}\n${currentSelected.sessionId}` !== selectedKey
      )
        return;
      setMessages((current) => [...page.messages, ...current]);
      olderCountRef.current += page.messages.length;
      setConversationCursor(page.cursor);
      requestAnimationFrame(() => {
        const current = scrollRef.current;
        if (current)
          current.scrollTop =
            previousTop + current.scrollHeight - previousHeight;
      });
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingOlder(false);
    }
  }

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
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    const onScroll = () => setMenu(null);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [menu]);

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

  const input =
    "w-full rounded-sm border border-field bg-canvas px-2 py-1.5 text-sm text-l2 outline-none placeholder:text-l4 focus:border-l4";
  const menuItem =
    "block w-full px-3 py-1.5 text-left text-l2 hover:bg-hover";
  // 菜单分组小标题（v3.88）：11 项平铺改三组，caps 式弱化小字，只作分段不可点
  const menuGroupLabel =
    "px-3 pb-0.5 pt-1.5 text-micro tracking-wider text-l4 first:pt-0.5";
  // 回放头部「恢复 ▾」下拉（外部恢复/复制命令），坐标定位 + 全屏遮罩点击关闭
  const [resumeMenu, setResumeMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
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

  // 与右键菜单一致：Escape / 任意滚动关闭，避免滚动后浮层错位
  useEffect(() => {
    if (!resumeMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setResumeMenu(null);
    };
    const onScroll = () => setResumeMenu(null);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [resumeMenu]);

  // 「移到卡片…」子面板：同右键菜单的关闭语义
  useEffect(() => {
    if (!taskPickerFor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTaskPickerFor(null);
    };
    const onScroll = () => setTaskPickerFor(null);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [taskPickerFor]);

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
          ? `${agentLabel(filter.agent)} · ${basename(filter.path)}`
          : filter.kind === "projectPath"
            ? basename(filter.path)
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
            <div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-l3">已选 {checkedInView} 项</span>
              <div className="flex items-center gap-1">
                <button
                  onClick={toggleSelectAll}
                  className={ghostActionClass}
                >
                  {allChecked ? "取消全选" : "全选（当前筛选结果）"}
                </button>
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
                  className={
                    confirmBatch
                      ? "inline-flex h-7 items-center justify-center rounded-md bg-err px-2 text-xs text-err-text hover:brightness-110 disabled:opacity-50"
                      : "inline-flex h-7 items-center justify-center rounded-md px-2 text-xs text-err-text hover:bg-hover disabled:opacity-50"
                  }
                >
                  {batchDeleting
                    ? "删除中…"
                    : confirmBatch
                      ? `确认删除 ${checkedInView} 项（含 pin 快照）？`
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
                  className={`${ghostActionClass} gap-1`}
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
                    className={ghostActionClass}
                    title={exportPath}
                  >
                    打开
                  </button>
                )}
                <button
                  onClick={exitSelectMode}
                  className={ghostActionClass}
                >
                  取消
                </button>
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
              {searchingBody && (
                <span className="text-micro text-l4">正在搜正文…</span>
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
              常用 3 个常驻；近 7 天/内部 AI/已归档收进「更多 ▾」，激活的提到行内常显。
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
                    title="更多快筛（近 7 天 / 内部 AI / 已归档）"
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
                          (f) => !PRIMARY_QUICK.has(f.id),
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
            <span className="shrink-0 text-l4">{treeOpen ? "▴" : "▾"}</span>
          </button>
          </div>
        </div>
        {error && !selected && (
          <p className="shrink-0 px-3 py-1 text-xs text-err-text">{error}</p>
        )}
        {treeOpen ? (
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
              <button
                onClick={() => {
                  pickScope({ kind: "all" });
                }}
                className={`mx-1 flex h-7 w-[calc(100%-8px)] items-center justify-between gap-1 rounded-md px-2 text-left text-xs ${
                  filterActive({ kind: "all" })
                    ? "bg-rail-sel text-l1"
                    : "text-l3 hover:bg-hover"
                }`}
              >
                <span className="truncate">全部对话</span>
                <span
                  className={`shrink-0 text-xs opacity-70 ${filterActive({ kind: "all" }) ? "text-l2" : "text-l4"}`}
                >
                  {regularVisible.length}
                </span>
              </button>
              <button
                onClick={() => {
                  pickScope({ kind: "scratch" });
                }}
                className={`mx-1 flex h-7 w-[calc(100%-8px)] items-center justify-between gap-1 rounded-md px-2 text-left text-xs ${
                  filterActive({ kind: "scratch" })
                    ? "bg-rail-sel text-l1"
                    : "text-l3 hover:bg-hover"
                }`}
              >
                <span className="truncate">随手聊</span>
                <span
                  className={`shrink-0 text-xs opacity-70 ${filterActive({ kind: "scratch" }) ? "text-l2" : "text-l4"}`}
                >
                  {
                    regularVisible.filter(
                      (s) =>
                        isScratchCwd(s.projectPath, IS_WINDOWS) &&
                        s.workspace == null,
                    ).length
                  }
                </span>
              </button>
              {internalVisible.length > 0 && (
                <button
                  onClick={() => {
                    pickScope({ kind: "internal" });
                  }}
                  title="Mesa 自己调用 AI 生成提交信息、摘要等产生的内部对话"
                  className={`mx-1 flex h-7 w-[calc(100%-8px)] items-center justify-between gap-1 rounded-md px-2 text-left text-xs ${
                    filterActive({ kind: "internal" })
                      ? "bg-rail-sel text-l1"
                      : "text-l3 hover:bg-hover"
                  }`}
                >
                  <span className="truncate">Mesa 内部 AI</span>
                  <span
                    className={`shrink-0 text-xs opacity-70 ${filterActive({ kind: "internal" }) ? "text-l2" : "text-l4"}`}
                  >
                    {internalVisible.length}
                  </span>
                </button>
              )}
              {tree.length > 0 && (
                <div className="mx-2 my-1 border-t border-hairline" />
              )}
              {tree.map((g) => {
                // 该 agent 是当前筛选（agent 或其下项目）才用选中填充
                const active =
                  (filter.kind === "agent" || filter.kind === "project") &&
                  filter.agent === g.agent;
                const open = expandedGroup?.agent === g.agent;
                return (
                  <div key={g.agent}>
                    <button
                      onClick={() => {
                        setExpandedAgent(open ? null : g.agent);
                      }}
                      aria-expanded={open}
                      title="展开或收起这个 Agent 的项目"
                      className={`mx-1 flex h-7 w-[calc(100%-8px)] items-center gap-1.5 rounded-md px-2 text-left text-xs ${
                        active
                          ? "bg-rail-sel text-l1"
                          : "text-l3 hover:bg-hover"
                      }`}
                    >
                      <FoldMark open={open} />
                      <span className="min-w-0 flex-1 truncate">
                        {agentLabel(g.agent)}
                      </span>
                      <span
                        className={`shrink-0 text-xs opacity-70 ${active ? "text-l2" : "text-l4"}`}
                      >
                        {g.list.length}
                      </span>
                    </button>
                    {open && (
                      <div className="mx-1 mb-0.5 ml-4 border-l border-white/5 pl-1.5">
                        <button
                          onClick={() => {
                            pickScope({ kind: "agent", agent: g.agent });
                          }}
                          className={`flex h-7 w-full items-center justify-between gap-2 rounded-md px-2 text-left text-xs ${
                            filterActive({ kind: "agent", agent: g.agent })
                              ? "bg-rail-sel text-l1"
                              : "text-l3 hover:bg-hover"
                          }`}
                        >
                          <span className="truncate">全部项目</span>
                          <span
                            className={`shrink-0 text-xs opacity-70 ${filterActive({ kind: "agent", agent: g.agent }) ? "text-l2" : "text-l4"}`}
                          >
                            {g.list.length}
                          </span>
                        </button>
                        {g.projects.map((p) => {
                          const pActive = filterActive({
                            kind: "project",
                            agent: g.agent,
                            path: p.path,
                          });
                          return (
                            <button
                              key={p.path}
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
                              title={p.path}
                              className={`flex h-7 w-full items-center justify-between gap-2 rounded-md px-2 text-left text-xs ${
                                pActive
                                  ? "bg-rail-sel text-l1"
                                  : "text-l3 hover:bg-hover"
                              }`}
                            >
                              <span className="truncate">
                                {basename(p.path)}
                              </span>
                              <span
                                className={`shrink-0 text-xs opacity-70 ${pActive ? "text-l2" : "text-l4"}`}
                              >
                                {p.list.length}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
              {projectGroups.length > 0 && (
                <>
                  <div className="mx-2 my-1 border-t border-hairline" />
                  <button
                    type="button"
                    onClick={() => setProjectsOpen((v) => !v)}
                    aria-expanded={projectsOpen}
                    title="按项目筛选（不限 Agent）"
                    className="mx-1 flex h-7 w-[calc(100%-8px)] items-center gap-1.5 rounded-md px-2 text-left text-xs text-l3 hover:bg-hover"
                  >
                    <FoldMark open={projectsOpen} />
                    <span className="min-w-0 flex-1 truncate">按项目</span>
                    <span className="shrink-0 text-xs text-l4 opacity-70">
                      {projectGroups.length}
                    </span>
                  </button>
                  {projectsOpen && (
                    <div className="mx-1 mb-0.5 ml-4 border-l border-hairline pl-1.5">
                      {projectGroups.map((p) => {
                        const pActive = filterActive({
                          kind: "projectPath",
                          path: p.path,
                        });
                        return (
                          <button
                            key={pathKey(p.path, IS_WINDOWS)}
                            type="button"
                            onClick={() =>
                              pickScope({ kind: "projectPath", path: p.path })
                            }
                            title={p.path}
                            className={`flex h-7 w-full items-center justify-between gap-2 rounded-md px-2 text-left text-xs ${
                              pActive
                                ? "bg-rail-sel text-l1"
                                : "text-l3 hover:bg-hover"
                            }`}
                          >
                            <span className="truncate">{basename(p.path)}</span>
                            <span
                              className={`shrink-0 text-xs opacity-70 ${pActive ? "text-l2" : "text-l4"}`}
                            >
                              {p.list.length}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
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
                          liveSessions[sessionRuntimeKey(s.agent, s.sessionId)]
                            ? "正在终端中进行，点击跳转"
                            : "CLI 仍在外部终端中运行"
                        }
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm disabled:cursor-default"
                      >
                        <span className="size-2 rounded-full bg-ok-text" />
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
                        title="Codex resume 链合并为一条"
                      >
                        {s.chainCount} 次继续
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
                    : "去终端页跑几个 agent 会话，回来就能在这里翻记录。"
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
                      onClick={() => setPage("terminal")}
                      className={rowActionClass}
                    >
                      去终端快速开聊
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
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-strip px-4 py-2">
              <button
                type="button"
                className="flex h-7 items-center rounded-md px-2 text-xs text-l3 hover:bg-hover hover:text-l1 md:hidden"
                onClick={() => setMobileRailOpen(true)}
                aria-label="打开会话列表"
              >
                ☰ 列表
              </button>
              <span className="truncate text-sm font-medium text-l1">
                {sessionTitle(selected)}
              </span>
              {selected.live && (
                <span
                  className="flex shrink-0 items-center gap-1 rounded-sm bg-inset px-1.5 py-0.5 text-xs text-l2"
                  title="该对话的 CLI 进程仍在运行（外部探测）"
                >
                  <span className="size-2 rounded-full bg-ok-text" />
                  进行中
                </span>
              )}
              {selected.agent === "codex" &&
                (() => {
                  const chip = codexSessionChannelChip(selected.provider);
                  if (!chip) return null;
                  return (
                    <span
                      className="shrink-0 rounded-sm bg-inset px-1.5 py-0.5 text-xs text-l2"
                      title={chip.tip}
                    >
                      {chip.label}
                    </span>
                  );
                })()}
              {selected.workspace && (
                <span
                  className="shrink-0 rounded-sm bg-inset px-1.5 py-0.5 text-xs text-l2"
                  title={
                    selected.stepName
                      ? `研究步骤：${selected.stepName}（工作区：${selected.workspace}）`
                      : `工作区：${selected.workspace}`
                  }
                >
                  ⎇ {selected.stepName ?? selected.workspace}
                </span>
              )}
              {selected.handoffFromAgent && (
                <span
                  className="shrink-0 rounded-sm bg-inset px-1.5 py-0.5 text-xs text-l2"
                  title={`该对话由 ${agentLabel(selected.handoffFromAgent)} 会话接力生成（简报接力，非记忆转移）`}
                >
                  ⇄ 接自 {agentLabel(selected.handoffFromAgent)}
                </span>
              )}
              <span
                className="shrink-0 text-xs text-l3"
                title={
                  selected.tokenUsage
                    ? `${absTime(selected.updatedAt)} · ${fmtTokens(selected.tokenUsage)}`
                    : absTime(selected.updatedAt)
                }
              >
                {agentLabel(selected.agent)} · {relTime(selected.updatedAt)}
              </span>
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
              {/* 对话 / 当前项目改动 页签 */}
              <div className="flex shrink-0 gap-1">
                {(["chat", "diff"] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => setReplayTab(k)}
                    className={`inline-flex h-7 items-center justify-center rounded-md px-2.5 text-xs ${
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
            {error && (
              <p className="px-4 py-1 text-xs text-err-text">{error}</p>
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
                {summary && (
                  <div className="px-4">
                    <div className="mx-auto mt-2 max-w-3xl rounded-sm ccode-well p-3 text-sm text-l2">
                      <span className="mr-1">◈</span>
                      <span className="whitespace-pre-wrap">{summary}</span>
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
                        {conversationCursor !== null && (
                          <div className="mb-3 flex justify-center">
                            <button
                              type="button"
                              disabled={loadingOlder}
                              onClick={() => void loadOlderMessages()}
                              className={rowActionClass}
                            >
                              {loadingOlder ? "加载中…" : "加载更早对话"}
                            </button>
                          </div>
                        )}
                        {messages.length === 0 ? (
                          <EmptyState
                            title="这条会话没有可回放的内容"
                            detail={
                              conversationCursor !== null
                                ? "这一段里没有解析出消息。点上面「加载更早对话」继续往前。"
                                : "本地会话文件里没有解析出消息记录。"
                            }
                          />
                        ) : (
                          <ConversationView
                            key={`${selected?.sessionId ?? "none"}:${searchFocus?.around ?? "tail"}`}
                            messages={messages}
                            cwd={selected?.projectPath ?? null}
                            focusIndex={findFocusMessageIndex(messages, searchFocus)}
                            focusKeywords={searchFocus?.matchedKeywords ?? []}
                          />
                        )}
                      </>
                    )}
                  </div>
                </div>
                {/* 底部只读操作条：继续由头部主 CTA 负责，底部只保留外部路径和项目跳转。 */}
                <div className="shrink-0 px-4 pb-2 pt-2.5">
                  <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-2 rounded-xl bg-inset px-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-xs text-l4">
                      历史回放只读 · 需要继续时使用上方「继续」
                    </span>
                    <button
                      type="button"
                      onClick={() => void resumeExternal(selected)}
                      disabled={!selected.alive && !selected.pinned}
                      className={ghostActionClass}
                    >
                      在外部继续
                    </button>
                    {selected.agent === "codex" && (IS_MAC || IS_WINDOWS) && (
                      <button
                        type="button"
                        onClick={() => void openInClient(selected)}
                        disabled={!clientOpenable(selected)}
                        title={
                          clientOpenable(selected)
                            ? "唤起 Codex 桌面客户端直接打开这条对话，可接着聊"
                            : `这条会话记录的渠道「${selected.provider}」在客户端 config.toml 里没有定义，客户端打开会报「Model provider not found」。想在客户端续聊：到连接页对这条 Codex 连接用「注册到客户端」（写入 config.toml 的渠道定义）；用上方「继续」则是在 Mesa 终端里续聊——启动时临时注入渠道定义，不改客户端配置`
                        }
                        className={ghostActionClass}
                      >
                        在客户端打开
                      </button>
                    )}
                    {registeredProjectPaths.has(selected.projectPath) && (
                      <button
                        type="button"
                        onClick={() => {
                          setSelectProjectReq(selected.projectPath);
                          setPage("workspaces");
                        }}
                        className={ghostActionClass}
                      >
                        查看项目
                      </button>
                    )}
                    <span
                      className="shrink-0 rounded-full px-2.5 py-0.5 text-micro font-medium"
                      style={agentBrandBadgeStyle(selected.agent)}
                    >
                      {agentLabel(selected.agent)}
                    </span>
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

      {/* 回放头部更多操作：固定遮罩 + 按钮下方浮层 */}
      {resumeMenu && selected && (
        <div className="fixed inset-0 z-20" onClick={() => setResumeMenu(null)}>
          <div
            className="absolute w-44 rounded-sm border border-field ccode-float-surface py-1 text-sm"
            style={{ left: resumeMenu.x, top: resumeMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className={`${menuItem} disabled:opacity-50`}
              disabled={!selected.alive && !selected.pinned}
              onClick={() => {
                setResumeMenu(null);
                void resumeExternal(selected);
              }}
            >
              ⇗ 在外部终端恢复
            </button>
            <button
              className={`${menuItem} disabled:opacity-50`}
              disabled={!selected.alive && !selected.pinned}
              title={COPY_RESUME_HINT}
              onClick={() => {
                setResumeMenu(null);
                void copyResumeCommand(selected);
              }}
            >
              {copiedId ===
              sessionRuntimeKey(selected.agent, selected.sessionId)
                ? COPY_RESUME_DONE
                : COPY_RESUME_LABEL}
            </button>
            <button
              className={`${menuItem} disabled:opacity-50`}
              disabled={aiSummarizing || (!selected.alive && !selected.pinned)}
              onClick={() => {
                setResumeMenu(null);
                void onSummarize();
              }}
            >
              {aiSummarizing ? "◈ 摘要中…" : "◈ 生成摘要"}
            </button>
            <button
              className={`${menuItem} disabled:opacity-50`}
              disabled={!selected.alive && !selected.pinned}
              onClick={() => {
                setResumeMenu(null);
                setHandoffFor(selected);
              }}
            >
              ◈ 接力到…
            </button>
            <button
              className={`${menuItem} disabled:opacity-50`}
              disabled={!selected.alive && !selected.pinned}
              title="AI 提炼全会话成紧凑简报，新会话读简报续作（不带旧上下文）"
              onClick={() => {
                setResumeMenu(null);
                setDigestFor(selected);
              }}
            >
              ◈ 提炼接力…
            </button>
            <button
              className={`${menuItem} disabled:opacity-50`}
              disabled={exporting || (!selected.alive && !selected.pinned)}
              onClick={() => {
                setResumeMenu(null);
                void onExport();
              }}
            >
              {exporting ? "导出中…" : "导出 Markdown"}
            </button>
            <button
              className={`${menuItem} disabled:opacity-50`}
              disabled={exportingPack || (!selected.alive && !selected.pinned)}
              onClick={() => {
                setResumeMenu(null);
                void onExportPack([selected]);
              }}
            >
              {exportingPack ? "导出中…" : "导出会话包"}
            </button>
            <button
              className={menuItem}
              onClick={() => {
                setResumeMenu(null);
                void togglePin(selected);
              }}
            >
              {selected.pinned ? "取消保留" : "⚑ 保留"}
            </button>
          </div>
        </div>
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

      {/* 右键菜单：fixed 遮罩 + 光标处浮层 */}
      {menu && (
        <div
          className="fixed inset-0 z-20"
          onClick={() => setMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu(null);
          }}
        >
          <div
            className="absolute min-w-36 rounded-sm border border-field ccode-float-surface py-1 text-sm"
            style={{ left: menu.x, top: menu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {menu.kind === "session" ? (
              <>
                {/* 11 项平铺 → 三组（v3.88，用户点名「一堆可选操作」）：
                    整理（改这条对话的元数据）/ 继续（把它接着往下做）/ 危险。
                    「保留」「在终端恢复」两个高频项已提到行内 hover，菜单里保留同项以便右键直达 */}
                <div className={menuGroupLabel}>整理</div>
                <button
                  className={menuItem}
                  onClick={() => {
                    setMenu(null);
                    void togglePin(menu.session);
                  }}
                >
                  {menu.session.pinned ? "取消保留" : "保留"}
                </button>
                <button
                  className={menuItem}
                  onClick={() => {
                    setMenu(null);
                    void toggleArchive(menu.session);
                  }}
                >
                  {menu.session.archived ? "取消归档" : "归档"}
                </button>
                <button
                  className={menuItem}
                  onClick={() => {
                    setMenu(null);
                    // 编辑表单在列表栏，先退出回放态
                    setSelected(null);
                    setEditing({
                      agent: menu.session.agent,
                      sessionId: menu.session.sessionId,
                      title: menu.session.customTitle ?? "",
                      tags: menu.session.tags.join(", "),
                    });
                  }}
                >
                  编辑
                </button>
                <button
                  className={`${menuItem} disabled:opacity-50`}
                  disabled={exportingPack || (!menu.session.alive && !menu.session.pinned)}
                  onClick={() => {
                    setMenu(null);
                    void onExportPack([menu.session]);
                  }}
                >
                  导出会话包
                </button>
                {/* 移到卡片：仅项目筛选下可用（此时才知道 project_root）——属「整理」 */}
                {projectScopePath(filter) != null && (
                  <button
                    className={menuItem}
                    title="把该对话归入本项目的一张话题"
                    onClick={() => {
                      setMenu(null);
                      setTaskPickerFor(menu.session);
                    }}
                  >
                    移到卡片…
                  </button>
                )}
                {(menu.session.alive || menu.session.pinned) && (
                  <>
                    <div className={menuGroupLabel}>继续</div>
                    <button
                      className={menuItem}
                      onClick={() => {
                        setMenu(null);
                        resumeInTerminal(menu.session);
                      }}
                    >
                      在终端恢复
                    </button>
                    <button
                      className={menuItem}
                      title="在外部终端应用里恢复（同一件事的另一个出口，下面是复制命令自己粘）"
                      onClick={() => {
                        setMenu(null);
                        void resumeExternal(menu.session);
                      }}
                    >
                      在外部继续 · 打开终端
                    </button>
                    <button
                      className={menuItem}
                      title={COPY_RESUME_HINT}
                      onClick={() => {
                        setMenu(null);
                        void copyResumeCommand(menu.session);
                      }}
                    >
                      {COPY_RESUME_MENU}
                    </button>
                    {clientOpenable(menu.session) && (
                      <button
                        className={menuItem}
                        title="唤起 Codex 桌面客户端直接打开这条对话（客户端与 CLI 共享本地会话库，可接着聊）"
                        onClick={() => {
                          setMenu(null);
                          void openInClient(menu.session);
                        }}
                      >
                        在客户端打开 · Codex
                      </button>
                    )}
                    <button
                      className={menuItem}
                      title="AI 提炼全会话成紧凑简报，新会话读简报续作（不带旧上下文）"
                      onClick={() => {
                        setMenu(null);
                        setDigestFor(menu.session);
                      }}
                    >
                      ◈ 提炼接力…
                    </button>
                  </>
                )}
                <div className={menuGroupLabel}>危险</div>
                <button
                  className={`${menuItem} text-err-text`}
                  onClick={() => {
                    setMenu(null);
                    void deleteSession(menu.session);
                  }}
                >
                  删除对话
                </button>
              </>
            ) : (
              <button
                className={`${menuItem} text-err-text`}
                onClick={() => {
                  setMenu(null);
                  void deleteProjectSessions(
                    menu.agent,
                    menu.path,
                    menu.count,
                    menu.extra,
                  );
                }}
              >
                删除该项目全部对话
              </button>
            )}
          </div>
        </div>
      )}
      {/* 「移到卡片…」子面板：列出当前筛选项目的卡片；无卡片给置灰提示 */}
      {taskPickerFor && scopePath != null && (
        <div
          className="fixed inset-0 z-20"
          onClick={() => setTaskPickerFor(null)}
        >
          <div
            className="absolute left-1/2 top-1/4 w-72 -translate-x-1/2 rounded-sm border border-field ccode-float-surface py-1 text-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="px-3 pb-1 pt-1.5 text-xs text-l4">
              移到卡片（{basename(scopePath)}）
            </p>
            {(taskCards[scopePath] ?? []).length === 0 ? (
              <p className="px-3 py-1.5 text-sm text-l4">
                该项目还没有话题，可在项目页新建。
              </p>
            ) : (
              (taskCards[scopePath] ?? []).map((c) => (
                <button
                  key={c.id}
                  className={`${menuItem} flex items-center justify-between gap-2`}
                  onClick={() => void assignTask(taskPickerFor, c.id)}
                >
                  <span className="min-w-0 truncate">▤ {c.name}</span>
                  {taskPickerFor.taskId === c.id && (
                    <span className="shrink-0 text-xs text-l4">当前</span>
                  )}
                </button>
              ))
            )}
            {taskPickerFor.taskId && (
              <button
                className={menuItem}
                onClick={() => void assignTask(taskPickerFor, null)}
              >
                移出卡片
              </button>
            )}
          </div>
        </div>
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
