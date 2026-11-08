/** 机构访问（高校/研究所）通道前端纯逻辑：状态镜像、获取按钮可见性、渠道文案。
 *  后端见 src-tauri/src/inst_access.rs（会话 Cookie 0600 不出站，这里只拿到统计态）。
 *  设置页「学校图书馆」2026-11-08 起是三种访问方式（校园网 / 校外访问链接 / 出版商网站登录），
 *  旧的「登录好了 · 已登录」标记与登录入口一并去掉（那只是记点按钮的日期，不是真的登录状态）。 */

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
