import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatBalanceAmount,
  formatBalanceAmountMasked,
  gatewayHasWallet,
  groupWalletAccounts,
  pickAccountHead,
  splitBalanceAmount,
  walletAccountTitle,
  walletAmountCaption,
  walletExpirySoon,
  walletHostMatches,
  walletKindLabel,
  walletMissingHint,
  walletOriginKey,
  walletKeyAmountLine,
  walletSpendTone,
  walletTokenQuota,
  walletUnlimitedFill,
  walletUnlimitedLine,
  walletUrl,
  walletUsedPercent,
  WALLET_UNLIMITED_BAR_CAP,
} from "../src/gateway-balance.ts";

function gw(url: string) {
  return { slots: { openai: url } };
}

test("主机命中 zetatechs，非子串误伤", () => {
  assert.ok(walletHostMatches("zetatechs.com"));
  assert.ok(walletHostMatches("ent.zetatechs.com"));
  assert.ok(walletHostMatches("ENT.Zetatechs.COM"));
  assert.ok(walletHostMatches("ent.zetatechs.com:443"));
  assert.ok(!walletHostMatches("notzetatechs.com"));
  assert.ok(!walletHostMatches("api.deepseek.com"));
  assert.ok(!walletHostMatches(""));
});

test("网关槽 URL 命中才出卡", () => {
  assert.ok(gatewayHasWallet(gw("https://ent.zetatechs.com/v1")));
  assert.ok(
    gatewayHasWallet({ slots: { responses: "https://ent.zetatechs.com/v1" } }),
  );
  assert.ok(!gatewayHasWallet(gw("https://api.deepseek.com/v1")));
  assert.ok(!gatewayHasWallet({ slots: null }));
  assert.ok(!gatewayHasWallet({}));
});

test("金额按站点币种格式化，不走用量页汇率", () => {
  assert.equal(formatBalanceAmount(128.5, "CNY"), "¥128.50");
  assert.equal(formatBalanceAmount(12, "USD"), "$12.00");
  assert.equal(formatBalanceAmount(1234.6, "TOKENS"), "1,235 tokens");
  assert.equal(formatBalanceAmount(Number.NaN, "CNY"), "—");
  assert.equal(formatBalanceAmountMasked("CNY"), "¥•••");
  assert.equal(formatBalanceAmountMasked("USD"), "$•••");
  assert.equal(formatBalanceAmountMasked("TOKENS"), "•••");
});

test("已用百分比钳制", () => {
  assert.equal(walletUsedPercent(21.5, 150), (21.5 / 150) * 100);
  assert.equal(walletUsedPercent(0, 150), 0);
  assert.equal(walletUsedPercent(200, 100), 100);
  assert.equal(walletUsedPercent(1, 0), null);
  assert.equal(walletUsedPercent(null, 100), null);
});

test("钱包深链与种类名", () => {
  assert.equal(walletUrl("https://ent.zetatechs.com"), "https://ent.zetatechs.com/wallet");
  assert.equal(walletUrl("https://ent.zetatechs.com/"), "https://ent.zetatechs.com/wallet");
  assert.equal(walletKindLabel("newapi"), "New API");
  assert.equal(walletKindLabel("other"), "other");
  assert.equal(walletAmountCaption("wallet"), "当前可用余额");
  assert.equal(walletAmountCaption("token"), "密钥额度");
  assert.equal(walletAmountCaption(""), "余额");
  assert.match(walletMissingHint(false), /系统访问令牌/);
  assert.match(walletMissingHint(true), /连接页/);
  // 一句话说得完，不铺两行长句
  assert.ok(walletMissingHint(false).length <= 20);
  assert.ok(walletMissingHint(true).length <= 20);
});

test("大数字拆币种符号，负数符号不跑进数字里", () => {
  assert.deepEqual(splitBalanceAmount(4842.831884, "CNY"), {
    prefix: "¥",
    number: "4,842.83",
    unit: "",
  });
  assert.deepEqual(splitBalanceAmount(12, "USD"), { prefix: "$", number: "12.00", unit: "" });
  assert.deepEqual(splitBalanceAmount(1235, "TOKENS"), {
    prefix: "",
    number: "1,235",
    unit: "tokens",
  });
  assert.deepEqual(splitBalanceAmount(-1.45, "CNY"), {
    prefix: "-¥",
    number: "1.45",
    unit: "",
  });
  assert.equal(splitBalanceAmount(Number.NaN, "CNY").number, "—");
});

