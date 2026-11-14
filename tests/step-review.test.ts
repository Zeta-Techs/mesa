import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveStepReviewProfile,
  reviewPaneTabs,
  STEP_REVIEW_PROFILES,
  type StepReviewKind,
} from "../src/step-review.ts";
import { PIPELINE_TEMPLATES, pipelineStepsForTemplate } from "../src/pipeline-presets.ts";
import { deliveryContentPaths, deliveryProcessPaths } from "../src/review-file-groups.ts";
import { reviewSavePrimaryLabel, historyWorkspaceSaveTitle, REVIEW_SAVE } from "../src/review-save-copy.ts";

test("评审档案闭集：筛选 / 文件交付 / 报告验收 / 默认，不按工作区名另开一页", () => {
  assert.equal(
    resolveStepReviewProfile({ workspaceName: "lit-search" }, []).kind,
    "screening",
  );
  assert.equal(
    resolveStepReviewProfile(
      { workspaceName: "exp-run" },
      ["papers/screening.md", "papers/included.md"],
    ).kind,
    "screening",
  );
  assert.equal(
    resolveStepReviewProfile(
      {
        workspaceName: "lit-notes",
        expectedArtifacts: ["notes/*.md", "notes/index.json", "references.bib"],
      },
      ["notes/a.md"],
    ).kind,
    "files",
  );
  assert.equal(
    resolveStepReviewProfile(
      {
        workspaceName: "exp-run",
        expectedArtifacts: ["results/summary.md", "experiments/reproduce.py"],
      },
      ["results/a.md"],
    ).kind,
    "acceptance",
  );
  assert.equal(
    resolveStepReviewProfile({ workspaceName: "exp-run" }, ["results/a.md"]).kind,
    "files",
  );
  assert.equal(resolveStepReviewProfile(null, []).kind, "default");
  assert.equal(STEP_REVIEW_PROFILES.files.groupFiles, true);
  assert.equal(STEP_REVIEW_PROFILES.files.acceptance, "none");
  assert.equal(STEP_REVIEW_PROFILES.files.showReproduction, false);
  assert.equal(STEP_REVIEW_PROFILES.screening.acceptance, "none");
  assert.equal(STEP_REVIEW_PROFILES.acceptance.groupFiles, true);
  assert.equal(STEP_REVIEW_PROFILES.screening.evidence, "screening");
  assert.equal(STEP_REVIEW_PROFILES.acceptance.evidence, "report");
  assert.equal(STEP_REVIEW_PROFILES.acceptance.showReproduction, true);
  assert.equal(STEP_REVIEW_PROFILES.screening.showReproduction, false);
});

test("检索/精读/大纲同一套页签，Git 对照只在文件", () => {
  assert.deepEqual(
    reviewPaneTabs("screening")?.map((tab) => tab.label),
    ["清单", "过程", "文件"],
  );
  assert.deepEqual(
    reviewPaneTabs("files", ["notes/a.md", ".ccode/help-wanted.md"])?.map(
      (tab) => tab.label,
    ),
    ["笔记", "过程", "文件"],
  );
  assert.deepEqual(
    reviewPaneTabs("files", ["outline.md", ".ccode/help-wanted.md"])?.map(
      (tab) => tab.label,
    ),
    ["稿件", "过程", "文件"],
  );
  assert.deepEqual(
    reviewPaneTabs("files", ["submission/formatted.md"])?.map((tab) => tab.label),
    ["稿件", "过程", "文件"],
  );
  assert.deepEqual(
    reviewPaneTabs("files", ["outline.md", "notes/a.md"])?.map((tab) => tab.label),
    ["稿件", "过程", "文件"],
  );
  assert.deepEqual(
    reviewPaneTabs("acceptance")?.map((tab) => tab.label),
    ["结果", "过程", "文件"],
  );
  assert.equal(reviewPaneTabs("default"), null);
});

