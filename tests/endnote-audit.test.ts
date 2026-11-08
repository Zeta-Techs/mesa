import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// 已有 Word + EndNote 稿件的只读体检（endnote-bridge/scripts/audit_docx.py，2026-11-08）：
// 只读 docx、不改引文域；结果写成 Mesa 核验项三档，外加「在 EndNote 里怎么改」清单。
const python = process.platform === "win32" ? "python" : "python3";
const script = resolve("src-tauri/resources/skills/endnote-bridge/scripts/audit_docx.py");
const run = (args: string[], cwd: string) => spawnSync(python, [script, ...args], { cwd, encoding: "utf8", timeout: 60_000 });

// 按 JSON 规格拼一份最小 docx：引文域两种存法（fldData 双域 / 指令内联）、LF 与截断的坏域、参考文献表、标黄、修订、批注
const BUILDER = String.raw`
import sys, json, zipfile, base64
spec = json.load(open(sys.argv[1], encoding="utf-8"))
W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
def esc(s): return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
def t(s, hl=False):
    rpr = '<w:rPr><w:highlight w:val="yellow"/></w:rPr>' if hl else ""
    return f'<w:r>{rpr}<w:t xml:space="preserve">{esc(s)}</w:t></w:r>'
def fc(kind, data=None):
    inner = f"<w:fldData>{data}</w:fldData>" if data is not None else ""
    return f'<w:r><w:fldChar w:fldCharType="{kind}">{inner}</w:fldChar></w:r>'
def instr(s): return f'<w:r><w:instrText xml:space="preserve">{esc(s)}</w:instrText></w:r>'
def cite_xml(r):
    authors = "".join(f"<author>{a}</author>" for a in r["au"])
    return (f'<Cite><Author>{r["au"][0].split(",")[0]}</Author><Year>{r["y"]}</Year><RecNum>{r["n"]}</RecNum>'
            f'<record><rec-number>{r["n"]}</rec-number><foreign-keys><key app="EN" db-id="{r.get("db", "DB1")}">{r["n"]}</key></foreign-keys>'
            f'<contributors><authors>{authors}</authors></contributors><titles><title>{r["t"]}</title></titles>'
            f'<dates><year>{r["y"]}</year></dates></record></Cite>')
def b64(payload, mode):
    data = base64.b64encode(payload.encode() + b"\0").decode()
    if mode == "trunc":
        data = "PA=="
    nl = "\n" if mode == "lf" else "\r\n"
    return nl.join(data[i:i + 76] for i in range(0, len(data), 76)) + nl
def cite(seg):
    payload = "<EndNote>" + "".join(cite_xml(r) for r in seg["cite"]) + "</EndNote>"
    mode = seg.get("mode", "fld")
    if mode == "inline":
        return fc("begin") + instr(" ADDIN EN.CITE " + payload) + fc("separate") + t(seg["show"]) + fc("end")
    fd = b64(payload, mode)
    return (fc("begin", fd) + instr(" ADDIN EN.CITE ") + fc("begin", fd) + instr(" ADDIN EN.CITE.DATA ") + fc("end")
            + fc("separate") + t(seg["show"]) + fc("end"))
paras = []
for p in spec["paras"]:
    if isinstance(p, dict) and "reflist" in p:
        ents = p["reflist"]
        for i, e in enumerate(ents):
            body = (fc("begin", "") + instr(" ADDIN EN.REFLIST ") + fc("separate") if i == 0 else "") + t(e) + (fc("end") if i == len(ents) - 1 else "")
            paras.append(f"<w:p>{body}</w:p>")
        continue
    body = ""
    for seg in p:
        if "cite" in seg: body += cite(seg)
        elif "ins" in seg: body += f'<w:ins w:id="9" w:author="{seg["by"]}" w:date="2026-11-08T00:00:00Z">{t(seg["ins"])}</w:ins>'
        elif "comment" in seg:
            body += f'<w:commentRangeStart w:id="0"/>{t(seg["on"])}<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>'
        else: body += t(seg["t"], seg.get("hl", False))
    paras.append(f"<w:p>{body}</w:p>")
doc = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {W}><w:body>{"".join(paras)}</w:body></w:document>'
with zipfile.ZipFile(sys.argv[2], "w") as z:
    z.writestr("[Content_Types].xml", "<Types/>")
    z.writestr("word/document.xml", doc.encode("utf-8"))
    z.writestr("docProps/core.xml", '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Old Owner</dc:creator><cp:lastModifiedBy>Old Owner</cp:lastModifiedBy></cp:coreProperties>')
    for p in spec["paras"]:
        for seg in (p if isinstance(p, list) else []):
            if "comment" in seg:
                z.writestr("word/comments.xml", f'<w:comments {W}><w:comment w:id="0" w:author="{seg["by"]}"><w:p>{t(seg["comment"])}</w:p></w:comment></w:comments>')
`;

