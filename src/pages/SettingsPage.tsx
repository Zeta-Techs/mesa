import BackgroundTasksPanel from "../components/BackgroundTasksPanel";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ChartColumn,
  Download,
  Globe,
  HardDrive,
  Info,
  Keyboard,
  Palette,
  Search,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  Stethoscope,
  X,
  type LucideIcon,
} from "lucide-react";
import appIconDark from "../assets/app-icon/dark.png";
import appIconLight from "../assets/app-icon/light.png";
import { searchSettings, type SettingSectionId } from "../settings-search.ts";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { exit } from "@tauri-apps/plugin-process";
import { applyTheme, useAppStore } from "../store";
import type { AppSettings } from "../store";
import {
  compactPrimaryActionClass,
  fieldClass,
  hoverRevealClass,
  PageFrame,
  PageHeader,
  primaryActionClass,
  Checkbox,
  FoldMark,
  SegTabs,
  Toggle,
  settingsPillClass,
  InlineNotice,
} from "../components/PageFrame";
import { captureDecision, comboLabel, IS_MAC, IS_WINDOWS, PAGE_HOTKEY_DEFS } from "../hotkeys";
import {
  canOneClickInstall,
  depMissingReason,
  installButtonHint,
  installGuidance,
  type DepItemDto,
  type DepPlatform,
  type DepTool,
} from "../dep-check";
import { DepInstallLog, useDepInstall, type DepInstallEntry } from "../dep-install";
import {
  NAV_CAPSULE_ITEM_IDS,
  normalizeNavCapsuleDelay,
  normalizeNavCapsuleDisplayMode,
  normalizeNavCapsuleVisibleItems,
  resolveStartupNavMode,
  type NavCapsuleItemId,
} from "../nav-capsule";
import {
  aiProfileChoices,
  parseAiProfileChoice,
  selectedAiProfileChoice,
} from "../ai-profile-choice";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { open as openDirectory } from "@tauri-apps/plugin-dialog";
import {
  TERMINAL_FONT_CHOICES,
  isKnownTerminalFont,
  monoFallbackStack,
  terminalFontStack,
} from "../terminal-font";
import type { CustomRuntimeDto, StorageEntryDto, UnpricedModelDto } from "../types";
import { AGENTS } from "../types";
import { getVersion } from "@tauri-apps/api/app";
import {
  collectFrontendDiagnostics,
  formatLogText,
  logLocalTime,
} from "../diagnostics";
import { useAppUpdateInstall } from "../app-update-install";
import UpdateNotes from "../components/UpdateNotes";
import { enableCodexWinSandbox } from "../components/CodexWinSandboxNotice";
import {
  appUpdateProgressLabel,
  appUpdateProgressPct,
  appUpdateStatusHint,
} from "../app-update";

/** 七套深色主题：色板双格预览（左=侧栏色，右=内容底色）+ 名称 */
import {
  XTERM_PALETTES,
  PALETTE_PREVIEW_KEYS,
  AUTO_PALETTE,
  PALETTE_LIST,
  resolvePaletteId,
  themeDefaultPalette,
} from "../terminal-palettes";
import { THEMES, isCustomThemeId, isLightTheme } from "../themes";
import { followedTheme } from "../theme-follow";
import {
  DEFAULT_INST_LOGIN_URL,
  instOtherPanelDefaultOpen,
  instPrefixPanelDefaultOpen,
  instSessionLabel,
  type InstSessionStatus,
} from "../inst-access";
import appCss from "../App.css?raw";
import {
  parseThemeSwatchesFromCss,
  themeSwatchFor,
} from "../theme-swatch";
import { alertDialog, confirmDialog } from "../components/ConfirmDialog";
import FeedbackModal from "../components/FeedbackModal";
import {
  ThirdPartyNotices,
  loadThirdPartyNotices,
} from "../components/ThirdPartyNotices";
import { Modal } from "../components/Modal";
import {
  addCustomThemeCard,
  CUSTOM_THEME_CARDS_MAX,
  customThemeIdFromSeeds,
  DEFAULT_CUSTOM_THEME,
  deriveThemeTokens,
  nextCardName,
  normalizeCustomTheme,
  normalizeCustomThemeCards,
  normalizeHex,
  removeCustomThemeCard,
  renameCustomThemeCard,
  resolveCustomThemeCardId,
  seedsFromComputed,
  type CustomThemeCard,
  type CustomThemeSeeds,
} from "../custom-theme";
import { NAV_GROUPS, NAV_BOTTOM } from "../navigation";
import {
  CHROME_OPACITIES,
  chromeOpacityLabel,
  chromeOpacityShortLabel,
  normalizeChromeOpacity,
} from "../chrome-opacity";
import {
  CHAT_ACCENTS,
  CHAT_ACCENT_LABEL,
  CHAT_FONT_FAMILIES,
  CHAT_FONT_FAMILY_LABEL,
  CHAT_FONT_SIZES,
  CHAT_FONT_SIZE_LABEL,
  CHAT_SCROLLBARS,
  CHAT_SCROLLBAR_LABEL,
  normalizeChatAccent,
  normalizeChatFontFamily,
  normalizeChatFontSize,
  normalizeChatScrollbar,
  type ChatAccent,
  type ChatFontFamily,
  type ChatFontSize,
  type ChatScrollbar,
} from "../chat-style";
import { toast } from "../toast";
import { compact as compactTokens } from "../stats-insight";
import { storageClearConfirmText, storageSegments, summarizeStorage } from "../settings-storage";
import InternalSessionsCard from "../components/InternalSessionsCard";
import { collapseCarriageReturns } from "../stream-text";

// 调色板清单单一出处在 ../terminal-palettes（PALETTE_LIST，含亮暗标记）

/** 色卡预览：取共享调色板表的前 8 个 ANSI 标准色（与终端实际生效色一致） */
function paletteDots(id: string): string[] {
  const p = XTERM_PALETTES[id] ?? XTERM_PALETTES["dark-plus"];
  return PALETTE_PREVIEW_KEYS.map((k) => p[k]);
}

// 主题清单单一出处在 ../themes（命令面板共用）



/** 调色块：做成输入框形态（色块 + 名称 + 色值），整块点开系统取色器。
 *  不与主题小窗同形——原先同尺寸同版式，被看成又一排可选主题（2026-10-17） */
function ColorChip({
  label,
  value,
  onLive,
}: {
  label: string;
  value: string;
  onLive: (hex: string) => void;
}) {
  const hex = normalizeHex(value) ?? "#000000";
  return (
    <label className="relative inline-flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md border border-field bg-canvas pl-1 pr-2.5 text-xs hover:border-l4">
      <span
        aria-hidden="true"
        className="h-6 w-6 shrink-0 rounded-sm ring-1 ring-hairline"
        style={{ background: hex }}
      />
      <span className="text-l3">{label}</span>
      <span className="font-mono text-micro text-l2">{hex}</span>
      <input
        type="color"
        aria-label={label}
        className="absolute inset-0 m-0 h-full w-full cursor-pointer border-0 p-0 opacity-0"
        value={hex}
        onInput={(e) => onLive((e.target as HTMLInputElement).value)}
        onChange={(e) => onLive(e.target.value)}
      />
    </label>
  );
}

/** 主题小窗：左栏竖条 + 画布 + 强调点，名称写在画布上用该主题自己的标题色。
 *  内置主题、另存色卡、未存自定义三处共用（原先三份手抄） */
