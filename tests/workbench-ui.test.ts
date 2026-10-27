import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const compilation = build({
  stdin: {
    contents: `export { createElement, act } from 'react';
      export { createRoot } from 'react-dom/client';
      export { default as Page } from './src/pages/WorkbenchPage';
      export { subscribeToasts } from './src/toast';`,
    resolveDir: process.cwd(), loader: "tsx",
  },
  bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
  external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
  loader: { ".css": "empty" },
  plugins: [{ name: "workbench-boundaries", setup(bundle) {
    bundle.onResolve({ filter: /^(\.\.\/store|\.\.\/phone-drop-store|\.\.\/polling|\.\.\/components\/ClientOpenDialog|@tauri-apps\/api\/event)$/ }, (args) => ({ path: args.path, namespace: "workbench-test" }));
    bundle.onLoad({ filter: /.*/, namespace: "workbench-test" }, ({ path }) => {
      if (path === "../store") return { contents: `
        export const useAppStore = Object.assign((select) => select(globalThis.__wbState), { getState: () => globalThis.__wbState });
        export const runInboxAction = (item) => globalThis.__wbActions.push(['inbox', item]);
        export const visibleInboxItems = (items) => items;` };
      if (path === "../phone-drop-store") return { contents: "export const usePhoneDropStore = (select) => select({ open: false, items: [] });" };
      if (path === "../polling") return { contents: "export const pollEvery = () => () => {};" };
      if (path === "../components/ClientOpenDialog") return { contents: "export const useClientOpen = () => ({ projectClients: [], dialog: null });" };
      return { contents: `export const listen = async (event, handler) => {
        globalThis.__wbEvents.set(event, handler); return () => globalThis.__wbEvents.delete(event);
      };` };
    });
    bundle.onResolve({ filter: /\?(worker|url)$/ }, (args) => ({ path: args.path, namespace: "query-stub" }));
    bundle.onLoad({ filter: /.*/, namespace: "query-stub" }, () => ({ contents: 'export default "data:application/javascript,";' }));
  } }],
});

const project = { path: "/fixture", name: "测试项目", workMode: "office", createdAt: "2026-10-27T09:00:00", lastOpenedAt: "2026-10-27T10:00:00" };
const goal = { id: "goal", kind: "office_doc", projectRoot: project.path, name: "整理资料", description: "目标与验收说明\n".repeat(80), status: "running", archivedAt: null, inputPaths: ["."], adoptedPaths: [], reviewRequired: true, agent: "codex", createdAt: "2026-10-27T09:00:00", updatedAt: "2026-10-27T10:00:00" };
const tab = { tabId: "tab", runId: "run", taskId: "goal", agentId: "codex", sessionId: "session", cwd: project.path, title: "整理资料", running: true, attention: "confirm", runtime: "cli", reuseKey: "task:goal" };
const request = { requestId: "one", replyable: true, toolName: "shell", kind: "execute", command: "sh -lc 'python scripts/check.py --file data.csv'\n# 完整第二行", path: "/fixture/data.csv", oldText: "旧内容", newText: "新内容", diff: "-旧内容\n+新内容", detail: "CLI 的请求说明", alwaysLabel: null, plan: null };
const snapshot = { tabId: "tab", agent: "codex", kind: "codex", turn: { status: "awaiting_approval", startedAt: Date.now() - 120_000 }, approval: request, activity: null, thinking: null };
const confirm = { key: "confirm:run", dot: "bg-warn-text", text: "整理资料待确认", actionLabel: "去处理", action: { type: "run", runId: "run", tabId: "tab" } };
const notice = { key: "lit:fixture", dot: "bg-ok-text", text: "文献更新", actionLabel: "查看", action: { type: "page", page: "workspaces" } };
const schedule = (id: string, extra = {}) => ({ id, projectRoot: project.path, name: `雷达 ${id}`, enabled: true, pausedReason: null, runningRunId: null, frequency: "daily", hour: 16, minute: 0, weekday: 1, intervalHours: null, nextRunAt: "2026-10-27T16:00:00", skill: "lit-watch", history: [], ...extra });

