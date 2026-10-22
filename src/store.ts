import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { type Effect } from "@tauri-apps/api/window";
import { IS_WINDOWS } from "./hotkeys";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { DEFAULT_THEME_ID, isCustomThemeId, isLightTheme } from "./themes";
import { followedTheme } from "./theme-follow";
import {
  applyCustomThemeVars,
  clearCustomThemeVars,
  DEFAULT_CUSTOM_THEME,
  deriveThemeTokens,
  normalizeCustomTheme,
  type CustomThemeCard,
  type CustomThemeSeeds,
} from "./custom-theme";
import {
  cycleBrandState,
  enterChromeHidden,
  exitChromeHidden,
  toggleChromeHiddenState,
} from "./nav-capsule";
import { createSessionRefreshCoordinator } from "./session-refresh";
import {
  dismissHelp,
  dismissInboxItem,
  inboxSignature,
  filterDismissed,
  INBOX_DISMISSED_KEY,
  loadHelpDismissed,
  loadInboxDismissed,
} from "./inbox";
import {
  APP_UPDATE_CHECK_TIMEOUT_MS,
  appUpdateInboxFields,
  mergeAppUpdateInbox,
  summarizeUpdateCheckError,
  updaterProxyUrl,
  type AppUpdateStatus,
} from "./app-update";
import type { RunOverviewInput } from "./run-overview";
import type { DepCheckDto } from "./dep-check";
import type { AskAiFile } from "./ask-ai";
import type { SpotCheckSession } from "./spot-check";
import { toast } from "./toast";
import { phoneInboxFields } from "./phone-drop";
import { usePhoneDropStore } from "./phone-drop-store";
import {
  ONBOARDING_STORAGE_KEY,
  parseOnboarding,
  serializeOnboarding,
  type OnboardingState,
  type OnboardingStepId,
} from "./onboarding";
import type { ProjectSurfaceTab } from "./project-surface";
import type {
  BindingInput,
  DetectResult,
  Gateway,
  GatewayInput,
  HandoffBriefDto,
  Profile,
  ProfileInput,
  RepoDto,
  RunDto,
  SessionMetaDto,
  SurfaceMode,
  TaskCardDto,
} from "./types";

const RECENT_REPOS_CACHE_KEY = "ccode.recentRepos";
/** 应用更新检查代数：后一次检查作废前一次的结果，避免慢请求盖住新结果 */
let appUpdateCheckGen = 0;

function cachedRecentRepos(): RepoDto[] {
  try {
    const value = JSON.parse(
      localStorage.getItem(RECENT_REPOS_CACHE_KEY) ?? "[]",
    );
    return Array.isArray(value)
      ? value.filter(
          (repo): repo is RepoDto =>
            typeof repo?.path === "string" && typeof repo?.name === "string",
        )
      : [];
  } catch {
    return [];
  }
}

function loadOnboardingState(): OnboardingState {
  try {
    return parseOnboarding(localStorage.getItem(ONBOARDING_STORAGE_KEY));
  } catch {
    return parseOnboarding(null);
  }
}

/** 应用设置（SettingsPage；后端 get_settings/update_settings 契约） */
export interface AppSettings {
  terminalFontSize: number;
  terminalFontFamily?: string;
  /** 终端渲染器：auto（默认，WebGL）| dom（兼容）；旧值 webgl 与 auto 同义；只对新开的终端生效 */
  terminalRenderer?: string;
  /** 内置终端 shell：auto | powershell | pwsh | git-bash | cmd | zsh | bash | fish（设置 → 终端） */
  terminalShell?: string;
  /** Windows 上定时任务里的 Codex 用它自己的 Windows 沙箱（看过说明、确认过才是 true；用户 Codex 配置里有就照那个） */
  codexWinSandboxConsent?: boolean;
  terminalPalette?: string; // "auto"/缺省 = 跟随主题；其余为四套深色 + 四套配对浅色，见 terminal-palettes.ts
  scrollback: number;
  rateUsdCny: number;
  brewMirror: boolean;
  /** 长任务 OS 通知：注意力跃迁且窗口未聚焦时发系统通知（默认开） */
  notificationsEnabled: boolean;
  /** 会话自动命名（默认开）：聊完起名 + 打开对话页补名去重；关 = 全停，手改标题不受影响 */
  autoTitleSessions?: boolean;
  /** 内部对话保留期自动清理（默认开）与保留天数（默认 30），见 internal_sessions.rs */
  internalAutoClean?: boolean;
  internalRetentionDays?: number;
  /** 工作副本家目录的自定义基目录（实际根 `<基目录>/ccode`）；缺省 = ~/ccode。只经 set_workspace_root 写 */
  workspaceRoot?: string;
  /** 反馈邮箱直发配置（授权码另存 keys.json 0600，绝不在此对象/不回显） */
  feedbackSmtp?: {
    provider: string;
    host: string;
    port: number;
    tls: string;
    from: string;
  } | null;
  theme: string;
  /** 自定义主题三色（左栏/画布/强调）；theme 为 custom / custom-light 时生效 */
  customTheme?: CustomThemeSeeds | null;
  /** 另存的可点色卡 */
  customThemes?: CustomThemeCard[];
  /** 当前选中的另存色卡；改取色器后清空（回到正在调的自定义） */
  customThemeCardId?: string | null;
  /** ◈ AI 功能固定使用的 profile id；null/undefined = 自动（最近使用） */
  aiProfileId?: string | null;
  /** 专用配置里选中的模型；空 = 该配置的第一个模型 */
  aiModel?: string | null;
  /** ◈ AI 功能按功能独立配置：键 = 功能 key（commit/summarize/pr/distill/conflict/translate，
      见 ai.rs FN_* 常量），值 = profile id；键缺失 = 跟随默认（aiProfileId） */
  aiProfiles?: Record<string, string>;
  /** 与 aiProfiles 同键：该功能选中的模型；键缺失 = 该配置的第一个模型 */
  aiProfileModels?: Record<string, string>;
  /** 每个 agent 的默认 profile（agent id → profile id）：启动栏选完 agent 后预选它。
   *  解析顺序 显式默认 > 上次使用 > 首个配置 */
  defaultProfiles?: Record<string, string>;
  /** 启动时进入哪一页（页面 id）；缺省 = workbench */
  startPage?: string;
  /** 启动时的导航形态；缺省时尊重旧 navCollapsed 偏好 */
  startupNavMode?: "expanded" | "collapsed" | "hidden";
  /** 侧栏 / 顶栏罩色透明度（百分比挡位，见 Rust KNOWN_CHROME_OPACITIES）。
   *  乘在各主题自己的罩色基数上，一个值同时管侧栏与顶栏、深浅两套；
   *  100 = 各主题原有观感，也是缺省值。 */
  chromeOpacity?: number;
  /** 应用图标外观：system（跟随系统，缺省）/ dark / light——只换运行中的程序坞、主窗与托盘图标 */
  appIconStyle?: "system" | "dark" | "light";
  /** 聊天层阅读体验（设置 → 外观，表见 chat-style.ts，Rust 侧 KNOWN_CHAT_* 白名单） */
  chatFontSize?: "small" | "normal" | "large" | "xlarge";
  chatFontFamily?: "system" | "serif" | "mono";
  chatAccent?: "off" | "warm" | "amber" | "teal" | "violet";
  chatScrollbar?: "auto" | "always";
  /** 主题跟随系统深浅（缺省关）：开着时系统外观变化即把 theme 换成同名 twin 写回（theme-follow.ts）；
   *  原生窗口外观交还系统（setTheme(null)），自定义配色不跟随 */
  themeFollowSystem?: boolean;
  /** 顶部导航胶囊离开后的自动隐藏延迟（毫秒） */
  navCapsuleHideDelayMs?: number;
  /** 顶部导航胶囊**展开面**的内容显示：both（符号+文字）/icons（仅符号）/labels（仅文字）。
   *  只管展开态那排导航项；休眠面（「恢复侧栏」）恒带文字，不跟随此设置。 */
  navCapsuleDisplayMode?: "both" | "icons" | "labels";
  /** 顶部导航胶囊中显示的入口 id；缺省 = 全部显示 */
  navCapsuleVisibleItems?: string[];
  /** 顶部岛的跑完/跑挂播报开关（默认开）。关掉只影响岛上那一行字，
      系统通知与收件箱各自独立。 */
  navCapsuleRunAnnounce?: boolean;
  /** 「停用」的 profile id（字段名沿用旧称）：软停用 = 不被自动路径挑中，手动指定仍可用 */
  hiddenProfiles?: string[];
  /** 「设为全局」追踪：agent id → 上次由 Mesa 写入该 agent 全局配置的 profile id
      （只代表「上次写入」，Mesa 之外手改配置文件会失真；恢复备份后由后端清除） */
  activeGlobalProfiles?: Record<string, string>;
  /** 对话页「⇗ 外部恢复」的终端应用；auto/undefined = 按优先级探测 */
  externalTerminal?: string;
  /** 精确注意力标记（agent hooks 桥接）：agent id → 开关，键缺失 = 关；
      开/关走专用命令 set_hooks_attention（写各家 hooks 配置），勿单独 patch */
  hooksAttention?: Record<string, boolean>;
  /** 快捷键绑定（"mod+shift+k" 格式，mod=⌘/Ctrl；空串 = 禁用） */
  hotkeyPalette?: string;
  hotkeyHideChrome?: string;
  /** ⌘1–⌘9 页切整组总开关（关 = 全部页切绑定不生效） */
  hotkeyPageSwitch?: boolean;
  /** 页切逐页绑定：键 = 页面 id（hotkeys.ts PAGE_HOTKEY_DEFS），值 = 组合串；
      键缺失 = 该页用默认绑定（mod+1..mod+9） */
  hotkeyPages?: Record<string, string>;
  /** 想法期只读保护（卡片区「聊想法」，默认开）：开 = 支持的 CLI 注入只读/计划模式参数 +
      预填指令带不动文件约束；关 = 纯聊天 */
  discussReadonly?: boolean;
  /** 底部状态栏统一开关（默认开）：终端层与聊天层同进退；关 = 两层都不显示（旧 statusBarInChat 已迁移） */
  statusBar?: boolean;
  /** 向 agent 主动告知终端底色（Windows 专用，默认开）：ConPTY 吞掉 OSC 10/11
      底色查询，浅色主题下 agent 会回落深色；开 = attach 后主动推当前主题前景/底色 */
  terminalColorReport?: boolean;
  /** 出网代理（官方账号启动与登录注入 HTTPS_PROXY 等）；空 = 不注入。网关启动不走 */
  outboundProxy?: string | null;
  /** NO_PROXY；出网代理有值且此项空时默认 localhost,127.0.0.1,::1 */
  outboundNoProxy?: string | null;
  /** 机构访问前缀（EZproxy/OpenAthens 式）；空 = 未配置。会话 Cookie 另存后端 0600 文件 */
  institutionalPrefix?: string | null;
  /** 机构登录窗上次打开的地址（图书馆/CARSI 入口），便于一键重开 */
  institutionalLoginUrl?: string | null;
}

