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

test("自查：短值不会换进已写好的占位、原有占位不动；两个包同键不同义换新键", async () => {
  const { parameterize, mergeStepParams } = await import("../src/task-packs.ts");
  const s = { name: "a", workspaceName: "a", brief: "投 Nature，阈值 1，目录 {param:dir}", expectedArtifacts: [], skills: [], run: [] };
  const { steps, hits } = parameterize([s as never], [
    { key: "p1", label: "期刊", value: "Nature", help: "", options: [] },
    { key: "p2", label: "阈值", value: "1", help: "", options: [] },
  ]);
  assert.equal(steps[0].brief, "投 {param:p1}，阈值 {param:p2}，目录 {param:dir}");
  assert.deepEqual(hits, { p1: 1, p2: 1 });
  const fromA = { ...s, brief: "投 {param:p1}", params: [{ key: "p1", label: "期刊", value: "Nature", help: "", options: [] }] };
  const fromB = { ...s, brief: "阈值 {param:p1}", params: [{ key: "p1", label: "阈值", value: "20%", help: "", options: [] }] };
  const fromB2 = { ...s, brief: "再用 {param:p1}", params: [{ key: "p1", label: "阈值", value: "20%", help: "", options: [] }] };
  const merged = mergeStepParams([fromA, fromB, fromB2] as never);
  assert.deepEqual(merged.params.map((p) => `${p.key}=${p.label}`), ["p1=期刊", "p2=阈值"]);
  assert.equal(merged.steps[0].brief, "投 {param:p1}");
  assert.equal(merged.steps[1].brief, "阈值 {param:p2}");
  assert.equal(merged.steps[2].brief, "再用 {param:p2}", "同义的第二步也认到同一个新键");
});

test("自查：导入的包只带运行命令也要再问一次", async () => {
  const { importedScriptsNote } = await import("../src/task-packs.ts");
  const note = importedScriptsNote({ name: "x", imported: true, scripts: [], steps: [{ run: [{ name: "go", command: "rm -rf data", isDefault: true }] }] as never });
  assert.ok(note?.includes("运行命令：rm -rf data"), note ?? "");
  assert.equal(importedScriptsNote({ name: "x", imported: true, scripts: [], steps: [{ run: [] }] as never }), null);
});

test("参数类型：取值校验与后端同口径，不合规的拼任务书时当没填", async () => {
  const { paramValueProblem, applyStepParams, missingParams } = await import("../src/task-packs.ts");
  assert.equal(paramValueProblem("number", "0.05"), null);
  assert.equal(paramValueProblem("number", "1e3"), null);
  assert.match(paramValueProblem("number", "0x10") ?? "", /数字/);
  assert.match(paramValueProblem("number", "五") ?? "", /数字/);
  assert.equal(paramValueProblem("bool", "是"), null);
  assert.match(paramValueProblem("bool", "true") ?? "", /是/);
  assert.equal(paramValueProblem("path", "data/raw/"), null);
  assert.equal(paramValueProblem("path", "a//b"), null);
  for (const bad of ["../x", "/etc/passwd", "C:/x.txt", "./a", "a/../b"]) assert.ok(paramValueProblem("file", bad), bad);
  assert.equal(paramValueProblem("number", ""), null, "空值不算错");
  assert.equal(paramValueProblem(undefined, "../随便"), null, "文字参数不管");
  const step = {
    name: "s",
    brief: "读 {param:dir}",
    params: [{ key: "dir", label: "数据目录", value: "../secret", help: "", options: [], kind: "path" }],
  } as never;
  assert.equal((applyStepParams(step) as { brief: string }).brief, "读 （参数「数据目录」未填）");
  assert.equal(missingParams(step).length, 1);
});
