import assert from "node:assert/strict";
import test from "node:test";
import {
  isAdoptedMcp,
  mcpCheckAtLabel,
  mcpCmdPathBadge,
  mcpDeleteImpact,
  mcpDistBadge,
  mcpHealthLabel,
  mcpHealthNeedsLogin,
  mcpHealthText,
  mcpOriginLabel,
  mcpPathResolveNote,
  missingEnvSignature,
  missingEnvWarnText,
  mcpEnvRefNames,
  mcpSecretFieldLabel,
  mcpSecretPlaceholder,
  shortenCommand,
  shortenPathToken,
} from "../src/mcp-display.ts";

test("家目录前缀三形态折叠为 ~", () => {
  assert.equal(shortenPathToken("/Users/alice/bin/tool"), "~/bin/tool");
  assert.equal(shortenPathToken("/home/bob/bin/tool"), "~/bin/tool");
  assert.equal(
    shortenPathToken("C:\\Users\\carol\\AppData\\tool.exe"),
    "~/AppData/tool.exe",
  );
});

test("超过 3 段砍中段留首尾，3 段以内原样", () => {
  assert.equal(
    shortenPathToken(
      "/Users/alice/Library/Application Support/SkyComputerUseClient",
    ),
    "~/…/SkyComputerUseClient",
  );
  assert.equal(shortenPathToken("/opt/homebrew/bin/node"), "/opt/homebrew/bin/node");
  assert.equal(
    shortenPathToken("/very/long/path/with/many/segments/tool"),
    "/very/…/tool",
  );
});

test("非路径 token 与 URL 原样保留", () => {
  assert.equal(shortenPathToken("npx"), "npx");
  assert.equal(shortenPathToken("--port"), "--port");
  assert.equal(shortenPathToken("https://api.example.com/v1"), "https://api.example.com/v1");
});

test("shortenCommand 逐 token 缩略后拼接，短路径原样", () => {
  assert.equal(
    shortenCommand("/Users/alice/.bun/bin/bun", [
      "x",
      "/Users/alice/Library/Application Support/SkyComputerUseClient/index.js",
      "--stdio",
    ]),
    "~/.bun/bin/bun x ~/…/index.js --stdio",
  );
});

test("行内异常短语：需登录 / 连不上，正常与未检测不写", () => {
  const base = { latencyMs: 30, detail: null };
  assert.equal(mcpHealthLabel(undefined), null);
  assert.equal(mcpHealthLabel("checking"), null);
  assert.equal(mcpHealthLabel({ ...base, ok: true, error: null }), null);
  assert.deepEqual(
    mcpHealthLabel({ ...base, ok: false, error: "需要 OAuth 登录（HTTP 401 Unauthorized）", status: "auth" }),
    { text: "需登录", tone: "warn" },
  );
  assert.deepEqual(
    mcpHealthLabel({ ...base, ok: false, error: "连接超时" }),
    { text: "连不上", tone: "err" },
  );
});

const AGENTS_FIXTURE = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "kimi", label: "Kimi Code" },
] as const;

test("收编判定：仅 ccode 算自建，收编/粘贴/旧数据空串都按收编对待", () => {
  assert.equal(isAdoptedMcp("ccode"), false);
  assert.equal(isAdoptedMcp("imported:codex"), true);
  assert.equal(isAdoptedMcp("imported:json"), true);
  assert.equal(isAdoptedMcp(""), true); // 旧数据来源未知：宁可少删不可错删
});

test("删除影响面：取 apps 为 true 的 agent 显示名，按 agents 表序", () => {
  assert.deepEqual(
    mcpDeleteImpact(
      { codex: true, kimi: false, "claude-code": true },
      AGENTS_FIXTURE,
    ),
    ["Claude Code", "Codex"],
  );
  assert.deepEqual(mcpDeleteImpact({}, AGENTS_FIXTURE), []);
  assert.deepEqual(
    mcpDeleteImpact({ unknown: true }, AGENTS_FIXTURE),
    [],
    "未知 agent id 不进影响面（显示名无处查）",
  );
});

