import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import { build } from "esbuild";

/** 双击段落跳源码行的组件链路（onBodyDoubleClick→jumpToSource→定位 effect）。
 *  口径照抄 review-annotation-ui.test.ts：esbuild 打包真组件 + JSDOM 全局 +
 *  Tauri invoke 桩 + monaco 桩（记录 reveal/setPosition 调用以断言定位行号）。 */
const DOC = [
  "# 标题行", // 1
  "", // 2
  "第一段内容。", // 3
  "", // 4
  "[链接文字](https://example.com)", // 5
  "", // 6
  "第二段内容。", // 7
  "", // 8
  "结尾。", // 9
].join("\n");

test("双击段落切编辑态并定位到该段源码行；双击链接不跳", async () => {
  const bundle = await build({
    stdin: {
      contents:
        "export {createElement,act} from 'react'; export {createRoot} from 'react-dom/client'; export {useState} from 'react'; export {default as Preview} from './src/components/ProjectFilePreview';",
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
        name: "host",
        setup(b) {
          b.onResolve({ filter: /^monaco-editor$/ }, () => ({
            path: "monaco",
            namespace: "stub",
          }));
          b.onResolve({ filter: /\?(worker|url)$/ }, () => ({
            path: "asset",
            namespace: "stub",
          }));
          b.onResolve({ filter: /\/MdToc$/ }, () => ({
            path: "toc",
            namespace: "stub",
          }));
          b.onResolve({ filter: /\/MermaidDiagrams$/ }, () => ({
            path: "mermaid",
            namespace: "stub",
          }));
          b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
            loader: "js",
            contents:
              args.path === "asset"
                ? 'export default "data:text/javascript,";'
                : args.path === "monaco"
                  ? `const doc = ${JSON.stringify(DOC)};
(globalThis.__mdJump ??= { reveal: [], pos: [] });
const model={getValue(){return doc},setValue(){},getFullModelRange(){return{}},getLineCount(){return 9}};
const ed={dispose(){},updateOptions(){},layout(){},focus(){},hasTextFocus(){return false},addCommand(){},getDomNode(){return null},getSelection(){return null},executeEdits(){},pushUndoStop(){},onDidChangeModelContent(){return{dispose(){}}},getModel(){return model},getValue(){return doc},
revealLineInCenter(l){globalThis.__mdJump.reveal.push(l)},setPosition(p){globalThis.__mdJump.pos.push(p)}};
export const editor={defineTheme(){},setTheme(){},create(){return ed}};
export const KeyMod={CtrlCmd:2048,Shift:1024,WinCtrl:256};
export const KeyCode={Enter:3,KeyB:32,KeyC:33,KeyI:39,KeyX:54};
export const languages={register(){},setMonarchTokensProvider(){},getLanguages(){return[]}};
const lsd={setModeConfiguration(){}};
export const css={cssDefaults:lsd,scssDefaults:lsd,lessDefaults:lsd};
export const html={htmlDefaults:lsd,handlebarDefaults:lsd,razorDefaults:lsd};
export const json={jsonDefaults:lsd};
export const typescript={typescriptDefaults:lsd,javascriptDefaults:lsd};`
                  : "export default function Stub(){return null;}",
          }));
        },
      },
    ],
  });
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  class FakeObserver {
    observe() {}
    disconnect() {}
    unobserve() {}
    takeRecords() {
      return [];
    }
  }
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
    IntersectionObserver: FakeObserver,
    MutationObserver: FakeObserver,
    DOMMatrix: class {
      multiplySelf() {
        return this;
      }
    },
    requestAnimationFrame: (fn: () => void) => {
      fn();
      return 0;
    },
    cancelAnimationFrame: () => {},
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    self: dom.window,
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
  Object.assign(dom.window, {
    __TAURI_INTERNALS__: {
      invoke: async (command: string) => {
        if (command === "read_file_preview") {
          return { text: DOC, truncated: false, readOnlyReason: null, revision: "o1" };
        }
        if (command === "path_context") return { kind: "other" };
        return null;
      },
    },
  });
  const mod = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(
    createRequire(import.meta.url),
    mod,
    mod.exports,
  );
  const { createElement: h, act, createRoot, useState, Preview } = mod.exports;
  // FilePreviewEditor 是 lazy 加载，monaco 桩在首渲染时才评估——先预置调用记录对象
  //（桩内 ??= 不会覆盖既有对象）
  (globalThis as Record<string, unknown>).__mdJump = { reveal: [], pos: [] };
  const jump = globalThis.__mdJump as { reveal: number[]; pos: unknown[] };

  function Harness() {
    const [, force] = useState(0);
    return h(
      "div",
      null,
      h(
        "button",
        { onClick: () => force((n: number) => n + 1) },
        "rerender",
      ),
      h(Preview, { path: "/tree/note.md", root: "/tree" }),
    );
  }

  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  try {
    await act(async () => root.render(h(Harness)));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const body = host.querySelector(".md-body");
    assert.ok(body, "阅读态 .md-body 应存在");
    const paragraphs = Array.from(body.children).filter(
      (el) => el.tagName === "P",
    );
    assert.equal(paragraphs.length, 4);

    // 双击链接（第 3 个块，行 5 的段落里）：不跳、保持阅读态
    const linkPara = paragraphs[1];
    const anchor = linkPara.querySelector("a");
    assert.ok(anchor, "应有链接");
    await act(async () => {
      anchor.dispatchEvent(
        new dom.window.MouseEvent("dblclick", { bubbles: true }),
      );
    });
    assert.ok(host.querySelector(".md-body"), "双击链接不应切编辑态");
    assert.deepEqual(jump.reveal, []);

    // 双击「第二段内容。」（第 4 个顶层块，行 7）：切编辑态 + 定位行 7
    await act(async () => {
      paragraphs[2].dispatchEvent(
        new dom.window.MouseEvent("dblclick", { bubbles: true }),
      );
    });
    assert.ok(!host.querySelector(".md-body"), "双击段落后应切到编辑态");
    assert.equal(jump.reveal.at(-1), 7, "应滚到第 7 行（该段源码行）");
    assert.deepEqual(jump.pos.at(-1), { lineNumber: 7, column: 1 });
  } finally {
    await act(async () => root.unmount());
    for (const [key, desc] of restore) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    delete (globalThis as Record<string, unknown>).__mdJump;
  }
});
