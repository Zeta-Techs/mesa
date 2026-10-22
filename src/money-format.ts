/**
 * 金额数字：千分位 + 两位小数（2026-10-23 审查：同页次数写「28,000」、金额却是「¥97135.69」，
 * 六位数要数位数才读得出）。只管数字本身，币种符号、≥ / ~ 前缀由调用方拼。
 */
export function groupedMoney(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
