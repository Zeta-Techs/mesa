/** 机构访问（高校/研究所）通道前端纯逻辑：状态镜像、获取按钮可见性、渠道文案。
 *  后端见 src-tauri/src/inst_access.rs（会话 Cookie 0600 不出站，这里只拿到统计态）。
 *  设置页信息架构（2026-09-17）：「学校图书馆」只留登录一条主路径；前缀与内嵌/桥按需折叠。 */

/** 机构登录的默认入口：CARSI 高校联盟（国内绝大多数高校接入）。
 *  设置页主路径不摆地址框，空登录页即走这里。 */
export const DEFAULT_INST_LOGIN_URL = "https://www.carsi.edu.cn/";

function normalizeLoginUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

/** 填了且不是默认 CARSI → 算自定义入口（「其他方式」默认展开）。空 = 走默认。 */
export function isCustomInstLoginUrl(url: string): boolean {
  const a = normalizeLoginUrl(url);
  return Boolean(a) && a !== normalizeLoginUrl(DEFAULT_INST_LOGIN_URL);
}

/** 「校外打不开全文时」默认展开：已填前缀或前缀不合法，进来就能看见。 */
export function instPrefixPanelDefaultOpen(
  prefix: string,
  prefixInvalid?: boolean,
): boolean {
  return Boolean(prefix.trim()) || Boolean(prefixInvalid);
}

/** 「其他方式」默认展开：自定义登录入口或已有内嵌窗会话。 */
export function instOtherPanelDefaultOpen(
  loginUrl: string,
  sessionPresent: boolean,
): boolean {
  return isCustomInstLoginUrl(loginUrl) || sessionPresent;
}

/** inst_session_status 的返回（无任何秘密值） */
export interface InstSessionStatus {
  prefixConfigured: boolean;
  /** 前缀填了但不是合法 http(s) URL——通道不会用它，就地提示补 scheme */
  prefixInvalid?: boolean;
  prefixHost: string;
  loginUrlSaved: boolean;
  sessionPresent: boolean;
  /** 会话可信：至少一条 Cookie 命中前缀主机或出版商域（入口页一打开的
   *  pre-auth Cookie 不算——真取时只会报会话过期，按钮不该亮） */
  sessionCredible?: boolean;
  /** 保存会话时的登录起始主机（展示用，非秘密） */
  capturedFrom?: string;
  updatedAt: string | null;
  cookieCount: number;
  domains: string[];
}

/** 通道可用：配了有效前缀（含校园 IP 经代理）或已有**可信**登录会话（校园 IP
 *  直连）——会话存在但只有入口页 Cookie 时不算可用（2026-09-17 审计） */
export function instActiveFrom(status: InstSessionStatus | null): boolean {
  if (!status) return false;
  return status.prefixConfigured || (status.sessionPresent && status.sessionCredible !== false);
}

/** 「登录学校账号」打开的地址：登录入口 > 前缀 > 默认 CARSI（设置页与付费墙行同一口径） */
export function instLoginOpenUrl(loginUrl?: string | null, prefix?: string | null): string {
  return (loginUrl ?? "").trim() || (prefix ?? "").trim() || DEFAULT_INST_LOGIN_URL;
}

/** 浏览器登录标记（2026-10-22）：默认通道在系统浏览器里登录，Mesa 读不到那边的会话，
 *  只能记下人点「登录好了」的时间。只管界面显示「已登录」——不算机构通道可用，
 *  无头取全文仍只认前缀或内嵌会话（instActiveFrom）。 */
const INST_BROWSER_LOGIN_KEY = "ccode.instBrowserLoginAt";
/** 设置页与付费墙行都挂着，同一窗口里 storage 事件不触发，改了靠这个互相通知 */
export const INST_BROWSER_LOGIN_EVENT = "ccode-inst-browser-login";
/** 学校统一认证的登录多在一周内失效；过了就当没登录，按钮回来 */
export const INST_BROWSER_LOGIN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function instBrowserLoginFresh(at: number | null, now: number): boolean {
  return at != null && at <= now && now - at < INST_BROWSER_LOGIN_TTL_MS;
}

