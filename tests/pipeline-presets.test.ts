import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PIPELINE_TEMPLATES,
  pipelineStepsForTemplate,
  settingsForTemplateApply,
} from "../src/pipeline-presets.ts";

test("内置模板的 workspaceName 全局唯一，避免追加时互相覆盖", () => {
  for (const template of PIPELINE_TEMPLATES) {
    const names = template.steps
      .map((s) => s.workspaceName)
      .filter(Boolean);
    assert.equal(new Set(names).size, names.length, template.name);
  }
});

test("模板追加入口对自定义模板也补齐最小步骤契约", () => {
  const [step] = pipelineStepsForTemplate({
    id: "custom",
    name: "自定义",
    description: "",
    steps: [
      {
        name: "一步",
        workspaceName: "one",
        brief: "",
        expectedArtifacts: ["result.md"],
        skills: [],
        run: [],
      },
    ],
  });
  assert.ok(step.acceptanceCriteria?.some((x) => x.includes("非空")));
  assert.deepEqual(step.requiredSkills, []);
});

test("投稿模板首投/返修是真正的不同步骤链，返修产物按轮次隔离", () => {
  const template = PIPELINE_TEMPLATES.find(
    (t) => t.id === "submission-rebuttal",
  );
  assert.ok(template);
  const initial = pipelineStepsForTemplate(template, "initial");
  assert.deepEqual(initial.map((s) => s.name), ["期刊格式适配", "投稿材料"]);
  const revision = pipelineStepsForTemplate(template, "revision", 2);
  assert.equal(revision.length, 1);
  assert.equal(revision[0].workspaceName, "rebuttal-r2");
  assert.ok(revision[0].expectedArtifacts.includes("manuscript/revised-r2.md"));
  assert.ok(
    revision[0].expectedArtifacts.includes(
      "submission/resubmission-checklist-r2.md",
    ),
  );
  assert.ok(revision[0].brief.includes("reviews/round-2.md"));
  assert.ok(!revision[0].expectedArtifacts.some((x) => x === "manuscript/revised.md"));
});

test("投稿返修第 1 轮兼容综述定稿与科研论文定稿两种上游稿件", () => {
  const template = PIPELINE_TEMPLATES.find(
    (t) => t.id === "submission-rebuttal",
  );
  assert.ok(template);
  const [revision] = pipelineStepsForTemplate(template, "revision", 1);
  assert.deepEqual(revision.inputs, ["reviews/round-1.md", "references.bib"]);
  assert.ok(revision.anyOfInputs?.[0]?.includes("submission/formatted.md"));
  assert.ok(revision.anyOfInputs?.[0]?.includes("manuscript/paper-final.md"));
  assert.ok(revision.anyOfInputs?.[0]?.includes("manuscript/review-final.md"));
  assert.ok(revision.anyOfInputs?.[0]?.includes("manuscript/thesis-final.md"));
  assert.ok(revision.brief.includes("submission/formatted.md"));
  assert.ok(revision.expectedArtifacts.includes("manuscript/revised-r1.md"));
});

test("内置模板的后续步骤输入都能接到上游产物", () => {
  const covers = (artifact: string, input: string) =>
    artifact === input || artifact.startsWith(input) || input.startsWith(artifact);
  for (const template of PIPELINE_TEMPLATES) {
    const variants =
      template.id === "submission-rebuttal"
        ? [
            pipelineStepsForTemplate(template, "initial", 1),
            pipelineStepsForTemplate(template, "revision", 2),
          ]
        : [template.steps];
    for (const steps of variants) {
      const prior: string[] = [];
      for (const step of steps) {
        if (prior.length) {
          for (const input of step.inputs ?? []) {
            assert.ok(
              prior.some((artifact) => covers(artifact, input)),
              `${template.id}/${step.name} 的输入未接到上游：${input}`,
            );
          }
          // optionalInputs 可以来自项目资源或跨模板输入，不要求一定由本模板前序步骤产出。
          // 后端对它们只做存在即读取，不把缺失当作链路错误。
          for (const input of step.optionalInputs ?? []) {
            assert.ok(input.trim(), `${template.id}/${step.name} 存在空的可选输入`);
          }
          for (const group of step.anyOfInputs ?? []) {
            assert.ok(
              group.some((input) => prior.some((artifact) => covers(artifact, input))),
              `${template.id}/${step.name} 的任一输入组未接到上游：${group.join(" 或 ")}`,
            );
          }
        }
        prior.push(...step.expectedArtifacts);
      }
    }
  }
});

