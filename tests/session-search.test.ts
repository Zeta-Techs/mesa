import assert from "node:assert/strict";
import test from "node:test";
import {
  applySearchHits,
  findFocusMessageIndex,
  focusFromMatch,
  metadataMatchesQuery,
  parseSearchQuery,
  sessionPassesFilters,
  searchHitKey,
  tokenizeSearchQuery,
} from "../src/session-search.ts";
import type {
  ChatMessageDto,
  SessionMetaDto,
  SessionSearchHitDto,
} from "../src/types.ts";

function s(over: Partial<SessionMetaDto> = {}): SessionMetaDto {
  return {
    agent: "claude-code",
    sessionId: "s1",
    projectPath: "/w/alpha",
    title: "闲聊",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    filePath: "/f",
    tokenUsage: null,
    cliVersion: null,
    pinned: false,
    archived: false,
    customTitle: null,
    tags: [],
    alive: true,
    chainCount: 1,
    workspace: null,
    stepName: null,
    summary: null,
    live: false,
    source: "cli",
    internal: false,
    handoffFromAgent: null,
    handoffFromSession: null,
    taskId: null,
    taskName: null,
    profileId: null,
    ...over,
  };
}

test("tokenizeSearchQuery 空白分词、丢掉短英文、保留汉字", () => {
  assert.deepEqual(tokenizeSearchQuery("  消融  transformer,  a  IF  "), [
    "消融",
    "transformer",
    "if",
  ]);
  assert.deepEqual(tokenizeSearchQuery("酶"), ["酶"]);
  assert.deepEqual(tokenizeSearchQuery(" ，， "), []);
});

test("metadataMatchesQuery 任一关键词即可", () => {
  const row = s({ title: "消融实验", tags: ["方差"] });
  assert.equal(metadataMatchesQuery(row, ["消融"]), true);
  assert.equal(metadataMatchesQuery(row, ["方差"]), true);
  assert.equal(metadataMatchesQuery(row, ["天气"]), false);
});

test("无正文结果时按元数据过滤、保持原序", () => {
  const rows = [
    s({ sessionId: "old", title: "消融", updatedAt: "2026-08-01T00:00:00Z" }),
    s({ sessionId: "new", title: "别的", updatedAt: "2026-09-01T00:00:00Z" }),
  ];
  const { list, snippets } = applySearchHits(rows, "消融", null);
  assert.deepEqual(
    list.map((x) => x.sessionId),
    ["old"],
  );
  assert.equal(Object.keys(snippets).length, 0);
});

test("有正文命中时按后端顺序排，并带摘录", () => {
  const rows = [
    s({ sessionId: "a", title: "A", agent: "claude-code" }),
    s({ sessionId: "b", title: "B", agent: "codex" }),
  ];
  const hits: SessionSearchHitDto[] = [
    {
      agent: "codex",
      sessionId: "b",
      score: 90,
      snippet: "……消融实验……",
      matchedKeywords: ["消融"],
    },
    {
      agent: "claude-code",
      sessionId: "a",
      score: 40,
      snippet: null,
      matchedKeywords: ["消融"],
    },
  ];
  const { list, snippets } = applySearchHits(rows, "消融", hits);
  assert.deepEqual(
    list.map((x) => x.sessionId),
    ["b", "a"],
  );
  assert.equal(snippets[searchHitKey("codex", "b")], "……消融实验……");
  assert.equal(snippets[searchHitKey("claude-code", "a")], undefined);
});

test("后端空数组表示没有命中，不再回落元数据", () => {
  const rows = [s({ title: "消融" })];
  const { list } = applySearchHits(rows, "消融", []);
  assert.equal(list.length, 0);
});

test("空查询不过滤", () => {
  const rows = [s(), s({ sessionId: "s2" })];
  const { list } = applySearchHits(rows, "  ", null);
  assert.equal(list.length, 2);
});

function msg(
  over: Partial<ChatMessageDto> & { text: string; role?: string },
): ChatMessageDto {
  return {
    role: over.role ?? "user",
    timestamp: over.timestamp ?? null,
    usage: null,
    blocks: [{ kind: "text", text: over.text, toolName: null }],
  };
}

test("findFocusMessageIndex 时间戳优先于关键词", () => {
  const messages = [
    msg({ text: "消融实验甲", timestamp: "t1" }),
    msg({ text: "消融实验乙", timestamp: "t2" }),
    msg({ text: "别的", timestamp: "t3" }),
  ];
  assert.equal(
    findFocusMessageIndex(messages, {
      around: 10,
      matchTimestamp: "t2",
      matchRole: "user",
      snippet: "…消融实验乙…",
      matchedKeywords: ["消融"],
    }),
    1,
  );
});

