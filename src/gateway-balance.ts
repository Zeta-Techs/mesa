// 网关余额卡纯逻辑（用量页）：主机命中、币种金额、已用百分比、同站账户合并。
// 与后端 gateway_balance.rs WALLET_HOSTS / 解析口径双端镜像。

import { endpointHost } from "./gateway-option.ts";
import { groupedMoney } from "./money-format.ts";

/** 槽 URL 主机命中才出卡。加站点 = 加一条（与 Rust WALLET_HOSTS 同步）。 */
export const WALLET_HOSTS = ["zetatechs.com"] as const;

export function walletHostMatches(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/\.+$/, "");
  if (!h) return false;
  return WALLET_HOSTS.some((suffix) => h === suffix || h.endsWith(`.${suffix}`));
}

export function gatewayHasWallet(gateway: {
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
  return urls.some((u) => {
    if (!u) return false;
    return walletHostMatches(endpointHost(u));
  });
}

export function walletKindLabel(kind: string): string {
  if (kind === "newapi") return "New API";
  return kind;
}

/**
 * 大数字上方的说明：钱包来源写「当前可用余额」，密钥来源写「密钥额度」
 */
export function walletAmountCaption(source: string): string {
  return source === "wallet" ? "当前可用余额" : source === "token" ? "密钥额度" : "余额";
}

/**
 * 消耗进度条分档（大数字是余额，不能拿消耗比例给余额上色）。
 * 条走主题强调色的过渡：正常 CTA、预警 warn、危急 err，都压到约 70–85% 不透明，
 * 避免暗底上一条高亮浅白压过左侧大字。
 */
export function walletSpendTone(usedPct: number): { bar: string; text: string } {
  if (usedPct >= 90) return { bar: "bg-err-text/85", text: "text-err-text" };
  if (usedPct >= 80) return { bar: "bg-warn-text/80", text: "text-warn-text" };
  return { bar: "bg-cta/70", text: "text-l1" };
}

/**
 * 账户余额条的几何：画**剩余**比例，方向与大数字（余额）一致——满条 = 钱还多、
 * 条短 = 快见底（油量表口径：满 = 安心）。
 *
 * 2026-09-30 改向：原先条画已消耗，于是同一行里大数字说「剩 ¥2112」、条却填到 89%，
 * 两个信号互相拆台（条越满 = 钱越少）。余额卡的主语是余额，条必须跟着主语走。
 *
 * **告警档仍按已消耗判**（`walletSpendTone`）：条短且红 = 剩得少且在报警，
 * 而不是条本身在说消耗。调用方不再拿 `text` 给「已消耗」上色（那是事实不是告警，
 * 上色会和条的档位说两遍）——颜色只留在条上。
 *
 * 返回 null = 无总量可算（不限额度 / 缺数据），此时不画条。
 */
export function walletBalanceBar(
  used: number | null | undefined,
  total: number | null | undefined,
): { remainPct: number; bar: string } | null {
  const usedPct = walletUsedPercent(used, total);
  if (usedPct == null) return null;
  return { remainPct: 100 - usedPct, bar: walletSpendTone(usedPct).bar };
}

/** 密钥行金额：限额 `¥3.05 / ¥203.05`，不限只写已用 `¥4622.53`，不混「已用」前缀 */
export function walletKeyAmountLine(
  unlimited: boolean,
  used: number | null | undefined,
  total: number | null | undefined,
  currency: string,
  hide = false,
): string {
  if (unlimited) {
    if (used == null || !Number.isFinite(used)) return "";
    return hide ? formatBalanceAmountMasked(currency) : formatBalanceAmount(used, currency);
  }
  if (used == null || total == null) return "";
  return hide
    ? `${formatBalanceAmountMasked(currency)} / ${formatBalanceAmountMasked(currency)}`
    : `${formatBalanceAmount(used, currency)} / ${formatBalanceAmount(total, currency)}`;
}

/** 站点币种金额：CNY → ¥、USD → $、TOKENS → 整数 + tokens；不走用量页汇率。 */
export function formatBalanceAmount(value: number, currency: string): string {
  if (!Number.isFinite(value)) return "—";
  if (currency === "TOKENS") return `${Math.round(value).toLocaleString("en-US")} tokens`;
  const symbol = currency === "CNY" ? "¥" : "$";
  return value < 0 ? `-${symbol}${groupedMoney(-value)}` : `${symbol}${groupedMoney(value)}`;
}

/** 隐藏额度时的占位，保留币种符号。 */
export function formatBalanceAmountMasked(currency: string): string {
  if (currency === "TOKENS") return "•••";
  return `${currency === "CNY" ? "¥" : "$"}•••`;
}

/**
 * 大数字排版：币种符号 / 单位小一号，数字保持大号。
 * 整串 `¥4842.83` 都按 2xl 渲染会头重脚轻，`1235 tokens` 更是长得离谱。
 * 负数把负号留在符号上（`-¥1.45`，不是 `¥-1.45`）。
 */
export function splitBalanceAmount(
  value: number,
  currency: string,
): { prefix: string; number: string; unit: string } {
  if (!Number.isFinite(value)) return { prefix: "", number: "—", unit: "" };
  if (currency === "TOKENS") {
    return { prefix: "", number: Math.round(value).toLocaleString("en-US"), unit: "tokens" };
  }
  const symbol = currency === "CNY" ? "¥" : "$";
  const fixed = value < 0 ? `-${groupedMoney(-value)}` : groupedMoney(value);
  return fixed.startsWith("-")
    ? { prefix: `-${symbol}`, number: fixed.slice(1), unit: "" }
    : { prefix: symbol, number: fixed, unit: "" };
}

export function walletUsedPercent(
  used: number | null | undefined,
  total: number | null | undefined,
): number | null {
  if (used == null || total == null || !(total > 0) || !Number.isFinite(used)) {
    return null;
  }
  return Math.min(100, Math.max(0, (used / total) * 100));
}

/**
 * 不限额度没有总量，开口条不能画成「用了百分之几」。
 * 长度只比这张卡上各密钥已经花掉的多少：花得最多的停在 95（末端留白，额度还开着），
 * 其余按 log1p 相对它缩短——¥4622 和 ¥10 用线性比，短的那条会缩成看不见。
 * 已用 ≤ 0 或没有可比数字时返回 null，不画一条假的空槽。
 */
export const WALLET_UNLIMITED_BAR_CAP = 95;

export function walletUnlimitedFill(
  used: number | null | undefined,
  peers: readonly (number | null | undefined)[],
): number | null {
  if (used == null || !Number.isFinite(used) || used <= 0) return null;
  let peak = used;
  for (const n of peers) {
    if (n != null && Number.isFinite(n) && n > peak) peak = n;
  }
  if (!(peak > 0)) return null;
  const ratio = Math.log1p(used) / Math.log1p(peak);
  return Math.min(WALLET_UNLIMITED_BAR_CAP, Math.max(0, ratio * WALLET_UNLIMITED_BAR_CAP));
}

/**
 * 不限额度那一行的副文。只写「不限」是信息死胡同——不限的密钥其实也记了已用，
 * 而这恰恰是「这个月这把密钥烧了多少」的唯一线索。
 */
export function walletUnlimitedLine(
  used: number | null | undefined,
  currency: string,
  hide = false,
): string {
  if (used == null || !Number.isFinite(used)) return "不限";
  return `不限 · 已用 ${hide ? formatBalanceAmountMasked(currency) : formatBalanceAmount(used, currency)}`;
}

// ===== 同站账户合并（2026-09-21） =====
//
// 一个站配多个网关是常态（测试一个、正式一个），而**钱包是账户级的**：只要共用同一个
// 系统访问令牌，几个网关查到的是同一个余额。逐个渲染成一排标签页会出现「三个标签页
// 数字一模一样」，看着像坏了。所以按「站点 + 账户」合成一张卡，钱包数字只出现一次；
// 各家推理密钥的额度作为明细行留在下面（那才是真正不同的部分）。
//
// 分组键必须带 account，不能只按 origin：同一个站开两个账户是合法的，那种情况必须
// 分开成两张卡（否则会把两个账户的余额混成一张）。

/** 分组只看这几个字段；其余 DTO 字段不参与 */
export interface WalletGroupRow {
  gatewayId: string;
  gatewayName: string;
  origin: string;
  /** /api/user/self 的账户名；查不到钱包时为 null */
  account?: string | null;
  ok: boolean;
  source: string;
}

export interface WalletAccountGroup<T extends WalletGroupRow> {
  /** origin 规范化后的分组键 */
  key: string;
  origin: string;
  account: string | null;
  /** 代表行：优先「钱包成功」，其次任一成功，最后第一行（好让它的 error 说话） */
  head: T;
  /** 同账户的全部网关，保持后端给的顺序 */
  members: T[];
}

/** 明细行需要的额度字段（结构化，便于单测） */
export interface WalletMemberRow extends WalletGroupRow {
  unlimited: boolean;
  remaining?: number | null;
  used?: number | null;
  total?: number | null;
  tokenUnlimited: boolean;
  tokenRemaining?: number | null;
  tokenUsed?: number | null;
  tokenTotal?: number | null;
}

export interface WalletQuotaView {
  unlimited: boolean;
  used: number | null;
  total: number | null;
  pct: number | null;
}

/**
 * 一条「密钥额度」明细该画成什么。三条分支合一，替掉原先散在 JSX 里的三段条件：
 * 1. 有 /api/usage/token 数据 → 用它；
 * 2. 没有、但这个网关的**主导数字不是钱包**（说明额度是从 billing 兜底提升上来的）→ 用提升值；
 * 3. 其余 → 返回 null（真的没数据）。
 * 第 2 条必须带 `source !== "wallet"`：钱包来源的行里 remaining/used/total 是**账户余额**，
 * 拿它当密钥额度会画出「钱包余额 / 钱包总额」冒充密钥用量。
 */
export function walletTokenQuota(row: WalletMemberRow): WalletQuotaView | null {
  if (
    row.tokenUnlimited ||
    row.tokenRemaining != null ||
    (row.tokenUsed != null && row.tokenTotal != null)
  ) {
    return {
      unlimited: row.tokenUnlimited,
      used: row.tokenUsed ?? null,
      total: row.tokenTotal ?? null,
      pct: walletUsedPercent(row.tokenUsed, row.tokenTotal),
    };
  }
  if (row.source !== "wallet" && (row.remaining != null || row.total != null)) {
    return {
      unlimited: row.unlimited,
      used: row.used ?? null,
      total: row.total ?? null,
      pct: walletUsedPercent(row.used, row.total),
    };
  }
  return null;
}

/** 到期提醒门槛：只有临近（含已过期）才在卡面露出来，远期到期是噪音，挂悬停就够 */
export const WALLET_EXPIRY_SOON_DAYS = 14;

export function walletExpirySoon(
  expiresAt: number | null | undefined,
  now: number,
  days = WALLET_EXPIRY_SOON_DAYS,
): boolean {
  // 站点用 0 表示「无到期」，不能当成 1970 年喊到期
  if (expiresAt == null || !Number.isFinite(expiresAt) || expiresAt <= 0) return false;
  return expiresAt - now <= days * 24 * 60 * 60 * 1000;
}

/** origin 规范化：去尾斜杠 + 主机小写（同址不同写法要合到一起） */
export function walletOriginKey(origin: string): string {
  return origin.trim().replace(/\/+$/, "").toLowerCase();
}

/** 代表行：钱包成功 > 任一成功 > 第一行 */
export function pickAccountHead<T extends WalletGroupRow>(
  members: readonly T[],
): T {
  return (
    members.find((m) => m.ok && m.source === "wallet") ??
    members.find((m) => m.ok) ??
    members[0]
  );
}

export function groupWalletAccounts<T extends WalletGroupRow>(
  rows: readonly T[],
): WalletAccountGroup<T>[] {
  const byOrigin = new Map<string, T[]>();
  for (const row of rows) {
    const key = walletOriginKey(row.origin);
    const list = byOrigin.get(key);
    if (list) list.push(row);
    else byOrigin.set(key, [row]);
  }
  const groups: WalletAccountGroup<T>[] = [];
  const push = (key: string, account: string | null, members: T[]) => {
    if (!members.length) return;
    groups.push({
      key,
      origin: members[0].origin,
      account,
      head: pickAccountHead(members),
      members,
    });
  };
  for (const [key, members] of byOrigin) {
    const accounts: string[] = [];
    for (const m of members) {
      const name = m.account?.trim();
      if (name && !accounts.includes(name)) accounts.push(name);
    }
    if (accounts.length <= 1) {
      push(key, accounts[0] ?? null, members);
      continue;
    }
    // 同站多账户：按账户拆；认不出账户的行并进第一组，不丢行
    const primary = accounts[0];
    const buckets = new Map<string, T[]>(accounts.map((a) => [a, []]));
    for (const m of members) {
      const name = m.account?.trim();
      const bucket = name && buckets.has(name) ? buckets.get(name) : buckets.get(primary);
      bucket?.push(m);
    }
    for (const [account, bucket] of buckets) push(key, account, bucket ?? []);
  }
  return groups;
}

/**
 * 账户标题：单网关且不并排时用用户自己起的网关名（那才是他认得的叫法）；
 * 多网关合并、或同页并排多张卡时改标「站点 · 账户」——否则两张同站不同账户的卡
 * 会各显示成某个网关名，看着像重复。
 */
export function walletAccountTitle(
  group: {
    origin: string;
    account: string | null;
    members: { gatewayName: string }[];
  },
  disambiguate = false,
): string {
  if (group.members.length === 1 && !disambiguate) return group.members[0].gatewayName;
  const host = endpointHost(group.origin) || group.origin;
  return group.account ? `${host} · ${group.account}` : host;
}

export function walletUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/wallet`;
}

/** 不限额度且没有钱包数字时的说明。一句话说完，入口在卡头（去钱包 / 去连接页）。 */
export function walletMissingHint(hasWalletToken: boolean): string {
  return hasWalletToken
    ? "令牌查不到钱包，去连接页核对"
    : "账户钱包要系统访问令牌，去连接页填";
}
