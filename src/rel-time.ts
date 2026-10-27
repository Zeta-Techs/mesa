/** 相对时间（白话主显）：「刚刚 / N 分钟前 / N 小时前 / N 天前」，超过 30 天回落日期；
 *  悬浮 title 用 absTime 给绝对时间（白话双层：相对为主、绝对降为悬浮） */
export function relTime(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(t).toLocaleDateString("zh-CN");
}

/** 绝对时间（悬浮二级呈现）：无法解析时返回空串 */
export function absTime(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleString("zh-CN", { hour12: false });
}

/**
 * 列表里统一的「什么时候」（2026-10-27 工作台精修：同一页曾混着「刚刚 / 12 天前 / 2026/9/10 / 更新于 …」）：
 * 7 天内写相对时间，更早写「9月10日」，跨年才带年份。nowMs 显式传，纯函数便于测试
 */
export function shortWhen(iso: string | null, nowMs: number = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const min = Math.floor((nowMs - t) / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} 天前`;
  const date = new Date(t);
  const md = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === new Date(nowMs).getFullYear() ? md : `${date.getFullYear()}年${md}`;
}
