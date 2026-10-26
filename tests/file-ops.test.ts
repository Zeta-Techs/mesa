import assert from "node:assert/strict";
import test from "node:test";
import { nameDraftPrompt, stemSelection } from "../src/file-ops.ts";

test("改名默认只选主名，不选扩展名；文件夹与点开头的文件全选", () => {
  assert.deepEqual(stemSelection("report.final.docx", false), [0, 12]);
  assert.deepEqual(stemSelection("data.v2", true), [0, 7]);
  assert.deepEqual(stemSelection(".gitignore", false), [0, 10]);
  assert.deepEqual(stemSelection("README", false), [0, 6]);
});

test("名字输入行的提示随用途变", () => {
  assert.equal(nameDraftPrompt({ kind: "rename", path: "/p/notes/a.md", value: "a.md" }).label, "重命名 a.md：");
  assert.equal(nameDraftPrompt({ kind: "file", dir: "/p/notes", value: "" }).label, "新建于 notes：");
  assert.equal(nameDraftPrompt({ kind: "folder", dir: "/p", value: "" }).placeholder, "文件夹名称");
});
