import test from "node:test";
import assert from "node:assert/strict";
import {
  applyOrder,
  isPinned,
  parsePins,
  reorderGroup,
  splitPinned,
  togglePin,
} from "../src/project-tree.ts";

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

const pathOf = (r: { repoPath: string }) => r.repoPath;

test("组内顺序：表里的按表排，新加的排在最后并保持原顺序", () => {
  const four = [...rows, { repoPath: "/u/d", name: "d" }];
  const sorted = applyOrder(four, ["/u/c", "/u/a"], pathOf, false);
  assert.deepEqual(sorted.map((r) => r.name), ["c", "a", "b", "d"]);
  assert.deepEqual(applyOrder(four, [], pathOf, false).map((r) => r.name), ["a", "b", "c", "d"]);
});

test("组内顺序：表里残留已移除的课题不影响排序", () => {
  const sorted = applyOrder(rows, ["/u/gone", "/u/b"], pathOf, false);
  assert.deepEqual(sorted.map((r) => r.name), ["b", "a", "c"]);
});

test("拖动落定：组内挪位写回表，别的组的条目原样保留", () => {
  // 另一组的 /x/1 在表里；本组显示顺序 a b c，把 a 拖到最后
  const next = reorderGroup(["/u/b", "/x/1"], ["/u/a", "/u/b", "/u/c"], 0, 2, false);
  assert.deepEqual(next, ["/x/1", "/u/b", "/u/c", "/u/a"]);
  assert.deepEqual(applyOrder(rows, next, pathOf, false).map((r) => r.name), ["b", "c", "a"]);
});

test("拖动落定：往前拖、原位松手、越界都正确", () => {
  assert.deepEqual(reorderGroup([], ["/u/a", "/u/b", "/u/c"], 2, 0, false), ["/u/c", "/u/a", "/u/b"]);
  assert.deepEqual(reorderGroup(["/u/a"], ["/u/a", "/u/b"], 1, 1, false), ["/u/a"]);
  assert.deepEqual(reorderGroup(["/u/a"], ["/u/a", "/u/b"], 0, 5, false), ["/u/a"]);
});

test("拖动落定：置顶表当 list 用，看不见的残留置顶不丢", () => {
  const pins = ["/u/a", "/u/gone", "/u/c"];
  assert.deepEqual(reorderGroup(pins, ["/u/a", "/u/c"], 1, 0, false), ["/u/gone", "/u/c", "/u/a"]);
});

test("组内顺序：Windows 路径大小写与分隔符不敏感", () => {
  const win = [
    { repoPath: "C:\\Work\\A", name: "a" },
    { repoPath: "C:\\Work\\B", name: "b" },
  ];
  assert.deepEqual(applyOrder(win, ["c:/work/b"], pathOf, true).map((r) => r.name), ["b", "a"]);
  assert.deepEqual(reorderGroup(["c:/work/a", "c:/work/b"], ["C:\\Work\\A", "C:\\Work\\B"], 0, 1, true), [
    "C:\\Work\\B",
    "C:\\Work\\A",
  ]);
});
