/**
 * 获取模型的下拉面板按厂商分组折叠的纯逻辑（大网关 400+ 模型平铺没法选）。
 *
 * 纯逻辑、无 DOM，node --test 直接测（tests/model-vendors.test.ts）。
 */

export interface VendorGroup {
  vendor: string;
  models: string[];
}

/**
 * 常见模型名前缀 → 厂商分组（2026-11-07：按「字母+数字」前缀分组时 qwen / qwen3、o3 / o4、wan2 / wanx2 各成一组，
 * 大网关的分类胶囊挤成两三行）。只收前缀确定属于这家的；没收的照旧取前缀字母段。
 */
const VENDOR_FAMILIES: [RegExp, string][] = [
  [/^(gpt|chatgpt|o\d|text-embedding|text-moderation|dall-e|davinci|babbage|whisper|tts|codex|omni-moderation|sora)/i, "openai"],
  [/^claude/i, "claude"],
  [/^(gemini|gemma|imagen|veo|learnlm)/i, "gemini"],
  [/^(qwen|qwq|qvq|wan[x\d.-]|wanx|tongyi)/i, "qwen"],
  [/^deepseek/i, "deepseek"],
  [/^(glm|chatglm|cogview|cogvideo|codegeex)/i, "glm"],
  [/^(kimi|moonshot)/i, "kimi"],
  [/^(minimax|abab|hailuo)/i, "minimax"],
  [/^grok/i, "grok"],
  [/^(doubao|seedream|seedance|seed-)/i, "doubao"],
  [/^(mistral|mixtral|codestral|magistral|devstral|ministral|pixtral)/i, "mistral"],
  [/^llama/i, "llama"],
  [/^(ernie|wenxin)/i, "ernie"],
  [/^hunyuan/i, "hunyuan"],
];

/**
 * 从模型 id 推断厂商名（仅用于展示分组，宁粗勿错）：
 * openrouter 风格 "vendor/model" 取斜杠前段；否则先查常见前缀表（gpt-5.6-sol、o3-pro → openai，Qwen3-32B → qwen），
 * 表外取开头字母段（去掉版本数字）；完全不匹配归「其他」。
 */
export function vendorOf(model: string): string {
  const m = model.trim();
  if (!m) return "其他";
  const slash = m.indexOf("/");
  if (slash > 0) return m.slice(0, slash).toLowerCase();
  for (const [re, vendor] of VENDOR_FAMILIES) if (re.test(m)) return vendor;
  const match = /^[a-zA-Z]+/.exec(m);
  return match ? match[0].toLowerCase() : "其他";
}

/** 分组 + 可选筛选（子串、大小写不敏感）；组内按名称排序，组按厂商名排序，「其他」恒末 */
export function groupModelsByVendor(
  models: readonly string[],
  filter = "",
): VendorGroup[] {
  const kw = filter.trim().toLowerCase();
  const map = new Map<string, string[]>();
  for (const m of models) {
    if (kw && !m.toLowerCase().includes(kw)) continue;
    const v = vendorOf(m);
    const arr = map.get(v);
    if (arr) arr.push(m);
    else map.set(v, [m]);
  }
  return [...map.entries()]
    .map(([vendor, ms]) => ({
      vendor,
      models: ms.sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) =>
      a.vendor === "其他"
        ? 1
        : b.vendor === "其他"
          ? -1
          : a.vendor.localeCompare(b.vendor),
    );
}

/** 分类筛选：`all` 保留全部分组；指定厂商只留该组。筛选词仍走 groupModelsByVendor。 */
export function visibleVendorGroups(
  models: readonly string[],
  vendor = "all",
  filter = "",
): VendorGroup[] {
  const groups = groupModelsByVendor(models, filter);
  if (!vendor || vendor === "all") return groups;
  return groups.filter((g) => g.vendor === vendor);
}
