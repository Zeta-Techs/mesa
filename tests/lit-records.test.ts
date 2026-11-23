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
process.env.MESA_LIT_OFFLINE = "1"; // bridge.py 也不读本机 30 天缓存（见 research-tool-scripts.test.ts）
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

test("bib：检索排除了的篇移出引文库（按 DOI，没 DOI 按标题），点名还在引它的稿件；重跑不变", () => {
  // 2026-11-10 HER：检索补料轮排除了 Kawashima2023，精读跟进后引文库、交棒约束、可写点清单里都还留着
  const root = mkdtempSync(join(tmpdir(), "mesa-lit-prune-"));
  try {
    mkdirSync(join(root, "papers"), { recursive: true });
    mkdirSync(join(root, "manuscript"), { recursive: true });
    writeFileSync(join(root, "papers/included.json"), JSON.stringify([
      { id: "K", title: "A Review of Transition Metal Boride Water Oxidation Electrocatalysts", decision: "excluded", reason: "排除：人工移出", doi: "10.1021/acs.chemrev.3c00005" },
      { id: "T", title: "Removed borate review without any identifier", decision: "excluded", reason: "排除：人工移出" },
      { id: "G", title: "Amorphous cobalt boride", decision: "included", reason: "纳入", doi: "10.1002/anie.201601234", authors: ["Gupta, S."], year: 2016 },
    ]));
    const bib = join(root, "references.bib");
    writeFileSync(bib,
      "@article{Kawashima2023,\n  title = {A Review},\n  doi = {https://doi.org/10.1021/ACS.CHEMREV.3C00005}\n}\n\n" +
      "@article{Cui2020,\n  title = {Removed {borate} review without any identifier},\n  year = {2020}\n}\n\n" +
      "@article{Gupta2016,\n  title = {Amorphous cobalt boride},\n  doi = {10.1002/anie.201601234}\n}\n");
    writeFileSync(join(root, "outline.md"), "## 1\n见 [@Kawashima2023; @Gupta2016]。\n");
    writeFileSync(join(root, "manuscript/draft.md"), "As reviewed [@Gupta2016], email a@Cui2020x.\n");
    let r = spawnSync(python, [script, "bib"], { cwd: root, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.removed, ["Kawashima2023", "Cui2020"]);
    assert.deepEqual(out.citedBy, { Kawashima2023: ["outline.md"] });
    const text = readFileSync(bib, "utf8");
    assert.ok(text.startsWith("@article{Gupta2016,"), text);
    assert.doesNotMatch(text, /Kawashima2023|Cui2020/);
    assert.equal((text.match(/^@article/gm) ?? []).length, 1);
    r = spawnSync(python, [script, "bib"], { cwd: root, encoding: "utf8", timeout: 60_000 });
    assert.equal(JSON.parse(r.stdout).removed, undefined);
    assert.equal(readFileSync(bib, "utf8"), text, "重跑不变");
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

test("kind 只在 json 里：不进 RIS；写错值 check 拦；angles-facts 按截至年数之后纳入的研究论文", () => {
  const { root, ws, proj } = fixture();
  try {
    const path = join(ws, "papers/included.json");
    const json = JSON.parse(readFileSync(path, "utf8"));
    json.find((x: { id: string }) => x.id === "W2").kind = "review";
    json.find((x: { id: string }) => x.id === "W1").kind = "research";
    writeFileSync(path, JSON.stringify(json, null, 2));
    let r = run(["write", "--root", proj], ws);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const ris = readFileSync(join(ws, "papers/to-fetch.ris"), "utf8") + readFileSync(join(ws, "papers/endnote-import.ris"), "utf8");
    assert.doesNotMatch(ris, /\bkind\b/);
    r = run(["check", "--root", proj], ws);
    assert.equal(r.status, 0, r.stdout);
    // 写错值：check 点名
    json.find((x: { id: string }) => x.id === "W1").kind = "综述";
    writeFileSync(path, JSON.stringify(json, null, 2));
    r = run(["write", "--root", proj], ws);
    r = run(["check", "--root", proj], ws);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /kind 应是 review \/ research \/ other/);
    // angles-facts：W2（综述，2021 截至 2020）之后纳入的研究论文 = W1（2023）
    json.find((x: { id: string }) => x.id === "W1").kind = "research";
    writeFileSync(path, JSON.stringify(json, null, 2));
    mkdirSync(join(ws, "notes"), { recursive: true });
    // 带 BOM 的 index.json（Windows 记事本存的）照样读
    writeFileSync(join(ws, "notes/index.json"), "\uFEFF" + JSON.stringify([{ id: "W2", bibKey: "Bai2021", cutoffYear: 2020 }, { id: "W1", bibKey: "Da2023" }]));
    r = run(["angles-facts"], ws);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /纳入综述 1 篇、研究论文 1 篇/);
    assert.match(r.stdout, /\| \[@Bai2021\] Recent advances of MXenes .* \| 2020 \| 1 篇：\[@Da2023\] \|/);
    // 标题里的 | 转义，不把表格拆列
    json.find((x: { id: string }) => x.id === "W2").title = "MXenes | a review";
    writeFileSync(path, JSON.stringify(json, null, 2));
    r = run(["angles-facts"], ws);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /\| \[@Bai2021\] MXenes \\\| a review \| 2021 \| 2020 \|/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("impact：影响因子只从 Mesa 的期刊指标表来，查不到写「表中无此刊」，没有工具就不写、报错退出", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "lit-impact-"));
  try {
    mkdirSync(join(root, "papers"));
    const json = join(root, "papers", "included.json");
    writeFileSync(json, JSON.stringify([
      { id: "a", title: "A", decision: "included", reason: "纳入", venue: "Chemical Reviews", impactFactor: "99" },
      { id: "b", title: "B", decision: "included", reason: "纳入", venue: "Unknown" },
      { id: "c", title: "C", decision: "excluded", reason: "排除", venue: "Fuel" },
    ], null, 2));
    // 没有 MESA_JOURNAL_TOOL：退出 2，不动文件
    const env = { ...process.env };
    delete env.MESA_JOURNAL_TOOL;
    const before = readFileSync(json, "utf8");
    const none = spawnSync(python, [script, "impact"], { cwd: root, encoding: "utf8", env, timeout: 30_000 });
    assert.equal(none.status, 2);
    assert.match(none.stderr, /不要凭记忆估/);
    assert.equal(readFileSync(json, "utf8"), before);
    // 假 helper：按 Mesa 的输出格式回一份结果
    const tool = join(root, "fake-helper.sh");
    writeFileSync(tool, `#!/bin/sh\necho '{"a":{"impactFactor":"55.8","casQuartile":1,"top":true},"b":null,"c":{"impactFactor":"7.5","casQuartile":2,"top":false}}'\n`, { mode: 0o755 });
    const r = spawnSync(python, [script, "impact"], { cwd: root, encoding: "utf8", env: { ...env, MESA_JOURNAL_TOOL: tool }, timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /查到 2 篇，表中无此刊 1 篇/);
    const rows = JSON.parse(readFileSync(json, "utf8"));
    assert.deepEqual(rows.map((x: any) => x.id), ["a", "b", "c"], "顺序不变");
    assert.equal(rows[0].impactFactor, "55.8", "旧的手填值被表里的覆盖");
    assert.equal(rows[0].casQuartile, 1);
    assert.equal(rows[0].casTop, true);
    assert.equal(rows[1].impactFactor, "表中无此刊");
    assert.equal(rows[1].casQuartile, undefined);
    assert.equal(rows[2].casTop, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write：接着上一版编号的新篇，开头写「某天新加：第 x–y 篇」；上一版的说明照留；首次生成不写", () => {
  const root = mkdtempSync(join(tmpdir(), "lit-added-"));
  try {
    mkdirSync(join(root, "papers"));
    const rec = (id: string, title: string) => ({ id, title, decision: "included", reason: "纳入", doi: id, authors: ["A, B"], year: "2020", venue: "J", url: `https://doi.org/${id}` });
    writeFileSync(join(root, "papers", "included.json"), JSON.stringify([rec("10.1/a", "Alpha"), rec("10.1/b", "Beta")], null, 2));
    assert.equal(run(["write", "--root", root], root).status, 0);
    const first = readFileSync(join(root, "papers", "to-fetch.md"), "utf8");
    assert.doesNotMatch(first, /新加/);
    writeFileSync(join(root, "papers", "to-fetch.md"), first.replace("2. Beta", "2. ✓ Beta"));
    writeFileSync(join(root, "papers", "included.json"), JSON.stringify([rec("10.1/a", "Alpha"), rec("10.1/b", "Beta"), rec("10.1/c", "Gamma"), rec("10.1/d", "Delta")], null, 2));
    assert.equal(run(["write", "--root", root], root).status, 0);
    const second = readFileSync(join(root, "papers", "to-fetch.md"), "utf8");
    assert.match(second, /^\d{4}-\d{2}-\d{2} 新加：第 3–4 篇。$/m);
    assert.match(second, /^2\. ✓ Beta/m, "上一版的 ✓ 照留");
    // 再跑一次：没有新篇，说明照留
    assert.equal(run(["write", "--root", root], root).status, 0);
    assert.match(readFileSync(join(root, "papers", "to-fetch.md"), "utf8"), /新加：第 3–4 篇。/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write 持久化 bibKey 并与 bib/angles-facts 对齐；摘要含单边花括号不崩；未打勾排除重排仍记新加；无 DOI 缺全文与预印本可检", () => {
  const root = mkdtempSync(join(tmpdir(), "lit-extra-"));
  try {
    mkdirSync(join(root, "papers"));
    const mk = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
      id,
      title,
      decision: "included",
      reason: "纳入",
      authors: ["Zhang, Wei"],
      year: "2024",
      venue: "Adv. Mater.",
      volume: "36",
      issue: "无期号",
      pages: "2400001",
      date: "2024",
      epubDate: "待补",
      articleType: "Journal Article",
      issn: "0935-9648",
      journalAbbreviation: "Adv. Mater.",
      abstract: "Active {110 facet under alkaline HER.",
      keywords: ["HER"],
      language: "en",
      doi: id.startsWith("10.") ? id : "待补",
      url: id.startsWith("10.") ? `https://doi.org/${id}` : "https://example.org/nodoi",
      ...extra,
    });
    const jsonPath = join(root, "papers", "included.json");
    writeFileSync(jsonPath, JSON.stringify([
      mk("10.1/old1", "Old One", { kind: "review", year: "2021" }),
      mk("10.1/old2", "Old Two", { kind: "research" }),
    ], null, 2));
    assert.equal(run(["write", "--root", root], root).status, 0);
    const written1 = JSON.parse(readFileSync(jsonPath, "utf8"));
    assert.equal(written1[0].bibKey, "Zhang2021");
    assert.equal(written1[1].bibKey, "Zhang2024");

    // 没人打 ✓ 时排除第 1 篇并新加 1 篇：编号从 1 重排，仍应写出「新加：第 2 篇」
    written1[0].decision = "excluded";
    written1.push(mk("no-doi-1", "No DOI Paper", { authors: ["Li, Na"], year: "2025", kind: "other" }));
    writeFileSync(jsonPath, JSON.stringify(written1, null, 2));
    assert.equal(run(["write", "--root", root], root).status, 0);
    assert.match(readFileSync(join(root, "papers", "to-fetch.md"), "utf8"), /新加：第 2 篇。/);

    // bib 接受单边 {110 花括号并复用 included.json 里的 bibKey
    const bibRes = run(["bib"], root);
    assert.equal(bibRes.status, 0, bibRes.stderr);
    const bibOut = JSON.parse(bibRes.stdout);
    assert.equal(bibOut.keys["10.1/old2"], "Zhang2024");
    assert.equal(bibOut.keys["no-doi-1"], "Li2025");

    // angles-facts 在没有 notes/index.json 时回退到 bibKey，且计入 kind=other
    const rowsForAngles = JSON.parse(readFileSync(jsonPath, "utf8"));
    rowsForAngles[0].decision = "included";
    writeFileSync(jsonPath, JSON.stringify(rowsForAngles, null, 2));
    assert.equal(run(["write", "--root", root], root).status, 0);
    const af = run(["angles-facts"], root);
    assert.equal(af.status, 0, af.stderr);
    assert.match(af.stdout, /\[@Zhang2021\]/);
    assert.match(af.stdout, /@Zhang2024; @Li2025/);

    // 手删 to-fetch.md 里的无 DOI 条目 → check 报错；加预印本与漏填 kind → check 给告警
    const fetchMd = readFileSync(join(root, "papers", "to-fetch.md"), "utf8")
      .split("\n")
      .filter((l) => !l.includes("No DOI Paper"))
      .join("\n");
    writeFileSync(join(root, "papers", "to-fetch.md"), fetchMd);
    const badCheck = run(["check", "--root", root], root);
    assert.notEqual(badCheck.status, 0);
    assert.match(badCheck.stdout, /无 DOI 条目「No DOI Paper」不在 to-fetch\.md/);

    rowsForAngles.push(mk("10.48550/arXiv.2401.00001", "Preprint HER", { kind: "" }));
    writeFileSync(jsonPath, JSON.stringify(rowsForAngles, null, 2));
    assert.equal(run(["write", "--root", root], root).status, 0);
    const warnCheck = run(["check", "--root", root], root);
    assert.equal(warnCheck.status, 0, warnCheck.stdout);
    assert.match(warnCheck.stdout, /看起来是预印本/);
    assert.match(warnCheck.stdout, /漏填 review \/ research \/ other/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fetch：每篇只试第 1 条直链不换链，连续 3 次 HTTP 403 即停，区分无合规直链 / 下载失败 / 停止后未尝试", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-lit-fetch-"));
  try {
    mkdirSync(join(root, "papers"), { recursive: true });
    const mk = (id: string, title: string, doi: string) => ({
      id, title, decision: "included", reason: "纳入", doi,
      authors: ["Li, Na"], year: "2025", venue: "Nano Energy", url: `https://doi.org/${doi}`,
    });
    const rows = [
      mk("p0", "No Link Paper", "10.1000/nolink"),
      mk("p1", "Forbidden One", "10.1000/f1"),
      mk("p2", "Forbidden Two", "10.1000/f2"),
      mk("p3", "Forbidden Three", "10.1000/f3"),
      mk("p4", "Skipped After Stop", "10.1000/after"),
    ];
    writeFileSync(join(root, "papers", "included.json"), JSON.stringify(rows, null, 2));
    const code = `
import sys, types
sys.path.insert(0, sys.argv[1])
import lit_records as m
m.utf8_stdio()  # 直调 cmd_fetch 绕过了 main()：Windows 管道默认 cp1252，中文进度一打印就崩
tried = []
def fake_candidates(doi, allow_preprint=False):
    if doi == "10.1000/nolink": return []
    return [f"https://a.test/{doi}.pdf", f"https://b.test/{doi}.pdf"]
def fake_download(url, dest):
    tried.append(url)
    raise m.Forbidden()
m.oa_candidates = fake_candidates
m.download_pdf = fake_download
m.cmd_fetch(types.SimpleNamespace(json=sys.argv[2], root=sys.argv[3], allow_preprint=False))
print("TRIED=" + ",".join(tried))
`;
    const r = spawnSync(
      python,
      ["-c", code, resolve("src-tauri/resources/skills/lit-search/scripts"), join(root, "papers", "included.json"), root],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /无合规直链：10\.1000\/nolink/);
    assert.doesNotMatch(r.stdout, /付费墙：/);
    assert.match(r.stdout, /停止后未尝试：Skipped After Stop/);
    assert.match(r.stdout, /连续 3 次 403，已停止其余下载/);
    // 每篇只试第 1 条链（a.test），绝不换链试 b.test，且停手后不再请求 after
    assert.match(r.stdout, /TRIED=https:\/\/a\.test\/10\.1000\/f1\.pdf,https:\/\/a\.test\/10\.1000\/f2\.pdf,https:\/\/a\.test\/10\.1000\/f3\.pdf$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check：来源表认可的同名或无句点刊名缩写不误报，仍拦未缩写的错误全称", () => {
  const { root, ws, proj } = fixture();
  try {
    const path = join(ws, "papers/included.json");
    const rows = JSON.parse(readFileSync(path, "utf8"));
    rows[0].venue = "Nano Energy";
    rows[0].journalAbbreviation = "Nano Energy";
    rows[1].venue = "Sustainable Energy & Fuels";
    rows[1].journalAbbreviation = "Sustainable Energy Fuels";
    writeFileSync(path, JSON.stringify(rows, null, 2));
    assert.equal(run(["write", "--root", proj], ws).status, 0);
    const ok = run(["check", "--root", proj], ws);
    assert.equal(ok.status, 0, ok.stdout);
    assert.doesNotMatch(ok.stdout, /不像 ISO 4/);

    rows[0].venue = "Advanced Materials";
    rows[0].journalAbbreviation = "Advanced Materials";
    writeFileSync(path, JSON.stringify(rows, null, 2));
    assert.equal(run(["write", "--root", proj], ws).status, 0);
    const warned = run(["check", "--root", proj], ws);
    assert.equal(warned.status, 0, warned.stdout);
    assert.match(warned.stdout, /期刊缩写「Advanced Materials」不像 ISO 4/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write：pending 的 Zotero 导入条目也记下 pdf，后续纳入不误进待获取", () => {
  const { root, ws, proj } = fixture();
  try {
    const zPdf = join(root, "zotero-pending.pdf");
    writeFileSync(zPdf, "%PDF-1.4 zotero");
    mkdirSync(join(proj, "papers/imports"), { recursive: true });
    writeFileSync(
      join(proj, "papers/imports/zotero-test.json"),
      JSON.stringify([{ id: "1:PENDPDF1", bibKey: "zotero1pendpdf1", title: "Pending Zotero Paper", doi: "10.1000/pendpdf", pdfPath: zPdf }]),
    );
    const path = join(ws, "papers/included.json");
    const rows = JSON.parse(readFileSync(path, "utf8"));
    rows.push({
      id: "zotero1pendpdf1",
      title: "Pending Zotero Paper",
      decision: "pending",
      reason: "待确认",
      doi: "10.1000/pendpdf",
      authors: ["Li, Na"],
      year: "2024",
      venue: "Nano Energy",
      journalAbbreviation: "Nano Energy",
      url: "https://doi.org/10.1000/pendpdf",
    });
    writeFileSync(path, JSON.stringify(rows, null, 2));
    assert.equal(run(["write", "--root", proj], ws).status, 0);
    const updated = JSON.parse(readFileSync(path, "utf8"));
    const item = updated.find((x: { id: string }) => x.id === "zotero1pendpdf1");
    assert.equal(item.pdf, zPdf.replace(/\\/g, "/"), "pending 条目也必须落盘 Zotero pdf 路径");

    // 模拟之前误把已有 PDF 的条目写进待获取清单（且尚未手工勾选 ✓），重跑 write 应自动清出待获取
    item.decision = "included";
    writeFileSync(path, JSON.stringify(updated, null, 2));
    writeFileSync(
      join(ws, "papers/to-fetch.md"),
      "# 待获取全文\n\n1. Pending Zotero Paper — 10.1000/pendpdf\n",
    );
    assert.equal(run(["write", "--root", proj], ws).status, 0);
    assert.doesNotMatch(readFileSync(join(ws, "papers/to-fetch.md"), "utf8"), /Pending Zotero Paper/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pdfs：识别 Supporting Information 不误当正文全文，同时输出统一 absPath 与 source", () => {
  const { root, ws, proj } = fixture();
  try {
    // 给 W1 放一个带 Supporting Information 文件名的 SI 文件，给 W2 放 Zotero 绝对路径正文 PDF
    mkdirSync(join(proj, "papers"), { recursive: true });
    writeFileSync(join(proj, "papers/Wang2023-Supporting-Information.pdf"), "%PDF-1.4 si");
    const zPdf = join(root, "Zotero", "storage", "Z1", "Bai2021.pdf");
    mkdirSync(join(root, "Zotero", "storage", "Z1"), { recursive: true });
    writeFileSync(zPdf, "%PDF-1.4 main");
    mkdirSync(join(proj, "papers/imports"), { recursive: true });
    writeFileSync(
      join(proj, "papers/imports/zotero-si.json"),
      JSON.stringify([{ id: "1:Z1", bibKey: "W2", title: "MXenes", doi: "10.1038/s41699-021-00259-4", pdfPath: zPdf }]),
    );
    const path = join(ws, "papers/included.json");
    const rows = JSON.parse(readFileSync(path, "utf8"));
    rows.find((x: { id: string }) => x.id === "W1").title = "Wang 2023 Supporting Information Test";
    writeFileSync(path, JSON.stringify(rows, null, 2));
    const r = run(["pdfs", "--root", proj], ws);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const w2 = out.found.find((x: { id: string }) => x.id === "W2");
    assert.ok(w2, "W2 Zotero 正文 PDF 应被认出");
    assert.equal(w2.source, "zotero");
    assert.ok(w2.absPath.endsWith("/Bai2021.pdf"));
    assert.equal(out.found.some((x: { id: string }) => x.id === "W1"), false, "SI 文件不得进 found");
    assert.ok(out.missing.some((x: { id: string }) => x.id === "W1"), "只有 SI 的条目应留在 missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pdfs：识别出版商 SI 后缀（sc4c04490_si_001）且 --json-only 静默 stderr", () => {
  const { root, ws, proj } = fixture();
  try {
    mkdirSync(join(proj, "papers"), { recursive: true });
    writeFileSync(join(proj, "papers/10.1021_acssuschemeng.4c04490_si_001.pdf"), "%PDF-1.4 acs si");
    const path = join(ws, "papers/included.json");
    const rows = JSON.parse(readFileSync(path, "utf8"));
    rows.find((x: { id: string }) => x.id === "W1").doi = "10.1021/acssuschemeng.4c04490";
    writeFileSync(path, JSON.stringify(rows, null, 2));
    const r = run(["pdfs", "--root", proj, "--json-only"], ws);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr.trim(), "", "--json-only 应静默 stderr 中文摘要");
    const out = JSON.parse(r.stdout);
    assert.equal(out.found.some((x: { id: string }) => x.id === "W1"), false, "ACS _si_001 不得当正文");
    assert.ok(out.supportingOnly?.some((x: { id: string }) => x.id === "W1"), "ACS _si_001 应标进 supportingOnly");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("table：--get / --upsert 幂等转义 | 防拆列 + --remove 移出已排除行", () => {
  const { root, ws } = fixture();
  try {
    mkdirSync(join(ws, "notes"), { recursive: true });
    const skim = join(ws, "notes/skim.md");
    writeFileSync(
      skim,
      [
        "# 速读表",
        "",
        "| 键 | 年份 | 主要结论 | 全文 |",
        "|---|---|---|---|",
        "| @Wang2023 | 2023 | 旧结论 | 无 |",
        "| @Dropped2022 | 2022 | 待删行 | 有 |",
        "",
      ].join("\n"),
    );
    const patch = join(ws, "patch.json");
    writeFileSync(
      patch,
      JSON.stringify([
        { bibKey: "Wang2023", columns: { 主要结论: "半电池 |ΔG_H|=0.249 eV，双电极 A||B 稳定", 全文: "有" } },
        { bibKey: "Bai2021", columns: { 年份: "2021", 主要结论: "已转义 \\|ΔG_H\\|=0.12 eV 不重复转义", 全文: "有" } },
      ]),
    );
    const up = run(["table", "--file", skim, "--upsert", patch], ws);
    assert.equal(up.status, 0, up.stderr);
    const upOut = JSON.parse(up.stdout);
    assert.deepEqual(upOut.updated, ["Wang2023"]);
    assert.deepEqual(upOut.appended, ["Bai2021"]);

    const textAfterUp = readFileSync(skim, "utf8");
    assert.match(textAfterUp, /\\\|ΔG_H\\\|=0\.249 eV，双电极 A\\\|\\\|B 稳定/);
    assert.doesNotMatch(textAfterUp, /\\\\\|/, "已转义 \\| 不得被双转义成 \\\\|");

    const rm = run(["table", "--file", skim, "--remove", "Dropped2022,MissingKey"], ws);
    assert.equal(rm.status, 0, rm.stderr);
    const rmOut = JSON.parse(rm.stdout);
    assert.deepEqual(rmOut.removed, ["Dropped2022"]);
    assert.deepEqual(rmOut.notFound, ["MissingKey"]);
    assert.doesNotMatch(readFileSync(skim, "utf8"), /@Dropped2022/);

    const got = run(["table", "--file", skim, "--get", "Wang2023,Bai2021"], ws);
    assert.equal(got.status, 0, got.stderr);
    const gotOut = JSON.parse(got.stdout);
    assert.equal(gotOut.rows.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validate：查 BibTeX 缺逗号/宽表排除残留/handoff&angles 键闭环，且忽略 WB₂@WS₂ 化学负载写法", () => {
  const { root, ws, proj } = fixture();
  try {
    mkdirSync(join(ws, "notes"), { recursive: true });
    // included: W1 (Wang2023), W2 (Bai2021); excluded: W4 (Dropped2022)
    const incPath = join(ws, "papers/included.json");
    const rows = JSON.parse(readFileSync(incPath, "utf8")).filter(
      (x: { id: string }) => x.id === "W1" || x.id === "W2",
    );
    rows.find((x: { id: string }) => x.id === "W1").bibKey = "Wang2023";
    rows.find((x: { id: string }) => x.id === "W2").bibKey = "Bai2021";
    rows.push({
      id: "W4",
      bibKey: "Dropped2022",
      title: "Excluded Boride Paper",
      authors: ["Dropped, Alice"],
      year: 2022,
      doi: "10.1000/dropped.2022",
      decision: "excluded",
      reason: "不在范围",
    });
    writeFileSync(incPath, JSON.stringify(rows, null, 2));
    writeFileSync(
      join(ws, "notes/index.json"),
      JSON.stringify([
        { id: "W1", bibKey: "Wang2023", fulltextStatus: "abstract-only", reviewStatus: "pending", skimmed: true, notePath: "" },
        { id: "W2", bibKey: "Bai2021", fulltextStatus: "abstract-only", reviewStatus: "pending", skimmed: true, notePath: "" },
      ]),
    );
    writeFileSync(
      join(ws, "notes/skim.md"),
      [
        "| 键 | 年份 | 结论 |",
        "|---|---|---|",
        "| @Wang2023 | 2023 | ok |",
        "| @Bai2021 | 2021 | ok |",
        "| @Dropped2022 | 2022 | stale |",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(ws, "references.bib"),
      [
        "@article{Wang2023,",
        "  title = {W1},",
        "  articletype = {Journal Article}",
        "  year = {2023},",
        "  doi = {10.1038/s41560-023-01234-5},",
        "}",
        "",
        "@article{Bai2021,",
        "  title = {W2},",
        "  year = {2021},",
        "  doi = {10.1038/s41699-021-00259-4},",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(ws, "notes/handoff.md"),
      "## 写作约束\n- 催化剂 WB₂@WS₂ 与 CoB@NC 及 Ni(OH)₂@C 性能见 [@Wang2023; @Bai2021]（示例 `@bibKey` 忽略）。\n- 误留排除篇 @Dropped2022 和错键 @Ghost2099。\n",
    );
    const bad = run(["validate", "--root", proj, "--json-out"], ws);
    assert.equal(bad.status, 1, "存在多处错误应返回退出码 1");
    const badOut = JSON.parse(bad.stdout);
    const joined = badOut.errors.join("\n");
    assert.match(joined, /articletype.*缺少逗号/, "应检出 BibTeX 字段缺逗号");
    assert.match(joined, /skim\.md.*残留.*dropped2022/i, "应检出宽表残留已排除篇");
    assert.match(joined, /handoff\.md.*已排除键.*@Dropped2022/, "应检出 handoff 引用已排除键");
    assert.match(joined, /handoff\.md.*找不到的引用键.*@Ghost2099/, "应检出 handoff 未知键");
    assert.doesNotMatch(joined, /WS₂|NC|Ni\(OH\)|bibKey/, "不得把 WB₂@WS₂ / CoB@NC / 行内代码误判为引用键");

    // 修复全部错误后再验一次，应通过且仍包含 WB₂@WS₂ 化学式
    writeFileSync(
      join(ws, "notes/skim.md"),
      "| 键 | 年份 | 结论 |\n|---|---|---|\n| @Wang2023 | 2023 | ok |\n| @Bai2021 | 2021 | ok |\n",
    );
    writeFileSync(
      join(ws, "references.bib"),
      [
        "@article{Wang2023,",
        "  title = {W1},",
        "  articletype = {Journal Article},",
        "  year = {2023},",
        "  doi = {10.1038/s41560-023-01234-5},",
        "}",
        "",
        "@article{Bai2021,",
        "  title = {W2},",
        "  year = {2021},",
        "  doi = {10.1038/s41699-021-00259-4},",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(ws, "notes/handoff.md"),
      "## 写作约束\n- 催化剂 WB₂@WS₂ 与 CoB@NC 及 Ni(OH)₂@C 性能见 [@Wang2023; @Bai2021]，联系 test@uni.edu。\n",
    );
    const ok = run(["validate", "--root", proj, "--json-out"], ws);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.equal(JSON.parse(ok.stdout).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("table + validate：支持 extraction.md 的「来源 [@键]」非首列键、同篇多行与反引号包裹 `@Key`", () => {
  const { root, ws, proj } = fixture();
  try {
    mkdirSync(join(ws, "notes"), { recursive: true });
    const incPath = join(ws, "papers/included.json");
    const rows = JSON.parse(readFileSync(incPath, "utf8")).filter(
      (x: { id: string }) => x.id === "W1" || x.id === "W2",
    );
    rows.find((x: { id: string }) => x.id === "W1").bibKey = "Wang2023";
    rows.find((x: { id: string }) => x.id === "W2").bibKey = "Bai2021";
    rows.push({
      id: "W4",
      bibKey: "Dropped2022",
      title: "Excluded Paper",
      authors: ["Dropped, Alice"],
      year: 2022,
      doi: "10.1000/dropped.2022",
      decision: "excluded",
      reason: "不在范围",
    });
    writeFileSync(incPath, JSON.stringify(rows, null, 2));
    writeFileSync(
      join(ws, "notes/index.json"),
      JSON.stringify([
        { id: "W1", bibKey: "Wang2023", fulltextStatus: "fulltext", reviewStatus: "pending", skimmed: true, notePath: "" },
        { id: "W2", bibKey: "Bai2021", fulltextStatus: "fulltext", reviewStatus: "pending", skimmed: true, notePath: "" },
      ]),
    );
    writeFileSync(
      join(ws, "notes/skim.md"),
      "| 键 | 年份 | 结论 |\n|---|---|---|\n| @Wang2023 | 2023 | ok |\n| @Bai2021 | 2021 | ok |\n",
    );
    const ext = join(ws, "notes/extraction.md");
    writeFileSync(
      ext,
      [
        "| 材料／组成 | 测试条件 | 指标 | 来源 [@键] | 页码／图表 |",
        "|---|---|---|---|---|",
        "| Co/FeMoB | HER 1 M KOH | η100=54 mV | [@Wang2023] | p.4 |",
        "| Co/FeMoB | OER 1 M KOH | η100=257 mV | [@Wang2023] | p.5 |",
        "| OldMat | HER | — | [@Dropped2022] | p.1 |",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(ws, "references.bib"),
      "@article{Wang2023,\n  title = {W1},\n  year = {2023},\n  doi = {10.1038/s41560-023-01234-5},\n}\n\n@article{Bai2021,\n  title = {W2},\n  year = {2021},\n  doi = {10.1038/s41699-021-00259-4},\n}\n",
    );
    writeFileSync(
      join(ws, "notes/handoff.md"),
      "## 写作约束\n- 化学式 `PtCu_AC@Cu-Mo₄/₃B₂T_z` 与 `NiCoFeB@NiNC` 忽略，但反引号里的 `@Dropped2022` 必须被检出。\n",
    );

    // 1. validate 应检出 extraction.md（非首列）里的 Dropped2022 以及 handoff.md 反引号里的 `@Dropped2022`
    const v1 = run(["validate", "--root", proj, "--json-out"], ws);
    assert.equal(v1.status, 1);
    const errs = JSON.parse(v1.stdout).errors.join("\n");
    assert.match(errs, /extraction\.md.*残留.*dropped2022/i);
    assert.match(errs, /handoff\.md.*已排除键.*@Dropped2022/);
    assert.doesNotMatch(errs, /Cu-Mo|NiNC/);

    // 2. table --get 应按「来源 [@键]」返回 Wang2023 的全部 2 行
    const g = run(["table", "--file", ext, "--get", "Wang2023"], ws);
    assert.equal(g.status, 0, g.stderr);
    const gOut = JSON.parse(g.stdout);
    assert.equal(gOut.keyColumn, "来源 [@键]");
    assert.equal(gOut.rows.length, 2, "同篇 HER/OER 两行应全部返回");

    // 3. table --upsert 支持 match 精准改多行中的某一行 + 追加新行把 [@Bai2021] 放进「来源 [@键]」列而非第 0 列
    const patch = join(ws, "ext-patch.json");
    writeFileSync(
      patch,
      JSON.stringify([
        { bibKey: "Wang2023", match: { 测试条件: "OER" }, columns: { 指标: "η100=250 mV (核实)" } },
        { bibKey: "Bai2021", columns: { "材料／组成": "PtCu_AC@Cu-Mo4/3B2Tz", 测试条件: "HER 1 M KOH", 指标: "1.34 |e|", "页码／图表": "p.9" } },
      ]),
    );
    const up = run(["table", "--file", ext, "--upsert", patch], ws);
    assert.equal(up.status, 0, up.stderr);
    const extText = readFileSync(ext, "utf8");
    assert.match(extText, /\| Co\/FeMoB \| OER 1 M KOH \| η100=250 mV \(核实\) \| \[@Wang2023\] \| p\.5 \|/);
    assert.match(extText, /\| PtCu_AC@Cu-Mo4\/3B2Tz \| HER 1 M KOH \| 1\.34 \\\|e\\\| \| \[@Bai2021\] \| p\.9 \|/);

    // 4. table --remove 移出 extraction.md 里的 Dropped2022，再跑 validate 通过
    const rm = run(["table", "--file", ext, "--remove", "Dropped2022"], ws);
    assert.equal(rm.status, 0, rm.stderr);
    assert.deepEqual(JSON.parse(rm.stdout).removed, ["Dropped2022"]);
    writeFileSync(
      join(ws, "notes/handoff.md"),
      "## 写作约束\n- 化学式 `PtCu_AC@Cu-Mo₄/₃B₂T_z` 与 `NiCoFeB@NiNC` 对应 `@Wang2023` 与 `@Bai2021`。\n",
    );
    const v2 = run(["validate", "--root", proj, "--json-out"], ws);
    assert.equal(v2.status, 0, v2.stdout + v2.stderr);
    assert.equal(JSON.parse(v2.stdout).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("outline-check：复算覆盖检查并拆分研究/综述卡、严避化学式 A@B 误报、拦截缺全文补读与排除键", () => {
  const { root, ws } = fixture();
  try {
    mkdirSync(join(ws, "notes"), { recursive: true });
    writeFileSync(
      join(ws, "papers/included.json"),
      JSON.stringify([
        { id: "R1", bibKey: "Rev2025", kind: "review", decision: "included", year: 2025 },
        { id: "P1", bibKey: "Wang2023", kind: "research", decision: "included", year: 2023 },
        { id: "P2", bibKey: "Skim2024", kind: "research", decision: "included", year: 2024 },
        { id: "P3", bibKey: "NoPdf2022", kind: "research", decision: "included", year: 2022 },
        { id: "X1", bibKey: "Drop2021", kind: "research", decision: "excluded", year: 2021 },
      ]),
    );
    writeFileSync(
      join(ws, "notes/index.json"),
      JSON.stringify([
        { id: "R1", bibKey: "Rev2025", reviewStatus: "reviewed", fulltextStatus: "fulltext", notePath: "notes/01.md" },
        { id: "P1", bibKey: "Wang2023", reviewStatus: "reviewed", fulltextStatus: "fulltext", notePath: "notes/02.md" },
        { id: "P2", bibKey: "Skim2024", reviewStatus: "pending", skimmed: true, fulltextStatus: "fulltext", notePath: "" },
        { id: "P3", bibKey: "NoPdf2022", reviewStatus: "pending", skimmed: true, fulltextStatus: "abstract-only", notePath: "" },
        { id: "X1", bibKey: "Drop2021", reviewStatus: "reviewed", fulltextStatus: "fulltext", notePath: "notes/x.md" },
      ]),
    );
    writeFileSync(
      join(ws, "references.bib"),
      [
        "@article{Rev2025, year = {2025}}",
        "@article{Wang2023, year = {2023}}",
        "@article{Skim2024, year = {2024}}",
        "@article{NoPdf2022, year = {2022}}",
      ].join("\n"),
    );

    // 1. 干净通过态：含大量化学负载写法 WB₂@WS₂ / Co-B@CoO / NiCoFeB@NiNC / PtCu_AC@Cu-Mo₄/₃B₂T_z
    writeFileSync(
      join(ws, "outline.md"),
      [
        "# 综述大纲",
        "",
        "## 1. 引言与非晶硼化物",
        "- 要点：对比 WB₂@WS₂、Co-B@CoO、NiCoFeB@NiNC、Ru₂B₃@BNC、etched-NiPB@MS 与 `PtCu_AC@Cu-Mo₄/₃B₂T_z`。",
        "- **拟引用（可写）**：[@Rev2025] [@Wang2023]",
        "- **拟引用（线索）**：[@Skim2024] [@NoPdf2022]",
        "",
        "## 覆盖检查",
        "| 节 | 可写正文篇数 | 仅线索篇数 | 最新一篇年份 | 判断 | 建议 |",
        "|---|---:|---:|---:|---|---|",
        "| 1. 引言与非晶硼化物 | 2 | 2 | 2025 | 薄（一手研究仅 1 篇） | 补读：[@Skim2024] |",
        "",
      ].join("\n"),
    );
    const ok = run(["outline-check", "--outline", "outline.md", "--json-out"], ws);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    const okJson = JSON.parse(ok.stdout);
    assert.equal(okJson.ok, true);
    assert.equal(okJson.coverage[0].computed.writable, 2);
    assert.equal(okJson.coverage[0].computed.writableResearch, 1);
    assert.equal(okJson.coverage[0].computed.writableReview, 1);
    assert.equal(okJson.coverage[0].computed.hint, 2);
    assert.equal(okJson.coverage[0].computed.latest, 2025);

    // 2. 报错态：覆盖篇数错 + 补读缺全文 NoPdf2022 + 误引排除键 Drop2021 + 把仅速读塞进可写
    writeFileSync(
      join(ws, "outline.md"),
      [
        "# 综述大纲",
        "## 1. 引言",
        "- 拟引用（可写）：[@Rev2025] [@Skim2024] [@Drop2021]",
        "- 拟引用（线索）：[@NoPdf2022]",
        "## 覆盖检查",
        "| 节 | 可写正文篇数 | 仅线索篇数 | 最新一篇年份 | 判断 | 建议 |",
        "|---|---:|---:|---:|---|---|",
        "| 1. 引言 | 9 | 1 | 2025 | 薄 | 补读：[@NoPdf2022] |",
      ].join("\n"),
    );
    const bad = run(["outline-check", "--outline", "outline.md", "--json-out"], ws);
    assert.equal(bad.status, 1);
    const badErrs = JSON.parse(bad.stdout).errors.join("\n");
    assert.match(badErrs, /已排除文献.*@Drop2021/);
    assert.match(badErrs, /@Skim2024.*非全文精读/);
    assert.match(badErrs, /篇数对不上/);
    assert.match(badErrs, /@NoPdf2022.*缺少全文 PDF/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("table 多键空格参数 + index-update 批量更新 + Symbol 字体 μ→m 单位告警", () => {
  const { root, ws } = fixture();
  try {
    mkdirSync(join(ws, "notes"), { recursive: true });
    // 1. table --get / --remove 均支持空格分隔多键（不再报 unrecognized arguments）
    const skim = join(ws, "notes/skim.md");
    writeFileSync(
      skim,
      [
        "| 键 | 年份 | 结论 |",
        "|---|---|---|",
        "| @Du2025 | 2025 | A |",
        "| @Zhao2025 | 2025 | B |",
        "| @Lu2024 | 2024 | C |",
        "",
      ].join("\n"),
    );
    const g = run(["table", "--file", skim, "--get", "Du2025", "Zhao2025"], ws);
    assert.equal(g.status, 0, g.stderr);
    assert.equal(JSON.parse(g.stdout).rows.length, 2);

    const rm = run(["table", "--file", skim, "--remove", "Du2025", "Zhao2025"], ws);
    assert.equal(rm.status, 0, rm.stderr);
    assert.deepEqual(JSON.parse(rm.stdout).removed, ["Du2025", "Zhao2025"]);
    assert.match(readFileSync(skim, "utf8"), /@Lu2024/);
    assert.doesNotMatch(readFileSync(skim, "utf8"), /@Du2025|@Zhao2025/);

    // 2. index-update 批量更新 reviewStatus / notePath / forSections 并自动清 skimmed
    const idxPath = join(ws, "notes/index.json");
    writeFileSync(
      idxPath,
      JSON.stringify([
        { id: "W1", bibKey: "Du2025", reviewStatus: "pending", skimmed: true, fulltextStatus: "fulltext", notePath: "" },
        { id: "W2", bibKey: "Saad2021", reviewStatus: "pending", skimmed: true, fulltextStatus: "fulltext", notePath: "", forSections: ["2"] },
      ]),
    );
    const patchPath = join(ws, "idx-patch.json");
    writeFileSync(
      patchPath,
      JSON.stringify([
        { bibKey: "Du2025", reviewStatus: "reviewed", notePath: "notes/17-Du2025.md", forSections: ["2"] },
        { bibKey: "Saad2021", reviewStatus: "reviewed", notePath: "notes/24-Saad2021.md", forSections: ["3"] },
        { bibKey: "Missing2099", reviewStatus: "reviewed" },
      ]),
    );
    const upd = run(["index-update", "--index", idxPath, "--patch", patchPath], ws);
    assert.equal(upd.status, 0, upd.stderr);
    const updOut = JSON.parse(upd.stdout);
    assert.deepEqual(updOut.updated, ["Du2025", "Saad2021"]);
    assert.deepEqual(updOut.notFound, ["Missing2099"]);
    const updatedIdx = JSON.parse(readFileSync(idxPath, "utf8"));
    assert.equal(updatedIdx[0].reviewStatus, "reviewed");
    assert.equal("skimmed" in updatedIdx[0], false, "reviewed 后应自动移除 skimmed");
    assert.deepEqual(updatedIdx[1].forSections, ["2", "3"], "默认合并已有 forSections 并去重");

    // 3. _detect_symbol_unit_pages 精准检出 RSC/Elsevier Symbol 字体 μ→m 污染页
    const symCode = `
import sys
sys.path.insert(0, sys.argv[1])
import lit_records as m
class FakePage:
    def __init__(self, d, raw=""):
        self._d, self._raw = d, raw
    def get_text(self, mode=None):
        return self._d if mode == "dict" else self._raw
doc = [
    FakePage({"blocks": [{"type": 0, "lines": [{"spans": [{"font": "TimesNewRoman", "text": "Normal 10 mg L-1"}]}]}]}),
    FakePage({"blocks": [{"type": 0, "lines": [{"spans": [
        {"font": "AdvOTce3d9a73", "text": "B leaching is 425.7 "},
        {"font": "SymbolMT", "text": "m"},
        {"font": "AdvOTce3d9a73", "text": "g L-1 after 100 h"},
    ]}]}]}),
]
print(",".join(map(str, m._detect_symbol_unit_pages(doc, 2))))
`;
    const sr = spawnSync(python, ["-c", symCode, resolve("src-tauri/resources/skills/lit-search/scripts")], { encoding: "utf8" });
    assert.equal(sr.status, 0, sr.stderr);
    assert.equal(sr.stdout.trim(), "2", "应只标出第 2 页 Symbol 字体 μ→m 污染，不误报第 1 页正常 mg L-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("table --to-csv 与 outline-check 扩展五项红线（拼图去重禁综述/证据表覆盖/C1..Cn 闭集/sections.json/禁彩色 emoji）", () => {
  const { root, ws } = fixture();
  try {
    mkdirSync(join(ws, "notes"), { recursive: true });
    mkdirSync(join(ws, "manuscript"), { recursive: true });
    // 1. table --to-csv 确定性导出且还原转义竖线
    const extMd = join(ws, "notes/extraction.md");
    const extCsv = join(ws, "notes/extraction.csv");
    writeFileSync(
      extMd,
      [
        "| 材料 | 条件 | 来源 [@键] |",
        "|---|---|---|",
        "| WB₂@WS₂ | 1 M KOH \\| 10 mA cm⁻² | @Wang2023 |",
        "| Co₂B | 1 M KOH | @Bai2021 |",
        "",
      ].join("\n"),
    );
    const csvRes = run(["table", "--file", extMd, "--to-csv", extCsv], ws);
    assert.equal(csvRes.status, 0, csvRes.stderr);
    assert.equal(JSON.parse(csvRes.stdout).totalRows, 2);
    const csvText = readFileSync(extCsv, "utf8");
    assert.match(csvText, /1 M KOH \| 10 mA cm⁻²/, "导出 CSV 应还原转义的竖线");

    // 2. outline-check 五项红线检出
    writeFileSync(
      join(ws, "papers/included.json"),
      JSON.stringify([
        { id: "W1", bibKey: "Wang2023", title: "Study 1", year: 2023, decision: "included" },
        { id: "W2", bibKey: "Bai2021", title: "Study 2", year: 2021, decision: "included" },
        { id: "R1", bibKey: "Rev2024", title: "Review 1", year: 2024, kind: "review", decision: "included" },
      ]),
    );
    writeFileSync(
      join(ws, "notes/index.json"),
      JSON.stringify([
        { id: "W1", bibKey: "Wang2023", reviewStatus: "reviewed", fulltextStatus: "fulltext", notePath: "notes/01.md" },
        { id: "W2", bibKey: "Bai2021", reviewStatus: "reviewed", fulltextStatus: "fulltext", notePath: "notes/02.md" },
        { id: "R1", bibKey: "Rev2024", kind: "review", reviewStatus: "reviewed", fulltextStatus: "fulltext", notePath: "notes/03.md" },
      ]),
    );
    writeFileSync(
      join(ws, "references.bib"),
      [
        "@article{Wang2023, title={S1}, year={2023}}",
        "@article{Bai2021, title={S2}, year={2021}}",
        "@article{Rev2024, title={R1}, year={2024}}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(ws, "manuscript/sections.json"),
      JSON.stringify([{ id: "S1", title: "主体一" }, { id: "S2", title: "多出一节" }]),
    );
    writeFileSync(
      join(ws, "outline.md"),
      [
        "# 综述大纲",
        "",
        "## 覆盖检查",
        "| 节 | 可写正文篇数 | 仅线索篇数 | 最新一篇年份 | 判断 | 建议 |",
        "|---|---|---|---|---|---|",
        "| 1. 引言 | 1 | 0 | 2024 | 够 | |",
        "| 2. 机理 | 2 | 0 | 2023 | 够 | |",
        "| 3. 结论 | 1 | 0 | 2023 | 够 | |",
        "",
        "## 1. 引言",
        "- 拟引用（可写）：[@Rev2024]",
        "",
        "## 2. 机理",
        "### 2.1 界面演化",
        "- 拟引用（可写）：[@Wang2023] [@Bai2021]",
        "- 用图：拼 图1（论点）= (a) [@Wang2023] Fig.2c + (b) [@Rev2024] Fig.1a",
        "- 用图：拼 图2（重复且单篇）= (a) [@Wang2023] Fig.2c",
        "- 注意：这里误放了彩色 emoji ✅",
        "",
        "## 3. 结论",
        "- 拟引用（可写）：[@Wang2023]",
        "",
        "## 证据综合表",
        "| 键 | 论断 | 结论 |",
        "|---|---|---|",
        "| @Wang2023 | 支持 C1、C2 | 有效 |",
        "",
        "- **C1**：仅定义了 C1",
        "",
      ].join("\n"),
    );
    const bad = run(["outline-check", "--outline", "outline.md", "--json-out"], ws);
    assert.equal(bad.status, 1, "违背五项红线应返回退出码 1");
    const badJson = JSON.parse(bad.stdout);
    const errText = badJson.errors.join("\n");
    assert.match(errText, /同一块子图进了两张拼图.*@Wang2023.*2c/, "应检出跨拼图重复子图");
    assert.match(errText, /拼图 1 混入了综述图.*@Rev2024/, "应检出拼图混入综述");
    assert.match(errText, /拼图 2 仅来自 1 篇研究论文/, "应检出拼图研究论文不足 2 篇");
    assert.match(errText, /证据综合表遗漏.*@Bai2021/, "应检出证据综合表遗漏可写一手研究");
    assert.match(errText, /未定义的论断编号.*C2/, "应检出未定义论断 C2");
    assert.match(errText, /sections\.json 定义了 2 节.*1 章/, "应检出 sections.json 章数不一致");
    assert.match(errText, /彩色 emoji/, "应检出彩色 emoji");

    // 3. 全部修复后（含保留单色 ⚠︎ 与科研符号）应 0 错 0 警通过
    writeFileSync(join(ws, "manuscript/sections.json"), JSON.stringify([{ id: "S1", title: "机理" }]));
    writeFileSync(
      join(ws, "outline.md"),
      [
        "# 综述大纲",
        "",
        "## 覆盖检查",
        "| 节 | 可写正文篇数 | 仅线索篇数 | 最新一篇年份 | 判断 | 建议 |",
        "|---|---|---|---|---|---|",
        "| 1. 引言 | 1 | 0 | 2024 | 够 | |",
        "| 2. 机理 | 2 | 0 | 2023 | 够 | |",
        "| 3. 结论 | 1 | 0 | 2023 | 够 | |",
        "",
        "## 1. 引言",
        "- 拟引用（可写）：[@Rev2024]",
        "",
        "## 2. 机理",
        "### 2.1 界面演化",
        "- 拟引用（可写）：[@Wang2023] [@Bai2021]",
        "- 用图：拼 图1（论点）= (a) [@Wang2023] Fig.2c + (b) [@Bai2021] Fig.4a",
        "- ⚠︎ 注意：单色警示与 ✓、°、μ、WB₂@WS₂ 均合法",
        "",
        "## 3. 结论",
        "- 拟引用（可写）：[@Wang2023]",
        "",
        "## 证据综合表",
        "| 键 | 论断 | 结论 |",
        "|---|---|---|",
        "| @Wang2023 | 支持 C1 | 有效 |",
        "| @Bai2021 | 支持 C2 | 有效 |",
        "| @Rev2024 | 综述脉络 | 综述 |",
        "",
        "- **C1**：论断一",
        "- **C2**：论断二",
        "",
      ].join("\n"),
    );
    const good = run(["outline-check", "--outline", "outline.md", "--json-out"], ws);
    assert.equal(good.status, 0, good.stdout + good.stderr);
    const goodJson = JSON.parse(good.stdout);
    assert.equal(goodJson.ok, true);
    assert.deepEqual(goodJson.errors, []);
    assert.deepEqual(goodJson.warnings, []);
    assert.equal(goodJson.composites, 1);
    assert.equal(goodJson.evidenceKeys, 3);
    assert.deepEqual(goodJson.sections, { count: 1, outlineBodyChapters: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
