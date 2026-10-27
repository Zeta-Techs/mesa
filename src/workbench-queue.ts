/**
 * 工作台「等你拍板」队列（2026-10-27，设计稿 docs/design-workbench-mockup.html 第一批）：收件箱条目与待验收目标合成一列，
 * 按「有多挡路」排序；键盘 J/K 移动、回车去处理、A/R 答审批、E 收起通知。纯逻辑，供 node --test 直接测。
 *
 * 行内能直接做的只有两种，其余照旧跳去处理：
 * - 审批：只有旁路能经 CLI 官方通道回复的家（Codex / Qwen / OpenCode，chat-channel.ts approvalChoices）才给允许 / 拒绝；
 *   Claude 这类只有 hooks 的只能在终端菜单里答，行上仍是「去处理」。
 * - 收起：只给信息类（inbox.ts BULK_READABLE），决策类不给，免得把要拍板的事藏掉。
 * 两种都先等几秒才真的送出，期间可撤销（createDeferred）。
 */
import { BULK_READABLE, inboxCategoryOf, type InboxCategory } from "./inbox.ts";
import type { ChannelApproval } from "./chat-channel.ts";

/** blocking = Agent 停着等你或干不下去；decide = 等你看结果；notice = 通知 */
export type QueueTier = "blocking" | "decide" | "notice";

const BLOCKING: ReadonlySet<InboxCategory> = new Set(["confirm", "help", "conflict", "dep", "profile"]);
const NOTICE: ReadonlySet<InboxCategory> = new Set(["lit", "digest", "phone", "skill"]);

export function queueTier(key: string): QueueTier {
  const category = inboxCategoryOf(key);
  if (BLOCKING.has(category)) return "blocking";
  if (NOTICE.has(category)) return "notice";
  return "decide";
}

export const QUEUE_TIER_LABEL: Record<QueueTier, string> = {
  blocking: "停着等你",
  decide: "等你看结果",
  notice: "通知",
};

/** 行内审批：要回复的那一问（旁路快照里的 approval） */
export interface QueueApproval {
  tabId: string;
  requestId: string;
  title: string;
  /** 命令原文 / 要改的文件，一行；没有就不显示 */
  detail: string | null;
  /** 旁路已脱敏的请求，详情不再截断或改写命令。 */
  request: ChannelApproval;
  agent: string;
  /** 标签已知的对话目录，不冒充 CLI 本次请求的 cwd。 */
  conversationCwd: string | null;
  /** 允许 / 拒绝的按钮字（「这次会话都允许」这类不进工作台：要选得细回对话里选） */
  allowLabel: string;
  denyLabel: string;
}

export interface QueueInboxInput {
  key: string;
  dot: string;
  text: string;
  actionLabel: string;
}

export interface QueueReviewInput {
  id: string;
  label: string;
  projectName: string | null;
}

export type QueueRow<I extends QueueInboxInput = QueueInboxInput> =
  | {
      kind: "inbox";
      key: string;
      tier: QueueTier;
      dot: string;
      text: string;
      project: string | null;
      item: I;
      /** 可以行内收起（信息类） */
      dismissible: boolean;
      approval: QueueApproval | null;
    }
  | {
      kind: "review";
      key: string;
      tier: QueueTier;
      dot: string;
      text: string;
      project: string | null;
      taskId: string;
    };

const TIER_ORDER: Record<QueueTier, number> = { blocking: 0, decide: 1, notice: 2 };

/** 收件箱键按 Run 复用；待发送只藏当前这一问，不能把下一问一起藏掉。 */
export function approvalHiddenKey(key: string, requestId: string): string {
  return `${key}\0${requestId}`;
}

