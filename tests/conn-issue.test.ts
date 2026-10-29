import assert from "node:assert/strict";
import test from "node:test";
import {
  connIssueCounts,
  connIssueText,
  detectConnIssues,
  newestConnIssue,
} from "../src/conn-issue.ts";

// 2026-10-17 本机假网关回 429（GLM 5 小时额度原文）/ 401 / 500，按 Mesa 应答口径 PTY 实录的屏幕行
const QUOTA = "已达到 5 小时的使用上限。您的限额将在 2026-10-18 03:12:00 重置。";

test("七家的错误行都认得出，并按原文分类", () => {
  const one = (agent: string, lines: string[]) => {
    const found = detectConnIssues(lines, agent);
    assert.equal(found.length, 1, `${agent}: ${JSON.stringify(found)}`);
    return found[0];
  };
  let f = one("claude-code", ["❯ hello there", `✻ 429 ${QUOTA} · Retrying in 3s · attempt 4/10`, "❯"]);
  assert.equal(f.kind, "quota");
  assert.equal(f.status, 429);
  assert.equal(f.message, QUOTA);
  assert.equal(f.retrying, true);
  assert.equal(one("claude-code", ["✻ 401 身份验证失败。 · Retrying in 17s · attempt 6/10"]).kind, "auth");
  assert.equal(one("claude-code", ["✻ 500 Internal server error · Retrying in 4s · attempt 4/10"]).kind, "timeout");
  assert.equal(one("codebuddy", [`  └ 429 ${QUOTA}`]).kind, "quota");
  // 网关回 200 但不是 chat/completions 流（2026-10-21 实录：连接给了 Anthropic 地址）
  f = one("codebuddy", ["> 你好", "  └ Model returned no valid response. Retry later, switch models with /model, or report it with /feedback."]);
  assert.equal(f.kind, "other");
  assert.equal(f.message, "Model returned no valid response.");
  f = one("codex", ["■ exceeded retry limit, last status: 429 Too Many Requests"]);
  assert.equal(f.kind, "rate_limit");
  f = one("codex", ["■ unexpected status 401 Unauthorized: 身份验证失败。, url: http://127.0.0.1:18970/e401/codex/v1/responses"]);
  assert.equal(f.kind, "auth");
  assert.equal(f.message, "Unauthorized: 身份验证失败。", "url 不进原文");
  f = one("kimi", ["  🌑 Retrying (5/10) · APIProviderRateLimitError · in 5s", `     429 · 429 ${QUOTA}`]);
  assert.equal(f.kind, "quota");
  assert.equal(f.retrying, true);
  assert.equal(one("kimi", ["   Error: [provider.auth_error] 401 身份验证失败。"]).kind, "auth");
  f = one("opencode", [`   ⬝⬝⬝⬝⬝⬝⬝⬝ ${QUOTA} [retrying in 1s attempt #2] esc interrupt`]);
  assert.equal(f.kind, "quota");
  assert.equal(one("grok", [`  ┃  Retry failed: rate_limit_error: ${QUOTA}`]).kind, "quota");
  assert.equal(
    one("grok", ["┃  Authentication required: your session has expired or your credentials were rejected. Run /login to re-"]).kind,
    "auth",
  );
  // 速率限制（不是额度用完）：GLM 1302 原文
  assert.equal(one("claude-code", ["✻ 429 您的账户已达到速率限制，请您控制请求频率 · Retrying in 3s · attempt 2/10"]).kind, "rate_limit");
});

test("回答正文里聊到 429、rate limit 不算；别家的形态不串用", () => {
  assert.deepEqual(
    detectConnIssues(["⏺ 429 表示 Too Many Requests，常见于 rate limit。", "  API 返回 401 时要检查钥匙"], "claude-code"),
    [],
  );
  assert.deepEqual(detectConnIssues(["■ exceeded retry limit, last status: 429 Too Many Requests"], "claude-code"), []);
});

