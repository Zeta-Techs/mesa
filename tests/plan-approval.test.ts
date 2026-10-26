import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { isPlanMenu, latestPlanText, planChoice, planFeedbackText, planMenuTitle, screenPlan } from "../src/plan-approval.ts";
import { parseTuiMenu } from "../src/tui-menu.ts";
import type { ChatMessageDto } from "../src/types.ts";

// 四家真屏（tests/fixtures/plan-screens.json，假网关 TRIGGER_PLAN 抓的）
const SCREENS = JSON.parse(readFileSync(new URL("./fixtures/plan-screens.json", import.meta.url), "utf8")) as Record<string, string[]>;
const PLAN = "方案：写一个探针文件\n\n1. 在工作目录新建 mesa_probe.txt\n2. 写入一行 mesa\n3. 读回确认";
// OpenCode 的当前项只靠序号颜色：照 1.19.3 抓屏回放的字色（当前项序号 6a91c6、其余序号与说明 808080、按键提示 eeeeee）
const opencodeCells = (lines: string[]) => (row: number) => {
  const t = lines[row];
  const fg = /^\s*┃\s+1\. Yes/.test(t) ? "rgb:6a91c6" : /↑↓/.test(t) ? "rgb:eeeeee" : "rgb:808080";
  return [...t].map((ch) => ({ ch, dim: false, inverse: false, bg: true, fg }));
};
const read = (agent: string) => {
  const lines = SCREENS[agent];
  const menu = parseTuiMenu(lines, agent === "opencode" ? opencodeCells(lines) : undefined);
  assert.ok(menu, `${agent} 认出菜单`);
  const plan = screenPlan(lines, menu);
  return { menu: plan ? { ...menu, plan } : menu, plan };
};
const kinds = (options: string[]) => options.map((o, i) => planChoice(o, i)).map((c) => [c.kind, c.label, c.tier]);

// Claude Code 2.1.308 只讨论（--permission-mode plan）里写完方案、调 ExitPlanMode 后的那一屏（2026-10-26 假网关 TRIGGER_PLAN 抓屏，120 列）
const RULE = "─".repeat(120);
const DASH = "╌".repeat(120);
const PLAN_SCREEN = [
  "❯ TRIGGER_PLAN 写个方案",
  "",
  "⏺ Updated plan",
  "  ⎿  /plan to preview",
  "",
  RULE,
  " Ready to code?",
  "",
  " Here is Claude's plan:",
  DASH,
  " 方案：写一个探针文件",
  "",
  " 1. 在工作目录新建 mesa_probe.txt",
  " 2. 写入一行 mesa",
  " 3. 读回确认",
  DASH,
  RULE,
  "",
  " Claude has written up a plan and is ready to execute. Would you like to proceed?",
  "",
  " ❯ 1. Yes, and use auto mode",
  "   2. Yes, manually approve edits",
  "   3. Tell Claude what to change",
  "      shift+tab to approve with this feedback",
  "",
  " ctrl+g to edit in Vim · ~/.claude/plans/virtual-spinning-toucan.md",
];

test("认出方案确认那一屏：三项照原文、高亮第一项；按键提示不粘进第三项", () => {
  const menu = parseTuiMenu(PLAN_SCREEN);
  assert.ok(menu);
  assert.equal(menu.question, "Claude has written up a plan and is ready to execute. Would you like to proceed?");
  assert.deepEqual(menu.options, ["Yes, and use auto mode", "Yes, manually approve edits", "Tell Claude what to change"]);
  assert.equal(menu.selected, 0);
  assert.ok(isPlanMenu(menu, null), "旁路没到也凭问句认");
  assert.ok(isPlanMenu(menu, "ExitPlanMode"));
  assert.equal(planMenuTitle(menu, true), "方案写好了，按这个方案开工吗？");
});

test("没写方案文件就要退出计划模式：「Exit plan mode?」也认，标题不提方案", () => {
  const menu = parseTuiMenu([
    RULE,
    " Exit plan mode?",
    "",
    "  Claude wants to exit plan mode",
    "",
    "  ❯ 1. Yes, and switch to default (ask each time) for this session",
    "    2. No",
  ]);
  assert.ok(menu);
  assert.ok(isPlanMenu(menu, null));
  assert.equal(planMenuTitle(menu, false), "它想结束计划模式，开始动手吗？");
  const [go, no] = menu.options.map((o, i) => planChoice(o, i));
  assert.deepEqual([go.kind, go.tier, go.label], ["go", "ask", "按方案开工 · 请求批准"]);
  assert.deepEqual([no.kind, no.label], ["stay", "先不开工"]);
});

