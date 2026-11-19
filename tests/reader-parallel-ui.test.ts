import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

/** 对照栏（2026-11-19）：读文字切段 → 自动翻当前页往后 → 按段显示；没翻成的能重试；PDF 上点一段对照栏接住并画框 */
test("对照栏：切段后自动按批翻译、碎片不翻、失败可重试、PDF 点段落对照栏接住", async () => {
  const bundle = await build({
    stdin: {
      contents: `export {createElement, act, createRef} from 'react';
        export {createRoot} from 'react-dom/client';
        export {default as Pane} from './src/components/ReaderParallelPane';`,
      resolveDir: process.cwd(), loader: "tsx",
    },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
    loader: { ".css": "empty" },
  });
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true, CSS: { escape: (s: string) => s },
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  // JSDOM 没有布局与滚动：滚动只记一下
  const paneScrolls: number[] = [];
  dom.window.HTMLElement.prototype.scrollTo = function (opts?: ScrollToOptions | number) {
    paneScrolls.push(typeof opts === "object" ? (opts?.top ?? 0) : 0);
  } as typeof dom.window.HTMLElement.prototype.scrollTo;
  const compiled = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
  const { createElement: h, act, createRef, createRoot, Pane } = compiled.exports;

  // 假文档：两页，PDF 坐标原点在页底（视口 y = 800 - y）
  const item = (str: string, x: number, y: number) => ({ str, transform: [10, 0, 0, 10, x, 800 - y], width: 400, hasEOL: true });
  const doc = {
    numPages: 2,
    getPage: async (n: number) => ({
      getViewport: () => ({ width: 600, height: 800, convertToViewportPoint: (x: number, y: number) => [x, 800 - y] }),
      getTextContent: async () => ({
        items:
          n === 1
            ? [item("First paragraph about the Volmer step.", 50, 200), item("Second paragraph after a gap, long enough.", 50, 260), item("0.1", 50, 300)]
            : [item("Third paragraph on the next page here.", 50, 200)],
      }),
    }),
  };
  const prompts: string[] = [];
  let fail = true;
  const translate = async (prompt: string) => {
    prompts.push(prompt);
    if (prompt.includes("[[P1]]\nThird paragraph")) {
      if (fail) throw new Error("网络断了");
      return "[[P1]]\n第三段译文";
    }
    return "[[P1]]\n第一段译文 $T_i$\n\n[[P2]]\n第二段译文";
  };
  const marks: unknown[][] = [];
  const scrolls: Array<[number, number]> = [];
  const apiRef = createRef();
  const root = createRoot(dom.window.document.getElementById("root")!);
  const text = () => dom.window.document.getElementById("root")!.textContent ?? "";
  const settle = async () => {
    for (let i = 0; i < 8; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
  };
  try {
    await act(async () =>
      root.render(
        h(Pane, {
          apiRef, doc, pdfPath: "/p/a.pdf", title: "Borides", glossary: [], translate, unavailable: null,
          onMarks: (m: unknown[]) => marks.push(m), onScrollPdf: (p: number, f: number) => scrolls.push([p, f]),
          onClose() {}, roomy: false, onToggleRoom() {},
        }),
      ),
    );
    await settle();
    // 第 1 页两段一批、第 2 页一批；碎片「0.1」不送
    assert.equal(prompts.length, 2, "两页各一批（当前页往后三页都在范围里）");
    assert.ok(prompts[0].includes("[[P1]]\nFirst paragraph") && prompts[0].includes("[[P2]]\nSecond paragraph"));
    assert.ok(!prompts.some((p) => p.includes("[[P3]]")), "碎片不翻");
    assert.ok(prompts[0].includes("论文题名：Borides"));
    assert.match(text(), /第一段译文/);
    assert.match(text(), /第二段译文/);
    assert.equal(dom.window.document.querySelector<HTMLElement>(".md-math")?.dataset.tex, "T_i", "译文公式交 KaTeX");
    assert.match(text(), /没翻成：Error: 网络断了/);
    assert.match(text(), /已译 2 \/ 3 段 · 1 段没翻成/);
    // 重试：只重翻失败的那段
    fail = false;
    const retry = [...dom.window.document.querySelectorAll("button")].find((b) => b.textContent === "重试")!;
    await act(async () => retry.click());
    await settle();
    assert.equal(prompts.length, 3);
    assert.match(text(), /第三段译文/);
    assert.match(text(), /已译 3 \/ 3 段/);
    // PDF 上点第 1 页第二段：对照栏接住、画深色框
    let handled = false;
    await act(async () => {
      handled = apiRef.current.onPointer(1, 0.2, 260 / 800 - 0.005, true);
    });
    assert.equal(handled, true);
    assert.ok(paneScrolls.length > 0, "对照栏把那段滚到中间");
    const last = marks.at(-1) as Array<{ page: number; tone: string }>;
    assert.deepEqual(last.map((m) => [m.page, m.tone]), [[1, "focus"]]);
    assert.equal(apiRef.current.onPointer(1, 0.9, 0.9, true), false, "空白处不接");
    // 对照栏里点一段：PDF 滚到那段
    const para = dom.window.document.querySelector<HTMLElement>('[data-para-id="2:0"]')!;
    await act(async () => para.click());
    assert.deepEqual(scrolls.at(-1)?.[0], 2);
  } finally {
    await act(async () => root.unmount());
    for (const [key, desc] of restore) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
