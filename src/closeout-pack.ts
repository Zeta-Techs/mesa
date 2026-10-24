/**
 * 项目卡上的完结清单：按整条流程的脉络收文件，不按目录摊开。
 * 定稿步出现后才显示。已经写出来的才列入，缺的不占一行。
 */

import { isManuscriptScaffold } from "./review-file-groups.ts";
import { matchPaperPdf } from "./screening-review.ts";

export type CloseoutGroupId =
  | "final"
  | "manuscript"
  | "figures"
  | "library"
  | "checks"
  | "notes";

export interface CloseoutFile {
  rel: string;
  name: string;
  abs: string;
  label: string;
}

interface CatalogItem {
  group: CloseoutGroupId;
  rel: string;
  label: string;
  /** 一句「这份拿来干什么」，显示在名字后面（2026-10-24 用户：完结文件只有一排名字，看不出哪份做什么用） */
  hint?: string;
}

/** 两份带引用域的 Word：在 Mesa 里预览不了 EndNote / Zotero 的域，点开交给系统里的 Word。
 *  「在 Word 里换样式」是保存进项目之后人自己的可选事，不放在定稿步的人工事项里（2026-10-24 用户拍板）。 */
export function isCloseoutFieldDoc(rel: string): boolean {
  return rel === "output/endnote.docx" || rel === "output/zotero.docx";
}

export const FIELD_DOC_HINT =
  "两份域稿点开会用 Word 打开。要在 Word 里接着改、让 EndNote 或 Zotero 换样式时：在 EndNote 选项卡点 Update Citations and Bibliography，或在 Zotero 选项卡点 Refresh，再在那里选样式。不在 Word 里改稿就不用管。";

/** 脉络顺序。同一路径只出现一次。 */
const CATALOG: CatalogItem[] = [
  { group: "final", rel: "output/review-final.pdf", label: "定稿 PDF", hint: "阅读、投稿" },
  { group: "final", rel: "output/paper-final.pdf", label: "论文 PDF", hint: "阅读、投稿" },
  { group: "final", rel: "output/thesis-final.pdf", label: "学位论文 PDF", hint: "阅读、送审" },
  { group: "final", rel: "output/formatted.pdf", label: "期刊格式 PDF", hint: "按目标期刊排好的版本" },
  { group: "final", rel: "output/main.pdf", label: "LaTeX PDF" },
  { group: "final", rel: "output/review-final.docx", label: "普通 Word", hint: "阅读用，换不了文献样式" },
  { group: "final", rel: "output/paper-final.docx", label: "论文 Word", hint: "阅读用，换不了文献样式" },
  { group: "final", rel: "output/thesis-final.docx", label: "学位论文 Word", hint: "阅读用，换不了文献样式" },
  { group: "final", rel: "output/formatted.docx", label: "期刊格式 Word" },
  { group: "final", rel: "output/endnote.docx", label: "EndNote 域稿", hint: "Word 打开，Update 后可换样式" },
  { group: "final", rel: "output/zotero.docx", label: "Zotero 域稿", hint: "Word 打开，Refresh 后可换样式" },
  { group: "manuscript", rel: "manuscript/review-final.md", label: "定稿源稿", hint: "要再改稿从这里改" },
  { group: "manuscript", rel: "manuscript/paper-final.md", label: "论文源稿", hint: "要再改稿从这里改" },
  { group: "manuscript", rel: "manuscript/thesis-final.md", label: "学位论文源稿", hint: "要再改稿从这里改" },
  { group: "manuscript", rel: "submission/formatted.md", label: "期刊格式稿" },
  { group: "manuscript", rel: "manuscript/main.tex", label: "LaTeX 主文件" },
  { group: "manuscript", rel: "manuscript/source.docx", label: "Word 原件" },
  { group: "manuscript", rel: "manuscript/draft.md", label: "初稿" },
  { group: "manuscript", rel: "output/draft.pdf", label: "初稿 PDF" },
  { group: "manuscript", rel: "output/draft.docx", label: "初稿 Word" },
  { group: "manuscript", rel: "outline.md", label: "大纲" },
  { group: "manuscript", rel: "manuscript/outline.md", label: "论文大纲" },
  { group: "library", rel: "papers/screening.md", label: "检索与筛选", hint: "怎么查的、为什么纳入或排除" },
  { group: "library", rel: "papers/included.md", label: "纳入清单", hint: "最终用到的文献" },
  { group: "library", rel: "papers/to-fetch.md", label: "待获取全文", hint: "还缺全文的篇目" },
  { group: "library", rel: "papers/zotero-library.ris", label: "给 Zotero 的全库", hint: "导入 Zotero，全部引用文献" },
  { group: "library", rel: "papers/endnote-library.ris", label: "给 EndNote 的全库", hint: "导入 EndNote，全部引用文献" },
  { group: "library", rel: "papers/endnote-import.ris", label: "给 EndNote 的题录", hint: "导入 EndNote，检索步纳入的那批" },
  { group: "library", rel: "references.bib", label: "文献库", hint: "引用键与题录（BibTeX）" },
  { group: "library", rel: "notes/index.json", label: "笔记索引", hint: "每篇读到什么程度" },
  { group: "library", rel: "notes/handoff.md", label: "精读交到写作的要点", hint: "写作时要守的约束" },
  { group: "checks", rel: "manuscript/citation-check.md", label: "引用检查", hint: "引用和文献库对不对得上" },
  { group: "checks", rel: "manuscript/verification-decisions.md", label: "待核实裁决", hint: "存疑句子你怎么定的" },
  { group: "checks", rel: "manuscript/review-report.md", label: "审查报告", hint: "审查意见和你的决定" },
  { group: "checks", rel: "manuscript/changelog.md", label: "修改记录", hint: "润色改了哪些地方" },
  { group: "checks", rel: "papers/endnote-cite-report.md", label: "EndNote 域稿报告", hint: "哪些引用对上了库" },
  { group: "checks", rel: "papers/zotero-cite-report.md", label: "Zotero 域稿报告", hint: "哪些引用对上了库" },
  { group: "checks", rel: "submission/target-journal.md", label: "目标期刊", hint: "选定的期刊和理由" },
  { group: "checks", rel: "submission/figure-permissions.md", label: "转载许可清单", hint: "每块拼图的许可状态" },
  { group: "checks", rel: "submission/declarations.md", label: "投稿声明", hint: "作者、基金、利益冲突、AI 使用" },
  { group: "checks", rel: "manuscript/section-status.md", label: "章节状态", hint: "各章证据与审核状态" },
];