async function harness(options: { live?: boolean; empty?: boolean } = {}) {
  const dom = new JSDOM('<button id="sidebar">侧栏</button><input id="outside-input"><div id="root"></div>', { url: "http://localhost" });
  const actions: any[] = [];
  const events = new Map<string, (event: any) => void>();
  const calls: Array<{ command: string; args: any }> = [];
  const data = { projects: options.empty ? [] : [project], tasks: options.empty ? [] : [goal], schedules: [] as any[], runs: [] as any[], usages: {} as Record<string, { priced: boolean; costUsd: number }>, snapshot: snapshot as any };
  const failures = new Set<string>();
  let rejectReply = false;
  const state: Record<string, any> = {
    contextLabel: null, terminalRunInputs: options.live ? [tab] : [], unreadChats: [],
    inboxItems: options.live ? [confirm, notice] : [], appUpdate: null, inboxDismissed: [], sessions: [], recentRepos: [],
    loadRecentRepos: async () => {},
  };
  for (const name of ["setPage", "setEnterCwdReq", "setSelectProjectReq", "setTaskReviewReq", "setFocusTabReq", "setProjectFocusReq", "setWorkspaceReviewRequest", "dismissInbox", "dismissInboxBulk"]) state[name] = (...args: any[]) => actions.push([name, ...args]);
  const frames = new Map<number, () => void>();
  const pending = new Map<number, () => void>();
  let timerId = 0;
  const windowSetTimeout = dom.window.setTimeout.bind(dom.window);
  const windowClearTimeout = dom.window.clearTimeout.bind(dom.window);
  dom.window.setTimeout = ((fn: () => void, ms: number) => {
    if (ms !== 5000) return windowSetTimeout(fn, ms);
    const id = --timerId; pending.set(id, fn); return id;
  }) as typeof dom.window.setTimeout;
  dom.window.clearTimeout = ((id: number) => { if (!pending.delete(id)) windowClearTimeout(id); }) as typeof dom.window.clearTimeout;
  Object.assign(dom.window, {
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    __TAURI_INTERNALS__: { invoke: async (command: string, args: any) => {
      calls.push({ command, args });
      if (failures.has(command)) throw new Error(`读取失败：${command}`);
      if (command === "list_projects") return [...data.projects];
      if (command === "list_workspaces") return [];
      if (command === "run_list") return data.runs;
      if (command === "task_list") return data.tasks;
      if (command === "list_schedules") return data.schedules;
      if (command === "chat_channel_snapshot") return data.snapshot;
      if (command === "chat_channel_reply") { if (rejectReply) throw new Error("请求已过期"); return; }
      if (command === "session_usage") return data.usages[args.sessionId] ?? { priced: true, costUsd: 0.31 };
      if (["run_schedule_now", "cancel_schedule_run", "update_schedule", "list_dir"].includes(command)) return;
      throw new Error(`测试未声明调用：${command}`);
    } },
  });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const saved: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, localStorage: dom.window.localStorage, DOMMatrix: class {}, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (fn: () => void) => { const id = ++timerId; frames.set(id, fn); return id; }, cancelAnimationFrame: (id: number) => frames.delete(id), __wbState: state, __wbActions: actions, __wbEvents: events })) {
    saved.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const mod = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", (await compilation).outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
  const { createElement: h, act, createRoot, Page, subscribeToasts } = mod.exports;
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  const toasts: any[] = [];
  const unsubscribe = subscribeToasts((notice: any) => toasts.push(notice));
  const update = async (fn: () => void | Promise<void>) => {
    await act(async () => { await fn(); });
    await act(async () => { const current = [...frames.values()]; frames.clear(); current.forEach((frame) => frame()); });
  };
  let revision = 0;
  const render = (visible = true) => update(() => root.render(h(Page, { visible, revision: revision++ })));
  const button = (text: string, scope: ParentNode = host) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text)!;
  const key = (target: EventTarget, name: string, extra = {}) => update(() => { target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...extra })); });
  return {
    dom, host, calls, state, data, failures, actions, events, toasts, render, update, button, key,
    rejectReply: () => { rejectReply = true; },
    sendPending: () => update(() => { const current = [...pending.values()]; pending.clear(); current.forEach((fn) => fn()); }),
    close: async () => {
      unsubscribe(); await act(async () => root.unmount()); dom.window.close();
      for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    },
  };
}

