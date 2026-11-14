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
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  jsx: "automatic",
  external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "lucide-react"],
  plugins: [
    {
      name: "onboarding-host",
      setup(builder) {
        const stubs: Record<string, string> = {
          "../store": `import {useSyncExternalStore} from 'react';
            export const useAppStore = select => select(useSyncExternalStore(window.__onboarding.subscribe, window.__onboarding.snapshot));
            useAppStore.getState = () => window.__onboarding.state;`,
          "../hotkeys": "export const IS_MAC = false; export const IS_WINDOWS = false;",
          "../mac-titlebar": "export const macOverlayPadClass = () => 'pl-3'; export const useMacFullscreen = () => false;",
          "../quick-chat-launch": "export const openQuickChat = async (prompt, profile) => { window.__onboarding.chats++; window.__onboarding.prompt = prompt; window.__onboarding.profile = profile; };",
          "../connect-official": `export const connectOfficialAccount = () => window.__onboarding.connect();
            export const startOfficialLogin = async () => {};`,
          "../agent-install": `export const diagnose = () => null; export const installToolHelp = () => '需要 Node.js';
            export const useAgentInstall = () => window.__onboarding.install;`,
          "../dep-install": `export const DepInstallLog = () => null;
            export const useDepInstall = () => ({entries: {node: {running: false}}, install: async () => {}});`,
          "./AgentIcon": "export default () => null;",
          "./WindowControls": "export default () => null;",
          "@tauri-apps/api/core": "export const invoke = (...args) => window.__onboarding.invoke(...args);",
        };
        builder.onResolve({ filter: /.*/ }, (args) =>
          args.path in stubs ? { path: args.path, namespace: "stub" } : undefined,
        );
        builder.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
          contents: stubs[args.path],
          loader: "js",
        }));
      },
    },
  ],
});

const blank: OnboardingFacts = {
  installedAgents: [],
  gatewayCount: 0,
  profileCount: 0,
  userSessionCount: 0,
  projectCount: 0,
};