const KIND_BY_WORKSPACE: Record<string, StepReviewKind> = {
  "lit-search": "screening",
  "lit-survey-search": "screening",
  "lit-notes": "files",
  outline: "files",
  draft: "files",
  polish: "files",
  "lit-survey-gap": "files",
  "exp-design": "files",
  "exp-run": "acceptance",
  "exp-analysis": "acceptance",
  "paper-outline": "files",
  "paper-draft": "files",
  "research-paper-polish": "files",
  "data-inspect": "files",
  "data-clean": "acceptance",
  "data-eda": "acceptance",
  "data-report": "files",
  proposal: "files",
  methodology: "files",
  "thesis-exp-run": "acceptance",
  "thesis-exp-analysis": "acceptance",
  "thesis-draft": "files",
  "thesis-final": "files",
  "journal-format": "files",
  "submission-materials": "files",
  "latex-skeleton": "files",
  "latex-writing": "files",
  "latex-compile": "files",
  "latex-final": "files",
  "rebuttal-r1": "files",
};

function stepsForReviewAudit() {
  return PIPELINE_TEMPLATES.flatMap((tpl) => {
    const steps =
      tpl.id === "submission-rebuttal"
        ? [
            ...pipelineStepsForTemplate(tpl, "initial"),
            ...pipelineStepsForTemplate(tpl, "revision", 1),
          ]
        : tpl.steps;
    return steps.map((step) => ({ tpl, step }));
  });
}

function sampleArtifactPath(pattern: string): string {
  return pattern.replace(/\*/g, "x");
}

test("六套模板步骤评审档案按产物分流", () => {
  for (const { tpl, step } of stepsForReviewAudit()) {
    const ws = step.workspaceName ?? "";
    assert.ok(
      KIND_BY_WORKSPACE[ws],
      `未登记评审档案：${tpl.id}/${step.name} (${ws})`,
    );
    assert.equal(
      resolveStepReviewProfile(step, []).kind,
      KIND_BY_WORKSPACE[ws],
      `${tpl.id}/${step.name}`,
    );
  }
});

test("精读之后的下一步声明读取 notes/", () => {
  const rows = stepsForReviewAudit();
  for (let i = 0; i < rows.length; i++) {
    const { tpl, step } = rows[i];
    if (!step.skills.includes("lit-notes")) continue;
    const next = rows[i + 1]?.tpl.id === tpl.id ? rows[i + 1].step : undefined;
    if (!next) continue;
    const inputs = [
      ...(next.inputs ?? []),
      ...(next.optionalInputs ?? []),
      ...(next.anyOfInputs ?? []).flat(),
    ];
    assert.ok(
      inputs.some((path) => path === "notes/" || path.startsWith("notes")),
      `${tpl.id} 的「${next.name}」没声明读 notes/，精读笔记接不上下一步`,
    );
  }
});

test("files 档每步预期产物都能进笔记/稿件主面", () => {
  for (const { tpl, step } of stepsForReviewAudit()) {
    if (resolveStepReviewProfile(step, []).kind !== "files") continue;
    const samples = (step.expectedArtifacts ?? []).map(sampleArtifactPath);
    assert.ok(
      deliveryContentPaths(samples).length > 0 ||
        deliveryProcessPaths(samples).length > 0,
      `${tpl.id}/${step.name} 主面空：${samples.join("、")}`,
    );
  }
});

test("科研保存链白话：有未提交 / 有提交 / 已写入 / 空", () => {
  assert.equal(
    reviewSavePrimaryLabel({ hasUncommitted: true, hasCommitted: false }),
    "提交并保存进项目",
  );
  assert.equal(
    reviewSavePrimaryLabel({ hasUncommitted: false, hasCommitted: true }),
    "保存进项目",
  );
  assert.equal(
    reviewSavePrimaryLabel({ hasUncommitted: true, hasCommitted: false, checking: true }),
    "提交并保存进项目",
  );
  assert.equal(
    reviewSavePrimaryLabel({ hasUncommitted: false, hasCommitted: false, mergedAt: "t", checking: true }),
    "检查中…",
  );
  assert.equal(
    reviewSavePrimaryLabel({ hasUncommitted: false, hasCommitted: false, mergedAt: "t" }),
    "已保存进项目",
  );
  assert.equal(
    reviewSavePrimaryLabel({ hasUncommitted: false, hasCommitted: false }),
    "无待保存提交",
  );
  assert.equal(historyWorkspaceSaveTitle("文献检索与筛选"), "保存进项目：文献检索与筛选");
  assert.equal(REVIEW_SAVE.reviewNodeLabel, "你核对后，保存进项目");
});
