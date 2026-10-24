import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEFAULT_NAV_CAPSULE_VISIBLE_ITEMS,
  INITIAL_NAV_ISLAND,
  NAV_CAPSULE_DELAYS,
  isIslandExpanded,
  isNavCapsuleItemVisible,
  NAV_CAPSULE_ITEM_IDS,
  reconcileIsland,
  cycleBrandState,
  enterChromeHidden,
  exitChromeHidden,
  normalizeNavCapsuleDisplayMode,
  normalizeNavCapsuleVisibleItems,
  normalizeNavCapsuleDelay,
  resolveStartupNavMode,
  toggleChromeHiddenState,
} from "../src/nav-capsule.ts";

test("brand button toggles expanded ↔ collapsed without entering hidden", () => {
  const expanded = {
    navCollapsed: false,
    chromeHidden: false,
    chromeHiddenReturnCollapsed: null,
  };
  const collapsed = cycleBrandState(expanded);
  assert.deepEqual(collapsed, { ...expanded, navCollapsed: true });
  assert.deepEqual(cycleBrandState(collapsed), expanded);
  assert.equal(cycleBrandState(collapsed).chromeHidden, false);
});

test("direct hidden toggle snapshots expanded state too", () => {
  const state = {
    navCollapsed: false,
    chromeHidden: false,
    chromeHiddenReturnCollapsed: null,
  };
  const hidden = toggleChromeHiddenState(state);
  assert.equal(hidden.chromeHidden, true);
  assert.equal(hidden.chromeHiddenReturnCollapsed, false);
  assert.deepEqual(toggleChromeHiddenState(hidden), state);
});

test("startup mode respects legacy preference when absent", () => {
  assert.equal(resolveStartupNavMode(undefined, false), "expanded");
  assert.equal(resolveStartupNavMode(undefined, true), "collapsed");
  assert.equal(resolveStartupNavMode("hidden", false), "hidden");
  assert.equal(resolveStartupNavMode("unknown", true), "collapsed");
});

test("capsule delay accepts only supported values", () => {
  assert.deepEqual(NAV_CAPSULE_DELAYS, [0, 500, 1000, 2000, 5000]);
  assert.equal(normalizeNavCapsuleDelay(0), 0);
  assert.equal(normalizeNavCapsuleDelay(500), 500);
  assert.equal(normalizeNavCapsuleDelay(999), 1000);
  assert.equal(normalizeNavCapsuleDelay("2000"), 1000);
  // 未设置与非法值都落到 1 秒，不会因为 0 是可选项而把"没配"读成"立即"
  assert.equal(normalizeNavCapsuleDelay(undefined), 1000);
  assert.equal(normalizeNavCapsuleDelay(null), 1000);
});

test("entering hidden twice does not overwrite restore snapshot", () => {
  const first = enterChromeHidden({
    navCollapsed: true,
    chromeHidden: false,
    chromeHiddenReturnCollapsed: null,
  });
  assert.deepEqual(
    enterChromeHidden({ ...first, navCollapsed: false }),
    { ...first, navCollapsed: false },
  );
});

test("capsule display mode defaults to both and accepts only supported values", () => {
  assert.equal(normalizeNavCapsuleDisplayMode(undefined), "both");
  assert.equal(normalizeNavCapsuleDisplayMode("icons"), "icons");
  assert.equal(normalizeNavCapsuleDisplayMode("labels"), "labels");
  assert.equal(normalizeNavCapsuleDisplayMode("text"), "both");
});

test("capsule visible items default to all and filter unknown ids", () => {
  assert.deepEqual(
    normalizeNavCapsuleVisibleItems(undefined),
    DEFAULT_NAV_CAPSULE_VISIBLE_ITEMS,
  );
  assert.deepEqual(
    normalizeNavCapsuleVisibleItems(["workbench", "unknown", 3, "settings"]),
    ["workbench", "settings"],
  );
  assert.deepEqual(normalizeNavCapsuleVisibleItems([]), []);
});

test("hidden current page remains temporarily visible", () => {
  assert.equal(isNavCapsuleItemVisible("workbench", "workbench", []), true);
  assert.equal(isNavCapsuleItemVisible("workbench", "settings", []), false);
  assert.equal(isNavCapsuleItemVisible("settings", "workbench", ["settings"]), true);
});

test("「运行」不上岛（2026-10-24）：不在可配名单里，正在运行页、存过旧名单都不显示", () => {
  assert.ok(!(NAV_CAPSULE_ITEM_IDS as readonly string[]).includes("terminal"));
  assert.equal(isNavCapsuleItemVisible("terminal", "terminal", ["terminal"]), false);
  assert.deepEqual(normalizeNavCapsuleVisibleItems(["workbench", "terminal"]), ["workbench"]);
});

/* --- 完全隐藏侧栏时的顶部灵动岛状态机 --- */

