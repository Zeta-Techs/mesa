/** 终端 16 色调色板预设（bg/fg 仍随应用主题，ANSI 色 + 光标 + 选区按预设切换）。
 *  从 TerminalPage 抽出共享：设置页的调色板预览也用它（单一事实源）。
 *
 *  **深浅成对（v3.85）**：每套深色调色板配一套同性格浅色 twin。
 *  原因：ANSI 预设原本全是深色向的，直接铺在浅色主题的近白底上时
 *  `white #e5e5e5`／`brightWhite #ffffff` 等于隐形、`yellow #e5e510` 读不了、
 *  写死的深藏蓝选区把选中文字压成不可读。浅色主题必须换整套 ANSI。
 *
 *  浅色套取值原则：以各家**官方浅色终端色板**为准（VS Code Light+ / Solarized Light /
 *  Atom One Light / Catppuccin Latte），仅对在近白底上对比度低于约 1.5:1 的槽位做加深，
 *  加深处在行内注释标注。`white`/`brightWhite` 在浅色下按各家官方口径落在中～浅灰区间，
 *  承担「弱化文字」语义（不是背景色），故不与 `black` 争最深。 */
export const XTERM_PALETTES: Record<string, Record<string, string>> = {
  // ---- 深色套（值与 v3.84 完全一致，仅把原先写死在 buildXtermTheme 里的
  //      cursor / selectionBackground 收进表内，深色行为零变化） ----
  "dark-plus": {
    black: "#000000", red: "#cd3131", green: "#0dbc79", yellow: "#e5e510",
    blue: "#2472c8", magenta: "#bc3fbc", cyan: "#11a8cd", white: "#e5e5e5",
    brightBlack: "#666666", brightRed: "#f14c4c", brightGreen: "#23d18b",
    brightYellow: "#f5f543", brightBlue: "#3b8eea", brightMagenta: "#d670d6",
    brightCyan: "#29b8db", brightWhite: "#ffffff",
    cursor: "#aeafad", selectionBackground: "#264f78",
  },
  solarized: {
    black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
    blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
    brightBlack: "#002b36", brightRed: "#cb4b16", brightGreen: "#586e75",
    brightYellow: "#657b83", brightBlue: "#839496", brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
    cursor: "#aeafad", selectionBackground: "#264f78",
  },
  "one-dark": {
    black: "#282c34", red: "#e06c75", green: "#98c379", yellow: "#d19a66",
    blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf",
    brightBlack: "#545862", brightRed: "#e06c75", brightGreen: "#98c379",
    brightYellow: "#d19a66", brightBlue: "#61afef", brightMagenta: "#c678dd",
    brightCyan: "#56b6c2", brightWhite: "#ffffff",
    cursor: "#aeafad", selectionBackground: "#264f78",
  },
  catppuccin: {
    black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af",
    blue: "#89b4fa", magenta: "#f5c2e7", cyan: "#94e2d5", white: "#bac2de",
    brightBlack: "#585b70", brightRed: "#f38ba8", brightGreen: "#a6e3a1",
    brightYellow: "#f9e2af", brightBlue: "#89b4fa", brightMagenta: "#f5c2e7",
    brightCyan: "#94e2d5", brightWhite: "#a6adc8",
    cursor: "#aeafad", selectionBackground: "#264f78",
  },

  // ---- 浅色套（v3.85 新增） ----
  /** VS Code Light+ 官方终端色板（原样采用，无加深） */
  "light-plus": {
    black: "#000000", red: "#cd3131", green: "#00bc00", yellow: "#949800",
    blue: "#0451a5", magenta: "#bc05bc", cyan: "#0598bc", white: "#555555",
    brightBlack: "#666666", brightRed: "#cd3131", brightGreen: "#14ce14",
    brightYellow: "#b5ba00", brightBlue: "#0451a5", brightMagenta: "#bc05bc",
    brightCyan: "#0598bc", brightWhite: "#a5a5a5",
    cursor: "#333333", selectionBackground: "#add6ff",
  },
  /** Solarized Light：强调色为官方值；base 槽位按浅底可读性重排——
   *  官方把 ANSI black 落在 base2 #eee8d5（浅底上不可见），此处改用 base02 #073642，
   *  brightWhite 用 base1 #93a1a1 承担弱化语义 */
  "solarized-light": {
    black: "#073642", red: "#dc322f", green: "#728a00", yellow: "#a07800",
    blue: "#268bd2", magenta: "#d33682", cyan: "#2a8a80", white: "#657b83",
    brightBlack: "#586e75", brightRed: "#cb4b16", brightGreen: "#859900",
    brightYellow: "#b58900", brightBlue: "#3a95d8", brightMagenta: "#6c71c4",
    brightCyan: "#2aa198", brightWhite: "#93a1a1",
    cursor: "#586e75", selectionBackground: "#e4dcc0",
  },
  /** Atom One Light 官方值；官方 white 为 #fafafa（浅底上不可见），
   *  改用 mono-3 #a0a1a7，brightWhite 取更浅一档 #c2c3c7 作弱化色 */
  "one-light": {
    black: "#383a42", red: "#e45649", green: "#50a14f", yellow: "#c18401",
    blue: "#4078f2", magenta: "#a626a4", cyan: "#0184bc", white: "#a0a1a7",
    brightBlack: "#696c77", brightRed: "#e45649", brightGreen: "#50a14f",
    brightYellow: "#c18401", brightBlue: "#4078f2", brightMagenta: "#a626a4",
    brightCyan: "#0997b3", brightWhite: "#c2c3c7",
    cursor: "#526fff", selectionBackground: "#bfdbfe",
  },
  /** Catppuccin Latte 官方终端色板（原样采用，无加深）。
   *  注：mocha-light 主题的 App chrome 早已用官方 Latte（App.css），
   *  终端却一直在用 Mocha 深色套——本条同时修掉这处不一致 */
  latte: {
    black: "#5c5f77", red: "#d20f39", green: "#40a02b", yellow: "#df8e1d",
    blue: "#1e66f5", magenta: "#ea76cb", cyan: "#179299", white: "#acb0be",
    brightBlack: "#6c6f85", brightRed: "#d20f39", brightGreen: "#40a02b",
    brightYellow: "#df8e1d", brightBlue: "#1e66f5", brightMagenta: "#ea76cb",
    brightCyan: "#179299", brightWhite: "#bcc0cc",
    cursor: "#4c4f69", selectionBackground: "#bcc0cc",
  },
};

