/**
 * 全局快捷键的组合键纯逻辑（与 DOM 解耦，node --test 直接单测）。
 * 组合串格式："mod+shift+alt+key"，mod = macOS ⌘ / 其他平台 Ctrl；key 为小写 e.key。
 * 空串 = 该快捷键禁用。
 */

/** 页切绑定清单单一出处（App.tsx 全局监听、设置页录制 UI、命令面板、启动页同源）：
 *  顺序与侧栏一致（2026-10-24 侧栏改版后重排：工作台 · 运行 · 搜对话 · 项目，是图标态侧栏从上到下的顺序；
 *  原 ⌘2 项目 / ⌘3 运行 / ⌘4 对话），label = 侧栏上的入口名，page = 启动页下拉里的页名，hint = 设置页悬停说明。
 *  combo 为该页默认绑定（settings.hotkeyPages 按页覆盖，存的是页 id，重排不影响改过的绑定） */
export const PAGE_HOTKEY_DEFS = [
  { id: "workbench", label: "工作台", page: "工作台", combo: "mod+1", hint: "所有课题的总览" },
  {
    id: "terminal",
    label: "运行",
    page: "运行页",
    combo: "mod+2",
    hint: "回到运行页正看着的那段对话（展开的侧栏里没有这一行，点项目里的对话也一样）",
  },
  { id: "sessions", label: "搜对话", page: "对话页", combo: "mod+3", hint: "打开对话页，光标落在搜索框" },
  { id: "workspaces", label: "项目", page: "项目页", combo: "mod+4", hint: "当前课题的项目页" },
  { id: "profiles", label: "连接", page: "连接", combo: "mod+5", hint: "API 连接与官方账号" },
  { id: "skills", label: "技能", page: "技能", combo: "mod+6", hint: "给 Agent 装的技能" },
  { id: "mcp", label: "MCP", page: "MCP", combo: "mod+7", hint: "给 Agent 接的 MCP 服务" },
  { id: "stats", label: "用量", page: "用量", combo: "mod+8", hint: "token 与费用" },
  { id: "settings", label: "设置", page: "设置", combo: "mod+9", hint: "也可以用 ⌘, / Ctrl+," },
] as const;

/** 新对话（侧栏「新对话」同一入口；macOS「文件」菜单里也有，菜单那条固定 ⌘N）的默认绑定 */
export const DEFAULT_NEW_CHAT_HOTKEY = "mod+n";
/** 光标移到侧栏里正看着的那段对话，之后 ↑↓ 选、回车打开（2026-10-24；同 VS Code Ctrl+0 聚焦侧栏） */
export const DEFAULT_FOCUS_RAIL_HOTKEY = "mod+0";

/**
 * 全局快捷键这次按下去该不该由 Mesa 接：Windows / Linux 上 mod 是 Ctrl，焦点在终端里时 Ctrl+N（下一条历史）、
 * Ctrl+0 这类组合是给 shell / Agent 的，不能抢；macOS 的 mod 是 ⌘，终端里也照接。`inTerminal` = 焦点在 xterm 里
 */
export function globalHotkeyAllowed(inTerminal: boolean, isMac: boolean): boolean {
  return isMac || !inTerminal;
}

/** 改不了、但要让人知道的快捷键（设置页「固定快捷键」只列出）；mac / other 分写，因为 Ctrl+Tab 在 Mac 上也是 Ctrl */
export const FIXED_HOTKEYS: readonly { label: string; mac: string; other: string; hint?: string }[] = [
  { label: "切到刚才看的那段对话", mac: "⌃Tab", other: "Ctrl+Tab", hint: "在运行页里按，按最近看过的顺序" },
  { label: "切到最早看的那段对话", mac: "⌃⇧Tab", other: "Ctrl+Shift+Tab" },
  { label: "侧栏里上下选对话", mac: "↑ ↓ · 回车打开", other: "↑ ↓ · Enter 打开", hint: "光标在侧栏里时；← → 收起 / 展开课题" },
  { label: "打开设置", mac: "⌘,", other: "Ctrl+," },
  { label: "终端里查找", mac: "⌘F", other: "Ctrl+F", hint: "光标在终端里时" },
];

