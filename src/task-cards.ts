import type { HumanTaskStateDto, TaskCardDto } from "./types";

/** 任务卡纯逻辑：分桶/排序/会话分组，供工作区页卡片区、对话页分组与评审沉淀共用（单一出处，测试在 tests/task-cards.test.ts） */

/** 卡片排序：创建时间升序（先建在前），同刻按名称码位序兜底，保证渲染顺序稳定。
 *  兜底禁用 localeCompare：默认 locale 随系统走（Windows 中文机 = 拼音序，英文 CI = 码位序），
 *  同一数据不同机器排出两种顺序，测试与界面都不稳 */
export function sortCards(cards: TaskCardDto[]): TaskCardDto[] {
  return cards
    .slice()
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
}

/** 按流水线步骤分桶：步骤桶按流水线顺序排列；挂在已删除/改名步骤上的卡与未挂步骤的卡
 *  一起收进「未挂步骤」桶（恒在末尾，即使为空也保留——它是新建未挂卡片的入口） */
export function bucketCardsByStep(
  cards: TaskCardDto[],
  stepNames: string[],
): { step: string | null; cards: TaskCardDto[] }[] {
  const sorted = sortCards(cards);
  const buckets = stepNames.map((step) => ({
    step: step as string | null,
    cards: [] as TaskCardDto[],
  }));
  const unattached: { step: string | null; cards: TaskCardDto[] } = {
    step: null,
    cards: [],
  };
  for (const card of sorted) {
    const bucket =
      card.step !== null
        ? buckets.find((b) => b.step === card.step)
        : undefined;
    (bucket ?? unattached).cards.push(card);
  }
  return [...buckets, unattached];
}

/** 会话按卡片分组（对话页项目筛选下）：「未归置」(taskId null) 恒在最前，与原「无工作区会话排最前」同口径；
 *  其余组按组内最近活跃降序；组内保持传入顺序（调用方已按时间降序）。
 *  组名取组内首个非空 taskName（后端按项目回填，卡片删除后 taskId/taskName 均为 null） */
export function groupSessionsByTask<
  T extends {
    taskId: string | null;
    taskName: string | null;
    updatedAt: string | null;
  },
>(sessions: T[]): { taskId: string | null; name: string; list: T[] }[] {
  const groups = new Map<string | null, T[]>();
  for (const s of sessions) {
    const k = s.taskId;
    const g = groups.get(k);
    if (g) g.push(s);
    else groups.set(k, [s]);
  }
  return [...groups.entries()]
    .sort((a, b) => {
      if (a[0] === null) return -1;
      if (b[0] === null) return 1;
      return (b[1][0]?.updatedAt ?? "").localeCompare(a[1][0]?.updatedAt ?? "");
    })
    .map(([taskId, list]) => ({
      taskId,
      name:
        taskId === null
          ? "未归置"
          : (list.find((s) => s.taskName)?.taskName ?? "未命名卡片"),
      list,
    }));
}

// ===== 开工弹层 TASK.md 编辑区（可编辑预览）的纯状态机 =====

/** text = 编辑区当前内容；dirty = 人编辑过（拼装变化的重拼不再覆盖） */
export interface TaskMdEditorState {
  text: string;
  dirty: boolean;
}
export type TaskMdEditorEvent =
  /** 默认拼装结果（初次加载/来源变化）：仅 dirty=false 时生效 */
  | { type: "assemble"; text: string }
  /** 人工编辑 */
  | { type: "edit"; text: string }
  /** 恢复默认拼装 */
  | { type: "reset"; text: string };

export function taskMdEditorReduce(
  state: TaskMdEditorState,
  event: TaskMdEditorEvent,
): TaskMdEditorState {
  switch (event.type) {
    case "assemble":
      return state.dirty ? state : { text: event.text, dirty: false };
    case "edit":
      return { text: event.text, dirty: true };
    case "reset":
      return { text: event.text, dirty: false };
  }
}


// ===== 话题卡（讨论的唯一载体） =====

/** 聚焦步骤下的全部话题卡：种子开聊建的、决策项「开聊」建的、手动加的，一律进这一个清单。
 *
 *  刻意不按 kind 过滤：kind（idea/draft）原本区分「只读纯聊」和「agent 直接改草稿」，
 *  但那是启动参数的差别，不该逼用户在开聊前先选一种——讨论入口已合并为「只读开聊 + 事后沉淀」，
 *  可写那条路由 discuss 节点的「跟 Agent 聊任务书」单独承担。
 *  两种 kind 都收还有个现实理由：老项目里已经建好的 draft 卡不能凭空消失。 */
export function topicCardsForStep(
  cards: TaskCardDto[],
  stepName: string,
): TaskCardDto[] {
  return sortCards(cards.filter((c) => c.step === stepName));
}

/** 还没开聊过的预置话题（讨论种子 + 决策项问题）：已经建了卡的不再出 chip，
 *  它已经以话题行的形式躺在清单里了——两处都显示会让人以为是两个东西 */
export function unstartedSeeds(
  cards: TaskCardDto[],
  stepName: string,
  seeds: string[],
): string[] {
  const started = new Set(
    topicCardsForStep(cards, stepName).map((c) => c.name.trim()),
  );
  return seeds.filter((s) => s.trim() && !started.has(s.trim()));
}

// ===== 人工事项（人机分工 checklist）的纯逻辑 =====

/** 时机 → 白话标签（before/during/after 之外的一律按并行处理，与后端归一口径一致） */
export function humanTimingLabel(timing: string): string {
  switch (timing) {
    case "before":
      return "开始前";
    case "after":
      return "收尾";
    default:
      return "进行中";
  }
}

/** 某步骤未完成的人工事项（卡片 badge / 开工弹层提醒 / 评审收尾提醒共用）。
 *  排除可选事项：它们不做也不影响这一步跑完，计进「N 件待做」会变成一个
 *  永远清不掉的红点，久了整套提醒就没人看了 */
export function pendingHumanTasks(
  states: HumanTaskStateDto[],
  stepName: string,
): HumanTaskStateDto[] {
  return states.filter((s) => s.step === stepName && !s.done && !s.optional);
}

/** 开工弹层提醒口径：开工前（before）事项未完成才提示——进行中/收尾的不挡开工 */
export function blockingHumanTasks(
  states: HumanTaskStateDto[],
  stepName: string,
): HumanTaskStateDto[] {
  return pendingHumanTasks(states, stepName).filter((s) => s.timing === "before");
}

/** 评审提醒口径：收尾（after）事项未完成才提示 */
export function closingHumanTasks(
  states: HumanTaskStateDto[],
  stepName: string,
): HumanTaskStateDto[] {
  return pendingHumanTasks(states, stepName).filter((s) => s.timing === "after");
}
