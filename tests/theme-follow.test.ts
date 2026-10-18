import assert from "node:assert/strict";
import test from "node:test";
import { followedTheme, themeTwin } from "../src/theme-follow.ts";
import { THEMES } from "../src/themes.ts";

test("十四套内置主题两两成对：深色的 twin 是浅色，浅色的 twin 是深色", () => {
  for (const t of THEMES) {
    const light = "light" in t && t.light;
    const other = themeTwin(t.id, !light);
    assert.ok(other, `${t.id} 找不到成对的另一套`);
    assert.equal(themeTwin(other, !!light), t.id, `${t.id} ↔ ${other} 不可逆`);
  }
});

test("跟随系统：按系统深浅取同名那套，已经对了就原样", () => {
  assert.equal(followedTheme("terracotta", false), "terracotta-light");
  assert.equal(followedTheme("terracotta-light", true), "terracotta");
  assert.equal(followedTheme("ayu", true), "ayu");
  assert.equal(followedTheme("ayu-light", false), "ayu-light");
});

test("自定义配色与未知 id 不跟随", () => {
  assert.equal(followedTheme("custom", false), "custom");
  assert.equal(followedTheme("custom-light", true), "custom-light");
  assert.equal(followedTheme("no-such-theme", false), "no-such-theme");
  assert.equal(themeTwin("custom", true), null);
  assert.equal(followedTheme(undefined, true), "midnight");
});
