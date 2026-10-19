import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmChoices,
  mentionedProjectFiles,
  REPLY_FOLD_MIN_CHARS,
  splitReplySections,
} from "../src/chat-reply.ts";

/** 把正文垫到可折长度：分节只给长回复 */
const pad = (text: string) => `${text}\n\n${"补充说明。".repeat(Math.ceil(REPLY_FOLD_MIN_CHARS / 5))}`;

test("两个以上小标题才折叠", () => {
  const sections = splitReplySections(pad("开头\n\n验收摘要：\n565 条\n\n尚未验证：\n7 篇"));
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
  const sections = splitReplySections(pad(text));
  // 只有「配置如下：」「部署步骤：」两个真标题；YAML 键行必须留在正文里
  assert.equal(sections?.length, 2);
  assert.equal(sections?.[0]?.title, "配置如下：");
  assert.ok(sections?.[0]?.body.includes("server:"));
  assert.ok(sections?.[0]?.body.includes("```yaml"));
  assert.ok(!sections?.some((s) => s.title === "db:" || s.title === "server:"));
});

test("短回答不分节；句子里的冒号引子、列表项、加粗开头都不当小标题", () => {
  // 2026-10-17 用户截图：解释 API 的回答被折成一串空标题
  const api = [
    "# API 是什么？",
    "想象你去餐厅吃饭：",
    "- 你（顾客）想吃饭",
    "## 生活中的例子",
    "你手机上的天气 App 并不是自己测天气的。它做的事是：",
    "1. 向气象服务发请求",
  ].join("\n");
  assert.equal(splitReplySections(api), null);
  const long = splitReplySections(pad(api));
  const titles = long?.map((s) => s.title) ?? [];
  assert.ok(titles.includes("API 是什么？"));
  assert.ok(titles.includes("生活中的例子"));
  assert.ok(!titles.some((t) => t.includes("它做的事是")), "带句号的长句不是标题");
  assert.ok(!titles.some((t) => t.startsWith("-") || t.startsWith("1.")));
});

test("已经用 ## 分节的回复里，冒号句是引出下文的话，不当小标题", () => {
  // 2026-10-19 用户实测排版题：「标注语言的代码块示例如下：」被折成一节，代码块和引用收进去
  const reply = [
    "## 二、列表与代码",
    "正文一段。",
    "标注语言的代码块示例如下：",
    "",
    "```python",
    "# 注释",
    "def render(src):",
    "```",
    "引用一句：",
    "> 格式是为内容服务的",
    "## 三、公式与图片",
    "正文。",
  ].join("\n");
  const titles = splitReplySections(pad(reply))?.map((s) => s.title) ?? [];
  assert.deepEqual(titles, ["二、列表与代码", "三、公式与图片"]);
  // 没有 ## 标题的报告体（「验收摘要：」「尚未验证：」）仍按冒号行分节——见「两个以上小标题才折叠」
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