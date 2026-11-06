// 设置页「自定义定价」表格 ↔ pricing.json（后端 pricing.rs parse_entry 同一口径）。
// 只有输入 / 输出两价且按美元填的行写回老格式 [输入, 输出]，老文件原样往返；
// 填了缓存价或按人民币填的写对象 {input, output, cacheRead?, cacheWrite?, currency?}

export type PricingCurrency = "USD" | "CNY";

export interface PricingRow {
  prefix: string;
  currency: PricingCurrency;
  input: string;
  output: string;
  /** 空串 = 不填，按输入价 1 折算 */
  cacheRead: string;
  /** 空串 = 不填，按输入价算 */
  cacheWrite: string;
}

export function emptyPricingRow(prefix = ""): PricingRow {
  return { prefix, currency: "USD", input: "", output: "", cacheRead: "", cacheWrite: "" };
}

const text = (v: unknown) => (typeof v === "number" ? String(v) : "");

/** 解析 pricing.json；`_rate` 单独带出（汇率主入口在设置项，这里只为不丢数据）。解析失败抛错 */
export function parsePricingFile(raw: string): { rows: PricingRow[]; rate: number | null } {
  if (!raw.trim()) return { rows: [], rate: null };
  const v = JSON.parse(raw) as Record<string, unknown>;
  const rows: PricingRow[] = [];
  for (const [prefix, val] of Object.entries(v)) {
    if (prefix.startsWith("_")) continue;
    if (Array.isArray(val)) {
      rows.push({ ...emptyPricingRow(prefix), input: text(val[0]), output: text(val[1]) });
    } else if (val && typeof val === "object") {
      const o = val as Record<string, unknown>;
      rows.push({
        prefix,
        currency: o.currency === "CNY" ? "CNY" : "USD",
        input: text(o.input),
        output: text(o.output),
        cacheRead: text(o.cacheRead),
        cacheWrite: text(o.cacheWrite),
      });
    }
  }
  return { rows, rate: typeof v._rate === "number" ? v._rate : null };
}

/** 一行哪里填得不对（保存前就地标出来，不等后端报错）；null = 能存 */
export function pricingRowProblem(row: PricingRow): string | null {
  if (!row.prefix.trim()) return null; // 空前缀行保存时丢掉
  const bad = (s: string, required: boolean) => {
    const t = s.trim();
    if (!t) return required;
    const n = Number(t);
    return !Number.isFinite(n) || n < 0;
  };
  if (bad(row.input, true) || bad(row.output, true)) return "输入价和输出价要填非负数字";
  if (bad(row.cacheRead, false) || bad(row.cacheWrite, false)) return "缓存价要填非负数字，或留空";
  return null;
}

/** 表格序列化回 pricing.json；空前缀行丢弃，同前缀后写的为准 */
export function serializePricingRows(rows: PricingRow[], rate: number | null): string {
  const obj: Record<string, unknown> = {};
  if (rate != null) obj._rate = rate;
  for (const row of rows) {
    const prefix = row.prefix.trim();
    if (!prefix) continue;
    const input = Number(row.input) || 0;
    const output = Number(row.output) || 0;
    const cacheRead = row.cacheRead.trim() ? Number(row.cacheRead) : null;
    const cacheWrite = row.cacheWrite.trim() ? Number(row.cacheWrite) : null;
    if (row.currency === "USD" && cacheRead == null && cacheWrite == null) {
      obj[prefix] = [input, output];
      continue;
    }
    const entry: Record<string, unknown> = { input, output };
    if (cacheRead != null) entry.cacheRead = cacheRead;
    if (cacheWrite != null) entry.cacheWrite = cacheWrite;
    if (row.currency === "CNY") entry.currency = "CNY";
    obj[prefix] = entry;
  }
  return Object.keys(obj).length ? JSON.stringify(obj, null, 2) : "";
}

/** 价格显示：去掉多余的 0（3 → "3"，0.125 → "0.125"） */
export function priceLabel(n: number): string {
  return String(Number(n.toFixed(4)));
}
