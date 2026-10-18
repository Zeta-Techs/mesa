import { normSep, stripVerbatim } from "./path-utils.ts";

export type TaskPermission = "discuss" | "write_tree";

/** 人声明的资料范围：空副本 / 勾选路径 / 整个项目。禁止静默默认成整个项目。 */
export type TaskMaterialScope = "none" | "selected" | "whole";

export function pruneNestedPaths(paths: readonly string[]): string[] {
  const unique: string[] = [];
  for (const raw of paths) {
    const path = normSep(raw).replace(/^\/+|\/+$/g, "");
    if (!path || unique.includes(path)) continue;
    unique.push(path);
  }
  unique.sort((a, b) => a.length - b.length || a.localeCompare(b));
  const kept: string[] = [];
  for (const path of unique) {
    if (path === ".") return ["."];
    const covered = kept.some(
      (parent) => parent === "." || path === parent || path.startsWith(`${parent}/`),
    );
    if (!covered) kept.push(path);
  }
  return kept;
}

export function pathCoveredBySelection(
  relative: string,
  selected: readonly string[],
): boolean {
  const path = normSep(relative).replace(/\/+$/, "");
  if (!path) return selected.includes(".");
  return selected.some((item) => {
    const parent = normSep(item).replace(/\/+$/, "");
    return parent === "." || path === parent || path.startsWith(`${parent}/`);
  });
}

export function toggleTaskMaterialPath(
  selected: readonly string[],
  relative: string,
  checked: boolean,
): string[] {
  const path = normSep(relative).replace(/^\/+|\/+$/g, "");
  if (!path || path === ".") return [...selected];
  if (checked) {
    const withoutDescendants = selected.filter(
      (item) => item !== path && !normSep(item).startsWith(`${path}/`),
    );
    if (pathCoveredBySelection(path, withoutDescendants)) return withoutDescendants;
    return pruneNestedPaths([...withoutDescendants, path]);
  }
  return selected.filter((item) => item !== path);
}

export function taskPathsForScope(
  scope: TaskMaterialScope,
  selectedPaths: readonly string[],
  permission: TaskPermission,
): { inputPaths: string[]; outputPaths: string[]; error: string | null } {
  const outputPaths = permission === "write_tree" ? ["."] : [];
  if (scope === "none") {
    return { inputPaths: [], outputPaths, error: null };
  }
  if (scope === "whole") {
    return { inputPaths: ["."], outputPaths, error: null };
  }
  const inputPaths = pruneNestedPaths(selectedPaths.filter((path) => path !== "."));
  if (inputPaths.length === 0) {
    return {
      inputPaths: [],
      outputPaths: [],
      error: "请勾选要带入这一步的文件或目录",
    };
  }
  return { inputPaths, outputPaths, error: null };
}

export function canSaveDeclaredGoal(input: {
  name: string;
  scope: TaskMaterialScope;
  selectedPaths: readonly string[];
  permission: TaskPermission;
}): boolean {
  if (!input.name.trim()) return false;
  return taskPathsForScope(input.scope, input.selectedPaths, input.permission).error === null;
}

export function canSubmitDeclaredTask(input: {
  name: string;
  scope: TaskMaterialScope;
  selectedPaths: readonly string[];
  profileId: string;
  permission: TaskPermission;
}): boolean {
  if (!input.profileId) return false;
  return canSaveDeclaredGoal(input);
}

/** 会话/开步自动登记的 Task 常用绝对路径当名称；人声明的步骤不会。 */
export function isDeclaredTaskName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/") || trimmed.startsWith("~")) return false;
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return false;
  if (trimmed.startsWith("\\\\")) return false;
  return true;
}

export function isDeclaredTask(task: { declared?: boolean; name: string }): boolean {
  if (task.declared === true) return true;
  if (task.declared === false) return false;
  return isDeclaredTaskName(task.name);
}

export function visibleDeclaredTasks<
  T extends { kind: string; name: string; declared?: boolean; archivedAt?: string | null },
>(
  tasks: readonly T[],
  kinds: ReadonlySet<string>,
): T[] {
  // 已归档（archivedAt）的目标不出主列表：删除即归档后数据还在，只是不再出现
  return tasks.filter(
    (task) => kinds.has(task.kind) && isDeclaredTask(task) && !task.archivedAt,
  );
}

export function archivedDeclaredTasks<
  T extends { kind: string; name: string; declared?: boolean; archivedAt?: string | null },
