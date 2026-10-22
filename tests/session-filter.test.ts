import assert from "node:assert/strict";
import test from "node:test";
import {
  QUICK_FILTERS,
  applySessionFilters,
  sessionFilterQuickForSearch,
  groupSearchHitsByArchive,
  SEARCH_ARCHIVED_HEADER,
  buildScopeSuggestions,
  groupSessionsByProjectPath,
  isCcodeAiTempCwd,
  sessionLooksInternal,
  sessionExcludedFromProjectList,
  sessionTime,
  sessionDayKey,
  type QuickFilterId,
  type ScopeChip,
} from "../src/session-filter.ts";
import type { SessionMetaDto } from "../src/types.ts";

const DAY = 86_400_000;
/** 固定「现在」= 2026-08-15 12:00 本地，避免跨日抖动 */
const NOW = new Date(2026, 7, 15, 12, 0, 0).getTime();
const at = (offsetDays: number) =>
  new Date(NOW - offsetDays * DAY).toISOString();

function s(over: Partial<SessionMetaDto> = {}): SessionMetaDto {
  return {
    agent: "claude-code",
    sessionId: Math.random().toString(36).slice(2),
    projectPath: "/w/alpha",
    title: null,
    createdAt: at(0),
    updatedAt: at(0),
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
    ...over,
  };
}

const NO_LIVE = new Set<string>();
const q = (...ids: QuickFilterId[]) => new Set(ids);

test("默认口径：排除归档与内部会话", () => {
  const rows = [s(), s({ archived: true }), s({ internal: true })];
  assert.equal(applySessionFilters(rows, q(), [], NO_LIVE, NOW).length, 1);
});

test("archived 是放宽不是只看归档", () => {
  const rows = [s(), s({ archived: true })];
  assert.equal(
    applySessionFilters(rows, q("archived"), [], NO_LIVE, NOW).length,
    2,
  );
});

test("搜索时 quick 放宽归档，未搜索不动", () => {
  const base = q("today");
  assert.equal(sessionFilterQuickForSearch(base, false), base);
  const searching = sessionFilterQuickForSearch(base, true);
  assert.ok(searching.has("archived"));
  assert.ok(searching.has("today"));
  assert.equal(sessionFilterQuickForSearch(q("archived"), true).has("archived"), true);
});

test("搜索命中：未归档在前，已归档沉底挂组头", () => {
  const a = s({ sessionId: "a" });
  const b = s({ sessionId: "b", archived: true });
  const c = s({ sessionId: "c", archived: true });
  const rows = groupSearchHitsByArchive([a, b, c]);
  assert.deepEqual(
    rows.map((r) => [r.header, r.s.sessionId]),
    [
      [null, "a"],
      [SEARCH_ARCHIVED_HEADER, "b"],
      [null, "c"],
    ],
  );
  assert.deepEqual(groupSearchHitsByArchive([a]), [{ header: null, s: a }]);
});

test("internal 是收窄：只看内部 AI", () => {
  const rows = [s(), s({ internal: true }), s({ internal: true })];
  const out = applySessionFilters(rows, q("internal"), [], NO_LIVE, NOW);
  assert.equal(out.length, 2);
  assert.ok(out.every((x) => x.internal));
});

test("pinned 只看已保留", () => {
  const rows = [s({ pinned: true }), s()];
  assert.equal(applySessionFilters(rows, q("pinned"), [], NO_LIVE, NOW).length, 1);
});

test("live 认后端标记，也认终端标签镜像", () => {
  const a = s({ live: true });
  const b = s({ agent: "codex", sessionId: "S9" });
  const c = s();
  const liveKeys = new Set(["codex\nS9"]);
  const out = applySessionFilters([a, b, c], q("live"), [], liveKeys, NOW);
  assert.equal(out.length, 2);
});

test("今天 / 近 7 天按本机日界，week 覆盖 today", () => {
  const rows = [s({ updatedAt: at(0) }), s({ updatedAt: at(3) }), s({ updatedAt: at(30) })];
  assert.equal(applySessionFilters(rows, q("today"), [], NO_LIVE, NOW).length, 1);
  assert.equal(applySessionFilters(rows, q("week"), [], NO_LIVE, NOW).length, 2);
  // 同时勾选取更宽的
  assert.equal(
    applySessionFilters(rows, q("today", "week"), [], NO_LIVE, NOW).length,
    2,
  );
});

test("没有时间戳的会话不进时间筛选结果", () => {
  const rows = [s({ updatedAt: null, createdAt: null })];
  assert.equal(applySessionFilters(rows, q("today"), [], NO_LIVE, NOW).length, 0);
  // 不加时间筛选时仍然列出
  assert.equal(applySessionFilters(rows, q(), [], NO_LIVE, NOW).length, 1);
});

test("updatedAt 缺失时回落 createdAt", () => {
  assert.equal(sessionTime(s({ updatedAt: null, createdAt: at(1) })) !== null, true);
  assert.equal(sessionTime(s({ updatedAt: null, createdAt: "坏时间" })), null);
});

