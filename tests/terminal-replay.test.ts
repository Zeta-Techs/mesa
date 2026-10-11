import assert from "node:assert/strict";
import test from "node:test";
import { terminalReplayText } from "../src/terminal-replay.ts";

test("回放只留最后若干行", () => {
  const lines = Array.from({ length: 5 }, (_, i) => `L${i}`);
  assert.equal(terminalReplayText(lines, 2), "L3\nL4");
});