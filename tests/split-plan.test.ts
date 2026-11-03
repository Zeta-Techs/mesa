import assert from "node:assert/strict";
import test from "node:test";
import { buildSplitPrompt, laneGoalText, MAX_LANES, parseSplitPlan, planIssues, readSplitReply } from "../src/split-plan.ts";

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

test("拆成几路：提示词带要做的事、项目概况与格式；让它改时带上一版与意见", () => {
  const p = buildSplitPrompt({ projectName: "单细胞课题", request: "三个批次各做质控再汇总", context: "项目目录（前两层）：\n- data/（3 项）" });
  assert.ok(p.includes("项目「单细胞课题」"));
  assert.ok(p.includes("三个批次各做质控再汇总") && p.includes("- data/（3 项）"));
  assert.ok(p.includes("不拆：理由") && p.includes("需要你定"));
  assert.ok(!p.includes("上一版方案"));
  // 格式示例自己就能被解析出两路
  const example = p.split("格式：\n\n")[1].split("\n\n规矩")[0];
  assert.equal(parseSplitPlan(example).lanes.length, 2);
  const again = buildSplitPrompt({ projectName: "x", request: "y", context: "", previous: "# 拆分方案：旧", feedback: "批次三不用做" });
  assert.ok(again.includes("上一版方案：\n# 拆分方案：旧") && again.includes("批次三不用做"));
});

test("读 AI 回话：去围栏和前言；不拆；没按格式", () => {
  const got = readSplitReply("好的，方案如下：\n```markdown\n# 拆分方案：质控\n按什么拆：按批次\n\n## A\n要做：x\n```");
  assert.equal(got.kind, "plan");
  assert.ok(got.kind === "plan" && got.text.startsWith("# 拆分方案：质控") && got.text.endsWith("要做：x"));
  assert.deepEqual(readSplitReply("**不拆：** 前后一步接一步"), { kind: "no-split", reason: "前后一步接一步" });
  assert.deepEqual(readSplitReply("不拆：只有一个文件"), { kind: "no-split", reason: "只有一个文件" });
  assert.equal(readSplitReply("我觉得可以分三路").kind, "bad");
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

test("先说「不写」再补一句的不算写共享文件（Codex 实写）", async () => {
  const plan = parseSplitPlan("# 拆分方案：x\n按什么拆：按批次\n\n## 汇总\n要做：合并\n交：a.md\n写共享文件：不写；只写汇总目录内的文件\n等：不等，先开\n");
  assert.deepEqual(planIssues(plan), []);
  const { laneWaits } = await import("../src/split-plan.ts");
  assert.equal(laneWaits(plan.lanes[0]), false, "「不等，先开」不算要等");
});
