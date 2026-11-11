/**
 * 大纲核对（综述回路三期，docs/design-outline-loop.md §4）：数得清的事实由 Mesa 自己算，不靠 AI 自述。
 * 输入 outline.md、notes/index.json、references.bib、papers/included.json 的文本，输出
 * ① 覆盖检查每节的机械计数（可写正文 / 仅线索 / 最新年份，按笔记状态数），与 AI 写的并排；
 * ② 核验项：键不在 references.bib、引了已排除的篇 → 拦下；分档与笔记状态不符、同一节重复列键、
 *    同一块子图进了两张拼图、AI 写的篇数与 Mesa 数的对不上 → 待你判断。这里不出「通过」：要么是错，要么要人看。
 * 分档口径与 notes-progress.ts 一致：reviewed + fulltext = 可写正文；仅摘要、只速读、还没笔记的 = 仅线索；
 * included.json 里 decision=excluded 的篇不计数。纯逻辑，配 tests/outline-check.test.ts。
 */
import type { CheckItem, ChecksDto } from "./research-checks.ts";
import { sectionTableRows } from "./notes-progress.ts";

/** 核验项的检查器名：评审页据此写来源「Mesa 核对」 */
export const MESA_CHECKER = "mesa";

export type NoteTier = "fulltext" | "abstract" | "skim" | "pending" | "none";

const TIER_RANK: Record<NoteTier, number> = { fulltext: 4, abstract: 3, skim: 2, pending: 1, none: 0 };

const TIER_WORD: Record<Exclude<NoteTier, "fulltext">, string> = {
  abstract: "仅摘要",
  skim: "只速读",
  pending: "还没写完笔记",
  none: "没有笔记",
};

// ---------- 键 ----------

/** Pandoc 引用键：裸写的 @键 成稿时也会被当成引用。前面不能是字母数字（WB₂@WS₂、a@b.com 不算），
 *  键里可带 : . - 但不以它们结尾（句末的点不吃进来）；括号注释、顿号都在键外 */
const KEY_RE = /(?<![\p{L}\p{N}_.@])@([A-Za-z_][A-Za-z0-9_]*(?:[:.\-][A-Za-z0-9_]+)*)/gu;

function keyMatches(line: string): { key: string; index: number }[] {
  const out: { key: string; index: number }[] = [];
  for (const m of line.matchAll(KEY_RE)) {
    const key = m[1];
    const at = m.index ?? 0;
    const before = line.slice(0, at).replace(/\s+$/, "");
    // 方括号里的（[@键]、[@甲; @乙]、[-@键]）一律算；裸写的要带年份才算，免得把「@邮箱名」一类当成键
    const bracketed = /[[;\-]$/.test(before);
    if (!bracketed && !/\d/.test(key)) continue;
    out.push({ key, index: at });
  }
  return out;
}

export function citedKeys(text: string): string[] {
  return keyMatches(text).map((m) => m.key);
}

// ---------- 台账 ----------

function records(parsed: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? (["records", "items", "papers", "entries", "notes"].map((k) => (parsed as Record<string, unknown>)[k]).find(Array.isArray) as unknown[] | undefined) ?? []
      : [];
  return rows.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}

function parseJson(text: string | null | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const REVIEWED = new Set(["reviewed", "done", "read", "complete", "completed", "已读", "已完成"]);

function rowTier(row: Record<string, unknown>): NoteTier {
  const review = str(row.reviewStatus).toLowerCase();
  if (REVIEWED.has(review)) return str(row.fulltextStatus).toLowerCase() === "fulltext" ? "fulltext" : "abstract";
  if (row.skimmed === true) return "skim";
  return "pending";
}

export interface NoteState {
  tier: NoteTier;
  /** 笔记记的它撑哪几节（二期 forSections），只留节号 */
  forSections: string[];
}

function sectionNumbers(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,，、;；\s]+/) : [];
  return list.map((x) => str(x).replace(/^§/, "").match(/^\d+(?:\.\d+)*/)?.[0] ?? "").filter(Boolean);
}

