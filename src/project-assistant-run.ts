/**
 * 项目助手的取数与问一次（2026-11-04，docs/design-project-assistant.md §4–5）。
 * 全部用已有命令取数（只读），拼成 project-snapshot.ts 的输入；问答经后端 `project_assistant_ask`（出站前脱敏、落记录）。
 * 某一样读不到就跳过那一块，不挡回答。
 */
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { IS_MAC, IS_WINDOWS } from "./hotkeys";
import { useAppStore } from "./store";
import { pathWithin, samePath } from "./path-utils";
import { stepAttention } from "./run-overview";
import { isAppCrashClose, latestRunFailure } from "./run-failure";
import { projectAssistantLaunch } from "./project-agents";
import { AGENTS } from "./types";
import { buildProjectSnapshot, type SnapshotInput, type SnapshotRun, type SnapshotStep } from "./project-snapshot";
import { buildAssistantPrompt, type AssistantHistoryTurn } from "./project-assistant";
import type { ChecksDto } from "./research-checks";
import type { DepCheckDto } from "./dep-check";
import type { MesaErrorRecord } from "./mesa-errors";
import type {
  DetectResult,
  HelpRequestDto,
  ProjectConfigReadDto,
  ProjectDto,
  ProjectMailDto,
  ProjectMemoryDocumentDto,
  RunDto,
  RunEventDto,
  TaskDto,
  WorkspaceDto,
  WorkspaceHealthDto,
} from "./types";

export interface AssistantTurn {
  at: string;
  question: string;
  answer: string;
  connection: string;
}

/** 「问问为什么」带进来的那件事 */
export interface AssistantFocus {
  title: string;
  detail: string;
  runId?: string | null;
}

const GOAL_STATUS: Record<string, string> = {
  pending: "记下了还没开工",
  queued: "排队中",
  running: "进行中",
  pending_review: "做完了等你验收",
  completed: "已完成",
  failed: "上次失败",
  stopped: "上次停了",
};

/** 读不到（报错或返回空值）一律当没有，不挡回答 */
function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  return p.then((v) => v ?? fallback).catch(() => fallback);
}

function eventLine(e: RunEventDto): string {
  return `${e.createdAt} ${e.eventType}${e.payload ? ` ${e.payload}` : ""}`;
}

/** 这个项目用谁答（专属绑定 > 项目默认 > AI 功能连接），以及给人看的一行 */
export function assistantConnection(project: ProjectDto | null): {
  profileId: string | null;
  model: string | null;
  line: string;
  bound: boolean;
} {
  const { profiles } = useAppStore.getState();
  const launch = projectAssistantLaunch(profiles, project);
  if (!launch) return { profileId: null, model: null, line: "设置里「AI 功能」的连接", bound: false };
  const profile = profiles.find((p) => p.id === launch.profileId);
  const agent = AGENTS.find((a) => a.id === launch.agentId)?.label ?? launch.agentId;
  const line = [agent, profile?.name, launch.model || "默认模型"].filter(Boolean).join(" · ");
  return { profileId: launch.profileId, model: launch.model || null, line, bound: launch.bound };
}