test("只报新错误：基线按次数记，倒计时重绘不算新，同一错误再出一次才算", () => {
  const retry = (n: number) => `✻ 429 ${QUOTA} · Retrying in ${n}s · attempt ${n}/10`;
  const baseline = new Map<string, number>();
  assert.ok(newestConnIssue(detectConnIssues([retry(3)], "claude-code"), baseline));
  // 用户关掉提示：此刻屏上的记作基线
  const now = connIssueCounts(detectConnIssues([retry(3)], "claude-code"));
  now.forEach((v, k) => baseline.set(k, v));
  assert.equal(newestConnIssue(detectConnIssues([retry(9)], "claude-code"), baseline), null, "倒计时变了还是同一个");
  // 错误滚走后基线清掉；再出现就是新的
  assert.equal(newestConnIssue(detectConnIssues(["❯ ok"], "claude-code"), baseline), null);
  assert.equal(baseline.size, 0);
  assert.ok(newestConnIssue(detectConnIssues([retry(2)], "claude-code"), baseline));
  // Codex 的错误是留在记录里的：同一错误出现第二次（次数涨了）算新的
  const cx = "■ exceeded retry limit, last status: 429 Too Many Requests";
  const b2 = connIssueCounts(detectConnIssues([cx], "codex"));
  assert.equal(newestConnIssue(detectConnIssues([cx], "codex"), b2), null);
  assert.ok(newestConnIssue(detectConnIssues([cx, "› 再试一次", cx], "codex"), b2));
});

test("给人看的一句话", () => {
  assert.equal(connIssueText("quota", "GLM"), "「GLM」连接的额度用完了");
  assert.equal(connIssueText("auth", ""), "当前连接的钥匙被拒绝了");
});

// 2026-10-29 本机出网代理指到不通的端口，PTY 抓屏实录（各家官方账号 / 直连官方时的网络不通）
test("网络不通：Claude / Cursor / Grok / CodeBuddy 认得出，重试类第 2 次起才算", () => {
  const CLAUDE = (n: number) => `✻ Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED) · Retrying in 3s · attempt ${n}/10`;
  assert.equal(detectConnIssues([CLAUDE(1)], "claude-code").length, 0, "第 1 次可能只是抖一下");
  const f = detectConnIssues(["❯ hi", CLAUDE(2)], "claude-code");
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, "network");
  assert.equal(f[0].retrying, true);
  // 倒计时与次数变化不换签名
  assert.equal(detectConnIssues([CLAUDE(5)], "claude-code")[0].sig, f[0].sig);
  // 没有网络错误码的重试行不算网络问题（其他原因另说）
  assert.equal(detectConnIssues(["✻ Overloaded · Retrying in 3s · attempt 4/10"], "claude-code").length, 0);

  const cursor = detectConnIssues([" ⠀⠞ Reconnecting (attempt 1, 0s)", " ⠘⠤ Reconnecting to agentn.global.api5.cursor.sh (attempt 2, 1s)"], "cursor");
  assert.equal(cursor.length, 1, "第 1 次不算");
  assert.equal(cursor[0].kind, "network");
  assert.equal(cursor[0].message, "Reconnecting to agentn.global.api5.cursor.sh");

  assert.equal(detectConnIssues(["    ⠸ Connection failed | Retrying (attempt 1)... 0.0s    21s ⇣1.34k [stop]"], "grok").length, 0);
  const grok = detectConnIssues(["    ⠴ Connection failed | Retrying (attempt 2)... 0.0s    21s ⇣1.34k [stop]"], "grok");
  assert.equal(grok[0].kind, "network");

  const bud = detectConnIssues(["  └ 502 连接被拒绝：可能是代理未启动或端口被拦截，请检查网络代理设置（connect ECONNREFUSED 127.0.0.1:9）"], "codebuddy");
  assert.equal(bud[0].kind, "network");
  assert.equal(bud[0].status, 502);
  // 网关自己回的 502 不是网络不通
  assert.equal(detectConnIssues(["  └ 502 Bad Gateway"], "codebuddy")[0].kind, "timeout");
  assert.equal(connIssueText("network", ""), "当前连接连不上服务器");
});