async function mount(facts: OnboardingFacts = blank, formOnly = false) {
  const dom = new JSDOM('<button id="opener">上手引导</button><div id="root"></div>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
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
      onboardingWizardOpen: true,
      settings: { theme: "midnight" },
      gateways: [] as Array<{
        id: string;
        name: string;
        keyHint?: string | null;
        noAuth?: boolean;
        slots?: Record<string, string | null>;
        models?: Array<{ id: string; status?: string }>;
      }>,
      profiles: [] as { id?: string; agent: string; name?: string; gatewayId?: string | null; models?: string[] }[],
      onboarding: { status: "active" } as { status: string },
      onboardingOfficial: {} as Record<string, string>,
      depCheck: null,
      setOnboardingWizardOpen: (open: boolean) => patch({ onboardingWizardOpen: open }),
      updateOnboarding: () => {},
      refreshDepCheck: async () => {},
      setPage: () => {},
      setSettingsSectionReq: () => requests.push("proxy"),
      setGatewayLibraryReq: () => requests.push("gw-lib"),
      setNewProjectOpenReq: () => requests.push("new"),
      setAddProjectOpenReq: () => requests.push("add"),
      setDemoProjectOpenReq: () => requests.push("demo"),
      saveGateway: async () => {
        requests.push("save");
        return { id: "gateway", name: "测试服务商" };
      },
      bindGateway: async (input?: unknown) => {
        requests.push("bind");
        data.bound = input;
      },
      loadAll: async () => {
        requests.push("loadAll");
      },
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => data.state,
    install: {
      entries: {} as Record<string, { running: boolean; output: string }>,
      previews: {} as Record<string, string>,
      loadPreviews: async () => {},
      install: async () => {},
    },
    chats: 0,
    prompt: undefined as string | undefined,
    profile: undefined as { id: string; agent: string } | undefined,
    bound: undefined as unknown,
    connect: async () => true,
    invoke: async (_cmd?: string, _args?: unknown) => ({ ok: true, checks: [] }) as unknown,
  };
  function patch(value: Partial<typeof data.state>) {
    data.state = { ...data.state, ...value };
    for (const listener of listeners) listener();
  }
  Object.assign(dom.window, { __onboarding: data });
  const compiled = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(
    createRequire(import.meta.url),
    compiled,
    compiled.exports,
  );
  const { createElement, act, createRoot, OnboardingWizard, GatewayQuickForm } = compiled.exports;
  const host = dom.window.document.getElementById("root")!;
  const opener = dom.window.document.getElementById("opener")!;
  opener.focus();
  const root = createRoot(host);
  const makeProps = (nextFacts: OnboardingFacts) =>
    formOnly
      ? {
          agent: "claude-code",
          onConnected: () => requests.push("connected"),
          onMore: () => requests.push("more"),
          onBusyChange: () => {},
        }
      : { facts: nextFacts };
  await act(async () => root.render(createElement(formOnly ? GatewayQuickForm : OnboardingWizard, makeProps(facts))));
  function button(label: string) {
    const result = Array.from(dom.window.document.querySelectorAll("button")).find(
      (entry) => (entry.getAttribute("aria-label") ?? entry.textContent?.trim()) === label,
    );
    assert.ok(result, `缺少按钮：${label}`);
    return result;
  }
  async function pickOption(menuLabel: string, optionMatch: string) {
    await act(async () => {
      button(menuLabel).click();
    });
    await act(async () => {
      const option = Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((o) =>
        o.textContent?.includes(optionMatch),
      );
      assert.ok(option, `下拉「${menuLabel}」缺少选项：${optionMatch}`);
      option.click();
    });
  }
  return {
    dom,
    host,
    data,
    patch,
    act,
    requests,
    opener,
    button,
    pickOption,
    rerender: (nextFacts: OnboardingFacts) =>
      act(async () => root.render(createElement(formOnly ? GatewayQuickForm : OnboardingWizard, makeProps(nextFacts)))),
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

test("向导切步：带前后方向标记、回到顶部并聚焦标题；Alt+方向键切步；Esc 关闭后归还焦点", async () => {
  const ui = await mount();
  try {
    assert.equal(ui.host.querySelector(".ccode-wizard-step")?.getAttribute("data-dir"), "none");
    const main = ui.host.querySelector("main")!;
    main.scrollTop = 500;
    await ui.click("建第一个项目，未完成");
    assert.equal(ui.host.querySelector(".ccode-wizard-step")?.getAttribute("data-dir"), "forward");
    await ui.act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    assert.equal(main.scrollTop, 0);
    assert.equal(document.activeElement?.id, "onboarding-title");

    // Alt+ArrowLeft 回退一步，方向标记变为 backward
    await ui.act(async () =>
      document.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true })),
    );
    assert.equal(ui.host.querySelector('[aria-current="step"]')?.getAttribute("aria-label"), "聊第一句，当前步骤");
    assert.equal(ui.host.querySelector(".ccode-wizard-step")?.getAttribute("data-dir"), "backward");

    // Alt+ArrowRight 再前进到末屏
    await ui.act(async () =>
      document.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true })),
    );
    assert.equal(ui.host.querySelector('[aria-current="step"]')?.getAttribute("aria-label"), "建第一个项目，当前步骤");

    await ui.act(async () =>
      document.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true })),
    );
    assert.equal(document.activeElement, ui.button("先去体验"));
    await ui.act(async () =>
      document.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true })),
    );
    assert.equal(document.activeElement, ui.button("接上 AI，未完成"));
    await ui.act(async () =>
      document.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    assert.equal(ui.host.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, ui.opener);
  } finally {
    await ui.close();
  }
});

