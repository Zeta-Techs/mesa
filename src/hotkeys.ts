/**
 * 全局快捷键的组合键纯逻辑（与 DOM 解耦，node --test 直接单测）。
 * 组合串格式："mod+shift+alt+key"，mod = macOS ⌘ / 其他平台 Ctrl；key 为小写 e.key。
 * 空串 = 该快捷键禁用。
 */

/** 页切绑定清单单一出处（App.tsx 全局监听与设置页录制 UI 同源）：
 *  顺序与导航定义一致（工作→资源→用量/设置）；combo 为该页默认绑定（settings.hotkeyPages 可按页覆盖） */
export const PAGE_HOTKEY_DEFS = [
  { id: "workbench", label: "工作台", combo: "mod+1" },
  { id: "workspaces", label: "项目", combo: "mod+2" },
  { id: "terminal", label: "运行", combo: "mod+3" },
  { id: "sessions", label: "对话", combo: "mod+4" },
  { id: "profiles", label: "连接", combo: "mod+5" },
  { id: "skills", label: "技能", combo: "mod+6" },
  { id: "mcp", label: "MCP", combo: "mod+7" },
  { id: "stats", label: "用量", combo: "mod+8" },
  { id: "settings", label: "设置", combo: "mod+9" },
] as const;

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
