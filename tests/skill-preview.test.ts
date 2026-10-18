import assert from "node:assert/strict";
import test from "node:test";
import { splitSkillFrontmatter } from "../src/skill-preview.ts";

test("splitSkillFrontmatter：拆出顶层字段，续行与列表并进上一个键，正文去掉头", () => {
  const { fields, body } = splitSkillFrontmatter(
    [
      "---",
      "name: lit-notes",
      'description: "文献精读笔记规范"',
      "provides:",
      "  - notes",
      "  - bib",
      "outputs: |",
      "  notes/*.md",
      "---",
      "",
      "# 标题",
      "正文",
    ].join("\n"),
  );
  assert.deepEqual(fields, [
    { key: "name", value: "lit-notes" },
    { key: "description", value: "文献精读笔记规范" },
    { key: "provides", value: "notes · bib" },
    { key: "outputs", value: "notes/*.md" },
  ]);
  assert.equal(body, "# 标题\n正文");
});

test("splitSkillFrontmatter：没有 frontmatter 原样返回", () => {
  assert.deepEqual(splitSkillFrontmatter("# 只有正文"), { fields: [], body: "# 只有正文" });
  assert.equal(splitSkillFrontmatter("\uFEFF---\r\nname: x\r\n---\r\nbody").body, "body");
});

test("splitSkillFrontmatter：行内数组去括号与引号", () => {
  const { fields } = splitSkillFrontmatter(
    '---\noutputs: [analysis/, "figures/", eda-report.md]\nprovides: [data-eda]\n---\nx',
  );
  assert.deepEqual(fields, [
    { key: "outputs", value: "analysis/ · figures/ · eda-report.md" },
    { key: "provides", value: "data-eda" },
  ]);
});
