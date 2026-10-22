import assert from "node:assert/strict";
import test from "node:test";
import {
  PALETTE_LIST,
  PALETTE_TWIN,
  XTERM_PALETTES,
  isLightPalette,
  resolvePaletteId,
} from "../src/terminal-palettes.ts";
import { THEMES, isLightTheme } from "../src/themes.ts";

const ANSI_KEYS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
  "cursor", "selectionBackground",
] as const;

test("每套调色板都补齐 16 色 + 光标 + 选区", () => {
  for (const p of PALETTE_LIST) {
    const palette = XTERM_PALETTES[p.id];
    assert.ok(palette, `缺调色板 ${p.id}`);
    for (const k of ANSI_KEYS) {
      assert.match(
        palette[k] ?? "",
        /^#[0-9a-f]{6}$/i,
        `${p.id}.${k} 不是合法色值`,
      );
    }
  }
});

test("深浅 twin 双向成对且亮暗相反", () => {
  for (const [id, twin] of Object.entries(PALETTE_TWIN)) {
    assert.ok(XTERM_PALETTES[twin], `${id} 的 twin ${twin} 不存在`);
    assert.equal(PALETTE_TWIN[twin], id, `${id} ↔ ${twin} 不是双向映射`);
    assert.notEqual(isLightPalette(id), isLightPalette(twin));
  }
  // 每套都必须有 twin，否则浅色主题下会回落到默认套而不是同性格那套
  for (const p of PALETTE_LIST) {
    assert.ok(PALETTE_TWIN[p.id], `${p.id} 没有配对 twin`);
  }
});

test("亮暗匹配时原样返回", () => {
  assert.equal(resolvePaletteId("dark-plus", false), "dark-plus");
  assert.equal(resolvePaletteId("latte", true), "latte");
});

test("亮暗不符时换到 twin", () => {
  // 浅色主题 + 深色向预设 → 换浅色 twin（原本会让 white/brightWhite 在近白底上隐形）
  assert.equal(resolvePaletteId("dark-plus", true), "light-plus");
  assert.equal(resolvePaletteId("catppuccin", true), "latte");
  assert.equal(resolvePaletteId("solarized", true), "solarized-light");
  assert.equal(resolvePaletteId("one-dark", true), "one-light");
  // 反向同理
  assert.equal(resolvePaletteId("light-plus", false), "dark-plus");
  assert.equal(resolvePaletteId("latte", false), "catppuccin");
});

test("缺省/未知 id 回落到对应亮暗档的默认套", () => {
  assert.equal(resolvePaletteId(undefined, false), "one-dark");
  assert.equal(resolvePaletteId(undefined, true), "light-plus");
  assert.equal(resolvePaletteId("不存在的调色板", false), "one-dark");
  assert.equal(resolvePaletteId("不存在的调色板", true), "light-plus");
  assert.equal(resolvePaletteId("", true), "light-plus");
});

test("跟随主题（没选过 / auto）：深色 One Dark、暮紫 Catppuccin、浅色一律 Light+", () => {
  assert.equal(resolvePaletteId("auto", false, "ayu"), "one-dark");
  assert.equal(resolvePaletteId(undefined, false, "mocha"), "catppuccin");
  assert.equal(resolvePaletteId("auto", true, "mocha-light"), "light-plus");
  assert.equal(resolvePaletteId("auto", true, "ayu-light"), "light-plus");
  // 手动选过的照旧，不被主题默认覆盖
  assert.equal(resolvePaletteId("dark-plus", false, "mocha"), "dark-plus");
});

test("十四套主题都能解析出与自身亮暗一致的调色板", () => {
  for (const t of THEMES) {
    const light = isLightTheme(t.id);
    for (const p of PALETTE_LIST) {
      assert.equal(
        isLightPalette(resolvePaletteId(p.id, light)),
        light,
        `主题 ${t.id} + 调色板 ${p.id} 解析结果亮暗不符`,
      );
    }
  }
});

test("isLightTheme 覆盖七套浅色、不误判深色", () => {
  assert.equal(THEMES.filter((t) => isLightTheme(t.id)).length, 7);
  assert.equal(isLightTheme("midnight"), false);
  assert.equal(isLightTheme("midnight-light"), true);
  assert.equal(isLightTheme("custom"), false);
  assert.equal(isLightTheme("custom-light"), true);
  assert.equal(isLightTheme(undefined), false);
  assert.equal(isLightTheme("不存在的主题"), false);
});
