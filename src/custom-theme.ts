/**
 * 自定义主题：用户只选左栏 / 画布 / 强调三色，其余令牌按现有深浅阶梯派生。
 * 与 DOM 解耦，供 node --test 直接测。真正写到 :root 的入口在 applyCustomThemeVars。
 */

export const CUSTOM_THEME_ID = "custom";
export const CUSTOM_LIGHT_THEME_ID = "custom-light";

export const DEFAULT_CUSTOM_THEME: CustomThemeSeeds = {
  rail: "#0c0b09",
  canvas: "#131210",
  accent: "#faa8d4",
};

/** 会写到 element.style 的令牌（不含 ok/err/warn/hover/switch——那些仍走 [data-theme$="-light"]） */
export const CUSTOM_TOKEN_KEYS = [
  "rail",
  "rail2",
  "rail-sel",
  "strip",
  "canvas",
  "inset",
  "raised",
  "bubble",
  "seg-sel",
  "hairline",
  "field",
  "l1",
  "l2",
  "l3",
  "l4",
  "cta",
  "cta-text",
  "cta-bd",
  "nav-accent",
  "cta-pill",
  "cta-pill-text",
  "folder",
  "editor-bg",
  "editor-fg",
  "editor-line",
  "done",
  "link",
  "tabline",
  "btn",
] as const;

export type CustomTokenKey = (typeof CUSTOM_TOKEN_KEYS)[number];

export interface CustomThemeSeeds {
  rail: string;
  canvas: string;
  accent: string;
}

export const CUSTOM_THEME_CARDS_MAX = 12;
export const CUSTOM_THEME_CARD_NAME_MAX = 12;

/** 另存的可点色卡（三色快照 + 名字） */
export interface CustomThemeCard extends CustomThemeSeeds {
  id: string;
  name: string;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface DerivedTheme {
  light: boolean;
  themeId: typeof CUSTOM_THEME_ID | typeof CUSTOM_LIGHT_THEME_ID;
  tokens: Record<CustomTokenKey, string>;
  warnings: string[];
}

export function isCustomThemeId(id: string | undefined): boolean {
  return id === CUSTOM_THEME_ID || id === CUSTOM_LIGHT_THEME_ID;
}

export function customThemeId(light: boolean): typeof CUSTOM_THEME_ID | typeof CUSTOM_LIGHT_THEME_ID {
  return light ? CUSTOM_LIGHT_THEME_ID : CUSTOM_THEME_ID;
}

export function parseHex(input: string): Rgb | null {
  const raw = input.trim().toLowerCase();
  const hex = raw.startsWith("#") ? raw.slice(1) : raw;
  if (/^[0-9a-f]{3}$/.test(hex)) {
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
    };
  }
  if (/^[0-9a-f]{6}$/.test(hex)) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(raw);
  if (rgb) {
    return {
      r: clampByte(+rgb[1]),
      g: clampByte(+rgb[2]),
      b: clampByte(+rgb[3]),
    };
  }
  return null;
}

