import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// 设置「研究档案」分区：生效状态三态、开关、AI 拿到的原文、三者区别说明、按分类的例句、新增走后端
const bundle = await build({
  stdin: {
    contents: `export {createElement} from 'react';
      export {act} from 'react';
      export {createRoot} from 'react-dom/client';
      export {default as ResearchProfileSection} from './src/components/ResearchProfileSection';`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  jsx: "automatic",
  external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
  plugins: [
    {
      name: "profile-host",
      setup(builder) {
        const stubs: Record<string, string> = {
          "@tauri-apps/api/core": "export const invoke = (...args) => window.__profile.invoke(...args);",
        };
        builder.onResolve({ filter: /.*/ }, (args) => (args.path in stubs ? { path: args.path, namespace: "stub" } : undefined));
        builder.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
      },
    },
  ],
});

const CATEGORIES = ["研究方向", "常用方法", "数据处理习惯", "写作偏好", "导师意见", "放弃的方向", "其他"];
const entry = (id: string, category: string, text: string, state = "active") => ({
  meta: { id, createdAt: "2026-11-07", goalName: category, state, reason: "导师要求" },
  text,
});

async function mount(initial: { inject: boolean; entries: ReturnType<typeof entry>[]; context: string }) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const state = { ...initial };
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  (dom.window as unknown as Record<string, unknown>).__profile = {
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      calls.push({ cmd, args });
      switch (cmd) {
        case "research_profile_read":
          return {
            doc: { revision: "r1", legacyText: "", entries: state.entries },
            settings: { inject: state.inject },
            categories: CATEGORIES,
            context: state.context,
          };
        case "research_profile_suggestions":
          return [];
        case "research_profile_set_inject":
          state.inject = args.inject as boolean;
          return null;
        case "research_profile_update":
          state.entries = [...state.entries, entry("new", args.category as string, args.text as string)];
          state.context = `研究者档案（跨项目…）：\n- ${args.category}：${args.text}`;
          return null;
        case "research_profile_papers":
          return [];
        default:
          throw new Error(`桩未覆盖的命令：${cmd}`);
      }
    },
  };
  const req = createRequire(import.meta.url);
  const mod = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(req, mod, mod.exports);
  const { createElement, act, createRoot, ResearchProfileSection } = mod.exports;
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  const settle = async () => {
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  await act(async () => root.render(createElement(ResearchProfileSection)));
  await settle();
  const text = () => host.textContent ?? "";
  const button = (name: string) =>
    [...host.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").includes(name)) as HTMLButtonElement | undefined;
  const click = async (el: Element | undefined) => {
    assert.ok(el, "找不到要点的元素");
    await act(async () => (el as HTMLElement).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    await settle();
  };
  const type = async (el: HTMLInputElement | HTMLSelectElement, value: string) => {
    const proto = el instanceof dom.window.HTMLSelectElement ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
      el.dispatchEvent(new dom.window.Event(el instanceof dom.window.HTMLSelectElement ? "change" : "input", { bubbles: true }));
    });
    await settle();
  };
  return {
    host, text, button, click, type, calls, state,
    close: async () => {
      await act(async () => root.unmount());
      for (const [key, desc] of restore) {
        if (desc) Object.defineProperty(globalThis, key, desc);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}

test("空档案：写明 AI 拿不到，区别说明默认展开，没有原文入口；记一条后变成生效并能看原文", async () => {
  const ui = await mount({ inject: true, entries: [], context: "" });
  try {
    assert.match(ui.text(), /还没有条目：AI 现在什么也拿不到/);
    assert.match(ui.text(), /只对一个项目成立/, "档案空着时区别说明默认展开");
    assert.equal(ui.button("看 AI 拿到的原文"), undefined);
    // 分类例句随分类换
    const select = ui.host.querySelector("select") as HTMLSelectElement;
    const input = ui.host.querySelectorAll("input")[0] as HTMLInputElement;
    await ui.type(select, "写作偏好");
    assert.match(input.placeholder, /少用被动句/);
    await ui.type(input, "段首先给结论");
    await ui.type(ui.host.querySelectorAll("input")[1] as HTMLInputElement, "导师在组会上要求");
    await ui.click(ui.button("记下"));
    const add = ui.calls.find((c) => c.cmd === "research_profile_update");
    assert.deepEqual(
      { action: add?.args.action, category: add?.args.category, text: add?.args.text },
      { action: "add", category: "写作偏好", text: "段首先给结论" },
    );
    assert.match(ui.text(), /正在生效：1 条会附给 AI/);
    await ui.click(ui.button("看 AI 拿到的原文"));
    assert.match(ui.host.querySelector("pre")?.textContent ?? "", /写作偏好：段首先给结论/);
  } finally {
    await ui.close();
  }
});

test("有条目：开关关掉写「已关」并调后端，区别说明默认收起；作废的条目不算数", async () => {
  const ui = await mount({
    inject: true,
    entries: [entry("a", "常用方法", "阻抗谱用等效电路拟合"), entry("b", "其他", "旧条目", "revoked")],
    context: "研究者档案（跨项目…）：\n- 常用方法：阻抗谱用等效电路拟合",
  });
  try {
    assert.match(ui.text(), /正在生效：1 条会附给 AI/);
    assert.doesNotMatch(ui.text(), /只对一个项目成立/, "有条目时区别说明收起");
    const toggle = ui.host.querySelector('[role="switch"]') as HTMLButtonElement;
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    await ui.click(toggle);
    assert.deepEqual(ui.calls.find((c) => c.cmd === "research_profile_set_inject")?.args, { inject: false });
    assert.match(ui.text(), /已关：1 条都不会附给 AI/);
    await ui.click(ui.button("有什么不同"));
    assert.match(ui.text(), /附在你第一句前面的那段话/);
    assert.match(ui.text(), /不附给 AI，也不改任何项目/, "文献总表写明只给你查");
  } finally {
    await ui.close();
  }
});
