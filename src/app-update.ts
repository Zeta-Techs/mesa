/**
 * 应用自更新（Tauri updater）的展示纯逻辑：与 DOM/插件解耦，供 node --test 直接测。
 * 真正的 check()/downloadAndInstall() 仍在 store.ts，这里只处理文案、代理与收件箱合并。
 */

export const APP_UPDATE_CHECK_TIMEOUT_MS = 30_000;

export type AppUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "none"
  | "dev"
  | "error";

/** 有可用更新时的收件箱字段；key 带版本，忽略后换新版本会自动复现 */
export function appUpdateInboxFields(
  info: { version: string; currentVersion: string } | null,
): { key: string; text: string } | null {
  if (!info?.version) return null;
  return {
    key: `update:${info.version}`,
    text: `Mesa v${info.version} 可更新（当前 v${info.currentVersion}）`,
  };
}

/** 用当前检查结果替换旧的 update: 条目；无更新则摘掉 */
export function mergeAppUpdateInbox<T extends { key: string }>(
  items: readonly T[],
  extra: T | null,
): T[] {
  const rest = items.filter((it) => !it.key.startsWith("update:"));
  return extra ? [...rest, extra] : rest;
}

/** 出网代理给 updater 用：只传 http(s)，socks5 不传以免检查直接失败 */
export function updaterProxyUrl(
  outboundProxy: string | null | undefined,
): string | undefined {
  const t = outboundProxy?.trim() ?? "";
  if (t.startsWith("http://") || t.startsWith("https://")) return t;
  return undefined;
}

/** 检查失败不把插件/网络原文甩到界面 */
export function summarizeUpdateCheckError(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes("timeout") || s.includes("timed out") || s.includes("timedout"))
    return "检查超时，请检查网络后重试";
  if (s.includes("signature") || s.includes("minisign") || s.includes("checksum"))
    return "更新包签名校验失败";
  if (
    s.includes("latest.json") ||
    s.includes("release json") ||
    s.includes("valid release")
  )
    return "未读到有效的更新清单，请稍后重试";
  // 插件原文：the platform `darwin-x86_64` was not found in the response `platforms` object
  // / None of the fallback platforms … were found —— 自行构建的平台（如 Linux、ARM Windows）
  // 每次启动都会撞上，归成一句可行动的话而不是「失败」
  if (
    s.includes("was not found in the response") ||
    s.includes("fallback platforms") ||
    s.includes("targetnotfound")
  )
    return "这台电脑的平台没有对应的更新包（如自行构建的版本），不会收到应用内更新，请到发布页下载安装包";
  if (
    s.includes("network") ||
    s.includes("dns") ||
    s.includes("connection") ||
    s.includes("connect") ||
    s.includes("resolve") ||
    s.includes("error sending request")
  )
    return "无法连接更新源：请检查网络，或在设置 → 网络填出网代理后重试";
  return "检查更新失败，请稍后重试";
}

export function appUpdateStatusHint(status: AppUpdateStatus): string {
  switch (status) {
    case "checking":
    case "idle":
      return "正在检查更新…";
    case "dev":
      return "开发模式不检查应用更新（打包后的正式版才会检查）";
    case "none":
      return "已是最新版本";
    case "error":
      return "检查更新失败";
    case "available":
      return "发现新版本";
    default:
      return "尚未检查";
  }
}

export function appUpdateProgressLabel(
  downloaded: number,
  total: number | null,
): string {
  if (total && total > 0) {
    const pct = Math.min(100, Math.round((downloaded / total) * 100));
    return `已下载 ${pct}%`;
  }
  if (downloaded > 0) return `已下载 ${formatUpdateBytes(downloaded)}`;
  return "正在下载…";
}

export function appUpdateProgressPct(
  downloaded: number,
  total: number | null,
): number | null {
  if (!total || total <= 0) return null;
  return Math.min(100, Math.round((downloaded / total) * 100));
}

function formatUpdateBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}
