/**
 * 「待你处理」收件箱的分类纯逻辑 + 人工请求（help:）的屏蔽/通知判定。
 * 与 DOM/Tauri 解耦（localStorage 薄层除外），供 node --test 直接测。
 * 触发链路：WorkspacesPage 构造条目（key 前缀即类别）；应用更新由
 * visibleInboxItems 现算合并（项目页未挂载时标题栏/工作台仍能看到）。
 * App 标题栏 / 页内 strip 按 groupInbox 分组渲染类别胶囊。
 */
import { NOTIFY_DEBOUNCE_MS } from "./notify.ts";

export type InboxCategory =
  | "conflict"
  | "confirm"
  | "dep"
  | "update"
  | "lit"
  | "ready"
  | "artifacts"
  | "digest"
  | "skill"
  | "profile"
  | "help";

export interface InboxCategoryMeta {
  id: InboxCategory;
  label: string;
}

/** 固定展示顺序（与原 strip 摘要口径一致，confirm: 与 live: 合并为「待确认」；
 *  dep: 依赖缺失紧随「待确认」（git 不在 = 工作区/评审停工，与待确认同级紧迫）；
 *  update: 应用可更新（不阻断干活，但必须能看见）；lit: 文献雷达新命中随后；
 *  help 追加在末尾） */
export const INBOX_CATEGORIES: readonly InboxCategoryMeta[] = [
  { id: "conflict", label: "冲突" },
  { id: "confirm", label: "待确认" },
  { id: "dep", label: "依赖" },
  { id: "update", label: "更新" },
  { id: "lit", label: "文献" },
  { id: "ready", label: "可合并" },
  { id: "artifacts", label: "待核验" },
  { id: "digest", label: "待发送" },
  { id: "skill", label: "技能" },
  { id: "profile", label: "配置失效" },
  { id: "help", label: "人工请求" },
];

/** 从条目 key 前缀推导类别；未知前缀回落待确认（warn 语义），保证新条目不静默丢失 */
export function inboxCategoryOf(key: string): InboxCategory {
  if (key.startsWith("conflict:")) return "conflict";
  if (key.startsWith("confirm:") || key.startsWith("live:")) return "confirm";
  if (key.startsWith("dep:")) return "dep";
  if (key.startsWith("update:")) return "update";
  if (key.startsWith("lit:")) return "lit";
  if (key.startsWith("ready:")) return "ready";
  if (key.startsWith("artifacts:")) return "artifacts";
  if (key.startsWith("digest")) return "digest";
  if (key.startsWith("skill:")) return "skill";
  if (key.startsWith("profile:")) return "profile";
  if (key.startsWith("help:")) return "help";
  return "confirm";
}

export function inboxCategoryLabel(category: InboxCategory): string {
  return INBOX_CATEGORIES.find((meta) => meta.id === category)?.label ?? "待确认";
}

export interface InboxGroup<T> {
  category: InboxCategory;
  label: string;
  items: T[];
}

/** 按类别分组：固定 INBOX_CATEGORIES 顺序，空类不返回；类内保持条目原顺序 */
export function groupInbox<T extends { key: string }>(
  items: readonly T[],
): InboxGroup<T>[] {
  return INBOX_CATEGORIES.map((meta) => ({
    category: meta.id,
    label: meta.label,
    items: items.filter((it) => inboxCategoryOf(it.key) === meta.id),
  })).filter((group) => group.items.length > 0);
}

/** help: 条目屏蔽表的 localStorage 键：{ [root]: 条目签名 } */
export const HELP_DISMISSED_KEY = "ccode.helpDismissed";

/** 通用条目屏蔽表（v3.88）：{ [item.key]: 签名 }。
 *  原先只有 help: 能忽略，其余六类只能干等它自己消失。
 *  签名口径同 help——状态一变签名就变、条目自动复现，所以「忽略」不会真的漏掉事情。 */
export const INBOX_DISMISSED_KEY = "ccode.inboxDismissed";

/** 条目的状态签名：同 key 的内容变化即视为新事件，旧的忽略自动失效 */
export function inboxSignature(item: {
  key: string;
  text: string;
  actionLabel: string;
}): string {
  return `${item.text}|${item.actionLabel}`;
}

