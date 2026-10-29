import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeReuseKey,
  compareRunIdentity,
  inferTaskKind,
  isDiscussPermission,
  isRunProcessLive,
  isWorkbenchActiveRun,
  isWorkbenchSurfaceRun,
  pickRecoverableRun,
} from "../src/run-model.ts";

test("canonicalizeReuseKey：wt: 升格为 lane:", () => {
  assert.equal(canonicalizeReuseKey("wt:/t"), "lane:/t");
  assert.equal(canonicalizeReuseKey("lane:/t"), "lane:/t");
});

test("inferTaskKind 按 reuseKey 前缀", () => {
  assert.equal(inferTaskKind("login:codex", "/x"), "login");
  assert.equal(inferTaskKind("reader:/p", "/p"), "reader");
  assert.equal(inferTaskKind("watch:s:/p", "/p"), "watch");
  assert.equal(inferTaskKind("office:/p:f", "/p"), "office_doc");
  assert.equal(inferTaskKind("ws:/wt", "/wt"), "pipeline_step");
  assert.equal(inferTaskKind("wt:/t", "/t"), "coding_lane");
  assert.equal(inferTaskKind("lane:/t", "/t"), "coding_lane");
  assert.equal(inferTaskKind("coding:/repo:project", "/repo"), "coding_lane");
  assert.equal(inferTaskKind("headless:ai-prompt:commit", "/tmp"), "scratch");
  assert.equal(inferTaskKind("", "/Users/a/ccode/scratch/x"), "scratch");
  assert.equal(
    inferTaskKind("", "/Users/a/ccode/workspaces/r/lit"),
    "pipeline_step",
  );
});

test("isWorkbenchSurfaceRun：登录与空闲 shell 不算正在进行", () => {
  assert.equal(
    isWorkbenchSurfaceRun({ reuseKey: "login:codex", running: true }),
    false,
  );
  assert.equal(
    isWorkbenchSurfaceRun({ reuseKey: "watch:1:/p", running: true }),
    false,
  );
  assert.equal(
    isWorkbenchSurfaceRun({ reuseKey: "headless:ai-prompt:x", running: true }),
    false,
  );
  assert.equal(
    isWorkbenchSurfaceRun({ shell: true, running: false, attention: null }),
    false,
  );
  assert.equal(
    isWorkbenchSurfaceRun({
      reuseKey: "ws:/wt",
      running: true,
      attention: "working",
    }),
    true,
  );
  assert.equal(
    isWorkbenchSurfaceRun({
      reuseKey: "reader:/p",
      running: false,
      shell: true,
    }),
    true,
  );
  assert.equal(
    isWorkbenchSurfaceRun({
      reuseKey: "custom:r1:/wt",
      shell: true,
      running: false,
    }),
    true,
  );
  assert.equal(
    isWorkbenchSurfaceRun({ running: true, attention: "working" }),
    true,
  );
});

test("isDiscussPermission：permission 优先于 readonly", () => {
  assert.equal(isDiscussPermission("discuss", false), true);
  assert.equal(isDiscussPermission("write_tree", true), false);
  assert.equal(isDiscussPermission(undefined, true), true);
});

test("isWorkbenchActiveRun：空闲老标签不进「正在进行」，主卡口径不受影响", () => {
  // 空闲挂着的任务标签（进程退出、无注意力、非 shell）：不算活
  assert.equal(
    isWorkbenchActiveRun({ reuseKey: "task:task-1", running: false, attention: null }),
    false,
  );
  assert.equal(
    isWorkbenchActiveRun({ reuseKey: "ws:/wt", running: false, attention: null }),
    false,
  );
  // 有活的任务标签照常：在跑 / 等确认 / 已跑完等你收 / 开着的交互 shell
  assert.equal(
    isWorkbenchActiveRun({ reuseKey: "task:task-1", running: true, attention: null }),
    true,
  );
  assert.equal(
    isWorkbenchActiveRun({ reuseKey: "task:task-1", running: false, attention: "confirm" }),
    true,
  );
  assert.equal(
    isWorkbenchActiveRun({ reuseKey: "task:task-1", running: false, attention: "done" }),
    true,
  );
  assert.equal(
    isWorkbenchActiveRun({ reuseKey: "reader:/p", running: false, shell: true }),
    true,
  );
  // 白名单外照旧不算；主卡口径（surface）仍保留死标签供找回
  assert.equal(isWorkbenchActiveRun({ reuseKey: "watch:1:/p", running: true }), false);
  assert.equal(isWorkbenchSurfaceRun({ reuseKey: "task:task-1", running: false, attention: null }), true);
});

