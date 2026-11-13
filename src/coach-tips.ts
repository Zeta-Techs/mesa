/** 一次性悬浮气泡（CoachTip）的登记处与「该不该出」的计数（2026-10-27，侧栏多选起；设计稿 docs/design-rail-multiselect-tip-mockup.html）。
 *  规矩：只在看得出用户正在绕远路时才出（同一件事用鼠标做到第 2 次之类），不在第一次打开时弹；
 *  每条出过就记下、永不再出；用户已经在用对应的快捷键也记下；一次打开 Mesa 最多主动出一条——
 *  followUp（接着上一条、或回应用户自己刚做的动作，如多选的「接着怎么选」）不占这个名额。
 *  计数是纯函数（tests/coach-tips.test.ts）；画法见 components/CoachTip.tsx */

export const COACH_TIP_KEYS = {
  /** 侧栏一段段归档 / 置顶时提醒能多选（多选 B） */
  pickNudge: "ccode.railPickNudgeSeen",
  /** 选上第一段时教怎么接着选（多选 D，followUp） */
  pickNext: "ccode.railPickNextSeen",
  /** 在两段对话之间来回点时提醒 ⌃Tab / Ctrl+Tab */
  switchBack: "ccode.coachSwitchBackSeen",
  /** 用鼠标关对话时提醒 ⌘W / Ctrl+Shift+W */
  closeKey: "ccode.coachCloseKeySeen",
  /** 用右上角 >_ 在聊天和终端之间来回切时提醒快捷键（默认 ⌘⇧T / Ctrl+Shift+T，设置页可改） */
  surfaceKey: "ccode.coachSurfaceKeySeen",
  /** 用量页订阅余量卡第一次有多家、收着时告诉能左右滑动切换（2026-10-31 用户点名要，例外于「不首次即弹」：
   *  收起态不放标签，不提示就没人知道能滑） */
  planSwipe: "ccode.coachPlanSwipeSeen",
  /** 文献雷达第一次有命中、积累还是空的时候，说清接下来怎么做：加入积累 → 下全文 → 精读写笔记
   *  （2026-11-05 用户点名要，例外于「不首次即弹」与「一次打开只出一条」：行内操作平时藏在悬停里，
   *  不提示就不知道命中出来以后该干什么）。点了「加入积累」也算学会 */
  radarNext: "ccode.coachRadarNextSeen",
  /** 写作 / 定稿步骤第一次出现「导入 Word 批注…」（保存过一次以后）时说清它干什么（2026-11-13 用户点名要，例外于
   *  「不首次即弹」与「一次打开只出一条」：按钮名看不出是「稿子发给导师批注完再导回来」）。点了按钮也算学会 */
  wordComments: "ccode.coachWordCommentsSeen",
} as const;
export type CoachTipId = keyof typeof COACH_TIP_KEYS;

// 这次打开 Mesa 已经主动出过一条（模块级，重开 Mesa 归零）
let shownThisLaunch = false;

export function coachTipSeen(id: CoachTipId): boolean {
  try {
    return localStorage.getItem(COACH_TIP_KEYS[id]) === "1";
  } catch {
    return false;
  }
}

/** 记下这条不用再出（出过了，或用户已经会了）；不占这次打开的名额 */
export function markCoachTipSeen(id: CoachTipId) {
  try {
    localStorage.setItem(COACH_TIP_KEYS[id], "1");
  } catch {
    /* 存不下只是下次可能再出一次 */
  }
}

export function canShowCoachTip(id: CoachTipId, followUp = false): boolean {
  return !coachTipSeen(id) && (followUp || !shownThisLaunch);
}

/** 真出了：记下这条，主动出的占掉这次打开的名额 */
export function markCoachTipShown(id: CoachTipId, followUp = false) {
  markCoachTipSeen(id);
  if (!followUp) shownThisLaunch = true;
}

