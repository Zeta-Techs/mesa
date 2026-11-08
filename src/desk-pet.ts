/**
 * 桌宠「小桌」的报信逻辑（2026-11-09 用户拍板「按推荐全部做」；设计稿 docs/design-desk-pet.md）。纯逻辑，配 tests/desk-pet.test.ts。
 * - 等你的事：照搬项目助手「等你的事」（assistant-queue.ts buildDeskItems，手机同一份），不另判
 * - 做完 / 出错：照搬「现在的情况」卡的取数（assistant-brief.ts BriefInput），不另判
 * - 能在桌宠上点的，按 assistant-ops.ts 分级（桌宠与手机同档）；只在桌面的给「去看看」
 * - 说的话都由 Mesa 按记录拼，不经 AI
 * 取数与转达在主窗口（desk-pet-host.ts），桌宠小窗只收这份清单、点按钮回传。
 */
import type { DeskItem } from "./assistant-queue.ts";
import type { BriefInput } from "./assistant-brief.ts";
import type { AssistantAction } from "./project-assistant.ts";
import type { BuddyPose, BuddyProp } from "./buddy-sprite.ts";

/** 桌宠上的一件事。help / question / confirm / trust / blocked / grant 同「等你的事」；review = 做完等你评审 / 验收；failed = 出错 / 没做完 */
export type PetKind = DeskItem["kind"] | "review" | "failed";

/** 在桌宠上能直接点的：reply = 选项或写一句送过去；grant = 放宽重跑一次 / 不用；trust = 替你按信任菜单（只限经项目助手派的活）；null = 只能去看看 */
export type PetTap = "reply" | "grant" | "trust" | null;

export interface PetItem {
  /** 稳定键：比对哪些是新来的、按钮回传都靠它。等你的事沿用 DeskItem.key（手机推送同一键） */
  key: string;
  kind: PetKind;
  projectPath: string;
  projectName: string;
  /** 「第 2 步「精读」」「目标「…」」「工作副本「x」」 */
  where: string;
  /** 一句话，Mesa 按记录拼 */
  text: string;
  detail: string | null;
  options: { key: string; label: string }[];
  recommend: string | null;
  tap: PetTap;
  /** 去看看：跳到哪 */
  open: PetOpen;
}

export type PetOpen =
  | { kind: "assistant"; projectPath: string }
  | { kind: "action"; projectPath: string; action: AssistantAction }
  | { kind: "tab"; projectPath: string; tabId: string };

export interface PetFeed {
  /** 有活在做（步骤或目标在跑、终端里的 AI 在干活） */
  working: boolean;
  items: PetItem[];
}

/** 等你的事 → 桌宠条目（分级同手机：信任菜单只在是你经项目助手派的活时能点） */
export function petItemsFromDesk(project: { path: string; name: string }, desk: readonly DeskItem[]): PetItem[] {
  return desk.map((d) => {
    const tap: PetTap =
      d.kind === "help" || d.kind === "question"
        ? "reply"
        : d.kind === "grant"
          ? "grant"
          : d.kind === "trust" && d.trust?.dispatched
            ? "trust"
            : null;
    const open: PetOpen =
      (d.kind === "confirm" || d.kind === "blocked" || d.kind === "trust") && d.tabId
        ? { kind: "tab", projectPath: project.path, tabId: d.tabId }
        : { kind: "assistant", projectPath: project.path };
    return {
      key: d.key,
      kind: d.kind,
      projectPath: project.path,
      projectName: project.name,
      where: d.where,
      text: d.question,
      detail: d.detail.length ? d.detail.join("；") : null,
      options: d.options.map((o) => ({ key: o.key, label: o.label })),
      recommend: d.recommend,
      tap,
      open,
    };
  });
}

/** 没做完的目标多久以内还提（再早的当作你已经知道了，不在桌宠上一直挂着） */
const FAILED_GOAL_DAYS = 3;