/** 调色板清单（id/名称/亮暗）单一出处：设置页色卡与 buildXtermTheme 共用。
 *  同一 index 的深浅两套互为 twin（见 PALETTE_TWIN）。 */
export const PALETTE_LIST = [
  { id: "dark-plus", name: "Dark+", light: false },
  { id: "solarized", name: "Solarized", light: false },
  { id: "one-dark", name: "One Dark", light: false },
  { id: "catppuccin", name: "Catppuccin", light: false },
  { id: "light-plus", name: "Light+", light: true },
  { id: "solarized-light", name: "Solarized Light", light: true },
  { id: "one-light", name: "One Light", light: true },
  { id: "latte", name: "Latte", light: true },
] as const;

/** 深浅 twin 映射（双向）：主题亮暗与所选调色板不符时自动换到对面那套 */
export const PALETTE_TWIN: Record<string, string> = {
  "dark-plus": "light-plus",
  "light-plus": "dark-plus",
  solarized: "solarized-light",
  "solarized-light": "solarized",
  "one-dark": "one-light",
  "one-light": "one-dark",
  catppuccin: "latte",
  latte: "catppuccin",
};

/** 「跟随主题」（2026-10-22 起的默认，设置里没选过也是它）：深色 One Dark——各色对比度 4.3–9:1 较匀，
 *  Dark+ 黄色 14:1 扎眼、红蓝不到 4:1；浅色 Light+——One Light 在近白底上红蓝只有 3:1 出头。
 *  暮紫配 Catppuccin（同源配色）；浅色暮紫仍走 Light+（Latte 的黄、品红在浅底上 2.2:1）。 */
export const AUTO_PALETTE = "auto";
export const DEFAULT_DARK_PALETTE = "one-dark";
export const DEFAULT_LIGHT_PALETTE = "light-plus";
const THEME_DARK_PALETTE: Record<string, string> = { mocha: "catppuccin" };

/** 跟随主题时这套主题用哪套调色板 */
export function themeDefaultPalette(themeId: string | undefined, themeIsLight: boolean): string {
  if (themeIsLight) return DEFAULT_LIGHT_PALETTE;
  return (themeId && THEME_DARK_PALETTE[themeId]) || DEFAULT_DARK_PALETTE;
}

export function isLightPalette(id: string): boolean {
  return PALETTE_LIST.some((p) => p.id === id && p.light);
}

/**
 * 按主题亮暗解析实际生效的调色板 id。
 * 没选过 / 选了「跟随主题」/ 未知 id → 这套主题的默认套（themeDefaultPalette）；
 * 亮暗不符时切到 twin（无 twin 记录则回落默认套），
 * 避免用户配出「浅底 + 深色向 ANSI」这种不可读组合。
 */
export function resolvePaletteId(
  paletteId: string | undefined,
  themeIsLight: boolean,
  themeId?: string,
): string {
  const fallback = themeDefaultPalette(themeId, themeIsLight);
  const id = paletteId && XTERM_PALETTES[paletteId] ? paletteId : fallback;
  if (isLightPalette(id) === themeIsLight) return id;
  const twin = PALETTE_TWIN[id];
  if (twin && XTERM_PALETTES[twin]) return twin;
  return fallback;
}

/** 设置页预览用的代表色（前 8 个 ANSI 标准色） */
export const PALETTE_PREVIEW_KEYS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
] as const;