test("向导内展开 MenuSelect 时按 Esc 只收起下拉菜单，不误关整个向导", async () => {
  const ui = await mount({ ...blank, installedAgents: ["claude-code"] });
  try {
    await ui.act(async () => ui.patch({ onboardingOfficial: { "claude-code": "none" } }));
    await ui.click("服务商");
    assert.ok(ui.dom.window.document.querySelector('[role="listbox"]'), "服务商下拉已展开");
    await ui.act(async () =>
      document.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    assert.equal(ui.dom.window.document.querySelector('[role="listbox"]'), null, "下拉已收起");
    assert.equal(ui.data.state.onboardingWizardOpen, true, "向导仍保持打开");
  } finally {
    await ui.close();
  }
});

test("没连接就去接上 AI；已有连接可切换试问场景、修改句子或选定连接发送", async () => {
  const ui = await mount();
  try {
    await ui.click("聊第一句，未完成");
    assert.ok(ui.button("去接上 AI"));
    await ui.click("去接上 AI");
    assert.equal(ui.host.querySelector("h1")?.textContent, "先把 AI 接上");
  } finally {
    await ui.close();
  }

  const connected = await mount({ ...blank, profileCount: 2 });
  try {
    await connected.act(async () =>
      connected.patch({
        profiles: [
          { id: "p-claude", agent: "claude-code", name: "官方账号" },
          { id: "p-codex", agent: "codex", name: "DeepSeek", models: ["deepseek-v4-pro"] },
        ],
      }),
    );
    await connected.click("Codex · DeepSeek");
    await connected.click("梳理论文脉络");
    const textarea = connected.host.querySelector<HTMLTextAreaElement>('textarea[aria-label="试问内容"]')!;
    assert.match(textarea.value, /核心文献脉络/);
    await connected.click("发这一句试试");
    assert.equal(connected.data.chats, 1);
    assert.match(String(connected.data.prompt), /核心文献脉络/);
    assert.equal(connected.data.profile?.id, "p-codex");
    assert.equal(connected.data.state.onboardingWizardOpen, false);
  } finally {
    await connected.close();
  }
});

test("账号探测显示等待；完成探测带登录状态标记；支持展开安装其他 Agent 并自动切到新装好的 CLI", async () => {
  const ui = await mount({ ...blank, installedAgents: ["claude-code", "codex"] });
  try {
    assert.match(ui.host.textContent!, /正在检查官方账号登录状态/);
    await ui.act(async () => ui.patch({ onboardingOfficial: { "claude-code": "ready", codex: "login" } }));
    assert.match(ui.host.textContent!, /已登录/);
    let finish: (value: boolean) => void = () => {};
    ui.data.connect = () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      });
    await ui.click("用 Claude Code 官方账号");
    assert.equal(ui.button("聊第一句，未完成").disabled, true);
    await ui.act(async () =>
      document.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    assert.equal(ui.data.state.onboardingWizardOpen, true);
    await ui.act(async () => finish(false));
    assert.equal(ui.button("聊第一句，未完成").disabled, false);

    // 展开「安装其他 Agent」；装好 kimi 后自动收起安装列表并切换到 Kimi Code
    await ui.click("安装其他 Agent");
    assert.ok(ui.button("收起安装列表"));
    await ui.act(async () => ui.patch({ onboardingOfficial: { "claude-code": "ready", codex: "login", kimi: "none" } }));
    await ui.rerender({ ...blank, installedAgents: ["claude-code", "codex", "kimi"] });
    assert.ok(ui.button("安装其他 Agent"), "新装好后自动收起安装列表");
    assert.equal(ui.button("Kimi Code").getAttribute("aria-pressed"), "true");
  } finally {
    await ui.close();
  }
});

test("安装在途：有忙碌反馈且不丢失安装界面，完成后恢复导航并可手动重新检测", async () => {
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
    await ui.click("重新检测");
    assert.ok(ui.requests.includes("loadAll"));
  } finally {
    await ui.close();
  }
});

test("项目卡整行可点击：三种入口分别派发原有请求", async () => {
  for (const [label, request] of [
    ["从头开始一个新课题：新建项目", "new"],
    ["资料已经在电脑上：添加已有文件夹", "add"],
    ["还没想好，先看个例子：创建示例课题", "demo"],
  ]) {
    const ui = await mount({ ...blank, profileCount: 1, userSessionCount: 1 });
    try {
      await ui.click(label);
      assert.deepEqual(ui.requests, [request]);
      assert.equal(ui.data.state.onboardingWizardOpen, false);
    } finally {
      await ui.close();
    }
  }
});

test("API Key 表单：支持明文切换、提交先测试再保存；失败保留输入并可重试；在途禁止改输入与跳走", async () => {
  const ui = await mount(blank, true);
  try {
    assert.equal(ui.button("测试并保存").disabled, true);
    const input = ui.host.querySelector<HTMLInputElement>("#onboarding-api-key")!;
    await ui.act(async () => {
      Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "test-key");
      input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
      const model = ui.host.querySelector<HTMLInputElement>("input[list]")!;
      Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, "value")!.set!.call(model, "claude-test");
      model.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
    });
    assert.equal(input.type, "password");
    await ui.click("显示密钥");
    assert.equal(input.type, "text");
    await ui.click("隐藏密钥");
    assert.equal(input.type, "password");

    assert.equal(ui.button("测试并保存").disabled, false, ui.host.textContent!);
    let fail: (reason: Error) => void = () => {};
    let probes = 0;
    ui.data.invoke = () => {
      probes++;
      return new Promise((_resolve, reject) => {
        fail = reject;
      });
    };
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
    assert.deepEqual(ui.requests, ["save", "bind", "loadAll", "connected"]);
  } finally {
    await ui.close();
  }
});

