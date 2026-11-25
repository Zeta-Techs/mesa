import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// 聊天页右侧全高「侧边提问（Side Question）」分栏 UI 行为测试（components/ChatAsideCard.tsx）：
// 覆盖顶栏开合、多页签新建与隔离历史、收起保留记录、关单条、带入主框、侧边独立选模型与切主会话重置。
const bundle = await build({
  stdin: {
    contents: `import { createElement } from 'react';
      import { useChatAside } from './src/components/ChatAsideCard';
      export { act } from 'react';
      export { createRoot } from 'react-dom/client';
      export { useAppStore } from './src/store';
      export { createElement };
      export function Harness(props) {
        const aside = useChatAside({
          sessionId: props.sessionId,
          sessionFile: props.sessionFile ?? null,
          agentId: props.agentId,
          profileId: props.profileId ?? 'p-1',
          model: props.model ?? 'claude-sonnet-4-5',
          cwd: props.cwd ?? '/repo/demo',
          messages: props.messages ?? [{ role: 'user', timestamp: null, blocks: [{ kind: 'text', text: '帮我改下列名' }] }],
          containerWidth: props.containerWidth ?? 1200,
          asideSlot: props.asideSlot ?? null,
          toggleRequest: props.toggleRequest ?? 0,
          onSummaryChange: (s) => { window.__aside.summary = s; },
          onInsertToMain: (text) => window.__aside.inserted.push(text),
          onReturnFocus: () => { window.__aside.returnedFocus += 1; },
        });
        window.__aside.latest = aside;
        return createElement('div', null, aside.pane);
      }`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  jsx: "automatic",
  loader: { ".css": "empty", ".png": "dataurl", ".svg": "empty" },
  external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
  plugins: [
    {
      name: "aside-ui-stubs",
      setup(b) {
        b.onResolve({ filter: /^\.\/ChatMarkdown$/ }, () => ({ path: "chat-md-stub", namespace: "stub" }));
        b.onLoad({ filter: /^chat-md-stub$/, namespace: "stub" }, () => ({
          contents: `import { createElement } from 'react'; export default function ChatMarkdown({ text }) { return createElement('div', { 'data-testid': 'aside-md' }, text); }`,
          loader: "js",
        }));
        b.onResolve({ filter: /\.svg\?raw$/ }, (args) => ({ path: args.path, namespace: "svg-raw" }));
        b.onLoad({ filter: /.*/, namespace: "svg-raw" }, () => ({
          contents: `export default "<svg></svg>";`,
          loader: "js",
        }));
      },
    },
  ],
});

async function mount(initialProps: Record<string, unknown> = {}) {
  const dom = new JSDOM('<div id="root"></div><div id="slot"></div>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const host = {
    calls: [] as Array<Record<string, any>>,
    inserted: [] as string[],
    returnedFocus: 0,
    summary: null as any,
    latest: null as any,
    nextReply: {
      text: "目前改到了第 2 个字段。",
      how: "fork",
      costUsd: 0.004,
      responderAgent: "claude-code",
      responderProfile: "Claude 主号",
    },
  };
  Object.assign(dom.window, {
    __aside: host,
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args?: any) => {
        if (command === "chat_ask_aside") {
          host.calls.push(args.req);
          return host.nextReply;
        }
        throw new Error(`Unexpected IPC: ${command}`);
      },
    },
  });
  const compiled = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(
    createRequire(import.meta.url),
    compiled,
    compiled.exports,
  );
  const { act, createRoot, createElement: h, Harness, useAppStore } = compiled.exports;
  useAppStore.setState({
    profiles: [
      { id: "p-claude", agent: "claude-code", name: "Claude 主号", models: ["claude-sonnet-4-5", "claude-haiku-4-5"], extraEnv: {}, hasKey: true },
      { id: "p-codex", agent: "codex", name: "Codex 网关", models: ["gpt-5.2"], extraEnv: {}, hasKey: true },
    ],
    agents: [
      { id: "claude-code", binaryPath: "/usr/local/bin/claude" },
      { id: "codex", binaryPath: "/usr/local/bin/codex" },
    ],
  });
  const el = dom.window.document.getElementById("root")!;
  const slot = dom.window.document.getElementById("slot")!;
  const root = createRoot(el);
  let curProps: Record<string, unknown> = { sessionId: "sid-1", agentId: "claude-code", ...initialProps };
  await act(async () => root.render(h(Harness, curProps)));
  return {
    el,
    slot,
    doc: dom.window.document,
    host,
    act,
    rerender: async (next: Record<string, unknown>) => {
      curProps = { ...curProps, ...next };
      await act(async () => root.render(h(Harness, curProps)));
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      for (const [key, desc] of restore) {
        if (desc) Object.defineProperty(globalThis, key, desc);
        else delete (globalThis as any)[key];
      }
      dom.window.close();
    },
  };
}

