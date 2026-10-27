/**
 * 工作台项目卡（2026-10-27 设计稿 docs/design-workbench-mockup.html 第二批）：每个项目一张卡，卡头是项目现在怎么样，
 * 任务行是里面每件事到哪了，点任务行在右侧开任务面板。纯逻辑，只读已有数据（项目 / 工作区 / 流程步骤 / 编程概览 /
 * 目标 / 定时任务 / 运行标签），不新增后端；供 node --test 直接测。
 *
 * 任务行四类 + 对话：科研有流程的列步骤，没流程的科研与工作项目列目标，编程列分支，三类都列定时任务；
 * 落在项目里、哪个任务都对不上的活标签单列成「对话」。同一件事只出现一次：在拍板队列里的行只标「待拍板」，按钮在队列里。
 */
import { pathWithin, samePath } from "./path-utils.ts";
import { goalBucket, GOAL_BUCKET_LABEL } from "./project-tasks.ts";
import { CODING_KIND_LABEL, deriveCodingKind, type CodingKind } from "./work-mode.ts";
import { nextRunLabel } from "./schedule-tasks.ts";

export type CardWorkMode = "research" | "coding" | "office";
export type CardTaskKind = "step" | "goal" | "branch" | "schedule" | "chat";
/** 行首点：live 在跑、wait 等你、fail 出错、done 做完、idle 其余 */
export type CardTone = "live" | "wait" | "fail" | "done" | "idle";

export interface CardLiveRun {
  tabId: string;
  runId?: string;
  agentId: string;
  attention: "confirm" | "working" | "done" | null;
  running: boolean;
}

export interface CardTask {
  /** 稳定身份：step:<工作区名> / goal:<taskId> / branch:<路径> / schedule:<id> / chat:<tabId> */
  id: string;
  kind: CardTaskKind;
  /** 行首小字：步骤 2 / 目标 / 分支 / 定时 / 对话 */
  kindLabel: string;
  name: string;
  state: string;
  tone: CardTone;
  live: CardLiveRun | null;
  /** 这件事在拍板队列里（行上只标「待拍板」） */
  queued: boolean;
  /** 详情面板与跳转用的原始身份 */
  ref:
    | { kind: "step"; stepIndex: number; workspaceName: string; worktreePath: string | null; workspaceId: string | null }
    | { kind: "goal"; taskId: string; status: string }
    | { kind: "branch"; path: string; branch: string; codingKind: CodingKind }
    | { kind: "schedule"; scheduleId: string }
    | { kind: "chat"; tabId: string };
}

export interface CardVital {
  label: string;
  value: string;
}

export interface ProjectCard {
  path: string;
  name: string;
  registered: boolean;
  workMode: CardWorkMode | null;
  vitals: CardVital[];
  /** 科研流程进度条：每步 done / cur / todo；没有流程为 null */
  track: { name: string; state: "done" | "cur" | "todo" }[] | null;
  tasks: CardTask[];
  /** 有 Agent 开着 */
  live: boolean;
}

export interface CardProjectInput {
  path: string;
  name: string;
  registered: boolean;
  workMode: CardWorkMode | null;
}

export interface CardWorkspaceInput {
  id: string;
  repoPath: string;
  name: string;
  worktreePath: string;
  status: string;
  mergedAt: string | null;
}

export interface CardStepInput {
  name: string;
  workspaceName: string;
  seedComplete?: boolean;
}

export interface CardCodingInput {
  baseBranch: string;
  worktrees: readonly {
    path: string;
    branch: string;
    isPrimary: boolean;
    isBase: boolean;
    dirty: boolean;
    ahead: number;
    behind: number;
  }[];
}

export interface CardGoalInput {
  id: string;
  projectRoot: string | null;
  name: string;
  status: string;
  archivedAt: string | null;
}