/** Windows 整窗 Mica 跟着 Mesa 主题走。配置里的 mica 只跟系统外观，
 *  深色主题配系统浅色时侧栏罩色会对不上。
 *  macOS 侧不走这里——那边的材质外观由 applyTheme 的 setTheme 一并管（同一个 light
 *  值同时决定 NSAppearance 和 mica 挡位，两个平台口径一致）。 */
function syncWindowsMica(light: boolean) {
  if (!IS_WINDOWS) return;
  void getCurrentWebviewWindow()
    .setEffects({
      effects: [(light ? "micaLight" : "micaDark") as Effect],
    })
    // 挂不上（Windows 10 等）：App.css 的 data-material=none 回到实心底，不让桌面透出来
    .catch(() => {
      document.documentElement.dataset.material = "none";
    });
}

/** 运行时切主题：Tailwind v4 @theme 的工具类引用 CSS 变量，覆盖 dataset.theme 即生效；
 *  同时同步原生窗口外观——原生 <select> 下拉/滚动条按 NSWindow appearance 渲染，
 *  只改 CSS 变量时深色主题下弹出的仍是系统浅色列表。
 *
 *  **窗口外观由本函数独占写入**，不要再在别处加 setTheme（App.tsx 一度也写过一次，
 *  两个写手互相覆盖：updateSettings 每次都调本函数，于是调一下「侧栏/顶栏透明度」
 *  就会 深→浅 闪一次）。开机态例外，由 Rust setup 侧先定，见 lib.rs。 */
export function applyTheme(
  id: string,
  customTheme?: CustomThemeSeeds | null,
  followSystem = false,
) {
  const root = document.documentElement;
  clearCustomThemeVars(root);
  if (isCustomThemeId(id)) {
    const derived = deriveThemeTokens(
      normalizeCustomTheme(customTheme) ?? DEFAULT_CUSTOM_THEME,
    );
    root.dataset.theme = derived.themeId;
    applyCustomThemeVars(root, derived.tokens);
    // 自定义主题的深浅现算得出（画布亮度），不必再走 id 判定。
    // 外观必须跟主题走：材质的底色由 NSAppearance 决定，主题浅而材质深时，
    // 浅色壳那层 78% 罩色压不住近黑的材质，四周缝与圆角处就渗黑边。
    const light = derived.light;
    void getCurrentWebviewWindow()
      .setTheme(light ? "light" : "dark")
      .catch(() => {});
    syncWindowsMica(light);
    return;
  }
  const theme = id || DEFAULT_THEME_ID;
  root.dataset.theme = theme;
  // 判定走 themes.ts 的 isLightTheme（该文件声明它是「原生窗口外观、终端调色板 twin、
  // 浅色分支」的单一出处），不要在这里另写后缀判断。
  const light = isLightTheme(theme);
  // 跟随系统时窗口外观交还系统（null）：强制外观会让 WebView 的 prefers-color-scheme
  // 也跟着被钉死，再也收不到系统切换。跟随态下 theme 由 syncThemeWithSystem 校正成与
  // 系统同深浅，材质与主题仍一致；自定义配色不跟随，上面分支照旧强制
  void getCurrentWebviewWindow()
    .setTheme(followSystem ? null : light ? "light" : "dark")
    .catch(() => {});
  syncWindowsMica(light);
}

/** 系统当前是否深色。只在窗口外观为 null（跟随态）时读得到真实系统值 */
function systemPrefersDark(): boolean | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** 跟随系统深浅：theme 与系统深浅不符时写回同名 twin（无变化即停，不会自激）。
 *  调用点：设置读入/每次写入后（盖住命令面板直接切到反向主题），以及系统外观变化事件 */
async function syncThemeWithSystem() {
  const s = useAppStore.getState().settings;
  if (!s?.themeFollowSystem) return;
  const dark = systemPrefersDark();
  if (dark === null) return;
  const next = followedTheme(s.theme, dark);
  if (next !== s.theme) await useAppStore.getState().updateSettings({ theme: next });
}

let themeFollowListening = false;
function ensureThemeFollowListener() {
  if (themeFollowListening || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  themeFollowListening = true;
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => void syncThemeWithSystem().catch(() => {}));
}

