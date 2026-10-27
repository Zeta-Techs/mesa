import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProjectCard, filterCards, type CardRunInput } from "../src/workbench-cards.ts";

const base = {
  workspaces: [],
  steps: null,
  pipelineOptOut: false,
  coding: null,
  goals: [],
  schedules: [],
  runs: [],
  queueKeys: new Set<string>(),
  now: new Date("2026-10-27T10:00:00"),
};
const run = (over: Partial<CardRunInput>): CardRunInput => ({
  tabId: "t1",
  agentId: "codex",
  cwd: "/p",
  title: "对话",
  running: true,
  attention: "working",
  ...over,
});

test("科研流程：进度条按步，列当前步与开着工作副本的步，做完的只在进度条上", () => {
  const card = buildProjectCard({
    ...base,
    project: { path: "/p", name: "综述", registered: true, workMode: "research" },
    steps: [
      { name: "检索", workspaceName: "s1" },
      { name: "精读", workspaceName: "s2" },
      { name: "大纲", workspaceName: "s3" },
      { name: "初稿", workspaceName: "s4" },
    ],
    workspaces: [
      { id: "w1", repoPath: "/p", name: "s1", worktreePath: "/wt/s1", status: "active", mergedAt: "2026-10-20" },
      { id: "w2", repoPath: "/p", name: "s2", worktreePath: "/wt/s2", status: "active", mergedAt: null },
      { id: "w3", repoPath: "/p", name: "s3", worktreePath: "/wt/s3", status: "active", mergedAt: null },
    ],
    runs: [run({ cwd: "/wt/s2/notes", runId: "r1", attention: "confirm" })],
    queueKeys: new Set(["confirm:r1", "ready:w3"]),
  });
  assert.deepEqual(card.track?.map((s) => s.state), ["done", "cur", "todo", "todo"]);
  assert.deepEqual(card.vitals[0], { label: "进行到", value: "第 2 / 4 步" });
  assert.deepEqual(card.tasks.map((t) => [t.kindLabel, t.name, t.state, t.tone, t.queued]), [
    ["步骤 2", "精读", "等你确认", "wait", true],
    ["步骤 3", "大纲", "进行中，还没保存进项目", "wait", true],
  ]);
  assert.equal(card.live, true);
});

test("工作项目：列没做完的目标，标签按 taskId 认领，做完的只计数", () => {
  const card = buildProjectCard({
    ...base,
    project: { path: "/p", name: "测试项目", registered: true, workMode: "office" },
    goals: [
      { id: "g1", projectRoot: "/p", name: "整理数据", status: "running", archivedAt: null },
      { id: "g2", projectRoot: "/p", name: "周报", status: "draft", archivedAt: null },
      { id: "g3", projectRoot: "/p", name: "旧活", status: "completed", archivedAt: null },
      { id: "g4", projectRoot: "/p", name: "验收", status: "pending_review", archivedAt: null },
      { id: "g5", projectRoot: "/other", name: "别家", status: "running", archivedAt: null },
    ],
    runs: [run({ taskId: "g1", cwd: "/tmp/iso/g1" })],
    queueKeys: new Set(["review:g4"]),
  });
  assert.deepEqual(card.tasks.map((t) => [t.name, t.state, t.tone]), [
    ["验收", "待验收", "wait"],
    ["整理数据", "正在干活", "live"],
    ["周报", "记下了，还没开工", "idle"],
  ]);
  assert.deepEqual(card.vitals, [
    { label: "进行中", value: "1" },
    { label: "待验收", value: "1" },
    { label: "记下未开工", value: "1" },
  ]);
});

test("科研不用流程且没有步骤时同工作项目列目标；还留着步骤的照旧列步骤（与项目页同口径）", () => {
  const goals = [{ id: "g1", projectRoot: "/p", name: "写综述", status: "draft", archivedAt: null }];
  const project = { path: "/p", name: "x", registered: true, workMode: "research" as const };
  const lite = buildProjectCard({ ...base, project, steps: [], pipelineOptOut: true, goals });
  assert.equal(lite.track, null);
  assert.deepEqual(lite.tasks.map((t) => t.kind), ["goal"]);
  const kept = buildProjectCard({ ...base, project, steps: [{ name: "检索", workspaceName: "s1" }], pipelineOptOut: true, goals });
  assert.deepEqual(kept.tasks.map((t) => t.kind), ["step"]);
});

