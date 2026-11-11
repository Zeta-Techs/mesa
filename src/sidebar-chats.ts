/**
 * 侧栏项目树挂对话的纯逻辑（2026-10-23 用户拍板第一期，tests/sidebar-chats.test.ts）。
 * 口径：对话是唯一的对象，每段对话只归一个文件夹（某个项目或随手聊），侧栏项目树就是这棵树；
 * 点一段对话进运行页能直接写，只看不起进程。这里只算「哪个文件夹列哪几段、各带什么状态点、默认展开谁」。
 */
import type { SessionMetaDto } from "./types";
import { pathKey, pathWithin } from "./path-utils.ts";
import { isScratchCwd } from "./quick-chat.ts";
import { sessionExcludedFromProjectList } from "./session-filter.ts";
import { caretOfAttention, strongestCaret, withUnread, type RunCaretState } from "./run-caret.ts";
import { unreadKeyOf } from "./chat-unread.ts";
import { tidySessionTitle } from "./session-title.ts";
import { roundCauseLabel, type RoundCause } from "./step-loop.ts";

/** 每个文件夹下最多列几段，更早的走「全部 N 条」进对话页 */
export const SIDEBAR_CHAT_LIMIT = 5;

/** 随手聊在展开偏好里的键（项目用 pathKey） */
export const SCRATCH_FOLDER_KEY = "scratch";

/** 自动起名的「MMDD|类型|」前缀（类型闭集见 AGENTS.md 会话标题）：侧栏窄，只留主题，完整标题放悬停 */
const AUTO_TITLE_PREFIX = /^\d{4}\|(?:功能|设计|修复|优化|发布|探索|文档|研究)\|\s*/;

/** 去掉项目名后剩下的至少这么多字才去（再短就看不出是哪件事了） */
const FOLDER_PREFIX_MIN_REST = 4;

/** 侧栏短标题。给了所在文件夹名（挂在某个课题下时）再去掉开头重复的课题名：流程步骤的对话起名时带着项目背景，
 *  常写成「测试项目综述大纲…」，挂在「测试项目」下面这几个字是重复的，还把后半截挤出侧栏（2026-10-26）。
 *  只改显示，完整标题照旧放悬停 */
export function sidebarChatTitle(full: string, folderName?: string): string {
  const trimmed = full.trim();
  const short = trimmed.replace(AUTO_TITLE_PREFIX, "").trim() || trimmed;
  const folder = folderName?.trim() ?? "";
  if ([...folder].length < 2 || !short.toLowerCase().startsWith(folder.toLowerCase())) return short;
  const rest = short.slice(folder.length).replace(/^[\s·:：|｜\-—_，,、]+/, "");
  return [...rest].length >= FOLDER_PREFIX_MIN_REST ? rest : short;
}

function listable(s: SessionMetaDto): boolean {
  // 源文件不在的接不回也看不了回放，留给对话页（那里有保留下来的快照）
  return s != null && !s.archived && !s.internal && s.alive && !sessionExcludedFromProjectList(s);
}

/** 课题 / 随手聊下面列不列：没起名、也没说过一句话的空对话不占侧栏（2026-10-26 用户：随手聊被「未命名对话」占满），
 *  对话页照列。正开着的照列（openKeys = `agent\nsessionId`）：只说了句「你好」的新对话起不出标题，
 *  不列就一直是只有 × 的标签行、没有 ⋯（2026-11-01 用户）。置顶是人手钉的，不走这条 */
function listedInFolder(s: SessionMetaDto, openKeys: ReadonlySet<string>): boolean {
  return listable(s) && (!tidySessionTitle(s).unnamed || openKeys.has(`${s.agent}\n${s.sessionId}`));
}

/** 精读对话在项目菜单打开后照列：只看还在、没归档（统一排除表本来就把它们挡在外面，listable 不适用） */
function readerListable(s: SessionMetaDto): boolean {
  return !!s.reader && !s.archived && !s.internal && s.alive;
}

