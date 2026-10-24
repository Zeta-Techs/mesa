import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { renderTaskMd } from "../src/task-md.ts";
import { PIPELINE_TEMPLATES, settingsForTemplateApply } from "../src/pipeline-presets.ts";
import { KEEP_WORKING_CLAUSE } from "../src/step-decisions.ts";
import { accumulationChip, formatKickoffChip } from "../src/kickoff-inputs.ts";
import {
  countNonCommentLines,
  intakeBridgeHits,
  intakeBridgeLabel,
  intakeBridgeSurfaceKind,
  summarizeIntakeBridge,
} from "../src/kickoff-dirty-gate.ts";
import type { ProjectConfigDto, ProjectStepDto } from "../src/types.ts";

function step(partial: Partial<ProjectStepDto> = {}): ProjectStepDto {
  return {
    name: "清洗与整理",
    workspaceName: "data-clean",
    brief: "做清洗。",
    expectedArtifacts: ["cleaning/rules.md"],
    skills: [],
    run: [],
    ...partial,
  };
}

function cfg(partial: Partial<ProjectConfigDto> = {}): ProjectConfigDto {
  return {
    artifactDir: "artifacts",
    resources: [],
    steps: [],
    ...partial,
  };
}

test("TASK.md 派生产物写本工作区、文献 PDF 直写项目根", () => {
  const md = renderTaskMd(step(), cfg(), "/Users/me/proj");
  assert.match(md, /项目根：`\/Users\/me\/proj`/);
  assert.match(md, /`\/Users\/me\/proj\/papers\/`/);
  assert.match(md, /本工作区的 `artifacts\/` 或 `output\/`（相对路径）/);
  assert.match(md, /评审合并进主仓时自动带到项目根同名目录/);
  assert.match(md, /项目根相对路径（如 artifacts\/xxx\.csv）/);
  assert.doesNotMatch(md, /`\/Users\/me\/proj\/artifacts`/);
  assert.doesNotMatch(md, /`\/Users\/me\/proj\/output\/`/);
});

test("TASK.md 产物目录：要提交的脚本放 scripts/，产物目录只放一次性脚本和缓存", () => {
  const md = renderTaskMd(step(), cfg(), "/tmp/p");
  assert.match(md, /简报没指定就放 `scripts\/`（进 git）/);
  assert.match(md, /`artifacts\/` 不进 git，只放一次性调试脚本和接口缓存/);
});

