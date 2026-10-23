import assert from "node:assert/strict";
import test from "node:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { displayCitationTitle } from "../src/screening-review.ts";

// 2026-10-23 HER 导出核查：导进 EndNote / Zotero 的题录与 Mesa 界面上的写法要一致。
// 化学式按「整词能拆成元素 + 计量」认（bridge.py _subscript_formulas 与 screening-review.ts 同口径）。

const python = process.platform === "win32" ? "python" : "python3";
const scripts = resolve("src-tauri/resources/skills");
const bridgeSrc = join(scripts, "endnote-bridge/scripts/bridge.py");

/** 题名 → 期望写法。两端（导出 bridge.clean、界面 displayCitationTitle）都要等于它。 */
const TITLES: [string, string][] = [
  ["Single atom Ru doping 2H-MoS2 as catalyst", "Single atom Ru doping 2H-MoS₂ as catalyst"],
  ["TiO2 nanorods", "TiO₂ nanorods"],
  ["MoS2/CoSe2 heterostructure", "MoS₂/CoSe₂ heterostructure"],
  ["NiFe2O4", "NiFe₂O₄"],
  ["LiNi0.8Co0.1Mn0.1O2 cathode", "LiNi₀.₈Co₀.₁Mn₀.₁O₂ cathode"],
  ["Ni(OH)2 nanosheets", "Ni(OH)₂ nanosheets"],
  ["MgCl2 with Mg2+ ions", "MgCl₂ with Mg²⁺ ions"],
  ["Mg2Cl3+ cation", "Mg₂Cl₃⁺ cation"],
  ["Co3O4-x", "Co₃O₄₋ₓ"],
  ["MoSx and NiOx", "MoSₓ and NiOₓ"],
  ["MgxMo3S4", "MgₓMo₃S₄"],
  ["g-C3N4", "g-C₃N₄"],
  ["Zr1-xTMxB2", "Zr₁₋ₓTMₓB₂"],
  ["Ca2+ Mg(CF 3 SO 3 ) 2 - MgCl 2", "Ca²⁺ Mg(CF₃SO₃)₂ - MgCl₂"],
  ["Co2 B nanosheets", "Co₂B nanosheets"],
  // 吃空格的老毛病：Ti3C2Tx 和后面的 MXene 不能粘在一起
  ["Ti3C2Tx MXene", "Ti₃C₂Tₓ MXene"],
  ["Quantum dot-doped CeO <sub> <i>x</i> </sub> –NiB with", "Quantum dot-doped CeOₓ–NiB with"],
  // 不是式子的不动：图表编号、计算方法名、普通词、毒株、颗粒物、年份、标题里首字母大写的 As
  ["Figure S2 and Table S1", "Figure S2 and Table S1"],
  ["B3LYP functional", "B3LYP functional"],
  ["Lux and Fox", "Lux and Fox"],
  ["H1N1 virus", "H1N1 virus"],
  ["PM2.5", "PM2.5"],
  ["In 2020, we", "In 2020, we"],
  ["MoS2 As Catalyst", "MoS₂ As Catalyst"],
  ["COVID-19 and SARS-CoV-2", "COVID-19 and SARS-CoV-2"],
  ["A549 cells", "A549 cells"],
];

