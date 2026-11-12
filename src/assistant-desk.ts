/**
 * 调度台取数与转达（调 invoke，2026-11-06 docs/design-assistant-dispatch-desk.md §2）：
 * loadDesk 收这个项目「等你的事」（判定在 assistant-queue.ts）；replyDesk 把你的回复原路、原话送回去。
 * 桌面面板与飞书通道共用，不各写一套。
 */
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "./store";
import { IS_WINDOWS } from "./hotkeys";
import { pathWithin, samePath } from "./path-utils";
import { stepSessionTail } from "./session-tail";
import { helpNotDismissed } from "./help-requests";
import { buildWorkspaceTerminalRequest } from "./pipeline-start";
import { loadHelpDismissed } from "./inbox";
import { liveRunIn, sendToWorkspace } from "./assistant-dispatch";
import { buildDeskItems, relayText, type DeskItem, type DeskStep } from "./assistant-queue";
import type { HelpItemDto, HelpRequestDto, ProjectConfigReadDto, RunDto, ScheduleDto, WorkspaceDto } from "./types";
import type { OpenDispatch } from "./assistant-echo";

function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  return p.then((v) => v ?? fallback).catch(() => fallback);
}

export async function loadDesk(projectPath: string): Promise<DeskItem[]> {
  const [read, workspaces, runs, help, schedules] = await Promise.all([
    safe(invoke<ProjectConfigReadDto | null>("read_project_config", { path: projectPath }), null),
    safe(invoke<WorkspaceDto[]>("list_workspaces"), []),
    safe(invoke<RunDto[]>("run_list", { projectRoot: projectPath }), []),
    safe(invoke<HelpRequestDto[]>("list_help_requests"), []),
    safe(invoke<ScheduleDto[]>("list_schedules"), []),
  ]);
  const mine = workspaces.filter((w) => w.status !== "archived" && samePath(w.repoPath, projectPath, IS_WINDOWS));
  const steps: DeskStep[] = (read?.config.steps ?? []).map((s, index) => ({
    index,
    name: s.name,
    workspaceName: s.workspaceName,
    worktreePath: mine.find((w) => w.name === s.workspaceName)?.worktreePath ?? null,
  }));
  const live = useAppStore.getState().terminalRunInputs;
  const busy = (path: string) =>
    live.some((r) => r.running && !r.shell && pathWithin(r.cwd, path, IS_WINDOWS) && (r.attention === "working" || r.attention === "confirm"));
  const tails = (
    await Promise.all(
      steps
        .filter((s) => s.worktreePath)
        .map(async (s) => {
          const tail = await stepSessionTail(runs, s.worktreePath!).catch(() => null);
          return tail ? { step: s, text: tail.text, busy: busy(s.worktreePath!) } : null;
        }),
    )
  ).filter((t): t is { step: DeskStep; text: string; busy: boolean } => !!t);
  // 目标在 Mesa 自己的隔离副本里跑（不在项目目录下）：按这个项目的运行记录认它们
  const roots = [projectPath, ...mine.map((w) => w.worktreePath), ...runs.filter((r) => !r.closedAt).map((r) => r.isolationPath)];
  const open = await safe(invoke<OpenDispatch[]>("assistant_open_dispatches"), []);
  const dispatchedHere = (cwd: string, taskId: string | undefined) =>
    open.some(
      (d) =>
        samePath(d.projectRoot, projectPath, IS_WINDOWS) &&
        ((!!taskId && d.record.taskId === taskId) || (!!d.record.worktreePath && pathWithin(cwd, d.record.worktreePath, IS_WINDOWS))),
    );
  const confirms = live
    .filter((r) => !!r.blocker && roots.some((root) => pathWithin(r.cwd, root, IS_WINDOWS)))
    .map((r) => ({
      tabId: r.tabId,
      title: r.title,
      step: steps.find((s) => s.worktreePath && pathWithin(r.cwd, s.worktreePath, IS_WINDOWS)) ?? null,
      blocker: r.blocker!,
      dispatched: dispatchedHere(r.cwd, r.taskId),
    }));
  return buildDeskItems({
    steps,
    help: helpNotDismissed(help, loadHelpDismissed()).filter((h) => samePath(h.repoPath, projectPath, IS_WINDOWS)),
    tails,
    confirms,
    grants: schedules
      .filter((s) => s.grantRequest && samePath(s.projectRoot, projectPath, IS_WINDOWS))
      .map((s) => ({ scheduleId: s.id, name: s.name, at: s.grantRequest!.at, blocked: s.grantRequest!.blocked })),
  });
}