export function formatHex(c: Rgb): string {
  const h = (n: number) => clampByte(n).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/** 规范化成 #rrggbb；非法返回 null */
export function normalizeHex(input: string | null | undefined): string | null {
  if (!input) return null;
  const c = parseHex(input);
  return c ? formatHex(c) : null;
}

/** Monaco 编辑器面色：从 CSS 令牌读（get = 按变量名取 getPropertyValue），一律规范成 #rrggbb。
 *  Monaco 只认 6/8 位十六进制，见到别的写法在 defineTheme 里直接抛错；打包版 CSS 压缩会把
 *  #ffffff / #111111 缩成 #fff / #111（2026-10-29 打包版打开文件整页「界面渲染出错」实证）。
 *  读不到或认不出时按深浅兜底 */
export function monacoEditorColors(get: (name: string) => string, light = false): Record<string, string> {
  const read = (name: string, fallback: string) => normalizeHex(get(name)) ?? fallback;
  return {
    "editor.background": read("--color-editor-bg", light ? "#ffffff" : "#11131a"),
    "editor.foreground": read("--color-editor-fg", light ? "#2a2620" : "#aeb6c6"),
    "editorLineNumber.foreground": read("--color-editor-line", light ? "#a39e93" : "#525a6b"),
  };
}

export function normalizeCustomTheme(
  seeds: Partial<CustomThemeSeeds> | null | undefined,
): CustomThemeSeeds | null {
  if (!seeds) return null;
  const rail = normalizeHex(seeds.rail);
  const canvas = normalizeHex(seeds.canvas);
  const accent = normalizeHex(seeds.accent);
  if (!rail || !canvas || !accent) return null;
  return { rail, canvas, accent };
}

/** 色块上的标签字色：亮底用深字，暗底用浅字 */
export function chipInk(hex: string): string {
  const c = parseHex(hex);
  if (!c) return "#e9e6e2";
  return lum(c) > 148 ? "#1a1814" : "#f4f1ec";
}

/** 与 theme-contrast.test.ts 同一套 0–255 加权亮度，用来排阶梯 */
export function lum(c: Rgb): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

export function relLum(c: Rgb): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const u = Math.min(1, Math.max(0, t));
  return {
    r: Math.round(a.r + (b.r - a.r) * u),
    g: Math.round(a.g + (b.g - a.g) * u),
    b: Math.round(a.b + (b.b - a.b) * u),
  };
}

/** 保持色相，把亮度拉到 target（0–255 加权 lum） */
export function setLum(base: Rgb, target: number): Rgb {
  const t = Math.min(255, Math.max(0, target));
  const cur = lum(base);
  if (Math.abs(cur - t) < 0.6) return base;
  const end = cur < t ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
  let lo = 0;
  let hi = 1;
  let best = base;
  let bestErr = Math.abs(cur - t);
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    const c = mixRgb(base, end, mid);
    const L = lum(c);
    const err = Math.abs(L - t);
    if (err < bestErr) {
      best = c;
      bestErr = err;
    }
    if ((cur < t && L < t) || (cur > t && L > t)) lo = mid;
    else hi = mid;
  }
  return best;
}

/** WCAG 相对亮度 ≥ 0.4 当浅色（纸面都在 0.8+，中灰偏深） */
export function canvasIsLight(canvas: Rgb): boolean {
  return relLum(canvas) >= 0.4;
}

export function customThemeIdFromSeeds(seeds: CustomThemeSeeds): string {
  const canvas = parseHex(seeds.canvas);
  return customThemeId(canvas ? canvasIsLight(canvas) : false);
}

function pullContrast(fg: Rgb, bg: Rgb, min: number, lightText: boolean): Rgb {
  let c = fg;
  for (let i = 0; i < 20 && contrast(c, bg) < min; i++) {
    c = lightText
      ? mixRgb(c, { r: 255, g: 255, b: 255 }, 0.18)
      : mixRgb(c, { r: 0, g: 0, b: 0 }, 0.18);
  }
  return c;
}

function textOn(bg: Rgb): Rgb {
  const paper = { r: 252, g: 250, b: 246 };
  const ink = { r: 26, g: 24, b: 20 };
  return contrast(paper, bg) >= contrast(ink, bg) ? paper : ink;
}

export function deriveThemeTokens(raw: CustomThemeSeeds): DerivedTheme {
  const warnings: string[] = [];
  const seeds = normalizeCustomTheme(raw) ?? DEFAULT_CUSTOM_THEME;
  let rail = parseHex(seeds.rail)!;
  const canvas = parseHex(seeds.canvas)!;
  const accent = parseHex(seeds.accent)!;
  const light = canvasIsLight(canvas);
  const Lc = lum(canvas);

  if (light) {
    if (lum(rail) >= Lc - 4) {
      rail = setLum(rail, Math.max(0, Lc - 10));
      warnings.push("左栏已略微调暗，才能和内容底分开");
    }
  } else if (lum(rail) >= Lc - 3) {
    rail = setLum(rail, Math.max(0, Lc - 8));
    warnings.push("左栏已略微调暗，才能和内容底分开");
  }

  const tokens = light
    ? deriveLight(rail, canvas, accent, warnings)
    : deriveDark(rail, canvas, accent);

  return {
    light,
    themeId: customThemeId(light),
    tokens,
    warnings,
  };
}

