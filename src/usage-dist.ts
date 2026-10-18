/**
 * 用量页「分布」区的纯逻辑（tests/usage-dist.test.ts）：占比、截断、复制表格。
 *
 * 2026-10-17 用量页改版：六个分布页签（最贵 / Agent / 项目 / 网关 / 任务 / 模型）统一成同一种
 * 「名称 · 占比条 · tokens · 占比 · 费用」行；先露 DIST_PREVIEW 行、其余「显示全部」——
 * 不再静默截断（旧项目表 slice(0, 20) 没有任何提示）。
 */

/** 默认先露几行（设计系统长列表口径：先 10 条，底部「显示全部 / 收起」） */
export const DIST_PREVIEW = 10;

/** 占比：总量为 0 时一律 0，避免 NaN 画进进度条 */
export function shareOf(value: number, total: number): number {
  if (!(total > 0) || !(value > 0)) return 0;
  return Math.min(1, value / total);
}

/** 进度条宽度：有量的行至少露一小截（1.5%），否则小份额看起来像「没有」 */
export function barWidthPct(share: number): number {
  return share > 0 ? Math.max(1.5, share * 100) : 0;
}

/** 占比文字：< 0.1% 写「<0.1%」而不是骗人的「0.0%」 */
export function sharePctLabel(share: number): string {
  if (share <= 0) return "0%";
  if (share < 0.001) return "<0.1%";
  return `${(share * 100).toFixed(1)}%`;
}

/** 先露几行：行数不超过 preview+2 时直接全展开——只藏一两行不值得多一次点击 */
export function visibleDistRows<T>(
  rows: readonly T[],
  expanded: boolean,
  preview = DIST_PREVIEW,
): { shown: T[]; hidden: number } {
  if (expanded || rows.length <= preview + 2) return { shown: [...rows], hidden: 0 };
  return { shown: rows.slice(0, preview), hidden: rows.length - preview };
}

/** 复制表格：制表符分隔、首行表头，粘进 Excel / Numbers / 飞书表格即成列。
 *  单元格里的制表符与换行压成空格，否则会把一格拆成多格 / 多行。 */
export function toTsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const clean = (cell: string) => cell.replace(/[\t\r\n]+/g, " ").trim();
  return [header, ...rows].map((r) => r.map(clean).join("\t")).join("\n");
}
