/**
 * 文献检索/筛选步骤的评审主面纯逻辑。
 * 步骤卡上核对纳入/排除；审阅看要进课题的文件并保存。默认 included.md，JSON 进过程组。
 */

export type ReviewFileGroupId = "list" | "fetch" | "other" | "machine";

export const REVIEW_FILE_GROUP_LABEL: Record<ReviewFileGroupId, string> = {
  list: "清单",
  fetch: "待获取",
  other: "其他改动",
  machine: "过程",
};

export const REVIEW_FILE_GROUP_ORDER: ReviewFileGroupId[] = [
  "list",
  "fetch",
  "other",
  "machine",
];

const PREFERRED_REVIEW_FILES = [
  "papers/included.md",
  "papers/screening.md",
  "papers/to-fetch.md",
] as const;

const PREFERRED_DIFF_FILES = [
  "papers/to-fetch.md",
  "papers/screening.md",
] as const;

export function normReviewPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function fileName(path: string): string {
  const p = normReviewPath(path);
  return p.split("/").pop() ?? p;
}

export function isScreeningReviewStep(step: {
  workspaceName?: string | null;
  expectedArtifacts?: readonly string[] | null;
}): boolean {
  const name = step.workspaceName ?? "";
  if (name === "lit-search" || name === "lit-survey-search") return true;
  const arts = step.expectedArtifacts ?? [];
  return (
    arts.includes("papers/included.json") &&
    arts.some(
      (p) =>
        p === "papers/screening.md" ||
        p.endsWith("/screening.md") ||
        p === "papers/included.md",
    )
  );
}

/** 改动列表同时出现筛选记录与纳入清单时，按筛选审阅排文件，不必等步骤上下文。 */
export function shouldPrioritizeScreeningFiles(paths: readonly string[]): boolean {
  const n = paths.map(normReviewPath);
  const hasScreening = n.some((p) => p.endsWith("papers/screening.md"));
  const hasIncluded = n.some(
    (p) => p.endsWith("papers/included.md") || p.endsWith("papers/included.json"),
  );
  return hasScreening && hasIncluded;
}

export function reviewFileGroup(path: string): ReviewFileGroupId {
  const p = normReviewPath(path);
  const base = fileName(p);
  if (base === "included.md" || base === "screening.md") return "list";
  if (base === "to-fetch.md" || base === "to-fetch.ris") return "fetch";
  if (isReviewProcessFile(p)) return "machine";
  return "other";
}

/**
 * 「文件」页签只留给人看的检索产物。脚本、缓存、任务书、技能说明不进这一栏。
 */
export function isScreeningReviewFile(path: string): boolean {
  const base = fileName(normReviewPath(path));
  return (
    base === "included.md" ||
    base === "included.json" ||
    base === "screening.md" ||
    base === "to-fetch.md" ||
    base === "to-fetch.ris" ||
    base === "endnote-import.ris"
  );
}

/** 检索过程文件：缓存、脚本、配置。不进清单主面。 */
export function isReviewProcessFile(path: string): boolean {
  const p = normReviewPath(path);
  const base = fileName(p);
  if (
    base === "included.json" ||
    base === "help-wanted.md" ||
    base === "zotero-sync.md" ||
    base === ".gitignore" ||
    base === ".gitattributes"
  ) {
    return true;
  }
  if (p.includes("/api-cache/") || p.endsWith("/api-cache")) return true;
  if (
    p === ".ccode" ||
    p.startsWith(".ccode/") ||
    p.includes("/.ccode/") ||
    p === "scripts" ||
    p.startsWith("scripts/") ||
    p.includes("/scripts/")
  ) {
    return true;
  }
  return base.endsWith(".py");
}

/** 检索过程只看查了哪些库、命中多少。验收摘要和 G1 整段不进这一页。 */
export function screeningSearchLog(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const heading = /^(#{1,6})\s+(?:检索日志|检索过程|各库检索)/;
  const table = /^\s*\|?\s*(?:\*\*)?(?:日期|库|来源)(?:\*\*)?\s*\|/;
  let start = lines.findIndex((line) => heading.test(line.trim()));
  let level = 0;
  if (start >= 0) {
    level = lines[start].match(/^#+/)?.[0].length ?? 0;
  } else {
    start = lines.findIndex((line) => table.test(line));
  }
  if (start < 0) return "";
  const out: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    if (i > start && level > 0 && new RegExp(`^#{1,${level}}\\s`).test(lines[i])) break;
    if (i > start && level === 0 && /^#{1,6}\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n").trim();
}

export function isScreeningListFile(path: string): boolean {
  const base = fileName(path);
  return base === "included.md" || base === "included.json";
}

export function preferredReviewPath(paths: readonly string[]): string | null {
  if (!paths.length) return null;
  const normalized = paths.map((p) => ({ raw: p, n: normReviewPath(p) }));
  for (const want of PREFERRED_REVIEW_FILES) {
    const hit = normalized.find((p) => p.n === want || p.n.endsWith(`/${want}`));
    if (hit) return hit.raw;
  }
  const list = normalized.filter((p) => reviewFileGroup(p.n) === "list");
  if (list.length) return list[0].raw;
  return paths[0];
}

/** 纳入表已经覆盖清单，diff 默认打开待获取或筛选记录，避免和表重复。 */
export function preferredDiffPath(paths: readonly string[]): string | null {
  const rest = paths.filter((p) => !isScreeningListFile(p));
  if (!rest.length) return null;
  const normalized = rest.map((p) => ({ raw: p, n: normReviewPath(p) }));
  for (const want of PREFERRED_DIFF_FILES) {
    const hit = normalized.find((p) => p.n === want || p.n.endsWith(`/${want}`));
    if (hit) return hit.raw;
  }
  return rest[0];
}

export function stackedReviewPaths(paths: readonly string[], activePath: string | null): string[] {
  const rest = sortReviewPaths(
    paths.filter((p) => !isScreeningListFile(p) || p === activePath),
  );
  const preferred = preferredDiffPath(rest);
  if (!preferred) return rest;
  return [preferred, ...rest.filter((p) => p !== preferred)];
}

function preferredRank(path: string): number {
  const n = normReviewPath(path);
  const idx = PREFERRED_REVIEW_FILES.findIndex(
    (want) => n === want || n.endsWith(`/${want}`),
  );
  return idx < 0 ? 99 : idx;
}

export function sortReviewPaths(paths: readonly string[]): string[] {
  return [...paths].sort((a, b) => {
    const ga = REVIEW_FILE_GROUP_ORDER.indexOf(reviewFileGroup(a));
    const gb = REVIEW_FILE_GROUP_ORDER.indexOf(reviewFileGroup(b));
    if (ga !== gb) return ga - gb;
    const pa = preferredRank(a);
    const pb = preferredRank(b);
    if (pa !== pb) return pa - pb;
    return normReviewPath(a).localeCompare(normReviewPath(b), "zh");
  });
}

export function groupReviewFiles<T extends { path: string }>(
  files: readonly T[],
): { id: ReviewFileGroupId; label: string; files: T[] }[] {
  const buckets: Record<ReviewFileGroupId, T[]> = {
    list: [],
    fetch: [],
    other: [],
    machine: [],
  };
  for (const file of files) buckets[reviewFileGroup(file.path)].push(file);
  for (const id of REVIEW_FILE_GROUP_ORDER) {
    const order = sortReviewPaths(buckets[id].map((f) => f.path));
    const map = new Map(buckets[id].map((f) => [f.path, f]));
    buckets[id] = order.map((p) => map.get(p)!);
  }
  return REVIEW_FILE_GROUP_ORDER
    .map((id) => ({
      id,
      label: REVIEW_FILE_GROUP_LABEL[id],
      files: buckets[id],
    }))
    .filter((g) => g.files.length > 0);
}

export interface IncludedRecord {
  id: string;
  title: string;
  decision: string;
  reason: string;
  authors: string;
  year: string;
  source: string;
  url: string;
  /** 检索时一次查全，纳入时原样追加，不再另查。 */
  volume: string;
  issue: string;
  pages: string;
  date: string;
  epubDate: string;
  articleType: string;
  issn: string;
  journalAbbreviation: string;
  abstract: string;
  keywords: string;
  language: string;
}

function stringField(rec: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function keywordsOf(rec: Record<string, unknown>): string {
  const direct = stringField(rec, ["keywords", "keyword"]);
  if (direct) return direct;
  const list = rec.keywords;
  if (!Array.isArray(list)) return "";
  return list.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean).join("; ");
}

function authorsOf(rec: Record<string, unknown>): string {
  const direct = stringField(rec, ["authors", "author"]);
  if (direct) return direct;
  const list = rec.authors;
  if (Array.isArray(list)) {
    return list
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (item && typeof item === "object") {
          const row = item as Record<string, unknown>;
          return stringField(row, ["name", "literal"]) || [row.family, row.given].filter((p) => typeof p === "string").join(" ");
        }
        return "";
      })
      .filter(Boolean)
      // 「;」分隔：检索步写的是「姓, 名」数组，逗号拼起来 RIS 就拆不开、整串成了一个作者（2026-10-22）
      .join("; ");
  }
  return "";
}

function yearOf(rec: Record<string, unknown>): string {
  const value = rec.year ?? rec.date ?? rec.published;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") {
    const m = value.match(/\b(19|20)\d{2}\b/);
    return m ? m[0] : value.trim();
  }
  return "";
}

