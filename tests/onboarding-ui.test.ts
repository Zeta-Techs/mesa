import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import type { OnboardingFacts } from "../src/onboarding.ts";

const bundle = await build({
  stdin: {
    contents: `export {createElement, act} from 'react';
      export {createRoot} from 'react-dom/client';
      export {OnboardingWizard} from './src/components/OnboardingWizard';
      export {GatewayQuickForm} from './src/components/GatewayQuickForm';`,
    resolveDir: process.cwd(), loader: "tsx",
  },
  bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
  external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
  plugins: [{
    name: "onboarding-host",
    setup(builder) {
      const stubs: Record<string, string> = {
        "../store": `import {useSyncExternalStore} from 'react';
          export const useAppStore = select => select(useSyncExternalStore(window.__onboarding.subscribe, window.__onboarding.snapshot));
          useAppStore.getState = () => window.__onboarding.state;`,
        "../hotkeys": "export const IS_MAC = false; export const IS_WINDOWS = false;",
        "../mac-titlebar": "export const macOverlayPadClass = () => 'pl-3'; export const useMacFullscreen = () => false;",
        "../quick-chat-launch": "export const openQuickChat = async () => { window.__onboarding.chats++; };",
        "../connect-official": `export const connectOfficialAccount = () => window.__onboarding.connect();
          export const startOfficialLogin = async () => {};`,
        "../agent-install": `export const diagnose = () => null; export const installToolHelp = () => '需要 Node.js';
          export const useAgentInstall = () => window.__onboarding.install;`,
        "../dep-install": `export const DepInstallLog = () => null;
          export const useDepInstall = () => ({entries: {node: {running: false}}, install: async () => {}});`,
        "./WindowControls": "export default () => null;",
        "@tauri-apps/api/core": "export const invoke = (...args) => window.__onboarding.invoke(...args);",
      };
      builder.onResolve({ filter: /.*/ }, (args) => args.path in stubs ? { path: args.path, namespace: "stub" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
    },
  }],
});

const blank: OnboardingFacts = { installedAgents: [], gatewayCount: 0, profileCount: 0, userSessionCount: 0, projectCount: 0 };

async function mount(facts: OnboardingFacts = blank, formOnly = false) {
  const dom = new JSDOM('<button id="opener">上手引导</button><div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  dom.window.matchMedia = (() => ({ matches: true })) as typeof dom.window.matchMedia;
  const listeners = new Set<() => void>();
  const requests: string[] = [];
  const data = {
    state: {
      onboardingWizardOpen: true, settings: { theme: "midnight" }, profiles: [] as { agent: string }[],
      onboardingOfficial: {} as Record<string, string>, depCheck: null,
      setOnboardingWizardOpen: (open: boolean) => patch({ onboardingWizardOpen: open }),
      updateOnboarding: () => {}, refreshDepCheck: async () => {},
      setPage: () => {}, setNewProjectOpenReq: () => requests.push("new"),
      setAddProjectOpenReq: () => requests.push("add"), setDemoProjectOpenReq: () => requests.push("demo"),
      saveGateway: async () => { requests.push("save"); return { id: "gateway" }; },
      bindGateway: async () => { requests.push("bind"); }, loadAll: async () => {},
    },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    snapshot: () => data.state,
    install: { entries: {} as Record<string, { running: boolean; output: string }>, previews: {} as Record<string, string>, loadPreviews: async () => {}, install: async () => {} },
    chats: 0, connect: async () => true, invoke: async () => ({ ok: true, checks: [] }),
  };
  function patch(value: Partial<typeof data.state>) {
    data.state = { ...data.state, ...value };
    for (const listener of listeners) listener();
  }
  Object.assign(dom.window, { __onboarding: data });
  const compiled = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
  const { createElement, act, createRoot, OnboardingWizard, GatewayQuickForm } = compiled.exports;
  const host = dom.window.document.getElementById("root")!;
  const opener = dom.window.document.getElementById("opener")!;
  opener.focus();
  const root = createRoot(host);
  const props = formOnly ? { agent: "claude-code", onConnected: () => requests.push("connected"), onMore: () => requests.push("more"), onBusyChange: () => {} } : { facts };
  await act(async () => root.render(createElement(formOnly ? GatewayQuickForm : OnboardingWizard, props)));
  function button(label: string) {
    const result = Array.from(host.querySelectorAll("button")).find((entry) => (entry.getAttribute("aria-label") ?? entry.textContent?.trim()) === label);
    assert.ok(result, `缺少按钮：${label}`);
    return result;
  }
  return {
    dom, host, data, patch, act, requests, opener, button,
    click: (label: string) => act(async () => button(label).click()),
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

test("向导切步：回到顶部、聚焦标题；未做完只退出体验，Esc 关闭后归还焦点", async () => {
  const ui = await mount();
  try {
    const main = ui.host.querySelector("main")!;
    main.scrollTop = 500;
    await ui.click("建第一个项目，未完成");
    await ui.act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    assert.equal(main.scrollTop, 0);
    assert.equal(document.activeElement?.id, "onboarding-title");
    await ui.act(async () => document.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true })));
    assert.equal(document.activeElement, ui.button("先去体验"));
    await ui.act(async () => document.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    assert.equal(document.activeElement, ui.button("接上 AI，未完成"));
    assert.ok(ui.button("先去体验"));
    assert.equal(ui.host.querySelector('[aria-current="step"]')?.getAttribute("aria-label"), "建第一个项目，当前步骤");
    await ui.act(async () => document.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(ui.host.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, ui.opener);
  } finally { await ui.close(); }
});

test("没连接就去接上 AI；已有连接可打开对话，不提前启动真实 Agent", async () => {
  const ui = await mount();
  try {
    await ui.click("聊第一句，未完成");
    assert.ok(ui.button("去接上 AI"));
    await ui.click("去接上 AI");
    assert.equal(ui.host.querySelector("h1")?.textContent, "先把 AI 接上");
  } finally { await ui.close(); }
  const connected = await mount({ ...blank, profileCount: 1 });
  try {
    await connected.click("开始第一段对话");
    assert.equal(connected.data.chats, 1);
    assert.equal(connected.data.state.onboardingWizardOpen, false);
  } finally { await connected.close(); }
});

test("账号探测显示等待；完成探测不擅自切换 Agent，接入期间切步和 Esc 都不退出", async () => {
  const ui = await mount({ ...blank, installedAgents: ["claude-code", "codex"] });
  try {
    assert.match(ui.host.textContent!, /正在检查官方账号登录状态/);
    await ui.act(async () => ui.patch({ onboardingOfficial: { "claude-code": "ready", codex: "ready" } }));
    let finish: (value: boolean) => void = () => {};
    ui.data.connect = () => new Promise<boolean>((resolve) => { finish = resolve; });
    await ui.click("用 Claude Code 官方账号");
    assert.equal(ui.button("聊第一句，未完成").disabled, true);
    await ui.act(async () => document.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(ui.data.state.onboardingWizardOpen, true);
    await ui.act(async () => finish(false));
    assert.equal(ui.button("聊第一句，未完成").disabled, false);
    await ui.click("Codex");
    assert.equal(ui.button("Codex").getAttribute("aria-pressed"), "true");
    assert.ok(ui.button("用 Codex 官方账号"));
  } finally { await ui.close(); }
});

test("安装在途：有忙碌反馈且不丢失安装界面，完成后恢复导航", async () => {
  const ui = await mount();
  try {
    await ui.act(async () => {
      ui.data.install.entries = { codex: { running: true, output: "正在安装" } };
      ui.patch({});
    });
    assert.equal(ui.button("跳过这步").disabled, true);
    assert.match(ui.host.querySelector("footer")!.textContent!, /正在处理/);
    await ui.act(async () => {
      ui.data.install.entries = {};
      ui.patch({});
    });
    assert.equal(ui.button("跳过这步").disabled, false);
  } finally { await ui.close(); }
});

test("项目卡整行可点击：三种入口分别派发原有请求", async () => {
  for (const [label, request] of [["新建项目", "new"], ["添加已有文件夹", "add"], ["创建示例课题", "demo"]]) {
    const ui = await mount({ ...blank, profileCount: 1, userSessionCount: 1 });
    try {
      await ui.click(label);
      assert.deepEqual(ui.requests, [request]);
      assert.equal(ui.data.state.onboardingWizardOpen, false);
    } finally { await ui.close(); }
  }
});

test("API Key 表单：提交先测试再保存；失败保留输入并可重试；在途禁止改输入与跳走", async () => {
  const ui = await mount(blank, true);
  try {
    assert.equal(ui.button("测试并保存").disabled, true);
    const input = ui.host.querySelector<HTMLInputElement>('input[type="password"]')!;
    await ui.act(async () => {
      Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "test-key");
      input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
      const model = ui.host.querySelector<HTMLInputElement>('input[list]')!;
      Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, "value")!.set!.call(model, "claude-test");
      model.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
    });
    assert.equal(ui.button("测试并保存").disabled, false, ui.host.textContent!);
    let fail: (reason: Error) => void = () => {};
    let probes = 0;
    ui.data.invoke = () => { probes++; return new Promise((_resolve, reject) => { fail = reject; }); };
    await ui.act(async () => {
      ui.host.querySelector("form")!.requestSubmit();
      ui.host.querySelector("form")!.requestSubmit();
    });
    assert.equal(probes, 1);
    assert.equal(ui.host.querySelector("fieldset")!.disabled, true);
    assert.equal(ui.button("更多设置（网关库）").matches(":disabled"), true);
    await ui.act(async () => fail(new Error("服务商暂时不可用")));
    assert.match(ui.host.querySelector('[role="alert"]')!.textContent!, /服务商暂时不可用/);
    assert.equal(input.value, "test-key");
    assert.deepEqual(ui.requests, []);
    ui.data.invoke = async () => ({ ok: true, checks: [] });
    await ui.act(async () => ui.host.querySelector("form")!.requestSubmit());
    assert.deepEqual(ui.requests, ["save", "bind", "connected"]);
  } finally { await ui.close(); }
});

test("API Key 表单：选「其他服务商 / 中转」自填地址，地址不对不放行，保存只填这家 Agent 的协议槽", async () => {
  const ui = await mount(blank, true);
  try {
    const set = async (el: HTMLInputElement | HTMLSelectElement, value: string, event: string) => {
      const proto = el instanceof ui.dom.window.HTMLSelectElement ? ui.dom.window.HTMLSelectElement.prototype : ui.dom.window.HTMLInputElement.prototype;
      await ui.act(async () => {
        Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
        el.dispatchEvent(new ui.dom.window.Event(event, { bubbles: true }));
      });
    };
    const select = ui.host.querySelector("select")!;
    const customOption = Array.from(select.options).find((o) => o.textContent?.includes("自填地址"))!;
    assert.ok(customOption, "下拉里要有自填地址一项");
    await set(select, customOption.value, "change");
    const url = ui.host.querySelector<HTMLInputElement>('input[type="url"]')!;
    assert.ok(url, "选中后出现 API 地址输入框");
    await set(ui.host.querySelector<HTMLInputElement>('input[type="password"]')!, "relay-key", "input");
    await set(ui.host.querySelector<HTMLInputElement>("input[list]")!, "claude-relay", "input");
    await set(url, "relay.example.com", "input");
    assert.equal(ui.button("测试并保存").disabled, true);
    await set(url, "https://relay.example.com/api", "input");
    assert.equal(ui.button("测试并保存").disabled, false);
    let saved: { name: string; slots: Record<string, string | null> } | null = null;
    let probedUrl = "";
    ui.data.invoke = async (_cmd: string, args: { baseUrl: string }) => { probedUrl = args.baseUrl; return { ok: true, checks: [] }; };
    await ui.act(async () => ui.patch({ saveGateway: async (_id: null, input: { name: string; slots: Record<string, string | null> }) => { saved = input; return { id: "gateway", name: input.name }; } } as never));
    await ui.act(async () => ui.host.querySelector("form")!.requestSubmit());
    assert.equal(probedUrl, "https://relay.example.com/api");
    assert.equal(saved!.name, "relay.example.com");
    assert.deepEqual(saved!.slots, { anthropic: "https://relay.example.com/api", openai: null, responses: null, gemini: null, cursor: null });
    assert.deepEqual(ui.requests, ["bind", "connected"]);
  } finally { await ui.close(); }
});

test("API Key 表单：填好 Key 离开输入框自动拉模型目录，下拉不预选目录第一个，选中后按它测试与保存", async () => {
  const ui = await mount(blank, true);
  try {
    const calls: string[] = [];
    let probedModel = "";
    ui.data.invoke = async (cmd: string, args: { model?: string }) => {
      calls.push(cmd);
      if (cmd === "fetch_models") return { models: ["gpt-search-broken", "claude-relay", "claude-relay"], fromCache: false, fetchedAt: "", capabilityMetadataCount: 0 };
      probedModel = args.model ?? "";
      return { ok: true, checks: [] };
    };
    const key = ui.host.querySelector<HTMLInputElement>('input[type="password"]')!;
    await ui.act(async () => {
      Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, "value")!.set!.call(key, "relay-key");
      key.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
    });
    await ui.act(async () => { key.dispatchEvent(new ui.dom.window.FocusEvent("focusout", { bubbles: true })); });
    assert.deepEqual(calls, ["fetch_models"]);
    const select = ui.host.querySelector<HTMLSelectElement>("#onboarding-model")!;
    assert.equal(select.tagName, "SELECT");
    assert.equal(select.value, "", "不替人预选目录第一个");
    assert.deepEqual(Array.from(select.options).map((o) => o.value), ["", "gpt-search-broken", "claude-relay", "__manual__"]);
    assert.equal(ui.button("测试并保存").disabled, true);
    await ui.act(async () => {
      Object.getOwnPropertyDescriptor(ui.dom.window.HTMLSelectElement.prototype, "value")!.set!.call(select, "claude-relay");
      select.dispatchEvent(new ui.dom.window.Event("change", { bubbles: true }));
    });
    await ui.act(async () => ui.host.querySelector("form")!.requestSubmit());
    assert.equal(probedModel, "claude-relay");
    assert.deepEqual(ui.requests, ["save", "bind", "connected"]);
  } finally { await ui.close(); }
});