function byRecent(a: SessionMetaDto, b: SessionMetaDto): number {
  const x = a.updatedAt ?? "";
  const y = b.updatedAt ?? "";
  return x < y ? 1 : x > y ? -1 : 0;
}

/** 某个项目的对话：会话目录就是它，或落在它的工作区 / 工作树里（projectPath 多已归并回主仓，这里兜底），按最近活动倒序。
 *  精读对话（沉浸阅读区派的，一篇一段）默认不列：多了把课题下面挤乱，回去接着读走文献的「继续精读」；
 *  项目菜单「显示精读对话」打开后照列（showReader，2026-11-06 用户） */
export function projectChats(
  sessions: readonly SessionMetaDto[],
  root: string,
  worktrees: readonly string[] = [],
  isWindows = false,
  openKeys: ReadonlySet<string> = new Set(),
  showReader = false,
): SessionMetaDto[] {
  const key = pathKey(root, isWindows);
  return sessions
    .filter(
      (s) =>
        (s.reader ? showReader && readerListable(s) : listedInFolder(s, openKeys)) &&
        (pathKey(s.projectPath, isWindows) === key ||
          worktrees.some((w) => pathWithin(s.projectPath, w, isWindows))),
    )
    .sort(byRecent);
}

/** 哪些课题在侧栏列出精读对话（项目菜单「显示精读对话」，2026-11-06）：本机 localStorage，存课题的 pathKey */
export const READER_CHATS_SHOWN_KEY = "ccode.projectShowReaderChats";

export function parseReaderChatsShown(raw: string | null): string[] {
  try {
    const v: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];
  } catch {
    return [];
  }
}

export function toggleReaderChatsShown(shown: readonly string[], folderKey: string): string[] {
  return shown.includes(folderKey) ? shown.filter((k) => k !== folderKey) : [...shown, folderKey];
}

/** 某个课题有没有精读对话（项目菜单有这一项才出开关） */
export function hasReaderChats(
  sessions: readonly SessionMetaDto[],
  root: string,
  isWindows = false,
): boolean {
  const key = pathKey(root, isWindows);
  return sessions.some((s) => readerListable(s) && pathKey(s.projectPath, isWindows) === key);
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

/** 多选里几段一起置顶 / 取消置顶（2026-10-27）：有没钉的就把没钉的按点选顺序接在后面；全都钉着才一起取消 */
export function pinPicked(pins: readonly string[], picked: readonly string[]): string[] {
  const missing = picked.filter((k) => !pins.includes(k));
  if (missing.length > 0) return [...pins, ...missing];
  const drop = new Set(picked);
  return pins.filter((k) => !drop.has(k));
}

/** 侧栏多选（2026-10-27）：⌘（Windows 上 Ctrl）点一行 = 加进 / 拿出；⇧ 点 = 从起点到这一行整段换上（同访达）。
 *  order 是侧栏里眼下列着的对话从上到下；起点不在里面就只选这一行 */
export function nextPicked(
  prev: ReadonlySet<string>,
  order: readonly string[],
  key: string,
  anchor: string | null,
  mode: "toggle" | "range",
): Set<string> {
  if (mode === "toggle") {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  }
  const a = anchor == null ? -1 : order.indexOf(anchor);
  const b = order.indexOf(key);
  if (a < 0 || b < 0) return new Set([key]);
  return new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1));
}

/** 多选提醒（coach-tips.ts noteSingleAct）贴哪一行：刚处理的那段在侧栏里的下一段（没有就上一段），就是接下来最可能要处理的那段 */
export function nudgeAnchor(order: readonly string[], key: string): string | null {
  const i = order.indexOf(key);
  if (i < 0) return null;
  return order[i + 1] ?? order[i - 1] ?? null;
}

/**
 * 项目内置顶（2026-11-05 用户：科研流程发起的检索 / 精读 / 大纲对话要一直留在项目下面随时接着聊，不被新对话挤进「显示更多」）。
 * 流程步骤的对话（stepName 非空）自动置顶，人手取消的记 dropped；别的项目对话人手置顶记 pinned。
 * 键 = agent\nsessionId（全局唯一，不分项目存）；与树最上面跨课题的「置顶」（CHAT_PINS_KEY）是两回事，钉到那里的不在项目下重复列。
 */
