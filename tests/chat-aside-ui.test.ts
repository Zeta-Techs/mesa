import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// 聊天页「问它一句（不打断）」浮卡 UI 行为测试（components/ChatAsideCard.tsx）：
// 覆盖直发 /btw、多轮追问带 history、代答徽标展示、带入主输入框、收起展开与关闭清空。
const bundle = await build({
  stdin: {
    contents: `import { createElement } from 'react';
      import { useChatAside } from './src/components/ChatAsideCard';
      export { act } from 'react';
      export { createRoot } from 'react-dom/client';
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
          narrow: false,
          onInsertToMain: (text) => window.__aside.inserted.push(text),
          onReturnFocus: () => { window.__aside.returnedFocus += 1; },
        });
        window.__aside.latest = aside;
        return createElement('div', null, aside.panel);
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
      },
    },
  ],
});

async function mount(initialProps: Record<string, unknown> = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
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
  const { act, createRoot, createElement: h, Harness } = compiled.exports;
  const el = dom.window.document.getElementById("root")!;
  const root = createRoot(el);
  const props = { sessionId: "sid-1", agentId: "claude-code", ...initialProps };
  await act(async () => root.render(h(Harness, props)));
  return {
    el,
    host,
    act,
    rerender: async (next: Record<string, unknown>) => {
      await act(async () => root.render(h(Harness, { ...props, ...next })));
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

test("聊天侧边浮卡：直发 /btw、多轮追问带 history、带入主框与关闭清空", async () => {
  const ctx = await mount({ sessionId: "sid-1", sessionFile: "/tmp/s1.jsonl", agentId: "claude-code" });
  try {
    assert.equal(ctx.el.querySelector('[data-testid="chat-aside-card"]'), null);

    // 1. 直接带问题打开（模拟主框敲 `/btw 做到哪了？`）
    await ctx.act(async () => {
      ctx.host.latest.openCard("做到哪了？");
      await new Promise((r) => setTimeout(r, 10));
    });
    assert.equal(ctx.host.calls.length, 1);
    assert.equal(ctx.host.calls[0].question, "做到哪了？");
    assert.equal(ctx.host.calls[0].filePath, "/tmp/s1.jsonl");
    assert.deepEqual(ctx.host.calls[0].history, []);
    const card = ctx.el.querySelector<HTMLElement>('[data-testid="chat-aside-card"]')!;
    assert.ok(card);
    assert.match(card.textContent!, /只读分身/);
    assert.match(card.textContent!, /目前改到了第 2 个字段/);

    // 2. 卡内追问第二句：自动把第一轮问答带进 history
    ctx.host.nextReply = {
      text: "因为旧列名带空格，导出 CSV 会错位。",
      how: "delegate",
      costUsd: null,
      responderAgent: "codex",
      responderProfile: "Codex 只读",
    };
    await ctx.act(async () => {
      ctx.host.latest.openCard("为什么改列名？");
      await new Promise((r) => setTimeout(r, 10));
    });
    assert.equal(ctx.host.calls.length, 2);
    assert.deepEqual(ctx.host.calls[1].history, [
      { question: "做到哪了？", answer: "目前改到了第 2 个字段。" },
    ]);
    assert.match(card.textContent!, /Codex 代答/);

    // 3. 点「带入主输入框」：把对应回答传给主输入框并自动折叠浮卡
    const insertBtns = Array.from(card.querySelectorAll<HTMLButtonElement>("button")).filter((b) =>
      b.textContent?.includes("带入主输入框"),
    );
    assert.equal(insertBtns.length, 2);
    await ctx.act(async () => insertBtns[1].click());
    assert.deepEqual(ctx.host.inserted, ["因为旧列名带空格，导出 CSV 会错位。"]);
    assert.match(card.textContent!, /2 轮/);

    // 4. 点关闭钮：浮卡消失并归还焦点给主框
    const closeBtn = card.querySelector<HTMLButtonElement>('button[aria-label="关闭侧边问答"]')!;
    await ctx.act(async () => closeBtn.click());
    assert.equal(ctx.el.querySelector('[data-testid="chat-aside-card"]'), null);
    assert.equal(ctx.host.returnedFocus, 1);
  } finally {
    await ctx.cleanup();
  }
});

test("聊天侧边浮卡：切到另一段会话自动重置，不串台", async () => {
  const ctx = await mount({ sessionId: "sid-A", agentId: "gemini" });
  try {
    await ctx.act(async () => {
      ctx.host.latest.openCard("总结一下这段");
      await new Promise((r) => setTimeout(r, 10));
    });
    assert.ok(ctx.el.querySelector('[data-testid="chat-aside-card"]'));

    await ctx.rerender({ sessionId: "sid-B" });
    assert.equal(ctx.el.querySelector('[data-testid="chat-aside-card"]'), null);
  } finally {
    await ctx.cleanup();
  }
});