const GROUP_LABEL: Record<CloseoutGroupId, string> = {
  final: "最终稿",
  manuscript: "可以接着改的稿",
  figures: "图",
  library: "文献从哪来",
  checks: "核对与修改",
  notes: "精读笔记",
};

const GROUP_ORDER: CloseoutGroupId[] = [
  "final",
  "manuscript",
  "figures",
  "library",
  "checks",
  "notes",
];

const CATALOG_BY_REL = new Map(CATALOG.map((item) => [item.rel, item]));

export function closeoutGroupLabel(id: CloseoutGroupId): string {
  return GROUP_LABEL[id];
}

/** 整条流程都已保存进项目，并且其中有定稿步，才在项目卡上给出完结文件。 */
export function closeoutPackVisible(
  steps: readonly { workspaceName?: string | null; expectedArtifacts?: readonly string[] | null }[],
  done: readonly boolean[],
): boolean {
  if (steps.length === 0 || done.length !== steps.length) return false;
  if (!done.every(Boolean)) return false;
  return steps.some((step) => isCloseoutStep(step));
}

export function isCloseoutStep(step: {
  workspaceName?: string | null;
  expectedArtifacts?: readonly string[] | null;
} | null): boolean {
  if (!step) return false;
  const name = step.workspaceName ?? "";
  if (
    name === "polish" ||
    name === "research-paper-polish" ||
    name === "thesis-final" ||
    name === "journal-format" ||
    name === "latex-final" ||
    name.startsWith("rebuttal-")
  ) {
    return true;
  }
  return (step.expectedArtifacts ?? []).some((path) =>
    /(?:review|paper|thesis)-final\.(?:md|pdf|docx)$|formatted\.(?:md|pdf|docx)$|output\/main\.pdf$/i.test(
      path.replace(/\\/g, "/"),
    ),
  );
}

function baseName(rel: string): string {
  return rel.replace(/\\/g, "/").split("/").pop() ?? rel;
}

