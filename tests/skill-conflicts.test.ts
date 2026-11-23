import assert from "node:assert/strict";
import test from "node:test";
import { skillChainWarnings, skillOutputConflicts } from "../src/skill-conflicts.ts";
import type { SkillDto } from "../src/types.ts";

const skill = (name: string, outputs?: string[]) =>
  ({ name, outputs }) as SkillDto;

test("skillOutputConflicts：同一路径或两目录互含才算相交", () => {
  const lib = [
    skill("a", ["papers/"]),
    skill("b", ["papers/inbox.md"]),
    skill("c", ["papers/"]),
    skill("d", ["papers/imports/"]),
  ];
  assert.deepEqual(skillOutputConflicts(["a", "b"], lib), []);
  assert.deepEqual(skillOutputConflicts(["a", "c"], lib), [
    { a: "a", b: "c", output: "papers/" },
  ]);
  assert.deepEqual(skillOutputConflicts(["a", "d"], lib), [
    { a: "a", b: "d", output: "papers/" },
  ]);
});

test("skillOutputConflicts：不相交与名字前缀误伤防护", () => {
  const lib = [
    skill("a", ["papers/"]),
    skill("b", ["figures/"]),
    skill("c", ["papers2/draft.md"]), // papers/ 不能误伤 papers2/
  ];
  assert.deepEqual(skillOutputConflicts(["a", "b"], lib), []);
  assert.deepEqual(skillOutputConflicts(["a", "c"], lib), []);
});

test("skillOutputConflicts：路径归一化（空白、反斜杠、重复斜杠、./ 前缀）", () => {
  const lib = [skill("a", [" notes/inbox.md "]), skill("b", [".\\notes\\inbox.md"])];
  assert.deepEqual(skillOutputConflicts(["a", "b"], lib), [
    { a: "a", b: "b", output: "notes/inbox.md" },
  ]);
});

test("skillOutputConflicts：空 outputs 与未入库技能不参与", () => {
  const lib = [skill("a", ["papers/"]), skill("b"), skill("c", [])];
  assert.deepEqual(skillOutputConflicts(["a", "b", "c", "ghost"], lib), []);
});

test("skillOutputConflicts：同一对技能多处相交只报一次（取第一个）", () => {
  const lib = [
    skill("a", ["notes/", "references.bib"]),
    skill("b", ["notes/", "references.bib"]),
  ];
  assert.deepEqual(skillOutputConflicts(["a", "b"], lib), [
    { a: "a", b: "b", output: "notes/" },
  ]);
});

test("skillOutputConflicts：多对冲突逐对列出", () => {
  const lib = [
    skill("a", ["analysis/"]),
    skill("b", ["figures/"]),
    skill("c", ["analysis/", "figures/"]),
  ];
  assert.deepEqual(skillOutputConflicts(["a", "b", "c"], lib), [
    { a: "a", b: "c", output: "analysis/" },
    { a: "b", b: "c", output: "figures/" },
  ]);
});

test("skillOutputConflicts：步骤简报已点名两个技能分工（名称或 {skill:锚名}）时不误报黄字", () => {
  const lib = [
    { name: "review-figures", outputs: ["figures/"], provides: ["review-figures"] } as SkillDto,
    { name: "schematic-forge", outputs: ["figures/"], provides: ["schematic-forge"] } as SkillDto,
    { name: "figure-forge", outputs: ["figures/"], provides: ["figure-forge"] } as SkillDto,
  ];
  const brief = "拼图按 {skill:review-figures}，自绘按 {skill:schematic-forge}，重绘按 {skill:figure-forge}。";
  assert.deepEqual(skillOutputConflicts(["review-figures", "schematic-forge", "figure-forge"], lib, brief), []);
  // 简报只提了其中一个时，仍提醒未分工的那对
  const partial = "拼图按 {skill:review-figures}。";
  assert.equal(skillOutputConflicts(["review-figures", "schematic-forge"], lib, partial).length, 1);
});

test("内置互补技能不报：目录 vs 其中的报告文件；多阶段技能对上本步产物即可", () => {
  const lib = [
    skill("lit-search", ["papers/"]),
    skill("zotero-sync", ["papers/zotero-sync.md"]),
    skill("review-writing", ["outline.md", "manuscript/"]),
    skill("bib-check", ["manuscript/citation-check.md"]),
  ];
  assert.deepEqual(skillOutputConflicts(["lit-search", "zotero-sync"], lib), []);
  assert.deepEqual(skillOutputConflicts(["review-writing", "bib-check"], lib), []);
  assert.deepEqual(
    skillChainWarnings(
      ["review-writing"],
      [iface("review-writing", [], ["outline.md", "manuscript/"])],
      ["outline.md", "notes/", "references.bib"],
      ["manuscript/draft.md", "output/draft.pdf"],
    ),
    [],
  );
});