test("审批详情保留请求原文、固定操作、焦点圈定与返回；队列用原生列表，通知默认收起", async () => {
  const ui = await harness({ live: true });
  try {
    await ui.render();
    assert.equal(ui.host.querySelector('[role="listbox"], [role="option"]'), null);
    assert.ok(ui.host.querySelector('ul[aria-label="等你拍板"] > li'));
    assert.equal(ui.host.querySelector('[aria-label="信息通知"]'), null);
    await ui.update(() => ui.button("通知 1").click());
    assert.match(ui.host.querySelector('[aria-label="信息通知"]')!.textContent!, /文献更新/);
    const opener = ui.button("详情");
    await ui.update(() => { opener.focus(); opener.click(); });
    const panel = ui.host.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.ok(panel);
    assert.match(panel.textContent!, /仅回答当前这一问/);
    assert.ok([...panel.querySelectorAll("pre")].some((node) => node.textContent === request.command));
    assert.match(panel.textContent!, /CLI 的请求说明/);
    assert.match(panel.textContent!, /对话目录\/fixture/);
    const scrollBody = panel.lastElementChild!;
    assert.ok(!scrollBody.contains(ui.button("允许一次", panel)));
    assert.equal(ui.dom.window.document.activeElement, panel);
    const controls = panel.querySelectorAll<HTMLButtonElement>("button");
    await ui.key(panel, "Tab", { shiftKey: true });
    assert.equal(ui.dom.window.document.activeElement, controls[controls.length - 1]);
    await ui.key(controls[controls.length - 1], "Tab");
    assert.equal(ui.dom.window.document.activeElement, controls[0]);
    await ui.key(controls[0], "Escape");
    assert.equal(ui.host.querySelector('[role="dialog"]'), null);
    assert.equal(ui.dom.window.document.activeElement, opener);
  } finally { await ui.close(); }
});

test("审批待发送可以撤销；成功后才提示已发送，过期失败恢复，同一对话的下一问仍可处理", async () => {
  const ui = await harness({ live: true });
  try {
    await ui.render();
    await ui.update(() => ui.button("允许一次").click());
    assert.equal(ui.calls.filter((call) => call.command === "chat_channel_reply").length, 0);
    assert.match(ui.toasts.at(-1).message, /将在 5 秒后允许一次，仍可撤销/);
    await ui.update(() => ui.toasts.at(-1).actions[0].onClick());
    await ui.sendPending();
    assert.equal(ui.calls.filter((call) => call.command === "chat_channel_reply").length, 0);
    assert.ok(ui.button("允许一次"));
    await ui.update(() => ui.button("允许一次").click());
    await ui.render(false);
    await ui.sendPending();
    await ui.render();
    assert.deepEqual(ui.calls.find((call) => call.command === "chat_channel_reply")!.args, { tabId: "tab", requestId: "one", decision: "allow" });
    assert.match(ui.toasts.at(-1).message, /已发送允许一次/);
    await ui.update(() => ui.events.get("chat-channel-tab")!({ payload: { ...snapshot, approval: { ...request, requestId: "two" } } }));
    assert.ok(ui.button("拒绝"));
    ui.rejectReply();
    await ui.update(() => ui.button("拒绝").click());
    assert.match(ui.toasts.at(-1).message, /将在 5 秒后拒绝/);
    await ui.sendPending();
    assert.match(ui.toasts.at(-1).message, /没能送到.*回到对话/);
    assert.ok(ui.button("拒绝"));
    assert.equal(ui.calls.filter((call) => call.command === "chat_channel_reply").at(-1)!.args.requestId, "two");
  } finally { await ui.close(); }
});