function urlOf(rec: Record<string, unknown>, id: string): string {
  // url 写着「待补」时往后找 doi 字段（检索步脚本没有链接时写待补）
  const direct =
    ["url", "link", "doi"]
      .map((key) => rec[key])
      .find((v): v is string => typeof v === "string" && v.trim() !== "" && v.trim() !== "待补")
      ?.trim() ?? "";
  if (/^https?:\/\//i.test(direct)) return direct;
  if (direct.startsWith("10.")) return `https://doi.org/${direct}`;
  const doi = id.startsWith("doi:") ? id.slice(4) : /^10\.\d{4,}/.test(id) ? id : "";
  return doi ? `https://doi.org/${doi}` : "";
}

/** IUPAC 元素符号。双字母优先，避免把正文词切成元素。 */
const ELEMENT_SYMBOLS = new Set(
  "H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og".split(" "),
);

function isElementSymbol(token: string): boolean {
  return ELEMENT_SYMBOLS.has(token);
}

/** 下一个字母若还在拼单词（Cobalt、Complex），这里就不是元素。单独的计量 x 除外。 */
function continuesWord(text: string, index: number): boolean {
  const next = text[index] ?? "";
  if (!/[a-z]/.test(next)) return false;
  if (next === "x" && !/[A-Za-z]/.test(text[index + 1] ?? "")) return false;
  return true;
}

/**
 * 整段都能拆成元素、系数、计量 x 或键，才算化学式。
 * 做法同 ComProScanner 的 formula prefix：双字母优先，碰到单词续写就停。
 */
function formulaCovers(text: string): boolean {
  let pos = 0;
  const greek = /^[α-ωΑ-Ω]+/.exec(text);
  if (greek) pos = greek[0].length;
  while (pos < text.length) {
    const rest = text.slice(pos);
    const ch = rest[0] ?? "";
    if ("\u2013\u2212-/".includes(ch)) {
      pos += 1;
      continue;
    }
    if (ch === "x") {
      const afterX = rest.slice(1);
      const nextTwo = afterX.slice(0, 2);
      const nextIsElement = (nextTwo.length === 2 && isElementSymbol(nextTwo) && !continuesWord(afterX, 2))
        || (isElementSymbol(afterX[0] ?? "") && !continuesWord(afterX, 1));
      if (nextIsElement || !/[A-Za-z]/.test(afterX[0] ?? "")) {
        pos += 1;
        continue;
      }
    }
    const num = /^(?:\d+(?:\.\d+)?)(?:\/\d+(?:\.\d+)?)?/.exec(rest);
    if (num && (pos === 0 || /[A-Za-z)\u2013\u2212/-]/.test(text[pos - 1] ?? ""))) {
      pos += num[0].length;
      continue;
    }
    const two = rest.slice(0, 2);
    if (two.length === 2 && isElementSymbol(two) && !continuesWord(text, pos + 2)) {
      pos += 2;
      continue;
    }
    const one = rest.slice(0, 1);
    if (isElementSymbol(one) && !continuesWord(text, pos + 1)) {
      pos += 1;
      continue;
    }
    return false;
  }
  return text.length > 0;
}

function hasRealElement(token: string): boolean {
  const body = token.replace(/^[α-ωΑ-Ω]+/, "").replace(/[\u2013\u2212-]+$/u, "");
  let i = 0;
  let found = false;
  while (i < body.length) {
    const two = body.slice(i, i + 2);
    if (two.length === 2 && /^[A-Z][a-z]$/.test(two) && isElementSymbol(two) && !continuesWord(body, i + 2)) {
      found = true;
      i += 2;
      continue;
    }
    const one = body[i] ?? "";
    if (/[A-Z]/.test(one) && isElementSymbol(one) && !continuesWord(body, i + 1) && !/[A-Z]/.test(body[i + 1] ?? "")) {
      found = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return found;
}

export function isFormulaToken(token: string): boolean {
  const body = token.replace(/^[α-ωΑ-Ω]+/, "");
  const core = body.replace(/[\u2013\u2212-]+$/u, "");
  if (!core) return false;
  if (core === "x" || /^[\u2013\u2212-]?x$/.test(core)) return true;
  // \u7eaf\u6570\u5b57 token \u53ea\u8ba4 1\u20132 \u4f4d\uff08\u5316\u5b66\u8ba1\u91cf\uff09\uff1a3 \u4f4d\u4ee5\u4e0a\u662f\u5e74\u4efd/\u6e29\u5ea6/\u9875\u7801\u4e00\u7c7b\u7684\u6563\u6587\u6570\u5b57\uff0c
  // \u4e0d\u80fd\u5f53\u5f0f\u5b50\u6210\u5206\u53c2\u4e0e\u7c98\u63a5\uff08\u300cIn 2020,\u300d\u4f1a\u88ab\u62fc\u6210 In2020\uff0c2026-10-11 \u5bf9\u6297\u5ba1\u67e5\u5b9e\u8bc1\uff09
  if (/^(?:\d{1,2}(?:\.\d+)?)(?:\/\d{1,2}(?:\.\d+)?)?(?:[\u2013\u2212-]x?)?$/.test(core)) return true;
  if (/^\d{1,2}\.\d{1,2}$/.test(core)) return true;
  // 三个以上全大写是缩写（HCP）。两个全大写且能拆成元素才算式子（BO）。
  if (/^[A-Z][a-z]?\d/.test(core) && formulaCovers(core) && hasRealElement(core)) return true;
  if (/^[A-Z][a-z]?\d+-[A-Z]{2,4}B\d+$/.test(core)) return true;
  if (/^[A-Z]{3,}$/.test(core)) return false;
  if (/^[A-Z]{2}$/.test(core) && !hasRealElement(core)) return false;
  return formulaCovers(core) && hasRealElement(core);
}

const SUB_MARKS: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
  "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "x": "ₓ", "y": "ᵧ",
};
const SUP_MARKS: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻",
};

function shiftMarks(text: string, table: Record<string, string>): string {
  return [...text].map((ch) => table[ch] ?? ch).join("");
}