test("API Key 表单：选「其他服务商 / 中转」自填地址，地址不对不放行，保存只填这家 Agent 的协议槽", async () => {
  const ui = await mount(blank, true);
  try {
    const set = async (el: HTMLInputElement, value: string) => {
      await ui.act(async () => {
        Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, "value")!.set!.call(el, value);
        el.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
      });
    };
    await ui.pickOption("服务商", "自填地址");
    const url = ui.host.querySelector<HTMLInputElement>('input[type="url"]')!;
    assert.ok(url, "选中后出现 API 地址输入框");
    await set(ui.host.querySelector<HTMLInputElement>("#onboarding-api-key")!, "relay-key");
    await set(ui.host.querySelector<HTMLInputElement>("input[list]")!, "claude-relay");
    await set(url, "relay.example.com");
    assert.equal(ui.button("测试并保存").disabled, true);
    await set(url, "https://relay.example.com/api");
    assert.equal(ui.button("测试并保存").disabled, false);
    let saved: { name: string; slots: Record<string, string | null> } | null = null;
    let probedUrl = "";
    ui.data.invoke = async (_cmd?: string, args?: unknown) => {
      probedUrl = (args as { baseUrl: string }).baseUrl;
      return { ok: true, checks: [] };
    };
    await ui.act(async () =>
      ui.patch({
        saveGateway: async (_id: null, input: { name: string; slots: Record<string, string | null> }) => {
          saved = input;
          return { id: "gateway", name: input.name };
        },
      } as never),
    );
    await ui.act(async () => ui.host.querySelector("form")!.requestSubmit());
    assert.equal(probedUrl, "https://relay.example.com/api");
    assert.equal(saved!.name, "relay.example.com");
    assert.deepEqual(saved!.slots, {
      anthropic: "https://relay.example.com/api",
      openai: null,
      responses: null,
      gemini: null,
      cursor: null,
    });
    assert.deepEqual(ui.requests, ["bind", "loadAll", "connected"]);
  } finally {
    await ui.close();
  }
});

test("API Key 表单：填好 Key 离开输入框自动拉模型目录，MenuSelect 不预选目录第一个，选中后按它测试与保存", async () => {
  const ui = await mount(blank, true);
  try {
    const calls: string[] = [];
    let probedModel = "";
    ui.data.invoke = async (cmd?: string, args?: unknown) => {
      calls.push(String(cmd));
      if (cmd === "fetch_models") {
        return {
          models: ["gpt-search-broken", "claude-relay", "claude-relay"],
          fromCache: false,
          fetchedAt: "",
          capabilityMetadataCount: 0,
        };
      }
      probedModel = (args as { model?: string })?.model ?? "";
      return { ok: true, checks: [] };
    };
    const key = ui.host.querySelector<HTMLInputElement>("#onboarding-api-key")!;
    await ui.act(async () => {
      Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, "value")!.set!.call(key, "relay-key");
      key.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
    });
    await ui.act(async () => {
      key.dispatchEvent(new ui.dom.window.FocusEvent("focusout", { bubbles: true }));
    });
    assert.deepEqual(calls, ["fetch_models"]);
    const trigger = ui.button("默认模型");
    assert.match(trigger.textContent!, /选一个模型（共 2 个）/, "不替人预选目录第一个");
    assert.equal(ui.button("测试并保存").disabled, true);
    await ui.pickOption("默认模型", "claude-relay");
    await ui.act(async () => ui.host.querySelector("form")!.requestSubmit());
    assert.equal(probedModel, "claude-relay");
    assert.deepEqual(ui.requests, ["save", "bind", "loadAll", "connected"]);
  } finally {
    await ui.close();
  }
});