/** 工作区页 → 终端页的交接：新开一个标签，预填 cwd + 注入 env（如端口段） */
export interface PendingTerminal {
  cwd: string;
  extraEnv: Record<string, string>;
  title?: string;
  /** run 脚本：进入 shell 后立即写入的命令行 */
  prefillCommand?: string;
  /** run 脚本标签：只开 shell，不走 agent 启动流程 */
  shellOnly?: boolean;
  /** 直接启动 Custom Runtime，不经过 shell */
  customRuntimeId?: string;
  /** run 脚本来源的工作区 id（nonconcurrent 互斥追踪用） */
  wsId?: string;
  /** 会话恢复：以 --resume/--continue 语义重启该会话（SessionLink 确定性锁定） */
  resume?: {
    agentId: string;
    sessionId: string;
    /** 会话的 model_provider（codex rollout 元信息）：恢复时按它挑兼容 profile，
     *  "ccode" = 内联 provider 会话，必须用带 Base URL 的配置（见 resume-profile.ts） */
    provider?: string | null;
  };
  /** 指定启动配置（未给则按 ccode.lastProfile → 该 agent 首个配置兜底） */
  autoLaunchProfileId?: string;
  /** 预填启动栏（工作区记住上次配置） */
  agentId?: string;
  profileId?: string;
  model?: string;
  /** 建好标签就直接启动（不用再点一次「启动」）。会话恢复隐含为 true。
   *  「快速开聊」2026-10-17 起不置 true：落聊天空态，发第一句时才带着它启动（输入框里还能改选择）。
   *  找不到对应 profile 时自动降级为「只预填、不启动」（见 TerminalView 的 autoStart 守卫）。 */
  autoStart?: boolean;
  /** 一键开步预填的首条指令：启动时注入 CLI，启动成功后清除（一次性） */
  initialPrompt?: string;
  /** 打开后右栏直接落到指定页签（如卡片区「主仓改动」提醒跳到改动面板） */
  rightTab?: "git";
  /** 「最干净的终端」：落地即收起工作树与右栏（走既有文件树/成果面板开关，不再进专注终端）。
   *  给「快速开聊」用——没有项目上下文时三个面板都没东西可给，摆着只是噪音 */
  clean?: boolean;
  /** 开聊自动带开文件预览（路径 + 预览根）：一次性交接不落盘
      （terminal-tab-persistence 白名单本就不含它） */
  previewPath?: string;
  previewRoot?: string;
  /** 对外权限政策：只讨论 / 可改这棵树。缺省 write_tree。 */
  permission?: "discuss" | "write_tree";
  /** 可以改文件时的原生权限档（ask 请求批准 / auto / full）；缺省 = 按这家 CLI 本机设置。
      阅读会话固定「请求批准」（改笔记以外的文件先问） */
  permissionMode?: "ask" | "auto" | "full" | null;
  /** 开工弹层的本次思考档覆盖（2026-09-15）：随标签种子传递，launch 经
      pty_spawn effortOverride 注入；空 = 绑定逐模型策略/端点默认 */
  effort?: string | null;
  /** @deprecated 用 permission；true 等同 discuss */
  readonly?: boolean;
  /** 打开后切到聊天层（办公「问 AI」）；缺省沿用标签上次选择 / 默认终端 */
  surface?: "chat" | "terminal";
  /** 复用键：已有同 key 标签时切换到它而不是新开（「跟 AI 商量一下」等
      重复入口防标签堆积）。只有工作区键（ws:）进重启持久化白名单，别的恢复占位不参与复用 */
  reuseKey?: string;
  /** 这一步的对话还在跑（CLI 活着，不能再 resume 一份）：有标签持有它就切过去，不另开会话。
      复用键没命中（老标签没带键）时按会话 id 认，再不行认同一工作树里正在跑 Agent 的标签 */
  focusSession?: { agentId: string; sessionId: string };
  /** 只复用空白标签（快速开聊）：有复用键以此开头、还没说过话的标签就切过去（不改它输入框里已换的选择），
      没有就用 reuseKey 新开。说过话的不复用——快速开聊是开新对话 */
  reuseBlank?: string;
  /** 与 reuseBlank 配合：切到空白标签时把它的输入框改成这次指定的 Agent / 连接 / 模型。
      默认（不设）不改——快速开聊要保留人在输入框里已换过的选择；连接页「新对话」是点名要这条连接，必须改 */
  reseedBlank?: boolean;
  /** 步骤认领（「跟 AI 商量一下」）：启动 spawn 时以最终 agent/cwd 登记
      claim_next_session_for_step，让会话归到该步骤（项目「对话」页按 stepName 过滤）。
      不在发起时提前登记——启动栏还可改 agent/目录，spawn 时的实时值才作数 */
  stepName?: string;
  /** 第 1 期 Run 身份；恢复同一 Run 时带上 */
  runId?: string;
  /** 新建 Task 后预创建的 Run 所属 Task。 */
  taskId?: string;
}

/** 工作区页 / 改动面板 → 终端全宽审阅视图的一次性交接。 */
export interface WorkspaceReviewRequest {
  worktreePath: string;
  /** 产生改动的 Run；评审页不从 cwd 反推身份。 */
  runId?: string | null;
  /** 工作区列表的更多操作可直接定位到评审中的对应完成动作；
      resolve-conflict 表示「解决冲突」入口，允许评审层自动准备冲突两侧。 */
  action?: "pr" | "archive" | "resolve-conflict";
  /** 同一路径的重复请求也要重新触发评审内的定位动作。 */
  requestId: string;
  /** 从项目页签进来的：返回时回到这个项目的这个页签，而不是停在终端页。 */
  returnTo?: { projectRoot: string; surface: ProjectSurfaceTab } | null;
  /** 发起页，store 自动记（调用方不写）：评审只挂在运行页，从别的页进来的返回时回那一页。 */
  fromPage?: string;
  /** 这次已经采纳：评审只查看，不能再改纳入或排除。 */
  locked?: boolean;
}

export function sessionRuntimeKey(agent: string, sessionId: string): string {
  return `${agent}\n${sessionId}`;
}

/** 「待你处理」收件箱条目（可序列化，闭包不进 store）；
    action 由消费方统一派发（全部走 store 一次性请求 + 页面跳转） */
export interface InboxItem {
  key: string;
  /** 状态点语义色 class（bg-warn-text / bg-ok-text） */
  dot: string;
  text: string;
  actionLabel: string;
  /** 仅 help: 条目携带：请求条目签名（dismiss 时连同 root 写入屏蔽表） */
  dismissSignature?: string;
  action:
    | {
      type: "review";
      worktreePath: string;
      runId?: string | null;
      intent?: "pr" | "archive" | "resolve-conflict";
      }
    | { type: "session"; agent: string; sessionId: string }
    | { type: "digest" }
    | { type: "skillAdapt"; skillId: string }
    | { type: "artifacts"; workspaceId: string }
    | { type: "project"; projectRoot: string }
    | { type: "litWatch"; projectRoot: string }
    | { type: "help"; projectRoot: string }
    | { type: "run"; runId?: string; tabId?: string }
    | { type: "settings"; section: string }
    | { type: "phoneDrop" }
    | { type: "profiles" };
}

/** 应用更新收件箱条目（去设置页「更新」分区） */
export function appUpdateInboxEntry(
  info: { version: string; currentVersion: string } | null,
): InboxItem | null {
  const fields = appUpdateInboxFields(info);
  if (!fields) return null;
  return {
    key: fields.key,
    dot: "bg-ok-text",
    text: fields.text,
    actionLabel: "去安装",
    action: { type: "settings", section: "update" },
  };
}

/** 「从手机添加」还没处理的条数 → 收件箱「手机」条目（点开弹层列表，不重新开始接收） */
export function phoneDropInboxEntry(pending: number): InboxItem | null {
  const fields = phoneInboxFields(pending);
  if (!fields) return null;
  return {
    key: fields.key,
    dot: "bg-ok-text",
    text: fields.text,
    actionLabel: "去处理",
    action: { type: "phoneDrop" },
  };
}

/** 标题栏 / 工作台可见收件箱：业务条目 + 现算的应用更新与手机待处理（项目页未挂载也能看到） */
export function visibleInboxItems(
  items: InboxItem[],
  update: { version: string; currentVersion: string } | null,
  dismissed: Record<string, string>,
  phonePending = 0,
): InboxItem[] {
  const phone = phoneDropInboxEntry(phonePending);
  return filterDismissed(
    [...mergeAppUpdateInbox(items, appUpdateInboxEntry(update)), ...(phone ? [phone] : [])],
    dismissed,
  );
}

/** 「◈ 提炼接力」后台任务（v3.60）：AI 蒸馏与 DigestPicker 解耦——picker 可关可开，
    同一会话复用结果不重复发起；ready 且未消费时进收件箱「待发送」 */
export interface DigestJob {
  agent: string;
  sessionId: string;
  filePath: string;
  cwd: string;
  title: string | null;
  status: "running" | "ready" | "error";
  brief?: HandoffBriefDto;
  error?: string;
  /** 已选定发送目标/用户丢弃：从收件箱摘除（简报文件仍在磁盘，重开 picker 复用） */
  consumed: boolean;
}

