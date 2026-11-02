/**
 * agent 识别色模块：品牌色（AGENT_BRAND）为唯一在用的色相表——对话页列表行胶囊与
 * 统计页进度条/圆点共用（单一出处；新增 Agent 在这里加一行）。
 * （v3.94 前另有一张随主题联动的令牌色表 AGENT_COLORS 供统计页进度条用，
 *  用户拍板进度条改绑品牌色后已删。）
 */

/**
 * 品牌色（固定 hex，不随主题变——同 file-icons.ts 的「固定识别色」先例）：
 * 对话列表的 Agent 胶囊（色字 + 10% 淡底）与统计页进度条/圆点共用，扫一眼即可分家。
 * 选色口径（v3.92 调）：低饱和中明度的「雾面色」（高饱和 500 档在浅色主题下发飘显廉价），
 * 尽量贴各家真实品牌色相（Claude 赤陶、Codex 紫、Kimi 青玉…），九家 hue 两两拉开；
 * 胶囊是「色字 + 10% 淡底」，深浅主题都要可读，禁走极端明暗。新 Agent 加一行，别撞色。
 */
export const AGENT_BRAND: Record<string, string> = {
  "claude-code": "#D97757", // 赤陶（Claude 官方色）
  kimi: "#0D9488", // 青玉
  codex: "#8B7EC8", // 雾紫
  gemini: "#527EC3", // 灰蓝
  qwen: "#7450C8", // 深紫罗兰
  opencode: "#7A8699", // 石板灰蓝
  codebuddy: "#C45959", // 砖红
  cursor: "#A87F2A", // 暗琥珀
  grok: "#C4506A", // 雾玫红
};

/** 未知 Agent 兜底：按 id 哈希取 HSL 色，确定性且不与上方令牌池撞色 */
export function fallbackAgentColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 45% 65%)`;
}

export const agentBrand = (id: string) =>
  AGENT_BRAND[id] ?? fallbackAgentColor(id);

/** agent 胶囊徽章的内联样式：品牌色文字 + 同色系 10% 底（无描边——描边+彩底+彩字三层叠加
    在浅色主题下显廉价，v3.92 收敛；深浅主题均可读） */
export function agentBrandBadgeStyle(id: string): {
  color: string;
  background: string;
} {
  const c = agentBrand(id);
  return {
    color: c,
    background: `color-mix(in srgb, ${c} 10%, transparent)`,
  };
}