/**
 * 化学式数字收成下标，电荷收成上标。和 endnote-bridge 的 clean 同一条：
 * 元素或右括号后面的数字（含小数、分数）才是下标；2D、相号 -191、变量 n 不动。
 * 计量 x 和下标之间的连接号也收成下标，1–x 整段在一起。
 */
function markFormulaDigits(formula: string): string {
  // 复合物末位「化学计量数+电荷」只把 + 上标，数字留给下标规则（Mg2Cl3+ → Mg₂Cl₃⁺，
  // 不是 Mg₂Cl³⁺）。须在数字转下标之前做。
  formula = formula.replace(/((?:[A-Z][a-z]?\d{1,2}){2,})\+/g, "$1⁺");
  formula = formula
    .replace(/(?<![A-Za-z])x(?![A-Za-z])/g, "ₓ")
    .replace(/([A-Z][a-z]?)x(?![a-z])/g, (match, element: string) =>
      isElementSymbol(element) ? `${element}ₓ` : match,
    );
  // 位数收到 1–2 位：化学计量鲜有 3 位以上，而「In 2020,」「At 300 K」这类散文高频句式
  // 会被 3+ 位整段下标（2026-10-11 对抗审查实证）。
  const coefficient = /^(\d{1,2}(?:\.\d+)?(?:\/\d{1,2}(?:\.\d+)?)?)(?![0-9+])/;
  const atom = /^([A-Z][a-z]?|[α-ωΑ-Ω])/ ;
  const sub = new Set([..."₀₁₂₃₄₅₆₇₈₉ₓᵧ"]);
  const chars = [...formula];
  const out: string[] = [];
  let i = 0;
  while (i < chars.length) {
    const rest = chars.slice(i).join("");
    const el = atom.exec(rest);
    const prev = out[out.length - 1] ?? "";
    const beforeIsFormula = prev === "" || prev === ")" || sub.has(prev) || /[A-Za-z\s\u2013\u2212ₓᵧ-]/.test(prev);
    const symbolOk = Boolean(el) && (isElementSymbol(el?.[1] ?? "") || /[α-ωΑ-Ω]/.test(el?.[1] ?? ""));
    if (el && symbolOk && beforeIsFormula) {
      const after = rest.slice(el[1].length);
      // 连写式：Zr1-xTMxB2。Crossref 纯文本会把 Zr1-xTMxB2 收成 Zr1-TMB2。先于单个数字。
      const varied = /^(\d+)-x(?![a-z])/.exec(after);
      if (varied && isElementSymbol(el[1])) {
        out.push(`${el[1]}${shiftMarks(varied[1], SUB_MARKS)}₋ₓ`);
        i += el[1].length + varied[0].length;
        continue;
      }
      const glued = /^(\d+)[ \t]*-[ \t]*([A-Z]{2,4})B(\d+)/.exec(after);
      if (glued && isElementSymbol(el[1])) {
        out.push(`${el[1]}${shiftMarks(glued[1], SUB_MARKS)}₋ₓ${glued[2]}ₓB${shiftMarks(glued[3], SUB_MARKS)}`);
        i += el[1].length + glued[0].length;
        continue;
      }
      const gap = /^[ \t]+/.exec(after)?.[0].length ?? 0;
      const num = coefficient.exec(after.slice(gap));
      if (num && (gap > 0 || !/[a-z]/.test(chars[i + el[1].length] ?? ""))) {
        out.push(el[1] + shiftMarks(num[1], SUB_MARKS));
        i += el[1].length + gap + num[1].length;
        continue;
      }
    }
    const ch = chars[i] ?? "";
    const ahead = chars.slice(i).join("");
    const stoichiometry = /^([₀₁₂₃₄₅₆₇₈₉])([\u2013\u2212-])x(?![A-Za-z])/.exec(ahead);
    if (stoichiometry) {
      out.push(stoichiometry[1], "₋", "ₓ");
      i += stoichiometry[0].length;
      continue;
    }
    out.push(ch);
    i += 1;
  }
  let text = out.join("");
  text = text.replace(/([₀₁₂₃₄₅₆₇₈₉ₓᵧ])[ \t]+([A-Z][a-z]?)(?![a-z])/g, "$1$2");
  text = text.replace(/([₀₁₂₃₄₅₆₇₈₉ₓᵧ])[ \t]+\)/g, "$1)");
  text = text.replace(/(\d{1,2}\+|\d{1,2}-(?!-))(?![A-Za-z0-9])/g, (charge) => shiftMarks(charge, SUP_MARKS));
  return text;
}

/** 整句里已经成形的化学式再收一次。摘要里的「Co₂ B.」不靠分词。 */
function tightenMarkedFormula(text: string): string {
  const chars = [...text];
  const sub = new Set("₀₁₂₃₄₅₆₇₈₉ₓᵧ");
  const bond = new Set(["\u2013", "\u2212", "-"]);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] ?? "";
    const prev = out[out.length - 1] ?? "";
    const next = chars[i + 1] ?? "";
    if (ch === "x" && !/[A-Za-z]/.test(next) && (sub.has(prev) || bond.has(prev) || "–−-".includes(prev))) {
      if (bond.has(prev) || "–−-".includes(prev)) out[out.length - 1] = "₋";
      out.push("\u2093");
      continue;
    }
    const nextWord = chars.slice(i + 1).join("").match(/^[A-Za-z]+/)?.[0] ?? "";
    if (ch === " " && sub.has(prev) && isElementSymbol(nextWord)) {
      continue;
    }
    out.push(ch);
  }
  return out.join("");
}

/**
 * 题名显示。不改 included.json。
 * Mac 把 U+F8FF 画成苹果；出版数据里它和制表线常是化学键。
 * 连续几个词都能拆成化学式时才去掉它们之间的空格，并把数字收成上下标。
 */
