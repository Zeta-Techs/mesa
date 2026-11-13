import assert from "node:assert/strict";
import test from "node:test";
import {
  deliveryContentPaths,
  deliveryFileGroup,
  deliveryProcessPaths,
  groupDeliveryFiles,
  preferredDeliveryPath,
  sortDeliveryPaths,
} from "../src/review-file-groups.ts";

test("精读与写作改动按笔记/稿件/引文分组", () => {
  assert.equal(deliveryFileGroup("notes/001-a.md"), "notes");
  assert.equal(deliveryFileGroup("notes/index.json"), "machine");
  assert.equal(deliveryFileGroup("references.bib"), "index");
  assert.equal(deliveryFileGroup("outline.md"), "manuscript");
  assert.equal(deliveryFileGroup("manuscript/draft.md"), "manuscript");
  assert.equal(deliveryFileGroup("manuscript/_quarto.yml"), "machine");
  assert.equal(deliveryFileGroup("manuscript/ieee.csl"), "machine");
  assert.equal(deliveryFileGroup("manuscript/.gitignore"), "machine");
  assert.equal(deliveryFileGroup("manuscript/screening.md"), "machine");
  assert.equal(deliveryFileGroup("output/site_libs/bootstrap.css"), "machine");
  assert.equal(deliveryFileGroup("output/_tex/draft.tex"), "machine");
  assert.equal(deliveryFileGroup("survey/gap-analysis.md"), "manuscript");
  assert.equal(deliveryFileGroup("submission/formatted.md"), "manuscript");
  assert.equal(deliveryFileGroup("rebuttal/response-letter-r1.md"), "manuscript");
  assert.equal(deliveryFileGroup("papers/to-fetch.md"), "fetch");
  assert.equal(deliveryFileGroup("scripts/build.py"), "other");
  assert.equal(deliveryFileGroup(".ccode/help-wanted.md"), "machine");
  assert.equal(deliveryFileGroup("help-wanted.md"), "machine");
  assert.equal(deliveryFileGroup("papers/a.pdf"), "other");

  const paths = [
    "scripts/x.py",
    "references.bib",
    "notes/index.json",
    "notes/002.md",
    "manuscript/draft.md",
    "papers/to-fetch.md",
  ];
  assert.deepEqual(sortDeliveryPaths(paths), [
    "notes/002.md",
    "manuscript/draft.md",
    "references.bib",
    "papers/to-fetch.md",
    "scripts/x.py",
    "notes/index.json",
  ]);
  assert.deepEqual(
    groupDeliveryFiles(paths.map((path) => ({ path }))).map((g) => g.id),
    ["notes", "manuscript", "index", "fetch", "other", "machine"],
  );
});

test("大纲审阅默认打开稿件，不把 help-wanted 摊在主面", () => {
  const files = [
    ".ccode/help-wanted.md",
    "outline.md",
    "artifacts/outline_key_check.json",
  ];
  assert.equal(preferredDeliveryPath(files), "outline.md");
  assert.deepEqual(deliveryContentPaths(files), ["outline.md"]);
  assert.deepEqual(deliveryProcessPaths(files), [".ccode/help-wanted.md"]);
  assert.equal(
    preferredDeliveryPath([".ccode/help-wanted.md", "notes/001.md"]),
    "notes/001.md",
  );
  assert.equal(preferredDeliveryPath([".ccode/help-wanted.md"]), ".ccode/help-wanted.md");
  assert.equal(preferredDeliveryPath([]), null);
  assert.equal(
    preferredDeliveryPath(["output/draft.pdf", "manuscript/draft.md"]),
    "manuscript/draft.md",
  );
  assert.deepEqual(
    deliveryContentPaths([
      "output/formatted.pdf",
      "submission/formatted.md",
      ".ccode/help-wanted.md",
    ]),
    ["submission/formatted.md", "output/formatted.pdf"],
  );
  assert.deepEqual(
    deliveryContentPaths([
      "output/draft.pdf",
      "output/draft.docx",
      "manuscript/draft.md",
    ]),
    ["manuscript/draft.md", "output/draft.docx", "output/draft.pdf"],
  );
});

test("大纲审阅有笔记改动时仍先打开 outline.md", () => {
  const files = [
    "notes/001.md",
    ".ccode/help-wanted.md",
    "outline.md",
    "artifacts/outline_key_check.json",
  ];
  assert.equal(preferredDeliveryPath(files), "outline.md");
  assert.equal(deliveryContentPaths(files)[0], "outline.md");
});

test("写作审阅默认打开 draft.md，不把 _quarto.yml 当稿件", () => {
  const files = [
    "manuscript/_quarto.yml",
    "manuscript/.gitignore",
    ".geminiignore",
    "manuscript/draft.md",
    "manuscript/screening.md",
    "output/draft.docx",
    "output/draft.pdf",
  ];
  assert.equal(preferredDeliveryPath(files), "manuscript/draft.md");
  assert.deepEqual(deliveryContentPaths(files), [
    "manuscript/draft.md",
    "output/draft.docx",
    "output/draft.pdf",
  ]);
  assert.equal(deliveryFileGroup("manuscript/_quarto.yml"), "machine");
});

test("过程只放本步记录，脚本和缓存不进", () => {
  assert.equal(deliveryFileGroup("papers/screening.md"), "machine");
  assert.equal(deliveryFileGroup("manuscript/section-status.md"), "machine");
  assert.equal(deliveryFileGroup("manuscript/citation-check.md"), "machine");
  assert.equal(deliveryFileGroup("results/run-manifest.json"), "machine");
  assert.equal(deliveryFileGroup("cleaning/cleaned-data-manifest.md"), "machine");
  assert.equal(deliveryFileGroup("enrich_metadata.py"), "other");
  assert.equal(deliveryFileGroup("artifacts/api-cache/01.json"), "other");
  assert.deepEqual(
    deliveryProcessPaths([
      "notes/001.md",
      "notes/index.json",
      "papers/to-fetch.md",
      "manuscript/section-status.md",
      "scripts/build.py",
    ]),
    ["manuscript/section-status.md", "notes/index.json"],
  );
});
