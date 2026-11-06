/**
 * 资料全貌（2026-11-06 流程贯通 §7，design-flow-weave.md）的纯逻辑：前面几步轮流打磨同几份资料（文献库、笔记、大纲、稿件），
 * 项目页一块里一行一份，写清现状（从文件机械数，不靠 AI 自述）、跟上游对齐没有，加上在途的回头（补料单走到哪、链等谁）。
 * 行按步骤与技能槽认，引擎不认综述；读文件在组件里（MaterialsOverview.tsx），这里只拼说法。配 tests/materials-overview.test.ts。
 */
import { chainWhere, type ReworkDto } from "./step-loop.ts";
import type { StepKind } from "./step-kind.ts";
import {
  excludedIncludedIds,
  notesProgress,
  notesProgressLine,
  outlineProgress,
  outlineProgressParts,
  searchProgress,
  searchProgressLine,
  skimRowCount,
} from "./notes-progress.ts";

/** 资料全貌要读的文件（项目根相对路径；按步骤类型取，读不到的为 null） */
export interface AssetFiles {
  included?: string | null;
  index?: string | null;
  /** 文献数据抽取表 notes/extraction.md（2026-11-07） */
  extraction?: string | null;
  outline?: string | null;
  /** 实验设计的 experiments/matrix.json、实验执行的 results/matrix.json */
  matrix?: string | null;
  /** 清洗的 cleaning/rule-decisions.md */
  decisions?: string | null;
  /** 分析的 figures/manifest.json */
  figures?: string | null;
  /** 分析步交的几份报告（数「## 结论条目」用） */
  reports?: string[];
}

/** 这一类步骤现状要读哪些文件（ledger = 走台账白名单读，否则走只读预览）。分析步的报告按它交的 .md 产物取，最多 4 份 */
export function assetFilesFor(kind: StepKind, expectedArtifacts: readonly string[] = []): { key: keyof AssetFiles; path: string; ledger?: boolean }[] {
  switch (kind) {
    case "search":
      return [{ key: "included", path: "papers/included.json", ledger: true }];
    case "notes":
      return [
        { key: "included", path: "papers/included.json", ledger: true },
        { key: "index", path: "notes/index.json", ledger: true },
        { key: "extraction", path: "notes/extraction.md" },
      ];
    case "outline":
      return [{ key: "outline", path: "outline.md" }];
    case "design":
      return [{ key: "matrix", path: "experiments/matrix.json" }];
    case "experiment":
      return [{ key: "matrix", path: "results/matrix.json" }];
    case "clean":
      return [{ key: "decisions", path: "cleaning/rule-decisions.md" }];
    case "analysis":
      return [
        { key: "figures", path: "figures/manifest.json" },
        ...expectedArtifacts
          .map((a) => a.replace(/\\/g, "/"))
          .filter((a) => a.endsWith(".md") && !a.includes("*"))
          .slice(0, 4)
          .map((path) => ({ key: "reports" as const, path })),
      ];
    default:
      return [];
  }
}

function jsonRows(text: string): unknown[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    for (const value of Object.values(parsed as Record<string, unknown>)) if (Array.isArray(value)) return value;
    return Object.keys(parsed as Record<string, unknown>).length ? Object.values(parsed as Record<string, unknown>) : null;
  }
  return null;
}

const DONE = /^(done|completed?|success|succeeded|ok|finished|完成|已完成)$/i;
const FAILED = /^(failed|fail|error|失败)$/i;
const NOT_RUN = /^(not-run|not_run|cancell?ed|skipped|取消|未运行)$/i;

/** 实验矩阵按 status 数：完成 / 失败 / 没跑（取消、not-run）/ 其余算待跑 */
export function matrixCounts(text: string): { total: number; done: number; failed: number; notRun: number } | null {
  const rows = jsonRows(text);
  if (!rows || rows.length === 0) return null;
  const out = { total: rows.length, done: 0, failed: 0, notRun: 0 };
  for (const row of rows) {
    const status = String((row as Record<string, unknown> | null)?.status ?? "").trim();
    if (DONE.test(status)) out.done += 1;
    else if (FAILED.test(status)) out.failed += 1;
    else if (NOT_RUN.test(status)) out.notRun += 1;
  }
  return out;
}

