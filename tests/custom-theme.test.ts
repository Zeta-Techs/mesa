import assert from "node:assert/strict";
import test from "node:test";
import {
  addCustomThemeCard,
  canvasIsLight,
  chipInk,
  contrast,
  CUSTOM_THEME_CARDS_MAX,
  customThemeIdFromSeeds,
  DEFAULT_CUSTOM_THEME,
  deriveThemeTokens,
  formatHex,
  lum,
  nextCardName,
  normalizeCustomTheme,
  normalizeCustomThemeCards,
  normalizeHex,
  monacoEditorColors,
  parseHex,
  relLum,
  removeCustomThemeCard,
  renameCustomThemeCard,
  resolveCustomThemeCardId,
  sanitizeCardName,
} from "../src/custom-theme.ts";

function rgb(hex: string) {
  const c = parseHex(hex);
  assert.ok(c, hex);
  return c;
}

test("parseHex / normalizeHex：#rgb、#rrggbb、rgb()、非法", () => {
  assert.deepEqual(parseHex("#abc"), { r: 170, g: 187, b: 204 });
  assert.equal(normalizeHex("#ABC"), "#aabbcc");
  assert.equal(normalizeHex("0a0b0e"), "#0a0b0e");
  assert.equal(normalizeHex("rgb(10, 11, 14)"), "#0a0b0e");
  assert.equal(normalizeHex("nope"), null);
  assert.equal(normalizeHex(""), null);
  assert.equal(formatHex({ r: 250, g: 168, b: 212 }), "#faa8d4");
});

