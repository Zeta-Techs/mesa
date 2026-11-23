import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { PIPELINE_TEMPLATES } from "../src/pipeline-presets.ts";
import { stepDataRoots } from "../src/step-flow.ts";

test("模板/技能指令静态体检：无必需技能冲突、无未定义 G1–G5 门禁、精读机检排除汇总表", () => {
  for (const tpl of PIPELINE_TEMPLATES) {
    for (const step of tpl.steps) {
      const text = `${step.guidance ?? ""}\n${step.prompt ?? ""}`;
      const skills = step.skills ?? [];

      // 1. 正文明确写「不写 papers/zotero-sync.md」或「不在这一步同步」时，不得强绑 zotero-sync 为必需技能
      if (/不写\s*papers\/zotero-sync\.md|不在这一步同步/.test(text)) {
        assert.ok(
          !skills.includes("zotero-sync"),
          `模板「${tpl.name}」步骤「${step.name}」正文禁止同步，但把 zotero-sync 挂成了必需技能`,
        );
      }

      // 2. 提到 G1–G5 / G1-G5 时，同一份步骤指令里必须给出释义，不留未定义黑盒代号
      if (/G1[–-]G5/.test(text)) {
        assert.match(
          text,
          /G1[^。\n]{2,}G2|G1[＝=：:]/,
          `模板「${tpl.name}」步骤「${step.name}」提到 G1–G5 但未就地定义`,
        );
      }

      // 3. 精读步 machine:count:notes/*.md 必须把常见汇总表全部排除，避免速读表/抽取表顶替单篇笔记数
      const notesCheck = (step.completionCriteria ?? []).find((c) =>
        c.startsWith("machine:count:notes/*.md"),
      );
      if (notesCheck && skills.includes("lit-notes")) {
        for (const summaryFile of ["handoff.md", "glossary.md", "excerpts.md", "inbox.md", "angles.md", "extraction.md"]) {
          assert.ok(
            notesCheck.includes(summaryFile),
            `模板「${tpl.name}」步骤「${step.name}」机检 ${notesCheck} 漏排除 ${summaryFile}`,
          );
        }
      }
    }
  }
});

test("review-figures 技能必须明示查找 Zotero 外部只读 PDF 路径，避免初稿拼图误判缺全文", () => {
  const skill = readFileSync(
    resolve("src-tauri/resources/skills/review-figures/SKILL.md"),
    "utf8",
  );
  assert.match(skill, /Zotero/);
  assert.match(skill, /lit_records\.py pdfs/);
  assert.match(skill, /included\.json/);
});

test("stepDataRoots：已保存步骤恒以项目根为准，未保存活跃工作副本优先工作区并回落项目根", () => {
  assert.deepEqual(
    stepDataRoots({ status: "active", worktreePath: "/wt/lit-notes" }, "review", "/proj"),
    ["/wt/lit-notes", "/proj"],
  );
  assert.deepEqual(
    stepDataRoots({ status: "active", worktreePath: "/wt/lit-notes" }, "active", "/proj"),
    ["/wt/lit-notes", "/proj"],
  );
  // 已保存（done）即使还留着活跃工作区，读源也以项目根为准
  assert.deepEqual(
    stepDataRoots({ status: "active", worktreePath: "/wt/lit-search" }, "done", "/proj"),
    ["/proj"],
  );
  assert.deepEqual(stepDataRoots(undefined, "pending", "/proj"), ["/proj"]);
});
