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
