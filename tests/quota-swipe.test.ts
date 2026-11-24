import assert from "node:assert/strict";
import test from "node:test";
import { carouselDragOffset, mergePartialPlanRows, swipeFollowOffset } from "../src/quota-swipe.ts";
import type { PlanQuotaDto } from "../src/types.ts";

function makeRow(id: string, used: number, queriedAt = 100): PlanQuotaDto {
  return {
    gatewayId: id,
    gatewayName: id,
    provider: "codex",
    planLevel: "Plus",
    ok: true,
    error: null,
    windows: [{ window: "five_hour", usedPercent: used, resetsAt: null }],
    resetCardsSupported: false,
    resetCards: {
      ok: true,
      error: null,
      fiveHour: 0,
      weekly: 0,
      general: 0,
      generalApplicable: null,
      fiveHourExpiresAt: null,
      weeklyExpiresAt: null,
      generalExpiresAt: null,
      lastFiveHourResetAt: null,
      lastWeekResetAt: null,
    },
    queriedAt,
    fromCache: false,
    consoleUrl: "",
    bindingId: null,
    accountHint: null,
    isActiveSlot: null,
  };
}

test("swipeFollowOffset：可切方向按比例跟手并限幅，到头方向阻力更大", () => {
  assert.equal(swipeFollowOffset(20, true), 7);
  assert.equal(swipeFollowOffset(-20, true), -7);
  assert.equal(swipeFollowOffset(200, true), 28);
  assert.equal(swipeFollowOffset(-200, false), -10);
  assert.ok(Math.abs(swipeFollowOffset(20, false)) < Math.abs(swipeFollowOffset(20, true)));
});

test("carouselDragOffset：可切方向支持宽幅平滑拖拽，到头方向轻微橡皮筋阻尼", () => {
  assert.equal(carouselDragOffset(0, true, 400), 0);
  assert.ok(carouselDragOffset(-100, true, 400) < -60);
  assert.ok(Math.abs(carouselDragOffset(1000, true, 400)) <= 180);
  assert.ok(Math.abs(carouselDragOffset(-200, false, 400)) <= 22);
  assert.ok(Math.abs(carouselDragOffset(30, false, 400)) < Math.abs(carouselDragOffset(30, true, 400)));
});

test("mergePartialPlanRows：渐进结果原地刷新已缓存账号，不闪丢尚未返回的账号", () => {
  const cached = [makeRow("codex", 10, 1), makeRow("agy-1", 40, 1)];
  const merged = mergePartialPlanRows(cached, [makeRow("codex", 15, 2), makeRow("glm", 5, 2)]);
  assert.deepEqual(
    merged.map((r) => [r.gatewayId, r.windows[0].usedPercent]),
    [
      ["codex", 15],
      ["agy-1", 40],
      ["glm", 5],
    ],
  );
});
