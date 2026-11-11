import assert from "node:assert/strict";
import test from "node:test";
import {
  bucketCardsByStep,
  topicCardsForStep,
  unstartedSeeds,
  groupSessionsByTask,
  taskMdEditorReduce,
  sortCards,
} from "../src/task-cards.ts";
import type { TaskCardDto } from "../src/types.ts";

function card(partial: Partial<TaskCardDto>): TaskCardDto {
  return {
    id: "t-1",
    name: "卡片",
    step: null,
    workspace: null,
    kind: "draft",
    createdAt: "2026-08-01T10:00:00Z",
    ...partial,
  };
}

test("sortCards：创建时间升序，同刻按名称兜底", () => {  const sorted = sortCards([
    card({ id: "t-b", name: "乙", createdAt: "2026-08-02T00:00:00Z" }),
    card({ id: "t-a2", name: "甲二", createdAt: "2026-08-01T00:00:00Z" }),
    card({ id: "t-a1", name: "甲一", createdAt: "2026-08-01T00:00:00Z" }),
  ]);
  assert.deepEqual(
    sorted.map((c) => c.id),
    ["t-a1", "t-a2", "t-b"],
  );
});

test("bucketCardsByStep：步骤桶按流水线顺序；失效步骤的卡并入未挂步骤桶（末尾）", () => {
  const buckets = bucketCardsByStep(
    [
      card({ id: "t-2", name: "二", step: "写综述" }),
      card({ id: "t-1", name: "一", step: "读文献" }),
      card({ id: "t-3", name: "散卡" }),
      card({ id: "t-4", name: "旧步骤卡", step: "已删除步骤" }),
    ],
    ["读文献", "写综述", "空步骤"],
  );
  assert.deepEqual(
    buckets.map((b) => [b.step, b.cards.map((c) => c.id)]),
    [
      ["读文献", ["t-1"]],
      ["写综述", ["t-2"]],
      ["空步骤", []],
      [null, ["t-3", "t-4"]],
    ],
  );
});

test("groupSessionsByTask：未归置恒在最前，组按最近活跃降序，组内保持传入顺序", () => {
  type S = { taskId: string | null; taskName: string | null; updatedAt: string | null; id: string };
  const s = (p: Partial<S> & { id: string }): S => ({
    taskId: null,
    taskName: null,
    updatedAt: null,
    ...p,
  });
  const groups = groupSessionsByTask([
    s({ id: "a1", taskId: "t-a", taskName: "卡A", updatedAt: "2026-08-02T00:00:00Z" }),
    s({ id: "free", updatedAt: "2026-08-05T00:00:00Z" }),
    s({ id: "b1", taskId: "t-b", taskName: "卡B", updatedAt: "2026-08-04T00:00:00Z" }),
    s({ id: "a2", taskId: "t-a", taskName: "卡A", updatedAt: "2026-08-01T00:00:00Z" }),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.name, g.list.map((x) => x.id)]),
    [
      ["未归置", ["free"]],
      ["卡B", ["b1"]],
      ["卡A", ["a1", "a2"]],
    ],
  );
});

test("groupSessionsByTask：卡片已删除（taskName 为 null）回落「未命名卡片」，不报错", () => {
  const groups = groupSessionsByTask([
    { taskId: "t-gone", taskName: null, updatedAt: "2026-08-01T00:00:00Z" },
  ]);
  assert.equal(groups[0].name, "未命名卡片");
});

test("taskMdEditorReduce：脏态防覆盖，重置恢复跟随拼装", () => {
  let st = { text: "", dirty: false };
  st = taskMdEditorReduce(st, { type: "assemble", text: "默认v1" });
  assert.deepEqual(st, { text: "默认v1", dirty: false });
  // 未脏：拼装变化的重拼跟随
  st = taskMdEditorReduce(st, { type: "assemble", text: "默认v2" });
  assert.equal(st.text, "默认v2");
  // 人编辑后 dirty：重拼/再加载不覆盖
  st = taskMdEditorReduce(st, { type: "edit", text: "人改的" });
  st = taskMdEditorReduce(st, { type: "assemble", text: "默认v3" });
  assert.equal(st.text, "人改的");
  // 恢复默认拼装：回到跟随态
  st = taskMdEditorReduce(st, { type: "reset", text: "默认v4" });
  st = taskMdEditorReduce(st, { type: "assemble", text: "默认v5" });
  assert.deepEqual(st, { text: "默认v5", dirty: false });
});


