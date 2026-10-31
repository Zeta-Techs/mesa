import assert from "node:assert/strict";
import { test } from "node:test";
import {
  planSwipeTarget,
  formatPlanTimestamp,
  formatQuotaPoints,
  formatResetCountdown,
  formatResetPoint,
  gatewayHasPlanQuota,
  planAbsoluteQuotaLine,
  planAbsoluteQuotaPair,
  planPrimaryWindowIndex,
  planProviderLabel,
  planGatewayNameVisible,
  planLevelLabel,
  planQuotaDataAt,
  planResetCardHighlight,
  planResetFootnote,
  planResetRemain,
  planTabLabel,
  planWindowCaption,
  planWindowLabel,
  planWindowsByTightness,
  planWindowUnused,
  quotaBarLevel,
  quotaTone,
  resetCardExpiryNote,
} from "../src/plan-quota.ts";

// 2026-09-19 12:00:00 本地（Asia/Shanghai）的毫秒值——测试统一用显式 now
const NOW = new Date(2026, 8, 19, 12, 0, 0).getTime();

test("供应商显示名与切换标签", () => {
  assert.equal(planProviderLabel("zhipu"), "智谱");
  assert.equal(planProviderLabel("kimi"), "Kimi");
  assert.equal(planProviderLabel("minimax"), "MiniMax");
  assert.equal(planProviderLabel("claude"), "Claude");
  assert.equal(planProviderLabel("codex"), "Codex");
  assert.equal(planProviderLabel("other-x"), "other-x");
  // 同供应商单网关：标签只有供应商名；多网关：追加网关名区分
  assert.equal(planTabLabel({ provider: "kimi", gatewayName: "Kimi 主力" }, 1), "Kimi");
  assert.equal(
    planTabLabel({ provider: "kimi", gatewayName: "Kimi 备用" }, 2),
    "Kimi · Kimi 备用",
  );
});

test("网关名与供应商同义时不显示（GLM 撞智谱徽章）", () => {
  assert.ok(!planGatewayNameVisible("GLM", "zhipu"));
  assert.ok(!planGatewayNameVisible("glm 2", "zhipu"));
  assert.ok(!planGatewayNameVisible("智谱", "zhipu"));
  assert.ok(!planGatewayNameVisible("Kimi", "kimi"));
  assert.ok(!planGatewayNameVisible("MiniMax", "minimax"));
  assert.ok(!planGatewayNameVisible(null, "zhipu"));
  // 有实际区分信息的名字保留
  assert.ok(planGatewayNameVisible("智谱备用", "zhipu"));
  assert.ok(planGatewayNameVisible("Zeta-22", "zhipu"));
  assert.ok(planGatewayNameVisible("公司号", "zhipu"));
  assert.ok(planGatewayNameVisible("Kimi 主力", "kimi"));
});

test("套餐等级精简（GLM 前缀与 Plan 后缀剥掉）", () => {
  assert.equal(planLevelLabel("GLM Coding Max"), "Max");
  assert.equal(planLevelLabel("GLM Coding Lite"), "Lite");
  assert.equal(planLevelLabel("MaxPlan"), "Max");
  assert.equal(planLevelLabel("glm coding pro"), "Pro");
  // 全小写等级首字母大写（智谱实测回 "max"）；已带大写/非纯字母的原样
  assert.equal(planLevelLabel("max"), "Max");
  assert.equal(planLevelLabel("air"), "Air");
  assert.equal(planLevelLabel("Max"), "Max");
  assert.equal(planLevelLabel("GLM-4"), "GLM-4");
  assert.equal(planLevelLabel(null), null);
  assert.equal(planLevelLabel("  "), null);
});

test("窗口名映射与未知值透传", () => {
  assert.equal(planWindowLabel("five_hour"), "5 小时");
  assert.equal(planWindowLabel("weekly"), "本周");
  assert.equal(planWindowLabel("monthly"), "本月");
  assert.equal(planWindowLabel("custom-x"), "custom-x");
});

test("重置时间点为官方风格的具体时刻（精确到秒）", () => {
  const sameDay = new Date(2026, 8, 19, 15, 30, 45).getTime();
  assert.equal(formatPlanTimestamp(sameDay, NOW), "15:30:45");
  const nextDay = new Date(2026, 8, 20, 8, 5, 0).getTime();
  assert.equal(formatPlanTimestamp(nextDay, NOW), "09-20 08:05:00");
  // 窗口重置主显示：具体时间点；倒计时留在悬停
  assert.equal(formatResetPoint(nextDay, NOW), "09-20 08:05:00 重置");
  assert.equal(formatResetPoint(null, NOW), null);
  assert.equal(formatResetCountdown(nextDay, NOW), "20 小时 5 分后重置");
  assert.equal(formatResetCountdown(NOW - 1, NOW), "已到重置时间");
});

test("进度分档边界", () => {
  assert.equal(quotaBarLevel(69.9), "ok");
  assert.equal(quotaBarLevel(70), "warn");
  assert.equal(quotaBarLevel(89.9), "warn");
  assert.equal(quotaBarLevel(90), "danger");
});