function pythonClean(inputs: string[]): string[] {
  const code = [
    "import json, sys, importlib.util",
    "spec = importlib.util.spec_from_file_location('b', sys.argv[1])",
    "b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)",
    "sys.stdin.reconfigure(encoding='utf-8'); sys.stdout.reconfigure(encoding='utf-8')",
    "print(json.dumps([b.clean(x) for x in json.loads(sys.stdin.read())], ensure_ascii=False))",
  ].join("\n");
  const r = spawnSync(python, ["-c", code, bridgeSrc], { input: JSON.stringify(inputs), encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("化学式：导出（bridge.clean）与界面（displayCitationTitle）同一写法", () => {
  const py = pythonClean(TITLES.map(([raw]) => raw));
  TITLES.forEach(([raw, want], i) => {
    assert.equal(py[i], want, `导出：${raw}`);
    assert.equal(displayCitationTitle(raw), want, `界面：${raw}`);
  });
});

/** 照 Mesa 同步时的摆法：bridge.py 和期刊缩写表放在同一个临时目录里跑 */
function syncDir(withZotero = false): string {
  const dir = mkdtempSync(join(tmpdir(), "mesa-cite-format-"));
  copyFileSync(bridgeSrc, join(dir, "bridge.py"));
  copyFileSync(resolve("src-tauri/resources/journal-abbreviations.csv"), join(dir, "journal-abbreviations.csv"));
  // LTWA 摘录（真表 2021-07-02 版里原样摘的条目），测试不联网下载
  copyFileSync(resolve("tests/fixtures/ltwa-mini.csv"), join(dir, "ltwa.csv"));
  if (withZotero) {
    copyFileSync(join(scripts, "endnote-bridge/scripts/library_match.py"), join(dir, "library_match.py"));
    copyFileSync(join(scripts, "zotero-sync/scripts/zotero_rtf.py"), join(dir, "zotero_rtf.py"));
  }
  return dir;
}

// 引文库里带上缩写，导出时不用联网查 JabRef 表
const BIB =
  "@article{Wang2021,\n title={【12】Single atom Ru doping 2H-MoS2},\n author={Wang, Jing}, year={2021},\n" +
  " journal={Applied Catalysis B: Environmental}, journalabbreviation={Appl. Catal., B}, volume={298}, pages={120490}\n}\n" +
  "@article{Xu2017,\n title={19~.Cobalt nickel boride},\n author={Xu, Ning}, year={2017},\n" +
  " journal={Journal of Materials Chemistry A}, journalabbreviation={J. Mater. Chem.A}, volume={5}\n}\n" +
  "@article{Liang2022,\n title={Two-dimensional titanium carbonitride MXene},\n author={Liang, Kun}, year={2022},\n" +
  " journal={Materials Reports: Energy}, journalabbreviation={Mater. Rep.: Energy}\n}\n";

test("EndNote 份：题名去编号前缀，缩写收拾写法，ACS 与 ISO 4 两种缩写都给（XML 缩写 2、期刊术语表）", () => {
  const dir = syncDir();
  try {
    writeFileSync(join(dir, "references.bib"), BIB);
    const bridge = join(dir, "bridge.py");
    let r = spawnSync(python, [bridge, "--input", join(dir, "references.bib"), "--output", join(dir, "lib.ris"), "--report", join(dir, "r.json"), "--journal-terms", join(dir, "terms.txt")], { encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const ris = readFileSync(join(dir, "lib.ris"), "utf8");
    assert.match(ris, /TI  - Single atom Ru doping 2H-MoS₂\r\n/);
    assert.match(ris, /TI  - Cobalt nickel boride\r\n/);
    assert.match(ris, /J2  - Appl\. Catal\., B\r\n/);
    assert.match(ris, /J2  - J\. Mater\. Chem\. A\r\n/, "Chem.A 补空格");
    assert.match(ris, /J2  - Mater\. Rep\. Energy\r\n/, "ISO 4 不留冒号");
    const terms = readFileSync(join(dir, "terms.txt"), "utf8");
    assert.match(terms, /^Applied Catalysis B: Environmental\tAppl\. Catal\., B\tAppl\. Catal\. B Environ\.\tAppl Catal, B\r\n/m);
    assert.match(terms, /^Journal of Materials Chemistry A\tJ\. Mater\. Chem\. A\tJ\. Mater\. Chem\. A\tJ Mater Chem A\r\n/m, "没有另一种写法时缩写 2 同缩写 1");
    r = spawnSync(python, [bridge, "--input", join(dir, "references.bib"), "--output", join(dir, "lib.xml"), "--report", join(dir, "x.json")], { encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const xml = readFileSync(join(dir, "lib.xml"), "utf8");
    assert.match(xml, /<abbr-1>Appl\. Catal\., B<\/abbr-1><abbr-2>Appl\. Catal\. B Environ\.<\/abbr-2>/);
    assert.match(xml, /<title>Single atom Ru doping 2H-MoS₂<\/title>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Zotero 份：缩写与 EndNote 份同一套，另一种写法进「其他」（M2），题名去编号前缀", () => {
  const dir = syncDir(true);
  try {
    writeFileSync(join(dir, "references.bib"), BIB);
    const env = { ...process.env, ZOTERO_CONFIG_DIR: dir };
    const r = spawnSync(python, [join(dir, "zotero_rtf.py"), "--library-ris", "--bib", join(dir, "references.bib"), "--ris", join(dir, "z.ris")], { encoding: "utf8", timeout: 60_000, env });
    assert.equal(r.status, 0, r.stderr);
    const ris = readFileSync(join(dir, "z.ris"), "utf8");
    assert.match(ris, /TI  - Single atom Ru doping 2H-MoS₂\r\nAU/);
    assert.match(ris, /J2  - Appl\. Catal\., B\r\nM2  - ISO 4 abbreviation: Appl\. Catal\. B Environ\.\r\n/);
    assert.match(ris, /J2  - J\. Mater\. Chem\. A\r\n/);
    assert.match(ris, /TI  - Cobalt nickel boride\r\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("同步前补字段：字段已齐的不联网，缺的才按 DOI 问", () => {
  const code = [
    "import json, sys, importlib.util",
    "spec = importlib.util.spec_from_file_location('b', sys.argv[1])",
    "b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)",
    "asked = []",
    "b.crossref_fill = lambda doi: asked.append(doi) or {'abstract': 'A', 'issn': '1', 'date': '2020', 'journalAbbreviation': 'J.'}",
    "b.openalex_fill = lambda doi: {}",
    "b.iso4_abbreviation = lambda j: ''",
    "b.time.sleep = lambda s: None",
    "full = {'doi': '10.1/full', 'title': 'T', 'abstract': 'x', 'issn': '1', 'date': '2020', 'journalAbbreviation': 'J.'}",
    "thin = {'doi': '10.1/thin', 'title': 'T'}",
    "b.enrich_records([full, thin])",
    "print(json.dumps({'asked': asked, 'thin': thin.get('abstract')}))",
  ].join("\n");
  const r = spawnSync(python, ["-c", code, bridgeSrc], { encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { asked: ["10.1/thin"], thin: "A" });
});

// 2026-10-23 用户拍板「所有刊都做」：每本刊按 LTWA 算 ISO 4，和主缩写不同就作第二种写法
test("ISO 4：按 LTWA 算缩写——单词刊名不缩、冠词介词去掉、分册字母照写、复数按单数查、源词无重音缩写也无重音、括号地名词组优先", () => {
  const dir = syncDir();
  try {
    const code = [
      "import json, sys, importlib.util",
      "spec = importlib.util.spec_from_file_location('b', sys.argv[1])",
      "b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)",
      "sys.stdin.reconfigure(encoding='utf-8'); sys.stdout.reconfigure(encoding='utf-8')",
      "print(json.dumps([b.iso4_compute(x) for x in json.loads(sys.stdin.read())], ensure_ascii=False))",
    ].join("\n");
    const cases: [string, string][] = [
      ["Applied Catalysis B: Environmental", "Appl. Catal. B Environ."],
      ["Journal of the American Chemical Society", "J. Am. Chem. Soc."],
      ["International Journal of Hydrogen Energy", "Int. J. Hydrog. Energy"],
      ["Journal of Materials Chemistry A", "J. Mater. Chem. A"],
      ["Materials Reports: Energy", "Mater. Rep. Energy"],
      ["Advanced Sustainable Systems", "Adv. Sustain. Syst."],
      ["Small", "Small"],
      ["ChemCatChem", "ChemCatChem"],
      ["Journal of Medical Toxicology", "J. Med. Toxicol."],
      ["Toxicology In Vitro", "Toxicol. In Vitro"],
      ["Science (Washington, DC, United States)", "Science (Washington, DC, U. S.)"],
      ["Journal of Materials (Amsterdam, Netherlands)", "J. Mater. (Amsterdam, Neth.)"],
      ["Chemistry - A European Journal", "Chem. European J."],
      ["Clinical Toxicology: an official journal of the American Academy", "Clinical Toxicol."],
    ];
    const r = spawnSync(python, ["-c", code, join(dir, "bridge.py")], { input: JSON.stringify(cases.map(([j]) => j)), encoding: "utf8", timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr);
    const got = JSON.parse(r.stdout);
    cases.forEach(([journal, want], i) => assert.equal(got[i], want, journal));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
