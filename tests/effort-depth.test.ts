import assert from "node:assert/strict";
import test from "node:test";
import { effortDepth, effortValleyY } from "../src/effort-depth.ts";

test("深度按档位在名单里的位置算，最后一档为 1；默认 / 认不出为 null", () => {
  const levels = ["low", "medium", "high", "max"];
  assert.equal(effortDepth("low", levels), 0.25);
  assert.equal(effortDepth("max", levels), 1);
  assert.equal(effortDepth("", levels), null);
  assert.equal(effortDepth("ultra", levels), null);
  // Kimi 那种 on / off
  assert.equal(effortDepth("off", ["off", "on"]), 0);
  assert.equal(effortDepth("on", ["off", "on"]), 1);
});

test("M 的谷底随深度往下", () => {
  assert.ok(effortValleyY(0) < effortValleyY(0.5) && effortValleyY(0.5) < effortValleyY(1));
  assert.equal(effortValleyY(2), effortValleyY(1));
});
