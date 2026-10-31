import { test } from "node:test";
import assert from "node:assert/strict";
import { swipeFollowOffset } from "../src/quota-swipe.ts";

test("跟手位移有阻力、封顶，到头的方向阻力更大", () => {
  assert.equal(swipeFollowOffset(20, true), 7);
  assert.equal(swipeFollowOffset(-20, true), -7);
  assert.equal(swipeFollowOffset(200, true), 28);
  assert.equal(swipeFollowOffset(-200, false), -10);
  assert.ok(Math.abs(swipeFollowOffset(20, false)) < Math.abs(swipeFollowOffset(20, true)));
});