test("右侧 Side Question 分栏：portal 挂入右列、独立切模型、多页签隔离、收起保留与关闭单条", async () => {
  const ctx = await mount({ sessionId: "sid-1", sessionFile: "/tmp/s1.jsonl", agentId: "claude-code" });
  try {
    await ctx.rerender({ asideSlot: ctx.slot, toggleRequest: 1 });
    const pane = () => ctx.slot.querySelector<HTMLElement>('[data-testid="chat-aside-pane"]');
    assert.ok(pane(), "宽屏应 portal 到 pane-body 右列插槽，避免主状态栏横穿");
    assert.match(pane()!.textContent!, /不打断主对话，在旁边随口问一句/);
    assert.equal(ctx.host.summary.open, true);

    // 1. 底部模型选择器：切到 Codex 网关的 gpt-5.2
    const trigger = pane()!.querySelector<HTMLButtonElement>('[data-testid="aside-model-trigger"]')!;
    assert.match(trigger.textContent!, /自动跟随/);
    await ctx.act(async () => trigger.click());
    const menuItems = Array.from(pane()!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
    const codexOpt = menuItems.find((b) => b.textContent?.includes("gpt-5.2"))!;
    assert.ok(codexOpt);
    await ctx.act(async () => codexOpt.click());
    assert.match(trigger.textContent!, /gpt-5\.2/);

    // 2. 第一条线程提问：请求携带显式 overrideProfileId 与 overrideModel
    ctx.host.nextReply = {
      text: "目前改到了第 2 个字段。",
      how: "delegate",
      costUsd: 0.004,
      responderAgent: "codex",
      responderProfile: "Codex 网关",
    };
    await ctx.act(async () => {
      ctx.host.latest.openCard("做到哪了？");
      await new Promise((r) => setTimeout(r, 10));
    });
    assert.equal(ctx.host.calls.length, 1);
    assert.equal(ctx.host.calls[0].overrideProfileId, "p-codex");
    assert.equal(ctx.host.calls[0].overrideModel, "gpt-5.2");
    assert.deepEqual(ctx.host.calls[0].history, []);
    assert.match(pane()!.textContent!, /Codex 代答/);
    assert.match(pane()!.textContent!, /目前改到了第 2 个字段/);

    // 3. 切回「自动跟随」并在同线程追问：override 回到 null、history 带上一轮
    await ctx.act(async () => trigger.click());
    const autoOpt = Array.from(pane()!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find((b) =>
      b.textContent?.includes("自动跟随"),
    )!;
    await ctx.act(async () => autoOpt.click());
    ctx.host.nextReply = {
      text: "旧列名含空格会导致 CSV 错位。",
      how: "fork",
      costUsd: null,
      responderAgent: "claude-code",
      responderProfile: "Claude 主号",
    };
    await ctx.act(async () => {
      ctx.host.latest.openCard("为什么改列名？");
      await new Promise((r) => setTimeout(r, 10));
    });
    assert.equal(ctx.host.calls.length, 2);
    assert.equal(ctx.host.calls[1].overrideProfileId, null);
    assert.equal(ctx.host.calls[1].overrideModel, null);
    assert.deepEqual(ctx.host.calls[1].history, [
      { question: "做到哪了？", answer: "目前改到了第 2 个字段。" },
    ]);

    // 4. 点顶部「+」新建第二条独立侧边提问线程：上下文完全隔离
    const addBtn = pane()!.querySelector<HTMLButtonElement>('button[aria-label="新建侧边提问"]')!;
    await ctx.act(async () => addBtn.click());
    assert.equal(pane()!.querySelectorAll('[role="tab"]').length, 2);

    await ctx.act(async () => {
      ctx.host.latest.openCard("动了几个测试文件？");
      await new Promise((r) => setTimeout(r, 10));
    });
    assert.equal(ctx.host.calls.length, 3);
    assert.deepEqual(ctx.host.calls[2].history, []);
    assert.equal(ctx.host.summary.activeThreads, 2);

    // 5. 收起保留记录 → 再次打开仍在 → 关掉全部页签自动收起
    const collapseBtn = pane()!.querySelector<HTMLButtonElement>('button[aria-label="收起侧边提问栏"]')!;
    await ctx.act(async () => collapseBtn.click());
    assert.equal(pane(), null);
    assert.equal(ctx.host.summary.activeThreads, 2);
    assert.equal(ctx.host.returnedFocus, 1);

    await ctx.rerender({ toggleRequest: 2 });
    assert.equal(pane()!.querySelectorAll('[role="tab"]').length, 2);

    const closeSecond = pane()!.querySelector<HTMLButtonElement>('button[aria-label="关闭「动了几个测试文件？」"]')!;
    await ctx.act(async () => closeSecond.click());
    const closeFirst = pane()!.querySelector<HTMLButtonElement>('button[aria-label="关闭「做到哪了？」"]')!;
    await ctx.act(async () => closeFirst.click());
    assert.equal(pane(), null);
    assert.equal(ctx.host.summary.activeThreads, 0);
  } finally {
    await ctx.cleanup();
  }
});

test("右侧 Side Question 分栏：切到另一段主会话自动清空不串台", async () => {
  const ctx = await mount({ sessionId: "sid-A", agentId: "gemini" });
  try {
    await ctx.act(async () => {
      ctx.host.latest.openCard("总结一下这段");
      await new Promise((r) => setTimeout(r, 10));
    });
    assert.ok(ctx.el.querySelector('[data-testid="chat-aside-pane"]'));

    await ctx.rerender({ sessionId: "sid-B" });
    assert.equal(ctx.el.querySelector('[data-testid="chat-aside-pane"]'), null);
    assert.equal(ctx.host.summary.activeThreads, 0);
  } finally {
    await ctx.cleanup();
  }
});