/** 「现在的情况」的取数 → 桌宠条目：步骤做完等评审 / 出错，目标做完等验收 / 没做完。等确认归「等你的事」，这里不重复 */
export function petItemsFromBrief(project: { path: string; name: string }, input: BriefInput, now: Date): PetItem[] {
  const out: PetItem[] = [];
  const base = { projectPath: project.path, projectName: project.name, options: [], recommend: null, tap: null as PetTap };
  for (const s of input.steps) {
    const where = `第 ${s.n} 步「${s.name}」`;
    if (s.state === "failed") {
      out.push({
        ...base,
        key: `step-failed:${s.n}:${s.name}`,
        kind: "failed",
        where,
        text: `${where}出错了`,
        detail: s.failure ?? null,
        open: { kind: "action", projectPath: project.path, action: { kind: "step", step: s.n, text: "", label: `看第 ${s.n} 步` } },
      });
    } else if (s.state === "review") {
      out.push({
        ...base,
        key: `step-review:${s.n}:${s.name}`,
        kind: "review",
        where,
        text: `${where}做完了，等你评审`,
        detail: null,
        open: { kind: "action", projectPath: project.path, action: { kind: "review", step: s.n, text: "", label: `去评审第 ${s.n} 步` } },
      });
    }
  }
  for (const g of input.goals) {
    const where = `目标「${g.name}」`;
    const toProject = { kind: "action" as const, projectPath: project.path, action: { kind: "project" as const, step: null, text: "", label: "去项目页" } };
    if (g.status === "pending_review") {
      out.push({ ...base, key: `goal-review:${g.name}`, kind: "review", where, text: `${where}做完了，等你验收`, detail: null, open: toProject });
    } else if (g.status === "failed" || g.status === "stopped") {
      const age = now.getTime() - Date.parse(g.updatedAt);
      if (Number.isFinite(age) && age <= FAILED_GOAL_DAYS * 86_400_000) {
        out.push({ ...base, key: `goal-failed:${g.name}`, kind: "failed", where, text: `${where}没做完`, detail: null, open: toProject });
      }
    }
  }
  return out.map((i) => ({ ...i, key: `${project.path}|${i.key}` }));
}

/** 「有活在做」：步骤在跑或目标在跑 */
export function briefWorking(input: BriefInput): boolean {
  return input.steps.some((s) => s.state === "working") || input.goals.some((g) => g.status === "running");
}

/** 小桌什么时候冒一句话：important = 有事等你、做完等评审、出错都冒；quiet = 不冒，只换样子和数字 */
export type PetSay = "important" | "quiet";

/** 这一轮新来的（上一轮没有的键）；第一次拿到清单（prev = null）不算新来的，免得一开机就冒一串 */
export function newArrivals(prev: ReadonlySet<string> | null, items: readonly PetItem[]): PetItem[] {
  if (!prev) return [];
  return items.filter((i) => !prev.has(i.key));
}

/** 要冒话的那一件：新来的里挑最要紧的一件（出错 > 等你拍板 > 做完）；quiet 一律不冒 */
export function pickBubble(arrivals: readonly PetItem[], say: PetSay): PetItem | null {
  if (say === "quiet" || arrivals.length === 0) return null;
  const rank = (i: PetItem) => (i.kind === "failed" ? 0 : i.kind === "review" ? 2 : 1);
  return [...arrivals].sort((a, b) => rank(a) - rank(b))[0];
}

/** 冒的那句话：「HER催化综述：第 3 步「精读」做完了，等你评审」；一次来了好几件加「（还有 N 件）」 */
export function bubbleText(item: PetItem, arrivals: number): string {
  const head = item.kind === "help" || item.kind === "question" ? `${item.where}在问你：${item.text}` : item.text;
  const more = arrivals > 1 ? `（还有 ${arrivals - 1} 件）` : "";
  return `${item.projectName}：${head}${more}`;
}

/** 新来的事让小桌做个反应：出错垂头丧气、做完蹦一下，其余不额外动 */
export function arrivalReaction(arrivals: readonly PetItem[]): "oops" | "happy" | null {
  if (arrivals.some((i) => i.kind === "failed")) return "oops";
  if (arrivals.some((i) => i.kind === "review")) return "happy";
  return null;
}

/**
 * 小桌此刻的样子：被拖着走 > 刚来的反应 > 有事等你（等你回）> 有活在做（在想）> 按时间（睡 / 咖啡 / 台灯 / 站着）。
 * 夜深了有事等你照样醒着等。
 */
export function petPose(input: {
  drag: "left" | "right" | null;
  reaction: "oops" | "happy" | null;
  waiting: number;
  working: boolean;
  rest: { pose: "idle" | "sleep"; prop: BuddyProp };
}): { pose: BuddyPose; prop: BuddyProp } {
  if (input.drag) return { pose: input.drag === "left" ? "walkLeft" : "walkRight", prop: null };
  if (input.reaction) return { pose: input.reaction, prop: null };
  if (input.waiting > 0) return { pose: "wait", prop: null };
  if (input.working) return { pose: "think", prop: null };
  return { pose: input.rest.pose, prop: input.rest.pose === "idle" ? input.rest.prop : null };
}

/** 角标数：等你拍板 + 等你评审 + 出错，都算「要你看一眼」 */
export function waitingCount(items: readonly PetItem[]): number {
  return items.length;
}

/** 桌宠里一件事的类别小字（与项目助手「等你的事」同一套叫法） */
export function petKindLabel(kind: PetKind): string {
  switch (kind) {
    case "help":
      return "人工请求";
    case "question":
      return "AI 在对话里问你";
    case "trust":
      return "等你信任文件夹";
    case "blocked":
      return "卡住了";
    case "grant":
      return "要扩大授权";
    case "confirm":
      return "等你确认";
    case "review":
      return "做完了";
    case "failed":
      return "出错了";
  }
}
