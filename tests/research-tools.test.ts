import assert from "node:assert/strict";
import test from "node:test";
import { PIPELINE_TEMPLATES, pipelineStepsForTemplate } from "../src/pipeline-presets.ts";
import { DEFAULT_RESEARCH_TOOLS, researchToolAskFieldsForStep, researchToolFieldsForSteps, researchToolsFromSettings, settingsWithResearchTools, withResearchTools } from "../src/research-tools.ts";
import { conflictingTemplateSteps, renameConflictingSteps } from "../src/pipeline-append.ts";
import { parseReproductionContract } from "../src/research-report.ts";

const template = (id: string) => PIPELINE_TEMPLATES.find((t) => t.id === id)!;

test("工具设置保留项目规则且可切回默认；非法值不生效", () => {
  const tools = { ...DEFAULT_RESEARCH_TOOLS, plotting: "origin" as const, libraryExport: "endnote" as const };
  const settings = settingsWithResearchTools(["不改原始数据", "科研工具/未来字段：保留"], tools);
  assert.deepEqual(researchToolsFromSettings(settings), tools);
  assert.deepEqual(settingsWithResearchTools(settings, DEFAULT_RESEARCH_TOOLS), ["不改原始数据", "科研工具/未来字段：保留"]);
  assert.equal(researchToolsFromSettings(["科研工具/plotting：malformed"]).plotting, "python");
});

test("旧 literature 设置键写回时剥掉，不再当工具合同", () => {
  assert.deepEqual(researchToolsFromSettings(["科研工具/literature：zotero"]), DEFAULT_RESEARCH_TOOLS);
  assert.deepEqual(settingsWithResearchTools(["科研工具/literature：zotero", "不改原始数据"], DEFAULT_RESEARCH_TOOLS), ["不改原始数据"]);
});

test("选择 Origin 一次补齐相关步骤合同，重应用幂等，撤销不删手工技能", () => {
  const source = template("research-paper").steps.find((s) => s.name === "结果分析")!;
  const tools = { ...DEFAULT_RESEARCH_TOOLS, plotting: "origin" as const };
  const chosen = withResearchTools(source, tools);
  assert.ok(chosen.skills.includes("origin-plot"));
  assert.ok(chosen.requiredSkills?.includes("origin-plot"));
  assert.ok(chosen.expectedArtifacts.includes("analysis/plot_origin.py"));
  assert.ok(chosen.humanTasks?.some((h) => h.title.includes("Origin")));
  assert.deepEqual(withResearchTools(chosen, tools), chosen);
  const removed = withResearchTools(chosen, DEFAULT_RESEARCH_TOOLS);
  assert.deepEqual(removed.skills, source.skills);
  assert.deepEqual(removed.expectedArtifacts, source.expectedArtifacts);
  const manual = { ...source, skills: [...source.skills, "origin-plot"], requiredSkills: [...source.skills, "origin-plot"] };
  assert.ok(withResearchTools(withResearchTools(manual, tools), DEFAULT_RESEARCH_TOOLS).skills.includes("origin-plot"));
});

test("Blender 只挂研究设计/结构示意，不替代统计图；EndNote 交付不冒充检索来源", () => {
  const tools = { ...DEFAULT_RESEARCH_TOOLS, illustration: "blender" as const, libraryExport: "endnote" as const };
  const steps = template("research-paper").steps.map((s) => withResearchTools(s, tools));
  assert.ok(steps.find((s) => s.name === "实验设计")!.skills.includes("blender-research"));
  assert.ok(!steps.find((s) => s.name === "结果分析")!.skills.includes("blender-research"));
  assert.ok(!withResearchTools(template("review").steps.find((s) => s.workspaceName === "outline")!, tools).skills.includes("blender-research"));
  assert.ok(steps[0].skills.includes("endnote-bridge"));
  assert.equal(steps[0].expectedArtifacts.includes("output/endnote.docx"), false);
  const notes = steps.find((s) => s.skills.includes("lit-notes"))!;
  assert.ok(notes.skills.includes("endnote-bridge"));
  assert.equal(notes.expectedArtifacts.includes("papers/endnote-import.ris"), false);
  assert.ok(steps[0].expectedArtifacts.includes("papers/endnote-import.ris"));
  assert.equal(notes.expectedArtifacts.includes("output/endnote.docx"), false);
  const paperPolish = steps.find((s) => s.workspaceName === "research-paper-polish")!;
  assert.ok(paperPolish.skills.includes("endnote-bridge"));
  assert.ok(paperPolish.expectedArtifacts.includes("output/endnote.docx"));
  assert.ok(paperPolish.expectedArtifacts.includes("papers/endnote-cite-report.md"));
  assert.ok((paperPolish.humanTasks ?? []).some((h) => h.title === "换样式时打开域稿"));
  assert.equal((paperPolish.humanTasks ?? []).some((h) => h.title.includes("EndNote")), true);
  assert.equal((paperPolish.humanTasks ?? []).filter((h) => h.title.includes("域稿")).length, 1);
  const reviewDraft = withResearchTools(template("review").steps.find((s) => s.workspaceName === "draft")!, tools);
  assert.ok(!reviewDraft.skills.includes("endnote-bridge"));
  const reviewPolish = withResearchTools(template("review").steps.find((s) => s.workspaceName === "polish")!, tools);
  assert.ok(reviewPolish.skills.includes("endnote-bridge"));
  assert.ok(reviewPolish.skills.includes("zotero-sync"));
  const latexPolish = withResearchTools(template("review").steps.find((s) => s.workspaceName === "polish")!, {
    ...tools,
    manuscript: "latex",
  });
  assert.ok(latexPolish.skills.includes("endnote-bridge"));
  assert.ok(latexPolish.expectedArtifacts.includes("output/zotero.docx"));
  const latexFormat = withResearchTools(template("submission-rebuttal").steps.find((s) => s.workspaceName === "journal-format")!, {
    ...tools,
    manuscript: "latex",
  });
  assert.ok(!latexFormat.skills.includes("endnote-bridge"));
  assert.ok(!latexFormat.expectedArtifacts.includes("output/zotero.docx"));
});

