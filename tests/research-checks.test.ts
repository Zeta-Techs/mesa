import assert from "node:assert/strict";
import test from "node:test";
import { checkChipText, checkConsultSeed, checkLocation, checkQuoteLine, countChecks, groupChecks, type CheckItem } from "../src/research-checks.ts";

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

test("请几家研讨这一条：标题、落点、摘录、说明进问题；落点前后 15 行与来源文件进材料", () => {
  const seed = checkConsultSeed(
    mk("c1", "needs_human", {
      title: "这句引用摘录撑不住正文的论断",
      target: { file: "manuscript/draft.md", line: 10 },
      evidence: { source: "notes/smith2020.md", quote: "effects were modest", page: 4, detail: "摘录说的是小效应" },
    }),
  );
  assert.match(seed.question, /这句引用摘录撑不住正文的论断/);
  assert.match(seed.question, /位置：manuscript\/draft\.md:10/);
  assert.match(seed.question, /「effects were modest」（标注 p\.4）/);
  assert.match(seed.question, /判断由我来定/);
  assert.deepEqual(seed.materials, [
    { path: "manuscript/draft.md", range: "1-25" },
    { path: "notes/smith2020.md", range: "" },
  ]);
  const web = checkConsultSeed(mk("c2", "needs_human", { evidence: { source: "https://doi.org/x.pdf" } }));
  assert.deepEqual(web.materials, []);
});
