/**
 * 侧栏项目树挂对话的纯逻辑（2026-10-23 用户拍板第一期，tests/sidebar-chats.test.ts）。
 * 口径：对话是唯一的对象，每段对话只归一个文件夹（某个项目或随手聊），侧栏项目树就是这棵树；
 * 点一段对话进运行页能直接写，只看不起进程。这里只算「哪个文件夹列哪几段、各带什么状态点、默认展开谁」。
 */
import type { SessionMetaDto } from "./types";
import { pathKey, pathWithin } from "./path-utils.ts";
import { isScratchCwd } from "./quick-chat.ts";
import { sessionExcludedFromProjectList } from "./session-filter.ts";
import { caretOfAttention, strongestCaret, type RunCaretState } from "./run-caret.ts";

/** 每个文件夹下最多列几段，更早的走「全部 N 条」进对话页 */
export const SIDEBAR_CHAT_LIMIT = 5;

/** 随手聊在展开偏好里的键（项目用 pathKey） */
export const SCRATCH_FOLDER_KEY = "scratch";

/** 自动起名的「MMDD|类型|」前缀（类型闭集见 AGENTS.md 会话标题）：侧栏窄，只留主题，完整标题放悬停 */
const AUTO_TITLE_PREFIX = /^\d{4}\|(?:功能|设计|修复|优化|发布|探索|文档|研究)\|\s*/;

export function sidebarChatTitle(full: string): string {
  const trimmed = full.trim();
  return trimmed.replace(AUTO_TITLE_PREFIX, "").trim() || trimmed;
}

function listable(s: SessionMetaDto): boolean {
  // 源文件不在的接不回也看不了回放，留给对话页（那里有保留下来的快照）
  return s != null && !s.archived && !s.internal && s.alive && !sessionExcludedFromProjectList(s);
}

function byRecent(a: SessionMetaDto, b: SessionMetaDto): number {
  const x = a.updatedAt ?? "";
  const y = b.updatedAt ?? "";
  return x < y ? 1 : x > y ? -1 : 0;
}

/** 某个项目的对话：会话目录就是它，或落在它的工作区 / 工作树里（projectPath 多已归并回主仓，这里兜底），按最近活动倒序 */
export function projectChats(
  sessions: readonly SessionMetaDto[],
  root: string,
  worktrees: readonly string[] = [],
  isWindows = false,
): SessionMetaDto[] {
  const key = pathKey(root, isWindows);
  return sessions
    .filter(
      (s) =>
        listable(s) &&
        (pathKey(s.projectPath, isWindows) === key ||
          worktrees.some((w) => pathWithin(s.projectPath, w, isWindows))),
    )
    .sort(byRecent);
}

/**
 * 置顶的对话（2026-10-24 用户：侧栏「都做」）：常回去的几段钉在树最上面「置顶」一节，跨课题，不再在原课题下重复列。
 * 记本机（同课题置顶，localStorage CHAT_PINS_KEY），键 = agent\nsessionId，顺序 = 置顶的先后。
 * 对话页的「保留」是另一回事（存一份快照防 CLI 清掉），两者不挂钩。
 */
export const CHAT_PINS_KEY = "ccode.sidebarChatPins";

export function parseChatPins(raw: string | null): string[] {
  try {
    const v: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.includes("\n")) : [];
  } catch {
    return [];
  }
}

/** 置顶 / 取消置顶：新置顶的排在最后（同课题置顶） */
export function toggleChatPin(pins: readonly string[], key: string): string[] {
  return pins.includes(key) ? pins.filter((k) => k !== key) : [...pins, key];
}

/** 「置顶」一节列哪几段：按置顶顺序，归档 / 内部 / 源文件不在的不列（同各课题口径） */
export function pinnedChats(sessions: readonly SessionMetaDto[], pins: readonly string[]): SessionMetaDto[] {
  const byKey = new Map(sessions.filter(listable).map((s) => [`${s.agent}\n${s.sessionId}`, s]));
  return pins.map((k) => byKey.get(k)).filter((s): s is SessionMetaDto => s != null);
}

/** 随手聊的对话：`~/ccode/scratch` 里的；随手聊目录被登记成项目后归那个项目，不重复列 */
export function scratchChats(
  sessions: readonly SessionMetaDto[],
  projectPaths: readonly string[],
  isWindows = false,
): SessionMetaDto[] {
  const projects = new Set(projectPaths.filter(Boolean).map((p) => pathKey(p, isWindows)));
  return sessions
    .filter(
      (s) =>
        listable(s) &&
        isScratchCwd(s.projectPath, isWindows) &&
        !projects.has(pathKey(s.projectPath, isWindows)),
    )
    .sort(byRecent);
}

