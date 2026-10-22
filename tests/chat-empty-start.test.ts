import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveChatCwd,
  STARTER_PROMPTS,
  starterContextFor,
} from "../src/chat-empty-start.ts";

test("~ 与空目录展开成家目录", () => {
  assert.equal(resolveChatCwd("~", "/Users/u"), "/Users/u");
  assert.equal(resolveChatCwd("", "/Users/u"), "/Users/u");
  assert.equal(resolveChatCwd("~/x", "/Users/u/"), "/Users/u/x");
  assert.equal(resolveChatCwd("/proj/a", "/Users/u"), "/proj/a");
});

test("起手提示按目录类型：登记项目按工作方式，家目录 / 随手聊 / 未登记给通用", () => {
  const projects = [
    { path: "/proj/r", workMode: "research" },
    { path: "/proj/c", workMode: "coding" },
  ];
  assert.equal(starterContextFor("/proj/r", projects), "research");
  assert.equal(starterContextFor("/proj/c/", projects), "coding");
  assert.equal(starterContextFor("/Users/u", projects), "general");
  assert.equal(starterContextFor("/Users/u/ccode/scratch", projects), "general");
  for (const list of Object.values(STARTER_PROMPTS)) {
    assert.ok(list.length >= 3 && list.length <= 4, "一排三到四个，多了就成了菜单");
  }
});






test("问候按时段", async () => {
  const { chatGreeting } = await import("../src/chat-empty-start.ts");
  assert.equal(chatGreeting(8), "早上好");
  assert.equal(chatGreeting(12), "中午好");
  assert.equal(chatGreeting(15), "下午好");
  assert.equal(chatGreeting(20), "晚上好");
  assert.equal(chatGreeting(2), "夜深了");
});

test("通用空态的「接着做」：按最近一次对话排，不含当前目录与内部对话", async () => {
  const { recentProjectStarters } = await import("../src/chat-empty-start.ts");
  const projects = [
    { path: "/proj/a", name: "A", lastOpenedAt: "2026-10-01T00:00:00Z" },
    { path: "/proj/b", name: "B", lastOpenedAt: null },
    { path: "/proj/c", name: "C", lastOpenedAt: null },
    { path: "/proj/d", name: "D", lastOpenedAt: "2026-10-20T00:00:00Z" },
  ];
  const sessions = [
    { projectPath: "/proj/a", updatedAt: "2026-10-22T08:00:00Z" },
    { projectPath: "/proj/b", updatedAt: "2026-10-22T09:00:00Z" },
    { projectPath: "/proj/c", updatedAt: "2026-10-23T09:00:00Z", internal: true },
  ];
  assert.deepEqual(
    recentProjectStarters(projects, sessions, "/Users/u/ccode/scratch").map((p) => p.name),
    ["B", "A"],
  );
  // 当前就在 B 里：不推荐自己；没对话的 D 用上次打开时间兜底
  assert.deepEqual(
    recentProjectStarters(projects, sessions, "/proj/b/", false, 3).map((p) => p.name),
    ["A", "D"],
  );
});
