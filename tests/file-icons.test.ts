import assert from "node:assert/strict";
import test from "node:test";
import { fileTypeIcon, isPreviewableImagePath } from "../src/file-icons.ts";

test("常见类型命中固定识别色标签", () => {
  assert.deepEqual(fileTypeIcon("docs/guide.md"), {
    label: "M↓",
    color: "#5ca861",
  });
  assert.deepEqual(fileTypeIcon("src/App.tsx"), {
    label: "⚛",
    color: "#61dafb",
  });
  assert.deepEqual(fileTypeIcon("src/store.ts"), {
    label: "TS",
    color: "#3178c6",
  });
  assert.deepEqual(fileTypeIcon("src-tauri/src/lib.rs"), {
    label: "R",
    color: "#dea584",
  });
});

test("扩展名大小写不敏感，qmd 归入口记 markdown 图标", () => {
  assert.equal(fileTypeIcon("Notes/DRAFT.MD")?.label, "M↓");
  assert.equal(fileTypeIcon("manuscript/main.qmd")?.label, "M↓");
});

test("表格与幻灯扩展名走固定识别色", () => {
  assert.equal(fileTypeIcon("a.xlsx")?.label, "X");
  assert.equal(fileTypeIcon("a.xlsx")?.color, "#217346");
  assert.equal(fileTypeIcon("data.csv")?.label, "CSV");
  assert.equal(fileTypeIcon("deck.pptx")?.label, "P");
  assert.equal(fileTypeIcon("papers/to-fetch.ris")?.label, "RIS");
});

test("Windows 反斜杠路径与无扩展名/未知类型的兜底", () => {
  assert.equal(fileTypeIcon("src\\components\\GitPanel.tsx")?.label, "⚛");
  // 未收录返回 null，界面画通用文件图标（FileTypeMark），不留空槽
  assert.equal(fileTypeIcon("Makefile"), null);
  assert.equal(fileTypeIcon("archive.tar.unknownext"), null);
});

test("项目文件夹里常见的无图标文件都有符号（2026-10-17 用户截图）", () => {
  assert.equal(fileTypeIcon(".ccode/acceptance-log.jsonl")?.label, "{}");
  assert.equal(fileTypeIcon(".ccode/acceptance-log.lock")?.label, "⚙");
  assert.equal(fileTypeIcon(".gitignore")?.label, "⚙");
  // 备份副本按 .bak 认，不冒充原文件（inbox.md.bak-xxx 不是 Markdown）
  assert.equal(fileTypeIcon("notes/inbox.md.bak-1791881432")?.label, "BAK");
  assert.equal(fileTypeIcon("notes/inbox.md.bak-adopt-32664ebd")?.label, "BAK");
  assert.equal(fileTypeIcon("papers/watch-seen.md.bak-align-20261014")?.label, "BAK");
  assert.equal(fileTypeIcon("x.bak")?.label, "BAK");
  assert.equal(fileTypeIcon("notes/bakery.md")?.label, "M↓");
  assert.equal(fileTypeIcon("manuscript/template/elsarticle.cls")?.label, "TeX");
  assert.equal(fileTypeIcon("styles/nature.csl")?.label, "<>");
  assert.equal(fileTypeIcon("papers/endnote-import.enw")?.label, "RIS");
});

test("isPreviewableImagePath 覆盖 png/gif 大小写与 Windows 路径", () => {
  assert.equal(isPreviewableImagePath("/Users/a/效果演示/演示1.png"), true);
  assert.equal(isPreviewableImagePath("C:\\shots\\A.PNG"), true);
  assert.equal(isPreviewableImagePath("anim.gif"), true);
  assert.equal(isPreviewableImagePath("notes.md"), false);
  assert.equal(isPreviewableImagePath("photo.bmp"), false);
});
