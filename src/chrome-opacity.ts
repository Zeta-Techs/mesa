/* 侧栏 / 顶栏罩色的挡位。
   必须与 src-tauri/src/settings.rs 的 KNOWN_CHROME_OPACITIES 一致：那边是入库存真值的
   白名单，不在表里的值会被静默落回默认，前端加选项而 Rust 没跟上就会「选了没反应」。

   **这个数是各主题自己罩色基数上的倍率，不是不透明度**：100 = 各主题本来的样子
   （深色侧栏 + 顶栏 + 四周缝同一层 48%；浅色壳与侧栏各 78%），0 = 完全不铺罩色、直接透出壁纸。
   两端在三套基数下含义一致；中间档同一个数在深浅主题里浓淡不同——hint 里要说清楚，
   否则用户会以为 50% 在哪都是一半。

   为什么是挡位而不是滑块：能看清侧栏文字的下限只能一档一档比出来，连续值没有
   可判断的落点。
   为什么允许到 0：亮壁纸想更实、暗壁纸/照片壁纸想更透，只允许单向会让另一半没法调。
   0 有对比度风险（文字直接压在壁纸上），由 hint 讲明，不做硬拦——这是外观设置，
   调坏了看得见，也能立刻调回来。 */
export const CHROME_OPACITIES = [0, 25, 50, 75, 85, 100] as const;
export type ChromeOpacity = (typeof CHROME_OPACITIES)[number];

/** 100 = 各主题原有罩色，也是缺省档：没动过设置时与改版前逐字节相同。 */
export const DEFAULT_CHROME_OPACITY: ChromeOpacity = 100;

export function normalizeChromeOpacity(value: unknown): ChromeOpacity {
  return CHROME_OPACITIES.includes(value as ChromeOpacity)
    ? (value as ChromeOpacity)
    : DEFAULT_CHROME_OPACITY;
}

/** 挡位 → CSS 变量倍率。CSS 侧存的是「基数 × 倍率」，把「哪一层多透」留给 App.css，
   JS 不持有 42/78/28 这些数——否则改一次主题基数要在两个地方对账。 */
export function chromeOpacityScale(value: unknown): number {
  return normalizeChromeOpacity(value) / 100;
}

/** 挡位标签。两端单独措辞，因为它们不是「某一档」而是两种观感：
   100 是主题本来的样子，0 是完全没有罩色、文字直接压在壁纸上。 */
export function chromeOpacityLabel(pct: ChromeOpacity): string {
  if (pct === 100) return "100%（主题原样）";
  if (pct === 0) return "0%（全透）";
  return `${pct}%`;
}

/** 分段按钮上的短标签（设置页一排六格，长标签挤不下）：两端用词、中间只写数，
   完整说法仍走 chromeOpacityLabel（悬停 title）。 */
export function chromeOpacityShortLabel(pct: ChromeOpacity): string {
  if (pct === 100) return "原样";
  if (pct === 0) return "全透";
  return String(pct);
}
