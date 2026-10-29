/**
 * 认出 Agent CLI 画在终端里的「连接出问题」（纯逻辑，读 xterm 可视区文本行）：额度用完、限流、钥匙被拒、
 * 服务出错 / 超时、模型不存在。认出来后 Mesa 给「换个连接接着这段对话」（TerminalView switchConnection）。
 *
 * 只认带固定上下文的错误行，回答正文里聊到「429」「rate limit」不算。各家形态（2026-10-17 本机假网关回
 * 429 / 401 / 500，按 Mesa 应答口径 PTY 实录；样本在 tests/conn-issue.test.ts）：
 * - Claude Code / CodeBuddy 重试中：「✻ 429 <网关原文> · Retrying in 3s · attempt 4/10」；最终「API Error: 429 …」
 * - CodeBuddy：「└ 429 <网关原文>」；网关回 200 却不是它要的 chat/completions 流时只画
 *   「└ Model returned no valid response. Retry later, …」（2026-10-21 实录：给了 Anthropic 地址）
 * - Codex：「■ exceeded retry limit, last status: 429 Too Many Requests」「■ unexpected status 401 Unauthorized: <原文>, url: …」
 * - Kimi：「Retrying (5/10) · APIProviderRateLimitError · in 5s」下一行「429 · <原文>」；「Error: [provider.auth_error] 401 <原文>」
 * - OpenCode：「<原文> [retrying in 1s attempt #2]」
 * - Grok：「Retry failed: rate_limit_error: <原文>」「Authentication required: …」
 * 网络不通（2026-10-29 本机把出网代理指到不通的端口，PTY 抓屏实录；只有官方账号启动才给「去填出网代理」，见 chat-decision）：
 * - Claude Code：「✻ Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED) · Retrying in 1s · attempt 1/10」
 * - Cursor：「⠘⠤ Reconnecting to agentn.global.api5.cursor.sh (attempt 2, 1s)」（第一次只有「Reconnecting (attempt 1, 0s)」）
 * - Grok：「⠸ Connection failed | Retrying (attempt 2)... 0.3s」
 * - CodeBuddy：「└ 502 连接被拒绝：可能是代理未启动或端口被拦截，请检查网络代理设置（connect ECONNREFUSED …）」
 * 重试第一次就报太容易是网络抖一下，重试类只认第 2 次起。Gemini / Qwen / Kimi 没有官方账号的实录，不认。
 * 认不出的：Qwen 重试期间屏上只有转圈（实测 90 秒仍在静默重试）；OpenCode 的 401 只画网关原文、没有状态码。
 */

export type ConnIssueKind = "quota" | "rate_limit" | "auth" | "timeout" | "network" | "model_missing" | "other";

export interface DetectedConnIssue {
  kind: ConnIssueKind;
  status: number | null;
  /** 网关 / CLI 的原文（去掉重试计数） */
  message: string;
  /** CLI 还在自动重试 */
  retrying: boolean;
  /** 同一个错误的稳定键：同一行重绘（倒计时、次数变化）不算新错误 */
  sig: string;
}

const EDGE = /^[\s│┃]+|[\s│┃]+$/g;

export function classifyConnIssue(status: number | null, text: string): ConnIssueKind {
  if (status === 401 || status === 403 || /auth|unauthori[sz]ed|credential|invalid.{0,12}key|身份验证|鉴权|令牌无效/i.test(text)) {
    return "auth";
  }
  if (status === 402 || /quota|insufficient|额度|上限|欠费|余额|usage limit|limit reached|billing|credit/i.test(text)) {
    return "quota";
  }
  if (status === 429 || /rate.?limit|too many requests|速率|频率|限流/i.test(text)) return "rate_limit";
  if (status === 404 || /model.{0,20}(not found|not exist|does not exist)|model_not_found|模型不存在|不支持该模型/i.test(text)) {
    return "model_missing";
  }
  if ((status !== null && status >= 500) || /timeout|timed out|overload|unavailable|econn|bad gateway|超时|服务繁忙/i.test(text)) {
    return "timeout";
  }
  return "other";
}

/** Node 的网络错误码 / CLI 自己写的「防火墙或代理」：连不上服务器，不是服务器回了错 */
const NETWORK = /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b|firewall or proxy|连接被拒绝/i;

function issue(status: number | null, label: string, message: string, retrying: boolean): DetectedConnIssue {
  const msg = message.trim();
  let kind = classifyConnIssue(status, `${label} ${msg}`);
  if ((kind === "timeout" || kind === "other") && NETWORK.test(msg)) kind = "network";
  return { kind, status, message: msg, retrying, sig: `${kind}|${status ?? ""}|${msg}` };
}

function netIssue(message: string): DetectedConnIssue {
  return { kind: "network", status: null, message, retrying: true, sig: `network||${message}` };
}