test("island starts dormant with no transient flags", () => {
  assert.deepEqual(INITIAL_NAV_ISLAND, {
    phase: "dormant",
    pointerInside: false,
    focused: false,
  });
});

test("pointer enter and focus both expand the island", () => {
  assert.equal(reconcileIsland(INITIAL_NAV_ISLAND, "pointer-enter").phase, "expanded");
  assert.equal(reconcileIsland(INITIAL_NAV_ISLAND, "focus").phase, "expanded");
});

test("delay-expired collapses only after both pointer and focus leave", () => {
  // 悬停中到点：不收
  const hovering = reconcileIsland(INITIAL_NAV_ISLAND, "pointer-enter");
  assert.deepEqual(reconcileIsland(hovering, "delay-expired"), hovering);

  // 指针离开但焦点还在：仍不收（否则 Tab 焦点会落进被遮住的页面）
  const focused = reconcileIsland(hovering, "focus");
  const afterLeave = reconcileIsland(focused, "pointer-leave");
  assert.equal(afterLeave.phase, "expanded");
  assert.equal(reconcileIsland(afterLeave, "delay-expired").phase, "expanded");

  // 两者都离开：收起
  const blur = reconcileIsland(afterLeave, "blur");
  assert.equal(reconcileIsland(blur, "delay-expired").phase, "dormant");
});

test("pointer re-entry during the wait period keeps the island open", () => {
  const armed = reconcileIsland(
    reconcileIsland(INITIAL_NAV_ISLAND, "pointer-enter"),
    "pointer-leave",
  );
  // 等待期内重新指向：回到 expanded，随后的 delay-expired 不再应收
  const back = reconcileIsland(armed, "pointer-enter");
  assert.equal(back.phase, "expanded");
  assert.deepEqual(reconcileIsland(back, "delay-expired"), back);
});

test("close drops back to the initial island state immediately", () => {
  const open = reconcileIsland(
    reconcileIsland(INITIAL_NAV_ISLAND, "pointer-enter"),
    "focus",
  );
  assert.deepEqual(reconcileIsland(open, "close"), INITIAL_NAV_ISLAND);
});

test("isIslandExpanded treats focus and hover as one judgement", () => {
  assert.equal(isIslandExpanded(INITIAL_NAV_ISLAND), false);
  assert.equal(isIslandExpanded({ ...INITIAL_NAV_ISLAND, focused: true }), true);
  assert.equal(isIslandExpanded({ ...INITIAL_NAV_ISLAND, pointerInside: true }), true);
});

/* 灵动岛：休眠＝状态、展开＝操作（2026-10-17）。休眠面切出来单独断言，
   防止有人把可点控件塞回休眠面——指针一进岛就展开，休眠面里的按钮鼠标点不到。 */
function islandFaces() {
  const src = readFileSync(
    new URL("../src/components/TopNavCapsule.tsx", import.meta.url),
    "utf8",
  );
  const dormant = /ref=\{dormantRowRef\}([\s\S]*?)ref=\{expandedRowRef\}/.exec(src);
  const expanded = /ref=\{expandedRowRef\}([\s\S]*?)<\/nav>/.exec(src);
  assert.ok(dormant && expanded, "找不到休眠面/展开面，可能改了结构");
  return { dormant: dormant[1], expanded: expanded[1] };
}

test("休眠面报当前页且恒带文字（不走受 displayMode 影响的 itemContent）", () => {
  const { dormant } = islandFaces();
  // 报页名（「搜对话」那一页报「对话」），没有页名的报入口名
  assert.match(dormant, /<span>\{currentNav\?\.page \?\? currentNav\?\.label \?\? "Mesa"\}<\/span>/);
  assert.doesNotMatch(dormant, /itemContent\(/);
});

test("休眠面只放展示：恢复侧栏、可点活动胶囊都在展开面", () => {
  const { dormant, expanded } = islandFaces();
  assert.doesNotMatch(dormant, /restoreItem\(/, "恢复侧栏不放休眠面");
  assert.doesNotMatch(dormant, /<RunActivityButton/, "休眠面用只读 RunActivityStatus");
  assert.match(dormant, /<RunActivityStatus \/>/);
  assert.match(dormant, /announceItem\(false\)/, "休眠面播报是只读那一份");
  assert.match(expanded, /restoreItem\(expanded\)/);
  assert.match(expanded, /<RunActivityButton variant="island"/);
});

test("当前页标签是一枚带字的胶囊，不是一枚方图标", () => {
  const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
  const current = /\.ccode-nav-island-current\s*\{[^}]*\}/.exec(css);
  assert.ok(current, "找不到 .ccode-nav-island-current 规则");
  // 带字后 7px 横内距贴在字上会显挤，需要比导航项宽一点
  assert.match(current[0], /padding:\s*0 9px/);
});