test("空落点人工事项必须使用 manual，且推荐技能存在于内置技能集合", () => {
  const builtin = new Set([
    "bib-check", "blender-research", "data-clean", "data-eda", "endnote-bridge", "figure-forge",
    "lit-notes", "lit-search", "lit-watch", "origin-plot", "proposal-writer", "quarto-render",
    "rebuttal-crafter", "research-writing", "review-figures", "review-framework", "review-writing",
    "slides-deck", "stats-check", "zotero-sync",
  ]);
  for (const template of PIPELINE_TEMPLATES) {
    for (const step of template.steps) {
      for (const task of step.humanTasks ?? []) {
        // 落点可省（行内处理的人工事项没有 target，例如「更换引用样式」）。
        if (!(task.target ?? "").trim()) {
          assert.equal(task.completion ?? "manual", "manual", `${template.id}/${step.name}/${task.title}`);
        }
      }
      for (const skill of step.skills) assert.ok(builtin.has(skill), `${template.id}/${step.name} 使用未播种技能：${skill}`);
    }
  }
});

test("每套模板有自己的纪律，没填的全局设定留占位", () => {
  for (const template of PIPELINE_TEMPLATES) {
    assert.ok(
      (template.projectRules ?? []).length > 0,
      `${template.id} 缺少 projectRules`,
    );
  }
  const review = PIPELINE_TEMPLATES.find((t) => t.id === "review")!;
  const data = PIPELINE_TEMPLATES.find((t) => t.id === "data-processing")!;
  assert.match(review.projectRules!.join("\n"), /不要虚构文献/);
  assert.doesNotMatch(review.projectRules!.join("\n"), /原始数据/);
  assert.match(data.projectRules!.join("\n"), /原始数据/);
  assert.doesNotMatch(data.projectRules!.join("\n"), /虚构文献/);
  assert.deepEqual(settingsForTemplateApply(review), [
    ...review.projectRules!,
    ...(review.projectSettings ?? []),
  ]);
  assert.deepEqual(
    settingsForTemplateApply(review, ["聚焦某个子问题", "", "", "", ""]),
    [
      ...review.projectRules!,
      "综述角度：聚焦某个子问题",
      ...(review.projectSettings ?? []).slice(1),
    ],
  );
});

test("Zotero 检索只默认挂三套科研文献步骤；定稿默认交两份域稿", () => {
  const citeSteps = new Set(["polish", "research-paper-polish", "thesis-final", "journal-format"]);
  for (const id of ["review", "research-paper", "thesis"]) {
    const template = PIPELINE_TEMPLATES.find((t) => t.id === id);
    assert.ok(template, `缺少模板：${id}`);
    const searchStep = template.steps.find((step) => step.skills.includes("lit-search"));
    assert.ok(searchStep, `${id} 缺少文献检索步骤`);
    if (id === "review") {
      assert.equal(searchStep.skills.includes("zotero-sync"), false, "综述检索不默认挂 Zotero");
      assert.equal(searchStep.expectedArtifacts.includes("papers/zotero-sync.md"), false);
    } else {
      assert.ok(searchStep.skills.includes("zotero-sync"), `${id} 文献检索步骤未挂载 zotero-sync`);
    }
    assert.deepEqual(searchStep.requiredSkills, ["lit-search"], `${id} 的 zotero-sync 应为可选技能`);
    assert.ok(!searchStep.skills.includes("origin-plot"));
    assert.ok(!searchStep.skills.includes("endnote-bridge"));
  }
  for (const template of PIPELINE_TEMPLATES) {
    for (const step of template.steps) {
      const cites = citeSteps.has(step.workspaceName ?? "");
      if (!step.skills.includes("lit-search") && !cites) {
        assert.ok(!step.skills.includes("zotero-sync"), `${template.id}/${step.name} 错误挂载 zotero-sync`);
      }
      assert.ok(!step.skills.includes("origin-plot"), `${template.id}/${step.name} 不应默认挂载 origin-plot`);
      if (cites) {
        assert.ok(step.skills.includes("endnote-bridge"), `${template.id}/${step.name} 定稿应挂 endnote-bridge`);
        assert.ok(step.skills.includes("zotero-sync"), `${template.id}/${step.name} 定稿应挂 zotero-sync`);
        assert.ok(step.expectedArtifacts.includes("output/endnote.docx"));
        assert.ok(step.expectedArtifacts.includes("output/zotero.docx"));
      } else {
        assert.ok(!step.skills.includes("endnote-bridge"), `${template.id}/${step.name} 不应默认挂载 endnote-bridge`);
      }
    }
  }
});

