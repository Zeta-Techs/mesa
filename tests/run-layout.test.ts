import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_MIN_PX, RIGHT_MIN_PX, runLayout } from "../src/run-layout.ts";

const base = { rightOpen: true, rightWidth: 460 };

test("宽窗口：右栏按偏好，对话拿剩下的", () => {
  const l = runLayout({ ...base, total: 1260 });
  assert.equal(l.right, 460);
  assert.ok(1260 - l.right >= CHAT_MIN_PX);
});

test("地方不够：只压右栏，压到最窄；对话始终不窄于最窄", () => {
  // 360 + 440 = 800：右栏从 460 压到 440
  let l = runLayout({ ...base, total: 800 });
  assert.equal(l.right, 440);
  // 360 + 360 正好
  l = runLayout({ ...base, total: 720 });
  assert.equal(l.right, RIGHT_MIN_PX);
  // 窗口实在太窄：右栏不再往下压，宁可让对话让一点
  l = runLayout({ ...base, total: 600 });
  assert.equal(l.right, RIGHT_MIN_PX);
});

test("右栏关着：不占宽，但能拖到的最宽照给", () => {
  const l = runLayout({ ...base, total: 1000, rightOpen: false });
  assert.equal(l.right, 0);
  assert.equal(l.rightMax, 1000 - CHAT_MIN_PX);
});

test("专注内容（偏好宽被设成窗口宽六成以上）：给对话留最窄那一条", () => {
  const l = runLayout({ ...base, total: 1000, rightWidth: 900 });
  assert.equal(l.right, 1000 - CHAT_MIN_PX);
});

test("偏好比最窄还窄：抬到最窄", () => {
  assert.equal(runLayout({ ...base, total: 1200, rightWidth: 100 }).right, RIGHT_MIN_PX);
});
