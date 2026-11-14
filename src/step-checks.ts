/**
 * 其余科研步骤的 Mesa 核对（2026-11-14）：把大纲、精读、初稿/定稿之外的步骤（检索台账机械完整性、数据登记、
 * 清洗、实验设计、实验执行、结果分析/探索性分析、投稿材料、返修对照，以及跨步骤共用的数字追溯 numbers.json、
 * 置信区间算术自洽、存疑裁决清单 verification-decisions*.md）统一做成评审页打开与项目助手取数时现算的纯函数。
 *
 * 硬约束（architecture §10 2026-11-11）：
 *   - 不写 .ccode/checks/*.jsonl，只返回 checker = "mesa" 的内存项；
 *   - 只出 blocked / needs_human，永不出 passed；
 *   - 检索步不重复「待确认清单」（人在检索评审面逐篇定），只核对隐藏在过程组里的 included.json 结构/重号等硬错误。
 */
import type { CheckItem } from "./research-checks.ts";
import { bibIds, imageRefs, manuscriptCitations } from "./draft-check.ts";
import { excludedKeys, MESA_CHECKER } from "./outline-check.ts";
import type { StepKind } from "./step-kind.ts";

export interface StepCheckInput {
  kind: StepKind;
  artifacts: readonly string[];
  /** 已读到的文本文件（键统一为正斜杠相对路径，如 "data/fields.json"、"analysis/findings.md"） */
  files: ReadonlyMap<string, string>;
  /** 已知存在的相对文件路径集合（用于核对图片、datasets.json path、figures/manifest.json 等；null 表示未列举目录） */
  existingPaths?: ReadonlySet<string> | null;
  /** 多处 references.bib（工作副本、项目根） */
  bibs?: readonly (string | null | undefined)[];
  /** 多处 notes/index.json（辅助识别已排除文献的键） */
  indexes?: readonly (string | null | undefined)[];
  /** papers/included.json（项目根或工作副本） */
  included?: string | null;
  /** 初稿/定稿步已被 checkDraft 覆盖的主稿路径（避免对同一份主稿重复报缺图、缺引用与待定标记） */
  primaryManuscript?: string | null;
}

