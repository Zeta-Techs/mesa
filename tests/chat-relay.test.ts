import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  composeRelayPrompt,
  relayCardText,
  relayChipText,
  relayAgentRows,
  relayModeRows,
  splitRelayPrompt,
  type RelayOptionDto,
} from "../src/chat-relay.ts";

interface Case {
  name: string;
  text: string;
  relay: { briefName: string; delta: boolean; said: string; from: string | null; roundsBy: string | null } | null;
}

// 与 relay_brief.rs 共读：抬头拼法后端定，两端拆法一致
const cases: Case[] = JSON.parse(readFileSync("tests/fixtures/relay-prompts.json", "utf8"));

test("接力抬头两端拆法一致", () => {
  for (const c of cases) {
    const p = splitRelayPrompt(c.text);
    if (!c.relay) {
      assert.equal(p, null, c.name);
      continue;
    }
    assert.ok(p, c.name);
    assert.equal(p.briefName, c.relay.briefName, c.name);
    assert.equal(p.delta, c.relay.delta, c.name);
    assert.equal(p.said, c.relay.said, c.name);
    assert.equal(p.from, c.relay.from, c.name);
    assert.equal(p.roundsBy, c.relay.roundsBy, c.name);
  }
});

test("拼回去再拆得到原话", () => {
  const framing = "〔Mesa 接力〕这段对话之前由 Codex（会话 a）做，交接简报在 .ccode/handoff-1-ab.md。先读完它，再按 ---- 下面我这句话做；不要复述简报。";
  const p = splitRelayPrompt(composeRelayPrompt(framing, "  第一行\n第二行 "));
  assert.equal(p?.said, "第一行\n第二行");
  assert.equal(relayCardText(p!), "前面由 Codex 做");
});

test("接力卡与输入框上的说法", () => {
  const delta = splitRelayPrompt(cases.find((c) => c.relay?.delta)!.text)!;
  assert.equal(relayCardText(delta), "你离开期间 Codex 做了 2 轮、Kimi Code 做了 1 轮");
  const t = { agentId: "codex", profileId: "p", model: "", mode: "new" as const, resumeSession: null };
  assert.equal(relayChipText(t, "Codex"), "下一句交给 Codex");
  assert.equal(relayChipText({ ...t, mode: "resume", resumeSession: "s" }, "Codex"), "下一句接回 Codex 原来那段");
});

const agents = [
  { id: "claude-code", label: "Claude Code", installed: true },
  { id: "codex", label: "Codex", installed: true },
  { id: "kimi", label: "Kimi Code", installed: true },
  { id: "gemini", label: "Gemini CLI", installed: false },
];
const profiles = [
  { id: "c1", agent: "codex", name: "官方", models: ["gpt-5.5"] },
  { id: "c2", agent: "codex", name: "中转", models: ["gpt-5.5-mini"] },
  { id: "k1", agent: "kimi", name: "月之暗面", models: ["kimi-k3"] },
  { id: "k2", agent: "kimi", name: "停用的", models: [] },
  { id: "g1", agent: "gemini", name: "x", models: [] },
];

test("第一层一家一行：当前这家、没装的、没有可用连接的不列；上次用的连接排前", () => {
  const rows = relayAgentRows({
    currentAgent: "claude-code",
    agents,
    profiles,
    hiddenProfiles: ["k2"],
    options: [],
    lastProfile: (a) => (a === "codex" ? "c2" : null),
  });
  assert.deepEqual(rows.map((r) => r.agentId), ["codex", "kimi"]);
  assert.deepEqual(rows[0].profiles.map((p) => p.id), ["c2", "c1"]);
  assert.deepEqual(rows[1].profiles.map((p) => p.id), ["k1"]);
  assert.equal(rows[0].used, null);
});

test("用过的家：默认接回在前；建议新开时新开在前并写原因；接不回只给新开", () => {
  const opt = (o: Partial<RelayOptionDto>): RelayOptionDto => ({
    agent: "codex",
    priorSession: "B",
    priorFile: "/f",
    deltaRounds: 3,
    roundsBy: "Kimi Code 做了 3 轮",
    resumable: true,
    recommendNew: false,
    reason: null,
    ...o,
  });
  const row = relayAgentRows({
    currentAgent: "kimi",
    agents,
    profiles,
    hiddenProfiles: [],
    options: [opt({})],
    lastProfile: () => null,
  }).find((r) => r.agentId === "codex")!;
  assert.equal(row.used?.priorSession, "B");
  assert.deepEqual(relayModeRows(opt({})).map((m) => m.label), ["接回原来那段 · 补 3 轮", "新开一段"]);
  const rec = relayModeRows(opt({ recommendNew: true, reason: "原来那段上下文已用 82%" }));
  assert.equal(rec[0].mode, "new");
  assert.equal(rec[0].note, "原来那段上下文已用 82%");
  assert.deepEqual(relayModeRows(opt({ resumable: false, recommendNew: true, reason: "原来那段的记录已不在" })).map((m) => m.mode), ["new"]);
});
