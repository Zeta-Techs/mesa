import assert from "node:assert/strict";
import test from "node:test";
import { unsavedUpstreamSteps } from "../src/kickoff-inputs.ts";

const steps = [
  {
    name: "文献检索与筛选",
    expectedArtifacts: ["papers/screening.md", "papers/included.md", "papers/included.json", "papers/to-fetch.md"],
  },
  {
    name: "文献精读与笔记",
    inputs: ["papers/included.md", "papers/included.json", "papers/to-fetch.md"],
    optionalInputs: ["papers/*.pdf"],
    expectedArtifacts: ["notes/*.md", "notes/index.json", "references.bib"],
  },
  {
    name: "综述大纲",
    inputs: ["notes/", "notes/handoff.md", "papers/included.md", "references.bib"],
    expectedArtifacts: ["outline.md"],
  },
];

test("检索步待评审时开精读：点名还没保存进项目的上游与要读的文件", () => {
  const status = (key: string) => (i: number) =>
    i === 0 ? { key, worktreePath: "/ws/lit-search" } : { key: "pending", worktreePath: null };
  const hits = unsavedUpstreamSteps(steps, 1, status("review"));
  assert.deepEqual(hits, [{
    name: "文献检索与筛选",
    status: "review",
    worktreePath: "/ws/lit-search",
    inputs: ["papers/included.md", "papers/included.json", "papers/to-fetch.md"],
  }]);
  assert.equal(unsavedUpstreamSteps(steps, 1, status("active"))[0]?.status, "active");
  assert.equal(unsavedUpstreamSteps(steps, 1, status("blocked"))[0]?.status, "blocked");
  // 已保存进项目 / 还没开工 / 检查中：不报
  for (const key of ["done", "pending", "checking"]) {
    assert.deepEqual(unsavedUpstreamSteps(steps, 1, status(key)), [], key);
  }
});

test("跨步也认：大纲要读的 notes/ 覆盖精读的 notes/*.md；与本步无关的上游不报", () => {
  const statuses: Record<number, { key: string; worktreePath: string }> = {
    0: { key: "done", worktreePath: "/ws/lit-search" },
    1: { key: "review", worktreePath: "/ws/lit-notes" },
  };
  const hits = unsavedUpstreamSteps(steps, 2, (i) => statuses[i] ?? null);
  assert.deepEqual(hits.map((h) => [h.name, h.inputs]), [
    // notes/handoff.md 落在精读的 notes/*.md 里，也算
    ["文献精读与笔记", ["notes/", "notes/handoff.md", "references.bib"]],
  ]);
  // 第一步、没有声明必读输入的步骤：无从比较
  assert.deepEqual(unsavedUpstreamSteps(steps, 0, () => ({ key: "review", worktreePath: "/x" })), []);
  assert.deepEqual(
    unsavedUpstreamSteps([steps[0]!, { name: "空", expectedArtifacts: [] }], 1, () => ({ key: "review", worktreePath: "/x" })),
    [],
  );
});

test("同名前缀不误认：included.md 不覆盖 included.json，可选输入不算", () => {
  const two = [
    { name: "A", expectedArtifacts: ["papers/included.md"] },
    { name: "B", inputs: ["papers/included.json"], optionalInputs: ["papers/included.md"] },
  ];
  assert.deepEqual(unsavedUpstreamSteps(two, 1, () => ({ key: "review", worktreePath: "/x" })), []);
});
