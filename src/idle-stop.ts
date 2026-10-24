/**
 * 空闲对话的后台进程自动收（2026-10-24 用户拍板 A，tests/idle-stop.test.ts）。
 * 运行页标签条撤掉以后，开着的 Agent 进程看不见也不好关，会越积越多。回完话、你也没在看的对话，
 * 空闲满 30 分钟就停掉进程、收掉标签；记录还在侧栏，再点开就是「只看不接、发一句接回」。
 * 不收：正看着的（含分屏两栏）、正在生成 / 等你确认的、输入框里有没发的字的，
 * 以及不是普通对话的标签——纯终端（可能跑着开发服务）、流水线步骤、编程车道、阅读、登录、自定义运行时等各有自己的收尾。
 */
import { isNewChatKey } from "./quick-chat.ts";

/** 空闲多久收：30 分钟 */
export const IDLE_STOP_MS = 30 * 60 * 1000;

export interface IdleTabInput {
  id: string;
  reuseKey?: string;
  customRuntimeId?: string;
  stepName?: string;
  taskId?: string;
}

export interface IdleStatusInput {
  running: boolean;
  shell: boolean;
  attention: "done" | "working" | "confirm" | null;
}

/** 这个标签算不算「普通对话」：新对话入口开的、从列表接回的，或没带复用键的；别的入口各有自己的生命周期 */
export function isPlainChatTab(tab: IdleTabInput): boolean {
  if (tab.customRuntimeId || tab.stepName || tab.taskId) return false;
  const key = tab.reuseKey;
  return !key || isNewChatKey(key) || key.startsWith("resume:");
}

/** 现在能不能开始算空闲：Agent 在跑、没在生成、没等你确认，且是普通对话 */
export function idleEligible(tab: IdleTabInput, status: IdleStatusInput | null | undefined): boolean {
  if (!status?.running || status.shell) return false;
  if (status.attention === "working" || status.attention === "confirm") return false;
  return isPlainChatTab(tab);
}

/**
 * 每次检查时更新各标签「从什么时候开始空闲」，并给出该收的。
 * since：上一次的记录（tabId → 开始空闲的时刻）；kept：正看着的 / 输入框有字的，算作不空闲。
 * 不再符合条件的从记录里去掉（下次符合时重新计时）。
 */
export function idleStopPass(input: {
  tabs: readonly IdleTabInput[];
  statuses: Readonly<Record<string, IdleStatusInput | undefined>>;
  kept: ReadonlySet<string>;
  since: Readonly<Record<string, number>>;
  now: number;
  limitMs?: number;
}): { since: Record<string, number>; stop: string[] } {
  const limit = input.limitMs ?? IDLE_STOP_MS;
  const since: Record<string, number> = {};
  const stop: string[] = [];
  for (const tab of input.tabs) {
    if (input.kept.has(tab.id) || !idleEligible(tab, input.statuses[tab.id])) continue;
    const from = input.since[tab.id] ?? input.now;
    since[tab.id] = from;
    if (input.now - from >= limit) stop.push(tab.id);
  }
  return { since, stop };
}
