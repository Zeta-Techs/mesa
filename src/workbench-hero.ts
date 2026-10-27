/**
 * 工作台「继续当前工作」主卡纯逻辑：选哪条当前工作、状态怎么说、继续跳哪。
 * 与 DOM/Tauri 解耦，供 node --test 直接测。
 */
import { pathKey, pathWithin, samePath } from "./path-utils.ts";
import { cwdBasename, buildRunOverview, type RunOverviewInput } from "./run-overview.ts";
import {
  canonicalizeReuseKey,
  isRunProcessLive,
  isWorkbenchActiveRun,
  isWorkbenchSurfaceRun,
  pickRecoverableRun,
} from "./run-model.ts";
import { goalBucket } from "./project-tasks.ts";
import { splitLaunchPrompt } from "./project-context.ts";
import { projectNowLine } from "./project-status.ts";
import { sessionExcludedFromProjectList } from "./session-filter.ts";
import {
  replaceAbsFsPaths,
  stripTitleMarkdown,
  tidySessionTitle,
  unwrapPromptTags,
} from "./session-title.ts";

export type WorkbenchHeroSource =
  | "running"
  | "context"
  | "recent-registered"
  | "recent";

export interface WorkbenchProject {
  path: string;
  name: string;
  workMode?: "research" | "coding" | "office" | null;
  lastOpenedAt?: string | null;
  createdAt?: string | null;
}

export interface WorkbenchRepo {
  path: string;
  name: string;
  lastActive?: string | null;
}

export interface WorkbenchRecentRow {
  path: string;
  name: string;
  lastActive: string | null;
  registered: boolean;
}

export interface WorkbenchWorkspaceRef {
  repoPath: string;
  worktreePath: string;
  name: string;
  status: string;
  mergedAt: string | null;
}

/** 一张工作台卡上的一次活着的干活（终端标签视图）。 */
export interface WorkbenchRunChip {
  /** 跨页面稳定身份；tabId 仅用于聚焦当前终端视图。 */
  runId?: string;
  tabId: string;
  agentId: string;
  attention: "confirm" | "working" | "done" | null;
  /** 工作区名 / 分支 / 文档名，不是 CLI 名 */
  taskLabel: string;
  /** 进程是否还活着；已退出/未启动的保留标签为 false（可继续但不算运行中） */
  live?: boolean;
}

export interface WorkbenchHero {
  name: string;
  path: string;
  registered: boolean;
  /** 属于这张卡的运行标签（有则「继续工作」聚焦它）= runs 里优先级最高的一条 */
  tabId: string | null;
  agentId: string | null;
  model: string | null;
  attention: "confirm" | "working" | "done" | null;
  /** 这张卡所属项目/目录上的存活工作数（不是全应用） */
  runningCount: number;
  /** 同一项目上的多次 Run（待确认在前）；单次时状态行已够，UI 可不重复列 */
  runs: WorkbenchRunChip[];
  source: WorkbenchHeroSource;
  workMode?: "research" | "coding" | "office" | null;
  subtitle?: string | null;
}

export type WorkbenchContinue =
  | { kind: "terminal"; tabId: string; runId?: string }
  | { kind: "project"; path: string }
  | { kind: "enter-cwd"; path: string };

export type WorkbenchDestination =
  | { kind: "conversation"; label: "回到对话"; runId?: string; tabId?: string }
  | { kind: "project"; label: "打开项目"; path: string }
  | { kind: "directory"; label: "打开目录"; path: string };

/** 文案与执行共用同一个落点；关掉标签仍先按 Run 找回，未添加目录不冒充项目。 */
export function resolveWorkbenchDestination(
  target: WorkbenchContinue,
  runs: Parameters<typeof pickRecoverableRun>[0],
  isWindows: boolean,
): WorkbenchDestination {
  if (target.kind === "terminal") {
    return { kind: "conversation", label: "回到对话", runId: target.runId, tabId: target.tabId };
  }
  const recovered = pickRecoverableRun(runs, target.path, isWindows);
  if (recovered) return { kind: "conversation", label: "回到对话", runId: recovered.id };
  return target.kind === "project"
    ? { kind: "project", label: "打开项目", path: target.path }
    : { kind: "directory", label: "打开目录", path: target.path };
}

