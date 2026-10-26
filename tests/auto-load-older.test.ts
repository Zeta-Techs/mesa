import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_LOAD_OLDER_THRESHOLD,
  SCROLL_IDLE_MS,
  canCommitNow,
  nearTop,
  needsFill,
  wasPrepended,
} from "../src/auto-load-older.ts";

test("离顶三屏以内就提前加载更早的", () => {
  const m = { scrollHeight: 8000, clientHeight: 800 };
  assert.equal(nearTop({ ...m, scrollTop: 0 }), true);
  assert.equal(nearTop({ ...m, scrollTop: 2400 }), true);
  assert.equal(nearTop({ ...m, scrollTop: 2401 }), false);
  assert.equal(nearTop({ ...m, scrollTop: 7200 }), false);
  // 窗口很矮时不低于下限
  const short = { scrollHeight: 3000, clientHeight: 100 };
  assert.equal(nearTop({ ...short, scrollTop: AUTO_LOAD_OLDER_THRESHOLD }), true);
  assert.equal(nearTop({ ...short, scrollTop: AUTO_LOAD_OLDER_THRESHOLD + 1 }), false);
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

test("拉回来的更早一页等手停了再接；快撞顶就不等", () => {
  const m = { scrollTop: 3000, clientHeight: 800 };
  assert.equal(canCommitNow({ ...m, sinceLastScrollMs: 16 }), false);
  assert.equal(canCommitNow({ ...m, sinceLastScrollMs: SCROLL_IDLE_MS }), true);
  assert.equal(canCommitNow({ scrollTop: 400, clientHeight: 800, sinceLastScrollMs: 16 }), true);
  assert.equal(canCommitNow({ scrollTop: 401, clientHeight: 800, sinceLastScrollMs: 16 }), false);
});

test("只有人碰过滚动区之后的滚动才去接更早一页（贴底、锚点挪回不算）", async () => {
  const { scrollIsUsers, USER_SCROLL_WINDOW_MS } = await import("../src/auto-load-older.ts");
  assert.equal(scrollIsUsers(0), true);
  assert.equal(scrollIsUsers(USER_SCROLL_WINDOW_MS), true);
  assert.equal(scrollIsUsers(USER_SCROLL_WINDOW_MS + 1), false);
  assert.equal(scrollIsUsers(Number.POSITIVE_INFINITY), false, "打开后从没碰过");
});
