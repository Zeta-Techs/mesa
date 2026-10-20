import assert from "node:assert/strict";
import test from "node:test";
import { collapseCarriageReturns } from "../src/stream-text.ts";

test("进度条跨块重绘：拼接后只留每行最后一帧", () => {
  const chunks = ["  -", "\r  \\", "\r  |", "\r 1024 KB / 3.62 MB", "\r 3.62 MB / 3.62 MB\r\n", "done\n"];
  assert.equal(collapseCarriageReturns(chunks.join("")), " 3.62 MB / 3.62 MB\ndone\n");
});

test("\\r 与 \\n 拆在两块里仍是正常换行", () => {
  assert.equal(collapseCarriageReturns("line\r" + "\nnext"), "line\nnext");
});

test("还没收到下一块时，行尾单独的 \\r 不吞掉本行", () => {
  assert.equal(collapseCarriageReturns("50%\r"), "50%");
});

test("纯文本与多行原样", () => {
  assert.equal(collapseCarriageReturns("a\nb\n"), "a\nb\n");
  assert.equal(collapseCarriageReturns(""), "");
});