export function displayCitationTitle(title: string): string {
  // 标识符整段豁免：题名/摘要里的 DOI/URL 不做化学美化（与 bridge.py clean() 同款停车手法；
  // 哨兵用私用区单字符，不用数字编码——数字会被上下标转换改写导致恢复失配、URL 静默丢失）。
  const parked: string[] = [];
  const prepared = title
    .replace(/[\x00\uE000-\uE3FF]/g, "")
    .replace(/(https?:\/\/[^<>\s]+|(?<![\w.])10\.\d{4,9}\/[^<>\s]+)/gi, (hit) => {
      parked.push(hit);
      return String.fromCharCode(0xe000 + parked.length - 1);
    })
    .replace(/[\uF8FF\u2500]/g, "–")
    .replace(/\u2010/g, "-")
    // 先剥斜体粗体，再吃掉标签前的排版空格（MgCl <sub>2</sub> → MgCl₂），最后收上下标。
    // 标签内容以数字/正负号/x/y 开头、前一字符是字母数字或右括号才吃，纯文字不受影响。
    .replace(/<\/?(?:i|b|em|strong)>/gi, "")
    .replace(/(?<=[A-Za-z0-9)\]])[ \t ]+(?=<[sS][uU][bB]>[+\-−0-9xy]|<[sS][uU][pP]>[+\-−0-9xy])/g, "")
    .replace(/<sup>(.*?)<\/sup>/gi, (_m, inner: string) => shiftMarks(inner, SUP_MARKS))
    .replace(/<sub>(.*?)<\/sub>/gi, (_m, inner: string) => shiftMarks(inner, SUB_MARKS))
    // 复合物末位是「化学计量数+电荷」而非高价电荷：Mg2Cl3+ 是 [Mg₂(μ-Cl)₃]⁺，只把 + 上标，
    // 数字留给下标规则（2026-10-11 实证：整串读成 Mg₂Cl³⁺，化学含义翻转）。
    .replace(/((?:[A-Z][a-z]?\d{1,2}){2,})\+/g, "$1⁺")
    // 电荷上标常以连字符形容词收尾：Mg2+-Conducting、Li+-based。'-' 不在豁免之列；
    // 负电荷不吞双连字符（C60--covered 不是 C⁶⁰⁻）。
    .replace(/([A-Za-z])(\d{1,2}\+|\d{1,2}-(?!-))(?![A-Za-z0-9])/g, (_m, atom: string, charge: string) => atom + shiftMarks(charge, SUP_MARKS))
    // 存量已损坏形态的愈合：老产物里「字母+空格+上下标字」（MgCl ₂、cm ⁻²）把空格吃掉。
    // 正常散文不含 Unicode 上下标字符，此规则只命中被旧版污染过的题录。
    .replace(/(?<=[A-Za-z0-9)\]])[ \t ]+(?=[₀₁₂₃₄₅₆₇₈₉⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻])/g, "");
  const text = prepared.replace(/[ \u00A0]+([,.;:!?])/g, "$1");
  const raw = text.split(/(\s+|[()[\]])/).flatMap((part) => {
    if (/^\s+$/.test(part) || /^[()[\]]$/.test(part)) return [part];
    return part.match(/\d+(?:\.\d+)?[\u2013\u2212-]?|[\u2013\u2212-]|[^\s()[\]]+/g) ?? [part];
  });
  const out: string[] = [];
  let i = 0;
  while (i < raw.length) {
    const token = raw[i] ?? "";
    if (!isFormulaToken(token)) {
      out.push(token);
      i += 1;
      continue;
    }
    if (/[\dx]/i.test(token) && (formulaCovers(token.replace(/[\u2013\u2212-]+$/u, "")) && hasRealElement(token) || /^[A-Z][a-z]?\d+-[A-Z]{2,4}B\d+$/.test(token))) {
      out.push(markFormulaDigits(token));
      i += 1;
      continue;
    }
    const parts = [token];
    let j = i + 1;
    let end = i;
    while (j < raw.length) {
      const glue: string[] = [];
      let k = j;
      while (k < raw.length && /^(\s+|[\u2013\u2212-])$/.test(raw[k] ?? "")) {
        if (/^[\u2013\u2212-]$/.test(raw[k] ?? "")) glue.push(raw[k] ?? "");
        k += 1;
      }
      if (k >= raw.length) break;
      const next = raw[k] ?? "";
      if (!isFormulaToken(next)) break;
      parts.push(...glue, next);
      end = k;
      j = k + 1;
    }
    const joined = parts.join("");
    const eachIsFormula = parts.every((part) => hasRealElement(part) || part === "x" || /^\d/.test(part));
    if (parts.length > 1 && eachIsFormula && /[\dx]/.test(joined) && formulaCovers(joined) && hasRealElement(joined)) {
      let prefix = "";
      let cursor = out.length;
      const pulled: string[] = [];
      let sawSpace = false;
      while (cursor > 0) {
        const piece = out[cursor - 1] ?? "";
        if (/^\s+$/.test(piece)) {
          sawSpace = true;
          cursor -= 1;
          continue;
        }
        const formulaPiece = piece === "x" || /^\d[\u2013\u2212-]?$/.test(piece) || (/^[A-Z][a-z]?$/.test(piece) && hasRealElement(piece));
        if (!formulaPiece) break;
        pulled.unshift(piece);
        sawSpace = false;
        cursor -= 1;
      }
      if (pulled.length > 0) {
        prefix = pulled.join("");
        const dropFrom = sawSpace ? cursor + 1 : cursor;
        out.splice(dropFrom, out.length - dropFrom);
      }
      out.push(markFormulaDigits(prefix + joined));
      i = end + 1;
      continue;
    }
    out.push(token);
    i += 1;
  }
  return tightenMarkedFormula(out.join(""))
    .replace(/([([{])[ \u00A0]+/g, "$1")
    .replace(/[ \u00A0]+([)\]}])/g, "$1")
    .replace(/₁–x/g, "₁₋ₓ")
    .replace(/([A-Z][a-z]?)(\d+)-([A-Z]{2,4})B(\d+)/g, (_m, el: string, a: string, tm: string, b: string) =>
      isElementSymbol(el) ? `${el}${shiftMarks(a, SUB_MARKS)}₋ₓ${tm}ₓB${shiftMarks(b, SUB_MARKS)}` : _m,
    )
    .replace(/([A-Z][a-z]?)(\d+)(?=[/B])/g, (_m, el: string, digits: string) =>
      isElementSymbol(el) ? el + shiftMarks(digits, SUB_MARKS) : _m,
    )
    .replace(/([₀₁₂₃₄₅₆₇₈₉])[ \t]*[A-Z][ \t]+(\d+(?:\.\d+)?)/g, (_m, lead: string, rest: string) => `${lead}T${shiftMarks(rest, SUB_MARKS)}`)
    .replace(/([₀₁₂₃₄₅₆₇₈₉])–ₓ/g, "$1₋ₓ")
    .replace(/([A-Z][a-z]?) x(?![A-Za-z])/g, (match, element: string) =>
      isElementSymbol(element) ? `${element}ₓ` : match,
    )
    .replace(/([A-Z]) x(?![A-Za-z])/g, "$1ₓ")
    .replace(/([A-Z][a-z]?)x([A-Z][a-z]?)yB/g, (match, left: string, right: string) =>
      isElementSymbol(left) && isElementSymbol(right) ? `${left}ₓ${right}ᵧB` : match,
    )
    .replace(/([A-Z][a-z]?) n \+1/g, (match, element: string) =>
      isElementSymbol(element) ? `${element}ₙ₊₁` : match,
    )
    .replace(/([A-Z][a-z]?) n(?![A-Za-z])/g, (match, element: string) =>
      isElementSymbol(element) ? `${element}ₙ` : match,
    )
    .replace(/([A-Z][a-z]?) (\d+)(?= -\d)/g, (match, element: string, digits: string) =>
      isElementSymbol(element) ? `${element}${shiftMarks(digits, SUB_MARKS)}` : match,
    )
    .replace(/TMB (\d+)/g, (_m, digits: string) => `TMB${shiftMarks(digits, SUB_MARKS)}`)
    .replace(/\)(\d+)/g, (_m, digits: string) => `)${shiftMarks(digits, SUB_MARKS)}`)
    .replace(/(\d+)A cm [−-]2(?![0-9A-Za-z])/g, (_m, amount: string) => `${amount} A cm⁻²`)
    .replace(/cm ?[−–-]2(?![0-9A-Za-z])/g, "cm⁻²")
    .replace(/([a-z]) -(?=[A-Z])/g, "$1-")
    .replace(/[ \t]+ₓ/g, "ₓ")
    .replace(/([₀₁₂₃₄₅₆₇₈₉])\.(\d)/g, (_m, lead: string, tail: string) => `${lead}\u2024${shiftMarks(tail, SUB_MARKS)}`)
    .replace(/([A-Z][a-z]?)(\d+)(?=[@A-Z])/g, (match, element: string, digits: string) =>
      isElementSymbol(element) ? element + shiftMarks(digits, SUB_MARKS) : match,
    )
    .replace(/([ₙ₊₁])[ \t]+(?=[A-Z])/g, "$1")
    .replace(/([₀₁₂₃₄₅₆₇₈₉ₓᵧⁿ])[ \t]+-(?=[A-Za-z0-9])/g, "$1-")
    .replace(/([₀₁₂₃₄₅₆₇₈₉])\/(\d+)/g, (_m, lead: string, tail: string) => `${lead}/${shiftMarks(tail, SUB_MARKS)}`)
    .replace(/([₀₁₂₃₄₅₆₇₈₉])[ \t]+([A-Z](?![a-z]{2}))/g, "$1$2")
    .replace(/T[ \t]+z(?![A-Za-z])/g, "Tz")
    .replace(/([₀₁₂₃₄₅₆₇₈₉])([A-Z][a-z]?)(\d+)/g, (_m, lead: string, element: string, digits: string) =>
      isElementSymbol(element) ? `${lead}${element}${shiftMarks(digits, SUB_MARKS)}` : _m,
    )
    .replace(/([A-Z]{2,3})(\d+)/g, (_m, mark: string, digits: string) => `${mark}${shiftMarks(digits, SUB_MARKS)}`)
    .replace(/([A-Z][a-z]?)(\d+)(?=-)/g, (match, element: string, digits: string) =>
      isElementSymbol(element) ? `${element}${shiftMarks(digits, SUB_MARKS)}` : match,
    )
    // 放回停车的标识符原文
    .replace(/[\uE000-\uE3FF]/g, (hit) => parked[hit.charCodeAt(0) - 0xe000] ?? hit);
}