const norm = (p: string) => p.trim().replace(/\\/g, "/").replace(/^\.\//, "");

function push(items: CheckItem[], item: Omit<CheckItem, "checker">) {
  items.push({ ...item, checker: MESA_CHECKER });
}

function lineList(lines: readonly number[], cap = 10): string {
  return `第 ${lines.slice(0, cap).join("、")} 行${lines.length > cap ? ` 等 ${lines.length} 处` : ""}`;
}

function parseJson(text: string | undefined | null): { ok: true; value: unknown } | { ok: false } {
  if (text == null) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** 与 workspaces.rs acceptance_records 保持一致：支持顶层数组或 records/items/papers/entries/runs/fields/datasets/experiments 包装 */
function extractRecords(value: unknown): Record<string, unknown>[] | null {
  const arr = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? (["records", "items", "papers", "entries", "notes", "runs", "fields", "datasets", "experiments", "figures"]
          .map((k) => (value as Record<string, unknown>)[k])
          .find(Array.isArray) as unknown[] | undefined) ?? null
      : null;
  if (!arr) return null;
  return arr.every((r) => !!r && typeof r === "object" && !Array.isArray(r)) ? (arr as Record<string, unknown>[]) : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" || typeof v === "boolean" ? String(v) : "";
}

function hasNonEmptyField(row: Record<string, unknown>, field: string): boolean {
  const v = row[field];
  if (v == null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/** 校验 JSON 台账格式、非空、唯一 id 与必填字段 */
function checkLedgerRecords(
  items: CheckItem[],
  path: string,
  text: string | undefined,
  requiredFields: readonly string[],
  opts: { allowEmpty?: boolean; skipMissingFieldsWhen?: (row: Record<string, unknown>) => boolean } = {},
): Record<string, unknown>[] | null {
  if (text === undefined) return null;
  const parsed = parseJson(text);
  if (!parsed.ok) {
    push(items, {
      id: `step-bad-json-${path}`,
      kind: "ledger-json",
      status: "blocked",
      title: `${path} 不是合法 JSON，下游步骤无法读取`,
      target: { file: path },
      evidence: { detail: "修好 JSON 语法（括号、引号或末尾逗号）后再试。" },
    });
    return null;
  }
  const rows = extractRecords(parsed.value);
  if (!rows) {
    push(items, {
      id: `step-bad-shape-${path}`,
      kind: "ledger-json",
      status: "blocked",
      title: `${path} 缺少对象数组记录结构`,
      target: { file: path },
      evidence: { detail: "应为 JSON 对象数组（如 [{ \"id\": ... }]）。" },
    });
    return null;
  }
  if (!opts.allowEmpty && rows.length === 0) {
    push(items, {
      id: `step-empty-records-${path}`,
      kind: "ledger-json",
      status: "blocked",
      title: `${path} 记录为空`,
      target: { file: path },
      evidence: { detail: "至少登记 1 条记录后再提交评审。" },
    });
    return rows;
  }
  const idCounts = new Map<string, number>();
  const missingInfo: string[] = [];
  rows.forEach((row, idx) => {
    const id = str(row.id);
    if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    if (opts.skipMissingFieldsWhen?.(row)) return;
    const lack = requiredFields.filter((f) => !hasNonEmptyField(row, f));
    if (lack.length > 0) missingInfo.push(`${id || `第 ${idx + 1} 条`}（缺 ${lack.join("、")}）`);
  });
  for (const [id, count] of idCounts) {
    if (count > 1) {
      push(items, {
        id: `step-dup-id-${path}-${id}`,
        kind: "ledger-id",
        status: "blocked",
        title: `${path} 里 id「${id}」重复出现了 ${count} 次`,
        target: { file: path },
        evidence: { detail: "每条记录的 id 必须唯一，否则跨文件对账（same-ids）会失败。" },
      });
    }
  }
  if (missingInfo.length > 0) {
    push(items, {
      id: `step-missing-fields-${path}`,
      kind: "ledger-fields",
      status: "blocked",
      title: `${path} 有 ${missingInfo.length} 条记录缺必填字段`,
      target: { file: path },
      evidence: { detail: `${missingInfo.slice(0, 8).join("；")}${missingInfo.length > 8 ? ` 等 ${missingInfo.length} 条` : ""}。` },
    });
  }
  return rows;
}

function activeRecordIds(rows: readonly Record<string, unknown>[] | null): Set<string> | null {
  if (!rows) return null;
  const ids = new Set<string>();
  for (const row of rows) {
    const dec = str(row.decision).toLowerCase();
    if (dec === "excluded" || dec === "exclude") continue;
    const id = str(row.id);
    if (id) ids.add(id);
  }
  return ids;
}

/** 核对两份台账的唯一 id 集合一致（对齐 workspaces.rs machine:same-ids） */
function checkSameIds(
  items: CheckItem[],
  refPath: string,
  refRows: readonly Record<string, unknown>[] | null,
  delivPath: string,
  delivRows: readonly Record<string, unknown>[] | null,
  label: string,
) {
  const expected = activeRecordIds(refRows);
  const actual = activeRecordIds(delivRows);
  if (!expected || !actual) return;
  const missing = [...expected].filter((id) => !actual.has(id));
  const extra = [...actual].filter((id) => !expected.has(id));
  if (!missing.length && !extra.length) return;
  const parts = [
    missing.length ? `漏了 ${missing.slice(0, 6).join("、")}${missing.length > 6 ? ` 等 ${missing.length} 项` : ""}` : "",
    extra.length ? `多了 ${extra.slice(0, 6).join("、")}${extra.length > 6 ? ` 等 ${extra.length} 项` : ""}` : "",
  ].filter(Boolean);
  push(items, {
    id: `step-same-ids-${refPath}-${delivPath}`,
    kind: "ledger-reconcile",
    status: "blocked",
    title: `${label}与 ${refPath} 的 id 对不上（${parts.join("；")}）`,
    target: { file: delivPath },
    evidence: { source: refPath, detail: `上游共 ${expected.size} 项，当前文件 ${actual.size} 项；逐 id 对齐（取消执行的也保留原 id 并记明状态和原因）。` },
  });
}

// ---------- 引用、图片、待定标记与统计置信区间 ----------

/** 核对 Markdown 文件里的 [@键] 引用与引文库 / 已排除清单（与 draft-check 同口径） */
function checkDocCitations(
  items: CheckItem[],
  file: string,
  text: string,
  bibText: string,
  bibSet: ReadonlySet<string>,
  excluded: ReturnType<typeof excludedKeys>,
) {
  const cites = manuscriptCitations(text);
  const first = new Map<string, number>();
  const all = new Map<string, number[]>();
  for (const c of cites) {
    if (!first.has(c.key)) first.set(c.key, c.line);
    all.set(c.key, [...(all.get(c.key) ?? []), c.line]);
  }
  for (const [key, line] of first) {
    const k = key.toLowerCase();
    const out = excluded.sure.get(k) ?? (!bibSet.has(key) ? excluded.derived.get(k) : undefined);
    if (out !== undefined) {
      push(items, {
        id: `step-excluded-${key}`,
        kind: "citation_excluded",
        status: "blocked",
        title: `${file} 引了已排除的文献 @${key}`,
        target: { file, line },
        evidence: { source: "papers/included.json", detail: `${out ? `「${out.slice(0, 80)}」` : "这篇"}在纳入清单里已排除。${lineList(all.get(key)!)}。` },
      });
    } else if (bibText && !bibSet.has(key)) {
      push(items, {
        id: `step-ref-${key}`,
        kind: "citation_resolve",
        status: "blocked",
        title: `${file} 里的 [@${key}] 在引文库里找不到`,
        target: { file, line },
        evidence: { source: key, detail: `${lineList(all.get(key)!)}。补进 references.bib 或改正键名。` },
      });
    }
  }
}

/** 核对 Markdown 里引用的本地图片是否存在 */
function checkDocImages(items: CheckItem[], file: string, text: string, existingPaths: ReadonlySet<string> | null | undefined) {
  if (!existingPaths) return;
  const lost = imageRefs(text, file).filter((r) => r.path && !r.path.startsWith("..") && !existingPaths.has(r.path));
  const byPath = new Map<string, number[]>();
  for (const r of lost) byPath.set(r.path, [...(byPath.get(r.path) ?? []), r.line]);
  for (const [path, lines] of byPath) {
    push(items, {
      id: `step-image-${file}-${path}`,
      kind: "draft-figure",
      status: "blocked",
      title: `${file} 引的图 ${path} 不存在`,
      target: { file, line: lines[0] },
      evidence: { detail: `${lineList(lines)}。补上图片文件，或修正路径。` },
    });
  }
}

const UNSURE_MARK = /\[(待核实|待补实验|待确认|推测|待填|TODO|TBD)\]/gi;

function checkUnsureMarks(items: CheckItem[], file: string, text: string) {
  const hits: { line: number; tag: string }[] = [];
  let fenced = false;
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    for (const m of line.matchAll(UNSURE_MARK)) hits.push({ line: i + 1, tag: m[1] });
  });
  if (!hits.length) return;
  const counts = [...new Set(hits.map((h) => h.tag))].map((t) => `[${t}] ${hits.filter((h) => h.tag === t).length}`).join("、");
  push(items, {
    id: `step-unsure-${file}`,
    kind: "draft-marks",
    status: "needs_human",
    title: `${file} 还有 ${hits.length} 处待定标记：${counts}`,
    target: { file, line: hits[0].line },
    evidence: { detail: `${lineList([...new Set(hits.map((h) => h.line))], 15)}。提交或定稿前请逐处确认。` },
  });
}

/** 移植自 stats-check/scripts/stat_check.py CI：估计值与自身置信区间的算术自洽（JS 的 \b 不认 β/η，改用 Unicode 边界） */
const CI_NUM = String.raw`[-−]?(?:\d+(?:\.\d+)?|\.\d+)`;
const CI_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])(?:OR|RR|HR|β|b|B|d|g|M|Mdiff|MD|SMD|η²|r)\s*=\s*(?<v>${CI_NUM})[^\[\]()]{0,24}?(?<lvl>\d{2})\s*%\s*CI\s*[:：]?\s*[\[(]\s*(?<lo>${CI_NUM})\s*[,;，；]\s*(?<hi>${CI_NUM})\s*[\])]`,
  "gu",
);

export function checkCiConsistency(file: string, text: string): CheckItem[] {
  const out: CheckItem[] = [];
  const fnum = (s: string) => Number(s.replace("−", "-"));
  let fenced = false;
  text.split(/\r?\n/).forEach((line, idx) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced || /^\s*<!--/.test(line)) return;
    for (const m of line.matchAll(CI_RE)) {
      const g = m.groups ?? {};
      const v = fnum(g.v ?? "");
      const lo = fnum(g.lo ?? "");
      const hi = fnum(g.hi ?? "");
      if ([v, lo, hi].some(Number.isNaN)) continue;
      const quote = m[0].trim();
      const no = idx + 1;
      const start = m.index ?? 0;
      if (lo > hi) {
        push(out, {
          id: `mesa-ci-${file}-${no}-${start}`,
          kind: "ci_consistency",
          status: "blocked",
          title: `置信区间下限大于上限：${quote}`,
          target: { file, line: no },
          evidence: { quote },
        });
      } else if (!(lo <= v && v <= hi)) {
        push(out, {
          id: `mesa-ci-${file}-${no}-${start}`,
          kind: "ci_consistency",
          status: "blocked",
          title: `估计值不在自己的置信区间里：${quote}`,
          target: { file, line: no },
          evidence: { quote },
        });
      }
    }
  });
  return out;
}

// ---------- 存疑裁决清单（verification-decisions*.md / rule-decisions.md） ----------

function checkPendingDecisions(items: CheckItem[], file: string, text: string | undefined, label: string) {
  if (!text) return;
  const lines: number[] = [];
  let fenced = false;
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    if (/(?:裁决|决定|状态|decision)\s*[：:]\s*待裁决/i.test(line) || /\|\s*待裁决\s*\|/.test(line)) {
      lines.push(i + 1);
    }
  });
  if (lines.length > 0) {
    push(items, {
      id: `step-decisions-${file}`,
      kind: "verification-decisions",
      status: "needs_human",
      title: `${label}还有 ${lines.length} 条「待裁决」尚未定夺`,
      target: { file, line: lines[0] },
      evidence: { detail: `${lineList(lines)}。在步骤卡逐条点接受、拒绝或修改后再合入成稿。` },
    });
  }
}

// ---------- 数字追溯（移植自 research-writing/scripts/num_check.py 的离线确定性比对） ----------

function parseShownNumber(rawText: string): { value: number; decimals: number } | null {
  const cleaned = rawText.trim().replace(/−/g, "-").replace(/,/g, "").replace(/%$/, "").trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const decimals = cleaned.includes(".") ? cleaned.split(".")[1].length : 0;
  return { value: Number(cleaned), decimals };
}

function jsonLookup(data: unknown, path: string): unknown {
  let cur: unknown = data;
  const parts = path.match(/[^.[\]]+|\[\d+\]/g) ?? [];
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") throw new Error(`路径 ${path} 在 ${part} 处取不到值`);
    if (part.startsWith("[")) {
      const idx = Number(part.slice(1, -1));
      if (!Array.isArray(cur) || idx < 0 || idx >= cur.length) throw new Error(`数组下标 ${part} 越界`);
      cur = cur[idx];
    } else {
      if (!(part in (cur as Record<string, unknown>))) throw new Error(`字段 ${part} 不存在`);
      cur = (cur as Record<string, unknown>)[part];
    }
  }
  return cur;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === "\"" && line[i + 1] === "\"") {
        cur += "\"";
        i += 1;
      } else if (ch === "\"") {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === "\"") {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function csvLookup(csvText: string, rowNo: unknown, matchObj: unknown, column: string): number {
  const lines = csvText.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) throw new Error("CSV 没有数据行");
  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  const colIdx = headers.indexOf(column);
  if (colIdx < 0) throw new Error(`CSV 找不到列 ${column}`);
  const dataRows = lines.slice(1).map((l) => {
    const vals = parseCsvLine(l);
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => {
      rec[h] = (vals[i] ?? "").trim();
    });
    return rec;
  });
  let target: Record<string, string> | undefined;
  if (matchObj && typeof matchObj === "object") {
    const hits = dataRows.filter((r) =>
      Object.entries(matchObj as Record<string, unknown>).every(([k, v]) => (r[k] ?? "") === String(v ?? "").trim()),
    );
    if (hits.length !== 1) throw new Error(`按过滤条件找到 ${hits.length} 行，应恰好 1 行`);
    target = hits[0];
  } else {
    const idx = Number(rowNo) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= dataRows.length) throw new Error(`行号 ${String(rowNo)} 越界`);
    target = dataRows[idx];
  }
  const num = Number(target[column]);
  if (!Number.isFinite(num)) throw new Error(`列 ${column} 的值「${target[column]}」不是数字`);
  return num;
}

function splitLocation(loc: unknown): { file: string; line?: number } {
  const s = str(loc);
  const m = s.match(/^(.+?):(\d+)$/);
  return m ? { file: norm(m[1]), line: Number(m[2]) } : { file: norm(s) };
}

export function checkNumbersTrace(
  numbersPath: string,
  numbersText: string,
  files: ReadonlyMap<string, string>,
  existingPaths?: ReadonlySet<string> | null,
): CheckItem[] {
  const items: CheckItem[] = [];
  const parsed = parseJson(numbersText);
  if (!parsed.ok) {
    push(items, {
      id: `step-bad-json-${numbersPath}`,
      kind: "number_trace",
      status: "blocked",
      title: `${numbersPath} 不是合法 JSON，数字追溯没法核对`,
      target: { file: numbersPath },
    });
    return items;
  }
  const entries =
    Array.isArray(parsed.value)
      ? parsed.value
      : parsed.value && typeof parsed.value === "object" && Array.isArray((parsed.value as Record<string, unknown>).numbers)
        ? ((parsed.value as Record<string, unknown>).numbers as unknown[])
        : null;
  if (!entries) {
    push(items, {
      id: `step-bad-shape-${numbersPath}`,
      kind: "number_trace",
      status: "blocked",
      title: `${numbersPath} 缺少 numbers 数组`,
      target: { file: numbersPath },
    });
    return items;
  }
  entries.forEach((raw, i) => {
    if (!raw || typeof raw !== "object") return;
    const entry = raw as Record<string, unknown>;
    const nid = str(entry.id) || `N${String(i + 1).padStart(3, "0")}`;
    const loc = splitLocation(entry.location);
    const shownText = str(entry.value);
    const sourceRel = norm(str(entry.source));
    const shown = parseShownNumber(shownText);
    const sourceTag = `${sourceRel}${entry.path ? `#${str(entry.path)}` : ""}`;
    if (!shown || !sourceRel) {
      push(items, {
        id: `step-num-${nid}`,
        kind: "number_trace",
        status: "needs_human",
        title: `${nid} 登记不完整（缺数值或结果文件）`,
        target: { file: loc.file || numbersPath, line: loc.line },
        evidence: { source: sourceTag },
      });
      return;
    }
    const sourceText = files.get(sourceRel);
    if (sourceText === undefined) {
      if (existingPaths && !existingPaths.has(sourceRel)) {
        push(items, {
          id: `step-num-${nid}`,
          kind: "number_trace",
          status: "blocked",
          title: `正文的 ${shownText} 在结果文件里取不到`,
          target: { file: loc.file || numbersPath, line: loc.line },
          evidence: { source: sourceTag, detail: `结果文件 ${sourceRel} 不存在` },
        });
      }
      return;
    }
    let actual: number;
    try {
      if (/\.csv$/i.test(sourceRel)) {
        actual = csvLookup(sourceText, entry.row, entry.match, str(entry.column));
      } else {
        const j = JSON.parse(sourceText);
        const val = jsonLookup(j, str(entry.path));
        actual = Number(val);
        if (!Number.isFinite(actual)) throw new Error(`取到的值「${String(val)}」不是数字`);
      }
    } catch (err) {
      push(items, {
        id: `step-num-${nid}`,
        kind: "number_trace",
        status: "blocked",
        title: `正文的 ${shownText} 在结果文件里取不到`,
        target: { file: loc.file || numbersPath, line: loc.line },
        evidence: { source: sourceTag, detail: err instanceof Error ? err.message : String(err) },
      });
      return;
    }
    const scale = entry.scale != null ? Number(entry.scale) : 1;
    const scaled = actual * scale;
    const tolerance = 0.5 * 10 ** -shown.decimals + 1e-9 * Math.max(1, Math.abs(scaled));
    const expect = scaled.toFixed(shown.decimals);
    if (Math.abs(scaled - shown.value) > tolerance) {
      push(items, {
        id: `step-num-${nid}`,
        kind: "number_trace",
        status: "blocked",
        title: `正文写 ${shownText}，结果文件是 ${expect}`,
        target: { file: loc.file || numbersPath, line: loc.line },
        evidence: { source: sourceTag, detail: `结果文件原值 ${actual}${entry.scale != null ? `（×${String(entry.scale)}）` : ""}` },
      });
      return;
    }
    const docText = loc.file ? files.get(loc.file) : undefined;
    if (docText !== undefined && loc.line && loc.line > 0) {
      const docLines = docText.split(/\r?\n/);
      const atLine = docLines[loc.line - 1];
      if (atLine !== undefined && !atLine.replace(/−/g, "-").includes(shownText.replace(/−/g, "-"))) {
        push(items, {
          id: `step-num-${nid}`,
          kind: "number_trace",
          status: "needs_human",
          title: `${shownText} 与结果一致，但登记的那一行正文里没有这个数`,
          target: { file: loc.file, line: loc.line },
          evidence: { source: sourceTag, detail: "行号可能随改稿偏移了；请核对正文位置。" },
        });
      }
    }
  });
  return items;
}

// ---------- 总入口 ----------

export function checkStepArtifacts(input: StepCheckInput): CheckItem[] {
  const items: CheckItem[] = [];
  const arts = new Set(input.artifacts.map(norm));
  const get = (rel: string) => input.files.get(norm(rel));
  const bibTexts = (input.bibs ?? []).filter((b): b is string => !!b);
  const bibJoined = bibTexts.join("\n");
  const bibSet = new Set(bibTexts.flatMap((b) => bibIds(b)));
  const excluded = excludedKeys(input.included, input.indexes ?? [], bibTexts);
  const primary = input.primaryManuscript ? norm(input.primaryManuscript) : null;

  // ① 文献检索与筛选（不重复待确认清单，只核对隐藏在过程组里的 included.json 硬错误与检索日期）
  if (input.kind === "search") {
    const incText = get("papers/included.json");
    checkLedgerRecords(items, "papers/included.json", incText, ["id", "title", "decision", "reason"], {
      allowEmpty: true,
      // 待确认（pending）的篇在步骤卡上由人定，可能还没填最终 reason
      skipMissingFieldsWhen: (row) => {
        const d = str(row.decision).toLowerCase();
        return (d === "pending" || d === "undecided" || d === "待确认") && hasNonEmptyField(row, "id") && hasNonEmptyField(row, "title");
      },
    });
    const screening = get("papers/screening.md");
    if (screening !== undefined && !/检索日期/.test(screening)) {
      push(items, {
        id: "step-screening-date",
        kind: "search-meta",
        status: "needs_human",
        title: "papers/screening.md 里没写「检索日期」",
        target: { file: "papers/screening.md", line: 1 },
        evidence: { detail: "定稿前要按检索日期判断是否超过 14 天需要更新检索；请在筛选记录顶部补上检索日期。" },
      });
    }
    return items;
  }

  // ② 数据登记与检查（data-inspect：kind=other 且产物含 data/fields.json 或 data/datasets.json）
  if (arts.has("data/fields.json") || arts.has("data/datasets.json")) {
    const fieldRows = checkLedgerRecords(items, "data/fields.json", get("data/fields.json"), ["id", "name", "type", "status"]);
    if (fieldRows) {
      const pending = fieldRows.filter((r) => /^(pending|todo|unconfirmed|待确认|未确认)$/i.test(str(r.status)));
      if (pending.length > 0) {
        push(items, {
          id: "step-data-fields-pending",
          kind: "data-fields",
          status: "needs_human",
          title: `data/fields.json 还有 ${pending.length} 个字段口径待确认`,
          target: { file: "data/fields.json" },
          evidence: { detail: `${pending.slice(0, 8).map((r) => str(r.name) || str(r.id)).join("、")}${pending.length > 8 ? " 等" : ""}。` },
        });
      }
    }
    const dsRows = checkLedgerRecords(items, "data/datasets.json", get("data/datasets.json"), ["id", "name", "path"]);
    if (dsRows && input.existingPaths) {
      for (const ds of dsRows) {
        const p = norm(str(ds.path));
        if (!p || p.startsWith("/") || /^[A-Za-z]:\//.test(p) || p.startsWith("..")) continue;
        if (!input.existingPaths.has(p)) {
          push(items, {
            id: `step-dataset-missing-${str(ds.id) || p}`,
            kind: "data-datasets",
            status: "blocked",
            title: `data/datasets.json 登记的数据文件 ${p} 不存在`,
            target: { file: "data/datasets.json" },
            evidence: { detail: `数据集「${str(ds.name) || str(ds.id)}」指向的路径在工作目录里找不到。` },
          });
        }
      }
    }
    const dict = get("data-dictionary.md");
    if (dict !== undefined) checkUnsureMarks(items, "data-dictionary.md", dict);
  }

  // ③ 清洗与整理（clean）
  if (input.kind === "clean" || arts.has("cleaning/fields.json")) {
    const cleanRows = checkLedgerRecords(items, "cleaning/fields.json", get("cleaning/fields.json"), ["id", "name", "rule", "status"]);
    const rawFieldsText = get("data/fields.json");
    if (cleanRows && rawFieldsText !== undefined) {
      const rawParsed = parseJson(rawFieldsText);
      const rawRows = rawParsed.ok ? extractRecords(rawParsed.value) : null;
      checkSameIds(items, "data/fields.json", rawRows, "cleaning/fields.json", cleanRows, "cleaning/fields.json");
    }
    checkPendingDecisions(items, "cleaning/rule-decisions.md", get("cleaning/rule-decisions.md"), "清洗规则裁决单");
    const rules = get("cleaning/rules.md");
    if (rules !== undefined) checkUnsureMarks(items, "cleaning/rules.md", rules);
  }

  // ④ 实验设计 / 研究方法（design）
  if (input.kind === "design" || arts.has("experiments/matrix.json")) {
    if (arts.has("experiments/matrix.json")) {
      const expRows = checkLedgerRecords(items, "experiments/matrix.json", get("experiments/matrix.json"), ["id", "configuration", "status"]);
      if (expRows) {
        const pending = expRows.filter((r) => /blocked|pending-approval|待批准|待确认/i.test(str(r.status)));
        if (pending.length > 0) {
          push(items, {
            id: "step-design-matrix-pending",
            kind: "experiment-matrix",
            status: "needs_human",
            title: `实验矩阵里有 ${pending.length} 组处于阻塞或待批准状态`,
            target: { file: "experiments/matrix.json" },
            evidence: { detail: `${pending.slice(0, 8).map((r) => str(r.id)).join("、")}${pending.length > 8 ? " 等" : ""}。确认资源裁剪或方案后再进入实验执行。` },
          });
        }
      }
    }
    for (const doc of ["design.md", "chapters/methodology.md"]) {
      const text = get(doc);
      if (text === undefined || doc === primary) continue;
      checkDocCitations(items, doc, text, bibJoined, bibSet, excluded);
      checkDocImages(items, doc, text, input.existingPaths);
      checkUnsureMarks(items, doc, text);
      items.push(...checkCiConsistency(doc, text));
    }
  }

  // ⑤ 实验执行（experiment）
  if (input.kind === "experiment" || arts.has("results/run-manifest.json")) {
    const resMatrix = checkLedgerRecords(items, "results/matrix.json", get("results/matrix.json"), ["id", "configuration", "status"]);
    const manifest = checkLedgerRecords(items, "results/run-manifest.json", get("results/run-manifest.json"), [
      "id",
      "dataHash",
      "codeVersion",
      "environment",
      "command",
      "status",
      "outputs",
    ]);
    const planText = get("experiments/matrix.json");
    if (planText !== undefined) {
      const planParsed = parseJson(planText);
      const planRows = planParsed.ok ? extractRecords(planParsed.value) : null;
      if (resMatrix) checkSameIds(items, "experiments/matrix.json", planRows, "results/matrix.json", resMatrix, "results/matrix.json");
      if (manifest) checkSameIds(items, "experiments/matrix.json", planRows, "results/run-manifest.json", manifest, "results/run-manifest.json");
    }
    const failed = (resMatrix ?? manifest ?? []).filter((r) => /^(failed|error|blocked|失败|阻塞)$/i.test(str(r.status)));
    if (failed.length > 0) {
      push(items, {
        id: "step-experiment-failed",
        kind: "experiment-run",
        status: "needs_human",
        title: `实验结果里有 ${failed.length} 组状态为失败或阻塞：${failed.slice(0, 6).map((r) => str(r.id)).join("、")}`,
        target: { file: resMatrix ? "results/matrix.json" : "results/run-manifest.json" },
        evidence: { detail: "确认是预期边界/硬件受限（保留记录进入分析），还是需要退回重跑。" },
      });
    }
    const summary = get("results/summary.md");
    if (summary !== undefined) {
      checkDocImages(items, "results/summary.md", summary, input.existingPaths);
      checkUnsureMarks(items, "results/summary.md", summary);
    }
  }

  // ⑥ 结果分析 / 探索性分析 / 结果章节（analysis）
  if (input.kind === "analysis") {
    for (const jsonPath of ["analysis/results.json", "analysis/summary-stats.json"]) {
      const text = get(jsonPath);
      if (text === undefined) continue;
      const parsed = parseJson(text);
      if (!parsed.ok) {
        push(items, {
          id: `step-bad-json-${jsonPath}`,
          kind: "ledger-json",
          status: "blocked",
          title: `${jsonPath} 不是合法 JSON，后续写作与数字追溯无法读取`,
          target: { file: jsonPath },
        });
      } else if (
        parsed.value == null ||
        (Array.isArray(parsed.value) && parsed.value.length === 0) ||
        (typeof parsed.value === "object" && !Array.isArray(parsed.value) && Object.keys(parsed.value as object).length === 0)
      ) {
        push(items, {
          id: `step-empty-json-${jsonPath}`,
          kind: "ledger-json",
          status: "blocked",
          title: `${jsonPath} 内容为空`,
          target: { file: jsonPath },
        });
      }
    }
    const manifestText = get("figures/manifest.json");
    if (manifestText !== undefined) {
      const parsed = parseJson(manifestText);
      if (!parsed.ok) {
        push(items, {
          id: "step-bad-json-figures/manifest.json",
          kind: "figure-manifest",
          status: "blocked",
          title: "figures/manifest.json 不是合法 JSON",
          target: { file: "figures/manifest.json" },
        });
      } else if (input.existingPaths) {
        const figRows = extractRecords(parsed.value) ?? [];
        for (const row of figRows) {
          for (const field of ["file", "path", "script", "spec"]) {
            const p = norm(str(row[field]));
            if (!p || p.startsWith("/") || p.startsWith("..")) continue;
            if (!input.existingPaths.has(p)) {
              push(items, {
                id: `step-fig-manifest-missing-${field}-${p}`,
                kind: "figure-manifest",
                status: "blocked",
                title: `figures/manifest.json 登记的 ${p} 不存在`,
                target: { file: "figures/manifest.json" },
                evidence: { detail: `字段 ${field} 指向的文件不在工作目录中，图表无法一键复现。` },
              });
            }
          }
        }
      }
    }
    for (const report of ["analysis/findings.md", "analysis/results-table.md", "eda-report.md", "chapters/results.md"]) {
      const text = get(report);
      if (text === undefined || report === primary) continue;
      checkDocCitations(items, report, text, bibJoined, bibSet, excluded);
      checkDocImages(items, report, text, input.existingPaths);
      checkUnsureMarks(items, report, text);
      items.push(...checkCiConsistency(report, text));
    }
  }

  // ⑦ 跨步骤共用的文稿辅助核对：主稿的统计区间自洽、附属正文的引用/图片/待定标记、数字追溯、存疑裁决、返修意见对账
  if (primary) {
    const pText = get(primary);
    if (pText !== undefined) items.push(...checkCiConsistency(primary, pText));
  }

  // 同一轮要交的附属正文 / 投稿材料 / 返修信（主稿之外的 Markdown 交付物）
  for (const rel of arts) {
    if (rel === primary || !/\.(md|qmd)$/i.test(rel) || /[*?]/.test(rel)) continue;
    if (/^(chapters\/|rebuttal\/response-letter-|rebuttal\/revisions-|submission\/cover-letter\.md$|submission\/highlights\.md$)/i.test(rel)) {
      const text = get(rel);
      if (text === undefined) continue;
      checkDocCitations(items, rel, text, bibJoined, bibSet, excluded);
      checkDocImages(items, rel, text, input.existingPaths);
      checkUnsureMarks(items, rel, text);
      items.push(...checkCiConsistency(rel, text));
    }
  }

  // 审稿意见逐条回复对账（response-letter-rN.md ↔ revisions-rN.md 里的 R1.1 / E.1 编号）
  for (const rel of arts) {
    const m = rel.match(/^rebuttal\/response-letter-(r\d+)\.md$/i);
    if (!m) continue;
    const round = m[1];
    const letter = get(rel);
    const revPath = `rebuttal/revisions-${round}.md`;
    const revisions = get(revPath);
    if (!letter || !revisions) continue;
    const idRe = /\b(?:R\d+\.\d+|E\.\d+)\b/g;
    const letterIds = new Set([...letter.matchAll(idRe)].map((x) => x[0]));
    const revIds = new Set([...revisions.matchAll(idRe)].map((x) => x[0]));
    if (letterIds.size > 0) {
      const missingInRev = [...letterIds].filter((id) => !revIds.has(id));
      if (missingInRev.length > 0) {
        push(items, {
          id: `step-rebuttal-ids-${round}`,
          kind: "rebuttal-reconcile",
          status: "needs_human",
          title: `修改对照表 ${revPath} 漏了回复信里的 ${missingInRev.length} 条意见编号：${missingInRev.slice(0, 6).join("、")}`,
          target: { file: revPath, line: 1 },
          evidence: { source: rel, detail: "回复信与修改对照表的意见编号（R1.1、E.1…）应逐条对应（纯解释不改稿的也记「无正文改动」）。" },
        });
      }
    }
  }

  // 存疑裁决单（定稿、分析报告、返修）
  for (const rel of arts) {
    if (/verification-decisions.*\.md$/i.test(rel)) {
      checkPendingDecisions(items, rel, get(rel), rel);
    }
  }

  // 数字追溯（manuscript/numbers.json、analysis/numbers.json）
  for (const numPath of ["manuscript/numbers.json", "analysis/numbers.json"]) {
    if (!arts.has(numPath)) continue;
    const numText = get(numPath);
    if (numText !== undefined) {
      items.push(...checkNumbersTrace(numPath, numText, input.files, input.existingPaths));
    }
  }

  return items;
}
