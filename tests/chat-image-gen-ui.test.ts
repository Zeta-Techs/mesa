import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// 聊天出图胶囊（components/ChatImageGen.tsx）：换模型、对比几个、挑中一张回到单个模型。esbuild 内联打包 + JSDOM，口径同 chat-composer-chips-ui
const bundle = await build({
  stdin: {
    contents: `import { createElement, useEffect } from 'react';
      import { useChatImageGen } from './src/components/ChatImageGen';
      export { act } from 'react';
      export { createRoot } from 'react-dom/client';
      export { useAppStore } from './src/store';
      export { createElement };
      export function Harness(props) {
        const g = useChatImageGen({ tabId: 't1', sessionId: null, agentId: 'codex', skills: props.skills, generating: false, attention: null });
        useEffect(() => { g.composer.setOn(true); }, []);
        window.__gen.latest = g;
        return createElement('div', null, g.composer.pill, g.composer.issue);
      }`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  jsx: "automatic",
  loader: { ".css": "empty", ".png": "dataurl", ".svg": "empty" },
  external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
  plugins: [
    {
      name: "image-gen-host",
      setup(b) {
        b.onResolve({ filter: /\.svg\?raw$/ }, (args) => ({ path: args.path, namespace: "svg-raw" }));
        b.onLoad({ filter: /.*/, namespace: "svg-raw" }, () => ({ contents: `export default "<svg></svg>";`, loader: "js" }));
      },
    },
  ],
});

async function mount() {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const host = { sets: [] as unknown[], latest: null as any };
  Object.assign(dom.window, {
    __gen: host,
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args?: unknown) => {
        if (command === "image_gen_chat_sync") return null;
        if (command === "image_gen_chat_set") return (host.sets.push(args), null);
        if (command === "image_gen_status") return { helperReady: true };
        if (command === "image_gen_candidates") {
          return [
            { gatewayId: "codex", gatewayName: "Codex", models: ["gemini-3-pro-image", "gpt-image-2.5"] },
            { gatewayId: "agy", gatewayName: "Antigravity", models: ["gemini-3-pro-image"] },
          ];
        }
        if (command === "image_gen_chat_calls") {
          return [
            { id: "c1", at: 1, phase: "done", model: "gpt-image-2.5", gatewayName: "Codex", paths: ["/p/figures/cat-gpt.png"] },
            { id: "c2", at: 2, phase: "done", model: "gemini-3-pro-image", gatewayName: "Antigravity", paths: ["/p/figures/cat-gemini.png"] },
          ];
        }
        throw new Error(`Unexpected IPC: ${command}`);
      },
    },
  });
  const compiled = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
  const { act, createRoot, createElement: h, Harness, useAppStore } = compiled.exports;
  useAppStore.setState({ settings: { ...(useAppStore.getState().settings ?? {}), imageGenGatewayId: "codex", imageGenModel: "gpt-image-2.5" } });
  const el = dom.window.document.getElementById("root")!;
  const root = createRoot(el);
  await act(async () => root.render(h(Harness, { skills: [{ name: "image-gen" }] })));
  // 候选目录、调用记录是异步读回来的
  await act(async () => new Promise((r) => setTimeout(r, 20)));
  const doc = dom.window.document;
  const pill = () => el.querySelector<HTMLElement>('[data-testid="image-gen-pill"]')!;
  const listbox = () => doc.querySelector<HTMLElement>('[role="listbox"]');
  const option = (model: string, gateway?: string) =>
    Array.from(listbox()!.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(
      (o) => o.textContent?.includes(model) && (!gateway || o.textContent.includes(gateway)),
    )!;
  const clickText = (scope: HTMLElement, text: string) =>
    act(async () => Array.from(scope.querySelectorAll("button")).find((b) => b.textContent?.trim() === text)!.click());
  const openPicker = () => act(async () => pill().querySelector<HTMLButtonElement>("button")!.click());
  return {
    act, host, pill, listbox, option, clickText, openPicker, doc,
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, d] of restore) {
        if (d) Object.defineProperty(globalThis, key, d);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}

