import assert from "node:assert/strict";
import test from "node:test";
import {
  LIT_WATCH_SKILL,
  WATCH_SKILL_CATEGORY,
  buildWatchSkillSeedPrompt,
  defaultScheduleName,
  followSkillName,
  isLitWatchSkill,
  scheduleSkillOptions,
  scheduleSkillOptionsForEdit,
  suggestWatchSkillName,
  watchDraftMetaRelPath,
  watchDraftRelPath,
} from "../src/schedule-skill.ts";

const skills = [
  { id: "uuid-lit", name: "lit-watch", category: null },
  { id: "uuid-clean", name: "data-clean", category: null },
  { id: "uuid-review", name: "review-writing", category: null },
  { id: "uuid-model", name: "model-watch", category: WATCH_SKILL_CATEGORY },
];

test("技能下拉：lit-watch 恒在最前，只收分类为巡检的技能，value 用目录名", () => {
  const opts = scheduleSkillOptions(skills);
  assert.deepEqual(
    opts.map((o) => o.id),
    ["lit-watch", "model-watch"],
  );
  assert.equal(opts[0].name, "文献雷达");
  assert.ok(!opts.some((o) => o.id === "data-clean" || o.id === "uuid-clean"));
});

test("空技能库兜底：仍给出 lit-watch 选项，默认名不崩", () => {
  const opts = scheduleSkillOptions([]);
  assert.equal(opts.length, 1);
  assert.equal(opts[0].id, LIT_WATCH_SKILL);
  assert.equal(defaultScheduleName("lit-watch", []), "文献雷达");
  assert.equal(defaultScheduleName("data-clean", []), "data-clean");
});

test("编辑下拉：当前技能不在列表时补一条", () => {
  const opts = scheduleSkillOptionsForEdit(skills, "old-uuid");
  assert.ok(opts.some((o) => o.id === "old-uuid"));
  assert.equal(scheduleSkillOptionsForEdit(skills, "lit-watch").length, 2);
});

test("默认任务名跟随技能", () => {
  assert.equal(defaultScheduleName("lit-watch", skills), "文献雷达");
  assert.equal(defaultScheduleName("model-watch", skills), "model-watch");
  assert.equal(defaultScheduleName("ghost", skills), "ghost");
});

test("切换技能：未手改的名称跟随新默认，手改过的不覆盖", () => {
  assert.equal(
    followSkillName("文献雷达", "lit-watch", "model-watch", skills),
    "model-watch",
  );
  assert.equal(followSkillName("", "lit-watch", "model-watch", skills), "model-watch");
  assert.equal(
    followSkillName("我的雷达", "lit-watch", "model-watch", skills),
    "我的雷达",
  );
  assert.equal(
    followSkillName("model-watch", "model-watch", "lit-watch", skills),
    "文献雷达",
  );
});

test("草稿路径与技能名候选", () => {
  assert.equal(watchDraftRelPath("abc"), ".ccode/drafts/watch-abc.md");
  assert.equal(watchDraftMetaRelPath("abc"), ".ccode/drafts/watch-abc.meta.json");
  assert.equal(suggestWatchSkillName("查模型更新"), "查模型更新");
  assert.equal(suggestWatchSkillName("OpenAI / Anthropic"), "OpenAI-Anthropic");
  assert.equal(suggestWatchSkillName("   "), "watch-skill");
  assert.ok(isLitWatchSkill("lit-watch"));
  assert.ok(!isLitWatchSkill("model-watch"));
});

test("写技能种子：指向草稿路径、禁止 inbox.md、等确认落盘", () => {
  const p = buildWatchSkillSeedPrompt({
    intent: "每天查各家模型",
    draftRelPath: ".ccode/drafts/watch-abc.md",
    skillName: "model-watch",
    scheduleName: "查模型更新",
  });
  assert.ok(p.includes(".ccode/drafts/watch-abc.md"));
  assert.ok(p.includes("model-watch"));
  assert.ok(p.includes("每天查各家模型"));
  assert.ok(p.includes("notes/inbox.md"));
  assert.ok(p.includes("确认落盘"));
  assert.ok(!p.includes("{skill}"));
});
