import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

async function mount() {
  const options: Record<string, any>[] = [];
  const models: string[] = [];
  const observers: Array<() => void> = [];
  let disposed = 0;
  const bundle = await build({
    stdin: { contents: "export {createElement,act} from 'react'; export {createRoot} from 'react-dom/client'; export {default as TextCompare} from './src/components/TextVersionCompare'; export {default as ImageCompare} from './src/components/ImageVersionCompare';", resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", loader: { ".css": "empty" },
    external: ["react", "react-dom/client", "react/jsx-runtime"],
    plugins: [{ name: "host", setup(builder) {
      builder.onResolve({ filter: /^monaco-editor$/ }, () => ({ path: "monaco", namespace: "stub" }));
      builder.onResolve({ filter: /\?(worker|url)$/ }, () => ({ path: "worker", namespace: "stub" }));
      builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: "invoke", namespace: "stub" }));
      builder.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ loader: "js", contents: args.path === "worker" ? "export default class Worker{}" : args.path === "invoke" ? "export const invoke=async()=>({mime:'image/png',data:'YWJj'});" : `export const editor={defineTheme(){},setTheme(){},createModel(text){globalThis.__compareModels(text);return {dispose(){}}},createDiffEditor(host,options){globalThis.__compareOptions(options);return {setModel(){},updateOptions(options){globalThis.__compareOptions(options)},dispose(){globalThis.__compareDispose()}}}};` }));
    } }],
  });
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: () => ({ getPropertyValue: () => "#222222" }),
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { constructor(callback: () => void) { observers.push(callback); } observe() {} disconnect() {} },
    __compareModels: (text: string) => models.push(text),
    __compareOptions: (value: Record<string, any>) => options.push(value),
    __compareDispose: () => { disposed++; },
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const module = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  const { createElement, act, createRoot, TextCompare, ImageCompare } = module.exports;
  const root = createRoot(dom.window.document.getElementById("root")!);
  const document = dom.window.document;
  return {
    createElement, act, root, TextCompare, ImageCompare, document, options, models, observers, disposed: () => disposed,
    button: (label: string) => [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === label)!,
    async cleanup() {
      await act(async () => root.unmount()); dom.window.close();
      for (const [key, descriptor] of restore) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("文本对照两边只读，随容器宽度切左右或单栏，只看改动不改正文，退出销毁编辑器", async () => {
  const mounted = await mount();
  try {
    await mounted.act(async () => mounted.root.render(mounted.createElement(mounted.TextCompare, { before: "old words", after: "new words" })));
    assert.deepEqual(mounted.models, ["old words", "new words"]);
    const initial = mounted.options[0];
    assert.equal(initial.readOnly, true); assert.equal(initial.originalEditable, false); assert.equal(initial.renderMarginRevertIcon, false);
    assert.equal(initial.ignoreTrimWhitespace, false); assert.equal(initial.renderSideBySideInlineBreakpoint, 640);
    const host = mounted.document.querySelector('[aria-label="文本版本对照（只读）"]')!;
    Object.defineProperty(host, "clientWidth", { value: 900, configurable: true });
    await mounted.act(async () => mounted.observers[0]());
    assert.equal(mounted.options.at(-1)?.renderSideBySide, true);
    Object.defineProperty(host, "clientWidth", { value: 400, configurable: true });
    await mounted.act(async () => mounted.observers[0]());
    assert.equal(mounted.options.at(-1)?.renderSideBySide, false);
    const checkbox = mounted.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await mounted.act(async () => checkbox.click());
    assert.equal(mounted.options.at(-1)?.hideUnchangedRegions.enabled, true);
    assert.deepEqual(mounted.models, ["old words", "new words"]);
    await mounted.act(async () => mounted.root.render(null));
    assert.equal(mounted.disposed(), 1);
  } finally { await mounted.cleanup(); }
});

test("图片两边共用倍率和滚动位置，不同尺寸保持比例，原生滚轮同步但不放大", async () => {
  const mounted = await mount();
  try {
    await mounted.act(async () => mounted.root.render(mounted.createElement(mounted.ImageCompare, { before: "/cache/old.png", after: "/cache/current.png" })));
    const images = [...mounted.document.querySelectorAll("img")];
    assert.equal(images.length, 2);
    Object.defineProperty(images[0], "naturalWidth", { value: 1000 }); Object.defineProperty(images[0], "naturalHeight", { value: 500 });
    Object.defineProperty(images[1], "naturalWidth", { value: 2000 }); Object.defineProperty(images[1], "naturalHeight", { value: 1000 });
    await mounted.act(async () => { for (const image of images) image.dispatchEvent(new mounted.document.defaultView!.Event("load")); });
    await mounted.act(async () => mounted.button("100%").click());
    assert.equal(images[0].style.width, "1000px"); assert.equal(images[1].style.width, "2000px");
    await mounted.act(async () => mounted.document.querySelector<HTMLButtonElement>('[aria-label="两图放大"]')!.click());
    assert.equal(images[0].style.width, "1250px"); assert.equal(images[1].style.width, "2500px");
    const left = mounted.document.querySelector<HTMLDivElement>('[aria-label="左图"]')!;
    const right = mounted.document.querySelector<HTMLDivElement>('[aria-label="右图"]')!;
    for (const pane of [left, right]) {
      Object.defineProperty(pane, "clientWidth", { value: 200 }); Object.defineProperty(pane, "clientHeight", { value: 100 });
    }
    Object.defineProperty(left, "scrollWidth", { value: 1000 }); Object.defineProperty(left, "scrollHeight", { value: 500 });
    Object.defineProperty(right, "scrollWidth", { value: 1800 }); Object.defineProperty(right, "scrollHeight", { value: 900 });
    left.scrollLeft = 400; left.scrollTop = 200;
    await mounted.act(async () => left.dispatchEvent(new mounted.document.defaultView!.Event("scroll")));
    assert.equal(right.scrollLeft, 800); assert.equal(right.scrollTop, 400);
    await mounted.act(async () => right.dispatchEvent(new mounted.document.defaultView!.Event("scroll")));
    assert.equal(left.scrollLeft, 400);
    await mounted.act(async () => left.dispatchEvent(new mounted.document.defaultView!.WheelEvent("wheel", { deltaY: 100, bubbles: true })));
    assert.equal(images[0].style.width, "1250px");
  } finally { await mounted.cleanup(); }
});
