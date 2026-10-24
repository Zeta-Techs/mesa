/**
 * 对话页筛选纯逻辑（v3.88）。
 *
 * 背景：`SessionMetaDto` 里早就有 stepName / taskName / workspace / live / pinned /
 * updatedAt 这些维度，**一个都没进筛选 UI**；唯一做进 UI 的 agent 维度恰恰最低频
 * （用户按项目、按时间、按状态找，不按 agent 找）。这里补上高频的状态/时间快筛，
 * 以及把搜索框升级成「输入 → 结构化建议 → 落成可叠加 chip」。
 *
 * 与 DOM/Tauri 解耦，node --test 直接测。
 */
import { pathKey } from "./path-utils.ts";
import { isScratchCwd } from "./quick-chat.ts";
import type { SessionMetaDto } from "./types";

/** 一行 chip 快筛的 id（互不排斥，可与作用域 chip 叠加） */
export type QuickFilterId =
  | "pinned"
  | "live"
  | "today"
  | "week"
  | "internal"
  | "archived";

export interface QuickFilterDef {
  id: QuickFilterId;
  label: string;
  title: string;
}

/** 固定展示顺序：状态在前、时间居中、范围在后 */
export const QUICK_FILTERS: readonly QuickFilterDef[] = [
  { id: "pinned", label: "保留", title: "只看已保留（pin）的对话" },
  { id: "live", label: "进行中", title: "只看仍在运行的会话" },
  { id: "today", label: "今天", title: "今天有更新的对话" },
  { id: "week", label: "近 7 天", title: "近 7 天有更新的对话" },
  { id: "internal", label: "内部 AI", title: "只看 Mesa 内部 AI 的会话" },
  { id: "archived", label: "已归档", title: "把已归档的对话也列出来" },
];

/** 作用域筛选：搜索建议点选后落成的 chip，可叠加 */
export interface ScopeChip {
  kind: "project" | "step" | "task" | "agent" | "day";
  /** 匹配值（projectPath / stepName / taskName / agent id / 本机时区日期 YYYY-MM-DD） */
  value: string;
  /** 展示用短标签 */
  label: string;
}

function dayStart(offsetDays: number, now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime() - offsetDays * 86_400_000;
}

