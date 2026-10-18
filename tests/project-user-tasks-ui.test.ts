import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import type { RunDto, RunEventDto, TaskDto } from "../src/types.ts";

const bundle = await build({
  stdin: {
    contents: `export {createElement, act} from 'react'; export {createRoot} from 'react-dom/client'; export {default as View} from './src/components/ProjectUserTasksView';`,
    resolveDir: process.cwd(), loader: "tsx",
  },
  bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
  external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
  plugins: [{ name: "goal-host", setup(b) {
    const stubs: Record<string, string> = {
      "../store": `export const useAppStore = select => select(window.__goalUi.store);
        useAppStore.getState = () => window.__goalUi.store;
        export const runInboxAction = action => window.__goalUi.continues.push(action);`,
      "../goal-run": `export const prepareGoalRun = async input => {
          window.__goalUi.starts.push(input);
          if (window.__goalUi.startError) throw new Error('准备失败');
          return {run:window.__goalUi.preparedRun, prompt:'frozen context'};
        };
        export const goalRunTerminalFields = (task, run, prompt) => ({cwd:run.isolationPath, taskId:task.id, runId:run.id, initialPrompt:prompt});`,
      "@tauri-apps/api/event": "export const listen = async () => () => {};",
      "./ConfirmDialog": `export const confirmDialog = async text => {
        window.__goalUi.confirmations.push(text); return window.__goalUi.confirm;
      };`,
      "./ProjectSettingsDrawer": "export default function Panel(){return null;}",
      "./ResearchReproductionPanel": "export default function Panel(){return null;}",
      "./ResearchAcceptancePanel": "export default function Panel(){return null;}",
      "./OfficePreviewModal": "export default function Panel(){return null;}",
    };
    b.onResolve({ filter: /.*/ }, (args) => args.path in stubs ? { path: args.path, namespace: "goal-stub" } : undefined);
    b.onLoad({ filter: /.*/, namespace: "goal-stub" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
  } }],
});

function goal(id: string, status = "pending", extra: Partial<TaskDto> = {}): TaskDto {
  return {
    id, projectRoot: "/project", kind: "office_doc", taskRef: null, name: `整理${id}文档`,
    description: "", status, inputPaths: ["."], outputPaths: ["."], reviewRequired: true,
    archivedAt: null, agent: "codex", profileId: "codex-a", createdAt: "2026-09-10T00:00:00Z",
    updatedAt: "2026-09-10T00:00:00Z", declared: true, ...extra,
  };
}
function execution(task: TaskDto, extra: Partial<RunDto> = {}): RunDto {
  return {
    id: `run-${task.id}`, taskId: task.id, taskKind: task.kind, taskRef: null,
    projectRoot: "/project", isolationPath: `/isolated/${task.id}`, runtime: "local_cli",
    agent: "codex", profileId: "codex-a", permission: "write_tree", reuseKey: null,
    sessionId: `session-${task.id}`, internal: false, sentinel: false, status: "stopped",
    createdAt: "2026-09-10T00:00:00Z", closedAt: null, exitCode: null, closeReason: null,
    customRuntimeId: null, capabilities: {} as RunDto["capabilities"], ...extra,
  };
}

async function renderGoals(options: {
  tasks?: TaskDto[];
  runs?: RunDto[];
  events?: RunEventDto[];
  mode?: string;
  embed?: boolean;
  steps?: unknown[];
  loadError?: boolean;
  gate?: Promise<void>;
  profiles?: unknown[];
  pendingReview?: unknown;
  reviewGate?: Promise<void>;
  reviewError?: boolean;
  contextGate?: Promise<void>;
  configGate?: Promise<void>;
  protectedPaths?: string[];
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
  const pollers = new Map<number, () => void>();
  let timerId = 0;
  dom.window.setInterval = ((callback: () => void) => {
    const id = ++timerId;
    pollers.set(id, callback);
    return id;
  }) as typeof dom.window.setInterval;
  dom.window.clearInterval = (id) => { pollers.delete(id); };
  const calls: Array<{ command: string; args: any }> = [];
  const pages: string[] = [];
  const terminals: any[] = [];
  const data = {
    tasks: options.tasks ?? [], runs: options.runs ?? [], events: options.events ?? [],
    loadError: options.loadError ?? false, reviewError: options.reviewError ?? false, archiveError: false, startError: false,
    confirm: false, confirmations: [] as string[], starts: [] as any[], continues: [] as any[],
    preparedRun: execution(goal("new")),
    storage: null as any, cleanupError: null as string | null,
    review: options.pendingReview ?? { changes: [], frozen: true, seq: 4, payloadDir: "/frozen/4" },
    store: {
      profiles: options.profiles ?? [{ id: "codex-a", agent: "codex", name: "Official", models: ["gpt-6-astra"] }],
      settings: { hiddenProfiles: [] }, agents: [{ id: "codex", readonlySupported: true }],
      setPage: (page: string) => pages.push(page), setPendingTerminal: (value: unknown) => terminals.push(value),
      taskReviewReq: null, setTaskReviewReq() {},
    },
  };
  Object.assign(dom.window, {
    __goalUi: data,
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: any) => {
        calls.push({ command, args });
        if (command === "read_project_config") {
          await options.configGate;
          return { config: { steps: options.steps ?? [], pipelineOptOut: true, protectedPaths: options.protectedPaths ?? [], skills: [] } };
        }
        if (command === "task_list") {
          await options.gate;
          if (data.loadError) throw new Error("项目暂不可读");
          return [...data.tasks];
        }
        if (command === "run_list") return data.runs.map((run) => ({ ...run }));
        if (command === "task_goal_events") return data.events;
        if (command === "task_run_context") {
          await options.contextGate;
          return { text: "冻结的工作环境" };
        }
        if (command === "task_output_changes") {
          await options.reviewGate;
          if (data.reviewError) throw new Error("冻结清单不可读");
          return data.review;
        }
        if (command === "task_adopt_outputs") return;
        if (command === "task_recover_outputs") return data.tasks.find((task) => task.pendingApplyRunId === args.runId);
        if (command === "task_delete" || command === "task_unarchive") {
          if (data.archiveError) throw new Error("写入失败");
          data.tasks = data.tasks.map((task) => task.id === args.id
            ? { ...task, archivedAt: command === "task_delete" ? "2026-09-11T00:00:00Z" : null }
            : task);
          return;
        }
        if (command === "task_create") {
          const task = goal("created", "pending", { ...args.input, reviewRequired: args.input.permission === "write_tree" });
          data.tasks.push(task);
          return task;
        }
        if (command === "task_storage_review") {
          return data.storage ?? {
            taskId: args.taskId, workspace: { bytes: 14, files: 2, directories: 1 },
            review: { bytes: 6, files: 1, directories: 1 }, revision: "rev",
            blockedReason: null,
            reviewBlockedReason: "请先清理工作副本，再单独删除历史版本与恢复备份",
            pending: null,
          };
        }
        if (command === "task_cleanup") {
          if (data.cleanupError) throw new Error(data.cleanupError);
          const empty = { bytes: 0, files: 0, directories: 0 };
          const previous = data.storage ?? {
            workspace: { bytes: 14, files: 2, directories: 1 },
            review: { bytes: 6, files: 1, directories: 1 },
          };
          data.storage = {
            taskId: args.taskId,
            workspace: args.scope === "workspace" ? empty : previous.workspace,
            review: args.scope === "review" ? empty : previous.review,
            revision: "rev-next", blockedReason: null,
            reviewBlockedReason: args.scope === "workspace" ? null : null,
            pending: null,
          };
          return data.storage;
        }
        throw new Error(`Unexpected IPC: ${command}`);
      },
    },
  });
  const compiled = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
  const { createElement: h, act, createRoot, View } = compiled.exports;
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  await act(async () => root.render(h(View, {
    project: { path: "/project", name: "项目", workMode: options.mode ?? "office", defaultAgent: "codex", defaultProfiles: { codex: "codex-a" } },
    embed: options.embed ?? false,
  })));
  function button(label: string, parent: ParentNode = host): HTMLButtonElement {
    const result = Array.from(parent.querySelectorAll("button")).find((b) =>
      (b.getAttribute("aria-label") ?? b.textContent?.trim()) === label);
    assert.ok(result, `缺少按钮 ${label}`);
    return result;
  }
  function row(task: TaskDto): HTMLElement {
    const result = host.querySelector<HTMLElement>(`li[aria-label="目标：${task.description || task.name}"]`);
    assert.ok(result, `缺少目标卡 ${task.name}`);
    return result;
  }
  return {
    dom, host, act, data, calls, pages, terminals, button, row,
    poll: async () => act(async () => { for (const callback of pollers.values()) callback(); }),
    click: async (label: string, parent?: ParentNode) => act(async () => button(label, parent).click()),
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

test("单个已停止目标：重试优先，标题限两行，归档收进详情", async () => {
  const task = goal("模型", "stopped", { name: "根据这份表格格式整理最新的模型 完善表格", description: "根据这份表格格式整理最新的模型 完善表格" });
  const view = await renderGoals({ tasks: [task], runs: [execution(task)] });
  try {
    const card = view.row(task);
    assert.equal(card.querySelector("h4")!.textContent, task.name);
    assert.equal(view.host.textContent!.split(task.name).length - 1, 1);
    assert.ok(!view.host.textContent!.includes("项目现在"));
    assert.ok(!view.host.textContent!.includes("生成"));
    assert.ok(!view.host.textContent!.includes("没做完"));
    assert.equal(view.host.querySelectorAll("h3").length, 0);
    assert.ok(view.button("重试", card).classList.contains("ccode-action-primary"));
    assert.ok(!view.button("新建目标").classList.contains("ccode-action-primary"));
    assert.equal(view.host.querySelectorAll(".ccode-action-primary").length, 1);
    assert.ok(card.querySelector("h4")!.classList.contains("line-clamp-2"));
    assert.equal(card.querySelector('[aria-label^="归档目标："]'), null, "默认卡面不摆归档按钮");
    await view.click(`目标详情：${task.name}`, card);
    const archive = view.button(`归档目标：${task.name}`, card);
    assert.equal(archive.textContent, "归档目标");
    assert.equal(archive.disabled, false);
    assert.ok(card.querySelector(".flex-wrap"), "窄容器允许操作换行");
    assert.match(card.textContent!, /Codex · 验收后写入文档/);
    await view.click("重试", card);
    assert.equal(view.data.starts[0].reuseIsolation, true);
    assert.deepEqual(view.terminals[0].resume, { agentId: "codex", sessionId: `session-${task.id}` });
    assert.equal(view.pages.at(-1), "terminal");
  } finally { await view.close(); }
});

test("混合目标按验收/进行中/需处理/未开始/已完成排序，仅一个主操作", async () => {
  const tasks = [goal("未开始"), goal("进行中", "running"), goal("已完成", "completed"), goal("验收", "pending_review"), goal("失败", "failed")];
  const view = await renderGoals({ tasks, runs: tasks.map((task) => execution(task)) });
  try {
    assert.deepEqual(Array.from(view.host.querySelectorAll('li[aria-label^="目标："]')).map((item) => item.getAttribute("aria-label")), [tasks[3], tasks[1], tasks[4], tasks[0], tasks[2]].map((task) => `目标：${task.name}`));
    assert.equal(view.host.querySelectorAll(".ccode-action-primary").length, 1);
    assert.ok(view.button("验收文档", view.row(tasks[3])).classList.contains("ccode-action-primary"));
    await view.click(`目标详情：${tasks[1].name}`, view.row(tasks[1]));
    assert.equal(view.button(`归档目标：${tasks[1].name}`).disabled, true);
    await view.click("继续", view.row(tasks[1]));
    assert.deepEqual(view.data.continues[0].action, { type: "run", runId: `run-${tasks[1].id}` });
    assert.equal(view.data.starts.length, 0, "继续不新建 Run");
    await view.click("验收文档", view.row(tasks[3]));
    assert.match(view.host.querySelector('[role="dialog"]')!.textContent!, /验收文档/);
    assert.ok(view.calls.some((call) => call.command === "task_output_changes" && call.args.runId === `run-${tasks[3].id}`));
    assert.ok(!view.calls.some((call) => call.command === "task_adopt_outputs"), "打开验收绝不自动采纳");
  } finally { await view.close(); }
});

test("完整历程默认收起，展开保留意见与版本，内部执行不展示", async () => {
  const task = goal("结果", "completed", { adoptedPaths: ["文档/结果.md"] });
  const first = execution(task, { id: "first" });
  const second = execution(task, { id: "second", createdAt: "2026-09-11T00:00:00Z" });
  const view = await renderGoals({ tasks: [task], runs: [second, first, execution(task, { id: "hidden", internal: true })], events: [
    { id: "note", runId: "first", eventType: "task.review_notes", payload: JSON.stringify({ feedback: "数字移到附表" }), createdAt: "2026-09-10T01:00:00Z" },
  ] });
  try {
    assert.equal(view.host.querySelector('[aria-label^="目标历程详情"]'), null);
    assert.ok(view.button("新建目标").classList.contains("ccode-action-primary"));
    await view.click(`目标详情：${task.name}`);
    const history = view.host.querySelector('[aria-label^="目标历程详情"]')!;
    assert.deepEqual(Array.from(history.querySelectorAll("li")).map((item) => ({
      label: item.querySelector("p > span")?.textContent,
      body: item.querySelectorAll("p")[1]?.textContent ?? "",
    })), [
      { label: "生成", body: "" },
      { label: "意见", body: "数字移到附表" },
      { label: "第 2 版", body: "" },
      { label: "已采纳", body: "" },
    ]);
    // 每一版、每条意见旁带时间（悬浮给绝对时间）；采纳没有可靠时间不标
    assert.deepEqual(
      Array.from(history.querySelectorAll("li")).map((item) => Boolean(item.querySelector("p > span[title]"))),
      [true, true, true, false],
    );
    assert.equal(view.button(`目标详情：${task.name}`).getAttribute("aria-expanded"), "true");
    await view.click(`目标详情：${task.name}`);
    assert.equal(view.host.querySelector('[aria-label^="目标历程详情"]'), null);
    await view.click("再来一版", view.row(task));
    assert.ok(view.host.querySelector('[role="dialog"]'));
  } finally { await view.close(); }
});

test("归档保留确认，已归档默认收起可恢复，失败明确反馈", async () => {
  const task = goal("档案", "stopped");
  const view = await renderGoals({ tasks: [task] });
  try {
    await view.click(`目标详情：${task.name}`, view.row(task));
    await view.click(`归档目标：${task.name}`);
    assert.equal(view.data.confirmations.length, 1);
    assert.match(view.data.confirmations[0], /释放副本空间/);
    assert.match(view.data.confirmations[0], /归档不等于清理/);
    assert.ok(!view.data.confirmations[0].includes("待验收"));
    assert.ok(!view.calls.some((call) => call.command === "task_delete"));
    view.data.confirm = true;
    view.data.archiveError = true;
    await view.click(`归档目标：${task.name}`);
    assert.match(view.host.querySelector('[role="alert"]')!.textContent!, /归档目标失败/);
    view.data.archiveError = false;
    await view.click(`归档目标：${task.name}`);
    const archiveButton = view.button("已归档 1");
    assert.equal(archiveButton.getAttribute("aria-expanded"), "false");
    assert.match(view.host.textContent!, /当前没有目标/);
    assert.ok(!view.host.textContent!.includes("第一个目标"));
    await view.click("已归档 1");
    await view.click("恢复");
    view.row(task);
    assert.equal(view.data.tasks[0].archivedAt, null);
    assert.ok(view.calls.some((call) => call.command === "task_unarchive" && call.args.id === task.id));
  } finally { await view.close(); }
});

test("新建目标仍可先记下、不自动启动；开始走原有准备入口", async () => {
  const view = await renderGoals();
  try {
    assert.match(view.host.textContent!, /这次想完成什么/);
    await view.click("新建目标");
    const input = view.host.querySelector("textarea")!;
    await view.act(async () => {
      Object.getOwnPropertyDescriptor(view.dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, "按公司模板整理文档");
      input.dispatchEvent(new view.dom.window.Event("input", { bubbles: true }));
    });
    await view.click("记下");
    assert.equal(view.data.starts.length, 0);
    const created = view.data.tasks[0];
    assert.equal(created.kind, "office_doc");
    assert.deepEqual(created.inputPaths, ["."]);
    assert.deepEqual(created.outputPaths, ["."]);
    await view.click("开始", view.row(created));
    assert.equal(view.data.starts[0].task.id, created.id);
    assert.equal(view.data.starts[0].reuseIsolation, false);
  } finally { await view.close(); }
});

test("无流程科研复用目标样式与产物验收，流程科研和编程不进入目标区", async () => {
  const task = goal("文献", "pending_review", { kind: "free_research" });
  const research = await renderGoals({ mode: "research", embed: true, tasks: [task], runs: [execution(task)] });
  try {
    assert.match(research.row(task).textContent!, /验收后写入项目/);
    await research.click("验收产物", research.row(task));
    assert.match(research.host.querySelector('[role="dialog"]')!.textContent!, /验收产物/);
  } finally { await research.close(); }
  for (const mode of ["research", "coding"]) {
    const excluded = await renderGoals({ mode, tasks: [task], steps: [{ name: "文献精读" }] });
    try {
      assert.equal(excluded.host.textContent, "");
      assert.ok(!excluded.calls.some((call) => call.command === "task_list"));
    } finally { await excluded.close(); }
  }
});

test("加载、读取失败和无 Run 状态不伪装为空目标或可验收", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const loading = await renderGoals({ gate });
  try {
    assert.match(loading.host.querySelector('[role="status"]')!.textContent!, /正在读取目标/);
    assert.ok(!loading.host.textContent!.includes("这次想完成什么"));
    await loading.act(async () => finish());
    assert.match(loading.host.textContent!, /这次想完成什么/);
  } finally { finish(); await loading.close(); }
  const failed = await renderGoals({ loadError: true });
  try {
    assert.match(failed.host.querySelector('[role="alert"]')!.textContent!, /任务读取失败/);
    assert.ok(!failed.host.textContent!.includes("这次想完成什么"));
    failed.data.loadError = false;
    await failed.click("刷新目标");
    assert.equal(failed.host.querySelector('[role="alert"]'), null);
  } finally { await failed.close(); }
  const missing = await renderGoals({ tasks: [goal("等待", "pending_review")] });
  try {
    assert.match(missing.host.textContent!, /运行记录暂不可用/);
    assert.ok(!Array.from(missing.host.querySelectorAll("button")).some((button) => button.textContent === "验收文档"));
  } finally { await missing.close(); }
});

test("重新打开目标可找回未完成接受，继续携带原操作 ID 而非最新版本", async () => {
  const task = goal("recovery", "completed", { pendingApplyRunId: "old-run" });
  const old = { ...execution(task), id: "old-run" };
  const latest = { ...execution(task), id: "new-run", createdAt: "2026-09-12T00:00:00Z" };
  const view = await renderGoals({ tasks: [task], runs: [latest, old], pendingReview: { changes: [{ path: "report.md", kind: "modified", bytes: 10 }], frozen: true, seq: null, payloadDir: "/old-frozen", readiness: "ledger_pending", pendingApply: { id: "original-operation", versionId: "old-run:1", paths: ["report.md"], phase: "files_applied", note: "原来的意见", memorize: false } } });
  try {
    await view.click("处理未完成接受", view.row(task));
    assert.match(view.host.textContent!, /old-run:1/);
    assert.ok(view.calls.some((c) => c.command === "task_output_changes" && c.args.runId === "old-run"));
    await view.click("继续未完成的接受");
    assert.deepEqual(view.calls.find((c) => c.command === "task_recover_outputs")?.args, { runId: "old-run", operationId: "original-operation", action: "continue" });
    assert.equal(view.calls.some((c) => c.command === "task_adopt_outputs"), false);
  } finally { await view.close(); }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("验收首次加载固定外框，等待规则和上下文后一次展示完整清单", async () => {
  const config = deferred();
  const context = deferred();
  const task = goal("首次验收", "pending_review");
  const view = await renderGoals({
    tasks: [task], runs: [execution(task)], configGate: config.promise, contextGate: context.promise,
    protectedPaths: ["input"],
    pendingReview: { frozen: true, seq: 2, payloadDir: "/frozen/2", changes: [
      { path: "output/report.md", kind: "added", bytes: 10 },
      { path: "input/source.txt", kind: "modified", bytes: 10 },
    ] },
  });
  try {
    await view.click("验收文档", view.row(task));
    const panel = view.host.querySelector<HTMLElement>('[role="dialog"]')!;
    const panelClasses = panel.className;
    assert.ok(!panel.textContent!.includes("output/report.md"), "规则未读完前不先显示可接受文件");
    assert.match(panelClasses, /h-\[min\(48rem,calc\(100dvh-24px\)\)\]/);
    assert.ok(panel.querySelector('[aria-busy="true"]'));
    assert.match(panel.textContent!, /读取这版的变更/);
    await view.act(async () => config.resolve());
    assert.ok(!panel.textContent!.includes("output/report.md"), "不分批撑开弹窗");
    await view.act(async () => context.resolve());
    assert.equal(view.host.querySelector('[role="dialog"]'), panel, "加载前后不重挂弹窗");
    assert.equal(panel.className, panelClasses, "加载前后保持同一尺寸约束");
    assert.equal(panel.querySelector('[aria-busy="true"]'), null);
    assert.match(panel.textContent!, /output\/report\.md/);
    assert.match(panel.textContent!, /冻结的工作环境/);
    const protectedRow = Array.from(panel.querySelectorAll("li")).find((row) => row.textContent?.includes("input/source.txt"))!;
    assert.equal(protectedRow.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled, true);
    assert.equal(view.calls.filter((c) => c.command === "task_output_changes").length, 1, "规则晚到不重复读验收");
    assert.equal(view.calls.filter((c) => c.command === "task_run_context").length, 1);
  } finally {
    config.resolve(); context.resolve(); await view.close();
  }
});

test("列表轮询不重载打开的验收，不替换所审版本或丢失勾选、意见与滚动", async () => {
  const task = goal("稳定验收", "pending_review");
  const review = { frozen: true, seq: 2, payloadDir: "/frozen/2", changes: [
    { path: "output/report.md", kind: "added", bytes: 10 },
    { path: "output/weekly.md", kind: "added", bytes: 20 },
  ] };
  const view = await renderGoals({ tasks: [task], runs: [execution(task)], pendingReview: review });
  try {
    await view.click("验收文档", view.row(task));
    const panel = view.host.querySelector<HTMLElement>('[role="dialog"]')!;
    const weeklyRow = Array.from(panel.querySelectorAll("li")).find((row) => row.textContent?.includes("output/weekly.md"))!;
    const checkbox = weeklyRow.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await view.act(async () => checkbox.click());
    assert.equal(checkbox.checked, false);
    const text = panel.querySelector("textarea")!;
    await view.act(async () => {
      Object.getOwnPropertyDescriptor(view.dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(text, "保留这版报告");
      text.dispatchEvent(new view.dom.window.Event("input", { bubbles: true }));
    });
    const content = panel.querySelector<HTMLElement>('[aria-label="验收内容"]') ?? panel;
    content.scrollTop = 120;
    const before = view.calls.filter((c) => ["task_output_changes", "task_run_context"].includes(c.command)).length;
    view.data.review = { ...review, seq: 3, payloadDir: "/frozen/3", changes: [{ path: "output/new.md", kind: "added", bytes: 30 }] };
    await view.poll();
    await view.poll();
    assert.equal(view.calls.filter((c) => ["task_output_changes", "task_run_context"].includes(c.command)).length, before, "同一 Run 的新对象不触发读取中闪动");
    assert.equal(view.host.querySelector('[role="dialog"]'), panel);
    assert.equal(panel.querySelector("textarea"), text);
    assert.equal(text.value, "保留这版报告");
    assert.equal(checkbox.checked, false);
    assert.ok(panel.querySelector('[aria-label="验收内容"]'), "验收内容有独立滚动区");
    assert.equal(content.scrollTop, 120);
    assert.match(panel.textContent!, /当前冻结版本：2/);
    assert.ok(!panel.textContent!.includes("output/new.md"));
    assert.ok(!panel.textContent!.includes("读取这版的变更"));
    const accept = Array.from(panel.querySelectorAll("button")).find((button) => /^采纳 1/.test(button.textContent ?? ""))!;
    assert.ok(accept);
    await view.act(async () => accept.click());
    assert.deepEqual(view.calls.find((c) => c.command === "task_adopt_outputs")?.args, {
      runId: `run-${task.id}`, paths: ["output/report.md"], note: "保留这版报告", expectSeq: 2, memorize: false,
    });
    await view.click("验收文档", view.row(task));
    assert.match(view.host.querySelector('[role="dialog"]')!.textContent!, /当前冻结版本：3/);
    assert.match(view.host.querySelector('[role="dialog"]')!.textContent!, /output\/new\.md/);

  } finally { await view.close(); }
});

test("验收读取失败留在同一外框提示重开，不闪成空成果或允许接受", async () => {
  const task = goal("读取失败", "pending_review");
  const gate = deferred();
  const view = await renderGoals({ tasks: [task], runs: [execution(task)], reviewGate: gate.promise, reviewError: true });
  try {
    await view.click("验收文档", view.row(task));
    const panel = view.host.querySelector<HTMLElement>('[role="dialog"]')!;
    const classes = panel.className;
    await view.act(async () => gate.resolve());
    assert.equal(view.host.querySelector('[role="dialog"]'), panel);
    assert.equal(panel.className, classes);
    assert.match(panel.querySelector('[role="alert"]')!.textContent!, /冻结清单不可读.*重新打开验收/);
    assert.ok(!panel.textContent!.includes("没有新的文档"));
    assert.ok(!panel.textContent!.includes("不带回文档，完成"));
    assert.equal(view.calls.some((c) => c.command === "task_adopt_outputs"), false);
    await view.click("关闭", panel);
    view.data.reviewError = false;
    await view.click("验收文档", view.row(task));
    assert.match(view.host.querySelector('[role="dialog"]')!.textContent!, /没有新的文档/);
  } finally { gate.resolve(); await view.close(); }
});

test("加载期间关闭验收，晚到的响应不重新打开弹窗", async () => {
  const task = goal("关闭加载", "pending_review");
  const gate = deferred();
  const view = await renderGoals({ tasks: [task], runs: [execution(task)], reviewGate: gate.promise });
  try {
    await view.click("验收文档", view.row(task));
    await view.click("关闭", view.host.querySelector('[role="dialog"]')!);
    await view.act(async () => gate.resolve());
    assert.equal(view.host.querySelector('[role="dialog"]'), null);
    assert.equal(view.calls.some((c) => c.command === "task_adopt_outputs"), false);
  } finally { gate.resolve(); await view.close(); }
});

test("长目标卡只显示两行原文与简短状态，详情保留全文、产物和归档", async () => {
  const prompt = "只读取 input/observations.txt 的虚构数据，不访问网络、不安装依赖、不修改 input/ 和 manuscript/。生成 output/summary.md、output/weekly.md、output/clean.csv，说明两组样本数与均值，并注明这是验收假数据，不作科学结论。不要做其他工作。";
  const paths = ["output/summary.md", "output/weekly.md", "output/clean.csv"];
  const task = goal("长目标", "completed", { name: prompt, description: prompt, adoptedPaths: paths, kind: "free_research" });
  const view = await renderGoals({ tasks: [task], runs: [execution(task)], mode: "research", embed: true });
  try {
    const card = view.row(task);
    const title = card.querySelector("h4")!;
    assert.equal(title.textContent, prompt, "只做展示裁剪，不改写或删减真实目标");
    assert.ok(title.classList.contains("line-clamp-2"));
    const meta = card.querySelector("p")!;
    assert.match(meta.textContent!, /已完成.*Codex.*已写入 3 项/);
    assert.ok(!meta.textContent!.includes("output/"));
    assert.equal(card.querySelector('[aria-label^="目标完整要求"]'), null);
    assert.equal(card.querySelector('[aria-label="已写入项目的文件"]'), null);
    assert.equal(card.querySelector('[aria-label^="归档目标："]'), null);
    assert.deepEqual(Array.from(card.querySelectorAll("button")).map((button) => button.textContent), ["再来一版", "详情"]);
    assert.ok(!view.button("再来一版", card).classList.contains("ccode-action-secondary"), "已完成目标的返修按钮降为轻量辅助操作");
    await view.click(`目标详情：${prompt}`, card);
    assert.ok(!card.querySelector("h4")!.classList.contains("line-clamp-2"), "展开后标题即完整要求，不再裁两行");
    const full = card.querySelector('[aria-label^="目标完整要求"]')!;
    assert.equal(full.textContent, prompt);
    assert.equal(card.querySelector("h4"), full, "同一段原文只出现一次，不另开完整要求栏");
    const outputs = card.querySelector('[aria-label="已写入项目的文件"]')!;
    assert.deepEqual(Array.from(outputs.querySelectorAll("li")).map((item) => item.textContent), paths);
    assert.match(card.querySelector("h5")!.textContent!, /已写入项目 · 3/);
    assert.equal(view.button(`归档目标：${prompt}`, card).disabled, false);
    await view.poll();
    assert.equal(card.querySelector('[aria-label^="目标完整要求"]'), full, "列表刷新不折叠已打开详情");
    await view.click(`目标详情：${prompt}`, card);
    assert.equal(card.querySelector('[aria-label="已写入项目的文件"]'), null);
    await view.click("再来一版", card);
    assert.ok(view.host.querySelector('[role="dialog"]'));
    assert.equal(view.data.starts.length, 0, "打开返修仍不自动启动 Agent");
    assert.equal(view.data.tasks[0].name, prompt);
    assert.equal(view.data.tasks[0].description, prompt);
  } finally { await view.close(); }
});

test("详情保留不同的目标名与补充要求，声明输出范围不冒充已写入", async () => {
  const task = goal("补充", "pending", { name: "整理周报", description: "依据这份原始记录写周报，不改原始数据。", outputPaths: ["output"] });
  const view = await renderGoals({ tasks: [task] });
  try {
    const card = view.row(task);
    assert.match(card.querySelector("p")!.textContent!, /输出范围 1 项/);
    assert.ok(!card.textContent!.includes("已写入"));
    await view.click(`目标详情：${task.description}`, card);
    const full = card.querySelector('[aria-label^="目标完整要求"]')!;
    assert.match(full.textContent!, /整理周报/);
    assert.match(full.textContent!, /依据这份原始记录写周报，不改原始数据。/);
    assert.deepEqual(Array.from(card.querySelectorAll('[aria-label="声明的输出范围"] li')).map((item) => item.textContent), ["output"]);
    assert.equal(card.querySelector('[aria-label^="目标历程详情"]'), null, "无历史不占历程空块");
    assert.equal(view.data.starts.length, 0);
  } finally { await view.close(); }
});

test("已完成目标详情可释放副本；清理未完成时主操作是继续清理且不能归档或重跑", async () => {
  const done = goal("完成清理", "completed");
  const view = await renderGoals({ tasks: [done], runs: [execution(done)] });
  try {
    await view.click(`目标详情：${done.name}`, view.row(done));
    await view.click("释放副本空间", view.row(done));
    const dialog = view.host.querySelector('[role="dialog"]')!;
    assert.match(dialog.textContent!, /释放副本空间/);
    assert.match(dialog.textContent!, /工作副本/);
    assert.match(dialog.textContent!, /历史版本与恢复备份/);
    assert.ok(view.calls.some((call) => call.command === "task_storage_review" && call.args.taskId === done.id));
    const reviewBtn = Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === "删除历史版本与备份")!;
    assert.equal(reviewBtn.disabled, true, "有工作副本时不能先删历史版本");
  } finally { await view.close(); }

  const pending = goal("中断清理", "completed", { storageCleanupPending: true, workspaceCleared: true });
  const interrupted = await renderGoals({ tasks: [pending], runs: [execution(pending)] });
  try {
    const card = interrupted.row(pending);
    assert.equal(interrupted.button("继续清理副本", card).classList.contains("ccode-action-primary"), true);
    assert.equal(Array.from(card.querySelectorAll("button")).some((b) => b.textContent === "开始" || b.textContent === "重试" || b.textContent === "从项目重新开始"), false);
    await interrupted.click(`目标详情：${pending.name}`, card);
    assert.equal(interrupted.button(`归档目标：${pending.name}`, card).disabled, true);
    interrupted.data.storage = {
      taskId: pending.id, workspace: { bytes: 14, files: 2, directories: 1 },
      review: { bytes: 6, files: 1, directories: 1 }, revision: "rev",
      blockedReason: null, reviewBlockedReason: null,
      pending: { id: "op-1", scope: "workspace" },
    };
    interrupted.data.confirm = true;
    await interrupted.click("继续清理副本", card);
    assert.match(interrupted.host.querySelector('[role="dialog"]')!.textContent!, /有未完成的/);
  } finally { await interrupted.close(); }
});

test("工作副本已清理后只能从当前项目重新开始，已归档可继续未完成清理", async () => {
  const cleared = goal("已释放", "completed", { workspaceCleared: true });
  const view = await renderGoals({ tasks: [cleared], runs: [execution(cleared)] });
  try {
    const card = view.row(cleared);
    await view.click("从项目重新开始", card);
    assert.equal(view.data.starts.length, 0);
    assert.match(view.data.confirmations.at(-1)!, /旧工作副本已清理/);
    view.data.confirm = true;
    await view.click("从项目重新开始", card);
    assert.equal(view.data.starts[0].reuseIsolation, false);
    assert.equal(view.terminals[0].resume, undefined);
  } finally { await view.close(); }

  const archived = goal("归档占用", "completed", {
    archivedAt: "2026-09-11T00:00:00Z", storageCleanupPending: true,
  });
  const archiveView = await renderGoals({ tasks: [archived] });
  try {
    await archiveView.click("已归档 1");
    assert.equal(archiveView.button("继续清理副本").textContent, "继续清理副本");
    assert.equal(archiveView.button("恢复").disabled, true);
    assert.equal(archiveView.button("恢复").title, "请先继续未完成的副本清理，再恢复");
  } finally { await archiveView.close(); }
});

test("待验收归档会说明不再提醒；未完成接受不能归档", async () => {
  const review = goal("待验收归档", "pending_review");
  const view = await renderGoals({ tasks: [review], runs: [execution(review)] });
  try {
    await view.click(`目标详情：${review.name}`, view.row(review));
    const archive = view.button(`归档目标：${review.name}`, view.row(review));
    assert.equal(archive.disabled, false);
    await view.click(`归档目标：${review.name}`, view.row(review));
    assert.match(view.data.confirmations[0], /还在待验收/);
    assert.match(view.data.confirmations[0], /释放副本空间/);
    assert.ok(!view.calls.some((call) => call.command === "task_delete"));
  } finally { await view.close(); }

  const apply = goal("未完成接受", "completed", { pendingApplyRunId: "old-run" });
  const blocked = await renderGoals({ tasks: [apply], runs: [execution(apply, { id: "old-run" })] });
  try {
    await blocked.click(`目标详情：${apply.name}`, blocked.row(apply));
    const archive = blocked.button(`归档目标：${apply.name}`, blocked.row(apply));
    assert.equal(archive.disabled, true);
    assert.equal(archive.title, "请先处理未完成的接受，再归档");
  } finally { await blocked.close(); }
});
