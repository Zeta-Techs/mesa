import type { GitFileDto } from "./types";

/** 开工软门纯逻辑：项目根未提交改动与本步声明输入（inputs/optionalInputs/anyOfInputs 并集）
 *  的相交判定。工作区从本地基准分支 HEAD 建树，未提交的改动带不进去——命中就要在开工前
 *  「存进历史」或二次确认（2026-09-20，与上一步收尾软门同款只确认不阻断）。
 *  输入形态按模板实际写法收敛：目录（notes/）、文件（references.bib）、单层 glob（papers/*.pdf）；
 *  其余带通配符的按字面量比。git 路径恒为 / 分隔，Windows 侧也归一后再比。 */

function normPath(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/** 单条输入是否命中一个仓库相对路径文件 */
export function inputPathMatches(input: string, filePath: string): boolean {
  const pat = normPath(input);
  const file = normPath(filePath);
  if (pat === "" || file === "") return false;
  // 单层 *.ext glob（"papers/*.pdf" / "*.pdf"）：目录内（无根时为仓库顶层）直接子文件按扩展名
  const glob = /^(?:(.*)\/)?\*\.([A-Za-z0-9]+)$/.exec(pat);
  if (glob) {
    const dir = (glob[1] ?? "").replace(/\/+$/, "");
    const ext = glob[2].toLowerCase();
    const rest =
      dir === ""
        ? file
        : file.startsWith(`${dir}/`)
          ? file.slice(dir.length + 1)
          : null;
    return (
      rest !== null &&
      !rest.includes("/") &&
      rest.toLowerCase().endsWith(`.${ext}`)
    );
  }
  if (file === pat) return true;
  // 目录输入（"notes/" 或 "notes"）：命中其下任意深度文件；同级前缀名不算（notes2/ ≠ notes/）
  const dir = pat.replace(/\/+$/, "");
  return dir !== "" && file.startsWith(`${dir}/`);
}

/** 改动文件里命中本步输入的子集（保持原顺序，前端就地渲染文件名单） */
export function dirtyInputHits(
  files: readonly GitFileDto[],
  inputs: readonly string[],
): GitFileDto[] {
  const patterns = inputs.map(normPath).filter((p) => p !== "");
  return files.filter((f) =>
    patterns.some((pat) => inputPathMatches(pat, f.path)),
  );
}

/** 开工接驳面（2026-10-13 双台账拍板）：这些路径的未提交改动属于「积累面」——
 *  流程正典清单（papers/included.md、included.json、to-fetch.md、to-fetch.ris）与用户笔记
 *  （notes/ 下任意深度 .md，及其配图 notes/assets/）。papers/reading-list.md 是 gitignored 的积累账，不在此列：
 *  它经 freeze_reading_list_intake 冻结快照进工作区，不走 git。inbox.md 已被 gitignore，
 *  porcelain 里本就不会出现，这里显式排除是双保险。 */
export type IntakeBridgeKind = "ledger" | "notes" | "asset";

export interface IntakeBridgeHit {
  path: string;
  kind: IntakeBridgeKind;
  /** 已入库文件的改动（非 ??）：整文件行数不是新行，摘要不按行数报 */
  modified?: true;
}

/** 单个仓库相对路径是否属于积累面；命中返回分类，否则 null */
export function intakeBridgeSurfaceKind(path: string): IntakeBridgeKind | null {
  const p = normPath(path);
  if (
    p === "papers/included.md" ||
    p === "papers/included.json" ||
    p === "papers/to-fetch.md" ||
    p === "papers/to-fetch.ris"
  ) {
    return "ledger";
  }
  if (p.startsWith("notes/") && p.endsWith(".md") && p !== "notes/inbox.md") {
    return "notes";
  }
  // 沉浸阅读截图（笔记里引用的配图）跟笔记一起带进基准，否则工作区里的笔记图是断的
  if (p.startsWith("notes/assets/")) return "asset";
  return null;
}

/** 脏文件里的积累面子集（保序）：开工接驳的候选提交集 */
export function intakeBridgeHits(
  files: readonly { path: string; status?: string }[],
): IntakeBridgeHit[] {
  const out: IntakeBridgeHit[] = [];
  for (const f of files) {
    const kind = intakeBridgeSurfaceKind(f.path);
    if (!kind) continue;
    out.push(f.status && f.status !== "??" ? { path: normPath(f.path), kind, modified: true } : { path: normPath(f.path), kind });
  }
  return out;
}

export interface IntakeBridgeSummary {
  /** 清单 md（included.md / to-fetch.md）非注释行合计（主仓当前内容） */
  ledgerLines: number;
  /** 未提交笔记份数（积累面里的 notes/*.md 个数） */
  notesCount: number;
  /** 未提交的笔记配图（notes/assets/ 下的文件；整个目录未跟踪时 git 只报一行目录） */
  assetsCount: number;
  /** 配图里有整目录的一行（数不清张数，只说「笔记配图」） */
  assetsDir: boolean;
}

/** 非注释行口径与后端 count_list_lines 一致：去空白后非空、且不以 # 开头 */
export function countNonCommentLines(text: string): number {
  return text.split(/\r?\n/).filter((line) => {
    const t = line.trim();
    return t !== "" && !t.startsWith("#");
  }).length;
}

/** 积累面摘要：新建的清单 md 拿主仓当前文件内容数非注释行，笔记按文件个数。
 *  texts 是脏清单 md 的主仓内容（读不到的按空计）；结构化清单（json/ris）不进行数。 */
export function summarizeIntakeBridge(
  hits: readonly IntakeBridgeHit[],
  texts: Readonly<Record<string, string>>,
): IntakeBridgeSummary {
  let ledgerLines = 0;
  let notesCount = 0;
  let assetsCount = 0;
  let assetsDir = false;
  for (const hit of hits) {
    if (hit.kind === "notes") {
      notesCount += 1;
      continue;
    }
    if (hit.kind === "asset") {
      assetsCount += 1;
      if (hit.path.endsWith("/")) assetsDir = true;
      continue;
    }
    // 新文件整份都是新行；已入库的清单改了几行数不出来，只报「清单文件待提交」
    if (hit.path.endsWith(".md") && !hit.modified) {
      ledgerLines += countNonCommentLines(texts[hit.path] ?? "");
    }
  }
  return { ledgerLines, notesCount, assetsCount, assetsDir };
}

/** 弹层一行的白话摘要：「清单 N 条新行 / M 篇未提交笔记」（哪段有命中才出现哪段） */
export function intakeBridgeLabel(summary: IntakeBridgeSummary, ledgerHitCount: number): string {
  const parts: string[] = [];
  if (summary.ledgerLines > 0) {
    parts.push(`清单 ${summary.ledgerLines} 条新行`);
  } else if (ledgerHitCount > 0) {
    parts.push("清单文件待提交");
  }
  if (summary.notesCount > 0) {
    parts.push(`${summary.notesCount} 篇未提交笔记`);
  }
  if (summary.assetsCount > 0) {
    parts.push(summary.assetsDir ? "笔记配图" : `${summary.assetsCount} 张笔记配图`);
  }
  return parts.join(" / ");
}