interface Item {
  id: string;
  status: string;
  title: string;
  evidence?: { detail?: string };
}
const items = (root: string): Item[] =>
  readFileSync(join(root, ".ccode/checks/cite-docx.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
const byId = (list: Item[], id: string) => list.find((i) => i.id === id);
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

function makeDocx(spec: unknown) {
  const root = mkdtempSync(join(tmpdir(), "endnote-audit-"));
  const specPath = join(root, "spec.json");
  writeFileSync(specPath, JSON.stringify(spec));
  const docx = join(root, "audit.docx");
  const built = spawnSync(python, ["-c", BUILDER, specPath, docx], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  return { root, docx };
}

const R = {
  smith: { n: 1, au: ["Smith, John"], y: 2020, t: "Mg anodes" },
  lee: { n: 2, au: ["Lee, Ann", "Park, Bo"], y: 2021, t: "Sulfur hosts" },
  zhou: { n: 3, au: ["Zhou, Yi"], y: 2001, t: "Lattice relaxation" },
  brown: { n: 4, au: ["Brown, Carl"], y: 2019, t: "Electrolytes" },
};

test("cites：点名作者对号（含句中先插佐证引文）、两种存法、编号顺序、手写 Ref. N", () => {
  const { root, docx } = makeDocx({
    paras: [
      [{ t: "Smith et al. showed fast plating." }, { cite: [R.smith], show: "1", mode: "inline" }],
      [
        { t: "Lee and co-workers measured clusters (<3 nm)" },
        { cite: [R.zhou], show: "2" },
        { t: " and assigned them to MgS." },
        { cite: [R.lee], show: "3" },
      ],
      [{ t: "Wang et al. found a new phase." }, { cite: [R.brown], show: "4" }],
      [{ t: "Figure 1. Adapted from Ref. 3 with permission." }],
      { reflist: ["1. Smith", "2. Zhou", "3. Lee", "4. Brown"] },
    ],
  });
  try {
    const before = sha(docx);
    const r = run(["cites", docx, "--root", root], root);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.equal(sha(docx), before, "体检不得改动稿件");
    const list = items(root);
    assert.equal(byId(list, "FIELD-ALL")?.status, "passed");
    assert.equal(byId(list, "NAME-1")?.status, "passed");
    // 点名 Lee，紧跟的是佐证引文 Zhou，Lee 那篇在同一句后面：算对上，不拦
    assert.equal(byId(list, "NAME-3")?.status, "passed");
    assert.equal(byId(list, "NAME-2"), undefined);
    const wang = byId(list, "NAME-4");
    assert.equal(wang?.status, "blocked");
    assert.match(wang?.evidence?.detail ?? "", /Brown/);
    assert.equal(byId(list, "NUM-ORDER")?.status, "passed");
    assert.equal(byId(list, "BIB-COUNT"), undefined);
    assert.ok(list.some((i) => i.id.startsWith("HANDREF-4") && i.status === "needs_human"));
    const report = readFileSync(join(root, "output/endnote-audit.md"), "utf8");
    assert.match(report, /点名 Wang/);
    assert.match(report, /Edit & Manage Citation\(s\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cites：LF 换行与截断的域数据拦下，提示别再保存", () => {
  const { root, docx } = makeDocx({
    paras: [
      [{ t: "Plating is fast." }, { cite: [R.smith], show: "1", mode: "lf" }],
      [{ t: "Hosts matter." }, { cite: [R.lee], show: "2", mode: "trunc" }],
    ],
  });
  try {
    const r = run(["cites", docx, "--root", root], root);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    const list = items(root);
    assert.equal(byId(list, "FIELD-ALL"), undefined);
    assert.equal(byId(list, "FIELD-1")?.status, "blocked");
    assert.match(byId(list, "FIELD-1")?.evidence?.detail ?? "", /LF/);
    assert.equal(byId(list, "FIELD-2")?.status, "blocked");
    assert.match(byId(list, "FIELD-2")?.evidence?.detail ?? "", /截断/);
    assert.match(byId(list, "FIELD-2")?.evidence?.detail ?? "", /不要再在 Word 里保存/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cites：混用两个库、库内重复记录、一条域里篇数多于显示编号，都交人判断", () => {
  const other = { n: 1, au: ["Ding, Wei"], y: 2021, t: "Vacancy engineering", db: "DB2" };
  const dupA = { n: 7, au: ["Hacker, Jan"], y: 2025, t: "Interfacial processes of Mg anodes" };
  const dupB = { ...dupA, n: 9 };
  const { root, docx } = makeDocx({
    paras: [
      [{ t: "Plating is fast." }, { cite: [R.smith], show: "1" }],
      [{ t: "Vacancies help." }, { cite: [other], show: "2" }],
      [{ t: "Interfaces evolve." }, { cite: [dupA], show: "3" }],
      [{ t: "Interfaces evolve again." }, { cite: [dupB, R.brown], show: "4" }],
    ],
  });
  try {
    const r = run(["cites", docx, "--root", root], root);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const list = items(root);
    const db = list.find((i) => i.id.startsWith("DBID-"));
    assert.equal(db?.status, "needs_human");
    assert.match(db?.title ?? "", /DB2/);
    assert.equal(byId(list, "DUP-DB1-7-9")?.status, "needs_human");
    assert.equal(byId(list, "COUNT-4")?.status, "needs_human");
    assert.ok(list.every((i) => i.status !== "passed" || !/点名/.test(i.title)));
    const report = readFileSync(join(root, "output/endnote-audit.md"), "utf8");
    assert.match(report, /## EndNote 库记录/);
    assert.match(report, /来自另一个库/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("marks：列出标黄、修订、批注和留下的名字，Word 开着时提醒另存", () => {
  const { root, docx } = makeDocx({
    paras: [
      [{ t: "Plain start. " }, { t: "Check this claim.", hl: true }],
      [{ t: "Some text " }, { ins: "inserted words", by: "Reviewer A" }],
      [{ comment: "Too vague", on: "this phrase", by: "Reviewer B" }],
    ],
  });
  writeFileSync(join(root, "~$dit.docx"), "lock");
  try {
    const r = run(["marks", docx, "--root", root], root);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /标黄 1 处，修订 1 处，批注 1 条/);
    assert.match(r.stdout, /正在 Word 里打开/);
    const report = readFileSync(join(root, "output/docx-marks.md"), "utf8");
    assert.match(report, /第 1 段：Check this claim\./);
    assert.match(report, /Reviewer A 插入：inserted words/);
    assert.match(report, /第 3 段「this phrase」 Reviewer B：Too vague/);
    assert.match(report, /作者（creator）：Old Owner/);
    assert.match(report, /修订 \/ 批注署名：Reviewer A、Reviewer B/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
