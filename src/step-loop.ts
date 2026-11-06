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
  /** 补料链（2026-11-06 流程贯通 §6）：退回目标保存后接着自动跟进的下游步骤名，按顺序；空 = 只补这一步 */
  chain?: string[];
}

/** 补料链上一步「开过」的记录；skipped = 算出来没有要跟进的（记了 ack），链从它的上一步接着往下 */
export interface ChainStartDto {
  step: string;
  at: string;
  skipped?: boolean;
}

export interface ReworkDto extends ReworkDraft {
  id: string;
  sentAt: string;
  relPath: string;
  /** 链走到哪（rework_list 读上；发单时还没有） */
  chainState?: { started: ChainStartDto[]; stopped: boolean };
}

/**
 * 补料链下一步该谁跟进（纯逻辑，2026-11-06 流程贯通 §6）：从退回目标起往下走，链上每一步要等它的「上一步」
 * 在开了之后又保存过才轮到它；开过而 skipped 的不算上一步（它没改东西）。轮到谁返回 { step, prev, savedAt }，
 * 还在等某一步保存 / 链走完 / 停掉 / 没有链返回 null。savedAt：某一步最近一次保存进项目的时间（没保存过 null）。
 */
export function chainNext(
  rework: Pick<ReworkDto, "toStep" | "sentAt" | "chain" | "chainState">,
  savedAt: (step: string) => string | null,
): { step: string; prev: string; savedAt: string } | null {
  if (!rework.chain?.length || rework.chainState?.stopped) return null;
  let prev = rework.toStep;
  let since = rework.sentAt;
  for (const step of rework.chain) {
    const started = rework.chainState?.started.find((s) => s.step === step);
    if (started) {
      if (!started.skipped) {
        prev = step;
        since = started.at;
      }
      continue;
    }
    const saved = savedAt(prev);
    return saved && Date.parse(saved) > Date.parse(since) ? { step, prev, savedAt: saved } : null;
  }
  return null;
}

/** 链现在卡在哪（资料全貌 / 提示用）：等某一步保存、轮到某一步跟进、走完了、停掉了 */
export function chainWhere(
  rework: Pick<ReworkDto, "toStep" | "sentAt" | "chain" | "chainState">,
  savedAt: (step: string) => string | null,
): { kind: "none" } | { kind: "stopped" } | { kind: "done" } | { kind: "waiting"; step: string } | { kind: "next"; step: string } {
  if (!rework.chain?.length) return { kind: "none" };
  if (rework.chainState?.stopped) return { kind: "stopped" };
  const next = chainNext(rework, savedAt);
  if (next) return { kind: "next", step: next.step };
  let prev = rework.toStep;
  let since = rework.sentAt;
  for (const step of rework.chain) {
    const started = rework.chainState?.started.find((s) => s.step === step);
    if (!started) return { kind: "waiting", step: prev };
    if (!started.skipped) {
      prev = step;
      since = started.at;
    }
  }
  const saved = savedAt(prev);
  return saved && Date.parse(saved) > Date.parse(since) ? { kind: "done" } : { kind: "waiting", step: prev };
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

/** 补料单从表单文字拆出主题：一行一条，去掉行首的 -、*、序号（「3.2 失活机理」的节号不是序号，留着） */
export function parseTopics(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[、)）]|\d+\.(?!\d))\s*/, "").trim())
    .filter(Boolean);
}

/** 补料轮的开场指令：补料单原文写进去（不靠 AI 去读项目根的文件），只补单上的。
 *  isNotes = 退回精读（「补读」）：点名的篇写成完整精读笔记——任务书里「研究论文只速读、不写单篇笔记」对它们不适用，
 *  否则 AI 照任务书只补速读行（2026-11-05 排查）；精读步没有「主要报告」，不叫它往报告末尾追加。 */
