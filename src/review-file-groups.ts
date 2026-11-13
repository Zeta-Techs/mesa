/**
 * 文件交付类评审的改动分组（精读/大纲/写作/排版等）。
 * 检索步分组仍在 screening-review.ts。
 */

import { normReviewPath } from "./screening-review.ts";

export type DeliveryFileGroupId =
  | "notes"
  | "manuscript"
  | "index"
  | "fetch"
  | "other"
  | "machine";

export const DELIVERY_FILE_GROUP_LABEL: Record<DeliveryFileGroupId, string> = {
  notes: "笔记",
  manuscript: "稿件",
  index: "引文",
  fetch: "待获取",
  other: "其他改动",
  machine: "过程",
};

export const DELIVERY_FILE_GROUP_ORDER: DeliveryFileGroupId[] = [
  "notes",
  "manuscript",
  "index",
  "fetch",
  "other",
  "machine",
];

function fileName(path: string): string {
  const p = normReviewPath(path);
  return p.split("/").pop() ?? p;
}

/** Quarto/Git 脚手架、渲染中间件：进过程，不进稿件主面。 */
export function isManuscriptScaffold(path: string): boolean {
  const p = normReviewPath(path);
  const base = fileName(p).toLowerCase();
  if (
    base === ".gitignore" ||
    base === ".gitattributes" ||
    base === ".geminiignore" ||
    base === ".qwenignore" ||
    base === ".aiignore" ||
    base === ".agentignore" ||
    base === "_quarto.yml" ||
    base === "_quarto.yaml" ||
    base.endsWith(".csl")
  ) {
    return true;
  }
  if (p.includes("/site_libs/") || p.includes("/_tex/")) return true;
  if (p.startsWith("output/_tex/") || p.startsWith("output/site_libs/")) return true;
  return false;
}

export function deliveryFileGroup(path: string): DeliveryFileGroupId {
  const p = normReviewPath(path);
  const base = fileName(p);
  if (isStepProcessRecord(p) || isManuscriptScaffold(p)) return "machine";
  if (base === "to-fetch.md" || base === "to-fetch.ris") return "fetch";
  if (base === "included.md" || base === "included.json") {
    return "other";
  }
  if (base.endsWith(".bib")) return "index";
  if (p === "notes" || p.startsWith("notes/") || p.includes("/notes/")) {
    return "notes";
  }
  if (
    p === "scripts" ||
    p.startsWith("scripts/") ||
    p.includes("/scripts/") ||
    base.endsWith(".py") ||
    p.includes("/api-cache/")
  ) {
    return "other";
  }
  if (
    base === "outline.md" ||
    base === "design.md" ||
    base === "data-dictionary.md" ||
    base === "analysis-report.md" ||
    base === "eda-report.md" ||
    p.startsWith("manuscript/") ||
    p.startsWith("chapters/") ||
    p.startsWith("proposal/") ||
    p.startsWith("survey/") ||
    p.startsWith("submission/") ||
    p.startsWith("rebuttal/") ||
    p.startsWith("output/") ||
    p.includes("/manuscript/") ||
    p.includes("/chapters/") ||
    p.includes("/proposal/") ||
    p.includes("/survey/") ||
    p.includes("/submission/") ||
    p.includes("/rebuttal/") ||
    base.endsWith(".tex") ||
    base.endsWith(".qmd")
  ) {
    return "manuscript";
  }
  return "other";
}

/** 渲染 PDF/docx 不抢稿件主面，源稿在前。 */
export function isDerivedReviewPreview(path: string): boolean {
  const p = normReviewPath(path);
  if (p === "output" || p.startsWith("output/") || p.includes("/output/")) return true;
  return /\.(pdf|docx)$/i.test(fileName(p));
}

export function sortDeliveryPaths(paths: readonly string[]): string[] {
  return [...paths].sort((a, b) => {
    const ga = DELIVERY_FILE_GROUP_ORDER.indexOf(deliveryFileGroup(a));
    const gb = DELIVERY_FILE_GROUP_ORDER.indexOf(deliveryFileGroup(b));
    if (ga !== gb) return ga - gb;
    const ra = manuscriptPreviewRank(a);
    const rb = manuscriptPreviewRank(b);
    if (ra !== rb) return ra - rb;
    return normReviewPath(a).localeCompare(normReviewPath(b), "zh");
  });
}