export interface WorkbenchNowSeed {
  path: string;
  name: string;
  registered: boolean;
  workMode: "research" | "coding" | "office" | null;
  subtitle: string | null;
  needsYou: boolean;
  extraRoots?: string[];
}

export interface WorkbenchNowItem extends WorkbenchHero {
  workMode: "research" | "coding" | "office" | null;
  subtitle: string | null;
  rank: number;
}

interface PathGroup {
  key: string;
  roots: string[];
  registered: boolean;
}

function isLiveWork(run: RunOverviewInput): boolean {
  return isWorkbenchSurfaceRun(run);
}

/** 「正在进行」列表专用：比主卡更严，空闲挂着的任务/工作区标签不算活。 */
function isActiveWork(run: RunOverviewInput): boolean {
  return isWorkbenchActiveRun(run);
}

/** 标签标题优先；占位「终端」回落到目录尾段。 */
export function taskLabelForRun(run: {
  title: string;
  cwd: string;
}): string {
  const title = run.title.trim();
  if (title && title !== "终端") return title;
  return cwdBasename(run.cwd) || "这项工作";
}

function toRunChip(run: RunOverviewInput): WorkbenchRunChip {
  return {
    runId: run.runId,
    tabId: run.tabId,
    agentId: run.agentId,
    attention: run.attention,
    taskLabel: taskLabelForRun(run),
    live: isRunProcessLive(run),
  };
}

function runChipRank(chip: WorkbenchRunChip): number {
  if (chip.attention === "confirm") return 0;
  if (chip.attention === "working") return 1;
  return 2;
}

function sortRunChips(runs: WorkbenchRunChip[]): WorkbenchRunChip[] {
  return [...runs].sort((a, b) => runChipRank(a) - runChipRank(b));
}

function pointerFromRuns(runs: readonly WorkbenchRunChip[]): {
  tabId: string | null;
  agentId: string | null;
  attention: "confirm" | "working" | "done" | null;
} {
  const top = runs[0];
  if (!top) return { tabId: null, agentId: null, attention: null };
  return {
    tabId: top.tabId,
    agentId: top.agentId || null,
    attention: top.attention,
  };
}

function attributePath(
  cwd: string,
  groups: readonly PathGroup[],
  isWindows: boolean,
): string | null {
  let best: { key: string; len: number } | null = null;
  for (const g of groups) {
    for (const root of g.roots) {
      if (!pathWithin(cwd, root, isWindows)) continue;
      const len = pathKey(root, isWindows).length;
      if (!best || len > best.len) best = { key: g.key, len };
    }
  }
  return best?.key ?? null;
}

/** runId → 项目根、taskId → 项目根的稳定身份归属表（由 Run 记录与 Task 列表现算）。 */
export interface WorkbenchRunAttribution {
  runProjects?: Readonly<Record<string, string>>;
  taskProjects?: Readonly<Record<string, string>>;
}

/**
 * 归属一条运行到项目组：先按 runId / taskId 稳定身份（人声明目标的隔离副本 cwd 在
 * task-runs/<taskId>/<staging> 下，按 cwd 永远落不到项目，会被拆成单独的 UUID 卡），
 * 都没有再按 cwd 最长前缀。命中归属表但组里没有该项目时返回项目根本身。
 */
function attributeRun(
  run: RunOverviewInput,
  groups: readonly PathGroup[],
  isWindows: boolean,
  attribution?: WorkbenchRunAttribution,
): string | null {
  const keyOfRoot = (root: string | undefined): string | null => {
    if (!root?.trim()) return null;
    const hit = groups.find((g) => samePath(g.key, root, isWindows));
    return hit?.key ?? root;
  };
  const byRun = keyOfRoot(
    run.runId ? attribution?.runProjects?.[run.runId] : undefined,
  );
  if (byRun) return byRun;
  const key = canonicalizeReuseKey(run.reuseKey);
  const taskId =
    run.taskId ?? (key.startsWith("task:") ? key.slice(5) : undefined);
  const byTask = keyOfRoot(
    taskId ? attribution?.taskProjects?.[taskId] : undefined,
  );
  if (byTask) return byTask;
  return attributePath(run.cwd, groups, isWindows);
}