// ===== 人工事项 =====

import {
  blockingHumanTasks,
  closingHumanTasks,
  humanTimingLabel,
  pendingHumanTasks,
} from "../src/task-cards.ts";
import type { HumanTaskStateDto } from "../src/types.ts";

function ht(partial: Partial<HumanTaskStateDto>): HumanTaskStateDto {
  return {
    step: "检索",
    title: "事项",
    guidance: "",
    target: "",
    timing: "during",
    detected: false,
    manual: false,
    explicitCancel: false,
    done: false,
    ...partial,
  };
}

test("humanTimingLabel：三档白话标签，未知值按进行中", () => {
  assert.equal(humanTimingLabel("before"), "开始前");
  assert.equal(humanTimingLabel("during"), "进行中");
  assert.equal(humanTimingLabel("after"), "收尾");
  assert.equal(humanTimingLabel("whenever"), "进行中");
});

test("pending/blocking/closing：按步骤过滤未完成，blocking 只收开工前，closing 只收收尾", () => {
  const states = [
    ht({ title: "a", timing: "before" }),
    ht({ title: "b", timing: "before", done: true, detected: true }),
    ht({ title: "c", timing: "after" }),
    ht({ title: "d", timing: "during" }),
    ht({ title: "e", step: "别的步骤", timing: "before" }),
  ];
  assert.deepEqual(
    pendingHumanTasks(states, "检索").map((s) => s.title),
    ["a", "c", "d"],
  );
  assert.deepEqual(
    blockingHumanTasks(states, "检索").map((s) => s.title),
    ["a"],
  );
  assert.deepEqual(
    closingHumanTasks(states, "检索").map((s) => s.title),
    ["c"],
  );
});

test("话题清单：收聚焦步骤下的全部卡，不按 kind 过滤", () => {
  const cards = [
    card({ id: "t-i1", name: "想法一", kind: "idea", step: "读文献" }),
    // 老项目留下的 draft 卡：讨论入口合并后仍必须看得见，不能凭空消失
    card({ id: "t-d1", name: "讨论一", kind: "draft", step: "读文献" }),
    card({ id: "t-i2", name: "别步想法", kind: "idea", step: "写综述" }),
    card({ id: "t-i3", name: "散想法", kind: "idea" }),
  ];
  assert.deepEqual(
    topicCardsForStep(cards, "读文献").map((c) => c.id),
    ["t-i1", "t-d1"],
  );
  // 别的步骤/未挂步骤的卡不进聚焦清单
  assert.deepEqual(
    topicCardsForStep(cards, "写综述").map((c) => c.id),
    ["t-i2"],
  );
  assert.deepEqual(topicCardsForStep(cards, "不存在的步骤"), []);
});

test("预置话题 chips：开聊过的不再出 chip（已在话题清单里）", () => {
  const cards = [
    card({ id: "t-1", name: "综述角度怎么收", kind: "idea", step: "读文献" }),
    card({ id: "t-2", name: "别步的同名", kind: "idea", step: "写综述" }),
  ];
  const seeds = ["综述角度怎么收", "纳入标准定多严"];
  assert.deepEqual(unstartedSeeds(cards, "读文献", seeds), ["纳入标准定多严"]);
  // 别的步骤开过的不算数
  assert.deepEqual(unstartedSeeds(cards, "写综述", seeds), seeds);
  // 无卡时全部未开聊
  assert.deepEqual(unstartedSeeds([], "读文献", seeds), seeds);
});

test("预置话题比对忽略首尾空白；空种子剔除", () => {
  const cards = [card({ id: "t-1", name: " 算力怎么排 ", kind: "idea", step: "跑实验" })];
  assert.deepEqual(unstartedSeeds(cards, "跑实验", ["算力怎么排", "  "]), []);
});
