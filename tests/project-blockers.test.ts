import assert from "node:assert/strict";
import test from "node:test";
import { projectBlockers } from "../src/project-blockers.ts";
import type { CardTask } from "../src/workbench-cards.ts";

function step(i: number, name: string, worktreePath: string | null, extra: Partial<CardTask> = {}): CardTask {
  return {
    id: `step:${name}`,
    kind: "step",
    kindLabel: `步骤 ${i + 1}`,
    name,
    state: "工作副本开着",
    tone: "idle",
    live: null,
    queued: false,
    inProgress: true,
    touchedAt: null,
    ref: { kind: "step", stepIndex: i, workspaceName: name, worktreePath, workspaceId: "w" },
    ...extra,
  };
}

const failedRun = {
  id: "r1",
  isolationPath: "/w/s1",
  internal: false,
  createdAt: "2026-11-04T09:00:00Z",
  closedAt: "2026-11-04T09:01:00Z",
  status: "failed",
  exitCode: 127,
  closeReason: "进程以非零退出码结束",
};

test("卡点：出错的步骤在前，Mesa 出错其次，等你拍板最后；开着在干活的不算", () => {
  const tasks = [
    step(0, "检索", "/w/s1"),
    step(1, "精读", "/w/s2", { queued: true }),
    step(2, "写作", "/w/s3", { live: { tabId: "t", agentId: "codex", attention: "working", running: true } }),
  ];
  const now = Date.parse("2026-11-04T12:00:00+08:00");
  const blockers = projectBlockers({
    card: { tasks },
    runs: [failedRun, { ...failedRun, id: "r3", isolationPath: "/w/s3" }],
    mesaErrors: [
      { at: "2026-11-04T11:00:00+08:00", firstAt: "", count: 2, source: "invoke", command: "x", message: "boom", notice: "保存失败：boom", version: "" },
    ],
    nowMs: now,
  });
  assert.deepEqual(
    blockers.map((b) => b.text),
    [
      "第 1 步「检索」出错了：未找到命令（退出码 127）",
      "Mesa 近一天在这个项目上报错 2 次，最近一次：保存失败：boom",
      "第 2 步「精读」等你拍板",
    ],
  );
  assert.deepEqual(blockers[1].target.kind, "assistant");
});

test("卡点：没有事就是空的；一天前的、没弹过提示的 Mesa 出错不催", () => {
  const blockers = projectBlockers({
    card: { tasks: [step(0, "检索", "/w/s1")] },
    runs: [{ ...failedRun, status: "completed", exitCode: 0 }],
    mesaErrors: [
      { at: "2026-11-01T11:00:00+08:00", firstAt: "", count: 1, source: "invoke", command: "x", message: "old", notice: "旧提示", version: "" },
      { at: "2026-11-04T11:00:00+08:00", firstAt: "", count: 1, source: "invoke", command: "x", message: "后台静默失败", version: "" },
    ],
    nowMs: Date.parse("2026-11-04T12:00:00+08:00"),
  });
  assert.deepEqual(blockers, []);
});