>(
  tasks: readonly T[],
  kinds: ReadonlySet<string>,
): T[] {
  return tasks.filter(
    (task) => kinds.has(task.kind) && isDeclaredTask(task) && !!task.archivedAt,
  );
}

export function declaredTaskKindsForMode(
  workMode: string | null | undefined,
): Set<string> {
  if (workMode === "office") return new Set(["office_doc"]);
  if (workMode === "research") return new Set(["free_research"]);
  return new Set();
}

export function taskStatusLabel(status: string): string {
  switch (status) {
    case "running":
      return "进行中";
    case "pending_review":
      return "待验收";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "stopped":
      return "已停止";
    default:
      return "尚未开始";
  }
}

export type GoalBucket = "running" | "review" | "stuck" | "open" | "done";

export const GOAL_BUCKET_ORDER: GoalBucket[] = [
  "review",
  "running",
  "stuck",
  "open",
  "done",
];

export const GOAL_BUCKET_LABEL: Record<GoalBucket, string> = {
  running: "进行中",
  review: "待验收",
  stuck: "需要处理",
  open: "尚未开始",
  done: "已完成",
};

export function goalBucket(status: string): GoalBucket {
  if (status === "pending_review") return "review";
  if (status === "completed") return "done";
  if (status === "running") return "running";
  if (status === "failed" || status === "stopped") return "stuck";
  return "open";
}

export function goalDisplayName(task: {
  name: string;
  description?: string | null;
}): string {
  const name = task.name.trim();
  const desc = task.description?.trim() ?? "";
  if (desc && desc !== name && desc.length > name.length) return desc;
  return name || desc;
}

/** 空列表不再解释按钮；有目标时才说下一步。 */
export function goalVsChatHint(_workMode?: string | null): string {
  return "";
}

export function nextGoalHint(
  workMode: string | null | undefined,
  tasks: readonly { name: string; status: string; description?: string | null }[],
): string {
  if (tasks.length === 0) return goalVsChatHint(workMode);
  const review = tasks.find((task) => task.status === "pending_review");
  if (review) return `验收「${goalDisplayName(review)}」。`;
  const running = tasks.find((task) => task.status === "running");
  if (running) return `「${goalDisplayName(running)}」正在做，点继续看进度。`;
  const stuck = tasks.find(
    (task) => task.status === "failed" || task.status === "stopped",
  );
  if (stuck) return `「${goalDisplayName(stuck)}」没做完，点重试。`;
  const open = tasks.find((task) => task.status === "pending");
  if (open) return `开始「${goalDisplayName(open)}」，或再记一个目标。`;
  return "还可以再记一个目标。";
}

export function groupGoalsByBucket<T extends { status: string }>(
  tasks: readonly T[],
): Record<GoalBucket, T[]> {
  const groups: Record<GoalBucket, T[]> = {
    running: [],
    review: [],
    stuck: [],
    open: [],
    done: [],
  };
  for (const task of tasks) {
    groups[goalBucket(task.status)].push(task);
  }
  return groups;
}

export function isTaskMaterialNoise(name: string, isSystem?: boolean): boolean {
  if (isSystem) return true;
  return (
    name === ".git" ||
    name === ".ccode" ||
    name === "node_modules" ||
    name === "target" ||
    name === "artifacts.yaml"
  );
}

/** 保护路径只建议像原始数据 / 合同财务的目录，勾选列表里这些排前面。 */
export function suggestProtectedPaths(
  workMode: string | null | undefined,
  dirNames: readonly string[],
): string[] {
  if (workMode === "coding") return [];
  const pattern =
    workMode === "office"
      ? /^(合同|财务|发票|invoice|finance|contracts?)$/i
      : /^(数据|data|raw|原始数据)$/i;
  return dirNames.filter((name) => pattern.test(name.trim()));
}

export type ProtectEntry = {
  path: string;
  isDir: boolean;
};

function protectEntryName(
  entry: { name: string; isDir?: boolean; isSystem?: boolean },
): string | null {
  const name = entry.name.trim();
  if (!name || isTaskMaterialNoise(name, entry.isSystem)) return null;
  return name;
}

