import assert from "node:assert/strict";
import test from "node:test";
import {
  applyStepParams,
  checkCommand,
  checkSectionLines,
  missingParams,
  nextParamKey,
  packCheckFile,
  parameterize,
  triggerDefaultOn,
  triggerSummary,
} from "../src/task-packs.ts";
import type { PackTriggerDto, ProjectStepDto, StepParamDto } from "../src/types.ts";

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

test("核验：结果文件、按后缀给运行方式（Windows 用 python）、任务书一段", () => {
  const c = { name: "qc-thresholds", skill: "sc-qc", script: "scripts/qc_check.py", description: "阈值写进报告" };
  assert.equal(packCheckFile("pk-1", "qc-thresholds"), ".ccode/checks/pack-pk-1-qc-thresholds.jsonl");
  assert.equal(packCheckFile(undefined, "x"), ".ccode/checks/pack-local-x.jsonl");
  assert.equal(
    checkCommand(c, "pk-1", false),
    "python3 <技能 sc-qc 的目录>/scripts/qc_check.py --root <工作目录> --out .ccode/checks/pack-pk-1-qc-thresholds.jsonl",
  );
  assert.match(checkCommand(c, "pk-1", true), /^python </);
  assert.match(checkCommand({ ...c, script: "check.R" }, "pk-1", false), /^Rscript /);
  const lines = checkSectionLines(step({ pack: "pk-1", checks: [c] }), false).join("\n");
  assert.match(lines, /## 本步核验\n- 阈值写进报告：`python3 /);
  assert.match(lines, /拦下（blocked）的先回头改再交/);
  assert.deepEqual(checkSectionLines(step(), false), []);
});

test("触发：一句话说明与默认勾不勾", () => {
  const base: PackTriggerDto = {
    name: "新数据质控",
    kind: "folder",
    skill: "sc-qc",
    frequency: "",
    weekday: null,
    intervalHours: null,
    hour: 0,
    minute: 0,
    folder: "data/incoming",
    exts: ["h5"],
    mode: "record",
  };
  assert.equal(triggerSummary(base), "事件规则「新数据质控」：data/incoming/ 有新文件（h5）时用技能 sc-qc，先只记录");
  assert.equal(triggerDefaultOn(base), true);
  assert.equal(triggerDefaultOn({ ...base, mode: "run" }), false);
  const sched = { ...base, kind: "schedule", frequency: "weekly", weekday: 3, hour: 9, minute: 5, name: "" };
  assert.equal(triggerSummary(sched), "定时任务：每周三 09:05跑技能 sc-qc");
  assert.equal(triggerDefaultOn(sched), false, "定时会叫 AI 花钱，默认不勾");
});