test("分档颜色：正常档不着色，只有警示/危急上语义色", () => {
  assert.equal(quotaTone(0).bar, "bg-cta");
  assert.equal(quotaTone(0).text, "text-l1");
  assert.equal(quotaTone(69.9).text, "text-l1");
  assert.equal(quotaTone(70).bar, "bg-warn-text");
  assert.equal(quotaTone(70).text, "text-warn-text");
  assert.equal(quotaTone(95).bar, "bg-err-text");
  assert.equal(quotaTone(95).text, "text-err-text");
});

test("窗口没用过 → 标黄劝退（注意：只劝，不禁用按钮；后端 use 不校验用量，点了真扣一张）", () => {
  const w = (window: string, usedPercent: number) => ({ window, usedPercent });
  // 本机实况：5 小时 0%（标黄劝退） / 周 100%（正常，不劝）
  assert.equal(planWindowUnused([w("five_hour", 0), w("weekly", 100)], "five_hour"), true);
  assert.equal(planWindowUnused([w("five_hour", 0), w("weekly", 100)], "weekly"), false);
  assert.equal(planWindowUnused([w("five_hour", 0.4)], "five_hour"), false);
  // 供应商没回这个窗：不标黄，不误报"没用过"
  assert.equal(planWindowUnused([w("five_hour", 0)], "weekly"), false);
  assert.equal(planWindowUnused([], "five_hour"), false);
});

test("主窗口挑最紧的那个（本机实测：5 小时 0% / 周 100% 必须锚周窗）", () => {
  const w = (window: string, usedPercent: number) => ({ window, usedPercent });
  // 后端恒按 5 小时 → 周输出；本机实况：周窗爆掉、5h 全新
  assert.equal(
    planPrimaryWindowIndex([w("five_hour", 0), w("weekly", 100)]),
    1,
  );
  assert.equal(planPrimaryWindowIndex([w("five_hour", 91), w("weekly", 42)]), 0);
  // 并列不换人（稳版面）：靠前的 5 小时留着
  assert.equal(planPrimaryWindowIndex([w("five_hour", 50), w("weekly", 50)]), 0);
  // 单窗与三窗
  assert.equal(planPrimaryWindowIndex([w("five_hour", 12)]), 0);
  assert.equal(
    planPrimaryWindowIndex([w("five_hour", 10), w("weekly", 20), w("monthly", 30)]),
    2,
  );
  // 空数组不给 0（调用方必须判，防越界取 undefined 当窗口渲染）
  assert.equal(planPrimaryWindowIndex([]), -1);
  assert.equal(planWindowCaption("five_hour"), "5 小时已用");
  assert.equal(planWindowCaption("weekly"), "本周已用");
  assert.equal(planWindowCaption("monthly"), "本月已用");
});

test("双窗同构：最紧的排第一，其余保持原序", () => {
  const w = (window: string, usedPercent: number) => ({ window, usedPercent });
  const rows = [w("five_hour", 0), w("weekly", 100)];
  assert.deepEqual(
    planWindowsByTightness(rows).map((x) => x.window),
    ["weekly", "five_hour"],
  );
  // 已经最紧的不用挪
  assert.deepEqual(
    planWindowsByTightness([w("five_hour", 91), w("weekly", 42)]).map((x) => x.window),
    ["five_hour", "weekly"],
  );
  assert.deepEqual(planWindowsByTightness([]), []);
});

test("重置卡只高亮最紧且危急的那张，不禁用另一张", () => {
  const w = (window: string, usedPercent: number) => ({ window, usedPercent });
  const tight = [w("five_hour", 0), w("weekly", 100)];
  assert.equal(planResetCardHighlight(tight, "weekly"), true);
  assert.equal(planResetCardHighlight(tight, "five_hour"), false);
  // 都没到危急档：不高亮
  assert.equal(
    planResetCardHighlight([w("five_hour", 40), w("weekly", 60)], "weekly"),
    false,
  );
  // 5 小时 95% 更紧：高亮 5 小时
  assert.equal(
    planResetCardHighlight([w("five_hour", 95), w("weekly", 80)], "five_hour"),
    true,
  );
  assert.equal(
    planResetCardHighlight([w("five_hour", 95), w("weekly", 80)], "weekly"),
    false,
  );
});

test("配额点数格式化：千分位手写（不依赖 locale），小数留一位", () => {
  assert.equal(formatQuotaPoints(0), "0");
  assert.equal(formatQuotaPoints(80), "80");
  assert.equal(formatQuotaPoints(28000), "28,000");
  assert.equal(formatQuotaPoints(140023), "140,023");
  assert.equal(formatQuotaPoints(1234567), "1,234,567");
  assert.equal(formatQuotaPoints(12.5), "12.5");
  assert.equal(formatQuotaPoints(1234.56), "1,234.6");
  assert.equal(formatQuotaPoints(Number.NaN), "—");
});