test("不限额度也把已用说出来", () => {
  assert.equal(walletUnlimitedLine(4622.53, "CNY"), "不限 · 已用 ¥4,622.53");
  assert.equal(walletUnlimitedLine(null, "CNY"), "不限");
  assert.equal(walletUnlimitedLine(4622.53, "CNY", true), "不限 · 已用 ¥•••");
});

test("不限额度开口条：同卡已用的对数比，最多停在留白处", () => {
  const peers = [4622.64, 9.89];
  assert.equal(walletUnlimitedFill(4622.64, peers), WALLET_UNLIMITED_BAR_CAP);
  const small = walletUnlimitedFill(9.89, peers);
  // 差两个数量级：线性比会缩成不到 1，对数比仍能看见，又明显短于最长的那条
  assert.ok(small != null && small > 10 && small < WALLET_UNLIMITED_BAR_CAP / 2);
  // 只差一倍时两条仍靠近，不按线性拉成一半
  const close = walletUnlimitedFill(100, [100, 200]);
  assert.ok(close != null && close > 60);
  assert.equal(walletUnlimitedFill(200, [100, 200]), WALLET_UNLIMITED_BAR_CAP);
  // 单独一把也留白，不画成满条
  assert.equal(walletUnlimitedFill(100, []), WALLET_UNLIMITED_BAR_CAP);
  assert.equal(walletUnlimitedFill(0, [10]), null);
  assert.equal(walletUnlimitedFill(null, [10]), null);
  assert.equal(walletUnlimitedFill(-3, [10]), null);
});

test("消耗条：主题强调色过渡，正常档压透明度", () => {
  assert.equal(walletSpendTone(2).bar, "bg-cta/70");
  assert.equal(walletSpendTone(76).bar, "bg-cta/70");
  assert.equal(walletSpendTone(80).bar, "bg-warn-text/80");
  assert.equal(walletSpendTone(95).bar, "bg-err-text/85");
});

test("密钥行金额格式一致，不混已用前缀", () => {
  assert.equal(walletKeyAmountLine(false, 3.05, 203.05, "CNY"), "¥3.05 / ¥203.05");
  assert.equal(walletKeyAmountLine(true, 4622.53, null, "CNY"), "¥4,622.53");
  assert.equal(walletKeyAmountLine(true, null, null, "CNY"), "");
  assert.equal(
    walletKeyAmountLine(false, 3.05, 203.05, "CNY", true),
    "¥••• / ¥•••",
  );
});

test("到期只临近才在卡里冒头", () => {
  const now = 1_700_000_000_000;
  const day = 24 * 60 * 60 * 1000;
  assert.ok(walletExpirySoon(now + 3 * day, now));
  assert.ok(walletExpirySoon(now + 14 * day, now));
  assert.ok(walletExpirySoon(now - day, now), "已过期同样要提醒");
  assert.ok(!walletExpirySoon(now + 15 * day, now));
  assert.ok(!walletExpirySoon(null, now));
  assert.ok(!walletExpirySoon(0, now), "站点的 0 表示无到期，不能当 1970 年喊到期");
});

// ===== 同站账户合并 =====

function walletRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    gatewayId: "g1",
    gatewayName: "Zeta-22",
    origin: "https://ent.zetatechs.com",
    account: "hongtongzhou",
    ok: true,
    source: "wallet",
    unlimited: false,
    remaining: 4842.83,
    used: 15157.17,
    total: 20000,
    tokenUnlimited: false,
    tokenRemaining: 1.45,
    tokenUsed: 2255.42,
    tokenTotal: 2256.87,
    ...over,
  };
}