/** 稿件主面：正文源稿 → Word → PDF → 其余。 */
export function manuscriptPreviewRank(path: string): number {
  const base = fileName(path).toLowerCase();
  if (isManuscriptScaffold(path)) return 90;
  if (isDerivedReviewPreview(path)) {
    if (base.endsWith(".docx")) return 20;
    if (base.endsWith(".pdf")) return 21;
    return 30;
  }
  if (
    base === "draft.md" ||
    base === "outline.md" ||
    base === "review-final.md" ||
    base.endsWith("-draft.md")
  ) {
    return 0;
  }
  if (base.endsWith(".md") || base.endsWith(".qmd")) return 1;
  return 50;
}

/** 这一步怎么做成的记录。脚本、配置、接口缓存不进这里，留在「文件」。 */
export function isStepProcessRecord(path: string): boolean {
  const p = normReviewPath(path);
  const base = fileName(p);
  if (
    base === "screening.md" ||
    base === "zotero-sync.md" ||
    base === "help-wanted.md" ||
    base === "section-status.md" ||
    base === "changelog.md" ||
    base === "citation-check.md" ||
    base === "citation-style.md" ||
    base === "compile-notes.md" ||
    base === "run-manifest.json" ||
    base === "implementation-check.md" ||
    base === "cleaned-data-manifest.md"
  ) {
    return true;
  }
  if (p === "notes/index.json" || p.endsWith("/notes/index.json")) return true;
  if (p === ".ccode" || p.startsWith(".ccode/") || p.includes("/.ccode/")) return true;
  return false;
}

/** 打开审阅时先看笔记/稿件，不把 help-wanted 等过程文件摊在主面。 */
export function preferredDeliveryPath(paths: readonly string[]): string | null {
  return deliveryContentPaths(paths)[0] ?? deliveryProcessPaths(paths)[0] ?? null;
}

export function deliveryContentPaths(paths: readonly string[]): string[] {
  const content = paths.filter((path) => {
    const group = deliveryFileGroup(path);
    return group === "notes" || group === "manuscript";
  });
  const source = content.filter((path) => !isDerivedReviewPreview(path));
  const derived = content
    .filter((path) => isDerivedReviewPreview(path))
    .sort((a, b) => derivedPreviewRank(a) - derivedPreviewRank(b) || a.localeCompare(b, "zh"));
  const rankedSource = [...source].sort((a, b) => {
    const ra = manuscriptPreviewRank(a);
    const rb = manuscriptPreviewRank(b);
    if (ra !== rb) return ra - rb;
    return normReviewPath(a).localeCompare(normReviewPath(b), "zh");
  });
  return [...rankedSource, ...derived];
}

function derivedPreviewRank(path: string): number {
  const n = fileName(path).toLowerCase();
  if (n.endsWith(".docx")) return 0;
  if (n.endsWith(".pdf")) return 1;
  return 2;
}

export function deliveryProcessPaths(paths: readonly string[]): string[] {
  return sortDeliveryPaths(paths).filter((path) => isStepProcessRecord(path));
}

export function groupDeliveryFiles<T extends { path: string }>(
  files: readonly T[],
): { id: DeliveryFileGroupId; label: string; files: T[] }[] {
  const buckets: Record<DeliveryFileGroupId, T[]> = {
    notes: [],
    manuscript: [],
    index: [],
    fetch: [],
    other: [],
    machine: [],
  };
  for (const file of files) buckets[deliveryFileGroup(file.path)].push(file);
  for (const id of DELIVERY_FILE_GROUP_ORDER) {
    const order = sortDeliveryPaths(buckets[id].map((f) => f.path));
    const map = new Map(buckets[id].map((f) => [f.path, f]));
    buckets[id] = order.map((p) => map.get(p)!);
  }
  return DELIVERY_FILE_GROUP_ORDER.map((id) => ({
    id,
    label: DELIVERY_FILE_GROUP_LABEL[id],
    files: buckets[id],
  })).filter((g) => g.files.length > 0);
}