test("定稿同时交 EndNote 与 Zotero 两份域稿，不看文献库选项", () => {
  const review = template("review").steps;
  const polish = review.find((s) => s.workspaceName === "polish")!;
  const notes = review.find((s) => s.workspaceName === "lit-notes")!;
  assert.ok(polish.expectedArtifacts.includes("output/endnote.docx"));
  assert.ok(polish.expectedArtifacts.includes("output/zotero.docx"));
  const plain = withResearchTools(polish, DEFAULT_RESEARCH_TOOLS);
  assert.ok(plain.expectedArtifacts.includes("output/endnote.docx"));
  assert.ok(plain.expectedArtifacts.includes("output/zotero.docx"));
  assert.equal(plain.expectedArtifacts.includes("output/zotero.rtf"), false);
  assert.ok(plain.humanTasks?.some((h) => h.title === "换样式时打开域稿"));
  assert.equal(plain.humanTasks?.some((h) => /打开 (EndNote|Zotero) 域稿/.test(h.title)), false);
  assert.equal(withResearchTools(notes, { ...DEFAULT_RESEARCH_TOOLS, libraryExport: "zotero" }).expectedArtifacts.includes("output/zotero.docx"), false);
  const notesEndnote = withResearchTools(notes, { ...DEFAULT_RESEARCH_TOOLS, libraryExport: "endnote" });
  assert.ok(notesEndnote.skills.includes("endnote-bridge"));
  assert.match(notesEndnote.brief, /按这份 references\.bib 生成导入文件/);
  assert.equal(notesEndnote.expectedArtifacts.includes("papers/endnote-import.ris"), false);
  for (const id of ["research-paper", "thesis", "submission-rebuttal"]) {
    const finals = template(id).steps.filter((s) =>
      ["research-paper-polish", "thesis-final", "journal-format"].includes(s.workspaceName ?? ""),
    );
    assert.ok(finals.length > 0, id);
    for (const step of finals) {
      assert.ok(step.expectedArtifacts.includes("output/endnote.docx"), `${id}/${step.name}`);
      assert.ok(step.expectedArtifacts.includes("output/zotero.docx"), `${id}/${step.name}`);
    }
  }
});

test("Zotero 同步技能跟 lit_source，不跟已废除的 literature 设置", () => {
  const search = template("research-paper").steps[0];
  const notes = template("research-paper").steps.find((s) => s.skills.includes("lit-notes"))!;
  assert.ok(!notes.skills.includes("zotero-sync"));
  assert.ok(withResearchTools(notes, DEFAULT_RESEARCH_TOOLS, "artifacts", "zotero").skills.includes("zotero-sync"));
  assert.ok(!withResearchTools(notes, DEFAULT_RESEARCH_TOOLS, "artifacts", "folder").skills.includes("zotero-sync"));
  assert.ok(!withResearchTools(search, DEFAULT_RESEARCH_TOOLS, "artifacts", "search").requiredSkills?.includes("zotero-sync"));
  assert.ok(withResearchTools(search, DEFAULT_RESEARCH_TOOLS, "artifacts", "zotero").requiredSkills?.includes("zotero-sync"));
  const mounted = withResearchTools(notes, DEFAULT_RESEARCH_TOOLS, "artifacts", "zotero");
  assert.deepEqual(withResearchTools(mounted, DEFAULT_RESEARCH_TOOLS, "artifacts", "search").skills, notes.skills);
});