/** Agent 常把纳入写成 include。清单、计数和移出都认 included。 */
export function canonicalScreeningDecision(value: string): string {
  const decision = value.trim().toLowerCase();
  if (decision === "include" || decision === "included") return "included";
  if (decision === "exclude" || decision === "excluded") return "excluded";
  if (decision === "pending") return "pending";
  return value.trim();
}

function asRows(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  const rec = data as Record<string, unknown>;
  for (const key of ["items", "records", "rows"]) {
    if (Array.isArray(rec[key])) return rec[key] as unknown[];
  }
  return [];
}

export function parseIncludedRecords(text: string): IncludedRecord[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const out: IncludedRecord[] = [];
  for (const row of asRows(data)) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : "";
    const title = typeof rec.title === "string" ? rec.title : "";
    if (!title) continue;
    out.push({
      id,
      title,
      decision: canonicalScreeningDecision(typeof rec.decision === "string" ? rec.decision : ""),
      reason: typeof rec.reason === "string" ? rec.reason : "",
      authors: authorsOf(rec),
      year: yearOf(rec),
      source: stringField(rec, ["source", "venue", "journal", "container"]),
      url: urlOf(rec, id),
      volume: stringField(rec, ["volume", "vl"]),
      issue: stringField(rec, ["issue", "number"]),
      pages: stringField(rec, ["pages", "page"]),
      date: stringField(rec, ["date", "published"]),
      epubDate: stringField(rec, ["epubDate", "epubdate", "publishedOnline"]),
      articleType: stringField(rec, ["articleType", "articletype", "type"]),
      issn: stringField(rec, ["issn", "isbn"]),
      journalAbbreviation: stringField(rec, ["journalAbbreviation", "journalabbreviation", "shortJournal"]),
      abstract: stringField(rec, ["abstract"]),
      keywords: keywordsOf(rec),
      language: stringField(rec, ["language"]),
    });
  }
  return out;
}

export interface ScreeningCounts {
  total: number;
  included: number;
  pending: number;
  toFetch: number;
}

/** 清单里每篇都已纳入或排除。空清单、空白判定不算拍完。 */
export function pendingConfirmCleared(records: readonly IncludedRecord[]): boolean {
  return (
    records.length > 0 &&
    records.every((row) => row.decision === "included" || row.decision === "excluded")
  );
}

export function screeningCounts(
  records: readonly IncludedRecord[],
  toFetch: number,
): ScreeningCounts {
  return {
    total: records.length,
    included: records.filter((r) => r.decision === "included").length,
    pending: records.filter((r) => r.decision === "pending").length,
    toFetch,
  };
}

export function screeningCountLine(counts: ScreeningCounts): string {
  const parts = [`纳入 ${counts.included}`, `待确认 ${counts.pending}`];
  if (counts.toFetch > 0) parts.push(`待获取 ${counts.toFetch}`);
  parts.push(`共 ${counts.total} 篇`);
  return parts.join(" · ");
}

export function extraDecisionsFromSummary(summaryText: string): string[] {
  const out: string[] = [];
  for (const raw of summaryText.split(/\r?\n/)) {
    const line = raw.trim();
    const m =
      /^(?:\d+\.\s*)?(?:\*\*)?(?:需要人决定|待人决定)(?:\*\*)?[：:]\s*(.+)$/.exec(
        line,
      );
    if (!m) continue;
    for (const part of m[1].split(/[；;]/)) {
      const t = part.trim().replace(/[。．]$/, "");
      if (t) out.push(t);
    }
  }
  return out;
}

function coveredByCounts(text: string, counts: ScreeningCounts): boolean {
  const n = text.toLowerCase();
  if (counts.pending > 0 && /pending|待确认/.test(n)) return true;
  if (counts.toFetch > 0 && /付费|全文|待获取|to-fetch/.test(n)) return true;
  return false;
}

export function screeningDecisionLines(
  counts: ScreeningCounts,
  extras: readonly string[] = [],
): string[] {
  const lines: string[] = [];
  if (counts.pending > 0) lines.push(`确认 ${counts.pending} 篇 pending 是否纳入`);
  if (counts.toFetch > 0) lines.push(`获取 ${counts.toFetch} 篇付费全文`);
  for (const extra of extras) {
    const t = extra.trim();
    if (!t || coveredByCounts(t, counts)) continue;
    if (lines.includes(t)) continue;
    lines.push(t);
  }
  return lines;
}

/** 这一屏唯一的当前动作；付费全文和库授权不是现在的事。 */
export function screeningNowLine(counts: ScreeningCounts): string {
  if (counts.pending > 0) return `现在：核对 ${counts.pending} 篇待确认`;
  if (counts.total === 0) return "现在：清单是空的，先看筛选记录";
  return "现在：看完纳入清单，记下筛选决定";
}

export function screeningReviewNote(counts: ScreeningCounts): string {
  if (counts.pending > 0) {
    return `下面是要进课题的文件。还有 ${counts.pending} 篇待确认，先回步骤卡核对。`;
  }
  return "下面是要进课题的文件。看过就点右上角保存进项目。";
}

export function screeningLaterLines(
  counts: ScreeningCounts,
  extras: readonly string[] = [],
): string[] {
  const lines: string[] = [];
  if (counts.toFetch > 0) {
    lines.push(`${counts.toFetch} 篇付费全文，保存进项目后再获取`);
  }
  for (const extra of extras) {
    const t = extra.trim();
    if (!t || coveredByCounts(t, counts)) continue;
    if (lines.includes(t)) continue;
    lines.push(t);
  }
  return lines;
}

export function blockerPrimaryText(
  blockers: readonly { text: string }[],
): string {
  if (!blockers.length) return "";
  if (blockers.length === 1) return blockers[0].text;
  return `${blockers[0].text}（另有 ${blockers.length - 1} 项）`;
}

export type DecisionTone = "ok" | "warn" | "muted";

export function decisionBadge(decision: string): {
  label: string;
  tone: DecisionTone;
} {
  if (decision === "included") return { label: "纳入", tone: "ok" };
  if (decision === "pending") return { label: "待确认", tone: "warn" };
  if (decision === "excluded") return { label: "排除", tone: "muted" };
  return { label: decision || "未标", tone: "muted" };
}

/**
 * tone → 文字色类名。纳入清单里「待确认」是唯一需要用户再看一眼的行，
 * 早先这里把三档都渲染成 `text-ok-text`，待确认和排除看起来都像已通过。
 */
export function decisionToneClass(tone: DecisionTone): string {
  if (tone === "ok") return "text-ok-text";
  if (tone === "warn") return "text-warn-text";
  return "text-l4";
}

export type ScreeningTableFilter = "pending" | "included" | "all";

export function defaultScreeningTableFilter(
  counts: ScreeningCounts,
): ScreeningTableFilter {
  if (counts.pending > 0) return "pending";
  if (counts.included > 0) return "included";
  return "all";
}