test("Monaco 面色一律给 #rrggbb：打包压缩成 #fff/#111 的令牌也要展开，认不出用兜底", () => {
  const tokens: Record<string, string> = {
    "--color-editor-bg": " #fff",
    "--color-editor-fg": "#111",
    "--color-editor-line": "var(--x)",
  };
  const colors = monacoEditorColors((name) => tokens[name] ?? "");
  assert.deepEqual(colors, {
    "editor.background": "#ffffff",
    "editor.foreground": "#111111",
    "editorLineNumber.foreground": "#525a6b",
  });
  for (const v of Object.values(colors)) assert.match(v, /^#[0-9a-f]{6}$/);
});

test("normalizeCustomTheme：三色齐且合法才过", () => {
  assert.equal(normalizeCustomTheme(null), null);
  assert.equal(normalizeCustomTheme({ rail: "#111", canvas: "xyz", accent: "#f00" }), null);
  assert.deepEqual(normalizeCustomTheme({ rail: "#111", canvas: "#222", accent: "#f00" }), {
    rail: "#111111",
    canvas: "#222222",
    accent: "#ff0000",
  });
});

test("沉浸黑三色派生为深色，画布保持用户值，文字可读", () => {
  const d = deriveThemeTokens(DEFAULT_CUSTOM_THEME);
  assert.equal(d.light, false);
  assert.equal(d.themeId, "custom");
  assert.equal(d.tokens.canvas, "#131210");
  assert.equal(d.tokens.cta, "#faa8d4");
  assert.ok(lum(rgb(d.tokens.rail)) < lum(rgb(d.tokens.canvas)));
  assert.ok(contrast(rgb(d.tokens.l1), rgb(d.tokens.canvas)) >= 7);
  assert.ok(contrast(rgb(d.tokens.l2), rgb(d.tokens.canvas)) >= 4.5);
  assert.ok(contrast(rgb(d.tokens["cta-text"]), rgb(d.tokens.cta)) >= 4.5);
  assert.ok(lum(rgb(d.tokens.strip)) > lum(rgb(d.tokens.canvas)));
  assert.ok(lum(rgb(d.tokens.inset)) > lum(rgb(d.tokens.strip)));
  assert.ok(lum(rgb(d.tokens.raised)) > lum(rgb(d.tokens.inset)));
});

test("浅色纸面派生：rail < canvas < rail2 < strip < inset < raised，选中/线条更深", () => {
  const d = deriveThemeTokens({
    rail: "#e5e5dd",
    canvas: "#edede9",
    accent: "#c2447f",
  });
  assert.equal(d.light, true);
  assert.equal(d.themeId, "custom-light");
  const t = d.tokens;
  const order = ["rail", "canvas", "rail2", "strip", "inset", "raised"] as const;
  for (let i = 0; i < order.length - 1; i++) {
    assert.ok(
      lum(rgb(t[order[i]])) < lum(rgb(t[order[i + 1]])),
      `${order[i]} 应比 ${order[i + 1]} 暗`,
    );
  }
  for (let i = 1; i < 4; i++) {
    const step = lum(rgb(t[order[i + 1]])) - lum(rgb(t[order[i]]));
    assert.ok(step >= 3, `${order[i]}→${order[i + 1]} 只差 ${step.toFixed(1)}`);
  }
  assert.ok(lum(rgb(t["rail-sel"])) < lum(rgb(t.rail)));
  assert.ok(lum(rgb(t.hairline)) < lum(rgb(t.canvas)));
  assert.ok(lum(rgb(t.field)) < lum(rgb(t.hairline)));
  assert.ok(lum(rgb(t.bubble)) < lum(rgb(t.canvas)));
  assert.ok(contrast(rgb(t.l1), rgb(t.canvas)) >= 7);
  assert.ok(contrast(rgb(t.l2), rgb(t.canvas)) >= 4.5);
  assert.ok(contrast(rgb(t.l3), rgb(t.canvas)) >= 4.5);
  assert.ok(contrast(rgb(t["cta-text"]), rgb(t.cta)) >= 4.5);
});

test("左栏和画布同色时自动拉开，并给警告", () => {
  const d = deriveThemeTokens({
    rail: "#101218",
    canvas: "#101218",
    accent: "#faa8d4",
  });
  assert.ok(lum(rgb(d.tokens.rail)) < lum(rgb(d.tokens.canvas)) - 2);
  assert.ok(d.warnings.some((w) => w.includes("左栏")));
});

test("高饱和黄强调色仍有可读按钮字", () => {
  const d = deriveThemeTokens({
    rail: "#0a0b0e",
    canvas: "#101218",
    accent: "#ffe100",
  });
  assert.ok(contrast(rgb(d.tokens["cta-text"]), rgb(d.tokens.cta)) >= 4.5);
});

test("近白画布标浅色并警告层次弱，画布值不改", () => {
  const d = deriveThemeTokens({
    rail: "#f0f0f0",
    canvas: "#fcfcfc",
    accent: "#0169cc",
  });
  assert.equal(d.light, true);
  assert.equal(d.tokens.canvas, "#fcfcfc");
  assert.ok(d.warnings.some((w) => w.includes("太浅") || w.includes("左栏")));
  assert.ok(contrast(rgb(d.tokens.l1), rgb(d.tokens.canvas)) >= 7);
});

test("chipInk：亮底深字、暗底浅字", () => {
  assert.equal(chipInk("#f2ece7"), "#1a1814");
  assert.equal(chipInk("#0a0b0e"), "#f4f1ec");
});

test("sanitizeCardName / nextCardName：空白回落、跳过已用序号", () => {
  assert.equal(sanitizeCardName("  实验  一  ", "色卡"), "实验 一");
  assert.equal(sanitizeCardName("   ", "色卡 2"), "色卡 2");
  assert.equal(sanitizeCardName("一二三四五六七八九十一二多余", "色卡").length, 12);
  assert.equal(nextCardName([]), "色卡 1");
  assert.equal(nextCardName([{ name: "色卡 1" }, { name: "色卡 3" }]), "色卡 2");
});

test("另存色卡：校验、上限、改名、删除、选中失效", () => {
  const seeds = DEFAULT_CUSTOM_THEME;
  const a = addCustomThemeCard([], seeds, "  实验室  ", "c1");
  assert.equal(a.ok, true);
  if (!a.ok) return;
  assert.equal(a.card.name, "实验室");
  assert.equal(a.list.length, 1);
  const dup = addCustomThemeCard(a.list, seeds, "二", "c1");
  assert.equal(dup.ok, false);
  const b = addCustomThemeCard(a.list, seeds, "", "c2");
  assert.equal(b.ok, true);
  if (!b.ok) return;
  assert.equal(b.card.name, "色卡 1");
  const renamed = renameCustomThemeCard(b.list, "c1", "新名");
  assert.equal(renamed.find((c) => c.id === "c1")?.name, "新名");
  const removed = removeCustomThemeCard(renamed, "c1");
  assert.deepEqual(
    removed.map((c) => c.id),
    ["c2"],
  );
  assert.equal(resolveCustomThemeCardId(removed, "c1"), null);
  assert.equal(resolveCustomThemeCardId(removed, "c2"), "c2");
  const full = Array.from({ length: CUSTOM_THEME_CARDS_MAX }, (_, i) => ({
    id: `c${i}`,
    name: `色卡 ${i + 1}`,
    ...seeds,
  }));
  const overflow = addCustomThemeCard(full, seeds, "满", "cx");
  assert.equal(overflow.ok, false);
  assert.equal(normalizeCustomThemeCards([{ id: "bad id", ...seeds }]).length, 0);
});

test("canvasIsLight / customThemeIdFromSeeds 跟画布走", () => {
  assert.equal(canvasIsLight(rgb("#101218")), false);
  assert.equal(canvasIsLight(rgb("#edede9")), true);
  assert.ok(relLum(rgb("#edede9")) > 0.7);
  assert.equal(
    customThemeIdFromSeeds({ rail: "#111", canvas: "#eee", accent: "#f00" }),
    "custom-light",
  );
  assert.equal(customThemeIdFromSeeds(DEFAULT_CUSTOM_THEME), "custom");
});
