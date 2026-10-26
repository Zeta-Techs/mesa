import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  includedMdLine,
  parseIncludedRecords,
  recordToEndnoteRis,
  recordToZoteroRis,
} from "../src/screening-review.ts";

// 检索步题录固定脚本（lit-search/scripts/lit_records.py）：一份 included.json 出清单、两份 RIS、引文库，
// 拼法要和 Mesa 界面「纳入」时追加 RIS 的那份（screening-review.ts risBody）逐条一致——两边对不上，
// 人点纳入后追加的那条和检索步写的就是两种样子，同步进 Zotero / EndNote 也是两种样子。
const python = process.platform === "win32" ? "python" : "python3";
// 脚本里有联网补全（Crossref、ISO 4 缩写表 LTWA）：测试一律连不上外网，免得外部站点变慢就拖到超时（2026-10-26 CI：
// issn.org 对 runner 一直不回，用例卡满超时被杀）。出站指向不监听的本机代理，连接当场被拒、脚本走离线分支
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) process.env[k] = "http://127.0.0.1:9";
const script = resolve("src-tauri/resources/skills/lit-search/scripts/lit_records.py");
const bridge = resolve("src-tauri/resources/skills/endnote-bridge/scripts/bridge.py");
const run = (args: string[], cwd: string) =>
  spawnSync(python, [script, ...args], { cwd, encoding: "utf8", timeout: 60_000 });

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
const cacheBody = (dir: string, url: string, body: unknown) =>
  writeFileSync(join(dir, `${sha1(url)}.body`), typeof body === "string" ? body : JSON.stringify(body));

const records = [
  {
    id: "W1",
    title: "Development of a Novel Pt₃V Alloy Electrocatalyst for Hydrogen Evolution",
    decision: "included",
    reason: "纳入：直接相关",
    authors: ["Da, Yumin", "Jiang, Rui", "Tian, Zhangliu", "Han, Xiao"],
    year: "2023",
    venue: "Advanced Energy Materials",
    volume: "13",
    issue: "17",
    pages: "2300127",
    date: "May 2023",
    epubDate: "March 14, 2023",
    articleType: "Journal Article",
    issn: "1614-6832",
    journalAbbreviation: "Adv. Energy Mater.",
    abstract: "Hydrogen (H₂) energy is presumed to be the most promising.",
    keywords: ["hydrogen evolution reaction", "Pt alloy"],
    language: "en",
    doi: "10.1002/aenm.202300127",
    url: "https://doi.org/10.1002/aenm.202300127",
  },
  {
    id: "W2",
    title: "Recent advances of MXenes as electrocatalysts",
    decision: "included",
    reason: "纳入：综述",
    authors: ["Bai, Saishuai"],
    year: "2021",
    venue: "Small",
    volume: "5",
    issue: "待补",
    pages: "e12357",
    date: "September 2021",
    epubDate: "待补",
    articleType: "待补",
    issn: "2397-7132",
    journalAbbreviation: "Small",
    abstract: "待补",
    keywords: "待补",
    language: "en",
    doi: "10.1038/s41699-021-00259-4",
    url: "https://doi.org/10.1038/s41699-021-00259-4",
  },
  {
    id: "W3",
    title: "Turing structuring with multiple nanotwins for hydrogen evolution reaction",
    decision: "included",
    reason: "纳入：开放获取已下",
    authors: ["Gu, Jialun"],
    year: "2023",
    venue: "Nature Communications",
    volume: "14",
    issue: "1",
    pages: "5389",
    date: "September 4, 2023",
    epubDate: "待补",
    articleType: "Journal Article",
    issn: "2041-1723",
    journalAbbreviation: "Nat. Commun.",
    abstract: "Low-dimensional nanocrystals.",
    keywords: ["Turing"],
    language: "en",
    doi: "10.1038/s41467-023-40972-w",
    url: "https://doi.org/10.1038/s41467-023-40972-w",
  },
  {
    id: "W4",
    title: "Efficient FeCoNiCuPd thin-film electrocatalyst",
    decision: "pending",
    reason: "待确认：只做了碱性",
    authors: ["Wang, Shiqi"],
    year: "2022",
    venue: "Applied Catalysis B: Environmental",
    volume: "313",
    issue: "待补",
    pages: "121472",
    date: "September 2022",
    epubDate: "待补",
    articleType: "Journal Article",
    issn: "0926-3373",
    journalAbbreviation: "Appl. Catal. B",
    abstract: "待补",
    keywords: "待补",
    language: "en",
    doi: "10.1016/j.apcatb.2022.121472",
    url: "https://doi.org/10.1016/j.apcatb.2022.121472",
  },
  { id: "W5", title: "Off-topic paper", decision: "excluded", reason: "排除：主题无关" },
];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mesa-lit-records-"));
  const ws = join(root, "ws");
  const proj = join(root, "proj");
  mkdirSync(join(ws, "papers"), { recursive: true });
  mkdirSync(join(proj, "papers"), { recursive: true });
  writeFileSync(join(ws, "papers/included.json"), JSON.stringify(records, null, 2));
  // W3 已有全文：人按「作者年份-短标题」起的名字，缩写 HER 认得出
  writeFileSync(join(proj, "papers/Gu2023-Turing-nanotwins-HER.pdf"), "%PDF-1.4 fake");
  return { root, ws, proj };
}

