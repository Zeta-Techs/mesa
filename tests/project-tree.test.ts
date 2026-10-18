import test from "node:test";
import assert from "node:assert/strict";
import { isPinned, parsePins, splitPinned, togglePin } from "../src/project-tree.ts";

const rows = [
  { repoPath: "/u/a", name: "a" },
  { repoPath: "/u/b", name: "b" },
  { repoPath: "/u/c", name: "c" },
];

test("置顶切换：追加到末尾、再点取消", () => {
  let pins = togglePin([], "/u/b", false);
  pins = togglePin(pins, "/u/a", false);
  assert.deepEqual(pins, ["/u/b", "/u/a"]);
  assert.deepEqual(togglePin(pins, "/u/b", false), ["/u/a"]);
});

test("拆段：置顶按先后排，从其余里拿走，不重复出现", () => {
  const { pinned, rest } = splitPinned(rows, ["/u/c", "/u/a"], false);
  assert.deepEqual(pinned.map((r) => r.name), ["c", "a"]);
  assert.deepEqual(rest.map((r) => r.name), ["b"]);
});

test("拆段：已移除课题的残留置顶自然跳过", () => {
  const { pinned, rest } = splitPinned(rows, ["/u/gone"], false);
  assert.equal(pinned.length, 0);
  assert.equal(rest.length, 3);
});

test("Windows 路径大小写与分隔符不敏感", () => {
  assert.equal(isPinned(["C:\\Users\\A"], "c:/users/a", true), true);
  assert.equal(isPinned(["/u/A"], "/u/a", false), false);
});

test("坏数据当空表", () => {
  assert.deepEqual(parsePins(null), []);
  assert.deepEqual(parsePins("not json"), []);
  assert.deepEqual(parsePins('{"a":1}'), []);
  assert.deepEqual(parsePins('["/u/a", 3, "/u/b"]'), ["/u/a", "/u/b"]);
});
