import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// 引用核验固定脚本（bib-check/scripts/cite_check.py，2026-11-02）：结果写成 Mesa 核验项，
// 状态只有 passed / blocked / needs_human；要读懂内容的永不判通过。测试一律离线。
const python = process.platform === "win32" ? "python" : "python3";
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) process.env[k] = "http://127.0.0.1:9";
process.env.MESA_LIT_OFFLINE = "1";
const script = resolve("src-tauri/resources/skills/bib-check/scripts/cite_check.py");
const run = (args: string[], cwd: string) => spawnSync(python, [script, ...args], { cwd, encoding: "utf8", timeout: 60_000 });

interface Item {
  id: string;
  kind: string;
  status: string;
  title: string;
  target?: { file: string; line?: number };
  evidence?: { detail?: string; page?: number };
}
const items = (root: string, name: string): Item[] =>
  readFileSync(join(root, ".ccode/checks", name), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
const byId = (list: Item[], id: string) => list.find((i) => i.id === id);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cite-check-"));
  mkdirSync(join(root, "manuscript"), { recursive: true });
  writeFileSync(
    join(root, "references.bib"),
    "@article{smith2020,\n  title = {Deep learning for proteins},\n  doi = {10.1/abc}\n}\n" +
      "@article{lee2019,\n  title = {Graph methods}\n}\n@article{lee2019,\n  title = {Graph methods again}\n}\n",
  );
  writeFileSync(
    join(root, "manuscript/review-draft.md"),
    "# Intro\n\nProteins fold [@smith2020; @ghost2021].\n\nSee @fig-one and email a@b.com; cycled @500 mA g-1.\n\n```\n[@incode]\n```\n\nAs @lee2019 showed.\n",
  );
  // 这类文件不是正文，里面的引用不算
  writeFileSync(join(root, "manuscript/citation-check.md"), "[@notcounted]\n");
  writeFileSync(join(root, "manuscript/section-status.md"), "[@notcounted2]\n");
  return root;
}

