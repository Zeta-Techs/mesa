/** 综述回路二期（docs/design-review-loop.md §4–§6，2026-11-05 拍板）的纯逻辑：
 *  补料轮 / 跟进轮的开场指令、精读跟进的增量篇目、轮次起因的说法、可退回的上游步骤。
 *  引擎不认识「检索」「综述」：哪一步算检索、算精读由调用方按技能槽判定后传进来（isSearch / isNotes）。 */

import { KEEP_WORKING_CLAUSE } from "./step-decisions.ts";
import { sectionTableRows } from "./notes-progress.ts";

export interface ReworkDraft {
  fromStep: string;
  toStep: string;
  toWorkspaceId: string;
  toWorkspaceName: string;
  topics: string[];
  reason: string;
  clues: string;
  scale: number | null;
}

export interface ReworkDto extends ReworkDraft {
  id: string;
  sentAt: string;
  relPath: string;
}

export type RoundCause = "first" | "rework" | "followup" | "fresh" | "manual";

export interface StepRoundDto {
  index: number;
  savedAt: string;
  cause: RoundCause;
  rework: ReworkDto | null;
  sha: string;
  paths: string[];
}

export interface StepRoundsDto {
  rounds: StepRoundDto[];
  openCause: RoundCause | null;
  openRework: ReworkDto | null;
}

export interface FollowupScopeDto {
  behind: number;
  files: string[];
}

export interface RoundTextDto {
  text: string;
  truncated: boolean;
}

/** 补料单从表单文字拆出主题：一行一条，去掉行首的 -、*、序号 */
export function parseTopics(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.、)）])\s*/, "").trim())
    .filter(Boolean);
}

/** 补料轮的开场指令：补料单原文写进去（不靠 AI 去读项目根的文件），只补单上的。 */
export function reworkPrompt(
  rework: Pick<ReworkDto, "fromStep" | "topics" | "reason" | "clues" | "scale" | "relPath">,
  opts: { isSearch: boolean; projectRoot: string; date: string },
): string {
  const lines = [
    `这是一轮补料：「${rework.fromStep}」退回来的，只补下面列的，不重做整步。`,
    "要补：",
    ...rework.topics.map((t, i) => `${i + 1}. ${t}`),
    `为什么：${rework.reason}`,
  ];
  if (rework.clues.trim()) lines.push(`线索：${rework.clues.trim()}`);
  if (rework.scale) lines.push(`规模：这次大致不超过 ${rework.scale} 篇。`);
  lines.push(
    "先读 TASK.md 的完成标准和决策暂停策略，它们照旧有效。",
    opts.isSearch
      ? "已纳入、已判定的文献不重筛、不改判定；新找到的按原纳入标准筛，纳入的追加进 papers/included.json，再按技能跑 lit_records.py write 重出清单。" +
          `在 papers/screening.md 末尾追加「## 补料轮（${opts.date}）」一节：补了什么、检索式、候选数与纳入数、没拿到全文的原因。`
      : "在本步已有产物上追加或修改，人确认过的内容不推翻；" +
          `在本步主要报告末尾追加「## 补料轮（${opts.date}）」一节，写清补了什么、改了哪些文件。`,
    `补料单原件：${joinRoot(opts.projectRoot, rework.relPath)}。`,
    KEEP_WORKING_CLAUSE,
  );
  return lines.join("\n");
}