export const PROJECT_CHAT_PINS_KEY = "ccode.projectChatPins";

export interface ProjectChatPins {
  pinned: string[];
  dropped: string[];
}

export function parseProjectChatPins(raw: string | null): ProjectChatPins {
  const keys = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.includes("\n")) : [];
  try {
    const v = JSON.parse(raw ?? "{}") as { pinned?: unknown; dropped?: unknown } | null;
    return { pinned: keys(v?.pinned), dropped: keys(v?.dropped) };
  } catch {
    return { pinned: [], dropped: [] };
  }
}

/** 这段眼下在不在项目内置顶里 */
export function isProjectPinned(s: SessionMetaDto, pins: ProjectChatPins): boolean {
  const key = `${s.agent}\n${s.sessionId}`;
  return s.stepName ? !pins.dropped.includes(key) : pins.pinned.includes(key);
}

/** 在项目里置顶 / 取消：流程对话改 dropped，其余改 pinned（新置顶的排在最后） */
export function toggleProjectChatPin(pins: ProjectChatPins, s: SessionMetaDto): ProjectChatPins {
  const key = `${s.agent}\n${s.sessionId}`;
  const on = isProjectPinned(s, pins);
  const pinned = pins.pinned.filter((k) => k !== key);
  const dropped = pins.dropped.filter((k) => k !== key);
  if (s.stepName) return { pinned, dropped: on ? [...dropped, key] : dropped };
  return { pinned: on ? pinned : [...pinned, key], dropped };
}

/** 一个项目的对话（projectChats 的输出，最近在前）拆成项目内置顶与其余：
 *  置顶里流程对话在前、按开工先后（就是流程顺序），人手置顶的跟在后面、按置顶先后；其余保持原顺序 */