export function reworkPrompt(
  rework: Pick<ReworkDto, "fromStep" | "topics" | "reason" | "clues" | "scale" | "relPath">,
  opts: { isSearch: boolean; isNotes?: boolean; projectRoot: string; date: string },
): string {
  const lit = opts.isSearch || !!opts.isNotes;
  const lines = [
    lit
      ? `这是一轮补料：「${rework.fromStep}」退回来的，只补下面列的，不重做整步。`
      : `这是一轮修改：「${rework.fromStep}」退回来的，只改下面列的，不重做整步。`,
    lit ? "要补：" : "要改：",
    ...rework.topics.map((t, i) => `${i + 1}. ${t}`),
    `为什么：${rework.reason}`,
  ];
  if (rework.clues.trim()) lines.push(`线索：${rework.clues.trim()}`);
  if (rework.scale) lines.push(`规模：这次大致不超过 ${rework.scale} 篇。`);
  lines.push("先读 TASK.md 的完成标准和决策暂停策略，它们照旧有效。");
  // 补检、补读要知道这一节拿来写什么（2026-11-06）：项目最新内容开轮前已并进工作副本，大纲和可写点清单就在手边；只读不改
  if (opts.isSearch || opts.isNotes) {
    lines.push(
      "项目里有 outline.md 的，先看单上这些节在大纲里要写什么、已经用了哪些文献；有 notes/angles.md 的也看对应角度。按这些去" +
        (opts.isSearch ? "找" : "读") +
        "，大纲和可写点清单本轮不改。",
    );
  }
  if (opts.isSearch) {
    lines.push("线索里点名了种子文献（例如某几篇综述）的，按技能「引用扩展」从它们的参考文献和被引里找，只收和单上主题对得上的。");
  }
  lines.push(
    opts.isSearch
      ? "已纳入、已判定的文献不重筛、不改判定；新找到的按原纳入标准筛，纳入的追加进 papers/included.json，再按技能跑 lit_records.py write 重出清单。" +
          `在 papers/screening.md 末尾追加「## 补料轮（${opts.date}）」一节：补了什么、检索式、候选数与纳入数、没拿到全文的原因。`
      : opts.isNotes
        ? "单上点名的篇（或这些主题下该精读的篇）写成完整精读笔记：一篇一个单篇笔记文件，写法照技能；notes/index.json 里那几篇改 reviewStatus=reviewed、填 notePath、去掉 skimmed。" +
          "任务书里「研究论文只速读、不写单篇笔记」对这几篇不适用；其他篇的笔记和速读行一字不动。收尾补 references.bib、按新笔记更新 notes/handoff.md 的写作约束，最后在对话里列出补了哪几篇、改了哪些文件。"
        : "在本步已有产物上修改，人确认过的内容不推翻；" +
          `在本步主要报告末尾追加「## 修改轮（${opts.date}）」一节，写清改了什么、改了哪些文件。`,
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
 *  那是只速读过、等大纲点名精读的研究论文（综述精读第一轮，2026-11-05）或缺全文的篇，跟进不顺带把它们全读了。
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

/** 开一轮前并进来的新内容，附在开场指令末尾（2026-11-06 流程贯通 §3）；没有就空串 */
export function latestNote(files: string[]): string {
  if (files.length === 0) return "";
  const shown = files.slice(0, FILE_CAP).map((f) => `- ${f}`);
  if (files.length > FILE_CAP) shown.push(`- …另有 ${files.length - FILE_CAP} 个`);
  return [
    "项目里有这一步还没用上的新内容，开始前已经并进本工作区（多是别的步骤保存进项目的，例如文献清单、笔记、大纲）：",
    ...shown,
    "跟本步有关的照着用，无关的不用管；本步已有的、人确认过的内容不推翻。",
  ].join("\n");
}

/** 指令后面接上并入说明（没有就原样） */
export function withLatestNote(prompt: string, files: string[]): string {
  const note = latestNote(files);
  return note ? `${prompt}\n\n${note}` : prompt;
}

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
      "只处理这些篇，写法照 TASK.md 与技能（先跑 lit_records.py write 认 PDF）：任务书要研究论文只速读的，就在 notes/skim.md 补行；综述写综述卡。已有笔记和速读行一字不动。",
      "收尾更新 notes/index.json、references.bib 与 notes/handoff.md；有可写点清单的，新篇改变了哪个角度就在 notes/angles.md 里补一句。",
      KEEP_WORKING_CLAUSE,
    ].join("\n");
  }
  const shown = opts.files.slice(0, FILE_CAP).map((f) => `- ${f}`);
  if (opts.files.length > FILE_CAP) shown.push(`- …另有 ${opts.files.length - FILE_CAP} 个`);
  return [
    head,
    "这些文件在本步上次保存之后改过：",
    ...shown,
    "先读这些改动，只修改受它们影响的部分；本轮之前没做完的（还没问完的问、没写的节）照 TASK.md 接着做；人确认过的内容不推翻。在本步主要产物末尾追加「## 本轮改了什么」一节，逐条写改了哪里、因为上游哪处变化。",
    KEEP_WORKING_CLAUSE,
  ].join("\n");
}

