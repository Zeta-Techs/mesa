import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import ConversationView from "./ConversationView";
import ChatComposer from "./ChatComposer";
import ChatEmptyStart from "./ChatEmptyStart";
import { ChevronDown, FolderOpen } from "lucide-react";
import { chatGreeting } from "../chat-empty-start";
import { useAppStore } from "../store";
import { isLightTheme } from "../themes";
import { MesaMark } from "./MesaMark";
import ChatModelMenu from "./ChatModelMenu";
import ChatPermissionBadge from "./ChatPermissionBadge";
import type {
  ConnIssueState,
  LaunchPickState,
  NativePermissionMode,
  TabStatus,
} from "../pages/TerminalPage";
import type { TuiMenu } from "../tui-menu";
import { liveReplySupported, unsyncedTail } from "../live-reply";
import { lastContextTokens, lastUserText, type MesaCommand } from "../composer-assist";
import { AGENTS, type SessionMetaDto } from "../types";
import type {
  ChatMessageDto,
  DetectResult,
  McpServerDto,
  SessionSyncState,
  SkillDto,
} from "../types";
import { IS_WINDOWS } from "../hotkeys";
import { samePath } from "../path-utils";
import { dropHitsRect, joinDroppedChatPaths } from "../terminal-input";
import {
  approvalExtraHint,
  chatHeaderStatus,
  chatWaitKind,
  chatWaitText,
  composerShowsInterrupt,
  latestToolName,
  slashHandoff,
} from "../chat-handoff";
import { confirmChoices } from "../chat-reply";
import ChatDecisionCard, { type ChatDecision } from "./ChatDecisionCard";
import { connIssueDecision } from "../chat-decision";
import { cwdChipLabel } from "../terminal-welcome";
import { escInterruptSafe } from "../agent-caps";
import type { TrustPrompt } from "../trust-prompt";
import {
  approvalChoices,
  approvalPreview,
  approvalTitle,
  type ChannelReplyDecision,
  type ChatChannelSnapshot,
} from "../chat-channel";

