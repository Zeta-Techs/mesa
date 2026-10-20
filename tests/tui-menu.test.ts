import assert from "node:assert/strict";
import test from "node:test";
import { menuAnswerKeys, menuEchoesText, parseTuiMenu, sameTuiMenu } from "../src/tui-menu.ts";

test("认出切换确认菜单：问句、选项、当前高亮", () => {
  const menu = parseTuiMenu([
    "",
    " Switching model mid-conversation may increase cost. Continue?",
    "",
    " ❯ 1. Yes, switch to glm-5.3",
    "   2. No, keep current model",
    "",
    " Enter to confirm · Esc to cancel",
  ]);
  assert.ok(menu);
  assert.equal(menu.question, "Switching model mid-conversation may increase cost. Continue?");
  assert.equal(menu.detail, null);
  assert.deepEqual(menu.options, ["Yes, switch to glm-5.3", "No, keep current model"]);
  assert.equal(menu.selected, 0);
  assert.deepEqual(menuAnswerKeys(menu, 1), ["\x1b[B", "\r"]);
  assert.deepEqual(menuAnswerKeys(menu, 0), ["\r"]);
});

test("高亮在中间也能往上挪", () => {
  const menu = parseTuiMenu(["─".repeat(40), "Select effort", "  low", "❯ medium", "  high"]);
  assert.ok(menu);
  assert.equal(menu.selected, 1);
  assert.deepEqual(menu.options, ["low", "medium", "high"]);
  assert.deepEqual(menuAnswerKeys(menu, 0), ["\x1b[A", "\r"]);
});

test("单独一行的输入提示、边框线、普通对话不算菜单", () => {
  assert.equal(parseTuiMenu(["────────", "❯ 帮我看看这个报错", "────────"]), null);
  assert.equal(parseTuiMenu(["这是一段普通回答", "没有选中标记"]), null);
  // 对话记录里回显的命令 + 工具输出续行，不能被当成两项菜单
  assert.equal(parseTuiMenu(["❯ /model sonnet", "  ⎿  Set model to sonnet"]), null);
  assert.equal(parseTuiMenu(["❯ 看看这个", "  ⎿  Read 3 files"]), null);
  // 对话记录里回显的多行提问（Claude 续行缩进两格）：没有序号、提示、边框，不是菜单
  assert.equal(parseTuiMenu(["", "❯ 第一行问题", "  第二行补充", "", "⏺ 好的"]), null);
});

test("同一菜单判等，高亮变了算不同", () => {
  const a = parseTuiMenu(["Q?", "❯ 1. Yes", "  2. No"]);
  const b = parseTuiMenu(["Q?", "  1. Yes", "❯ 2. No"]);
  assert.ok(sameTuiMenu(a, parseTuiMenu(["Q?", "❯ 1. Yes", "  2. No"])));
  assert.equal(sameTuiMenu(a, b), false);
});

test("Claude Code 2.1.292 中途换模型 / 换档的确认菜单（本机 PTY 实录）", () => {
  const screen = [
    "  最后一句话，用来观察流式输出时终端和聊天层谁先显示。",
    "",
    "✻ Sautéed for 7s · done 8:49 PM",
    "▔".repeat(100),
    "   Switch model?",
    "   Your next response will be slower and use more tokens",
    "",
    "   This conversation is cached for the current model. Switching to glm-other means the full",
    "   history gets re-read on your next message.",
    "",
    "   ❯ 1. Yes, switch to glm-other",
    "     2. No, go back",
    "",
  ];
  const menu = parseTuiMenu(screen);
  assert.ok(menu);
  assert.equal(menu.question, "Switch model?");
  assert.match(menu.detail ?? "", /^Your next response will be slower/);
  assert.deepEqual(menu.options, ["Yes, switch to glm-other", "No, go back"]);
  assert.equal(menu.selected, 0);
  // 回显的命令与结果不是菜单
  assert.equal(
    parseTuiMenu([
      "❯ /effort max",
      "  ⎿  Set effort level to max (this session only): Maximum capability with deepest reasoning.",
      "                                                                ◈ max · /effort",
      "─".repeat(100),
      "❯",
      "─".repeat(100),
    ]),
    null,
  );
});

