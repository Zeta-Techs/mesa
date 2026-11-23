import assert from "node:assert/strict";
import test from "node:test";
import {
  completeStreamingMarkdown,
  splitStreamingMarkdownBlocks,
  unsyncedMarkdownTail,
} from "../src/live-markdown.ts";

test("splitStreamingMarkdownBlocks：按空行拆成顶层块，不拆围栏代码与块级公式", () => {
  const md = [
    "## 结论",
    "",
    "第一段内容。",
    "",
    "```python",
    "def f(x):",
    "",
    "    return x + 1",
    "```",
    "",
    "$$",
    "E = mc^2",
    "",
    "a + b = c",
    "$$",
    "",
    "末尾段",
  ].join("\n");

  const blocks = splitStreamingMarkdownBlocks(md);
  assert.deepEqual(blocks, [
    "## 结论",
    "第一段内容。",
    "```python\ndef f(x):\n\n    return x + 1\n```",
    "$$\nE = mc^2\n\na + b = c\n$$",
    "末尾段",
  ]);
});

test("splitStreamingMarkdownBlocks：流式追加末尾块时，已完成块字符串保持完全不变", () => {
  const step1 = splitStreamingMarkdownBlocks("## 标题\n\n第一段\n\n第二段前");
  const step2 = splitStreamingMarkdownBlocks("## 标题\n\n第一段\n\n第二段前半句接着写");
  assert.equal(step1[0], step2[0]);
  assert.equal(step1[1], step2[1]);
  assert.notEqual(step1[2], step2[2]);
});

test("completeStreamingMarkdown：未闭合围栏代码自动闭合，且剥掉末尾半截闭合反引号", () => {
  assert.equal(
    completeStreamingMarkdown("```ts\nconst x = 1;"),
    "```ts\nconst x = 1;\n```",
  );
  assert.equal(
    completeStreamingMarkdown("```ts\nconst x = 1;\n``"),
    "```ts\nconst x = 1;\n```",
  );
  // 围栏代码内部不触碰 ** 或 `
  assert.equal(
    completeStreamingMarkdown("```py\n# **not bold"),
    "```py\n# **not bold\n```",
  );
  // 已闭合围栏保持原样
  assert.equal(
    completeStreamingMarkdown("```ts\nconst x = 1;\n```"),
    "```ts\nconst x = 1;\n```",
  );
});

test("completeStreamingMarkdown：行内粗体 / 删除线 / 斜体 / 行内代码自动闭合，下划线标识符不误变斜体", () => {
  assert.equal(completeStreamingMarkdown("这是 **重点内容"), "这是 **重点内容**");
  assert.equal(completeStreamingMarkdown("这是 **重点内容*"), "这是 **重点内容**");
  assert.equal(completeStreamingMarkdown("这是 ~~删除内容"), "这是 ~~删除内容~~");
  assert.equal(completeStreamingMarkdown("这是 ~~删除内容~"), "这是 ~~删除内容~~");
  assert.equal(completeStreamingMarkdown("这是 *强调"), "这是 *强调*");
  assert.equal(completeStreamingMarkdown("调用 `npm run test"), "调用 `npm run test`");
  // 裸起手符暂不闪出来
  assert.equal(completeStreamingMarkdown("这是 **"), "这是 ");
  assert.equal(completeStreamingMarkdown("调用 `"), "调用 ");
  assert.equal(completeStreamingMarkdown("## "), "");
  // 列表项 `* ` 不当斜体起手
  assert.equal(completeStreamingMarkdown("* 第一条内容"), "* 第一条内容");
  // 下划线标识符不补闭合，避免 snake_case 闪烁
  assert.equal(completeStreamingMarkdown("变量 foo_bar_"), "变量 foo_bar_");
  // 水平分割线 *** 不被改坏，行尾裸 *** 先收掉
  assert.equal(completeStreamingMarkdown("***"), "***");
  assert.equal(completeStreamingMarkdown("这是 ***"), "这是 ");
  // 货币 $100 不触发公式态，同行后面的 ** 仍正常补齐
  assert.equal(completeStreamingMarkdown("预算 $100 左右，**重点内容"), "预算 $100 左右，**重点内容**");
});

test("completeStreamingMarkdown：末尾未闭合链接与图片不露出半截 URL，行内代码内不误改", () => {
  assert.equal(completeStreamingMarkdown("见 [设计文档](https://exam"), "见 设计文档");
  assert.equal(completeStreamingMarkdown("图 ![结果图](./fig/a"), "图 结果图");
  assert.equal(completeStreamingMarkdown("示例 `[a](b` 保留"), "示例 `[a](b` 保留");
});

test("unsyncedMarkdownTail：未落盘时保留开头裸围栏；部分落盘时连带保留紧挨未落盘正文前的围栏起手行", () => {
  const codeOnly = ["```", "const a = 1;", "```"];
  assert.deepEqual(unsyncedMarkdownTail(codeOnly, ""), codeOnly);

  const mixed = [
    "这是一段已经落盘到会话文件里的说明正文。",
    "",
    "```",
    "console.log('streaming');",
  ];
  assert.deepEqual(
    unsyncedMarkdownTail(mixed, "这是一段已经落盘到会话文件里的说明正文。"),
    ["```", "console.log('streaming');"],
  );
});
