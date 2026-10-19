import assert from "node:assert/strict";
import test from "node:test";
import { parseTuiPanel } from "../src/tui-panel.ts";

// 2026-10-19 用户截图：Claude 2.1.29x 里发 /cost 打开的 Settings 面板（Usage 页）
const USAGE_PANEL = [
  "❯ /cost",
  "",
  "─".repeat(100),
  "  Settings   Status   Config   Usage   Stats",
  "",
  "  Session",
  "",
  "  Total cost:            $0.73 (costs may be inaccurate due to usage of unknown models)",
  "  Total duration (API):  5m 7s",
  "  Usage by model:",
  "              glm-5.3:  19.6k input, 9.9k output, 774.0k cache read, 0 cache write ($0.73)",
  "",
  "  Esc to cancel",
];

const CHAT_SCREEN = [
  "⏺ 收到",
  "",
  "✻ Cooked for 21s · done 3:11 PM",
  "",
  "─".repeat(100),
  "❯ ",
  "─".repeat(100),
  "  glm-5.3 | ccode/scratch | 65.3k tok",
];

test("Settings 面板：没有输入框、有 Esc to cancel", () => {
  assert.equal(parseTuiPanel(USAGE_PANEL, "claude-code"), true);
});

test("正常对话界面（有输入框）不是面板", () => {
  assert.equal(parseTuiPanel(CHAT_SCREEN, "claude-code"), false);
  // 生成中底栏写的是 esc to interrupt，且输入框还在
  const generating = [...CHAT_SCREEN.slice(0, -1), "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt"];
  assert.equal(parseTuiPanel(generating, "claude-code"), false);
});

test("没有关闭提示的全屏界面不认（宁可漏认）", () => {
  const noHint = USAGE_PANEL.filter((l) => !/Esc to cancel/.test(l));
  assert.equal(parseTuiPanel(noHint, "claude-code"), false);
  // 生成中提示「esc to interrupt」不是关闭提示
  const interrupt = [...noHint, "  esc to interrupt"];
  assert.equal(parseTuiPanel(interrupt, "claude-code"), false);
});

test("没有画面布局表的家（CodeBuddy / OpenCode）和空白屏不认", () => {
  assert.equal(parseTuiPanel(USAGE_PANEL, "codebuddy"), false);
  assert.equal(parseTuiPanel(USAGE_PANEL, "opencode"), false);
  assert.equal(parseTuiPanel(["", "", "  Esc to cancel"], "claude-code"), false);
});

test("Codex 同样：没有输入行 + Esc to close 才算", () => {
  const panel = ["  Resume a previous session", "", "  ❯ 1. 今天的会话", "    2. 昨天的会话", "", "  Enter to select · Esc to close"];
  assert.equal(parseTuiPanel(panel, "codex"), true);
  assert.equal(parseTuiPanel(["› 你好", "• 好的", "› "], "codex"), false);
});
