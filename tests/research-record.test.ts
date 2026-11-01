import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { RESEARCH_EXPORTS, runRecordLine, type RunRecordDto } from "../src/research-record.ts";

const run = (over: Partial<RunRecordDto> = {}): RunRecordDto => ({
  runId: "r1",
  taskKind: "pipeline_step",
  purpose: "研究流程：综述初稿",
  agent: "claude-code",
  models: ["claude-opus"],
  createdAt: "2026-11-02T08:00:00Z",
  status: "completed",
  ...over,
});

test("研究记录一行：用途、AI 工具与模型、结果；核验只标拦下与待判断", () => {
  assert.deepEqual(runRecordLine(run()), { title: "研究流程：综述初稿", meta: "Claude Code · claude-opus · 完成", flag: "" });
  assert.equal(runRecordLine(run({ models: [], status: "failed" })).meta, "Claude Code · 模型未记录 · 失败");
  assert.equal(runRecordLine(run({ checks: { passed: 3, blocked: 1, needsHuman: 2 } })).flag, "拦下 1 · 待判断 2");
  assert.equal(runRecordLine(run({ checks: { passed: 3, blocked: 0, needsHuman: 0 } })).flag, "");
  assert.deepEqual(RESEARCH_EXPORTS.map((e) => e.kind), ["ai_statement", "repro_pack", "process_report"]);
  assert.match(RESEARCH_EXPORTS[2].hint, /不含对话原文/);
});

test("研究记录面板：没有记录不出现；有记录可展开、导出后给出文件名", async () => {
  const bundle = await build({
    stdin: {
      contents: `export {createElement,act} from 'react'; export {createRoot} from 'react-dom/client'; export {default as Panel} from './src/components/ResearchRecordPanel';`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    jsx: "automatic",
    external: ["react", "react-dom/client", "react/jsx-runtime"],
    plugins: [
      {
        name: "stub",
        setup(b) {
          b.onResolve({ filter: /^@tauri-apps\/plugin-opener$/ }, () => ({ path: "opener", namespace: "stub" }));
          b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
            loader: "js",
            contents: "export const revealItemInDir=async(p)=>{globalThis.__revealed=p;};",
          }));
        },
      },
    ],
  });
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  let runs: RunRecordDto[] = [];
  const exported: string[] = [];
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  Object.assign(dom.window, {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: { path: string; kind?: string }) => {
        if (command === "research_record_read") return { runs };
        if (command === "research_export") {
          exported.push(args.kind!);
          return `/Users/x/Downloads/ccode-exports/课题-研究过程报告-20261102.html`;
        }
        throw new Error(command);
      },
    },
  });
  const mod = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
  const { createElement: h, act, createRoot, Panel } = mod.exports;
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  try {
    await act(async () => root.render(h(Panel, { projectPath: "/p" })));
    assert.equal(host.textContent, "");
    runs = [run(), run({ runId: "r2", purpose: "目标", agent: "codex", models: ["gpt-5"] })];
    await act(async () => root.render(h(Panel, { key: "2", projectPath: "/p" })));
    assert.match(host.textContent!, /研究记录2/);
    assert.doesNotMatch(host.textContent!, /Codex · gpt-5/);
    await act(async () => (host.querySelector("button[aria-expanded]") as HTMLButtonElement).click());
    assert.match(host.textContent!, /Codex · gpt-5 · 完成/);
    const report = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "研究过程报告") as HTMLButtonElement;
    await act(async () => report.click());
    assert.deepEqual(exported, ["process_report"]);
    assert.match(host.textContent!, /已导出到下载文件夹：课题-研究过程报告-20261102\.html/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, d] of restore) {
      if (d) Object.defineProperty(globalThis, key, d);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