test("自由任务标签按任务入口进入工作台白名单", () => {
  assert.equal(inferTaskKind("free:task-1", "/Users/me/project"), "free_research");
  assert.equal(
    isWorkbenchSurfaceRun({
      reuseKey: "task:task-1",
      running: true,
      attention: null,
    }),
    true,
  );
});

test("pickRecoverableRun：关标签后按项目找回可恢复 Run", () => {
  const caps = {
    canResume: true,
    canStop: true,
    streamsOutput: true,
    canReview: true,
    resumeReason: null,
  };
  const run = {
    id: "run-1",
    internal: false,
    closedAt: "2026-09-05T12:00:00+08:00",
    taskKind: "coding_lane",
    sessionId: "s1",
    runtime: "local_cli",
    capabilities: caps,
    projectRoot: "/repo",
    isolationPath: "/Users/me/ccode/worktrees/repo/feat",
  };
  assert.equal(pickRecoverableRun([run], "/repo")?.sessionId, "s1");
  assert.equal(pickRecoverableRun([{ ...run, internal: true }], "/repo"), null);
  assert.equal(pickRecoverableRun([{ ...run, taskKind: "watch" }], "/repo"), null);
  assert.equal(pickRecoverableRun([{ ...run, taskKind: "reader" }], "/repo"), null);
  assert.equal(
    pickRecoverableRun([{ ...run, runtime: "custom", capabilities: { ...caps, canResume: false } }], "/repo"),
    null,
  );
});

test("isRunProcessLive：进程活着才算运行中，保留标签不算", () => {
  assert.equal(isRunProcessLive({ running: true, attention: null }), true);
  assert.equal(isRunProcessLive({ running: false, attention: "working" }), true);
  assert.equal(isRunProcessLive({ running: false, attention: "confirm" }), true);
  assert.equal(isRunProcessLive({ running: false, attention: "done" }), true);
  assert.equal(isRunProcessLive({ running: false, attention: null }), false);
  assert.equal(isRunProcessLive({}), false);
});

test("compareRunIdentity：只有 Agent / 目录 / 权限算身份", () => {
  const bound = { agentId: "codex", cwd: "~", permission: "write_tree" as const };
  const home = "/Users/a";
  assert.equal(compareRunIdentity(null, bound, home), "same");
  assert.equal(compareRunIdentity(bound, { ...bound }, home), "same");
  // ~ 与展开后的主目录、尾斜杠都是同一处
  assert.equal(compareRunIdentity(bound, { ...bound, cwd: "/Users/a/" }, home), "same");
  assert.equal(
    compareRunIdentity(
      { ...bound, cwd: "~/Documents/p" },
      { ...bound, cwd: "/Users/a/Documents/p" },
      home,
    ),
    "same",
  );
  // 截图场景：上次在 ~ 跑，停下后换到项目目录
  assert.equal(
    compareRunIdentity(bound, { ...bound, cwd: "/Users/a/Documents/zeta首页界面设计" }, home),
    "cwd",
  );
  assert.equal(compareRunIdentity(bound, { ...bound, agentId: "claude-code" }, home), "agent");
  // 几样一起变按目录算（会话换、目标归属也放下）
  assert.equal(
    compareRunIdentity(bound, { agentId: "claude-code", cwd: "/tmp/x", permission: "discuss" }, home),
    "cwd",
  );
  assert.equal(compareRunIdentity(bound, { ...bound, permission: "discuss" }, home), "permission");
  // Windows 大小写与分隔符
  assert.equal(
    compareRunIdentity(
      { ...bound, cwd: "C:\\Users\\A\\proj" },
      { ...bound, cwd: "c:/users/a/proj" },
      "C:\\Users\\A",
      true,
    ),
    "same",
  );
});
