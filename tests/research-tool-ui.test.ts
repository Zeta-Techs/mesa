import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { PIPELINE_TEMPLATES } from "../src/pipeline-presets.ts";

async function harness(contents: string) {
  const result = await build({ stdin: { contents: `export {createElement,act} from 'react'; export {createRoot} from 'react-dom/client'; ${contents}`, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", external: ["react", "react-dom/client", "react/jsx-runtime"] });
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const raf = (cb: FrameRequestCallback) => Number(setTimeout(() => cb(Date.now()), 0));
  const saved: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: raf, cancelAnimationFrame: clearTimeout })) {
    saved.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const mod = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", result.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
  const root = mod.exports.createRoot(dom.window.document.getElementById("root"));
  return { ...mod.exports, root, dom, host: dom.window.document.getElementById("root")!, close: async () => {
    await mod.exports.act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  } };
}

test("流程编辑器选择 Origin 后交付技能、工程、图和项目偏好，不直接写外部库", async () => {
  const ui = await harness("export {default as Editor} from './src/components/PipelineEditor';");
  let saved: any[] = []; const invokes: string[] = [];
  Object.assign(ui.dom.window, { __TAURI_INTERNALS__: { invoke: async (command: string) => { invokes.push(command); if (command === "list_skills") return []; throw new Error(command); } } });
  try {
    const steps = PIPELINE_TEMPLATES.find((t) => t.id === "research-paper")!.steps;
    await ui.act(async () => ui.root.render(ui.createElement(ui.Editor, { projectName: "Fixture", projectPath: "/fixture", config: { steps, resources: [], settings: ["原始数据只读"], artifactDir: "artifacts" }, warnings: [], saving: false, onSave: (...args: any[]) => { saved = args; }, onClose() {}, onConfigReload() {} })));
    const label = [...ui.host.querySelectorAll("label")].find((l: any) => l.textContent.startsWith("数值图")) as HTMLLabelElement;
    const select = label.querySelector("select")!;
    await ui.act(async () => { select.value = "origin"; select.dispatchEvent(new ui.dom.window.Event("change", { bubbles: true })); });
    const button = [...ui.host.querySelectorAll("button")].find((b: any) => b.textContent === "保存") as HTMLButtonElement;
    await ui.act(async () => button.click());
    const analysis = saved[0].find((s: any) => s.name === "结果分析");
    assert.ok(analysis.skills.includes("origin-plot"));
    assert.ok(analysis.expectedArtifacts.includes("artifacts/origin/project.opju"));
    assert.ok(saved[1].includes("科研工具/plotting：origin"));
    assert.ok(saved[1].includes("原始数据只读"));
    assert.deepEqual(invokes,["list_skills"]);
  } finally { await ui.close(); }
});

test("工具预检先阻止未就绪开工，刷新后根据真实返回释放，不自动分发", async () => {
  const ui = await harness("export {default as Preflight} from './src/components/ResearchToolPreflight';");
  const blocked: boolean[] = []; let available = false; const invokes: string[] = [];
  Object.assign(ui.dom.window, { __TAURI_INTERNALS__: { invoke: async (command: string) => { invokes.push(command); assert.equal(command,"research_tool_preflight"); return [{name:"origin-plot",status:available?"available":"missing",detail:available?"已启用":"未分发",blocking:!available}]; } } });
  const onBlocked = (v: boolean) => blocked.push(v);
  try {
    await ui.act(async () => ui.root.render(ui.createElement(ui.Preflight,{projectRoot:"/fixture",stepName:"分析",agent:"codex",onBlocked})));
    assert.equal(blocked.at(-1),true);assert.match(ui.host.textContent!,/未分发/);
    available=true;await ui.act(async () => ([...ui.host.querySelectorAll("button")].find((b) => b.textContent === "重新检测") as HTMLButtonElement).click());
    assert.equal(blocked.at(-1),false);assert.match(ui.host.textContent!,/已启用/);
    assert.deepEqual(invokes,["research_tool_preflight","research_tool_preflight"]);
  } finally { await ui.close(); }
});

test("英文综述设定屏只填全局设定，不问稿件载体或 Blender", async () => {
  const ui = await harness("export {default as Pick} from './src/components/TemplatePickModal';");
  Object.assign(ui.dom.window, { __TAURI_INTERNALS__: { invoke: async () => ({ config: { settings: [], topic: "", steps: [] } }) } });
  try {
    await ui.act(async () => ui.root.render(ui.createElement(ui.Pick, {
      projectPath: "/fixture", projectName: "综述", onClose() {}, onOptOut() {}, onApplied() {},
    })));
    const review = [...ui.host.querySelectorAll("button")].find((b: { textContent: string }) => b.textContent.includes("英文综述")) as HTMLButtonElement;
    await ui.act(async () => review.click());
    const text = ui.host.textContent ?? "";
    assert.match(text, /综述角度/);
    assert.doesNotMatch(text, /稿件载体/);
    assert.doesNotMatch(text, /按需补齐交付/);
    assert.doesNotMatch(text, /结构 \/ 装置示意/);
    assert.doesNotMatch(text, /文献库交付/);
  } finally { await ui.close(); }
});
