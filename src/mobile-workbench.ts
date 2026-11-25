/**
 * 手机工作台（PWA + 127.0.0.1 本地加密服务 + 可插拔 HTTPS 通道）的纯逻辑与类型定义。
 * 与 src-tauri/src/mobile_workbench.rs 的 DTO 保持一致，纯逻辑可直接由 node --test 单测。
 */

export type MobileTunnelMode = "cloudflare" | "tailscale" | "custom";

export interface MobileDeviceDto {
  id: string;
  name: string;
  pairedAt: string;
  lastSeenAt: string;
}

export interface CloudflareInfoDto {
  installed: boolean;
  binaryPath: string | null;
  running: boolean;
  tunnelUrl: string | null;
  hint: string;
}

export interface TailscaleInfoDto {
  installed: boolean;
  binaryPath: string | null;
  backendState: string;
  dnsName: string | null;
  tailscaleIps: string[];
  httpsReady: boolean;
  serveActive: boolean;
  serveUrl: string | null;
  mobilePeersTotal: number;
  mobilePeersOnline: number;
  hint: string;
}

export interface MobileWorkbenchStatusDto {
  enabled: boolean;
  running: boolean;
  port: number;
  localUrl: string | null;
  tunnelMode: MobileTunnelMode;
  tailscaleHttpsPort: number;
  customBaseUrl: string;
  publicUrl: string | null;
  devices: MobileDeviceDto[];
  pairingUrl: string | null;
  pairingQrSvg: string | null;
  pairingLeftSecs: number;
  cloudflare: CloudflareInfoDto;
  tailscale: TailscaleInfoDto;
  lastError: string | null;
}

export const DEFAULT_TAILSCALE_HTTPS_PORT = 8443;
export const MAX_MOBILE_DEVICES = 8;

/** 展示给用户确认的 Tailscale 命令预览（与后端 apply_tailscale_serve 参数一致） */
export function tailscaleServeCommand(httpsPort: number, localPort: number): string {
  const hp = httpsPort >= 443 ? Math.floor(httpsPort) : DEFAULT_TAILSCALE_HTTPS_PORT;
  const lp = localPort > 0 ? Math.floor(localPort) : 17590;
  return `tailscale serve --bg --https=${hp} 127.0.0.1:${lp}`;
}

/** 校验用户输入的 Tailscale HTTPS 端口（443 或 1024–65535） */
export function validateTailscalePort(raw: string): { port: number; error: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { port: DEFAULT_TAILSCALE_HTTPS_PORT, error: null };
  if (!/^\d+$/.test(trimmed)) {
    return { port: DEFAULT_TAILSCALE_HTTPS_PORT, error: "端口必须是数字（如 8443 或 443）" };
  }
  const n = Number(trimmed);
  if (n !== 443 && (n < 1024 || n > 65535)) {
    return { port: DEFAULT_TAILSCALE_HTTPS_PORT, error: "端口须为 443 或 1024–65535" };
  }
  return { port: n, error: null };
}

/** 校验自定义 HTTPS 隧道基址（与后端 normalize_custom_url 口径一致） */
export function validateCustomBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^https:\/\/[^/\s?#]+/i.test(trimmed)) {
    return "自定义通道必须是以 https:// 开头的加密地址（禁止明文 http://）";
  }
  if (trimmed.includes("?") || trimmed.includes("#")) {
    return "基址不能包含查询参数或锚点";
  }
  return null;
}

/** Cloudflare 通道状态的简短中文标签与色调 */
export function cloudflareStateLabel(cf: CloudflareInfoDto): { text: string; tone: "ok" | "warn" | "muted" } {
  if (cf.running && cf.tunnelUrl) return { text: "HTTPS 通道已开启", tone: "ok" };
  if (cf.installed) return { text: "已就绪，可一键开启", tone: "ok" };
  return { text: "首次开启将自动下载组件", tone: "muted" };
}

/** Tailscale 状态的简短中文标签与色调 */
export function tailscaleStateLabel(ts: TailscaleInfoDto): { text: string; tone: "ok" | "warn" | "muted" } {
  if (!ts.installed) return { text: "未检测到 Tailscale", tone: "muted" };
  if (ts.serveActive) return { text: "HTTPS 通道已开启", tone: "ok" };
  if (ts.backendState === "Running" && ts.httpsReady) return { text: "已就绪，可一键开启", tone: "ok" };
  if (ts.backendState === "Running" && !ts.httpsReady) return { text: "需在 Tailscale 后台开启 HTTPS 证书", tone: "warn" };
  if (ts.backendState === "NeedsLogin") return { text: "Tailscale 未登录", tone: "warn" };
  return { text: `Tailscale 未连接（${ts.backendState || "已停止"}）`, tone: "warn" };
}

/** Tailscale 已开启但账号下无在线手机节点时给出排查提醒 */
export function tailscaleMobilePeerWarning(ts: TailscaleInfoDto): string | null {
  if (!ts.installed || ts.backendState !== "Running" || !ts.serveActive) return null;
  if (ts.mobilePeersTotal === 0) {
    return "当前 Tailscale 账号下未检测到手机设备（若手机端提示试用结束或待管理员审批，可直接改用免装 App 的 Cloudflare 通道）。";
  }
  if (ts.mobilePeersOnline === 0) {
    return "当前未检测到在线手机节点，请确认手机 Tailscale 开关已连接；若与手机代理 App 冲突，可改用 Cloudflare 通道。";
  }
  return null;
}

/** 配对倒计时 MM:SS */
export function formatPairingCountdown(secs: number): string {
  const safe = Math.max(0, Math.floor(secs));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 顶行状态一句话摘要 */
export function mobileWorkbenchSummary(status: MobileWorkbenchStatusDto): string {
  if (!status.enabled) return "未开启";
  if (!status.running) return status.lastError ? `启动失败：${status.lastError}` : "正在启动本机服务…";
  if (status.publicUrl) return `已就绪 · ${status.publicUrl}`;
  return `仅本机回环运行（${status.localUrl ?? `127.0.0.1:${status.port}`}），尚未开启外网加密通道`;
}