function ThemeTile({
  name,
  rail,
  canvas,
  accent,
  ink,
  selected,
  title,
  onClick,
  onDoubleClick,
  nameSlot,
}: {
  name: string;
  rail: string;
  canvas: string;
  accent: string;
  ink: string;
  selected: boolean;
  title: string;
  onClick: () => void;
  onDoubleClick?: () => void;
  /** 替换名称位（色卡改名输入框） */
  nameSlot?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={
        onDoubleClick
          ? (e) => {
              e.preventDefault();
              onDoubleClick();
            }
          : undefined
      }
      title={title}
      aria-pressed={selected}
      className={`h-14 w-full min-w-0 overflow-hidden rounded-md text-left ${
        selected ? "ring-2 ring-l1" : "ring-1 ring-hairline hover:ring-field"
      }`}
      style={{ background: canvas }}
    >
      <span className="flex h-full">
        <span className="w-2.5 shrink-0" style={{ background: rail }} aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col justify-between px-1.5 py-1.5">
          <span
            className="h-1.5 w-1.5 self-end rounded-full"
            style={{ background: accent }}
            aria-hidden="true"
          />
          {nameSlot ?? (
            <span className="truncate text-micro font-medium" style={{ color: ink }}>
              {name}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

/** 系统当前是否深色。跟随态下窗口外观交还系统，媒体查询读到的就是系统值 */
function systemIsDark(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : true;
}

/** 终端分区顶部的预览：字体 / 字号 / 调色板改了当场看得到，不必切到运行页开一个标签。
 *  底与字色取主题的 editor-bg/fg 令牌（深色主题与终端 XTERM_BG_FG 逐字相同，浅色主题终端
 *  另取近白，差在肉眼分辨以下），ANSI 色取实际生效的调色板；中文行验证 CJK 回退 */
function TerminalPreview({
  family,
  fontSize,
  paletteId,
}: {
  family: string;
  fontSize: number;
  paletteId: string;
}) {
  const p = XTERM_PALETTES[paletteId] ?? XTERM_PALETTES["dark-plus"];
  const lines: { text: string; color?: string }[][] = [
    [{ text: "~/thesis ", color: p.blue }, { text: "$ ", color: p.brightBlack }, { text: "git status --short" }],
    [{ text: " M ", color: p.red }, { text: "manuscript/intro.md" }],
    [{ text: "?? ", color: p.red }, { text: "data/cleaned.csv" }],
    [{ text: "✓ ", color: p.green }, { text: "12 项检查通过  " }, { text: "⚠ 1 条警告", color: p.yellow }],
    [{ text: "→ ", color: p.cyan }, { text: "读取 references.bib  " }, { text: "0O 1lI {}[]", color: p.magenta }],
  ];
  return (
    <div
      aria-label="终端预览"
      role="img"
      className="mb-3 overflow-hidden rounded-xl px-4 py-3 ring-1 ring-hairline"
      style={{
        background: "var(--color-editor-bg)",
        color: "var(--color-editor-fg)",
        fontFamily: terminalFontStack(family, monoFallbackStack()),
        fontSize: `${Math.min(18, Math.max(11, fontSize))}px`,
        lineHeight: 1.35,
      }}
    >
      {lines.map((segs, i) => (
        <div key={i} className="whitespace-pre">
          {segs.map((seg, j) => (
            <span key={j} style={seg.color ? { color: seg.color } : undefined}>
              {seg.text}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

// fieldClass 自带 w-full：本页 Row 右列是收缩到内容的 auto 列，定宽控件（w-20/w-24/w-40）
// 追加的宽度类在 Tailwind 排序中会被 w-full 覆盖，故用去掉 w-full 的本页变体保持原宽度
// 2026-10-18 起设置页控件整体换「胶囊」手感：圆角放大、高度 36px、底色抬一档（借鉴 Codex 设置页）
const fieldFixed = fieldClass
  .replace("w-full ", "")
  .replace("rounded-md", "rounded-lg")
  .replace("bg-canvas", "bg-strip")
  .replace("py-1.5", "h-9");

/** 设置页按钮：抬底胶囊，行内操作与卡头动作统一一档（原 28px 无框 ghost / 描边次按钮并为一种） */
const ghostActionClass = settingsPillClass;
const secondaryActionClass = settingsPillClass;
const rowActionClass = settingsPillClass;

/** 下拉宽度只留三档（2026-10-17）：原先跟最长选项走，终端页三个下拉宽度差一倍多，
 *  AI 专用配置更是顶出卡片右缘。短枚举 sm、一般 md、带配置名/字体说明的长选项 lg */
const selectSm = `${fieldFixed} w-40 max-w-full`;
const selectMd = `${fieldFixed} w-64 max-w-full`;
const selectLg = `${fieldFixed} w-80 max-w-full`;

/** 「外部终端」下拉的选项按平台给（navigator.platform 在 WKWebView/Chromium 均可用） */
const EXTERNAL_TERMINALS: { id: string; label: string }[] = (() => {
  const p = navigator.platform || "";
  if (p.startsWith("Mac"))
    return [
      { id: "auto", label: "自动（Ghostty → iTerm → 终端）" },
      { id: "ghostty", label: "Ghostty" },
      { id: "iterm", label: "iTerm2" },
      { id: "terminal", label: "终端 Terminal.app" },
    ];
  if (p.startsWith("Win"))
    return [
      { id: "cmd", label: "命令提示符 (cmd)" },
      { id: "powershell", label: "PowerShell" },
    ];
  return [
    { id: "auto", label: "自动（按优先级探测）" },
    { id: "gnome-terminal", label: "GNOME Terminal" },
    { id: "konsole", label: "Konsole" },
    { id: "xfce4-terminal", label: "Xfce Terminal" },
    { id: "xterm", label: "XTerm" },
  ];
})();

/** 下拉当前值必须落在本平台选项里：Windows 旧存档 auto 回落到 cmd。 */
function externalTerminalSelectValue(stored: string | undefined): string {
  const ids = EXTERNAL_TERMINALS.map((t) => t.id);
  if (stored && ids.includes(stored)) return stored;
  return ids[0] ?? "auto";
}

/** 内置 AI 功能按功能独立配置的行（key 与后端 ai.rs FN_* 常量对应）。
 *  按用在哪里分三组，每行一句说明——「提炼接力」「雷达解读」这类名字不说用在哪，新用户无从判断要不要单配 */
const AI_FN_GROUPS: { title: string; rows: { key: string; label: string; hint: string }[] }[] = [
  {
    title: "编程",
    rows: [
      { key: "commit", label: "提交信息", hint: "提交改动时起草说明" },
      { key: "pr", label: "PR 描述", hint: "开拉取请求时起草描述" },
      { key: "conflict", label: "冲突建议", hint: "合并冲突时给出选哪边的建议" },
    ],
  },
  {
    title: "对话与技能",
    rows: [
      { key: "summarize", label: "会话摘要 / 起名", hint: "对话列表的标题与摘要" },
      { key: "digest", label: "接力与评审提炼", hint: "交接给下一个 Agent、评审结论沉淀" },
      { key: "distill", label: "沉淀为技能", hint: "把一段对话整理成技能" },
      { key: "skill-optimize", label: "优化合成技能", hint: "合并、改写已有技能" },
    ],
  },
  {
    title: "科研",
    rows: [
      { key: "translate", label: "翻译", hint: "阅读文献、技能页里的翻译" },
      { key: "watch-explain", label: "雷达解读", hint: "定时文献雷达命中后的解读" },
    ],
  },
];

const NAV_CAPSULE_SETTING_ITEMS: { id: NavCapsuleItemId; label: string }[] = [
  { id: "quick-chat", label: "新对话" },
  ...NAV_GROUPS.flatMap((group) =>
    group.items.map((item) => ({ id: item.id as NavCapsuleItemId, label: item.label })),
  ),
  ...NAV_BOTTOM.map((item) => ({
    id: item.id as NavCapsuleItemId,
    label: item.label,
  })),
];

/** 诊断日志条目（与后端 logbuf::LogEntryDto 对应） */
type LogEntry = { ts: string; level: string; source: string; message: string };

/** 精确注意力标记支持清单条目（与后端 hooks::HookSupportDto 对应） */
type HookSupport = {
  agent: string;
  supported: boolean;
  note?: string | null;
  configPath?: string | null;
  /** Mesa 拉起时自动带精确事件（启动参数 / CLI 自带通道，不改用户配置），不给开关 */
  auto?: boolean;
};

/** 可一键安装的字体预设：下拉字体名 → 后端字体 id（内置/系统/自定义不在安装范围） */
const INSTALLABLE_FONTS: Record<string, string> = {
  "Maple Mono NF CN": "maple",
  "Sarasa Mono SC": "sarasa",
  Iosevka: "iosevka",
};

/** 与后端 fonts::FontStatusDto / FontInstallDto 对应 */
type FontStatus = { id: string; family: string; installed: boolean };
type FontInstallResult = { ok: boolean; output: string };

/** 「本机占用」条形图色阶：取主题令牌，换主题自动跟随；最后一档（灰）给「其他」 */
const STORAGE_TONES = [
  "var(--color-cta)",
  "var(--color-ok-text)",
  "var(--color-link)",
  "var(--color-warn-text)",
  "var(--color-err-text)",
  "var(--color-l4)",
];

/** 字节数白话：设置页「数据与存储」用（1 位小数，KB 起跳） */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

/** 分区清单：顺序即导航顺序。description 是分区标题下那一行，回答「这里管什么」 */
const SETTING_NAV: {
  id: SettingSectionId;
  label: string;
  group: "basic" | "management";
  icon: LucideIcon;
  description: string;
}[] = [
  { id: "appearance", label: "外观", group: "basic", icon: Palette, description: "主题、透明度与应用图标" },
  { id: "terminal", label: "终端", group: "basic", icon: SquareTerminal, description: "内嵌终端的显示、外部终端与自定义运行时" },
  { id: "startup", label: "通用", group: "basic", icon: SlidersHorizontal, description: "启动页面、导航形态与系统通知" },
  { id: "hotkeys", label: "快捷键", group: "basic", icon: Keyboard, description: "点绑定钮后按下新组合即保存，Esc 取消" },
  { id: "integration", label: "AI 与 Agent", group: "management", icon: Sparkles, description: "内置 AI 功能用哪份配置，以及 Mesa 对各家 Agent 的约束" },
  { id: "network", label: "网络", group: "management", icon: Globe, description: "出网代理、下载镜像与学校图书馆" },
  { id: "stats", label: "用量", group: "management", icon: ChartColumn, description: "用量页折算费用用的汇率与价目" },
  { id: "update", label: "更新", group: "management", icon: Download, description: "检查并安装 Mesa 新版本" },
  { id: "diag", label: "诊断", group: "management", icon: Stethoscope, description: "排障用的诊断包、依赖体检与应用日志" },
  { id: "storage", label: "数据与存储", group: "management", icon: HardDrive, description: "Mesa 在本机占用的目录，以及卸载" },
  { id: "about", label: "关于", group: "management", icon: Info, description: "版本、许可、隐私与反馈" },
];

/** 设置页低频折叠：校外前缀 / 其他方式。默认开闭由调用方按已填内容决定。 */
function SettingsFold({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="-ml-1 inline-flex items-center text-micro text-l4 hover:text-l2"
      >
        <FoldMark open={open} />
        {label}
      </button>
      {open && <div className="mt-2 flex flex-col gap-2">{children}</div>}
    </div>
  );
}

/** 依赖体检指引文案的平台参数（installGuidance 显式传参，纯逻辑不读平台） */
const DEP_PLATFORM: DepPlatform = IS_MAC ? "mac" : IS_WINDOWS ? "win" : "linux";

/** 依赖体检单行状态：ok = ✓ + 版本 + 路径；缺失/CLT stub = ✗ + 说明 +
 *  一键安装钮（渠道允许时）或指引文案；安装进行/结果跟随该行展示 */
function DepStatusLine({
  label,
  purpose,
  busy = false,
  item,
  tool,
  channel,
  entry,
  onInstall,
}: {
  label: string;
  /** 白话用途（普通用户不认识 PyMuPDF / Pillow 这类名字），缺失时跟在名字后面 */
  purpose?: string;
  /** 同一批安装正在别的行进行（拼图两库一起装），本行按钮也锁住 */
  busy?: boolean;
  item: DepItemDto;
  tool: DepTool;
  channel: string;
  entry: DepInstallEntry;
  onInstall: (tool: DepTool) => void;
}) {
  if (item.status === "ok") {
    return (
      <div className="flex items-center gap-2 py-1 text-xs">
        <span className="text-ok-text">✓</span>
        <span className="text-l2">{label}</span>
        <span className="text-l4">{item.version ?? "版本未知"}</span>
        {item.path && (
          <span className="min-w-0 truncate font-mono text-l4" title={item.path}>
            {item.path}
          </span>
        )}
      </div>
    );
  }
  const reason = depMissingReason(item);
  const hint = installButtonHint(tool, item.prereq, channel);
  return (
    <div className="py-1 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-err-text">✗</span>
        <span className="text-l2">{label}</span>
        {purpose && <span className="text-l3">{purpose}</span>}
        <span className="text-l4">{reason}</span>
        {/* 有具体原因（如残留环境变量）时装不装都一样，不给安装按钮误导人去重装 */}
        {item.note ? null : canOneClickInstall(tool, channel, item.prereq) ? (
          <>
            <button
              onClick={() => onInstall(tool)}
              disabled={entry.running || busy}
              className={`${rowActionClass} shrink-0`}
            >
              {entry.running || busy
                ? "安装中…"
                : item.status === "clt_stub"
                  ? "安装"
                  : "一键安装"}
            </button>
            {hint && !entry.running && !busy && <span className="text-l4">{hint}</span>}
          </>
        ) : (
          <span className="text-l4">
            {installGuidance(tool, channel, DEP_PLATFORM, item.prereq)}
          </span>
        )}
      </div>
      <DepInstallLog entry={entry} />
    </div>
  );
}

/** 版本行的构建信息：macOS aarch64 标「Apple 芯片」——用户看得懂的叫法；
 *  Intel 自构建版在这里就能认出来，不用撞「平台不在更新清单」的错 */
function buildInfoSuffix(
  b: { os: string; arch: string; channel: string } | null,
): string | undefined {
  if (!b) return undefined;
  const os = b.os === "macos" ? "macOS" : b.os === "windows" ? "Windows" : b.os;
  const arch =
    b.os === "macos" && b.arch === "aarch64"
      ? "Apple 芯片"
      : b.arch === "x86_64"
        ? "x64"
        : b.arch;
  return `${os} · ${arch}${b.channel === "dev" ? " · 开发模式" : ""}`;
}

/** 「开源许可与致谢」只读浮层：复用全站 Modal 壳（Esc / 遮罩 / 关闭钮 + 焦点陷阱）。
 *  内容与帮助菜单 → 关于的许可内页同一个组件（ThirdPartyNotices）：致谢与数据来源一页、
 *  组件许可一页（可搜索） */
function NoticesOverlay({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <Modal
      open
      onClose={onClose}
      title="开源许可与致谢"
      description="Mesa 按 Apache-2.0 发布；下面是它用到的开源组件、字体与数据来源。"
      size="lg"
    >
      <ThirdPartyNotices text={text} />
    </Modal>
  );
}

/** 导航选中的分区始终展开；分区标题不是折叠操作。标题与说明取自 SETTING_NAV，两处不会写岔 */
function Section({
  id,
  active,
  badge,
  children,
}: {
  id: SettingSectionId;
  active: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  if (id !== active) return null;
  const nav = SETTING_NAV.find((n) => n.id === id);
  return (
    <section>
      <header className="mb-5">
        {/* 分区标题是页内最大的字（2026-10-18 借鉴 Codex 设置页：大标题 + 一行灰说明，
            其下才是成组卡片）；原 text-base 与卡头只差一档，层级发闷 */}
        <h2 className="flex min-h-9 flex-wrap items-center gap-2 text-xl font-semibold leading-9 tracking-tight text-l1">
          {nav?.label}
          {badge}
        </h2>
        {nav?.description && <p className="mt-1 text-sm leading-5 text-l3">{nav.description}</p>}
      </header>
      <div>{groupRows(children)}</div>
    </section>
  );
}

/** 分区内的小节标题：只用留白和字重分组，不画线、不铺底（design-system 设置页口径） */
function SubHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mt-8 mb-1 first:mt-0">
      <h3 className="text-base font-semibold text-l1">{title}</h3>
      {hint && <p className="mt-0.5 text-micro leading-4 text-l3">{hint}</p>}
    </div>
  );
}

/** 成组编辑器的统一内容卡：卡头 = 标题 + 一句说明 + 右侧动作，卡内放 CardRow 或自定义内容 */
function Card({
  title,
  hint,
  action,
  children,
}: {
  title?: React.ReactNode;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-3 ccode-well ccode-card p-4">
      {(title || action) && (
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <div className="text-sm font-medium text-l1">{title}</div>}
            {hint && <p className="mt-0.5 text-micro leading-4 text-l3">{hint}</p>}
          </div>
          {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

/** 卡内列表行：功能名在左、控件靠右，宽屏由外层 grid 排成双列 */
function CardRow({
  label,
  hint,
  title,
  children,
}: {
  label: string;
  hint?: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="group flex min-h-11 items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 hover:bg-hover">
      <div className="min-w-0" title={title}>
        <div className="truncate text-sm text-l1">{label}</div>
        {hint && <p className="mt-0.5 truncate text-micro leading-4 text-l3">{hint}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function Row({
  label,
  hint,
  labelTitle,
  extra,
  align = "center",
  disabled = false,
  children,
}: {
  label: string;
  hint?: string;
  /** 文案克制（v3.88）：说不完的机制说明压成一句 hint，全文挂标签旁的 ⓘ 上悬浮可读 */
  labelTitle?: string;
  /** 行下方全宽区域（如字体安装的流式输出），不传不渲染 */
  extra?: React.ReactNode;
  /** 右侧控件高于一行（按钮 + 折叠 / 候选列表 / 图标块）时用 start：
   *  居中会让左标签掉到控件中段，看着和首个控件对不齐 */
  align?: "center" | "start";
  /** 前置条件不满足：整行弱化且不可点（灵动岛组在非隐藏导航形态下） */
  disabled?: boolean;
  children: React.ReactNode;
}) {
  // 2026-10-18：行 = 左标题/说明 + 右控件靠右（Codex 设置页手感）；窄了控件自然折到标题下方。
  // 行与行之间的发丝线、卡片外框由 RowGroup 给——Row 只管自己的内边距
  return (
    <div
      aria-disabled={disabled || undefined}
      className={`flex flex-wrap gap-x-6 gap-y-2.5 px-4 py-3.5 ${
        align === "center" ? "items-center" : "items-start"
      } ${disabled ? "pointer-events-none opacity-50" : ""}`}
    >
      <div className={`min-w-[12rem] flex-1 ${align === "start" ? "pt-1.5" : ""}`}>
        <div className="flex items-center gap-1.5 text-sm font-medium text-l1">
          <span>{label}</span>
          {/* 悬浮说明原先只挂在标签文字上，没有任何视觉提示，等于藏起来了；
              补一个可聚焦的 ⓘ，键盘与读屏也拿得到全文 */}
          {labelTitle && (
            <span
              tabIndex={0}
              role="img"
              aria-label={labelTitle}
              title={labelTitle}
              className="inline-flex shrink-0 cursor-help rounded-sm text-l4 outline-none hover:text-l2 focus-visible:text-l1 focus-visible:ring-1 focus-visible:ring-field"
            >
              <Info aria-hidden="true" className="h-3 w-3" />
            </span>
          )}
        </div>
        {hint && <p className="mt-0.5 max-w-lg text-micro leading-4 text-l3">{hint}</p>}
      </div>
      <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">{children}</div>
      {extra && <div className="basis-full">{extra}</div>}
    </div>
  );
}

/** 连续的 Row 收成一张分组卡：外框 + 行间发丝线。Section 对直接子元素自动套用，
 *  页面代码照旧只写 <Row>，不必手包 */
function RowGroup({ children }: { children: React.ReactNode }) {
  return <div className="mt-3 ccode-well ccode-card divide-y divide-hairline overflow-hidden">{children}</div>;
}

/** Section 的直接子元素里，相邻的 Row 合成一个 RowGroup；其余（SubHeading / Card / 自定义块）原样。
 *  只认直接子元素：包在 Fragment / div 里的 Row 不会被合并，保持自身内边距、不带外框 */
function groupRows(children: React.ReactNode): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let run: React.ReactElement[] = [];
  const flush = () => {
    if (run.length === 0) return;
    out.push(<RowGroup key={`rows-${out.length}`}>{run}</RowGroup>);
    run = [];
  };
  React.Children.toArray(children).forEach((child) => {
    if (React.isValidElement(child) && child.type === Row) {
      run.push(child);
    } else {
      flush();
      out.push(child);
    }
  });
  flush();
  return out;
}

/** 应用图标外观三选一（设置 → 外观）。「跟随系统」预览深浅各半，说明它会自己变 */
const APP_ICON_STYLES: { id: "system" | "dark" | "light"; label: string }[] = [
  { id: "system", label: "跟随系统" },
  { id: "dark", label: "深色" },
  { id: "light", label: "浅色" },
];

function AppIconPicker({
  value,
  onChange,
}: {
  value: "system" | "dark" | "light";
  onChange: (style: "system" | "dark" | "light") => void;
}) {
  return (
    <div role="radiogroup" aria-label="应用图标" className="flex flex-wrap gap-2">
      {APP_ICON_STYLES.map((opt) => {
        const selected = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(opt.id)}
            className={`flex w-[5.5rem] flex-col items-center gap-1.5 rounded-md px-2 pb-1.5 pt-2.5 text-xs transition-colors ${
              selected
                ? "bg-seg-sel text-l1 ring-2 ring-l1"
                : "text-l3 ring-1 ring-hairline hover:bg-hover hover:text-l1"
            }`}
          >
            {opt.id === "system" ? (
              <span aria-hidden="true" className="relative h-10 w-10">
                <img src={appIconDark} alt="" className="absolute inset-0 h-10 w-10 [clip-path:inset(0_50%_0_0)]" />
                <img src={appIconLight} alt="" className="absolute inset-0 h-10 w-10 [clip-path:inset(0_0_0_50%)]" />
              </span>
            ) : (
              <img
                src={opt.id === "dark" ? appIconDark : appIconLight}
                alt=""
                aria-hidden="true"
                className="h-10 w-10"
              />
            )}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/** 快捷键录制钮：点击进入监听态，按下新组合即保存；Esc 或点击别处取消，与另一绑定冲突时拒绝并提示。
 *  macOS WKWebView 点击 button 默认不给键盘焦点，onKeyDown 挂按钮上永远收不到按键；
 *  监听态改挂 window 级 capture 监听（capture 先于 App.tsx 的 bubble 全局快捷键触发，
 *  stopImmediatePropagation 把同节点其余监听一并压过），退出监听态即卸载。
 *  监听态由父级 capturing id 受控：全页同时最多一行在录，点击行外即取消
 *  （否则残留的窗口级监听会一直吞掉全部按键） */
function HotkeyCapture({
  id,
  value,
  defaultValue,
  conflictsWith,
  onSave,
  capturing,
  setCapturing,
}: {
  id: string;
  /** 当前绑定（"" = 已禁用） */
  value: string;
  defaultValue: string;
  /** 其余在用的绑定值，用于防冲突（空串不计） */
  conflictsWith: string[];
  onSave: (combo: string) => void;
  /** 当前处于监听态的行 id（null = 没有行在录） */
  capturing: string | null;
  setCapturing: (id: string | null) => void;
}) {
  const listening = capturing === id;
  const [conflict, setConflict] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      // 录制期间吞掉全部按键：防默认行为（如 ⌘K 的浏览器动作）与全局快捷键触发
      e.preventDefault();
      e.stopImmediatePropagation();
      const d = captureDecision(e, conflictsWith);
      if (d.action === "cancel") {
        setCapturing(null);
        setConflict(false);
      } else if (d.action === "conflict") {
        // 留在监听态，可继续按其他组合
        setConflict(true);
      } else if (d.action === "save") {
        onSave(d.combo);
        setConflict(false);
        setCapturing(null);
      }
      // ignore：纯修饰键/无修饰键，继续等待
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [listening, conflictsWith, onSave, setCapturing]);

  useEffect(() => {
    if (!listening) return;
    const onMouseDown = (e: MouseEvent) => {
      if (
        rootRef.current &&
        e.target instanceof Node &&
        !rootRef.current.contains(e.target)
      ) {
        setCapturing(null);
        setConflict(false);
      }
    };
    window.addEventListener("mousedown", onMouseDown, true);
    return () => window.removeEventListener("mousedown", onMouseDown, true);
  }, [listening, setCapturing]);

  return (
    <span
      ref={rootRef}
      className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs"
    >
      <button
        type="button"
        onClick={() => setCapturing(id)}
        className={`inline-flex h-7 min-w-14 shrink-0 items-center justify-center rounded-md border px-2 font-mono ${
          listening
            ? "border-cta-bd bg-inset text-cta"
            : conflict
              ? "border-err-text/50 text-err-text"
              : value === ""
                ? "border-dashed border-hairline bg-transparent text-l4"
                : "border-field bg-inset text-l2"
        }`}
      >
        {listening ? "按下新快捷键…" : comboLabel(value)}
      </button>
      {conflict && <span className="text-err-text">与其他快捷键冲突</span>}
      {/* 「恢复」「禁用」两格固定占位（不适用时 invisible）：条件渲染会让改过默认值的行
          把快捷键钮往左挤，与同列其他行对不齐（2026-10-17 截图实证 ⌘L 比 ⌘9 左移一截）。
          「禁用」低频，悬停行才显现 */}
      <button
        type="button"
        tabIndex={value !== defaultValue ? undefined : -1}
        aria-hidden={value !== defaultValue ? undefined : true}
        onClick={() => {
          setCapturing(null);
          onSave(defaultValue);
        }}
        className={`${ghostActionClass} shrink-0 ${value !== defaultValue ? "" : "invisible"}`}
        title={`恢复默认 ${comboLabel(defaultValue)}`}
      >
        恢复
      </button>
      <button
        type="button"
        tabIndex={value !== "" ? undefined : -1}
        aria-hidden={value !== "" ? undefined : true}
        onClick={() => {
          setCapturing(null);
          onSave("");
        }}
        className={`${ghostActionClass} shrink-0 ${value !== "" ? hoverRevealClass : "invisible"}`}
      >
        禁用
      </button>
    </span>
  );
}

/** 快捷键分区内容：页切九行 + 全局两行；录制互斥态 capturing 在此层持有 */
function HotkeysSection({
  settings,
  patch,
}: {
  settings: AppSettings | null;
  patch: (p: Partial<AppSettings>) => void;
}) {
  const [capturing, setCapturing] = useState<string | null>(null);
  const palette = settings?.hotkeyPalette ?? "mod+k";
  const chrome = settings?.hotkeyHideChrome ?? "mod+\\";
  const pageSwitchOn = settings?.hotkeyPageSwitch !== false;
  const pageCombo = (id: string) =>
    settings?.hotkeyPages?.[id] ??
    PAGE_HOTKEY_DEFS.find((p) => p.id === id)?.combo ??
    "";
  const pageCombos = PAGE_HOTKEY_DEFS.map((p) => pageCombo(p.id));

  return (
    <>
      {/* 成组编辑器统一内容卡（design-system 设置页条目）：「页面快捷键」「全局快捷键」
          各收一张卡，卡内标准列表行 = 功能名在左、控件靠右，宽屏双列；行不铺底色块。
          「页面切换」总开关管的就是这张卡，放进卡头，不再单独占一行悬在卡外 */}
      <Card
        title="页面快捷键"
        hint={pageSwitchOn ? "一键直达下面九个主页面" : "已关闭：下面九个绑定暂不生效，仍可先改好"}
        action={
          <Toggle
            checked={pageSwitchOn}
            onChange={(v) => void patch({ hotkeyPageSwitch: v })}
            label="页面切换"
          />
        }
      >
        {/* 总开关关闭时整组弱化示意（仍可编辑，方便先配好再开） */}
        <div className={`grid grid-cols-1 gap-1 lg:grid-cols-2 ${pageSwitchOn ? "" : "opacity-50"}`}>
          {PAGE_HOTKEY_DEFS.map((p) => (
            <CardRow key={p.id} label={p.label}>
              <HotkeyCapture
                id={p.id}
                value={pageCombo(p.id)}
                defaultValue={p.combo}
                conflictsWith={[
                  palette,
                  chrome,
                  ...PAGE_HOTKEY_DEFS.filter((x) => x.id !== p.id).map(
                    (x) => pageCombo(x.id),
                  ),
                ]}
                onSave={(combo) =>
                  void patch({
                    hotkeyPages: {
                      ...(settings?.hotkeyPages ?? {}),
                      [p.id]: combo,
                    },
                  })
                }
                capturing={capturing}
                setCapturing={setCapturing}
              />
            </CardRow>
          ))}
        </div>
      </Card>
      <Card title="全局快捷键" hint="在任何页面都生效">
        <div className="grid grid-cols-1 gap-1 lg:grid-cols-2">
          <CardRow label="命令面板" title="页面跳转 / 主题 / 侧栏">
            <HotkeyCapture
              id="palette"
              value={palette}
              defaultValue="mod+k"
              conflictsWith={[chrome, ...pageCombos]}
              onSave={(combo) => void patch({ hotkeyPalette: combo })}
              capturing={capturing}
              setCapturing={setCapturing}
            />
          </CardRow>
          <CardRow label="隐藏侧栏" title="界面只剩工作内容">
            <HotkeyCapture
              id="chrome"
              value={chrome}
              defaultValue="mod+\\"
              conflictsWith={[palette, ...pageCombos]}
              onSave={(combo) => void patch({ hotkeyHideChrome: combo })}
              capturing={capturing}
              setCapturing={setCapturing}
            />
          </CardRow>
        </div>
      </Card>
    </>
  );
}

/** 一键卸载：清 Mesa 自己的数据，课题文件夹不动。确认两次，第二次要原样输入「卸载」。 */
/** 内置终端用哪个 shell：候选只列本机找得到的（后端 terminal_shell_options），选了没装的启动时回落自动 */
function TerminalShellRow({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const [options, setOptions] = useState<{ id: string; label: string; path: string }[]>([]);
  useEffect(() => {
    invoke<{ id: string; label: string; path: string }[]>("terminal_shell_options")
      .then(setOptions)
      .catch(() => setOptions([]));
  }, []);
  const missing = value !== "auto" && options.length > 0 && !options.some((o) => o.id === value);
  return (
    <Row
      label="内置终端 shell"
      hint={
        missing
          ? "选的 shell 本机找不到，新开的终端用自动"
          : IS_WINDOWS
            ? "新开的终端生效。自动 = Windows PowerShell；运行脚本固定用 Git Bash"
            : "新开的终端生效。自动 = 系统默认 shell（$SHELL）"
      }
      labelTitle={options.map((o) => `${o.label}：${o.path}`).join("\n") || undefined}
    >
      <select
        className={selectSm}
        value={missing ? "auto" : value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="auto">自动</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </Row>
  );
}

function UninstallRow() {
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [typed, setTyped] = useState("");
  async function uninstall() {
    if (busy || typed.trim() !== "卸载") return;
    setBusy(true);
    try {
      const result = await invoke<{
        trashed: string[];
        errors: string[];
        deferred: string[];
      }>("uninstall_mesa");
      if (result.errors.length > 0) {
        await alertDialog(
          `有 ${result.errors.length} 项没能清掉，应用先不退出：\n${result.errors.join("\n")}`,
        );
        setBusy(false);
        return;
      }
      // 界面记忆（最近项目、偏好等 ccode.* 键）在 WebView 的 localStorage 里，后端够不到。
      // 卸载真正成功后才清：后端中途拒绝（如 Windows 上还有终端开在 Mesa 目录里）时设置不该丢
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key?.startsWith("ccode.")) localStorage.removeItem(key);
      }
      // Windows：网页数据目录被 Mesa 自己占着，运行中删不掉，退出前告诉用户手动删
      if (result.deferred.length > 0) {
        await alertDialog(
          `以下目录 Mesa 运行时被自身占用，退出后请手动删除：\n${result.deferred.join("\n")}`,
        );
      }
      await exit(0);
    } catch (reason) {
      await alertDialog(`卸载没有完成：${String(reason)}`);
      setBusy(false);
    }
  }
  return (
    <div className="mt-3 ccode-well ccode-card px-4 py-3.5">
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-l1">卸载 Mesa</span>
          <span className="mt-0.5 block text-micro leading-4 text-l3">
            本机数据移入回收站。课题文件夹保留。完成后应用退出。
          </span>
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void (async () => {
            const ok = await confirmDialog(
              "卸载 Mesa 的本机数据？\n\n" +
                "会移入回收站：配置与密钥、技能库、会话索引、工作副本、定时任务记录，以及界面记住的最近项目和偏好。\n" +
                "课题文件夹、论文和各家 AI 自己的会话不会动。\n\n" +
                "应用本身还在：Mac 把 Mesa.app 拖进废纸篓；Windows 在「设置 → 应用」里卸载。",
              { danger: true, confirmText: "继续", focusCancel: true },
            );
            if (ok) setArmed(true);
          })()}
          className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg border border-err-text/40 px-3.5 text-xs font-medium text-err-text transition-colors hover:bg-hover disabled:opacity-50"
        >
          卸载…
        </button>
      </div>
      {armed && (
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void uninstall();
          }}
        >
          <input
            autoFocus
            value={typed}
            disabled={busy}
            onChange={(event) => setTyped(event.target.value)}
            placeholder="输入「卸载」"
            aria-label="输入卸载以确认"
            className={`${fieldClass} min-w-0 flex-1`}
          />
          <button
            type="submit"
            disabled={busy || typed.trim() !== "卸载"}
            className="inline-flex h-7 shrink-0 items-center justify-center rounded-md border border-err-text/40 px-2.5 text-xs text-err-text transition-colors hover:bg-hover disabled:opacity-50"
          >
            {busy ? "正在卸载…" : "确认卸载"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setArmed(false);
              setTyped("");
            }}
            className={`${ghostActionClass} shrink-0`}
          >
            取消
          </button>
        </form>
      )}
    </div>
  );
}

/** 自定义运行时：低频功能，平时只列已登记的条目；表单点「＋ 添加」或「编辑」才展开
 *  （原先五个空输入框常驻，是终端分区最占地方的东西，「添加」还被挤出首屏，2026-10-17） */
function CustomRuntimeBlock({
  onError,
  onNotice,
}: {
  onError: (msg: string) => void;
  onNotice: (msg: string) => void;
}) {
  const [list, setList] = useState<CustomRuntimeDto[]>([]);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [cwd, setCwd] = useState("");
  const [envText, setEnvText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function reload() {
    try {
      setList(await invoke<CustomRuntimeDto[]>("list_custom_runtimes"));
    } catch (e) {
      onError(String(e));
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function closeForm() {
    setEditingId(null);
    setName("");
    setCommand("");
    setArgs("");
    setCwd("");
    setEnvText("");
    setFormOpen(false);
  }

  async function save() {
    setBusy(true);
    try {
      const argList = args
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const lines = envText
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("#"));
      const invalid = lines.find((line) => {
        const i = line.indexOf("=");
        return i <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0, i).trim());
      });
      if (invalid) throw new Error(`环境变量格式无效：${invalid}`);
      const env = Object.fromEntries(
        lines
          .filter((line) => line.includes("="))
          .map((line) => {
            const i = line.indexOf("=");
            return [line.slice(0, i).trim(), line.slice(i + 1)];
          }),
      );
      await invoke("save_custom_runtime", {
        id: editingId,
        name,
        command,
        args: argList,
        env,
        cwd: cwd.trim() || null,
      });
      closeForm();
      onNotice("已保存自定义运行时");
      await reload();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="自定义运行时"
      hint="把本机一条命令登记成终端里可选的运行时，当普通终端跑（不注入密钥、不解析会话）；命令写绝对路径或 PATH 里的命令名"
      action={
        !formOpen && (
          <button
            type="button"
            className={`${ghostActionClass} shrink-0`}
            onClick={() => setFormOpen(true)}
          >
            ＋ 添加
          </button>
        )
      }
    >
      {list.length === 0 && !formOpen && (
        <p className="px-1 py-1 text-xs text-l4">
          还没有登记。需要在终端里直接跑某个本机工具（如自己的脚本、别的 CLI）时再加
        </p>
      )}
      {list.length > 0 && (
        <ul className="space-y-0.5">
          {list.map((r) => (
            <li
              key={r.id}
              className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-hover"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-l2">
                {r.name}
                <span className="ml-2 font-mono text-micro text-l4">
                  {[r.command, ...r.args].join(" ")}
                </span>
              </span>
              <button
                type="button"
                className={`${ghostActionClass} ${hoverRevealClass} shrink-0 text-micro`}
                onClick={() => {
                  setEditingId(r.id);
                  setName(r.name);
                  setCommand(r.command);
                  setArgs(r.args.join(" "));
                  setCwd(r.cwd ?? "");
                  setEnvText(Object.entries(r.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n"));
                  setFormOpen(true);
                }}
              >
                编辑
              </button>
              <button
                type="button"
                className={`${ghostActionClass} ${hoverRevealClass} shrink-0 text-micro`}
                onClick={() => {
                  void (async () => {
                    if (
                      !(await confirmDialog(
                        `删除自定义运行时「${r.name}」？登记的命令会从列表里去掉，已有终端标签不受影响。`,
                        { danger: true },
                      ))
                    )
                      return;
                    try {
                      await invoke("delete_custom_runtime", { id: r.id });
                      await reload();
                      onNotice(`已删除自定义运行时「${r.name}」`);
                    } catch (e) {
                      onError(String(e));
                    }
                  })();
                }}
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      )}
      {formOpen && (
        <form
          className={list.length > 0 ? "mt-3" : ""}
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && name.trim() && command.trim()) void save();
          }}
        >
          {/* 表单按「是什么 → 怎么跑 → 在哪跑」排成两列，环境变量多行占整宽 */}
          <div className="grid grid-cols-1 gap-2 @min-[36rem]/settings:grid-cols-2">
            <input
              className={`${fieldClass} h-8 py-0`}
              placeholder="名称"
              aria-label="运行时名称"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              className={`${fieldClass} h-8 py-0 font-mono text-xs`}
              placeholder="命令（绝对路径或 PATH 里的命令名）"
              aria-label="命令"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            />
            <input
              className={`${fieldClass} h-8 py-0 font-mono text-xs`}
              placeholder="参数（可选，空格分开）"
              aria-label="参数"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
            />
            <input
              className={`${fieldClass} h-8 py-0 font-mono text-xs`}
              placeholder="默认工作目录（可选，只在没有项目目录时用）"
              aria-label="默认工作目录"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
            />
            <textarea
              className={`${fieldClass} py-1.5 font-mono text-micro @min-[36rem]/settings:col-span-2`}
              placeholder={"环境变量（可选，每行 KEY=VALUE）"}
              aria-label="环境变量"
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              rows={2}
            />
          </div>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" className={`${ghostActionClass} shrink-0`} onClick={closeForm}>
              取消
            </button>
            <button
              type="submit"
              className={`${rowActionClass} shrink-0`}
              disabled={busy || !name.trim() || !command.trim()}
            >
              {editingId ? "保存修改" : "添加"}
            </button>
          </div>
        </form>
      )}
    </Card>
  );
}

export default function SettingsPage({ visible }: { visible: boolean }) {
  const settings = useAppStore((s) => s.settings);
  const loadSettings = useAppStore((s) => s.loadSettings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const profiles = useAppStore((s) => s.profiles);
  const aiChoices = aiProfileChoices(
    profiles,
    (id) => AGENTS.find((a) => a.id === id)?.label ?? id,
  );
  const loadAll = useAppStore((s) => s.loadAll);
  const appUpdate = useAppStore((s) => s.appUpdate);
  const appUpdateStatus = useAppStore((s) => s.appUpdateStatus);
  const appUpdateError = useAppStore((s) => s.appUpdateError);
  const checkAppUpdate = useAppStore((s) => s.checkAppUpdate);
  // 依赖体检（诊断区 Row）：store 共享，启动时已静默探测一次；一键安装完成后就地刷新
  const depCheck = useAppStore((s) => s.depCheck);
  const depCheckBusy = useAppStore((s) => s.depCheckBusy);
  const depCheckError = useAppStore((s) => s.depCheckError);
  const refreshDepCheck = useAppStore((s) => s.refreshDepCheck);
  const depInstall = useDepInstall((_tool, res) => {
    // xcode 渠道只是触发系统弹窗（versionAfter 恒 null），装没装完都靠「重新检测」收口
    if (res.ok && res.method !== "xcode") void refreshDepCheck();
  });
  // 外部「跳设置页并选中分区」的一次性请求（收件箱 dep: 条目发起）
  const settingsSectionReq = useAppStore((s) => s.settingsSectionReq);
  const setSettingsSectionReq = useAppStore((s) => s.setSettingsSectionReq);
  const [error, setError] = useState<string | null>(null);
  // 下载并安装：与帮助菜单「检查更新」弹窗同一流程（app-update-install.ts）
  const {
    installing,
    progress: installProgress,
    install: installUpdate,
  } = useAppUpdateInstall(setError);
  const autoOpenedUpdate = useRef(false);
  const [notice, setNotice] = useState<
    string | { text: string; openPath: string } | null
  >(null);
  // 成功横幅统一在这里收：原先各处自己 setTimeout(清空)，后一条提示会被前一条的计时器提前抹掉。
  // 停留时长随字数走（引导类长句要读得完），带「打开」的给足 10 秒；错误横幅不自动消失
  useEffect(() => {
    if (!notice) return;
    const text = typeof notice === "string" ? notice : notice.text;
    const ms =
      typeof notice === "string"
        ? Math.min(15000, Math.max(5000, text.length * 150))
        : 10000;
    const timer = window.setTimeout(() => setNotice(null), ms);
    return () => window.clearTimeout(timer);
  }, [notice]);
  // 恢复上次查看的分区（HIG settings.md「Restore the most recently viewed pane」）：
  // 常改的设置往往连着改几次，每次都弹回「外观」要重新点。非法/清空的存量值回落外观。
  const [activeSection, setActiveSection] = useState(() => {
    try {
      const saved = localStorage.getItem("ccode.settings.section");
      return saved && SETTING_NAV.some((n) => n.id === saved)
        ? saved
        : "appearance";
    } catch {
      return "appearance";
    }
  });
  // 外部深链与「有更新切到更新分区」也会改 activeSection，统一在这里落盘
  useEffect(() => {
    try {
      localStorage.setItem("ccode.settings.section", activeSection);
    } catch {
      /* 私密模式等场景写不进就算了，不影响当次会话 */
    }
  }, [activeSection]);
  /** 设置页搜索：只筛左侧分区，不做逐行高亮（见 settings-search.ts 的说明） */
  const [sectionQuery, setSectionQuery] = useState("");
  /** 命中的分区 id（按相关度）。空查询 = 全部。 */
  const matchedSections = useMemo(
    () => searchSettings(sectionQuery).map((hit) => hit.id),
    [sectionQuery],
  );
  const contentRef = useRef<HTMLDivElement>(null);
  // 数值输入的本地草稿（失焦/回车才提交，避免每击键一次 IPC）
  const [fontSize, setFontSize] = useState("");
  const [fontFamily, setFontFamily] = useState("JetBrains Mono");
  const [customFont, setCustomFont] = useState("");
  const [scrollback, setScrollback] = useState("");
  const [rate, setRate] = useState("");
  const [outboundProxy, setOutboundProxy] = useState("");
  const [customDraft, setCustomDraft] = useState<CustomThemeSeeds | null>(null);
  const customPatchTimer = useRef<number | null>(null);
  const [savingCard, setSavingCard] = useState(false);
  const [cardNameDraft, setCardNameDraft] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [outboundNoProxy, setOutboundNoProxy] = useState("");
  // 机构访问（高校/研究所全文通道）：前缀与登录页草稿 + 会话状态（值在后端 0600 文件，这里只有统计态）
  const [institutionalPrefix, setInstitutionalPrefix] = useState("");
  const [institutionalLoginUrl, setInstitutionalLoginUrl] = useState("");
  const [instStatus, setInstStatus] = useState<InstSessionStatus | null>(null);
  const [instBusy, setInstBusy] = useState<"login" | "capture" | "clear" | "bridge" | null>(null);
  // null = 跟随默认（已填前缀 / 自定义入口 / 已有内嵌会话则展开）；人手点过之后不再抢
  const [instPrefixOpen, setInstPrefixOpen] = useState<boolean | null>(null);
  const [instOtherOpen, setInstOtherOpen] = useState<boolean | null>(null);
  // 出网代理自动检测：候选由后端读系统代理/环境变量/常见端口产出，点选才写入
  const [proxyDetecting, setProxyDetecting] = useState(false);
  const [proxyCandidates, setProxyCandidates] = useState<
    { url: string; source: string; alive: boolean }[] | null
  >(null);
  // 自定义定价的表格草稿（保存时序列化为 pricing.json 的 {"前缀":[输入,输出]} 格式，后端校验不变）
  const [pricingRows, setPricingRows] = useState<
    { prefix: string; input: string; output: string }[]
  >([]);
  // 文件里已有的 _rate 原样保留（汇率主入口是上方「汇率」设置项，这里只为了不丢数据）
  const [pricingRateExtra, setPricingRateExtra] = useState<number | null>(null);
  const [pricingDirty, setPricingDirty] = useState(false);
  // 未提交草稿标记（ref 镜像供 effect 内读取）：settings 变化（如切主题）时不覆盖正在编辑的输入框
  const draftDirty = useRef(new Set<string>());
  const pricingDirtyRef = useRef(false);
  function markPricingDirty(d: boolean) {
    pricingDirtyRef.current = d;
    setPricingDirty(d);
  }
  const [savingPricing, setSavingPricing] = useState(false);
  // 查不到价格的模型（用量页分区可见时拉一次，保存定价后重拉）
  const [unpriced, setUnpriced] = useState<UnpricedModelDto[] | null>(null);
  async function loadUnpriced() {
    try {
      setUnpriced(await invoke<UnpricedModelDto[]>("usage_unpriced_models"));
    } catch {
      setUnpriced(null); // 只是辅助清单，读不到就不显示，不打断定价编辑
    }
  }
  // 诊断日志（进程内环形缓冲，分区展开时拉最近 100 条）
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [diagnosticsExporting, setDiagnosticsExporting] = useState(false);
  // 生效配置快照导出进行态（排查九家 agent 配置漂移用）
  const [configDumpExporting, setConfigDumpExporting] = useState(false);
  // 可安装字体预设的安装状态（id → installed）：进页面查一次缓存，安装成功后刷新
  const [fontStatus, setFontStatus] = useState<Record<string, boolean>>({});
  // 字体安装进行态 / 实时输出 / 最近结果；target 记录本次安装的字体 id（切换选择后隐藏旧输出）
  const [fontInstalling, setFontInstalling] = useState(false);
  const [fontInstallOutput, setFontInstallOutput] = useState("");
  const [fontInstallResult, setFontInstallResult] =
    useState<FontInstallResult | null>(null);
  const [fontInstallTarget, setFontInstallTarget] = useState<string | null>(
    null,
  );
  // 应用版本（「关于」分区）：Tauri 从 tauri.conf.json 取，与打包产物一致
  const [appVersion, setAppVersion] = useState<string | null>(null);
  // 构建信息（「关于」分区）：平台/架构/渠道，辨认自己装的是哪种包（Intel 自构建版等）
  const [buildInfo, setBuildInfo] = useState<{
    os: string;
    arch: string;
    channel: string;
  } | null>(null);
  // 第三方许可清单：首次点「查看开源许可」才拉（几百 KB 文本，不值得常驻）
  const [noticesText, setNoticesText] = useState<string | null>(null);
  const [noticesOpen, setNoticesOpen] = useState(false);
  // 「反馈与提需求」行的表单弹层（与顶栏帮助菜单共用同一个 FeedbackModal 组件）
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // 精确注意力标记支持清单（九家全列出，支持与否与备注以后端注册表为准）
  const [hookSupport, setHookSupport] = useState<HookSupport[]>([]);
  const [hookSupportError, setHookSupportError] = useState<string | null>(null);
  async function loadHookSupport() {
    try {
      setHookSupport(await invoke<HookSupport[]>("hooks_attention_support"));
      setHookSupportError(null);
    } catch (e) {
      setHookSupportError(`注意力标记支持清单加载失败：${String(e)}`);
    }
  }
  useEffect(() => {
    if (visible) contentRef.current?.scrollIntoView({ block: "start", inline: "nearest" });
  }, [activeSection, visible]);

  // 应用数据占用：选中「数据与存储」时读一次（递归求目录大小，不适合常驻轮询）
  const [storage, setStorage] = useState<StorageEntryDto[] | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  // 真实用户家目录：工作副本可换到别的盘后，不能再从条目路径反推（会把组头错折成 ~/ccode）
  const [homeDir, setHomeDir] = useState("");
  async function loadStorage() {
    try {
      void invoke<string>("home_dir").then(setHomeDir).catch(() => {});
      setStorage(await invoke<StorageEntryDto[]>("app_storage_usage"));
    } catch {
      setStorage(null);
      setStorageError("存储占用统计失败，请稍后重试。");
    }
  }
  useEffect(() => {
    if (
      visible &&
      activeSection === "storage" &&
      storage === null
    ) {
      setStorageError(null);
      void loadStorage();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, activeSection]);

  /** 工作副本家目录换位置：选目录 → 说清只管新建的 → 后端校验落盘；path 为 null = 恢复默认 */
  const [movingRoot, setMovingRoot] = useState(false);
  async function changeWorkspaceRoot(restoreDefault: boolean) {
    setError(null);
    let target: string | null = null;
    if (!restoreDefault) {
      const picked = await openDirectory({
        directory: true,
        multiple: false,
        title: "选择存放工作副本的文件夹（Mesa 会在里面建 ccode 目录）",
      });
      if (typeof picked !== "string") return;
      target = picked;
    }
    const where = target ? `${target.replace(/[\\/]+$/, "")}${IS_WINDOWS ? "\\" : "/"}ccode` : "~/ccode";
    const ok = await confirmDialog(
      `此后新建的编程工作树、科研工作副本、定时隔离树放进：\n${where}\n\n` +
        "已有的不会自动搬，继续留在原处照常使用；它们在下方「本机占用」里仍会列出，" +
        "走项目页的归档 / 删除清掉后，空间才会释放。",
      { confirmText: target ? "使用这个位置" : "恢复默认", focusCancel: false },
    );
    if (!ok) return;
    setMovingRoot(true);
    try {
      const next = await invoke<AppSettings>("set_workspace_root", { path: target });
      useAppStore.setState({ settings: next });
      setNotice(target ? `工作副本位置已改为 ${where}` : "工作副本位置已恢复默认");
      setStorage(null);
      await loadStorage();
    } catch (e) {
      const message = String(e);
      setError(message);
      toast(`设置工作副本位置失败：${message}`, "error");
    } finally {
      setMovingRoot(false);
    }
  }

  /** 清理一项可清理的应用数据（后端白名单把关，整目录移回收站）；先确认、后重统计 */
  const [clearingStorage, setClearingStorage] = useState<string | null>(null);
  async function clearStorage(entry: StorageEntryDto) {
    const ok = await confirmDialog(
      storageClearConfirmText(entry.id, entry.label, formatBytes(entry.bytes)),
      { danger: true, confirmText: "移到回收站", focusCancel: true },
    );
    if (!ok) return;
    setClearingStorage(entry.id);
    setError(null);
    try {
      await invoke("clear_storage_entry", { id: entry.id });
      setNotice(`已把「${entry.label}」移到回收站`);
      await loadStorage();
    } catch (e) {
      const message = String(e);
      setError(message);
      toast(`清理失败：${message}`, "error");
    } finally {
      setClearingStorage(null);
    }
  }

  useEffect(() => {
    if (!visible) return;
    loadSettings().catch((e) => setError(String(e)));
    refreshFontStatus();
  }, [visible, loadSettings]);

  useEffect(() => {
    if (!visible || activeSection !== "integration") return;
    if (profiles.length === 0)
      loadAll().catch((e) => setError(`连接配置加载失败：${String(e)}`));
    if (hookSupport.length === 0 && !hookSupportError) void loadHookSupport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, activeSection]);

  useEffect(() => {
    if (!visible || activeSection !== "about" || appVersion !== null) return;
    getVersion()
      .then(setAppVersion)
      .catch(() => toast("应用版本读取失败", "warning"));
    if (buildInfo === null) {
      invoke<{ os: string; arch: string; channel: string }>("build_info")
        .then(setBuildInfo)
        .catch(() => setBuildInfo(null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, activeSection]);

  /** 打开「开源许可」浮层：清单文本懒加载一次，失败提示不弹层 */
  async function openNotices() {
    const text = noticesText ?? (await loadThirdPartyNotices());
    if (text === null) return;
    setNoticesText(text);
    setNoticesOpen(true);
  }

  useEffect(() => {
    if (!visible || activeSection !== "stats") return;
    void loadUnpriced();
    if (pricingDirtyRef.current) return;
    invoke<string>("read_pricing_file")
      .then((t) => {
        if (!t.trim()) {
          setPricingRows([]);
          setPricingRateExtra(null);
        } else {
          try {
            const v = JSON.parse(t) as Record<string, unknown>;
            setPricingRateExtra(
              typeof v._rate === "number" ? v._rate : null,
            );
            setPricingRows(
              Object.entries(v)
                .filter(([k, val]) => k !== "_rate" && Array.isArray(val))
                .map(([prefix, val]) => ({
                  prefix,
                  input: String((val as unknown[])[0] ?? ""),
                  output: String((val as unknown[])[1] ?? ""),
                })),
            );
          } catch (e) {
            setPricingRows([]);
            setPricingRateExtra(null);
            setError(`pricing.json 解析失败（${e}），编辑后保存将覆盖原文件`);
          }
        }
        markPricingDirty(false);
      })
      .catch((e) => setError(String(e)));
  }, [visible, activeSection]);

  // settings 到达后同步草稿（正在编辑、未提交的输入框跳过）
  useEffect(() => {
    if (settings) {
      const dirty = draftDirty.current;
      if (!dirty.has("fontSize"))
        setFontSize(String(settings.terminalFontSize));
      if (!dirty.has("scrollback")) setScrollback(String(settings.scrollback));
      if (!dirty.has("rate")) setRate(String(settings.rateUsdCny));
      if (!dirty.has("outboundProxy"))
        setOutboundProxy(settings.outboundProxy ?? "");
      if (!dirty.has("outboundNoProxy"))
        setOutboundNoProxy(settings.outboundNoProxy ?? "");
      if (!dirty.has("institutionalPrefix"))
        setInstitutionalPrefix(settings.institutionalPrefix ?? "");
      if (!dirty.has("institutionalLoginUrl"))
        setInstitutionalLoginUrl(settings.institutionalLoginUrl ?? "");
      if (!dirty.has("customFont")) {
        const fam = settings.terminalFontFamily ?? "JetBrains Mono";
        if (isKnownTerminalFont(fam)) {
          setFontFamily(fam);
        } else {
          setFontFamily("__custom__");
          setCustomFont(fam);
        }
      }
    }
  }, [settings]);

  // 机构访问：网络分区展开时拉会话状态；登录窗自动保存成功事件到达即刷新
  async function loadInstStatus() {
    try {
      setInstStatus(await invoke<InstSessionStatus>("inst_session_status"));
    } catch (e) {
      setError(`机构访问状态加载失败：${String(e)}`);
    }
  }
  useEffect(() => {
    if (!visible || activeSection !== "network") return;
    void loadInstStatus();
  }, [visible, activeSection]);
  useEffect(() => {
    if (!visible) return;
    const un = listen<{ credible?: boolean; empty?: boolean }>(
      "inst-session-captured",
      (e) => {
        // 入口页一打开的 pre-auth Cookie 也算「保存」，但真取全文只会报会话过期——
        // 如实区分（2026-09-17 审计：旧文案在用户还没登录时就说「可以取全文了」）；
        // 空罐事件是窗里全部登出，文案不得再说「检测到入口会话」
        if (e.payload?.empty) {
          setNotice("登录窗里的会话已全部退出，本地保存的会话已同步清空");
        } else {
          setNotice(
            e.payload?.credible === false
              ? "已检测到入口页会话——完成机构登录后会自动更新，届时才能逐篇「获取全文」"
              : "机构登录会话已保存，可以在文献清单里逐篇「获取全文」了",
          );
        }
        void loadInstStatus();
      },
    );
    return () => {
      void un.then((f) => f());
    };
  }, [visible]);

  /** 出网代理检测：后端读系统代理/环境变量/常见端口，候选点选才写入 */
  async function detectProxy() {
    setProxyDetecting(true);
    setError(null);
    try {
      setProxyCandidates(
        await invoke<{ url: string; source: string; alive: boolean }[]>(
          "detect_outbound_proxy",
        ),
      );
    } catch (e) {
      setError(`代理检测失败：${String(e)}`);
    } finally {
      setProxyDetecting(false);
    }
  }

  function applyProxyCandidate(url: string) {
    draftDirty.current.delete("outboundProxy");
    setOutboundProxy(url);
    void patch({ outboundProxy: url });
    // 选完即收：候选列表是挑选工具，选中后留在页面上只剩噪音（2026-09-17 用户实测）
    setProxyCandidates(null);
  }

  /** 打开机构登录（通道 B）：默认走系统浏览器——真实浏览器干浏览器的事，
   *  登录一次后浏览器 profile 持续有效；文献下载由收货通道/浏览器桥接走 papers/。
   *  什么都不填也行：默认开 CARSI 高校联盟入口（选学校 → 登录 → 顺手点进一个数据库） */
  async function openInstLogin() {
    const typed = institutionalLoginUrl.trim() || institutionalPrefix.trim();
    const url = typed || DEFAULT_INST_LOGIN_URL;
    if (!/^https?:\/\//i.test(url)) {
      setError("机构登录页须是 http(s):// 开头的完整地址（学校图书馆入口或代理登录页）");
      return;
    }
    setInstBusy("login");
    setError(null);
    try {
      if (typed) await patch({ institutionalLoginUrl: typed });
      await invoke("inst_browser_open", { url });
      setNotice(
        "已打开浏览器。选学校、完成登录后，待获取清单点「浏览器」下载，PDF 自动进项目",
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setInstBusy(null);
    }
  }

  /** 旧通道回落：内嵌登录窗（会话倒回 Mesa，供 fetch_via_channel 无头阶梯用） */
  async function openInstLoginEmbedded() {
    const typed = institutionalLoginUrl.trim() || institutionalPrefix.trim();
    const url = typed || DEFAULT_INST_LOGIN_URL;
    if (!/^https?:\/\//i.test(url)) {
      setError("机构登录页须是 http(s):// 开头的完整地址");
      return;
    }
    setInstBusy("login");
    setError(null);
    try {
      if (typed) await patch({ institutionalLoginUrl: typed });
      await invoke("inst_open_login", { url });
      setNotice("内嵌登录窗已打开——登录后会话自动增量保存（此通道仅供无头阶梯与调试，日常下载走浏览器）");
    } catch (e) {
      setError(String(e));
    } finally {
      setInstBusy(null);
    }
  }

  /** 安装浏览器桥（通道 C）：写 NativeMessagingHosts 清单 + 把扩展目录就位到
   *  配置目录（结果里带实际路径——装 DMG 的用户没有仓库，不能再指仓库目录） */
  async function installBrowserBridge() {
    setInstBusy("bridge");
    setError(null);
    try {
      const results = await invoke<string[]>("install_browser_bridge");
      setNotice(
        `浏览器桥：${results.join("；")}。只支持 Chrome/Edge 等 Chromium 系浏览器（Safari/Firefox 装不了扩展，用「浏览器打开」+90 秒自动收货即可）`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setInstBusy(null);
    }
  }

  async function captureInstSession() {
    setInstBusy("capture");
    setError(null);
    try {
      setInstStatus(await invoke<InstSessionStatus>("inst_capture_session"));
      setNotice("机构会话已保存，可以在文献清单里逐篇「获取全文」了");
    } catch (e) {
      setError(String(e));
    } finally {
      setInstBusy(null);
    }
  }

  async function clearInstSession() {
    setInstBusy("clear");
    setError(null);
    try {
      setInstStatus(await invoke<InstSessionStatus>("inst_clear_session"));
      setNotice("机构会话已清除");
    } catch (e) {
      setError(String(e));
    } finally {
      setInstBusy(null);
    }
  }

  // 主题色卡：从 App.css 源文本抽色，不切正在显示的主题
  const themeSwatches = useMemo(() => {
    const colors = parseThemeSwatchesFromCss(appCss);
    return THEMES.map((t) => ({ ...t, ...themeSwatchFor(t.id, colors) }));
  }, []);
  const customCards = normalizeCustomThemeCards(settings?.customThemes);
  const selectedCardId = resolveCustomThemeCardId(
    customCards,
    settings?.customThemeCardId,
  );
  const customSelected = isCustomThemeId(settings?.theme) && !selectedCardId;
  const followSystem = settings?.themeFollowSystem === true;
  const savedCustom = normalizeCustomTheme(settings?.customTheme);
  const customSeeds =
    customDraft ??
    (customSelected ? savedCustom : null) ??
    seedsFromComputed(getComputedStyle(document.documentElement)) ??
    savedCustom ??
    DEFAULT_CUSTOM_THEME;
  const customDerived = useMemo(
    () => deriveThemeTokens(savedCustom ?? customSeeds),
    [
      savedCustom?.rail,
      savedCustom?.canvas,
      savedCustom?.accent,
      customSeeds.rail,
      customSeeds.canvas,
      customSeeds.accent,
    ],
  );
  const pickerDerived = useMemo(
    () => deriveThemeTokens(customSeeds),
    [customSeeds.rail, customSeeds.canvas, customSeeds.accent],
  );

  function persistCustom(next: CustomThemeSeeds) {
    const id = customThemeIdFromSeeds(next);
    applyTheme(id, next);
    void patch({ theme: id, customTheme: next, customThemeCardId: "" });
  }

  function liveCustom(next: CustomThemeSeeds) {
    setCustomDraft(next);
    applyTheme(customThemeIdFromSeeds(next), next);
    if (customPatchTimer.current) window.clearTimeout(customPatchTimer.current);
    customPatchTimer.current = window.setTimeout(() => {
      persistCustom(next);
    }, 180);
  }

  function commitCustom(next: CustomThemeSeeds) {
    if (customPatchTimer.current) {
      window.clearTimeout(customPatchTimer.current);
      customPatchTimer.current = null;
    }
    setCustomDraft(next);
    persistCustom(next);
  }

  // 进入自定义＝把正在显示的主题三色拷进来、外观不跳变；取不到才回落上次的自定义 / 默认
  function activateCustom() {
    const saved = normalizeCustomTheme(settings?.customTheme);
    const computed = seedsFromComputed(getComputedStyle(document.documentElement));
    commitCustom(computed ?? saved ?? DEFAULT_CUSTOM_THEME);
  }

  function applySavedCard(card: CustomThemeCard) {
    if (customPatchTimer.current) {
      window.clearTimeout(customPatchTimer.current);
      customPatchTimer.current = null;
    }
    const seeds = {
      rail: card.rail,
      canvas: card.canvas,
      accent: card.accent,
    };
    setCustomDraft(null);
    applyTheme(customThemeIdFromSeeds(seeds), seeds);
    void patch({
      theme: customThemeIdFromSeeds(seeds),
      customTheme: seeds,
      customThemeCardId: card.id,
    });
  }

  function startSaveCard() {
    if (customCards.length >= CUSTOM_THEME_CARDS_MAX) return;
    setCardNameDraft(nextCardName(customCards));
    setSavingCard(true);
  }

  function confirmSaveCard() {
    const result = addCustomThemeCard(customCards, customSeeds, cardNameDraft);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setSavingCard(false);
    const seeds = {
      rail: result.card.rail,
      canvas: result.card.canvas,
      accent: result.card.accent,
    };
    setCustomDraft(null);
    applyTheme(customThemeIdFromSeeds(seeds), seeds);
    void patch({
      theme: customThemeIdFromSeeds(seeds),
      customTheme: seeds,
      customThemes: result.list,
      customThemeCardId: result.card.id,
    });
  }

  async function deleteSavedCard(card: CustomThemeCard) {
    if (
      !(await confirmDialog(`删除色卡「${card.name}」？`, {
        danger: true,
        confirmText: "删除",
      }))
    )
      return;
    const next = removeCustomThemeCard(customCards, card.id);
    const patchBody: Parameters<typeof updateSettings>[0] = {
      customThemes: next,
    };
    if (selectedCardId === card.id) patchBody.customThemeCardId = "";
    void patch(patchBody);
  }

  function commitRename(card: CustomThemeCard) {
    const next = renameCustomThemeCard(customCards, card.id, renameDraft);
    setRenamingId(null);
    void patch({ customThemes: next });
  }

  async function patch(p: Parameters<typeof updateSettings>[0]) {
    setError(null);
    try {
      await updateSettings(p);
    } catch (e) {
      const message = String(e);
      setError(message);
      toast(`设置保存失败：${message}`, "error");
    }
  }

  /** 应用图标：先落设置再换图——设置没存上就不换，免得重启后与界面显示的不一致 */
  async function setAppIcon(style: "system" | "dark" | "light") {
    setError(null);
    try {
      await updateSettings({ appIconStyle: style });
    } catch (e) {
      const message = String(e);
      setError(message);
      toast(`设置保存失败：${message}`, "error");
      return;
    }
    try {
      await invoke("apply_app_icon", { style });
    } catch (e) {
      toast(`应用图标没换上：${String(e)}`, "warning");
    }
  }

  /** 按功能 AI 配置：改一键后整图提交；空值 = 删除该键（跟随默认） */
  function patchAiFnProfile(fnKey: string, value: string) {
    const next = { ...(settings?.aiProfiles ?? {}) };
    const models = { ...(settings?.aiProfileModels ?? {}) };
    if (!value) {
      delete next[fnKey];
      delete models[fnKey];
    } else {
      const choice = parseAiProfileChoice(value);
      next[fnKey] = choice.profileId;
      if (choice.model) models[fnKey] = choice.model;
      else delete models[fnKey];
    }
    void patch({ aiProfiles: next, aiProfileModels: models });
  }

  function patchAiProfile(value: string) {
    const choice = parseAiProfileChoice(value);
    void patch({ aiProfileId: choice.profileId, aiModel: choice.model });
  }

  /** 精确注意力标记开关：走专用命令（写/移除该 agent 的 hooks 配置 + 记设置），
      不走普通 patch——失败时设置不落库，避免开关显示与实际安装不一致 */
  const [hooksBusy, setHooksBusy] = useState<string | null>(null);
  async function toggleHooks(agent: string, label: string, enabled: boolean) {
    if (hooksBusy) return;
    setError(null);
    setHooksBusy(agent);
    try {
      const s = await invoke<AppSettings>("set_hooks_attention", {
        agent,
        enabled,
      });
      useAppStore.setState({ settings: s });
      const target = hookSupport.find((h) => h.agent === agent)?.configPath;
      setNotice(
        enabled
          ? `已开启：${label} hooks 已写入 ${target ?? "其配置文件"}`
          : `已关闭：${label} hooks 已移除`,
      );
    } catch (e) {
      const message = String(e);
      setError(message);
      toast(`hooks 配置失败：${message}`, "error");
    } finally {
      setHooksBusy(null);
    }
  }

  function commitNumber(
    raw: string,
    min: number,
    max: number,
    apply: (n: number) => void,
  ) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    apply(Math.min(max, Math.max(min, Math.round(n * 100) / 100)));
  }

  async function savePricing() {
    setSavingPricing(true);
    setError(null);
    try {
      // 表格序列化回 pricing.json 既有格式：{"前缀": [输入价, 输出价]}；空前缀行丢弃
      const obj: Record<string, unknown> = {};
      if (pricingRateExtra != null) obj._rate = pricingRateExtra;
      for (const row of pricingRows) {
        const prefix = row.prefix.trim();
        if (!prefix) continue;
        obj[prefix] = [Number(row.input) || 0, Number(row.output) || 0];
      }
      const text = Object.keys(obj).length
        ? JSON.stringify(obj, null, 2)
        : "";
      await invoke("write_pricing_file", { text });
      markPricingDirty(false);
      setNotice("已保存，用量页下次查询生效");
      void loadUnpriced();
    } catch (e) {
      const message = String(e);
      setError(message);
      toast(`定价保存失败：${message}`, "error");
    } finally {
      setSavingPricing(false);
    }
  }

  async function loadLogs() {
    try {
      setLogs(await invoke<LogEntry[]>("get_app_log", { limit: 100 }));
    } catch (e) {
      const message = String(e);
      setError(message);
      toast(`日志读取失败：${message}`, "warning");
    }
  }

  async function refreshFontStatus() {
    try {
      const list = await invoke<FontStatus[]>("font_status");
      setFontStatus(Object.fromEntries(list.map((f) => [f.id, f.installed])));
    } catch (e) {
      toast(`字体状态读取失败：${String(e)}`, "warning");
    }
  }

  /** 一键安装字体：先挂事件监听再 invoke；结果以 done 事件为准，invoke 返回值兜底
      （同 ProfilesPage runAgentCmd 模式；brew cask 无需交互，不挂输入行） */
  async function installFont(fontId: string) {
    setFontInstalling(true);
    setFontInstallTarget(fontId);
    setFontInstallOutput("");
    setFontInstallResult(null);
    const unOut = await listen<string>("font-install-output", (e) => {
      setFontInstallOutput((prev) => prev + e.payload);
    });
    let doneArrived = false;
    const unDone = await listen<FontInstallResult>("font-install-done", (e) => {
      doneArrived = true;
      setFontInstallResult(e.payload);
    });
    try {
      const res = await invoke<FontInstallResult>("install_font", { fontId });
      if (!doneArrived) setFontInstallResult(res);
      // emit_done 推送与 invoke 返回的是同一份结果，ok 以 res 为准即可
      if (res.ok) {
        await refreshFontStatus();
        setNotice("字体已安装，重新打开终端后生效");
      }
    } catch (e) {
      const message = String(e);
      setError(message);
      toast(`字体安装失败：${message}`, "error");
      if (!doneArrived)
        setFontInstallResult({ ok: false, output: message });
    } finally {
      unOut();
      unDone();
      setFontInstalling(false);
    }
  }

  // 选中「诊断」（且页面可见）时拉取日志；依赖体检尚无结果时顺带探测一次
  useEffect(() => {
    if (visible && activeSection === "diag") {
      loadLogs();
      if (!useAppStore.getState().depCheck) void refreshDepCheck();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, activeSection]);

  // 收件箱 dep: 条目等外部请求：选中目标分区（消费后清空请求）
  useEffect(() => {
    if (!visible || !settingsSectionReq) return;
    const target = settingsSectionReq;
    setSettingsSectionReq(null);
    if (SETTING_NAV.some((item) => item.id === target)) setActiveSection(target);
  }, [visible, settingsSectionReq, setSettingsSectionReq]);

  // 有可用更新且用户还停在默认「外观」时切到更新分区，避免导航里的更新提示被忽略。
  // 已经点过别的分区或外部指定了分区（收件箱 dep: 等）不抢。
  useEffect(() => {
    if (!visible || !appUpdate || autoOpenedUpdate.current) return;
    autoOpenedUpdate.current = true;
    if (settingsSectionReq) return;
    setActiveSection((cur) => (cur === "appearance" ? "update" : cur));
  }, [visible, appUpdate, settingsSectionReq]);

  async function clearLogs() {
    setError(null);
    try {
      await invoke("clear_app_log");
      setLogs([]);
      setNotice("应用日志已清理");
    } catch (e) {
      const message = String(e);
      setError(message);
      toast(`清理日志失败：${message}`, "error");
    }
  }

  async function copyLogs() {
    const text = formatLogText(logs);
    try {
      await navigator.clipboard.writeText(text);
      setNotice("已复制到剪贴板");
    } catch (e) {
      const message = String(e);
      setError(message);
      toast(`复制日志失败：${message}`, "warning");
    }
  }

  async function exportDiagnosticsBundle() {
    if (diagnosticsExporting) return;
    setDiagnosticsExporting(true);
    setError(null);
    try {
      const path = await invoke<string>("export_diagnostics_bundle", {
        frontend: collectFrontendDiagnostics(),
      });
      setNotice({ text: `诊断包已导出：${path}`, openPath: path });
      await loadLogs();
    } catch (e) {
      const message = String(e);
      setError(message);
      toast(`诊断包导出失败：${message}`, "error");
    } finally {
      setDiagnosticsExporting(false);
    }
  }

  // 生效配置快照：一键落盘 ~/Downloads/ccode-exports/（口径同诊断包导出）；
  // 设置页无项目语境，projectRoot 传 null（workspaceSettings 段不产出）
  async function exportEffectiveConfig() {
    if (configDumpExporting) return;
    setConfigDumpExporting(true);
    setError(null);
    try {
      const path = await invoke<string>("export_effective_config", {
        projectRoot: null,
      });
      setNotice({ text: `配置快照已导出：${path}`, openPath: path });
    } catch (e) {
      const message = String(e);
      setError(message);
      toast(`配置快照导出失败：${message}`, "error");
    } finally {
      setConfigDumpExporting(false);
    }
  }

  async function openStorageEntry(path: string) {
    setError(null);
    try {
      // 条目既可能是文件也可能是目录；统一在系统文件管理器中定位，
      // 避免把目录交给默认应用后看起来像按钮无效。
      await revealItemInDir(path);
    } catch (e) {
      const message = `无法打开此位置：${String(e)}`;
      setError(message);
      toast(message, "warning");
    }
  }

  const prefixDraftInvalid =
    Boolean(institutionalPrefix.trim()) &&
    !/^https?:\/\//i.test(institutionalPrefix.trim());
  const prefixOpen =
    instPrefixOpen ??
    instPrefixPanelDefaultOpen(
      institutionalPrefix,
      instStatus?.prefixInvalid || prefixDraftInvalid,
    );
  const otherOpen =
    instOtherOpen ??
    instOtherPanelDefaultOpen(
      institutionalLoginUrl,
      Boolean(instStatus?.sessionPresent),
    );

  // 结果横幅统一口径：well 底 + ✓/✗ 语义色文字，不铺整块 bg-ok/bg-err。
  // 放进内容列并吸顶：原先挂在页头下方，分区一长、点了底部的按钮，结果出在视野外
  const banners = (error || notice) && (
    <div className="sticky top-14 z-10 mb-3 flex flex-col gap-2">
      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-md ccode-well px-3 py-2.5 text-xs leading-5 text-l2 shadow-sm">
          <span className="shrink-0 text-err-text">✗</span>
          <span className="min-w-0 flex-1">{error}</span>
          <button
            type="button"
            aria-label="关闭错误提示"
            onClick={() => setError(null)}
            className="shrink-0 rounded-sm text-l4 hover:text-l1"
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {notice && (
        <div role="status" className="flex items-start gap-2 rounded-md ccode-well px-3 py-2.5 text-xs leading-5 text-l2 shadow-sm">
          <span className="shrink-0 text-ok-text">✓</span>
          <span className="min-w-0 flex-1">
            {typeof notice === "string" ? notice : notice.text}
          </span>
          {typeof notice !== "string" && (
            <button
              type="button"
              className="h-6 shrink-0 rounded-md border border-field bg-strip px-2 text-micro text-l2 hover:bg-hover hover:text-l1"
              onClick={() => void revealItemInDir(notice.openPath)}
            >
              打开
            </button>
          )}
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => setNotice(null)}
            className="shrink-0 rounded-sm text-l4 hover:text-l1"
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );

  return (
    <PageFrame width="wide">
      <PageHeader title="设置" meta="外观、终端、AI 与应用管理" />

      <div className="@container">
        <div className="grid min-w-0 gap-5 @min-[48rem]:grid-cols-[11rem_minmax(0,1fr)] @min-[48rem]:gap-7">
          <nav aria-label="设置分区" className="self-start @min-[48rem]:sticky @min-[48rem]:top-16">
            {/* 搜索框无描边口径（与 searchFieldClass 同配方）：inset 底、聚焦加深；
                带图标/清除钮，聚焦态挂在容器 focus-within 上；ccode-search-shell
                豁免内部 input 的全局 focus 环（未入层规则压过 outline-none，会出直角方框） */}
            <div className="ccode-search-shell mb-3 flex h-8 items-center gap-2 rounded-md bg-inset px-2.5 transition-colors focus-within:bg-raised">
              <Search aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-l4" />
              <input
                value={sectionQuery}
                onChange={(event) => setSectionQuery(event.target.value)}
                placeholder="找设置…"
                aria-label="搜索设置"
                className="min-w-0 flex-1 bg-transparent text-xs text-l2 outline-none placeholder:text-l4"
              />
              {sectionQuery && (
                <button
                  type="button"
                  aria-label="清除搜索"
                  onClick={() => setSectionQuery("")}
                  className="shrink-0 text-l4 hover:text-l1"
                >
                  <X aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-4 @min-[48rem]:flex-col @min-[48rem]:gap-5">
              {([
                { id: "basic", label: "常用" },
                { id: "management", label: "管理" },
              ] as const).map((group) => {
                // 搜索只筛显示的档，不隐藏分组标题：标题消失会让剩下的项看起来
                // 不知属于哪一类，而分组本身没有搜索语义
                const items = SETTING_NAV.filter(
                  (nav) => nav.group === group.id && matchedSections.includes(nav.id),
                );
                if (items.length === 0) return null;
                return (
                <div key={group.id} className="min-w-0">
                  <p id={`settings-group-${group.id}`} className="mb-1.5 px-2.5 text-micro font-medium text-l3">
                    {group.label}
                  </p>
                  <ul aria-labelledby={`settings-group-${group.id}`} className="flex flex-wrap gap-1 @min-[48rem]:flex-col">
                    {items.map(({ id, label, icon: Icon }) => (
                      <li key={id} className="min-w-0">
                        <button
                          id={`settings-nav-${id}`}
                          type="button"
                          aria-current={activeSection === id ? "page" : undefined}
                          aria-controls="settings-content"
                          onClick={() => setActiveSection(id)}
                          className={`flex min-h-8 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
                            activeSection === id
                              ? "bg-seg-sel font-medium text-l1"
                              : "text-l3 hover:bg-hover hover:text-l1"
                          }`}
                        >
                          {/* 图标随选中态变色（同侧栏）：扫一眼就能认出分区，不用逐字读 */}
                          <Icon
                            aria-hidden="true"
                            className={`h-3.5 w-3.5 shrink-0 ${activeSection === id ? "text-nav-accent" : "text-l4"}`}
                          />
                          {label}
                          {id === "update" && appUpdate && (
                            <span className="inline-flex shrink-0 items-center gap-1 text-micro text-ok-text">
                              <span aria-hidden="true" className="size-2 rounded-full bg-ok-text" />
                              可更新
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
                );
              })}
            </div>
            {sectionQuery.trim() && matchedSections.length === 0 && (
              // 空结果要说一句：没这句，用户只看到左栏空了，会以为设置页坏了
              <p role="status" className="px-2.5 text-xs text-l4">
                没有匹配的设置
              </p>
            )}
          </nav>
          <div
            ref={contentRef}
            id="settings-content"
            role="region"
            aria-labelledby={`settings-nav-${activeSection}`}
            className="@container/settings min-w-0 scroll-mt-16"
          >
            {banners}

      <Section id="appearance" active={activeSection}>
        {/* 主题卡（2026-10-17 细化）：内置十四套七列深浅成对 →「我的配色」同一网格（另存色卡 +
            自定义入口）→ 选中自定义或某张色卡时才展开调色条。取色块改成输入框形态，
            不再与主题小窗同形，免得被看成又一排主题；没在用自定义时不占版面。 */}
        <div className="mb-3 ccode-well ccode-card p-4">
          <div className="mb-2 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-l2">主题</div>
              <p className="mt-0.5 text-micro leading-4 text-l4">
                {followSystem
                  ? isCustomThemeId(settings?.theme)
                    ? "自定义配色没有成对的另一套，不随系统切换；选内置主题后才跟随"
                    : "点任一张只选配色，深浅随系统切换"
                  : "上排深色，下排同名浅色"}
              </p>
            </div>
            <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-l3">
              跟随系统深浅
              <Toggle
                label="主题跟随系统深浅"
                checked={followSystem}
                onChange={(v) => void patch({ themeFollowSystem: v })}
              />
            </label>
          </div>
          <div className="grid grid-cols-[repeat(7,minmax(4.5rem,1fr))] gap-2 overflow-x-auto">
            {themeSwatches.map((t) => (
              <ThemeTile
                key={t.id}
                name={t.name}
                rail={t.rail}
                canvas={t.canvas}
                accent={t.accent}
                ink={t.ink}
                selected={settings?.theme === t.id}
                title={`切换到${t.name}`}
                onClick={() => {
                  setCustomDraft(null);
                  const id = followSystem ? followedTheme(t.id, systemIsDark()) : t.id;
                  void patch({ theme: id, customThemeCardId: "" });
                }}
              />
            ))}
          </div>

          <div className="mb-1.5 mt-4 text-micro font-medium text-l3">我的配色</div>
          <div className="grid grid-cols-[repeat(7,minmax(4.5rem,1fr))] gap-2 overflow-x-auto">
            {customCards.map((card) => {
              const derived = deriveThemeTokens(card);
              return (
                <div key={card.id} className="group relative min-w-0">
                  <ThemeTile
                    name={card.name}
                    rail={derived.tokens.rail}
                    canvas={derived.tokens.canvas}
                    accent={derived.tokens.cta}
                    ink={derived.tokens.l1}
                    selected={selectedCardId === card.id}
                    title={`${card.name}（双击改名）`}
                    onClick={() => {
                      if (renamingId === card.id) return;
                      applySavedCard(card);
                    }}
                    onDoubleClick={() => {
                      setRenamingId(card.id);
                      setRenameDraft(card.name);
                    }}
                    nameSlot={
                      renamingId === card.id ? (
                        <input
                          className="w-full border-0 bg-transparent p-0 text-micro font-medium outline-none"
                          style={{ color: derived.tokens.l1 }}
                          value={renameDraft}
                          autoFocus
                          maxLength={12}
                          aria-label="色卡名称"
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onBlur={() => commitRename(card)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") e.currentTarget.blur();
                            if (e.key === "Escape") setRenamingId(null);
                          }}
                        />
                      ) : undefined
                    }
                  />
                  <button
                    type="button"
                    title="删除"
                    aria-label={`删除色卡「${card.name}」`}
                    className={`${hoverRevealClass} ${ghostActionClass} absolute right-0.5 top-0.5 z-10 h-6 w-6 text-l3 hover:text-l1`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteSavedCard(card);
                    }}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
            {customSelected ? (
              <ThemeTile
                name="自定义 · 未存"
                rail={customDerived.tokens.rail}
                canvas={customDerived.tokens.canvas}
                accent={customDerived.tokens.cta}
                ink={customDerived.tokens.l1}
                selected
                title="当前的自定义配色（还没另存成色卡）"
                onClick={() => {}}
              />
            ) : (
              <button
                type="button"
                onClick={activateCustom}
                title="从当前主题的三个颜色出发，配一套自己的主题"
                className="flex h-14 min-w-0 items-center justify-center rounded-md border border-dashed border-field text-micro text-l3 hover:border-l4 hover:text-l1"
              >
                ＋ 自定义
              </button>
            )}
          </div>

          {(customSelected || selectedCardId) && (
            <div className="mt-3">
              <p className="mb-1.5 text-micro leading-4 text-l4">
                {selectedCardId
                  ? "调色：改动后变成未存的自定义，满意了再另存为色卡"
                  : "调色：点色块用系统取色器，立即生效"}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <ColorChip
                  label="左栏"
                  value={customSeeds.rail}
                  onLive={(hex) => liveCustom({ ...customSeeds, rail: hex })}
                />
                <ColorChip
                  label="画布"
                  value={customSeeds.canvas}
                  onLive={(hex) => liveCustom({ ...customSeeds, canvas: hex })}
                />
                <ColorChip
                  label="强调"
                  value={customSeeds.accent}
                  onLive={(hex) => liveCustom({ ...customSeeds, accent: hex })}
                />
                {savingCard ? (
                  <span className="flex items-center gap-1.5">
                    <input
                      className={`${fieldFixed} w-28`}
                      value={cardNameDraft}
                      autoFocus
                      maxLength={12}
                      aria-label="新色卡名称"
                      onChange={(e) => setCardNameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") confirmSaveCard();
                        if (e.key === "Escape") setSavingCard(false);
                      }}
                    />
                    <button type="button" className={rowActionClass} onClick={confirmSaveCard}>
                      保存
                    </button>
                    <button
                      type="button"
                      className={ghostActionClass}
                      onClick={() => setSavingCard(false)}
                    >
                      取消
                    </button>
                  </span>
                ) : (
                  customSelected && (
                    <button
                      type="button"
                      className={`${rowActionClass} shrink-0 disabled:opacity-40`}
                      disabled={customCards.length >= CUSTOM_THEME_CARDS_MAX}
                      title={
                        customCards.length >= CUSTOM_THEME_CARDS_MAX
                          ? `最多 ${CUSTOM_THEME_CARDS_MAX} 套`
                          : "把当前三个颜色存成一张可点的色卡"
                      }
                      onClick={startSaveCard}
                    >
                      另存为色卡
                    </button>
                  )
                )}
              </div>
              {pickerDerived.warnings.length > 0 && customSelected && (
                <p className="mt-1.5 text-micro text-l4">
                  {pickerDerived.warnings.join("；")}
                </p>
              )}
            </div>
          )}
        </div>

        <Row
          label="侧栏 / 顶栏透明度"
          hint="百分数是罩色浓度，立即生效；壁纸越花越往「原样」调"
          labelTitle="原样（100%）是各主题本来的样子，越小越透出桌面磨砂，全透（0%）完全不铺罩色、文字直接压在壁纸上。侧栏选中行的底色也跟着一起变淡，最透时选中只剩文字和图标变色。深浅主题与图标态各有自己的底色，同一个百分数看起来的浓淡会不同"
        >
          <SegTabs
            items={CHROME_OPACITIES.map((pct) => ({
              id: String(pct),
              label: (
                <span title={chromeOpacityLabel(pct)}>
                  {pct === 0 || pct === 100
                    ? chromeOpacityShortLabel(pct)
                    : `${chromeOpacityShortLabel(pct)}%`}
                </span>
              ),
            }))}
            value={String(normalizeChromeOpacity(settings?.chromeOpacity))}
            onChange={(id) => void patch({ chromeOpacity: Number(id) })}
            className="flex-wrap"
          />
        </Row>

        <Row
          label="聊天字号"
          hint="立即生效；标准 = 原有大小"
          labelTitle="管聊天层和对话回放里的正文（你的提问与 AI 回复）。标题、行内代码跟着按比例变；终端字号在「终端」里单独调"
        >
          <SegTabs
            items={CHAT_FONT_SIZES.map((id) => ({
              id,
              label: CHAT_FONT_SIZE_LABEL[id],
            }))}
            value={normalizeChatFontSize(settings?.chatFontSize)}
            onChange={(id) => void patch({ chatFontSize: id as ChatFontSize })}
          />
        </Row>

        <Row
          label="聊天字体"
          hint="系统 = 跟随界面字体"
          labelTitle="衬线用宋体系（macOS 宋体-简、Windows 宋体 / 思源宋体），适合长文阅读；等宽用 JetBrains Mono，中文回退系统字体。代码块一直是等宽，不受影响"
        >
          <SegTabs
            items={CHAT_FONT_FAMILIES.map((id) => ({
              id,
              label: CHAT_FONT_FAMILY_LABEL[id],
            }))}
            value={normalizeChatFontFamily(settings?.chatFontFamily)}
            onChange={(id) =>
              void patch({ chatFontFamily: id as ChatFontFamily })
            }
          />
        </Row>

        <Row
          label="行内代码颜色"
          hint="文件名、命令、变量名这类反引号包着的字"
          labelTitle="给对话里的行内代码一个淡强调色（字色加同色薄底），和正文、链接一眼分开；深浅主题各有一套保证看得清。关闭 = 灰白。代码块不受影响"
        >
          <SegTabs
            items={CHAT_ACCENTS.map((id) => ({
              id,
              label: CHAT_ACCENT_LABEL[id],
            }))}
            value={normalizeChatAccent(settings?.chatAccent)}
            onChange={(id) => void patch({ chatAccent: id as ChatAccent })}
          />
        </Row>

        <Row
          label="聊天滚动条"
          hint="闲置淡出：鼠标进入或滚动时才显现"
          labelTitle="两种都比以前更宽、更好抓，悬停到滚动条上还会再粗一点。选「常显」则一直显示"
        >
          <SegTabs
            items={CHAT_SCROLLBARS.map((id) => ({
              id,
              label: CHAT_SCROLLBAR_LABEL[id],
            }))}
            value={normalizeChatScrollbar(settings?.chatScrollbar)}
            onChange={(id) =>
              void patch({ chatScrollbar: id as ChatScrollbar })
            }
          />
        </Row>

        <Row label="聊天预览" align="start" hint="上面四项改了这里当场变">
          <div className="md-body md-chat max-w-md rounded-md border border-hairline bg-inset px-3 py-2">
            <p>
              已把结果写进 <code>notes/clips.md</code>，可以用 <code>npm test</code>{" "}
              复查，详见 <a href="#chat-preview" onClick={(e) => e.preventDefault()}>这份说明</a>。
            </p>
            <p>
              Hello, <strong>Mesa</strong> 的对话正文会随字号与字体一起变化。
            </p>
          </div>
        </Row>

        <Row
          label="应用图标"
          align="start"
          hint={
            IS_MAC
              ? "只换运行中的程序坞与托盘图标"
              : IS_WINDOWS
                ? "只换运行中的任务栏与托盘图标"
                : "只换运行中的窗口与托盘图标"
          }
          labelTitle="安装包里的图标由系统决定：macOS 26 及以上随系统外观设置切深浅，更早的 macOS 与 Windows / Linux 是深色。这里选深色或浅色，只改 Mesa 运行期间程序坞（Windows 为任务栏）和托盘里的那一份，Finder、启动台、开始菜单不受影响；「跟随系统」= 不干预"
        >
          <AppIconPicker
            value={settings?.appIconStyle ?? "system"}
            onChange={(style) => void setAppIcon(style)}
          />
        </Row>

        <Row
          label="底部状态栏"
          hint="关掉后终端和聊天都不显示"
        >
          <Toggle
            label="底部状态栏"
            checked={settings?.statusBar ?? true}
            onChange={(checked) => patch({ statusBar: checked })}
          />
        </Row>
      </Section>

      <Section id="terminal" active={activeSection}>
        <TerminalPreview
          family={fontFamily === "__custom__" ? customFont : fontFamily}
          fontSize={Number(fontSize) || settings?.terminalFontSize || 13}
          paletteId={resolvePaletteId(
            settings?.terminalPalette,
            isLightTheme(settings?.theme),
            settings?.theme,
          )}
        />
        <Row
          label="终端渲染"
          hint="重开终端生效。自动用显卡绘制，出字和滚动更顺、框线连贯，显卡用不了时自动改用兼容；兼容按网页排版绘制，画面显示不对时再选"
        >
          {/* 旧设置里存过的 "webgl" 与自动同义（terminal-renderer.ts），显示成自动 */}
          <select
            className={selectSm}
            value={settings?.terminalRenderer === "dom" ? "dom" : "auto"}
            onChange={(e) => patch({ terminalRenderer: e.target.value })}
          >
            <option value="auto">自动（WebGL）</option>
            <option value="dom">兼容（DOM）</option>
          </select>
        </Row>

        <TerminalShellRow
          value={settings?.terminalShell ?? "auto"}
          onChange={(next) => patch({ terminalShell: next })}
        />

        <Row label="终端字号" hint="立即生效（11–18）">
          <input
            type="number"
            min={11}
            max={18}
            className={`${fieldFixed} w-20`}
            value={fontSize}
            onChange={(e) => {
              draftDirty.current.add("fontSize");
              setFontSize(e.target.value);
            }}
            onBlur={() => {
              draftDirty.current.delete("fontSize");
              commitNumber(fontSize, 11, 18, (n) =>
                patch({ terminalFontSize: n }),
              );
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              draftDirty.current.delete("fontSize");
              commitNumber(fontSize, 11, 18, (n) =>
                patch({ terminalFontSize: n }),
              );
            }}
          />
        </Row>

        <Row
          label="终端字体"
          hint="立即生效；未安装可一键装"
          extra={
            fontInstallTarget &&
            fontInstallTarget === INSTALLABLE_FONTS[fontFamily] &&
            (fontInstalling || fontInstallResult) ? (
              <div className="mt-2">
                {fontInstalling && (
                  <pre
                    // callback ref：每次渲染都把滚动条钉在底部，跟随输出自动滚动
                    ref={(el) => {
                      if (el) el.scrollTop = el.scrollHeight;
                    }}
                    className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-inset p-2 font-mono text-xs text-l3"
                  >
                    {collapseCarriageReturns(fontInstallOutput) || "安装中，等待输出…"}
                  </pre>
                )}
                {!fontInstalling && fontInstallResult && (
                  <div className="rounded-sm ccode-well p-2 text-xs text-l2">
                    <span
                      className={
                        fontInstallResult.ok ? "text-ok-text" : "text-err-text"
                      }
                    >
                      {fontInstallResult.ok ? "✓ 安装完成" : "✗ 安装失败"}
                    </span>
                    {/* 后端只回传尾部 ~30 行，直接展示不折叠 */}
                    {fontInstallResult.output && (
                      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-l3">
                        {fontInstallResult.output}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            ) : undefined
          }
        >
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <select
              className={selectLg}
              value={fontFamily}
              onChange={(e) => {
                setFontFamily(e.target.value);
                if (e.target.value !== "__custom__") {
                  draftDirty.current.delete("customFont");
                  patch({ terminalFontFamily: e.target.value });
                } else {
                  // 选中「自定义」但未提交字体名，同属未提交草稿
                  draftDirty.current.add("customFont");
                }
              }}
            >
              {/* 选项来自 src/terminal-font.ts 单一出处（加字体只改那一处） */}
              {TERMINAL_FONT_CHOICES.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
              <option value="__custom__">自定义…</option>
            </select>
            {fontFamily === "__custom__" && (
              <input
                className={`${fieldFixed} w-40`}
                placeholder="字体名，如 Fira Code"
                value={customFont}
                onChange={(e) => {
                  draftDirty.current.add("customFont");
                  setCustomFont(e.target.value);
                }}
                onBlur={() => {
                  if (customFont.trim()) {
                    draftDirty.current.delete("customFont");
                    patch({ terminalFontFamily: customFont.trim() });
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && customFont.trim()) {
                    draftDirty.current.delete("customFont");
                    patch({ terminalFontFamily: customFont.trim() });
                  }
                }}
              />
            )}
            {/* 选中可安装预设且检测未安装时显示一键安装（已装/内置/系统/自定义不显示）。
                字体安装只走 Homebrew，Windows 上点了必然失败，不显示 */}
            {!IS_WINDOWS &&
              INSTALLABLE_FONTS[fontFamily] &&
              fontStatus[INSTALLABLE_FONTS[fontFamily]] === false && (
                <button
                  onClick={() => installFont(INSTALLABLE_FONTS[fontFamily])}
                  disabled={fontInstalling}
                  title="通过 Homebrew 安装该字体"
                  className={`${compactPrimaryActionClass} shrink-0`}
                >
                  {fontInstalling &&
                  fontInstallTarget === INSTALLABLE_FONTS[fontFamily]
                    ? "安装中…"
                    : "安装"}
                </button>
              )}
          </div>
        </Row>

        {/* 只列出与当前主题亮暗匹配的四套：浅色主题配深色向 ANSI 会让 white/brightWhite
            在近白底上隐形，不给用户配出不可读组合的机会。存的值不符时按 twin 现算生效值。
            每套标名字（原先只有色条、名字藏在悬浮里）；「已自动换成配对的那套」并进说明，
            不再在浅色主题下常驻一行提示 */}
        {(() => {
          const themeIsLight = isLightTheme(settings?.theme);
          const stored = settings?.terminalPalette;
          const auto = !stored || stored === AUTO_PALETTE;
          const effective = resolvePaletteId(stored, themeIsLight, settings?.theme);
          const options = [
            { id: AUTO_PALETTE, name: "跟随主题" },
            ...PALETTE_LIST.filter((p) => p.light === themeIsLight),
          ];
          const effectiveName = PALETTE_LIST.find((p) => p.id === effective)?.name ?? effective;
          return (
            <Row
              label="终端调色板"
              align="start"
              hint={
                auto
                  ? `立即生效；跟随主题时用 ${effectiveName}，换主题自动换配套的那套`
                  : stored !== effective
                    ? `立即生效；当前主题是${themeIsLight ? "浅色" : "深色"}，你选的那套已换成配对的${themeIsLight ? "浅色" : "深色"}版`
                    : `立即生效；只列与${themeIsLight ? "浅色" : "深色"}主题相配的四套`
              }
            >
              <div role="radiogroup" aria-label="终端调色板" className="flex flex-wrap gap-2">
                {options.map((pl) => {
                  const selected = pl.id === AUTO_PALETTE ? auto : !auto && effective === pl.id;
                  return (
                    <button
                      key={pl.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => patch({ terminalPalette: pl.id })}
                      className={`flex flex-col items-start gap-1 rounded-md border px-1.5 pb-1 pt-1.5 text-micro ${
                        selected
                          ? "border-cta-bd text-l1"
                          : "border-field text-l3 hover:text-l1"
                      }`}
                    >
                      {/* 8 色无缝色条：分段 flex-1 自适应固定宽度，色数变化也不撑破布局 */}
                      <span className="flex h-3 w-20 overflow-hidden rounded-sm">
                        {paletteDots(
                          pl.id === AUTO_PALETTE ? themeDefaultPalette(settings?.theme, themeIsLight) : pl.id,
                        ).map((d) => (
                          <span key={d} className="flex-1" style={{ background: d }} />
                        ))}
                      </span>
                      {pl.name}
                    </button>
                  );
                })}
              </div>
            </Row>
          );
        })()}

        <Row label="滚动缓冲行数" hint="新开标签生效（1000–20000）">
          <input
            type="number"
            min={1000}
            max={20000}
            step={1000}
            className={`${fieldFixed} w-24`}
            value={scrollback}
            onChange={(e) => {
              draftDirty.current.add("scrollback");
              setScrollback(e.target.value);
            }}
            onBlur={() => {
              draftDirty.current.delete("scrollback");
              commitNumber(scrollback, 1000, 20000, (n) =>
                patch({ scrollback: n }),
              );
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              draftDirty.current.delete("scrollback");
              commitNumber(scrollback, 1000, 20000, (n) =>
                patch({ scrollback: n }),
              );
            }}
          />
        </Row>

        {/* ConPTY 专属问题，非 Windows 平台 xterm.js 会如实应答 OSC 查询，不给这一行 */}
        {IS_WINDOWS && (
          <Row
            label="向 agent 告知终端底色"
            hint="浅色主题下告诉 gemini / qwen 底色，新开标签生效"
          >
            <Toggle
              label="向 agent 告知终端底色"
              checked={settings?.terminalColorReport ?? true}
              onChange={(checked) => patch({ terminalColorReport: checked })}
            />
          </Row>
        )}

        <SubHeading title="外部终端与运行时" />
        <Row
          label="外部终端"
          hint="对话页「在外部终端恢复」、连接页外部启动用哪个终端；立即生效"
          labelTitle="对话页「⇗ 外部恢复」使用的终端应用，立即生效。Windows 可在命令提示符和 PowerShell 之间切换：cmd 不经过 PowerShell，通常更快"
        >
          <select
            className={selectLg}
            value={externalTerminalSelectValue(settings?.externalTerminal)}
            onChange={(e) => patch({ externalTerminal: e.target.value })}
          >
            {EXTERNAL_TERMINALS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </Row>

        <CustomRuntimeBlock onError={setError} onNotice={setNotice} />
      </Section>

      <Section id="startup" active={activeSection}>
        <Row label="启动时进入" hint="下次启动生效">
          <select
            className={selectSm}
            value={settings?.startPage ?? "workbench"}
            onChange={(e) => patch({ startPage: e.target.value })}
          >
            {PAGE_HOTKEY_DEFS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Row>
        <Row
          label="默认导航形态"
          hint="下次启动生效；运行中可临时切换"
        >
          <select
            className={selectMd}
            value={resolveStartupNavMode(
              settings?.startupNavMode,
              localStorage.getItem("ccode.navCollapsed") === "1",
            )}
            onChange={(e) =>
              void patch({
                startupNavMode: e.target.value as
                  | "expanded"
                  | "collapsed"
                  | "hidden",
              })
            }
          >
            <option value="expanded">展开侧栏</option>
            <option value="collapsed">图标侧栏</option>
            <option value="hidden">完全隐藏 + 顶部灵动岛</option>
          </select>
        </Row>

        <Row
          label="系统通知"
          hint="Mesa 在后台、Agent 停下等你确认时弹系统通知"
          labelTitle="窗口在后台、待你确认时通知，30 秒内不重复"
        >
          <Toggle
            label="系统通知"
            checked={settings?.notificationsEnabled ?? true}
            onChange={(checked) => patch({ notificationsEnabled: checked })}
          />
        </Row>

        <SubHeading
          title="顶部灵动岛"
          hint={
            (settings?.hotkeyHideChrome ?? "mod+\\")
              ? `侧栏隐藏时顶部出现的导航岛：默认导航形态选「完全隐藏」，或运行中按 ${comboLabel(settings?.hotkeyHideChrome ?? "mod+\\")} 临时隐藏`
              : "侧栏隐藏时顶部出现的导航岛：默认导航形态选「完全隐藏」，或从命令面板临时隐藏侧栏"
          }
        />
        <Row
          label="自动收起"
          hint="鼠标移开后多久收起展开的岛"
          labelTitle="完全隐藏时，岛始终停在顶部，只留「恢复侧栏」；鼠标移入或键盘聚焦展开完整导航，移开后按此延时收起。选「立即」适合只借岛点一下就走，不留停在半开的岛"
        >
          <select
            className={selectSm}
            value={normalizeNavCapsuleDelay(settings?.navCapsuleHideDelayMs)}
            onChange={(e) =>
              void patch({ navCapsuleHideDelayMs: Number(e.target.value) })
            }
          >
            <option value={0}>立即</option>
            <option value={500}>0.5 秒</option>
            <option value={1000}>1 秒</option>
            <option value={2000}>2 秒</option>
            <option value={5000}>5 秒</option>
          </select>
        </Row>
        <Row
          label="跑完播报"
          hint="Agent 跑完或断开时在岛上报一句，4 秒消失"
          labelTitle="Agent 跑完一个回合或进程断开时，在休眠态那一行报一句，4 秒后自己消失。只报这两种「刚发生的事」——等待确认、冲突等待处理属于收件箱，岛不重复持有它们的计数"
        >
          <Toggle
            label="顶部岛跑完播报"
            checked={settings?.navCapsuleRunAnnounce !== false}
            onChange={(v) => void patch({ navCapsuleRunAnnounce: v })}
          />
        </Row>
        <Row
          label="展开内容"
          hint="岛展开后的导航显示符号、文字还是两者；立即生效"
        >
          <select
            className={selectSm}
            value={normalizeNavCapsuleDisplayMode(settings?.navCapsuleDisplayMode)}
            onChange={(e) =>
              void patch({
                navCapsuleDisplayMode: e.target.value as
                  | "both"
                  | "icons"
                  | "labels",
              })
            }
          >
            <option value="both">符号 + 文字</option>
            <option value="icons">仅显示符号</option>
            <option value="labels">仅显示文字</option>
          </select>
        </Row>
        <Card
          title="岛上显示的入口"
          hint="「恢复侧栏」始终保留；隐藏了当前所在页面时会临时保留它的入口"
          action={
            <button
              type="button"
              className={`${ghostActionClass} shrink-0 text-xs`}
              onClick={() => void patch({ navCapsuleVisibleItems: [...NAV_CAPSULE_ITEM_IDS] })}
            >
              全部显示
            </button>
          }
        >
          {/* 密集短项固定五列对齐（design-system）：max-content 轨在整宽卡里右侧留死空间，
              等宽 1fr 轨填满卡宽（2026-10-03 用户反馈「右边空一块」） */}
          <div className="grid grid-cols-[repeat(5,minmax(0,1fr))] gap-2">
            {NAV_CAPSULE_SETTING_ITEMS.map((item) => {
              const selected = normalizeNavCapsuleVisibleItems(
                settings?.navCapsuleVisibleItems,
              ).includes(item.id);
              return (
                <Checkbox
                  key={item.id}
                  className={`h-8 rounded-md px-2 text-xs hover:bg-hover ${
                    selected ? "text-l1" : "text-l3"
                  }`}
                  checked={selected}
                  label={item.label}
                  onChange={(checked) => {
                    const current = normalizeNavCapsuleVisibleItems(
                      settings?.navCapsuleVisibleItems,
                    );
                    const next = checked
                      ? [...new Set([...current, item.id])]
                      : current.filter((id) => id !== item.id);
                    void patch({ navCapsuleVisibleItems: next });
                  }}
                />
              );
            })}
          </div>
        </Card>
      </Section>

      {/* 快捷键：点击绑定钮进入录制态，按下新组合即保存；空串 = 禁用 */}
      <Section
        id="hotkeys"
        active={activeSection}
      >
        {/* 全部在用的绑定（命令面板/侧栏/九页切）在 HotkeysSection 内互判冲突 */}
        <HotkeysSection settings={settings} patch={patch} />
      </Section>

      <Section
        id="stats"
        active={activeSection}
      >
        <Row label="汇率（USD→CNY）" hint="用量页下次查询生效">
          <input
            type="number"
            step={0.01}
            min={0}
            className={`${fieldFixed} w-24`}
            value={rate}
            onChange={(e) => {
              draftDirty.current.add("rate");
              setRate(e.target.value);
            }}
            onBlur={() => {
              draftDirty.current.delete("rate");
              commitNumber(rate, 0, 100, (n) => patch({ rateUsdCny: n }));
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              draftDirty.current.delete("rate");
              commitNumber(rate, 0, 100, (n) => patch({ rateUsdCny: n }));
            }}
          />
        </Row>

        {/* 自定义定价：表格编辑（每行 = 模型前缀 + 输入/输出价），保存时序列化为 pricing.json */}
        <Card
          title="自定义定价"
          hint="按模型名前缀匹配，覆盖内置价目；单位：美元 / 每百万 token"
          action={
            // 没改动时不放钮：一颗灰着的「已保存」看着像坏了（2026-10-17）
            (pricingDirty || savingPricing) && (
              <button
                onClick={savePricing}
                disabled={savingPricing}
                className={rowActionClass}
              >
                {savingPricing ? "保存中…" : "保存"}
              </button>
            )
          }
        >
          {pricingRows.length === 0 && (
            // 空态说一句为什么是空的：内置价目已覆盖常见模型，这里只放例外
            <p className="px-1 py-1 text-xs text-l4">
              还没有自定义价目。常见模型已有内置价，只有用量页算不出价或价格不对时才需要加
            </p>
          )}
          {pricingRows.length > 0 && (
            <div className="mb-1 grid grid-cols-[minmax(140px,1fr)_7rem_7rem_28px] items-center gap-2 px-1 text-xs text-l4">
              <span>模型前缀</span>
              <span>输入价</span>
              <span>输出价</span>
              <span />
            </div>
          )}
          <div className="space-y-1">
            {pricingRows.map((row, i) => (
              <div
                key={i}
                className="grid grid-cols-[minmax(140px,1fr)_7rem_7rem_28px] items-center gap-2"
              >
                <input
                  className={fieldClass}
                  placeholder="如 kimi-k3"
                  value={row.prefix}
                  onChange={(e) => {
                    const next = [...pricingRows];
                    next[i] = { ...row, prefix: e.target.value };
                    setPricingRows(next);
                    markPricingDirty(true);
                  }}
                />
                <input
                  className={fieldClass}
                  placeholder="2.5"
                  inputMode="decimal"
                  value={row.input}
                  onChange={(e) => {
                    const next = [...pricingRows];
                    next[i] = { ...row, input: e.target.value };
                    setPricingRows(next);
                    markPricingDirty(true);
                  }}
                />
                <input
                  className={fieldClass}
                  placeholder="10"
                  inputMode="decimal"
                  value={row.output}
                  onChange={(e) => {
                    const next = [...pricingRows];
                    next[i] = { ...row, output: e.target.value };
                    setPricingRows(next);
                    markPricingDirty(true);
                  }}
                />
                <button
                  type="button"
                  aria-label={`删除 ${row.prefix || "该行"}`}
                  className="flex h-7 w-7 items-center justify-center rounded-sm text-xs text-l4 hover:bg-hover hover:text-err-text"
                  onClick={() => {
                    setPricingRows(pricingRows.filter((_, j) => j !== i));
                    markPricingDirty(true);
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="mt-2 flex h-7 items-center rounded-sm px-2 text-xs text-l3 hover:bg-hover hover:text-l1"
            onClick={() => {
              setPricingRows([
                ...pricingRows,
                { prefix: "", input: "", output: "" },
              ]);
              markPricingDirty(true);
            }}
          >
            + 添加模型
          </button>
          {/* 待补清单：用量里出现过、三层价目都查不到的模型。原先只能对着用量页的「≥ / ~」猜是谁没价 */}
          {(() => {
            const listed = new Set(pricingRows.map((r) => r.prefix.trim().toLowerCase()));
            const pending = (unpriced ?? []).filter(
              (m) => !listed.has(m.model.toLowerCase()),
            );
            if (unpriced === null || pending.length === 0) return null;
            return (
              <div className="mt-3">
                <p className="mb-1 px-1 text-micro font-medium text-l3">
                  用量里查不到价格的模型
                  <span className="ml-1.5 font-normal text-l4">这些模型的花费没算进用量页</span>
                </p>
                <ul>
                  {pending.map((m) => (
                    <li
                      key={m.model}
                      className="flex items-center gap-3 rounded-md px-1 py-1 text-xs hover:bg-hover"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-l2">{m.model}</span>
                      <span className="shrink-0 text-l4">
                        {compactTokens(m.tokens)} token · 最近 {m.lastDay}
                      </span>
                      <button
                        type="button"
                        className={`${ghostActionClass} shrink-0`}
                        onClick={() => {
                          setPricingRows([
                            ...pricingRows,
                            { prefix: m.model, input: "", output: "" },
                          ]);
                          markPricingDirty(true);
                        }}
                      >
                        填价
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })()}
        </Card>
      </Section>

      <Section id="integration" active={activeSection}>
        {/* 两件事分两节（2026-10-17）：内置 AI 功能用哪份配置 / Mesa 对各家 Agent 加的约束。
            「会话自动命名」挪到配置卡后面，紧挨它用到的「会话摘要 / 起名」槽 */}
        <SubHeading title="内置 AI 功能" hint="Mesa 自己发起的 AI 调用：起提交说明、给对话起名、翻译等" />
        <Row
          label="AI 专用配置"
          hint="留空自动用最近使用的配置"
          labelTitle="同一配置的每个模型各占一条"
        >
          <select
            className={selectLg}
            value={selectedAiProfileChoice(
              settings?.aiProfileId,
              settings?.aiModel,
              profiles,
            )}
            onChange={(e) => patchAiProfile(e.target.value)}
          >
            <option value="">自动（最近使用）</option>
            {aiChoices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </Row>

        {/* 同权控件分级（跨页三原则 #1）：按功能的几条收进一张卡，不与上方默认行排成一堵墙 */}
        <Card title="按功能单独配置" hint="留空跟随上方「AI 专用配置」；某项想用更便宜或更强的模型时再单配">
          {AI_FN_GROUPS.map((group) => (
            <div key={group.title} className="mt-2 first:mt-0">
              <p className="mb-0.5 px-2 text-micro font-medium text-l4">{group.title}</p>
              <div className="grid grid-cols-1 gap-x-3 gap-y-0.5 xl:grid-cols-2">
                {group.rows.map((fn) => {
                  const value = selectedAiProfileChoice(
                    settings?.aiProfiles?.[fn.key],
                    settings?.aiProfileModels?.[fn.key],
                    profiles,
                  );
                  const chosen = aiChoices.find((c) => c.value === value);
                  return (
                    <CardRow key={fn.key} label={fn.label} hint={fn.hint}>
                      <select
                        className={`${fieldFixed} w-56 max-w-[45vw] shrink-0`}
                        title={chosen?.label ?? "跟随默认"}
                        value={value}
                        onChange={(e) => patchAiFnProfile(fn.key, e.target.value)}
                      >
                        <option value="">跟随默认</option>
                        {aiChoices.map((choice) => (
                          <option key={choice.value} value={choice.value}>
                            {choice.label}
                          </option>
                        ))}
                      </select>
                    </CardRow>
                  );
                })}
              </div>
            </div>
          ))}
        </Card>

        <Row
          label="会话自动命名"
          hint="Agent 聊完自动给对话起标题；关掉后不再起名"
          labelTitle="起名跟上方「AI 专用配置」走，「会话摘要 / 起名」行可单独换。聊完起名、打开对话页补名去重；关掉后已有标题与你手改的标题都不受影响"
        >
          <Toggle
            label="会话自动命名"
            checked={settings?.autoTitleSessions ?? true}
            onChange={(v) => patch({ autoTitleSessions: v })}
          />
        </Row>

        {IS_WINDOWS && (
          <Row
            label="定时任务里 Codex 用 Windows 沙箱"
            hint="不开时 Codex 在无人值守的定时任务里会拦下所有命令；开之前会先讲清楚它会做什么"
            labelTitle="只对 Mesa 的定时任务生效，不改 Codex 的配置文件；你在 Codex 里自己开过沙箱时直接用你的设置"
          >
            <Toggle
              label="定时任务里 Codex 用 Windows 沙箱"
              checked={settings?.codexWinSandboxConsent ?? false}
              onChange={(v) => {
                if (v) void enableCodexWinSandbox();
                else patch({ codexWinSandboxConsent: false });
              }}
            />
          </Row>
        )}

        <SubHeading title="对 Agent 的约束" hint="Mesa 拉起各家 CLI 时额外加的保护与标记" />
        <Row
          label="想法期只读保护"
          hint="聊想法时不让 agent 改文件（支持的 CLI 走进程级保护）"
        >
          {/* v3.66 当时定「设置页不加行」，前提是只有一个开关点；
              现在它影响多条讨论路径，用户在卡片区之外找不到它（v3.88 补） */}
          <Toggle
            checked={settings?.discussReadonly ?? true}
            onChange={(v) => patch({ discussReadonly: v })}
            label="想法期只读保护"
          />
        </Row>

        {hookSupportError && (
          <div className="mt-3 flex items-center gap-2 text-xs text-err-text">
            <span>{hookSupportError}</span>
            <button
              type="button"
              className={ghostActionClass}
              onClick={() => void loadHookSupport()}
            >
              重试
            </button>
          </div>
        )}
        {/* 卡头说一次机制，行标签只写 agent 名，写入路径挂行悬浮（v3.88：机制说明不占版面）。
            不支持的几家不再各占一行灰开关，并成卡底一句。
            2026-10-20 起五家在 Mesa 里启动时自动带上（docs/design-chat-structured-channels.md），不再给开关；
            只剩只认全局配置的三家（Gemini / Kimi / Grok）要开关 */}
        {hookSupport.length > 0 && (() => {
          const auto = hookSupport.filter((h) => h.auto);
          const supported = hookSupport.filter((h) => h.supported && !h.auto);
          const unsupported = hookSupport.filter((h) => !h.supported);
          const labelOf = (agent: string) => AGENTS.find((a) => a.id === agent)?.label ?? agent;
          return (
            <Card
              title="精确注意力标记"
              hint="由 CLI 自己报告进度、何时停下等你确认，比读终端画面准，审批卡上还能看到要运行的命令和要改的内容"
            >
              {auto.length > 0 && (
                <p className="mb-2 px-2 text-xs leading-5 text-l3">
                  {auto.map((h) => labelOf(h.agent)).join("、")}：在 Mesa 里启动时自动带上，不改你的配置。
                </p>
              )}
              {supported.length > 0 && (
                <p className="mb-1 px-2 text-micro text-l4">
                  下面几家只认全局配置里的 hooks，开了才有；开启会写入该 CLI 的 hooks 配置，写前自动备份
                </p>
              )}
              <div className="grid grid-cols-1 gap-1 lg:grid-cols-2">
                {supported.map((h) => {
                  const label = labelOf(h.agent);
                  return (
                    <CardRow
                      key={h.agent}
                      label={label}
                      hint={h.note ?? undefined}
                      title={h.configPath ? `写入 ${h.configPath}` : undefined}
                    >
                      <Toggle
                        label={`精确注意力标记（${label}）`}
                        checked={settings?.hooksAttention?.[h.agent] ?? false}
                        onChange={(checked) => void toggleHooks(h.agent, label, checked)}
                      />
                    </CardRow>
                  );
                })}
              </div>
              {unsupported.length > 0 && (
                <p className="mt-2 px-2 text-micro text-l4">
                  暂不支持：{unsupported.map((h) => labelOf(h.agent)).join("、")}
                </p>
              )}
            </Card>
          );
        })()}
      </Section>

      <Section id="network" active={activeSection}>
        <Row
          label="出网代理"
          align="start"
          hint="官方登录与更新下载用；空 = 不使用"
          labelTitle="用于官方账号登录与安装/更新下载（网关启动不走；国内镜像自动直连不绕代理）。空 = 不使用。「检测」探测本机代理（Clash / V2Ray 等），点候选即填。"
        >
          <div className="flex max-w-[34rem] flex-col gap-2">
            <div className="flex items-center gap-2">
              <input
                className={`${fieldFixed} min-w-0 flex-1 font-mono text-xs`}
                placeholder="http://127.0.0.1:7890"
                value={outboundProxy}
                onChange={(e) => {
                  draftDirty.current.add("outboundProxy");
                  setOutboundProxy(e.target.value);
                }}
                onBlur={() => {
                  draftDirty.current.delete("outboundProxy");
                  void patch({ outboundProxy: outboundProxy.trim() });
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  draftDirty.current.delete("outboundProxy");
                  void patch({ outboundProxy: outboundProxy.trim() });
                }}
              />
              <button
                type="button"
                onClick={() => void detectProxy()}
                disabled={proxyDetecting}
                className={`${secondaryActionClass} shrink-0`}
              >
                {proxyDetecting ? "检测中…" : "检测本机代理"}
              </button>
            </div>
            {proxyCandidates !== null &&
              (proxyCandidates.length === 0 ? (
                <p className="text-micro text-l4">
                  没检测到本机代理——确认代理软件（Clash / V2Ray 等）在运行，或手动填写
                </p>
              ) : (
                <ul className="space-y-0.5">
                  {proxyCandidates.map((c) => (
                    <li key={c.url}>
                      <button
                        type="button"
                        onClick={() => applyProxyCandidate(c.url)}
                        title="点选填入并保存"
                        className={`flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-micro hover:bg-hover ${
                          outboundProxy.trim() === c.url ? "text-l1" : "text-l3"
                        }`}
                      >
                        <span className="font-mono">{c.url}</span>
                        <span className="shrink-0 text-l4">{c.source}</span>
                        <span
                          className={`ml-auto shrink-0 ${c.alive ? "text-ok-text" : "text-l4"}`}
                        >
                          {c.alive ? "运行中" : "未探到监听"}
                        </span>
                        {outboundProxy.trim() === c.url && (
                          <span className="shrink-0 text-l4">· 当前</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              ))}
          </div>
        </Row>
        <Row
          label="不走代理的地址"
          hint="对应 NO_PROXY；留空默认本机地址"
          labelTitle="填了出网代理但此项留空时，默认 localhost,127.0.0.1,::1"
        >
          <input
            className={`${fieldFixed} w-72 font-mono text-xs`}
            placeholder="localhost,127.0.0.1,::1"
            value={outboundNoProxy}
            onChange={(e) => {
              draftDirty.current.add("outboundNoProxy");
              setOutboundNoProxy(e.target.value);
            }}
            onBlur={() => {
              draftDirty.current.delete("outboundNoProxy");
              void patch({ outboundNoProxy: outboundNoProxy.trim() });
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              draftDirty.current.delete("outboundNoProxy");
              void patch({ outboundNoProxy: outboundNoProxy.trim() });
            }}
          />
        </Row>
        {/* Homebrew 只在 macOS / Linux 上用；Windows 一键安装走 winget，这行对它没有意义 */}
        {!IS_WINDOWS && (
          <Row
            label="brew 镜像"
            hint="用 Homebrew 安装/更新时走国内镜像"
            labelTitle="元数据走 TUNA，包体走南大 ghcr 代理"
          >
            <Toggle
              label="brew 镜像"
              checked={settings?.brewMirror ?? false}
              onChange={(checked) => patch({ brewMirror: checked })}
            />
          </Row>
        )}

        <SubHeading title="文献全文" />
        <Row
          label="学校图书馆"
          align="start"
          hint="登录一次即可下载全文；不存账号密码"
          labelTitle="登录一次，之后待获取清单点「浏览器」下载，PDF 自动进项目。不存账号密码。"
        >
          <div className="flex max-w-[34rem] flex-col gap-2">
            <button
              type="button"
              onClick={() => void openInstLogin()}
              disabled={instBusy !== null}
              className={`${primaryActionClass} w-fit shrink-0`}
            >
              {instBusy === "login" ? "打开中…" : "登录学校账号"}
            </button>
            <SettingsFold
              label={
                !prefixOpen && instStatus?.prefixHost
                  ? `校外打不开全文时 · ${instStatus.prefixHost}`
                  : "校外打不开全文时"
              }
              open={prefixOpen}
              onToggle={() => setInstPrefixOpen(!prefixOpen)}
            >
              <p className="text-micro text-l4">
                贴图书馆「校外访问」链接，下载自动走学校代理
              </p>
              <input
                className={`${fieldFixed} w-full font-mono text-xs`}
                placeholder="https://proxy.xxx.edu.cn/login?url="
                value={institutionalPrefix}
                onChange={(e) => {
                  draftDirty.current.add("institutionalPrefix");
                  setInstitutionalPrefix(e.target.value);
                }}
                onBlur={() => {
                  draftDirty.current.delete("institutionalPrefix");
                  const v = institutionalPrefix.trim();
                  if (v && !/^https?:\/\//i.test(v)) return;
                  void patch({ institutionalPrefix: v });
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  draftDirty.current.delete("institutionalPrefix");
                  const v = institutionalPrefix.trim();
                  if (v && !/^https?:\/\//i.test(v)) return;
                  void patch({ institutionalPrefix: v });
                }}
              />
              {(prefixDraftInvalid || instStatus?.prefixInvalid) && (
                <p className="text-micro text-err-text">
                  前缀不是合法的 http(s) 地址——机构通道当前没有在使用它，请补全
                  scheme（如上例以 https:// 开头）
                </p>
              )}
            </SettingsFold>
            <SettingsFold
              label="其他方式"
              open={otherOpen}
              onToggle={() => setInstOtherOpen(!otherOpen)}
            >
              <p className="text-micro text-l4">
                登录入口（空 = CARSI 高校联盟）
              </p>
              <input
                className={`${fieldFixed} w-full font-mono text-xs`}
                placeholder={DEFAULT_INST_LOGIN_URL}
                value={institutionalLoginUrl}
                onChange={(e) => {
                  draftDirty.current.add("institutionalLoginUrl");
                  setInstitutionalLoginUrl(e.target.value);
                }}
                onBlur={() => {
                  draftDirty.current.delete("institutionalLoginUrl");
                  void patch({
                    institutionalLoginUrl: institutionalLoginUrl.trim(),
                  });
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  draftDirty.current.delete("institutionalLoginUrl");
                  void patch({
                    institutionalLoginUrl: institutionalLoginUrl.trim(),
                  });
                }}
              />
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <button
                  type="button"
                  onClick={() => void openInstLoginEmbedded()}
                  disabled={instBusy !== null}
                  className="text-micro text-l4 underline decoration-dotted underline-offset-2 hover:text-l2 disabled:opacity-50"
                  title="旧通道：内嵌登录窗，会话倒回 Mesa（无头阶梯/调试用，日常下载走浏览器）"
                >
                  内嵌窗登录
                </button>
                <button
                  type="button"
                  onClick={() => void captureInstSession()}
                  disabled={instBusy !== null}
                  className="text-micro text-l4 underline decoration-dotted underline-offset-2 hover:text-l2 disabled:opacity-50"
                  title="手动保存在内嵌窗里登录得到的会话（浏览器通道不需要这一步）"
                >
                  {instBusy === "capture" ? "保存中…" : "我已登录，保存会话"}
                </button>
                <button
                  type="button"
                  onClick={() => void installBrowserBridge()}
                  disabled={instBusy !== null}
                  className="text-micro text-l4 underline decoration-dotted underline-offset-2 hover:text-l2 disabled:opacity-50"
                  title="实验功能：安装后到 Chrome/Edge 扩展页（开发者模式）「加载已解压的扩展程序」，选安装结果里给出的扩展目录（已自动就位到本机配置目录），文献页即有「存到 Mesa」一键落 papers/。日常用「浏览器打开」自动收货即可，不必依赖此按钮"
                >
                  {instBusy === "bridge" ? "安装中…" : "安装浏览器桥"}
                </button>
              </div>
              <p className="flex flex-wrap items-center gap-x-2 text-micro text-l4">
                <span>
                  内嵌会话：{instSessionLabel(instStatus)}
                  {instStatus?.capturedFrom
                    ? ` · 入口 ${instStatus.capturedFrom}`
                    : ""}
                </span>
                {instStatus?.sessionPresent && (
                  <button
                    type="button"
                    onClick={() => void clearInstSession()}
                    disabled={instBusy !== null}
                    className="underline decoration-dotted underline-offset-2 hover:text-l2 disabled:opacity-50"
                  >
                    {instBusy === "clear" ? "清除中…" : "退出"}
                  </button>
                )}
              </p>
            </SettingsFold>
          </div>
        </Row>
      </Section>

      <Section
        id="update"
        active={activeSection}
        badge={
          appUpdate ? (
            <span className="ml-1 inline-flex items-center gap-1 rounded-sm bg-inset px-1.5 py-0.5 text-xs font-normal text-l3">
              <span className="size-2 rounded-full bg-ok-text" />
              v{appUpdate.version} 可更新
            </span>
          ) : undefined
        }
      >
        {appUpdate ? (
          <Card
            title={
              <>
                发现新版本 <span className="text-l1">v{appUpdate.version}</span>
              </>
            }
            hint={`当前 v${appUpdate.currentVersion} · 安装完成后会自动重启，进行中的对话请先保存`}
            action={
              <button
                onClick={() => {
                  setError(null);
                  void installUpdate();
                }}
                disabled={installing}
                className={`${primaryActionClass} shrink-0`}
              >
                {installing
                  ? appUpdateProgressLabel(
                      installProgress?.downloaded ?? 0,
                      installProgress?.total ?? null,
                    )
                  : "下载并安装"}
              </button>
            }
          >
            {installing && (
              <div className="mb-2 h-1 overflow-hidden rounded-full bg-inset">
                <div
                  className="h-full bg-ok-text transition-[width]"
                  style={{
                    width: `${appUpdateProgressPct(
                      installProgress?.downloaded ?? 0,
                      installProgress?.total ?? null,
                    ) ?? 15}%`,
                  }}
                />
              </div>
            )}
            {appUpdateError && (
              <InlineNotice tone="err" className="mb-2">{appUpdateError}</InlineNotice>
            )}
            {appUpdate.body?.trim() && <UpdateNotes text={appUpdate.body.trim()} />}
          </Card>
        ) : (
          <Row
            label="检查更新"
            hint={
              appUpdateStatus === "error"
                ? appUpdateError ?? appUpdateStatusHint("error")
                : appUpdateStatusHint(appUpdateStatus)
            }
          >
            {appUpdateStatus !== "dev" && (
              <button
                onClick={() => checkAppUpdate()}
                disabled={appUpdateStatus === "checking" || appUpdateStatus === "idle"}
                className={`shrink-0 ${rowActionClass}`}
              >
                {appUpdateStatus === "checking" || appUpdateStatus === "idle"
                  ? "检查中…"
                  : "重新检查"}
              </button>
            )}
          </Row>
        )}
      </Section>

      <Section
        id="diag"
        active={activeSection}
      >
        <Row
          label="诊断包"
          hint={
            IS_WINDOWS
              ? "系统 / WebView2 / 显卡 / 输入法与运行信息，已脱敏"
              : "系统与运行信息，已脱敏"
          }
          labelTitle="排障附件：导出后附到「反馈与提需求」里；不含环境变量"
        >
          <button
            onClick={exportDiagnosticsBundle}
            disabled={diagnosticsExporting}
            className={rowActionClass}
          >
            {diagnosticsExporting ? "正在采集…" : "导出诊断包"}
          </button>
        </Row>
        <Row
          label="生效配置快照"
          hint="当前生效值，排查配置漂移；已脱敏"
          labelTitle="应用设置、九家配置清单与能力表；不含密钥"
        >
          <button
            onClick={exportEffectiveConfig}
            disabled={configDumpExporting}
            className={rowActionClass}
          >
            {configDumpExporting ? "正在生成…" : "导出生效配置快照"}
          </button>
        </Row>
        <Row
          label="依赖体检"
          hint="Git / Node.js / Quarto / TeX / PDF 处理库"
          extra={
            depCheck ? (
              <div className="rounded-sm ccode-well p-2">
                <DepStatusLine
                  label="Git"
                  item={depCheck.git}
                  tool="git"
                  channel={depCheck.channel}
                  entry={depInstall.entries.git}
                  onInstall={(t) => void depInstall.install(t)}
                />
                <DepStatusLine
                  label="Node.js"
                  item={depCheck.node}
                  tool="node"
                  channel={depCheck.channel}
                  entry={depInstall.entries.node}
                  onInstall={(t) => void depInstall.install(t)}
                />
                <DepStatusLine
                  label="Quarto"
                  item={depCheck.quarto}
                  tool="quarto"
                  channel={depCheck.channel}
                  entry={depInstall.entries.quarto}
                  onInstall={(t) => void depInstall.install(t)}
                />
                <DepStatusLine
                  label="TeX"
                  item={depCheck.tex}
                  tool="tex"
                  channel={depCheck.channel}
                  entry={depInstall.entries.tex}
                  onInstall={(t) => void depInstall.install(t)}
                />
                <DepStatusLine
                  label="PyMuPDF"
                  purpose="（综述拼图：从 PDF 里裁图）"
                  busy={depInstall.entries.pymupdf.running || depInstall.entries.pillow.running}
                  item={depCheck.pymupdf}
                  tool="pymupdf"
                  channel={depCheck.channel}
                  entry={depInstall.entries.pymupdf}
                  onInstall={(t) => void depInstall.install(t)}
                />
                <DepStatusLine
                  label="Pillow"
                  purpose="（综述拼图：把图排成一版）"
                  busy={depInstall.entries.pymupdf.running || depInstall.entries.pillow.running}
                  item={depCheck.pillow}
                  tool="pillow"
                  channel={depCheck.channel}
                  entry={depInstall.entries.pillow}
                  onInstall={(t) => void depInstall.install(t)}
                />
                <div className="flex items-center gap-2 py-1 text-xs text-l4">
                  <span className="text-l2">安装渠道</span>
                  {depCheck.channel === "brew" && "Homebrew（可一键安装）"}
                  {depCheck.channel === "winget" && "winget（可一键安装）"}
                  {depCheck.channel === "xcode" &&
                    "无 Homebrew：Git 走系统安装窗口，其余用官网安装包（可一键安装）"}
                  {depCheck.channel === "none" &&
                    "无自动安装渠道（按指引手动安装）"}
                  <span className="ml-auto shrink-0">
                    上次检测 {depCheck.checkedAt}
                  </span>
                </div>
                {depCheckError && (
                  <InlineNotice tone="err" className="py-1">上次检测失败：{depCheckError}，可重试</InlineNotice>
                )}
              </div>
            ) : depCheckError ? (
              <p className="text-xs text-err-text">
                检测失败：{depCheckError}
              </p>
            ) : (
              <p className="text-xs text-l4">尚未检测</p>
            )
          }
        >
          <button
            onClick={() => void refreshDepCheck()}
            disabled={depCheckBusy}
            className={rowActionClass}
          >
            {depCheckBusy ? "检测中…" : "重新检测"}
          </button>
        </Row>
        <BackgroundTasksPanel />
        <Card
          title="应用日志"
          hint="最近 100 条；进程内缓冲，重启即清空"
          action={
            <>
              <button onClick={loadLogs} className="rounded-sm px-2 py-0.5 text-xs text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50">
                刷新
              </button>
              <button
                onClick={copyLogs}
                disabled={logs.length === 0}
                className="rounded-sm px-2 py-0.5 text-xs text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
              >
                复制全部
              </button>
              <button
                onClick={async () => {
                  setError(null);
                  try {
                    const path = await invoke<string>("export_app_log");
                    setNotice({ text: `已导出：${path}`, openPath: path });
                  } catch (e) {
                    setError(String(e));
                  }
                }}
                disabled={logs.length === 0}
                title="导出为 txt 到 ~/Downloads/ccode-exports/，反馈问题时发给开发者"
                className="rounded-sm px-2 py-0.5 text-xs text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
              >
                导出
              </button>
              <button
                onClick={clearLogs}
                disabled={logs.length === 0}
                className="rounded-sm px-2 py-0.5 text-xs text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
              >
                清空
              </button>
            </>
          }
        >
          {logs.length === 0 ? (
            <p className="px-1 text-xs text-l4">暂无日志</p>
          ) : (
            <div className="max-h-64 overflow-auto font-mono text-xs leading-5">
              {logs.map((l, i) => (
                <div key={i} className="break-all">
                  <span className="text-l4">
                    {logLocalTime(l.ts)}{" "}
                  </span>
                  <span
                    className={
                      l.level === "error"
                        ? "text-err-text"
                        : l.level === "warn"
                          ? "text-warn-text"
                          : "text-l3"
                    }
                  >
                    [{l.level}]
                  </span>{" "}
                  <span className="text-l3">{l.source}:</span>{" "}
                  <span className="text-l2">{l.message}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </Section>

      <Section
        id="storage"
        active={activeSection}
      >
        {/* 用户此前完全不知道 Mesa 在硬盘上占了多少、存在哪（v3.88 补）。
            2026-10-17：分「Mesa 数据 / 工作副本」两组、组头写一次根目录、行里只写相对名；
            卡头给总计；补列 ~/ccode 下的工作副本（往往才是大头）；快照可就地清理（移回收站）。
            旧说明「快照 / 备份 / 缓存可以直接删」不对：备份里有「恢复初始状态」要用的原样，
            模型目录被 Codex 全局配置引用着，逐项核过只剩快照能清 */}
        {(() => {
          const summary = storage ? summarizeStorage(storage, IS_WINDOWS, homeDir) : null;
          const segments = storage ? storageSegments(storage) : [];
          const customRoot = settings?.workspaceRoot?.trim();
          const rootShown = customRoot
            ? `${customRoot.replace(/[\\/]+$/, "")}${IS_WINDOWS ? "\\" : "/"}ccode`
            : "~/ccode";
          return (
            <>
              <SubHeading
                title="工作副本位置"
                hint="编程工作树、科研工作副本、定时隔离树都放在这里，用得越多占得越大；Windows 上默认在 C 盘，空间紧就换到别的盘。只管此后新建的，已有的留在原处照常用。"
              />
              <RowGroup>
                <Row label="存放位置" hint={customRoot ? rootShown : `${rootShown}（默认）`}>
                  {customRoot && (
                    <button
                      type="button"
                      className={ghostActionClass}
                      disabled={movingRoot}
                      onClick={() => void changeWorkspaceRoot(true)}
                    >
                      恢复默认
                    </button>
                  )}
                  <button
                    type="button"
                    className={ghostActionClass}
                    disabled={movingRoot}
                    onClick={() => void changeWorkspaceRoot(false)}
                  >
                    {movingRoot ? "处理中…" : "更改位置…"}
                  </button>
                </Row>
              </RowGroup>

              <SubHeading
                title="本机占用"
                hint="Mesa 在本机的目录与大小；配置、索引和备份别手动删"
              />
              <div className="mt-3 ccode-well ccode-card p-4">
                {storageError ? (
                  <p className="py-2 text-xs text-err-text">{storageError}</p>
                ) : summary === null ? (
                  <p className="py-2 text-xs text-l4">统计中…</p>
                ) : (
                  <>
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-l1">
                          Mesa 已占用 {summary.totalApprox ? "≥ " : ""}
                          {formatBytes(summary.total)}
                        </p>
                      </div>
                      <button
                        type="button"
                        className={`${ghostActionClass} shrink-0`}
                        onClick={() => {
                          setStorage(null);
                          setStorageError(null);
                          void loadStorage();
                        }}
                      >
                        重新统计
                      </button>
                    </div>
                    {segments.length > 0 && (
                      <>
                        <div
                          role="img"
                          aria-label={`占用分布：${segments.map((g) => `${g.label} ${formatBytes(g.bytes)}`).join("，")}`}
                          className="mt-3 flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-inset"
                        >
                          {segments.map((g) => (
                            <span
                              key={g.key}
                              style={{ width: `${Math.max(g.pct, 0.6)}%`, background: STORAGE_TONES[g.tone] ?? STORAGE_TONES[STORAGE_TONES.length - 1] }}
                            />
                          ))}
                        </div>
                        <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
                          {segments.map((g) => (
                            <li key={g.key} className="min-w-0">
                              <p className="flex items-center gap-1.5 text-xs text-l2">
                                <span
                                  aria-hidden="true"
                                  className="size-2 shrink-0 rounded-full"
                                  style={{ background: STORAGE_TONES[g.tone] ?? STORAGE_TONES[STORAGE_TONES.length - 1] }}
                                />
                                {g.label}
                              </p>
                              <p className="mt-0.5 pl-3.5 font-mono text-micro text-l3">{formatBytes(g.bytes)}</p>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    {summary.groups.map((group) => (
                      <div key={group.key} className="mt-4">
                        <p className="flex items-baseline gap-2 pb-1 text-micro">
                          <span className="font-medium text-l2">{group.title}</span>
                          <span className="min-w-0 truncate font-mono text-l4" title={group.rootPath}>
                            {group.rootLabel}
                          </span>
                        </p>
                        <ul className="divide-y divide-hairline border-t border-hairline">
                          {group.rows.map((e) => (
                            <li key={e.path} className="group flex items-center gap-2 py-2">
                              <span className="min-w-0 flex-1 truncate text-sm text-l1" title={e.path}>
                                {e.label}
                                <span className="ml-2 font-mono text-micro text-l4">{e.rel}</span>
                              </span>
                              <span className="w-16 shrink-0 text-right font-mono text-xs text-l3">
                                {e.exists ? `${e.approx ? "≥ " : ""}${formatBytes(e.bytes)}` : "—"}
                              </span>
                              {/* 行级低频动作：hover 才现。「清理」每行都占位（不可清理时 invisible）：
                                  只在快照行渲染会把那一行的大小挤到左边，整列对不齐（2026-10-17 截图实证） */}
                              <button
                                type="button"
                                tabIndex={e.clearable ? undefined : -1}
                                aria-hidden={e.clearable ? undefined : true}
                                disabled={!e.clearable || !e.exists || e.bytes === 0 || clearingStorage !== null}
                                onClick={() => void clearStorage(e)}
                                className={`${ghostActionClass} shrink-0 ${e.clearable ? hoverRevealClass : "invisible"}`}
                              >
                                {clearingStorage === e.id ? "清理中…" : "清理"}
                              </button>
                              <button
                                type="button"
                                disabled={!e.exists}
                                onClick={() => void openStorageEntry(e.path)}
                                title="在系统文件管理器中定位"
                                className={`${ghostActionClass} ${hoverRevealClass} shrink-0`}
                              >
                                定位
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </>
                )}
              </div>
            </>
          );
        })()}
        <InternalSessionsCard
          autoClean={settings?.internalAutoClean ?? true}
          retentionDays={settings?.internalRetentionDays ?? 30}
          onPatch={(p) => patch(p)}
        />
        <SubHeading title="卸载" />
        <UninstallRow />
      </Section>

      <Section
        id="about"
        active={activeSection}
      >
        {/* 关于页二次收拢（2026-10-17 用户「看着有点乱」）：只回答两件事——我装的是什么（身份卡）、
            出了事找谁（反馈）。GitHub 主页与开源许可降为身份卡右侧两个轻链接；致谢与数据来源是
            「用了谁的东西」，与第三方许可同一类，并进许可浮层；隐私压成页脚一句，全文挂悬浮 */}
        <div className="mt-1 flex flex-wrap items-center gap-4 ccode-well ccode-card p-4">
          <img
            src={settings?.appIconStyle === "light" ? appIconLight : appIconDark}
            alt=""
            aria-hidden="true"
            className="h-14 w-14 shrink-0"
          />
          <div className="min-w-0 flex-1">
            <div
              className="text-base font-semibold text-l1"
              title="展示名 Mesa，内部身份 ccode（bundle ID com.ccode.dev，数据在 ~/ccode/）——报障找目录时对得上"
            >
              Mesa
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-l3">
              <span className="font-mono text-l2">{appVersion ? `v${appVersion}` : "…"}</span>
              {buildInfoSuffix(buildInfo) && <span>{buildInfoSuffix(buildInfo)}</span>}
            </div>
            <div className="mt-0.5 text-micro text-l4">
              © 2026 泽塔前沿科技（杭州）有限公司 · Apache-2.0
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1">
            {appUpdate && (
              <button
                type="button"
                className={`${rowActionClass} mr-1 shrink-0`}
                onClick={() => setActiveSection("update")}
              >
                v{appUpdate.version} 可更新 · 去安装
              </button>
            )}
            <button
              type="button"
              className={`${ghostActionClass} gap-1.5`}
              title="在浏览器打开 GitHub 仓库：源码与发布记录，顺手点个 Star"
              onClick={() =>
                void openUrl("https://github.com/hongtongzhou-design/ccode").catch(
                  () => toast("浏览器没打开，稍后再试", "warning"),
                )
              }
            >
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8"
                />
              </svg>
              GitHub
            </button>
            <button
              type="button"
              className={ghostActionClass}
              title="第三方组件与字体的许可、致谢、文献数据来源"
              onClick={() => void openNotices()}
            >
              开源许可与致谢
            </button>
          </div>
        </div>
        <Row
          label="反馈与提需求"
          hint="遇到问题或想要的功能，直接告诉开发者"
          labelTitle="别贴密钥或 token。诊断包已脱敏；自己复制的终端输出可能还带着密钥，发送前留意"
        >
          <button
            type="button"
            className={secondaryActionClass}
            onClick={() => setFeedbackOpen(true)}
          >
            打开反馈表单
          </button>
          <button
            type="button"
            className={secondaryActionClass}
            onClick={() =>
              void openUrl(
                "https://github.com/hongtongzhou-design/ccode/issues",
              ).catch(() => toast("浏览器没打开，稍后再试", "warning"))
            }
          >
            去 GitHub 提 Issue
          </button>
        </Row>
        <div className="space-y-1 pt-3 text-micro leading-4 text-l4">
          <p title="API 密钥只存本机（仅本人可读的文件）；各 CLI 的会话目录只读。会联网的只有：检查更新（向 Mesa 的更新源问版本：发布页或官方镜像）、文献同步 / 下载 / 远查（把 DOI 或刊名发给 JabRef、NLM、ShowJCR、Unpaywall、Crossref、OpenAlex；从 ISSN 下载期刊词缩写表）、你主动发送的反馈">
            隐私：密钥只存本机；除检查更新、文献检索和你发出的反馈外，不上传任何数据。
          </p>
          <p>
            Mesa 不是 Claude Code、Codex 等任何 CLI
            的官方产品，各家名称与商标归其所有者。
          </p>
        </div>
      </Section>
          </div>
        </div>
      </div>
      {noticesOpen && noticesText !== null && (
        <NoticesOverlay
          text={noticesText}
          onClose={() => setNoticesOpen(false)}
        />
      )}
      <FeedbackModal open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </PageFrame>
  );
}
