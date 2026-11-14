import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { checkCiConsistency, checkNumbersTrace, checkStepArtifacts } from "../src/step-checks.ts";
import { mergeMesaChecks } from "../src/outline-check.ts";

const python = process.platform === "win32" ? "python" : "python3";
const skill = (name: string, file: string) => resolve(`src-tauri/resources/skills/${name}/scripts/${file}`);

test("检索步：不重复待确认清单，但拦下 included.json 重号/坏 JSON/已定条目缺理由，并提示筛选记录缺检索日期", () => {
  const cleanPending = checkStepArtifacts({
    kind: "search",
    artifacts: ["papers/included.json", "papers/screening.md"],
    files: new Map([
      [
        "papers/included.json",
        JSON.stringify([
          { id: "10.1/a", title: "Paper A", decision: "included", reason: "切题" },
          { id: "10.1/b", title: "Paper B", decision: "pending", reason: "" },
        ]),
      ],
      ["papers/screening.md", "# 筛选记录\n\n检索日期：2026-11-10\n"],
    ]),
  });
  assert.deepEqual(cleanPending, []);

  const broken = checkStepArtifacts({
    kind: "search",
    artifacts: ["papers/included.json", "papers/screening.md"],
    files: new Map([
      [
        "papers/included.json",
        JSON.stringify([
          { id: "10.1/a", title: "Paper A", decision: "included", reason: "" },
          { id: "10.1/a", title: "Paper A dup", decision: "excluded", reason: "重复" },
        ]),
      ],
      ["papers/screening.md", "# 筛选记录（忘了写日期）\n"],
    ]),
  });
  assert.ok(broken.some((i) => i.id === "step-dup-id-papers/included.json-10.1/a" && i.status === "blocked"));
  assert.ok(broken.some((i) => i.id === "step-missing-fields-papers/included.json" && i.status === "blocked"));
  assert.ok(broken.some((i) => i.id === "step-screening-date" && i.status === "needs_human"));
  assert.ok(broken.every((i) => i.checker === "mesa" && i.status !== "passed"));
});

test("数据登记与清洗步：字段/数据集台账校验、same-ids 对账与待裁决清洗规则", () => {
  const inspectItems = checkStepArtifacts({
    kind: "other",
    artifacts: ["data-dictionary.md", "data/fields.json", "data/datasets.json"],
    existingPaths: new Set(["data/raw.csv"]),
    files: new Map([
      ["data/fields.json", JSON.stringify([{ id: "f1", name: "age", type: "int", status: "pending" }])],
      ["data/datasets.json", JSON.stringify([{ id: "d1", name: "Raw", path: "data/missing.csv" }])],
      ["data-dictionary.md", "# 字段字典\n年龄单位 [待确认]\n"],
    ]),
  });
  assert.ok(inspectItems.some((i) => i.id === "step-dataset-missing-d1" && i.status === "blocked"));
  assert.ok(inspectItems.some((i) => i.id === "step-data-fields-pending" && i.status === "needs_human"));
  assert.ok(inspectItems.some((i) => i.id === "step-unsure-data-dictionary.md" && i.status === "needs_human"));

  const cleanItems = checkStepArtifacts({
    kind: "clean",
    artifacts: ["cleaning/fields.json", "cleaning/rule-decisions.md"],
    files: new Map([
      ["data/fields.json", JSON.stringify([{ id: "f1" }, { id: "f2" }])],
      ["cleaning/fields.json", JSON.stringify([{ id: "f1", name: "age", rule: "drop<0", status: "applied" }])],
      ["cleaning/rule-decisions.md", "### R01\n- 裁决：待裁决\n"],
    ]),
  });
  assert.ok(cleanItems.some((i) => i.id === "step-same-ids-data/fields.json-cleaning/fields.json" && i.status === "blocked"));
  assert.ok(cleanItems.some((i) => i.id === "step-decisions-cleaning/rule-decisions.md" && i.status === "needs_human"));
});

test("实验设计与实验执行步：矩阵必填字段、实验与计划 same-ids 对账、失败运行提醒", () => {
  const designItems = checkStepArtifacts({
    kind: "design",
    artifacts: ["design.md", "experiments/matrix.json"],
    bibs: ["@article{Real2023,\n year={2023}\n}"],
    files: new Map([
      ["experiments/matrix.json", JSON.stringify([{ id: "E1", configuration: "baseline", status: "pending-approval" }])],
      ["design.md", "Method follows [@Real2023] and [@Ghost2025].\n"],
    ]),
  });
  assert.ok(designItems.some((i) => i.id === "step-ref-Ghost2025" && i.status === "blocked"));
  assert.ok(designItems.some((i) => i.id === "step-design-matrix-pending" && i.status === "needs_human"));

  const expItems = checkStepArtifacts({
    kind: "experiment",
    artifacts: ["results/matrix.json", "results/run-manifest.json", "results/summary.md"],
    files: new Map([
      ["experiments/matrix.json", JSON.stringify([{ id: "E1" }, { id: "E2" }])],
      ["results/matrix.json", JSON.stringify([{ id: "E1", configuration: "baseline", status: "failed" }])],
      [
        "results/run-manifest.json",
        JSON.stringify([
          {
            id: "E1",
            dataHash: "sha256:1",
            codeVersion: "abc",
            environment: "py3.12",
            command: "python run.py",
            status: "failed",
            outputs: ["results/e1.json"],
          },
        ]),
      ],
    ]),
  });
  assert.ok(expItems.some((i) => i.id === "step-same-ids-experiments/matrix.json-results/matrix.json" && i.status === "blocked"));
  assert.ok(expItems.some((i) => i.id === "step-same-ids-experiments/matrix.json-results/run-manifest.json" && i.status === "blocked"));
  assert.ok(expItems.some((i) => i.id === "step-experiment-failed" && i.status === "needs_human"));
});