/** 屏上所有认得出的连接错误，自上而下（同一个错误出现几次就列几次，调用方按次数判新旧） */
export function detectConnIssues(lines: readonly string[], agentId: string): DetectedConnIssue[] {
  const rows = lines.map((l) => l.replace(EDGE, ""));
  const out: DetectedConnIssue[] = [];
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i];
    if (!t) continue;
    let m: RegExpExecArray | null;
    if (agentId === "claude-code" || agentId === "codebuddy") {
      if ((m = /^\S\s+([45]\d\d)\s+(.+?)\s+·\s+Retrying in\b/.exec(t))) {
        out.push(issue(Number(m[1]), "", m[2], true));
        continue;
      }
      if ((m = /\bAPI Error:?\s*\(?([45]\d\d)\)?\s*(.*)$/.exec(t))) {
        out.push(issue(Number(m[1]), "", m[2], false));
        continue;
      }
      // 没有状态码的连接错误：「✻ Connection refused — … (ECONNREFUSED) · Retrying in 1s · attempt 3/10」
      if (
        (m = /^\S\s+(.+?)\s+·\s+Retrying in\b.*?\battempt\s+(\d+)\/\d+/.exec(t)) &&
        Number(m[2]) >= 2 &&
        NETWORK.test(m[1])
      ) {
        out.push(issue(null, "", m[1], true));
        continue;
      }
      if (agentId === "codebuddy" && (m = /^└\s+([45]\d\d)\s+(.+)$/.exec(t))) {
        out.push(issue(Number(m[1]), "", m[2], false));
        continue;
      }
      if (agentId === "codebuddy" && (m = /^└\s+(Model returned no valid response\.?)/.exec(t))) {
        out.push(issue(null, "", m[1], false));
        continue;
      }
    }
    if (agentId === "codex") {
      if ((m = /^■\s+exceeded retry limit, last status:\s*([45]\d\d)\s*(.*)$/.exec(t))) {
        out.push(issue(Number(m[1]), "", m[2], false));
        continue;
      }
      if ((m = /^■\s+unexpected status\s+([45]\d\d)\s*(.*?)(?:,\s*url:.*)?$/.exec(t))) {
        out.push(issue(Number(m[1]), "", m[2], false));
        continue;
      }
    }
    if (agentId === "cursor" && (m = /Reconnecting(?: to (\S+))? \(attempt (\d+),/.exec(t)) && Number(m[2]) >= 2) {
      out.push(netIssue(m[1] ? `Reconnecting to ${m[1]}` : "Reconnecting"));
      continue;
    }
    if (agentId === "kimi") {
      if ((m = /Retrying \(\d+\/\d+\)\s*·\s*(\w+)\s*·/.exec(t))) {
        const next = rows.slice(i + 1).find((r) => r.trim());
        const d = next ? /^([45]\d\d)\s*·\s*(.+)$/.exec(next) : null;
        out.push(issue(d ? Number(d[1]) : null, m[1], d ? d[2] : m[1], true));
        continue;
      }
      if ((m = /Error:\s*\[provider\.(\w+)\]\s*([45]\d\d)?\s*(.*)$/.exec(t))) {
        out.push(issue(m[2] ? Number(m[2]) : null, m[1], m[3] || m[1], false));
        continue;
      }
    }
    if (agentId === "opencode" && (m = /^(?:[⬝■]+\s+)?(.+?)\s+\[retrying in \d+\w* attempt #\d+\]/.exec(t))) {
      out.push(issue(null, "", m[1], true));
      continue;
    }
    if (agentId === "grok") {
      if ((m = /^Retry failed:\s*(\w+):\s*(.+)$/.exec(t))) {
        out.push(issue(null, m[1], m[2], false));
        continue;
      }
      if ((m = /^Authentication required:\s*(.+)$/.exec(t))) {
        out.push(issue(401, "auth", m[1], false));
        continue;
      }
      if ((m = /Connection failed\s*\|\s*Retrying \(attempt (\d+)\)/.exec(t)) && Number(m[1]) >= 2) {
        out.push(netIssue("Connection failed"));
        continue;
      }
    }
  }
  return out;
}

/**
 * 只要「新」错误：发命令 / 关提示 / 换连接那一刻屏上已有的记作基线（按次数），之后同一个错误次数涨了才算新的。
 * 基线里不再出现在屏上的条目顺手清掉——那个错误滚走了，再出现就是新的。返回最靠下的新错误，没有为 null。
 */
export function newestConnIssue(
  found: readonly DetectedConnIssue[],
  baseline: Map<string, number>,
): DetectedConnIssue | null {
  const counts = new Map<string, number>();
  for (const f of found) counts.set(f.sig, (counts.get(f.sig) ?? 0) + 1);
  for (const [sig, n] of baseline) {
    const now = counts.get(sig) ?? 0;
    if (now === 0) baseline.delete(sig);
    else if (now < n) baseline.set(sig, now);
  }
  for (let i = found.length - 1; i >= 0; i--) {
    const f = found[i];
    if ((counts.get(f.sig) ?? 0) > (baseline.get(f.sig) ?? 0)) return f;
  }
  return null;
}

export function connIssueCounts(found: readonly DetectedConnIssue[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of found) counts.set(f.sig, (counts.get(f.sig) ?? 0) + 1);
  return counts;
}

/** 给人看的一句话（聊天层确认卡 / 终端顶栏共用） */
export function connIssueText(kind: ConnIssueKind, profileName: string): string {
  const name = profileName ? `「${profileName}」连接` : "当前连接";
  switch (kind) {
    case "quota":
      return `${name}的额度用完了`;
    case "rate_limit":
      return `${name}被限流了，请求太频繁`;
    case "auth":
      return `${name}的钥匙被拒绝了`;
    case "timeout":
      return `${name}的服务出错或超时了`;
    case "network":
      return `${name}连不上服务器`;
    case "model_missing":
      return `${name}里没有这个模型`;
    default:
      return `${name}出错了`;
  }
}
