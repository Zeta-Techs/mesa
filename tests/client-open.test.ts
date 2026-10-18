import assert from "node:assert/strict";
import test from "node:test";
import {
  afterOpenHint,
  dialogTitle,
  needsDialog,
  openButtonLabel,
  primaryAction,
  sessionTarget,
  sortChecks,
  type HandoffPlanDto,
} from "../src/client-open.ts";

function plan(over: Partial<HandoffPlanDto> = {}): HandoffPlanDto {
  return {
    clientId: "codex-desktop",
    display: "Codex 客户端",
    level: "session",
    verdict: "ready",
    checks: [],
    fix: null,
    downloadUrl: null,
    ...over,
  };
}

test("全部通过才免弹层直接打开", () => {
  assert.equal(needsDialog(plan()), false);
  assert.equal(
    needsDialog(plan({ checks: [{ id: "provider_ok", status: "ok", text: "ok" }] })),
    false,
  );
  for (const status of ["note", "warn", "fix", "block"] as const) {
    assert.equal(
      needsDialog(plan({ checks: [{ id: "x", status, text: "t" }] })),
      true,
      status,
    );
  }
  assert.equal(needsDialog(plan({ verdict: "blocked" })), true);
});

test("检查项按严重度排序，同级保持后端顺序", () => {
  const sorted = sortChecks([
    { id: "a", status: "ok", text: "" },
    { id: "b", status: "warn", text: "" },
    { id: "c", status: "block", text: "" },
    { id: "d", status: "warn", text: "" },
    { id: "e", status: "fix", text: "" },
    { id: "f", status: "note", text: "" },
  ]);
  assert.deepEqual(
    sorted.map((c) => c.id),
    ["c", "e", "b", "d", "f", "a"],
  );
});

test("主按钮：拦截没有、修复写明写盘、警告才叫仍然打开", () => {
  assert.equal(primaryAction(plan({ verdict: "blocked" })).enabled, false);
  assert.equal(primaryAction(plan({ verdict: "needsFix" })).label, "写入并打开");
  assert.equal(
    primaryAction(plan({ checks: [{ id: "w", status: "warn", text: "" }] })).label,
    "仍然打开",
  );
  assert.equal(
    primaryAction(plan({ checks: [{ id: "n", status: "note", text: "" }] })).label,
    "打开",
  );
});

test("项目级文案写明只开项目，会话级不带项目二字", () => {
  const c = { display: "Claude 桌面版" };
  assert.equal(openButtonLabel(c, "session"), "在 Claude 桌面版打开");
  assert.equal(openButtonLabel(c, "project"), "在 Claude 桌面版打开项目");
  assert.equal(dialogTitle(plan({ level: "project" })), "在 Codex 客户端打开项目");
  assert.equal(dialogTitle(plan()), "在 Codex 客户端打开这条对话");
});

test("会话目标把缺省字段规整为 null", () => {
  const t = sessionTarget({ agent: "codex", sessionId: "abc" }, true);
  assert.deepEqual(t, {
    kind: "session",
    agent: "codex",
    sessionId: "abc",
    filePath: null,
    provider: null,
    profileId: null,
    liveInMesa: true,
  });
});

test("打开后的固定提醒点明客户端侧失败 Mesa 看不到", () => {
  assert.match(afterOpenHint("Claude 桌面版"), /Claude 桌面版.*Mesa 看不到/);
});
