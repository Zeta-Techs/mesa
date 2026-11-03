import assert from "node:assert/strict";
import test from "node:test";
import {
  basedOnFor,
  builtinKey,
  builtinUpdate,
  changedFields,
  currentBuiltinSteps,
  mergeBuiltinUpdate,
  normValue,
  rebased,
} from "../src/pack-builtin.ts";
import { importedScriptsNote } from "../src/task-packs.ts";
import type { ProjectStepDto } from "../src/types.ts";

const step = (name: string, brief: string, extra: Partial<ProjectStepDto> = {}): ProjectStepDto =>
  ({ name, workspaceName: name, brief, expectedArtifacts: [`${name}.md`], skills: [], resources: [], ...extra }) as ProjectStepDto;

test("normValue 把「没写」的各种写法看成一样，键顺序无关", () => {
  assert.deepEqual(normValue({ b: [], a: " x ", c: false, d: null, e: "" }), { a: "x" });
  assert.equal(JSON.stringify(normValue({ a: 1, b: 2 })), JSON.stringify(normValue({ b: 2, a: 1 })));
  assert.deepEqual(changedFields(step("a", "b", { inputs: [] }), step("a", "b")), []);
  assert.deepEqual(changedFields(step("a", "b"), step("a", "c")), ["brief"]);
});

test("basedOnFor 记当时内置原样；投稿模板按分支与轮次", () => {
  const review = basedOnFor("review");
  assert.ok(review);
  assert.equal(review.mode, "");
  assert.deepEqual(review.steps, currentBuiltinSteps(review));
  const rev = basedOnFor("submission-rebuttal", "revision", 2);
  assert.equal(rev?.mode, "revision");
  assert.equal(rev?.round, 2);
  assert.deepEqual(rev?.steps, currentBuiltinSteps(rev!));
  assert.equal(basedOnFor("no-such"), null);
  // 刚另存、内置没变：没有更新
  assert.equal(builtinUpdate({ steps: review.steps, basedOn: review }, review.steps), null);
  assert.equal(builtinUpdate({ steps: review.steps, basedOn: review }, null), null, "内置已删：不提示");
  assert.equal(builtinKey(rev!), "submission-rebuttal|revision|2");
});

test("内置升级：列出变了、新加、去掉的步，标我改没改过；没改过的直接跟新版", () => {
  const review = basedOnFor("review")!;
  const current = review.steps;
  // 造一份「旧版内置」：第一步简报不同、少最后一步、多一步旧的
  const old = [{ ...current[0], brief: "旧简报" }, ...current.slice(1, -1), step("旧步骤", "x")];
  const basedOn = { ...review, steps: old };
  const untouched = builtinUpdate({ steps: old, basedOn }, current);
  assert.ok(untouched);
  assert.equal(untouched.untouched, true);
  const kinds = untouched.changes.map((c) => `${c.kind}:${c.name}`);
  assert.ok(kinds.includes(`changed:${current[0].name}`), kinds.join());
  assert.ok(kinds.includes(`added:${current.at(-1)!.name}`), kinds.join());
  assert.ok(kinds.includes("removed:旧步骤"), kinds.join());
  assert.deepEqual(untouched.changes.find((c) => c.kind === "changed")?.fields, ["brief"]);

  // 我改过第二步：不算 untouched；第一步我没改
  const mine = old.map((s, i) => (i === 1 ? { ...s, brief: `${s.brief}\n我加的一句` } : s));
  const edited = builtinUpdate({ steps: mine, basedOn }, current)!;
  assert.equal(edited.untouched, false);
  assert.equal(edited.changes.find((c) => c.name === current[0].name)?.mineEdited, false);

  // 只勾第一步和新加的：第一步换新版、新加的插在内置里它前一步之后、我改的第二步保留、去掉的没勾就留着
  const merged = mergeBuiltinUpdate(mine, edited, new Set([current[0].name, current.at(-1)!.name]));
  assert.equal(merged[0].brief, current[0].brief);
  assert.ok(merged[1].brief.endsWith("我加的一句"));
  const lastBuiltin = current.at(-1)!.name;
  const prevName = current.at(-2)!.name;
  assert.equal(merged.findIndex((s) => s.name === lastBuiltin), merged.findIndex((s) => s.name === prevName) + 1);
  assert.ok(merged.some((s) => s.name === "旧步骤"));
  // 勾了去掉的那步：从我的版本里拿掉
  assert.ok(!mergeBuiltinUpdate(mine, edited, new Set(["旧步骤"])).some((s) => s.name === "旧步骤"));
  // 处理完（保留我的 / 按勾选更新）对照点挪到现在的内置，不再提示
  assert.equal(builtinUpdate({ steps: mine, basedOn: rebased(basedOn, current) }, current), null);
});

test("导入的包带文件才在加进项目前再问一次", () => {
  assert.equal(importedScriptsNote({ name: "a", imported: false, scripts: ["skills/x/a.py"] }), null);
  assert.equal(importedScriptsNote({ name: "a", imported: true, scripts: [] }), null);
  const many = Array.from({ length: 10 }, (_, i) => `skills/x/s${i}.py`);
  const note = importedScriptsNote({ name: "质控", imported: true, scripts: many })!;
  assert.ok(note.includes("「质控」是从别人那里导入的"));
  assert.ok(note.includes("· x/s0.py"));
  assert.ok(note.includes("…共 10 项"));
  assert.ok(!note.includes("s9.py"));
});

test("自查：我的版本加了核验或资源就算改过，内置升级不自动整份换掉", () => {
  const review = basedOnFor("review")!;
  const old = [{ ...review.steps[0], brief: "旧" }, ...review.steps.slice(1)];
  const withCheck = old.map((s, i) => (i === 1 ? { ...s, checks: [{ name: "c", skill: "k", script: "s.py", description: "" }] } : s));
  const up = builtinUpdate({ steps: withCheck, basedOn: { ...review, steps: old } }, review.steps)!;
  assert.equal(up.untouched, false);
});
