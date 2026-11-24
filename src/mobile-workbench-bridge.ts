/**
 * 手机工作台 ↔ 桌面主窗口事件桥（2026-11-24）：
 * - 概览 / 文件只读 / 流式项目助手问答 / 人工请求答复 / 跨网传资料全部直连 Rust，不经 WebView；
 * - 本桥只负责两件轻量事务：
 *   1. 同步刷新桌面 UI（手机问答/答完人工请求后推 bumpAssistantEchoTick / bumpHelpRefresh）；
 *   2. 接收手机点「派出去」发来的 `mobile-workbench-dispatch` 事件，按 `assistant-ops.ts` 手机权限口径
 *      复用现有 `dispatchWorkOrder` + `assistant_mark_dispatched`，再经 `mobile_workbench_bridge_reply` 回传结果。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "./store";
import { samePath } from "./path-utils";
import { IS_WINDOWS } from "./hotkeys";
import { resolveTurnParts } from "./project-assistant";
import { desktopOnlyNote, opAllowed } from "./assistant-ops";
import { dispatchWorkOrder, type DispatchRecord } from "./assistant-dispatch";
import type { AssistantTurn } from "./project-assistant-run";
import type { ProjectConfigReadDto, ProjectDto } from "./types";

interface MobileDispatchEvent {
  reqId: string;
  projectRoot: string;
  turnAt: string;
}

async function handleDispatchRequest(payload: MobileDispatchEvent): Promise<{ ok: boolean; message: string }> {
  if (!opAllowed("dispatch", "phone")) {
    return { ok: false, message: desktopOnlyNote("派出去") };
  }
  const projects = await invoke<ProjectDto[]>("list_projects").catch(() => [] as ProjectDto[]);
  const project = projects.find((p) => samePath(p.path, payload.projectRoot, IS_WINDOWS));
  if (!project) {
    return { ok: false, message: "未找到该项目，请刷新手机端项目列表" };
  }
  const log = await invoke<AssistantTurn[]>("assistant_log_read", { projectRoot: project.path }).catch(
    () => [] as AssistantTurn[],
  );
  const turn = log.find((t) => t.at === payload.turnAt);
  if (!turn) {
    return { ok: false, message: "未找到对应的项目助手回答" };
  }
  if (turn.dispatched) {
    return { ok: true, message: `这张单已经派过了：${turn.dispatched.note}` };
  }
  const steps = await invoke<ProjectConfigReadDto>("read_project_config", { path: project.path })
    .then((r) => r.config.steps.length)
    .catch(() => 0);
  const order = resolveTurnParts(turn, steps).order;
  if (!order) {
    return { ok: false, message: "那一轮里没有可派出的任务单" };
  }
  // 手机上派：不自动触发需要桌面确认的工作副本合并，confirm 固定 null
  const result = await dispatchWorkOrder({ order, projectPath: project.path, project, confirm: null });
  const record: DispatchRecord = {
    at: new Date().toISOString(),
    target: order.target,
    step: order.step,
    title: order.title,
    mode: result.mode,
    mailId: result.mailId ?? null,
    taskId: result.taskId ?? null,
    worktreePath: result.worktreePath ?? null,
    note: result.note,
    baseAhead: result.baseAhead ?? null,
  };
  await invoke("assistant_mark_dispatched", { projectRoot: project.path, turnAt: turn.at, record }).catch(() => {});
  useAppStore.getState().bumpAssistantEchoTick();
  return { ok: true, message: `${result.note}。做完了我会告诉你。` };
}

/** 启动手机工作台事件桥；返回取消订阅函数 */
export async function startMobileWorkbenchBridge(): Promise<() => void> {
  const unsubs: (() => void)[] = [];
  const offAssistant = await listen("mobile-workbench-assistant-updated", () => {
    useAppStore.getState().bumpAssistantEchoTick();
  });
  unsubs.push(offAssistant);

  const offHelp = await listen("mobile-workbench-help-updated", () => {
    useAppStore.getState().bumpHelpRefresh();
  });
  unsubs.push(offHelp);

  const offDispatch = await listen<MobileDispatchEvent>("mobile-workbench-dispatch", (ev) => {
    const payload = ev.payload;
    if (!payload?.reqId) return;
    void handleDispatchRequest(payload)
      .then((res) =>
        invoke("mobile_workbench_bridge_reply", {
          reqId: payload.reqId,
          ok: res.ok,
          message: res.message,
        }).catch(() => {}),
      )
      .catch((err) =>
        invoke("mobile_workbench_bridge_reply", {
          reqId: payload.reqId,
          ok: false,
          message: String(err),
        }).catch(() => {}),
      );
  });
  unsubs.push(offDispatch);

  return () => {
    for (const off of unsubs) off();
  };
}
