import assert from "node:assert/strict";
import test from "node:test";
import {
  continueRoute,
  keepWorkspaceResume,
  pickLiveWorkspaceSession,
  pickWorkspaceResume,
  shouldResumeWorkspaceSession,
  workspaceCarrySource,
} from "../src/workspace-resume.ts";
import type { SessionMetaDto } from "../src/types.ts";

function session(over: Partial<SessionMetaDto>): SessionMetaDto {
  return {
    agent: "claude-code",
    sessionId: "s-x",
    projectPath: "/repo",
    title: null,
    createdAt: null,
    updatedAt: null,
    filePath: "/f",
    tokenUsage: null,
    cliVersion: null,
    pinned: false,
    archived: false,
    customTitle: null,
    tags: [],
    alive: false,
    chainCount: 1,
    workspace: "lit-search",
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

test("去终端 resume：取该工作区最近活跃的一条（列表已降序，第一个命中即最新）", () => {
  const out = pickWorkspaceResume(
    [
      session({ sessionId: "s-new", workspace: "lit-search" }),
      session({ sessionId: "s-old", workspace: "lit-search" }),
    ],
    "lit-search",
    "/repo",
  );
  assert.deepEqual(out, { agentId: "claude-code", sessionId: "s-new" });
});

test("去终端 resume：工作区名与仓库路径都要匹配（路径去尾斜杠）", () => {
  const sessions = [
    session({ sessionId: "s-other-ws", workspace: "data-eda" }),
    session({
      sessionId: "s-other-repo",
      workspace: "lit-search",
      projectPath: "/other",
    }),
    session({ sessionId: "s-hit", workspace: "lit-search" }),
  ];
  const out = pickWorkspaceResume(sessions, "lit-search", "/repo/");
  assert.equal(out?.sessionId, "s-hit");
});

test("去终端 resume：项目根会话（无 workspace）不算该工作区的", () => {
  const out = pickWorkspaceResume(
    [session({ sessionId: "s-root", workspace: null })],
    "lit-search",
    "/repo",
  );
  assert.equal(out, null);
});

test("去终端 resume：排除归档 / 内部无头 / live 中的会话", () => {
  const out = pickWorkspaceResume(
    [
      session({ sessionId: "s-archived", archived: true }),
      session({ sessionId: "s-internal", internal: true }),
      session({ sessionId: "s-live", live: true }),
      session({ sessionId: "s-ok" }),
    ],
    "lit-search",
    "/repo",
  );
  assert.equal(out?.sessionId, "s-ok");
});

test("评审退回接回原会话，开工和按意见重写新开", () => {
  assert.equal(shouldResumeWorkspaceSession(), true);
  assert.equal(shouldResumeWorkspaceSession({ hasPrompt: true }), false);
  assert.equal(
    shouldResumeWorkspaceSession({ hasPrompt: true, resumeSession: true }),
    true,
  );
  assert.equal(
    shouldResumeWorkspaceSession({ hasPrompt: true, resumeSession: false }),
    false,
  );
});

test("去终端：步骤绑定是另一家 Agent 时不接回历史会话", () => {
  assert.equal(
    keepWorkspaceResume({
      sessionAgentId: "claude-code",
      stepAgentId: "codex",
    }),
    false,
  );
  assert.equal(
    keepWorkspaceResume({
      explicitResume: true,
      sessionAgentId: "claude-code",
      stepAgentId: "codex",
    }),
    true,
  );
  assert.equal(
    keepWorkspaceResume({
      sessionAgentId: "codex",
      stepAgentId: "codex",
    }),
    true,
  );
  assert.equal(
    keepWorkspaceResume({ sessionAgentId: "claude-code" }),
    true,
  );
  assert.equal(
    keepWorkspaceResume({ stepAgentId: "codex" }),
    false,
  );
});

test("换 Agent 继续：另一家的最近会话可带上，同一家或没有则不问", () => {
  const sessions = [
    session({ sessionId: "s-new", agent: "claude-code", filePath: "/f-new" }),
    session({ sessionId: "s-old", agent: "codex", filePath: "/f-old" }),
  ];
  assert.equal(
    workspaceCarrySource(sessions, "lit-search", "/repo", "codex")?.sessionId,
    "s-new",
  );
  assert.equal(
    workspaceCarrySource(sessions, "lit-search", "/repo", "claude-code"),
    null,
  );
  assert.equal(
    workspaceCarrySource(
      [session({ live: true, agent: "claude-code" })],
      "lit-search",
      "/repo",
      "codex",
    ),
    null,
  );
});

test("去终端 resume：全排除或无会话时返回 null（去终端降级为新标签）", () => {
  assert.equal(pickWorkspaceResume([], "lit-search", "/repo"), null);
  assert.equal(
    pickWorkspaceResume(
      [session({ live: true })],
      "lit-search",
      "/repo",
    ),
    null,
  );
});

test("步骤「继续」：上次是同一家 Agent 就接回原会话，另一家才问带不带，「新开一轮」直接新开", () => {
  const sessions = [
    session({ sessionId: "s-live", live: true }),
    session({ sessionId: "s-last", agent: "claude-code" }),
  ];
  // 还在跑的不接（resume 同一会话会冲突），取下一条
  assert.deepEqual(continueRoute(sessions, "lit-search", "/repo", "claude-code"), { kind: "resume", sessionId: "s-last" });
  const carry = continueRoute(sessions, "lit-search", "/repo", "codex");
  assert.equal(carry.kind, "carry");
  assert.equal(carry.kind === "carry" && carry.source.sessionId, "s-last");
  assert.deepEqual(continueRoute(sessions, "lit-search", "/repo", "claude-code", true), { kind: "fresh" });
  assert.deepEqual(continueRoute([], "lit-search", "/repo", "claude-code"), { kind: "fresh" });
  // 别的工作区的会话不算
  assert.deepEqual(continueRoute(sessions, "lit-notes", "/repo", "claude-code"), { kind: "fresh" });
});

test("去终端看看 / 回答：这一步有对话还在跑时认出它（交给终端页找持有的标签），不 resume 更早的那条", () => {
  const sessions = [
    session({ sessionId: "s-live", live: true }),
    session({ sessionId: "s-old" }),
  ];
  assert.deepEqual(pickLiveWorkspaceSession(sessions, "lit-search", "/repo/"), { agentId: "claude-code", sessionId: "s-live" });
  assert.equal(pickLiveWorkspaceSession([session({ sessionId: "s-old" })], "lit-search", "/repo"), null);
});