function deriveDark(rail: Rgb, canvas: Rgb, accent: Rgb): Record<CustomTokenKey, string> {
  const Lc = lum(canvas);
  const Lr = lum(rail);
  const rail2 = setLum(mixRgb(rail, canvas, 0.55), clampLum(Math.max(Lr + 4, Lc + 5)));
  const strip = setLum(canvas, clampLum(Lc + 12));
  const inset = setLum(canvas, clampLum(Lc + 22));
  const raised = setLum(canvas, clampLum(Lc + 36));
  const bubble = setLum(canvas, clampLum(Lc + 46));
  const hairline = setLum(canvas, clampLum(Lc + 28));
  const field = setLum(canvas, clampLum(Lc + 52));
  const railSel = setLum(rail, clampLum(Math.max(lum(raised) + 4, Lr + 28)));
  const segSel = setLum(rail, clampLum(lum(railSel) + 8));
  const l1 = pullContrast({ r: 233, g: 230, b: 226 }, canvas, 7, true);
  const l2 = pullContrast({ r: 189, g: 186, b: 180 }, canvas, 4.5, true);
  const l3 = pullContrast({ r: 149, g: 149, b: 154 }, canvas, 3.2, true);
  const l4 = pullContrast({ r: 107, g: 107, b: 114 }, canvas, 2.6, true);
  return finishTokens({
    light: false,
    rail,
    rail2,
    canvas,
    strip,
    inset,
    raised,
    bubble,
    hairline,
    field,
    railSel,
    segSel,
    l1,
    l2,
    l3,
    l4,
    accent,
  });
}

function deriveLight(
  rail: Rgb,
  canvas: Rgb,
  accent: Rgb,
  warnings: string[],
): Record<CustomTokenKey, string> {
  const Lc = lum(canvas);
  const room = 255 - Lc;
  if (room < 16) {
    warnings.push("画布太浅，卡片层次会比较弱");
  }
  const step = Math.max(3, Math.min(10, Math.floor(room / 4) || 3));
  const rail2 = setLum(mixRgb(rail, canvas, 0.65), clampLum(Lc + step));
  const strip = setLum(canvas, clampLum(Lc + step * 2));
  const inset = setLum(canvas, clampLum(Lc + step * 3));
  const raised = setLum(canvas, clampLum(Math.min(255, Lc + step * 4 + 2)));
  const bubble = setLum(canvas, Math.max(0, Lc - 10));
  const hairline = setLum(canvas, Math.max(0, Lc - 18));
  const field = setLum(canvas, Math.max(0, Lc - 36));
  const railSel = setLum(rail, Math.max(0, lum(rail) - 10));
  const segSel = setLum(rail, Math.max(0, lum(rail) - 22));
  const l1 = pullContrast({ r: 26, g: 24, b: 20 }, canvas, 7, false);
  const l2 = pullContrast({ r: 63, g: 60, b: 54 }, canvas, 4.5, false);
  const l3 = pullContrast({ r: 111, g: 107, b: 98 }, canvas, 4.5, false);
  const l4 = pullContrast({ r: 154, g: 149, b: 139 }, canvas, 3, false);
  return finishTokens({
    light: true,
    rail,
    rail2,
    canvas,
    strip,
    inset,
    raised,
    bubble,
    hairline,
    field,
    railSel,
    segSel,
    l1,
    l2,
    l3,
    l4,
    accent,
  });
}

