import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_MIN_PX, RIGHT_MIN_PX, clampTreeWidth, runLayout } from "../src/run-layout.ts";

const base = {
  rem: 14,
  treeOpen: true,
  treeWidth: 210,
  rightOpen: true,
  rightWidth: 460,
  rightExpanded: false,
};

test("宽窗口：三块都按偏好，对话拿剩下的", () => {
  const l = runLayout({ ...base, total: 1260 });
  assert.equal(l.treeShown, true);
  assert.equal(l.tree, 210);
  assert.equal(l.right, 460);
  assert.ok(1260 - l.tree - l.right >= CHAT_MIN_PX);
});

test("地方不够：先压右栏，压到最窄还不够才让文件树先收起；对话始终不窄于最窄", () => {
  // 210 + 360 + 440 = 1010：右栏从 460 压到 440，文件树还在
  let l = runLayout({ ...base, total: 1010 });
  assert.deepEqual([l.treeShown, l.right], [true, 440]);
  // 210 + 360 + 360 = 930 正好
  l = runLayout({ ...base, total: 930 });
  assert.deepEqual([l.treeShown, l.right], [true, RIGHT_MIN_PX]);
  // 再窄：文件树让位（偏好不改），右栏拿回「总宽 − 对话最窄」
  l = runLayout({ ...base, total: 840 });
  assert.equal(l.treeShown, false);
  assert.equal(l.treeYielded, true);
  assert.equal(l.right, 460);
  assert.ok(840 - l.right >= CHAT_MIN_PX);
  // 右栏关了：文件树回来
  l = runLayout({ ...base, total: 840, rightOpen: false });
  assert.deepEqual([l.treeShown, l.treeYielded, l.right], [true, false, 0]);
});

test("专注内容：文件树收起，右栏给对话留最窄那一条", () => {
  const l = runLayout({ ...base, total: 1000, rightExpanded: true, rightWidth: 900 });
  assert.equal(l.treeShown, false);
  assert.equal(l.right, 1000 - CHAT_MIN_PX);
});

test("文件树宽度：12–22rem，按根字号算", () => {
  assert.equal(clampTreeWidth(100, 14), 168);
  assert.equal(clampTreeWidth(500, 14), 308);
  assert.equal(clampTreeWidth(240, 16), 240);
  // 能拖到的最宽也要给对话和右栏最窄留地方
  assert.equal(runLayout({ ...base, total: 1000 }).treeMax, 1000 - CHAT_MIN_PX - RIGHT_MIN_PX);
  assert.equal(runLayout({ ...base, total: 2000 }).treeMax, 308);
});