test("run 声明的 Quarto/LaTeX 正式输出均进入 expectedArtifacts", () => {
  for (const template of PIPELINE_TEMPLATES) {
    for (const step of template.steps) {
      for (const run of step.run) {
        const matches = [...run.command.matchAll(/quarto render\s+([^\s]+)\s+--to\s+(pdf|docx)/g)];
        for (const [, source, format] of matches) {
          const base = source.split("/").pop()!.replace(/\.[^.\/]+$/, "");
          const artifact = `output/${base}.${format}`;
          assert.ok(step.expectedArtifacts.includes(artifact), `${template.id}/${step.name} 缺少 run 产物：${artifact}`);
        }
        if (run.command.includes("tectonic") || run.command.includes("latexmk -pdf")) {
          assert.ok(step.expectedArtifacts.includes("output/main.pdf"), `${template.id}/${step.name} 缺少 LaTeX PDF 产物`);
        }
      }
    }
  }
});

test("同一份稿同时渲 docx 和 pdf 时，docx 排在 pdf 前面", () => {
  for (const template of PIPELINE_TEMPLATES) {
    for (const step of template.steps) {
      const formats = step.run.flatMap((run) =>
        [...run.command.matchAll(/quarto render\s+\S+\s+--to\s+(pdf|docx)/g)].map(
          (match) => match[1],
        ),
      );
      const pdf = formats.indexOf("pdf");
      const docx = formats.indexOf("docx");
      if (pdf >= 0 && docx >= 0) {
        assert.ok(
          docx < pdf,
          `${template.id}/${step.name} 应先渲 docx 再渲 pdf`,
        );
      }
    }
  }
});

test("quarto render 的产物落点：稿件在一级目录下，--output-dir 必须是 ../output 且不带 --output", () => {
  // 实测（Windows + Quarto 1.10.19）：没有 _quarto.yml 时 --output-dir 相对稿件所在目录解析。
  // 写 `output` 落进 manuscript/output/ 且后一次渲染清掉前一次；与 --output 同用则成品落到工作区根
  const variants = PIPELINE_TEMPLATES.flatMap((template) =>
    template.id === "submission-rebuttal"
      ? [
          pipelineStepsForTemplate(template, "initial", 1),
          pipelineStepsForTemplate(template, "revision", 2),
        ]
      : [template.steps],
  );
  let seen = 0;
  for (const steps of variants) {
    for (const step of steps) {
      for (const run of step.run) {
        if (!/quarto render\s+/.test(run.command)) continue;
        seen += 1;
        const source = run.command.match(/quarto render\s+(\S+)/)![1];
        assert.equal(source.split("/").length, 2, `${step.name}/${run.name} 稿件应在一级目录下：${source}`);
        assert.match(run.command, /--output-dir \.\.\/output(\s|$)/, `${step.name}/${run.name} --output-dir 应为 ../output`);
        assert.doesNotMatch(run.command, /\s--output\s/, `${step.name}/${run.name} 不能带 --output`);
      }
    }
  }
  assert.ok(seen >= 10, "应覆盖到全部模板的渲染命令");
});

test("quarto-render 技能与导出的综述模板都用 ../output", () => {
  const skill = readFileSync("src-tauri/resources/skills/quarto-render/SKILL.md", "utf8");
  assert.match(skill, /--to pdf --output-dir \.\.\/output/);
  assert.doesNotMatch(skill, /--output-dir output\b/);
  const exported = readFileSync("src-tauri/resources/pipeline-review.json", "utf8");
  assert.doesNotMatch(exported, /--output-dir output\b/);
  assert.match(exported, /--output-dir \.\.\/output/);
});

test("quarto-render 随包 CSL 是编号引用", () => {
  const csl = readFileSync(
    "src-tauri/resources/skills/quarto-render/ieee.csl",
    "utf8",
  );
  assert.match(csl, /citation-format="numeric"/);
  assert.match(csl, /<text variable="citation-number"/);
  assert.match(csl, /prefix="\[" suffix="\]"/);
});