export function filterIncludedRecords(
  records: readonly IncludedRecord[],
  filter: ScreeningTableFilter,
): IncludedRecord[] {
  if (filter === "all") return [...records];
  return records.filter((row) => row.decision === filter);
}

export function includedRecordMeta(row: IncludedRecord): string {
  return [row.year, shortAuthors(row.authors), row.source].filter(Boolean).join(" · ");
}

/** 作者串缩成前 keep 位 +「等 N 人」：清单行一行放得下（完整作者进悬停）。
 *  认三种写法：`;` 分隔；「姓, 名, 姓, 名」逗号对（每段都是单个词且段数为偶数时两两成对）；
 *  「名 姓, 名 姓」每段一人。已带 et al. / 等 的原样返回。 */
export function shortAuthors(authors: string | undefined | null, keep = 3): string {
  const raw = (authors ?? "").trim();
  if (!raw || /(?:et al\.?|等)\s*$/i.test(raw)) return raw;
  let names: string[];
  if (raw.includes(";") || raw.includes("；")) {
    names = raw.split(/[;；]/).map((s) => s.trim()).filter(Boolean);
  } else {
    const parts = raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    const paired = parts.length >= 4 && parts.length % 2 === 0 && parts.every((p) => !/\s/.test(p));
    names = paired
      ? parts.flatMap((p, i) => (i % 2 === 0 ? [`${p}, ${parts[i + 1]}`] : []))
      : parts;
  }
  if (names.length <= keep) return raw;
  return `${names.slice(0, keep).join("; ")} 等 ${names.length} 人`;
}

export function includedRecordKey(row: Pick<IncludedRecord, "id" | "title">): string {
  return row.id || row.title;
}

export function doiToken(id: string, url: string): string {
  const m = `${id} ${url}`.match(/10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/i);
  return m ? m[0].replace(/[.,;]+$/, "") : "";
}

function alnum(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export function pdfNameFromReason(reason: string): string | null {
  const labeled = reason.match(/已有(?:项目)?PDF[：:]\s*(.+?\.pdf)/i);
  if (labeled) return labeled[1].trim();
  return null;
}

/** 项目 papers/ 里已有 PDF 时配对：理由里的文件名 > DOI > 标题与文件名互相包含。 */
export function matchPaperPdf(
  record: Pick<IncludedRecord, "title" | "id" | "url" | "reason">,
  files: readonly { name: string; path: string }[],
  papersDir?: string,
): string | null {
  const named = pdfNameFromReason(record.reason ?? "");
  if (named) {
    const want = alnum(named);
    const exact = files.find((file) => file.name.toLowerCase() === named.toLowerCase());
    if (exact) return exact.path;
    const fuzzy = files.find((file) => alnum(file.name) === want);
    if (fuzzy) return fuzzy.path;
    if (papersDir) return `${papersDir.replace(/[\\/]+$/, "")}/${named}`;
  }
  const doi = doiToken(record.id, record.url).toLowerCase();
  const doiKey = doi.replace(/[/:]/g, "_");
  const want = alnum(record.title);
  let best: { score: number; path: string } | null = null;
  for (const file of files) {
    const name = file.name.toLowerCase();
    if (!name.endsWith(".pdf")) continue;
    const stem = name.slice(0, -4);
    const stemKey = alnum(stem);
    let score = 0;
    if (doi && (name.includes(doi) || stem.includes(doiKey) || stem.replace(/-/g, "_").includes(doiKey))) {
      score = 1000 + doi.length;
    } else if (want.length >= 12 && stemKey.length >= 8 && (want.includes(stemKey) || stemKey.includes(want.slice(0, 24)))) {
      score = Math.min(want.length, stemKey.length);
    }
    if (score > 0 && (!best || score > best.score)) best = { score, path: file.path };
  }
  return best?.path ?? null;
}

/** 待获取只认 DOI 对上文件名；标题模糊命中不能当成已经有全文。 */
export function paperHasDoiPdf(
  record: Pick<IncludedRecord, "id" | "url">,
  files: readonly { name: string }[],
): boolean {
  const doi = doiToken(record.id, record.url).toLowerCase();
  if (!doi) return false;
  const doiKey = doi.replace(/[/:]/g, "_");
  return files.some((file) => {
    const name = file.name.toLowerCase();
    if (!name.endsWith(".pdf")) return false;
    const stem = name.slice(0, -4).replace(/-/g, "_");
    return name.includes(doi) || stem.includes(doiKey);
  });
}

/** 只剥掉开头那句判定，句号后面的原理由留下。 */
function reasonBody(previous: string): string {
  return previous.replace(/^(纳入|排除|待确认)[：:][^。]*。?/, "").trim();
}

export function confirmReason(decision: "included" | "excluded", previous: string): string {
  const prefix = decision === "included" ? "纳入：评审确认" : "排除：评审确认";
  const rest = reasonBody(previous);
  return rest ? `${prefix}。${rest}` : prefix;
}

/** 已纳入篇目点「移出」：判定改成排除，记录留在 json。 */
export function removeReason(previous: string): string {
  const rest = reasonBody(previous);
  const prefix = "排除：人工移出";
  return rest ? `${prefix}。${rest}` : prefix;
}

/** 已排除篇目点「恢复为待确认」：只改判定，不写回待获取。 */
export function restorePendingReason(previous: string): string {
  const rest = reasonBody(previous);
  const prefix = "待确认：从排除恢复";
  return rest ? `${prefix}。${rest}` : prefix;
}

function patchIncludedRow(
  rec: Record<string, unknown>,
  decision: string,
  reason: string,
) {
  rec.decision = decision;
  rec.reason = reason;
}

export function patchIncludedJson(
  text: string,
  key: string,
  decision: string,
  reason: string,
): string {
  const data = JSON.parse(text) as unknown;
  const rows = asRows(data);
  let found = false;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : "";
    const title = typeof rec.title === "string" ? rec.title : "";
    if (id !== key && title !== key) continue;
    patchIncludedRow(rec, decision, reason);
    found = true;
  }
  if (!found) throw new Error("清单里找不到这篇");
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** 一次改多篇。keys 对 id，对不上再对标题。一篇都没对上则抛错。 */
export function patchIncludedJsonMany(
  text: string,
  keys: string[],
  decision: "included" | "excluded" | "pending",
  reasonFor: (previous: string) => string,
): string {
  const wanted = new Set(keys.filter(Boolean));
  if (wanted.size === 0) throw new Error("没有选中的篇目");
  const data = JSON.parse(text) as unknown;
  const rows = asRows(data);
  let found = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : "";
    const title = typeof rec.title === "string" ? rec.title : "";
    if (!wanted.has(id) && !wanted.has(title)) continue;
    const previous = typeof rec.reason === "string" ? rec.reason : "";
    patchIncludedRow(rec, decision, reasonFor(previous));
    found += 1;
  }
  if (found === 0) throw new Error("清单里找不到选中的篇目");
  return `${JSON.stringify(data, null, 2)}\n`;
}

export type ScreeningSort = "listed" | "if-desc" | "if-asc";

