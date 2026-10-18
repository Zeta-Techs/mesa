import assert from "node:assert/strict";
import test from "node:test";
import {
  isBlankChatTab,
  isScratchCwd,
  newTabCwd,
  pickQuickChatDefault,
  pickQuickChatHistory,
  pickQuickChatSessions,
  profileCanAutoStart,
  sessionHomeLabel,
  sessionDisplayTitle,
  withLiveSessionFlags,
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

test("随手聊历史：按顺序取前 N 条", () => {
  const list = Array.from({ length: 12 }, (_, i) =>
    session({ sessionId: `s-${i}`, projectPath: SCRATCH }),
  );
  const out = pickQuickChatSessions(list, [], 8);
  assert.equal(out.length, 8);
  assert.equal(out[0].sessionId, "s-0");
  assert.equal(out[7].sessionId, "s-7");
});

test("随手聊历史：排除归档/内部/live/源文件已删的（这些都恢复不了）", () => {
  const out = pickQuickChatSessions(
    [
      session({ sessionId: "s-archived", archived: true }),
      session({ sessionId: "s-internal", internal: true }),
      session({ sessionId: "s-live", live: true }),
      session({ sessionId: "s-gone", alive: false }),
      session({ sessionId: "s-ok", projectPath: SCRATCH }),
    ],
    [],
    8,
  );
  assert.deepEqual(
    out.map((s) => s.sessionId),
    ["s-ok"],
  );
});

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

test("随手聊历史：只列 scratch，排除工作区/已注册项目/其他仓库", () => {
  const out = pickQuickChatSessions(
    [
      session({ sessionId: "s-scratch", projectPath: SCRATCH }),
      session({
        sessionId: "s-ccode",
        projectPath: "/Users/u/Documents/Ccode",
      }),
      session({ sessionId: "s-ws", workspace: "lit-search", projectPath: SCRATCH }),
      session({
        sessionId: "s-project",
        projectPath: "/Users/u/papers/proj",
      }),
      session({ sessionId: "s-loose", projectPath: "/tmp/elsewhere" }),
    ],
    ["/Users/u/papers/proj/"],
  );
  assert.deepEqual(
    out.map((s) => s.sessionId),
    ["s-scratch"],
    "未注册的编码仓库、工作区、项目内会话都不算随手聊",
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

test("运行页「+」的目录跟当前标签走；主目录 / 没有 / Mesa 隔离目录不跟", () => {
  assert.equal(newTabCwd("/Users/me/proj"), "/Users/me/proj");
  assert.equal(newTabCwd("/Users/me/ccode/scratch"), "/Users/me/ccode/scratch");
  assert.equal(newTabCwd("~"), undefined);
  assert.equal(newTabCwd(""), undefined);
  assert.equal(newTabCwd(null), undefined);
  assert.equal(newTabCwd("/Users/me/ccode/workspaces/abc"), undefined);
  assert.equal(newTabCwd("/Volumes/D/ccode/worktrees/proj/lane-1"), undefined);
  assert.equal(newTabCwd("/Users/me/ccode/watch-worktrees/x"), undefined);
  assert.equal(newTabCwd("D:\\ccode\\worktrees\\p", true), undefined);
  assert.equal(newTabCwd("C:\\Users\\me\\proj", true), "C:\\Users\\me\\proj");
});

test("withLiveSessionFlags：终端页正在跑的会话补标 live", () => {
  const listed = session({ sessionId: "s-run", live: false });
  const out = withLiveSessionFlags([listed], {
    "claude-code\ns-run": "tab-1",
  });
  assert.equal(out[0].live, true);
  assert.equal(listed.live, false, "不改入参");
});

test("pickQuickChatHistory：正在跑的随手聊不进列表", () => {
  const out = pickQuickChatHistory(
    [
      session({ sessionId: "s-live", projectPath: SCRATCH, live: false }),
      session({ sessionId: "s-ok", projectPath: SCRATCH }),
    ],
    [],
    { "claude-code\ns-live": "tab-1" },
  );
  assert.deepEqual(
    out.map((s) => s.sessionId),
    ["s-ok"],
  );
});
