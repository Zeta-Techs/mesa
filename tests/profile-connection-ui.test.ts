import assert from "node:assert/strict";
import test from "node:test";
import {
  agentConflictState,
  canProbeProfile,
  duplicateNameIds,
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

test("测试通过与官方账号不常驻；失败与缺密钥各自着色", () => {
  assert.equal(profileStatusCell({ accountType: "api", connectionStatus: "ready", keyHint: "ab12" }), null);
  assert.equal(profileStatusCell({ accountType: "api", connectionStatus: "probe_failed" })?.tone, "err");
  assert.equal(
    profileStatusCell({ accountType: "api", connectionStatus: "credential_missing" })?.text,
    "缺密钥",
  );
  assert.equal(profileStatusCell({ accountType: "official", connectionStatus: "official" }), null);
});

test("未测试但绑定模型失效：状态列说模型问题", () => {
  const cell = profileStatusCell({
    accountType: "api",
    connectionStatus: "untested",
    modelSyncStatus: "missing",
  });
  assert.equal(cell?.text, "模型不在目录");
});

test("有网关、协议槽能体检的 API 连接给「测试」入口（测过的也给，用来重测）", () => {
  const base = { agent: "claude-code", accountType: "api", gatewayId: "g1" };
  assert.equal(canProbeProfile(base), true);
  assert.equal(canProbeProfile({ ...base, gatewayId: null }), false);
  assert.equal(canProbeProfile({ ...base, accountType: "official" }), false);
  // Gemini / Cursor 槽后端不支持体检：行上不给测试，免得点了只报错
  assert.equal(canProbeProfile({ ...base, agent: "gemini" }), false);
  assert.equal(canProbeProfile({ ...base, agent: "cursor" }), false);
  assert.equal(canProbeProfile({ ...base, agent: "kimi", protocol: "anthropic" }), true);
});

test("重名只在同一 Agent 内算，忽略大小写与首尾空白", () => {
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

test("附加环境变量里像密钥的键：值非空才算，注释和空行跳过", async () => {
  const { secretLikeEnvKeys } = await import("../src/profile-connection-ui.ts");
  assert.deepEqual(
    secretLikeEnvKeys("HTTPS_PROXY=http://x\nOPENAI_API_KEY=sk-1\n# MY_TOKEN=x\nEMPTY_SECRET=\nX_AUTH_HEADER=abc"),
    ["OPENAI_API_KEY", "X_AUTH_HEADER"],
  );
});

test("连接冲突分档：未添加默认目录官方号时不报冲突（仅隔离目录官方号同样不报）", () => {
  const conflicts = ["~/.codebuddy/settings.json 中存在 CODEBUDDY_API_KEY"];
  assert.equal(
    agentConflictState({
      agentId: "codebuddy",
      conflicts,
      profiles: [{ id: "api-1", accountType: "api", name: "智谱 GLM" }],
      activeGlobalProfileId: "api-1",
    }),
    null,
  );
  assert.equal(
    agentConflictState({
      agentId: "claude-code",
      conflicts: ["~/.claude/settings.json 中存在 ANTHROPIC_AUTH_TOKEN"],
      profiles: [
        { id: "iso-1", accountType: "official", name: "工作号", officialRef: { mode: "isolatedDir" } },
      ],
      activeGlobalProfileId: null,
    }),
    null,
  );
});

test("连接冲突分档：API 已设为全局时，进程级可覆盖三家静默，盖不过的几家归为 mesa_global_api", () => {
  const profiles = [
    { id: "off-1", accountType: "official", name: "官方账号" },
    { id: "api-1", accountType: "api", name: "智谱 GLM" },
  ];
  // CodeBuddy / Claude Code / Qwen：进程级盖过磁盘，API 设为全局本身就是用户意图
  for (const agentId of ["codebuddy", "claude-code", "qwen"]) {
    assert.equal(
      agentConflictState({
        agentId,
        conflicts: ["settings.json 中存在 API_KEY"],
        profiles,
        activeGlobalProfileId: "api-1",
      }),
      null,
    );
  }
  // Gemini / Grok：进程级盖不过，Mesa 内启动官方会被拦，归为 mesa_global_api 并带出连接名
  const gemini = agentConflictState({
    agentId: "gemini",
    conflicts: ["~/.gemini/.env 中存在 GEMINI_API_KEY"],
    profiles,
    activeGlobalProfileId: "api-1",
  });
  assert.equal(gemini?.kind, "mesa_global_api");
  assert.equal(gemini?.mesaOverridesOfficial, false);
  assert.equal(gemini?.officialProfileId, "off-1");
  assert.equal(gemini?.activeGlobalApiName, "智谱 GLM");
});

test("连接冲突分档：非 API 全局时的外部残留照常报 residual，且尊重忽略签名", () => {
  const profiles = [
    { id: "off-1", accountType: "official", name: "官方账号" },
    { id: "api-1", accountType: "api", name: "智谱 GLM" },
  ];
  const c1 = ["~/.codebuddy/settings.json 中存在 CODEBUDDY_BASE_URL", "~/.codebuddy/settings.json 中存在 CODEBUDDY_API_KEY"];
  const res = agentConflictState({
    agentId: "codebuddy",
    conflicts: c1,
    profiles,
    activeGlobalProfileId: null,
  });
  assert.equal(res?.kind, "residual");
  assert.equal(res?.mesaOverridesOfficial, true);
  assert.equal(res?.officialProfileId, "off-1");
  assert.equal(res?.activeGlobalApiName, null);

  // 忽略签名命中时隐藏，残留项增减后自动复现
  assert.equal(
    agentConflictState({
      agentId: "codebuddy",
      conflicts: c1,
      dismissedSignature: res?.signature,
      profiles,
      activeGlobalProfileId: "off-1",
    }),
    null,
  );
  assert.equal(
    agentConflictState({
      agentId: "codebuddy",
      conflicts: [c1[0]],
      dismissedSignature: res?.signature,
      profiles,
      activeGlobalProfileId: "off-1",
    })?.kind,
    "residual",
  );

  // Antigravity 托管快照官方号属于默认配置作用域，仍检外部残留
  const agy = agentConflictState({
    agentId: "agy",
    conflicts: ["~/.gemini/antigravity-cli/settings.json 中存在 modelProvider"],
    profiles: [{ id: "agy-1", accountType: "official", name: "Google 主号", officialRef: { mode: "managedSnapshot" } }],
    activeGlobalProfileId: null,
  });
  assert.equal(agy?.kind, "residual");
  assert.equal(agy?.officialProfileId, "agy-1");
});
