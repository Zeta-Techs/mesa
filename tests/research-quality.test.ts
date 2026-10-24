import { researchToolContractMatches } from "../src/research-tools.ts";
import { appendUpstreamAcceptance } from "../src/research-acceptance.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { PIPELINE_TEMPLATES, pipelineStepsForTemplate, settingsForTemplateApply } from "../src/pipeline-presets.ts";
import { decisionGate, formatDecisionAnswer, parseDecisions, recommendedAnswers, upsertDecisions } from "../src/step-decisions.ts";
import { renderTaskMd } from "../src/task-md.ts";

const template = (id: string) => PIPELINE_TEMPLATES.find((t) => t.id === id)!;
const step = (id: string, workspace: string) => template(id).steps.find((s) => s.workspaceName === workspace)!;
const skill = (name: string) => readFileSync(`src-tauri/resources/skills/${name}/SKILL.md`, "utf8");
const md = (id: string, workspace: string) => renderTaskMd(step(id, workspace), {
  workMode: "research", artifactDir: "artifacts", resources: [], steps: template(id).steps,
  settings: settingsForTemplateApply(template(id)), rulesOwned: true,
}, "/research/project");

test("六套模板阶段数固定，科研论文多一步论文大纲，不另建自动编排", () => {
  assert.deepEqual(PIPELINE_TEMPLATES.map((t) => [t.id, t.steps.length]), [
    ["review", 5], ["research-paper", 8], ["data-processing", 4], ["thesis", 8],
    ["submission-rebuttal", 2], ["latex-paper", 4],
  ]);
});

test("关键开工必须有人的证据答案，不接受空草稿、讨论种子或一键推荐", () => {
  for (const [id, workspace] of [
    ["research-paper", "exp-design"], ["research-paper", "exp-run"],
    ["thesis", "methodology"], ["thesis", "thesis-exp-run"],
    ["data-processing", "data-clean"], ["data-processing", "data-eda"],
  ]) {
    const s = step(id, workspace);
    assert.equal(s.decisionMode, "hard_pause", workspace);
    assert.ok((s.decisions?.length ?? 0) > 0);
    assert.equal(decisionGate(s, "").blocked, true);
    assert.equal(decisionGate(s, s.brief).blocked, true, "简报不能充当人工回答");
    assert.deepEqual(recommendedAnswers(s.decisions!, new Map()), []);
    const draft = upsertDecisions("# 任务书\n保留正文", s.decisions!.map((d) => ({ q: d.q, answer: formatDecisionAnswer("approve", "人已阅 design v2；仅批准范围 A；证据见评阅记录") })));
    assert.equal(decisionGate(s, draft).blocked, false);
    assert.ok(draft.includes("保留正文"));
    assert.match(md(id, workspace), /不得自行采用推荐值/);
  }
});

test("正式实验均携带 G2/G3、冻结计划、实现检查及全矩阵运行证据", () => {
  for (const [id, design, run] of [["research-paper", "exp-design", "exp-run"], ["thesis", "methodology", "thesis-exp-run"]]) {
    assert.match(md(id, design), /G2 设计与分析计划/);
    for (const token of ["已看过", "训练折", "测试结果", "停止规则", "必要伦理", "总成本", "备选方案"]) assert.ok(md(id, design).includes(token), token);
    const s = step(id, run);
    for (const path of ["results/run-manifest.json", "results/implementation-check.md", "results/matrix.json"]) assert.ok(s.expectedArtifacts.includes(path));
    assert.ok(s.inputs?.includes("experiments/matrix.json"));
    assert.ok(s.acceptanceCriteria?.includes("machine:same-ids:experiments/matrix.json::results/matrix.json"));
    assert.ok(s.acceptanceCriteria?.includes("machine:same-ids:experiments/matrix.json::results/run-manifest.json"));
    for (const token of ["G3 数据与实现", "已知答案", "dataHash", "codeVersion", "environment", "command", "随机种子", "备份", "不覆盖旧运行"]) assert.ok(md(id, run).includes(token), token);
  }
});

