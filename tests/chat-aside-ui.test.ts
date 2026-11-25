import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// 聊天页右侧全高「侧边提问（Side Question）」分栏 UI 行为测试（components/ChatAsideCard.tsx）：
// 覆盖顶栏开合、多页签新建与隔离历史、收起保留记录、关单条、带入主框与切主会话重置。
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
          containerWidth: props.containerWidth ?? 1200,
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
  const { act, createRoot, createElement: h, Harness } = compiled.exports;
  const el = dom.window.document.getElementById("root")!;
  const root = createRoot(el);
  let curProps: Record<string, unknown> = { sessionId: "sid-1", agentId: "claude-code", ...initialProps };
  await act(async () => root.render(h(Harness, curProps)));
  return {
    el,
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

test("右侧 Side Question 分栏：多页签独立历史、收起保留记录、关闭单条与带入主框", async () => {
  const ctx = await mount({ sessionId: "sid-1", sessionFile: "/tmp/s1.jsonl", agentId: "claude-code" });
  try {
    assert.equal(ctx.el.querySelector('[data-testid="chat-aside-pane"]'), null);

    // 1. 顶栏按钮翻转展开右侧分栏，进入极简空态
    await ctx.rerender({ toggleRequest: 1 });
    const pane = () => ctx.el.querySelector<HTMLElement>('[data-testid="chat-aside-pane"]');
    assert.ok(pane());
    assert.match(pane()!.textContent!, /不打断主对话，在旁边随口问一句/);
    assert.equal(ctx.host.summary.open, true);

    // 2. 第一条线程提问（自动把首问设为页签标题）
    await ctx.act(async () => {
      ctx.host.latest.openCard("做到哪了？");
      await new Promise((r) => setTimeout(r, 10));
    });
    assert.equal(ctx.host.calls.length, 1);
    assert.deepEqual(ctx.host.calls[0].history, []);
    assert.match(pane()!.textContent!, /做到哪了？/);
    assert.match(pane()!.textContent!, /只读分身/);
    assert.match(pane()!.textContent!, /目前改到了第 2 个字段/);

    // 3. 在同一线程里连续追问 → 自动带上第一轮 history
    ctx.host.nextReply = {
      text: "旧列名含空格会导致 CSV 错位。",
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
    assert.match(pane()!.textContent!, /Codex 代答/);

    // 4. 点顶部「+」新建第二条独立侧边提问线程：上下文完全隔离，history 为空
    const addBtn = pane()!.querySelector<HTMLButtonElement>('button[aria-label="新建侧边提问"]')!;
    await ctx.act(async () => addBtn.click());
    assert.equal(pane()!.querySelectorAll('[role="tab"]').length, 2);
    assert.match(pane()!.textContent!, /不打断主对话，在旁边随口问一句/);

    ctx.host.nextReply = {
      text: "一共改了 3 个测试文件。",
      how: "fork",
      costUsd: 0.002,
      responderAgent: "claude-code",
      responderProfile: "Claude 主号",
    };
    await ctx.act(async () => {
      ctx.host.latest.openCard("动了几个测试文件？");
      await new Promise((r) => setTimeout(r, 10));
    });
    assert.equal(ctx.host.calls.length, 3);
    assert.deepEqual(ctx.host.calls[2].history, []);
    assert.equal(ctx.host.summary.activeThreads, 2);

    // 5. 点「带入主输入框」传给主框
    const insertBtn = Array.from(pane()!.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("带入主输入框"),
    )!;
    await ctx.act(async () => insertBtn.click());
    assert.deepEqual(ctx.host.inserted, ["一共改了 3 个测试文件。"]);

    // 6. 收起右侧栏：记录保留、上报 activeThreads 仍为 2、焦点还给主框
    const collapseBtn = pane()!.querySelector<HTMLButtonElement>('button[aria-label="收起侧边提问栏"]')!;
    await ctx.act(async () => collapseBtn.click());
    assert.equal(pane(), null);
    assert.equal(ctx.host.summary.open, false);
    assert.equal(ctx.host.summary.activeThreads, 2);
    assert.equal(ctx.host.returnedFocus, 1);

    // 7. 再次通过顶栏打开：2 条页签记录完整保留
    await ctx.rerender({ toggleRequest: 2 });
    assert.ok(pane());
    assert.equal(pane()!.querySelectorAll('[role="tab"]').length, 2);

    // 8. 关掉第二条页签，切回第一条；再关掉第一条，自动收起分栏
    const closeSecond = pane()!.querySelector<HTMLButtonElement>('button[aria-label="关闭「动了几个测试文件？」"]')!;
    await ctx.act(async () => closeSecond.click());
    assert.equal(pane()!.querySelectorAll('[role="tab"]').length, 1);
    assert.match(pane()!.textContent!, /目前改到了第 2 个字段/);

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
