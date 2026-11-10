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

export type RoundCause = "first" | "rework" | "followup" | "fresh" | "manual" | "comments" | "catchup";

export interface StepRoundDto {
  index: number;
  savedAt: string;
  cause: RoundCause;
  rework: ReworkDto | null;
  sha: string;
  paths: string[];
  /** 与 paths 一一对应：added / modified / deleted；比不出为空串（老后端没有这个字段） */
  changes?: string[];
}

/** 「看这一轮」文件前的小标签 */
export function roundChangeLabel(kind: string | undefined): string {
  return kind === "added" ? "新加" : kind === "deleted" ? "删了" : kind === "modified" ? "改了" : "";
}

/** 由纳入清单生成的文献台账：「看这一轮」里不逐行比，改看一句白话（后端 step_round_ledger） */
const LEDGER_FILES = new Set([
  "papers/included.json",
  "papers/included.md",
  "papers/to-fetch.md",
  "papers/to-fetch.ris",
  "papers/endnote-import.ris",
]);
export function isLedgerFile(path: string): boolean {
  return LEDGER_FILES.has(path.replace(/\\/g, "/"));
}

export type DiffLine = { kind: "add" | "del" | "ctx" | "gap"; text: string };

/** Git 差异去掉给程序看的行（diff --git / index / --- / +++ / 文件模式），@@ 段头换成一条分隔，增删行去掉开头的 +/-、按颜色区分
 *  （2026-11-10 用户：「看这一轮」把 Git 原始差异摆给人看） */
export function readableDiff(text: string): DiffLine[] {
  const out: DiffLine[] = [];
  let started = false;
  // 文件头只在每个文件第一个 @@ 之前：段里删掉的「-- 」开头的行不能当文件头丢掉
  let inHunk = false;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (!inHunk && !line.startsWith("@@")) continue;
    if (line.startsWith("@@")) {
      if (started) out.push({ kind: "gap", text: "" });
      started = true;
      inHunk = true;
      continue;
    }
    if (line.startsWith("\\ No newline")) continue;
    if (line.startsWith("+")) out.push({ kind: "add", text: line.slice(1) });
    else if (line.startsWith("-")) out.push({ kind: "del", text: line.slice(1) });
    else out.push({ kind: "ctx", text: line.startsWith(" ") ? line.slice(1) : line });
  }
  while (out.length > 0 && out[out.length - 1].kind === "ctx" && !out[out.length - 1].text) out.pop();
  return out;
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
  opts: { isSearch: boolean; isNotes?: boolean; projectRoot: string; date: string; clause?: string },
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
          "任务书里「研究论文只速读、不写单篇笔记」对这几篇不适用；其他篇的笔记和速读行一字不动。收尾跑 lit_records.py bib 补 references.bib；notes/handoff.md 的写作约束按新笔记改到现在成立的样子（新补的约束加上，不再成立的删掉），不记改动经过；最后在对话里列出补了哪几篇、改了哪些文件。"
        : "在本步已有产物上修改，人确认过的内容不推翻；" +
          `在本步主要报告末尾追加「## 修改轮（${opts.date}）」一节，写清改了什么、改了哪些文件。` +
          (opts.clause ? opts.clause : ""),
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

/** 精读这边还留着、检索那边已经排除的篇（2026-11-10 用户拍板「从根本上改对」）：笔记索引里还有它，
 *  或引文库里还有它的 DOI。跟进时交给 AI 从写作约束、可写点清单、索引里撤掉（引文库由 lit_records.py bib 移出）。 */
export function notesDroppedIds(includedText: string, indexText: string | null, bibText: string | null): string[] {
  let rows: unknown[] | null = null;
  try {
    rows = recordsOf(JSON.parse(includedText));
  } catch {
    return [];
  }
  if (!rows) return [];
  const listed = new Set<string>();
  if (indexText) {
    try {
      for (const row of recordsOf(JSON.parse(indexText)) ?? []) {
        const r = row as Record<string, unknown>;
        if (typeof r.id === "string") listed.add(r.id);
      }
    } catch {
      /* 索引坏了：只按引文库认 */
    }
  }
  const bib = (bibText ?? "").toLowerCase();
  const out: string[] = [];
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    const decision = typeof r.decision === "string" ? r.decision.trim().toLowerCase() : "";
    if (decision !== "excluded" && decision !== "exclude") continue;
    if (typeof r.id !== "string") continue;
    const doi = bareDoi(typeof r.doi === "string" && r.doi ? r.doi : r.id);
    if (listed.has(r.id) || (doi && bib.includes(doi))) out.push(r.id);
  }
  return out;
}

