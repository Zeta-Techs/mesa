import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// 聊天正文排版（2026-10-21）：AI 长回复整段按 Markdown 排、用户长消息收起渐隐、围栏代码同一套代码块、一问一答的节奏、过程里的中途说明降一级
const bundle = await build({
  stdin: {
    contents: `export {createElement, act} from 'react'; export {createRoot} from 'react-dom/client';
      export {default as Conversation} from './src/components/ConversationView';
      export {useAppStore} from './src/store';`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  jsx: "automatic",
  loader: { ".css": "empty", ".png": "dataurl" },
  external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
  plugins: [
    {
      name: "conversation-host",
      setup(b) {
        const stubs: Record<string, string> = {
          "./ChatMarkdown": `import { createElement } from 'react';
            export default function ChatMarkdown(p) { return createElement('div', { 'data-md': '1' }, p.text); }
            export function ChatImageCard() { return null; }
            export function ChatCodeBlock(p) { return createElement('pre', { 'data-code': p.lang }, p.text); }`,
        };
        b.onResolve({ filter: /.*/ }, (args) =>
          args.path in stubs ? { path: args.path, namespace: "conv-stub" } : undefined,
        );
        b.onLoad({ filter: /.*/, namespace: "conv-stub" }, (args) => ({
          contents: stubs[args.path],
          loader: "js",
          resolveDir: process.cwd(),
        }));
      },
    },
  ],
});

async function mount() {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  Object.assign(dom.window, {
    __TAURI_INTERNALS__: {
      invoke: async (command: string) => {
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
  const { createElement: h, act, createRoot, Conversation, useAppStore } = compiled.exports;
  const el = dom.window.document.getElementById("root")!;
  const root = createRoot(el);
  const render = (props: Record<string, unknown>) => act(async () => root.render(h(Conversation, props)));
  const button = (text: string) => {
    const found = Array.from(el.querySelectorAll("button")).find((b) => b.textContent?.includes(text));
    assert.ok(found, `缺少按钮：${text}`);
    return found as HTMLButtonElement;
  };
  const click = (text: string) => act(async () => button(text).click());
  return {
    el,
    render,
    button,
    click,
    store: useAppStore,
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, d] of restore) {
        if (d) Object.defineProperty(globalThis, key, d);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}

const at = (s: number) => new Date(Date.UTC(2026, 9, 21, 1, 0, s)).toISOString();
const block = (kind: string, text: string, toolName: string | null = null) => ({ kind, text, toolName });
const m = (role: string, blocks: unknown[], s: number) => ({ role, blocks, timestamp: at(s), usage: null });

test("AI 长回复整段交给 Markdown，不再截成原文要点「展开全部」", async () => {
  const ui = await mount();
  try {
    const long = `## 结论\n\n${"**加粗**的长段落。".repeat(600)}`;
    assert.ok(long.length > 4000);
    await ui.render({ messages: [m("user", [block("text", "讲讲")], 0), m("assistant", [block("text", long)], 5)] });
    const md = ui.el.querySelector("[data-md]");
    assert.equal(md?.textContent, long);
    assert.ok(!Array.from(ui.el.querySelectorAll("button")).some((b) => b.textContent?.includes("展开全部")));
  } finally {
    await ui.close();
  }
});

test("用户消息：大圆角气泡、新问题前拉开；围栏代码走同一套代码块；超长收起后可展开", async () => {
  const ui = await mount();
  try {
    const pasted = "日志一行\n".repeat(600);
    await ui.render({
      messages: [
        m("user", [block("text", "看这段：\n```python\nprint(1)\n```\n怎么样")], 0),
        m("assistant", [block("text", "可以。")], 3),
        m("user", [block("text", pasted)], 6),
      ],
    });
    const rows = ui.el.querySelectorAll(".ccode-chat-user-row");
    assert.equal(rows.length, 2);
    assert.ok(rows[0]!.querySelector(".rounded-2xl.ccode-chat-user"));
    assert.equal(ui.el.querySelector("pre[data-code]")?.getAttribute("data-code"), "python");
    assert.equal(ui.el.querySelector("pre[data-code]")?.textContent, "print(1)");
    const clamp = rows[1]!.querySelector(".ccode-chat-clamp");
    assert.ok(clamp, "长消息收起");
    assert.ok((clamp!.textContent ?? "").length < pasted.length);
    await ui.click("展开全部");
    assert.equal(rows[1]!.querySelector(".ccode-chat-clamp"), null);
    assert.ok((rows[1]!.textContent ?? "").includes(pasted.trim()));
    assert.ok(ui.button("收起"));
    // 短消息不挂渐隐
    assert.equal(rows[0]!.querySelector(".ccode-chat-clamp"), null);
  } finally {
    await ui.close();
  }
});

test("做完的一轮里，中途说明降一级（ccode-chat-aside）；还在写时不降", async () => {
  const turn = [
    m("user", [block("text", "改一下")], 0),
    m("assistant", [block("text", "我先看看文件。")], 2),
    m("assistant", [block("tool_use", JSON.stringify({ command: "ls" }), "Bash"), block("tool_result", "a.ts")], 3),
    m("assistant", [block("text", "改好了。")], 9),
  ];
  const ui = await mount();
  try {
    await ui.render({ messages: turn });
    await ui.click("已工作");
    const aside = ui.el.querySelector(".ccode-chat-aside");
    assert.equal(aside?.textContent, "我先看看文件。");
    await ui.render({ messages: turn.slice(0, 3), working: true });
    assert.equal(ui.el.querySelector(".ccode-chat-aside"), null);
  } finally {
    await ui.close();
  }
});

test("排队气泡按这家 CLI 的行为写，「立即发送」只挂在最后一条排着的气泡上", async () => {
  const ui = await mount();
  try {
    let pressed = 0;
    const queued = (text: string, s: number) => ({ ...m("user", [block("text", text)], s), queued: true });
    await ui.render({
      messages: [m("user", [block("text", "先跑测试")], 0), queued("顺便看 lint", 5), queued("再看类型", 6)],
      working: true,
      queuedNote: {
        text: "下一步时交给它",
        title: "t",
        action: { label: "立即发送", title: "按 Esc", onClick: () => pressed++ },
      },
    });
    const notes = Array.from(ui.el.querySelectorAll('span[title="t"]'));
    assert.deepEqual(notes.map((n) => n.textContent), ["下一步时交给它", "下一步时交给它"]);
    const buttons = Array.from(ui.el.querySelectorAll("button")).filter((b) => b.textContent === "立即发送");
    assert.equal(buttons.length, 1);
    await ui.click("立即发送");
    assert.equal(pressed, 1);
  } finally {
    await ui.close();
  }
});