test("键盘跟随焦点、忽略输入和侧栏；hooks 不提供行内审批", async () => {
  const ui = await harness({ live: true });
  try {
    ui.state.inboxItems = [confirm, { ...confirm, key: "confirm:other", action: { type: "run", runId: "other" } }];
    await ui.render();
    const second = ui.dom.window.document.getElementById("wbq-confirm:other")!;
    await ui.key(ui.dom.window.document.body, "j");
    assert.equal(ui.dom.window.document.activeElement, second);
    const sidebar = ui.dom.window.document.getElementById("sidebar")!;
    sidebar.focus(); await ui.key(sidebar, "ArrowDown");
    assert.equal(ui.dom.window.document.activeElement, sidebar);
    const input = ui.dom.window.document.getElementById("outside-input")!;
    input.focus(); await ui.key(input, "a");
    assert.equal(ui.calls.some((call) => call.command === "chat_channel_reply"), false);
    const first = ui.dom.window.document.getElementById("wbq-confirm:run")!;
    await ui.update(() => first.focus());
    await ui.key(first, "a");
    assert.match(ui.toasts.at(-1).message, /将在 5 秒后允许一次/);
    await ui.update(() => ui.toasts.at(-1).actions[0].onClick());
    await ui.update(() => ui.events.get("chat-channel-tab")!({ payload: { ...snapshot, agent: "claude-code", kind: "hooks", approval: { ...request, replyable: false } } }));
    assert.equal(ui.button("允许一次"), undefined);
    await ui.update(() => ui.button("去处理").click());
    assert.equal(ui.actions.at(-1)[0], "inbox");
  } finally { await ui.close(); }
});

test("详情按需取花费并去重；项目头落点、项目折叠与当前任务的回到对话", async () => {
  const ui = await harness({ live: true });
  try {
    ui.state.inboxItems = [];
    ui.state.terminalRunInputs = [{ ...tab, attention: "working" }];
    ui.data.snapshot = { ...snapshot, turn: { ...snapshot.turn, status: "running" }, approval: null };
    ui.data.runs = [{ id: "run", taskId: "goal", projectRoot: project.path, agent: "codex", sessionId: "session", isolationPath: project.path, internal: false, status: "running", createdAt: "2026-10-27T10:00:00", closedAt: null }];
    await ui.render();
    assert.equal(ui.calls.some((call) => call.command === "session_usage"), false);
    assert.match(ui.host.querySelector(".ccode-workbench-task")!.textContent!, /本轮/);
    const collapse = ui.host.querySelector<HTMLButtonElement>('[aria-label="收起测试项目"]')!;
    await ui.update(() => collapse.click());
    assert.equal(ui.dom.window.document.getElementById(collapse.getAttribute("aria-controls")!)!.hidden, true);
    await ui.update(() => collapse.click());
    await ui.update(() => (ui.host.querySelector(".ccode-workbench-task") as HTMLButtonElement).click());
    const panel = ui.host.querySelector('[role="dialog"]')!;
    assert.match(panel.textContent!, /\$0.31/);
    assert.equal(ui.calls.filter((call) => call.command === "session_usage").length, 1);
    assert.ok(!panel.lastElementChild!.contains(ui.button("回到对话", panel)));
    await ui.update(() => ui.button("回到对话", panel).click());
    assert.deepEqual(ui.actions.slice(-2), [["setFocusTabReq", "tab"], ["setPage", "terminal"]]);
    assert.equal(ui.calls.some((call) => /accept|apply_delivery/.test(call.command)), false);
    ui.data.usages.unpriced = { priced: false, costUsd: 0 };
    ui.data.runs.push({ ...ui.data.runs[0], id: "unknown", sessionId: "unpriced" });
    await ui.render(false); await ui.render();
    await ui.update(() => (ui.host.querySelector(".ccode-workbench-task") as HTMLButtonElement).click());
    assert.match(ui.host.querySelector('[role="dialog"]')!.textContent!, /≥.*\$0.31/);

  } finally { await ui.close(); }
});

