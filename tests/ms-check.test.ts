import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// 投稿前检查（research-writing/scripts/ms_check.py，2026-11-08）：只读稿件，结果写 .ccode/checks/ms-check.jsonl 三档。
const python = process.platform === "win32" ? "python" : "python3";
const script = resolve("src-tauri/resources/skills/research-writing/scripts/ms_check.py");
const run = (args: string[], cwd: string) => spawnSync(python, [script, ...args], { cwd, encoding: "utf8", timeout: 60_000 });

interface Item {
  id: string;
  status: string;
  title: string;
  evidence?: { detail?: string };
}
const items = (root: string): Item[] =>
  readFileSync(join(root, ".ccode/checks/ms-check.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
const find = (list: Item[], prefix: string) => list.filter((i) => i.id.startsWith(prefix));

test("Markdown 稿：重复编号、手写标题编号、作者名拼错、图注缺出处、单位与拼写混用都点出来", () => {
  const root = mkdtempSync(join(tmpdir(), "ms-check-"));
  mkdirSync(join(root, "manuscript"), { recursive: true });
  writeFileSync(
    join(root, "manuscript/paper-final.md"),
    [
      "---",
      "title: Mg-S batteries",
      "number-sections: true",
      "author:",
      "  - name: Ling Sheng",
      "    email: shenglin@uni.edu",
      "  - name: Zhangxiang Hao",
      "    email: haozx@uni.edu",
      "---",
      "",
      "## 1. Introduction",
      "",
      "Mg–S cells deliver 1000 mAh g-1 and 900 mA h g-1 at 25 °C and 30 oC. The the behavior and the behaviour differ.",
      "Mg-S cells were analyzed in in situ XRD in terms of with care.",
      "",
      "Figure 1. Cycling data. Adapted from Smith et al.",
      "",
      "Figure 1. Another figure [@a].",
      "",
      "Figure 3. Third figure.",
      "",
      "## Methods",
      "",
      "Done.",
    ].join("\n"),
  );
  // 写作规范不是稿件（大纲那步就交）：它的「## 1 核心术语」、重复词一律不扫
  writeFileSync(join(root, "manuscript/style-sheet.md"), "## 1 核心术语\n\n- 引用一律 [@bib键]。The the rule.\n");
  try {
    const r = run(["--root", root], root);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.ok(!readFileSync(join(root, ".ccode/checks/ms-check.jsonl"), "utf8").includes("style-sheet"), "写作规范不进扫描");
    const list = items(root);
    const authors = find(list, "AUTHOR-");
    assert.equal(authors.length, 1, "拼音首字母 haozx 算对上，只点 Ling / shenglin");
    assert.match(authors[0].title, /Ling Sheng/);
    assert.equal(find(list, "HEAD-NUM")[0]?.status, "blocked");
    const cap = find(list, "CAP-NUM-Figure")[0];
    assert.equal(cap?.status, "blocked");
    assert.match(cap?.evidence?.detail ?? "", /重复：1/);
    assert.match(cap?.evidence?.detail ?? "", /缺：2/);
    assert.equal(find(list, "CAP-SRC-Figure1-")[0]?.status, "needs_human");
    const slips = find(list, "SLIP-").map((i) => i.title);
    assert.ok(slips.some((t) => /The the/.test(t)));
    assert.ok(slips.some((t) => /terms of with/.test(t)));
    assert.ok(!slips.some((t) => /in in/.test(t)), "in in situ 不是重复词");
    assert.ok(find(list, "UNIT-比容量").length === 1);
    assert.ok(find(list, "UNIT-摄氏度").length === 1);
    assert.ok(find(list, "DASH-MgS").length === 1);
    assert.equal(find(list, "SPELL-MIX")[0]?.status, "needs_human");
    assert.equal(find(list, "CONCLUSION")[0]?.status, "needs_human");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Word 稿：没有标题样式时按加粗短段认标题；自动编号与手打编号混用交人；有展望节算有结论", () => {
  const root = mkdtempSync(join(tmpdir(), "ms-check-docx-"));
  const builder = String.raw`
import sys, zipfile
W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
def p(text, bold=False, num=False):
    ppr = '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>' if num else ""
    rpr = "<w:rPr><w:b/></w:rPr>" if bold else ""
    return f'<w:p>{ppr}<w:r>{rpr}<w:t xml:space="preserve">{text}</w:t></w:r></w:p>'
body = "".join([
    p("A Review", bold=True), p("Ling Sheng,a Tianbao Ma*b"), p("* shenglin@uni.edu; tbma@uni.edu"),
    p("Abstract", bold=True), p("Text."), p("Introduction", bold=True, num=True), p("Body text."),
    p("2. Mechanisms", bold=True), p("Figure 1 (a) Data. Adapted from ref. 3"), p("Figure 2 Schematic of cells."),
    p("Figure 2 shows the cell."), p("5. Challenges and Future Perspectives", bold=True), p("End."),
])
with zipfile.ZipFile(sys.argv[1], "w") as z:
    z.writestr("word/document.xml", f'<w:document {W}><w:body>{body}</w:body></w:document>')
`;
  const docx = join(root, "draft.docx");
  const built = spawnSync(python, ["-c", builder, docx], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  try {
    const r = run([docx, "--root", root], root);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const list = items(root);
    assert.match(find(list, "AUTHOR-shenglin")[0]?.title ?? "", /Ling Sheng/);
    assert.equal(find(list, "AUTHOR-tbma").length, 0, "名首字母 + 姓算对上");
    const head = find(list, "HEAD-NUM")[0];
    assert.equal(head?.status, "needs_human");
    assert.match(head?.title ?? "", /1 个是 Word 自动编号，2 个是手打的编号/);
    assert.equal(find(list, "CAP-NUM-Figure")[0]?.status, "passed", "「Figure 2 shows」是正文，不算第二个图 2");
    assert.equal(find(list, "CAP-SRC-").length, 0, "Adapted from ref. 3 有出处");
    assert.equal(find(list, "CONCLUSION")[0]?.status, "passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
