import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findPlanRowForProfile,
  hasOfficialQuotaCard,
  isolatedEnvVarOf,
  isPlanRowExhausted,
  isQuotaExhaustedError,
  needsRelayOnSameAgentSwitch,
  pickAlternateAccountForLimit,
  supportsMultiOfficial,
} from "../src/official-accounts.ts";
import {
  applyQuotaDisplayPrefs,
  EMPTY_QUOTA_PREFS,
  moveQuotaOrder,
  planProviderLabel,
  planWindowLabel,
  toggleQuotaHidden,
} from "../src/plan-quota.ts";
import type { PlanQuotaDto, Profile } from "../src/types.ts";

function makeProfile(patch: Partial<Profile> & { id: string; agent: string; name: string }): Profile {
  return {
    accountType: "official",
    noAuth: false,
    protocol: null,
    baseUrl: null,
    models: [],
    extraEnv: {},
    requestPolicy: { headerEnv: {} },
    keyHint: null,
    hasKey: false,
    lastUsedAt: null,
    gatewayId: null,
    ...patch,
  };
}

function makeQuota(patch: Partial<PlanQuotaDto> & { gatewayId: string; provider: string }): PlanQuotaDto {
  return {
    gatewayName: "官方账号",
    planLevel: null,
    ok: true,
    error: null,
    windows: [],
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
    queriedAt: 1_700_000_000_000,
    fromCache: false,
    consoleUrl: "",
    ...patch,
  };
}