test("write：清单与两份 RIS 只从 included.json 出，RIS 与 Mesa 界面纳入时追加的那份逐条一致", () => {
  const { root, ws, proj } = fixture();
  try {
    let r = run(["write", "--root", proj], ws);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const rows = parseIncludedRecords(readFileSync(join(ws, "papers/included.json"), "utf8"));
    const byId = new Map(rows.map((row) => [row.id, row]));
    // 有全文的不进待获取；待确认、排除的不进
    const fetchMd = readFileSync(join(ws, "papers/to-fetch.md"), "utf8");
    assert.match(fetchMd, /^1\. Development of a Novel Pt₃V Alloy .* — 10\.1002\/aenm\.202300127$/m);
    assert.match(fetchMd, /^2\. Recent advances of MXenes as electrocatalysts — 10\.1038\/s41699-021-00259-4$/m);
    assert.doesNotMatch(fetchMd, /Turing|FeCoNiCuPd|Off-topic/);
    // json 里记下全文位置（Mesa 阅读区按 pdf 字段认回题名）
    const json = JSON.parse(readFileSync(join(ws, "papers/included.json"), "utf8"));
    assert.equal(json.find((x: { id: string }) => x.id === "W3").pdf, "papers/Gu2023-Turing-nanotwins-HER.pdf");
    // 两份 RIS：CRLF、同序、逐条与 TS 一致
    const zotero = readFileSync(join(ws, "papers/to-fetch.ris"), "utf8");
    const endnote = readFileSync(join(ws, "papers/endnote-import.ris"), "utf8");
    const listed = ["W1", "W2"].map((id) => byId.get(id)!);
    assert.equal(zotero, listed.map(recordToZoteroRis).join("\r\n\r\n") + "\r\n");
    assert.equal(endnote, listed.map(recordToEndnoteRis).join("\r\n\r\n") + "\r\n");
    // 「待补」不进任何标签；文章类型待补时 EndNote 写 Journal Article
    assert.doesNotMatch(zotero + endnote, /待补/);
    assert.match(endnote, /M3  - Journal Article\r\nSN  - 2397-7132/);
    assert.match(zotero, /AU  - Da, Yumin\r\nAU  - Jiang, Rui\r\nAU  - Tian, Zhangliu\r\nAU  - Han, Xiao\r\n/);
    assert.doesNotMatch(zotero, /^(?:DA|ET|M2|M3|LA|JO|N1)  - /m);
    // 一词刊名缩写等于全称：不写 J2
    assert.doesNotMatch(zotero.split("ER  - ")[1], /J2  - /);
    // included.md 与 Mesa 的行写法一致；计数从 json 来
    const md = readFileSync(join(ws, "papers/included.md"), "utf8");
    assert.match(md, /终判纳入 3 篇，另有待确认 1 篇，人工排除 1 篇/);
    for (const id of ["W1", "W2", "W3", "W4"]) assert.ok(md.includes(includedMdLine(byId.get(id)!)), id);
    assert.match(md, /Da, Yumin; Jiang, Rui; Tian, Zhangliu 等 4 人, 2023/);
    // 校验通过；动过 RIS 顺序就不过
    r = run(["check", "--root", proj], ws);
    assert.equal(r.status, 0, r.stdout);
    writeFileSync(join(ws, "papers/to-fetch.ris"), listed.reverse().map(recordToZoteroRis).join("\r\n\r\n") + "\r\n");
    r = run(["check", "--root", proj], ws);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /to-fetch\.ris 的条目与 to-fetch\.md 不同序/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write：已勾的待获取行保留编号与 ✓，移出的行去掉，新纳入的接在后面", () => {
  const { root, ws, proj } = fixture();
  try {
    writeFileSync(
      join(ws, "papers/to-fetch.md"),
      "# 待获取全文\n\n1. ✓ Recent advances of MXenes as electrocatalysts — 10.1038/s41699-021-00259-4\n2. Gone paper — 10.9999/gone\n",
    );
    const r = run(["write", "--root", proj], ws);
    assert.equal(r.status, 0, r.stderr);
    const md = readFileSync(join(ws, "papers/to-fetch.md"), "utf8");
    assert.match(md, /^1\. ✓ Recent advances of MXenes/m);
    assert.match(md, /^2\. Development of a Novel Pt₃V/m);
    assert.doesNotMatch(md, /Gone paper/);
    const ris = readFileSync(join(ws, "papers/to-fetch.ris"), "utf8");
    assert.ok(ris.indexOf("s41699-021-00259-4") < ris.indexOf("aenm.202300127"), "RIS 与清单同序");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("enrich：Crossref 为准补齐（上下标、&amp;、纸本日期与网络出版日分开），关键词取 OpenAlex，缩写查表，排除的不动", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-lit-enrich-"));
  try {
    const cache = join(root, "cache");
    mkdirSync(join(root, "papers"), { recursive: true });
    mkdirSync(cache);
    const doi = "10.1016/j.ensm.2022.01.001";
    writeFileSync(
      join(root, "papers/included.json"),
      JSON.stringify([
        { id: "A", title: "Mo 2 C display name", decision: "included", reason: "纳入", doi, authors: "Wrong One" },
        { id: "B", title: "Excluded", decision: "excluded", reason: "排除" },
      ]),
    );
    cacheBody(cache, `https://api.crossref.org/works/${doi}`, {
      status: "ok",
      message: {
        DOI: doi,
        type: "journal-article",
        title: ["Mo<sub>2</sub>C nanosheets for H<sub>2</sub> evolution"],
        author: [
          { family: "Li", given: "Ming" },
          { family: "Li", given: "Ming" },
          { family: "Zhang", given: "Wei" },
        ],
        "container-title": ["Energy Storage Materials"],
        "short-container-title": ["Energy Storage Materials"],
        volume: "45",
        page: "100-110",
        issued: { "date-parts": [[2022, 1, 5]] },
        "published-online": { "date-parts": [[2022, 1, 5]] },
        "published-print": { "date-parts": [[2022, 3]] },
        ISSN: ["2405-8297"],
        abstract: "<jats:title>Abstract</jats:title><jats:p>Hydrogen (H<sub>2</sub>) &amp; more.</jats:p>",
        language: "en",
      },
    });
    cacheBody(cache, `https://api.openalex.org/works/doi:${doi}`, {
      keywords: [
        { display_name: "Hydrogen evolution", score: 0.8 },
        { display_name: "Noise", score: 0.1 },
      ],
      primary_location: { source: { display_name: "Energy Storage Materials" } },
      biblio: { volume: "45", issue: "2" },
      language: "en",
    });
    const r = spawnSync(python, [script, "enrich", "--offline", "--cache", cache], { cwd: root, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const [a, b] = JSON.parse(readFileSync(join(root, "papers/included.json"), "utf8"));
    assert.equal(a.title, "Mo₂C nanosheets for H₂ evolution");
    assert.deepEqual(a.authors, ["Li, Ming", "Zhang, Wei"], "同一人写两次只留一次，作者以 Crossref 为准");
    assert.equal(a.venue, "Energy Storage Materials");
    assert.equal(a.journalAbbreviation, "Energy Storage Mater.", "Mesa 兜底表");
    assert.equal(a.date, "March 2022", "出版日期取纸本");
    assert.equal(a.epubDate, "January 5, 2022", "网络出版日另记");
    assert.equal(a.issue, "2", "Crossref 没有的期由 OpenAlex 补");
    assert.equal(a.pages, "100-110");
    assert.equal(a.abstract, "Hydrogen (H₂) & more.");
    assert.deepEqual(a.keywords, ["Hydrogen evolution"]);
    assert.equal(a.url, `https://doi.org/${doi}`);
    assert.equal(a.articleType, "Journal Article");
    assert.equal(b.title, "Excluded");
    assert.equal(b.venue, undefined, "排除的不补字段");
    // 字段顺序固定：id/title/decision/reason 在前
    assert.deepEqual(Object.keys(a).slice(0, 4), ["id", "title", "decision", "reason"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("开放获取：不收预印本时，Research Square 标成 acceptedVersion 的也不下；允许时排在正式版后面", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-lit-oa-"));
  try {
    const doi = "10.1038/s41467-023-44261-4";
    cacheBody(root, `https://api.openalex.org/works/doi:${doi}`, {
      locations: [
        { pdf_url: "https://www.researchsquare.com/article/rs-1/latest.pdf", version: "acceptedVersion", source: { display_name: "Research Square" } },
        { pdf_url: "https://www.nature.com/articles/s41467-023-44261-4.pdf", version: "publishedVersion", source: { display_name: "Nature Communications" } },
        { pdf_url: "https://repo.example.edu/1.pdf", version: "acceptedVersion", source: { display_name: "Univ Repository" } },
        { pdf_url: "https://arxiv.org/pdf/2301.1", version: "submittedVersion", source: { display_name: "arXiv" } },
      ],
    });
    const code = `import sys; sys.path.insert(0, sys.argv[1]); import lit_records as m; m.Net.cache=__import__('pathlib').Path(sys.argv[2]); m.Net.offline=True; print(m.oa_candidates(sys.argv[3], False)); print(m.oa_candidates(sys.argv[3], True))`;
    const r = spawnSync(python, ["-c", code, resolve(script, ".."), root, doi], { encoding: "utf8", timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr);
    const [strict, loose] = r.stdout.trim().split(/\r?\n/);
    assert.equal(strict, "['https://www.nature.com/articles/s41467-023-44261-4.pdf', 'https://repo.example.edu/1.pdf']");
    assert.match(loose, /^\['https:\/\/www\.nature\.com.*researchsquare.*arxiv/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bib：精读步从 included.json 写引文库——已有条目不改键、只补空的或「待补」的字段；新篇按 姓+年 起键；重跑不变", () => {
  const { root, ws } = fixture();
  try {
    const bib = join(ws, "references.bib");
    const existing = "@article{Da2023x,\n  title = {Development of a Novel Pt₃V Alloy Electrocatalyst for Hydrogen Evolution},\n  author = {Da, Yumin},\n  year = 2023,\n  volume = {待补},\n  doi = {10.1002/aenm.202300127}\n}\n";
    writeFileSync(bib, existing);
    let r = run(["bib"], ws);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.keys, { W1: "Da2023x", W2: "Bai2021", W3: "Gu2023" });
    assert.deepEqual(out.added, ["Bai2021", "Gu2023"]);
    assert.ok(out.filled.Da2023x.includes("volume"));
    let text = readFileSync(bib, "utf8");
    assert.match(text, /author = \{Da, Yumin\},/, "人写过的作者不覆盖");
    assert.match(text, /year = 2023,/);
    assert.match(text, /volume = \{13\}/);
    assert.match(text, /@article\{Bai2021,[\s\S]*number = \{待补\}/, "必填字段查不到写待补");
    assert.doesNotMatch(text, /FeCoNiCuPd/, "待确认默认不进引文库");
    r = run(["bib"], ws);
    assert.deepEqual(JSON.parse(r.stdout).added, []);
    assert.equal(readFileSync(bib, "utf8"), text, "重跑不变");
    // 同步到文献库时「待补」不进 RIS（bridge 读 bib 时当没有这个字段）
    const ris = join(ws, "lib.ris");
    r = spawnSync(python, [bridge, "--input", bib, "--output", ris, "--report", join(ws, "lib.json")], { encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    text = readFileSync(ris, "utf8");
    assert.equal((text.match(/^TY  - /gm) ?? []).length, 3);
    assert.doesNotMatch(text, /待补/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("不分期的刊：Crossref 有卷无期记「无期号」，不进 RIS、引文库不写 number，早先写的 number = {待补} 拿掉", () => {
  // 2026-10-23 HER 精读步：Appl. Catal. B / Chin. J. Catal. 只按卷编排，期号「待补」永远补不上，渲染出「(待补)」
  const root = mkdtempSync(join(tmpdir(), "mesa-lit-noissue-"));
  try {
    const cache = join(root, "cache");
    mkdirSync(join(root, "papers"), { recursive: true });
    mkdirSync(cache);
    const doi = "10.1016/j.apcatb.2021.120490";
    writeFileSync(join(root, "papers/included.json"), JSON.stringify([
      { id: "W", title: "Single atom Ru doping 2H-MoS2", decision: "included", reason: "纳入", doi },
    ]));
    cacheBody(cache, `https://api.crossref.org/works/${doi}`, {
      status: "ok",
      message: {
        DOI: doi, type: "journal-article", title: ["Single atom Ru doping 2H-MoS2"],
        author: [{ family: "Wang", given: "Kai" }], "container-title": ["Applied Catalysis B: Environmental"],
        volume: "298", page: "120490", issued: { "date-parts": [[2021, 11]] },
      },
    });
    cacheBody(cache, `https://api.openalex.org/works/doi:${doi}`, { biblio: { volume: "298" } });
    let r = spawnSync(python, [script, "enrich", "--offline", "--cache", cache], { cwd: root, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const [rec] = JSON.parse(readFileSync(join(root, "papers/included.json"), "utf8"));
    assert.equal(rec.issue, "无期号");
    assert.doesNotMatch(r.stdout, /待补：[^\n]*issue/, "不算缺口");
    const bib = join(root, "references.bib");
    writeFileSync(bib, `@article{Wang2021,\n  title = {Single atom Ru doping 2H-MoS2},\n  volume = {298},\n  number = {待补},\n  doi = {${doi}}\n}\n`);
    r = spawnSync(python, [script, "bib"], { cwd: root, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    let text = readFileSync(bib, "utf8");
    assert.doesNotMatch(text, /number/);
    assert.match(text, /volume = \{298\},\n  doi =/);
    writeFileSync(bib, "");
    r = spawnSync(python, [script, "bib"], { cwd: root, encoding: "utf8", timeout: 60_000 });
    text = readFileSync(bib, "utf8");
    assert.match(text, /@article\{Wang2021,/);
    assert.doesNotMatch(text, /number|无期号/, "新写的条目也不带 number");
    r = spawnSync(python, [script, "write", "--root", root], { cwd: root, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const ris = readFileSync(join(root, "papers/endnote-import.ris"), "utf8");
    assert.doesNotMatch(ris, /IS  -|无期号/);
    const [row] = parseIncludedRecords(readFileSync(join(root, "papers/included.json"), "utf8"));
    assert.doesNotMatch(recordToEndnoteRis(row), /IS  -|无期号/, "Mesa 纳入时追加的那份同口径");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Mesa 纳入时追加 RIS：数组作者一人一条 AU，「待补」的页、链接、文章类型不进标签", () => {
  const [row] = parseIncludedRecords(
    JSON.stringify([{ id: "X", title: "T", decision: "included", reason: "", authors: ["Doe, Jane", "Roe, John", "待补"], pages: "待补", url: "待补", articleType: "待补", doi: "10.1/x" }]),
  );
  const endnote = recordToEndnoteRis(row);
  assert.match(endnote, /AU  - Doe, Jane\r\nAU  - Roe, John\r\nTI/);
  assert.doesNotMatch(endnote, /待补/);
  assert.match(endnote, /M3  - Journal Article/);
  assert.match(endnote, /UR  - https:\/\/doi\.org\/10\.1\/x/);
});

test("认已有全文：文件名对不上（元素缩写、出版商编号名）时按 PDF 开头元数据里的 DOI 认", () => {
  const { root, ws, proj } = fixture();
  try {
    writeFileSync(join(proj, "papers/s41699-021.pdf"), "%PDF-1.4\n<</doi (10.1038/s41699-021-00259-4)>>\n");
    const r = run(["write", "--root", proj], ws);
    assert.equal(r.status, 0, r.stderr);
    const json = JSON.parse(readFileSync(join(ws, "papers/included.json"), "utf8"));
    assert.equal(json.find((x: { id: string }) => x.id === "W2").pdf, "papers/s41699-021.pdf");
    assert.doesNotMatch(readFileSync(join(ws, "papers/to-fetch.md"), "utf8"), /MXenes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 2026-10-23 HER：出版商 PDF 的元数据压在对象流里，原始字节搜不到 DOI；首页页眉印着
test("认已有全文：原始字节里没有 DOI 时，有 PyMuPDF 就按前两页文字认", (t) => {
  const probe = spawnSync(python, ["-c", "import pymupdf"], { encoding: "utf8" });
  if (probe.status !== 0) {
    t.skip("没装 PyMuPDF");
    return;
  }
  const { root, ws, proj } = fixture();
  try {
    const pdf = join(proj, "papers/Bai2021-MX-HER.pdf");
    const make = `import pymupdf,sys; d=pymupdf.open(); p=d.new_page(); p.insert_text((72,72),"https://doi.org/10.1038/s41699-021-00259-4"); d.save(sys.argv[1], deflate=True)`;
    assert.equal(spawnSync(python, ["-c", make, pdf], { encoding: "utf8" }).status, 0);
    assert.ok(!readFileSync(pdf).includes("s41699"), "原始字节里确实没有 DOI");
    const r = run(["write", "--root", proj], ws);
    assert.equal(r.status, 0, r.stderr);
    const json = JSON.parse(readFileSync(join(ws, "papers/included.json"), "utf8"));
    assert.equal(json.find((x: { id: string }) => x.id === "W2").pdf, "papers/Bai2021-MX-HER.pdf");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 2026-10-23 HER：用户自己 Zotero 库里导进来的，检索步按年份窗口排掉 9 篇、只写在 screening.md，
// Mesa 文献清单里看不到也改不回；导入登记的 PDF 也没认成全文，改判纳入后会被列进待获取
test("Zotero 导入：登记的 PDF 认成全文不进待获取；导入条目都要在 json 里，Agent 不排除", () => {
  const { root, ws, proj } = fixture();
  try {
    const storage = join(root, "Zotero", "storage", "ABCD1234");
    mkdirSync(storage, { recursive: true });
    const pdf = join(storage, "Bai et al_2021_MXenes.pdf");
    writeFileSync(pdf, "%PDF-1.4 fake");
    mkdirSync(join(proj, "papers/imports"), { recursive: true });
    const manifest = (rows: unknown[]) =>
      writeFileSync(join(proj, "papers/imports/zotero-batch.json"), JSON.stringify(rows));
    manifest([{ id: "1:ABCD1234", title: "MXenes", bibKey: "zotero1abcd1234", doi: "10.1038/s41699-021-00259-4", pdfPath: pdf, status: "imported" }]);
    let r = run(["write", "--root", proj], ws);
    assert.equal(r.status, 0, r.stderr);
    const json = JSON.parse(readFileSync(join(ws, "papers/included.json"), "utf8"));
    assert.equal(json.find((x: { id: string }) => x.id === "W2").pdf, pdf.replace(/\\/g, "/"));
    assert.doesNotMatch(readFileSync(join(ws, "papers/to-fetch.md"), "utf8"), /MXenes/);
    r = run(["check", "--root", proj], ws);
    assert.equal(r.status, 0, r.stdout);
    // 导入清单里有、json 里没有的：点名；Agent 自己排除的导入条目：点名；人移出的放过
    manifest([
      { id: "1:ABCD1234", title: "MXenes", bibKey: "zotero1abcd1234", doi: "10.1038/s41699-021-00259-4", pdfPath: pdf },
      { id: "1:EIT3KHJL", title: "Old review", bibKey: "zotero1eit3khjl", doi: "10.3389/fchem.2019.00085", pdfPath: null },
      { id: "1:OFFTOPIC", title: "Off-topic paper", bibKey: "W5", doi: null, pdfPath: null },
    ]);
    r = run(["check", "--root", proj], ws);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /Zotero 导入的 zotero1eit3khjl 不在 included\.json/);
    assert.match(r.stdout, /W5 是用户从 Zotero 导入的，Agent 不排除/);
    const rows = JSON.parse(readFileSync(join(ws, "papers/included.json"), "utf8"));
    rows.find((x: { id: string }) => x.id === "W5").reason = "排除：人工移出。主题无关";
    rows.push({ id: "zotero1eit3khjl", title: "Old review", decision: "excluded", reason: "排除：评审确认" });
    writeFileSync(join(ws, "papers/included.json"), JSON.stringify(rows, null, 2));
    r = run(["check", "--root", proj], ws);
    assert.doesNotMatch(r.stdout, /Zotero 导入|Agent 不排除/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
