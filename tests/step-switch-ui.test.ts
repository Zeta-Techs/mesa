import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import { PIPELINE_TEMPLATES } from "../src/pipeline-presets.ts";

// 2026-11-10 用户：科研任务切步骤画面闪一下。StepFlow 按步骤名重新挂载，人工事项状态没回来前整块不渲染；
// 真 useHumanTasks 留着上一次读到的整项目状态，切到读过的项目里任一步都能当场画出来
test("切步骤：人工事项状态还在路上时，流程线照样画出来，不先空一下", async () => {
  const compiled = await build({
    stdin: { contents: `export { createElement, act } from 'react'; export { createRoot } from 'react-dom/client'; export { default as StepFlow } from './src/components/StepFlow';`, resolveDir: process.cwd(), loader: "tsx" },
    loader: { ".css": "empty" },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    external: ["react", "react-dom/client", "react/jsx-runtime"],
    plugins: [{ name: "host-boundaries", setup(b) {
      const stubs: Record<string, string> = {
        asset: "export default \"data:text/javascript,\";",
        "../store": "const state={humanTasksTick:0,helpPending:{},setPendingTerminal(){},setWorkspaceReviewRequest(){},setPage(){},setPreviewReq(){},setHelpViewReq(){}}; export const useAppStore=Object.assign(fn=>fn(state),{getState:()=>state,setState(){},subscribe(){}});",
        "../pipeline-start": "export const buildWorkspaceTerminalRequest=async()=>({});",
        "../md-math": "export const renderMathInto=async()=>{};",
        "@tauri-apps/api/webviewWindow": "export const getCurrentWebviewWindow=()=>({onDragDropEvent:async()=>()=>{}});",
      };
      const anyImporter = new Set(["../md-math", "../store", "@tauri-apps/api/webviewWindow"]);
      b.onResolve({ filter: /.*/ }, (args) => {
        if (/\?(worker|url)$/.test(args.path)) return { path: "asset", namespace: "host-stub" };
        if (!(args.path in stubs)) return undefined;
        if (anyImporter.has(args.path)) return { path: args.path, namespace: "host-stub" };
        return args.importer.replaceAll("\\", "/").endsWith("/StepFlow.tsx")
          ? { path: args.path, namespace: "host-stub" }
          : undefined;
      });
      b.onLoad({ filter: /.*/, namespace: "host-stub" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
    } }],
  });
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
    DOMMatrix: class { multiplySelf() { return this; } preMultiplySelf() { return this; } invertSelf() { return this; } translateSelf() { return this; } scaleSelf() { return this; } multiply() { return this; } inverse() { return this; } } })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const steps = PIPELINE_TEMPLATES.find((t) => t.id === "research-paper")!.steps;
  const [a, b] = steps;
  const all = [a, b].flatMap((s) => (s.humanTasks ?? []).map((t) => ({
    step: s.name, title: t.title, guidance: t.guidance ?? "", target: "", timing: t.timing ?? "before", detected: false, done: false,
  })));
  let pending: Promise<unknown> | null = null;
  Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke: async (command: string) => {
    if (command === "list_human_task_states") return pending ?? all;
    if (command === "list_skills") return [];
    return null;
  } } });
  const module = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  const { createElement: h, act, createRoot, StepFlow } = module.exports;
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  const render = (step: typeof a) => act(async () => root.render(h(StepFlow, {
    key: step.name, projectPath: "/research/project", step, runStatus: "pending", hasDraft: false,
    draft: { relPath: `.ccode/drafts/${step.workspaceName}.md`, exists: false, text: null },
    onSeed() {}, onStart() {},
  })));
  try {
    await render(a);
    assert.ok(host.textContent!.trim().length > 0, "第一步读到事项状态后画出来");
    pending = new Promise(() => {}); // 切过去以后这一轮的读取一直不回来
    await render(b);
    assert.ok(host.textContent!.trim().length > 0, "切到第二步，先用读过的整项目状态画，不空一下");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
