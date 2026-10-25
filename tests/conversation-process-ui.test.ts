import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// 对话里一轮的过程：「已工作 X 秒」收起 / 展开、一行一行的动作、点开看差异与输出（2026-10-18 用户：过程显示太粗糙）
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

const at = (s: number) => new Date(Date.UTC(2026, 9, 18, 1, 0, s)).toISOString();
const block = (kind: string, text: string, toolName: string | null = null) => ({ kind, text, toolName });
const m = (role: string, blocks: unknown[], s: number) => ({ role, blocks, timestamp: at(s), usage: null });

const CWD = "/Users/me/proj";
const MESSAGES = [
  m("user", [block("text", "把 toast 文案改成白话")], 0),
  m("assistant", [block("thinking", "Let me look at the card first.")], 3),
  m(
    "assistant",
    [
      block(
        "tool_use",
        JSON.stringify({
          file_path: `${CWD}/src/components/LitWatchCard.tsx`,
          old_string: "a\n已在流程清单 不在积累\nc\n旧",
          new_string: "a\n已在流程清单，还没加入积累\nc\n新",
        }),
        "Edit",
      ),
      block("tool_result", "The file has been updated successfully."),
    ],
    9,
  ),
  m("assistant", [block("text", "先把文案改成白话，再跑验证：")], 10),
  m(
    "assistant",
    [
      block("tool_use", JSON.stringify({ command: "npm test", description: "跑前端测试" }), "Bash"),
      block("tool_result", "# pass 12\n# fail 0"),
    ],
    250,
  ),
  m("assistant", [block("text", "改完并全绿了。")], 253),
];

test("一轮结束后收成「已工作 4 分 13 秒」，回答露在外面；不再原样摆 JSON 参数", async () => {
  const ui = await mount();
  try {
    await ui.render({ messages: MESSAGES, cwd: CWD });
    const text = ui.el.textContent ?? "";
    assert.match(text, /已工作 4 分 13 秒/);
    assert.match(text, /改了 1 个文件 · 运行 1 条命令/);
    assert.match(text, /改完并全绿了/);
    assert.doesNotMatch(text, /先把文案改成白话/, "中途说明收在过程里");
    assert.doesNotMatch(text, /file_path|old_string/);
    assert.equal(ui.button("已工作").getAttribute("aria-expanded"), "false");

    await ui.click("已工作");
    assert.equal(ui.button("已工作").getAttribute("aria-expanded"), "true");
    assert.match(ui.button("已工作").querySelector("svg")?.getAttribute("class") ?? "", /(^|\s)rotate-0/);
    const open = ui.el.textContent ?? "";
    assert.match(open, /思考3 秒/);
    assert.match(open, /编辑LitWatchCard\.tsxsrc\/components\/\+2−2/);
    assert.match(open, /先把文案改成白话/);
    assert.match(open, /运行跑前端测试npm test/);
    assert.doesNotMatch(open, /Let me look/, "思考正文要点开才看");
    assert.doesNotMatch(open, /file_path|old_string/);
  } finally {
    await ui.close();
  }
});

test("点一行看细节：编辑画差异、能跳到改动面板；命令给命令与输出；思考给正文", async () => {
  const ui = await mount();
  try {
    await ui.render({ messages: MESSAGES, cwd: CWD });
    await ui.click("已工作");
    await ui.click("LitWatchCard.tsx");
    const diff = ui.el.textContent ?? "";
    assert.match(diff, /已在流程清单 不在积累/);
    assert.match(diff, /已在流程清单，还没加入积累/);
    assert.ok(ui.el.querySelector(".bg-diff-add-bg") && ui.el.querySelector(".bg-diff-del-bg"));
    await ui.click("在改动里查看");
    assert.deepEqual(ui.store.getState().diffFocusReq, { cwd: CWD, path: "src/components/LitWatchCard.tsx" });

    await ui.click("跑前端测试");
    assert.match(ui.el.textContent ?? "", /\$ npm test# pass 12/);
    await ui.click("思考");
    assert.match(ui.el.textContent ?? "", /Let me look at the card first\./);
  } finally {
    await ui.close();
  }
});

test("还在生成的一轮：不收起、没有「已工作」，说到一半的正文跟在过程后面", async () => {
  const ui = await mount();
  try {
    await ui.render({ messages: MESSAGES.slice(0, 4), cwd: CWD, working: true });
    const text = ui.el.textContent ?? "";
    assert.doesNotMatch(text, /已工作/);
    assert.match(text, /编辑LitWatchCard\.tsx/);
    assert.match(text, /先把文案改成白话/);
  } finally {
    await ui.close();
  }
});

test("失败的步骤：收起时标在「已工作」后面，展开后那一行写明", async () => {
  const ui = await mount();
  try {
    await ui.render({
      messages: [
        m("user", [block("text", "跑测试")], 0),
        m(
          "assistant",
          [block("tool_use", JSON.stringify({ command: "npm test" }), "Bash"), block("tool_result", "Exit code 1\nnpm ERR!")],
          5,
        ),
        m("assistant", [block("text", "测试挂了")], 6),
      ],
      cwd: CWD,
    });
    assert.match(ui.el.textContent ?? "", /1 步没成功/);
    await ui.click("已工作");
    assert.match(ui.el.textContent ?? "", /运行npm test失败/);
  } finally {
    await ui.close();
  }
});

test("没有时长的一轮：摘要本身就是那一行，不再前缀「过程 ·」（2026-10-25）", async () => {
  const ui = await mount();
  try {
    const noTime = MESSAGES.map((x) => ({ ...x, timestamp: null }));
    await ui.render({ messages: noTime, cwd: CWD });
    const text = ui.el.textContent ?? "";
    assert.match(text, /改了 1 个文件 · 运行 1 条命令/);
    assert.doesNotMatch(text, /过程/);
    assert.equal(ui.button("运行 1 条命令").getAttribute("aria-expanded"), "false");
  } finally {
    await ui.close();
  }
});

test("悬停操作浮着不占高度：用户的贴在气泡里（左侧浮出），回答的挂在回答下面（2026-10-25）", async () => {
  const ui = await mount();
  try {
    await ui.render({
      messages: [m("user", [block("text", "你好")], 0), m("assistant", [block("text", "你好！")], 2)],
      onEditResend: () => {},
    });
    const edit = ui.button("编辑后重发").parentElement!;
    assert.match(edit.className, /(^|\s)absolute(\s|$)/);
    assert.ok(edit.closest(".rounded-2xl"), "用户消息的操作在气泡里，往左浮出");
    const copies = Array.from(ui.el.querySelectorAll("button")).filter((b) => b.textContent?.includes("复制"));
    assert.equal(copies.length, 2);
    for (const b of copies) assert.match(b.parentElement!.className, /(^|\s)absolute(\s|$)/);
  } finally {
    await ui.close();
  }
});