export interface CloseoutNoteIndex {
  bibKey?: string;
  notePath?: string;
  title?: string;
  doi?: string;
  id?: string;
}

export interface CloseoutNoteRow {
  note: CloseoutFile;
  title: string;
  pdf: CloseoutFile | null;
}

export function parseCloseoutIndex(text: string): CloseoutNoteIndex[] {
  try {
    const data = JSON.parse(text) as unknown;
    if (!Array.isArray(data)) return [];
    return data.filter((item): item is CloseoutNoteIndex => Boolean(item) && typeof item === "object");
  } catch {
    return [];
  }
}

/** 笔记头部来源行指向的 PDF（list_paper_notes）：索引里没有的笔记（沉浸阅读自己建的）靠它配全文、取题名 */
export interface CloseoutNoteSource {
  noteName: string;
  pdfRel?: string | null;
}

/** 每篇笔记一行：优先用索引里的题名，并按题名或 DOI 配上全文 PDF；索引里没有的
 *  （沉浸阅读建的笔记）按笔记头部来源行配 PDF，题名取 PDF 文件名——原先显示成
 *  「A-Mg2+Li+-hybrid-…」这样的文件名、还标「无全文」（2026-10-18 用户截图）。 */
export function closeoutNoteRows(
  notes: readonly CloseoutFile[],
  index: readonly CloseoutNoteIndex[],
  pdfs: readonly CloseoutFile[],
  sources: readonly CloseoutNoteSource[] = [],
): CloseoutNoteRow[] {
  const byPath = new Map<string, CloseoutNoteIndex>();
  const byKey = new Map<string, CloseoutNoteIndex>();
  for (const item of index) {
    const path = item.notePath?.replace(/\\/g, "/");
    if (path) byPath.set(path, item);
    if (item.bibKey) byKey.set(item.bibKey, item);
  }
  const files = pdfs.map((file) => ({ name: file.name, path: file.abs }));
  return notes
    .map((note) => {
      const stem = note.name.replace(/\.md$/i, "");
      const item = byPath.get(note.rel) ?? byKey.get(stem);
      if (!item) {
        const sourceRel = sources.find((src) => src.noteName === note.name)?.pdfRel?.replace(/\\/g, "/");
        const sourceName = sourceRel?.split("/").pop() ?? "";
        const pdf = sourceName
          ? (pdfs.find((file) => file.name === sourceName) ?? null)
          : null;
        const title = sourceName ? sourceName.replace(/\.pdf$/i, "") : closeoutNoteLabel(note.name);
        return { note, title, pdf };
      }
      const title = item.title?.trim() || closeoutNoteLabel(note.name);
      const pdfPath = matchPaperPdf(
        { title: item.title ?? "", id: item.doi || item.id || "", url: "", reason: "" },
        files,
      );
      return { note, title, pdf: pdfs.find((file) => file.abs === pdfPath) ?? null };
    })
    .sort((a, b) => a.title.localeCompare(b.title, "zh"));
}

/** `alotaibi2026probing.md` 显示成「alotaibi 2026 probing」；沉浸阅读按标题起的
 *  `A-Mg2+Li+-hybrid-….md` 把连字符还原成空格。 */
export function closeoutNoteLabel(name: string): string {
  const stem = name.replace(/\.md$/i, "");
  const matched = stem.match(/^([A-Za-z]+)(\d{4})(.*)$/);
  if (!matched) return stem.includes(" ") ? stem : stem.replace(/-+/g, " ").trim();
  const rest = matched[3].replace(/[-_]+/g, " ").trim();
  return [matched[1], matched[2], rest].filter(Boolean).join(" ");
}

/** 样式、配置、渲染时复制进 output/figures 的图，不进完结清单。 */
export function isCloseoutVisible(rel: string): boolean {
  const path = rel.replace(/\\/g, "/");
  if (isManuscriptScaffold(path)) return false;
  // 渲染用的字体说明、Word 模板、参考文献过滤器：给工具用的，不是成果
  if (/^manuscript\/(?:typeface\.md|reference\.docx|references\.lua)$/i.test(path)) return false;
  if (path === "output/figures" || path.startsWith("output/figures/")) return false;
  if (path.startsWith("figures/src/")) return false;
  return true;
}

