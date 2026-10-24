import assert from "node:assert/strict";
import test from "node:test";
import { skillFileDiff } from "../src/skill-diff.ts";

test("技能差异：只画改动处，没改的长段折成 ⋯，CRLF 不算改动", () => {
  const body = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  const changed = [...body];
  changed[5] = "line 5 changed";
  changed[25] = "line 25 changed";
  const d = skillFileDiff(body.join("\r\n") + "\r\n", changed.join("\n") + "\n");
  assert.equal(d.added, 2);
  assert.equal(d.removed, 2);
  // 两处改动之间 20 行没改：折成一个 ⋯，前后各留 2 行
  const ops = d.lines.map((l) => l.op).join("");
  assert.ok(d.lines.length < 20, ops);
  assert.match(ops, /~  -\+  ~  -\+  ~/);
  assert.deepEqual(skillFileDiff("a\r\nb\r\n", "a\nb\n"), { lines: [], added: 0, removed: 0 });
});
