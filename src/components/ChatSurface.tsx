import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDown } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import ConversationView from "./ConversationView";
import ChatSearch from "./ChatSearch";
import { locateChatQuote, messageIdentity } from "../chat-navigation";
import { ChatImageEditContext } from "./ChatMarkdown";
import ChatComposer, { useFlashOnSeq, type ComposerSeed } from "./ChatComposer";
import { splitDocPaths, splitImagePaths } from "../chat-image";
import ChatEmptyStart from "./ChatEmptyStart";
import MesaThinkingDots from "./MesaThinkingDots";
import { firstCompleteTurnIndex } from "../conversation-tools";
import { useAutoLoadOlder, wasPrepended } from "../auto-load-older";
import { useReadingAnchor } from "../reading-anchor";
import { chatGreeting, resolveChatCwd, starterContextFor } from "../chat-empty-start";
import { useAppStore } from "../store";
import { isLightTheme } from "../themes";
import { MesaCaret, MesaMark, MesaStatusLead } from "./MesaMark";
import ChatModelMenu from "./ChatModelMenu";
import ChatPermissionBadge, { confirmPermissionChoice, effectivePermissionTier } from "./ChatPermissionBadge";
import ChatProjectPicker, { type DirPick } from "./ChatProjectPicker";
import { nextPermissionTier } from "../chat-permission";
import { readCombos, recordCombo, type LaunchCombo } from "../launch-combos";
import type {
  ConnIssueState,
  LaunchPickState,
  NativePermissionMode,
  TabStatus,
} from "../pages/TerminalPage";
import type { MenuAnswer, TuiMenu } from "../tui-menu";
import type { PermissionTierId } from "../chat-permission";
import { dropAskedEcho, liveReplySupported, sameAsPrevReply, unsyncedTail } from "../live-reply";
import { useRevealedText } from "../text-reveal";
import { lastContextTokens, userTextHistory, type MesaCommand } from "../composer-assist";
import { AGENTS, type ProjectDto } from "../types";
import type {
  ChatMessageDto,
  DetectResult,
  McpServerDto,
  SessionSyncState,
  SkillDto,
} from "../types";
import { IS_WINDOWS } from "../hotkeys";
import { samePath } from "../path-utils";
import { dropHitsRect } from "../terminal-input";
import {
  approvalExtraHint,
  chatHeaderStatus,
  chatMessageKey,
  CHAT_NO_SESSION_TEXT,
  composerShowsInterrupt,
  confirmHandoffEvent,
  slashHandoff,
} from "../chat-handoff";
import { confirmHandoffReason, decisionKind, recordChatHandoff, type HandoffReason } from "../chat-handoff-log";
import { chatStatus, settleStatus, statusCaretMotion, type ShownStatus } from "../chat-status";
import { confirmChoices } from "../chat-reply";
import ChatDecisionCard, { type ChatDecision } from "./ChatDecisionCard";
import { useCliNewer } from "../cli-verified";
import { connIssueDecision, grokLoginDecision } from "../chat-decision";
import { cwdChipLabel } from "../terminal-welcome";
import { escInterruptSafe } from "../agent-caps";
import { midTurnSpec, queueSendHint, queuedNote, runningPlaceholder, stopTitle } from "../mid-turn-send";
import type { TrustPrompt } from "../trust-prompt";
import {
  launchFailureHint,
  type FirstRunNote,
  type LaunchBlock,
  type LaunchFailure,
  type SpecialScreen,
  type WaitKey,
  type WaitScreen,
} from "../terminal-wait";
import type { AskAction } from "../tui-ask";
import { isPlanMenu, latestPlanText, planCardChoices, planChoice, planFeedbackText, planMenuTitle } from "../plan-approval";
import {
  channelSourceNote,
  channelOutcome,
  isQuestionApproval,
  approvalChoices,
  approvalPreview,
  approvalTitle,
  menuOutgrowsChannel,
  type ChannelReplyDecision,
  type ChatChannelSnapshot,
} from "../chat-channel";