export function splitProjectPinned(
  chats: readonly SessionMetaDto[],
  pins: ProjectChatPins,
): { pinned: SessionMetaDto[]; rest: SessionMetaDto[] } {
  const steps: SessionMetaDto[] = [];
  const manual: SessionMetaDto[] = [];
  const rest: SessionMetaDto[] = [];
  for (const s of chats) {
    if (!isProjectPinned(s, pins)) rest.push(s);
    else (s.stepName ? steps : manual).push(s);
  }
  steps.sort((a, b) => {
    const x = a.createdAt ?? a.updatedAt ?? "";
    const y = b.createdAt ?? b.updatedAt ?? "";
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const order = new Map(pins.pinned.map((k, i) => [k, i]));
  manual.sort((a, b) => order.get(`${a.agent}\n${a.sessionId}`)! - order.get(`${b.agent}\n${b.sessionId}`)!);
  return { pinned: [...steps, ...manual], rest };
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
  openKeys: ReadonlySet<string> = new Set(),
): SessionMetaDto[] {
  const projects = new Set(projectPaths.filter(Boolean).map((p) => pathKey(p, isWindows)));
  return sessions
    .filter(
      (s) =>
        listedInFolder(s, openKeys) &&
        isScratchCwd(s.projectPath, isWindows) &&
        !projects.has(pathKey(s.projectPath, isWindows)),
    )
    .sort(byRecent);
}

/**
 * 分叉出来的对话挂在原对话下面（2026-10-31 用户照 Claude 客户端侧栏）。认两种来路：CLI 自己的真分叉（forkedFrom，
 * Claude 续链里分出去的那条）和 Mesa 的「从这里分叉 / 分叉成新对话」（同一家的接力，handoffFrom*）；跨家接力不算分叉。
 * 返回原对话的 `agent\nsessionId`，不是分叉的返回 null
 */
export function forkParentKey(s: SessionMetaDto): string | null {
  if (s.forkedFrom) return `${s.agent}\n${s.forkedFrom}`;
  if (s.handoffFromSession && s.handoffFromAgent === s.agent) return `${s.agent}\n${s.handoffFromSession}`;
  return null;
}

export interface ForkRow {
  s: SessionMetaDto;
  /** 0 = 顶格；1 起是分叉，分叉的分叉再深一层 */
  depth: number;
  /** 底下挂着几段（含分叉的分叉）；0 = 没有分叉，不给开合箭头 */
  forks: number;
}

/**
 * 一个文件夹里的对话按分叉挂好（输入按最近活动倒序）：分叉紧跟在原对话下面，原对话不在这份列表里的照常顶格；
 * 一家子排在其中最近动过的那一段的位置（分叉刚聊过，原对话跟着往上走），同一层仍按最近活动
 */
export function nestForks(chats: readonly SessionMetaDto[]): ForkRow[] {
  const keyOf = (s: SessionMetaDto) => `${s.agent}\n${s.sessionId}`;
  const byKey = new Map(chats.map((s) => [keyOf(s), s]));
  const parentOf = (s: SessionMetaDto): string | null => {
    const p = forkParentKey(s);
    return p && p !== keyOf(s) && byKey.has(p) ? p : null;
  };
  // 绕回自己的（数据坏了才会有）当顶格，不然整串都挂不出来
  const inCycle = (s: SessionMetaDto) => {
    const seen = new Set([keyOf(s)]);
    for (let p = parentOf(s); p; p = parentOf(byKey.get(p)!)) {
      if (seen.has(p)) return true;
      seen.add(p);
    }
    return false;
  };
  const kids = new Map<string, SessionMetaDto[]>();
  const roots: SessionMetaDto[] = [];
  for (const s of chats) {
    const p = inCycle(s) ? null : parentOf(s);
    if (p) kids.set(p, [...(kids.get(p) ?? []), s]);
    else roots.push(s);
  }
  const index = new Map(chats.map((s, i) => [keyOf(s), i]));
  const rank = new Map<string, number>();
  const size = new Map<string, number>();
  const measure = (s: SessionMetaDto): number => {
    const k = keyOf(s);
    let r = index.get(k)!;
    let n = 0;
    for (const c of kids.get(k) ?? []) {
      r = Math.min(r, measure(c));
      n += 1 + size.get(keyOf(c))!;
    }
    rank.set(k, r);
    size.set(k, n);
    return r;
  };
  roots.forEach(measure);
  const byRank = (a: SessionMetaDto, b: SessionMetaDto) => rank.get(keyOf(a))! - rank.get(keyOf(b))!;
  const out: ForkRow[] = [];
  const walk = (s: SessionMetaDto, depth: number) => {
    out.push({ s, depth, forks: size.get(keyOf(s))! });
    for (const c of [...(kids.get(keyOf(s)) ?? [])].sort(byRank)) walk(c, depth + 1);
  };
  for (const r of [...roots].sort(byRank)) walk(r, 0);
  return out;
}

/** 收起分叉的那几段底下的不列；keep（正看着的那段）被收在里面时照样列出来，不然侧栏里找不到「现在在哪」 */
export function foldForks(rows: readonly ForkRow[], folded: ReadonlySet<string>, keep: string | null = null): ForkRow[] {
  const out: ForkRow[] = [];
  let hideBelow: number | null = null;
  for (const r of rows) {
    if (hideBelow != null && r.depth <= hideBelow) hideBelow = null;
    const key = `${r.s.agent}\n${r.s.sessionId}`;
    if (hideBelow != null) {
      if (key === keep) out.push(r);
      continue;
    }
    out.push(r);
    if (r.forks > 0 && folded.has(key)) hideBelow = r.depth;
  }
  return out;
}

/** 收起了分叉的对话记在本机（键同置顶） */
export const FORK_FOLDS_KEY = "ccode.sidebarForkFolds";

/** 随手聊「归档 N 天没动的」默认天数 */
export const SCRATCH_STALE_DAYS = 7;

/** 随手聊里多少天没动的对话（节头 ⋯ 一键归档用，2026-10-26）：连侧栏不列的空对话一起算；
 *  外面还在跑的、Mesa 里开着的、不知道什么时候动过的都不算。调用方先剔掉置顶的 */
export function staleScratchChats(
  sessions: readonly SessionMetaDto[],
  projectPaths: readonly string[],
  openKeys: ReadonlySet<string>,
  nowMs: number,
  days = SCRATCH_STALE_DAYS,
  isWindows = false,
): SessionMetaDto[] {
  const projects = new Set(projectPaths.filter(Boolean).map((p) => pathKey(p, isWindows)));
  const cutoff = nowMs - days * 86_400_000;
  return sessions.filter((s) => {
    if (!listable(s) || s.live || openKeys.has(`${s.agent}\n${s.sessionId}`)) return false;
    if (!isScratchCwd(s.projectPath, isWindows) || projects.has(pathKey(s.projectPath, isWindows))) return false;
    const at = s.updatedAt ? Date.parse(s.updatedAt) : NaN;
    return Number.isFinite(at) && at < cutoff;
  });
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
  /** 分叉标签的原会话 id（run-overview forkOf） */
  forkOf?: string | null;
}

/** 行尾的运行状态光标（run-caret.ts）；null = 没开着 */
export type ChatDot = RunCaretState | null;

/** 对话行的状态：Mesa 里开着它的标签按注意力（等确认 / 干活 / 闲着）；Mesa 外的终端正在写它、这一轮还没收尾算在干活（后端 live：闲着补写元数据不算） */
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
  /** 开聊复用键：`reader:` 开头的是精读区的标签 */
  reuseKey?: string;
}

export type OpenTabKind = "new" | "terminal" | "chat";

export interface OpenTabRow {
  tabId: string;
  kind: OpenTabKind;
  label: string;
  dot: ChatDot;
  /** 归哪个文件夹（currentFolderKey 同口径）；null = 不在任何项目、也不是随手聊 */
  folderKey: string | null;
  /** 分叉标签还没认出新会话时挂在哪段对话下面（`agent\nsessionId`）；不是分叉为 null */
  forkParentKey: string | null;
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
  /** 这个文件夹列不列精读对话（showReader 同口径）；不给 = 都列。精读区开着时它的标签也不挂出来 */
  showReader?: (folderKey: string | null) => boolean;
}): OpenTabRow[] {
  const out: OpenTabRow[] = [];
  for (const r of input.runs) {
    if (r.sessionId && input.listed.has(`${r.agentId}\n${r.sessionId}`)) continue;
    const reader = (r.reuseKey ?? "").startsWith("reader:");
    if (reader && input.showReader && !input.showReader(input.folderOf(r.cwd))) continue;
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
          : r.sessionId || r.forkOf
            ? title || "对话"
            : "新对话";
    out.push({
      tabId: r.tabId,
      kind,
      label,
      dot: kind === "chat" && r.running ? caretOfAttention(r.attention) : null,
      folderKey: input.folderOf(r.cwd),
      forkParentKey: r.forkOf ? `${r.agentId}\n${r.forkOf}` : null,
    });
  }
  return out;
}

