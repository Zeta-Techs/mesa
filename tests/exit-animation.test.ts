import assert from "node:assert/strict";
import test from "node:test";
import {
  EXIT_ANIM_MS,
  exitDurationMs,
  nextExitRenderState,
} from "../src/exit-animation.ts";

test("exitDurationMs：reduced-motion 取 0（立即卸载），否则用基础时长", () => {
  assert.equal(exitDurationMs(true), 0);
  assert.equal(exitDurationMs(false), EXIT_ANIM_MS);
  assert.equal(exitDurationMs(false, 220), 220);
  assert.equal(exitDurationMs(true, 220), 0);
});

test("nextExitRenderState：打开恒满挂载、清退场标记", () => {
  assert.deepEqual(nextExitRenderState({ render: false, exiting: false }, true, 150), {
    render: true,
    exiting: false,
  });
  // 退场途中重开：exiting 归位
  assert.deepEqual(nextExitRenderState({ render: true, exiting: true }, true, 150), {
    render: true,
    exiting: false,
  });
});

test("nextExitRenderState：关闭时 dur<=0 立即卸载", () => {
  assert.deepEqual(nextExitRenderState({ render: true, exiting: false }, false, 0), {
    render: false,
    exiting: false,
  });
});

test("nextExitRenderState：关闭时保持挂载进入 exiting（时长 > 0）", () => {
  assert.deepEqual(nextExitRenderState({ render: true, exiting: false }, false, 150), {
    render: true,
    exiting: true,
  });
  // 从未挂载过的组件关闭不产生退场残影
  assert.deepEqual(nextExitRenderState({ render: false, exiting: false }, false, 150), {
    render: false,
    exiting: false,
  });
});
