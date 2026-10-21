/**
 * 内嵌终端用哪种渲染器：设置「终端渲染」。理由与实测见 docs/conventions/terminal.md「终端渲染器」。
 */

/** 自动档两个平台都走 WebGL（2026-10-22 用户拍板；此前 Mac 默认 DOM、只有 Gemini 例外）：
 *  WKWebView 逐像素复测锐度与 DOM 持平，出字与滚动更顺，框线与半格方块铺满整格——DOM 在行高 1.2 下
 *  框线断成虚线、方块留缝。只有显式选「兼容（DOM）」才不走；旧设置里的 "webgl" 与自动同义。
 *  软件渲染与上下文丢失时由 TerminalPage 退回 DOM，不在这里判。 */
export function wantsWebglRenderer(setting: string | undefined): boolean {
  return setting !== "dom";
}

/** WebGL 渲染器的单元格宽 = floor(字宽 × 像素比) + round(letterSpacing)（addon-webgl 0.19，letterSpacing 按设备像素算）。
 *  一律向下取整：JetBrains Mono 13px 字宽 7.79，Retina 上 15.59 → 15（每格窄 3.8%），1 倍外接屏 7.79 → 7（窄 10%，字挤成一团）。
 *  小数部分 ≥ 0.5 时补 1 个设备像素，改成就近取整：Retina 16、1 倍屏 8（宽 2.6%）。
 *  DOM 渲染器按实际字宽排，不补（2026-10-21 WKWebView 实测，docs/conventions/terminal.md「终端渲染器」） */
export function webglLetterSpacing(charWidthCss: number, devicePixelRatio: number): number {
  if (!(charWidthCss > 0) || !(devicePixelRatio > 0)) return 0;
  const device = charWidthCss * devicePixelRatio;
  return device - Math.floor(device) >= 0.5 ? 1 : 0;
}
