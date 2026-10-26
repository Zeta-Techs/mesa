import assert from "node:assert/strict";
import test from "node:test";
import { stampKey } from "../src/file-watch.ts";

test("文件版本戳：大小或修改时间任一变化都算换了一版", () => {
  assert.equal(stampKey(null), null);
  const a = stampKey({ size: 10, modifiedMs: 1000 });
  assert.equal(a, "10:1000");
  assert.notEqual(stampKey({ size: 11, modifiedMs: 1000 }), a);
  assert.notEqual(stampKey({ size: 10, modifiedMs: 1001 }), a);
});