test("引用格式只在定稿步定：起草步固定编号制，定稿步指向流程线选择器", () => {
  // 起草步：不装选择器，初稿固定按编号制渲（YAML 挂随包 ieee.csl）。
  // 定稿步：样式由人在流程线「更换引用样式」上选，简报必须指向那一处。
  const draftNames = ["综述初稿", "论文初稿"];
  for (const template of PIPELINE_TEMPLATES) {
    const variants =
      template.id === "submission-rebuttal"
        ? [
            pipelineStepsForTemplate(template, "initial", 1),
            pipelineStepsForTemplate(template, "revision", 2),
          ]
        : [template.steps];
    for (const steps of variants) {
      for (const step of steps) {
        if (!step.run.some((run) => /quarto render\s+/.test(run.command))) continue;
        // 投稿返修的「期刊格式适配」只对特定刊适配，不属起草/定稿两分
        if (template.id === "submission-rebuttal") {
          assert.match(step.brief, /更换引用样式/, step.name);
          continue;
        }
        if (draftNames.includes(step.name)) {
          assert.match(step.brief, /初稿固定用编号制/, step.name);
          assert.equal(
            (step.humanTasks ?? []).some((h) => /引用样式/.test(h.title)),
            false,
            `${step.name} 不该再挂引用样式事项：格式在定稿步定`,
          );
        } else {
          assert.match(step.brief, /更换引用样式/, step.name);
        }
      }
    }
  }
});

test("需要渲染的步骤必须挂载 quarto-render 技能", () => {
  const variants = PIPELINE_TEMPLATES.flatMap((template) =>
    template.id === "submission-rebuttal"
      ? [
          pipelineStepsForTemplate(template, "initial", 1),
          pipelineStepsForTemplate(template, "revision", 2),
        ]
      : [template.steps],
  );
  for (const steps of variants) {
    for (const step of steps) {
      if (step.run.some((run) => /quarto render\s+/.test(run.command))) {
        assert.ok(
          step.skills.includes("quarto-render"),
          `${step.name} 声明 Quarto run 但未挂载 quarto-render`,
        );
      }
    }
  }
});

test("lit-search 与返修步骤的核心产物契约完整且按轮次隔离", () => {
  for (const template of PIPELINE_TEMPLATES) {
    const variants =
      template.id === "submission-rebuttal"
        ? [
            pipelineStepsForTemplate(template, "initial", 1),
            pipelineStepsForTemplate(template, "revision", 2),
          ]
        : [template.steps];
    for (const steps of variants) {
      for (const step of steps) {
        if (step.skills.includes("lit-search")) {
          for (const artifact of [
            "papers/screening.md",
            "papers/included.md",
            "papers/to-fetch.md",
            "papers/to-fetch.ris",
            "papers/endnote-import.ris",
          ]) {
            assert.ok(
              step.expectedArtifacts.includes(artifact),
              `${template.id}/${step.name} 缺少 lit-search 产物：${artifact}`,
            );
          }
        }
        if (step.name.includes("审稿意见回复")) {
          const round = step.name.match(/第(\d+)轮/)?.[1];
          assert.ok(round, `${template.id}/${step.name} 缺少轮次`);
          assert.ok(
            step.expectedArtifacts.every((artifact) =>
              artifact.includes(`-r${round}`),
            ),
            `${template.id}/${step.name} 存在未隔离的返修产物`,
          );
          assert.ok(
            !step.expectedArtifacts.some((artifact) =>
              /(?:revised|response-letter)\.md$/.test(artifact),
            ),
            `${template.id}/${step.name} 存在无轮次返修文件`,
          );
        }
      }
    }
  }
});

test("只读审查技能的报告落点已进入步骤产物契约", () => {
  const variants = PIPELINE_TEMPLATES.flatMap((template) =>
    template.id === "submission-rebuttal"
      ? [
          pipelineStepsForTemplate(template, "initial", 1),
          pipelineStepsForTemplate(template, "revision", 2),
        ]
      : [template.steps],
  );
  for (const steps of variants) {
    for (const step of steps) {
      const artifacts = step.expectedArtifacts;
      if (step.skills.includes("bib-check")) {
        assert.ok(
          artifacts.some((x) => /citation-check|format-notes|final-check/.test(x)),
          `${step.name} 挂载 bib-check 但未声明引用审查报告`,
        );
      }
      if (step.skills.includes("stats-check")) {
        assert.ok(
          artifacts.some((x) => /stats-check/.test(x)),
          `${step.name} 挂载 stats-check 但未声明统计审查报告`,
        );
      }
      if (step.skills.includes("lit-notes") && step.brief.includes("更新 to-fetch.md")) {
        assert.ok(
          artifacts.includes("papers/to-fetch.md"),
          `${step.name} 会更新 to-fetch.md 但未声明回写产物`,
        );
      }
    }
  }
});

