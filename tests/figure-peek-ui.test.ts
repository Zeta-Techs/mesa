import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

/** 对照窗（2026-11-05）：几项并存是标签，点标签切换、× 关一项、p.N 让正文跳页；
 *  按区域渲染：圈选的区域经 transform 平移到画布原点 */
test("对照窗：标签切换、关一项、跳页，圈选区域按页内比例平移渲染", async () => {
  const bundle = await build({
    stdin: {
      contents: `export {createElement, act} from 'react';
        export {createRoot} from 'react-dom/client';
        export {default as Peek} from './src/components/PdfFigurePeek';`,
      resolveDir: process.cwd(), loader: "tsx",
    },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
  });
  const dom = new JSDOM('<div id="host" style="position:relative"><div id="root"></div></div>', { url: "http://localhost/" });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  class RO { observe() {} disconnect() {} }
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: RO,
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  // JSDOM 没有布局：给宿主与窗内容一个尺寸
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { configurable: true, get() { return 800; } });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", { configurable: true, get() { return 600; } });
  const renders: { page: number; transform: number[] }[] = [];
  const doc = {
    async getPage(n: number) {
      return {
        getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
        render: (args: { transform: number[] }) => {
          renders.push({ page: n, transform: args.transform });
          return { promise: Promise.resolve(), cancel() {} };
        },
      };
    },
  };
  const compiled = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(
    createRequire(import.meta.url), compiled, compiled.exports,
  );
  const { createElement: h, act, createRoot, Peek } = compiled.exports;
  const root = createRoot(dom.window.document.getElementById("root")!);
  const closed: string[] = [];
  const jumped: number[] = [];
  let active = "cap";
  const items = [
    { key: "cap", page: 3, label: "p.3 圈选", region: { x: 0.5, y: 0.25, w: 0.5, h: 0.5 } },
    { key: "fig", page: 7, label: "Fig. 2", region: null, focusY: 0.6 },
  ];
  const render = () => act(async () => root.render(h(Peek, {
    doc, items, activeKey: active,
    onActivate: (k: string) => { active = k; },
    onClose: (k: string) => closed.push(k),
    onJump: (p: number) => jumped.push(p),
  })));
  const buttons = () => [...dom.window.document.querySelectorAll("button")];
  try {
    await render();
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    // 浮窗挂 body、fixed：能拖到笔记栏 / 对话栏上面，不关在 PDF 栏里
    const win = dom.window.document.querySelector<HTMLElement>("body > [data-figure-peek]");
    assert.ok(win, "挂在 body 上");
    assert.match(win!.className, /\bfixed\b/);
    assert.ok(parseInt(win!.style.width) >= 420, "默认比栏内窗大");
    assert.ok(buttons().some((b) => b.textContent?.includes("p.3 圈选")));
    assert.ok(buttons().some((b) => b.textContent?.includes("Fig. 2")));
    // 圈选区域：平移量 = 区域左上角在当前倍率下的像素（× 输出倍率），落在画布原点
    const r = renders.at(-1)!;
    assert.equal(r.page, 3);
    assert.ok(r.transform[4] < 0 && r.transform[5] < 0, "区域左上角平移到原点");
    // 点标签切换、p.N 跳页、× 关当前项
    await act(async () => buttons().find((b) => b.textContent?.includes("Fig. 2"))!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(active, "fig");
    await render();
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    assert.equal(renders.at(-1)!.page, 7);
    const whole = renders.at(-1)!.transform;
    assert.ok(Math.abs(whole[4]) === 0 && Math.abs(whole[5]) === 0, "整页不平移");
    await act(async () => buttons().find((b) => b.textContent === "p.7")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.deepEqual(jumped, [7]);
    await act(async () => buttons().find((b) => b.getAttribute("aria-label") === "关掉对照窗")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.deepEqual(closed, ["fig"]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
