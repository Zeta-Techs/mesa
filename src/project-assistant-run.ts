/**
 * 项目助手的取数与问一次（2026-11-04，docs/design-project-assistant.md §4–5）。
 * 全部用已有命令取数（只读），拼成 project-snapshot.ts 的输入；问答经后端 `project_assistant_ask`（出站前脱敏、落记录）。
 * 某一样读不到就跳过那一块，不挡回答。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { IS_MAC, IS_WINDOWS } from "./hotkeys";
import { useAppStore } from "./store";
import { pathWithin, samePath } from "./path-utils";
import { stepAttention } from "./run-overview";
import { isAppCrashClose, latestRunFailure } from "./run-failure";
import { projectAssistantLaunch } from "./project-agents";
import { AGENTS } from "./types";
import { buildProjectSnapshot, type SnapshotInput, type SnapshotRun, type SnapshotStep } from "./project-snapshot";
import {
  basisText,
  historyKeep,
  recallOlderTurns,
  buildAssistantPrompt,
  classifyQuestion,
  GUIDE_LIMIT,
  inspectRules,
  INSPECT_AGENTS,
  intentEffort,
  isReviewAsk,
  mentionedStep,
  previousTurnHint,
  SNAPSHOT_MAX_CHARS,
  wantsInspect,
  type AssistantHistoryTurn,
  type AssistantIntent,
} from "./project-assistant";
import type { CheckItem, ChecksDto } from "./research-checks";
import { mergeMesaChecks } from "./outline-check";
import { loadDraftCheck, loadNotesCheck, loadOutlineCheck, loadStepWritingChecks } from "./research-report-load";
import { stepKind } from "./step-kind";
import { reviewingStep, reviewRoundFocus } from "./assistant-brief";
import { renderProjectMap, type MapEntry } from "./project-map";
import { builtinTaskCatalogLines } from "./builtin-tasks";
import { PIPELINE_TEMPLATES } from "./pipeline-presets";
import { TRIGGER_CATALOG_LINES, workerCapabilityLines } from "./assistant-capabilities";
import { projectDefaultProfile } from "./split-draft";
import { resolveTaskModel } from "./project-agents";
import { dispatchStatus, type DispatchRecord } from "./assistant-dispatch";
import { stepSessionTail } from "./session-tail";
import type { BriefInput, BriefStep } from "./assistant-brief";
import { hasKnowledgeSources } from "./assistant-brief";
import type { DirEntryDto } from "./components/FileTree";
import { declaredTaskKindsForMode, visibleDeclaredTasks } from "./project-tasks";
import type { DepCheckDto } from "./dep-check";
import type { MesaErrorRecord } from "./mesa-errors";
import type {
  AgentCapabilitiesDto,
  DetectResult,
  ModelCapabilityDto,
  HelpRequestDto,
  ProjectConfigReadDto,
  ProjectDto,
  ProjectMailDto,
  KnowledgeForAiDto,
  RunDto,
  RunEventDto,
  SkillDto,
  TaskDto,
  TaskPackDto,
  WorkspaceDto,
  WorkspaceHealthDto,
} from "./types";

export interface AssistantTurn {
  at: string;
  question: string;
  answer: string;
  connection: string;
  /** 这一问依据了什么（说明书哪几节 / 这个项目的记录）；旧记录没有 */
  basis?: string;
  /** 这次调用花了多少（美元；只有 Claude Code / Codex、模型查得到价时有） */
  costUsd?: number | null;
  /** 这一轮的派活单派出去了 */
  dispatched?: DispatchRecord | null;
  /** 派活回音（2026-11-05）：为哪一轮派出去的活补的进展；问题为空，不当成问答喂给 AI */
  echoOf?: string | null;
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

