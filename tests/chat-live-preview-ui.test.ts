import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

async function loadBundle() {
  const bundle = await build({
    stdin: {
      contents: `
        export { createElement, act } from 'react';
        export { createRoot } from 'react-dom/client';
        export { StreamingMarkdown, LiveScreenPreview } from './src/components/ChatLivePreview';
      `,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    loader: { ".css": "empty" },
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    jsx: "automatic",
    external: ["react", "react-dom/client", "react/jsx-runtime"],
    plugins: [
      {
        name: "stub-tauri",
        setup(b) {
          b.onResolve({ filter: /^@tauri-apps\// }, (args) => ({
            path: args.path,
            namespace: "stub",
          }));
          b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
            loader: "js",
            contents: `export async function invoke() { return null; } export function convertFileSrc(s) { return s; } export async function openPath() {} export async function openUrl() {}`,
          }));
        },
      },
    ],
  });
  const req = createRequire(import.meta.url);
  const mod = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(req, mod, mod.exports);
  return mod.exports;
}

function setupDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "http://localhost/",
  });
  const g = globalThis as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  for (const key of ["window", "document", "HTMLElement", "Node", "Element", "DOMParser", "IS_REACT_ACT_ENVIRONMENT"]) {
    saved[key] = g[key];
  }
  g.window = dom.window;
  g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement;
  g.Node = dom.window.Node;
  g.Element = dom.window.Element;
  g.DOMParser = dom.window.DOMParser;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  return {
    dom,
    rootEl: dom.window.document.getElementById("root")!,
    cleanup() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete g[k];
        else g[k] = v;
      }
      dom.window.close();
    },
  };
}

test("StreamingMarkdown：流式 Markdown 原生渲染标题 / 粗体 / 未闭合代码块，不漏出原始语法且在末尾挂行内光标", async () => {
  const { createElement, act, createRoot, StreamingMarkdown } = await loadBundle();
  const { dom, rootEl, cleanup } = setupDom();
  try {
    const root = createRoot(rootEl);
    await act(async () => {
      root.render(
        createElement(StreamingMarkdown, {
          text: "## 实验结论\n\n这里包含 **未闭合粗体",
          showCaret: true,
          light: false,
        }),
      );
    });
    const h2 = rootEl.querySelector("h2");
    assert.equal(h2?.textContent, "实验结论");
    const strong = rootEl.querySelector("strong");
    assert.equal(strong?.textContent, "未闭合粗体");
    assert.equal(rootEl.textContent?.includes("**"), false);
    assert.equal(rootEl.textContent?.includes("##"), false);
    // 行内光标挂在最后一个 <p> 内
    const caret = rootEl.querySelector("p .ccode-live-caret");
    assert.ok(caret, "caret should be inline inside trailing paragraph");

    // 切到未闭合围栏代码块：不露出 ```，并且已完成块节点（h2）保持原节点引用不重造
    await act(async () => {
      root.render(
        createElement(StreamingMarkdown, {
          text: "## 实验结论\n\n```python\nprint('ok')",
          showCaret: true,
          light: false,
        }),
      );
    });
    assert.equal(rootEl.querySelector("h2"), h2, "completed block DOM node should stay frozen");
    const preCode = rootEl.querySelector("pre code");
    assert.ok(preCode);
    assert.ok(preCode.textContent?.includes("print('ok')"));
    assert.equal(rootEl.textContent?.includes("```"), false);
    // 外链图片在流式阶段也必须被重写成占位，不产生原生 <img src="https://...">
    await act(async () => {
      root.render(
        createElement(StreamingMarkdown, {
          text: "![pixel](https://evil.example/p.png)",
          showCaret: false,
          light: false,
        }),
      );
    });
    assert.equal(rootEl.querySelector("img"), null);

    await act(async () => root.unmount());
    void dom;
  } finally {
    cleanup();
  }
});

test("LiveScreenPreview：读屏富文本预览渲染标题 / 粗体 / 行内代码 / 等宽表格 / 底色代码块，并随 maxChars 精准裁切", async () => {
  const { createElement, act, createRoot, LiveScreenPreview } = await loadBundle();
  const { rootEl, cleanup } = setupDom();
  try {
    const styledLines = [
      { text: "方案要点", spans: [{ text: "方案要点" }], heading: true },
      {
        text: "先运行 npm test 并核对 关键结论",
        spans: [
          { text: "先运行 " },
          { text: "npm test", code: true },
          { text: " 并核对 " },
          { text: "关键结论", bold: true },
        ],
      },
      { text: "┌───┬───┐", spans: [{ text: "┌───┬───┐" }], table: true },
      { text: "│ A │ B │", spans: [{ text: "│ A │ B │" }], table: true },
      { text: "const x = 1;", spans: [{ text: "const x = 1;" }], codeBlock: true },
    ];
    const fullText = styledLines.map((l) => l.text).join("\n");
    const root = createRoot(rootEl);

    await act(async () => {
      root.render(
        createElement(LiveScreenPreview, {
          styledLines,
          text: fullText,
          maxChars: fullText.length,
          showCaret: true,
          light: true,
        }),
      );
    });

    assert.equal(rootEl.querySelector(".ccode-live-heading")?.textContent, "方案要点");
    assert.equal(rootEl.querySelector("code")?.textContent, "npm test");
    assert.equal(rootEl.querySelector("strong")?.textContent, "关键结论");
    assert.ok(rootEl.querySelector("pre.ccode-live-table")?.textContent?.includes("│ A │ B │"));
    assert.ok(rootEl.querySelector("pre.ccode-live-codeblock code")?.textContent?.includes("const x = 1;"));
    assert.ok(rootEl.querySelector(".ccode-caret-blink"), "caret should render at tail");

    // 匀速显示裁切到前两行中段时，表格和代码块尚未出现
    await act(async () => {
      root.render(
        createElement(LiveScreenPreview, {
          styledLines,
          text: fullText.slice(0, 12),
          maxChars: 12,
          showCaret: true,
          light: false,
        }),
      );
    });
    assert.equal(rootEl.querySelector("pre.ccode-live-table"), null);
    assert.equal(rootEl.querySelector("pre.ccode-live-codeblock"), null);

    await act(async () => root.unmount());
  } finally {
    cleanup();
  }
});
