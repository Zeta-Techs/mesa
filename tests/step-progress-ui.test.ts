import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import { PIPELINE_TEMPLATES } from "../src/pipeline-presets.ts";
import { stepFillsAnySlot } from "../src/skill-slots.ts";

test("步骤分组三行：检索、精读、大纲各用自身统计，其他步骤不强加计数，人工决定和主动作保留", async () => {
  const compiled = await build({
    stdin: { contents: "export {createElement,act} from 'react'; export {createRoot} from 'react-dom/client'; export {default as StepFlow} from './src/components/StepFlow';", resolveDir: process.cwd(), loader: "tsx" },
    loader: { ".css": "empty" }, bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    external: ["react", "react-dom/client", "react/jsx-runtime"],
    plugins: [{ name: "host", setup(builder) {
      const stubs: Record<string, string> = {
        asset: 'export default "data:text/javascript,";',
        "../store": "const state={humanTasksTick:0,helpPending:{},terminalRunInputs:{},profiles:[],settings:{},setPendingTerminal(){},setWorkspaceReviewRequest(){},setPage(){},setPreviewReq(){},setHelpViewReq(){}}; export const useAppStore=Object.assign(fn=>fn(state),{getState:()=>state,setState(){},subscribe(){}});",
        "../pipeline-start": "export const buildWorkspaceTerminalRequest=async()=>({});",
        "../md-math": "export const renderMathInto=async()=>{};",
        "@tauri-apps/api/webviewWindow": "export const getCurrentWebviewWindow=()=>({onDragDropEvent:async()=>()=>{}});",
      };
      builder.onResolve({ filter: /.*/ }, (args) => {
        if (/\?(worker|url)$/.test(args.path)) return { path: "asset", namespace: "host-stub" };
        if (!(args.path in stubs)) return undefined;
        if (args.path === "../pipeline-start" && !args.importer.endsWith("/StepFlow.tsx")) return undefined;
        return { path: args.path, namespace: "host-stub" };
      });
      builder.onLoad({ filter: /.*/, namespace: "host-stub" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
    } }],
  });
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
    DOMMatrix: class { multiplySelf() { return this; } preMultiplySelf() { return this; } invertSelf() { return this; } translateSelf() { return this; } scaleSelf() { return this; } multiply() { return this; } inverse() { return this; } },
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const calls: string[] = [];
  const notes = JSON.stringify([
    { id: "a", reviewStatus: "reviewed", fulltextStatus: "fulltext" },
    { id: "b", reviewStatus: "reviewed", fulltextStatus: "abstract-only" },
    { id: "c", reviewStatus: "pending", skimmed: true },
  ]);
  const included = JSON.stringify([{ id: "a", title: "A", decision: "included" }, { id: "b", title: "B", decision: "included" }]);
  Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: { path?: string }) => {
    calls.push(command);
    if (command === "list_human_task_states" || command === "list_skills") return [];
    if (command === "read_research_ledger" || command === "read_file_preview") {
      let text = "# 任务书\n";
      if (args.path?.endsWith("notes/index.json")) text = notes;
      if (args.path?.endsWith("papers/included.json")) text = included;
      if (args.path?.endsWith("outline.md")) text = "# 综述大纲\n\n## 定框架记录\n- Q1: Why?\n  A: Mechanisms\n";
      return { text, truncated: false, readOnlyReason: null, revision: "rev" };
    }
    if (command === "to_fetch_progress") return [];
    return null;
  } } });
  const module = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  const { createElement, act, createRoot, StepFlow } = module.exports;
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  try {
    const exercised = new Set<string>();
    for (const template of PIPELINE_TEMPLATES) {
      for (const step of template.steps) {
        const notesStep = stepFillsAnySlot(step.skills, ["lit-notes"], {});
        const searchStep = stepFillsAnySlot(step.skills, ["lit-search"], {});
        const outlineStep = stepFillsAnySlot(step.skills, ["review-framework"], {});
        await act(async () => root.render(createElement(StepFlow, {
          key: `${template.id}:${step.workspaceName}`, projectPath: "/research/project", step, runStatus: "done", hasDraft: true,
          draft: { relPath: `.ccode/drafts/${step.workspaceName}.md`, exists: true, text: "# 任务书\n" },
          discussed: true, onSeed() {}, onStart() {},
          discussInline: createElement("button", null, "方案研讨"),
          loopActions: createElement("button", { "data-loop": true }, "文件版本"),
        })));
        const agent = host.querySelector('[data-node-key="agent"]');
        if (!agent) continue;
        const headline = agent.querySelector('[data-step-progress="headline"]');
        // 没有统计的步骤不留空统计行（2026-11-13 步骤卡统一设计稿）；按钮一律在工具行
        const detail = agent.querySelector('[data-step-progress="details"]')!;
        assert.ok(agent.querySelector('[data-step-tools="loop"] [data-loop]'), `回头组在工具行：${step.name}`);
        assert.ok(!detail?.querySelector("button"), "统计行不放按钮");
        assert.ok((agent.textContent?.match(/已写笔记/g) ?? []).length <= 1, "总量只显示一次，不在详情里重复");
        if (notesStep) {
          assert.match(headline?.textContent ?? "", /已写笔记 2 篇/);
          assert.match(detail.textContent ?? "", /全文 1.*仅摘要 1.*只速读 1/);
          exercised.add("notes");
          const actions = Array.from(agent.querySelectorAll("button"));
          const discuss = actions.find((button) => button.textContent === "继续讨论");
          assert.ok(discuss, step.name);
          // 统计行（总量 + 分项）在上，工具行（商量 | 回头）在下，总量和分项同一行（2026-11-13 设计稿）
          assert.ok(discuss!.compareDocumentPosition(detail) & dom.window.Node.DOCUMENT_POSITION_PRECEDING);
          assert.ok(detail.contains(headline!));
        } else if (searchStep) {
          assert.match(headline?.textContent ?? "", /纳入 2 篇/);
          assert.match(detail.textContent ?? "", /缺全文 2/);
          exercised.add("search");
        } else if (outlineStep) {
          exercised.add("outline");
          assert.doesNotMatch(agent.textContent ?? "", /已写笔记|纳入 2 篇/);
        } else {
          assert.equal(headline, null, `非文献统计步骤不加空计数：${step.name}`);
          assert.equal(detail, null, `非文献统计步骤不留空统计行：${step.name}`);
          exercised.add("other");
        }
      }
    }
    assert.deepEqual([...exercised].sort(), ["notes", "other", "outline", "search"]);
    // 回头组子节点渲染为空（如刚开工尚无文件版本时 FileVersionsButton 返回 null）时，分隔竖线通过 CSS 选择器一并收起
    const emptyLoopStep = PIPELINE_TEMPLATES[0].steps[0];
    await act(async () => root.render(createElement(StepFlow, {
      key: "empty-loop-check", projectPath: "/research/project", step: emptyLoopStep, runStatus: "active", hasDraft: true,
      draft: { relPath: ".ccode/drafts/s.md", exists: true, text: "# 任务书\n" },
      discussed: true, onSeed() {}, onStart() {},
      loopActions: createElement(() => null),
    })));
    const emptyLoopEl = host.querySelector('[data-step-tools="loop"]')!;
    assert.equal(emptyLoopEl.childElementCount, 0);
    const sepEl = emptyLoopEl.previousElementSibling!;
    assert.match(sepEl.className, /\[&:has\(\+\[data-step-tools=loop\]:empty\)\]:hidden/);
    assert.ok(!calls.some((command) => /merge_workspace|write_task_draft|shell_spawn|pty_write/.test(command)));
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
