import { test } from "node:test";
import assert from "node:assert/strict";
import { wantsWebglRenderer, webglLetterSpacing } from "../src/terminal-renderer.ts";

test("自动档两个平台都走 WebGL，只有选「兼容（DOM）」才不走", () => {
  assert.equal(wantsWebglRenderer("auto"), true);
  assert.equal(wantsWebglRenderer(undefined), true);
  // 旧设置里显式选过的 "webgl" 与自动同义
  assert.equal(wantsWebglRenderer("webgl"), true);
  assert.equal(wantsWebglRenderer("dom"), false);
});

test("WebGL 单元格宽就近取整：小数 ≥ 0.5 补 1 个设备像素，否则不补", () => {
  // JetBrains Mono 13px 实测字宽 7.7931（WKWebView）：Retina 15.59 → 补到 16，1 倍屏 7.79 → 补到 8
  assert.equal(webglLetterSpacing(7.7931, 2), 1);
  assert.equal(webglLetterSpacing(7.7931, 1), 1);
  // SF Mono 13px 8.0361：Retina 16.07、1 倍屏 8.04，向下取整本来就最近
  assert.equal(webglLetterSpacing(8.0361, 2), 0);
  assert.equal(webglLetterSpacing(8.0361, 1), 0);
  // 量不到字宽（字体没加载、没有画布）就不动
  assert.equal(webglLetterSpacing(0, 2), 0);
  assert.equal(webglLetterSpacing(Number.NaN, 2), 0);
});