test("作用域 chip：同类取或、异类取与", () => {
  const rows = [
    s({ projectPath: "/w/alpha", stepName: "检索" }),
    s({ projectPath: "/w/beta", stepName: "检索" }),
    s({ projectPath: "/w/alpha", stepName: "写作" }),
  ];
  const p = (v: string): ScopeChip => ({ kind: "project", value: v, label: v });
  const st = (v: string): ScopeChip => ({ kind: "step", value: v, label: v });
  // 两个项目 chip = 并集
  assert.equal(
    applySessionFilters(rows, q(), [p("/w/alpha"), p("/w/beta")], NO_LIVE, NOW).length,
    3,
  );
  // 项目 + 步骤 = 交集
  assert.equal(
    applySessionFilters(rows, q(), [p("/w/alpha"), st("检索")], NO_LIVE, NOW).length,
    1,
  );
});

test("搜索建议按项目/步骤/卡片/agent 分类去重", () => {
  const rows = [
    s({ projectPath: "/w/lit-review", stepName: "文献检索与筛选", taskName: "检索策略" }),
    s({ projectPath: "/w/lit-review", stepName: "文献精读", taskName: null }),
  ];
  const out = buildScopeSuggestions(rows, "检索");
  const kinds = out.map((c) => c.kind);
  assert.ok(kinds.includes("step"), "应命中步骤名");
  assert.ok(kinds.includes("task"), "应命中卡片名");
  // 同一值不重复出现
  assert.equal(new Set(out.map((c) => `${c.kind}:${c.value}`)).size, out.length);
  // 空查询不给建议
  assert.deepEqual(buildScopeSuggestions(rows, "  "), []);
});

test("建议每类有条数上限", () => {
  const rows = Array.from({ length: 9 }, (_, i) =>
    s({ projectPath: `/w/proj-${i}` }),
  );
  const out = buildScopeSuggestions(rows, "proj", 4);
  assert.equal(out.filter((c) => c.kind === "project").length, 4);
});

test("快筛清单 id 唯一", () => {
  assert.equal(new Set(QUICK_FILTERS.map((f) => f.id)).size, QUICK_FILTERS.length);
});

test("按项目分组：跨 Agent 合并、空路径跳过、按最近更新排序", () => {
  const older = s({
    agent: "claude-code",
    projectPath: "/w/alpha",
    updatedAt: at(3),
  });
  const newer = s({
    agent: "codex",
    projectPath: "/w/alpha",
    updatedAt: at(0),
  });
  const beta = s({
    agent: "kimi",
    projectPath: "/w/beta",
    updatedAt: at(1),
  });
  const empty = s({ projectPath: "  ", updatedAt: at(0) });
  const groups = groupSessionsByProjectPath([older, newer, beta, empty]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].path, "/w/alpha");
  assert.equal(groups[0].list.length, 2);
  assert.equal(groups[1].path, "/w/beta");
});

test("按项目分组：Windows 路径大小写与分隔符视为同一项目", () => {
  const a = s({ projectPath: "C:\\w\\Alpha", updatedAt: at(0) });
  const b = s({ projectPath: "c:/w/alpha", updatedAt: at(1) });
  const groups = groupSessionsByProjectPath([a, b], true);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].list.length, 2);
});

test("Ccode 无头 AI 临时目录：只认 ccode-ai-<uuid> 目录名", () => {
  assert.equal(
    isCcodeAiTempCwd("/var/folders/xx/T/ccode-ai-2666326a-de4f-48c0-92aa-1979d2e1abcd"),
    true,
  );
  assert.equal(isCcodeAiTempCwd("/tmp/ccode-ai-not-a-uuid"), false);
  assert.equal(isCcodeAiTempCwd("/Users/me/Ccode"), false);
  assert.equal(
    sessionLooksInternal(
      s({
        internal: false,
        projectPath:
          "/private/var/folders/xx/T/ccode-ai-2666326a-de4f-48c0-92aa-1979d2e1abcd",
      }),
    ),
    true,
  );
  assert.equal(sessionLooksInternal(s({ internal: true, projectPath: "/w/alpha" })), true);
  assert.equal(sessionLooksInternal(s({ internal: false, projectPath: "/w/alpha" })), false);
  assert.equal(
    sessionLooksInternal(
      s({
        internal: false,
        projectPath: "/w/alpha",
        title: "你是科研文献快筛助手。根据下面给出的题录写解读",
      }),
    ),
    true,
  );
  assert.equal(
    sessionLooksInternal(
      s({
        internal: false,
        projectPath: "/w/alpha",
        title: "请使用 lit-watch 技能执行一次文献巡检：按 papers/watchlist.md",
      }),
    ),
    true,
  );
  assert.equal(
    sessionLooksInternal(s({ source: "ccode-ai", projectPath: "/w/alpha" })),
    true,
  );
  const ask = s({
    title: '请看这份文件："Addressing the failure of sulfonated"',
  });
  assert.equal(sessionLooksInternal(ask), false);
  assert.equal(sessionExcludedFromProjectList(ask), true);
  assert.equal(
    sessionExcludedFromProjectList(
      s({ title: "【阅读上下文】我在沉浸阅读区读 PDF：/tmp/a.pdf" }),
    ),
    true,
  );
  assert.equal(
    sessionExcludedFromProjectList(
      s({ title: "读 .ccode/handoff-20260822T021523Z.md 分叉简报" }),
    ),
    true,
  );
  assert.equal(
    sessionExcludedFromProjectList(s({ title: "继续写实验" })),
    false,
  );
});

