import assert from "node:assert/strict";
import test from "node:test";
import { caretOfAttention, strongestCaret } from "../src/run-caret.ts";

test("一个开着的 Agent：等确认 / 干活照注意力，做完了或还不知道按闲着", () => {
  assert.equal(caretOfAttention("confirm"), "confirm");
  assert.equal(caretOfAttention("working"), "working");
  assert.equal(caretOfAttention("done"), "idle");
  assert.equal(caretOfAttention(null), "idle");
});

test("几个合成一个：等确认 > 干活 > 闲着，空的没有", () => {
  assert.equal(strongestCaret(["idle", "working", "idle"]), "working");
  assert.equal(strongestCaret(["working", "confirm"]), "confirm");
  assert.equal(strongestCaret(["idle", null]), "idle");
  assert.equal(strongestCaret([]), null);
  assert.equal(strongestCaret([null, undefined]), null);
});
