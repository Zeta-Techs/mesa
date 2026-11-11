// 运行页里一个标签的终端 + 聊天层 + 右栏（2026-11-07 从 TerminalPage.tsx 原样拆出；页面级的标签管理仍在 TerminalPage）
import {
  memo,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as openDirectoryDialog } from "@tauri-apps/plugin-dialog";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { useAppStore } from "../store";
import { IS_MAC, IS_WINDOWS } from "../hotkeys";
import { monoFallbackStack, terminalFontStack } from "../terminal-font";
import { sendSystemNotification } from "../system-notification";
import { installDomScrollRowReuse } from "../terminal-row-reuse";
import { installTrackpadWheelCoalescing } from "../terminal-wheel-scroll";
import {
  dropHitsRect,
  escapeShellPath,
  firstImageItem,
  imageExtFromMime,
  joinDroppedPaths,
  KIMI_CSI_U_CTRL_V,
  KIMI_CSI_U_ENTER,
  markdownToPlain,
  pasteImageFeedback,
  armPrintableEcho,
  printableKeyFallback,
  takePrintableEcho,
  ptyShiftEnterRewrite,
  macLineEditKey,
  shouldReportTerminalColors,
  xtermOscColorReport,
} from "../terminal-input";
import { saveClipboardImage } from "../clipboard-image";
import {
  consumeHostSequences,
  consumeTerminalQueries,
  encodeKittyKey,
  keyNeedsPreventDefault,
  safeOsc8Url,
} from "../terminal-protocols";
import { hitCellRange, terminalPathHits } from "../terminal-links";
import { pasteGuardPlan } from "../paste-guard";
import type { TerminalProgress } from "../terminal-notify";
import { REPLAY_HEAD, REPLAY_TAIL, terminalReplayText } from "../terminal-replay";
import {
  hasAssistantText,
  mergeConversationPages,
  slidOutOfWindow,
  localCommandOutput,
  localCommandRecord,
  mergeLocalRecords,
  messageKey,
  pendingAfterTurn,
  placePendingUsers,
  sentUserRecorded,
  slashCommandRecorded,
  SLASH_LOCAL_SETTLE_MS,
  slashResultLines,
  slashSettledLocally,
  slashSettlesAtTurnEnd,
  READS_SESSION_TIER,
  sessionModeTier,
} from "../chat-handoff";
import { useCliNewer } from "../cli-verified";
import { AGENTS, type CustomRuntimeDto, type OfficialAccountStatusDto } from "../types";
import {
  PREFLIGHT_MAX_AGE_SECS,
  preflightBlockMessage,
  preflightFixMessage,
  preflightReviewNote,
  routeFixLabel,
  type RouteCheck,
} from "../route-check";
import { applyRouteFix, findRouteFix, setRouteAlertFromCheck } from "../route-watch";
import {
  channelAttention,
  channelCanAnswer,
  channelInfersApproval,
  channelLiveLines,
  channelRelink,
  channelTurnOpen,
  hooksApprovalAnswered,
  menuOutgrowsChannel,
  sessionSwitchNote,
  type ChatChannelSnapshot,
} from "../chat-channel";
import { resolveCustomRuntimeCwd } from "../custom-runtime";
import { pathWithin as pathWithinDialect, samePath } from "../path-utils";
import { compareRunIdentity, isTaskReuseKey, type RunIdentity } from "../run-model";
import { composeLaunchPrompt } from "../project-context";
import { composeRelayPrompt, splitRelayPrompt, type RelayOptionDto, type RelayTarget } from "../chat-relay";
import { loadProjectContextPack } from "../project-context-load";
import { normalizeWorkMode } from "../work-mode";
import { exitCodeClause, exitCodeSummary, exitToneClass } from "../exit-code";
import ChatSurface from "../components/ChatSurface";
import { confirmDialog, alertDialog } from "../components/ConfirmDialog";
import ContextMenu from "../components/ContextMenu";
import InsertMenuItems from "../components/InsertMenuItems";
import {
  detectEffortInOutput,
  detectModelInOutput,
  detectModelOnScreen,
  modelOnScreenSupported,
  outputTail,
} from "../reasoning-effort";
import { QUICK_CHAT_KEY_PREFIX, codexSandboxCoversHome } from "../quick-chat";
import {
  cachedConversationPage,
  cachedConversationRest,
  conversationPageFor,
  conversationRestFor,
  saveQuickChatChoice,
} from "../quick-chat-launch";
import { connectionModels, readModelHistory } from "../model-history";
import { modelKind } from "../model-kinds";
import TerminalStatusBar from "../components/TerminalStatusBar";
import LaunchMenu, {
  DownMenu,
  useDownMenu,
  type LaunchMenuOption,
} from "../components/LaunchMenu";
import { wireWorkspaceLaunchGuard } from "../pipeline-start";
import { projectChatLaunch } from "../project-agents";
import type { DirPick } from "../components/ChatProjectPicker";
import { skipDisconnectedOfficial } from "../resume-profile";
import { fittedPtySize } from "../terminal-resume";
import {
  allowSpawn,
  launchChromeBeforeMeasure,
  type ResizeLatch,
} from "../terminal-geometry";
import { toast } from "../toast";
import { RIGHT_DEFAULT_PX, RIGHT_MIN_PX } from "../run-layout";
import { autoTitleMilestone } from "../session-title";
import {
  menuMoveKeys,
  menuReadyToConfirm,
  parseKimiEffortPicker,
  pickerTargetIndex,
  menuEchoesText,
  parseTuiMenu,
  sameTuiMenu,
  type MenuAnswer,
  type TuiMenu,
} from "../tui-menu";
import { inSessionPermissionSwitch, kimiEffortPickLevel } from "../switch-strategy";
import { askAfter, askAnswerKeys, askFinishes, askMenu, parseClaudeAsk, type AskAction } from "../tui-ask";
import { PLAN_EXIT_TOOLS, screenPlan } from "../plan-approval";
import { promptSuggestionSupported, readPromptSuggestion } from "../prompt-suggestion";
import { italicLine, lineCells } from "../screen-cells";
import { type MesaCommand } from "../composer-assist";
import { claudeOutputTokens, claudeTurnActiveOnScreen, extractLiveReply, extractLiveThinking, liveReplySupported, mergeLiveReply, sentTextStuckInBox, staleEcho, staleWithoutEcho, terminalHasInputBox } from "../live-reply";
import { parseTuiNotice, parseTuiPanel } from "../tui-panel";
import { classifierBillingNotice, classifierNoticeAutoSkip } from "../cli-notices";
import {
  claudeFirstRunStep,
  claudeThemeLabel,
  claudeThemeTarget,
  exitTail,
  launchBlockOf,
  launchFailureHint,
  specialScreenOf,
  waitKeyBytes,
  waitScreenOf,
  type FirstRunNote,
  type LaunchBlock,
  type LaunchFailure,
  type SpecialScreen,
  type WaitKey,
  type WaitScreen,
} from "../terminal-wait";
import {
  connIssueCounts,
  connIssueText,
  detectConnIssues,
  newestConnIssue,
  type ConnIssueKind,
} from "../conn-issue";
import { askAboutText, clipNoteEntry, quoteForChat } from "../terminal-quote";
import {
  parseTrustPrompt,
  trustReadyToConfirm,
  sameTrustPrompt,
  trustAnswerKeys,
  type TrustPrompt,
} from "../trust-prompt";
import {
  isUnsafeLitProjectDir,
  suggestLitProjectDir,
} from "../lit-project";
import { XTERM_PALETTES, resolvePaletteId } from "../terminal-palettes";
import { DEFAULT_THEME_ID, isCustomThemeId, isLightTheme } from "../themes";
import {
  customXtermBgFg,
  DEFAULT_CUSTOM_THEME,
  deriveThemeTokens,
  normalizeCustomTheme,
} from "../custom-theme";
import { looksLikeModelId, modelOnProfileSwitch, officialModelAllowed } from "../model-switch";
import { isSoftwareWebGL } from "../diagnostics";
import { wantsWebglRenderer, webglLetterSpacing } from "../terminal-renderer";
import {
  ChevronDown,
  ClipboardPaste,
  MessageCircleQuestion,
  MessageSquareQuote,
  NotebookPen,
  TriangleAlert,
  Copy,
  Eye,
  FolderOpen,
  FolderPlus,
  GitFork,
  MessageSquare,
  MessagesSquare,
  PanelTopClose,
  Search,
  SlidersHorizontal,
  SquareTerminal,
  SquarePen,
  Minimize2,
  Download,
  GitCompare,
} from "lucide-react";
import {
  PERMISSION_TIERS,
  confirmPermissionChoice,
  type PermissionTier,
} from "../components/ChatPermissionBadge";
import { debounceAllows } from "../notify";
import { directoryUnavailableMessage } from "../terminal-cwd";
import {
  idleTabTitle,
  isTerminalIdle,
  welcomeCwdActionLabel,
  welcomeDirChoices,
} from "../terminal-welcome";
import {
  PTY_WORKING_SILENCE_MS,
  applyTailAttention,
  conversationTurnSettled,
  onPtyWorkingSilence,
  ptyInputLooksLikeSubmit,
  ptyOutputMarksWorking,
  shouldArmWorkingOnLaunch,
  PTY_LIVE_MS,
} from "../tab-working";
import type {
  ChatMessageDto,
  ConversationPageDto,
  ProjectDto,
  RunDto,
  SessionMetaDto,
  SkillDto,
  McpServerDto,
  ChatSendResult,
  SessionSyncState,
} from "../types";
import { watchDevicePixelRatio } from "../device-pixel-ratio";
import { pollEvery } from "../polling";
import { memoWithLatestFunctions } from "../stable-props";
import { petSpeaksInstead, readPetDnd } from "../desk-pet";

// 每个标签的聊天层 / 状态栏都在本页一起画，回调是内联闭包：换成转发到最新闭包的固定函数后，
// 别的标签实时预览出一行字不再带着这个标签的整段对话重画（stable-props.ts）
export const StableChatSurface = memoWithLatestFunctions(ChatSurface, {
  onPickLaunch: 2,
  runtime: 2,
  mesaCommands: 3,
});
export const StableTerminalStatusBar = memoWithLatestFunctions(TerminalStatusBar, { colors: 2 });

// wsLast 记忆层闸门接线（H4 修复）：buildWorkspaceTerminalRequest 是纯逻辑层、按测试
// 打包口径不直接依赖 store 模块；这里模块加载时把真实数据源接上（停用连接不被自动
// 预填、陈旧模型过名单校验）。
wireWorkspaceLaunchGuard(() => {
  const s = useAppStore.getState();
  return {
    profiles: s.profiles.map((p) => ({ id: p.id, models: p.models })),
    hiddenProfiles: s.settings?.hiddenProfiles ?? [],
    permissionModes: Object.fromEntries(s.agents.map((a) => [a.id, a.permissionModes ?? []])),
  };
});


// Monaco 体积大，首次打开文件预览时才加载
export const FilePreviewEditor = lazy(() => import("../components/FilePreviewEditor"));
// pdf.js 同样拆懒加载 chunk，首次打开 PDF 预览时才加载
export const PdfContinuousView = lazy(() => import("../components/PdfContinuousView"));
export const UnsupportedPreview = lazy(() => import("../components/UnsupportedPreview"));

/** 沉浸阅读/写笔记时把 PDF 所在文件夹加成项目（默认不挂研究流程）。取消或失败返回 null。 */
export async function offerAddLitProject(
  pdfPath: string,
  cwdHint: string | null | undefined,
): Promise<string | null> {
  const dir = suggestLitProjectDir(pdfPath, cwdHint, IS_WINDOWS);
  let home = "";
  try {
    home = await invoke<string>("home_dir");
  } catch {
    /* 家目录读不到时仍拦盘符根，拦不住家目录本身 */
  }
  if (isUnsafeLitProjectDir(dir, home, IS_WINDOWS)) {
    await alertDialog(
      "这份 PDF 还不在任何已添加的项目里。它在家目录或系统盘根下，不能把整个家目录加成项目。\n请先把文献放到一个专门的文件夹，再用项目页「添加项目」，或在那个文件夹里打开终端后再试。",
    );
    return null;
  }
  const name = dir.split(/[\\/]/).pop() || dir;
  if (
    !(await confirmDialog(
      `把「${dir}」添加为项目？\n\n沉浸阅读的笔记要写进项目文件夹，这份 PDF 还不在任何项目里。`,
      { confirmText: "添加并继续" },
    ))
  ) {
    return null;
  }
  try {
    const project = await invoke<ProjectDto>("register_project", {
      path: dir,
      name,
    });
    try {
      await invoke("set_pipeline_opt_out", {
        projectRoot: project.path,
        optOut: true,
      });
    } catch {
      /* 已添加成功：不挂流程失败不挡阅读 */
    }
    void useAppStore.getState().loadProjects();
    return project.path;
  } catch (e) {
    await alertDialog(`添加项目失败：${String(e)}`);
    return null;
  }
}
// mammoth 拆懒加载 chunk，首次打开 docx 预览时才加载
export const DocxPreview = lazy(() => import("../components/DocxPreview"));
export const XlsxPreview = lazy(() => import("../components/XlsxPreview"));
export const ImagePreview = lazy(() => import("../components/ImagePreview"));

type PtyKind = "agent" | "shell";

/** 聊天层窥视终端：底栏占主区高度的比例。必须是真实分栏（终端按此高度 fit），
    不能只裁全高 xterm 的底部——Codex 主对话是 inline，内容靠上、底下是空行，裁底就是白板。 */
export const CHAT_PEEK_RATIO = 0.32;

export function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** path 是否落在 base 内（含相等）：走 path-utils 方言层，Windows 不分大小写、认 \\?\ 前缀 */
export function pathWithin(path: string, base: string): boolean {
  return pathWithinDialect(path, base, IS_WINDOWS);
}

/** 标签页状态：由 TerminalView 上报，标签条 / 首页收件箱镜像（terminalRunInputs）/ 工作树根目录都用它 */
export interface TabStatus {
  title: string;
  /** 有存活 PTY（agent 或 shell） */
  alive: boolean;
  /** agent 正在运行（关闭前需要确认） */
  running: boolean;
  /** 当前接的是登录 shell（agent 退出回落或手动打开） */
  shell: boolean;
  agentId: string;
  profileId: string;
  model: string;
  /** 启动时注入的模型；状态栏求交用这个，不跟 CLI 内换模 */
  launchModel: string | null;
  cwd: string;
  /** 当前 PTY id（可见性门控用；无存活 PTY 时为 null） */
  ptyId: string | null;
  /** 会话尾部状态（P3c 注意力标记）；无联动/shell/已退出/未知时为 null */
  attention: "done" | "working" | "confirm" | null;
  /** shell 模式下存在可恢复的会话（空态「恢复任务」可用性） */
  canResume: boolean;
  /** 当前或最近一次关联的会话 id；只用于标签恢复元数据，不含会话文件内容。 */
  sessionId: string | null;
  /** agent 启动成功时刻（ms epoch；终端状态栏运行时长用；shell/未启动为 null） */
  startedAt: number | null;
  runId: string | null;
  /** 从 TUI 画面认出的当前思考档（含人在终端里敲 /effort 改的）；没认到为 null */
  effortSeen: string | null;
  /** 从 TUI 画面认出的当前模型（/model 回显、开场横幅；reasoning-effort.ts detectModelInOutput）；没认到为 null */
  modelSeen: string | null;
  /** 本次进程的开工弹层思考档覆盖；没有为 null */
  effortOverride: string | null;
}

/** TerminalView 暴露给父级的动作表（查找图标 / 聊天发送 / 改目录等；回调经 ref 转发，始终最新） */
export interface FocusTabActions {
  stop: () => void;
  resume: () => void;
  openConversationPage: () => void;
  search: () => void;
  modify: () => void;
  /** 运行中的「插入」在标签栏，菜单本身仍由这个终端画；anchor = 标签栏按钮外框，菜单贴它弹出 */
  toggleInsert: (anchor?: { left: number; bottom: number }) => void;
  /** 往 xterm 画面写一行浅灰日志（状态栏 Commit & Push 的回显；走终端缓冲区不经 PTY，
      运行中的 TUI 会在下一帧覆盖它——只是即时反馈，不是持久日志） */
  logLine: (text: string) => void;
  /** 状态栏目录浮层改工作目录（仅未启动时开放；cwd state 单一出处在 TerminalView） */
  setCwd: (cwd: string) => void;
  chooseCwd: () => void;
  sendMessage: (text: string) => Promise<ChatSendResult>;
  restartWritable: () => Promise<ChatSendResult>;
  /** 往当前 PTY 直接写字节（聊天层审批 y/n/Esc、生成中暂停 Esc；无存活 PTY 时静默丢弃） */
  writePty: (data: string) => void;
  /** 终端最后 maxLines 行的文字（全屏 TUI 时是可视区）：「聊天和终端对不上」反馈附上 */
  terminalText: (maxLines: number) => string;
  /** 往 PTY 写一条 TUI 命令并提交（模型/思考档直切；picker 由调用方再窥视终端） */
  writeCommand: (cmd: string) => void;
  /** 用户刚提交一轮（聊天发送 / 注入并回车）：允许随后的 PTY 输出点亮「生成中」 */
  noteUserTurn: () => void;
  /** 聊天层向前翻页（会话文件 cursor；压缩会话可能没有更早一页） */
  loadOlderConversation: (settle?: () => Promise<void>) => Promise<void>;
  /** 聊天层替用户回答启动时的「是否信任这个目录」菜单 */
  answerTrust: (accept: boolean) => void;
  /** 聊天输入框的开聊前选择（与启动栏同一写入口） */
  pickLaunchAgent: (id: string) => void;
  pickLaunchProfile: (id: string) => void;
  pickLaunchModel: (model: string) => void;
  /** 恢复占位标签接回上次的会话（同终端空态卡「恢复任务」） */
  restoreHere: () => void;
  /** 在指定位置弹出目录菜单（项目 / 随手聊 / 主目录 / 选择文件夹… / 新建项目…；聊天输入框目录芯片用） */
  openDirMenu: (x: number, y: number) => void;
  /** 开聊前换目录（聊天项目弹层 / 拖进文件夹）：选了项目且这个标签没手动换过 Agent，就带上项目的对话默认（chat 槽 > 项目默认） */
  pickDir: (pick: DirPick) => void;
  /** 「新建项目…」：去项目页建，建好回到这个标签 */
  newProject: () => void;
  /** 换配置层「换一家接着做」：选中接力目标（null = 取消）；发下一句时才交接 */
  pickRelay: (target: RelayTarget | null) => void;
  /** 打开接力那组时取：这段接力对话里已经用过哪几家、换回是接回还是建议新开 */
  loadRelayOptions: () => void;
  /** 「最近用过」的一套搭配：Agent + 连接 + 模型一起换（思考档是标签级，由父级写） */
  applyLaunchCombo: (combo: { agentId: string; profileId: string; model: string }) => void;
  /** 写一条 TUI 命令并盯屏 5 秒，CLI 弹确认菜单时上报 menuPrompt（切模型 / 思考档用） */
  runTuiCommand: (cmd: string) => void;
  /** 替用户在确认菜单里选第 index 项；带 text 时把字打进那一行再回车（方案确认的「接着改方案」，MenuAnswer） */
  answerMenu: (index: number, opts?: MenuAnswer) => void;
  /** 替用户答 Claude 的提问表单（tui-ask.ts：选一项 / 自己写 / 交这一题 / 切题 / 先不答） */
  answerAsk: (action: AskAction) => void;
  /** 运行中换权限：停下 Agent，带着新权限接回原来那段对话（权限在启动参数里，只能重开兑现） */
  restartWithPermission: () => void;
  /** 会话里直接换权限、不重开（Kimi / Codex / Qwen，switch-strategy inSessionPermissionSwitch）；false = 这家这个版本不能 */
  switchPermissionInSession: (tier: "ask" | "auto" | "full") => Promise<boolean>;
  /** 停下 Agent，带着新模型 / 思考档接回原来那段对话（会写回 CLI 全局配置的切换走这条，switch-strategy.ts） */
  relaunchWith: (patch: { model?: string; effort?: string | null }) => void;
  /** 换一条连接接着这段对话：停下 Agent，换成 profileId 那条连接（模型按新连接的名单），再按原会话接回 */
  switchConnection: (profileId: string) => void;
  /** 关掉「连接出问题」提示：此刻屏上的错误记作已看过，同一个错误不再提示，新的照常 */
  dismissConnIssue: () => void;
  /** Grok 卡在续期过期的官方登录上（grok_login.rs）：停下 Grok、grok logout、按原会话接回 */
  grokLogout: () => void;
  /** 关掉上面那条提示：这次启动不再提示 */
  dismissGrokLogin: () => void;
  /** 「终端在等你」通用卡上的一下按键（terminal-wait.ts） */
  pressWaitKey: (key: WaitKey) => void;
  /** 「没能启动」卡：按原来的设置再启动一次（接得回上次的会话就接） */
  launchAgain: () => void;
  dismissLaunchFailure: () => void;
  /** Gemini 卡：只把认证方式设成 API Key（先备份）再启动 */
  fixGeminiAuth: () => void;
  dismissLaunchBlock: () => void;
}

async function resolveLaunchCwdForCustom(
  runtimeId: string,
  tabCwd: string,
): Promise<string> {
  const list = await invoke<CustomRuntimeDto[]>("list_custom_runtimes");
  const runtime = list.find((item) => item.id === runtimeId);
  const resolved = resolveCustomRuntimeCwd(tabCwd, runtime?.cwd, IS_WINDOWS);
  if (!resolved) throw new Error("未指定工作目录");
  return resolved;
}

/** 开聊前选择：聊天输入框底栏用，与终端启动栏同一份状态 */
export interface LaunchPickState {
  editable: boolean;
  /** 恢复占位：这个标签上次的会话还没接回（聊天空态给「接着聊」而不是新对话入口） */
  resumeSessionId: string | null;
  /** 只看不接：这段对话的记录正在读出来 / 已经摆出来（发第一句才接回）；没有摆为 null */
  preview?: "loading" | "shown" | null;
  /** 只看不接、还没起进程：输入框底部能改这次接回用的连接 / 模型 / 思考档 / 权限（Agent 与目录跟着这段对话，不能换） */
  resumePick?: boolean;
  agentId: string;
  profileId: string;
  model: string;
  profiles: LaunchMenuOption[];
  models: string[];
  /** 本次思考档覆盖（"" = 按连接设置）；effortLevels 为空 = 这个组合调不了，不显示思考栏 */
  effort: string;
  effortLevels: string[];
  /** 本次权限：可以改文件 / 只讨论（各家 CLI 用自己的只读或计划模式实现） */
  permission: "discuss" | "write_tree";
  /** 可以改文件时的原生权限档：null = 按本机设置；ask / auto / full 只加在本次命令行上 */
  permissionMode: NativePermissionMode | null;
  /** 这家 CLI 能指定的原生权限档（agent_specs permission_args） */
  permissionModes: string[];
  readonlySupported: boolean;
  /** 这家 CLI 本机默认权限（short 上徽标、detail 整句；如 Claude「完全访问」）；默认档为 null */
  permissionNote: CliPermissionNote | null;
  /** 从会话文件读到的实际权限档（Kimi / Codex，sessionModeTier）；读不到为 null，徽标按 Mesa 记录的选择写 */
  observedTier: "ask" | "auto" | "full" | null;
  /** 刚按项目默认换了 Agent / 连接（选项目时）：输入框上短暂写一句「按项目默认」，几秒后清掉 */
  autoNote: string | null;
}

/** 聊天里换一家接着做：这段对话有记录才能接力；生成中换不了 */
export interface RelayPickState {
  available: boolean;
  blocked: string | null;
  pick: RelayTarget | null;
  options: RelayOptionDto[];
}

/** 后端 relay_prepare：写好的简报与接力抬头 */
interface RelayPrepareDto {
  kind: "full" | "delta" | "resume_only";
  briefPath: string | null;
  briefName: string | null;
  framing: string | null;
  resumeSessionId: string | null;
  /** 接回那段的 model_provider（Codex 内联渠道要按它挑连接注入） */
  resumeProvider: string | null;
  summary: string;
}

/** 聊天权限菜单的原生档：ask 请求批准 / auto 帮我批准 / full 完全访问（agent_specs permission_args） */
export type NativePermissionMode = "ask" | "auto" | "full";

/** 标签级的本次启动选择（思考档 / 权限）：聊天输入框、终端启动栏、「这次启动」卡都写这一份 */
export interface TabLaunchPatch {
  effort?: string | null;
  permission?: "discuss" | "write_tree";
  permissionMode?: NativePermissionMode | null;
}

/** 这家 CLI 本机权限设置（cli_permission.rs）：tier = 对应菜单哪一档，认不出为 null */
export interface CliPermissionNote {
  tier: "discuss" | NativePermissionMode | null;
  short: string;
  detail: string;
}

/** 连接出问题时给聊天层 / 终端顶栏的那一份（2026-10-17 用户选定「出错时换个连接接着聊」） */
export interface ConnIssueState {
  kind: ConnIssueKind;
  status: number | null;
  /** 网关 / CLI 原文 */
  message: string;
  /** CLI 还在自动重试 */
  retrying: boolean;
  sig: string;
  /** 出问题的那条连接的名字 */
  profileName: string;
  /** 给人看的一句话（connIssueText） */
  text: string;
  /** 原文一行（含状态码、是否还在重试） */
  detail: string;
  /** 同一家 Agent 的其他可用连接（不含当前这条、不含已停用的）；label = 连接名 · 默认模型 */
  alternatives: { profileId: string; label: string }[];
}

/** TerminalView 上报的当前会话联动数据（主工作区聊天层与阅读区 Agent 栏渲染用） */
export interface SessionLinkState {
  file: string | null;
  sessionId: string | null;
  title: string | null;
  agentId: string | null;
  state: "idle" | "detecting" | "linked" | "timeout";
  /** 会话文件同步通道：识别中 / 已监听 / 等待文件 / 签名轮询兜底。 */
  sync: SessionSyncState;
  conv: ChatMessageDto[];
  /** 下一页上界；null = 没有更早的一窗（短会话或压缩包） */
  convCursor: number | null;
  loadingOlder: boolean;
  /** 已发送用户消息，等待会话文件中出现对应 Agent 回复。 */
  pendingReply: boolean;
  /** hooks 精确注意力为 confirm 时的「在等什么」摘要（无 hooks/无详情字段为 null） */
  confirmDetail: string | null;
  /** 屏幕上正停着「是否信任这个目录」菜单（会话文件出现之前才扫） */
  trustPrompt: TrustPrompt | null;
  /** 聊天层发切换命令后，CLI 弹出的确认 / 选择菜单（发命令后几秒内才扫，tui-menu.ts） */
  menuPrompt: TuiMenu | null;
  /** 运行中在终端里换了权限模式（Claude 审批菜单里「切到 auto」、Shift+Tab）：会话文件记下的新模式 + 序号，
   *  父级按序号只应用一次到标签的权限档（聊天徽标跟上）；没换过为 null */
  cliModeSwitch: { agent: string; mode: string; seq: number } | null;
  /** 终端里开着一个只能在终端看、按 Esc 关的面板（/cost、/usage 的 Settings 面板等，tui-panel.ts） */
  tuiPanel: boolean;
  /** 终端里弹了一条要按回车才继续的通知（tui-panel.ts parseTuiNotice）：正文行；没有为 null */
  tuiNotice: string[] | null;
  /** 终端里「在等你」的那一块（terminal-wait.ts）：通用卡用；认得出的屏、看得见输入框时为 null */
  waitScreen: (WaitScreen & { noInputBox: boolean }) | null;
  /** Claude Code 第一次启动时替人走完的配色 / 安全须知 */
  firstRunNote: FirstRunNote | null;
  /** Agent 一启动就退出：退出码与终端最后几行 */
  launchFailure: LaunchFailure | null;
  /** 启动被拦、聊天层能给出处理办法（Gemini 认证方式） */
  launchBlock: LaunchBlock | null;
  /** 认得出的首次启动屏（Gemini 要存密钥、Cursor 要登录） */
  specialScreen: SpecialScreen | null;
  /** 连接出问题（额度 / 限流 / 钥匙 / 服务 / 模型；conn-issue.ts 扫终端画面认出）+ 可换的同家连接 */
  connIssue: ConnIssueState | null;
  /** Grok 用 API 连接启动，却卡在续期本地已过期的 xAI 官方登录上（grok_login.rs），消息发不出去 */
  grokLoginStuck: boolean;
  /** 终端画面里这一轮正在写的回复（live-reply.ts；只认 Claude Code / CodeBuddy，别家 null） */
  liveReply: string[] | null;
  /** Claude 转圈行里这一轮已生成的 token 数（live-reply.ts claudeOutputTokens）；别家与没认出时 null */
  liveTokens: number | null;
  /** 终端思考框里正在显示的思考（live-reply.ts extractLiveThinking：Grok、Kimi；去掉竖线与 Thinking 头）；不在想为 null */
  liveThinking: string | null;
  /** Claude Code 输入框里那行灰字：它猜你下一句想说什么（prompt-suggestion.ts）；没有为 null */
  promptSuggestion: string | null;
  /** Agent 在跑但 PTY 已 4 秒没出字：TUI 静止（多半停在菜单 / 登录上），不是模型还在想 */
  ptyQuiet: boolean;
  /** 在跑、十分钟没出一个字（2026-11-06 统一「卡在哪」的兜底：没人盯着的活可能卡在认不出的地方） */
  stalled: boolean;
  /** 开聊前的 Agent / 配置 / 模型选择（与启动栏同一份） */
  launchPick: LaunchPickState;
  /** 聊天里换一家 Agent 接着做（docs/design-chat-relay.md） */
  relay: RelayPickState;
  /** 当前 Agent 可从聊天界面直接调用的技能 / MCP 资源。 */
  skills: SkillDto[];
  mcps: McpServerDto[];
  /** 结构化旁路快照（chat_channel.rs：hooks / Qwen Dual Output / OpenCode 服务 / Codex app-server）；没接上为 null */
  channel: ChatChannelSnapshot | null;
}

export const agentLabel = (id: string) => AGENTS.find((a) => a.id === id)?.label ?? id;

/** 终端 ⋯「对话操作」各项的图标（命令名见 mesaCommandsFor） */
const CONVERSATION_ACTION_ICONS: Record<string, typeof SquarePen | undefined> = {
  "/new": SquarePen,
  "/compact": Minimize2,
  "/export": Download,
  "/diff": GitCompare,
  "/chat": MessageSquare,
};

/** 在跑、这么久没出一个字算「可能卡住了」（统一「卡在哪」的兜底） */
const STALLED_MS = 10 * 60_000;
export const RIGHT_PANEL_WIDTH_KEY = "ccode.terminalRightWidth";
export const RIGHT_PANEL_DEFAULT_WIDTH = RIGHT_DEFAULT_PX;
export const RIGHT_PANEL_MIN_WIDTH = RIGHT_MIN_PX;
/** 文件窗格「树与预览左右并排」：开关与并排时树栏宽度的本地记忆 */
export const FILES_SPLIT_KEY = "ccode.terminal.filesSplit";
export const FILES_TREE_WIDTH_KEY = "ccode.terminal.filesTreeWidth";
export const FILES_TREE_DEFAULT_WIDTH = 220;
export const FILES_TREE_MIN_WIDTH = 160;
/** 并排时预览栏至少留这么宽，树栏最宽不挤到它 */
export const FILES_PREVIEW_MIN_WIDTH = 240;
// 分屏：左 pane 宽度百分比的本地记忆（分屏开关状态本身不持久化）
export const SPLIT_PCT_KEY = "ccode.terminalSplitPct";
const SPLIT_MIN_PCT = 20;
const SPLIT_MAX_PCT = 80;
export const clampSplitPct = (pct: number) =>
  Math.min(SPLIT_MAX_PCT, Math.max(SPLIT_MIN_PCT, pct));
/** 右栏一次只显示一个窗格（2026-10-24）：preview＝「文件」窗格（树 / 预览），git＝「改动」窗格；
 *  各由对话头的一个按钮开关，右栏里不再画「文件 | 改动」标签条 */
export type RightTab = "preview" | "git";
/** 文件窗格里正显示的是树还是预览标签（预览标签只在点开文件后才有） */
export type FilesView = "tree" | "preview";

/** 往 shell 写完整命令后的「回车」：ConPTY 把裸 LF 当 Ctrl+Enter，PowerShell 只换行不执行；
 *  Windows 用 \r（VS Code sendText 同口径），其他平台保持 \n */
const SHELL_ENTER = IS_WINDOWS ? "\r" : "\n";

/** 终端输出流控：画完这么多字（string.length）回一次确认。必须 ≤ pty.rs 的 FLOW_LOW——
 *  攒着不发的部分要低于后端恢复读取的下限，否则停读后永远等不到恢复 */
const OUTPUT_ACK_CHUNK = 5000;

/** 待确认的系统通知（权限申请与提示音在 system-notification.ts）：
 *  带「去处理」动作按钮（ccode.attention，App.tsx 注册）；extra 携带 tabId/cwd，
 *  onAction 路由：聚焦对应标签（只有待确认一种通知）。 */
export function fireAttentionNotification(
  title: string,
  body: string,
  extra: { tabId: string; cwd: string },
) {
  // 桌宠开着且会说话：等你确认由小桌报，不再另弹系统通知（2026-11-09 桌宠第二期）
  if (petSpeaksInstead(useAppStore.getState().settings, readPetDnd(), Date.now())) return Promise.resolve();
  return sendSystemNotification({ title, body, actionTypeId: "ccode.attention", extra });
}

/** 七套深色 + 七套浅色主题对应的 xterm 底色/前景。
 *  深色行与 App.css 的 --color-editor-bg/--color-editor-fg 逐字一致（tests/theme-tokens.test.ts 锁定）。
 *  浅色行**刻意不等同 editor-bg**：editor-bg 是纯白 #ffffff，整屏纯白当终端发刺眼，
 *  故各主题取自己色相的近白（暖纸 / 冷灰 / 淡紫，见 16c456b 的调校），不一概用 #fff。
 *  ANSI 16 色 + 光标 + 选区由调色板预设提供，并按主题亮暗自动取深/浅套
 *  （见 terminal-palettes.ts 的 resolvePaletteId）。 */
const XTERM_BG_FG: Record<string, { background: string; foreground: string }> =
  {
    midnight: { background: "#131210", foreground: "#b3b0aa" },
    terracotta: { background: "#181816", foreground: "#bdbcb8" },
    ayu: { background: "#15130f", foreground: "#bdb8b0" },
    mocha: { background: "#1f1f23", foreground: "#b5b9c7" },
    neutral: { background: "#111111", foreground: "#c9c9c9" },
    dracula: { background: "#2a2b2f", foreground: "#ccced8" },
    shadcn: { background: "#12141a", foreground: "#b9b9c0" },
    "midnight-light": { background: "#fbfbf9", foreground: "#3f3c36" },
    "terracotta-light": { background: "#fefcfa", foreground: "#453f3a" },
    "ayu-light": { background: "#fffdfa", foreground: "#443a31" },
    "mocha-light": { background: "#fbfafb", foreground: "#3d3b47" },
    "neutral-light": { background: "#fdfdfd", foreground: "#3a3a3a" },
    "dracula-light": { background: "#fefdff", foreground: "#403a4e" },
    "shadcn-light": { background: "#fefefe", foreground: "#344054" },
  };

/** 终端 16 色调色板预设已抽至 src/terminal-palettes.ts（设置页预览共享） */

/** 底/字色取自主题表，ANSI 16 色 + cursor + selectionBackground 全部由调色板提供。
 *  调色板先经 resolvePaletteId 按主题亮暗解析：浅色主题拿到深色向预设时自动换 twin，
 *  避免近白底上出现 white/brightWhite 隐形、深藏蓝选区压死选中文字。 */
export function buildXtermTheme(
  themeId: string,
  paletteId?: string,
  customTheme?: { rail: string; canvas: string; accent: string } | null,
): { background: string; foreground: string } & Record<string, string> {
  const palette =
    XTERM_PALETTES[resolvePaletteId(paletteId, isLightTheme(themeId), themeId)];
  const bgfg = isCustomThemeId(themeId)
    ? customXtermBgFg(
        deriveThemeTokens(normalizeCustomTheme(customTheme) ?? DEFAULT_CUSTOM_THEME)
          .tokens,
      )
    : (XTERM_BG_FG[themeId] ?? XTERM_BG_FG[DEFAULT_THEME_ID]);
  const light = isLightTheme(themeId);
  return {
    ...bgfg,
    ...palette,
    scrollbarSliderBackground: light ? "#3a342c99" : "#ffffff99",
    scrollbarSliderHoverBackground: light ? "#3a342ccc" : "#ffffffcc",
    scrollbarSliderActiveBackground: light ? "#3a342cff" : "#ffffffff",
  };
}

/** 与 xterm 自己量字宽同一口径（CharSizeService：画布上按 `${fontSize}px ${fontFamily}` 量一个 W） */
function measureTerminalCharWidth(fontSize: number, fontFamily: string): number {
  try {
    const canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(100, 100)
        : document.createElement("canvas");
    const ctx = canvas.getContext("2d") as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) return 0;
    ctx.font = `${fontSize}px ${fontFamily}`;
    return ctx.measureText("W").width;
  } catch {
    return 0;
  }
}

/** 同一 Run 未完成的交互启动：挡住 StrictMode / 连点「运行」抢锁。 */
const interactiveLaunchLocks = new Set<string>();

/** 单个终端：独立持有 xterm 实例、PTY 引用和启动栏状态；隐藏时只 display:none，不杀进程。
 *  memo 化：启动栏自己的状态变化只重渲染本组件，不级联到兄弟标签/文件树/编辑器。 */
export const TerminalView = memo(function TerminalView({
  visible,
  primaryFocus = true,
  rightOpen,
  compactBarHidden = false,
  onToggleCompactBar,
  layoutKey,
  gitTotals,
  termBg,
  statusBarOn = true,
  tabId,
  initialCwd,
  skipSeed,
  initialExtraEnv,
  initialTitle,
  initialAgentId,
  initialProfileId,
  initialModel,
  resumeSessionId,
  forkSessionId,
  resumeProvider,
  autoStart,
  resumeKick,
  prefillCommand,
  shellOnly,
  customRuntimeId,
  initialPrompt: presetPrompt,
  readonly,
  permission,
  permissionMode = null,
  effortOverride,
  submitCsiU = false,
  restored,
  stepClaimName,
  reuseKey,
  initialRunId,
  taskId,
  launchSeed = 0,
  externalCwd,
  onConsumeExternalCwd,
  onStatus,
  onSessionUpdate,
  embedInPeek = false,
  coveredByChat = false,
  onActions,
  onRestoreComplete,
  onConsumeResume,
  onForkChat,
  onConversationInsert,
  onSearchChat,
  onPatchLaunch,
  getConversationActions,
  onOpenPath,
  onProgress,
}: {
  visible: boolean;
  /** 分屏时只有活跃 pane 绑定窗口级 ⌘F 兜底；xterm 聚焦时的拦截不受影响 */
  primaryFocus?: boolean;
  /** 收缩态启动行被用户隐藏（全局偏好）；隐藏后由标签栏召回钮恢复 */
  compactBarHidden?: boolean;
  onToggleCompactBar?: () => void;
  /** 右侧面板开关影响 xterm 可用宽度，变化时需要重新 fit */
  rightOpen: boolean;
  /** 布局版本号（右栏开合/分屏/窥视等宽度变化时递增，触发 xterm 重新 fit） */
  layoutKey?: string;
  /** 该标签 cwd 的 git 变更统计（Codex 风：状态行常驻 +N -N） */
  gitTotals?: { add: number; del: number } | null;
  /** 终端画面底色（与 xterm 主题同源）：画布区涂它，和状态栏拼成一张同色圆角卡 */
  termBg?: string;
  /** 底部状态栏开着：画面只圆上沿，下沿圆角由状态栏补。关掉时画面自己四角都圆。 */
  statusBarOn?: boolean;
  /** 本标签 id（liveSessions 登记用） */
  tabId: string;
  /** 不继承「上次启动」记录（兜底空标签） */
  skipSeed?: boolean;
  /** 从工作树「在此打开」/ 工作区创建的标签：启动栏 cwd 预填为该目录 */
  initialCwd?: string;
  /** 工作区交接的附加 env（如 CCODE_PORT 端口段），launch 时注入 */
  initialExtraEnv?: Record<string, string>;
  /** 工作区交接的标签标题（工作区名 / run: 脚本名），优先于 profile/agent 名 */
  initialTitle?: string;
  /** 预填启动栏（会话恢复 / 工作区记住配置） */
  initialAgentId?: string;
  initialProfileId?: string;
  initialModel?: string;
  /** 会话恢复：pty_spawn 的 resumeSessionId */
  resumeSessionId?: string;
  /** 原生分叉（pty_spawn 的 forkSessionId）：第一次启动把这段会话整段复制成新会话；之后接新会话 */
  forkSessionId?: string;
  /** 会话恢复：rollout 记下的 provider */
  resumeProvider?: string;
  /** 首次可见时自动启动（会话恢复；有 profile 才启动，否则只预填） */
  autoStart?: boolean;
  /** 已有 resume 标签但进程不在时，再点「继续」递增以重试启动 */
  resumeKick?: number;
  /** run 脚本：进入 shell 后立即写入的命令行 */
  prefillCommand?: string;
  /** run 脚本标签：挂载后自动开 shell 并执行 prefillCommand（不走 Agent 启动流程） */
  shellOnly?: boolean;
  /** 直接启动 Custom Runtime，不经过 shell */
  customRuntimeId?: string;
  /** 一键开步预填的首条指令：启动时注入 CLI，成功后清除（一次性）；留空 = 不注入 */
  initialPrompt?: string;
  /** 「聊想法」只读模式：pty_spawn 透传（支持的 CLI 注入只读/计划模式参数） */
  readonly?: boolean;
  permission?: "discuss" | "write_tree";
  /** 可以改文件时的原生权限档（聊天权限徽标）：pty_spawn permissionMode 透传；null = 按本机设置 */
  permissionMode?: NativePermissionMode | null;
  /** 开工弹层的本次思考档覆盖：launch 经 pty_spawn effortOverride 注入（空 = 绑定默认） */
  effortOverride?: string | null;
  /** 当前 Agent 的提交键是否使用 kitty CSI-u（目前 Kimi） */
  submitCsiU?: boolean;
  /** 应用重启后恢复出的占位标签；用户明确操作前不启动 PTY。 */
  restored?: boolean;
  /** 步骤认领（「跟 AI 商量一下」）：launch 时以最终 agent/cwd 登记会话归该步骤 */
  stepClaimName?: string;
  reuseKey?: string;
  initialRunId?: string;
  /** 新建 Task 后预创建的 Run 所属 Task */
  taskId?: string;
  /** 父级要求把启动栏改成 initialAgent/Profile/Model（去终端看看：闲置标签换上步骤绑定）。
   *  只在未运行时生效，不打断正在跑的会话。 */
  launchSeed?: number;
  /** 最近项目「真进入」：把目标目录注入活动标签的启动栏（TerminalView 消费后清空） */
  externalCwd?: string | null;
  onConsumeExternalCwd?: () => void;
  /** 上报回调带 tabId（父级共享 useCallback，memo 稳定） */
  onStatus: (id: string, s: TabStatus) => void;
  onSessionUpdate: (id: string, s: SessionLinkState) => void;
  /** 聊天窥视底栏：只留 xterm，收起启动栏，让这一栏高度都给 TUI */
  embedInPeek?: boolean;
  /** 聊天层整片盖在终端上（聊天模式且没拉起终端）：xterm 照常解析（聊天层读屏要用），只停绘制 */
  coveredByChat?: boolean;
  /** 向父级注册本标签的动作表（查找图标 / 聊天发送 / 改目录等） */
  onActions?: (id: string, a: FocusTabActions) => void;
  onRestoreComplete?: (id: string) => void;
  /** launch 成功接管会话后通知父级清掉标签级 resumeSessionId（之后「启动」不再接旧会话） */
  onConsumeResume?: (id: string) => void;
  /** 从当前会话摘要开一个只读分叉标签（启动行 ⋯，不进聊天 ＋）。带 tabId：
   *  页面侧可传稳定回调，避免内联箭头击穿 memo(TerminalView)。 */
  onForkChat?: (tabId: string) => void;
  /** 选中的终端文字交给对话（引用到输入框 / 问 AI）：父级按这个标签当前在聊天层还是终端层分派。
   *  带 tabId 的稳定回调，避免击穿 memo(TerminalView) */
  onConversationInsert?: (tabId: string, text: string, opts: { send: boolean }) => void;
  onSearchChat?: (tabId: string) => void;
  /** 启动栏「思考」「权限」格与「这次启动」卡写回标签级选择（与聊天输入框同一份）。带 tabId 的稳定回调 */
  onPatchLaunch?: (tabId: string, patch: TabLaunchPatch) => void;
  /** ⋯ 菜单里的「对话操作」（与聊天层斜杠面板 Mesa 组同一份，去掉终端层用不着的）。带 tabId 的稳定回调 */
  getConversationActions?: (tabId: string) => MesaCommand[];
  /** 终端里的绝对路径点开到右侧预览。 */
  onOpenPath?: (path: string, line: number | null) => void;
  /** 终端上报的任务进度（OSC 9;4，kimi/grok/codebuddy 发）→ 标签条小徽章。
   *  带 tabId 的稳定回调（memo 不失效，进度 1Hz 更新不级联全部终端重渲染）。 */
  onProgress?: (tabId: string, progress: TerminalProgress | null) => void;
}) {
  const profiles = useAppStore((s) => s.profiles);
  const settings = useAppStore((s) => s.settings);
  const gateways = useAppStore((s) => s.gateways);
  /** 配置指纹里显示网关名（id 是 uuid，人读不出） */
  const gatewayNameOf = (id: string) =>
    gateways.find((g) => g.id === id)?.name ?? id.slice(0, 8);
  // 终端创建 effect 依赖 [everVisible]，创建时参数经 ref 取最新设置
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // 设置即时应用：字号与主题色随设置页修改实时生效（scrollback 只对新终端生效）
  useEffect(() => {
    const term = termRef.current;
    if (!term || !settings) return;
    term.options.fontSize = settings.terminalFontSize;
    term.options.fontFamily = terminalFontStack(
      settings.terminalFontFamily,
      monoFallbackStack(),
    );
    term.options.theme = buildXtermTheme(
      settings.theme,
      settings.terminalPalette,
      settings.customTheme,
    );
    cellWidthSyncRef.current?.();
    // 字号/字体变了但容器像素尺寸没变，ResizeObserver 不触发——手动补 fit 让 PTY 行列跟随
    try {
      fitRef.current?.fit();
    } catch {
      // display:none 下尺寸为 0，fit 会抛；可见性 effect 里会补
    }
  }, [settings]);
  // 记住上次启动选择（agent/profile/模型/目录），每个新标签以此为初始值（skipSeed 标签除外）
  const saved = skipSeed
    ? {}
    : (() => {
        try {
          return JSON.parse(
            localStorage.getItem("ccode.lastLaunch") ?? "{}",
          ) as Partial<{
            agentId: string;
            profileId: string;
            model: string;
            cwd: string;
          }>;
        } catch {
          return {};
        }
      })();
  const [agentId, setAgentId] = useState<string>(
    initialAgentId ?? saved.agentId ?? "claude-code",
  );
  const [profileId, setProfileId] = useState(
    initialProfileId ?? saved.profileId ?? "",
  );
  const [officialSt, setOfficialSt] = useState<OfficialAccountStatusDto | null>(
    null,
  );
  // 登录检测是否已落锤（成功或失败都算）；officialSt=null 既可能是「未探测完」
  // 也可能是「探测失败」，自动启动必须区分这两种（见下方 autoStart 守卫）
  const [officialStReady, setOfficialStReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setOfficialSt(null);
    setOfficialStReady(false);
    invoke<OfficialAccountStatusDto>("official_account_status", { agentId })
      .then((st) => {
        if (!cancelled) {
          setOfficialSt(st);
          setOfficialStReady(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setOfficialSt(null);
          setOfficialStReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);
  // 换 Agent 后按「显式默认 > 上次使用 > 该 Agent 首个配置」预选（v3.88）。
  // 这才是用户心里的「启用某个配置」——不加 enabled 布尔（与注入语义打架，见 settings.rs）
  // 官方账号未登录时不要自动预选：选了会打官方接口且不带密钥，报 401 Missing bearer。
  useEffect(() => {
    if (running || profileId) return;
    const hasOfficial = profiles.some(
      (p) => p.agent === agentId && p.accountType === "official",
    );
    if (hasOfficial && officialSt === null) return;
    const pick =
      settings?.defaultProfiles?.[agentId] ||
      localStorage.getItem(`ccode.lastProfile.${agentId}`) ||
      "";
    const remembered = profiles.find(
      (p) => p.id === pick && p.agent === agentId,
    );
    // 停用/缺槽的「上次配置」不参与自动预选（停用的本意就是别自动落到它头上，
    // 与 resume-profile.ts 的 wishedId 口径一致；手动下拉仍可选）。全停用时
    // 由下方最末回落兜底，不拦死。
    const rememberedOk =
      remembered &&
      !hiddenProfiles.includes(remembered.id) &&
      !remembered.slotMissing &&
      (remembered.accountType !== "official" || officialSt?.connected)
        ? remembered.id
        : undefined;
    // 兜底挑首个时跳过停用项（停用的本意就是「别自动落到我头上」）；
    // 全被停用时仍从停用项里取，好过留空
    const visible = profiles.filter(
      (p) =>
        p.agent === agentId &&
        !hiddenProfiles.includes(p.id) &&
        !p.slotMissing,
    );
    const auto = skipDisconnectedOfficial(visible, officialSt?.connected);
    setProfileId(
      rememberedOk ??
        auto[0]?.id ??
        visible[0]?.id ??
        profiles.find((p) => p.agent === agentId)?.id ??
        "",
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    agentId,
    profiles,
    settings?.defaultProfiles,
    settings?.hiddenProfiles,
    officialSt,
  ]);
  // 指定了配置时不要沿用上次启动留下的模型（官方账号会被 DeepSeek 顶掉）
  const [model, setModel] = useState(
    initialModel ?? (initialProfileId ? "" : saved.model) ?? "",
  );
  /** 本次启动实际注入的模型（状态栏求交用它，不跟 CLI 内 /model 或启动栏事后改选） */
  const [launchModel, setLaunchModel] = useState<string | null>(null);
  /** 这个进程启动时的模型与思考档（空串 = 默认）：会话文件锁定时连同连接一起记进 session_meta */
  const launchRecordRef = useRef<{ model: string; effort: string } | null>(null);
  // 状态栏思考档的真值来源之一：CLI 自己画在屏上的档位（detectEffortInOutput）
  const [effortSeen, setEffortSeen] = useState<string | null>(null);
  const [modelSeen, setModelSeen] = useState<string | null>(null);
  const effortTailRef = useRef("");
  // 输出监听是启动时挂的闭包：认档用「这个进程启动时的 Agent」，不跟启动栏后来的选择
  const launchAgentRef = useRef(agentId);
  /** 按当前渲染器重算单元格宽补位（WebGL 就近取整）；字号字体改了由设置 effect 调 */
  const cellWidthSyncRef = useRef<(() => void) | null>(null);
  const selectedProfile = profiles.find(
    (p) => p.id === profileId && p.agent === agentId,
  );
  // 扫屏回调里要拿「出错时用的是哪条连接」，不能读闭包里的旧值
  const selectedProfileRef = useRef(selectedProfile);
  selectedProfileRef.current = selectedProfile;
  // 模型 combo：下拉开合状态 + 选项来源（profile 预设 + 本 Agent 历史，去重）
  const [modelOpen, setModelOpen] = useState(false);
  // Agent / 配置同时只开一个，且不跟模型清单叠在一起
  const [openPick, setOpenPick] = useState<
    null | "agent" | "profile" | "effort" | "permission"
  >(null);
  const modelAnchorRef = useRef<HTMLSpanElement>(null);
  // 换 profile 时保留了手填模型：说明行据此提示「仍按原样注入」（选中预设即消）
  const [modelKept, setModelKept] = useState(false);
  // 官方账号：丢掉上次中转留下的 DeepSeek 等模型，避免 -m 进 ChatGPT 通道
  useEffect(() => {
    if (running || !selectedProfile || selectedProfile.accountType !== "official")
      return;
    const cur = model.trim();
    if (!cur) return;
    if (
      !officialModelAllowed(agentId, cur) ||
      (selectedProfile.models.length > 0 && !selectedProfile.models.includes(cur))
    ) {
      setModel(selectedProfile.models[0] ?? "");
      setModelKept(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, selectedProfile?.accountType]);
  // 模型选项 = 这份连接自己的模型名单 + 用这份连接手填用过的模型。
  // 历史按「Agent + 连接」分开记：原先按 Agent 混记，别的连接用过的模型（gpt-6-sol、deepseek…）
  // 会出现在 GLM 连接的名单里，选了也调不通（2026-10-17 用户截图）
  const modelOptions = useMemo(() => {
    // 出图 / 向量等非对话模型不进名单（选了启动也会被后端闸拦下，见 model-kinds.ts）
    return connectionModels(selectedProfile?.models ?? [], readModelHistory(agentId, profileId)).filter(
      (m) => modelKind(m) === "chat",
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, profileId, selectedProfile, model]);
  // 新标签的模型种子来自「上次启动」，可能是另一份连接的模型（上次用 Codex-GPT 的 gpt-5.6-luna，
  // 这次落到 Codex-Deepseek）。配置定下来后核一次：不在这份连接的名单 / 历史里就换成它的默认模型
  const modelSeededRef = useRef(!initialModel && !initialProfileId && Boolean(saved.model));
  useEffect(() => {
    if (running || !modelSeededRef.current || !selectedProfile) return;
    modelSeededRef.current = false;
    const cur = model.trim();
    if (cur && !modelOptions.includes(cur)) {
      setModel(selectedProfile.models[0] ?? "");
      setModelKept(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProfile, modelOptions]);
  const {
    box: modelMenuBox,
    exiting: modelMenuExiting,
    closeNow: modelMenuCloseNow,
  } = useDownMenu(modelOpen && modelOptions.length > 0, modelAnchorRef, 0);
  // 模型清单挂在 body 上，点输入框外要收起（箭头按钮在锚点内，不误关）
  useEffect(() => {
    if (!modelOpen) return;
    const onDoc = (event: MouseEvent) => {
      const target = event.target as Node;
      if (modelAnchorRef.current?.contains(target)) return;
      const menu = document.getElementById(`mesa-launch-model-menu-${tabId}`);
      if (menu?.contains(target)) return;
      setModelOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [modelOpen, tabId]);
  const [cwd, setCwd] = useState(initialCwd ?? "~");
  const [cwdIssue, setCwdIssue] = useState<string | null>(null);
  const [cwdChecking, setCwdChecking] = useState(false);
  const cwdCheckSeqRef = useRef(0);
  const [homeDir, setHomeDir] = useState("");
  useEffect(() => {
    void invoke<string>("home_dir")
      .then(setHomeDir)
      .catch(() => {});
  }, []);
  // 没给目录的新标签默认随手聊（~/ccode/scratch，与快速开聊同口径），不再默认主目录：Codex 在 Windows 上会给
  // 工作目录下每一项改访问权限，主目录 = 整个用户文件夹（2026-10-20 实测）。主目录仍可在目录菜单里选。
  // 恢复的标签与接回会话保持原目录；人在这之前已经换过目录的不覆盖
  useEffect(() => {
    if (initialCwd || restored || resumeSessionId) return;
    let cancelled = false;
    void invoke<string>("ensure_scratch_dir")
      .then((dir) => {
        if (!cancelled && dir) setCwd((cur) => (cur === "~" ? dir : cur));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** launch 里人主动取消（如主目录提醒点了取消）时的说明，给聊天层发送失败时显示，代替笼统的「启动失败」 */
  const launchCancelRef = useRef<string | null>(null);

  async function checkWorkingDirectory(path = cwd): Promise<boolean> {
    const seq = ++cwdCheckSeqRef.current;
    setCwdChecking(true);
    try {
      await invoke("list_dir", { path, showHidden: false });
      if (seq === cwdCheckSeqRef.current) setCwdIssue(null);
      return true;
    } catch {
      if (seq === cwdCheckSeqRef.current) setCwdIssue(path);
      return false;
    } finally {
      if (seq === cwdCheckSeqRef.current) setCwdChecking(false);
    }
  }

  function setWorkingDirectory(path: string) {
    const next = path.trim();
    if (!next) return;
    cwdCheckSeqRef.current += 1;
    setCwd(next);
    setCwdChecking(false);
    setCwdIssue(null);
    setError(null);
    setNotice(null);
    setBarExpanded(true);
  }

  async function chooseWorkingDirectory() {
    const selected = await openDirectoryDialog({ directory: true, multiple: false });
    const path = Array.isArray(selected) ? selected[0] : selected;
    if (typeof path === "string" && path.trim()) setWorkingDirectory(path);
  }

  async function returnToHomeDirectory() {
    setWorkingDirectory("~");
    await checkWorkingDirectory("~");
  }
  // 一键开步的首条指令：开步预填过就展示编辑框；注入成功即清除（一次性）
  const [promptText, setPromptText] = useState(presetPrompt ?? "");
  // 分叉会话允许“重启为可写”时仍需保留最初的摘要指令；启动成功后启动栏文本会被清空。
  const forkPromptRef = useRef(presetPrompt ?? "");
  const [showPrompt, setShowPrompt] = useState(!!presetPrompt);
  const [running, setRunning] = useState(false); // agent 正在运行
  // 去终端看看命中已有闲置标签：把启动栏改成这次解析出的 Agent/连接/模型。
  // 跑着的会话不改（活会话仍是原 Agent）。
  const appliedLaunchSeed = useRef(0);
  useEffect(() => {
    if (!launchSeed || launchSeed === appliedLaunchSeed.current || running) return;
    appliedLaunchSeed.current = launchSeed;
    if (initialAgentId) setAgentId(initialAgentId);
    if (initialProfileId) setProfileId(initialProfileId);
    setModel(initialModel ?? "");
  }, [launchSeed, initialAgentId, initialProfileId, initialModel, running]);
  const [shellActive, setShellActive] = useState(false); // 当前接的是 shell
  const [exited, setExited] = useState(false);
  /** 最后一次子进程退出的码；后端 pty-exit 事件的 payload。null＝从未退出过。 */
  const [exitCode, setExitCode] = useState<number | null>(null);
  /** agent 启动成功时刻（状态栏运行时长；shell/未启动为 null） */
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 提示（非错误）：「已接回正在跑的进程」这类只陈述事实的消息。与 error 分家——
  // error 会把收缩行强制顶出来（compactBarUrgent）且飘红，接回成功是正常态，两样都不该占
  const [notice, setNotice] = useState<string | null>(null);
  // 启动栏收缩：空闲时完整展示，启动成功后自动收成一行状态条（「修改」可重新展开）
  // 恢复占位标签默认使用紧凑行，避免「可恢复」卡片上方再堆一整套启动配置。
  const [barExpanded, setBarExpanded] = useState(!restored);

  useEffect(() => {
    if (restored && !running && !shellActive) setBarExpanded(false);
  }, [restored, running, shellActive]);

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // openpty 之后的尺寸锁。unset 不是「可以改行列」。
  // measured / frozen 时，attach 和防抖 onResize 都不通知进程。
  const resizeLatchRef = useRef<ResizeLatch>({ kind: "unset" });
  const barExpandedRef = useRef(!restored);
  const advancedLaunchOpenRef = useRef(!!presetPrompt);
  barExpandedRef.current = barExpanded;
  // 组件卸载标记：attach/onPtyExit 的 await 途中关标签时，回落 shell 不得再碰已 dispose 的 xterm
  const mountedRef = useRef(true);
  const searchRef = useRef<SearchAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const ptyKindRef = useRef<PtyKind | null>(null);
  /** 子进程推过 Kitty 键盘 flags 之后才把功能键编成 CSI-u。弹出或新进程清掉。 */
  const kkpArmedRef = useRef(false);
  const queryPendingRef = useRef("");
  const hostPendingRef = useRef("");
  /** Kitty 分块贴图（m=1）跨帧攒的 base64。 */
  const kittyAccumRef = useRef("");
  /** 后台标签带外信号流（pty-signal）自己的断帧攒缓冲——与主输出流分开。 */
  const signalPendingRef = useRef("");
  /** 终端通知（OSC 9/777/BEL）按标签限频的时间戳。 */
  const terminalNotifyAtRef = useRef(0);
  /** 可见性走 ref：创建期一次性订阅（onBell 等）不捕获过期闭包 */
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  /** everVisible 同理（saveTerminalReplayNow 在生命周期回调里调用）；
   *  声明在 1665 行的 state 之前，赋值挪到其后（渲染期内联赋值） */
  const everVisibleRef = useRef(false);
  const onOpenPathRef = useRef(onOpenPath);
  onOpenPathRef.current = onOpenPath;
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const onForkChatRef = useRef(onForkChat);
  onForkChatRef.current = onForkChat;
  const [inlineImageUrl, setInlineImageUrl] = useState<string | null>(null);
  const unlistenRef = useRef<(() => void)[]>([]);

  // —— 输出搜索（SearchAddon）：搜索条只作用于本标签的 xterm 实例 ——
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // 条件开关（借鉴 Tabby/VS Code）：正则 / 全词 / 大小写；命中计数 x/y
  const [searchRegex, setSearchRegex] = useState(false);
  const [searchWord, setSearchWord] = useState(false);
  const [searchCase, setSearchCase] = useState(false);
  const [searchResults, setSearchResults] = useState<{
    index: number;
    count: number;
  } | null>(null);
  const [searchNote, setSearchNote] = useState<string | null>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 备用屏（全屏 TUI）没有回滚区：查找范围塌缩成当前一屏，↑↓ 只在屏幕内打转。
  // 搜索条据此出提示，免得看起来像查找坏了。由 buffer.onBufferChange 驱动，
  // 进出全屏程序时提示跟着出现/消失。
  const [altBufferActive, setAltBufferActive] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [terminalActionMenu, setTerminalActionMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  // 空态卡「将在 … 启动」点开的目录菜单（随手聊 / 最近项目 / 主目录 / 选择文件夹…）
  const [welcomeDirMenu, setWelcomeDirMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const storeProjectPaths = useAppStore((s) => s.projectPaths);
  const storeRecentRepos = useAppStore((s) => s.recentRepos);
  // 终端画布右键菜单（复制/粘贴/全选/清屏/查找）
  const [termCtxMenu, setTermCtxMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [termPick, setTermPick] = useState<{
    text: string;
    x: number;
    y: number;
  } | null>(null);
  const [termPickView, setTermPickView] = useState<string | null>(null);
  // 粘贴图片/拖入文件后的瞬态轻反馈（3s 自动消，重贴重置计时）
  const [inputNote, setInputNote] = useState<string | null>(null);
  const inputNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 输入侧动作的瞬态轻反馈（参考配置页 notice 模式，只是更轻） */
  function flashInputNote(text: string) {
    setInputNote(text);
    if (inputNoteTimer.current) clearTimeout(inputNoteTimer.current);
    inputNoteTimer.current = setTimeout(() => setInputNote(null), 3000);
  }

  /** 用户主动写入 PTY 的统一反馈：写入失败不能静默丢掉输入。 */
  function writeInteractivePty(ptyId: string, data: string, success?: string) {
    void invoke("pty_write", { ptyId, data })
      .then(() => {
        if (success) flashInputNote(success);
      })
      .catch((reason) => flashInputNote(`终端输入失败：${String(reason)}`));
  }

  /** 剪贴板图片 → 落盘（save_clipboard_image）→ 绝对路径转义写进 PTY
      （「路径文本」是九家 CLI 通吃的图片输入方式，各家升级行为见 matrix §11） */
  async function pasteImageFile(file: File) {
    const id = ptyIdRef.current;
    if (!id) {
      flashInputNote("终端未启动，无法粘贴");
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      const path = await saveClipboardImage(buf, imageExtFromMime(file.type));
      await invoke("pty_write", {
        ptyId: id,
        data: escapeShellPath(path, IS_WINDOWS),
      });
      flashInputNote(pasteImageFeedback(path));
    } catch (reason) {
      flashInputNote(`粘贴图片失败：${String(reason)}`);
    }
  }

  /** 粘贴的实际写入：按 bracketed paste 模式包标记（TUI 的「大段粘贴确认」靠它）。
   *  同内容 250ms 去重：mac ⌘V 的键盘路径（pasteFromClipboard 的 execCommand 失败后
   *  readText）与原生 paste 事件（capture 三分发）可能各到一次，异步解析间隔可超
   *  80ms（三轮审查）；双发会让 CLI 收两份。失败不静默——用户主动写入要有反馈。 */
  const lastPasteRef = useRef<{ data: string; at: number } | null>(null);
  function writePtyPaste(data: string, note?: string) {
    const id = ptyIdRef.current;
    if (!id) {
      flashInputNote("终端未启动，无法粘贴");
      return;
    }
    const now = performance.now();
    const last = lastPasteRef.current;
    if (last && last.data === data && now - last.at < 250) {
      return; // 同一记粘贴的第二条路径，丢弃
    }
    lastPasteRef.current = { data, at: now };
    const wrap = termRef.current?.modes.bracketedPasteMode
      ? `\x1b[200~${data}\x1b[201~`
      : data;
    if (data.includes("\r")) {
      invoke("pty_write", { ptyId: id, data: wrap })
        .then(() => flashInputNote(note ?? "已粘贴"))
        .catch(() => flashInputNote("粘贴失败"));
    } else {
      writeInteractivePty(id, wrap, note);
    }
  }

  /** 终端文本粘贴的统一防线（src/paste-guard.ts）：shell 多行先确认、
   *  收尾回车一律剪掉（防「粘贴即执行」）；agent 标签交给 TUI 自己消化。 */
  function handleTerminalTextPaste(text: string) {
    const plan = pasteGuardPlan({
      text,
      kind: ptyKindRef.current === "agent" ? "agent" : "shell",
      alternateScreen:
        termRef.current?.buffer.active.type === "alternate",
    });
    if (plan.action === "confirm") {
      void confirmDialog(
        `${plan.trimmed ? "首尾换行已去掉。" : ""}要粘贴 ${plan.lines} 行内容，确认粘贴？`,
        { danger: true },
      ).then((ok) => {
        if (ok) writePtyPaste(plan.data);
      });
      return;
    }
    if (!plan.data) {
      if (plan.note) flashInputNote(plan.note);
      return;
    }
    writePtyPaste(plan.data, plan.note);
  }

  /** 右键「粘贴」。菜单点击拿不到网页剪贴板权限，文字走终端输入框的 paste。 */
  async function pasteFromClipboard() {
    const area = termRef.current?.textarea;
    if (area) {
      area.focus();
      try {
        if (document.execCommand("paste")) return;
      } catch {
        /* 下面再试异步读取 */
      }
    }
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        handleTerminalTextPaste(text);
        return;
      }
      // 网页剪贴板没文字：可能是 Finder/资源管理器复制的文件（WKWebView 不给路径）
      const files = await invoke<string[]>("read_clipboard_files");
      if (files.length > 0) {
        const joined = joinDroppedPaths(files, IS_WINDOWS);
        if (joined) writePtyPaste(joined, `已粘贴 ${files.length} 个文件路径`);
        return;
      }
    } catch {
      flashInputNote("无法读取剪贴板");
    }
  }

  /** xterm 画布内的匹配高亮色（与主题无关，参照 VS Code Dark+ 查找高亮） */
  const SEARCH_DECORATIONS = {
    matchBackground: "#3a5a8a",
    matchOverviewRuler: "#3a5a8a",
    activeMatchBackground: "#5a7ba8",
    activeMatchColorOverviewRuler: "#5a7ba8",
  };

  /** 按当前开关拼搜索项；非法正则即时提示，不当掉整条搜索 */
  const searchOptions = useCallback(
    (incremental: boolean) => ({
      decorations: SEARCH_DECORATIONS,
      regex: searchRegex,
      caseSensitive: searchCase,
      wholeWord: searchWord,
      incremental,
    }),
    [searchRegex, searchCase, searchWord],
  );

  const runSearch = useCallback(
    (q: string, incremental: boolean, backward = false) => {
      if (!q || !searchRef.current) {
        setSearchResults(null);
        setSearchNote(null);
        return;
      }
      if (searchRegex) {
        try {
          new RegExp(q);
        } catch (err) {
          setSearchResults(null);
          setSearchNote(`正则有误：${String(err).slice(0, 60)}`);
          return;
        }
      }
      setSearchNote(null);
      try {
        if (backward) searchRef.current.findPrevious(q, searchOptions(incremental));
        else searchRef.current.findNext(q, searchOptions(incremental));
      } catch {
        // 增量搜索边打边查，中间态正则抛错按无结果处理
        setSearchResults(null);
      }
    },
    [searchOptions, searchRegex],
  );

  /** 输入变化：250ms 防抖后增量高亮（Tabby 同款节奏，长缓冲不卡输入） */
  const queueIncrementalSearch = useCallback(
    (q: string) => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = setTimeout(() => {
        searchDebounceRef.current = null;
        runSearch(q, true);
      }, 250);
    },
    [runSearch],
  );

  const findNext = useCallback(
    (q?: string) => {
      const query = q ?? searchQuery;
      if (query) runSearch(query, false);
    },
    [runSearch, searchQuery],
  );

  const findPrev = useCallback(() => {
    if (searchQuery) runSearch(searchQuery, false, true);
  }, [runSearch, searchQuery]);

  // 开关切换：立即按当前词重查一遍（不等人再敲字）；先清掉防抖里携带旧开关的 pending
  useEffect(() => {
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = null;
    }
    if (searchOpen && searchQuery) runSearch(searchQuery, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchRegex, searchCase, searchWord]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchResults(null);
    setSearchNote(null);
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = null;
    }
    searchRef.current?.clearDecorations();
    termRef.current?.focus();
  }, []);

  // 终端被聊天盖住时也收起查找，避免浮层留在聊天搜索上方。
  useEffect(() => {
    if (!visible || coveredByChat) {
      setSearchOpen(false);
      setTerminalActionMenu(null);
      setTermCtxMenu(null);
    }
  }, [visible, coveredByChat]);

  // 搜索条打开时聚焦输入框并选中已有文本，同时按当前缓冲区类型定一次提示。
  // 订阅只在「切换」时触发：若打开搜索条时已经身处全屏程序里（备屏早已激活），
  // 光靠订阅会一直保持 false，提示就不出现。
  useEffect(() => {
    if (!searchOpen) return;
    searchInputRef.current?.select();
    setAltBufferActive(termRef.current?.buffer.active.type === "alternate");
  }, [searchOpen]);

  // 从聊天切到终端（>_、/terminal、快捷键都算）：光标落进终端，切过来就能打字。
  // 只认「整块终端从盖着变成露着」这一下——窥视条开合、挂载、换标签都不抢焦点
  const fullTerminal = !coveredByChat && !embedInPeek;
  const fullTerminalPrevRef = useRef(fullTerminal);
  useEffect(() => {
    const was = fullTerminalPrevRef.current;
    fullTerminalPrevRef.current = fullTerminal;
    if (!was && fullTerminal && visible && primaryFocus) termRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullTerminal]);

  // Cmd/Ctrl+F 呼出搜索条：只挂当前可见且活跃的 pane，保证只作用于活跃终端。
  // 终端聚焦时按键经 xterm 的 customKeyEventHandler 拦截（见创建 effect），这里兜底页面其余焦点。
  useEffect(() => {
    if (!visible || !primaryFocus) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.defaultPrevented && !e.altKey && !e.shiftKey && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        // Monaco 编辑器（文件预览）有自己的查找组件、md 阅读态有自己的查找条（md-find-scope），不劫持
        if (e.target instanceof Element && e.target.closest(".monaco-editor, .md-find-scope"))
          return;
        e.preventDefault();
        const inTerminal = e.target instanceof Element && e.target.closest(".xterm, [data-terminal-search]");
        if ((coveredByChat || embedInPeek) && !inTerminal) onSearchChat?.(tabId);
        else setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, primaryFocus, coveredByChat, embedInPeek, onSearchChat, tabId]);

  // —— 当前会话联动（SessionLink）：事件驱动刷新，签名轮询仅作兜底 ——
  const [sessionFile, setSessionFile] = useState<string | null>(null);
  const [linkedSessionId, setLinkedSessionId] = useState<string | null>(null);
  const [linkedSessionTitle, setLinkedSessionTitle] = useState<string | null>(
    null,
  );
  const [linkState, setLinkState] = useState<SessionLinkState["state"]>("idle");
  const [syncState, setSyncState] = useState<SessionLinkState["sync"]>("waiting");
  const [conv, setConv] = useState<ChatMessageDto[]>([]);
  // 结构化旁路快照（下方「聊天层结构化旁路」一节；前面几个 effect 要用到，所以声明放这里）
  const [channel, setChannel] = useState<ChatChannelSnapshot | null>(null);
  const channelRef = useRef<ChatChannelSnapshot | null>(null);
  const channelSeqSeenRef = useRef(0);
  const channelEndHandledRef = useRef<number | null>(null);
  const lastSendAtRef = useRef(0);
  const olderRef = useRef<ChatMessageDto[]>([]);
  const latestWindowRef = useRef<ChatMessageDto[]>([]);
  /** 上一次刷新解析出的最新一页（不含本地乐观消息）：算滑出窗口的那几条（slidOutOfWindow） */
  const prevParsedRef = useRef<ChatMessageDto[]>([]);
  /** 已经在后台接齐过更早记录的那份会话（agent + 文件），同一份不重复接 */
  const restForRef = useRef<string | null>(null);
  /** 摆着的记录转接回时，先把已接齐的更早记录留着；接上的正是同一份文件就原样放回，不再从头接一遍 */
  const carryOlderRef = useRef<{ filePath: string; older: ChatMessageDto[] } | null>(null);
  const convCursorRef = useRef<number | null>(null);
  const [convCursor, setConvCursor] = useState<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [pendingReply, setPendingReplyState] = useState(false);
  const pendingReplyRef = useRef(false);
  const agentProcRef = useRef({ running: false, shellActive: false });
  agentProcRef.current = { running, shellActive };
  // 本地即时/排队消息：已发送但会话文件尚未记下的用户消息队列（连发多条都保留）
  const pendingUsersRef = useRef<ChatMessageDto[]>([]);
  const pendingAssistantKeysRef = useRef<Set<string>>(new Set());
  const pendingReplyTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 等待回复轮询的起始时刻（3 分钟超时兜底用）
  const pendingReplySinceRef = useRef(0);
  function stopPendingReplyPolling() {
    if (pendingReplyTimerRef.current) {
      clearInterval(pendingReplyTimerRef.current);
      pendingReplyTimerRef.current = null;
    }
  }
  function startPendingReplyPolling() {
    if (pendingReplyTimerRef.current) return;
    pendingReplySinceRef.current = Date.now();
    pendingReplyTimerRef.current = setInterval(() => {
      if (!pendingReplyRef.current) {
        stopPendingReplyPolling();
        return;
      }
      // 兜底：回复永远不来（进程崩溃/会话文件写入失败）时 3 分钟后停轮询并摘掉「等待回复」。
      // Agent 还在跑就不超时——精读这种长工具回合经常超过 3 分钟。
      if (Date.now() - pendingReplySinceRef.current > 3 * 60 * 1000) {
        const live = agentProcRef.current;
        if (!live.running || live.shellActive) setPendingReply(false);
        return;
      }
      void fetchConversation(true);
    }, 700);
  }
  const setPendingReply = (value: boolean) => {
    pendingReplyRef.current = value;
    setPendingReplyState(value);
    // 每次进入等待都重置 3 分钟窗口（轮询已在跑时 start 会早退，超时不能按上一条消息算）
    if (value) {
      pendingReplySinceRef.current = Date.now();
      startPendingReplyPolling();
    } else stopPendingReplyPolling();
  };
  const lastResumeRef = useRef<string | null>(null);
  const linkCtxRef = useRef<{
    agentId: string;
    cwd: string;
    hint: string | null;
    filePath: string | null;
    /** 锁定的会话 id（liveSessions 登记用） */
    sessionId: string | null;
    createdAt: string | null;
  } | null>(null);
  const linkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 只看不接（2026-10-23 侧栏挂对话第一期）：标签带着要接的会话、还没起进程时，先把这段对话从会话文件读出来摆着，
  // 输入框照常能写，发第一句才接回（sendMessage 的恢复占位分支）。接上之后记录归 SessionLink 管。
  // 会话文件路径取本机会话列表里的那一条；列表里没有就不摆（退回「这段对话还没接回」）
  const previewFilePath = useAppStore((s) =>
    resumeSessionId && !customRuntimeId
      ? (s.sessions.find((x) => x.agent === agentId && x.sessionId === resumeSessionId)
          ?.filePath ?? null)
      : null,
  );
  // 记录页按会话更新时间认缓存：鼠标移到侧栏那一行时已经取过、来回切没变过的，点开不再重读（conversation-prefetch.ts）。
  // 只在第一次摆的时候读它（不进下面 effect 的依赖），列表刷新改了更新时间不触发重摆
  const previewVersion = useAppStore((s) =>
    resumeSessionId && !customRuntimeId
      ? (s.sessions.find((x) => x.agent === agentId && x.sessionId === resumeSessionId)
          ?.updatedAt ?? "")
      : "",
  );
  const previewVersionRef = useRef(previewVersion);
  previewVersionRef.current = previewVersion;
  const previewSrcRef = useRef<{ agentId: string; filePath: string } | null>(null);
  // 有记录可摆的标签一开始就算「在读」：第一次上报就不让聊天层画空态（下面的 effect 挂载后才跑，晚一帧）
  const [previewState, setPreviewState] = useState<"loading" | "shown" | null>(() =>
    previewFilePath ? "loading" : null,
  );
  /** 摆着的记录转接回的那一次 resetLink 不清空对话（见 sendMessage） */
  const keepPreviewConvRef = useRef(false);
  // 先启动 / 接回 Agent 再发的那一句正在路上（showEarlyBubble 到 launch 回来）：resetLink 不收「等回复」
  const earlyLaunchRef = useRef(false);
  // 绘制前摆：记录已经取回来（鼠标移上去时取过、点开前等过、刚看过）就在第一帧画出来，不先画一帧空白再出字
  //（2026-10-26 用户：切对话黑一下）
  useLayoutEffect(() => {
    if (running || shellActive || linkState !== "idle" || !previewFilePath) {
      setPreviewState(null);
      return;
    }
    // 已经摆过这一份（接回没成功又回到闲置）：不重读
    if (previewSrcRef.current?.filePath === previewFilePath) {
      setPreviewState("shown");
      return;
    }
    // 看到这个标签才读：重启后恢复出一排占位标签时不一次全读
    if (!visible) return;
    let stale = false;
    const src = { agentId, filePath: previewFilePath };
    const show = (page: ConversationPageDto) => {
      previewSrcRef.current = src;
      olderRef.current = [];
      restForRef.current = null;
      latestWindowRef.current = page.messages;
      convCursorRef.current = page.cursor;
      setConvCursor(page.cursor);
      setConv(page.messages);
      setPreviewState("shown");
      if (page.cursor != null) {
        void loadRestOfConversation(src, page.cursor, () => !linkCtxRef.current && previewSrcRef.current === src);
      }
    };
    const ready = cachedConversationPage(src.agentId, src.filePath, previewVersionRef.current);
    if (ready && !linkCtxRef.current) {
      show(ready);
      return;
    }
    setPreviewState("loading");
    conversationPageFor(src.agentId, src.filePath, previewVersionRef.current)
      .then((page) => {
        if (stale || linkCtxRef.current) return;
        show(page);
      })
      .catch(() => {
        // 读不出就不摆，聊天层退回「这段对话还没接回」，发一句照样接回
        if (!stale) setPreviewState(null);
      });
    return () => {
      stale = true;
    };
  }, [running, shellActive, linkState, previewFilePath, agentId, visible]);
  const sessionWatchIdRef = useRef<string | null>(null);
  const sessionWatchUnlistenRef = useRef<(() => void) | null>(null);
  const sessionWatchStartingRef = useRef(false);
  const linkStartedAtRef = useRef(0);
  const conversationRequestRef = useRef(0);
  // 收尾被 ptyLive 推迟后的保证重试定时器（去重：同屏最多挂一个）
  const settleRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoTitleEarlyRef = useRef(false);
  /** 已触发过的中途校正节点（autoTitleMilestone），0 = 还没触发 */
  const autoTitleMilestoneRef = useRef(0);
  const setLiveSession = useAppStore((s) => s.setLiveSession);
  const setOpenSessionReq = useAppStore((s) => s.setOpenSessionReq);
  const setPage = useAppStore((s) => s.setPage);

  const agentProfiles = profiles.filter((p) => p.agent === agentId);
  // 「隐藏」的配置：只在启动栏下拉里沉到「已停用」分组，不影响可用性
  const hiddenProfiles = settings?.hiddenProfiles ?? [];
  const profileMenuLabel = (p: (typeof agentProfiles)[number]): string =>
    p.accountType === "official" && officialSt && !officialSt.connected
      ? `${p.name}（未登录）`
      : p.name;
  const profileMenuOptions: LaunchMenuOption[] = [
    ...(profileId && !selectedProfile
      ? [{ value: profileId, label: "上次配置已不存在" }]
      : []),
    ...agentProfiles
      .filter((p) => !hiddenProfiles.includes(p.id))
      .map((p) => ({ value: p.id, label: profileMenuLabel(p) })),
    ...agentProfiles
      .filter((p) => hiddenProfiles.includes(p.id))
      .map((p) => ({
        value: p.id,
        label: profileMenuLabel(p),
        group: "已停用（可手选）",
      })),
  ];
  // 这个标签里人手换过 Agent / 连接（启动栏、聊天菜单、「最近用过」）：之后换项目不再自动带项目默认，免得覆盖人的选择
  const agentPickedByHandRef = useRef(false);
  // 刚按项目默认换了 Agent：聊天输入框上短暂写「按项目默认」
  const [launchAutoNote, setLaunchAutoNote] = useState<string | null>(null);
  useEffect(() => {
    if (!launchAutoNote) return;
    const t = window.setTimeout(() => setLaunchAutoNote(null), 4000);
    return () => window.clearTimeout(t);
  }, [launchAutoNote]);
  // 启动栏三段选择的唯一写入口：终端启动栏与聊天输入框的开聊前选择共用，两边改的是同一份
  function pickLaunchAgent(id: string) {
    agentPickedByHandRef.current = true;
    setAgentId(id);
    setProfileId("");
    setModel("");
    setModelKept(false);
  }
  function pickLaunchProfile(id: string) {
    agentPickedByHandRef.current = true;
    const prevModels = profiles.find((p) => p.id === profileId)?.models ?? [];
    const prof = profiles.find((p) => p.id === id);
    setProfileId(id);
    // 手填的模型不再被静默清掉：不在新配置模型表里就保留，
    // 并由下方说明行告知「仍会按原样注入」
    const next = modelOnProfileSwitch(model, prevModels, prof?.models ?? []);
    setModel(next.model);
    setModelKept(next.kept);
  }
  function pickLaunchModel(m: string) {
    setModel(m);
    setModelKept(false);
  }
  /** 「最近用过」的搭配：三样一起换（换 Agent 的默认连接预选只在 profileId 为空时跑，这里一并给了不会被它顶掉） */
  function applyLaunchCombo(c: { agentId: string; profileId: string; model: string }) {
    if (running) return;
    agentPickedByHandRef.current = true;
    setAgentId(c.agentId);
    setProfileId(c.profileId);
    setModel(c.model);
    setModelKept(false);
    setLaunchAutoNote(null);
  }
  // —— 聊天里换一家接着做（docs/design-chat-relay.md）：选了目标先挂着，发下一句时才交接 ——
  const [relayPick, setRelayPick] = useState<RelayTarget | null>(null);
  const relayPickRef = useRef<RelayTarget | null>(null);
  relayPickRef.current = relayPick;
  const [relayOptions, setRelayOptions] = useState<RelayOptionDto[]>([]);
  /** 换好 Agent 之后才能按新那家启动（launch 读的是这一帧的 agentId / profileId）：挂在这里，下一帧的 effect 接着跑 */
  const relayJobRef = useRef<{
    target: RelayTarget;
    prepared: RelayPrepareDto;
    message: string;
    source: { agentId: string; profileId: string; model: string; sessionId: string };
    early: { reRegister: () => void; retract: () => void };
    resolve: (r: ChatSendResult) => void;
  } | null>(null);
  const [relayTick, setRelayTick] = useState(0);
  /** 接手那家没起来、退回原来那家后：下一句接回原来那段，不另开 */
  const relayBackRef = useRef<string | null>(null);
  /** 这段对话的来源（接力要有记录）：在跑的取认领到的会话，只看没接的取摆着的那段 */
  function relaySource() {
    if (customRuntimeId) return null;
    const ctx = linkCtxRef.current;
    const sessionId =
      ctx?.sessionId ?? linkedSessionId ?? relayBackRef.current ?? (running ? null : resumeSessionId) ?? null;
    const filePath = ctx?.filePath ?? sessionFile ?? previewFilePath ?? null;
    if (!sessionId || !filePath) return null;
    return {
      agent: ctx?.agentId ?? agentId,
      sessionId,
      filePath,
      cwd,
      title: linkedSessionTitle ?? null,
    };
  }
  function pickRelay(target: RelayTarget | null) {
    setRelayPick(target);
  }
  function loadRelayOptions() {
    const source = relaySource();
    if (!source) return;
    const targets = launchAgents
      .filter((a) => a.id !== source.agent && a.binaryPath)
      .map((a) => {
        const remembered = localStorage.getItem(`ccode.lastProfile.${a.id}`);
        const prof =
          profiles.find((p) => p.id === remembered && p.agent === a.id) ?? profiles.find((p) => p.agent === a.id);
        return { agent: a.id, model: prof?.models[0] ?? null };
      });
    invoke<RelayOptionDto[]>("relay_options", { source, targets })
      .then(setRelayOptions)
      .catch(() => setRelayOptions([]));
  }
  /**
   * 开聊前换目录（聊天项目弹层、把文件夹拖进来、终端空态卡的目录菜单）。随手聊目录可能还没建：与快速开聊同一个后端入口创建。
   * 选的是已添加的项目、且这个标签没手动换过 Agent：按项目里「＋ 新对话」同一条塔带上用谁（chat 槽 > 项目默认，2026-10-22）
   */
  async function pickDir(pick: DirPick) {
    if (running) return;
    if (pick.kind === "scratch") {
      try {
        setWorkingDirectory(await invoke<string>("ensure_scratch_dir"));
      } catch (reason) {
        setError(`随手聊目录创建失败：${String(reason)}`);
      }
      return;
    }
    if (pick.kind === "home") {
      setWorkingDirectory("~");
      return;
    }
    setWorkingDirectory(pick.path);
    if (agentPickedByHandRef.current) return;
    try {
      const list = await invoke<ProjectDto[]>("list_projects");
      const project = list.find((p) => samePath(p.path, pick.path, IS_WINDOWS));
      const launchTo = projectChatLaunch(profiles, project ?? null);
      if (!launchTo) return;
      const changed = launchTo.agentId !== agentId || launchTo.profileId !== profileId;
      setAgentId(launchTo.agentId);
      setProfileId(launchTo.profileId);
      setModel(launchTo.model);
      setModelKept(false);
      if (changed) setLaunchAutoNote("按项目默认");
    } catch {
      // 读不到项目表：只换目录，用谁照旧
    }
  }
  function openNewProject() {
    useAppStore.getState().setNewProjectOpenReq({ token: Date.now(), returnTabId: tabId });
  }
  // 开聊前的思考档（2026-10-17 用户选定）：与开工弹层同一判定——只有该 Agent + 连接 + 模型
  // 有启动注入通道（combo_surface.injectEffortAllowed）才给档位；值是本次覆盖（标签 effort），不写回连接
  const launchAgents = useAppStore((s) => s.agents);
  const effectiveLaunchModel = model.trim() || selectedProfile?.models[0] || "";
  const [launchEffortInjectable, setLaunchEffortInjectable] = useState(false);
  useEffect(() => {
    if (running || !profileId || !effectiveLaunchModel) {
      setLaunchEffortInjectable(false);
      return;
    }
    let stale = false;
    invoke<{ injectEffortAllowed?: boolean }>("combo_surface", {
      profileId,
      model: effectiveLaunchModel,
    })
      .then((c) => {
        if (!stale) setLaunchEffortInjectable(c.injectEffortAllowed === true);
      })
      .catch(() => {
        if (!stale) setLaunchEffortInjectable(false);
      });
    return () => {
      stale = true;
    };
  }, [running, profileId, effectiveLaunchModel]);
  const launchAgentDet = launchAgents.find((a) => a.id === agentId);
  const launchAgentDetRef = useRef(launchAgentDet);
  launchAgentDetRef.current = launchAgentDet;
  // 这次运行用的权限（读会话里的实际档时判断「上一次运行留下的那条算不算」）
  const permissionRef = useRef(permission);
  permissionRef.current = permission;
  const permissionModeRef = useRef(permissionMode);
  permissionModeRef.current = permissionMode;
  // 从会话文件读到的实际权限档（Kimi / Codex）：徽标写它，不加「已选 ·」
  const [observedTier, setObservedTier] = useState<"ask" | "auto" | "full" | null>(null);
  const launchEffortLevels = useMemo(
    () => {
      const levels = launchAgentDet?.effort?.levels;
      // 只有注入通道、没有原生档表的 agent（codex 配置注入）给通用三档（同开工弹层）
      return levels?.length ? levels : ["low", "medium", "high"];
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [launchAgentDet?.effort?.levels?.join(",")],
  );
  // 这家 CLI 本机默认权限（只读探查，cli_permission.rs）：如实告诉用户会不会先问
  const [cliPermissionNote, setCliPermissionNote] = useState<CliPermissionNote | null>(null);
  useEffect(() => {
    let stale = false;
    invoke<CliPermissionNote | null>("cli_default_permission", {
      agent: agentId,
    })
      .then((note) => {
        if (!stale) setCliPermissionNote(note ?? null);
      })
      .catch(() => {
        if (!stale) setCliPermissionNote(null);
      });
    return () => {
      stale = true;
    };
  }, [agentId]);
  // 开聊前选择给聊天层的那一份：恢复占位 / 自定义运行时 / 已在跑的标签不可改
  const launchPickEditable =
    !running && !shellActive && !restored && !customRuntimeId && !resumeSessionId && !forkSessionId;
  const launchPick = useMemo<LaunchPickState>(
    () => ({
      editable: launchPickEditable,
      resumeSessionId:
        !running && !shellActive && !customRuntimeId ? (resumeSessionId ?? null) : null,
      preview: previewState,
      resumePick: previewState === "shown" && !running && !shellActive && !customRuntimeId,
      agentId,
      profileId,
      model,
      profiles: profileMenuOptions,
      models: modelOptions,
      effort: effortOverride?.trim() ?? "",
      effortLevels: launchEffortInjectable ? launchEffortLevels : [],
      permission: permission ?? (readonly ? "discuss" : "write_tree"),
      permissionMode,
      permissionModes: launchAgentDet?.permissionModes ?? [],
      readonlySupported: launchAgentDet?.readonlySupported ?? false,
      permissionNote: cliPermissionNote,
      observedTier,
      autoNote: launchAutoNote,
    }),
    // profileMenuOptions 每次渲染新建，按其内容签名判等
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      launchPickEditable,
      running,
      shellActive,
      resumeSessionId,
      previewState,
      agentId,
      profileId,
      model,
      modelOptions,
      profileMenuOptions.map((o) => `${o.value}\t${o.label}\t${o.group ?? ""}`).join("\n"),
      effortOverride,
      launchEffortInjectable,
      launchEffortLevels,
      permission,
      permissionMode,
      readonly,
      launchAgentDet?.readonlySupported,
      launchAgentDet?.permissionModes?.join(","),
      cliPermissionNote,
      observedTier,
      launchAutoNote,
    ],
  );
  // 启动栏「权限」格与「这次启动」卡（2026-10-18 与聊天输入框同步）：值 = 只讨论 / 手选的原生档 /
  // 本机设置对应的那档；都没有为 ""（本机设置对应不上四档）。改档写标签（onPatchLaunch），与聊天输入框同一份
  const permFollowsLocal =
    launchPick.permission !== "discuss" && launchPick.permissionMode === null;
  const permTier: PermissionTier | "" =
    launchPick.permission === "discuss"
      ? "discuss"
      : (launchPick.permissionMode ?? cliPermissionNote?.tier ?? "");
  const permAvailable = (id: PermissionTier) =>
    id === "discuss" ? launchPick.readonlySupported : launchPick.permissionModes.includes(id);
  const permOptions = PERMISSION_TIERS.map((t) => {
    const ok = permAvailable(t.id);
    return {
      value: t.id,
      label: t.label,
      disabled: !ok,
      title: ok ? t.desc : `${agentLabel(agentId)} 没有这一档的启动参数`,
      hint: !ok
        ? "没有这一档"
        : permFollowsLocal && cliPermissionNote?.tier === t.id
          ? "本机设置"
          : undefined,
      tone: t.id === "full" ? ("warn" as const) : undefined,
    };
  });
  const permText =
    PERMISSION_TIERS.find((t) => t.id === permTier)?.label ??
    cliPermissionNote?.short ??
    "默认权限";
  // 「这次启动」卡里可换的连接：同一家 Agent 的其他连接（不含当前、不含已停用的；与连接出错提示同口径）
  const launchInfoAlternatives = profiles.filter(
    (p) =>
      p.agent === agentId &&
      p.id !== profileId &&
      !(settings?.hiddenProfiles ?? []).includes(p.id),
  );
  /** 改权限：完全访问二次确认；live = 进程在跑（换了要重开接回）。返回是否真改了 */
  async function pickLaunchPermission(id: PermissionTier, live: boolean): Promise<boolean> {
    if (!(await confirmPermissionChoice(agentLabel(agentId), id, live))) return false;
    onPatchLaunch?.(
      tabId,
      id === "discuss"
        ? { permission: "discuss", permissionMode: null }
        : { permission: "write_tree", permissionMode: id },
    );
    return true;
  }

  const [skillCount, setSkillCount] = useState(0);
  // 当前 Agent 已启用的技能清单（技能页开关同步）；「插入」菜单一键使用
  const [agentSkills, setAgentSkills] = useState<SkillDto[]>([]);
  // 当前 Agent 已分发的 MCP server 清单（MCP 页开关同步）；「插入」菜单一键提及/管理
  const [agentMcps, setAgentMcps] = useState<McpServerDto[]>([]);
  // 技能 + MCP 合并为一颗「插入」pill（聊天输入条「插入」菜单同口径），
  // 收缩态右侧只留 插入/修改/⋯ 三件，替代原先两粒常驻计数胶囊
  // 菜单只有一份状态，但有两个锚点：收缩状态行「插入」(bar) 与标签栏 ✦ (tab)。
  // 原先共用一个布尔，两处弹层同时渲染——运行中点插入出现两个列表（2026-10-17 修）
  const [insertMenuFrom, setInsertMenuFrom] = useState<"bar" | "tab" | null>(null);
  const [insertTabAnchor, setInsertTabAnchor] = useState<{ left: number; bottom: number } | null>(null);
  // 高级启动项默认收起：主栏回答「用谁、用哪个模型、在哪运行」；
  // 首条指令收进高级选项，技能/MCP 保留为运行时常驻入口。
  const [advancedLaunchOpen, setAdvancedLaunchOpen] = useState(!!presetPrompt);
  advancedLaunchOpenRef.current = advancedLaunchOpen;
  const [launchInfoOpen, setLaunchInfoOpen] = useState(false);
  // 向上弹出菜单的锚点与动态限高：固定 224px 在锚点上方空间不足时会顶出屏幕
  const insertAnchor = useRef<HTMLSpanElement>(null);
  const [insertMenuMaxH, setInsertMenuMaxH] = useState(224);

  /** 向上弹出菜单的限高：锚点上方可用空间 - 8px 边距，夹在 [96, 224] */
  function upMaxH(anchor: HTMLElement | null) {
    if (!anchor) return 224;
    return Math.max(
      96,
      Math.min(224, Math.floor(anchor.getBoundingClientRect().top) - 8),
    );
  }

  // 当前 Agent 已启用的技能数与清单（技能页开关同步）+ 已分发的 MCP server（MCP 页开关同步）
  useEffect(() => {
    invoke<SkillDto[]>("list_skills")
      .then((all) => {
        const mine = all.filter((s) => s.apps[agentId]);
        setAgentSkills(mine);
        setSkillCount(mine.length);
      })
      .catch(() => {
        setAgentSkills([]);
        setSkillCount(0);
      });
    invoke<McpServerDto[]>("list_mcp_servers")
      .then((all) => setAgentMcps(all.filter((s) => s.apps[agentId])))
      .catch(() => setAgentMcps([]));
  }, [agentId]);

  /** 一键使用技能：运行中注入当前终端输入框（不自动发送）；未启动写进首条指令 */
  function useSkill(name: string) {
    const text = `使用 ${name} 技能：`;
    if (running && activePtyId) {
      writeInteractivePty(activePtyId, text);
    } else {
      setShowPrompt(true);
      setAdvancedLaunchOpen(true);
      setPromptText((t) => (t ? `${t}\n${text}` : text));
    }
    setInsertMenuFrom(null);
  }

  /** 一键提及 MCP server：同技能注入机制（提示 Agent 调用其工具；分发变更对新会话生效） */
  function useMcp(name: string) {
    const text = `使用 ${name} 这个 MCP server 提供的工具：`;
    if (running && activePtyId) {
      writeInteractivePty(activePtyId, text);
    } else {
      setShowPrompt(true);
      setAdvancedLaunchOpen(true);
      setPromptText((t) => (t ? `${t}\n${text}` : text));
    }
    setInsertMenuFrom(null);
  }

  /** 插入菜单的条目（技能 / MCP 两段 + 管理分发）：状态行与标签栏两个锚点共用同一份，
      原先标签栏那份是没有分段标题和说明的简版，两处长得不一样 */
  function renderInsertItems() {
    return (
      <InsertMenuItems
        skills={agentSkills}
        mcps={agentMcps}
        onSkill={useSkill}
        onMcp={useMcp}
        onManageMcp={() => {
          setInsertMenuFrom(null);
          setPage("mcp");
        }}
      />
    );
  }

  /** 「插入」pill：技能 + MCP 合并为一颗（聊天输入条「插入」菜单同口径）。
      up=true 向上弹出，收缩栏在页面顶部须向下；alignRight=true 右对齐——
      收缩态 pill 在 ml-auto 右侧，默认左对齐会溢出屏幕右缘。两边都空不渲染。 */
  function renderInsertMenu(up: boolean, alignRight = false) {
    if (agentSkills.length === 0 && agentMcps.length === 0) return null;
    return (
      <span className="relative" ref={insertAnchor}>
        <button
          type="button"
          onClick={() => {
            // 打开（向上弹）时按锚点上方空间重新限高
            if (up && insertMenuFrom !== "bar")
              setInsertMenuMaxH(upMaxH(insertAnchor.current));
            setInsertMenuFrom((v) => (v === "bar" ? null : "bar"));
          }}
          title={`已启用 ${skillCount} 个技能、${agentMcps.length} 个 MCP，点击插入`}
          aria-expanded={insertMenuFrom === "bar"}
          className="rounded-sm px-1.5 py-0.5 text-l3 hover:bg-hover hover:text-l1"
        >
          插入
        </button>
        {insertMenuFrom === "bar" && (
          <>
            {/* 点击浮层外任意处关闭 */}
            <div
              className="fixed inset-0 z-40"
              onClick={() => setInsertMenuFrom(null)}
            />
            {/* 高度随锚点上方空间收缩，防顶出屏幕 */}
            <ul
              style={{ maxHeight: up ? insertMenuMaxH : 224 }}
              className={`absolute ${up ? "bottom-full mb-1" : "top-full mt-1"} ${alignRight ? "right-0" : "left-0"} z-50 w-72 overflow-auto rounded-md border border-field ccode-float-surface p-1`}
            >
              {renderInsertItems()}
            </ul>
          </>
        )}
      </span>
    );
  }

  const [activePtyId, setActivePtyId] = useState<string | null>(null);
  // 向标签条上报标题/运行状态；值没变就不惊动父组件。
  // 未启动的标签用「当前启动配置」当标题（Agent · 配置，随启动栏选择实时变）——
  // 多开时一排「未启动」无法区分（用户反馈）；启动后仍走会话标题链
  const neverLaunched = !activePtyId && !running && !shellActive;
  const launchIdentity = neverLaunched
    ? selectedProfile
      ? `${agentLabel(agentId)} · ${selectedProfile.name}`
      : agentLabel(agentId)
    : "";
  // 已启动标签：身份前缀（Agent · 配置）+ 目录名——收缩行被隐藏后这是标签上
  // 唯一的身份信息；同目录多开的终端靠它区分（纯 shell 标签没有 Agent，前缀为空）
  const startedIdentity =
    activePtyId || running || shellActive
      ? [
          selectedProfile
            ? `${agentLabel(agentId)} · ${selectedProfile.name}`
            : agentLabel(agentId),
          cwd ? basename(cwd) : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : "";
  const title =
    // 随手聊：发第一句前输入框里还能换 Agent，标题跟着当前选的那家走
    (reuseKey?.startsWith(QUICK_CHAT_KEY_PREFIX) ? `随手聊 · ${agentLabel(agentId)}` : "") ||
    initialTitle?.trim() ||
    launchIdentity ||
    startedIdentity ||
    idleTabTitle(cwd, isTerminalIdle({ ptyId: activePtyId })) ||
    (cwd ? basename(cwd) : "") ||
    "终端";
  // 真实 cwd 跟随：进程存活期间每 4s 问一次后端 PTY 进程的真实 cwd——shell 内 cd 后
  // 文件树/git 面板也能跟上（此前只认启动栏路径，切标签「不跟随」的根源之一）。
  // 未启动时的目录编辑：空态卡「将在 … 启动」点选文件夹；底栏胶囊可键入路径（启动前生效，与轮询不冲突）
  useEffect(() => {
    if (!visible || !activePtyId || (!running && !shellActive)) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const real = await invoke<string | null>("pty_get_cwd", {
          ptyId: activePtyId,
        });
        if (!cancelled && real) {
          setCwd((cur) => (cur === real ? cur : real));
          // Agent 自己的真实目录就是这条 Run 的目录（启动栏写的可能是软链 / ~ 写法，后端按 canonical 记）：
          // 跟着改绑定身份，免得下次启动把同一处目录认成换了、丢掉原会话。回落 shell 里 cd 走才算换目录
          if (running && !shellActive && boundIdentityRef.current) {
            boundIdentityRef.current = { ...boundIdentityRef.current, cwd: real };
          }
        }
      } catch {
        /* PTY 已退出 / 平台不支持（Windows 返回 null 走不到这）：静默 */
      }
    };
    void tick();
    const unpoll = pollEvery(tick, 4000);
    return () => {
      cancelled = true;
      unpoll();
    };
  }, [visible, activePtyId, running, shellActive]);

  // 空态引导卡可见性（画布中央卡片 + 启动栏主按钮降级 + ⌘↵ 快捷键共用同一条件）
  const welcomeVisible = !shellOnly && !running && !shellActive;
  // 退出码白话（后端 pty-exit 的 payload 已接住）：状态行与紧凑行共用同一份解释。
  const exitSummary = exitCode === null ? null : exitCodeSummary(exitCode);
  // 启动栏第二行（状态提示行）有内容才渲染——只有 ⋯ 时整行像悬空碎片（v3.92 修）
  const showBarMeta = !!(
    error ||
    notice ||
    cwdIssue ||
    (initialExtraEnv && Object.keys(initialExtraEnv).length > 0) ||
    (!running &&
      (shellActive || exited))
  );
  // ⌘↵ 直启动作经 ref 转发（xterm 键盘层 handler 是挂载期闭包，只能经 ref 拿最新状态）
  const launchNowRef = useRef<() => void>(() => {});
  launchNowRef.current = () => {
    if (!profileId && !customRuntimeId) return;
    if (restored && !customRuntimeId) void restoreTask();
    else void launch();
  };
  const welcomeVisibleRef = useRef(welcomeVisible);
  welcomeVisibleRef.current = welcomeVisible;
  // xterm 键盘层 handler 是挂载期闭包，agentId 也要经 ref 拿最新值（切 Agent 后 Enter/Ctrl+V 改写才跟随）
  const agentIdRef = useRef(agentId);
  agentIdRef.current = agentId;
  // ⌘/Ctrl+Enter 直接启动（打字中不抢；终端聚焦时按键被 xterm 吞掉、走不到 window，
  // 那条路径由 attachCustomKeyEventHandler 里的同款分支兜底——与 ⌘F 同一处理模式）
  useEffect(() => {
    if (!visible || !primaryFocus || !welcomeVisible) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
      const el = document.activeElement as HTMLElement | null;
      if (el) {
        const tag = el.tagName;
        const typing =
          (tag === "TEXTAREA" &&
            !el.classList.contains("xterm-helper-textarea")) ||
          tag === "INPUT" ||
          tag === "SELECT" ||
          el.isContentEditable;
        if (typing) return;
      }
      e.preventDefault();
      launchNowRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, primaryFocus, welcomeVisible]);
  const [runId, setRunId] = useState<string | null>(initialRunId ?? null);
  // 轮询 / 旁路回调的闭包是 launch 那一轮捕获的，那时 setRunId 还没生效——在里面读 runId 永远是旧值（新标签是 null），
  // lockLink 就不给 Run 登记会话，换权限重开时报「此 Run 不支持恢复」（2026-10-21：Gemini / Kimi / OpenCode 的交互 Run
  // 全都没登记会话）。闭包里一律读这个 ref
  const runIdRef = useRef<string | null>(runId);
  runIdRef.current = runId;
  // 手上那条 Run 绑定时的身份：本次挂载里启动成功时记下；恢复出的标签（带 initialRunId、还没启动过）取挂载时的值。
  // launch 拿它和这次启动比，换了目录 / Agent / 权限就另开 Run（compareRunIdentity）
  const boundIdentityRef = useRef<RunIdentity | null>(
    initialRunId
      ? { agentId, cwd, permission: permission ?? (readonly ? "discuss" : "write_tree") }
      : null,
  );
  const [attention, setAttention] = useState<TabStatus["attention"]>(null);
  // PTY 输出静默计时：working 标由输出事件打起，静默后按 onPtyWorkingSilence 熄灭
  const lastOutputAtRef = useRef(0);
  // 拉起后的第一次发送要等 CLI 进入读键状态：进程刚起来时写进去的字先被终端行规程回显、
  // 回车跟着成了「开屏前预输入」的一部分——字落进输入框却没提交，聊天层还记成已发出
  // （2026-10-18 阅读区简报实测：Claude Code 拉起后 50ms 内写入必现，等它画出界面再安静 400ms 后 3/3 正常）
  const ptyAttachedAtRef = useRef(0);
  const inputReadyRef = useRef(true);
  // 最近一次画出字（剥掉终端查询后还有内容）的时刻：只发了查询的帧不算「画出了界面」
  const lastDrawAtRef = useRef(0);
  // 这次拉起的启动阶段已过（见过输入框 / 回合已开始）：之后不再扫信任菜单（scanTrustPromptSoon）
  const startupSettledRef = useRef(false);
  // 用户刚提交一轮（聊天发送 / 回车 / 带指令的新启动）：允许 PTY 点亮转圈。
  // 启动或恢复会话本身不点亮——TUI 启动画面不是「正在生成回答」。
  const ptyWorkingArmedRef = useRef(false);
  const hadPtyWorkingOutputRef = useRef(false);
  function armPtyWorking() {
    // 发了下一句：屏上已有的错误算看过，这一轮再出错才提示
    if (rawConnIssueRef.current) dismissConnIssue();
    ptyWorkingArmedRef.current = true;
    hadPtyWorkingOutputRef.current = false;
    setAttention("working");
    // 这一轮里弹出的审批菜单要认；发送前屏上已有的「像菜单」的东西记作基线
    menuBaselineRef.current = screenMenu();
  }
  function disarmPtyWorking() {
    ptyWorkingArmedRef.current = false;
    hadPtyWorkingOutputRef.current = false;
    setAttention((prev) => (prev === "working" ? null : prev));
  }
  // 按了 Esc（聊天层停止按钮 / 终端里）之后收旁路的回合：Claude 还没出字就被打断时把这句退回输入框，会话文件里只留这句提问——
  // 没有打断标记、没有 turn_duration，也不发 Stop，旁路回合一直「在回复」，聊天层停下后过一会又被它点亮成「思考中」
  // （2026-10-26 用户 Windows 实测；e2e_channel E2E_INTERRUPT_MS 核对过 Esc 1.5 秒后回合仍是 running）。
  // 屏上连着两次看不到「esc to interrupt」和转圈行（claudeTurnActiveOnScreen）= 真停了，才收；还在跑（Esc 被菜单之类吃掉）就不动，最多看 4.5 秒
  const escSettleTimerRef = useRef<number | null>(null);
  function settleAfterEsc() {
    if (launchAgentRef.current !== "claude-code") return;
    if (escSettleTimerRef.current) window.clearTimeout(escSettleTimerRef.current);
    let tries = 0;
    let quiet = 0;
    const check = () => {
      escSettleTimerRef.current = null;
      const ch = channelRef.current;
      if (!mountedRef.current || ch?.kind !== "hooks" || !channelTurnOpen(ch)) return;
      quiet = claudeTurnActiveOnScreen(screenLines()) ? 0 : quiet + 1;
      if (quiet >= 2) {
        void invoke<boolean>("chat_channel_settle_interrupted", { tabId }).catch(() => false);
        return;
      }
      if (++tries < 15) escSettleTimerRef.current = window.setTimeout(check, 300);
    };
    escSettleTimerRef.current = window.setTimeout(check, 300);
  }
  // 用户交互时间（终端里敲键 / 点击引起的焦点进出）：TUI 开了焦点上报（mode 1004）
  // 时点一下输入框就会让 TUI 重绘一帧，按键回显同理——这些用户自己引发的重绘
  // 不是「生成中」，交互后短窗口内的 PTY 输出不打 working（否则点下输入框就转圈）
  const lastInteractionAtRef = useRef(0);
  function markInteraction() {
    lastInteractionAtRef.current = Date.now();
  }
  // hooks 精确注意力 confirm 时的「在等什么」摘要（审批卡片用；无 hooks/无详情字段为 null）
  const [confirmDetail, setConfirmDetail] = useState<string | null>(null);
  // 启动时的「是否信任这个目录」菜单：会话文件出现前它挡在前面，聊天层看不到（trust-prompt.ts）
  const [trustPrompt, setTrustPrompt] = useState<TrustPrompt | null>(null);
  const trustPromptRef = useRef<TrustPrompt | null>(null);
  // PTY 静止：聊天层判断「等不到会话文件」是卡在菜单上，还是模型只是慢（转圈动画一直在出字）
  const [ptyQuiet, setPtyQuiet] = useState(false);
  const ptyQuietRef = useRef(false);
  const [stalled, setStalled] = useState(false);
  const stalledRef = useRef(false);
  const trustScanTimerRef = useRef<number | null>(null);
  const trustAnsweringUntilRef = useRef(0);
  function scanTrustPromptSoon() {
    // 过了启动阶段就不会再有信任菜单；正挂着一个时继续扫，菜单消失要能撤掉。
    // 原先以「会话已接上」为界：Claude / CodeBuddy 的 SessionStart hook 一起来就报了会话文件，信任菜单还在后头，
    // 聊天层不再扫屏、看不到菜单（2026-10-21 用户：CodeBuddy 发第一条，终端弹出是否信任，聊天层不显示）
    if (!trustPromptRef.current && trustScanSettled()) return;
    if (trustScanTimerRef.current) window.clearTimeout(trustScanTimerRef.current);
    trustScanTimerRef.current = window.setTimeout(() => {
      trustScanTimerRef.current = null;
      // 正在替人挪高亮、核对完才回车（answerTrust）：挪到一半的菜单不拿回来当卡片
      const hold = trustAnsweringUntilRef.current - Date.now();
      if (hold > 0) {
        window.setTimeout(scanTrustPromptSoon, hold);
        return;
      }
      const term = termRef.current;
      if (!term || ptyKindRef.current !== "agent") return;
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < term.rows; i++) {
        lines.push(buf.getLine(buf.viewportY + i)?.translateToString(true) ?? "");
      }
      const next = parseTrustPrompt(lines);
      if (next) trustOptionsRef.current = next.options;
      // 画出了输入框、或这一轮已经开始干活：启动阶段过了
      else if (terminalHasInputBox(lines, launchAgentRef.current) === true || channelRef.current?.turn) {
        startupSettledRef.current = true;
      }
      if (sameTrustPrompt(trustPromptRef.current, next)) return;
      trustPromptRef.current = next;
      setTrustPrompt(next);
    }, 250);
  }
  /** 启动阶段（信任菜单只在这时出现）是否已过：见过输入框 / 回合已开始；认不得画面、又没有旁路的家照旧以会话接上为界 */
  function trustScanSettled(): boolean {
    if (startupSettledRef.current) return true;
    return Boolean(
      linkCtxRef.current?.filePath && !liveReplySupported(launchAgentRef.current) && !channelRef.current,
    );
  }
  useEffect(() => {
    if (!running) {
      if (ptyQuietRef.current) {
        ptyQuietRef.current = false;
        setPtyQuiet(false);
      }
      if (stalledRef.current) {
        stalledRef.current = false;
        setStalled(false);
      }
      return;
    }
    const timer = window.setInterval(() => {
      const silence = Date.now() - lastOutputAtRef.current;
      if (!stalledRef.current && lastOutputAtRef.current > 0 && silence >= STALLED_MS) {
        stalledRef.current = true;
        setStalled(true);
      }
      if (ptyQuietRef.current) return;
      if (silence >= 4000) {
        ptyQuietRef.current = true;
        setPtyQuiet(true);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  // 切模型 / 思考档的确认菜单：runTuiCommand 写完命令开 5 秒窗口扫屏；菜单挂着时继续扫到它消失。
  // 2026-10-18 第三期起，用户发出一句后、这一轮没结束前也扫：工具审批（Claude「Do you want to proceed?」、
  // Codex「Would you like to run…」、Qwen / Gemini「Allow execution…」、Kimi「Run this command?」、Grok 单选）都是
  // 带序号的菜单，聊天层按原文给按钮。各家只认回车 / 方向键 / 序号，按 y 不一定管用（Claude 2.1.292 实测按 y 没反应）
  const [menuPrompt, setMenuPrompt] = useState<TuiMenu | null>(null);
  const menuPromptRef = useRef<TuiMenu | null>(null);
  const menuWatchUntilRef = useRef(0);
  const menuScanTimerRef = useRef<number | null>(null);
  const menuSyncWaitsRef = useRef(0);
  // 发命令那一刻屏上已经「像菜单」的东西（如对话记录里一段多行提问）：之后再认出同一个不算
  const menuBaselineRef = useRef<TuiMenu | null>(null);
  // 最近一次从聊天发出的话：扫审批菜单时排除它的回显
  const lastSentRef = useRef("");
  // 见过的启动信任菜单的选项：同一组选项以后不再当通用确认菜单报
  const trustOptionsRef = useRef<string[] | null>(null);
  function screenMenu(): TuiMenu | null {
    return parseScreenMenu(screenLines());
  }
  /** 可视区第 row 行每个字的样子（灰字 / 反色 / 底色；screen-cells.ts） */
  function screenCells(row: number) {
    const term = termRef.current;
    if (!term) return [];
    const buf = term.buffer.active;
    return lineCells(buf.getLine(buf.viewportY + row));
  }
  /** 可视区第 row 行整行是斜体（Kimi 收起的思考，live-reply.ts Layout.thinkItalic） */
  function screenItalicRow(row: number) {
    return italicLine(screenCells(row));
  }
  /** 屏上等你选的东西：Claude 的提问表单按表单读（tui-ask.ts），其余照通用菜单读（Kimi 选择器的说明行靠字色分开） */
  function parseScreenMenu(lines: string[]): TuiMenu | null {
    const ask = launchAgentRef.current === "claude-code" ? parseClaudeAsk(lines, screenCells) : null;
    if (ask) return askMenu(ask);
    const menu = parseTuiMenu(lines, screenCells, launchAgentRef.current);
    // 计划模式的方案确认：标题与屏上读得到的方案附在菜单上（旁路、会话文件给不出方案时卡片用它）
    const plan = menu ? screenPlan(lines, menu) : null;
    return menu && plan ? { ...menu, plan } : menu;
  }
  // 终端里换权限模式的跟随（fetchConversation 读会话文件；基线 = 这个文件第一次读到的模式）
  const permBaselineRef = useRef<{ file: string; mode: string } | null>(null);
  // 本机处理完、会话文件里没有的斜杠命令记录（只在这次打开的聊天里；换了会话文件就清）
  const localRecordsRef = useRef<{ file: string; records: ChatMessageDto[] }>({ file: "", records: [] });
  // 斜杠命令发出那一刻的屏（认这次新出的结果行，slashResultLines）；最近一条斜杠命令（它唤出的选择器答完就收尾）
  const slashBaselineRef = useRef(new WeakMap<ChatMessageDto, string[]>());
  const slashMenuOwnerRef = useRef<{ sent: ChatMessageDto; at: number } | null>(null);
  /** 斜杠命令在本机收尾：留成「命令 + 结果」、从待落盘里拿掉（只在这次打开的聊天里有，会话文件里没有） */
  function settleSlashLocally(pu: ChatMessageDto, output: string[]) {
    if (!pendingUsersRef.current.includes(pu)) return;
    const file = linkCtxRef.current?.filePath ?? "";
    if (localRecordsRef.current.file !== file) localRecordsRef.current = { file, records: [] };
    localRecordsRef.current.records.push(localCommandOutput(pu, output));
    pendingUsersRef.current = pendingUsersRef.current.filter((m) => m !== pu);
    if (slashMenuOwnerRef.current?.sent === pu) slashMenuOwnerRef.current = null;
    void fetchConversation(true);
  }
  /** 这条斜杠命令这次新出的结果行（屏上认得出的） */
  function slashResultNow(pu: ChatMessageDto): string[] {
    return slashResultLines(
      launchAgentRef.current ?? "",
      pu.blocks[0]?.text ?? "",
      screenLines(),
      slashBaselineRef.current.get(pu) ?? null,
    );
  }
  /**
   * 这一轮结束了：生成中发的、还没收尾的斜杠命令直接留成记录（结果行认得出就带上），不再挂着等终端静下来——
   * 原先挂到这一轮的状态翻过去就和待落盘一起清掉，聊天里什么都没留下（2026-11-11 用户 Kimi /permission）。
   * 开着选择器 / 面板时不收：命令还没答完
   */
  function flushSlashAtTurnEnd() {
    if (menuPromptRef.current || tuiPanelRef.current) return;
    const agent = launchAgentRef.current ?? "";
    const now = Date.now();
    for (const pu of [...pendingUsersRef.current]) {
      if (!pu.queued || !slashSettlesAtTurnEnd(agent, pu)) continue;
      if (now - Date.parse(pu.timestamp ?? "") < SLASH_LOCAL_SETTLE_MS) continue;
      const result = slashResultNow(pu);
      settleSlashLocally(pu, result.length ? result : [`已发给 ${agentLabel(agent)}，结果以终端为准`]);
    }
  }
  const [cliModeSwitch, setCliModeSwitch] = useState<{ agent: string; mode: string; seq: number } | null>(null);
  // 终端里开着的面板（tui-panel.ts）：跟菜单同一次扫屏认；开着时一直扫到它关掉
  const [tuiPanel, setTuiPanel] = useState(false);
  const tuiPanelRef = useRef(false);
  function setPanelOpen(open: boolean) {
    if (tuiPanelRef.current === open) return;
    tuiPanelRef.current = open;
    setTuiPanel(open);
  }
  // 要按回车才继续的通知（Claude 中途弹的计费说明等）：同一次扫屏认，弹着时一直扫到它消失
  const [tuiNotice, setTuiNotice] = useState<string[] | null>(null);
  const tuiNoticeRef = useRef<string[] | null>(null);
  // 上次替人按掉计费说明的时刻（cli-notices.ts）
  const noticeSkipAtRef = useRef(0);
  function setTuiNoticeLines(next: string[] | null) {
    if ((tuiNoticeRef.current?.join("\n") ?? null) === (next?.join("\n") ?? null)) return;
    tuiNoticeRef.current = next;
    setTuiNotice(next);
  }
  // 最近一次扫屏：看得见这家的输入框、没有菜单（hooksApprovalAnswered：旁路还说「等批准」时据此认作已经答过）
  const [promptIdle, setPromptIdle] = useState(false);
  // 旁路审批卡最近一次撤掉的时刻（applyChannel 记）；屏上那张菜单第一次被认出的时刻与内容
  const channelApprovalGoneAtRef = useRef(0);
  const menuFirstSeenRef = useRef<{ key: string; at: number } | null>(null);
  /**
   * 能从聊天层答审批的旁路（Codex / Qwen / OpenCode）一轮进行中时，屏上的审批菜单交给旁路的卡：
   * 旁路已经有卡 → 同一问，不另出；旁路的卡刚撤（答过了）→ 终端菜单还没撤的那一下不认；
   * 刚认出、旁路的事件还没到 → 先等 1.2 秒。等过了旁路还没有，才按屏上原文出卡（旁路漏了的兜底）。
   * 原先两边各出一张，先中文后英文（2026-10-21 用户 Codex / Qwen）
   */
  function channelOwnsMenu(menu: TuiMenu | null): boolean {
    const ch = channelRef.current;
    if (!menu) {
      menuFirstSeenRef.current = null;
      return false;
    }
    if (!ch || channelInfersApproval(ch) || !channelTurnOpen(ch)) return false;
    // 旁路的卡上答不了（没有回复通道的那类请求）：屏上原文的卡更有用；终端菜单的选项比旁路能回的多，也用屏上原文的卡。
    // 结束计划（Qwen exit_plan_mode）旁路只给「允许 / 拒绝」，屏上那张有几种开工法，交给屏上的方案卡（plan-approval.ts）
    if (ch.approval?.toolName && PLAN_EXIT_TOOLS.has(ch.approval.toolName)) return false;
    if (ch.approval) {
      return channelCanAnswer(ch, launchAgentRef.current) && !menuOutgrowsChannel(ch, launchAgentRef.current, menu.options.length);
    }
    const now = Date.now();
    if (now - channelApprovalGoneAtRef.current < 3000) {
      window.setTimeout(scanMenuSoon, 600);
      return true;
    }
    const key = `${menu.question ?? ""}\n${menu.options.join("\n")}`;
    if (menuFirstSeenRef.current?.key !== key) menuFirstSeenRef.current = { key, at: now };
    if (now - menuFirstSeenRef.current.at < 1200) {
      window.setTimeout(scanMenuSoon, 400);
      return true;
    }
    return false;
  }
  function scanMenuSoon() {
    const turnLive = ptyWorkingArmedRef.current || pendingReplyRef.current;
    if (
      !menuPromptRef.current &&
      !tuiPanelRef.current &&
      !tuiNoticeRef.current &&
      !waitScreenRef.current &&
      !specialScreenRef.current &&
      !waitWatchRef.current &&
      Date.now() > menuWatchUntilRef.current &&
      !turnLive
    )
      return;
    // 节流、不防抖：生成中转圈每一两百毫秒就出一帧，防抖（每帧重新计时）一直等不到 250ms 的安静，答完提问后
    // 卡片要挂到这一轮说完才撤（2026-10-22 用户：点了之后卡住几秒）
    if (menuScanTimerRef.current) return;
    menuScanTimerRef.current = window.setTimeout(runMenuScan, 250);
  }
  function runMenuScan() {
    menuScanTimerRef.current = null;
    if (!termRef.current || ptyKindRef.current !== "agent") return;
    // 提问表单的键还没按完：屏上是半路的样子，等按完再读
    const keysLeft = askKeysDoneAtRef.current - Date.now();
    if (keysLeft > 0) {
      menuScanTimerRef.current = window.setTimeout(runMenuScan, keysLeft + 50);
      return;
    }
    // 一帧正画到一半（同步输出还没收尾）：表单下半截还是旧的，读出来会缺一截、卡片闪没（同 scanLiveReplyNow）
    if (termRef.current.modes.synchronizedOutputMode && menuSyncWaitsRef.current < 20) {
      menuSyncWaitsRef.current++;
      menuScanTimerRef.current = window.setTimeout(runMenuScan, 50);
      return;
    }
    menuSyncWaitsRef.current = 0;
    const lines = screenLines();
    if (handleClaudeFirstRun(lines)) return;
    const special = specialScreenOf(lines, launchAgentRef.current);
    setSpecialScreenState(special);
    if (special) {
      // 认得出的屏有专门的卡：不当面板 / 通用卡（Gemini 输密钥那屏原先被认成「面板」）
      setTuiNoticeLines(null);
      setPanelOpen(false);
      setWaitScreenState(null);
      setPromptIdle(false);
      if (menuPromptRef.current) {
        menuPromptRef.current = null;
        setMenuPrompt(null);
      }
      return;
    }
    const found = parseScreenMenu(lines);
    // 用户自己发的多行编号清单回显在屏上（「❯ 1. … / 2. …」）也是这个形状：选项全在刚发的话里就不算
    const echoed = found ? menuEchoesText(found, lastSentRef.current) : false;
    // 启动信任菜单归信任卡管（trust-prompt.ts）：这里再认一遍，点完信任后菜单还在屏上的那一两帧
    // 会以通用确认卡再冒出来一次（2026-10-18 用户截图「Accessing workspace… No, exit / Yes, I trust」）
    const trustMenu =
      found !== null &&
      (parseTrustPrompt(lines) !== null ||
        (trustOptionsRef.current !== null &&
          found.options.join("\n") === trustOptionsRef.current.join("\n")));
    const next0 =
      echoed || trustMenu || sameTuiMenu(found, menuBaselineRef.current) ? null : found;
    const next = channelOwnsMenu(next0) ? null : next0;
    // 菜单（审批 / 切换确认）也带 Esc to cancel：认出菜单时不再当面板
    // 要按回车继续的通知也带 Esc to cancel：认出通知时不当面板（面板卡的按钮是 Esc，按了会取消）
    const notice = found === null ? parseTuiNotice(lines, launchAgentRef.current) : null;
    setTuiNoticeLines(notice);
    // 「auto mode 分类器计费」说明：用户勾过「以后自动略过」就替他按回车（只认这一条，回车不改任何设置；cli-notices.ts）。
    // 3 秒内只按一次：按完屏还没换过来的那几帧不重复按
    if (notice && classifierBillingNotice(notice) && classifierNoticeAutoSkip() && Date.now() - noticeSkipAtRef.current > 3000) {
      noticeSkipAtRef.current = Date.now();
      pressWaitKey("enter");
    }
    const panel = found === null && notice === null && parseTuiPanel(lines, launchAgentRef.current);
    setPanelOpen(panel);
    const inputBox = terminalHasInputBox(lines, launchAgentRef.current);
    setPromptIdle(next === null && inputBox === true);
    // 通用卡的摘录：认得出的屏（菜单 / 通知 / 面板 / 信任）各有专用卡，看得见输入框就是没在等人
    const recognized = found !== null || notice !== null || panel || trustPromptRef.current !== null || parseTrustPrompt(lines) !== null;
    const wait = recognized || inputBox === true ? null : waitScreenOf(lines);
    setWaitScreenState(wait ? { ...wait, noInputBox: inputBox === false } : null);
    const ask = next?.ask ?? null;
    // 卡片上交过卷又到了确认页：答案就是刚在卡片上选的，替人按「Submit answers」，不要人再点一次
    // （2026-10-22 用户：为什么还有确认提交回答）。还有题没答（带提醒）、或人自己点到确认页的，照常出卡
    // CLI 比 Mesa 核对过的新（cli-verified.ts）：确认页的样子可能变了，不替人按，照常出卡
    if (ask?.kind === "review" && !ask.warning && !cliNewerRef.current && Date.now() < askAutoConfirmUntilRef.current) {
      askAutoConfirmUntilRef.current = 0;
      const keys = askAnswerKeys(ask, { kind: "confirm" });
      const id = ptyIdRef.current;
      if (keys && id) {
        pressAskKeys(id, keys, true);
        return;
      }
    }
    // 刚交过：表单还在屏上是键还没生效（或正换到确认页），先不把卡片拿回来；过了这一会儿还在就照常出卡，
    // 按键没生效时人还能接着答
    const hiddenLeft = askHiddenUntilRef.current - Date.now();
    if (ask && hiddenLeft > 0) {
      menuScanTimerRef.current = window.setTimeout(runMenuScan, hiddenLeft + 50);
      return;
    }
    // 换到了另一道题：上一下不是最后一题，之后人自己点到确认页时不替人交
    if (ask?.kind === "question") askAutoConfirmUntilRef.current = 0;
    // 会话内换权限唤出的选择器：逐项核对原文，认准了替人选（answerMenu 挪完高亮再读屏核对才回车）；对不上不按，卡片给人点
    const expected = expectedPickerRef.current;
    if (next && expected) {
      const index = Date.now() < expected.until ? pickerTargetIndex(next, expected.options, expected.pick) : null;
      expectedPickerRef.current = index !== null && expected.then ? { ...expected.then, until: Date.now() + 6000 } : null;
      if (index !== null) {
        menuPromptRef.current = next;
        answerMenu(index);
        return;
      }
    }
    if (sameTuiMenu(menuPromptRef.current, next)) return;
    menuPromptRef.current = next;
    setMenuPrompt(next);
  }
  // 「终端在等你」通用卡（terminal-wait.ts，2026-10-27 取代自动弹出底部终端）：屏上那一块的摘录，跟菜单同一次扫屏认。
  // 等确认 / Agent 静止时（waitWatchRef）也扫一次——停在配色、登录这类画面上时终端不再出字，没有输出驱动扫屏
  const [waitScreen, setWaitScreen] = useState<(WaitScreen & { noInputBox: boolean }) | null>(null);
  const waitScreenRef = useRef<(WaitScreen & { noInputBox: boolean }) | null>(null);
  const waitWatchRef = useRef(false);
  function setWaitScreenState(next: (WaitScreen & { noInputBox: boolean }) | null) {
    const key = (w: typeof next) => (w ? `${w.noInputBox}\n${w.lines.join("\n")}` : null);
    if (key(waitScreenRef.current) === key(next)) return;
    waitScreenRef.current = next;
    setWaitScreen(next);
  }
  useEffect(() => {
    waitWatchRef.current = attention === "confirm" || ptyQuiet;
    if (waitWatchRef.current) scanMenuSoon();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attention, ptyQuiet]);
  /** 通用卡上点的键：回车按这家的提交键（Kimi 是 CSI-u），按完再扫一次屏，卡片跟着终端变 */
  function pressWaitKey(key: WaitKey) {
    const id = ptyIdRef.current;
    if (!id) return;
    const enter = submitCsiU ? KIMI_CSI_U_ENTER : "\r";
    const keys = waitKeyBytes(key).map((k) => (k === "\r" ? enter : k));
    const done = queuePtyKeys(id, keys);
    if (key === "enter" || key.startsWith("digit:") || key.startsWith("text:")) armPtyWorking();
    menuWatchUntilRef.current = done + 3000;
    window.setTimeout(scanMenuSoon, Math.max(0, done - Date.now()) + 200);
  }

  // Claude Code 第一次启动的配色、安全须知两屏 Mesa 替人走完（2026-10-27 用户：新用户第一印象很差）；
  // 信任文件夹仍由人在信任卡上点。CLI 比核对过的新时不替人按，交给通用卡。每屏最多试三次，按不准就交给通用卡
  const [firstRunNote, setFirstRunNote] = useState<FirstRunNote | null>(null);
  // Agent 一启动就退出（接上不到 30 秒、非零退出码）：聊天里出「没能启动」卡，原先只在终端里留一行红字、对话区空着
  const [launchFailure, setLaunchFailure] = useState<LaunchFailure | null>(null);
  // 启动被拦、聊天层能给出处理办法（Gemini 还没把认证方式设成 API Key）：聊天里出带按钮的卡
  const [launchBlock, setLaunchBlock] = useState<LaunchBlock | null>(null);
  // 认得出的首次启动屏（Gemini 要存密钥、Cursor 要登录，terminal-wait.ts specialScreenOf）：专门的卡
  const [specialScreen, setSpecialScreen] = useState<SpecialScreen | null>(null);
  const specialScreenRef = useRef<SpecialScreen | null>(null);
  function setSpecialScreenState(next: SpecialScreen | null) {
    if (JSON.stringify(specialScreenRef.current) === JSON.stringify(next)) return;
    specialScreenRef.current = next;
    setSpecialScreen(next);
  }
  /** Gemini 卡「设成 API Key 并启动」：只改认证方式（后端先备份），再按原来的设置启动 */
  async function fixGeminiAuth() {
    try {
      await invoke("gemini_use_api_key_auth", { profileId });
    } catch (e) {
      setLaunchBlock((b) => (b ? { ...b, message: `没能改认证方式：${String(e)}` } : b));
      return;
    }
    setLaunchBlock(null);
    setError(null);
    void launch(lastResumeRef.current ?? undefined);
  }
  const firstRunRef = useRef<{ busyUntil: number; tries: Record<string, number> }>({ busyUntil: 0, tries: {} });
  function handleClaudeFirstRun(lines: string[]): boolean {
    if (launchAgentRef.current !== "claude-code" || cliNewerRef.current) return false;
    const step = claudeFirstRunStep(lines);
    const id = ptyIdRef.current;
    if (!step || !id) return false;
    const state = firstRunRef.current;
    const left = state.busyUntil - Date.now();
    if (left > 0) {
      menuScanTimerRef.current = window.setTimeout(runMenuScan, left + 50);
      return true;
    }
    const tries = (state.tries[step.kind] ?? 0) + 1;
    if (tries > 3) return false;
    state.tries[step.kind] = tries;
    const enter = submitCsiU ? KIMI_CSI_U_ENTER : "\r";
    if (step.kind === "security") {
      const done = queuePtyKeys(id, [enter]);
      state.busyUntil = done + 1200;
      setFirstRunNote((prev) => ({ theme: prev?.theme ?? null, security: step.text }));
      menuWatchUntilRef.current = state.busyUntil + 5000;
      menuScanTimerRef.current = window.setTimeout(runMenuScan, state.busyUntil - Date.now() + 50);
      return true;
    }
    // 配色：能跟随终端的选 Auto；Windows 的 ConPTY 吞掉底色查询，按 Mesa 主题明暗选
    const light = isLightTheme(settingsRef.current?.theme ?? DEFAULT_THEME_ID);
    const target = claudeThemeTarget(step.options, IS_WINDOWS ? (light ? "light" : "dark") : "auto");
    if (target < 0) return false;
    const moves = menuMoveKeys({ question: null, detail: null, options: step.options, selected: step.selected }, target);
    const done = moves.length ? queuePtyKeys(id, moves) : Date.now();
    state.busyUntil = done + 1500;
    // 挪完读屏核对：高亮停在要选的那一项上才回车（同 answerMenu，替人按键只在认准时做）
    const confirm = (n: number) => {
      if (ptyIdRef.current !== id) return;
      const now = claudeFirstRunStep(screenLines());
      if (now?.kind === "theme" && now.selected === target) {
        writeInteractivePty(id, enter);
        setFirstRunNote((prev) => ({ theme: claudeThemeLabel(step.options[target]), security: prev?.security ?? null }));
      } else if (n < 3) {
        window.setTimeout(() => confirm(n + 1), 150);
        return;
      }
      state.busyUntil = Date.now() + 800;
      menuWatchUntilRef.current = Date.now() + 8000;
      menuScanTimerRef.current = window.setTimeout(runMenuScan, 900);
    };
    window.setTimeout(() => confirm(0), Math.max(0, done - Date.now()) + 150);
    return true;
  }

  // 实时预览：Agent 出字时节流 300ms 读一次可视区，抽出这一轮正在写的回复给聊天层（会话文件一段写完才落盘）
  const [liveReply, setLiveReply] = useState<string[] | null>(null);
  const liveReplyRef = useRef<string[] | null>(null);
  const [liveTokens, setLiveTokens] = useState<number | null>(null);
  const liveTokensRef = useRef<number | null>(null);
  const [liveThinking, setLiveThinking] = useState<string | null>(null);
  const liveThinkingRef = useRef<string | null>(null);
  const liveScanAtRef = useRef(0);
  const liveScanTimerRef = useRef<number | null>(null);
  // 最近一次从聊天发出时屏上的最后一条回显与原文（writeChatMessage 记；读到新回显后清）
  const sendEchoRef = useRef<{ before: string | null; beforeLines: string[] | null; sent: string } | null>(null);
  // 连续因「一帧还没画完」改期的次数（封顶后照读，免得 CLI 忘了收尾时预览永远不动）
  const liveSyncWaitsRef = useRef(0);
  // 实时预览攒的是哪一条回显后面的回复
  const liveEchoRef = useRef<string | null>(null);
  // 接回会话、这句还没写进终端（等进程起来、回放、输入框就绪）：屏上全是回放的旧对话，不读。
  // 原先这段空当里读到的上一轮回复被当成这一轮的预览，写进去之后 staleEcho 又一直拦着新读数，旧回复就挂到新回复出字
  // （2026-10-27 用户截图）。writeChatMessage 记下发送前的屏之后放开
  const liveHoldRef = useRef(false);
  function scanLiveReplySoon() {
    if (!liveReplySupported(launchAgentRef.current)) return;
    if (liveHoldRef.current) return;
    // 旁路直接送实时文字的家（Qwen / OpenCode / Codex）不再读屏
    const ch = channelRef.current;
    if (ch && ch.kind !== "hooks" && channelTurnOpen(ch)) return;
    if (liveScanTimerRef.current) return;
    const wait = Math.max(0, liveScanAtRef.current + 300 - Date.now());
    liveScanTimerRef.current = window.setTimeout(scanLiveReplyNow, wait);
  }
  function scanLiveReplyNow() {
    liveScanTimerRef.current = null;
    if (liveHoldRef.current) return;
    const term = termRef.current;
    if (!term || ptyKindRef.current !== "agent") return;
    // 一帧正画到一半（同步输出 ?2026h 还没收尾，Claude Code 每帧都这样包；一帧常分两块到）：这时读到的是
    // 上半截新、下半截旧的半帧。等这一帧画完再读（2026-10-22 回放实录：逐块读时约四成落在半帧上）
    if (term.modes.synchronizedOutputMode && liveSyncWaitsRef.current < 20) {
      liveSyncWaitsRef.current++;
      liveScanTimerRef.current = window.setTimeout(scanLiveReplyNow, 50);
      return;
    }
    liveSyncWaitsRef.current = 0;
    liveScanAtRef.current = Date.now();
    const lines = screenLines();
    // 长回复滚出屏后只看得见续行：接到上一次读到的整段后面（mergeLiveReply）
    const read = extractLiveReply(lines, launchAgentRef.current, screenItalicRow);
    // Claude 转圈行的已生成 token 数（Windows 上 Claude 不边写边画，聊天层靠它看出还在出字）
    if (launchAgentRef.current === "claude-code") {
      const tokens = claudeOutputTokens(lines);
      if (tokens !== null && tokens !== liveTokensRef.current) {
        liveTokensRef.current = tokens;
        setLiveTokens(tokens);
      }
    }
    // 正在想的那一框（Grok、Kimi）：不混进回复预览，照终端原样（去掉竖线与 Thinking 头）另给聊天层；框收起 = 想完了，清掉
    const thinking = extractLiveThinking(lines, launchAgentRef.current)?.join("\n") ?? null;
    if (thinking !== liveThinkingRef.current) {
      liveThinkingRef.current = thinking;
      setLiveThinking(thinking);
    }
    const shown = liveReplyRef.current;
    // 一时读不出（菜单挂着、重绘半帧）保留上一次的，免得预览闪没；新一轮发送时清
    if (!read) return;
    // 刚发的这句 CLI 还没画出来：屏上是上一轮的回显和回复，不当这一轮的预览（Qwen 先把上一段回复又显示一遍）
    const sent = sendEchoRef.current;
    if (sent && read.echo !== undefined) {
      if (staleEcho(read, sent.before, sent.sent, sent.beforeLines)) return;
      sendEchoRef.current = null;
    } else if (sent && staleWithoutEcho(read, sent.beforeLines)) {
      return;
    }
    // 回显换了 = 新的一轮（在终端里直接发的话不经聊天发送，不会清掉上一轮的预览）：不拿上一轮的开头去补这一轮
    let prev = shown;
    if (read.echo !== undefined) {
      if (read.echo !== liveEchoRef.current) prev = null;
      liveEchoRef.current = read.echo;
    }
    const next = mergeLiveReply(prev, read);
    if (!next) return;
    if ((shown?.join("\n") ?? null) === next.join("\n")) return;
    liveReplyRef.current = next;
    setLiveReply(next);
  }
  // 连接出问题（conn-issue.ts）：Agent 出字时节流 500ms 扫一次可视区。基线 = 「已经看过」的错误（按次数）：
  // 关提示、换连接、发下一句、新进程接上时把屏上已有的记进去，之后同一个错误次数涨了才算新的
  const [rawConnIssue, setRawConnIssue] = useState<
    (ReturnType<typeof detectConnIssues>[number] & { profileName: string }) | null
  >(null);
  const rawConnIssueRef = useRef(rawConnIssue);
  rawConnIssueRef.current = rawConnIssue;
  const connBaselineRef = useRef<Map<string, number>>(new Map());
  const connScanTimerRef = useRef<number | null>(null);
  function screenLines(): string[] {
    const term = termRef.current;
    if (!term) return [];
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < term.rows; i++) {
      lines.push(buf.getLine(buf.viewportY + i)?.translateToString(true) ?? "");
    }
    return lines;
  }
  // 底栏上的模型（Codex「模型 档位 · 目录」）：差量重绘只重画变了的格子，输出流里档位前面不一定是模型名，
  // 只能从画好的屏上读（reasoning-effort.ts detectModelOnScreen）。节流 500ms
  const footerScanTimerRef = useRef<number | null>(null);
  // Claude 输入框里那行灰字（它猜你下一句想说什么，prompt-suggestion.ts）：会话文件和 hooks 都不记，只能读屏。
  // 出字时节流 400ms 读一次，一帧画到一半时等它画完；发出一句时清掉
  const [promptSuggestion, setPromptSuggestion] = useState<string | null>(null);
  const promptSuggestionRef = useRef<string | null>(null);
  const suggestionScanTimerRef = useRef<number | null>(null);
  function setSuggestion(next: string | null) {
    if (promptSuggestionRef.current === next) return;
    promptSuggestionRef.current = next;
    setPromptSuggestion(next);
  }
  function scanSuggestionSoon() {
    if (suggestionScanTimerRef.current || !promptSuggestionSupported(launchAgentRef.current)) return;
    let waits = 0;
    const run = () => {
      const term = termRef.current;
      if (term?.modes.synchronizedOutputMode && waits++ < 20) {
        suggestionScanTimerRef.current = window.setTimeout(run, 50);
        return;
      }
      suggestionScanTimerRef.current = null;
      if (!term || ptyKindRef.current !== "agent") return;
      setSuggestion(readPromptSuggestion(screenLines(), screenCells));
    };
    suggestionScanTimerRef.current = window.setTimeout(run, 400);
  }
  function scanFooterModelSoon() {
    if (footerScanTimerRef.current || !modelOnScreenSupported(launchAgentRef.current)) return;
    footerScanTimerRef.current = window.setTimeout(() => {
      footerScanTimerRef.current = null;
      if (ptyKindRef.current !== "agent") return;
      const seen = detectModelOnScreen(screenLines(), launchAgentRef.current);
      if (seen) setModelSeen((prev) => (prev === seen ? prev : seen));
    }, 500);
  }
  function scanConnIssueSoon() {
    if (connScanTimerRef.current) return;
    connScanTimerRef.current = window.setTimeout(() => {
      connScanTimerRef.current = null;
      if (ptyKindRef.current !== "agent") return;
      const found = detectConnIssues(screenLines(), launchAgentRef.current);
      const cur = rawConnIssueRef.current;
      // 还在重试的那条从屏上消失了：CLI 自己缓过来了（或转成了最终报错，那会作为新错误出现）
      if (cur?.retrying && !found.some((f) => f.sig === cur.sig)) setRawConnIssue(null);
      const next = newestConnIssue(found, connBaselineRef.current);
      if (!next || next.sig === cur?.sig) return;
      setRawConnIssue({ ...next, profileName: selectedProfileRef.current?.name ?? "" });
    }, 500);
  }
  /** 屏上现有的错误全部记作已看过（不再提示），并收起当前提示 */
  function dismissConnIssue() {
    const counts = connIssueCounts(detectConnIssues(screenLines(), launchAgentRef.current));
    connBaselineRef.current = counts;
    setRawConnIssue(null);
  }
  const hiddenProfileKey = (settings?.hiddenProfiles ?? []).join("\n");
  const isOfficialProfile = selectedProfile?.accountType === "official";
  const connIssue = useMemo<ConnIssueState | null>(() => {
    if (!rawConnIssue) return null;
    const hidden = hiddenProfileKey ? hiddenProfileKey.split("\n") : [];
    const alternatives = profiles
      .filter((p) => p.agent === agentId && p.id !== profileId && !hidden.includes(p.id))
      .map((p) => ({ profileId: p.id, label: p.models[0] ? `${p.name} · ${p.models[0]}` : p.name }));
    const detail = `${rawConnIssue.status ? `${rawConnIssue.status} · ` : ""}${rawConnIssue.message}${
      rawConnIssue.retrying ? "（它还在自动重试）" : ""
    }`;
    // 「连不上服务器」只对官方账号启动有意义（出网代理只管官方启动）；中转连接照旧按服务出错 / 超时处理
    const kind = rawConnIssue.kind === "network" && !isOfficialProfile ? "timeout" : rawConnIssue.kind;
    return {
      kind,
      status: rawConnIssue.status,
      message: rawConnIssue.message,
      retrying: rawConnIssue.retrying,
      sig: rawConnIssue.sig,
      profileName: rawConnIssue.profileName,
      text: connIssueText(kind, rawConnIssue.profileName),
      detail,
      alternatives,
    };
  }, [rawConnIssue, profiles, agentId, profileId, hiddenProfileKey, isOfficialProfile]);
  const [connPick, setConnPick] = useState("");
  // Grok 卡在续期官方登录上（2026-10-26，grok_login.rs）：用 API 连接启动的 Grok 也会先续期本地存着的 xAI 官方登录，
  // 连不上 auth.x.ai 时每条消息卡半分钟以上、屏上没有任何报错。启动时探一次登录服务器，运行中每 8 秒看一眼 Grok 日志
  const [grokLoginStuck, setGrokLoginStuck] = useState(false);
  const grokLoginDismissedRef = useRef(false);
  const grokLogoutPendingRef = useRef(false);
  const grokLoginWatched =
    running && launchAgentRef.current === "grok" && selectedProfile?.accountType !== "official";
  useEffect(() => {
    if (!grokLoginWatched || startedAt === null) return;
    // 「先不管」只管这一次启动
    grokLoginDismissedRef.current = false;
    let alive = true;
    const check = (probe: boolean) =>
      invoke<{ staleLogin: boolean; blocked: boolean }>("grok_login_check", {
        sinceMs: probe ? null : startedAt,
        probe,
      })
        .then((r) => {
          if (!alive || grokLoginDismissedRef.current) return;
          if (r.staleLogin && r.blocked) setGrokLoginStuck(true);
          // 登录续上了（不再过期）或被清掉：提示收回
          else if (!r.staleLogin) setGrokLoginStuck(false);
        })
        .catch(() => {});
    void check(true);
    const timer = window.setInterval(() => void check(false), 8000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [grokLoginWatched, startedAt]);
  function dismissGrokLogin() {
    grokLoginDismissedRef.current = true;
    setGrokLoginStuck(false);
  }
  function grokLogout() {
    setGrokLoginStuck(false);
    grokLogoutPendingRef.current = true;
    if (ptyKindRef.current === "agent" && ptyIdRef.current) void stop();
  }
  // 会话内换权限时期待的选择器（switch-strategy inSessionPermissionSwitch）：原文、要选的项、有效期；then = 完全访问的第二层确认
  const expectedPickerRef = useRef<{
    options: string[];
    pick: string;
    until: number;
    then?: { options: string[]; pick: string };
  } | null>(null);
  /**
   * 会话里直接换权限、不重开（2026-11-11，docs/design-chat-inline-switch.md 2.A）：带参数直切的家（Qwen）发一条命令；
   * 选择器的家（Kimi、Codex）发命令后等选择器出来，逐项核对原文再替人选。命令照聊天里发的斜杠命令走，留「命令 + 结果」记录。
   * 返回 false = 这家这个版本不能在会话里换
   */
  async function switchPermissionInSession(tier: "ask" | "auto" | "full"): Promise<boolean> {
    const spec = inSessionPermissionSwitch(launchAgentRef.current ?? "", launchAgentDetRef.current?.version);
    if (!spec || !ptyIdRef.current) return false;
    if (spec.args) {
      const arg = spec.args[tier];
      if (!arg) return false;
      return !(await sendMessage(`${spec.command} ${arg}`)).error;
    }
    const pick = spec.picker?.tiers[tier];
    if (!spec.picker || !pick) return false;
    const confirm = tier === "full" ? spec.picker.fullConfirm : undefined;
    expectedPickerRef.current = {
      options: spec.picker.options,
      pick,
      until: Date.now() + 8000,
      ...(confirm ? { then: { options: confirm.options, pick: confirm.pick } } : {}),
    };
    const sent = await sendMessage(spec.command);
    if (sent.error) {
      expectedPickerRef.current = null;
      return false;
    }
    menuWatchUntilRef.current = Math.max(menuWatchUntilRef.current, Date.now() + 6000);
    scanMenuSoon();
    return true;
  }
  /**
   * Kimi 2.5.3 会话内换思考档（2026-11-11 实测）：发不带参数的 /effort 唤出横排选择器，←→ 挪到要的档，读屏核对方括号停在它上面，
   * 再按 Alt+S（只改本段、下一轮生效；回车会存成默认）。Kimi 开着 kitty 键盘，Alt+S 只认 CSI-u 写法，传统 ESC s 无效。
   * 选择器没出来、没有这一档、核对对不上：按 Esc 退出，什么都不改
   */
  function pickKimiEffort(id: string, level: string) {
    const enter = submitCsiU ? KIMI_CSI_U_ENTER : "\r";
    const esc = submitCsiU ? "\x1b[27u" : "\x1b";
    writeInteractivePty(id, `/effort${enter}`);
    const want = level.toLowerCase();
    const cancel = () => {
      if (ptyIdRef.current === id && parseKimiEffortPicker(screenLines())) writeInteractivePty(id, esc);
    };
    const confirm = (target: number, tries: number) => {
      if (ptyIdRef.current !== id) return;
      const now = parseKimiEffortPicker(screenLines());
      if (now && now.selected === target && now.options[target]?.toLowerCase() === want) {
        writeInteractivePty(id, submitCsiU ? "\x1b[115;3u" : "\x1bs");
        return;
      }
      if (tries < 3) window.setTimeout(() => confirm(target, tries + 1), 150);
      else cancel();
    };
    const wait = (tries: number) => {
      if (ptyIdRef.current !== id) return;
      const picker = parseKimiEffortPicker(screenLines());
      if (!picker) {
        if (tries < 15) window.setTimeout(() => wait(tries + 1), 120);
        return;
      }
      const target = picker.options.findIndex((o) => o.toLowerCase() === want);
      if (target < 0) return cancel();
      const delta = target - picker.selected;
      const keys = Array.from({ length: Math.abs(delta) }, () => (delta > 0 ? "\x1b[C" : "\x1b[D"));
      const done = keys.length ? queuePtyKeys(id, keys) : Date.now();
      window.setTimeout(() => confirm(target, 0), Math.max(0, done - Date.now()) + 150);
    };
    window.setTimeout(() => wait(0), 150);
  }
  /** 写一条 TUI 命令（聊天层 / 底栏切模型、思考档），随后盯 5 秒屏幕看 CLI 有没有弹确认 */
  function runTuiCommand(cmd: string) {
    const id = ptyIdRef.current;
    if (!id) return;
    // Kimi 换思考档：带参数的 /effort 会存成默认，改走选择器只改本段（switch-strategy kimiEffortPickLevel）
    const kimiLevel = kimiEffortPickLevel(launchAgentRef.current ?? "", launchAgentDetRef.current?.version, cmd);
    if (kimiLevel) {
      pickKimiEffort(id, kimiLevel);
      return;
    }
    const enter = submitCsiU ? KIMI_CSI_U_ENTER : "\r";
    menuBaselineRef.current = screenMenu();
    writeInteractivePty(id, `${cmd}${enter}`);
    menuWatchUntilRef.current = Date.now() + 5000;
    scanMenuSoon();
  }
  function answerMenu(index: number, opts: MenuAnswer = {}) {
    const { text, openFirst, onDone } = opts;
    const menu = menuPromptRef.current;
    const id = ptyIdRef.current;
    if (!menu || !id) return;
    menuPromptRef.current = null;
    setMenuPrompt(null);
    // 答完到下一次扫屏之间，别让旁路还没撤的「等批准」顶上来一张兜底卡（扫屏会纠正：菜单还在就回来）
    if (liveReplySupported(launchAgentRef.current)) setPromptIdle(true);
    // Kimi 开了 kitty 键盘后只认 CSI-u 回车（submitCsiU）；方向键仍是传统写法
    const enter = submitCsiU ? KIMI_CSI_U_ENTER : "\r";
    const moves = menuMoveKeys(menu, index);
    // 一个确认之后可能还有下一个（选完模型再问思考档）：再开一小段窗口
    menuWatchUntilRef.current = Date.now() + 3000;
    // 能打字的那一行（方案确认的「接着改方案」）：高亮停对了先把字整段写进去，隔一拍再回车；
    // openFirst（Kimi「Revise」）先回车打开输入行再打字。打字期间屏上那一行变成了字，扫屏先别把卡片拿回来
    const later = (ms: number, data: string) =>
      window.setTimeout(() => {
        if (ptyIdRef.current === id) writeInteractivePty(id, data);
      }, ms);
    // 这张菜单是聊天里刚发的斜杠命令唤出来的（/permission、/effort…）：答完就把那条命令收成「命令 + 选了哪一项 + 结果行」
    const owner = slashMenuOwnerRef.current;
    const picked = menu.options[index] ?? null;
    const settleOwner = (after: number) => {
      if (!owner || Date.now() - owner.at > 60_000 || !picked) return;
      window.setTimeout(() => {
        if (ptyIdRef.current !== id) return;
        settleSlashLocally(owner.sent, [`选了：${picked}`, ...slashResultNow(owner.sent)]);
      }, after + 900);
    };
    const submit = (): number => {
      onDone?.();
      if (!text) {
        writeInteractivePty(id, enter);
        settleOwner(0);
        return 0;
      }
      const lead = openFirst ? 400 : 0;
      if (openFirst) writeInteractivePty(id, enter);
      later(lead, text);
      later(lead + 300, enter);
      askKeysDoneAtRef.current = Date.now() + lead + 700;
      return lead + 300;
    };
    if (moves.length === 0) {
      // 高亮本来就在这一项（刚从屏上读到的）：直接回车
      const wait = submit();
      window.setTimeout(scanMenuSoon, wait + 400);
      return;
    }
    // 先挪高亮，再读一遍屏确认停对了才回车（tui-menu.ts menuReadyToConfirm）：读屏认错了格数也不会选中另一项
    const done = queuePtyKeys(id, moves);
    // 核对期间屏上是挪到一半的菜单：扫屏先别把卡片拿回来（与提问表单的按键同一道闸）
    askKeysDoneAtRef.current = done + 1200;
    const settle = () => {
      askKeysDoneAtRef.current = 0;
    };
    const confirm = (tries: number) => {
      if (ptyIdRef.current !== id) return settle();
      const term = termRef.current;
      if (term?.modes.synchronizedOutputMode && tries < 6) {
        window.setTimeout(() => confirm(tries + 1), 60);
        return;
      }
      if (menuReadyToConfirm(menu, index, parseScreenMenu(screenLines()))) {
        settle();
        const wait = submit();
        window.setTimeout(scanMenuSoon, wait + 400);
        return;
      }
      // 画面可能还没跟上：再等两拍；仍对不上就不按，卡片按屏上现在的样子重画，交给人再点一次
      if (tries < 3) {
        window.setTimeout(() => confirm(tries + 1), 150);
        return;
      }
      settle();
      menuWatchUntilRef.current = Date.now() + 3000;
      scanMenuSoon();
    };
    window.setTimeout(() => confirm(0), Math.max(0, done - Date.now()) + 150);
  }
  // 替用户按的键排成一队：每个键隔 80ms（Ink 一次只认一个键），连点几下也不会交错着写
  const keyQueueAtRef = useRef(0);
  // 提问表单的键按到什么时候：按完之前屏上是半路的样子（光标挪了、还没回车），扫屏不拿它覆盖卡片
  const askKeysDoneAtRef = useRef(0);
  // 交了卷的卡片当场收起，这之前扫到的表单不拿回来（键还没生效 / 正换到确认页）
  const askHiddenUntilRef = useRef(0);
  // 这之前扫到确认页就替人按「Submit answers」（卡片上交过卷才设）
  const askAutoConfirmUntilRef = useRef(0);
  const cliNewer = useCliNewer(agentId);
  const cliNewerRef = useRef(cliNewer);
  cliNewerRef.current = cliNewer;
  function queuePtyKeys(id: string, keys: string[]): number {
    const start = Math.max(Date.now(), keyQueueAtRef.current);
    keys.forEach((key, i) => {
      window.setTimeout(() => {
        if (ptyIdRef.current === id) writeInteractivePty(id, key);
      }, start - Date.now() + i * 80);
    });
    keyQueueAtRef.current = start + keys.length * 80;
    return keyQueueAtRef.current;
  }
  function answerAsk(action: AskAction) {
    const menu = menuPromptRef.current;
    const ask = menu?.ask;
    const id = ptyIdRef.current;
    if (!menu || !ask || !id || menu.pending) return;
    const keys = askAnswerKeys(ask, action)?.map((k) => (k === "\r" && submitCsiU ? KIMI_CSI_U_ENTER : k));
    if (!keys) return;
    // 交卷（最后一题选定 / 交这一题 / 确认 / 不答）：卡片当场收起，到了确认页替人按「Submit answers」；
    // 多选勾一项、往「自己写」里写字：还是这一题，先照按键结果画（askAfter），连点也从对的光标位置算；
    // 换题（多题里还有没答的、切题）：先停用按钮，等屏上换了再画
    const finishes = askFinishes(ask, action);
    askAutoConfirmUntilRef.current =
      finishes && (action.kind === "pick" || action.kind === "text" || action.kind === "submit")
        ? Date.now() + keys.length * 80 + 5000
        : 0;
    if (!finishes) {
      const after = askAfter(ask, action);
      const next: TuiMenu = after ? askMenu(after) : { ...menu, pending: true };
      menuPromptRef.current = next;
      setMenuPrompt(next);
    } else if (liveReplySupported(launchAgentRef.current)) {
      // 同 answerMenu：答完到下一次扫屏之间，别让旁路还没撤的「等批准」顶上来一张兜底卡
      setPromptIdle(true);
    }
    pressAskKeys(id, keys, finishes);
  }
  function pressAskKeys(id: string, keys: string[], hide: boolean) {
    const done = queuePtyKeys(id, keys);
    askKeysDoneAtRef.current = done + 120;
    menuWatchUntilRef.current = done + 3000;
    if (hide) {
      askHiddenUntilRef.current = done + 1500;
      menuPromptRef.current = null;
      setMenuPrompt(null);
    }
    if (menuScanTimerRef.current) window.clearTimeout(menuScanTimerRef.current);
    menuScanTimerRef.current = window.setTimeout(runMenuScan, done - Date.now() + 200);
  }
  function clearTrustPrompt() {
    if (trustScanTimerRef.current) window.clearTimeout(trustScanTimerRef.current);
    trustScanTimerRef.current = null;
    trustPromptRef.current = null;
    setTrustPrompt(null);
  }
  /** 聊天层替用户在信任菜单里选：方向键挪到目标项再回车，每个键单独写、隔一拍 */
  function answerTrust(accept: boolean) {
    const prompt = trustPromptRef.current;
    const id = ptyIdRef.current;
    if (!prompt || !id) return;
    clearTrustPrompt();
    // 同一屏信任菜单可能已被通用菜单扫描认出过：一并撤掉，免得点完信任又冒出一张同样的卡
    trustOptionsRef.current = prompt.options;
    menuPromptRef.current = null;
    setMenuPrompt(null);
    const enter = submitCsiU ? KIMI_CSI_U_ENTER : "\r";
    const moves = trustAnswerKeys(prompt, accept).slice(0, -1);
    // 先挪高亮，读屏确认停在「信任 / 不信任」那一项上才回车（同 answerMenu）：信任是安全决定，认错一格就反了
    const done = moves.length ? queuePtyKeys(id, moves) : Date.now();
    trustAnsweringUntilRef.current = moves.length ? done + 1000 : 0;
    const confirm = (tries: number) => {
      if (ptyIdRef.current !== id) return;
      const now = moves.length ? parseTrustPrompt(screenLines()) : prompt;
      if (trustReadyToConfirm(prompt, accept, now)) {
        writeInteractivePty(id, enter);
        if (accept) armPtyWorking();
      } else if (tries < 3) {
        window.setTimeout(() => confirm(tries + 1), 150);
        return;
      }
      // 选完之后屏幕会变；再扫一次，万一按键没生效（或没认准、没按回车）菜单还在，按钮要回来
      trustAnsweringUntilRef.current = 0;
      window.setTimeout(scanTrustPromptSoon, 400);
    };
    window.setTimeout(() => confirm(0), moves.length ? Math.max(0, done - Date.now()) + 150 : 0);
  }
  // PTY 输出静默：已经出过字则熄灭；还在等首字（思考中）保持转圈。
  // 熄灭后会话文件 sticky working 不得重新点亮（applyTailAttention）。
  useEffect(() => {
    if (attention !== "working") return;
    const timer = window.setInterval(() => {
      // 旁路说这一轮还在进行（长命令静默跑着、等批准）：不按 PTY 静默熄灭
      if (channelTurnOpen(channelRef.current)) return;
      const silenceMs = Date.now() - lastOutputAtRef.current;
      if (silenceMs <= PTY_WORKING_SILENCE_MS) return;
      const next = onPtyWorkingSilence({
        prev: "working",
        armed: ptyWorkingArmedRef.current,
        hadPtyWorkingOutput: hadPtyWorkingOutputRef.current,
        pendingReply: pendingReplyRef.current,
        silenceMs,
      });
      ptyWorkingArmedRef.current = next.armed;
      if (next.clearHadOutput) hadPtyWorkingOutputRef.current = false;
      setAttention(next.attention);
    }, 500);
    return () => window.clearInterval(timer);
  }, [attention]);
  const lastReportRef = useRef("");
  useEffect(() => {
    const s: TabStatus = {
      title,
      alive: running || shellActive,
      running,
      shell: shellActive,
      agentId,
      profileId,
      model,
      launchModel,
      cwd,
      ptyId: activePtyId,
      // 注意力：confirm/done 认会话尾部/hooks；working 认「用户刚提交 + PTY 出字」，
      // 会话文件 sticky working 不能单独维持。running 不兜底——「进程在跑」≠「正在生成」。
      // 屏上认出了等你选的菜单（工具审批 / 启动信任 / 切换确认，tui-menu.ts、trust-prompt.ts）也算 confirm
      // （2026-10-18）：原先「等你确认」只靠 hooks 精确注意力（要在设置里逐家打开）或会话尾部推断，没开 hooks 的家
      // 在等你批准时收件箱、标签黄点、系统通知全都不响；读屏认得出的七家（tui-menu.ts 样本）不用装 hooks。
      // 要按回车才继续的通知（tui-panel.ts parseTuiNotice）同样算等你：弹着时这一轮停着（2026-11-06 补；
      // 勾了自动略过的计费说明 Mesa 会替人按掉，不算）。
      // 反过来，hooks 还说「等批准」、屏上却已回到输入框：答过了，工具在跑（hooksApprovalAnswered）
      attention:
        running && !shellActive
          ? menuPrompt || trustPrompt || (tuiNotice && !(classifierBillingNotice(tuiNotice) && classifierNoticeAutoSkip()))
            ? "confirm"
            : attention === "confirm" && hooksApprovalAnswered(channel, promptIdle)
              ? "working"
              : attention
          : null,
      canResume: shellActive && lastResumeRef.current != null,
      startedAt,
      sessionId:
        linkCtxRef.current?.sessionId ??
        linkCtxRef.current?.hint ??
        lastResumeRef.current ??
        resumeSessionId ??
        null,
      runId,
      effortSeen,
      modelSeen,
      effortOverride: effortOverride?.trim() || null,
    };
    const key = JSON.stringify(s);
    if (key !== lastReportRef.current) {
      lastReportRef.current = key;
      onStatus(tabId, s);
    }
  }, [
    title,
    running,
    shellActive,
    agentId,
    profileId,
    model,
    launchModel,
    cwd,
    activePtyId,
    attention,
    menuPrompt,
    trustPrompt,
    channel,
    promptIdle,
    sessionFile,
    resumeSessionId,
    startedAt,
    runId,
    effortSeen,
    modelSeen,
    effortOverride,
    onStatus,
  ]);

  // 接力那一份：有记录才能换给别家；生成中换不了
  const relayAvailable = Boolean(relaySource());
  const relayState = useMemo<RelayPickState>(
    () => ({
      available: relayAvailable,
      blocked: attention === "working" || pendingReply ? "等这一轮结束再换" : null,
      pick: relayPick,
      options: relayOptions,
    }),
    [relayAvailable, attention, pendingReply, relayPick, relayOptions],
  );
  // 当前会话数据镜像给页面级主工作区聊天层
  useEffect(() => {
    onSessionUpdate(tabId, {
      file: sessionFile,
      sessionId: linkedSessionId,
      title: linkedSessionTitle,
      agentId: linkState === "idle" ? null : agentId,
      state: linkState,
      sync: syncState,
      conv,
      convCursor,
      loadingOlder,
      pendingReply,
      confirmDetail,
      trustPrompt,
      menuPrompt,
      cliModeSwitch,
      tuiPanel,
      tuiNotice,
      waitScreen,
      firstRunNote,
      launchFailure,
      launchBlock,
      specialScreen,
      connIssue,
      grokLoginStuck,
      liveReply,
      liveTokens,
      liveThinking,
      promptSuggestion,
      ptyQuiet,
      stalled,
      launchPick,
      relay: relayState,
      skills: agentSkills,
      mcps: agentMcps,
      channel,
    });
  }, [
    sessionFile,
    linkedSessionId,
    linkedSessionTitle,
    linkState,
    syncState,
    agentId,
    conv,
    convCursor,
    loadingOlder,
    pendingReply,
    confirmDetail,
    trustPrompt,
    menuPrompt,
    cliModeSwitch,
    tuiPanel,
    tuiNotice,
    waitScreen,
    firstRunNote,
    launchFailure,
    launchBlock,
    specialScreen,
    connIssue,
    grokLoginStuck,
    liveReply,
    liveTokens,
    liveThinking,
    promptSuggestion,
    ptyQuiet,
    stalled,
    launchPick,
    relayState,
    agentSkills,
    agentMcps,
    channel,
    onSessionUpdate,
  ]);

  // 从工作树带入目录创建的标签：聚焦配置选择，选好即可启动
  const profileSelectRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (initialCwd) profileSelectRef.current?.focus();
  }, [initialCwd]);

  // 懒挂载：首次可见时才创建 xterm，未展示过的标签不占用终端资源。
  // 被聊天层盖着、也不自动启动的（侧栏点开只看的对话、重启恢复的占位标签）用到才建：切到终端层 / 窥视、
  // 发第一句接回（launch 里 ensureTerminal 现建）。建 xterm + WebGL 约 30ms：原先推到第一帧之后建，
  // 每点一段只看的对话仍白建一个、切完紧跟一次长任务（2026-10-26 改为用到才建）
  const deferTerminal = coveredByChat && !autoStart && !resumeKick;
  const [everVisible, setEverVisible] = useState(visible && !deferTerminal);
  everVisibleRef.current = everVisible;
  useEffect(() => {
    if (!visible || everVisible || deferTerminal) return;
    setEverVisible(true);
  }, [visible, everVisible, deferTerminal]);
  /** 用到才建的标签：launch 前现建 xterm，等它挂好、再等一帧让 fit 量到真实大小 */
  async function ensureTerminal(): Promise<boolean> {
    if (termRef.current) return true;
    setEverVisible(true);
    const until = performance.now() + 2000;
    while (!termRef.current && performance.now() < until) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    if (!termRef.current) return false;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return true;
  }

  // 恢复占位标签只做目录检查，不自动启动或偷偷迁移目录；失效时把修复入口放进空态卡。
  useEffect(() => {
    if (!restored || !visible) return;
    void checkWorkingDirectory(cwd);
  }, [restored, visible, cwd]);

  useEffect(() => {
    if (!everVisible) return;
    const term = new Terminal({
      // Unicode11Addon 使用 xterm 的 proposed Unicode API；显式开启后才能在
      // xterm 6 中加载宽度规则，否则 addon.activate 会抛错并触发顶层错误边界。
      allowProposedApi: true,
      // 字体族单一出处：已选族名 + 应用等宽回退链（App.css --font-mono）。
      // 回退链里 ui-monospace 必须排在 Menlo 之前——macOS 上公开的 "SF Mono" 家族并不
      // 存在（系统那支的 family 是私有名 .SF NS Mono），只有 ui-monospace 才映射到它。
      fontFamily: terminalFontStack(
        settingsRef.current?.terminalFontFamily,
        monoFallbackStack(),
      ),
      fontSize: settingsRef.current?.terminalFontSize ?? 14,
      // 显示质感微调：清瘦锐利（向 Ghostty 靠）、盒绘对齐、粗体增亮、平滑滚动
      fontWeight: 400,
      fontWeightBold: 600,
      rescaleOverlappingGlyphs: true,
      drawBoldTextInBrightColors: true,
      // 暗色 TUI 弱字（brightBlack 灰、dim 修饰）在深底上对比度过低发暗——
      // 按 VS Code 终端同款默认 4.5 兜底提亮（只抬对比度不足的颜色，不改调色板定义）
      minimumContrastRatio: 4.5,
      // Ink 类 TUI（Gemini CLI）整片高频重绘时，平滑滚动动画会叠加成闪烁——关闭
      smoothScrollDuration: 0,
      // 鼠标上报逃生口：claude code / grok 这类全屏 TUI 会开鼠标上报（mode 1000/1002/1006）
      // 接管拖拽，xterm 便不再产生本地选择，getSelection() 恒为空 → ⌘C 无内容可复制。
      // xterm 的 shouldForceSelection 在 macOS 上要求 altKey && 本开关（默认 false，
      // 即 Option+拖拽也失效），Windows/Linux 走 shiftKey 本就能强选。
      // 打开后 Option+拖拽可在任何开鼠标上报的 TUI 里正常选文本。
      macOptionClickForcesSelection: true,
      lineHeight: 1.2,
      letterSpacing: 0,
      cursorStyle: "bar",
      cursorBlink: true,
      scrollback: settingsRef.current?.scrollback ?? 5000,
      // Windows 走 ConPTY（portable-pty）：不声明时 xterm 按裸 Unix 假设处理满宽行回绕，
      // 表格/长回显会错位（借鉴 Hyper/Tabby；buildNumber 取 ≥21376 = 现代 ConPTY 语义）
      ...(IS_WINDOWS
        ? { windowsPty: { backend: "conpty" as const, buildNumber: 21376 } }
        : {}),
      // macOS 触控板增量很小。放大滚动灵敏度，不改 Windows 的一格一行。
      scrollSensitivity: IS_MAC ? 3 : 1,
      fastScrollSensitivity: IS_MAC ? 8 : 5,
      // OSC 8：只打开 http(s) 与 mailto。javascript: 等不进浏览器。
      linkHandler: {
        activate(_event, uri) {
          const safe = safeOsc8Url(uri);
          if (safe) void openUrl(safe);
        },
      },
      theme: buildXtermTheme(
        settingsRef.current?.theme ?? DEFAULT_THEME_ID,
        settingsRef.current?.terminalPalette,
        settingsRef.current?.customTheme,
      ),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    // 命中计数（x/y）：搜不到时给「没有」的明确反馈（借鉴 Tabby/VS Code）
    search.onDidChangeResults((r) => {
      setSearchResults({ index: r.resultIndex, count: r.resultCount });
    });
    // Ghostty/现代终端使用 Unicode 11 宽度规则；xterm 默认 Unicode 6
    // 会让部分 emoji、组合字符和新 CJK 字符错列，尤其在 TUI 表格中明显。
    // 注意：loadAddon 只注册，必须显式把 activeVersion 切到 "11" 才真正生效
    // （2026-10-10 核查发现此前一直没激活，宽度表仍是 Unicode 6）。
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.open(containerRef.current!);
    try {
      fit.fit();
    } catch {
      // 容器隐藏时 fit 会算不出尺寸，可见时再 fit
    }
    termRef.current = term;
    const onPickPointerUp = (event: MouseEvent) => {
      const text = term.getSelection().trim();
      const host = containerRef.current;
      if (!text || !host) return;
      const box = host.getBoundingClientRect();
      setTermPick({
        text,
        x: Math.max(8, Math.min(event.clientX - box.left, box.width - 120)),
        y: Math.max(8, Math.min(event.clientY - box.top + 8, box.height - 36)),
      });
    };
    const onPickCleared = term.onSelectionChange(() => {
      if (!term.getSelection().trim()) setTermPick(null);
    });
    containerRef.current?.addEventListener("mouseup", onPickPointerUp);
    mountedRef.current = true;
    fitRef.current = fit;
    searchRef.current = search;

    // Codex Shift+Enter 改写后，xterm 仍可能再发 `\r`（keydown 返回 false 未 cancel）。
    // 空输入时 Codex 不提交，看起来像换行；有内容时这记 `\r` 会直接发送。
    let swallowShiftEnterCrUntil = 0;
    // Shift+标点已由宿主补发过一次的字符：随后 xterm 的 keypress/input 若再发同一个字，
    // 这里吞掉，避免「?」变「??」。窗口取得短，只兜同一记按键的重复来源。
    let printableEcho = { char: "", count: 0, until: 0 };
    // Cmd/Ctrl+F 在终端聚焦时也呼出搜索条（拦在 xterm 之前，避免 Ctrl+F 字符进 PTY）
    term.attachCustomKeyEventHandler((e) => {
      if (
        e.type === "keydown" &&
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "f"
      ) {
        setSearchOpen(true);
        return false;
      }
      // macOS 贴图键透传：七家 CLI（claude/codex/gemini/qwen/opencode/kimi/codebuddy）
      // 的剪贴板图片粘贴键是 Ctrl+V——CLI 收到按键后自己去读系统剪贴板；但网页侧
      // Ctrl+V 在 WKWebView 里不产生 paste 事件也不进 PTY，须在键盘层改写为 \x16。
      // 只拦 macOS：Windows 各家贴图用 Alt+V（本就透传为 ESC+v），
      // Windows/Linux 的 Ctrl+V 保留文本粘贴语义（走下方 paste 事件路径）。
      if (
        e.type === "keydown" &&
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "c"
      ) {
        const selected = term.getSelection();
        if (selected) {
          e.preventDefault();
          void navigator.clipboard.writeText(selected).catch(() => {});
          // Windows 的 Ctrl+C 兼任复制与打断：复制完清掉选区，下一次 Ctrl+C 才能打断 Agent
          // （Windows Terminal 同口径）。macOS 复制走 ⌘C，不清
          if (IS_WINDOWS) term.clearSelection();
          return false;
        }
      }
      if (
        IS_MAC &&
        e.type === "keydown" &&
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "v"
      ) {
        // ⌘V 先看剪贴板里有没有图片。有图就落成路径；没有再当普通文本粘贴。
        if (e.metaKey) {
          void pasteFromClipboard();
          return false;
        }
        const id = ptyIdRef.current;
        if (id) {
          // kimi 开了 kitty 键盘协议后只认 CSI-u（v=118 + ctrl 修饰位 5），
          // 与同函数上方 Enter → CSI-u 同一改写模式
          const data =
            agentIdRef.current === "kimi" ? KIMI_CSI_U_CTRL_V : "\x16";
          invoke("pty_write", { ptyId: id, data }).catch((e) => setError(String(e)));
        }
        return false;
      }
      // ⌘← / ⌘→ / ⌘⌫ 照 iTerm2「自然文本编辑」改写成 Ctrl+A / E / U（macLineEditKey）；
      // 要排在 kitty 编码前面——那条路会把它们编成 super 修饰，多数 CLI 不认
      if (IS_MAC) {
        const lineEdit = macLineEditKey(e, kkpArmedRef.current);
        if (lineEdit) {
          if (e.type === "keydown") {
            const id = ptyIdRef.current;
            if (id) {
              markInteraction();
              invoke("pty_write", { ptyId: id, data: lineEdit }).catch((err) =>
                setError(String(err)),
              );
            }
          }
          return false;
        }
      }
      // ⌘/Ctrl+Enter 空态直启：终端聚焦时按键到不了 window 监听，必须在 xterm 键盘层拦
      if (
        e.type === "keydown" &&
        (e.metaKey || e.ctrlKey) &&
        e.key === "Enter" &&
        welcomeVisibleRef.current
      ) {
        launchNowRef.current();
        return false;
      }
      // 子进程推过 Kitty 键盘之后才改编码。此前 Ctrl+C 仍是中断字符，shell 不受影响。
      // 不发松开：查询应答里也没有那一位。纯 Shift 的可打印字符留给 xterm / 输入法。
      if (
        kkpArmedRef.current &&
        e.type === "keydown" &&
        !e.isComposing
      ) {
        // 没选区的 ⌘C 已经过了复制分支。不要把它编成 CSI 写进 TUI。
        if (
          e.metaKey &&
          !e.ctrlKey &&
          !e.altKey &&
          !e.shiftKey &&
          e.key.toLowerCase() === "c"
        ) {
          return false;
        }
        // Ctrl/⌘+V 同理只放行不编码：编码会把 CSI-u 118 写进 PTY，而粘贴事件
        // 又写一次文本——Windows（Ctrl+V）与 mac（⌘V）都双发（2026-10-11 复核实证）
        if (
          (e.metaKey || e.ctrlKey) &&
          !e.altKey &&
          !e.shiftKey &&
          e.key.toLowerCase() === "v"
        ) {
          return false;
        }
        const encoded = encodeKittyKey({
          type: e.type,
          key: e.key,
          code: e.code,
          shiftKey: e.shiftKey || e.getModifierState("Shift"),
          altKey: e.altKey,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          repeat: e.repeat,
        });
        if (encoded) {
          const id = ptyIdRef.current;
          if (!id) return true;
          if (e.shiftKey && e.key === "Enter") {
            swallowShiftEnterCrUntil = performance.now() + 80;
          }
          // return false 时 xterm 不接手这一键，也就不替我们拦浏览器的默认动作：⇧Tab 写进去切完权限，焦点又跳到界面按钮上
          if (keyNeedsPreventDefault(e)) e.preventDefault();
          invoke("pty_write", { ptyId: id, data: encoded }).catch((err) =>
            setError(String(err)),
          );
          return false;
        }
      }
      // 协议还没推上来时的旧改写：kimi 的 Enter、Codex 的 Shift+Enter。
      if (
        agentIdRef.current === "kimi" &&
        e.type === "keydown" &&
        e.key === "Enter" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey
      ) {
        const id = ptyIdRef.current;
        if (id) {
          armPtyWorking();
          invoke("pty_write", { ptyId: id, data: KIMI_CSI_U_ENTER }).catch((err) =>
            setError(String(err)),
          );
        }
        // 只 return false 不 preventDefault，浏览器照发 keypress，xterm 再补一个 `\r`：普通发送时落在空输入框上看不出，
        // /permission 这类选择器刚弹出就被这个 `\r` 选中当前项关掉（Kimi 写「Permission mode unchanged」，2026-10-22 用户实测）
        e.preventDefault();
        swallowShiftEnterCrUntil = performance.now() + 80;
        return false;
      }
      if (
        e.key === "Enter" &&
        (e.shiftKey || e.getModifierState("Shift")) &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        const rewrite = ptyShiftEnterRewrite(agentIdRef.current);
        if (rewrite) {
          e.preventDefault();
          e.stopPropagation();
          if (e.type === "keydown") {
            swallowShiftEnterCrUntil = performance.now() + 80;
            const id = ptyIdRef.current;
            if (id) {
              invoke("pty_write", { ptyId: id, data: rewrite }).catch((err) =>
                setError(String(err)),
              );
            }
          }
          return false;
        }
      }
      // Shift+标点丢字：WKWebView 上 Shift+`/` 报 keyCode 0 或 229（不是 191），这一下 xterm 都不发，
      // 当场补发，再由下面的哨兵吞掉 xterm 可能补发的那一次。keyCode >= 48 交给 xterm：它认识
      // Shift+标点（evaluateKeyboardEvent 的 191:["/","?"] 等键位表），无需宿主插手。
      if (e.type === "keydown") {
        // 只为 WKWebView / WebKitGTK 兜底：Windows 中文输入法（微软拼音中文标点）的 Shift+1 也报
        // keyCode 229，补发 ASCII「!」后输入法再上屏「！」，CLI 收到「!！」
        const fallback = IS_WINDOWS ? null : printableKeyFallback(e);
        if (fallback) {
          const id = ptyIdRef.current;
          // PTY 还没就绪时不能补发，但**更不能把这一记吞掉**：原实现无论有没有 id 都设哨兵并
          // return false，等于 xterm 也被拦住、PTY 也没收到，按键凭空消失。没 id 就原样放行，
          // 让 xterm 走它自己的路径。
          if (!id) return true;
          invoke("pty_write", { ptyId: id, data: fallback.data }).catch((err) =>
            setError(String(err)),
          );
          printableEcho = armPrintableEcho(
            printableEcho,
            fallback.data,
            performance.now(),
          );
          return false;
        }
      }
      return true;
    });

    // 渲染器选择（设置页「终端渲染」）：自动档两个平台都走 WebGL（2026-10-22 用户拍板，此前 Mac 默认 DOM——
    // 当年判 WebGL 在 WKWebView 里偏软，xterm 6 下逐像素复测已与 DOM 持平，见 terminal-renderer.ts）；
    // 只有显式选「兼容（DOM）」才不加载。软件渲染（SwiftShader 等，闪烁）时退回 DOM。
    // 上下文丢失不再永久退 DOM（借鉴 Tabby）：终端标签长寿命、常驻后台，正是丢失高发场景；
    // 窗口重新聚焦/可见时预算重试（≤3 次），再丢才认命回落。
    const wantWebgl = wantsWebglRenderer(settingsRef.current?.terminalRenderer);
    let webglRecoveryLeft = 3;
    // webglActive：当前已加载且健康——没有它，每次窗口聚焦都会重建 renderer、
    // 新开 WebGL 上下文（2026-10-11 复核实证）。软件渲染探针也只开一次。
    let webglActive = false;
    let softwareWebgl: boolean | null = null;
    // WebGL 的单元格宽改成就近取整（webglLetterSpacing：原本一律向下取整，Retina 上每格窄 3.8%、
    // 1 倍屏窄 10%）。卸下 WebGL 回 0——DOM 渲染器按实际字宽排。字号字体、像素比、字体加载完都要重算
    const syncCellWidth = () => {
      const spacing = webglActive
        ? webglLetterSpacing(
            measureTerminalCharWidth(term.options.fontSize ?? 14, term.options.fontFamily ?? ""),
            window.devicePixelRatio,
          )
        : 0;
      if (term.options.letterSpacing === spacing) return;
      term.options.letterSpacing = spacing;
      try {
        fit.fit();
      } catch {
        // 容器隐藏时 fit 算不出尺寸，可见时再 fit
      }
    };
    const loadWebgl = (): boolean => {
      if (!wantWebgl || webglActive || webglRecoveryLeft <= 0) return false;
      try {
        if (softwareWebgl === null) softwareWebgl = isSoftwareWebGL();
        if (softwareWebgl) return false;
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
          webglActive = false;
          webglRecoveryLeft -= 1;
          syncCellWidth();
          // 退回的是新建的 DOM 渲染器：滚动按行挪位要重新挂上
          teardownRowReuse();
          teardownRowReuse = installDomScrollRowReuse(term);
        });
        term.loadAddon(webgl);
        webglActive = true;
        syncCellWidth();
        return true;
      } catch {
        return false;
      }
    };
    loadWebgl();
    cellWidthSyncRef.current = syncCellWidth;
    // 拖到另一块像素比不同的屏、界面缩放（⌘= / ⌘-）：xterm 自己会重算尺寸，补位要跟着重判
    const stopDprWatch = watchDevicePixelRatio(() => syncCellWidth());
    document.fonts?.addEventListener?.("loadingdone", syncCellWidth);
    const recoverWebgl = () => {
      if (wantWebgl && webglRecoveryLeft > 0) loadWebgl();
    };
    const onVisRecover = () => {
      if (document.visibilityState === "visible") recoverWebgl();
    };
    window.addEventListener("focus", recoverWebgl);
    document.addEventListener("visibilitychange", onVisRecover);
    const teardownWebglRecovery = () => {
      window.removeEventListener("focus", recoverWebgl);
      document.removeEventListener("visibilitychange", onVisRecover);
      stopDprWatch();
      document.fonts?.removeEventListener?.("loadingdone", syncCellWidth);
      cellWidthSyncRef.current = null;
    };

    // 触控板滚动合帧（见 src/terminal-wheel-scroll.ts）：xterm 只对物理滚轮做平滑动画，
    // 触控板是「一枚事件写一次滚动位置、触发一次整屏重绘」——60–120Hz 细粒度小增量下就是
    // 「上下滑动一卡一卡」。这里把同帧内的多枚事件合成一枚再交回 xterm 原滚动逻辑，
    // 压到每帧最多一次写入与重绘；备用屏/鼠标上报/带修饰键仍原样交给 xterm。
    const teardownWheelCoalescing = installTrackpadWheelCoalescing(term);
    // 滚轮一格也是整屏重画。视口平移不到一屏时把还在屏幕上的行挪走，只重画新行。
    let teardownRowReuse = installDomScrollRowReuse(term);

    // 链接可点击：点击经 opener 插件打开系统浏览器（不泄进 PTY，与技能页同源）
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        void openUrl(uri);
      }),
    );
    term.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const raw = term.buffer.active.getLine(bufferLineNumber - 1);
        if (!raw) return callback([]);
        // 字符下标 ≠ 单元格列号（中文/emoji 宽字符占 2 格）。src 版 translateToString
        // 有 outColumns 回填参数，但 6.0.0 编译产物里没有（2026-10-11 复核实证）——
        // 逐格自算「每个字符 → 所在单元格列号」；复用格必须取自 getNullCell。
        const probe = term.buffer.active.getNullCell();
        const columns: number[] = [];
        let text = "";
        for (let x = 0; x < raw.length; x += 1) {
          const cell = raw.getCell(x, probe);
          if (!cell || cell.getWidth() === 0) continue; // 搭子格/越界格不产字符
          const chars = cell.getChars() ?? "";
          const emitted = chars.length > 0 ? chars : " "; // 空白格按 translateToString 口径补空格
          for (const ch of emitted) {
            columns.push(x);
            text += ch;
          }
        }
        const hits = terminalPathHits(text);
        if (hits.length === 0) return callback([]);
        callback(
          hits.flatMap((hit) => {
            const range = hitCellRange(hit, columns);
            if (!range) return [];
            return [
              {
                range: {
                  start: { x: range.startX, y: bufferLineNumber },
                  end: { x: range.endX, y: bufferLineNumber },
                },
                text: hit.text,
                activate() {
                  if (hit.kind === "absolute") {
                    onOpenPathRef.current?.(hit.path, hit.line);
                    return;
                  }
                  // 相对路径/~：点击时按标签 cwd 校验存在再打开（一次 stat，误报词点了给提示）
                  void invoke<string | null>("terminal_link_target", {
                    cwd: cwdRef.current ?? "",
                    path: hit.path,
                  })
                    .then((abs) => {
                      if (abs) {
                        onOpenPathRef.current?.(abs, hit.line);
                      } else {
                        flashInputNote(`没找到 ${hit.path}`);
                      }
                    })
                    .catch(() => flashInputNote(`没找到 ${hit.path}`));
                },
              },
            ];
          }),
        );
      },
    });

    // BEL 响铃 → 系统通知（claude-code 的通知通道就是 BEL，不发 OSC 9/777；
    // 2026-10-10 二进制核查确认）。只对 Agent 生效，shell 里的 \a 不打扰。
    // 订阅随 term.dispose() 一并释放，无需单独清理。
    term.onBell(() => {
      if (ptyKindRef.current !== "agent") return;
      notifyTerminal("终端响铃，可能需要你确认");
    });

    // 剪贴板粘贴的统一入口（capture 阶段，先于 xterm 默认行为）：
    // ① image/* → 落盘成绝对路径写 PTY（原有路径）；
    // ② 有文本 → 过粘贴防线（shell 多行确认 / 剪收尾回车）后自管写入；
    // ③ 无文本无图 → 可能是 Finder/资源管理器复制的文件（webview 剪贴板不给路径），
    //    探一次原生剪贴板，有文件就按引号路径写入（mac NSPasteboard / win CF_HDROP）。
    const container = containerRef.current!;
    const onPasteCapture = (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const idx = firstImageItem(items);
      if (idx >= 0) {
        e.preventDefault();
        e.stopPropagation();
        const file = items[idx].getAsFile();
        if (file) void pasteImageFile(file);
        return;
      }
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text) {
        e.preventDefault();
        e.stopPropagation();
        handleTerminalTextPaste(text);
        return;
      }
      // 无文本：默认粘贴本来也写不进东西，接管去探原生文件剪贴板
      e.preventDefault();
      void invoke<string[]>("read_clipboard_files")
        .then((files) => {
          if (!files.length) return;
          const joined = joinDroppedPaths(files, IS_WINDOWS);
          if (joined) writePtyPaste(joined, `已粘贴 ${files.length} 个文件路径`);
        })
        .catch(() => {});
    };
    container.addEventListener("paste", onPasteCapture, true);

    // 文件拖入转路径：只响应落在本终端 rect 内的 drop（人工事项导入等其它
    // 拖放监听按各自坐标域区分，互不拦截）；多路径 shell 转义后空格拼接，
    // 不换行——只进输入框，避免误执行
    const unlistenDrop = getCurrentWebviewWindow().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return; // display:none 的隐藏标签 rect 全 0
      const scale = window.devicePixelRatio || 1;
      const { x, y } = event.payload.position;
      if (!dropHitsRect({ x, y }, rect, scale)) return;
      // 聊天层盖住这块坐标时由 ChatSurface 接管（拖入进输入框，不写 PTY）
      const overChat = [
        [x, y],
        [x / scale, y / scale],
      ].some(([px, py]) => {
        const el = document.elementFromPoint(px, py);
        return Boolean(el?.closest("[data-chat-drop]"));
      });
      if (overChat) return;
      const paths = event.payload.paths;
      const text = joinDroppedPaths(paths, IS_WINDOWS);
      if (!text) return;
      const id = ptyIdRef.current;
      if (id) {
        writeInteractivePty(id, text, `已写入 ${paths.length} 个路径`);
      } else {
        flashInputNote("终端未启动，无法写入路径");
      }
    });

    // fit 限频（借鉴 Tabby）：拖分屏把手/开合侧栏时 resize 事件连发，裸调 fit 每次都
    // 全量重排；rAF 合并到帧尾一次 + trailing 兜底，WKWebView 重排更贵，收益明显
    let fitQueued = false;
    let fitPending = false;
    const runFit = () => {
      try {
        fit.fit();
      } catch {
        // display:none 时尺寸为 0，fit 会抛；可见性 effect 里会补
      }
    };
    const scheduleFit = () => {
      if (fitQueued) {
        fitPending = true;
        return;
      }
      fitQueued = true;
      requestAnimationFrame(() => {
        fitQueued = false;
        runFit();
        // 帧内又有请求：再排一帧（trailing），不丢最后一次尺寸
        if (fitPending) {
          fitPending = false;
          scheduleFit();
        }
      });
    };
    const onWinResize = () => scheduleFit();
    window.addEventListener("resize", onWinResize);

    // 容器尺寸变化的通用兜底：状态栏进出、启动栏塌缩、分屏拖拽、侧栏开合……
    // 凡改变 xterm 容器高度的都自动 fit，不再逐个点名触发（留空/遮行问题的根治）
    const resizeObs = new ResizeObserver(() => scheduleFit());
    if (containerRef.current) resizeObs.observe(containerRef.current);

    // 画面稳定后再告诉进程一次。继续会话时高度会从启动栏展开变成收起，
    // 不通知的话 Claude 按矮的画完，又在变高后的底边自己补一行。
    let resizeCoalesceTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingResize: { cols: number; rows: number } | null = null;
    const subs = [
      term.onData((data) => {
        if (
          data === "\r" &&
          swallowShiftEnterCrUntil !== 0 &&
          performance.now() < swallowShiftEnterCrUntil
        ) {
          swallowShiftEnterCrUntil = 0;
          return;
        }
        // 宿主刚补过的符号：xterm 组词收尾若再送出同一个，按次数吞掉。
        const echo = takePrintableEcho(printableEcho, data, performance.now());
        printableEcho = echo.guard;
        if (echo.swallow) return;
        markInteraction();
        if (ptyInputLooksLikeSubmit(data, KIMI_CSI_U_ENTER)) armPtyWorking();
        else if (data === "\x1b") settleAfterEsc();
        const id = ptyIdRef.current;
        if (id) invoke("pty_write", { ptyId: id, data }).catch((e) => setError(String(e)));
      }),
      term.onResize(({ cols, rows }) => {
        pendingResize = { cols, rows };
        if (resizeCoalesceTimer) clearTimeout(resizeCoalesceTimer);
        resizeCoalesceTimer = setTimeout(() => {
          resizeCoalesceTimer = null;
          const size = pendingResize;
          pendingResize = null;
          const id = ptyIdRef.current;
          if (!id || !size) return;
          invoke("pty_resize", {
            ptyId: id,
            cols: size.cols,
            rows: size.rows,
          }).catch(() => {});
        }, 400);
      }),
      // 备屏进出（进/出 claude code、vim 这类全屏程序）时同步搜索条提示。
      // 只在类型真的翻转时 setState：xterm 开备屏时会连发数次事件，直接设值会让
      // 这个体量很大的组件白白重渲染好几轮。
      term.buffer.onBufferChange((buf) => {
        const alt = buf.type === "alternate";
        setAltBufferActive((prev) => (prev === alt ? prev : alt));
      }),
    ];

    // xterm 6 已移除 onFocus/onBlur 事件：焦点进出挂在内层隐藏 textarea 上。
    // 焦点变化会作为 mode 1004 事件发给 TUI 并触发重绘，记交互时间供输出侧抑制
    const termTextarea = term.textarea;
    const onTermFocusChange = () => markInteraction();
    termTextarea?.addEventListener("focus", onTermFocusChange);
    termTextarea?.addEventListener("blur", onTermFocusChange);

    // 只在组件卸载（标签被关闭 / 应用退出）时清理 PTY；隐藏不触发
    return () => {
      mountedRef.current = false;
      window.removeEventListener("resize", onWinResize);
      resizeObs.disconnect();
      if (resizeCoalesceTimer) clearTimeout(resizeCoalesceTimer);
      container.removeEventListener("paste", onPasteCapture, true);
      termTextarea?.removeEventListener("focus", onTermFocusChange);
      termTextarea?.removeEventListener("blur", onTermFocusChange);
      void unlistenDrop.then((f) => f());
      subs.forEach((s) => s.dispose());
      onPickCleared.dispose();
      container.removeEventListener("mouseup", onPickPointerUp);
      stopLinkTimer();
      stopSessionWatcher();
      stopPendingReplyPolling();
      if (settleRetryTimerRef.current != null) {
        clearTimeout(settleRetryTimerRef.current);
        settleRetryTimerRef.current = null;
      }
      // 释放 liveSessions 登记（「进行中」标记随标签消失）
      const sid = linkCtxRef.current?.sessionId;
      const linkedAgent = linkCtxRef.current?.agentId;
      if (sid && linkedAgent) setLiveSession(linkedAgent, sid, null);
      invoke("release_session_claim", { claimId: tabId }).catch(() => {});
      // 注意：这里不存回放。关标签 = 标签即将消失，replay 文件由 requestCloseTab
      // 先 drop；「上次离开时的画面」在 pty-exit / 页面隐藏 / 关窗守卫三处存
      // （2026-10-10 修：原先只在卸载时存，应用退出不触发卸载 → 占位标签永远空）。
      const id = ptyIdRef.current;
      ptyIdRef.current = null;
      ptyKindRef.current = null;
      if (id) invoke("pty_kill", { ptyId: id }).catch(() => {});
      unlistenRef.current.forEach((u) => u());
      teardownWheelCoalescing();
      teardownRowReuse();
      teardownWebglRecovery();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [everVisible]);

  /** 用户最后看到的终端文字：全屏 TUI 在备用屏时拍可视行，否则取普通缓冲最后 limit 行（回放与「对不上」反馈共用） */
  function bufferTailLines(limit: number): string[] {
    const term = termRef.current;
    if (!term) return [];
    const lines: string[] = [];
    if (term.buffer.active.type === "alternate") {
      for (let y = 0; y < term.rows; y += 1) {
        lines.push(term.buffer.active.getLine(y)?.translateToString(true) ?? "");
      }
    } else {
      const normal = term.buffer.normal;
      const from = Math.max(0, normal.length - limit);
      for (let y = from; y < normal.length; y += 1) {
        lines.push(normal.getLine(y)?.translateToString(true) ?? "");
      }
    }
    return lines;
  }
  /** 抓当前终端画面存回放。全屏 TUI 挂在备用屏时普通缓冲往往只有启动前的空屏
   *  （claude 整场都在 1049），此时改拍备用屏的可视行——回放要的是用户最后看到的画面。 */
  function saveTerminalReplayNow() {
    if (!termRef.current || !everVisibleRef.current) return;
    const replay = terminalReplayText(bufferTailLines(400), 400);
    if (replay.trim()) {
      invoke("save_terminal_replay", { tabId, text: replay }).catch(() => {});
    }
  }

  // 回放的存点：页面卸载（应用退出）、应用切后台/最小化、关窗守卫信号，
  // 以及**30 秒周期快照**——关窗链路（JS onCloseRequested 与 Rust emit→listen）
  // 在实机上都可能整条断掉（2026-10-11 探针实证），周期快照让任何死亡方式
  // （正常关窗/崩溃/kill -9/输入法卡死）都只损失最后 30 秒画面。
  useEffect(() => {
    if (!everVisible) return;
    const save = () => saveTerminalReplayNow();
    const onSaveAll = () => save();
    window.addEventListener("pagehide", save);
    window.addEventListener("mesa:save-terminal-replays", onSaveAll);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") save();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const timer = setInterval(save, 30_000);
    return () => {
      window.removeEventListener("pagehide", save);
      window.removeEventListener("mesa:save-terminal-replays", onSaveAll);
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [everVisible]);

  useEffect(() => {
    if (!everVisible || !restored) return;
    let cancelled = false;
    void invoke<string>("load_terminal_replay", { tabId }).then((text) => {
      const term = termRef.current;
      if (cancelled || !term || !text.trim() || ptyIdRef.current) return;
      term.writeln(`\x1b[90m${REPLAY_HEAD}\x1b[0m`);
      term.write(text.replace(/\n/g, "\r\n"));
      term.writeln(`\r\n\x1b[90m${REPLAY_TAIL}\x1b[0m`);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [everVisible, restored, tabId]);

  // 空态隐藏 xterm 的静态块光标（左上角那个）：DECTCEM 转义对 WebGL/DOM 渲染都生效，
  // 不写进回滚缓冲；启动后进程输出会自行把光标恢复
  useEffect(() => {
    termRef.current?.write(welcomeVisible ? "\x1b[?25l" : "\x1b[?25h");
  }, [welcomeVisible, everVisible]);

  // 布局变化只重排画面。进程起来之后不再通知它改行列：
  // 从综述流程继续时，多出来的高度会让 Claude 把状态行再画一份。
  useEffect(() => {
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {}
    });
  }, [visible, rightOpen, layoutKey, barExpanded, embedInPeek]);

  // 最近项目/⇄「真进入」：外部注入的 cwd 落地到启动栏；shell 存活时写 cd 让终端真正跟上
  //（否则树走了 shell 还在原地，真实 cwd 轮询会把路径拉回旧目录）
  useEffect(() => {
    if (visible && externalCwd && !running) {
      setCwd(externalCwd);
      if (shellActive && activePtyId) {
        // 按这个标签实际用的 shell 拼 cd（设置里可换成 cmd / Git Bash，写法各不相同）
        invoke("pty_cd", { ptyId: activePtyId, path: externalCwd }).catch(() => {});
      }
      onConsumeExternalCwd?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, externalCwd, running]);

  // 工作区合并/归档/删除后：本标签还留在被移除的工作树里时切回主仓库（shell 写 cd +
  // 启动栏更新），避免目录被删后终端/文件树烂尾
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const shellRef = useRef({ shellActive, running, activePtyId });
  shellRef.current = { shellActive, running, activePtyId };
  useEffect(() => {
    let un: (() => void) | undefined;
    listen<{ worktreePath: string; repoPath: string }>("ws-archived", (e) => {
      const { worktreePath, repoPath } = e.payload;
      const cur = cwdRef.current;
      if (!pathWithin(cur, worktreePath)) return;
      setCwd(repoPath);
      const s = shellRef.current;
      if (s.shellActive && !s.running && s.activePtyId) {
        invoke("pty_cd", { ptyId: s.activePtyId, path: repoPath }).catch(() => {});
      }
    }).then((u) => (un = u));
    return () => un?.();
  }, []);

  // run 脚本标签：终端就绪后自动开 shell 并写入脚本命令（tty 会缓冲输入直到 shell 读取）。
  // 声明在终端创建 effect 之后，保证 attach 时 termRef 已就位
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (
      (!shellOnly && !customRuntimeId) ||
      (customRuntimeId && restored) ||
      !visible ||
      !everVisible ||
      autoStartedRef.current
    )
      return;
    void (async () => {
      try {
        const launchCwd = customRuntimeId
          ? await resolveLaunchCwdForCustom(customRuntimeId, cwd)
          : cwd;
        if (!(await checkWorkingDirectory(launchCwd))) return;
        autoStartedRef.current = true;
        if (launchCwd !== cwd) setCwd(launchCwd);
        const size = fittedPtySize(fitRef.current, termRef.current);
        if (!allowSpawn(size)) {
          setError("这次没能按画面大小启动");
          return;
        }
        resizeLatchRef.current = {
          kind: "measured",
          cols: size.cols,
          rows: size.rows,
        };
        const ptyId = customRuntimeId
          ? (await invoke<{ ptyId: string }>("pty_spawn_custom", {
              runtimeId: customRuntimeId,
              cwd: launchCwd,
              runId: runId ?? initialRunId,
              cols: size.cols,
              rows: size.rows,
            })).ptyId
          : await invoke<string>("shell_spawn", {
              cwd,
              extraEnv: initialExtraEnv ?? null,
              purpose: "script",
              runId: runId ?? initialRunId ?? null,
              cols: size.cols,
              rows: size.rows,
            });
        await attach(ptyId, customRuntimeId ? "agent" : "shell", { reset: true });
        setExited(false);
        setExitCode(null);
        setShellActive(!customRuntimeId);
        // 与「启动后自动收缩」一致：脚本已接管终端，启动栏收成一行
        setBarExpanded(false);
        if (!customRuntimeId && prefillCommand) {
          await invoke("pty_write", { ptyId, data: `${prefillCommand}${SHELL_ENTER}` });
        }
      } catch (e) {
        const rid = runId ?? initialRunId;
        if (rid) invoke("run_close", { id: rid }).catch(() => {});
        setError(String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, everVisible, shellOnly, customRuntimeId]);

  // 会话恢复标签：首次可见且找得到配置时自动启动一次（找不到则只预填，由用户处理）。
  // 启动放进 setTimeout(0)，卸载时清掉：开发态 StrictMode 会假卸载再挂一次，
  // 同步连启两次会抢同一条 Run 锁，第二次报「此运行已在启动或执行中」。
  const autoLaunchedRef = useRef(false);
  useEffect(() => {
    if (!autoStart || !visible || !everVisible || autoLaunchedRef.current)
      return;
    const profile = customRuntimeId
      ? undefined
      : profiles.find((p) => p.id === profileId);
    // 官方账号必须等登录检测落锤：未探测完不启动（避免拿 401 当启动结果），
    // 已确认未登录则停自动启动并提示，不静默改道别的配置
    if (profile?.accountType === "official") {
      if (!officialStReady) return;
      if (!officialSt?.connected) {
        autoLaunchedRef.current = true;
        setError(
          "官方账号未登录：请到连接页登录，或在启动栏改选网关配置后手动启动",
        );
        setBarExpanded(true);
        return;
      }
    }
    if (!(customRuntimeId || profile)) return;
    const timer = window.setTimeout(() => {
      if (autoLaunchedRef.current) return;
      autoLaunchedRef.current = true;
      // 带着开场话自动启动（开始 / 继续 / 退回修改 / 跟进更新…）：那句先在聊天里出气泡，和输入框里发第一句同一套
      // （2026-11-11 用户：退回修改跳到聊天层，消息要等一会才出来——CLI 起来、接回长对话、话写进会话文件之前一片空白）。
      // 启动没成就收回；成了照常等会话文件记下后替换
      const opening = !restored && !customRuntimeId ? promptText.trim() : "";
      const early = opening ? showEarlyBubble(opening) : null;
      // launch 内部 try 只包住 pty_spawn 起的后半段；前置段（目录检查/清理/官方账号
      // 确认）抛错时 void 吞掉就是「自动启动没反应」。落到错误面并展开启动栏，
      // 让用户（和我们）看得到失败原因。Promise.resolve 兜 launch 返回 null 的分支。
      Promise.resolve(restored && !customRuntimeId ? restoreTask() : launch())
        .then((res) => {
          if (!early) return;
          if (res) early.reRegister();
          else early.retract();
        })
        .catch((e) => {
          early?.retract();
          setError(`自动启动失败：${String(e)}`);
          setBarExpanded(true);
        })
        .finally(() => {
          if (early) endEarlyBubbleLaunch();
        });
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, everVisible, autoStart, profileId, profiles, restored, officialSt, officialStReady]);

  const lastResumeKickRef = useRef(0);
  useEffect(() => {
    if (!resumeKick || resumeKick === lastResumeKickRef.current) return;
    // Agent 还在跑：先不消费这次 kick，等它停了再拉起。
    // 标签还藏着时不预热：fit 会落到 0×0，再拉宽就把窄画面写进滚动记录。
    if (!visible || !everVisible || running) return;
    lastResumeKickRef.current = resumeKick;
    void launch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeKick, visible, everVisible, running]);

  /** 终端自己发的通知（OSC 9/777 标题、BEL）：与注意力通知同一套门——
   *  设置关了不发、前台当前标签不打扰（画面就在眼前）、按标签限频。
   *  OSC 9;4 进度序列已在 terminal-notify 里排除，不会走到这里。 */
  function notifyTerminal(title: string) {
    if (!(settingsRef.current?.notificationsEnabled ?? true)) return;
    if (visibleRef.current && !document.hidden && document.hasFocus()) return;
    const now = Date.now();
    if (!debounceAllows(terminalNotifyAtRef.current, now)) return;
    terminalNotifyAtRef.current = now;
    // 正文带来源：多标签并跑时区分是谁在叫（三轮审查：原标题/正文颠倒且无来源）
    void fireAttentionNotification(
      title,
      `${agentLabel(agentIdRef.current)} · 终端`,
      { tabId, cwd: cwdRef.current },
    );
  }

  /** 把一个 PTY 接到 xterm 上；agent 退出时自动回落到 shell */
  async function attach(
    ptyId: string,
    kind: PtyKind,
    opts?: { reset?: boolean; focus?: boolean },
  ) {
    // await 途中组件可能已卸载（关标签）：杀掉没人持有的 PTY，不碰已 dispose 的 xterm
    if (!mountedRef.current || !termRef.current) {
      invoke("pty_kill", { ptyId }).catch(() => {});
      return;
    }
    const term = termRef.current;
    if (opts?.reset) {
      term.reset();
      void invoke("drop_terminal_replay", { tabId }).catch(() => {});
    }
    unlistenRef.current.forEach((u) => u());
    ptyIdRef.current = ptyId;
    ptyKindRef.current = kind;
    if (kind === "agent") {
      ptyAttachedAtRef.current = Date.now();
      inputReadyRef.current = false;
      startupSettledRef.current = false;
    }
    kkpArmedRef.current = false;
    queryPendingRef.current = "";
    hostPendingRef.current = "";
    kittyAccumRef.current = "";
    signalPendingRef.current = "";
    setInlineImageUrl(null);
    setActivePtyId(ptyId);
    setEffortSeen(null);
    setModelSeen(null);
    effortTailRef.current = "";
    launchAgentRef.current = agentId;
    // 启动后 20 秒也盯确认菜单：完全访问启动时 Claude Code 先弹「Bypass Permissions mode」警告，
    // 默认高亮在 No——聊天层不给按钮就卡在「已送出」（2026-10-17 本机 PTY 实录）。不替用户选
    if (kind === "agent") {
      menuBaselineRef.current = null;
      menuWatchUntilRef.current = Date.now() + 20_000;
      firstRunRef.current = { busyUntil: 0, tries: {} };
      setFirstRunNote(null);
      setWaitScreenState(null);
      setSpecialScreenState(null);
      setLaunchFailure(null);
      setLaunchBlock(null);
      // 换连接 / 重开接回后，xterm 里还留着上一个进程画的错误：记作已看过，不再提示
      connBaselineRef.current = connIssueCounts(detectConnIssues(screenLines(), agentId));
    }
    // 输出走 Rust 交来的通道（pty_subscribe，见下方）：小帧是字符串，≥8KB 的大帧是原始字节
    //（不转义、不拼脚本执行）。每帧画完回流控确认，攒满 OUTPUT_ACK_CHUNK 发一次；后端未确认的
    // 超过 10 万字就停读 PTY，刷屏时 Ctrl+C 立即见效（pty.rs FlowGate）
    const output = new Channel<string | ArrayBuffer>();
    const listenOutput = (handle: (payload: string) => void) => {
      const decoder = new TextDecoder();
      output.onmessage = (message) =>
        handle(typeof message === "string" ? message : decoder.decode(message));
      return () => {
        output.onmessage = () => {};
      };
    };
    let drawnUnacked = 0;
    const ackDrawn = (units: number) => {
      drawnUnacked += units;
      if (drawnUnacked < OUTPUT_ACK_CHUNK) return;
      const done = drawnUnacked;
      drawnUnacked = 0;
      void invoke("pty_ack", { ptyId, units: done }).catch(() => {});
    };
    unlistenRef.current = [
      listenOutput((payload) => {
        // 查询在这里只剥掉、跟踪 Kitty 推栈；应答由后端读线程当场写回（term_query.rs），
        // 前端再答就是第二份，且后台标签的 backlog 补发会让应答晚到、被 CLI 当成按键打进输入框
        const queried = consumeTerminalQueries(queryPendingRef.current, payload);
        queryPendingRef.current = queried.pending;
        for (const reply of queried.replies) {
          if (reply.kkp === "arm") kkpArmedRef.current = true;
          if (reply.kkp === "disarm") kkpArmedRef.current = false;
        }
        // 贴图 / OSC 52 / OSC 9、777 通知统一走断帧管线（consumeHostSequences）：
        // 半截序列攒到下一帧，不把转义或 base64 画进画面
        const host = consumeHostSequences(
          hostPendingRef.current,
          queried.text,
          kittyAccumRef.current,
        );
        hostPendingRef.current = host.pending;
        kittyAccumRef.current = host.kittyAccum;
        if (host.clipboard) {
          void navigator.clipboard.writeText(host.clipboard).catch(() => {});
        }
        for (const title of host.titles) {
          notifyTerminal(title);
        }
        if (host.progress) onProgressRef.current?.(tabId, host.progress);
        const image = host.images.find((item) => item.protocol === "kitty");
        if (image) {
          setInlineImageUrl(`data:${image.mime};base64,${image.payload}`);
        }
        if (host.text) {
          // 带清回滚区（ESC[3J）的整屏重画（Ink 回复超一屏时每帧「清屏 + 整段历史重打」）：用户正往上翻着时，
          // xterm 清掉回滚区后把视口钉在新历史的最顶端、此后每帧都回到顶，往下滚也被拽回去，看着像滚轮反了。
          // 历史是从头原样重打的，按原来的行号把视口放回去，用户看的还是那一段
          const buf = term.buffer.active;
          const keepLine =
            host.text.includes("\x1b[3J") && buf.viewportY < buf.baseY ? buf.viewportY : null;
          if (keepLine === null) term.write(host.text, () => ackDrawn(payload.length));
          else
            term.write(host.text, () => {
              term.scrollToLine(Math.min(keepLine, term.buffer.active.baseY));
              ackDrawn(payload.length);
            });
        } else {
          ackDrawn(payload.length);
        }
        if (kind === "agent" && host.text) {
          lastDrawAtRef.current = Date.now();
          scanTrustPromptSoon();
          scanMenuSoon();
          scanLiveReplySoon();
          scanConnIssueSoon();
          scanSuggestionSoon();
          if (ptyQuietRef.current) {
            ptyQuietRef.current = false;
            setPtyQuiet(false);
          }
          if (stalledRef.current) {
            stalledRef.current = false;
            setStalled(false);
          }
          // 帧会把一句话切开：拼上上一帧尾巴再认，只留最后 160 字当下一帧的前缀（不从转义序列中间开始）
          const scan = effortTailRef.current + host.text;
          effortTailRef.current = outputTail(scan, 160);
          // 认档形态按 CLI 分（各家把档写在不同位置、不同句式）
          const seen = detectEffortInOutput(scan, launchAgentRef.current);
          if (seen) setEffortSeen((prev) => (prev === seen ? prev : seen));
          const seenModel = detectModelInOutput(scan, launchAgentRef.current);
          if (seenModel) setModelSeen((prev) => (prev === seenModel ? prev : seenModel));
          scanFooterModelSoon();
        }
        // PTY 出字即活动：静默计时器量的是真实输出，与「这帧算不算 working」分开——
        // 切聊天/点输入框引发的焦点重绘有 300ms 抑制窗，窗内的 TUI 重绘若不计入活动，
        // 突发渲染间隙 ≥2s 就会在切换瞬间误熄灭 attention，且 armed 已耗尽、
        // 后续输出再也点不亮（working 只能靠重新提交），表现为「终端还在出字、
        // 聊天层却不显示运行中」。出字时间与 hadOutput 在 marks 判定之外先记。
        if (kind === "agent") {
          lastOutputAtRef.current = Date.now();
          hadPtyWorkingOutputRef.current = true;
          setAttention((prev) => {
            // 旁路说这一轮已经结束：TUI 收尾的重绘不再点亮转圈
            if (channelRef.current?.turn && !channelTurnOpen(channelRef.current)) return prev;
            if (
              !ptyOutputMarksWorking({
                prev,
                armed: ptyWorkingArmedRef.current,
                msSinceInteraction: Date.now() - lastInteractionAtRef.current,
              })
            ) {
              return prev;
            }
            return "working";
          });
        }
      }),
      await listen<number>(`pty-exit-${ptyId}`, (e) => {
        void onPtyExit(ptyId, e.payload);
      }),
      // 后台标签的带外信号（Rust route_output 在不可见时对含 OSC 9/777/BEL 的帧照发）：
      // 只喂通知/进度解析，不写画面——正文仍在 backlog 里等切回补发；补发时的重复
      // 通知由限频消化、进度幂等。没有这条，通知与进度徽章的主场景（后台标签）失效。
      await listen<string>(`pty-signal-${ptyId}`, (e) => {
        const host = consumeHostSequences(signalPendingRef.current, e.payload);
        signalPendingRef.current = host.pending;
        for (const title of host.titles) notifyTerminal(title);
        if (host.progress) onProgressRef.current?.(tabId, host.progress);
        // 裸 BEL：claude-code 等只发 BEL 的 CLI 在后台的唯一通知通道。完整的
        // OSC 序列连同其 BEL 终结符已被上面消费，text 里残留的 \x07 只会是裸响铃
        //（2026-10-11 三轮审查实证：缺这段时后台 BEL 整条链路断裂）。
        if (ptyKindRef.current === "agent" && host.text.includes("\x07")) {
          notifyTerminal("终端响铃，可能需要你确认");
        }
      }),
    ];
    // 两个 await listen 期间卸载：退掉刚注册的监听并杀掉 PTY，避免向已 dispose 的 term 写入
    if (!mountedRef.current) {
      unlistenRef.current.forEach((u) => u());
      unlistenRef.current = [];
      if (ptyIdRef.current === ptyId) {
        ptyIdRef.current = null;
        ptyKindRef.current = null;
      }
      invoke("pty_kill", { ptyId }).catch(() => {});
      return;
    }
    // 监听都挂好了再接通道：接上之前的输出在后端 backlog 里，可见就当场补发，不会丢开屏
    await invoke("pty_subscribe", { ptyId, channel: output }).catch(() => {});
    // Windows/ConPTY 吞掉 Agent 的 OSC 10/11 底色查询（两个方向都不通，见
    // docs/conventions/terminal.md），xterm 的内置回报永远送不到子进程。
    // 改为不等查询、attach 后主动推一次：浅色主题下把当前前景/底色告诉 Agent，
    // 让 gemini/qwen 的启动探测选到浅色配色。ConPTY 会缓冲，早于子进程读 stdin 也不丢。
    if (
      shouldReportTerminalColors({
        isWindows: IS_WINDOWS,
        kind,
        agentId: agentIdRef.current,
        themeId: settingsRef.current?.theme,
        enabled: settingsRef.current?.terminalColorReport ?? true,
      })
    ) {
      const themeColors = buildXtermTheme(
        settingsRef.current?.theme ?? "midnight-light",
        settingsRef.current?.terminalPalette,
        settingsRef.current?.customTheme,
      );
      const reports = [
        xtermOscColorReport(10, themeColors.foreground),
        xtermOscColorReport(11, themeColors.background),
      ].filter((r): r is string => r !== null);
      if (reports.length > 0) {
        invoke("pty_report_terminal_colors", { ptyId, reports }).catch(() => {});
      }
    }
    try {
      fitRef.current?.fit();
    } catch {}
    const fitted = fittedPtySize(fitRef.current, term);
    if (fitted) {
      await invoke("pty_resize", {
        ptyId,
        cols: fitted.cols,
        rows: fitted.rows,
      }).catch(() => {});
    }
    // 退出回落等被动 attach 不抢焦点（分屏下用户在另一个 pane 打字）
    if (opts?.focus !== false) term.focus();
  }

  async function onPtyExit(exitedId: string, code: number) {
    // 已被 launch/cleanup 切换到新 PTY，忽略这个过期的退出事件
    if (ptyIdRef.current !== exitedId) return;
    const kind = ptyKindRef.current;
    ptyIdRef.current = null;
    ptyKindRef.current = null;
    setActivePtyId(null);
    setRunning(false);
    setExitCode(code);
    // 「已接回正在跑的进程」只描述接回那一刻的存活态，进程退出后即过期
    setNotice(null);
    // TUI 崩溃没弹栈时 armed 残留会把回落 shell 的 Ctrl+C 变 CSI-u 垃圾——进程退出即解除；
    // 半截序列的攒帧状态一并清空，不留到下一个进程；进度徽章一并清
    kkpArmedRef.current = false;
    queryPendingRef.current = "";
    hostPendingRef.current = "";
    kittyAccumRef.current = "";
    signalPendingRef.current = "";
    onProgressRef.current?.(tabId, null);
    ptyWorkingArmedRef.current = false;
    hadPtyWorkingOutputRef.current = false;
    setAttention(null); // agent 退出：清除注意力标记
    clearTrustPrompt();
    menuPromptRef.current = null;
    setMenuPrompt(null);
    setPanelOpen(false);
    setTuiNoticeLines(null);
    setWaitScreenState(null);
    setSpecialScreenState(null);
    // 一启动就退出：xterm 解析是异步的，排在退出横幅前面读屏，读到的是进程最后画的样子
    if (kind === "agent" && code > 0 && Date.now() - ptyAttachedAtRef.current < 30_000) {
      termRef.current?.write("", () => setLaunchFailure({ code, lines: exitTail(screenLines()) }));
    }
    // 换权限重开 / 退出：下一次接上的运行重新取基线，旧运行的切换不再上报
    permBaselineRef.current = null;
    setObservedTier(null);
    liveReplyRef.current = null;
    setLiveReply(null);
    liveTokensRef.current = null;
    setLiveTokens(null);
    liveThinkingRef.current = null;
    setLiveThinking(null);
    setSuggestion(null);
    if (kind === "agent") {
      // 记录可恢复的会话 id（一键恢复按钮用）
      lastResumeRef.current = linkCtxRef.current?.sessionId ?? null;
      // agent 退出（含手动停止）→ 同一终端自动回落到登录 shell。
      // 异常横幅只认 code > 0：负数（-1 等）是 pty_kill/丢弃/等待超时的「原因未知」
      // 哨兵（exit-code.ts），手动「停止」正是走它——code≠0 会把每次停止都误报成崩溃
      //（2026-10-11 复核实证）。死因横幅随回放持久（借鉴 VS Code）。
      const clause = exitCodeClause(code);
      if (code > 0) {
        // 屏上认得出原因就在横幅下面补一句白话（比如 Codex 官方账号连不上 OpenAI）
        const hint = launchFailureHint(exitTail(screenLines()), code);
        termRef.current?.write(
          `\r\n\x1b[91m── agent 异常退出（代码 ${code}）${clause ? `：${clause}` : ""} ──\x1b[0m\r\n` +
            `\x1b[90m退出画面已存进回放；从启动栏重新启动可接回上一次会话\x1b[0m\r\n` +
            (hint ? `\x1b[93m提示：${hint}\x1b[0m\r\n` : ""),
        );
      }
      const fallbackBanner = `\r\n\x1b[90m── agent 已结束（会话已保存，可一键恢复）── 当前为 shell ──${
        clause ? ` ${clause} ──` : ""
      }\x1b[0m\r\n`;
      // 快照放在末段横幅的 write 回调里：xterm.write 是异步解析，同步快照读不到刚写的字节
      const t = termRef.current;
      if (t) t.write(fallbackBanner, () => saveTerminalReplayNow());
      else saveTerminalReplayNow();
      try {
        // 用 cwdRef 取最新目录：运行期间 pty_get_cwd 轮询更新的 cwd 不进本闭包
        const size = fittedPtySize(fitRef.current, termRef.current);
        if (!allowSpawn(size)) {
          setError("这次没能按画面大小启动");
          setExited(true);
          return;
        }
        resizeLatchRef.current = {
          kind: "measured",
          cols: size.cols,
          rows: size.rows,
        };
        const id = await invoke<string>("shell_spawn", {
          cwd: cwdRef.current,
          extraEnv: initialExtraEnv ?? null,
          cols: size.cols,
          rows: size.rows,
        });
        // 等待 shell_spawn 期间用户可能已重新启动：已有新 PTY 时杀掉这个回落 shell，不抢监听
        if (ptyIdRef.current !== null) {
          invoke("pty_kill", { ptyId: id }).catch(() => {});
          return;
        }
        // 被动回落不抢焦点（分屏下用户可能在另一个 pane 打字）
        await attach(id, "shell", { focus: false });
        // attach 途中组件卸载：PTY 已被 attach 入口守卫杀掉，不再 setState
        if (!mountedRef.current) return;
        setShellActive(true);
      } catch (e) {
        setError(String(e));
        setExited(true);
      }
      void finalizeLink();
    } else {
      setShellActive(false);
      setExited(true);
      saveTerminalReplayNow();
    }
  }

  /** 彻底清理当前 PTY（用于重新启动前/手动开 shell 前）；先置空引用以抑制自动回落 */
  async function cleanupPty() {
    const id = ptyIdRef.current;
    ptyIdRef.current = null;
    ptyKindRef.current = null;
    // 重启/换会话时旧进度徽章不得残留到新进程第一个进度到来
    onProgressRef.current?.(tabId, null);
    if (id) await invoke("pty_kill", { ptyId: id }).catch(() => {});
    unlistenRef.current.forEach((u) => u());
    unlistenRef.current = [];
    resetLink();
  }

  function stopLinkTimer() {
    if (linkTimerRef.current) {
      clearInterval(linkTimerRef.current);
      linkTimerRef.current = null;
    }
  }

  /** 收尾判定因 PTY 仍出字被推迟时，PTY_LIVE_MS 窗口结束后强制重判一次——
   *  不能等下一次文件变化（可能永远不来）驱动的刷新 */
  function scheduleSettleRetry() {
    if (settleRetryTimerRef.current != null) return;
    settleRetryTimerRef.current = window.setTimeout(
      () => {
        settleRetryTimerRef.current = null;
        void fetchConversation(true);
      },
      PTY_LIVE_MS + 1000,
    );
  }

  function stopSessionWatcher() {
    sessionWatchUnlistenRef.current?.();
    sessionWatchUnlistenRef.current = null;
    const id = sessionWatchIdRef.current;
    sessionWatchIdRef.current = null;
    if (id) invoke("unwatch_session", { watchId: id }).catch(() => {});
  }

  /** 找当前 Agent 进程对应的会话文件：有 hint 精确匹配，否则走后端排他声明。 */
  async function findSessionFile(): Promise<{
    filePath: string;
    sessionId: string;
    title: string | null;
    createdAt: string | null;
  } | null> {
    const ctx = linkCtxRef.current;
    if (!ctx) return null;
    try {
      if (ctx.hint) {
        // 按 id 找：扫描缓存里还没有这条新会话时后端会重扫一次，不用等满 10 秒缓存
        const hit = await invoke<SessionMetaDto | null>("find_session", {
          agent: ctx.agentId,
          sessionId: ctx.hint,
        });
        return hit
          ? {
              filePath: hit.filePath,
              sessionId: ctx.hint,
              title: hit.customTitle || hit.title,
              createdAt: hit.createdAt ?? null,
            }
          : null;
      }
      const meta = await invoke<SessionMetaDto | null>("claim_session_for", {
        claimId: tabId,
      });
      return meta
        ? {
            filePath: meta.filePath,
            sessionId: meta.sessionId,
            title: meta.customTitle || meta.title,
            createdAt: meta.createdAt ?? null,
          }
        : null;
    } catch {
      return null;
    }
  }

  const convSigRef = useRef("");

  async function fetchConversation(force = false) {
    const ctx = linkCtxRef.current;
    if (!ctx?.filePath) return;
    let nextSig: string | null = null;
    let turnSettled = false;
    // 签名门控仍作兜底，但 watcher 事件会强制刷新。每次都记录新签名，避免事件后
    // 的下一轮轮询再次无条件解析；requestId 防止旧的异步读取覆盖新结果。
    const sig = await invoke<[number, number] | null>("session_file_sig", {
      filePath: ctx.filePath,
    }).catch(() => null);
    if (linkCtxRef.current !== ctx) return;
    // hooks 家的旁路回合还开着：照「等回复」一样每轮都读到尾部检查——拒绝工具 / Esc 打断时 Claude 不发 Stop，
    // 只能靠读会话文件收掉（chat_channel_settle_from_transcript），文件不再变也要接着查
    const hooksTurnOpen = channelRef.current?.kind === "hooks" && channelTurnOpen(channelRef.current);
    if (sig) {
      nextSig = `${sig[0]}:${sig[1]}`;
      if (!force && !pendingReplyRef.current && !hooksTurnOpen && nextSig === convSigRef.current) return;
    }
    // 过了签名门才占序号：被门挡掉的轮询不能把正在等后端的那次读取作废——原先先占号，那次读取回来见号变了就退出，
    // 而签名已经记下、之后的轮询都被门挡掉，收尾检查再也没人做，聊天层一直「还在回复」（2026-10-25 用户：提问被拒后终端已结束）
    const requestId = ++conversationRequestRef.current;
    try {
      const page = await invoke<ConversationPageDto>(
        "get_session_conversation_page",
        {
          agent: ctx.agentId,
          filePath: ctx.filePath,
          before: null,
          around: null,
        },
      );
      if (linkCtxRef.current !== ctx || requestId !== conversationRequestRef.current)
        return;
      const parsedMessages = page.messages;
      // 本地已发送但会话文件还没记下的用户消息（排队中的也算：连续发送多条时
      // 各 CLI 的 TUI 会缓冲输入逐条处理，文件落盘有先后）
      const pendingUsers = pendingReplyRef.current
        ? pendingUsersRef.current
        : [];
      // 包含 + 宽松比对（残留草稿、CLI 吞掉 emoji），只认发送之后落盘的记录（再发一遍说过的话不算已落盘，见 sentUserRecorded）
      const isRecorded = (pu: ChatMessageDto) =>
        slashCommandRecorded(pu, parsedMessages) || sentUserRecorded(pu, parsedMessages);
      // 只画在终端里的斜杠命令（Codex /status…）：本机处理完就留成「命令 + 结果」记录，不再挡着等回复
      if (localRecordsRef.current.file !== ctx.filePath) {
        localRecordsRef.current = { file: ctx.filePath, records: [] };
      }
      const now = Date.now();
      // 认得出结果行的（Kimi「Permission mode: …」等）：当场收尾，不必等终端静下来
      const byResult = new Map<ChatMessageDto, string[]>();
      for (const pu of pendingUsers) {
        if (isRecorded(pu) || !/^[/!]\S/.test((pu.blocks[0]?.text ?? "").trim())) continue;
        const result = slashResultNow(pu);
        if (result.length) byResult.set(pu, result);
      }
      for (const [pu, result] of byResult) {
        localRecordsRef.current.records.push(localCommandOutput(pu, result));
        if (slashMenuOwnerRef.current?.sent === pu) slashMenuOwnerRef.current = null;
      }
      const settledLocal = pendingUsers.filter(
        (pu) =>
          !isRecorded(pu) &&
          !byResult.has(pu) &&
          slashSettledLocally({
            agentId: ctx.agentId,
            sent: pu,
            now,
            lastOutputAt: lastOutputAtRef.current,
            panelOpen: tuiPanelRef.current,
          }),
      );
      for (const pu of settledLocal) {
        localRecordsRef.current.records.push(localCommandRecord(pu, liveReplyRef.current));
      }
      const missing = pendingUsers.filter(
        (pu) => !isRecorded(pu) && !settledLocal.includes(pu) && !byResult.has(pu),
      );
      pendingUsersRef.current = missing;
      const mergedMessages = placePendingUsers(
        mergeLocalRecords(parsedMessages, localRecordsRef.current.records),
        missing,
        pendingAssistantKeysRef.current,
      );
      // 已经接上更早的记录时，最新一页往后挪滑出去的那几条并进「更早」，不然对话一长中间那段会消失
      if (olderRef.current.length > 0) {
        olderRef.current = mergeConversationPages(
          olderRef.current,
          slidOutOfWindow(prevParsedRef.current, parsedMessages),
        );
      }
      prevParsedRef.current = parsedMessages;
      latestWindowRef.current = mergedMessages;
      if (olderRef.current.length === 0) {
        convCursorRef.current = page.cursor;
        setConvCursor(page.cursor);
        if (page.cursor != null) {
          void loadRestOfConversation(
            { agentId: ctx.agentId, filePath: ctx.filePath },
            page.cursor,
            () => linkCtxRef.current === ctx,
          );
        }
      }
      setConv(mergeConversationPages(olderRef.current, mergedMessages));
      const hasNewAssistantText = parsedMessages.some(
        (message) =>
          message.role !== "user" &&
          hasAssistantText([message]) &&
          !pendingAssistantKeysRef.current.has(messageKey(message)),
      );
      if (
        pendingReplyRef.current &&
        hasNewAssistantText &&
        missing.length === 0 &&
        conversationTurnSettled(parsedMessages)
      ) {
        setPendingReply(false);
      }
      // 等回复期间不把上一轮助手正文当成「这一轮已生成完」
      turnSettled =
        !pendingReplyRef.current && conversationTurnSettled(parsedMessages);
      if (nextSig) convSigRef.current = nextSig;
      setLinkState("linked");
      if (
        !autoTitleEarlyRef.current &&
        mergedMessages.some(
          (m) => m.role === "user" && m.blocks.some((b) => b.kind === "text" && b.text.trim()),
        )
      ) {
        autoTitleEarlyRef.current = true;
        scheduleAutoTitle("early");
      }
      // 中途校正按用户说了几句来：第一条回复出来时材料跟临时标题一样，不再多问一次
      const milestone = autoTitleMilestone(
        mergedMessages.filter(
          (m) => m.role === "user" && m.blocks.some((b) => b.kind === "text" && b.text.trim()),
        ).length,
      );
      if (milestone > autoTitleMilestoneRef.current) {
        autoTitleMilestoneRef.current = milestone;
        scheduleAutoTitle("final");
      }
    } catch {
      // 会话文件可能写到一半，下轮再试
    }
    // 权限模式跟随：这个会话文件第一次读到的模式是基线，之后变了才上报（终端里切过）。
    // 2026-10-19 用户：审批时点了「切换」，终端已是 auto，聊天层徽标还是「请求批准」
    if (READS_SESSION_TIER.has(ctx.agentId)) {
      const got = await invoke<{ mode: string; atMs: number | null } | null>("session_permission_mode", {
        agent: ctx.agentId,
        filePath: ctx.filePath,
      }).catch(() => null);
      if (linkCtxRef.current !== ctx) return;
      const mode = got?.mode ?? null;
      const report = (m: string) =>
        setCliModeSwitch((prev) => ({ agent: ctx.agentId, mode: m, seq: (prev?.seq ?? 0) + 1 }));
      const base = permBaselineRef.current;
      if (ctx.agentId === "claude-code") {
        if (mode && (!base || base.file !== ctx.filePath)) {
          permBaselineRef.current = { file: ctx.filePath, mode };
        } else if (mode && base && mode !== base.mode) {
          permBaselineRef.current = { file: ctx.filePath, mode };
          report(mode);
        }
      } else if (got && mode) {
        // Kimi / Codex 以最后一条为准（2026-11-11 实测）。上一次运行留下的那条不算——带参数启动时这次会再写一条新的；
        // 只有 Kimi 不带参数（按本机设置）接回旧会话时沿用会话里存的档、不再写，那条就是实际档（用「请求批准」接回一段
        // 切过 Never Ask 的对话，实际仍是 Never Ask）
        const flagged =
          ctx.agentId !== "kimi" || permissionRef.current === "discuss" || permissionModeRef.current !== null;
        const stale = flagged && got.atMs != null && got.atMs < linkStartedAtRef.current - 3000;
        const tier = stale ? null : sessionModeTier(ctx.agentId, mode);
        if (!stale) setObservedTier(tier);
        if (tier && (!base || base.file !== ctx.filePath || base.mode !== mode)) {
          permBaselineRef.current = { file: ctx.filePath, mode };
          // 标签记下的选择只跟到这家能用启动参数指定的档（Kimi 没有「请求批准」的参数：manual 只显示、不改选择）
          if ((launchAgentDetRef.current?.permissionModes ?? []).includes(tier)) report(mode);
        }
      }
    }
    // P3c：同一路径顺带轮询会话尾部状态（done/working/confirm/unknown）
    try {
      const state = await invoke<string>("session_tail_state", {
        agent: ctx.agentId,
        filePath: ctx.filePath,
      });
      if (linkCtxRef.current !== ctx || requestId !== conversationRequestRef.current)
        return;
      // 收尾判定被 ptyLive 推迟（PTY 8 秒窗内还出过字）时必须保证一次重试：
      // 之后会话文件若再无新写入，签名门会让 5s 轮询永远不再重跑 fetch，
      // 「已收尾但被推迟」就冻结成永久转圈（2026-09-19 综述大纲跑完实测）
      const fileSaysOver = state === "done" || state === "settled" || turnSettled;
      // hooks 家的回合被打断（审批菜单里拒绝 / Esc）时 Claude 不发 Stop，旁路一直「在回复」：会话文件说收尾了就让后端核对后收掉
      const openChannel = channelRef.current;
      if (fileSaysOver && openChannel?.kind === "hooks" && channelTurnOpen(openChannel)) {
        void invoke<boolean>("chat_channel_settle_from_transcript", { tabId }).catch(() => false);
      }
      const ptyLive = Date.now() - lastOutputAtRef.current < PTY_LIVE_MS;
      // 回合确定结束、且刚发的用户消息都已落盘（不是上一轮残留的收尾标记）：
      // 等回复就此结束，不再靠逐条比对正文（正文比对有漏判就会一直挂着「等待回复」）
      let pendingNow = pendingReplyRef.current;
      if (fileSaysOver && pendingNow) flushSlashAtTurnEnd();
      if (state === "settled" && pendingNow && pendingUsersRef.current.length === 0) {
        pendingNow = false;
        setPendingReply(false);
      }
      setAttention((prev) => {
        // 旁路在报回合状态：以它为准，会话尾部 / PTY 出字的推断不再改
        const fromChannel = channelAttention(channelRef.current);
        if (fromChannel) return fromChannel;
        const next = applyTailAttention({
          prev,
          tail: state,
          armed: ptyWorkingArmedRef.current,
          turnSettled,
          ptyLive,
          pendingReply: pendingNow,
        });
        ptyWorkingArmedRef.current = next.armed;
        if (fileSaysOver && ptyLive && next.attention === "working") {
          scheduleSettleRetry();
        }
        return next.attention;
      });
      // confirm 时顺带取「在等什么」（hooks payload 的 message/tool_name；取不到为 null）
      if (state === "confirm") {
        const detail = await invoke<string | null>("session_confirm_detail", {
          agent: ctx.agentId,
          filePath: ctx.filePath,
        }).catch(() => null);
        if (linkCtxRef.current !== ctx || requestId !== conversationRequestRef.current)
          return;
        setConfirmDetail(detail);
      } else {
        setConfirmDetail(null);
      }
    } catch {
      if (linkCtxRef.current === ctx && requestId === conversationRequestRef.current) {
        setAttention(null);
        setConfirmDetail(null);
      }
    }
  }

  /** 最近一页摆出来之后，在后台把更早的记录一次接齐（2026-10-26 用户对照 Claude 客户端：往上翻要丝滑、滚动条别一下变短）。
   *  接的期间报「正在接更早的」：聊天层不再自己一页页接。已经取回来的当场接上（点开前等过、刚看过）。读不出就留着分页，往上翻照旧一页页接 */
  async function loadRestOfConversation(
    src: { agentId: string; filePath: string },
    cursor: number,
    isCurrent: () => boolean,
  ) {
    const key = `${src.agentId}\n${src.filePath}`;
    if (restForRef.current === key) return;
    restForRef.current = key;
    const apply = (rest: ConversationPageDto) => {
      olderRef.current = mergeConversationPages(rest.messages, olderRef.current);
      convCursorRef.current = null;
      setConvCursor(null);
      setConv(mergeConversationPages(olderRef.current, latestWindowRef.current));
    };
    // 已经取回来的（刚看过、点开前等过）当场接上，和最近一页同一帧画出来
    const ready = cachedConversationRest(src.agentId, src.filePath, cursor);
    if (ready) {
      apply(ready);
      return;
    }
    setLoadingOlder(true);
    try {
      const rest = await conversationRestFor(src.agentId, src.filePath, cursor);
      if (!isCurrent()) return;
      apply(rest);
    } catch {
      if (restForRef.current === key) restForRef.current = null;
    } finally {
      setLoadingOlder(false);
    }
  }

  async function loadOlderConversation(settle?: () => Promise<void>) {
    const ctx = linkCtxRef.current;
    // 只看没接的对话也能往上翻（来源是摆出来的那份会话文件）
    const preview = ctx ? null : previewSrcRef.current;
    const src = ctx?.filePath
      ? { agentId: ctx.agentId, filePath: ctx.filePath }
      : preview;
    const cursor = convCursorRef.current;
    if (!src || cursor == null || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await invoke<ConversationPageDto>(
        "get_session_conversation_page",
        {
          agent: src.agentId,
          filePath: src.filePath,
          before: cursor,
          around: null,
        },
      );
      // 等手停下来再接到上面，滑动途中插入会顿一下
      await settle?.();
      if (ctx ? linkCtxRef.current !== ctx : previewSrcRef.current !== preview) return;
      olderRef.current = mergeConversationPages(page.messages, olderRef.current);
      convCursorRef.current = page.cursor;
      setConvCursor(page.cursor);
      setConv(
        mergeConversationPages(olderRef.current, latestWindowRef.current),
      );
    } catch {
      // 没有更早一窗或文件正在写，下次再试
    } finally {
      setLoadingOlder(false);
    }
  }

  /** 会话文件锁定：登记 liveSessions（会话页「进行中」+ 反向跳转） */
  function lockLink(
    filePath: string,
    sessionId: string,
    title: string | null,
    createdAt?: string | null,
  ) {
    const ctx = linkCtxRef.current;
    if (!ctx || ctx.filePath) return;
    ctx.filePath = filePath;
    ctx.sessionId = sessionId;
    if (localRecordsRef.current.file === "") localRecordsRef.current.file = filePath;
    if (createdAt) ctx.createdAt = createdAt;
    olderRef.current = [];
    latestWindowRef.current = [];
    prevParsedRef.current = [];
    restForRef.current = null;
    // 摆着的那份正是这一份：已接齐的更早记录原样放回（不然接回那一下整段缩回最近一页、再从头接一遍）
    const carry = carryOlderRef.current;
    carryOlderRef.current = null;
    if (carry && samePath(carry.filePath, filePath, IS_WINDOWS) && carry.older.length > 0) {
      olderRef.current = carry.older;
      restForRef.current = `${ctx.agentId}\n${filePath}`;
    }
    convCursorRef.current = null;
    setConvCursor(null);
    setSessionFile(filePath);
    setLinkedSessionId(sessionId);
    setLinkedSessionTitle(title);
    setLinkState("linked");
    setSyncState("polling");
    setLiveSession(ctx.agentId, sessionId, tabId);
    const rid = runIdRef.current ?? initialRunId;
    if (rid) {
      invoke("run_attach_session", { id: rid, sessionId }).catch(() => {});
    }
    // 连同这次启动的模型与思考档一起记：下次从侧栏点开这段对话，输入框默认就是它（session_resume_config）
    const rec = launchRecordRef.current;
    void invoke("set_session_profile_command", {
      agent: ctx.agentId,
      sessionId,
      profileId,
      ...(rec ? { model: rec.model, effort: rec.effort } : {}),
    });
    void startSessionWatcher(filePath, ctx.agentId);
    // 侧栏要马上把这段收进对话列表：不刷的话它一直画成「开着、列表里还没有」的行，只有 ×、没有 ⋯，
    // 要等起好标题那次刷新或每分钟的轮询才换过来（2026-11-01 用户：新对话过一会才有 ⋯）
    void useAppStore.getState().loadSessions(true);
    // 关联成功后降低兜底轮询频率；实时刷新以 watcher 事件为主。
    startLinkPolling(5000);
  }

  async function startSessionWatcher(filePath: string, agent: string) {
    if (sessionWatchStartingRef.current) return;
    sessionWatchStartingRef.current = true;
    stopSessionWatcher();
    try {
      const watchId = await invoke<string>("watch_session", {
        agent,
        filePath,
      });
      const unlisten = await listen(`session-changed-${watchId}`, () => {
        void fetchConversation(true);
      });
      const ctx = linkCtxRef.current;
      if (!ctx || ctx.filePath !== filePath) {
        unlisten();
        void invoke("unwatch_session", { watchId });
        return;
      }
      sessionWatchIdRef.current = watchId;
      sessionWatchUnlistenRef.current = unlisten;
      setSyncState("watching");
      void fetchConversation(true);
    } catch {
      // 文件监听不可用时保留签名轮询兜底，不阻断聊天。
      setSyncState("polling");
    } finally {
      sessionWatchStartingRef.current = false;
    }
  }

  // ===== 聊天层结构化旁路（chat_channel.rs / chat-channel.ts，docs/design-chat-structured-channels.md）=====
  // 后端按各家 CLI 自己吐的结构化事件推快照。旁路说了算的事（会话归属与跟随、回合状态、审批内容、实时文字）
  // 优先于读会话文件 / 读屏的推断；旁路没接上的家（或这次没接上）照旧走原来那套

  /** CLI 换了会话（Claude /clear、恢复别的会话）：改盯新文件，对话流换成「已开始新对话」一行 */
  function relinkTo(filePath: string | null, sessionId: string | null, source: string | null) {
    const ctx = linkCtxRef.current;
    if (!ctx) return;
    stopSessionWatcher();
    if (ctx.sessionId) setLiveSession(ctx.agentId, ctx.sessionId, null);
    // 换对象使上一会话尚未返回的读取失效；新文件没出现时也不能继续展示旧会话。
    linkCtxRef.current = { ...ctx, filePath: null, sessionId: null, hint: sessionId, createdAt: null };
    conversationRequestRef.current++;
    olderRef.current = [];
    latestWindowRef.current = [];
    prevParsedRef.current = [];
    restForRef.current = null;
    carryOlderRef.current = null;
    convCursorRef.current = null;
    setConvCursor(null);
    setSessionFile(null);
    setLinkedSessionId(null);
    setLinkedSessionTitle(null);
    setLinkState("detecting");
    setSyncState("waiting");
    linkStartedAtRef.current = Date.now();
    pendingUsersRef.current = [];
    pendingAssistantKeysRef.current = new Set();
    setPendingReply(false);
    const note: ChatMessageDto = {
      role: "user",
      blocks: [{ kind: "command_output", text: sessionSwitchNote(source), toolName: null }],
      timestamp: new Date().toISOString(),
      usage: null,
    };
    localRecordsRef.current = { file: filePath ?? "", records: [note] };
    convSigRef.current = "";
    setConv([note]);
    if (filePath) lockLink(filePath, sessionId ?? "", null);
    else void linkTick();
  }

  function applyChannel(snap: ChatChannelSnapshot | null) {
    const prev = channelRef.current;
    channelRef.current = snap;
    setChannel(snap);
    // 旁路的审批卡撤了（聊天层答过 / 终端里答过）：终端菜单撤掉前那一下读屏不再认（scanMenuSoon）
    if (prev?.approval && !snap?.approval) channelApprovalGoneAtRef.current = Date.now();
    if (!snap) return;
    if (snap.connection === "disconnected") {
      setAttention(null);
      liveReplyRef.current = null;
      setLiveReply(null);
      scanMenuSoon();
      void fetchConversation(true);
      return;
    }
    const ctx = linkCtxRef.current;
    if (ctx && snap.agent === ctx.agentId) {
      const rel = channelRelink(
        snap,
        { filePath: ctx.filePath, hint: ctx.hint, sessionId: ctx.sessionId, seenSeq: channelSeqSeenRef.current },
        IS_WINDOWS,
      );
      channelSeqSeenRef.current = snap.sessionSeq;
      if (rel.kind === "switch") {
        relinkTo(rel.path, rel.sessionId, snap.sessionSource);
      } else if (rel.kind === "lock") {
        // 新会话的文件在第一条消息之后才落盘：在了就直接锁，不在就先记 id，等文件出现按 id 认
        const path = rel.path;
        const sid = rel.sessionId;
        void invoke<[number, number] | null>("session_file_sig", { filePath: path })
          .then((sig) => {
            const cur = linkCtxRef.current;
            if (cur !== ctx || cur.filePath || channelRef.current?.sessionId !== sid) return;
            if (sig && sid) lockLink(path, sid, null);
            else if (sid) cur.hint = sid;
          })
          .catch(() => {});
      } else if (rel.kind === "hint") {
        if (ctx.filePath) relinkTo(null, rel.sessionId, snap.sessionSource);
        else linkCtxRef.current = { ...ctx, hint: rel.sessionId };
      }
    }
    // 回合状态 → 标签注意力（working / confirm / done）
    const att = channelAttention(snap);
    if (att && (prev?.turn?.status !== snap.turn?.status || prev?.turn?.seq !== snap.turn?.seq)) {
      if (att === "working") ptyWorkingArmedRef.current = true;
      setAttention(att);
    }
    // hooks / 程序状态报来「等批准」：看一眼屏上还在不在等（Windows 上 hooks 在后台跑，报到时可能已经在终端里答完了），
    // 卡片的按钮也从屏上菜单来
    if (channelInfersApproval(snap) && att === "confirm") {
      menuWatchUntilRef.current = Math.max(menuWatchUntilRef.current, Date.now() + 3000);
      scanMenuSoon();
    }
    // 回合结束：马上读一次会话文件；文件稍慢于事件，2.5 秒后再读一次，这一轮开始前发出的话算 CLI 已收下
    // （落盘原文对不上也不再挂着「正在生成回复」、同一句画两遍，见 pendingAfterTurn），都收下了就结束等待
    const turn = snap.turn;
    if (turn?.endedAt && turn.endedAt !== channelEndHandledRef.current) {
      channelEndHandledRef.current = turn.endedAt;
      void fetchConversation(true);
      if (pendingReplyRef.current) {
        const endedCtx = linkCtxRef.current;
        window.setTimeout(() => {
          if (linkCtxRef.current !== endedCtx) return;
          void fetchConversation(true).then(() => {
            if (linkCtxRef.current !== endedCtx || !pendingReplyRef.current) return;
            flushSlashAtTurnEnd();
            pendingUsersRef.current = pendingAfterTurn(pendingUsersRef.current, turn.startedAt);
            if (pendingUsersRef.current.length > 0) return;
            setPendingReply(false);
            // 摘掉画面上残留的本地气泡
            void fetchConversation(true);
          });
        }, 2500);
      }
    }
    // 旁路的提示（压缩上下文）：在对话流里记一行灰字，只在这次打开的聊天里保留
    if (snap.notice && snap.notice.seq !== prev?.notice?.seq && ctx?.filePath && linkCtxRef.current === ctx) {
      if (localRecordsRef.current.file !== ctx.filePath) {
        localRecordsRef.current = { file: ctx.filePath, records: [] };
      }
      localRecordsRef.current.records.push({
        role: "user",
        blocks: [{ kind: "command_output", text: snap.notice.text, toolName: null }],
        timestamp: new Date().toISOString(),
        usage: null,
      });
      void fetchConversation(true);
    }
    // 旁路送来的实时文字（Qwen / OpenCode / Codex）取代读屏预览
    const live = channelLiveLines(snap);
    if (live && channelTurnOpen(snap)) {
      const prevLive = liveReplyRef.current?.join("\n") ?? null;
      if (prevLive !== live.join("\n")) {
        liveReplyRef.current = live;
        setLiveReply(live);
      }
    }
  }
  const applyChannelRef = useRef(applyChannel);
  applyChannelRef.current = applyChannel;
  useEffect(() => {
    let off: (() => void) | null = null;
    let disposed = false;
    void listen<ChatChannelSnapshot | null>(`chat-channel-${tabId}`, (e) => {
      applyChannelRef.current(e.payload ?? null);
    }).then((fn) => {
      if (disposed) fn();
      else off = fn;
    });
    // 热更新 / 重新挂载：先取一次当前快照
    void invoke<ChatChannelSnapshot | null>("chat_channel_snapshot", { tabId })
      .then((s) => {
        if (s && !disposed) applyChannelRef.current(s);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      off?.();
    };
  }, [tabId]);

  // 认领扫描在 Windows 上一次要好几秒，500ms 一轮会叠着发；叠着的那轮回来时旁路早已锁定会话，
  // 拿「没找到」把同步状态改回 waiting，之后再没人改回来——对话照常刷新，底部却一直挂着「等待会话文件」
  // （2026-10-26 Windows Codex 实测）。所以同一时刻只跑一轮，扫描回来先确认还没锁上
  const linkTickBusyRef = useRef(false);
  async function linkTick() {
    if (linkTickBusyRef.current) return;
    linkTickBusyRef.current = true;
    try {
      await linkTickOnce();
    } finally {
      linkTickBusyRef.current = false;
    }
  }

  async function linkTickOnce() {
    const ctx = linkCtxRef.current;
    if (!ctx) return;
    if (!ctx.filePath) {
      const hit = await findSessionFile();
      if (linkCtxRef.current !== ctx || ctx.filePath) return;
      if (!hit) {
        setSyncState("waiting");
        if (Date.now() - linkStartedAtRef.current >= 20_000)
          setLinkState("timeout");
        return;
      }
      lockLink(hit.filePath, hit.sessionId, hit.title, hit.createdAt);
    } else if (!channelRef.current?.sessionId || channelRef.current.connection === "disconnected") {
      // 没有旁路报「换了会话」的家（Gemini / Kimi / Grok 默认）：/clear 后 CLI 另开新文件，按认领规则接着跟
      const next = await invoke<SessionMetaDto | null>("claim_session_successor", { claimId: tabId }).catch(() => null);
      const cur = linkCtxRef.current;
      if (next && cur?.filePath && !samePath(next.filePath, cur.filePath, IS_WINDOWS)) {
        relinkTo(next.filePath, next.sessionId, null);
        return;
      }
    }
    const linkedCtx = linkCtxRef.current;
    if (linkedCtx?.filePath && !sessionWatchIdRef.current) {
      void startSessionWatcher(linkedCtx.filePath, linkedCtx.agentId);
    }
    await fetchConversation();
  }

  function startLinkPolling(intervalMs = 5000) {
    stopLinkTimer();
    linkTimerRef.current = setInterval(() => void linkTick(), intervalMs);
    void linkTick();
  }

  /** agent 退出后停止轮询，最后再抓一次拿到完整对话 */
  async function finalizeLink() {
    stopLinkTimer();
    const ctx = linkCtxRef.current;
    if (!ctx) return;
    if (!ctx.filePath) {
      const hit = await findSessionFile();
      if (hit) lockLink(hit.filePath, hit.sessionId, hit.title, hit.createdAt);
      else if (linkCtxRef.current === ctx && !ctx.filePath) setLinkState("timeout");
    }
    await fetchConversation(true);
    // Agent 退出不代表会话文件已经完成落盘；保留短轮询，让最后一条 assistant
    // 消息有机会在 shell 回落后进入聊天层。fetchConversation 成功解析到回复时
    // 会自行清理 pending 状态。
    if (pendingReplyRef.current) startPendingReplyPolling();
    const sid = linkCtxRef.current?.sessionId;
    const linkedAgent = linkCtxRef.current?.agentId;
    if (sid && linkedAgent) setLiveSession(linkedAgent, sid, null);
    if (!linkCtxRef.current?.filePath) {
      window.setTimeout(() => {
        void (async () => {
          const hit = await findSessionFile();
          if (hit)
            lockLink(hit.filePath, hit.sessionId, hit.title, hit.createdAt);
          scheduleAutoTitle("final");
        })();
      }, 2500);
    } else {
      scheduleAutoTitle("final");
    }
  }

  function scheduleAutoTitle(stage: "early" | "final") {
    // 设置页「会话自动命名」关掉时不发起调用（后端命令另有闸门，这里省掉白跑与重试）
    if (useAppStore.getState().settings?.autoTitleSessions === false) return;
    const ctx = linkCtxRef.current;
    const agent = ctx?.agentId;
    const sessionId = ctx?.sessionId;
    const filePath = ctx?.filePath;
    const createdAt = ctx?.createdAt ?? null;
    if (!agent || !sessionId || !filePath) return;
    const attempt = (n: number) => {
      void invoke<string | null>("ai_auto_title_session", {
        agent,
        sessionId,
        filePath,
        createdAt,
        stage,
      })
        .then((title) => {
          // null = 不该起或不用起（手改过、材料没变……），重试也一样；只有出错才重试
          if (!title) return;
          const cur = linkCtxRef.current;
          if (cur?.sessionId === sessionId) setLinkedSessionTitle(title);
          void useAppStore.getState().loadSessions(true);
        })
        .catch(() => {
          if (n < 2) window.setTimeout(() => attempt(n + 1), 8000);
        });
    };
    window.setTimeout(() => attempt(0), 2500);
  }

  function resetLink() {
    stopLinkTimer();
    stopSessionWatcher();
    const sid = linkCtxRef.current?.sessionId;
    const linkedAgent = linkCtxRef.current?.agentId;
    if (sid && linkedAgent) setLiveSession(linkedAgent, sid, null);
    invoke("release_session_claim", { claimId: tabId }).catch(() => {});
    autoTitleEarlyRef.current = false;
    autoTitleMilestoneRef.current = 0;
    linkCtxRef.current = null;
    convSigRef.current = "";
    carryOlderRef.current =
      keepPreviewConvRef.current && previewSrcRef.current && olderRef.current.length > 0
        ? { filePath: previewSrcRef.current.filePath, older: olderRef.current }
        : null;
    olderRef.current = [];
    latestWindowRef.current = [];
    prevParsedRef.current = [];
    restForRef.current = null;
    convCursorRef.current = null;
    setConvCursor(null);
    setLoadingOlder(false);
    setSessionFile(null);
    setLinkedSessionId(null);
    setLinkedSessionTitle(null);
    setLinkState("idle");
    setSyncState("waiting");
    // 摆着的记录正转接回：先留在画面上，接上后会话文件刷新会整份替换
    if (!keepPreviewConvRef.current) setConv([]);
    previewSrcRef.current = null;
    // 先启动再发的那一句：「等回复」留着，launch 回来重新登记气泡。原先这里一收，生成中那一行
    // 先出、消失（启动那几百毫秒）、再出——新对话发第一句闪一下（2026-10-26 用户）
    if (!earlyLaunchRef.current) setPendingReply(false);
    // 那一句也留在待确认里：resetLink 到 launch 回来之间，接回的会话文件可能已经锁定并刷新一次，待确认清空了气泡就被冲掉，
    // 等 reRegister 再冒出来——发出去先消失一下才显示（2026-10-28 用户：「终端没起来时发送消息会被吞一下」）
    if (!earlyLaunchRef.current) {
      pendingUsersRef.current = [];
      pendingAssistantKeysRef.current = new Set();
    }
    ptyWorkingArmedRef.current = false;
    hadPtyWorkingOutputRef.current = false;
    setAttention(null);
    setConfirmDetail(null);
    clearTrustPrompt();
    menuPromptRef.current = null;
    setMenuPrompt(null);
    setPanelOpen(false);
    setTuiNoticeLines(null);
    // 换权限重开 / 退出：下一次接上的运行重新取基线，旧运行的切换不再上报
    permBaselineRef.current = null;
    setObservedTier(null);
    liveReplyRef.current = null;
    setLiveReply(null);
    liveTokensRef.current = null;
    setLiveTokens(null);
    liveThinkingRef.current = null;
    setLiveThinking(null);
    setSuggestion(null);
  }

  /** 布局提交之后再读格子。高度没变时当前帧就能量到；变了就等下一次尺寸。 */
  function waitForTerminalGrid(): Promise<{ cols: number; rows: number } | null> {
    const now = fittedPtySize(fitRef.current, termRef.current);
    const host = containerRef.current;
    if (!host) return Promise.resolve(now);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (size: { cols: number; rows: number } | null) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        window.clearTimeout(timer);
        resolve(size);
      };
      const observer = new ResizeObserver(() => {
        finish(fittedPtySize(fitRef.current, termRef.current));
      });
      observer.observe(host);
      const timer = window.setTimeout(() => finish(now), 200);
      if (now) finish(now);
    });
  }

  async function launch(
    resumeId?: string,
    /** typeDroppedPrompt：CLI 没有启动注入参数（Kimi）时由调用方等 TUI 就绪后把指令打进输入框，
        这里按「已发出」收起启动栏、不复制不报错 */
    /** freshRun：不沿用标签上的旧 Run，另开一条（换权限重开：旧 Run 刚被停下、权限也变了，沿用会被身份校验拒掉） */
    /** relay：聊天里换一家接着做——Agent 已换成接手那家，resume = 接回它原来那段（null = 新开），不沿用标签上旧那家的会话 */
    options?: {
      prompt?: string;
      readonly?: boolean;
      typeDroppedPrompt?: boolean;
      freshRun?: boolean;
      relay?: { resume: string | null; provider: string | null };
    },
  ): Promise<{ ptyId: string; promptDropped: boolean } | null> {
    setError(null);
    setNotice(null);
    launchCancelRef.current = null;
    if (customRuntimeId) {
      if (restored) {
        setError("自定义 Runtime 不支持恢复；点击“运行”会创建新的 Run");
      }
      try {
        const launchCwd = await resolveLaunchCwdForCustom(customRuntimeId, cwd);
        if (!(await checkWorkingDirectory(launchCwd))) {
          setBarExpanded(true);
          return null;
        }
        const probeRun = (runId ?? initialRunId ?? "").trim();
        if (
          probeRun &&
          (await invoke<string | null>("pty_id_for_run", { runId: probeRun }))
        ) {
          setNotice("已接回正在跑的进程，画面大小先不动");
          return null;
        }
        await cleanupPty();
        if (launchCwd !== cwd) setCwd(launchCwd);
        const fresh = await invoke<{ id: string }>("run_open_custom", {
          cwd: launchCwd,
          reuseKey: reuseKey ?? `custom:${customRuntimeId}:${launchCwd}`,
          runId: null,
          customRuntimeId,
        });
        const size = fittedPtySize(fitRef.current, termRef.current);
        if (!allowSpawn(size)) {
          setError("这次没能按画面大小启动");
          return null;
        }
        resizeLatchRef.current = {
          kind: "measured",
          cols: size.cols,
          rows: size.rows,
        };
        const res = await invoke<{ ptyId: string; runId: string | null }>(
          "pty_spawn_custom",
          {
            runtimeId: customRuntimeId,
            cwd: launchCwd,
            runId: fresh.id,
            cols: size.cols,
            rows: size.rows,
          },
        );
        runIdRef.current = res.runId ?? fresh.id;
        setRunId(res.runId ?? fresh.id);
        await attach(res.ptyId, "agent", { reset: true });
        setExited(false);
        setExitCode(null);
        setShellActive(false);
        setBarExpanded(false);
        return { ptyId: res.ptyId, promptDropped: false };
      } catch (e) {
        setError(String(e));
        return null;
      }
    }
    if (
      selectedProfile?.accountType === "official" &&
      officialSt &&
      !officialSt.connected
    ) {
      const ok = await confirmDialog(
        "官方账号还没登录，仍要启动？\n\n启动后会报未登录（401）。可以先去连接页登录，或换一条连接。",
        { confirmText: "仍要启动" },
      );
      if (!ok) {
        setBarExpanded(true);
        return null;
      }
    }
    // 线路体检（design-outbound-route.md）：官方账号启动前取 5 分钟内的结果，没有就当场测（最多约 6 秒）。
    // 拦下 = 问一句；待你判断 = 启动后提一句；没有探测点的那几家后端报错，这里当没测
    let routeBlocked = false;
    let routeNote: string | null = null;
    if (selectedProfile?.accountType === "official") {
      let check = await invoke<RouteCheck>("route_check", {
        agentId,
        profileId,
        maxAgeSecs: PREFLIGHT_MAX_AGE_SECS,
      }).catch(() => null);
      // 修复后启动（二期）：代理没在运行、而本机有在跑的代理或装了代理软件时，先问要不要修好再启动
      if (check?.verdict === "block") {
        const fix = await findRouteFix(check).catch(() => null);
        if (
          fix &&
          (await confirmDialog(preflightFixMessage(check, agentLabel(agentId), fix), {
            confirmText: `${routeFixLabel(fix)}再启动`,
          }))
        ) {
          check = (await applyRouteFix(fix, agentId, profileId).catch(() => null)) ?? check;
        }
      }
      if (check) setRouteAlertFromCheck(check);
      if (check?.verdict === "block") {
        routeBlocked = true;
        const ok = await confirmDialog(preflightBlockMessage(check, agentLabel(agentId)), {
          confirmText: "仍要启动",
        });
        if (!ok) {
          launchCancelRef.current = "没有启动：线路体检没通过，到 设置 → 网络 看原因";
          setBarExpanded(true);
          return null;
        }
      } else if (check) {
        routeNote = preflightReviewNote(check, agentLabel(agentId));
      }
    }
    if (!(await checkWorkingDirectory(cwd))) {
      setBarExpanded(true);
      return null;
    }
    if (
      codexSandboxCoversHome({
        agentId,
        cwd,
        home: homeDir,
        permissionMode:
          (permission ?? (options?.readonly ?? readonly ? "discuss" : "write_tree")) === "discuss"
            ? null
            : permissionMode,
        isWindows: IS_WINDOWS,
      })
    ) {
      const ok = await confirmDialog(
        "Codex 要在主目录里运行\n\n在 Windows 上它会改整个用户文件夹的访问权限，第一次会很慢。建议取消，换成「随手聊」或某个项目文件夹。",
        { confirmText: "仍在主目录运行" },
      );
      if (!ok) {
        launchCancelRef.current = "没有启动：Codex 不建议在主目录运行，请在输入框下方的目录芯片里换一个文件夹再发";
        setBarExpanded(true);
        return null;
      }
    }
    if (!visible || !(await ensureTerminal())) {
      setError("这次没能按画面大小启动");
      return null;
    }
    const launchPrompt = (options?.prompt ?? promptText).trim();
    // 手上的 Run 和这次启动对不上（停下后换了目录 / Agent / 权限）：另开 Run，不带旧 id 去撞 open_at 的身份校验。
    // 换了目录或 Agent 时原会话也接不回（别家 CLI / 别的目录），开新会话；离开原目录时目标归属一并放下
    const launchPermission = permission ?? (options?.readonly ?? readonly ? "discuss" : "write_tree");
    const launchIdentity: RunIdentity = { agentId, cwd, permission: launchPermission };
    const identityChange = (runId ?? initialRunId ?? "").trim()
      ? compareRunIdentity(boundIdentityRef.current, launchIdentity, homeDir, IS_WINDOWS)
      : "same";
    const freshRun = Boolean(options?.freshRun) || identityChange !== "same";
    const sessionMoved = identityChange === "agent" || identityChange === "cwd";
    const leftTaskDir = identityChange === "cwd";
    const relayLaunch = options?.relay;
    const resumeFrom = relayLaunch
      ? (relayLaunch.resume ?? undefined)
      : sessionMoved
        ? undefined
        : (resumeId ?? resumeSessionId);
    // 原生分叉只在第一次启动用（launch 成功即从标签清掉）；换了目录 / Agent 分不了原会话
    const forkFrom = relayLaunch || resumeFrom || sessionMoved ? undefined : forkSessionId;
    const isResume = Boolean(resumeFrom);
    const chrome = launchChromeBeforeMeasure({
      resume: isResume,
      prompt: launchPrompt,
      promptInject: agentId === "kimi" ? "unsupported" : "positional",
    });
    const chromeSnapshot = {
      bar: barExpandedRef.current,
      advanced: advancedLaunchOpenRef.current,
    };
    const probeRun = freshRun ? "" : (runId ?? initialRunId ?? "").trim();
    let existingPty: string | null = null;
    if (probeRun) {
      existingPty = await invoke<string | null>("pty_id_for_run", {
        runId: probeRun,
      });
    }
    if (existingPty) {
      resizeLatchRef.current = { kind: "frozen" };
      // 接回活进程也要先立关联上下文：标签重新挂载后 linkCtxRef 是空的，linkTick 见空直接返回，
      // 聊天层永远停在「正在连接当前会话…」、20 秒超时也不触发（2026-10-23 用户点随手聊会话实测）。
      // 会话 id 依次取：这次要接的会话 > 这个 Run 已登记的会话；都没有才走按标签认领
      const runSessionId = resumeFrom
        ? null
        : await invoke<RunDto | null>("run_get", { id: probeRun })
            .then((r) => r?.sessionId ?? null)
            .catch(() => null);
      if (!linkCtxRef.current) {
        channelSeqSeenRef.current = 0;
        channelEndHandledRef.current = null;
        linkCtxRef.current = {
          agentId,
          cwd,
          hint: resumeFrom ?? runSessionId,
          filePath: null,
          sessionId: null,
          createdAt: null,
        };
      }
      setLinkState("detecting");
      setSyncState("detecting");
      linkStartedAtRef.current = Date.now();
      startLinkPolling(500);
      await attach(existingPty, "agent", { reset: false });
      setExited(false);
      setExitCode(null);
      setShellActive(false);
      setRunning(true);
      setStartedAt((prev) => prev ?? Date.now());
      setNotice("已接回正在跑的进程，画面大小先不动");
      return { ptyId: existingPty, promptDropped: false };
    }
    if (chrome.kind === "collapse") {
      setAdvancedLaunchOpen(false);
      setBarExpanded(false);
    }
    const size = await waitForTerminalGrid();
    if (!allowSpawn(size)) {
      setBarExpanded(chromeSnapshot.bar);
      setAdvancedLaunchOpen(chromeSnapshot.advanced);
      setError("这次没能按画面大小启动");
      return null;
    }
    await cleanupPty();
    setLinkState("detecting");
    setSyncState("detecting");
    linkStartedAtRef.current = Date.now();
    // 步骤认领（「跟 AI 商量一下」）：spawn 前以最终 agent/cwd 登记——此刻的值才是用户
    // 在启动栏确认后的真实选择；会话归属由列表扫描命中后固化进 session_meta.step_name。
    // 同标签重复启动（重启 Agent 接着聊任务书）重新登记，新会话仍归该步骤
    if (stepClaimName && !resumeFrom) {
      invoke("claim_next_session_for_step", {
        agent: agentId,
        cwd,
        stepName: stepClaimName,
      }).catch(() => {
        // 登记失败静默降级：会话不归步骤，仍可在对话页全部列表里看到
      });
    }
    const lockKey = (freshRun ? "" : (runId ?? initialRunId ?? "").trim()) || `tab:${tabId}`;
    if (interactiveLaunchLocks.has(lockKey)) {
      return null;
    }
    interactiveLaunchLocks.add(lockKey);
    // 启动参数带进去的首条指令也算「刚发的话」：没经过 writeChatMessage，原先 lastSentRef 是空的。CLI 把它留在输入框里时
    // （2026-10-25 用户截图，Claude 2.1.308），「❯ 首行 + 缩进续行 + 上方横线」被扫菜单认成五个选项，拿它比对才排除得掉
    if (launchPrompt && !isResume) lastSentRef.current = launchPrompt;
    try {
      resizeLatchRef.current = {
        kind: "measured",
        cols: size.cols,
        rows: size.rows,
      };
      const res = await invoke<{
        ptyId: string;
        sessionHint: string | null;
        promptDropped: boolean;
        model: string | null;
        runId: string | null;
        adopted?: boolean;
        resumeUnwritten?: boolean;
        proxyDown?: string | null;
      }>("pty_spawn", {
        agentId,
        profileId,
        cwd,
        model: (() => {
          const m = model.trim();
          if (!m) return null;
          if (
            selectedProfile?.accountType === "official" &&
            !officialModelAllowed(agentId, m)
          ) {
            return null;
          }
          return m;
        })(),
        // 工作区交接的附加 env（端口段），与 profile env 叠加
        extraEnv: initialExtraEnv ?? null,
        // 会话恢复（无则全新会话）；换了目录 / Agent 不再接原会话
        resumeSessionId: resumeFrom ?? null,
        forkSessionId: forkFrom ?? null,
        resumeProvider: relayLaunch ? relayLaunch.provider : sessionMoved ? null : (resumeProvider ?? null),
        // 一键开步的首条指令（恢复会话由后端忽略注入）
        initialPrompt: (options?.prompt ?? promptText).trim() || null,
        linkClaimId: tabId,
        // 「聊想法」只读模式：后端按注册表注入只读/计划模式参数（不支持的 CLI 只有 prompt 软约束）
        readonly: options?.readonly ?? readonly ?? null,
        permission: launchPermission,
        // 开工弹层的本次思考档覆盖（空 = 绑定逐模型策略）；后端在读绑定策略处用本值优先
        effortOverride: effortOverride?.trim() || null,
        // 聊天权限徽标选的原生权限档（只讨论时不传；null = 按本机设置）
        permissionMode: launchPermission === "discuss" ? null : permissionMode,
        // 离开了原目标的目录：不再按那个目标的复用键 / Task 登记（工作区键会被判成步骤、在主仓里写盘被拒）
        reuseKey: leftTaskDir && isTaskReuseKey(reuseKey) ? null : (reuseKey ?? null),
        runId: freshRun ? null : (runId ?? initialRunId ?? null),
        taskId: leftTaskDir ? null : (taskId ?? null),
        cols: size.cols,
        rows: size.rows,
      });
      if (res.adopted) resizeLatchRef.current = { kind: "frozen" };
      if (res.runId) {
        runIdRef.current = res.runId;
        setRunId(res.runId);
      }
      boundIdentityRef.current = launchIdentity;
      // 原会话属于换走之前的 Agent / 目录：回落 shell 后发消息不再拿它去接
      if (sessionMoved) lastResumeRef.current = null;
      // 要接的那段对话从没落盘（上次启动没聊就退出 / 启动即崩），后端已改开新会话：说一句，
      // 免得用户以为接上了上次的上下文
      if (res.resumeUnwritten) {
        toast("上次那段对话没有留下记录（Agent 没来得及保存就退出了），已在原目录开了新会话", "info");
      }
      // 官方账号走设置里的出网代理，本机代理端口没在监听：多半是代理软件没开，接下来的网络错误先往这上头想
      // 预检已经就这件事问过就不再提（同一件事只说一次）；预检用的是 5 分钟内的结果，代理刚关掉时靠这里兜底
      if (res.proxyDown && !routeBlocked) {
        toast(`出网代理 ${res.proxyDown} 没有在运行：官方账号可能连不上，先打开代理软件，或到设置 → 网络改掉`, "warning");
      }
      if (routeNote) toast(routeNote, "info");
      // 后端兜底模型回传（前端留空 = profile 首个模型）：同步进标签状态，
      // 否则状态栏/对话头部在兜底路径下没有模型可显示；lastLaunch/模型历史也记生效值
      const effectiveModel = res.model ?? model;
      if (res.model && res.model !== model) setModel(res.model);
      setLaunchModel(effectiveModel.trim() || null);
      launchRecordRef.current = { model: effectiveModel.trim(), effort: effortOverride?.trim() ?? "" };
      localStorage.setItem(
        "ccode.lastLaunch",
        JSON.stringify({ agentId, profileId, model: effectiveModel, cwd }),
      );
      // 随手聊发出第一句、Agent 起来了：下次快速开聊照这次的 Agent / 连接 / 模型 / 思考档开
      if (reuseKey?.startsWith(QUICK_CHAT_KEY_PREFIX)) {
        saveQuickChatChoice({
          agentId,
          profileId,
          model: effectiveModel.trim() || undefined,
          effort: effortOverride?.trim() || null,
        });
      }
      // 模型历史（Agent + 连接维度，去重前置，上限 10 条）：模型 combo 下拉的可选项来源之一
      if (effectiveModel.trim() && profileId) {
        try {
          const key = `ccode.modelHistory.${agentId}.${profileId}`;
          const list = JSON.parse(
            localStorage.getItem(key) ?? "[]",
          ) as string[];
          localStorage.setItem(
            key,
            JSON.stringify(
              [
                effectiveModel.trim(),
                ...list.filter((m) => m !== effectiveModel.trim()),
              ].slice(0, 10),
            ),
          );
        } catch {
          /* 损坏则重置 */
        }
      }
      // 记住各 Agent 上次使用的配置（会话恢复的兜底选择）
      localStorage.setItem(`ccode.lastProfile.${agentId}`, profileId);
      // 工作区记住上次配置（W3：worktree 目录下的启动）
      if (cwd.includes("/ccode/workspaces/")) {
        localStorage.setItem(
          `ccode.wsLast.${cwd}`,
          JSON.stringify({ agentId, profileId, model }),
        );
      }
      // SessionLink：记录启动上下文，开始轮询会话文件
      channelSeqSeenRef.current = 0;
      channelEndHandledRef.current = null;
      linkCtxRef.current = {
        agentId,
        cwd,
        hint: res.sessionHint,
        filePath: null,
        sessionId: null,
        createdAt: null,
      };
      // 首次关联阶段使用短间隔，避免聊天层长时间停留在“识别中”；关联成功后
      // lockLink 会切回较宽松的兜底轮询，正常刷新由 session watcher 驱动。
      startLinkPolling(500);
      await attach(res.ptyId, "agent", { reset: !res.adopted });
      const launchedPrompt = (options?.prompt ?? promptText).trim();
      const armWorking = shouldArmWorkingOnLaunch({
        prompt: launchedPrompt,
        isResume: isResume && !res.resumeUnwritten,
      });
      if (armWorking) {
        armPtyWorking();
      }
      setExited(false);
      setExitCode(null);
      setShellActive(false);
      setRunning(true);
      setStartedAt(Date.now());
      if (res.adopted) {
        setNotice("已接回正在跑的进程，画面大小先不动");
      } else if (res.promptDropped && !isResume && options?.typeDroppedPrompt) {
        // 调用方随后写进 PTY 并自己点亮「进行中」
        disarmPtyWorking();
        setPromptText("");
        setShowPrompt(false);
        setAdvancedLaunchOpen(false);
        setBarExpanded(false);
      } else if (res.promptDropped && !isResume) {
        // Kimi 没有带首条指令进交互界面的参数（-p 是一次性非交互）：等输入框就绪后照普通消息写进去，
        // 与聊天发送同一条路；写不进去才退回复制（2026-11-10 用户：开步换成 Kimi 只给「已复制，请粘贴」）
        if (armWorking) setPendingReply(true);
        setPromptText("");
        setShowPrompt(false);
        setAdvancedLaunchOpen(false);
        setBarExpanded(false);
        const droppedPty = res.ptyId;
        void writeChatMessage(droppedPty, launchPrompt).then((sent) => {
          if (!sent.error || !mountedRef.current || ptyIdRef.current !== droppedPty) return;
          disarmPtyWorking();
          setPendingReply(false);
          void navigator.clipboard.writeText(launchPrompt).catch(() => {});
          setError(`首条指令没能自动发出（${sent.error}）：已复制，请在终端里粘贴发送`);
          setBarExpanded(true);
        });
      } else {
        // 注入首轮也走「等回复」：切到聊天要立刻有进行中/正在回复，
        // 不能等会话文件落盘或用户再发一条才亮。
        if (armWorking) setPendingReply(true);
        // 一次性：注入成功（或未携带指令）即清除，之后「启动」不再重复发送
        setPromptText("");
        setShowPrompt(false);
        setAdvancedLaunchOpen(false);
        setBarExpanded(false);
      }
      if (restored) onRestoreComplete?.(tabId);
      // 本次启动已接管会话：清掉标签级 resumeSessionId，之后「启动」不会再接回旧会话
      if (resumeSessionId) onConsumeResume?.(tabId);
      return { ptyId: res.ptyId, promptDropped: res.promptDropped };
    } catch (e) {
      if (resizeLatchRef.current.kind !== "measured" && resizeLatchRef.current.kind !== "frozen") {
        setBarExpanded(chromeSnapshot.bar);
        setAdvancedLaunchOpen(chromeSnapshot.advanced);
      }
      invoke("release_session_claim", { claimId: tabId }).catch(() => {});
      stopLinkTimer();
      setLinkState("idle");
      // cleanupPty 已杀掉旧 PTY：失败不能留下指向死 PTY 的幻影 shell 状态。
      // 启动没成功不算「进程已退出」——否则空态卡还在，上面却写进程没了。
      setShellActive(false);
      setActivePtyId(null);
      setError(String(e));
      setLaunchBlock(launchBlockOf(String(e)));
      return null;
    } finally {
      interactiveLaunchLocks.delete(lockKey);
    }
  }

  async function openShell() {
    setError(null);
    setNotice(null);
    if (!(await checkWorkingDirectory(cwd))) {
      setBarExpanded(true);
      return;
    }
    await cleanupPty();
    try {
      const size = fittedPtySize(fitRef.current, termRef.current);
      if (!allowSpawn(size)) {
        setError("这次没能按画面大小启动");
        return;
      }
      resizeLatchRef.current = {
        kind: "measured",
        cols: size.cols,
        rows: size.rows,
      };
      const ptyId = await invoke<string>("shell_spawn", {
        cwd,
        extraEnv: initialExtraEnv ?? null,
        cols: size.cols,
        rows: size.rows,
      });
      await attach(ptyId, "shell", { reset: true });
      setExited(false);
      setExitCode(null);
      setShellActive(true);
      setBarExpanded(false);
    } catch (e) {
      // 旧 PTY 已被 cleanupPty 杀掉：同样清掉幻影 shell 状态
      setShellActive(false);
      setActivePtyId(null);
      setExited(true);
      setError(String(e));
    }
  }

  /** 重启占位标签只在用户点击后恢复；目录失效时保留表单供修改，不盲目回落到其他目录。 */
  async function restoreTask() {
    if (!selectedProfile) {
      setError("上次使用的配置已不存在，请重新选择配置");
      setBarExpanded(true);
      return;
    }
    if (!(await checkWorkingDirectory(cwd))) {
      setBarExpanded(true);
      return;
    }
    await launch();
  }

  /** 停止 Agent：杀掉 PTY 后由退出事件自动回落到 shell */
  // 运行中换权限（2026-10-17 用户：发完消息权限就改不了了）：各家权限都在启动参数里，
  // 只能停下再带新参数接回原会话。父级先改标签的 permission / permissionMode，再调这里；
  // 进程退出回落 shell 后（下方 effect）用最新 props 按原会话恢复，对话内容不丢
  const permissionRestartRef = useRef(false);
  /** 换模型 / 思考档的重开接回（2026-10-18）：先把新值写进启动栏 state 与标签，下一拍再停；回落 shell 后
   *  下方 effect 按原会话带新参数接回。不用 CLI 的 /model、/effort——它们会写回 CLI 自己的全局配置 */
  function relaunchWith(patch: { model?: string; effort?: string | null }) {
    if (ptyKindRef.current !== "agent" || !ptyIdRef.current) return;
    if (patch.model !== undefined) {
      setModel(patch.model);
      setModelKept(false);
    }
    if (patch.effort !== undefined) onPatchLaunch?.(tabId, { effort: patch.effort });
    window.setTimeout(restartWithPermission, 0);
  }
  function restartWithPermission() {
    if (ptyKindRef.current !== "agent" || !ptyIdRef.current) return;
    permissionRestartRef.current = true;
    void stop();
  }
  useEffect(() => {
    if (!permissionRestartRef.current || running || !shellActive) return;
    permissionRestartRef.current = false;
    // 另开一条 Run 接回原对话：旧 Run 已停、权限也变了（只讨论 ↔ 可改文件是 Run 身份的一部分）。
    // 接回途中原来的对话留在画面上，接上后会话文件刷新整份替换——原先 launch 先清空聊天，换权限 / 换模型像整页刷新了一次（2026-10-25 用户）
    const resume = lastResumeRef.current ?? undefined;
    keepPreviewConvRef.current = Boolean(resume);
    void launch(resume, { prompt: "", freshRun: true }).finally(() => {
      keepPreviewConvRef.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, shellActive]);

  // 出错换连接（2026-10-17）：先把标签的连接 / 模型换成新的，再停下 Agent；回落 shell 后（下方 effect）
  // 按原会话接回。Agent 已经停了（还能接着聊）就直接接回。模型：新连接名单里有当前模型就留着，没有用它的第一个
  const switchPendingRef = useRef<string | null>(null);
  function switchConnection(id: string) {
    const target = profiles.find((p) => p.id === id && p.agent === agentId);
    if (!target) return;
    dismissConnIssue();
    setProfileId(id);
    const cur = model.trim();
    setModel(cur && target.models.includes(cur) ? cur : (target.models[0] ?? ""));
    setModelKept(false);
    switchPendingRef.current = id;
    if (ptyKindRef.current === "agent" && ptyIdRef.current) void stop();
  }
  useEffect(() => {
    const target = switchPendingRef.current;
    if (!target || running || !shellActive || profileId !== target) return;
    switchPendingRef.current = null;
    if (!lastResumeRef.current) return;
    // 同换权限：接回途中原来的对话留在画面上
    keepPreviewConvRef.current = true;
    void launch(lastResumeRef.current, { prompt: "" }).finally(() => {
      keepPreviewConvRef.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, shellActive, profileId]);
  // 退出 Grok 官方登录：等 Grok 停下（它不再占着登录文件锁）再 grok logout，然后按原会话接回。
  // logout 没清掉（别的 Grok 标签还卡着）照样接回，把原因报出来
  useEffect(() => {
    if (!grokLogoutPendingRef.current || running || !shellActive) return;
    grokLogoutPendingRef.current = false;
    void (async () => {
      try {
        await invoke("grok_logout");
        setNotice("已退出 Grok 官方登录，改用这条连接的钥匙");
      } catch (reason) {
        setError(String(reason));
      }
      const resume = lastResumeRef.current ?? undefined;
      keepPreviewConvRef.current = Boolean(resume);
      await launch(resume, { prompt: "" }).finally(() => {
        keepPreviewConvRef.current = false;
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, shellActive]);

  async function stop() {
    const id = ptyIdRef.current;
    if (!id) return;
    try {
      await invoke("pty_kill", { ptyId: id });
    } catch (reason) {
      setError(`停止终端失败：${String(reason)}`);
    }
  }

  /** 等刚拉起的 Agent 能收键，只在拉起后的第一次发送等，之后直接写。
   *  认得画面布局的几家（live-reply.ts）等屏上画出它的输入框、再安静 300ms：Kimi 2.3 一起来先发一个终端查询，
   *  隔一秒多才画界面，原先「出过字后安静 400ms」在查询之后就写了，字落在界面起来之前被吞掉
   *  （2026-10-21 用户：Kimi 发「你好」终端里没有输入，8 秒后终端被拉起来；Mac 同样）。屏上是信任菜单时一直等——
   *  这时写进回车就等于替用户选了；其余认不出输入框的情形最多等 20 秒。
   *  认不得布局的家（与后台标签：画面不更新）照旧：画出过字后安静 400ms（一直没画的等满 3 秒），最多 8 秒 */
  async function waitAgentInputReady(ptyId: string) {
    const agent = launchAgentRef.current;
    const byBox = liveReplySupported(agent) && visibleRef.current;
    while (!inputReadyRef.current && ptyIdRef.current === ptyId) {
      const now = Date.now();
      const since = now - ptyAttachedAtRef.current;
      const quiet = now - lastOutputAtRef.current;
      if (byBox) {
        const lines = screenLines();
        const trust = parseTrustPrompt(lines) !== null;
        // 刚起来的 20 秒里要安静 1.5 秒才算就绪：接回的会话先画输入框、再回放、再写「※ recap」，
        // 中途写进去开头会丢、提交键被当成粘贴里的换行（2026-10-24 HER 润色：输入框画出 1 秒就写，整段卡在框里）
        const settle = since < 20_000 ? 1500 : 300;
        if (!trust && ((quiet >= settle && terminalHasInputBox(lines, agent) === true) || since >= 20_000)) {
          inputReadyRef.current = true;
          break;
        }
      } else {
        const drew = lastDrawAtRef.current > ptyAttachedAtRef.current;
        if ((quiet >= 400 && (drew || since >= 3000)) || since >= 8000) {
          inputReadyRef.current = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async function writeChatMessage(ptyId: string, text: string): Promise<ChatSendResult> {
    await waitAgentInputReady(ptyId);
    if (ptyIdRef.current !== ptyId) {
      liveHoldRef.current = false;
      return { error: "终端已重新启动，这句没有发出，请再发一次" };
    }
    // 写之前就记下：正文粘进输入框到按下提交之间（多行要等 0.65 秒），输入框里的编号清单会被扫菜单认成选项，
    // 拿上一句比对排除不掉（2026-10-21 用户 Grok：七步清单在输入框里时出了一张「终端里在等你选一项」）
    lastSentRef.current = text;
    // 发送前屏上最后一条回显与那时读得出的一截：CLI 画出这句之前，实时预览读到的还是上一轮（staleEcho / staleWithoutEcho）
    const beforeRead = extractLiveReply(screenLines(), launchAgentRef.current, screenItalicRow);
    sendEchoRef.current = {
      before: beforeRead?.echo ?? null,
      beforeLines: beforeRead?.lines ?? null,
      sent: text,
    };
    liveHoldRef.current = false;
    try {
      await invoke("pty_write_submit", {
        ptyId,
        text,
        submit: submitCsiU ? KIMI_CSI_U_ENTER : "\r",
        // Windows 上 Grok 收粘贴包里的 LF 会把两行连成一行，CR 才算换行；Codex 的 LF 同样丢、CR 又会拆成几条消息，
        // 换行改送 Shift+Enter 按键记录（pty.rs shift_enter_pieces）；别家 LF 正常，不动
        pasteNewline: !IS_WINDOWS
          ? null
          : launchAgentRef.current === "grok"
            ? "\r"
            : launchAgentRef.current === "codex"
              ? "shift-enter"
              : null,
      });
      void confirmSubmitted(ptyId, text);
      return { error: null };
    } catch (e) {
      return { error: `发送失败：${String(e)}` };
    }
  }

  /** 交出去了没有：这句连着 1.6 秒还躺在输入框里，就补一次「粘贴结束 + 提交键」，最多补三次。
   *  刚接回的会话（resume 回放、recap 还在写）里写进去，CLI 会停在粘贴状态：后面的回车都被当成粘贴里的换行，
   *  人自己按回车也只多一行（2026-10-24 HER 润色两次实证：Claude 框里多出一空行、按回车只出「ctrl+g 编辑」提示）。
   *  先补粘贴结束标记把它拉出粘贴状态，再按提交键；没在粘贴状态时这个标记被忽略。只认屏上的输入框，没有布局表的家不管 */
  async function confirmSubmitted(ptyId: string, text: string) {
    const agent = launchAgentRef.current;
    const PASTE_END = "\x1b[201~";
    for (let attempt = 0; attempt < 3; attempt++) {
      let stuckFor = 0;
      for (let waited = 0; waited < 6000 && stuckFor < 1600; waited += 400) {
        await new Promise((r) => setTimeout(r, 400));
        if (!mountedRef.current || ptyIdRef.current !== ptyId) return;
        if (sentTextStuckInBox(screenLines(), agent, text) !== true) {
          stuckFor = 0;
          if (waited >= 2000) return;
          continue;
        }
        stuckFor += 400;
      }
      if (stuckFor < 1600) return;
      await invoke("pty_write", { ptyId, data: PASTE_END }).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      if (!mountedRef.current || ptyIdRef.current !== ptyId) return;
      await invoke("pty_write", { ptyId, data: submitCsiU ? KIMI_CSI_U_ENTER : "\r" }).catch(() => {});
    }
  }

  /** queued = 上一轮还在生成时发的：CLI 自己排队，这一轮结束才处理（聊天层气泡标「排队中」） */
  function showOptimisticUserMessage(text: string, queued = false): ChatMessageDto {
    lastSentRef.current = text;
    lastSendAtRef.current = Date.now();
    // 发送发生在后台读取途中时，令旧读取失效，避免它把刚显示的本地消息覆盖掉。
    conversationRequestRef.current += 1;
    // 实时预览从这一轮重新攒（上一轮的长回复不能接到这一轮前面）
    liveReplyRef.current = null;
    setLiveReply(null);
    liveTokensRef.current = null;
    setLiveTokens(null);
    liveThinkingRef.current = null;
    setLiveThinking(null);
    setSuggestion(null);
    const message: ChatMessageDto = {
      role: "user",
      blocks: [{ kind: "text", text, toolName: null }],
      timestamp: new Date().toISOString(),
      usage: null,
      ...(queued ? { queued: true } : {}),
    };
    pendingAssistantKeysRef.current = new Set(
      conv
        .filter((item) => item.role !== "user")
        .map((item) => messageKey(item)),
    );
    pendingUsersRef.current = [...pendingUsersRef.current, message];
    setConv((current) => {
      const last = current[current.length - 1];
      const lastText = last?.blocks.map((block) => block.text).join("");
      if (last?.role === "user" && lastText === text) return current;
      // 不截短：原先截成最后 50 条（2026-08 还没有分页时的上限），长对话一发出就从几百条缩成 50 条、
      // 会话文件刷新再并回来，画面一缩一胀跳到半中间（2026-10-28 本机实录）
      return [...current, message];
    });
    setPendingReply(true);
    return message;
  }

  /** 先显示了、却没写进终端：把那条气泡撤掉（同一个对象；同文去重时没加进去的不受影响），「等回复」回到发送前 */
  function retractOptimisticUserMessage(message: ChatMessageDto, wasPending: boolean) {
    pendingUsersRef.current = pendingUsersRef.current.filter((m) => m !== message);
    setConv((current) => current.filter((m) => m !== message));
    setPendingReply(wasPending);
  }

  /** 这个目录是已添加的项目：取它开聊附带的项目说明（自动 / 自定义 / 不附带，见项目设置）；不是项目或读不到给空串 */
  async function projectPackFor(dir: string): Promise<string> {
    try {
      const list = await invoke<ProjectDto[]>("list_projects");
      const project = list.find((p) => samePath(p.path, dir, IS_WINDOWS));
      if (!project) return "";
      return await loadProjectContextPack({
        name: project.name,
        path: project.path,
        workMode: normalizeWorkMode(project.workMode),
        writeReview: false,
        kind: "session",
      });
    } catch {
      return "";
    }
  }

  async function sendMessage(text: string): Promise<ChatSendResult> {
    const message = text.trim();
    if (!message) return { error: null };
    const relayTarget = relayPickRef.current;
    if (relayTarget) return relaySend(message, relayTarget);
    // 发送链路以 PTY ref 为准，不依赖 running/activePtyId 的异步镜像状态。
    // 聊天层与终端层共享这个 PTY；刚启动或刚从 shell 回落时，React 状态可能尚未完成一帧更新。
    const currentPtyId = ptyIdRef.current;
    if (ptyKindRef.current === "agent" && currentPtyId) {
      const wasPending = pendingReplyRef.current;
      const queued = wasPending || attention === "working";
      armPtyWorking();
      // 气泡先出、再往终端里写（要等 CLI 能收键、多行正文还要等 0.65 秒才按提交）：输入框一清空，这句就在对话里了，
      // 不留一段「哪儿都看不见」的空当（2026-10-25 用户：发送不够丝滑）。没写进去再撤掉
      const shown = showOptimisticUserMessage(message, queued);
      if (/^[/!]\S/.test(message)) {
        slashBaselineRef.current.set(shown, screenLines());
        slashMenuOwnerRef.current = { sent: shown, at: Date.now() };
      }
      const result = await writeChatMessage(currentPtyId, message);
      if (result.error) {
        disarmPtyWorking();
        retractOptimisticUserMessage(shown, wasPending);
      }
      return result;
    }

    // Agent 已回落 shell：聊天框继续沿用最后一个会话，而不是启动新上下文。
    if (!running && shellActive && lastResumeRef.current) {
      const early = showEarlyBubble(message);
      liveHoldRef.current = true;
      const res = await launch(lastResumeRef.current, { prompt: "" }).finally(endEarlyBubbleLaunch);
      if (!res) {
        early.retract();
        return { error: launchCancelRef.current ?? error ?? "恢复会话失败，请切到终端检查" };
      }
      early.reRegister();
      // 恢复启动要经历进程引导/会话回放（可能还有信任提示）：等一拍再写，
      // 否则正文+提交键落在尚未就绪的 TUI 上，表现为消息躺在输入框里没发出去
      await new Promise((r) => setTimeout(r, 1200));
      if (!mountedRef.current) return { error: null };
      if (ptyIdRef.current !== res.ptyId) {
        early.retract();
        return { error: "终端已重新启动，这句没有发出，请再发一次" };
      }
      armPtyWorking();
      const result = await writeChatMessage(res.ptyId, message);
      if (result.error) {
        disarmPtyWorking();
        early.retract();
      }
      return result;
    }

    // 恢复占位（重启后留下、还没接回的标签）与只看没接的对话（列表里点开的）：先按原会话恢复，再把这句写进去。
    // 恢复启动会忽略首条指令注入，直接带 prompt 启动这句话会被吞掉。
    // 接力时接手那家没起来、退回了原来那家：同样接回原来那段（relayBackRef）
    const backTo = relayBackRef.current;
    if (!running && !shellActive && (resumeSessionId || backTo) && !customRuntimeId) {
      if (!selectedProfile) {
        return { error: "上次使用的配置已不存在，切到终端在启动栏重新选择" };
      }
      // 摆着的记录在接回途中不清掉：接上之后由会话文件刷新接替，不闪回空态（showEarlyBubble 一并管）
      const early = showEarlyBubble(message);
      liveHoldRef.current = true;
      const res = await launch(backTo ?? undefined, { prompt: "" }).finally(endEarlyBubbleLaunch);
      if (!res) {
        early.retract();
        return { error: launchCancelRef.current ?? error ?? "恢复会话失败，请切到终端检查" };
      }
      relayBackRef.current = null;
      early.reRegister();
      await new Promise((r) => setTimeout(r, 1200));
      if (!mountedRef.current) return { error: null };
      if (ptyIdRef.current !== res.ptyId) {
        early.retract();
        return { error: "终端已重新启动，这句没有发出，请再发一次" };
      }
      armPtyWorking();
      const result = await writeChatMessage(res.ptyId, message);
      if (result.error) {
        disarmPtyWorking();
        early.retract();
      }
      return result;
    }

    if (!profileId) {
      return {
        error:
          agentProfiles.length === 0
            ? `${agentLabel(agentId)} 还没有连接：先去「连接」页添加，或点输入框右下的模型菜单换一家 Agent`
            : "还没选连接：点输入框右下的模型菜单，在顶部选一条连接",
      };
    }
    setPromptText(message);
    setShowPrompt(true);
    // 在已添加的项目里开的新对话（项目行 ＋、新对话换到这个项目都算）：项目说明（项目设置里的对话注入）悄悄附在第一句前面，
    // 发的时候按项目当时的内容现拼；聊天气泡、起名只认人说的（splitLaunchPrompt / strip_mesa_launch_pack）
    const pack = await projectPackFor(cwd);
    const firstPrompt = pack ? composeLaunchPrompt(pack, message) : message;
    const early = showEarlyBubble(message);
    const res = await launch(undefined, { prompt: firstPrompt, typeDroppedPrompt: true }).finally(endEarlyBubbleLaunch);
    if (!res) {
      early.retract();
      return { error: launchCancelRef.current ?? "启动 Agent 失败，请切到终端查看详细信息" };
    }
    early.reRegister();
    // 读屏比对「刚发的话」要用整段首条指令（项目说明拼在前面），不是气泡里那句
    lastSentRef.current = firstPrompt;
    if (res.promptDropped) {
      // Kimi 没有带首条指令启动的参数：等输入框就绪后照普通消息写进去（与之后每句同一条路）
      if (!mountedRef.current) return { error: null };
      if (ptyIdRef.current !== res.ptyId) {
        early.retract();
        return { error: "终端已重新启动，这句没有发出，请再发一次" };
      }
      armPtyWorking();
      const result = await writeChatMessage(res.ptyId, firstPrompt);
      if (result.error) {
        disarmPtyWorking();
        early.retract();
      }
      return result;
    }
    return { error: null };
  }

  /**
   * 聊天里换一家接着做（docs/design-chat-relay.md §3.3 / §4.4）：写好简报、停下原来那家，同一个标签换成接手那家——
   * 新开一段时第一句 =「接力抬头 + ---- + 这句原话」；接回它原来那段时先接回，再把「补充抬头 + 原话」作为这一轮发出。
   * 任一步失败停在原处报原因：写简报失败什么都不动；接手那家没起来就退回原来那家，下一句接回原来那段
   */
  async function relaySend(message: string, target: RelayTarget): Promise<ChatSendResult> {
    const source = relaySource();
    if (!source) {
      setRelayPick(null);
      return { error: "这段对话还没有记录，直接换 Agent 即可" };
    }
    if (attention === "working" || pendingReplyRef.current) {
      return { error: "等这一轮结束再换" };
    }
    if (!profiles.some((p) => p.id === target.profileId)) {
      return { error: `${agentLabel(target.agentId)} 的这条连接已不在，请重选` };
    }
    const early = showEarlyBubble(message);
    let prepared: RelayPrepareDto;
    try {
      prepared = await invoke<RelayPrepareDto>("relay_prepare", {
        source,
        targetAgent: target.agentId,
        resumeSession: target.mode === "resume" ? target.resumeSession : null,
        withWords: true,
      });
    } catch (e) {
      early.retract();
      endEarlyBubbleLaunch();
      return { error: `没能交给 ${agentLabel(target.agentId)}：${String(e)}` };
    }
    const targetDet = launchAgents.find((a) => a.id === target.agentId);
    return new Promise<ChatSendResult>((resolve) => {
      relayJobRef.current = {
        target,
        prepared,
        message,
        source: { agentId: source.agent, profileId, model, sessionId: source.sessionId },
        early,
        resolve,
      };
      agentPickedByHandRef.current = true;
      setRelayPick(null);
      setRelayOptions([]);
      setAgentId(target.agentId);
      setProfileId(target.profileId);
      setModel(target.model);
      setModelKept(false);
      // 思考档跟着换家回到默认；接手那家没有当前这档原生权限就回到「按本机设置」
      onPatchLaunch?.(tabId, {
        effort: null,
        ...(permissionMode && !targetDet?.permissionModes?.includes(permissionMode) ? { permissionMode: null } : {}),
      });
      setRelayTick((n) => n + 1);
      // 原来那家还在跑：先停（同换连接），回落 shell 后下面的 effect 再按接手那家起
      if (ptyKindRef.current === "agent" && ptyIdRef.current) void stop();
    });
  }
  async function runRelayJob(job: NonNullable<typeof relayJobRef.current>): Promise<ChatSendResult> {
    const { target, prepared, message, early, source } = job;
    const backToSource = (why: string): ChatSendResult => {
      early.retract();
      setAgentId(source.agentId);
      setProfileId(source.profileId);
      setModel(source.model);
      relayBackRef.current = source.sessionId;
      return {
        error: `${agentLabel(target.agentId)} 没起来（${why}），已回到 ${agentLabel(source.agentId)}，再发一次即可`,
      };
    };
    if (prepared.kind === "full" && prepared.framing) {
      const pack = await projectPackFor(cwd);
      const body = composeRelayPrompt(prepared.framing, message);
      const firstPrompt = pack ? composeLaunchPrompt(pack, body) : body;
      setPromptText(firstPrompt);
      setShowPrompt(true);
      const res = await launch(undefined, {
        prompt: firstPrompt,
        typeDroppedPrompt: true,
        freshRun: true,
        relay: { resume: null, provider: null },
      }).finally(endEarlyBubbleLaunch);
      if (!res) return backToSource(launchCancelRef.current ?? error ?? "启动失败");
      early.reRegister();
      lastSentRef.current = firstPrompt;
      if (res.promptDropped) {
        if (!mountedRef.current) return { error: null };
        if (ptyIdRef.current !== res.ptyId) {
          early.retract();
          return { error: "终端已重新启动，这句没有发出，请再发一次" };
        }
        armPtyWorking();
        const result = await writeChatMessage(res.ptyId, firstPrompt);
        if (result.error) {
          disarmPtyWorking();
          early.retract();
        }
        return result;
      }
      return { error: null };
    }
    // 接回原来那段：接回不能在启动参数里带话（pty.rs），接上之后照普通一句发
    liveHoldRef.current = true;
    const res = await launch(prepared.resumeSessionId ?? undefined, {
      prompt: "",
      freshRun: true,
      relay: { resume: prepared.resumeSessionId, provider: prepared.resumeProvider },
    }).finally(endEarlyBubbleLaunch);
    if (!res) return backToSource(launchCancelRef.current ?? error ?? "接回失败");
    early.reRegister();
    await new Promise((r) => setTimeout(r, 1200));
    if (!mountedRef.current) return { error: null };
    if (ptyIdRef.current !== res.ptyId) {
      early.retract();
      return { error: "终端已重新启动，这句没有发出，请再发一次" };
    }
    const text = prepared.kind === "delta" && prepared.framing ? composeRelayPrompt(prepared.framing, message) : message;
    armPtyWorking();
    const result = await writeChatMessage(res.ptyId, text);
    if (result.error) {
      disarmPtyWorking();
      early.retract();
    }
    return result;
  }

  /**
   * 要先启动 / 接回 Agent 的发送（几秒）：气泡先出。launch 开头的 resetLink 会清对话和待确认列表——
   * 期间置 keepPreviewConvRef 让画面上的（连同这条气泡）留着，launch 回来马上重新登记成待确认，接上后会话文件刷新不把它冲掉
   * （2026-10-25 用户：输入框清空了，聊天里却过几秒才出来）
   */
  function showEarlyBubble(text: string) {
    const shown: ChatMessageDto[] = [showOptimisticUserMessage(text)];
    keepPreviewConvRef.current = true;
    earlyLaunchRef.current = true;
    return {
      reRegister: () => {
        // 还在待确认里（resetLink 留下了）就不再加一遍
        if (shown.some((m) => pendingUsersRef.current.includes(m))) return;
        shown.push(showOptimisticUserMessage(text));
      },
      retract: () => {
        liveHoldRef.current = false;
        shown.forEach((m) => retractOptimisticUserMessage(m, false));
      },
    };
  }
  function endEarlyBubbleLaunch() {
    keepPreviewConvRef.current = false;
    earlyLaunchRef.current = false;
  }

  async function restartWritable(): Promise<ChatSendResult> {
    const prompt = forkPromptRef.current.trim();
    if (!prompt) return { error: "这段对话没有可重建的分叉摘要" };
    setPromptText(prompt);
    setShowPrompt(true);
    const res = await launch(undefined, { prompt, readonly: false, typeDroppedPrompt: true });
    if (!res) return { error: "重启可写会话失败，请切到终端查看详细信息" };
    if (res.promptDropped) {
      if (!mountedRef.current || ptyIdRef.current !== res.ptyId) return { error: null };
      armPtyWorking();
      const result = await writeChatMessage(res.ptyId, prompt);
      if (result.error) disarmPtyWorking();
      return result;
    }
    return { error: null };
  }

  function openConversationPage() {
    const sessionId = linkCtxRef.current?.sessionId ?? lastResumeRef.current;
    if (!sessionId) return;
    setOpenSessionReq({
      agent: linkCtxRef.current?.agentId ?? agentId,
      sessionId,
    });
    setPage("sessions");
  }

  // 接力：Agent 换好、这一帧的 launch 已经是接手那家，再起（relaySend 挂的活）
  useEffect(() => {
    const job = relayJobRef.current;
    if (!job || agentId !== job.target.agentId || profileId !== job.target.profileId || running) return;
    relayJobRef.current = null;
    void runRelayJob(job).then(job.resolve);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relayTick, agentId, profileId, running]);
  // 接手那段认出来了：第一句带着接力抬头，按简报文件名补记「接手的是这段」（对话页 ⋯ 入口开的也走这里）
  const relayAttachedRef = useRef(new Set<string>());
  useEffect(() => {
    if (!linkedSessionId || linkState !== "linked") return;
    const owner = linkCtxRef.current?.agentId ?? agentId;
    for (const m of conv.slice(0, 3)) {
      if (m.role !== "user") continue;
      const text = m.blocks.find((b) => b.kind === "text")?.text ?? "";
      const name = splitRelayPrompt(text)?.briefName;
      const key = `${name}\n${linkedSessionId}`;
      if (!name || relayAttachedRef.current.has(key)) continue;
      relayAttachedRef.current.add(key);
      invoke<boolean>("relay_attach", { briefName: name, agent: owner, sessionId: linkedSessionId })
        .then((changed) => {
          if (changed) void useAppStore.getState().loadSessions(true);
        })
        .catch(() => {});
    }
  }, [conv, linkedSessionId, linkState, agentId]);

  // 动作表：actionsRef 每次渲染更新为最新闭包；挂载时只注册一次稳定转发对象，
  // 父级查找/聊天发送等调用时穿透 ref，不会拿到首次渲染的陈旧 agent/profile/model/cwd
  const actionsRef = useRef<FocusTabActions>({
    stop: () => {},
    resume: () => {},
    openConversationPage: () => {},
    search: () => {},
    modify: () => {},
    toggleInsert: () => {},
    logLine: () => {},
    setCwd: () => {},
    chooseCwd: () => {},
    sendMessage: async () => ({ error: "终端尚未准备好" }),
    restartWritable: async () => ({ error: "这段对话不是可写分叉" }),
    writePty: () => {},
    terminalText: () => "",
    writeCommand: () => {},
    noteUserTurn: () => {},
    loadOlderConversation: async () => {},
    answerTrust: () => {},
    pickLaunchAgent: () => {},
    pickLaunchProfile: () => {},
    pickLaunchModel: () => {},
    pickRelay: () => {},
    loadRelayOptions: () => {},
    restoreHere: () => {},
    openDirMenu: () => {},
    pickDir: () => {},
    newProject: () => {},
    applyLaunchCombo: () => {},
    runTuiCommand: () => {},
    answerMenu: () => {},
    answerAsk: () => {},
    restartWithPermission: () => {},
    switchPermissionInSession: async () => false,
    relaunchWith: () => {},
    switchConnection: () => {},
    dismissConnIssue: () => {},
    grokLogout: () => {},
    dismissGrokLogin: () => {},
    pressWaitKey: () => {},
    launchAgain: () => {},
    dismissLaunchFailure: () => {},
    fixGeminiAuth: () => {},
    dismissLaunchBlock: () => {},
  });
  actionsRef.current = {
    stop: () => void stop(),
    resume: () => {
      if (lastResumeRef.current)
        void launch(lastResumeRef.current ?? undefined);
    },
    openConversationPage,
    search: () => setSearchOpen(true),
    toggleInsert: (anchor) => {
      setInsertTabAnchor(anchor ?? null);
      setInsertMenuFrom((from) => (from === "tab" ? null : "tab"));
    },
    modify: () => {
      if (ptyIdRef.current) {
        setLaunchInfoOpen(true);
        return;
      }
      setBarExpanded(true);
      setAdvancedLaunchOpen(true);
    },
    // 暗淡色（SGR 2）写一行，不进 PTY 输入流
    logLine: (text) => termRef.current?.writeln(`\x1b[2m${text}\x1b[0m`),
    setCwd: (c) => setWorkingDirectory(c),
    chooseCwd: () => void chooseWorkingDirectory(),
    sendMessage,
    restartWritable,
    // 聊天层审批按键（y/n/Esc）与生成中暂停（Esc）的写入通道。
    // Esc 是 Codex 那种停这一轮、会话还在：清掉「等待回复」，发送钮变回发送，下一条照常写进同一 PTY。
    writePty: (data) => {
      if (data === "\x1b" || data === "\x03") {
        disarmPtyWorking();
        if (data === "\x1b") {
          setPendingReply(false);
          settleAfterEsc();
        }
      } else if (data === "y" || data === "n") armPtyWorking();
      const id = ptyIdRef.current;
      if (id) writeInteractivePty(id, data);
    },
    terminalText: (n) => bufferTailLines(n).join("\n"),
    writeCommand: (cmd) => {
      const id = ptyIdRef.current;
      if (!id) return;
      const enter = submitCsiU ? KIMI_CSI_U_ENTER : "\r";
      writeInteractivePty(id, `${cmd}${enter}`);
    },
    noteUserTurn: () => armPtyWorking(),
    loadOlderConversation: (settle) => loadOlderConversation(settle),
    answerTrust: (accept) => answerTrust(accept),
    pickLaunchAgent,
    pickLaunchProfile,
    pickLaunchModel,
    pickRelay,
    loadRelayOptions,
    restoreHere: () => void restoreTask(),
    openDirMenu: (x, y) => setWelcomeDirMenu({ x, y }),
    pickDir: (pick) => void pickDir(pick),
    newProject: openNewProject,
    applyLaunchCombo,
    runTuiCommand,
    answerMenu,
    answerAsk,
    restartWithPermission,
    switchPermissionInSession,
    relaunchWith,
    switchConnection,
    dismissConnIssue,
    grokLogout,
    dismissGrokLogin,
    pressWaitKey,
    launchAgain: () => {
      setLaunchFailure(null);
      void launch(lastResumeRef.current ?? undefined);
    },
    dismissLaunchFailure: () => setLaunchFailure(null),
    fixGeminiAuth: () => void fixGeminiAuth(),
    dismissLaunchBlock: () => setLaunchBlock(null),
  };
  useEffect(() => {
    onActions?.(tabId, {
      stop: () => actionsRef.current.stop(),
      resume: () => actionsRef.current.resume(),
      openConversationPage: () =>
        actionsRef.current.openConversationPage(),
      search: () => actionsRef.current.search(),
      modify: () => actionsRef.current.modify(),
      toggleInsert: (anchor) => actionsRef.current.toggleInsert(anchor),
      logLine: (t) => actionsRef.current.logLine(t),
      setCwd: (c) => actionsRef.current.setCwd(c),
      chooseCwd: () => actionsRef.current.chooseCwd(),
      sendMessage: (text) => actionsRef.current.sendMessage(text),
      restartWritable: () => actionsRef.current.restartWritable(),
      writePty: (data) => actionsRef.current.writePty(data),
      terminalText: (n) => actionsRef.current.terminalText(n),
      writeCommand: (cmd) => actionsRef.current.writeCommand(cmd),
      noteUserTurn: () => actionsRef.current.noteUserTurn(),
      loadOlderConversation: (settle) => actionsRef.current.loadOlderConversation(settle),
      answerTrust: (accept) => actionsRef.current.answerTrust(accept),
      pickLaunchAgent: (id) => actionsRef.current.pickLaunchAgent(id),
      pickLaunchProfile: (id) => actionsRef.current.pickLaunchProfile(id),
      pickLaunchModel: (m) => actionsRef.current.pickLaunchModel(m),
      pickRelay: (t) => actionsRef.current.pickRelay(t),
      loadRelayOptions: () => actionsRef.current.loadRelayOptions(),
      restoreHere: () => actionsRef.current.restoreHere(),
      openDirMenu: (x, y) => actionsRef.current.openDirMenu(x, y),
      pickDir: (pick) => actionsRef.current.pickDir(pick),
      newProject: () => actionsRef.current.newProject(),
      applyLaunchCombo: (c) => actionsRef.current.applyLaunchCombo(c),
      runTuiCommand: (cmd) => actionsRef.current.runTuiCommand(cmd),
      answerMenu: (i, opts) => actionsRef.current.answerMenu(i, opts),
      answerAsk: (a) => actionsRef.current.answerAsk(a),
      restartWithPermission: () => actionsRef.current.restartWithPermission(),
      switchPermissionInSession: (tier) => actionsRef.current.switchPermissionInSession(tier),
      relaunchWith: (patch) => actionsRef.current.relaunchWith(patch),
      switchConnection: (id) => actionsRef.current.switchConnection(id),
      dismissConnIssue: () => actionsRef.current.dismissConnIssue(),
      grokLogout: () => actionsRef.current.grokLogout(),
      dismissGrokLogin: () => actionsRef.current.dismissGrokLogin(),
      pressWaitKey: (k) => actionsRef.current.pressWaitKey(k),
      launchAgain: () => actionsRef.current.launchAgain(),
      dismissLaunchFailure: () => actionsRef.current.dismissLaunchFailure(),
      fixGeminiAuth: () => actionsRef.current.fixGeminiAuth(),
      dismissLaunchBlock: () => actionsRef.current.dismissLaunchBlock(),
    });
  }, [onActions, tabId]);

  // P1b：启动栏输入框统一 inset 底（浮起层级），聚焦边线不变
  const select =
    "h-8 rounded-md border border-field bg-inset px-2 text-sm text-l2 outline-none placeholder:text-l4 focus:border-l4";
  // 分段容器内的无边框控件（v3.92：Agent/配置/模型三组收进同一条分段工具条，
  // 段与段之间留真空隙（gap）各自成小胶囊、不靠分隔线粘连，hover 单段高亮）
  const seg =
    "h-7 rounded-sm bg-transparent px-2 text-sm text-l2 outline-none placeholder:text-l4 hover:bg-hover focus:bg-hover disabled:hover:bg-transparent";

  function openTerminalActionMenu(event: React.MouseEvent<HTMLButtonElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    setTerminalActionMenu({ x: rect.right - 176, y: rect.bottom + 4 });
  }

  // ⋯ 打开时现取（父级按这一刻的会话 / 运行状态组装，与斜杠面板同源）
  const conversationActions = terminalActionMenu ? (getConversationActions?.(tabId) ?? []) : [];
  const terminalMenuItems = [
    ...(!running && !shellActive
      ? [
          {
            icon: SquareTerminal,
            label: "打开 Shell",
            onSelect: () => void openShell(),
          },
        ]
      : []),
    ...(!ptyIdRef.current
      ? [
          {
            icon: SlidersHorizontal,
            label: advancedLaunchOpen ? "收起高级启动选项" : "显示高级启动选项",
            onSelect: () => {
              setBarExpanded(true);
              setAdvancedLaunchOpen((v) => !v);
            },
          },
        ]
      : [
          {
            icon: Eye,
            label: "这次启动…",
            title: "看这次用的连接、模型、思考档和权限；可以换权限、换连接接着聊",
            onSelect: () => setLaunchInfoOpen(true),
          },
        ]),
    ...(sessionFile && linkedSessionId
      ? [
          ...(onForkChat
            ? [
                {
                  icon: GitFork,
                  label: "分叉成新对话",
                  onSelect: () => onForkChat?.(tabId),
                },
              ]
            : []),
          {
            icon: MessagesSquare,
            label: "在对话页回放",
            onSelect: () => openConversationPage(),
          },
        ]
      : []),
    // 对话操作（2026-10-18 与聊天层斜杠面板 Mesa 组同步）：新对话、压缩、导出、看改动、切到聊天
    ...(conversationActions.length > 0
      ? [
          { separator: true },
          { header: "对话操作" },
          ...conversationActions.map((c) => ({
            icon: CONVERSATION_ACTION_ICONS[c.cmd],
            label: c.label,
            title: c.hint,
            onSelect: c.run,
          })),
        ]
      : []),
    { separator: true },
    // 「快速开聊」的转正出口：把当前目录登记成项目，会话历史天然跟 cwd 走、
    // 自动归到新项目下（ProjectAggregator 既有归并口径，不需要迁移任何东西）。
    // 只登记，不建工作区、不选模板——模板从项目页的引导横幅或 ⋯ 里选。
    {
      icon: FolderPlus,
      label: "转为项目…",
      onSelect: () => {
        void (async () => {
          const dir = cwd.trim().replace(/[\\/]+$/, "");
          const name = dir.split(/[\\/]/).pop() || dir;
          if (!dir) return;
          if (
            !(await confirmDialog(
              `把「${name}」登记为 Mesa 项目？\n\n只登记，不改动任何文件。`,
              { confirmText: "登记" },
            ))
          )
            return;
          try {
            await invoke("register_project", { path: dir, name });
            void useAppStore.getState().loadProjects();
            useAppStore.getState().setSelectProjectReq(dir);
            useAppStore.getState().setPage("workspaces");
          } catch (e) {
            void alertDialog(`转为项目失败：${String(e)}`);
          }
        })();
      },
    },
  ];

  // 选中终端文字交给对话 / 存进笔记（2026-10-17 用户选定）。只在 Agent 在跑时给「引用 / 问 AI」：
  // 普通 Shell 的输出没有对话可交；分派（聊天层进输入框、终端层写进 TUI 输入行）在父级 conversationInsert
  const canHandToChat = running && Boolean(onConversationInsert);
  function handSelectionToChat(text: string, ask: boolean) {
    const payload = ask ? askAboutText(text) : quoteForChat(text);
    if (!payload) return;
    onConversationInsert?.(tabId, payload, { send: ask });
    termRef.current?.clearSelection();
    setTermPick(null);
  }
  // 「存进笔记」写项目根的 notes/clips.md：只在科研 / 办公项目里（编程仓库不往里塞 notes/，随手聊目录没有项目可存）
  const projectsVersion = useAppStore((st) => st.projectsVersion);
  const [clipRoot, setClipRoot] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    invoke<ProjectDto[]>("list_projects")
      .then((list) => {
        if (stale) return;
        const owner = list
          .filter((p) => pathWithin(cwd, p.path) && normalizeWorkMode(p.workMode) !== "coding")
          .sort((a, b) => b.path.length - a.path.length)[0];
        setClipRoot(owner?.path ?? null);
      })
      .catch(() => {
        if (!stale) setClipRoot(null);
      });
    return () => {
      stale = true;
    };
  }, [cwd, projectsVersion]);
  async function saveSelectionClip(text: string) {
    if (!clipRoot) return;
    const content = clipNoteEntry({
      text,
      when: new Date(),
      agentLabel: running ? agentLabel(agentId) : null,
      sessionTitle: linkedSessionTitle,
    });
    if (!content) return;
    try {
      await invoke("append_project_clip", { projectRoot: clipRoot, content });
      flashInputNote("已存进项目的 notes/clips.md");
      termRef.current?.clearSelection();
      setTermPick(null);
    } catch (e) {
      flashInputNote(`没存上：${String(e)}`);
    }
  }

  // 终端画布右键菜单：复制按打开菜单那一刻的选区裁剪（setTermCtxMenu 触发重渲染即取到最新值）
  const ctxSelection = termRef.current?.getSelection() ?? "";
  const termCtxMenuItems = [
    {
      icon: Copy,
      label: "复制",
      disabled: !ctxSelection,
      title: ctxSelection ? undefined : "先在终端里选中一段输出",
      onSelect: () =>
        void navigator.clipboard.writeText(ctxSelection).catch(() => {}),
    },
    {
      icon: ClipboardPaste,
      label: "粘贴",
      onSelect: () => void pasteFromClipboard(),
    },
    ...(ctxSelection.trim() && canHandToChat
      ? [
          { separator: true },
          {
            icon: MessageSquareQuote,
            label: "引用到输入框",
            title: "把选中的这段加上引用符号放进输入框，接着写你的话",
            onSelect: () => handSelectionToChat(ctxSelection, false),
          },
          {
            icon: MessageCircleQuestion,
            label: "问 AI 这是什么意思",
            title: "带着这段直接问这里的 AI",
            onSelect: () => handSelectionToChat(ctxSelection, true),
          },
        ]
      : []),
    ...(ctxSelection.trim() && clipRoot
      ? [
          {
            icon: NotebookPen,
            label: "存进笔记",
            title: "追加到这个项目的 notes/clips.md",
            onSelect: () => void saveSelectionClip(ctxSelection),
          },
        ]
      : []),
    { separator: true },
    {
      icon: Search,
      label: "查找输出",
      onSelect: () => setSearchOpen(true),
    },
  ];

  // 收缩行被隐藏时，出现必须看见的失败信息（错误 / 目录问题）则临时自动显示——
  // 否则「恢复失败」这类 Run 提示会随着行一起被藏掉。「上次任务，可恢复」是被动提示，
  // 不算紧急（恢复入口在中央卡片），随隐藏偏好一起藏（首版把 restored 也算紧急，
  // 导致恢复类标签永远藏不掉，用户实测否决）。「已接回正在跑的进程」同理走 notice
  // 不拦隐藏——接回是正常态，走过 error 时这行点「收起」永远收不起来（2026-10-09 修复）
  const compactBarUrgent = !!error || !!cwdIssue;

  return (
    <div className={`relative flex h-full flex-col ${embedInPeek ? "" : "px-2 pt-2"}`}>
      {launchInfoOpen && ptyIdRef.current && (
        <>
          <button
            type="button"
            aria-label="关闭这次启动"
            className="fixed inset-0 z-40"
            onClick={() => setLaunchInfoOpen(false)}
          />
          {/* 「这次启动」卡（2026-10-18 重做）：原先只读、首句写「这次进程不会改。要换，先停止」——模型 / 思考档现在
              底栏就能切，权限可以重开接回，连接可以换了接着聊，那句话已经不对。现在列全这次的五样，
              并把换权限、换连接放在卡里（与聊天输入框、连接出错提示同一套动作） */}
          <div
            role="dialog"
            aria-label="这次启动"
            className="ccode-float-surface absolute left-2 top-9 z-50 w-[19rem] rounded-xl border border-field p-1 text-sm shadow-lg"
          >
            <div className="px-2 pb-1 pt-1 text-xs text-l3">这次启动</div>
            <dl className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-2 gap-y-1 px-2 pb-1.5 text-xs">
              <dt className="text-l4">Agent</dt>
              <dd className="truncate text-l1">{agentLabel(agentId)}</dd>
              <dt className="text-l4">连接</dt>
              <dd className="min-w-0">
                <span className="block truncate text-l1">{selectedProfile?.name ?? "—"}</span>
                {/* 配置指纹（借鉴 VS Code 环境信息层）：托盘/设置切了全局默认后，跑着的终端仍是旧网关——
                    这里能看到本进程到底用的哪一套。只显标识与尾号，密钥值永不出现 */}
                {selectedProfile && (
                  <span className="block truncate text-l4" title="本进程生效的配置指纹">
                    {selectedProfile.accountType === "official"
                      ? "官方账号登录"
                      : [
                          selectedProfile.gatewayId
                            ? `网关 ${gatewayNameOf(selectedProfile.gatewayId)}`
                            : null,
                          selectedProfile.keyHint ? `密钥 ${selectedProfile.keyHint}` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                  </span>
                )}
              </dd>
              <dt className="text-l4">模型</dt>
              <dd className="truncate text-l1" title="运行中可在底栏或聊天输入框换">
                {modelSeen ?? launchModel ?? (model || "CLI 默认")}
              </dd>
              <dt className="text-l4">思考</dt>
              <dd className="truncate text-l1">
                {effortSeen ?? effortOverride ?? "按连接设置"}
              </dd>
              <dt className="text-l4">权限</dt>
              <dd className={`truncate ${permTier === "full" ? "text-caution-text" : "text-l1"}`}>
                {permText}
                {permFollowsLocal && cliPermissionNote && (
                  <span className="ml-1 text-l4">（本机设置）</span>
                )}
              </dd>
              <dt className="text-l4">目录</dt>
              <dd className="truncate text-l2" title={cwd}>
                {cwd}
              </dd>
              {selectedProfile && Object.keys(selectedProfile.extraEnv ?? {}).length > 0 && (
                <>
                  <dt className="text-l4">附加变量</dt>
                  <dd
                    className="truncate text-l2"
                    title={`附加环境变量（值不显示）：${Object.keys(selectedProfile.extraEnv).join("、")}`}
                  >
                    {Object.keys(selectedProfile.extraEnv).join("、")}
                  </dd>
                </>
              )}
            </dl>
            {onPatchLaunch && !customRuntimeId && (
              <div className="mx-1 border-t border-hairline px-1 pb-1.5 pt-1.5">
                <div className="mb-1 text-xs text-l3">
                  换权限
                  <span className="ml-1.5 text-micro text-l4">会停下 Agent，带新权限接回这段对话</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {PERMISSION_TIERS.map((t) => {
                    const ok = permAvailable(t.id);
                    const current = t.id === permTier;
                    const busy = attention === "working";
                    return (
                      <button
                        key={t.id}
                        type="button"
                        disabled={!ok || current || busy}
                        title={
                          !ok
                            ? `${agentLabel(agentId)} 没有这一档的启动参数`
                            : busy
                              ? "正在生成，等这一轮结束再换权限"
                              : t.desc
                        }
                        onClick={() =>
                          void (async () => {
                            if (!(await pickLaunchPermission(t.id, true))) return;
                            setLaunchInfoOpen(false);
                            // 先让新权限写进标签、下一拍再重开：重开时读的是新 props（同聊天层）
                            window.setTimeout(restartWithPermission, 0);
                          })()
                        }
                        className={`h-6 rounded-md px-2 text-xs disabled:cursor-default ${
                          current
                            ? `bg-seg-sel ${t.id === "full" ? "text-caution-text" : "text-l1"}`
                            : `border border-hairline hover:bg-hover disabled:opacity-40 disabled:hover:bg-transparent ${
                                t.id === "full" ? "text-caution-text" : "text-l2 hover:text-l1"
                              }`
                        }`}
                      >
                        {t.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {linkedSessionId && launchInfoAlternatives.length > 0 && (
              <div className="mx-1 border-t border-hairline px-1 pb-0.5 pt-1.5">
                <div className="mb-0.5 text-xs text-l3">
                  换连接接着聊
                  <span className="ml-1.5 text-micro text-l4">聊过的内容不会丢</span>
                </div>
                <ul>
                  {launchInfoAlternatives.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() =>
                          void (async () => {
                            const ok = await confirmDialog(
                              `换到「${p.name}」接着这段对话？\n\nMesa 会停下 ${agentLabel(agentId)}，换成这条连接后接回原来这段对话，聊过的内容不会丢。${
                                model.trim() && !p.models.includes(model.trim()) && p.models[0]
                                  ? `\n\n这条连接里没有 ${model.trim()}，会改用 ${p.models[0]}。`
                                  : ""
                              }`,
                              { confirmText: "换连接" },
                            );
                            if (!ok) return;
                            setLaunchInfoOpen(false);
                            switchConnection(p.id);
                          })()
                        }
                        className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-lg px-1.5 text-left text-xs text-l2 hover:bg-hover hover:text-l1"
                      >
                        <span className="truncate">{p.name}</span>
                        {p.models[0] && <span className="truncate text-l4">{p.models[0]}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </>
      )}
      {activePtyId && insertMenuFrom === "tab" && (
        <>
          <button
            type="button"
            aria-label="关闭插入菜单"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setInsertMenuFrom(null)}
          />
          {/* 贴标签栏 ✦ 按钮下沿弹出（原先钉在窗口右上角，离按钮很远）；右缘留 12px 不出屏 */}
          <ul
            className="fixed z-50 max-h-72 w-72 overflow-auto rounded-md border border-field ccode-float-surface p-1"
            style={{
              left: Math.max(
                8,
                Math.min(
                  insertTabAnchor?.left ?? window.innerWidth - 300,
                  window.innerWidth - 300,
                ),
              ),
              top: (insertTabAnchor?.bottom ?? 44) + 4,
            }}
          >
            {renderInsertItems()}
          </ul>
        </>
      )}
      {/* 底栏在会话运行中也保持可见（v3.213 运行态 = 收缩行）：运行中要能点到
          修改/插入/⋯（转为项目…、停止都在里面）。顶部高度归零是
          design-embedded-terminal.md 方案 C（PR4）的形态——portal 与底栏身份
          没做之前不得提前藏整条栏（2026-10-08 回归修复：activePtyId 一挂就把
          ⋯ 全藏掉，快速开聊转正出口在会话存活期间不可达）。 */}
      {embedInPeek ? null : barExpanded ? (
        <>
          <div className="mb-1 flex min-w-0 flex-wrap items-start gap-x-1.5 gap-y-2">
            {/* Agent/配置/模型收进同一条分段工具条：段间留空隙各自成胶囊。
                菜单从按钮下沿向下展开（系统 select 会把当前项钉在按钮上、整单往上长）。 */}
            <div className="flex w-fit min-w-0 max-w-full flex-[0_1_auto] items-center gap-1 overflow-hidden rounded-md border border-field bg-inset p-0.5">
            <LaunchMenu
              label="Agent"
              value={agentId}
              placeholder="选择 Agent"
              options={AGENTS.map((a) => ({ value: a.id, label: a.label }))}
              disabled={running}
              open={openPick === "agent"}
              onOpenChange={(next) => {
                setOpenPick(next ? "agent" : null);
                if (next) setModelOpen(false);
              }}
              onChange={pickLaunchAgent}
              className={`${seg} w-[clamp(7.5rem,12vw,10rem)] min-w-[7.5rem] max-w-[10rem] shrink`}
            />
            <LaunchMenu
              label="配置"
              value={profileId}
              placeholder="选择配置"
              options={profileMenuOptions}
              emptyHint="还没有配置"
              disabled={running}
              open={openPick === "profile"}
              onOpenChange={(next) => {
                setOpenPick(next ? "profile" : null);
                if (next) setModelOpen(false);
              }}
              onChange={pickLaunchProfile}
              buttonRef={profileSelectRef}
              className={`${seg} w-[clamp(6.5rem,12vw,9rem)] min-w-[6.5rem] max-w-[9rem] shrink`}
            />
            {selectedProfile && (
              // 模型 combo-box：可输可选（profile 预设 + 本 Agent 历史），输入即筛选，
              // 自由输入的模型启动成功后记入历史（ccode.modelHistory.<agent>.<连接>），下次直接可选
              <>
              <span
                ref={modelAnchorRef}
                className="flex w-[clamp(10rem,22vw,18rem)] min-w-[9rem] max-w-[18rem] shrink items-center"
              >
                <input
                  className={`${seg} min-w-0 flex-1`}
                  value={model}
                  /* 长模型 id（deepseek-v4-flash-0731 这类）会被这格宽度截断，
                     而输入框是横向滚动的、没有省略号，截掉的部分看不出"还有"。
                     title 给出完整值：悬停即可读全，不用点进去按 Home/End 挪光标。 */
                  title={model || "选择或输入本次启动使用的模型"}
                  onChange={(e) => {
                    setModel(e.target.value);
                    setModelKept(false);
                    setOpenPick(null);
                    setModelOpen(true);
                  }}
                  onFocus={() => {
                    setOpenPick(null);
                    setModelOpen(true);
                  }}
                  onBlur={() => setModelOpen(false)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" || e.key === "Enter")
                      setModelOpen(false);
                  }}
                  placeholder="模型，可输入"
                  disabled={running}
                />
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label="展开模型列表"
                  disabled={running || modelOptions.length === 0}
                  className="mr-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-l4 hover:bg-hover hover:text-l2 disabled:opacity-40"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setOpenPick(null);
                    setModelOpen((v) => !v);
                  }}
                >
                  <ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" />
                </button>
                <DownMenu
                  box={
                    modelMenuBox &&
                    modelOptions.some((m) =>
                      m.toLowerCase().includes(model.trim().toLowerCase()),
                    )
                      ? modelMenuBox
                      : null
                  }
                  exiting={modelMenuExiting}
                  id={`mesa-launch-model-menu-${tabId}`}
                  labelledBy="模型"
                >
                  <ul>
                    {modelOptions
                      .filter((m) =>
                        m.toLowerCase().includes(model.trim().toLowerCase()),
                      )
                      .map((m) => (
                        <li key={m}>
                          <button
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              setModel(m);
                              setModelKept(false);
                              modelMenuCloseNow();
                              setModelOpen(false);
                            }}
                            className={`flex h-8 w-full items-center truncate px-2.5 text-left text-sm ${
                              m === model
                                ? "bg-hover text-l1"
                                : "text-l2 hover:bg-hover hover:text-l1"
                            }`}
                          >
                            {m}
                          </button>
                        </li>
                      ))}
                  </ul>
                </DownMenu>
              </span>
              </>
            )}
            {/* 思考 / 权限两格（2026-10-18 与聊天输入框同步）：原先只在聊天层能选，终端里点运行照样生效却看不见 */}
            {selectedProfile && launchPick.effortLevels.length > 0 && onPatchLaunch && (
              <LaunchMenu
                label="思考"
                value={launchPick.effort}
                placeholder="默认"
                options={[
                  { value: "", label: "默认", title: "按连接给这个模型设的思考档" },
                  ...launchPick.effortLevels.map((l) => ({ value: l, label: l })),
                ]}
                disabled={running}
                open={openPick === "effort"}
                onOpenChange={(next) => {
                  setOpenPick(next ? "effort" : null);
                  if (next) setModelOpen(false);
                }}
                onChange={(v) => onPatchLaunch(tabId, { effort: v || null })}
                preferredWidth={180}
                className={`${seg} w-[clamp(5rem,8vw,6.5rem)] min-w-[5rem] max-w-[6.5rem] shrink`}
              />
            )}
            {!customRuntimeId && onPatchLaunch && (
              <LaunchMenu
                label="权限"
                value={permTier}
                placeholder={permText}
                options={permOptions}
                disabled={running}
                open={openPick === "permission"}
                onOpenChange={(next) => {
                  setOpenPick(next ? "permission" : null);
                  if (next) setModelOpen(false);
                }}
                onChange={(v) => void pickLaunchPermission(v as PermissionTier, false)}
                preferredWidth={220}
                className={`${
                  permTier === "full" ? seg.replace("text-l2", "text-caution-text") : seg
                } w-[clamp(6rem,9vw,7.5rem)] min-w-[6rem] max-w-[7.5rem] shrink`}
              />
            )}
            </div>
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {/* 未启动欢迎态不渲染「插入」：一键注入的落点（首条指令）此时默认折叠、
                  MCP 提及没有输入框可进；启动后的收缩栏保留（v3.213 口径不变） */}
              {!welcomeVisible && renderInsertMenu(false, true)}
              {/* 欢迎卡可见时不渲染第二个「运行」：卡片主按钮是唯一主动作（⌘↵ 仍可用），
                  同视野双主按钮是页面显乱的根源；运行中显示「停止」，
                  shell 面板态（无欢迎卡）才保留启动钮 */}
              {!shellOnly &&
                (running || !welcomeVisible) &&
                (running ? (
                  <button
                    onClick={stop}
                    className="inline-flex h-8 shrink-0 items-center justify-center rounded-md border border-field bg-inset px-3 text-sm text-err-text hover:bg-hover"
                  >
                    停止
                  </button>
                ) : (
                  <button
                    onClick={() => (restored && !customRuntimeId ? void restoreTask() : void launch())}
                    disabled={!profileId || !!profiles.find((p) => p.id === profileId)?.slotMissing}
                    className="inline-flex h-8 shrink-0 items-center justify-center rounded-md border border-cta-bd bg-cta px-3 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
                  >
                    {restored && !customRuntimeId ? "恢复任务" : "运行"}
                  </button>
                ))}
              <button
                type="button"
                onClick={openTerminalActionMenu}
                title="更多终端操作"
                aria-label="更多终端操作"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sm text-l3 hover:bg-hover hover:text-l1"
              >
                ⋯
              </button>
            </span>
            {/* 模型相关的异常提示独占下一行，不挤压右侧动作组。 */}
            {(() => {
              const prof = profiles.find((p) => p.id === profileId);
              const emptyModels =
                !!prof && prof.models.length === 0 && !model.trim();
              const odd = model.trim() !== "" && !looksLikeModelId(model);
              const line = modelKept
                ? "不在这个配置的模型列表里，仍按原样用。"
                : emptyModels
                  ? "这个配置没填模型，会用 CLI 自己的默认值。"
                  : odd
                    ? "这串不太像模型名，确认一下。"
                    : null;
              return line ? (
                <span
                    className={`order-last w-full truncate text-micro leading-4 ${
                    modelKept || emptyModels || odd ? "text-warn-text" : "text-l4"
                  }`}
                >
                  {line}
                </span>
              ) : null;
            })()}
          </div>
          {advancedLaunchOpen ? (
            <div className="mb-2 rounded-md ccode-well px-2.5 py-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="shrink-0 text-xs text-l3">高级启动选项</span>
                {!showPrompt && !shellOnly && (
                  <button
                    type="button"
                    className="ml-auto h-7 rounded-sm px-2 text-micro text-l4 hover:bg-hover hover:text-l2"
                    onClick={() => setShowPrompt(true)}
                  >
                    添加首条指令
                  </button>
                )}
              </div>
              {/* 一键开步的首条指令：可编辑，留空 = 不注入；注入成功即清除。 */}
              {showPrompt && !shellOnly && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="shrink-0 text-xs text-l3">启动后自动发送：</span>
                  <input
                    className={`${select} min-w-0 flex-1 py-1 text-xs`}
                    value={promptText}
                    onChange={(e) => setPromptText(e.target.value)}
                    placeholder="留空则不注入首条指令"
                    disabled={running}
                  />
                  {running && promptText.trim() && (
                    <button
                      type="button"
                      title="复制指令到剪贴板"
                      onClick={() =>
                        void navigator.clipboard.writeText(promptText).catch(() => {})
                      }
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-sm text-l3 hover:bg-hover hover:text-l1"
                    >
                      ⧉
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : null}
          {/* 第二行（状态提示行）有内容才渲染；⋯ 已挪到第一行末尾（v3.92） */}
          {showBarMeta && (
          <div className="mb-1 flex min-h-0 flex-wrap items-center gap-2 text-xs">
            {initialExtraEnv && Object.keys(initialExtraEnv).length > 0 && (
              <span
                className="text-l4"
                title={`启动时注入：\n${Object.entries(initialExtraEnv)
                  .map(([k, v]) => `${k}=${v}`)
                  .join("\n")}`}
              >
                工作区 · 端口段已注入
              </span>
            )}
            {shellActive && !running && (
              <span className="text-l3">shell 模式</span>
            )}
            {exited && !running && !shellActive && exitSummary && (
              <span
                className={exitToneClass(exitSummary.tone)}
                title={
                  exitSummary.code === null
                    ? "结束原因未知：手动停止、进程回收或回收超时"
                    : `退出码 ${exitSummary.code}`
                }
              >
                进程{exitSummary.label}
              </span>
            )}
            {cwdIssue && (
              <span className="truncate text-warn-text" title={cwdIssue}>
                {directoryUnavailableMessage(cwdIssue)}
              </span>
            )}
            {error && <span className="truncate text-err-text">{error}</span>}
            {!error && notice && (
              <span className="truncate text-l3">{notice}</span>
            )}
          </div>
          )}
          {/* 无配置的引导统一收进空态卡片（v3.92：卡片给「去配置页创建」动作；
              不再在启动栏里渲染整段 EmptyState——那条 min-h-48 灰带与卡片重复且视觉断裂） */}
          {autoStart &&
            profileId &&
            !profiles.some((p) => p.id === profileId) && (
              <p className="mb-2 text-sm text-l3">请先为该 Agent 创建配置</p>
            )}
        </>
      ) : compactBarHidden && !compactBarUrgent ? null : (
        /* 收缩态只保留启动配置入口；聊天统一从主工作区进入。 */
        <div className="mt-1 mb-1 flex h-7 items-center gap-2 text-xs text-l4">
          {/* 身份这一行本身就是入口（2026-10-18：原先右边另有「本次 / 修改」按钮，和这行字说的是同一件事）：
              有进程时打开「这次启动」卡（看连接 / 模型 / 思考 / 权限，可换权限、换连接接着聊），没进程时展开启动栏 */}
          <button
            type="button"
            onClick={() => {
              // 已有进程时只开浮层。展开整条栏会把 xterm 垫高，
              // Ink 回合中不重排，输入行停在半截。
              if (ptyIdRef.current) setLaunchInfoOpen(true);
              else setBarExpanded(true);
            }}
            title={
              ptyIdRef.current
                ? "这次启动：连接、模型、思考档、权限；可换权限、换连接接着聊"
                : "修改启动配置"
            }
            className="-ml-1 min-w-0 truncate rounded-sm px-1 py-0.5 text-left text-l4 hover:bg-hover hover:text-l2"
          >
            {agentLabel(agentId)}
            {selectedProfile ? ` · ${selectedProfile.name}` : ""}
            {model ? ` · ${model}` : ""}
            {` · ${basename(cwd)}`}
            {gitTotals && (gitTotals.add > 0 || gitTotals.del > 0) && (
              <span
                className="ml-1 font-mono"
                title="变更（git diff vs HEAD / 任务累计）"
              >
                <span className="text-add">+{gitTotals.add}</span>
                <span className="text-del">-{gitTotals.del}</span>
              </span>
            )}
            {shellActive && !running ? " · shell 模式" : ""}
            {exited && !running && !shellActive
              ? ` · ${exitSummary ? `进程${exitSummary.label}` : "已退出"}`
              : ""}
            {restored && !customRuntimeId && !running && !shellActive ? " · 上次任务，可恢复" : ""}
            {restored && customRuntimeId && !running && !shellActive ? " · 自定义 Runtime 不支持恢复" : ""}
          </button>
          {error ? (
            <span className="truncate text-err-text">{error}</span>
          ) : notice ? (
            <span className="truncate text-l3">{notice}</span>
          ) : null}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {/* 技能/MCP「插入」：进程活着时入口在当前标签的 ✦（标签栏），这一行不再摆第二个；
                没有进程（已退出/可恢复）时才在这里，注入落进首条指令。 */}
            {!activePtyId && renderInsertMenu(false, true)}
            <button
              type="button"
              onClick={openTerminalActionMenu}
              title="更多终端操作"
              aria-label="更多终端操作"
              className="flex h-7 w-7 items-center justify-center rounded-sm text-sm text-l3 hover:bg-hover hover:text-l1"
            >
              ⋯
            </button>
            {onToggleCompactBar && (
              <button
                type="button"
                onClick={onToggleCompactBar}
                title="收起此行（底部状态栏仍有身份信息；顶部对话头可召回）"
                aria-label="收起启动配置行"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-l3 hover:bg-hover hover:text-l1"
              >
                <PanelTopClose size={14} strokeWidth={1.8} aria-hidden="true" />
              </button>
            )}
          </span>
        </div>
      )}
      {/* 只有解出图片文件头才预览（MIME 按文件头判定）。新进程/重置时清掉，也可手动关。 */}
      {inlineImageUrl && (
        <div className="ccode-float-surface absolute bottom-10 right-8 z-20 max-h-40 max-w-[16rem] overflow-hidden rounded-md border border-field bg-raised p-1">
          <div className="relative">
            <img
              src={inlineImageUrl}
              alt="终端贴图"
              className="block max-h-36 max-w-full object-contain"
            />
            <button
              type="button"
              onClick={() => setInlineImageUrl(null)}
              title="关闭预览"
              className="absolute right-0.5 top-0.5 rounded-sm bg-strip/90 px-1 text-micro text-l2 hover:bg-hover hover:text-l1"
            >
              ✕
            </button>
          </div>
        </div>
      )}
      {searchOpen && !coveredByChat && (
        <div data-terminal-search className="absolute left-3 top-2 z-30 flex flex-col items-start gap-1 rounded-md border border-field bg-strip px-2 py-1">
          <div className="flex items-center gap-1">
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                queueIncrementalSearch(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (e.shiftKey) findPrev();
                  else findNext();
                } else if (e.key === "ArrowUp") {
                  // 单行输入框里 ↑ 本就只做「光标归位」，没有编辑语义——拿来做上一条匹配
                  e.preventDefault();
                  findPrev();
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  findNext();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  closeSearch();
                }
              }}
              placeholder="查找终端输出"
              className="w-56 rounded-sm border border-field bg-inset px-2 py-1 text-sm text-l2 outline-none placeholder:text-l4 focus:border-l4"
            />
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={findPrev}
              title="上一个（Shift+Enter 或 ↑）"
              className="flex h-7 w-7 items-center justify-center rounded-sm text-sm text-l3 hover:bg-hover hover:text-l1"
            >
              ↑
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => findNext()}
              title="下一个（Enter 或 ↓）"
              className="flex h-7 w-7 items-center justify-center rounded-sm text-sm text-l3 hover:bg-hover hover:text-l1"
            >
              ↓
            </button>
            <button
              onClick={closeSearch}
              title="关闭（Esc）"
              className="flex h-7 w-7 items-center justify-center rounded-sm text-sm text-l3 hover:bg-hover hover:text-l1"
            >
              ×
            </button>
            {/* 命中计数：搜不到时给「没有」的明确反馈，分不清「没有」还是「没生效」 */}
            {searchQuery && (
              <span className="w-14 shrink-0 text-center text-micro text-l4">
                {searchNote
                  ? "—"
                  : searchResults
                    ? searchResults.count === 0
                      ? "无结果"
                      : `${searchResults.index + 1}/${searchResults.count}`
                    : ""}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {(
              [
                ["Aa", "区分大小写", searchCase, () => setSearchCase((v) => !v)],
                ["全词", "整词匹配", searchWord, () => setSearchWord((v) => !v)],
                [".*", "正则（如 Error|失败）", searchRegex, () => setSearchRegex((v) => !v)],
              ] as const
            ).map(([label, title, on, toggle]) => (
              <button
                key={label}
                type="button"
                title={title}
                onMouseDown={(e) => e.preventDefault()}
                onClick={toggle}
                className={`flex min-h-7 items-center rounded-sm px-1.5 text-micro ${
                  on
                    ? "bg-seg-sel text-l1"
                    : "text-l3 hover:bg-hover hover:text-l1"
                }`}
              >
                {label}
              </button>
            ))}
            {searchNote && <span className="truncate text-micro text-err-text">{searchNote}</span>}
          </div>
          {/* 全屏 TUI 跑在备用屏上，没有回滚缓冲可查：不说明的话 ↑↓ 只在屏幕内
              打转会被当成查找坏了。nowrap + 字数控制在输入行宽度内——浮条宽度由
              最宽的子项决定，提示比输入行还宽会把整个浮条撑开 */}
          {altBufferActive && (
            <div className="whitespace-nowrap text-xs text-l4">
              全屏程序内没有可回看的输出，查找只在本屏生效
            </div>
          )}
        </div>
      )}
      {/* 有状态栏：只圆上沿，和状态栏的下圆角拼成一张卡。
          没有状态栏：画面自己四角都圆。 */}
      <div
        className={`relative flex min-h-0 flex-1 overflow-hidden ${
          statusBarOn ? "rounded-t-xl" : "rounded-xl"
        }`}
        style={{ background: termBg }}
      >
        <div
          ref={containerRef}
          // 阅读区打开期间由 TerminalPage 按此标记把本节点搬进覆盖层右栏（DOM 搬移不重建）
          data-terminal-host={tabId}
          className="min-w-0 flex-1 overflow-hidden px-3 py-2.5"
          // 聊天层盖住时跳过绘制：xterm 按 IntersectionObserver 判可见，content-visibility: hidden 让它停画、
          // 揭开时整屏重画一次；visibility: hidden 停不了（WKWebView 实测）。尺寸不变、行列数不变，
          // 缓冲照常解析，读屏（信任菜单 / 实时回复 / 连接错误）不受影响
          style={coveredByChat ? { contentVisibility: "hidden" } : undefined}
          onContextMenu={(e) => {
            e.preventDefault();
            setTermCtxMenu({ x: e.clientX, y: e.clientY });
          }}
        />
        {/* 连接出问题（conn-issue.ts）：盖在画面顶上（absolute，不改终端行数），按钮与聊天层确认卡同一个动作。
            只在整块终端露着时画：聊天层盖着（或终端只在聊天下方窥视）时聊天里已有同一张卡，这条横条 z-30 会浮在聊天层上面，
            同一件事顶上一条、底下一张（2026-10-28 用户截图） */}
        {connIssue && fullTerminal && (
          <div
            role="alert"
            className="absolute inset-x-3 top-2 z-30 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-field ccode-float-surface px-2.5 py-1.5 text-xs"
          >
            <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-warn-text" />
            <span className="font-medium text-l1">{connIssue.text}</span>
            <span className="min-w-0 flex-1 truncate text-l3" title={connIssue.detail}>
              {connIssue.detail}
            </span>
            {connIssue.alternatives.length > 0 ? (
              <span className="flex shrink-0 items-center gap-1">
                <select
                  aria-label="换到哪条连接"
                  value={
                    connIssue.alternatives.some((a) => a.profileId === connPick)
                      ? connPick
                      : connIssue.alternatives[0].profileId
                  }
                  onChange={(e) => setConnPick(e.target.value)}
                  className="h-6 max-w-[14rem] rounded-sm border border-field bg-inset px-1 text-xs text-l2"
                >
                  {connIssue.alternatives.map((a) => (
                    <option key={a.profileId} value={a.profileId}>
                      {a.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() =>
                    switchConnection(
                      connIssue.alternatives.some((a) => a.profileId === connPick)
                        ? connPick
                        : connIssue.alternatives[0].profileId,
                    )
                  }
                  title="停下 AI，换成这条连接，再接回原来这段对话"
                  className="h-6 rounded-sm bg-cta px-2 text-xs text-cta-text hover:opacity-90"
                >
                  换这条接着聊
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setPage("profiles")}
                className="h-6 shrink-0 rounded-sm px-2 text-xs text-l2 hover:bg-hover"
                title="这家 AI 没有别的可用连接"
              >
                去连接页添加一条
              </button>
            )}
            <button
              type="button"
              onClick={dismissConnIssue}
              aria-label="关闭提示"
              className="h-6 shrink-0 rounded-sm px-1.5 text-l4 hover:bg-hover hover:text-l2"
            >
              ✕
            </button>
          </div>
        )}
        {/* Grok 卡在续期官方登录上（grok_login.rs）：同连接出问题的提示条，按钮与聊天层确认卡同一个动作 */}
        {grokLoginStuck && !connIssue && (
          <div
            role="alert"
            className="absolute inset-x-3 top-2 z-30 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-field ccode-float-surface px-2.5 py-1.5 text-xs"
          >
            <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-warn-text" />
            <span className="font-medium text-l1">Grok 卡在续期官方登录上，消息发不出去</span>
            <span className="min-w-0 flex-1 truncate text-l3" title="这台电脑存着一个已过期的 xAI 官方登录，连不上 auth.x.ai 续期">
              这台电脑存着一个已过期的 xAI 官方登录，连不上 auth.x.ai 续期
            </span>
            <button
              type="button"
              onClick={grokLogout}
              title="停下 Grok，运行 grok logout，再接回原来这段对话"
              className="h-6 shrink-0 rounded-sm bg-cta px-2 text-xs text-cta-text hover:opacity-90"
            >
              退出官方登录
            </button>
            <button
              type="button"
              onClick={dismissGrokLogin}
              aria-label="关闭提示"
              className="h-6 shrink-0 rounded-sm px-1.5 text-l4 hover:bg-hover hover:text-l2"
            >
              ✕
            </button>
          </div>
        )}
        {/* 粘贴图片/拖入文件的瞬态轻反馈（不挡画布，3s 自消） */}
        {inputNote && (
          <div className="pointer-events-none absolute bottom-3 right-4 z-20 max-w-[80%] truncate rounded-sm border border-field ccode-float-surface px-2 py-1 text-xs text-l2">
            {inputNote}
          </div>
        )}
        {termPick && (
          <div
            className="absolute z-30 flex gap-1 rounded-md border border-field bg-raised p-1"
            style={{ left: termPick.x, top: termPick.y }}
            onMouseDown={(event) => event.preventDefault()}
          >
            <button
              type="button"
              className="rounded-sm px-2 py-1 text-xs text-l1 hover:bg-hover"
              onClick={() => {
                void navigator.clipboard.writeText(termPick.text).then(
                  () => {
                    flashInputNote("已复制");
                    termRef.current?.clearSelection();
                  },
                  () => flashInputNote("复制失败"),
                );
              }}
            >
              复制
            </button>
            <button
              type="button"
              className="rounded-sm px-2 py-1 text-xs text-l1 hover:bg-hover"
              title="去掉标题、加粗、链接这些标记，只留字"
              onClick={() => {
                void navigator.clipboard.writeText(markdownToPlain(termPick.text)).then(
                  () => {
                    flashInputNote("已复制文本");
                    termRef.current?.clearSelection();
                  },
                  () => flashInputNote("复制失败"),
                );
              }}
            >
              复制文本
            </button>
            <button
              type="button"
              className="rounded-sm px-2 py-1 text-xs text-l1 hover:bg-hover"
              onClick={() => {
                setTermPickView(termPick.text);
                termRef.current?.clearSelection();
              }}
            >
              查看
            </button>
            {canHandToChat && (
              <>
                <span className="mx-0.5 w-px self-stretch bg-hairline" aria-hidden="true" />
                <button
                  type="button"
                  className="rounded-sm px-2 py-1 text-xs text-l1 hover:bg-hover"
                  title="把选中的这段加上引用符号放进输入框，接着写你的话"
                  onClick={() => handSelectionToChat(termPick.text, false)}
                >
                  引用
                </button>
                <button
                  type="button"
                  className="rounded-sm px-2 py-1 text-xs text-l1 hover:bg-hover"
                  title="带着这段直接问这里的 AI「这是什么意思」"
                  onClick={() => handSelectionToChat(termPick.text, true)}
                >
                  问 AI
                </button>
              </>
            )}
            {clipRoot && (
              <button
                type="button"
                className="rounded-sm px-2 py-1 text-xs text-l1 hover:bg-hover"
                title="追加到这个项目的 notes/clips.md"
                onClick={() => void saveSelectionClip(termPick.text)}
              >
                存进笔记
              </button>
            )}
          </div>
        )}
        {/* 未启动空态引导（v3.91 / v3.213）：画布中央一张卡，只回答「在这个目录运行」。
            身份（agent / 配置 / 模型）只活在启动栏，不在卡上再说一遍。
            xterm 保持挂载在底层（移树会杀 PTY 语义）；浮层壳 pointer-events-none 不挡画布 */}
        {welcomeVisible && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            {/* 内容井 + 极浅勾边（v3.213：去掉玻璃拟态和大投影——浅色空画布上
                blur 无物可透，shadow-lg 像登录卡）。勾边仍用 l1 12% 混合。
                无顶部图标盒、无说明小字；卡片 w-80，主按钮 min-w-40 自适应。 */}
            <div
              className="ccode-well pointer-events-auto relative flex w-80 flex-col items-center gap-3 rounded-lg border px-5 py-5 text-center"
              style={{
                borderColor:
                  "color-mix(in srgb, var(--color-l1) 12%, transparent)",
              }}
            >
              {cwdIssue && (
                <div className="w-full rounded-md border border-field ccode-well px-3 py-2 text-left text-xs">
                  <div className="font-medium text-warn-text">工作目录不可用</div>
                  <div className="mt-1 truncate font-mono text-micro text-l3" title={cwdIssue}>
                    {cwdIssue}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => void chooseWorkingDirectory()}
                      disabled={cwdChecking}
                      className="rounded-sm border border-cta-bd bg-cta px-2 py-1 text-micro text-cta-text disabled:opacity-50"
                    >
                      选择新目录
                    </button>
                    <button
                      type="button"
                      onClick={() => void returnToHomeDirectory()}
                      disabled={cwdChecking}
                      className="rounded-sm border border-field bg-inset px-2 py-1 text-micro text-l2 disabled:opacity-50"
                    >
                      回到主目录
                    </button>
                    <button
                      type="button"
                      onClick={() => void checkWorkingDirectory()}
                      disabled={cwdChecking}
                      className="rounded-sm px-2 py-1 text-micro text-l3 hover:bg-hover disabled:opacity-50"
                    >
                      {cwdChecking ? "检查中…" : "重新检查"}
                    </button>
                  </div>
                </div>
              )}
              <button
                type="button"
                onClick={(event) => {
                  // 有家目录才能拼出随手聊/主目录候选；问不到时退回系统选目录窗
                  if (!homeDir) {
                    void chooseWorkingDirectory();
                    return;
                  }
                  const r = event.currentTarget.getBoundingClientRect();
                  setWelcomeDirMenu({ x: r.left, y: r.bottom + 4 });
                }}
                disabled={cwdChecking}
                aria-haspopup="menu"
                title={`${cwd === "~" && homeDir ? homeDir : cwd}\n点击换目录`}
                className="flex max-w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 font-mono text-xs text-l3 hover:bg-hover hover:text-l1 disabled:cursor-default disabled:opacity-50"
              >
                <FolderOpen
                  size={13}
                  strokeWidth={1.8}
                  className="shrink-0 text-l4"
                  aria-hidden="true"
                />
                {/* 图标 + 文字改成 inline-flex 后，省略号要落在文字这一格上：
                    按钮自身不带 truncate（它现在还要容纳图标），给文字套一层 min-w-0。 */}
                <span className="min-w-0 truncate">
                  {welcomeCwdActionLabel(cwd, homeDir, !!restored, IS_WINDOWS)}
                </span>
              </button>
              {agentProfiles.length === 0 ? (
                /* 无配置时主按钮换成有效引导（禁用的「启动」是死按钮，v3.92 修） */
                <button
                  type="button"
                  onClick={() => setPage("profiles")}
                  className="inline-flex h-9 min-w-40 cursor-pointer items-center justify-center rounded-md border border-cta-bd bg-cta px-5 text-sm text-cta-text hover:brightness-110"
                >
                  去连接页
                </button>
              ) : (
                <>
                  {/* 2026-10-18 用户：快速开聊落到聊天层、终端这一面像没启动的坏标签。说清楚它在等什么 */}
                  {!(restored && !customRuntimeId) && (
                    <p className="text-xs text-l3">在聊天里发出第一句时自动运行</p>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      restored && !customRuntimeId ? void restoreTask() : void launch()
                    }
                    disabled={!profileId || cwdChecking || !!profiles.find((p) => p.id === profileId)?.slotMissing}
                    className="inline-flex h-9 min-w-40 cursor-pointer items-center justify-center gap-2 rounded-md border border-cta-bd bg-cta px-5 text-sm text-cta-text hover:brightness-110 disabled:cursor-default disabled:opacity-50"
                  >
                    {restored && !customRuntimeId ? "恢复任务" : "现在运行"}
                    {/* 快捷键说明：括号小字随按钮文字整体居中，不加胶囊底色
                        （18% 混合底在纯色按钮上是块显眼补丁，用户否为「色差」）；勿绝对定位钉右缘 */}
                    <span className="text-micro opacity-80">
                      （{IS_MAC ? "⌘ + Enter" : "Ctrl + Enter"}）
                    </span>
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => void openShell()}
                className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs text-l4 hover:bg-hover hover:text-l2"
              >
                打开普通 Shell
              </button>
            </div>
          </div>
        )}
      </div>
      {terminalActionMenu && (
        <ContextMenu
          x={terminalActionMenu.x}
          y={terminalActionMenu.y}
          onClose={() => setTerminalActionMenu(null)}
          items={terminalMenuItems}
        />
      )}
      {welcomeDirMenu && (
        <ContextMenu
          x={welcomeDirMenu.x}
          y={welcomeDirMenu.y}
          onClose={() => setWelcomeDirMenu(null)}
          items={[
            ...welcomeDirChoices({
              cwd,
              home: homeDir,
              projectPaths: storeProjectPaths,
              recentRepos: storeRecentRepos,
              isWindows: IS_WINDOWS,
            }).map((choice) => ({
              label: choice.label,
              checked: choice.current,
              title: choice.path,
              hint: choice.kind === "home" ? "~" : undefined,
              // 与聊天输入框的项目弹层同一个入口：随手聊按需创建，选项目带上项目的对话默认
              onSelect: () => void pickDir({ kind: choice.kind, path: choice.path }),
            })),
            { separator: true },
            {
              icon: FolderOpen,
              label: "选择文件夹…",
              onSelect: () => void chooseWorkingDirectory(),
            },
            {
              icon: FolderPlus,
              label: "新建项目…",
              title: "起个名字建一个新文件夹，定好工作方式后登记为项目（在项目页完成）",
              onSelect: openNewProject,
            },
          ]}
        />
      )}
      {termPickView !== null && (
        <div className="absolute inset-4 z-40 flex flex-col rounded-md border border-field bg-canvas">
          <div className="flex h-8 shrink-0 items-center justify-between border-b border-hairline px-2">
            <span className="text-xs text-l3">选中的文字</span>
            <button
              type="button"
              className="rounded-sm px-2 py-1 text-xs text-l2 hover:bg-hover"
              onClick={() => setTermPickView(null)}
            >
              关闭
            </button>
          </div>
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-3 text-xs text-l1">
            {termPickView}
          </pre>
        </div>
      )}
      {termCtxMenu && (
        <ContextMenu
          x={termCtxMenu.x}
          y={termCtxMenu.y}
          onClose={() => setTermCtxMenu(null)}
          items={termCtxMenuItems}
        />
      )}
    </div>
  );
});