/** 运行页标签的状态镜像里本节要用的几样（RunOverviewInput 的子集） */
export interface ChatRunInput {
  tabId: string;
  agentId: string;
  sessionId?: string | null;
  cwd: string;
  running: boolean;
  shell: boolean;
  attention: "done" | "working" | "confirm" | null;
}

/** 行尾的运行状态光标（run-caret.ts）；null = 没开着 */
export type ChatDot = RunCaretState | null;

/** 对话行的状态：Mesa 里开着它的标签按注意力（等确认 / 干活 / 闲着）；Mesa 外的终端正在写它算在干活 */
export function chatDot(s: SessionMetaDto, runs: readonly ChatRunInput[]): ChatDot {
  const run = runs.find((r) => r.sessionId === s.sessionId && r.agentId === s.agent);
  if (run) {
    if (!run.running || run.shell) return null;
    return caretOfAttention(run.attention);
  }
  return s.live ? "working" : null;
}

/** 文件夹行（收起时也看得见）的状态：这个文件夹里最要紧的那个（等确认 > 干活 > 闲着） */
export function folderDot(
  roots: readonly string[],
  runs: readonly ChatRunInput[],
  isWindows = false,
): ChatDot {
  return strongestCaret(
    runs
      .filter((r) => r.running && !r.shell && roots.some((root) => root && pathWithin(r.cwd, root, isWindows)))
      .map((r) => caretOfAttention(r.attention)),
  );
}

/** 随手聊文件夹的状态（随手聊没有固定根路径，按目录口径认） */
export function scratchDot(runs: readonly ChatRunInput[], isWindows = false): ChatDot {
  return strongestCaret(
    runs
      .filter((r) => r.running && !r.shell && isScratchCwd(r.cwd, isWindows))
      .map((r) => caretOfAttention(r.attention)),
  );
}

/** 正在看的标签落在哪个文件夹：随手聊 → SCRATCH_FOLDER_KEY；否则取包含它的最深一行（工作树归主仓） */
export function currentFolderKey(
  cwd: string | null | undefined,
  folders: readonly { root: string; worktrees: readonly string[] }[],
  projectPaths: readonly string[],
  isWindows = false,
): string | null {
  if (!cwd) return null;
  const registered = projectPaths.some((p) => pathKey(p, isWindows) === pathKey(cwd, isWindows));
  if (isScratchCwd(cwd, isWindows) && !registered) return SCRATCH_FOLDER_KEY;
  let best: { key: string; depth: number } | null = null;
  for (const f of folders) {
    for (const root of [f.root, ...f.worktrees]) {
      if (!root || !pathWithin(cwd, root, isWindows)) continue;
      const depth = pathKey(root, isWindows).length;
      if (!best || depth > best.depth) best = { key: pathKey(f.root, isWindows), depth };
    }
  }
  return best?.key ?? null;
}

/** 文件夹展开没有：人手开关过的按记下的；没碰过的只展开正在聊的那个（不然一棵树全摊开） */
export function folderOpen(
  key: string,
  prefs: Readonly<Record<string, boolean>>,
  currentKey: string | null,
): boolean {
  return prefs[key] ?? key === currentKey;
}

/** 每点一次「展开更多」多列几段 */
export const SIDEBAR_CHAT_STEP = 10;

/** 侧栏里还放得下几行对话：可用高度减去不归对话的部分（节头、「展开更多」行），按对话行高折算 */
export function chatSlots(input: { available: number; fixed: number; rowHeight: number }): number {
  if (input.rowHeight <= 0 || input.available <= 0) return 0;
  return Math.max(0, Math.floor((input.available - input.fixed) / input.rowHeight));
}

/**
 * 各个展开的文件夹列几段（2026-10-23 用户：「查看全部」改「展开更多」，按侧栏空位多展示一些）。
 * counts / extra 按显示顺序（随手聊在前）：每个至少 base 段，点过「展开更多」的再加上 extra；
 * 侧栏还有空位就从上往下补，补到放满为止；都不超过它自己有的段数。
 */
export function chatQuotas(input: {
  counts: readonly number[];
  extra: readonly number[];
  slots: number;
  base?: number;
}): number[] {
  const base = input.base ?? SIDEBAR_CHAT_LIMIT;
  const shown = input.counts.map((c, i) => Math.min(c, base + Math.max(0, input.extra[i] ?? 0)));
  let spare = Math.max(0, Math.floor(input.slots) - shown.reduce((a, b) => a + b, 0));
  for (let i = 0; i < shown.length && spare > 0; i++) {
    const add = Math.min(spare, input.counts[i] - shown[i]);
    shown[i] += add;
    spare -= add;
  }
  return shown;
}

