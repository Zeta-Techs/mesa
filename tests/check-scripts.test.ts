import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// 第二期核验脚本（2026-11-02）：数字追溯 num_check、统计自洽 stat_check、图重建 fig_check。
// 三档状态与 cite_check 同口径；共用 src-tauri/resources/mesa_checks.py。
const python = process.platform === "win32" ? "python" : "python3";
const skill = (name: string, file: string) => resolve(`src-tauri/resources/skills/${name}/scripts/${file}`);
const run = (script: string, args: string[], cwd: string) =>
  spawnSync(python, [script, ...args], { cwd, encoding: "utf8", timeout: 120_000 });

interface Item {
  id: string;
  status: string;
  title: string;
  target?: { file: string; line?: number };
  evidence?: { detail?: string; quote?: string };
}
const items = (root: string, name: string): Item[] =>
  readFileSync(join(root, ".ccode/checks", name), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
const byId = (list: Item[], id: string) => list.find((i) => i.id === id);
const tmp = () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-checks-"));
  mkdirSync(join(root, "manuscript"), { recursive: true });
  return root;
};

test("num_check：按显示位数比对、CSV 按行或按匹配取值、百分数换算；对不上拦下，没登记的交人", () => {
  const root = tmp();
  try {
    mkdirSync(join(root, "results"));
    writeFileSync(join(root, "results/metrics.json"), JSON.stringify({ model: { auc: 0.4216, runs: [{ acc: 0.9133 }] } }));
    writeFileSync(join(root, "results/table.csv"), "group,mean\nA,1.234\nB,2.5\n");
    writeFileSync(
      join(root, "manuscript/draft.md"),
      "AUC 为 0.42，准确率 91.3%。\nA 组均值 1.23，B 组 2.50。\n另有 3.14 没登记。\n",
    );
    const numbers = [
      { id: "N1", location: "manuscript/draft.md:1", value: "0.42", source: "results/metrics.json", path: "model.auc" },
      { id: "N2", location: "manuscript/draft.md:1", value: "91.3%", source: "results/metrics.json", path: "model.runs[0].acc", scale: 100 },
      { id: "N3", location: "manuscript/draft.md:2", value: "1.23", source: "results/table.csv", match: { group: "A" }, column: "mean" },
      { id: "N4", location: "manuscript/draft.md:2", value: "2.60", source: "results/table.csv", row: 2, column: "mean" },
      { id: "N5", location: "manuscript/draft.md:2", value: "0.5", source: "results/missing.json", path: "x" },
      { id: "N6", location: "manuscript/draft.md:3", value: "1.23", source: "results/table.csv", row: 1, column: "mean" },
    ];
    writeFileSync(join(root, "manuscript/numbers.json"), JSON.stringify({ numbers }));
    const r = run(skill("research-writing", "num_check.py"), ["--root", root, "--coverage"], root);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    const list = items(root, "num-check.jsonl");
    assert.equal(byId(list, "N-N1")?.status, "passed");
    assert.equal(byId(list, "N-N2")?.status, "passed");
    assert.equal(byId(list, "N-N3")?.status, "passed");
    const n4 = byId(list, "N-N4");
    assert.equal(n4?.status, "blocked");
    assert.equal(n4?.title, "正文写 2.60，结果文件是 2.50");
    assert.equal(byId(list, "N-N5")?.status, "blocked");
    // 数值对，但登记的那一行没有这个数：位置交人核
    assert.equal(byId(list, "N-N6")?.status, "needs_human");
    const cov = byId(list, "COV");
    assert.equal(cov?.status, "needs_human");
    assert.match(cov?.evidence?.detail ?? "", /3\.14/);
    assert.doesNotMatch(cov?.evidence?.detail ?? "", /0\.42/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("num_check：没有登记文件就拦下并退出 2", () => {
  const root = tmp();
  try {
    assert.equal(run(skill("research-writing", "num_check.py"), ["--root", root], root).status, 2);
    assert.equal(byId(items(root, "num-check.jsonl"), "NUMBERS")?.status, "blocked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stat_check：重算 p 对得上的通过、对不上的拦下；单侧写明的交人；估计值不在区间里拦下", () => {
  const root = tmp();
  try {
    writeFileSync(
      join(root, "manuscript/results.md"),
      [
        "两组差异显著，t(28) = 2.20, p = .036。",
        "方差分析 F(1, 28) = 4.84, p < .05。",
        "错报的：t(28) = 2.20, p = .01。",
        "卡方 χ2(1, N = 100) = 3.84, p = .05；相关 r(28) = .38, p = .04。",
        "单侧检验 t(28) = 2.20, p = .018。",
        "效应 d = 0.80, 95% CI [0.10, 0.70]；OR = 1.5, 95% CI [1.1, 2.3]。",
      ].join("\n"),
    );
    const r = run(skill("stats-check", "stat_check.py"), ["--root", root], root);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    const list = items(root, "stat-check.jsonl");
    const at = (line: number) => list.filter((i) => i.target?.line === line);
    assert.deepEqual(at(1).map((i) => i.status), ["passed"]);
    assert.deepEqual(at(2).map((i) => i.status), ["passed"]);
    assert.deepEqual(at(3).map((i) => i.status), ["blocked"]);
    assert.match(at(3)[0].evidence?.detail ?? "", /0\.036/);
    assert.deepEqual(at(4).map((i) => i.status).sort(), ["passed", "passed"]);
    assert.deepEqual(at(5).map((i) => i.status), ["needs_human"]);
    assert.deepEqual(at(6).map((i) => i.status), ["blocked", "passed"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stat_check：认不出任何统计报告时交人一句，不报通过", () => {
  const root = tmp();
  try {
    writeFileSync(join(root, "manuscript/a.md"), "纯文字，没有统计。\n");
    assert.equal(run(skill("stats-check", "stat_check.py"), ["--root", root], root).status, 0);
    const list = items(root, "stat-check.jsonl");
    assert.deepEqual(list.map((i) => [i.id, i.status]), [["STAT-NONE", "needs_human"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fig_check：确定性脚本逐字节一致通过、失败与漏出图拦下、稿件引用了没登记的交人", () => {
  const root = tmp();
  try {
    mkdirSync(join(root, "figures"));
    writeFileSync(
      join(root, "figures/make.py"),
      "import sys\nname = sys.argv[1]\nif name == 'bad': raise SystemExit('boom')\nif name != 'skip':\n    open(f'figures/{name}.txt', 'w').write('data ' + name)\n",
    );
    writeFileSync(join(root, "figures/fig1.txt"), "data fig1");
    writeFileSync(join(root, "figures/fig2.txt"), "old content");
    writeFileSync(
      join(root, "figures/manifest.json"),
      JSON.stringify({
        figures: [
          { file: "figures/fig1.txt", script: "figures/make.py", args: ["fig1"] },
          { file: "figures/fig2.txt", script: "figures/make.py", args: ["fig2"] },
          { file: "figures/fig3.txt", script: "figures/make.py", args: ["bad"] },
          { file: "figures/fig4.txt", script: "figures/make.py", args: ["skip"] },
          { file: "figures/fig5.txt", script: "figures/nope.py" },
        ],
      }),
    );
    writeFileSync(join(root, "manuscript/draft.md"), "![一](../figures/fig1.txt)\n![示意](../figures/sketch.png)\n");
    const r = run(skill("figure-forge", "fig_check.py"), ["--root", root, "--coverage"], root);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    const list = items(root, "fig-check.jsonl");
    assert.equal(byId(list, "FIG-figures/fig1.txt")?.status, "passed");
    assert.equal(byId(list, "FIG-figures/fig2.txt")?.status, "needs_human");
    assert.equal(byId(list, "FIG-figures/fig3.txt")?.status, "blocked");
    assert.match(byId(list, "FIG-figures/fig3.txt")?.evidence?.detail ?? "", /boom/);
    assert.equal(byId(list, "FIG-figures/fig4.txt")?.status, "blocked");
    assert.equal(byId(list, "FIG-figures/fig5.txt")?.status, "blocked");
    assert.equal(byId(list, "COV-figures/sketch.png")?.status, "needs_human");
    assert.equal(byId(list, "COV-figures/fig1.txt"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fig_check --coverage：图注含 [@key] 仍能识别图片路径，outputs 同源副本与拼图 JSON 不误报，配套文件跳过且去重", () => {
  const root = tmp();
  try {
    mkdirSync(join(root, "figures/fig1"), { recursive: true });
    writeFileSync(join(root, "figures/fig1/fig1.svg"), "<svg/>");
    writeFileSync(join(root, "figures/fig1/fig1.png"), "PNG-FIG1-BYTES");
    writeFileSync(join(root, "figures/fig1.png"), "PNG-FIG1-BYTES");
    writeFileSync(join(root, "figures/fig4.png"), "PANEL-PNG");
    writeFileSync(
      join(root, "figures/fig4.json"),
      JSON.stringify({ width_cm: 17, panels: [{ letter: "a", source: "figures/src/a.png" }] }),
    );
    writeFileSync(
      join(root, "figures/manifest.json"),
      JSON.stringify({
        figures: [
          {
            file: "figures/fig1/fig1.svg",
            spec: "figures/fig1/figure.json",
            kind: "schematic",
            outputs: ["figures/fig1/fig1.png"],
          },
        ],
      }),
    );
    writeFileSync(join(root, "manuscript/style-sheet.md"), "![示例](../figures/helper-only.png)\n");
    writeFileSync(
      join(root, "manuscript/draft.md"),
      [
        "![**Figure 1.** Mechanism [@Zhang2024].](../figures/fig1.png)",
        "![**Figure 4.** Reprinted panels [@Li2023].](../figures/fig4.png)",
        "![**Figure 5.** Unregistered [@Wang2022].](../figures/unreg.png)",
        "![Again](../figures/unreg.png)",
      ].join("\n"),
    );
    const r = run(skill("figure-forge", "fig_check.py"), ["--root", root, "--coverage"], root);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const list = items(root, "fig-check.jsonl");
    const covs = list.filter((i) => i.id.startsWith("COV-"));
    assert.deepEqual(covs.map((i) => i.id), ["COV-figures/unreg.png"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stat_check / num_check：--files 指定 manuscript/ 之外的报告（数据处理的 analysis-report.md、学位论文 chapters/）", () => {
  const root = tmp();
  try {
    mkdirSync(join(root, "chapters"));
    writeFileSync(join(root, "analysis-report.md"), "差异显著，t(28) = 2.20, p = .01。\n均值 3.14。\n");
    writeFileSync(join(root, "chapters/results.md"), "F(1, 28) = 4.84, p < .05。\n");
    const r = run(skill("stats-check", "stat_check.py"), ["--root", root, "--files", "analysis-report.md", "chapters/*.md"], root);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    const list = items(root, "stat-check.jsonl");
    assert.deepEqual(list.map((i) => [i.target?.file, i.status]), [["analysis-report.md", "blocked"], ["chapters/results.md", "passed"]]);
    writeFileSync(join(root, "numbers.json"), JSON.stringify({ numbers: [] }));
    run(skill("research-writing", "num_check.py"), ["--root", root, "--numbers", "numbers.json", "--coverage", "--files", "analysis-report.md"], root);
    assert.match(byId(items(root, "num-check.jsonl"), "COV")?.evidence?.detail ?? "", /analysis-report\.md:2 3\.14/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const hasMatplotlib = spawnSync(python, ["-c", "import matplotlib"], { encoding: "utf8" }).status === 0;

test("fig_lint：对数轴次刻度重叠直接提示 NullFormatter；tight_layout 贴边 1–2 px 不误拦，真出画布仍拦下", { skip: !hasMatplotlib }, () => {
  const root = tmp();
  try {
    mkdirSync(join(root, "figures"));
    writeFileSync(
      join(root, "figures/plot.py"),
      [
        "import sys, matplotlib",
        "matplotlib.rcParams['svg.fonttype'] = 'none'",
        "import matplotlib.pyplot as plt",
        "from matplotlib.ticker import NullFormatter",
        "mode = sys.argv[1]",
        "fig, ax = plt.subplots(figsize=(89/25.4, 66/25.4), dpi=300)",
        "ax.plot([0.2, 1.5], [10, 100])",
        "ax.set_xscale('log')",
        "if mode != 'clash':",
        "    ax.xaxis.set_minor_formatter(NullFormatter())",
        "if mode == 'edge':",
        "    # 贴近画布底边约 1.5 px（< 2 pt 字框余量），不应判成文字出画布",
        "    fig.text(0.5, -0.0015, 'Current density', ha='center', va='bottom', fontsize=7)",
        "if mode == 'clip':",
        "    fig.text(0.5, -0.08, 'Clipped label', ha='center', va='top', fontsize=8)",
        "fig.savefig(f'figures/{mode}.svg')",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "figures/manifest.json"),
      JSON.stringify({
        figures: [
          { file: "figures/clash.svg", script: "figures/plot.py", args: ["clash"] },
          { file: "figures/edge.svg", script: "figures/plot.py", args: ["edge"] },
          { file: "figures/clip.svg", script: "figures/plot.py", args: ["clip"] },
        ],
      }),
    );
    const r = run(skill("figure-forge", "fig_lint.py"), ["--root", root], root);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    const list = items(root, "fig-lint.jsonl");
    const clash = byId(list, "CLASH-figures/clash.svg");
    assert.equal(clash?.status, "blocked");
    assert.match(clash?.title ?? "", /NullFormatter/);
    assert.equal(byId(list, "OK-figures/edge.svg")?.status, "passed", `贴边微余量不应误杀：${JSON.stringify(list)}`);
    assert.equal(byId(list, "CLIP-figures/clip.svg")?.status, "blocked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fig_lint：pathlib.Path 子目录路径不丢目录，同一张图多格式连存只出一条 GRAY 且目标指向原图文件", { skip: !hasMatplotlib }, () => {
  const root = tmp();
  try {
    mkdirSync(join(root, "figures/sub"), { recursive: true });
    writeFileSync(
      join(root, "figures/make.py"),
      [
        "from pathlib import Path",
        "import matplotlib",
        "matplotlib.rcParams['svg.fonttype'] = 'none'",
        "matplotlib.rcParams['pdf.fonttype'] = 42",
        "import matplotlib.pyplot as plt",
        "fig, ax = plt.subplots(figsize=(89/25.4, 60/25.4), dpi=200)",
        "ax.plot([1, 2], [3, 4])",
        "out = Path('figures/sub')",
        "fig.savefig(out / 'p.png')",
        "fig.savefig(out / 'p.svg')",
        "fig.savefig(out / 'p.pdf')",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "figures/manifest.json"),
      JSON.stringify({ figures: [{ file: "figures/sub/p.svg", script: "figures/make.py" }] }),
    );
    const r = run(skill("figure-forge", "fig_lint.py"), ["--root", root], root);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const list = items(root, "fig-lint.jsonl");
    assert.equal(byId(list, "OK-figures/sub/p.svg")?.status, "passed", JSON.stringify(list));
    assert.equal(byId(list, "OK-p.svg"), undefined);
    const grays = list.filter((i) => i.id.startsWith("GRAY-"));
    assert.equal(grays.length, 1, JSON.stringify(grays));
    assert.equal(grays[0].id, "GRAY-figures/sub/p.svg");
    assert.equal(grays[0].target?.file, "figures/sub/p.svg");
    assert.match(grays[0].evidence?.detail ?? "", /\.ccode\/checks\/fig-lint\/.*-gray\.png/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
