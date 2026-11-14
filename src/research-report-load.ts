import { invoke } from "@tauri-apps/api/core";
import { extractResearchSections, researchAbsolutePath, researchRelativePath, type ResearchReport, type ResearchReportKind } from "./research-report";
import type { DirEntryDto } from "./components/FileTree";
import { searchPdfProbes, searchProgress, searchProgressParts } from "./notes-progress";
import { missingToFetchCount, parseToFetchItems } from "./step-flow";
import { checkOutline, outlineThinStatus, type OutlineCheckResult } from "./outline-check";
import { checkNotes, type NoteFile } from "./notes-check";
import { checkDraft, draftProgressParts, imageRefs, manuscriptCandidateDirs, pickManuscript, supersededWritingIds, type DraftStepKind } from "./draft-check";
import { scanWritingReview, writingHitChecks } from "./draft-review";
import { checkStepArtifacts } from "./step-checks";
import type { StepKind } from "./step-kind";
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

/** 精读核对的取数（notes-check.ts 只算）：笔记索引与 notes/ 文件取同一处根（工作副本优先），
 *  避免项目根里尚未并入本工作副本的下游补读/雷达笔记跨根串入旧索引；引文库多处取并集。没有笔记索引返回空 */
const NOTE_FILE_CAP = 400;
export async function loadNotesCheck(roots: readonly string[]): Promise<CheckItem[]> {
  let index: string | null = null;
  let indexRoot = roots[0] ?? "";
  for (const root of roots) {
    const text = await readOptional(root, "notes/index.json");
    if (text != null) {
      index = text;
      indexRoot = root;
      break;
    }
  }
  if (index == null || !indexRoot) return [];
  const noteRoots = indexRoot === roots[0] ? [indexRoot] : [indexRoot, ...roots.filter((r) => r !== indexRoot)];
  const listing = await invoke<DirEntryDto[]>("list_dir", {
    path: researchAbsolutePath(indexRoot, "notes"),
    showHidden: false,
    root: indexRoot,
  }).catch(() => [] as DirEntryDto[]);
  const names = [...new Set(listing.filter((e) => !e.isDir).map((e) => e.name))];
  const md = names.filter((n) => /\.md$/i.test(n)).slice(0, NOTE_FILE_CAP);
  const [bibs, included, extraction, notes, skims] = await Promise.all([
    Promise.all(roots.map((r) => readOptional(r, "references.bib"))),
    firstOptional(roots, "papers/included.json"),
    readFirst(noteRoots, "notes/extraction.md"),
    Promise.all(md.map(async (n): Promise<NoteFile | null> => {
      const text = await readFirst(noteRoots, `notes/${n}`);
      return text == null ? null : { path: `notes/${n}`, text };
    })),
    Promise.all(md.filter((n) => /^skim.*\.md$/i.test(n)).map((n) => readFirst(noteRoots, `notes/${n}`))),
  ]);
  return checkNotes({
    index,
    files: names.map((n) => `notes/${n}`),
    notes: notes.filter((n): n is NoteFile => !!n),
    bibs,
    included,
    extraction,
    skim: skims.filter(Boolean).join("\n"),
  });
}

async function listCandidateManuscripts(root: string, artifacts: readonly string[]): Promise<string[]> {
  const dirs = manuscriptCandidateDirs(artifacts);
  const rows = await Promise.all(
    dirs.map(async (dir) => {
      const entries = await invoke<DirEntryDto[]>("list_dir", {
        path: researchAbsolutePath(root, dir),
        showHidden: false,
        root,
      }).catch(() => [] as DirEntryDto[]);
      return entries.filter((e) => !e.isDir).map((e) => (dir === "." ? e.name : `${dir}/${e.name}`));
    }),
  );
  return [...new Set(rows.flat())];
}