export default function ChatSurface({
  messages,
  state,
  syncState,
  loading,
  active = true,
  searchRequest = 0,
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
  recordPending = false,
  onPickLaunch,
  onRestore,
  onDraftChange,
  onPickDir,
  onNewProject,
  runtime = null,
  onTuiCommand,
  menuPrompt = null,
  onAnswerMenu,
  onPlanLeft,
  planStartBlocked = false,
  onAnswerAsk,
  tuiPanel = false,
  tuiNotice = null,
  liveReply = null,
  liveTokens = null,
  liveThinking = null,
  promptSuggestion = null,
  onRestartPermission,
  mesaCommands = [],
  externalInsert = null,
  onExternalInsertConsumed,
  connIssue = null,
  onSwitchConnection,
  onDismissConnIssue,
  grokLoginStuck = false,
  onGrokLogout,
  onDismissGrokLogin,
  onOpenProfiles,
  onForkFrom,
  channel = null,
  onChannelReply,
  onSendNow,
  waitScreen = null,
  onWaitKey,
  onOpenLink,
  firstRunNote = null,
  launchFailure = null,
  onLaunchAgain,
  onDismissLaunchFailure,
  launchBlock = null,
  onFixGeminiAuth,
  onDismissLaunchBlock,
  specialScreen = null,
  metaSlots = null,
}: {
  messages: ChatMessageDto[];
  state: "idle" | "detecting" | "linked" | "timeout";
  syncState: SessionSyncState;
  loading: boolean;
  /** 聊天层当前可见（常驻挂载仅隐藏后，用作输入框聚焦信号） */
  active?: boolean;
  searchRequest?: number;
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
  onApprovalKey?: (key: "y" | "n" | "esc" | "enter") => void;
  peek?: boolean;
  onTogglePeek?: () => void;
  modelSwitch?: DetectResult["modelSwitch"];
  hooksEnabled?: boolean;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  /** 拉到更早一页后先 await settle（等手停）再写进列表 */
  onLoadOlder?: (settle?: () => Promise<void>) => void | Promise<void>;
  /** 空态目录行：点选工作目录（未启动时走终端标签 chooseCwd） */
  onChooseCwd?: () => void;
  /** 终端里正停着「是否信任这个目录」菜单（会话文件出现之前） */
  trustPrompt?: TrustPrompt | null;
  onAnswerTrust?: (accept: boolean) => void;
  /** Agent 在跑但终端 4 秒没出字（TUI 静止，多半停在菜单 / 登录上） */
  ptyQuiet?: boolean;
  /** 开聊前的 Agent / 配置 / 模型选择（与终端启动栏同一份；进程起来后不再显示） */
  launchPick?: LaunchPickState | null;
  /** 接一段旧对话的标签刚开、状态还没报上来：记录在路上，不画空态 */
  recordPending?: boolean;
  onPickLaunch?: {
    agent: (id: string) => void;
    profile: (id: string) => void;
    model: (model: string) => void;
    effort: (level: string) => void;
    permission: (
      permission: "discuss" | "write_tree",
      mode?: NativePermissionMode | null,
    ) => void;
    /** 「最近用过」的一套搭配：Agent + 连接 + 模型 + 思考档一起换 */
    combo?: (combo: LaunchCombo) => void;
  };
  /** 恢复占位：接回这个标签上次的会话 */
  onRestore?: () => void;
  /** 输入框里有没有没发的字或附件（标签那边据此决定切走时能不能顺手收掉这个标签） */
  onDraftChange?: (hasDraft: boolean) => void;
  /** 开聊前换项目 / 文件夹（项目芯片弹层、把文件夹拖进来）：选了项目由标签那边带上项目默认的 Agent */
  onPickDir?: (pick: DirPick) => void;
  /** 项目弹层「新建项目…」 */
  onNewProject?: () => void;
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
  /** 选菜单第 index 项；带 text 时先把字打进那一行再回车（Claude 方案确认的「Tell Claude what to change」） */
  onAnswerMenu?: (index: number, opts?: MenuAnswer) => void;
  /** 方案确认上点了开工（或结束计划模式）、键已按下：这段对话离开只讨论，按 tier 走（null = 这家 CLI 自己的设置） */
  onPlanLeft?: (tier: NativePermissionMode | null) => void;
  /** 只讨论的目标 / 任务卡想法（discussOnly）：方案卡不给开工，只留「接着改方案」「先不开工」 */
  planStartBlocked?: boolean;
  /** 答 Claude 的提问表单（menuPrompt.ask，tui-ask.ts） */
  onAnswerAsk?: (action: AskAction) => void;
  /** 终端里开着一个只能在终端看的面板（/cost、/usage 的 Settings 面板等，tui-panel.ts） */
  tuiPanel?: boolean;
  /** 终端里弹了一条要按回车才继续的通知（tui-panel.ts parseTuiNotice）：正文行 */
  tuiNotice?: string[] | null;
  /** 终端画面里这一轮正在写的回复（live-reply.ts）；会话文件追上的行由这里剔掉 */
  liveReply?: string[] | null;
  /** Claude 转圈行里这一轮已生成的 token 数（Windows 上 Claude 不边写边画，靠它看出还在出字）；没有为 null */
  liveTokens?: number | null;
  /** 终端思考框里正在显示的思考（live-reply.ts extractLiveThinking：Grok、Kimi）：正文出来前照原样显示在实时预览的位置 */
  liveThinking?: string | null;
  /** Claude 输入框里那行灰字：它猜你下一句想说什么（prompt-suggestion.ts）；输入框空着时照样灰着显示，Tab 填入 */
  promptSuggestion?: string | null;
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
  /** Grok 卡在续期过期的官方登录上（grok_login.rs）：卡片给「退出官方登录，接着这段对话」 */
  grokLoginStuck?: boolean;
  onGrokLogout?: () => void;
  onDismissGrokLogin?: () => void;
  /** 没有可换的连接时去「连接」页添加 */
  onOpenProfiles?: () => void;
  /** 助手消息「从这里分叉」：带着到这条为止的对话开一个分叉标签 */
  onForkFrom?: (text: string) => void;
  /** 结构化旁路快照（chat-channel.ts）：审批的结构化内容、能否从聊天层答 */
  channel?: ChatChannelSnapshot | null;
  /** 经 CLI 官方通道回复审批（Qwen / OpenCode / Codex） */
  onChannelReply?: (requestId: string, decision: ChannelReplyDecision) => void;
  /** 往终端写一串键（「立即发送」：这家 CLI 让排着的那句马上处理的键，mid-turn-send.ts） */
  onSendNow?: (keys: string) => void;
  /** 终端里「在等你」的那一块（terminal-wait.ts waitScreenOf）；noInputBox = 这家有画面布局表且屏上没有它的输入框 */
  waitScreen?: (WaitScreen & { noInputBox: boolean }) | null;
  /** 通用卡上的按键：照这家的口径写进终端（标签动作 pressWaitKey） */
  onWaitKey?: (key: WaitKey) => void;
  onOpenLink?: (url: string) => void;
  /** Claude Code 第一次启动时替人走完的配色 / 安全须知（聊天里留一行说明） */
  firstRunNote?: FirstRunNote | null;
  /** Agent 一启动就退出、还没接上会话：退出码与终端最后几行 */
  launchFailure?: LaunchFailure | null;
  onLaunchAgain?: () => void;
  onDismissLaunchFailure?: () => void;
  /** 启动被拦、聊天层能给出处理办法（Gemini 还没把认证方式设成 API Key） */
  launchBlock?: LaunchBlock | null;
  onFixGeminiAuth?: () => void;
  onDismissLaunchBlock?: () => void;
  /** 认得出的首次启动屏（Gemini 要存密钥、Cursor 要登录，terminal-wait.ts specialScreenOf） */
  specialScreen?: SpecialScreen | null;
  /**
   * 底部状态栏（聊天变体）留给「权限 · 项目 | 模型」的左右两格（TerminalStatusBar chatMetaRef）。
   * 两格都在、输入框不在居中空态时挂进去（输入框下面只有一行，2026-10-23）；否则画在输入框下面
   */
  metaSlots?: { left: HTMLElement | null; right: HTMLElement | null } | null;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollFadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const followRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const [hasNew, setHasNew] = useState(false);
  // 往上翻了一段：底部正中浮一枚「回到最新」（2026-10-26 用户）。离底一点就冒出来太吵（同日用户：「不要离底立马就显现，
  // 用户可能需要的时候再显示」），一屏又太晚（同日二改）：离底超过三分之一屏（至少 160px）才出；底下来了新内容另由 hasNew 叫出来
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [stuckWaiting, setStuckWaiting] = useState(false);
  const [seedInsert, setSeedInsert] = useState<string | ComposerSeed | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [composerFocus, setComposerFocus] = useState(0);
  const [focus, setFocus] = useState<{ identity: string; fromEnd: number; query: string; seq: number } | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const focusMessage = useCallback((index: number, query: string) => {
    const list = messagesRef.current;
    if (index < 0 || !list[index]) { setFocus(null); return; }
    followRef.current = false;
    const identity = messageIdentity(list[index]);
    const fromEnd = list.slice(index + 1).filter((message) => messageIdentity(message) === identity).length;
    setFocus((prev) => ({ identity, fromEnd, query, seq: (prev?.seq ?? 0) + 1 }));
  }, []);
  const focusIndex = useMemo(() => {
    if (!focus) return -1;
    const matches = messages.flatMap((message, index) => messageIdentity(message) === focus.identity ? [index] : []);
    return matches[matches.length - 1 - focus.fromEnd] ?? -1;
  }, [messages, focus]);
  useEffect(() => {
    if (searchRequest) { followRef.current = false; setSearchOpen(true); }
  }, [searchRequest]);
  const editImage = useCallback((absPath: string) => setSeedInsert({ text: "", paths: [], edit: absPath }), []);
  const [homeDir, setHomeDir] = useState("");
  const loadingOlderRef = useRef(false);
  const prevFirstKeyRef = useRef<string | null>(null);
  // 被分页切断的半轮先不显示（它的提问在更早一页里），否则收起行的时长 / 条数会在加载更早一页后变
  const firstShown = firstCompleteTurnIndex(messages, hasOlder, focusIndex);
  const shownMessages = useMemo(() => messages.slice(firstShown), [messages, firstShown]);

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

  // 卡住、认不出的确认、斜杠命令打开的选择器：不再自动弹出底部终端（2026-10-27 用户拍板），改出「终端在等你」通用卡
  //（waitDecision）。选择器开着由这里记：发了会打开选择器的命令 / 点了芯片里的选择器之后，到屏上回到输入框为止
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerSeenRef = useRef(false);
  useEffect(() => {
    if (!pickerOpen) return;
    if (waitScreen) pickerSeenRef.current = true;
    else if (pickerSeenRef.current) setPickerOpen(false);
    const t = setTimeout(() => setPickerOpen(false), 30_000);
    return () => clearTimeout(t);
  }, [pickerOpen, waitScreen]);
  function openPicker() {
    pickerSeenRef.current = false;
    setPickerOpen(true);
  }
  // 「在等确认」刚出现先等一会儿：hooks / 旁路的事件比屏上画出菜单早到，扫屏认菜单还有 250ms 节流，
  // 这一下读到的是半截画面，认不出就先冒一张通用卡、随即换成菜单卡（同原先自动露出终端的 1.5 秒宽限）
  const [confirmAged, setConfirmAged] = useState(false);
  useEffect(() => {
    setConfirmAged(false);
    if (attention !== "confirm") return;
    const t = setTimeout(() => setConfirmAged(true), 1500);
    return () => clearTimeout(t);
  }, [attention]);

  function scrollBottom() {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = true;
    setHasNew(false);
    setAwayFromBottom(false);
    el.scrollTop = el.scrollHeight;
  }

  // 阅读位置：上面多了更早一页、图片晚到撑高时把正看着的那行留在原处，跟着底部时贴底（reading-anchor.ts）。
  // 人刚点开了什么（过程、长文）而内容变高：先锚住，再按现在离底多远重算跟不跟
  useReadingAnchor(scrollRef, {
    stickToBottom: () => followRef.current,
    onUserShift: () => {
      const el = scrollRef.current;
      if (el) followRef.current = nearBottom(el);
    },
  });

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const prepended =
      loadingOlderRef.current &&
      wasPrepended(prevFirstKeyRef.current, shownMessages.map(chatMessageKey));
    prevFirstKeyRef.current = shownMessages[0] ? chatMessageKey(shownMessages[0]) : null;
    // 头部真的多了更早一页：位置由 useReadingAnchor 在绘制前挪回，这次不算「有新消息」。
    // 等更早一页的途中最新窗口刷新了（只在尾部追加）不算前插，标记留给真前插那次
    if (loadingOlderRef.current && prepended) {
      loadingOlderRef.current = false;
      return;
    }
    // 贴底当帧就贴（不等下一帧）：切到一段刚摆出来的对话时，先画一帧停在最上面、再跳到底，看着是一跳。
    // 下一帧再补一次，接住这一帧之后才排好版的内容
    if (followRef.current) {
      scrollBottom();
      requestAnimationFrame(scrollBottom);
    } else setHasNew(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownMessages]);
  // 加载结束（loadingOlder 与新消息同一批到）还没前插：这页没带来更早的消息，补偿标记作废
  useLayoutEffect(() => {
    if (!loadingOlder) loadingOlderRef.current = false;
  }, [loadingOlder]);

  // 拖放监听只挂一次：开聊前能不能换目录随渲染变，经 ref 读最新的
  const dropPickDirRef = useRef<((pick: DirPick) => void) | null>(null);
  // 拖着文件悬在聊天区上方：盖一层「松开添加」（2026-10-23 用户：像 ChatGPT 那样拖进输入框）
  const [dropHover, setDropHover] = useState(false);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const unlisten = getCurrentWebviewWindow().onDragDropEvent((event) => {
      const hits = (position: { x: number; y: number }) => {
        const rect = rootRef.current?.getBoundingClientRect();
        return Boolean(rect && rect.width > 0 && dropHitsRect(position, rect, window.devicePixelRatio || 1));
      };
      const p = event.payload;
      if (p.type === "enter" || p.type === "over") {
        if (!cancelled) setDropHover(hits(p.position));
        return;
      }
      if (!cancelled) setDropHover(false);
      if (p.type !== "drop" || !hits(p.position)) return;
      const paths = p.paths.filter((x) => x.length > 0);
      if (paths.length === 0) return;
      // 拖进来的成附件卡（同「+ → 文件或图片」，图片和 PDF 带缩略图），发送时一行一个路径
      const seed = { text: "", paths };
      // 开聊前拖进来一个文件夹 = 在这个文件夹里聊（项目弹层底部写着「也可以把文件夹拖进来」）；文件照旧当附件
      const pickDir = dropPickDirRef.current;
      if (pickDir && paths.length === 1) {
        const path = paths[0];
        void invoke("list_dir", { path, showHidden: false })
          .then(() => {
            if (!cancelled) pickDir({ kind: "folder", path });
          })
          .catch(() => {
            if (!cancelled) setSeedInsert(seed);
          });
        return;
      }
      if (!cancelled) setSeedInsert(seed);
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
  // linked 稳态（实时同步/已结束·可继续）不显——运行态由底部状态栏状态点覆盖。
  // 只看没接的对话（列表里点开的）：输入框底部照常摆这段对话上次的「权限 · 模型 · 思考」、能改（2026-10-24 用户），
  // 不加注记（原「发一句就接着聊」，同日用户删：看着像提示语、占地方，发一句接回是自然的事）
  const resumePickOpen = Boolean(launchPick?.resumePick && !running);
  const statusNote =
    launchPick?.preview === "shown" && !running
      ? null
      : syncState === "waiting" || state === "detecting" || state === "timeout"
        ? headerStatus
        : null;
  const canSend = state !== "timeout" || running || canResume;
  // 开聊前选择（Agent·模型 / 权限）：可改、没起进程、还没有对话
  const launchPickOpen = Boolean(launchPick?.editable && !running && messages.length === 0);
  dropPickDirRef.current = launchPickOpen && onPickDir ? onPickDir : null;

  // 空态：输入框挪到画面中间偏上，起手提示与「接着上一段」在它下方（2026-10-17 二轮收敛）。
  // 只看没接的对话还在读记录时不进空态，免得问候语闪一下；标签刚开、这段对话的状态还没报上来时同样不进
  //（recordPending，2026-10-24 用户：切对话画面跳一下——先画一帧居中的空态再沉到底）
  const emptyStart =
    state === "idle" &&
    messages.length === 0 &&
    !stuckWaiting &&
    launchPick?.preview !== "loading" &&
    !recordPending;
  // 输入框上方的看图标注台开着时不用居中空态：输入框沉到底，把整块高度让给图（2026-10-23 用户：图太小了）
  const [imageStageOpen, setImageStageOpen] = useState(false);
  const emptyLayout = emptyStart && !imageStageOpen;

  async function loadOlder(settle?: () => Promise<void>) {
    if (!onLoadOlder) return;
    // 人往上翻到顶附近才算不跟底了；还贴着底（刚打开、最新一页不满三屏就自动接更早的）时接上来仍贴底——
    // 原先一律不跟，切到一段对话先在底部闪一下、接上更早一页后停在上面（2026-10-26 用户）
    const el = scrollRef.current;
    if (!el || !nearBottom(el)) followRef.current = false;
    loadingOlderRef.current = true;
    await onLoadOlder(settle);
  }
  useAutoLoadOlder(scrollRef, {
    enabled: hasOlder && !!onLoadOlder && !emptyStart,
    busy: loadingOlder,
    onLoad: loadOlder,
    fillKey: messages.length,
  });
  const projectPaths = useAppStore((s) => s.projectPaths);
  const recentRepos = useAppStore((s) => s.recentRepos);
  const theme = useAppStore((s) => s.settings?.theme);
  const generating =
    loading || (running && attention === "working");
  // 这一轮已经过去多久：生成开始时起表，每秒走一下，停了清零
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
  // 「这一轮现在在做什么」（chat-status.ts）：说在做的事，不说阶段；过程里已经在动的那一行不在这里重复
  const activity = channel?.activity ?? null;
  const thinking = channel?.thinking ?? null;
  const statusLine = channel?.statusLine ?? null;
  const statusBase = useMemo(
    () =>
      chatStatus({
        messages,
        activity,
        thinking,
        statusLine,
        cwd: cwd ?? null,
        isWindows: IS_WINDOWS,
      }),
    [messages, activity, thinking, statusLine, cwd],
  );
  // 状态字最短停留（settleStatus）：一秒里连跳几条时不跟着闪，停够了换成那一刻最新的一条；每一轮从头算。
  // 「思考中」与 M▁ 同一帧出（2026-10-26，原先刚发出 1.5 秒只亮光标）
  const shownStatusRef = useRef<ShownStatus | null>(null);
  const [shownStatus, setShownStatus] = useState<ShownStatus | null>(null);
  useEffect(() => {
    if (!generating) {
      shownStatusRef.current = null;
      setShownStatus(null);
      return;
    }
    let timer = 0;
    const apply = () => {
      const r = settleStatus(shownStatusRef.current, statusBase, Date.now());
      if (r.shown !== shownStatusRef.current) {
        shownStatusRef.current = r.shown;
        setShownStatus(r.shown);
      }
      if (r.retryInMs !== null) timer = window.setTimeout(apply, r.retryInMs);
    };
    apply();
    return () => window.clearTimeout(timer);
  }, [generating, statusBase]);
  // 刚开始生成、还没排进去的那一帧直接用算出来的（和第一条一样，不必空一帧）
  const status = shownStatus?.status ?? statusBase;
  const statusText = trustPrompt ? "等你确认是否信任这个目录" : status.text;
  const statusMotion = statusCaretMotion(status.kind, Boolean(trustPrompt));
  // 最近一次「看得见的进展」：新消息、预览出字、旁路换了工具 / 思考 / CLI 自己报的现状。安静满 10 秒才给「看实时输出」
  const [progressAt, setProgressAt] = useState(() => Date.now());
  useEffect(() => {
    setProgressAt(Date.now());
  }, [messages.length, liveReply, liveThinking, activity?.startedAt, thinking, statusLine]);
  const quiet = generating && Date.now() - progressAt >= QUIET_HINT_MS;
  const extraHint = approvalExtraHint(agentId, hooksEnabled);
  const liveReplyCapable = liveReplySupported(agentId ?? "");
  // 聊天层接不住、要去终端的那一下记个数（chat-handoff-log.ts），排聊天层下一步补什么
  const noteHandoff = (reason: HandoffReason, detail?: string) =>
    recordChatHandoff(agentId, reason, detail);
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
      grokLoginStuck ||
      menuPrompt ||
      tuiPanel
    )
      return [];
    let lastUser = -1;
    let prevUser = -1;
    messages.forEach((m, i) => {
      if (m.role === "user" && m.blocks.some((b) => b.kind === "text")) {
        prevUser = lastUser;
        lastUser = i;
      }
    });
    const replyText = (from: number, to: number) =>
      messages
        .slice(from, to)
        .filter((m) => m.role !== "user")
        .flatMap((m) => m.blocks.filter((b) => b.kind === "text").map((b) => b.text))
        .join("\n");
    const synced = replyText(lastUser + 1, messages.length);
    // 分几段的提问（带项目说明的第一句）在终端里隔着空行回显，读屏只认得第一段：其余几段不当回复
    const asked =
      lastUser >= 0
        ? messages[lastUser].blocks
            .filter((b) => b.kind === "text")
            .map((b) => b.text)
            .join("\n")
        : "";
    const live = dropAskedEcho(liveReply, asked);
    // 读到的整段都是上一轮已经画出来的回复：读屏在新回显画出来之前读到了上一轮（隔一会再发、两句一样时），不当这一轮的预览。
    // 只在整段都对得上时才拦，新回复里碰巧有一行与上一轮相同不受影响（2026-10-27 用户截图；读屏侧的拦法见 live-reply.ts staleEcho）
    if (lastUser >= 0 && sameAsPrevReply(live, replyText(prevUser + 1, lastUser))) return [];
    return unsyncedTail(live, synced);
  })();
  // 终端里正在想（Grok 的思考框）：正文出来前照终端原样显示在实时预览的位置，竖线、「◆ Thinking…」、折叠的「…」已在读屏时去掉
  // （2026-10-26 用户：就要原生的思考显示，只把无关的去掉）；正文一出来就让位
  const thinkingPreview =
    livePreview.length === 0 &&
    generating &&
    liveThinking &&
    attention !== "confirm" &&
    !trustPrompt &&
    !connIssue &&
    !menuPrompt &&
    !tuiPanel
      ? liveThinking
      : "";
  // 实时预览多出一行：贴着底的就当帧跟到底。原先只在消息列表变化时贴底（生成中 700ms 一次的轮询），新出的那一行先落在
  // 底部留白和渐隐里，等下一次轮询整段才往上跳一行，看着像那一行在原位闪一下才出新内容（2026-10-22 用户 Claude 长回复）
  // 一块一块到的预览匀速放出来（text-reveal.ts）：到一块贴一块看着一顿一顿的；不在生成了一次放完
  const livePreviewText = useRevealedText(livePreview.length > 0 ? livePreview.join("\n") : thinkingPreview, generating);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && followRef.current && livePreviewText) el.scrollTop = el.scrollHeight;
  }, [livePreviewText]);
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
  // CLI 比 Mesa 核对过的新（cli-verified.ts）：卡上的选项是读屏认出来的，画面变了可能按不准，提醒一句
  const cliNewer = useCliNewer(agentId);
  const channelChoices = channelApproval ? approvalChoices(channelApproval, agentId ?? null) : [];
  // 终端菜单的选项比旁路能回的多（Qwen 只收允许 / 拒绝）：让给下面照终端原文的菜单卡，命令原文照样画在卡上
  const menuOutgrows = Boolean(
    menuPrompt && !menuPrompt.ask && menuOutgrowsChannel(channel ?? null, agentId ?? null, menuPrompt.options.length),
  );
  // 计划模式写完方案、问要不要开工（plan-approval.ts，Claude / CodeBuddy / Gemini / Kimi）：卡上整篇方案 + 按方案开工 / 接着改方案
  const planMenu = isPlanMenu(menuPrompt ?? null, channelApproval?.toolName) ? menuPrompt! : null;
  const planChoices = planMenu ? planMenu.options.map((o, i) => planChoice(o, i)) : [];
  const planRevise = planChoices.find((c) => c.kind === "revise") ?? null;
  const revisePlan = (feedback: string) =>
    planRevise && onAnswerMenu?.(planRevise.index, { text: feedback, openFirst: planRevise.openFirst });
  function planDecision(menu: TuiMenu): ChatDecision {
    // 方案原文：旁路（Claude hooks）> 会话文件里写方案文件 / 结束计划的那次调用 > 屏上读得到的那一截
    const known = channelApproval?.plan ?? latestPlanText(messages);
    const text = known ?? menu.plan?.text ?? null;
    const file = channelApproval?.toolName === "ExitPlanMode" ? channelApproval.path : null;
    const pick = (c: { index: number; kind: string; tier: PermissionTierId | null }) => () =>
      onAnswerMenu?.(c.index, {
        // 开工 / 结束计划模式：键真按下去了，这段对话就不再是只讨论
        onDone:
          c.kind === "go" || c.kind === "leave"
            ? () => onPlanLeft?.(c.tier === "discuss" ? null : c.tier)
            : undefined,
      });
    return {
      key: `plan:${menu.options.join("|")}`,
      title: planMenuTitle(menu, Boolean(text)),
      hint: planStartBlocked
        ? "这是只讨论的目标 / 想法，这里不开工：要动手回项目页点「开工」，或把目标改成要验收的，在那边做"
        : cliNewer
        ? "这版 CLI Mesa 还没核对过：选项按终端原文认，按不对就点「露出终端」在终端里选"
        : "开工后这段对话接着按选的那一档走，不用重开；也可以在终端里答，哪边先答算哪边",
      options: [],
      plan: {
        text,
        fromScreen: !known && Boolean(text),
        path: file ? (file.split(/[\\/]/).pop() ?? file) : null,
        cwd,
        // 只讨论的目标 / 想法：开工、结束计划模式都不给（没有验收环，开工就直接改项目文件）
        go: planCardChoices(planChoices, planStartBlocked).go
          .map((c) => ({
            label: c.label,
            description: c.description,
            primary: c.index === menu.selected,
            title: `在终端菜单里选「${c.original}」`,
            onClick: pick(c),
          })),
        others: planCardChoices(planChoices, planStartBlocked).others
          .map((c) => ({ label: c.label, title: `${c.description}（终端里的「${c.original}」）`, onClick: pick(c) })),
        onRevise: planRevise
          ? (feedback) => {
              const t = planFeedbackText(feedback);
              if (t) revisePlan(t);
            }
          : null,
      },
    };
  }
  // 「终端在等你」通用卡（terminal-wait.ts）：认不出的确认、卡住、选择器开着、启动后停在没有输入框的画面上。
  // 原先这几种都自动弹出底部终端，2026-10-27 用户拍板改成卡片，去终端只在卡上由人点
  const waitReason: HandoffReason | null = !waitScreen || !running
    ? null
    : attention === "confirm" && confirmAged
      ? confirmHandoffReason(confirmHandoffEvent(agentId, hooksEnabled))
      : pickerOpen
        ? "picker"
        : stuckWaiting || (ptyQuiet && waitScreen.noInputBox)
          ? "stuck_start"
          : null;
  function waitDecision(screen: WaitScreen, detail?: string | null): ChatDecision {
    return {
      key: `wait:${screen.title}`,
      title: screen.title ? `终端在等你：${screen.title}` : `${agentLabel(agentId)} 在终端里等你处理`,
      detail: detail ?? null,
      hint: cliNewer
        ? "这版 CLI Mesa 还没核对过，下面是终端原文；按键直接发给终端，处理完卡片自己收起"
        : "Mesa 认不出这一步，下面是终端原文；按键直接发给终端，处理完卡片自己收起",
      options: [],
      screen: {
        lines: screen.lines,
        live: true,
        numbered: screen.numbered,
        links: screen.links,
        typeIn: screen.typeIn,
        keys: true,
        // Grok 非 prompt 态 Esc 会触发整进程退出确认（escInterruptSafe）
        esc: escInterruptSafe(agentId),
        onKey: (k) => onWaitKey?.(k),
        onOpenLink: (url) => onOpenLink?.(url),
      },
    };
  }
  // 一启动就退出、还没接上会话：退出码与终端最后几行（不再只在终端里留一行红字）
  const failureDecision: ChatDecision | null =
    launchFailure && !running
      ? {
          key: `launch-failed:${launchFailure.code}:${launchFailure.lines.join("\n")}`,
          title: `${agentLabel(agentId)} 没能启动`,
          detail: `它一启动就退出了${launchFailure.code > 0 ? `（退出码 ${launchFailure.code}）` : ""}。终端里的最后几行：`,
          hint: launchFailureHint(launchFailure.lines, launchFailure.code),
          options: [
            ...(onDismissLaunchFailure ? [{ label: "知道了", onClick: onDismissLaunchFailure }] : []),
            ...(onLaunchAgain ? [{ label: "重新启动", primary: true, onClick: onLaunchAgain }] : []),
          ],
          screen: {
            lines: launchFailure.lines,
            live: false,
            numbered: 0,
            links: [],
            typeIn: false,
            keys: false,
            esc: false,
            onKey: () => {},
            onOpenLink: (url) => onOpenLink?.(url),
          },
        }
      : null;
  // Gemini 还没选认证方式：启动前就拦下了，卡上一键只改认证方式（先备份）再启动（2026-10-27 用户拍板）
  const blockDecision: ChatDecision | null =
    launchBlock?.kind === "gemini-auth" && !running
      ? {
          key: "launch-block:gemini-auth",
          title: "Gemini 还要设一下认证方式",
          detail: launchBlock.message,
          hint: "只改 ~/.gemini/settings.json 里认证方式这一项，改之前先备份，在连接页「恢复备份」能改回去；密钥照旧只在启动时交给它，不存进钥匙串",
          options: [
            ...(onDismissLaunchBlock ? [{ label: "先不用", onClick: onDismissLaunchBlock }] : []),
            ...(onFixGeminiAuth
              ? [{ label: "设成 API Key 并启动", primary: true, title: "改 ~/.gemini/settings.json 的认证方式（先备份），然后启动 Gemini", onClick: onFixGeminiAuth }]
              : []),
          ],
        }
      : null;
  // 认得出的首次启动屏：Gemini 要把密钥存进钥匙串、Cursor 要先登录
  const specialDecision: ChatDecision | null =
    !running || !specialScreen
      ? null
      : specialScreen.kind === "gemini-key-store"
        ? {
            key: "special:gemini-key-store",
            title: "Gemini 要把密钥存进系统钥匙串",
            detail:
              "Gemini 在问你要不要把这条连接的密钥存进系统钥匙串。Mesa 平时只在启动时把密钥交给它、不另外存；继续的话，以后在终端里单独运行 Gemini 也会用这把密钥。",
            hint: "不想存就点「取消」，再到连接页把这条连接「设为全局默认」：Gemini 改成直接用 Mesa 启动时交给它的密钥",
            options: [
              { label: "取消", title: "往终端按 Esc", onClick: () => onWaitKey?.("esc") },
              { label: "存进钥匙串并继续", primary: true, title: "往终端按回车", onClick: () => onWaitKey?.("enter") },
            ],
          }
        : {
            key: `special:cursor-login:${specialScreen.url ?? ""}`,
            title: "Cursor 要先登录",
            detail: specialScreen.url
              ? "已经给出登录链接：在浏览器里登录 Cursor 账号，登录好这张卡会自己收起。"
              : "Cursor CLI 只用 Cursor 自己的账号，第一次要在浏览器里登录一次。",
            hint: "也可以到「连接」页用官方账号登录 Cursor",
            options: [
              ...(onOpenProfiles ? [{ label: "去连接页", onClick: onOpenProfiles }] : []),
              specialScreen.url
                ? { label: "在浏览器打开登录页", primary: true, title: specialScreen.url, onClick: () => onOpenLink?.(specialScreen.url!) }
                : { label: "去浏览器登录", primary: true, title: "往终端按回车，Cursor 会打开浏览器", onClick: () => onWaitKey?.("enter") },
            ],
          };
  const decision: ChatDecision | null =
    failureDecision
      ? failureDecision
      : blockDecision
      ? blockDecision
      : specialDecision
      ? specialDecision
      : // 方案确认排在旁路审批前：Qwen 的结束计划旁路只给「允许 / 拒绝」，屏上那张有几种开工法
    planMenu && !trustPrompt
      ? planDecision(planMenu)
      : channelApproval && channelChoices.length && !trustPrompt && !menuOutgrows
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
      : isQuestionApproval(channelApproval) && !menuPrompt && !trustPrompt
      ? {
          key: `question:${channelApproval?.requestId ?? ""}`,
          title: `${agentLabel(agentId)} 在等你回答`,
          hint: "请在终端完成这份提问；回答后会自动继续同步",
          preview,
          options: [],
        }
      : attention === "confirm" && !menuPrompt && !trustPrompt && waitScreen
      ? // 宽限里先不出卡（菜单多半马上认出来），过了还认不出才出通用卡
        confirmAged
        ? waitDecision(waitScreen, confirmDetail ?? channelApproval?.detail ?? null)
        : null
      : attention === "confirm" && !menuPrompt && !trustPrompt
      ? {
          key: `approval:${confirmDetail ?? ""}`,
          title: channelApproval ? approvalTitle(channelApproval, agentLabel(agentId)) : `${agentLabel(agentId)} 在等你确认`,
          // 程序状态旁路（Grok）没有 hooks 日志，卡上写它自己报的那一句（「写一个探针文件」）
          detail: confirmDetail ?? channelApproval?.detail ?? "终端里有待处理的批准、登录或菜单选择",
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
        : grokLoginStuck
          ? grokLoginDecision({
              onLogout: () => onGrokLogout?.(),
              onDismiss: () => onDismissGrokLogin?.(),
            })
        : menuPrompt?.ask
          ? {
              // Claude 的提问表单（AskUserQuestion，tui-ask.ts）：卡片照表单画，答法按表单的键走
              key: `ask:${menuPrompt.ask.kind === "question" ? menuPrompt.ask.question : "review"}`,
              title: menuPrompt.question ?? "Claude 在问你",
              options: [],
              ask: {
                form: menuPrompt.ask,
                pending: Boolean(menuPrompt.pending),
                onAction: (action) => onAnswerAsk?.(action),
              },
            }
        : menuPrompt
          ? {
              key: `menu:${menuPrompt.question ?? ""}:${menuPrompt.options.join("|")}`,
              title: menuPrompt.question ?? "终端里在等你选一项",
              detail: menuPrompt.detail,
              // 审批菜单：旁路给了要做的事（命令 / 差异）就画在卡上，选项仍照终端原文
              preview: channel?.turn?.status === "awaiting_approval" ? preview : null,
              hint: cliNewer
                ? "这版 CLI Mesa 还没核对过：选项照终端原文，按不对就点「露出终端」在终端里选"
                : "选项照终端原文；高亮的是终端当前默认的那一项",
              // 不替用户选：把 CLI 的选项原样摆出来（tui-menu.ts）
              options: menuPrompt.options.map((opt, i) => ({
                label: opt,
                primary: i === menuPrompt.selected,
                title: `在终端菜单里选「${opt}」`,
                onClick: () => onAnswerMenu?.(i),
              })),
            }
          : tuiNotice
            ? {
                // Claude 一轮中途弹的通知（2026-10-21：经第三方网关时 auto mode 分类器计费说明），按回车前这一轮停着；
                // 原先被当成面板、按钮是 Esc（按了是取消）
                key: `tui-notice:${tuiNotice.join("\n")}`,
                title: "终端里弹了一条提示，按回车才会接着做",
                detail: tuiNotice.join("\n"),
                hint: "提示原文照终端显示；只是说明，回车继续不改任何设置",
                options: [{ label: "继续", primary: true, title: "往终端按回车", onClick: () => onApprovalKey?.("enter") }],
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
            : waitReason && waitScreen
              ? waitDecision(waitScreen)
              : null;
  // 出了新问题就滚到底：卡片贴着输入框，不能藏在视口外
  const decisionKey = decision?.key ?? null;
  // 通用卡 = 聊天层没接住的一次（设置「诊断」里的计数，排下一步该补什么）：同一张卡只记一次
  const waitCardKey = decision?.screen?.live ? decisionKey : null;
  useEffect(() => {
    if (waitCardKey && waitReason) recordChatHandoff(agentId, waitReason);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitCardKey]);
  useEffect(() => {
    if (decisionKey) requestAnimationFrame(scrollBottom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decisionKey]);

  async function sendFromComposer(text: string): Promise<string | null> {
    // Claude 的提问表单开着时，输入框里写的就是答案：写进表单「自己写」那一行再交（直接打进终端的话，
    // 回车会选中光标停着的那一项）。确认页没有地方写字，让人先在卡片上提交或取消
    // 方案确认开着时，输入框里写的是对方案的意见：写进「Tell Claude what to change」那一行再交（直接打进终端，
    // 回车会选中高亮的「开工」那一项）
    if (planRevise && onAnswerMenu) {
      const t = planFeedbackText(text);
      if (!t) return "写下要改哪里";
      revisePlan(t);
      return null;
    }
    const ask = menuPrompt?.ask;
    if (ask && onAnswerAsk) {
      if (menuPrompt?.pending) return "上一步还在交给终端，稍等一下再发";
      if (ask.kind === "review") return "先在上面点「提交回答」或「整组不答」";
      onAnswerAsk({ kind: "text", text, submit: true });
      return null;
    }
    // 从聊天层开聊：记下这套搭配，下次在这个项目里点一下就能换回来（launch-combos.ts）
    if (launchPickOpen && launchPick && cwd && launchPick.profileId) {
      recordCombo(
        resolveChatCwd(cwd, homeDir),
        {
          agentId: launchPick.agentId,
          profileId: launchPick.profileId,
          model: launchPick.model.trim(),
          effort: launchPick.effort,
        },
        IS_WINDOWS,
      );
    }
    const event = slashHandoff(text, modelSwitch?.kind ?? null);
    if (event === "picker_model") openPicker();
    return onSend(text);
  }

  // 生成中又发一句：这家 CLI 怎么处理（下一步就交 / 这一轮说完再交）、怎么「立即发送」（2026-10-22 逐家实测）
  const midTurn = midTurnSpec(agentId, { csiU: runtime?.submitCsiU ?? false });
  const sendNow = running && generating && onSendNow ? midTurn.sendNow : null;
  // 点过「立即发送」的那一轮不再给钮（那句还要等会话文件记下才从「排队」变正式，期间别让人连点）
  const [sentNowAt, setSentNowAt] = useState<number | null>(null);
  useEffect(() => {
    if (!generating) setSentNowAt(null);
  }, [generating]);
  function pressSendNow() {
    if (!sendNow) return;
    setSentNowAt(Date.now());
    onSendNow?.(sendNow.keys);
  }
  const note = queuedNote(midTurn);

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
  const recallHistory = useMemo(() => userTextHistory(messages), [messages]);

  // 项目表（项目芯片弹层、权限菜单拿哪件事举例、「最近用过」标题里的项目名都要）
  const projectsVersion = useAppStore((s) => s.projectsVersion);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  useEffect(() => {
    let cancelled = false;
    invoke<ProjectDto[]>("list_projects")
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectsVersion]);
  const chatDir = resolveChatCwd(cwd, homeDir);
  const workContext = starterContextFor(chatDir, projects, IS_WINDOWS);
  const cwdLabel = cwd
    ? cwdChipLabel({ cwd, home: homeDir, projectPaths, recentRepos, isWindows: IS_WINDOWS })
    : "";

  // 权限写在输入框身上：切到完全访问时上沿细线亮一下、只讨论虚线框（其余档不加东西）
  const launchAgentLabel = AGENTS.find((a) => a.id === launchPick?.agentId)?.label ?? "这家 CLI";
  const permTier =
    launchPick && !readOnly
      ? effectivePermissionTier(launchPick.permission, launchPick.permissionMode, launchPick.permissionNote)
      : null;
  const composerTone = permTier === "full" ? "full" : permTier === "discuss" || readOnly ? "discuss" : null;
  // 权限字平时灰；人亲手切到完全访问时与输入框上沿细线同一下亮 caution（2026-10-23 用户）。
  // 只认人换档：切换对话、刚打开时档位读进来都不亮（2026-10-25 用户：每切一段对话都亮很难看）
  const [fullPickSeq, setFullPickSeq] = useState(0);
  const toneFlash = useFlashOnSeq(fullPickSeq);
  const pickPermission = onPickLaunch
    ? (permission: "discuss" | "write_tree", mode?: NativePermissionMode | null) => {
        onPickLaunch.permission(permission, mode);
        if (permission === "write_tree" && mode === "full" && permTier !== "full") setFullPickSeq((n) => n + 1);
      }
    : undefined;
  // ⇧Tab 轮换权限：只在开聊前（开聊后换档要重开，留给菜单里那条确认）
  async function cyclePermission() {
    if (!launchPick || !pickPermission) return;
    const next = nextPermissionTier(permTier, (id) =>
      id === "discuss" ? launchPick.readonlySupported : launchPick.permissionModes.includes(id),
    );
    if (!next) return;
    if (next === "full" && !(await confirmPermissionChoice(launchAgentLabel, "full", false))) return;
    if (next === "discuss") pickPermission("discuss", null);
    else pickPermission("write_tree", next);
  }

  // 输入框里有图、当前模型确知看不了图：附件下面说一句（模型能力库，ChatModelMenu 查）
  const [imageKind, setImageKind] = useState<"plain" | "marks" | null>(null);
  const [imageWarning, setImageWarning] = useState<string | null>(null);

  // 「最近在这个项目用过」的搭配：连接已删的不列
  const storeProfiles = useAppStore((s) => s.profiles);
  const combos = useMemo(
    () =>
      launchPickOpen && chatDir
        ? readCombos(chatDir, IS_WINDOWS).filter((c) =>
            storeProfiles.some((p) => p.id === c.profileId && p.agent === c.agentId),
          )
        : [],
    // launchPick 变了（刚开过聊、换了项目）重新读
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [launchPickOpen, chatDir, storeProfiles, launchPick?.agentId, launchPick?.profileId],
  );
  const contextUsed = lastContextTokens(messages);

  // 输入框下面那一行（2026-10-23 用户：照 Claude 客户端那样简洁）：框里只留 + 和发送，
  // 左边「权限 · 项目」、右边「模型 · 思考」挪到框外；居中空态时紧贴输入框，开聊后挂进底部状态栏同一行
  const metaSlotted = !emptyLayout && Boolean(metaSlots?.left && metaSlots?.right);
  const metaLeft = (
    <>
      {/* 权限：开聊前可选，开聊后换 = 重开接回；只读分叉另有「只读分叉」标签，不重复。
          平时灰字，切到完全访问时与输入框上沿细线同一下亮 caution（flash） */}
      {launchPick && !readOnly && (launchPickOpen || resumePickOpen || running || canResume) && (
        <ChatPermissionBadge
          agentLabel={launchAgentLabel}
          agentId={launchPick.agentId}
          context={workContext}
          cycleHint={launchPickOpen || resumePickOpen}
          permission={launchPick.permission}
          mode={launchPick.permissionMode}
          modes={launchPick.permissionModes}
          readonlySupported={launchPick.readonlySupported}
          note={launchPick.permissionNote}
          // 开聊前、只看没接、或 Agent 停了还能接着聊：改的是下次启动的参数；运行中：换 = 重开接回
          editable={launchPickOpen || resumePickOpen || (!running && canResume)}
          onPermission={pickPermission}
          live={running && onRestartPermission ? { busy: generating, onRestart: onRestartPermission } : null}
          flash={toneFlash}
        />
      )}
      {/* 项目芯片（2026-10-17 用户：「将在 ~ 开始」应该是选项目；2026-10-22 换成与权限、模型同一族的弹层）：
          能搜、带项目类型与项目默认；开聊后目录不能再换，不显示（开聊后状态栏自己写项目名 / 分支）。
          换了目录，空态「最近的对话」随之列那个文件夹的 */}
      {cwd && launchPick?.editable && !running && messages.length === 0 && (
        <ChatProjectPicker
          cwd={cwd}
          homeDir={homeDir}
          label={cwdLabel}
          projects={projects}
          recentRepos={recentRepos ?? []}
          isWindows={IS_WINDOWS}
          onPick={(pick) => onPickDir?.(pick)}
          onChooseFolder={() => onChooseCwd?.()}
          onNewProject={onNewProject}
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
  );
  // 「测试版」收进模型菜单底部一行（2026-10-23）：点进去说这一家在聊天里能做到哪一步、哪些要回终端
  const openTerminalFromBeta = () => {
    noteHandoff("user_switch", "beta");
    onOpenTerminal();
  };
  // 「模型 · 思考」菜单：开聊前、运行中、停了可接着聊同一个菜单（ChatModelMenu）
  const metaRight =
    (launchPickOpen || resumePickOpen) && onPickLaunch ? (
      <>
        {/* 刚选的项目设了对话默认，Agent 跟着换了：说一声（几秒后自己消失） */}
        {launchPick?.autoNote && (
          <span className="shrink-0 animate-pulse-brief text-micro text-l4">{launchPick.autoNote}</span>
        )}
        <ChatModelMenu
          kind="launch"
          pick={launchPick!}
          onAgent={onPickLaunch.agent}
          onProfile={onPickLaunch.profile}
          onModel={onPickLaunch.model}
          onEffort={onPickLaunch.effort}
          onPermission={pickPermission ?? onPickLaunch.permission}
          combos={combos}
          combosWhere={cwdLabel || null}
          onCombo={onPickLaunch.combo}
          imageKind={imageKind}
          onImageWarning={setImageWarning}
          onOpenTerminal={openTerminalFromBeta}
        />
      </>
    ) : (running || canResume) && runtime && onTuiCommand ? (
      <ChatModelMenu
        kind="runtime"
        channel={channel}
        live={running}
        status={runtime.status}
        profileModels={runtime.profileModels}
        modelSwitch={modelSwitch ?? null}
        effort={runtime.effort}
        submitCsiU={runtime.submitCsiU}
        onTuiCommand={onTuiCommand}
        onPicker={openPicker}
        contextUsed={contextUsed}
        // 挂进状态栏时圆环由状态栏画（它有本段用量与连接名，悬停一起说）
        showRing={!metaSlotted}
        onCompact={mesaCommands.find((c) => c.cmd === "/compact")?.run ?? null}
        onRelaunch={runtime.onRelaunch}
        imageKind={imageKind}
        onImageWarning={setImageWarning}
        onOpenTerminal={openTerminalFromBeta}
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
    ) : null;

  return (
    <div
      ref={rootRef}
      data-chat-drop="1"
      className="relative flex h-full min-h-0 w-full flex-col bg-canvas"
    >
      {searchOpen && <ChatSearch messages={messages} request={searchRequest} hasOlder={hasOlder} loadingOlder={loadingOlder}
        onLoadOlder={onLoadOlder ? () => { followRef.current = false; void loadOlder(); } : undefined}
        onFocus={focusMessage}
        onClose={() => { setSearchOpen(false); setFocus(null); setComposerFocus((value) => value + 1); }} />}
      {dropHover && (
        <div className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-lg border-2 border-dashed border-mesa-amber/60 bg-canvas/80">
          <p className="text-sm text-l2">松开，添加到消息里</p>
        </div>
      )}
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
          // 滚动条「闲置淡出」：滚动期间打标，停 0.9s 摘掉（样式见 App.css .ccode-chat-scroll）
          el.dataset.scrolling = "1";
          if (scrollFadeTimer.current) clearTimeout(scrollFadeTimer.current);
          scrollFadeTimer.current = setTimeout(() => {
            delete el.dataset.scrolling;
          }, 900);
          const atBottom = nearBottom(el);
          // 跟着底时只有往上挪了才算人要离开：贴底之后内容又在上方长高（整段记录接上、窗口换段）也会发一次滚动事件，
          // 那时离底远了但位置没往上走，照旧跟底——原先这一下就断了跟底，画面停在中间一帧再跳回底（2026-10-26 实测）
          followRef.current = atBottom || (followRef.current && el.scrollTop >= lastScrollTopRef.current - 1);
          lastScrollTopRef.current = el.scrollTop;
          setAwayFromBottom(farFromBottom(el));
          if (atBottom) setHasNew(false);
        }}
        // 浏览器自带的滚动锚定关掉，由 useReadingAnchor 一家做（两家叠着会补两遍）
        className={
          emptyLayout
            ? "min-h-0 flex-[0.75_1_0]"
            : "ccode-chat-scroll relative min-h-0 flex-1 overflow-auto [overflow-anchor:none]"
        }
      >
        {/* 栏宽跟聊天字号走（App.css .ccode-chat-column，回答一行约 52 字），与输入框、底部状态栏同一条中轴：
            外层 px-4、内层不再加内边距，和 ChatComposer 同构——正文左缘、气泡右缘与输入框两边对齐（2026-10-25） */}
        <div className="flex min-h-full flex-col px-4">
        <div className="ccode-chat-column mx-auto flex w-full flex-1 flex-col pb-6 pt-8">
          {emptyLayout && (
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
            stuckWaiting && !decision ? (
              <div className="flex flex-1 flex-col items-center justify-center pb-20 text-center">
                <p className="max-w-md text-sm text-warn-text">
                  {CHAT_NO_SESSION_TEXT}
                  ——信任此目录 / 登录 / 菜单选择通常在终端里
                </p>
                <div className="mt-3 flex items-center gap-2">
                  {onTogglePeek && (
                    <button
                      type="button"
                      onClick={() => {
                        if (!peek) noteHandoff("user_stuck", "peek");
                        onTogglePeek();
                      }}
                      className="rounded-md border border-field bg-raised px-3 py-1.5 text-xs text-l2 hover:bg-inset hover:text-l1"
                    >
                      {peek ? "终端已露出" : "露出终端"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      noteHandoff("user_stuck", "open");
                      onOpenTerminal();
                    }}
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
            // 点对话里的图 = 接着改：放进输入框、展开看图标注台（ChatMarkdown ChatImageEditContext）
            <ChatImageEditContext.Provider value={editImage}>
            <ConversationView
              messages={shownMessages}
              cwd={cwd}
              focusIndex={focusIndex < 0 ? -1 : focusIndex - firstShown}
              focusKeywords={focus ? [focus.query] : undefined}
              focusRequest={focus?.seq ?? 0}
              working={generating || settling}
              awaiting={attention === "confirm" || channel?.turn?.status === "awaiting_approval"}
              // 消息里整行的图片 / 文档路径还原成附件卡，不当文字塞回输入框
              onEditResend={(text) => {
                const split = splitImagePaths(text);
                const docs = splitDocPaths(split.text);
                setSeedInsert({ text: docs.text, paths: [...split.images, ...docs.docs] });
              }}
              onForkHere={onForkFrom}
              onQuote={(quote) => setSeedInsert({ text: "", paths: [], quote })}
              queuedNote={{
                ...note,
                text: sentNowAt ? "已叫它马上处理" : note.text,
                action:
                  sendNow && !sentNowAt
                    ? { label: sendNow.label, title: sendNow.title, onClick: pressSendNow }
                    : null,
              }}
            />
            </ChatImageEditContext.Provider>
          )}
          {(livePreview.length > 0 || thinkingPreview) && (
            // 与助手正文同一栏、同字号，但不走 Markdown（终端里已渲染过）：灰一级表示「还在写、以落盘为准」。
            // 还在写时 Mesa 光标接在最后一个字后面，不另起一行写状态（2026-10-21）
            // 字号行高与落盘后的回答同一档（.ccode-chat-body），落盘那一下不跳。
            // 显示的是终端里的思考（Grok 思考框、Kimi「thinking…」下的两行）时换成别家思考展开后的样子（ConversationView 过程「思考」行的正文）：
            // 过程行那一档字号（.ccode-chat-meta）、左边一条细线，与正文分开（2026-10-26 用户：思考和正文区分不开）
            <div
              className={`mb-2 whitespace-pre-wrap break-words text-l3 ${
                livePreview.length > 0 ? "ccode-chat-body" : "ccode-chat-meta border-l border-hairline pl-3 leading-relaxed"
              }`}
            >
              {livePreviewText}
              {generating && !decision && <MesaCaret light={isLightTheme(theme)} />}
            </div>
          )}
          {running && !connIssue && channel?.retry && (
            <p role="status" className="mb-2 text-xs text-caution-text">{channel.retry}</p>
          )}
          {running && !generating && !connIssue && channelOutcome(channel) && (
            <p role="status" className="mb-2 text-xs text-caution-text">{channelOutcome(channel)}</p>
          )}
          {running && channel?.connection === "disconnected" && (
            <p role="status" className="mb-2 text-xs text-caution-text">{channelSourceNote(channel)}</p>
          )}
          {firstRunNote && (firstRunNote.theme || firstRunNote.security) && <FirstRunLine note={firstRunNote} agent={agentLabel(agentId)} />}
          {decision && (
            <ChatDecisionCard
              decision={decision}
              onOpenTerminal={() => {
                noteHandoff("user_decision", decisionKind(decision.key));
                onOpenTerminal();
              }}
              onPeek={
                onTogglePeek && !peek
                  ? () => {
                      noteHandoff("user_decision", decisionKind(decision.key));
                      onTogglePeek();
                    }
                  : undefined
              }
            />
          )}
          {generating && !decision && !channel?.retry && livePreview.length === 0 && !thinkingPreview && (
            // 生成中那一行（2026-10-21 用户：「正在生成回复」「正在用」太机械）：M▁ 后面说这一轮在做的事——
            // 正在跑的工具（「运行 npm test」）、计划里在做的一项、思考的小标题，都没有才写「思考中」；
            // 过程里已经有那一行在动时只留光标。2026-10-26 起光标按阶段动（在想呼吸、干活伸缩、等你确认常亮），
            // 一道光带连着扫过 M 和字（等你确认时不扫）。满 10 秒才写时间，Claude 没有逐字预览时写已生成的 token 数，
            // 安静满 10 秒才给「看实时输出」。预览在出字时这一行不出现，光标接在预览末尾
            <div className="mb-2 flex min-w-0 items-center gap-2 text-xs text-l3">
              <MesaStatusLead text={statusText} motion={statusMotion} sweep={!trustPrompt} />
              {genElapsed >= 10 && (
                <span className="shrink-0 tabular-nums text-l4" aria-hidden="true">
                  {fmtElapsed(genElapsed)}
                </span>
              )}
              {liveTokens !== null && liveTokens > 0 && (
                <span className="shrink-0 tabular-nums text-l4" title="终端转圈行里这一轮已经收到的 token 数">
                  已生成 {fmtTokens(liveTokens)} token
                </span>
              )}
              {/* 聊天层按会话文件同步，一段写完才落盘；有实时预览的家不给（2026-10-17 用户：点开终端比聊天层先显示，体验不好），
                  别家安静满 10 秒才给 */}
              {onTogglePeek && !peek && !liveReplyCapable && quiet && (
                <button
                  type="button"
                  onClick={() => {
                    noteHandoff("user_live");
                    onTogglePeek();
                  }}
                  className="shrink-0 rounded-sm px-1 text-l4 underline decoration-dotted underline-offset-2 hover:text-l2"
                >
                  看实时输出
                </button>
              )}
            </div>
          )}
        </div>
        </div>
        {!emptyLayout && (
          // 对话流底部渐隐（2026-10-22 配色）：字滚到输入框上方时淡进画布，不是一刀切；负边距不占高度，不挡点击。
          // 挂在滚动区本身（不在内容栏里）：粘底层不能越出所在块的内容框，放在内容栏里时停在底部会落到 pb-6 留白之上、
          // 正好压在最后一行上（同日用户：「底部隐现的太多了」）。放这里停在底部时先盖住留白，只轻扫「思考中」那一行下缘；
          // 往上翻时贴边这一段淡得明显（同日用户：「渐隐更突出一点，思考中只底部一点点」；曲线见 App.css .ccode-chat-fade）。
          // 高度与内容栏 pb-6 相同（2026-10-27 用户：「思考中」遮得太多、底部每次都发糊，贴着输入框还漏一条半透明的字）：
          // 停在底部时只盖留白、不碰最后一行；往上翻时字在这 24px 里收尽，贴着输入框那一截已是实底，不再透出一条字
          <div aria-hidden="true" className="ccode-chat-fade pointer-events-none sticky bottom-0 -mt-6 h-6" />
        )}
        {!emptyLayout && (awayFromBottom || hasNew) && (
          // 回到最新（2026-10-26 用户：往上翻找内容时要有个悬浮按钮回到最新）：离底超过三分之一屏，或底下来了新内容才出现。
          // 零高粘底层挂在滚动区本身，
          // 按钮浮在可视区底边上方、和对话栏同一条中轴，不占版面（出现 / 收起不推动正文）。
          // 扁平浮层圆钮（同日四改撤掉立体珠：和全站格格不入）。
          // 三种样子：生成中 = 三枚琥珀光标随机变换队形并呼吸，鼠标移上去 / 键盘聚焦换成 ↓；
          // 不在生成、有新消息 = 「↓ 有新消息」小胶囊；只是翻上去了 = 只有 ↓ 的圆钮。
          // 生成中不写「有新消息」：一直在出字，那句话没有信息量
          <div className="pointer-events-none sticky bottom-3 z-10 h-0">
            <div className="absolute inset-x-0 bottom-0 flex justify-center">
              <button
                type="button"
                onClick={scrollBottom}
                // 光标换队时会探出内容框一点点：Chromium（WebView2）给 button 的 overflow 不是 visible，会冒出滚动条，行内写死
                style={{ overflow: "visible" }}
                aria-label={generating ? "回到最新（正在生成）" : hasNew ? "跳到最新消息" : "回到最新"}
                className={`ccode-float-surface group/jump pointer-events-auto relative flex h-8 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full border border-hairline text-l2 transition-colors hover:border-field hover:text-l1 ${
                  hasNew && !generating ? "pl-2.5 pr-3" : "w-8"
                }`}
              >
                {generating ? (
                  <>
                    {/* 生成中：三枚琥珀光标随机变换队形，带呼吸（MesaThinkingDots / App.css .ccode-jump-dots） */}
                    <MesaThinkingDots className="absolute inset-0 transition-opacity group-hover/jump:opacity-0 group-focus-visible/jump:opacity-0" />
                    <span className="relative flex size-3.5 items-center justify-center">
                      <ArrowDown
                        size={14}
                        strokeWidth={2}
                        aria-hidden="true"
                        className="absolute opacity-0 transition-opacity group-hover/jump:opacity-100 group-focus-visible/jump:opacity-100"
                      />
                    </span>
                  </>
                ) : (
                  <ArrowDown size={14} strokeWidth={2} aria-hidden="true" />
                )}
                {/* 字号写在内层：全站 button { font: inherit } 会吞掉按钮上的 text-*，否则跟着聊天字号变大 */}
                {hasNew && !generating && <span className="text-xs">有新消息</span>}
              </button>
            </div>
          </div>
        )}
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
        focusRequest={composerFocus}
        onLocateQuote={(quote) => {
          const index = locateChatQuote(messages, quote);
          if (index < 0) return false;
          setSearchOpen(false);
          focusMessage(index, quote.text);
          return true;
        }}
        onSeedConsumed={() => setSeedInsert(null)}
        // 占位字不带结尾的「…」（2026-10-25 用户对照 Claude 客户端：系统字体里它画成底线上的三个点，读作「...」）
        placeholder={
          decision?.ask
            ? decision.ask.form.kind === "review"
              ? "先在上面提交或取消这组回答"
              : "写你自己的答案，发出去就交这一题"
            : decision?.plan?.onRevise
            ? "要改方案就写在这里，发出去它先改方案、不开工"
            : decision
            ? "先在上面选一项，或者直接回复"
            : readOnly
            ? "这是只读分叉；可以提问、分析和规划"
            : generating && running
              ? runningPlaceholder(midTurn, null)
            : messages.length === 0
              ? "问一个问题"
              : undefined
        }
        // Claude 猜的下一句：只在它停在输入框、没有等你决定的事时给（生成中屏上那行是排队提示，不是建议）
        suggestion={running && !generating && !decision ? promptSuggestion : null}
        // 权限 · 项目 | 模型：状态栏在就挂进状态栏，否则画在框下面（metaSlots 注释）
        footer={
          metaSlotted ? null : (
            <div className="mt-1 flex h-7 min-w-0 items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-0.5">{metaLeft}</div>
              <div className="flex min-w-0 shrink items-center gap-1.5">{metaRight}</div>
            </div>
          )
        }
        running={composerShowsInterrupt({
          running,
          attention,
          pendingReply: loading,
        })}
        onInterrupt={onInterrupt}
        narrow={emptyLayout}
        cwd={cwd ?? null}
        mesaCommands={mesaCommands}
        recallHistory={recallHistory}
        tone={composerTone}
        toneFlash={toneFlash}
        onCyclePermission={
          (launchPickOpen || resumePickOpen) && launchPick && !readOnly ? () => void cyclePermission() : undefined
        }
        imageWarning={imageWarning}
        onImagesChange={setImageKind}
        onDraftChange={onDraftChange}
        onImageStageChange={setImageStageOpen}
        queueHint={queueSendHint(midTurn)}
        stopTitle={stopTitle(midTurn, agentId)}
      />
      {emptyLayout && (
        // 输入框后面同一层级渲染，切出空态时输入框不重挂载（已输入的字、焦点都在）
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-[45rem] px-4">
            <ChatEmptyStart
              cwd={cwd}
              homeDir={homeDir}
              onPickPrompt={(text) => setSeedInsert(text)}
              resumeSessionId={launchPick?.resumeSessionId ?? null}
              onRestore={onRestore}
              onPickProject={
                // 与输入框里的项目芯片同一条换目录路径；开聊后目录不能再换，不给
                launchPick?.editable && !running && onPickDir
                  ? (path) => onPickDir({ kind: "project", path })
                  : undefined
              }
              onShowScreen={onOpenTerminal}
            />
          </div>
        </div>
      )}
      {metaSlotted && metaSlots?.left && createPortal(metaLeft, metaSlots.left)}
      {metaSlotted && metaSlots?.right && createPortal(metaRight, metaSlots.right)}
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

/** 安静多久才给「看实时输出」 */
const QUIET_HINT_MS = 10_000;

/** 离底不到 56px 算贴着底部：跟着新消息走 */
function nearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 56;
}

/** 离底超过三分之一屏（至少 160px）：这时才给「回到最新」浮钮——离底一点点（看一眼上一段）自己滚回去就行，
 *  按钮冒出来反而挡字；翻过三分之一屏多半是在往回找东西了 */
function farFromBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight > Math.max(160, el.clientHeight / 3);
}

/** 1234 → 1.2k；千以下原样 */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/.0$/, "")}k` : String(n);
}

function fmtElapsed(sec: number): string {
  if (sec < 60) return `${sec} 秒`;
  return `${Math.floor(sec / 60)} 分 ${String(sec % 60).padStart(2, "0")} 秒`;
}

function agentLabel(agentId: string | null | undefined): string {
  return AGENTS.find((a) => a.id === agentId)?.label ?? "Agent";
}

/** Claude Code 第一次启动时 Mesa 替人走完的两步：一行说明，安全须知原文可展开（不替人看，只是不挡路） */
function FirstRunLine({ note, agent }: { note: FirstRunNote; agent: string }) {
  const [open, setOpen] = useState(false);
  const done = [
    note.theme ? `配色选了「${note.theme}」` : null,
    note.security ? "安全须知已确认" : null,
  ].filter(Boolean);
  return (
    <div className="mb-3 text-xs leading-5 text-l3">
      <div className="flex items-start gap-2">
        <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-done" aria-hidden="true" />
        <span>
          {agent} 第一次启动，Mesa 替你完成了：{done.join("，")}
          {note.security && (
            <>
              {" · "}
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="text-cta-pill-text underline decoration-dashed underline-offset-2 hover:text-l1"
              >
                {open ? "收起原文" : "看安全须知原文"}
              </button>
            </>
          )}
          {note.theme && <span className="text-l4">（以后可在终端里用 /theme 改）</span>}
        </span>
      </div>
      {open && note.security && (
        <pre className="ml-3.5 mt-1.5 whitespace-pre-wrap rounded-lg border border-hairline bg-inset px-3 py-2 font-mono text-xs leading-5 text-l2">
          {note.security.join("\n")}
        </pre>
      )}
    </div>
  );
}
