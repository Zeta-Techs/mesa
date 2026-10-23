// 出图模型的排序、推荐与耗时估算（2026-10-24 用户：「筛选框太长了，常用的、最新的放在前面」「能做个大致的生成进度吗」）。
// 纯逻辑无 DOM，tests/image-models.test.ts 直接测。各家归类按模型名（与 model-kinds.ts 同为「宁粗勿错」的展示口径）。

export interface ImageModelItem {
  gatewayId: string;
  gatewayName: string;
  model: string;
}

export interface ImageFamily {
  key: string;
  label: string;
  items: ImageModelItem[];
}

/** 家族：展示顺序即常用度（大致按各家出图模型的使用面排），认不出的归「其他」放最后 */
const FAMILIES: { key: string; label: string; match: RegExp; seconds: number }[] = [
  { key: "gpt-image", label: "OpenAI GPT Image", match: /gpt-image|dall-?e/, seconds: 90 },
  { key: "gemini", label: "Google Gemini / Imagen", match: /gemini|imagen|banana/, seconds: 60 },
  { key: "seedream", label: "豆包 Seedream", match: /seedream|seededit|doubao/, seconds: 25 },
  { key: "grok", label: "xAI Grok Imagine", match: /grok|imagine/, seconds: 25 },
  { key: "qwen-image", label: "通义千问 Qwen-Image", match: /qwen/, seconds: 35 },
  { key: "wan", label: "通义万相", match: /^wan/, seconds: 30 },
  { key: "cogview", label: "智谱 CogView", match: /cogview/, seconds: 30 },
  { key: "flux", label: "FLUX", match: /flux/, seconds: 30 },
  { key: "hunyuan", label: "腾讯混元", match: /hunyuan/, seconds: 40 },
  { key: "midjourney", label: "Midjourney", match: /midjourney|^mj[-_]/, seconds: 60 },
];
const OTHER = { key: "other", label: "其他", seconds: 45 };

function baseName(model: string): string {
  return (model.split("/").pop() ?? model).toLowerCase();
}

export function familyOf(model: string): { key: string; label: string } {
  const b = baseName(model);
  const f = FAMILIES.find((x) => x.match.test(b));
  return f ? { key: f.key, label: f.label } : { key: OTHER.key, label: OTHER.label };
}

/** 日期快照后缀：-2026-03-03 / -250828 / -20250828 */
const SNAPSHOT = /-(\d{4}-\d{2}-\d{2}|\d{6,8})$/;

/** 版本号：去掉日期快照后取第一段数字（2.5、3.1、4-0→4.0）；没有版本号记 0 */
export function versionOf(model: string): number {
  const b = baseName(model).replace(SNAPSHOT, "");
  const m = /(\d+)(?:[.-](\d+))?/.exec(b);
  if (!m) return 0;
  return Number(`${m[1]}.${m[2] ?? "0"}`);
}

/** 档位：旗舰（pro/max/quality/ultra/hd）> 本体 > 认不出的后缀 > 轻量（flash/lite/mini/turbo/fast） */
function tierOf(model: string): number {
  const toks = baseName(model).replace(SNAPSHOT, "").split(/[^a-z0-9.]+/).filter(Boolean);
  const light = ["flash", "lite", "mini", "turbo", "fast", "nano"];
  const strong = ["pro", "max", "quality", "ultra", "hd"];
  if (toks.some((t) => strong.includes(t))) return 3;
  if (toks.some((t) => light.includes(t))) return 0;
  // 去掉家族词与版本号后还剩词 = 认不出的变体（gpt-image-2.5-flare）
  const rest = toks.filter(
    (t) => !/^\d/.test(t) && !/^(gpt|image|gemini|grok|imagine|qwen|wan\d.*|wanx.*|doubao|seedream|cogview|flux.*|t2i|v\d+|preview)$/.test(t),
  );
  return rest.length > 0 ? 1 : 2;
}

/** 同一家里「最新、最常用」在前：正式版先于快照/预览，版本高的先，同版本旗舰 > 本体 > 变体 > 轻量 */
export function compareImageModels(a: string, b: string): number {
  const snapA = SNAPSHOT.test(baseName(a)) ? 1 : 0;
  const snapB = SNAPSHOT.test(baseName(b)) ? 1 : 0;
  if (snapA !== snapB) return snapA - snapB;
  const preA = /preview/.test(baseName(a)) ? 1 : 0;
  const preB = /preview/.test(baseName(b)) ? 1 : 0;
  if (preA !== preB) return preA - preB;
  const v = versionOf(b) - versionOf(a);
  if (v !== 0) return v;
  const t = tierOf(b) - tierOf(a);
  if (t !== 0) return t;
  return a.localeCompare(b);
}

export const itemKey = (i: { gatewayId: string; model: string }) => `${i.gatewayId}\u0001${i.model}`;

/** 按家族分组（家族按常用度排，组内按 compareImageModels）；filter 为子串筛选 */
export function groupImageModels(items: readonly ImageModelItem[], filter = ""): ImageFamily[] {
  const kw = filter.trim().toLowerCase();
  const map = new Map<string, ImageFamily>();
  for (const it of items) {
    const fam = familyOf(it.model);
    if (kw && !`${it.model} ${it.gatewayName} ${fam.label}`.toLowerCase().includes(kw)) continue;
    const g = map.get(fam.key) ?? { key: fam.key, label: fam.label, items: [] };
    g.items.push(it);
    map.set(fam.key, g);
  }
  const order = [...FAMILIES.map((f) => f.key), OTHER.key];
  return [...map.values()]
    .map((g) => ({
      ...g,
      items: g.items.sort((a, b) => compareImageModels(a.model, b.model) || a.gatewayName.localeCompare(b.gatewayName)),
    }))
    .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}

/** 推荐：每家排第一的那个（同模型多网关只取一个），按家族常用度排 */
export function recommendedImageModels(items: readonly ImageModelItem[]): ImageModelItem[] {
  return groupImageModels(items)
    .filter((g) => g.key !== OTHER.key)
    .map((g) => g.items[0]);
}

// ===== 耗时估算（进度条用；接口不回进度，只能按以往耗时估） =====

export function defaultSecondsFor(model: string): number {
  const b = baseName(model);
  return (FAMILIES.find((x) => x.match.test(b)) ?? OTHER).seconds;
}

/** 估计秒数：这个模型以往几次的中位数；没有记录用家族默认值 */
export function estimateSeconds(model: string, history: readonly number[] | undefined): number {
  const h = (history ?? []).filter((ms) => ms > 0).sort((a, b) => a - b);
  if (h.length === 0) return defaultSecondsFor(model);
  return Math.max(3, Math.round(h[Math.floor(h.length / 2)] / 1000));
}

/** 进度 0–1：估计时间内线性走到 90%，超出后慢慢逼近 99%，不到返回结果不会满格 */
export function progressAt(elapsedSec: number, estimateSec: number): number {
  const est = Math.max(1, estimateSec);
  if (elapsedSec <= est) return 0.9 * (elapsedSec / est);
  return Math.min(0.99, 0.9 + 0.09 * (1 - Math.exp(-(elapsedSec - est) / est)));
}

/** 记一次耗时：每个模型留最近 5 次 */
export function recordDuration(
  store: Record<string, number[]>,
  model: string,
  ms: number,
): Record<string, number[]> {
  return { ...store, [model]: [...(store[model] ?? []), ms].slice(-5) };
}

/** 最近用过：新的在前、去重、最多 6 条 */
export function pushRecent(list: readonly string[], key: string): string[] {
  return [key, ...list.filter((k) => k !== key)].slice(0, 6);
}
