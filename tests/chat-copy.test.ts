import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  nodePlainText,
  rangeCopyHtml,
  rangePlainText,
  rangeSoleFormula,
  rangeTable,
  tableToTsv,
} from "../src/chat-copy.ts";

/** 排版后的公式：data-tex 记源码，里面是 KaTeX 的 MathML + HTML 两份（直接取文字会出两遍） */
const KATEX_X2 =
  '<span class="md-math" data-tex="x^2"><span class="katex"><span class="katex-mathml"><math><semantics><mrow><msup><mi>x</mi><mn>2</mn></msup></mrow><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">x2</span></span></span>';

function body(html: string) {
  const dom = new JSDOM(`<div id="root">${html}</div>`);
  return { doc: dom.window.document, root: dom.window.document.getElementById("root")! };
}

test("纯文本：去掉 Markdown 符号、列表写成 • 与编号、段落空一行", () => {
  const { root } = body(
    "<h2>标题</h2>\n<p>一段 <strong>粗体</strong> 和 <code>code</code>。</p>\n<ul>\n<li>甲</li>\n<li><p>乙</p></li>\n</ul>\n<ol start=\"3\">\n<li>丙</li>\n<li>丁</li>\n</ol>",
  );
  assert.equal(nodePlainText(root), "标题\n\n一段 粗体 和 code。\n\n• 甲\n• 乙\n\n3. 丙\n4. 丁");
});

test("纯文本：公式还原成 $TeX$，代码块保留缩进且不带头栏字，按钮与图标不带", () => {
  const { root } = body(
    `<p>面积 ${KATEX_X2} 平方米<br>第二行</p>` +
      '<div class="md-math md-math-display" data-tex="E=mc^2"><span class="katex">E=mc2</span></div>' +
      '<div class="md-code"><div class="md-code-bar"><span>py</span><button>复制</button></div><pre><code>def f():\n    return 1</code></pre></div>' +
      '<div data-copy-skip=""><button>引用追问</button></div>',
  );
  assert.equal(nodePlainText(root), "面积 $x^2$ 平方米\n第二行\n\n$$E=mc^2$$\n\ndef f():\n    return 1");
});

test("没排版的公式占位：从 $..$ 原文取源码", () => {
  const { root } = body('<p><span class="md-math">$a+b$</span></p>');
  assert.equal(nodePlainText(root), "$a+b$");
});

test("表格：制表符分列，格里的换行收成空格，公式写源码", () => {
  const { root } = body(
    `<div class="md-table-wrap"><table><thead><tr><th>量</th><th>值</th></tr></thead><tbody><tr><td>面积<br>（估）</td><td>${KATEX_X2}</td></tr><tr><td>b</td><td>2</td></tr></tbody></table></div>`,
  );
  const table = root.querySelector("table")!;
  assert.equal(tableToTsv(table), "量\t值\n面积 （估）\t$x^2$\nb\t2");
  assert.equal(nodePlainText(root), "量\t值\n面积 （估）\t$x^2$\nb\t2");
});

test("选区：一头落在公式中间时扩到整条公式；只选中公式时给 LaTeX", () => {
  const { doc, root } = body(`<p>面积 ${KATEX_X2} 平方米</p>`);
  const html = root.querySelector(".katex-html")!.firstChild!;
  const range = doc.createRange();
  range.setStart(root.querySelector("p")!.firstChild!, 0);
  range.setEnd(html, 1);
  assert.equal(rangePlainText(range), "面积 $x^2$");
  assert.equal(rangeSoleFormula(range), null);

  const sole = doc.createRange();
  sole.selectNode(root.querySelector(".md-math")!);
  assert.equal(rangeSoleFormula(sole), "x^2");
  assert.equal(rangePlainText(sole), "$x^2$");
});

test("选区：落在代码块里面保留原样换行与缩进", () => {
  const { doc, root } = body("<pre><code>a = 1\n    b = 2\nc = 3</code></pre>");
  const text = root.querySelector("code")!.firstChild!;
  const range = doc.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 16);
  assert.equal(rangePlainText(range), "a = 1\n    b = 2");
});

test("选区：框住表里几格也按列分；碰到表格就能整表复制", () => {
  const { doc, root } = body(
    "<p>前文</p><table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>",
  );
  const cells = root.querySelectorAll("td");
  const range = doc.createRange();
  range.setStart(cells[0].firstChild!, 0);
  range.setEnd(cells[3].firstChild!, 1);
  assert.equal(rangePlainText(range), "a\tb\nc\td");
  assert.equal(rangeTable(range, root), root.querySelector("table"));

  const before = doc.createRange();
  before.selectNodeContents(root.querySelector("p")!);
  assert.equal(rangeTable(before, root), null);
});

test("富文本那份：去掉类名、界面元素，公式换成 $TeX$ 文字", () => {
  const { doc, root } = body(`<p class="x">面积 ${KATEX_X2}<button>复制</button></p>`);
  const range = doc.createRange();
  range.selectNodeContents(root);
  assert.equal(rangeCopyHtml(range), "<p>面积 $x^2$</p>");
});
