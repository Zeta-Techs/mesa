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

// 2026-11-23 用户：研究综述任务面板每个步骤切换都会闪烁一下。
// 验证进项目预热 + 模块级缓存后，切步骤在所有新 IPC 挂起不返回时首帧就能直接画到最终态，不先空/闪占位再撑开。
test("切步骤：预热与回切时后续建议、统计行、已补全文、已记下、抽查候选、EndNote 库与裁决列表首帧直接到位", async () => {
  const compiled = await build({
    stdin: {
      contents: `
        export { createElement, act } from 'react';
        export { createRoot } from 'react-dom/client';
        export { default as StepFlow, prefetchStepFlowCaches } from './src/components/StepFlow';
      `,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    loader: { ".css": "empty" },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    external: ["react", "react-dom/client", "react/jsx-runtime"],
    plugins: [{ name: "host-boundaries", setup(b) {
      const stubs: Record<string, string> = {
        asset: "export default \"data:text/javascript,\";",
        "../store": "const state={humanTasksTick:0,helpPending:{},terminalRunInputs:[],profiles:[],settings:{},setPendingTerminal(){},setWorkspaceReviewRequest(){},setPage(){},setPreviewReq(){},setHelpViewReq(){},setSelectProjectReq(){},setFilePreviewReq(){},setSettingsSectionReq(){},setPendingMcpPreset(){},setReaderReq(){},setDiscussCarryReq(){},setStepStartReq(){},requestCloseTab(){}}; export const useAppStore=Object.assign(fn=>fn(state),{getState:()=>state,setState(){},subscribe(){}});",
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
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, localStorage: dom.window.localStorage,
    sessionStorage: dom.window.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true,
    DOMMatrix: class { multiplySelf() { return this; } preMultiplySelf() { return this; } invertSelf() { return this; } translateSelf() { return this; } scaleSelf() { return this; } multiply() { return this; } inverse() { return this; } },
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const steps = PIPELINE_TEMPLATES.find((t) => t.id === "review")!.steps;
  const searchStep = steps[0]!;
  const notesStep = steps[1]!;
  const draftStep = steps[3]!;
  const polishStep = steps[4]!;
  const projectPath = "/research/lit-review-flicker";
  const polishWs = {
    id: "ws-polish",
    name: polishStep.workspaceName,
    worktreePath: `${projectPath}/.ccode/worktrees/${polishStep.workspaceName}`,
    status: "active",
    mergedAt: null,
  };
  const allHumanStates = steps.flatMap((s) => (s.humanTasks ?? []).map((t) => ({
    step: s.name,
    title: t.title,
    guidance: t.guidance ?? "",
    target: t.target ?? "",
    timing: t.timing ?? "after",
    optional: t.optional ?? false,
    detected: false,
    // 检索步「核对待确认篇目」已勾完；精读步「抽查 3 篇笔记」未勾完以验证抽查按钮首帧直出
    done: s.name === searchStep.name && t.title.includes("待确认"),
  })));
  const notesNextJson = JSON.stringify({
    readiness: "ready",
    summary: "精读已完成，可按需补齐少量全文。",
    optional: [
      {
        id: "fetch-core",
        label: "优先补齐 1 篇核心缺全文 PDF",
        action: "fetch_pdf",
        priorityDois: ["10.1000/core1"],
      },
      {
        id: "mem-rule",
        label: "把对照口径记成长期规则",
        action: "remember",
        memoryText: "金属硼酸盐仅作对照，不混入主结论",
      },
      {
        id: "open-angles",
        label: "先看一眼可写点",
        action: "open_file",
        file: "notes/angles.md",
      },
    ],
    handedOff: "已写入 notes/handoff.md。",
  });
  const notesIndexJson = JSON.stringify([
    { id: "p1", notePath: "notes/2025-lu-boride.md", reviewStatus: "reviewed", fulltextStatus: "fulltext" },
    { id: "p2", notePath: "notes/2025-du-boride.md", reviewStatus: "reviewed", fulltextStatus: "abstract-only" },
  ]);
  const toFetchMd = "- [ ] Lu2025 Core Boride Study — https://doi.org/10.1000/core1\n";
  const reportMd = [
    "## 严重问题",
    "",
    "R001 位置：manuscript/final.md:12",
    "问题：摘要数据与正文表格不一致。",
    "",
  ].join("\n");
  const targetJournalMd = "# 目标期刊\n\n期刊：Nature Catalysis\n";
  const cslXml = '<style xmlns="http://purl.org/net/xbiblio/csl"><category citation-format="author-date"/><citation><layout prefix="(" suffix=")"><text variable="author"/></layout></citation></style>';

  let frozen = false;
  const never = new Promise(() => {});
  Object.assign(dom.window, {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: Record<string, any> = {}) => {
        if (frozen) return never;
        if (command === "list_human_task_states") return allHumanStates;
        if (command === "list_skills") return [];
        if (command === "project_memory_read") {
          return { entries: [{ text: "金属硼酸盐仅作对照，不混入主结论", meta: { state: "active" } }] };
        }
        if (command === "to_fetch_progress") return ["Lu2025.pdf"];
        if (command === "endnote_library_legacy") return false;
        if (command === "existing_files") {
          return [{ path: "manuscript/final.md", abs: `${polishWs.worktreePath}/manuscript/final.md` }];
        }
        if (command === "read_file_preview" || command === "read_research_ledger") {
          const p = String(args.path ?? "").replaceAll("\\", "/");
          if (p.endsWith(`.ccode/step-next/${notesStep.workspaceName}.json`)) {
            return { text: notesNextJson, truncated: false, readOnlyReason: null, revision: "r1" };
          }
          if (p.endsWith("notes/index.json")) {
            return { text: notesIndexJson, truncated: false, readOnlyReason: null, revision: "r2" };
          }
          if (p.endsWith("papers/to-fetch.md")) {
            return { text: toFetchMd, truncated: false, readOnlyReason: null, revision: "r3" };
          }
          if (p.endsWith("papers/endnote-library.path")) {
            return { text: "/Users/me/Documents/my-lib.enl\n", truncated: false, readOnlyReason: null, revision: "r4" };
          }
          if (p.endsWith("manuscript/final.md")) {
            return { text: "# Final\n\nBody text.\n", truncated: false, readOnlyReason: null, revision: "r5" };
          }
          if (p.endsWith("submission/target-journal.md")) {
            return { text: targetJournalMd, truncated: false, readOnlyReason: null, revision: "r7" };
          }
          if (p.endsWith("citation.csl")) {
            return { text: cslXml, truncated: false, readOnlyReason: null, revision: "r8" };
          }
          if (p.includes("report")) {
            return { text: reportMd, truncated: false, readOnlyReason: null, revision: "r6" };
          }
          throw new Error(`missing: ${p}`);
        }
        return null;
      },
    },
  });

  const module = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", compiled.outputFiles[0].text)(
    createRequire(import.meta.url),
    module,
    module.exports,
  );
  const { createElement: h, act, createRoot, StepFlow, prefetchStepFlowCaches } = module.exports;
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  const renderStep = (step: typeof notesStep, runStatus: string, ws?: typeof polishWs) =>
    act(async () => {
      root.render(h(StepFlow, {
        key: step.name,
        projectPath,
        step,
        runStatus,
        ws,
        hasDraft: true,
        draft: { relPath: `.ccode/drafts/${step.workspaceName}.md`, exists: true, text: "# TASK\n" },
        onStart() {},
      }));
    });

  try {
    // 1. 模拟进项目停在第 5 步（润色与定稿）并后台预热全部步骤缓存
    await renderStep(polishStep, "active", polishWs);
    await prefetchStepFlowCaches({
      projectPath,
      steps,
      workspaces: [polishWs],
      stepKeys: ["done", "done", "done", "done", "active"],
      skillProvides: {},
    });
    assert.match(host.textContent ?? "", /R001/, "第 5 步初始加载出逐条审查条目");
    assert.match(host.textContent ?? "", /对照文件/, "第 5 步解析出对照文件工具条");
    assert.match(host.textContent ?? "", /Nature Catalysis/, "第 5 步读出目标期刊");

    // 2. 冻结全部 IPC：模拟切步骤瞬间异步请求尚未返回的首帧
    frozen = true;

    // 首次切到第 2 步（精读）：此前从未挂载过，靠预热缓存首帧必须完整落位
    await renderStep(notesStep, "done");
    assert.match(host.querySelector('[data-step-progress="headline"]')?.textContent ?? "", /已写笔记 2 篇/, "统计行首帧即出");
    const nextCard = host.querySelector("[data-step-next-actions]");
    assert.ok(nextCard, "「后续建议」卡片首帧即出，不先空一帧再撑开");
    assert.match(nextCard.textContent ?? "", /后续建议（1）/, "fetch_pdf 与 remember 首帧即判定已自动完成，计数不跳");
    assert.match(nextCard.textContent ?? "", /已补 1\/1/, "已补全文徽标首帧即出");
    assert.match(nextCard.textContent ?? "", /已记下/, "已记进项目知识状态首帧即出");
    assert.match(host.querySelector("[data-spot-check]")?.textContent ?? "", /2025 lu boride/, "抽查候选按钮首帧即出");

    // 首次切到第 4 步（初稿）：EndNote 库行首帧即出
    await renderStep(draftStep, "done");
    assert.match(host.textContent ?? "", /my-lib\.enl/, "EndNote 库说明首帧即出");

    // 切到第 1 步（检索，假设未保存但已核对待确认）：文献清单不先闪开「加载文献清单…」再收起
    await renderStep(searchStep, "review");
    assert.doesNotMatch(host.textContent ?? "", /加载文献清单/, "已核完待确认时首帧即收起，不闪开占位");

    // 回切第 5 步（润色与定稿）：裁决列表、对照文件工具条与引用样式/目标期刊首帧直接到位，不闪占位
    await renderStep(polishStep, "active", polishWs);
    const polishText = host.textContent ?? "";
    assert.doesNotMatch(polishText, /加载条目/, "回切定稿步不闪「加载条目…」占位");
    assert.match(polishText, /R001/, "回切定稿步裁决条目首帧直出");
    assert.match(polishText, /对照文件/, "回切定稿步对照文件工具条首帧直出");
    assert.match(polishText, /Nature Catalysis/, "回切定稿步目标期刊首帧直出，不先闪默认「方括号编号 [1]」");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