/** 工作台「最近项目 / 最近对话」最多条数。 */
export const WORKBENCH_RECENT_LIMIT = 6;

function laterIso(a?: string | null, b?: string | null): string | null {
  const left = a?.trim() || "";
  const right = b?.trim() || "";
  if (!left) return right || null;
  if (!right) return left;
  const lt = Date.parse(left);
  const rt = Date.parse(right);
  if (!Number.isNaN(lt) && !Number.isNaN(rt)) return lt >= rt ? left : right;
  return left >= right ? left : right;
}

function compareRecent(a: string | null, b: string | null): number {
  const left = a ?? "";
  const right = b ?? "";
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const lt = Date.parse(left);
  const rt = Date.parse(right);
  if (!Number.isNaN(lt) && !Number.isNaN(rt) && lt !== rt) return rt - lt;
  return right < left ? -1 : right > left ? 1 : 0;
}

/**
 * 工作台「最近项目」行：已添加项目 ∪ 会话扫出的仓库。
 * 传入 interactiveLast（项目路径→最近一次交互会话时间）时，只列有交互历史的项目、
 * 按交互时间排序——定时雷达只产生自动活动不产生会话，纯雷达项目不进「最近」
 * （2026-10-13 拍板；项目页「查看全部」仍可达）。radar 之外按最近活动降序，默认最多 10 条。
 * 正在进行的主卡项目仍列入：刚添加的办公项目否则会从「最近」里消失。
 */
export function workbenchRecentRows(input: {
  recentRepos: readonly WorkbenchRepo[];
  projects: readonly WorkbenchProject[];
  excludePaths?: readonly string[];
  isWindows?: boolean;
  limit?: number;
  /** 项目路径 → 最近一次交互会话时间；提供即启用「只列交互项目」口径 */
  interactiveLast?: ReadonlyMap<string, string>;
}): WorkbenchRecentRow[] {
  const isWindows = input.isWindows ?? false;
  const limit = input.limit ?? WORKBENCH_RECENT_LIMIT;
  const exclude = input.excludePaths ?? [];
  const interactive = input.interactiveLast;
  const interactiveAt = (path: string): string | null => {
    if (!interactive) return null;
    for (const [k, v] of interactive) {
      if (samePath(k, path, isWindows)) return v;
    }
    return null;
  };
  const skipped = (path: string) =>
    exclude.some((p) => samePath(p, path, isWindows));
  const rows: WorkbenchRecentRow[] = [];

  for (const project of input.projects) {
    if (skipped(project.path)) continue;
    const last = interactiveAt(project.path);
    if (interactive && !last) continue;
    const repo = input.recentRepos.find((r) =>
      samePath(r.path, project.path, isWindows),
    );
    const name =
      project.name.trim() ||
      repo?.name.trim() ||
      cwdBasename(project.path) ||
      project.path;
    rows.push({
      path: project.path,
      name,
      lastActive: laterIso(
        laterIso(last, laterIso(project.lastOpenedAt, project.createdAt)),
        repo?.lastActive,
      ),
      registered: true,
    });
  }

  for (const repo of input.recentRepos) {
    if (skipped(repo.path)) continue;
    if (rows.some((row) => samePath(row.path, repo.path, isWindows))) continue;
    const last = interactiveAt(repo.path);
    if (interactive && !last) continue;
    rows.push({
      path: repo.path,
      name: repo.name.trim() || cwdBasename(repo.path) || repo.path,
      lastActive: laterIso(last, repo.lastActive ?? null),
      registered: false,
    });
  }

  rows.sort((a, b) => {
    const byTime = compareRecent(a.lastActive, b.lastActive);
    if (byTime !== 0) return byTime;
    return a.name.localeCompare(b.name, "zh");
  });
  return rows.slice(0, Math.max(0, limit));
}

