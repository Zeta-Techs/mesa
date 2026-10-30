/**
 * 工作台项目分组（2026-10-27 设计稿 docs/design-workbench-mockup.html 第二批；同日由卡片改为分组列表）：每个项目一组，项目头是项目现在怎么样，
 * 任务行是里面每件事到哪了，点任务行在右侧开任务面板。纯逻辑，只读已有数据（项目 / 工作区 / 流程步骤 / 编程概览 /
 * 目标 / 定时任务 / 运行标签），不新增后端；供 node --test 直接测。
 *
 * 任务行四类 + 对话：科研有流程的列步骤，没流程的科研与工作项目列目标，编程列分支，三类都列定时任务；
 * 落在项目里、哪个任务都对不上的活标签单列成「对话」。同一件事只出现一次：在拍板队列里的行只标「待拍板」，按钮在队列里。
 */
import { pathWithin, samePath } from "./path-utils.ts";
import { goalBucket, GOAL_BUCKET_LABEL } from "./project-tasks.ts";
import { CODING_KIND_LABEL, deriveCodingKind, type CodingKind } from "./work-mode.ts";
import { frequencyLabel, nextRunLabel, parseLocalSlot } from "./schedule-tasks.ts";
import { describeActivity, thinkingHeadline } from "./chat-status.ts";

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
  /** 手上正在做（开着工作副本的步骤、改了没提交的分支、进行中的目标、开着的对话、正在跑的定时）；
   *  只落后 / 领先基准、记下没开工的不算——它们是事实，不是「有活」（2026-10-27 用户截图：三个旧编程项目全被算成有活的） */
  inProgress: boolean;
  /** 流程里当前这一步（行首点用强调色） */
  current?: boolean;
  /** 最后一次动它（没在跑的行，时长那一列写它）：步骤 / 分支看工作副本里的对话与最近提交，目标看更新时间，定时看上次跑 */
  touchedAt: string | null;
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
    lastCommitAt?: string | null;
  }[];
}

export interface CardGoalInput {
  id: string;
  projectRoot: string | null;
  name: string;
  status: string;
  archivedAt: string | null;
  updatedAt?: string | null;
}

export interface CardScheduleInput {
  id: string;
  name: string;
  projectRoot: string;
  enabled: boolean;
  frequency: string;
  weekday: number | null;
  hour: number;
  minute: number;
  intervalHours?: number | null;
  runningRunId?: string | null;
  pausedReason?: string | null;
  nextRunAt?: string | null;
  /** 新的在前；跳过的不算「上次」 */
  history: readonly { at?: string; status: string; summary?: string; startedAt?: string | null; newEntries?: number | null }[];
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

/** 两个 ISO 时刻取晚的；都没有为 null */
function latest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
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
  runs: readonly CardRunInput[];
  queueKeys: ReadonlySet<string>;
  /** 某个目录里最后一次对话活动（页面按会话现算）；不传就只用提交 / 更新时间 */
  touchedAt?: (root: string) => string | null;
  now?: Date;
  isWindows?: boolean;
}): ProjectCard {
  const win = input.isWindows ?? false;
  const { project } = input;
  const used = new Set<string>();
  const inQueue = (...keys: (string | undefined | null)[]) => keys.some((k) => !!k && input.queueKeys.has(k));
  const confirmKey = (run: CardRunInput | undefined) => (run ? `confirm:${run.runId ?? run.tabId}` : null);
  const runIn = (root: string) => input.runs.find((r) => !used.has(r.tabId) && pathWithin(r.cwd, root, win));
  const touched = (root: string | null) => (root && input.touchedAt ? input.touchedAt(root) : null);
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
        // 当前这一步写「工作副本开着」；排在它后面、提前开了工作副本的写「提前开了，还没保存」（2026-10-27 用户截图：三行同一句读不出区别）
        state: live
          ? liveState(live, "进行中")
          : !s.ws
            ? "还没开始"
            : s.ws.status === "creating"
              ? "正在准备工作副本"
              : i === current
                ? "工作副本开着，还没保存进项目"
                : "提前开了，还没保存",
        tone: live ? liveTone(live) : queued ? "wait" : "idle",
        live,
        queued,
        inProgress: Boolean(live || s.ws),
        current: i === current,
        touchedAt: touched(s.ws?.worktreePath ?? null),
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
        state: live
          ? liveState(live, GOAL_BUCKET_LABEL[bucket])
          : bucket === "open"
            ? "记下了，还没开工"
            : bucket === "stuck"
              ? goal.status === "failed"
                ? "上次失败，需要处理"
                : "上次停了，需要处理"
              : GOAL_BUCKET_LABEL[bucket],
        // 中途停下只是没跑完、等人接着做，同待验收给琥珀；红只给真失败（2026-10-30 用户截图：停了也一片红）
        tone: live
          ? liveTone(live)
          : bucket === "review" || (bucket === "stuck" && goal.status !== "failed")
            ? "wait"
            : bucket === "stuck"
              ? "fail"
              : "idle",
        live,
        queued,
        inProgress: Boolean(live || bucket === "running"),
        touchedAt: goal.updatedAt ?? null,
        ref: { kind: "goal", taskId: goal.id, status: goal.status },
      });
    }
    // 零不写（2026-10-27 用户截图：「进行中 0 · 待验收 0」是噪音）
    if (counts.running) vitals.push({ label: "进行中", value: String(counts.running) });
    if (counts.review) vitals.push({ label: "待验收", value: String(counts.review) });
    if (counts.open) vitals.push({ label: "记下未开工", value: String(counts.open) });
  }

  if (project.workMode === "coding" && input.coding) {
    const lanes = input.coding.worktrees.filter((w) => !(w.isBase && w.isPrimary));
    const kinds: Partial<Record<CodingKind, number>> = {};
    const base = input.coding.baseBranch || "基准";
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
        state: live
          ? liveState(live, CODING_KIND_LABEL[kind])
          : kind === "sync"
            ? `落后 ${base}，需同步`
            : kind === "ready"
              ? `比 ${base} 多出提交，等待合并`
              : CODING_KIND_LABEL[kind],
        // 落后 / 领先基准是事实不是待办：不上黄点（黄点留给真在等你的）
        tone: live ? liveTone(live) : "idle",
        live,
        queued,
        inProgress: Boolean(live || kind === "dev"),
        touchedAt: latest(w.lastCommitAt ?? null, touched(w.path)),
        ref: { kind: "branch", path: w.path, branch: w.branch, codingKind: kind },
      });
    }
    vitals.push({ label: "基准", value: input.coding.baseBranch || "main" });
    if (lanes.length) vitals.push({ label: "分支", value: `${lanes.length} 条` });
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
      inProgress: true,
      touchedAt: null,
      ref: { kind: "chat", tabId: run.tabId },
    });
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

