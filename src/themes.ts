import {
  CUSTOM_LIGHT_THEME_ID,
  CUSTOM_THEME_ID,
  isCustomThemeId,
  monacoEditorColors,
} from "./custom-theme.ts";

export { CUSTOM_LIGHT_THEME_ID, CUSTOM_THEME_ID, isCustomThemeId };

/** 主题清单（设置页色卡与 ⌘K 命令面板共用，单一出处）。
 *  七套深色 + 七套同名浅色（light 标记），浅色在设置页排在对应深色正下方。
 *  自定义主题不进本表（custom / custom-light）。 */
export const THEMES = [
  { id: "midnight", name: "沉浸黑" },
  { id: "terracotta", name: "陶土" },
  { id: "ayu", name: "琥珀" },
  { id: "mocha", name: "暮紫" },
  { id: "neutral", name: "极简灰蓝" },
  { id: "dracula", name: "哥特" },
  { id: "shadcn", name: "灰蓝正红" },
  { id: "midnight-light", name: "沉浸黑 · 浅", light: true },
  { id: "terracotta-light", name: "陶土 · 浅", light: true },
  { id: "ayu-light", name: "琥珀 · 浅", light: true },
  { id: "mocha-light", name: "暮紫 · 浅", light: true },
  { id: "neutral-light", name: "极简灰蓝 · 浅", light: true },
  { id: "dracula-light", name: "哥特 · 浅", light: true },
  { id: "shadcn-light", name: "灰蓝正红 · 浅", light: true },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

/** 首次安装的主题（2026-10-26 用户拍板：极简灰蓝深色；原 2026-10-22 琥珀 + 跟随系统）：首装不跟随系统深浅，
 *  新用户首屏一律深色（settings.rs DEFAULT_THEME / DEFAULT_THEME_FOLLOW_SYSTEM 同步）。
 *  也是设置还没读到时的兜底 */
export const DEFAULT_THEME_ID = "neutral";

/** 主题亮暗判定单一出处：原生窗口外观、终端调色板 twin、浅色分支都走它，禁另造判定。
 *  自定义浅色 id 为 custom-light（画布亮度现算后写入），不进 THEMES 十四套清单。 */
export function isLightTheme(id: string | undefined): boolean {
  if (id === CUSTOM_LIGHT_THEME_ID) return true;
  if (id === CUSTOM_THEME_ID) return false;
  return THEMES.some((t) => t.id === id && "light" in t && t.light);
}

/** Monaco 编辑器主题（文件预览与合并冲突共用，名为 MONACO_THEME）：底子跟 Mesa 主题深浅走——
 *  语法着色、当前行框、选区这些没逐项覆盖的颜色都继承底子，浅色主题配 vs-dark 会字色发淡、
 *  当前行套一圈深色框（2026-10-29 打包版点验截图）。面色仍从 CSS 令牌读 */
export const MONACO_THEME = "ccode";
export function monacoThemeData(themeId: string | undefined, get: (name: string) => string) {
  const light = isLightTheme(themeId);
  return {
    base: light ? ("vs" as const) : ("vs-dark" as const),
    inherit: true,
    rules: [],
    colors: monacoEditorColors(get, light),
  };
}