/** 项目根下一层的文件夹和文件都可以勾；不展开子树。勾文件夹保护里面全部。 */
export function protectableEntries(
  topLevel: readonly { name: string; isDir?: boolean; isSystem?: boolean }[],
  extraProtected: readonly string[] = [],
  workMode?: string | null,
): ProtectEntry[] {
  const usable = topLevel
    .map((entry) => {
      const name = protectEntryName(entry);
      return name ? { path: name, isDir: entry.isDir !== false } : null;
    })
    .filter((entry): entry is ProtectEntry => entry !== null);
  const suggested = new Set(
    suggestProtectedPaths(
      workMode,
      usable.filter((entry) => entry.isDir).map((entry) => entry.path),
    ),
  );
  const rows = [
    ...usable.filter((entry) => suggested.has(entry.path)),
    ...usable.filter((entry) => !suggested.has(entry.path)),
  ];
  const seen = new Set(rows.map((entry) => entry.path));
  for (const raw of extraProtected) {
    const path = normSep(raw).replace(/^\/+|\/+$/g, "");
    if (!path || path === "." || seen.has(path)) continue;
    if (rows.some((parent) => path === parent.path || path.startsWith(`${parent.path}/`))) {
      continue;
    }
    const last = path.split("/").pop() ?? path;
    rows.push({ path, isDir: !/\.[^./]+$/.test(last) });
    seen.add(path);
  }
  return rows;
}

/** 已被父文件夹勾上：这一层不能单独取消。 */
export function folderProtectLocked(
  path: string,
  protectedPaths: readonly string[],
): boolean {
  const relative = normSep(path).replace(/^\/+|\/+$/g, "");
  if (!relative) return false;
  return protectedPaths.some((item) => {
    const parent = normSep(item).replace(/^\/+|\/+$/g, "");
    return Boolean(parent) && relative.startsWith(`${parent}/`);
  });
}

export function toggleProtectedFolder(
  current: readonly string[],
  path: string,
  checked: boolean,
): string[] {
  const relative = normSep(path).replace(/^\/+|\/+$/g, "");
  if (!relative || relative === ".") return [...current];
  if (checked) {
    const rest = current.filter((item) => {
      const existing = normSep(item).replace(/^\/+|\/+$/g, "");
      return existing !== relative && !existing.startsWith(`${relative}/`);
    });
    return pruneNestedPaths([...rest, relative]);
  }
  return current.filter((item) => {
    const existing = normSep(item).replace(/^\/+|\/+$/g, "");
    return existing !== relative && !existing.startsWith(`${relative}/`);
  });
}

export function taskInputLabel(paths: readonly string[]): string {
  if (paths.includes(".")) return "整个项目";
  return paths.length ? paths.join("、") : "不带入现有文件";
}

export function taskOutputLabel(
  paths: readonly string[],
  reviewRequired: boolean,
  workMode?: string | null,
): string {
  if (!reviewRequired) return "只讨论，不改项目文件";
  const writeback =
    workMode === "office" ? "验收后写入文档" : "验收后写入项目";
  if (paths.includes(".")) return writeback;
  return paths.length ? `${writeback} ${paths.join("、")}` : writeback;
}

export function taskChangeKindLabel(kind: string): string {
  if (kind === "added") return "新增";
  if (kind === "modified") return "修改";
  if (kind === "deleted") return "已删除 · 不写回";
  return kind;
}

export function selectedChangePaths(
  changes: readonly { path: string }[],
  selected: ReadonlySet<string>,
): string[] {
  return changes.filter((change) => selected.has(change.path)).map((change) => change.path);
}

