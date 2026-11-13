import { invoke } from "@tauri-apps/api/core";
import { extractResearchSections, researchAbsolutePath, researchRelativePath, type ResearchReport, type ResearchReportKind } from "./research-report";
import type { DirEntryDto } from "./components/FileTree";
import { searchPdfProbes, searchProgress, searchProgressParts } from "./notes-progress";
import { missingToFetchCount, parseToFetchItems } from "./step-flow";
import { checkOutline, outlineThinStatus, type OutlineCheckResult } from "./outline-check";
import { checkNotes, type NoteFile } from "./notes-check";
import { checkDraft, draftProgressParts, imageRefs, pickManuscript, type DraftStepKind } from "./draft-check";
import type { CheckItem } from "./research-checks";

export interface ReportPreview { text: string; truncated: boolean; revision: string | null; readOnlyReason?: string | null }
export interface ResearchReportLoad { reports: ResearchReport[]; warnings: string[]; scanned: number; files: string[] }

export async function readResearchFile(root: string, path: string): Promise<ReportPreview> {
  const value = await invoke<ReportPreview>("read_file_preview", { root, path: researchAbsolutePath(root, path), requireWithinRoot: true });
  // Existing preview API supports external symlinks for manual browsing; automatic summaries do not.
  if (value.readOnlyReason && !value.truncated) throw new Error(value.readOnlyReason);
  return value;
}

/** 科研台账整份读（纳入清单/待获取/两份 RIS/笔记索引/引文库，后端白名单）：
 *  预览通道 256 KB 封顶，两百篇带摘要的 included.json 就超了——截断后清单整块读不出来。 */
export async function readResearchLedger(root: string, path: string): Promise<ReportPreview> {
  const value = await invoke<ReportPreview>("read_research_ledger", { root, path: researchAbsolutePath(root, path) });
  if (value.readOnlyReason && !value.truncated) throw new Error(value.readOnlyReason);
  return value;
}

/** 对照项目 papers/ 里实际有没有这些篇的 PDF（to_fetch_progress，与待获取清单「已存」同一口径）。对不上或出错都当没有 */
async function probePapers(projectRoot: string, items: { title: string; url: string }[]): Promise<(string | null)[]> {
  if (items.length === 0) return [];
  const names = await invoke<(string | null)[] | null>("to_fetch_progress", {
    projectRoot,
    items: items.map((it) => ({ title: it.title, url: it.url })),
  }).catch(() => null);
  return Array.isArray(names) ? names : [];
}

/** 检索篇数一行：台账没记 pdf、但 papers/ 里已经有的也算已有全文（PDF 下在项目根，所以对照 projectRoot） */
export async function searchCountLineWithFiles(projectRoot: string, includedText: string): Promise<string[] | null> {
  const probes = searchPdfProbes(includedText);
  const names = await probePapers(projectRoot, probes);
  const found = new Set(probes.flatMap((p, i) => (names[i] ? [p.id] : [])));
  const p = searchProgress(includedText, found);
  return p ? searchProgressParts(p) : null;
}

/** 待获取还缺几篇：去掉已勾 ✓ 的和 papers/ 里已经有的（不是清单总条数） */
export async function missingToFetchWithFiles(projectRoot: string, toFetchText: string): Promise<number> {
  const items = parseToFetchItems(toFetchText).filter((it) => !it.done);
  const names = await probePapers(projectRoot, items);
  const doneByLine: Record<number, string> = {};
  items.forEach((it, i) => {
    if (names[i]) doneByLine[it.line] = names[i] as string;
  });
  return missingToFetchCount(toFetchText, doneByLine);
}

/** 大纲核对的取数（outline-check.ts 只算）：outline.md 取第一处有的（工作副本优先）；笔记索引、引文库几处都读、按键合并
 *  （精读保存进项目后，大纲这边不等并入就数得到）；纳入清单以项目根为准。roots 末位是项目根。读不到大纲返回 null */
async function readOptional(root: string, rel: string): Promise<string | null> {
  try {
    const file = await readResearchLedger(root, rel);
    return file.truncated ? null : file.text;
  } catch {
    return null;
  }
}

async function readOutline(roots: readonly string[]): Promise<string | null> {
  for (const root of roots) {
    try {
      const file = await readResearchFile(root, "outline.md");
      if (!file.truncated) return file.text;
    } catch {
      /* 这一处没有大纲，试下一处 */
    }
  }
  return null;
}

export async function loadOutlineCheck(roots: readonly string[]): Promise<OutlineCheckResult | null> {
  const outline = await readOutline(roots);
  if (outline == null) return null;
  const [indexes, bibs, includeds] = await Promise.all([
    Promise.all(roots.map((r) => readOptional(r, "notes/index.json"))),
    Promise.all(roots.map((r) => readOptional(r, "references.bib"))),
    Promise.all([...roots].reverse().map((r) => readOptional(r, "papers/included.json"))),
  ]);
  return checkOutline({ outline, indexes, bibs, included: includeds.find((t) => t != null) ?? null });
}

