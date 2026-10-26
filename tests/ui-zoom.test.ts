import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  formatUiZoom,
  normalizeUiZoom,
  stepUiZoom,
  uiZoomKeyDirection,
  UI_ZOOM_DEFAULT,
  UI_ZOOM_STEPS,
} from "../src/ui-zoom.ts";
import { watchDevicePixelRatio, type DprWindow } from "../src/device-pixel-ratio.ts";

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; code: string }> = {}) => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  key: k,
  ...mods,
});

test("界面缩放：存量值归最近一档，坏值回 100%", () => {
  assert.equal(normalizeUiZoom(1.24), 1.25);
  assert.equal(normalizeUiZoom(0.5), 0.8);
  assert.equal(normalizeUiZoom(9), 1.5);
  assert.equal(normalizeUiZoom(undefined), UI_ZOOM_DEFAULT);
  assert.equal(normalizeUiZoom(Number.NaN), UI_ZOOM_DEFAULT);
  assert.equal(normalizeUiZoom("1.1"), UI_ZOOM_DEFAULT);
});

test("界面缩放：一次挪一档，到头不动", () => {
  assert.equal(stepUiZoom(1, 1), 1.1);
  assert.equal(stepUiZoom(1.1, 1), 1.25);
  assert.equal(stepUiZoom(1, -1), 0.9);
  assert.equal(stepUiZoom(1.5, 1), 1.5);
  assert.equal(stepUiZoom(0.8, -1), 0.8);
  assert.equal(formatUiZoom(1.25), "125%");
});

test("界面缩放：档位两端与 Rust ui_zoom 的范围一致", () => {
  const rs = readFileSync(new URL("../src-tauri/src/ui_zoom.rs", import.meta.url), "utf8");
  const min = Number(/pub const MIN_ZOOM: f64 = ([\d.]+);/.exec(rs)?.[1]);
  const max = Number(/pub const MAX_ZOOM: f64 = ([\d.]+);/.exec(rs)?.[1]);
  assert.equal(UI_ZOOM_STEPS[0], min);
  assert.equal(UI_ZOOM_STEPS[UI_ZOOM_STEPS.length - 1], max);
});

test("界面缩放快捷键：mod + = / + / - 与小键盘，Alt 与无修饰键不算", () => {
  assert.equal(uiZoomKeyDirection(key("=", { metaKey: true })), 1);
  assert.equal(uiZoomKeyDirection(key("+", { ctrlKey: true })), 1);
  assert.equal(uiZoomKeyDirection(key("+", { ctrlKey: true, code: "NumpadAdd" })), 1);
  assert.equal(uiZoomKeyDirection(key("-", { metaKey: true })), -1);
  assert.equal(uiZoomKeyDirection(key("Subtract", { ctrlKey: true, code: "NumpadSubtract" })), -1);
  assert.equal(uiZoomKeyDirection(key("=")), null);
  assert.equal(uiZoomKeyDirection(key("=", { metaKey: true, altKey: true })), null);
  // ⌘0 是「光标移到侧栏」，不当复位
  assert.equal(uiZoomKeyDirection(key("0", { metaKey: true })), null);
});

/** 假窗口：媒体查询按建时的像素比记住，像 WKWebView 那样缩放后不发 change */
function fakeWindow(dpr: number) {
  const resize = new Set<() => void>();
  const queries: { query: string; listeners: Set<() => void> }[] = [];
  const win = {
    devicePixelRatio: dpr,
    matchMedia(query: string) {
      const q = { query, listeners: new Set<() => void>() };
      queries.push(q);
      return {
        addEventListener: (_: string, l: () => void) => q.listeners.add(l),
        removeEventListener: (_: string, l: () => void) => q.listeners.delete(l),
      };
    },
    addEventListener: (_: string, l: () => void) => resize.add(l),
    removeEventListener: (_: string, l: () => void) => resize.delete(l),
  };
  return { win: win as unknown as DprWindow & { devicePixelRatio: number }, resize, queries };
}

test("像素比监听：缩放只发 resize 也能接住，值没变不回调", () => {
  const { win, resize } = fakeWindow(2);
  const seen: number[] = [];
  const stop = watchDevicePixelRatio((d) => seen.push(d), win);
  resize.forEach((l) => l()); // 只是改窗口大小
  assert.deepEqual(seen, []);
  win.devicePixelRatio = 2.5; // ⌘= 后 WKWebView 只发 resize
  resize.forEach((l) => l());
  assert.deepEqual(seen, [2.5]);
  stop();
  assert.equal(resize.size, 0);
});

test("像素比监听：换屏走媒体查询，之后按新值重建查询", () => {
  const { win, queries } = fakeWindow(2);
  const seen: number[] = [];
  const stop = watchDevicePixelRatio((d) => seen.push(d), win);
  win.devicePixelRatio = 1;
  [...queries[0].listeners].forEach((l) => l());
  assert.deepEqual(seen, [1]);
  assert.equal(queries[0].listeners.size, 0);
  assert.equal(queries.at(-1)?.query, "(resolution: 1dppx)");
  assert.equal(queries.at(-1)?.listeners.size, 1);
  stop();
  assert.equal(queries.at(-1)?.listeners.size, 0);
});
