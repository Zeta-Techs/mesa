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

test("非晶前缀 the a-Ni 与美式名词复数 analyses / catalyses 不误判为语病或英美混用", () => {
  const root = mkdtempSync(join(tmpdir(), "ms-check-slip-spell-"));
  mkdirSync(join(root, "manuscript"), { recursive: true });
  writeFileSync(
    join(root, "manuscript/review.md"),
    [
      "## Introduction",
      "",
      "Spectroscopic analyses and electrocatalytic catalyses reveal that the a-Ni/c-MoO2 heterointerface,",
      "the a–b plane, and the A-site environment were systematically analyzed and optimized.",
      "By contrast, the a catalyst phrase is a real article slip.",
      "",
      "## Conclusions {#sec-conclusions}",
      "",
      "Summary.",
    ].join("\n"),
  );
  try {
    const r = run(["--root", root], root);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const list = items(root);
    const concl = find(list, "CONCLUSION")[0];
    assert.equal(concl?.status, "passed");
    assert.doesNotMatch(concl?.title ?? "", /#sec-conclusions/, "Quarto 标题锚点属性不带进检查标题");
    const slips = find(list, "SLIP-");
    assert.equal(slips.length, 1, `只应报真正的 'the a catalyst'，实际：${JSON.stringify(slips)}`);
    assert.match(slips[0].evidence?.quote ?? slips[0].title, /the a catalyst/);
    assert.equal(find(list, "SPELL-MIX")[0]?.status, "passed", "analyses / catalyses 不当成英式动词");

    // 真正出现英式动词（analyse / analysing）时仍能抓出英美混用
    writeFileSync(
      join(root, "manuscript/review.md"),
      "## Introduction\n\nSamples were analyzed for optimization and characterization while analysing surface states to analyse trends.\n\n## Conclusions\n\nEnd.\n",
    );
    const r2 = run(["--root", root], root);
    assert.equal(r2.status, 0, r2.stderr + r2.stdout);
    const mix = find(items(root), "SPELL-MIX")[0];
    assert.equal(mix?.status, "needs_human");
    assert.match(mix?.evidence?.detail ?? "", /analyse/);
    assert.match(mix?.evidence?.detail ?? "", /analysing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("文末 References 节与 Word Bibliography 样式里的所引论文标题不计入正文连接号/拼写混用（2026-11-15 HER 定稿实证）", () => {
  const root = mkdtempSync(join(tmpdir(), "ms-check-refs-"));
  mkdirSync(join(root, "manuscript"), { recursive: true });
  writeFileSync(
    join(root, "manuscript/review-final.md"),
    [
      "## Introduction",
      "",
      "W–P co-doping was analyzed to optimize catalytic performance.",
      "",
      "## Conclusions",
      "",
      "Summary.",
      "",
      "## References",
      "",
      "[1] Chen et al., Tuning electronic property via W-P co-doping to catalyse behaviour in grey electrodes.",
    ].join("\n"),
  );
  const docx = join(root, "review-final.docx");
  const builder = String.raw`
import sys, zipfile
W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
def p(text, style=""):
    ppr = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
    return f'<w:p>{ppr}<w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>'
body = "".join([
    p("1 Introduction", "Heading2"),
    p("W–P co-doping was analyzed to optimize catalytic performance."),
    p("2 Conclusions", "Heading2"),
    p("Summary."),
    p("References", "Heading2"),
    p("[23] Chen et al., Tuning electronic property via W-P co-doping to catalyse behaviour.", "Bibliography"),
])
with zipfile.ZipFile(sys.argv[1], "w") as z:
    z.writestr("word/document.xml", f'<w:document {W}><w:body>{body}</w:body></w:document>')
`;
  const built = spawnSync(python, ["-c", builder, docx], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  try {
    const r = run(["manuscript/review-final.md", docx, "--root", root], root);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const list = items(root);
    assert.equal(find(list, "DASH-WP").length, 0, `References 里的 W-P 原标题不应报连接号不一：${JSON.stringify(list)}`);
    assert.ok(find(list, "SPELL-MIX").every((i) => i.status === "passed"), `References 里的英式拼写不应判混用：${JSON.stringify(list)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pandoc 语法雷区：双约等号 ~ 误配下标、表格未转义 |e| 错列、列表前缺空行与漏方括号 (@Key) 全部检出", () => {
  const root = mkdtempSync(join(tmpdir(), "ms-check-pandoc-"));
  mkdirSync(join(root, "manuscript"), { recursive: true });
  writeFileSync(
    join(root, "manuscript/draft.md"),
    [
      "---",
      "title: Boride HER Review",
      "---",
      "",
      "## Mechanisms",
      "",
      "Legitimate subscripts H~2~O, ΔG~H\\*~ and inline code `~10` or math $a \\sim 20$ stay clean.",
      "Overpotential dropped from ~120 to ~38 mV across the series (@Wang2024).",
      "Single approximate value ~45 mV needs review.",
      "",
      "| Material | Charge transfer | Source |",
      "| --- | --- | --- |",
      "| Co-B | 1.34 |e| | [@Wang2024] |",
      "| Ni-B | 0.82 \\|e\\| | [@Wang2024] |",
      "",
      "Key takeaways below:",
      "- First point without blank line before list.",
      "- Second point.",
      "",
      "## Conclusions",
      "",
      "Done.",
    ].join("\n"),
  );
  try {
    const r = run(["--root", root], root);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    const list = items(root);
    assert.equal(find(list, "MD-TILDE-BLOCK")[0]?.status, "blocked", JSON.stringify(list));
    assert.equal(find(list, "MD-TILDE-WARN")[0]?.status, "needs_human", JSON.stringify(list));
    assert.equal(find(list, "MD-TABLE-PIPE")[0]?.status, "blocked", JSON.stringify(list));
    assert.match(find(list, "MD-TABLE-PIPE")[0]?.evidence?.detail ?? "", /表头 3 列、本行 5 列/);
    assert.equal(find(list, "MD-LIST-BLANK")[0]?.status, "needs_human", JSON.stringify(list));
    assert.equal(find(list, "MD-PAREN-CITE")[0]?.status, "blocked", JSON.stringify(list));
    assert.match(find(list, "MD-PAREN-CITE")[0]?.evidence?.detail ?? "", /\(@Wang2024\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check_pdf_text.py：检出高图图注侵入页脚页码区，正常排版放行，--skip-layout 跳过版面检查", () => {
  const hasFit = spawnSync(python, ["-c", "import pymupdf"], { encoding: "utf8" }).status === 0;
  if (!hasFit) return;
  const checkPdf = resolve("src-tauri/resources/skills/quarto-render/scripts/check_pdf_text.py");
  const root = mkdtempSync(join(tmpdir(), "pdf-footer-"));
  const okPdf = join(root, "ok.pdf");
  const badPdf = join(root, "bad.pdf");
  const mk = spawnSync(python, ["-c", [
    "import sys, pymupdf",
    "doc = pymupdf.open(); p = doc.new_page(width=595, height=842)",
    "p.insert_text((72, 100), 'Figure 1. Clean caption well above footer.', fontsize=10)",
    "p.insert_text((290, 800), '12', fontsize=10)",
    "doc.save(sys.argv[1]); doc.close()",
    "doc2 = pymupdf.open(); p2 = doc2.new_page(width=595, height=842)",
    "p2.insert_text((72, 796), 'Figure 3. Very tall composite figure caption colliding with page number.', fontsize=10)",
    "p2.insert_text((290, 800), '12', fontsize=10)",
    "doc2.save(sys.argv[2]); doc2.close()",
  ].join("\n"), okPdf, badPdf], { encoding: "utf8" });
  assert.equal(mk.status, 0, mk.stderr);
  try {
    const rOk = spawnSync(python, [checkPdf, okPdf], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    assert.equal(rOk.status, 0, rOk.stdout + rOk.stderr);
    assert.match(rOk.stdout, /无页脚碰撞/);

    const rBad = spawnSync(python, [checkPdf, badPdf], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    assert.equal(rBad.status, 1, rBad.stdout + rBad.stderr);
    assert.match(rBad.stdout, /页脚\/底边碰撞/);
    assert.match(rBad.stdout, /图注\/表题/);

    const rSkip = spawnSync(python, [checkPdf, badPdf, "--skip-layout"], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    assert.equal(rSkip.status, 0, rSkip.stdout + rSkip.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("投稿体例卫生与绝对路径泄露：检出零散加粗、破折号过密、粗体清单、内部策划词、模板修辞、全称绝对否定与本机绝对路径", () => {
  const root = mkdtempSync(join(tmpdir(), "ms-check-hygiene-"));
  mkdirSync(join(root, "manuscript"), { recursive: true });
  mkdirSync(join(root, "figures"), { recursive: true });
  // 构造 >500 词正文以便测试长破折号千词密度
  const filler = "Catalytic activity depends on surface reconstruction under alkaline polarization conditions in boride electrocatalysts. ";
  const denseEmdash = Array.from({ length: 25 }, () => `${filler}The interface — governed by dynamic leaching — evolves rapidly across cycles.`).join(" ");
  const boldList = Array.from({ length: 8 }, (_, i) => `- **Point ${i + 1}**: Surface boron dissolution alters kinetics.`).join("\n");
  writeFileSync(
    join(root, "manuscript/draft.md"),
    [
      "## Introduction",
      "",
      "The **alkaline boride interface** shows a **38 mV** overpotential. Rather than conventional oxide catalysis, we observe a stark contrast that proves indispensable and unmistakably central, and we delve into this multifaceted landscape.",
      "",
      "This review follows an eight-section sandwich architecture across the reviewed corpus under Pillar I and Track A, offering a forensic verdict based on abstract-level reporting.",
      "",
      "Across the entire peer-reviewed literature, not one study reports post-HER support XPS, giving zero reports (0/6).",
      "",
      denseEmdash,
      "",
      boldList,
      "",
      "## Conclusions",
      "",
      "Summary.",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "manuscript/voice-profile.md"),
    "## Voice Profile\n\n- **Benchmark**: stark contrast — indispensable.\n",
  );
  writeFileSync(
    join(root, "figures/README.md"),
    "# Figures\n\nBuilt via [script](file:///Users/alice/ccode/workspaces/demo/draft/analysis/run.py).\n",
  );
  try {
    const r = run(["--root", root], root);
    assert.equal(r.status, 1, "figures/README.md 残留本机绝对路径应拦下");
    const list = items(root);
    assert.ok(!list.some((i) => i.id.includes("voice-profile")), "voice-profile.md 属于配套文件不进正文扫描");
    assert.equal(find(list, "PROSE-BOLD")[0]?.status, "needs_human", JSON.stringify(list));
    assert.equal(find(list, "PROSE-BOLD-LIST")[0]?.status, "needs_human", JSON.stringify(list));
    assert.equal(find(list, "PROSE-EMDASH")[0]?.status, "needs_human", JSON.stringify(list));
    assert.equal(find(list, "PROSE-INTERNAL-TERMS")[0]?.status, "needs_human", JSON.stringify(list));
    assert.equal(find(list, "PROSE-CLICHE")[0]?.status, "needs_human", JSON.stringify(list));
    assert.equal(find(list, "PROSE-ABS-NEG")[0]?.status, "needs_human", JSON.stringify(list));
    assert.equal(find(list, "PATH-ABS-LEAK@figures/README.md")[0]?.status, "blocked", JSON.stringify(list));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