test("Claude Code 完全访问启动警告：按键提示行不算选项（2.1.292 实录，默认高亮在 No）", () => {
  const menu = parseTuiMenu([
    "─".repeat(100),
    "  WARNING: Claude Code running in Bypass Permissions mode",
    "",
    "  In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially",
    "  dangerous commands.",
    "",
    "  ❯ No, exit",
    "    Yes, I accept",
    "",
    "  Enter to confirm · Esc to cancel",
  ]);
  assert.ok(menu);
  assert.equal(menu.question, "WARNING: Claude Code running in Bypass Permissions mode");
  assert.deepEqual(menu.options, ["No, exit", "Yes, I accept"]);
  assert.equal(menu.selected, 0);
  assert.deepEqual(menuAnswerKeys(menu, 1), ["\x1b[B", "\r"]);
  // 紧贴在选项下面也不算
  assert.deepEqual(
    parseTuiMenu(["Q?", "  ❯ No, exit", "    Yes, I accept", "  Enter to confirm · Esc to cancel"])?.options,
    ["No, exit", "Yes, I accept"],
  );
});

// 2026-10-18 聊天层第三期：各家工具审批的 PTY 实录（假 API 回一个「跑命令」工具调用，scripts/e2e-model-routing/chat-capture.py）
test("Claude Code 2.1.292 审批：问句在虚线框下面，折行的长选项并回上一项", () => {
  const menu = parseTuiMenu([
    "⏺ Bash(echo mesa > a.txt)",
    "  ⎿  Waiting…",
    "─".repeat(100),
    " Bash command",
    ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below',
    " 写一个探针文件",
    "╌".repeat(100),
    " echo mesa > a.txt",
    "╌".repeat(100),
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and always allow access to",
    "      /Users/me/project from this project",
    "   3. Yes, and switch to auto mode · auto mode handles these prompts for you",
    "   4. No",
    " Esc to cancel · Tab to amend",
  ]);
  assert.ok(menu);
  assert.equal(menu.question, "Do you want to proceed?");
  assert.equal(menu.detail, "Bash command 写一个探针文件 echo mesa > a.txt", "推广提示不进说明");
  assert.deepEqual(menu.options, [
    "Yes",
    "Yes, and always allow access to /Users/me/project from this project",
    "Yes, and switch to auto mode · auto mode handles these prompts for you",
    "No",
  ]);
  assert.equal(menu.selected, 0);
});

test("Codex 0.163 审批与模型选择器：没有边框，问句只取紧贴选项的那一组", () => {
  const approval = parseTuiMenu([
    "› 跑一下",
    "",
    "",
    "• Running echo mesa > a.txt",
    "",
    "",
    "  Would you like to run the following command?",
    "",
    "  Environment: local",
    "",
    "  Reason: 写个文件，可以吗？",
    "",
    "  $ echo mesa > a.txt",
    "",
    "",
    "› 1. Yes, proceed (y)",
    "  2. Yes, and don't ask again for commands that start with `echo mesa > a.txt` (p)",
    "  3. No, and tell Codex what to do differently (esc)",
    "",
    "  Press enter to confirm or esc to cancel",
  ]);
  assert.ok(approval);
  assert.equal(approval.question, "Would you like to run the following command?", "理由以问号结尾也不抢问句");
  assert.match(approval.detail ?? "", /\$ echo mesa > a\.txt$/);
  assert.equal(approval.options.length, 3);
  const picker = parseTuiMenu([
    "• done",
    "",
    "  Worked for <1s • 01:05",
    "",
    "",
    "  Select Model and Effort",
    "",
    "",
    "› 1. GPT-6.1-Sol    Latest workhorse model for coding and everyday work.",
    "  2. GPT-6-Astra    Frontier intelligence for the most demanding work.",
    "",
    "  enter select · esc back",
  ]);
  assert.equal(picker?.question, "Select Model and Effort");
});

test("Qwen Code 0.25 审批：整屏缩进两格，菜单下面的转圈行不并进最后一项", () => {
  const menu = parseTuiMenu([
    "  > 跑一下",
    "  ? Shell echo mesa > a.txt (写文件) ←",
    "     echo mesa > a.txt",
    "   Allow execution of: 'echo'?",
    "   › 1. Yes, allow once",
    "     2. Always allow run 'echo *' commands in this project",
    "     3. No, suggest changes (esc)",
    "  ⠏ Waiting for user confirmation...",
  ]);
  assert.ok(menu);
  assert.equal(menu.question, "Allow execution of: 'echo'?");
  assert.deepEqual(menu.options, [
    "Yes, allow once",
    "Always allow run 'echo *' commands in this project",
    "No, suggest changes (esc)",
  ]);
});

