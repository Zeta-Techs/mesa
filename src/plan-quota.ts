// 订阅余量卡纯逻辑（用量页）：供应商显示名、卡片切换标签、窗口名、倒计时、进度分档、重置卡文案。
// 时间一律显式传 now（毫秒 epoch），禁墙钟断言（CI 纪律）。

export const PROVIDER_LABELS: Record<string, string> = {
  zhipu: "智谱",
  kimi: "Kimi",
  minimax: "MiniMax",
  claude: "Claude",
  codex: "Codex",
};

export function planProviderLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/** 套餐等级精简：剥掉 GLM / GLM Coding 前缀与 Plan 后缀（GLM Coding Max → Max；MaxPlan → Max）；
 *  全小写的等级首字母大写（智谱实测回 `level: "max"`，原样上屏是「max」——官方写 Max） */
export function planLevelLabel(level: string | null): string | null {
  if (!level) return null;
  const s = level
    .trim()
    .replace(/^glm\s+coding\s+/i, "")
    .replace(/^glm\s+/i, "")
    .replace(/\s*plan$/i, "")
    .trim();
  if (!s) return null;
  return /^[a-z]+$/.test(s) ? s[0].toUpperCase() + s.slice(1) : s;
}

const PROVIDER_NAME_KEYWORDS: Record<string, string[]> = {
  zhipu: ["glm", "zhipu", "bigmodel", "智谱"],
  kimi: ["kimi", "moonshot"],
  minimax: ["minimax"],
  claude: ["claude", "anthropic"],
  codex: ["codex", "chatgpt", "openai"],
};

/** 网关名是否还值得显示：只剩供应商同义词（可带数字编号，如 "GLM"、"glm 2"）时与供应商
 *  徽章重复，不再显示；有实际区分信息（"智谱备用"、"公司号"）才显示 */
export function planGatewayNameVisible(
  name: string | null | undefined,
  provider: string,
): boolean {
  if (!name) return false;
  const compact = name.toLowerCase().replace(/[\s\-_·]/g, "");
  if (!compact) return false;
  let rest = compact;
  for (const k of PROVIDER_NAME_KEYWORDS[provider] ?? []) {
    rest = rest.split(k).join("");
  }
  return rest.replace(/[0-9]+/g, "").length > 0;
}

/** 卡片切换标签：供应商名；同供应商多网关时追加网关名区分 */
export function planTabLabel(
  row: { provider: string; gatewayName: string },
  sameProviderCount: number,
): string {
  const label = planProviderLabel(row.provider);
  return sameProviderCount > 1 ? `${label} · ${row.gatewayName}` : label;
}

/** 收起态左右滑动切换（2026-10-31 用户：收起时不放标签，滑动切）：dir 1 = 下一家、-1 = 上一家；
 *  到头不回绕（滑到底再滑没反应，比绕回第一家更不容易迷路）。当前不在列表里按第一家算 */
export function planSwipeTarget(
  ids: readonly string[],
  current: string | null,
  dir: 1 | -1,
): string | null {
  if (ids.length === 0) return null;
  const at = Math.max(0, current == null ? 0 : ids.indexOf(current));
  return ids[Math.min(ids.length - 1, Math.max(0, at + dir))];
}

// ===== 收起态横向轻扫：按「一次手势」判定（2026-10-31 用户：时灵时不灵、反着滑有时不行） =====
// 触控板一次轻扫 = 手指那几十毫秒的事件 + 松手后一长串衰减的惯性事件。旧版用「触发后锁 250ms、事件不停就顺延」
// 挡惯性，又把小于阈值的位移一直攒着不清：惯性没停时反向轻扫被锁吞掉；上次没滑够的残量会带进下一次，
// 同向变得过灵、反向要多滑一倍。改成每次手势各算各的，一次手势最多切一家。

/** 一次手势累计横向位移到这个数（像素）才切 */
export const PLAN_SWIPE_THRESHOLD = 30;
/** 事件间隔超过它就算新手势（惯性事件约 16ms 一个，不会断这么久） */
const SWIPE_GAP_MS = 120;