test("选定模板后只出示相关工具字段", () => {
  const dataKeys = researchToolFieldsForSteps(template("data-processing").steps).map((f) => f.key);
  assert.deepEqual(dataKeys, ["plotting"]);
  const reviewKeys = researchToolFieldsForSteps(template("review").steps).map((f) => f.key);
  assert.ok(!reviewKeys.includes("illustration"));
  assert.ok(reviewKeys.includes("manuscript"));
  assert.ok(reviewKeys.includes("libraryExport"));
  assert.ok(!reviewKeys.includes("plotting"));
});

test("工具问在用得上的那一步；综述不问稿件载体", () => {
  const review = template("review").steps;
  assert.deepEqual(researchToolAskFieldsForStep(review.find((s) => s.workspaceName === "outline")!, review).map((f) => f.key), []);
  assert.deepEqual(researchToolAskFieldsForStep(review.find((s) => s.workspaceName === "lit-notes")!, review).map((f) => f.key), []);
  assert.deepEqual(researchToolAskFieldsForStep(review.find((s) => s.workspaceName === "polish")!, review).map((f) => f.key), []);
  assert.deepEqual(researchToolAskFieldsForStep(review.find((s) => s.workspaceName === "draft")!, review).map((f) => f.key), []);
  const paper = template("research-paper").steps;
  assert.deepEqual(researchToolAskFieldsForStep(paper.find((s) => s.name === "结果分析")!, paper).map((f) => f.key), ["plotting"]);
  assert.ok(!paper.some((s) => researchToolAskFieldsForStep(s, paper).some((f) => f.key === "manuscript")));
  const sub = template("submission-rebuttal").steps;
  assert.deepEqual(researchToolAskFieldsForStep(sub[0]!, sub).map((f) => f.key), ["libraryExport", "manuscript"]);
  const data = template("data-processing").steps;
  assert.deepEqual(researchToolAskFieldsForStep(data.find((s) => s.skills.includes("data-eda"))!, data).map((f) => f.key), ["plotting"]);
});

test("科研论文与毕业论文双向追加不再误复用不同稿件的同名步骤", () => {
  for (const [a, b] of [["research-paper", "thesis"], ["thesis", "research-paper"]]) {
    const existing = template(a).steps; const incoming = template(b).steps;
    assert.ok(conflictingTemplateSteps(existing, incoming).includes("论文初稿"));
    const renamed = renameConflictingSteps(existing, incoming, template(b).name);
    assert.deepEqual(conflictingTemplateSteps(existing, renamed), []);
    const merged = [...existing, ...renamed.filter((s) => !existing.some((p) => p.name === s.name))];
    const outputs = merged.flatMap((s) => s.expectedArtifacts);
    for (const s of merged) for (const input of s.inputs ?? []) {
      if (/manuscript\/(thesis-)?draft\.md/.test(input)) assert.ok(outputs.includes(input), input);
    }
  }
});