/** 影响因子能解析成数字才参加排序和最低值。空、未收录不编一个 0。 */
export function impactFactorValue(metric: { impactFactor: string | null } | null | undefined): number | null {
  const raw = metric?.impactFactor?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * 最低影响因子只留下达到的篇。查不到影响因子的篇留在清单里，避免把书章和未收录期刊一起丢掉。
 * 排序只在有数字的篇之间进行，没有数字的保持原顺序排在后面。
 */
export function arrangeScreeningRows<T>(
  rows: T[],
  metricOf: (row: T) => { impactFactor: string | null } | null | undefined,
  sort: ScreeningSort,
  minIf: number | null,
): T[] {
  const kept = rows.filter((row) => {
    if (minIf == null || !Number.isFinite(minIf)) return true;
    const value = impactFactorValue(metricOf(row));
    return value == null || value >= minIf;
  });
  if (sort === "listed") return kept;
  return kept
    .map((row, index) => ({ row, index, value: impactFactorValue(metricOf(row)) }))
    .sort((a, b) => {
      if (a.value == null && b.value == null) return a.index - b.index;
      if (a.value == null) return 1;
      if (b.value == null) return -1;
      const delta = sort === "if-desc" ? b.value - a.value : a.value - b.value;
      return delta === 0 ? a.index - b.index : delta;
    })
    .map((item) => item.row);
}

/** 一次把全部 pending 改成纳入。reason 按每条原理由生成。 */
export function includeAllPendingJson(text: string): string {
  const data = JSON.parse(text) as unknown;
  const rows = asRows(data);
  let found = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    if (rec.decision !== "pending") continue;
    const previous = typeof rec.reason === "string" ? rec.reason : "";
    patchIncludedRow(rec, "included", confirmReason("included", previous));
    found += 1;
  }
  if (found === 0) throw new Error("没有待确认篇目");
  return `${JSON.stringify(data, null, 2)}\n`;
}

export function includedMdLine(row: Pick<IncludedRecord, "title" | "authors" | "year" | "source" | "url" | "id">): string {
  // 与检索步脚本 lit_records.py md_line 同一写法：作者超过三位写「等 N 人」
  const who = [shortAuthors(row.authors), row.year].filter(Boolean).join(", ");
  const tail = row.url || row.id;
  return [row.title, who, row.source, tail].filter(Boolean).join(" — ");
}

/** 开头那句「终判纳入 N 篇」按 json 现数改。编号文献行不动。 */
export function syncIncludedSummary(md: string, records: readonly IncludedRecord[]): string {
  const included = records.filter((row) => row.decision === "included").length;
  const pending = records.filter((row) => row.decision === "pending").length;
  const excluded = records.filter((row) => row.decision === "excluded").length;
  return md.replace(/\r\n/g, "\n").split("\n").map((line) => {
    if (/^\s*\d+\.\s/.test(line)) return line;
    if (!/纳入/.test(line) || !/篇/.test(line) || !/\d/.test(line)) return line;
    let next = line.replace(/(纳入\s*(?:\*\*)?)\d+/, `$1${included}`);
    if (/待确认/.test(next)) next = next.replace(/(待确认\s*(?:\*\*)?)\d+/, `$1${pending}`);
    if (/排除/.test(next)) next = next.replace(/(排除\s*(?:\*\*)?)\d+/, `$1${excluded}`);
    return next;
  }).join("\n");
}

export function patchIncludedMd(
  md: string,
  title: string,
  decision: string,
  line: string,
): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const kept = lines.filter((row) => !row.includes(title));
  if (decision === "excluded") return kept.join("\n");
  // 中文标题后面紧跟汉字时没有 \b。纳入文献清单、纳入清单都算这一节。
  const heading = decision === "included"
    ? /^(#{1,6}\s+).*(?:纳入|Included\b)/i
    : /^(#{1,6}\s+).*(?:pending|待确认)/i;
  let at = kept.findIndex((row) => heading.test(row.trim()));
  if (at < 0) {
    const block = decision === "included"
      ? ["", "## 纳入清单", line]
      : ["", "## Pending 清单", line];
    return [...kept, ...block].join("\n").replace(/^\n+/, "");
  }
  at += 1;
  while (at < kept.length && kept[at].trim() === "") at += 1;
  while (
    at < kept.length
    && kept[at].trim() !== ""
    && !/^\s*\d+\.\s/.test(kept[at])
    && !/^#{1,6}\s/.test(kept[at])
  ) {
    at += 1;
  }
  kept.splice(at, 0, line);
  return kept.join("\n");
}

export function alreadyInToFetch(
  md: string,
  row: Pick<IncludedRecord, "title" | "id" | "url">,
): boolean {
  const doi = doiToken(row.id, row.url);
  if (doi && md.includes(doi)) return true;
  return Boolean(row.title) && md.includes(row.title);
}

export function appendToFetchEntry(md: string, row: IncludedRecord): string {
  if (alreadyInToFetch(md, row)) return md;
  const numbered = md.match(/^\s*\d+\.\s/gm);
  const n = (numbered?.length ?? 0) + 1;
  const doi = doiToken(row.id, row.url) || row.url || row.id;
  const line = `${n}. ${row.title} — ${doi}`;
  if (!md.trim()) return `# 待获取全文\n\n${line}\n`;
  return `${md.replace(/\s*$/, "")}\n${line}\n`;
}

function lineMentionsRecord(
  line: string,
  row: Pick<IncludedRecord, "title" | "id" | "url">,
): boolean {
  const doi = doiToken(row.id, row.url);
  if (doi && line.toLowerCase().includes(doi.toLowerCase())) return true;
  return Boolean(row.title) && line.includes(row.title);
}

/**
 * 移出时拿掉待获取里这一篇。编号不重排，避免和已经勾掉的行错位。
 * 只删含 DOI 或标题的行；空文件原样返回。
 */
export function removeToFetchEntry(
  md: string,
  row: Pick<IncludedRecord, "title" | "id" | "url">,
): string {
  if (!md.trim()) return md;
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const kept = lines.filter((line) => !lineMentionsRecord(line, row));
  if (kept.length === lines.length) return md;
  return `${kept.join("\n").replace(/\n+$/, "")}\n`;
}

/** 移出时按 DOI 或标题拿掉 RIS 里对应的一整条。对不上则原样返回。 */
export function removeRisRecord(
  ris: string,
  row: Pick<IncludedRecord, "title" | "id" | "url">,
): string {
  const doi = doiToken(row.id, row.url).toLowerCase();
  const title = risValue(row.title).toLowerCase();
  if (!doi && !title) return ris;
  const blocks = risBlocks(ris);
  if (blocks.length === 0) return ris;
  const kept = blocks.filter((block) => {
    const blockDoi = doiToken("", blockField(block, "DO")).toLowerCase();
    const blockTitle = blockField(block, "TI").toLowerCase();
    if (doi && blockDoi === doi) return false;
    if (title && blockTitle === title) return false;
    return true;
  });
  if (kept.length === blocks.length) return ris;
  const body = kept.map((block) => block.trim()).filter(Boolean).join("\r\n\r\n");
  return body ? `${body}\r\n` : "";
}

/** 精读索引里这篇已经写了笔记路径。读不到索引、或 notePath 为空，都不算有笔记。 */
export function notePathForRecord(indexText: string, id: string): string | null {
  if (!id.trim()) return null;
  let data: unknown;
  try {
    data = JSON.parse(indexText);
  } catch {
    return null;
  }
  for (const row of asRows(data)) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    if (rec.id !== id) continue;
    const path = rec.notePath;
    if (typeof path === "string" && path.trim()) return path.trim();
  }
  return null;
}

/** references.bib 里出现这篇 DOI 或标题。对不上不提示。 */
export function bibMentionsRecord(
  bib: string,
  row: Pick<IncludedRecord, "title" | "id" | "url">,
): boolean {
  const doi = doiToken(row.id, row.url);
  if (doi && bib.toLowerCase().includes(doi.toLowerCase())) return true;
  const title = row.title.trim();
  return title.length >= 8 && bib.includes(title);
}

function risValue(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
}

/** 「待补」是给人看的缺口标记，进 RIS 就成了文献库里一格「待补」：当没有 */
function filled(value: string): string {
  const text = risValue(value);
  return text === "待补" || text === "待核" ? "" : text;
}

