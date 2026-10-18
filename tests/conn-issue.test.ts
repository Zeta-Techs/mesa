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
