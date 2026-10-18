/** 步骤卡上的报告自述：质量状态和未决标记计数。不是系统认证。 */

export interface StepEvidenceSummary {
  status: string | null;
  unverified: number;
  pending: number;
}

const STATUS =
  /质量状态[：:\s]*\**\s*(已生成待审|有条件接受(?:（[^）]*）)?|证据通过(?:（[^）]*）)?|阻塞)/;

export function stepEvidenceSummary(text: string): StepEvidenceSummary {
  return {
    status: text.match(STATUS)?.[1] ?? null,
    unverified: text.match(/\[待核实\]/g)?.length ?? 0,
    pending: text.match(/\[待确认\]/g)?.length ?? 0,
  };
}

export function stepEvidenceLabel(summary: StepEvidenceSummary): string | null {
  const parts: string[] = [];
  if (summary.status) parts.push(summary.status);
  if (summary.unverified > 0) parts.push(`待核实 ${summary.unverified}`);
  if (summary.pending > 0) parts.push(`待确认 ${summary.pending}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** 审查类文件（报告、改动记录、引用检查、裁决清单、章节状态）：里面的 [待核实] 是在
 *  「描述」问题，不是稿子里还剩的未决标记——计进去会让定稿步头部写「待核实 5」，
 *  而稿子里一处都没有（2026-10-18 实测）。 */
const META_REPORT = /(?:^|\/)(?:review-report|changelog|citation-check|verification-decisions|section-status|typeface|handoff)\.md$/i;

/** 多份产物合起来的摘要：质量状态取自全部；未决标记只数正文（稿件/大纲/清单），
 *  只有审查类文件时才数它们（检索步的 screening.md 本身就是正文）。 */
export function stepEvidenceSummaryOf(files: readonly { path: string; text: string }[]): StepEvidenceSummary {
  const all = stepEvidenceSummary(files.map((f) => f.text).join("\n"));
  const body = files.filter((f) => !META_REPORT.test(f.path));
  if (body.length === 0 || body.length === files.length) return all;
  const counted = stepEvidenceSummary(body.map((f) => f.text).join("\n"));
  return { status: all.status, unverified: counted.unverified, pending: counted.pending };
}
