import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

/** 下拉里「补文献」那一项的值（StepLoop.tsx LIT） */
const LIT = "\u0000lit";

async function mount() {
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
  const doc = dom.window.document;
  return {
    h, act, root, ReworkDialog, doc,
    body: () => doc.body.textContent ?? "",
    button: (label: string) => [...doc.querySelectorAll("button")].find((b) => b.textContent?.trim() === label),
    areas: () => [...doc.querySelectorAll("textarea")],
    boxes: () => [...doc.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')],
    reasonInput: () => doc.querySelector<HTMLInputElement>("input:not([inputmode]):not([type=checkbox])")!,
    setValue: (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
      el.dispatchEvent(new dom.window.Event(el instanceof dom.window.HTMLSelectElement ? "change" : "input", { bubbles: true }));
    },
    async cleanup() {
      await act(async () => root.unmount());
      for (const [key, desc] of restore) {
        if (desc) Object.defineProperty(globalThis, key, desc);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}

const LIT_PROPS = { searchTarget: "文献检索与筛选", notesTarget: "文献精读与笔记" };

/** 退回弹层按目标换说法：检索、精读并成「补文献」两栏（2026-11-11 按大纲的节转回路①）；退回大纲 / 初稿叫「修改」、不问篇数 */
test("退回弹层：退回大纲叫修改不问篇数；补文献两栏，找新文献才问篇数", async () => {
  const m = await mount();
  const sent: Array<Record<string, unknown>> = [];
  try {
    // 初稿退回：最近的上一步是大纲（不是文献步骤）
    await m.act(async () => m.root.render(m.h(m.ReworkDialog, {
      fromStep: "综述初稿", targets: ["综述大纲", "文献精读与笔记", "文献检索与筛选"], ...LIT_PROPS,
      busy: false, error: null, onCancel() {}, onSend: (f: Record<string, unknown>) => sent.push(f),
    })));
    assert.match(m.body(), /退回上一步修改/);
    assert.match(m.body(), /要改的地方/);
    assert.doesNotMatch(m.body(), /大致补多少篇/);
    // 检索、精读在下拉里并成一项
    assert.deepEqual([...m.doc.querySelectorAll("option")].map((o) => o.textContent), ["综述大纲", "补文献（找新文献 / 精读已有的）"]);
    await m.act(async () => { m.setValue(m.areas()[0], "§3 先讲机理"); m.setValue(m.reasonInput(), "读者看不出取舍"); });
    await m.act(async () => m.button("退回去改")!.click());
    assert.deepEqual(sent.at(-1), { target: "综述大纲", topics: ["§3 先讲机理"], reason: "读者看不出取舍", clues: "", scale: null, chain: [], reads: [] });
    // 换到补文献：分段切换（找新文献 / 精读已有的 / 两样一起补），默认停在「找新文献」
    await m.act(async () => m.setValue(m.doc.querySelector("select")!, LIT));
    assert.match(m.body(), /^补文献/);
    assert.match(m.body(), /找什么新文献/);
    assert.ok(m.button("找新文献"));
    assert.ok(m.button("精读已有的"));
    assert.ok(m.button("两样一起补"));
    assert.ok(m.button("退回去补"));
    // 做到一半发起：说明之后点「继续」会先并进来
    await m.act(async () => m.root.render(m.h(m.ReworkDialog, {
      key: "in-progress",
      fromStep: "综述大纲", targets: ["文献精读与笔记"], notesTarget: "文献精读与笔记", fromInProgress: true,
      busy: false, error: null, onCancel() {}, onSend() {},
    })));
    assert.match(m.body(), /在「综述大纲」点「继续」接着做/);
    assert.doesNotMatch(m.body(), /找什么新文献/, "上游没有检索就没有找新文献栏");
  } finally {
    await m.cleanup();
  }
});

test("补文献：切「精读已有的」退回精读；切「两样一起补」退回检索、精读那几条随单走、链上锁定精读", async () => {
  const m = await mount();
  const sent: Array<Record<string, unknown>> = [];
  try {
    await m.act(async () => m.root.render(m.h(m.ReworkDialog, {
      fromStep: "综述大纲", targets: ["文献精读与笔记", "文献检索与筛选"], ...LIT_PROPS,
      chainOptions: { "文献精读与笔记": ["综述大纲"], "文献检索与筛选": ["文献精读与笔记", "综述大纲"] },
      busy: false, error: null, onCancel() {}, onSend: (f: Record<string, unknown>) => sent.push(f),
    })));
    assert.equal(m.doc.querySelector("select"), null, "只有检索、精读两个上游时没有下拉");
    assert.match(m.body(), /执行路径/);
    // 默认停在「找新文献」：执行路径含检索 → 精读、大纲
    assert.deepEqual(m.boxes().map((b) => b.checked), [true, true]);
    // 切到「精读已有的」：只勾选大纲
    await m.act(async () => m.button("精读已有的")!.click());
    assert.deepEqual(m.boxes().map((b) => b.checked), [true], "只精读：精读之后只有大纲，默认勾上");
    await m.act(async () => { m.setValue(m.areas()[0], "4.3：[@Su2025]"); });
    // 展开更多选项填理由
    const moreBtn = [...m.doc.querySelectorAll("button")].find((b) => b.textContent?.includes("更多选项"))!;
    await m.act(async () => moreBtn.click());
    await m.act(async () => m.setValue(m.reasonInput(), "4.3 可写正文只有 2 篇"));
    await m.act(async () => m.button("退回去补")!.click());
    assert.deepEqual(sent.at(-1), {
      target: "文献精读与笔记", topics: ["4.3：[@Su2025]"], reads: [], chain: ["综述大纲"],
      reason: "4.3 可写正文只有 2 篇", clues: "", scale: null,
    });
    // 切到「两样一起补」再写找新文献：退回目标换成检索，链按检索给默认，精读锁定勾上
    await m.act(async () => m.button("两样一起补")!.click());
    await m.act(async () => m.setValue(m.areas()[0], "4.3 界面稳定性：2024 年以后"));
    assert.deepEqual(m.boxes().map((b) => [b.checked, b.disabled]), [[true, true], [true, false]]);
    await m.act(async () => m.boxes()[1].click());
    await m.act(async () => m.setValue(m.doc.querySelector<HTMLInputElement>("input[inputmode]")!, "8"));
    await m.act(async () => m.button("退回去补")!.click());
    assert.deepEqual(sent.at(-1), {
      target: "文献检索与筛选", topics: ["4.3 界面稳定性：2024 年以后"], reads: ["4.3：[@Su2025]"], chain: ["文献精读与笔记"],
      reason: "4.3 可写正文只有 2 篇", clues: "", scale: 8,
    });
  } finally {
    await m.cleanup();
  }
});

test("补文献：覆盖检查双栏预填自动停在「两样一起补」；单目标预填停在对应 Tab", async () => {
  const m = await mount();
  try {
    await m.act(async () => m.root.render(m.h(m.ReworkDialog, {
      fromStep: "综述大纲", targets: ["文献精读与笔记", "文献检索与筛选"], ...LIT_PROPS,
      prefill: {
        "文献检索与筛选": { topics: "3.2 失活：原位表征", reason: "3.2 薄" },
        "文献精读与笔记": { topics: "4.3：[@Xu2019]", reason: "4.3 薄" },
      },
      busy: false, error: null, onCancel() {}, onSend() {},
    })));
    assert.deepEqual(m.areas().slice(0, 2).map((a) => a.value), ["3.2 失活：原位表征", "4.3：[@Xu2019]"]);
    assert.equal(m.reasonInput().value, "3.2 薄；4.3 薄");
    await m.act(async () => m.root.render(m.h(m.ReworkDialog, {
      key: "assistant",
      fromStep: "项目助手", targets: ["综述大纲", "文献精读与笔记", "文献检索与筛选"], ...LIT_PROPS,
      initial: { target: "文献检索与筛选", topics: "更新检索：11-01 以来", reason: "投稿前", clues: "", scale: null },
      busy: false, error: null, onCancel() {}, onSend() {},
    })));
    assert.equal((m.doc.querySelector("select") as HTMLSelectElement).value, LIT);
    assert.equal(m.areas()[0].value, "更新检索：11-01 以来");
  } finally {
    await m.cleanup();
  }
});

test("补文献：左栏展示大纲章节速览（点选即填入）、待读全文显示作者年份标题（非乱码 key）、理由可留空", async () => {
  const m = await mount();
  const sent: Array<Record<string, unknown>> = [];
  try {
    await m.act(async () => m.root.render(m.h(m.ReworkDialog, {
      fromStep: "综述大纲", targets: ["文献精读与笔记", "文献检索与筛选"], ...LIT_PROPS,
      chainOptions: { "文献精读与笔记": ["综述大纲"], "文献检索与筛选": ["文献精读与笔记", "综述大纲"] },
      outlineSections: [
        { num: "2", label: "2. 界面重构机理", level: 2, writable: 12, hint: 3, latest: "2026", verdict: "够" },
        { num: "2.1", label: "2.1 阴极脱硼", level: 3 },
      ],
      pendingPapers: [
        { bibKey: "zotero1zxcq6wjv", author: "Zhang", year: "2024", venue: "Nano Energy", title: "3D Boride Monolithic Electrode" },
      ],
      busy: false, error: null, onCancel() {}, onSend: (f: Record<string, unknown>) => sent.push(f),
    })));
    assert.match(m.body(), /大纲章节/);
    assert.match(m.body(), /可写 12/);
    // 默认停在「找新文献」，点左侧小节直接填入并可发出
    const secBtn = [...m.doc.querySelectorAll("button")].find((b) => b.textContent?.includes("2.1 阴极脱硼"))!;
    await m.act(async () => secBtn.click());
    assert.equal(m.areas()[0].value, "2.1 阴极脱硼：");
    assert.equal(m.button("退回去补")!.disabled, false);
    // 切到「精读已有的」：显示作者/年份/期刊/标题，不把 @zotero 哈希当主标题
    const readTab = [...m.doc.querySelectorAll("button")].find((b) => b.textContent?.startsWith("精读已有的"))!;
    await m.act(async () => readTab.click());
    assert.match(m.body(), /Zhang \(2024\) Nano Energy/);
    assert.match(m.body(), /3D Boride Monolithic Electrode/);
    const paperBtn = [...m.doc.querySelectorAll("button")].find((b) => b.textContent?.includes("3D Boride Monolithic Electrode"))!;
    await m.act(async () => paperBtn.click());
    assert.equal(m.areas()[0].value, "[@zotero1zxcq6wjv]");
    await m.act(async () => m.button("退回去补")!.click());
    assert.equal(sent.at(-1)?.target, "文献精读与笔记");
    assert.equal(sent.at(-1)?.reason, "补充精读已纳入待读全文");
  } finally {
    await m.cleanup();
  }
});
