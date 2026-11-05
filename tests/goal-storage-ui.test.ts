import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  stdin: {
    contents: `export {createElement, act} from 'react'; export {createRoot} from 'react-dom/client'; export {default as Modal} from './src/components/GoalStorageModal';`,
    resolveDir: process.cwd(), loader: "tsx",
  },
  bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
  external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
  plugins: [{ name: "storage-host", setup(b) {
    const stubs: Record<string, string> = {
      "./ConfirmDialog": `export const confirmDialog = async (text, opts) => {
        window.__storageUi.confirmations.push({ text, confirmText: opts?.confirmText });
        return window.__storageUi.confirm;
      };`,
    };
    b.onResolve({ filter: /.*/ }, (args) => args.path in stubs ? { path: args.path, namespace: "storage-stub" } : undefined);
    b.onLoad({ filter: /.*/, namespace: "storage-stub" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
  } }],
});

function usage(bytes = 14, files = 2, directories = 1) {
  return { bytes, files, directories };
}

async function renderStorage(options: {
  review?: Record<string, unknown>;
  loadError?: string;
  cleanupError?: string;
  confirm?: boolean;
} = {}) {
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
  const changed: number[] = [];
  const data = {
    confirm: options.confirm ?? false,
    confirmations: [] as Array<{ text: string; confirmText?: string }>,
    review: options.review ?? {
      taskId: "goal-1", workspace: usage(), review: usage(6, 1, 1), revision: "rev-1",
      blockedReason: null,
      reviewBlockedReason: "请先清理工作副本，再单独删除历史版本与恢复备份",
      pending: null,
    },
    loadError: options.loadError ?? null,
    cleanupError: options.cleanupError ?? null,
  };
  Object.assign(dom.window, {
    __storageUi: data,
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: any) => {
        calls.push({ command, args });
        if (command === "task_storage_review") {
          if (data.loadError) throw new Error(data.loadError);
          return { ...data.review };
        }
        if (command === "task_cleanup") {
          if (data.cleanupError) throw new Error(data.cleanupError);
          const empty = usage(0, 0, 0);
          data.review = {
            ...data.review,
            workspace: args.scope === "workspace" ? empty : data.review.workspace,
            review: args.scope === "review" ? empty : data.review.review,
            reviewBlockedReason: args.scope === "workspace" ? null : data.review.reviewBlockedReason,
            pending: null,
            revision: "rev-next",
          };
          return { ...data.review };
        }
        throw new Error(`Unexpected IPC: ${command}`);
      },
    },
  });
  const compiled = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
  const { createElement: h, act, createRoot, Modal } = compiled.exports;
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  await act(async () => root.render(h(Modal, {
    taskId: "goal-1", onClose() {}, onChanged() { changed.push(1); },
  })));
  function button(label: string): HTMLButtonElement {
    const result = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
    assert.ok(result, `缺少按钮 ${label}`);
    return result;
  }
  return {
    host, act, data, calls, changed, button,
    click: async (label: string) => act(async () => button(label).click()),
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

test("工作副本与历史版本分两步，各需单独确认；有工作副本时不能先删历史", async () => {
  const view = await renderStorage();
  try {
    assert.match(view.host.textContent!, /工作副本/);
    assert.match(view.host.textContent!, /历史版本与恢复备份/);
    assert.equal(view.button("删除历史版本与备份").disabled, true);
    await view.click("清理工作副本");
    assert.equal(view.calls.some((c) => c.command === "task_cleanup"), false);
    assert.match(view.data.confirmations[0].text, /只能从当前项目重新开始/);
    assert.equal(view.data.confirmations[0].confirmText, "确认清理");
    view.data.confirm = true;
    await view.click("清理工作副本");
    const cleanup = view.calls.find((c) => c.command === "task_cleanup")!;
    assert.deepEqual(cleanup.args, {
      taskId: "goal-1", scope: "workspace", revision: "rev-1", operationId: null, confirmed: true,
    });
    assert.match(view.host.textContent!, /工作副本已清理/);
    assert.equal(view.changed.length, 1);
  } finally { await view.close(); }
});

test("中断后显示继续清理；外部改动或引用失败时保留入口且不改范围", async () => {
  const view = await renderStorage({
    review: {
      taskId: "goal-1", workspace: usage(), review: usage(6, 1, 1), revision: "rev-1",
      blockedReason: null, reviewBlockedReason: null,
      pending: { id: "op-1", scope: "workspace" },
    },
    cleanupError: "待清理目录在确认后被修改或替换，未继续删除；原清理记录保留",
    confirm: true,
  });
  try {
    assert.match(view.host.textContent!, /有未完成的工作副本清理/);
    assert.equal(view.button("清理工作副本").disabled, true);
    assert.equal(view.button("删除历史版本与备份").disabled, true);
    await view.click("继续清理");
    assert.equal(view.data.confirmations[0].confirmText, "继续清理");
    assert.match(view.data.confirmations[0].text, /继续上次没做完的清理/);
    const cleanup = view.calls.find((c) => c.command === "task_cleanup")!;
    assert.equal(cleanup.args.operationId, "op-1");
    assert.equal(cleanup.args.scope, "workspace");
    assert.match(view.host.querySelector('[role="alert"]')!.textContent!, /被修改或替换/);
    assert.match(view.host.textContent!, /有未完成的工作副本清理/);
    assert.equal(view.changed.length, 1);
  } finally { await view.close(); }
});

test("被其他项目或运行引用时禁用清理，刷新后仍不发删除", async () => {
  const view = await renderStorage({
    review: {
      taskId: "goal-1", workspace: usage(), review: usage(6, 1, 1), revision: "rev-1",
      blockedReason: "该副本仍被其他项目或运行引用，不能删除",
      reviewBlockedReason: "该副本仍被其他项目或运行引用，不能删除",
      pending: null,
    },
  });
  try {
    assert.match(view.host.textContent!, /仍被其他项目或运行引用/);
    assert.equal(view.button("清理工作副本").disabled, true);
    assert.equal(view.button("删除历史版本与备份").disabled, true);
    await view.click("刷新占用");
    assert.equal(view.calls.filter((c) => c.command === "task_cleanup").length, 0);
    assert.equal(view.calls.filter((c) => c.command === "task_storage_review").length, 2);
  } finally { await view.close(); }
});