/** 一步的核验项：核验文件里的 + 大纲那一步 Mesa 自己核对的（与评审页同一个纯函数，评审页不写文件，这里再算一遍） */
async function stepChecks(
  step: { skills?: readonly string[]; expectedArtifacts?: readonly string[] },
  worktree: string,
  projectPath: string,
): Promise<CheckItem[]> {
  // 大纲、精读、初稿、定稿另有 Mesa 核对（2026-11-11）：与评审页同一个函数现算
  const kind = stepKind(step, undefined);
  const roots = [worktree, projectPath];
  const mesa: Promise<CheckItem[]> =
    kind === "outline"
      ? loadOutlineCheck(roots).then((r) => r?.items ?? [])
      : kind === "notes"
        ? loadNotesCheck(roots)
        : kind === "writing" || kind === "final"
          ? loadDraftCheck(roots, kind, step.expectedArtifacts ?? [])
          : Promise.resolve([]);
  const [file, own] = await Promise.all([
    safe(invoke<ChecksDto>("research_checks_read", { path: worktree }), null as ChecksDto | null),
    mesa.catch(() => [] as CheckItem[]),
  ]);
  const writing = await loadStepWritingChecks(worktree, kind, step.expectedArtifacts ?? [], own).catch(() => [] as CheckItem[]);
  return mergeMesaChecks(file, [...own, ...writing])?.items ?? [];
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
  /** 用的是哪家 Agent；走「AI 功能」连接时前端不知道，为 null */
  agentId: string | null;
} {
  const { profiles } = useAppStore.getState();
  const launch = projectAssistantLaunch(profiles, project);
  if (!launch) return { profileId: null, model: null, line: "设置里「AI 功能」的连接", bound: false, agentId: null };
  const profile = profiles.find((p) => p.id === launch.profileId);
  const agent = AGENTS.find((a) => a.id === launch.agentId)?.label ?? launch.agentId;
  const line = [agent, profile?.name, launch.model || "默认模型"].filter(Boolean).join(" · ");
  return { profileId: launch.profileId, model: launch.model || null, line, bound: launch.bound, agentId: launch.agentId };
}

