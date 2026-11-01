import assert from "node:assert/strict";
import test from "node:test";
import { checkChipText, checkLocation, checkQuoteLine, countChecks, groupChecks, type CheckItem } from "../src/research-checks.ts";

const mk = (id: string, status: CheckItem["status"], extra: Partial<CheckItem> = {}): CheckItem => ({
  id,
  kind: "quote_in_source",
  status,
  title: id,
  ...extra,
});

test("核验清单：拦下在前、待你判断其次、通过最后；待你判断不折进通过", () => {
  const items = [mk("a", "passed"), mk("b", "needs_human"), mk("c", "blocked"), mk("d", "passed")];
  assert.deepEqual(
    groupChecks(items).map((g) => [g.status, g.items.map((i) => i.id)]),
    [["blocked", ["c"]], ["needs_human", ["b"]], ["passed", ["a", "d"]]],
  );
  assert.deepEqual(countChecks(items), { passed: 2, blocked: 1, needsHuman: 1 });
  assert.equal(checkChipText(items), "核验 4 项 · 拦下 1 · 待你判断 1");
  assert.equal(checkChipText([mk("a", "passed")]), "核验 1 项 · 通过");
  assert.equal(checkChipText([mk("a", "passed"), mk("b", "needs_human")]), "核验 2 项 · 待你判断 1");
});

test("核验清单：位置与摘录的写法", () => {
  assert.equal(checkLocation(mk("a", "passed", { target: { file: "manuscript/x.md", line: 3 } })), "manuscript/x.md:3");
  assert.equal(checkLocation(mk("a", "passed", { target: { file: "references.bib" } })), "references.bib");
  assert.equal(checkLocation(mk("a", "passed")), "");
  assert.equal(checkQuoteLine(mk("a", "passed", { evidence: { quote: "原句", page: 12 } })), "「原句」（标注 p.12）");
  assert.equal(checkQuoteLine(mk("a", "passed", { evidence: { quote: " 原句 " } })), "「原句」");
  assert.equal(checkQuoteLine(mk("a", "passed", { evidence: { detail: "x" } })), "");
});