test("绝对值行：只给百分比（或只给总量）不摆半截数", () => {
  assert.equal(planAbsoluteQuotaPair(80000, 140000), "80,000 / 140,000");
  assert.equal(planAbsoluteQuotaLine(0, 28000), "已用 0 / 28,000");
  assert.equal(planAbsoluteQuotaLine(null, 28000), null);
  assert.equal(planAbsoluteQuotaLine(5, null), null);
  assert.equal(planAbsoluteQuotaLine(null, null), null);
  // 超发在卡面封顶，避免 140,023 / 140,000 看起来像坏了
  assert.equal(planAbsoluteQuotaPair(140023, 140000), "140,000 / 140,000");
  assert.equal(planAbsoluteQuotaLine(140023, 140000), "已用 140,000 / 140,000");
});

test("重置脚注：时间点 + 倒计时同屏（不再只藏在悬停）", () => {
  const in20h = new Date(2026, 8, 20, 8, 5, 0).getTime();
  assert.equal(
    planResetFootnote(in20h, NOW),
    "09-20 08:05:00 重置（还有 20 小时 5 分）",
  );
  const in6d = new Date(2026, 8, 26, 15, 0, 0).getTime();
  assert.equal(
    planResetFootnote(in6d, NOW),
    "09-26 15:00:00 重置（还有 7 天 3 小时）",
  );
  // 已过时间点不带括号（避免「…重置（已到重置时间）」这种同义重复）
  assert.equal(planResetFootnote(NOW - 1, NOW), "11:59:59 重置");
  assert.equal(planResetFootnote(null, NOW), null);
});

test("卡面倒计时只写还剩多久，时刻放悬停", () => {
  const in20h = new Date(2026, 8, 20, 8, 5, 0).getTime();
  assert.equal(planResetRemain(in20h, NOW), "还有 20 小时 5 分");
  const in6d = new Date(2026, 8, 26, 15, 0, 0).getTime();
  assert.equal(planResetRemain(in6d, NOW), "还有 7 天 3 小时");
  assert.equal(planResetRemain(NOW - 1, NOW), "已到重置时间");
  assert.equal(planResetRemain(null, NOW), null);
});

test("重置卡期限附注：卡面只写日期，时刻放悬停", () => {
  const day = 86_400_000;
  const far = resetCardExpiryNote(NOW + 27 * day, NOW);
  assert.equal(far?.text, "有效期至 10-16 · 剩 27 天");
  assert.equal(far?.urgent, false);
  assert.match(far?.title ?? "", /10-16 12:00:00/);
  const soon = resetCardExpiryNote(NOW + 3 * day, NOW);
  assert.equal(soon?.urgent, true);
  assert.match(soon?.text ?? "", /剩 3 天$/);
  const past = resetCardExpiryNote(NOW - 1, NOW);
  assert.equal(past?.urgent, true);
  assert.match(past?.text ?? "", /已到期$/);
  assert.equal(resetCardExpiryNote(null, NOW), null);
});

test("骨架占位判定与后端探测同口径", () => {
  const gw = (url: string) => ({ slots: { anthropic: url } });
  assert.ok(gatewayHasPlanQuota(gw("https://open.bigmodel.cn/api/anthropic")));
  assert.ok(gatewayHasPlanQuota(gw("https://api.z.ai/api/paas/v4")));
  assert.ok(gatewayHasPlanQuota(gw("https://api.kimi.com/coding")));
  assert.ok(gatewayHasPlanQuota(gw("https://api.minimaxi.com/api/paas/v4")));
  assert.ok(gatewayHasPlanQuota({ slots: { openai: "https://api.minimax.io/v1" } }));
  assert.ok(gatewayHasPlanQuota(gw("https://api.minimax.cn/anthropic")));
  assert.ok(gatewayHasPlanQuota(gw("https://api.kimi.ai/coding/v1")));
  // 普通按量付费端点不命中
  assert.ok(!gatewayHasPlanQuota(gw("https://api.deepseek.com/v1")));
  assert.ok(!gatewayHasPlanQuota(gw("https://api.moonshot.cn/v1")));
  assert.ok(!gatewayHasPlanQuota({ slots: null }));
});

test("缓存数据标注", () => {
  assert.equal(planQuotaDataAt(NOW, false), null);
  assert.equal(planQuotaDataAt(NOW - 3600_000, true), "数据截至 11:00");
});

test("收起态滑动切换：前后各一家，到头不回绕", () => {
  const ids = ["g1", "official:claude-code", "official:codex"];
  assert.equal(planSwipeTarget(ids, "g1", 1), "official:claude-code");
  assert.equal(planSwipeTarget(ids, "official:codex", 1), "official:codex");
  assert.equal(planSwipeTarget(ids, "g1", -1), "g1");
  assert.equal(planSwipeTarget(ids, null, 1), "official:claude-code");
  assert.equal(planSwipeTarget(ids, "gone", 1), "official:claude-code");
  assert.equal(planSwipeTarget([], null, 1), null);
});
