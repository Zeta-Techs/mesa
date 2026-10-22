import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// 评审只挂在运行页：从项目页等别处进来的，store 要记下发起页，返回时才回得去（2026-10-23 用户截图：
// 流程线「去评审」再「返回」停在了运行页）
test("评审请求自动记发起页，清空时不带", async () => {
  const out = await build({
    entryPoints: ["src/store.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "storeModule",
    platform: "browser",
    logLevel: "silent",
    plugins: [{
      name: "tauri-stub",
      setup(b) {
        b.onResolve({ filter: /^@tauri-apps\// }, (args) => ({ path: args.path, namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: "export const invoke = async () => null; export const listen = async () => () => {};" +
            "export const getCurrentWebviewWindow = () => ({}); export const getCurrentWindow = () => ({});" +
            "export const check = async () => null; export const Effect = {}; export default {};",
          loader: "js",
        }));
      },
    }],
  });
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only", url: "http://localhost/" });
  // 产物带 "use strict"，严格模式 eval 里的 var 不挂到 window，手动挂出来
  dom.window.eval(`${out.outputFiles[0].text}\nwindow.storeModule = storeModule;`);
  const { useAppStore } = (dom.window as unknown as { storeModule: { useAppStore: { getState(): {
    setPage(p: string): void;
    setWorkspaceReviewRequest(r: { worktreePath: string; requestId: string } | null): void;
    workspaceReviewRequest: { fromPage?: string } | null;
  } } } }).storeModule;
  const s = useAppStore.getState();
  s.setPage("workspaces");
  s.setWorkspaceReviewRequest({ worktreePath: "/w", requestId: "1" });
  assert.equal(useAppStore.getState().workspaceReviewRequest?.fromPage, "workspaces");
  s.setWorkspaceReviewRequest(null);
  assert.equal(useAppStore.getState().workspaceReviewRequest, null);
});
