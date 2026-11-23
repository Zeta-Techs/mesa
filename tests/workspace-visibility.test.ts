import assert from "node:assert/strict";
import test from "node:test";
import {
  filterFocusedStepWorkspaces,
  filterOutsideFlowWorkspaces,
  filterWorkspacesByFocus,
  isStepWorkspaceSupersededByCloseout,
} from "../src/workspace-visibility.ts";

interface Ws {
  name: string;
}

function ws(name: string): Ws {
  return { name };
}

const steps = [
  { name: "文献检索", workspaceName: "lit-search" },
  { name: "精读笔记", workspaceName: "lit-notes" },
];

test("聚焦步骤：命中绑定该步骤 workspaceName 的工作区", () => {
  const list = [ws("lit-search"), ws("lit-notes"), ws("manual-fix")];
  const out = filterWorkspacesByFocus(list, steps, "文献检索");
  assert.deepEqual(
    out.map((w) => w.name),
    ["lit-search", "manual-fix"],
  );
});

test("聚焦步骤：不匹配任何步骤的手动工作区始终可见", () => {
  const list = [ws("adhoc"), ws("lit-notes")];
  const out = filterWorkspacesByFocus(list, steps, "文献检索");
  assert.deepEqual(
    out.map((w) => w.name),
    ["adhoc"],
  );
});

test("未聚焦（null）显示全量", () => {
  const list = [ws("lit-search"), ws("lit-notes"), ws("manual-fix")];
  const out = filterWorkspacesByFocus(list, steps, null);
  assert.deepEqual(
    out.map((w) => w.name),
    ["lit-search", "lit-notes", "manual-fix"],
  );
});

test("空步骤表显示全量（含聚焦名非 null 时）", () => {
  const list = [ws("a"), ws("b")];
  assert.deepEqual(filterWorkspacesByFocus(list, [], null).length, 2);
  assert.deepEqual(filterWorkspacesByFocus(list, [], "某步骤").length, 2);
});

test("聚焦名在步骤表中不存在：只显示不匹配任何步骤的工作区", () => {
  const list = [ws("lit-search"), ws("manual-fix")];
  const out = filterWorkspacesByFocus(list, steps, "已删除步骤");
  assert.deepEqual(
    out.map((w) => w.name),
    ["manual-fix"],
  );
});

test("步骤工作区与流程外工作区严格分离：步骤工作区不塞进流程之外", () => {
  const fullSteps = [
    ...steps,
    { name: "润色与定稿", workspaceName: "polish" },
  ];
  const list = [ws("lit-search"), ws("lit-notes"), ws("polish"), ws("manual-fix")];

  assert.deepEqual(
    filterFocusedStepWorkspaces(list, fullSteps, "润色与定稿").map((w) => w.name),
    ["polish"],
  );
  assert.deepEqual(
    filterFocusedStepWorkspaces(list, fullSteps, null),
    [],
  );
  assert.deepEqual(
    filterOutsideFlowWorkspaces(list, fullSteps).map((w) => w.name),
    ["manual-fix"],
  );
  assert.deepEqual(
    filterOutsideFlowWorkspaces([ws("lit-search"), ws("polish")], fullSteps),
    [],
  );
});

test("定稿步已保存且完结文件可见时，本步工作区文件卡由完结文件接管去重", () => {
  const polishStep = {
    name: "润色与定稿",
    workspaceName: "polish",
    expectedArtifacts: ["output/review-final.pdf"],
  };
  const searchStep = {
    name: "文献检索",
    workspaceName: "lit-search",
    expectedArtifacts: ["papers/included.md"],
  };

  assert.equal(
    isStepWorkspaceSupersededByCloseout({
      closeoutVisible: true,
      boundStep: polishStep,
      merged: true,
    }),
    true,
  );
  // 尚有未合并改动或完结文件未出现时，仍显示定稿步本步工作区卡
  assert.equal(
    isStepWorkspaceSupersededByCloseout({
      closeoutVisible: true,
      boundStep: polishStep,
      merged: false,
    }),
    false,
  );
  assert.equal(
    isStepWorkspaceSupersededByCloseout({
      closeoutVisible: false,
      boundStep: polishStep,
      merged: true,
    }),
    false,
  );
  // 前序非定稿步骤回看时，保留该步自己的本步工作区/本步文件入口
  assert.equal(
    isStepWorkspaceSupersededByCloseout({
      closeoutVisible: true,
      boundStep: searchStep,
      merged: true,
    }),
    false,
  );
});