test("Kimi Code 2.2「▶ 1.」、Gemini 0.64 方框里的「● 1.」、Grok 1.0 单选「2 (●)」都认", () => {
  const kimi = parseTuiMenu([
    " " + "─".repeat(60),
    "   ▶ Run this command?",
    "   cwd: /tmp/work",
    "   $ echo mesa > a.txt",
    "   ▶ 1. Approve once",
    "     2. Approve for this session",
    "     3. Reject",
    "   ↑/↓ select · 1/2/3 choose · ↵ confirm",
  ]);
  assert.equal(kimi?.question, "Run this command?");
  assert.deepEqual(kimi?.options, ["Approve once", "Approve for this session", "Reject"]);

  const gemini = parseTuiMenu([
    `╭${"─".repeat(60)}╮█`,
    `│ ? Shell  echo mesa > a.txt${" ".repeat(34)}│█`,
    `│ ╭${"─".repeat(58)}╮ │█`,
    `│ │ echo mesa > a.txt${" ".repeat(40)}│ │█`,
    `│ ╰${"─".repeat(58)}╯ │█`,
    `│ Allow execution of [Shell]?${" ".repeat(32)}│█`,
    `│ ● 1. Allow once${" ".repeat(44)}│█`,
    `│   2. Allow for this session${" ".repeat(32)}│█`,
    `│   3. No, suggest changes (esc)${" ".repeat(29)}│█`,
    `╰${"─".repeat(60)}╯█`,
  ]);
  assert.ok(gemini);
  assert.equal(gemini.question, "Allow execution of [Shell]?");
  assert.match(gemini.detail ?? "", /echo mesa > a\.txt/, "小框里的命令照收");
  assert.deepEqual(gemini.options, ["Allow once", "Allow for this session", "No, suggest changes (esc)"]);

  const grok = parseTuiMenu([
    "  ┃",
    "  ┃  ›  写一个探针文件",
    "  ┃  │ echo mesa > a.txt",
    "  ┃",
    "  ┃  1 (○) Yes, and don't ask again for anything (always-approve mode)",
    "  ┃  2 (●) Yes, proceed",
    "  ┃  3 (○) No, reject (type to add feedback)",
    "  ┃",
    "  1/3:select  │  Tab:next option  │  Ctrl+c:cancel",
  ]);
  assert.ok(grok);
  assert.equal(grok.selected, 1, "单选的实心圈是当前项");
  assert.deepEqual(grok.options[1], "Yes, proceed");
  assert.deepEqual(menuAnswerKeys(grok, 2), ["\x1b[B", "\r"]);
});

test("用户自己发的编号清单回显不是菜单", () => {
  const menu = parseTuiMenu(["› 1. 先读配置", "  2. 再改测试"]);
  assert.ok(menu, "形状上像菜单");
  assert.equal(menuEchoesText(menu, "1. 先读配置\n2. 再改测试"), true);
  assert.equal(menuEchoesText(menu, "随便问问"), false);
});

test("CodeBuddy 2.168 审批：框顶标题「Confirm」，问句取贴着选项的「Are you sure…」，「> 1.」是当前项", () => {
  const box = (t: string) => `│ ${t.padEnd(70)}│`;
  const menu = parseTuiMenu([
    "● REPL · 写一个探针文件",
    `╭${"─".repeat(72)}╮`,
    box("Confirm"),
    box(""),
    box("  REPL"),
    box('  code: "return await Bash({ command: "echo mesa > a.txt" })"'),
    box(""),
    box("Are you sure you want to do this?"),
    box(""),
    box("> 1. Yes"),
    box("  2. Yes, and don't ask again this session (shift + tab)"),
    box("  3. No, and tell CodeBuddy what to do differently (escape)"),
    `╰${"─".repeat(72)}╯`,
  ]);
  assert.ok(menu);
  assert.equal(menu.question, "Are you sure you want to do this?");
  assert.match(menu.detail ?? "", /^Confirm REPL/);
  assert.equal(menu.options.length, 3);
  assert.equal(menu.selected, 0);
});

test("Windows：Grok 单选的选中点画成 •（2026-10-20 ConPTY 抓屏）", () => {
  const menu = parseTuiMenu([
    "  │  >  写一个探针文件",
    "  │  │ echo mesa > mesa_probe.txt",
    "  │",
    "  │  1 (○) Yes, and don't ask again for anything (always-approve mode)",
    "  │  2 (•) Yes, proceed",
    "  │  3 (○) No, reject (type to add feedback)",
    "  │  4 (○) Never allow: echo",
    "  │",
    "  1/4:select  │  Tab:next option  │  ←/→:scope  │  Ctrl+c:cancel",
  ]);
  assert.equal(menu?.selected, 1);
  assert.equal(menu?.options[1], "Yes, proceed");
  assert.equal(menu?.options.length, 4);
});
