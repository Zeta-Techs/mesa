import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  claudeFirstRunStep,
  claudeThemeLabel,
  claudeThemeTarget,
  exitTail,
  launchFailureHint,
  waitKeyBytes,
  waitScreenOf,
} from "../src/terminal-wait.ts";

// Claude Code 2.1.308 空 HOME 首次启动实录（2026-10-27，110×34，pyte 抓屏）
const screen = (name: string) =>
  readFileSync(new URL(`./fixtures/terminal-wait/${name}.txt`, import.meta.url), "utf8").split("\n");

test("配色屏：认出选项与当前高亮，摘录去掉启动字符画", () => {
  const lines = screen("claude-theme");
  const step = claudeFirstRunStep(lines);
  assert.deepEqual(step, {
    kind: "theme",
    options: [
      "Auto (match terminal)",
      "Dark mode",
      "Light mode",
      "Dark mode (colorblind-friendly)",
      "Light mode (colorblind-friendly)",
      "Dark mode (ANSI colors only)",
      "Light mode (ANSI colors only)",
    ],
    selected: 1,
  });
  const wait = waitScreenOf(lines)!;
  assert.equal(wait.lines[0], "Let's get started.");
  assert.ok(wait.lines.every((l) => !/[░█]/.test(l)), "字符画不进卡片");
  assert.ok(wait.lines.length <= 16);
  assert.equal(wait.title, "Choose the text style that looks best with your terminal");
});

test("配色选哪项：Mac 选 Auto，Windows 按 Mesa 主题明暗", () => {
  const step = claudeFirstRunStep(screen("claude-theme"));
  assert.ok(step?.kind === "theme");
  assert.equal(claudeThemeTarget(step.options, "auto"), 0);
  assert.equal(claudeThemeTarget(step.options, "light"), 2);
  assert.equal(claudeThemeTarget(step.options, "dark"), 1);
  // 新版去掉了 Auto：退回按明暗
  assert.equal(claudeThemeTarget(["Dark mode", "Light mode"], "auto"), 0);
  assert.equal(claudeThemeLabel("Auto (match terminal)"), "跟随终端（随 Mesa 主题深浅）");
});

test("安全须知屏：取须知原文", () => {
  const step = claudeFirstRunStep(screen("claude-security"));
  assert.ok(step?.kind === "security");
  assert.equal(step.text[0], "Security notes:");
  assert.ok(step.text.some((l) => l.startsWith("2. Due to prompt injection risks")));
  assert.ok(!step.text.some((l) => /Press Enter/.test(l)));
});

test("别的屏不当首次启动", () => {
  assert.equal(claudeFirstRunStep(screen("claude-trust")), null);
  assert.equal(claudeFirstRunStep(screen("claude-login-method")), null);
  assert.equal(claudeFirstRunStep(["❯ 你好", "─".repeat(40)]), null);
});

test("信任屏：从实线下面开始摘，问句当标题", () => {
  const wait = waitScreenOf(screen("claude-trust"))!;
  assert.equal(wait.lines[0], "Accessing workspace:");
  assert.match(wait.title, /^Quick safety check: Is this a project you created or one you trust\?|^Accessing workspace:$/);
  assert.equal(wait.numbered, 0);
});

test("登录屏：折行的网址接成一条，认出要粘贴代码", () => {
  const wait = waitScreenOf(screen("claude-login-code"))!;
  assert.equal(wait.links.length, 1);
  assert.match(wait.links[0], /^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true&client_id=/);
  assert.match(wait.links[0], /&state=[\w-]+$/, "最后一截续行也接上");
  assert.ok(!/\s/.test(wait.links[0]));
  assert.equal(wait.typeIn, true);
});

test("编号选项：数出连续序号", () => {
  const wait = waitScreenOf(screen("claude-login-method"))!;
  assert.equal(wait.numbered, 3);
  assert.equal(wait.title, "Select login method:");
  assert.equal(wait.typeIn, false);
  // 只有一项不算菜单
  assert.equal(waitScreenOf(["Steps:", "1. do it"])!.numbered, 0);
});

test("方框竖边剥掉、连续空行并一行；空屏为 null", () => {
  const wait = waitScreenOf([
    "╭──────────────────────────╮",
    "│ Apply this migration?    │",
    "│                          │",
    "│                          │",
    "│ ❯ 1. Yes                 │",
    "│   2. No                  │",
    "╰──────────────────────────╯",
  ])!;
  assert.deepEqual(wait.lines, ["Apply this migration?", "", "❯ 1. Yes", "  2. No"]);
  assert.equal(wait.title, "Apply this migration?");
  assert.equal(wait.numbered, 2);
  assert.equal(waitScreenOf(["", "   ", ""]), null);
});

test("按键字节：方向键、回车、Esc、数字、整段文字", () => {
  assert.deepEqual(waitKeyBytes("up"), ["\x1b[A"]);
  assert.deepEqual(waitKeyBytes("down"), ["\x1b[B"]);
  assert.deepEqual(waitKeyBytes("enter"), ["\r"]);
  assert.deepEqual(waitKeyBytes("esc"), ["\x1b"]);
  assert.deepEqual(waitKeyBytes("digit:2"), ["2"]);
  assert.deepEqual(waitKeyBytes("text:abc\ndef"), ["abc def", "\r"]);
});

test("启动失败：最后几行与原因", () => {
  const raw = ["", "env: node: No such file or directory", "", "   "];
  assert.deepEqual(exitTail(raw), ["env: node: No such file or directory"]);
  assert.match(launchFailureHint(exitTail(raw), 127)!, /找不到 Node/);
  assert.match(launchFailureHint(["zsh: command not found: codex"], 127)!, /找不到要运行的程序/);
  assert.equal(launchFailureHint(["Error: invalid config"], 1), null);
  assert.equal(exitTail(Array.from({ length: 20 }, (_, i) => `line ${i}`)).length, 8);
});