function nameForPath(
  path: string,
  projects: readonly WorkbenchProject[],
  recentRepos: readonly WorkbenchRepo[],
  isWindows: boolean,
): string {
  const project = projects.find((p) => samePath(p.path, path, isWindows));
  const projectName = project?.name.trim();
  if (projectName) return projectName;
  const repo = recentRepos.find((r) => samePath(r.path, path, isWindows));
  const repoName = repo?.name.trim();
  if (repoName) return repoName;
  return cwdBasename(path) || path;
}

function buildGroups(
  projects: readonly WorkbenchProject[],
  recentRepos: readonly WorkbenchRepo[],
  workspaces: readonly WorkbenchWorkspaceRef[],
  isWindows: boolean,
): PathGroup[] {
  const groups: PathGroup[] = [];
  for (const project of projects) {
    const trees = workspaces
      .filter(
        (w) =>
          w.status !== "archived" &&
          samePath(w.repoPath, project.path, isWindows),
      )
      .map((w) => w.worktreePath);
    groups.push({
      key: project.path,
      roots: [project.path, ...trees],
      registered: true,
    });
  }
  for (const repo of recentRepos) {
    if (groups.some((g) => samePath(g.key, repo.path, isWindows))) continue;
    groups.push({ key: repo.path, roots: [repo.path], registered: false });
  }
  return groups;
}

function heroAt(
  path: string,
  source: WorkbenchHeroSource,
  projects: readonly WorkbenchProject[],
  recentRepos: readonly WorkbenchRepo[],
  isWindows: boolean,
  live?: {
    tabId: string;
    agentId: string;
    model: string;
    attention: "confirm" | "working" | "done" | null;
    runningCount: number;
    runs: WorkbenchRunChip[];
  },
): WorkbenchHero {
  const registered = projects.some((p) => samePath(p.path, path, isWindows));
  const workMode =
    projects.find((p) => samePath(p.path, path, isWindows))?.workMode ?? null;
  const runs = live?.runs ?? [];
  return {
    name: nameForPath(path, projects, recentRepos, isWindows),
    path,
    registered,
    tabId: live?.tabId ?? null,
    agentId: live?.agentId || null,
    model: live?.model || null,
    attention: live?.attention ?? null,
    runningCount: live?.runningCount ?? 0,
    runs,
    source,
    workMode,
  };
}

