import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { findQuoteRange, setReviewHighlight } from "../src/review-marks.ts";

/** findQuoteRange 读全局 document / NodeFilter（同 chat-inline-refs.test.ts 的 JSDOM 口径） */
function hostOf(html: string): HTMLElement {
  const dom = new JSDOM(`<div id="host">${html}</div>`, { url: "http://localhost/" });
  Object.assign(globalThis, {
    document: dom.window.document,
    NodeFilter: dom.window.NodeFilter,
  });
  return dom.window.document.getElementById("host")!;
}

test("同段落引文：命中的 Range 能还原出那段文字", () => {
  const host = hostOf("<p>甲乙丙丁 戊己</p><p>另一段</p>");
  const range = findQuoteRange(host, "丙丁 戊");
  assert.ok(range);
  assert.equal(range!.toString(), "丙丁 戊");
  assert.equal(range!.startContainer, host.querySelector("p")!.firstChild);
  assert.equal(range!.endContainer, host.querySelector("p")!.firstChild);
});

test("跨段落、段内连续空白都折成一个空格：划选拼出的引文能找到", () => {
  const host = hostOf("<p>第一段 结尾</p><li>第二段  开头</li><p>别的</p>");
  const range = findQuoteRange(host, "结尾 第二段 开头");
  assert.ok(range);
  // Range.toString() 不插块间空格、不折叠空白：按折叠前的原文核对起止
  assert.equal(range!.startContainer.parentElement, host.querySelector("p"));
  assert.equal(range!.endContainer.parentElement, host.querySelector("li"));
  assert.equal(range!.toString().replace(/\s+/g, ""), "结尾第二段开头");
  const host2 = hostOf("<p>甲\n乙</p>");
  assert.ok(findQuoteRange(host2, "甲 乙"), "换行折成空格后也能命中");
});

test("找不到（正文没有、空引文、只有空白）返回 null；重复的句子取第一处", () => {
  const host = hostOf("<p>同一句</p><p>同一句</p><p>无关</p>");
  assert.equal(findQuoteRange(host, "正文里没有"), null);
  assert.equal(findQuoteRange(host, "   "), null);
  assert.equal(findQuoteRange(host, ""), null);
  const range = findQuoteRange(host, "同一句")!;
  assert.equal(range.startContainer.parentElement, host.children[0], "取第一处");
  assert.equal(range.toString(), "同一句");
});

test("长选段收成「开头…结尾」时按首尾标出整段，结尾取开头之后最近的一处", () => {
  const host = hostOf("<p>甲乙丙丁戊己庚辛</p><p>戊己再出现</p>");
  const range = findQuoteRange(host, "甲乙…戊己");
  assert.ok(range);
  assert.equal(range!.toString(), "甲乙丙丁戊己");
  assert.equal(findQuoteRange(host, "没有…戊己"), null, "开头找不到");
  assert.equal(findQuoteRange(host, "庚辛…甲乙"), null, "结尾在开头之前不算");
  assert.equal(findQuoteRange(host, "…戊己"), null, "缺开头不猜");
});

test("代码块头栏（.md-code-bar）与 KaTeX 隐藏 MathML（.katex-mathml）不混进引文反查", () => {
  const host = hostOf(
    '<p>前文</p><div class="md-code"><div class="md-code-bar"><span>python</span><button>复制</button></div><pre><code>x = 1</code></pre></div><p>公式 <span class="katex"><span class="katex-mathml">E=mc^2</span><span class="katex-html">E=mc2</span></span> 后文</p>',
  );
  const codeSpan = findQuoteRange(host, "前文 x = 1")!;
  assert.ok(codeSpan, "跳过 python 复制 头栏命中代码块");
  const mathSpan = findQuoteRange(host, "公式 E=mc2 后文")!;
  assert.ok(mathSpan, "跳过重复的 katex-mathml 命中可见公式");
});

test("多实例高亮登记：放大弹层卸载不会清掉主评审栏的 review-done 高亮", () => {
  const host = hostOf("<p>第一处</p><p>第二处</p>");
  const r1 = findQuoteRange(host, "第一处")!;
  const r2 = findQuoteRange(host, "第二处")!;
  const registry = new Map<string, { ranges: Range[] }>();
  class FakeHighlight {
    ranges: Range[];
    constructor(...ranges: Range[]) {
      this.ranges = ranges;
    }
  }
  const prevCss = (globalThis as { CSS?: unknown }).CSS;
  const prevHighlight = (globalThis as { Highlight?: unknown }).Highlight;
  const ownerA = Symbol("main");
  const ownerB = Symbol("modal");
  Object.assign(globalThis, {
    CSS: { highlights: registry },
    Highlight: FakeHighlight,
  });
  try {
    setReviewHighlight("review-done", ownerA, [r1]);
    setReviewHighlight("review-done", ownerB, [r2]);
    assert.equal(registry.get("review-done")?.ranges.length, 2);

    setReviewHighlight("review-done", ownerB, []);
    assert.deepEqual(registry.get("review-done")?.ranges, [r1]);

    setReviewHighlight("review-done", ownerA, []);
    assert.equal(registry.has("review-done"), false);
  } finally {
    setReviewHighlight("review-done", ownerA, []);
    setReviewHighlight("review-done", ownerB, []);
    if (prevCss === undefined) Reflect.deleteProperty(globalThis, "CSS");
    else Object.assign(globalThis, { CSS: prevCss });
    if (prevHighlight === undefined) Reflect.deleteProperty(globalThis, "Highlight");
    else Object.assign(globalThis, { Highlight: prevHighlight });
  }
});
