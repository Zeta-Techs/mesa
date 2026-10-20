/**
 * 「从手机添加」纯逻辑（docs/design-phone-drop.md；后端 phone_drop.rs）。
 * 与 DOM/Tauri 解耦，供 node --test 直接测：条目能做什么、放进哪个项目、状态与收件箱文案。
 */
import { pathWithin } from "./path-utils.ts";
import { normalizeWorkMode } from "./work-mode.ts";

export type PhoneItemKind = "image" | "pdf" | "file" | "text";
/** new 还没处理 / attached 附到了对话 / placed 放进了项目 / saved 另存了 */
export type PhoneItemStatus = "new" | "attached" | "placed" | "saved";

export interface PhoneItem {
  id: string;
  kind: PhoneItemKind;
  /** 原名（清洗过）；文字条目是第一行摘要 */
  name: string;
  /** 暂存文件绝对路径；文字条目为 null */
  path: string | null;
  text: string | null;
  size: number;
  receivedAt: string;
  status: PhoneItemStatus;
  placedTo: string | null;
}

export interface PhoneAddr {
  ip: string;
  label: string;
}

export interface PhoneDropStatus {
  receiving: boolean;
  connected: boolean;
  url: string | null;
  qrSvg: string | null;
  address: string | null;
  addresses: PhoneAddr[];
  received: number;
}

export const IDLE_PHONE_STATUS: PhoneDropStatus = {
  receiving: false,
  connected: false,
  url: null,
  qrSvg: null,
  address: null,
  addresses: [],
  received: 0,
};

export type PhoneAction = "attach" | "place" | "saveAs" | "copy" | "delete";

/** 放进项目各自的落点（与 phone_drop.rs place_into 同口径） */
export const PHONE_PLACE_TARGET: Record<Exclude<PhoneItemKind, "file">, string> = {
  pdf: "papers/",
  image: "notes/assets/",
  text: "notes/clips.md",
};

/**
 * 一条能做什么。canAttach：从对话输入框打开（有目标输入框）；canPlace：有可放的科研 / 办公项目。
 * 其他文件不给「放进项目」——放到项目里不被豁免的位置会让主仓变脏、挡住工作区合并。
 */
export function phoneItemActions(
  item: Pick<PhoneItem, "kind" | "status">,
  ctx: { canAttach: boolean; canPlace: boolean },
): PhoneAction[] {
  const out: PhoneAction[] = [];
  if (ctx.canAttach && item.status !== "attached") out.push("attach");
  if (ctx.canPlace && item.kind !== "file" && item.status !== "placed") out.push("place");
  out.push(item.kind === "text" ? "copy" : "saveAs");
  out.push("delete");
  return out;
}

export function phoneItemStatusText(item: Pick<PhoneItem, "status" | "placedTo">): string {
  switch (item.status) {
    case "attached":
      return "已附到输入框";
    case "placed":
      return item.placedTo ? `已放进 ${item.placedTo}` : "已放进项目";
    case "saved":
      return "已另存";
    default:
      return "";
  }
}

export function phonePendingCount(items: readonly Pick<PhoneItem, "status">[]): number {
  return items.filter((it) => it.status === "new").length;
}

/** 收件箱「手机」条目：签名含条数，条数变了被忽略过的也会再出现 */
export function phoneInboxFields(pending: number): { key: string; text: string } | null {
  if (pending <= 0) return null;
  return { key: "phone:pending", text: `手机发来 ${pending} 条还没处理` };
}

/**
 * 「放进项目」默认哪个项目：对话工作目录所在的科研 / 办公项目（最长匹配，同「存进笔记」）；
 * 不在项目里就取最近打开的那个（list_projects 已按最近打开排序）。编程项目不放。
 */
export function pickPlaceProject(
  projects: readonly { path: string; workMode?: string }[],
  cwd: string | null,
  isWindows = false,
): string | null {
  const eligible = placeableProjects(projects);
  if (cwd) {
    const owner = eligible
      .filter((p) => pathWithin(cwd, p.path, isWindows))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (owner) return owner.path;
  }
  return eligible[0]?.path ?? null;
}

export function placeableProjects<T extends { workMode?: string }>(projects: readonly T[]): T[] {
  return projects.filter((p) => normalizeWorkMode(p.workMode) !== "coding");
}

export function formatPhoneSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 弹层状态行 */
export function phoneStateLine(status: PhoneDropStatus, incoming: string | null): string {
  if (!status.receiving) return "没有在接收";
  if (incoming) return `正在接收 ${incoming}…`;
  if (status.connected) return status.received > 0 ? `手机已连上 · 已收 ${status.received} 条` : "手机已连上";
  return "等手机扫码…";
}

/** 自动停止的原因（手动停止不提示） */
export function phoneStopNote(reason: string | null | undefined): string | null {
  if (reason === "idle") return "30 分钟没有收到新东西，已停止从手机接收";
  if (reason === "error") return "接收出错，已停止从手机接收";
  return null;
}