export function relativeProjectPath(root: string, path: string): string {
  const normalizedRoot = normSep(stripVerbatim(root)).replace(/\/+$/, "");
  const normalizedPath = normSep(stripVerbatim(path));
  if (!normalizedRoot) return normalizedPath;
  if (normalizedPath === normalizedRoot) return "";
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  const rootKey = normalizedRoot.toLowerCase();
  const pathKeyValue = normalizedPath.toLowerCase();
  if (pathKeyValue.startsWith(`${rootKey}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  return normalizedPath;
}

export function taskFileBadge(
  outputPaths: readonly string[],
  relativeFile: string,
): string | null {
  if (!relativeFile || outputPaths.includes(".")) return null;
  const file = normSep(relativeFile).replace(/\/+$/, "");
  return (
    outputPaths.find((output) => {
      const normalized = normSep(output).replace(/\/+$/, "");
      return file === normalized || file.startsWith(`${normalized}/`);
    }) ?? null
  );
}

export function goalRevisionLabel(runCount: number): string | null {
  if (runCount <= 1) return null;
  return `第 ${runCount} 版`;
}

export type GoalTimelineItem = {
  kind: "generated" | "feedback" | "revision" | "accepted";
  text: string;
  /** 这一版开跑 / 这条意见写下的时间（详情里与「生成」「第 2 版」并排显示）；接受没有可靠时间，不填 */
  at?: string;
};

export type GoalTimelineRun = {
  id: string;
  status: string;
  internal?: boolean;
  createdAt: string;
};

export type GoalTimelineEvent = {
  runId: string;
  eventType: string;
  payload?: string | null;
  createdAt: string;
};

export function parseReviewNote(payload?: string | null): string {
  const raw = payload?.trim() ?? "";
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as { feedback?: unknown; note?: unknown };
    const text =
      (typeof parsed.feedback === "string" && parsed.feedback) ||
      (typeof parsed.note === "string" && parsed.note) ||
      "";
    return text.trim();
  } catch {
    return raw;
  }
}

export function parseAdoptedPaths(payload?: string | null): string[] {
  const raw = payload?.trim() ?? "";
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { paths?: unknown };
    if (!Array.isArray(parsed.paths)) return [];
    return parsed.paths
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item && item !== ".");
  } catch {
    return [];
  }
}

export function goalTimeline(input: {
  status: string;
  runs: readonly GoalTimelineRun[];
  events?: readonly GoalTimelineEvent[];
  acceptedLabel?: string;
}): GoalTimelineItem[] {
  const runs = input.runs
    .filter((run) => !run.internal)
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const events = (input.events ?? [])
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const items: GoalTimelineItem[] = [];
  runs.forEach((run, index) => {
    items.push(
      index === 0
        ? { kind: "generated", text: "生成", at: run.createdAt }
        : { kind: "revision", text: `第 ${index + 1} 版`, at: run.createdAt },
    );
    for (const event of events) {
      if (event.runId !== run.id || event.eventType !== "task.review_notes") continue;
      const note = parseReviewNote(event.payload);
      if (note) items.push({ kind: "feedback", text: `意见：${note}`, at: event.createdAt });
    }
  });
  if (input.status === "completed") {
    items.push({ kind: "accepted", text: input.acceptedLabel ?? "已接受" });
  }
  return items;
}

export function goalTimelineLabel(items: readonly GoalTimelineItem[]): string {
  return items.map((item) => item.text).join(" → ");
}

/** 历程路径不含意见正文，给任务卡摘要用。 */
export function goalTimelinePath(items: readonly GoalTimelineItem[]): string {
  return items.map((item) => (item.kind === "feedback" ? "意见" : item.text)).join(" → ");
}

export function pathIsProtected(
  relative: string,
  protectedPaths: readonly string[],
): boolean {
  return pathCoveredBySelection(relative, protectedPaths);
}

export function parseProtectedPathDraft(text: string): {
  paths: string[];
  error: string | null;
} {
  const raw = text
    .split("\n")
    .map((line) => line.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  if (raw.some((path) => path === ".")) {
    return { paths: [], error: "保护路径不能是整个项目" };
  }
  if (
    raw.some((path) =>
      path.split("/").some((part) => !part || part === "." || part === ".."),
    )
  ) {
    return { paths: [], error: "保护路径必须是项目内相对路径" };
  }
  return { paths: pruneNestedPaths(raw), error: null };
}

export function acceptedGoalOutputs(
  outputPaths: readonly string[] | undefined,
  adoptedPaths: readonly string[] | undefined,
): string[] {
  const adopted = (adoptedPaths ?? []).map((item) => item.trim()).filter((item) => item && item !== ".");
  if (adopted.length) return adopted;
  return (outputPaths ?? []).map((item) => item.trim()).filter((item) => item && item !== ".");
}

export function continueGoalPrompt(goal: string, feedback: string): string {
  const body = goal.trim() || "按原目标继续";
  const note = feedback.trim();
  if (!note) return body;
  return `${body}\n\n上一版的修改意见：\n${note}`;
}

export type GoalFileMark = {
  goalName: string;
  pending: boolean;
};

export function markForProjectFile(
  relative: string,
  marks: readonly { relative: string; goalName: string; pending: boolean }[],
): GoalFileMark | null {
  const file = normSep(relative).replace(/\/+$/, "");
  if (!file) return null;
  const hit = marks.find((mark) => {
    const path = normSep(mark.relative).replace(/\/+$/, "");
    return file === path || file.startsWith(`${path}/`) || path.startsWith(`${file}/`);
  });
  return hit ? { goalName: hit.goalName, pending: hit.pending } : null;
}

export function joinRunPath(root: string, relative: string): string {
  const base = root.replace(/[\\/]+$/, "");
  const rest = relative.replace(/\\/g, "/").replace(/^\/+/, "");
  return rest ? `${base}/${rest}` : base;
}