test("三套文献链都有稳定 ID、全文状态与笔记覆盖，而非仅一篇非空笔记", () => {
  for (const id of ["review", "research-paper", "thesis"]) {
    const search = template(id).steps.find((s) => s.skills.includes("lit-search"))!;
    const notes = template(id).steps.find((s) => s.skills.includes("lit-notes"))!;
    assert.ok(search.expectedArtifacts.includes("papers/included.json"), id);
    assert.ok(search.acceptanceCriteria?.includes("machine:records-allow-empty:papers/included.json::id,title,decision,reason"), id);
    assert.ok(notes.inputs?.includes("papers/included.json"), id);
    assert.ok(notes.expectedArtifacts.includes("notes/index.json"), id);
    assert.ok(notes.acceptanceCriteria?.includes("machine:same-ids:papers/included.json::notes/index.json"), id);
    assert.ok(notes.acceptanceCriteria?.some((x) => x.includes("fulltextStatus,reviewStatus")), id);
  }
  assert.match(skill("lit-notes"), /无实际 PDF 不伪造来源锚点/);
  assert.match(skill("lit-notes"), /中途 git 提交只保存进度/);
  assert.match(skill("lit-notes"), /不得结束本轮等人/);
  assert.match(skill("lit-search"), /同一研究多个报告/);
  assert.match(skill("lit-search"), /严格检索不等于完整系统综述/);
});

test("十类失败模式在真实 TASK.md/技能中对应拦截要求，不宣称模型必然遵从", () => {
  const cases: [string, string, RegExp][] = [
    ["猜题", md("review", "lit-search"), /等待人确认后正式筛选/],
    ["摘要冒充全文", md("review", "outline"), /摘要-only.*核心全文未得则收窄结论或阻塞/],
    ["真引用不支持论断", md("review", "polish"), /主要论断必须有支持性核验/],
    ["数据泄漏", md("research-paper", "exp-design"), /所有拟合型预处理仅在训练折学习/],
    ["探索后补检验", skill("data-eda"), /同数据探索后补 p 值.*不满足升级条件/],
    ["指标实现错误", md("research-paper", "exp-run"), /已知答案或独立实现/],
    ["便利性裁剪", md("research-paper", "exp-run"), /不按易完成\/结果好坏挑组合/],
    ["计划漏项", md("thesis", "thesis-exp-run"), /machine:same-ids:experiments\/matrix.json::results\/matrix.json/],
    ["复用失效结果", md("research-paper", "exp-analysis"), /未经重验不得复用旧结论/],
    ["占位即通过", md("submission-rebuttal", "submission-materials"), /无法解决则阻塞，不以说明理由代替解决/],
  ];
  for (const [name, text, pattern] of cases) assert.match(text, pattern, name);
});

test("G4 独立复算和 G5 人工放行/归档覆盖两种实证与全部成稿出口", () => {
  for (const [id, workspace] of [["research-paper", "exp-analysis"], ["thesis", "thesis-exp-analysis"]]) {
    const text = md(id, workspace);
    for (const token of ["G4", "容差", "未覆盖范围", "独立实现", "主要论断—证据", "人裁决", "不多数投票"]) assert.ok(text.includes(token), token);
  }
  for (const [id, workspace] of [["review", "polish"], ["research-paper", "research-paper-polish"], ["thesis", "thesis-final"], ["submission-rebuttal", "submission-materials"], ["latex-paper", "latex-final"]]) {
    const text = md(id, workspace);
    for (const token of ["G5", "阻塞", "共同作者同意", "AI 使用披露", "归档", "回执", "更正/撤回", "不得代签"]) assert.ok(text.includes(token), `${workspace}/${token}`);
  }
  const revision = pipelineStepsForTemplate(template("submission-rebuttal"), "revision", 3)[0];
  assert.match(revision.brief, /设计→执行→分析→复算/);
  assert.match(revision.brief, /只有计划时维持阻塞/);
  assert.ok(revision.expectedArtifacts.includes("manuscript/revised-r3.md"));
});

test("数据处理保留原始数据、逐字段对账、探索等级和下游版本依赖", () => {
  const clean = step("data-processing", "data-clean");
  assert.ok(clean.inputs?.includes("data/fields.json"));
  assert.ok(clean.expectedArtifacts.includes("cleaning/fields.json"));
  assert.ok(clean.acceptanceCriteria?.includes("machine:same-ids:data/fields.json::cleaning/fields.json"));
  assert.match(md("data-processing", "data-inspect"), /不向模型或外部服务发送敏感行/);
  assert.match(skill("data-clean"), /只读原始数据/);
  assert.match(skill("data-clean"), /未批准不得应用/);
  assert.ok(step("data-processing", "data-report").inputs?.includes("cleaning/cleaned-data-manifest.md"));
  assert.match(md("data-processing", "data-report"), /不因列入局限就升级为结论/);
});