test("收编来源展示名：agent 名 / 粘贴 JSON / 未知来源", () => {
  assert.equal(mcpOriginLabel("imported:codex", AGENTS_FIXTURE), "Codex");
  assert.equal(
    mcpOriginLabel("imported:grok", AGENTS_FIXTURE),
    "grok",
    "agents 表查不到时回退原始 id",
  );
  assert.equal(mcpOriginLabel("imported:json", AGENTS_FIXTURE), "粘贴的 JSON");
  assert.equal(mcpOriginLabel("", AGENTS_FIXTURE), "未知来源");
  assert.equal(mcpOriginLabel("ccode", AGENTS_FIXTURE), "未知来源");
});

test("分发状态徽标：仅异常三态有徽标，文案说人话", () => {
  assert.equal(mcpDistBadge("ok"), null, "一致不标");
  assert.equal(mcpDistBadge("off"), null, "未分发不标");
  assert.equal(mcpDistBadge(undefined), null, "未探测不标");
  assert.equal(mcpDistBadge("bogus"), null, "未知值不标（防后端新增态炸前端）");
  const modified = mcpDistBadge("modified");
  assert.equal(modified?.label, "外部已修改");
  const missing = mcpDistBadge("missing");
  assert.equal(missing?.label, "外部已删除");
  assert.match(missing?.tip ?? "", /重新写入/, "missing 必须点明拨开=重写");
  const disabled = mcpDistBadge("disabled_externally");
  assert.equal(disabled?.label, "外部已禁用");
  assert.match(disabled?.tip ?? "", /清单不受影响/);
  // 三态识别色互不相同且与协议徽章同口径（color-mix 自适应主题）
  const hexes = [modified, missing, disabled].map((b) =>
    b?.color.match(/#[0-9a-f]{6}/i)?.[0],
  );
  assert.equal(new Set(hexes).size, 3);
  assert.match(missing?.background ?? "", /color-mix/);
});

test("体检时间标签：ISO → MM-DD HH:mm，认不出原样返回", () => {
  assert.equal(mcpCheckAtLabel("2026-09-03T08:05:11Z"), "09-03 08:05");
  assert.equal(mcpCheckAtLabel("不是时间"), "不是时间");
});

test("体检行文案：检测中 / 正常带耗时与 detail / 失败给原因 / 沉淀结果带时间前缀", () => {
  assert.equal(mcpHealthText(undefined), null, "未检测过不显示");
  assert.equal(mcpHealthText("checking"), "正在检测连通性…");
  const ok = mcpHealthText({
    ok: true,
    latencyMs: 123,
    error: null,
    detail: "fs@1.0",
    status: "handshake",
  });
  assert.equal(ok, "连通正常 · fs@1.0 · 123ms\n点击重新检测");
  // reachable 细分：地址可达但握手未确认，不说「连通正常」
  const reachable = mcpHealthText({
    ok: true,
    latencyMs: 45,
    error: null,
    detail: "HTTP 405",
    status: "reachable",
  });
  assert.match(reachable ?? "", /^地址可达，握手未确认 · HTTP 405 · 45ms/);
  // 认证失败 / 路径错误：ok=false，error 文案直出
  const auth = mcpHealthText({
    ok: false,
    latencyMs: 30,
    error: "认证失败（HTTP 401）：密钥未设置、未注入或被服务端拒绝",
    detail: null,
    status: "auth",
  });
  assert.match(auth ?? "", /认证失败/);
  const oauth = mcpHealthText({
    ok: false,
    latencyMs: 40,
    error:
      "需要 OAuth 登录（HTTP 401 Unauthorized）：在对应 CLI 执行 mcp login（Codex：codex mcp login <名>）",
    detail: null,
    status: "auth",
  });
  assert.equal(
    mcpHealthNeedsLogin({
      ok: false,
      latencyMs: 40,
      error: "需要 OAuth 登录（HTTP 401 Unauthorized）",
      detail: null,
      status: "auth",
    }),
    true,
  );
  assert.match(oauth ?? "", /不会代登/);
  assert.equal(
    mcpHealthNeedsLogin({
      ok: false,
      latencyMs: 30,
      error: "认证失败（HTTP 401）：密钥未设置、未注入或被服务端拒绝",
      detail: null,
      status: "auth",
    }),
    false,
  );
  const fail = mcpHealthText({
    ok: false,
    latencyMs: 8123,
    error: "8 秒未响应 initialize（超时）",
    detail: null,
    status: "error",
  });
  assert.match(fail ?? "", /8 秒未响应/);
  assert.match(fail ?? "", /点击重新检测/);
  // 沉淀结果没有 status 字段（lastCheck 不落它）：维持 ok/error 两层文案，不虚构细分
  const persisted = mcpHealthText(
    { ok: false, latencyMs: 8123, error: "超时", detail: null },
    "2026-09-03T08:05:11Z",
  );
  assert.match(persisted ?? "", /^上次检测（09-03 08:05）：/, "沉淀结果必须与实时结果可区分");
  const persistedOk = mcpHealthText(
    { ok: true, latencyMs: 50, error: null, detail: "HTTP 200 OK" },
    "2026-09-03T08:05:11Z",
  );
  assert.match(persistedOk ?? "", /连通正常 · HTTP 200 OK/, "无 status 时按原口径");
});

test("缺失变量签名：去重 + 排序，同组变量任意顺序同签名", () => {
  assert.equal(missingEnvSignature(["B", "A", "A"]), "A,B");
  assert.equal(missingEnvSignature(["A", "B"]), missingEnvSignature(["B", "A"]));
  assert.notEqual(missingEnvSignature(["A"]), missingEnvSignature(["A", "B"]));
});

test("缺失变量警告文案：列变量、讲原因、给选择，保存/分发两动作", () => {
  const save = missingEnvWarnText(["CONSENSUS_API_KEY"], "保存");
  assert.match(save, /CONSENSUS_API_KEY/);
  assert.match(save, /密钥栏/);
  assert.match(save, /仍要保存吗？/);
  const dist = missingEnvWarnText(["A", "B"], "分发");
  assert.match(dist, /A、B/);
  assert.match(dist, /仍要分发吗？/);
});

test("命令路径告警徽标：relative/missing 两异常态有徽标，ok 与未知值不标", () => {
  assert.equal(mcpCmdPathBadge("ok"), null, "正常态不标");
  assert.equal(mcpCmdPathBadge(undefined), null, "未探测不标");
  assert.equal(mcpCmdPathBadge("bogus"), null, "未知值不标（防后端新增态炸前端）");
  const rel = mcpCmdPathBadge("relative");
  assert.equal(rel?.label, "相对路径命令");
  assert.match(rel?.tip ?? "", /内嵌终端拉起会启动失败/, "悬浮必须讲后果");
  assert.match(rel?.tip ?? "", /修复为绝对路径/, "悬浮必须指出路");
  const miss = mcpCmdPathBadge("missing");
  assert.equal(miss?.label, "命令路径不存在");
  assert.match(miss?.tip ?? "", /版本升级|已卸载/, "missing 讲清高危成因");
  // 与分发异常态同口径的识别色体系，且 relative≠missing 色相
  assert.notEqual(rel?.color, miss?.color);
  assert.match(rel?.background ?? "", /color-mix/);
});

test("收编/导入解析附注：解析数与未解析数自由组合，全零不附注", () => {
  assert.equal(mcpPathResolveNote(0, 0), null);
  assert.equal(
    mcpPathResolveNote(1, 0),
    "其中 1 条的相对路径已解析为绝对路径",
  );
  assert.equal(
    mcpPathResolveNote(0, 2),
    "2 条的相对路径未能解析，请在列表里修复",
  );
  const both = mcpPathResolveNote(1, 1);
  assert.match(both ?? "", /已解析为绝对路径/);
  assert.match(both ?? "", /未能解析/);
});

test("MCP 引用名：Bearer 内嵌与整值，去重保序", () => {
  assert.deepEqual(
    mcpEnvRefNames([
      { value: "Bearer ${CONSENSUS_API_KEY}" },
      { value: "$FOO" },
      { value: "Bearer ${CONSENSUS_API_KEY}" },
    ]),
    ["CONSENSUS_API_KEY", "FOO"],
  );
  assert.deepEqual(mcpEnvRefNames([{ value: "plain" }]), []);
  assert.equal(mcpSecretFieldLabel("CONSENSUS_API_KEY"), "Consensus API 密钥");
  assert.equal(mcpSecretFieldLabel("MY_TOKEN"), "MY_TOKEN");
  assert.match(mcpSecretPlaceholder("···Y41"), /已保存 ···Y41/);
  assert.match(mcpSecretPlaceholder(), /粘贴密钥/);
});