test("结果分析、返修对照与定稿裁决：图表清单文件缺失、返修意见漏号、verification-decisions 待裁决", () => {
  const analysisItems = checkStepArtifacts({
    kind: "analysis",
    artifacts: ["analysis/findings.md", "analysis/results.json", "figures/manifest.json"],
    existingPaths: new Set(["figures/fig1.png"]),
    files: new Map([
      ["analysis/results.json", "{}"],
      ["figures/manifest.json", JSON.stringify([{ file: "figures/fig1.png", script: "figures/make_fig1.py" }])],
      ["analysis/findings.md", "![f2](../figures/fig2.png)\nEffect OR = 2.40, 95% CI [1.10, 1.90].\n"],
    ]),
  });
  assert.ok(analysisItems.some((i) => i.id === "step-empty-json-analysis/results.json" && i.status === "blocked"));
  assert.ok(analysisItems.some((i) => i.id === "step-fig-manifest-missing-script-figures/make_fig1.py" && i.status === "blocked"));
  assert.ok(analysisItems.some((i) => i.id === "step-image-analysis/findings.md-figures/fig2.png" && i.status === "blocked"));
  assert.ok(analysisItems.some((i) => i.kind === "ci_consistency" && i.status === "blocked"));

  const rebuttalItems = checkStepArtifacts({
    kind: "final",
    artifacts: ["manuscript/revised-r1.md", "rebuttal/response-letter-r1.md", "rebuttal/revisions-r1.md", "rebuttal/verification-decisions-r1.md"],
    primaryManuscript: "manuscript/revised-r1.md",
    files: new Map([
      ["manuscript/revised-r1.md", "# Revised\n"],
      ["rebuttal/response-letter-r1.md", "## R1.1\nDone.\n## R1.2\n[待确认]\n## E.1\nDone.\n"],
      ["rebuttal/revisions-r1.md", "| 编号 | 位置 |\n|---|---|\n| R1.1 | §2 |\n"],
      ["rebuttal/verification-decisions-r1.md", "- 条目 1｜裁决：待裁决\n"],
    ]),
  });
  assert.match(rebuttalItems.find((i) => i.id === "step-rebuttal-ids-r1")?.title ?? "", /R1\.2、E\.1/);
  assert.ok(rebuttalItems.some((i) => i.id === "step-unsure-rebuttal/response-letter-r1.md"));
  assert.ok(rebuttalItems.some((i) => i.id === "step-decisions-rebuttal/verification-decisions-r1.md"));
});

test("对照 stat_check.py CI 与 num_check.py：算术矛盾与数字追溯结果一致，且 mergeMesaChecks 自动去重", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-step-checks-"));
  try {
    mkdirSync(join(root, "manuscript"), { recursive: true });
    mkdirSync(join(root, "results"), { recursive: true });
    const draft = [
      "# Results",
      "Model reached AUC 84.2% (OR = 1.80, 95% CI [2.10, 1.20]; β = 0.95, 95% CI [0.10, 0.60]).",
      "Table row showed 12.5 mV.",
    ].join("\n");
    const metrics = JSON.stringify({ model: { auc: 0.81 } });
    const csv = "catalyst,overpotential\nCoB,12.5\n";
    const numbers = JSON.stringify({
      numbers: [
        { id: "N001", location: "manuscript/draft.md:2", value: "84.2%", source: "results/metrics.json", path: "model.auc", scale: 100 },
        { id: "N002", location: "manuscript/draft.md:1", value: "12.5", source: "results/table.csv", match: { catalyst: "CoB" }, column: "overpotential" },
      ],
    });
    writeFileSync(join(root, "manuscript/draft.md"), draft);
    writeFileSync(join(root, "manuscript/numbers.json"), numbers);
    writeFileSync(join(root, "results/metrics.json"), metrics);
    writeFileSync(join(root, "results/table.csv"), csv);

    const st = spawnSync(python, [skill("stats-check", "stat_check.py"), "--root", root], { cwd: root, encoding: "utf8", timeout: 30_000 });
    assert.equal(st.status, 1, st.stderr + st.stdout);
    const stItems = readFileSync(join(root, ".ccode/checks/stat-check.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const ciMine = checkCiConsistency("manuscript/draft.md", draft);
    assert.deepEqual(
      ciMine.map((i) => i.title),
      stItems.filter((i) => i.kind === "ci_consistency" && i.status === "blocked").map((i) => i.title),
    );

    const nm = spawnSync(python, [skill("research-writing", "num_check.py"), "--root", root], { cwd: root, encoding: "utf8", timeout: 30_000 });
    assert.equal(nm.status, 1, nm.stderr + nm.stdout);
    const nmItems = readFileSync(join(root, ".ccode/checks/num-check.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const numMine = checkNumbersTrace(
      "manuscript/numbers.json",
      numbers,
      new Map([
        ["manuscript/draft.md", draft],
        ["results/metrics.json", metrics],
        ["results/table.csv", csv],
      ]),
    );
    assert.deepEqual(
      numMine.map((i) => `${i.id.replace("step-num-", "N-")}:${i.status}:${i.title}`),
      nmItems.filter((i) => i.status !== "passed").map((i) => `${i.id}:${i.status}:${i.title}`),
    );

    // 合并时去掉脚本里重复的 CI-* 与 N-* 错项，保留脚本通过项
    const merged = mergeMesaChecks({ items: [...stItems, ...nmItems], files: ["stat-check.jsonl", "num-check.jsonl"], skipped: 0 }, [...ciMine, ...numMine])!;
    assert.equal(merged.items.filter((i) => i.kind === "ci_consistency").length, 2);
    assert.equal(merged.items.filter((i) => i.kind === "number_trace").length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
