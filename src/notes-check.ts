/**
 * 精读核对（2026-11-11，同大纲核对的做法）：笔记索引、笔记文件、引文库、纳入清单、抽取表、速读表之间数得清的对不上，
 * 评审页打开时 Mesa 现算、合并进核验清单，不写文件、不靠 AI 跑脚本。只出拦下 / 待你判断，不出通过。
 * 起因：HER 里 Huang2027 有完整精读笔记，索引却一直标 pending + skimmed，进度少算一篇，大纲那步却把它当可写正文在用。
 * 「写完了」与进度行同一份判断（notes-progress.ts isReviewedRow）；进度行口径不变，只认索引。纯逻辑，配 tests/notes-check.test.ts。
 */
import type { CheckItem } from "./research-checks.ts";
import { isReviewedRow } from "./notes-progress.ts";
import { bibEntries, citedKeys, excludedKeys, MESA_CHECKER } from "./outline-check.ts";

/** lit-notes 技能的八段（综述卡沿用同样八个标题，另加两节） */
export const NOTE_SECTIONS = ["一句话总结", "研究问题", "方法", "主要结果", "局限", "可引用点", "与本课题的关系", "疑问与待跟进"] as const;

/** 八段标题至少出现这么多段，才算「写成了的笔记」（不看文件大小） */
export const FULL_NOTE_MIN = 6;
/** 不是单篇笔记、只是有几段像的：至少出现这么多段才拿来查「没有索引指向」 */
const NOTE_LIKE_MIN = 3;

export interface NoteFile {
  /** 相对工作目录，如 notes/40-xxx.md */
  path: string;
  text: string;
}

export interface NotesCheckInput {
  /** notes/index.json（工作副本优先） */
  index: string | null;
  /** notes/ 下所有文件的相对路径（判断 notePath 指的文件在不在） */
  files: readonly string[];
  /** notes/ 下 .md 的内容（判断完整笔记、缺哪几段、仅摘要；可以只给一部分，没给内容的不查这几项） */
  notes: readonly NoteFile[];
  bib?: string | null;
  included?: string | null;
  extraction?: string | null;
  /** notes/skim.md 与分路速读表 skim-*.md，拼在一起给 */
  skim?: string | null;
}

