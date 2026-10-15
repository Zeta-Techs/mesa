import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { marked } from "marked";
// 显式声明运行前提：mathBlock 扩展注册进全局 marked（md-block-map 也会带上）
import "../src/md-math.ts";
import {
  mdBlocks,
  mdChildTagOf,
  mdLineForChild,
  type MdBlockInfo,
} from "../src/md-block-map.ts";
import { decorateMdCodeBlocks } from "../src/md-code-chrome.ts";
import { sanitizeDocumentHtml } from "../src/document-html.ts";

// sanitizeDocumentHtml 惰性取全局 window；给 node 测试补一个 JSDOM 实例
const dom = new JSDOM("<!doctype html><html><body></body></html>");
(globalThis as { window?: typeof dom.window }).window = dom.window;

/** 与 FilePreviewEditor 渲染同序的管线：parse → 清洗 → 上屏 → 代码装饰 */
function renderToHost(doc: string): HTMLElement {
  const html = sanitizeDocumentHtml(
    marked.parse(doc, { gfm: true, breaks: false, async: false }) as string,
  );
  const host = dom.window.document.createElement("div");
  host.innerHTML = html;
  decorateMdCodeBlocks(host);
  return host;
}

function childTagsOf(host: HTMLElement): string[] {
  return Array.from(host.children).map((c) =>
    mdChildTagOf(c.tagName, c.getAttribute("class") ?? ""),
  );
}

test("全链路：parse→清洗→代码装饰后，每个顶层块配对到正确起始行", () => {
  const doc = [
    "# 研究问题", // 1 h1
    "", // 2
    "这是一段引言。", // 3 p
    "", // 4
    "$$", // 5 块级公式
    "E=mc^2", // 6
    "$$", // 7
    "", // 8
    "- 项目一", // 9 ul
    "- 项目二", // 10
    "", // 11
    "> 引用块", // 12 blockquote
    "", // 13
    "```ts", // 14 代码围栏（装饰后顶层是 div.md-code）
    "const x = 1;", // 15
    "```", // 16
    "", // 17
    "| a | b |", // 18 table
    "|---|---|", // 19
    "| 1 | 2 |", // 20
    "", // 21
    "---", // 22 hr
    "", // 23
    "结尾段。", // 24 p
  ].join("\n");
  const host = renderToHost(doc);
  const tags = childTagsOf(host);
  const blocks = mdBlocks(doc);
  assert.deepEqual(tags, [
    "h1", "p", "math", "ul", "blockquote", "pre", "table", "hr", "p",
  ]);
  assert.deepEqual(
    tags.map((_, i) => mdLineForChild(blocks, tags, i)),
    [1, 3, 5, 9, 12, 14, 18, 22, 24],
  );
});

test("全链路：mermaid 围栏被换成 div.md-mermaid 后仍配对到围栏起始行", () => {
  const doc = "前言\n\n```mermaid\ngraph TD\nA-->B\n```\n\n后记";
  const host = renderToHost(doc);
  // 模拟 MermaidDiagrams.renderOne 的 pre.replaceWith(div.md-mermaid)
  const pre = host.querySelector("pre[data-md-mermaid]")!;
  const wrap = dom.window.document.createElement("div");
  wrap.className = "md-mermaid";
  pre.replaceWith(wrap);
  const tags = childTagsOf(host);
  const blocks = mdBlocks(doc);
  assert.deepEqual(
    tags.map((_, i) => mdLineForChild(blocks, tags, i)),
    [1, 3, 8],
  );
});

test("mdBlocks：$$ 块级公式按 math 记账（lexer 无参调用不丢全局扩展）", () => {
  const blocks = mdBlocks("$$\nE\n$$\n\n正文");
  assert.equal(blocks[0].tag, "math");
  assert.equal(blocks.find((b) => b.tag === "p")?.line, 5);
});

test("mdBlocks：\\r\\n 归一后行号不漂", () => {
  const ps = mdBlocks("# a\r\n\r\n段落一\r\n\r\n段落二\r\n").filter(
    (b) => b.tag === "p",
  );
  assert.deepEqual(ps.map((b) => b.line), [3, 5]);
});

test("mdBlocks：重复链接定义被 Lexer 吞掉时 indexOf 重同步", () => {
  const doc = "[foo]: /url\n[foo]: /url\n\n正文段";
  assert.equal(mdBlocks(doc).find((b) => b.tag === "p")?.line, 4);
});

test("mdLineForChild：清洗剥掉一枚顶层块时向后自愈", () => {
  const blocks: MdBlockInfo[] = [
    { line: 1, tag: "h1" },
    { line: 3, tag: "p" },
    { line: 9, tag: "ul" },
  ];
  // DOM 里 h1 被剥（危险 html 整块清洗），只剩 p、ul
  assert.equal(mdLineForChild(blocks, ["p", "ul"], 0), 3);
  assert.equal(mdLineForChild(blocks, ["p", "ul"], 1), 9);
});

test("mdLineForChild：对不齐与越界返回 null（回落纯切编辑态）", () => {
  const blocks: MdBlockInfo[] = [
    { line: 1, tag: "h1" },
    { line: 3, tag: "ul" },
  ];
  assert.equal(mdLineForChild(blocks, ["p"], 0), null);
  assert.equal(mdLineForChild(blocks, ["h1"], 1), null);
  assert.equal(mdLineForChild(blocks, ["h1"], -1), null);
});

test("mdLineForChild：raw html（*）吃任意标签", () => {
  const blocks: MdBlockInfo[] = [
    { line: 2, tag: "*" },
    { line: 5, tag: "p" },
  ];
  assert.equal(mdLineForChild(blocks, ["div", "p"], 0), 2);
  assert.equal(mdLineForChild(blocks, ["div", "p"], 1), 5);
});

test("mdLineForChild：html 块零产出（注释被清洗剥掉）时让位给下一枚真实 token", () => {
  const blocks: MdBlockInfo[] = [
    { line: 1, tag: "*" },
    { line: 3, tag: "p" },
  ];
  assert.equal(mdLineForChild(blocks, ["p"], 0), 3);
});

test("全链路：html 注释块被清洗剥掉，双击正文仍定位到正文行", () => {
  const doc = "<!-- 注释 -->\n\n正文段";
  const host = renderToHost(doc);
  const tags = childTagsOf(host);
  assert.deepEqual(tags, ["p"]);
  assert.equal(mdLineForChild(mdBlocks(doc), tags, 0), 3);
});

test("mdBlocks：单独 \\r 换行归一后行号不漂", () => {
  const ps = mdBlocks("一\r二\r\r三\r").filter((b) => b.tag === "p");
  assert.deepEqual(ps.map((b) => b.line), [1, 4]);
});

test("mdChildTagOf：装饰链改写的顶层节点归一", () => {
  assert.equal(mdChildTagOf("DIV", "md-code"), "pre");
  assert.equal(mdChildTagOf("DIV", "md-mermaid"), "pre");
  assert.equal(mdChildTagOf("DIV", "md-math md-math-display"), "math");
  assert.equal(mdChildTagOf("DIV", ""), "div");
  assert.equal(mdChildTagOf("PRE", ""), "pre");
  assert.equal(mdChildTagOf("UL", "contains-task-list"), "ul");
  assert.equal(mdChildTagOf("H2", ""), "h2");
});

test("mdChildTagOf：class 撞名不误判（md-codebook 不是 md-code）", () => {
  assert.equal(mdChildTagOf("DIV", "md-codebook"), "div");
});