export function pickWorkbenchHero(input: {
  projects: readonly WorkbenchProject[];
  recentRepos: readonly WorkbenchRepo[];
  workspaces: readonly WorkbenchWorkspaceRef[];
  runs: readonly RunOverviewInput[];
  /** 上次选中项目的显示名（contextLabel.project）；同名项目有歧义，仅作无路径时的唯一匹配回落 */
  contextName: string | null;
  /** 上次选中项目的路径（稳定身份）；有它就不按名字猜 */
  contextPath?: string | null;
  attribution?: WorkbenchRunAttribution;
  isWindows?: boolean;
}): WorkbenchHero | null {
  const isWindows = input.isWindows ?? false;
  const groups = buildGroups(
    input.projects,
    input.recentRepos,
    input.workspaces,
    isWindows,
  );
  const live = buildRunOverview([...input.runs]).items.filter(isLiveWork);

  if (live.length > 0) {
    const top = live[0]!;
    const key = attributeRun(top, groups, isWindows, input.attribution);
    const path = key ?? top.cwd;
    const mine = live.filter((run) => {
      const attributed = attributeRun(run, groups, isWindows, input.attribution);
      if (key) {
        if (attributed !== null) return samePath(attributed, key, isWindows);
        // 归属表外的运行退回 cwd 包含判断（如主卡落在已从注册表移除的项目根上）
        return (
          pathWithin(run.cwd, path, isWindows) ||
          pathWithin(path, run.cwd, isWindows)
        );
      }
      return (
        pathWithin(run.cwd, path, isWindows) ||
        pathWithin(path, run.cwd, isWindows)
      );
    });
    const runs = sortRunChips(mine.map(toRunChip));
    const pointer = pointerFromRuns(runs);
    const pointed = mine.find((run) => run.tabId === pointer.tabId) ?? top;
    return heroAt(
      path,
      "running",
      input.projects,
      input.recentRepos,
      isWindows,
      {
        tabId: pointer.tabId ?? pointed.tabId,
        agentId: pointer.agentId ?? pointed.agentId,
        model: pointed.model,
        attention: pointer.attention ?? pointed.attention,
        runningCount: runs.filter((chip) => chip.live).length,
        runs,
      },
    );
  }

  const contextPath = input.contextPath?.trim() ?? "";
  if (contextPath) {
    const byPath = input.projects.find((p) =>
      samePath(p.path, contextPath, isWindows),
    );
    if (byPath) {
      return heroAt(
        byPath.path,
        "context",
        input.projects,
        input.recentRepos,
        isWindows,
      );
    }
    const repoByPath = input.recentRepos.find((r) =>
      samePath(r.path, contextPath, isWindows),
    );
    if (repoByPath) {
      return heroAt(
        repoByPath.path,
        "context",
        input.projects,
        input.recentRepos,
        isWindows,
      );
    }
  }

  // 名字只是显示标签：同名项目存在时不猜首项，只有唯一命中才用
  const contextName = input.contextName?.trim() ?? "";
  if (contextName) {
    const nameHits = input.projects.filter((p) => p.name === contextName);
    if (nameHits.length === 1) {
      return heroAt(
        nameHits[0]!.path,
        "context",
        input.projects,
        input.recentRepos,
        isWindows,
      );
    }
    const repoHits = input.recentRepos.filter((r) => r.name === contextName);
    if (nameHits.length === 0 && repoHits.length === 1) {
      const registered = input.projects.find((p) =>
        samePath(p.path, repoHits[0]!.path, isWindows),
      );
      return heroAt(
        registered?.path ?? repoHits[0]!.path,
        "context",
        input.projects,
        input.recentRepos,
        isWindows,
      );
    }
  }

  for (const repo of input.recentRepos) {
    const project = input.projects.find((p) =>
      samePath(p.path, repo.path, isWindows),
    );
    if (project) {
      return heroAt(
        project.path,
        "recent-registered",
        input.projects,
        input.recentRepos,
        isWindows,
      );
    }
  }
  if (input.recentRepos[0]) {
    return heroAt(
      input.recentRepos[0].path,
      "recent",
      input.projects,
      input.recentRepos,
      isWindows,
    );
  }
  return null;
}

function nowRank(opts: {
  attention: "confirm" | "working" | "done" | null;
  runningCount: number;
  needsYou: boolean;
}): number {
  if (opts.attention === "confirm") return 0;
  if (opts.attention === "working" || opts.runningCount > 0) return 1;
  if (opts.needsYou) return 2;
  return 3;
}

/** 正在进行的项目：有存活 Agent 或该方式下「要你管」。最多 5 条，第一条最大。 */
export function pickWorkbenchNow(input: {
  seeds: readonly WorkbenchNowSeed[];
  runs: readonly RunOverviewInput[];
  attribution?: WorkbenchRunAttribution;
  isWindows?: boolean;
}): WorkbenchNowItem[] {
  const isWindows = input.isWindows ?? false;
  const groups: PathGroup[] = input.seeds.map((s) => ({
    key: s.path,
    roots: [s.path, ...(s.extraRoots ?? [])],
    registered: s.registered,
  }));
  // 「正在进行」用严口径：空闲老标签不顶卡（主卡/找回区仍用宽口径保留死标签）
  const live = buildRunOverview([...input.runs]).items.filter(isActiveWork);
  const byPath = new Map<string, WorkbenchNowItem>();

  function ensure(path: string, source: WorkbenchHeroSource): WorkbenchNowItem {
    const seed = input.seeds.find((s) => samePath(s.path, path, isWindows));
    const key = seed?.path ?? path;
    const existing = byPath.get(key);
    if (existing) return existing;
    const item: WorkbenchNowItem = {
      name: seed?.name ?? cwdBasename(path) ?? path,
      path: key,
      registered: seed?.registered ?? false,
      tabId: null,
      agentId: null,
      model: null,
      attention: null,
      runningCount: 0,
      runs: [],
      source,
      workMode: seed?.workMode ?? null,
      subtitle: seed?.subtitle ?? null,
      rank: 3,
    };
    byPath.set(key, item);
    return item;
  }

  for (const run of live) {
    const key =
      attributeRun(run, groups, isWindows, input.attribution) ?? run.cwd;
    const item = ensure(key, "running");
    item.runs.push(toRunChip(run));
  }

  for (const seed of input.seeds) {
    if (!seed.needsYou && !byPath.has(seed.path)) continue;
    const item = ensure(seed.path, byPath.has(seed.path) ? "running" : "recent-registered");
    if (!item.subtitle) item.subtitle = seed.subtitle;
    if (!item.workMode) item.workMode = seed.workMode;
  }

  const items = [...byPath.values()].map((item) => {
    const seed = input.seeds.find((s) => samePath(s.path, item.path, isWindows));
    const runs = sortRunChips(item.runs);
    const pointer = pointerFromRuns(runs);
    // 运行数只算活进程；已退出/未启动的保留标签留在 runs 里供继续，但不冒充「正在工作」
    const liveCount = runs.filter((chip) => chip.live).length;
    return {
      ...item,
      runs,
      runningCount: liveCount,
      tabId: pointer.tabId,
      agentId: pointer.agentId,
      attention: pointer.attention,
      rank: nowRank({
        attention: pointer.attention,
        runningCount: liveCount,
        needsYou: seed?.needsYou ?? false,
      }),
    };
  });
  items.sort((a, b) => a.rank - b.rank);
  return items.slice(0, 5);
}

