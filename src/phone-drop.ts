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
  /** 二维码里用的主机：电脑名（xxx.local）或 IP */
  host: string;
  label: string;
}

export interface PhoneDropStatus {
  /** 主动接收中（有二维码、可配新手机） */
  receiving: boolean;
  /** 常驻等候中：没在主动接收，但已配对的手机随时能发 */
  standby: boolean;
  /** 「Mesa 开着就随时接收已配对的手机」开关 */
  standbyEnabled: boolean;
  connected: boolean;
  /** 扫码配对地址（二维码内容） */
  url: string | null;
  qrSvg: string | null;
  host: string | null;
  addresses: PhoneAddr[];
  received: number;
  /** 最近连上的已配对手机 */
  lastDevice: string | null;
  /** 固定端口被占、这次临时换了端口 */
  portNote: string | null;
}

export const IDLE_PHONE_STATUS: PhoneDropStatus = {
  receiving: false,
  standby: false,
  standbyEnabled: true,
  connected: false,
  url: null,
  qrSvg: null,
  host: null,
  addresses: [],
  received: 0,
  lastDevice: null,
  portNote: null,
};

/** 已配对的手机（记住这台手机，2026-10-21） */
export interface PhoneDevice {
  id: string;
  name: string;
  pairedAt: string;
  lastSeenAt: string | null;
}

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

/** 放进去的位置写到文件夹为止（notes/assets/phone-20261021-092945.jpg → notes/assets/）；
 *  文件名短的（notes/clips.md）整条写，完整路径放悬停 */
export function phonePlacedLabel(placedTo: string): string {
  const cut = placedTo.lastIndexOf("/");
  if (cut < 0) return placedTo;
  const base = placedTo.slice(cut + 1);
  return base.length <= 12 ? placedTo : placedTo.slice(0, cut + 1);
}

/** 能点开看：文字就地展开；有文件的走预览弹窗（图片 / PDF / 表格 / 文档在 Mesa 里看，
 *  HEIC 这类看不了的在弹窗里给「用系统应用打开」） */
export function phoneItemOpenable(item: Pick<PhoneItem, "kind" | "path">): boolean {
  return item.kind === "text" || Boolean(item.path);
}

export function phoneItemStatusText(item: Pick<PhoneItem, "status" | "placedTo">): string {
  switch (item.status) {
    case "attached":
      return "已附到输入框";
    case "placed":
      return item.placedTo ? `已放进 ${phonePlacedLabel(item.placedTo)}` : "已放进项目";
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
export function phoneStateLine(
  status: PhoneDropStatus,
  incoming: string | null,
  hasDevices = false,
): string {
  if (!status.receiving) return "没有在接收";
  if (incoming) return `正在接收 ${incoming}…`;
  if (status.connected) {
    const who = status.lastDevice ? `${status.lastDevice} 已连上` : "手机已连上";
    return status.received > 0 ? `${who} · 已收 ${status.received} 条` : who;
  }
  return hasDevices ? "等手机打开「发到 Mesa」…" : "等手机扫码…";
}

/** 已配对时状态卡的两行：标题 + 说明（主动接收 / 常驻等候 / 都没开） */
export function phonePairedCard(
  status: PhoneDropStatus,
  incoming: string | null,
): { title: string; hint: string; live: boolean } {
  if (status.receiving) {
    return {
      title: phoneStateLine(status, incoming, true),
      hint: "在手机上点主屏的「发到 Mesa」就能发，不用扫码。",
      live: status.connected,
    };
  }
  if (status.standby) {
    if (incoming) return { title: `正在接收 ${incoming}…`, hint: "", live: true };
    return {
      title: status.connected ? `${status.lastDevice ?? "手机"} 已连上` : "手机随时能发",
      hint: "手机点主屏的「发到 Mesa」就能发，不用先在这里点开始。",
      live: status.connected,
    };
  }
  return {
    title: "没在接收",
    hint: "「随时接收」关着：要发，先点「开始接收」。",
    live: false,
  };
}

/** 已配对手机的一行说明：上次用过的时间（今天只写时刻） */
export function phoneDeviceLine(device: Pick<PhoneDevice, "pairedAt" | "lastSeenAt">, now: Date): string {
  const at = (iso: string | null) => {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const pad = (n: number) => String(n).padStart(2, "0");
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return d.toDateString() === now.toDateString() ? `今天 ${hm}` : `${d.getMonth() + 1}月${d.getDate()}日`;
  };
  const seen = at(device.lastSeenAt);
  if (seen) return `上次用 ${seen}`;
  const paired = at(device.pairedAt);
  return paired ? `${paired} 配对` : "";
}

/** 自动停止的原因（手动停止不提示） */
export function phoneStopNote(reason: string | null | undefined): string | null {
  if (reason === "idle") return "30 分钟没有收到新东西，已停止从手机接收";
  if (reason === "error") return "接收出错，已停止从手机接收";
  return null;
}