const iface = (name: string, inputs?: string[], outputs?: string[], inferred = false) =>
  ({ name, inputs, outputs, interfaceInferred: inferred }) as SkillDto;

test("skillChainWarnings：读入有上游供给/目录覆盖/通配覆盖时不报", () => {
  const lib = [
    iface("lit-notes", ["papers/included.md", "references.bib"], ["notes/"]),
  ];
  // 精确供给 + 目录供给
  assert.deepEqual(
    skillChainWarnings(
      ["lit-notes"],
      lib,
      ["papers/", "references.bib"],
      ["notes/*.md"],
    ),
    [],
  );
  // 通配供给覆盖目录需求
  assert.deepEqual(
    skillChainWarnings(["lit-notes"], lib, ["papers/", "references.bib"], []),
    [],
  );
  const lib2 = [iface("fw", ["notes/"], ["outline.md"])];
  assert.deepEqual(
    skillChainWarnings(["fw"], lib2, ["notes/*.md"], ["outline.md"]),
    [],
  );
});

test("skillChainWarnings：读入无供给与产出未进预期产物分别报 input/output", () => {
  const lib = [
    iface("ext-skill", ["papers/corpus.csv"], ["report/summary.md"], true),
  ];
  const warnings = skillChainWarnings(
    ["ext-skill"],
    lib,
    ["papers/screening.md"],
    ["report.md"],
  );
  assert.deepEqual(warnings, [
    { skill: "ext-skill", kind: "input", path: "papers/corpus.csv", inferred: true },
    { skill: "ext-skill", kind: "output", path: "report/summary.md", inferred: true },
  ]);
});

test("skillChainWarnings：本步预期产物不算上游缺失", () => {
  const lib = [iface("endnote-bridge", ["references.bib"], [])];
  assert.deepEqual(
    skillChainWarnings(
      ["endnote-bridge"],
      lib,
      ["papers/included.md"],
      ["notes/*.md", "references.bib"],
    ),
    [],
  );
});

test("skillChainWarnings：未入库/无接口技能不参与；预期产物为空不检 output 侧", () => {
  const lib = [iface("plain")];
  assert.deepEqual(
    skillChainWarnings(["plain", "ghost"], lib, [], ["x.md"]),
    [],
  );
  const lib2 = [iface("w", [], ["anything.md"])];
  assert.deepEqual(skillChainWarnings(["w"], lib2, [], []), []);
});

test("skillChainWarnings：本步只写导入文件时，不报技能声明里的交稿文件", () => {
  const lib = [
    iface("endnote-bridge", [], [
      "papers/endnote-report.json",
      "output/endnote.docx",
      "papers/endnote-cite-report.md",
    ]),
  ];
  assert.deepEqual(
    skillChainWarnings(
      ["endnote-bridge"],
      lib,
      [],
      ["papers/screening.md", "papers/endnote-import.ris"],
      ["papers/endnote-import.ris"],
    ),
    [],
  );
});

test("skillChainWarnings：路径归一化后判定（./ 前缀、反斜杠）", () => {
  const lib = [iface("s", ["./papers\\included.md"], [])];
  assert.deepEqual(
    skillChainWarnings(["s"], lib, ["papers/"], ["x.md"]),
    [],
  );
});

test("skillChainWarnings：手动挂到精读步的 zotero-sync 只比对本阶段文件，不报定稿域稿", () => {
  const lib = [
    iface("zotero-sync", [], ["papers/zotero-sync.md", "output/zotero.docx", "papers/zotero-cite-report.md"]),
  ];
  const expected = ["notes/*.md", "notes/index.json", "references.bib", "papers/to-fetch.md", "notes/handoff.md"];
  assert.deepEqual(
    skillChainWarnings(["zotero-sync"], lib, [], expected, undefined, { "zotero-sync": ["papers/zotero-sync.md"] }),
    [{ skill: "zotero-sync", kind: "output", path: "papers/zotero-sync.md", inferred: false }],
  );
  assert.deepEqual(
    skillChainWarnings(["zotero-sync"], lib, [], [...expected, "papers/zotero-sync.md"], undefined, { "zotero-sync": ["papers/zotero-sync.md"] }),
    [],
  );
});
