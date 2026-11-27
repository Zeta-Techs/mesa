import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const python = process.platform === "win32" ? "python" : "python3";
// 脚本里有联网补全（ISO 4 缩写表 LTWA、JabRef 缩写表、Crossref）：测试一律不联网（2026-10-26 CI 起四个用例卡满 20 秒被杀）
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) process.env[k] = "http://127.0.0.1:9";
// 只断网还不够：联网失败会按次退避重试（每个地址几秒），本机又有 30 天缓存——CI 上卡满超时、本机却全过。
// MESA_LIT_OFFLINE 让脚本不联网也不读缓存、当场按连不上处理，两边结果一致
process.env.MESA_LIT_OFFLINE = "1";
const bridge = resolve("src-tauri/resources/skills/endnote-bridge/scripts/bridge.py");
const citeDocx = resolve("src-tauri/resources/skills/endnote-bridge/scripts/cite_docx.py");
const run = (script: string, args: string[]) => spawnSync(python, [script, ...args], { encoding: "utf8", timeout: 20_000 });
// Windows 控制台默认 cp1252，docx 里的中文标题直接 print 会把整个断言打空。
const zipXml = (docx: string, names = ["word/document.xml"]) =>
  spawnSync(
    python,
    // 字节直写 stdout：文本模式 print 在 Windows 会把 \n 翻成 \r\n，fldData 的 \r\n 就成 \r\r\n（2026-10-11 CI 实证）
    ["-c", "import sys, zipfile; z=zipfile.ZipFile(sys.argv[1]);\n[sys.stdout.buffer.write(z.read(n)) for n in sys.argv[2].split(',')]", docx, names.join(",")],
    { encoding: "utf8", timeout: 10_000 },
  );
// EndNote/Zotero 的引文数据在域数据（fldData，base64）里，断言前先解码。
const fldData = (docx: string) =>
  spawnSync(
    python,
    ["-c", "import sys; sys.stdout.reconfigure(encoding='utf-8'); import zipfile,re,base64\nxml=zipfile.ZipFile(sys.argv[1]).read('word/document.xml').decode()\nblob=b''.join(base64.b64decode(''.join(m.split())) for m in re.findall(r'<w:fldData[^>]*>(.*?)</w:fldData>',xml,re.S))\nprint(blob.decode('utf-8','replace'))", docx],
    { encoding: "utf8", timeout: 10_000 },
  );

