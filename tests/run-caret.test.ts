import assert from "node:assert/strict";
import test from "node:test";
import { caretOfAttention, closeAsksFirst, strongestCaret } from "../src/run-caret.ts";

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

test("关掉开着的对话：只有明确回完话的直接关，干活 / 等确认 / 还不知道都先问", () => {
  assert.equal(closeAsksFirst("done"), false);
  assert.equal(closeAsksFirst("working"), true);
  assert.equal(closeAsksFirst("confirm"), true);
  assert.equal(closeAsksFirst(null), true);
  assert.equal(closeAsksFirst(undefined), true);
});
