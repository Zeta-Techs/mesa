import assert from "node:assert/strict";
import test from "node:test";
import {
  groupFilesByStatus,
  userDirtyFiles,
  statusBadgeTitle,
  statusGroupKey,
} from "../src/git-status-groups.ts";
import type { GitFileDto } from "../src/types.ts";

function file(path: string, status: string): GitFileDto {
  return { path, status, additions: null, deletions: null };
}

test("状态分组：A/?? 进新增，D 进删除，M/R 与未知状态兜底进修改", () => {
  assert.equal(statusGroupKey("M"), "modified");
  assert.equal(statusGroupKey("R"), "modified");
  assert.equal(statusGroupKey("A"), "added");
  assert.equal(statusGroupKey("??"), "added");
  assert.equal(statusGroupKey("D"), "deleted");
  assert.equal(statusGroupKey("U"), "unmerged");
  assert.equal(statusGroupKey("UU"), "unmerged");
});

test("状态分组：组序固定为 冲突 → 修改 → 新增 → 删除，组内保持原顺序，空组省略", () => {
  const groups = groupFilesByStatus([
    file("new.ts", "??"),
    file("a.ts", "M"),
    file("gone.ts", "D"),
    file("b.ts", "M"),
    file("staged.ts", "A"),
    file("hit.ts", "U"),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.label, g.files.map((f) => f.path)]),
    [
      ["冲突的", ["hit.ts"]],
      ["修改的", ["a.ts", "b.ts"]],
      ["新增的", ["new.ts", "staged.ts"]],
      ["删除的", ["gone.ts"]],
    ],
  );
  assert.deepEqual(groupFilesByStatus([]), []);
});

test("未跟踪的验收账本不算用户改动", () => {
  const files = [
    file(".ccode/acceptance-log.jsonl", "??"),
    file(".ccode/acceptance-log.lock", "??"),
    file("papers/included.md", "M"),
  ];
  assert.deepEqual(
    userDirtyFiles(files).map((row) => row.path),
    ["papers/included.md"],
  );
  // 2026-10-13 双台账口径：验收台账已跟踪的 M 也不算「你的改动」（合并写台账不该回头催你）
  assert.deepEqual(
    userDirtyFiles([file(".ccode/acceptance-log.jsonl", "M")]).map((row) => row.path),
    [],
  );
});

test("积累面台账不算「你的改动未存入历史」（与合并闸门同口径）", () => {
  const clean = [
    file("notes/inbox.md", "M"),
    file("papers/watch-seen.md", "M"),
    file("papers/watch-followup.md", "??"),
    file("papers/reading-list.md", "??"),
    file(".ccode/watch-explains.json", "??"),
    file(".ccode/pending-registrations.json", "??"),
    file("notes/my-note.md", "??"),
    file("notes/slug/我的笔记.md", "M"),
    file(".ccode/watch/s1/watchlist.md", "M"),
  ];
  assert.deepEqual(
    userDirtyFiles(clean).map((row) => row.path),
    [],
  );
  // 防呆：积累账被违规提交后变 tracked 的 M 要显形；流程正典照常计
  const visible = [
    file("papers/reading-list.md", "M"),
    file(".ccode/watch-explains.json", "M"),
    file("papers/included.md", "M"),
    file("notes/index.json", "M"),
    file("notes/inbox.md.bak", "??"),
    // 豁免按精确路径认：产出目录里的同名文件不算台账（与后端口径对称）
    file("output/acceptance-log.jsonl", "M"),
  ];
  assert.deepEqual(
    userDirtyFiles(visible).map((row) => row.path),
    ["papers/reading-list.md", ".ccode/watch-explains.json", "papers/included.md", "notes/index.json", "notes/inbox.md.bak", "output/acceptance-log.jsonl"],
  );
});

test("徽标悬浮 title：字母保留 + 白话说明", () => {
  assert.equal(statusBadgeTitle("M"), "M · 已修改");
  assert.equal(statusBadgeTitle("??"), "?? · 新文件");
  assert.equal(statusBadgeTitle("UU"), "UU · 未合并（冲突）");
  assert.equal(statusBadgeTitle("U"), "U · 未合并（冲突）");
});

test("项目页提醒不把 Mesa 自有档案（.ccode/、.gitignore）当成你的改动", async () => {
  const { isMesaCardPath, userWorkDirtyFiles, userDirtyFiles } = await import("../src/git-status-groups.ts");
  const files = [
    { path: ".ccode/project.toml", status: "M" },
    { path: ".ccode/drafts/lit-notes.md", status: "??" },
    { path: ".gitignore", status: "M" },
    { path: "papers/included.md", status: "M" },
    { path: "notes/inbox.md", status: "M" },
  ];
  assert.ok(isMesaCardPath(".ccode/project.toml"));
  assert.ok(!isMesaCardPath(".ccodex/a.md"));
  assert.ok(!isMesaCardPath("papers/.gitignore"));
  // 项目页 / 开工弹层：只剩你自己的改动（开工与评审前 Mesa 会自己提交档案）
  assert.deepEqual(userWorkDirtyFiles(files).map((f) => f.path), ["papers/included.md"]);
  // 评审提交面板照旧能看见档案卡——挡合并的东西都要能提交
  assert.ok(userDirtyFiles(files).some((f) => f.path === ".ccode/project.toml"));
});
