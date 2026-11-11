/**
 * 核验清单纯逻辑（2026-11-02，docs/design-research-moat.md §3.1）：评审页读 `.ccode/checks/` 的核验项
 * （research_checks_read），按三档分组展示。三档口径：passed 只表示机器能确定的事实成立；
 * blocked 是机器确定有问题；needs_human 要人看。这里不做任何汇总打分、不把待你判断折进通过。
 */

export type CheckStatus = "passed" | "blocked" | "needs_human";

export interface CheckItem {
  id: string;
  kind: string;
  status: CheckStatus;
  title: string;
  target?: { file: string; line?: number };
  evidence?: { source?: string; quote?: string; page?: number; detail?: string };
  checker?: string;
  at?: string;
}

export interface ChecksDto {
  items: CheckItem[];
  files: string[];
  skipped: number;
}

export interface CheckCounts {
  passed: number;
  blocked: number;
  needsHuman: number;
}

export const CHECK_STATUS_LABEL: Record<CheckStatus, string> = {
  blocked: "拦下",
  needs_human: "待你判断",
  passed: "通过",
};

/** 分组顺序：先看拦下的，再看要人判断的，通过的放最后 */
export const CHECK_STATUS_ORDER: CheckStatus[] = ["blocked", "needs_human", "passed"];

export function countChecks(items: readonly CheckItem[]): CheckCounts {
  const counts: CheckCounts = { passed: 0, blocked: 0, needsHuman: 0 };
  for (const item of items) {
    if (item.status === "passed") counts.passed += 1;
    else if (item.status === "blocked") counts.blocked += 1;
    else counts.needsHuman += 1;
  }
  return counts;
}

/** 基础检查行里那颗按钮的字：总数 + 有才写的拦下 / 待你判断；全是通过时写「通过」 */
export function checkChipText(items: readonly CheckItem[]): string {
  const c = countChecks(items);
  const parts = [`核验 ${items.length} 项`];
  if (c.blocked) parts.push(`拦下 ${c.blocked}`);
  if (c.needsHuman) parts.push(`待你判断 ${c.needsHuman}`);
  if (!c.blocked && !c.needsHuman) parts.push("通过");
  return parts.join(" · ");
}

export function groupChecks(items: readonly CheckItem[]): { status: CheckStatus; items: CheckItem[] }[] {
  return CHECK_STATUS_ORDER.map((status) => ({
    status,
    items: items.filter((item) => item.status === status),
  })).filter((group) => group.items.length > 0);
}

export function checkLocation(item: CheckItem): string {
  if (!item.target?.file) return "";
  return item.target.line ? `${item.target.file}:${item.target.line}` : item.target.file;
}

/** 摘录后面跟的页码说明：p.N 来自 Agent 标注，实际在哪页写在 detail 里 */
export function checkQuoteLine(item: CheckItem): string {
  const quote = item.evidence?.quote?.trim();
  if (!quote) return "";
  return item.evidence?.page ? `「${quote}」（标注 p.${item.evidence.page}）` : `「${quote}」`;
}

export const CHECK_DISCLAIMER =
  "通过只表示机器能确定的事实成立（如键能解析、原文里有这段话、DOI 指向这篇）；这段话是否支持论断，仍要你判断。";

/**
 * 「请几家研讨这一条」（2026-11-11 研讨二期）：核验清单里待你判断的一条带进研讨——标题、落点、摘录、说明原样写进问题；
 * 落点文件取前后各 15 行作材料，来源若是项目里的文件也进材料（存不存在由调用方再筛）。研讨只给意见，判断仍由人定
 */
export function checkConsultSeed(item: CheckItem): { question: string; materials: { path: string; range: string }[] } {
  const lines = [`核验清单里这一条要我判断：${item.title}`];
  const where = checkLocation(item);
  if (where) lines.push(`位置：${where}`);
  const quote = checkQuoteLine(item);
  if (quote) lines.push(`原文摘录：${quote}`);
  if (item.evidence?.detail) lines.push(`说明：${item.evidence.detail}`);
  if (item.evidence?.source) lines.push(`来源：${item.evidence.source}`);
  lines.push("", "这一处的论断有没有被摘录或原文撑住？要不要改、怎么改？各自说理由；判断由我来定。");
  const materials: { path: string; range: string }[] = [];
  const file = item.target?.file?.trim();
  if (file) {
    const line = item.target?.line;
    materials.push({ path: file, range: line ? `${Math.max(1, line - 15)}-${line + 15}` : "" });
  }
  const src = item.evidence?.source?.trim();
  if (src && /\.[A-Za-z0-9]{1,8}$/.test(src) && !/^[a-z]+:\/\//i.test(src) && src !== file) materials.push({ path: src, range: "" });
  return { question: lines.join("\n"), materials };
}
