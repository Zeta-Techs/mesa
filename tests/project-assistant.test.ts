import assert from "node:assert/strict";
import test from "node:test";
import { buildAssistantPrompt, historyBlock, parseAssistantAnswer } from "../src/project-assistant.ts";
import { buildProjectSnapshot, type SnapshotInput } from "../src/project-snapshot.ts";

test("动作标记：只认白名单，按钮文字由前端生成，最多三个", () => {
  const { text, actions } = parseAssistantAnswer(
    "第 2 步启动失败，是环境的问题。\n\n[[看这一步:2]] [[设置]] [[去评审:9]] [[删库|x]] [[留话:2|先停一下]] [[报告|启动失败]]",
    3,
  );
  assert.equal(text, "第 2 步启动失败，是环境的问题。");
  assert.deepEqual(
    actions.map((a) => [a.kind, a.step, a.label]),
    [
      ["step", 2, "看第 2 步"],
      ["settings", null, "去设置"],
      ["mail", 2, "给第 2 步留话"],
    ],
    "越界的步骤、不认识的种类丢掉，超过三个不要",
  );
  assert.equal(actions[2].text, "先停一下");
});

test("动作标记：缺内容的不要，同一种只留一个，全角冒号也认", () => {
  const { actions } = parseAssistantAnswer("[[留话:1]] [[商量|方法段怎么写]] [[商量|另一个]] [[看这一步：1]]", 2);
  assert.deepEqual(actions.map((a) => a.kind), ["discuss", "step"]);
});

test("提示词带规矩、快照、最近几轮和这次的问题", () => {
  const prompt = buildAssistantPrompt({
    snapshot: "# 项目快照",
    history: [{ question: "到哪了", answer: "第 2 步" }],
    question: "哪里出错了",
  });
  assert.match(prompt, /先分清是谁的问题/);
  assert.match(prompt, /# 项目快照/);
  assert.match(prompt, /用户：到哪了\n你：第 2 步/);
  assert.match(prompt, /## 这次的问题\n哪里出错了$/);
  const many = Array.from({ length: 10 }, (_, i) => ({ question: `q${i}`, answer: "a" }));
  assert.ok(!historyBlock(many).includes("q3") && historyBlock(many).includes("q4"));
});

function input(over: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    now: "2026-11-04T10:00:00+08:00",
    mesaVersion: "0.2.0",
    platform: "macOS",
    project: {
      name: "综述",
      path: "/p/review",
      workMode: "research",
      topic: "固态电池",
      settings: [],
      hasPipeline: true,
      defaultAgent: "codex",
    },
    steps: [
      {
        index: 0,
        name: "文献检索",
        brief: "检索文献",
        expectedArtifacts: ["papers/included.md"],
        acceptanceCriteria: [],
        state: "出错了",
        worktreePath: "/w/s1",
        failure: "PTY 启动失败",
        checks: [{ id: "c1", kind: "cite", status: "blocked", title: "引用缺 DOI" }],
        reviewNotes: "图 2 标注不清",
      },
    ],
    goals: [],
    runs: [
      {
        id: "r1",
        isolationPath: "/w/s1",
        internal: false,
        createdAt: "2026-11-04T09:00:00Z",
        closedAt: null,
        status: "failed",
        exitCode: null,
        closeReason: "应用上次异常退出，Run 未能正常收尾",
        agent: "codex",
        taskKind: "step",
        where: "第 1 步",
      },
    ],
    focus: null,
    failedRunEvents: [],
    helpItems: [],
    pendingMail: [],
    mesaErrors: [
      { at: "2026-11-04T09:30:00+08:00", firstAt: "", count: 2, source: "invoke", command: "save_step", message: "nothing added", version: "0.2.0" },
    ],
    appLog: [],
    deps: [{ name: "Git", status: "ok", version: "2.4" }],
    agents: [{ id: "codex", installed: true, version: "0.166" }],
    decided: [],
    ...over,
  };
}

test("快照写清每步状态、出错原因、核验、退回意见与 Mesa 出错", () => {
  const text = buildProjectSnapshot(input());
  assert.match(text, /### 第 1 步「文献检索」：出错了\n最近一次运行出错：PTY 启动失败/);
  assert.match(text, /\[拦下\] 引用缺 DOI/);
  assert.match(text, /评审退回意见：\n图 2 标注不清/);
  assert.match(text, /Mesa 上次异常退出.*Mesa 的问题，不是这一步的/);
  assert.match(text, /save_step 失败（10 分钟内 2 次）/);
  assert.match(text, /- Git：已就绪 2\.4/);
});

test("快照超长时先砍事件和日志，最后硬截", () => {
  const big = input({
    failedRunEvents: [{ where: "第 1 步", events: Array.from({ length: 50 }, () => "x".repeat(200)) }],
    appLog: Array.from({ length: 20 }, () => ({ ts: "t", level: "error", source: "s", message: "y".repeat(200) })),
  });
  const full = buildProjectSnapshot(big, 100000);
  assert.match(full, /出错那次的最后几条事件/);
  const cut = buildProjectSnapshot(big, 3000);
  assert.ok(cut.length <= 3000 + 10);
  assert.ok(!cut.includes("出错那次的最后几条事件"));
  assert.match(cut, /第 1 步「文献检索」/);
});
