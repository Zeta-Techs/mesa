/**
 * 初稿 / 定稿核对（2026-11-11，同大纲核对的做法）：稿件里数得清的事实 Mesa 在评审页打开时现算、合并进核验清单，
 * 不写文件、不靠 AI 跑脚本；只出拦下 / 待你判断，不出通过。
 * 从随技能分发的核验脚本移植了几条便宜、确定、离线的规则，**规则与脚本一致**（tests/draft-check.test.ts 拿同一份样例跑脚本对照）：
 *   - bib-check/scripts/cite_check.py refs：引用键能否在引文库里解析（PANDOC_KEY、去尾标点、纯数字与 @fig- 一类交叉引用不算）、库里重复键 → 拦下
 *   - research-writing/scripts/ms_check.py：开了 number-sections 又手写标题编号 → 拦下；图注 / 表题编号重复或跳号 → 拦下；
 *     图注「Adapted / Reproduced from」后面没有引文 → 待你判断
 * 联网核 DOI、重跑出图、对原文摘录不移植，仍由 AI 跑脚本。纯逻辑，取数在 research-report-load.ts loadDraftCheck。
 */
import type { CheckItem } from "./research-checks.ts";
import { excludedKeys, MESA_CHECKER, noteStates } from "./outline-check.ts";
import { placeholderFigureLines, writingScanSourcePath } from "./draft-review.ts";
import { isManuscriptHelper } from "./manuscript-files.ts";

// ---------- 从脚本移植的正则（改这里先改脚本，对照测试会拦） ----------

/** cite_check.py PANDOC_KEY：Python 的 \w 认 Unicode 字母数字，这里用 \p{L}\p{N}_ 对上 */
const PANDOC_KEY = /(?<![\p{L}\p{N}_@.\\])-?@([A-Za-z0-9_][\p{L}\p{N}_:.#$%&\-+?<>~/]*)/gu;
const CROSSREF_PREFIXES = ["fig-", "tbl-", "sec-", "eq-", "lst-", "thm-", "lem-", "def-"];
/** cite_check.py bib_ids */
const BIB_ID = /@(?!comment|string|preamble)[\p{L}\p{N}_-]+\s*\{\s*([^,\s]+)\s*,/giu;
/** ms_check.py CAPTION / SOURCE_PHRASE / CITE_MARK / HAND_NUMBER */
const CAPTION = /^\s*(?:\*\*)?(Figure|Fig\.|Table|Scheme)\s+(S?\d+)(?:\*\*)?(?:[.:|]|\s+(?=[A-Z(]))/u;
const SOURCE_PHRASE = /\b(?:Adapted|Reproduced|Reprinted|Modified|Redrawn)\s+(?:with permission\s+)?from\b[^.;]*/iu;
const CITE_MARK = /\[@|\\cite|\bRef(?:s)?\.\s*\d|\[\d|\([\p{L}\p{N}_][^()]*\d{4}[a-z]?\)|\bref\.\s*\d|\d+\s*$|[¹²³⁴⁵⁶⁷⁸⁹⁰]/u;
const HAND_NUMBER = /^\s*(?:\d+(?:\.\d+)*\.?|[IVX]+\.)\s+\S/u;

// ---------- 读稿（同 ms_check.read_text_doc：去掉 front matter，代码块不算，空行不算） ----------

interface Para {
  text: string;
  line: number;
  heading: boolean;
  level: number;
}

export function readDoc(text: string): { front: string; paras: Para[] } {
  let front = "";
  let bodyStart = 0;
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end > 0) {
      front = text.slice(3, end);
      bodyStart = (text.slice(0, end + 4).match(/\n/g) ?? []).length;
    }
  }
  const lines = text.split(/\r?\n/);
  const paras: Para[] = [];
  let fenced = false;
  lines.forEach((line, i) => {
    if (i < bodyStart) return;
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced || !line.trim()) return;
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    paras.push(m ? { text: m[2].trim(), line: i + 1, heading: true, level: m[1].length } : { text: line.trim(), line: i + 1, heading: false, level: 0 });
  });
  return { front, paras };
}

/** cite_check.citations：[(键, 行号)]，按出现顺序 */
export function manuscriptCitations(text: string): { key: string; line: number }[] {
  const out: { key: string; line: number }[] = [];
  let fenced = false;
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    for (const m of line.matchAll(PANDOC_KEY)) {
      const key = m[1].replace(/[.:;,?]+$/, "");
      if (key && !/^\d+$/.test(key) && !CROSSREF_PREFIXES.some((p) => key.toLowerCase().startsWith(p))) out.push({ key, line: i + 1 });
    }
  });
  return out;
}

export function bibIds(text: string): string[] {
  return [...text.matchAll(BIB_ID)].map((m) => m[1]);
}

// ---------- 小工具 ----------

function push(items: CheckItem[], item: Omit<CheckItem, "checker">) {
  items.push({ ...item, checker: MESA_CHECKER });
}

function lineList(lines: readonly number[], cap = 10): string {
  return `第 ${lines.slice(0, cap).join("、")} 行${lines.length > cap ? ` 等 ${lines.length} 处` : ""}`;
}

const NON_BODY = /^(abstract|摘要|references?|bibliography|参考文献|acknowledge?ments?|致谢|appendix|附录|supplementary|declarations?|author contributions?|conflicts? of interest|funding)\b/i;
const INTRO_OUTRO = /^(introduction|引言|前言|conclusions?|summary|outlook|concluding remarks|perspectives?|结论|总结|展望)/i;

function normTitle(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/^[\s§]*\d+(\.\d+)*\.?\s*/, "").replace(/[^\p{L}\p{N}]+/gu, "");
}

