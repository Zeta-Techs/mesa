import assert from "node:assert/strict";
import test from "node:test";
import {
  captureDecision,
  closeChatCombo,
  comboFromEvent,
  comboLabel,
  DEFAULT_FOCUS_RAIL_HOTKEY,
  DEFAULT_NEW_CHAT_HOTKEY,
  DEFAULT_TOGGLE_SURFACE_HOTKEY,
  eventMatchesCombo,
  FIXED_HOTKEYS,
  globalHotkeyAllowed,
  hotkeyClashes,
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

test("PAGE_HOTKEY_DEFS：八页、顺序同展开的侧栏、没有「运行」（2026-10-24 用户二改）、默认 ⌘1–⌘8 唯一", () => {
  assert.equal(PAGE_HOTKEY_DEFS.length, 8);
  assert.deepEqual(
    PAGE_HOTKEY_DEFS.map((p) => p.id),
    ["workbench", "sessions", "workspaces", "profiles", "skills", "mcp", "stats", "settings"],
  );
  assert.deepEqual(
    PAGE_HOTKEY_DEFS.slice(0, 3).map((p) => p.label),
    ["工作台", "对话管理", "项目"],
    "字同侧栏入口",
  );
  const combos = PAGE_HOTKEY_DEFS.map((p) => p.combo);
  assert.deepEqual(combos, [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `mod+${n}`));
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

test("hotkeyClashes：存下的旧绑定和新默认撞车时两条都标出（项目存成旧默认 ⌘2，撞对话管理 ⌘2）；禁用不算撞", () => {
  const pages = PAGE_HOTKEY_DEFS.map((p) => ({
    id: p.id,
    label: p.label,
    // 重排前改过、存成旧默认的「项目」⌘2
    combo: p.id === "workspaces" ? "mod+2" : p.combo,
  }));
  const clashes = hotkeyClashes([...pages, { id: "newChat", label: "新对话", combo: "" }]);
  assert.equal(clashes.get("workspaces"), "对话管理");
  assert.equal(clashes.get("sessions"), "项目");
  assert.equal(clashes.size, 2);
  assert.equal(hotkeyClashes(PAGE_HOTKEY_DEFS.map((p) => ({ ...p }))).size, 0, "默认绑定互不相撞");
  assert.equal(
    hotkeyClashes([
      { id: "a", label: "甲", combo: "" },
      { id: "b", label: "乙", combo: "" },
    ]).size,
    0,
  );
});

test("FIXED_HOTKEYS：名字不超过 8 个字（设置页双列放得下，不被截成「…」）", () => {
  for (const k of FIXED_HOTKEYS) assert.ok([...k.label].length <= 8, k.label);
});

test("聊天 / 终端切换：默认 ⌘⇧T / Ctrl+Shift+T，按住 Shift 时 key 是大写也命中；裸 Ctrl+T 不拦（终端里照常进 CLI）", () => {
  const taken = [
    ...PAGE_HOTKEY_DEFS.map((p) => p.combo),
    "mod+k",
    "mod+\\",
    READER_MODE_HOTKEY,
    DEFAULT_NEW_CHAT_HOTKEY,
    DEFAULT_FOCUS_RAIL_HOTKEY,
  ];
  assert.ok(!taken.includes(DEFAULT_TOGGLE_SURFACE_HOTKEY));
  assert.ok(eventMatchesCombo(ev({ metaKey: true, shiftKey: true, key: "T" }), DEFAULT_TOGGLE_SURFACE_HOTKEY));
  assert.ok(eventMatchesCombo(ev({ ctrlKey: true, shiftKey: true, key: "T" }), DEFAULT_TOGGLE_SURFACE_HOTKEY));
  assert.ok(!eventMatchesCombo(ev({ ctrlKey: true, key: "t" }), DEFAULT_TOGGLE_SURFACE_HOTKEY));
  // 设置页录下来的就是默认值本身
  assert.deepEqual(captureDecision(ev({ metaKey: true, shiftKey: true, key: "T" }), []), {
    action: "save",
    combo: DEFAULT_TOGGLE_SURFACE_HOTKEY,
  });
});

test("关掉这段对话：macOS ⌘W，其余平台 Ctrl+Shift+W（Ctrl+W 留给终端删词），并列在固定快捷键里", () => {
  assert.equal(closeChatCombo(true), "mod+w");
  assert.equal(closeChatCombo(false), "mod+shift+w");
  const row = FIXED_HOTKEYS.find((h) => h.label === "关掉这段对话");
  assert.ok(row);
  assert.equal(row.mac, "⌘W");
  assert.equal(row.other, "Ctrl+Shift+W");
});
