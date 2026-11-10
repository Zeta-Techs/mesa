/**
 * 一步按数据分几路（2026-11-03 项目内协作四期，docs/design-project-coordination.md §9）前端纯逻辑：
 * 同一个工作区里分片，每路一段对话（复用键 `ws:<工作树>#lane-<k>`，parallelLane），各路做完写 `.ccode/fanout/lane-<k>.done`；
 * 到齐后 Mesa 用这一步本来的复用键开收尾一路（TerminalPage 的定时检查）。几路由数据定（fan_out.rs），分不分由人在开工弹层勾。
 */
import type { FanOutItemDto, ProjectStepDto, StepFanOutDto } from "./types.ts";
import { PEEK_TOOL_WINDOWS_NOTE } from "./peek.ts";

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
    `只写这几条自己的文件${spec.own ? `：${spec.own}` : ""}。任务书里要求写的共享文件（索引、引文库、清单、验收摘要一类）一律不写，任务书里会生成或改写共享文件的命令（开头要先跑的整理、出清单脚本一类）也不跑，这些都留给最后的收尾一路；不跑 git 提交；不碰别的条目的文件。读材料时的中间文件（从 PDF 抽的文字、页面截图、临时脚本）放系统临时目录，不放进工作区，用完删掉：工作区产物目录里的文件评审后会带回项目。`,
    `做完这几条后，写一个空文件 \`${laneDoneMark(k)}\` 就停下，不用等人。想知道别的几路进度：\`${tool} peek agents\`。${isWindows ? PEEK_TOOL_WINDOWS_NOTE : ""}`,
  ].join("\n");
}

/** 收尾一路的开场：读各路产物，写共享文件与验收摘要；缺的先列出来 */
export function mergePrompt(step: Pick<ProjectStepDto, "name">, spec: StepFanOutDto, total: number): string {
  return [
    `「${step.name}」刚才分 ${total} 路同时做完了（各路只写了自己那几条的文件，做完标记在 \`${FANOUT_MARK_DIR}/\`）。现在你做收尾，照常先读 TASK.md：`,
    spec.merge ? spec.merge : "按任务书把共享文件写全、写验收摘要。",
    "不要重做各路已经做好的条目；合各路的表时照搬各路写好的行，只调顺序、统一格式，不改写、不删减。对一遍条目清单，缺了或做坏了的先列出来，再按任务书决定补做还是写进报告交给人。各路留在产物目录里的中间文件（抽出的文字、截图、临时脚本）删掉，写进报告。",
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
  /** 各路的终端请求（第 k 路 = laneRequests[k-1]）：开工时没起来的路由终端页补开（2026-11-10 HER：第 1 路标签凭空没了，收尾永远等不齐） */
  laneRequests?: unknown[];
  /** 已补开过的路，每路只补一次 */
  healed?: number[];
  /** 记下的时间（ms）：超过 FANOUT_EXPIRE_MS 还没到齐的不再等（工作区可能已归档） */
  createdAt?: number;
}

export const FANOUT_EXPIRE_MS = 3 * 24 * 3600 * 1000;

export const FANOUT_STORAGE_PREFIX = "ccode.fanout.";

/** 要补开的路：没写做完标记、没有标签、也从没起过运行（起过又被人关掉的不补），每路只补一次 */
export function lanesToHeal(input: {
  lanes: number;
  done: readonly number[];
  laneKeys: readonly (string | undefined)[];
  openKeys: ReadonlySet<string>;
  ranKeys: ReadonlySet<string>;
  healed: readonly number[];
}): number[] {
  const out: number[] = [];
  for (let k = 1; k <= input.lanes; k += 1) {
    const key = input.laneKeys[k - 1];
    if (!key || input.done.includes(k) || input.healed.includes(k)) continue;
    if (input.openKeys.has(key) || input.ranKeys.has(key)) continue;
    out.push(k);
  }
  return out;
}

/** 到齐了没：1..lanes 都有标记 */
export function allLanesDone(done: readonly number[], lanes: number): boolean {
  for (let k = 1; k <= lanes; k += 1) if (!done.includes(k)) return false;
  return lanes > 0;
}