export interface Combo {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

/** 从键盘事件提取组合；纯修饰键（只按了 ⌘/Shift 等）或完全无修饰键时返回 null */
export function comboFromEvent(e: {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  key: string;
}): string | null {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod && !e.altKey) return null; // 全局快捷键必须至少带 mod 或 alt，防普通输入被吞
  const key = e.key.toLowerCase();
  if (["meta", "control", "shift", "alt"].includes(key)) return null;
  return comboToString({ mod, shift: e.shiftKey, alt: e.altKey, key });
}

export function comboToString(c: Combo): string {
  const parts: string[] = [];
  if (c.mod) parts.push("mod");
  if (c.shift) parts.push("shift");
  if (c.alt) parts.push("alt");
  parts.push(c.key);
  return parts.join("+");
}

/** 事件是否命中组合串；combo 为空串（禁用）时永不命中 */
export function eventMatchesCombo(
  e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; key: string },
  combo: string,
): boolean {
  if (!combo) return false;
  const parts = combo.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  const needMod = parts.includes("mod");
  const needShift = parts.includes("shift");
  const needAlt = parts.includes("alt");
  return (
    (e.metaKey || e.ctrlKey) === needMod &&
    e.shiftKey === needShift &&
    e.altKey === needAlt &&
    e.key.toLowerCase() === key
  );
}

/** 快捷键录制态的按键决议（SettingsPage HotkeyCapture 用；与 DOM 解耦可单测）：
 *  Esc 取消；纯修饰键/无修饰键忽略（继续等待）；与任一在用的其他绑定冲突则拒绝；其余保存 */
export function captureDecision(
  e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; key: string },
  conflictsWith: readonly string[],
):
  | { action: "cancel" }
  | { action: "save"; combo: string }
  | { action: "conflict"; combo: string }
  | { action: "ignore" } {
  if (e.key === "Escape") return { action: "cancel" };
  const combo = comboFromEvent(e);
  if (!combo) return { action: "ignore" };
  // 冲突方为禁用（空串）时不判冲突
  if (conflictsWith.some((c) => c && c === combo)) {
    return { action: "conflict", combo };
  }
  return { action: "save", combo };
}

/** 平台判定（App 标题栏收件箱等 mac 专属 chrome 用） */
export const IS_MAC =
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform || "");

/** Windows 判定（字体光栅化差异需要 CSS 按平台区分，见 App.css） */
export const IS_WINDOWS =
  typeof navigator !== "undefined" &&
  (navigator.platform || "").startsWith("Win");

/** 组合串 → 展示标签（mod+k → ⌘K；非 mac 显示 Ctrl+K） */
export function comboLabel(combo: string): string {
  if (!combo) return "已禁用";
  const parts = combo.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  const mods: string[] = [];
  if (parts.includes("mod")) mods.push(IS_MAC ? "⌘" : "Ctrl+");
  if (parts.includes("shift")) mods.push(IS_MAC ? "⇧" : "Shift+");
  if (parts.includes("alt")) mods.push(IS_MAC ? "⌥" : "Alt+");
  const keyLabel =
    key === "\\" ? "\\" : key.length === 1 ? key.toUpperCase() : key;
  return mods.join("") + keyLabel;
}

/** 阅读区笔记栏「阅读/编辑」切换（ReaderOverlay 监听 → FilePreviewEditor modeTick 翻转）。
 *  mod = macOS ⌘ / Win·Linux Ctrl；焦点在右栏终端时不拦（Ctrl+E 是 readline 行尾） */
export const READER_MODE_HOTKEY = "mod+e";