/** 「◈ 适配到流水线」后台成稿。opened 后从收件箱摘掉，稿还在，再点该技能直接打开。 */
export interface SkillAdaptJob {
  skillId: string;
  skillName: string;
  status: "running" | "ready" | "error";
  content: string | null;
  error: string | null;
  /** 技能本来就符合流水线，稿是原文，没有重写。 */
  unchanged: boolean;
  opened: boolean;
}

/** 收件箱条目动作统一派发（工作区页 strip 与 App 标题栏收件箱共用） */
export function runInboxAction(item: InboxItem) {
  const s = useAppStore.getState();
  if (item.action.type === "review") {
    s.setWorkspaceReviewRequest({
      worktreePath: item.action.worktreePath,
      runId: item.action.runId ?? null,
      action: item.action.intent,
      requestId: crypto.randomUUID(),
    });
    s.setPage("terminal");
  } else if (item.action.type === "run") {
    const runId = item.action.runId;
    const tabId = item.action.tabId;
    const live = runId
      ? s.terminalRunInputs.find((r) => r.runId === runId)
      : tabId
        ? s.terminalRunInputs.find((r) => r.tabId === tabId)
        : undefined;
    if (live) {
      s.setFocusTabReq(live.tabId);
      s.setPage("terminal");
    } else if (tabId) {
      s.setFocusTabReq(tabId);
      s.setPage("terminal");
    } else if (runId) {
      void import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke<RunDto | null>("run_get", { id: runId })
          .then((run) => {
            if (!run) {
              toast("找不到这次运行，可能已被清理", "warning");
              return;
            }
            const custom = run.runtime === "custom" || run.agent === "custom";
            s.setPendingTerminal({
              cwd: run.isolationPath,
              extraEnv: {},
              agentId: custom ? "custom" : run.agent,
              profileId: custom ? undefined : run.profileId ?? undefined,
              customRuntimeId: custom
                ? run.customRuntimeId ??
                  run.reuseKey?.match(/^custom:([^:]+):/)?.[1]
                : undefined,
              reuseKey: run.reuseKey ?? undefined,
              runId,
              // 透传原 Task 身份：缺了它后端会按 reuseKey/路径重新推导 kind/ref，
              // 与已登记 Run（声明目标是 free_research + 目标名）对不上而被拒
              taskId: run.taskId || undefined,
              permission: run.permission === "discuss" ? "discuss" : "write_tree",
              resume: !custom && run.sessionId
                ? { agentId: run.agent, sessionId: run.sessionId }
                : undefined,
              autoStart: !custom && Boolean(run.sessionId),
            });
            s.setPage("terminal");
          })
          .catch((reason) => {
            toast(`打开运行失败：${String(reason)}`, "error");
          }),
      );
    }
  } else if (item.action.type === "session") {
    s.setOpenSessionReq({
      agent: item.action.agent,
      sessionId: item.action.sessionId,
    });
    s.setPage("sessions");
  } else if (item.action.type === "digest") {
    s.setDigestOpenReq(Date.now());
    s.setPage("sessions");
  } else if (item.action.type === "skillAdapt") {
    s.setSkillAdaptOpenId(item.action.skillId);
    s.setPage("skills");
  } else if (item.action.type === "artifacts") {
    s.setArtifactCheckReq(item.action.workspaceId);
    s.setPage("workspaces");
  } else if (item.action.type === "project") {
    s.setSelectProjectReq(item.action.projectRoot);
    s.setPage("workspaces");
  } else if (item.action.type === "litWatch") {
    const act = item.action;
    s.setSelectProjectReq(act.projectRoot);
    s.setProjectFocusReq({
      projectRoot: act.projectRoot,
      focus: "lit",
      token: Date.now(),
    });
    s.setPage("workspaces");
  } else if (item.action.type === "help") {
    // 人工请求「去查看」：选中项目之外还要弹出完整内容层——请求全文在 strip 行里只有 40 字截断预览
    s.setSelectProjectReq(item.action.projectRoot);
    s.setHelpViewReq(item.action.projectRoot);
    s.setPage("workspaces");
  } else if (item.action.type === "phoneDrop") {
    usePhoneDropStore.getState().openDialog(null, { start: false });
  } else if (item.action.type === "settings") {
    // 依赖体检条目：跳设置页并选中目标分区（设置页消费 settingsSectionReq 后清空）
    s.setSettingsSectionReq(item.action.section);
    s.setPage("settings");
  } else {
    s.setPage("profiles");
  }
}

