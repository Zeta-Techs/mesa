import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveSkillSlot,
  stepFillsAnySlot,
  resolveSkillRefs,
  LIT_WATCH_SLOT,
} from "../src/skill-slots.ts";

test("技能位解析：provides 声明优先，名字精确匹配兜底，两者都不中为空缺", () => {
  const provides = { "my-search": ["lit-search"], "my-notes": ["lit-notes"] };
  // 用户技能顶位
  assert.equal(resolveSkillSlot("lit-search", ["my-search"], provides), "my-search");
  // 无人声明时名字兜底（内置技能自名即位）
  assert.equal(resolveSkillSlot("lit-search", ["lit-search"], provides), "lit-search");
  assert.equal(resolveSkillSlot("lit-search", ["lit-search"], undefined), "lit-search");
  // 混挂：既有顶位者又有内置名 → 声明者赢
  assert.equal(resolveSkillSlot("lit-search", ["lit-search", "my-search"], provides), "my-search");
  // 空缺
  assert.equal(resolveSkillSlot("lit-search", [], provides), null);
  assert.equal(resolveSkillSlot("lit-search", ["other"], provides), null);
  assert.equal(resolveSkillSlot("lit-search", undefined, provides), null);
});

test("行为键判定 stepFillsAnySlot：任一锚位被占据即真", () => {
  const provides = { "my-notes": ["lit-notes"] };
  assert.equal(stepFillsAnySlot(["my-notes"], ["lit-search", "lit-notes"], provides), true);
  assert.equal(stepFillsAnySlot(["lit-notes"], ["lit-search", "lit-notes"], undefined), true);
  assert.equal(stepFillsAnySlot(["unrelated"], ["lit-search", "lit-notes"], provides), false);
  assert.equal(stepFillsAnySlot([], ["lit-watch"], undefined), false);
  assert.equal(LIT_WATCH_SLOT, "lit-watch");
});

test("简报占位解析：换技能后正文跟随，空缺锚保留原样并进 unresolved", () => {
  const brief = "全程按 {skill:lit-search} 技能执行，写法见 {skill:lit-notes} 技能，出图按 {skill:figure-forge} 技能。";
  // 用户技能顶了检索位、内置顶了精读位、图位空缺
  const provides = { "my-search": ["lit-search"] };
  const r = resolveSkillRefs(brief, ["my-search", "lit-notes"], provides);
  // 空缺锚渲染成锚名本身（可读，不把模板语法漏给 agent），锚名进 unresolved 供校验提醒
  assert.equal(
    r.text,
    "全程按 my-search 技能执行，写法见 lit-notes 技能，出图按 figure-forge 技能。",
  );
  assert.deepEqual(r.unresolved, ["figure-forge"]);
  // 无映射时全部回落名字匹配（内置场景零回归）
  const r2 = resolveSkillRefs(brief, ["lit-search", "lit-notes", "figure-forge"], undefined);
  assert.deepEqual(r2.unresolved, []);
  assert.equal(r2.text.indexOf("{skill:"), -1);
});
