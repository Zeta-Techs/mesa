import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";

test("后台任务：展示当前执行并投递停止，不自动再次运行", async () => {
  const built = await build({
    stdin: { contents: `export {createElement,act} from 'react'; export {createRoot} from 'react-dom/client'; export {default as Panel} from './src/components/BackgroundTasksPanel';`, resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    external: ["react", "react-dom/client", "react/jsx-runtime"], define: { "process.env.NODE_ENV": '"development"' },
  });
  const dom = new JSDOM('<div id="root"></div>', {url:"http://localhost/"});
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,IS_REACT_ACT_ENVIRONMENT:true})) {
    restore.push([key,Object.getOwnPropertyDescriptor(globalThis,key)]);
    Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  const calls: Array<[string, unknown]> = [];
  Object.assign(dom.window,{__TAURI_INTERNALS__:{invoke:async (command:string,args:unknown) => {
    calls.push([command,args]);
    if(command === "active_background_runs") return [{id:"run-test",agent:"codex",taskRef:"摘要"}];
    if(command === "run_cancel") return;
    throw new Error(command);
  }}});
  const compiled = {exports:{} as Record<string,any>};
  new Function("require","module","exports",built.outputFiles[0].text)(createRequire(import.meta.url),compiled,compiled.exports);
  const {createElement:h,act,createRoot,Panel}=compiled.exports;
  const host = dom.window.document.getElementById("root")!;
  const root=createRoot(host);
  try {
    await act(async()=>root.render(h(Panel)));
    assert.match(host.textContent!,/Codex · 摘要/);
    await act(async()=>host.querySelector("button")!.click());
    assert.deepEqual(calls.filter(([command])=>command==="run_cancel"),[["run_cancel",{id:"run-test"}]]);
    assert.ok(!calls.some(([command])=>command.includes("spawn")));
  } finally {
    await act(async()=>root.unmount());
    dom.window.close();
    for(const [key,descriptor] of restore) { if(descriptor) Object.defineProperty(globalThis,key,descriptor); else Reflect.deleteProperty(globalThis,key); }
  }
});