export interface PlanWheelState {
  /** 本次手势方向（1 / -1），0 = 还没有手势 */
  dir: number;
  x: number;
  y: number;
  fired: boolean;
  lastT: number;
  /** 上一个事件的横向幅度：惯性只会越来越小，衰减过后突然变大 = 手指又扫了一次 */
  lastMag: number;
  /** 本次手势的峰值幅度：手指还在加速时幅度也在涨，没衰减到峰值一半以下不算「又扫了一次」 */
  peak: number;
}

export const PLAN_WHEEL_IDLE: PlanWheelState = { dir: 0, x: 0, y: 0, fired: false, lastT: -Infinity, lastMag: 0, peak: 0 };

/** 喂一个 wheel 事件（像素、毫秒），返回新状态与要不要切（1 下一家 / -1 上一家 / 0 不切）。纯函数，时间显式传入 */
export function planWheelStep(
  st: PlanWheelState,
  dx: number,
  dy: number,
  t: number,
): { state: PlanWheelState; step: 1 | -1 | 0 } {
  const mag = Math.abs(dx);
  const sign = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const fresh =
    st.dir === 0 ||
    t - st.lastT > SWIPE_GAP_MS ||
    // 反方向：手指往回扫了，不等惯性停（这是「反着滑不行」的根因）
    (sign !== 0 && sign !== st.dir) ||
    // 同方向、已切过、惯性已衰减过半后幅度明显回升：惯性里又扫了一次
    (st.fired && mag > 4 && st.lastMag < st.peak * 0.5 && mag > st.lastMag * 1.6);
  let next: PlanWheelState = fresh
    ? { dir: sign, x: 0, y: 0, fired: false, lastT: t, lastMag: mag, peak: mag }
    : { ...st, lastT: t, lastMag: mag, peak: Math.max(st.peak, mag) };
  next = { ...next, x: next.x + dx, y: next.y + Math.abs(dy) };
  if (next.fired || next.dir === 0) return { state: next, step: 0 };
  // 横向为主才算（斜着滚页面不误切），按整次手势的累计判，不按单个事件
  if (Math.abs(next.x) >= PLAN_SWIPE_THRESHOLD && Math.abs(next.x) > next.y) {
    return { state: { ...next, fired: true }, step: next.x > 0 ? 1 : -1 };
  }
  return { state: next, step: 0 };
}

export function planWindowLabel(window: string): string {
  if (window === "five_hour") return "5 小时";
  if (window === "weekly") return "本周";
  if (window === "monthly") return "本月";
  return window;
}

