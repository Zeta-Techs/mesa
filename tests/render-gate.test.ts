import assert from "node:assert/strict";
import test from "node:test";
import { RenderGate } from "../src/render-gate.ts";

test("RenderGate 并发上限：超限排队，释放即移交队首（FIFO）", async () => {
  const gate = new RenderGate(2);
  const r1 = await gate.acquire();
  const r2 = await gate.acquire();
  let got3 = false;
  const p3 = gate.acquire().then((r) => {
    got3 = true;
    return r;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(got3, false, "满槽时后来者应排队等待");
  r1(); // 释放 → 槽位直接移交队首 p3，不经计数
  const r3 = await p3;
  assert.equal(got3, true);
  r2(); // 释放 → 无等待者，计数递减
  const r4 = await gate.acquire(); // 此刻有空槽，立即可得
  r3();
  r4();
});

test("RenderGate release 幂等：重复调用不虚增槽位", async () => {
  const gate = new RenderGate(1);
  const r1 = await gate.acquire();
  r1();
  r1(); // 重复释放不得把 slots 减到负数/让后续超限
  r1();
  const r2 = await gate.acquire();
  let got3 = false;
  void gate.acquire().then(() => {
    got3 = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(got3, false, "仍持有 r2 时后来者应等待");
  r2();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(got3, true, "r2 释放后等待者被唤醒");
});

test("RenderGate 排队者中途放弃（拿到槽立即归还）：槽位继续下传", async () => {
  const gate = new RenderGate(1);
  const r1 = await gate.acquire();
  let got2 = false;
  const p2 = gate.acquire().then((r) => {
    got2 = true;
    return r;
  });
  let got3 = false;
  const p3 = gate.acquire().then((r) => {
    got3 = true;
    return r;
  });
  r1(); // 唤醒 p2
  const release2 = await p2;
  assert.equal(got2, true);
  assert.equal(got3, false);
  release2(); // p2 放弃：槽位应下传 p3
  await p3;
  assert.equal(got3, true);
  (await p3)();
});
