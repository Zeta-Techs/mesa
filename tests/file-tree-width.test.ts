import assert from "node:assert/strict";
import test from "node:test";
import { clampFileTreeWidth, FILE_TREE_DEFAULT_REM, parseFileTreeWidth } from "../src/file-tree-width.ts";

test("文件树宽度：不窄于 16rem，给预览至少留 24rem", () => {
  assert.equal(clampFileTreeWidth(100, 14), 224);
  assert.equal(clampFileTreeWidth(900, 14, 1400), 900);
  assert.equal(clampFileTreeWidth(1200, 14, 1400), 1064, "1400 宽的整行，预览留 336");
  assert.equal(clampFileTreeWidth(500, 14, 400), 224, "整行再窄也不窄过下限");
  assert.equal(clampFileTreeWidth(Number.NaN, 14), FILE_TREE_DEFAULT_REM * 14);
});

test("文件树宽度存档读回：坏值、没存过都回默认宽", () => {
  assert.equal(parseFileTreeWidth(null, 14), FILE_TREE_DEFAULT_REM * 14);
  assert.equal(parseFileTreeWidth("abc", 14), FILE_TREE_DEFAULT_REM * 14);
  assert.equal(parseFileTreeWidth("-5", 14), FILE_TREE_DEFAULT_REM * 14);
  assert.equal(parseFileTreeWidth("520", 14), 520);
  assert.equal(parseFileTreeWidth("50", 14), 224);
});