/** 过滤掉「已忽略且签名未变」的条目 */
export function filterDismissed<
  T extends { key: string; text: string; actionLabel: string },
>(items: readonly T[], dismissed: Record<string, string>): T[] {
  return items.filter((it) => dismissed[it.key] !== inboxSignature(it));
}

/** 记录忽略并返回新表；写入失败静默（隐私模式） */
export function dismissInboxItem(
  item: { key: string; text: string; actionLabel: string },
  cur: Record<string, string>,
): Record<string, string> {
  const next = { ...cur, [item.key]: inboxSignature(item) };
  try {
    localStorage.setItem(INBOX_DISMISSED_KEY, JSON.stringify(next));
  } catch {
    /* 写不进就只靠本次内存态 */
  }
  return next;
}

export function loadInboxDismissed(): Record<string, string> {
  try {
    return parseHelpDismissed(localStorage.getItem(INBOX_DISMISSED_KEY));
  } catch {
    return {};
  }
}

/** 请求条目签名：文件内容变化（签名不同）时旧屏蔽自动失效、条目复现 */
export function helpSignature(items: readonly string[]): string {
  return items.join("|");
}

/** 命中屏蔽表且签名一致 = 不生成该 help 条目 */
export function isHelpDismissed(
  dismissed: Record<string, string>,
  root: string,
  signature: string,
): boolean {
  return dismissed[root] === signature;
}

/** 解析屏蔽表原文：坏 JSON / 非对象 / 非字符串值一律容错为空表 */
export function parseHelpDismissed(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return {};
    return Object.fromEntries(
      Object.entries(value).filter(([, v]) => typeof v === "string"),
    );
  } catch {
    return {};
  }
}

/** 首条请求预览：截断 max 字，超出加省略号 */
export function helpPreview(text: string, max = 40): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 收件箱任务名：工作区 / 分支优先，标签标题其次，目录尾段兜底。 */
export function inboxTaskLabel(opts: {
  title?: string | null;
  cwdLabel?: string | null;
  workspaceName?: string | null;
  branch?: string | null;
}): string {
  const named = opts.workspaceName?.trim() || opts.branch?.trim();
  if (named) return named;
  const title = opts.title?.trim();
  if (title && title !== "终端") return title;
  return opts.cwdLabel?.trim() || "这项工作";
}

/** 收件箱主文案：和「项目现在」同一句式——名字紧贴状态，不写「去」。 */
export function inboxTaskLine(taskLabel: string, action: string): string {
  const label = taskLabel.trim() || "这项工作";
  return `${label}${action.trim()}`;
}

/**
 * 人工请求新来源判定（edge-trigger）：next 中存在而 prev 中不存在的 key，
 * 且距上次通知该 key 已满去抖窗口（同 root 30 秒内最多一条）。
 * prev 为 null = 基线未建立（首轮刷新），一律不通知，防启动误报。
 */
export function helpNotifyKeys(
  prev: ReadonlySet<string> | null,
  next: readonly string[],
  lastSentAt: ReadonlyMap<string, number>,
  now: number,
  windowMs: number = NOTIFY_DEBOUNCE_MS,
): string[] {
  if (prev === null) return [];
  return next.filter((key) => {
    if (prev.has(key)) return false;
    const last = lastSentAt.get(key);
    return last === undefined || now - last >= windowMs;
  });
}

// ---- localStorage 薄层（以下依赖 DOM，不进 node 测试） ----

export function loadHelpDismissed(): Record<string, string> {
  try {
    return parseHelpDismissed(localStorage.getItem(HELP_DISMISSED_KEY));
  } catch {
    return {};
  }
}

/** 记录屏蔽（root + 当前签名）并返回新表；写入失败静默（隐私模式等） */
export function dismissHelp(
  root: string,
  signature: string,
): Record<string, string> {
  const next = { ...loadHelpDismissed(), [root]: signature };
  try {
    localStorage.setItem(HELP_DISMISSED_KEY, JSON.stringify(next));
  } catch {
    /* 写不进就只靠本次内存态 */
  }
  return next;
}