/** 点「展开更多」后这个文件夹要记的 extra：在眼下列着的段数上再多 SIDEBAR_CHAT_STEP 段
 *  （不能只在 extra 上加：空位补出来的那些已经列着，只加 extra 会显得「点了没多几段」） */
export function expandedExtra(shownNow: number, base = SIDEBAR_CHAT_LIMIT): number {
  return Math.max(0, shownNow - base) + SIDEBAR_CHAT_STEP;
}

/** 运行页开着的一个标签（RunOverviewInput 的子集）：侧栏要把列表里还没有的那些也摆出来 */
export interface OpenTabInput extends ChatRunInput {
  title: string;
}

export type OpenTabKind = "new" | "terminal" | "chat";

export interface OpenTabRow {
  tabId: string;
  kind: OpenTabKind;
  label: string;
  dot: ChatDot;
  /** 归哪个文件夹（currentFolderKey 同口径）；null = 不在任何项目、也不是随手聊 */
  folderKey: string | null;
}

/**
 * 运行页标签条撤掉以后（2026-10-24 第二期），开着、但侧栏对话列表里还没有的东西也挂在侧栏：
 * 还没说话的新对话、纯终端、刚起来还没认出会话的 Agent（也写「新对话」，认出来、进了列表就换成那一行）、列表里不列的会话（归档 / 内部）。
 * 已经有对话行的不重复（那一行就是它）；没起进程的只列正看着的那个（别的空白标签切走就收了，列出来只是噪音）。
 */
export function openTabRows(input: {
  runs: readonly OpenTabInput[];
  /** 侧栏已经列着的对话：`agent\nsessionId` */
  listed: ReadonlySet<string>;
  focusedTabId: string | null;
  folderOf: (cwd: string) => string | null;
}): OpenTabRow[] {
  const out: OpenTabRow[] = [];
  for (const r of input.runs) {
    if (r.sessionId && input.listed.has(`${r.agentId}\n${r.sessionId}`)) continue;
    if (!r.running && !r.shell && r.tabId !== input.focusedTabId) continue;
    const kind: OpenTabKind = r.shell ? "terminal" : r.running || r.sessionId ? "chat" : "new";
    const title = r.title.trim();
    const label =
      kind === "new"
        ? "新对话"
        : kind === "terminal"
          ? title && title !== "终端"
            ? title
            : "终端"
          : r.sessionId
            ? title || "对话"
            : "新对话";
    out.push({
      tabId: r.tabId,
      kind,
      label,
      dot: kind === "chat" && r.running ? caretOfAttention(r.attention) : null,
      folderKey: input.folderOf(r.cwd),
    });
  }
  return out;
}

export interface PaletteOpenChat {
  tabId: string;
  kind: OpenTabKind;
  label: string;
  /** 开着的 Agent 的光标；纯终端 / 没起进程的为 null */
  caret: ChatDot;
  cwd: string;
  /** 运行页正看着的那段 */
  current: boolean;
}

/**
 * 命令面板「打开的对话」（2026-10-24 用户：侧栏完全隐藏 / 收成图标时回不到没在跑的对话）：运行页里开着的全部，
 * 不管侧栏有没有列着（侧栏这时看不见）。等你确认的排最前，其次在干活的，其余按开的顺序；正看着的那段沉底（已经在它上面了）。
 * 没起进程的空白新对话只列正看着的那个（同 openTabRows：别的切走就收了）
 */
export function paletteOpenChats(
  runs: readonly OpenTabInput[],
  focusedTabId: string | null,
): PaletteOpenChat[] {
  const rows = openTabRows({ runs, listed: new Set(), focusedTabId, folderOf: () => null });
  const out = rows.map((r) => {
    const run = runs.find((x) => x.tabId === r.tabId)!;
    return {
      tabId: r.tabId,
      kind: r.kind,
      label: r.label,
      caret: r.kind === "chat" && run.running ? caretOfAttention(run.attention) : null,
      cwd: run.cwd,
      current: r.tabId === focusedTabId,
    };
  });
  const rank = (c: PaletteOpenChat) =>
    c.current ? 3 : c.caret === "confirm" ? 0 : c.caret === "working" ? 1 : 2;
  // sort 稳定：同档保持开的顺序
  return out.sort((a, b) => rank(a) - rank(b));
}

/**
 * 侧栏里用键盘走（2026-10-24 用户：侧栏「都做」）：↑↓ 一行、Home / End 到头尾，到头不绕回；
 * 光标不在任何一行上时 ↓ 从第一行起、↑ 从最后一行起。别的键返回 null（不归这里管）
 */
export function railNavIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowDown") return current < 0 ? 0 : Math.min(count - 1, current + 1);
  if (key === "ArrowUp") return current < 0 ? count - 1 : Math.max(0, current - 1);
  return null;
}
