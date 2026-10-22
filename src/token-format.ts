/**
 * 聊天层底部状态栏的 token 数（2026-10-22）：按中文读法写——一万以下带千分位（3,400），
 * 一万起写「万」（7.8 万），一亿起写「亿」。终端状态栏仍用 k / M（fmtTokens），与 CLI 自己的写法一致
 */
export function fmtTokensZh(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v >= 100_000_000) return `${trim(v / 100_000_000)} 亿`;
  if (v >= 10_000) return `${trim(v / 10_000)} 万`;
  return v.toLocaleString("en-US");
}

function trim(x: number): string {
  return x.toFixed(1).replace(/\.0$/, "");
}

export interface UsageParts {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  costUsd: number;
  priced: boolean;
}

/**
 * 这段对话一共处理了多少 token（2026-10-22 用户：「token 数是不是显示有误」）：新输入 + 读缓存 + 写缓存 + 输出。
 * 原先只加新输入和输出，Claude 这类带缓存的长对话每轮都把整段上下文从缓存读一遍，读缓存才是大头——
 * 一段两亿 token 的对话只显示五十多万，与旁边的费用（含缓存计价）对不上
 */
export function usageTotal(u: UsageParts): number {
  return u.input + u.output + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
}

/** 悬停拆分：读缓存（便宜，按输入价一折）/ 新输入 / 写缓存 / 输出，再写估算费用 */
export function usageTitle(u: UsageParts, fmt: (n: number) => string): string {
  const parts = [
    (u.cacheRead ?? 0) > 0 ? `读缓存 ${fmt(u.cacheRead ?? 0)}` : null,
    `新输入 ${fmt(u.input)}`,
    (u.cacheWrite ?? 0) > 0 ? `写缓存 ${fmt(u.cacheWrite ?? 0)}` : null,
    `输出 ${fmt(u.output)}`,
  ].filter(Boolean);
  const head = `这段对话累计 ${fmt(usageTotal(u))} token：${parts.join(" · ")}`;
  const note =
    (u.cacheRead ?? 0) > 0 ? "\n每一轮都会把之前的对话从缓存再读一遍，所以读缓存是大头；它按输入价的一折计费" : "";
  const cost = u.priced ? `\n按定价表估算 $${u.costUsd.toFixed(3)}` : "";
  return `${head}${note}${cost}\n约 1 分钟更新一次`;
}
