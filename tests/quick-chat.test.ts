import assert from "node:assert/strict";
import test from "node:test";
import {
  chatChoiceForProfile,
  isBlankChatTab,
  isNewChatKey,
  isScratchCwd,
  isThrowawayTab,
  codexSandboxCoversHome,
  pickQuickChatDefault,
  profileCanAutoStart,
  sessionHomeLabel,
  sessionDisplayTitle,
} from "../src/quick-chat.ts";
import type { SessionMetaDto } from "../src/types.ts";

function session(over: Partial<SessionMetaDto>): SessionMetaDto {
  return {
    agent: "claude-code",
    sessionId: "s-x",
    projectPath: "/repo/sub",
    title: "标题",
    createdAt: null,
    updatedAt: null,
    filePath: "/f",
    tokenUsage: null,
    cliVersion: null,
    pinned: false,
    archived: false,
    customTitle: null,
    tags: [],
    alive: true,
    chainCount: 1,
    workspace: null,
    stepName: null,
    summary: null,
    live: false,
    source: "cli",
    internal: false,
    handoffFromAgent: null,
    handoffFromSession: null,
    taskId: null,
    taskName: null,
    ...over,
  };
}

const SCRATCH = "/Users/u/ccode/scratch";

test("归属标注：工作区会话显工作区名，否则目录尾段", () => {
  assert.equal(
    sessionHomeLabel(session({ workspace: "lit-search" })),
    "⛁ lit-search",
  );
  assert.equal(sessionHomeLabel(session({ projectPath: "/repo/sub" })), "sub");
  assert.equal(
    sessionHomeLabel(session({ projectPath: "/repo/sub/" })),
    "sub",
    "尾斜杠不影响",
  );
});

test("标题优先级：自定义 > 会话标题 > 摘要 > 兜底", () => {
  assert.equal(
    sessionDisplayTitle(session({ customTitle: "改过的", title: "原标题" })),
    "改过的",
  );
  assert.equal(sessionDisplayTitle(session({ title: "原标题" })), "原标题");
  assert.equal(
    sessionDisplayTitle(session({ title: null, summary: "AI 摘要" })),
    "AI 摘要",
  );
  assert.equal(
    sessionDisplayTitle(session({ title: null, summary: null })),
    "未命名对话",
  );
});

test("isScratchCwd 认家目录下 ccode/scratch，含子路径；Windows 折叠大小写", () => {
  assert.equal(isScratchCwd(""), false);
  assert.equal(isScratchCwd("/Users/u/ccode/scratch"), true);
  assert.equal(isScratchCwd("/Users/u/ccode/scratch/notes"), true);
  assert.equal(isScratchCwd("/Users/u/Documents/Ccode"), false);
  assert.equal(isScratchCwd("C:\\Users\\u\\ccode\\scratch", true), true);
  assert.equal(isScratchCwd("c:/users/u/ccode/scratch", true), true);
});

test("快速开聊自动路径：排除停用和已知失效配置，未知状态放行", () => {
  assert.equal(profileCanAutoStart({ connectionStatus: "ready" }), true);
  assert.equal(profileCanAutoStart({ connectionStatus: "catalog_stale" }), true);
  assert.equal(profileCanAutoStart({ connectionStatus: "probe_failed" }), false);
  assert.equal(profileCanAutoStart({ modelSyncStatus: "missing" }), false);
  assert.equal(profileCanAutoStart({ connectionStatus: "ready" }, true), false);
});

const AGENT_ORDER = ["claude-code", "codex", "gemini"];
const USABLE = [
  { id: "c1", agent: "claude-code", models: ["glm-5.3", "glm-5.3-flash"] },
  { id: "x1", agent: "codex", models: ["deepseek-v4"] },
  { id: "x2", agent: "codex", models: [] },
];

test("快速开聊默认：记住的连接还能用就照它开，模型在名单里才沿用，思考档跟着模型", () => {
  const base = { lastLaunch: {}, usable: USABLE, installed: ["claude-code", "codex"], agentOrder: AGENT_ORDER };
  assert.deepEqual(
    pickQuickChatDefault({
      ...base,
      remembered: { agentId: "codex", profileId: "x1", model: "deepseek-v4", effort: "high" },
    }),
    { agentId: "codex", profileId: "x1", model: "deepseek-v4", effort: "high" },
  );
  // 名单里没有这个模型了：不带模型和思考档（用连接默认）
  assert.deepEqual(
    pickQuickChatDefault({
      ...base,
      remembered: { agentId: "claude-code", profileId: "c1", model: "gone", effort: "xhigh" },
    }),
    { agentId: "claude-code", profileId: "c1" },
  );
  // 名单为空的连接（官方账号这类）：照记住的模型
  assert.deepEqual(
    pickQuickChatDefault({ ...base, remembered: { agentId: "codex", profileId: "x2", model: "gpt-x" } }),
    { agentId: "codex", profileId: "x2", model: "gpt-x", effort: null },
  );
});

