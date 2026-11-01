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
    "# Intro\n\nProteins fold [@smith2020; @ghost2021].\n\nSee @fig-one and email a@b.com.\n\n```\n[@incode]\n```\n\nAs @lee2019 showed.\n",
  );
  // 这类文件不是正文，里面的引用不算
  writeFileSync(join(root, "manuscript/citation-check.md"), "[@notcounted]\n");
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
    for (const absent of ["REF-fig-one", "REF-incode", "REF-notcounted", "REF-b.com"]) assert.equal(byId(list, absent), undefined, absent);
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
    writeFileSync(join(project, "papers/included.json"), JSON.stringify([{ id: "W1", title: "Deep", pdf: "papers/Smith2020-proteins.pdf" }]));
    writeFileSync(
      join(project, "notes/index.json"),
      JSON.stringify([
        { id: "W1", bibKey: "smith2020", fulltextStatus: "fulltext" },
        { id: "W2", bibKey: "lee2019", fulltextStatus: "abstract-only" },
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
    // 稿件里引了但没给摘录的：交人看，不判通过也不拦
    assert.equal(byId(list, "COV-ghost2021")?.status, "needs_human");
    assert.equal(byId(list, "COV-smith2020"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
