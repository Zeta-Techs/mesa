/** 图片预览的纯计算（tests/image-view.test.ts） */

/** 「适应窗口」倍率：整张图放进框里（留 pad 边距），小图不放大 */
export function imageFitScale(
  natural: { w: number; h: number },
  box: { w: number; h: number },
  pad = 0,
): number {
  if (natural.w <= 0 || natural.h <= 0 || box.w <= pad || box.h <= pad) return 1;
  return Math.min(1, (box.w - pad) / natural.w, (box.h - pad) / natural.h);
}

/** 1536 → 「1.5 KB」，中文界面统一的字节写法 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
