import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error 纯 JS 脚本模块，无类型声明
import { extractReleaseNotes } from "../scripts/release-notes.mjs";

const LOG = `# 更新日志

## 未发布

- 未发布条目

## v0.2.0（2026-09-01）

- 两点零条目

## v0.1.0（2026-08-08，首个发布版本）

- 一点零条目
`;

test("优先取对应版本段，并在下一个二级标题处截断", () => {
  assert.equal(extractReleaseNotes(LOG, "0.2.0"), "- 两点零条目");
  assert.equal(extractReleaseNotes(LOG, "0.1.0"), "- 一点零条目");
});

test("版本号不做前缀匹配（0.2 不会命中 0.2.0）", () => {
  assert.equal(extractReleaseNotes(LOG, "0.2"), "- 未发布条目");
});

test("没有版本段时回落「未发布」，都没有则为空", () => {
  assert.equal(extractReleaseNotes(LOG, "0.3.0"), "- 未发布条目");
  assert.equal(extractReleaseNotes("# x\n\n## v0.1.0\n\n- a\n", "0.3.0"), "");
});

test("未发布段为空且无版本段时返回空串", () => {
  assert.equal(extractReleaseNotes("## 未发布\n\n## v0.1.0\n- a\n", "0.3.0"), "");
});
