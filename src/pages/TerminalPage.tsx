import {
  Fragment,
  memo,
  lazy,
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
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as openDirectoryDialog } from "@tauri-apps/plugin-dialog";
import { exit } from "@tauri-apps/plugin-process";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { sessionRuntimeKey, useAppStore } from "../store";
import { IS_MAC, IS_WINDOWS } from "../hotkeys";
import { monoFallbackStack, terminalFontStack } from "../terminal-font";
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
  shouldReportTerminalColors,
  xtermOscColorReport,
} from "../terminal-input";
import {
  consumeHostSequences,
  consumeTerminalQueries,
  encodeKittyKey,
  safeOsc8Url,
} from "../terminal-protocols";
import { hitCellRange, terminalPathHits } from "../terminal-links";
import { pasteGuardPlan } from "../paste-guard";
import type { TerminalProgress } from "../terminal-notify";
import { terminalReplayText } from "../terminal-replay";
import {
  confirmHandoffEvent,
  hasAssistantText,
  mergeConversationPages,
  shouldAutoPeek,
} from "../chat-handoff";
import { AGENTS, type CustomRuntimeDto, type OfficialAccountStatusDto } from "../types";
import { resolveCustomRuntimeCwd } from "../custom-runtime";
import { samePath } from "../path-utils";
import { cwdIsCodingWorktree } from "../coding-git";
import { loadCodingOverview } from "../components/CodingProjectView";
import { normalizeWorkMode } from "../work-mode";
import { exitCodeClause, exitCodeSummary, exitToneClass } from "../exit-code";
import ChatSurface from "../components/ChatSurface";
import { confirmDialog, alertDialog } from "../components/ConfirmDialog";
import ContextMenu from "../components/ContextMenu";
import FileTree, { type DirEntryDto } from "../components/FileTree";
import GitPanel, { type GitSummary } from "../components/GitPanel";
import TerminalStatusBar from "../components/TerminalStatusBar";
import { LoadingRows, hoverRevealClass } from "../components/PageFrame";
import LaunchMenu, {
  DownMenu,
  useDownMenu,
  type LaunchMenuOption,
} from "../components/LaunchMenu";
import ProjectRail from "../components/ProjectRail";
import WorkspaceReviewView from "../components/WorkspaceReviewView";
import ReaderOverlay from "../components/ReaderOverlay";
import { renderTaskMd } from "../pipeline-start";
import { formatPdfExcerptPrompt, readerReuseKey } from "../reader";
import { defaultCommitMessage } from "../git-commit-message";
import { skipDisconnectedOfficial } from "../resume-profile";
import {
  findResumeHolderTab,
  fittedPtySize,
  resolveResumeLaunch,
  shouldRelaunchResumeTab,
} from "../terminal-resume";
import {
  allowSpawn,
  launchChromeBeforeMeasure,
  type ResizeLatch,
} from "../terminal-geometry";
import { toast } from "../toast";
import { ORGANIZE_NOTES_PROMPT } from "../pipeline-presets";
import {
  isUnsafeLitProjectDir,
  notesInboxTarget,
  suggestLitProjectDir,
} from "../lit-project";
import { isPreviewableImagePath } from "../file-icons";
import { XTERM_PALETTES, resolvePaletteId } from "../terminal-palettes";
import { isCustomThemeId, isLightTheme } from "../themes";
import {
  customXtermBgFg,
  DEFAULT_CUSTOM_THEME,
  deriveThemeTokens,
  normalizeCustomTheme,
} from "../custom-theme";
import {
  looksLikeModelId,
  modelOnProfileSwitch,
  officialModelAllowed,
} from "../model-switch";
import { isSoftwareWebGL } from "../diagnostics";
import {
  Columns2,
  Eye,
  EyeOff,
  FolderOpen,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  ChevronDown,
  PanelTopClose,
  PanelTopOpen,
  RefreshCw,
  Search,
  Sparkles,
  SquareTerminal,
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
import { clampTabDragDx, rubberbandTabDx, tabDragTarget } from "../tab-drag";
import { directoryUnavailableMessage } from "../terminal-cwd";
import {
  collapseHomeTreeOnce,
  idleTabTitle,
  isTerminalIdle,
  welcomeCwdActionLabel,
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
import type { RunOverviewInput } from "../run-overview";
import type {
  ChatMessageDto,
  CodingOpDto,
  CodingOverviewDto,
  ConversationPageDto,
  GitCommitResultDto,
  HandoffTargetDto,
  ProjectConfigReadDto,
  ProjectDto,
  SessionMetaDto,
  SkillDto,
  McpServerDto,
  WorkspaceDto,
  WorkspaceHealthDto,
  ChatSendResult,
  SessionSyncState,
  SurfaceMode,
} from "../types";
import type { PdfActionResult } from "../components/PdfPreview";

// Monaco 体积大，首次打开文件预览时才加载
const FilePreviewEditor = lazy(() => import("../components/FilePreviewEditor"));
// pdf.js 同样拆懒加载 chunk，首次打开 PDF 预览时才加载
const PdfContinuousView = lazy(() => import("../components/PdfContinuousView"));

/** 沉浸阅读/写笔记时把 PDF 所在文件夹加成项目（默认不挂研究流程）。取消或失败返回 null。 */
async function offerAddLitProject(
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
      `这份 PDF 还不在任何已添加的项目里。\n沉浸阅读会把笔记写进项目文件夹，需要先添加项目。\n\n将添加：${dir}\n添加后不挂研究流程，只用来读文献、写笔记。`,
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
const DocxPreview = lazy(() => import("../components/DocxPreview"));
const XlsxPreview = lazy(() => import("../components/XlsxPreview"));
const ImagePreview = lazy(() => import("../components/ImagePreview"));

type PtyKind = "agent" | "shell";

/** 主工作区默认面层：新标签未显式切层时落终端（聊天层交互尚未完善），
    分叉聊天等明确聊天意图的入口仍显式置 "chat"，不受默认值影响 */
const DEFAULT_SURFACE_MODE: SurfaceMode = "terminal";
/** 聊天层窥视终端：底栏占主区高度的比例。必须是真实分栏（终端按此高度 fit），
    不能只裁全高 xterm 的底部——Codex 主对话是 inline，内容靠上、底下是空行，裁底就是白板。 */
const CHAT_PEEK_RATIO = 0.32;

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** 归一化后判断 path 是否落在 base 内（含相等），与 FileTree/ProjectRail 的口径一致 */
function pathWithin(path: string, base: string): boolean {
  const p = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const b = base.replace(/\\/g, "/").replace(/\/+$/, "");
  return p === b || p.startsWith(`${b}/`);
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
}

/** TerminalView 暴露给父级的动作表（查找图标 / 聊天发送 / 改目录等；回调经 ref 转发，始终最新） */
export interface FocusTabActions {
  stop: () => void;
  resume: () => void;
  openConversationPage: () => void;
  search: () => void;
  modify: () => void;
  /** 运行中的「插入」在标签栏，菜单本身仍由这个终端画 */
  toggleInsert: () => void;
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
  /** 往 PTY 写一条 TUI 命令并提交（模型/思考档直切；picker 由调用方再窥视终端） */
  writeCommand: (cmd: string) => void;
  /** 用户刚提交一轮（聊天发送 / 注入并回车）：允许随后的 PTY 输出点亮「生成中」 */
  noteUserTurn: () => void;
  /** 聊天层向前翻页（会话文件 cursor；压缩会话可能没有更早一页） */
  loadOlderConversation: () => Promise<void>;
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
  /** 当前 agent 可从聊天界面直接调用的技能 / MCP 资源。 */
  skills: SkillDto[];
  mcps: McpServerDto[];
}

const agentLabel = (id: string) => AGENTS.find((a) => a.id === id)?.label ?? id;

const RIGHT_PANEL_WIDTH_KEY = "ccode.terminalRightWidth";
const RIGHT_PANEL_DEFAULT_WIDTH = 460;
const RIGHT_PANEL_MIN_WIDTH = 360;
// 右栏最大宽度不写死像素：随窗口自由拉宽，只给中带终端保留最小可用宽度
const TERMINAL_MIN_RESERVE = 340;
// 分屏：左 pane 宽度百分比的本地记忆（分屏开关状态本身不持久化）
const SPLIT_PCT_KEY = "ccode.terminalSplitPct";
const SPLIT_MIN_PCT = 20;
const SPLIT_MAX_PCT = 80;
const clampSplitPct = (pct: number) =>
  Math.min(SPLIT_MAX_PCT, Math.max(SPLIT_MIN_PCT, pct));
const RIGHT_TABS = [
  { key: "preview", label: "文件", symbol: "▤" },
  { key: "git", label: "改动", symbol: "⌘" },
] as const;
type RightTab = (typeof RIGHT_TABS)[number]["key"];

/** shell 单引号转义（向 PTY 写 cd 命令用） */
const shQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** 发系统通知：macOS 首次发送前必须显式申请权限（系统级弹窗，仅首次）；被拒则静默跳过。
 *  带「去处理」动作按钮（ccode.attention，App.tsx 注册）；extra 携带 tabId/cwd，
 *  onAction 路由：聚焦对应标签（只有待确认一种通知）。 */
async function fireAttentionNotification(
  title: string,
  body: string,
  extra: { tabId: string; cwd: string },
) {
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  if (!granted) return;
  sendNotification({ title, body, actionTypeId: "ccode.attention", extra });
}

/** 七套深色 + 七套浅色主题对应的 xterm 底色/前景。
 *  深色行与 App.css 的 --color-editor-bg/--color-editor-fg 逐字一致（tests/theme-tokens.test.ts 锁定）。
 *  浅色行**刻意不等同 editor-bg**：editor-bg 是纯白 #ffffff，整屏纯白当终端发刺眼，
 *  故各主题取自己色相的近白（暖纸 / 冷灰 / 淡紫，见 16c456b 的调校），不一概用 #fff。
 *  ANSI 16 色 + 光标 + 选区由调色板预设提供，并按主题亮暗自动取深/浅套
 *  （见 terminal-palettes.ts 的 resolvePaletteId）。 */
const XTERM_BG_FG: Record<string, { background: string; foreground: string }> =
  {
    midnight: { background: "#0e1015", foreground: "#b3b0aa" },
    terracotta: { background: "#2d2d2b", foreground: "#c9c9c4" },
    ayu: { background: "#10141c", foreground: "#bfbdb6" },
    mocha: { background: "#1e1e2e", foreground: "#aeb8dc" },
    neutral: { background: "#111111", foreground: "#c9c9c9" },
    dracula: { background: "#282a36", foreground: "#cfcfc9" },
    shadcn: { background: "#111827", foreground: "#b9b9c0" },
    "midnight-light": { background: "#fbfbf9", foreground: "#3f3c36" },
    "terracotta-light": { background: "#fefcfa", foreground: "#453f3a" },
    "ayu-light": { background: "#fffefd", foreground: "#3f4754" },
    "mocha-light": { background: "#fbfafc", foreground: "#4e4b63" },
    "neutral-light": { background: "#fdfdfd", foreground: "#3a3a3a" },
    "dracula-light": { background: "#fefdff", foreground: "#403a4e" },
    "shadcn-light": { background: "#fefefe", foreground: "#344054" },
  };

/** 终端 16 色调色板预设已抽至 src/terminal-palettes.ts（设置页预览共享） */

/** 底/字色取自主题表，ANSI 16 色 + cursor + selectionBackground 全部由调色板提供。
 *  调色板先经 resolvePaletteId 按主题亮暗解析：浅色主题拿到深色向预设时自动换 twin，
 *  避免近白底上出现 white/brightWhite 隐形、深藏蓝选区压死选中文字。 */
function buildXtermTheme(
  themeId: string,
  paletteId?: string,
  customTheme?: { rail: string; canvas: string; accent: string } | null,
): { background: string; foreground: string } & Record<string, string> {
  const palette =
    XTERM_PALETTES[resolvePaletteId(paletteId, isLightTheme(themeId))];
  const bgfg = isCustomThemeId(themeId)
    ? customXtermBgFg(
        deriveThemeTokens(normalizeCustomTheme(customTheme) ?? DEFAULT_CUSTOM_THEME)
          .tokens,
      )
    : (XTERM_BG_FG[themeId] ?? XTERM_BG_FG.midnight);
  const light = isLightTheme(themeId);
  return {
    ...bgfg,
    ...palette,
    scrollbarSliderBackground: light ? "#3a342c99" : "#ffffff99",
    scrollbarSliderHoverBackground: light ? "#3a342ccc" : "#ffffffcc",
    scrollbarSliderActiveBackground: light ? "#3a342cff" : "#ffffffff",
  };
}

/** 同一 Run 未完成的交互启动：挡住 StrictMode / 连点「运行」抢锁。 */
const interactiveLaunchLocks = new Set<string>();

/** 单个终端：独立持有 xterm 实例、PTY 引用和启动栏状态；隐藏时只 display:none，不杀进程。
 *  memo 化：启动栏自己的状态变化只重渲染本组件，不级联到兄弟标签/文件树/编辑器。 */
const TerminalView = memo(function TerminalView({
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
  resumeProvider,
  autoStart,
  resumeKick,
  prefillCommand,
  shellOnly,
  customRuntimeId,
  initialPrompt: presetPrompt,
  readonly,
  permission,
  effortOverride,
  submitCsiU = false,
  restored,
  stepClaimName,
  reuseKey,
  initialRunId,
  taskId,
  externalCwd,
  onConsumeExternalCwd,
  onStatus,
  onSessionUpdate,
  embedInPeek = false,
  onActions,
  onRestoreComplete,
  onConsumeResume,
  onForkChat,
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
  /** 布局版本号（左栏显隐/分屏/窥视等宽度变化时递增，触发 xterm 重新 fit） */
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
  /** 会话恢复：rollout 记下的 provider */
  resumeProvider?: string;
  /** 首次可见时自动启动（会话恢复；有 profile 才启动，否则只预填） */
  autoStart?: boolean;
  /** 已有 resume 标签但进程不在时，再点「继续」递增以重试启动 */
  resumeKick?: number;
  /** run 脚本：进入 shell 后立即写入的命令行 */
  prefillCommand?: string;
  /** run 脚本标签：挂载后自动开 shell 并执行 prefillCommand（不走 agent 启动流程） */
  shellOnly?: boolean;
  /** 直接启动 Custom Runtime，不经过 shell */
  customRuntimeId?: string;
  /** 一键开步预填的首条指令：启动时注入 CLI，成功后清除（一次性）；留空 = 不注入 */
  initialPrompt?: string;
  /** 「聊想法」只读模式：pty_spawn 透传（支持的 CLI 注入只读/计划模式参数） */
  readonly?: boolean;
  permission?: "discuss" | "write_tree";
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
  /** 最近项目「真进入」：把目标目录注入活动标签的启动栏（TerminalView 消费后清空） */
  externalCwd?: string | null;
  onConsumeExternalCwd?: () => void;
  /** 上报回调带 tabId（父级共享 useCallback，memo 稳定） */
  onStatus: (id: string, s: TabStatus) => void;
  onSessionUpdate: (id: string, s: SessionLinkState) => void;
  /** 聊天窥视底栏：只留 xterm，收起启动栏，让这一栏高度都给 TUI */
  embedInPeek?: boolean;
  /** 向父级注册本标签的动作表（查找图标 / 聊天发送 / 改目录等） */
  onActions?: (id: string, a: FocusTabActions) => void;
  onRestoreComplete?: (id: string) => void;
  /** launch 成功接管会话后通知父级清掉标签级 resumeSessionId（之后「启动」不再接旧会话） */
  onConsumeResume?: (id: string) => void;
  /** 从当前会话摘要开一个只读分叉标签（启动行 ⋯，不进聊天 ＋）。带 tabId：
   *  页面侧可传稳定回调，避免内联箭头击穿 memo(TerminalView)。 */
  onForkChat?: (tabId: string) => void;
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
  // 换 agent 后按「显式默认 > 上次使用 > 该 agent 首个配置」预选（v3.88）。
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
  const selectedProfile = profiles.find(
    (p) => p.id === profileId && p.agent === agentId,
  );
  // 模型 combo：下拉开合状态 + 选项来源（profile 预设 + 本 agent 历史，去重）
  const [modelOpen, setModelOpen] = useState(false);
  // Agent / 配置同时只开一个，且不跟模型清单叠在一起
  const [openPick, setOpenPick] = useState<null | "agent" | "profile">(null);
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
  const modelOptions = useMemo(() => {
    let history: string[] = [];
    try {
      history = JSON.parse(
        localStorage.getItem(`ccode.modelHistory.${agentId}`) ?? "[]",
      ) as string[];
    } catch {
      /* 损坏按空历史 */
    }
    return [
      ...new Set([...(selectedProfile?.models ?? []), ...history]),
    ].filter(Boolean);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, selectedProfile, model]);
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
      const path = await invoke<string>("save_clipboard_image", {
        bytes: Array.from(new Uint8Array(buf)),
        ext: imageExtFromMime(file.type),
      });
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

  // 切走标签（或整页隐藏）时收起搜索条，避免隐藏标签残留查找态
  useEffect(() => {
    if (!visible) {
      setSearchOpen(false);
      setTerminalActionMenu(null);
      setTermCtxMenu(null);
    }
  }, [visible]);

  // 搜索条打开时聚焦输入框并选中已有文本，同时按当前缓冲区类型定一次提示。
  // 订阅只在「切换」时触发：若打开搜索条时已经身处全屏程序里（备屏早已激活），
  // 光靠订阅会一直保持 false，提示就不出现。
  useEffect(() => {
    if (!searchOpen) return;
    searchInputRef.current?.select();
    setAltBufferActive(termRef.current?.buffer.active.type === "alternate");
  }, [searchOpen]);

  // Cmd/Ctrl+F 呼出搜索条：只挂当前可见且活跃的 pane，保证只作用于活跃终端。
  // 终端聚焦时按键经 xterm 的 customKeyEventHandler 拦截（见创建 effect），这里兜底页面其余焦点。
  useEffect(() => {
    if (!visible || !primaryFocus) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        // Monaco 编辑器（文件预览）有自己的查找组件，不劫持
        if (e.target instanceof Element && e.target.closest(".monaco-editor"))
          return;
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, primaryFocus]);

  // —— 当前会话联动（SessionLink）：事件驱动刷新，签名轮询仅作兜底 ——
  const [sessionFile, setSessionFile] = useState<string | null>(null);
  const [linkedSessionId, setLinkedSessionId] = useState<string | null>(null);
  const [linkedSessionTitle, setLinkedSessionTitle] = useState<string | null>(
    null,
  );
  const [linkState, setLinkState] = useState<SessionLinkState["state"]>("idle");
  const [syncState, setSyncState] = useState<SessionLinkState["sync"]>("waiting");
  const [conv, setConv] = useState<ChatMessageDto[]>([]);
  const olderRef = useRef<ChatMessageDto[]>([]);
  const latestWindowRef = useRef<ChatMessageDto[]>([]);
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
  const sessionWatchIdRef = useRef<string | null>(null);
  const sessionWatchUnlistenRef = useRef<(() => void) | null>(null);
  const sessionWatchStartingRef = useRef(false);
  const linkStartedAtRef = useRef(0);
  const conversationRequestRef = useRef(0);
  // 收尾被 ptyLive 推迟后的保证重试定时器（去重：同屏最多挂一个）
  const settleRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoTitleEarlyRef = useRef(false);
  const autoTitleFinalRef = useRef(false);
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
  const [skillCount, setSkillCount] = useState(0);
  // 当前 agent 已启用的技能清单（技能页开关同步）；「插入」菜单一键使用
  const [agentSkills, setAgentSkills] = useState<SkillDto[]>([]);
  // 当前 agent 已分发的 MCP server 清单（MCP 页开关同步）；「插入」菜单一键提及/管理
  const [agentMcps, setAgentMcps] = useState<McpServerDto[]>([]);
  // 技能 + MCP 合并为一颗「插入」pill（聊天输入条「插入」菜单同口径），
  // 收缩态右侧只留 插入/修改/⋯ 三件，替代原先两粒常驻计数胶囊
  const [insertMenuOpen, setInsertMenuOpen] = useState(false);
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

  // 当前 agent 已启用的技能数与清单（技能页开关同步）+ 已分发的 MCP server（MCP 页开关同步）
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
    setInsertMenuOpen(false);
  }

  /** 一键提及 MCP server：同技能注入机制（提示 agent 调用其工具；分发变更对新会话生效） */
  function useMcp(name: string) {
    const text = `使用 ${name} 这个 MCP server 提供的工具：`;
    if (running && activePtyId) {
      writeInteractivePty(activePtyId, text);
    } else {
      setShowPrompt(true);
      setAdvancedLaunchOpen(true);
      setPromptText((t) => (t ? `${t}\n${text}` : text));
    }
    setInsertMenuOpen(false);
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
            if (up && !insertMenuOpen)
              setInsertMenuMaxH(upMaxH(insertAnchor.current));
            setInsertMenuOpen((v) => !v);
          }}
          title={`已启用 ${skillCount} 个技能、${agentMcps.length} 个 MCP，点击插入`}
          aria-expanded={insertMenuOpen}
          className="rounded-sm px-1.5 py-0.5 text-l3 hover:bg-hover hover:text-l1"
        >
          插入
        </button>
        {insertMenuOpen && (
          <>
            {/* 点击浮层外任意处关闭 */}
            <div
              className="fixed inset-0 z-40"
              onClick={() => setInsertMenuOpen(false)}
            />
            {/* 高度随锚点上方空间收缩，防顶出屏幕 */}
            <ul
              style={{ maxHeight: up ? insertMenuMaxH : 224 }}
              className={`absolute ${up ? "bottom-full mb-1" : "top-full mt-1"} ${alignRight ? "right-0" : "left-0"} z-50 w-72 overflow-auto rounded-md border border-field ccode-float-surface p-1`}
            >
              {agentSkills.length > 0 && (
                <li className="px-2 pb-0.5 pt-1.5 text-micro text-l4">技能</li>
              )}
              {agentSkills.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => useSkill(s.name)}
                    className="flex w-full flex-col gap-0.5 rounded-sm px-2 py-1.5 text-left hover:bg-hover"
                  >
                    <span className="text-xs text-l1">{s.name}</span>
                    {s.description && (
                      <span className="truncate text-micro text-l4">
                        {s.description}
                      </span>
                    )}
                  </button>
                </li>
              ))}
              {agentMcps.length > 0 && (
                <li
                  className={`px-2 pb-0.5 pt-1.5 text-micro text-l4 ${
                    agentSkills.length > 0
                      ? "mt-1 border-t border-hairline"
                      : ""
                  }`}
                >
                  MCP
                </li>
              )}
              {agentMcps.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => useMcp(s.name)}
                    className="flex w-full flex-col gap-0.5 rounded-sm px-2 py-1.5 text-left hover:bg-hover"
                  >
                    <span className="text-xs text-l1">{s.name}</span>
                    <span className="truncate font-mono text-micro text-l4">
                      {s.kind === "stdio"
                        ? `${s.command} ${s.args.join(" ")}`
                        : s.url}
                    </span>
                  </button>
                </li>
              ))}
              <li className="mt-1 border-t border-hairline">
                <button
                  type="button"
                  onClick={() => {
                    setInsertMenuOpen(false);
                    setPage("mcp");
                  }}
                  className="flex w-full rounded-sm px-2 py-1.5 text-left text-micro text-l4 hover:bg-hover hover:text-l2"
                >
                  管理 MCP 分发 →（变更对新会话生效）
                </button>
              </li>
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
  // 唯一的身份信息；同目录多开的终端靠它区分（纯 shell 标签没有 agent，前缀为空）
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
        }
      } catch {
        /* PTY 已退出 / 平台不支持（Windows 返回 null 走不到这）：静默 */
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
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
  // xterm 键盘层 handler 是挂载期闭包，agentId 也要经 ref 拿最新值（切 agent 后 Enter/Ctrl+V 改写才跟随）
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
  const [attention, setAttention] = useState<TabStatus["attention"]>(null);
  // PTY 输出静默计时：working 标由输出事件打起，静默后按 onPtyWorkingSilence 熄灭
  const lastOutputAtRef = useRef(0);
  // 用户刚提交一轮（聊天发送 / 回车 / 带指令的新启动）：允许 PTY 点亮转圈。
  // 启动或恢复会话本身不点亮——TUI 启动画面不是「正在生成回答」。
  const ptyWorkingArmedRef = useRef(false);
  const hadPtyWorkingOutputRef = useRef(false);
  function armPtyWorking() {
    ptyWorkingArmedRef.current = true;
    hadPtyWorkingOutputRef.current = false;
    setAttention("working");
  }
  function disarmPtyWorking() {
    ptyWorkingArmedRef.current = false;
    hadPtyWorkingOutputRef.current = false;
    setAttention((prev) => (prev === "working" ? null : prev));
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
  // PTY 输出静默：已经出过字则熄灭；还在等首字（思考中）保持转圈。
  // 熄灭后会话文件 sticky working 不得重新点亮（applyTailAttention）。
  useEffect(() => {
    if (attention !== "working") return;
    const timer = window.setInterval(() => {
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
      // 会话文件 sticky working 不能单独维持。running 不兜底——「进程在跑」≠「正在生成」
      attention: running && !shellActive ? attention : null,
      canResume: shellActive && lastResumeRef.current != null,
      startedAt,
      sessionId:
        linkCtxRef.current?.sessionId ??
        linkCtxRef.current?.hint ??
        lastResumeRef.current ??
        resumeSessionId ??
        null,
      runId,
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
    sessionFile,
    resumeSessionId,
    startedAt,
    runId,
    onStatus,
  ]);

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
      skills: agentSkills,
      mcps: agentMcps,
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
    agentSkills,
    agentMcps,
    onSessionUpdate,
  ]);

  // 从工作树带入目录创建的标签：聚焦配置选择，选好即可启动
  const profileSelectRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (initialCwd) profileSelectRef.current?.focus();
  }, [initialCwd]);

  // 懒挂载：首次可见时才创建 xterm，未展示过的标签不占用终端资源
  const [everVisible, setEverVisible] = useState(visible);
  everVisibleRef.current = everVisible;
  useEffect(() => {
    if (visible) setEverVisible(true);
  }, [visible]);

  // 恢复占位标签只做目录检查，不自动启动或偷偷迁移目录；失效时把修复入口放进空态卡。
  useEffect(() => {
    if (!restored || !visible || !everVisible) return;
    void checkWorkingDirectory(cwd);
  }, [restored, visible, everVisible, cwd]);

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
        settingsRef.current?.theme ?? "midnight",
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
        const fallback = printableKeyFallback(e);
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

    // 渲染器选择（设置页「终端渲染」）：auto = Windows 流畅优先（WebGL + 软件渲染探针）、
    // macOS 清晰优先（DOM）——xterm 的字形图集→GPU 纹理采样在 WKWebView 里整体偏软发糊
    // （A/B 截屏实测 DOM 渲染明显更锐利，Safari 同引擎复现一致），故 Mac 默认不走 WebGL；
    // 用户显式选「流畅」(webgl) 时按流畅优先，软件渲染（SwiftShader 等，闪烁）时退回默认。
    // 上下文丢失不再永久退 DOM（借鉴 Tabby）：终端标签长寿命、常驻后台，正是丢失高发场景；
    // 窗口重新聚焦/可见时预算重试（≤3 次），再丢才认命回落——Windows 默认 webgl 的用户
    // 不会「流畅档悄悄变糊」。
    const renderer = settingsRef.current?.terminalRenderer ?? "auto";
    const wantWebgl = renderer === "webgl" || (renderer === "auto" && !IS_MAC);
    let webglRecoveryLeft = 3;
    // webglActive：当前已加载且健康——没有它，每次窗口聚焦都会重建 renderer、
    // 新开 WebGL 上下文（2026-10-11 复核实证）。软件渲染探针也只开一次。
    let webglActive = false;
    let softwareWebgl: boolean | null = null;
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
        });
        term.loadAddon(webgl);
        webglActive = true;
        return true;
      } catch {
        return false;
      }
    };
    loadWebgl();
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
    };

    // 触控板滚动合帧（见 src/terminal-wheel-scroll.ts）：xterm 只对物理滚轮做平滑动画，
    // 触控板是「一枚事件写一次滚动位置、触发一次整屏重绘」——60–120Hz 细粒度小增量下就是
    // 「上下滑动一卡一卡」。这里把同帧内的多枚事件合成一枚再交回 xterm 原滚动逻辑，
    // 压到每帧最多一次写入与重绘；备用屏/鼠标上报/带修饰键仍原样交给 xterm。
    const teardownWheelCoalescing = installTrackpadWheelCoalescing(term);
    // 滚轮一格也是整屏重画。视口平移不到一屏时把还在屏幕上的行挪走，只重画新行。
    const teardownRowReuse = installDomScrollRowReuse(term);

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
    // 2026-10-10 二进制核查确认）。只对 agent 生效，shell 里的 \a 不打扰。
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

  /** 抓当前终端画面存回放。全屏 TUI 挂在备用屏时普通缓冲往往只有启动前的空屏
   *  （claude 整场都在 1049），此时改拍备用屏的可视行——回放要的是用户最后看到的画面。 */
  function saveTerminalReplayNow() {
    const term = termRef.current;
    if (!term || !everVisibleRef.current) return;
    const lines: string[] = [];
    if (term.buffer.active.type === "alternate") {
      for (let y = 0; y < term.rows; y += 1) {
        lines.push(term.buffer.active.getLine(y)?.translateToString(true) ?? "");
      }
    } else {
      const normal = term.buffer.normal;
      const from = Math.max(0, normal.length - 400);
      for (let y = from; y < normal.length; y += 1) {
        lines.push(normal.getLine(y)?.translateToString(true) ?? "");
      }
    }
    const replay = terminalReplayText(lines, 400);
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
      term.writeln("\x1b[90m── 上次离开时的画面 ──\x1b[0m");
      term.write(text.replace(/\n/g, "\r\n"));
      term.writeln("\r\n\x1b[90m── 点恢复任务后重新接上 ──\x1b[0m");
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
        invoke("pty_write", {
          ptyId: activePtyId,
          data: `cd ${shQuote(externalCwd)}\n`,
        }).catch(() => {});
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
      if (cur !== worktreePath && !cur.startsWith(`${worktreePath}/`)) return;
      setCwd(repoPath);
      const s = shellRef.current;
      if (s.shellActive && !s.running && s.activePtyId) {
        invoke("pty_write", {
          ptyId: s.activePtyId,
          data: `cd ${shQuote(repoPath)}\n`,
        }).catch(() => {});
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
          await invoke("pty_write", { ptyId, data: `${prefillCommand}\n` });
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
      // launch 内部 try 只包住 pty_spawn 起的后半段；前置段（目录检查/清理/官方账号
      // 确认）抛错时 void 吞掉就是「自动启动没反应」。落到错误面并展开启动栏，
      // 让用户（和我们）看得到失败原因。Promise.resolve 兜 launch 返回 null 的分支。
      Promise.resolve(restored && !customRuntimeId ? restoreTask() : launch()).catch(
        (e) => {
          setError(`自动启动失败：${String(e)}`);
          setBarExpanded(true);
        },
      );
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
  }, [resumeKick, visible, running]);

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
    kkpArmedRef.current = false;
    queryPendingRef.current = "";
    hostPendingRef.current = "";
    kittyAccumRef.current = "";
    signalPendingRef.current = "";
    setInlineImageUrl(null);
    setActivePtyId(ptyId);
    unlistenRef.current = [
      await listen<string>(`pty-output-${ptyId}`, (e) => {
        const queried = consumeTerminalQueries(queryPendingRef.current, e.payload);
        queryPendingRef.current = queried.pending;
        for (const reply of queried.replies) {
          if (reply.kkp === "arm") kkpArmedRef.current = true;
          if (reply.kkp === "disarm") kkpArmedRef.current = false;
          if (reply.reply) {
            invoke("pty_write", { ptyId, data: reply.reply }).catch(() => {});
          }
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
        if (host.text) term.write(host.text);
        // PTY 出字即活动：静默计时器量的是真实输出，与「这帧算不算 working」分开——
        // 切聊天/点输入框引发的焦点重绘有 300ms 抑制窗，窗内的 TUI 重绘若不计入活动，
        // 突发渲染间隙 ≥2s 就会在切换瞬间误熄灭 attention，且 armed 已耗尽、
        // 后续输出再也点不亮（working 只能靠重新提交），表现为「终端还在出字、
        // 聊天层却不显示运行中」。出字时间与 hadOutput 在 marks 判定之外先记。
        if (kind === "agent") {
          lastOutputAtRef.current = Date.now();
          hadPtyWorkingOutputRef.current = true;
          setAttention((prev) => {
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
      // 后台标签的带外信号（Rust gated_emit 在不可见时对含 OSC 9/777/BEL 的帧照发）：
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
    // Windows/ConPTY 吞掉 agent 的 OSC 10/11 底色查询（两个方向都不通，见
    // docs/conventions/terminal.md），xterm 的内置回报永远送不到子进程。
    // 改为不等查询、attach 后主动推一次：浅色主题下把当前前景/底色告诉 agent，
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
    if (kind === "agent") {
      // 记录可恢复的会话 id（一键恢复按钮用）
      lastResumeRef.current = linkCtxRef.current?.sessionId ?? null;
      // agent 退出（含手动停止）→ 同一终端自动回落到登录 shell。
      // 异常横幅只认 code > 0：负数（-1 等）是 pty_kill/丢弃/等待超时的「原因未知」
      // 哨兵（exit-code.ts），手动「停止」正是走它——code≠0 会把每次停止都误报成崩溃
      //（2026-10-11 复核实证）。死因横幅随回放持久（借鉴 VS Code）。
      const clause = exitCodeClause(code);
      if (code > 0) {
        termRef.current?.write(
          `\r\n\x1b[91m── agent 异常退出（代码 ${code}）${clause ? `：${clause}` : ""} ──\x1b[0m\r\n` +
            `\x1b[90m退出画面已存进回放；从启动栏重新启动可接回上一次会话\x1b[0m\r\n`,
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

  /** 找当前 agent 进程对应的会话文件：有 hint 精确匹配，否则走后端排他声明。 */
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
        const list = await invoke<SessionMetaDto[]>("list_sessions");
        const hit = list.find(
          (s) => s.agent === ctx.agentId && s.sessionId === ctx.hint,
        );
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
    const requestId = ++conversationRequestRef.current;
    let nextSig: string | null = null;
    let turnSettled = false;
    // 签名门控仍作兜底，但 watcher 事件会强制刷新。每次都记录新签名，避免事件后
    // 的下一轮轮询再次无条件解析；requestId 防止旧的异步读取覆盖新结果。
    const sig = await invoke<[number, number] | null>("session_file_sig", {
      filePath: ctx.filePath,
    }).catch(() => null);
    if (sig) {
      nextSig = `${sig[0]}:${sig[1]}`;
      if (!force && !pendingReplyRef.current && nextSig === convSigRef.current) return;
    }
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
      const isRecorded = (pu: ChatMessageDto) =>
        parsedMessages.some(
          (message) =>
            message.role === "user" &&
            message.blocks.some((block) => {
              if (block.kind !== "text") return false;
              const sent = pu.blocks[0]?.text ?? "";
              // TUI 输入框可能有残留草稿（先发一半、审批框吞键等），落盘文本会是
              // 「残留 + 本文」的拼接（实证：yyyyyy你是什么模型），精确匹配永远落空、
              // 「等待回复」挂到超时——放宽为包含匹配；重复发同一文本时旧记录会先命中，
              // 清除仍受下方 hasNewAssistantText（必须出现新回复正文）双闸门约束
              return (
                block.text === sent ||
                (sent.length > 0 && block.text.includes(sent))
              );
            }),
        );
      const missing = pendingUsers.filter((pu) => !isRecorded(pu));
      pendingUsersRef.current = missing;
      const mergedMessages =
        missing.length > 0
          ? (() => {
              const next = [...parsedMessages];
              const replyIndex = next.findIndex((message) => message.role !== "user");
              next.splice(replyIndex < 0 ? next.length : replyIndex, 0, ...missing);
              return next;
            })()
          : parsedMessages;
      latestWindowRef.current = mergedMessages;
      if (olderRef.current.length === 0) {
        convCursorRef.current = page.cursor;
        setConvCursor(page.cursor);
      }
      setConv(mergeConversationPages(olderRef.current, mergedMessages));
      const hasNewAssistantText = parsedMessages.some(
        (message) =>
          message.role !== "user" &&
          hasAssistantText([message]) &&
          !pendingAssistantKeysRef.current.has(JSON.stringify(message.blocks)),
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
      if (
        !autoTitleFinalRef.current &&
        parsedMessages.some(
          (m) => m.role !== "user" && m.blocks.some((b) => b.kind === "text" && b.text.trim()),
        )
      ) {
        autoTitleFinalRef.current = true;
        scheduleAutoTitle("final");
      }
    } catch {
      // 会话文件可能写到一半，下轮再试
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
      const fileSaysOver = state === "done" || turnSettled;
      const ptyLive = Date.now() - lastOutputAtRef.current < PTY_LIVE_MS;
      setAttention((prev) => {
        const next = applyTailAttention({
          prev,
          tail: state,
          armed: ptyWorkingArmedRef.current,
          turnSettled,
          ptyLive,
          pendingReply: pendingReplyRef.current,
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

  async function loadOlderConversation() {
    const ctx = linkCtxRef.current;
    const cursor = convCursorRef.current;
    if (!ctx?.filePath || cursor == null || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await invoke<ConversationPageDto>(
        "get_session_conversation_page",
        {
          agent: ctx.agentId,
          filePath: ctx.filePath,
          before: cursor,
          around: null,
        },
      );
      if (linkCtxRef.current !== ctx) return;
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
    if (createdAt) ctx.createdAt = createdAt;
    olderRef.current = [];
    latestWindowRef.current = [];
    convCursorRef.current = null;
    setConvCursor(null);
    setSessionFile(filePath);
    setLinkedSessionId(sessionId);
    setLinkedSessionTitle(title);
    setLinkState("linked");
    setSyncState("polling");
    setLiveSession(ctx.agentId, sessionId, tabId);
    if (runId) {
      invoke("run_attach_session", { id: runId, sessionId }).catch(() => {});
    }
    void invoke("set_session_profile_command", {
      agent: ctx.agentId,
      sessionId,
      profileId,
    });
    void startSessionWatcher(filePath, ctx.agentId);
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

  async function linkTick() {
    const ctx = linkCtxRef.current;
    if (!ctx) return;
    if (!ctx.filePath) {
      const hit = await findSessionFile();
      if (!hit) {
        setSyncState("waiting");
        if (Date.now() - linkStartedAtRef.current >= 20_000)
          setLinkState("timeout");
        return;
      }
      lockLink(hit.filePath, hit.sessionId, hit.title, hit.createdAt);
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
      else setLinkState("timeout");
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
          if (!title) {
            if (n < 2) window.setTimeout(() => attempt(n + 1), 8000);
            return;
          }
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
    autoTitleFinalRef.current = false;
    linkCtxRef.current = null;
    convSigRef.current = "";
    olderRef.current = [];
    latestWindowRef.current = [];
    convCursorRef.current = null;
    setConvCursor(null);
    setLoadingOlder(false);
    setSessionFile(null);
    setLinkedSessionId(null);
    setLinkedSessionTitle(null);
    setLinkState("idle");
    setSyncState("waiting");
    setConv([]);
    setPendingReply(false);
    pendingUsersRef.current = [];
    pendingAssistantKeysRef.current = new Set();
    ptyWorkingArmedRef.current = false;
    hadPtyWorkingOutputRef.current = false;
    setAttention(null);
    setConfirmDetail(null);
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
    options?: { prompt?: string; readonly?: boolean },
  ): Promise<{ ptyId: string; promptDropped: boolean } | null> {
    setError(null);
    setNotice(null);
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
        "「官方账号」走 ChatGPT / OpenAI 官方接口，不带网关密钥。当前还没登录，启动会变成 401（Missing bearer）。请到连接页登录，或改选网关配置。",
        { confirmText: "仍要启动" },
      );
      if (!ok) {
        setBarExpanded(true);
        return null;
      }
    }
    if (!(await checkWorkingDirectory(cwd))) {
      setBarExpanded(true);
      return null;
    }
    if (!visible || !everVisible) {
      setError("这次没能按画面大小启动");
      return null;
    }
    const launchPrompt = (options?.prompt ?? promptText).trim();
    const isResume = Boolean(resumeId ?? resumeSessionId);
    const chrome = launchChromeBeforeMeasure({
      resume: isResume,
      prompt: launchPrompt,
      promptInject: agentId === "kimi" ? "unsupported" : "positional",
    });
    const chromeSnapshot = {
      bar: barExpandedRef.current,
      advanced: advancedLaunchOpenRef.current,
    };
    const probeRun = (runId ?? initialRunId ?? "").trim();
    let existingPty: string | null = null;
    if (probeRun) {
      existingPty = await invoke<string | null>("pty_id_for_run", {
        runId: probeRun,
      });
    }
    if (existingPty) {
      resizeLatchRef.current = { kind: "frozen" };
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
    // 同标签重复启动（重启 agent 接着聊任务书）重新登记，新会话仍归该步骤
    if (stepClaimName && !resumeId && !resumeSessionId) {
      invoke("claim_next_session_for_step", {
        agent: agentId,
        cwd,
        stepName: stepClaimName,
      }).catch(() => {
        // 登记失败静默降级：会话不归步骤，仍可在对话页全部列表里看到
      });
    }
    const lockKey = (runId ?? initialRunId ?? "").trim() || `tab:${tabId}`;
    if (interactiveLaunchLocks.has(lockKey)) {
      return null;
    }
    interactiveLaunchLocks.add(lockKey);
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
        // 会话恢复（无则全新会话）
        resumeSessionId: resumeId ?? resumeSessionId ?? null,
        resumeProvider: resumeProvider ?? null,
        // 一键开步的首条指令（恢复会话由后端忽略注入）
        initialPrompt: (options?.prompt ?? promptText).trim() || null,
        linkClaimId: tabId,
        // 「聊想法」只读模式：后端按注册表注入只读/计划模式参数（不支持的 CLI 只有 prompt 软约束）
        readonly: options?.readonly ?? readonly ?? null,
        permission:
          permission ??
          (options?.readonly ?? readonly ? "discuss" : "write_tree"),
        // 开工弹层的本次思考档覆盖（空 = 绑定逐模型策略）；后端在读绑定策略处用本值优先
        effortOverride: effortOverride?.trim() || null,
        reuseKey: reuseKey ?? null,
        runId: runId ?? initialRunId ?? null,
        taskId: taskId ?? null,
        cols: size.cols,
        rows: size.rows,
      });
      if (res.adopted) resizeLatchRef.current = { kind: "frozen" };
      if (res.runId) setRunId(res.runId);
      // 后端兜底模型回传（前端留空 = profile 首个模型）：同步进标签状态，
      // 否则状态栏/对话头部在兜底路径下没有模型可显示；lastLaunch/模型历史也记生效值
      const effectiveModel = res.model ?? model;
      if (res.model && res.model !== model) setModel(res.model);
      setLaunchModel(effectiveModel.trim() || null);
      localStorage.setItem(
        "ccode.lastLaunch",
        JSON.stringify({ agentId, profileId, model: effectiveModel, cwd }),
      );
      // 模型历史（本 agent 维度，去重前置，上限 10 条）：模型 combo 下拉的可选项来源之一
      if (effectiveModel.trim()) {
        try {
          const key = `ccode.modelHistory.${agentId}`;
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
      // 记住各 agent 上次使用的配置（会话恢复的兜底选择）
      localStorage.setItem(`ccode.lastProfile.${agentId}`, profileId);
      // 工作区记住上次配置（W3：worktree 目录下的启动）
      if (cwd.includes("/ccode/workspaces/")) {
        localStorage.setItem(
          `ccode.wsLast.${cwd}`,
          JSON.stringify({ agentId, profileId, model }),
        );
      }
      // SessionLink：记录启动上下文，开始轮询会话文件
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
        isResume: Boolean(resumeId ?? resumeSessionId),
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
      } else if (res.promptDropped && !isResume) {
        disarmPtyWorking();
        setPendingReply(false);
        // 栏高保持测量时的样子。指令留在错误行，收缩行因 error 会显示出来。
        void navigator.clipboard
          .writeText(launchPrompt)
          .catch(() => {});
        setError("该 CLI 不支持启动注入：指令已复制，请在终端里粘贴发送");
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

  /** 停止 agent：杀掉 PTY 后由退出事件自动回落到 shell */
  async function stop() {
    const id = ptyIdRef.current;
    if (!id) return;
    try {
      await invoke("pty_kill", { ptyId: id });
    } catch (reason) {
      setError(`停止终端失败：${String(reason)}`);
    }
  }

  async function writeChatMessage(ptyId: string, text: string): Promise<ChatSendResult> {
    try {
      await invoke("pty_write_submit", {
        ptyId,
        text,
        submit: submitCsiU ? KIMI_CSI_U_ENTER : "\r",
      });
      return { error: null };
    } catch (e) {
      return { error: `发送失败：${String(e)}` };
    }
  }

  function showOptimisticUserMessage(text: string) {
    // 发送发生在后台读取途中时，令旧读取失效，避免它把刚显示的本地消息覆盖掉。
    conversationRequestRef.current += 1;
    const message: ChatMessageDto = {
      role: "user",
      blocks: [{ kind: "text", text, toolName: null }],
      timestamp: new Date().toISOString(),
      usage: null,
    };
    pendingAssistantKeysRef.current = new Set(
      conv
        .filter((item) => item.role !== "user")
        .map((item) => JSON.stringify(item.blocks)),
    );
    pendingUsersRef.current = [...pendingUsersRef.current, message];
    setConv((current) => {
      const last = current[current.length - 1];
      const lastText = last?.blocks.map((block) => block.text).join("");
      if (last?.role === "user" && lastText === text) return current;
      return [...current, message].slice(-50);
    });
    setPendingReply(true);
  }

  async function sendMessage(text: string): Promise<ChatSendResult> {
    const message = text.trim();
    if (!message) return { error: null };
    // 发送链路以 PTY ref 为准，不依赖 running/activePtyId 的异步镜像状态。
    // 聊天层与终端层共享这个 PTY；刚启动或刚从 shell 回落时，React 状态可能尚未完成一帧更新。
    const currentPtyId = ptyIdRef.current;
    if (ptyKindRef.current === "agent" && currentPtyId) {
      armPtyWorking();
      const result = await writeChatMessage(currentPtyId, message);
      if (result.error) disarmPtyWorking();
      else showOptimisticUserMessage(message);
      return result;
    }

    // Agent 已回落 shell：聊天框继续沿用最后一个会话，而不是启动新上下文。
    if (!running && shellActive && lastResumeRef.current) {
      const res = await launch(lastResumeRef.current, { prompt: "" });
      if (!res) return { error: error ?? "恢复会话失败，请切到终端检查" };
      // 恢复启动要经历进程引导/会话回放（可能还有信任提示）：等一拍再写，
      // 否则正文+提交键落在尚未就绪的 TUI 上，表现为消息躺在输入框里没发出去
      await new Promise((r) => setTimeout(r, 1200));
      if (!mountedRef.current || ptyIdRef.current !== res.ptyId)
        return { error: null };
      armPtyWorking();
      const result = await writeChatMessage(res.ptyId, message);
      if (result.error) disarmPtyWorking();
      else showOptimisticUserMessage(message);
      return result;
    }

    if (!profileId) return { error: "请先在底部状态栏选择一个连接配置" };
    setPromptText(message);
    setShowPrompt(true);
    const res = await launch(undefined, { prompt: message });
    if (!res) return { error: "启动 Agent 失败，请切到终端查看详细信息" };
    if (res.promptDropped) {
      return {
        error: "该 CLI 不支持自动发送首条指令，已切到终端；请粘贴并发送输入框中的指令",
        needsTerminal: true,
      };
    }
    showOptimisticUserMessage(message);
    return { error: null };
  }

  async function restartWritable(): Promise<ChatSendResult> {
    const prompt = forkPromptRef.current.trim();
    if (!prompt) return { error: "当前标签没有可重建的分叉摘要" };
    setPromptText(prompt);
    setShowPrompt(true);
    const res = await launch(undefined, { prompt, readonly: false });
    if (!res) return { error: "重启可写会话失败，请切到终端查看详细信息" };
    if (res.promptDropped) {
      return {
        error: "该 CLI 不支持自动发送分叉指令，已切到终端；请手动发送摘要指令",
        needsTerminal: true,
      };
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
    restartWritable: async () => ({ error: "当前标签不是可写分叉" }),
    writePty: () => {},
    writeCommand: () => {},
    noteUserTurn: () => {},
    loadOlderConversation: async () => {},
  });
  actionsRef.current = {
    stop: () => void stop(),
    resume: () => {
      if (lastResumeRef.current)
        void launch(lastResumeRef.current ?? undefined);
    },
    openConversationPage,
    search: () => setSearchOpen(true),
    toggleInsert: () => setInsertMenuOpen((open) => !open),
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
        if (data === "\x1b") setPendingReply(false);
      } else if (data === "y" || data === "n") armPtyWorking();
      const id = ptyIdRef.current;
      if (id) writeInteractivePty(id, data);
    },
    writeCommand: (cmd) => {
      const id = ptyIdRef.current;
      if (!id) return;
      const enter = submitCsiU ? KIMI_CSI_U_ENTER : "\r";
      writeInteractivePty(id, `${cmd}${enter}`);
    },
    noteUserTurn: () => armPtyWorking(),
    loadOlderConversation: () => loadOlderConversation(),
  };
  useEffect(() => {
    onActions?.(tabId, {
      stop: () => actionsRef.current.stop(),
      resume: () => actionsRef.current.resume(),
      openConversationPage: () =>
        actionsRef.current.openConversationPage(),
      search: () => actionsRef.current.search(),
      modify: () => actionsRef.current.modify(),
      toggleInsert: () => actionsRef.current.toggleInsert(),
      logLine: (t) => actionsRef.current.logLine(t),
      setCwd: (c) => actionsRef.current.setCwd(c),
      chooseCwd: () => actionsRef.current.chooseCwd(),
      sendMessage: (text) => actionsRef.current.sendMessage(text),
      restartWritable: () => actionsRef.current.restartWritable(),
      writePty: (data) => actionsRef.current.writePty(data),
      writeCommand: (cmd) => actionsRef.current.writeCommand(cmd),
      noteUserTurn: () => actionsRef.current.noteUserTurn(),
      loadOlderConversation: () => actionsRef.current.loadOlderConversation(),
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

  const terminalMenuItems = [
    ...(!running && !shellActive
      ? [{ label: "打开 Shell", onSelect: () => void openShell() }]
      : []),
    ...(!ptyIdRef.current
      ? [
          {
            label: advancedLaunchOpen ? "收起高级启动选项" : "显示高级启动选项",
            onSelect: () => {
              setBarExpanded(true);
              setAdvancedLaunchOpen((v) => !v);
            },
          },
        ]
      : [
          {
            label: "查看本次启动",
            onSelect: () => setLaunchInfoOpen(true),
          },
        ]),
    ...(sessionFile && linkedSessionId
      ? [
          ...(onForkChat
            ? [
                {
                  label: "新建分叉聊天",
                  onSelect: () => onForkChat?.(tabId),
                },
              ]
            : []),
          {
            label: "在对话页回放",
            onSelect: () => openConversationPage(),
          },
        ]
      : []),
    // 「快速开聊」的转正出口：把当前目录登记成项目，会话历史天然跟 cwd 走、
    // 自动归到新项目下（ProjectAggregator 既有归并口径，不需要迁移任何东西）。
    // 只登记，不建工作区、不选模板——模板从项目页的引导横幅或 ⋯ 里选。
    {
      label: "转为项目…",
      onSelect: () => {
        void (async () => {
          const dir = cwd.trim().replace(/[\\/]+$/, "");
          const name = dir.split(/[\\/]/).pop() || dir;
          if (!dir) return;
          if (
            !(await confirmDialog(
              `把「${dir}」登记为 Mesa 项目？\n只登记这个目录，不会建工作区、不改动任何文件。写论文可在项目页选研究流程；只读文献写笔记可以不选。\n对话跟着这个目录走；要落到别的文件夹，得在开聊前另选目录。`,
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

  // 终端画布右键菜单：复制按打开菜单那一刻的选区裁剪（setTermCtxMenu 触发重渲染即取到最新值）
  const ctxSelection = termRef.current?.getSelection() ?? "";
  const termCtxMenuItems = [
    {
      label: "复制",
      disabled: !ctxSelection,
      title: ctxSelection ? undefined : "先在终端里选中一段输出",
      onSelect: () =>
        void navigator.clipboard.writeText(ctxSelection).catch(() => {}),
    },
    { label: "粘贴", onSelect: () => void pasteFromClipboard() },
    { label: "查找输出", onSelect: () => setSearchOpen(true) },
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
            aria-label="关闭本次启动"
            className="fixed inset-0 z-40"
            onClick={() => setLaunchInfoOpen(false)}
          />
          <div className="ccode-float-surface absolute left-3 top-10 z-50 w-72 rounded-md border border-field bg-raised p-3 text-xs text-l2">
            <p className="text-l1">这次进程不会改。要换，先停止。</p>
            <p className="mt-2">
              {agentLabel(agentId)}
              {selectedProfile ? ` · ${selectedProfile.name}` : ""}
              {model ? ` · ${model}` : ""}
            </p>
            {/* 配置指纹（借鉴 VS Code 环境信息层）：托盘/设置切了全局默认后，
                跑着的终端仍是旧网关——这里能看到本进程到底吃的哪碗饭。
                只显标识与尾号，密钥值永不出现 */}
            {selectedProfile && (
              <p className="mt-1 truncate text-l4" title="本进程生效的配置指纹">
                {(() => {
                  if (selectedProfile.accountType === "official") {
                    return "官方账号登录";
                  }
                  const parts = [
                    selectedProfile.gatewayId
                      ? `网关 ${gatewayNameOf(selectedProfile.gatewayId)}`
                      : null,
                    selectedProfile.keyHint
                      ? `密钥 ${selectedProfile.keyHint}`
                      : null,
                  ].filter((s): s is string => Boolean(s));
                  return parts.length > 0 ? parts.join(" · ") : null;
                })()}
              </p>
            )}
            {selectedProfile &&
              Object.keys(selectedProfile.extraEnv ?? {}).length > 0 && (
                <p
                  className="mt-1 truncate text-l4"
                  title={`附加环境变量（值不显示）：${Object.keys(selectedProfile.extraEnv).join("、")}`}
                >
                  附加变量：{Object.keys(selectedProfile.extraEnv).join("、")}
                </p>
              )}
            <p className="mt-1 truncate text-l3" title={cwd}>
              {cwd}
            </p>
          </div>
        </>
      )}
      {activePtyId && insertMenuOpen && (
        <div className="fixed right-3 top-12 z-50">
          <button
            type="button"
            aria-label="关闭插入菜单"
            className="fixed inset-0 z-40"
            onClick={() => setInsertMenuOpen(false)}
          />
          <ul className="relative z-50 max-h-56 w-72 overflow-auto rounded-md border border-field ccode-float-surface p-1">
            {agentSkills.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => useSkill(s.name)}
                  className="flex w-full rounded-sm px-2 py-1.5 text-left text-xs text-l1 hover:bg-hover"
                >
                  {s.name}
                </button>
              </li>
            ))}
            {agentMcps.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => useMcp(m.name)}
                  className="flex w-full rounded-sm px-2 py-1.5 text-left text-xs text-l1 hover:bg-hover"
                >
                  {m.name}
                </button>
              </li>
            ))}
            {agentSkills.length === 0 && agentMcps.length === 0 && (
              <li className="px-2 py-1.5 text-xs text-l4">还没有可插入的技能或 MCP</li>
            )}
          </ul>
        </div>
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
              onChange={(id) => {
                setAgentId(id);
                setProfileId("");
                setModel("");
                setModelKept(false);
              }}
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
              onChange={(id) => {
                const prevModels =
                  profiles.find((p) => p.id === profileId)?.models ?? [];
                const prof = profiles.find((p) => p.id === id);
                setProfileId(id);
                // 手填的模型不再被静默清掉：不在新配置模型表里就保留，
                // 并由下方说明行告知「仍会按原样注入」
                const next = modelOnProfileSwitch(
                  model,
                  prevModels,
                  prof?.models ?? [],
                );
                setModel(next.model);
                setModelKept(next.kept);
              }}
              buttonRef={profileSelectRef}
              className={`${seg} w-[clamp(6.5rem,12vw,9rem)] min-w-[6.5rem] max-w-[9rem] shrink`}
            />
            {selectedProfile && (
              // 模型 combo-box：可输可选（profile 预设 + 本 agent 历史），输入即筛选，
              // 自由输入的模型启动成功后记入历史（ccode.modelHistory.<agent>），下次直接可选
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
              <p className="mb-2 text-sm text-l3">请先为该 agent 创建配置</p>
            )}
        </>
      ) : compactBarHidden && !compactBarUrgent ? null : (
        /* 收缩态只保留启动配置入口；聊天统一从主工作区进入。 */
        <div className="mt-1 mb-1 flex h-7 items-center gap-2 text-xs text-l4">
          <span className="truncate">
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
          </span>
          {error ? (
            <span className="truncate text-err-text">{error}</span>
          ) : notice ? (
            <span className="truncate text-l3">{notice}</span>
          ) : null}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {/* 技能/MCP 合并为一颗「插入」（运行时快捷入口，收缩状态行常驻）；
                首条指令等低频启动项进入高级配置。 */}
            {renderInsertMenu(false, true)}
            <button
              type="button"
              onClick={() => {
                // 已有进程时只开浮层。展开整条栏会把 xterm 垫高，
                // Ink 回合中不重排，输入行停在半截。
                if (ptyIdRef.current) setLaunchInfoOpen(true);
                else setBarExpanded(true);
              }}
              title={ptyIdRef.current ? "查看本次启动" : "修改启动配置"}
              className="rounded-sm px-2 py-1 text-l3 hover:bg-hover hover:text-l1"
            >
              {ptyIdRef.current ? "本次" : "修改"}
            </button>
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
                title="收起此行（底部状态栏仍有身份信息；标签栏可召回）"
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
      {searchOpen && (
        <div className="absolute left-3 top-2 z-30 flex flex-col items-start gap-1 rounded-md border border-field bg-strip px-2 py-1">
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
          onContextMenu={(e) => {
            e.preventDefault();
            setTermCtxMenu({ x: e.clientX, y: e.clientY });
          }}
        />
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
                onClick={() => void chooseWorkingDirectory()}
                disabled={cwdChecking}
                title={`${cwd === "~" && homeDir ? homeDir : cwd}\n点击选择工作目录`}
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
                <button
                  type="button"
                  onClick={() =>
                    restored && !customRuntimeId ? void restoreTask() : void launch()
                  }
                  disabled={!profileId || cwdChecking || !!profiles.find((p) => p.id === profileId)?.slotMissing}
                  className="inline-flex h-9 min-w-40 cursor-pointer items-center justify-center gap-2 rounded-md border border-cta-bd bg-cta px-5 text-sm text-cta-text hover:brightness-110 disabled:cursor-default disabled:opacity-50"
                >
                  {restored && !customRuntimeId ? "恢复任务" : "运行"}
                  {/* 快捷键说明：括号小字随按钮文字整体居中，不加胶囊底色
                      （18% 混合底在纯色按钮上是块显眼补丁，用户否为「色差」）；勿绝对定位钉右缘 */}
                  <span className="text-micro opacity-80">
                    （{IS_MAC ? "⌘ + Enter" : "Ctrl + Enter"}）
                  </span>
                </button>
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
}

export default function TerminalPage({ visible }: { visible: boolean }) {
  const setPage = useAppStore((s) => s.setPage);
  const liveSessions = useAppStore((s) => s.liveSessions);
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
      resumeSessionId: tab.customRuntimeId ? undefined : tab.sessionId ?? undefined,
      runId: tab.runId ?? undefined,
      taskId: tab.taskId ?? undefined,
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
  // 标签条拖拽排序（Ghostty 式跟手拖动）：源标签随指针平移、其余标签滑动让位（150ms
  // transition）、松手先吸附到目标槽位再真正重排——全程无 HTML5 DnD（Tauri 原生文件拖放
  // dragDropEnabled 默认开，会拦截 WKWebView 拖拽手势，dragstart 根本不触发）。
  // 拖拽期间 tabs 顺序不变（布局稳定，槽位测量值才有效），落定时才 moveTab 重排；
  // 顺序即 tabs 数组顺序，重启持久化按数组存，重排自动带过去
  const [tabDrag, setTabDrag] = useState<{
    id: string;
    /** 源标签原索引（= 当前渲染索引，拖拽期间顺序不变） */
    from: number;
    /** 指针当前落在的槽位索引（让位动画与落定位置都按它） */
    target: number;
    /** 源标签当前位移 px（钳制在标签条内容范围内） */
    dx: number;
    /** 拖拽开始时各槽位测量值（viewport 坐标；顺序 = tabs 顺序） */
    rects: { left: number; width: number }[];
    /** true = 松手吸附动画中：源标签 transition 到落点，结束才重排清态 */
    settling: boolean;
  } | null>(null);
  // 拖拽落定后的那次 click 要吞掉（否则拖完还会触发激活切换）
  const suppressTabClickRef = useRef(false);
  const moveTab = useCallback((from: number, to: number) => {
    setTabs((prev) => {
      if (from < 0 || to < 0 || from >= prev.length || to >= prev.length || from === to)
        return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);
  /** 标签按下即挂 window 级 move/up 监听：横向位移超 6px 才进入拖拽，否则当普通点击放过 */
  function onTabPointerDown(e: React.PointerEvent, tabId: string) {
    if (e.button !== 0) return;
    const tabEl = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    let active = false;
    let rects: { left: number; width: number }[] = [];
    let from = 0;
    // finish 里要用最新 target（setState 闭包拿不到），ref 镜像
    let lastTarget = 0;
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.style.userSelect = "";
    };
    const finish = () => {
      cleanup();
      if (!active) return;
      suppressTabClickRef.current = true;
      const target = lastTarget;
      if (target === from) {
        setTabDrag(null);
        return;
      }
      // 先吸附：源标签 transition 滑到目标槽位，动画结束才重排（与 transition 时长对齐）
      setTabDrag((cur) =>
        cur
          ? {
              ...cur,
              dx: cur.rects[target].left - cur.rects[from].left,
              settling: true,
            }
          : null,
      );
      window.setTimeout(() => {
        moveTab(from, target);
        setTabDrag(null);
      }, 170);
    };
    const onMove = (ev: PointerEvent) => {
      if (!active) {
        if (Math.abs(ev.clientX - startX) <= 6) return;
        active = true;
        // 进入拖拽态才测量槽位（此刻布局未变）；querySelectorAll 顺序 = tabs 顺序
        const els = Array.from(
          (tabEl.parentElement ?? tabEl).querySelectorAll<HTMLElement>(
            "[data-tab-id]",
          ),
        );
        rects = els.map((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, width: r.width };
        });
        from = Math.max(
          0,
          els.findIndex((el) => el.getAttribute("data-tab-id") === tabId),
        );
        lastTarget = from;
        // 拖动经过的标签标题会被划选，拖拽期间全局禁选
        document.body.style.userSelect = "none";
      }
      // 钳制：源标签不出标签条内容范围；目标槽位：源中心越过谁的中线就占谁的位
      // （纯逻辑在 tab-drag.ts——>= 判定守「拖到最右」边界，曾翻车：严格 > 永远够不到末槽）
      const rawDx = ev.clientX - startX;
      const dx = clampTabDragDx(rects, from, rawDx);
      const target = tabDragTarget(rects, from, dx);
      lastTarget = target;
      // 视觉位移走橡胶带：越界阻力递增不在边界冻住，槽位判定仍用钳制值（语义不动）
      setTabDrag({
        id: tabId,
        from,
        target,
        dx: rubberbandTabDx(rects, from, rawDx),
        rects,
        settling: false,
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }
  const [statuses, setStatuses] = useState<Record<string, TabStatus>>({});
  // 关闭守卫（关标签/关窗）在异步链路里取最新状态，避免闭包过期
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
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
  // 左栏（工作树）：显示 / 被专注内容隐藏
  const [showHidden, setShowHidden] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  /** 最近项目「真进入」：待注入活动标签启动栏的目录 */
  const [enterCwd, setEnterCwd] = useState<string | null>(null);
  // 右侧成果工作台默认可见；文件、改动在同一处切换，聊天留在主工作区。
  const [treeOpen, setTreeOpen] = useState(() => {
    try {
      return localStorage.getItem("ccode.terminal.treeOpen") === "1";
    } catch {
      return false;
    }
  });
  // 主目录自动收起只做一次。人点「显示文件树」先记下，效果里不得再收掉这一下。
  const homeTreeHandledRef = useRef(false);
  const homeTreeUserOpenRef = useRef(false);
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
  const [rightOpen, setRightOpen] = useState(() => {
    try {
      return localStorage.getItem("ccode.terminal.rightOpen") === "1";
    } catch {
      return false;
    }
  });
  const [rightWidth, setRightWidth] = useState(() => {
    const saved = Number(localStorage.getItem(RIGHT_PANEL_WIDTH_KEY));
    const width =
      Number.isFinite(saved) && saved > 0 ? saved : RIGHT_PANEL_DEFAULT_WIDTH;
    // 上限由挂载时的窗口尺寸动态钳制（见下方 resize 副作用），这里只保下限
    return Math.max(RIGHT_PANEL_MIN_WIDTH, width);
  });
  const [rightExpanded, setRightExpanded] = useState(false);
  const terminalRootRef = useRef<HTMLDivElement>(null);
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

  function persistTreeOpen(next: boolean) {
    if (next) homeTreeUserOpenRef.current = true;
    setTreeOpen(next);
    try {
      localStorage.setItem("ccode.terminal.treeOpen", next ? "1" : "0");
    } catch {
      /* ignore */
    }
  }
  function persistRightOpen(next: boolean) {
    setRightOpen(next);
    try {
      localStorage.setItem("ccode.terminal.rightOpen", next ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  const [rightTab, setRightTab] = useState<RightTab>("preview");
  // 主工作区模式按标签隔离；切换只改变显示层，不改变标签/PTY/会话。
  const [surfaceModeByTab, setSurfaceModeByTab] = useState<Record<string, SurfaceMode>>({});
  const [peekByTab, setPeekByTab] = useState<Record<string, boolean>>({});
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
  const focusedSurfaceMode = surfaceModeByTab[focusedId] ?? DEFAULT_SURFACE_MODE;
  /** 左栏文件树当前根（钻取/切根后与 activeCwd 分叉）：改动面板跟随它而不是终端标签 cwd，
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
  // 切标签/分屏焦点变化时回到新标签 cwd：树若未挂载（收起或专注内容）就没人发 onRootNavigated，
  // 必须在这里清掉分叉，否则改动面板会停在旧标签的目录上
  useEffect(() => {
    setTreeRoot(null);
  }, [activeCwd]);

  // 文件树根落在主目录时自动收起一次（不写偏好）：主目录下全是系统文件夹。
  // 人点「显示文件树」当次保持打开。离开主目录后守卫复位。
  const [homeDir, setHomeDir] = useState("");
  useEffect(() => {
    void invoke<string>("home_dir")
      .then(setHomeDir)
      .catch(() => {});
  }, []);
  useEffect(() => {
    const root = treeRoot ?? activeCwd;
    // 家目录还没问到、cwd 又不是 ~ 时，先别判断，避免人刚点开就被补上的 homeDir 收掉
    const homeKnown = root === "~" || !!homeDir;
    const atHome =
      homeKnown &&
      !!root &&
      (root === "~" || samePath(root, homeDir, IS_WINDOWS));
    if (homeTreeUserOpenRef.current) {
      homeTreeUserOpenRef.current = false;
      homeTreeHandledRef.current = true;
    }
    if (!homeKnown) return;
    const next = collapseHomeTreeOnce(
      atHome,
      treeOpen,
      homeTreeHandledRef.current,
    );
    homeTreeHandledRef.current = next.handled;
    if (next.open !== treeOpen) setTreeOpen(next.open);
  }, [treeRoot, activeCwd, homeDir, treeOpen]);

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
  }

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

  useEffect(() => {
    if ((surfaceModeByTab[focusedId] ?? DEFAULT_SURFACE_MODE) !== "chat") return;
    if (statuses[focusedId]?.attention !== "confirm") return;
    if (
      !shouldAutoPeek(
        confirmHandoffEvent(
          statuses[focusedId]?.agentId,
          Boolean(
            useAppStore.getState().settings?.hooksAttention?.[
              statuses[focusedId]?.agentId ?? ""
            ],
          ),
        ),
      )
    ) {
      return;
    }
    setPeek(focusedId, true);
    // peekLocked / 用户手动收起由 setPeek 守
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statuses[focusedId]?.attention, focusedId, surfaceModeByTab[focusedId]]);

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

  function maxRightWidth(expanded = rightExpanded): number {
    const total = terminalRootRef.current?.clientWidth ?? window.innerWidth;
    const railWidth = expanded ? 0 : 240;
    return Math.max(
      RIGHT_PANEL_MIN_WIDTH,
      total - railWidth - TERMINAL_MIN_RESERVE,
    );
  }

  function clampRightWidth(width: number, expanded = rightExpanded): number {
    return Math.min(
      maxRightWidth(expanded),
      Math.max(RIGHT_PANEL_MIN_WIDTH, width),
    );
  }

  function toggleRightExpanded() {
    if (rightExpanded) {
      setRightExpanded(false);
      setRightWidth(clampRightWidth(normalRightWidthRef.current, false));
      return;
    }
    normalRightWidthRef.current = rightWidth;
    const total = terminalRootRef.current?.clientWidth ?? window.innerWidth;
    setRightExpanded(true);
    setRightWidth(clampRightWidth(Math.round(total * 0.58), true));
  }

  function closeRightPanel() {
    if (rightExpanded) {
      setRightExpanded(false);
      setRightWidth(clampRightWidth(normalRightWidthRef.current, false));
    }
    persistRightOpen(false);
  }

  function toggleRightPanel() {
    if (rightOpen) closeRightPanel();
    else persistRightOpen(true);
  }

  function startRightResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = rightWidth;
    const expanded = rightExpanded;
    const onMove = (moveEvent: PointerEvent) => {
      setRightWidth(
        clampRightWidth(startWidth + startX - moveEvent.clientX, expanded),
      );
    };
    const onUp = (upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const finalWidth = clampRightWidth(
        startWidth + startX - upEvent.clientX,
        expanded,
      );
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

  useEffect(() => {
    const onResize = () => setRightWidth((width) => clampRightWidth(width));
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightExpanded]);

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
        cur.skills === s.skills &&
        cur.mcps === s.mcps
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

  /** 写入指定终端标签 agent 输入的核心链路（pty_write；send=true 时末尾补 \r 直接发送，
      缺省不自动回车、用户检查后发送）。右栏选段（活跃标签）与阅读区（阅读会话标签）共用；
      返回 null 表示已写入，返回字符串为要展示给用户的提示。 */
  const injectToTab = useCallback(
    async (tabId: string, data: string, send?: boolean): Promise<string | null> => {
      const s = statuses[tabId];
      if (!s?.running || !s.ptyId) {
        return "当前标签没有运行中的 Agent，请先启动再试";
      }
      try {
        if (send) tabActionsRef.current.get(tabId)?.noteUserTurn();
        await invoke("pty_write", {
          ptyId: s.ptyId,
          data: send ? `${data}\r` : data,
        });
        return null;
      } catch (reason) {
        return `终端输入失败：${String(reason)}`;
      }
    },
    [statuses],
  );

  /** 写入当前活跃终端标签 agent 输入（PDF 问 AI 与 md 讨论/改写共用） */
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
    if (!action) return "当前终端标签尚未准备好";
    setChatBusy(true);
    try {
      const result = await action.sendMessage(text);
      if (result.needsTerminal) switchSurface("terminal");
      return result.error;
    } finally {
      setChatBusy(false);
    }
  }

  /** 聊天层暂停当前生成：往 PTY 写 Esc（不是 Ctrl+C 硬中断——不退出会话，
      Codex/Claude 等生成中按 Esc 是停下当前回合、回到可继续输入的提示符。
      Grok Build 走不到这里：非 prompt 态 Esc 会触发整进程退出确认，
      ChatComposer 按 escInterruptSafe 对 grok 不渲染停止钮） */
  function chatInterrupt() {
    tabActionsRef.current.get(focusedId)?.writePty("\x1b");
  }

  /** 聊天层审批卡片按键：批准 y / 拒绝 n / 取消 Esc（单键热键，各 CLI TUI 通用形态；
      kimi 类 CSI-u 终端的 Enter 改写不涉及——审批热键不回车） */
  function chatApprovalKey(key: "y" | "n" | "esc") {
    tabActionsRef.current
      .get(focusedId)
      ?.writePty(key === "esc" ? "\x1b" : key);
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
      effort?: string | null;
      forkSource?: { agent: string; sessionId: string };
      /** 复用键（pendingTerminal.reuseKey 透传）：重复入口切标签而不是新开 */
      reuseKey?: string;
      /** 步骤认领（pendingTerminal.stepName 透传）：launch 时登记会话归步骤 */
      stepName?: string;
      runId?: string;
      taskId?: string;
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
        effort: init?.effort,
        forkSource: init?.forkSource,
        reuseKey: init?.reuseKey,
        stepName: init?.stepName,
        runId: init?.runId,
        taskId: init?.taskId,
      };
      setTabs((prev) => [...prev, t]);
      setActiveId(t.id);
      return t.id;
    },
    [],
  );

  function relativeBriefPath(filePath: string, cwd: string): string {
    // Tauri 在 Windows 返回反斜杠路径；prompt 中统一用 `/`，同时用不区分大小写
    // 的比较处理盘符大小写差异。超出 cwd 时保留原路径，避免错误地截掉前缀。
    const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
    const root = normalize(cwd);
    const target = normalize(filePath);
    const rootCmp = root.toLowerCase();
    const targetCmp = target.toLowerCase();
    return targetCmp.startsWith(`${rootCmp}/`)
      ? target.slice(root.length + 1)
      : target;
  }

  async function forkChat(fromTabId = focusedId) {
    const source = sessionByTab[fromTabId];
    const status = statuses[fromTabId];
    if (!source?.file || !source.sessionId || !source.agentId || !status) return;
    setChatBusy(true);
    try {
      const brief = await invoke<{ filePath: string; summary: string }>(
        "build_handoff_brief",
        {
          agent: source.agentId,
          sessionId: source.sessionId,
          filePath: source.file,
          cwd: status.cwd,
          title: source.title,
          targetPath: null,
        },
      );
      await invoke("mark_handoff", {
        targetAgent: source.agentId,
        targetCwd: status.cwd,
        fromAgent: source.agentId,
        fromSessionId: source.sessionId,
      });
      const profileId =
        status.profileId || profiles.find((p) => p.agent === source.agentId)?.id;
      if (!profileId) {
        throw new Error(`找不到 ${agentLabel(source.agentId)} 的连接配置，请先在连接页创建或恢复配置`);
      }
      const prompt = `读 ${relativeBriefPath(brief.filePath, status.cwd)} 分叉简报，在此基础上继续完成任务`;
      const promptSupported = await invoke<HandoffTargetDto[]>("handoff_targets")
        .then((targets) => targets.find((target) => target.id === source.agentId)?.promptSupported)
        .catch(() => source.agentId !== "kimi");
      const forkTabId = addTab({
        cwd: status.cwd,
        title: `分叉 · ${source.title || "当前对话"}`,
        agentId: source.agentId,
        profileId,
        model: status.model,
        initialPrompt: prompt,
        readonly: true,
        permission: "discuss",
        forkSource: { agent: source.agentId, sessionId: source.sessionId },
        autoStart: true,
      });
      // 不支持启动注入的 CLI（当前为 Kimi）必须直接落到终端，避免把“已启动”
      // 误呈现成聊天已发送；用户可在终端粘贴已复制的分叉指令。
      setSurfaceModeByTab((prev) => ({
        ...prev,
        [forkTabId]: promptSupported === false ? "terminal" : "chat",
      }));
    } catch (e) {
      void alertDialog(`新建分叉聊天失败：${String(e)}`);
    } finally {
      setChatBusy(false);
    }
  }

  /** 工作树「在此打开新终端」：新建标签并预填 cwd，用户选 agent/profile 后启动 */
  const openTerminalAt = useCallback(
    (path: string) => {
      addTab({ cwd: path, title: basename(path) });
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
      appSettings?.theme ?? "midnight",
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
      // 会话恢复：显式带了原配置（runId 恢复）时优先原配置；否则依次
      // autoLaunchProfileId → ccode.lastProfile → 该 agent 首个配置；
      // Codex 三条渠道分开挑（网关 / ChatGPT 官方 / 客户端磁盘渠道），见 pickResumeProfile。
      const launchAgentId = pt.agentId ?? pt.resume?.agentId;
      let profileId = pt.profileId;
      let model = pt.model;
      let autoStart = !!pt.resume || !!pt.autoStart;
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
            "已换成项目默认的连接。这条对话上次用的渠道不同，确认后点运行。",
            "info",
          );
        }
      }
      // 复用键：已有同 key 标签就切过去，不再新开（「快速开聊」「跟 AI 商量一下」等
      // 重复入口防标签堆积；恢复出的占位标签不带 reuseKey，不参与复用——会话已断，新开才诚实）。
      // 复用时不跳过右侧收尾：previewPath/rightTab 等交接对复用标签同样生效（重进即回到该有的布局）
      let tabId: string | null = null;
      const adoptExisting = (existing: (typeof tabs)[number]) => {
        tabId = existing.id;
        setActiveId(existing.id);
        const prompt = pt.initialPrompt?.trim();
        if (prompt) {
          pendingChatInjectRef.current = { tabId: existing.id, prompt };
          setInjectTick((n) => n + 1);
        }
        const st = statusesRef.current[existing.id];
        // Agent 还在跑：只聚焦。回落 shell / 已退出：同一标签再 launch，不另开一套抢锁。
        const kick = pt.resume
          ? shouldRelaunchResumeTab(st)
          : Boolean(pt.autoStart && st && !st.running);
        if (kick) {
          setTabs((prev) =>
            prev.map((t) =>
              t.id === existing.id
                ? {
                    ...t,
                    resumeKick: (t.resumeKick ?? 0) + 1,
                    ...(pt.resume
                      ? {
                          resumeSessionId: pt.resume.sessionId,
                          resumeProvider: pt.resume.provider ?? undefined,
                          initialAgentId: pt.resume.agentId,
                        }
                      : {}),
                  }
                : t,
            ),
          );
        }
      };
      if (pt.reuseKey) {
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
        reuseKey: pt.reuseKey,
        stepName: pt.stepName,
        runId: pt.runId,
        taskId: pt.taskId,
      });
      if (tabId && pt.resume && pt.initialPrompt?.trim()) {
        pendingChatInjectRef.current = {
          tabId,
          prompt: pt.initialPrompt.trim(),
        };
        setInjectTick((n) => n + 1);
      }
      // 纯 shell/脚本标签（登录、CLI 自更新、run 脚本）没有会话可供聊天层展示——
      // 显式落终端面（当前默认面层已是终端，这里守住「未来默认值再变也不回到 chat」的口径；
      // 同分叉不支持注入时落终端的处理，3688 行附近）
      // 闭包不保留 let 的收窄：进回调前用 const 固定，否则 [tabId] 推宽回 string | null 报 TS2464
      const launchedTabId = tabId;
      if (launchedTabId && (pt.shellOnly || pt.prefillCommand)) {
        setSurfaceModeByTab((prev) => ({ ...prev, [launchedTabId]: "terminal" }));
      }
      if (launchedTabId && pt.surface === "chat") {
        setSurfaceModeByTab((prev) => ({ ...prev, [launchedTabId]: "chat" }));
      }
      if (launchedTabId && pt.surface === "terminal") {
        setSurfaceModeByTab((prev) => ({ ...prev, [launchedTabId]: "terminal" }));
      }
      // run 脚本标签：登记 nonconcurrent 互斥追踪
      if (pt.wsId && tabId) setRunningScript(pt.wsId, tabId);
      // 「快速开聊」：落到最干净的终端——收起工作树与右栏，只剩标签条 + 终端。
      // 走既有文件树/成果面板开关，不再另开「专注终端」。
      // 理由：随手聊没有项目上下文——文件树是空目录、改动面板是「不是 git 仓库」、
      // 对话面板要等会话关联，三个面板都没东西可给，摆着只是噪音
      if (pt.clean) {
        persistTreeOpen(false);
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
        if (pt.previewPath.toLowerCase().endsWith(".pdf")) {
          setRightExpanded(true);
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
    // PDF 是阅读动作：打开时自动进入专注内容（隐藏工作树），用户可随时 ⇲/Esc 还原
    if (previewReq.path.toLowerCase().endsWith(".pdf")) setRightExpanded(true);
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
    });
  }, [visible, readerReq, setReaderReq]);

  const readerKey = reader ? readerReuseKey(reader.projectRoot) : null;
  /** 阅读会话标签（reuseKey 找回：退出再进接着聊；恢复出的占位标签不带 reuseKey 不参与复用） */
  const readerTabId = readerKey
    ? (tabs.find((t) => t.reuseKey === readerKey)?.id ?? null)
    : null;
  const [readerNeedsProfile, setReaderNeedsProfile] = useState(false);
  /** 自动起会话的一次性标记：用户手动关掉阅读会话标签后不连环重建（栏内给「重新启动」入口） */
  const readerTriedRef = useRef<string | null>(null);
  const [readerAgentTick, setReaderAgentTick] = useState(0);
  useEffect(() => {
    if (!reader) readerTriedRef.current = null;
  }, [reader]);

  /** 阅读会话的启动配置：agent 跟随启动栏上次选择；profile 按既有解析顺序
      （显式默认 settings.defaultProfiles > 上次使用 > 首个可见 > 首个，与启动栏一致） */
  function resolveReaderLaunch(): { agentId: string; profileId: string } {
    const st = useAppStore.getState();
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
    };
  }

  /** 派一个阅读会话标签（项目根 + 默认配置 + autoStart + reuseKey，快速开聊同款机制）；
      返回 false = 无可用配置（Agent 栏显示引导卡） */
  function dispatchReaderSession(r: {
    pdfPath: string;
    projectRoot: string;
  }): boolean {
    const launch = resolveReaderLaunch();
    if (!launch.profileId) return false;
    setPendingTerminal({
      cwd: r.projectRoot,
      extraEnv: {},
      title: `阅读 · ${basename(r.pdfPath).replace(/\.pdf$/i, "")}`,
      agentId: launch.agentId,
      profileId: launch.profileId,
      autoStart: true,
      reuseKey: readerReuseKey(r.projectRoot),
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
    const ok = dispatchReaderSession(reader);
    // 无配置不记一次性标记：配置页加好配置后 profiles 变化会自然重试
    readerTriedRef.current = ok ? readerKey : null;
    setReaderNeedsProfile(!ok);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, reader, readerKey, readerTabId, profiles, readerAgentTick]);

  /** 阅读区注入（选段「↵ 直接发送」/ 输入框回车）：走与右栏选段同一条 injectToTab 链路，目标换成阅读会话标签 */
  const injectToReader = useCallback(
    (data: string, send?: boolean): Promise<string | null> =>
      readerTabId
        ? injectToTab(readerTabId, data, send)
        : Promise.resolve("阅读会话还没建好，稍等片刻再试"),
    [injectToTab, readerTabId],
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

  // 阅读区打开时把阅读会话标签提到活跃（右栏 xterm 就是那个标签的画面；
  // 退出阅读区时该标签随 closeReader 一起关掉，不再「正好落在它上面」）
  useEffect(() => {
    if (!reader || !readerTabId || activeId === readerTabId) return;
    activateTab(readerTabId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reader, readerTabId, activeId]);

  // 阅读区打开期间：阅读会话标签的 xterm 宿主节点移进覆盖层右栏槽位，关闭时移回原标签槽位
  // （Monaco 宿主移动同款先例：DOM 搬移不重建，PTY/xterm/scrollback 全程不丢；
  // 容器上的 ResizeObserver 在尺寸变化时自动 fit，无需额外触发）。
  // 槽位用回调 ref + state：右栏收起/展开导致槽位卸载重建时 effect 随之复位/再搬。
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

  // 步骤胶囊「📁」交来的文件树切根请求：复用 enterCwd/externalCwd「真进入」机制，
  // 落地到活动标签启动栏（shell 存活时写 cd），文件树根随活动标签 cwd 切换
  const enterCwdReq = useAppStore((s) => s.enterCwdReq);
  const setEnterCwdReq = useAppStore((s) => s.setEnterCwdReq);
  useEffect(() => {
    if (!visible || !enterCwdReq) return;
    setEnterCwdReq(null);
    // 评审覆盖层会挡住文件树，先退出（同 previewReq 消费语义）
    setReviewPath(null);
    setReviewRunId(null);
    setReviewAction(null);
    setEnterCwd(enterCwdReq);
  }, [visible, enterCwdReq, setEnterCwdReq]);

  /** PDF 选段「整理为笔记」（§11.4 P2b）：有精读步骤则写入对应工作区 inbox 并预填终端；
      无研究流程时写入项目根 notes/inbox.md。 */
  const organizePdfExcerpt = useCallback(
    async (
      text: string,
      page: number,
      fileName: string,
    ): Promise<PdfActionResult> => {
      const pdfPath = preview?.path;
      if (!pdfPath) return { ok: false, msg: "预览已关闭，请重新打开 PDF" };
      let owner = await invoke<ProjectDto | null>("pdf_owner_project", {
        pdfPath,
      });
      if (!owner) {
        const root = await offerAddLitProject(
          pdfPath,
          statuses[focusedId]?.cwd ?? preview?.root,
        );
        if (!root) return { ok: false, msg: "未添加项目，笔记没有写入" };
        owner = { path: root, name: "", createdAt: null, lastOpenedAt: null };
      }
      const read = await invoke<ProjectConfigReadDto>("read_project_config", {
        path: owner.path,
      });
      const cfg = read.config;
      const date = new Date().toLocaleDateString("sv-SE");
      const chunk = `\n## ${fileName} · 第 ${page} 页 · ${date}\n\n${text}\n`;
      const target = notesInboxTarget(cfg);
      if (target.kind === "project-root") {
        await invoke("append_workspace_inbox", {
          worktreePath: owner.path,
          content: chunk,
        });
        return {
          ok: true,
          msg: "已写入项目 notes/inbox.md。可在文件树打开这份笔记继续写。",
        };
      }
      const step =
        cfg.steps.find((s) => s.workspaceName === target.name) ?? cfg.steps[1];
      // 已有活跃工作区直接追加；没有则走一键开步链路（同 ProjectGroup.startStep）
      const all = await invoke<WorkspaceDto[]>("list_workspaces");
      const samePath = (a: string, b: string) =>
        a.replace(/[\\/]+$/, "") === b.replace(/[\\/]+$/, "");
      let ws = all.find(
        (w) =>
          samePath(w.repoPath, owner.path) &&
          w.name === target.name &&
          w.status === "active",
      );
      if (!ws) {
        await invoke("ensure_git_repo", { path: owner.path });
        ws = await invoke<WorkspaceDto>("create_workspace", {
          repoPath: owner.path,
          name: target.name,
        });
        let skillMeta: Record<string, string> | undefined;
        let providesByName: Record<string, string[]> | undefined;
        if (step?.skills.length) {
          try {
            const lib = await invoke<SkillDto[]>("list_skills");
            skillMeta = Object.fromEntries(
              lib.map((skill) => [skill.name, skill.description]),
            );
            providesByName = Object.fromEntries(
              lib.map((skill) => [skill.name, skill.provides ?? []]),
            );
          } catch {
            /* 技能库不可读时只列技能名 */
          }
        }
        if (step) {
          try {
            await invoke("write_workspace_task_md", {
              worktreePath: ws.worktreePath,
              content: renderTaskMd(step, cfg, owner.path, undefined, skillMeta, providesByName),
            });
          } catch {
            /* 简报仍可在 project.toml 与步骤「编辑简报」中查看 */
          }
        }
      }
      await invoke("append_workspace_inbox", {
        worktreePath: ws.worktreePath,
        content: chunk,
      });
      const pairs = await invoke<[string, string][]>("workspace_env_for", {
        worktreePath: ws.worktreePath,
      });
      const last = (() => {
        try {
          return JSON.parse(
            localStorage.getItem(`ccode.wsLast.${ws.worktreePath}`) ?? "{}",
          ) as Partial<{ agentId: string; profileId: string; model: string }>;
        } catch {
          return {};
        }
      })();
      setPendingTerminal({
        cwd: ws.worktreePath,
        extraEnv: Object.fromEntries(pairs),
        title: ws.name,
        agentId: last.agentId,
        profileId: last.profileId,
        model: last.model,
        initialPrompt: ORGANIZE_NOTES_PROMPT,
      });
      return {
        ok: true,
        msg: `已写入工作区「${ws.name}」的 notes/inbox.md，并预填了终端启动（确认配置后点「启动」）`,
      };
    },
    [preview, focusedId, statuses, setPendingTerminal],
  );

  // 会话页「进行中」反向跳转：聚焦指定标签
  const focusTabId = useAppStore((s) => s.focusTabId);
  const focusTab = useAppStore((s) => s.focusTab);
  useEffect(() => {
    if (visible && focusTabId) {
      if (tabs.some((t) => t.id === focusTabId)) activateTab(focusTabId);
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

  /** 关闭标签守卫：仅「agent 还在跑」的标签弹确认（shell/已退出/未启动不弹）。
      存活判定以后端 pty_has_running_process 为准；命令不存在或报错时守卫静默跳过，不阻塞关闭。 */
  async function requestCloseTab(id: string) {
    const s = statusesRef.current[id];
    if (s?.running && s.ptyId) {
      try {
        const alive = await invoke<boolean>("pty_has_running_process", {
          ptyId: s.ptyId,
        });
        if (
          alive &&
          !(await confirmDialog("该标签的 Agent 还在运行，确认关闭并终止？", {
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

  function doCloseTab(id: string) {
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    let nextActiveId = activeId;
    if (next.length === 0) {
      // 至少保留一个标签
      const fresh: Tab = {
        id: crypto.randomUUID(),
        skipSeed: true,
      };
      nextActiveId = fresh.id;
      setTabs([fresh]);
      setActiveId(fresh.id);
    } else {
      setTabs(next);
      if (id === activeId) {
        nextActiveId = next[Math.max(0, idx - 1)].id;
        setActiveId(nextActiveId);
      }
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

  // 关窗守卫：还有 agent 在跑的标签时，关窗前统一确认一次；确认后放行（allowCloseRef 防重入）。
  // 后端命令未就绪时对应标签不计入，静默放行。
  const allowWindowCloseRef = useRef(false);
  useEffect(() => {
    const win = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    win
      .onCloseRequested((event) => {
        if (allowWindowCloseRef.current) return;
        // 无论是否拦截确认，先让各标签终端存一版回放快照（同步分发，
        // invoke 异步落盘，pagehide 会再兜底一次）
        window.dispatchEvent(new CustomEvent("mesa:save-terminal-replays"));
        const candidates = Object.values(statusesRef.current).filter(
          (s) => s.running && s.ptyId,
        );
        if (candidates.length === 0) {
          // 无 agent 也要给回放 IPC 留出落盘时间（120ms，体感无感），
          // 否则立即销毁 webview 时快照可能没写完（2026-10-11 复核）
          event.preventDefault();
          void (async () => {
            await new Promise((resolve) => setTimeout(resolve, 120));
            allowWindowCloseRef.current = true;
            await win.close().catch(() => exit(0));
          })();
          return;
        }
        event.preventDefault();
        void (async () => {
          let alive = 0;
          for (const s of candidates) {
            try {
              if (
                await invoke<boolean>("pty_has_running_process", {
                  ptyId: s.ptyId,
                })
              )
                alive++;
            } catch {
              /* 命令未就绪：该标签不计入守卫 */
            }
          }
          if (
            alive > 0 &&
            !(await confirmDialog(
              `还有 ${alive} 个标签的 Agent 正在运行，确认退出并终止？`,
              { danger: true },
            ))
          )
            return;
          allowWindowCloseRef.current = true;
          // 等一小拍让回放 IPC 落盘再关窗
          await new Promise((resolve) => setTimeout(resolve, 200));
          // 正常路径走 window.close（触发 onCloseRequested 但被放行）；
          // close 被权限拒绝时兜底直接退出进程（process:default 已授权）
          await win.close().catch(() => exit(0));
        })();
      })
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      });
    // Rust 侧的关窗前置信号（lib.rs on_window_event）：红绿灯关窗时上面的
    // onCloseRequested 实机不执行（2026-10-11 探针实证），可靠路径是 Rust 拦一次、
    // 发这条事件、等 350ms 再放行——这里接住并分发各标签的回放存盘
    let unlistenFlush: (() => void) | undefined;
    void listen("mesa:flush-before-close", () => {
      window.dispatchEvent(new CustomEvent("mesa:save-terminal-replays"));
    }).then((u) => {
      if (disposed) u();
      else unlistenFlush = u;
    });
    return () => {
      disposed = true;
      unlisten?.();
      unlistenFlush?.();
    };
  }, []);

  const railBtn =
    "flex h-7 w-7 items-center justify-center rounded-sm text-xs text-l4 hover:bg-hover hover:text-l2";

  // 运行中输入汇总（P5）：状态全部来自现有 statuses 上报，不新增轮询；
  // inputs 镜像进 store（terminalRunInputs），供工作区首页「待你处理」跨页聚合只读
  // （排序/分类由首页自行用 buildRunOverview 完成）。
  const setTerminalRunInputs = useAppStore((s) => s.setTerminalRunInputs);
  const runInputs: RunOverviewInput[] = useMemo(
    () =>
      tabs.map((t) => {
        const s = statuses[t.id];
        return {
          tabId: t.id,
          title: s?.title ?? "终端",
          agentId: s?.agentId ?? "",
          model: s?.model ?? "",
          cwd: s?.cwd ?? "",
          running: s?.running ?? false,
          shell: s?.shell ?? false,
          attention: s?.attention ?? null,
          reuseKey: t.reuseKey,
          runId: s?.runId ?? t.runId,
          taskId: t.taskId,
        };
      }),
    [tabs, statuses],
  );
  useEffect(() => {
    setTerminalRunInputs(runInputs);
  }, [runInputs, setTerminalRunInputs]);

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
    >
      {/* 左栏：工作树（专注内容下整体隐藏；默认完全收起，标签栏左侧钮打开） */}
      {!rightExpanded && treeOpen && (
        <div className="flex w-56 shrink-0 flex-col border-r border-hairline bg-rail2">
          <div className="flex h-8 shrink-0 items-center gap-2 px-2">
            <span className="mr-auto text-xs font-medium text-l3">
              上下文
            </span>
            <button
              onClick={() => setShowHidden((v) => !v)}
              title={showHidden ? "隐藏隐藏文件" : "显示隐藏文件"}
              className={`flex h-7 w-7 items-center justify-center rounded-sm text-xs hover:bg-hover ${
                showHidden ? "text-l1" : "text-l4 hover:text-l2"
              }`}
            >
              {showHidden ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
            <button
              onClick={() => setRefreshKey((k) => k + 1)}
              title="刷新文件树"
              className={railBtn}
            >
              <RefreshCw size={14} />
            </button>
            <button
              type="button"
              onClick={() => persistTreeOpen(false)}
              title="隐藏文件树"
              aria-label="隐藏文件树"
              className={railBtn}
            >
              <PanelLeftClose size={14} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto py-1">
            <FileTree
              cwd={activeCwd}
              showHidden={showHidden}
              onShowHidden={setShowHidden}
              refreshKey={refreshKey}
              onOpenFile={openPreview}
              onOpenTerminal={openTerminalAt}
              onFsEvent={bumpFsChangeTick}
              onEnterProject={setEnterCwd}
              onRootChange={closePreviewForRootChange}
              onRootNavigated={setTreeRoot}
              onRecoverDirectory={() =>
                tabActionsRef.current.get(focusedId)?.chooseCwd()
              }
              onOpenReader={(path) =>
                void (/\.pdf$/i.test(path)
                  ? openReaderForPdf(path)
                  : openReaderForNote(path))
              }
              belowRecent={
                /* 项目区：进行中的已添加项目 + 科研活跃工作区；当前标签置顶 */
                <ProjectRail
                  cwd={activeCwd}
                  pageVisible={visible}
                  refreshKey={refreshKey}
                  agentRunning={statuses[focusedId]?.running ?? false}
                  tabs={Object.values(statuses).map((s) => ({
                    cwd: s.cwd,
                    running: s.running,
                    attention: s.attention,
                  }))}
                  onEnter={setEnterCwd}
                  onOpenNewTab={openTerminalAt}
                />
              }
            />
          </div>
        </div>
      )}

      {/* 中带：终端标签区。向上盖 1px，挡住顶栏透出的那条窗口黑缝。 */}
      <div className="relative -mt-px flex min-w-0 flex-1 flex-col bg-canvas">
        {/* 顶部标签条：常驻中带顶部 */}
        <div className="flex h-9 items-center gap-1 overflow-hidden px-2">
          <div className="min-w-0 flex-1 overflow-x-auto">
            <div className="flex w-full min-w-0 items-center">
          {tabs.map((t, tabIndex) => {
            const s = statuses[t.id];
            const active = t.id === activeId;
            // 注意力点：仅 待确认 渲染黄点，无状态/空闲不渲染（降噪）；「已回复」不打点——
            // 回合结束每轮都发生，不是待办。与关闭 × 一样只在悬停 / 激活 / 键盘聚焦时显现
            // （待确认的全局注意力入口在顶栏收件箱，标签级只做 hover 提示）。
            const confirmDot =
              s?.attention === "confirm"
                ? { cls: "text-warn-text", tip: "待确认" }
                : null;
            // 拖拽（Ghostty 式）：源标签跟手平移；位于「原位置→目标位置」之间的标签
            // 各退/进一个槽位（滑动让位）；松手时源标签 transition 吸附到目标槽位后重排
            const isDragSource = tabDrag?.id === t.id;
            let shift = 0;
            if (tabDrag && !isDragSource) {
              const { from, target, rects } = tabDrag;
              if (from < target && tabIndex > from && tabIndex <= target) {
                shift = rects[tabIndex - 1].left - rects[tabIndex].left;
              } else if (from > target && tabIndex < from && tabIndex >= target) {
                shift = rects[tabIndex + 1].left - rects[tabIndex].left;
              }
            }
            return (
              <Fragment key={t.id}>
                {/* 标签间分隔：居中短刻度线（h-4 w-px），全高边框太重。
                    刻度只出现在两颗未激活标签之间——紧贴激活胶囊的刻度会撞上胶囊边。
                    注意这与启动栏分段工具条无关：那边是 gap 分段的胶囊组、不用分隔线
                    （divide 方案被否为「粘在一起」，见 design-system.md）；标签是平铺的
                    并列项，刻度承担的是分组边界，两处不共用口径。 */}
                {tabIndex > 0 &&
                  tabs[tabIndex - 1].id !== activeId &&
                  !active && (
                    <span
                      aria-hidden="true"
                      className="h-4 w-px shrink-0 bg-field"
                    />
                  )}
                <div
                  data-tab-id={t.id}
                onClick={() => {
                  // 拖拽落定后的那次 click 吞掉（拖排序不该顺手切换标签）
                  if (suppressTabClickRef.current) {
                    suppressTabClickRef.current = false;
                    return;
                  }
                  activateTab(t.id);
                }}
                onPointerDown={(e) => onTabPointerDown(e, t.id)}
                style={{
                  transform:
                    isDragSource && tabDrag
                      ? `translateX(${tabDrag.dx}px)`
                      : shift !== 0
                        ? `translateX(${shift}px)`
                        : undefined,
                  // 让位标签始终滑动；源标签跟手不动画、吸附时才有
                  transition:
                    tabDrag && (!isDragSource || tabDrag.settling)
                      ? "transform 150ms ease"
                      : undefined,
                  // 源标签浮在让位标签之上（零阴影体系下用层级表达浮起）
                  position: isDragSource ? "relative" : undefined,
                  zIndex: isDragSource ? 10 : undefined,
                }}
                className={`group/tab flex h-8 min-w-[72px] flex-1 basis-0 cursor-pointer items-center gap-1.5 rounded-full border text-xs ${
                  tabIndex === 0 && !rightExpanded && !treeOpen ? "pl-1 pr-2.5" : "px-2.5"
                } ${
                  active
                    ? "border-field bg-raised text-l1"
                    : "border-transparent text-l3 hover:bg-hover hover:text-l1"
                } ${isDragSource ? "bg-raised" : ""}`}
              >
                {/* 「正在生成回答」：只认 working。8 段虚线按相位差闪 opacity
                    （合成器驱动，终端出字满载也不掉帧）；既不用 CSS rotate——
                    WKWebView 会让圆心晃，也不用 dashoffset 动画——主线程重绘，
                    xterm 渲染挤占时一卡一卡（2026-09-15 实测）。 */}
                {tabIndex === 0 && !rightExpanded && !treeOpen && (
                  <button
                    type="button"
                    title="显示文件树"
                    aria-label="显示文件树"
                    onPointerDown={(event) => event.stopPropagation()}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      persistTreeOpen(true);
                    }}
                    onClick={(event) => event.stopPropagation()}
                    className="flex size-6 shrink-0 items-center justify-center rounded-full text-l4 hover:bg-hover hover:text-l2"
                  >
                    <PanelLeftOpen size={15} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                )}
                {s?.attention === "working" && (
                  <span
                    className="inline-flex size-3 shrink-0 items-center justify-center"
                    title="生成回答中"
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      className="ccode-working-spinner text-l2"
                      aria-label="生成中"
                    >
                      {Array.from({ length: 8 }, (_, i) => (
                        <circle
                          key={i}
                          cx="12"
                          cy="12"
                          r="9"
                          pathLength="8"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="butt"
                          strokeDasharray="1.5 6.5"
                          strokeDashoffset={-i}
                        />
                      ))}
                    </svg>
                  </span>
                )}
                {confirmDot && (
                  <span
                    className={`shrink-0 text-micro ${confirmDot.cls} ${
                      active
                        ? ""
                        : "invisible group-hover/tab:visible group-focus-within/tab:visible"
                    }`}
                    title={confirmDot.tip}
                  >
                    ●
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">
                  {s?.title && s.title !== "终端" ? s.title : "终端"}
                </span>
                {(() => {
                  // 任务进度徽章（终端 OSC 9;4 上报）：后台跑长任务时标签条可见，
                  // 不用切过去盯；state 0 = 结束不显示，1 带百分比，2 = 错误（!），
                  // 3/4 = 进行中/暂停（…）
                  const p = tabProgress[t.id];
                  if (!p || p.state === 0) return null;
                  const label =
                    p.state === 1 && p.progress != null
                      ? `${Math.round(p.progress)}%`
                      : p.state === 2
                        ? "!"
                        : "…";
                  return (
                    <span
                      className={`shrink-0 text-micro ${
                        p.state === 2 ? "text-err-text" : "text-l4"
                      }`}
                      title={
                        p.state === 2
                          ? "任务报错（终端上报）"
                          : "任务进度（终端上报）"
                      }
                    >
                      {label}
                    </span>
                  );
                })()}
                {active && s?.ptyId && (
                  <button
                    type="button"
                    title="插入技能或 MCP"
                    aria-label="插入技能或 MCP"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      tabActionsRef.current.get(t.id)?.toggleInsert();
                    }}
                    className="flex size-5 shrink-0 items-center justify-center rounded-full text-l4 hover:bg-hover hover:text-l2"
                  >
                    <Sparkles size={13} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                )}
                {t.restored && (
                  <span
                    className="shrink-0 text-micro text-l4"
                    title="应用重启前未结束，点恢复任务"
                  >
                    恢复
                  </span>
                )}
                {splitActive && t.id === splitTabId && (
                  <span
                    className="shrink-0 rounded-sm bg-inset px-1 text-micro text-l3"
                    title="分屏右侧对照（点击交换到左侧）"
                  >
                    ◧
                  </span>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void requestCloseTab(t.id);
                  }}
                  aria-label="关闭标签"
                  className={`shrink-0 text-l4 hover:text-err-text focus-visible:visible ${active ? "" : "invisible group-hover/tab:visible"}`}
                >
                  ×
                </button>
              </div>
              </Fragment>
            );
          })}
            </div>
          </div>
          <button
            onClick={() => addTab()}
            title="新建终端标签"
            className="flex size-8 shrink-0 items-center justify-center rounded-full border border-hairline bg-inset text-sm text-l4 hover:border-field hover:bg-raised hover:text-l2"
          >
            ＋
          </button>
          {/* 收缩启动行被隐藏时的召回钮：身份信息状态栏虽有，插入/修改/⋯ 在行里 */}
          {compactBarHidden && (
            <button
              type="button"
              onClick={toggleCompactBar}
              title="显示启动配置行（插入 / 修改 / 更多操作）"
              aria-label="显示启动配置行"
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-l4 hover:bg-hover hover:text-l2"
            >
              <PanelTopOpen size={16} strokeWidth={1.8} aria-hidden="true" />
            </button>
          )}
          <span className="ml-2 flex shrink-0 items-center border-l border-hairline pl-2">
            <button
              type="button"
              onClick={() =>
                switchSurface(focusedSurfaceMode === "chat" ? "terminal" : "chat")
              }
              title={
                focusedSurfaceMode === "chat" ? "切换到终端" : "切换到聊天"
              }
              aria-label={
                focusedSurfaceMode === "chat" ? "切换到终端" : "切换到聊天"
              }
              className="flex size-7 items-center justify-center rounded-md text-l4 hover:bg-hover hover:text-l2"
            >
              {focusedSurfaceMode === "chat" ? (
                <MessageSquare size={14} strokeWidth={1.8} aria-hidden="true" />
              ) : (
                <SquareTerminal size={14} strokeWidth={1.8} aria-hidden="true" />
              )}
            </button>
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={toggleRightPanel}
              aria-pressed={rightOpen}
              title={rightOpen ? "隐藏成果面板" : "显示成果面板"}
              aria-label={rightOpen ? "隐藏成果面板" : "显示成果面板"}
              className={`flex size-7 items-center justify-center rounded-md transition-colors ${
                rightOpen
                  ? "bg-seg-sel text-l1"
                  : "text-l4 hover:bg-hover hover:text-l2"
              }`}
            >
              {rightOpen ? (
                <PanelRightClose size={14} strokeWidth={1.8} aria-hidden="true" />
              ) : (
                <PanelRightOpen size={14} strokeWidth={1.8} aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                if (focusedSurfaceMode === "chat") switchSurface("terminal");
                toggleSplit();
              }}
              disabled={!splitActive && tabs.length < 2}
              aria-pressed={splitActive}
              title={
                splitActive
                  ? "退出分屏"
                  : tabs.length < 2
                    ? "分屏对照（需要两个标签）"
                    : "分屏对照"
              }
              aria-label={
                splitActive
                  ? "退出分屏"
                  : tabs.length < 2
                    ? "分屏对照（需要两个标签）"
                    : "分屏对照"
              }
              className={`flex size-7 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                splitActive
                  ? "bg-seg-sel text-l1"
                  : "text-l4 hover:bg-hover hover:text-l2"
              }`}
            >
              <Columns2 size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => {
                if (focusedSurfaceMode === "chat" && !peekByTab[focusedId]) {
                  switchSurface("terminal");
                }
                tabActionsRef.current.get(focusedId)?.search();
              }}
              title="查找终端输出"
              aria-label="查找终端输出"
              className="flex size-7 items-center justify-center rounded-md text-l4 hover:bg-hover hover:text-l2"
            >
              <Search size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </span>
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
                layoutKey={`${rightOpen}-${Math.round(rightWidth)}-${rightExpanded}-${splitActive ? `split${Math.round(splitPct)}` : "single"}-${(surfaceModeByTab[t.id] ?? DEFAULT_SURFACE_MODE) === "chat" && peekByTab[t.id] ? "peek" : "full"}-${reader && readerTabId === t.id ? "reader" : "pane"}-${appSettings?.statusBar === false ? "nostatus" : "status"}`}
                embedInPeek={
                  (surfaceModeByTab[t.id] ?? DEFAULT_SURFACE_MODE) === "chat" &&
                  Boolean(peekByTab[t.id])
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
                externalCwd={t.id === focusedId ? enterCwd : null}
                onConsumeExternalCwd={consumeExternalCwd}
                onStatus={reportStatus}
                onSessionUpdate={reportSession}
                onActions={registerActions}
                onRestoreComplete={finishRestore}
                onConsumeResume={clearResumeSession}
                onForkChat={handleTabForkChat}
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
                          title="选择右侧对照显示的标签"
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
                          ? "关闭此 pane（退出分屏，保留当前标签）"
                          : "关闭此 pane（退出分屏，切换到对照标签）"
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
                      (surfaceModeByTab[t.id] ?? DEFAULT_SURFACE_MODE) ===
                      "chat";
                    const peek = Boolean(peekByTab[t.id]);
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
                      <ChatSurface
                        messages={sessionByTab[t.id]?.conv ?? []}
                        state={sessionByTab[t.id]?.state ?? "idle"}
                        syncState={sessionByTab[t.id]?.sync ?? "waiting"}
                        loading={sessionByTab[t.id]?.pendingReply ?? false}
                        cwd={statuses[t.id]?.cwd ?? t.initialCwd ?? null}
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
                        onOpenTerminal={() => switchSurface("terminal")}
                        active={chatOn}
                        agentId={agentKey ?? null}
                        confirmDetail={
                          sessionByTab[t.id]?.confirmDetail ?? null
                        }
                        onInterrupt={chatInterrupt}
                        onApprovalKey={chatApprovalKey}
                        peek={peek}
                        onTogglePeek={() => setPeek(t.id, !peek, true)}
                        onRequestPeek={() => setPeek(t.id, true)}
                        modelSwitch={det?.modelSwitch ?? null}
                        hooksEnabled={Boolean(
                          appSettings?.hooksAttention?.[agentKey ?? ""],
                        )}
                        hasOlder={sessionByTab[t.id]?.convCursor != null}
                        loadingOlder={sessionByTab[t.id]?.loadingOlder ?? false}
                        onLoadOlder={() =>
                          void tabActionsRef.current
                            .get(t.id)
                            ?.loadOlderConversation()
                        }
                        onChooseCwd={() =>
                          tabActionsRef.current.get(t.id)?.chooseCwd()
                        }
                      />
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
                    // 聊天原生变体：聊天层且 peek 未开（peek 里嵌的是终端画面，仍用终端同底语言）
                    const chatBar =
                      (surfaceModeByTab[t.id] ?? DEFAULT_SURFACE_MODE) ===
                        "chat" && !peekByTab[t.id];
                    return (
                      <TerminalStatusBar
                        variant={chatBar ? "chat" : "terminal"}
                        status={st}
                        fallbackCwd={t.initialCwd ?? ""}
                        profileId={st?.profileId ?? null}
                        profileName={prof?.name ?? null}
                        profileModels={prof?.models ?? []}
                        launchModel={st?.launchModel ?? null}
                        modelSwitch={det?.modelSwitch ?? null}
                        effort={det?.effort ?? null}
                        git={focused ? gitTotals : null}
                        mergeReady={focused ? mergeReadyWs : []}
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
                        colors={statusBarColors}
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
              const width = clampRightWidth(RIGHT_PANEL_DEFAULT_WIDTH, false);
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
            style={{ width: rightWidth }}
            className="flex shrink-0 flex-col border-l border-hairline bg-raised/70"
          >
            {/* 右侧工作台只保留文件与改动；聊天已经进入主工作区，避免同一会话重复显示。 */}
            <div className="group flex h-8 shrink-0 items-center gap-1 bg-raised/70 px-2">
              {RIGHT_TABS.map(({ key: k, label, symbol }) => {
                const gitBadge =
                  k === "git" && gitTotals && gitTotals.add + gitTotals.del > 0
                    ? gitTotals.add + gitTotals.del
                    : null;
                return (
                  <button
                    key={k}
                    onClick={() => setRightTab(k)}
                    onDoubleClick={toggleRightExpanded}
                    title={`${label}；双击${rightExpanded ? "退出专注内容" : "进入专注内容"}`}
                    className={`flex h-7 shrink-0 items-center gap-1 rounded-sm px-2.5 text-xs ${
                      rightTab === k
                        ? "bg-seg-sel text-l1"
                        : "text-l3 hover:text-l1"
                    }`}
                  >
                    <span className="text-micro text-l4">{symbol}</span>
                    {label}
                    {k === "preview" && previewDirty && (
                      <span className="ml-1 text-l3" title="有未保存的修改">
                        ●
                      </span>
                    )}
                    {gitBadge && (
                      <span className="ml-1 rounded-sm bg-ok px-1 text-ok-text">
                        +{gitBadge}
                      </span>
                    )}
                  </button>
                );
              })}
              {rightTab === "preview" && preview && previewFiles.length > 1 && (
                <span className="ml-1 flex items-center gap-0.5 text-micro text-l4">
                  <button type="button" onClick={() => switchPreview(-1)} disabled={previewFiles[0]?.path === preview.path} className="rounded px-1 hover:bg-hover disabled:opacity-30" title="上一个文件（↑）">↑</button>
                  <button type="button" onClick={() => switchPreview(1)} disabled={previewFiles[previewFiles.length - 1]?.path === preview.path} className="rounded px-1 hover:bg-hover disabled:opacity-30" title="下一个文件（↓）">↓</button>
                </span>
              )}
              {/* 右侧动作区：专注内容 + 收起。 */}
              <span className="ml-auto flex min-w-0 items-center gap-1 pl-1">
                <button
                  type="button"
                  onClick={toggleRightExpanded}
                  title={
                    rightExpanded
                      ? "退出专注内容（Esc，恢复工作树分栏）"
                      : "专注内容（暂时隐藏工作树，右栏铺满，Esc 退出）"
                  }
                  className={`flex size-7 shrink-0 items-center justify-center rounded-sm text-xs text-l4 hover:bg-hover hover:text-l1 ${hoverRevealClass}`}
                >
                  {rightExpanded ? "⇲" : "⇱"}
                </button>
                <button
                  onClick={closeRightPanel}
                  title="收起工作台"
                  className={`flex size-7 shrink-0 items-center justify-center rounded-sm text-xs text-l4 hover:bg-hover hover:text-l1 ${hoverRevealClass}`}
                >
                  ×
                </button>
              </span>
            </div>
            <div
              className={
                rightTab === "preview"
                  ? "flex min-h-0 flex-1 flex-col"
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
                  ) : /\.doc$/i.test(preview.path) ? (
                    <div className="p-3">
                      <p className="text-sm text-l3">
                        旧版 .doc 不能内嵌预览，请用 Word 另存为 .docx 后再打开。
                      </p>
                    </div>
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
              ) : (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="p-3">
                    <p className="text-sm text-l4">
                      在左侧工作树中单击文件预览
                    </p>
                  </div>
                </div>
              )}
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
          initialAction={reviewAction}
          initialActionKey={reviewRequestId}
          onClose={() => {
            setReviewPath(null);
            setReviewRunId(null);
            setReviewAction(null);
            setReviewRequestId(null);
          }}
        />
      )}

      {/* 沉浸式阅读区（z-40 页面模态档）：底下终端/PTY/右栏全程保持挂载，只是被盖住；
          右栏 xterm 由上面的 useLayoutEffect 把阅读会话标签的宿主节点搬进 termSlot */}
      {reader && (
        <ReaderOverlay
          pdfPath={reader.pdfPath}
          projectRoot={reader.projectRoot}
          notePath={reader.notePath ?? null}
          hasAgentTab={readerTabId !== null}
          agentTabId={readerTabId}
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
        />
      )}
    </div>
  );
}
