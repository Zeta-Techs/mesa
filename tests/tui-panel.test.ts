import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseTuiNotice, parseTuiPanel } from "../src/tui-panel.ts";

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

// 2026-10-21 用户 Windows 实测（Claude Code 2.1.305，经智谱网关、auto mode）：一轮中途弹的通知，按回车才继续
const AUTO_MODE_NOTICE = [
  "● Bash(python mesa_probe/hello.py)",
  '  ⎿  "hello"',
  "",
  "─".repeat(100),
  "  We're changing auto mode to no longer charge for classifier requests in Claude Code.",
  "",
  "  However, this session isn't eligible because your requests go through open.bigmodel.cn, which isn't  ",
  "  compatible with this update.",
  "",
  "  Nothing breaks: auto mode keeps working, and its classifier requests are billed as before.",
  "",
  "  To fix it and access the new version of auto mode, ask your gateway to implement:",
  "  https://code.claude.com/docs/en/auto-mode-classifier-billing",
  "",
  "  Enter to continue · Esc to cancel",
];

test("parseTuiNotice：要按回车继续的通知取出正文；有输入框、没有提示行都不算", () => {
  const body = parseTuiNotice(AUTO_MODE_NOTICE, "claude-code")!;
  assert.equal(body[0], "We're changing auto mode to no longer charge for classifier requests in Claude Code.");
  assert.equal(body[body.length - 1], "https://code.claude.com/docs/en/auto-mode-classifier-billing");
  assert.ok(!body.some((l) => /Enter to continue|─{8}/.test(l)));
  assert.equal(parseTuiNotice(AUTO_MODE_NOTICE.slice(0, -1), "claude-code"), null);
  const withPrompt = [...AUTO_MODE_NOTICE, "─".repeat(100), "❯ ", "─".repeat(100)];
  assert.equal(parseTuiNotice(withPrompt, "claude-code"), null);
});

test("通知正文不带启动字符画（Claude 首次启动的安全须知，2.1.308 实录）", () => {
  const lines = readFileSync(new URL("./fixtures/terminal-wait/claude-security.txt", import.meta.url), "utf8").split("\n");
  const body = parseTuiNotice(lines, "claude-code");
  assert.ok(body);
  assert.equal(body[0], "Security notes:");
  assert.ok(body.every((l) => !/[░█]/.test(l)));
});