export function continueWorkbenchTarget(hero: WorkbenchHero): WorkbenchContinue {
  const top = hero.runs[0];
  if (top?.runId) {
    return {
      kind: "terminal",
      tabId: top.tabId,
      runId: top.runId,
    };
  }
  if (hero.tabId) {
    return { kind: "terminal", tabId: hero.tabId };
  }
  if (hero.registered) return { kind: "project", path: hero.path };
  return { kind: "enter-cwd", path: hero.path };
}

/** 流程进度：第一个还没合并的步骤是第几步；全做完 done=true、指末步；没有步骤返回 null */
export function openStepProgress(
  steps: readonly {
    name: string;
    workspaceName: string;
    seedComplete?: boolean;
  }[],
  workspaces: readonly Pick<
    WorkbenchWorkspaceRef,
    "name" | "status" | "mergedAt"
  >[],
): { name: string; index: number; total: number; done: boolean } | null {
  const name = firstOpenStepName(steps, workspaces);
  if (name === null) return null;
  const total = steps.length;
  const open = steps.findIndex((step) => {
    if (step.seedComplete) return false;
    const ws = workspaces.find((w) => w.name === step.workspaceName && w.status !== "archived");
    return !(ws && ws.status === "active" && ws.mergedAt);
  });
  if (open < 0) return { name, index: total, total, done: true };
  return { name, index: open + 1, total, done: false };
}

/**
 * 工作台副行的步骤：写明是「进行到哪一步」。只写步骤名时，和下面「上次停在」那句
 * （常是在商量后面某一步的任务书）挨着读像矛盾（2026-10-26 用户截图）。
 */
export function stepProgressLabel(
  progress: { name: string; index: number; total: number; done: boolean } | null,
): string | null {
  if (!progress) return null;
  if (progress.done) return `${progress.total} 步都已完成`;
  if (progress.total <= 1) return `进行到：${progress.name}`;
  return `进行到：${progress.name}（第 ${progress.index} / ${progress.total} 步）`;
}

/** 流水线里第一个尚未合并的步骤名；全做完回末步；没有步骤返回 null */
export function firstOpenStepName(
  steps: readonly {
    name: string;
    workspaceName: string;
    seedComplete?: boolean;
  }[],
  workspaces: readonly Pick<
    WorkbenchWorkspaceRef,
    "name" | "status" | "mergedAt"
  >[],
): string | null {
  if (steps.length === 0) return null;
  for (const step of steps) {
    if (step.seedComplete) continue;
    const ws = workspaces.find(
      (w) => w.name === step.workspaceName && w.status !== "archived",
    );
    const done = Boolean(ws && ws.status === "active" && ws.mergedAt);
    if (!done) return step.name;
  }
  return steps[steps.length - 1]!.name;
}

