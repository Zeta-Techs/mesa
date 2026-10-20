import assert from "node:assert/strict";
import test from "node:test";
import { scheduleWarnText, sumRefs, usageWarnText } from "../src/unbind-impact.ts";

test("没有受影响定时任务时不出警告", () => {
  assert.equal(scheduleWarnText([]), "");
});

test("定时任务警告列前 3 个名字，超过加「等」", () => {
  const two = scheduleWarnText([{ name: "A" }, { name: "B" }]);
  assert.match(two, /有 2 条定时任务/);
  assert.match(two, /「A」、「B」）/);
  const five = scheduleWarnText(["A", "B", "C", "D", "E"].map((name) => ({ name })));
  assert.match(five, /「A」、「B」、「C」 等）/);
  assert.doesNotMatch(five, /「D」/);
});

test("项目与目标引用为 0 或数不出来时不出警告", () => {
  assert.equal(usageWarnText(null), "");
  assert.equal(usageWarnText({ projects: 0, goals: 0 }), "");
  assert.match(usageWarnText({ projects: 2, goals: 1 }), /2 个项目.*1 条目标/s);
});

test("多条连接的引用数求和", () => {
  assert.deepEqual(
    sumRefs([
      { projects: 1, goals: 2 },
      { projects: 3, goals: 0 },
    ]),
    { projects: 4, goals: 2 },
  );
  assert.deepEqual(sumRefs([]), { projects: 0, goals: 0 });
});