export interface CardScheduleInput {
  id: string;
  name: string;
  projectRoot: string;
  enabled: boolean;
  runningRunId?: string | null;
  pausedReason?: string | null;
  nextRunAt?: string | null;
  /** 新的在前；跳过的不算「上次」 */
  history: readonly { status: string; summary?: string }[];
}

export interface CardRunInput {
  tabId: string;
  runId?: string;
  taskId?: string;
  agentId: string;
  cwd: string;
  title: string;
  running: boolean;
  attention: "confirm" | "working" | "done" | null;
}

const TONE_ORDER: Record<CardTone, number> = { wait: 0, live: 1, fail: 2, idle: 3, done: 4 };

function liveOf(run: CardRunInput): CardLiveRun {
  return { tabId: run.tabId, runId: run.runId, agentId: run.agentId, attention: run.attention, running: run.running };
}

/** 有 Agent 开着的行：等你确认 > 在干活 > 开着闲着 */
function liveTone(live: CardLiveRun): CardTone {
  return live.attention === "confirm" ? "wait" : "live";
}

function liveState(live: CardLiveRun, fallback: string): string {
  if (live.attention === "confirm") return "等你确认";
  if (live.attention === "working") return "正在干活";
  return live.running ? "开着，等你下一句" : fallback;
}

