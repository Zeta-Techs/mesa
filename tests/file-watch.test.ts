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

import { encodingLabel, previewSaveCompletion } from "../src/file-preview.ts";

test("编码名给人看：GBK 家族统一叫 GBK，其余照常", () => {
  assert.equal(encodingLabel("gb18030"), "GBK");
  assert.equal(encodingLabel("GBK"), "GBK");
  assert.equal(encodingLabel("Big5"), "Big5");
  assert.equal(encodingLabel("windows-1252"), "Windows-1252");
  assert.equal(encodingLabel("UTF-16LE"), "UTF-16LE");
});

test("保存完成后的基线带上写回时用的编码", () => {
  const c = previewSaveCompletion("a", "a", "rev", "GBK");
  assert.equal(c.snapshot.encoding, "GBK");
  assert.equal(c.dirty, false);
  assert.equal(previewSaveCompletion("a", "ab", "rev").snapshot.encoding, null);
});
