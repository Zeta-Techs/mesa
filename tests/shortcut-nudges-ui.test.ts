import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";

// 「用鼠标做了本有快捷键的事」提醒（shortcut-nudges.tsx，2026-10-27）：真模块 + 真 CoachTip，确认框桩掉
const bundle = await build({
  stdin: {
    contents: `export {act} from 'react'; export * from './src/components/shortcut-nudges';`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  jsx: "automatic",
  external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
  plugins: [
    {
      name: "boundaries",
      setup(b) {
        b.onResolve({ filter: /\/ConfirmDialog$/ }, () => ({ path: "confirm", namespace: "stub" }));
        b.onLoad({ filter: /^confirm$/, namespace: "stub" }, () => ({
          contents: `export const confirmDialogOpen = () => window.__confirmOpen === true;`,
          loader: "js",
        }));
      },
    },
  ],
});

function load() {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const mod = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
  const tip = () => dom.window.document.body.querySelector('[data-coach-tip][role="dialog"]');
  return { ...mod.exports, dom, tip };
}

const anchor = { left: 600, top: 10, right: 628, bottom: 38 };

test("聊天 ↔ 终端：用 >_ 去、回不提，再去时在按钮下面提醒快捷键，只提一次（2026-10-27）", async () => {
  const { act, noteMouseToggleSurface, tip } = load();
  await act(async () => {
    noteMouseToggleSurface(anchor, "mod+shift+t");
    noteMouseToggleSurface(anchor, "mod+shift+t");
  });
  assert.equal(tip(), null);
  await act(async () => noteMouseToggleSurface(anchor, "mod+shift+t"));
  assert.match(tip()!.textContent!, /聊天和终端来回切有快捷键/);
  assert.match(tip()!.textContent!, /Shift\+T|⇧⌘T/);
  assert.equal(localStorage.getItem("ccode.coachSurfaceKeySeen"), "1");
  const ok = Array.from(tip()!.querySelectorAll("button")).find((b) => b.textContent === "知道了")!;
  await act(async () => ok.click());
  assert.equal(tip(), null);
  for (let i = 0; i < 3; i++) await act(async () => noteMouseToggleSurface(anchor, "mod+shift+t"));
  assert.equal(tip(), null, "出过不再出");
});

test("聊天 ↔ 终端：快捷键被关掉了不提；这次打开已出过别的提醒也不提（2026-10-27）", async () => {
  {
    const { act, noteMouseToggleSurface, tip } = load();
    for (let i = 0; i < 3; i++) await act(async () => noteMouseToggleSurface(anchor, ""));
    assert.equal(tip(), null);
  }
  {
    const { act, noteMouseToggleSurface, noteMouseCloseChat, tip } = load();
    await act(async () => {
      noteMouseCloseChat(anchor, "below");
      noteMouseCloseChat(anchor, "below");
      await new Promise((r) => setTimeout(r, 450));
    });
    assert.match(tip()!.textContent!, /关掉对话有快捷键/);
    await act(async () => {
      document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    for (let i = 0; i < 3; i++) await act(async () => noteMouseToggleSurface(anchor, "mod+shift+t"));
    assert.equal(tip(), null, "一次打开最多主动出一条");
    assert.equal(localStorage.getItem("ccode.coachSurfaceKeySeen"), null);
  }
});
