import assert from "node:assert/strict";
import test from "node:test";
import { assignSlots, FORMATIONS, pickNextFormation } from "../src/jump-formations.ts";

test("队形表：起手式是一行，id 不重复，三枚都在 32px 圆钮里放得下", () => {
  assert.equal(FORMATIONS[0].id, "row");
  assert.equal(new Set(FORMATIONS.map((f) => f.id)).size, FORMATIONS.length);
  for (const f of FORMATIONS) {
    for (const s of f.slots) {
      // 横光标半宽 3px、圆点约 2px；圆钮内半径约 13px，留一点呼吸张缩的余量
      assert.ok(Math.hypot(Math.abs(s.x) + 3, Math.abs(s.y) + 2) < 12, `${f.id} 越界`);
    }
  }
});

test("随机换队：不会原地换成同一个，rand 取遍 [0,1) 都落在别的队形上", () => {
  for (const f of FORMATIONS) {
    const seen = new Set<string>();
    for (let k = 0; k < 100; k++) {
      const next = pickNextFormation(f.id, k / 100);
      assert.notEqual(next.id, f.id);
      seen.add(next.id);
    }
    assert.equal(seen.size, FORMATIONS.length - 1, "每个别的队形都抽得到");
  }
  assert.ok(pickNextFormation("row", 0.9999999));
});

test("分配格子：按总路程最短，换队时三枚不交叉", () => {
  const row = FORMATIONS.find((f) => f.id === "row")!.slots;
  const stack = FORMATIONS.find((f) => f.id === "stack")!.slots;
  // 一行 → 自己：原地不动
  assert.deepEqual(assignSlots(row, row), [...row]);
  // 一行 → 一摞：中间那枚留在中心，左右两枚各去上下（不会让中间那枚穿过别人去顶上）
  const out = assignSlots(row, stack);
  assert.deepEqual(out[1], stack[1]);
  // 逆序给目标，结果与目标顺序无关
  const reversed = [stack[2], stack[1], stack[0]];
  const out2 = assignSlots(row, reversed);
  const cost = (o: typeof out) =>
    o.reduce((sum, s, i) => sum + (s.x - row[i].x) ** 2 + (s.y - row[i].y) ** 2, 0);
  assert.equal(cost(out2), cost(out));
});