/** 同一件事在 windowMs 里做到第 times 次（用鼠标关对话之类） */
export function noteRepeat(
  prev: readonly number[],
  now: number,
  windowMs: number,
  times = 2,
): { at: number[]; hit: boolean } {
  const at = [...prev.filter((t) => now - t < windowMs), now];
  return { at, hit: at.length >= times };
}
export const CLOSE_KEY_WINDOW_MS = 5 * 60_000;
/** 聊天 ↔ 终端：去、回、再去（点到第 3 下）才算来回切，只看一眼终端不算 */
export const SURFACE_KEY_WINDOW_MS = 5 * 60_000;
export const SURFACE_KEY_TIMES = 3;

export const PICK_NUDGE_WINDOW_MS = 60_000;
export type SingleAct = { kind: "archive" | "pin"; at: number };

/** 对单段做了一次归档 / 置顶：记下来，并判断该不该提醒能多选——1 分钟内同一件事做到第 2 次 */
export function noteSingleAct(
  prev: readonly SingleAct[],
  kind: SingleAct["kind"],
  now: number,
): { acts: SingleAct[]; nudge: boolean } {
  const acts = [...prev.filter((a) => now - a.at < PICK_NUDGE_WINDOW_MS), { kind, at: now }];
  return { acts, nudge: acts.filter((a) => a.kind === kind).length >= 2 };
}

export const SWITCH_BACK_WINDOW_MS = 2 * 60_000;
export type ChatOpen = { key: string; at: number };

/** 在侧栏点开一段对话：记下来；2 分钟内在同两段之间来回点（A → B → A → B）时，other = 刚离开的那段（⌃Tab 回得去的那段）。
 *  再点正看着的那段不算一次 */
export function noteChatOpen(
  prev: readonly ChatOpen[],
  key: string,
  now: number,
): { opens: ChatOpen[]; other: string | null } {
  const live = prev.filter((o) => now - o.at < SWITCH_BACK_WINDOW_MS);
  if (live.length > 0 && live[live.length - 1].key === key) return { opens: live, other: null };
  const opens = [...live, { key, at: now }].slice(-4);
  const [a, b, c, d] = opens.map((o) => o.key);
  const other = opens.length === 4 && a !== b && a === c && b === d ? c : null;
  return { opens, other };
}

/** 「跟 AI 商量一下」引导气泡（2026-11-05 用户点名要，例外于「不首次即弹」与「一次打开只出一条」）：
 *  商量能把人的想法问进任务书、成稿更贴他的判断，所以每个项目第一次走到还没开工、也没商量过的步骤就出；
 *  点了商量、点「先不了」或 × 都记下，这个项目不再出。按项目路径记 */
const DISCUSS_NUDGE_KEY = "ccode.coachDiscussNudgeProjects";
/** 同一个气泡里「请几家研讨（可选）」那一句另记（2026-11-11 用户：第一次同时出现商量和研讨两个按钮时就该提示）：
 *  研讨是后加的，以前关掉的气泡里没有这一句；研讨链接也只在要人拿主意的步骤上有（role 为 you / both，模板里大多数步骤）。
 *  关掉的气泡没带研讨那句时只记商量，到第一个带研讨链接、没开工没商量过的步骤再出一次；在带研讨链接的步骤上关掉两笔都记 */
const CONSULT_NUDGE_KEY = "ccode.coachConsultNudgeProjects";

function nudgeProjects(key: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function markNudgeProject(key: string, projectPath: string) {
  const list = nudgeProjects(key);
  if (list.includes(projectPath)) return;
  try {
    localStorage.setItem(key, JSON.stringify([...list, projectPath].slice(-200)));
  } catch {
    /* 存不下只是下次可能再出一次 */
  }
}

export function discussNudgeSeen(projectPath: string): boolean {
  return nudgeProjects(DISCUSS_NUDGE_KEY).includes(projectPath);
}

export function markDiscussNudgeSeen(projectPath: string) {
  markNudgeProject(DISCUSS_NUDGE_KEY, projectPath);
}

export function consultNudgeSeen(projectPath: string): boolean {
  return nudgeProjects(CONSULT_NUDGE_KEY).includes(projectPath);
}

export function markConsultNudgeSeen(projectPath: string) {
  markNudgeProject(CONSULT_NUDGE_KEY, projectPath);
}
