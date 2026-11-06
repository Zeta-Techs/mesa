/**
 * 资料全貌（2026-11-06 流程贯通 §7，design-flow-weave.md）的纯逻辑：前面几步轮流打磨同几份资料（文献库、笔记、大纲、稿件），
 * 项目页一块里一行一份，写清现状（从文件机械数，不靠 AI 自述）、跟上游对齐没有，加上在途的回头（补料单走到哪、链等谁）。
 * 行按步骤与技能槽认，引擎不认综述；读文件在组件里（MaterialsOverview.tsx），这里只拼说法。配 tests/materials-overview.test.ts。
 */
import { stepFillsAnySlot, type SkillProvides } from "./skill-slots.ts";
import { chainWhere, type ReworkDto } from "./step-loop.ts";
import {
  excludedIncludedIds,
  notesProgress,
  notesProgressLine,
  outlineProgress,
  outlineProgressParts,
  searchProgress,
  searchProgressLine,
} from "./notes-progress.ts";

export type AssetKind = "search" | "notes" | "outline" | "other";

/** 这一步管的是哪份资料：检索 → 文献库，精读 → 笔记，交 outline.md 的 → 大纲，其余按步骤名叫 */
export function assetKind(
  step: { skills?: readonly string[]; expectedArtifacts?: readonly string[] },
  provides: SkillProvides,
): AssetKind {
  if (stepFillsAnySlot(step.skills, ["lit-search"], provides)) return "search";
  if (stepFillsAnySlot(step.skills, ["lit-notes"], provides)) return "notes";
  if ((step.expectedArtifacts ?? []).some((a) => a.replace(/\\/g, "/").replace(/^\.\//, "") === "outline.md")) return "outline";
  return "other";
}

export const ASSET_LABEL: Record<AssetKind, string> = {
  search: "文献库",
  notes: "笔记",
  outline: "大纲",
  other: "",
};

/** 一份资料此刻的机械计数（读不到 / 解析不了返回 null，界面不猜） */
export function assetCounts(kind: AssetKind, files: { included?: string | null; index?: string | null; outline?: string | null }): string | null {
  if (kind === "search" && files.included) {
    const p = searchProgress(files.included);
    return p ? searchProgressLine(p) : null;
  }
  if (kind === "notes" && files.index) {
    const p = notesProgress(files.index, files.included ? excludedIncludedIds(files.included) : new Set());
    return p ? notesProgressLine(p) : null;
  }
  if (kind === "outline" && files.outline) {
    const p = outlineProgress(files.outline);
    const parts = p ? outlineProgressParts(p) : [];
    return parts.length ? parts.join(" · ") : "有大纲";
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
