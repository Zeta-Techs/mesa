import test from "node:test";
import assert from "node:assert/strict";
import {
  canDragChatToStep,
  canLeaveStep,
  missingStepTargets,
  pastChatDragThreshold,
  stepWriteTargets,
} from "../src/chat-step-drag.ts";
import { groupStepChats } from "../src/sidebar-chats.ts";

test("拖进步骤：课题里、不在工作区、不是精读 / 内部对话才能拖；移出只给记出来的步骤", () => {
  assert.equal(canDragChatToStep({}, true), true);
  assert.equal(canDragChatToStep({}, false), false, "随手聊不在课题里");
  assert.equal(canDragChatToStep({ workspace: "lit-search" }, true), false, "工作区的对话步骤由工作区定");
  assert.equal(canDragChatToStep({ reader: true }, true), false);
  assert.equal(canDragChatToStep({ internal: true }, true), false);
  assert.equal(canLeaveStep({ stepName: "文献检索与筛选" }), true);
  assert.equal(canLeaveStep({ stepName: "文献检索与筛选", workspace: "lit-search" }), false);
  assert.equal(canLeaveStep({ stepName: null }), false);
  assert.equal(pastChatDragThreshold(3, 4), false);
  assert.equal(pastChatDragThreshold(0, 6), true);
});

test("拖的时候补出还没有对话的步骤，按档案卡顺序编号", () => {
  assert.deepEqual(missingStepTargets(["文献检索与筛选", "文献精读与笔记", "综述大纲"], ["文献检索与筛选"]), [
    { name: "文献精读与笔记", index: 2 },
    { name: "综述大纲", index: 3 },
  ]);
  assert.deepEqual(missingStepTargets([], ["x"]), []);
});

test("接力对话写步骤归属时各段都写、不重复", () => {
  assert.deepEqual(
    stepWriteTargets({
      agent: "codex",
      sessionId: "B",
      relaySegments: [
        { agent: "claude-code", sessionId: "A" },
        { agent: "codex", sessionId: "B" },
      ],
    }),
    [
      { agent: "codex", sessionId: "B" },
      { agent: "claude-code", sessionId: "A" },
    ],
  );
});

test("从步骤发起的研讨挂进那一步，这一步还没有对话也建组；没步骤名的不收", () => {
  const { groups } = groupStepChats([], [], [
    { id: "c1", step: "文献检索与筛选" },
    { id: "c2", step: null },
    { id: "c3", step: "文献检索与筛选" },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].step, "文献检索与筛选");
  assert.deepEqual(groups[0].consults, ["c1", "c3"]);
  assert.deepEqual(groups[0].rows, []);
});
