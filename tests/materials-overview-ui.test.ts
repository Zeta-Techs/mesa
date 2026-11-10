import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

/** 资料全貌（2026-11-06 流程贯通 §7）：两步以上开过工才出；有没跟上的或在途补料单时默认展开；停掉链走 rework_chain_stop */
test("资料全貌：一行一份资料、落后写清、在途补料单可停链", async () => {
  const result = await build({
    stdin: {
      contents: `export {createElement,act} from 'react'; export {createRoot} from 'react-dom/client'; export {default as Overview} from './src/components/MaterialsOverview';`,
      resolveDir: process.cwd(), loader: "tsx",
    },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    external: ["react", "react-dom/client", "react/jsx-runtime"],
  });
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const raf = (cb: FrameRequestCallback) => Number(setTimeout(() => cb(Date.now()), 0));
  const saved: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: raf, cancelAnimationFrame: clearTimeout })) {
    saved.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const mod = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", result.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
  const { createElement: h, act, createRoot, Overview } = mod.exports;
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  const invokes: string[] = [];
  let stopped = false;
  const included = JSON.stringify([{ id: "a", decision: "included", pdf: "papers/a.pdf" }, { id: "b", decision: "included" }]);
  const index = JSON.stringify([{ id: "a", reviewStatus: "reviewed", fulltextStatus: "fulltext" }]);
  Object.assign(dom.window, {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: Record<string, string>) => {
        invokes.push(command);
        if (command === "read_research_ledger") return { text: String(args.path).endsWith("included.json") ? included : index, truncated: false };
        if (command === "rework_list") {
          return [{ id: "r1", fromStep: "综述大纲", toStep: "文献检索与筛选", sentAt: "2026-11-06T01:00:00Z", chain: ["文献精读与笔记"], chainState: { started: [], stopped }, topics: ["x"], reason: "y", clues: "", scale: null, toWorkspaceId: "w1", toWorkspaceName: "lit-search", relPath: "" }];
        }
        if (command === "rework_chain_stop") { stopped = true; return null; }
        throw new Error(command);
      },
    },
  });
  const ws = (name: string, mergedAt: string | null, staleUpstream: string | null = null) => ({ id: name, name, mergedAt, staleUpstream, status: "active" });
  const steps = [
    { name: "文献检索与筛选", workspaceName: "lit-search", skills: ["lit-search"] },
    { name: "文献精读与笔记", workspaceName: "lit-notes", skills: ["lit-notes"] },
    { name: "综述大纲", workspaceName: "outline", skills: [] },
  ];
  const provides = { "lit-search": ["lit-search"], "lit-notes": ["lit-notes"] };
  const focused: number[] = [];
  const render = (statuses: unknown[], refreshKey = "1") =>
    act(async () => root.render(h(Overview, { projectPath: "/p", steps, statuses, provides, focusIndex: 2, onFocus: (i: number) => focused.push(i), refreshKey })));
  try {
    // 只有一步开过工：不出
    await render([{ key: "done", ws: ws("lit-search", "2026-11-05T00:00:00Z") }, { key: "pending" }, { key: "pending" }]);
    assert.equal(host.textContent, "");
    // 检索在补（进行中）、精读已保存但落后：默认展开
    await render([
      { key: "active", ws: ws("lit-search", "2026-11-05T00:00:00Z") },
      { key: "done", ws: ws("lit-notes", "2026-11-05T02:00:00Z", "文献检索与筛选") },
      { key: "active", ws: ws("outline", null) },
    ], "2");
    const text = host.textContent ?? "";
    assert.match(text, /资料全貌/);
    // 折起行直接说哪一步没对齐、为什么（精读：纳入 2 篇、索引里只有 1 篇 → 新纳入 1 篇没读，压过「落后于」），旁边「去这一步」
    assert.match(text, /「文献精读与笔记」新纳入 1 篇没读 · 1 张补料单在途去这一步/);
    assert.match(text, /文献检索与筛选 · 文献库进行中纳入 2 篇 · 已有全文 1 · 缺全文 1/);
    assert.match(text, /已写笔记 1 \/ 1 篇/);
    assert.doesNotMatch(text, /已对齐/, "对齐时不写字");
    assert.match(text, /补料单「综述大纲」→「文献检索与筛选」（11-0[67] 发出）：在补 · 补完保存后接着跟进「文献精读与笔记」/);
    // 点步骤名跳过去
    await act(async () => ([...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith("文献精读与笔记")) as HTMLButtonElement).click());
    assert.deepEqual(focused, [1]);
    await act(async () => ([...host.querySelectorAll("button")].find((b) => b.textContent === "去这一步") as HTMLButtonElement).click());
    assert.deepEqual(focused, [1, 1]);
    // 停掉这条链
    await act(async () => ([...host.querySelectorAll("button")].find((b) => b.textContent === "停掉这条链") as HTMLButtonElement).click());
    assert.ok(invokes.includes("rework_chain_stop"));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});
