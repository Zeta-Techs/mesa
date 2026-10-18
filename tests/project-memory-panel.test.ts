import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

test("项目知识：人工修订传版本，作废确认，保存失败不丢编辑", async () => {
  const compiled = await build({ stdin: { contents: `export {createElement,act} from 'react'; export {createRoot} from 'react-dom/client'; export {default as Panel} from './src/components/ProjectMemoryPanel'; export {ConfirmDialogHost} from './src/components/ConfirmDialog';`, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"] });
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (fn: () => void) => { fn(); return 0; }, cancelAnimationFrame: () => {} })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const entry = { meta: { id: "m1", createdAt: "t1", goalName: "实验", sourceVersion: "run:1", state: "active", replaces: null, reason: "人工确认" }, text: "旧结论", stalePaths: ["data.csv"] };
  let disk = { revision: "v1", legacyText: "旧笔记", entries: [entry] };
  const calls: any[] = []; let fail = true;
  Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: any) => {
    if (command === "project_memory_read") return disk;
    assert.equal(command, "project_memory_update"); calls.push(args);
    assert.equal(args.path, "/project");
    if (fail) throw new Error("项目知识已被修改，请重新读取后再确认");
    if (args.action === "replace") disk = { ...disk, revision: "v2", entries: [{ ...entry, meta: { ...entry.meta, state: "superseded" } }, { ...entry, meta: { ...entry.meta, id: "m2", replaces: "m1" }, text: args.text, stalePaths: [] }] };
    else disk = { ...disk, revision: "v3", entries: disk.entries.map((e) => e.meta.id === args.id ? { ...e, meta: { ...e.meta, state: "revoked" } } : e) };
    return disk;
  } } });
  const mod = { exports: {} as Record<string, any> }; new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
  const { createElement: h, act, createRoot, Panel, ConfirmDialogHost } = mod.exports;
  const host = dom.window.document.getElementById("root")!; const root = createRoot(host);
  const button = (name: string) => [...dom.window.document.querySelectorAll("button")].find((b) => b.textContent === name)!;
  const input = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
    const proto = element.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value); element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  try {
    await act(async () => root.render(h("div", null, h(Panel, { projectPath: "/project" }), h(ConfirmDialogHost))));
    // 面板默认折叠（摘要给有效条数），先点开再进条目操作
    await act(async () => [...dom.window.document.querySelectorAll("button")].find((b) => b.textContent!.includes("项目长期知识"))!.click());
    assert.match(host.textContent!, /来源已变化/);
    await act(async () => button("修订 / 重新确认").click());
    await input(host.querySelector("textarea")!, "新结论"); await input(host.querySelector("input")!, "复算后确认");
    await act(async () => button("确认替代旧结论").click());
    assert.match(host.textContent!, /已被修改/); assert.equal(host.querySelector("textarea")!.value, "新结论");
    assert.equal(calls[0].expectedRevision, "v1"); assert.equal(calls[0].id, "m1");
    fail = false; await act(async () => button("确认替代旧结论").click());
    await input(host.querySelector("input")!, "结论不再适用");
    await act(async () => button("作废").click());
    const before = calls.length; await act(async () => button("取消").click()); assert.equal(calls.length, before);
    await act(async () => button("作废").click());
    const confirm = [...dom.window.document.querySelectorAll("button")].find((b) => b.textContent === "确定" || b.textContent === "确认");
    assert.ok(confirm); await act(async () => confirm.click());
    assert.equal(calls.at(-1).action, "revoke"); assert.equal(calls.at(-1).expectedRevision, "v2");
  } finally { await act(async () => root.unmount()); dom.window.close(); for (const [key, descriptor] of restore) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } }
});
