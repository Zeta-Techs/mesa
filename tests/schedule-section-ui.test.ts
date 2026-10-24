import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import type { ScheduleDto } from "../src/types.ts";

/**
 * 定时任务列表（ScheduleSection）真实组件测试。
 * 钉四件承重行为：
 * 1. 任务集变更桥（onSchedulesChanged）：启停/删除/新建/编辑保存后必须调用——
 *    新建删除不发 scheduler-run-done，漏调雷达卡要切页才翻新；
 * 2. 编辑弹层清空运行配置必须发空串（后端 Option<Option> 下 null ≡ 不改，发 null 静默失效）；
 * 3. 删除雷达任务时确认层说清「关键词一起删除」（关键词按任务一份）；
 * 4. 创建弹层说明关键词在建好后从任务行添加。
 * 5.（2026-10-23）历史行「看过程」打开那次后台对话；自动暂停写原因并能「重新打开」；
 *    「带附言运行」把附言带给 run_schedule_now；其他项目的任务在底部总览里，点一行去那个项目。
 * 6.（2026-10-23 使用优化）建好后提示试跑；「上次」一行直接给结果与入口；非科研项目空态给示例、
 *    默认新建巡检技能且不列文献雷达。
 */

function radarSchedule(): ScheduleDto {
  return {
    id: "s1", name: "文献雷达", projectRoot: "/project", skill: "lit-watch",
    profileId: "p1", frequency: "daily", weekday: null, hour: 9, minute: 0,
    enabled: true, lastRunAt: null, lastStatus: null, history: [],
  };
}

