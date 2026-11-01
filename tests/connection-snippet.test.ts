import test from "node:test";
import assert from "node:assert/strict";
import { applyFieldsToForm, fieldsFromForm, gatewayOwnedChanges, snippetFileTag, linesToMap, mapToLines, type SnippetFormSlice } from "../src/connection-snippet.ts";

const form = (over: Partial<SnippetFormSlice> = {}): SnippetFormSlice => ({
  name: "Zeta",
  accountType: "api",
  noAuth: false,
  protocol: null,
  apiBackend: null,
  baseUrl: " https://api.zetatechs.com/v1 ",
  models: ["a", " b ", "a", ""],
  roleModels: {},
  extraEnvText: "HTTPS_PROXY=http://x\n# 注释\n",
  requestPolicy: { temperature: 0.3, topP: null, maxOutputTokens: 8192, reasoningEffort: "high", headerEnv: {} },
  apiKey: "",
  ...over,
});

test("名=值 行与对象互转", () => {
  assert.deepEqual(linesToMap("A=1\n\n# c\nB = x=y\nbad"), { A: "1", B: "x=y" });
  assert.equal(mapToLines({ A: "1", B: "2" }), "A=1\nB=2");
});

test("表单 → 片段字段：名单去重去空、地址去空白、密钥只给尾号", () => {
  const f = fieldsFromForm(form(), "X-Tenant=TENANT", "TKsD");
  assert.deepEqual(f.models, ["a", "b"]);
  assert.equal(f.baseUrl, "https://api.zetatechs.com/v1");
  assert.equal(f.keyHint, "TKsD");
  assert.deepEqual(f.headerEnv, { "X-Tenant": "TENANT" });
  assert.deepEqual(f.extraEnv, { HTTPS_PROXY: "http://x" });
  assert.equal(f.roleModels, null, "没设分工不带");
  assert.equal(fieldsFromForm(form({ apiKey: "sk-typed" }), "", "TKsD").keyHint, "新填，保存后生效");
  assert.equal(fieldsFromForm(form({ accountType: "official" }), "", null).baseUrl, "");
});

test("片段字段 → 表单：没填新密钥保留表单里的；名字留空不改名", () => {
  const base = form({ apiKey: "sk-typed" });
  const fields = { ...fieldsFromForm(base, "", "TKsD"), name: "", models: ["b", "a"], newKey: null, temperature: null };
  const { form: next, headerEnvText } = applyFieldsToForm(base, fields);
  assert.equal(next.name, "Zeta");
  assert.equal(next.apiKey, "sk-typed");
  assert.deepEqual(next.models, ["b", "a"]);
  assert.equal(next.requestPolicy.temperature, null);
  assert.equal(headerEnvText, "");
  const withKey = applyFieldsToForm(base, { ...fields, newKey: "sk-new" }).form;
  assert.equal(withKey.apiKey, "sk-new");
});

test("网关管的字段改了要拦：地址、密钥、请求参数", () => {
  const before = fieldsFromForm(form(), "", "TKsD");
  assert.deepEqual(gatewayOwnedChanges(before, { ...before, models: ["b"], name: "新名" }), [], "名单、名字是连接自己的");
  assert.deepEqual(
    gatewayOwnedChanges(before, { ...before, baseUrl: "https://x", newKey: "sk-n", temperature: 0.9, reasoningEffort: "low" }),
    ["地址", "密钥", "温度", "思考档"],
  );
});

test("打开文件定位：各家主配置文件，Cursor 不给入口", () => {
  assert.equal(snippetFileTag("codex"), "config.toml");
  assert.equal(snippetFileTag("claude-code"), "settings.json");
  assert.equal(snippetFileTag("opencode"), "opencode.json");
  assert.equal(snippetFileTag("cursor"), null);
});