test("普通审批菜单不当方案确认；旁路说是 ExitPlanMode 但认不出开工项时也交回通用卡", () => {
  const bash = parseTuiMenu([RULE, " Bash command", "", "   echo mesa", "", " Do you want to proceed?", " ❯ 1. Yes", "   2. No"]);
  assert.ok(bash);
  assert.equal(isPlanMenu(bash, "Bash"), false);
  assert.equal(isPlanMenu({ question: "?", detail: null, options: ["好", "不好"], selected: 0 }, "ExitPlanMode"), false);
  assert.equal(isPlanMenu(null, "ExitPlanMode"), false);
});

test("开工选项说成中文、标出开工后按哪一档；认不出的照原文", () => {
  const pick = (t: string) => planChoice(t, 0);
  assert.deepEqual([pick("Yes, and use auto mode").label, pick("Yes, and use auto mode").tier], ["按方案开工 · 帮我批准", "auto"]);
  assert.deepEqual([pick("Yes, manually approve edits").label, pick("Yes, manually approve edits").tier], ["按方案开工 · 请求批准", "ask"]);
  assert.deepEqual([pick("Yes, and bypass permissions").label, pick("Yes, and bypass permissions").tier], ["按方案开工 · 完全访问", "full"]);
  const accept = pick("Yes, and auto-accept edits");
  assert.deepEqual([accept.label, accept.tier], ["按方案开工 · 自动改文件", null]);
  const clear = pick("Yes, clear context and use auto mode");
  assert.equal(clear.label, "清空上下文再开工 · 帮我批准");
  assert.match(clear.description ?? "", /清掉这段对话的上下文/);
  assert.deepEqual([pick("Yes, do something new").label, pick("Yes, do something new").description], ["按方案开工", "Yes, do something new"]);
  assert.deepEqual([pick("Tell Claude what to change").kind, pick("Tell Claude what to change").label], ["revise", "接着改方案"]);
  assert.deepEqual([pick("No, keep planning").kind, pick("Something else").kind, pick("Something else").label], ["stay", "other", "Something else"]);
});

test("方案原文兜底：这一轮最近一次 ExitPlanMode 的 plan；上一轮的不算", () => {
  const plan = (text: string, extra: Partial<ChatMessageDto> = {}): ChatMessageDto => ({
    role: "assistant",
    blocks: [{ kind: "tool_use", toolName: "ExitPlanMode", text: JSON.stringify({ plan: text, planFilePath: "/p.md" }) }],
    timestamp: null,
    usage: null,
    ...extra,
  });
  const user = (text: string): ChatMessageDto => ({ role: "user", blocks: [{ kind: "text", text, toolName: null }], timestamp: null, usage: null });
  assert.equal(latestPlanText([user("做个方案"), plan("# 旧"), plan("# 新")]), "# 新");
  assert.equal(latestPlanText([plan("# 上一轮"), user("改一下")]), null);
  assert.equal(latestPlanText([user("x"), { ...plan(""), blocks: [{ kind: "tool_use", toolName: "ExitPlanMode", text: "{坏" }] }]), null);
  assert.equal(latestPlanText([]), null);
});

test("改方案的意见压成一行、去掉控制字符（回车会把它交出去）", () => {
  assert.equal(planFeedbackText("  第一步换成\n写测试\t先\x1b[A  "), "第一步换成 写测试 先[A");
  assert.equal(planFeedbackText("\n\n"), "");
});

test("六家真屏：都认成方案确认，屏上读得到整篇方案（编号清单不当选项截断）", () => {
  const squash = (t: string | null | undefined) => (t ?? "").split("\n").map((l) => l.trim()).join("\n");
  for (const agent of ["claude-code", "codebuddy", "gemini", "kimi", "qwen"]) {
    const { menu, plan } = read(agent);
    assert.ok(isPlanMenu(menu, null), `${agent} 不靠旁路也认得出`);
    assert.equal(squash(plan?.text), squash(PLAN), `${agent} 屏上的方案`);
    assert.equal(planMenuTitle(menu, false), "方案写好了，按这个方案开工吗？");
  }
  // OpenCode 屏上只有「Plan at … is complete」与写文件的回显，方案原文从会话里写进 plans/ 的那次取
  const { menu, plan } = read("opencode");
  assert.equal(plan, null);
  assert.ok(isPlanMenu(menu, null));
  assert.equal(menu.selected, 0, "当前项靠序号颜色认出");
});