test("定时任务列表：桥、空串清除、删除确认与创建提示", async () => {
  const bundle = await build({
    stdin: {
      contents: `export {createElement, act} from 'react';
        export {createRoot} from 'react-dom/client';
        export {default as Section} from './src/components/ScheduleSection';`,
      resolveDir: process.cwd(), loader: "tsx",
    },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    loader: { ".css": "empty", ".woff": "empty", ".woff2": "empty", ".ttf": "empty", ".svg": "empty", ".gif": "empty" },
    external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
    plugins: [{
      name: "schedule-host",
      setup(b) {
        const stubs: Record<string, string> = {
          "../store": `export const useAppStore = select => select(window.__scheduleUiHost.store);`,
          "../toast": `export const toast = (...args) => window.__scheduleUiHost.toasts.push(args);`,
          "./ConfirmDialog": `export const confirmDialog = async (message) => {
            window.__scheduleUiHost.confirms.push(message);
            return window.__scheduleUiHost.confirmResult ?? true;
          };`,
          "./AskAiModal": `export const beginAskAi = () => {};`,
          "@tauri-apps/api/event": `export const listen = async () => () => {};`,
        };
        b.onResolve({ filter: /.*/ }, (args) => args.path in stubs ? { path: args.path, namespace: "schedule-stub" } : undefined);
        b.onResolve({ filter: /\?worker$|\?url$/ }, (args) => ({ path: args.path, namespace: "schedule-asset" }));
        b.onLoad({ filter: /.*/, namespace: "schedule-stub" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
        b.onLoad({ filter: /.*/, namespace: "schedule-asset" }, () => ({ contents: "export default 'data:worker,';", loader: "js" }));
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
  let schedules: ScheduleDto[] = [radarSchedule()];
  let subs: { keyword: string }[] = [{ keyword: "mixture-of-experts" }];
  let subsVersion = 0;
  const commands: Array<{ command: string; args: any }> = [];
  const data = {
    confirms: [] as string[],
    confirmResult: true as boolean,
    toasts: [] as unknown[][],
    changed: 0,
    store: {
      profiles: [{ id: "p1", name: "测试配置", agent: "codex", models: ["m"] }],
      setPage(page: string) { data.pages.push(page); },
      setWorkspaceReviewRequest() {},
      setOpenSessionReq(req: unknown) { data.openSession.push(req); },
      setSelectProjectReq(root: string) { data.selected.push(root); },
      setProjectFocusReq() {},
    },
    pages: [] as string[],
    openSession: [] as unknown[],
    selected: [] as string[],
  };
  Object.assign(dom.window, {
    __scheduleUiHost: data,
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
    __TAURI_INTERNALS__: {
      transformCallback: () => 1,
      unregisterCallback() {},
      invoke: async (command: string, args?: any) => {
        commands.push({ command, args });
        if (command === "list_schedules") return schedules;
        if (command === "list_watch_subscriptions") {
          const id = args?.scheduleId as string | undefined;
          if (id && id !== "s1") return [];
          return subs;
        }
        if (command === "list_watch_skill_drafts") return [];
        if (command === "list_skills") return [];
        if (command === "agent_capabilities") return [];
        if (command === "update_schedule" || command === "delete_schedule" || command === "create_schedule")
          return radarSchedule();
        if (command === "schedule_run_delete") return;
        if (command === "ensure_schedule_skill_distributed") return;
        if (command === "run_schedule_now") return;
        throw new Error(command);
      },
    },
  });
  const compiled = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(
    createRequire(import.meta.url), compiled, compiled.exports,
  );
  const { createElement: h, act, createRoot, Section } = compiled.exports;
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  let showOthers = false;
  let workMode: string | undefined;
  const render = async () => act(async () => root.render(h(Section, {
    projectRoot: "/project", layout: "card", subsVersion, showOthers, workMode,
    onSchedulesChanged: () => { data.changed++; },
  })));
  const allButtons = () => Array.from(dom.window.document.querySelectorAll("button"));
  const byText = (text: string) => {
    const b = allButtons().find((x) => x.textContent?.trim() === text);
    assert.ok(b, `缺少按钮：${text}`);
    return b;
  };
  const click = async (b: HTMLButtonElement) =>
    act(async () => b.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
  try {
    await render();
    assert.match(host.textContent!, /文献雷达/);
    const runBtn = () =>
      allButtons().find((b) => b.getAttribute("aria-label") === "立即运行：文献雷达")!;
    assert.equal(runBtn().disabled, false, "已有关键词时立即运行可点");

    // ① 启停走桥（load() 其后还会拉 list_*，断言存在性而非末位）
    const toggle = host.querySelector<HTMLButtonElement>('button[role="switch"][aria-label^="停用"]')!;
    assert.ok(toggle);
    await click(toggle);
    const toggled = commands.find((c) => c.command === "update_schedule");
    assert.ok(toggled, "启停应发 update_schedule");
    assert.equal(toggled!.args.patch.enabled, false);
    assert.ok(data.changed >= 1, "启停后应调 onSchedulesChanged");

    // ② 删除雷达任务：关键词跟着任务走，确认层说清一起删除
    await click(allButtons().find((b) => b.getAttribute("aria-label") === "任务操作：文献雷达")! as HTMLButtonElement);
    await click(byText("删除任务"));
    assert.ok(
      data.confirms.some((m) => /关键词一起删除/.test(m)),
      `确认文案应说清关键词一起删除：${JSON.stringify(data.confirms)}`,
    );
    assert.ok(commands.some((c) => c.command === "delete_schedule"));
    assert.ok(data.changed >= 2, "删除后应调 onSchedulesChanged");

    // ③ 创建弹层：关键词在建好后从任务行添加；保存建任务走桥
    subs = [];
    subsVersion = 1;
    await render(); // 订阅版本变化才重读关键词数
    assert.equal(runBtn().disabled, true, "文献雷达没有关键词时立即运行不可点");
    await click(byText("＋ 新建定时任务"));
    assert.match(dom.window.document.body.textContent!, /每条雷达用自己的关键词/);
    // 运行配置收在「更多设置」里，默认收着
    assert.match(dom.window.document.body.textContent!, /运行配置跟随项目默认/);
    await click(byText("创建"));
    assert.ok(commands.some((c) => c.command === "create_schedule"));
    assert.ok(data.changed >= 3, "新建任务后应调 onSchedulesChanged");
    // 建好后提示试跑；雷达还没关键词时先说订关键词
    assert.match(host.textContent!, /先点「关键词」订阅，再试跑一次/);
    await click(byText("不用"));
    assert.doesNotMatch(host.textContent!, /试跑一次/);

    // ④ 编辑弹层清空运行配置：发空串（发 null 后端当「不改」，清除静默失效）
    schedules = [radarSchedule()];
    await render();
    await click(allButtons().find((b) => b.getAttribute("aria-label") === "任务操作：文献雷达")! as HTMLButtonElement);
    await click(byText("编辑任务"));
    // 弹层 portal 在 body；行内也有运行配置下拉（在 #root），必须只认弹层里的那个
    const selects = Array.from(dom.window.document.body.querySelectorAll<HTMLSelectElement>("select"));
    const profile = selects.filter((s) =>
      Array.from(s.options).some((o) => o.value === "p1"),
    ).pop();
    assert.ok(profile, "编辑弹层应有运行配置下拉");
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value")!.set!.call(profile, "");
      profile.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    await click(byText("保存"));
    const patch = commands.filter((c) => c.command === "update_schedule").at(-1)!.args.patch;
    assert.equal(patch.profileId, "", "清空运行配置必须发空串，不是 null");
    assert.equal(patch.linkedStep, undefined, "界面不编辑关联步骤，补丁里就不带这个键");
    assert.ok(data.changed >= 4, "编辑保存后应调 onSchedulesChanged");

    // ⑤ 历史行删除：确认层说清「已采纳产物不受影响」，确认后发 schedule_run_delete
    schedules = [{
      ...radarSchedule(),
      history: [{
        at: "2026-10-13T09:44:00+08:00", status: "ok", summary: "新命中 2 篇",
        newEntries: 2, startedAt: null, finishedAt: null, artifacts: [],
        runId: "run-h1", isolationPath: "/tmp/iso", adopted: true,
      }],
    }];
    subsVersion = 2; // 换数据必须走 subsVersion 触发重拉，光 render 不会重读
    await render();
    await click(allButtons().find((b) => b.textContent?.includes("历史") && b.getAttribute("aria-expanded") !== null)! as HTMLButtonElement);
    const delBtn = allButtons().find((b) => b.getAttribute("aria-label")?.startsWith("删除运行记录："))!;
    assert.ok(delBtn, "历史行应有删除按钮");
    const before = commands.filter((c) => c.command === "schedule_run_delete").length;
    await click(delBtn);
    assert.ok(
      data.confirms.some((m) => /已采纳进项目的产物不受影响/.test(m)),
      `历史删除确认应说明已采纳产物不受影响：${JSON.stringify(data.confirms)}`,
    );
    const deleted = commands.filter((c) => c.command === "schedule_run_delete");
    assert.equal(deleted.length, before + 1);
    assert.equal(deleted.at(-1)!.args.runId, "run-h1");
    // 确认层点掉（confirmResult=false）时不发删除命令（历史列表仍展开，无需再点开）
    data.confirmResult = false;
    data.confirms.length = 0;
    const delAgain = allButtons().find((b) => b.getAttribute("aria-label")?.startsWith("删除运行记录：")) as HTMLButtonElement | undefined;
    assert.ok(
      delAgain,
      `删除后历史行应仍在（stub 原样返回）：${Array.from(host.querySelectorAll("button")).map((b) => b.getAttribute("aria-label") ?? b.textContent).join("｜")}`,
    );
    await click(delAgain);
    assert.equal(commands.filter((c) => c.command === "schedule_run_delete").length, before + 1, "取消确认不得删除");

    // ⑥ 看过程 / 自动暂停 / 带附言运行 / 其他项目总览
    data.confirmResult = true;
    schedules = [
      {
        ...radarSchedule(),
        enabled: false,
        pausedReason: "连续 3 次没跑成，已自动暂停。最后一次：AI 调用超时",
        history: [{
          at: "2026-10-23T09:44:00+08:00", status: "ok", summary: "新命中 0 篇",
          newEntries: 0, noop: true, runId: "run-h2", isolationPath: "/tmp/iso",
          agent: "codex", sessionId: "sess-1", trigger: "catchup", scheduledFor: "2026-10-23T09:00:00",
        }],
      },
      {
        ...radarSchedule(), id: "s9", name: "别处的雷达", projectRoot: "/elsewhere",
        nextRunAt: "2026-10-24T09:00:00",
      },
    ];
    showOthers = true;
    subs = [{ keyword: "mixture-of-experts" }]; // 没关键词时菜单里不给「带附言运行」
    subsVersion = 3;
    await render();
    assert.match(host.textContent!, /已自动暂停/);
    assert.match(host.textContent!, /连续 3 次没跑成/);
    const reopen = byText("重新打开");
    await click(reopen);
    const reopened = commands.filter((c) => c.command === "update_schedule").at(-1)!;
    assert.equal(reopened.args.patch.enabled, true, "重新打开 = 打开开关");
    // 第⑤步已经展开了这一行的历史；收着的话再点开
    const historyBtn = allButtons().find((b) => b.textContent?.includes("历史") && b.getAttribute("aria-expanded") !== null)!;
    if (historyBtn.getAttribute("aria-expanded") !== "true") await click(historyBtn as HTMLButtonElement);
    assert.match(host.textContent!, /补跑 · 原定/);
    assert.ok(!allButtons().some((b) => b.textContent?.trim() === "去评审"), "无新内容的运行不给去评审");
    // 「上次」一行不用展开历史就能看到结果和入口
    assert.match(host.textContent!, /上次 .*无新内容/);
    await click(byText("看过程"));
    assert.deepEqual(data.openSession.at(-1), { agent: "codex", sessionId: "sess-1" });
    assert.equal(data.pages.at(-1), "sessions");
    // 其他项目总览：折叠着，点开后一行去那个项目
    const fold = allButtons().find((b) => b.textContent?.includes("其他项目的定时任务（1）"));
    assert.ok(fold, "应有其他项目总览");
    await click(fold!);
    await click(allButtons().find((b) => b.textContent?.includes("别处的雷达"))! as HTMLButtonElement);
    assert.equal(data.selected.at(-1), "/elsewhere");
    assert.equal(data.pages.at(-1), "workspaces");
    // 带附言运行：⋯ 菜单 → 弹层 → 立即运行，附言跟着 run_schedule_now 走
    await click(allButtons().find((b) => b.getAttribute("aria-label") === "任务操作：文献雷达")! as HTMLButtonElement);
    await click(byText("带附言运行…"));
    const textarea = dom.window.document.body.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "这次重点看 MoE");
      textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await click(byText("立即运行"));
    const ran = commands.filter((c) => c.command === "run_schedule_now").at(-1)!;
    assert.equal(ran.args.note, "这次重点看 MoE");

    // ⑦ 编程项目：空态给示例；默认新建巡检技能，种类里没有文献雷达；点示例预填描述
    schedules = [];
    showOthers = false;
    workMode = "coding";
    subsVersion = 4;
    await render();
    assert.match(host.textContent!, /还没有定时任务/);
    await click(byText("每周汇总代码改动"));
    const body = dom.window.document.body;
    const kind = Array.from(body.querySelectorAll<HTMLSelectElement>("select")).find((s) =>
      Array.from(s.options).some((o) => o.value === "__new__"),
    )!;
    assert.equal(kind.value, "__new__", "编程项目默认新建巡检技能");
    assert.ok(!Array.from(kind.options).some((o) => o.value === "lit-watch"), "非科研项目不列文献雷达");
    const intentBox = Array.from(body.querySelectorAll<HTMLTextAreaElement>("textarea")).at(-1)!;
    assert.match(intentBox.value, /上一周的提交和改动/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