async function probeExistingFiles(root: string, relPaths: readonly string[]): Promise<Set<string> | null> {
  const dirs = [
    ...new Set(
      relPaths
        .map((p) => p.replace(/\\/g, "/").replace(/^\.\//, ""))
        .filter((p) => p && !p.startsWith("/") && !p.startsWith("..") && !/^[A-Za-z]:\//.test(p))
        .map((p) => {
          const idx = p.lastIndexOf("/");
          return idx < 0 ? "." : p.slice(0, idx);
        }),
    ),
  ];
  if (dirs.length === 0) return new Set();
  const existing = new Set<string>();
  let listed = true;
  for (const dir of dirs) {
    const rows = await invoke<DirEntryDto[]>("list_dir", { path: researchAbsolutePath(root, dir), showHidden: false, root }).catch(() => null);
    if (rows === null) {
      if (dir === ".") {
        listed = false;
        continue;
      }
      const parent = dir.split("/").slice(0, -1).join("/") || ".";
      const base = dir.split("/").pop();
      const exists = await invoke<DirEntryDto[]>("list_dir", { path: researchAbsolutePath(root, parent), showHidden: false, root })
        .then((up) => up.some((e) => e.isDir && e.name === base))
        .catch(() => null);
      if (exists !== false) listed = false;
      continue;
    }
    for (const e of rows) {
      if (!e.isDir) existing.add(dir === "." ? e.name : `${dir}/${e.name}`);
    }
  }
  return listed ? existing : null;
}

async function loadDraftCheckWithPrimary(
  roots: readonly string[],
  kind: DraftStepKind,
  artifacts: readonly string[],
): Promise<{ items: CheckItem[]; file: string | null; text: string | null }> {
  const [work] = roots;
  if (!work) return { items: [], file: null, text: null };
  const listed = await listCandidateManuscripts(work, artifacts);
  const file = pickManuscript(artifacts, listed);
  if (!file) return { items: [], file: null, text: null };
  const text = await readFirst([work], file);
  if (text == null) return { items: [], file: null, text: null };
  const figRefs = imageRefs(text, file).filter((r) => r.path.startsWith("figures/")).map((r) => r.path);
  const existing = figRefs.length > 0 ? await probeExistingFiles(work, figRefs) : new Set<string>();
  const [bibs, included, index, sections, styleSheet, outline] = await Promise.all([
    Promise.all(roots.map((r) => readOptional(r, "references.bib"))),
    firstOptional(roots, "papers/included.json"),
    firstOptional(roots, "notes/index.json"),
    readFirst(roots, "manuscript/sections.json"),
    readFirst(roots, "manuscript/style-sheet.md"),
    readFirst(roots, "outline.md"),
  ]);
  const bib = bibs.filter(Boolean).join("\n") || null;
  return {
    items: checkDraft({ kind, file, text, bib, included, index, sections, styleSheet, outline, existingImages: existing }),
    file,
    text,
  };
}

/** 初稿 / 定稿核对的取数（draft-check.ts 只算）：主稿只在工作副本里找（这一步的产物），台账、写作规范、大纲先工作副本后项目根；
 *  稿件引的图按所在目录列一次，看在不在。找不到主稿返回空 */
export async function loadDraftCheck(roots: readonly string[], kind: DraftStepKind, artifacts: readonly string[]): Promise<CheckItem[]> {
  return (await loadDraftCheckWithPrimary(roots, kind, artifacts)).items;
}

const TEXT_STEP_ARTIFACT = /\.(md|qmd|json|csv)$/i;

/** 除大纲外所有步骤的 Mesa 核对统一取数入口（评审页与项目助手共用同一份）：
 *  - notes → 精读核对（loadNotesCheck）
 *  - writing / final → 主稿核对（loadDraftCheck） + 附属文件 / 数字追溯 / 存疑裁决 / 置信区间自洽
 *  - search / clean / design / experiment / analysis / other → 台账对账、分析与实验核对、投稿材料与返修核对 */
export async function loadStepMesaChecks(
  roots: readonly string[],
  kind: StepKind,
  artifacts: readonly string[],
): Promise<CheckItem[]> {
  if (kind === "outline") return [];
  if (kind === "notes") return loadNotesCheck(roots);
  const [work] = roots;
  if (!work) return [];
  if (kind === "search") {
    const [inc, screening] = await Promise.all([
      readOptional(work, "papers/included.json"),
      readFirst([work], "papers/screening.md"),
    ]);
    const files = new Map<string, string>();
    if (inc != null) files.set("papers/included.json", inc);
    if (screening != null) files.set("papers/screening.md", screening);
    return checkStepArtifacts({ kind, artifacts, files });
  }
  const draft =
    kind === "writing" || kind === "final"
      ? await loadDraftCheckWithPrimary(roots, kind, artifacts)
      : { items: [] as CheckItem[], file: null, text: null };
  const files = new Map<string, string>();
  if (draft.file && draft.text != null) files.set(draft.file, draft.text);

  const normArts = artifacts.map((a) => a.replace(/\\/g, "/").replace(/^\.\//, ""));
  const workTargets = new Set<string>(
    normArts.filter((a) => TEXT_STEP_ARTIFACT.test(a) && !/[*?]/.test(a) && a !== draft.file),
  );
  if (kind === "analysis") {
    for (const p of ["analysis/results.json", "analysis/summary-stats.json", "figures/manifest.json", "analysis/findings.md", "analysis/results-table.md", "eda-report.md", "chapters/results.md"]) {
      if (normArts.includes(p) || normArts.some((a) => a.startsWith("figures/"))) workTargets.add(p);
    }
  }
  await Promise.all(
    [...workTargets].map(async (rel) => {
      const t = await readFirst([work], rel);
      if (t != null) files.set(rel, t);
    }),
  );

  // 跨步对账的上游参考台账（本步已产出对应下游 JSON 且工作副本没有上游台账时，回退项目根）
  const upstreamRefs: string[] = [];
  if (files.has("cleaning/fields.json") && !files.has("data/fields.json")) upstreamRefs.push("data/fields.json");
  if ((files.has("results/run-manifest.json") || files.has("results/matrix.json")) && !files.has("experiments/matrix.json")) {
    upstreamRefs.push("experiments/matrix.json");
  }
  await Promise.all(
    upstreamRefs.map(async (rel) => {
      const t = await readFirst(roots, rel);
      if (t != null) files.set(rel, t);
    }),
  );

  // numbers.json 引到的结果文件与目标正文：按需补读并收集待查存在性的路径
  const pathsToProbe = new Set<string>();
  for (const numPath of ["manuscript/numbers.json", "analysis/numbers.json"]) {
    const raw = files.get(numPath);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const list: unknown[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.numbers) ? parsed.numbers : [];
      const extraReads = new Set<string>();
      for (const e of list) {
        if (!e || typeof e !== "object") continue;
        const src = String((e as Record<string, unknown>).source ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
        if (src && !src.startsWith("/") && !src.startsWith("..")) {
          pathsToProbe.add(src);
          if (/\.(json|csv)$/i.test(src) && !files.has(src)) extraReads.add(src);
        }
        const loc = String((e as Record<string, unknown>).location ?? "").trim().replace(/:\d+$/, "").replace(/\\/g, "/").replace(/^\.\//, "");
        if (loc && /\.(md|qmd)$/i.test(loc) && !files.has(loc)) extraReads.add(loc);
      }
      await Promise.all(
        [...extraReads].slice(0, 24).map(async (rel) => {
          const t = await readFirst(roots, rel);
          if (t != null) files.set(rel, t);
        }),
      );
    } catch {
      /* 非法 JSON 交给 checkStepArtifacts 报拦下 */
    }
  }

  for (const [rel, text] of files) {
    if (rel !== draft.file && /\.(md|qmd)$/i.test(rel)) {
      for (const r of imageRefs(text, rel)) {
        if (r.path && !r.path.startsWith("..")) pathsToProbe.add(r.path);
      }
    }
  }
  const dsRaw = files.get("data/datasets.json");
  if (dsRaw) {
    try {
      const parsed = JSON.parse(dsRaw);
      const rows: unknown[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.datasets) ? parsed.datasets : Array.isArray(parsed?.records) ? parsed.records : [];
      for (const r of rows) {
        if (r && typeof r === "object" && typeof (r as Record<string, unknown>).path === "string") {
          pathsToProbe.add(String((r as Record<string, unknown>).path));
        }
      }
    } catch { /* ignore */ }
  }
  const figRaw = files.get("figures/manifest.json");
  if (figRaw) {
    try {
      const parsed = JSON.parse(figRaw);
      const rows: unknown[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.figures) ? parsed.figures : Array.isArray(parsed?.items) ? parsed.items : [];
      for (const r of rows) {
        if (!r || typeof r !== "object") continue;
        for (const f of ["file", "path", "script", "spec"]) {
          const v = (r as Record<string, unknown>)[f];
          if (typeof v === "string" && v.trim()) pathsToProbe.add(v.trim());
        }
      }
    } catch { /* ignore */ }
  }

  const hasNonPrimaryCites = [...files.entries()].some(([rel, text]) => rel !== draft.file && /\.(md|qmd)$/i.test(rel) && text.includes("@"));
  const [existingPaths, bibs, indexes, included] = await Promise.all([
    pathsToProbe.size > 0 ? probeExistingFiles(work, [...pathsToProbe]) : Promise.resolve(null),
    hasNonPrimaryCites ? Promise.all(roots.map((r) => readOptional(r, "references.bib"))) : Promise.resolve([]),
    hasNonPrimaryCites ? Promise.all(roots.map((r) => readOptional(r, "notes/index.json"))) : Promise.resolve([]),
    hasNonPrimaryCites ? firstOptional(roots, "papers/included.json") : Promise.resolve(null),
  ]);

  const extra = checkStepArtifacts({
    kind,
    artifacts,
    files,
    existingPaths,
    bibs,
    indexes,
    included,
    primaryManuscript: draft.file,
  });
  return [...draft.items, ...extra];
}

/** 大纲 / 初稿 / 定稿的写作扫描核验项（与评审页 WorkspaceReviewView 同口径，供项目助手取数共用） */
export async function loadStepWritingChecks(
  worktree: string,
  kind: string,
  artifacts: readonly string[],
  mesaItems: readonly CheckItem[],
): Promise<CheckItem[]> {
  if (!worktree) return [];
  let file: string | null = null;
  if (kind === "outline") {
    file = "outline.md";
  } else if (kind === "writing" || kind === "final") {
    const listed = await listCandidateManuscripts(worktree, artifacts);
    file = pickManuscript(artifacts, listed);
  }
  if (!file) return [];
  const text = await readFirst([worktree], file);
  if (text == null) return [];
  const isOutline = /(^|\/)outline\.md$/i.test(file);
  const superseded = supersededWritingIds(mesaItems);
  return writingHitChecks(
    scanWritingReview(text, { allowGapIds: isOutline, allowNumberedHeadings: isOutline }),
    file,
  ).filter((c) => !superseded.has(c.id));
}

/** 初稿步骤卡的统计行（draft-check.ts draftProgressParts 只算）：工作副本优先、项目根兜底，主稿与 sections.json 取同一处。
 *  没有 md / qmd 主稿（Word、LaTeX 载体）返回 null，不出统计行 */
export async function loadDraftProgress(roots: readonly string[], artifacts: readonly string[]): Promise<string[] | null> {
  for (const root of roots) {
    const listed = await listCandidateManuscripts(root, artifacts);
    if (!listed.length) continue;
    const file = pickManuscript(artifacts, listed);
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