/** 一类步骤此刻的机械计数（读不到 / 解析不了返回 null，界面不猜） */
export function assetCounts(kind: StepKind, files: AssetFiles): string | null {
  if (kind === "search" && files.included) {
    const p = searchProgress(files.included);
    return p ? searchProgressLine(p) : null;
  }
  if (kind === "notes" && files.index) {
    const p = notesProgress(files.index, files.included ? excludedIncludedIds(files.included) : new Set());
    const rows = files.extraction ? skimRowCount(files.extraction) : null;
    const parts = [p ? notesProgressLine(p) : null, rows ? `抽取表 ${rows} 行` : null].filter(Boolean);
    return parts.length ? parts.join(" · ") : null;
  }
  if (kind === "outline" && files.outline) {
    const p = outlineProgress(files.outline);
    const parts = p ? outlineProgressParts(p) : [];
    return parts.length ? parts.join(" · ") : "有大纲";
  }
  if (kind === "design" && files.matrix) {
    const m = matrixCounts(files.matrix);
    return m ? `实验矩阵 ${m.total} 组` : null;
  }
  if (kind === "experiment" && files.matrix) {
    const m = matrixCounts(files.matrix);
    if (!m) return null;
    const parts = [`矩阵 ${m.total} 组：完成 ${m.done}`];
    if (m.failed) parts.push(`失败 ${m.failed}`);
    if (m.notRun) parts.push(`没跑 ${m.notRun}`);
    const waiting = m.total - m.done - m.failed - m.notRun;
    if (waiting) parts.push(`待跑 ${waiting}`);
    return parts.join(" · ");
  }
  if (kind === "clean" && files.decisions != null) {
    const n = (files.decisions.match(/裁决[:：]\s*待裁决/g) ?? []).length;
    return n > 0 ? `${n} 条规则待你裁决` : "规则都裁决过了";
  }
  if (kind === "analysis") {
    const parts: string[] = [];
    const figs = files.figures ? jsonRows(files.figures) : null;
    if (figs && figs.length) parts.push(`图 ${figs.length} 张`);
    const conclusions = (files.reports ?? []).reduce((n, t) => n + (t.match(/^\s*-\s*C\d{3,}\s*\|/gm) ?? []).length, 0);
    if (conclusions) parts.push(`结论条目 ${conclusions} 条`);
    return parts.length ? parts.join(" · ") : null;
  }
  return null;
}

function mmdd(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface OverviewRow {
  name: string;
  /** 「文献库」「笔记」「大纲」或空（按步骤名叫） */
  asset: string;
  state: string;
  counts: string | null;
  align: { text: string; tone: "ok" | "warn" | "idle" };
}

/** 一步一行：没开工的不出（空节点不出现） */
export function overviewRow(input: {
  name: string;
  asset: string;
  key: string;
  staleUpstream?: string | null;
  mergedAt?: string | null;
  counts: string | null;
}): OverviewRow | null {
  const state =
    input.key === "done"
      ? `已保存${input.mergedAt ? ` ${mmdd(input.mergedAt)}` : ""}`
      : input.key === "review"
        ? "待评审"
        : input.key === "blocked"
          ? "有冲突"
          : input.key === "active" || input.key === "checking"
            ? "进行中"
            : null;
  if (!state) return null;
  const stale = input.staleUpstream;
  const align: OverviewRow["align"] = stale
    ? { text: input.key === "done" ? `落后于「${stale}」，还没跟进` : `「${stale}」有新内容还没并进来`, tone: "warn" }
    : input.key === "done"
      ? { text: "已对齐", tone: "ok" }
      : { text: "", tone: "idle" };
  return { name: input.name, asset: input.asset, state, counts: input.counts, align };
}

/** 在途的回头一行；补完了而且链（如有）也走完 / 停掉了返回 null。savedAt：某一步最近一次保存进项目的时间 */
export function reworkLine(
  r: Pick<ReworkDto, "fromStep" | "toStep" | "sentAt" | "chain" | "chainState">,
  savedAt: (step: string) => string | null,
): { text: string; chainActive: boolean } | null {
  const saved = savedAt(r.toStep);
  const done = !!saved && Date.parse(saved) > Date.parse(r.sentAt);
  const where = chainWhere(r, savedAt);
  if (done && (where.kind === "none" || where.kind === "done" || where.kind === "stopped")) return null;
  const parts = [`补料单「${r.fromStep}」→「${r.toStep}」（${mmdd(r.sentAt)} 发出）：${done ? "已补完" : "在补"}`];
  if (where.kind === "waiting" && where.step !== r.toStep) parts.push(`链：等「${where.step}」评审、保存`);
  else if (where.kind === "waiting") parts.push(`补完保存后接着跟进「${(r.chain ?? []).join("」「")}」`);
  else if (where.kind === "next") parts.push(`链：轮到「${where.step}」跟进`);
  else if (where.kind === "stopped") parts.push("链已停");
  return { text: parts.join(" · "), chainActive: where.kind === "waiting" || where.kind === "next" };
}

/** 折起时那一行：几份资料、几份没对齐、几张补料单在途；都对齐、没在途时说「都对齐了」 */
export function overviewSummary(rows: readonly OverviewRow[], inFlight: number): string {
  const behind = rows.filter((r) => r.align.tone === "warn").length;
  const parts = [`${rows.length} 步开过工`];
  parts.push(behind > 0 ? `${behind} 步没跟上上游` : "都对齐了");
  if (inFlight > 0) parts.push(`${inFlight} 张补料单在途`);
  return parts.join(" · ");
}
