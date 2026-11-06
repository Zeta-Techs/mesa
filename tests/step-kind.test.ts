import assert from "node:assert/strict";
import test from "node:test";
import { PIPELINE_TEMPLATES } from "../src/pipeline-presets.ts";
import { ROUND_CLAUSE, chainDefaultOff, stepKind } from "../src/step-kind.ts";

test("步骤类型：按技能槽与产物认，内置六套模板每一步都归得对", () => {
  const provides = undefined; // 内置技能自名即位
  const kinds = Object.fromEntries(
    PIPELINE_TEMPLATES.map((t) => [t.id, t.steps.map((s) => `${s.name}=${stepKind(s, provides)}`)]),
  );
  assert.deepEqual(kinds["review"], ["文献检索与筛选=search", "文献精读与笔记=notes", "综述大纲=outline", "综述初稿=writing", "润色与定稿=final"]);
  assert.deepEqual(kinds["research-paper"], [
    "文献检索与筛选=search", "精读与研究空白=notes", "实验设计=design", "实验执行=experiment", "结果分析=analysis",
    "论文大纲=writing", "论文初稿=writing", "润色与投稿准备=final",
  ]);
  assert.deepEqual(kinds["data-processing"], ["数据登记与检查=other", "清洗与整理=clean", "探索性分析=analysis", "分析报告=writing"]);
  assert.deepEqual(kinds["thesis"], [
    "文献检索与筛选=search", "文献精读与笔记=notes", "开题报告与综述=writing", "研究方法=design", "实验执行=experiment",
    "结果分析与章节=analysis", "论文初稿=writing", "格式与定稿=final",
  ]);
  assert.deepEqual(kinds["submission-rebuttal"], ["期刊格式适配=final", "投稿材料=other"]);
  assert.deepEqual(kinds["latex-paper"], ["搭建骨架=other", "章节写作=writing", "编译与排错=other", "定稿导出=final"]);
});

test("步骤类型：回头时各类的做法与链默认勾选", () => {
  assert.match(ROUND_CLAUSE.clean, /先改 cleaning\/rules\.md.*从原始数据重跑/);
  assert.match(ROUND_CLAUSE.experiment, /只重跑受上游改动影响的组合.*不覆盖旧运行/);
  assert.match(ROUND_CLAUSE.analysis, /不手改图和表里的数.*旧 → 新/);
  assert.match(ROUND_CLAUSE.design, /不为了结果改主指标或停止规则/);
  assert.equal(ROUND_CLAUSE.search, "");
  assert.equal(ROUND_CLAUSE.notes, "");
  assert.equal(chainDefaultOff("experiment"), true);
  assert.equal(chainDefaultOff("analysis"), false);
});