test("检索步先核对待确认，再下载已纳入全文，pending 不进 to-fetch", () => {
  const searchSteps = PIPELINE_TEMPLATES.flatMap((t) => t.steps).filter(
    (s) => s.workspaceName === "lit-search" || s.workspaceName === "lit-survey-search",
  );
  assert.ok(searchSteps.length >= 3);
  for (const step of searchSteps) {
    const titles = (step.humanTasks ?? []).filter((h) => h.timing === "after").map((h) => h.title);
    const pendingAt = titles.indexOf("核对待确认篇目");
    const paywallAt = titles.findIndex((t) => t.includes("付费"));
    assert.ok(pendingAt >= 0, `${step.name} 缺核对待确认`);
    assert.ok(paywallAt >= 0, `${step.name} 缺付费墙下载`);
    assert.ok(pendingAt < paywallAt, `${step.name} 待确认必须排在下载全文之前`);
    assert.match(step.brief, /禁止把 pending 写入 to-fetch/);
  }
});

test("三条检索链简报都带积累进料句，全模板不再出现「加入精读」", () => {
  const searchSteps = PIPELINE_TEMPLATES.flatMap((t) => t.steps).filter(
    (s) => s.skills.includes("lit-search"),
  );
  assert.equal(searchSteps.length, 3, "英文综述 / 科研论文 / 毕业论文各一条检索步");
  for (const step of searchSteps) {
    assert.match(
      step.brief,
      /工作区 \.ccode\/handoff-lit-intake\.md（开工时从项目根 papers\/reading-list\.md 冻结/,
      `${step.workspaceName} 缺积累进料句`,
    );
    assert.match(
      step.brief,
      /与 included\.md 存量、人工导入题录、检索候选池统一去重（同篇不重复列）/,
      `${step.workspaceName} 进料句缺统一去重口径`,
    );
    assert.match(
      step.brief,
      /不回写、不删除、不清空积累台账/,
      `${step.workspaceName} 进料句缺积累账保护句`,
    );
  }
  // 2026-10-13 拍板：「加入精读」改叫「加入积累」；模板文案零残留旧称
  for (const template of PIPELINE_TEMPLATES) {
    for (const step of template.steps) {
      assert.doesNotMatch(
        step.brief,
        /加入精读/,
        `${template.id}/${step.name} 仍写旧称「加入精读」`,
      );
    }
  }
});

test("内置模板不再用空目录作为预期产物", () => {
  for (const template of PIPELINE_TEMPLATES) {
    const variants =
      template.id === "submission-rebuttal"
        ? [
            pipelineStepsForTemplate(template, "initial", 1),
            pipelineStepsForTemplate(template, "revision", 2),
          ]
        : [template.steps];
    for (const steps of variants) {
      for (const step of steps) {
        assert.ok(
          step.expectedArtifacts.every((artifact) => !artifact.endsWith("/")),
          `${template.id}/${step.name} 仍有过宽目录产物`,
        );
      }
    }
  }
});

test("毕业论文拆成与综述同名的文献两步再开题", () => {
  const thesis = PIPELINE_TEMPLATES.find((t) => t.id === "thesis");
  const review = PIPELINE_TEMPLATES.find((t) => t.id === "review");
  assert.ok(thesis && review);
  assert.deepEqual(
    thesis.steps.slice(0, 3).map((s) => s.name),
    ["文献检索与筛选", "文献精读与笔记", "开题报告与综述"],
  );
  assert.equal(thesis.steps[0].workspaceName, review.steps[0].workspaceName);
  assert.equal(thesis.steps[1].workspaceName, review.steps[1].workspaceName);
  assert.equal(thesis.steps.length, 8);
});

test("独立启动的首步不得把笔记库当成必需输入", () => {
  for (const id of ["thesis", "latex-paper"]) {
    const template = PIPELINE_TEMPLATES.find((t) => t.id === id);
    assert.ok(template);
    const first = template.steps[0];
    assert.ok(
      !(first.inputs ?? []).some((x) => x === "notes/" || x === "references.bib"),
      `${id} 首步把 notes/bib 标成了必需`,
    );
  }
});

