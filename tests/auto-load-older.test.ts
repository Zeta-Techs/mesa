import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_LOAD_OLDER_THRESHOLD,
  nearTop,
  needsFill,
  wasPrepended,
} from "../src/auto-load-older.ts";

test("翻到顶部附近才自动加载更早的", () => {
  const m = { scrollHeight: 5000, clientHeight: 800 };
  assert.equal(nearTop({ ...m, scrollTop: 0 }), true);
  assert.equal(nearTop({ ...m, scrollTop: AUTO_LOAD_OLDER_THRESHOLD }), true);
  assert.equal(nearTop({ ...m, scrollTop: AUTO_LOAD_OLDER_THRESHOLD + 1 }), false);
  assert.equal(nearTop({ ...m, scrollTop: 4200 }), false);
});

test("内容不满一屏才算要补页", () => {
  assert.equal(needsFill({ scrollTop: 0, scrollHeight: 600, clientHeight: 800 }), true);
  assert.equal(needsFill({ scrollTop: 0, scrollHeight: 801, clientHeight: 800 }), true);
  assert.equal(needsFill({ scrollTop: 0, scrollHeight: 1200, clientHeight: 800 }), false);
});

test("只有原首条往后挪了才算前插（最新窗整体后滑不算）", () => {
  assert.equal(wasPrepended("a", ["x", "y", "a", "b"]), true);
  assert.equal(wasPrepended("a", ["a", "b", "c"]), false);
  // 最新一窗随文件增长往后滑：原首条掉出窗口
  assert.equal(wasPrepended("a", ["b", "c", "d"]), false);
  assert.equal(wasPrepended(null, ["a"]), false);
});
