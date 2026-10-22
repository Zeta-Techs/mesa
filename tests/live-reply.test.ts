import assert from "node:assert/strict";
import test from "node:test";
import { claudeOutputTokens, extractLiveReply, liveReplySupported, mergeLiveReply, staleEcho, terminalHasInputBox, unsyncedTail } from "../src/live-reply.ts";

const RULE = "─".repeat(100);
// Claude Code 2.1.292 本机 PTY 实录（流式写到一半；假 API 慢速吐字）
const STREAMING = [
  " ▐▛███▛█   Claude Code v2.1.292",
  "▝▜██████▀  glm-test · API Usage Billing",
  "",
  "❯ 请读文件 a.txt",
  "",
  "⏺ 我先读一下文件。",
  "",
  "  Read 1 file",
  "",
  "⏺ 好的，我先看一下结构。",
  "",
  "  结论",
  "",
  "  - 第一点：配置读取在 settings.rs，这里负责合并默认值。",
  "  -",
  "",
  "",
  RULE,
  "❯",
  RULE,
  "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← for agents",
];

test("读出这一轮正在写的回复：去掉工具摘要、转圈行、输入框", () => {
  assert.deepEqual(extractLiveReply(STREAMING, "claude-code")?.lines, [
    "我先读一下文件。",
    "",
    "好的，我先看一下结构。",
    "",
    "结论",
    "",
    "- 第一点：配置读取在 settings.rs，这里负责合并默认值。",
    "-",
  ]);
  const withSpinner = [
    "❯ hello",
    "⏺ 我先读一下文件。",
    "  Read 1 file",
    "⏺",
    "✻ Twisting… (0s · ↓ 18 tokens)",
    "                                                  ● high · /effort",
    RULE,
    "❯",
    RULE,
  ];
  assert.deepEqual(extractLiveReply(withSpinner, "claude-code")?.lines, ["我先读一下文件。"]);
});

test("别家、确认菜单挂着、还没有回复时不预览", () => {
  assert.equal(extractLiveReply(STREAMING, "codex"), null);
  assert.equal(extractLiveReply(["❯ hello", "▔".repeat(80), "   Switch model?", "   ❯ 1. Yes"], "claude-code"), null);
  assert.equal(extractLiveReply(["❯ hello", "", RULE, "❯", RULE], "claude-code"), null);
  // 启动信任菜单（Claude 2.1.292 实录）：没有输入框，整屏都不是回复
  assert.equal(
    extractLiveReply(
      [
        " Accessing workspace:",
        " /Users/tongzhouhong",
        " Quick safety check: Is this a project you created or one you trust?",
        " ❯ No, exit",
        "   Yes, I trust this folder",
        " Enter to confirm · Esc to cancel",
      ],
      "claude-code",
    ),
    null,
  );
});

test("会话文件追上的行让位，只留聊天层还没有的部分", () => {
  const live = extractLiveReply(STREAMING, "claude-code")!.lines;
  // 会话文件里已经有第一段（Markdown 原文带 ## 和反引号也对得上）
  assert.deepEqual(unsyncedTail(live, "我先读一下文件。"), live.slice(2));
  assert.deepEqual(
    unsyncedTail(live, "我先读一下文件。好的，我先看一下结构。\n\n## 结论\n\n- 第一点：配置读取在 `settings.rs`，这里负责合并默认值。\n-"),
    [],
  );
});

test("长回复开头滚出屏后，屏上这一截接到上一次后面，不丢前半段", () => {
  // Claude Code 2.1.292 实录：回复长过一屏时，回显和「⏺」都滚出去了，屏上只有续行
  const para = (n: number) => `  第${n}段：这是一段用来撑满屏幕的长回复。`;
  const screen = (from: number, to: number) => {
    const rows: string[] = [""];
    for (let n = from; n <= to; n++) rows.push(para(n), "");
    return [...rows, "", RULE, "❯", RULE, "  ⏵⏵ auto mode on · esc to interrupt"];
  };
  const first = extractLiveReply(
    ["❯ 请给我一个长回复", "", "⏺ 第1段：这是一段用来撑满屏幕的长回复。", "", para(2), "", RULE, "❯", RULE],
    "claude-code",
  )!;
  assert.equal(first.anchored, true);
  const later = extractLiveReply(screen(2, 5), "claude-code")!;
  assert.equal(later.anchored, false);
  assert.equal(later.lines[0], "第2段：这是一段用来撑满屏幕的长回复。");
  const merged = mergeLiveReply(first.lines, later)!;
  assert.deepEqual(merged.filter((l) => l.trim()).map((l) => l.slice(0, 3)), ["第1段", "第2段", "第3段", "第4段", "第5段"]);
  // 再往后滚：继续接
  const more = mergeLiveReply(merged, extractLiveReply(screen(4, 8), "claude-code")!)!;
  assert.equal(more.filter((l) => l.trim()).length, 8);
  // 看得见开头时以整段为准
  assert.deepEqual(mergeLiveReply(more, first), first.lines);
  // 这一轮还没见过开头：续行不知道属于谁，不预览
  assert.equal(mergeLiveReply(null, later), null);
});

