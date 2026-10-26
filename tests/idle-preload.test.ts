import assert from "node:assert/strict";
import test from "node:test";
import { preloadInIdle } from "../src/idle-preload.ts";

function fakeIdle() {
  const queue: Array<() => void> = [];
  return {
    schedule: (cb: () => void) => {
      queue.push(cb);
    },
    async flush() {
      const cb = queue.shift();
      cb?.();
      // 让 load().then(next) 跑完
      for (let i = 0; i < 4; i++) await Promise.resolve();
    },
    get pending() {
      return queue.length;
    },
  };
}

test("一次只载一块，载完才排下一个空闲", async () => {
  const idle = fakeIdle();
  const loaded: string[] = [];
  preloadInIdle(
    ["运行页", "编辑器", "PDF"].map((name) => async () => {
      loaded.push(name);
    }),
    idle.schedule,
  );
  assert.equal(idle.pending, 1);
  assert.deepEqual(loaded, []);
  await idle.flush();
  assert.deepEqual(loaded, ["运行页"]);
  assert.equal(idle.pending, 1);
  await idle.flush();
  await idle.flush();
  assert.deepEqual(loaded, ["运行页", "编辑器", "PDF"]);
  assert.equal(idle.pending, 0);
});

test("某块载失败不挡后面的；取消后不再载", async () => {
  const idle = fakeIdle();
  const loaded: string[] = [];
  const stop = preloadInIdle(
    [
      async () => {
        throw new Error("x");
      },
      async () => {
        loaded.push("二");
      },
      async () => {
        loaded.push("三");
      },
    ],
    idle.schedule,
  );
  await idle.flush();
  await idle.flush();
  assert.deepEqual(loaded, ["二"]);
  stop();
  await idle.flush();
  assert.deepEqual(loaded, ["二"]);
});