test("findFocusMessageIndex 无时间戳时用关键词", () => {
  const messages = [
    msg({ text: "天气不错" }),
    msg({ text: "消融实验怎么做", role: "assistant" }),
  ];
  assert.equal(
    findFocusMessageIndex(messages, {
      around: null,
      matchTimestamp: null,
      matchRole: null,
      snippet: null,
      matchedKeywords: ["消融"],
    }),
    1,
  );
});

test("findFocusMessageIndex 摘录空白折叠后仍能对上", () => {
  const messages = [
    msg({ text: "天气不错" }),
    msg({
      text: "32' 的 `codex_relay_compat_args`)\n: '``` -c web_search",
      role: "assistant",
    }),
  ];
  assert.equal(
    findFocusMessageIndex(messages, {
      around: null,
      matchTimestamp: null,
      matchRole: "assistant",
      snippet: "…32' 的 `codex_relay_compat_args`) : '``` -c web_searc…",
      matchedKeywords: ["web"],
    }),
    1,
  );
});

test("findFocusMessageIndex 同一秒多条时用摘录区分", () => {
  const messages = [
    msg({ text: "我来跑", role: "assistant", timestamp: "t" }),
    msg({ text: "全绿 web_search", role: "assistant", timestamp: "t" }),
  ];
  assert.equal(
    findFocusMessageIndex(messages, {
      around: 1,
      matchTimestamp: "t",
      matchRole: "assistant",
      snippet: "…全绿 web_search…",
      matchedKeywords: ["web"],
    }),
    1,
  );
});

test("focusFromMatch：每一处命中各自带时间戳和摘录，同一秒多条也能对上", () => {
  const messages = [
    msg({ text: "提到一次消融", role: "assistant", timestamp: "t" }),
    msg({ text: "消融实验的方差怎么算", timestamp: "t" }),
  ];
  const focus = focusFromMatch(
    {
      around: 42,
      timestamp: "t",
      role: "user",
      snippet: "消融实验的方差怎么算",
      score: 90,
    },
    ["消融", "方差"],
  );
  assert.equal(focus.around, 42);
  assert.deepEqual(focus.matchedKeywords, ["消融", "方差"]);
  assert.equal(findFocusMessageIndex(messages, focus), 1);
});

test("parseSearchQuery：引号整句与筛选写法，与后端 parse_query 同口径", () => {
  const pq = parseSearchQuery(
    'agent:Claude 角色：我 after:2026-10 before:2026/10/20 "回复 超过" 「1500 字」 消融 http://x.y',
  );
  assert.deepEqual(pq.agents, ["claude"]);
  assert.equal(pq.role, "user");
  assert.equal(pq.after, "2026-10");
  assert.equal(pq.before, "2026-10-20");
  assert.deepEqual(pq.phrases, ["回复 超过", "1500 字"]);
  assert.deepEqual(pq.tokens, ["回复 超过", "1500 字", "消融", "http://x.y"]);
  const odd = parseSearchQuery("role:随便 after:昨天");
  assert.equal(odd.role, null);
  assert.equal(odd.after, null);
  assert.deepEqual(odd.tokens, ["role:随便", "after:昨天"]);
  assert.deepEqual(parseSearchQuery('"没闭合 的引号').phrases, ["没闭合 的引号"]);
});

test("只写筛选不写词：按 agent / 日期筛列表；按角色搜时不拿标题先顶上", () => {
  const rows = [
    s({ sessionId: "a", agent: "codex", updatedAt: "2026-10-15T04:00:00Z", title: "消融" }),
    s({ sessionId: "b", agent: "claude-code", updatedAt: "2026-09-01T04:00:00Z", title: "消融" }),
  ];
  assert.ok(sessionPassesFilters(rows[0], parseSearchQuery("agent:codex after:2026-10")));
  assert.ok(!sessionPassesFilters(rows[1], parseSearchQuery("after:2026-10")));
  assert.deepEqual(
    applySearchHits(rows, "agent:codex", null).list.map((x) => x.sessionId),
    ["a"],
  );
  assert.deepEqual(applySearchHits(rows, "消融 role:我", null).list, []);
  assert.deepEqual(
    applySearchHits(rows, "消融 agent:claude", null).list.map((x) => x.sessionId),
    ["b"],
  );
});
