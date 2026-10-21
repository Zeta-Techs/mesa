import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { highlightCodeBlocks, highlightLanguage } from "../src/code-highlight.ts";

test("围栏语言名 → 认的语言；别名归一，不认识的不猜", () => {
  assert.equal(highlightLanguage("py"), "python");
  assert.equal(highlightLanguage("Python"), "python");
  assert.equal(highlightLanguage("tsx"), "typescript");
  assert.equal(highlightLanguage("sh"), "bash");
  assert.equal(highlightLanguage("tex"), "latex");
  assert.equal(highlightLanguage("R"), "r");
  assert.equal(highlightLanguage(""), null);
  assert.equal(highlightLanguage("brainfuck"), null);
});

test("只给写明语言的代码块上色；文字不变、只上一次；mermaid 与没写语言的原样", async () => {
  const dom = new JSDOM(`<div>
    <pre><code class="language-python">def f(x):\n    return x + 1  # 加一</code></pre>
    <pre><code>plain &lt;b&gt;</code></pre>
    <pre><code class="language-mermaid">graph TD; A-->B;</code></pre>
  </div>`);
  const host = dom.window.document.querySelector("div")!;
  const [py, plain, mermaid] = Array.from(host.querySelectorAll("code"));
  const before = py.textContent;
  await highlightCodeBlocks(host);
  assert.equal(py.dataset.hl, "1");
  assert.ok(py.querySelector(".hljs-keyword"), py.innerHTML);
  assert.ok(py.querySelector(".hljs-comment"));
  assert.equal(py.textContent, before);
  assert.equal(plain.innerHTML, "plain &lt;b&gt;");
  assert.equal(mermaid.dataset.hl, undefined);
  const html = py.innerHTML;
  await highlightCodeBlocks(host);
  assert.equal(py.innerHTML, html);
});
