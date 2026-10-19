import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  stdin: {
    contents: `export {createElement, act} from 'react'; export {createRoot} from 'react-dom/client'; export {default as Dialog} from './src/components/SessionSlimDialog';`,
    resolveDir: process.cwd(), loader: "tsx",
  },
  bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
  external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
  plugins: [{ name: "slim-host", setup(b) {
    const stubs: Record<string, string> = {
      "@tauri-apps/plugin-opener": `export const revealItemInDir = async (p) => { window.__slimUi.revealed.push(p); };`,
    };
    b.onResolve({ filter: /.*/ }, (args) => args.path in stubs ? { path: args.path, namespace: "slim-stub" } : undefined);
    b.onLoad({ filter: /.*/, namespace: "slim-stub" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
  } }],
});

const MB = 1024 * 1024;

function inspect(over: Record<string, unknown> = {}) {
  return {
    supported: true, fileBytes: 68 * MB, scanned: true, mediaCount: 65, mediaBytes: 32 * MB,
    bodyBytes: 33 * MB, level: "danger", removable: 59, keep: 6, recentlyWritten: false, ...over,
  };
}

const applied = {
  removed: 59, kept: 6, bytesBefore: 68 * MB, bytesAfter: 10 * MB, bodyBefore: 34 * MB, bodyAfter: 5 * MB,
  backupPath: "/cfg/backups/session-slim/s-20261019.jsonl",
};

async function mount(props: Record<string, unknown>, options: { applyError?: string } = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const calls: Array<{ command: string; args: any }> = [];
  const events: string[] = [];
  Object.assign(dom.window, {
    __slimUi: { revealed: [] as string[] },
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: any) => {
        calls.push({ command, args });
        if (command === "session_slim_apply") {
          if (options.applyError) throw new Error(options.applyError);
          return applied;
        }
        throw new Error(`Unexpected IPC: ${command}`);
      },
    },
  });
  const compiled = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(
    createRequire(import.meta.url), compiled, compiled.exports,
  );
  const { createElement: h, act, createRoot, Dialog } = compiled.exports;
  const el = dom.window.document.getElementById("root")!;
  const root = createRoot(el);
  await act(async () => root.render(h(Dialog, {
    agent: "claude-code", filePath: "/home/.claude/projects/p/s.jsonl", inspect: inspect(),
    runningInMesaTab: false,
    onClose: () => events.push("close"), onApplied: () => events.push("applied"), onResume: () => events.push("resume"),
    ...props,
  })));
  const button = (text: string) => {
    const found = Array.from(el.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);
    assert.ok(found, `缺少按钮：${text}`);
    return found as HTMLButtonElement;
  };
  return {
    el, calls, events, button, revealed: (dom.window as any).__slimUi.revealed as string[],
    click: (text: string) => act(async () => button(text).click()),
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

test("确认弹层：先讲清动什么不动什么，只瘦身 → 带正确参数调用，显示结果、备份位置与客户端提醒", async () => {
  const ui = await mount({});
  try {
    const text = ui.el.textContent ?? "";
    assert.match(text, /65 张截图/);
    assert.match(text, /较早的 59 张/);
    assert.match(text, /最近 6 张/);
    assert.match(text, /完整备份/);
    await ui.click("只瘦身");
    assert.deepEqual(ui.calls, [{
      command: "session_slim_apply",
      args: { agent: "claude-code", filePath: "/home/.claude/projects/p/s.jsonl", keep: 6 },
    }]);
    assert.deepEqual(ui.events, ["applied"]);
    const after = ui.el.textContent ?? "";
    assert.match(after, /已移除 59 张较早的截图/);
    assert.match(after, /原会话文件已完整备份/);
    assert.match(after, /s-20261019\.jsonl/);
    assert.match(after, /归档再恢复一次/);
    await ui.click("/cfg/backups/session-slim/s-20261019.jsonl");
    assert.deepEqual(ui.revealed, ["/cfg/backups/session-slim/s-20261019.jsonl"]);
    await ui.click("在终端继续");
    assert.deepEqual(ui.events, ["applied", "close", "resume"]);
  } finally {
    await ui.close();
  }
});

test("瘦身并在终端继续：成功后依次回调 applied → close → resume，不停留在结果页", async () => {
  const ui = await mount({});
  try {
    await ui.click("瘦身并在终端继续");
    assert.equal(ui.calls.length, 1);
    assert.deepEqual(ui.events, ["applied", "close", "resume"]);
  } finally {
    await ui.close();
  }
});

test("被拦时（Mesa 终端里在跑 / 最近一分钟有写入）：两个动作都不可点，也不会调用后端", async () => {
  for (const [props, reason] of [
    [{ runningInMesaTab: true }, /终端标签/],
    [{ inspect: inspect({ recentlyWritten: true }) }, /最近一分钟/],
  ] as const) {
    const ui = await mount(props);
    try {
      assert.match(ui.el.textContent ?? "", reason);
      assert.equal(ui.button("只瘦身").disabled, true);
      assert.equal(ui.button("瘦身并在终端继续").disabled, true);
      await ui.click("只瘦身");
      assert.equal(ui.calls.length, 0);
    } finally {
      await ui.close();
    }
  }
});

test("后端拒绝或失败：显示原因，不出现结果页，按钮恢复可再点", async () => {
  const ui = await mount({}, { applyError: "瘦身过程中这条会话又有新写入，已放弃（原文件没有改动）。" });
  try {
    await ui.click("只瘦身");
    const text = ui.el.textContent ?? "";
    assert.match(text, /又有新写入/);
    assert.doesNotMatch(text, /已移除/);
    assert.equal(ui.button("只瘦身").disabled, false);
    assert.deepEqual(ui.events, []);
  } finally {
    await ui.close();
  }
});
