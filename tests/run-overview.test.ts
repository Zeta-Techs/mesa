import assert from "node:assert/strict";
import test from "node:test";
import {
  attributeToProject,
  buildRunOverview,
  cwdBasename,
  itemRank,
  projectRailStatus,
  stepAttention,
  workspaceAgentBusy,
  workspaceHasLiveAgent,
  workspaceReviewInboxEligible,
  type RunOverviewInput,
} from "../src/run-overview.ts";

function input(partial: Partial<RunOverviewInput>): RunOverviewInput {
  return {
    tabId: "t1",
    title: "终端",
    agentId: "claude-code",
    model: "",
    cwd: "/repo/proj",
    running: false,
    shell: false,
    attention: null,
    ...partial,
  };
}

test("cwdBasename 取路径尾段，容忍尾部分隔符与 Windows 分隔符", () => {
  assert.equal(cwdBasename("/repo/proj"), "proj");
  assert.equal(cwdBasename("/repo/proj/"), "proj");
  assert.equal(cwdBasename("C:\\repo\\proj"), "proj");
  assert.equal(cwdBasename("/repo/ccode/workspaces/lit-notes"), "lit-notes");
  assert.equal(cwdBasename("~"), "~");
  assert.equal(cwdBasename(""), "");
});

test("itemRank 优先级：待确认 > 工作中 > 其余运行中 > shell/已退出；已回复不占档", () => {
  assert.equal(itemRank(input({ attention: "confirm", running: true })), 0);
  assert.equal(itemRank(input({ attention: "working", running: true })), 1);
  // done = 回合结束，不阻塞决策，随 running 归普通档
  assert.equal(itemRank(input({ attention: "done", running: true })), 2);
  assert.equal(itemRank(input({ attention: "done" })), 3);
  assert.equal(itemRank(input({ running: true })), 2);
  assert.equal(itemRank(input({ shell: true })), 3);
  assert.equal(itemRank(input({})), 3);
});

test("workspaceHasLiveAgent：进程还在跑不算待评审，回落 shell 不算", () => {
  const ws = "/ccode/workspaces/lit-notes";
  assert.equal(
    workspaceHasLiveAgent(ws, [
      input({ cwd: ws, running: true, shell: false, attention: "done" }),
    ]),
    true,
  );
  assert.equal(
    workspaceHasLiveAgent(ws, [
      input({ cwd: ws, running: true, shell: true }),
    ]),
    false,
  );
  assert.equal(workspaceHasLiveAgent(ws, [input({ cwd: "/other", running: true })]), false);
  assert.equal(workspaceHasLiveAgent(undefined, [input({ cwd: ws, running: true })]), false);
});

test("workspaceAgentBusy：出字或等确认才算忙，回合结束不算", () => {
  const ws = "/ccode/workspaces/draft";
  assert.equal(
    workspaceAgentBusy(ws, [input({ cwd: ws, attention: "working", running: true })]),
    true,
  );
  assert.equal(
    workspaceAgentBusy(ws, [input({ cwd: ws, attention: "confirm", running: true })]),
    true,
  );
  assert.equal(
    workspaceAgentBusy(ws, [
      input({ cwd: ws, attention: "done", running: true, shell: false }),
    ]),
    false,
  );
  assert.equal(workspaceAgentBusy(ws, [input({ cwd: "/other", attention: "working" })]), false);
});

test("项目列表绿点只认还在跑的 Agent，未归档工作区不亮", () => {
  const roots = [
    "/Users/me/Documents/综述流程测试",
    "/Users/me/ccode/workspaces/综述流程测试/polish",
  ];
  assert.equal(
    projectRailStatus({ needsAttention: 0, roots, runs: [] }),
    null,
  );
  assert.equal(
    projectRailStatus({
      needsAttention: 0,
      roots,
      runs: [
        input({
          cwd: "/Users/me/ccode/workspaces/综述流程测试/polish",
          running: false,
          attention: "done",
        }),
      ],
    }),
    null,
  );
  assert.equal(
    projectRailStatus({
      needsAttention: 0,
      roots,
      runs: [
        input({
          cwd: "/Users/me/ccode/workspaces/综述流程测试/polish",
          running: true,
          shell: true,
        }),
      ],
    }),
    null,
  );
  assert.equal(
    projectRailStatus({
      needsAttention: 0,
      roots,
      runs: [
        input({
          cwd: "/Users/me/ccode/workspaces/综述流程测试/polish/manuscript",
          running: true,
          shell: false,
        }),
      ],
    }),
    "running",
  );
  assert.equal(
    projectRailStatus({
      needsAttention: 2,
      roots,
      runs: [
        input({
          cwd: "/Users/me/ccode/workspaces/综述流程测试/polish",
          running: true,
        }),
      ],
    }),
    "warn",
  );
  assert.equal(
    projectRailStatus({
      needsAttention: 0,
      roots,
      runs: [input({ cwd: "/Users/me/Documents/综述流程测试2", running: true })],
    }),
    null,
  );
});