test("每个内置复现入口都声明可被真实面板解析的合同", () => {
  for (const t of PIPELINE_TEMPLATES) for (const s of t.steps) {
    for (const entry of s.expectedArtifacts.filter((p) => p.endsWith("/reproduce.py"))) {
      const marker = s.brief.match(/# MESA_REPRODUCE: (\{[^\n]+?\})/);
      assert.ok(marker, `${t.name}/${s.name}`);
      const contract = parseReproductionContract(entry, marker[0]);
      assert.equal(contract?.resultFile, "verification.json");
      assert.equal(contract?.subcommand, null);
    }
  }
});

test("零结果是显式合同，RIS 仍可见；返修按轮次渲染", () => {
  for (const id of ["review", "research-paper", "thesis"]) {
    const search = template(id).steps[0];
    assert.ok(search.expectedArtifacts.includes("papers/to-fetch.ris"));
    assert.ok(search.acceptanceCriteria?.includes("machine:optional-empty:papers/to-fetch.ris"));
    assert.ok(search.acceptanceCriteria?.some((c) => c.startsWith("machine:records-allow-empty:")));
  }
  const [revision] = pipelineStepsForTemplate(template("submission-rebuttal"), "revision", 3);
  assert.ok(revision.expectedArtifacts.includes("output/revised-r3.pdf"));
  assert.ok(revision.run.some((r) => r.command.includes("revised-r3.md")));
});

test("上游验收引用不自动授权，更新替换已有摘要而非重复堆叠", async () => {
  const { appendUpstreamAcceptance } = await import("../src/research-acceptance.ts");
  const row = { stepName: "分析", verdict: "accept", conclusionScope: "仅样本内描述", openBlockers: [], createdAt: "2026-09-11", resultVersion: "v1", valid: true, changedFiles: [] };
  const text = appendUpstreamAcceptance("# TASK\n保留人工内容", [row]);
  assert.match(text,/非本步自动授权/);
  assert.equal(appendUpstreamAcceptance(text,[row]),text);
  assert.equal(appendUpstreamAcceptance(text,[]).trim(),"# TASK\n保留人工内容");
  assert.match(appendUpstreamAcceptance(text,[{...row,valid:false,changedFiles:["analysis.md"]}]),/必须复核/);
});

test("旧模板升级只提出匹配候选，不修改原始对象", async () => {
  const { pipelineUpgradeCandidates } = await import("../src/pipeline-upgrade.ts");
  const t = template("data-processing");
  const steps = structuredClone(t.steps); steps[0].brief="用户自改";
  const before=JSON.stringify(steps);
  const changes=pipelineUpgradeCandidates(steps,t);
  assert.equal(changes.length,1);assert.equal(changes[0].index,0);
  assert.equal(JSON.stringify(steps),before);
  steps[0].workspaceName="custom";assert.equal(pipelineUpgradeCandidates(steps,t).length,0);
});

test("原生稿件选择生成自己的输入/交付合同，可逆切换且不会伪造 Quarto 正式稿", () => {
  const t=template("submission-rebuttal");
  for (const manuscript of ["latex", "word"] as const) {
    const tools={...DEFAULT_RESEARCH_TOOLS,manuscript};
    const source=t.steps[0]; const step=withResearchTools(source,tools);
    assert.equal(step.run.length,0);
    assert.ok(!step.skills.includes("quarto-render"));
    assert.deepEqual(step.anyOfInputs,[[manuscript==="latex"?"manuscript/main.tex":"manuscript/source.docx"]]);
    assert.ok(step.expectedArtifacts.includes(manuscript==="latex"?"submission/latex/main.tex":"submission/formatted.docx"));
    assert.deepEqual(withResearchTools(step,tools),step);
    const reset=withResearchTools(step,DEFAULT_RESEARCH_TOOLS);
    assert.deepEqual(reset.expectedArtifacts,source.expectedArtifacts);
    assert.deepEqual(reset.run,source.run);
    const [revision]=pipelineStepsForTemplate(t,"revision",2);
    assert.deepEqual(withResearchTools(revision,tools).anyOfInputs,[[manuscript==="latex"?"submission/latex-r1/main.tex":"manuscript/revised-r1.docx"]]);
    const materials=withResearchTools(t.steps[1],tools);
    assert.ok(materials.inputs?.includes(manuscript==="latex"?"submission/latex/main.tex":"submission/formatted.docx"));
    assert.ok(materials.inputs?.includes("output/formatted.pdf"));
    assert.deepEqual(withResearchTools(materials,tools),materials);
    assert.deepEqual(withResearchTools(materials,DEFAULT_RESEARCH_TOOLS).inputs,t.steps[1].inputs);
  }
});

test("工具产物拒绝根外目录，不因 Windows 分隔符逃逸", () => {
  const source=template("research-paper").steps.find((s)=>s.name==="结果分析")!;
  const tools={...DEFAULT_RESEARCH_TOOLS,plotting:"origin" as const};
  for(const directory of ["../outside","/tmp/out","C:\\out","data\\..\\outside"]) assert.throws(()=>withResearchTools(source,tools,directory),/相对产物目录/);
  assert.ok(withResearchTools(source,tools,"output\\research").expectedArtifacts.includes("output/research/origin/project.opju"));
});

test("旧草稿不能悄悄绕过当前工具选择，恢复默认后可开工", async () => {
  const { researchToolContractMatches } = await import("../src/research-tools.ts");
  const source=template("research-paper").steps.find((s)=>s.name==="结果分析")!;
  const chosen=withResearchTools(source,{...DEFAULT_RESEARCH_TOOLS,plotting:"origin"});
  assert.equal(researchToolContractMatches(chosen,source.brief),false);
  assert.equal(researchToolContractMatches(chosen,chosen.brief),true);
  assert.equal(researchToolContractMatches(source,chosen.brief),false);
  assert.equal(researchToolContractMatches(source,source.brief),true);
  const extra = chosen.brief.replace(
    '"artifacts":["',
    '"artifacts":["papers/to-fetch.ris","',
  );
  assert.notEqual(extra, chosen.brief);
  assert.equal(researchToolContractMatches(chosen, extra), true);
});