function bareDoi(raw: string): string {
  const m = /10\.\d{4,9}\/[^\s"<>{}]+/.exec(raw.toLowerCase());
  return m ? m[0].replace(/[.,;)]+$/, "") : "";
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

/** 补读候选（2026-11-10 HER 实测：缺全文的篇按摘要写了笔记，人后来在官网下到了全文，没有入口让 AI 回头补读）：
 *  索引里 fulltextStatus 为 abstract-only / unavailable 的篇，带上纳入清单里的标题与 DOI，交 to_fetch_progress 对照 papers/ 有没有全文。
 *  读不懂的 JSON 返回 null（不给入口） */
export interface CatchUpProbe {
  id: string;
  bibKey: string;
  notePath: string;
  title: string;
  url: string;
}

export function catchUpProbes(includedText: string, indexText: string): CatchUpProbe[] | null {
  let index: unknown[] | null;
  let included: unknown[] | null;
  try {
    index = recordsOf(JSON.parse(indexText));
    included = recordsOf(JSON.parse(includedText));
  } catch {
    return null;
  }
  if (!index || !included) return null;
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of included) {
    const r = row as Record<string, unknown>;
    if (typeof r.id === "string") byId.set(r.id, r);
  }
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const out: CatchUpProbe[] = [];
  for (const row of index) {
    const r = row as Record<string, unknown>;
    if (!["abstract-only", "unavailable"].includes(str(r.fulltextStatus)) || !str(r.id)) continue;
    const paper = byId.get(str(r.id));
    const doi = str(paper?.doi);
    out.push({
      id: str(r.id),
      bibKey: str(r.bibKey),
      notePath: str(r.notePath),
      title: str(paper?.title),
      url: doi ? `https://doi.org/${doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")}` : str(paper?.url),
    });
  }
  return out;
}

