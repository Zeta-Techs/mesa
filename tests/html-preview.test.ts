import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createHtmlPreviewSanitizer } from "../src/document-html.ts";
import {
  HTML_IFRAME_SANDBOX,
  htmlLocalImageSrcs,
  htmlStylesheetHrefs,
  isLocalStylesheetHref,
  replaceHtmlImageSrc,
  replaceStylesheetLinks,
  wrapHtmlSrcdoc,
} from "../src/html-preview.ts";

test("抽出 stylesheet href，跳过 icon", () => {
  const html = `<link rel="stylesheet" href="./a.css"><link rel="icon" href="x.png">`;
  assert.deepEqual(htmlStylesheetHrefs(html), ["./a.css"]);
});

test("replaceStylesheetLinks 内联已读到的 CSS，丢掉读不到的", () => {
  const html = `<link rel="stylesheet" href="a.css"><link rel="stylesheet" href="miss.css">`;
  const out = replaceStylesheetLinks(html, { "a.css": "body{color:red}" });
  assert.match(out, /<style>body\{color:red\}<\/style>/);
  assert.doesNotMatch(out, /miss\.css/);
});

test("本地图 src 收集与替换，http 跳过", () => {
  const html = `<img src="./p.png"><img src="https://ex.com/a.png">`;
  assert.deepEqual(htmlLocalImageSrcs(html), ["./p.png"]);
  const next = replaceHtmlImageSrc(html, "./p.png", "data:image/png;base64,AA");
  assert.match(next, /data:image\/png;base64,AA/);
});

test("isLocalStylesheetHref 拒外链", () => {
  assert.equal(isLocalStylesheetHref("./a.css"), true);
  assert.equal(isLocalStylesheetHref("https://ex.com/a.css"), false);
});

test("不完整文档包一层 html 骨架", () => {
  assert.match(wrapHtmlSrcdoc("<p>hi</p>"), /<!DOCTYPE html>/i);
  assert.equal(wrapHtmlSrcdoc("<!DOCTYPE html><html></html>"), "<!DOCTYPE html><html></html>");
});

test("沙箱不含 same-origin 与 top-navigation", () => {
  assert.match(HTML_IFRAME_SANDBOX, /allow-scripts/);
  assert.doesNotMatch(HTML_IFRAME_SANDBOX, /same-origin/);
  assert.doesNotMatch(HTML_IFRAME_SANDBOX, /top-navigation/);
});

test("HTML 预览消毒剥脚本保留 style", () => {
  const dom = new JSDOM("");
  const sanitize = createHtmlPreviewSanitizer(dom.window);
  const out = sanitize(
    `<!DOCTYPE html><html><head><style>p{color:red}</style><script>alert(1)</script></head><body><p onclick="x()">ok</p><iframe></iframe></body></html>`,
  );
  assert.match(out, /<style>/i);
  assert.doesNotMatch(out, /script/i);
  assert.doesNotMatch(out, /iframe/i);
  assert.doesNotMatch(out, /onclick/i);
  assert.match(out, />ok</);
});

test("HTML 预览消毒保留报告要用的内联 style、内嵌 SVG 与 MathML，仍剥脚本与事件", () => {
  const dom = new JSDOM("");
  const sanitize = createHtmlPreviewSanitizer(dom.window);
  const out = sanitize(
    `<!DOCTYPE html><html><head><title>报告</title></head><body>` +
      `<div style="color:red">红字</div>` +
      `<svg width="10" height="10" onload="x()"><rect width="5" height="5" fill="blue"/><script>alert(1)</script></svg>` +
      `<math><mi>x</mi></math>` +
      `<a href="javascript:alert(1)">坏链</a><form><input></form></body></html>`,
  );
  assert.match(out, /style="color:red"/);
  assert.match(out, /<svg[^>]*>/);
  assert.match(out, /<rect/);
  assert.match(out, /<math>/);
  assert.doesNotMatch(out, /script|onload|javascript:|<form|<input/i);
});
