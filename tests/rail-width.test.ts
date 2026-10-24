import assert from "node:assert/strict";
import test from "node:test";
import { clampRailWidth, parseRailWidth, RAIL_DEFAULT_REM } from "../src/rail-width.ts";

test("侧栏宽度：14–26rem，按根字号算；窗口小时上限收到窗口宽的 40%", () => {
  assert.equal(clampRailWidth(100, 14), 196);
  assert.equal(clampRailWidth(900, 14), 364);
  assert.equal(clampRailWidth(300, 16), 300);
  assert.equal(clampRailWidth(360, 14, 800), 320, "800 宽的窗口最多 320");
  assert.equal(clampRailWidth(360, 14, 300), 196, "窗口再小也不窄过下限");
});

test("存档读回：坏值、没存过都回默认宽", () => {
  assert.equal(parseRailWidth(null, 14), RAIL_DEFAULT_REM * 14);
  assert.equal(parseRailWidth("abc", 14), RAIL_DEFAULT_REM * 14);
  assert.equal(parseRailWidth("280", 14), 280);
  assert.equal(parseRailWidth("9999", 14), 364);
});