test("出图胶囊：对比几个 → 勾两个收起成「2 个模型对比」，那一行点名两个；挑中其中一张改图回到出它的那个模型", async () => {
  const ui = await mount();
  try {
    assert.match(ui.pill().textContent ?? "", /gpt-image-2\.5/, "默认是连接页那个");
    await ui.openPicker();
    assert.ok(ui.listbox(), "点模型名弹出选择框");
    assert.match(ui.listbox()!.textContent ?? "", /只管这个对话 · 连接页默认：gpt-image-2\.5（Codex 网关）/);
    assert.match(ui.option("gemini-3-pro-image", "Antigravity").textContent ?? "", /Antigravity 网关/, "网关列写成「某某 网关」");

    await ui.clickText(ui.listbox()!, "对比几个");
    assert.match(ui.listbox()!.textContent ?? "", /已选 1 \/ 4/, "从现在这个模型起步");
    await ui.act(async () => ui.option("gemini-3-pro-image", "Antigravity").click());
    assert.match(ui.listbox()!.textContent ?? "", /已选 2 \/ 4/, "多选不收起");
    await ui.act(async () => ui.doc.dispatchEvent(new ui.doc.defaultView!.KeyboardEvent("keydown", { key: "Escape" })));
    assert.match(ui.pill().textContent ?? "", /2 个模型对比/);
    const line = ui.host.latest.composer.directive("画一只猫", false);
    assert.equal(
      line.line,
      "使用 image-gen 技能出图（出图模型 gpt-image-2.5、gemini-3-pro-image 各出一版对比，用 $MESA_IMAGE_TOOL 出图工具）：",
    );
    assert.equal(ui.host.sets.length, 0, "对比不改这个对话记着的模型");

    // 点一张不是对比里出的图：仍在对比（几个模型各改一版）
    await ui.act(async () => ui.host.latest.composer.onEditImage("/p/photo.png"));
    assert.match(ui.pill().textContent ?? "", /2 个模型对比/);
    // 挑中 Gemini 那张接着改：回到 Gemini（Antigravity 网关），并记成这个对话的模型
    await ui.act(async () => ui.host.latest.composer.onEditImage("/p/figures/cat-gemini.png"));
    assert.match(ui.pill().textContent ?? "", /gemini-3-pro-image/);
    assert.doesNotMatch(ui.pill().textContent ?? "", /对比/);
    assert.deepEqual(ui.host.sets.at(-1), { tabId: "t1", sessionId: null, gatewayId: "agy", model: "gemini-3-pro-image" });
    assert.match(ui.host.latest.composer.directive("帽子换蓝色", true).line, /^使用 image-gen 技能改图（出图模型 gemini-3-pro-image，/);
  } finally {
    await ui.close();
  }
});

test("出图胶囊：多选只勾回一个就当换成它；「只用一个」留第一个", async () => {
  const ui = await mount();
  try {
    await ui.openPicker();
    await ui.clickText(ui.listbox()!, "对比几个");
    // 取消默认那个、换勾 Gemini（推荐里那一行，Antigravity 网关）：只剩一个，收起后就是换成它
    await ui.act(async () => ui.option("gpt-image-2.5").click());
    await ui.act(async () => ui.option("gemini-3-pro-image", "Antigravity").click());
    await ui.act(async () => ui.doc.dispatchEvent(new ui.doc.defaultView!.KeyboardEvent("keydown", { key: "Escape" })));
    assert.match(ui.pill().textContent ?? "", /gemini-3-pro-image/);
    assert.deepEqual(ui.host.sets.at(-1), { tabId: "t1", sessionId: null, gatewayId: "agy", model: "gemini-3-pro-image" });

    await ui.openPicker();
    await ui.clickText(ui.listbox()!, "对比几个");
    await ui.act(async () => ui.option("gpt-image-2.5").click());
    await ui.clickText(ui.listbox()!, "只用一个");
    assert.ok(ui.listbox(), "选择框留着、回到单选");
    assert.doesNotMatch(ui.listbox()!.textContent ?? "", /已选/);
    assert.match(ui.pill().textContent ?? "", /gemini-3-pro-image/, "留第一个（原来那个）");
  } finally {
    await ui.close();
  }
});
