import assert from "node:assert/strict";
import test from "node:test";
import {
  contrastRows,
  memberNames,
  memberOptions,
  mentionedNames,
  pickDefaultMembers,
  round1Messages,
  round1Revealed,
  sameFamilies,
  shortModel,
  streamMessages,
  toProjectRel,
  type ConsultMessage,
  type ConsultRecord,
  type MemberOption,
} from "../src/consult.ts";
import type { ReviewerProfile } from "../src/cross-review.ts";

const prof = (id: string, agent: string, models: string[], lastUsedAt: string | null = null): ReviewerProfile => ({
  id,
  agent,
  name: id,
  models,
  lastUsedAt,
  accountType: "api",
});

test("候选：能看项目按 CLI 外壳定，与接的模型无关", () => {
  const opts = memberOptions(
    [prof("cc", "claude-code", ["claude-opus-5-5", "glm-5.3"]), prof("gem", "gemini", ["gemini-3.8-flash"])],
    [],
  );
  const glm = opts.find((o) => o.model === "glm-5.3")!;
  assert.equal(glm.canRead, true, "Claude Code 外壳接 GLM 也能看项目");
  assert.equal(glm.family, "zhipu");
  assert.equal(opts.find((o) => o.agentId === "gemini")!.canRead, false);
});

const opt = (key: string, family: string | null, canRead: boolean, tier: 1 | 2 = 1, model = key): MemberOption => ({
  key,
  agentId: canRead ? "claude-code" : "gemini",
  profileId: key,
  profileName: key,
  model,
  family,
  tier,
  canRead,
});

test("默认挑法：先保证模型族不同，同族里优先能看项目的；不拿同族的凑数", () => {
  const options = [
    opt("sonnet", "anthropic", true),
    opt("gem", "gemini", false),
    opt("gem-cc", "gemini", true),
    opt("opus", "anthropic", true),
    opt("gpt", "openai", true),
    opt("odd", null, true),
  ];
  const picked = pickDefaultMembers(options, "opus").map((o) => o.key);
  assert.deepEqual(picked, ["opus", "gem-cc", "gpt"]);
  // 只有一族时只挑一位，不补同族
  assert.deepEqual(pickDefaultMembers([opt("a", "anthropic", true), opt("b", "anthropic", true)], null).map((o) => o.key), ["a"]);
  // 第一位找不到时照常按规则挑
  assert.equal(pickDefaultMembers(options, "gone")[0].key, "sonnet");
});

test("成员名按模型族，同族加短模型名", () => {
  assert.deepEqual(
    memberNames([
      { family: "anthropic", model: "claude-opus-5-5", profileName: "a" },
      { family: "anthropic", model: "claude-sonnet-5-5", profileName: "b" },
      { family: "kimi", model: "kimi-k2.6", profileName: "c" },
      { family: null, model: "x", profileName: "我的中转" },
    ]),
    ["Claude·Opus", "Claude·Sonnet", "Kimi", "我的中转"],
  );
  assert.deepEqual(
    memberNames([
      { family: "openai", model: "gpt-6.1", profileName: "a" },
      { family: "openai", model: "gpt-6.1", profileName: "b" },
    ]),
    ["GPT·gpt-6.1 1", "GPT·gpt-6.1 2"],
  );
  assert.equal(shortModel(""), "默认");
  assert.deepEqual([...sameFamilies([{ family: "openai" }, { family: "openai" }, { family: null }])], ["openai"]);
});

const m = (over: Partial<ConsultMessage>): ConsultMessage => ({
  id: "x",
  at: "",
  role: "member",
  member: "m1",
  phase: "r1",
  round: 0,
  text: "",
  conclusion: null,
  refs: [],
  unsure: null,
  pass: false,
  status: "ok",
  error: null,
  mentions: [],
  costUsd: null,
  durationMs: null,
  ...over,
});

const record = (messages: ConsultMessage[]): ConsultRecord => ({
  meta: {
    id: "c",
    title: "t",
    titleSource: "auto",
    createdAt: "",
    question: "q",
    materials: [],
    members: [
      { id: "m1", name: "Claude", family: "anthropic", agent: "claude-code", profileId: "a", model: "", canReadProject: true },
      { id: "m2", name: "GPT", family: "openai", agent: "codex", profileId: "b", model: "", canReadProject: true },
      { id: "m3", name: "Kimi", family: "kimi", agent: "kimi", profileId: "c", model: "", canReadProject: false },
    ],
    crossRounds: 1,
    relayLimit: 2,
  },
  messages,
});

test("对照条：原话照搬，改判才给新结论，交叉 PASS 记没补充，依据问题计数", () => {
  const rec = record([
    m({ id: "a", member: "m2", conclusion: "保留亚组", refs: [{ raw: "", path: "x", loc: "", state: "missing" }] }),
    m({ id: "b", member: "m1", conclusion: "平台站不住" }),
    m({ id: "c", member: "m3", status: "timeout" }),
    m({ id: "d", member: "m2", phase: "cross", round: 1, conclusion: "只放地区" }),
    m({ id: "e", member: "m1", phase: "cross", round: 1, pass: true }),
  ]);
  const rows = contrastRows(rec);
  assert.deepEqual(rows.map((r) => r.member.name), ["Claude", "GPT", "Kimi"]);
  assert.equal(rows[0].first, "平台站不住");
  assert.equal(rows[0].latest, null);
  assert.equal(rows[0].crossPassed, true);
  assert.equal(rows[1].latest, "只放地区");
  assert.equal(rows[1].missing, 1);
  assert.equal(rows[2].status, "timeout");
  assert.deepEqual(round1Messages(rec).map((x) => x.id), ["b", "a", "c"]);
  assert.deepEqual(streamMessages(rec).map((x) => x.id), ["d"]);
});

test("第一轮有人还在答就不亮", () => {
  assert.equal(round1Revealed([{ phase: "r1" }, { phase: "cross" }]), false);
  assert.equal(round1Revealed([{ phase: "cross" }]), true);
});

test("@ 提示：最长名优先，@所有人 = 全部", () => {
  const ms = [{ name: "Claude" }, { name: "Claude·Opus" }, { name: "GPT" }];
  assert.deepEqual(mentionedNames("@Claude·Opus 和 @gpt", ms), ["Claude·Opus", "GPT"]);
  assert.deepEqual(mentionedNames("@大家 看看", ms), ["Claude", "Claude·Opus", "GPT"]);
  assert.deepEqual(mentionedNames("没有点名", ms), []);
});

test("材料路径转项目内相对路径", () => {
  assert.equal(toProjectRel("/Users/a/proj/notes/x.md", "/Users/a/proj"), "notes/x.md");
  assert.equal(toProjectRel("./notes/x.md", "/Users/a/proj"), "notes/x.md");
  assert.equal(toProjectRel("C:\\p\\notes\\x.md", "C:\\p"), "notes/x.md");
  assert.equal(toProjectRel("/Users/b/other.md", "/Users/a/proj"), null);
  assert.equal(toProjectRel("../x.md", "/Users/a/proj"), null);
});
