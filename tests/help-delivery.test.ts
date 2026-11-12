import assert from "node:assert/strict";
import test from "node:test";
import { sendHelpDelivery } from "../src/help-delivery.ts";

test("回答只在原发送链成功后逐批确认", async () => {
  const calls: string[] = [];
  const error = await sendHelpDelivery("original", async () => ["delivery", "回答原文"], async (text) => {
    calls.push(text);
    return { error: null };
  }, async (id, runId) => { calls.push(`${id}:${runId}`); });
  assert.equal(error, null);
  assert.deepEqual(calls, ["回答原文", "delivery:original"]);
});

test("发送失败或异常不能确认或自动重发", async () => {
  for (const throws of [false, true]) {
    let attempts = 0;
    const error = await sendHelpDelivery("run", async () => ["id", "回答"], async () => {
      attempts += 1;
      if (throws) throw new Error("断线");
      return { error: "超时，可能仍在写入" };
    }, async () => { assert.fail("失败不得确认"); });
    assert.match(error!, /未自动重发/);
    assert.equal(attempts, 1);
  }
});

test("确认保存失败保留不明结果；没有待发回答不发送", async () => {
  const error = await sendHelpDelivery("run", async () => ["id", "回答"], async () => ({ error: null }), async () => { throw new Error("保存失败"); });
  assert.match(error!, /未自动重发/);
  assert.equal(await sendHelpDelivery("run", async () => null, async () => { assert.fail(); }, async () => { assert.fail(); }), null);
});

test("需要终端人工操作不算回答已送达", async () => {
  const error = await sendHelpDelivery("run", async () => ["id", "回答"], async () => ({ error: null, needsTerminal: true }), async () => { assert.fail("仅预填不能确认"); });
  assert.match(error!, /未自动重发/);
});
