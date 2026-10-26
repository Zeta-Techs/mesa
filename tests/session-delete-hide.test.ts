import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";

/* 删对话不顿（2026-10-26 用户「删除对话不是立马删掉，而是顿一下」）：确认后这一行当场从列表拿掉，
   删的过程中扫描还看得见源文件，这期间回来的刷新不能让它冒回来；删失败撤销后随下一次刷新回来 */
test("删除中的对话当场从列表拿掉，刷新不让它冒回来，撤销后回来", async () => {
  const built = await build({
    stdin: { contents: `export {useAppStore} from './src/store';`, resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"development"' },
  });
  const dom = new JSDOM("<div></div>", { url: "http://localhost/" });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: dom.window.localStorage })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const row = (id: string) => ({ agent: "claude-code", sessionId: id });
  Object.assign(dom.window, {
    __TAURI_INTERNALS__: {
      invoke: async (command: string) => {
        if (command === "list_sessions") return [row("a"), row("b")];
        throw new Error(command);
      },
    },
  });
  try {
    const compiled = { exports: {} as Record<string, any> };
    new Function("require", "module", "exports", built.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
    const store = compiled.exports.useAppStore;
    const ids = () => store.getState().sessions.map((s: { sessionId: string }) => s.sessionId);

    await store.getState().loadSessions(true);
    assert.deepEqual(ids(), ["a", "b"]);

    const release = store.getState().hideSessionsWhileDeleting(["claude-code\na"]);
    assert.deepEqual(ids(), ["b"], "确认删除后这一行当场没了");

    await store.getState().loadSessions(true);
    assert.deepEqual(ids(), ["b"], "删的过程中刷新回来的列表还带着它，也不能冒回来");

    release();
    release(); // 重复撤销无害
    await store.getState().loadSessions(true);
    assert.deepEqual(ids(), ["a", "b"], "删失败撤销后随刷新回来");
  } finally {
    dom.window.close();
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
