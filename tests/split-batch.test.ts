import assert from "node:assert/strict";
import test from "node:test";
import { batchProgress, liveBatches, pushBatch, type SplitBatch } from "../src/split-batch.ts";

const batch: SplitBatch = {
  id: "b1",
  title: "三批质控",
  createdAt: 0,
  lanes: [
    { taskId: "a", name: "批次1", waits: false, started: true },
    { taskId: "b", name: "批次2", waits: false, started: true },
    { taskId: "c", name: "批次3", waits: false, started: true },
    { taskId: "d", name: "汇总", waits: true, started: false },
  ],
};

test("拆分回报：在做时写进度，等着的那路点名", () => {
  const st: Record<string, string> = { a: "running", b: "pending_review", c: "running", d: "pending" };
  const p = batchProgress(batch, (id) => st[id] ?? null);
  assert.equal(p.done, false);
  assert.equal(p.tone, "live");
  assert.equal(p.text, "「三批质控」3 路：2 路在做、1 路待验收；「汇总」在等");
  assert.deepEqual(p.lines[3], { name: "汇总", label: "还没开工" });
});

test("拆分回报：开了的都收场才算做完，失败的标红，等着的那路提示可以开了", () => {
  const st: Record<string, string> = { a: "pending_review", b: "completed", c: "failed", d: "pending" };
  const p = batchProgress(batch, (id) => st[id] ?? null);
  assert.equal(p.done, true);
  assert.equal(p.tone, "fail");
  assert.equal(p.text, "「三批质控」开的 3 路都收场了：1 路待验收、1 路已验收、1 路失败；「汇总」在等，前面验收后在项目里点开始");
  // 汇总那路已经开了，就不再说在等
  const st2: Record<string, string> = { ...st, c: "pending_review", d: "running" };
  assert.doesNotMatch(batchProgress(batch, (id) => st2[id] ?? null).text, /在等/);
});

test("拆分回报：没开起来的不算进度；记几批、过期不盯", () => {
  const none = batchProgress({ ...batch, lanes: batch.lanes.map((l) => ({ ...l, started: false })) }, () => "pending");
  assert.equal(none.done, false, "一路都没开不算做完");
  const list = pushBatch(pushBatch(pushBatch(pushBatch([], { ...batch, id: "1" }), { ...batch, id: "2" }), { ...batch, id: "3" }), { ...batch, id: "4" });
  assert.deepEqual(list.map((b) => b.id), ["4", "3", "2"]);
  assert.equal(liveBatches([{ ...batch, createdAt: 0 }], 8 * 24 * 3600 * 1000).length, 0);
});