/** 补读轮的开场指令：只补读这几篇，在原笔记上续写 */
export function catchUpPrompt(hits: { probe: CatchUpProbe; pdf: string }[]): string {
  const lines = hits.map(({ probe, pdf }) => {
    const name = probe.bibKey || probe.id;
    const note = probe.notePath ? `，笔记 ${probe.notePath}` : "";
    return `- ${name}（${probe.id}${note}）：全文 papers/${pdf}`;
  });
  return [
    `有 ${hits.length} 篇原来没有全文（notes/index.json 里 fulltextStatus 是 abstract-only 或 unavailable），现在 papers/ 里有了：`,
    ...lines,
    "这一轮只补读这几篇，别的篇一字不动。先跑 lit_records.py pdfs 认 PDF（精读只读清单，不跑 write），再读全文。",
    "在原笔记上续写（没有笔记的按技能新写），不另起平行笔记：按全文补齐、改正各段，原来凭摘要写的判断逐条核对，改了的在该段写明「按全文改」；「标注」「译段」「我的想法」与人手写的内容原样保留。",
    "收尾把这几篇在 notes/index.json 里的 fulltextStatus 改成 fulltext；有数据抽取表的补这几篇的行（出处与页码按全文填）；可写点清单受影响的在 notes/angles.md 补一句；notes/handoff.md 写作约束里这几篇「仅摘要 / 题录」的那条删掉，按全文改了结论、要下游照着写的，把那条约束改成新结论，不记补读经过。",
    KEEP_WORKING_CLAUSE,
  ].join("\n");
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

/** 检索后来排除的篇在精读这边怎么撤：写作约束、可写点清单、索引撤掉；笔记文件是读过的记录，留着不删 */
function droppedClause(ids: string[]): string {
  const shown = ids.slice(0, ID_CAP).join("、");
  const more = ids.length > ID_CAP ? ` 等 ${ids.length} 篇（以 papers/included.json 里 decision=excluded 为准）` : "";
  return (
    `检索那一步后来排除了 ${ids.length} 篇，精读这边还留着：${shown}${more}。这些篇不再进综述：` +
    "从 notes/index.json 里删掉它们那几行；notes/handoff.md 写作约束里提到它们的条目删掉或改写；notes/angles.md 里拿它们当依据的句子改掉或删掉；" +
    "references.bib 里的条目由 lit_records.py bib 移出，它点名了哪些稿件还在引用这些键的，写进本步验收摘要交人处理，本步不改稿件。笔记文件留着不删。"
  );
}

/** 跟进轮的开场指令。notesIds 非 null = 精读步：只给这些篇写笔记；否则按改动文件说。 */
export function followupPrompt(opts: {
  upstream: string;
  notesIds: string[] | null;
  /** 精读步：检索后来排除、精读这边还留着的篇（notesDroppedIds） */
  droppedIds?: string[];
  files: string[];
  /** 这一类步骤回头时的做法（step-kind.ts ROUND_CLAUSE）；按改动文件跟进时接在后面 */
  clause?: string;
}): string {
  const head = `上游「${opts.upstream}」保存过新内容，这一轮只跟进新增的部分，不重做整步。项目里的新内容已经并进本工作区。`;
  if (opts.notesIds) {
    const lines = [head];
    if (opts.notesIds.length > 0) {
      const shown = opts.notesIds.slice(0, ID_CAP).join("、");
      const more = opts.notesIds.length > ID_CAP ? ` 等 ${opts.notesIds.length} 篇（以 papers/included.json 为准）` : "";
      lines.push(
        `纳入清单里新加了 ${opts.notesIds.length} 篇，笔记索引里还没有：${shown}${more}。`,
        "只处理这些篇，写法照 TASK.md 与技能（先跑 lit_records.py pdfs 认 PDF）：任务书要研究论文只速读的，就在 notes/skim.md 补行；综述写综述卡。已有笔记和速读行一字不动。",
      );
    }
    const dropped = opts.droppedIds ?? [];
    if (dropped.length > 0) lines.push(droppedClause(dropped));
    lines.push(
      "收尾跑 lit_records.py bib 更新 references.bib，再更新 notes/index.json 与 notes/handoff.md（只留现在仍成立的写作约束）" +
        (opts.notesIds.length > 0 ? "；有可写点清单的，新篇改变了哪个角度就在 notes/angles.md 里补一句。" : "。"),
      KEEP_WORKING_CLAUSE,
    );
    return lines.join("\n");
  }
  const shown = opts.files.slice(0, FILE_CAP).map((f) => `- ${f}`);
  if (opts.files.length > FILE_CAP) shown.push(`- …另有 ${opts.files.length - FILE_CAP} 个`);
  return [
    head,
    "这些文件在本步上次保存之后改过：",
    ...shown,
    "先读这些改动，只修改受它们影响的部分；本轮之前没做完的（还没问完的问、没写的节）照 TASK.md 接着做；人确认过的内容不推翻。在本步主要产物末尾追加「## 本轮改了什么」一节，逐条写改了哪里、因为上游哪处变化。",
    ...(opts.clause ? [opts.clause] : []),
    KEEP_WORKING_CLAUSE,
  ].join("\n");
}

/** 跟进确认框里的一句规模话 */
export function followupScale(opts: { upstream: string; notesIds: string[] | null; droppedIds?: string[]; files: string[] }): string {
  if (opts.notesIds) {
    const n = opts.notesIds.length;
    const d = opts.droppedIds?.length ?? 0;
    if (n === 0 && d === 0) return "";
    const parts = [
      n > 0 ? `新纳入 ${n} 篇，AI 只处理这 ${n} 篇（按任务书精读或补速读行），已有笔记和速读行不动、只速读过的不顺带精读` : "",
      d > 0 ? `后来排除 ${d} 篇，AI 把它们从交棒的写作约束、可写点清单、索引和引文库里撤掉，笔记留着` : "",
    ].filter(Boolean);
    return `「${opts.upstream}」有更新：${parts.join("；")}。`;
  }
  return opts.files.length > 0
    ? `「${opts.upstream}」有更新：项目里 ${opts.files.length} 个文件在这一步上次保存之后改过，AI 只改受影响的部分。`
    : "";
}

/** 跟进确认框（确认框文案要短，design-system.md）：问句标题 + 一两句后果。并入、恢复这类机制不写；
 *  上一轮没保存时只写「一起评审、不能只退回一轮」这个后果（2026-11-10 用户：弹窗文案尽可能简洁） */
export function followupConfirmText(opts: {
  notesIds: string[] | null;
  droppedIds?: string[];
  files: string[];
  unsaved: boolean;
}): string {
  const n = opts.notesIds?.length ?? 0;
  const d = opts.notesIds ? (opts.droppedIds?.length ?? 0) : 0;
  const head =
    n > 0 && d > 0
      ? `跟进新纳入的 ${n} 篇、撤下后来排除的 ${d} 篇？\n\nAI 只读新纳入的，排除的从写作约束和引文库撤掉，已有笔记不动。`
      : n > 0
        ? `跟进新纳入的 ${n} 篇？\n\nAI 只读这 ${n} 篇，已有笔记不动。`
        : d > 0
          ? `撤下后来排除的 ${d} 篇？\n\nAI 把它们从写作约束和引文库撤掉，笔记留着。`
          : `跟进上游改过的 ${opts.files.length} 个文件？\n\nAI 只改受影响的部分。`;
  return opts.unsaved ? `${head}\n\n注意：上一轮还没保存，两轮会一起评审，不能只退回其中一轮。` : head;
}

/** 补读确认框：问句标题 + 哪几篇 */
export function catchUpConfirmText(names: string[]): string {
  return `补读 ${names.length} 篇新到的全文？\n\nAI 在原笔记上续写：${names.join("、")}。别的篇不动。`;
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
    case "comments":
      return "意见轮";
    case "catchup":
      return "补读轮";
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
 *  ② 否则第一个「已完成但上游又保存过」的步骤 → 去那一步点「跟进更新」。
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
    return { index: i, text: `「${statuses[i].staleUpstream}」有更新：下一步到「${name}」点「跟进更新」。` };
  }
  return null;
}