/** 具体时间点（官方口径）：今天 HH:mm:ss，跨天 MM-DD HH:mm:ss */
export function formatPlanTimestamp(ms: number, now: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? clock : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock}`;
}

/** 卡面日期：MM-DD，时刻放到悬停 */
export function formatPlanDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 重置时间点（官方风格）：「MM-DD HH:mm:ss 重置」；未知返回 null */
export function formatResetPoint(resetsAt: number | null, now: number): string | null {
  if (resetsAt == null) return null;
  return `${formatPlanTimestamp(resetsAt, now)} 重置`;
}

/** 重置倒计时（悬停提示用）：「X 小时 Y 分后重置」/「已到重置时间」；未知返回 null */
export function formatResetCountdown(resetsAt: number | null, now: number): string | null {
  if (resetsAt == null) return null;
  const remain = resetsAt - now;
  if (remain <= 0) return "已到重置时间";
  const mins = Math.ceil(remain / 60_000);
  if (mins < 60) return `${mins} 分后重置`;
  const hours = Math.floor(mins / 60);
  const restMins = mins % 60;
  if (hours < 48) return `${hours} 小时${restMins > 0 ? ` ${restMins} 分` : ""}后重置`;
  const days = Math.floor(hours / 24);
  return `${days} 天 ${hours % 24} 小时后重置`;
}

/** 主窗口脚注：「09-27 08:00 重置（还有 6 天 3 小时）」。
 *  倒计时上屏，不再只藏在悬停里——「还要等多久」是这张卡的第二个核心问题，
 *  每次都得悬停才看得见等于没给；已过时间点则不带括号（避免「…重置（已到重置时间）」） */
export function planResetFootnote(resetsAt: number | null, now: number): string | null {
  const point = formatResetPoint(resetsAt, now);
  if (!point) return null;
  if (resetsAt == null || resetsAt - now <= 0) return point;
  const remain = formatResetCountdown(resetsAt, now)?.replace(/后重置$/, "") ?? "";
  return remain ? `${point}（还有 ${remain}）` : point;
}

/** 卡面倒计时：「还有 28 小时 51 分」／「已到重置时间」。
 *  具体时刻（09-22 16:22:32）放悬停，不和时间戳叠成一句灰字 */
export function planResetRemain(resetsAt: number | null, now: number): string | null {
  if (resetsAt == null) return null;
  const cd = formatResetCountdown(resetsAt, now);
  if (!cd) return null;
  if (cd === "已到重置时间") return cd;
  return `还有 ${cd.replace(/后重置$/, "")}`;
}

/** 进度分档：<70 正常 / 70-90 警示 / ≥90 危急 */
export function quotaBarLevel(usedPercent: number): "ok" | "warn" | "danger" {
  if (usedPercent >= 90) return "danger";
  if (usedPercent >= 70) return "warn";
  return "ok";
}

/** 分档 → 颜色令牌（条与数字同一档，两张卡共用）：
 *  正常档**不着色**（一片彩色数字反而看不出哪个真要管），只有警示/危急才上语义色 */
export function quotaTone(usedPercent: number): { bar: string; text: string } {
  const level = quotaBarLevel(usedPercent);
  if (level === "danger") return { bar: "bg-err-text", text: "text-err-text" };
  if (level === "warn") return { bar: "bg-warn-text", text: "text-warn-text" };
  return { bar: "bg-cta", text: "text-l1" };
}

// ===== 订阅卡窗口顺序（最紧的排第一，双窗同构） =====

export interface PlanWindowLike {
  window: string;
  usedPercent: number;
}

/** 主窗口下标：已用百分比最高的那个（并列取靠前者；后端恒按 5 小时 → 周输出，
 *  所以并列时锚在 5 小时窗）。空数组返回 -1，调用方必须判。
 *  为什么要挑而不是固定 5 小时：真正卡住你的可能正是周窗
 *  （2026-09-21 实测本机 5 小时 0%、周 100%——固定锚 5 小时会顶着一个大绿 0% 而看不见爆掉的周额度） */
export function planPrimaryWindowIndex(windows: readonly PlanWindowLike[]): number {
  let best = -1;
  for (let i = 0; i < windows.length; i += 1) {
    // 严格大于：并列不换人，稳住版面
    if (best < 0 || windows[i].usedPercent > windows[best].usedPercent) best = i;
  }
  return best;
}

/** 最紧的窗口排第一，其余保持原序。双窗同构时，爆掉的那个仍先入眼 */
export function planWindowsByTightness<T extends PlanWindowLike>(
  windows: readonly T[],
): T[] {
  const pi = planPrimaryWindowIndex(windows);
  if (pi <= 0) return windows.slice();
  const out = windows.slice();
  const [head] = out.splice(pi, 1);
  return [head, ...out];
}

/** 重置卡要不要改成主按钮：只高亮最紧且已到危急档（≥90%）的那张，
 *  不禁用另一张（0% 仍可点，劝退在确认框） */
export function planResetCardHighlight(
  windows: readonly PlanWindowLike[],
  cardWindow: string,
): boolean {
  const pi = planPrimaryWindowIndex(windows);
  if (pi < 0) return false;
  const w = windows[pi];
  return w.window === cardWindow && quotaBarLevel(w.usedPercent) === "danger";
}

/** 大数字上方的说明：这个百分比属于哪个窗口（「5 小时已用」） */
export function planWindowCaption(window: string): string {
  return `${planWindowLabel(window)}已用`;
}

// ===== 绝对值（智谱积分、Kimi 配额点数；MiniMax 只有百分比） =====

/** 配额点数格式化：整数不带小数、小数留一位；手写千分位（不依赖 locale，CI 输出可断言） */
export function formatQuotaPoints(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 10) / 10;
  const [int, frac] = String(rounded).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${grouped}.${frac}` : grouped;
}

