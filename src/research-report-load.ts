import { invoke } from "@tauri-apps/api/core";
import { extractResearchSections, researchAbsolutePath, researchRelativePath, type ResearchReport, type ResearchReportKind } from "./research-report";
import type { DirEntryDto } from "./components/FileTree";
import { searchPdfProbes, searchProgress, searchProgressLine } from "./notes-progress";
import { missingToFetchCount, parseToFetchItems } from "./step-flow";

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
export async function searchCountLineWithFiles(projectRoot: string, includedText: string): Promise<string | null> {
  const probes = searchPdfProbes(includedText);
  const names = await probePapers(projectRoot, probes);
  const found = new Set(probes.flatMap((p, i) => (names[i] ? [p.id] : [])));
  const p = searchProgress(includedText, found);
  return p ? searchProgressLine(p) : null;
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