/** 会话的时间戳（updatedAt 优先，回落 createdAt）；都没有返回 null */
export function sessionTime(s: SessionMetaDto): number | null {
  const raw = s.updatedAt ?? s.createdAt;
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

/** 会话归属的本机时区日期键 YYYY-MM-DD（day chip 匹配用；按最近更新时间归日） */
export function sessionDayKey(s: SessionMetaDto): string | null {
  const t = sessionTime(s);
  if (t === null) return null;
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/**
 * 应用快筛 + 作用域 chip。
 *
 * 口径要点：
 * - `archived` 是**放宽**（把归档的也列出来），不是「只看归档」——与既有「显示已归档」开关同义；
 *   没勾时一律排除归档项。
 * - `internal` 是**收窄**（只看内部 AI）；没勾时排除内部会话，与既有列表口径一致。
 * - `today` / `week` 同时勾选取并集里更宽的那个（week 覆盖 today）。
 * - 作用域 chip 之间**同类取或、异类取与**：两个项目 chip = 这两个项目里的；
 *   项目 chip + 步骤 chip = 该项目里该步骤的。
 */
export function applySessionFilters(
  sessions: readonly SessionMetaDto[],
  quick: ReadonlySet<QuickFilterId>,
  scopes: readonly ScopeChip[],
  liveKeys: ReadonlySet<string>,
  now: number = Date.now(),
): SessionMetaDto[] {
  const cutoff = quick.has("week")
    ? dayStart(6, now)
    : quick.has("today")
      ? dayStart(0, now)
      : null;
  const byKind = new Map<ScopeChip["kind"], string[]>();
  for (const c of scopes) {
    const list = byKind.get(c.kind) ?? [];
    list.push(c.value);
    byKind.set(c.kind, list);
  }
  return sessions.filter((s) => {
    if (!quick.has("archived") && s.archived) return false;
    if (quick.has("internal") ? !s.internal : s.internal) return false;
    if (quick.has("pinned") && !s.pinned) return false;
    if (quick.has("live") && !s.live && !liveKeys.has(`${s.agent}\n${s.sessionId}`))
      return false;
    if (cutoff !== null) {
      const t = sessionTime(s);
      if (t === null || t < cutoff) return false;
    }
    for (const [kind, values] of byKind) {
      const hit = values.some((v) => {
        if (kind === "project") return s.projectPath === v;
        if (kind === "step") return s.stepName === v;
        if (kind === "task") return s.taskName === v;
        if (kind === "day") return sessionDayKey(s) === v;
        return s.agent === v;
      });
      if (!hit) return false;
    }
    return true;
  });
}

/** 搜索时把已归档也放进来；未搜索仍排除（除非快筛已开归档）。左侧分类计数不走这条。 */
export function sessionFilterQuickForSearch(
  quick: ReadonlySet<QuickFilterId>,
  searching: boolean,
): ReadonlySet<QuickFilterId> {
  if (!searching || quick.has("archived")) return quick;
  const next = new Set(quick);
  next.add("archived");
  return next;
}

export const SEARCH_ARCHIVED_HEADER = "已归档";

/** 搜索命中：未归档在前，已归档沉底并挂组头。 */
export function groupSearchHitsByArchive<T extends { archived: boolean }>(
  sessions: readonly T[],
): { header: string | null; s: T }[] {
  const active: T[] = [];
  const archived: T[] = [];
  for (const s of sessions) {
    if (s.archived) archived.push(s);
    else active.push(s);
  }
  return [
    ...active.map((s) => ({ header: null as string | null, s })),
    ...archived.map((s, i) => ({
      header: i === 0 ? SEARCH_ARCHIVED_HEADER : null,
      s,
    })),
  ];
}

/**
 * 搜索建议：从当前会话集里提取匹配查询的结构化维度，点选即落成 chip。
 * 取代原先「展开手风琴 → 找 agent → 展开 → 找项目」的三次点击钻取。
 * 每类最多 `perKind` 条，避免下拉过长。
 */
export function buildScopeSuggestions(
  sessions: readonly SessionMetaDto[],
  query: string,
  perKind = 4,
): ScopeChip[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const seen = new Set<string>();
  const out: ScopeChip[] = [];
  const push = (kind: ScopeChip["kind"], value: string, label: string) => {
    const v = value.trim();
    if (!v || !v.toLowerCase().includes(q)) return;
    const key = `${kind}:${v}`;
    if (seen.has(key)) return;
    if (out.filter((c) => c.kind === kind).length >= perKind) return;
    seen.add(key);
    out.push({ kind, value: v, label });
  };
  // 顺序 = 用户找东西的常见顺序：项目 → 步骤 → 卡片 → agent
  for (const s of sessions) push("project", s.projectPath, baseName(s.projectPath));
  for (const s of sessions) push("step", s.stepName ?? "", s.stepName ?? "");
  for (const s of sessions) push("task", s.taskName ?? "", s.taskName ?? "");
  for (const s of sessions) push("agent", s.agent, s.agent);
  return out;
}

/** 路径末段（项目名展示用；与其余页面 pathBaseName 同口径） */
export function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 对话列表 meta 行的「哪个项目」：已添加项目用注册名，随手聊目录写「随手聊」，
 *  其余目录用末段。范围已限定到单个项目时调用方不显示（同一事实不重复）。 */
export function sessionProjectLabel(
  projectPath: string,
  names: ReadonlyMap<string, string>,
  isWindows = false,
): string | null {
  if (!projectPath.trim()) return null;
  // 会话文件没记工作目录时，后端退回 Claude 存会话的目录名（路径里非字母数字都换成 -，有损）：
  // 不是路径就别当路径显示（曾出现「-Users-tongzhouho…」），按同一规则编码已添加项目去对，唯一对上才写名
  if (!/[\\/]/.test(projectPath)) {
    const hits = [...names].filter(
      ([path, name]) => name.trim() && claudeProjectDirName(path) === projectPath,
    );
    return hits.length === 1 ? hits[0][1].trim() : null;
  }
  const key = pathKey(projectPath, isWindows);
  for (const [path, name] of names) {
    if (pathKey(path, isWindows) === key && name.trim()) return name.trim();
  }
  if (isScratchCwd(projectPath, isWindows)) return "随手聊";
  return baseName(projectPath) || null;
}

/** Claude Code 存会话的目录名：绝对路径去掉末尾分隔后，每个非 ASCII 字母数字的字符换成 `-`
 *  （`/Users/me/测试项目` → `-Users-me-----`；Windows `C:\\x` → `C--x`） */
export function claudeProjectDirName(path: string): string {
  return path.replace(/[\\/]+$/, "").replace(/[^A-Za-z0-9]/g, "-");
}

/** Mesa 无头 AI 的临时 cwd 名：`ccode-ai-<uuid>`（与 ai.rs 命名同步）。 */
const CCODE_AI_TEMP_RE =
  /^ccode-ai-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 是否为 Mesa 自建的无头 AI 临时目录。
 * 用量统计仍只认 provenance；对话页范围用它把已过期登记的临时目录从「项目」里拿开。
 */
export function isCcodeAiTempCwd(path: string): boolean {
  return CCODE_AI_TEMP_RE.test(baseName(path));
}

/**
 * 无头调用写进 CLI 会话文件后，标题就是那段 prompt 的前 60 字。
 * 雷达解读 / 定时巡检跑在项目目录时，靠这些句子从「本项目会话」拿开。
 */
export const HEADLESS_TITLE_HINTS = [
  "你是科研文献快筛助手",
  "请用中文解读下面这篇文献",
  "技能执行一次文献巡检",
  "技能在项目内执行一次定时巡检",
  "本任务由 Mesa 定时雷达自动触发",
] as const;

function titleLooksHeadless(
  title: string | null | undefined,
  customTitle: string | null | undefined,
): boolean {
  const hay = `${customTitle ?? ""} ${title ?? ""}`;
  return HEADLESS_TITLE_HINTS.some((h) => hay.includes(h));
}

/** 对话列表是否按内部 AI 归并：后端标记、临时 cwd、无头来源、或雷达/解读 prompt 标题。 */
export function sessionLooksInternal(s: {
  internal?: boolean;
  source?: string;
  projectPath: string;
  title?: string | null;
  customTitle?: string | null;
}): boolean {
  if (s.internal) return true;
  if (s.source === "ccode-ai") return true;
  if (isCcodeAiTempCwd(s.projectPath)) return true;
  return titleLooksHeadless(s.title, s.customTitle);
}

/**
 * 本项目会话再排除 Mesa 按钮拉起的交互会话（问 AI / 沉浸阅读注入）。
 * 这些仍是普通项目对话，对话页（搜对话）照常列出，不进「内部 AI」；侧栏项目树、工作台、任务卡都按这一份筛。
 * 接力简报（`.ccode/handoff-`，在一步里换 Agent 接着做）2026-10-24 移出本表（用户：「其他按推荐改」）——
 * 那是这一步的正式工作，原先随项目页「对话」页签的口径一起藏掉，侧栏挂对话之后就找不到了。
 */
export const PROJECT_SESSION_EXCLUDE_HINTS = [
  "看这份文件",
  "【阅读上下文】",
] as const;

export function sessionExcludedFromProjectList(s: {
  internal?: boolean;
  source?: string;
  projectPath: string;
  title?: string | null;
  customTitle?: string | null;
}): boolean {
  if (sessionLooksInternal(s)) return true;
  const hay = `${s.customTitle ?? ""} ${s.title ?? ""}`;
  return PROJECT_SESSION_EXCLUDE_HINTS.some((h) => hay.includes(h));
}

export interface ProjectGroup {
  /** 组内第一条会话的原始路径（显示/回写用，不拿 pathKey） */
  path: string;
  list: SessionMetaDto[];
}

function latestStamp(list: readonly SessionMetaDto[]): string {
  let max = "";
  for (const s of list) {
    const t = s.updatedAt ?? s.createdAt ?? "";
    if (t > max) max = t;
  }
  return max;
}

/**
 * 跨 Agent 按项目路径分组（对话页「范围 → 按项目」）。
 * 比较键走 pathKey（Windows 折叠大小写、剥 verbatim）；空路径不进组。
 */
export function groupSessionsByProjectPath(
  sessions: readonly SessionMetaDto[],
  isWindows = false,
): ProjectGroup[] {
  const byKey = new Map<string, ProjectGroup>();
  for (const s of sessions) {
    const p = s.projectPath?.trim();
    if (!p || sessionLooksInternal(s)) continue;
    const key = pathKey(p, isWindows);
    const g = byKey.get(key);
    if (g) g.list.push(s);
    else byKey.set(key, { path: p, list: [s] });
  }
  return [...byKey.values()].sort((a, b) =>
    latestStamp(b.list).localeCompare(latestStamp(a.list)),
  );
}

export const SCOPE_KIND_LABEL: Record<ScopeChip["kind"], string> = {
  project: "项目",
  step: "步骤",
  task: "卡片",
  agent: "Agent",
  day: "日期",
};

/** 对话页「范围」里的一行目录（项目 / 其他目录）。 */
export interface ScopeDirRow {
  path: string;
  label: string;
  count: number;
}

/**
 * 「范围」选择面的目录分段（2026-10-17 重排）：已添加项目用注册名在上，其余目录（家目录、
 * tmp、没添加的仓库）收进「其他目录」；随手聊目录不在这里（它有自己的一行）。
 * 原来一张「按项目」表把 backend-admin（已添加，注册名「后端管理」）和 tongzhouhong（家目录）、
 * tmp 混排，且组头计数是「项目个数」与别处「对话条数」口径不一。
 */
export function scopeDirRows(
  groups: readonly ProjectGroup[],
  projectNames: ReadonlyMap<string, string>,
  home: string,
  isWindows = false,
): { projects: ScopeDirRow[]; others: ScopeDirRow[] } {
  const projects: ScopeDirRow[] = [];
  const others: ScopeDirRow[] = [];
  const homeKey = home.trim() ? pathKey(home, isWindows) : null;
  for (const g of groups) {
    if (isScratchCwd(g.path, isWindows)) continue;
    const key = pathKey(g.path, isWindows);
    let registered: string | null = null;
    for (const [path, name] of projectNames) {
      if (pathKey(path, isWindows) === key) {
        registered = name.trim() || baseName(path);
        break;
      }
    }
    if (registered) {
      projects.push({ path: g.path, label: registered, count: g.list.length });
    } else {
      others.push({
        path: g.path,
        label: homeKey && key === homeKey ? "主目录" : baseName(g.path),
        count: g.list.length,
      });
    }
  }
  // groups 已按最近活动降序，两段沿用
  return { projects, others };
}
