import BackgroundTasksPanel from "../components/BackgroundTasksPanel";
import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { searchSettings, type SettingSectionId } from "../settings-search.ts";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { exit, relaunch } from "@tauri-apps/plugin-process";
import { applyTheme, useAppStore } from "../store";
import type { AppSettings } from "../store";
import {
  compactPrimaryActionClass,
  fieldClass,
  ghostActionClass,
  hoverRevealClass,
  PageFrame,
  PageHeader,
  primaryActionClass,
  rowActionClass,
  Checkbox,
  FoldMark,
  Toggle,
  secondaryActionClass,
} from "../components/PageFrame";
import { captureDecision, comboLabel, IS_MAC, IS_WINDOWS, PAGE_HOTKEY_DEFS } from "../hotkeys";
import {
  canOneClickInstall,
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
import {
  TERMINAL_FONT_CHOICES,
  isKnownTerminalFont,
} from "../terminal-font";
import type { CustomRuntimeDto, StorageEntryDto } from "../types";
import { AGENTS } from "../types";
import { getVersion } from "@tauri-apps/api/app";
import { collectFrontendDiagnostics } from "../diagnostics";
import {
  appUpdateProgressLabel,
  appUpdateProgressPct,
  appUpdateStatusHint,
} from "../app-update";

/** 七套深色主题：色板双格预览（左=侧栏色，右=内容底色）+ 名称 */
import {
  XTERM_PALETTES,
  PALETTE_PREVIEW_KEYS,
  PALETTE_LIST,
  resolvePaletteId,
} from "../terminal-palettes";
import { THEMES, isCustomThemeId, isLightTheme } from "../themes";
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
import {
  addCustomThemeCard,
  chipInk,
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
  normalizeChromeOpacity,
} from "../chrome-opacity";
import { toast } from "../toast";

// 调色板清单单一出处在 ../terminal-palettes（PALETTE_LIST，含亮暗标记）

/** 色卡预览：取共享调色板表的前 8 个 ANSI 标准色（与终端实际生效色一致） */
function paletteDots(id: string): string[] {
  const p = XTERM_PALETTES[id] ?? XTERM_PALETTES["dark-plus"];
  return PALETTE_PREVIEW_KEYS.map((k) => p[k]);
}

// 主题清单单一出处在 ../themes（命令面板共用）



/** 整块点开系统取色器；名称和色值只展示，不在色块上改 */
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
  const ink = chipInk(hex);
  return (
    <label className="relative h-14 w-[6.5rem] shrink-0 cursor-pointer overflow-hidden rounded-md ring-1 ring-hairline hover:ring-field">
      <span className="pointer-events-none block h-full" style={{ background: hex }} />
      <span
        className="pointer-events-none absolute inset-x-0 bottom-0 px-1.5 py-1"
        style={{ color: ink }}
      >
        <span className="block text-micro font-medium">{label}</span>
        <span className="block font-mono text-micro leading-4">{hex}</span>
      </span>
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

// fieldClass 自带 w-full：本页 Row 右列是收缩到内容的 auto 列，定宽控件（w-20/w-24/w-40）
// 追加的宽度类在 Tailwind 排序中会被 w-full 覆盖，故用去掉 w-full 的本页变体保持原宽度
const fieldFixed = fieldClass.replace("w-full ", "");

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

/** 内置 AI 功能按功能独立配置的行（key 与后端 ai.rs FN_* 常量对应） */
const AI_FN_ROWS: { key: string; label: string }[] = [
  { key: "commit", label: "提交信息" },
  { key: "summarize", label: "会话摘要 / 起名" },
  { key: "pr", label: "PR 描述" },
  { key: "distill", label: "沉淀为技能" },
      { key: "skill-optimize", label: "优化合成技能" },
  { key: "digest", label: "提炼接力 / 评审沉淀" },
  { key: "conflict", label: "冲突建议" },
  { key: "translate", label: "翻译" },
];

const NAV_CAPSULE_SETTING_ITEMS: { id: NavCapsuleItemId; label: string }[] = [
  { id: "quick-chat", label: "快速开聊" },
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

const SETTING_NAV: {
  id: SettingSectionId;
  label: string;
  group: "basic" | "management";
}[] = [
  { id: "appearance", label: "外观", group: "basic" },
  { id: "startup", label: "启动行为", group: "basic" },
  { id: "hotkeys", label: "快捷键", group: "basic" },
  { id: "stats", label: "统计", group: "basic" },
  { id: "integration", label: "集成", group: "management" },
  { id: "network", label: "网络", group: "management" },
  { id: "update", label: "更新", group: "management" },
  { id: "diag", label: "诊断", group: "management" },
  { id: "storage", label: "数据与存储", group: "management" },
  { id: "about", label: "关于", group: "management" },
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
  item,
  tool,
  channel,
  entry,
  onInstall,
}: {
  label: string;
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
  const reason =
    item.status === "clt_stub" ? "需要安装 Xcode 命令行工具" : "未安装";
  return (
    <div className="py-1 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-err-text">✗</span>
        <span className="text-l2">{label}</span>
        <span className="text-l4">{reason}</span>
        {canOneClickInstall(tool, channel) ? (
          <button
            onClick={() => onInstall(tool)}
            disabled={entry.running}
            className={`${rowActionClass} shrink-0`}
          >
            {entry.running
              ? "安装中…"
              : item.status === "clt_stub"
                ? "安装"
                : "一键安装"}
          </button>
        ) : (
          <span className="text-l4">
            {installGuidance(tool, channel, DEP_PLATFORM)}
          </span>
        )}
      </div>
      <DepInstallLog entry={entry} />
    </div>
  );
}

/** 导航选中的分区始终展开；分区标题不是折叠操作。 */
function Section({
  title,
  badge,
  active,
  children,
}: {
  title: string;
  badge?: React.ReactNode;
  active: boolean;
  children: React.ReactNode;
}) {
  if (!active) return null;
  return (
    <section>
      <h2 className="mb-1 flex min-h-8 flex-wrap items-center gap-2 text-sm font-medium text-l1">
        {title}
        {badge}
      </h2>
      <div>{children}</div>
    </section>
  );
}

function Row({
  label,
  hint,
  labelTitle,
  extra,
  children,
}: {
  label: string;
  hint?: string;
  /** 文案克制（v3.88）：说不完的机制说明压成一句 hint，全文挂标签上悬浮可读 */
  labelTitle?: string;
  /** 行下方全宽区域（如字体安装的流式输出），不传不渲染 */
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 items-start gap-x-5 gap-y-2 py-3 @min-[40rem]/settings:grid-cols-[minmax(12rem,20rem)_minmax(0,1fr)] @min-[40rem]/settings:items-center">
      <div className="min-w-0">
        <div className="text-sm text-l2" title={labelTitle}>
          {label}
        </div>
        {hint && <p className="mt-0.5 max-w-lg text-micro leading-4 text-l4">{hint}</p>}
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-start gap-2">{children}</div>
      {extra && <div className="col-span-full mt-2">{extra}</div>}
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
      {value !== defaultValue && (
        <button
          type="button"
          onClick={() => {
            setCapturing(null);
            onSave(defaultValue);
          }}
          className={`${ghostActionClass} shrink-0`}
        >
          恢复
        </button>
      )}
      {value !== "" && (
        <button
          type="button"
          onClick={() => {
            setCapturing(null);
            onSave("");
          }}
          className={`${ghostActionClass} shrink-0`}
        >
          禁用
        </button>
      )}
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
      <Row
        label="页面切换"
        hint="按侧栏顺序切换页面；关闭后下面九个绑定全部不生效"
      >
        <Toggle
          checked={pageSwitchOn}
          onChange={(v) => void patch({ hotkeyPageSwitch: v })}
          label="页面切换"
        />
      </Row>
      {/* 成组编辑器统一内容卡（design-system 设置页条目）：「页面快捷键」「全局快捷键」
          各收一张卡，卡内标准列表行 = 功能名在左、控件靠右，宽屏双列；行不铺底色块 */}
      <div className="mt-2 rounded-lg ccode-well p-3">
        {/* 总开关关闭时整组弱化示意（仍可编辑，方便先配好再开） */}
        <div className={pageSwitchOn ? "" : "opacity-50"}>
          <div className="mb-2 text-xs font-medium text-l3">页面快捷键</div>
          <div className="grid grid-cols-1 gap-1 lg:grid-cols-2">
            {PAGE_HOTKEY_DEFS.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-hover"
              >
                <span className="min-w-0 truncate text-sm text-l2">{p.label}</span>
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
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-2 rounded-lg ccode-well p-3">
        <div className="mb-2 text-xs font-medium text-l3">全局快捷键</div>
        <div className="grid grid-cols-1 gap-1 lg:grid-cols-2">
          <div className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-hover">
            <span className="min-w-0 truncate text-sm text-l2" title="页面跳转 / 主题 / 侧栏">
              命令面板
            </span>
            <HotkeyCapture
              id="palette"
              value={palette}
              defaultValue="mod+k"
              conflictsWith={[chrome, ...pageCombos]}
              onSave={(combo) => void patch({ hotkeyPalette: combo })}
              capturing={capturing}
              setCapturing={setCapturing}
            />
          </div>
          <div className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-hover">
            <span className="min-w-0 truncate text-sm text-l2" title="界面只剩工作内容">
              隐藏侧栏
            </span>
            <HotkeyCapture
              id="chrome"
              value={chrome}
              defaultValue="mod+\\"
              conflictsWith={[palette, ...pageCombos]}
              onSave={(combo) => void patch({ hotkeyHideChrome: combo })}
              capturing={capturing}
              setCapturing={setCapturing}
            />
          </div>
        </div>
      </div>
    </>
  );
}

/** 一键卸载：清 Mesa 自己的数据，课题文件夹不动。确认两次，第二次要原样输入「卸载」。 */
function UninstallRow() {
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [typed, setTyped] = useState("");
  async function uninstall() {
    if (busy || typed.trim() !== "卸载") return;
    setBusy(true);
    // 界面记忆（最近项目、偏好等 ccode.* 键）在 WebView 的 localStorage 里，
    // 后端够不到；两次确认都已通过，就在动手前同步清掉。应用马上退出，无需保留
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith("ccode.")) localStorage.removeItem(key);
    }
    try {
      const result = await invoke<{
        trashed: string[];
        errors: string[];
      }>("uninstall_mesa");
      if (result.errors.length > 0) {
        await alertDialog(
          `有 ${result.errors.length} 项没能清掉，应用先不退出：\n${result.errors.join("\n")}`,
        );
        setBusy(false);
        return;
      }
      await exit(0);
    } catch (reason) {
      await alertDialog(`卸载没有完成：${String(reason)}`);
      setBusy(false);
    }
  }
  return (
    <div className="mt-3 rounded-lg ccode-well p-3">
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-l2">卸载 Mesa</span>
          <span className="block text-micro text-l4">
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
          className="inline-flex h-7 shrink-0 items-center justify-center rounded-md border border-err-text/40 px-2.5 text-xs text-err-text transition-colors hover:bg-hover disabled:opacity-50"
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
      setName("");
      setCommand("");
      setArgs("");
      setCwd("");
      setEnvText("");
      setEditingId(null);
      onNotice("已保存自定义运行时");
      await reload();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-lg ccode-well p-3">
      <div className="mb-1 text-sm text-l2">自定义运行时</div>
      <p
        className="mb-2 text-micro text-l4"
        title="登记一条本机命令，在当前终端目录当普通终端跑。不注入密钥、不解析会话。相对路径命令不能用。默认工作目录只在随手聊或空目录时启用，不会覆盖项目根或工作树。"
      >
        登记本机命令当普通终端跑；命令须绝对路径
      </p>
      {list.length > 0 && (
        <ul className="mb-2 space-y-1">
          {list.map((r) => (
            <li
              key={r.id}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-hover"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-l2">
                {r.name}
                <span className="ml-2 font-mono text-micro text-l4">
                  {r.command}
                </span>
              </span>
              <button
                type="button"
                className={`${ghostActionClass} shrink-0 text-micro`}
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
              <button
                type="button"
                className={`${ghostActionClass} shrink-0 text-micro`}
                onClick={() => {
                  setEditingId(r.id);
                  setName(r.name);
                  setCommand(r.command);
                  setArgs(r.args.join(" "));
                  setCwd(r.cwd ?? "");
                  setEnvText(Object.entries(r.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n"));
                }}
              >
                编辑
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <input
          className={`${fieldClass} h-8 min-w-28 flex-1 py-0`}
          placeholder="名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <textarea
          className={`${fieldClass} h-8 min-w-40 flex-1 py-1 font-mono text-micro`}
          placeholder={"环境变量（可选，每行 KEY=VALUE）"}
          value={envText}
          onChange={(e) => setEnvText(e.target.value)}
          rows={1}
        />
        <input
          className={`${fieldClass} h-8 min-w-36 flex-1 py-0`}
          placeholder="命令（绝对路径或 PATH 名）"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
        />
        <input
          className={`${fieldClass} h-8 min-w-40 flex-1 py-0`}
          placeholder="默认工作目录（可选）"
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
        />
        <input
          className={`${fieldClass} h-8 min-w-24 flex-1 py-0`}
          placeholder="参数（可选，空格分开）"
          value={args}
          onChange={(e) => setArgs(e.target.value)}
        />
        <button
          type="button"
          className={`${rowActionClass} shrink-0`}
          disabled={busy || !name.trim() || !command.trim()}
          onClick={() => void save()}
        >
          {editingId ? "保存修改" : "添加"}
        </button>
      </div>
    </div>
  );
}

export default function SettingsPage({ visible }: { visible: boolean }) {
  const settings = useAppStore((s) => s.settings);
  const loadSettings = useAppStore((s) => s.loadSettings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const profiles = useAppStore((s) => s.profiles);
  const aiChoices = aiProfileChoices(profiles);
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
  const [installing, setInstalling] = useState(false);
  const [installProgress, setInstallProgress] = useState<{
    downloaded: number;
    total: number | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoOpenedUpdate = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState("appearance");
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
  useEffect(() => {
    if (
      visible &&
      activeSection === "storage" &&
      storage === null
    ) {
      setStorageError(null);
      invoke<StorageEntryDto[]>("app_storage_usage")
        .then(setStorage)
        .catch(() => {
          setStorage(null);
          setStorageError("存储占用统计失败，请稍后重试。");
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, activeSection]);

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
  }, [visible, activeSection, appVersion]);

  useEffect(() => {
    if (!visible || activeSection !== "stats") return;
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

  function activateCustom(fromCurrent: boolean) {
    const saved = normalizeCustomTheme(settings?.customTheme);
    const computed = seedsFromComputed(getComputedStyle(document.documentElement));
    const next =
      fromCurrent || !saved
        ? (computed ?? saved ?? DEFAULT_CUSTOM_THEME)
        : saved;
    commitCustom(next);
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
      setTimeout(() => setNotice(null), 3000);
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
      setNotice("已保存，下一次统计查询生效");
      setTimeout(() => setNotice(null), 3000);
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
        setTimeout(() => setNotice(null), 4000);
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
      setTimeout(() => setNotice(null), 3000);
    } catch (e) {
      const message = String(e);
      setError(message);
      toast(`清理日志失败：${message}`, "error");
    }
  }

  // 下载并安装应用更新：成功后 relaunch 进新版本；失败恢复按钮可重试。
  // 重启会杀掉后台无头任务，安装前先查一遍，有活着的任务必须用户明确点头
  async function installUpdate() {
    if (!appUpdate || installing) return;
    try {
      const active = await invoke<
        { agent: string; taskRef: string | null }[]
      >("active_background_runs");
      if (active.length > 0) {
        const first = active[0];
        const label =
          first.taskRef || first.agent || "后台任务";
        const ok = await confirmDialog(
          `有 ${active.length} 个后台任务正在运行（如「${label}」）。\n\n` +
            "更新安装完成后应用会重启，这些任务会被直接中断，未保存的进度会丢失。\n\n" +
            "可以先去「后台任务」停止它们再更新。仍要现在安装？",
          { danger: true, confirmText: "仍然安装", focusCancel: true },
        );
        if (!ok) return;
      }
    } catch {
      // 查询失败不拦更新：用户主动点的安装，别因诊断性查询挂掉主流程
    }
    setInstalling(true);
    setInstallProgress({ downloaded: 0, total: null });
    setError(null);
    try {
      await appUpdate.downloadAndInstall((ev) => {
        if (ev.event === "Started") {
          setInstallProgress({
            downloaded: 0,
            total: ev.data.contentLength ?? null,
          });
        } else if (ev.event === "Progress") {
          setInstallProgress((prev) => ({
            downloaded: (prev?.downloaded ?? 0) + ev.data.chunkLength,
            total: prev?.total ?? null,
          }));
        } else if (ev.event === "Finished") {
          setInstallProgress((prev) => ({
            downloaded: prev?.total ?? prev?.downloaded ?? 0,
            total: prev?.total ?? null,
          }));
        }
      });
      await relaunch();
    } catch (e) {
      const message = String(e);
      setError(message);
      toast(`更新安装失败：${message}`, "error");
      setInstalling(false);
    }
  }

  async function copyLogs() {
    const text = logs
      .map((l) => `${l.ts} [${l.level}] ${l.source}: ${l.message}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setNotice("已复制到剪贴板");
      setTimeout(() => setNotice(null), 3000);
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
      setNotice(`诊断包已导出：${path}`);
      setTimeout(() => setNotice(null), 5000);
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
      setNotice(`配置快照已导出：${path}`);
      setTimeout(() => setNotice(null), 5000);
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

  return (
    <PageFrame width="fluid">
      <PageHeader title="设置" meta="外观、终端与应用集成" />
      {/* 结果横幅统一口径：well 底 + ✓/✗ 语义色文字，不铺整块 bg-ok/bg-err */}
      {error && (
        <div role="alert" className="mb-3 flex items-start gap-2 rounded-md ccode-well px-3 py-2.5 text-xs leading-5 text-l2">
          <span className="shrink-0 text-err-text">✗</span>
          <span className="min-w-0 flex-1">{error}</span>
        </div>
      )}
      {notice && (
        <div role="status" className="mb-3 flex items-start gap-2 rounded-md ccode-well px-3 py-2.5 text-xs leading-5 text-l2">
          <span className="shrink-0 text-ok-text">✓</span>
          <span className="min-w-0 flex-1">{notice}</span>
        </div>
      )}

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
                    {items.map(({ id, label }) => (
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

      <Section
        title="外观"
        active={activeSection === "appearance"}
      >
        {/* 主题：七列深浅成对。色卡是该主题的小窗（左栏 + 画布 + 强调点），
            名称写在画布上用该主题自己的标题色，深浅一眼可辨。
            成组编辑器收统一内容卡（同快捷键卡口径），块间分隔用留白不画横线。 */}
        <div className="mb-3 rounded-lg ccode-well p-3">
          <div className="mb-2 text-sm text-l2">主题</div>
          <div className="grid grid-cols-7 gap-2 overflow-x-auto">
            {themeSwatches.map((t) => {
              const selected = settings?.theme === t.id;
              return (
              <button
                key={t.id}
                onClick={() => {
                  setCustomDraft(null);
                  void patch({ theme: t.id, customThemeCardId: "" });
                }}
                title={`切换到${t.name}`}
                className={`min-w-0 overflow-hidden rounded-md text-left ${
                  selected ? "ring-2 ring-l1" : "ring-1 ring-hairline hover:ring-field"
                }`}
                style={{ background: t.canvas }}
              >
                <span className="flex h-14">
                  <span
                    className="w-2.5 shrink-0"
                    style={{ background: t.rail }}
                    aria-hidden="true"
                  />
                  <span className="flex min-w-0 flex-1 flex-col justify-between px-1.5 py-1.5">
                    <span
                      className="h-1.5 w-1.5 self-end rounded-full"
                      style={{ background: t.accent }}
                      aria-hidden="true"
                    />
                    <span
                      className="truncate text-micro font-medium"
                      style={{ color: t.ink }}
                    >
                      {t.name}
                    </span>
                  </span>
                </span>
              </button>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => activateCustom(false)}
              title="自定义主题"
              className={`h-14 w-[7.5rem] overflow-hidden rounded-md text-left ${
                customSelected
                  ? "ring-2 ring-l1"
                  : "ring-1 ring-hairline hover:ring-field"
              }`}
              style={{ background: customDerived.tokens.canvas }}
            >
              <span className="flex h-full">
                <span
                  className="w-2.5 shrink-0"
                  style={{ background: customDerived.tokens.rail }}
                  aria-hidden="true"
                />
                <span className="flex min-w-0 flex-1 flex-col justify-end px-1.5 py-1.5">
                  <span
                    className="truncate text-micro font-medium"
                    style={{ color: customDerived.tokens.l1 }}
                  >
                    自定义
                  </span>
                </span>
              </span>
            </button>
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
            <button
              type="button"
              className={`${rowActionClass} shrink-0`}
              onClick={() => activateCustom(true)}
            >
              从当前主题拷入
            </button>
            {savingCard ? (
              <span className="flex items-center gap-1.5">
                <input
                  className={`${fieldFixed} w-28`}
                  value={cardNameDraft}
                  autoFocus
                  maxLength={12}
                  onChange={(e) => setCardNameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") confirmSaveCard();
                    if (e.key === "Escape") setSavingCard(false);
                  }}
                />
                <button
                  type="button"
                  className={rowActionClass}
                  onClick={confirmSaveCard}
                >
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
            )}
          </div>
          {customCards.length > 0 && (
            <div className="mt-2 grid grid-cols-7 gap-2">
              {customCards.map((card) => {
                const derived = deriveThemeTokens(card);
                const selected = selectedCardId === card.id;
                return (
                  <div key={card.id} className="group relative min-w-0">
                    <button
                      type="button"
                      onClick={() => {
                        if (renamingId === card.id) return;
                        applySavedCard(card);
                      }}
                      onDoubleClick={(e) => {
                        e.preventDefault();
                        setRenamingId(card.id);
                        setRenameDraft(card.name);
                      }}
                      title={`${card.name}（双击改名）`}
                      className={`h-14 w-full overflow-hidden rounded-md text-left ${
                        selected
                          ? "ring-2 ring-l1"
                          : "ring-1 ring-hairline hover:ring-field"
                      }`}
                      style={{ background: derived.tokens.canvas }}
                    >
                      <span className="flex h-full">
                        <span
                          className="w-2.5 shrink-0"
                          style={{ background: derived.tokens.rail }}
                          aria-hidden="true"
                        />
                        <span className="flex min-w-0 flex-1 flex-col justify-between px-1.5 py-1.5">
                          <span
                            className="h-1.5 w-1.5 self-end rounded-full"
                            style={{ background: derived.tokens.cta }}
                            aria-hidden="true"
                          />
                          {renamingId === card.id ? (
                            <input
                              className="w-full border-0 bg-transparent p-0 text-micro font-medium outline-none"
                              style={{ color: derived.tokens.l1 }}
                              value={renameDraft}
                              autoFocus
                              maxLength={12}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => setRenameDraft(e.target.value)}
                              onBlur={() => commitRename(card)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.currentTarget.blur();
                                }
                                if (e.key === "Escape") {
                                  setRenamingId(null);
                                }
                              }}
                            />
                          ) : (
                            <span
                              className="truncate text-micro font-medium"
                              style={{ color: derived.tokens.l1 }}
                            >
                              {card.name}
                            </span>
                          )}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      title="删除"
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
            </div>
          )}
          {pickerDerived.warnings.length > 0 && customSelected && (
            <p className="mt-1.5 text-micro text-l4">
              {pickerDerived.warnings.join("；")}
            </p>
          )}
        </div>

        <Row
          label="侧栏 / 顶栏透明度"
          hint="立即生效。100% 是主题默认，0% 完全透出壁纸"
          labelTitle="立即生效。100% 是各主题本来的样子，0% 则完全不铺罩色、文字直接压在壁纸上。侧栏选中行的底色也跟着一起变淡，最透时只剩文字和图标变色。深浅主题与图标态各有自己的底色，同一个百分数看起来的浓淡会不同"
        >
          <select
            className={`${fieldFixed} w-36`}
            value={normalizeChromeOpacity(settings?.chromeOpacity)}
            onChange={(e) =>
              void patch({ chromeOpacity: Number(e.target.value) })
            }
          >
            {CHROME_OPACITIES.map((pct) => (
              <option key={pct} value={pct}>
                {chromeOpacityLabel(pct)}
              </option>
            ))}
          </select>
        </Row>

        <Row
          label="终端渲染"
          hint={
            IS_MAC
              ? "重开终端生效。清晰更锐，流畅更快"
              : "重开终端生效。自动：Windows 流畅，Mac 清晰"
          }
        >
          <select
            className={fieldFixed}
            value={settings?.terminalRenderer ?? "auto"}
            onChange={(e) => patch({ terminalRenderer: e.target.value })}
          >
            <option value="auto">自动</option>
            <option value="webgl">流畅（WebGL）</option>
            <option value="dom">清晰（默认渲染）</option>
          </select>
        </Row>

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
          hint="立即生效。没装上的可以一键装"
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
                    {fontInstallOutput || "安装中，等待输出…"}
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
          <div className="flex items-center gap-2">
            <select
              className={fieldFixed}
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
            {/* 选中可安装预设且检测未安装时显示一键安装（已装/内置/系统/自定义不显示） */}
            {INSTALLABLE_FONTS[fontFamily] &&
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

        <Row label="终端调色板" hint="立即生效">
          {/* 只列出与当前主题亮暗匹配的四套：浅色主题配深色向 ANSI 会让 white/brightWhite
              在近白底上隐形，不给用户配出不可读组合的机会。存的值不符时按 twin 现算生效值。 */}
          {(() => {
            const themeIsLight = isLightTheme(settings?.theme);
            const stored = settings?.terminalPalette;
            const effective = resolvePaletteId(stored, themeIsLight);
            const options = PALETTE_LIST.filter((p) => p.light === themeIsLight);
            return (
              <div className="flex flex-col gap-1.5">
                <div className="flex gap-2">
                  {options.map((pl) => (
                    <button
                      key={pl.id}
                      onClick={() => patch({ terminalPalette: pl.id })}
                      title={pl.name}
                      className={`rounded-md border p-1.5 text-xs ${
                        effective === pl.id
                          ? "border-cta-bd text-l1"
                          : "border-field text-l3 hover:text-l1"
                      }`}
                    >
                      {/* 8 色无缝色条：分段 flex-1 自适应固定宽度，色数变化也不撑破布局 */}
                      <span className="flex h-3 w-16 overflow-hidden rounded-sm">
                        {paletteDots(pl.id).map((d) => (
                          <span
                            key={d}
                            className="flex-1"
                            style={{ background: d }}
                          />
                        ))}
                      </span>
                    </button>
                  ))}
                </div>
                {stored && stored !== effective && (
                  <div className="text-micro text-l4">
                    当前主题是{themeIsLight ? "浅色" : "深色"}，已自动切换到配对的
                    {themeIsLight ? "浅色" : "深色"}调色板
                  </div>
                )}
              </div>
            );
          })()}
        </Row>

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

        <Row
          label="长任务 OS 通知"
          hint="窗口在后台、待你确认时通知，30 秒内不重复"
        >
          <Toggle
            label="长任务 OS 通知"
            checked={settings?.notificationsEnabled ?? true}
            onChange={(checked) => patch({ notificationsEnabled: checked })}
          />
        </Row>

        <Row
          label="底部状态栏"
          hint="终端和聊天共用。关掉后两边都不显示"
        >
          <Toggle
            label="底部状态栏"
            checked={settings?.statusBar ?? true}
            onChange={(checked) => patch({ statusBar: checked })}
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
      </Section>

      {/* 快捷键：点击绑定钮进入录制态，按下新组合即保存；空串 = 禁用 */}
      <Section
        title="启动行为"
        active={activeSection === "startup"}
      >
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
        <Row label="启动时进入" hint="下次启动生效">
          <select
            className={fieldFixed + " w-32"}
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
          hint="仅影响下次启动；运行中仍可通过侧栏按钮或 ⌘\\ 临时切换"
        >
          <select
            className={`${fieldFixed} w-52`}
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
          label="顶部岛自动收起"
          hint="完全隐藏时，鼠标移开后按此延时收起岛"
          labelTitle="完全隐藏时，岛始终停在顶部，只留「恢复侧栏」；鼠标移入或键盘聚焦展开完整导航，移开后按此延时收起。选「立即」适合只借岛点一下就走，不留停在半开的岛"
        >
          <select
            className={`${fieldFixed} w-28`}
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
          label="顶部岛跑完播报"
          hint="Agent 跑完或断开时在顶部报一句，4 秒消失"
          labelTitle="Agent 跑完一个回合或进程断开时，在休眠态那一行报一句，4 秒后自己消失。只报这两种「刚发生的事」——等待确认、冲突等待处理属于收件箱，岛不重复持有它们的计数"
        >
          <Toggle
            label="顶部岛跑完播报"
            checked={settings?.navCapsuleRunAnnounce !== false}
            onChange={(v) => void patch({ navCapsuleRunAnnounce: v })}
          />
        </Row>
        <Row
          label="顶部岛导航内容"
          hint="完全隐藏时岛展开显示什么；立即生效"
          labelTitle="完全隐藏时控制展开态里显示符号、文字，设置修改后立即生效"
        >
          <select
            className={`${fieldFixed} w-40`}
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
        <div className="mt-2 rounded-lg ccode-well p-3">
          <div className="mb-2 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-l2">顶部导航显示项目</div>
              <p className="mt-0.5 text-micro leading-4 text-l4">
                恢复侧栏始终保留；隐藏当前页面时会临时保留该入口
              </p>
            </div>
            <button
              type="button"
              className={`${ghostActionClass} shrink-0 text-xs`}
              onClick={() => void patch({ navCapsuleVisibleItems: [...NAV_CAPSULE_ITEM_IDS] })}
            >
              全部显示
            </button>
          </div>
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
                  className={`h-8 rounded-md border px-2.5 text-xs ${
                    selected
                      ? "border-field bg-raised text-l1"
                      : "border-hairline bg-canvas text-l3"
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
        </div>
      </Section>

      <Section
        title="快捷键"
        active={activeSection === "hotkeys"}
      >
        {/* 全部在用的绑定（命令面板/侧栏/九页切）在 HotkeysSection 内互判冲突 */}
        <HotkeysSection settings={settings} patch={patch} />
      </Section>

      <Section
        title="统计"
        active={activeSection === "stats"}
      >
        <Row label="汇率（USD→CNY）" hint="统计页下次查询生效">
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
        <div className="py-3">
          <div className="mb-1 flex items-center gap-3">
            <span className="w-32 shrink-0 text-sm text-l2">自定义定价</span>
            <span className="text-xs text-l4">
              美元 / 每百万 token，按模型名前缀匹配（覆盖内置价目与模型能力库价目）
            </span>
            <button
              onClick={savePricing}
              disabled={!pricingDirty || savingPricing}
              className={`ml-auto ${rowActionClass}`}
            >
              {savingPricing ? "保存中…" : "保存"}
            </button>
          </div>
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
        </div>
      </Section>

      <Section
        title="集成"
        active={activeSection === "integration"}
      >
        {hookSupportError && (
          <div className="mb-2 flex items-center gap-2 text-xs text-err-text">
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
        <Row label="brew 镜像" hint="安装/更新走国内镜像（元数据 TUNA、包体南大 ghcr 代理）">
          <Toggle
            label="brew 镜像"
            checked={settings?.brewMirror ?? false}
            onChange={(checked) => patch({ brewMirror: checked })}
          />
        </Row>

        <Row
          label="会话自动命名"
          hint="起名跟下方 AI 配置走，「会话摘要 / 起名」行可单独换；关掉后不再自动改标题"
          labelTitle="聊完起名、打开对话页补名去重。起名用哪份 AI 配置：默认跟下方「AI 专用配置」，在「按功能单独配置」的「会话摘要 / 起名」行可单独指定（起名和会话摘要共用这一行）。关掉后 Mesa 不再自动起名或补名，已有标题与你手改的标题都不受影响"
        >
          <Toggle
            label="会话自动命名"
            checked={settings?.autoTitleSessions ?? true}
            onChange={(v) => patch({ autoTitleSessions: v })}
          />
        </Row>

        <Row
          label="AI 专用配置"
          hint="同一配置的每个模型各占一条。自动用最近使用的配置"
        >
          <select
            className={fieldFixed}
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

        {/* 同权控件分级（跨页三原则 #1）：按功能的七条收进一张卡，不再与上方默认行排成一堵墙 */}
        <div className="rounded-lg ccode-well p-3">
          <div className="mb-2 text-xs font-medium text-l3">
            按功能单独配置（留空跟随上方默认）
          </div>
          <div className="flex flex-col gap-2">
            {AI_FN_ROWS.map((fn) => (
              <div key={fn.key} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-sm text-l2">{fn.label}</span>
                <select
                  className={`${fieldFixed} w-56 shrink-0`}
                  value={selectedAiProfileChoice(
                    settings?.aiProfiles?.[fn.key],
                    settings?.aiProfileModels?.[fn.key],
                    profiles,
                  )}
                  onChange={(e) => patchAiFnProfile(fn.key, e.target.value)}
                >
                  <option value="">跟随默认</option>
                  {aiChoices.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>

        <Row
          label="外部终端"
          hint="「⇗ 外部恢复」用哪个终端；立即生效"
          labelTitle="对话页「⇗ 外部恢复」使用的终端应用，立即生效。Windows 可在命令提示符和 PowerShell 之间切换：cmd 不经过 PowerShell，通常更快"
        >
          <select
            className={fieldFixed}
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

        {/* 九家收一张卡：行标签只写 agent 名（「精确注意力标记」由卡头承担），写入位置放行内 micro 说明 */}
        {hookSupport.length > 0 && (
          <div className="rounded-lg ccode-well p-3">
            <div className="mb-2 text-xs font-medium text-l3">精确注意力标记</div>
            <div className="flex flex-col gap-2">
              {hookSupport.map((h) => {
                const label = AGENTS.find((a) => a.id === h.agent)?.label ?? h.agent;
                const hint = h.supported
                  ? `写入 ${h.configPath ?? `${label} 配置`}（自动备份）${h.note ? `；${h.note}` : ""}`
                  : "暂不支持";
                return (
                  <div key={h.agent} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm text-l2">{label}</div>
                      <p className="mt-0.5 break-all text-micro leading-4 text-l4">{hint}</p>
                    </div>
                    {h.supported ? (
                      <Toggle
                        label={`精确注意力标记（${label}）`}
                        checked={settings?.hooksAttention?.[h.agent] ?? false}
                        onChange={(checked) => void toggleHooks(h.agent, label, checked)}
                      />
                    ) : (
                      <span className="pointer-events-none shrink-0 opacity-40">
                        <Toggle
                          label={`精确注意力标记（${label}）`}
                          checked={false}
                          onChange={() => {}}
                        />
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Section>

      <Section
        title="网络"
        active={activeSection === "network"}
      >
        <Row
          label="出网代理"
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
                {proxyDetecting ? "检测中…" : "检测"}
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
          hint="对应 NO_PROXY。填了出网代理但此项留空时，默认 localhost,127.0.0.1,::1"
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
        <Row
          label="学校图书馆"
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
                把图书馆「校外访问」链接贴这里，打开文献会走学校代理。校园网直连不用填。
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
        title="更新"
        active={activeSection === "update"}
        badge={
          appUpdate ? (
            <span className="ml-1 inline-flex items-center gap-1 rounded-sm bg-inset px-1.5 py-0.5 text-xs font-normal text-l3">
              <span className="size-2 rounded-full bg-ok-text" />
              v{appUpdate.version} 可更新
            </span>
          ) : undefined
        }
      >
        <div className="py-3">
          {appUpdate ? (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-sm text-l2">
                  发现新版本{" "}
                  <span className="text-l1">v{appUpdate.version}</span>
                  <span className="ml-2 text-xs text-l4">
                    当前 v{appUpdate.currentVersion}
                  </span>
                </span>
                <button
                  onClick={installUpdate}
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
              </div>
              <p className="mb-2 text-xs text-l4">
                安装完成后会自动重启。进行中的对话请先保存。
              </p>
              {installing && (
                <div className="mb-2">
                  <div className="h-1 overflow-hidden rounded-full bg-inset">
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
                </div>
              )}
              {appUpdateError && (
                <p className="mb-2 text-xs text-err-text">{appUpdateError}</p>
              )}
              {appUpdate.body && (
                <div className="max-h-48 overflow-auto whitespace-pre-line rounded-sm ccode-well p-2 text-xs leading-5 text-l3">
                  {appUpdate.body}
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-l4">
                {appUpdateStatus === "error"
                  ? appUpdateError ?? appUpdateStatusHint("error")
                  : appUpdateStatusHint(appUpdateStatus)}
              </span>
              {appUpdateStatus !== "dev" &&
                appUpdateStatus !== "checking" &&
                appUpdateStatus !== "idle" && (
                  <button
                    onClick={() => checkAppUpdate()}
                    className={`shrink-0 ${rowActionClass}`}
                  >
                    重新检查
                  </button>
                )}
              {(appUpdateStatus === "checking" ||
                appUpdateStatus === "idle") && (
                <span className="text-xs text-l4">请稍候</span>
              )}
            </div>
          )}
        </div>
      </Section>

      <Section
        title="诊断"
        active={activeSection === "diag"}
      >
        <Row
          label="Windows 诊断包"
          hint="打包系统与运行信息供排查；已脱敏，不含环境变量"
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
          hint="应用设置、九家配置清单与能力表的当前生效值，排查配置漂移用；已脱敏，不含密钥"
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
          hint="Git / Node.js / Quarto / TeX / 拼图库"
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
                  item={depCheck.pymupdf}
                  tool="pymupdf"
                  channel={depCheck.channel}
                  entry={depInstall.entries.pymupdf}
                  onInstall={(t) => void depInstall.install(t)}
                />
                <DepStatusLine
                  label="Pillow"
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
                    "无 Homebrew（Git 可走系统安装窗口）"}
                  {depCheck.channel === "none" &&
                    "无自动安装渠道（按指引手动安装）"}
                  <span className="ml-auto shrink-0">
                    上次检测 {depCheck.checkedAt}
                  </span>
                </div>
                {depCheckError && (
                  <div className="py-1 text-xs text-err-text">
                    上次检测失败：{depCheckError}，可重试
                  </div>
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
        <div className="py-3">
          <div className="group mb-2 flex items-center gap-2">
            <span className="text-xs text-l4">
              最近 100 条应用日志（进程内缓冲，重启即清空）
            </span>
            {/* 诊断是低频区：行内按钮 hover 才现，Tab 聚焦同样显示 */}
            <button
              onClick={loadLogs}
              className={`ml-auto rounded-sm px-2 py-0.5 text-xs text-l2 hover:bg-hover ${hoverRevealClass}`}
            >
              刷新
            </button>
            <button
              onClick={copyLogs}
              disabled={logs.length === 0}
              className={`rounded-sm px-2 py-0.5 text-xs text-l2 hover:bg-hover disabled:opacity-50 ${hoverRevealClass}`}
            >
              复制全部
            </button>
            <button
              onClick={async () => {
                setError(null);
                try {
                  const path = await invoke<string>("export_app_log");
                  setNotice(`已导出：${path}`);
                  setTimeout(() => setNotice(null), 4000);
                } catch (e) {
                  setError(String(e));
                }
              }}
              disabled={logs.length === 0}
              title="导出为 txt 到 ~/Downloads/ccode-exports/，反馈问题时发给开发者"
              className={`rounded-sm px-2 py-0.5 text-xs text-l2 hover:bg-hover disabled:opacity-50 ${hoverRevealClass}`}
            >
              导出
            </button>
            <button
              onClick={clearLogs}
              disabled={logs.length === 0}
              className={`rounded-sm px-2 py-0.5 text-xs text-l2 hover:bg-hover disabled:opacity-50 ${hoverRevealClass}`}
            >
              清空
            </button>
          </div>
          {logs.length === 0 ? (
            <p className="text-xs text-l4">暂无日志</p>
          ) : (
            <div className="max-h-64 overflow-auto rounded-sm ccode-well p-2 font-mono text-xs leading-5">
              {logs.map((l, i) => (
                <div key={i} className="break-all">
                  <span className="text-l4">
                    {l.ts.replace("T", " ").replace("Z", "")}{" "}
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
        </div>
      </Section>

      <Section
        title="数据与存储"
        active={activeSection === "storage"}
      >
        {/* 用户此前完全不知道 Mesa 在硬盘上占了多少、存在哪（v3.88 补） */}
        {storageError ? (
          <p className="py-2 text-xs text-err-text">{storageError}</p>
        ) : storage === null ? (
          <p className="py-2 text-xs text-l4">统计中…</p>
        ) : (
          <ul>
            {storage.map((e) => (
              <li key={e.path} className="group flex items-center gap-2 rounded-md px-2 py-2 hover:bg-hover">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-l2">
                    {e.label}
                  </span>
                  <span
                    className="block truncate font-mono text-micro text-l4"
                    title={e.path}
                  >
                    {e.path}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-xs text-l3">
                  {e.exists ? formatBytes(e.bytes) : "—"}
                </span>
                {/* 行级低频动作：hover 才现的 ghost 钮，不再每行常驻描边次按钮 */}
                <button
                  type="button"
                  disabled={!e.exists}
                  onClick={() => void openStorageEntry(e.path)}
                  title="在系统文件管理器中定位"
                  className={`${ghostActionClass} ${hoverRevealClass} shrink-0 disabled:opacity-40`}
                >
                  定位
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="pt-2 text-micro text-l4">
          快照 / 备份 / 缓存可以直接删，配置与索引别手动删。
        </p>
        <UninstallRow />
        <CustomRuntimeBlock onError={setError} onNotice={setNotice} />
      </Section>

      <Section
        title="关于"
        active={activeSection === "about"}
      >
        <Row
          label="版本"
          hint={
            appUpdate
              ? `有新版本 v${appUpdate.version}，到「更新」分区安装`
              : undefined
          }
        >
          <span className="flex items-center gap-2">
            <span className="font-mono text-xs text-l2">
              {appVersion ?? "…"}
            </span>
            {appUpdate && (
              <button
                type="button"
                className={rowActionClass}
                onClick={() => setActiveSection("update")}
              >
                去安装
              </button>
            )}
          </span>
        </Row>
        <Row label="项目主页" hint="MIT 许可">
          <button
            type="button"
            className={secondaryActionClass}
            onClick={() =>
              void openUrl("https://github.com/hongtongzhou-design/ccode")
            }
          >
            在浏览器打开
          </button>
        </Row>
      </Section>
          </div>
        </div>
      </div>
    </PageFrame>
  );
}
