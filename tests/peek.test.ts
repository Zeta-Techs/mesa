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
  // Windows 上 Claude Code 的命令工具是 Git Bash，跑不了 & $env:…，要带 bash 写法
  assert.ok(peekSectionLines(1, true).join("\n").includes('`"$MESA_PEEK_TOOL"`'));
  assert.ok(!peekSectionLines(1, false).join("\n").includes("Git Bash"));
  assert.deepEqual(peekSectionLines(0, false), []);
});

test("项目说明：同项目有别的工作开着才带「看一眼」那一句", async () => {
  const { renderProjectContextPack } = await import("../src/project-context.ts");
  const base = { name: "综述", path: "/p", workMode: "research", kind: "session" as const, settings: [], topLevel: [] };
  assert.ok(!renderProjectContextPack(base).includes("MESA_PEEK_TOOL"));
  const text = renderProjectContextPack({ ...base, peers: 2 });
  assert.ok(text.includes('同项目还有 2 段别的工作开着'), text);
  assert.ok(text.includes('`"$MESA_PEEK_TOOL" peek agents`'), text);
  assert.ok(renderProjectContextPack({ ...base, peers: 1, isWindows: true }).includes("`& $env:MESA_PEEK_TOOL peek agents`"));
});

test("留话：工作台摘要与每条状态字", async () => {
  const { mailStatusText, mailSummary } = await import("../src/project-mail.ts");
  const mails = [
    { status: "pending" as const, toOpen: true },
    { status: "pending" as const, toOpen: false },
    { status: "delivered" as const, toOpen: true },
  ];
  assert.equal(mailSummary(mails), "留话 3 条，1 条等对方空闲");
  assert.equal(mailStatusText(mails[1]), "对方已结束，送不到");
  assert.equal(mailStatusText(mails[2]), "已送到");
  assert.equal(mailSummary([mails[2]]), "留话 1 条");
  assert.ok(peekSectionLines(1, false).join("\n").includes('tell --to 名字 "要说的话"'));
});

test("任务面板改动行：加减、二进制、新文件", async () => {
  const { changeLine } = await import("../src/peek.ts");
  assert.equal(changeLine({ added: "12", removed: "3", newFile: false }), "+12 −3");
  assert.equal(changeLine({ added: "-", removed: "-", newFile: false }), "二进制");
  assert.equal(changeLine({ added: "", removed: "", newFile: true }), "新文件");
});