// 2026-10-22 用户：Claude Code 流式长回复，聊天层预览一遍遍重贴整屏。假网关按 6 字一块流出真回复
// （chat-capture.py + E2E_LONG_FILE / E2E_LONG_CHUNK），抓下的相邻两屏：上一次的尾巴被 CLI 重画了
const LIST = ["两层嵌套的无序列表如下：", "", "- 学习准备", "  - 明确学习目标", "  - 收集必要资料", "- 练习过程"];
const unanchored = (lines: string[]) => ({ lines, anchored: false });

test("长回复：上一次的尾巴被重画（列表项先画个「-」、「4.」后面才出字）也接得上，不整屏重贴", () => {
  const prev = ["当不同意见出现时，先确认彼此讨论的是同一个问题，往往很有帮助。", "", ...LIST, "  -"];
  const screen = ["当不同意见出现时，先确认彼此讨论的是同一个问题，往往很有帮助。", "", ...LIST, "  - 从简单任务开始", "  - 检查每次输出"];
  assert.deepEqual(mergeLiveReply(prev, unanchored(screen.slice(2))), [...prev.slice(0, 2), ...screen.slice(2)]);
  const ordered = ["有序列表如下：", "", "1. 明确任务的范围和目标。", "2. 将目标拆分为若干可执行步骤。"];
  const merged = mergeLiveReply([...LIST, "", ...ordered, "3."], unanchored([...ordered, "3. 按照优先级完成最关键的部分。", "4."]));
  assert.deepEqual(merged, [...LIST, "", ...ordered, "3. 按照优先级完成最关键的部分。", "4."]);
});

test("长回复：表格每多一格就重排、加粗收尾前后两种样子，都按屏上最新的接", () => {
  const rule = (l: string, m: string, r: string) => `${l}──────${m}────────────────────────${m}────────${r}`;
  const half = [rule("┌", "┬", "┐"), "│ 项目 │          内容          │  状态  │", rule("├", "┼", "┤"), "│ 方法 │ 选择能够执行的具       │        │", rule("└", "┴", "┘")];
  const full = [rule("┌", "┬", "┐"), "│ 项目 │          内容          │  状态  │", rule("├", "┼", "┤"), "│ 方法 │ 选择能够执行的具体步骤 │ 已规划 │", rule("├", "┼", "┤"), "│ 复盘 │ 根据结果调整后续行动   │ 待开始 │", rule("└", "┴", "┘")];
  const before = ["4. 检查结果并记录改进方向。", ""];
  const merged = mergeLiveReply([...LIST, "", ...before, ...half], unanchored([...before, ...full, "", "结构化表达能够让复杂的信息更容易被理解。"]));
  assert.deepEqual(merged, [...LIST, "", ...before, ...full, "", "结构化表达能够让复杂的信息更容易被理解。"]);
  // 屏顶正好是表格上边框：段落和表格之间的空行留着，边框只留屏上那条
  const fromBorder = mergeLiveReply([...before, ...half], unanchored(full));
  assert.deepEqual(fromBorder, [...before, ...full]);
  // 「**持续…」没收尾时原样画着星号，收尾后画成加粗：同一行
  const bold = mergeLiveReply(["每一个小步骤都可能带来反馈。", "**持续而温和的进步，通常比"], unanchored(["每一个小步骤都可能带来反馈。", "持续而温和的进步，通常比短暂而激烈的努力更加可靠。", "有些经验需要时间。"]));
  assert.deepEqual(bold, ["每一个小步骤都可能带来反馈。", "持续而温和的进步，通常比短暂而激烈的努力更加可靠。", "有些经验需要时间。"]);
});

test("长回复：对不上时，屏上大半已经有了就不接（重画没对齐），大半是新的才接（滚过了一整屏）", () => {
  const prev = ["第一行旧内容写完了", "第二行旧内容写完了", "第三行旧内容写完了", "第四行旧内容写完了"];
  // 屏顶那行认不出（半帧之类），下面都是上一次已有的：不重贴
  assert.deepEqual(mergeLiveReply(prev, unanchored(["一行认不出的半截", ...prev.slice(1)])), prev);
  // 全是新的：两次读之间滚过了一整屏，接在后面
  const fresh = ["第五行新内容", "第六行新内容"];
  assert.deepEqual(mergeLiveReply(prev, unanchored(fresh)), [...prev, ...fresh]);
});

// 2026-10-18 聊天层第三期：假 API 慢慢流出 10 行，PTY 抓屏（scripts/e2e-model-routing/chat-capture.py）。
// 各家都是流到一半（第二个要点刚出来）的那一帧，边框截短
const HALF = ["第一段：这是一段慢慢流出来的回复。", "", "• 要点一：终端先画出来", "• 要点二：会话文件后落盘"];
const HALF_DASH = HALF.map((l) => l.replace(/^• /, "- "));
const BOX = (inner: string) => [`  ╭${"─".repeat(30)}╮`, `  │ ${inner.padEnd(29)}│`, `  ╰${"─".repeat(30)}╯`];

test("Codex 0.163：› 回显 / • 正文 / 没有边框的输入行", () => {
  const screen = [
    "› 讲一段",
    "",
    "• 第一段：这是一段慢慢流出来的回复。",
    "",
    "  • 要点一：终端先画出来",
    "  • 要点二：会话文件后落盘",
    "",
    "• Working (2s • esc to interrupt)",
    "",
    "› Ask Codex to do anything",
    "",
    "  e2e-picked high · /tmp/work",
    "  ? for shortcuts",
  ];
  assert.deepEqual(extractLiveReply(screen, "codex")?.lines, HALF);
  // 工具调用和它的输出不进预览
  const withTool = ["› 看看", "• Ran ls -la", "  └ total 8", "    a.txt", "• 目录里只有 a.txt。", "› Ask Codex to do anything"];
  assert.deepEqual(extractLiveReply(withTool, "codex")?.lines, ["目录里只有 a.txt。"]);
});

