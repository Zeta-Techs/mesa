import assert from "node:assert/strict";
import test from "node:test";
import { renderTaskMd } from "../src/task-md.ts";
import { PIPELINE_TEMPLATES, settingsForTemplateApply } from "../src/pipeline-presets.ts";
import { KEEP_WORKING_CLAUSE } from "../src/step-decisions.ts";
import type { ProjectConfigDto, ProjectStepDto } from "../src/types.ts";

function step(partial: Partial<ProjectStepDto> = {}): ProjectStepDto {
  return {
    name: "清洗与整理",
    workspaceName: "data-clean",
    brief: "做清洗。",
    expectedArtifacts: ["cleaning/rules.md"],
    skills: [],
    run: [],
    ...partial,
  };
}

function cfg(partial: Partial<ProjectConfigDto> = {}): ProjectConfigDto {
  return {
    artifactDir: "artifacts",
    resources: [],
    steps: [],
    ...partial,
  };
}

test("TASK.md 派生产物写本工作区、文献 PDF 直写项目根", () => {
  const md = renderTaskMd(step(), cfg(), "/Users/me/proj");
  assert.match(md, /项目根：`\/Users\/me\/proj`/);
  assert.match(md, /`\/Users\/me\/proj\/papers\/`/);
  assert.match(md, /本工作区的 `artifacts\/` 或 `output\/`（相对路径）/);
  assert.match(md, /评审合并进主仓时自动带到项目根同名目录/);
  assert.match(md, /项目根相对路径（如 artifacts\/xxx\.csv）/);
  assert.doesNotMatch(md, /`\/Users\/me\/proj\/artifacts`/);
  assert.doesNotMatch(md, /`\/Users\/me\/proj\/output\/`/);
});

test("TASK.md 收尾：派生产物走工作区，直写项目根的是未验收产物", () => {
  const md = renderTaskMd(step(), cfg(), "/tmp/p");
  assert.match(md, /派生产物只写本工作区产物目录/);
  assert.match(md, /文献 PDF 写项目根 papers\//);
  assert.doesNotMatch(md, /必须落在上方项目根对应目录/);
  assert.match(md, /决策暂停策略/);
  assert.match(md, /本步中途没有必须等人拍板的事项/);
  assert.match(md, /一批工作、一次 git 提交或进度汇报不是停工理由/);
  assert.match(md, /停工门见上文「决策暂停策略」/);
  assert.doesNotMatch(md, /完成时把本步源稿、脚本与清单全部 git 提交——不提交/);
});

test("六套模板的 TASK.md 都带本步停工清单，格式步要停下来看样张", () => {
  for (const t of PIPELINE_TEMPLATES) {
    const cfg: ProjectConfigDto = {
      artifactDir: "artifacts",
      resources: [],
      steps: t.steps,
      settings: settingsForTemplateApply(t),
      rulesOwned: true,
    };
    for (const s of t.steps) {
      const md = renderTaskMd(s, cfg, "/pilot/project");
      assert.ok(md.includes(KEEP_WORKING_CLAUSE), `${t.id}/${s.name} 缺做到做完`);
      assert.match(md, /本步必须停下来等你|本步中途没有必须等人拍板的事项/);
    }
  }
  const format = PIPELINE_TEMPLATES.find((t) => t.id === "submission-rebuttal")!
    .steps.find((s) => s.workspaceName === "journal-format")!;
  const md = renderTaskMd(format, {
    artifactDir: "artifacts", resources: [], steps: [format],
  }, "/pilot/project");
  assert.match(md, /开工前等你做完：放入成稿/);
  assert.match(md, /渲染出样张后停下来让你看版式/);
});

test("TASK.md 不含目标验收的「保持原样」段", () => {
  const md = renderTaskMd(
    step(),
    cfg({
      workMode: "research",
      steps: [step()],
      protectedPaths: ["数据/raw"],
    }),
    "/tmp/p",
  );
  assert.doesNotMatch(md, /保持原样/);
  assert.doesNotMatch(md, /数据\/raw/);
});

test("TASK.md 项目规则不含未填的全局设定空表", () => {
  const md = renderTaskMd(
    step(),
    cfg({
      workMode: "research",
      settings: [
        "优先使用项目里已有的 papers/、notes/ 和 references.bib，不要虚构文献。",
        "综述角度：（领域全景 / 聚焦某个子问题）",
        "答辩时间：（倒推各章节的截止）",
        "综述角度：聚焦某个子问题",
      ],
    }),
    "/tmp/p",
  );
  assert.match(md, /不要虚构文献/);
  assert.match(md, /综述角度：聚焦某个子问题/);
  const rules = md.split("## 待确认的全局设定")[0];
  assert.doesNotMatch(rules, /答辩时间/);
  assert.doesNotMatch(rules, /领域全景/);
  assert.match(md, /## 待确认的全局设定/);
  assert.match(md, /答辩时间：（倒推各章节的截止）/);
  assert.match(md, /先逐项问人/);
});

test("TASK.md 简报占位按挂载名单解析：换技能后正文跟随（2026-10-11 个性化机制）", () => {
  const s = step();
  s.brief = "全程按 {skill:lit-search} 技能执行，写法见 {skill:lit-notes} 技能。";
  s.skills = ["my-search", "lit-notes"];
  // 用户技能声明 provides: [lit-search] → 顶位；lit-notes 无顶位者 → 名字兜底
  const provides = { "my-search": ["lit-search"] };
  const md = renderTaskMd(s, cfg(), "/tmp/p", undefined, undefined, provides);
  assert.match(md, /全程按 my-search 技能执行/);
  assert.match(md, /写法见 lit-notes 技能/);
  assert.doesNotMatch(md, /\{skill:/);
  // 位空缺：渲染成锚名可读形态（校验层负责提醒）
  s.skills = ["lit-notes"];
  const md2 = renderTaskMd(s, cfg(), "/tmp/p", undefined, undefined, provides);
  assert.match(md2, /全程按 lit-search 技能执行/);
  assert.doesNotMatch(md2, /\{skill:/);
});
