import assert from "node:assert/strict";
import test from "node:test";
import {
  arrangeBranchMap,
  groupLanesByTheme,
  laneActivityLabel,
  lastLaneTheme,
  overlayLanes,
} from "../src/coding-lanes.ts";

const trees = [
  { path: "/repo", branch: "main", isPrimary: true },
  { path: "/wt/ui", branch: "feature/login-ui", isPrimary: false },
  { path: "/wt/api", branch: "feature/login-api", isPrimary: false },
];

test("overlayLanes：无行时按分支名现算", () => {
  const rows = overlayLanes(trees, [], false);
  assert.equal(rows[1]?.lane.name, "feature/login-ui");
  assert.equal(rows[1]?.lane.theme, null);
});

test("groupLanesByTheme：主仓单独一组，主题分组", () => {
  const rows = overlayLanes(
    trees,
    [
      {
        id: "1",
        name: "前端",
        theme: "登录",
        branch: "feature/login-ui",
        worktreePath: "/wt/ui",
      },
      {
        id: "2",
        name: "后端",
        theme: "登录",
        branch: "feature/login-api",
        worktreePath: "/wt/api",
      },
    ],
    false,
  );
  const groups = groupLanesByTheme(rows);
  assert.equal(groups[0]?.label, "主仓");
  assert.equal(groups[1]?.label, "登录");
  assert.equal(groups[1]?.items.length, 2);
});

test("lastLaneTheme 取最后一条非空主题", () => {
  assert.equal(lastLaneTheme([{ theme: null }, { theme: "登录" }]), "登录");
  assert.equal(lastLaneTheme([]), "");
});

test("laneActivityLabel：树上有活 Agent 才不是空闲", () => {
  assert.equal(
    laneActivityLabel("/wt/ui", [
      { cwd: "/wt/ui", agentId: "codex", running: true, attention: "working" },
    ]),
    "codex",
  );
  assert.equal(
    laneActivityLabel("/wt/ui", [
      { cwd: "/wt/other", agentId: "codex", running: true },
    ]),
    "空闲",
  );
});

test("arrangeBranchMap：基准作根，其余工作树挂在根下，未检出分支单列", () => {
  const branch = (name: string, worktreePath: string | null, isBase = false) => ({
    name, worktreePath, isBase,
  });
  // 基准 dev 没检出：主仓停在功能分支上
  const off = overlayLanes(
    [{ path: "/repo", branch: "feat/chat", isPrimary: true, isBase: false }],
    [],
  );
  const offMap = arrangeBranchMap(
    off,
    [branch("dev", null, true), branch("feat/chat", "/repo"), branch("fix/forum", null)],
    "dev",
  );
  assert.equal(offMap.root?.name, "dev");
  assert.equal(offMap.root?.tree, null);
  assert.equal(offMap.root?.branch?.name, "dev");
  assert.deepEqual(offMap.groups.map((g) => g.items.map((t) => t.branch)), [["feat/chat"]]);
  assert.deepEqual(offMap.loose.map((b) => b.name), ["fix/forum"]);

  // 基准检出在主仓：主仓就是根，不再出现在子节点里
  const on = overlayLanes(
    [
      { path: "/repo", branch: "main", isPrimary: true, isBase: true },
      { path: "/wt/ui", branch: "feature/ui", isPrimary: false, isBase: false },
    ],
    [],
  );
  const onMap = arrangeBranchMap(on, [branch("main", "/repo", true), branch("feature/ui", "/wt/ui")], "main");
  assert.equal(onMap.root?.tree?.path, "/repo");
  assert.deepEqual(onMap.groups.flatMap((g) => g.items.map((t) => t.path)), ["/wt/ui"]);
  assert.deepEqual(onMap.loose, []);

  // 基准只在远程、本地没有分支行：根仍按名字给出
  const bare = arrangeBranchMap(on.slice(1), [], "main");
  assert.equal(bare.root?.name, "main");
  assert.equal(bare.root?.branch, null);
  assert.equal(arrangeBranchMap([], [], " ").root, null);
});