test("只靠颜色标当前项的菜单：颜色都一样或没有按键提示时不认（对话里的编号清单）", () => {
  const lines = SCREENS.opencode;
  const same = (row: number) => [...lines[row]].map((ch) => ({ ch, dim: false, inverse: false, bg: true, fg: "rgb:808080" }));
  assert.equal(parseTuiMenu(lines, same), null);
  const noHint = lines.filter((l) => !/↑↓/.test(l));
  assert.equal(parseTuiMenu(noHint, opencodeCells(noHint)), null);
  // 没有字色信息（来源给不出）也不猜
  assert.equal(parseTuiMenu(lines), null);
});

test("各家选项：开工后按哪一档、哪一项能写意见、哪一项要先回车", () => {
  assert.deepEqual(kinds(read("claude-code").menu.options), [
    ["go", "按方案开工 · 帮我批准", "auto"],
    ["go", "按方案开工 · 请求批准", "ask"],
    ["revise", "接着改方案", null],
  ]);
  // Gemini 每项下面一行说明被并进选项名，照样认
  assert.deepEqual(kinds(read("gemini").menu.options), [
    ["go", "按方案开工 · 自动改文件", null],
    ["go", "按方案开工 · 请求批准", "ask"],
    ["revise", "接着改方案", null],
  ]);
  const kimi = read("kimi").menu.options.map((o, i) => planChoice(o, i));
  assert.deepEqual(kimi.map((c) => [c.kind, c.label, Boolean(c.openFirst)]), [
    ["go", "按方案开工", false],
    ["stay", "先不开工", false],
    ["revise", "接着改方案", true],
  ]);
  assert.equal(kimi[0].description, "权限回到这家 CLI 自己的设置");
  assert.deepEqual(kinds(read("qwen").menu.options), [
    ["go", "按方案开工 · 回到原来的权限", "ask"],
    ["go", "按方案开工 · 自动改文件", null],
    ["go", "按方案开工 · 请求批准", "ask"],
    ["stay", "先不开工", null],
  ]);
  assert.equal(planChoice(read("qwen").menu.options[0], 0).description, "原来是「请求批准」：改文件、跑命令前都先问你");
  assert.deepEqual(kinds(read("opencode").menu.options), [
    ["go", "按方案开工", null],
    ["stay", "先不开工", null],
  ]);
  assert.equal(planChoice(read("opencode").menu.options[0], 0).description, "权限回到这家 CLI 自己的设置");
  assert.deepEqual(kinds(read("codebuddy").menu.options), [
    ["go", "按方案开工", null],
    ["stay", "先不开工", null],
    ["leave", "结束计划模式，先不开工", null],
  ]);
});

test("方案原文兜底：会话文件里写进 plans/ 的那一次（Kimi Write.path、Gemini write_file、CodeBuddy REPL 里的 Write）", () => {
  const user: ChatMessageDto = { role: "user", blocks: [{ kind: "text", text: "做个方案", toolName: null }], timestamp: null, usage: null };
  const call = (toolName: string, input: unknown): ChatMessageDto => ({
    role: "assistant",
    blocks: [{ kind: "tool_use", toolName, text: JSON.stringify(input) }],
    timestamp: null,
    usage: null,
  });
  assert.equal(latestPlanText([user, call("Write", { path: "/s/agents/main/plans/a.md", content: "# K" }), call("ExitPlanMode", {})]), "# K");
  assert.equal(latestPlanText([user, call("write_file", { file_path: "../x/plans/mesa-plan.md", content: "# G" }), call("exit_plan_mode", { plan_filename: "mesa-plan.md" })]), "# G");
  // Qwen：方案就在 exit_plan_mode 的 plan 里；OpenCode：write(filePath) 写进数据目录的 plans/
  assert.equal(latestPlanText([user, call("exit_plan_mode", { plan: "# Q" })]), "# Q");
  assert.equal(latestPlanText([user, call("write", { filePath: "/h/.local/share/opencode/plans/1-a.md", content: "# O" }), call("plan_exit", {})]), "# O");
  const code = `await Write({ file_path: "/h/.codebuddy/plans/q.md", content: "# C\\n\\n1. 一" }); return 'ok'`;
  assert.equal(latestPlanText([user, call("REPL", { code }), call("REPL", { code: "return await ExitPlanMode({})" })]), "# C\n\n1. 一");
  // 写的不是方案文件：不算
  assert.equal(latestPlanText([user, call("Write", { file_path: "/w/src/a.ts", content: "x" })]), null);
});