function finishTokens(p: {
  light: boolean;
  rail: Rgb;
  rail2: Rgb;
  canvas: Rgb;
  strip: Rgb;
  inset: Rgb;
  raised: Rgb;
  bubble: Rgb;
  hairline: Rgb;
  field: Rgb;
  railSel: Rgb;
  segSel: Rgb;
  l1: Rgb;
  l2: Rgb;
  l3: Rgb;
  l4: Rgb;
  accent: Rgb;
}): Record<CustomTokenKey, string> {
  const cta = p.accent;
  const ctaText = pullContrast(textOn(cta), cta, 4.5, lum(textOn(cta)) > lum(cta));
  const ctaBd = setLum(cta, p.light ? Math.max(0, lum(cta) - 36) : Math.max(0, lum(cta) - 48));
  const ctaPill = p.light
    ? mixRgb(cta, { r: 255, g: 255, b: 255 }, 0.78)
    : mixRgb(cta, { r: 0, g: 0, b: 0 }, 0.72);
  const ctaPillText = pullContrast(
    p.light ? mixRgb(cta, { r: 0, g: 0, b: 0 }, 0.28) : mixRgb(cta, { r: 255, g: 255, b: 255 }, 0.4),
    ctaPill,
    4.5,
    !p.light,
  );
  const editorBg = p.light
    ? mixRgb(p.canvas, { r: 255, g: 255, b: 255 }, 0.7)
    : setLum(p.canvas, Math.max(0, lum(p.canvas) - 6));
  return {
    rail: formatHex(p.rail),
    rail2: formatHex(p.rail2),
    "rail-sel": formatHex(p.railSel),
    strip: formatHex(p.strip),
    canvas: formatHex(p.canvas),
    inset: formatHex(p.inset),
    raised: formatHex(p.raised),
    bubble: formatHex(p.bubble),
    "seg-sel": formatHex(p.segSel),
    hairline: formatHex(p.hairline),
    field: formatHex(p.field),
    l1: formatHex(p.l1),
    l2: formatHex(p.l2),
    l3: formatHex(p.l3),
    l4: formatHex(p.l4),
    cta: formatHex(cta),
    "cta-text": formatHex(ctaText),
    "cta-bd": formatHex(ctaBd),
    "nav-accent": formatHex(cta),
    "cta-pill": formatHex(ctaPill),
    "cta-pill-text": formatHex(ctaPillText),
    folder: formatHex(mixRgb(p.l3, cta, 0.22)),
    "editor-bg": formatHex(editorBg),
    "editor-fg": formatHex(p.l2),
    "editor-line": formatHex(p.l4),
    done: p.light ? "#2e7d5f" : "#47967a",
    link: p.light ? "#2470d8" : "#60a0f0",
    tabline: formatHex(p.l2),
    btn: formatHex(p.light ? p.field : p.raised),
  };
}

function clampLum(n: number): number {
  return Math.min(255, Math.max(0, n));
}

function clampByte(n: number): number {
  return Math.min(255, Math.max(0, Math.round(n)));
}

export function cssVarName(key: CustomTokenKey): string {
  return `--color-${key}`;
}

export function applyCustomThemeVars(
  el: HTMLElement,
  tokens: Record<CustomTokenKey, string>,
): void {
  for (const key of CUSTOM_TOKEN_KEYS) {
    el.style.setProperty(cssVarName(key), tokens[key]);
  }
}

export function clearCustomThemeVars(el: HTMLElement): void {
  for (const key of CUSTOM_TOKEN_KEYS) {
    el.style.removeProperty(cssVarName(key));
  }
}

export function snapshotCustomThemeVars(el: HTMLElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of CUSTOM_TOKEN_KEYS) {
    const v = el.style.getPropertyValue(cssVarName(key)).trim();
    if (v) out[key] = v;
  }
  return out;
}

export function restoreCustomThemeVars(
  el: HTMLElement,
  snap: Record<string, string>,
): void {
  clearCustomThemeVars(el);
  for (const [key, value] of Object.entries(snap)) {
    el.style.setProperty(`--color-${key}`, value);
  }
}

