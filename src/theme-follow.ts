import { DEFAULT_THEME_ID, THEMES, isCustomThemeId } from "./themes.ts";

/**
 * 主题跟随系统深浅（2026-10-17）的纯逻辑。
 *
 * 十四套内置主题深浅成对：`xxx` 与 `xxx-light` 同名同性格。跟随开着时，系统外观一变就把
 * settings.theme 换成对面那套写回——theme 始终是**生效值**，终端调色板 twin、原生窗口外观、
 * 浅色分支都照旧只读 theme，不必各自再判一次「现在是不是在跟随」。
 * 自定义配色（custom / custom-light）没有成对的另一套，不跟随，原样返回。
 */

/** 同名 twin：want=light 取 `xxx-light`，否则取 `xxx`；不是内置主题返回 null */
export function themeTwin(id: string | undefined, light: boolean): string | null {
  if (!id || isCustomThemeId(id)) return null;
  const base = id.endsWith("-light") ? id.slice(0, -"-light".length) : id;
  const target = light ? `${base}-light` : base;
  return THEMES.some((t) => t.id === target) ? target : null;
}

/** 跟随时应生效的主题：内置主题换成与系统同深浅的那套，自定义与未知 id 原样 */
export function followedTheme(id: string | undefined, systemDark: boolean): string {
  const fallback = id || DEFAULT_THEME_ID;
  return themeTwin(fallback, !systemDark) ?? fallback;
}