/** 第一处读得到的预览文件（不在台账白名单里的：抽取表、速读表、笔记） */
async function readFirst(roots: readonly string[], rel: string): Promise<string | null> {
  for (const root of roots) {
    try {
      const file = await readResearchFile(root, rel);
      if (!file.truncated) return file.text;
    } catch {
      /* 这一处没有，试下一处 */
    }
  }
  return null;
}

async function firstOptional(roots: readonly string[], rel: string): Promise<string | null> {
  for (const root of roots) {
    const text = await readOptional(root, rel);
    if (text != null) return text;
  }
  return null;
}

/** 精读核对的取数（notes-check.ts 只算）：工作副本和项目根都读、以工作副本为准（同 notes-progress 口径）；
 *  notes/ 下的文件两处取并集，笔记内容按文件先工作副本后项目根读。roots 首位是工作副本。没有笔记索引返回空 */
const NOTE_FILE_CAP = 400;
export async function loadNotesCheck(roots: readonly string[]): Promise<CheckItem[]> {
  const index = await firstOptional(roots, "notes/index.json");
  if (index == null) return [];
  const listings = await Promise.all(
    roots.map((root) =>
      invoke<DirEntryDto[]>("list_dir", { path: researchAbsolutePath(root, "notes"), showHidden: false, root }).catch(() => [] as DirEntryDto[]),
    ),
  );
  const names = [...new Set(listings.flat().filter((e) => !e.isDir).map((e) => e.name))];
  const md = names.filter((n) => /\.md$/i.test(n)).slice(0, NOTE_FILE_CAP);
  const [bib, included, extraction, notes, skims] = await Promise.all([
    firstOptional(roots, "references.bib"),
    firstOptional(roots, "papers/included.json"),
    readFirst(roots, "notes/extraction.md"),
    Promise.all(md.map(async (n): Promise<NoteFile | null> => {
      const text = await readFirst(roots, `notes/${n}`);
      return text == null ? null : { path: `notes/${n}`, text };
    })),
    Promise.all(md.filter((n) => /^skim.*\.md$/i.test(n)).map((n) => readFirst(roots, `notes/${n}`))),
  ]);
  return checkNotes({
    index,
    files: names.map((n) => `notes/${n}`),
    notes: notes.filter((n): n is NoteFile => !!n),
    bib,
    included,
    extraction,
    skim: skims.filter(Boolean).join("\n"),
  });
}

/** 初稿 / 定稿核对的取数（draft-check.ts 只算）：主稿只在工作副本里找（这一步的产物），台账、写作规范、大纲先工作副本后项目根；
 *  稿件引的图按所在目录列一次，看在不在。找不到主稿返回空 */
export async function loadDraftCheck(roots: readonly string[], kind: DraftStepKind, artifacts: readonly string[]): Promise<CheckItem[]> {
  const [work] = roots;
  if (!work) return [];
  const listing = await invoke<DirEntryDto[]>("list_dir", { path: researchAbsolutePath(work, "manuscript"), showHidden: false, root: work }).catch(() => [] as DirEntryDto[]);
  const file = pickManuscript(artifacts, listing.filter((e) => !e.isDir).map((e) => `manuscript/${e.name}`));
  if (!file) return [];
  const text = await readFirst([work], file);
  if (text == null) return [];
  const dirs = [...new Set(imageRefs(text, file).map((r) => r.path.split("/").slice(0, -1).join("/")).filter((d) => d.startsWith("figures")))];
  const existing = new Set<string>();
  let listed = true;
  for (const dir of dirs) {
    const rows = await invoke<DirEntryDto[]>("list_dir", { path: researchAbsolutePath(work, dir), showHidden: false, root: work }).catch(() => null);
    if (rows === null) {
      // 目录本身不在：里面引的图都不在；列不出来的别的原因当没查
      const exists = await invoke<DirEntryDto[]>("list_dir", { path: researchAbsolutePath(work, dir.split("/").slice(0, -1).join("/") || "."), showHidden: false, root: work })
        .then((up) => up.some((e) => e.isDir && e.name === dir.split("/").pop()))
        .catch(() => null);
      if (exists !== false) listed = false;
      continue;
    }
    for (const e of rows) if (!e.isDir) existing.add(`${dir}/${e.name}`);
  }
  const [bib, included, index, sections, styleSheet, outline] = await Promise.all([
    firstOptional(roots, "references.bib"),
    firstOptional(roots, "papers/included.json"),
    firstOptional(roots, "notes/index.json"),
    readFirst(roots, "manuscript/sections.json"),
    readFirst(roots, "manuscript/style-sheet.md"),
    readFirst(roots, "outline.md"),
  ]);
  return checkDraft({ kind, file, text, bib, included, index, sections, styleSheet, outline, existingImages: listed ? existing : null });
}

