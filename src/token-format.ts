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
