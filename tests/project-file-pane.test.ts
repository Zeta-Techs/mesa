import assert from "node:assert/strict";
import test from "node:test";
import {
  clampFilePaneWidth,
  dockOccupant,
  filePaneShouldClose,
  FILE_PANE_WIDTH_DEFAULT,
  neighborFile,
} from "../src/project-file-pane.ts";

test("文件栏宽度：夹在 360–960，双击（负数）回默认", () => {
  assert.equal(clampFilePaneWidth(200), 360);
  assert.equal(clampFilePaneWidth(700.6), 701);
  assert.equal(clampFilePaneWidth(2000), 960);
  assert.equal(clampFilePaneWidth(-1), FILE_PANE_WIDTH_DEFAULT);
  assert.equal(clampFilePaneWidth(Number.NaN), FILE_PANE_WIDTH_DEFAULT);
});

test("停靠位轮流：只开一个给它，两个都开看谁在前", () => {
  assert.equal(dockOccupant("assistant", false, false), null);
  assert.equal(dockOccupant("assistant", false, true), "file");
  assert.equal(dockOccupant("file", true, false), "assistant");
  assert.equal(dockOccupant("file", true, true), "file");
  assert.equal(dockOccupant("assistant", true, true), "assistant");
});

test("上一个 / 下一个文件：按清单顺序，到头或不在清单里给 null", () => {
  const list = [
    { path: "/p/papers/a.md", name: "a.md" },
    { path: "/p/papers/b.md", name: "b.md" },
  ];
  assert.equal(neighborFile(list, "/p/papers/a.md", 1, false)?.name, "b.md");
  assert.equal(neighborFile(list, "/p/papers/a.md", -1, false), null);
  assert.equal(neighborFile(list, "/p/papers/b.md", 1, false), null);
  assert.equal(neighborFile(list, "/p/other.md", 1, false), null);
  assert.equal(neighborFile(undefined, "/p/papers/a.md", 1, false), null);
  const win = [
    { path: "C:/P/papers/a.md", name: "a.md" },
    { path: "C:/P/papers/b.md", name: "b.md" },
  ];
  assert.equal(neighborFile(win, "c:\\p\\papers\\A.md", 1, true)?.name, "b.md");
});

test("文件栏收起：只在项目页换到别的项目时；离开项目页、跨页打开的那一帧、有没保存的改动都不收", () => {
  const base = { paneRoot: "/p", isWindows: false, dirty: false };
  assert.equal(filePaneShouldClose({ ...base, page: "workspaces", prevProject: "/p", project: "/q" }), true);
  assert.equal(filePaneShouldClose({ ...base, dirty: true, page: "workspaces", prevProject: "/p", project: "/q" }), false);
  assert.equal(filePaneShouldClose({ ...base, page: "terminal", prevProject: "/p", project: "/q" }), false);
  assert.equal(filePaneShouldClose({ ...base, page: "workspaces", prevProject: "/q", project: "/q" }), false);
  assert.equal(filePaneShouldClose({ ...base, page: "workspaces", prevProject: "/q", project: "/p" }), false);
  assert.equal(filePaneShouldClose({ ...base, page: "workspaces", prevProject: undefined, project: "/q" }), false);
});
