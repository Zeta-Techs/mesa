import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  isManuscriptBody,
  isManuscriptHelper,
  MANUSCRIPT_HELPER_NAMES,
  manuscriptSourcePath,
} from "../src/manuscript-files.ts";

// 写作配套文件名单只认 fixture：Mesa 前端、mesa_checks.py、cite_check.py 三份必须逐条一致
// （2026-11-11：七处各自一份名单、互相对不上，一天冒出三处「写作规范当稿件」的误报）
const fixture: string[] = JSON.parse(readFileSync("tests/fixtures/manuscript-helpers.json", "utf8")).helpers;

function pyTuple(path: string): string[] {
  const text = readFileSync(path, "utf8");
  const m = text.match(/MANUSCRIPT_HELPERS = \(([\s\S]*?)\)/);
  assert.ok(m, `${path} 里找不到 MANUSCRIPT_HELPERS`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

test("三份名单与 fixture 逐条一致", () => {
  assert.deepEqual([...MANUSCRIPT_HELPER_NAMES], fixture);
  assert.deepEqual(pyTuple("src-tauri/resources/mesa_checks.py"), fixture);
  assert.deepEqual(pyTuple("src-tauri/resources/skills/bib-check/scripts/cite_check.py"), fixture);
});

test("用公共模块的脚本不再自带名单", () => {
  for (const path of [
    "src-tauri/resources/skills/research-writing/scripts/ms_check.py",
    "src-tauri/resources/skills/research-writing/scripts/num_check.py",
  ]) {
    const text = readFileSync(path, "utf8");
    assert.match(text, /SKIP = C\.MANUSCRIPT_HELPER_RE/, path);
    assert.doesNotMatch(text, /SKIP = re\.compile/, path);
  }
  assert.match(
    readFileSync("src-tauri/resources/skills/bib-check/scripts/cite_check.py", "utf8"),
    /SKIP_MANUSCRIPT = re\.compile\(\s*"\(" \+ "\|"\.join\(MANUSCRIPT_HELPERS\)/,
  );
});

test("配套文件与正文：写作规范、章节状态、修改记录不算正文", () => {
  for (const p of ["manuscript/style-sheet.md", "manuscript/section-status.md", "manuscript/changelog.md", "manuscript/typeface.md", "manuscript/outline.md", "manuscript/README.md"]) {
    assert.ok(isManuscriptHelper(p), p);
    assert.ok(!isManuscriptBody(p), p);
  }
  for (const p of ["manuscript/draft.md", "manuscript/review-final.md", "manuscript/chapters/02-methods.tex", "proposal/proposal.md"]) {
    assert.ok(isManuscriptBody(p), p);
  }
  assert.ok(!isManuscriptBody("notes/01-a.md"));
});

test("挑主稿按名字，不按传进来的顺序；没有正文时退回大纲", () => {
  assert.equal(
    manuscriptSourcePath(["manuscript/changelog.md", "manuscript/section-status.md", "manuscript/draft.md"]),
    "manuscript/draft.md",
  );
  assert.equal(manuscriptSourcePath(["manuscript/style-sheet.md", "manuscript/sections.json", "outline.md"]), "outline.md");
  assert.equal(manuscriptSourcePath(["manuscript/sections/02-b.md", "manuscript/sections/01-a.md"]), "manuscript/sections/01-a.md");
  assert.equal(manuscriptSourcePath(["papers/screening.md", "TASK.md"]), null);
});
