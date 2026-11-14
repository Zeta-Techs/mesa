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
import { invalidateAssistantSnapshot } from "./project-assistant-run";
import { buildDeskItems, loadDismissedDeskQuestions, relayText, type DeskItem, type DeskStep, type DeskTailInput } from "./assistant-queue";
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
    live.some((r) => r.running && !r.shell && pathWithin(r.cwd, path, IS_WINDOWS) && (r.attention === "working" || r.attention === "confirm" || !!r.blocker));
  // 目标在 Mesa 自己的隔离副本里跑（不在项目目录下）：按这个项目的运行记录认它们
  const roots = [projectPath, ...mine.map((w) => w.worktreePath), ...runs.filter((r) => !r.closedAt).map((r) => r.isolationPath)];
  const stepTails = await Promise.all(
    steps
      .filter((s) => s.worktreePath)
      .map(async (s): Promise<DeskTailInput | null> => {
        const tail = await stepSessionTail(runs, s.worktreePath!).catch(() => null);
        return tail ? { step: s, text: tail.text, busy: busy(s.worktreePath!) } : null;
      }),
  );
  // 项目根对话、目标隔离副本对话等非步骤交互活：同样读最后一段话抓提问，就地原路转达
  const nonStepLive = live.filter(
    (r) =>
      r.running &&
      !r.shell &&
      !!r.cwd &&
      !steps.some((s) => s.worktreePath && pathWithin(r.cwd, s.worktreePath, IS_WINDOWS)) &&
      roots.some((root) => pathWithin(r.cwd, root, IS_WINDOWS)),
  );
  const seenFallbackCwd = new Set<string>();
  const nonStepTails = await Promise.all(
    nonStepLive.map(async (r): Promise<DeskTailInput | null> => {
      const matched = r.runId ? runs.find((x) => x.id === r.runId) : undefined;
      const sid = r.sessionId || matched?.sessionId || null;
      let scoped: readonly RunDto[];
      if (sid) {
        scoped = [
          matched
            ? { ...matched, sessionId: sid }
            : ({
                id: r.runId ?? r.tabId,
                agent: r.agentId,
                sessionId: sid,
                isolationPath: r.cwd,
                createdAt: "9999",
                internal: false,
              } as RunDto),
        ];
      } else {
        const key = IS_WINDOWS ? r.cwd.toLowerCase() : r.cwd;
        if (seenFallbackCwd.has(key)) return null;
        seenFallbackCwd.add(key);
        scoped = runs;
      }
      const tail = await stepSessionTail(scoped, r.cwd).catch(() => null);
      if (!tail) return null;
      return {
        step: null,
        where: `对话「${r.title || "未命名"}」`,
        targetRoot: r.cwd,
        runId: r.runId,
        tabId: r.tabId,
        text: tail.text,
        busy: r.attention === "working" || r.attention === "confirm" || !!r.blocker,
      };
    }),
  );
  const tails = [...stepTails, ...nonStepTails].filter((t): t is DeskTailInput => !!t);
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
      cwd: r.cwd,
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
    dismissedQuestions: loadDismissedDeskQuestions(),
    isWindows: IS_WINDOWS,
  });
}