test("移除旧的不安全默认和机械配额，保留科学否定/探索的合法出口", () => {
  const all = PIPELINE_TEMPLATES.flatMap((t) => t.steps).map((s) => s.brief).join("\n");
  assert.doesNotMatch(all, /若未回复则按|按该假设执行到底|换用公开替代品并标注|至少 2 个|强相关对（\|r\|≥0.7）/);
  assert.match(all, /证据不足/);
  assert.match(skill("review-writing"), /不能改为“X 已确立”/);
  assert.match(skill("review-framework"), /不按空白数量评分/);
  assert.match(skill("stats-check"), /不凭正态性检验结果机械换检验/);
  assert.match(skill("bib-check"), /本技能不静默扩大为内容裁决/);
});

test("TASK.md 通用人工事项不把文件出现或 Agent 自评当批准", () => {
  const text = md("research-paper", "exp-run");
  assert.match(text, /有文件不代表已获批准/);
  assert.match(text, /人工批准不得由 Agent 代填/);
  assert.match(text, /报告已生成与问题已解决分开/);
  const custom = pipelineStepsForTemplate({ id: "custom", name: "自定义", description: "", steps: [{ name: "普通", brief: "做事", expectedArtifacts: ["result.md"], skills: [], run: [] }] })[0];
  assert.equal(custom.decisionMode, undefined, "不得把内置科研决策模式套到用户模板");
  assert.doesNotMatch(custom.brief, /G[1-5]/);
});