/** 合成队列：分档稳定排序（档内保持收件箱原顺序，待验收目标排在本档收件箱条目之后）；hidden 里的键（已处理、等送出的）不出 */
export function buildDecisionQueue<I extends QueueInboxInput>(input: {
  inbox: readonly I[];
  reviews: readonly QueueReviewInput[];
  projectOf: (item: I) => string | null;
  approvals: Readonly<Record<string, QueueApproval>>;
  hidden: ReadonlySet<string>;
}): QueueRow<I>[] {
  const rows: QueueRow<I>[] = [
    ...input.inbox.map((item): QueueRow<I> => ({
      kind: "inbox",
      key: item.key,
      tier: queueTier(item.key),
      dot: item.dot,
      text: item.text,
      project: input.projectOf(item),
      item,
      dismissible: BULK_READABLE.has(inboxCategoryOf(item.key)),
      approval: input.approvals[item.key] ?? null,
    })),
    ...input.reviews.map((task): QueueRow<I> => ({
      kind: "review",
      key: `review:${task.id}`,
      tier: "decide",
      dot: "bg-warn-text",
      text: `${task.label} · 待验收`,
      project: task.projectName,
      taskId: task.id,
    })),
  ];
  return rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => {
      if (input.hidden.has(row.key)) return false;
      if (row.kind !== "inbox") return true;
      return row.approval
        ? !input.hidden.has(approvalHiddenKey(row.key, row.approval.requestId))
        : ![...input.hidden].some((key) => key.startsWith(`${row.key}\0`));
    })
    .sort((a, b) => TIER_ORDER[a.row.tier] - TIER_ORDER[b.row.tier] || a.index - b.index)
    .map(({ row }) => row);
}

export type QueueKeyAction = "next" | "prev" | "open" | "allow" | "deny" | "dismiss";

/** 键盘：只认不带修饰键的单键；当前行做不了的动作返回 null（不吞键） */
export function queueKeyAction(
  event: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean },
  row: QueueRow | null,
): QueueKeyAction | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (key === "j" || key === "ArrowDown") return "next";
  if (key === "k" || key === "ArrowUp") return "prev";
  if (!row) return null;
  if (key === "Enter") return "open";
  const approval = row.kind === "inbox" ? row.approval : null;
  if (key === "a" && approval) return "allow";
  if (key === "r" && approval) return "deny";
  if (key === "e" && row.kind === "inbox" && row.dismissible) return "dismiss";
  return null;
}

/** 选中行按键记：列表变了（处理掉一行、新来一行）仍停在原来那行；那行没了就停在原位置上的下一行 */
export function resolveSelection(
  rows: readonly { key: string }[],
  selectedKey: string | null,
  lastIndex: number,
): number {
  if (rows.length === 0) return -1;
  const at = selectedKey ? rows.findIndex((r) => r.key === selectedKey) : -1;
  if (at >= 0) return at;
  return Math.min(Math.max(lastIndex, 0), rows.length - 1);
}

export function moveSelection(count: number, index: number, delta: 1 | -1): number {
  if (count === 0) return -1;
  if (index < 0) return 0;
  return Math.min(count - 1, Math.max(0, index + delta));
}

/** 已处理（送出或撤销期间）的键：条目从收件箱消失后就不必再记 */
export function pruneHidden(hidden: ReadonlySet<string>, present: readonly string[]): Set<string> {
  const keep = new Set(present);
  return new Set([...hidden].filter((key) => keep.has(key.split("\0")[0])));
}

/** 撤销窗口：处理后先等这么久才真的送出 */
export const QUEUE_UNDO_MS = 5000;

/**
 * 延后执行 + 撤销：schedule 后 delayMs 内 cancel 就不执行。挂在模块上而不是组件里——
 * 点完马上离开工作台，送出照常发生
 */
export function createDeferred(timers: {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}) {
  const pending = new Map<string, unknown>();
  return {
    schedule(id: string, run: () => void, delayMs: number): void {
      const prev = pending.get(id);
      if (prev !== undefined) timers.clear(prev);
      pending.set(
        id,
        timers.set(() => {
          pending.delete(id);
          run();
        }, delayMs),
      );
    },
    /** 撤销：还没送出返回 true */
    cancel(id: string): boolean {
      const handle = pending.get(id);
      if (handle === undefined) return false;
      timers.clear(handle);
      pending.delete(id);
      return true;
    },
    has(id: string): boolean {
      return pending.has(id);
    },
  };
}
