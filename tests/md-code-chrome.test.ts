import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  decorateMdCodeBlocks,
  decorateMdTables,
  isMermaidLanguage,
  isNumericCell,
  languageFromCodeClass,
} from "../src/md-code-chrome.ts";

test("languageFromCodeClass 抽出 language- 后缀", () => {
  assert.equal(languageFromCodeClass("language-ts"), "ts");
  assert.equal(languageFromCodeClass("foo language-c++ bar"), "c++");
  assert.equal(languageFromCodeClass(""), "");
});

test("isMermaidLanguage 大小写不敏感", () => {
  assert.equal(isMermaidLanguage("mermaid"), true);
  assert.equal(isMermaidLanguage("Mermaid"), true);
  assert.equal(isMermaidLanguage("ts"), false);
});

test("decorateMdCodeBlocks 给普通围栏套头栏，mermaid 只打标", () => {
  const dom = new JSDOM(
    `<div>
      <pre><code class="language-ts">const a = 1;</code></pre>
      <pre><code class="language-mermaid">graph TD; A-->B;</code></pre>
    </div>`,
  );
  const host = dom.window.document.querySelector("div")!;
  decorateMdCodeBlocks(host);
  assert.equal(host.querySelectorAll("[data-md-code]").length, 1);
  assert.equal(host.querySelector(".md-code-lang")?.textContent, "ts");
  assert.equal(host.querySelector("[data-md-mermaid]")?.tagName, "PRE");
  decorateMdCodeBlocks(host);
  assert.equal(host.querySelectorAll("[data-md-code]").length, 1);
});

test("复制钮是图标 + 字，不再用字符画 ⧉", () => {
  const dom = new JSDOM(`<div><pre><code class="language-py">x = 1</code></pre></div>`);
  const host = dom.window.document.querySelector("div")!;
  decorateMdCodeBlocks(host);
  const btn = host.querySelector(".md-code-copy")!;
  assert.ok(btn.querySelector("svg"));
  assert.equal(btn.querySelector(".md-code-copy-label")?.textContent, "复制");
  assert.ok(!btn.textContent?.includes("⧉"));
});

test("数字单元格：小数、百分比、千分位、科学计数、± 误差、< 0.05 都算；单位、文字不算", () => {
  for (const yes of ["12", "-3.5", "45%", "1,234,567", "6.02e23", "0.82 ± 0.03", "< 0.05", "−2"]) {
    assert.ok(isNumericCell(yes), yes);
  }
  for (const no of ["", "n/a", "12 kg", "Smith", "2020a", "—"]) assert.ok(!isNumericCell(no), no);
});

test("decorateMdTables：套横滚壳、整列数字的列右对齐，表头跟着；只包一次", () => {
  const dom = new JSDOM(`<div><table>
    <thead><tr><th>模型</th><th>准确率</th><th>备注</th></tr></thead>
    <tbody>
      <tr><td>A</td><td>0.91</td><td>基线</td></tr>
      <tr><td>B</td><td>0.88 ± 0.02</td><td></td></tr>
    </tbody></table></div>`);
  const host = dom.window.document.querySelector("div")!;
  decorateMdTables(host);
  decorateMdTables(host);
  assert.equal(host.querySelectorAll(".md-table-wrap").length, 1);
  assert.equal(host.querySelector(".md-table-wrap > table")?.tagName, "TABLE");
  const numCells = Array.from(host.querySelectorAll(".md-num")).map((c) => c.textContent);
  assert.deepEqual(numCells, ["准确率", "0.91", "0.88 ± 0.02"]);
});
