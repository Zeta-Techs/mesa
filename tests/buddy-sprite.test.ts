import assert from "node:assert/strict";
import test from "node:test";
import {
  CAT_COLS,
  CAT_FRAMES,
  CAT_ROWS,
  DEFAULT_BUDDY_STYLE,
  buddyRow,
  calmPause,
  normalizeBuddyStyle,
  type BuddyPose,
} from "../src/buddy-sprite.ts";

const POSES: BuddyPose[] = ["idle", "wave", "think", "happy", "oops", "sleep", "wait", "walkRight", "walkLeft"];
const VALID_PIXELS = new Set([".", "M", "A", "H", "B", "E"]);

test("助手形象默认值是桌角黑猫，未知值回落到默认", () => {
  assert.equal(DEFAULT_BUDDY_STYLE, "cat");
  assert.equal(normalizeBuddyStyle(undefined), "cat");
  assert.equal(normalizeBuddyStyle(null), "cat");
  assert.equal(normalizeBuddyStyle("unknown"), "cat");
  assert.equal(normalizeBuddyStyle("cat"), "cat");
  assert.equal(normalizeBuddyStyle("monolith"), "monolith");
});

test("桌角黑猫每个姿势都是 13×10 纯像素矩阵，仅使用调色板字符，左走是右走镜像", () => {
  for (const pose of POSES) {
    const frames = CAT_FRAMES[pose];
    assert.ok(frames.length >= 1, `${pose} 至少有一帧`);
    for (const [fi, grid] of frames.entries()) {
      assert.equal(grid.length, CAT_ROWS, `${pose}[${fi}] 行数`);
      let lit = 0;
      for (const [ri, row] of grid.entries()) {
        assert.equal(row.length, CAT_COLS, `${pose}[${fi}] 第 ${ri} 行列数`);
        for (const ch of row) {
          assert.ok(VALID_PIXELS.has(ch), `${pose}[${fi}] 含非法像素字符 ${ch}`);
          if (ch !== ".") lit += 1;
        }
      }
      assert.ok(lit > 0, `${pose}[${fi}] 不能为空白帧`);
    }
  }
  assert.equal(CAT_FRAMES.walkLeft.length, CAT_FRAMES.walkRight.length);
  for (let i = 0; i < CAT_FRAMES.walkRight.length; i += 1) {
    const mirrored = CAT_FRAMES.walkRight[i].map((row) => [...row].reverse().join(""));
    assert.deepEqual(CAT_FRAMES.walkLeft[i], mirrored);
  }
});

test("挥手和开心放完回到待机，出错停在最后一帧，待机 / 思考 / 睡觉一直循环", () => {
  assert.equal(buddyRow("wave", null).after, "rest");
  assert.equal(buddyRow("happy", null).after, "rest");
  const oops = buddyRow("oops", null);
  assert.equal(oops.after, "hold");
  assert.equal(oops.hold, oops.durations.length - 1);
  for (const p of ["idle", "think", "sleep", "wait"] as const) {
    assert.equal(buddyRow(p, null).repeat, null);
  }
});

test("安静档停帧在有效范围内，间隔落在 35–50 秒", () => {
  for (const p of POSES) {
    const r = buddyRow(p, null);
    assert.ok(r.calmHold >= 0 && r.calmHold < r.durations.length, p);
    assert.equal(r.durations.length, CAT_FRAMES[p].length, `${p} 时长数与黑猫帧数对齐`);
  }
  assert.equal(calmPause(0), 35_000);
  assert.equal(calmPause(1), 50_000);
  assert.equal(calmPause(7), 50_000);
});
