import assert from "node:assert/strict";
import test from "node:test";
import { applyStepParams, missingParams, nextParamKey, parameterize } from "../src/task-packs.ts";
import type { ProjectStepDto, StepParamDto } from "../src/types.ts";

const p = (key: string, label: string, value: string): StepParamDto => ({ key, label, value, help: "", options: [] });

function step(over: Partial<ProjectStepDto> = {}): ProjectStepDto {
  return {
    name: "质控",
    workspaceName: "qc",
    brief: "",
    expectedArtifacts: [],
    skills: [],
    run: [],
    ...over,
  };
}

test("把值改成参数：长的先换，验收里的 machine: 行不动，数命中", () => {
  const s = step({
    brief: "按 Nature Medicine 格式；线粒体阈值 20%，不投 Nature",
    acceptanceCriteria: ["报告写明阈值 20%", "machine:exists out/20%.md"],
    decisions: [{ q: "阈值 20% 够吗", options: [] }],
    humanTasks: [{ title: "确认 20%", guidance: "", target: "", timing: "during" }],
  });
  const params = [p("p1", "期刊", "Nature"), p("p2", "长期刊", "Nature Medicine"), p("p3", "阈值", "20%")];
  const { steps, hits } = parameterize([s], params);
  assert.equal(steps[0].brief, "按 {param:p2} 格式；线粒体阈值 {param:p3}，不投 {param:p1}");
  assert.deepEqual(steps[0].acceptanceCriteria, ["报告写明阈值 {param:p3}", "machine:exists out/20%.md"]);
  assert.equal(steps[0].decisions?.[0].q, "阈值 {param:p3} 够吗");
  assert.equal(steps[0].humanTasks?.[0].title, "确认 {param:p3}");
  assert.deepEqual(hits, { p1: 1, p2: 1, p3: 4 });
});

test("拼任务书时换回取值，没填的写明缺哪一项", () => {
  const s = step({
    brief: "投 {param:j}，阈值 {param:t}，未知 {param:x}",
    params: [p("j", "目标期刊", "Cell"), p("t", "阈值", "  ")],
  });
  assert.equal(applyStepParams(s).brief, "投 Cell，阈值 （参数「阈值」未填），未知 （参数「x」未填）");
  assert.deepEqual(missingParams(s).map((x) => x.key), ["t"]);
  const plain = step({ brief: "没有参数" });
  assert.equal(applyStepParams(plain), plain, "没参数的步骤原样返回");
});

test("参数键按顺序取不撞号", () => {
  assert.equal(nextParamKey([]), "p1");
  assert.equal(nextParamKey([{ key: "p2" }]), "p3");
  assert.equal(nextParamKey([{ key: "p1" }, { key: "p3" }]), "p4");
});
