/** 验收账本文案：kind → 人话，禁止把 pipeline_merge 写成「已接受结论」。 */

export function acceptanceKindLabel(kind: string | undefined): string {
  switch (kind) {
    case "pipeline_merge":
      return "文件已进入项目";
    case "coding_merge":
      return "文件已进入项目";
    case "watch_adopt":
      return "巡检已采纳";
    case "goal_adopt":
    default:
      return "已接受";
  }
}

export function shortVersionId(versionId: string | undefined | null): string {
  const id = versionId?.trim() ?? "";
  if (!id) return "";
  const sha = id.includes(":") ? id.slice(id.lastIndexOf(":") + 1) : id;
  return sha.length > 8 ? sha.slice(0, 8) : sha;
}

export function acceptanceEntryHeadline(entry: {
  kind?: string;
  goalName: string;
  versionId?: string;
}): string {
  const kind = acceptanceKindLabel(entry.kind);
  const sha = shortVersionId(entry.versionId);
  const name = entry.goalName.trim() || "目标";
  return sha ? `${kind} · ${name} · ${sha}` : `${kind} · ${name}`;
}

/** 账本里按技能名记的条目（定时巡检写 goalName = 技能名），列表上换成人认得的名字 */
const LEDGER_NAME_LABEL: Record<string, string> = { "lit-watch": "文献雷达" };
/** 系统自动写的备注：与条目类型说的是同一件事，列表不再另起一行重复 */
const AUTO_NOTES = new Set(["定时巡检采纳"]);

/** 设置抽屉验收记录的一行（2026-10-17 用户截图：原先三行一条——「巡检已采纳 · lit-watch ·
 *  f04cb236」「定时巡检采纳」「1 天前」，技能名、版本号是内部词，备注与类型重复）。
 *  title = 「对象 · 发生了什么」；版本短号只进悬浮；系统备注不重复显示。 */
export function acceptanceEntryRow(entry: {
  kind?: string;
  goalName: string;
  versionId?: string;
  note?: string | null;
}): { title: string; version: string; note: string } {
  const raw = entry.goalName.trim();
  const name = LEDGER_NAME_LABEL[raw] ?? (raw || "目标");
  const note = entry.note?.trim() ?? "";
  return {
    title: `${name} · ${acceptanceKindLabel(entry.kind)}`,
    version: shortVersionId(entry.versionId),
    note: AUTO_NOTES.has(note) ? "" : note,
  };
}

/** Git 合并成功文案：进主仓 ≠ 科学验收。 */
export function mergeAdmissionText(input: {
  ledgerWritten?: boolean;
  versionId?: string | null;
}): string {
  if (input.ledgerWritten === false) return "文件已进入项目，验收记录未写下";
  const sha = shortVersionId(input.versionId);
  return sha ? `文件已进入项目 · ${sha}` : "文件已进入项目";
}

export function watchAdoptText(ledgerWritten: boolean): string {
  return ledgerWritten ? "巡检已采纳" : "巡检已采纳，验收记录未写下";
}

export function watchLedgerFailed(message: string): boolean {
  return (
    message.includes("验收记录落盘失败") || message.includes("文件已采纳，但")
  );
}

/** 打开评审记下的 tip 不被后续刷新覆盖。 */
export function freezeReviewedSha(
  frozen: string | null | undefined,
  incoming: string | null | undefined,
  explicitRefresh = false,
): string | null {
  const have = frozen?.trim() ?? "";
  if (have && !explicitRefresh) return have;
  const next = incoming?.trim() ?? "";
  return next || null;
}

/** 本次提交后只绑定该提交的完整 SHA，不能把随后出现的新提交当成已审版本。 */
export function reviewedShaAfterCommit(
  commitHash: string | null | undefined,
  currentHead: string | null | undefined,
): string {
  const hash = commitHash?.trim() ?? "";
  const head = currentHead?.trim() ?? "";
  if (!/^[a-f\d]{4,64}$/i.test(hash) || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(head) || !head.startsWith(hash)) {
    throw new Error("提交已完成，但当前版本与本次提交不一致，请刷新并重新检查改动后再合并");
  }
  return head;
}

/** 合并路径绑 tip；「再记录验收」不传 expect，走 is-ancestor 跳过。 */
export function gitAdmissionPayload(input: {
  retry: boolean;
  reviewedSha?: string | null;
}): { expectReviewedSha?: string } {
  if (input.retry) return {};
  const sha = input.reviewedSha?.trim();
  if (!sha) throw new Error("请先打开或刷新评审，再合并这版结果");
  return { expectReviewedSha: sha };
}

export function acceptanceEntryKey(entry: {
  kind?: string;
  runId: string;
  goalId: string;
  versionId?: string;
  decidedAt: string;
}): string {
  return `${entry.kind ?? ""}:${entry.runId}:${entry.goalId}:${entry.versionId ?? ""}:${entry.decidedAt}`;
}

/** Git 合并成功不表示被跳过的非 Git 文件也已接收。 */
export function deliveryFollowupText(report: { conflicts?: string[]; skippedProtected?: string[]; failed?: string[] } | null | undefined): string {
  if (!report) return "";
  const parts: string[] = [];
  if (report.conflicts?.length) parts.push(`同名文件未覆盖：${report.conflicts.join("、")}`);
  if (report.skippedProtected?.length) parts.push(`保护路径未接收：${report.skippedProtected.join("、")}`);
  if (report.failed?.length) parts.push(`仍需处理：${report.failed.join("；")}`);
  return parts.length ? `${parts.join("；")}。工作区中仍有未接收内容时不能归档。` : "";
}
