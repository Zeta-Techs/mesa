/**
 * 哪些文件是正文稿件、哪些只是写作配套文件（2026-11-11）。
 * 起因：「写作规范 style-sheet.md 当成稿件」一天里冒出三处误报（标题序号、大纲挂复核、引用缺 bib），
 * 根子是七处各自维护一份「不算稿件」的名单、互相对不上。名单只在这里、mesa_checks.py、cite_check.py 三处，
 * 内容以 tests/fixtures/manuscript-helpers.json 为准（tests/manuscript-files.test.ts 逐条比对）。
 */

/** 文件名里含这些词的是写作配套文件，不是正文（与 fixture 同序） */
export const MANUSCRIPT_HELPER_NAMES = [
  "citation-check",
  "citation-style",
  "review-report",
  "verification-decisions",
  "declarations",
  "checklist",
  "evidence",
  "section-status",
  "changelog",
  "numbers",
  "revision-notes",
  "outline",
  "typeface",
  "readme",
  "style-sheet",
] as const;

const HELPER_RE = new RegExp(`(${MANUSCRIPT_HELPER_NAMES.join("|")})`, "i");

const norm = (path: string) => path.replace(/\\/g, "/");
const baseName = (path: string) => norm(path).split("/").pop() ?? "";

/** 写作配套文件（按文件名认，同脚本的 SKIP 口径） */
export function isManuscriptHelper(path: string): boolean {
  return HELPER_RE.test(baseName(path));
}

/** 正文稿件：manuscript/、submission/、proposal/、chapters/ 下的 md / qmd / tex，去掉写作配套文件 */
export function isManuscriptBody(path: string): boolean {
  const p = norm(path);
  return /(^|\/)(manuscript|submission|proposal|chapters)\/.+\.(md|qmd|tex)$/i.test(p) && !isManuscriptHelper(p);
}

const MAIN_NAME = /^(review-final|paper-final|thesis-final|draft|main|formatted|proposal|analysis-report)\.(md|qmd|tex)$|-draft\.(md|qmd)$/i;

/** 这一步要扫的主稿：先认主稿名（draft.md、*-final.md…），再是其余正文稿件（按路径排序），都没有时退回大纲 outline.md。
 *  不按传进来的顺序取第一个——原先会挑中排在前面的 changelog.md、section-status.md */
export function manuscriptSourcePath(paths: readonly string[]): string | null {
  const md = paths.filter((p) => /\.(md|qmd)$/i.test(norm(p)));
  const main = md.find((p) => MAIN_NAME.test(baseName(p)) && !isManuscriptHelper(p));
  if (main) return main;
  const body = md.filter(isManuscriptBody).sort((a, b) => norm(a).localeCompare(norm(b)));
  if (body.length > 0) return body[0];
  return md.find((p) => /(^|\/)outline\.md$/i.test(norm(p))) ?? null;
}
