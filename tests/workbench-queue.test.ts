import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDecisionQueue,
  approvalHiddenKey,
  createDeferred,
  moveSelection,
  pruneHidden,
  queueKeyAction,
  queueTier,
  resolveSelection,
  type QueueApproval,
  type QueueRow,
} from "../src/workbench-queue.ts";

const item = (key: string, text = key) => ({ key, dot: "bg-warn-text", text, actionLabel: "去处理" });
const approval: QueueApproval = {
  tabId: "t1",
  requestId: "r1",
  title: "Codex 要运行一条命令",
  detail: "rm a.csv",
  request: { requestId: "r1", replyable: true, kind: "execute", command: "rm a.csv", path: null, oldText: null, newText: null, diff: null, detail: null, toolName: "shell", alwaysLabel: null },
  agent: "Codex",
  conversationCwd: "/p",
  allowLabel: "允许",
  denyLabel: "拒绝",
};

test("queueTier：停着等你 > 等你看结果 > 通知", () => {
  assert.equal(queueTier("confirm:run1"), "blocking");
  assert.equal(queueTier("live:codex:s1"), "blocking");
  assert.equal(queueTier("help:/p"), "blocking");
  assert.equal(queueTier("conflict:w1"), "blocking");
  assert.equal(queueTier("ready:w1"), "decide");
  assert.equal(queueTier("sched:x"), "decide");
  assert.equal(queueTier("update:1.2"), "decide");
  assert.equal(queueTier("lit:s:1"), "notice");
  assert.equal(queueTier("phone:3"), "notice");
});

test("buildDecisionQueue：分档稳定排序，待验收目标排在本档收件箱之后，hidden 的不出", () => {
  const rows = buildDecisionQueue({
    inbox: [item("lit:a"), item("ready:w1"), item("confirm:r1"), item("help:/p"), item("skill:x")],
    reviews: [{ id: "g1", label: "整理数据", projectName: "测试项目" }],
    projectOf: () => null,
    approvals: { "confirm:r1": approval },
    hidden: new Set(["skill:x"]),
  });
  assert.deepEqual(
    rows.map((r) => r.key),
    ["confirm:r1", "help:/p", "ready:w1", "review:g1", "lit:a"],
  );
  const first = rows[0];
  assert.equal(first.kind === "inbox" && first.approval?.requestId, "r1");
  const review = rows[3];
  assert.equal(review.text, "整理数据 · 待验收");
  assert.equal(review.project, "测试项目");
});

test("buildDecisionQueue：只有信息类能行内收起", () => {
  const rows = buildDecisionQueue({
    inbox: [item("lit:a"), item("confirm:r1"), item("ready:w")],
    reviews: [],
    projectOf: () => null,
    approvals: {},
    hidden: new Set(),
  });
  const dismissible = Object.fromEntries(rows.map((r) => [r.key, r.kind === "inbox" && r.dismissible]));
  assert.deepEqual(dismissible, { "confirm:r1": false, "ready:w": true, "lit:a": true });
});

test("queueKeyAction：A/R 只对能行内答的审批，E 只对能收起的，带修饰键不认", () => {
  const [withApproval, plain, notice] = buildDecisionQueue({
    inbox: [item("confirm:r1"), item("confirm:r2"), item("lit:a")],
    reviews: [],
    projectOf: () => null,
    approvals: { "confirm:r1": approval },
    hidden: new Set(),
  }) as QueueRow[];
  assert.equal(queueKeyAction({ key: "j" }, null), "next");
  assert.equal(queueKeyAction({ key: "ArrowUp" }, plain), "prev");
  assert.equal(queueKeyAction({ key: "Enter" }, plain), "open");
  assert.equal(queueKeyAction({ key: "Enter" }, null), null);
  assert.equal(queueKeyAction({ key: "a" }, withApproval), "allow");
  assert.equal(queueKeyAction({ key: "A" }, withApproval), "allow");
  assert.equal(queueKeyAction({ key: "r" }, withApproval), "deny");
  assert.equal(queueKeyAction({ key: "a" }, plain), null);
  assert.equal(queueKeyAction({ key: "e" }, plain), null);
  assert.equal(queueKeyAction({ key: "e" }, notice), "dismiss");
  assert.equal(queueKeyAction({ key: "a", metaKey: true }, withApproval), null);
  assert.equal(queueKeyAction({ key: "j", ctrlKey: true }, plain), null);
});

test("resolveSelection / moveSelection：按键记住选中行，那行没了停在原位置", () => {
  const rows = [{ key: "a" }, { key: "b" }, { key: "c" }];
  assert.equal(resolveSelection(rows, "b", 0), 1);
  assert.equal(resolveSelection([{ key: "a" }, { key: "c" }], "b", 1), 1);
  assert.equal(resolveSelection([{ key: "a" }], "b", 2), 0);
  assert.equal(resolveSelection([], "b", 2), -1);
  assert.equal(moveSelection(3, 2, 1), 2);
  assert.equal(moveSelection(3, 0, -1), 0);
  assert.equal(moveSelection(3, -1, 1), 0);
  assert.equal(moveSelection(0, 0, 1), -1);
});

test("pruneHidden：条目从收件箱消失后不再记", () => {
  assert.deepEqual([...pruneHidden(new Set(["a", "b"]), ["b", "c"])], ["b"]);
});

test("createDeferred：到点执行，撤销就不执行，同一 id 重排只算最后一次", () => {
  const queue: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const deferred = createDeferred({
    set: (fn, ms) => {
      const handle = { fn, ms, cleared: false };
      queue.push(handle);
      return handle;
    },
    clear: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  });
  const ran: string[] = [];
  deferred.schedule("x", () => ran.push("x"), 5000);
  deferred.schedule("y", () => ran.push("y"), 5000);
  assert.equal(deferred.has("x"), true);
  assert.equal(deferred.cancel("x"), true);
  assert.equal(deferred.cancel("x"), false);
  deferred.schedule("y", () => ran.push("y2"), 5000);
  for (const h of queue) if (!h.cleared) h.fn();
  assert.deepEqual(ran, ["y2"]);
  assert.equal(deferred.has("y"), false);
});


test("待发送按请求隐藏：同一 Run 的下一问仍出现，短暂没快照时不重现上一问", () => {
  const input = { inbox: [item("confirm:r")], reviews: [], projectOf: () => null, hidden: new Set([approvalHiddenKey("confirm:r", "one")]) };
  assert.equal(buildDecisionQueue({ ...input, approvals: { "confirm:r": { ...approval, requestId: "one" } } }).length, 0);
  assert.equal(buildDecisionQueue({ ...input, approvals: { "confirm:r": { ...approval, requestId: "two" } } }).length, 1);
  assert.equal(buildDecisionQueue({ ...input, approvals: {} }).length, 0);
  assert.deepEqual([...pruneHidden(input.hidden, ["confirm:r"])], [...input.hidden]);
  assert.equal(pruneHidden(input.hidden, ["confirm:rr"]).size, 0);
});