test("TASK.md 收尾：派生产物走工作区，直写项目根的是未验收产物", () => {
  const md = renderTaskMd(step(), cfg(), "/tmp/p");
  assert.match(md, /派生产物只写本工作区产物目录/);
  assert.match(md, /文献 PDF 写项目根 papers\//);
  assert.doesNotMatch(md, /必须落在上方项目根对应目录/);
  assert.match(md, /决策暂停策略/);
  assert.match(md, /本步中途没有必须等人拍板的事项/);
  assert.match(md, /一批工作、一次 git 提交或进度汇报不是停工理由/);
  assert.match(md, /停工门见上文「决策暂停策略」/);
  assert.doesNotMatch(md, /完成时把本步源稿、脚本与清单全部 git 提交——不提交/);
});

test("六套模板的 TASK.md 都带本步停工清单，格式步要停下来看样张", () => {
  for (const t of PIPELINE_TEMPLATES) {
    const cfg: ProjectConfigDto = {
      artifactDir: "artifacts",
      resources: [],
      steps: t.steps,
      settings: settingsForTemplateApply(t),
      rulesOwned: true,
    };
    for (const s of t.steps) {
      const md = renderTaskMd(s, cfg, "/pilot/project");
      assert.ok(md.includes(KEEP_WORKING_CLAUSE), `${t.id}/${s.name} 缺做到做完`);
      assert.match(md, /本步必须停下来等你|本步中途没有必须等人拍板的事项/);
    }
  }
  const format = PIPELINE_TEMPLATES.find((t) => t.id === "submission-rebuttal")!
    .steps.find((s) => s.workspaceName === "journal-format")!;
  const md = renderTaskMd(format, {
    artifactDir: "artifacts", resources: [], steps: [format],
  }, "/pilot/project");
  assert.match(md, /开工前等你做完：放入成稿/);
  assert.match(md, /渲染出样张后停下来让你看版式/);
});

test("TASK.md 不含目标验收的「保持原样」段", () => {
  const md = renderTaskMd(
    step(),
    cfg({
      workMode: "research",
      steps: [step()],
      protectedPaths: ["数据/raw"],
    }),
    "/tmp/p",
  );
  assert.doesNotMatch(md, /保持原样/);
  assert.doesNotMatch(md, /数据\/raw/);
});

test("TASK.md 项目规则不含未填的全局设定空表", () => {
  const md = renderTaskMd(
    step(),
    cfg({
      workMode: "research",
      settings: [
        "优先使用项目里已有的 papers/、notes/ 和 references.bib，不要虚构文献。",
        "综述角度：（领域全景 / 聚焦某个子问题）",
        "答辩时间：（倒推各章节的截止）",
        "综述角度：聚焦某个子问题",
      ],
    }),
    "/tmp/p",
  );
  assert.match(md, /不要虚构文献/);
  assert.match(md, /综述角度：聚焦某个子问题/);
  const rules = md.split("## 待确认的全局设定")[0];
  assert.doesNotMatch(rules, /答辩时间/);
  assert.doesNotMatch(rules, /领域全景/);
  assert.match(md, /## 待确认的全局设定/);
  assert.match(md, /答辩时间：（倒推各章节的截止）/);
  assert.match(md, /先逐项问人/);
});

test("TASK.md 简报占位按挂载名单解析：换技能后正文跟随（2026-10-11 个性化机制）", () => {
  const s = step();
  s.brief = "全程按 {skill:lit-search} 技能执行，写法见 {skill:lit-notes} 技能。";
  s.skills = ["my-search", "lit-notes"];
  // 用户技能声明 provides: [lit-search] → 顶位；lit-notes 无顶位者 → 名字兜底
  const provides = { "my-search": ["lit-search"] };
  const md = renderTaskMd(s, cfg(), "/tmp/p", undefined, undefined, provides);
  assert.match(md, /全程按 my-search 技能执行/);
  assert.match(md, /写法见 lit-notes 技能/);
  assert.doesNotMatch(md, /\{skill:/);
  // 位空缺：渲染成锚名可读形态（校验层负责提醒）
  s.skills = ["lit-notes"];
  const md2 = renderTaskMd(s, cfg(), "/tmp/p", undefined, undefined, provides);
  assert.match(md2, /全程按 lit-search 技能执行/);
  assert.doesNotMatch(md2, /\{skill:/);
});

test("积累面命中：正典清单与笔记算，inbox / 积累账 / 其他文件不算", () => {
  assert.equal(intakeBridgeSurfaceKind("papers/included.md"), "ledger");
  assert.equal(intakeBridgeSurfaceKind("papers/included.json"), "ledger");
  assert.equal(intakeBridgeSurfaceKind("papers/to-fetch.md"), "ledger");
  assert.equal(intakeBridgeSurfaceKind("papers/to-fetch.ris"), "ledger");
  assert.equal(intakeBridgeSurfaceKind("notes/a.md"), "notes");
  assert.equal(intakeBridgeSurfaceKind("notes/sub/deep/b.md"), "notes");
  // inbox.md 已 gitignored（显式排除是双保险）；reading-list 是积累账，走快照不走 git
  assert.equal(intakeBridgeSurfaceKind("notes/inbox.md"), null);
  assert.equal(intakeBridgeSurfaceKind("papers/reading-list.md"), null);
  assert.equal(intakeBridgeSurfaceKind("papers/screening.md"), null);
  assert.equal(intakeBridgeSurfaceKind("notes/index.json"), null);
  const hits = intakeBridgeHits([
    { path: "papers/included.md" },
    { path: "notes/01.md" },
    { path: "papers/screening.md" },
    { path: "notes/inbox.md" },
    { path: "src/main.rs" },
  ]);
  assert.deepEqual(hits, [
    { path: "papers/included.md", kind: "ledger" },
    { path: "notes/01.md", kind: "notes" },
  ]);
});

test("接驳摘要：清单 md 数主仓非注释行、笔记按份数，标签按命中段拼", () => {
  const hits = intakeBridgeHits([
    { path: "papers/included.md" },
    { path: "papers/to-fetch.ris" },
    { path: "notes/a.md" },
    { path: "notes/b.md" },
  ]);
  const summary = summarizeIntakeBridge(hits, {
    "papers/included.md": "# 清单\n\nA — B, 2020 — C — D\nE — F, 2021 — G — H\n",
  });
  assert.equal(summary.ledgerLines, 2);
  assert.equal(summary.notesCount, 2);
  assert.equal(
    intakeBridgeLabel(summary, hits.filter((h) => h.kind === "ledger").length),
    "清单 2 条新行 / 2 篇未提交笔记",
  );
  // 只有结构化清单（json/ris，无数可数）→ 兜底段；只有笔记 → 只出笔记段
  const onlyRis = summarizeIntakeBridge(hits.filter((h) => h.path.endsWith(".ris")), {});
  assert.equal(intakeBridgeLabel(onlyRis, 1), "清单文件待提交");
  const onlyNotes = summarizeIntakeBridge(hits.filter((h) => h.kind === "notes"), {});
  assert.equal(intakeBridgeLabel(onlyNotes, 0), "2 篇未提交笔记");
  assert.equal(countNonCommentLines("# 注释\n正文\n\n"), 1);
  // 已入库的 included.md 只改了一行：整份 72 行不能报成「72 条新行」
  const tracked = intakeBridgeHits([{ path: "papers/included.md", status: "M" }]);
  assert.deepEqual(tracked, [{ path: "papers/included.md", kind: "ledger", modified: true }]);
  const trackedSummary = summarizeIntakeBridge(tracked, { "papers/included.md": "A\nB\nC\n" });
  assert.equal(intakeBridgeLabel(trackedSummary, 1), "清单文件待提交");
  assert.equal(
    summarizeIntakeBridge(intakeBridgeHits([{ path: "papers/included.md", status: "??" }]), { "papers/included.md": "A\nB\n" }).ledgerLines,
    2,
  );
});

test("沉浸阅读截图跟笔记一起接驳，标签单列「笔记配图」", () => {
  assert.equal(intakeBridgeSurfaceKind("notes/assets/capture-1.png"), "asset");
  const files = intakeBridgeHits([{ path: "notes/a.md" }, { path: "notes/assets/c1.png" }, { path: "notes/assets/c2.png" }]);
  assert.equal(intakeBridgeLabel(summarizeIntakeBridge(files, {}), 0), "1 篇未提交笔记 / 2 张笔记配图");
  // 整个目录未跟踪时 git 只报一行目录，数不清张数
  const dir = intakeBridgeHits([{ path: "notes/assets/" }]);
  assert.equal(intakeBridgeLabel(summarizeIntakeBridge(dir, {}), 0), "笔记配图");
});

test("积累芯片：N 条才出场，标签固定「积累 N 条」", () => {
  assert.equal(accumulationChip(0, "/p/papers/reading-list.md"), null);
  const chip = accumulationChip(3, "/p/papers/reading-list.md")!;
  assert.equal(chip.role, "optional");
  assert.equal(chip.present, true);
  assert.equal(chip.previewPath, "/p/papers/reading-list.md");
  assert.deepEqual(formatKickoffChip(chip), { label: "积累 3 条", missing: false });
});

/**
 * startPipelineStep 开工接驳时序（2026-10-13 双台账）：真实链路经 @tauri-apps invoke，
 * 这里用 esbuild 打包 + 桩替换 invoke，钉三件事：
 * 1. 勾选且命中非空 → scoped git_commit（固定信息 + 路径）发生在 commit_project_bootstrap
 *    之后、create_workspace 之前；
 * 2. create_workspace 成功、TASK.md 落盘后 freeze_reading_list_intake（projectRoot +
 *    worktreePath），失败只经 onError 提示、链路继续走到终端交接；
 * 3. 未勾选 / 无命中不提交，但仍冻结积累账快照。
 * 注意：startPipelineStep 还被 research-quality.test.ts 以「提取函数体」方式在隔离上下文
 * 执行，本函数体禁引新的模块级标识符（提交信息用字面量），新增依赖须两边同改。
 */
async function bundleStartPipeline(): Promise<{
  startPipelineStep: (args: Record<string, unknown>) => Promise<void>;
}> {
  const bundle = await build({
    stdin: {
      contents: `export {startPipelineStep, buildWorkspaceTerminalRequest, wireWorkspaceLaunchGuard} from './src/pipeline-start';`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    plugins: [
      {
        name: "pipeline-start-host",
        setup(b) {
          const stubs: Record<string, string> = {
            "@tauri-apps/api/core":
              "export const invoke = async (cmd, args) => globalThis.__pipelineStartHost.invoke(cmd, args);",
          };
          b.onResolve({ filter: /.*/ }, (args) =>
            args.path in stubs
              ? { path: args.path, namespace: "pipeline-start-stub" }
              : undefined,
          );
          b.onLoad({ filter: /.*/, namespace: "pipeline-start-stub" }, (args) => ({
            contents: stubs[args.path],
            loader: "js",
          }));
        },
      },
    ],
  });
  const compiled = { exports: {} as Record<string, unknown> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(
    createRequire(import.meta.url),
    compiled,
    compiled.exports,
  );
  return compiled.exports as unknown as {
    startPipelineStep: (args: Record<string, unknown>) => Promise<void>;
    buildWorkspaceTerminalRequest: (ws: Record<string, unknown>, prompt?: string, opts?: Record<string, unknown>) => Promise<Record<string, unknown>>;
    wireWorkspaceLaunchGuard: (get: () => unknown) => void;
  };
}

interface SeqCall {
  cmd: string;
  args: Record<string, unknown>;
}

function installInvokeHost(
  overrides: Record<string, (args: Record<string, unknown>) => unknown> = {},
): { calls: SeqCall[]; errors: string[] } {
  const calls: SeqCall[] = [];
  const errors: string[] = [];
  const impl: Record<string, (args: Record<string, unknown>) => unknown> = {
    ensure_git_repo: () => ({}),
    commit_project_bootstrap: () => ({}),
    git_commit: () => ({}),
    create_workspace: () => ({
      id: "w1",
      name: "data-clean",
      repoPath: "/p",
      worktreePath: "/p/.mesa/ws-data-clean",
    }),
    freeze_reading_list_intake: () => true,
    write_workspace_task_md: () => null,
    research_upstream_acceptances: () => [],
    ...overrides,
  };
  (globalThis as { __pipelineStartHost?: unknown }).__pipelineStartHost = {
    invoke: async (cmd: string, args: Record<string, unknown>) => {
      calls.push({ cmd, args });
      const fn = impl[cmd];
      if (!fn) throw new Error(`测试未预期的命令：${cmd}`);
      return fn(args);
    },
  };
  return { calls, errors };
}

async function runStart(
  api: Awaited<ReturnType<typeof bundleStartPipeline>>,
  errors: string[],
  intakeBridge?: { accepted: boolean; paths: string[] },
): Promise<{ opened: boolean }> {
  let opened = false;
  await api.startPipelineStep({
    projectPath: "/p",
    step: step(),
    cfg: cfg({ steps: [step()] }),
    taskMdOverride: "# 任务书\n做清洗。",
    onError: (msg: string) => errors.push(msg),
    onOpenTerminal: async () => {
      opened = true;
    },
    ...(intakeBridge ? { intakeBridge } : {}),
  });
  return { opened };
}

test("开工接驳：scoped 提交在 bootstrap 后、建区前，冻结在任务书落盘后", async () => {
  const api = await bundleStartPipeline();
  const { calls, errors } = installInvokeHost();
  const { opened } = await runStart(api, errors, {
    accepted: true,
    paths: ["papers/included.md", "papers/to-fetch.ris", "notes/a.md"],
  });
  const order = calls.map((c) => c.cmd);
  const bootstrapAt = order.indexOf("commit_project_bootstrap");
  const commitAt = order.indexOf("git_commit");
  const createAt = order.indexOf("create_workspace");
  const writeAt = order.indexOf("write_workspace_task_md");
  const freezeAt = order.indexOf("freeze_reading_list_intake");
  assert.ok(bootstrapAt >= 0, "缺档案卡 bootstrap 提交");
  assert.ok(commitAt > bootstrapAt, "接驳提交必须晚于 bootstrap");
  assert.ok(createAt > commitAt, "接驳提交必须早于 create_workspace");
  assert.ok(freezeAt > createAt, "积累账冻结必须晚于 create_workspace");
  assert.ok(freezeAt > writeAt, "积累账冻结在任务书落盘之后");
  const commit = calls[commitAt];
  assert.equal(commit.args.cwd, "/p");
  assert.equal(commit.args.push, false);
  assert.deepEqual(commit.args.paths, [
    "papers/included.md",
    "papers/to-fetch.ris",
    "notes/a.md",
  ]);
  assert.equal(
    commit.args.message,
    "Mesa: 开工接驳——积累清单与笔记并入基准（开工确认）",
  );
  assert.deepEqual(calls[freezeAt].args, {
    projectRoot: "/p",
    worktreePath: "/p/.mesa/ws-data-clean",
  });
  assert.deepEqual(errors, []);
  assert.equal(opened, true);
});

test("冻结积累账失败只提示不阻断：链路仍交接终端", async () => {
  const api = await bundleStartPipeline();
  const { calls, errors } = installInvokeHost({
    freeze_reading_list_intake: () => {
      throw new Error("快照写入失败");
    },
  });
  const { opened } = await runStart(api, errors, {
    accepted: true,
    paths: ["papers/included.md"],
  });
  assert.equal(calls.filter((c) => c.cmd === "freeze_reading_list_intake").length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /积累清单快照写入失败（不影响开步）/);
  assert.equal(opened, true, "冻结失败后仍要交接终端");
});

test("未勾选不接驳提交；无命中不提交：两种情况都照常冻结快照", async () => {
  const api = await bundleStartPipeline();
  // 显式不勾选
  const off = installInvokeHost();
  await runStart(api, off.errors, { accepted: false, paths: ["papers/included.md"] });
  assert.equal(off.calls.some((c) => c.cmd === "git_commit"), false);
  assert.equal(off.calls.some((c) => c.cmd === "freeze_reading_list_intake"), true);
  assert.deepEqual(off.errors, []);
  // 无命中（paths 空）→ 不提交
  const none = installInvokeHost();
  await runStart(api, none.errors, { accepted: true, paths: [] });
  assert.equal(none.calls.some((c) => c.cmd === "git_commit"), false);
  assert.equal(none.calls.some((c) => c.cmd === "freeze_reading_list_intake"), true);
});


test("wsLast 记忆层闸门：停用连接不被自动预填（autoStart 落空），陈旧模型过名单校验", async () => {
  const api = await bundleStartPipeline();
  const ws = {
    id: "w1", repoPath: "/p", repoName: "p", name: "data-clean", branch: "ccode/data-clean",
    worktreePath: "/p/.mesa/ws-data-clean", baseBranch: "main", portBase: 4200,
    status: "active", createdAt: "2026-10-15T00:00:00Z", archivedAt: null,
  };
  const lsPrev = (globalThis as { localStorage?: unknown }).localStorage;
  const store: Record<string, string> = {};
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  };
  const prevHost = (globalThis as { __pipelineStartHost?: unknown }).__pipelineStartHost;
  (globalThis as { __pipelineStartHost?: unknown }).__pipelineStartHost = {
    invoke: async (cmd: string) => {
      if (cmd === "workspace_env_for") return [];
      if (cmd === "list_sessions") return [];
      throw new Error(`测试未预期的命令：${cmd}`);
    },
  };
  try {
    api.wireWorkspaceLaunchGuard(() => ({
      profiles: [
        { id: "p-disabled", models: ["m1"] },
        { id: "p-live", models: ["m2"] },
      ],
      hiddenProfiles: ["p-disabled"],
    }));
    // ① wsLast 指向停用连接：不预填、不自动拉起（StepFlow 无手选 autoStart 入口靠这道闸）
    store["ccode.wsLast./p/.mesa/ws-data-clean"] = JSON.stringify({ agentId: "codex", profileId: "p-disabled", model: "m1" });
    const req1 = await api.buildWorkspaceTerminalRequest(ws, "继续做到完成标准", { autoStart: true });
    assert.equal(req1.profileId, undefined, "停用连接不做预填");
    assert.equal(req1.autoStart, false, "记忆失效时降为预填不自动拉起");
    // ② wsLast 指向活连接但模型已不在名单：连接保留、模型落空（回落名单第一由启动侧兑）
    store["ccode.wsLast./p/.mesa/ws-data-clean"] = JSON.stringify({ agentId: "codex", profileId: "p-live", model: "gone-model" });
    const req2 = await api.buildWorkspaceTerminalRequest(ws, "继续做到完成标准", { autoStart: true });
    assert.equal(req2.profileId, "p-live");
    assert.equal(req2.model, undefined, "名单外模型不逐字注入");
    assert.equal(req2.autoStart, true);
    // ③ 未接线（wire 前置为 undefined 语义不可逆，这里只验证停用名单为空时照常预填）
    api.wireWorkspaceLaunchGuard(() => ({ profiles: [{ id: "p-disabled", models: ["m1"] }], hiddenProfiles: [] }));
    store["ccode.wsLast./p/.mesa/ws-data-clean"] = JSON.stringify({ agentId: "codex", profileId: "p-disabled", model: "m1" });
    const req3 = await api.buildWorkspaceTerminalRequest(ws, "继续做到完成标准", { autoStart: true });
    assert.equal(req3.profileId, "p-disabled", "未停用的记忆照常预填");
  } finally {
    if (lsPrev === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
    else (globalThis as { localStorage?: unknown }).localStorage = lsPrev;
    (globalThis as { __pipelineStartHost?: unknown }).__pipelineStartHost = prevHost;
  }
});

// 2026-10-23 HER 精读步：接回时只带连接不带模型，启动侧落到连接名单第一个（glm-5.3 接回成 glm-5.3-flash）
test("继续接回原对话：同一家 Agent 带上绑定的模型，不落到连接名单第一个", async () => {
  const api = await bundleStartPipeline();
  const ws = {
    id: "w1", repoPath: "/p", repoName: "p", name: "lit-notes", branch: "ccode/lit-notes",
    worktreePath: "/p/.mesa/ws-lit-notes", baseBranch: "main", portBase: 4200,
    status: "active", createdAt: "2026-10-22T00:00:00Z", archivedAt: null,
  };
  const session = {
    agent: "claude-code", sessionId: "s1", workspace: "lit-notes", projectPath: "/p",
    archived: false, internal: false, live: false,
  };
  const lsPrev = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const prevHost = (globalThis as { __pipelineStartHost?: unknown }).__pipelineStartHost;
  (globalThis as { __pipelineStartHost?: unknown }).__pipelineStartHost = {
    invoke: async (cmd: string) => {
      if (cmd === "workspace_env_for") return [];
      if (cmd === "list_sessions") return [session];
      throw new Error(`测试未预期的命令：${cmd}`);
    },
  };
  try {
    const bound = { agentId: "claude-code", profileId: "gw", model: "glm-5.3" };
    const req = await api.buildWorkspaceTerminalRequest(ws, "接着上次停下的地方继续", {
      autoStart: true, resumeSession: true, stepLaunch: bound,
    });
    assert.equal(req.resume?.sessionId, "s1");
    assert.equal(req.autoLaunchProfileId, "gw");
    assert.equal(req.model, "glm-5.3");
    // 绑定是另一家：接回的会话自选连接，不把别家的模型塞过去
    const other = await api.buildWorkspaceTerminalRequest(ws, "接着上次停下的地方继续", {
      autoStart: true, resumeSession: true, stepLaunch: { agentId: "codex", profileId: "cx", model: "gpt-x" },
    });
    assert.equal(other.resume?.sessionId, "s1");
    assert.equal(other.model, undefined);
  } finally {
    if (lsPrev === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
    else (globalThis as { localStorage?: unknown }).localStorage = lsPrev;
    (globalThis as { __pipelineStartHost?: unknown }).__pipelineStartHost = prevHost;
  }
});

test("TASK.md 本步骤脚本：只在 Windows、只列简报点名的 run 脚本；有 PowerShell 写法时两种都给", () => {
  const latex = PIPELINE_TEMPLATES.flatMap((t) => t.steps).find((s) =>
    s.run.some((r) => r.name === "render-pdf"),
  );
  assert.ok(latex, "LaTeX 模板应带 render-pdf");
  const render = latex.run.find((r) => r.name === "render-pdf")!;
  assert.ok(render.commandWindows, "render-pdf 必须带 PowerShell 写法");
  // PowerShell 5.1 不认 bash 语法；&& 只出现在 cmd /c 里
  assert.doesNotMatch(render.commandWindows!, /mkdir -p|command -v|\bfi\b|\/dev\/null/);
  assert.match(render.commandWindows!, /cmd \/d \/c exit \$rpExit/);

  const mac = renderTaskMd(latex, cfg(), "/p", undefined, undefined, undefined, undefined, false);
  assert.doesNotMatch(mac, /## 本步骤脚本/, "macOS 不占任务书篇幅");

  const win = renderTaskMd(latex, cfg(), "C:\\p", undefined, undefined, undefined, undefined, true);
  assert.match(win, /## 本步骤脚本（Windows）/);
  assert.match(win, /命令工具是 PowerShell 时：`New-Item -ItemType Directory -Force output/);
  assert.match(win, /命令工具是 Git Bash 时：`mkdir -p output/);
  assert.doesNotMatch(win, /没有给 PowerShell 写法的条目/);
});

test("TASK.md 本机 Python：只在 Windows 给出，-I 隔离模式要配 -X utf8", () => {
  const win = renderTaskMd(step(), cfg(), "C:\\p", undefined, undefined, undefined, undefined, true);
  assert.match(win, /## 本机 Python（Windows）/);
  assert.match(win, /不要用 `python3`/);
  assert.match(win, /`-I` 或 `-E`[^\n]*`-X utf8`/);
  assert.doesNotMatch(renderTaskMd(step(), cfg(), "/p"), /## 本机 Python/);
});

test("TASK.md 本机 Python：读 PDF 的步骤在 Windows 上提示用 PyMuPDF 抽字、转页图看图", () => {
  const notes = step({ skills: ["lit-notes"] });
  const win = renderTaskMd(notes, cfg(), "C:\\p", undefined, undefined, undefined, undefined, true);
  assert.match(win, /pdftoppm is not installed[^\n]*get_pixmap/);
  assert.doesNotMatch(renderTaskMd(step(), cfg(), "C:\\p", undefined, undefined, undefined, undefined, true), /pdftoppm/, "不读 PDF 的步骤不带");
  assert.doesNotMatch(renderTaskMd(notes, cfg(), "/p"), /pdftoppm/, "只在 Windows");
  // 大纲步一类：输入里写着要读原文 PDF，或项目资源挂着 PDF
  const outline = step({ inputs: ["17 篇主线批原文 PDF（路径见「项目资源」，只读）"] });
  assert.match(renderTaskMd(outline, cfg(), "C:\\p", undefined, undefined, undefined, undefined, true), /pdftoppm/);
  const withPdf = cfg({ resources: [{ name: "Fan 2022", path: "C:\\Zotero\\storage\\K\\Fan.pdf", type: "paper", readonly: true, note: "" }] });
  assert.match(renderTaskMd(step(), withPdf, "C:\\p", undefined, undefined, undefined, undefined, true), /pdftoppm/);
});

test("TASK.md 本步骤脚本：简报没点名的不列；只有 bash 写法的条目点名用 Git Bash", () => {
  const s = step({
    brief: "改完跑一次 run 脚本 prep，再跑 render-draft。",
    run: [
      { name: "render-draft", command: "quarto render manuscript/draft.md --to pdf", default: true },
      { name: "prep", command: "mkdir -p out && cp a out/", default: false },
      { name: "export-docx", command: "quarto render manuscript/draft.md --to docx", default: false },
    ],
  });
  const win = renderTaskMd(s, cfg(), "C:\\p", undefined, undefined, undefined, undefined, true);
  assert.match(win, /- render-draft：`quarto render manuscript\/draft\.md --to pdf`/);
  assert.match(win, /- prep：`mkdir -p out/);
  assert.doesNotMatch(win, /export-docx/, "简报没点名");
  assert.match(win, /用 Git Bash 执行/);
  const quartoOnly = step({ brief: "跑 render-draft。", run: [s.run[0]] });
  assert.doesNotMatch(renderTaskMd(quartoOnly, cfg(), "C:\\p", undefined, undefined, undefined, undefined, true), /用 Git Bash 执行/);
  assert.doesNotMatch(renderTaskMd(step(), cfg(), "/p"), /## 本步骤脚本/);
});

test("TASK.md 决策暂停策略带人工请求文件的用法：只放没答的、答完删、不提交", () => {
  const md = renderTaskMd(step(), cfg(), "/tmp/p");
  assert.match(md, /\.ccode\/help-wanted\.md 只放还没回答的问题/);
  assert.match(md, /人回复后把那一条删掉/);
  assert.match(md, /这个文件不提交/);
});
