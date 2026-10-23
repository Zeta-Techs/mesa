import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { PIPELINE_TEMPLATES, settingsForTemplateApply, pipelineStepsForTemplate } from "../src/pipeline-presets.ts";
import { renderTaskMd } from "../src/task-md.ts";

const find = (id: string) => PIPELINE_TEMPLATES.find((t) => t.id === id)!;
const md = (id: string) => find(id).steps.map((s) => renderTaskMd(s, {
  resources: [], steps: find(id).steps, artifactDir: "artifacts", settings: settingsForTemplateApply(find(id)), rulesOwned: true,
}, "/pilot/project"));

test("任务书减重不靠删阶段/门禁：共用摘要一次，格式适配不重复终审", () => {
  // 上限含按步骤派生的停工清单（拍板/先报再问/样张）。
  // 上限含论文大纲、结论条目、章节状态和先报告后改稿。再涨要说明加了什么合同。
  // 这三个上限原先就已过时（HEAD 上 review 21798/21200、论文 32338/31900、学位 29899/29400 全超），
  // 本轮涨的是 review +853、论文两模板各 +131，全是新加的合同：
  //   · 图件：figures/README.md 升为必须产物，正文新增 machine:not-contains:manuscript/draft.md::待绘制，
  //     挡住「先写待绘制、回头再补图」——占位符一旦进正文就没人回头补。
  //   · 交棒：notes/handoff.md 升为必须产物并挂写作约束门禁，outline 接它作输入；
  //     同时挪掉「核心篇名单」那个人工确认门（净减一道停工）。
  //   · 缩写：lit-search 的刊名缩写从 NLM ISSN 查询改成 ISO 4 规则自算，不必联网。
  // 上限取整到百位，比当前文本高一点的余量，留给下一轮微量改字——真加合同仍须回来写明。
  // 本轮 review 再 +343（实测 22994）：引用样式的交接改成「按流程线选定、结果写 submission/
  // target-journal.md」，各渲染步简报都写明了选定处；润色步那句同步改成读已定期刊。
  // 紧接一轮再 +411（实测 23405）：润色步新增 5b——agent 按 [待核实] 与「疑似编造/元数据存疑」
  // 列全 manuscript/verification-decisions.md（裁决栏留空，不得代填），并升为预期产物；
  // 人工事项「逐条裁决」改带落点、走 decisions_cleared 判定，未裁决拦住定稿。
  // 又一轮（review 实测 23447、论文 32484、学位 30103）：三套定稿步的「更换引用样式」
  // 换成「确认引用样式」——带落点 manuscript/citation-confirmed.md（确认绑定当时 csl 版本，
  // csl 一变确认失效）并补上核实项说明，比原来的空 guidance 长。
  // 上限取 23550 / 32550 / 30150，仍在下一轮微量改字的余量内。
  // 2026-09-29：审查决定改成步骤上点，REVIEW_FIRST 写明「决定：」行。学位模板实测 30305，上限提到 30450。
  // 同日：初稿增加正文字体确认。综述 23659、论文 32841、学位 30518，上限提到 23800 / 33000 / 30700。
  // 2026-09-30：初稿字体改到开工时问，并列入 typeface.md / reference.docx；润色步不再必交 target-journal.md。
  // 同日：论文/学位论文定稿步改成与综述同一句「沿用编号不写 target-journal.md」，并写明沿用 typeface.md。
  // 实测 review 24378、论文 33079、学位 30881。上限取整到百位，留一点改字余量。
  // 2026-10-10：三模板检索步加「标准档发现不空转」（LIT_SEARCH_NO_WASTE：只 OpenAlex 一条主检索式、
  // 429 记缺口不重试、缩写与 RIS 只做一次）＋开放获取 3 次 403 停手；to-fetch 题录改用 Crossref 标题
  // （上下标收成 Unicode、不用 OpenAlex display_name 覆盖）；精读步新增「按已对上 DOI 的 PDF 首页/摘要页
  // 校正 references.bib 的标题与摘要」条款（三模板同一句）。实测 review 24948、论文 33979、学位 31784，
  // 上限提到 25100 / 34200 / 32000。
  // 2026-10-13：双台账拍板——三条检索链各加「积累进料」句（handoff-lit-intake.md/reading-list.md
  // 统一去重并入、不回写不清空）＋「开工时清单存量条目=进料口」句。实测 review 25365、论文 34310、
  // 学位 32115，上限提到 25700 / 34700 / 32500。
  // 2026-10-17 审查修复：精读步写明「排除篇不建索引行」「notes/excerpts.md 摘录并进笔记」（三模板同一句）；
  // 综述初稿先读 handoff「写作约束」；引用样式统一由流程线选（不再「开工先问」）；Word 模板改由
  // YAML 的 format.docx 承载的说明句。实测 review 25933、论文 34591、学位 32543，
  // 上限提到 26100 / 34800 / 32700。
  // 2026-10-22 检索步复查：产物目录段加「要提交的脚本放 scripts/」一句（每步都有产物目录段，六模板同涨）；
  // 检索/精读两步加开放获取版本规则（不收预印本时预印本服务器上的版本不下）。实测 review 26605、论文 35543、
  // 数据 12174、学位 33495、投稿 8713、LaTeX 13303，上限取整到百位留余量。
  // 同日再加一句：决策暂停策略带人工请求文件的用法（只放没答的、答完删、不提交；每步一句，六模板同涨）。
  // 实测 review 26621、论文 36303、数据 12734、学位 34257、投稿 8993、LaTeX 13863。
  // 2026-10-23 检索链加「人导入的每条进 included.json、Agent 不排除」一句（三模板同涨）。实测 review 26884、论文 36437、学位 34391。
  // 同日再改：综述拼图按论点取子图（笔记可引用图细到子图、大纲用图计划逐块列、初稿裁子图流程）。实测 review 27082、论文 36466、学位 34420。
  // 2026-10-24 初稿步加拼图块数按可读性、每块记来源生成 figures/sources.md 两句。实测 review 27303。
  // 同日再加：综述定稿步写换原图与转载许可清单一条。实测 review 27799。
  // 同日再加：综述定稿步写投稿声明空白模板一条（作者、基金、利益冲突、AI 使用声明由人填）。实测 review 28194。
  const before: Record<string, number> = { review: 28400, "research-paper": 36600, "data-processing": 12900, thesis: 34600, "submission-rebuttal": 9100, "latex-paper": 14000 };
  for (const t of PIPELINE_TEMPLATES) {
    const tasks = md(t.id);
    assert.ok(tasks.reduce((n, s) => n+s.length, 0) < before[t.id], t.id);
    for (const task of tasks) {
      assert.equal(task.split("验收摘要放在本步主要报告开头").length-1, 1);
      for (const text of ["关键证据/复现入口", "尚未验证", "影响结论的未决问题", "需要人决定", "未经重验不得复用旧结论"]) assert.ok(task.includes(text), text);
    }
    assert.ok(!t.projectRules?.some((line) => line.includes("质量状态")), "共用摘要不在项目规则重复");
  }
  const format = find("submission-rebuttal").steps[0];
  assert.doesNotMatch(format.brief, /G5 投稿就绪/);
  assert.match(format.brief, /交下一步投稿材料统一关闭/);
  assert.match(find("submission-rebuttal").steps[1].brief, /G5 投稿就绪/);
  assert.match(pipelineStepsForTemplate(find("submission-rebuttal"), "revision", 2)[0].brief, /G5 投稿就绪/);
});

