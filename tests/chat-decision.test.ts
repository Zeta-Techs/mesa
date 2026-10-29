import assert from "node:assert/strict";
import test from "node:test";
import { connIssueDecision, grokLoginDecision } from "../src/chat-decision.ts";
import type { ConnIssueState } from "../src/pages/TerminalPage.tsx";

function issue(over: Partial<ConnIssueState> = {}): ConnIssueState {
  return {
    kind: "quota",
    status: 429,
    message: "5 小时额度已用完",
    retrying: false,
    sig: "quota|429|5 小时额度已用完",
    profileName: "GLM",
    text: "「GLM」连接的额度用完了",
    detail: "429 5 小时额度已用完",
    alternatives: [],
    ...over,
  };
}

test("连接出问题：同家其他连接逐个成按钮，第一条为推荐，点了换到那条", () => {
  const picked: string[] = [];
  const d = connIssueDecision(
    issue({
      alternatives: [
        { profileId: "zeta", label: "Zeta · glm-5.3" },
        { profileId: "b", label: "B" },
        { profileId: "c", label: "C" },
        { profileId: "d", label: "D" },
      ],
    }),
    "Claude Code",
    { onSwitch: (id) => picked.push(id), onDismiss: () => picked.push("dismiss") },
  );
  assert.equal(d.title, "「GLM」连接的额度用完了");
  assert.equal(d.detail, "429 5 小时额度已用完");
  assert.equal(d.key, "conn:quota|429|5 小时额度已用完");
  const labels = d.options.map((o) => o.label);
  assert.deepEqual(labels, [
    "换到 Zeta · glm-5.3，接着这段对话",
    "换到 B，接着这段对话",
    "换到 C，接着这段对话",
    "先不换",
  ], "最多摆三条，末尾总有「先不换」");
  assert.equal(d.options[0].primary, true);
  d.options[0].onClick();
  d.options[3].onClick();
  assert.deepEqual(picked, ["zeta", "dismiss"]);
  assert.match(d.hint ?? "", /聊过的内容不会丢/);
});

test("连接出问题：没有可换的连接时给「去添加连接」，提示按错误种类给另一条路", () => {
  let opened = false;
  const d = connIssueDecision(issue({ kind: "auth", retrying: true }), "Codex", {
    onSwitch: () => {},
    onDismiss: () => {},
    onOpenProfiles: () => {
      opened = true;
    },
  });
  assert.deepEqual(d.options.map((o) => o.label), ["去添加连接", "先不换"]);
  d.options[0].onClick();
  assert.equal(opened, true);
  assert.match(d.hint ?? "", /还在自己重试/);
  assert.match(d.hint ?? "", /检查这条连接的钥匙/);
  // 没传去连接页的入口：只剩「先不换」
  const bare = connIssueDecision(issue(), "Codex", { onSwitch: () => {}, onDismiss: () => {} });
  assert.deepEqual(bare.options.map((o) => o.label), ["先不换"]);
  assert.match(bare.hint ?? "", /等额度恢复/);
});

test("Grok 卡在续期官方登录上：推荐退出官方登录接着聊，另一个是先不管", () => {
  const picked: string[] = [];
  const d = grokLoginDecision({ onLogout: () => picked.push("logout"), onDismiss: () => picked.push("dismiss") });
  assert.equal(d.key, "grok-login-stuck");
  assert.deepEqual(
    d.options.map((o) => [o.label, Boolean(o.primary)]),
    [
      ["退出官方登录，接着这段对话", true],
      ["先不管", false],
    ],
  );
  d.options.forEach((o) => o.onClick());
  assert.deepEqual(picked, ["logout", "dismiss"]);
});

test("网络不通（官方账号）：先给「去设置出网代理」，同家别的连接是备选、不再抢主按钮", () => {
  const log: string[] = [];
  const d = connIssueDecision(
    issue({ kind: "network", status: null, message: "Reconnecting to x", retrying: true, text: "当前连接连不上服务器", alternatives: [{ profileId: "zeta", label: "Zeta" }] }),
    "Cursor",
    { onSwitch: (id) => log.push(`switch:${id}`), onDismiss: () => {}, onOpenNetwork: () => log.push("network") },
  );
  assert.match(d.hint ?? "", /设置 → 网络.*出网代理/);
  assert.deepEqual(d.options.map((o) => [o.label, Boolean(o.primary)]), [
    ["去设置出网代理", true],
    ["换到 Zeta，接着这段对话", false],
    ["先不换", false],
  ]);
  d.options[0].onClick();
  assert.deepEqual(log, ["network"]);
  // 没有别的连接时不再出「去添加连接」（换连接帮不上网络问题）
  const bare = connIssueDecision(issue({ kind: "network" }), "Cursor", { onSwitch: () => {}, onDismiss: () => {}, onOpenProfiles: () => {}, onOpenNetwork: () => {} });
  assert.deepEqual(bare.options.map((o) => o.label), ["去设置出网代理", "先不换"]);
});
