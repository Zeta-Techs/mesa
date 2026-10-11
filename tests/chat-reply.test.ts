import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmChoices,
  mentionedProjectFiles,
  splitReplySections,
} from "../src/chat-reply.ts";

test("两个以上小标题才折叠", () => {
  const sections = splitReplySections("开头\n\n验收摘要：\n565 条\n\n尚未验证：\n7 篇");
  assert.equal(sections?.length, 3);
  assert.equal(sections?.[1]?.title, "验收摘要：");
  assert.equal(splitReplySections("只有一段话"), null);
});

test("围栏代码块里的行不当小标题，代码不拆进折叠区", () => {
  const text = [
    "配置如下：",
    "",
    "```yaml",
    "server:",
    "  port: 8080",
    "db:",
    "  host: localhost",
    "```",
    "",
    "部署步骤：",
    "1. npm run build",
  ].join("\n");
  const sections = splitReplySections(text);
  // 只有「配置如下：」「部署步骤：」两个真标题；YAML 键行必须留在正文里
  assert.equal(sections?.length, 2);
  assert.equal(sections?.[0]?.title, "配置如下：");
  assert.ok(sections?.[0]?.body.includes("server:"));
  assert.ok(sections?.[0]?.body.includes("```yaml"));
  assert.ok(!sections?.some((s) => s.title === "db:" || s.title === "server:"));
});

test("相对文件路径可点，网址不是；./ 前缀对齐 git 状态", () => {
  const files = mentionedProjectFiles(
    "见 papers/screening.md 和 ./scripts/run.py，https://a.com/b.md 不算",
  );
  assert.deepEqual(files, ["papers/screening.md", "scripts/run.py"]);
});

test("登录确认不提供批准按钮", () => {
  assert.equal(confirmChoices("需要登录").length, 0);
  assert.equal(confirmChoices("permission to use Bash")[0]?.key, "y");
  assert.equal(confirmChoices("select a model")[0]?.key, undefined);
  // 「选择」不再当菜单词——真 y/n 确认题含它时按钮照常给（2026-10-11 修误伤）
  assert.equal(confirmChoices("选择是否继续？[y/n]")[0]?.key, "y");
});