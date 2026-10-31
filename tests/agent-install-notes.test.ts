import assert from "node:assert/strict";
import { test } from "node:test";
import { installNotes, isWingetMethod, wingetFailureHint } from "../src/agent-install-notes.ts";

const facts = { isWindows: true, proxyConfigured: false, gitMissing: false };
const codexWinget = "winget: winget install --id OpenAI.Codex -e --source winget";

test("winget 预览与结果里的 method 都认得出", () => {
  assert.ok(isWingetMethod(codexWinget));
  assert.ok(isWingetMethod("winget"));
  assert.ok(!isWingetMethod("npm: npm install -g @openai/codex"));
});

test("Codex / Grok 走 winget 时先说会弹管理员确认；npm 渠道与其他家不说", () => {
  assert.match(installNotes("codex", codexWinget, facts).join(), /管理员确认/);
  assert.match(installNotes("grok", "winget: winget install --id xAI.GrokBuild", facts).join(), /管理员确认/);
  assert.deepEqual(installNotes("opencode", "winget: winget install --id SST.opencode", facts), []);
  assert.deepEqual(installNotes("codex", "npm: npm install -g @openai/codex", facts), []);
  assert.deepEqual(installNotes("codex", codexWinget, { ...facts, isWindows: false }), []);
});

test("填了出网代理时提醒 winget 只认系统代理", () => {
  const notes = installNotes("opencode", "winget: winget install --id SST.opencode", { ...facts, proxyConfigured: true });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /系统代理/);
});

test("Windows 上缺 Git 时提醒 Claude Code 跑不了命令，与安装渠道无关", () => {
  assert.match(installNotes("claude-code", "npm: npm install -g @anthropic-ai/claude-code", { ...facts, gitMissing: true }).join(), /Git/);
  assert.deepEqual(installNotes("claude-code", "npm: npm install -g x", facts), []);
  assert.deepEqual(installNotes("codex", "npm: npm install -g x", { ...facts, gitMissing: true }), []);
});

test("winget 失败按中英文输出给下一步", () => {
  assert.match(wingetFailureHint("未能安装程序包依赖项。", "winget") ?? "", /管理员/);
  assert.match(wingetFailureHint("Failed to install package dependencies.", "winget") ?? "", /管理员/);
  assert.match(wingetFailureHint("下载安装程序失败", "winget") ?? "", /系统代理/);
  assert.match(wingetFailureHint("InternetOpenUrl() failed. 0x80072efd", "winget") ?? "", /系统代理/);
  assert.equal(wingetFailureHint("下载安装程序失败", "npm"), null);
  assert.equal(wingetFailureHint("已成功安装", "winget"), null);
});
