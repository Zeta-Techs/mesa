import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PIPELINE_TEMPLATES } from "../src/pipeline-presets.ts";

test("示例课题用的英文综述 JSON 与 PIPELINE_TEMPLATES 同步", () => {
  const tpl = PIPELINE_TEMPLATES.find((t) => t.id === "review");
  assert.ok(tpl, "缺少英文综述模板");
  const disk = JSON.parse(
    readFileSync("src-tauri/resources/pipeline-review.json", "utf8"),
  ) as {
    id: string;
    name: string;
    projectRules?: string[];
    projectSettings: string[];
    steps: unknown;
  };
  assert.equal(disk.id, "review");
  assert.equal(disk.name, tpl!.name);
  assert.deepEqual(disk.projectRules ?? [], tpl!.projectRules ?? []);
  assert.deepEqual(disk.projectSettings, tpl!.projectSettings ?? []);
  assert.deepEqual(
    disk.steps,
    tpl!.steps,
    "改了英文综述模板后请运行：node --experimental-strip-types scripts/export-review-template.ts",
  );
});

test("示例课题 JSON 的检索简报同步带积累进料句", () => {
  const disk = JSON.parse(
    readFileSync("src-tauri/resources/pipeline-review.json", "utf8"),
  ) as { steps: { workspaceName?: string; brief?: string }[] };
  const brief =
    disk.steps.find((s) => s.workspaceName === "lit-search")?.brief ?? "";
  assert.match(brief, /\.ccode\/handoff-lit-intake\.md/, "示例课题缺积累进料句");
  assert.match(brief, /不回写、不删除、不清空积累台账/);
  assert.doesNotMatch(brief, /加入精读/);
});

test("精读步机器验收不要求未读篇也有 notePath", () => {
  for (const tpl of PIPELINE_TEMPLATES) {
    for (const step of tpl.steps) {
      if (!step.skills?.includes("lit-notes")) continue;
      const records = (step.acceptanceCriteria ?? []).filter((c) =>
        c.startsWith("machine:records:notes/index.json"),
      );
      assert.ok(records.length >= 1, `${tpl.id}/${step.name} 缺少 index records 验收`);
      for (const rule of records) {
        assert.equal(
          rule.includes("notePath"),
          false,
          `${tpl.id}/${step.name} 仍要求 notePath：${rule}`,
        );
      }
      assert.match(
        step.brief,
        /禁止整段粘贴英文摘要/,
        `${tpl.id}/${step.name} 简报未写禁止摘要灌装合同`,
      );
      assert.equal(
        /每篇产出 notes/.test(step.brief),
        false,
        `${tpl.id}/${step.name} 简报仍写每篇产出笔记文件`,
      );
      assert.equal(
        /一次跑不完则/.test(step.brief),
        false,
        `${tpl.id}/${step.name} 简报仍把一次跑不完写成停工许可`,
      );
      assert.match(
        step.brief,
        /提交后立刻/,
        `${tpl.id}/${step.name} 简报未写分批提交后继续`,
      );
      assert.match(
        step.brief,
        /不得结束本轮等人/,
        `${tpl.id}/${step.name} 简报未写核心未完不得停轮`,
      );
      assert.equal(
        /其余按摘要记或 index pending/.test(step.brief),
        false,
        `${tpl.id}/${step.name} 简报仍把非核心写成可停成 pending`,
      );
    }
  }
});