test("API Key 表单：已有兼容网关时默认可免重贴密钥一键测试并绑定", async () => {
  const ui = await mount(blank, true);
  try {
    await ui.act(async () =>
      ui.patch({
        gateways: [
          {
            id: "gw-existing",
            name: "DeepSeek",
            keyHint: "9f01",
            slots: { anthropic: "https://api.deepseek.com/anthropic", responses: "https://api.deepseek.com/v1" },
            models: [{ id: "deepseek-v4-pro", status: "available" }],
          },
        ],
      }),
    );
    await ui.click("复用已有网关（1）");
    let probeArgs: Record<string, unknown> | null = null;
    ui.data.invoke = async (_cmd?: string, args?: unknown) => {
      probeArgs = args as Record<string, unknown>;
      return { ok: true, checks: [] };
    };
    await ui.click("测试并绑定");
    assert.equal(probeArgs?.gatewayId, "gw-existing");
    assert.equal(probeArgs?.model, "deepseek-v4-pro");
    assert.deepEqual(ui.requests, ["bind", "loadAll", "connected"]);
  } finally {
    await ui.close();
  }
});

test("做完的步骤回来还能看过程：接上 AI 可展开「再接一个」也能手动「收起」，聊天与项目入口仍在", async () => {
  const facts = { ...blank, installedAgents: ["claude-code"], profileCount: 1, userSessionCount: 1, projectCount: 1 };
  const ui = await mount(facts);
  try {
    await ui.act(async () =>
      ui.patch({ profiles: [{ agent: "claude-code", name: "智谱" }], onboardingOfficial: { "claude-code": "ready" } }),
    );
    await ui.click("接上 AI，已完成");
    assert.match(ui.host.textContent!, /连接已添加/);
    await ui.click("再接一个");
    assert.ok(ui.button("收起"), "展开后可随时手动收起");
    assert.ok(ui.button("用 Claude Code 官方账号"), "原来的接入方式照样出现");
    await ui.click("收起");
    assert.ok(ui.button("再接一个"), "点收起后回到结果视图");
    await ui.click("再接一个");
    await ui.click("用 Claude Code 官方账号");
    assert.ok(ui.button("再接一个"), "接好后自动收回结果视图");
    await ui.click("聊第一句，已完成");
    assert.ok(ui.button("再发一次试试"));
    await ui.click("建第一个项目，已完成");
    assert.ok(ui.button("从头开始一个新课题：新建项目"));
  } finally {
    await ui.close();
  }
});

test("引导已收起或完成时从帮助回来看：底栏不再给「稍后再说 / 不再显示」", async () => {
  const ui = await mount();
  try {
    assert.ok(ui.button("不再显示"));
    await ui.act(async () => ui.patch({ onboarding: { status: "dismissed" } }));
    assert.equal(
      Array.from(ui.host.querySelectorAll("button")).some((b) => b.textContent?.trim() === "不再显示"),
      false,
    );
    assert.match(ui.host.querySelector("footer")!.textContent!, /引导已收起/);
  } finally {
    await ui.close();
  }
});

test("接好连接后给「装给 Claude Code」：人点了才分发内置技能，装完显示结果、没装的 CLI 不给", async () => {
  const facts = { ...blank, installedAgents: ["claude-code"], profileCount: 1 };
  const skill = (id: string, apps: Record<string, boolean>, source = "builtin") => ({
    id,
    name: id,
    source,
    apps,
    staleCopies: [],
  });
  let lib = [
    skill("lit-search", { "claude-code": false, codex: false }),
    skill("lit-notes", { "claude-code": true, codex: false }),
    skill("mine", { "claude-code": false }, "ccode"),
  ];
  const calls: string[] = [];
  const ui = await mount(facts);
  try {
    ui.data.invoke = async (cmd?: string, args?: unknown) => {
      const a = args as { id?: string; agent?: string } | undefined;
      if (cmd === "list_skills") return lib;
      if (cmd === "apply_skill") {
        calls.push(`${a?.id}:${a?.agent}`);
        lib = lib.map((s) => (s.id === a?.id ? { ...s, apps: { ...s.apps, [a!.agent!]: true } } : s));
      }
      return { ok: true, checks: [] };
    };
    await ui.act(async () =>
      ui.patch({ profiles: [{ agent: "claude-code", name: "智谱" }, { agent: "codex", name: "中转" }] }),
    );
    await ui.click("接上 AI，已完成");
    assert.deepEqual(calls, [], "打开向导不自动写 CLI 目录");
    assert.match(ui.host.textContent!, /还差 1 个/);
    assert.ok(!ui.host.textContent!.includes("装给 Codex"), "没装的 Codex 不给按钮");
    await ui.click("装给 Claude Code");
    assert.deepEqual(calls, ["lit-search:claude-code"], "只装内置、只补没装的");
    assert.match(ui.host.textContent!, /内置技能已装给 Claude Code/);
  } finally {
    await ui.close();
  }
});
