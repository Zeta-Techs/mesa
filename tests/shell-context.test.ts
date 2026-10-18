import test from "node:test";
import assert from "node:assert/strict";
import {
  runActivitySummary,
  shellContextPlacement,
  shellMode,
} from "../src/shell-context.ts";
import type { RunOverviewInput } from "../src/run-overview.ts";

const run = (over: Partial<RunOverviewInput>): RunOverviewInput => ({
  tabId: "t",
  title: "",
  agentId: "claude-code",
  model: "",
  cwd: "/u/proj",
  running: true,
  shell: false,
  attention: null,
  ...over,
});

test("侧栏三形态：展开时顶栏左侧不放任何重复信息", () => {
  assert.equal(shellMode(false, false), "expanded");
  assert.equal(shellMode(true, false), "collapsed");
  assert.equal(shellMode(true, true), "hidden");
  for (const page of ["workbench", "workspaces", "settings"]) {
    assert.deepEqual(shellContextPlacement("expanded", page), {
      projectChip: false,
      activity: "none",
    });
  }
});

test("图标态：项目芯片常驻（文件夹只管去项目页，项目页里也要能切），活动在顶栏", () => {
  for (const page of ["workspaces", "terminal"]) {
    assert.deepEqual(shellContextPlacement("collapsed", page), {
      projectChip: true,
      activity: "titlebar",
    });
  }
});

test("全隐藏：项目芯片常驻（唯一切项目入口），活动进灵动岛", () => {
  for (const page of ["workspaces", "workbench"]) {
    assert.deepEqual(shellContextPlacement("hidden", page), {
      projectChip: true,
      activity: "island",
    });
  }
});

test("运行摘要：shell 不算、待确认排最前、短句先报待确认", () => {
  const s = runActivitySummary(
    [
      run({ tabId: "a", title: "写综述", attention: "working" }),
      run({ tabId: "b", title: "", cwd: "/u/blender", attention: "confirm" }),
      run({ tabId: "c", shell: true }),
      run({ tabId: "d", running: false }),
    ],
    5,
  );
  assert.deepEqual(
    s.agents.map((a) => [a.tabId, a.label, a.state]),
    [
      ["b", "blender", "confirm"],
      ["a", "写综述", "working"],
    ],
  );
  assert.equal(s.confirm, 1);
  assert.equal(s.running, 2);
  assert.equal(s.external, 0, "有终端标签时外部会话不另报");
  assert.equal(s.tone, "confirm");
  assert.equal(s.label, "1 待确认 · 2 运行中");
});

test("运行摘要：全员待确认只报待确认；只有外部会话时回落外部数", () => {
  assert.equal(
    runActivitySummary([run({ attention: "confirm" })], 0).label,
    "1 待确认",
  );
  const ext = runActivitySummary([], 3);
  assert.deepEqual([ext.running, ext.external, ext.tone, ext.label], [3, 3, "running", "3 运行中"]);
  const idle = runActivitySummary([], 0);
  assert.deepEqual([idle.tone, idle.label], ["idle", ""]);
});
