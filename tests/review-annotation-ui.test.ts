import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const OUTLINE = `# 综述定位

**覆盖边界**：核心只写镁负极与界面。
`;

test("大纲阅读态划选后，批注写进同一个意见框", async () => {
  const bundle = await build({
    stdin: {
      contents: `export {createElement,act} from 'react'; export {createRoot} from 'react-dom/client'; export {useState} from 'react'; export {default as Preview} from './src/components/ProjectFilePreview'; export {appendReviewAnnotation} from './src/draft-review';`,
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
                ? "export default \"data:text/javascript,\";"
                : args.path === "monaco"
                  ? `const model={getValue(){return ""},setValue(){},getFullModelRange(){return{}}};
const ed={dispose(){},updateOptions(){},layout(){},focus(){},hasTextFocus(){return false},addCommand(){},getDomNode(){return null},getSelection(){return null},executeEdits(){},pushUndoStop(){},onDidChangeModelContent(){return{dispose(){}}},getModel(){return model},getValue(){return ""}};
export const editor={defineTheme(){},setTheme(){},create(){return ed}};
export const KeyMod={CtrlCmd:2048,Shift:1024,WinCtrl:2048};
export const KeyCode={Enter:3,KeyB:41,KeyC:42,KeyI:53,KeyX:56};
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
          return {
            text: OUTLINE,
            truncated: false,
            readOnlyReason: null,
            revision: "o1",
          };
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
  const { createElement: h, act, createRoot, useState, Preview, appendReviewAnnotation } =
    mod.exports;

  function Harness() {
    const [notes, setNotes] = useState("摘要去掉未核实句。");
    return h(
      "div",
      null,
      h("textarea", { value: notes, readOnly: true, "aria-label": "意见" }),
      h(Preview, {
        path: "/tree/outline.md",
        root: "/tree",
        onAnnotate: (text: string, fileName: string, comment: string) => {
          setNotes((current: string) =>
            appendReviewAnnotation(current, { fileName, excerpt: text, comment }),
          );
          return null;
        },
      }),
    );
  }

  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  const quote = "核心只写镁负极与界面";
  try {
    await act(async () => root.render(h(Harness)));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assert.match(host.textContent ?? "", /核心只写镁负极与界面/);
    const body = host.querySelector(".md-body");
    assert.ok(body);
    const anchor = findText(body, quote);
    assert.ok(anchor);
    const start = anchor.textContent!.indexOf(quote);
    const range = dom.window.document.createRange();
    range.setStart(anchor, start);
    range.setEnd(anchor, start + quote.length);
    const box = {
      right: 80,
      bottom: 40,
      left: 8,
      top: 20,
      width: 72,
      height: 20,
      x: 8,
      y: 20,
      toJSON() {
        return {};
      },
    } as DOMRect;
    range.getBoundingClientRect = () => box;
    const sel = dom.window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const scroll = body.parentElement as HTMLElement;
    scroll.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 800,
        bottom: 600,
        width: 800,
        height: 600,
        x: 0,
        y: 0,
        toJSON() {
          return {};
        },
      }) as DOMRect;
    await act(async () => {
      dom.window.document.dispatchEvent(new dom.window.Event("selectionchange"));
    });
    const add = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "加进意见",
    );
    assert.ok(add, host.innerHTML.slice(0, 500));
    await act(async () =>
      add!.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      ),
    );
    const input = host.querySelector("input");
    assert.ok(input);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "改成只在背景提一句");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    const commit = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "加入意见",
    );
    assert.ok(commit);
    await act(async () => commit!.click());
    const opinion = host.querySelector("textarea");
    assert.match(
      opinion?.textContent ?? opinion?.value ?? "",
      /摘要去掉未核实句/,
    );
    assert.match(
      opinion?.value ?? "",
      /「核心只写镁负极与界面」（outline\.md）：改成只在背景提一句/,
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, desc] of restore) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else Reflect.deleteProperty(globalThis, key);
    }
  }

  function findText(rootNode: Node, needle: string): Node | null {
    const walker = dom.window.document.createTreeWalker(
      rootNode,
      dom.window.NodeFilter.SHOW_TEXT,
    );
    let current = walker.nextNode();
    while (current) {
      if ((current.textContent ?? "").includes(needle)) return current;
      current = walker.nextNode();
    }
    return null;
  }
});
