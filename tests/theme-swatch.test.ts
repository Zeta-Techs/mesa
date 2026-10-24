import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { THEMES } from "../src/themes.ts";
import {
  EMPTY_THEME_SWATCH,
  parseThemeSwatchesFromCss,
  themeSwatchFor,
} from "../src/theme-swatch.ts";

const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");

test("十四套主题都能从 App.css 抽到预览色", () => {
  const colors = parseThemeSwatchesFromCss(css);
  assert.equal(Object.keys(colors).length, THEMES.length);
  for (const t of THEMES) {
    const sw = colors[t.id];
    assert.ok(sw, `缺少 ${t.id}`);
    assert.match(sw.rail, /^#[0-9a-fA-F]{6}$/);
    assert.match(sw.canvas, /^#[0-9a-fA-F]{6}$/);
    assert.match(sw.accent, /^#[0-9a-fA-F]{6}$/);
    assert.match(sw.ink, /^#[0-9a-fA-F]{6}$/);
  }
});

test("沉浸黑预览色来自 @theme，不是空块", () => {
  const midnight = parseThemeSwatchesFromCss(css).midnight;
  assert.deepEqual(midnight, {
    rail: "#0c0b09",
    canvas: "#131210",
    accent: "#faa8d4",
    ink: "#e9e6e2",
  });
});

test("不把平台覆写或浅色共享段当成一套主题", () => {
  const extra = `
@theme {
  --color-rail: #111111; --color-canvas: #222222;
  --color-cta: #333333; --color-l1: #444444;
}
[data-theme="terracotta"] {
  --color-rail: #232322; --color-canvas: #2d2d2b;
  --color-cta: #cc7d5e; --color-l1: #f9f9f7;
}
[data-platform="windows"][data-theme="terracotta"] {
  --color-rail: #ffffff; --color-canvas: #ffffff;
  --color-cta: #ffffff; --color-l1: #ffffff;
}
[data-theme$="-light"] {
  --color-rail: #000000; --color-canvas: #000000;
  --color-cta: #000000; --color-l1: #000000;
}
`;
  const colors = parseThemeSwatchesFromCss(extra);
  assert.deepEqual(Object.keys(colors).sort(), ["midnight", "terracotta"]);
  assert.equal(colors.terracotta.rail, "#232322");
  assert.equal(colors.midnight.rail, "#111111");
});

test("未知 id 回落空色卡，不编造 hex", () => {
  assert.equal(themeSwatchFor("nope", {}), EMPTY_THEME_SWATCH);
});
