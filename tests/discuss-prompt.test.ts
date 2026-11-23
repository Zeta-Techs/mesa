import test from "node:test";
import assert from "node:assert/strict";
import { DISCUSS_FOCUS, discussFocus, discussOpeningPrompt, discussReuseKey, parseDiscussReuseKey } from "../src/discuss-prompt.ts";
import { PIPELINE_TEMPLATES } from "../src/pipeline-presets.ts";

test("开场是苏格拉底式：一次一问、答清楚直接记下接着问、不问模板已定的流程", () => {
  const p = discussOpeningPrompt({ stepName: "文献检索与筛选", relPath: ".ccode/drafts/x.md", workspaceName: "lit-search" });
  assert.match(p, /一次只问一个问题/);
  assert.match(p, /不要停下来等我确认/);
  assert.doesNotMatch(p, /复述给我确认/);
  assert.match(p, /不要拿来问我/);
  assert.match(p, /## 已定方向/);
  assert.match(p, /## 待拍板/);
  assert.match(p, /最想回答的一个问题/);
  assert.match(p, /不要把模板里的可选事项改成开工前必须办的前置/);
  assert.doesNotMatch(p, /还没定的是/);
});

test("没定的全局设定与种子并进开场", () => {
  const p = discussOpeningPrompt({
    stepName: "s", relPath: "t.md", workspaceName: "zzz",
    openSettings: ["综述角度：（领域全景 / 聚焦某个子问题）", " "],
    seeds: ["主指标测到什么"],
  });
  assert.match(p, /还没定的是：综述角度：（领域全景 \/ 聚焦某个子问题）。/);
  assert.match(p, /主指标测到什么；这一步交出的东西/);
});

test("英文综述五步都有专属提问方向", () => {
  const review = PIPELINE_TEMPLATES.find((t) => t.id === "review")!;
  for (const step of review.steps) {
    assert.ok(DISCUSS_FOCUS[step.workspaceName ?? ""], `${step.name} 缺提问方向`);
    assert.ok(discussFocus(step.workspaceName).length >= 3);
  }
});

test("商量对话复用键：拼出来的能拆回项目根与任务书路径（Windows 盘符里的冒号不碍事）；别的键认不出", () => {
  for (const root of ["/Users/me/HER", "C:\\Users\\me\\HER", "/p/a:b"]) {
    const key = discussReuseKey(root, ".ccode/drafts/lit-notes.md");
    assert.deepEqual(parseDiscussReuseKey(key), { projectRoot: root, relPath: ".ccode/drafts/lit-notes.md" });
  }
  assert.equal(parseDiscussReuseKey("assistant-discuss:/p:123"), null);
  assert.equal(parseDiscussReuseKey("discuss:/p/notes.md"), null);
  assert.equal(parseDiscussReuseKey(undefined), null);
});

test("已有项目规则传入商量开场：用户定下或推翻全局设定时允许同步改 .ccode/project.toml，不直接手改 memory.md", () => {
  const p = discussOpeningPrompt({
    stepName: "文献检索与筛选",
    relPath: ".ccode/drafts/lit-search.md",
    workspaceName: "lit-search",
    projectSettings: ["去向：EES期刊", "文献数据抽取表：不需要"],
  });
  assert.match(p, /当前项目规则：去向：EES期刊；文献数据抽取表：不需要/);
  assert.match(p, /同步把 \.ccode\/project\.toml 的 settings 里对应那条改成定下来的话/);
  assert.match(p, /## 本步补充要求/);
  assert.match(p, /记进项目知识/);
});

test("综述大纲商量开场：要求先读 angles.md / handoff.md，对齐定框架 ①–④ 问，并明确全权委托出口规则", () => {
  const p = discussOpeningPrompt({
    stepName: "综述大纲",
    relPath: ".ccode/drafts/outline.md",
    workspaceName: "outline",
  });
  assert.match(p, /notes\/angles\.md/);
  assert.match(p, /notes\/handoff\.md/);
  assert.match(p, /定框架第①、③问/);
  assert.match(p, /对应第②问/);
  assert.match(p, /对应第④问/);
  assert.match(p, /第⑤、⑥问留待正式执行/);
  assert.match(p, /明确全权委托/);
  assert.match(p, /一次性把剩余核心决策按你的推荐写入/);
});

test("综述初稿商量开场：引导提前商定自绘示意图风格与路线（含无 Blender 回落）", () => {
  const p = discussOpeningPrompt({
    stepName: "综述初稿",
    relPath: ".ccode/drafts/draft.md",
    workspaceName: "draft",
  });
  assert.match(p, /自绘示意图风格与路线/);
  assert.match(p, /没装自动回落纯矢量/);
});