export interface PaletteOpenChat {
  tabId: string;
  kind: OpenTabKind;
  /** 同侧栏：去掉「MMDD|类型|」只留主题 */
  label: string;
  /** 完整标题（搜索、悬停用） */
  fullTitle: string;
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
  /** 跑完了没看的（chat-unread.ts 的键）：光标换成蓝色，排在等确认之后 */
  unread: ReadonlySet<string> = new Set(),
): PaletteOpenChat[] {
  const rows = openTabRows({ runs, listed: new Set(), focusedTabId, folderOf: () => null });
  const out = rows.map((r) => {
    const run = runs.find((x) => x.tabId === r.tabId)!;
    return {
      tabId: r.tabId,
      kind: r.kind,
      label: r.kind === "chat" ? sidebarChatTitle(r.label) : r.label,
      fullTitle: r.label,
      caret: withUnread(
        r.kind === "chat" && run.running ? caretOfAttention(run.attention) : null,
        r.tabId !== focusedTabId && unread.has(unreadKeyOf(run)),
      ),
      cwd: run.cwd,
      current: r.tabId === focusedTabId,
    };
  });
  const rank = (c: PaletteOpenChat) =>
    c.current ? 4 : c.caret === "confirm" ? 0 : c.caret === "unread" ? 1 : c.caret === "working" ? 2 : 3;
  // sort 稳定：同档保持开的顺序
  return out.sort((a, b) => rank(a) - rank(b));
}