test("Qwen Code 0.25：  > 回显 / ◆ 正文 / 横线框住的输入框", () => {
  const screen = [
    "  > 讲一段",
    "",
    "  ◆ 第一段：这是一段慢慢流出来的回复。",
    "",
    "     - 要点一：终端先画出来",
    "     - 要点二：会话文件后落盘",
    "",
    "  ⠏ Blowing on the cartridge... (2s · ↓ 11 tokens · esc to cancel)",
    "─".repeat(60),
    ">   Type your message or @path/to/file",
    "─".repeat(60),
    "  ➜ work · e2e-picked xhigh",
  ];
  assert.deepEqual(extractLiveReply(screen, "qwen")?.lines, HALF_DASH);
  // 「  ? Shell …」这类工具行不进预览
  const withTool = ["  > 跑一下", "  ? Shell echo mesa > a.txt (写文件) ←", "     echo mesa > a.txt", "─".repeat(60), ">   Type", "─".repeat(60)];
  assert.equal(extractLiveReply(withTool, "qwen"), null);
});

test("Gemini CLI 0.64：回显与输入框都在 ▄▄ / ▀▀ 半格框里，最后一个才是输入框", () => {
  const screen = [
    "▄".repeat(60),
    " > 讲一段",
    "▀".repeat(60),
    "✦ 第一段：这是一段慢慢流出来的回复。",
    "",
    "   - 要点一：终端先画出来",
    "   - 要点二：会话文件后落盘",
    "",
    "  Thinking... (esc to cancel, 2s)                     ? for shortcuts",
    "─".repeat(60),
    " Shift+Tab to accept edits                            4 MCP servers",
    "▄".repeat(60),
    " >   Type your message or @path/to/file",
    "▀".repeat(60),
  ];
  assert.deepEqual(extractLiveReply(screen, "gemini")?.lines, HALF_DASH);
});

test("Grok Build 1.0：正文没有行首符号，右侧时间与滚动条去掉", () => {
  const screen = [
    "     ❯ 讲一段                                              1:13 AM",
    "",
    "     第一段：这是一段慢慢流出来的回复。                     1:13 AM  █",
    "",
    "     • 要点一：终端先画出来",
    "     • 要点二：会话文件后落盘",
    "",
    "    ⠙ Responding… 2.0s                          2.1s ⇣1.44k [stop]",
    "",
    ...BOX("❯"),
    "  Shift+Tab:mode  │  Ctrl+c:cancel",
  ];
  assert.deepEqual(extractLiveReply(screen, "grok")?.lines, HALF);
});

test("Kimi Code 2.2：❯ 回显 / ● 正文 / 方框输入框；工具调用整块跳过", () => {
  const screen = [
    " ❯ 讲一段",
    "",
    " ● 第一段：这是一段慢慢流出来的回复。",
    "",
    "   • 要点一：终端先画出来",
    "   • 要点二：会话文件后落盘",
    "",
    "  ⠼ Working… · Tip: ! to run a shell command",
    ...BOX(">"),
    " E2E · e2e-picked thinking  …/work",
  ];
  assert.deepEqual(extractLiveReply(screen, "kimi")?.lines, HALF);
  const withTool = [
    " ❯ 跑一下",
    " ● Running a command · $ echo mesa > a.txt",
    "   Press Ctrl+B to run in background",
    " ● 好了。",
    ...BOX(">"),
  ];
  assert.deepEqual(extractLiveReply(withTool, "kimi")?.lines, ["好了。"]);
});

test("CodeBuddy 2.168 生成中屏上只有转圈、OpenCode 是分栏整屏重绘：不预览", () => {
  assert.equal(liveReplySupported("codebuddy"), false);
  assert.equal(liveReplySupported("opencode"), false);
  assert.equal(
    extractLiveReply(["> 讲一段", "", "✸ Waking… (2s · streaming · ↓ 14 tokens)", "─".repeat(60), ">", "─".repeat(60)], "codebuddy"),
    null,
  );
  for (const agent of ["claude-code", "codex", "qwen", "gemini", "grok", "kimi"]) {
    assert.equal(liveReplySupported(agent), true, agent);
  }
});

