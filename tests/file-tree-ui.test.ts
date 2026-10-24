import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// 运行页左栏（2026-10-24 重做，原「上下文」）：栏头就是这段对话的目录，只留搜索与树；搜到的在树里逐级展开，不换根
const bundle = await build({
  stdin: {
    contents: `export {createElement, act} from 'react'; export {createRoot} from 'react-dom/client'; export {default as FileTree} from './src/components/FileTree';`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  jsx: "automatic",
  external: ["react", "react-dom/client", "react/jsx-runtime"],
});

const ROOT = "/Users/u/ccode/scratch";
const dirs: Record<string, { name: string; path: string; isDir: boolean }[]> = {
  [ROOT]: [
    { name: "papers", path: `${ROOT}/papers`, isDir: true },
    { name: "plan.txt", path: `${ROOT}/plan.txt`, isDir: false },
  ],
  [`${ROOT}/papers`]: [{ name: "2026", path: `${ROOT}/papers/2026`, isDir: true }],
  [`${ROOT}/papers/2026`]: [{ name: "smith.pdf", path: `${ROOT}/papers/2026/smith.pdf`, isDir: false }],
};

async function renderTree(cwd: string) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  // JSDOM 没有 scrollIntoView
  (dom.window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  const listed: string[] = [];
  let cb = 1;
  Object.assign(dom.window, {
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
    __TAURI_INTERNALS__: {
      transformCallback: () => cb++,
      invoke: async (command: string, args: Record<string, unknown>) => {
        if (command === "plugin:event|listen") return cb++;
        if (command === "plugin:event|unlisten") return null;
        if (command === "list_dir") {
          listed.push(String(args.path));
          return dirs[String(args.path)] ?? [];
        }
        if (command === "path_context") return { kind: "other", workspaceName: null, branch: null };
        if (command === "git_status_map") return {};
        if (command === "watch_dir") return "w1";
        if (command === "unwatch_dir") return null;
        if (command === "search_files")
          return [{ name: "smith.pdf", path: `${ROOT}/papers/2026/smith.pdf`, isDir: false, rel: "papers/2026/smith.pdf" }];
        throw new Error(`Unexpected IPC: ${command}`);
      },
    },
  });
  const mod = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(
    createRequire(import.meta.url),
    mod,
    mod.exports,
  );
  const { createElement: h, act, createRoot, FileTree } = mod.exports;
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  await act(async () => {
    root.render(
      h(FileTree, {
        cwd,
        showHidden: false,
        refreshKey: 0,
        onOpenFile: () => {},
        onOpenTerminal: () => {},
        actions: h("button", { type: "button", "aria-label": "收起文件树" }),
      }),
    );
  });
  const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
  await settle();
  return {
    dom,
    host,
    act,
    listed,
    settle,
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of restore) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("栏头就是这段对话的目录（随手聊写「随手聊」），行尾是传进来的动作；不再有项目区、最近项目、进入、上一级", async () => {
  const view = await renderTree(ROOT);
  try {
    const text = view.host.textContent ?? "";
    assert.ok(text.startsWith("随手聊"), "栏头写「随手聊」而不是 scratch");
    assert.ok(view.host.querySelector('[aria-label="收起文件树"]'), "行尾动作由运行页给");
    for (const gone of ["上下文", "进行中的项目", "进入", "←", "回到当前目录", "⇄", "⌄"]) {
      assert.ok(!text.includes(gone), `不该再有「${gone}」`);
    }
    assert.ok(text.includes("papers") && text.includes("plan.txt"));
  } finally {
    await view.close();
  }
});

test("搜到的文件：从根逐级展开到它所在的文件夹，不换根", async () => {
  const view = await renderTree(ROOT);
  try {
    const input = view.host.querySelector<HTMLInputElement>('input[aria-label="搜这个目录里的文件"]')!;
    await view.act(async () => {
      Object.getOwnPropertyDescriptor(view.dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "smith");
      input.dispatchEvent(new view.dom.window.Event("input", { bubbles: true }));
    });
    await view.act(async () => new Promise((r) => setTimeout(r, 350)));
    const hit = Array.from(view.host.querySelectorAll("div[title]")).find((d) =>
      d.getAttribute("title")?.includes("点一下在树里找到它"),
    ) as HTMLElement | undefined;
    assert.ok(hit, "搜索结果列出来了");
    await view.act(async () => hit!.click());
    await view.settle();
    const text = view.host.textContent ?? "";
    assert.ok(text.startsWith("随手聊"), "根没换");
    assert.ok(text.includes("2026") && text.includes("smith.pdf"), "逐级展开到了那一项");
    assert.ok(view.listed.includes(`${ROOT}/papers`) && view.listed.includes(`${ROOT}/papers/2026`));
  } finally {
    await view.close();
  }
});
