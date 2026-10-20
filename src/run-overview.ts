import { pathWithin, samePath } from "./path-utils.ts";
/**
 * 运行中总览（P5 聚合视图）的聚合/排序纯逻辑。
 * 输入全部由终端页现有 statuses 上报派生（TerminalView 本地轮询后镜像），
 * 不新增任何后端轮询；node --test 可直接单测。
 * 路径比较一律走 path-utils（分隔符 / verbatim 统一，Windows 折叠大小写）；
 * 平台由调用方显式传 isWindows，缺省 false = 大小写敏感（旧口径）。
 */

/** 工作区的终端注意力：cwd 落在该工作区内的运行标签。confirm > working > done。
 *  Agent 进程还在跑时不把中途助手正文当成「已跑完」。
 *  用途：流程线「已跑完」提示（ProjectGroup）与任务卡「继续/去终端看看」互斥
 *  （TaskCardsSection——在跑时点继续会在同一工作区并行第二条会话，两 Agent 并发写一棵树）。 */
export function stepAttention(
  ws: { worktreePath: string } | undefined,
  inputs: RunOverviewInput[],
  isWindows = false,
): "confirm" | "done" | "working" | null {
  if (!ws) return null;
  let found: "confirm" | "done" | "working" | null = null;
  for (const input of inputs) {
    if (!pathWithin(input.cwd, ws.worktreePath, isWindows)) continue;
    if (input.attention === "confirm") return "confirm";
    if (input.attention === "working") {
      found = "working";
      continue;
    }
    if (
      found !== "working" &&
      input.attention === "done" &&
      !(input.running && !input.shell)
    ) {
      found = "done";
    }
  }
  return found;
}

/** 聚合输入的单项：TerminalPage 从 tabs + statuses 派生（无状态的标签由调用方填默认值） */
export interface RunOverviewInput {
  tabId: string;
  title: string;
  agentId: string;
  model: string;
  cwd: string;
  /** agent 正在运行 */
  running: boolean;
  /** 当前接的是 shell（有存活 PTY） */
  shell: boolean;
  /** 会话尾部注意力状态；无联动 / shell / 已退出 / 未知为 null */
  attention: "done" | "working" | "confirm" | null;
  /** 开聊复用键（办公问 AI 按文件）；恢复占位标签没有 */
  reuseKey?: string;
  /** 第 1 期 Run 身份；无头不进此列表 */
  runId?: string;
  /** 人声明目标身份（task:<id> 的 id 部分；重启恢复的标签 reuseKey 不在白名单里，靠它归属项目） */
  taskId?: string;
}

/** Resolve a Run only from the already-mirrored terminal identity, never by
 * letting the review surface infer it from an arbitrary cwd. */
export function runIdForPath(
  inputs: readonly RunOverviewInput[],
  path: string,
  isWindows = false,
): string | null {
  if (!path.replace(/[\\/]+$/, "")) return null;
  const matches = inputs.filter(
    (input) => input.runId != null && samePath(input.cwd, path, isWindows),
  );
  // A path is not a Run identity. Only use this legacy bridge when it is
  // unambiguous; otherwise the review entry must remain explicitly unbound.
  return matches.length === 1 ? matches[0]!.runId ?? null : null;
}

export interface RunOverviewItem extends RunOverviewInput {
  /** cwd 尾段（项目名 / 工作区名），缩短显示用 */
  cwdLabel: string;
  /** 排序优先级，数字越小越靠前（见 itemRank） */
  rank: number;
}

export interface RunOverviewSummary {
  /** 待确认 */
  confirm: number;
  /** 工作中 */
  working: number;
}

/** 路径尾段（项目名 / 工作区名）；空路径返回空串，纯 "~" 原样返回 */
export function cwdBasename(p: string): string {
  if (!p) return "";
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** 该工作区还有活着的 Agent 进程（不是回落 shell）。
 *  只给步骤大圆：中途提交时圆仍停在进行中。流程线「去评审」不看这个——
 *  CLI 收完一轮后还坐在提示符上，进程活着，入口仍要给（见 workspaceAgentBusy）。 */
export function workspaceHasLiveAgent(
  worktreePath: string | undefined,
  inputs: readonly RunOverviewInput[],
  isWindows = false,
): boolean {
  if (!worktreePath) return false;
  return inputs.some((input) => {
    if (!input.running || input.shell) return false;
    return pathWithin(input.cwd, worktreePath, isWindows);
  });
}

/** Agent 正在出字或等确认。藏「去评审」、工作区行不喊「需要处理」。回合结束（done）不算。 */
export function workspaceAgentBusy(
  worktreePath: string | undefined,
  inputs: readonly RunOverviewInput[],
  isWindows = false,
): boolean {
  if (!worktreePath) return false;
  return inputs.some((input) => {
    if (input.attention !== "working" && input.attention !== "confirm") {
      return false;
    }
    return pathWithin(input.cwd, worktreePath, isWindows);
  });
}

/** 项目列表行的状态点：待处理优先；否则只有 Agent 进程还在这个课题里跑才亮绿。
 *  未归档工作区、回合结束、回落 shell 都不亮。 */
export function projectRailStatus(input: {
  needsAttention: number;
  roots: readonly string[];
  runs: readonly RunOverviewInput[];
  /** 平台显式传入（Windows 折叠大小写）；缺省按大小写敏感比较 */
  isWindows?: boolean;
}): "warn" | "running" | null {
  if (input.needsAttention > 0) return "warn";
  const isWindows = input.isWindows ?? false;
  const roots = input.roots.filter((root) => root.replace(/[\\/]+$/, "").length > 0);
  const running = input.runs.some((run) => {
    if (!run.running || run.shell) return false;
    return roots.some((root) => pathWithin(run.cwd, root, isWindows));
  });
  return running ? "running" : null;
}

/** 收件箱「待评审」：可合并且无冲突，且 Agent 没在出字。 */
export function workspaceReviewInboxEligible(input: {
  readyToMerge?: boolean | null;
  conflict?: boolean | null;
  agentBusy: boolean;
}): boolean {
  return Boolean(input.readyToMerge) && !input.conflict && !input.agentBusy;
}

/** 「要你管」排序：待确认 > 工作中 > 其余 agent 运行中 > shell / 已退出。
 *  「已回复」（done）不占档——回合结束不阻塞决策，归入普通运行/退出档 */
export function itemRank(input: RunOverviewInput): number {
  if (input.attention === "confirm") return 0;
  if (input.attention === "working") return 1;
  if (input.running) return 2;
  return 3;
}

/** 汇总全部终端标签：按「要你管」优先级稳定排序（同级保持标签原有顺序），并统计摘要 */
export function buildRunOverview(inputs: RunOverviewInput[]): {
  items: RunOverviewItem[];
  summary: RunOverviewSummary;
} {
  const items: RunOverviewItem[] = inputs.map((input) => ({
    ...input,
    cwdLabel: cwdBasename(input.cwd),
    rank: itemRank(input),
  }));
  // Array.prototype.sort 稳定：同 rank 保持传入顺序（即标签条顺序）
  items.sort((a, b) => a.rank - b.rank);
  const summary: RunOverviewSummary = { confirm: 0, working: 0 };
  for (const it of items) {
    if (it.attention === "confirm") summary.confirm++;
    else if (it.attention === "working") summary.working++;
  }
  return { items, summary };
}
