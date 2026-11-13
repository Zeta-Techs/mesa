import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { findQuoteRange } from "../src/review-marks.ts";

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
