import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { PIPELINE_TEMPLATES } from "../src/pipeline-presets.ts";
import { pickKickoffPermission } from "../src/kickoff-launch.ts";
import { classifierBillingNotice, classifierNoticeText } from "../src/cli-notices.ts";
import { parseTuiNotice } from "../src/tui-panel.ts";

test("pickKickoffPermission：本项目上次 > 本机设置 > 帮我批准 > 请求批准；这家没有原生档不给选", () => {
  const all = ["ask", "auto", "full"];
  assert.equal(pickKickoffPermission(all, null, null), "auto");
  assert.equal(pickKickoffPermission(all, "ask", "full"), "ask");
  assert.equal(pickKickoffPermission(all, null, "full"), "full", "本机就设成完全访问的照本机");
  assert.equal(pickKickoffPermission(all, null, "discuss"), "auto", "计划模式不是开工能选的档");
  assert.equal(pickKickoffPermission(["ask", "full"], "auto", null), "ask", "这家没有帮我批准");
  assert.equal(pickKickoffPermission([], "auto", "auto"), null);
});

// Claude Code 2.1.305 实录（tests/tui-panel.test.ts 同一份）：按终端宽度折行
const NOTICE = [
  "─".repeat(100),
  "  We're changing auto mode to no longer charge for classifier requests in Claude Code.",
  "",
  "  However, this session isn't eligible because your requests go through open.bigmodel.cn, which isn't  ",
  "  compatible with this update.",
  "",
  "  Nothing breaks: auto mode keeps working, and its classifier requests are billed as before.",
  "",
  "  Enter to continue · Esc to cancel",
];

test("classifierBillingNotice：认出计费说明并取网关名；折得更碎也认；别的通知不认", () => {
  const body = parseTuiNotice(NOTICE, "claude-code");
  assert.deepEqual(classifierBillingNotice(body), { gateway: "open.bigmodel.cn" });
  const narrow = ["We're changing auto mode to no", "longer charge for", "classifier requests in Claude Code.", "However, this session isn't eligible."];
  assert.deepEqual(classifierBillingNotice(narrow), { gateway: null });
  assert.equal(classifierBillingNotice(["Update available! Run brew upgrade"]), null);
  assert.equal(classifierBillingNotice(null), null);
  assert.match(classifierNoticeText("open.bigmodel.cn"), /走的是 open\.bigmodel\.cn，用不上新办法，照旧计费/);
  assert.match(classifierNoticeText(null), /走的是第三方网关/);
});

test("开工弹层：权限默认帮我批准，选完全访问要再确认、只这一次，不记成项目默认", async () => {
  const bundle = await build({
    stdin: { contents: `export {createElement,act} from 'react'; export {createRoot} from 'react-dom/client'; export {default as Kickoff} from './src/components/KickoffConfirmDialog';`, resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", external: ["react", "react-dom/client", "react/jsx-runtime"],
    plugins: [{ name: "host", setup(b) {
      b.onResolve({ filter: /^\.\.\/store$/ }, () => ({ path: "store", namespace: "stub" }));
      b.onResolve({ filter: /^\.\/HumanTasksList$/ }, () => ({ path: "human", namespace: "stub" }));
      b.onResolve({ filter: /^\.\/ConfirmDialog$/ }, () => ({ path: "confirm", namespace: "stub" }));
      b.onResolve({ filter: /^\.\.\/pipeline-start$/ }, (args) => args.importer.endsWith("KickoffConfirmDialog.tsx") ? { path: "pipeline", namespace: "stub" } : undefined);
      b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ loader: "js", resolveDir: process.cwd(), contents:
        args.path === "store" ? "export const useAppStore=fn=>fn(globalThis.__kickoffStore);"
        : args.path === "human" ? "export default function Human(){return null;}"
        : args.path === "confirm" ? "export const confirmDialog=async(t)=>{globalThis.__kickoffConfirms.push(t);return true;}; export const alertDialog=async()=>{};"
        : "export {renderTaskMd} from './src/task-md.ts'; export const gatherTaskMdExtras=async()=>({artifacts:[],skillMeta:{},decisions:[]});" }));
    } }],
  });
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  const confirms: string[] = [];
  const state = {
    profiles: [{ id: "p2", name: "Claude relay", agent: "claude-code", models: ["glm-5.3"], accountType: "api" }],
    agents: [{ id: "claude-code", binaryPath: "/usr/bin/test", permissionModes: ["ask", "auto", "full"] }],
    setPage() {},
  };
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, localStorage: dom.window.localStorage, requestAnimationFrame: (f: () => void) => { f(); return 0; }, cancelAnimationFrame: () => {}, IS_REACT_ACT_ENVIRONMENT: true, __kickoffStore: state, __kickoffConfirms: confirms })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke: async (command: string) => {
    if (command === "read_task_draft") return { relPath: ".ccode/drafts/outline.md", text: null };
    if (command === "git_status") return { isRepo: true, files: [] };
    if (command === "combo_surface") return {};
    if (command === "cli_default_permission") return { tier: "ask", short: "", detail: "" };
    if (["list_skills", "inspect_step_inputs", "discover_resources", "list_legacy_briefs", "list_human_task_states", "list_dir"].includes(command)) return [];
    throw new Error(command);
  } } });
  const mod = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
  const { createElement: h, act, createRoot, Kickoff } = mod.exports;
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  const raw = PIPELINE_TEMPLATES.find((t) => t.id === "review")!.steps.find((s) => s.workspaceName === "outline")!;
  const step = { ...raw, inputs: [], anyOfInputs: [], decisions: [], decisionMode: "auto_continue", skills: [], requiredSkills: [] };
  const launches: any[] = [];
  const tab = (name: string) => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((b) => b.textContent === name)!;
  try {
    // 本项目上次选过「帮我批准」：比本机设置（请求批准）优先
    dom.window.localStorage.setItem("ccode.kickoffPerm./project", "auto");
    await act(async () => root.render(h(Kickoff, {
      projectPath: "/project", step, cfg: { steps: [step], resources: [], artifactDir: "artifacts" },
      originCardId: null, busy: false, onCancel() {}, onConfirm: (_t: string, launch: unknown) => launches.push(launch),
    })));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    assert.equal(tab("帮我批准").getAttribute("aria-selected"), "true");
    assert.match(host.textContent!, /删文件这类有风险的才停下问你/);
    await act(async () => tab("完全访问").click());
    assert.equal(confirms.length, 1, "完全访问要再确认");
    assert.match(confirms[0], /开启完全访问/);
    assert.equal(tab("完全访问").getAttribute("aria-selected"), "true");
    assert.match(host.textContent!, /删文件也不问/);
    const go = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "确认开始")!;
    assert.ok(!go.disabled, "这一步没有要先拍板的事");
    await act(async () => go.click());
    assert.equal(launches[0].permissionMode, "full");
    assert.equal(dom.window.localStorage.getItem("ccode.kickoffPerm./project"), null, "完全访问不记成项目默认");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, d] of restore) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  }
});
