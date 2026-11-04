/**
 * 一步按数据分几路（2026-11-03 项目内协作四期，docs/design-project-coordination.md §9）前端纯逻辑：
 * 同一个工作区里分片，每路一段对话（复用键 `ws:<工作树>#lane-<k>`，parallelLane），各路做完写 `.ccode/fanout/lane-<k>.done`；
 * 到齐后 Mesa 用这一步本来的复用键开收尾一路（TerminalPage 的定时检查）。几路由数据定（fan_out.rs），分不分由人在开工弹层勾。
 */
import type { FanOutItemDto, ProjectStepDto, StepFanOutDto } from "./types.ts";

export const FANOUT_MARK_DIR = ".ccode/fanout";

export function laneReuseKey(baseKey: string, k: number): string {
  return `${baseKey}#lane-${k}`;
}

export function laneDoneMark(k: number): string {
  return `${FANOUT_MARK_DIR}/lane-${k}.done`;
}

function itemLine(item: FanOutItemDto): string {
  const seq = String(item.seq).padStart(2, "0");
  return `- ${seq} | ${item.key}${item.label ? ` | ${item.label}` : ""}`;
}

/** 第 k 路（1 起）的开场：只做这些条目、只写自己的文件、不碰共享文件、不提交，做完写标记停下 */
export function lanePrompt(spec: StepFanOutDto, items: readonly FanOutItemDto[], k: number, total: number, isWindows: boolean): string {
  const tool = isWindows ? "& $env:MESA_PEEK_TOOL" : '"$MESA_PEEK_TOOL"';
  return [
    `这一步按数据分成 ${total} 路同时做，你是第 ${k} 路。照常先读 TASK.md，但只做下面这 ${items.length} 条（序号是全局的，起文件名照这个序号写，别的路不会撞名）：`,
    ...items.map(itemLine),
    "",
    `只写这几条自己的文件${spec.own ? `：${spec.own}` : ""}。任务书里要求写的共享文件（索引、引文库、清单、验收摘要一类）一律不写，任务书里会生成或改写共享文件的命令（开头要先跑的整理、出清单脚本一类）也不跑，这些都留给最后的收尾一路；不跑 git 提交；不碰别的条目的文件。`,
    `做完这几条后，写一个空文件 \`${laneDoneMark(k)}\` 就停下，不用等人。想知道别的几路进度：\`${tool} peek agents\`。`,
  ].join("\n");
}

/** 收尾一路的开场：读各路产物，写共享文件与验收摘要；缺的先列出来 */
export function mergePrompt(step: Pick<ProjectStepDto, "name">, spec: StepFanOutDto, total: number): string {
  return [
    `「${step.name}」刚才分 ${total} 路同时做完了（各路只写了自己那几条的文件，做完标记在 \`${FANOUT_MARK_DIR}/\`）。现在你做收尾，照常先读 TASK.md：`,
    spec.merge ? spec.merge : "按任务书把共享文件写全、写验收摘要。",
    "不要重做各路已经做好的条目；对一遍条目清单，缺了或做坏了的先列出来，再按任务书决定补做还是写进报告交给人。",
  ].join("\n");
}

/** 开工弹层那一行：会分几路 */
export function fanOutSummary(total: number, lanes: number): string {
  if (total === 0) return "数据文件里还没有条目，分不了路";
  if (lanes < 2) return `${total} 条，不到分路的量，照常一路做`;
  return `${total} 条分 ${lanes} 路同时做（${lanes} 段对话各自计费），各路做完再开一路收尾`;
}

/** 收尾等待：存在 localStorage，终端页定时数做完标记 */
export interface FanOutPending {
  worktreePath: string;
  stepName: string;
  lanes: number;
  /** 收尾一路的终端请求（PendingTerminal，开工时就拼好） */
  merge: unknown;
  mergeStarted: boolean;
  /** 记下的时间（ms）：超过 FANOUT_EXPIRE_MS 还没到齐的不再等（工作区可能已归档） */
  createdAt?: number;
  /** 这一步的花费上限（美元，2026-11-04）：各路合计到了就停掉没做完的路、不自动开收尾；空 = 不设 */
  capUsd?: number | null;
  /** 各路标签的复用键（第 k 路 = laneKeys[k-1]），到上限时按它找要停的路 */
  laneKeys?: string[];
}

export const FANOUT_EXPIRE_MS = 3 * 24 * 3600 * 1000;

export const FANOUT_STORAGE_PREFIX = "ccode.fanout.";

/** 到上限了要停哪几路：还没写做完标记的（k 从 1 起） */
export function lanesToStop(done: readonly number[], lanes: number): number[] {
  const out: number[] = [];
  for (let k = 1; k <= lanes; k += 1) if (!done.includes(k)) out.push(k);
  return out;
}

/** 到上限时给人的那句话 */
export function capStopNote(stepName: string, spent: number, cap: number, stopped: number, lanes: number): string {
  return `「${stepName}」分路花到了上限：已花 $${spent.toFixed(2)}，上限 $${cap.toFixed(2)}。没做完的 ${stopped} 路已停下（共 ${lanes} 路），收尾一路没开。做完的条目文件都在这一步的工作副本里；要接着做，回对话页把停下的那几路接回来，或回项目页接着做这一步。`;
}

/** 到齐了没：1..lanes 都有标记 */
export function allLanesDone(done: readonly number[], lanes: number): boolean {
  for (let k = 1; k <= lanes; k += 1) if (!done.includes(k)) return false;
  return lanes > 0;
}