/** 区块标题：有活进程才叫「正在进行」，可恢复但不在跑叫「最近在做」。 */
export function workbenchNowSectionTitle(runningCount: number): "正在进行" | "最近在做" {
  // 没在跑时不叫「继续工作」：主卡按钮就是「继续工作」，标题再说一遍是同一事实说两次（2026-10-17）
  return runningCount > 0 ? "正在进行" : "最近在做";
}

/** 有实质标题才返回；未命名 / 空标题不列。与项目侧栏同一套清洗。 */
export function namedSessionTitle(session: {
  customTitle?: string | null;
  title?: string | null;
  summary?: string | null;
}): string | null {
  const shown = tidySessionTitle(session);
  if (shown.unnamed) return null;
  return shown.title;
}

/** 正在进行副行：与任务页同一句「项目现在」。没有待验收/进行中/没做完才回落步骤名。 */
export function workbenchNowSubtitle(input: {
  tasks: readonly {
    name: string;
    status: string;
    description?: string | null;
  }[];
  fallback: string | null;
}): { subtitle: string | null; needsYou: boolean } {
  const urgent = input.tasks.filter((task) => {
    const bucket = goalBucket(task.status);
    return bucket === "review" || bucket === "running" || bucket === "stuck";
  });
  // 工作台每行前面已经是项目名，「项目现在：」标签去掉，句子本身与任务页一致
  const line = projectNowLine(urgent)?.replace(/^项目现在：/, "");
  if (line) return { subtitle: line, needsYou: true };
  return { subtitle: input.fallback, needsYou: false };
}

// ---- 工作台第二批（2026-10-17）：上次停在 / 待处理归属 / 记下目标 / 加载失败汇总 ----

/** 「上次停在」取哪条会话：该项目最近一次人参与的对话。归档、内部无头 / 问 AI / 阅读注入
 *  （与项目侧栏同一套 sessionExcludedFromProjectList）、源文件没了又没快照的都跳过。 */
export function latestProjectSession<T extends {
  projectPath: string;
  updatedAt: string | null;
  title: string | null;
  customTitle: string | null;
  archived?: boolean;
  internal?: boolean;
  source?: string;
  alive?: boolean;
  pinned?: boolean;
}>(sessions: readonly T[], projectPath: string, isWindows = false): T | null {
  let best: T | null = null;
  for (const session of sessions) {
    if (session.archived || !session.updatedAt) continue;
    if (session.alive === false && !session.pinned) continue;
    if (!samePath(session.projectPath, projectPath, isWindows)) continue;
    if (
      sessionExcludedFromProjectList({
        internal: session.internal,
        source: session.source,
        projectPath: session.projectPath,
        title: session.title,
        customTitle: session.customTitle,
      })
    )
      continue;
    if (!best || compareRecent(session.updatedAt, best.updatedAt) < 0) best = session;
  }
  return best;
}

const LAST_SAID_INJECTED_RE = /^(?:<[a-z][\w-]*[\s>]|caveat:)/i;
const LAST_SAID_INTERRUPT_RE =
  /\[?\s*request interrupted by user[^\]]*\]?|请求(?:已)?中断|被用户中断/gi;

/** Mesa 开对话时把项目上下文包塞在第一句话前面（composeLaunchPrompt）：包不是人话，只留你说的（splitLaunchPrompt） */
function stripProjectPack(text: string): string {
  return splitLaunchPrompt(text).said;
}

function clampLastSaid(text: string): string {
  const chars = [...text];
  const cjk = chars.filter((c) => (c.codePointAt(0) ?? 0) > 0xff).length;
  const max = cjk >= chars.length / 2 ? 60 : 100;
  if (chars.length <= max) return text;
  return `${chars.slice(0, max).join("").trimEnd()}…`;
}

/**
 * 「上次停在」：会话里最后一条人说的话（只看 text 块；工具结果、系统注入的
 * `<system-reminder>` / `<command-…>` / Caveat、单独的「中断」提示都跳过）。
 * 不按首句切——要的是「当时让它干什么」，切成首词就没信息了。消息已在 Rust 层脱敏。
 */
