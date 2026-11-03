import assert from "node:assert/strict";
import test from "node:test";
import { buildPackAuthorPrompt, buildPackFixPrompt, issueLine, splitIssues } from "../src/task-pack-author.ts";
import type { PackIssueDto } from "../src/types.ts";

test("跟 AI 写的提示词：写在草稿目录、给出格式与闭集、不准装、不准开工", () => {
  const p = buildPackAuthorPrompt({
    name: "单细胞质控",
    intent: "按组里 SOP 做质控",
    dirRel: ".ccode/pack-drafts/pk-1",
    packRel: ".ccode/pack-drafts/pk-1/pack.toml",
    anchors: ["data-clean", "data-eda"],
    userSkills: ["my-qc"],
  });
  assert.match(p, /只写草稿目录 `\.ccode\/pack-drafts\/pk-1\/`/);
  assert.match(p, /\{skill:…\} 只能写这些内置技能名：data-clean、data-eda。本机已有的用户技能：my-qc/);
  assert.match(p, /不要安装技能，不要开工去做这件任务本身/);
  assert.match(p, /七类必须停下来问人/);
  assert.match(p, /不要说已经装好/);
  assert.match(buildPackAuthorPrompt({ name: "x", intent: " ", dirRel: "d", packRel: "d/p", anchors: [], userSkills: [] }), /先问清楚/);
});

test("检查结果：分拦下 / 提醒，回对话时原样告诉 AI", () => {
  const issues: PackIssueDto[] = [
    { level: "block", step: "质控", message: "没有简报" },
    { level: "warn", step: null, message: "参数「x」没有被任何步骤用到" },
  ];
  const { blocks, warns } = splitIssues(issues);
  assert.deepEqual([blocks.length, warns.length], [1, 1]);
  assert.equal(issueLine(blocks[0]), "「质控」没有简报");
  const fix = buildPackFixPrompt("d/pack.toml", issues, "pack.toml 写法不对：第 3 行");
  assert.match(fix, /- pack\.toml 写法不对：第 3 行\n- 【拦下】「质控」没有简报\n- 【提醒】参数「x」没有被任何步骤用到/);
  assert.match(buildPackFixPrompt("d/p", [], null), /没有问题/);
});
