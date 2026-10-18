import assert from "node:assert/strict";
import test from "node:test";
import {
  isUnsafeLitProjectDir,
  notesExcerptTarget,
  suggestLitProjectDir,
} from "../src/lit-project.ts";

test("PDF 在终端目录内时建议添加终端目录", () => {
  assert.equal(
    suggestLitProjectDir("/lib/papers/a.pdf", "/lib"),
    "/lib",
  );
  assert.equal(
    suggestLitProjectDir("/lib/papers/a.pdf", "/other"),
    "/lib/papers",
  );
  assert.equal(suggestLitProjectDir("/lib/a.pdf", null), "/lib");
});

test("Windows 路径同样按段判定", () => {
  assert.equal(
    suggestLitProjectDir("C:\\lib\\papers\\a.pdf", "C:\\lib", true),
    "C:\\lib",
  );
  assert.equal(
    suggestLitProjectDir("C:\\lib\\papers\\a.pdf", "C:\\other", true),
    "C:\\lib\\papers",
  );
});

test("家目录和盘符根不能当文献项目", () => {
  assert.equal(isUnsafeLitProjectDir("/Users/me", "/Users/me"), true);
  assert.equal(isUnsafeLitProjectDir("/", "/Users/me"), true);
  assert.equal(isUnsafeLitProjectDir("C:\\", "C:\\Users\\me", true), true);
  assert.equal(isUnsafeLitProjectDir("/Users/me/papers", "/Users/me"), false);
});

test("无流程或没有精读步骤时笔记写入项目根", () => {
  assert.deepEqual(
    notesExcerptTarget({ pipelineOptOut: true, steps: [{ workspaceName: "lit-notes" }] }),
    { kind: "project-root" },
  );
  assert.deepEqual(
    notesExcerptTarget({ steps: [] }),
    { kind: "project-root" },
  );
  assert.deepEqual(
    notesExcerptTarget({ steps: [{ workspaceName: "only" }] }),
    { kind: "project-root" },
  );
  assert.deepEqual(
    notesExcerptTarget({ steps: [{ workspaceName: "lit-search" }, { workspaceName: "lit-notes" }] }),
    { kind: "workspace", name: "lit-notes" },
  );
  // 没有 lit-notes 工作区名时按技能认精读步；第二步不再被盲目当成精读步
  assert.deepEqual(
    notesExcerptTarget({ steps: [{ workspaceName: "one" }, { workspaceName: "two" }] }),
    { kind: "project-root" },
  );
  assert.deepEqual(
    notesExcerptTarget({
      steps: [
        { workspaceName: "lit-survey-search", skills: ["lit-search"] },
        { workspaceName: "lit-survey-gap", skills: ["lit-notes"] },
      ],
    }),
    { kind: "workspace", name: "lit-survey-gap" },
  );
});
