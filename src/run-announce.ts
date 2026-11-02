import type { RunOverviewInput } from "./run-overview.ts";

/* ---------------------------------------------------------------------------
   跑完播报：Agent 结束一个回合或整个进程掉线时，在顶部岛的休眠面上报一句。

   为什么只有这两件事进岛：收件箱已经覆盖了「等确认」「冲突」「待验收」「待发送」
   这类**状态**——它是任意时刻的真相源，随时点开都在。岛不持有状态，只报**事件**，
   报完就散。凡是收件箱已经持有一份计数的，岛不得再持一份，否则两处数字会各说各话。
   跑完/跑挂是唯一没有归宿的一对：`WorkspaceReviewPanel` 的待验收要 Run 才有，
   收件箱的 runItems 只收 attention === "confirm"，done 与 failed 都被有意排除。
   所以这里的增量是干净的，不是又给收件箱开了一个入口。

   而「跑完」在跑完那一刻有用，十分钟后没用——这正是会过期、收件箱放不住的那类信息。
--------------------------------------------------------------------------- */

/**
 * 播报在休眠面上停留的时长。
 *
 * 刻意不跟随用户配置的收起延时：那个档位是「岛离开指针后多久收起自己的导航」，
 * 是导航的节奏；播报读的是内容，跟导航挂同一个数只会让刚加的「立即」档把每条
 * 播报一并瞬杀掉——用户选立即是嫌导航挡着，不是嫌通知碍事。
 */
export const RUN_ANNOUNCE_LINGER_MS = 4000;

/**
 * 同窗口内到达的播报合并成一条。多标签并行是常态，五个 Agent 同时收尾时
 * 不该轮流霸屏四秒、滚出一条 20 秒的队列——合并成「3 个已跑完」一句话说完。
 */
export const RUN_ANNOUNCE_MERGE_MS = 1500;

export type RunOutcome = "done" | "failed";

export interface RunAnnouncement {
  kind: "run";
  outcome: RunOutcome;
  /** 展示名：标签标题优先，空则退回 cwd 目录名。 */
  label: string;
  /** 标签 id，同一标签的后续播报替换前者而不是排队。 */
  tabId: string;
  /** 合并计数：1 = 单条，>1 = 「N 个已跑完」。 */
  count: number;
  /** 产生时刻（ms），由调用方传入，便于纯函数测试。 */
  at: number;
}

/** 标签标题为空时的兜底名，与运行总览同口径（末段目录名）。 */
export function announceLabel(title: string, cwd: string): string {
  const trimmed = title.trim();
  if (trimmed) return trimmed;
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "终端";
}

/**
 * 一次结束事件值不值得播报。
 *
 * done 只认「上一轮 reported 的 attention 不是 done」——`attention` 在会话尾部是
 * sticky 的，同一回合的状态会反复上报，不去重就会一直重播同一条。
 * failed 只认「此前 running，现在不 running 且不在等确认」：这是进程掉线，
 * 不是回合结束。正常退出（用户关掉 CLI）也落进这条，无法与崩溃区分——
 * 两者对用户是同一件事「它没了」，都该说一声，所以不做进一步区分。
 */
export function runFinished(
  prev: RunOverviewInput | undefined,
  next: RunOverviewInput,
): RunOutcome | null {
  if (!prev) return null; // 基线未建立：首帧不播报，否则一开机满屏历史
  if (next.attention === "confirm") return null; // 等你确认走收件箱，不是结束
  if (next.attention === "done" && prev.attention !== "done") return "done";
  if (prev.running && !next.running && !next.shell) return "failed";
  return null;
}

/**
 * 合并同一批到达的播报。同一标签只留最后一条（后到的状态更新），
 * 不同标签按结局分组计数，同一结局取最近一条作为载体。
 *
 * `windowMs` 内的旧条目并入新条目；超出窗口的旧条目原样保留在前面，
 * 让调用方按时间序渲染或裁剪。
 */
export function mergeAnnouncements(
  existing: readonly RunAnnouncement[],
  incoming: RunAnnouncement,
  now: number,
  windowMs = RUN_ANNOUNCE_MERGE_MS,
): RunAnnouncement[] {
  const next: RunAnnouncement[] = [];
  let merged = false;
  for (const item of existing) {
    if (item.tabId === incoming.tabId) continue; // 同标签：新的一条顶掉旧的
    if (item.outcome !== incoming.outcome) {
      next.push(item);
      continue;
    }
    if (now - item.at > windowMs) {
      next.push(item);
      continue;
    }
    if (!merged) {
      next.push({ ...incoming, count: item.count + 1 });
      merged = true;
    }
  }
  if (!merged) next.push(incoming);
  return next;
}

/** 休眠面上那一行字。单条报名字，多条报个数。 */
export function announceLine(item: RunAnnouncement): string {
  const verb = item.outcome === "done" ? "已跑完" : "已断开";
  if (item.count > 1) return `${item.count} 个${verb}`;
  return `${item.label} ${verb}`;
}