export function closeoutScanEntries(
  steps: readonly { expectedArtifacts?: readonly string[] | null }[],
): string[] {
  const rels = CATALOG.map((item) => item.rel);
  for (const step of steps) {
    for (const raw of step.expectedArtifacts ?? []) {
      const rel = raw.replace(/\\/g, "/").replace(/\/+$/, "");
      if (!rel || rel.includes("*") || !isCloseoutVisible(rel)) continue;
      rels.push(rel);
    }
  }
  rels.push("figures/*", "notes/*.md");
  return [...new Set(rels)];
}

function groupOf(rel: string): CloseoutGroupId | null {
  const path = rel.replace(/\\/g, "/");
  const known = CATALOG_BY_REL.get(path);
  if (known) return known.group;
  const base = baseName(path).toLowerCase();
  if (path.startsWith("notes/") && base.endsWith(".md") && base !== "handoff.md") return "notes";
  if (path.startsWith("figures/") && /\.(png|svg|pdf|md)$/i.test(base)) return "figures";
  if (path.startsWith("output/") && /\.(pdf|docx)$/i.test(base)) return "final";
  if (path.startsWith("manuscript/") && base.endsWith(".md")) return "manuscript";
  return null;
}

/** 这份文件拿来干什么（清单里登记过的才有） */
export function closeoutHint(rel: string): string {
  return CATALOG_BY_REL.get(rel.replace(/\\/g, "/"))?.hint ?? "";
}

function labelOf(rel: string, group: CloseoutGroupId): string {
  return CATALOG_BY_REL.get(rel)?.label ?? (group === "notes" || group === "figures" ? baseName(rel) : baseName(rel));
}

function rank(rel: string, group: CloseoutGroupId): number {
  const index = CATALOG.findIndex((item) => item.rel === rel);
  if (index >= 0) return index;
  if (group === "final") {
    const base = baseName(rel).toLowerCase();
    if (base.endsWith(".pdf")) return 20;
    if (base === "endnote.docx") return 21;
    if (base === "zotero.docx") return 22;
    return 23;
  }
  return 100;
}

export function groupCloseoutFiles(
  files: readonly CloseoutFile[],
): { id: CloseoutGroupId; label: string; files: CloseoutFile[] }[] {
  const buckets: Record<CloseoutGroupId, CloseoutFile[]> = {
    final: [],
    manuscript: [],
    figures: [],
    library: [],
    checks: [],
    notes: [],
  };
  const seen = new Set<string>();
  for (const file of files) {
    const rel = file.rel.replace(/\\/g, "/");
    if (!isCloseoutVisible(rel) || seen.has(rel)) continue;
    const group = groupOf(rel);
    if (!group) continue;
    seen.add(rel);
    buckets[group].push({
      ...file,
      rel,
      name: file.name || baseName(rel),
      label: file.label || labelOf(rel, group),
    });
  }
  return GROUP_ORDER.flatMap((id) => {
    const rows = buckets[id].sort(
      (a, b) => rank(a.rel, id) - rank(b.rel, id) || a.rel.localeCompare(b.rel, "zh"),
    );
    return rows.length ? [{ id, label: GROUP_LABEL[id], files: rows }] : [];
  });
}

/** 同一张拼图的 png 和说明并成「图 N」。README 单独留一条。 */
export function closeoutFigureCards(files: readonly CloseoutFile[]): CloseoutFile[] {
  const byStem = new Map<string, CloseoutFile[]>();
  const extra: CloseoutFile[] = [];
  for (const file of files) {
    const stem = file.name.replace(/\.(png|svg|pdf|md)$/i, "");
    if (/^fig\d+$/i.test(stem)) {
      const key = stem.toLowerCase();
      const list = byStem.get(key) ?? [];
      list.push(file);
      byStem.set(key, list);
    } else {
      extra.push(file);
    }
  }
  const cards = [...byStem.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))
    .map(([stem, list]) => {
      const image = list.find((item) => /\.(png|svg|pdf)$/i.test(item.name)) ?? list[0];
      return { ...image, label: `图 ${stem.replace(/^fig/i, "")}` };
    });
  const readme = extra.find((item) => /^readme\.md$/i.test(item.name));
  if (readme) cards.push({ ...readme, label: "拼图说明" });
  return cards;
}