test("没选引用样式仍渲，不定期刊不交空的目标期刊文件", () => {
  for (const id of ["review", "research-paper", "thesis"]) {
    const t = find(id);
    const draft = t.steps.find((s) =>
      (s.expectedArtifacts ?? []).some((p) => p === "manuscript/typeface.md"),
    )!;
    assert.ok(draft, `${id} 初稿要登记 typeface.md`);
    assert.ok(
      (draft.expectedArtifacts ?? []).includes("manuscript/reference.docx"),
      `${id} 初稿要登记 reference.docx`,
    );
    const final = t.steps.find((s) =>
      ["polish", "research-paper-polish", "thesis-final"].includes(s.workspaceName ?? ""),
    )!;
    assert.match(final.brief, /沿用编号就不要写这份文件/);
    assert.match(final.brief, /不因没选样式停渲|不因没有 citation-style\.md 停渲/);
    assert.match(final.brief, /manuscript\/typeface\.md/);
    assert.ok((final.inputs ?? []).includes("manuscript/typeface.md"), `${id} 定稿要读 typeface.md`);
    assert.ok((final.inputs ?? []).includes("manuscript/reference.docx"));
    assert.ok(
      !(final.expectedArtifacts ?? []).includes("submission/target-journal.md"),
      `${id} 定稿不把目标期刊当必交`,
    );
    assert.doesNotMatch(final.brief, /没有就问刊名/);
  }
  const journal = find("submission-rebuttal").steps[0];
  assert.ok((journal.expectedArtifacts ?? []).includes("submission/target-journal.md"));
  const skill = readFileSync("src-tauri/resources/skills/quarto-render/SKILL.md", "utf8");
  assert.match(skill, /不因没选样式/);
  assert.match(skill, /不要先用默认字体渲完再重渲/);
  assert.doesNotMatch(skill, /然后重渲/);
});