/** 章级标题的级别：最高一级只有一个时它是稿件标题，往下一级才是章 */
function chapterLevelOf(heads: readonly Para[]): number {
  const levels = [...new Set(heads.map((h) => h.level))].sort((a, b) => a - b);
  const top = levels[0] ?? 1;
  return heads.filter((h) => h.level === top).length === 1 && levels.length > 1 ? levels[1] : top;
}

/** manuscript/sections.json 定的节名（读不出返回 null） */
function plannedSections(json: string | null | undefined): string[] | null {
  try {
    const v = JSON.parse(json ?? "");
    return Array.isArray(v) ? v.map((s) => String((s as Record<string, unknown>)?.title ?? "")).filter(Boolean) : null;
  } catch {
    return null;
  }
}

function sameSection(a: string, b: string): boolean {
  const x = normTitle(a);
  const y = normTitle(b);
  return x === y || (x !== "" && y !== "" && (x.includes(y) || y.includes(x)));
}

/** 每一行属于哪一节（「2.2」这种编号）：标题自带编号就用，没写就按章级标题的顺序数（摘要、参考文献一类不算）；
 *  稿件标题（只有一个最高级标题时）不算一章 */
function sectionNumbers(paras: readonly Para[]): { at: (line: number) => string; title: (line: number) => string } {
  const heads = paras.filter((p) => p.heading);
  const chapterLevel = chapterLevelOf(heads);
  const marks: { line: number; num: string; title: string }[] = [];
  const counter: number[] = [];
  for (const h of heads) {
    if (h.level < chapterLevel) continue;
    const depth = h.level - chapterLevel;
    const own = h.text.match(/^[\s§]*(\d+(?:\.\d+)*)/)?.[1];
    if (NON_BODY.test(h.text.replace(/^[\s§]*\d+(\.\d+)*\.?\s*/, ""))) {
      marks.push({ line: h.line, num: "", title: h.text });
      if (depth === 0) counter.length = 0;
      continue;
    }
    counter.length = depth + 1;
    counter[depth] = (counter[depth] ?? 0) + 1;
    for (let i = 0; i < depth; i += 1) counter[i] = counter[i] ?? 1;
    marks.push({ line: h.line, num: own ?? counter.join("."), title: h.text });
  }
  const find = (line: number) => {
    let cur: { num: string; title: string } = { num: "", title: "" };
    for (const m of marks) {
      if (m.line > line) break;
      cur = m;
    }
    return cur;
  };
  return { at: (line) => find(line).num, title: (line) => find(line).title };
}

// ---------- 总入口 ----------

export type DraftStepKind = "writing" | "final";

export interface DraftCheckInput {
  kind: DraftStepKind;
  /** 主稿相对工作目录的路径（manuscript/draft.md） */
  file: string;
  text: string;
  bib?: string | null;
  included?: string | null;
  /** notes/index.json */
  index?: string | null;
  /** manuscript/sections.json */
  sections?: string | null;
  /** manuscript/style-sheet.md */
  styleSheet?: string | null;
  outline?: string | null;
  /** 稿件里引到的图片中，实际存在的那些（相对工作目录）；null = 没查（不报缺图） */
  existingImages?: ReadonlySet<string> | null;
}

/** 稿件引的图片：`![…](路径)`、`<img src>`；按主稿所在目录解析成相对工作目录的路径（网址不算） */
export function imageRefs(text: string, file: string): { path: string; line: number }[] {
  const dir = file.replace(/\\/g, "/").split("/").slice(0, -1);
  const out: { path: string; line: number }[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    // 图注写在 ![…] 里时常带 [@键]、方括号：不按配对括号认，只认「![」之后的 ](图片文件)
    const bang = line.indexOf("![");
    const md = bang < 0 ? [] : [...line.slice(bang).matchAll(/\]\(\s*<?([^)\s>]+?\.(?:png|jpe?g|gif|svg|pdf|tiff?|webp|eps))>?(?:\s+"[^"]*")?\s*\)/gi)];
    const refs = [...md, ...line.matchAll(/<img[^>]*\ssrc=["']([^"']+)["']/gi)].map((m) => m[1]);
    for (const raw of refs) {
      if (/^[a-z]+:/i.test(raw) || raw.startsWith("#")) continue;
      const parts = [...(raw.startsWith("/") ? [] : dir)];
      for (const seg of decodeURI(raw).replace(/\\/g, "/").split("/")) {
        if (seg === "..") parts.pop();
        else if (seg && seg !== ".") parts.push(seg);
      }
      out.push({ path: parts.join("/"), line: i + 1 });
    }
  });
  return out;
}

const UNSURE = /\[(待核实|待补实验|待确认|推测)\]/g;