/** 灵动岛对话下拉「最近对话」最多列几段 */
export const RECENT_CHAT_LIMIT = 8;

/**
 * 灵动岛对话下拉的「最近对话」（2026-10-30 用户：下拉里不该是「对话管理」入口，而是最近对话）：
 * 侧栏收着时回到没开着的对话。口径同侧栏能列的（listable：未归档、非内部、源文件在），
 * 已经在「打开的对话」里的不重复，按最后活动新到旧
 */
export function recentChats(
  sessions: readonly SessionMetaDto[],
  runs: readonly ChatRunInput[],
  limit = RECENT_CHAT_LIMIT,
): SessionMetaDto[] {
  const open = new Set(runs.filter((r) => r.sessionId).map((r) => `${r.agentId}\n${r.sessionId}`));
  return sessions
    .filter((s) => listable(s) && !open.has(`${s.agent}\n${s.sessionId}`))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, limit);
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

// ===== 流程对话按步骤分组（2026-11-10 用户拍板：长标题 + 行尾步骤名一窄就截断、分路几段认不出是第几路）=====

/** 一行流程对话：label = 侧栏写的角色名（商量任务书 / 执行任务书 / 第 k 路 / 收尾 / 补料轮、跟进轮…）；null = 认不出角色或人改过名，照旧写标题 */
export interface StepChatRow {
  row: ForkRow;
  label: string | null;
  done: boolean;
}

export interface StepChatGroup {
  /** 分组键：步骤名 */
  step: string;
  /** 第几步（1 起）；档案卡里已经没有这一步时为 null，排最后 */
  index: number | null;
  /** 分路外、开分路之前的行：商量在前，其余按开的先后 */
  rows: StepChatRow[];
  /** 分路子组：各路按路号，收尾放最后；没开过分路为 null */
  lanes: { rows: StepChatRow[]; total: number; done: number } | null;
  /** 分路之后才开的行（补料轮、跟进轮…），画在分路子组下面，保持先后顺序 */
  after: StepChatRow[];
}

// 「执行任务书」与「商量任务书」成对（2026-11-10 用户：「名字叫干活太草率了吧」）
const ROLE_NAME: Record<string, string> = { discuss: "商量任务书", work: "执行任务书", merge: "收尾" };

function mmdd(at: string | null | undefined): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(at ?? "");
  return m ? `${m[1]}-${m[2]}` : "";
}

const ROUND_CAUSES = new Set<string>(["rework", "followup", "fresh", "comments", "catchup"]);

/** 一段流程对话在侧栏写什么：人改过名的照写（null），分路写「第 k 路」，开轮开的写起因（同「这一步的几轮」：补料轮 / 跟进轮…），
 *  其余按角色；认不出的 null（2026-11-10 用户：解冲突后的跟进轮写成第二个「收尾」，「名字还叫收尾吗」） */
export function stepRoleLabel(s: SessionMetaDto): string | null {
  if (s.titleByUser) return null;
  if (s.stepRole === "lane") return s.laneNo ? `第 ${s.laneNo} 路` : null;
  if (s.stepRole === "round") return s.roundKind && ROUND_CAUSES.has(s.roundKind) ? roundCauseLabel(s.roundKind as RoundCause) : null;
  return (s.stepRole && ROLE_NAME[s.stepRole]) || null;
}

/** 项目内置顶里的流程对话按步骤分组（输入：splitProjectPinned 的 pinned 套上 ForkRow）；没有步骤名的（人手钉的）原样留在 manual。
 *  同一步里同一种角色不止一段（退回后重写、商量了两回）的，各自后面接开的日期「 · MM-DD」 */
