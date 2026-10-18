import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import type { IncludedEntryDto, WatchEntryDto } from "../src/lit-watch.ts";

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
  let schedules: Record<string, unknown>[] = [{
    id: "s1", name: "雷达", projectRoot: "/project", skill: "lit-watch",
    profileId: null, frequency: "daily", weekday: null, hour: 9, minute: 0,
    enabled: true, lastRunAt: null, lastStatus: null, history: [],
  }];
  const commands: string[] = [];
  Object.assign(dom.window, {
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
    __TAURI_INTERNALS__: {
    transformCallback: () => 1,
    unregisterCallback() {},
    invoke: async (command: string, args?: { day?: string }) => {
      commands.push(command);
      if (command === "list_watch_entries") return { entries, followups };
      if (command === "list_watch_subscriptions") {
        return [{ keyword: "test", sources: [], note: "" }];
      }
      if (command === "list_included_entries") return [];
      if (command === "list_schedules") return schedules;
      if (command === "to_fetch_progress") {
        const n = (args as { items?: unknown[] } | undefined)?.items?.length ?? 0;
        return Array.from({ length: n }, () => null);
      }
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
  const click = (b: HTMLButtonElement) =>
    act(async () => { b.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  const byText = (text: string) => {
    const b = [...host.querySelectorAll("button")].find((item) => item.textContent === text);
    assert.ok(b, `缺少按钮：${text}`);
    return b as HTMLButtonElement;
  };
  // 2026-10-14 趋势图带日/周/月切换；默认周。按 aria-label 定位容器、按色类数柱
  const chart = () => host.querySelector('div[role="img"][aria-label="近 8 周新命中数"]');
  const chartBy = (label: string) => host.querySelector(`div[role="img"][aria-label="${label}"]`);
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
    const dayAgo = (n: number) => {
      const d = new Date(now);
      d.setDate(d.getDate() - n);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    await render([entry("a", day), entry("b", null)]);
    // 2026-10-16 稀疏态：有数桶 ≤3 压成一句话（含「· 展开图」），不出图；
    // 缺日期说明与补记入口不因收起消失
    assert.equal(chart(), null, "稀疏时不直接出图");
    assert.match(host.textContent!, /近 8 周只有本周有新命中，共 1 篇/);
    assert.match(host.textContent!, /另有 1 条缺少有效巡检日期，未计入趋势/);
    const expandBtn = () =>
      [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("展开图")) as HTMLButtonElement;
    await click(expandBtn());
    const cols = () => chart()?.querySelectorAll("button[data-trend-col]");
    // 通栏等分列：8 列；今天 1 篇 = 上层 CTA 段 1 根；0 值列是 bg-field 底座
    assert.equal(cols()!.length, 8);
    assert.equal(chart()?.querySelectorAll(".bg-cta").length, 1);
    assert.equal(chart()?.querySelectorAll(".bg-field").length, 7);
    // 点今天的柱子 → 列表只剩这篇，工具栏出时间筛选胶囊；再点同柱或点胶囊清除
    const todayCol = [...cols()!].find((c) => !c.hasAttribute("disabled"))!;
    await click(todayCol as HTMLButtonElement);
    assert.ok(
      [...host.querySelectorAll("button")].some((b) => (b.textContent ?? "").trim().endsWith("×")),
      "工具栏出时间筛选胶囊",
    );
    await click(todayCol as HTMLButtonElement);
    assert.ok(
      ![...host.querySelectorAll("button")].some((b) => (b.textContent ?? "").trim().endsWith("×")),
      "再点同柱清除",
    );
    await click(byText("收起"));
    assert.equal(chart(), null, "收起回稀疏一句话");

    await render([entry("a", "2000-01-01")]);
    assert.equal(chart()?.querySelectorAll(".bg-field").length, 8);
    // ≥4 个有数桶不再压缩，数据一出直接出图（近 8 周每周都有）
    await render([entry("a", day), entry("b", dayAgo(7)), entry("c", dayAgo(14)), entry("d", dayAgo(21))]);
    assert.ok(![...host.querySelectorAll("button")].some((b) => b.textContent?.includes("展开图")), "不稀疏不出展开入口");
    assert.equal(cols()!.length, 8);
    assert.equal(chart()?.querySelectorAll(".bg-cta").length, 4, "四周各 1 篇");
    // 日/月切换：标题与桶数跟着变（近四天数据在周视角仍是稀疏，先展开出切换钮）
    await render([entry("a", day), entry("b", dayAgo(1)), entry("c", dayAgo(2)), entry("d", dayAgo(3))]);
    await click(expandBtn());
    await click(byText("日"));
    assert.ok(chartBy("近 14 天新命中数"), "日模式容器");
    assert.equal(chartBy("近 14 天新命中数")?.querySelectorAll("button[data-trend-col]").length, 14);
    assert.equal(chartBy("近 14 天新命中数")?.querySelectorAll(".bg-cta").length, 4, "近四天各 1 篇");
    await click(byText("月"));
    assert.ok(chartBy("近 6 月新命中数"), "月模式容器（展开态保持）");
    await click(byText("周"));
    assert.ok(chart(), "切回周模式");
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
    // 「待获取全文」区块 2026-10-14 按用户拍板移除：命中行自带打开来源/关联 PDF
    assert.ok(!host.textContent!.includes("待获取全文"));
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

/** 「加入积累」按钮 / 书标双态 / 积累清单抽屉：正典 included.md 与积累账
 *  reading-list.md 两表并集判书标；已积累书标点击＝展开抽屉定位该篇（移出只走抽屉 ✕），
 *  精读按钮有笔记显「继续精读」 */
test("加入积累：书标双态两表并集，已积累书标定位抽屉，移出只走抽屉 ✕", async () => {
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
      name: "radar-reading-host",
      setup(b) {
        b.onResolve({ filter: /^\.\.\/store$/ }, () => ({ path: "store", namespace: "stub" }));
        b.onResolve({ filter: /^\.\/FilePreviewEditor$/ }, () => ({ path: "editor", namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => ({
          loader: "js",
          contents: path === "store"
            ? "export const useAppStore = select => select({setPage(){},setReaderReq(){},setWorkspaceReviewRequest(){},setFilePreviewReq(r){globalThis.__filePreviewReqs.push(r);},setProjectSurfaceReq(){}});"
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
  const schedules: Record<string, unknown>[] = [{
    id: "s1", name: "雷达", projectRoot: "/project", skill: "lit-watch",
    profileId: null, frequency: "daily", weekday: null, hour: 9, minute: 0,
    enabled: true, lastRunAt: null, lastStatus: null, history: [],
  }];
  let entries: WatchEntryDto[] = [];
  // 正典 included.md 与积累账 reading-list.md 两张表；标题与命中行规范化全等。
  // Paper d 也在正典且 papers/ 已存全文（验证书标点击直接打开全文）
  let includedRows: IncludedEntryDto[] = [
    { lineId: "i-1", title: "Paper a", authorsYear: "Vaswani et al., 2026", source: "arxiv", link: "", rawLine: "" },
    { lineId: "i-2", title: "Paper d", authorsYear: "Kim et al., 2026", source: "Science", link: "", rawLine: "" },
  ];
  let readingRows: IncludedEntryDto[] = [
    { lineId: "r-1", title: "Paper b", authorsYear: "Chen L, 2026", source: "Nat. Energy", link: "10.1/b", rawLine: "" },
    { lineId: "r-2", title: "Paper extra", authorsYear: "Guo et al., 2026", source: "Joule", link: "10.1/x", rawLine: "" },
  ];
  // notes/ 笔记配对：只有 Paper b 有笔记（继续精读）；Paper extra 没有（精读）
  let noteLinkRows: Record<string, unknown>[] = [
    { notePath: "/project/notes/paper-b.md", noteName: "Paper b 精读.md", pdfRel: "papers/Paper b.pdf" },
  ];
  const commands: string[] = [];
  const addArgs: Record<string, unknown>[] = [];
  // 桩 store 的 setFilePreviewReq 落到这里（正典态点击打开全文的断言用）
  const previewReqs: Record<string, unknown>[] = (globalThis as Record<string, unknown>).__filePreviewReqs = [];
  Object.assign(dom.window, {
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
    __TAURI_INTERNALS__: {
    transformCallback: () => 1,
    unregisterCallback() {},
    invoke: async (command: string, args?: Record<string, unknown>) => {
      commands.push(command);
      if (command === "list_watch_entries") return { entries, followups: [] };
      if (command === "list_watch_subscriptions") {
        return [{ keyword: "test", sources: [], note: "" }];
      }
      if (command === "list_included_entries") return includedRows;
      if (command === "list_reading_list_entries") return readingRows;
      if (command === "list_paper_notes") return noteLinkRows;
      if (command === "list_schedules") return schedules;
      if (command === "to_fetch_progress") {
        // 两张积累行都配上全文（papers/ 文件名），抽屉才出精读/笔记/全文三键；
        // 正典命中 Paper d 也配全文（书标点击直接打开的用例）
        const items = (args as { items?: { title?: string }[] } | undefined)?.items ?? [];
        return items.map((it) =>
          it?.title === "Paper b" ? "Paper b.pdf"
          : it?.title === "Paper extra" ? "Paper extra.pdf"
          : it?.title === "Paper d" ? "Paper d.pdf"
          : null,
        );
      }
      if (command === "read_project_config") return { config: { resources: [] } };
      if (command === "add_reading_list_entry") {
        addArgs.push(args ?? {});
        readingRows = [
          ...readingRows,
          {
            lineId: "r-new", title: String(args?.title ?? ""),
            authorsYear: String(args?.authorsYear ?? ""), source: String(args?.source ?? ""),
            link: String(args?.link ?? ""), rawLine: "",
          },
        ];
        return { added: true };
      }
      if (command === "remove_reading_list_entry") {
        const lineId = String(args?.lineId ?? "");
        readingRows = readingRows.filter((r) => r.lineId !== lineId);
        return;
      }
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
  const buttonByLabel = (label: string) =>
    [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label);
  const buttonByText = (text: string) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  const click = (b: HTMLButtonElement) =>
    act(async () => b.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
  try {
    await render([entry("a", null), entry("b", null), entry("c", null), entry("d", null)]);

    // 书标双态：aria/title 区分「已在清单（正典）」「定位积累（积累账）」「加入积累」
    const included = buttonByLabel("已在清单：Paper a")!;
    assert.ok(included, "正典命中显示「已在清单」态");
    assert.match(included.getAttribute("title") ?? "", /流程的文献清单 papers\/included\.md/);
    const reading = buttonByLabel("定位积累：Paper b")!;
    assert.ok(reading, "积累账命中书标给「定位积累」态");
    assert.match(reading.getAttribute("title") ?? "", /已在积累 papers\/reading-list\.md/);
    assert.match(reading.getAttribute("title") ?? "", /定位/);
    const join = buttonByLabel("加入积累：Paper c")!;
    assert.ok(join, "两表都不在显示「加入积累」态");
    assert.equal(
      join.getAttribute("title"),
      "存入项目积累清单 papers/reading-list.md；进行中的流程不受影响，下一轮检索步开工时自动作为进料口",
    );
    // 旧口径文案不再出现（书标不再行内移出，tooltip 不再许诺「点开全文」）
    assert.doesNotMatch(host.textContent!, /加入精读|精读清单/);
    assert.doesNotMatch(reading.getAttribute("title") ?? "", /点开全文/);

    // 仅在正典（不在积累账）：没存全文时点击只说明去处，不动两张账
    await click(buttonByLabel("已在清单：Paper a")!);
    assert.match(host.textContent!, /这篇已在流程的文献清单里，不加重复积累/);
    assert.ok(!commands.includes("add_reading_list_entry"), "正典态不写积累账");
    assert.ok(!commands.includes("remove_reading_list_entry"), "正典态不移出");

    // 仅在正典但 papers/ 已存全文：点击直接打开全文（与标题点击同一动作，不再让用户扑空）
    await click(buttonByLabel("已在清单：Paper d")!);
    assert.match(host.textContent!, /这篇已在流程的文献清单里；打开已存全文/);
    assert.equal(previewReqs.at(-1)?.path, "/project/papers/Paper d.pdf");

    // 卡头「积累 N」入口：N = 积累账条数；点开抽屉列出 title 一行 + 作者/来源第二行
    const drawerBtn = buttonByText("积累 2")!;
    assert.ok(drawerBtn, "卡头显示「积累 N」，N 为积累账条数");
    await click(drawerBtn);
    assert.match(host.textContent!, /Chen L, 2026 · Nat\. Energy/);
    assert.match(host.textContent!, /Guo et al\., 2026 · Joule/);

    // 精读按钮带状态：有笔记的显「继续精读」（接续铁律在入口可见），没笔记的仍是「精读」
    assert.ok(buttonByLabel("继续精读：Paper b"), "有笔记 → 继续精读");
    assert.ok(buttonByLabel("精读：Paper extra"), "没笔记 → 精读");

    // 点「定位积累」书标：移出不在行内——书标负责展开抽屉并高亮这一篇
    await click(buttonByText("积累 2")!); // 先收起，验证书标能把抽屉重新展开
    assert.doesNotMatch(host.textContent!, /Chen L, 2026/);
    await click(buttonByLabel("定位积累：Paper b")!);
    assert.ok(!commands.includes("remove_reading_list_entry"), "书标不再行内移出");
    assert.match(host.textContent!, /Chen L, 2026 · Nat\. Energy/, "书标定位重新展开抽屉");
    const flashRow = host.querySelector('[data-reading-line="r-1"]');
    assert.ok(flashRow, "抽屉行带定位锚点");
    assert.match(flashRow.getAttribute("class") ?? "", /bg-inset/, "定位行拿到高亮");

    // 悬停 ✕ 移除：移出积累的唯一入口；走 remove_reading_list_entry 并就地刷新条数与列表
    const remove = buttonByLabel("从积累清单移除：Paper b")!;
    assert.ok(remove);
    await click(remove);
    assert.ok(commands.includes("remove_reading_list_entry"));
    assert.doesNotMatch(host.textContent!, /Chen L, 2026/);
    assert.ok(buttonByText("积累 1"), "移除后计数就地刷新");

    // 「加入积累」点击：走 add_reading_list_entry（字段拼装 includedLineFor 同款）。
    // 2026-10-14 拍板：只写账不跳精读（精读/笔记入口统一在积累抽屉），toast 指路书标定位
    await click(buttonByLabel("加入积累：Paper c")!);
    assert.ok(commands.includes("add_reading_list_entry"));
    assert.equal(addArgs[0]?.title, "Paper c");
    assert.equal(addArgs[0]?.authorsYear, "待补");
    assert.equal(addArgs[0]?.source, "Journal");
    assert.match(host.textContent!, /已加入积累清单，点书标在「积累」里定位开读/);
    assert.ok(buttonByText("积累 2"), "加入后计数就地刷新");

    // 空态：积累账清零后「积累 0」仍显示入口，展开给攒候选的空态文案
    readingRows = [];
    await render([entry("a", null), entry("b", null), entry("c", null)]);
    const emptyBtn = buttonByText("积累 0")!;
    assert.ok(emptyBtn, "条数为 0 也显示入口");
    await click(emptyBtn);
    assert.match(host.textContent!, /还没有积累。雷达里点『加入积累』攒你自己的精读候选；配了全文的可以直接开读。/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("雷达空态入口只认有任务的卡：没雷达巡检不摆「订阅关键词」，有任务才出", async () => {
  // 订阅在没有定时任务时毫无效果（立即跑只认有任务的卡），空态入口跟随任务存在与否
  const bundle = await build({
    stdin: {
      contents: `export {createElement, act} from 'react';
        export {createRoot} from 'react-dom/client';
        export {default as Card} from './src/components/LitWatchCard';
        export {invalidateSkillProvides} from './src/skill-slots.ts';`,
      resolveDir: process.cwd(), loader: "tsx",
    },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    loader: { ".css": "empty", ".woff": "empty", ".woff2": "empty", ".ttf": "empty", ".svg": "empty", ".gif": "empty" },
    external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
    plugins: [{
      name: "radar-empty-host",
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
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  let schedules: Record<string, unknown>[] = [];
  let skills: { name: string; provides?: string[] }[] = [];
  let entries: WatchEntryDto[] = [];
  Object.assign(dom.window, {
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
    __TAURI_INTERNALS__: {
    transformCallback: () => 1,
    unregisterCallback() {},
    invoke: async (command: string) => {
      if (command === "list_watch_entries") return { entries, followups: [] };
      if (command === "list_watch_subscriptions") return []; // 没订阅读
      if (command === "list_included_entries") return [];
      if (command === "list_schedules") return schedules;
      if (command === "list_skills") return skills;
      if (command === "to_fetch_progress") {
        const n = (args as { items?: unknown[] } | undefined)?.items?.length ?? 0;
        return Array.from({ length: n }, () => null);
      }
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
  const { createElement: h, act, createRoot, Card, invalidateSkillProvides } = compiled.exports;
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  let version = 0;
  // 不换 key：同一个组件实例靠 props 变化刷新（钉 schedulesVersion 桥，不是重挂载）
  const render = async () => act(async () => root.render(h(Card, {
    projectRoot: "/project", cfg: { steps: [] }, workspaces: [],
    focusToken: 1, onOpenSchedules() {}, onConfigChanged() {},
    schedulesVersion: version,
  })));
  try {
    // 没订阅 + 没雷达巡检：整块空态不出现，页面只剩「＋ 定时巡检」那条主路
    await render();
    assert.doesNotMatch(host.textContent!, /文献雷达/);

    // 建了雷达巡检后（同页任务列表桥 bump 版本号）：空态行就地出现，
    // 按钮写明是订阅关键词（不再裸写「添加」）
    schedules = [{
      id: "s1", name: "雷达", projectRoot: "/project", skill: "lit-watch",
      profileId: null, frequency: "daily", weekday: null, hour: 9, minute: 0,
      enabled: true, lastRunAt: null, lastStatus: null, history: [],
    }];
    version = 1;
    await render();
    assert.match(host.textContent!, /还没订阅读/);
    const addKeyword = [...host.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "订阅关键词",
    );
    assert.ok(addKeyword, "有雷达任务时应出现「订阅关键词」按钮");
    await act(async () => addKeyword!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.match(host.textContent!, /＋ 加一行/); // 订阅弹层已打开

    // 「雷达任务」按 provides 槽位解析（不是只认内置技能名）：自建技能没声明
    // provides: lit-watch 时不算雷达任务（卡片收起）；声明了就算——钉住
    // resolveSkillSlot 在卡内的接线，换回纯名字匹配这条测试会红
    schedules = [{
      id: "s2", name: "自建巡检", projectRoot: "/project", skill: "my-watch",
      profileId: null, frequency: "daily", weekday: null, hour: 9, minute: 0,
      enabled: true, lastRunAt: null, lastStatus: null, history: [],
    }];
    skills = [];
    version = 2;
    await act(async () => {
      invalidateSkillProvides();
      await Promise.resolve();
    });
    await render();
    assert.doesNotMatch(host.textContent!, /还没订阅读/);

    skills = [{ name: "my-watch", provides: ["lit-watch"] }];
    version = 3;
    await act(async () => {
      invalidateSkillProvides();
      await Promise.resolve();
    });
    await render();
    assert.match(host.textContent!, /还没订阅读/);

    // 关键词被清空、但雷达已经攒下命中：整张卡照常出（命中还在），另起一行提示补关键词——
    // 收成一行「还没订阅读」会把攒下的命中一起藏掉，看着像雷达没了（2026-10-17 用户实测）
    entries = [entry("x", null)];
    version = 4;
    await render();
    assert.doesNotMatch(host.textContent!, /还没订阅读/);
    assert.match(host.textContent!, /文献雷达 · 1 篇/);
    assert.match(host.textContent!, /还没有订阅关键词：下面是以前攒下的命中，巡检不会再有新命中/);
    assert.ok(
      [...host.querySelectorAll("button")].some((b) => b.textContent?.trim() === "订阅关键词"),
      "提示行带订阅关键词入口",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
