import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRecoverableTerminalState,
  serializeRecoverableTerminalState,
} from "../src/terminal-tab-persistence.ts";

test("recoverable terminal metadata round-trips without runtime fields", () => {
  const raw = serializeRecoverableTerminalState({
    tabs: [
      {
        label: "任务一",
        cwd: "/repo/task-one",
        agentId: "codex",
        profileId: "profile-1",
        model: "gpt-5-codex",
        sessionId: "session-1",
        runId: "run-keep",
        taskId: "task-keep",
        ptyId: "must-not-persist",
        extraEnv: { API_KEY: "must-not-persist" },
      } as never,
    ],
    activeIndex: 0,
  });
  assert.equal(raw.includes("ptyId"), false);
  assert.equal(raw.includes("API_KEY"), false);
  assert.deepEqual(parseRecoverableTerminalState(raw), {
    tabs: [
      {
        label: "任务一",
        cwd: "/repo/task-one",
        agentId: "codex",
        profileId: "profile-1",
        model: "gpt-5-codex",
        sessionId: "session-1",
        runId: "run-keep",
        taskId: "task-keep",
      },
    ],
    activeIndex: 0,
  });
});

test("grok 终端标签在重启恢复白名单内", () => {
  const raw = serializeRecoverableTerminalState({
    tabs: [
      {
        label: "Grok Build",
        cwd: "/repo",
        agentId: "grok",
        profileId: "p1",
        model: "",
        sessionId: null,
      },
    ],
    activeIndex: 0,
  });
  const parsed = parseRecoverableTerminalState(raw);
  assert.equal(parsed.tabs.length, 1);
  assert.equal(parsed.tabs[0].agentId, "grok");
});

test("damaged, future and incomplete states fall back safely", () => {
  assert.deepEqual(parseRecoverableTerminalState("not-json"), { tabs: [], activeIndex: 0 });
  assert.deepEqual(parseRecoverableTerminalState('{"version":2,"tabs":[]}'), {
    tabs: [],
    activeIndex: 0,
  });
  const parsed = parseRecoverableTerminalState(
    JSON.stringify({
      version: 1,
      activeIndex: 99,
      tabs: [
        { label: "缺目录", agentId: "codex" },
        { label: "可恢复", cwd: "/repo", agentId: "codex" },
      ],
    }),
  );
  assert.equal(parsed.tabs.length, 1);
  assert.equal(parsed.activeIndex, 0);
  assert.equal(parsed.tabs[0].profileId, "");
  assert.equal(parsed.tabs[0].sessionId, null);
});

test("工作区标签的复用键 ws: 跨重启保留（去终端回答 / 继续回到同一个标签），别的复用键不留", () => {
  const base = { label: "文献精读与笔记", cwd: "C:\Users\me\ccode\workspaces\HER\lit-notes", agentId: "claude-code", profileId: "p", model: "", sessionId: "s1" };
  const raw = serializeRecoverableTerminalState({
    tabs: [
      { ...base, reuseKey: "ws:C:\Users\me\ccode\workspaces\HER\lit-notes" },
      { ...base, reuseKey: "quick-chat:claude-code" },
    ],
    activeIndex: 0,
  });
  const back = parseRecoverableTerminalState(raw);
  assert.equal(back.tabs[0].reuseKey, "ws:C:\Users\me\ccode\workspaces\HER\lit-notes");
  assert.equal(back.tabs[1].reuseKey, undefined);
});
