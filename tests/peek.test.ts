import assert from "node:assert/strict";
import test from "node:test";
import { openPeerCount, peekSectionLines } from "../src/peek.ts";
import { renderTaskMd } from "../src/task-md.ts";
import type { ProjectConfigDto, ProjectStepDto } from "../src/types.ts";

test("只数开着的、不是内部后台也不是登录的", () => {
  const runs = [
    { closedAt: null, internal: false, taskKind: "pipeline_step" },
    { closedAt: "2026-11-03T10:00:00Z", internal: false, taskKind: "scratch" },
    { closedAt: null, internal: true, taskKind: "scratch" },
    { closedAt: null, internal: false, taskKind: "login" },
    { closedAt: null, internal: false, taskKind: "free_research" },
  ];
  assert.equal(openPeerCount(runs), 2);
});

test("有其他工作才在任务书带「同项目的其他工作」，按平台写调用法", () => {
  const step = { name: "综述初稿", workspaceName: "draft", brief: "写初稿。", expectedArtifacts: ["manuscript/draft.md"], skills: [], run: [] } as ProjectStepDto;
  const cfg = { artifactDir: "artifacts", resources: [], steps: [] } as ProjectConfigDto;
  assert.ok(!renderTaskMd(step, cfg, "/p").includes("同项目的其他工作"));
  const md = renderTaskMd(step, cfg, "/p", undefined, undefined, undefined, undefined, false, undefined, 2);
  assert.ok(md.includes("## 同项目的其他工作"));
  assert.ok(md.includes('还有 2 段别的工作开着'));
  assert.ok(md.includes('`"$MESA_PEEK_TOOL" peek agents`'));
  assert.ok(md.includes("别人工作副本里的文件不要改"));
  assert.ok(peekSectionLines(1, true).join("\n").includes("`& $env:MESA_PEEK_TOOL peek agents`"));
  assert.deepEqual(peekSectionLines(0, false), []);
});
