import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BUDDY_CELL, BUDDY_COLS, BUDDY_ROWS, buddyClip, buddyRow, type BuddyPose } from "../src/buddy-sprite.ts";

const POSES: BuddyPose[] = ["idle", "wave", "think", "happy", "oops", "sleep", "wait", "walkRight", "walkLeft"];

test("小桌精灵图的尺寸与行表一致（重孵后忘改行表会在这里红）", () => {
  const buf = readFileSync(new URL("../src/assets/buddy/xiaozhuo.webp", import.meta.url));
  assert.equal(buf.toString("ascii", 12, 16), "VP8X");
  const width = buf.readUIntLE(24, 3) + 1;
  const height = buf.readUIntLE(27, 3) + 1;
  assert.equal(width, BUDDY_CELL * BUDDY_COLS);
  assert.equal(height, BUDDY_CELL * BUDDY_ROWS);
});

test("每个姿势一行、行号不重、帧数不超过列数", () => {
  const rows = [...POSES.map((p) => buddyRow(p, null)), buddyRow("idle", "coffee"), buddyRow("idle", "lamp")];
  assert.equal(new Set(rows.map((r) => r.index)).size, rows.length);
  for (const r of rows) {
    assert.ok(r.index >= 0 && r.index < BUDDY_ROWS);
    assert.ok(r.durations.length >= 1 && r.durations.length <= BUDDY_COLS);
    assert.ok(r.hold < r.durations.length);
  }
});

test("道具只跟着站着的样子，问着 / 出错 / 睡着都不带", () => {
  assert.notEqual(buddyRow("idle", "coffee").index, buddyRow("idle", null).index);
  assert.equal(buddyRow("think", "lamp").index, buddyRow("think", null).index);
  assert.equal(buddyRow("sleep", "coffee").index, buddyRow("sleep", null).index);
});

test("挥手和蹦一下放完回到站着，出错停在最后一帧，站着 / 在想 / 睡着一直循环", () => {
  assert.equal(buddyRow("wave", null).after, "rest");
  assert.equal(buddyRow("happy", null).repeat, 1);
  const oops = buddyRow("oops", null);
  assert.equal(oops.after, "hold");
  assert.equal(oops.hold, oops.durations.length - 1);
  for (const p of ["idle", "think", "sleep"] as const) assert.equal(buddyRow(p, null).repeat, null);
});

test("头像位裁掉四周空白、整个人都在，大图取整格", () => {
  const big = buddyClip(112);
  assert.deepEqual([big.width, big.height, big.w, big.h], [112, 112, BUDDY_CELL, BUDDY_CELL]);
  const small = buddyClip(34);
  assert.equal(small.height, 34);
  // 所有帧合起来的范围（x 15–216、y 8–216）都在裁切框里：盘腿睡时人坐得低，也不能切掉
  assert.ok(small.x <= 15 && small.x + small.w >= 216 && small.y <= 8 && small.y + small.h >= 216);
  assert.ok(small.x + small.w <= BUDDY_CELL && small.y + small.h <= BUDDY_CELL);
});
