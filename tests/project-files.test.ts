import test from "node:test";
import assert from "node:assert/strict";
import {
  ancestorDirsToReveal,
  artifactPreviewSurface,
  batchAskPrompt,
  fileMatchesProjectFilter,
  flattenVisibleFiles,
  folderCountLabel,
  inTypingContext,
  neighborFile,
  projectFilePreviewKind,
  rangeSelect,
  supportsImmersiveReader,
} from "../src/project-files.ts";

test("research and coding files preview in-pane, including source", () => {
  assert.equal(projectFilePreviewKind("notes/a.md"), "text");
  assert.equal(projectFilePreviewKind("src/main.rs"), "text");
  assert.equal(projectFilePreviewKind("app.tsx"), "text");
  assert.equal(projectFilePreviewKind("Cargo.toml"), "text");
  assert.equal(projectFilePreviewKind("papers/a.pdf"), "pdf");
  assert.equal(projectFilePreviewKind("fig.png"), "image");
  assert.equal(projectFilePreviewKind("data.xlsx"), "xlsx");
  assert.equal(projectFilePreviewKind("data.csv"), "xlsx");
  assert.equal(projectFilePreviewKind("data.tsv"), "xlsx");
  assert.equal(projectFilePreviewKind("draft.docx"), "docx");
  assert.equal(projectFilePreviewKind("old.doc"), "legacy-doc");
});

test("产物核验：pdf/docx 就地预览，不跳运行页", () => {
  assert.equal(artifactPreviewSurface("output/draft.pdf"), "media");
  assert.equal(artifactPreviewSurface("output/draft.docx"), "media");
  assert.equal(artifactPreviewSurface("figures/fig1.png"), "media");
  assert.equal(artifactPreviewSurface("manuscript/draft.md"), "text");
  assert.equal(artifactPreviewSurface("papers/to-fetch.ris"), "text");
  assert.equal(artifactPreviewSurface("main.bin"), "jump");
});

test("沉浸阅读入口的判据统一：.markdown 与 .md 同等对待", () => {
  assert.equal(supportsImmersiveReader("papers/a.pdf"), true);
  assert.equal(supportsImmersiveReader("notes/a.md"), true);
  // 这条是回归点：预览浮层曾用 /\.(pdf|md|markdown)$/、工具条只认 md，
  // 同一个 .markdown 文件在一边有入口、另一边没有。
  assert.equal(supportsImmersiveReader("notes/a.markdown"), true);
  assert.equal(supportsImmersiveReader("notes/a.MD"), true);
  assert.equal(supportsImmersiveReader("notes/a.txt"), false);
  assert.equal(supportsImmersiveReader("notes/readme"), false);
  // 点开头的隐藏文件不是扩展名
  assert.equal(supportsImmersiveReader("notes/.md"), false);
  assert.equal(supportsImmersiveReader("notes/trailing."), false);
});

test("type filter keeps original office categories", () => {
  assert.equal(fileMatchesProjectFilter("a.md", "all"), true);
  assert.equal(fileMatchesProjectFilter("a.rs", "all"), true);
  assert.equal(fileMatchesProjectFilter("a.md", "doc"), true);
  assert.equal(fileMatchesProjectFilter("a.rs", "doc"), false);
  assert.equal(fileMatchesProjectFilter("a.pdf", "pdf"), true);
  assert.equal(fileMatchesProjectFilter("a.xlsx", "sheet"), true);
  assert.equal(fileMatchesProjectFilter("a.pptx", "slide"), true);
});

test("recent 是视图不是类型：不参与按类型收窄（搜索命中在最近视图下全保留）", () => {
  assert.equal(fileMatchesProjectFilter("a.rs", "recent"), true);
  assert.equal(fileMatchesProjectFilter("notes/a.md", "recent"), true);
  assert.equal(fileMatchesProjectFilter("papers/a.pdf", "recent"), true);
});

test("inTypingContext：方向键只在非打字焦点接管", () => {
  // 打字面：input / textarea（Monaco 编辑面）/ contenteditable / role=textbox
  const hit = { closest: () => ({}) } as unknown as HTMLElement;
  assert.equal(inTypingContext(hit), true);
  // 非打字面：文件行 button、普通 div
  const miss = { closest: () => null } as unknown as HTMLElement;
  assert.equal(inTypingContext(miss), false);
  // 焦点在 window/document（closest 不存在）：可接管
  assert.equal(inTypingContext(null), false);
  assert.equal(inTypingContext({} as HTMLElement), false);
});

test("flattenVisibleFiles only walks expanded directories", () => {
  const cache = {
    "/p": [
      { path: "/p/a.md", isDir: false },
      { path: "/p/src", isDir: true },
    ],
    "/p/src": [{ path: "/p/src/main.rs", isDir: false }],
  };
  assert.deepEqual(
    flattenVisibleFiles(cache, "/p", new Set()).map((item) => item.path),
    ["/p/a.md"],
  );
  assert.deepEqual(
    flattenVisibleFiles(cache, "/p", new Set(["/p/src"])).map((item) => item.path),
    ["/p/a.md", "/p/src/main.rs"],
  );
});

test("neighborFile steps to previous and next, and stops at ends", () => {
  const files = [{ path: "a" }, { path: "b" }, { path: "c" }];
  assert.equal(neighborFile(files, "b", 1)?.path, "c");
  assert.equal(neighborFile(files, "b", -1)?.path, "a");
  assert.equal(neighborFile(files, "a", -1), null);
  assert.equal(neighborFile(files, "c", 1), null);
  assert.equal(neighborFile(files, null, 1)?.path, "a");
});

test("ancestorDirsToReveal：展开到文件所在目录，不含根", () => {
  assert.deepEqual(ancestorDirsToReveal("/p", "/p/papers/a.pdf"), ["/p/papers"]);
  assert.deepEqual(ancestorDirsToReveal("/p", "/p/a.pdf"), []);
  assert.deepEqual(ancestorDirsToReveal("/p", "/other/a.pdf"), []);
  assert.deepEqual(
    ancestorDirsToReveal("C:\\p", "C:\\p\\papers\\a.pdf", true),
    ["C:\\p\\papers"],
  );
});

test("文件夹行数量：0 写空、封顶写 999+、没数不写", () => {
  assert.equal(folderCountLabel(undefined), null);
  assert.equal(folderCountLabel(null), null);
  assert.equal(folderCountLabel(0), "空");
  assert.equal(folderCountLabel(28), "28");
  assert.equal(folderCountLabel(1000), "999+");
});

test("Shift 连选：锚点到目标含两端，反向也行；锚点不在列表里只选目标", () => {
  const order = ["/p/a", "/p/b", "/p/c", "/p/d"];
  assert.deepEqual(rangeSelect(order, "/p/b", "/p/d"), ["/p/b", "/p/c", "/p/d"]);
  assert.deepEqual(rangeSelect(order, "/p/d", "/p/b"), ["/p/b", "/p/c", "/p/d"]);
  assert.deepEqual(rangeSelect(order, null, "/p/c"), ["/p/c"]);
  assert.deepEqual(rangeSelect(order, "/gone", "/p/c"), ["/p/c"]);
  assert.deepEqual(rangeSelect(order, "/p/a", "/gone"), []);
});

test("多选问 AI 的开场白：一份一行，带空格的路径加引号", () => {
  assert.equal(
    batchAskPrompt(["/p/a.pdf", "/p/my paper.pdf"]),
    '请看这几份文件：\n- /p/a.pdf\n- "/p/my paper.pdf"',
  );
});