function parseJson(text: string | null | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function rows(parsed: unknown): Record<string, unknown>[] {
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? (["records", "items", "papers", "entries", "notes"].map((k) => (parsed as Record<string, unknown>)[k]).find(Array.isArray) as unknown[] | undefined) ?? []
      : [];
  return list.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** notePath 统一成相对路径：去掉 ./、反斜杠；绝对路径取最后一个 notes/ 起的那段 */
export function normNotePath(p: string): string {
  const s = p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const at = s.lastIndexOf("/notes/");
  return s.startsWith("/") || /^[A-Za-z]:\//.test(s) ? (at >= 0 ? s.slice(at + 1) : s) : s;
}

/** 笔记里出现了八段里的哪几段（## 标题，允许前面带序号、后面带说明） */
export function noteSections(text: string): string[] {
  const heads = [...text.matchAll(/^#{2,3}\s+(.+?)\s*$/gm)].map((m) => m[1].replace(/^[\d.、\s]+/, ""));
  return NOTE_SECTIONS.filter((s) => heads.some((h) => h.startsWith(s)));
}

/** 笔记开头（标题下前几行，来源锚点之后的状态行）写的是全文还是仅摘要；没写返回 null。
 *  「仅摘要·待全文」算仅摘要（含「全文」二字但说的是还没有） */
export function noteFulltextClaim(text: string): "fulltext" | "abstract" | null {
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((l) => /^##\s/.test(l));
  const head = lines.slice(0, first < 0 ? 12 : Math.min(first, 12)).filter((l) => !/^#\s/.test(l) && !/^>\s*来源/.test(l)).join("\n");
  if (/仅摘要|只有摘要|仅按摘要/.test(head)) return "abstract";
  if (/全文/.test(head)) return "fulltext";
  return null;
}

function titleNorm(s: string): string {
  return s.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function joinKeys(keys: readonly string[], cap = 10): string {
  const shown = keys.slice(0, cap).map((k) => `@${k}`).join(" ");
  return keys.length > cap ? `${shown} 等 ${keys.length} 篇` : shown;
}

export function checkNotes(input: NotesCheckInput): CheckItem[] {
  const items: CheckItem[] = [];
  const index = rows(parseJson(input.index));
  const files = new Set(input.files.map(normNotePath));
  const texts = new Map(input.notes.map((n) => [normNotePath(n.path), n.text]));
  const bibKnown = !!input.bib;
  const bib = bibEntries([input.bib]);
  const excluded = excludedKeys(input.included, [input.index], [input.bib]);
  const push = (item: Omit<CheckItem, "checker">) => items.push({ ...item, checker: MESA_CHECKER });

  // ---- 索引自身 ----
  const keyCount = new Map<string, number>();
  for (const row of index) {
    const key = str(row.bibKey);
    if (key) keyCount.set(key, (keyCount.get(key) ?? 0) + 1);
  }
  for (const [key, n] of keyCount) {
    if (n > 1) {
      push({
        id: `notes-dup-${key}`,
        kind: "notes-index",
        status: "blocked",
        title: `笔记索引里 @${key} 出现了 ${n} 次`,
        target: { file: "notes/index.json" },
        evidence: { detail: "同一篇只留一条，进度和大纲按哪条算都不对。" },
      });
    }
  }
  const missingBib = [...keyCount.keys()].filter((k) => bibKnown && !bib.has(k));
  if (missingBib.length) {
    push({
      id: "notes-missing-bib",
      kind: "notes-index",
      status: "blocked",
      title: `笔记索引里 ${missingBib.length} 个键在 references.bib 里没有：${joinKeys(missingBib, 6)}`,
      target: { file: "notes/index.json" },
      evidence: { source: "references.bib", detail: "这些篇写进大纲、初稿时引用会解析不出来。精读收尾跑 lit_records.py bib 补进引文库，或把键改成库里的写法。" },
    });
  }

  const pointed = new Set<string>();
  for (const row of index) {
    const key = str(row.bibKey) || str(row.id) || "（没写键）";
    const rawPath = str(row.notePath);
    const path = rawPath ? normNotePath(rawPath) : "";
    if (path) pointed.add(path);
    const reviewed = isReviewedRow(row);
    const exists = !!path && files.has(path);
    if (reviewed && !exists) {
      push({
        id: `notes-no-file-${key}`,
        kind: "notes-index",
        status: "blocked",
        title: path ? `@${key} 标了已精读，笔记 ${path} 不存在` : `@${key} 标了已精读，索引里没写笔记在哪`,
        target: { file: "notes/index.json" },
        evidence: { detail: "精读进度和大纲都把它算作读完了，可找不到笔记。补上笔记，或把索引改回 pending。" },
      });
      continue;
    }
    const text = exists ? texts.get(path) : undefined;
    if (text === undefined) continue;
    const found = noteSections(text);
    if (!reviewed && found.length >= FULL_NOTE_MIN) {
      push({
        id: `notes-unmarked-${key}`,
        kind: "notes-index",
        status: "needs_human",
        title: `@${key} 的笔记已经写成，索引却标着${row.skimmed === true ? "只速读" : "还没读完"}`,
        target: { file: path },
        evidence: {
          detail:
            `笔记里有八段中的 ${found.length} 段，索引是 reviewStatus=${str(row.reviewStatus) || "（空）"}${row.skimmed === true ? "、skimmed=true" : ""}。` +
            "精读进度会少算这一篇，大纲按索引会把它当只速读；确认写完了就把索引改成 reviewed。",
        },
      });
    }
    if (reviewed && found.length < NOTE_SECTIONS.length) {
      const lack = NOTE_SECTIONS.filter((s) => !found.includes(s));
      push({
        id: `notes-sections-${key}`,
        kind: "notes-sections",
        status: "needs_human",
        title: `@${key} 的笔记缺 ${lack.length} 段：${lack.join("、")}`,
        target: { file: path },
        evidence: { detail: "精读笔记按八段写；全文不可得的照实写「不可核验」，也不要整段省掉。" },
      });
    }
    const claim = noteFulltextClaim(text);
    const ft = str(row.fulltextStatus).toLowerCase();
    const idx = ft === "fulltext" ? "fulltext" : ft === "abstract-only" || ft === "abstract" ? "abstract" : null;
    if (reviewed && claim && idx && claim !== idx) {
      push({
        id: `notes-fulltext-${key}`,
        kind: "notes-fulltext",
        status: "needs_human",
        title: claim === "abstract" ? `@${key} 笔记开头写「仅摘要」，索引却是全文` : `@${key} 笔记开头写的是全文，索引却是仅摘要`,
        target: { file: path, line: 1 },
        evidence: { detail: "大纲按索引分档（全文算可写正文，仅摘要只算线索）；以实际读的为准改其中一边。" },
      });
    }
  }

  // ---- 没有索引指向的笔记（只查长得像单篇笔记的；已排除的篇的笔记照旧留着，不报） ----
  const excludedTitles = rows(parseJson(input.included))
    .filter((r) => /^exclude/.test(str(r.decision).toLowerCase()))
    .map((r) => titleNorm(str(r.title)))
    .filter((t) => t.length >= 12);
  for (const n of input.notes) {
    const path = normNotePath(n.path);
    if (pointed.has(path) || noteSections(n.text).length < NOTE_LIKE_MIN) continue;
    const name = titleNorm(path.split("/").pop()!.replace(/\.md$/i, ""));
    const h1 = titleNorm(n.text.match(/^#\s+(.+)$/m)?.[1] ?? "");
    const ofExcluded = excludedTitles.some((t) => (name.length >= 12 && t.startsWith(name.slice(0, 40))) || (h1.length >= 12 && (t.startsWith(h1.slice(0, 40)) || h1.startsWith(t.slice(0, 40)))));
    if (ofExcluded) continue;
    push({
      id: `notes-orphan-${path}`,
      kind: "notes-index",
      status: "needs_human",
      title: `笔记 ${path} 没有索引条目指向它`,
      target: { file: path },
      evidence: { detail: "进度、大纲和抽查都按索引找笔记，这一份会被漏掉；在索引里补一条，或确认是多出来的再删。" },
    });
  }

  // ---- 纳入了却既没笔记、也没进速读表 ----
  const byId = new Map(index.map((r) => [str(r.id).toLowerCase(), r]));
  const skimKeys = new Set(citedKeys(input.skim ?? ""));
  const missing: string[] = [];
  for (const rec of rows(parseJson(input.included))) {
    const decision = str(rec.decision).toLowerCase();
    if (decision !== "included" && decision !== "include") continue;
    const row = byId.get(str(rec.id).toLowerCase());
    const key = row ? str(row.bibKey) : "";
    const path = row ? normNotePath(str(row.notePath)) : "";
    if ((path && files.has(path)) || (key && skimKeys.has(key))) continue;
    missing.push(key ? `@${key}` : `「${str(rec.title).slice(0, 40) || str(rec.id)}」`);
  }
  if (missing.length) {
    push({
      id: "notes-uncovered",
      kind: "notes-coverage",
      status: "needs_human",
      title: `纳入的 ${missing.length} 篇既没有笔记、也不在速读表里`,
      target: { file: "papers/included.json" },
      evidence: { detail: `${missing.slice(0, 12).join(" ")}${missing.length > 12 ? ` 等 ${missing.length} 篇` : ""}。精读这一轮该写笔记或速读行的漏了，或是这一轮之后才纳入的。` },
    });
  }

  // ---- 抽取表引了不在库 / 已排除的键 ----
  if (input.extraction) {
    const bad = new Map<string, { lines: number[]; why: string }>();
    input.extraction.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim().startsWith("|")) return;
      for (const key of citedKeys(line)) {
        const why = excluded.sure.has(key.toLowerCase()) || (!bib.has(key) && excluded.derived.has(key.toLowerCase()))
          ? "已排除"
          : bibKnown && !bib.has(key)
            ? "不在 references.bib 里"
            : "";
        if (!why) continue;
        const cur = bad.get(key) ?? { lines: [], why };
        cur.lines.push(i + 1);
        bad.set(key, cur);
      }
    });
    for (const [key, v] of bad) {
      push({
        id: `notes-extraction-${key}`,
        kind: "notes-extraction",
        status: "needs_human",
        title: `抽取表引了${v.why}的 @${key}`,
        target: { file: "notes/extraction.md", line: v.lines[0] },
        evidence: { detail: `第 ${v.lines.slice(0, 8).join("、")} 行。抽取表的数会进大纲与初稿的对照表，出处得是引文库里、没被排除的篇。` },
      });
    }
  }
  return items;
}
