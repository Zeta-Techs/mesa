import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { PIPELINE_TEMPLATES } from "../src/pipeline-presets.ts";

const INCLUDED = JSON.stringify([
  { id: "doi:1", title: "Solvating magnesium polysulfide", decision: "included", reason: "题目针对可充电 Mg-S" },
  { id: "doi:2", title: "Neighboring system paper", decision: "pending", reason: "相邻体系待确认" },
]);
const SCREENING = `# 筛选
## 验收摘要
1. 回答了什么：完成 Mg-S 检索与筛选。
5. 需要人决定：确认 pending 项；获取付费全文；如需写 Zotero 库须另行明确授权。
## 质量状态
已生成待审。
`;
const TO_FETCH = `1. Paywalled paper — 10.1000/xyz
`;

test("审阅摘要只出示计数和筛选决定，不摊纳入表", async () => {
  const bundle = await build({
    stdin: { contents: `export {createElement,act} from 'react'; export {createRoot} from 'react-dom/client'; export {default as Panel} from './src/components/ScreeningReviewPanel';`, resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    external: ["react", "react-dom/client", "react/jsx-runtime", "@tauri-apps/api/core", "@tauri-apps/plugin-opener"],
  });
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: any) => {
    if (command === "list_dir") return [];
    if (command !== "read_file_preview") throw new Error(command);
    assert.equal(args.requireWithinRoot, true);
    if (String(args.path).endsWith("included.json")) return { text: INCLUDED, truncated: false, revision: "j1" };
    if (String(args.path).endsWith("to-fetch.md")) return { text: TO_FETCH, truncated: false, revision: "t1" };
    if (String(args.path).endsWith("screening.md")) return { text: SCREENING, truncated: false, revision: "s1" };
    if (String(args.path).endsWith("included.md")) return { text: "- paper", truncated: false, revision: "m1" };
    throw new Error(String(args.path));
  } } });
  const mod = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
  const { createElement: h, act, createRoot, Panel } = mod.exports;
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  try {
    await act(async () => root.render(h(Panel, { root: "/tree" }, h("p", null, "筛选决定槽"))));
    assert.match(host.textContent!, /纳入 1 · 待确认 1 · 待获取 1 · 共 2 篇/);
    assert.match(host.textContent!, /Neighboring system paper/);
    assert.ok([...host.querySelectorAll("button")].some((b) => b.textContent === "纳入"));
    const excludePicked = [...host.querySelectorAll("button")].find((b) => b.textContent === "排除所选");
    const tools = excludePicked?.parentElement?.querySelector(":scope > .ml-auto");
    assert.ok(tools, "指标表状态和排序跟在排除所选右侧");
    assert.match(tools!.textContent ?? "", /排序/);
    assert.equal(tools!.querySelector("select")?.value, "listed");
    assert.doesNotMatch(host.textContent!, /验收摘要与未决项/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, d] of restore) {
      if (d) Object.defineProperty(globalThis, key, d);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("检索步评审先出待确认与筛选决定，不重复摊 included.md", async () => {
  const bundle = await build({
    stdin: { contents: `export {createElement,act} from 'react'; export {createRoot} from 'react-dom/client'; export {default as Review} from './src/components/WorkspaceReviewView';`, resolveDir: process.cwd(), loader: "tsx" },
    // WorkspaceReviewView 的图里有 monaco/katex 的 css：Node 测试不渲染样式，按空模块吞掉
    loader: { ".css": "empty" },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    external: ["react", "react-dom/client", "react/jsx-runtime"],
    plugins: [{ name: "host", setup(b) {
      b.onResolve({ filter: /^\.\.\/store$/ }, () => ({ path: "store", namespace: "stub" }));
      b.onResolve({ filter: /^\.\/ArtifactChecklist$/ }, () => ({ path: "artifacts", namespace: "stub" }));
      b.onResolve({ filter: /^\.\/WatchRunReview$/ }, () => ({ path: "watch", namespace: "stub" }));
      b.onResolve({ filter: /^\.\/OfficePreviewModal$/ }, () => ({ path: "preview", namespace: "stub" }));
      b.onResolve({ filter: /^\.\/ConfirmDialog$/ }, () => ({ path: "confirm", namespace: "stub" }));
      // Vite 专属的 ?worker/?url 导入（monaco/pdfjs 的 worker）：Node 测试里按空资产桩掉
      b.onResolve({ filter: /\?(worker|url)$/ }, () => ({ path: "asset", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
        loader: "js",
        contents: args.path === "asset" ? "export default \"data:text/javascript,\";"
          : args.path === "confirm" ? "export const confirmDialog=async()=>true;"
          : args.path === "store" ? "export const useAppStore=Object.assign(fn=>fn(globalThis.__reviewStore),{getState:()=>globalThis.__reviewStore});"
          : args.path === "artifacts" ? "export const loadArtifactRows=async()=>[];"
          : "export default function Watch(){return null;}",
      }));
    } }],
  });
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  class FakeObserver { observe() {} disconnect() {} unobserve() {} takeRecords() { return []; } }
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, localStorage: dom.window.localStorage,
    sessionStorage: dom.window.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true,
    IntersectionObserver: FakeObserver,
    // pdfjs 模块初始化即 new DOMMatrix()（SCALE_MATRIX 常量）；JSDOM 没有该 API，测试又不渲染 PDF，空壳够用
    DOMMatrix: class { multiplySelf() { return this; } preMultiplySelf() { return this; } invertSelf() { return this; } translateSelf() { return this; } scaleSelf() { return this; } multiply() { return this; } inverse() { return this; } },
    requestAnimationFrame: (fn: () => void) => { fn(); return 0; },
    cancelAnimationFrame: () => {},
    __reviewStore: { setPage() {}, setSelectProjectReq() {}, setFilePreviewReq() {}, setPendingTerminal() { throw new Error("no run expected"); }, runningScripts: {} },
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const step = PIPELINE_TEMPLATES.flatMap((t) => t.steps).find((s) => s.workspaceName === "lit-search")!;
  const files = [
    { path: "papers/included.json", status: "A", additions: 908, deletions: 0 },
    { path: "papers/screening.md", status: "A", additions: 200, deletions: 0 },
    { path: "scripts/build_outputs.py", status: "A", additions: 40, deletions: 0 },
    { path: "papers/included.md", status: "A", additions: 80, deletions: 0 },
    { path: "papers/to-fetch.md", status: "A", additions: 12, deletions: 0 },
  ];
  Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: any) => {
    if (command === "workspace_diff") return { inWorkspace: true, workspaceId: "w", workspaceName: "lit-search", branch: "ccode/lit-search", reviewOnly: false, baseBranch: "master", mergeBase: "abc", files, totalAdd: 3462, totalDel: 0, worktreePath: "/tree" };
    if (command === "git_status") return { isRepo: true, branch: "ccode/lit-search", ahead: 1, behind: 0, files: [], totalAdd: 0, totalDel: 0 };
    if (command === "workspace_health") return { conflict: false, uncommitted: false, mainDirty: true, mainOffBase: false, readyToMerge: false, worktreeHead: "a".repeat(40), ahead: 1, behind: 0 };
    if (command === "workspace_review_deliverables") return { token: "frozen", workspaceId: "w", projectRoot: "/project", payloadDir: "/frozen", files: [] };
    if (command === "workspace_unmerged_files") return { merging: false, files: [], staleBase: false };
    if (command === "list_workspaces") return [{ id: "w", name: "lit-search", status: "active", repoPath: "/project", worktreePath: "/tree", mergedAt: null }];
    if (command === "read_project_config") return { config: { steps: [step], resources: [], artifactDir: "artifacts" } };
    if (command === "check_citation_health") return { bibFound: false, totalRefs: 0, resolved: 0, missing: [] };
    if (command === "workspace_settings") return { run: [], runMode: "nonconcurrent" };
    if (command === "list_human_task_states" || command === "list_dir") return [];
    if (command === "research_get_acceptance") return null;
    if (command === "research_source") return { root: "/tree", projectId: "p", resultVersion: "v1", revision: "source-v1", warnings: [] };
    if (command === "research_get_run") throw new Error("no run");
    if (command === "workspace_file_diff") return `diff --git a/${args.path} b/${args.path}\n--- a/${args.path}\n+++ b/${args.path}\n@@ -0,0 +1 @@\n+ok\n`;
    if (command === "read_file_preview") {
      const path = String(args.path);
      if (path.endsWith("included.json")) return { text: INCLUDED, truncated: false, revision: "j1" };
      if (path.endsWith("to-fetch.md")) return { text: TO_FETCH, truncated: false, revision: "t1" };
      if (path.endsWith("screening.md")) return { text: SCREENING, truncated: false, revision: "s1" };
      if (path.endsWith("included.md")) return { text: "- paper", truncated: false, revision: "m1" };
      return { text: "", truncated: false, revision: "x" };
    }
    throw new Error(command);
  } } });
  const module = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  const { createElement: h, act, createRoot, Review } = module.exports;
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  try {
    await act(async () => root.render(h(Review, { worktreePath: "/tree", onClose() {} })));
    assert.match(host.textContent!, /清单/);
    assert.match(host.textContent!, /过程/);
    assert.match(host.textContent!, /文件/);
    assert.match(host.textContent!, /papers\/included\.md/);
    assert.doesNotMatch(host.textContent!, /给精读留一句/);
    const listTab = [...host.querySelectorAll("button")].find((b) => b.textContent === "清单");
    assert.ok(listTab);
    await act(async () => listTab!.click());
    assert.match(host.textContent!, /Neighboring system paper/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, d] of restore) {
      if (d) Object.defineProperty(globalThis, key, d);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