/**
 * 定稿前更新检索（2026-11-07 科研流程补全 §2）：定稿类步骤还没保存过、检索那一步已保存且超过 days 天没再保存时，
 * 返回检索那一步与它的保存时间，给「投稿前更新检索…」入口；检索那一步正在补（没处于已完成）时不提示。纯逻辑。
 */
export function searchRefreshHint(
  steps: readonly { name: string }[],
  kinds: readonly string[],
  keys: readonly (string | undefined)[],
  savedAt: (name: string) => string | null,
  focusIndex: number,
  now: number,
  days = 14,
): { step: string; savedAt: string; days: number } | null {
  if (kinds[focusIndex] !== "final" || keys[focusIndex] === "done") return null;
  const i = kinds.findIndex((k, idx) => k === "search" && idx < focusIndex);
  if (i < 0 || keys[i] !== "done") return null;
  const saved = savedAt(steps[i].name);
  if (!saved) return null;
  const age = Math.floor((now - Date.parse(saved)) / 86_400_000);
  return age >= days ? { step: steps[i].name, savedAt: saved, days: age } : null;
}

/** 更新检索的补料单预填 */
export function searchRefreshDraft(savedAt: string): { topics: string; reason: string } {
  const d = new Date(savedAt);
  const day = Number.isNaN(d.getTime()) ? savedAt.slice(0, 10) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return {
    topics: `更新检索：${day} 以来新发表的文献（按 papers/screening.md 检索日志里的原检索式与纳入标准，只补这段时间的）`,
    reason: "投稿前更新一次检索，避免漏掉最近发表的工作",
  };
}

// ===== 导师 / 合作者意见回流（2026-11-07 科研流程补全 §4） =====

/** 导入 Word 批注后处理意见那一轮的开场话：清单原路径写进去，AI 逐条填类别 / 去向 / 处理；上游的事不自己改 */
export function commentsPrompt(relPath: string, count: number, date: string): string {
  return [
    `这是一轮处理意见：我导入了 ${count} 条 Word 批注（导师 / 合作者的），清单在 ${relPath}（每行：编号 / 批注人 / 原文 / 意见 / 类别 / 去向 / 处理）。`,
    "先读 TASK.md 的完成标准和决策暂停策略，它们照旧有效。逐条处理：",
    "1. 填「类别」：改文字 / 补分析 / 补文献 / 改结构 / 要讨论。",
    "2. 本步能改的：「去向」写「本步」，直接改稿，「处理」写改在哪一节哪一段；不采纳的也写「本步」，「处理」写有依据的理由。",
    "3. 要前面步骤做的（补检索、补读、补算、改大纲 / 设计 / 清洗规则）：「去向」写「退回：步骤名」（步骤名照流程线上的原名），「处理」写要补 / 改什么；不自己改上游交的文件，Mesa 会按这一列预填退回单。",
    "4. 「要讨论」的写进人工请求问人，不替人拍板；人确认过的内容不推翻。",
    `全部过完，在本步主要报告末尾追加「## 意见处理（${date}）」：几条已改、几条待退回（退到哪几步）、几条要讨论、几条不采纳。`,
    KEEP_WORKING_CLAUSE,
  ].join("\n");
}

/** 意见清单里「去向」写了「退回：步骤名」的行，按退回目标归成补料单预填（targets：可退回的步骤名）。
 *  表头列是 docx_comments.rs render_sheet 的契约：编号 / 批注人 / 原文 / 意见 / 类别 / 去向 / 处理 */
export function commentReworkDrafts(sheet: string, targets: readonly string[]): Record<string, { topics: string; reason: string }> {
  const out: Record<string, { ids: string[]; topics: string[] }> = {};
  for (const line of sheet.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    const cells = t.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (cells.length < 7 || !/^C\d+$/.test(cells[0])) continue;
    const m = cells[5].match(/^退回[:：]\s*(.+)$/);
    if (!m) continue;
    const name = m[1].replace(/[「」]/g, "").trim();
    const target = targets.find((x) => x === name) ?? targets.find((x) => name.includes(x) || x.includes(name));
    if (!target) continue;
    const what = cells[6] || cells[3];
    (out[target] ??= { ids: [], topics: [] }).ids.push(cells[0]);
    out[target].topics.push(`${cells[0]} ${what}`.slice(0, 200));
  }
  return Object.fromEntries(
    Object.entries(out).map(([k, v]) => [k, { topics: v.topics.join("\n"), reason: `导师 / 合作者意见 ${v.ids.join("、")} 要前面这一步补或改` }]),
  );
}
