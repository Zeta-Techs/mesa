/**
 * 内嵌终端用哪种渲染器：设置「终端渲染」+ 平台 + 这个标签跑的 agent。
 * 自动档的平台分流理由见 docs/conventions/terminal.md「渲染器按平台分流」。
 */

/** 自动档在 Mac 上也走 WebGL 的 agent。
 *  gemini 0.64 用半格方块 ▄ / ▀ 给消息框、输入框做上下留白：DOM 渲染器按字体画这两个字，
 *  行高 1.2 下盖不满一行，框上下各成一条细线加一道缝；WebGL 自绘方块字符，铺满整格
 *  （2026-10-20 同一 xterm 内核在无界面浏览器里对比实测）。代价是这类标签的文字略软。 */
const WEBGL_ON_MAC_AGENTS = new Set(["gemini"]);

/** 用户显式选的档位优先；只有「自动」看平台和 agent。 */
export function wantsWebglRenderer(opts: {
  setting: string | undefined;
  isMac: boolean;
  agentId: string | undefined;
}): boolean {
  if (opts.setting === "webgl") return true;
  if (opts.setting === "dom") return false;
  return !opts.isMac || WEBGL_ON_MAC_AGENTS.has(opts.agentId ?? "");
}

/** WebGL 渲染器的单元格宽 = floor(字宽 × 像素比) + round(letterSpacing)（addon-webgl 0.19，letterSpacing 按设备像素算）。
 *  一律向下取整：JetBrains Mono 13px 字宽 7.79，Retina 上 15.59 → 15（每格窄 3.8%），1 倍外接屏 7.79 → 7（窄 10%，字挤成一团）。
 *  小数部分 ≥ 0.5 时补 1 个设备像素，改成就近取整：Retina 16、1 倍屏 8（宽 2.6%）。
 *  DOM 渲染器按实际字宽排，不补（2026-10-21 WKWebView 实测，docs/conventions/terminal.md「渲染器按平台分流」） */
export function webglLetterSpacing(charWidthCss: number, devicePixelRatio: number): number {
  if (!(charWidthCss > 0) || !(devicePixelRatio > 0)) return 0;
  const device = charWidthCss * devicePixelRatio;
  return device - Math.floor(device) >= 0.5 ? 1 : 0;
}
