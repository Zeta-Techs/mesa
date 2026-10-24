/**
 * 顶栏 / 灵动岛的「位置与活动」分工（纯逻辑，tests/shell-context.test.ts）。
 *
 * 2026-10-17 侧栏工作台化后定的规矩：同一件事在每种侧栏形态下只出现在一处。
 *   展开     项目在项目树、运行在项目树各对话行尾的点（折起的项目头上也有）→ 顶栏左侧什么都不放；
 *            侧栏「运行」行 2026-10-24 撤掉，只在图标态留一个图标（没有树时靠它回到对话）
 *   图标态   项目树不可见 → 顶栏项目芯片常驻（回项目 + 切换；侧栏文件夹只管去项目页，不再兼做切换）；活动芯片在顶栏
 *   全隐藏   没有侧栏 → 项目芯片常驻（这是唯一的切项目入口）；活动挪进灵动岛，顶栏不再报
 */
import { announceLabel } from "./run-announce.ts";
import { itemRank, type RunOverviewInput } from "./run-overview.ts";
import type { RunCaretState } from "./run-caret.ts";

export type ShellMode = "expanded" | "collapsed" | "hidden";

export function shellMode(collapsed: boolean, hidden: boolean): ShellMode {
  if (hidden) return "hidden";
  return collapsed ? "collapsed" : "expanded";
}

export interface ShellContextPlacement {
  /** 顶栏左侧的项目芯片 */
  projectChip: boolean;
  /** 运行活动摘要放在哪：顶栏芯片 / 灵动岛 / 不单独放（展开态项目树的对话行已承担） */
  activity: "titlebar" | "island" | "none";
}

export function shellContextPlacement(
  mode: ShellMode,
  /** 现行规则与页面无关（芯片常驻）；保留参数位，规则若再按页细分不必改调用方 */
  _page: string,
): ShellContextPlacement {
  if (mode === "expanded") return { projectChip: false, activity: "none" };
  // 侧栏不显示项目树时（图标态 / 全隐藏）芯片都常驻：它是唯一的切项目入口，在项目页也要能切。
  // 项目页页头的课题名是身份，芯片是切换器，两者不算重复。
  if (mode === "collapsed") return { projectChip: true, activity: "titlebar" };
  return { projectChip: true, activity: "island" };
}

export type RunActivityState = "confirm" | "working" | "done" | "running";

export interface RunActivityAgent {
  tabId: string;
  label: string;
  /** 所在目录末段（同名标签靠它区分） */
  where: string;
  agentId: string;
  state: RunActivityState;
}

export interface RunActivitySummary {
  agents: RunActivityAgent[];
  confirm: number;
  /** 正在跑的总数：终端标签里的 agent；一个都没有时回落外部 live 会话数（与侧栏计数同口径） */
  running: number;
  /** 没有终端标签可跳的外部 live 会话（列表里只能报个数） */
  external: number;
  tone: "confirm" | "running" | "idle";
  /** 芯片 / 胶囊上的短句 */
  label: string;
}

const STATE_OF = (input: RunOverviewInput): RunActivityState =>
  input.attention === "confirm"
    ? "confirm"
    : input.attention === "working"
      ? "working"
      : input.attention === "done"
        ? "done"
        : "running";

export const RUN_ACTIVITY_STATE_LABEL: Record<RunActivityState, string> = {
  confirm: "待确认",
  working: "工作中",
  done: "已回复",
  running: "运行中",
};

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** 活动芯片 / 图标态「运行」上那一道光标（run-caret.ts）：有等确认的 > 有在干活的（Mesa 外在写的也算）> 都闲着 */
export function runActivityCaret(summary: RunActivitySummary): RunCaretState | null {
  if (summary.tone === "idle") return null;
  if (summary.confirm > 0) return "confirm";
  if (summary.external > 0 || summary.agents.some((a) => a.state === "working")) return "working";
  return "idle";
}

/** 列表里每一个的光标：做完了（done）和刚起来不知道的（running）都按闲着 */
export function runActivityAgentCaret(state: RunActivityState): RunCaretState {
  return state === "confirm" ? "confirm" : state === "working" ? "working" : "idle";
}

/** 运行摘要：只认在跑的 agent（回落 shell 不算），待确认排最前（itemRank 同口径）。 */
export function runActivitySummary(
  inputs: readonly RunOverviewInput[],
  liveSessionCount: number,
): RunActivitySummary {
  const live = inputs
    .filter((i) => i.running && !i.shell)
    .slice()
    .sort((a, b) => itemRank(a) - itemRank(b));
  const agents = live.map((i) => ({
    tabId: i.tabId,
    label: announceLabel(i.title, i.cwd),
    where: baseName(i.cwd),
    agentId: i.agentId,
    state: STATE_OF(i),
  }));
  const confirm = agents.filter((a) => a.state === "confirm").length;
  const running = agents.length || liveSessionCount;
  const external = agents.length ? 0 : liveSessionCount;
  const tone = confirm > 0 ? "confirm" : running > 0 ? "running" : "idle";
  const label =
    confirm > 0
      ? running > confirm
        ? `${confirm} 待确认 · ${running} 运行中`
        : `${confirm} 待确认`
      : running > 0
        ? `${running} 运行中`
        : "";
  return { agents, confirm, running, external, tone, label };
}