/** 百分比旁的绝对值「140,000 / 140,000」；已用超过总量时按总量封顶（智谱周窗会到 140,023） */
export function planAbsoluteQuotaPair(
  used: number | null | undefined,
  total: number | null | undefined,
): string | null {
  if (used == null || total == null) return null;
  const shown = total > 0 && used > total ? total : used;
  return `${formatQuotaPoints(shown)} / ${formatQuotaPoints(total)}`;
}

/** 绝对值行「已用 140,023 / 140,000」；只给百分比（或只给了总量）时返回 null——不摆半截数 */
export function planAbsoluteQuotaLine(
  used: number | null | undefined,
  total: number | null | undefined,
): string | null {
  const pair = planAbsoluteQuotaPair(used, total);
  return pair ? `已用 ${pair}` : null;
}

/** 该窗口当前一点没用到（智谱实测 5 小时 0%）——**只用于劝退上色，不用来禁用按钮**
 *  （2026-09-21 用户拍板：「看着劝退吧 不拦截」）。后端 `plan_use_reset_card` 不校验窗口用量：
 *  它查一遍卡列表就真发 `POST /api/biz/customer-package-reset/use` 扣掉最早过期的那张，
 *  消费后不可撤销——所以「0% 时用卡等于白扔」这件事只能靠卡面标黄 + 确认弹窗明说，
 *  门不能关：用户可能就是想清掉这个窗口。
 *  窗口数据缺失（供应商没回这个窗）返回 false：宁不标黄，不误报"没用过"。 */
export function planWindowUnused(
  windows: PlanWindowLike[],
  window: string,
): boolean {
  const w = windows.find((x) => x.window === window);
  return w != null && w.usedPercent <= 0;
}

/** 重置卡期限附注：卡面只写日期 `有效期至 10-18 · 剩 27 天`，时刻放到 title。
 *  剩几十天的卡精确到秒是噪音；已过期/3 天内 → urgent=true */
export function resetCardExpiryNote(
  expiresAt: number | null | undefined,
  now: number,
): { text: string; urgent: boolean; title: string } | null {
  if (expiresAt == null) return null;
  const ts = formatPlanTimestamp(expiresAt, now);
  const day = formatPlanDate(expiresAt);
  if (expiresAt <= now) {
    return { text: `${day} 已到期`, urgent: true, title: `${ts} 已到期` };
  }
  const days = Math.ceil((expiresAt - now) / 86_400_000);
  return {
    text: `有效期至 ${day} · 剩 ${days} 天`,
    urgent: days <= 3,
    title: `${ts} 前用 · 剩 ${days} 天`,
  };
}

/** 网关是否配了订阅套餐端点（与后端 detect_plan_provider 同口径；骨架占位判断用，
 *  避免没有套餐网关的用户看到闪一下就消失的骨架） */
export function gatewayHasPlanQuota(gateway: {
  slots?:
    | {
        anthropic?: string | null;
        openai?: string | null;
        responses?: string | null;
        gemini?: string | null;
        cursor?: string | null;
      }
    | null;
}): boolean {
  const urls = [
    gateway.slots?.anthropic ?? null,
    gateway.slots?.openai ?? null,
    gateway.slots?.responses ?? null,
    gateway.slots?.gemini ?? null,
    gateway.slots?.cursor ?? null,
  ];
  return urls.some((u): u is string => {
    if (!u) return false;
    const lower = u.toLowerCase();
    return (
      lower.includes("bigmodel.cn") ||
      lower.includes("api.z.ai") ||
      lower.includes("api.kimi.com") ||
      lower.includes("api.kimi.ai") ||
      lower.includes("minimaxi.com") ||
      lower.includes("minimax.cn") ||
      lower.includes("minimax.io")
    );
  });
}

/** 数据时间标注：缓存/回落值显示「数据截至 HH:mm」；新鲜数据返回 null */
export function planQuotaDataAt(queriedAt: number, fromCache: boolean): string | null {
  if (!fromCache) return null;
  const d = new Date(queriedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `数据截至 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
