import assert from "node:assert/strict";
import test from "node:test";
import {
  adoptionReason,
  liveConsultState,
  consultCaret,
  sidebarConsults,
  workbenchLiveConsults,
  contrastRows,
  estimateCost,
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
  usdText,
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

test("花费预估：同连接同模型按它的均值，没记录的按全体均值，一条记录都没有只给次数", () => {
  const stats = [
    { profileId: "a", model: "m", calls: 2, avgUsd: 0.1 },
    { profileId: "b", model: "n", calls: 2, avgUsd: 0.3 },
  ];
  const r = estimateCost([{ profileId: "a", model: "m" }, { profileId: "c", model: "x" }], 1, stats);
  assert.equal(r.calls, 4);
  assert.equal(r.guessed, 1);
  assert.ok(Math.abs((r.usd ?? 0) - (0.1 + 0.2) * 2) < 1e-9);
  assert.deepEqual(estimateCost([{ profileId: "a", model: "m" }], 0, []), { calls: 1, usd: null, guessed: 0 });
});

test("提升到研究档案的依据：哪场研讨、谁的结论、经过哪几家", () => {
  const rec = record([
    m({ id: "a", member: "m1", conclusion: "平台站不住" }),
    m({ id: "b", member: "m2", status: "error" }),
    m({ id: "c", member: "m3", phase: "cross", round: 1, conclusion: "回到地区" }),
  ]);
  const reason = adoptionReason(rec, rec.messages[2], (a) => (a === "claude-code" ? "Claude Code" : a), "菌群 meta");
  assert.match(reason, /研讨「t」/);
  assert.match(reason, /采用 Kimi（默认模型 · kimi）的结论/);
  assert.match(reason, /参与：Claude（默认模型 · Claude Code）、Kimi（默认模型 · kimi）/);
  assert.doesNotMatch(reason, /GPT/);
  assert.match(reason, /\.ccode\/consults\/c\.jsonl/);
});

test("工作台露出的研讨：有人在答或等你发话，24 小时没动静的不列", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  const items = [
    { id: "a", busy: true, awaiting: false, updatedAt: "2026-11-11T11:59:00Z" },
    { id: "b", busy: false, awaiting: true, updatedAt: "2026-11-11T08:00:00Z" },
    { id: "c", busy: false, awaiting: false, updatedAt: "2026-11-11T11:00:00Z" },
    { id: "d", busy: false, awaiting: true, updatedAt: "2026-11-10T10:00:00Z" },
  ];
  assert.deepEqual(workbenchLiveConsults(items, now).map((x) => x.id), ["a", "b"]);
  assert.equal(liveConsultState({ busy: true, answering: 3, awaiting: false }), "3 家在答");
  assert.equal(liveConsultState({ busy: true, answering: 0, awaiting: false }), "在答");
  assert.equal(liveConsultState({ busy: false, answering: 0, awaiting: true }), "等你发话");
});

test("研讨花费：不到一分钱不显示成 $0.00", () => {
  assert.equal(usdText(0.00205771), "不到 $0.01");
  assert.equal(usdText(0.0703), "$0.07");
  assert.equal(usdText(1.234), "$1.23");
  assert.equal(usdText(0), "$0.00");
});

test("侧栏挂哪几场研讨：进行中的全列，其余 3 天内的补到 3 场，正打开的补在最后", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  const ago = (h: number) => new Date(now - h * 3600_000).toISOString();
  const items = [
    { id: "old", busy: false, awaiting: false, updatedAt: ago(24 * 10) },
    { id: "r1", busy: false, awaiting: false, updatedAt: ago(1) },
    { id: "r2", busy: false, awaiting: false, updatedAt: ago(2) },
    { id: "r3", busy: false, awaiting: false, updatedAt: ago(3) },
    { id: "r4", busy: false, awaiting: false, updatedAt: ago(4) },
    { id: "live", busy: true, awaiting: false, updatedAt: ago(5) },
    { id: "wait", busy: false, awaiting: true, updatedAt: ago(6) },
  ];
  assert.deepEqual(sidebarConsults(items, now).map((c) => c.id), ["r1", "r2", "r3", "live", "wait"]);
  assert.deepEqual(sidebarConsults(items, now, "old").map((c) => c.id), ["r1", "r2", "r3", "live", "wait", "old"]);
  assert.deepEqual(sidebarConsults(items, now, "r1").map((c) => c.id), ["r1", "r2", "r3", "live", "wait"]);
  assert.equal(consultCaret(items[5], now), "working");
  assert.equal(consultCaret(items[6], now), "idle");
  assert.equal(consultCaret(items[1], now), null);
  // 停下等你发话但 24 小时没动静：不再挂光标
  assert.equal(consultCaret({ busy: false, awaiting: true, updatedAt: ago(30) }, now), null);
});
