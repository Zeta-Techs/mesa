import assert from "node:assert/strict";
import test from "node:test";
import { RAIL_SEARCH_RECENT, railSearch, type RailSearchChat, type RailSearchProject } from "../src/rail-search.ts";

const chat = (key: string, title: string, folder: string, updatedAt: string | null): RailSearchChat<null> => ({
  key,
  title,
  fullTitle: `1024|功能|${title}`,
  folder,
  updatedAt,
  data: null,
});
const project = (key: string, name: string, path: string): RailSearchProject<null> => ({ key, name, path, data: null });

const CHATS = [
  chat("a", "启动动画优化", "ccode", "2026-10-23T05:00:00Z"),
  chat("b", "随手聊对话与文件夹切换", "随手聊", "2026-10-24T07:00:00Z"),
  chat("c", "出图模型不可用", "ccode", "2026-10-24T01:00:00Z"),
  chat("d", "整理数据", "Mesa 示例课题", "2026-10-20T01:00:00Z"),
];
const PROJECTS = [project("p1", "ccode", "/Users/x/Documents/Ccode"), project("p2", "Mesa 示例课题", "/Users/x/Documents/Mesa")];

test("不输入时只列最近对话，按更新时间从新到旧", () => {
  const hits = railSearch(CHATS, PROJECTS, "  ");
  assert.deepEqual(
    hits.map((h) => `${h.kind}:${h.item.key}`),
    ["chat:b", "chat:c", "chat:a", "chat:d"],
  );
});

test("不输入时最多列 RAIL_SEARCH_RECENT 段，重复的对话只列一次", () => {
  const many = Array.from({ length: RAIL_SEARCH_RECENT + 10 }, (_, i) =>
    chat(`k${i}`, `对话${i}`, "随手聊", `2026-10-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`),
  );
  assert.equal(railSearch(many, [], "").length, RAIL_SEARCH_RECENT);
  assert.equal(railSearch([CHATS[0], CHATS[0]], [], "").length, 1);
});

test("输入后项目在前、对话在后，不分大小写", () => {
  const hits = railSearch(CHATS, PROJECTS, "CCODE");
  assert.deepEqual(
    hits.map((h) => `${h.kind}:${h.item.key}`),
    ["project:p1", "chat:c", "chat:a"],
  );
});

test("标题命中的对话排在只有文件夹名命中的前面", () => {
  const list = [chat("x", "示例数据清洗", "随手聊", "2026-10-01T00:00:00Z"), CHATS[3]];
  const hits = railSearch(list, [], "示例");
  assert.deepEqual(hits.map((h) => h.item.key), ["x", "d"]);
});

test("多个词每个都要命中，可以分别落在标题和文件夹名上", () => {
  assert.deepEqual(
    railSearch(CHATS, [], "动画 ccode").map((h) => h.item.key),
    ["a"],
  );
  assert.deepEqual(railSearch(CHATS, [], "动画 随手聊"), []);
});

test("完整标题里的类型也搜得到；项目按路径也能命中", () => {
  assert.equal(railSearch(CHATS, [], "功能").length, CHATS.length);
  assert.deepEqual(
    railSearch([], PROJECTS, "documents/mesa").map((h) => h.item.key),
    ["p2"],
  );
});
