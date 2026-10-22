import {
  CUSTOM_LIGHT_THEME_ID,
  CUSTOM_THEME_ID,
  isCustomThemeId,
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

/** 首次安装的主题（2026-10-22 用户拍板，原沉浸黑）：琥珀的强调色就是 Mesa 的琥珀光标，发送块 / 插入符 /
 *  主按钮同一种颜色；首装同时默认「跟随系统深浅」（settings.rs DEFAULT_THEME / DEFAULT_THEME_FOLLOW_SYSTEM 同步）。
 *  也是设置还没读到时的兜底 */
export const DEFAULT_THEME_ID = "ayu";

/** 主题亮暗判定单一出处：原生窗口外观、终端调色板 twin、浅色分支都走它，禁另造判定。
 *  自定义浅色 id 为 custom-light（画布亮度现算后写入），不进 THEMES 十四套清单。 */
export function isLightTheme(id: string | undefined): boolean {
  if (id === CUSTOM_LIGHT_THEME_ID) return true;
  if (id === CUSTOM_THEME_ID) return false;
  return THEMES.some((t) => t.id === id && "light" in t && t.light);
}
