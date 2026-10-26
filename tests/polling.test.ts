import assert from "node:assert/strict";
import test from "node:test";
import { createPoller, type PollerEnv } from "../src/polling.ts";

function fakeEnv(hidden = false) {
  const timers = new Map<number, () => void>();
  let next = 1;
  const state = { hidden };
  const env: PollerEnv = {
    setInterval: (fn) => {
      const id = next++;
      timers.set(id, fn);
      return id;
    },
    clearInterval: (id) => {
      timers.delete(id);
    },
    hidden: () => state.hidden,
  };
  const fire = () => {
    for (const fn of [...timers.values()]) fn();
  };
  return { env, state, timers, fire };
}

test("定时触发；卸载后不再触发，alive() 变 false", () => {
  const { env, timers, fire } = fakeEnv();
  let calls = 0;
  let seenAlive: (() => boolean) | null = null;
  const poller = createPoller((alive) => {
    calls += 1;
    seenAlive = alive;
  }, 5000, env);
  fire();
  fire();
  assert.equal(calls, 2);
  assert.equal(seenAlive!(), true);
  poller.dispose();
  assert.equal(timers.size, 0);
  fire();
  assert.equal(calls, 2);
  assert.equal(seenAlive!(), false);
});

test("窗口隐藏时停，回到前台立刻补一次再接着定时", () => {
  const { env, state, timers, fire } = fakeEnv();
  let calls = 0;
  const poller = createPoller(() => {
    calls += 1;
  }, 5000, env);
  state.hidden = true;
  poller.onVisibilityChange();
  assert.equal(timers.size, 0);
  fire();
  assert.equal(calls, 0);
  state.hidden = false;
  poller.onVisibilityChange();
  assert.equal(calls, 1);
  assert.equal(timers.size, 1);
  fire();
  assert.equal(calls, 2);
});

test("一开始就隐藏：不起定时，显示后才开始", () => {
  const { env, state, timers } = fakeEnv(true);
  let calls = 0;
  const poller = createPoller(() => {
    calls += 1;
  }, 5000, env);
  assert.equal(timers.size, 0);
  state.hidden = false;
  poller.onVisibilityChange();
  assert.equal(calls, 1);
  assert.equal(timers.size, 1);
});

test("上一次还没回来不叠下一次，回来后恢复", async () => {
  const { env, fire } = fakeEnv();
  let calls = 0;
  let resolve: () => void = () => {};
  createPoller(() => {
    calls += 1;
    return new Promise<void>((r) => {
      resolve = r;
    });
  }, 5000, env);
  fire();
  fire();
  fire();
  assert.equal(calls, 1);
  resolve();
  await Promise.resolve();
  await Promise.resolve();
  fire();
  assert.equal(calls, 2);
});

test("失败的那次不卡住后面的", async () => {
  const { env, fire } = fakeEnv();
  let calls = 0;
  createPoller(() => {
    calls += 1;
    return Promise.reject(new Error("x"));
  }, 5000, env);
  fire();
  await Promise.resolve();
  await Promise.resolve();
  fire();
  assert.equal(calls, 2);
});
