import assert from "node:assert/strict";
import test from "node:test";
import {
  isBrowserShortcut,
  isNavigationMouseButton,
  isWindows11PlatformVersion,
  keepNativeContextMenu,
} from "../src/windows-shell.ts";

const k = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

test("拦下刷新 / 打印 / 查找条 / 后退前进", () => {
  for (const e of [
    k("F5"),
    k("r", { ctrlKey: true }),
    k("R", { ctrlKey: true, shiftKey: true }),
    k("p", { ctrlKey: true }),
    k("f", { ctrlKey: true }),
    k("ArrowLeft", { altKey: true }),
    k("ArrowRight", { altKey: true }),
    k("BrowserBack"),
  ])
    assert.ok(isBrowserShortcut(e), JSON.stringify(e));
});

test("普通输入与应用快捷键放行", () => {
  for (const e of [
    k("r"),
    k("k", { ctrlKey: true }),
    k("c", { ctrlKey: true }),
    k("v", { ctrlKey: true }),
    k("ArrowLeft"),
    k("ArrowLeft", { ctrlKey: true }),
    k("r", { ctrlKey: true, altKey: true }),
  ])
    assert.ok(!isBrowserShortcut(e), JSON.stringify(e));
});

test("鼠标侧键算导航", () => {
  assert.ok(isNavigationMouseButton(3));
  assert.ok(isNavigationMouseButton(4));
  assert.ok(!isNavigationMouseButton(0));
  assert.ok(!isNavigationMouseButton(2));
});

test("右键菜单：只在空白处拦，输入框 / 选中文字 / 应用自绘菜单放行", () => {
  assert.ok(!keepNativeContextMenu({ defaultPrevented: false, editable: false, hasSelection: false }));
  assert.ok(keepNativeContextMenu({ defaultPrevented: true, editable: false, hasSelection: false }));
  assert.ok(keepNativeContextMenu({ defaultPrevented: false, editable: true, hasSelection: false }));
  assert.ok(keepNativeContextMenu({ defaultPrevented: false, editable: false, hasSelection: true }));
});

test("Windows 11 判定按 UA-CH 主版本", () => {
  assert.ok(isWindows11PlatformVersion("15.0.0"));
  assert.ok(isWindows11PlatformVersion("13.0.0"));
  assert.ok(!isWindows11PlatformVersion("10.0.0"));
  assert.ok(!isWindows11PlatformVersion("0.3.0"));
  assert.ok(!isWindows11PlatformVersion(""));
});
