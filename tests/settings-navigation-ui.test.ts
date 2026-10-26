import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { compile } from "@tailwindcss/node";
import { JSDOM } from "jsdom";

const appCss = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
const bundle = await build({
  stdin: {
    contents: `export {createElement, act} from 'react'; export {createRoot} from 'react-dom/client'; export {default as Settings} from './src/pages/SettingsPage';`,
    resolveDir: process.cwd(), loader: "tsx",
  },
  bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
  // 设置页「应用图标」预览图：内联成 data URL，打包不依赖 Vite 资源管线
  loader: { ".png": "dataurl" },
  external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
  plugins: [{ name: "settings-host", setup(b) {
    const stubs: Record<string, string> = {
      "../store": `export const useAppStore = select => select(window.__settingsUiHost.store);
        useAppStore.getState = () => window.__settingsUiHost.store;
        useAppStore.setState = value => Object.assign(window.__settingsUiHost.store, value);
        export const applyTheme = (...args) => window.__settingsUiHost.themeChanges.push(args);`,
      "../toast": "export const toast = (...args) => window.__settingsUiHost.toasts.push(args);",
      "../components/ConfirmDialog": "export const confirmDialog = async () => false; export const alertDialog = async () => {};",
      "@tauri-apps/api/event": "export const listen = async () => () => {};",
      "@tauri-apps/plugin-process": "export const relaunch = async () => { throw new Error('不应触发重启'); }; export const exit = async () => { throw new Error('不应触发退出'); };",
    };
    b.onResolve({ filter: /App\.css\?raw$/ }, () => ({ path: "app-css", namespace: "settings-css" }));
    b.onLoad({ filter: /.*/, namespace: "settings-css" }, () => ({ contents: `export default ${JSON.stringify(appCss)};`, loader: "js" }));
    b.onResolve({ filter: /.*/ }, (args) => args.path in stubs ? { path: args.path, namespace: "settings-stub" } : undefined);
    b.onLoad({ filter: /.*/, namespace: "settings-stub" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
  } }],
});

const sections = ["外观", "终端", "通用", "快捷键", "AI 与 Agent", "网络", "用量", "更新", "诊断", "数据与存储", "关于"];

async function renderSettings(options: { request?: string; update?: boolean; visible?: boolean; storageError?: boolean } = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const scrolled: string[] = [];
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
    value(this: HTMLElement) { scrolled.push(this.id); },
  });
  const legacy = JSON.stringify({ appearance: true, network: true, storage: false, diag: false });
  dom.window.localStorage.setItem("ccode.settings.sections", legacy);
  const calls: Array<{ command: string; args: any }> = [];
  const patches: Record<string, unknown>[] = [];
  const data = {
    storageError: options.storageError ?? false, saveError: false, settingsLoads: 0, profilesLoads: 0,
    themes: [] as unknown[], themeChanges: [] as unknown[], toasts: [] as unknown[],
    store: {
      settings: { theme: "midnight", terminalFontSize: 14, terminalFontFamily: "JetBrains Mono", scrollback: 10000, rateUsdCny: 7, outboundProxy: "", outboundNoProxy: "" },
      profiles: [{ id: "codex-a", name: "Official", agent: "codex", models: ["gpt-6-astra"] }],
      appUpdate: options.update ? { version: "1.1.0", currentVersion: "1.0.0", body: "测试更新说明", downloadAndInstall: async () => { throw new Error("不应下载"); } } : null,
      appUpdateStatus: "none", appUpdateError: null, depCheck: null,
      loadSettings: async () => { data.settingsLoads++; },
      loadAll: async () => { data.profilesLoads++; },
      updateSettings: async (patch: Record<string, unknown>) => {
        if (data.saveError) throw new Error("保存被拒绝");
        patches.push(patch);
        data.store.settings = { ...data.store.settings, ...patch };
      },
      checkAppUpdate: async () => {}, refreshDepCheck: async () => {},
      settingsSectionReq: options.request ?? null as string | null,
      setSettingsSectionReq: (value: string | null) => { data.store.settingsSectionReq = value; },
    },
  };
  Object.assign(dom.window, {
    __settingsUiHost: data,
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: unknown) => {
        calls.push({ command, args });
        if (command === "font_status") return [];
        if (command === "read_pricing_file") return "";
        if (command === "hooks_attention_support") return [];
        if (command === "get_app_log") return [{ ts: "2026-09-11T00:00:00Z", level: "info", target: "test", message: "只读诊断" }];
        if (command === "active_background_runs" || command === "list_custom_runtimes") return [];
        if (command === "app_storage_usage") {
          if (data.storageError) throw new Error("不可读");
          return [{ label: "缓存", path: "/data/cache", bytes: 2048, exists: true }];
        }
        if (command === "plugin:app|version") return "1.0.0";
        if (command === "plugin:opener|reveal_item_in_dir") return;
        if (command === "plugin:opener|open_url") return;
        if (command === "inst_session_status") {
          return {
            prefixConfigured: false,
            prefixHost: "",
            loginUrlSaved: false,
            sessionPresent: false,
            updatedAt: null,
            cookieCount: 0,
            domains: [],
          };
        }
        throw new Error(`Unexpected IPC: ${command}`);
      },
    },
  });
  const compiled = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
  const { createElement: h, act, createRoot, Settings } = compiled.exports;
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  const render = async (visible = options.visible ?? true) => act(async () => root.render(h(Settings, { visible })));
  await render();
  const nav = () => host.querySelector('nav[aria-label="设置分区"]')!;
  const content = () => host.querySelector<HTMLElement>("#settings-content")!;
  function button(label: string, parent: ParentNode = host): HTMLButtonElement {
    const result = Array.from(parent.querySelectorAll("button")).find((b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === label);
    assert.ok(result, `缺少按钮：${label}`);
    return result;
  }
  const select = async (label: string) => act(async () => {
    const result = Array.from(nav().querySelectorAll("button")).find((b) => b.textContent?.startsWith(label));
    assert.ok(result, `缺少分区：${label}`);
    result.click();
  });
  return {
    dom, host, data, calls, patches, nav, content, button, select, render, act, scrolled, legacy,
    click: async (label: string, parent?: ParentNode) => act(async () => button(label, parent).click()),
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of restore) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("设置导航：常用和管理十一项始终可见，无高级总折叠或描边胶囊", async () => {
  const view = await renderSettings();
  try {
    assert.deepEqual(Array.from(view.nav().querySelectorAll("button")).map((b) => b.textContent), sections);
    assert.deepEqual(Array.from(view.nav().querySelectorAll("p")).map((p) => p.textContent), ["常用", "管理"]);
    assert.ok(!view.nav().textContent!.includes("高级设置"));
    assert.equal(view.nav().querySelector("[aria-expanded]"), null);
    for (const button of view.nav().querySelectorAll("button")) {
      assert.ok(!button.classList.contains("border"));
      assert.ok(!button.classList.contains("rounded-full"));
      assert.equal(button.getAttribute("aria-controls"), "settings-content");
    }
    assert.equal(view.nav().querySelector('[aria-current="page"]')!.textContent, "外观");
    assert.equal(view.content().querySelectorAll("section").length, 1);
    assert.equal(view.content().querySelector("h2")!.textContent, "外观");
    assert.equal(view.content().querySelector("h2 button"), null, "内容标题不再伪装折叠按钮");
    assert.deepEqual(view.calls.map((call) => call.command), ["font_status"], "旧折叠记忆不触发后台存储或日志读取");
    assert.equal(view.dom.window.localStorage.getItem("ccode.settings.sections"), view.legacy, "不破坏用户原有存储项");
    assert.equal(view.patches.length, 0);
  } finally { await view.close(); }
});

test("十一个分区可直接切换，只显示选中内容，并按需读取诊断与存储", async () => {
  const view = await renderSettings();
  try {
    for (const label of sections) {
      await view.select(label);
      assert.equal(view.content().querySelectorAll(":scope > section").length, 1);
      assert.equal(view.content().querySelector("h2")!.textContent, label);
      const selected = view.nav().querySelector('[aria-current="page"]')!;
      assert.equal(view.nav().querySelectorAll('[aria-current="page"]').length, 1);
      assert.equal(view.content().getAttribute("aria-labelledby"), selected.id);
    }
    assert.ok(view.calls.some((call) => call.command === "read_pricing_file"));
    assert.ok(view.calls.some((call) => call.command === "get_app_log"));
    assert.equal(view.calls.filter((call) => call.command === "app_storage_usage").length, 1);
    await view.select("数据与存储");
    assert.equal(view.calls.filter((call) => call.command === "app_storage_usage").length, 1, "已读取存储结果不重复扫描");
    await view.click("定位", view.content());
    assert.ok(view.calls.some((call) => call.command === "plugin:opener|reveal_item_in_dir"));
    assert.equal(view.patches.length, 0, "切换导航与读取内容不写设置");
    assert.ok(view.scrolled.length >= sections.length - 1, "切换分区回到内容顶部");
  } finally { await view.close(); }
});

test("外部跳转优先于更新自动打开，更新提示和安装入口保留", async () => {
  for (const request of [undefined, "diag", "network"]) {
    const view = await renderSettings({ request, update: true });
    try {
      const expected = request === "diag" ? "诊断" : request === "network" ? "网络" : "更新";
      assert.ok(view.nav().querySelector('[aria-current="page"]')!.textContent!.startsWith(expected));
      assert.match(view.nav().textContent!, /更新可更新/);
      assert.equal(view.data.store.settingsSectionReq, null);
      await view.select("更新");
      assert.match(view.content().textContent!, /测试更新说明/);
      view.button("下载并安装", view.content());
      assert.equal(view.patches.length, 0);
    } finally { await view.close(); }
  }
  const unknown = await renderSettings({ request: "does-not-exist" });
  try {
    assert.equal(unknown.nav().querySelector('[aria-current="page"]')!.textContent, "外观");
    assert.equal(unknown.data.store.settingsSectionReq, null);
  } finally { await unknown.close(); }
});

test("隐藏页面不消费跳转请求，回到设置后仍直接打开目标分区", async () => {
  const view = await renderSettings({ request: "storage", visible: false });
  try {
    assert.equal(view.calls.length, 0);
    assert.equal(view.data.store.settingsSectionReq, "storage");
    await view.render(true);
    assert.equal(view.nav().querySelector('[aria-current="page"]')!.textContent, "数据与存储");
    assert.match(view.content().textContent!, /缓存/);
    assert.equal(view.data.store.settingsSectionReq, null);
  } finally { await view.close(); }
});

test("设置保存与错误反馈保持原逻辑；网络输入仍按 Enter 提交", async () => {
  const view = await renderSettings();
  try {
    await view.select("网络");
    const proxy = view.content().querySelector<HTMLInputElement>('input[placeholder="http://127.0.0.1:7890"]')!;
    assert.ok(proxy);
    await view.act(async () => {
      Object.getOwnPropertyDescriptor(view.dom.window.HTMLInputElement.prototype, "value")!.set!.call(proxy, " http://localhost:7890 ");
      proxy.dispatchEvent(new view.dom.window.Event("input", { bubbles: true }));
    });
    assert.equal(view.patches.length, 0);
    await view.act(async () => proxy.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    assert.deepEqual(view.patches, [{ outboundProxy: "http://localhost:7890" }]);
    view.data.saveError = true;
    await view.act(async () => proxy.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    assert.match(view.host.querySelector('[role="alert"]')!.textContent!, /保存被拒绝/);
    assert.equal(view.patches.length, 1);

    assert.match(view.content().textContent!, /学校图书馆/);
    assert.ok(view.button("登录学校账号", view.content()));
    assert.equal(view.content().querySelector('input[placeholder="https://proxy.xxx.edu.cn/login?url="]'), null);
    assert.equal(
      Array.from(view.content().querySelectorAll("button")).some((b) => b.textContent?.trim() === "内嵌窗登录"),
      false,
    );
    await view.act(async () => view.button("校外打不开全文时", view.content()).click());
    assert.ok(view.content().querySelector('input[placeholder="https://proxy.xxx.edu.cn/login?url="]'));
    await view.act(async () => view.button("其他方式", view.content()).click());
    assert.ok(
      Array.from(view.content().querySelectorAll("button")).some((b) => b.textContent?.trim() === "内嵌窗登录"),
    );
  } finally { await view.close(); }
  const storage = await renderSettings({ request: "storage", storageError: true });
  try {
    assert.match(storage.content().textContent!, /存储占用统计失败/);
    assert.equal(storage.nav().querySelectorAll("button").length, 11);
  } finally { await storage.close(); }
});

test("会话自动命名开关在 AI 与 Agent 分区：默认开，点一下 patch autoTitleSessions=false", async () => {
  const view = await renderSettings();
  try {
    await view.select("AI 与 Agent");
    const toggle = view.content().querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="会话自动命名"]',
    )!;
    assert.ok(toggle, "AI 与 Agent 分区缺少「会话自动命名」开关");
    // store 夹具没写 autoTitleSessions：断言的就是「缺省 = 默认开」这条路径
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    await view.act(async () => toggle.click());
    assert.deepEqual(view.patches, [{ autoTitleSessions: false }]);
  } finally { await view.close(); }
});

test("关于页身份卡 GitHub 链接：打开仓库", async () => {
  const view = await renderSettings();
  try {
    await view.select("关于");
    assert.equal(view.content().querySelector(".ccode-repo-star-stage"), null);
    const button = view.button("GitHub", view.content());
    assert.ok(button.querySelector("svg"), "按钮上要有 GitHub 图标");
    await view.click("GitHub", view.content());
    const open = view.calls.find((call) => call.command === "plugin:opener|open_url");
    assert.equal(open?.args?.url, "https://github.com/Zeta-Techs/mesa");
  } finally { await view.close(); }
});

test("侧栏与内容行按实际容器宽度响应，不靠整窗宽度挤压内容", async () => {
  const compiled = await compile(appCss, { base: fileURLToPath(new URL("../src/", import.meta.url)), onDependency() {} });
  const css = compiled.build([
    "@container", "@container/settings", "@min-[48rem]:grid-cols-[11rem_minmax(0,1fr)]",
    "@min-[48rem]:sticky", "@min-[48rem]:flex-col",
    "@min-[40rem]/settings:grid-cols-[minmax(12rem,20rem)_minmax(0,1fr)]",
  ]);
  assert.match(css, /@container \(width >= 48rem\)/);
  assert.match(css, /grid-template-columns: 11rem minmax\(0,1fr\)/);
  assert.match(css, /@container settings \(width >= 40rem\)/);
  assert.match(css, /grid-template-columns: minmax\(12rem,20rem\) minmax\(0,1fr\)/);
  assert.match(css, /container-type: inline-size/);
  assert.match(css, /position: sticky/);
});
