import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import { PIPELINE_TEMPLATES } from "../src/pipeline-presets.ts";

// 商量引导气泡：没开工、没商量、任务书没改过时出；点「先不了」后这个项目不再出（按项目记在 localStorage）。
// 研讨那一句另记：第一个带「请几家研讨」的步骤再出一次
test("商量引导气泡：每个项目第一次出，关掉后不再出", async () => {
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
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, localStorage: dom.window.localStorage,
    // pdfjs 模块初始化即 new DOMMatrix()（SCALE_MATRIX 常量）；JSDOM 没有该 API，测试又不渲染 PDF，空壳够用
    DOMMatrix: class { multiplySelf() { return this; } preMultiplySelf() { return this; } invertSelf() { return this; } translateSelf() { return this; } scaleSelf() { return this; } multiply() { return this; } inverse() { return this; } } })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const s = PIPELINE_TEMPLATES.find((t) => t.id === "review")!.steps.find((x) => x.workspaceName === "lit-search")!;
  Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke: async (command: string) => {
    if (command === "list_skills") return [];
    if (command === "read_task_draft") return { relPath: ".ccode/drafts/lit-search.md", text: "" };
    return null;
  } } });
  const module = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  const { createElement: h, act, createRoot, StepFlow } = module.exports;
  const host = dom.window.document.getElementById("root")!;
  let root = createRoot(host);
  const button = (label: string) => Array.from(host.querySelectorAll("button")).find((b) => b.textContent === label);
  const props = {
    projectPath: "/research/her", step: s, runStatus: "pending", hasDraft: false,
    draft: { relPath: ".ccode/drafts/lit-search.md", exists: false, text: "" },
    onSeed() {}, onStart() {}, onDraftChanged() {},
  };
  try {
    const tip = "开始前，先跟 AI 聊几句？";
    const consultLine = "可以再点右边的「请几家研讨」（可选）";
    const withConsult = { ...props, discussInline: h("button", null, "请几家研讨") };
    await act(async () => root.render(h(StepFlow, props)));
    assert.ok(host.textContent!.includes(tip), "第一次应出气泡");
    assert.ok(!host.textContent!.includes(consultLine), "这一步没有研讨链接时气泡不提研讨");
    await act(async () => button("先不了")!.click());
    assert.ok(!host.textContent!.includes(tip));
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(h(StepFlow, props)));
    assert.ok(!host.textContent!.includes(tip), "同一项目关掉后不再出");
    // 第一次走到带「请几家研讨」的步骤：两个按钮第一次一起出现，气泡再出一次、带上研讨那句（2026-11-11 用户）
    await act(async () => root.render(h(StepFlow, withConsult)));
    assert.ok(host.textContent!.includes(tip), "第一个带研讨链接的步骤再出一次");
    assert.ok(host.textContent!.includes(consultLine));
    await act(async () => button("先不了")!.click());
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(h(StepFlow, withConsult)));
    assert.ok(!host.textContent!.includes(tip), "带研讨那句的也关过了，不再出");
    await act(async () => root.render(h(StepFlow, { ...withConsult, projectPath: "/research/other" })));
    assert.ok(host.textContent!.includes(tip) && host.textContent!.includes(consultLine), "换个项目照样出");
    await act(async () => button("先不了")!.click());
    await act(async () => root.render(h(StepFlow, { ...props, projectPath: "/research/other" })));
    assert.ok(!host.textContent!.includes(tip), "在带研讨链接的步骤上关掉，两笔都记，没研讨链接的步骤也不再出");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