/** 授权请求：放宽重跑这一次 / 不用（桌面与手机共用；「以后都放宽」只在桌面的定时任务编辑里改） */
export async function answerGrant(item: DeskItem, once: boolean): Promise<string> {
  if (!item.scheduleId) throw new Error("这件不是授权请求");
  await invoke(once ? "schedule_grant_once" : "schedule_grant_dismiss", { id: item.scheduleId });
  invalidateAssistantSnapshot();
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
export async function replyDesk(
  projectPath: string,
  item: DeskItem,
  text: string,
  remember: "已定" | "不做" | null = null,
): Promise<string> {
  const value = text.trim();
  if (!value) throw new Error("回复是空的");
  if (item.kind === "confirm") throw new Error("等确认的命令要回到电脑上的对话里确认");
  if (item.kind === "help") {
    const saved = await invoke<HelpItemDto>("help_request_answer", {
      root: item.helpRoot,
      itemId: item.helpItemId,
      answer: value,
      remember: remember ?? null,
    });
    invalidateAssistantSnapshot(projectPath);
    const ws = (await workspaceFor(item.worktreePath)) ?? (await workspaceFor(item.helpRoot));
    let deliveryRun: RunDto;
    try {
      deliveryRun = await invoke<RunDto>("help_delivery_prepare", { root: item.helpRoot, itemIds: [saved.id], retry: false });
    } catch (reason) {
      return `已记下你的回答，但暂未交给 Agent：${String(reason)}`;
    }
    if (deliveryRun.runtime === "headless") {
      const [help, schedules] = await Promise.all([
        safe(invoke<HelpRequestDto[]>("list_help_requests"), []),
        safe(invoke<ScheduleDto[]>("list_schedules"), []),
      ]);
      const src = help.find((h) => samePath(h.root, item.helpRoot ?? "", IS_WINDOWS));
      const rem = src?.items.filter((i) => !i.sent && !i.answer).length ?? 0;
      const sched = deliveryRun.taskRef ? schedules.find((s) => s.id === deliveryRun.taskRef) : undefined;
      if (sched?.followupState === "uncertain") return "回答已记下，但上次后台跟进已暂停，请回电脑核对定时任务产物";
      if (rem > 0) return `回答已记下；这处后台跟进还有 ${rem} 条问题待答，全部答完后后台按原授权继续`;
      if (sched && !sched.enabled) return "回答已保存；这条定时任务当前已暂停，在电脑上打开开关后后台才会继续";
      return "回答已保存；后台按原连接与授权继续，做完照常等你评审";
    }
    if (!ws) {
      if (item.helpRoot && !liveRunIn(item.helpRoot)) {
        useAppStore.getState().setPendingTerminal({
          cwd: item.helpRoot,
          extraEnv: {},
          title: item.where,
          runId: deliveryRun.id,
          taskId: deliveryRun.taskId || undefined,
          agentId: deliveryRun.agent,
          profileId: deliveryRun.profileId ?? undefined,
          resume: deliveryRun.sessionId ? { agentId: deliveryRun.agent, sessionId: deliveryRun.sessionId } : undefined,
          autoStart: Boolean(deliveryRun.profileId),
        });
        useAppStore.getState().setPage("terminal");
      }
      return `已记下，回答已排队；${item.where}的 AI 空闲时送到，送到前仍保留在待处理里`;
    }
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
  if (!ws) {
    const liveById = item.runId
      ? useAppStore.getState().terminalRunInputs.find((r) => r.running && !r.shell && r.runId === item.runId)?.runId ?? null
      : null;
    const liveRun = liveById ?? (item.worktreePath ? liveRunIn(item.worktreePath) : null);
    if (liveRun) {
      await invoke<string>("mail_send", { toRun: liveRun, text: relayText(value) });
      invalidateAssistantSnapshot(projectPath);
      return `已原话留给${item.where}的 AI，它空闲时送到`;
    }
    const runs = await safe(invoke<RunDto[]>("run_list", { projectRoot: projectPath }), []);
    const run =
      (item.runId ? runs.find((r) => !r.internal && !!r.sessionId && r.id === item.runId) : undefined) ??
      runs
        .filter((r) => !r.internal && !!r.sessionId && !!item.worktreePath && pathWithin(r.isolationPath, item.worktreePath, IS_WINDOWS))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    if (run?.sessionId && item.worktreePath) {
      useAppStore.getState().setPendingTerminal({
        cwd: item.worktreePath,
        extraEnv: {},
        title: item.where,
        runId: run.id,
        taskId: run.taskId || undefined,
        agentId: run.agent,
        profileId: run.profileId ?? undefined,
        resume: { agentId: run.agent, sessionId: run.sessionId },
        initialPrompt: relayText(value),
        autoStart: Boolean(run.profileId),
      });
      useAppStore.getState().setPage("terminal");
      invalidateAssistantSnapshot(projectPath);
      return `已接回${item.where}的对话，把你的话原样送了进去`;
    }
    throw new Error(`${item.where}的工作副本不在了，送不到`);
  }
  const sent = await sendToWorkspace(projectPath, ws, null, relayText(value));
  invalidateAssistantSnapshot(projectPath);
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

const knowledgeQueues = new Map<string, Promise<void>>();

/** 记一条规矩进项目知识「已定 / 不做」（项目助手的「以后照这样办」，桌面卡片与飞书按钮共用；按项目排队防连点多张时乐观锁撞车） */
export async function addProjectKnowledge(projectPath: string, text: string): Promise<void> {
  const key = projectPath.trim();
  const line = text.trim();
  if (!line) return;
  const writeOnce = async () => {
    const doc = await invoke<{ revision: string; entries?: { text: string; meta: { state: string } }[] }>("project_memory_read", { path: projectPath });
    if (doc.entries?.some((e) => e.meta.state === "active" && e.text.trim() === line)) return;
    await invoke("project_memory_update", {
      path: projectPath,
      expectedRevision: doc.revision,
      id: null,
      action: "add",
      text: line,
      reason: `项目助手对话里由你确认（${new Date().toLocaleDateString()}）`,
    });
    invalidateAssistantSnapshot(projectPath);
  };
  const prev = knowledgeQueues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    try {
      await writeOnce();
    } catch (reason) {
      if (!/版本已变|并发|revision|过时/i.test(String(reason))) throw reason;
      await writeOnce();
    }
  });
  knowledgeQueues.set(key, next);
  return next;
}
