import assert from "node:assert/strict";
import test from "node:test";
import { docxDroppedSummary } from "../src/office-convert.ts";
import { artifactPreviewSurface, projectFilePreviewKind } from "../src/project-files.ts";

const none = {
  equations: 0,
  insertions: 0,
  deletions: 0,
  comments: 0,
  headersFooters: false,
  textboxes: 0,
  citationFields: 0,
};

test("Word 预览看不到的东西列成一句；全没有就不提示", () => {
  assert.equal(docxDroppedSummary(none), null);
  assert.equal(
    docxDroppedSummary({ ...none, equations: 3, insertions: 2, deletions: 1, headersFooters: true }),
    "这份文档里有3 个公式、3 处修订、页眉页脚，下面的预览显示不出来",
  );
  // 引用域单独一句，不算「看不到」
  assert.equal(docxDroppedSummary({ ...none, citationFields: 5 }), null);
});

test("幻灯与旧版 Office 的预览分流", () => {
  assert.equal(projectFilePreviewKind("/p/talk.pptx"), "slides");
  assert.equal(projectFilePreviewKind("/p/talk.ppsx"), "slides");
  assert.equal(projectFilePreviewKind("/p/old.ppt"), "legacy-doc");
  assert.equal(projectFilePreviewKind("/p/a.odt"), "legacy-doc");
  assert.equal(projectFilePreviewKind("/p/a.rtf"), "legacy-doc");
  assert.equal(artifactPreviewSurface("/p/talk.pptx"), "media");
});
