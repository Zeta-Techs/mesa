/**
 * 文件预览编辑器字号（2026-10-26：原先固定 12.5 不能调）。存在本机，所有开着的编辑器一起变。
 */

export const EDITOR_FONT_DEFAULT = 12.5;
export const EDITOR_FONT_MIN = 10;
export const EDITOR_FONT_MAX = 22;
const KEY = "ccode.editorFontSize";
const EVENT = "ccode-editor-font";

export function clampEditorFont(v: number): number {
  if (!Number.isFinite(v)) return EDITOR_FONT_DEFAULT;
  return Math.min(EDITOR_FONT_MAX, Math.max(EDITOR_FONT_MIN, Math.round(v * 2) / 2));
}

/** 放大 / 缩小一档（1 像素一档） */
export function stepEditorFont(current: number, delta: 1 | -1): number {
  return clampEditorFont(current + delta);
}

export function readEditorFont(): number {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    return raw ? clampEditorFont(Number(raw)) : EDITOR_FONT_DEFAULT;
  } catch {
    return EDITOR_FONT_DEFAULT;
  }
}

export function writeEditorFont(v: number): number {
  const next = clampEditorFont(v);
  try {
    if (next === EDITOR_FONT_DEFAULT) globalThis.localStorage?.removeItem(KEY);
    else globalThis.localStorage?.setItem(KEY, String(next));
  } catch {
    /* 存不了就只改这一次 */
  }
  globalThis.dispatchEvent?.(new CustomEvent(EVENT, { detail: next }));
  return next;
}

/** 订阅字号变化（别的预览里改了，这里一起变）；返回取消订阅 */
export function onEditorFontChange(fn: (size: number) => void): () => void {
  const handler = (e: Event) => fn((e as CustomEvent<number>).detail);
  globalThis.addEventListener?.(EVENT, handler);
  return () => globalThis.removeEventListener?.(EVENT, handler);
}

// ---------- Markdown 阅读视图字号（2026-11-23 用户：加一个字号调整的按钮） ----------

export const READ_FONT_DEFAULT = 15;
export const READ_FONT_MIN = 12;
export const READ_FONT_MAX = 24;
const READ_KEY = "ccode.mdReadingFontSize";
const READ_EVENT = "ccode-reading-font";

export function clampReadingFont(v: number): number {
  if (!Number.isFinite(v)) return READ_FONT_DEFAULT;
  return Math.min(READ_FONT_MAX, Math.max(READ_FONT_MIN, Math.round(v * 2) / 2));
}

export function stepReadingFont(current: number, delta: 1 | -1): number {
  return clampReadingFont(current + delta);
}

export function readReadingFont(): number {
  try {
    const raw = globalThis.localStorage?.getItem(READ_KEY);
    return raw ? clampReadingFont(Number(raw)) : READ_FONT_DEFAULT;
  } catch {
    return READ_FONT_DEFAULT;
  }
}

export function writeReadingFont(v: number): number {
  const next = clampReadingFont(v);
  try {
    if (next === READ_FONT_DEFAULT) globalThis.localStorage?.removeItem(READ_KEY);
    else globalThis.localStorage?.setItem(READ_KEY, String(next));
  } catch {
    /* 存不了就只改这一次 */
  }
  globalThis.dispatchEvent?.(new CustomEvent(READ_EVENT, { detail: next }));
  return next;
}

export function onReadingFontChange(fn: (size: number) => void): () => void {
  const handler = (e: Event) => fn((e as CustomEvent<number>).detail);
  globalThis.addEventListener?.(READ_EVENT, handler);
  return () => globalThis.removeEventListener?.(READ_EVENT, handler);
}