interface AppState {
  profiles: Profile[];
  gateways: Gateway[];
  agents: DetectResult[];
  sessions: SessionMetaDto[];
  /** 已添加项目路径（注册表）；快速开聊随手聊历史现算用，启动时拉一次 */
  projectPaths: string[];
  setProjectPaths: (paths: string[]) => void;
  loadProjects: () => Promise<void>;
  /** 项目列表代数：任何一处的增删改（侧栏树管理动作、注册流程）自增，消费方据此重拉 */
  projectsVersion: number;
  bumpProjectsVersion: () => void;
  /** 侧栏「＋ 添加项目」的一次性请求（token）：项目页消费后打开目录选择器 */
  addProjectOpenReq: number | null;
  setAddProjectOpenReq: (token: number | null) => void;
  /** 「新建项目…」的一次性请求（token）：项目页消费后打开新建弹窗（起名 + 位置 + 工作方式，
   *  建文件夹后走同一套注册），不弹系统选目录窗——那是「添加已有文件夹」 */
  newProjectOpenReq: { token: number; returnTabId?: string } | null;
  setNewProjectOpenReq: (req: { token: number; returnTabId?: string } | null) => void;
  /** 「新建项目…」从聊天 / 终端标签发起时，建好后回到那个标签并把目录换成新项目（一次性） */
  tabCwdReq: { tabId: string; cwd: string } | null;
  setTabCwdReq: (req: { tabId: string; cwd: string } | null) => void;
  /** 侧栏「＋ → 创建示例课题」的一次性请求（token）：项目页消费后执行创建 */
  demoProjectOpenReq: number | null;
  setDemoProjectOpenReq: (token: number | null) => void;
  /** 后端按最近会话活跃度排序的仓库；本地缓存用于终端首开即时展示。 */
  recentRepos: RepoDto[];
  recentReposLoading: boolean;
  recentReposLoaded: boolean;
  loadRecentRepos: () => Promise<void>;
  /** 当前页面（nav id），放 store 里让任意页面可跳转 */
  page: string;
  setPage: (p: string) => void;
  /** 侧栏收缩状态（localStorage 持久化，品牌区点击切换） */
  navCollapsed: boolean;
  setNavCollapsed: (collapsed: boolean) => void;
  toggleNavCollapsed: () => void;
  /** 执行态全隐藏侧栏 chrome（⌘\ 切换，session 级不持久化） */
  chromeHidden: boolean;
  /** 进入完全隐藏前的普通侧栏状态；退出时恢复该值 */
  chromeHiddenReturnCollapsed: boolean | null;
  cycleNavState: () => void;
  enterChromeHidden: () => void;
  exitChromeHidden: () => void;
  toggleChromeHidden: () => void;
  /** 待消费的终端启动请求；终端页可见时消费并清空 */
  pendingTerminal: PendingTerminal | null;
  setPendingTerminal: (p: PendingTerminal | null) => void;
  /** 流程线「配置学术检索 MCP」跳过来：MCP 页打开对应预设表单后清空 */
  pendingMcpPreset: string | null;
  setPendingMcpPreset: (name: string | null) => void;
  /** 项目区「问 AI」选 Agent/配置弹层；确认后写成 pendingTerminal */
  askAiReq: AskAiFile | null;
  setAskAiReq: (r: AskAiFile | null) => void;
  workspaceReviewRequest: WorkspaceReviewRequest | null;
  setWorkspaceReviewRequest: (request: WorkspaceReviewRequest | null) => void;
  /** 终端标签运行状态镜像（TerminalPage 写入；工作区首页「待你处理」跨页只读） */
  terminalRunInputs: RunOverviewInput[];
  setTerminalRunInputs: (inputs: RunOverviewInput[]) => void;
  /** 「待你处理」收件箱条目镜像（WorkspacesPage 唯一写入方，签名变更才写）；
      App 标题栏收件箱与工作区页 strip 共同消费；action 为可序列化跳转描述 */
  inboxItems: InboxItem[];
  setInboxItems: (items: InboxItem[]) => void;
  /** help: 条目屏蔽表（{ root: 条目签名 }，localStorage ccode.helpDismissed 持久化；
      签名随文件内容变化，内容一变自动复现）。签名一致时 WorkspacesPage 不生成该条目 */
  helpDismissed: Record<string, string>;
  dismissHelpRequest: (root: string, signature: string) => void;
  /** 通用条目屏蔽表（v3.88）：任意收件箱条目可忽略，状态变化后自动复现 */
  inboxDismissed: Record<string, string>;
  dismissInbox: (item: InboxItem) => void;
  dismissInboxBulk: (items: InboxItem[]) => void;
  /** 依赖体检结果（git/node/安装渠道，dep_check.rs）：启动时静默探测一次，
      设置页诊断区「重新检测」与一键安装完成后就地刷新；null = 尚未探测/探测失败 */
  depCheck: DepCheckDto | null;
  /** 显式点「重新检测」要有看得见的反馈：检测进行中（按钮转「检测中…」并禁用） */
  depCheckBusy: boolean;
  /** 最近一次检测失败原因（诊断行内红字展示）；成功后清空。启动探测失败也落这里，
      只是不弹通知——静默指不打扰，不是不交代 */
  depCheckError: string | null;
  /** 每次调用重新探测（无缓存）；进行中防重入 */
  refreshDepCheck: () => Promise<void>;
  /** 一次性「跳设置页并选中分区」请求（收件箱 dep: 条目发起），设置页消费并清空 */
  settingsSectionReq: string | null;
  setSettingsSectionReq: (section: string | null) => void;
  /** 上手引导状态（onboarding.ts；localStorage ccode.onboarding 持久化）。完成与否由数据现算，这里只存
   *  判定结果、欢迎页看过没有、两步人工确认 */
  onboarding: OnboardingState;
  updateOnboarding: (patch: Partial<OnboardingState>) => void;
  /** 记一步人工确认（已记过不重写）；运行页真切到终端时也调它 */
  ackOnboarding: (id: OnboardingStepId) => void;
  /** 上手清单浮层开关（侧栏「上手引导」行 / 帮助菜单 / 命令面板共用） */
  onboardingPanelOpen: boolean;
  setOnboardingPanelOpen: (open: boolean) => void;
  /** 一次性「打开网关库」请求（连接页消费并清空）；create = 打开即进新建表单 */
  gatewayLibraryReq: { token: number; create: boolean } | null;
  setGatewayLibraryReq: (req: { token: number; create: boolean } | null) => void;
  /** 一次性「打开添加连接弹窗」请求（token；连接页消费并清空） */
  profileModalReq: number | null;
  setProfileModalReq: (token: number | null) => void;
  /** 一次性「当前标签切聊天 / 终端」请求（上手引导「切到终端」；运行页可见时消费并清空） */
  surfaceSwitchReq: { mode: SurfaceMode; token: number } | null;
  setSurfaceSwitchReq: (req: { mode: SurfaceMode; token: number } | null) => void;
  /** 一次性「跳终端页并激活标签」请求（首页待办点击发起），终端页可见时消费并清空 */
  focusTabReq: string | null;
  setFocusTabReq: (tabId: string | null) => void;
  /** 工作区页资源面板「查看」/ 步骤产物 → 终端页预览的交接（绝对路径，终端页消费并清空）；
      root 可选：文本预览的后端根约束（不给则回落活动标签 cwd） */
  previewReq: { path: string; name: string; root?: string } | null;
  setPreviewReq: (r: { path: string; name: string; root?: string } | null) => void;
  /** 聊天里点到的项目文件：运行页改动面板展开这一份 diff。 */
  diffFocusReq: { cwd: string; path: string } | null;
  setDiffFocusReq: (r: { cwd: string; path: string } | null) => void;
  /** 沉浸式阅读区的一次性打开请求（终端页消费并清空）：PDF 绝对路径 + 所属项目根；
      notePath 指定后笔记栏直接编辑该 md（不按 PDF slug 另建模板笔记）；
      fromPage 由 store 自动记发起页——阅读区只挂在终端页，跨页进入退出时回到来源页；
      spotCheck = 精读步「抽查 3 篇笔记」的核对档（三篇一起带进来，pdfPath/notePath 由阅读区按篇解析） */
  readerReq: {
    pdfPath: string;
    projectRoot: string;
    notePath?: string;
    fromPage?: string;
    spotCheck?: SpotCheckSession;
  } | null;
  setReaderReq: (
    r: {
      pdfPath: string;
      projectRoot: string;
      notePath?: string;
      fromPage?: string;
      spotCheck?: SpotCheckSession;
    } | null,
  ) => void;
  /** 人工事项状态在流程页之外被改过（阅读区抽查「都没问题」勾上）：useHumanTasks 见变化即重取 */
  humanTasksTick: number;
  bumpHumanTasks: () => void;
  /** 步骤胶囊「📁」→ 终端页文件树切根的一次性交接（终端页消费并清空） */
  enterCwdReq: string | null;
  setEnterCwdReq: (p: string | null) => void;
  /** 运行中的 run 脚本：工作区 id → 终端标签 id（nonconcurrent 互斥） */
  runningScripts: Record<string, string>;
  setRunningScript: (wsId: string, tabId: string | null) => void;
  /** 终端里正在进行的会话：agent+sessionId → 标签 id（防止跨 CLI 同 id 串联） */
  liveSessions: Record<string, string>;
  setLiveSession: (
    agent: string,
    sessionId: string,
    tabId: string | null,
  ) => void;
  /** 对话页 → 终端页的焦点跳转请求（终端页消费并清空） */
  focusTabId: string | null;
  focusTab: (tabId: string | null) => void;
  /** 工作区页 → 对话页的搜索词交接（对话页消费并清空） */
  sessionsQuery: string | null;
  /** 快速开聊「查看全部」→ 对话页只列随手聊（消费并清空） */
  sessionsScratchReq: boolean;
  setSessionsScratchReq: (on: boolean) => void;
  /** 请求对话页打开指定会话（终端页「⤴对话」跳转用） */
  openSessionReq: { agent: string; sessionId: string } | null;
  setOpenSessionReq: (r: { agent: string; sessionId: string } | null) => void;
  setSessionsQuery: (q: string | null) => void;
  /** 选段「✦ 沉淀为技能」→ 技能页的一次性草稿交接（技能页可见时打开新建 modal 预填并清空） */
  skillDraftReq: { name: string; description: string; content: string } | null;
  setSkillDraftReq: (
    r: { name: string; description: string; content: string } | null,
  ) => void;
  /** 「◈ 提炼接力」后台任务（生成与 picker 解耦；收件箱「待发送」只读） */
  digestJob: DigestJob | null;
  /** 发起提炼；同一会话 running/ready 时复用不重复发起，force 用于失败后重试 */
  startDigestJob: (
    src: {
      agent: string;
      sessionId: string;
      filePath: string;
      cwd: string;
      title: string | null;
    },
    force?: boolean,
  ) => void;
  /** 已选定发送目标/用户丢弃：从收件箱摘除（简报文件保留，重开 picker 复用） */
  consumeDigestJob: () => void;
  /** 收件箱「去发送」→ 对话页重开 DigestPicker 的一次性请求（nonce 触发） */
  digestOpenReq: number | null;
  setDigestOpenReq: (n: number | null) => void;
  /** 「◈ 适配到流水线」后台成稿，按技能 id。打开成稿后 opened=true，收件箱摘掉。 */
  skillAdaptJobs: Record<string, SkillAdaptJob>;
  startSkillAdapt: (skill: { id: string; name: string }, force?: boolean) => void;
  markSkillAdaptOpened: (skillId: string) => void;
  clearSkillAdapt: (skillId: string) => void;
  /** 收件箱「去查看」→ 技能页打开该技能适配稿 */
  skillAdaptOpenId: string | null;
  setSkillAdaptOpenId: (id: string | null) => void;
  /** 收件箱「去核验」→ 工作区页展开对应任务行产物清单的一次性请求 */
  artifactCheckReq: string | null;
  setArtifactCheckReq: (id: string | null) => void;
  /** 对话页卡片 chip → 工作区页选中对应项目的一次性请求（项目根路径，工作区页消费并清空） */
  /** 当前项目·步骤上下文镜像（WorkspacesPage 唯一写入方）：顶栏跨页展示「我在哪」。
   *  只读消费，不新增轮询——数据本就在工作区页手里；projectPath 供工作台按路径归属（同名项目不猜名字） */
  contextLabel: { project: string; projectPath?: string | null; step: string | null } | null;
  setContextLabel: (v: { project: string; projectPath?: string | null; step: string | null } | null) => void;
  selectProjectReq: string | null;
  projectFocusReq: {
    projectRoot: string;
    focus: "lit" | "schedule";
    token: number;
  } | null;
  setProjectFocusReq: (req: AppState["projectFocusReq"]) => void;
  /** 进项目页时切到指定页签（侧栏旧「定时巡检」→ 项目「定时任务」） */
  projectSurfaceReq: ProjectSurfaceTab | null;
  setProjectSurfaceReq: (tab: ProjectSurfaceTab | null) => void;
  /** 待获取清单等：切到文件页并打开这篇 PDF */
  filePreviewReq: { projectRoot: string; path: string; token: number } | null;
  setFilePreviewReq: (req: AppState["filePreviewReq"]) => void;
  /** 收件箱人工请求「去查看」的一次性请求（项目根路径）：工作区页弹出该来源的完整请求内容层 */
  helpViewReq: string | null;
  setHelpViewReq: (path: string | null) => void;
  /** 对话页作用域筛选的一次性请求（落成 step / project / task / agent chip） */
  sessionScopeReq: { kind: "project" | "step" | "task" | "agent" | "day"; value: string; label: string } | null;
  setSessionScopeReq: (
    r: { kind: "project" | "step" | "task" | "agent" | "day"; value: string; label: string } | null,
  ) => void;
  setSelectProjectReq: (path: string | null) => void;
  /** 工作台「待验收」→ 项目页打开对应目标的验收层 */
  taskReviewReq: { projectRoot: string; taskId: string } | null;
  setTaskReviewReq: (req: { projectRoot: string; taskId: string } | null) => void;
  /** 任务卡（按项目根缓存；list_task_cards 对非项目目录返回空表不报错） */
  taskCards: Record<string, TaskCardDto[]>;
  /** 拉取并缓存某项目的任务卡；失败抛错由调用方行内报错 */
  loadTaskCards: (projectRoot: string) => Promise<TaskCardDto[]>;
  /** 新建卡片（同项目重名后端拒绝）；成功后刷新缓存并返回新卡片。
   *  kind 缺省由后端推断（step 非空 → draft，否则 idea）；想法区建卡传 "idea" */
  createCard: (
    projectRoot: string,
    name: string,
    step: string | null,
    kind?: "idea" | "draft",
  ) => Promise<TaskCardDto>;
  renameCard: (
    projectRoot: string,
    taskId: string,
    newName: string,
  ) => Promise<void>;
  /** 删除卡片（后端顺手清掉所有会话的 task_id 归置） */
  deleteCard: (projectRoot: string, taskId: string) => Promise<void>;
  /** 会话归入/移出卡片（taskId null/空白 = 移出）；成功后刷新会话列表让 chip 即时更新 */
  assignSessionTask: (
    agent: string,
    sessionId: string,
    taskId: string | null,
  ) => Promise<void>;
  /** profile 三层验证失败镜像（ProfilesPage 写入：失败登记、通过/编辑后清除），收件箱只读 */
  profileIssues: Record<string, { name: string; agent: string; reason: string }>;
  setProfileIssue: (
    id: string,
    issue: { name: string; agent: string; reason: string } | null,
  ) => void;
  /** 应用设置（启动时加载；update 合并写回并即时应用主题） */
  settings: AppSettings | null;
  loadSettings: () => Promise<void>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  /** 应用自更新：check() 命中的可用更新（null=已是最新/未检查完/检查失败/开发模式） */
  appUpdate: Update | null;
  appUpdateStatus: AppUpdateStatus;
  appUpdateError: string | null;
  /** 启动时检查应用更新；开发模式跳过；失败写入 status 而不伪装成「已是最新」 */
  checkAppUpdate: () => Promise<void>;
  loadAll: () => Promise<void>;
  connectionLoadError: string | null;
  /** 拉取全部 agent 的会话元数据，返回最新列表供轮询比对 */
  loadSessions: (force?: boolean) => Promise<SessionMetaDto[]>;
  saveProfile: (id: string | null, input: ProfileInput) => Promise<void>;
  removeProfile: (id: string) => Promise<void>;
  duplicateProfile: (id: string) => Promise<void>;
  loadGateways: () => Promise<void>;
  /** 保存网关，返回保存后的网关（含 id），供「保存后立即绑定」链路使用 */
  saveGateway: (id: string | null, input: GatewayInput) => Promise<Gateway>;
  removeGateway: (id: string) => Promise<void>;
  bindGateway: (input: BindingInput) => Promise<Profile>;
}