export function readInstBrowserLogin(): number | null {
  try {
    const at = Number(localStorage.getItem(INST_BROWSER_LOGIN_KEY));
    return Number.isFinite(at) && at > 0 ? at : null;
  } catch {
    return null;
  }
}

/** null = 清掉标记 */
export function writeInstBrowserLogin(at: number | null): void {
  try {
    if (at == null) localStorage.removeItem(INST_BROWSER_LOGIN_KEY);
    else localStorage.setItem(INST_BROWSER_LOGIN_KEY, String(at));
  } catch {
    /* 写不进就只靠本次 */
  }
  window.dispatchEvent(new Event(INST_BROWSER_LOGIN_EVENT));
}

/** 「已登录」旁的日期：M月D日 */
export function instBrowserLoginDay(at: number): string {
  const d = new Date(at);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 「获取全文」按钮可见性（不摆装死钮原则）：
 *  - 裸 DOI / doi.org 链接：可查合法开放副本（Unpaywall/OpenAlex），离线也值得试；
 *  - 其余 http(s) 落地页：仅机构通道可用时才给（后端会走前缀改写 + 落地页提取）；
 *  - 空串/非链接：不给。 */
export function canAttemptFulltext(rawUrl: string, instActive: boolean): boolean {
  const u = rawUrl.trim();
  if (!u) return false;
  if (/^(?:doi:\s*)?10\.\d{4,9}\/\S+$/i.test(u)) return true;
  if (/^https?:\/\/(?:dx\.)?doi\.org\//i.test(u)) return true;
  if (/^https?:\/\//i.test(u)) return instActive;
  return false;
}

/** fetch_paper_fulltext 的 via → toast 前缀（渠道对人可见，失败提示才有方向） */
export function fulltextViaLabel(via: string): string {
  if (via === "oa") return "已获取（开放副本）：";
  if (via === "institutional") return "已获取（机构通道）：";
  return "已下载：";
}

/** 会话状态行的白话摘要（设置页/雷达卡共用）。只有入口页 Cookie 的罐子如实
 *  标注「尚未确认机构登录」——用户没真登录时不说「已保存可取全文」 */
export function instSessionLabel(status: InstSessionStatus | null): string {
  if (!status?.sessionPresent) return "未保存会话";
  const when = status.updatedAt ? new Date(status.updatedAt) : null;
  const time = when && !Number.isNaN(when.getTime())
    ? `${when.getMonth() + 1}月${when.getDate()}日 ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`
    : "时间未知";
  const domains = status.domains.length
    ? status.domains.slice(0, 3).join("、") + (status.domains.length > 3 ? ` 等 ${status.domains.length} 个域` : "")
    : "";
  if (status.sessionCredible === false) {
    return `入口页会话 ${status.cookieCount} 条（尚未确认机构登录——登录完成后会自动更新）· ${time}`;
  }
  return `已保存 ${status.cookieCount} 条会话（${domains}）· ${time}`;
}

/** fetch_paper_fulltext 的返回：落盘信息 + 实际命中渠道（direct/oa/institutional） */
export interface FetchedFulltextDto {
  path: string;
  name: string;
  via: string;
  /** papers/ 已有同一份（字节级相同），未重复写入 */
  dedup?: boolean;
}

/** 「浏览器打开」的目标地址：裸 DOI 补成 doi.org 落地，http(s) 原样 */
export function instOpenTarget(rawUrl: string): string {
  const u = rawUrl.trim().replace(/^doi:\s*/i, "");
  if (/^10\.\d{4,9}\/\S+$/i.test(u)) return `https://doi.org/${u}`;
  return rawUrl.trim();
}