// 2026-10-19 用户截图：Claude 2.1.29x 联网搜索结束后的一屏。回显已经滚出屏，工具名带空格（Web Search），
// 思考折叠行「Thought for 5s (ctrl+o to expand)」不带行首符号
const AFTER_WEB_SEARCH = [
  "  Thought for 7s (ctrl+o to expand)",
  "",
  "⏺ Fetch(https://v2.tauri.app/release/tauri/)",
  "  ⎿  Error: Unable to verify if domain v2.tauri.app is safe to fetch. This may be due to network restrictions or",
  "     enterprise security policies blocking claude.ai.",
  "",
  "  Thought for 6s (ctrl+o to expand)",
  "",
  '⏺ Web Search("tauri 2.12.1 crates.io 版本发布")',
  "  ⎿  Did 1 search in 15s",
  "",
  "  Thought for 5s (ctrl+o to expand)",
  "",
  "⏺ Tauri v2 当前最新版本为 2.12 系列（最新补丁 2.12.1），其中 2.12.0 于 2026 年 9 月 26 日发布。",
  "  另外 3.0.0-alpha.2 已处于早期预览阶段，但不属于稳定版。",
  "",
  "  来源链接：",
  "  - Announcing Tauri 2.12（官方博客） (https://v2.tauri.app/blog/tauri-2.12)",
  "  - crates.io — tauri (https://crates.io/crates/tauri)",
  "",
  "✻ Baked for 1m 19s · done 3:15 PM",
  "",
  RULE,
  "❯ 再搜下 Tauri 3.0 alpha 的新特性",
  RULE,
  "  glm-5.3 | ccode/scratch | 65.3k tok | 6% ctx",
];