test("同站多网关合成一张卡，钱包数字只出现一次", () => {
  const groups = groupWalletAccounts([
    walletRow({ gatewayId: "g1", gatewayName: "Zeta-22" }),
    walletRow({ gatewayId: "g2", gatewayName: "Test", tokenUnlimited: true, tokenRemaining: null }),
    walletRow({ gatewayId: "g3", gatewayName: "Ma" }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].members.length, 3);
  assert.equal(groups[0].head.gatewayId, "g1");
  // 多网关时标题是站点 + 账户，不是某一家网关的名字
  assert.equal(walletAccountTitle(groups[0]), "ent.zetatechs.com · hongtongzhou");
});

test("单网关仍用用户自己起的网关名", () => {
  const groups = groupWalletAccounts([walletRow()]);
  assert.equal(walletAccountTitle(groups[0]), "Zeta-22");
});

test("同站两个账户必须分开，不能混成一张卡", () => {
  const groups = groupWalletAccounts([
    walletRow({ gatewayId: "g1", account: "hongtongzhou" }),
    walletRow({ gatewayId: "g2", account: "someone-else" }),
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.map((g) => g.account),
    ["hongtongzhou", "someone-else"],
  );
  // 并排两张卡时标题要能分清，不能各显示成一个网关名
  assert.equal(walletAccountTitle(groups[0], true), "ent.zetatechs.com · hongtongzhou");
  assert.match(walletAccountTitle(groups[1], true), /someone-else/);
});

test("认不出账户的行并进本站第一组，不丢行", () => {
  const groups = groupWalletAccounts([
    walletRow({ gatewayId: "g1" }),
    walletRow({ gatewayId: "g2", account: null, source: "token" }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].members.length, 2);
  assert.equal(groups[0].account, "hongtongzhou");
});

test("不同站点各成一张卡；同址不同写法不拆开", () => {
  const groups = groupWalletAccounts([
    walletRow({ gatewayId: "g1", origin: "https://ent.zetatechs.com" }),
    walletRow({ gatewayId: "g2", origin: "https://ent.zetatechs.com/" }),
    walletRow({ gatewayId: "g3", origin: "https://other.example.com" }),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].members.length, 2);
  assert.equal(walletOriginKey("HTTPS://Ent.Zetatechs.com///"), "https://ent.zetatechs.com");
});

test("代表行优先钱包成功，全失败时留第一行把错误说出来", () => {
  assert.equal(
    pickAccountHead([
      walletRow({ gatewayId: "g1", ok: false, source: "token" }),
      walletRow({ gatewayId: "g2", ok: true, source: "wallet" }),
    ]).gatewayId,
    "g2",
  );
  assert.equal(
    pickAccountHead([
      walletRow({ gatewayId: "g1", ok: true, source: "token" }),
      walletRow({ gatewayId: "g2", ok: true, source: "wallet" }),
    ]).gatewayId,
    "g2",
  );
  const failed = pickAccountHead([
    walletRow({ gatewayId: "g1", ok: false, source: "" }),
    walletRow({ gatewayId: "g2", ok: true, source: "token" }),
  ]);
  assert.equal(failed.gatewayId, "g2");
  assert.equal(pickAccountHead([walletRow({ gatewayId: "g1", ok: false })]).gatewayId, "g1");
});

test("密钥额度：有 token 数据用它，billing 兜底用提升值，钱包来源绝不拿钱包数当密钥", () => {
  // 1. 有 /api/usage/token
  assert.deepEqual(walletTokenQuota(walletRow()), {
    unlimited: false,
    used: 2255.42,
    total: 2256.87,
    pct: (2255.42 / 2256.87) * 100,
  });
  // 2. 没有 token 数据、主导数字也不是钱包 → 用 billing 提升值
  assert.deepEqual(
    walletTokenQuota(
      walletRow({
        source: "token",
        tokenRemaining: null,
        tokenUsed: null,
        tokenTotal: null,
        tokenUnlimited: false,
        remaining: 128.5,
        used: 21.5,
        total: 150,
      }),
    ),
    { unlimited: false, used: 21.5, total: 150, pct: (21.5 / 150) * 100 },
  );
  // 3. 钱包来源且没有 token 数据 → null（不能拿钱包余额冒充密钥额度）
  assert.equal(
    walletTokenQuota(
      walletRow({
        tokenRemaining: null,
        tokenUsed: null,
        tokenTotal: null,
        tokenUnlimited: false,
      }),
    ),
    null,
  );
  // 4. 不限额度：照样是有效数据，带出已用
  assert.deepEqual(
    walletTokenQuota(
      walletRow({ tokenUnlimited: true, tokenRemaining: null, tokenUsed: 4622.53, tokenTotal: null }),
    ),
    { unlimited: true, used: 4622.53, total: null, pct: null },
  );
  // 5. 什么都没有
  assert.equal(
    walletTokenQuota(
      walletRow({
        source: "token",
        remaining: null,
        total: null,
        tokenRemaining: null,
        tokenUsed: null,
        tokenTotal: null,
        tokenUnlimited: false,
      }),
    ),
    null,
  );
});
