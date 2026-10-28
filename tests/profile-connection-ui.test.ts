import assert from "node:assert/strict";
import test from "node:test";
import {
  canProbeProfile,
  duplicateNameIds,
  profileNeedsProbe,
  profileStatusCell,
  showCatalogSyncAction,
  unsyncedModels,
} from "../src/profile-connection-ui.ts";

test("模型不在目录只出一条：点名哪个模型、说清去编辑里改", () => {
  const base = {
    accountType: "api",
    connectionStatus: "model_unsynced",
    modelSyncStatus: "stale",
    modelSyncNote: "网关目录已标记历史失效：deepseek-v4-flash-0731",
  };
  const cell = profileStatusCell({ ...base, unsynced: ["deepseek-v4-flash-0731"] });
  assert.equal(cell?.text, "模型不在目录");
  assert.match(cell?.tip ?? "", /^deepseek-v4-flash-0731 已不在网关的模型目录里/);
  assert.match(cell?.tip ?? "", /打开编辑/);
  assert.equal(cell?.tone, "warn");
  // 调用方没算出名单时退回后端说明
  assert.match(profileStatusCell(base)?.tip ?? "", /^网关目录已标记历史失效/);
});

test("不在目录的模型：目录里没有或已标失效；目录没拉过不判", () => {
  const catalog = [
    { id: "glm-5.3", status: "available" },
    { id: "glm-5v-turbo", status: "stale" },
  ];
  assert.deepEqual(unsyncedModels(["glm-5.3", "glm-5v-turbo", "glm-x"], catalog), ["glm-5v-turbo", "glm-x"]);
  assert.deepEqual(unsyncedModels(["glm-x"], []), []);
  assert.deepEqual(unsyncedModels(["glm-x"], null), []);
});

test("状态列只说例外：未测试、状态未知、密钥已存都不常驻", () => {
  for (const connectionStatus of ["untested", "unknown", undefined]) {
    assert.equal(
      profileStatusCell({ accountType: "api", connectionStatus, hasKey: true }),
      null,
    );
  }
});

test("测过且通过才是绿色；失败与缺密钥各自着色", () => {
  assert.equal(profileStatusCell({ accountType: "api", connectionStatus: "ready" })?.tone, "ok");
  assert.equal(profileStatusCell({ accountType: "api", connectionStatus: "probe_failed" })?.tone, "err");
  assert.equal(
    profileStatusCell({ accountType: "api", connectionStatus: "credential_missing" })?.text,
    "缺密钥",
  );
  assert.equal(profileStatusCell({ accountType: "official", connectionStatus: "official" })?.tone, "muted");
});

test("未测试但绑定模型失效：状态列说模型问题", () => {
  const cell = profileStatusCell({
    accountType: "api",
    connectionStatus: "untested",
    modelSyncStatus: "missing",
  });
  assert.equal(cell?.text, "模型不在目录");
});

test("只有未测试、有网关、协议槽能体检的 API 连接给「测试」入口", () => {
  const base = { agent: "claude-code", accountType: "api", gatewayId: "g1" };
  assert.equal(profileNeedsProbe({ ...base, connectionStatus: "untested" }), true);
  assert.equal(profileNeedsProbe({ ...base, gatewayId: null, connectionStatus: "untested" }), false);
  assert.equal(profileNeedsProbe({ ...base, connectionStatus: "ready" }), false);
  assert.equal(profileNeedsProbe({ ...base, accountType: "official", connectionStatus: "untested" }), false);
  // Gemini / Cursor 槽后端不支持体检：行上不给测试，免得点了只报错
  assert.equal(profileNeedsProbe({ ...base, agent: "gemini", connectionStatus: "untested" }), false);
  assert.equal(canProbeProfile({ ...base, agent: "cursor" }), false);
  assert.equal(canProbeProfile({ ...base, agent: "kimi", protocol: "anthropic" }), true);
});

test("重名只在同一 agent 内算，忽略大小写与首尾空白", () => {
  const ids = duplicateNameIds([
    { id: "a", agent: "codex", name: "Test" },
    { id: "b", agent: "codex", name: " test " },
    { id: "c", agent: "claude-code", name: "Test" },
    { id: "d", agent: "codex", name: "GLM" },
  ]);
  assert.deepEqual([...ids].sort(), ["a", "b"]);
});

test("目录过期才显示同步目录；模型未同步不显示", () => {
  assert.equal(
    showCatalogSyncAction({
      accountType: "api",
      gatewayId: "g1",
      connectionStatus: "catalog_stale",
    }),
    true,
  );
  assert.equal(
    showCatalogSyncAction({
      accountType: "api",
      gatewayId: "g1",
      connectionStatus: "model_unsynced",
    }),
    false,
  );
  assert.equal(
    showCatalogSyncAction({
      accountType: "official",
      gatewayId: "g1",
      connectionStatus: "catalog_stale",
    }),
    false,
  );
});

test("自动起名：底名没被占用就用底名，占用了补首个模型", async () => {
  const { suggestConnectionName } = await import("../src/profile-connection-ui.ts");
  assert.equal(suggestConnectionName({ base: "GLM", firstModel: "glm-5.3", takenNames: [] }), "GLM");
  assert.equal(
    suggestConnectionName({ base: "Test", firstModel: "deepseek-v4", takenNames: [" test "] }),
    "Test · deepseek-v4",
  );
  // 还没选模型：照给底名，名称框下的重名提醒负责提示
  assert.equal(suggestConnectionName({ base: "Test", firstModel: null, takenNames: ["Test"] }), "Test");
  assert.equal(suggestConnectionName({ base: "  ", takenNames: [] }), "");
});