test("人看决策摘要而非凭空保证；实际复现入口进入产物和下游输入", () => {
  for (const id of ["research-paper", "thesis"]) {
    const t = find(id);
    const run = t.steps.find((s) => s.expectedArtifacts.includes("results/run-manifest.json"))!;
    assert.ok(run.expectedArtifacts.includes("experiments/reproduce.py"));
    const analysis = t.steps.find((s) => s.inputs?.includes("results/run-manifest.json"))!;
    assert.ok(analysis.inputs?.includes("experiments/reproduce.py"));
    const tasks = md(id).join("\n");
    for (const token of ["决策摘要（先看方案", "可行方案", "代价/不确定性", "推荐不是批准", "--input/--output", "失败非零退出"]) assert.ok(tasks.includes(token), token);
  }
  const data = find("data-processing").steps.find((s) => s.workspaceName === "data-eda")!;
  assert.ok(data.expectedArtifacts.includes("analysis/reproduce.py"));
  for (const name of ["review-writing", "review-framework"]) {
    const text = readFileSync(`src-tauri/resources/skills/${name}/SKILL.md`, "utf8");
    assert.doesNotMatch(text, /每节要点（3-6 条）|每个主题组至少一处批判|批判词缺位|\*\*2-3 篇/);
  }
});

test("离线故障试跑与交付入口实际运行：拒绝缺证据/漂移/错数/覆盖原目录", () => {
  const dir = mkdtempSync(join(tmpdir(), "mesa-usability-pilot-"));
  const sources = join(dir, "sources"); mkdirSync(sources);
  // Test fixtures are explicitly synthetic; real full-text trial is a separate recorded run.
  for (const name of ["cawley2010-fulltext.txt", "varma2006-fulltext.txt"]) writeFileSync(join(sources, name), "OFFLINE TEST FIXTURE, NOT PAPER CONTENT.\n".repeat(40));
  const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  const output = join(dir, "pilot");
  const run = (args: string[]) => spawnSync(python, ["scripts/research-pilot.py", ...args], { encoding: "utf8", timeout: 60000 });
  try {
    const made = run(["create", "--sources", sources, "--literature", "tests/fixtures/research-pilot/literature.json", "--output", output]);
    assert.equal(made.status, 0, made.stderr || String(made.error));
    const results = JSON.parse(readFileSync(join(output, "pilot-results.json"), "utf8"));
    assert.equal(results.computationalRuns, 36);
    assert.equal(results.humanApproval, false);
    assert.equal(results.faults.length, 8);
    assert.ok(results.faults.every((x: {blocked:boolean}) => x.blocked));
    const rebuilt = join(dir, "rebuilt");
    const call = run(["reproduce", "--input", join(output, "computational"), "--output", rebuilt]);
    assert.equal(call.status, 0, call.stderr);
    assert.equal(readFileSync(join(rebuilt, "analysis/results-table.md"), "utf8"), readFileSync(join(output, "computational/analysis/results-table.md"), "utf8"));
    const overwrite = run(["reproduce", "--input", join(output, "computational"), "--output", rebuilt]);
    assert.notEqual(overwrite.status, 0);
    const nested = join(output, "computational", "unsafe-output");
    assert.notEqual(run(["reproduce", "--input", join(output, "computational"), "--output", nested]).status, 0);
    assert.equal(existsSync(nested), false);
    for (const [kind, name] of [["literature", "wrong-key"], ["computational", "data-drift"], ["computational", "missing-run"]]) {
      const failedOutput = join(dir, `blocked-${name}`);
      const failed = run(["reproduce", "--input", join(output, `${kind}-checks`, "faults", name), "--output", failedOutput]);
      assert.equal(failed.status, 2, failed.stderr);
      assert.equal(existsSync(failedOutput), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