test("按项目分组跳过无头 AI 临时目录", () => {
  const temp = s({
    projectPath: "/tmp/ccode-ai-2666326a-de4f-48c0-92aa-1979d2e1abcd",
  });
  const real = s({ projectPath: "/w/alpha" });
  const groups = groupSessionsByProjectPath([temp, real]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].path, "/w/alpha");
  const radar = s({
    projectPath: "/w/alpha",
    title: "请使用 lit-watch 技能执行一次文献巡检：按 papers/watchlist.md",
  });
  assert.equal(groupSessionsByProjectPath([radar]).length, 0);
});



test("day chip：sessionDayKey 按本机时区归日，applySessionFilters 按日期过滤", () => {
  // 2026-10-12 当天（本地时区）更新的一条：dayKey 即当天日期串
  const inDay = s({ updatedAt: new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate(), 15, 0).toISOString() });
  const key = sessionDayKey(inDay)!;
  const y = new Date();
  const expectKey = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
  assert.equal(key, expectKey);
  // 前一天 23:59 与当天 00:01 是两个不同的键
  const late = s({ updatedAt: new Date(y.getFullYear(), y.getMonth(), y.getDate() - 1, 23, 59).toISOString() });
  assert.notEqual(sessionDayKey(late), sessionDayKey(inDay));
  // 无时间戳 → null
  assert.equal(sessionDayKey(s({ updatedAt: null, createdAt: null })), null);
  // chip 过滤：命中当天、放行别的 kind
  const chip: ScopeChip = { kind: "day", value: key, label: "今天" };
  const kept = applySessionFilters([inDay, late], new Set(), [chip], []);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].sessionId, inDay.sessionId);
});

test("sessionProjectLabel：注册名 > 随手聊 > 目录末段", async () => {
  const { sessionProjectLabel } = await import("../src/session-filter.ts");
  const names = new Map([["/Users/me/Desktop/demo", "演示课题"]]);
  assert.equal(sessionProjectLabel("/Users/me/Desktop/demo/", names), "演示课题");
  assert.equal(sessionProjectLabel("/Users/me/ccode/scratch", names), "随手聊");
  assert.equal(sessionProjectLabel("/Users/me/code/mesa", names), "mesa");
  assert.equal(sessionProjectLabel("", names), null);
});

test("sessionProjectLabel：Claude 编码目录名认回已添加项目，认不出就不写", async () => {
  const { sessionProjectLabel, claudeProjectDirName } = await import("../src/session-filter.ts");
  assert.equal(claudeProjectDirName("/Users/me/Desktop/测试项目"), "-Users-me-Desktop-----");
  assert.equal(claudeProjectDirName("C:\\Users\\me\\x"), "C--Users-me-x");
  const names = new Map([
    ["/Users/me/Documents/Ccode", "Ccode"],
    ["/Users/me/Desktop/测试项目", "测试项目"],
  ]);
  assert.equal(sessionProjectLabel("-Users-me-Documents-Ccode", names), "Ccode");
  assert.equal(sessionProjectLabel("-Users-me-Desktop-----", names), "测试项目");
  assert.equal(sessionProjectLabel("-Users-me-elsewhere", names), null);
  // 两个同长中文名编码相同：认不准就不写
  const twins = new Map([
    ["/Users/me/甲乙", "甲乙"],
    ["/Users/me/丙丁", "丙丁"],
  ]);
  assert.equal(sessionProjectLabel("-Users-me---", twins), null);
});

test("scopeDirRows：已添加项目用注册名在上，家目录/其他目录另段，随手聊不进", async () => {
  const { scopeDirRows } = await import("../src/session-filter.ts");
  const g = (path: string, n: number) => ({ path, list: Array.from({ length: n }, () => ({}) as never) });
  const { projects, others } = scopeDirRows(
    [g("/Users/me/code/backend-admin", 21), g("/Users/me", 63), g("/Users/me/ccode/scratch", 6), g("/tmp", 9)],
    new Map([["/Users/me/code/backend-admin", "后端管理"]]),
    "/Users/me",
  );
  assert.deepEqual(projects, [{ path: "/Users/me/code/backend-admin", label: "后端管理", count: 21 }]);
  assert.deepEqual(
    others.map((r) => [r.label, r.count]),
    [["主目录", 63], ["tmp", 9]],
  );
});
