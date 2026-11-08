// 派活单「定时」一栏（「每周五 17:00」「每天早上 9 点」「每 4 小时」）→ 定时任务的周期。
// 认不出的不猜复杂规则：回落每周一 9:00 并标 guessed，卡片如实写「没认出，先按每周一 9:00 建，启用前去改」。

export interface OrderCadence {
  frequency: "daily" | "weekly" | "weekdays" | "hourly";
  weekday: number | null;
  intervalHours: number | null;
  hour: number;
  minute: number;
  /** 认不出、按默认建的 */
  guessed: boolean;
}

const WEEKDAY: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7 };
const CN_NUM: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
const INTERVALS = [1, 2, 3, 4, 6, 8, 12];

function num(raw: string | undefined): number | null {
  if (raw == null || raw === "") return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  return CN_NUM[raw] ?? null;
}

function parseTime(text: string): { hour: number; minute: number } | null {
  let hour: number | null = null;
  let minute = 0;
  const colon = text.match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
  if (colon) {
    hour = Number(colon[1]);
    minute = Number(colon[2]);
  } else {
    const dian = text.match(/(\d{1,2}|十[一二]?|[一二两三四五六七八九十])\s*点\s*(半|(\d{1,2})\s*分?)?/);
    if (dian) {
      hour = num(dian[1]);
      minute = dian[2] === "半" ? 30 : dian[3] ? Number(dian[3]) : 0;
    }
  }
  if (hour == null) return null;
  if (/下午|晚上|傍晚|夜里/.test(text) && hour < 12) hour += 12;
  if (/中午/.test(text) && hour < 11) hour += 12;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export function parseOrderCadence(text: string | null | undefined): OrderCadence {
  const t = (text ?? "").trim();
  const time = parseTime(t);
  const at = time ?? { hour: 9, minute: 0 };
  const hourly = t.match(/每\s*(\d{1,2}|[一二两三四六八]|十二)?\s*(个)?\s*小时/);
  if (hourly) {
    const n = num(hourly[1]) ?? 1;
    if (INTERVALS.includes(n)) {
      return { frequency: "hourly", weekday: null, intervalHours: n, hour: 0, minute: time?.minute ?? 0, guessed: false };
    }
  }
  if (/工作日|周一(到|至|-|—)周五/.test(t)) {
    return { frequency: "weekdays", weekday: null, intervalHours: null, ...at, guessed: false };
  }
  const week = t.match(/(?:每|逢)\s*(?:个)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/);
  if (week) {
    return { frequency: "weekly", weekday: WEEKDAY[week[1]], intervalHours: null, ...at, guessed: false };
  }
  if (/每天|每日|天天|每晚|每早|每天早上/.test(t)) {
    return { frequency: "daily", weekday: null, intervalHours: null, ...at, guessed: false };
  }
  return { frequency: "weekly", weekday: 1, intervalHours: null, hour: 9, minute: 0, guessed: true };
}

const WEEKDAY_LABEL = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export function cadenceLabel(c: OrderCadence): string {
  const hm = `${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`;
  switch (c.frequency) {
    case "hourly":
      return c.intervalHours === 1 ? "每小时" : `每 ${c.intervalHours} 小时`;
    case "daily":
      return `每天 ${hm}`;
    case "weekdays":
      return `工作日 ${hm}`;
    default:
      return `每${WEEKDAY_LABEL[c.weekday ?? 1]} ${hm}`;
  }
}