export default function ChatSurface({
  messages,
  state,
  syncState,
  loading,
  active = true,
  agentId,
  confirmDetail,
  cwd,
  running,
  canResume,
  attention,
  readOnly,
  readonlySupported,
  busy,
  skills,
  mcps,
  onSend,
  onAllowWrite,
  onOpenTerminal,
  onInterrupt,
  onApprovalKey,
  peek = false,
  onTogglePeek,
  onRequestPeek,
  modelSwitch,
  hooksEnabled = false,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
  onChooseCwd,
  trustPrompt = null,
  onAnswerTrust,
  ptyQuiet = false,
  launchPick = null,
  onPickLaunch,
  onRestore,
  onPickRecent,
  onOpenDirMenu,
  runtime = null,
  onTuiCommand,
  menuPrompt = null,
  onAnswerMenu,
  tuiPanel = false,
  liveReply = null,
  onRestartPermission,
  mesaCommands = [],
  externalInsert = null,
  onExternalInsertConsumed,
  connIssue = null,
  onSwitchConnection,
  onDismissConnIssue,
  onOpenProfiles,
  onForkFrom,
  channel = null,
  onChannelReply,
}: {
  messages: ChatMessageDto[];
  state: "idle" | "detecting" | "linked" | "timeout";
  syncState: SessionSyncState;
  loading: boolean;
  /** 聊天层当前可见（常驻挂载仅隐藏后，用作输入框聚焦信号） */
  active?: boolean;
  agentId?: string | null;
  confirmDetail?: string | null;
  cwd?: string | null;
  running: boolean;
  canResume: boolean;
  attention: "done" | "working" | "confirm" | null;
  readOnly: boolean;
  readonlySupported: boolean;
  busy?: boolean;
  skills: SkillDto[];
  mcps: McpServerDto[];
  onSend: (text: string) => Promise<string | null>;
  onAllowWrite: () => void;
  onOpenTerminal: () => void;
  onInterrupt?: () => void;
  onApprovalKey?: (key: "y" | "n" | "esc") => void;
  peek?: boolean;
  onTogglePeek?: () => void;
  onRequestPeek?: () => void;
  modelSwitch?: DetectResult["modelSwitch"];
  hooksEnabled?: boolean;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  /** 空态目录行：点选工作目录（未启动时走终端标签 chooseCwd） */
  onChooseCwd?: () => void;
  /** 终端里正停着「是否信任这个目录」菜单（会话文件出现之前） */
  trustPrompt?: TrustPrompt | null;
  onAnswerTrust?: (accept: boolean) => void;
  /** Agent 在跑但终端 4 秒没出字（TUI 静止，多半停在菜单 / 登录上） */
  ptyQuiet?: boolean;
  /** 开聊前的 Agent / 配置 / 模型选择（与终端启动栏同一份；进程起来后不再显示） */
  launchPick?: LaunchPickState | null;
  onPickLaunch?: {
    agent: (id: string) => void;
    profile: (id: string) => void;
    model: (model: string) => void;
    effort: (level: string) => void;
    permission: (
      permission: "discuss" | "write_tree",
      mode?: NativePermissionMode | null,
    ) => void;
  };
  /** 恢复占位：接回这个标签上次的会话 */
  onRestore?: () => void;
  /** 空态「最近的随手聊」点一条：接着聊它（快速开聊的空白标签用） */
  onPickRecent?: (s: SessionMetaDto) => void;
  /** 目录芯片点开的菜单（项目 / 随手聊 / 主目录 / 选择文件夹… / 新建项目…），坐标为芯片左下角 */
  onOpenDirMenu?: (x: number, y: number) => void;
  /** 运行中「模型 · 思考」芯片要的数据（与终端底栏同一份） */
  runtime?: {
    status: TabStatus | null;
    profileModels: string[];
    effort: DetectResult["effort"];
    submitCsiU: boolean;
    /** 停下 Agent、带新模型 / 思考档接回原对话（会写回 CLI 全局配置的切换走这条） */
    onRelaunch?: (patch: { model?: string; effort?: string | null }) => void;
  } | null;
  /** 写一条 TUI 命令并盯屏（标签动作 runTuiCommand） */
  onTuiCommand?: (cmd: string) => void;
  /** 切换命令之后 CLI 弹出的确认 / 选择菜单 */
  menuPrompt?: TuiMenu | null;
  onAnswerMenu?: (index: number) => void;
  /** 终端里开着一个只能在终端看的面板（/cost、/usage 的 Settings 面板等，tui-panel.ts） */
  tuiPanel?: boolean;
  /** 终端画面里这一轮正在写的回复（live-reply.ts）；会话文件追上的行由这里剔掉 */
  liveReply?: string[] | null;
  /** 运行中换权限：停下 Agent、带新权限接回原会话（标签动作 restartWithPermission） */
  onRestartPermission?: () => void;
  /** 斜杠面板上半组「Mesa」操作（新对话、压缩、分叉、看改动、导出、打开终端） */
  mesaCommands?: MesaCommand[];
  /** 外部送进来的一段话（终端选中文字「引用到输入框 / 问 AI」）：send=true 直接发，否则填进输入框 */
  externalInsert?: { text: string; send: boolean; token: number } | null;
  onExternalInsertConsumed?: () => void;
  /** 连接出问题（额度 / 限流 / 钥匙 / 服务 / 模型，conn-issue.ts 扫终端认出）+ 同家可换的连接 */
  connIssue?: ConnIssueState | null;
  /** 换到这条连接接着这段对话（标签动作 switchConnection：停下、换连接、按原会话接回） */
  onSwitchConnection?: (profileId: string) => void;
  onDismissConnIssue?: () => void;
  /** 没有可换的连接时去「连接」页添加 */
  onOpenProfiles?: () => void;
  /** 助手消息「从这里分叉」：带着到这条为止的对话开一个分叉标签 */
  onForkFrom?: (text: string) => void;
  /** 结构化旁路快照（chat-channel.ts）：审批的结构化内容、能否从聊天层答 */
  channel?: ChatChannelSnapshot | null;
  /** 经 CLI 官方通道回复审批（Qwen / OpenCode / Codex） */
  onChannelReply?: (requestId: string, decision: ChannelReplyDecision) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const [hasNew, setHasNew] = useState(false);
  const [stuckWaiting, setStuckWaiting] = useState(false);
  const [seedInsert, setSeedInsert] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState("");
  const prevScrollHeightRef = useRef(0);
  const loadingOlderRef = useRef(false);

  useEffect(() => {
    void invoke<string>("home_dir")
      .then(setHomeDir)
      .catch(() => {});
  }, []);

  // 「卡住」= 进程在跑、会话文件 8 秒还没出现。聊天发送会先乐观显示用户那条，
  // 所以只看「除了自己刚发的还有没有别的」——原先要求 messages.length === 0，
  // 发第一条就被乐观消息挡掉，这个出口永远不触发（2026-10-17 主目录信任菜单实测）
  // 还要求终端静止：模型慢、首轮思考久时 TUI 的转圈动画一直在出字，那不是卡住，
  // 不该把终端拉出来挡住聊天（2026-10-17 用户截图：正常开聊也弹出半屏终端）
  const onlyPendingUser = messages.every((m) => m.role === "user");
  const maybeStuck = running && syncState === "waiting" && onlyPendingUser && ptyQuiet;
  useEffect(() => {
    if (!maybeStuck) {
      setStuckWaiting(false);
      return;
    }
    const t = setTimeout(() => setStuckWaiting(true), 8000);
    return () => clearTimeout(t);
  }, [maybeStuck]);

  // 认出了信任菜单就在聊天层直接给按钮，不必再拉起终端。
  // 因为卡住而自动拉起的终端，等会话接上后自动收回；人手拉起的不动
  const autoPeekedRef = useRef(false);
  const prevStuckRef = useRef(false);
  useEffect(() => {
    // 只在刚判定卡住的那一下拉起；人手收起后不再反复弹回来
    const rising = stuckWaiting && !prevStuckRef.current;
    prevStuckRef.current = stuckWaiting;
    if (!rising || trustPrompt) return;
    if (!peek) autoPeekedRef.current = true;
    onRequestPeek?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stuckWaiting, trustPrompt]);
  useEffect(() => {
    if (syncState === "waiting" || !autoPeekedRef.current) return;
    autoPeekedRef.current = false;
    if (peek) onTogglePeek?.();
  }, [syncState, peek, onTogglePeek]);

  function scrollBottom() {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = true;
    setHasNew(false);
    el.scrollTop = el.scrollHeight;
  }

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (loadingOlderRef.current) {
      const delta = el.scrollHeight - prevScrollHeightRef.current;
      el.scrollTop += delta;
      loadingOlderRef.current = false;
      return;
    }
    if (followRef.current) requestAnimationFrame(scrollBottom);
    else setHasNew(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const unlisten = getCurrentWebviewWindow().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      if (
        !dropHitsRect(
          event.payload.position,
          rect,
          window.devicePixelRatio || 1,
        )
      ) {
        return;
      }
      const text = joinDroppedChatPaths(event.payload.paths, IS_WINDOWS);
      if (!text) return;
      if (!cancelled) setSeedInsert(text);
    });
    return () => {
      cancelled = true;
      void unlisten.then((fn) => fn());
    };
  }, [active]);

  const headerStatus = chatHeaderStatus({
    state,
    syncState,
    running,
    canResume,
    messageCount: messages.length,
  });
  // 未就绪状态注记（原头部第一行文案迁入输入框左下角）：识别中/等待会话文件/可恢复才显示，
  // linked 稳态（实时同步/已结束·可继续）不显——运行态由底部状态栏状态点覆盖
  const statusNote =
    syncState === "waiting" || state === "detecting" || state === "timeout"
      ? headerStatus
      : null;
  const canSend = state !== "timeout" || running || canResume;
  // 开聊前选择（Agent·模型 / 权限）：可改、没起进程、还没有对话
  const launchPickOpen = Boolean(launchPick?.editable && !running && messages.length === 0);

  // 空态：输入框挪到画面中间偏上，起手提示与「接着上一段」在它下方（2026-10-17 二轮收敛）
  const emptyStart = state === "idle" && messages.length === 0 && !stuckWaiting;
  const projectPaths = useAppStore((s) => s.projectPaths);
  const recentRepos = useAppStore((s) => s.recentRepos);
  const theme = useAppStore((s) => s.settings?.theme);
  const toolName = latestToolName(messages);
  const waitKind = chatWaitKind({
    pendingReply: loading,
    running,
    syncState,
    messageCount: messages.length,
    stuckWaiting,
    toolName,
  });
  const waitText = trustPrompt
    ? "等你确认是否信任这个目录"
    : chatWaitText(waitKind, toolName);
  const generating =
    loading || (running && attention === "working");
  // 这一轮已经过去多久（「正在回复 · 12 秒」）：生成开始时起表，每秒走一下，停了清零
  const [genStartedAt, setGenStartedAt] = useState<number | null>(null);
  const [, setGenTick] = useState(0);
  useEffect(() => {
    setGenStartedAt(generating ? Date.now() : null);
  }, [generating]);
  useEffect(() => {
    if (genStartedAt === null) return;
    const t = window.setInterval(() => setGenTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [genStartedAt]);
  const genElapsed = genStartedAt === null ? 0 : Math.floor((Date.now() - genStartedAt) / 1000);
  const extraHint = approvalExtraHint(agentId, hooksEnabled);
  const liveReplyCapable = liveReplySupported(agentId ?? "");
  // 一轮刚结束、会话文件还没把最后一段写进来：预览和展开的过程再留一会儿，追上了（或 4 秒到了）再收。
  // 原先一停就撤预览、过程同时收起，最后一段落盘前画面空一下才出来（2026-10-19 用户 Codex 实测）
  const [settling, setSettling] = useState(false);
  const wasGeneratingRef = useRef(generating);
  useEffect(() => {
    if (wasGeneratingRef.current && !generating) setSettling(true);
    if (generating) setSettling(false);
    wasGeneratingRef.current = generating;
  }, [generating]);
  useEffect(() => {
    if (!settling) return;
    const t = window.setTimeout(() => setSettling(false), 4000);
    return () => window.clearTimeout(t);
  }, [settling]);
  // 实时预览：终端里已经出来、会话文件还没落盘的那几行（生成中与刚结束的那一会儿显示，追上了自动让位）
  const livePreview = (() => {
    // 有「等你决定」时屏上是菜单，不是回复（decision 在下方算，这里直接看三个来源）
    if (
      !(generating || settling) ||
      !liveReply?.length ||
      attention === "confirm" ||
      trustPrompt ||
      connIssue ||
      menuPrompt ||
      tuiPanel
    )
      return [];
    let lastUser = -1;
    messages.forEach((m, i) => {
      if (m.role === "user" && m.blocks.some((b) => b.kind === "text")) lastUser = i;
    });
    const synced = messages
      .slice(lastUser + 1)
      .filter((m) => m.role !== "user")
      .flatMap((m) => m.blocks.filter((b) => b.kind === "text").map((b) => b.text))
      .join("\n");
    return unsyncedTail(liveReply, synced);
  })();
  // 会话文件追上了（预览全被盖掉，或者新内容进来了）就收；终端渲染与原文对不上的零星几行不再多挂 4 秒
  const settledMessagesRef = useRef(messages);
  useEffect(() => {
    if (!settling) {
      settledMessagesRef.current = messages;
      return;
    }
    if (livePreview.length === 0 || messages !== settledMessagesRef.current) setSettling(false);
  }, [settling, messages, livePreview.length]);

  // 「等你决定」：审批 > 启动信任 > 连接出问题 > 确认菜单（同一时刻只出一张卡）。
  // 屏上认出了审批菜单（menuPrompt）就按菜单原文给按钮，不再给「批准 / 拒绝」两个按键——
  // 各家审批多是带序号的菜单，只认回车 / 方向键 / 序号，按 y 不一定管用（2026-10-18 Claude 2.1.292 实测）
  // 旁路给了这次审批的结构化内容（命令原文 / 要改的差异）：卡片上画出来；能从聊天层答的直接给按钮
  const channelApproval = channel?.approval ?? null;
  const preview = approvalPreview(channelApproval);
  const channelChoices = channelApproval ? approvalChoices(channelApproval, agentId ?? null) : [];
  const decision: ChatDecision | null =
    channelApproval && channelChoices.length && !trustPrompt
      ? {
          key: `channel:${channelApproval.requestId ?? ""}`,
          title: approvalTitle(channelApproval, agentLabel(agentId)),
          detail: channelApproval.kind === "execute" ? channelApproval.detail : channelApproval.path,
          hint: "终端里也在等这一问，哪边先答算哪边",
          preview,
          options: channelChoices.map((c) => ({
            label: c.label,
            primary: c.primary,
            title: c.decision === "deny" ? "不让它做，它会接着想别的办法" : undefined,
            onClick: () => onChannelReply?.(channelApproval.requestId!, c.decision),
          })),
        }
      : attention === "confirm" && !menuPrompt && !trustPrompt
      ? {
          key: `approval:${confirmDetail ?? ""}`,
          title: channelApproval ? approvalTitle(channelApproval, agentLabel(agentId)) : `${agentLabel(agentId)} 在等你确认`,
          detail: confirmDetail ?? "终端里有待处理的批准、登录或菜单选择",
          hint: extraHint,
          preview,
          options: [
            ...confirmChoices(confirmDetail).map((choice) => ({
              label: choice.label,
              primary: choice.key === "y",
              title: `往终端按 ${choice.key}`,
              onClick: () => onApprovalKey?.(choice.key),
            })),
            // Grok 非 prompt 态 Esc 会触发整进程退出确认（escInterruptSafe）：不给「取消」
            ...(escInterruptSafe(agentId)
              ? [{ label: "取消", title: "往终端按 Esc（取消当前提示）", onClick: () => onApprovalKey?.("esc") }]
              : []),
          ],
        }
      : trustPrompt
        ? {
            key: `trust:${trustPrompt.path ?? ""}`,
            title: `启动前要你确认：是否信任这个目录${trustPrompt.path ? `（${trustPrompt.path}）` : ""}`,
            detail: "信任后它可以读、改、运行这个目录里的文件；不信任会直接退出。",
            hint:
              homeDir && trustPrompt.path && samePath(trustPrompt.path, homeDir, IS_WINDOWS)
                ? "这是主目录，范围很大——只是随便问问，可以改到「随手聊」目录再开始。"
                : null,
            options: [
              {
                label: "信任此目录",
                primary: true,
                title: `在终端菜单里选「${trustPrompt.options[trustPrompt.yesIndex]}」`,
                onClick: () => onAnswerTrust?.(true),
              },
              {
                label: "不信任，退出",
                title: `在终端菜单里选「${trustPrompt.options[trustPrompt.noIndex]}」`,
                onClick: () => onAnswerTrust?.(false),
              },
            ],
          }
        : connIssue
          ? connIssueDecision(connIssue, agentLabel(agentId), {
              onSwitch: (id) => onSwitchConnection?.(id),
              onDismiss: () => onDismissConnIssue?.(),
              onOpenProfiles,
            })
        : menuPrompt
          ? {
              key: `menu:${menuPrompt.question ?? ""}:${menuPrompt.options.join("|")}`,
              title: menuPrompt.question ?? "终端里在等你选一项",
              detail: menuPrompt.detail,
              // 审批菜单：旁路给了要做的事（命令 / 差异）就画在卡上，选项仍照终端原文
              preview: channel?.turn?.status === "awaiting_approval" ? preview : null,
              hint: "选项照终端原文；高亮的是终端当前默认的那一项",
              // 不替用户选：把 CLI 的选项原样摆出来（tui-menu.ts）
              options: menuPrompt.options.map((opt, i) => ({
                label: opt,
                primary: i === menuPrompt.selected,
                title: `在终端菜单里选「${opt}」`,
                onClick: () => onAnswerMenu?.(i),
              })),
            }
          : tuiPanel
            ? {
                // 面板开着时会话文件不动，原先这里一直写「正在生成回复」（2026-10-19 用户发 /cost 实测）
                key: "tui-panel",
                title: "这条命令的结果显示在终端的面板里",
                detail: "像 /cost、/usage 这类命令会在终端里打开一个面板，聊天层读不到里面的内容。看完关掉面板就能接着聊。",
                // Grok 非 prompt 态 Esc 会触发整进程退出确认（escInterruptSafe）：只留「露出终端 / 打开终端」
                options: escInterruptSafe(agentId)
                  ? [{ label: "关闭面板", title: "往终端按 Esc", onClick: () => onApprovalKey?.("esc") }]
                  : [],
              }
            : null;
  // 出了新问题就滚到底：卡片贴着输入框，不能藏在视口外
  const decisionKey = decision?.key ?? null;
  useEffect(() => {
    if (decisionKey) requestAnimationFrame(scrollBottom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decisionKey]);

  async function sendFromComposer(text: string): Promise<string | null> {
    const event = slashHandoff(text, modelSwitch?.kind ?? null);
    if (event === "picker_model") onRequestPeek?.();
    return onSend(text);
  }

  // 终端选中文字交给对话（终端会话「Mesa内嵌终端优化」的右键菜单 / 浮条 → 父级分派到这里）
  const externalToken = externalInsert?.token ?? null;
  useEffect(() => {
    if (!externalInsert) return;
    if (externalInsert.send) void onSend(externalInsert.text);
    else setSeedInsert(externalInsert.text);
    onExternalInsertConsumed?.();
    // 只在新请求到来时处理一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalToken]);
  const recallText = lastUserText(messages);
  const contextUsed = lastContextTokens(messages);

  return (
    <div
      ref={rootRef}
      data-chat-drop="1"
      className="flex h-full min-h-0 w-full flex-col bg-canvas"
    >
      {/* 聊天头部整条取消（2026-09-13）：标题归标签条，身份/模型/目录/状态点归底部状态栏
          （chat 变体）——两行头部与它们完全重复。原头部独有功能就近收编：
          停止 → 发送钮同体（正在生成变「进行中」符号钮，点击往终端发 Esc 暂停，会话保留）；
          只读分叉/允许修改与未就绪状态注记 → 输入框左下角 micro 行；
          ＋ 只插入技能/MCP；分叉和回放在启动行 ⋯。
          「等你决定」（信任 / 确认菜单 / 审批）原是这里的三种横条，2026-10-17 第一期合成对话末尾的
          ChatDecisionCard，贴着输入框（docs/design-chat-layer.md §5）。 */}

      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          const nearBottom =
            el.scrollHeight - el.scrollTop - el.clientHeight < 56;
          followRef.current = nearBottom;
          if (nearBottom) setHasNew(false);
        }}
        className={
          emptyStart
            ? "min-h-0 flex-[0.75_1_0]"
            : "relative min-h-0 flex-1 overflow-auto"
        }
      >
        <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-4 pb-6 pt-8 sm:px-5">
          {hasOlder && onLoadOlder && (
            <div className="mb-4 flex justify-center">
              <button
                type="button"
                disabled={loadingOlder}
                onClick={() => {
                  followRef.current = false;
                  loadingOlderRef.current = true;
                  prevScrollHeightRef.current =
                    scrollRef.current?.scrollHeight ?? 0;
                  onLoadOlder();
                }}
                className="rounded-md px-2.5 py-1 text-micro text-l3 hover:bg-hover hover:text-l1 disabled:opacity-40"
              >
                {loadingOlder ? "加载中…" : "加载更早的消息"}
              </button>
            </div>
          )}
          {emptyStart && (
            // 空态问候：Mesa 光标标志 + 时段问候，贴在输入框正上方（2026-10-17 用户选定）。
            // 只是问候：不重复「问一个问题…」，不写 Agent 身份（v3.214 否决的是居中引导语）。
            // 标志用去掉底板的字标（2026-10-18 用户：方块图标像摆了个 App 图标）：M 随主题字色、
            // 光标琥珀，坐在问候的基线上读作「M▁ 夜深了」，出现时光标闪三下
            <div className="mx-auto mt-auto flex w-full max-w-[45rem] items-baseline gap-3 px-1 pb-4 text-xl font-medium tracking-tight text-l1">
              <MesaMark
                light={isLightTheme(theme)}
                blink
                className="h-[0.85em] w-auto shrink-0"
              />
              <span>{chatGreeting(new Date().getHours())}</span>
            </div>
          )}
          {state === "idle" && messages.length === 0 ? (
            stuckWaiting ? (
              <div className="flex flex-1 flex-col items-center justify-center pb-20 text-center">
                <p className="max-w-md text-sm text-warn-text">
                  {chatWaitText("no_session")}
                  ——信任此目录 / 登录 / 菜单选择通常在终端里
                </p>
                <div className="mt-3 flex items-center gap-2">
                  {onTogglePeek && (
                    <button
                      type="button"
                      onClick={onTogglePeek}
                      className="rounded-md border border-field bg-raised px-3 py-1.5 text-xs text-l2 hover:bg-inset hover:text-l1"
                    >
                      {peek ? "终端已露出" : "露出终端"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={onOpenTerminal}
                    className="rounded-md border border-field bg-raised px-3 py-1.5 text-xs text-l2 hover:bg-inset hover:text-l1"
                  >
                    打开终端处理
                  </button>
                </div>
              </div>
            ) : null
          ) : state === "detecting" && messages.length === 0 ? (
            <div className="flex flex-1 items-center justify-center pb-20 text-sm text-l4">
              正在连接当前会话…
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-1" />
          ) : (
            <ConversationView
              messages={messages}
              cwd={cwd}
              working={generating || settling}
              onEditResend={(text) => setSeedInsert(text)}
              onForkHere={onForkFrom}
            />
          )}
          {livePreview.length > 0 && (
            // 与助手正文同一栏、同字号，但不走 Markdown（终端里已渲染过）：灰一级表示「还在写、以落盘为准」
            <div className="mb-2 whitespace-pre-wrap break-words text-sm leading-6 text-l3">
              {livePreview.join("\n")}
            </div>
          )}
          {decision && (
            <ChatDecisionCard
              decision={decision}
              onOpenTerminal={onOpenTerminal}
              onPeek={onTogglePeek && !peek ? onTogglePeek : undefined}
            />
          )}
          {generating && !decision && (
            // 「正在回复」用 Mesa 字标（2026-10-18 用户：换成 Mesa 独有的设计）：M▁ 的琥珀光标像插入符一样亮灭，
            // 后面是这一轮在做什么（已送出 / 正在生成回复 / 正在用 Bash…）和已经过去的时间
            <div className="mb-2 flex items-center gap-2 text-xs text-l3">
              <MesaMark
                light={isLightTheme(theme)}
                typing
                inline
                className="h-[0.8em] w-auto shrink-0 text-l3"
              />
              <span aria-live="polite">{waitText || "正在回复"}</span>
              {genElapsed >= 3 && (
                <span className="tabular-nums text-l4" aria-hidden="true">
                  {fmtElapsed(genElapsed)}
                </span>
              )}
              {/* 聊天层按会话文件同步，一段写完才落盘；Claude Code 的逐字输出已在上方实时预览，
                  别家没有预览时才给「看实时输出」（2026-10-17 用户：点开终端比聊天层先显示，体验不好） */}
              {onTogglePeek && !peek && !liveReplyCapable && (
                <button
                  type="button"
                  onClick={onTogglePeek}
                  className="rounded-sm px-1 text-l4 underline decoration-dotted underline-offset-2 hover:text-l2"
                >
                  看实时输出
                </button>
              )}
            </div>
          )}
          {hasNew && (
            <button
              type="button"
              onClick={scrollBottom}
              // 居中只靠 mx-auto：sticky 下 left-1/2 不起定位作用，再叠 -translate-x-1/2 会把按钮往左偏半个身位
              className="sticky bottom-2 mx-auto rounded-md border border-field bg-raised px-2.5 py-1 text-xs text-l2 hover:bg-inset hover:text-l1"
            >
              有新消息 ↓
            </button>
          )}
        </div>
      </div>

      <ChatComposer
        disabled={!canSend}
        busy={busy}
        skills={skills}
        mcps={mcps}
        onSend={sendFromComposer}
        focusWhen={active}
        agentId={agentId}
        seedInsert={seedInsert}
        onSeedConsumed={() => setSeedInsert(null)}
        placeholder={
          decision
            ? "先在上面选一项，或者直接回复…"
            : readOnly
            ? "这是只读分叉；可以提问、分析和规划…"
            : generating && running
              ? "还在回复；现在发的话会排队，这一轮结束后处理…"
            : messages.length === 0
              ? "问一个问题…"
              : undefined
        }
        leftExtras={
          <>
            {/* 目录芯片（2026-10-17 用户：「将在 ~ 开始」应该是选项目）：写项目名 / 随手聊 / 主目录，
                点开同终端空态卡那张目录菜单，多一项「新建项目…」；开聊后目录不能再换，不显示 */}
            {cwd && launchPick?.editable && !running && messages.length === 0 && (
              <button
                type="button"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  if (onOpenDirMenu) onOpenDirMenu(r.left, r.bottom + 4);
                  else onChooseCwd?.();
                }}
                title={`${cwd === "~" && homeDir ? homeDir : cwd}\n点击换项目或文件夹`}
                className="ml-1 flex h-6 min-w-0 max-w-[14rem] items-center gap-1 rounded-md px-1.5 text-micro text-l3 hover:bg-hover hover:text-l1"
              >
                <FolderOpen size={12} strokeWidth={1.8} aria-hidden="true" className="shrink-0" />
                <span className="truncate">
                  {cwdChipLabel({
                    cwd,
                    home: homeDir,
                    projectPaths,
                    recentRepos,
                    isWindows: IS_WINDOWS,
                  })}
                </span>
                <ChevronDown size={12} strokeWidth={1.8} aria-hidden="true" className="shrink-0" />
              </button>
            )}
            {/* 权限徽标：开聊前可选两档，开聊后只读；只读分叉另有「只读分叉」标签，不重复 */}
            {launchPick && !readOnly && (launchPickOpen || running || canResume) && (
              <ChatPermissionBadge
                agentLabel={AGENTS.find((a) => a.id === launchPick.agentId)?.label ?? "这家 CLI"}
                permission={launchPick.permission}
                mode={launchPick.permissionMode}
                modes={launchPick.permissionModes}
                readonlySupported={launchPick.readonlySupported}
                note={launchPick.permissionNote}
                // 开聊前、或 Agent 停了还能接着聊：改的是下次启动的参数；运行中：换 = 重开接回
                editable={launchPickOpen || (!running && canResume)}
                onPermission={onPickLaunch?.permission}
                live={
                  running && onRestartPermission
                    ? { busy: generating, onRestart: onRestartPermission }
                    : null
                }
              />
            )}
            {statusNote ? (
              <span
                // 窄栏（阅读区右栏）里让它截断，不然顶到右侧的模型芯片上叠字
                className="ml-1 min-w-0 truncate text-micro text-l4"
                title={statusNote === "等待会话文件" ? "会话文件还没出现；Agent 起来后会自动接上" : statusNote}
              >
                {statusNote}
              </span>
            ) : null}
            {readOnly && (
              <span
                className="ml-1 shrink-0 rounded-md bg-inset px-1.5 py-0.5 text-micro text-warn-text"
                title={
                  readonlySupported
                    ? "该分叉会话启用了 Agent 原生只读/计划模式"
                    : "该 Agent 没有原生只读参数，仅提供提示约束"
                }
              >
                只读分叉
              </span>
            )}
            {readOnly && (
              <button
                type="button"
                onClick={onAllowWrite}
                className="shrink-0 rounded px-1 text-micro text-warn-text hover:bg-hover"
              >
                允许修改
              </button>
            )}
          </>
        }
        rightExtras={
          // 「模型 · 思考」菜单：开聊前、运行中、停了可接着聊同一个菜单（ChatModelMenu）
          launchPickOpen && onPickLaunch ? (
            <ChatModelMenu
              kind="launch"
              pick={launchPick!}
              onAgent={onPickLaunch.agent}
              onProfile={onPickLaunch.profile}
              onModel={onPickLaunch.model}
              onEffort={onPickLaunch.effort}
              onPermission={onPickLaunch.permission}
            />
          ) : (running || canResume) && runtime && onTuiCommand ? (
            <ChatModelMenu
              kind="runtime"
              status={runtime.status}
              profileModels={runtime.profileModels}
              modelSwitch={modelSwitch ?? null}
              effort={runtime.effort}
              submitCsiU={runtime.submitCsiU}
              onTuiCommand={onTuiCommand}
              onPicker={onRequestPeek}
              contextUsed={contextUsed}
              onCompact={mesaCommands.find((c) => c.cmd === "/compact")?.run ?? null}
              onRelaunch={runtime.onRelaunch}
              // 进程退出、还能接着聊：改选「接着聊用哪个模型」，写标签的启动选择（与终端启动栏同一份）
              next={
                !running && canResume && launchPick && onPickLaunch
                  ? {
                      models: launchPick.models,
                      model: launchPick.model,
                      onModel: onPickLaunch.model,
                      effortLevels: launchPick.effortLevels,
                      effort: launchPick.effort,
                      onEffort: onPickLaunch.effort,
                    }
                  : null
              }
            />
          ) : null
        }
        running={composerShowsInterrupt({
          running,
          attention,
          pendingReply: loading,
        })}
        onInterrupt={onInterrupt}
        narrow={emptyStart}
        cwd={cwd ?? null}
        mesaCommands={mesaCommands}
        recallText={recallText}
      />
      {emptyStart && (
        // 输入框后面同一层级渲染，切出空态时输入框不重挂载（已输入的字、焦点都在）
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-[45rem] px-4">
            <ChatEmptyStart
              cwd={cwd}
              homeDir={homeDir}
              onPickPrompt={(text) => setSeedInsert(text)}
              resumeSessionId={launchPick?.resumeSessionId ?? null}
              onRestore={onRestore}
              onPickRecent={onPickRecent}
              onShowScreen={onOpenTerminal}
            />
          </div>
        </div>
      )}
      {peek && (
        <button
          type="button"
          onClick={onTogglePeek}
          title="收起露出的终端画面"
          className="shrink-0 border-t border-hairline bg-inset px-3 py-1 text-center text-micro text-l4 hover:bg-hover hover:text-l2"
        >
          下方是同一会话的终端 · 点此收起
        </button>
      )}
    </div>
  );
}

function fmtElapsed(sec: number): string {
  if (sec < 60) return `${sec} 秒`;
  return `${Math.floor(sec / 60)} 分 ${String(sec % 60).padStart(2, "0")} 秒`;
}

function agentLabel(agentId: string | null | undefined): string {
  return AGENTS.find((a) => a.id === agentId)?.label ?? "Agent";
}