/** 授权请求：放宽重跑这一次 / 不用（桌面与手机共用；「以后都放宽」只在桌面的定时任务编辑里改） */
export async function answerGrant(item: DeskItem, once: boolean): Promise<string> {
  if (!item.scheduleId) throw new Error("这件不是授权请求");
  await invoke(once ? "schedule_grant_once" : "schedule_grant_dismiss", { id: item.scheduleId });
  return once ? `已放宽，${item.where}这一次联网不限、马上重跑；跑完回到原来的授权。` : `好的，${item.where}的授权不变。`;
}

async function workspaceFor(path: string | null | undefined): Promise<WorkspaceDto | null> {
  if (!path) return null;
  const list = await safe(invoke<WorkspaceDto[]>("list_workspaces"), []);
  return list.find((w) => samePath(w.worktreePath, path, IS_WINDOWS)) ?? null;
}

/**
 * 回一件「等你的事」：人工请求写回作答，再把「按决定继续」送进那一步；对话里的问题把原话送进那段对话。
 * 等确认的命令不在这里答（只在桌面、回对话里确认），调用方先按分级表挡住。返回给人看的一句。
 */
export async function replyDesk(projectPath: string, item: DeskItem, text: string): Promise<string> {
  const value = text.trim();
  if (!value) throw new Error("回复是空的");
  if (item.kind === "confirm") throw new Error("等确认的命令要回到电脑上的对话里确认");
  if (item.kind === "help") {
    const saved = await invoke<HelpItemDto>("help_request_answer", {
      root: item.helpRoot,
      itemId: item.helpItemId,
      answer: value,
      remember: null,
    });
    const ws = (await workspaceFor(item.worktreePath)) ?? (await workspaceFor(item.helpRoot));
    const deliveryRun = await invoke<RunDto>("help_delivery_prepare", { root: item.helpRoot, itemIds: [saved.id], retry: false });
    if (deliveryRun.runtime === "headless") return "回答已保存；后台按原连接与授权继续，做完照常等你评审";
    if (!ws) return "已记下你的回答；这条来自项目根，回到那段对话里点「交给 Agent」才送得到";
    if (!liveRunIn(ws.worktreePath)) {
      const request = await buildWorkspaceTerminalRequest(ws, undefined, { autoStart: true, resumeSession: true });
      request.runId = deliveryRun.id;
      request.taskId = deliveryRun.taskId || undefined;
      request.agentId = deliveryRun.agent;
      request.profileId = deliveryRun.profileId ?? undefined;
      request.focusSession = undefined;
      request.resume = deliveryRun.sessionId ? { agentId: deliveryRun.agent, sessionId: deliveryRun.sessionId } : undefined;
      request.autoStart = Boolean(deliveryRun.profileId);
      useAppStore.getState().setPendingTerminal(request);
      useAppStore.getState().setPage("terminal");
    }
    return `已记下，回答已排队；${item.where}的 AI 空闲时送到，送到前仍保留在待处理里`;
  }
  const ws = await workspaceFor(item.worktreePath);
  if (!ws) throw new Error(`${item.where}的工作副本不在了，送不到`);
  const sent = await sendToWorkspace(projectPath, ws, null, relayText(value));
  return sent.mode === "mail" ? `已原话留给${item.where}的 AI，它空闲时送到` : `已接回${item.where}的对话，把你的话原样送了进去`;
}

/** 替人按信任菜单（仍是人点的那一下：桌面「等你的事」或手机卡片上点）：交给终端页那个标签读屏核对再回车 */
export function answerTrust(item: DeskItem, accept: boolean): void {
  if (!item.tabId) return;
  useAppStore.getState().setTrustAnswerReq({ tabId: item.tabId, accept, token: Date.now() });
}

/** 带路去确认：切到那个终端标签（只在桌面） */
export function focusConfirm(item: DeskItem): void {
  if (!item.tabId) return;
  const s = useAppStore.getState();
  s.setFocusTabReq(item.tabId);
  s.setPage("terminal");
}

/** 记一条规矩进项目知识「已定 / 不做」（项目助手的「以后照这样办」，桌面卡片与飞书按钮共用） */
export async function addProjectKnowledge(projectPath: string, text: string): Promise<void> {
  const doc = await invoke<{ revision: string }>("project_memory_read", { path: projectPath });
  await invoke("project_memory_update", {
    path: projectPath,
    expectedRevision: doc.revision,
    id: null,
    action: "add",
    text: text.trim(),
    reason: `项目助手对话里由你确认（${new Date().toLocaleDateString()}）`,
  });
}
