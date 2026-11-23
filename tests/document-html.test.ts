import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { marked } from "marked";
import { createDocumentSanitizer } from "../src/document-html.ts";
import { rewriteMdImageHtml } from "../src/reader.ts";
import "../src/md-math.ts";

const dom = new JSDOM("");
const sanitize = createDocumentSanitizer(dom.window);
function parse(html: string) {
  const host = dom.window.document.createElement("div");
  host.innerHTML = sanitize(html);
  return host;
}

test("文档 HTML：移除事件、活动内容、样式及伪造工作台覆盖层", () => {
  const host = parse(`<svg onload="alert(1)"></svg><math><mtext>x</mtext></math>
    <iframe srcdoc="x"></iframe><script>alert(1)</script><style>body{display:none}</style>
    <form action="https://example.com"><button>提交</button></form>
    <div class="fixed inset-0 z-50 md-math" style="position:fixed" onclick="alert(1)">$x$</div>
    <img src="data:image/png;base64,broken" onerror="alert(1)">`);
  assert.equal(host.querySelector("script,svg,math,iframe,form,button,style,[style],[onclick],[onerror]"), null);
  assert.equal(host.querySelector("div")?.className, "md-math");
  assert.ok(host.querySelector("img")?.getAttribute("src")?.startsWith("data:image/png"));
});

test("文档链接：拦截混淆脚本协议和图片占位中的危险协议", () => {
  for (const url of ["javascript:alert(1)", "java&#x09;script:alert(1)", "vbscript:msgbox(1)", "data:text/html,evil"]) {
    const host = parse(`<a href="${url}">链接</a><span data-md-src="${url}">图片</span>`);
    assert.equal(host.querySelector("a")?.hasAttribute("href"), false, url);
    assert.equal(host.querySelector("span")?.hasAttribute("data-md-src"), false, url);
  }
  const safe = parse(
    '<a href="https://example.com/paper">论文</a><a href="#note">脚注</a><a href="../notes/a.md">笔记</a>' +
      '<a href="file:///Users/u/硼化物析氢/notes/38.md#L10-L20">精读</a>',
  );
  assert.equal(safe.querySelectorAll("a[href]").length, 4);
  assert.equal(
    safe.querySelectorAll("a[href]")[3]?.getAttribute("href"),
    "file:///Users/u/硼化物析氢/notes/38.md#L10-L20",
  );
});

test("Markdown：表格、代码、公式、任务复选框和本地图占位保留", () => {
  const html = marked.parse("# 笔记\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n- [x] 已读\n\n```ts\nconst a = 1;\n```\n\n$x^2$\n\n![图](images/a.png)", { async: false });
  const host = parse(rewriteMdImageHtml(html));
  assert.equal(host.querySelector("h1")?.textContent, "笔记");
  assert.ok(host.querySelector("table td"));
  assert.ok(host.querySelector("code.language-ts"));
  assert.equal(host.querySelector(".md-math")?.textContent, "$x^2$");
  assert.ok(host.querySelector('input[type="checkbox"][checked][disabled]'));
  assert.equal(host.querySelector("[data-md-src]")?.getAttribute("data-md-src"), "images/a.png");
});

test("DOCX 转换 HTML：脚注、内嵌图片、基本排版保留，危险链接剥离", () => {
  const host = parse('<p><strong>正文</strong><sup><a href="#footnote-1" id="footnote-ref-1">1</a></sup></p><p id="footnote-1">脚注</p><img src="data:image/png;base64,AAAA"><a href="javascript:alert(1)">危险</a>');
  assert.ok(host.querySelector("strong"));
  assert.ok(host.querySelector("#footnote-1"));
  assert.equal(host.querySelectorAll("a[href]").length, 1);
  assert.ok(host.querySelector("img[src]"));
});

test("畸形命名空间和 DOM clobbering 不产生可执行属性", () => {
  const host = parse('<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>"><form id="attributes"><input name="__proto__"></form>');
  assert.equal(host.querySelector("script,style,math,svg,form,[onerror],[name]"), null);
});

test("图片重写后再清洗：data 图片不能借 onerror 绕过", () => {
  const html = rewriteMdImageHtml(marked.parse('<img src="data:image/png;base64,broken" onerror="alert(1)">', { async: false }));
  const host = parse(html);
  assert.ok(host.querySelector("img[src]"));
  assert.equal(host.querySelector("[onerror]"), null);
});

test("DOM 环境中的生产清洗入口与注入实例使用同一策略", async () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  try {
    const { sanitizeDocumentHtml } = await import("../src/document-html.ts");
    assert.equal(sanitizeDocumentHtml('<p onclick="x()">正常内容</p>'), "<p>正常内容</p>");
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