/** 跟进确认框里的一句规模话 */
export function followupScale(opts: { upstream: string; notesIds: string[] | null; files: string[] }): string {
  if (opts.notesIds) {
    return opts.notesIds.length > 0
      ? `上游「${opts.upstream}」有新内容：新纳入 ${opts.notesIds.length} 篇，AI 只处理这 ${opts.notesIds.length} 篇（按任务书精读或补速读行），已有笔记和速读行不动、只速读过的不顺带精读。`
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

/** 归不到任何退回目标的薄节（建议没写「补检」「补读」，或对应的上游步骤不存在）：不能悄悄丢掉，
 *  补料单上单列一块让人自己决定退回哪一步（2026-11-05 排查）。一条一行：「节：建议（原因）」 */
export function unplacedCoverageDrafts(drafts: CoverageDraft[], has: { search: boolean; read: boolean }): string[] {
  return drafts
    .filter((d) => d.target === "other" || (d.target === "search" && !has.search) || (d.target === "read" && !has.read))
    .map((d) => `${d.topic}（${d.reason.replace(/^覆盖检查：/, "")}）`);
}

/** 回路进行中「下一步去哪」（2026-11-05，用户反馈「跑完一个节点就不会弄了」）：流程进度条上方一行。
 *  ① 前面某步在补一轮（进行中 / 待评审 / 有冲突），后面已有做完的步骤 → 先把它做完、评审保存；
 *  ② 否则第一个「已完成但上游又保存过」的步骤 → 去那一步点「跟进上游的新增」。
 *  都不是返回 null。只认状态，不认模板。 */
export function loopHint(
  steps: { name: string }[],
  statuses: { key: string; staleUpstream?: string | null }[],
): { index: number; text: string } | null {
  const lastDone = statuses.map((s) => s.key).lastIndexOf("done");
  for (let i = 0; i < lastDone; i++) {
    const key = statuses[i]?.key;
    if (key === "active" || key === "review" || key === "blocked") {
      const name = steps[i]?.name ?? "";
      const what =
        key === "review"
          ? "这一轮做完了，去评审、保存进项目"
          : key === "blocked"
            ? "有冲突要先处理"
            : "正在补一轮，做完去评审、保存进项目";
      return { index: i, text: `回头补的这一轮在「${name}」：${what}；保存后，后面做完的步骤会显示「待跟进」，再依次去跟进。` };
    }
  }
  const i = statuses.findIndex((s) => s.key === "done" && !!s.staleUpstream);
  if (i >= 0) {
    const name = steps[i]?.name ?? "";
    return { index: i, text: `上游「${statuses[i].staleUpstream}」保存了新内容：下一步到「${name}」点「跟进上游的新增」。` };
  }
  return null;
}
