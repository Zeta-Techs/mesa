import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";

// 在内存中编译组件；仅模拟 Tauri 边界，不打开桌面应用或真实用户目录。
// 口径：评审页只列这次运行的新命中；排除在采纳时不写进项目；已采纳的运行只读回看。
test("定时评审：新命中列表、留下/排除、采纳确认与已采纳只读态", async () => {
  const built = await build({
    stdin: {
      contents: `export { createElement, act } from 'react'; export { createRoot } from 'react-dom/client'; export { default as Review } from './src/components/WatchRunReview'; export { ConfirmDialogHost } from './src/components/ConfirmDialog';`,
      resolveDir: process.cwd(), loader: "tsx",
    },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    external: ["react", "react-dom/client", "react/jsx-runtime"],
    define: { "process.env.NODE_ENV": '"development"' },
  });
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, requestAnimationFrame: (fn: () => void) => { fn(); return 0; }, IS_REACT_ACT_ENVIRONMENT: true })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  let legacy = false;
  let ledgerFail = false;
  const entries = [
    { id: "w-1", title: "Paper One", authors: "A", journal: "JACS", url: "u1", relevance: "推荐", zhSummary: "好", impactFactor: null, casQuartile: null, top: false, decision: "" },
    { id: "w-2", title: "Paper Two", authors: "B", journal: "", url: "u2", relevance: "相关", zhSummary: "", impactFactor: null, casQuartile: null, top: false, decision: "" },
  ];
  const decisions = new Map<string, string>();
  Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke: async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === "watch_run_entries") {
      if (legacy || args?.runId === "stopped") throw new Error("本次运行没有冻结产物证据");
      return entries.map((e) => ({ ...e, decision: decisions.get(e.id) ?? "" }));
    }
    if (command === "watch_run_decide") {
      const decision = String(args?.decision ?? "");
      if (decision) decisions.set(String(args?.entryId), decision);
      else decisions.delete(String(args?.entryId));
      return;
    }
    if (command === "watch_run_snapshot") {
      if (legacy) throw new Error("本次运行没有冻结产物证据");
      return { runId: "r", files: [{ path: "notes/inbox.md", before: "old", initial: "old", after: "new" }] };
    }
    if (command === "adopt_watch_run") {
      if (ledgerFail) throw new Error("文件已采纳，但验收记录落盘失败：disk。请再执行一次采纳以补记");
      return ["notes/inbox.md"];
    }
    throw new Error(command);
  } } });
  const compiled = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", built.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
  const { createElement: h, act, createRoot, Review, ConfirmDialogHost } = compiled.exports;
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  const buttons = () => Array.from(host.querySelectorAll("button"));
  const button = (text: string) => buttons().find((item) => item.textContent === text)!;
  const render = (id: string, status = "completed", locked = false) => act(async () => {
    root.render(h("div", null, h(Review, { key: id + String(locked), run: { id, status }, onClose: () => {}, currentDirectory: h("p", null, "实时目录内容"), locked }), h(ConfirmDialogHost)));
  });
  const decideCalls = () => calls.filter((c) => c.command === "watch_run_decide");
  const adoptCalls = () => calls.filter((c) => c.command === "adopt_watch_run");
  try {
    // 1) 新命中列表与计数行
    await render("first");
    assert.match(host.textContent!, /本次定时任务 · 命中评审/);
    assert.match(host.textContent!, /本次新命中 2 篇/);
    assert.match(host.textContent!, /排除的不会写进项目/);
    assert.ok(button("采纳进项目"));

    // 2) 排除：写决定，行从未定视图消失；显示已定的能找回并撤销
    await act(async () => button("排除").click());
    assert.equal(decideCalls().length, 1);
    assert.equal(decideCalls()[0].args?.decision, "excluded");
    assert.match(host.textContent!, /排除 1/);
    assert.ok(!host.textContent!.includes("Paper One"), "默认只看未定：已定条目退场");
    await act(async () => button("显示已定的").click());
    assert.match(host.textContent!, /已排除/);
    await act(async () => buttons().filter((b) => b.textContent === "撤销排除").at(-1)!.click());
    assert.equal(decideCalls().at(-1)!.args?.decision, "");

    // 3) 采纳确认：取消不 invoke；确认后按钮定稿并给出去向说明
    await act(async () => button("采纳进项目").click());
    await act(async () => button("取消").click());
    assert.equal(adoptCalls().length, 0);
    await act(async () => button("采纳进项目").click());
    await act(async () => buttons().filter((b) => b.textContent === "采纳进项目").at(-1)!.click());
    assert.equal(adoptCalls().length, 1);
    assert.ok(button("已采纳").disabled);
    assert.match(host.textContent!, /文献雷达/);

    // 4) 已采纳重开（locked）：只读回看，无采纳按钮、无留下/排除
    await render("first", "completed", true);
    assert.match(host.textContent!, /已采纳 · 只读回看/);
    assert.equal(button("采纳进项目"), undefined);
    assert.equal(button("留下"), undefined);
    assert.equal(button("排除"), undefined);
    assert.match(host.textContent!, /Paper One/);

    // 5) 台账补记：报「验收记录落盘失败」给重试入口，重试成功后定稿
    ledgerFail = true;
    await render("ledger");
    await act(async () => button("采纳进项目").click());
    await act(async () => buttons().filter((b) => b.textContent === "采纳进项目").at(-1)!.click());
    assert.match(host.textContent!, /验收记录未写下/);
    assert.ok(button("再记录验收"));
    ledgerFail = false;
    const adoptBeforeRetry = adoptCalls().length;
    await act(async () => button("再记录验收").click());
    assert.equal(adoptCalls().length, adoptBeforeRetry + 1);
    assert.ok(button("已采纳").disabled);

    // 6) 没跑完的运行：不能采纳，空态说明原因
    await render("stopped", "stopped");
    assert.ok(button("采纳进项目").disabled);
    assert.match(host.textContent!, /没有跑完/);

    // 7) 旧记录无冻结证据：列表为空，采纳不可点
    legacy = true;
    decisions.clear();
    await render("legacy");
    assert.match(host.textContent!, /没有冻结产物/);
    assert.ok(button("采纳进项目").disabled);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