test("EndNote bridge converts XML/RIS/BibTeX and preserves stable keys without changing original", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-bib-bridge-"));
  try {
    const input = join(root, "source.bib");
    const text = "@article{ExistingKey,\n title={结构 & Evidence}, author={Doe, Jane and Hong, Tongzhou}, year={2026}, journal={Research}, doi={10.1/example}, volume={12}, number={3}, pages={1--8}, url={https://example.test}, isbn={123}\n}\n";
    writeFileSync(input, text);
    const xml = join(root, "export.xml");
    let result = run(bridge, ["--input", input, "--output", xml, "--report", join(root, "first.json")]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(xml,"utf8"), /结构 &amp; Evidence/);
    const back = join(root, "candidate.bib");
    result = run(bridge, ["--input", xml, "--existing", input, "--output", back, "--report", join(root, "second.json")]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(back,"utf8"), /ExistingKey/);
    for (const expected of ["volume = {12}", "pages = {1--8}", "doi = {10.1/example}", "Hong, Tongzhou"]) assert.ok(readFileSync(back,"utf8").includes(expected), expected);
    assert.equal(readFileSync(input,"utf8"), text);
    const ris = join(root, "export.ris");
    result = run(bridge, ["--input", xml, "--output", ris, "--report", join(root, "third.json")]);
    assert.equal(result.status, 0, result.stderr);
    result = run(bridge, ["--input", ris, "--output", join(root, "ris.json"), "--report", join(root, "fourth.json")]);
    assert.equal(result.status, 0, result.stderr);
    const records = JSON.parse(readFileSync(join(root,"ris.json"),"utf8"));
    assert.equal(records[0].id, "ExistingKey");
    assert.deepEqual(records[0].authors, ["Doe, Jane", "Hong, Tongzhou"]);
    assert.equal(records[0].pages, "1--8");
    const risText = readFileSync(ris, "utf8");
    assert.match(risText, /T2  - Research/);
    assert.doesNotMatch(risText, /JO  - /);
    assert.match(risText, /VL  - 12/);
    assert.match(risText, /IS  - 3/);
    assert.match(risText, /SP  - 1\r\nM2  - 1\r\nEP  - 8/);
    assert.match(risText, /SN  - 123/);
    assert.match(risText, /AU  - Doe, Jane\r?\nAU  - Hong, Tongzhou/);
    const before = readFileSync(xml,"utf8");
    result = run(bridge, ["--input", input, "--output", xml, "--report", join(root, "overwrite.json")]);
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(xml,"utf8"), before);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("导入标题里的 HTML 上下标收成两个库都认的记号", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-title-mark-"));
  try {
    const input = join(root, "source.bib");
    writeFileSync(input, "@article{Gao2017,\n title={Reversible S<sup>0</sup>/MgS<sub>x</sub> Chemistry},\n author={Gao, Tao}, year={2017}, journal={Angewandte Chemie}, doi={10.1002/anie.201708241}\n}\n");
    const ris = join(root, "export.ris");
    const result = run(bridge, ["--input", input, "--output", ris, "--report", join(root, "report.json")]);
    assert.equal(result.status, 0, result.stderr);
    const text = readFileSync(ris, "utf8");
    assert.match(text, /TI  - Reversible S⁰\/MgSₓ Chemistry/);
    const alloy = join(root, "alloy.bib");
    writeFileSync(alloy, "@article{Alloy,\n title={Fe50-xMn30Cr10Co10Bx and Y(TM1TM2)B4 and Mo 2 B},\n author={Gao, Tao}, year={2024}, journal={Test}, doi={10.1000/alloy}\n}\n");
    const alloyRis = join(root, "alloy.ris");
    const alloyResult = run(bridge, ["--input", alloy, "--output", alloyRis, "--report", join(root, "alloy-report.json")]);
    assert.equal(alloyResult.status, 0, alloyResult.stderr);
    const alloyText = readFileSync(alloyRis, "utf8");
    assert.match(alloyText, /TI  - Fe₅₀₋ₓMn₃₀Cr₁₀Co₁₀Bₓ and Y\(TM₁TM₂\)B₄ and Mo₂B/);
    assert.doesNotMatch(text, /<sup>|<sub>/);
    writeFileSync(input, "@article{Yang2019,\n title={Ca2+ Mg(CF 3 SO 3 ) 2 - MgCl 2},\n author={Yang, Ann}, year={2019}, journal={Research}, doi={10.1/space}\n}\n");
    const spaced = join(root, "spaced.ris");
    const again = run(bridge, ["--input", input, "--output", spaced, "--report", join(root, "space.json")]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(readFileSync(spaced, "utf8"), /Ca²⁺ Mg\(CF₃SO₃\)₂ - MgCl₂/);
    writeFileSync(input, "@article{Lee2021,\n title={A {Mg} battery},\n author={Lee, Ann and Smith, Jr., John},\n year={2021}, journal={Angew. Chem.},\n doi={https://doi.org/10.1002/example}, pages={1--8}\n}\n");
    const braced = join(root, "braced.ris");
    const third = run(bridge, ["--input", input, "--output", braced, "--report", join(root, "brace.json")]);
    assert.equal(third.status, 0, third.stderr);
    const bracedText = readFileSync(braced, "utf8");
    assert.match(bracedText, /TI  - A Mg battery/);
    assert.match(bracedText, /AU  - Smith, Jr\., John/);
    assert.match(bracedText, /DO  - 10\.1002\/example/);
    assert.doesNotMatch(bracedText, /doi\.org/);
    // DOI 是标识符：化学美化把 D2EE04121A 转成下标后 DOI 匹配全断（2026-10-10 实证），出库必须保持 ASCII
    writeFileSync(input, "@article{Sub,\n title={Plain}, author={Doe, Jane}, year={2026}, journal={J}, doi={10.1039/D₂EE₀₄₁₂₁A}\n}\n");
    const subRis = join(root, "sub.ris");
    const subResult = run(bridge, ["--input", input, "--output", subRis, "--report", join(root, "sub.json")]);
    assert.equal(subResult.status, 0, subResult.stderr);
    assert.match(readFileSync(subRis, "utf8"), /DO  - 10\.1039\/D2EE04121A/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("EndNote 出库：标识符行零化学美化，标签前空格与电荷上标收敛（2026-10-11 实证）", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-endnote-id-"));
  try {
    const input = join(root, "source.bib");
    writeFileSync(
      input,
      "@article{Mg2026,\n" +
        " title={Deep cycling enabled by a robust Mg2+-Conducting interphase with MgCl <sub>2</sub> Solubilization and Mg(CF<sub>3</sub>SO<sub>3</sub>)<sub>2</sub> -Based salts at 500 µA cm −2},\n" +
        " author={Doe, Jane}, year={2026}, journal={J}, doi={10.1016/s0022-0728(99)00146-1},\n" +
        " volume={S1}, number={3a}, pages={A257--A260}, issn={0022-0728}, url={https://doi.org/10.1039/D2EE04121A},\n" +
        " abstract={See 10.1039/D2EE04121A and https://example.com/A257-1 for data}\n" +
        "}\n",
    );
    const ris = join(root, "export.ris");
    const result = run(bridge, ["--input", input, "--output", ris, "--report", join(root, "report.json")]);
    assert.equal(result.status, 0, result.stderr);
    const text = readFileSync(ris, "utf8");
    // 标题：电荷上标允许后跟连字符形容词；<sub> 前的排版空格吃掉；cm −2 收成 cm⁻²
    assert.match(text, /TI  - .*Mg²⁺-Conducting interphase with MgCl₂ Solubilization and Mg\(CF₃SO₃\)₂-Based salts at 500 µA cm⁻²/);
    // 标识符/定位行保持 ASCII：DOI、URL、卷、期、页、ISSN、citation key
    assert.match(text, /DO  - 10\.1016\/s0022-0728\(99\)00146-1/);
    assert.match(text, /UR  - https:\/\/doi\.org\/10\.1039\/D2EE04121A/);
    assert.match(text, /VL  - S1/);
    assert.match(text, /IS  - 3a/);
    assert.match(text, /SP  - A257/);
    assert.match(text, /EP  - A260/);
    assert.match(text, /SN  - 0022-0728/);
    assert.match(text, /ID  - Mg2026/);
    // 摘要里引用的裸 DOI/URL 同样不做化学美化
    assert.match(text, /AB  - See 10\.1039\/D2EE04121A and https:\/\/example\.com\/A257-1 for data/);
    assert.doesNotMatch(text, /₀₀₁₄₆|D₂EE|₂EE|A₂₅₇/);
    // XML 与 .enw 同口径：electronic-resource-num / %R 保持 ASCII，页码不美化
    const xml = join(root, "export.xml");
    assert.equal(run(bridge, ["--input", input, "--output", xml, "--report", join(root, "xml.json")]).status, 0);
    const xmlText = readFileSync(xml, "utf8");
    assert.match(xmlText, /<electronic-resource-num>10\.1016\/s0022-0728\(99\)00146-1</);
    assert.match(xmlText, /<pages start="A257" end="A260">/);
    assert.doesNotMatch(xmlText, /₀₀₁₄₆|D₂EE|₂EE|A₂₅₇/);
    const enw = join(root, "export.enw");
    assert.equal(run(bridge, ["--input", input, "--output", enw, "--report", join(root, "enw.json")]).status, 0);
    const enwText = readFileSync(enw, "utf8");
    assert.match(enwText, /%R 10\.1016\/s0022-0728\(99\)00146-1/);
    assert.match(enwText, /%V S1/);
    assert.match(enwText, /%P A257-A260/);
    assert.doesNotMatch(enwText, /₀₀₁₄₆|D₂EE|₂EE|A₂₅₇/);
    // 2026-10-11 对抗审查二轮：占位符进 <sup> 标签不丢 URL；散文年份不被下标；
    // 复合物电荷不翻转（Mg2Cl3+ 是 Mg₂Cl₃⁺）；存量「字母 空格 下标字」愈合
    writeFileSync(
      input,
      "@article{Adv2026,\n" +
        " title={Study of Mg2Cl3+ and MgCl2 in 2020},\n" +
        " author={Doe, Jane}, year={2026}, journal={J}, doi={10.1000/adv},\n" +
        " abstract={See <sup>https://example.com/a</sup> and In 2020 we showed Mg2Cl3+; old MgCl ₂ data}\n" +
        "}\n",
    );
    const adv = join(root, "adv.ris");
    assert.equal(run(bridge, ["--input", input, "--output", adv, "--report", join(root, "adv.json")]).status, 0);
    const advText = readFileSync(adv, "utf8");
    // 2026-10-23 起整词判定：MgCl2 这类多元素式子也收成下标（原先逐字符认，漏掉）
    assert.match(advText, /TI  - Study of Mg₂Cl₃⁺ and MgCl₂ in 2020/);
    assert.match(advText, /AB  - See https:\/\/example\.com\/a and In 2020 we showed Mg₂Cl₃⁺; old MgCl₂ data/);
    assert.doesNotMatch(advText, /\x00|[-]/);
    assert.doesNotMatch(advText, /In₂₀₂₀|Cl³⁺|₂0|0₂/);
    // 输入侧愈合：被旧版污染的 RIS（页码 A₂₅₇、DOI 下标）读回来折成 ASCII
    const poisoned = join(root, "poisoned.ris");
    writeFileSync(
      poisoned,
      "TY  - JOUR\r\nID  - P1\r\nTI  - Old record\r\nPY  - 2020\r\nSP  - A₂₅₇\r\nEP  - A₂₆₂\r\nDO  - 10.1039/D₂EE₀₄₁₂₁A\r\nER  - \r\n",
    );
    const healed = join(root, "healed.bib");
    assert.equal(run(bridge, ["--input", poisoned, "--output", healed, "--report", join(root, "healed.json")]).status, 0);
    const healedText = readFileSync(healed, "utf8");
    assert.match(healedText, /pages = \{A257--A262\}/);
    assert.match(healedText, /doi = \{10\.1039\/D2EE04121A\}/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("域稿正文：约义~不与下标记号错配、\\@ 转义还原、同年同姓消歧（2026-10-11 定稿审计实证）", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-body-marks-"));
  try {
    const md = join(root, "review-final.md");
    const bib = join(root, "references.bib");
    writeFileSync(
      md,
      "The routes hold ~79–81% efficiencies (Mg~3~Bi~2~, 170 mV) and a two-step a-MgCl~2~\\@polymer layer (~2 µm) drops overpotential from ~2.1 V to 0.25 V, failing after ~80 and ~50 cycles [@zhangS2026; @zhangX2026].",
    );
    writeFileSync(
      bib,
      "@article{zhangS2026,\n title={Mitigating}, author={Zhang, Shuxin and Ren, Ruotong}, year={2026}, journal={J}, doi={10.1/s}\n}\n" +
        "@article{zhangX2026,\n title={Interphase}, author={Zhang, Xinyuan and Xu, Hengyue}, year={2026}, journal={J}, doi={10.1/x}\n}\n" +
        "@article{sameA2026,\n title={First}, author={Chen, Li and Park, Min}, year={2025}, journal={J}, doi={10.1/a}\n}\n" +
        "@article{sameB2026,\n title={Second}, author={Chen, Li and Park, Min}, year={2025}, journal={J}, doi={10.1/b}\n}\n",
    );
    writeFileSync(join(root, "full.md"), "Same author twice [@sameA2026; @sameB2026].\n");
    const out = join(root, "endnote.docx");
    const result = run(citeDocx, ["--input", md, "--bib", bib, "--output", out, "--report", join(root, "r.md")]);
    assert.equal(result.status, 0, result.stderr);
    // 解包验收 run 结构
    const xml = zipXml(out).stdout;
    const paras = [...xml.matchAll(/<w:p\b.*?<\/w:p>/gs)].map((m) => m[0]);
    const runsOf = (p: string) =>
      [...p.matchAll(/<w:r\b.*?<\/w:r>/gs)].map((m) => ({
        sub: m[0].includes("subscript"),
        text: (m[0].match(/<w:t[^>]*>(.*?)<\/w:t>/s) || ["", ""])[1] ?? "",
      }));
    const body = paras.find((p) => p.includes("79–81%"));
    assert.ok(body, "找到目标段");
    const runs = runsOf(body);
    const subTexts = runs.filter((r) => r.sub).map((r) => r.text);
    // 假下标不得出现：任何下标 run 的内容只能是化学计量数字
    for (const t of subTexts) assert.match(t, /^[0-9]+$/, `下标 run 只允许数字，实得 ${JSON.stringify(t)}`);
    const full = runs.map((r) => r.text).join("");
    assert.match(full, /~79–81%/); // 大约号保留
    assert.match(full, /\(~2 µm\)/);
    assert.match(full, /~2\.1 V/);
    assert.match(full, /~80 and ~50 cycles/);
    assert.match(full, /a-MgCl2@polymer/); // \@ 已还原（2 为下标 run 摊平）
    assert.doesNotMatch(full, /\\@/);
    assert.match(full, /\(S\. Zhang et al\., 2026; X\. Zhang et al\., 2026\)/); // 同姓不同人加首字母
    // 同一作者同年两篇 → a/b
    const out2 = join(root, "same.docx");
    const md2 = join(root, "full.md");
    assert.equal(run(citeDocx, ["--input", md2, "--bib", bib, "--output", out2, "--report", join(root, "r2.md")]).status, 0);
    const xml2 = zipXml(out2).stdout;
    assert.match(xml2, /\(Chen et al\., 2025a; Chen et al\., 2025b\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("EndNote rejects malformed input, macro loss, external entities and report/output alias", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-bib-errors-"));
  try {
    for (const [name, text] of [["bad.bib","@article{x,title={oops}"], ["macro.bib","@string{j=\"Journal\"}\n@article{x,title={A},journal=j}"], ["evil.xml","<!DOCTYPE x [<!ENTITY e SYSTEM 'file:///etc/passwd'>]><xml/>"], ["bad.ris","TY  - JOUR\nTI  - A\n"]]) {
      const path = join(root,name); writeFileSync(path,text);
      const out = join(root,name+".xml");
      const result = run(bridge,["--input",path,"--output",out,"--report",out+".json"]);
      assert.notEqual(result.status,0,name);assert.equal(existsSync(out),false);
    }
    const source=join(root,"valid.bib");writeFileSync(source,"@article{x,title={A},year={2026}}");
    const alias=join(root,"same.xml");
    assert.notEqual(run(bridge,["--input",source,"--output",alias,"--report",alias]).status,0);
    assert.equal(existsSync(alias),false);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("EndNote 域稿：匹配键写出 ADDIN EN.CITE，未匹配不写 docx", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-endnote-cite-"));
  try {
    const md = join(root, "review-final.md");
    const bib = join(root, "references.bib");
    writeFileSync(
      bib,
      "@article{Doe2020,\n title={Evidence}, author={Doe, Jane and Roe, John}, year={2020}, journal={Research}, doi={10.1/ex}\n}\n@article{Lee2021,\n title={More}, author={Lee, Ann}, year={2021}, journal={Research}\n}\n",
    );
    writeFileSync(
      md,
      "# Title\n\nSee [@Doe2020] and also [@Doe2020; @Lee2021].\n\n```\ncode [@Missing]\n```\n",
    );
    const docx = join(root, "endnote.docx");
    const report = join(root, "report.md");
    let result = run(citeDocx, ["--input", md, "--bib", bib, "--output", docx, "--report", report]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(docx), true);
    const zip = zipXml(docx);
    assert.equal(zip.status, 0, zip.stderr);
    assert.match(zip.stdout, /ADDIN EN\.CITE/);
    assert.match(zip.stdout, /ADDIN EN\.REFLIST/);
    assert.doesNotMatch(zip.stdout, /\{Doe, 2020/);
    // 域格式契约（2026-10-10 与 EndNote 2025 实稿核对）：instrText 只留短指令，
    // 引文 XML 全在 fldData（base64，CRLF 换行），并嵌套 EN.CITE.DATA 子域（两层 fldData 同载荷）。
    // 少了子域 CWYW 读不到数据，Update 会把引文整条报成 INVALID CITATION。
    assert.doesNotMatch(zip.stdout, /ADDIN EN\.CITE &lt;EndNote&gt;/);
    assert.match(zip.stdout, /ADDIN EN\.CITE\.DATA </);
    assert.match(zip.stdout, new RegExp("[A-Za-z0-9+/]{76}\\r\\n"));
    const fld = fldData(docx);
    assert.equal(fld.status, 0, fld.stderr);
    assert.match(fld.stdout, /<EndNote><Cite><Author>Doe<\/Author><Year>2020<\/Year><RecNum>1<\/RecNum><DisplayText>\(Doe et al\., 2020\)<\/DisplayText>/);
    // 组引文 = 一条 fldData 里多个 Cite，只有第一个带 DisplayText
    assert.match(fld.stdout, /<DisplayText>\(Doe et al\., 2020; Lee, 2021\)<\/DisplayText>/);
    assert.match(fld.stdout, /<RecNum>2<\/RecNum><record><rec-number>2<\/rec-number><ref-type name="Journal Article">17<\/ref-type>/);
    // record 内顺序：rec-number 在前；未绑定不写 foreign-keys；urls 在 electronic-resource-num 之前
    assert.match(fld.stdout, /<rec-number>1<\/rec-number><ref-type name="Journal Article">17<\/ref-type>/);
    assert.doesNotMatch(fld.stdout, /<foreign-keys>/);
    assert.match(fld.stdout, /<urls><\/urls><electronic-resource-num>10\.1\/ex<\/electronic-resource-num>/);
    writeFileSync(md, "# Title\n\n3834 mAh cm^−3^ and **bold** H~2~O.\n");
    const marked = join(root, "marked.docx");
    result = run(citeDocx, ["--input", md, "--bib", bib, "--output", marked, "--report", join(root, "mark.md")]);
    assert.equal(result.status, 0, result.stderr);
    const markZip = zipXml(marked, ["word/document.xml", "word/styles.xml"]);
    assert.match(markZip.stdout, /Heading1/);
    assert.match(markZip.stdout, /w:val="both"/);
    assert.match(markZip.stdout, /firstLineChars="200"/);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    writeFileSync(join(root, "dot.png"), png);
    writeFileSync(md, "---\ntitle: \"A Title\"\nabstract: |\n  One line.\nkeywords:\n  - alpha\n---\n\n## Introduction\n\n### Detail\n\n![A panel.](dot.png){#fig-1}\n");
    const fronted = join(root, "front.docx");
    result = run(citeDocx, ["--input", md, "--bib", bib, "--output", fronted, "--report", join(root, "front.md")]);
    assert.equal(result.status, 0, result.stderr);
    const frontZip = zipXml(fronted);
    assert.match(frontZip.stdout, /A Title/);
    assert.match(frontZip.stdout, /Abstract/);
    assert.match(frontZip.stdout, /Keywords/);
    assert.doesNotMatch(frontZip.stdout, /摘要|关键词|图 1/);
    assert.match(frontZip.stdout, />1 Introduction</);
    assert.match(frontZip.stdout, />1\.1 Detail</);
    // 图注 = 粗体前缀 run + 粗体正文 run，断言跨 run 拼
    assert.match(frontZip.stdout, /Figure 1\. <\/w:t><\/w:r><w:r><w:rPr><w:b \/><\/w:rPr><w:t>A panel\./);
    writeFileSync(md, "See Figure @fig-1 and (Table @tbl-1).\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n: The caption. {#tbl-1}\n\n![Panel.](dot.png){#fig-1}\n");
    const linked = join(root, "linked.docx");
    result = run(citeDocx, ["--input", md, "--bib", bib, "--output", linked, "--report", join(root, "link.md")]);
    assert.equal(result.status, 0, result.stderr);
    const linkZip = zipXml(linked);
    assert.match(linkZip.stdout, /Figure 1\. <\/w:t><\/w:r><w:r><w:rPr><w:b \/><\/w:rPr><w:t>Panel\./);
    assert.match(linkZip.stdout, /Table 1\./);
    assert.doesNotMatch(linkZip.stdout, /@fig-1|@tbl-1/);
    assert.match(markZip.stdout, /outlineLvl w:val="0"/);
    assert.match(markZip.stdout, /outlineLvl w:val="5"/);
    assert.match(markZip.stdout, /w:val="superscript"/);
    assert.match(markZip.stdout, />−3</);
    assert.doesNotMatch(markZip.stdout, /\^−3\^/);
    assert.match(markZip.stdout, /w:val="subscript"/);
    writeFileSync(md, "| A | B |\n| --- | --- |\n| 1 | [@Doe2020] |\n\n---\n");
    const tabled = join(root, "table.docx");
    result = run(citeDocx, ["--input", md, "--bib", bib, "--output", tabled, "--report", join(root, "table.md")]);
    assert.equal(result.status, 0, result.stderr);
    const tableZip = zipXml(tabled);
    assert.match(tableZip.stdout, /<w:tbl>/);
    assert.match(tableZip.stdout, /w:val="nil"/);
    assert.doesNotMatch(tableZip.stdout, /insideV w:val="single"/);
    assert.match(tableZip.stdout, /ADDIN EN\.CITE/);
    assert.match(tableZip.stdout, /w:footerReference/);
    assert.match(tableZip.stdout, /pgMar/);
    writeFileSync(
      md,
      "See {#Doe2020} and the table {#tbl-benchmark}.\n",
    );
    const braced = join(root, "braced.docx");
    result = run(citeDocx, ["--input", md, "--bib", bib, "--output", braced, "--report", join(root, "brace.md")]);
    assert.equal(result.status, 0, result.stderr);
    const braceZip = zipXml(braced);
    assert.match(braceZip.stdout, /ADDIN EN\.CITE/);
    assert.match(braceZip.stdout, /tbl-benchmark/);
    assert.doesNotMatch(braceZip.stdout, /\{#|@tbl-/);
    assert.match(zip.stdout, /Doe et al\., 2020/);
    assert.doesNotMatch(zip.stdout, /<Author>Missing<\/Author>/);
    assert.match(readFileSync(report, "utf8"), /未匹配：0/);

    const manuscript = join(root, "manuscript");
    const figures = join(root, "figures");
    mkdirSync(manuscript);
    mkdirSync(figures);
    const figMd = join(manuscript, "review-final.md");
    writeFileSync(
      join(figures, "fig1.png"),
      Buffer.from(
        "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfff1f0005fe02fea27c9a2c0000000049454e44ae426082",
        "hex",
      ),
    );
    writeFileSync(
      figMd,
      "Before [@Doe2020].\n\n![Panel of [@Lee2021].](../figures/fig1.png){#fig-1}\n\nAfter.\n",
    );
    const withFig = join(root, "with-fig.docx");
    result = run(citeDocx, ["--input", figMd, "--bib", bib, "--output", withFig, "--report", join(root, "fig.md")]);
    assert.equal(result.status, 0, result.stderr);
    const figZip = spawnSync(
      python,
      ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print('\\n'.join(z.namelist())); print(z.read('word/document.xml').decode())", withFig],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(figZip.status, 0, figZip.stderr);
    assert.match(figZip.stdout, /word\/media\/image1\.png/);
    assert.match(figZip.stdout, /r:embed="rIdImg1"/);
    assert.match(figZip.stdout, /Panel of /);
    assert.match(figZip.stdout, /ADDIN EN\.CITE/);
    assert.match(readFileSync(join(root, "fig.md"), "utf8"), /插图：1/);
    writeFileSync(figMd, "![Gone.](../figures/missing.png)\n");
    const missingFig = join(root, "missing-fig.docx");
    result = run(citeDocx, ["--input", figMd, "--bib", bib, "--output", missingFig, "--report", join(root, "missing-fig.md")]);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(missingFig), false);

    writeFileSync(md, "Broken [@NoSuchKey] cite.\n");
    const bad = join(root, "bad.docx");
    result = run(citeDocx, ["--input", md, "--bib", bib, "--output", bad, "--report", join(root, "bad.md")]);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(bad), false);
    assert.match(readFileSync(join(root, "bad.md"), "utf8"), /NoSuchKey/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("引用样式按 PDF 推荐，不替人选定；EndNote 同步只应用接受的删除和新文献", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-cite-style-"));
  try {
    const papers = join(root, "papers");
    const manuscript = join(root, "manuscript");
    mkdirSync(papers);
    mkdirSync(manuscript);
    const stream = Buffer.from("BT (See [1] and [2].) Tj ET");
    writeFileSync(join(papers, "a.pdf"), Buffer.concat([
      Buffer.from("%PDF-1.4\n1 0 obj\n<< /Length " + stream.length + " >>\nstream\n"),
      stream,
      Buffer.from("\nendstream\nendobj\n"),
    ]));
    const style = resolve("src-tauri/resources/skills/quarto-render/scripts/citation_style.py");
    let result = run(style, ["--root", root, "--require-choice"]);
    assert.equal(result.status, 2, result.stderr);
    const report = readFileSync(join(manuscript, "citation-style.md"), "utf8");
    assert.match(report, /编号：1/);
    assert.match(report, /^选定：\s*$/m);
    writeFileSync(join(manuscript, "citation-style.md"), report.replace("选定：", "选定：编号"));
    result = run(style, ["--root", root, "--apply"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(manuscript, "citation.csl"), "utf8"), /citation-number/);
    assert.match(readFileSync(join(manuscript, "citation-style.md"), "utf8"), /选定：编号/);

    const md = join(manuscript, "review-final.md");
    const bib = join(root, "references.bib");
    writeFileSync(bib, "@article{Doe2020,\n title={Evidence}, author={Doe, Jane}, year={2020}, journal={Research}, doi={10.1/ex}\n}\n@article{Lee2021,\n title={More}, author={Lee, Ann}, year={2021}, journal={Research}, doi={10.2/ex}\n}\n");
    const onlyDoe = join(root, "only-doe.md");
    writeFileSync(onlyDoe, "See [@Doe2020].\n");
    writeFileSync(md, "See [@Doe2020] and [@Lee2021].\n");
    const output = join(root, "output");
    mkdirSync(output);
    result = run(citeDocx, ["--input", onlyDoe, "--bib", bib, "--output", join(output, "endnote.docx"), "--report", join(root, "cite.md")]);
    assert.equal(result.status, 0, result.stderr);
    const sync = resolve("src-tauri/resources/skills/endnote-bridge/scripts/sync_docx.py");
    result = run(sync, ["--root", root, "--markdown", "manuscript/review-final.md"]);
    assert.equal(result.status, 0, result.stderr);
    const diffPath = join(papers, "endnote-sync-report.md");
    const diff = readFileSync(diffPath, "utf8");
    assert.match(diff, /Lee2021 \| 删除 \| 决定：待定/);
    writeFileSync(diffPath, diff.replace("决定：待定", "决定：拒绝"));
    result = run(sync, ["--root", root, "--markdown", "manuscript/review-final.md", "--apply"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(md, "utf8"), /Lee2021/);
    writeFileSync(diffPath, readFileSync(diffPath, "utf8").replace("决定：拒绝", "决定：接受"));
    result = run(sync, ["--root", root, "--markdown", "manuscript/review-final.md", "--apply"]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(readFileSync(md, "utf8"), /Lee2021/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("域稿按 DOI 绑定本机库：唯一才写入记录号或条目地址，重复不猜", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-library-bind-"));
  try {
    const enl = join(root, "library.enl");
    const zotero = join(root, "zotero.sqlite");
    const seed = `
import sqlite3, sys
enl, zot = sys.argv[1], sys.argv[2]
e = sqlite3.connect(enl)
e.execute("CREATE TABLE misc(code INTEGER, subcode INTEGER, value BLOB, PRIMARY KEY(code, subcode))")
e.execute("INSERT INTO misc VALUES (14, 0, ?)", (b"abc123libraryid",))
e.execute("CREATE TABLE refs(id INTEGER PRIMARY KEY, trash_state INTEGER NOT NULL DEFAULT 0, electronic_resource_number TEXT NOT NULL DEFAULT '', added_to_library INTEGER)")
e.execute("INSERT INTO refs VALUES (392, 0, '10.1000/only', 1700000000)")
e.execute("INSERT INTO refs VALUES (10, 0, '10.1000/dup', 1700000001)")
e.execute("INSERT INTO refs VALUES (11, 0, '10.1000/dup', 1700000002)")
e.execute("INSERT INTO refs VALUES (12, 1, '10.1000/trashed', 1700000003)")
e.commit()
z = sqlite3.connect(zot)
z.execute("CREATE TABLE settings(setting TEXT, key TEXT, value TEXT)")
z.execute("INSERT INTO settings VALUES ('account', 'localUserKey', 'UserKey1')")
z.execute("CREATE TABLE libraries(libraryID INTEGER PRIMARY KEY, type TEXT)")
z.execute("INSERT INTO libraries VALUES (1, 'user')")
z.execute("CREATE TABLE items(itemID INTEGER PRIMARY KEY, libraryID INTEGER, key TEXT)")
z.execute("CREATE TABLE fields(fieldID INTEGER PRIMARY KEY, fieldName TEXT)")
z.execute("CREATE TABLE itemDataValues(valueID INTEGER PRIMARY KEY, value TEXT)")
z.execute("CREATE TABLE itemData(itemID INTEGER, fieldID INTEGER, valueID INTEGER)")
z.execute("CREATE TABLE deletedItems(itemID INTEGER)")
z.execute("INSERT INTO fields VALUES (1, 'DOI')")
z.execute("INSERT INTO items VALUES (1, 1, 'ONLYKEY8')")
z.execute("INSERT INTO items VALUES (2, 1, 'DUPKEY0A')")
z.execute("INSERT INTO items VALUES (3, 1, 'DUPKEY0B')")
z.execute("INSERT INTO itemDataValues VALUES (1, '10.1000/only')")
z.execute("INSERT INTO itemDataValues VALUES (2, 'https://doi.org/10.1000/dup')")
z.execute("INSERT INTO itemData VALUES (1, 1, 1)")
z.execute("INSERT INTO itemData VALUES (2, 1, 2)")
z.execute("INSERT INTO itemData VALUES (3, 1, 2)")
z.commit()
`;
    const seeded = spawnSync(python, ["-c", seed, enl, zotero], { encoding: "utf8" });
    assert.equal(seeded.status, 0, seeded.stderr);
    const md = join(root, "review-final.md");
    const bib = join(root, "references.bib");
    writeFileSync(md, "See [@Only2020] and [@Dup2021] and [@None2022].\n");
    writeFileSync(bib, [
      "@article{Only2020, title={Only}, author={Doe, Jane}, year={2020}, doi={10.1000/only}}",
      "@article{Dup2021, title={Dup}, author={Roe, Ann}, year={2021}, doi={DOI: 10.1000/dup.}}",
      "@article{None2022, title={None}, author={Lee, Bo}, year={2022}, doi={10.9999/missing}}",
      "",
    ].join("\n"));
    const endnote = join(root, "endnote.docx");
    let result = run(citeDocx, ["--input", md, "--bib", bib, "--output", endnote, "--report", join(root, "en.md"), "--endnote-library", enl]);
    assert.equal(result.status, 0, result.stderr);
    const enFld = fldData(endnote);
    assert.equal(enFld.status, 0, enFld.stderr);
    assert.match(zipXml(endnote).stdout, /ADDIN EN\.CITE\.DATA </);
    // 外键按实稿形态：rec-number 在前，key 带 timestamp 和 ENWeb 兄弟键
    assert.match(enFld.stdout, /<RecNum>392<\/RecNum>/);
    assert.match(enFld.stdout, /<rec-number>392<\/rec-number><foreign-keys><key app="EN" db-id="abc123libraryid" timestamp="1700000000">392<\/key><key app="ENWeb" db-id="">0<\/key><\/foreign-keys>/);
    assert.doesNotMatch(enFld.stdout, /<RecNum>10<\/RecNum>|db-id="mesa"/);
    const enReport = readFileSync(join(root, "en.md"), "utf8");
    assert.match(enReport, /已绑定 1 条/);
    assert.match(enReport, /Dup2021.*2 条/);
    assert.match(enReport, /None2022.*没有/);
    const pointer = join(root, "papers");
    mkdirSync(pointer);
    writeFileSync(join(pointer, "endnote-library.path"), `${enl}\n`);
    const viaPointer = join(root, "via-pointer.docx");
    result = run(citeDocx, ["--input", md, "--bib", bib, "--output", viaPointer, "--report", join(root, "pointer.md"), "--project-root", root]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(root, "pointer.md"), "utf8"), /已绑定 1 条/);
    const unbound = join(root, "unbound.docx");
    result = run(citeDocx, ["--input", md, "--bib", bib, "--output", unbound, "--report", join(root, "unbound.md")]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(root, "unbound.md"), "utf8"), /未指定 EndNote 库/);
    const unboundFld = fldData(unbound);
    assert.doesNotMatch(unboundFld.stdout, /foreign-keys|db-id/);

    const zoteroDocx = join(root, "zotero.docx");
    const zoteroScript = resolve("src-tauri/resources/skills/zotero-sync/scripts/zotero_docx.py");
    result = run(zoteroScript, ["--input", md, "--bib", bib, "--output", zoteroDocx, "--report", join(root, "zo.md"), "--zotero-db", zotero]);
    assert.equal(result.status, 0, result.stderr);
    const zoXml = zipXml(zoteroDocx);
    assert.match(zoXml.stdout, /users\/local\/UserKey1\/items\/ONLYKEY8/);
    assert.doesNotMatch(zoXml.stdout, /DUPKEY0/);
    assert.doesNotMatch(zoXml.stdout, /ITEM-/);
    assert.doesNotMatch(
      zoXml.stdout,
      /"citationItems":\s*\[\]/,
      "未绑定/多条的引文也必须带嵌在域里的 itemData，空 citationItems 会被 Zotero Refresh 整条删掉",
    );
    assert.match(zoXml.stdout, /users\/local\/00000000\/items\/embed000/);
    const zoReport = readFileSync(join(root, "zo.md"), "utf8");
    assert.match(zoReport, /已绑定 1 条/);
    assert.match(zoReport, /Dup2021.*2 条/);

    // EndNote X9 及更早：.enl 不是 SQLite、记录在 .Data/rdb——报告说清怎么导出 XML（2026-10-24 HER：「file is not a database」）
    const legacy = join(root, "old.enl");
    writeFileSync(legacy, "not sqlite");
    mkdirSync(join(root, "old.Data", "rdb"), { recursive: true });
    result = run(citeDocx, ["--input", md, "--bib", bib, "--output", join(root, "legacy.docx"), "--report", join(root, "legacy.md"), "--endnote-library", legacy]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(root, "legacy.md"), "utf8"), /EndNote X9 及更早[\s\S]*File → Export[\s\S]*XML/);
    // 导出的 XML 能绑：记录号与库编号取自 XML
    const exported = join(root, "endnote-library.xml");
    const style = (s: string) => `<style face="normal" font="default" size="100%">${s}</style>`;
    const rec = (n: number, doi: string) =>
      `<record><rec-number>${n}</rec-number><foreign-keys><key app="EN" db-id="x9dbid0001" timestamp="1690000000">${n}</key></foreign-keys><ref-type name="Journal Article">17</ref-type><titles><title>${style("T")}</title></titles><electronic-resource-num>${style(doi)}</electronic-resource-num></record>`;
    writeFileSync(exported, `<?xml version="1.0" encoding="UTF-8" ?><xml><records>${rec(7, "10.1000/only")}${rec(8, "10.1000/dup")}${rec(9, "10.1000/dup")}</records></xml>`);
    const viaXml = join(root, "via-xml.docx");
    result = run(citeDocx, ["--input", md, "--bib", bib, "--output", viaXml, "--report", join(root, "xml.md"), "--endnote-library", exported]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(root, "xml.md"), "utf8"), /已绑定 1 条/);
    assert.match(fldData(viaXml).stdout, /<rec-number>7<\/rec-number><foreign-keys><key app="EN" db-id="x9dbid0001" timestamp="1690000000">7<\/key>/);
    // 没有 DOI 的（中文期刊常见）：题名去标点大小写 + 年份恰好一条才绑（2026-10-24 HER：梁珂明 2020 两边都没 DOI）
    const recNoDoi = (n: number, title: string, year: string) =>
      `<record><rec-number>${n}</rec-number><foreign-keys><key app="EN" db-id="x9dbid0001" timestamp="1690000000">${n}</key></foreign-keys><ref-type name="Journal Article">17</ref-type><titles><title>${style(title)}</title></titles><dates><year>${style(year)}</year></dates></record>`;
    writeFileSync(exported, `<?xml version="1.0" encoding="UTF-8" ?><xml><records>${rec(7, "10.1000/only")}${recNoDoi(30, "碳纳米纤维负载铁钴镍硼化物可控制备", "2020")}${recNoDoi(31, "Same Title", "2019")}${recNoDoi(32, "Same title.", "2019")}</records></xml>`);
    const md2 = join(root, "nodoi.md");
    writeFileSync(md2, "See [@Cn2020] and [@Twin2019].\n");
    const bib2 = join(root, "nodoi.bib");
    writeFileSync(bib2, [
      "@article{Cn2020, title={碳纳米纤维负载铁钴镍硼化物可控制备}, author={梁珂明 and 姜彬}, year={2020}}",
      "@article{Twin2019, title={Same Title}, author={Roe, Ann}, year={2019}}",
      "",
    ].join("\n"));
    const noDoi = join(root, "nodoi.docx");
    result = run(citeDocx, ["--input", md2, "--bib", bib2, "--output", noDoi, "--report", join(root, "nodoi-report.md"), "--endnote-library", exported]);
    assert.equal(result.status, 0, result.stderr);
    const noDoiReport = readFileSync(join(root, "nodoi-report.md"), "utf8");
    assert.match(noDoiReport, /已绑定 1 条/);
    assert.match(noDoiReport, /Cn2020.*按题名与年份对上记录 30/);
    assert.match(noDoiReport, /Twin2019.*2 条，未绑定/);
    assert.match(fldData(noDoi).stdout, /<rec-number>30<\/rec-number><foreign-keys><key app="EN" db-id="x9dbid0001"/);
    // EndNote 2025 开库期间实时改写 .Data/sdb/sdb.eni，.enl 停在开库前快照：优先读更新的 sdb.eni（2026-11-14 HER 实证）
    const liveEnl = join(root, "live.enl");
    const liveSdbDir = join(root, "live.Data", "sdb");
    mkdirSync(liveSdbDir, { recursive: true });
    const liveSdb = join(liveSdbDir, "sdb.eni");
    const seedLive = `
import os, sqlite3, sys
enl, sdb = sys.argv[1], sys.argv[2]
for p, rows in [(enl, []), (sdb, [(501, 0, '10.1000/only', 1700009999)])]:
    c = sqlite3.connect(p)
    c.execute("CREATE TABLE misc(code INTEGER, subcode INTEGER, value BLOB, PRIMARY KEY(code, subcode))")
    c.execute("INSERT INTO misc VALUES (14, 0, ?)", (b"livedbid9999",))
    c.execute("CREATE TABLE refs(id INTEGER PRIMARY KEY, trash_state INTEGER NOT NULL DEFAULT 0, electronic_resource_number TEXT NOT NULL DEFAULT '', added_to_library INTEGER)")
    c.executemany("INSERT INTO refs VALUES (?, ?, ?, ?)", rows)
    c.commit()
    c.close()
os.utime(enl, (1700000000, 1700000000))
os.utime(sdb, (1700010000, 1700010000))
`;
    assert.equal(spawnSync(python, ["-c", seedLive, liveEnl, liveSdb], { encoding: "utf8" }).status, 0);
    const viaLive = join(root, "via-live.docx");
    result = run(citeDocx, ["--input", md, "--bib", bib, "--output", viaLive, "--report", join(root, "live.md"), "--endnote-library", liveEnl]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(root, "live.md"), "utf8"), /已绑定 1 条/);
    assert.match(fldData(viaLive).stdout, /<rec-number>501<\/rec-number><foreign-keys><key app="EN" db-id="livedbid9999" timestamp="1700009999">501<\/key>/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Zotero 域稿写出 ADDIN ZOTERO_ITEM，缺键不交 docx", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-zotero-docx-"));
  try {
    const md = join(root, "review-final.md");
    const bib = join(root, "references.bib");
    writeFileSync(md, "See [@Doe2020] and [@Doe2020; @Lee2021].\n");
    writeFileSync(
      bib,
      "@article{Doe2020,\n title={Evidence on MoS2 & Co2B at 10 mA cm^-2}, author={Doe, Jane and Roe, John}, year={2020}, journal={Research}, doi={10.1/ex}\n}\n@article{Lee2021,\n title={More}, author={Lee, Ann}, year={2021}, journal={Research}\n}\n",
    );
    const script = resolve("src-tauri/resources/skills/zotero-sync/scripts/zotero_docx.py");
    const docx = join(root, "zotero.docx");
    let result = run(script, ["--input", md, "--bib", bib, "--output", docx, "--report", join(root, "report.md")]);
    assert.equal(result.status, 0, result.stderr);
    const zip = zipXml(docx, ["word/document.xml", "word/styles.xml"]);
    assert.equal(zip.status, 0, zip.stderr);
    assert.match(zip.stdout, /ADDIN ZOTERO_ITEM CSL_CITATION/);
    assert.doesNotMatch(zip.stdout, /"citationItems":\s*\[\]/);
    // Zotero CSL JSON title 带 <sub>/<sup> 真上下标标记（Word Refresh 后出 w:vertAlign），而非 Unicode 假下标码位
    assert.match(zip.stdout, /MoS&lt;sub&gt;2&lt;\/sub&gt;/);
    assert.match(zip.stdout, /Co&lt;sub&gt;2&lt;\/sub&gt;B/);
    assert.doesNotMatch(zip.stdout, /MoS₂|Co₂B/);
    // EndNote 域稿 traveling library 同样写 <style face="subscript"> 真下标
    const enDocx = join(root, "en-sub.docx");
    assert.equal(run(citeDocx, ["--input", md, "--bib", bib, "--output", enDocx, "--report", join(root, "en-sub.md")]).status, 0);
    assert.match(
      fldData(enDocx).stdout,
      /<style face="normal" font="default" size="100%">Evidence on MoS<\/style><style face="subscript" font="default" size="100%">2<\/style>/,
    );
    assert.match(zip.stdout, /citationID/);
    assert.match(zip.stdout, /formattedCitation/);
    // 预置空 BIBL 会被 Zotero Refresh 删掉（2026-10-10 实证）：生成稿只留 References 标题和空锚点段
    assert.doesNotMatch(zip.stdout, /ZOTERO_BIBL|CSL_BIBLIOGRAPHY/);
    assert.match(zip.stdout, /outlineLvl w:val="0"/);
    assert.match(zip.stdout, /w:footerReference/);
    assert.match(zip.stdout, /References<\/w:t>/);
    assert.match(zip.stdout, /Doe et al\., 2020/);
    assert.doesNotMatch(zip.stdout, /\\\{Doe, 2020/);
    writeFileSync(md, "See {#Doe2020} and {#tbl-benchmark}.\n");
    const braced = join(root, "braced.docx");
    result = run(script, ["--input", md, "--bib", bib, "--output", braced, "--report", join(root, "brace.md")]);
    assert.equal(result.status, 0, result.stderr);
    const braceZip = zipXml(braced);
    assert.match(braceZip.stdout, /ADDIN ZOTERO_ITEM CSL_CITATION/);
    assert.match(braceZip.stdout, /tbl-benchmark/);
    assert.doesNotMatch(braceZip.stdout, /\{#/);
    assert.match(readFileSync(join(root, "report.md"), "utf8"), /未匹配：0/);
    // 图注和表题里的 [@键] 同样写出真实引文域（EndNote/Zotero 换编号样式时同步变成 [1]，不再停在静态作者-年），
    // 且首句加粗只作用在 <w:t> run，不污染 fldChar / instrText 域控制 run
    writeFileSync(
      md,
      "See [@Doe2020].\n\n![Lead [@Lee2021]. Summarized from [@Doe2020; @Lee2021].](dot.png){#fig-1}\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n: Table note [@Lee2021]. {#tbl-1}\n",
    );
    writeFileSync(join(root, "dot.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
    const captioned = join(root, "captioned.docx");
    result = run(script, ["--input", md, "--bib", bib, "--output", captioned, "--report", join(root, "cap.md")]);
    assert.equal(result.status, 0, result.stderr);
    const capZoXml = zipXml(captioned).stdout;
    assert.equal((capZoXml.match(/ADDIN ZOTERO_ITEM CSL_CITATION/g) ?? []).length, 4);
    assert.doesNotMatch(capZoXml, /<w:b \/><\/w:rPr><w:(?:fldChar|instrText)/);
    assert.doesNotMatch(result.stderr, /cited only in captions/);
    const enCaptioned = join(root, "en-captioned.docx");
    const enCapRes = run(citeDocx, ["--input", md, "--bib", bib, "--output", enCaptioned, "--report", join(root, "en-cap.md")]);
    assert.equal(enCapRes.status, 0, enCapRes.stderr);
    const capEnXml = zipXml(enCaptioned).stdout;
    assert.equal((capEnXml.match(/ADDIN EN\.CITE\.DATA/g) ?? []).length, 4);
    assert.doesNotMatch(capEnXml, /<w:b \/><\/w:rPr><w:(?:fldChar|instrText)/);
    assert.match(fldData(enCaptioned).stdout, /<Author>Lee<\/Author>/);
    writeFileSync(md, "See [@Missing].\n");
    const bad = join(root, "bad.docx");
    result = run(script, ["--input", md, "--bib", bib, "--output", bad, "--report", join(root, "bad.md")]);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(bad), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("两份域稿的字体取自 manuscript/typeface.md，没有这份文件才按平台回落（不再写死 Songti SC）", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-docx-fonts-"));
  try {
    mkdirSync(join(root, "manuscript"));
    mkdirSync(join(root, "submission"));
    const bib = join(root, "references.bib");
    writeFileSync(bib, "@article{Doe2020,\n title={Evidence}, author={Doe, Jane}, year={2020}, journal={Research}, doi={10.1/ex}\n}\n");
    const endnote = citeDocx;
    const zotero = resolve("src-tauri/resources/skills/zotero-sync/scripts/zotero_docx.py");
    const fontsOf = (script: string, source: string, name: string) => {
      const out = join(root, name);
      const result = run(script, ["--input", source, "--bib", bib, "--output", out, "--report", join(root, `${name}.md`)]);
      assert.equal(result.status, 0, result.stderr);
      const styles = zipXml(out, ["word/styles.xml"]).stdout;
      return {
        latin: styles.match(/w:ascii="([^"]*)"/)?.[1],
        cjk: styles.match(/w:eastAsia="([^"]*)"/)?.[1],
      };
    };
    const final = join(root, "manuscript", "review-final.md");
    writeFileSync(final, "See [@Doe2020].\n");
    // 没有 typeface.md：英文 Times New Roman，中文按平台（macOS Songti SC，其余宋体）
    const fallback = process.platform === "darwin" ? "Songti SC" : "宋体";
    for (const script of [endnote, zotero]) {
      assert.deepEqual(fontsOf(script, final, "a.docx"), { latin: "Times New Roman", cjk: fallback });
    }
    // 有 typeface.md：照用户在初稿开工时定的字体
    writeFileSync(join(root, "manuscript", "typeface.md"), "英文：Arial\n中文：SimSun\n");
    for (const script of [endnote, zotero]) {
      assert.deepEqual(fontsOf(script, final, "b.docx"), { latin: "Arial", cjk: "SimSun" });
    }
    // 期刊格式适配的稿在 submission/，同样找得到 ../manuscript/typeface.md
    const formatted = join(root, "submission", "formatted.md");
    writeFileSync(formatted, "See [@Doe2020].\n");
    for (const script of [endnote, zotero]) {
      assert.deepEqual(fontsOf(script, formatted, "c.docx"), { latin: "Arial", cjk: "SimSun" });
    }
    // 字体名里的引号不能弄坏 styles.xml
    writeFileSync(join(root, "manuscript", "typeface.md"), '英文：Foo "Bar"\n中文：宋体\n');
    assert.deepEqual(fontsOf(endnote, final, "d.docx"), { latin: "Foo &quot;Bar&quot;", cjk: "宋体" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Zotero 交稿写出可扫描的引用和对应 RIS，缺键不交稿", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-zotero-rtf-"));
  try {
    const md = join(root, "review-final.md");
    const bib = join(root, "references.bib");
    writeFileSync(md, "See [@Doe2020].\n");
    writeFileSync(bib, "@article{Doe2020,\n title={Evidence}, author={Doe, Jane}, year={2020}, journal={Research}, doi={10.1/ex}\n}\n");
    const script = resolve("src-tauri/resources/skills/zotero-sync/scripts/zotero_rtf.py");
    const rtf = join(root, "zotero.rtf");
    const ris = join(root, "zotero.ris");
    let result = run(script, ["--input", md, "--bib", bib, "--rtf", rtf, "--ris", ris, "--report", join(root, "report.md")]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(rtf, "utf8"), /\\\{Doe, 2020\\\}/);
    assert.match(readFileSync(ris, "utf8"), /ID  - Doe2020/);
    const zoteroRis = readFileSync(ris, "utf8");
    assert.match(zoteroRis, /T2  - Research/);
    assert.doesNotMatch(zoteroRis, /JO  - /);
    assert.doesNotMatch(zoteroRis, /M2  - /);
    writeFileSync(md, "See [@Missing].\n");
    const bad = join(root, "bad.rtf");
    result = run(script, ["--input", md, "--bib", bib, "--rtf", bad, "--ris", join(root, "bad.ris"), "--report", join(root, "bad.md")]);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(bad), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Zotero 全库 RIS（同步按钮）：T2/J2 字段约定，标识符零化学美化", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-zotero-lib-"));
  try {
    const bib = join(root, "references.bib");
    writeFileSync(
      bib,
      "@article{Mg2026,\n" +
        " title={MgCl <sub>2</sub> Solubilization with robust Mg2+-Conducting interphase},\n" +
        " author={Doe, Jane}, year={2026}, journal={Energy Storage Materials},\n" +
        " doi={10.1016/s0022-0728(99)00146-1}, volume={S1}, pages={A257--A260}, issn={0022-0728},\n" +
        " abstract={See 10.1039/D2EE04121A for data}\n" +
        "}\n",
    );
    const script = resolve("src-tauri/resources/skills/zotero-sync/scripts/zotero_rtf.py");
    const out = join(root, "zotero-library.ris");
    // 差量导入会读本机 Zotero 库跳过已有 DOI；测试指一个空配置目录，保持确定性
    const savedCfg = process.env.ZOTERO_CONFIG_DIR;
    process.env.ZOTERO_CONFIG_DIR = root;
    const result = run(script, ["--library-ris", "--bib", bib, "--ris", out]);
    if (savedCfg === undefined) delete process.env.ZOTERO_CONFIG_DIR;
    else process.env.ZOTERO_CONFIG_DIR = savedCfg;
    assert.equal(result.status, 0, result.stderr);
    const text = readFileSync(out, "utf8");
    // RIS 没有注释语法：文件直接从第一条开始，条数与重复情况只进 stdout
    assert.match(text, /^TY  - JOUR\r\n/);
    assert.doesNotMatch(text, /^#/m);
    assert.match(result.stdout, /本次交给 Zotero 1 条。/);
    // 现行字段约定：T2/J2，不写 N1（进笔记）/JO/JF/JA（JO 进期刊缩写）/ID/DA/M3/N2；
    // M2 只放期刊的另一种缩写（「ISO 4 abbreviation: …」）。有没有这一行看联网查到的缩写表（JabRef 没收这本刊时
    // 主缩写回落全称、LTWA 算出的 ISO 4 就作另一种写法），不在这里断言有无，只断言不拿 M2 放别的
    assert.match(text, /T2  - Energy Storage Materials/);
    for (const line of text.split(/\r\n/).filter((l) => l.startsWith("M2  - "))) {
      assert.match(line, /^M2  - ISO 4 abbreviation: \S/, line);
    }
    assert.match(text, /TI  - MgCl₂ Solubilization with robust Mg²⁺-Conducting interphase/);
    assert.match(text, /DO  - 10\.1016\/s0022-0728\(99\)00146-1/);
    assert.match(text, /AB  - See 10\.1039\/D2EE04121A for data/);
    for (const banned of ["N1  - ", "JO  - ", "JF  - ", "JA  - ", "ID  - ", "DA  - ", "M3  - ", "N2  - "]) {
      assert.doesNotMatch(text, new RegExp(banned.replace(/[- ]/g, (c) => "\\" + c)), banned);
    }
    assert.doesNotMatch(text, /₀₀₁₄₆|D₂EE|₂EE|A₂₅₇|MgCl ₂/);
    // 同步按钮的反馈：stdout 必带库体检结论（查不成也说明，不静默）
    assert.match(result.stdout, /库体检：/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 2026-10-23 HER：引文库里还留着检索前从 Zotero 导进来、后来全排除的 18 条，同步整份交了出去
test("Zotero 全库 RIS（同步按钮）：检索时排除的篇不导", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-zotero-skip-"));
  try {
    const bib = join(root, "references.bib");
    writeFileSync(
      bib,
      "@article{Keep2024, title={Kept paper}, author={Doe, Jane}, year={2024}, doi={10.1/keep}}\n" +
        "@article{Gone2020, title={Excluded boride paper}, author={Roe, John}, year={2020}, doi={10.1/GONE}}\n" +
        "@article{Gone2019, title={Excluded without doi}, author={Poe, Ann}, year={2019}}\n",
    );
    const included = join(root, "included.json");
    writeFileSync(included, JSON.stringify([
      { id: "A", title: "Kept paper", decision: "included", reason: "", doi: "10.1/keep" },
      { id: "B", title: "Excluded boride paper", decision: "excluded", reason: "", doi: "https://doi.org/10.1/gone" },
      { id: "C", title: "Excluded without DOI", decision: "excluded", reason: "" },
    ]));
    const script = resolve("src-tauri/resources/skills/zotero-sync/scripts/zotero_rtf.py");
    const out = join(root, "zotero-library.ris");
    const savedCfg = process.env.ZOTERO_CONFIG_DIR;
    process.env.ZOTERO_CONFIG_DIR = root;
    const result = run(script, ["--library-ris", "--bib", bib, "--ris", out, "--skip-excluded", included]);
    if (savedCfg === undefined) delete process.env.ZOTERO_CONFIG_DIR;
    else process.env.ZOTERO_CONFIG_DIR = savedCfg;
    assert.equal(result.status, 0, result.stderr);
    const text = readFileSync(out, "utf8");
    assert.match(text, /TI  - Kept paper/);
    assert.doesNotMatch(text, /Excluded/);
    assert.equal((text.match(/^TY  - /gm) ?? []).length, 1);
    assert.match(result.stdout, /本次交给 Zotero 1 条，检索时排除的 2 条不导/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ISO 4 缩写按期刊全称，带句点；一词刊名不缩", () => {
  const script = resolve("src-tauri/resources/skills/endnote-bridge/scripts/bridge.py");
  const probe = [
    "import importlib.util",
    `spec = importlib.util.spec_from_file_location("bridge", ${JSON.stringify(script)})`,
    "mod = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    "from pathlib import Path",
    "Path(mod.__file__).with_name('journal-abbreviations.csv').write_text(",
    "  'Energy Storage Materials,Energy Storage Mater.\\nThe Chemical Record,Chem. Rec.\\nNature,Nature\\n',",
    "  encoding='utf-8')",
    "mod._MESA_ISO4 = mod.load_mesa_iso4()",
    "mod._iso4_index = {",
    "  'advanced materials': 'Adv. Mater.',",
    "  'advanced engineering materials': 'Adv. Eng. Mater.',",
    "  'small': 'Small',",
    "}",
    "assert mod.iso4_abbreviation('Advanced Materials') == 'Adv. Mater.'",
    "assert mod.iso4_abbreviation('Advanced Engineering Materials') == 'Adv. Eng. Mater.'",
    "assert mod.iso4_abbreviation('Small') == 'Small'",
    "assert mod.iso4_abbreviation('Unknown Journal') == ''",
    "assert mod.iso4_abbreviation('Energy Storage Materials') == 'Energy Storage Mater.'",
    "assert mod.iso4_abbreviation('The Chemical Record') == 'Chem. Rec.'",
    "assert mod.iso4_abbreviation('Nature') == 'Nature'",
  ].join("\n");
  // 探针把兜底表写到脚本旁边（与同步时调用方的放法一致），跑完必须删掉：留在仓库里会让别的测试
  // 拿到这张表、本机绿而 CI 红（2026-10-25 实证：Zotero 全库 RIS 测试本机不出 M2、CI 出）
  const leftover = join(dirname(script), "journal-abbreviations.csv");
  try {
    const result = spawnSync(python, ["-c", probe], { encoding: "utf8", timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(leftover, { force: true });
  }
});

test("Blender validates provenance and dimensions without executing Blender; Origin probe starts no GUI", () => {
  const root = mkdtempSync(join(tmpdir(),"mesa-tool-probe-"));
  try {
    const file = join(root,"scene.json");
    const data = {kind:"schematic",units:"METRIC",provenance:"synthetic test fixture",limitations:"not experimental evidence",objects:[{shape:"cube",location:[0,0,0],scale:[1,2,3]}]};
    writeFileSync(file,JSON.stringify(data));
    const script = resolve("src-tauri/resources/skills/blender-research/scripts/build_scene.py");
    let result = run(script,["--params",file,"--validate"]);assert.equal(result.status,0,result.stderr);
    data.objects[0].scale[0]=-1;writeFileSync(file,JSON.stringify(data));
    result = run(script,["--params",file,"--validate"]);assert.notEqual(result.status,0);
    // 2026-11-23：illustration 管线 + 高频科研构件 + 多图批量 assets 校验 + scene_illus 成图裁边/线宽换算自检
    const batchFile = join(root, "batch.json");
    writeFileSync(batchFile, JSON.stringify({
      kind: "schematic",
      units: "NONE",
      style: "illustration",
      fig_width_mm: 183,
      provenance: "unit test",
      limitations: "not to scale",
      assets: [
        { name: "cell", objects: [{ name: "c1", shape: "three_electrode_cell" }], anchors: { custom: [0, 0, 1] } },
        { name: "lat", objects: [{ name: "l1", shape: "crystal_lattice", options: { nx: 2, ny: 2, nz: 2 } }] },
      ],
    }));
    result = run(script, ["--params", batchFile, "--validate"]);
    assert.equal(result.status, 0, result.stderr);
    // 成图自检要 Pillow：CI 不装，缺时只验线宽换算（同 schematic-forge.test.ts 口径）
    const hasPillow = spawnSync(python, ["-c", "import PIL"], { encoding: "utf8" }).status === 0;
    const illusCheck = spawnSync(python, ["-c", [
      "import sys, json, pathlib",
      "sys.path.insert(0, sys.argv[1])",
      "import scene_illus as SI",
      "px = SI.compute_freestyle_px(1800, 183.0, 0.75)",
      "assert 2.0 <= px <= 3.2, px",
      ...(hasPillow ? [] : ["sys.exit(0)"]),
      "from PIL import Image, ImageDraw",
      "d = pathlib.Path(sys.argv[2])",
      "im_empty = Image.new('RGBA', (200, 200), (0, 0, 0, 0)); p_empty = d / 'empty.png'; im_empty.save(p_empty)",
      "r_empty = SI.check_render_image(p_empty)",
      "assert any('empty_render' in w for w in r_empty['warnings']), r_empty",
      "im_clip = Image.new('RGBA', (200, 200), (0, 0, 0, 0)); ImageDraw.Draw(im_clip).rectangle([0, 40, 150, 160], fill=(30, 80, 130, 255)); p_clip = d / 'clip.png'; im_clip.save(p_clip)",
      "r_clip = SI.check_render_image(p_clip)",
      "assert any('edge_clipped(left)' in w for w in r_clip['warnings']), r_clip",
      "sc = SI.write_anchor_sidecar(p_clip, {'we_tip': [0.5, 0.4]}, (200, 200), 183.0)",
      "assert json.loads(sc.read_text())['anchors']['we_tip'] == [0.5, 0.4]",
    ].join("\n"), resolve("src-tauri/resources/skills/blender-research/scripts"), root], { encoding: "utf8" });
    assert.equal(illusCheck.status, 0, illusCheck.stderr);
    result=run(resolve("src-tauri/resources/skills/origin-plot/scripts/plot_origin.py"),["--probe"]);
    assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).readyToExecute,false);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("两份域稿支持 {#sec-}/@sec- 章节交叉引用、ΔG~H\\*~ 下标与 H* 自由基、紧邻编号列表分段及拦截报告口径（2026-11-15 HER 定稿审计实证）", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-sec-sub-list-"));
  const zoteroDocx = resolve("src-tauri/resources/skills/zotero-sync/scripts/zotero_docx.py");
  try {
    const bib = join(root, "references.bib");
    writeFileSync(
      bib,
      "@article{Huang2027,\n title={Balanced interfacial charge}, author={Huang, Kai}, year={2027}, journal={Appl. Catal. B}, doi={10.1016/j.apcatb.2026.127635}, volume={TBD}\n}\n",
    );
    const md = join(root, "review-final.md");
    writeFileSync(
      md,
      [
        "---",
        'title: "HER Borides"',
        "---",
        "",
        "## Introduction {#sec-intro}",
        "",
        "As outlined in @sec-mech and Section @sec-intro, H~2~O* → TS → H* + OH* feeds adsorbed H* onto a site with ΔG~H\\*~ ≈ 0 eV [@Huang2027].",
        "",
        "## Mechanisms {#sec-mech}",
        "",
        "### Dual-site division {#sec-dual}",
        "",
        "See Sec. @sec-dual for ΔG~H\\*~ comparisons:",
        "1. **Paired condition reporting**: report electrolyte and iR.",
        "2. **Intrinsic turnover**: pair geometric overpotential with ECSA.",
        "",
        "## Declarations {.unnumbered}",
        "",
        "Pending author confirmation.",
      ].join("\n"),
    );
    const enOut = join(root, "endnote.docx");
    const zoOut = join(root, "zotero.docx");
    const enRep = join(root, "en-report.md");
    const zoRep = join(root, "zo-report.md");
    const rEn = run(citeDocx, ["--input", md, "--bib", bib, "--output", enOut, "--report", enRep]);
    assert.equal(rEn.status, 0, rEn.stderr);
    const rZo = run(zoteroDocx, ["--input", md, "--bib", bib, "--output", zoOut, "--report", zoRep]);
    assert.equal(rZo.status, 0, rZo.stderr);

    for (const docx of [enOut, zoOut]) {
      const xml = zipXml(docx).stdout;
      assert.doesNotMatch(xml, /\{#sec-|@sec-|~H\*~/);
      assert.match(xml, />1 Introduction</);
      assert.match(xml, />2 Mechanisms</);
      assert.match(xml, />2\.1 Dual-site division</);
      assert.match(xml, />Declarations</);
      assert.match(xml, /As outlined in Section 2 and Section 1/);
      assert.match(xml, /See Section 2\.1 for /);
      // H* 自由基星号保留，不把两处 H* 之间的正文吞成斜体
      assert.match(xml, /H\* \+ OH\* feeds adsorbed H\* onto a site with ΔG/);
      // ΔG~H\*~ 渲成下标 H*
      assert.match(xml, /<w:vertAlign w:val="subscript" \/><\/w:rPr><w:t>H\*<\/w:t>/);
      // 紧邻 1. / 2. 各自独立成段，不粘成一段
      const paras = [...xml.matchAll(/<w:p\b.*?<\/w:p>/gs)].map((m) =>
        [...m[0].matchAll(/<w:t[^>]*>(.*?)<\/w:t>/gs)].map((t) => t[1]).join(""),
      );
      assert.equal(paras.filter((p) => p.startsWith("1. Paired condition")).length, 1);
      assert.equal(paras.filter((p) => p.startsWith("2. Intrinsic turnover")).length, 1);
    }
    // volume={TBD} 占位符已被 bridge.load 剔除，不进 traveling library
    assert.doesNotMatch(fldData(enOut).stdout, /TBD/);

    // 残留 {Author, 2020} 拒写 docx 时，报告须如实写明未写 docx，不得误报「打开 output/endnote.docx」
    const dirtyMd = join(root, "dirty.md");
    writeFileSync(dirtyMd, "## Intro\n\nLeftover {Huang, 2027} temp cite [@Huang2027].\n");
    const dirtyDocx = join(root, "dirty.docx");
    const dirtyRep = join(root, "dirty-report.md");
    const rDirty = run(citeDocx, ["--input", dirtyMd, "--bib", bib, "--output", dirtyDocx, "--report", dirtyRep]);
    assert.notEqual(rDirty.status, 0);
    assert.equal(existsSync(dirtyDocx), false);
    const dirtyReportText = readFileSync(dirtyRep, "utf8");
    assert.match(dirtyReportText, /未写 docx/);
    assert.doesNotMatch(dirtyReportText, /打开 `output\/endnote\.docx`/);

    // 催化/材料正文里的晶面族 {110}、{001} 不拦出稿，保持 ASCII 原文并在报告里给出 EndNote「全部忽略」提示（2026-11-16 实证）
    const facetMd = join(root, "facet.md");
    writeFileSync(facetMd, "## Facets\n\nOn {110} and {001} facets of MoB2 [@Huang2027].\n");
    const facetDocx = join(root, "facet.docx");
    const facetRep = join(root, "facet-report.md");
    const rFacet = run(citeDocx, ["--input", facetMd, "--bib", bib, "--output", facetDocx, "--report", facetRep]);
    assert.equal(rFacet.status, 0, rFacet.stderr);
    assert.match(zipXml(facetDocx).stdout, /on \{110\} and \{001\} facets/i);
    const facetReportText = readFileSync(facetRep, "utf8");
    assert.match(facetReportText, /`\{110\}`、`\{001\}`/);
    assert.match(facetReportText, /全部忽略/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("EndNote 多课题共用个人库：同 DOI 跨群组重复按本课题群组唯一消歧，同群组内重复仍不猜（2026-11-23 实证）", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-en-group-"));
  try {
    const project = join(root, "硼化物析氢");
    mkdirSync(join(project, "papers"), { recursive: true });
    const enl = join(root, "我的 EndNote 个人图书馆.enl");
    const seed = `
import sqlite3, struct, sys
enl = sys.argv[1]
c = sqlite3.connect(enl)
c.execute("CREATE TABLE misc(code INTEGER, subcode INTEGER, value BLOB, PRIMARY KEY(code, subcode))")
c.execute("INSERT INTO misc VALUES (14, 0, ?)", (b"groupdbid0001",))
c.execute("CREATE TABLE refs(id INTEGER PRIMARY KEY, trash_state INTEGER NOT NULL DEFAULT 0, electronic_resource_number TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', year TEXT NOT NULL DEFAULT '', added_to_library INTEGER)")
# 跨课题重复：1496 在旧课题 HER催化综述，1544 在本课题 硼化物析氢
c.execute("INSERT INTO refs VALUES (1496, 0, '10.1002/adfm.201906481', 'Metal Boride Review', '2019', 1794763156)")
c.execute("INSERT INTO refs VALUES (1544, 0, '10.1002/adfm.201906481', 'Metal Boride Review', '2020', 1795414244)")
# 同一课题群组里也重复了两条：必须仍保持未绑定（不猜）
c.execute("INSERT INTO refs VALUES (1550, 0, '10.1000/same-group-dup', 'Twice In Group', '2025', 1795414245)")
c.execute("INSERT INTO refs VALUES (1551, 0, '10.1000/same-group-dup', 'Twice In Group', '2025', 1795414246)")
c.execute("CREATE TABLE groups(group_id INTEGER PRIMARY KEY, recs_stamp INTEGER, spec BLOB, members BLOB)")
def pack_members(ids):
    return b"\\x00\\x00\\x00\\x02" + struct.pack("<I", len(ids)) + (struct.pack(f"<{len(ids)}I", *ids) if ids else b"")
c.execute("INSERT INTO groups VALUES (7, 0, ?, ?)", (
    '<?xml version="1.0" encoding="UTF-8"?><group version="1"><ids><name>HER催化综述</name></ids><rules><rule>TYPE;3</rule></rules></group>'.encode("utf-8"),
    pack_members([1496]),
))
c.execute("INSERT INTO groups VALUES (8, 0, ?, ?)", (
    '<?xml version="1.0" encoding="UTF-8"?><group version="1"><ids><name>硼化物析氢</name></ids><rules><rule>TYPE;3</rule></rules></group>'.encode("utf-8"),
    pack_members([1544, 1550, 1551]),
))
c.commit()
c.close()
`;
    const seeded = spawnSync(python, ["-c", seed, enl], { encoding: "utf8" });
    assert.equal(seeded.status, 0, seeded.stderr);
    writeFileSync(join(project, "papers", "endnote-library.path"), `${enl}\n`);
    const md = join(project, "review-final.md");
    const bib = join(project, "references.bib");
    writeFileSync(md, "See [@Gupta2020] and [@Twice2025].\n");
    writeFileSync(
      bib,
      [
        "@article{Gupta2020, title={Metal Boride Review}, author={Gupta, Suraj}, year={2020}, doi={10.1002/adfm.201906481}}",
        "@article{Twice2025, title={Twice In Group}, author={Roe, Ann}, year={2025}, doi={10.1000/same-group-dup}}",
        "",
      ].join("\n"),
    );
    const docx = join(project, "endnote.docx");
    const report = join(project, "report.md");
    const res = run(citeDocx, [
      "--input",
      md,
      "--bib",
      bib,
      "--output",
      docx,
      "--report",
      report,
      "--project-root",
      project,
    ]);
    assert.equal(res.status, 0, res.stderr);
    const fld = fldData(docx).stdout;
    assert.match(
      fld,
      /<rec-number>1544<\/rec-number><foreign-keys><key app="EN" db-id="groupdbid0001" timestamp="1795414244">1544<\/key>/,
    );
    assert.doesNotMatch(fld, /<rec-number>1496<\/rec-number>|<rec-number>1550<\/rec-number>|<rec-number>1551<\/rec-number>/);
    const reportText = readFileSync(report, "utf8");
    assert.match(reportText, /已绑定 1 条/);
    assert.match(reportText, /已按课题群组「硼化物析氢」精确对应/);
    assert.match(reportText, /Twice2025.*2 条，未绑定/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("两份域稿复用已有 References 标题与 ::: {#refs} 槽位，不出双 References 和字面 ::: refs :::（2026-11-23 实证）", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-refs-div-"));
  const zoteroDocx = resolve("src-tauri/resources/skills/zotero-sync/scripts/zotero_docx.py");
  try {
    const bib = join(root, "references.bib");
    writeFileSync(
      bib,
      "@article{Doe2025,\n title={Boride catalysts}, author={Doe, Jane}, year={2025}, journal={J. Catal.}, doi={10.1000/boride}\n}\n",
    );
    const md = join(root, "review-final.md");
    writeFileSync(
      md,
      [
        "## Introduction",
        "",
        "Borides catalyze HER [@Doe2025].",
        "",
        "## References {.unnumbered}",
        "",
        "::: {#refs}",
        ":::",
      ].join("\n") + "\n",
    );
    const enOut = join(root, "endnote.docx");
    const zoOut = join(root, "zotero.docx");
    assert.equal(run(citeDocx, ["--input", md, "--bib", bib, "--output", enOut, "--report", join(root, "en.md")]).status, 0);
    assert.equal(run(zoteroDocx, ["--input", md, "--bib", bib, "--output", zoOut, "--report", join(root, "zo.md")]).status, 0);

    for (const [label, docx] of [["endnote", enOut], ["zotero", zoOut]] as const) {
      const xml = zipXml(docx, ["word/document.xml", "word/styles.xml"]).stdout;
      const refMatches = xml.match(/>References<\/w:t>/g) ?? [];
      assert.equal(refMatches.length, 1, `${label} 不得出现两个 References 标题`);
      assert.doesNotMatch(xml, /:::/, `${label} 不得残留字面 ::: refs :::`);
      // Heading2 也必须左对齐且首行缩进归零（不继承正文 2 字符缩进）
      assert.match(xml, /w:styleId="Heading2"[\s\S]*?<w:ind w:firstLine="0" w:firstLineChars="0"\/>/);
    }
    assert.match(zipXml(enOut).stdout, /ADDIN EN\.REFLIST/);

    // ::: {#refs} 后紧跟 Appendix 时，参考文献域留在原位（References 与 Appendix 之间）
    const mdApp = join(root, "with-appendix.md");
    writeFileSync(
      mdApp,
      [
        "## Intro",
        "",
        "See [@Doe2025].",
        "",
        "## References {.unnumbered}",
        "",
        "::: {#refs}",
        ":::",
        "",
        "## Appendix {.unnumbered}",
        "",
        "Extra table.",
      ].join("\n") + "\n",
    );
    const enApp = join(root, "en-app.docx");
    assert.equal(run(citeDocx, ["--input", mdApp, "--bib", bib, "--output", enApp, "--report", join(root, "en-app.md")]).status, 0);
    const appXml = zipXml(enApp).stdout;
    assert.equal((appXml.match(/>References<\/w:t>/g) ?? []).length, 1);
    assert.doesNotMatch(appXml, /:::/);
    assert.ok(appXml.indexOf("ADDIN EN.REFLIST") > appXml.indexOf(">References</w:t>"));
    assert.ok(appXml.indexOf("ADDIN EN.REFLIST") < appXml.indexOf(">Appendix</w:t>"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Zotero 多课题共用个人库：同 DOI 跨分类重复按最新课题分类唯一消歧，同分类内重复仍不猜（2026-11-23 实证）", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-zo-col-"));
  const zoteroDocx = resolve("src-tauri/resources/skills/zotero-sync/scripts/zotero_docx.py");
  try {
    const project = join(root, "硼化物析氢");
    mkdirSync(project, { recursive: true });
    const zdb = join(root, "zotero.sqlite");
    const seed = `
import sqlite3, sys
z = sqlite3.connect(sys.argv[1])
z.execute("CREATE TABLE settings(setting TEXT, key TEXT, value TEXT)")
z.execute("INSERT INTO settings VALUES ('account', 'userID', '123456')")
z.execute("CREATE TABLE libraries(libraryID INTEGER PRIMARY KEY, type TEXT)")
z.execute("INSERT INTO libraries VALUES (1, 'user')")
z.execute("CREATE TABLE items(itemID INTEGER PRIMARY KEY, libraryID INTEGER, key TEXT)")
z.execute("CREATE TABLE fields(fieldID INTEGER PRIMARY KEY, fieldName TEXT)")
z.execute("CREATE TABLE itemDataValues(valueID INTEGER PRIMARY KEY, value TEXT)")
z.execute("CREATE TABLE itemData(itemID INTEGER, fieldID INTEGER, valueID INTEGER)")
z.execute("CREATE TABLE deletedItems(itemID INTEGER)")
z.execute("CREATE TABLE collections(collectionID INTEGER PRIMARY KEY, collectionName TEXT, libraryID INTEGER)")
z.execute("CREATE TABLE collectionItems(collectionID INTEGER, itemID INTEGER)")
z.execute("INSERT INTO fields VALUES (1, 'DOI')")
# 旧课题 HER催化综述 里的副本 + 本课题第一次同步 + 本课题最新带时间戳同步
z.execute("INSERT INTO collections VALUES (9, 'HER催化综述', 1)")
z.execute("INSERT INTO collections VALUES (14, '硼化物析氢', 1)")
z.execute("INSERT INTO collections VALUES (15, '硼化物析氢 2026/11/23 14:10:15', 1)")
z.execute("INSERT INTO items VALUES (1, 1, 'OLDHER01')")
z.execute("INSERT INTO items VALUES (2, 1, 'BORIDE14')")
z.execute("INSERT INTO items VALUES (3, 1, 'BORIDE15')")
z.execute("INSERT INTO items VALUES (4, 1, 'DUPCOL1A')")
z.execute("INSERT INTO items VALUES (5, 1, 'DUPCOL1B')")
z.execute("INSERT INTO itemDataValues VALUES (1, '10.1002/adfm.201906481')")
z.execute("INSERT INTO itemDataValues VALUES (2, '10.1000/same-col-dup')")
for iid in (1, 2, 3):
    z.execute("INSERT INTO itemData VALUES (?, 1, 1)", (iid,))
for iid in (4, 5):
    z.execute("INSERT INTO itemData VALUES (?, 1, 2)", (iid,))
z.execute("INSERT INTO collectionItems VALUES (9, 1)")
z.execute("INSERT INTO collectionItems VALUES (14, 2)")
z.execute("INSERT INTO collectionItems VALUES (15, 3)")
z.execute("INSERT INTO collectionItems VALUES (15, 4)")
z.execute("INSERT INTO collectionItems VALUES (15, 5)")
z.commit()
z.close()
`;
    assert.equal(spawnSync(python, ["-c", seed, zdb], { encoding: "utf8" }).status, 0);
    const md = join(project, "review-final.md");
    const bib = join(project, "references.bib");
    writeFileSync(md, "See [@Gupta2020] and [@Twice2025].\n");
    writeFileSync(
      bib,
      [
        "@article{Gupta2020, title={Metal Boride Review}, author={Gupta, Suraj}, year={2020}, doi={10.1002/adfm.201906481}}",
        "@article{Twice2025, title={Same Col Dup}, author={Roe, Ann}, year={2025}, doi={10.1000/same-col-dup}}",
        "",
      ].join("\n"),
    );
    const out = join(project, "zotero.docx");
    const rep = join(project, "report.md");
    const res = run(zoteroDocx, [
      "--input",
      md,
      "--bib",
      bib,
      "--output",
      out,
      "--report",
      rep,
      "--zotero-db",
      zdb,
      "--project-root",
      project,
    ]);
    assert.equal(res.status, 0, res.stderr);
    const xml = zipXml(out).stdout;
    assert.match(xml, /users\/123456\/items\/BORIDE15/);
    assert.doesNotMatch(xml, /OLDHER01|BORIDE14|DUPCOL1A|DUPCOL1B/);
    assert.match(xml, /embed000/);
    const repText = readFileSync(rep, "utf8");
    assert.match(repText, /已绑定 1 条/);
    assert.match(repText, /已按课题分类「硼化物析氢 2026\/11\/23 14:10:15」精确对应/);
    assert.match(repText, /Twice2025.*2 条，未绑定/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("两份域稿表格：保留转义竖线 \\| 不拆裂列数，单元格走 TableCell 零缩进 9pt 并按内容分列宽（2026-11-23 实证）", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-table-pipe-"));
  const zoteroDocx = resolve("src-tauri/resources/skills/zotero-sync/scripts/zotero_docx.py");
  try {
    const bib = join(root, "references.bib");
    writeFileSync(
      bib,
      "@article{Wang2026,\n title={AEMWE}, author={Wang, Li}, year={2026}, journal={Chem. Sci.}, doi={10.1000/aemwe}\n}\n",
    );
    const md = join(root, "review-final.md");
    writeFileSync(
      md,
      [
        "| Cathode \\|\\| Anode | Operating conditions and electrolyte protocol | Durability | Post-operation boron and metal audit | Ref |",
        "|---|---|---|---|---|",
        "| Os/TaB~2~ \\|\\| NiFe LDH | 1.0 M KOH / 80 °C / 4 cm^2^ zero-gap AEMWE | >230 h @ 1.0 A cm^−2^ | Not reported in primary main text (SI not verified) | [@Wang2026] |",
        "| A-NiCoB/NF | 1.0 M KOH / RT / 3E half-cell | >300 h @ 0.5 A cm^−2^ | 120 h ICP: B 0.29 mmol L^−1^ + depth XPS | [@Wang2026] |",
        "",
        ": AEMWE benchmark. {#tbl-1}",
      ].join("\n") + "\n",
    );
    for (const [label, script] of [["endnote", citeDocx], ["zotero", zoteroDocx]] as const) {
      const out = join(root, `${label}.docx`);
      const res = run(script, ["--input", md, "--bib", bib, "--output", out, "--report", join(root, `${label}.md`)]);
      assert.equal(res.status, 0, res.stderr);
      const xml = zipXml(out, ["word/document.xml", "word/styles.xml"]).stdout;
      // 保留为 5 列而非因 \|\| 裂成 7 列，且正文不残留反斜杠
      const grid = xml.match(/<w:tblGrid>[\s\S]*?<\/w:tblGrid>/)?.[0] ?? "";
      const widths = [...grid.matchAll(/w:w="(\d+)"/g)].map((m) => Number(m[1]));
      assert.equal(widths.length, 5, `${label} 表格应保持 5 列而非被 \\| 拆裂`);
      assert.equal(widths.reduce((a, b) => a + b, 0), 9026, `${label} 表格总宽应对齐 A4 栏宽 9026 dxa`);
      assert.ok(widths[1] > widths[4], `${label} 长文字列应宽于短引用列：${widths.join(", ")}`);
      assert.match(xml, /Cathode \|\| Anode/, `${label} 应还原字面 ||`);
      assert.match(xml, /Os\/TaB.*\|\| NiFe LDH/, `${label} 数据行应还原字面 ||`);
      assert.doesNotMatch(xml, /Cathode \\/, `${label} 不得残留反斜杠`);
      assert.match(xml, /w:pStyle w:val="TableCell"/, `${label} 单元格须套 TableCell 样式`);
      assert.match(xml, /w:styleId="TableCell"[\s\S]*?w:firstLine="0" w:firstLineChars="0"[\s\S]*?w:sz w:val="18"/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