test("读取失败保留旧列表与真实成功时间；重试恢复，首次失败不冒充空项目", async () => {
  const ui = await harness();
  try {
    await ui.render();
    assert.ok(ui.button("打开项目"));
    ui.failures.add("list_projects"); ui.failures.add("list_schedules");
    await ui.render(false); await ui.render();
    const banner = ui.host.querySelector('[role="status"]')!;
    assert.match(banner.textContent!, /项目列表：状态截至/);
    assert.match(banner.textContent!, /定时任务：状态截至/);
    const stamp = banner.querySelector("li")!.getAttribute("title");
    await ui.render();
    assert.equal(banner.querySelector("li")!.getAttribute("title"), stamp);
    assert.ok(ui.button("打开项目"));
    ui.failures.clear(); await ui.update(() => ui.button("重试").click());
    assert.equal(ui.host.querySelector('[role="status"]'), null);
    await ui.update(() => ui.button("打开项目").click());
    assert.deepEqual(ui.actions.slice(-2), [["setSelectProjectReq", "/fixture"], ["setPage", "workspaces"]]);
  } finally { await ui.close(); }
  const empty = await harness({ empty: true });
  try {
    empty.failures.add("list_projects"); await empty.render();
    assert.match(empty.host.textContent!, /尚未成功读取/);
    assert.doesNotMatch(empty.host.textContent!, /从一个项目开始/);
    empty.failures.clear(); await empty.update(() => empty.button("重试").click());
    assert.match(empty.host.textContent!, /从一个项目开始/);
    assert.equal(empty.host.querySelector('ul[aria-label="等你拍板"]'), null);
  } finally { await empty.close(); }
});

test("同刻定时任务可展开并打开；待拍板只导航，操作后只刷新定时数据", async () => {
  const originalNow = Date.now;
  Date.now = () => new Date("2026-10-27T10:00:00").getTime();
  const ui = await harness();
  try {
    // 今后 24 小时要跑的超过 3 个才出时间项（2026-10-27 精修）
    ui.data.schedules = [
      schedule("a"), schedule("b"),
      schedule("c", { hour: 18, nextRunAt: "2026-10-27T18:00:00" }),
      schedule("d", { hour: 20, nextRunAt: "2026-10-27T20:00:00" }),
      schedule("paused", { enabled: false, pausedReason: "连续失败" }),
    ];
    ui.state.inboxItems = [{ key: "sched:paused:paused", dot: "bg-warn-text", text: "雷达 paused 已暂停", actionLabel: "去处理", action: { type: "page", page: "workspaces" } }];
    await ui.render();
    const summary = ui.host.querySelector("summary")!;
    assert.match(summary.textContent!, /16:00 · 2 项/);
    await ui.update(() => summary.click());
    assert.equal(summary.parentElement!.hasAttribute("open"), true);
    await ui.update(() => ui.button("雷达 a · 测试项目", summary.parentElement!).click());
    assert.match(ui.host.querySelector('[role="dialog"]')!.textContent!, /雷达 a/);
    await ui.key(ui.host.querySelector('[role="dialog"]')!, "Escape");
    const before = ui.calls.length;
    await ui.update(() => ui.button("去拍板").click());
    assert.equal(ui.dom.window.document.activeElement?.id, "wbq-sched:paused:paused");
    assert.equal(ui.calls.length, before);
    await ui.update(() => ui.button("现在跑").click());
    assert.deepEqual(ui.calls.slice(before).map((call) => call.command), ["run_schedule_now", "list_schedules"]);
    // 一两个要跑的时候不出时间项：和下面的表是同一件事
    ui.data.schedules = [schedule("a")];
    await ui.render(false); await ui.render();
    assert.equal(ui.host.querySelector('[aria-label="今后 24 小时要跑的定时任务"]'), null);
    assert.match(ui.host.querySelector(".ccode-workbench-schedule")!.textContent!, /16:00.*雷达 a.*测试项目 · 每天 16:00/);
  } finally { await ui.close(); Date.now = originalNow; }
});
