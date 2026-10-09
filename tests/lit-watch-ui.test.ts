import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import type { WatchEntryDto } from "../src/lit-watch.ts";

function entry(id: string, date: string | null): WatchEntryDto {
  return {
    id, date, title: `Paper ${id}`, source: "Journal", authors: "",
    abstractFirst: "", keywordsHit: [], relevance: "推荐", journal: null,
    zhSummary: "", url: "", rawLineRange: [1, 2], metrics: null, explain: null,
  };
}

test("文献雷达真实卡片：趋势标题、已知日期柱与缺日期空态", async () => {
  const bundle = await build({
    stdin: {
      contents: `export {createElement, act} from 'react';
        export {createRoot} from 'react-dom/client';
        export {default as Card} from './src/components/LitWatchCard';`,
      resolveDir: process.cwd(), loader: "tsx",
    },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    loader: { ".css": "empty", ".woff": "empty", ".woff2": "empty", ".ttf": "empty", ".svg": "empty", ".gif": "empty" },
    external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
    plugins: [{
      name: "radar-host",
      setup(b) {
        b.onResolve({ filter: /^\.\.\/store$/ }, () => ({ path: "store", namespace: "stub" }));
        b.onResolve({ filter: /^\.\/FilePreviewEditor$/ }, () => ({ path: "editor", namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => ({
          loader: "js",
          contents: path === "store"
            ? "export const useAppStore = select => select({setPage(){},setReaderReq(){},setWorkspaceReviewRequest(){},setFilePreviewReq(){},setProjectSurfaceReq(){}});"
            : "export default function Editor(){return null;}",
        }));
      },
    }],
  });
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  let entries: WatchEntryDto[] = [];
  let followups: { title: string; url: string; note: string }[] = [];
  let schedules: Record<string, unknown>[] = [];
  const commands: string[] = [];
  Object.assign(dom.window, {
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
    __TAURI_INTERNALS__: {
    transformCallback: () => 1,
    unregisterCallback() {},
    invoke: async (command: string, args?: { day?: string }) => {
      commands.push(command);
      if (command === "list_watch_entries") return { entries, followups };
      if (command === "list_watch_subscriptions") return [{ keyword: "test", sources: [], note: "" }];
      if (command === "list_included_entries") return [];
      if (command === "list_schedules") return schedules;
      if (command === "to_fetch_progress") return [null];
      if (command === "repair_watch_batch_dates") return args?.day === "2026-10-03";
      if (command === "inst_browser_open" || command === "inst_browser_cancel") return;
      if (command === "journal_metrics_status") return { available: false, journalCount: 0, downloadedAt: null };
      if (command === "plugin:event|listen") return 1;
      if (command === "plugin:event|unlisten") return;
      throw new Error(command);
    },
  } });
  const compiled = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(
    createRequire(import.meta.url), compiled, compiled.exports,
  );
  const { createElement: h, act, createRoot, Card } = compiled.exports;
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  let seq = 0;
  async function render(next: WatchEntryDto[]) {
    entries = next;
    await act(async () => root.render(h(Card, {
      key: ++seq, projectRoot: "/project", cfg: { steps: [] }, workspaces: [],
      focusToken: seq, onOpenSchedules() {}, onConfigChanged() {},
    })));
  }
  const chart = () => host.querySelector('svg[aria-label="近 8 周每周新命中数"]');
  try {
    await render([]);
    assert.match(host.textContent!, /近 8 周新命中/);
    assert.match(host.textContent!, /暂无文献命中，巡检后显示趋势/);
    assert.equal(chart(), null);

    await render([entry("a", null), entry("b", null)]);
    assert.match(host.textContent!, /2 条文献缺少有效巡检日期，暂无法统计趋势/);
    assert.equal(chart(), null);

    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    await render([entry("a", day), entry("b", null)]);
    assert.equal(chart()?.querySelectorAll("rect").length, 8);
    assert.equal(chart()?.querySelectorAll('rect[fill="var(--color-cta)"]').length, 1);
    assert.match(host.textContent!, /另有 1 条缺少有效巡检日期，未计入趋势/);

    await render([entry("a", "2000-01-01")]);
    assert.equal(chart()?.querySelectorAll('rect[fill="var(--color-hairline)"]').length, 8);
    assert.doesNotMatch(host.textContent!, /缺少有效巡检日期|暂无文献命中/);

    schedules = [{
      id: "s1", name: "雷达", projectRoot: "/project", skill: "lit-watch",
      profileId: null, frequency: "daily", weekday: null, hour: 9, minute: 0,
      enabled: true, lastRunAt: "2026-10-03T05:36:19Z", lastStatus: "ok",
      history: [{
        status: "ok", newEntries: 2, adopted: true, summary: "",
        at: "2026-10-03T05:36:19Z", finishedAt: "2026-10-03T05:36:19Z",
      }],
    }];
    followups = [{ title: "付费墙论文", url: "https://doi.org/10.1000/abc", note: "付费墙" }];
    await render([entry("a", null), entry("b", null)]);
    assert.match(host.textContent!, /按巡检日补记/);
    const repair = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("按巡检日补记"));
    assert.ok(repair);
    await act(async () => { repair!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    assert.ok(commands.includes("repair_watch_batch_dates"));

    const fold = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("待人工下载"));
    assert.ok(fold);
    await act(async () => { fold!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    assert.match(host.textContent!, /官网/);
    assert.doesNotMatch(host.textContent!, /获取/);
    assert.match(host.textContent!, /关联/);
    assert.match(host.textContent!, /打开 papers\//);
    const site = [...host.querySelectorAll("button")].find((b) => b.textContent === "官网");
    assert.ok(site);
    await act(async () => { site!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    assert.ok(commands.includes("inst_browser_open"));
    assert.match(host.textContent!, /等待收货…/);
    assert.match(host.textContent!, /取消/);
    assert.ok(!commands.some((command) => /^(run_|save_|update_|delete_|add_)/.test(command)));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