test("收件箱待评审：可合并才进，出字中和冲突都不进", () => {
  assert.equal(
    workspaceReviewInboxEligible({
      readyToMerge: true,
      conflict: false,
      agentBusy: false,
    }),
    true,
  );
  assert.equal(
    workspaceReviewInboxEligible({
      readyToMerge: true,
      conflict: false,
      agentBusy: true,
    }),
    false,
  );
  assert.equal(
    workspaceReviewInboxEligible({
      readyToMerge: true,
      conflict: true,
      agentBusy: false,
    }),
    false,
  );
  assert.equal(
    workspaceReviewInboxEligible({
      readyToMerge: false,
      agentBusy: false,
    }),
    false,
  );
});

test("buildRunOverview 按「要你管」排序，同级保持标签原顺序", () => {
  const { items } = buildRunOverview([
    input({ tabId: "idle" }),
    input({ tabId: "shell", shell: true }),
    input({ tabId: "work", running: true, attention: "working" }),
    input({ tabId: "done", running: true, attention: "done" }),
    input({ tabId: "confirm", running: true, attention: "confirm" }),
    input({ tabId: "run", running: true }),
  ]);
  assert.deepEqual(
    items.map((i) => i.tabId),
    ["confirm", "work", "done", "run", "idle", "shell"],
  );
});

test("buildRunOverview 摘要不计已回复", () => {
  const { summary } = buildRunOverview([
    input({ tabId: "c1", running: true, attention: "confirm" }),
    input({ tabId: "c2", running: true, attention: "confirm" }),
    input({ tabId: "d1", running: true, attention: "done" }),
    input({ tabId: "w1", running: true, attention: "working" }),
  ]);
  assert.deepEqual(summary, { confirm: 2, working: 1 });
});

test("attributeToProject 最长前缀命中 + 段边界", () => {
  const groups = [
    { key: "p:a", roots: ["/repo/a", "/repo/a-ws/lit"] },
    { key: "p:b", roots: ["/repo/b"] },
  ];
  // 工作树内路径归到该项目（roots 含 worktreePath）
  assert.equal(attributeToProject("/repo/a-ws/lit/notes", groups), "p:a");
  // 项目根本身命中
  assert.equal(attributeToProject("/repo/b", groups), "p:b");
  // 段边界：/repo/a2 不得误中 /repo/a
  assert.equal(
    attributeToProject("/repo/a2/x", [{ key: "p:a", roots: ["/repo/a"] }]),
    null,
  );
  // 嵌套根取最长前缀
  assert.equal(
    attributeToProject("/repo/a/sub/deep", [
      { key: "outer", roots: ["/repo/a"] },
      { key: "inner", roots: ["/repo/a/sub"] },
    ]),
    "inner",
  );
  // Windows 分隔符归一 + 尾部斜杠
  assert.equal(
    attributeToProject("C:\\repo\\a\\sub", [{ key: "p:a", roots: ["C:/repo/a/"] }]),
    "p:a",
  );
  // 不命中 / 空路径
  assert.equal(attributeToProject("/elsewhere", groups), null);
  assert.equal(attributeToProject("", groups), null);
});


test("stepAttention：在跑工作区的注意力派生（任务卡继续/去终端互斥的判据）", () => {
  const ws = { worktreePath: "/repo/.mesa/ws-lit-search" };
  const mk = (attention: "done" | "working" | "confirm" | null, cwd = ws.worktreePath, extra: Partial<RunOverviewInput> = {}) =>
    input({ attention, cwd, ...extra });
  // 空输入 / cwd 不在工作区内 → null
  assert.equal(stepAttention(ws, []), null);
  assert.equal(stepAttention(ws, [mk("working", "/别的目录")]), null);
  // 子目录也算（工作区内运行的终端）
  assert.equal(stepAttention(ws, [mk("working", `${ws.worktreePath}/sub`)]), "working");
  // confirm 最优先；working 次之；done 不被中途正文冒充
  assert.equal(stepAttention(ws, [mk("done"), mk("confirm")]), "confirm");
  assert.equal(stepAttention(ws, [mk("done"), mk("working")]), "working");
  assert.equal(stepAttention(ws, [mk("done")]), "done");
  // 进程在跑（非 shell）时的 done 不算「已跑完」
  assert.equal(stepAttention(ws, [mk("done", ws.worktreePath, { running: true, shell: false })]), null);
  assert.equal(stepAttention(ws, [mk("done", ws.worktreePath, { running: true, shell: true })]), "done");
});
