import assert from "node:assert/strict";
import test from "node:test";
import { parseTrustPrompt, sameTrustPrompt, trustAnswerKeys } from "../src/trust-prompt.ts";

// 2026-10-17 用户截图里的 Claude Code 新版信任菜单：默认高亮在「No, exit」
const CLAUDE_NEW = [
  "────────────────────────────────",
  " Accessing workspace:",
  "",
  " /Users/tongzhouhong",
  "",
  " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open",
  " source project, or work from your team). If not, take a moment to review what's in this folder first.",
  "",
  " Claude Code'll be able to read, edit, and execute files here.",
  "",
  " Security guide",
  "",
  " ❯ No, exit",
  "   Yes, I trust this folder",
  "",
  " Enter to confirm · Esc to cancel",
];

test("认出 Claude 新版信任菜单：路径、选项与当前高亮", () => {
  const p = parseTrustPrompt(CLAUDE_NEW);
  assert.ok(p);
  assert.equal(p.path, "/Users/tongzhouhong");
  assert.deepEqual(p.options, ["No, exit", "Yes, I trust this folder"]);
  assert.equal(p.selected, 0);
  assert.equal(p.yesIndex, 1);
  // 信任 = 下移一格再回车；不信任 = 直接回车
  assert.deepEqual(trustAnswerKeys(p, true), ["\x1b[B", "\r"]);
  assert.deepEqual(trustAnswerKeys(p, false), ["\r"]);
});

test("旧版带序号、默认高亮在 Yes：信任直接回车，拒绝下移一格", () => {
  const p = parseTrustPrompt([
    " Do you trust the files in this folder?",
    " /tmp/demo",
    " ❯ 1. Yes, proceed",
    "   2. No, exit",
  ]);
  assert.ok(p);
  assert.deepEqual(trustAnswerKeys(p, true), ["\r"]);
  assert.deepEqual(trustAnswerKeys(p, false), ["\x1b[B", "\r"]);
});

test("Kimi / CodeBuddy / Gemini 的信任菜单也认：信任只选范围最窄的那项（2026-10-17 PTY 实录）", () => {
  const kimi = parseTrustPrompt([
    " ──────────────────────────",
    "  Trust this folder?",
    "  ↑↓ navigate · Enter select · Esc exit",
    "  /private/tmp/work",
    "  No project integrations or instructions to activate.",
    "  Trust is remembered for this folder, including future project config changes.",
    "  Tool approvals follow your permission settings.",
    "   ❯ Trust and continue",
    "     Exit",
    " ──────────────────────────",
  ]);
  assert.ok(kimi);
  assert.equal(kimi.path, "/private/tmp/work");
  assert.deepEqual(kimi.options, ["Trust and continue", "Exit"], "「Trust is remembered…」说明行不算选项");
  assert.deepEqual(trustAnswerKeys(kimi, true), ["\r"]);
  assert.deepEqual(trustAnswerKeys(kimi, false), ["\x1b[B", "\r"]);

  const codebuddy = parseTrustPrompt([
    "╭────────────────────────────────────╮",
    "│ Do you trust the files in this folder?                │",
    "│                                                        │",
    "│ /private/tmp/work                                      │",
    "│                                                        │",
    "│   > 1. Trust folder only (work)                        │",
    "│     2. Trust parent folder (tmp/**)                    │",
    "│     3. Trust folder and all subdirectories (work/**)   │",
    "│     4. No, exit (escape)                               │",
    "│                                                        │",
    "│ Enter to confirm • Esc to exit                         │",
    "╰────────────────────────────────────╯",
  ]);
  assert.ok(codebuddy);
  assert.equal(codebuddy.path, "/private/tmp/work");
  assert.equal(codebuddy.options.length, 4);
  assert.equal(codebuddy.yesIndex, 0, "不替用户信任上级目录或整棵子目录");
  assert.equal(codebuddy.noIndex, 3);
  assert.deepEqual(trustAnswerKeys(codebuddy, false), ["\x1b[B", "\x1b[B", "\x1b[B", "\r"]);

  const gemini = parseTrustPrompt([
    "Do you trust this folder?",
    "● 1. Trust folder (demo)",
    "  2. Trust parent folder",
    "  3. Don't trust (esc)",
  ]);
  assert.ok(gemini);
  assert.equal(gemini.yesIndex, 0);
  assert.equal(gemini.noIndex, 2);
});

test("普通对话画面不认", () => {
  assert.equal(parseTrustPrompt(["> 帮我看看这个报错", "No problem, let me check."]), null);
  // 有问句但没有成对的信任 / 不信任选项
  assert.equal(parseTrustPrompt(["Do you trust this folder?", "❯ Maybe later"]), null);
});

test("同一提示判等，高亮变了算不同", () => {
  const a = parseTrustPrompt(CLAUDE_NEW);
  const b = parseTrustPrompt([...CLAUDE_NEW]);
  assert.ok(sameTrustPrompt(a, b));
  const moved = parseTrustPrompt(CLAUDE_NEW.map((l) => l.replace("❯ No", "  No").replace("  Yes", "❯ Yes")));
  assert.equal(sameTrustPrompt(a, moved), false);
  assert.ok(sameTrustPrompt(null, null));
});