/** 手上在做、但此刻没人在跑的项目，多久没动就不再算「有活的」 */
export const ACTIVE_IDLE_MS = 7 * 24 * 3600_000;

/**
 * 「有活的」：此刻有事（在跑 / 等你 / 出错 / 在拍板队列里），或手上在做且 7 天内动过。
 * 只是分支落后基准、目标记下没开工的不算（2026-10-27）
 */
export function cardIsActive(card: ProjectCard, lastActiveMs: number | null, nowMs: number): boolean {
  if (card.tasks.some((t) => t.queued || t.tone === "live" || t.tone === "wait" || t.tone === "fail")) return true;
  if (!card.tasks.some((t) => t.inProgress)) return false;
  return lastActiveMs !== null && nowMs - lastActiveMs <= ACTIVE_IDLE_MS;
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

// ===== 第三批（2026-10-27）：任务行实时状态与花费、离开期间摘要 =====

/** 旁路快照里够得上「此刻在做什么」的部分（chat-channel.ts ChatChannelSnapshot 的子集） */
export interface LiveSnapInput {
  activity: { name: string; input: string } | null;
  thinking: string | null;
  statusLine?: string | null;
  turn: { status: string; startedAt: number } | null;
}

/** 此刻在做什么：正在跑的工具 > 思考小标题 > CLI 自己报的一句；只认旁路，读不到就 null（行上照写「正在干活」） */
export function liveActivityLine(
  snap: LiveSnapInput | null | undefined,
  cwd: string | null,
  isWindows: boolean,
): string | null {
  if (!snap?.turn || (snap.turn.status !== "running" && snap.turn.status !== "awaiting_approval")) return null;
  if (snap.activity) {
    const text = describeActivity(snap.activity, cwd, isWindows);
    if (text) return text;
  }
  const head = thinkingHeadline(snap.thinking);
  if (head) return `在想：${head}`;
  return snap.statusLine?.trim() || null;
}

/** 这一轮跑了多久（毫秒）；没在跑的不算 */
export function turnElapsedMs(snap: LiveSnapInput | null | undefined, nowMs: number): number | null {
  const t = snap?.turn;
  if (!t || (t.status !== "running" && t.status !== "awaiting_approval") || !t.startedAt) return null;
  return Math.max(0, nowMs - t.startedAt);
}

/** 时长白话：不到 1 分钟 / 12 分钟 / 1 小时 5 分 / 2 天 */
export function durationLabel(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "不到 1 分钟";
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} 小时 ${min % 60} 分` : `${h} 小时`;
  return `${Math.floor(h / 24)} 天`;
}

/** 离开不到这么久不算「离开」，不出摘要 */
export const AWAY_MIN_MS = 30 * 60_000;

/**
 * 离开期间一行摘要：只数确有记录的——结束的交互运行（内部的不算）、定时任务跑过的次数（跳过的不算）；
 * 什么都没发生、或离开不到半小时返回 null。花费不在这里估：用量按天入库，凑不出「离开这几小时」的准数
 */
export function awaySummary(input: {
  sinceMs: number | null;
  nowMs: number;
  runs: readonly { internal: boolean; status: string; closedAt: string | null }[];
  schedules: readonly { history: readonly { at: string; status: string }[] }[];
  waiting: number;
}): { lead: string; parts: string[] } | null {
  const since = input.sinceMs;
  if (!since || input.nowMs - since < AWAY_MIN_MS) return null;
  const after = (iso: string | null) => {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) && t > since && t <= input.nowMs;
  };
  const closed = input.runs.filter((r) => !r.internal && after(r.closedAt));
  const failedRuns = closed.filter((r) => r.status === "failed").length;
  const schedRuns = input.schedules.flatMap((s) => s.history).filter((r) => r.status !== "skipped" && after(r.at));
  const failedSched = schedRuns.filter((r) => r.status === "error" || r.status === "timeout").length;
  const parts: string[] = [];
  if (closed.length) parts.push(`结束了 ${closed.length} 次运行${failedRuns ? `（${failedRuns} 次出错退出）` : ""}`);
  if (schedRuns.length) parts.push(`定时任务跑了 ${schedRuns.length} 次${failedSched ? `（${failedSched} 次失败）` : ""}`);
  if (!parts.length) return null;
  if (input.waiting) parts.push(`${input.waiting} 件等你拍板`);
  return { lead: `你离开的 ${durationLabel(input.nowMs - since)}里`, parts };
}

// ===== 定时任务总览（2026-10-27 用户「除了用量都做」）=====
// 项目分组里不再列定时任务：同一件事只说一次，跨项目的定时任务统一在这一块看、在这一块点。

/** 行内动作：停止在跑的 / 重跑上次失败的 / 重新打开被暂停的 / 现在跑一次；在拍板队列里的不给（按钮在队列里） */
export type ScheduleAction = "cancel" | "rerun" | "reopen" | "run";

export interface ScheduleOverviewRow {
  task: CardTask;
  projectRoot: string;
  projectName: string;
  frequency: string;
  action: ScheduleAction | null;
  /** 下一次应跑时刻（毫秒）；停用 / 仅手动 / 没算出来为 null */
  nextAt: number | null;
}

/** 一个定时任务折成任务行（总览行与任务面板共用） */
export function scheduleCardTask(
  s: CardScheduleInput,
  queueKeys: ReadonlySet<string>,
  now?: Date,
): CardTask {
  const running = Boolean(s.runningRunId);
  const lastRun = s.history.find((r) => r.status !== "skipped") ?? null;
  const last = lastRun?.status ?? null;
  const failed = last === "error" || last === "timeout";
  // 失败写第一行原因（同原工作台「定时任务」摘要口径）
  const reason = last === "error" ? (lastRun?.summary ?? "").split("\n").find((l) => l.trim())?.trim().slice(0, 30) : null;
  const queued = queueKeys.has(`sched:paused:${s.id}`) || [...queueKeys].some((k) => k.startsWith(`sched:review:${s.id}:`));
  const next = nextRunLabel(s, now);
  const hits = last === "ok" && typeof lastRun?.newEntries === "number" ? `上次新命中 ${lastRun.newEntries}` : null;
  return {
    id: `schedule:${s.id}`,
    kind: "schedule",
    kindLabel: "定时",
    name: s.name,
    state: running
      ? "正在跑"
      : s.pausedReason
        ? `已自动暂停：${s.pausedReason}`
        : failed
          ? last === "timeout"
            ? "上次超时"
            : `上次失败：${reason || "没有错误信息"}`
          : [next ?? (s.enabled ? "仅手动" : "已停用"), hits].filter(Boolean).join(" · "),
    tone: running ? "live" : s.pausedReason || failed ? "fail" : "idle",
    live: null,
    queued,
    inProgress: running,
    touchedAt: lastRun?.at ?? null,
    ref: { kind: "schedule", scheduleId: s.id },
  };
}

/**
 * 跨项目定时任务总览：在跑 > 出错 / 暂停 > 按下次时间；停用且没有暂停原因的不列（那是人主动关的），已删项目的不列。
 */
export function scheduleOverview(
  schedules: readonly CardScheduleInput[],
  projects: readonly { path: string; name: string }[],
  queueKeys: ReadonlySet<string>,
  now: Date = new Date(),
  isWindows = false,
): ScheduleOverviewRow[] {
  const rows: (ScheduleOverviewRow & { rank: number })[] = [];
  for (const s of schedules) {
    const project = projects.find((p) => samePath(p.path, s.projectRoot, isWindows));
    if (!project) continue;
    if (!s.enabled && !s.pausedReason && !s.runningRunId) continue;
    const task = scheduleCardTask(s, queueKeys, now);
    const next = s.enabled ? (parseLocalSlot(s.nextRunAt)?.getTime() ?? null) : null;
    const failed = task.tone === "fail" && !s.pausedReason;
    const action: ScheduleAction | null = task.queued
      ? null
      : s.runningRunId
        ? "cancel"
        : s.pausedReason
          ? "reopen"
          : failed
            ? "rerun"
            : "run";
    rows.push({
      task,
      projectRoot: s.projectRoot,
      projectName: project.name,
      frequency: frequencyLabel(s.frequency, s.weekday, s.hour, s.minute, s.intervalHours),
      action,
      nextAt: next,
      rank: s.runningRunId ? 0 : task.tone === "fail" ? 1 : 2,
    });
  }
  return rows
    .sort((a, b) => a.rank - b.rank || cmpNext(a.nextAt, b.nextAt))
    .map(({ rank: _rank, ...row }) => row);
}

/** 下次时刻升序，没有的排后（两个都没有算相等，免得 Infinity - Infinity 得 NaN） */
function cmpNext(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/** 时间轴上的点：现在起 windowMs 内要跑的 + 正在跑的（at = 0 表示此刻）；pos 是 0–1 的横向位置 */
export function scheduleTimeline(
  rows: readonly ScheduleOverviewRow[],
  nowMs: number,
  windowMs = 24 * 3600_000,
): { id: string; name: string; pos: number; running: boolean; at: number }[] {
  const out: { id: string; name: string; pos: number; running: boolean; at: number }[] = [];
  for (const row of rows) {
    if (row.task.tone === "live") {
      out.push({ id: row.task.id, name: row.task.name, pos: 0, running: true, at: nowMs });
      continue;
    }
    if (row.nextAt === null) continue;
    const d = row.nextAt - nowMs;
    if (d < 0 || d > windowMs) continue;
    out.push({ id: row.task.id, name: row.task.name, pos: d / windowMs, running: false, at: row.nextAt });
  }
  return out;
}

/** 同一可见分钟合成一组；「正在跑」独立成现在，避免同刻任务互相遮住。 */
export function scheduleTimelineGroups(rows: readonly ScheduleOverviewRow[], nowMs: number) {
  type Point = ReturnType<typeof scheduleTimeline>[number];
  const groups = new Map<string, { key: string; at: number; running: boolean; items: Point[] }>();
  for (const point of scheduleTimeline(rows, nowMs)) {
    const key = point.running ? "now" : String(Math.floor(point.at / 60_000));
    const group = groups.get(key) ?? { key, at: point.at, running: point.running, items: [] };
    group.items.push(point);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => Number(b.running) - Number(a.running) || a.at - b.at);
}

/** 项目顺序跟侧栏：置顶段（按置顶先后）在前，其余按侧栏拖动排的顺序，没排过的按传入顺序（2026-10-27） */
export function orderLikeSidebar<T extends { path: string }>(
  items: readonly T[],
  pins: readonly string[],
  order: readonly string[],
  isWindows = false,
): T[] {
  const rank = (list: readonly string[], path: string) => {
    const i = list.findIndex((p) => samePath(p, path, isWindows));
    return i < 0 ? Number.POSITIVE_INFINITY : i;
  };
  return items
    .map((item, i) => ({ item, i, pin: rank(pins, item.path), ord: rank(order, item.path) }))
    .sort((a, b) => (a.pin === b.pin ? (a.ord === b.ord ? a.i - b.i : a.ord - b.ord) : a.pin - b.pin))
    .map((x) => x.item);
}