export function groupStepChats(rows: readonly ForkRow[]): { groups: StepChatGroup[]; manual: ForkRow[] } {
  const byStep = new Map<string, ForkRow[]>();
  const manual: ForkRow[] = [];
  for (const r of rows) {
    const step = r.s.stepName;
    if (!step) {
      manual.push(r);
      continue;
    }
    byStep.set(step, [...(byStep.get(step) ?? []), r]);
  }
  const created = (r: ForkRow) => r.s.createdAt ?? r.s.updatedAt ?? "";
  const groups: StepChatGroup[] = [];
  for (const [step, list] of byStep) {
    const lanesRaw = list.filter((r) => r.s.stepRole === "lane" && r.s.laneNo);
    const merges = lanesRaw.length > 0 ? list.filter((r) => r.s.stepRole === "merge") : [];
    const rest = list.filter((r) => !lanesRaw.includes(r) && !merges.includes(r));
    const roleCount = new Map<string, number>();
    for (const r of rest) {
      const l = stepRoleLabel(r.s);
      if (l) roleCount.set(l, (roleCount.get(l) ?? 0) + 1);
    }
    const toRow = (r: ForkRow): StepChatRow => {
      const l = stepRoleLabel(r.s);
      const dated = l && (roleCount.get(l) ?? 0) > 1 && mmdd(created(r)) ? `${l} · ${mmdd(created(r))}` : l;
      return { row: r, label: dated, done: r.s.stepRole === "lane" && Boolean(r.s.laneDone) };
    };
    const order = (r: ForkRow) => (r.s.stepRole === "discuss" ? 0 : 1);
    rest.sort((a, b) => order(a) - order(b) || (created(a) < created(b) ? -1 : created(a) > created(b) ? 1 : 0));
    lanesRaw.sort((a, b) => (a.s.laneNo ?? 0) - (b.s.laneNo ?? 0) || (created(a) < created(b) ? -1 : 1));
    const laneNos = new Set(lanesRaw.map((r) => r.s.laneNo));
    const doneNos = new Set(lanesRaw.filter((r) => r.s.laneDone).map((r) => r.s.laneNo));
    const index = list.map((r) => r.s.stepIndex).find((i): i is number => typeof i === "number") ?? null;
    // 分路之后开的（补料轮、跟进轮…）画在分路子组下面，不然排在「分 N 路」上面，先后颠倒
    const firstLane = lanesRaw.length > 0 ? lanesRaw.map(created).sort()[0] : null;
    const isAfter = (r: ForkRow) => firstLane !== null && r.s.stepRole !== "discuss" && created(r) > firstLane;
    groups.push({
      step,
      index,
      rows: rest.filter((r) => !isAfter(r)).map(toRow),
      after: rest.filter(isAfter).map(toRow),
      lanes:
        lanesRaw.length > 0
          ? { rows: [...lanesRaw, ...merges].map(toRow), total: laneNos.size, done: doneNos.size }
          : null,
    });
  }
  groups.sort((a, b) => (a.index ?? 1e9) - (b.index ?? 1e9) || a.step.localeCompare(b.step));
  return { groups, manual };
}

/** 圈号：1–20 用 ①…⑳，再往后写数字 */
export function circledIndex(n: number | null): string {
  if (n == null) return "";
  return n >= 1 && n <= 20 ? String.fromCodePoint(0x2460 + n - 1) : `${n}.`;
}

/** 步骤组的默认开合：看着的那段或在跑的那段所在的组开着；都没有时开最近动过的那一组 */
export function defaultOpenStep(
  groups: readonly StepChatGroup[],
  isHot: (s: SessionMetaDto) => boolean,
): string | null {
  const all = (g: StepChatGroup) => [...g.rows, ...(g.lanes?.rows ?? []), ...g.after].map((r) => r.row.s);
  const hot = groups.find((g) => all(g).some(isHot));
  if (hot) return hot.step;
  let best: { step: string; at: string } | null = null;
  for (const g of groups) {
    for (const s of all(g)) {
      const at = s.updatedAt ?? s.createdAt ?? "";
      if (!best || at > best.at) best = { step: g.step, at };
    }
  }
  return best?.step ?? null;
}
