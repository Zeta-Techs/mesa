import { test } from "node:test";
import assert from "node:assert/strict";
import { wantsWebglRenderer, webglLetterSpacing } from "../src/terminal-renderer.ts";

test("自动档：Mac 默认清晰（DOM），Gemini 标签例外走 WebGL；Windows 一律 WebGL", () => {
  const mac = (agentId: string | undefined) =>
    wantsWebglRenderer({ setting: "auto", isMac: true, agentId });
  assert.equal(mac("claude-code"), false);
  assert.equal(mac(undefined), false); // shell / 还没选 agent
  assert.equal(mac("gemini"), true);
  assert.equal(
    wantsWebglRenderer({ setting: undefined, isMac: true, agentId: "gemini" }),
    true,
  );
  assert.equal(
    wantsWebglRenderer({ setting: "auto", isMac: false, agentId: "claude-code" }),
    true,
  );
});

test("用户显式选的档位不被 agent 覆盖", () => {
  assert.equal(
    wantsWebglRenderer({ setting: "dom", isMac: true, agentId: "gemini" }),
    false,
  );
  assert.equal(
    wantsWebglRenderer({ setting: "dom", isMac: false, agentId: "gemini" }),
    false,
  );
  assert.equal(
    wantsWebglRenderer({ setting: "webgl", isMac: true, agentId: "codex" }),
    true,
  );
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
