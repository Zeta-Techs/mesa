import assert from "node:assert/strict";
import test from "node:test";
import {
  HTML_IFRAME_SANDBOX,
  htmlLocalImageSrcs,
  htmlLocalScriptSrcs,
  htmlStylesheetHrefs,
  isLocalStylesheetHref,
  replaceHtmlImageSrc,
  replaceLocalScripts,
  replaceStylesheetLinks,
  wrapHtmlDocument,
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
  assert.match(wrapHtmlDocument("<p>hi</p>"), /<!DOCTYPE html>/i);
  assert.equal(wrapHtmlDocument("<!DOCTYPE html><html></html>"), "<!DOCTYPE html><html></html>");
});

test("沙箱不含 same-origin 与 top-navigation", () => {
  assert.match(HTML_IFRAME_SANDBOX, /allow-scripts/);
  assert.doesNotMatch(HTML_IFRAME_SANDBOX, /same-origin/);
  assert.doesNotMatch(HTML_IFRAME_SANDBOX, /top-navigation/);
});

test("沙箱不给 allow-modals：脚本能跑后死循环 alert 会卡住窗口", () => {
  assert.doesNotMatch(HTML_IFRAME_SANDBOX, /modals/);
});

test("本地外置脚本收集与内联，外链与内联脚本跳过", () => {
  const html =
    `<script src="./app.js"></script><script type="module" src='lib/m.js'></script>` +
    `<script src="https://cdn.ex.com/d3.js"></script><script>tick()</script>`;
  assert.deepEqual(htmlLocalScriptSrcs(html), ["./app.js", "lib/m.js"]);
  const out = replaceLocalScripts(html, { "./app.js": "go('</script>')", "lib/m.js": "export {}" });
  assert.match(out, /<script>go\('<\\\/script>'\)<\/script>/);
  assert.match(out, /<script type="module">export \{\}<\/script>/);
  assert.match(out, /<script src="https:\/\/cdn\.ex\.com\/d3\.js"><\/script>/);
  assert.match(out, /<script>tick\(\)<\/script>/);
});

test("读不到的本地脚本保留原标签", () => {
  const html = `<script src="miss.js"></script>`;
  assert.equal(replaceLocalScripts(html, {}), html);
});