export function seedsFromComputed(cs: CSSStyleDeclaration): CustomThemeSeeds | null {
  return normalizeCustomTheme({
    rail: cs.getPropertyValue("--color-rail"),
    canvas: cs.getPropertyValue("--color-canvas"),
    accent: cs.getPropertyValue("--color-cta"),
  });
}

export function customXtermBgFg(tokens: Record<CustomTokenKey, string>): {
  background: string;
  foreground: string;
} {
  return { background: tokens["editor-bg"], foreground: tokens["editor-fg"] };
}

export function sanitizeCardName(raw: string, fallback: string): string {
  const t = raw.replace(/\s+/g, " ").trim();
  const src = t || fallback.replace(/\s+/g, " ").trim() || "色卡";
  return src.slice(0, CUSTOM_THEME_CARD_NAME_MAX);
}

export function nextCardName(existing: readonly { name: string }[]): string {
  const used = new Set(existing.map((c) => c.name));
  for (let i = 1; i <= CUSTOM_THEME_CARDS_MAX + 1; i++) {
    const n = `色卡 ${i}`;
    if (!used.has(n)) return n;
  }
  return "色卡";
}

export function newCardId(): string {
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 1296)
    .toString(36)
    .padStart(2, "0");
  return `c${t}${r}`;
}

export function normalizeCustomThemeCard(
  raw: Partial<CustomThemeCard> | null | undefined,
): CustomThemeCard | null {
  if (!raw || typeof raw.id !== "string") return null;
  const id = raw.id.trim();
  if (!id || id.length > 32 || !/^[a-zA-Z0-9-]+$/.test(id)) return null;
  const seeds = normalizeCustomTheme(raw);
  if (!seeds) return null;
  return {
    id,
    name: sanitizeCardName(raw.name ?? "", "色卡"),
    ...seeds,
  };
}

export function normalizeCustomThemeCards(
  list: readonly Partial<CustomThemeCard>[] | null | undefined,
): CustomThemeCard[] {
  if (!list?.length) return [];
  const out: CustomThemeCard[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const card = normalizeCustomThemeCard(raw);
    if (!card || seen.has(card.id)) continue;
    seen.add(card.id);
    out.push(card);
    if (out.length >= CUSTOM_THEME_CARDS_MAX) break;
  }
  return out;
}

export function addCustomThemeCard(
  list: readonly CustomThemeCard[],
  seeds: CustomThemeSeeds,
  name: string,
  id?: string,
):
  | { ok: true; list: CustomThemeCard[]; card: CustomThemeCard }
  | { ok: false; reason: string } {
  const normalized = normalizeCustomThemeCards(list);
  if (normalized.length >= CUSTOM_THEME_CARDS_MAX) {
    return { ok: false, reason: `最多保存 ${CUSTOM_THEME_CARDS_MAX} 套` };
  }
  const s = normalizeCustomTheme(seeds);
  if (!s) return { ok: false, reason: "颜色无效" };
  const card: CustomThemeCard = {
    id: id ?? newCardId(),
    name: sanitizeCardName(name, nextCardName(normalized)),
    ...s,
  };
  if (normalized.some((c) => c.id === card.id)) {
    return { ok: false, reason: "色卡已存在" };
  }
  return { ok: true, list: [...normalized, card], card };
}

export function removeCustomThemeCard(
  list: readonly CustomThemeCard[],
  id: string,
): CustomThemeCard[] {
  return normalizeCustomThemeCards(list).filter((c) => c.id !== id);
}

export function renameCustomThemeCard(
  list: readonly CustomThemeCard[],
  id: string,
  name: string,
): CustomThemeCard[] {
  return normalizeCustomThemeCards(list).map((c) =>
    c.id === id ? { ...c, name: sanitizeCardName(name, c.name) } : c,
  );
}

export function resolveCustomThemeCardId(
  list: readonly CustomThemeCard[],
  id: string | null | undefined,
): string | null {
  if (!id) return null;
  return list.some((c) => c.id === id) ? id : null;
}
