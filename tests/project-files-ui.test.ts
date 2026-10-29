import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import { build } from "esbuild";

/** 文件页交互链路：预览步进抢键口径（打字焦点放行）、Esc 关预览、
 *  右键菜单、最近视图。口径照抄 md-jump-ui.test.ts：esbuild 打包真组件 +
 *  JSDOM 全局 + Tauri invoke 桩 + monaco 桩；read_file_preview 的调用路径
 *  记录下来当「当前预览是谁」的观测点。 */
const ROOT = "/p";

test("文件页：↑/↓ 步进、打字焦点放行、Esc 关预览、右键菜单、最近视图、多选、文件夹数量、PDF 阅读状态", async () => {
  const bundle = await build({
    stdin: {
      contents:
        "export {createElement,act} from 'react'; export {createRoot} from 'react-dom/client'; export {useState} from 'react'; export {default as View} from './src/components/ProjectFilesView';",
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
                  ? `const doc = "# a\\n";
const model={getValue(){return doc},setValue(){},getFullModelRange(){return{}},getLineCount(){return 2}};
const ed={dispose(){},updateOptions(){},layout(){},focus(){},hasTextFocus(){return false},addCommand(){},getDomNode(){return null},getSelection(){return null},executeEdits(){},pushUndoStop(){},onDidChangeModelContent(){return{dispose(){}}},getModel(){return model},getValue(){return doc},revealLineInCenter(){},setPosition(){}};
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
  // jsdom 不实现 scrollIntoView；文件页预览切换后的滚动定位需要它
  (dom.window.HTMLElement.prototype as unknown as Record<string, unknown>)
    .scrollIntoView = () => {};
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
    // ProjectFilesView 的滚动定位用 CSS.escape
    CSS: dom.window.CSS,
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
  const reads: string[] = [];
  const officeDocs = [
    {
      path: `${ROOT}/papers/c.md`,
      name: "c.md",
      rel: "papers/c.md",
      size: 5,
      modified: "2026-10-16T02:00:00Z",
    },
    {
      path: `${ROOT}/a.md`,
      name: "a.md",
      rel: "a.md",
      size: 10,
      modified: "2026-10-16T01:00:00Z",
    },
  ];
  Object.assign(dom.window, {
    // 事件插件（@tauri-apps/api/event）的注销钩子走这个 internals（区别于 invoke 的那套）
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
    __TAURI_INTERNALS__: {
      invoke: async (command: string, payload: Record<string, unknown>) => {
        if (command === "read_file_preview") {
          reads.push(String(payload?.path));
          return {
            text: "# a\n",
            truncated: false,
            readOnlyReason: null,
            revision: "o1",
          };
        }
        if (command === "list_dir") {
          const p = String(payload?.path);
          if (p === ROOT)
            return [
              {
                name: "papers",
                path: `${ROOT}/papers`,
                isDir: true,
                size: 0,
                modified: "2026-10-16T01:00:00Z",
                childCount: 2,
              },
              {
                name: "a.md",
                path: `${ROOT}/a.md`,
                isDir: false,
                size: 10,
                modified: "2026-10-16T01:00:00Z",
              },
              {
                name: "b.md",
                path: `${ROOT}/b.md`,
                isDir: false,
                size: 10,
                modified: "2026-10-16T00:00:00Z",
              },
            ];
          if (p === `${ROOT}/papers`)
            return [
              {
                name: "Boride catalysts for hydrogen evolution.pdf",
                path: `${ROOT}/papers/Boride catalysts for hydrogen evolution.pdf`,
                isDir: false,
                size: 5,
                modified: "2026-10-16T02:00:00Z",
              },
              {
                name: "c.md",
                path: `${ROOT}/papers/c.md`,
                isDir: false,
                size: 5,
                modified: "2026-10-16T02:00:00Z",
              },
            ];
          return [];
        }
        if (command === "list_office_docs") return officeDocs;
        if (command === "list_paper_notes") return [];
        if (command === "list_included_entries")
          return [{ title: "Boride catalysts for hydrogen evolution" }];
        if (command === "list_reading_list_entries") return [];
        if (command === "watch_dir") return "w1";
        return null;
      },
      transformCallback: () => 1,
      unregisterListener: async () => {},
    },
  });
  const mod = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(
    createRequire(import.meta.url),
    mod,
    mod.exports,
  );
  const { createElement: h, act, createRoot, View } = mod.exports;
  const errors: string[] = [];

  const rootEl = dom.window.document.getElementById("root")!;
  const root = createRoot(rootEl);
  await act(async () => {
    root.render(
      h(View, {
        projectPath: ROOT,
        workMode: null,
        onError: (m: string) => errors.push(m),
      }),
    );
  });

  const body = dom.window.document.body;
  // 树渲染：根下两份 md + 一个文件夹
  assert.ok(body.textContent!.includes("a.md"));
  assert.ok(body.textContent!.includes("b.md"));
  assert.ok(body.textContent!.includes("papers"));
  // 类型筛选写字：「文档」带数量，不再只有图标
  const filterBar = body.querySelector('[role="radiogroup"][aria-label="文件类型"]')!;
  assert.ok(filterBar.textContent!.includes("文档"));
  // 收起的文件夹写里面有几项
  const papersRow = [...body.querySelectorAll("button[aria-expanded]")].find((b) =>
    b.textContent!.includes("papers"),
  )!;
  assert.ok(papersRow.textContent!.includes("2"));

  // 多选：Ctrl/⌘ 点两份 → 批量操作条；Esc 取消选择
  const click = (el: Element, mods: Record<string, boolean> = {}) =>
    act(async () => {
      el.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, ...mods }),
      );
    });
  const readsBeforePick = reads.length;
  await click(body.querySelector(`[data-file-path="${ROOT}/a.md"]`)!, { metaKey: true, ctrlKey: true });
  await click(body.querySelector(`[data-file-path="${ROOT}/b.md"]`)!, { metaKey: true, ctrlKey: true });
  const bar = () => body.querySelector('[role="toolbar"][aria-label="批量操作"]');
  assert.ok(bar()?.textContent!.includes("已选 2 个文件"));
  assert.equal(reads.length, readsBeforePick, "⌘ 点只选不预览");
  // 没有 PDF 就不出「加入积累」
  assert.ok(!bar()!.textContent!.includes("加入积累"));
  // 右键选中的那行 = 批量菜单
  await act(async () => {
    body.querySelector(`[data-file-path="${ROOT}/a.md"]`)!.dispatchEvent(
      new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
  });
  assert.ok(body.textContent!.includes("删除 2 个文件"));
  // 第一下 Esc 先收菜单（菜单退场有动画，等它卸载），第二下才取消选择
  await act(async () => {
    dom.window.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await new Promise((r) => setTimeout(r, 400));
  });
  assert.ok(bar(), "收菜单的那一下不取消选择");
  await act(async () => {
    dom.window.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  assert.equal(bar(), null, "Esc 取消选择");

  // 展开 papers：PDF 行标出阅读状态（在精读清单里 = 已在清单），展开后文件夹不再写数量
  await click(papersRow);
  const pdfRow = body.querySelector(
    `[data-file-path="${ROOT}/papers/Boride catalysts for hydrogen evolution.pdf"]`,
  )!;
  assert.ok(pdfRow.textContent!.includes("已在清单"));
  // Shift 连选：从 a.md 点到 PDF，中间的 b.md 一起选上；有 PDF 才出「加入积累」
  await click(body.querySelector(`[data-file-path="${ROOT}/papers/c.md"]`)!, { metaKey: true, ctrlKey: true });
  await click(pdfRow, { shiftKey: true });
  assert.ok(bar()?.textContent!.includes("已选 2 个文件"));
  assert.ok(bar()!.textContent!.includes("加入积累"));
  await click(body.querySelector('[aria-label="取消选择"]')!);
  assert.equal(bar(), null);
  // 收起 papers，后面的步进断言照旧只在根下两份之间走
  await click(papersRow);

  // 点文件 → 预览打开（同一文件初次加载可能读两次：初次 + 编辑器 ready 后刷新，
  //  断言只看「最后一次读到谁」）
  const rowA = body.querySelector(`[data-file-path="${ROOT}/a.md"]`)!;
  await act(async () => {
    rowA.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
  assert.equal(reads[reads.length - 1], `${ROOT}/a.md`);

  // 窗口方向键（焦点不在打字控件上）→ 步进到下一个文件
  await act(async () => {
    dom.window.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  assert.equal(reads[reads.length - 1], `${ROOT}/b.md`);

  // 打字焦点（Monaco 编辑面是 textarea）→ 方向键放行，不换文件
  const ta = dom.window.document.createElement("textarea");
  body.appendChild(ta);
  const readsBefore = reads.length;
  await act(async () => {
    ta.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  assert.equal(reads.length, readsBefore);
  assert.equal(reads[reads.length - 1], `${ROOT}/b.md`);

  // 打字焦点里的 Esc 归输入自己（新建文件夹输入/Monaco 同类）：不关预览
  const input = dom.window.document.createElement("input");
  body.appendChild(input);
  await act(async () => {
    input.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  assert.ok(body.querySelector('[aria-label="关闭预览"]'));
  body.removeChild(input);

  // Esc（焦点不在预览内）→ 关预览
  assert.ok(body.querySelector('[aria-label="关闭预览"]'));
  await act(async () => {
    body.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  assert.ok(!body.querySelector('[aria-label="关闭预览"]'));

  // 窗口预览里步进不收窗：大窗的 ↑/↓ 按钮与全局方向键都应保持 Modal 打开
  await act(async () => {
    rowA.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
  const windowBtn = [...body.querySelectorAll("button")].find((b) =>
    b.textContent!.includes("窗口预览"),
  )!;
  await act(async () => {
    windowBtn.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
  assert.ok(body.querySelector('[role="dialog"]'));
  await act(async () => {
    dom.window.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  assert.ok(body.querySelector('[role="dialog"]'));
  assert.equal(reads[reads.length - 1], `${ROOT}/b.md`);
  // Esc 在窗口态归 Modal：从 Modal 内按钮派发（冒泡到 document 才进 Modal 的监听）。
  // 窗口预览的 Modal 是条件渲染整棵卸载（不经 open 翻转退场动画），断言已卸载
  const modalBtn = body.querySelector<HTMLButtonElement>(
    '[role="dialog"] button',
  )!;
  await act(async () => {
    modalBtn.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  assert.ok(!body.querySelector('[role="dialog"]'));

  // 右键文件行 → 菜单（复制路径 / 删除）
  await act(async () => {
    rowA.dispatchEvent(
      new dom.window.MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  assert.ok(body.textContent!.includes("复制路径"));
  assert.ok(body.textContent!.includes("删除文件"));
  await act(async () => {
    dom.window.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  });

  // 「最近」视图：officeDocs 按修改时间降序平铺，rel 与 name 不同时带目录上下文
  const recentBtn = [
    ...body.querySelectorAll("button"),
  ].find((b) => b.textContent!.includes("最近"))!;
  await act(async () => {
    recentBtn.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
  assert.ok(body.textContent!.includes("papers/c.md"));

  await act(async () => {
    root.unmount();
  });
  // 卸载触发的 unwatch/unlisten 清理是异步 promise：等它落定再还原全局，
  // 否则迟到的清理在 window 已删的裸环境里炸 unhandledRejection
  await new Promise((r) => setTimeout(r, 20));
  for (const [key, desc] of restore.reverse()) {
    if (desc) Object.defineProperty(globalThis, key, desc);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});