export async function gatherSnapshot(projectPath: string, focus: AssistantFocus | null): Promise<string> {
  const [projects, read, workspaces, runs, tasks, help, mail, memory, mesaErrors, appLog, detected, version] =
    await Promise.all([
      safe(invoke<ProjectDto[]>("list_projects"), []),
      safe(invoke<ProjectConfigReadDto | null>("read_project_config", { path: projectPath }), null),
      safe(invoke<WorkspaceDto[]>("list_workspaces"), []),
      safe(invoke<RunDto[]>("run_list", { projectRoot: projectPath }), []),
      safe(invoke<TaskDto[]>("task_list", { projectRoot: projectPath, includeArchived: false }), []),
      safe(invoke<HelpRequestDto[]>("list_help_requests"), []),
      safe(invoke<ProjectMailDto[]>("mail_list", { projectRoot: projectPath }), []),
      safe(invoke<ProjectMemoryDocumentDto | null>("project_memory_read", { path: projectPath }), null),
      safe(invoke<MesaErrorRecord[]>("mesa_errors_read", { projectRoot: projectPath, limit: 30 }), []),
      safe(invoke<{ ts: string; level: string; source: string; message: string }[]>("get_app_log", { limit: 300 }), []),
      safe(invoke<DetectResult[]>("detect_agents"), []),
      safe(getVersion(), ""),
    ]);
  const state = useAppStore.getState();
  const deps: DepCheckDto | null =
    state.depCheck ?? (await safe(invoke<DepCheckDto>("check_dependencies"), null as DepCheckDto | null));
  const project = projects.find((p) => samePath(p.path, projectPath, IS_WINDOWS)) ?? null;
  const cfg = read?.config ?? null;
  const mine = workspaces.filter((w) => samePath(w.repoPath, projectPath, IS_WINDOWS));
  const live = state.terminalRunInputs;

  const steps: SnapshotStep[] = await Promise.all(
    (cfg?.steps ?? []).map(async (s, index) => {
      const ws = mine.find((w) => w.name === s.workspaceName && w.status !== "archived") ?? null;
      const base = {
        index,
        name: s.name,
        brief: s.brief,
        expectedArtifacts: s.expectedArtifacts,
        acceptanceCriteria: s.acceptanceCriteria ?? [],
        worktreePath: ws?.worktreePath ?? null,
      };
      if (!ws) {
        return { ...base, state: s.seedComplete ? "已完成（示例预置）" : "还没开始", failure: null, checks: [], reviewNotes: null };
      }
      const [health, checks, reviewNotes] = await Promise.all([
        safe(invoke<WorkspaceHealthDto>("workspace_health", { id: ws.id }), null as WorkspaceHealthDto | null),
        safe(invoke<ChecksDto>("research_checks_read", { path: ws.worktreePath }), null as ChecksDto | null),
        safe(invoke<string | null>("assistant_review_notes", { worktreePath: ws.worktreePath }), null),
      ]);
      const attention = stepAttention(ws, live, IS_WINDOWS);
      const failure = latestRunFailure(runs, ws.worktreePath, IS_WINDOWS)?.reason ?? null;
      let stateText: string;
      if (health?.conflict) stateText = "有冲突，等你在评审里处理";
      else if (attention === "working") stateText = "AI 正在干活";
      else if (attention === "confirm") stateText = "AI 在等你确认";
      else if (ws.mergedAt && health?.ahead === 0) stateText = "已保存进项目";
      else if (failure) stateText = "出错了";
      else if ((health?.ahead ?? 0) > 0) stateText = "做完了等你评审、保存进项目";
      else if (attention === "done") stateText = "AI 这一轮说完了，等你看";
      else stateText = health?.uncommitted ? "进行中，工作副本里有没保存的改动" : "进行中";
      return { ...base, state: stateText, failure, checks: checks?.items ?? [], reviewNotes };
    }),
  );

  const where = (run: RunDto): string => {
    const step = steps.find((s) => s.worktreePath && pathWithin(run.isolationPath, s.worktreePath, IS_WINDOWS));
    if (step) return `第 ${step.index + 1} 步`;
    const goal = tasks.find((t) => t.id === run.taskId);
    if (goal && goal.kind !== "step") return `目标「${goal.name}」`;
    return "对话";
  };
  const visibleRuns = runs.filter((r) => !r.internal).slice(0, 20);
  const snapshotRuns: SnapshotRun[] = visibleRuns.map((r) => ({ ...r, where: where(r) }));
  const failed = visibleRuns.filter((r) => r.status === "failed" && !isAppCrashClose(r)).slice(0, 2);
  const failedRunEvents = await Promise.all(
    failed.map(async (r) => ({
      where: where(r),
      events: (await safe(invoke<RunEventDto[]>("run_events", { id: r.id }), [])).slice(-8).map(eventLine),
    })),
  );
  const focusEvents = focus?.runId
    ? (await safe(invoke<RunEventDto[]>("run_events", { id: focus.runId }), [])).slice(-12).map(eventLine)
    : [];

  const roots = [projectPath, ...mine.map((w) => w.worktreePath)];
  const related = (text: string) => roots.some((r) => text.includes(r));
  const helpItems = help
    .filter((h) => samePath(h.repoPath, projectPath, IS_WINDOWS))
    .flatMap((h) =>
      h.items
        .filter((i) => !i.answer)
        .map((i) => ({
          where: h.workspaceName ? `工作副本「${h.workspaceName}」` : "项目根",
          question: i.question,
          options: i.options.map((o) => `${o.key}：${o.label}`),
          recommend: i.recommend,
        })),
    );
  const depRows = deps
    ? (
        [
          ["Git", deps.git],
          ["Node", deps.node],
          ["Quarto", deps.quarto],
          ["LaTeX", deps.tex],
        ] as const
      ).map(([name, d]) => ({ name, status: d.status, version: d.version, note: d.note }))
    : [];

  const input: SnapshotInput = {
    now: new Date().toISOString(),
    mesaVersion: version || "未知",
    platform: IS_MAC ? "macOS" : IS_WINDOWS ? "Windows" : "Linux",
    project: {
      name: project?.name ?? projectPath.split(/[\\/]/).filter(Boolean).pop() ?? projectPath,
      path: projectPath,
      workMode: project?.workMode ?? null,
      topic: cfg?.topic ?? null,
      settings: cfg?.settings ?? [],
      hasPipeline: (cfg?.steps.length ?? 0) > 0,
      defaultAgent: project?.defaultAgent ?? null,
    },
    steps,
    goals: tasks
      .filter((t) => t.kind !== "step" && !t.archivedAt)
      .slice(0, 12)
      .map((t) => ({ name: t.name, status: GOAL_STATUS[t.status] ?? t.status })),
    runs: snapshotRuns,
    focus: focus ? { title: focus.title, detail: focus.detail, events: focusEvents } : null,
    failedRunEvents,
    helpItems,
    pendingMail: mail.filter((m) => m.status === "pending").map((m) => `${m.fromLabel} → ${m.toLabel}：${m.text}`),
    mesaErrors,
    appLog: appLog.filter((l) => l.level !== "info" && related(`${l.source} ${l.message}`)),
    deps: depRows,
    agents: detected.map((d) => ({ id: AGENTS.find((a) => a.id === d.id)?.label ?? d.id, installed: !!d.binaryPath, version: d.version })),
    decided: memory?.entries.filter((e) => e.meta.state === "active").map((e) => e.text) ?? [],
  };
  return buildProjectSnapshot(input);
}

/** 问一次：取快照 → 拼提示词 → 后端脱敏后无头调用、落记录。项目默认那家不支持无头调用时退回「AI 功能」的连接 */
export async function askProjectAssistant(input: {
  projectPath: string;
  project: ProjectDto | null;
  question: string;
  history: readonly AssistantHistoryTurn[];
  focus: AssistantFocus | null;
}): Promise<AssistantTurn> {
  const snapshot = await gatherSnapshot(input.projectPath, input.focus);
  const prompt = buildAssistantPrompt({ snapshot, history: input.history, question: input.question });
  const conn = assistantConnection(input.project);
  const ask = (profileId: string | null, model: string | null, connection: string) =>
    invoke<AssistantTurn>("project_assistant_ask", {
      projectRoot: input.projectPath,
      profileId,
      model,
      connection,
      question: input.question,
      prompt,
    });
  try {
    return await ask(conn.profileId, conn.model, conn.line);
  } catch (reason) {
    if (!conn.profileId || conn.bound || !String(reason).includes("不支持无头调用")) throw reason;
    return ask(null, null, "设置里「AI 功能」的连接");
  }
}