test("快速开聊默认：记住的连接失效 → 同一家另一条 → 上次启动的 → 装了的第一家 → 任意一条", () => {
  const base = { usable: USABLE, agentOrder: AGENT_ORDER };
  assert.deepEqual(
    pickQuickChatDefault({ ...base, remembered: { agentId: "codex", profileId: "gone" }, lastLaunch: {}, installed: [] }),
    { agentId: "codex", profileId: "x1" },
  );
  assert.deepEqual(
    pickQuickChatDefault({
      ...base,
      remembered: { agentId: "gemini", profileId: "g1" },
      lastLaunch: { agentId: "codex", profileId: "x2" },
      installed: ["claude-code"],
    }),
    { agentId: "codex", profileId: "x2" },
  );
  assert.deepEqual(
    pickQuickChatDefault({ ...base, remembered: {}, lastLaunch: {}, installed: ["codex", "claude-code"] }),
    { agentId: "codex", profileId: "x1" },
  );
  assert.deepEqual(
    pickQuickChatDefault({ ...base, remembered: {}, lastLaunch: {}, installed: [] }),
    { agentId: "claude-code", profileId: "c1" },
  );
});

test("快速开聊默认：一条可用连接都没有时仍给出一家 Agent（输入框里提示去连接页）", () => {
  const base = { usable: [], lastLaunch: {}, agentOrder: AGENT_ORDER };
  assert.deepEqual(pickQuickChatDefault({ ...base, remembered: { agentId: "gemini" }, installed: ["codex"] }), {
    agentId: "gemini",
  });
  assert.deepEqual(pickQuickChatDefault({ ...base, remembered: {}, installed: ["codex"] }), { agentId: "codex" });
  assert.deepEqual(pickQuickChatDefault({ ...base, remembered: {}, installed: [] }), { agentId: "claude-code" });
});

test("空白标签：没起过进程、没接上会话、不是等接回的占位", () => {
  assert.equal(isBlankChatTab({}, undefined), true);
  assert.equal(isBlankChatTab({}, { alive: false, running: false, sessionId: null }), true);
  assert.equal(isBlankChatTab({}, { alive: true, running: true, sessionId: null }), false);
  // Agent 退出了但聊过：还留着会话 id，不算空白
  assert.equal(isBlankChatTab({}, { alive: false, running: false, sessionId: "s1" }), false);
  assert.equal(isBlankChatTab({ resumeSessionId: "s1" }, undefined), false);
});

test("codexSandboxCoversHome：只在 Windows + Codex + 主目录 + 非完全访问时提醒", () => {
  const base = { agentId: "codex", home: "C:\\Users\\me", permissionMode: "ask", isWindows: true };
  assert.equal(codexSandboxCoversHome({ ...base, cwd: "~" }), true);
  assert.equal(codexSandboxCoversHome({ ...base, cwd: "" }), true);
  assert.equal(codexSandboxCoversHome({ ...base, cwd: "c:/users/ME/" }), true);
  assert.equal(codexSandboxCoversHome({ ...base, cwd: "C:\\Users\\me", permissionMode: null }), true);
  assert.equal(codexSandboxCoversHome({ ...base, cwd: "C:\\Users\\me\\ccode\\scratch" }), false);
  assert.equal(codexSandboxCoversHome({ ...base, cwd: "~", permissionMode: "full" }), false);
  assert.equal(codexSandboxCoversHome({ ...base, cwd: "~", agentId: "claude-code" }), false);
  assert.equal(codexSandboxCoversHome({ ...base, cwd: "~", isWindows: false }), false);
});

test("连接页「新对话」：点哪条用哪条，模型取名单第一个，不看记住的默认", () => {
  assert.deepEqual(
    chatChoiceForProfile({ id: "p2", agent: "codex", models: ["gpt-5.6", "gpt-5.5"] }),
    { agentId: "codex", profileId: "p2", model: "gpt-5.6", effort: null },
  );
});

test("连接页「新对话」：名单为空或全是空白时不预选模型，也不带 model 键", () => {
  for (const models of [[], ["", "  "], null, undefined]) {
    const pick = chatChoiceForProfile({ id: "p", agent: "kimi", models });
    assert.equal(pick.agentId, "kimi");
    assert.equal(pick.profileId, "p");
    assert.ok(!("model" in pick), JSON.stringify(models));
  }
});

test("连接页「新对话」：跳过名单里的空白项取第一个有内容的", () => {
  assert.equal(
    chatChoiceForProfile({ id: "p", agent: "qwen", models: ["", "qwen3-coder"] }).model,
    "qwen3-coder",
  );
});

test("「新对话」开的空白标签：快速开聊与项目行 ＋（每次一把带 uuid 的键）都算，切走时没说话就收", () => {
  assert.equal(isNewChatKey("quickchat:1b2c"), true);
  assert.equal(isNewChatKey("research:/Users/u/测试项目:project:1b2c"), true);
  assert.equal(isNewChatKey("coding:C:\\repo:project:1b2c"), true);
  // 2026-10-24 前的项目对话键（同一项目共用一把）、问 AI、阅读：不算
  assert.equal(isNewChatKey("research:/Users/u/测试项目:project"), false);
  assert.equal(isNewChatKey("office:/p:notes/a.docx"), false);
  assert.equal(isNewChatKey(undefined), false);
  const blank = { reuseKey: "research:/p:project:1b2c" };
  assert.equal(isThrowawayTab(blank, null, false), true);
  assert.equal(isThrowawayTab(blank, null, true), false, "输入框里有字");
  assert.equal(isThrowawayTab(blank, { running: true }, false), false, "说过话了");
});