// Exercise the editor's actual pure conversion functions without mounting React/Tauri.
// Transpiling those AST nodes keeps the assertion on production code, not a parallel implementation.
test("流程编辑器读取再保存不会丢掉手写依据与硬暂停", () => {
  const source = readFileSync("src/components/PipelineEditor.tsx", "utf8");
  const file = ts.createSourceFile("PipelineEditor.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = file.statements.filter((n) => ts.isFunctionDeclaration(n) && ["toDraft", "toStep"].includes(n.name?.text ?? ""));
  assert.equal(functions.length, 2);
  const js = ts.transpileModule(functions.map((n) => n.getText(file)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const roundtrip = vm.runInNewContext(`${js}\n(s) => toStep(toDraft(s), 0)`);
  const original = structuredClone(step("research-paper", "exp-run"));
  original.humanTasks = []; // This test isolates decision conversion; human normalization has separate semantics.
  const result = JSON.parse(JSON.stringify(roundtrip(original)));
  assert.equal(result.decisionMode, "hard_pause");
  assert.deepEqual(result.decisions, original.decisions);
  assert.equal(decisionGate(result, "").blocked, true);
  assert.deepEqual(recommendedAnswers(result.decisions, new Map()), []);
  assert.deepEqual(result.acceptanceCriteria.filter((x: string) => x.startsWith("machine:")), original.acceptanceCriteria!.filter((x) => x.startsWith("machine:")));
});

test("有文件落点的科研人工判断仍须手动确认，不能以产物出现自动完成", () => {
  for (const [id, workspace] of [["research-paper", "research-paper-polish"], ["submission-rebuttal", "submission-materials"], ["data-processing", "data-inspect"]]) {
    const tasks = step(id, workspace).humanTasks!.filter((h) => h.timing === "after");
    assert.ok(tasks.length > 0);
    for (const task of tasks) {
      // 「逐条决定审查报告」「逐条裁决」的完成条件就是裁决清单清空（decisions_cleared，5a86579
      // 引入；逐条裁决 2026-10-24 推到论文定稿），不算「以产物出现自动完成」；其余人工判断仍须手动勾选
      const expected =
        task.title === "逐条决定审查报告" || task.title.startsWith("逐条裁决") ? "decisions_cleared" : "manual";
      assert.equal(task.completion, expected, task.title);
    }
  }
  for (const [id, workspace] of [["research-paper", "exp-run"], ["thesis", "thesis-exp-run"]]) {
    const ethical = step(id, workspace).humanTasks!.find((h) => h.title.includes("伦理/数据许可"))!;
    assert.ok(ethical);
    assert.notEqual(ethical.optional, true);
    assert.equal(ethical.completion, "manual");
  }
});

test("大纲、结论条目和先报告后改稿落在对应步骤", () => {
  assert.equal(step("research-paper", "paper-outline").expectedArtifacts[0], "manuscript/outline.md");
  assert.match(md("research-paper", "exp-analysis"), /## 结论条目/);
  assert.match(md("data-processing", "data-eda"), /## 结论条目/);
  assert.match(md("thesis", "thesis-exp-analysis"), /## 结论条目/);
  assert.match(md("research-paper", "lit-survey-gap"), /已批准问题与范围/);
  assert.match(md("thesis", "proposal"), /已批准问题与范围/);
  assert.match(md("research-paper", "exp-design"), /已批准设计/);
  assert.match(md("research-paper", "exp-run"), /已批准范围/);
  for (const [id, workspace] of [["review", "polish"], ["research-paper", "research-paper-polish"], ["thesis", "thesis-final"], ["latex-paper", "latex-final"], ["submission-rebuttal", "journal-format"]]) {
    assert.match(md(id, workspace), /禁止边查边改已有成稿/, workspace);
  }
  assert.match(md("review", "draft"), /section-status/);
  assert.match(md("research-paper", "paper-draft"), /section-status/);
  const revision = pipelineStepsForTemplate(template("submission-rebuttal"), "revision", 1)[0];
  assert.match(revision.brief, /review-report-r1/);
  assert.ok(revision.expectedArtifacts.includes("rebuttal/review-report-r1.md"));
});

test("质量证据声明为实际输入并进入验收合同，自定义模板不被套科研条件", () => {
  assert.ok(step("research-paper", "research-paper-polish").inputs?.includes("analysis/stats-check-results.md"));
  assert.ok(step("thesis", "thesis-final").inputs?.includes("analysis/thesis-results-stats-check.md"));
  assert.ok(step("submission-rebuttal", "submission-materials").inputs?.includes("submission/citation-check.md"));
  for (const t of PIPELINE_TEMPLATES) {
    for (const s of t.steps) {
      assert.ok(s.acceptanceCriteria?.some((x) => x.includes("人工质量验收")), s.workspaceName);
      assert.ok(s.brief.includes("质量状态与未决事项"), s.workspaceName);
    }
  }
  const revision = pipelineStepsForTemplate(template("submission-rebuttal"), "revision", 2)[0];
  assert.ok(revision.acceptanceCriteria?.some((x) => x.includes("人工质量验收")));
  const custom = pipelineStepsForTemplate({ id: "custom", name: "custom", description: "", steps: [{ name: "test", brief: "", expectedArtifacts: ["x.md"], skills: [], run: [] }] })[0];
  assert.ok(!custom.acceptanceCriteria?.some((x) => x.includes("G1–G5")));
});

test("实际开工链：未答决定或任务书写入失败时不会调用终端启动", async () => {
  const source = readFileSync("src/pipeline-start.ts", "utf8");
  const file = ts.createSourceFile("pipeline-start.ts", source, ts.ScriptTarget.Latest, true);
  const fn = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "startPipelineStep");
  assert.ok(fn);
  const js = ts.transpileModule(fn.getText(file).replace("export async", "async"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const s = step("research-paper", "exp-run");
  const cfg = { workMode: "research", artifactDir: "artifacts", resources: [], steps: template("research-paper").steps };
  const calls: string[] = [];
  const writes: string[] = [];
  let failWrite = false;
  const start = vm.runInNewContext(`${js}\nstartPipelineStep`, {
    parseDecisions,
    appendUpstreamAcceptance,
    researchToolContractMatches,
    decisionGate,
    renderTaskMd,
    DEFAULT_KICKOFF_PROMPT: "读 TASK.md，按简报开始执行",
    isGitMissingError: () => false,
    gatherTaskMdExtras: async () => ({ artifacts: [], skillMeta: undefined, decisions: [] }),
    invoke: async (command: string, args: Record<string, any>) => {
      calls.push(command);
      if (command === "research_upstream_acceptances") return [];
      if (command === "research_tool_preflight") return [];
      if (command === "create_workspace") return { name: s.workspaceName, worktreePath: "/isolated/project" };
      if (command === "write_workspace_task_md") {
        if (failWrite) throw new Error("disk full");
        writes.push(args.content);
      }
      return {};
    },
  });
  const opts = { projectPath: "/research/project", step: s, cfg, launch: { agentId: "codex", profileId: "test" }, onError: () => {}, onOpenTerminal: () => { calls.push("open_terminal"); } };
  await assert.rejects(start(opts), /硬暂停/);
  assert.deepEqual(calls, [], "未回答决定不可创建工作区或启动");
  const approved = upsertDecisions(md("research-paper", "exp-run"), s.decisions!.map((d) => ({ q: d.q, answer: formatDecisionAnswer("approve", "design v3，批准范围和许可见人工评阅") })));
  failWrite = true;
  await assert.rejects(start({ ...opts, taskMdOverride: approved }), /未启动 Agent.*disk full/);
  assert.deepEqual(calls, ["research_upstream_acceptances", "ensure_git_repo", "commit_project_bootstrap", "create_workspace", "write_workspace_task_md"]);
  assert.equal(writes.length, 0);
  calls.length = 0;
  failWrite = false;
  await start({ ...opts, taskMdOverride: approved });
  assert.equal(calls.at(-1), "open_terminal");
  assert.equal(writes[0], approved);
  assert.match(writes[0], /G3 数据与实现/);
});
