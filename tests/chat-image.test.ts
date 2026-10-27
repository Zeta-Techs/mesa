import { test } from "node:test";
import assert from "node:assert/strict";
import { attachmentLines, composerImageKind, docPathFromLine, imagePathFromLine, labeledImageFromLine, splitDocPaths, splitImagePaths } from "../src/chat-image.ts";

test("整行绝对路径识别为图片", () => {
  assert.equal(imagePathFromLine("/Users/x/pic/a.png"), "/Users/x/pic/a.png");
  assert.equal(imagePathFromLine("~/shots/a.jpeg"), "~/shots/a.jpeg");
  assert.equal(imagePathFromLine("C:\\shots\\a.webp"), "C:\\shots\\a.webp");
});

test("带空格的路径 + shell 单引号包裹", () => {
  assert.equal(
    imagePathFromLine(
      "'/Users/x/Library/Application Support/PixPin/Temp/a.png'",
    ),
    "/Users/x/Library/Application Support/PixPin/Temp/a.png",
  );
});

test("Windows 双引号包裹也要剥掉（escapeShellPath 的 Windows 分支产物）", () => {
  assert.equal(
    imagePathFromLine('"C:\\Users\\a b\\shots\\x.png"'),
    "C:\\Users\\a b\\shots\\x.png",
  );
  // 双引号自身双写的回转
  assert.equal(
    imagePathFromLine('"C:\\a""b\\x.png"'),
    'C:\\a"b\\x.png',
  );
});

test("单引号回转 '\\'' 还原", () => {
  assert.equal(imagePathFromLine("'/tmp/it'\\''s.png'"), "/tmp/it's.png");
});

test("相对路径（含分隔符）识别，裸文件名不识别", () => {
  assert.equal(imagePathFromLine("figures/plot.svg"), "figures/plot.svg");
  assert.equal(imagePathFromLine("plot.png"), null);
});

test("URL / 正文短语 / 非图片扩展名不识别", () => {
  assert.equal(imagePathFromLine("https://example.com/a.png"), null);
  assert.equal(imagePathFromLine("结果保存在 figures/plot.png 里"), null);
  assert.equal(imagePathFromLine("/tmp/notes.md"), null);
  assert.equal(imagePathFromLine(""), null);
});

test("splitImagePaths 剥离图片行并保持顺序", () => {
  const { text, images } = splitImagePaths(
    "看一下这两张图\n/tmp/a.png\n中间说明\nfigures/b.jpg\n",
  );
  assert.deepEqual(images, ["/tmp/a.png", "figures/b.jpg"]);
  assert.equal(text, "看一下这两张图\n中间说明");
});

test("整条消息就是图片路径时正文为空", () => {
  const { text, images } = splitImagePaths("/tmp/a.png");
  assert.equal(text, "");
  assert.deepEqual(images, ["/tmp/a.png"]);
});

test("改图的图写成「原图：」「标注图：」行，消息里照样认成图片（2026-10-25）", () => {
  assert.deepEqual(attachmentLines({ path: "/a/p.png" }), ["/a/p.png"]);
  assert.deepEqual(attachmentLines({ path: "/a/p.png", marked: "/tmp/m.png" }), ["/tmp/m.png"]);
  assert.deepEqual(attachmentLines({ path: "/a/p.png", edit: true }), ["原图：/a/p.png"]);
  assert.deepEqual(attachmentLines({ path: "/a/p.png", edit: true, marked: "/tmp/m.png" }), ["标注图：/tmp/m.png", "原图：/a/p.png"]);
  assert.deepEqual(labeledImageFromLine("原图：/a/p.png"), { label: "原图", path: "/a/p.png" });
  assert.equal(labeledImageFromLine("原图：不是路径"), null);
  const { text, images } = splitImagePaths("帽子换蓝色\n标注图：/tmp/m.png\n原图：/a/p.png");
  assert.equal(text, "帽子换蓝色");
  assert.deepEqual(images, ["/tmp/m.png", "/a/p.png"]);
});

test("要不要模型看图：普通图片附件要；接着改的图只在标过时要", () => {
  const img = (o: { edit?: boolean; marked?: boolean }) => ({ path: "/a.png", isImage: true, marked: false, ...o });
  assert.equal(composerImageKind([]), null);
  assert.equal(composerImageKind([img({ edit: true })]), null);
  assert.equal(composerImageKind([img({ edit: true, marked: true })]), "marks");
  assert.equal(composerImageKind([img({ edit: true, marked: true }), img({})]), "plain");
  assert.equal(composerImageKind([{ path: "/a.pdf", isImage: false, marked: false }]), null);
});

test("splitDocPaths：整行的文档路径抽成附件，正文里顺口提到的不动", () => {
  const { text, docs } = splitDocPaths("帮我总结这篇\n'/Users/me/Downloads/Dynamic Kinetic.pdf'\n再看 notes/a.docx 第二节\nC:\\data\\t.xlsx");
  assert.equal(text, "帮我总结这篇\n再看 notes/a.docx 第二节");
  assert.deepEqual(docs, ["/Users/me/Downloads/Dynamic Kinetic.pdf", "C:\\data\\t.xlsx"]);
  assert.equal(docPathFromLine("paper.pdf"), null);
  assert.equal(docPathFromLine("https://x.org/a.pdf"), null);
  assert.equal(docPathFromLine("/tmp/a.png"), null);
});