function joinRoot(root: string, rel: string): string {
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${sep}${sep === "\\" ? rel.replace(/\//g, "\\") : rel}`;
}

/** 精读跟进的增量：纳入里**索引还没有这一行**的 id（上游新加的篇）。索引里记了 pending 的不算——
 *  那是有意留待按章节读的研究论文（综述精读第一轮只读综述 + 核心篇，三期）或缺全文的篇，跟进不顺带把它们全读了。
 *  读不懂的 JSON 返回 null（界面改按文件列表说）。 */
export function notesFollowupIds(includedText: string, indexText: string | null): string[] | null {
  let included: unknown;
  try {
    included = JSON.parse(includedText);
  } catch {
    return null;
  }
  const rows = recordsOf(included);
  if (!rows) return null;
  const listed = new Set<string>();
  if (indexText) {
    try {
      for (const row of recordsOf(JSON.parse(indexText)) ?? []) {
        const r = row as Record<string, unknown>;
        if (typeof r.id === "string") listed.add(r.id);
      }
    } catch {
      /* 索引坏了：当成都没写，增量 = 全部纳入，由人在确认框里看到数字再决定 */
    }
  }
  const out: string[] = [];
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    const decision = typeof r.decision === "string" ? r.decision.trim().toLowerCase() : "";
    if (decision !== "included" && decision !== "include") continue;
    if (typeof r.id === "string" && !listed.has(r.id)) out.push(r.id);
  }
  return out;
}

function recordsOf(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    for (const key of ["records", "items", "papers", "entries", "notes"]) {
      const value = (parsed as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value;
    }
  }
  return null;
}

/** 跟进只看课题产物：Mesa 自己的过程文件、积累台账不算「上游新增」 */
export function followupFiles(files: string[]): string[] {
  return files.filter(
    (f) =>
      !f.startsWith(".ccode/") &&
      f !== "papers/reading-list.md" &&
      f !== "notes/inbox.md" &&
      !f.startsWith("papers/watch-"),
  );
}

const ID_CAP = 40;
const FILE_CAP = 30;

/** 跟进轮的开场指令。notesIds 非 null = 精读步：只给这些篇写笔记；否则按改动文件说。 */
export function followupPrompt(opts: {
  upstream: string;
  notesIds: string[] | null;
  files: string[];
}): string {
  const head = `上游「${opts.upstream}」保存过新内容，这一轮只跟进新增的部分，不重做整步。项目里的新内容已经并进本工作区。`;
  if (opts.notesIds) {
    const shown = opts.notesIds.slice(0, ID_CAP).join("、");
    const more = opts.notesIds.length > ID_CAP ? ` 等 ${opts.notesIds.length} 篇（以 papers/included.json 为准）` : "";
    return [
      head,
      `纳入清单里新加了 ${opts.notesIds.length} 篇，笔记索引里还没有：${shown}${more}。`,
      "只给这些篇写笔记，写法照 TASK.md 与技能（先跑 lit_records.py write 认 PDF）；已有笔记一字不动。",
      "收尾更新 notes/index.json、references.bib 与 notes/handoff.md。",
      KEEP_WORKING_CLAUSE,
    ].join("\n");
  }
  const shown = opts.files.slice(0, FILE_CAP).map((f) => `- ${f}`);
  if (opts.files.length > FILE_CAP) shown.push(`- …另有 ${opts.files.length - FILE_CAP} 个`);
  return [
    head,
    "这些文件在本步上次保存之后改过：",
    ...shown,
    "先读这些改动，只修改受它们影响的部分；人确认过的内容不推翻。在本步主要产物末尾追加「## 本轮改了什么」一节，逐条写改了哪里、因为上游哪处变化。",
    KEEP_WORKING_CLAUSE,
  ].join("\n");
}

/** 跟进确认框里的一句规模话 */
export function followupScale(opts: { upstream: string; notesIds: string[] | null; files: string[] }): string {
  if (opts.notesIds) {
    return opts.notesIds.length > 0
      ? `上游「${opts.upstream}」有新内容：新纳入 ${opts.notesIds.length} 篇，AI 只读这 ${opts.notesIds.length} 篇，已有笔记不动、留待按章节读的不顺带读。`
      : "";
  }
  return opts.files.length > 0
    ? `上游「${opts.upstream}」有新内容：项目里 ${opts.files.length} 个文件在这一步上次保存之后改过，AI 只改受影响的部分。`
    : "";
}

export function roundCauseLabel(cause: RoundCause): string {
  switch (cause) {
    case "first":
      return "首轮";
    case "rework":
      return "补料轮";
    case "followup":
      return "跟进轮";
    case "fresh":
      return "新开一轮";
    case "manual":
      return "接着改";
  }
}

/** 可退回的上游：本步之前、有工作区名的步骤，近的在前（默认上一步） */
export function reworkTargets<T extends { name: string; workspaceName?: string | null }>(
  steps: T[],
  index: number,
): T[] {
  return steps
    .slice(0, Math.max(0, index))
    .filter((s) => !!s.workspaceName)
    .reverse();
}

/** 「11-05 14:03」：轮次列表的时间（本地时区） */
export function roundTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 大纲「## 覆盖检查」里还没处理的薄节 → 补料单预填（综述回路三期 §9.3）。
 *  建议写「补检：…」的退回检索、「补读：…」的退回精读；别的写法归 other，交人选。 */
export interface CoverageDraft {
  target: "search" | "read" | "other";
  topic: string;
  reason: string;
}

export function coverageReworkDrafts(outlineText: string): CoverageDraft[] {
  const rows = sectionTableRows(outlineText, "覆盖检查") ?? [];
  const out: CoverageDraft[] = [];
  for (const row of rows) {
    const [section = "", body = "", hint = "", latest = "", verdict = "", advice = ""] = row;
    if (!/^薄/.test(verdict) || /不补/.test(verdict)) continue;
    const m = advice.match(/^(补检|补读)\s*[：:]\s*(.*)$/);
    const target = m ? (m[1] === "补检" ? "search" : "read") : "other";
    const what = (m ? m[2] : advice).trim();
    out.push({
      target,
      topic: `${section}${what ? `：${what}` : ""}`,
      reason: `覆盖检查：这一节可写正文 ${body || "?"} 篇、仅线索 ${hint || "?"} 篇，最新一篇 ${latest || "?"}`,
    });
  }
  return out;
}

/** 预填按退回目标分组：主题一行一条，原因取第一条（其余节的原因并进主题后面） */
export function groupCoverageDrafts(drafts: CoverageDraft[], target: CoverageDraft["target"]): { topics: string; reason: string } | null {
  const picked = drafts.filter((d) => d.target === target);
  if (picked.length === 0) return null;
  return {
    topics: picked.map((d) => d.topic).join("\n"),
    reason: picked.length === 1 ? picked[0].reason : `大纲覆盖检查里这 ${picked.length} 节是薄的（${picked.map((d) => d.reason.replace(/^覆盖检查：这一节/, "")).join("；")}）`,
  };
}
