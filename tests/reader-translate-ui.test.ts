import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

/** 译文浮窗（2026-11-06 用户选「只留浮窗」）：摆到原文段下方、× 彻底关掉不留东西、⋯ 里只有问这段 / 历史、历史在窗里看 */
test("译文浮窗：按原文段摆位、球和窗一体拖动、点球收起 / 展开、× 关掉连球收掉、历史在窗里翻", async () => {
  const bundle = await build({
    stdin: {
      contents: `export {createElement, act} from 'react';
        export {createRoot} from 'react-dom/client';
        export {default as Panel} from './src/components/ReaderTranslatePanel';`,
      resolveDir: process.cwd(), loader: "tsx",
    },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
  });
  const dom = new JSDOM('<div id="host"><div id="root"></div></div>', { url: "http://localhost/" });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  class RO { observe() {} disconnect() {} }
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: RO,
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  // JSDOM 没有布局：浮窗的定位祖先是覆盖层根（这里是 #host，1400×900），浮窗自己 416×240
  const hostEl = dom.window.document.getElementById("host")!;
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetParent", { configurable: true, get() { return hostEl; } });
  const rectOf = (w: number, h: number) => ({ x: 0, y: 0, left: 0, top: 0, right: w, bottom: h, width: w, height: h, toJSON() {} });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return (this.id === "host" ? rectOf(1400, 900) : rectOf(416, 240)) as DOMRect;
  };
  const compiled = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
  const { createElement: h, act, createRoot, Panel } = compiled.exports;
  const root = createRoot(dom.window.document.getElementById("root")!);
  const entry = (at: string, page: number, translated: string) => ({ original: "orig", translated, page, saved: false, at });
  const history = [entry("2", 3, "第二段译文"), entry("1", 2, "第一段译文")];
  const modes: string[] = [];
  let cancelled = 0;
  const shown: Array<string | null> = [];
  const props = (over: Record<string, unknown> = {}) => ({
    mode: "open", onMode: (m: string) => modes.push(m), latest: history[0], pending: null, history, saving: false, canSave: true,
    bounds: { left: 100, right: 300, top: 40, bottom: 0 },
    place: { key: "sel-1", rect: { top: 200, bottom: 320, left: 300, right: 700 } },
    onRetry() {}, onCancelPending: () => { cancelled++; }, onSaveEntry() {}, onHint() {}, onAsk() {}, canAsk: true,
    onDisplay: (e: { at: string } | null) => shown.push(e?.at ?? null),
    ...over,
  });
  const win = () => dom.window.document.querySelector<HTMLElement>("[data-reader-translate]");
  const button = (label: string) => [...dom.window.document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  try {
    await act(async () => root.render(h(Panel, props())));
    assert.ok(win(), "开着就有窗");
    assert.equal(win()!.style.left, "300px", "左缘对齐原文段");
    assert.equal(win()!.style.top, "328px", "贴在原文段下方 8px");
    assert.match(win()!.textContent!, /第二段译文/);
    assert.equal(shown.at(-1), "2", "告诉上层在 PDF 上标出这条的原文段");
    // ⋯ 里只有问这段 / 历史，没有「钉在 PDF 上」
    await act(async () => button("⋯")!.click());
    assert.ok(button("问这段"));
    assert.ok(button("历史（2）"));
    assert.doesNotMatch(dom.window.document.body.textContent!, /钉在|悬浮球|回到右栏/);
    // 历史在窗里看，点一条载入
    await act(async () => button("历史（2）")!.click());
    assert.match(win()!.textContent!, /本篇的翻译/);
    const first = [...win()!.querySelectorAll("li button")].find((b) => b.textContent?.includes("第一段译文")) as HTMLButtonElement;
    await act(async () => first.click());
    assert.match(win()!.textContent!, /第 2 页/);
    assert.match(win()!.textContent!, /第一段译文/);
    // 有译文就有「译」悬浮球，贴在窗左侧、顶边对齐（窗左缘 300 − 球 36 − 缝 6 = 258）
    const ball = () => dom.window.document.querySelector<HTMLElement>("[data-reader-translate-ball]");
    assert.ok(ball(), "窗开着球也在");
    assert.equal(ball()!.style.left, "258px");
    assert.equal(ball()!.style.top, "328px");
    assert.equal(ball()!.getAttribute("aria-expanded"), "true");
    assert.equal(dom.window.document.querySelector('[aria-label="收起译文"]')?.textContent?.trim(), "译", "收起靠球，表头不再有「—」");
    const drag = async (el: HTMLElement, x0: number, y0: number, x1: number, y1: number) => act(async () => {
      el.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: x0, clientY: y0 }));
      if (x1 !== x0 || y1 !== y0) dom.window.dispatchEvent(new dom.window.PointerEvent("pointermove", { clientX: x1, clientY: y1 }));
      dom.window.dispatchEvent(new dom.window.PointerEvent("pointerup", { clientX: x1, clientY: y1 }));
    });
    // 拖球：窗跟着一起走，不算点击
    const before = modes.length;
    await drag(ball()!, 260, 330, 360, 280);
    assert.equal(modes.length, before, "拖动不切换收起 / 展开");
    assert.equal(win()!.style.left, "400px", "窗跟着球走");
    assert.equal(win()!.style.top, "278px");
    assert.equal(ball()!.style.left, "358px");
    assert.equal(ball()!.style.top, "278px");
    // 拖表头：球也跟着走
    const header = win()!.firstElementChild as HTMLElement;
    await drag(header, 500, 290, 450, 340);
    assert.equal(win()!.style.left, "350px");
    assert.equal(ball()!.style.left, "308px");
    assert.equal(ball()!.style.top, "328px");
    // 点球收起（不作废在途），球留在原处；再点展开
    await drag(ball()!, 5, 5, 5, 5);
    assert.equal(modes.at(-1), "min");
    assert.equal(cancelled, 0, "收起不作废在途翻译");
    await act(async () => root.render(h(Panel, props({ mode: "min" }))));
    assert.equal(win(), null, "收起后窗不在");
    assert.ok(ball(), "收起后球还在");
    assert.equal(ball()!.style.left, "308px", "球留在原处");
    assert.equal(ball()!.getAttribute("aria-expanded"), "false");
    // 收着也能拖球换位，展开时窗就在球右边
    await drag(ball()!, 310, 330, 330, 330);
    await drag(ball()!, 5, 5, 5, 5);
    assert.equal(modes.at(-1), "open", "点球展开");
    await act(async () => root.render(h(Panel, props({ mode: "open" }))));
    assert.equal(win()!.style.left, "370px", "窗在球右边展开");
    assert.equal(win()!.style.top, "328px");
    // × 彻底关掉：作废在途、交给上层关；上层关了以后什么都不留
    await act(async () => (dom.window.document.querySelector('[aria-label="关掉译文"]') as HTMLButtonElement).click());
    assert.equal(modes.at(-1), "closed");
    assert.equal(cancelled, 1);
    await act(async () => root.render(h(Panel, props({ mode: "closed" }))));
    assert.equal(win(), null);
    assert.equal(dom.window.document.getElementById("root")!.innerHTML, "", "不留横条、不留球");
    assert.equal(ball(), null, "× 后球一起收掉");
    assert.equal(shown.at(-1), null, "关掉后撤掉原文段标记");
  } finally {
    await act(async () => root.unmount());
    delete (dom.window.HTMLElement.prototype as unknown as Record<string, unknown>).offsetParent;
    for (const [key, desc] of restore) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