/** 初稿步骤卡的统计行（draft-check.ts draftProgressParts 只算）：工作副本优先、项目根兜底，主稿与 sections.json 取同一处。
 *  没有 md / qmd 主稿（Word、LaTeX 载体）返回 null，不出统计行 */
export async function loadDraftProgress(roots: readonly string[], artifacts: readonly string[]): Promise<string[] | null> {
  for (const root of roots) {
    const listing = await invoke<DirEntryDto[]>("list_dir", { path: researchAbsolutePath(root, "manuscript"), showHidden: false, root }).catch(() => null);
    if (!listing) continue;
    const file = pickManuscript(artifacts, listing.filter((e) => !e.isDir).map((e) => `manuscript/${e.name}`));
    if (!file) continue;
    const text = await readFirst([root], file);
    if (text == null) continue;
    return draftProgressParts(text, await readFirst([root], "manuscript/sections.json"));
  }
  return null;
}

/** 大纲步骤卡计数行的「薄几节」：大纲里判薄的节，补料（补读点名的篇、为这一节补检来的新篇）到了的另算 */
export async function outlineThinWithNotes(roots: readonly string[], outline: string) {
  const indexes = await Promise.all(roots.map((r) => readOptional(r, "notes/index.json")));
  return outlineThinStatus(outline, indexes);
}

/** 台账整份写回：带读取时的版本，磁盘已被 Agent 改过就拒绝。返回新版本。 */
export async function saveResearchLedger(root: string, path: string, text: string, expectedRevision: string): Promise<string> {
  return invoke<string>("save_research_ledger", { root, path: researchAbsolutePath(root, path), text, expectedRevision });
}

export async function loadResearchReports(root: string, patterns: string[], kind: ResearchReportKind): Promise<ResearchReportLoad> {
  const warnings: string[] = [];
  const paths = new Set<string>();
  const dirs = new Map<string, Promise<DirEntryDto[]>>();
  const files: string[] = [];
  let limited = patterns.length > 32;
  // Exact report files take precedence over broad note directories when the scan is capped.
  const ordered = [...patterns].sort((a, b) => Number(!(/\.(md|markdown|txt)$/i.test(a) && !a.includes("*"))) - Number(!(/\.(md|markdown|txt)$/i.test(b) && !b.includes("*"))));
  for (const pattern of ordered.slice(0, 32)) {
    const p = researchRelativePath(pattern);
    if (!p) { warnings.push(`忽略项目外路径：${pattern}`); continue; }
    if (/\.(md|markdown|txt)$/i.test(p) && !p.includes("*")) { paths.add(p); continue; }
    const slash = p.lastIndexOf("/");
    const dir = p.endsWith("/") ? p.slice(0, -1) : p.slice(0, slash);
    const glob = p.endsWith("/") ? "*" : p.slice(slash + 1);
    if (!dir || dir.includes("*")) { warnings.push(`未展开路径：${p}`); continue; }
    if (!dirs.has(dir)) dirs.set(dir, invoke<DirEntryDto[]>("list_dir", { path: researchAbsolutePath(root, dir), showHidden: false, root }));
    try {
      const rows = await dirs.get(dir)!;
      if (rows.length >= 2000) warnings.push(`${dir}：目录列举达到上限，可能未覆盖全部报告`);
      const matcher = new RegExp(`^${glob.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
      for (const row of rows) {
        if (row.isDir || !matcher.test(row.name) || !/\.(md|markdown|txt)$/i.test(row.name) || /[\\/]/.test(row.name)) continue;
        paths.add(`${dir}/${row.name}`);
        if (paths.size > 40) { limited = true; break; }
      }
    } catch (reason) { warnings.push(`${dir}：${String(reason)}`); }
  }
  limited = limited || paths.size > 40;
  const reports: ResearchReport[] = [];
  for (const path of [...paths].slice(0, 40)) {
    if (/(?:^|\/)TASK\.md$/i.test(path)) continue;
    try {
      const preview = await readResearchFile(root, path);
      files.push(path);
      const explicit = extractResearchSections(preview.text, kind);
      // Writing decisions often consume a G4 acceptance summary rather than a new decision memo.
      const sections = explicit.length || kind !== "decision" ? explicit : extractResearchSections(preview.text, "acceptance");
      if (sections.length) reports.push({ path, sections, truncated: preview.truncated, revision: preview.revision });
      if (preview.truncated) warnings.push(`${path}：文件截断，摘要可能不完整，请查看原文件`);
    } catch (reason) { warnings.push(`${path}：${String(reason)}`); }
  }
  if (limited) warnings.push("只检查前32个声明路径、最多40个文件；其余请在文件预览中核对");
  return { reports, warnings, scanned: Math.min(paths.size, 40), files };
}
