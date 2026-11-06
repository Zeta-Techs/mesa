import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

/** 退回弹层按目标换说法（2026-11-06）：退回检索 / 精读叫「补料」、问篇数；退回大纲 / 初稿叫「修改」、不问篇数、不带篇数 */
test("退回弹层：退回文献步骤叫补料问篇数，退回大纲叫修改不问篇数", async () => {
  const bundle = await build({
    stdin: {
      contents: `export {createElement, act} from 'react';
        export {createRoot} from 'react-dom/client';
        export {ReworkDialog} from './src/components/StepLoop';`,
      resolveDir: process.cwd(), loader: "tsx",
    },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
  });
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0), cancelAnimationFrame: (id: number) => clearTimeout(id),
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const compiled = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
  const { createElement: h, act, createRoot, ReworkDialog } = compiled.exports;
  const root = createRoot(dom.window.document.getElementById("root")!);
  const sent: Array<Record<string, unknown>> = [];
  const body = () => dom.window.document.body.textContent ?? "";
  const button = (label: string) => [...dom.window.document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  const setValue = (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => {
    const proto = Object.getPrototypeOf(el);
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new dom.window.Event(el instanceof dom.window.HTMLSelectElement ? "change" : "input", { bubbles: true }));
  };
  try {
    // 初稿退回：最近的上一步是大纲（不是文献步骤）
    await act(async () => root.render(h(ReworkDialog, {
      fromStep: "综述初稿", targets: ["综述大纲", "文献精读与笔记", "文献检索与筛选"],
      litTargets: ["文献精读与笔记", "文献检索与筛选"], busy: false, error: null,
      onCancel() {}, onSend: (f: Record<string, unknown>) => sent.push(f),
    })));
    assert.match(body(), /退回上一步修改/);
    assert.match(body(), /再点「跟进上游的新增」接上/, "已保存的步骤发起：之后点跟进");
    assert.match(body(), /要改的地方/);
    assert.doesNotMatch(body(), /补多少篇/);
    const area = dom.window.document.querySelector("textarea")!;
    const input = dom.window.document.querySelector<HTMLInputElement>("input:not([inputmode])")!;
    await act(async () => { setValue(area, "§3 先讲机理"); setValue(input, "读者看不出取舍"); });
    await act(async () => button("退回去改")!.click());
    assert.deepEqual(sent.at(-1), { target: "综述大纲", topics: ["§3 先讲机理"], reason: "读者看不出取舍", clues: "", scale: null });
    // 换到检索：叫补料、问篇数
    await act(async () => setValue(dom.window.document.querySelector("select")!, "文献检索与筛选"));
    assert.match(body(), /退回上一步补料/);
    assert.match(body(), /大致补多少篇/);
    assert.ok(button("退回去补"));
    // 做到一半发起：说明之后点「继续」会先并进来，不用先保存
    await act(async () => root.render(h(ReworkDialog, {
      key: "in-progress",
      fromStep: "综述大纲", targets: ["文献精读与笔记"], litTargets: ["文献精读与笔记"], fromInProgress: true,
      busy: false, error: null, onCancel() {}, onSend() {},
    })));
    assert.match(body(), /在「综述大纲」点「继续」，会先把补来的并进来再接着做（这一步不用先保存）/);
  } finally {
    await act(async () => root.unmount());
    for (const [key, desc] of restore) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
