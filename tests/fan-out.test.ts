import assert from "node:assert/strict";
import test from "node:test";
import { allLanesDone, fanOutSummary, laneDoneMark, lanePrompt, laneReuseKey, mergePrompt } from "../src/fan-out.ts";
import { PIPELINE_TEMPLATES } from "../src/pipeline-presets.ts";

const spec = PIPELINE_TEMPLATES.find((t) => t.id === "review")!.steps.find((s) => s.workspaceName === "lit-notes")!.fanOut!;

test("精读步声明了按篇分路：纳入的篇、每路 8 篇、最多 4 路；论文模板的「精读与研究空白」不分", () => {
  assert.equal(spec.items, "papers/included.json");
  // 综述精读第一轮：综述精读、研究论文全部速读（2026-11-05 用户拍板），照旧按全部纳入的篇分；速读写各路自己的文件、收尾合表
  assert.equal(spec.filter, "decision=included");
  assert.ok(spec.own.includes("notes/skim-<本路号>.md"));
  assert.ok(spec.merge.includes("notes/skim.md") && spec.merge.includes("angles-facts"));
  assert.deepEqual([spec.per, spec.max], [8, 4]);
  assert.ok(PIPELINE_TEMPLATES.find((t) => t.id === "thesis")!.steps.some((s) => s.fanOut));
  assert.ok(!PIPELINE_TEMPLATES.find((t) => t.id === "research-paper")!.steps.some((s) => s.fanOut));
});

test("每一路的开场：全局序号、只写自己的、共享文件留给收尾、做完写标记", () => {
  const items = [
    { seq: 9, key: "10.1/x", label: "Boride HER" },
    { seq: 10, key: "10.1/y", label: "" },
  ];
  const p = lanePrompt(spec, items, 2, 3, false);
  assert.ok(p.startsWith("这一步按数据分成 3 路同时做，你是第 2 路"));
  assert.ok(p.includes("- 09 | 10.1/x | Boride HER") && p.includes("- 10 | 10.1/y"));
  assert.ok(p.includes("notes/<序号>-<短标题>.md"));
  assert.ok(p.includes("不跑 lit_records.py write"), "2026-11-03 Codex 干跑实证：不点名它会先跑、写出共享清单");
  assert.ok(p.includes("一律不写") && p.includes("也不跑，这些都留给最后的收尾一路") && p.includes("不跑 git 提交") && p.includes("放系统临时目录"));
  assert.ok(p.includes("`.ccode/fanout/lane-2.done`"));
  assert.ok(lanePrompt(spec, items, 1, 2, true).includes("& $env:MESA_PEEK_TOOL peek agents"));
  assert.equal(laneDoneMark(3), ".ccode/fanout/lane-3.done");
  assert.equal(laneReuseKey("ws:/wt/lit-notes", 2), "ws:/wt/lit-notes#lane-2");
});

test("收尾一路与弹层那一行、到齐判定", () => {
  const m = mergePrompt({ name: "文献精读与笔记" }, spec, 3);
  assert.ok(m.includes("「文献精读与笔记」刚才分 3 路同时做完了"));
  assert.ok(m.includes("lit_records.py") && m.includes("notes/index.json"));
  assert.ok(m.includes("不要重做各路已经做好的条目") && m.includes("照搬各路写好的行"));
  assert.equal(fanOutSummary(30, 4), "30 条分 4 路同时做（4 段对话各自计费），各路做完再开一路收尾");
  assert.equal(fanOutSummary(5, 1), "5 条，不到分路的量，照常一路做");
  assert.equal(fanOutSummary(0, 0), "数据文件里还没有条目，分不了路");
  assert.ok(allLanesDone([3, 1, 2], 3));
  assert.ok(!allLanesDone([1, 3], 3));
  assert.ok(!allLanesDone([], 0));
});

test("lanesToHeal：只补没做完、没标签、从没起过运行、还没补过的路", async () => {
  const { lanesToHeal } = await import("../src/fan-out.ts");
  const keys = ["k1", "k2", "k3", "k4"];
  assert.deepEqual(
    lanesToHeal({ lanes: 4, done: [], laneKeys: keys, openKeys: new Set(["k2", "k3", "k4"]), ranKeys: new Set(["k2", "k3", "k4"]), healed: [] }),
    [1],
    "第 1 路标签没了、也没起过运行：补",
  );
  assert.deepEqual(
    lanesToHeal({ lanes: 4, done: [], laneKeys: keys, openKeys: new Set(["k2"]), ranKeys: new Set(["k1", "k2", "k3", "k4"]), healed: [] }),
    [],
    "起过运行又被人关掉的不补",
  );
  assert.deepEqual(
    lanesToHeal({ lanes: 4, done: [1], laneKeys: keys, openKeys: new Set(), ranKeys: new Set(), healed: [2] }),
    [3, 4],
    "做完的、补过的不再补",
  );
});
