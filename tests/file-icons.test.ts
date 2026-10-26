import assert from "node:assert/strict";
import test from "node:test";
import { fileTypeIcon, isPreviewableImagePath } from "../src/file-icons.ts";

test("常见类型命中图形 + 固定识别色", () => {
  assert.deepEqual(fileTypeIcon("docs/guide.md"), { glyph: "note", color: "#5ca861" });
  assert.deepEqual(fileTypeIcon("src/App.tsx"), { glyph: "code", color: "#61dafb" });
  assert.deepEqual(fileTypeIcon("src/store.ts"), { glyph: "code", color: "#3178c6" });
  assert.deepEqual(fileTypeIcon("src-tauri/src/lib.rs"), { glyph: "code", color: "#dea584" });
});

test("科研常见文件各有一种图形：PDF / Word / 笔记 / 题录分得开", () => {
  assert.deepEqual(fileTypeIcon("papers/kim2019.pdf"), { glyph: "pdf", color: "#e5534b" });
  assert.equal(fileTypeIcon("drafts/draft-v3.docx")?.glyph, "word");
  assert.equal(fileTypeIcon("papers/endnote.ris")?.glyph, "citation");
  assert.equal(fileTypeIcon("references.bib")?.glyph, "citation");
  assert.equal(fileTypeIcon("papers/endnote-import.enw")?.glyph, "citation");
  assert.equal(fileTypeIcon("figures/fig1.png")?.glyph, "image");
  // PDF 与纯文本同一个页面图形，靠颜色分
  assert.equal(fileTypeIcon("notes.txt")?.glyph, "text");
  assert.notEqual(fileTypeIcon("notes.txt")?.color, fileTypeIcon("a.pdf")?.color);
});

test("扩展名大小写不敏感，qmd 归入笔记图形", () => {
  assert.equal(fileTypeIcon("Notes/DRAFT.MD")?.glyph, "note");
  assert.equal(fileTypeIcon("manuscript/main.qmd")?.glyph, "note");
});

test("表格、幻灯、音视频与压缩包", () => {
  assert.equal(fileTypeIcon("a.xlsx")?.glyph, "sheet");
  assert.equal(fileTypeIcon("a.xlsx")?.color, "#217346");
  assert.equal(fileTypeIcon("data.csv")?.glyph, "sheet");
  assert.equal(fileTypeIcon("deck.pptx")?.glyph, "slides");
  assert.equal(fileTypeIcon("talk.MP3")?.glyph, "audio");
  assert.equal(fileTypeIcon("demo.mov")?.glyph, "video");
  assert.equal(fileTypeIcon("bundle.zip")?.glyph, "archive");
});

test("Windows 反斜杠路径与无扩展名/未知类型的兜底", () => {
  assert.equal(fileTypeIcon("src\\components\\GitPanel.tsx")?.glyph, "code");
  // 未收录返回 null，界面画通用文件图标（FileTypeMark），不留空槽
  assert.equal(fileTypeIcon("Makefile"), null);
  assert.equal(fileTypeIcon("archive.tar.unknownext"), null);
});

test("项目文件夹里常见的无图标文件都有图形（2026-10-17 用户截图）", () => {
  assert.equal(fileTypeIcon(".ccode/acceptance-log.jsonl")?.glyph, "braces");
  assert.equal(fileTypeIcon(".ccode/acceptance-log.lock")?.glyph, "config");
  assert.equal(fileTypeIcon(".gitignore")?.glyph, "config");
  // 备份副本按 .bak 认，不冒充原文件（inbox.md.bak-xxx 不是 Markdown）
  assert.equal(fileTypeIcon("notes/inbox.md.bak-1791881432")?.glyph, "backup");
  assert.equal(fileTypeIcon("notes/inbox.md.bak-adopt-32664ebd")?.glyph, "backup");
  assert.equal(fileTypeIcon("papers/watch-seen.md.bak-align-20261014")?.glyph, "backup");
  assert.equal(fileTypeIcon("x.bak")?.glyph, "backup");
  assert.equal(fileTypeIcon("notes/bakery.md")?.glyph, "note");
  assert.equal(fileTypeIcon("manuscript/template/elsarticle.cls")?.glyph, "code");
  assert.equal(fileTypeIcon("styles/nature.csl")?.glyph, "code");
});

test("isPreviewableImagePath 覆盖 png/gif 大小写与 Windows 路径", () => {
  assert.equal(isPreviewableImagePath("/Users/a/效果演示/演示1.png"), true);
  assert.equal(isPreviewableImagePath("C:\\shots\\A.PNG"), true);
  assert.equal(isPreviewableImagePath("anim.gif"), true);
  assert.equal(isPreviewableImagePath("notes.md"), false);
  assert.equal(isPreviewableImagePath("photo.bmp"), false);
});