test("两个词的工具名（Web Search）算工具调用；「Thought for … (ctrl+o to expand)」不进预览", () => {
  const read = extractLiveReply(AFTER_WEB_SEARCH, "claude-code");
  assert.deepEqual(read?.lines, [
    "Tauri v2 当前最新版本为 2.12 系列（最新补丁 2.12.1），其中 2.12.0 于 2026 年 9 月 26 日发布。",
    "另外 3.0.0-alpha.2 已处于早期预览阶段，但不属于稳定版。",
    "",
    "来源链接：",
    "- Announcing Tauri 2.12（官方博客） (https://v2.tauri.app/blog/tauri-2.12)",
    "- crates.io — tauri (https://crates.io/crates/tauri)",
  ]);
  const text = (read?.lines ?? []).join("\n");
  assert.ok(!/Thought for|ctrl\+o|Web Search\(|Fetch\(|Baked for/.test(text), text);
});

test("会话里已经有这段回复时，预览整段让位（不再把同一段话在下面又贴一遍）", () => {
  const live = extractLiveReply(AFTER_WEB_SEARCH, "claude-code")?.lines ?? [];
  const synced =
    "**Tauri v2 当前最新版本为 2.12 系列（最新补丁 2.12.1）**，其中 2.12.0 于 2026 年 9 月 26 日发布。\n另外 3.0.0-alpha.2 已处于早期预览阶段，但不属于稳定版。\n\n来源链接：\n- [Announcing Tauri 2.12（官方博客）](https://v2.tauri.app/blog/tauri-2.12)\n- [crates.io — tauri](https://crates.io/crates/tauri)";
  assert.deepEqual(unsyncedTail(live, synced), []);
});

test("正文里以「⏺ Note (…)」这类带括号的英文开头不会被当成工具调用", () => {
  const rows = ["❯ hi", "⏺ Note (important): 先备份再操作。", "  第二行。", RULE, "❯", RULE];
  assert.deepEqual(extractLiveReply(rows, "claude-code")?.lines, ["Note (important): 先备份再操作。", "第二行。"]);
});

test("工具输出里折叠的「… +12 lines (ctrl+o to expand)」也不进预览", () => {
  const rows = ["❯ hi", "⏺ Bash(ls)", "  ⎿  a.txt", "     … +12 lines (ctrl+o to expand)", "", "⏺ 列好了。", RULE, "❯", RULE];
  assert.deepEqual(extractLiveReply(rows, "claude-code")?.lines, ["列好了。"]);
});

// 2026-10-20 用户 Windows 实测（Claude Code 2.1.304）：转圈下面的提示长过一行，折下来的第二行没有「⎿」，
// 原先被当成回复一直挂在预览里
test("Claude 转圈下「⎿  Tip:」折行的续行不进预览", () => {
  const rows = [
    "❯ 你好",
    "",
    "⏺ 我先想一想。",
    "  第二行。",
    "    - 缩进深的列表项照常保留",
    "",
    "✻ Pondering… (3s · ↓ 20 tokens)",
    "  ⎿  Tip: You can control how big a workflow is just by prompting. Ask for a small workflow, cap",
    '     it with "use at most 5 agents", or set a default with Dynamic workflow size in /config.',
    "",
    RULE,
    "❯",
    RULE,
  ];
  assert.deepEqual(extractLiveReply(rows, "claude-code")?.lines, [
    "我先想一想。",
    "第二行。",
    "  - 缩进深的列表项照常保留",
  ]);
});

// 聊天层据此认「审批已经答过」（chat-channel.ts hooksApprovalAnswered）：Claude 的审批菜单顶掉输入框，
// 答完输入框回来（菜单样本同 tests/tui-menu.test.ts，Claude Code 2.1.292 PTY 实录）
test("Claude：审批菜单挂着时屏上没有输入框，答完回到输入框", () => {
  const approving = [
    "❯ 写个文件",
    "",
    "⏺ Bash(echo mesa > a.txt)",
    "  ⎿  Waiting…",
    RULE,
    " Bash command",
    " echo mesa > a.txt",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. No",
    " Esc to cancel · Tab to amend",
  ];
  assert.equal(terminalHasInputBox(approving, "claude-code"), false);
  assert.equal(terminalHasInputBox(STREAMING, "claude-code"), true);
  assert.equal(terminalHasInputBox(STREAMING, "codebuddy"), null, "没有画面布局的家：不知道");
});

// 2026-10-19 用户截图（Codex 0.163）：多行提问的回显续行、审批结果行、失败命令行都不是回复
test("Codex：多行提问的回显续行不进预览", () => {
  const screen = [
    "› 不要调用任何工具。请按下面清单原样输出一段 Markdown：",
    "  1. 三个二级标题（## 开头）",
    "  2. 一个两层嵌套的无序列表，和一个有序列表",
    "",
    "• Working (6s • esc to interrupt)",
    "",
    "› Ask Codex to do anything",
  ];
  // 回显在第一行，可能是钉住的提问：这一轮刚开始（还没有上一次）时按真回显读，走与 TerminalPage 相同的 merge
  const live = (rows: string[]) => {
    const read = extractLiveReply(rows, "codex");
    return read ? mergeLiveReply(null, read) : null;
  };
  assert.equal(live(screen), null);
  const answering = [...screen.slice(0, 4), "• ## Markdown 语法基础", "", "› Ask Codex to do anything"];
  assert.deepEqual(live(answering), ["## Markdown 语法基础"]);
});

test("Codex：审批结果行与失败命令（含续行）不进预览", () => {
  const screen = [
    "› 联网搜索 Tauri v2 当前最新的版本号",
    "",
    '• Failed (exit 6) curl -s --max-time 20 -o /tmp/r.json "https://api.g…',
    "  └ + Show details",
    "",
    "• 网络又临时失败了，重试一次：",
    "",
    '✔ You approved codex to run curl -s --max-time 20 -o /tmp/r.json "HTTP …',
    "  this time",
    "",
    "• Ran curl -s --max-time 20 -o /tmp/r.json",
    "  └ published_at: 2026-10-14T18:52:14Z",
    "",
    "• 已确认。查询结果如下：",
    "",
    "› Ask Codex to do anything",
  ];
  assert.deepEqual(extractLiveReply(screen, "codex")?.lines, [
    "网络又临时失败了，重试一次：",
    "",
    "已确认。查询结果如下：",
  ]);
});

// 2026-10-19 用户：Codex 长回复预览卡在第 22 行 / 只剩下半截。抓屏（chat-capture.py，REPLY_PROMPT=TRIGGER_LONG）：
// 回复长过一屏后 Codex 把提问钉在第一行（多行提问拼成一行），下一行直接是回复中段
const CODEX_BOTTOM = ["", "", "› Ask Codex to do anything", "", "  e2e-picked high · /tmp/work"];
const nth = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => `第 ${a + i} 行：长回复逐行流出。`);

test("Codex：钉在屏顶的提问不当这一轮的开头，接着上一次往下拼", () => {
  const first = extractLiveReply(
    ["› TRIGGER_LONG 写长一点", "", "", ...nth(1, 5).map((l, i) => (i ? `  ${l}` : `• ${l}`)), ...CODEX_BOTTOM],
    "codex",
  )!;
  assert.deepEqual(first.lines, nth(1, 5));
  const pinned = extractLiveReply(["› TRIGGER_LONG 写长一点", ...nth(3, 8).map((l) => `  ${l}`), ...CODEX_BOTTOM], "codex")!;
  assert.equal(pinned.anchored, false);
  assert.deepEqual(mergeLiveReply(first.lines, pinned), nth(1, 8));
  // 回复第一行刚好贴在钉住的提问下面（真回显下面总有空行）
  const touching = extractLiveReply(["› TRIGGER_LONG 写长一点", `• ${nth(1, 1)[0]}`, ...nth(2, 6).map((l) => `  ${l}`), ...CODEX_BOTTOM], "codex")!;
  assert.deepEqual(mergeLiveReply(first.lines, touching), nth(1, 6));
});

test("Codex：钉住的提问下面正好是回复里的空行，不把下半截当整段", () => {
  const prev = ["## 第一节", "第一节正文", "", "## 第二节", "第二节正文"];
  const screen = ["› 按清单输出一段 Markdown", "", "  第二节正文", "", "  - 列表项", ...CODEX_BOTTOM];
  const read = extractLiveReply(screen, "codex")!;
  assert.equal(read.anchored, false);
  assert.deepEqual(mergeLiveReply(prev, read), [...prev, "", "- 列表项"]);
});

test("Codex：多行提问的真回显刚好滚到第一行，续行仍不进预览", () => {
  const prev = nth(1, 2);
  const screen = [
    "› TRIGGER_LONG 第一行提问",
    "    1. 第二行清单",
    "",
    "",
    `• ${nth(1, 1)[0]}`,
    ...nth(2, 3).map((l) => `  ${l}`),
    ...CODEX_BOTTOM,
  ];
  const read = extractLiveReply(screen, "codex")!;
  assert.deepEqual(mergeLiveReply(prev, read), nth(1, 3));
});

test("接续时上一次的最后一行只写了半截，写全后不重复", () => {
  const merged = mergeLiveReply(["第一行写完了", "第二行写到一"], { lines: ["第二行写到一半又写完", "第三行"], anchored: false });
  assert.deepEqual(merged, ["第一行写完了", "第二行写到一半又写完", "第三行"]);
});

// 2026-10-20 Windows 11 ConPTY 抓屏（scripts/e2e-model-routing/chat-capture.py + pywinpty，假网关慢速吐字）
test("Windows：Claude Code 的正文行首是 ●（不是 ⏺），右对齐的「● high · /effort」仍算状态", () => {
  const rows = [
    " ▐▛███▛█   Claude Code v2.1.304",
    "▝▜██████▀  e2e-picked with high effort · API Usage Billing",
    " ▝▝   ▝▝   ~\work",
    "❯ TRIGGER_SLOW 讲一段",
    "● 第一段：这是一段慢慢流出来的回复。",
    "  - 要点一：终端先画出来",
    "  - 要点二：会话文件后落盘",
    "                                                  ● high · /effort",
    "✻ Worked for 6s · done 21:12",
    RULE,
    "❯",
    RULE,
    "  ⏸ manual mode on · ? for shortcuts",
  ];
  const read = extractLiveReply(rows, "claude-code");
  assert.deepEqual(read?.lines, ["第一段：这是一段慢慢流出来的回复。", "- 要点一：终端先画出来", "- 要点二：会话文件后落盘"]);
});

test("Windows：Grok 回显与输入框是 >、工具是 ♦、代码块标签是 ○", () => {
  const box = "─".repeat(60);
  const rows = [
    "  ~/work                                                     6 / 256K │ [Dashboard]",
    "     > TRIGGER_SLOW 讲一段                                    9:13 PM",
    "     第一段：这是一段慢慢流出来的回复。                         9:13 PM",
    "     • 要点一：终端先画出来",
    "     echo mesa",
    "     ○ bash   [Copy]",
    "     ♦ Running 写一个探针文件",
    "     最后一行：完毕。",
    "     Worked for 6.3s",
    `  ╭${box}╮`,
    "  │ > ok" + " ".repeat(54) + "│",
    `  ╰${box}╯`,
    "  Tab/→:accept suggestion  │  Shift+Tab:mode  │  Ctrl+x:shortcuts",
  ];
  const read = extractLiveReply(rows, "grok");
  assert.deepEqual(read?.lines, ["第一段：这是一段慢慢流出来的回复。", "• 要点一：终端先画出来", "echo mesa", "最后一行：完毕。"]);
});

test("回显还没出来（提问排着队）、屏顶是启动横幅时不预览——横幅不是回复", () => {
  const top = "▄".repeat(60);
  const bottom = "▀".repeat(60);
  const rows = [
    " ▝▜▄     Gemini CLI v0.64.0",
    "   ▝▜▄",
    "Tips for getting started:",
    "1. Create GEMINI.md files to customize your interactions",
    "ℹ Waiting for MCP servers to initialize... Slash commands are still available and prompts will be queued.",
    "  Queued (press ↑ to edit):",
    "    TRIGGER_SLOW 讲一段",
    " Shift+Tab to accept edits                                   1 MCP server",
    top,
    " >   Type your message or @path/to/file",
    bottom,
  ];
  assert.equal(extractLiveReply(rows, "gemini"), null);
});

test("claudeOutputTokens：转圈行里已生成的 token 数（2026-10-21 Windows 抓屏原样）", () => {
  const screen = (status: string) => ["❯ TRIGGER_SLOW 讲一段", status, RULE, "❯", RULE];
  assert.equal(claudeOutputTokens(screen("✶ Musing… (5s · ↓ 20 tokens)")), 20);
  assert.equal(claudeOutputTokens(screen("· Simmering… (2s · ↓ 12 tokens)")), 12);
  assert.equal(claudeOutputTokens(screen("✻ Thinking… (1m 3s · ↓ 1.2k tokens · esc to interrupt)")), 1200);
  // 上传方向、收尾行、没有转圈：不算
  assert.equal(claudeOutputTokens(screen("✢ Musing… (0s · ↑ 3.4k tokens)")), null);
  assert.equal(claudeOutputTokens(screen("✻ Sautéed for 1m 20s · done 10:44")), null);
  assert.equal(claudeOutputTokens(["❯ hello", RULE, "❯", RULE]), null);
});

// 2026-10-21 Windows ConPTY 抓屏（Grok 1.0.62，假网关）：七行清单提问被折成三行（末行「2. … …」），
// 回复长过一屏后提问钉在屏顶（sticky header），下面一行「▲」是滚动提示，再往下是回复的后半截
const GROK_BOX = [
  "  ╭" + "─".repeat(60) + "╮",
  "  │ >" + " ".repeat(57) + "│",
  "  ╰" + "─".repeat(48) + " e2e-picked ─╯",
];
const GROK_STICKY = [
  "",
  "  ~/work                                                     1.6K / 256K │ [Dashboard]",
  "",
  "",
  "     > TRIGGER_LONG 在当前目录依次完成，每一步用一句话汇报：                 5:50 PM",
  "       1. 新建 mesa_probe/hello.py，内容是打印 hello 和当前时间",
  "       2. 列出 mesa_probe 目录 …",
  "",
  "                                                            ▲",
  "     第 4 步：在 mesa_probe 里搜到 \"hello\" 一词，仅出现在 hello.py 第 3 行。",
  "",
  "     第 5 步：已把 hello.py 中的 \"hello\" 改为 \"hello Mesa\"。                      █",
  "                                                                                     █",
  "    - Responding… 4.1s                                              4.2s ↓1.57k [stop]",
  "",
  ...GROK_BOX,
  "",
  "  Shift+Tab:mode  │  Ctrl+c:cancel  │  Ctrl+x:shortcuts",
];

test("Grok：多行提问的续行（含钉在屏顶、折成「… …」的）不是回复，滚动提示 ▲ 也不是", () => {
  const read = extractLiveReply(GROK_STICKY, "grok");
  assert.deepEqual(read?.lines, [
    "第 4 步：在 mesa_probe 里搜到 \"hello\" 一词，仅出现在 hello.py 第 3 行。",
    "",
    "第 5 步：已把 hello.py 中的 \"hello\" 改为 \"hello Mesa\"。",
  ]);
  // 没滚动时同样：提问三行之后两个空行才是回复
  const fresh = [
    "     > 在当前目录依次完成，每一步用一句话汇报：                              5:50 PM",
    "       1. 新建 mesa_probe/hello.py，内容是打印 hello 和当前时间",
    "       2. 列出 mesa_probe 目录 …",
    "",
    "",
    "     第 1 步：已创建 mesa_probe/hello.py。                                   5:50 PM",
    "",
    "    - Responding… 1.2s",
    ...GROK_BOX,
  ];
  assert.deepEqual(extractLiveReply(fresh, "grok")?.lines, ["第 1 步：已创建 mesa_probe/hello.py。"]);
});

test("unsyncedTail：开头混进的非回复行不把后面已落盘的段落拖进预览；短行不当锚", () => {
  const synced = "第 4 步：在 `mesa_probe` 里搜到 \"hello\" 一词，仅出现在 `hello.py` 第 3 行。\n第 5 步：已把 `hello.py` 中的 `\"hello\"` 改为 `\"hello Mesa\"`。";
  const live = [
    "  1. 新建 mesa_probe/hello.py，内容是打印 hello 和当前时间",
    "第 4 步：在 mesa_probe 里搜到 \"hello\" 一词，仅出现在 hello.py 第 3 行。",
    "",
    "第 5 步：已把 hello.py 中的 \"hello\" 改为 \"hello Mesa\"。",
  ];
  assert.deepEqual(unsyncedTail(live, synced), []);
  assert.deepEqual(unsyncedTail([...live, "", "第 6 步：已读取"], synced), ["第 6 步：已读取"]);
  // 「好的」这种短行到处对得上：它后面的新内容照常显示，前面的也不被它吞掉
  assert.deepEqual(unsyncedTail(["新的一段还没落盘", "好的"], "好的，我来看看。"), ["新的一段还没落盘", "好的"]);
});

test("Kimi 2.3 等首字时的月相转圈「🌑 · Tip: …」不进预览（2026-10-21 抓屏）", () => {
  const screen = [" ❯ 你好", " ", "  🌑 · Tip: /tasks to check progress and status for background tasks", ...BOX(">")];
  assert.equal(extractLiveReply(screen, "kimi"), null);
  const after = [" ❯ 你好", " ", " ● 你好！", "  🌕 · Tip: @: mention files", ...BOX(">")];
  assert.deepEqual(extractLiveReply(after, "kimi")?.lines, ["你好！"]);
});

test("Qwen 0.25.3 字形后带变体选择符「◆︎」「∴︎」：行首符号照认，思考折叠行不进预览", () => {
  const screen = [
    "  > 你好",
    "",
    "  ∴︎ Thought for 1s (click or ctrl+o to expand)",
    "",
    "  ◆︎ 你好！我是 Qwen Code，可以帮你处理编程任务。",
    "─".repeat(60),
    ">   输入您的消息或 @ 文件路径",
    "─".repeat(60),
  ];
  assert.deepEqual(extractLiveReply(screen, "qwen")?.lines, ["你好！我是 Qwen Code，可以帮你处理编程任务。"]);
});

test("Gemini 0.65 输入框上方的提示行（随权限档变字、带技能数、粘贴提示）不进预览", () => {
  const screen = [
    "▄".repeat(60),
    " > 在当前目录依次完成：",
    "   1. 新建 hello.py",
    "▀".repeat(60),
    " Press Ctrl+O to expand pasted text",
    "✦ 第一步完成。",
    "? for shortcuts",
    "─".repeat(60),
    " auto-accept edits Shift+Tab to manual                    1 MCP server · 20 skills",
    "▄".repeat(60),
    " >   Type your message or @path/to/file",
    "▀".repeat(60),
  ];
  assert.deepEqual(extractLiveReply(screen, "gemini")?.lines, ["第一步完成。"]);
});

// 2026-10-22 长回复回放（chat-capture.py CAP_RAW=1 + live-replay.ts，Gemini 0.65 / Grok 1.0.62，100×32）
const GEMINI_BOX = (prompt: string) => ["▄".repeat(60), ` ${prompt}   Type your message or @path/to/file`, "▀".repeat(60)];
const GEMINI_TABLE = [
  "  ┌──────┬──────────┬────────┐",
  "  │ 项目 │ 内容     │ 状态   │",
  "  ├──────┼──────────┼────────┤",
  "  │ 目标 │ 明确结果 │ 进行中 │",
  "  └──────┴──────────┴────────┘",
];

test("Gemini：完全访问（YOLO）输入框行首是「*」、shell 模式是「!」，照样认得出输入框", () => {
  const reply = ["▄".repeat(60), " > TRIGGER_LONG 写长一点", "▀".repeat(60), "✦ 一、关于观察与思考", "", "  日常生活中的许多变化。"];
  const tail = ["  Thinking... (esc to cancel, 8s)                ? for shortcuts", "─".repeat(60), " YOLO Ctrl+Y"];
  for (const prompt of ["*", "!", ">", "(r:)"]) {
    const screen = [...reply, ...tail, ...GEMINI_BOX(prompt)];
    assert.equal(terminalHasInputBox(screen, "gemini"), true, prompt);
    assert.deepEqual(extractLiveReply(screen, "gemini")?.lines, ["一、关于观察与思考", "", "日常生活中的许多变化。"], prompt);
  }
});

test("Gemini：回复里的表格（直角框）进预览，工具框（圆角）照旧不进", () => {
  const screen = [
    "▄".repeat(60),
    " > 列个表再跑一下",
    "▀".repeat(60),
    "✦ 结果如下：",
    "",
    ...GEMINI_TABLE,
    "",
    "  表格之后的一句。",
    "╭──────────────────────────────╮",
    "│ ✓  Shell echo mesa           │",
    "│ ┌──┐ 命令输出里的框也不算     │",
    "╰──────────────────────────────╯",
    "✦ done",
    ...GEMINI_BOX("*"),
  ];
  assert.deepEqual(extractLiveReply(screen, "gemini")?.lines, [
    "结果如下：",
    "",
    ...GEMINI_TABLE.map((l) => l.slice(2)),
    "",
    "表格之后的一句。",
    "done",
  ]);
  // 表格上沿卷出屏：下面的 ├ / └ 照样认得出是表格
  const scrolled = [...GEMINI_TABLE.slice(1).map((l) => l), "", "  表格之后的一句。", ...GEMINI_BOX(">")];
  assert.deepEqual(extractLiveReply(scrolled, "gemini")?.lines, [...GEMINI_TABLE.slice(1).map((l) => l.slice(2)), "", "表格之后的一句。"]);
  // Codex 工具输出的「└ total 8」不是表格
  assert.deepEqual(extractLiveReply(["› 看看", "• Ran ls", "  └ total 8", "• 好了。", "› Ask Codex to do anything"], "codex")?.lines, ["好了。"]);
});

test("Grok：提问钉在屏顶、下面是「▲」时屏上只是一截，接到上一次后面；裁掉开头的过渡帧不丢开头", () => {
  assert.equal(extractLiveReply(GROK_STICKY, "grok")?.anchored, false);
  const echo = "     ❯ TRIGGER_LONG 写长一点                                    10:18 AM";
  const body = (lines: string[]) => lines.map((l) => (l ? `     ${l}` : ""));
  const first = extractLiveReply([echo, "", "", ...body(["一、关于观察与思考", "", "第一行。", "第二行。", "第三行。"]), ...GROK_BOX], "grok")!;
  assert.equal(first.anchored, true);
  // 卷动的过渡帧：回显还在、头两行已被裁掉，「▲」还没画——看着像「看得见开头」，开头要留着
  const clipped = extractLiveReply([echo, "", "", "", "", ...body(["第一行。", "第二行。", "第三行。", "第四行。"]), ...GROK_BOX], "grok")!;
  assert.equal(clipped.anchored, true);
  const merged = mergeLiveReply(first.lines, clipped)!;
  assert.deepEqual(merged, ["一、关于观察与思考", "", "第一行。", "第二行。", "第三行。", "第四行。"]);
  // 画出「▲」之后：只是一截，照样接上
  const pinned = extractLiveReply([echo, "", "                    ▲", ...body(["第三行。", "第四行。", "第五行。"]), ...GROK_BOX], "grok")!;
  assert.equal(pinned.anchored, false);
  assert.deepEqual(mergeLiveReply(merged, pinned), [...merged, "第五行。"]);
  // 看得见开头、开头又和上一次一样：以屏上为准（不受上一次影响）
  assert.deepEqual(mergeLiveReply(["一、关于观察与思考", "旧的第二行"], first), first.lines);
});

test("长回复：屏顶正好是表格下沿和空行时，下沿和空行不接出两份", () => {
  const prev = ["│ 复盘 │ 待开始 │", "└──────┴────────┘", "", "结构化表达能够让复杂的信息更容易被理解。"];
  const screen = ["└──────┴────────┘", "", "结构化表达能够让复杂的信息更容易被理解。", "标题适合标记主题。"];
  assert.deepEqual(mergeLiveReply(prev, { lines: screen, anchored: false }), [prev[0], ...screen]);
});

test("staleEcho：刚发的这句还没画出来时，读到的是上一轮回显后面的回复", () => {
  const before = ["  > 你好", "", "  ◆ 你好！有什么可以帮你？", "─".repeat(60), ">   打字", "─".repeat(60)];
  const read = extractLiveReply(before, "qwen")!;
  assert.equal(read.echo, "  > 你好");
  // 发送前屏上最后一条回显就是它，又不像刚发的话：上一轮的
  assert.equal(staleEcho(read, "  > 你好", "讲个笑话"), true);
  // 新回显出来了：这一轮的
  const now = extractLiveReply(["  > 讲个笑话", "", "  ◆ 从前有座山", ...before.slice(3)], "qwen")!;
  assert.equal(staleEcho(now, "  > 你好", "讲个笑话"), false);
  // 重复发同一句：认作新的；发送前屏上没有回显：不拦
  assert.equal(staleEcho(read, "  > 你好", "你好"), false);
  assert.equal(staleEcho(read, null, "讲个笑话"), false);
});
