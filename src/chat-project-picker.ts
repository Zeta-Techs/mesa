/**
 * 聊天输入框的项目选择弹层（docs/design-chat-composer-mockup.html ①，2026-10-22）纯逻辑：
 * 原先是通用右键菜单（只列 6 个、不能搜、看不出项目类型）。现在顶上能搜，列表按最近活动排，
 * 每行带项目类型（科研 / 编程 / 办公）与项目默认的 Agent；随手聊、主目录固定在下面。
 */
import { samePath } from "./path-utils.ts";
import { normalizeWorkMode, type WorkMode } from "./work-mode.ts";

export interface PickerProject {
  path: string;
  name: string;
  workMode?: string | null;
  defaultAgent?: string | null;
  lastOpenedAt?: string | null;
}

export interface PickerRow {
  path: string;
  label: string;
  workMode: WorkMode;
  defaultAgent: string | null;
  current: boolean;
}

export interface PickerFixedRow {
  kind: "scratch" | "home";
  path: string;
  label: string;
  current: boolean;
}

/** 不搜时列几个最近的；搜的时候最多列几个 */
export const PICKER_RECENT = 6;
export const PICKER_SEARCH = 12;

function expandHome(cwd: string, home: string): string {
  const raw = cwd.trim();
  const base = home.replace(/[\\/]+$/, "");
  if (!raw || raw === "~") return home;
  return raw.startsWith("~") && base ? `${base}${raw.slice(1)}` : raw;
}

export function pickerRows(input: {
  projects: readonly PickerProject[];
  recentRepos?: readonly { path: string; name?: string; lastActive?: string | null }[];
  cwd: string;
  home: string;
  query: string;
  isWindows?: boolean;
}): { rows: PickerRow[]; fixed: PickerFixedRow[] } {
  const isWindows = input.isWindows ?? false;
  const current = expandHome(input.cwd, input.home);
  const q = input.query.trim().toLowerCase();
  const recent = input.recentRepos ?? [];
  const lastOf = (p: PickerProject) =>
    recent.find((r) => samePath(r.path, p.path, isWindows))?.lastActive || p.lastOpenedAt || "";
  const labelOf = (p: PickerProject) =>
    recent.find((r) => samePath(r.path, p.path, isWindows))?.name?.trim() ||
    p.name.trim() ||
    p.path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ||
    p.path;
  const matches = (p: PickerProject) => {
    if (!q) return true;
    const tail = p.path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
    return labelOf(p).toLowerCase().includes(q) || tail.toLowerCase().includes(q);
  };
  const rows = [...input.projects]
    .filter(matches)
    .sort((a, b) => (lastOf(b) > lastOf(a) ? 1 : lastOf(b) < lastOf(a) ? -1 : 0))
    .slice(0, q ? PICKER_SEARCH : PICKER_RECENT)
    .map((p) => ({
      path: p.path,
      label: labelOf(p),
      workMode: normalizeWorkMode(p.workMode),
      defaultAgent: p.defaultAgent?.trim() || null,
      current: samePath(p.path, current, isWindows),
    }));
  const sep = isWindows ? "\\" : "/";
  const base = input.home.replace(/[\\/]+$/, "");
  const scratch = `${base}${sep}ccode${sep}scratch`;
  const fixed: PickerFixedRow[] = [
    { kind: "scratch" as const, path: scratch, label: "随手聊", current: samePath(scratch, current, isWindows) },
    { kind: "home" as const, path: input.home, label: "主目录", current: samePath(input.home, current, isWindows) },
  ].filter((f) => !q || f.label.includes(input.query.trim()));
  return { rows, fixed: input.home ? fixed : [] };
}
