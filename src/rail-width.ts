/**
 * 应用侧栏的宽度（2026-10-24 用户：侧栏「都做」——原来固定 18rem，长标题都被截断；tests/rail-width.test.ts）。
 * 拖右边缘改，双击右边缘回默认；记本机（localStorage RAIL_WIDTH_KEY，存 px）。收成图标时不管它（固定 w-14）。
 * 范围 14–26rem（按根字号算，Mac 14px、Windows 16px），再窄项目名和对话标题挤不下，再宽主区太窄；
 * 窗口小时上限再收到窗口宽的 40%，给运行页的对话留地方（run-layout.ts 的对话最窄 360px 另算）。
 */

export const RAIL_WIDTH_KEY = "ccode.railWidth";
export const RAIL_DEFAULT_REM = 18;
export const RAIL_MIN_REM = 14;
export const RAIL_MAX_REM = 26;

export function clampRailWidth(px: number, rem: number, windowWidth = Number.POSITIVE_INFINITY): number {
  const min = RAIL_MIN_REM * rem;
  const max = Math.max(min, Math.min(RAIL_MAX_REM * rem, windowWidth * 0.4));
  return Math.round(Math.min(max, Math.max(min, Number.isFinite(px) ? px : RAIL_DEFAULT_REM * rem)));
}

/** 存档读回来：坏值 / 没存过 = 默认宽 */
export function parseRailWidth(raw: string | null, rem: number): number {
  const v = Number(raw);
  return raw && Number.isFinite(v) && v > 0 ? clampRailWidth(v, rem) : RAIL_DEFAULT_REM * rem;
}
