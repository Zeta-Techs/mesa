import assert from "node:assert/strict";
import test from "node:test";
import {
  captureDecision,
  comboFromEvent,
  comboLabel,
  DEFAULT_FOCUS_RAIL_HOTKEY,
  DEFAULT_NEW_CHAT_HOTKEY,
  eventMatchesCombo,
  globalHotkeyAllowed,
  PAGE_HOTKEY_DEFS,
  READER_MODE_HOTKEY,
} from "../src/hotkeys.ts";

const ev = (over: Partial<Parameters<typeof comboFromEvent>[0]>) => ({
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  key: "k",
  ...over,
});

test("comboFromEvent 纯修饰键 / 无修饰键返回 null", () => {
  assert.equal(comboFromEvent(ev({ metaKey: true, key: "Meta" })), null);
  assert.equal(comboFromEvent(ev({})), null);
});

test("comboFromEvent 生成规范化组合串", () => {
  assert.equal(comboFromEvent(ev({ metaKey: true })), "mod+k");
  assert.equal(
    comboFromEvent(ev({ metaKey: true, shiftKey: true, key: "K" })),
    "mod+shift+k",
  );
  assert.equal(comboFromEvent(ev({ ctrlKey: true, key: "\\" })), "mod+\\");
});

test("eventMatchesCombo 精确匹配修饰键集合", () => {
  assert.ok(eventMatchesCombo(ev({ metaKey: true }), "mod+k"));
  assert.ok(!eventMatchesCombo(ev({ metaKey: true, shiftKey: true }), "mod+k"));
  assert.ok(!eventMatchesCombo(ev({}), "mod+k"));
  assert.ok(eventMatchesCombo(ev({ ctrlKey: true, key: "\\" }), "mod+\\"));
});

test("eventMatchesCombo 空串（禁用）永不命中", () => {
  assert.ok(!eventMatchesCombo(ev({ metaKey: true }), ""));
});

test("comboLabel 渲染与禁用态", () => {
  assert.equal(comboLabel(""), "已禁用");
  // 非 mac 环境（测试运行在 node）mod 显示 Ctrl+
  const label = comboLabel("mod+k");
  assert.ok(label === "⌘K" || label === "Ctrl+K");
});

test("captureDecision：Esc 取消 / 纯修饰键忽略", () => {
  assert.deepEqual(captureDecision(ev({ key: "Escape" }), []), {
    action: "cancel",
  });
  assert.deepEqual(captureDecision(ev({ metaKey: true, key: "Meta" }), []), {
    action: "ignore",
  });
  assert.deepEqual(captureDecision(ev({}), []), { action: "ignore" });
});

test("captureDecision：冲突拒绝（多冲突方任一命中即拒）/ 正常保存", () => {
  assert.deepEqual(captureDecision(ev({ metaKey: true }), ["mod+k"]), {
    action: "conflict",
    combo: "mod+k",
  });
  // 多个冲突方：命中任意一个都拒绝
  assert.deepEqual(
    captureDecision(ev({ metaKey: true, key: "2" }), ["mod+k", "mod+2"]),
    { action: "conflict", combo: "mod+2" },
  );
  assert.deepEqual(captureDecision(ev({ metaKey: true }), ["mod+\\"]), {
    action: "save",
    combo: "mod+k",
  });
  // 冲突方为禁用（空串）时不判冲突
  assert.deepEqual(captureDecision(ev({ metaKey: true }), [""]), {
    action: "save",
    combo: "mod+k",
  });
});

test("PAGE_HOTKEY_DEFS：九页、顺序同侧栏（工作台 · 运行 · 搜对话 · 项目，2026-10-24）、默认绑定唯一", () => {
  assert.equal(PAGE_HOTKEY_DEFS.length, 9);
  assert.deepEqual(
    PAGE_HOTKEY_DEFS.map((p) => p.id),
    ["workbench", "terminal", "sessions", "workspaces", "profiles", "skills", "mcp", "stats", "settings"],
  );
  assert.deepEqual(
    PAGE_HOTKEY_DEFS.slice(0, 4).map((p) => p.label),
    ["工作台", "运行", "搜对话", "项目"],
    "字同侧栏入口",
  );
  const combos = PAGE_HOTKEY_DEFS.map((p) => p.combo);
  assert.equal(new Set(combos).size, 9, "默认绑定不得互相冲突");
  assert.deepEqual(combos, [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `mod+${n}`));
});


test("READER_MODE_HOTKEY：⌘E/Ctrl+E 命中，裸 E 与带 Shift 不命中", () => {
  assert.ok(eventMatchesCombo(ev({ metaKey: true, key: "e" }), READER_MODE_HOTKEY));
  assert.ok(eventMatchesCombo(ev({ ctrlKey: true, key: "E" }), READER_MODE_HOTKEY));
  assert.ok(!eventMatchesCombo(ev({ key: "e" }), READER_MODE_HOTKEY));
  assert.ok(
    !eventMatchesCombo(ev({ metaKey: true, shiftKey: true, key: "e" }), READER_MODE_HOTKEY),
  );
  // 不与九页页切绑定（mod+1..9）冲突
  assert.ok(!PAGE_HOTKEY_DEFS.some((p) => p.combo === READER_MODE_HOTKEY));
});

test("新对话 / 光标移到侧栏：默认 ⌘N / ⌘0，不和九页、命令面板、隐藏侧栏撞；Windows / Linux 焦点在终端里时让给 shell", () => {
  const taken = [...PAGE_HOTKEY_DEFS.map((p) => p.combo), "mod+k", "mod+\\", READER_MODE_HOTKEY];
  assert.ok(!taken.includes(DEFAULT_NEW_CHAT_HOTKEY));
  assert.ok(!taken.includes(DEFAULT_FOCUS_RAIL_HOTKEY));
  assert.notEqual(DEFAULT_NEW_CHAT_HOTKEY, DEFAULT_FOCUS_RAIL_HOTKEY);
  assert.equal(globalHotkeyAllowed(true, true), true, "Mac 上 ⌘ 不进终端，照接");
  assert.equal(globalHotkeyAllowed(true, false), false, "Ctrl+N 在终端里是下一条历史");
  assert.equal(globalHotkeyAllowed(false, false), true);
});