describe("official-accounts multi-account routing & limit hint", () => {
  it("recognizes multi-official capable agents", () => {
    for (const id of ["claude-code", "codex", "agy", "grok", "kimi", "gemini", "codebuddy"]) {
      assert.equal(supportsMultiOfficial(id), true, id);
    }
    for (const id of ["opencode", "cursor", "qwen"]) {
      assert.equal(supportsMultiOfficial(id), false, id);
    }
    assert.equal(isolatedEnvVarOf("grok"), "GROK_HOME");
    assert.equal(isolatedEnvVarOf("kimi"), "KIMI_CODE_HOME");
    assert.equal(isolatedEnvVarOf("gemini"), "GEMINI_CLI_HOME");
    assert.equal(isolatedEnvVarOf("codebuddy"), "CODEBUDDY_CONFIG_DIR");
    assert.equal(hasOfficialQuotaCard("grok"), true);
    assert.equal(hasOfficialQuotaCard("kimi"), true);
    assert.equal(hasOfficialQuotaCard("gemini"), false);
    assert.equal(hasOfficialQuotaCard("codebuddy"), false);
    assert.equal(planProviderLabel("grok"), "Grok");
    assert.equal(planWindowLabel("credits"), "额度");

    const grokDefault = makeProfile({ id: "gk-1", agent: "grok", name: "官方账号" });
    const kimiDefault = makeProfile({ id: "km-1", agent: "kimi", name: "官方账号" });
    const rows = [
      makeQuota({ gatewayId: "official:grok", provider: "grok" }),
      makeQuota({ gatewayId: "official:kimi", provider: "kimi" }),
    ];
    assert.equal(findPlanRowForProfile(grokDefault, rows)?.gatewayId, "official:grok");
    assert.equal(findPlanRowForProfile(kimiDefault, rows)?.gatewayId, "official:kimi");
  });

  it("forces relay when switching across official accounts or isolated dirs", () => {
    const claudeDefault = makeProfile({ id: "c1", agent: "claude-code", name: "官方账号" });
    const claudeIso = makeProfile({
      id: "c2",
      agent: "claude-code",
      name: "团队 Max",
      officialRef: { mode: "isolatedDir", localDirId: "acc-1" },
    });
    const gwA = makeProfile({
      id: "g1",
      agent: "claude-code",
      name: "智谱 A",
      accountType: "api",
      hasKey: true,
      gatewayId: "gw-1",
    });
    const gwB = makeProfile({
      id: "g2",
      agent: "claude-code",
      name: "智谱 B",
      accountType: "api",
      hasKey: true,
      gatewayId: "gw-2",
    });
    const agyA = makeProfile({
      id: "a1",
      agent: "agy",
      name: "主号",
      officialRef: { mode: "managedSnapshot", snapshotId: "sub-1" },
    });
    const agyB = makeProfile({
      id: "a2",
      agent: "agy",
      name: "备用号",
      officialRef: { mode: "managedSnapshot", snapshotId: "sub-2" },
    });

    assert.equal(needsRelayOnSameAgentSwitch(claudeDefault, claudeIso), true);
    assert.equal(needsRelayOnSameAgentSwitch(claudeIso, gwA), true);
    assert.equal(needsRelayOnSameAgentSwitch(agyA, agyB), true);
    // 普通同目录网关切换仍走原会话接回
    assert.equal(needsRelayOnSameAgentSwitch(gwA, gwB), false);
    assert.equal(needsRelayOnSameAgentSwitch(gwA, gwA), false);
  });

  it("detects quota exhaustion errors and picks least-used alternate official account first", () => {
    assert.equal(isQuotaExhaustedError("HTTP 429 Too Many Requests"), true);
    assert.equal(isQuotaExhaustedError("You have hit your usage limit"), true);
    assert.equal(isQuotaExhaustedError("当前账号额度已满"), true);
    assert.equal(isQuotaExhaustedError("connection reset by peer"), false);

    const c1 = makeProfile({ id: "c1", agent: "claude-code", name: "个人 Max" });
    const c2 = makeProfile({
      id: "c2",
      agent: "claude-code",
      name: "团队 Max",
      officialRef: { mode: "isolatedDir", localDirId: "acc-2" },
    });
    const c3 = makeProfile({
      id: "c3",
      agent: "claude-code",
      name: "备用 Pro",
      officialRef: { mode: "isolatedDir", localDirId: "acc-3" },
    });
    const gw = makeProfile({
      id: "gw",
      agent: "claude-code",
      name: "中转网关",
      accountType: "api",
      hasKey: true,
      gatewayId: "gw-1",
    });

    const rows: PlanQuotaDto[] = [
      makeQuota({
        gatewayId: "official:claude-code",
        bindingId: "c1",
        provider: "claude",
        windows: [{ window: "five_hour", usedPercent: 100, resetsAt: null, used: null, total: null }],
      }),
      makeQuota({
        gatewayId: "official:claude-code:c2",
        bindingId: "c2",
        provider: "claude",
        windows: [{ window: "five_hour", usedPercent: 100, resetsAt: null, used: null, total: null }],
      }),
      makeQuota({
        gatewayId: "official:claude-code:c3",
        bindingId: "c3",
        provider: "claude",
        windows: [{ window: "five_hour", usedPercent: 25, resetsAt: null, used: null, total: null }],
      }),
    ];

    assert.equal(isPlanRowExhausted(rows[0]), true);
    assert.equal(isPlanRowExhausted(rows[2]), false);

    // c2 也满了，自动跳过 c2，选中 c3（25%）而非网关
    const pick = pickAlternateAccountForLimit(c1, [c1, c2, c3, gw], rows);
    assert.equal(pick?.profile.id, "c3");
    assert.equal(pick?.usedPct, 25);

    // 若 c3 被隐藏，则退而选中可用网关
    const fallback = pickAlternateAccountForLimit(c1, [c1, c2, c3, gw], rows, ["c3"]);
    assert.equal(fallback?.profile.id, "gw");
  });

  it("filters and orders quota display prefs while never hiding all items", () => {
    const items = [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
    ];
    let prefs = moveQuotaOrder(EMPTY_QUOTA_PREFS, ["a", "b", "c"], "c", -1);
    assert.deepEqual(
      applyQuotaDisplayPrefs(items, (x) => x.id, prefs).map((x) => x.id),
      ["a", "c", "b"],
    );

    prefs = toggleQuotaHidden(prefs, "a");
    assert.deepEqual(
      applyQuotaDisplayPrefs(items, (x) => x.id, prefs).map((x) => x.id),
      ["c", "b"],
    );

    // 全部隐藏时防呆保留全部，避免卡片空白
    prefs = toggleQuotaHidden(toggleQuotaHidden(prefs, "b"), "c");
    assert.deepEqual(
      applyQuotaDisplayPrefs(items, (x) => x.id, prefs).map((x) => x.id),
      ["a", "c", "b"],
    );
  });
});