/** 笔记索引按键合并：几份索引（工作副本、项目根）里取最靠前的状态——精读保存进项目后，大纲那边不用等并入就数得到 */
export function noteStates(indexTexts: readonly (string | null | undefined)[]): Map<string, NoteState> {
  const out = new Map<string, NoteState>();
  for (const text of indexTexts) {
    for (const row of records(parseJson(text))) {
      const key = str(row.bibKey) || str(row.key);
      if (!key) continue;
      const tier = rowTier(row);
      const prev = out.get(key);
      const forSections = [...new Set([...(prev?.forSections ?? []), ...sectionNumbers(row.forSections)])];
      out.set(key, { tier: prev && TIER_RANK[prev.tier] >= TIER_RANK[tier] ? prev.tier : tier, forSections });
    }
  }
  return out;
}

/** references.bib 里的键与年份（几份取并集） */
export function bibEntries(bibTexts: readonly (string | null | undefined)[]): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const text of bibTexts) {
    if (!text) continue;
    const heads = [...text.matchAll(/@(\w+)\s*\{\s*([^,\s]+)\s*,/g)].filter((m) => !/^(comment|string|preamble)$/i.test(m[1]));
    heads.forEach((m, i) => {
      const body = text.slice(m.index ?? 0, heads[i + 1]?.index ?? text.length);
      const year = body.match(/\byear\s*=\s*[{"]?\s*(\d{4})/i)?.[1];
      if (!out.has(m[2]) || (year && out.get(m[2]) == null)) out.set(m[2], year ? Number(year) : null);
    });
  }
  return out;
}

function asciiFold(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

/** 已排除的篇能对上的键（小写键 → 题名）。进过引文库的按笔记索引 / 引文库 DOI 对（sure）；
 *  没进过的篇没有 bibKey，按 lit_records.py bib_key 的拼法（第一作者姓 + 年份）推（derived）——
 *  推出来的只在这个键不在引文库、笔记里也没有时才算，免得撞上同姓同年的另一篇 */
export function excludedKeys(
  includedText: string | null | undefined,
  indexTexts: readonly (string | null | undefined)[] = [],
  bibTexts: readonly (string | null | undefined)[] = [],
): { sure: Map<string, string>; derived: Map<string, string> } {
  const out = new Map<string, string>();
  const derived = new Map<string, string>();
  const excluded = new Map<string, Record<string, unknown>>();
  for (const row of records(parseJson(includedText))) {
    const decision = str(row.decision).toLowerCase();
    if (decision === "excluded" || decision === "exclude") excluded.set(str(row.id).toLowerCase(), row);
  }
  if (excluded.size === 0) return { sure: out, derived };
  for (const text of indexTexts) {
    for (const row of records(parseJson(text))) {
      const hit = excluded.get(str(row.id).toLowerCase());
      if (hit && str(row.bibKey)) out.set(str(row.bibKey).toLowerCase(), str(hit.title));
    }
  }
  for (const text of bibTexts) {
    for (const m of (text ?? "").matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,([\s\S]*?)(?=\n@|$)/g)) {
      const doi = m[2].match(/\bdoi\s*=\s*[{"]\s*([^}"]+)/i)?.[1]?.trim().toLowerCase();
      const hit = doi ? excluded.get(doi) : undefined;
      if (hit) out.set(m[1].toLowerCase(), str(hit.title));
    }
  }
  for (const row of excluded.values()) {
    const authors = row.authors;
    const first = Array.isArray(authors) ? str(authors[0]) : str(authors).split(/\s+and\s+|;/)[0] ?? "";
    const family = asciiFold(first.split(",")[0] ?? "").replace(/[^A-Za-z]/g, "");
    const year = str(row.year).match(/\d{4}/)?.[0] ?? "";
    if (family && year) {
      const base = `${family[0].toUpperCase()}${family.slice(1)}${year}`.toLowerCase();
      if (!derived.has(base)) derived.set(base, str(row.title));
    }
  }
  return { sure: out, derived };
}

// ---------- 大纲结构 ----------

interface Section {
  /** 节号（「2.1」「6」）；标题不带节号时为空 */
  number: string;
  title: string;
  line: number;
}

interface CiteLine {
  section: Section | null;
  line: number;
  writable: string[];
  hint: string[];
}

/** 改动记录一类的节不查键：那里写被排除的篇是在交代改了什么，不是引用 */
const LOG_HEADING = /改了什么|修改记录|变更记录|改动记录/;

function headingOf(line: string): { title: string; level: number } | null {
  const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
  if (h) return { title: h[2].trim(), level: h[1].length };
  // 加粗独占一行当小节标题（「**2.1 碱性 HER 动力学**」）
  const b = line.trim().match(/^\*\*([^*]+)\*\*$/);
  if (b && /^\s*§?\d/.test(b[1])) return { title: b[1].trim(), level: 7 };
  return null;
}

function leadNumber(text: string): string {
  return text.replace(/^[\s§第]+/, "").match(/^\d+(?:\.\d+)*/)?.[0] ?? "";
}

/** 「拟引用」一行拆两档：「拟引用——可写正文：…；仅线索：…」或分两行「拟引用（可写）：」「拟引用（线索）：」。
 *  档名后可带括号说明（「可写正文（论证与表行）：」）。没认出档名的整行不算 */
function splitTiers(line: string): { writable: string[]; hint: string[] } | null {
  const marks = [...line.matchAll(/(可写正文|可写|仅线索|线索)[^：:\n]{0,24}[：:]/g)];
  if (marks.length === 0) return null;
  const out = { writable: [] as string[], hint: [] as string[] };
  marks.forEach((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = marks[i + 1]?.index ?? line.length;
    const keys = citedKeys(line.slice(start, end));
    (m[1].includes("可写") ? out.writable : out.hint).push(...keys);
  });
  return out;
}

function parseOutline(text: string): { lines: string[]; sections: Section[]; cites: CiteLine[]; logRanges: [number, number][] } {
  const lines = text.split(/\r?\n/);
  const sections: Section[] = [];
  const cites: CiteLine[] = [];
  const logRanges: [number, number][] = [];
  let current: Section | null = null;
  let logStart: { line: number; level: number } | null = null;
  lines.forEach((raw, i) => {
    const h = headingOf(raw);
    if (h) {
      if (logStart && h.level <= logStart.level) {
        logRanges.push([logStart.line, i]);
        logStart = null;
      }
      if (LOG_HEADING.test(h.title) && !logStart) logStart = { line: i, level: h.level };
      current = { number: leadNumber(h.title), title: h.title.replace(/^[\s§]*\d+(?:\.\d+)*\.?\s*/, ""), line: i + 1 };
      sections.push(current);
      return;
    }
    if (!/^\s*[-*+•]\s/.test(raw) || !raw.includes("拟引用")) return;
    const tiers = splitTiers(raw.slice(raw.indexOf("拟引用")));
    if (tiers) cites.push({ section: current, line: i + 1, ...tiers });
  });
  if (logStart) logRanges.push([(logStart as { line: number }).line, lines.length]);
  return { lines, sections, cites, logRanges };
}

// ---------- 用图计划 ----------

/** 「1b/f」「5d–e」「7–8」「19」→ 一块块子图（小写）；整张图只写图号 */
export function figurePanels(spec: string): string[] {
  const out: string[] = [];
  let num = "";
  for (const token of spec.split(/[/,，、]/)) {
    const [left, right] = token.split(/\s*[–—~-]\s*/).map((s) => s.trim());
    const lm = left?.match(/^(S?\d+)?([a-zA-Z]?)$/);
    if (!lm) continue;
    if (lm[1]) num = lm[1].toUpperCase();
    if (!num) continue;
    const letter = lm[2].toLowerCase();
    if (right === undefined || right === "") {
      out.push(num + letter);
      continue;
    }
    const rm = right.match(/^(S?\d+)?([a-zA-Z]?)$/);
    if (!rm) {
      out.push(num + letter);
      continue;
    }
    if (rm[1] && !letter && !rm[2]) {
      // 7–8：整张图的范围
      for (let n = Number(num.replace(/^S/, "")); n <= Number(rm[1].replace(/^S/, "")) && out.length < 60; n += 1) out.push(`${num.startsWith("S") ? "S" : ""}${n}`);
      continue;
    }
    if (letter && rm[2] && !rm[1]) {
      for (let c = letter.charCodeAt(0); c <= rm[2].toLowerCase().charCodeAt(0); c += 1) out.push(num + String.fromCharCode(c));
      continue;
    }
    out.push(num + letter);
    if (rm[1]) num = rm[1].toUpperCase();
    out.push(num + rm[2].toLowerCase());
  }
  return [...new Set(out)];
}

interface Panel {
  composite: string;
  key: string;
  fig: string;
  panels: string[];
  line: number;
}

function compositePanels(lines: readonly string[]): Panel[] {
  const out: Panel[] = [];
  lines.forEach((raw, i) => {
    const heads = [...raw.matchAll(/拼\s*图\s*(\d+)/g)];
    heads.forEach((h, j) => {
      const seg = raw.slice((h.index ?? 0) + h[0].length, heads[j + 1]?.index ?? raw.length);
      const eq = seg.search(/[=＝]/);
      if (eq < 0) return;
      for (const m of seg.slice(eq).matchAll(/\[@([^\]\s;,]+)\]\s*Figs?\.?\s*(S?\d+[a-zA-Z]?(?:\s*[–—~\-/,、]\s*S?\d*[a-zA-Z]?)*)/g)) {
        const panels = figurePanels(m[2]);
        if (panels.length) out.push({ composite: h[1], key: m[1], fig: m[2].trim(), panels, line: i + 1 });
      }
    });
  });
  return out;
}

// ---------- 覆盖检查 ----------

export interface CoverageRowCheck {
  /** 表里「节」那一格原文 */
  label: string;
  /** AI 写的 */
  ai: { writable: number | null; hint: number | null; latest: string; verdict: string };
  /** Mesa 按笔记状态数的；这一行在大纲里找不到对应的节时为 null */
  mesa: { writable: string[]; hint: string[]; latest: number | null } | null;
  /** 篇数两边对不上 */
  mismatch: boolean;
}

function countCell(cell: string): number | null {
  const n = cell.match(/^\s*(\d+)/);
  return n ? Number(n[1]) : /^\s*(无|—|-)?\s*$/.test(cell) ? 0 : null;
}

/** 「1 引言 / 7 结论」→ ["1", "7"]；「3.2 B 亚结构与 ΔG／B p-band」→ ["3.2"] */
function rowNumbers(label: string): string[] {
  return [...new Set(label.split(/[/／、+＋]/).map(leadNumber).filter(Boolean))];
}

function belongs(section: Section | null, number: string): boolean {
  return !!section?.number && (section.number === number || section.number.startsWith(`${number}.`));
}

// ---------- 总入口 ----------

export interface OutlineCheckInput {
  outline: string;
  /** notes/index.json（工作副本、项目根各一份时都给，按键取最靠前的状态） */
  indexes?: readonly (string | null | undefined)[];
  /** references.bib（几份取并集） */
  bibs?: readonly (string | null | undefined)[];
  /** papers/included.json */
  included?: string | null;
  /** 核验项落点写哪个文件（相对工作目录） */
  outlinePath?: string;
}

export interface OutlineCheckResult {
  rows: CoverageRowCheck[];
  items: CheckItem[];
}

function joinKeys(keys: readonly string[], cap = 12): string {
  const shown = keys.slice(0, cap).map((k) => `@${k}`).join(" ");
  return keys.length > cap ? `${shown} 等 ${keys.length} 篇` : shown;
}

export function checkOutline(input: OutlineCheckInput): OutlineCheckResult {
  const file = input.outlinePath ?? "outline.md";
  const { lines, cites, logRanges } = parseOutline(input.outline);
  const notes = noteStates(input.indexes ?? []);
  const bibs = input.bibs ?? [];
  const bibKnown = bibs.some((b) => !!b);
  const bib = bibEntries(bibs);
  const excluded = excludedKeys(input.included, input.indexes ?? [], bibs);
  const tierOf = (key: string): NoteTier => notes.get(key)?.tier ?? "none";
  const yearOf = (key: string): number | null => bib.get(key) ?? (Number(key.match(/(\d{4})[a-z]?$/)?.[1]) || null);
  /** 已排除的题名；对不上返回 undefined */
  const excludedTitle = (key: string): string | undefined => {
    const k = key.toLowerCase();
    if (excluded.sure.has(k)) return excluded.sure.get(k);
    if (bib.has(key) || notes.has(key)) return undefined;
    return excluded.derived.get(k) ?? excluded.derived.get(k.replace(/[a-z]$/, ""));
  };
  const isExcluded = (key: string) => excludedTitle(key) !== undefined;
  const items: CheckItem[] = [];
  const target = (line: number) => ({ file, line });
  const where = (linesHit: number[]) => (linesHit.length > 1 ? `出现在第 ${linesHit.slice(0, 8).join("、")} 行${linesHit.length > 8 ? " 等" : ""}` : "");

  // ① 键：不在引文库 / 已排除（拦下）。改动记录一节不查
  const inLog = (i: number) => logRanges.some(([a, b]) => i >= a && i < b);
  const seen = new Map<string, number[]>();
  lines.forEach((raw, i) => {
    if (inLog(i) || headingOf(raw)) return;
    for (const { key } of keyMatches(raw)) seen.set(key, [...(seen.get(key) ?? []), i + 1]);
  });
  for (const [key, hit] of seen) {
    const out = excludedTitle(key);
    const inBib = bib.has(key);
    if (out !== undefined) {
      items.push({
        id: `outline-excluded-${key}`,
        kind: "outline-cite",
        status: "blocked",
        title: `引了已排除的文献 @${key}`,
        target: target(hit[0]),
        evidence: {
          source: "papers/included.json",
          detail:
            `${out ? `「${out.slice(0, 80)}」` : "这篇"}在纳入清单里已排除${inBib ? "" : "，references.bib 里也没有这个键"}。` +
            `成稿时 @键 会被当成引用；只是说明它被排除时去掉 @，要用它就先在检索那一步重新纳入。${where(hit)}`,
        },
        checker: MESA_CHECKER,
      });
    } else if (bibKnown && !inBib) {
      items.push({
        id: `outline-missing-bib-${key}`,
        kind: "outline-cite",
        status: "blocked",
        title: `references.bib 里没有 @${key}`,
        target: target(hit[0]),
        evidence: { source: "references.bib", detail: `大纲只能用引文库里已有的键；键写错了就改成库里的写法，缺这篇就回检索那一步补。${where(hit)}` },
        checker: MESA_CHECKER,
      });
    }
  }

  // ② 分档与笔记状态（待你判断）、同一节重复列键
  const tierIssues = new Map<string, { title: string; detail: string; lines: number[]; sections: string[] }>();
  const addTier = (id: string, title: string, detail: string, line: number, section: string) => {
    const cur = tierIssues.get(id) ?? { title, detail, lines: [], sections: [] };
    cur.lines.push(line);
    if (section && !cur.sections.includes(section)) cur.sections.push(section);
    tierIssues.set(id, cur);
  };
  const bySection = new Map<Section | null, CiteLine[]>();
  for (const c of cites) bySection.set(c.section, [...(bySection.get(c.section) ?? []), c]);
  for (const [section, list] of bySection) {
    const name = section ? section.number || section.title : "";
    const count = new Map<string, number>();
    for (const c of list) {
      for (const key of [...c.writable, ...c.hint]) count.set(key, (count.get(key) ?? 0) + 1);
      for (const key of c.writable) {
        const tier = tierOf(key);
        // 已排除的、引文库里没有的已经拦下，不再报分档
        if (tier === "fulltext" || isExcluded(key) || (bibKnown && !bib.has(key))) continue;
        addTier(
          `outline-tier-down-${key}`,
          `可写正文里列了${TIER_WORD[tier]}的 @${key}`,
          tier === "abstract"
            ? "这篇只有摘要级笔记，初稿只能写摘要实际报告的内容；放仅线索，或补到全文后再精读。"
            : "这篇还没有全文精读笔记，初稿不能拿它写定量结论或机制；放仅线索，或在精读那一步补读。",
          c.line,
          name,
        );
      }
      for (const key of c.hint) {
        if (tierOf(key) !== "fulltext") continue;
        addTier(`outline-tier-up-${key}`, `仅线索里的 @${key} 已有全文精读笔记`, "可以升到可写正文；这一节确实只点名不展开的，留着也行。", c.line, name);
      }
    }
    const dup = [...count].filter(([, n]) => n > 1).map(([k]) => k);
    if (dup.length) {
      items.push({
        id: `outline-dup-${section?.line ?? 0}`,
        kind: "outline-tier",
        status: "needs_human",
        title: `${name ? `${name} ` : ""}拟引用重复列了 ${joinKeys(dup)}`,
        target: target(list[0].line),
        evidence: { detail: "同一个键在这一节列了两次（或两档都列了），篇数会多算；留一处、放对档。" },
        checker: MESA_CHECKER,
      });
    }
  }
  for (const [id, v] of tierIssues) {
    items.push({
      id,
      kind: "outline-tier",
      status: "needs_human",
      title: v.title,
      target: target(v.lines[0]),
      evidence: { detail: `${v.detail}${v.sections.length ? `涉及 ${v.sections.join("、")}。` : ""}${where(v.lines)}` },
      checker: MESA_CHECKER,
    });
  }

  // ③ 同一块子图进了两张拼图
  const panels = compositePanels(lines);
  const reported = new Set<string>();
  panels.forEach((a, i) => {
    for (const b of panels.slice(i + 1)) {
      if (a.key !== b.key || a.composite === b.composite) continue;
      const shared = a.panels.filter((p) => b.panels.includes(p));
      if (!shared.length) continue;
      const id = `outline-panel-${a.key}-${shared.join("_")}-${a.composite}-${b.composite}`;
      if (reported.has(id)) continue;
      reported.add(id);
      items.push({
        id,
        kind: "outline-figure",
        status: "needs_human",
        title: `同一块子图用了两次：@${a.key} Fig.${shared.join("、")} 在拼图 ${a.composite} 和拼图 ${b.composite}`,
        target: target(b.line),
        evidence: { detail: `第 ${a.line} 行写「Fig.${a.fig}」，第 ${b.line} 行写「Fig.${b.fig}」。一张图只放一处，另一处换一块子图或改成文字引用。` },
        checker: MESA_CHECKER,
      });
    }
  });

  // ④ 覆盖检查：Mesa 数的与 AI 写的并排
  const rows: CoverageRowCheck[] = [];
  const coverage = sectionTableRows(input.outline, "覆盖检查") ?? [];
  const coverageLine = lines.findIndex((l) => /^##\s+覆盖检查/.test(l)) + 1;
  const rowLine = (label: string) =>
    lines.findIndex((l, i) => i >= coverageLine && l.trim().startsWith("|") && l.replace(/^\s*\|/, "").trim().startsWith(label)) + 1;
  for (const row of coverage) {
    const [label = "", w = "", h = "", latest = "", verdict = ""] = row;
    const ai = { writable: countCell(w), hint: countCell(h), latest: latest.trim(), verdict: verdict.trim() };
    const nums = rowNumbers(label);
    const mine = cites.filter((c) => nums.some((n) => belongs(c.section, n)));
    if (!nums.length || !mine.length) {
      rows.push({ label, ai, mesa: null, mismatch: false });
      continue;
    }
    const keys = [...new Set(mine.flatMap((c) => [...c.writable, ...c.hint]))].filter((k) => !isExcluded(k));
    const writable = keys.filter((k) => tierOf(k) === "fulltext");
    const hint = keys.filter((k) => tierOf(k) !== "fulltext");
    const years = keys.map(yearOf).filter((y): y is number => !!y);
    const mesa = { writable, hint, latest: years.length ? Math.max(...years) : null };
    const countOff = (ai.writable !== null && ai.writable !== writable.length) || (ai.hint !== null && ai.hint !== hint.length);
    // 格子里括号列了键、且列的个数等于写的篇数（AI 说的是全列）时，逐个对：重复的、多的、漏的。
    // 只列了一部分（「14（3 综述 + …）」）的不对，免得把「3 综述」当成漏写
    const keyNotes: string[] = [];
    for (const [cell, count, list, tierName] of [
      [w, ai.writable, writable, "可写正文"],
      [h, ai.hint, hint, "仅线索"],
    ] as const) {
      const listed = citedKeys(cell);
      if (!listed.length || listed.length !== count) continue;
      const dup = [...new Set(listed.filter((k, i) => listed.indexOf(k) !== i))];
      const extra = [...new Set(listed)].filter((k) => !list.includes(k));
      const missing = list.filter((k) => !listed.includes(k));
      const parts = [
        dup.length ? `${joinKeys(dup)} 写了两次` : "",
        missing.length ? `漏了 ${joinKeys(missing)}` : "",
        extra.length ? `多了 ${joinKeys(extra)}（不在这一节拟引用的这一档）` : "",
      ].filter(Boolean);
      if (parts.length) keyNotes.push(`${tierName}一格：${parts.join("，")}`);
    }
    const mismatch = countOff || keyNotes.length > 0;
    rows.push({ label, ai, mesa, mismatch });
    if (mismatch) {
      const short = label.slice(0, 30);
      items.push({
        id: `outline-count-${nums.join("_")}`,
        kind: "outline-coverage",
        status: "needs_human",
        title: countOff
          ? `覆盖检查「${short}」篇数对不上：AI 写 ${ai.writable ?? "?"} / ${ai.hint ?? "?"}，Mesa 数 ${writable.length} / ${hint.length}`
          : `覆盖检查「${short}」列的键和拟引用对不上`,
        target: target(rowLine(label) || coverageLine || mine[0].line),
        evidence: {
          detail:
            (keyNotes.length ? `${keyNotes.join("；")}。` : "") +
            `Mesa 按这一节拟引用里的键和笔记状态数——可写正文：${writable.length ? joinKeys(writable) : "无"}；仅线索：${hint.length ? joinKeys(hint) : "无"}。` +
            "篇数以 Mesa 数的为准，下一轮按它改表；够不够仍由你和 AI 判断。",
        },
        checker: MESA_CHECKER,
      });
    }
  }
  return { rows, items };
}

/** 覆盖检查里判「薄」、还没处理的节，以及其中补料已经到了的（建议里点名补读的篇都有了全文精读笔记，
 *  或补检来的新篇笔记记了这一节）。补料到了不等于够了——够不够等大纲那一步重新判断。没有覆盖检查返回 null */
export function outlineThinStatus(
  outline: string,
  indexes: readonly (string | null | undefined)[] = [],
): { thin: number; arrived: number } | null {
  const coverage = sectionTableRows(outline, "覆盖检查");
  if (!coverage) return null;
  const notes = noteStates(indexes);
  let thin = 0;
  let arrived = 0;
  for (const row of coverage) {
    const [label = "", , , , verdict = "", advice = ""] = row;
    if (!/^薄/.test(verdict) || /不补/.test(verdict)) continue;
    const keys = /补读/.test(advice) ? citedKeys(advice) : [];
    const nums = rowNumbers(label);
    const readDone = keys.length > 0 && keys.every((k) => notes.get(k)?.tier === "fulltext");
    const searchDone =
      /补检/.test(advice) &&
      nums.length > 0 &&
      [...notes.values()].some((n) => n.tier === "fulltext" && n.forSections.some((s) => nums.some((num) => s === num || s.startsWith(`${num}.`))));
    if (readDone || searchDone) arrived += 1;
    else thin += 1;
  }
  return { thin, arrived };
}

/** 评审页 / 项目助手里把 Mesa 核对的项排在核验文件的前面（同一档里先看机器数清楚的） */
export function mergeMesaChecks(dto: ChecksDto | null, mesa: readonly CheckItem[]): ChecksDto | null {
  if (!mesa.length) return dto;
  return { items: [...mesa, ...(dto?.items ?? [])], files: dto?.files ?? [], skipped: dto?.skipped ?? 0 };
}