export function checkDraft(input: DraftCheckInput): CheckItem[] {
  const items: CheckItem[] = [];
  const file = input.file;
  const { front, paras } = readDoc(input.text);
  const sec = sectionNumbers(paras);
  const bibText = input.bib ?? "";
  const ids = bibText ? bibIds(bibText) : [];
  const bibSet = new Set(ids);
  const excluded = excludedKeys(input.included, [input.index], [input.bib]);
  const notes = noteStates([input.index]);

  // ① 引用：库里重复键、键解析不了（拦下，同 cite_check refs）；引了已排除的（拦下）
  const seenIds = new Set<string>();
  for (const id of ids) {
    if (seenIds.has(id)) {
      push(items, { id: `draft-bib-dup-${id}`, kind: "citation_duplicate", status: "blocked", title: `引文库里 ${id} 重复出现`, target: { file: "references.bib" }, evidence: { detail: "同一个键对应多条记录，渲染时只会取其中一条" } });
    }
    seenIds.add(id);
  }
  const cites = manuscriptCitations(input.text);
  const first = new Map<string, number>();
  const all = new Map<string, number[]>();
  for (const c of cites) {
    if (!first.has(c.key)) first.set(c.key, c.line);
    all.set(c.key, [...(all.get(c.key) ?? []), c.line]);
  }
  for (const [key, line] of first) {
    const k = key.toLowerCase();
    const out = excluded.sure.get(k) ?? (!bibSet.has(key) && !notes.has(key) ? excluded.derived.get(k) : undefined);
    if (out !== undefined) {
      push(items, {
        id: `draft-excluded-${key}`,
        kind: "citation_excluded",
        status: "blocked",
        title: `引了已排除的文献 @${key}`,
        target: { file, line },
        evidence: { source: "papers/included.json", detail: `${out ? `「${out.slice(0, 80)}」` : "这篇"}在纳入清单里已排除${bibSet.has(key) ? "" : "，引文库里也没有"}。${lineList(all.get(key)!)}。` },
      });
    } else if (bibText && !bibSet.has(key)) {
      push(items, { id: `draft-ref-${key}`, kind: "citation_resolve", status: "blocked", title: `[@${key}] 在引文库里找不到`, target: { file, line }, evidence: { source: key, detail: "渲染后会变成问号；补进 references.bib 或改正键名" } });
    }
  }

  // ② 引了只速读 / 还没精读的（待你判断）：写出处数和所在节
  for (const [key, lines] of all) {
    const tier = notes.get(key)?.tier;
    if (tier !== "skim" && tier !== "pending") continue;
    const where = [...new Set(lines.map((l) => sec.at(l) || sec.title(l)).filter(Boolean))];
    const numeric = numericSentenceLines(paras, key);
    push(items, {
      id: `draft-skim-${key}`,
      kind: "draft-tier",
      status: "needs_human",
      title: `正文引了${tier === "skim" ? "只速读" : "还没精读"}的 @${key}（${lines.length} 处${where.length ? `，在 ${where.slice(0, 6).join("、")}` : ""}）${numeric.length ? `，${numeric.length} 句带数值` : ""}`,
      target: { file, line: numeric[0] ?? lines[0] },
      evidence: { detail: `${lineList(lines)}。${numeric.length ? `带数值的句子在${lineList(numeric)}，先看这几句。` : ""}只速读的篇只能点名、不能拿它写定量结论或机制细节；越没越界由你看。` },
    });
  }

  // ②b 仅摘要的篇撑了数值、句子里没标 [待核实] 也没写「摘要报告」（待你判断）
  for (const [key] of all) {
    if (notes.get(key)?.tier !== "abstract") continue;
    const numeric = numericSentenceLines(paras, key, ABSTRACT_HEDGE);
    if (!numeric.length) continue;
    push(items, {
      id: `draft-abstract-num-${key}`,
      kind: "draft-tier",
      status: "needs_human",
      title: `只读到摘要的 @${key} 撑了 ${numeric.length} 句带数值的话，句中没标 [待核实]`,
      target: { file, line: numeric[0] },
      evidence: { detail: `${lineList(numeric)}。仅摘要的篇写定量要标 [待核实]，或写成「该文摘要报告了…」；数值确实在摘要里的，你看过就行。` },
    });
  }

  // ②c 引用集中在一篇上（待你判断，只列不判）：正文带引用的段落里，被引最多的一篇占比
  const citedParas = paras.filter((p) => !p.heading && !p.text.startsWith("|") && !p.text.startsWith("!") && /@/.test(p.text));
  const paraKeys = citedParas.map((p) => new Set(manuscriptCitations(p.text).map((c) => c.key)));
  const perKey = new Map<string, number[]>();
  paraKeys.forEach((ks, i) => ks.forEach((k) => perKey.set(k, [...(perKey.get(k) ?? []), citedParas[i].line])));
  const ranked = [...perKey].sort((a, b) => b[1].length - a[1].length);
  const top = ranked[0];
  if (top && citedParas.length >= 30 && top[1].length >= CONCENTRATION_MIN_PARAS && top[1].length / citedParas.length >= CONCENTRATION_SHARE) {
    const chapters = [...new Set(top[1].map((l) => (sec.at(l) || sec.title(l)).split(".")[0]).filter(Boolean))];
    const pct = (n: number) => `${Math.round((n / citedParas.length) * 100)}%`;
    push(items, {
      id: "draft-concentration",
      kind: "draft-tier",
      status: "needs_human",
      title: `@${top[0]} 出现在 ${top[1].length} 段（带引用段落的 ${pct(top[1].length)}），跨 ${chapters.length} 章`,
      target: { file, line: top[1][0] },
      evidence: {
        detail: `其次：${ranked.slice(1, 4).map(([k, ls]) => `@${k} ${ls.length} 段`).join("、")}。只列出来，不判对错：一篇撑起中心论点时，摘要、讨论、结论的口气要和证据面对得上（「一组对照实验支持」，不写成 shown / rule）。`,
      },
    });
  }

  // ③ 标题编号（同 ms_check.check_heading_numbers 的 Markdown 分支）
  const heads = paras.filter((p) => p.heading);
  const hand = heads.filter((p) => HAND_NUMBER.test(p.text));
  if (/^\s*number-sections:\s*true/m.test(front) && hand.length) {
    push(items, {
      id: "draft-heading-number",
      kind: "headings",
      status: "blocked",
      title: `开了 number-sections 又手写了标题编号（${hand.length} 处），渲染后会编两次号`,
      target: { file, line: hand[0].line },
      evidence: { detail: `${hand.slice(0, 6).map((h) => h.text.slice(0, 40)).join("；")}。删掉手写的编号` },
    });
  }

  // ④ 图注 / 表题编号与出处（同 ms_check.check_captions）
  const seen = new Map<string, { num: string; line: number }[]>();
  for (const p of paras) {
    const m = p.text.match(CAPTION);
    if (!m) continue;
    const kind = m[1].toLowerCase().startsWith("tab") ? "Table" : m[1].toLowerCase() === "scheme" ? "Scheme" : "Figure";
    const num = m[2].toUpperCase();
    seen.set(kind, [...(seen.get(kind) ?? []), { num, line: p.line }]);
    const src = p.text.match(SOURCE_PHRASE);
    if (src && src.index !== undefined && !CITE_MARK.test(p.text.slice(src.index))) {
      push(items, {
        id: `draft-cap-src-${kind}${num}-${p.line}`,
        kind: "caption-source",
        status: "needs_human",
        title: `${kind} ${num} 的图注写了「${src[0].slice(0, 40)}」，后面没有引文或 Ref. 编号`,
        target: { file, line: p.line },
        evidence: { detail: "借用的图要在图注里写清出处，并按出版社要求写许可说明" },
      });
    }
  }
  for (const [kind, list] of seen) {
    const nums = list.filter((x) => !x.num.startsWith("S")).map((x) => Number(x.num));
    if (!nums.length) continue;
    const dup = [...new Set(nums.filter((n, i) => nums.indexOf(n) !== i))].sort((a, b) => a - b);
    const missing: number[] = [];
    for (let n = 1; n <= Math.max(...nums); n += 1) if (!nums.includes(n)) missing.push(n);
    if (!dup.length && !missing.length) continue;
    const detail = [dup.length ? `重复：${dup.join("、")}` : "", missing.length ? `缺：${missing.join("、")}` : ""].filter(Boolean).join("；");
    push(items, {
      id: `draft-cap-num-${kind}`,
      kind: "caption-number",
      status: "blocked",
      title: `${kind} 的编号${dup.length ? "重复" : ""}${dup.length && missing.length ? "、" : ""}${missing.length ? "跳号" : ""}`,
      target: { file, line: list[0].line },
      evidence: { detail: `${detail}（按图注 / 表题里的编号数）` },
    });
  }

  // ⑤ 引了不存在的图片（只认 figures/ 下的）
  const images = imageRefs(input.text, file);
  if (input.existingImages) {
    const lost = images.filter((r) => /^figures\//.test(r.path) && !input.existingImages!.has(r.path));
    const byPath = new Map<string, number[]>();
    for (const r of lost) byPath.set(r.path, [...(byPath.get(r.path) ?? []), r.line]);
    for (const [path, lines] of byPath) {
      push(items, { id: `draft-image-${path}`, kind: "draft-figure", status: "blocked", title: `正文引的图 ${path} 不存在`, target: { file, line: lines[0] }, evidence: { detail: `${lineList(lines)}。渲染时这张图会缺；补上图，或改正路径。` } });
    }
  }

  // ⑥ 定稿：还有「待绘制」或空图片占位（拦下；写作扫描同一份判断，见 draft-review placeholderFigureLines）
  if (input.kind === "final") {
    const lines = placeholderFigureLines(input.text);
    if (lines.length) {
      push(items, { id: "draft-placeholder", kind: "draft-figure", status: "blocked", title: `定稿里还有 ${lines.length} 处图的占位（「待绘制」或空图片）`, target: { file, line: lines[0] }, evidence: { detail: `${lineList(lines)}。定稿不留占位：补上图，或改成「见 [@键] Fig.n」。` } });
    }
  }

  // ⑦ 待核实一类标记还剩几处（一条汇总）
  const unsure: { line: number; tag: string }[] = [];
  input.text.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(UNSURE)) unsure.push({ line: i + 1, tag: m[1] });
  });
  if (unsure.length) {
    const counts = [...new Set(unsure.map((u) => u.tag))].map((t) => `[${t}] ${unsure.filter((u) => u.tag === t).length}`).join("、");
    push(items, {
      id: "draft-unsure",
      kind: "draft-marks",
      status: "needs_human",
      title: `还有 ${unsure.length} 处待定标记：${counts}`,
      target: { file, line: unsure[0].line },
      evidence: { detail: `${lineList([...new Set(unsure.map((u) => u.line))], 20)}。${input.kind === "final" ? "定稿前逐处核实或删掉。" : "初稿可以留，评审时看哪些要退回去核。"}` },
    });
  }

  // ⑧ 节的顺序、有无对 sections.json
  const plan = plannedSections(input.sections);
  if (plan?.length) {
    const chapterLevel = chapterLevelOf(heads);
    const strip = (t: string) => t.replace(/^[\s§]*\d+(\.\d+)*\.?\s*/, "");
    const body = heads.filter((h) => h.level === chapterLevel && !NON_BODY.test(strip(h.text)) && !INTRO_OUTRO.test(strip(h.text)));
    const at = plan.map((t) => body.findIndex((h) => normTitle(h.text) === normTitle(t) || normTitle(h.text).includes(normTitle(t)) || normTitle(t).includes(normTitle(h.text))));
    const matched = at.filter((i) => i >= 0);
    let detail = "";
    let title = "";
    if (matched.length) {
      const missing = plan.filter((_, i) => at[i] < 0);
      const disordered = matched.some((v, i) => i > 0 && v < matched[i - 1]);
      if (missing.length || disordered) {
        title = `稿件的节和 sections.json 对不上：${[missing.length ? `缺 ${missing.length} 节` : "", disordered ? "顺序不同" : ""].filter(Boolean).join("、")}`;
        detail = `${missing.length ? `缺：${missing.join("；")}。` : ""}sections.json 的顺序：${plan.join(" → ")}；稿件正文的章：${body.map((h) => strip(h.text)).join(" → ")}。`;
      }
    } else if (body.length !== plan.length) {
      title = `稿件正文 ${body.length} 章，sections.json 定了 ${plan.length} 节`;
      detail = `标题对不上字（可能一边中文一边英文），只比了章数。sections.json：${plan.join(" → ")}；稿件：${body.map((h) => strip(h.text)).join(" → ") || "（没有章级标题）"}。`;
    }
    if (title) {
      push(items, { id: "draft-sections", kind: "draft-structure", status: "needs_human", title, target: { file: "manuscript/sections.json" }, evidence: { detail: `${detail}引言与结论不在 sections.json 里，不算。` } });
    }
  }

  // ⑨ 写作规范里的缩写：首次出现不在规定的那一节，或从没给过全称
  if (input.styleSheet) {
    const issues: string[] = [];
    let firstLine: number | undefined;
    for (const abbr of styleAbbreviations(input.styleSheet)) {
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${abbr.abbr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u");
      const hit = paras.find((p) => !p.heading && sec.at(p.line) !== "" && re.test(p.text));
      if (!hit) continue;
      const where = sec.at(hit.line);
      const problems: string[] = [];
      if (abbr.section && !(where === abbr.section || where.startsWith(`${abbr.section}.`))) problems.push(`规定第 ${abbr.section} 节首次定义，第一次出现在第 ${where} 节（第 ${hit.line} 行）`);
      if (abbr.full && !input.text.toLowerCase().includes(abbr.full.toLowerCase())) problems.push("正文里没写过全称");
      if (problems.length) {
        issues.push(`${abbr.abbr}：${problems.join("；")}`);
        firstLine ??= hit.line;
      }
    }
    if (issues.length) {
      push(items, {
        id: "draft-abbr",
        kind: "draft-terms",
        status: "needs_human",
        title: `${issues.length} 个缩写和写作规范对不上`,
        target: { file, line: firstLine },
        evidence: { source: "manuscript/style-sheet.md", detail: `${issues.slice(0, 12).join("；")}${issues.length > 12 ? ` 等 ${issues.length} 个` : ""}。摘要单独定义，不算。` },
      });
    }
  }

  // ⑩ 大纲的拼图 / 自绘 / 重绘 / 表计划，稿件里插了没有
  if (input.outline) {
    // 只认计划的写法「拼图 N（论点）= …」「自绘 图N（论点）= …」「重绘 图N（论点）= …」：「拼图 7 张 + 仅引用 2 张」这类小结不算
    const plannedFigs = new Set([...input.outline.matchAll(/拼\s*图\s*(\d+)\s*[（(=＝]/g)].map((m) => Number(m[1])));
    const plannedDrawn = new Set([...input.outline.matchAll(/(?:自绘|重绘)\s*图\s*(\d+)\s*[（(=＝]/g)].map((m) => Number(m[1])));
    const plannedTabs = new Set([...input.outline.matchAll(/(?:^|[^附])表\s*(\d+)\s*（/gm)].map((m) => Number(m[1])));
    const figsIn = new Set<number>([
      ...images.map((r) => Number(r.path.match(/(?:^|\/)fig(?:ure)?[-_]?(\d+)(?:[-_][a-z0-9_-]+)?\.[a-z]+$/i)?.[1])).filter((n) => n > 0),
      ...paras.flatMap((p) => {
        const m = p.text.match(CAPTION);
        return m && !/^tab/i.test(m[1]) && !m[2].startsWith("S") ? [Number(m[2])] : [];
      }),
    ]);
    const tabsIn = new Set<number>(
      paras.flatMap((p) => {
        const m = p.text.match(CAPTION) ?? p.text.match(/^\s*(?:\*\*)?(表)\s*(\d+)/u);
        return m && /^(tab|表)/i.test(m[1]) ? [Number(m[2])] : [];
      }),
    );
    const mdTables = (input.text.match(/^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/gm) ?? []).length;
    const lackFig = [...plannedFigs].filter((n) => !figsIn.has(n)).sort((a, b) => a - b);
    const lackDrawn = [...plannedDrawn].filter((n) => !figsIn.has(n)).sort((a, b) => a - b);
    const lackTab = tabsIn.size || mdTables < plannedTabs.size ? [...plannedTabs].filter((n) => !tabsIn.has(n)).sort((a, b) => a - b) : [];
    if (lackFig.length || lackDrawn.length || lackTab.length) {
      const missingParts = [
        lackFig.length ? `拼图 ${lackFig.join("、")}` : "",
        lackDrawn.length ? `自绘/重绘 图${lackDrawn.join("、")}` : "",
        lackTab.length ? `表 ${lackTab.join("、")}` : "",
      ].filter(Boolean);
      const planSummary = [
        `拼图 ${plannedFigs.size} 张`,
        ...(plannedDrawn.size ? [`自绘/重绘 ${plannedDrawn.size} 张`] : []),
        `表 ${plannedTabs.size} 张`,
      ].join("、");
      push(items, {
        id: "draft-plan",
        kind: "draft-figure",
        status: "needs_human",
        title: `大纲计划的${missingParts.join("，")} 在稿件里没找到`,
        target: { file, line: 1 },
        evidence: {
          source: "outline.md",
          detail: `大纲计划${planSummary}；稿件里认到图 ${figsIn.size} 张（按 figures/figN 与图注编号）、表 ${tabsIn.size || mdTables} 张。拼不成或缺数据改成「见 [@键] Fig.n」的，原因应写在 figures/README.md。`,
        },
      });
    }
  }

  // ⑪ 渲染后会走样的写法（2026-11-13 HER 初稿实证）：下标写成 _、交叉引用前多写 Table、手写章节号、段末堆原图号
  const body = paras.filter((p) => !p.heading && !/^<!--/.test(p.text));
  const underscore = body.filter((p) => SUBSCRIPT_UNDERSCORE.test(proseOnly(p.text)));
  if (underscore.length) {
    const samples = [...new Set(underscore.flatMap((p) => [...proseOnly(p.text).matchAll(new RegExp(SUBSCRIPT_UNDERSCORE.source, "gu"))].map((m) => m[0])))];
    push(items, {
      id: "draft-underscore",
      kind: "draft-render",
      status: "needs_human",
      title: `${underscore.length} 处把下标写成了「_」（${samples.slice(0, 3).join("、")}）`,
      target: { file, line: underscore[0].line },
      evidence: { detail: `${lineList(underscore.map((p) => p.line))}。Markdown 里 _ 不是下标，PDF 和 Word 会原样显示下划线；改成 Pandoc 写法 ΔG~H\\*~、η~10~。` },
    });
  }
  const prefixed = body.flatMap((p) =>
    [...stripCodeAndMath(p.text).matchAll(XREF_PREFIX)].map((m) => ({ line: p.line, text: m[0] })),
  );
  if (prefixed.length) {
    push(items, {
      id: "draft-xref-prefix",
      kind: "draft-render",
      status: "blocked",
      title: `交叉引用前多写了 ${prefixed[0].text.replace(/\s*\[?-?@.*$/, "")}（${prefixed.length} 处），渲染后会显示两遍`,
      target: { file, line: prefixed[0].line },
      evidence: { detail: `${lineList([...new Set(prefixed.map((x) => x.line))])}。Quarto 会自己补上 Table / Figure / Section，「Tables @tbl-1」渲成「Tables Table 1」；删掉前面那个词。` },
    });
  }
  if (/^\s*number-sections:\s*true/m.test(front)) {
    const own = new Set(heads.map((h) => sec.at(h.line)).filter(Boolean));
    const refs = body.flatMap((p) => {
      const cleaned = stripCodeAndMath(p.text);
      return [...cleaned.matchAll(HAND_SECTION_REF)]
        .filter((m) => {
          const tail = cleaned.slice((m.index ?? 0) + m[0].length);
          // 「Section 2.1 of [@Smith2020]」指被引用论文的节，不是本稿章节号
          return !/^\s*(?:of|in)\s+(?:Refs?\.?\s*)?\[?-?@(?!sec-|fig-|tbl-|eq-)/i.test(tail);
        })
        .map((m) => ({ line: p.line, nums: m[0].match(/\d+(?:\.\d+)*/g) ?? [] }));
    });
    if (refs.length) {
      const missing = [...new Set(refs.flatMap((r) => r.nums).filter((n) => !own.has(n)))];
      push(items, {
        id: "draft-hand-secref",
        kind: "draft-render",
        status: "needs_human",
        title: `正文手写了 ${refs.length} 处章节号（Section 3.3 一类）${missing.length ? `，其中 ${missing.slice(0, 4).join("、")} 对不上现在的标题` : ""}`,
        target: { file, line: refs[0].line },
        evidence: { detail: `${lineList([...new Set(refs.map((r) => r.line))])}。章节号由 Quarto 自动编，挪一节手写的号就全错位；给那一节标题加 {#sec-名}，正文写 @sec-名。${missing.length ? "对不上的是按现在的标题顺序推算的。" : ""}` },
      });
    }
  }
  const piles = body.filter((p) => !p.text.startsWith("|")).flatMap((p) =>
    splitSentences(p.text)
      .filter((s) => (s.match(FIG_OF_CITE) ?? []).length >= 3)
      .map(() => p.line),
  );
  if (piles.length) {
    push(items, {
      id: "draft-fig-pile",
      kind: "draft-figure",
      status: "needs_human",
      title: `${piles.length} 句一口气列了三处以上的原文图号（see Fig. n of [@键]…）`,
      target: { file, line: piles[0] },
      evidence: { detail: `${lineList([...new Set(piles)])}。原图号放在用到它的那句论断里、一处一次；没处可放的记进 figures/README.md，不在段末堆成一串。` },
    });
  }
  return items;
}

/** 一篇占带引用段落的比例到多少才报（2026-11-13 HER 初稿 10%、另一份定稿 4%） */
const CONCENTRATION_SHARE = 0.08;
const CONCENTRATION_MIN_PARAS = 10;
/** 带单位的数值：75–84 mV、1.54 V、64 h、12%、0.06 eV、0.5 M、1000 cycles 等常见理化单位 */
const NUMERIC_VALUE =
  /\d+(?:\.\d+)?\s*(?:[–—-]\s*\d+(?:\.\d+)?\s*)?(?:%|wt%|at%|ppm|ppb|cycles|mV|V|mA|A|eV|meV|kJ|J|mW|kW|W|mAh|Wh|mF|F|mmol|μmol|µmol|mol|mM|M|GPa|MPa|kPa|Pa|bar|mbar|GHz|MHz|kHz|Hz|mL|μL|µL|L|kg|mg|μg|µg|g|cm|nm|μm|µm|Å|h|min|s|K|°C|Ω)(?![\p{L}.])/u;
const ABSTRACT_HEDGE = /\[待核实\]|\babstract\b|摘要/i;
const ABBR_BEFORE_DOT =
  /(?:^|[\s([{"'])(?:Figs?|Eqs?|Secs?|Tabs?|Refs?|et\s+al|vs|ca|cf|e\.g|i\.e|approx|wt|at|vol|no|Nos?|Ch|Dr|Prof|St|Jr|Sr|[A-Z])\.$/i;

/** 中英文分句：兼容中文句末标点与数字 / 希腊字母 / 化学前缀开头的英文句，同时避开 Fig. / et al. 与 [@a; @b] 括号内分号 */
function splitSentences(text: string): string[] {
  const brackets: string[] = [];
  const masked = text.replace(/\[[^\]\n]*\]/g, (m) => {
    brackets.push(m);
    return `\uE000${brackets.length - 1}\uE001`;
  });
  const restore = (s: string) => s.replace(/\uE000(\d+)\uE001/g, (_, idx) => brackets[Number(idx)] ?? "");
  const out: string[] = [];
  for (const chunk of masked.split(/[。！？；]+/)) {
    let start = 0;
    const re = /([.!?;])\s+(?=[A-Z\d"'“‘(\uE000\p{Script=Greek}\p{Script=Han}]|[a-z]-)/gu;
    for (const m of chunk.matchAll(re)) {
      const idx = m.index ?? 0;
      const end = idx + 1;
      if (m[1] === "." && ABBR_BEFORE_DOT.test(chunk.slice(start, end))) continue;
      const piece = restore(chunk.slice(start, end)).trim();
      if (piece) out.push(piece);
      start = idx + m[0].length;
    }
    const tail = restore(chunk.slice(start)).trim();
    if (tail) out.push(tail);
  }
  return out;
}

/** 引了这个键、又带数值的句子所在行（表格行不算；hedge 命中的句子不算） */
function numericSentenceLines(paras: readonly Para[], key: string, hedge?: RegExp): number[] {
  const out: number[] = [];
  for (const p of paras) {
    if (p.heading || p.text.startsWith("|")) continue;
    for (const s of splitSentences(p.text)) {
      if (!manuscriptCitations(s).some((c) => c.key === key)) continue;
      if (!NUMERIC_VALUE.test(proseOnly(s)) || hedge?.test(s)) continue;
      out.push(p.line);
      break;
    }
  }
  return out;
}

/** 下标写成「_」：ΔG_H*、η_10（引用键、网址、行内代码、公式、图片路径先剥掉） */
const SUBSCRIPT_UNDERSCORE = /(?<![\p{L}\p{N}_])\p{L}[\p{L}\p{N}]{0,3}_[\p{L}\p{N}{]+\*?/u;
const XREF_PREFIX = /\b(?:Figures?|Figs?\.|Tables?|Tabs?\.|Sections?|Secs?\.|Equations?|Eqs?\.)\s*\[?-?@(?:fig|tbl|sec|eq)-/gi;
const HAND_SECTION_REF = /(?:\bSections?|\bSecs?\.|§)\s*\d+(?:\.\d+)*(?:\s*(?:[–—-]|and|&|,)\s*\d+(?:\.\d+)*)*/gi;
const FIG_OF_CITE = /\bFigs?\.\s*S?\d+[^;]*?\bof\s+\[@/g;

function stripCodeAndMath(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\$\$[\s\S]*?\$\$|\$[^$]*\$/g, " ");
}

function proseOnly(text: string): string {
  return stripCodeAndMath(text)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/g, " ")
    .replace(/-?@[\p{L}\p{N}_:.#$%&\-+?<>~/]+/gu, " ");
}

/** 写作规范「术语/缩写 | 写法约定 | 首次定义位置」表里的缩写：第一格括号里的（transition metal boride (TMB)），
 *  或写法约定开头的（「HER、OER，首次出现给全称」，全称按第一格「/」分开对应）；位置取第三格开头的节号 */
export function styleAbbreviations(text: string): { abbr: string; full: string; section: string }[] {
  const out: { abbr: string; full: string; section: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith("|") || /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(line)) continue;
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (cells.length < 3 || /术语|缩写/.test(cells[0]) && /首次/.test(cells[2] ?? "")) continue;
    const section = (cells[2] ?? "").match(/^\s*§?(\d+(?:\.\d+)*)/)?.[1] ?? "";
    const paren = cells[0].match(/^(.*?)\s*\(([A-Z][A-Za-z0-9₀-₉ₓ\-]*[A-Z0-9][A-Za-z0-9]*)\)\s*$/);
    if (paren && !/\s/.test(paren[2])) {
      out.push({ abbr: paren[2], full: paren[1].trim(), section });
      continue;
    }
    const lead = cells[1].match(/^([A-Z][A-Z0-9]{1,9}(?:\s*[、,，]\s*[A-Z][A-Z0-9]{1,9})*)(?=[，,；;。\s]|$)/);
    if (lead) {
      const abbrs = lead[1].split(/\s*[、,，]\s*/);
      const fulls = cells[0].split(/\s+\/\s+/);
      abbrs.forEach((a, i) => out.push({ abbr: a, full: fulls.length === abbrs.length ? fulls[i].trim() : "", section }));
    }
  }
  return out;
}

/** 这一步的主稿：步骤要交的 manuscript/ 下 md / qmd 排前，再是工作副本 manuscript/ 里列出来的；只取真在的，
 *  按 writingScanSourcePath 同口径挑（draft.md / manuscript/ 优先）。挑不出返回 null */
export function pickManuscript(artifacts: readonly string[], listed: readonly string[]): string | null {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
  // 过程文件、写作规范这类写作配套文件不是稿件：名单只在 manuscript-files.ts（与核验脚本同一份）
  const ok = (p: string) => /^manuscript\/.+\.(md|qmd)$/i.test(p) && !/[*?]/.test(p) && !isManuscriptHelper(p);
  const have = new Set(listed.map(norm));
  const ordered = [...new Set([...artifacts.map(norm), ...listed.map(norm)])].filter((p) => ok(p) && have.has(p));
  return writingScanSourcePath(ordered);
}

/** 写作扫描里被核对项取代的那几条（同一件事只报一次）：定稿占位、number-sections 下手写编号 */
export function supersededWritingIds(items: readonly CheckItem[]): Set<string> {
  const out = new Set<string>();
  if (items.some((i) => i.id === "draft-placeholder")) out.add("writing-placeholder-fig");
  if (items.some((i) => i.id === "draft-heading-number")) out.add("writing-manual-numbers");
  return out;
}

/** 只占位、还没写正文的段：HTML 注释、「[待写]」「（TODO）」一类标记、TODO / TBD 起头 */
const PLACEHOLDER_PARA = /^(<!--.*-->|[[(（【]\s*(待写|待补|待填|TODO|TBD)[^\])）】]*[\])）】]|(TODO|TBD)\b.*)$/iu;

/**
 * 初稿步骤卡统计行（2026-11-13 步骤卡统一设计稿）：Mesa 从稿件数，不靠 AI 自述。
 * 节 = 章级标题（摘要、参考文献一类不算），标题下（含小节）有正文段才算已写；sections.json 定了、稿件里还没出标题的也算进总数
 * （引言、结论不在 sections.json 里，出了标题才算）。引用按出现次数数（交叉引用不算），待定标记同核对 ⑦。
 * 首项是主进度；稿件里没有章级标题返回 null。
 */
export function draftProgressParts(text: string, sections?: string | null): string[] | null {
  const { paras } = readDoc(text);
  const heads = paras.filter((p) => p.heading);
  if (heads.length === 0) return null;
  const level = chapterLevelOf(heads);
  const strip = (t: string) => t.replace(/^[\s§]*\d+(\.\d+)*\.?\s*/, "");
  const chapters: { title: string; written: boolean }[] = [];
  let cur: { title: string; written: boolean } | null = null;
  for (const p of paras) {
    if (p.heading) {
      if (p.level < level) cur = null;
      else if (p.level === level) {
        cur = NON_BODY.test(strip(p.text)) ? null : { title: p.text, written: false };
        if (cur) chapters.push(cur);
      }
      continue;
    }
    if (cur && !PLACEHOLDER_PARA.test(p.text)) cur.written = true;
  }
  if (chapters.length === 0) return null;
  const notYet = (plannedSections(sections) ?? []).filter((t) => !chapters.some((c) => sameSection(c.title, t))).length;
  const total = chapters.length + notYet;
  const written = chapters.filter((c) => c.written).length;
  const parts = [written === total ? `已写 ${total} 节` : `已写 ${written} / ${total} 节`];
  const cites = manuscriptCitations(text).length;
  if (cites > 0) parts.push(`引用 ${cites} 处`);
  const unsure = [...text.matchAll(UNSURE)].length;
  if (unsure > 0) parts.push(`待定标记 ${unsure}`);
  return parts;
}