test("编程：列基准以外的分支，标签按工作树目录认领", () => {
  const wt = (over: object) => ({ path: "/p", branch: "main", isPrimary: false, isBase: false, dirty: false, ahead: 0, behind: 0, ...over });
  const card = buildProjectCard({
    ...base,
    project: { path: "/p", name: "Ccode", registered: true, workMode: "coding" },
    coding: {
      baseBranch: "main",
      worktrees: [
        wt({ isPrimary: true, isBase: true }),
        wt({ path: "/wt/a", branch: "feat/a", dirty: true }),
        wt({ path: "/wt/b", branch: "feat/b", ahead: 2 }),
      ],
    },
    runs: [run({ cwd: "/wt/a" })],
  });
  assert.deepEqual(card.tasks.map((t) => [t.name, t.state, t.tone]), [
    ["feat/b", "等待合并", "wait"],
    ["feat/a", "正在干活", "live"],
  ]);
  assert.deepEqual(card.vitals, [
    { label: "基准", value: "main" },
    { label: "分支", value: "2 条" },
    { label: "等待合并", value: "1" },
  ]);
});

test("对不上任务的活标签单列成对话；别的项目的标签不算", () => {
  const card = buildProjectCard({
    ...base,
    project: { path: "/p", name: "x", registered: true, workMode: "office" },
    runs: [run({ tabId: "a", cwd: "/p/sub", title: "改周报" }), run({ tabId: "b", cwd: "/q" })],
  });
  assert.deepEqual(card.tasks.map((t) => [t.kind, t.name]), [["chat", "改周报"]]);
});

test("定时任务：在跑 / 暂停 / 上次失败 / 下次时间；停用且没暂停原因的不列", () => {
  const sched = (over: object) => ({ id: "s", name: "雷达", projectRoot: "/p", enabled: true, history: [], ...over });
  const card = buildProjectCard({
    ...base,
    project: { path: "/p", name: "x", registered: true, workMode: "research" },
    schedules: [
      sched({ id: "a", name: "在跑", runningRunId: "r" }),
      sched({ id: "b", name: "暂停", enabled: false, pausedReason: "连续失败" }),
      sched({ id: "c", name: "失败", history: [{ status: "skipped" }, { status: "timeout" }] }),
      sched({ id: "f", name: "报错", history: [{ status: "error", summary: "\n钉住的连接不存在\n细节" }] }),
      sched({ id: "d", name: "下次", nextRunAt: "2026-10-27T14:00:00" }),
      sched({ id: "e", name: "停用", enabled: false }),
    ],
    queueKeys: new Set(["sched:paused:b"]),
  });
  assert.deepEqual(card.tasks.map((t) => [t.name, t.state, t.queued]), [
    ["暂停", "已自动暂停", true],
    ["在跑", "正在跑", false],
    ["失败", "上次超时", false],
    ["报错", "上次失败：钉住的连接不存在", false],
    ["下次", "下次 今天 14:00", false],
  ]);
});

test("filterCards：有活的按传入顺序，其余筛选把有活的排前", () => {
  const card = (path: string, workMode: "research" | "coding" | "office") =>
    buildProjectCard({ ...base, project: { path, name: path, registered: true, workMode } });
  const cards = [card("/a", "research"), card("/b", "coding"), card("/c", "research")];
  assert.deepEqual(filterCards(cards, ["/c", "/b"], "active").map((c) => c.path), ["/c", "/b"]);
  assert.deepEqual(filterCards(cards, ["/c"], "research").map((c) => c.path), ["/c", "/a"]);
  assert.deepEqual(filterCards(cards, ["/b"], "all").map((c) => c.path), ["/b", "/a", "/c"]);
});
