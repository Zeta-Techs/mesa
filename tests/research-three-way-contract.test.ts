import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import dirtyCases from "./fixtures/research-dirty-cases.json" with { type: "json" };
import { checkDraft } from "../src/draft-check.ts";
import { missingToFetchCount, parseToFetchItems } from "../src/step-flow.ts";

const PY = process.platform === "win32" ? "python" : "python3";
const CITE_CHECK = resolve("src-tauri/resources/skills/bib-check/scripts/cite_check.py");
const LIT_RECORDS = resolve("src-tauri/resources/skills/lit-search/scripts/lit_records.py");

function hasPython3(): boolean {
  try {
    execFileSync(PY, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("三端脏数据契约：化学式 @ 与真引用在 TS draft-check 与 Python cite_check.py 上完全一致", (t) => {
  if (!hasPython3()) {
    t.skip("python3 不可用");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "mesa-dirty-cite-"));
  try {
    mkdirSync(join(dir, "manuscript"), { recursive: true });
    writeFileSync(join(dir, "references.bib"), dirtyCases.citations.bib, "utf8");
    writeFileSync(join(dir, "manuscript/draft.md"), dirtyCases.citations.markdown, "utf8");

    // 1. TS 前端 draft-check
    const tsItems = checkDraft({
      file: "manuscript/draft.md",
      text: dirtyCases.citations.markdown,
      bib: dirtyCases.citations.bib,
      kind: "writing",
    });
    const tsMissing = tsItems
      .filter((it) => it.kind === "citation_resolve")
      .map((it) => it.evidence?.source ?? it.title);
    assert.deepEqual(tsMissing, dirtyCases.citations.expectedMissing);

    // 2. Python bib-check/scripts/cite_check.py refs（离线写 .ccode/checks/cite-refs.jsonl）
    const pyRun = spawnSync(
      PY,
      [CITE_CHECK, "refs", "--root", dir, "--offline", "--manuscript", "manuscript/draft.md"],
      { cwd: dir, encoding: "utf8", timeout: 60_000 },
    );
    assert.equal(pyRun.status, 1, pyRun.stderr + pyRun.stdout);
    const pyRows = readFileSync(join(dir, ".ccode/checks/cite-refs.jsonl"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id: string; status: string });
    const pyMissing = pyRows
      .filter((r) => r.status === "blocked" && r.id.startsWith("REF-"))
      .map((r) => r.id.slice("REF-".length));
    assert.deepEqual(pyMissing, dirtyCases.citations.expectedMissing);
    assert.deepEqual(tsMissing, pyMissing);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("三端脏数据契约：to-fetch.md 的 ✓ / [已补] / [跳过] / [仅摘要] / 分隔线在 TS 与 Python 上完全一致", (t) => {
  if (!hasPython3()) {
    t.skip("python3 不可用");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "mesa-dirty-fetch-"));
  try {
    const fetchPath = join(dir, "to-fetch.md");
    writeFileSync(fetchPath, dirtyCases.toFetch.markdown, "utf8");

    // 1. TS 前端 parseToFetchItems & missingToFetchCount
    const tsItems = parseToFetchItems(dirtyCases.toFetch.markdown);
    assert.equal(tsItems.length, dirtyCases.toFetch.expectedCount);
    assert.deepEqual(
      tsItems.map((i) => i.done),
      dirtyCases.toFetch.expectedDoneFlags,
    );
    assert.equal(
      missingToFetchCount(dirtyCases.toFetch.markdown, {}),
      dirtyCases.toFetch.expectedMissingWithoutExtraSkips,
    );

    // 2. Python lit_records.read_previous_fetch
    const pyOut = execFileSync(
      PY,
      [
        "-c",
        `import importlib.util, json, pathlib, sys
spec = importlib.util.spec_from_file_location("lr", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
rows = mod.read_previous_fetch(pathlib.Path(sys.argv[2]))
print(json.dumps([{"n": n, "done": d, "body": b} for n, d, b in rows], ensure_ascii=False))`,
        LIT_RECORDS,
        fetchPath,
      ],
      { encoding: "utf8" },
    );
    const pyRows = JSON.parse(pyOut) as { n: number; done: boolean; body: string }[];
    assert.equal(pyRows.length, dirtyCases.toFetch.expectedCount);
    assert.deepEqual(
      pyRows.map((r) => r.done),
      dirtyCases.toFetch.expectedDoneFlags,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lit_records.py pdfs --json：统一输出 Zotero 外部绝对路径、bibKey 与 source，不把纯 SI 误认正文", (t) => {
  if (!hasPython3()) {
    t.skip("python3 不可用");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "mesa-dirty-pdfs-"));
  const zoteroDir = mkdtempSync(join(tmpdir(), "mesa-fake-zotero-"));
  try {
    mkdirSync(join(dir, "papers"), { recursive: true });
    const zoteroPdf = join(zoteroDir, "Boride-HER-Zotero.pdf");
    writeFileSync(zoteroPdf, "%PDF-1.4\n% minimal fake pdf\n", "utf8");
    const included = [
      {
        id: "W1",
        bibKey: "Zot2024",
        title: "Boride HER from Zotero",
        decision: "included",
        pdf: zoteroPdf,
      },
      {
        id: "W2",
        bibKey: "Miss2025",
        title: "Missing Paper Without PDF",
        decision: "included",
      },
    ];
    writeFileSync(join(dir, "papers/included.json"), JSON.stringify(included, null, 2), "utf8");
    const stdout = execFileSync(
      PY,
      [LIT_RECORDS, "pdfs", "--root", dir, "--json", join(dir, "papers/included.json")],
      { encoding: "utf8" },
    );
    const payload = JSON.parse(stdout) as {
      found: { id: string; bibKey?: string; source: string; absPath: string }[];
      missing: { id: string; bibKey?: string }[];
    };
    assert.equal(payload.found.length, 1);
    assert.equal(payload.found[0].id, "W1");
    assert.equal(payload.found[0].bibKey, "Zot2024");
    assert.equal(payload.found[0].source, "zotero");
    assert.ok(payload.found[0].absPath.endsWith("Boride-HER-Zotero.pdf"));
    assert.equal(payload.missing.length, 1);
    assert.equal(payload.missing[0].bibKey, "Miss2025");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(zoteroDir, { recursive: true, force: true });
  }
});

test("lit_records.py table / validate / extract-text：宽表按 bibKey 精确读写并转义 |，一键校验兼容字符串 year 与跨项目根 PDF", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-lit-root-"));
  const wt = mkdtempSync(join(tmpdir(), "mesa-lit-wt-"));
  try {
    mkdirSync(join(root, "papers"), { recursive: true });
    mkdirSync(join(wt, "papers"), { recursive: true });
    mkdirSync(join(wt, "notes"), { recursive: true });
    writeFileSync(join(root, "papers", "Xu2025-Boride.pdf"), "%PDF-1.4\n%%EOF\n", "utf8");
    const included = [
      { id: "W1", bibKey: "Xu2025", title: "Boride HER", year: "2025", decision: "included", kind: "research" },
      { id: "W2", bibKey: "Rev2024", title: "Boride Review", year: 2024, decision: "included", kind: "review" },
    ];
    writeFileSync(join(wt, "papers/included.json"), JSON.stringify(included, null, 2), "utf8");
    writeFileSync(
      join(wt, "notes/index.json"),
      JSON.stringify([
        { id: "W1", bibKey: "Xu2025", fulltextStatus: "fulltext", reviewStatus: "pending", skimmed: true, notePath: "" },
        { id: "W2", bibKey: "Rev2024", fulltextStatus: "fulltext", reviewStatus: "reviewed", notePath: "notes/01-Rev.md" },
      ], null, 2),
      "utf8",
    );
    writeFileSync(
      join(wt, "notes/01-Rev.md"),
      "# Boride Review\n\n> 来源 PDF：papers/Xu2025-Boride.pdf\n综述 · 全文\n\n## 一句话总结\n测试内容足够二十个字符以上。\n",
      "utf8",
    );
    writeFileSync(
      join(wt, "notes/skim.md"),
      "# 速读表\n\n| 键 | 年份 | 主要结论 | 全文 |\n|---|---|---|---|\n| @Xu2025 | 2025 | 旧摘要结论 | 无 |\n",
      "utf8",
    );
    writeFileSync(
      join(wt, "references.bib"),
      "@article{Xu2025,\n  title = {Boride HER},\n  year = {2025},\n  abstract = {Real abstract},\n}\n\n@article{Rev2024,\n  title = {Boride Review},\n  year = {2024},\n  abstract = {Review abstract},\n}\n",
      "utf8",
    );

    // 1. table --upsert 自动转义单元格中的 |ΔG_H|，不破坏列数
    const patchFile = join(wt, "patch.json");
    writeFileSync(
      patchFile,
      JSON.stringify([{ bibKey: "Xu2025", columns: { 主要结论: "按全文更新：|ΔG_H*|=0.08 eV", 全文: "有" } }]),
      "utf8",
    );
    const upOut = execFileSync(PY, [LIT_RECORDS, "table", "--file", join(wt, "notes/skim.md"), "--upsert", patchFile], {
      encoding: "utf8",
    });
    assert.deepEqual(JSON.parse(upOut).updated, ["Xu2025"]);

    const getOut = execFileSync(PY, [LIT_RECORDS, "table", "--file", join(wt, "notes/skim.md"), "--get", "Xu2025"], {
      encoding: "utf8",
    });
    const got = JSON.parse(getOut) as { rows: { bibKey: string; columns: Record<string, string> }[] };
    assert.equal(got.rows.length, 1);
    assert.equal(got.rows[0].columns["全文"], "有");
    assert.match(got.rows[0].columns["主要结论"], /\\\|ΔG_H\*\\\|=0\.08 eV/);

    // 2. validate 在 worktree（papers/ 下无 PDF）通过 MESA_PROJECT_ROOT 自动定位项目根 papers/ 并通过全部校验
    const valOut = execFileSync(PY, [LIT_RECORDS, "validate", "--json-out"], {
      cwd: wt,
      env: { ...process.env, MESA_PROJECT_ROOT: root },
      encoding: "utf8",
    });
    const summary = JSON.parse(valOut) as { ok: boolean; errors: string[]; included: number };
    assert.equal(summary.ok, true, `unexpected validate errors: ${summary.errors.join("; ")}`);
    assert.equal(summary.included, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
});
