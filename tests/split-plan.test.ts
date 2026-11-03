import assert from "node:assert/strict";
import test from "node:test";
import { buildCoordinatorPrompt, laneGoalText, MAX_LANES, parseSplitPlan, planIssues } from "../src/split-plan.ts";

const SAMPLE = `# 拆分方案：三个数据集各做一遍质控
按什么拆：按数据集（三个批次互不依赖）
共享文件：analysis/summary.md 只由「汇总」那一路写

## 1. 批次 A 质控
要做：按 docs/qc-sop.md 给批次 A 做质控
读：data/batch-a/
交：analysis/qc-a.md
写共享文件：不写
预算：一小时内

## 批次 B 质控
要做：同上，批次 B
  阈值沿用 A 的
读：data/batch-b/
交：analysis/qc-b.md
写共享文件：analysis/summary.md
`;

test("解析方案：标题、拆法、共享文件、每一路字段，多行字段接上", () => {
  const plan = parseSplitPlan(SAMPLE);
  assert.equal(plan.title, "三个数据集各做一遍质控");
  assert.equal(plan.basis, "按数据集（三个批次互不依赖）");
  assert.equal(plan.sharedFiles, "analysis/summary.md 只由「汇总」那一路写");
  assert.equal(plan.lanes.length, 2);
  assert.equal(plan.lanes[0].name, "批次 A 质控");
  assert.equal(plan.lanes[0].budget, "一小时内");
  assert.equal(plan.lanes[1].todo, "同上，批次 B\n阈值沿用 A 的");
});

test("检查：写共享文件提醒、没交提醒、没要做与重名拦下、超路数拦下", () => {
  const issues = planIssues(parseSplitPlan(SAMPLE));
  assert.deepEqual(issues.map((i) => `${i.level}:${i.lane}`), ["warn:批次 B 质控"]);
  const bad = parseSplitPlan("# 拆分方案：x\n\n## A\n交：无\n\n## A\n要做：y\n");
  const msgs = planIssues(bad).map((i) => `${i.level}:${i.message}`);
  assert.ok(msgs.includes("block:没写「要做」"), msgs.join());
  assert.ok(msgs.includes("block:名字重复"), msgs.join());
  assert.ok(msgs.some((m) => m.startsWith("warn:没写「按什么拆」")), msgs.join());
  assert.ok(msgs.some((m) => m.startsWith("warn:没写「交」")), msgs.join());
  const many = parseSplitPlan(["# x", "按什么拆：按章", ...Array.from({ length: MAX_LANES + 1 }, (_, i) => `## 第${i}路\n要做：a\n交：b`)].join("\n"));
  assert.ok(planIssues(many).some((i) => i.level === "block" && i.message.includes(`最多拆 ${MAX_LANES} 路`)));
  assert.ok(planIssues(parseSplitPlan("随便写的")).some((i) => i.level === "block"));
});

test("一路变成目标原文：读 / 交 / 共享 / 预算都写进去，提示可看同伴", () => {
  const plan = parseSplitPlan(SAMPLE);
  const a = laneGoalText(plan, plan.lanes[0]);
  assert.ok(a.startsWith("按 docs/qc-sop.md 给批次 A 做质控"));
  assert.ok(a.includes("读：data/batch-a/") && a.includes("交：analysis/qc-a.md") && a.includes("预算：一小时内"));
  assert.ok(a.includes("不写共享文件"));
  assert.ok(a.includes("peek agents"));
  assert.ok(laneGoalText(plan, plan.lanes[1]).includes("共享文件：analysis/summary.md"));
});

test("协调对话开场：不自己干活、写方案的格式与位置、按平台写工具", () => {
  const p = buildCoordinatorPrompt("单细胞课题", false);
  assert.ok(p.includes("你是项目「单细胞课题」的协调对话"));
  assert.ok(p.includes("`.ccode/split-plan.md`"));
  assert.ok(p.includes('`"$MESA_PEEK_TOOL" peek agents`'));
  assert.ok(p.includes("不要替人回答"));
  assert.ok(buildCoordinatorPrompt("x", true).includes("`& $env:MESA_PEEK_TOOL peek agents`"));
  // 开场里的格式示例自己就能被解析出两路
  const example = p.split("```markdown")[1].split("```")[0];
  assert.equal(parseSplitPlan(example).lanes.length, 2);
});

test("等前面几路：认「等 / 依赖 / 前置」，只记下不开；不认识的字段单独成行、不混进上一个字段", async () => {
  const { laneWaits } = await import("../src/split-plan.ts");
  // 2026-11-03 Codex 实写的那一路（汇总等三批质控）
  const plan = parseSplitPlan(`# 拆分方案：三批质控加汇总
按什么拆：按数据集

## 三批对比汇总
要做：汇总三批
读：qc/
交：qc/summary/comparison.md
写共享文件：不写
依赖：这一路要等前三路的产物都交齐才能开工，
  缺了先报缺失
备注：图用同一配色

## 第一批
要做：质控 a
交：qc/a.md
等：不等
`);
  const [summary, first] = plan.lanes;
  assert.equal(summary.shared, "不写");
  assert.equal(summary.waits, "这一路要等前三路的产物都交齐才能开工，\n缺了先报缺失");
  assert.deepEqual(summary.notes, ["备注：图用同一配色"]);
  assert.ok(laneWaits(summary));
  assert.ok(!laneWaits(first), "写「不等」就是不等");
  assert.deepEqual(planIssues(plan), [], "不再把「依赖」误报成写共享文件");
  const goal = laneGoalText(plan, summary);
  assert.ok(goal.includes("开工前提：这一路要等前三路") && goal.includes("备注：图用同一配色"), goal);
});