test("refs：找不到的键拦下、重复键拦下、交叉引用与代码块不算，离线时如实说没核", () => {
  const root = fixture();
  try {
    const r = run(["refs", "--root", root], root);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    const list = items(root, "cite-refs.jsonl");
    assert.equal(byId(list, "REF-smith2020")?.status, "passed");
    const ghost = byId(list, "REF-ghost2021");
    assert.equal(ghost?.status, "blocked");
    assert.deepEqual(ghost?.target, { file: "manuscript/review-draft.md", line: 3 });
    assert.equal(byId(list, "DUP-lee2019")?.status, "blocked");
    assert.equal(byId(list, "REF-lee2019")?.target?.line, 11);
    for (const absent of ["REF-fig-one", "REF-incode", "REF-notcounted", "REF-notcounted2", "REF-b.com", "REF-500"]) assert.equal(byId(list, absent), undefined, absent);
    assert.equal(byId(list, "ONLINE")?.status, "needs_human");
    assert.ok(list.every((i) => ["passed", "blocked", "needs_human"].includes(i.status)));
    assert.match(r.stdout, /拦下 2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refs：LaTeX 的 \\cite 也认", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "manuscript/main.tex"), "Text \\citep[p.~3]{smith2020, nobody}.\n");
    run(["refs", "--root", root, "--manuscript", "manuscript/main.tex"], root);
    const list = items(root, "cite-refs.jsonl");
    assert.equal(byId(list, "REF-smith2020")?.status, "passed");
    assert.equal(byId(list, "REF-nobody")?.status, "blocked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quotes：没有摘录文件就拦下并退出 2", () => {
  const root = fixture();
  try {
    const r = run(["quotes", "--root", root], root);
    assert.equal(r.status, 2);
    assert.equal(byId(items(root, "cite-quotes.jsonl"), "EVIDENCE")?.status, "blocked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quotes：逐字找原句——断词、弯引号、省略号都认；编的拦下；只有摘要的交人", (t) => {
  if (spawnSync(python, ["-c", "import pymupdf"], { encoding: "utf8" }).status !== 0) {
    t.skip("没装 PyMuPDF");
    return;
  }
  const root = fixture();
  const project = mkdtempSync(join(tmpdir(), "cite-check-proj-"));
  try {
    mkdirSync(join(project, "papers"), { recursive: true });
    mkdirSync(join(project, "notes"), { recursive: true });
    const pdf = join(project, "papers/Smith2020-proteins.pdf");
    // 标准字体画不出弯引号：PDF 里放直引号、摘录里写弯引号，同样要认（两边都归一）
    const make =
      "import pymupdf,sys; d=pymupdf.open(); d.new_page(); p=d.new_page(); " +
      "p.insert_text((72,72),'We show that the folding ener-'); p.insert_text((72,90),'gy landscape is \"funnel shaped\" in all cases.'); " +
      "p.insert_text((72,108),'Later results confirm the trend for large proteins.'); d.save(sys.argv[1])";
    assert.equal(spawnSync(python, ["-c", make, pdf], { encoding: "utf8" }).status, 0);
    // 早期项目：included.json 没记 pdf、文件用题名命名放在项目根，按题名认（2026-11-02 真实项目干跑）
    const legacy = join(project, "Graph Methods for Protein Interaction Networks_ A Survey.pdf");
    const make2 = "import pymupdf,sys; d=pymupdf.open(); p=d.new_page(); p.insert_text((72,72),'Graphs help to model protein interactions.'); d.save(sys.argv[1])";
    assert.equal(spawnSync(python, ["-c", make2, legacy], { encoding: "utf8" }).status, 0);
    writeFileSync(
      join(project, "papers/included.json"),
      JSON.stringify([
        { id: "W1", title: "Deep", pdf: "papers/Smith2020-proteins.pdf" },
        { id: "W3", title: "Graph methods for protein interaction networks: a survey" },
      ]),
    );
    writeFileSync(
      join(project, "notes/index.json"),
      JSON.stringify([
        { id: "W1", bibKey: "smith2020", fulltextStatus: "fulltext" },
        { id: "W2", bibKey: "lee2019", fulltextStatus: "abstract-only" },
        { id: "W3", bibKey: "wu2021", fulltextStatus: "fulltext" },
      ]),
    );
    writeFileSync(
      join(root, "manuscript/evidence.json"),
      JSON.stringify({
        quotes: [
          { id: "Q001", location: "manuscript/review-draft.md:3", key: "smith2020", quote: "the folding energy landscape is \u201cfunnel shaped\u201d", page: 2079 },
          { id: "Q002", location: "manuscript/review-draft.md:3", key: "smith2020", quote: "We show that … for large proteins" },
          { id: "Q003", location: "manuscript/review-draft.md:3", key: "smith2020", quote: "folding is always fast" },
          { id: "Q004", location: "manuscript/review-draft.md:11", key: "lee2019", quote: "graphs help" },
          { id: "Q005", location: "manuscript/review-draft.md:11", key: "wu2021", quote: "Graphs help to model protein interactions" },
        ],
      }),
    );
    const r = run(["quotes", "--root", root, "--project", project, "--coverage"], root);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    const list = items(root, "cite-quotes.jsonl");
    const q1 = byId(list, "Q-Q001");
    assert.equal(q1?.status, "passed");
    assert.match(q1?.evidence?.detail ?? "", /第 2 页.*标注 p\.2079/);
    assert.equal(byId(list, "Q-Q002")?.status, "passed");
    assert.equal(byId(list, "Q-Q003")?.status, "blocked");
    assert.equal(byId(list, "Q-Q004")?.status, "needs_human");
    assert.equal(byId(list, "Q-Q005")?.status, "passed");
    // 稿件里引了但没给摘录的：交人看，不判通过也不拦
    assert.equal(byId(list, "COV-ghost2021")?.status, "needs_human");
    assert.equal(byId(list, "COV-smith2020"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("refs：默认递归 manuscript/（LaTeX 章节在 chapters/ 里），模板目录不扫；也可指定文件", () => {
  const root = fixture();
  try {
    mkdirSync(join(root, "manuscript/chapters"), { recursive: true });
    mkdirSync(join(root, "manuscript/template"), { recursive: true });
    mkdirSync(join(root, "submission"), { recursive: true });
    writeFileSync(join(root, "manuscript/main.tex"), "\\input{chapters/intro}\n");
    writeFileSync(join(root, "manuscript/chapters/intro.tex"), "As shown \\cite{smith2020,inchapter}.\n");
    writeFileSync(join(root, "manuscript/template/sample.tex"), "\\cite{templatekey}\n");
    writeFileSync(join(root, "submission/formatted.md"), "Formatted [@onlyformatted].\n");
    run(["refs", "--root", root], root);
    let list = items(root, "cite-refs.jsonl");
    assert.equal(byId(list, "REF-inchapter")?.status, "blocked");
    assert.equal(byId(list, "REF-inchapter")?.target?.file, "manuscript/chapters/intro.tex");
    assert.equal(byId(list, "REF-templatekey"), undefined);
    assert.equal(byId(list, "REF-onlyformatted"), undefined);
    run(["refs", "--root", root, "--manuscript", "submission/formatted.md"], root);
    list = items(root, "cite-refs.jsonl");
    assert.equal(byId(list, "REF-onlyformatted")?.status, "blocked");
    assert.equal(byId(list, "REF-inchapter"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refs：句中点名的作者对号——整句找、带重音的 bib 也认，对不上拦下，没作者交人（离线也做）", () => {
  const root = mkdtempSync(join(tmpdir(), "cite-named-"));
  mkdirSync(join(root, "manuscript"), { recursive: true });
  writeFileSync(
    join(root, "references.bib"),
    "@article{smith2020,\n  author = {Smith, John and Park, Bo},\n  title = {A}\n}\n" +
      "@article{zhou2001,\n  author = {Zhou, Yi},\n  title = {B}\n}\n" +
      "@article{lee2021,\n  author = {Lee, Ann},\n  title = {C}\n}\n" +
      '@article{hacker2025,\n  author = {H{\\"a}cker, Jan and Garc{\\\'\\i}a Lastra, J. M.},\n  title = {D}\n}\n' +
      "@article{brown2019,\n  author = {Brown, Carl},\n  title = {E}\n}\n" +
      "@misc{noauth,\n  title = {F}\n}\n",
  );
  writeFileSync(
    join(root, "manuscript/review-draft.md"),
    "# Intro\n\nSmith et al. showed fast plating [@smith2020]. Lee and co-workers measured\n" +
      "small clusters [@zhou2001] and assigned them to MgS [@lee2021].\n\n" +
      "Wang et al. found a new phase [@brown2019]. Häcker and colleagues tracked interfaces [@hacker2025].\n" +
      "Jones et al. wrote a report [@noauth].\n",
  );
  writeFileSync(join(root, "manuscript/ch.tex"), "Brown et al. measured it \\cite{brown2019}. Smith et al. disagreed \\citep{zhou2001}.\n");
  try {
    const r = run(["refs", "--root", root], root);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    const named = items(root, "cite-refs.jsonl").filter((i) => i.kind === "citation_named_author");
    const find = (who: string) => named.find((i) => i.title.startsWith(`点名 ${who}`) && i.target?.file.endsWith(".md"));
    assert.equal(find("Smith")?.status, "passed");
    // 点名 Lee，紧跟的是佐证引文 zhou2001，Lee 那篇在同一句后面：算对上
    assert.equal(find("Lee")?.status, "passed");
    assert.equal(find("Wang")?.status, "blocked");
    assert.deepEqual(find("Wang")?.target, { file: "manuscript/review-draft.md", line: 6 });
    assert.equal(find("Häcker")?.status, "passed");
    assert.equal(find("Jones")?.status, "needs_human");
    const tex = named.filter((i) => i.target?.file === "manuscript/ch.tex");
    assert.deepEqual(tex.map((i) => i.status).sort(), ["blocked", "passed"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