export const useAppStore = create<AppState>((set, get) => {
  const sessionRefresh = createSessionRefreshCoordinator(
    () => invoke<SessionMetaDto[]>("list_sessions"),
    () => get().sessions,
    (sessions) => set({ sessions }),
  );

  return {
  profiles: [],
  connectionLoadError: null,
  gateways: [],
  agents: [],
  sessions: [],
  projectPaths: [],
  setProjectPaths: (paths) => set({ projectPaths: paths }),
  loadProjects: async () => {
    const list = await invoke<{ path: string }[]>("list_projects");
    set({ projectPaths: list.map((p) => p.path) });
  },
  projectsVersion: 0,
  bumpProjectsVersion: () =>
    set((s) => ({ projectsVersion: s.projectsVersion + 1 })),
  addProjectOpenReq: null,
  setAddProjectOpenReq: (token) => set({ addProjectOpenReq: token }),
  newProjectOpenReq: null,
  setNewProjectOpenReq: (req) => set({ newProjectOpenReq: req }),
  tabCwdReq: null,
  setTabCwdReq: (req) => set({ tabCwdReq: req }),
  demoProjectOpenReq: null,
  setDemoProjectOpenReq: (token) => set({ demoProjectOpenReq: token }),
  recentRepos: cachedRecentRepos(),
  recentReposLoading: false,
  recentReposLoaded: false,
  loadRecentRepos: async () => {
    if (get().recentReposLoading) return;
    set({ recentReposLoading: true });
    try {
      const recentRepos = await invoke<RepoDto[]>("list_repos");
      localStorage.setItem(RECENT_REPOS_CACHE_KEY, JSON.stringify(recentRepos));
      set({ recentRepos, recentReposLoaded: true });
    } finally {
      set({ recentReposLoading: false });
    }
  },
  page: "workbench",
  setPage: (p) => set({ page: p }),
  navCollapsed: localStorage.getItem("ccode.navCollapsed") === "1",
  setNavCollapsed: (collapsed) => {
    localStorage.setItem("ccode.navCollapsed", collapsed ? "1" : "0");
    set({ navCollapsed: collapsed });
  },
  toggleNavCollapsed: () =>
    set((s) => {
      localStorage.setItem("ccode.navCollapsed", s.navCollapsed ? "0" : "1");
      return { navCollapsed: !s.navCollapsed };
  }),
  chromeHidden: false,
  chromeHiddenReturnCollapsed: null,
  cycleNavState: () =>
    set((s) => {
      const next = cycleBrandState(s);
      if (next.navCollapsed !== s.navCollapsed) {
        localStorage.setItem("ccode.navCollapsed", next.navCollapsed ? "1" : "0");
      }
      return { ...s, ...next };
    }),
  enterChromeHidden: () =>
    set((s) => ({ ...s, ...enterChromeHidden(s) })),
  exitChromeHidden: () =>
    set((s) => {
      const next = exitChromeHidden(s);
      if (next.navCollapsed !== s.navCollapsed) {
        localStorage.setItem("ccode.navCollapsed", next.navCollapsed ? "1" : "0");
      }
      return { ...s, ...next };
    }),
  toggleChromeHidden: () =>
    set((s) => {
      const next = toggleChromeHiddenState(s);
      if (next.navCollapsed !== s.navCollapsed) {
        localStorage.setItem("ccode.navCollapsed", next.navCollapsed ? "1" : "0");
      }
      return { ...s, ...next };
    }),
  pendingTerminal: null,
  setPendingTerminal: (p) => set({ pendingTerminal: p }),
  pendingMcpPreset: null,
  setPendingMcpPreset: (name) => set({ pendingMcpPreset: name }),
  askAiReq: null,
  setAskAiReq: (r) => set({ askAiReq: r }),
  workspaceReviewRequest: null,
  // 发起页同 readerReq 在 store 层自动记：流程线、任务卡、收件箱、上游提醒等入口都是先发请求再切运行页
  setWorkspaceReviewRequest: (request) =>
    set({
      workspaceReviewRequest: request ? { ...request, fromPage: get().page } : null,
    }),
  terminalRunInputs: [],
  setTerminalRunInputs: (inputs) => set({ terminalRunInputs: inputs }),
  inboxItems: [],
  setInboxItems: (items) => set({ inboxItems: items }),
  inboxDismissed: loadInboxDismissed(),
  dismissInbox: (item) =>
    set((st) => ({ inboxDismissed: dismissInboxItem(item, st.inboxDismissed) })),
  /** 一键已读（信息类批量，2026-10-16）：逐条签名写入忽略表，一次落盘；
   *  白名单判定在调用侧（bulkReadableItems），决策类不进这里 */
  dismissInboxBulk: (items) =>
    set((st) => {
      const next = { ...st.inboxDismissed };
      for (const it of items) next[it.key] = inboxSignature(it);
      try {
        localStorage.setItem(INBOX_DISMISSED_KEY, JSON.stringify(next));
      } catch {
        /* 隐私模式写不进就只靠本次内存态 */
      }
      return { inboxDismissed: next };
    }),
  depCheck: null,
  depCheckBusy: false,
  depCheckError: null,
  refreshDepCheck: async () => {
    if (get().depCheckBusy) return;
    set({ depCheckBusy: true });
    try {
      set({
        depCheck: await invoke<DepCheckDto>("check_dependencies"),
        depCheckError: null,
      });
    } catch (e) {
      // 静默指不打扰主流程：显式点「重新检测」失败必须看得见，落错误态由诊断行展示
      set({ depCheckError: String(e) });
    } finally {
      set({ depCheckBusy: false });
    }
  },
  settingsSectionReq: null,
  setSettingsSectionReq: (section) => set({ settingsSectionReq: section }),
  onboarding: loadOnboardingState(),
  updateOnboarding: (patch) => {
    const onboarding = { ...get().onboarding, ...patch };
    set({ onboarding });
    try {
      localStorage.setItem(ONBOARDING_STORAGE_KEY, serializeOnboarding(onboarding));
    } catch {
      /* 存不下只影响下次启动：会重新判定，有连接即收起，不会反复打扰 */
    }
  },
  ackOnboarding: (id) => {
    const { onboarding, updateOnboarding } = get();
    if (onboarding.acks[id]) return;
    updateOnboarding({ acks: { ...onboarding.acks, [id]: true } });
  },
  onboardingPanelOpen: false,
  setOnboardingPanelOpen: (open) => set({ onboardingPanelOpen: open }),
  gatewayLibraryReq: null,
  setGatewayLibraryReq: (req) => set({ gatewayLibraryReq: req }),
  profileModalReq: null,
  setProfileModalReq: (token) => set({ profileModalReq: token }),
  surfaceSwitchReq: null,
  setSurfaceSwitchReq: (req) => set({ surfaceSwitchReq: req }),
  helpDismissed: loadHelpDismissed(),
  dismissHelpRequest: (root, signature) =>
    set({ helpDismissed: dismissHelp(root, signature) }),
  focusTabReq: null,
  setFocusTabReq: (tabId) => set({ focusTabReq: tabId }),
  previewReq: null,
  setPreviewReq: (r) => set({ previewReq: r }),
  diffFocusReq: null,
  setDiffFocusReq: (r) => set({ diffFocusReq: r }),
  readerReq: null,
  // 发起页在 store 层自动记（调用方不写 fromPage）：五个跨页入口（文件页/产物核验/资源面板）
  // 都该在退出阅读区时回来源页；终端页自己的入口不走 readerReq，天然不带回跳
  setReaderReq: (r) =>
    set({ readerReq: r ? { ...r, fromPage: get().page } : null }),
  humanTasksTick: 0,
  bumpHumanTasks: () => set((s) => ({ humanTasksTick: s.humanTasksTick + 1 })),
  enterCwdReq: null,
  setEnterCwdReq: (p) => set({ enterCwdReq: p }),
  runningScripts: {},
  setRunningScript: (wsId, tabId) =>
    set((s) => {
      const next = { ...s.runningScripts };
      if (tabId) next[wsId] = tabId;
      else delete next[wsId];
      return { runningScripts: next };
    }),
  liveSessions: {},
  setLiveSession: (agent, sessionId, tabId) =>
    set((s) => {
      const next = { ...s.liveSessions };
      const key = sessionRuntimeKey(agent, sessionId);
      if (tabId) next[key] = tabId;
      else delete next[key];
      return { liveSessions: next };
    }),
  focusTabId: null,
  focusTab: (tabId) => set({ focusTabId: tabId }),
  sessionsQuery: null,
  sessionsScratchReq: false,
  openSessionReq: null,
  setSessionsQuery: (q) => set({ sessionsQuery: q }),
  setSessionsScratchReq: (on) => set({ sessionsScratchReq: on }),
  setOpenSessionReq: (r) => set({ openSessionReq: r }),
  skillDraftReq: null,
  setSkillDraftReq: (r) => set({ skillDraftReq: r }),
  digestJob: null,
  skillAdaptJobs: {},
  startSkillAdapt: (skill, force) => {
    const cur = get().skillAdaptJobs[skill.id];
    if (cur?.status === "running") return;
    if (cur?.status === "ready" && !force) return;
    set({
      skillAdaptJobs: {
        ...get().skillAdaptJobs,
        [skill.id]: {
          skillId: skill.id,
          skillName: skill.name,
          status: "running",
          content: null,
          error: null,
          unchanged: false,
          opened: false,
        },
      },
    });
    invoke<{ name: string; content: string; unchanged?: boolean }>("adapt_skill_to_pipeline", {
      id: skill.id,
    })
      .then((dto) => {
        const jobs = get().skillAdaptJobs;
        const job = jobs[skill.id];
        if (!job || job.status !== "running") return;
        set({
          skillAdaptJobs: {
            ...jobs,
            [skill.id]: {
            ...job,
            status: "ready",
            content: dto.content,
            error: null,
            unchanged: dto.unchanged === true,
          },
          },
        });
      })
      .catch((reason) => {
        const jobs = get().skillAdaptJobs;
        const job = jobs[skill.id];
        if (!job || job.status !== "running") return;
        set({
          skillAdaptJobs: {
            ...jobs,
            [skill.id]: { ...job, status: "error", error: String(reason), content: null },
          },
        });
      });
  },
  markSkillAdaptOpened: (skillId) => {
    const job = get().skillAdaptJobs[skillId];
    if (!job) return;
    set({
      skillAdaptJobs: {
        ...get().skillAdaptJobs,
        [skillId]: { ...job, opened: true },
      },
    });
  },
  clearSkillAdapt: (skillId) => {
    const next = { ...get().skillAdaptJobs };
    delete next[skillId];
    set({ skillAdaptJobs: next });
  },
  skillAdaptOpenId: null,
  setSkillAdaptOpenId: (id) => set({ skillAdaptOpenId: id }),
  startDigestJob: (src, force) => {
    const cur = get().digestJob;
    const same =
      cur &&
      cur.agent === src.agent &&
      cur.sessionId === src.sessionId &&
      cur.filePath === src.filePath;
    // 同一会话已有结果/正在跑：直接复用，不因 picker 重开而重复提炼（费 token 且慢）
    if (same && !force && cur.status !== "error") return;
    set({ digestJob: { ...src, status: "running", consumed: false } });
    invoke<HandoffBriefDto>("build_session_digest", {
      agent: src.agent,
      sessionId: src.sessionId,
      filePath: src.filePath,
      cwd: src.cwd,
      title: src.title,
      targetPath: null,
    })
      .then((brief) => {
        const j = get().digestJob;
        // 期间用户已发起另一会话的提炼：本次结果作废，不回写
        if (j && j.agent === src.agent && j.sessionId === src.sessionId)
          set({ digestJob: { ...j, status: "ready", brief } });
      })
      .catch((e) => {
        const j = get().digestJob;
        if (j && j.agent === src.agent && j.sessionId === src.sessionId)
          set({ digestJob: { ...j, status: "error", error: String(e) } });
      });
  },
  consumeDigestJob: () => {
    const j = get().digestJob;
    if (j) set({ digestJob: { ...j, consumed: true } });
  },
  digestOpenReq: null,
  setDigestOpenReq: (n) => set({ digestOpenReq: n }),
  artifactCheckReq: null,
  setArtifactCheckReq: (id) => set({ artifactCheckReq: id }),
  contextLabel: null,
  setContextLabel: (v) => set({ contextLabel: v }),
  selectProjectReq: null,
  projectFocusReq: null,
  setProjectFocusReq: (req) => set({ projectFocusReq: req }),
  projectSurfaceReq: null,
  setProjectSurfaceReq: (tab) => set({ projectSurfaceReq: tab }),
  filePreviewReq: null,
  setFilePreviewReq: (req) => set({ filePreviewReq: req }),
  helpViewReq: null,
  setHelpViewReq: (path) => set({ helpViewReq: path }),
  setSelectProjectReq: (path) => set({ selectProjectReq: path }),
  taskReviewReq: null,
  setTaskReviewReq: (req) => set({ taskReviewReq: req }),
  sessionScopeReq: null,
  setSessionScopeReq: (r) => set({ sessionScopeReq: r }),
  taskCards: {},
  loadTaskCards: async (projectRoot) => {
    const cards = await invoke<TaskCardDto[]>("list_task_cards", {
      projectRoot,
    });
    set((s) => ({ taskCards: { ...s.taskCards, [projectRoot]: cards } }));
    return cards;
  },
  createCard: async (projectRoot, name, step, kind) => {
    const card = await invoke<TaskCardDto>("create_task_card", {
      projectRoot,
      name,
      step,
      kind: kind ?? null,
    });
    await get().loadTaskCards(projectRoot);
    return card;
  },
  renameCard: async (projectRoot, taskId, newName) => {
    await invoke("rename_task_card", { projectRoot, taskId, newName });
    await get().loadTaskCards(projectRoot);
  },
  deleteCard: async (projectRoot, taskId) => {
    await invoke("delete_task_card", { projectRoot, taskId });
    await get().loadTaskCards(projectRoot);
    // 后端已清掉会话的 task_id：刷新会话列表让对话页 chip/分组即时消失
    await get().loadSessions(true);
  },
  assignSessionTask: async (agent, sessionId, taskId) => {
    await invoke("assign_session_task", { agent, sessionId, taskId });
    await get().loadSessions(true);
  },
  profileIssues: {},
  setProfileIssue: (id, issue) =>
    set((s) => {
      const next = { ...s.profileIssues };
      if (issue) next[id] = issue;
      else delete next[id];
      return { profileIssues: next };
    }),
  settings: null,
  loadSettings: async () => {
    const s = await invoke<AppSettings>("get_settings");
    set({ settings: s });
    applyTheme(s.theme, s.customTheme, s.themeFollowSystem === true);
    ensureThemeFollowListener();
    void syncThemeWithSystem().catch(() => {});
  },
  updateSettings: async (patch) => {
    const s = await invoke<AppSettings>("update_settings", { patch });
    set({ settings: s });
    applyTheme(s.theme, s.customTheme, s.themeFollowSystem === true);
    void syncThemeWithSystem().catch(() => {});
  },

  appUpdate: null,
  appUpdateStatus: "idle",
  appUpdateError: null,
  checkAppUpdate: async () => {
    if (import.meta.env.DEV) {
      const prev = get().appUpdate;
      if (prev) prev.close().catch(() => {});
      set({
        appUpdate: null,
        appUpdateStatus: "dev",
        appUpdateError: null,
      });
      return;
    }
    const gen = ++appUpdateCheckGen;
    set({ appUpdateStatus: "checking", appUpdateError: null });
    try {
      const next = await check({
        timeout: APP_UPDATE_CHECK_TIMEOUT_MS,
        proxy: updaterProxyUrl(get().settings?.outboundProxy),
      });
      if (gen !== appUpdateCheckGen) {
        next?.close().catch(() => {});
        return;
      }
      const prev = get().appUpdate;
      if (prev && prev !== next) prev.close().catch(() => {});
      set({
        appUpdate: next,
        appUpdateStatus: next ? "available" : "none",
        appUpdateError: null,
      });
    } catch (e) {
      if (gen !== appUpdateCheckGen) return;
      const message = summarizeUpdateCheckError(String(e));
      if (get().appUpdate) {
        set({ appUpdateStatus: "available", appUpdateError: message });
        return;
      }
      set({ appUpdateStatus: "error", appUpdateError: message });
    }
  },

  loadAll: async () => {
    try {
      const [profiles, agents, gateways] = await Promise.all([
        invoke<Profile[]>("list_profiles"),
        invoke<DetectResult[]>("detect_agents"),
        invoke<Gateway[]>("list_gateways"),
      ]);
      set({ profiles, agents, gateways, connectionLoadError: null });
    } catch (reason) {
      set({ connectionLoadError: String(reason) });
      throw reason;
    }
  },

  loadSessions: (force = false) => sessionRefresh.load(force),

  saveProfile: async (id, input) => {
    if (id) {
      await invoke("update_profile", { id, input });
    } else {
      await invoke("create_profile", { input });
    }
    const profiles = await invoke<Profile[]>("list_profiles");
    set({ profiles });
    invoke("rebuild_tray").catch(() => {});
  },

  removeProfile: async (id) => {
    await invoke("delete_profile", { id });
    const profiles = await invoke<Profile[]>("list_profiles");
    set({ profiles });
    invoke("rebuild_tray").catch(() => {});
  },

  duplicateProfile: async (id) => {
    await invoke("duplicate_profile", { id });
    const profiles = await invoke<Profile[]>("list_profiles");
    set({ profiles });
    invoke("rebuild_tray").catch(() => {});
  },

  loadGateways: async () => {
    const gateways = await invoke<Gateway[]>("list_gateways");
    set({ gateways });
  },
  saveGateway: async (id, input) => {
    const saved = await invoke<Gateway>("save_gateway", { id, input });
    const [gateways, profiles] = await Promise.all([
      invoke<Gateway[]>("list_gateways"),
      invoke<Profile[]>("list_profiles"),
    ]);
    set({ gateways, profiles });
    invoke("rebuild_tray").catch(() => {});
    return saved;
  },
  removeGateway: async (id) => {
    await invoke("delete_gateway", { id });
    const gateways = await invoke<Gateway[]>("list_gateways");
    set({ gateways });
    invoke("rebuild_tray").catch(() => {});
  },
  bindGateway: async (input) => {
    const bound = await invoke<Profile>("bind_gateway", { input });
    const [gateways, profiles] = await Promise.all([
      invoke<Gateway[]>("list_gateways"),
      invoke<Profile[]>("list_profiles"),
    ]);
    set({ gateways, profiles });
    invoke("rebuild_tray").catch(() => {});
    return bound;
  },
  };
});

export function useProfilesByAgent(agentId: string): Profile[] {
  return useAppStore((s) => s.profiles).filter((p) => p.agent === agentId);
}

const NO_HIDDEN_PROFILES: string[] = [];
/** zustand 5 的选择器结果按引用比较：`?? []` 每次给新数组，hiddenProfiles 为 null 时组件
 *  一挂载就无限重渲染（Maximum update depth exceeded，2026-10-19 Windows 实证：项目页起不来）。
 *  缺省必须回落到同一个常量——选择器里一律不写 `?? []` / `?? {}`（tests/store-selector-lint 钉住） */
export const selectHiddenProfiles = (s: AppState): string[] =>
  s.settings?.hiddenProfiles ?? NO_HIDDEN_PROFILES;
