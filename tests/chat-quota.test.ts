import assert from "node:assert/strict";
import test from "node:test";
import {
  listSameAgentPeers,
  profileQuotaKind,
  resolveChatQuotaView,
} from "../src/chat-quota.ts";
import type { Gateway, GatewayBalanceDto, PlanQuotaDto, Profile } from "../src/types.ts";

function makeProfile(overrides: Partial<Profile>): Profile {
  return {
    id: "p1",
    name: "测试连接",
    agent: "claude-code",
    accountType: "official",
    gatewayId: null,
    hasKey: false,
    noAuth: false,
    models: [],
    defaultModel: null,
    env: {},
    ...overrides,
  } as Profile;
}

function makePlanRow(overrides: Partial<PlanQuotaDto>): PlanQuotaDto {
  return {
    gatewayId: "official:claude-code",
    gatewayName: "官方账号",
    provider: "claude",
    planLevel: "Max",
    ok: true,
    error: null,
    windows: [
      { window: "five_hour", usedPercent: 12, resetsAt: null, used: null, total: null },
      { window: "weekly", usedPercent: 64, resetsAt: null, used: null, total: null },
    ],
    resetCardsSupported: false,
    resetCards: {
      ok: false,
      fiveHour: 0,
      weekly: 0,
      fiveHourExpiresAt: null,
      weeklyExpiresAt: null,
      lastFiveHourResetAt: null,
      lastWeekResetAt: null,
      error: null,
      general: 0,
      generalExpiresAt: null,
      generalApplicable: null,
    },
    queriedAt: 1700000000000,
    fromCache: false,
    consoleUrl: "",
    ...overrides,
  };
}

function makeWalletRow(overrides: Partial<GatewayBalanceDto>): GatewayBalanceDto {
  return {
    gatewayId: "gw-wallet",
    gatewayName: "Zeta",
    origin: "https://ent.zetatechs.com",
    account: "user1",
    kind: "newapi",
    ok: true,
    error: null,
    source: "wallet",
    unlimited: false,
    currency: "CNY",
    remaining: 50,
    used: 450,
    total: 500,
    expiresAt: null,
    hasWalletToken: true,
    tokenRemaining: null,
    tokenUsed: null,
    tokenTotal: null,
    tokenUnlimited: true,
    tokenName: null,
    queriedAt: 1700000000000,
    fromCache: false,
    ...overrides,
  };
}

test("resolveChatQuotaView：订阅按最紧窗口换算剩余百分比与分档", () => {
  const profile = makeProfile({ id: "p-claude", agent: "claude-code", accountType: "official" });
  const view = resolveChatQuotaView(profile, [makePlanRow({})], []);
  assert.ok(view && view.kind === "plan");
  assert.equal(view.primary.window, "weekly");
  assert.equal(view.secondary?.window, "five_hour");
  assert.equal(view.remainPct, 36);
  assert.equal(view.tone, "ok");

  const dangerView = resolveChatQuotaView(
    profile,
    [
      makePlanRow({
        windows: [
          { window: "five_hour", usedPercent: 93.4, resetsAt: null, used: null, total: null },
          { window: "weekly", usedPercent: 40, resetsAt: null, used: null, total: null },
        ],
      }),
    ],
    [],
  );
  assert.ok(dangerView && dangerView.kind === "plan");
  assert.equal(dangerView.primary.window, "five_hour");
  assert.equal(dangerView.remainPct, 7);
  assert.equal(dangerView.tone, "danger");
});

test("resolveChatQuotaView：网关钱包按剩余比例与消耗告警分档", () => {
  const profile = makeProfile({
    id: "p-gw",
    agent: "codex",
    accountType: "gateway",
    gatewayId: "gw-wallet",
    hasKey: true,
  });
  const view = resolveChatQuotaView(profile, [], [makeWalletRow({ used: 455, total: 500 })]);
  assert.ok(view && view.kind === "wallet");
  assert.equal(view.usedPct, 91);
  assert.equal(view.remainPct, 9);
  assert.equal(view.tone, "danger");
});

test("resolveChatQuotaView：无匹配或失败行返回 null 不占空位", () => {
  const profile = makeProfile({ id: "p-none", agent: "gemini", accountType: "official" });
  assert.equal(resolveChatQuotaView(profile, [makePlanRow({})], []), null);
  const failed = makePlanRow({ ok: false, windows: [] });
  assert.equal(
    resolveChatQuotaView(makeProfile({ agent: "claude-code", accountType: "official" }), [failed], []),
    null,
  );
});

test("profileQuotaKind：区分官方套餐、网关套餐与 New API 钱包", () => {
  const gateways: Gateway[] = [
    {
      id: "gw-zhipu",
      name: "智谱",
      slots: { anthropic: "https://open.bigmodel.cn/api/anthropic" },
    } as Gateway,
    {
      id: "gw-zeta",
      name: "Zeta",
      slots: { openai: "https://ent.zetatechs.com/v1" },
    } as Gateway,
  ];
  assert.equal(
    profileQuotaKind(makeProfile({ agent: "codex", accountType: "official" }), gateways),
    "plan",
  );
  assert.equal(
    profileQuotaKind(makeProfile({ accountType: "gateway", gatewayId: "gw-zhipu" }), gateways),
    "plan",
  );
  assert.equal(
    profileQuotaKind(makeProfile({ accountType: "gateway", gatewayId: "gw-zeta" }), gateways),
    "wallet",
  );
  assert.equal(
    profileQuotaKind(makeProfile({ agent: "gemini", accountType: "official" }), gateways),
    null,
  );
});

test("listSameAgentPeers：优先同类型且已用比例更低的备选号，排除隐藏项与自身", () => {
  const cur = makeProfile({ id: "a1", name: "主力", agent: "agy", accountType: "official" });
  const a2 = makeProfile({ id: "a2", name: "备用高", agent: "agy", accountType: "official" });
  const a3 = makeProfile({ id: "a3", name: "备用低", agent: "agy", accountType: "official" });
  const aHidden = makeProfile({ id: "a4", name: "隐藏", agent: "agy", accountType: "official" });
  const gw = makeProfile({
    id: "g1",
    name: "网关",
    agent: "agy",
    accountType: "gateway",
    hasKey: true,
  });
  const planRows: PlanQuotaDto[] = [
    makePlanRow({
      gatewayId: "official:agy:a2",
      bindingId: "a2",
      provider: "agy",
      windows: [{ window: "five_hour", usedPercent: 75, resetsAt: null, used: null, total: null }],
    }),
    makePlanRow({
      gatewayId: "official:agy:a3",
      bindingId: "a3",
      provider: "agy",
      windows: [{ window: "five_hour", usedPercent: 18, resetsAt: null, used: null, total: null }],
    }),
  ];
  const peers = listSameAgentPeers(cur, [cur, a2, a3, aHidden, gw], planRows, ["a4"]);
  assert.deepEqual(
    peers.map((p) => p.profile.id),
    ["a3", "a2", "g1"],
  );
  assert.equal(peers[0].remainPct, 82);
  assert.equal(peers[1].tone, "warn");
});
