import assert from "node:assert/strict";
import test from "node:test";
import { storageClearConfirmText, storageSegments, summarizeStorage } from "../src/settings-storage.ts";
import type { StorageEntryDto } from "../src/types.ts";

const cfg = "/Users/u/Library/Application Support/ccode";
const entry = (p: Partial<StorageEntryDto> & { path: string }): StorageEntryDto => ({
  label: "x", bytes: 0, exists: true, clearable: false, id: "x", approx: false, root: "config", ...p,
});

test("按归属分组，组头写一次根目录（家目录折成 ~），行里只写相对名", () => {
  const s = summarizeStorage([
    entry({ path: `${cfg}/app.db`, bytes: 1000 }),
    entry({ path: `${cfg}/snapshots`, bytes: 500, clearable: true, id: "snapshots" }),
    entry({ path: "/Users/u/ccode/worktrees", bytes: 4000, root: "home", id: "~worktrees", approx: true }),
    entry({ path: "/Users/u/ccode/workspaces", exists: false, root: "home", id: "~workspaces" }),
  ]);
  assert.deepEqual(s.groups.map((g) => [g.title, g.rootLabel]), [
    ["Mesa 数据", "~/Library/Application Support/ccode"],
    ["工作副本", "~/ccode"],
  ]);
  assert.deepEqual(s.groups[0].rows.map((r) => r.rel), ["app.db", "snapshots/"]);
  assert.deepEqual(s.groups[1].rows.map((r) => r.rel), ["worktrees/", "workspaces/"]);
  assert.equal(s.total, 5500, "不存在的条目不计");
  assert.equal(s.totalApprox, true, "有一项统计提前收手，总计就是下限");
});

test("没有工作副本条目时不折家目录，也不报错", () => {
  const s = summarizeStorage([entry({ path: `${cfg}/app.db` })]);
  assert.equal(s.groups.length, 1);
  assert.equal(s.groups[0].rootLabel, cfg);
});

test("工作副本换到别的盘：家目录由调用方给，不被条目路径误折；旧位置单独成组", () => {
  const s = summarizeStorage(
    [
      entry({ path: `${cfg}/app.db`, bytes: 1000 }),
      entry({ path: "D:\\mesa\\ccode\\worktrees", bytes: 900, root: "home", id: "~worktrees" }),
      entry({ path: "D:\\mesa\\ccode\\workspaces", bytes: 100, root: "home", id: "~workspaces" }),
      entry({ path: "C:\\Users\\u\\ccode\\worktrees", bytes: 7000, root: "home-old", id: "~old-worktrees" }),
    ],
    true,
    "C:\\Users\\u",
  );
  assert.deepEqual(s.groups.map((g) => [g.title, g.rootLabel]), [
    ["Mesa 数据", cfg],
    ["工作副本", "D:\\mesa\\ccode"],
    ["工作副本（旧位置，换位置前留下的）", "~/ccode"],
  ]);
  assert.deepEqual(s.groups[1].rows.map((r) => r.rel), ["worktrees/", "workspaces/"]);
  assert.equal(s.total, 9000);
});

test("条形图分段：按大小取前几项，余下并成「其他」，不存在/0 字节不画", () => {
  const seg = storageSegments(
    [
      entry({ path: "/a", label: "会话索引与用量（app.db）", bytes: 100 }),
      entry({ path: "/b", label: "技能库", bytes: 300 }),
      entry({ path: "/c", label: "编程工作树", bytes: 500, root: "home" }),
      entry({ path: "/d", label: "编程工作树", bytes: 70, root: "home-old" }),
      entry({ path: "/e", label: "备份", bytes: 20 }),
      entry({ path: "/f", label: "目录", bytes: 10 }),
      entry({ path: "/g", label: "不存在", bytes: 999, exists: false }),
      entry({ path: "/h", label: "空", bytes: 0 }),
    ],
    3,
  );
  assert.deepEqual(seg.map((s) => [s.label, s.tone]), [
    ["编程工作树", 0],
    ["技能库", 1],
    ["会话索引与用量", 2],
    ["其他", -1],
  ]);
  assert.equal(Math.round(seg.reduce((n, s) => n + s.pct, 0)), 100);
  assert.deepEqual(storageSegments([entry({ path: "/x", bytes: 0 })]), []);
  assert.equal(
    storageSegments([entry({ path: "/o", label: "编程工作树", bytes: 5, root: "home-old" })])[0].label,
    "编程工作树（旧位置）",
  );
});

test("快照清理确认要说清会丢什么、怎么找回", () => {
  const text = storageClearConfirmText("snapshots", "会话快照", "15 MB");
  assert.match(text, /15 MB/);
  assert.match(text, /从对话列表里消失/);
  assert.match(text, /回收站/);
});