export function lastUserInstruction(
  messages: readonly {
    role: string;
    blocks: readonly { kind: string; text: string }[];
    timestamp?: string | null;
  }[],
): { text: string; full: string; timestamp: string | null } | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role !== "user") continue;
    const raw = message.blocks
      .filter((block) => block.kind === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (!raw) continue;
    // 先拆项目说明再展开标签：展开会把换行压成空格，认不出单独一行的分隔
    const unwrapped = unwrapPromptTags(stripProjectPack(raw));
    if (!unwrapped || LAST_SAID_INJECTED_RE.test(unwrapped)) continue;
    let full = replaceAbsFsPaths(unwrapped.replace(LAST_SAID_INTERRUPT_RE, " "));
    full = stripTitleMarkdown(full.replace(/\s+/g, " ").trim());
    if (!full) continue;
    return { text: clampLastSaid(full), full, timestamp: message.timestamp ?? null };
  }
  return null;
}

/** 收件箱条目归到哪个已添加项目（工作台「待你处理」行尾标项目名用）。归不到返回 null。 */
export function inboxItemProjectRoot(
  action:
    | { type: string; [key: string]: unknown }
    | null
    | undefined,
  ctx: {
    projectPaths: readonly string[];
    workspaces: readonly { id: string; repoPath: string; worktreePath: string }[];
    runProjects?: Readonly<Record<string, string>>;
    tabCwds?: Readonly<Record<string, string>>;
    sessions?: readonly { agent: string; sessionId: string; projectPath: string }[];
    isWindows?: boolean;
  },
): string | null {
  if (!action) return null;
  const isWindows = ctx.isWindows ?? false;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  const toProject = (path: string | null): string | null => {
    if (!path) return null;
    let best: { path: string; len: number } | null = null;
    for (const root of ctx.projectPaths) {
      if (!pathWithin(path, root, isWindows)) continue;
      const len = pathKey(root, isWindows).length;
      if (!best || len > best.len) best = { path: root, len };
    }
    return best?.path ?? null;
  };
  const byRun = (runId: string | null) =>
    runId ? toProject(ctx.runProjects?.[runId] ?? null) : null;
  switch (action.type) {
    case "project":
    case "litWatch":
    case "schedules":
    case "help":
      return toProject(str(action.projectRoot));
    case "artifacts": {
      const ws = ctx.workspaces.find((w) => w.id === str(action.workspaceId));
      return toProject(ws?.repoPath ?? null);
    }
    case "review": {
      const tree = str(action.worktreePath);
      const ws = tree
        ? ctx.workspaces.find((w) => samePath(w.worktreePath, tree, isWindows))
        : undefined;
      return toProject(ws?.repoPath ?? null) ?? byRun(str(action.runId)) ?? toProject(tree);
    }
    case "run": {
      const tabId = str(action.tabId);
      return byRun(str(action.runId)) ?? toProject(tabId ? ctx.tabCwds?.[tabId] ?? null : null);
    }
    case "session": {
      const hit = ctx.sessions?.find(
        (s) => s.agent === action.agent && s.sessionId === action.sessionId,
      );
      return toProject(hit?.projectPath ?? null);
    }
    default:
      return null;
  }
}

/** 工作台「记下目标」能落到哪些项目：与项目页目标视图同一口径——办公项目，或科研里
 *  显式选了「不使用研究流程」且没有步骤的（ProjectGroup liteResearch）。编程项目走车道，不进。 */
export function goalCaptureTargets<P extends {
  path: string;
  name: string;
  workMode?: string | null;
}>(
  projects: readonly P[],
  researchCfg: Readonly<Record<string, { stepCount: number; pipelineOptOut: boolean }>>,
): (P & { goalKind: "office_doc" | "free_research" })[] {
  const out: (P & { goalKind: "office_doc" | "free_research" })[] = [];
  for (const project of projects) {
    if (project.workMode === "office") {
      out.push({ ...project, goalKind: "office_doc" });
      continue;
    }
    if (project.workMode === "coding") continue;
    const cfg = researchCfg[project.path];
    if (cfg?.pipelineOptOut && cfg.stepCount === 0) {
      out.push({ ...project, goalKind: "free_research" });
    }
  }
  return out;
}