test("实验执行必须声明 design.md，精读必须声明 included", () => {
  for (const template of PIPELINE_TEMPLATES) {
    for (const step of template.steps) {
      if (step.name.includes("实验执行")) {
        assert.ok(
          (step.inputs ?? []).includes("design.md"),
          `${template.id}/${step.name} 缺少 design.md 输入`,
        );
      }
      if (step.skills.includes("lit-notes")) {
        assert.ok(
          (step.inputs ?? []).includes("papers/included.md"),
          `${template.id}/${step.name} 精读缺少 included.md`,
        );
      }
    }
  }
});

test("科研论文与投稿的清单文件不对撞，投稿能吃毕业论文成稿", () => {
  const paper = PIPELINE_TEMPLATES.find((t) => t.id === "research-paper");
  const sub = PIPELINE_TEMPLATES.find((t) => t.id === "submission-rebuttal");
  assert.ok(paper && sub);
  const polish = paper.steps.find((s) => s.name === "润色与投稿准备");
  const format = pipelineStepsForTemplate(sub, "initial")[0];
  assert.ok(polish?.expectedArtifacts.includes("submission/pre-submission-checklist.md"));
  assert.ok(!polish?.expectedArtifacts.includes("submission/checklist.md"));
  assert.ok(format.anyOfInputs?.[0]?.includes("manuscript/thesis-final.md"));
  assert.ok(format.expectedArtifacts.includes("output/formatted.pdf"));
  assert.ok(format.skills.includes("quarto-render"));
});

test("综述初稿：不以词数为完成标准，扩写必须回笔记或原文", () => {
  const review = PIPELINE_TEMPLATES.find((t) => t.id === "review");
  const draft = review?.steps.find((s) => s.name === "综述初稿");
  assert.ok(draft);
  assert.match(draft.brief, /词数不是完成标准/);
  assert.match(draft.brief, /notes\//);
  assert.match(draft.brief, /来源 PDF/);
  assert.match(draft.brief, /不以词数判定完成/);
  assert.match(draft.brief, /防御性套话/);
  assert.match(draft.brief, /PDF 首页可读/);
  assert.match(draft.brief, /G1 不准进稿件/);
  assert.match(draft.brief, /摘要只放全文撑得住/);
  assert.match(draft.brief, /禁止「待绘制」/);
  assert.ok(draft.expectedArtifacts?.includes("figures/README.md"));
  assert.ok(
    draft.acceptanceCriteria?.includes("machine:not-contains:manuscript/draft.md::待绘制"),
  );
  assert.match(draft.brief, /摘要级来源/);
  assert.ok(
    (draft.acceptanceCriteria ?? []).some((c) => /首页必须能读出/.test(c)),
    "PDF 验收不得只认非零字节",
  );
  assert.equal(
    (draft.humanTasks ?? []).some((t) => /审阅|看一眼/.test(t.title)),
    false,
    "初稿不再另挂审阅勾或硬伤计数",
  );
  const outline = review?.steps.find((s) => s.name === "综述大纲");
  assert.equal(
    (outline?.humanTasks ?? []).some((t) => /审阅|看一眼/.test(t.title)),
    false,
  );
});

test("声明了 Quarto 渲染的步骤简报必须写明要跑渲染", () => {
  for (const template of PIPELINE_TEMPLATES) {
    const steps =
      template.id === "submission-rebuttal"
        ? pipelineStepsForTemplate(template, "initial")
        : template.steps;
    for (const step of steps) {
      if (step.run.some((run) => /quarto render/.test(run.command))) {
        assert.ok(
          /渲染/.test(step.brief),
          `${template.id}/${step.name} 挂了 quarto 但简报没写渲染`,
        );
      }
    }
  }
});

test("检索步带可选 MCP 事项，文献 PDF 指引落到项目根", () => {
  for (const template of PIPELINE_TEMPLATES) {
    for (const step of template.steps) {
      if (!step.skills.includes("lit-search")) continue;
      assert.ok(
        (step.humanTasks ?? []).some((t) => t.title.includes("学术检索 MCP")),
        `${template.id}/${step.name} 缺少 MCP 事项`,
      );
      const pdf = (step.humanTasks ?? []).find((t) => t.target === "papers/*.pdf");
      assert.ok(pdf, `${template.id}/${step.name} 缺少付费全文事项`);
      assert.match(pdf.guidance, /项目根/);
    }
  }
});
