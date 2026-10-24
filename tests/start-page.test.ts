import assert from "node:assert/strict";
import test from "node:test";
import { normalizeStartPage, projectOfCwd, resolveStartAction, START_PAGE_OPTIONS } from "../src/start-page.ts";

const ctx = { hasLastChat: true, lastProjectPath: "/p/a", projectPaths: ["/p/b", "/p/a"] };

test("启动时进入：四种去处，旧存值（页面 id）与未知值当工作台", () => {
  assert.deepEqual(
    START_PAGE_OPTIONS.map((o) => o.label),
    ["工作台", "上次的对话", "上次的项目", "新对话"],
  );
  for (const old of ["terminal", "sessions", "workspaces", undefined, 3]) {
    assert.equal(normalizeStartPage(old), "workbench");
    assert.deepEqual(resolveStartAction(old, ctx), { kind: "workbench" });
  }
});

test("上次的对话：有可回的才去运行页，上次都关了回工作台", () => {
  assert.deepEqual(resolveStartAction("last-chat", ctx), { kind: "last-chat" });
  assert.deepEqual(resolveStartAction("last-chat", { ...ctx, hasLastChat: false }), { kind: "workbench" });
});

test("上次的项目：记的还在就选它；已移除退到项目页默认；一个项目都没有回工作台", () => {
  assert.deepEqual(resolveStartAction("last-project", ctx), { kind: "project", path: "/p/a" });
  assert.deepEqual(resolveStartAction("last-project", { ...ctx, lastProjectPath: "/gone" }), {
    kind: "project",
    path: null,
  });
  assert.deepEqual(resolveStartAction("last-project", { ...ctx, lastProjectPath: null }), {
    kind: "project",
    path: null,
  });
  assert.deepEqual(resolveStartAction("last-project", { ...ctx, projectPaths: [] }), { kind: "workbench" });
});

test("新对话：不看别的条件", () => {
  assert.deepEqual(
    resolveStartAction("new-chat", { hasLastChat: false, lastProjectPath: null, projectPaths: [] }),
    { kind: "new-chat" },
  );
});

test("上次的项目按对话目录认：落在项目里取最深的那个，随手聊 / 主目录不算", () => {
  const roots = ["/u/research", "/u/research/sub", "/u/code"];
  assert.equal(projectOfCwd("/u/research/sub/notes", roots), "/u/research/sub");
  assert.equal(projectOfCwd("/u/research", roots), "/u/research");
  assert.equal(projectOfCwd("/u/research-old", roots), null, "段边界，不按前缀");
  assert.equal(projectOfCwd("/u/ccode/scratch", roots), null);
  assert.equal(projectOfCwd("C:\\U\\Code\\x", ["c:/u/code"], true), "c:/u/code");
});
