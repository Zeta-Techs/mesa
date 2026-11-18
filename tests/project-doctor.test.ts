import { test } from "node:test";
import assert from "node:assert/strict";
import {
  forgetPasses,
  gotoHint,
  isBlocked,
  orderFindings,
  recentlyPassed,
  rememberPass,
  REVIEW_HANDLED_CODES,
} from "../src/project-doctor.ts";

test("拦人的排前面，同类保持后端顺序", () => {
  const out = orderFindings([
    { code: "a", text: "", blocks: false },
    { code: "b", text: "", blocks: true },
    { code: "c", text: "", blocks: false },
    { code: "d", text: "", blocks: true },
  ]);
  assert.deepEqual(out.map((f) => f.code), ["b", "d", "a", "c"]);
  assert.equal(isBlocked({ fixed: [], findings: out }), true);
  assert.equal(isBlocked({ fixed: ["x"], findings: [{ code: "a", text: "", blocks: false }] }), false);
});

test("去处理的出口说清去哪、点什么，说人话", () => {
  assert.match(gotoHint({ kind: "goto", label: "去处理冲突", target: "review" }, "精读"), /「精读」.*去评审.*去处理冲突/);
  assert.match(gotoHint({ kind: "goto", label: "x", target: "main-commit" }, "精读"), /提交项目文件夹的改动/);
  assert.match(gotoHint({ kind: "goto", label: "x", target: "workspaces" }, "精读"), /重新定位/);
});

test("评审页已有入口的状态不在体检条里重复列", () => {
  for (const code of ["main_unfinished", "main_off_base", "main_dirty", "worktree_conflict"]) {
    assert.ok(REVIEW_HANDLED_CODES.has(code), code);
  }
  assert.ok(!REVIEW_HANDLED_CODES.has("merged_outside"));
  assert.ok(!REVIEW_HANDLED_CODES.has("worktree_broken"));
});

test("刚体检过的同一入口五秒内不再跑，换入口或过时照跑", () => {
  forgetPasses();
  rememberPass("w1", "round", 1000);
  assert.equal(recentlyPassed("w1", "round", 3000), true);
  assert.equal(recentlyPassed("w1", "save", 3000), false);
  assert.equal(recentlyPassed("w2", "round", 3000), false);
  assert.equal(recentlyPassed("w1", "round", 7000), false);
});
