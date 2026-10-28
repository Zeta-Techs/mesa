/* 聊天层阅读体验：字号档 / 字体 / 行内代码强调色 / 滚动条。
   各表必须与 src-tauri/src/settings.rs 的 KNOWN_CHAT_* 一致——那边是存真值的白名单，
   不在表里的值会被静默落回默认，前端加选项而 Rust 没跟上就是「选了没反应」。

   只写成壳上的 CSS 变量 / data 属性，真正的样子留在 App.css（深浅两套强调色在那边按主题分）；
   JS 不持有颜色。「标准 / 系统」两档不写变量，保证没调过的人和改版前同一个样子。 */

export const CHAT_FONT_SIZES = ["small", "normal", "large", "xlarge"] as const;
export type ChatFontSize = (typeof CHAT_FONT_SIZES)[number];

export const CHAT_FONT_FAMILIES = ["system", "serif", "mono"] as const;
export type ChatFontFamily = (typeof CHAT_FONT_FAMILIES)[number];

export const CHAT_ACCENTS = ["off", "warm", "amber", "teal", "violet"] as const;
export type ChatAccent = (typeof CHAT_ACCENTS)[number];

export const CHAT_SCROLLBARS = ["auto", "always"] as const;
export type ChatScrollbar = (typeof CHAT_SCROLLBARS)[number];

export const DEFAULT_CHAT_FONT_SIZE: ChatFontSize = "normal";
export const DEFAULT_CHAT_FONT_FAMILY: ChatFontFamily = "system";
export const DEFAULT_CHAT_ACCENT: ChatAccent = "warm";
export const DEFAULT_CHAT_SCROLLBAR: ChatScrollbar = "auto";

function pick<T extends string>(
  table: readonly T[],
  value: unknown,
  fallback: T,
): T {
  return table.includes(value as T) ? (value as T) : fallback;
}

export const normalizeChatFontSize = (v: unknown) =>
  pick(CHAT_FONT_SIZES, v, DEFAULT_CHAT_FONT_SIZE);
export const normalizeChatFontFamily = (v: unknown) =>
  pick(CHAT_FONT_FAMILIES, v, DEFAULT_CHAT_FONT_FAMILY);
export const normalizeChatAccent = (v: unknown) =>
  pick(CHAT_ACCENTS, v, DEFAULT_CHAT_ACCENT);
export const normalizeChatScrollbar = (v: unknown) =>
  pick(CHAT_SCROLLBARS, v, DEFAULT_CHAT_SCROLLBAR);

/** 字号档 → 正文像素。标准档返回 null = 不写变量，沿用 --chat-base（14px，2026-10-28 起 Mac 与 Windows 同） */
export function chatFontSizePx(v: unknown): number | null {
  switch (normalizeChatFontSize(v)) {
    case "small":
      return 12.5;
    case "large":
      return 15.5;
    case "xlarge":
      return 17.5;
    default:
      return null;
  }
}

/** 字体 → font-family 栈。系统档返回 null = 继承全局栈。
   衬线栈把中文衬线（宋体系）排在西文衬线前面：混排时汉字不会掉回黑体；
   等宽栈直接复用 App.css 的 --font-mono（JetBrains Mono + CJK 兜底）。 */
export function chatFontFamilyStack(v: unknown): string | null {
  switch (normalizeChatFontFamily(v)) {
    case "serif":
      return `"Songti SC", "Noto Serif SC", "Source Han Serif SC", "SimSun", Georgia, "Times New Roman", serif`;
    case "mono":
      return "var(--font-mono)";
    default:
      return null;
  }
}

/** 壳上要写的内联变量：只含「不是默认」的那几个，没调过时返回空对象 */
export function chatStyleVars(settings: {
  chatFontSize?: unknown;
  chatFontFamily?: unknown;
}): Record<string, string> {
  const vars: Record<string, string> = {};
  const px = chatFontSizePx(settings.chatFontSize);
  if (px !== null) vars["--ccode-chat-fs"] = `${px}px`;
  const ff = chatFontFamilyStack(settings.chatFontFamily);
  if (ff !== null) vars["--ccode-chat-ff"] = ff;
  return vars;
}

export const CHAT_FONT_SIZE_LABEL: Record<ChatFontSize, string> = {
  small: "小",
  normal: "标准",
  large: "大",
  xlarge: "特大",
};
export const CHAT_FONT_FAMILY_LABEL: Record<ChatFontFamily, string> = {
  system: "系统",
  serif: "衬线",
  mono: "等宽",
};
export const CHAT_ACCENT_LABEL: Record<ChatAccent, string> = {
  off: "关闭",
  warm: "陶红",
  amber: "琥珀",
  teal: "青绿",
  violet: "紫",
};
export const CHAT_SCROLLBAR_LABEL: Record<ChatScrollbar, string> = {
  auto: "闲置淡出",
  always: "常显",
};
