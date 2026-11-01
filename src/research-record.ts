/**
 * 研究记录面板纯逻辑（2026-11-02，docs/design-research-moat.md §3.2）：.ccode/record.jsonl 一条运行一行，
 * 导出三件（AI 使用声明草稿 / 复现包 / 研究过程报告）走 research_export。
 */
import { AGENTS } from "./types.ts";

export interface RunRecordDto {
  runId: string;
  taskKind: string;
  purpose: string;
  agent: string;
  profileId?: string | null;
  models: string[];
  createdAt: string;
  closedAt?: string | null;
  status: string;
  exitCode?: number | null;
  checks?: { passed: number; blocked: number; needsHuman: number } | null;
}

export type ResearchExportKind = "ai_statement" | "repro_pack" | "process_report";

export const RESEARCH_EXPORTS: { kind: ResearchExportKind; label: string; hint: string }[] = [
  {
    kind: "ai_statement",
    label: "AI 使用声明草稿",
    hint: "按记录统计用过的 AI 工具、模型与用途，拼成中英两段草稿；措辞与 Mesa 之外用过的工具由你核对补充",
  },
  {
    kind: "repro_pack",
    label: "复现包",
    hint: "代码、环境文件、登记文件、引文库、研究记录与核验存档打成 zip；数据不带本体，只记哈希",
  },
  {
    kind: "process_report",
    label: "研究过程报告",
    hint: "给导师、学位办或伦理审查看的网页：AI 运行时间线、人的决定、核验摘要与人机分工；不含对话原文",
  },
];

const STATUS: Record<string, string> = { completed: "完成", failed: "失败", stopped: "停止" };

export function runRecordLine(record: RunRecordDto): { title: string; meta: string; flag: string } {
  const agent = AGENTS.find((a) => a.id === record.agent)?.label ?? record.agent;
  const models = record.models.length ? record.models.join("、") : "模型未记录";
  const status = STATUS[record.status] ?? record.status;
  const c = record.checks;
  const flag = c ? [c.blocked ? `拦下 ${c.blocked}` : "", c.needsHuman ? `待判断 ${c.needsHuman}` : ""].filter(Boolean).join(" · ") : "";
  return { title: record.purpose, meta: `${agent} · ${models} · ${status}`, flag };
}
