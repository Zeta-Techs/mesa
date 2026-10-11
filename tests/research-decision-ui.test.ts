import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import { PIPELINE_TEMPLATES } from "../src/pipeline-presets.ts";
import { decisionGate, formatDecisionAnswer, parseDecisions } from "../src/step-decisions.ts";

// Render the actual decision UI; stub host boundaries, not decision controls or persistence logic.
test("手写依据 UI：不提供默认批准，保存原文与依据后才满足开工决定", async () => {
  const compiled = await build({
    stdin: { contents: `export { createElement, act } from 'react'; export { createRoot } from 'react-dom/client'; export { default as StepFlow } from './src/components/StepFlow';`, resolveDir: process.cwd(), loader: "tsx" },
    // 组件图里的 monaco 会 import css：Node 测试不渲染样式，按空模块吞掉（css 空了，其中的字体 url 也不会再被解析）
    loader: { ".css": "empty" },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    external: ["react", "react-dom/client", "react/jsx-runtime"],
    plugins: [{ name: "host-boundaries", setup(b) {
      const stubs: Record<string, string> = {
        // Vite 专属的 ?worker/?url 导入（monaco/pdfjs 的 worker）：Node 测试里按空资产桩掉
        // pdfjs 校验 workerSrc 必须是字符串；给个惰性 data: URL，测试不会真起 worker
        asset: "export default \"data:text/javascript,\";",
        "../store": "const state={setPendingTerminal(){},setWorkspaceReviewRequest(){},setPage(){},setPreviewReq(){}}; export const useAppStore=Object.assign(fn=>fn(state),{getState:()=>state,setState(){},subscribe(){}});",
        "./HumanTasksList": "export const useHumanTasks = () => ({states:[],loading:false,error:null,dropHover:null,rowRefs:{current:new Map()},registerOffer:null}); export const RegisterOfferRow=()=>null;",
        "../pipeline-start": "export const buildWorkspaceTerminalRequest=async()=>({});",
        "../md-math": "export const renderMathInto=async()=>{};",
      };
      // 宿主边界对任何导入方都打桩：md-math 真模块会把 katex CSS（含字体 URL）拉进
      // bundle（无字体 loader 即失败）；真 store 在模块作用域读 localStorage，Node 下即崩
      const anyImporter = new Set(["../md-math", "../store"]);
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
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
    // pdfjs 模块初始化即 new DOMMatrix()（SCALE_MATRIX 常量）；JSDOM 没有该 API，测试又不渲染 PDF，空壳够用
    DOMMatrix: class { multiplySelf() { return this; } preMultiplySelf() { return this; } invertSelf() { return this; } translateSelf() { return this; } scaleSelf() { return this; } multiply() { return this; } inverse() { return this; } } })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const s = PIPELINE_TEMPLATES.find((t) => t.id === "research-paper")!.steps.find((s) => s.workspaceName === "exp-run")!;
  let disk = "# 用户自己的任务书\n\n保留此段，不覆盖。\n";
  let changed = 0;
  const calls: string[] = [];
  Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: { content?: string }) => {
    if (command === "list_skills") return []; // useSkillProvides 的环境拉取：吸收，不进序列断言
    calls.push(command);
    if (command === "read_task_draft") return { relPath: ".ccode/drafts/exp-run.md", text: disk };
    if (command === "write_task_draft") { disk = args.content!; return { relPath: ".ccode/drafts/exp-run.md", revision: "rev" }; }
    throw new Error(`unexpected IPC: ${command}`);
  } } });
  const module = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  const { createElement: h, act, createRoot, StepFlow } = module.exports;
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  const buttons = () => Array.from(host.querySelectorAll("button"));
  const button = (label: string) => buttons().find((b) => b.textContent === label)!;
  const render = () => act(async () => root.render(h(StepFlow, {
    projectPath: "/research/project", step: s, runStatus: "pending", hasDraft: true,
    draft: { relPath: ".ccode/drafts/exp-run.md", exists: true, text: disk },
    onSeed() {}, onStart() {}, onDraftChanged() { changed++; },
  })));
  try {
    await render();
    assert.equal(decisionGate(s, disk).blocked, true);
    assert.equal(button("全部用推荐值"), undefined);
    await act(async () => buttons().find((b) => b.textContent?.startsWith("直接选择"))!.click());
    await act(async () => button("写一句…").click());
    assert.ok(button("记下").disabled, "没有填写不得提交空答案");
    const status = host.querySelector<HTMLSelectElement>("select")!;
    await act(async () => {
      status.value = "approve";
      status.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    const input = host.querySelector<HTMLInputElement>('input[placeholder="例如：按已精读笔记写，没全文的只写到摘要"]')!;
    const answer = "批准 design-v3 的范围 A；伦理许可 E-1，证据见人工评阅记录";
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, answer);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(async () => button("记下").click());
    assert.deepEqual(calls, ["read_task_draft", "write_task_draft"]);
    assert.equal(changed, 1);
    assert.ok(disk.includes("保留此段，不覆盖。"));
    assert.equal(parseDecisions(disk).get(s.decisions![0].q), formatDecisionAnswer("approve", answer));
    assert.equal(decisionGate(s, disk).blocked, false);
    await render();
    assert.ok(host.textContent!.includes("可以写"), "父级刷新后显示刚保存的依据，而不是默认同意");
    assert.equal(button("全部用推荐值"), undefined);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