/** RIS 正文里的化学式。DOI、年份、卷期页不走这里。 */
function risText(value: string): string {
  return displayCitationTitle(risValue(value));
}

function risAuthors(authors: string): string[] {
  const text = authors.trim();
  if (!text) return [];
  const parts = text.includes(" and ")
    ? text.split(/\s+and\s+/)
    : text.includes(";")
      ? text.split(";")
      : [text];
  return parts.map((part) => filled(part)).filter(Boolean);
}

function risBlocks(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split(/(?:^|\n)TY  -/i).slice(1).map((part) => `TY  -${part}`);
}

function blockField(block: string, tag: string): string {
  const line = block.split("\n").find((row) => row.startsWith(`${tag}  -`));
  return line ? risValue(line.slice(6)) : "";
}

/** 按 DOI 或标题从已有 RIS（通常是 papers/imports 里的 EndNote 导出）取出整条。 */
export function sourceRisBlock(corpus: string, row: Pick<IncludedRecord, "id" | "title" | "url">): string | null {
  const doi = doiToken(row.id, row.url).toLowerCase();
  const title = risValue(row.title).toLowerCase();
  for (const block of risBlocks(corpus)) {
    const blockDoi = doiToken("", blockField(block, "DO")).toLowerCase();
    const blockTitle = blockField(block, "TI").toLowerCase();
    if ((doi && blockDoi === doi) || (title && blockTitle === title)) return block.trim();
  }
  return null;
}

const ENDNOTE_KEEP = ["AU", "TI", "T2", "J2", "PY", "DA", "ET", "VL", "IS", "SP", "EP", "M2", "M3", "SN", "DO", "KW", "AB", "LA", "UR"];
const ZOTERO_KEEP = ["AU", "TI", "T2", "J2", "PY", "DA", "VL", "IS", "SP", "EP", "SN", "DO", "KW", "AB", "UR"];

/** 把原导出记录改写成 EndNote 2025 认的标签。起始页同时写 M2，文章类型没有时用 Journal Article。 */
export function normalizeSourceRis(block: string): string {
  const lines = block.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  let start = "";
  let hasType = false;
  for (const line of lines) {
    const tag = line.slice(0, 2);
    if (!ENDNOTE_KEEP.includes(tag) || line.slice(2, 6) !== "  - ") continue;
    if (tag === "SP" || tag === "M2") start = start || risValue(line.slice(6));
    if (tag === "M3") hasType = true;
    kept.push(line.trimEnd());
  }
  if (start && !kept.some((line) => line.startsWith("M2  -"))) {
    const at = kept.findIndex((line) => line.startsWith("SP  -"));
    kept.splice(at + 1, 0, `M2  - ${start}`);
  }
  if (!hasType) kept.push("M3  - Journal Article");
  kept.unshift("TY  - JOUR");
  kept.push("ER  - ");
  return kept.join("\r\n");
}

function pushTag(lines: string[], tag: string, value: string) {
  const text = risValue(value);
  if (text && text !== "待补") lines.push(`${tag}  - ${text}`);
}

function risBody(row: IncludedRecord, target: "zotero" | "endnote"): string[] {
  const lines = ["TY  - JOUR"];
  for (const author of risAuthors(row.authors)) lines.push(`AU  - ${author}`);
  pushTag(lines, "TI", risText(row.title));
  const journal = risValue(row.source);
  if (journal && journal !== "待补") lines.push(`T2  - ${journal}`);
  const short = risValue(row.journalAbbreviation);
  if (short && short !== "待补" && short.toLowerCase() !== journal.toLowerCase()) {
    lines.push(`J2  - ${short}`);
  }
  pushTag(lines, "PY", row.year);
  if (target === "endnote") pushTag(lines, "DA", row.date);
  if (target === "endnote") pushTag(lines, "ET", row.epubDate);
  pushTag(lines, "VL", row.volume);
  pushTag(lines, "IS", row.issue);
  const pages = filled(row.pages).replace(/[–—−]/g, "-");
  const parts = pages ? pages.split(/-+/, 2).map((part) => part.trim()) : [];
  if (parts[0]) {
    lines.push(`SP  - ${parts[0]}`);
    if (target === "endnote") lines.push(`M2  - ${parts[0]}`);
  }
  if (parts[1] && parts[1] !== parts[0]) lines.push(`EP  - ${parts[1]}`);
  if (target === "endnote") pushTag(lines, "M3", filled(row.articleType) || "Journal Article");
  pushTag(lines, "SN", row.issn);
  const doi = doiToken(row.id, row.url);
  if (doi) lines.push(`DO  - ${doi}`);
  for (const word of risText(row.keywords).split(/[;；]/)) {
    if (word.trim() && word.trim() !== "待补") lines.push(`KW  - ${word.trim()}`);
  }
  pushTag(lines, "AB", risText(row.abstract));
  if (target === "endnote") pushTag(lines, "LA", row.language);
  const url = filled(row.url) || (doi ? `https://doi.org/${doi}` : "");
  if (url) lines.push(`UR  - ${url}`);
  lines.push("ER  - ");
  return lines;
}

/** 给 Zotero 的 RIS。期刊全称只写 T2；缩写只写 J2。不写 JO（Zotero 会把它放进期刊缩写）。 */
export function recordToZoteroRis(row: IncludedRecord): string {
  return risBody(row, "zotero").join("\r\n");
}

/** 给 EndNote 2025 RefMan RIS 的记录。页写 SP，起始页码写 M2，文章类型写 M3。 */
export function recordToEndnoteRis(row: IncludedRecord): string {
  return risBody(row, "endnote").join("\r\n");
}

/** 检索时写入 included.json 的完整题录，写成 EndNote 认的 RIS。不再另查。 */
export function recordToRis(row: IncludedRecord): string {
  return recordToEndnoteRis(row);
}

function appendRisRecord(
  ris: string,
  row: IncludedRecord,
  source: string,
  target: "zotero" | "endnote",
): string {
  const doi = doiToken(row.id, row.url);
  const title = risValue(row.title);
  if (doi && ris.toLowerCase().includes(doi.toLowerCase())) return ris;
  if (title && ris.toLowerCase().includes(title.toLowerCase())) return ris;
  const thin = !risValue(row.volume) && !risValue(row.pages) && !risValue(row.abstract);
  const fromSource = thin && source ? sourceRisBlock(source, row) : null;
  const block = fromSource
    ? target === "zotero"
      ? zoteroRisFromSource(fromSource)
      : normalizeSourceRis(fromSource)
    : target === "zotero"
      ? recordToZoteroRis(row)
      : recordToEndnoteRis(row);
  const base = ris.replace(/\s*$/, "");
  return base ? `${base}\r\n\r\n${block}\r\n` : `${block}\r\n`;
}

/** 纳入后追加到 EndNote 导入文件。已有同一 DOI 或标题则不重复。 */
export function appendEndnoteImportRecord(ris: string, row: IncludedRecord, source = ""): string {
  return appendRisRecord(ris, row, source, "endnote");
}

/** 纳入后追加到 Zotero 的 to-fetch.ris。标签与 EndNote 那份分开。 */
export function appendZoteroImportRecord(ris: string, row: IncludedRecord, source = ""): string {
  return appendRisRecord(ris, row, source, "zotero");
}

/** 原导出记录改成 Zotero 认的标签。丢掉 JO 和筛选注释。 */
export function zoteroRisFromSource(block: string): string {
  const lines = block.replace(/\r\n/g, "\n").split("\n");
  const kept = lines.filter((line) => {
    const tag = line.slice(0, 2);
    return ZOTERO_KEEP.includes(tag) && line.slice(2, 6) === "  - ";
  });
  kept.unshift("TY  - JOUR");
  kept.push("ER  - ");
  return kept.join("\r\n");
}