/** 一个项目的卡。runs 只传「活」的标签（isWorkbenchActiveRun），queueKeys 是拍板队列当前的行键 */
export function buildProjectCard(input: {
  project: CardProjectInput;
  workspaces: readonly CardWorkspaceInput[];
  steps: readonly CardStepInput[] | null;
  pipelineOptOut: boolean;
  coding: CardCodingInput | null;
  goals: readonly CardGoalInput[];
  schedules: readonly CardScheduleInput[];
  runs: readonly CardRunInput[];
  queueKeys: ReadonlySet<string>;
  now?: Date;
  isWindows?: boolean;
}): ProjectCard {
  const win = input.isWindows ?? false;
  const { project } = input;
  const used = new Set<string>();
  const inQueue = (...keys: (string | undefined | null)[]) => keys.some((k) => !!k && input.queueKeys.has(k));
  const confirmKey = (run: CardRunInput | undefined) => (run ? `confirm:${run.runId ?? run.tabId}` : null);
  const runIn = (root: string) => input.runs.find((r) => !used.has(r.tabId) && pathWithin(r.cwd, root, win));
  const take = (run: CardRunInput | undefined) => {
    if (run) used.add(run.tabId);
    return run;
  };

  const mineWs = input.workspaces.filter(
    (w) => w.status !== "archived" && samePath(w.repoPath, project.path, win),
  );
  const mineGoals = input.goals.filter(
    (g) => !g.archivedAt && g.projectRoot && samePath(g.projectRoot, project.path, win),
  );
  const tasks: CardTask[] = [];
  const vitals: CardVital[] = [];
  let track: ProjectCard["track"] = null;
  // 与项目页同口径（goalCaptureTargets / ProjectGroup liteResearch）：科研只有「不用流程且没有步骤」才按目标列
  const liteResearch = project.workMode === "research" && input.pipelineOptOut && (input.steps?.length ?? 0) === 0;
  const usePipeline = project.workMode === "research" && !liteResearch && (input.steps?.length ?? 0) > 0;

  if (usePipeline) {
    const steps = input.steps!;
    let current = -1;
    const states = steps.map((step, i) => {
      const ws = mineWs.find((w) => w.name === step.workspaceName);
      const done = Boolean(step.seedComplete || (ws && ws.status === "active" && ws.mergedAt));
      if (!done && current < 0) current = i;
      return { step, ws, done };
    });
    track = states.map((s, i) => ({ name: s.step.name, state: s.done ? "done" : i === current ? "cur" : "todo" }));
    vitals.push({
      label: "进行到",
      value: current < 0 ? `${steps.length} 步都已完成` : `第 ${current + 1} / ${steps.length} 步`,
    });
    states.forEach((s, i) => {
      // 列出：当前这一步、开了工作副本还没保存进项目的步；做完的和没轮到的只在进度条上
      if (s.done || (i !== current && !s.ws)) return;
      const run = s.ws ? take(runIn(s.ws.worktreePath)) : undefined;
      const live = run ? liveOf(run) : null;
      const queued = inQueue(confirmKey(run), s.ws && `conflict:${s.ws.id}`, s.ws && `ready:${s.ws.id}`, s.ws && `artifacts:${s.ws.id}`);
      tasks.push({
        id: `step:${s.step.workspaceName}`,
        kind: "step",
        kindLabel: `步骤 ${i + 1}`,
        name: s.step.name,
        state: live ? liveState(live, "进行中") : s.ws ? (s.ws.status === "creating" ? "正在准备工作副本" : "进行中，还没保存进项目") : "还没开始",
        tone: live ? liveTone(live) : queued ? "wait" : "idle",
        live,
        queued,
        ref: { kind: "step", stepIndex: i, workspaceName: s.step.workspaceName, worktreePath: s.ws?.worktreePath ?? null, workspaceId: s.ws?.id ?? null },
      });
    });
  }

  if (project.workMode === "office" || liteResearch) {
    const counts = { running: 0, review: 0, open: 0, stuck: 0, done: 0 };
    for (const goal of mineGoals) {
      const bucket = goalBucket(goal.status);
      counts[bucket]++;
      if (bucket === "done") continue;
      const run = take(
        input.runs.find((r) => !used.has(r.tabId) && r.taskId === goal.id),
      );
      const live = run ? liveOf(run) : null;
      const queued = inQueue(`review:${goal.id}`, confirmKey(run));
      tasks.push({
        id: `goal:${goal.id}`,
        kind: "goal",
        kindLabel: "目标",
        name: goal.name,
        state: live ? liveState(live, GOAL_BUCKET_LABEL[bucket]) : bucket === "open" ? "记下了，还没开工" : GOAL_BUCKET_LABEL[bucket],
        tone: live ? liveTone(live) : bucket === "review" ? "wait" : bucket === "stuck" ? "fail" : "idle",
        live,
        queued,
        ref: { kind: "goal", taskId: goal.id, status: goal.status },
      });
    }
    vitals.push({ label: "进行中", value: String(counts.running) });
    vitals.push({ label: "待验收", value: String(counts.review) });
    if (counts.open) vitals.push({ label: "记下未开工", value: String(counts.open) });
  }

  if (project.workMode === "coding" && input.coding) {
    const lanes = input.coding.worktrees.filter((w) => !(w.isBase && w.isPrimary));
    const kinds: Partial<Record<CodingKind, number>> = {};
    for (const w of lanes) {
      const kind = deriveCodingKind({ ...w, hasWorktree: true });
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      const run = take(runIn(w.path));
      const live = run ? liveOf(run) : null;
      const queued = inQueue(confirmKey(run));
      tasks.push({
        id: `branch:${w.path}`,
        kind: "branch",
        kindLabel: "分支",
        name: w.branch || "工作树",
        state: live ? liveState(live, CODING_KIND_LABEL[kind]) : CODING_KIND_LABEL[kind],
        tone: live ? liveTone(live) : kind === "sync" || kind === "ready" ? "wait" : "idle",
        live,
        queued,
        ref: { kind: "branch", path: w.path, branch: w.branch, codingKind: kind },
      });
    }
    vitals.push({ label: "基准", value: input.coding.baseBranch || "main" });
    vitals.push({ label: "分支", value: `${lanes.length} 条` });
    if (kinds.ready) vitals.push({ label: "等待合并", value: String(kinds.ready) });
    if (kinds.sync) vitals.push({ label: "需同步", value: String(kinds.sync) });
  }

  // 项目里其余开着的 Agent：哪个任务都对不上的单列成「对话」
  for (const run of input.runs) {
    if (used.has(run.tabId) || !pathWithin(run.cwd, project.path, win)) continue;
    used.add(run.tabId);
    const live = liveOf(run);
    tasks.push({
      id: `chat:${run.tabId}`,
      kind: "chat",
      kindLabel: "对话",
      name: run.title.trim() || "对话",
      state: liveState(live, "开着"),
      tone: liveTone(live),
      live,
      queued: inQueue(confirmKey(run)),
      ref: { kind: "chat", tabId: run.tabId },
    });
  }

  const mineSchedules = input.schedules.filter((s) => samePath(s.projectRoot, project.path, win));
  for (const s of mineSchedules) {
    if (!s.enabled && !s.pausedReason) continue;
    const running = Boolean(s.runningRunId);
    const lastRun = s.history.find((r) => r.status !== "skipped") ?? null;
    const last = lastRun?.status ?? null;
    const failed = last === "error" || last === "timeout";
    // 失败写第一行原因（同原工作台「定时任务」摘要口径）
    const reason = last === "error" ? (lastRun?.summary ?? "").split("\n").find((l) => l.trim())?.trim().slice(0, 30) : null;
    const queued = inQueue(`sched:paused:${s.id}`) || [...input.queueKeys].some((k) => k.startsWith(`sched:review:${s.id}:`));
    tasks.push({
      id: `schedule:${s.id}`,
      kind: "schedule",
      kindLabel: "定时",
      name: s.name,
      state: running
        ? "正在跑"
        : s.pausedReason
          ? "已自动暂停"
          : failed
            ? last === "timeout"
              ? "上次超时"
              : `上次失败：${reason || "没有错误信息"}`
            : (nextRunLabel(s, input.now) ?? "仅手动"),
      tone: running ? "live" : s.pausedReason || failed ? "fail" : "idle",
      live: null,
      queued,
      ref: { kind: "schedule", scheduleId: s.id },
    });
  }
  if (mineSchedules.length && project.workMode !== "coding") {
    vitals.push({ label: "定时任务", value: `${mineSchedules.filter((s) => s.enabled).length} 个` });
  }

  // 流程步骤保持流程顺序排在前面；其余按 等你 > 在跑 > 出错 > 其余 排
  const stepRows = tasks.filter((t) => t.kind === "step");
  const others = tasks
    .filter((t) => t.kind !== "step")
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
    .map(({ t }) => t);
  return {
    path: project.path,
    name: project.name,
    registered: project.registered,
    workMode: project.workMode,
    vitals,
    track,
    tasks: [...stepRows, ...others],
    live: input.runs.some((r) => pathWithin(r.cwd, project.path, win)) ||
      tasks.some((t) => t.live !== null),
  };
}

function rank(task: CardTask): number {
  return TONE_ORDER[task.queued ? "wait" : task.tone];
}

/** 卡上默认列几行，其余折成「还有 N 项」 */
export const CARD_VISIBLE_TASKS = 5;

/** 「有活的」之外按类型筛：全部 / 科研 / 编程 / 工作 */
export type CardFilter = "active" | "all" | CardWorkMode;

export function filterCards(
  cards: readonly ProjectCard[],
  activePaths: readonly string[],
  filter: CardFilter,
  isWindows = false,
): ProjectCard[] {
  const isActive = (c: ProjectCard) => activePaths.some((p) => samePath(p, c.path, isWindows));
  if (filter === "active") {
    // 有活的按「正在进行」原来的顺序排（确认 > 正在跑 > 其余）
    return activePaths
      .map((p) => cards.find((c) => samePath(c.path, p, isWindows)))
      .filter((c): c is ProjectCard => !!c);
  }
  const pool = filter === "all" ? [...cards] : cards.filter((c) => c.workMode === filter);
  return pool.sort((a, b) => Number(isActive(b)) - Number(isActive(a)));
}