export async function gatherSnapshot(projectPath: string, focus: AssistantFocus | null): Promise<string> {
  const [projects, read, workspaces, runs, tasks, help, mail, memory, mesaErrors, appLog, detected, version, profile] =
    await Promise.all([
      safe(invoke<ProjectDto[]>("list_projects"), []),
      safe(invoke<ProjectConfigReadDto | null>("read_project_config", { path: projectPath }), null),
      safe(invoke<WorkspaceDto[]>("list_workspaces"), []),
      safe(invoke<RunDto[]>("run_list", { projectRoot: projectPath }), []),
      safe(invoke<TaskDto[]>("task_list", { projectRoot: projectPath, includeArchived: false }), []),
      safe(invoke<HelpRequestDto[]>("list_help_requests"), []),
      safe(invoke<ProjectMailDto[]>("mail_list", { projectRoot: projectPath }), []),
      safe(invoke<KnowledgeForAiDto | null>("project_memory_for_ai", { path: projectPath }), null),
      safe(invoke<MesaErrorRecord[]>("mesa_errors_read", { projectRoot: projectPath, limit: 30 }), []),
      safe(invoke<{ ts: string; level: string; source: string; message: string }[]>("get_app_log", { limit: 300 }), []),
      safe(invoke<DetectResult[]>("detect_agents"), []),
      safe(getVersion(), ""),
      safe(invoke<string>("research_profile_context"), ""),
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
        stepChecks(s, ws.worktreePath, projectPath),
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
      return { ...base, state: stateText, failure, checks, reviewNotes };
    }),
  );

  // 交互对话里的出错不进运行记录：各步最近那段对话里 AI 最后说的话（只读最后一页）
  const stepTails = (
    await Promise.all(
      steps
        .filter((s) => s.worktreePath)
        .map(async (s) => {
          const tail = await stepSessionTail(runs, s.worktreePath!);
          return tail ? { where: `第 ${s.index + 1} 步「${s.name}」`, text: tail.text, flagged: tail.flagged } : null;
        }),
    )
  ).filter((t): t is { where: string; text: string; flagged: boolean } => !!t);
  // 项目助手自己派过的活与现在的进度（问「进度」时说得出「第 2 步正在按派活单改」）
  const dispatchedTurns = (await safe(invoke<AssistantTurn[]>("assistant_log_read", { projectRoot: projectPath }), []))
    .filter((t) => t.dispatched)
    .slice(-6);
  const dispatched = await Promise.all(
    dispatchedTurns.map(async (t) => {
      const d = t.dispatched!;
      const status = await dispatchStatus(d, projectPath).catch(() => ({ text: "看不到进度", tone: "idle" as const }));
      const to = d.target === "step" ? `第 ${d.step} 步` : "新目标";
      const how = d.mode === "mail" ? "留话" : d.mode === "resume" ? "接回对话开跑" : "记成目标开工";
      return `「${d.title}」交给${to}（${how}，${d.at}）· 现在：${status.text}`;
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
          ["数据分析库（numpy / pandas / matplotlib）", deps.datasci],
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
    decided: memory?.lines ?? [],
    profile,
    dispatched,
    stepTails,
  };
  return buildProjectSnapshot(input, SNAPSHOT_MAX_CHARS);
}

/** 快照留 90 秒：接着追问不用每次重新取一遍（带「这次重点」的不走缓存） */
const SNAPSHOT_TTL_MS = 90_000;
const snapshotCache = new Map<string, { at: number; text: string }>();

/** 面板一打开就先把项目记录整理好（你打字时已经取完，问的时候不再等这一两秒）；失败不管 */
/** 「现在的情况」卡与常用问题的取数（assistant-brief.ts 只算）：步骤状态与 gatherSnapshot 同口径，但不读对话尾巴、不拼文字 */
export async function gatherBriefInput(projectPath: string, since: string | null): Promise<BriefInput> {
  const [read, workspaces, runs, tasks, projects, knowledge, topLevel] = await Promise.all([
    safe(invoke<ProjectConfigReadDto | null>("read_project_config", { path: projectPath }), null),
    safe(invoke<WorkspaceDto[]>("list_workspaces"), []),
    safe(invoke<RunDto[]>("run_list", { projectRoot: projectPath }), []),
    safe(invoke<TaskDto[]>("task_list", { projectRoot: projectPath, includeArchived: false }), []),
    safe(invoke<ProjectDto[]>("list_projects"), []),
    safe(invoke<KnowledgeForAiDto | null>("project_memory_for_ai", { path: projectPath }), null),
    safe(invoke<DirEntryDto[]>("list_dir", { path: projectPath, showHidden: false }), [] as DirEntryDto[]),
  ]);
  const cfg = read?.config ?? null;
  const mine = workspaces.filter((w) => samePath(w.repoPath, projectPath, IS_WINDOWS));
  const live = useAppStore.getState().terminalRunInputs;
  const steps: BriefStep[] = await Promise.all(
    (cfg?.steps ?? []).map(async (s, index): Promise<BriefStep> => {
      const ws = mine.find((w) => w.name === s.workspaceName && w.status !== "archived") ?? null;
      const n = index + 1;
      if (!ws) return { n, name: s.name, state: s.seedComplete ? "saved" : "idle", needsHuman: 0 };
      const [health, checks] = await Promise.all([
        safe(invoke<WorkspaceHealthDto>("workspace_health", { id: ws.id }), null as WorkspaceHealthDto | null),
        stepChecks(s, ws.worktreePath, projectPath),
      ]);
      const attention = stepAttention(ws, live, IS_WINDOWS);
      const failure = latestRunFailure(runs, ws.worktreePath, IS_WINDOWS)?.reason ?? null;
      const state: BriefStep["state"] =
        attention === "working"
          ? "working"
          : attention === "confirm"
            ? "confirm"
            : ws.mergedAt && health?.ahead === 0
              ? "saved"
              : failure
                ? "failed"
                : (health?.ahead ?? 0) > 0 || health?.conflict
                  ? "review"
                  : "open";
      const needsHuman = checks.filter((c) => c.status === "needs_human").length;
      return { n, name: s.name, state, failure, mergedAt: ws.mergedAt ?? null, needsHuman };
    }),
  );
  const workMode = projects.find((p) => samePath(p.path, projectPath, IS_WINDOWS))?.workMode;
  const goals = visibleDeclaredTasks(tasks, declaredTaskKindsForMode(workMode)).map((t) => ({ name: t.name, status: t.status, updatedAt: t.updatedAt }));
  // 读不到项目知识时不提议（宁可不提，也别对已有知识的项目说「还没有」）；项目根没有约定文件也不提议（起草了也是「一条没找到」）
  const knowledgeEmpty =
    !!knowledge && knowledge.lines.length === 0 && knowledge.stale === 0 && hasKnowledgeSources(topLevel.filter((e) => !e.isDir).map((e) => e.name));
  return { hasFlow: steps.length > 0, steps, goals, since, knowledgeEmpty };
}

export function prefetchSnapshot(projectPath: string): void {
  void cachedSnapshot(projectPath, null).catch(() => {});
}

async function cachedSnapshot(projectPath: string, focus: AssistantFocus | null): Promise<string> {
  if (!focus) {
    const hit = snapshotCache.get(projectPath);
    if (hit && Date.now() - hit.at < SNAPSHOT_TTL_MS) return hit.text;
  }
  const text = await gatherSnapshot(projectPath, focus);
  if (!focus) snapshotCache.set(projectPath, { at: Date.now(), text });
  return text;
}

/** 不看项目记录的几类问题（怎么用 / 寒暄 / 判不出）只带的一点概况：当前时间、项目名、工作方式、默认 Agent、项目助手用的连接 */
function projectContext(projectPath: string, project: ProjectDto | null, connLine: string): string {
  const mode = project?.workMode === "research" ? "科研" : project?.workMode === "coding" ? "编程" : project?.workMode === "office" ? "工作" : "未登记";
  const agent = project?.defaultAgent ? (AGENTS.find((a) => a.id === project.defaultAgent)?.label ?? project.defaultAgent) : "没设";
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    `当前时间（本机）：${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
    `项目：${project?.name ?? projectPath}（${mode}项目）`,
    `项目默认 Agent：${agent}`,
    `项目助手这次用的连接：${connLine}`,
  ].join("\n");
}

/** 项目地图（要做事时带）：上次问以来新出现或改过的标「新」；读不到就不带 */
async function gatherMap(projectPath: string, lastAt: string | undefined): Promise<string | null> {
  const map = await safe(invoke<{ entries: MapEntry[]; truncated: boolean } | null>("project_file_map", { projectRoot: projectPath }), null);
  if (!map) return null;
  const since = lastAt ? Date.parse(lastAt) : NaN;
  return renderProjectMap(map.entries, { truncated: map.truncated, sinceMs: Number.isFinite(since) ? since : null });
}

/** 一句说明只取第一句、截短：能力清单要的是「什么时候用」，不是整段 */
function firstSentence(text: string, cap = 90): string {
  const t = text.replace(/\s+/g, " ").trim();
  const cut = t.search(/[。.!！?？]/);
  const one = cut > 0 ? t.slice(0, cut + 1) : t;
  return one.length > cap ? `${one.slice(0, cap)}…` : one;
}

/** 干活的连接能做到哪一步（二期）：项目默认连接的能力表、模型看不看得了图、出图模型配没配 */
async function workerCapabilities(project: ProjectDto | null): Promise<string[]> {
  const profile = projectDefaultProfile(project);
  if (!profile) return workerCapabilityLines({ worker: null, headlessWrite: null, vision: null, imageGen: { model: null, helperReady: false }, tier: null });
  const model = resolveTaskModel({
    models: profile.models,
    profileId: profile.id,
    defaultProfileId: project?.defaultProfiles?.[profile.agent],
    defaultModel: project?.defaultModels?.[profile.agent],
  });
  const imageModel = useAppStore.getState().settings?.imageGenModel?.trim() || null;
  const [caps, vision, imageStatus] = await Promise.all([
    safe(invoke<AgentCapabilitiesDto[]>("agent_capabilities"), []),
    model
      ? safe(invoke<ModelCapabilityDto[]>("model_capabilities", { models: [model], gatewayId: profile.gatewayId ?? null }), []).then((rows) => rows[0]?.vision ?? null)
      : Promise.resolve(null),
    imageModel ? safe(invoke<{ helperReady: boolean }>("image_gen_status"), { helperReady: false }) : Promise.resolve({ helperReady: false }),
  ]);
  const cap = caps.find((c) => c.agent === profile.agent) ?? null;
  return workerCapabilityLines({
    worker: { agent: AGENTS.find((a) => a.id === profile.agent)?.label ?? profile.agent, profile: profile.name, model },
    headlessWrite: cap?.headlessWrite ?? null,
    vision,
    imageGen: { model: imageModel, helperReady: imageStatus.helperReady },
    tier: cap ? { level: cap.supportTier, note: cap.tierNote } : null,
  });
}

/** 能力清单：内置任务、我的任务、已装技能的名字和一句话（一期）；干活的连接能做到哪一步、定时与事件（二期） */
export async function gatherCatalog(project: ProjectDto | null): Promise<string> {
  const [skills, packs, worker] = await Promise.all([
    safe(invoke<SkillDto[]>("list_skills"), []),
    safe(invoke<TaskPackDto[]>("list_task_packs"), []),
    workerCapabilities(project).catch(() => [] as string[]),
  ]);
  const lines = ["任务（写在「按任务」里）：", ...builtinTaskCatalogLines()];
  for (const p of packs) lines.push(`- 我的任务「${p.name}」：${firstSentence(p.description || p.steps.map((s) => s.name).join("、"))}`);
  if (skills.length) {
    lines.push("", "已装技能（写在「用到的技能」里）：");
    for (const sk of skills) lines.push(`- ${sk.name}：${firstSentence(sk.description)}`);
  }
  // 整套流程只供指路：写整篇综述 / 论文这种多步活时告诉用户可以套哪套，由他在项目页自己选（2026-11-08）
  lines.push("", "整套流程模板（写整篇综述、论文、学位论文、投稿返修这类多步活才用；你不套、不写进单子，告诉用户在项目页自己选）：");
  for (const t of PIPELINE_TEMPLATES) lines.push(`- 「${t.name}」：${firstSentence(t.description)}`);
  if (worker.length) lines.push("", ...worker);
  lines.push("", ...TRIGGER_CATALOG_LINES);
  return lines.join("\n");
}

/** 这一问怎么问：分到哪一类、要不要只读查看项目文件（面板据此写等待文案） */
export function planAsk(
  question: string,
  hasFocus: boolean,
  project: ProjectDto | null,
  /** 「换个查法」：人点了按哪一类重问 */
  forced?: AssistantIntent,
  /** 之前的问答：上一轮问了用户一个问题 / 起草了单子时，这一轮接着按「要做事」走 */
  history?: readonly (AssistantHistoryTurn & { dispatched?: unknown })[],
): { intent: AssistantIntent; inspect: boolean } {
  const last = history?.[history.length - 1];
  const intent = forced ?? classifyQuestion(question, hasFocus, last ? previousTurnHint(last.answer, !!last.dispatched) : undefined);
  const agent = assistantConnection(project).agentId;
  // 走「AI 功能」连接时不知道是哪家：先试，后端说不支持再退回只看记录
  const inspect = wantsInspect(question, intent, hasFocus) && (agent === null || INSPECT_AGENTS.includes(agent));
  return { intent, inspect };
}

const INSPECT_UNSUPPORTED = "INSPECT_UNSUPPORTED";

/** 问「这一轮怎么样 / 有没有问题 / 帮我看看」时看哪一步：问题里点名的，没点名就是评审页正开着的那一步。
 *  找到且开过工的，带上这一步的核验项（含 Mesa 核对）做成这次的重点，只读打开它的主要产物；找不到返回 null，照原来的问法走 */
async function reviewAskFocus(projectPath: string, question: string): Promise<AssistantFocus | null> {
  const [read, workspaces] = await Promise.all([
    safe(invoke<ProjectConfigReadDto | null>("read_project_config", { path: projectPath }), null),
    safe(invoke<WorkspaceDto[]>("list_workspaces"), []),
  ]);
  const steps = read?.config.steps ?? [];
  if (!steps.length) return null;
  const open = reviewingStep();
  const viewing = open && samePath(open.projectRoot, projectPath, IS_WINDOWS) ? open : null;
  const n = mentionedStep(question, steps.map((s) => ({ name: s.name, kind: stepKind(s, undefined) }))) ?? viewing?.n ?? null;
  const step = n ? steps[n - 1] : undefined;
  if (!n || !step) return null;
  const ws = workspaces.find((w) => w.name === step.workspaceName && w.status !== "archived" && samePath(w.repoPath, projectPath, IS_WINDOWS));
  if (!ws) return null;
  const checks = await stepChecks(step, ws.worktreePath, projectPath);
  return reviewRoundFocus(n, step.name, { worktree: ws.worktreePath, artifacts: step.expectedArtifacts }, checks);
}

/** 评审页开着时，「用户此刻在看哪」补一句正在评审哪一步（评审覆盖层挂在对话页上，页面名只写得出「对话页」） */
function withReviewing(where: string | undefined, projectPath: string): string | undefined {
  const open = reviewingStep();
  if (!open || !samePath(open.projectRoot, projectPath, IS_WINDOWS)) return where;
  return `${where ? `${where} · ` : ""}正在评审第 ${open.n} 步「${open.name}」`;
}

/** 问一次：先分流（classifyQuestion），按类取材料 → 拼提示词 → 后端脱敏后无头调用、落记录。
 *  问出错类问题且连接支持时，在项目根只读跑一次，让它自己打开文件核对；不支持就只看记录。
 *  项目默认那家不支持无头调用时退回「AI 功能」的连接 */
export async function askProjectAssistant(input: {
  projectPath: string;
  project: ProjectDto | null;
  question: string;
  history: readonly AssistantHistoryTurn[];
  focus: AssistantFocus | null;
  intent?: AssistantIntent;
  inspect?: boolean;
  /** 附的截图（Mesa 粘贴目录里的绝对路径，2026-11-05）：后端带图一律走只读查看，只有 Claude Code / Codex 能看 */
  images?: readonly string[];
  /** 用户此刻在看哪（assistant-dock.ts assistantWhere） */
  where?: string;
  /** 边生成边推来的更新：到此为止的回答（整段）/ 正在做的一步 */
  onStream?: (update: { text?: string; step?: string }) => void;
}): Promise<AssistantTurn> {
  // 问一轮怎么样：没带重点进来时，按点名的步骤或评审页开着的那一步补上重点（带核验项、只读打开产物）
  const focus = input.focus ?? (isReviewAsk(input.question) ? await reviewAskFocus(input.projectPath, input.question).catch(() => null) : null);
  const where = withReviewing(input.where, input.projectPath);
  const planned = planAsk(input.question, !!focus, input.project, undefined, input.history);
  const intent = input.intent ?? planned.intent;
  const inspect = input.inspect ?? planned.inspect;
  const conn = assistantConnection(input.project);
  const needSnapshot = intent === "project" || intent === "mixed" || intent === "request";
  const needGuide = intent === "howto" || intent === "mixed";
  const request = intent === "request";
  const [snapshot, guide, worktrees, map, catalog] = await Promise.all([
    needSnapshot ? cachedSnapshot(input.projectPath, focus) : Promise.resolve(null),
    needGuide
      ? safe(invoke<{ heading: string; text: string }[]>("assistant_guide_search", { question: input.question, limit: intent === "mixed" ? GUIDE_LIMIT.mixed : GUIDE_LIMIT.howto }), [])
      : Promise.resolve([] as { heading: string; text: string }[]),
    inspect
      ? safe(invoke<WorkspaceDto[]>("list_workspaces"), []).then((list) =>
          list
            .filter((w) => w.status !== "archived" && samePath(w.repoPath, input.projectPath, IS_WINDOWS))
            .map((w) => w.worktreePath),
        )
      : Promise.resolve([] as string[]),
    request ? gatherMap(input.projectPath, input.history[input.history.length - 1]?.at) : Promise.resolve(null),
    request ? gatherCatalog(input.project) : Promise.resolve(null),
  ]);
  const promptFor = (withInspect: boolean) =>
    buildAssistantPrompt({
      intent,
      snapshot,
      guide,
      inspect: withInspect ? inspectRules(input.projectPath, worktrees, request ? "intake" : "debug") : null,
      context: intent === "howto" || intent === "general" || intent === "chat" ? projectContext(input.projectPath, input.project, conn.line) : null,
      history: input.history,
      question: input.question,
      where: where || null,
      map,
      catalog,
    });
  const guideHeads = guide.map((g) => g.heading);
  const streamId = crypto.randomUUID();
  const ask = async (profileId: string | null, model: string | null, connection: string, withInspect: boolean) => {
    // 先挂上监听再发：后端一开跑就推（只有 Claude Code / Codex 推得出来，别家整段一次给）
    const unlisten = input.onStream
      ? await listen<{ text?: string; step?: string }>(`assistant-stream-${streamId}`, (event) => input.onStream?.(event.payload))
      : null;
    try {
      return await invoke<AssistantTurn>("project_assistant_ask", {
        projectRoot: input.projectPath,
        profileId,
        model,
        connection,
        // 翻出了更早的相关问答时依据里写一句，人知道它不只看了最近几轮
        basis: (() => {
          const base = basisText(intent, guideHeads, withInspect);
          const older = intent === "chat" || intent === "general" ? [] : recallOlderTurns(input.history, historyKeep(intent), input.question);
          return older.length ? `${base}${base ? " · " : ""}翻出 ${older.length} 轮更早的相关问答` : base;
        })(),
        question: input.question,
        prompt: promptFor(withInspect),
        inspect: withInspect,
        extraDirs: withInspect ? worktrees : null,
        effort: intentEffort(intent),
        streamId,
        images: input.images?.length ? input.images : null,
      });
    } finally {
      unlisten?.();
    }
  };
  const askWithFallback = async (profileId: string | null, model: string | null, connection: string) => {
    try {
      return await ask(profileId, model, connection, inspect);
    } catch (reason) {
      // 这家还不能只读查看项目文件：退回只看记录
      if (inspect && String(reason).includes(INSPECT_UNSUPPORTED)) return ask(profileId, model, connection, false);
      throw reason;
    }
  };
  try {
    return await askWithFallback(conn.profileId, conn.model, conn.line);
  } catch (reason) {
    if (!conn.profileId || conn.bound || !String(reason).includes("不支持无头调用")) throw reason;
    return askWithFallback(null, null, "设置里「AI 功能」的连接");
  }
}
