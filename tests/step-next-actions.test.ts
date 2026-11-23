import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultActionButtonText,
  matchesPriorityFetch,
  nextActionStepSlug,
  parseStepNextActions,
  priorityFetchProgress,
  rereadPdfsTopics,
  resolveStepNextPrimary,
  stepAfterSaveLabels,
  summarizePostSaveFollowup,
  synthesizeStepNextActions,
} from "../src/step-next-actions.ts";

test("parseStepNextActions：解析标准 JSON、围栏 JSON、双栏 reads 与 remember，过滤非法动作", () => {
  const raw = [
    "```json",
    JSON.stringify({
      readiness: "ready",
      summary: "5 篇综述卡与 71 篇速读表已完成，可直接评审保存后进大纲。",
      optional: [
        {
          id: "fetch-core",
          label: "优先补齐 10 篇核心缺全文",
          detail: "Lu2024、Du2024、Xu2025 等",
          action: "fetch_pdf",
          buttonText: "补全文",
          priorityDois: ["10.1021/jacs.4c00001", "10.1002/anie.202400002"],
          priorityKeys: ["Lu2024"],
        },
        {
          id: "lit-loop",
          label: "按大纲补齐薄节与核心篇精读",
          action: "return_step",
          targetStep: "文献检索与筛选",
          topics: "3.2 节补充阴极原位 Raman",
          reads: "3.1 节精读 @Lu2024、@Du2024",
          reason: "覆盖检查标记 3.1/3.2 节偏薄",
        },
        {
          id: "mem-borate",
          label: "把硼酸盐与硼化物严格区分的口径记进项目知识",
          action: "remember",
          memoryText: "金属硼酸盐（BO3 3-，如 NiBi、Co-Bi）仅作对照，严禁混作含 M–B 键的金属硼化物 HER 主结论",
        },
        {
          id: "bad-action",
          label: "非法动作会被忽略",
          action: "unknown_action",
        },
      ],
      handedOff: "20 篇仅摘要约束与 3 组机制分歧已写入 notes/handoff.md，下一步大纲自动读取。",
    }),
    "```",
  ].join("\n");
  const parsed = parseStepNextActions(raw);
  assert.ok(parsed);
  assert.equal(parsed.readiness, "ready");
  assert.equal(parsed.optional.length, 3);
  assert.equal(parsed.optional[0].action, "fetch_pdf");
  assert.equal(parsed.optional[1].reads, "3.1 节精读 @Lu2024、@Du2024");
  assert.equal(parsed.optional[2].action, "remember");
  assert.match(parsed.optional[2].memoryText ?? "", /金属硼酸盐/);
  assert.equal(parseStepNextActions("{}"), null);
  assert.equal(parseStepNextActions("not json"), null);
});

test("resolveStepNextPrimary：随步骤状态动态切换，且有跟进更新提示时让位", () => {
  const readyPlan = parseStepNextActions(JSON.stringify({ readiness: "ready", summary: "ok", optional: [] }))!;
  const blockedPlan = parseStepNextActions(JSON.stringify({ readiness: "blocked", summary: "缺综述卡", optional: [] }))!;

  assert.deepEqual(
    resolveStepNextPrimary(readyPlan, { runStatus: "active", hasNextStep: true, nextStepName: "综述大纲" }),
    { action: "review", label: "去评审", emphasize: false },
  );
  assert.deepEqual(
    resolveStepNextPrimary(readyPlan, { runStatus: "done", hasNextStep: true, nextStepName: "综述大纲" }),
    { action: "next_step", label: "去下一步：综述大纲", emphasize: true },
  );
  assert.equal(
    resolveStepNextPrimary(readyPlan, { runStatus: "done", hasNextStep: true, nextStepName: "综述大纲", hasFollowNudge: true }),
    null,
  );
  assert.equal(
    resolveStepNextPrimary(readyPlan, { runStatus: "done", hasNextStep: false }),
    null,
  );
  assert.deepEqual(
    resolveStepNextPrimary(blockedPlan, { runStatus: "active", hasNextStep: true, nextStepName: "综述大纲" }),
    { action: "continue_chat", label: "回对话补完", emphasize: false },
  );
  const blockedForReturn = parseStepNextActions(
    JSON.stringify({
      readiness: "blocked",
      summary: "等待补读 24 篇已配对全文",
      optional: [
        {
          id: "supp-24",
          label: "退回精读步补读 24 篇",
          action: "return_step",
          buttonText: "补文献…",
          targetStep: "文献精读与笔记",
          reads: "[@Lu2024]",
        },
      ],
    }),
  )!;
  assert.deepEqual(
    resolveStepNextPrimary(blockedForReturn, { runStatus: "active", hasNextStep: true, nextStepName: "综述初稿" }),
    { action: "return_step", label: "补文献…", emphasize: true, optionId: "supp-24" },
  );
  assert.equal(defaultActionButtonText("remember"), "记进项目知识");
});

test("matchesPriorityFetch、priorityFetchProgress 与 rereadPdfsTopics：精准追踪补齐进度并生成重读清单", () => {
  const items = [
    { line: 1, title: "Paper A Cathodic Reconstruction", url: "https://doi.org/10.1021/jacs.4c00001", done: false },
    { line: 2, title: "Paper B Alkaline HER", url: "https://doi.org/10.1002/anie.202400002", done: false },
    { line: 3, title: "Other Paper", url: "https://doi.org/10.1000/other", done: false },
  ];
  assert.equal(matchesPriorityFetch(items[0], ["10.1021/jacs.4c00001"], []), true);
  assert.equal(matchesPriorityFetch(items[2], ["10.1021/jacs.4c00001"], []), false);

  const prog = priorityFetchProgress(items, { 1: "Lu2024-Cathodic.pdf" }, ["10.1021/jacs.4c00001", "10.1002/anie.202400002"], []);
  assert.equal(prog.total, 2);
  assert.equal(prog.saved, 1);
  assert.deepEqual(prog.savedTitles, ["Paper A Cathodic Reconstruction"]);
  assert.equal(rereadPdfsTopics(prog.savedTitles, prog.savedFiles), "Paper A Cathodic Reconstruction（papers/Lu2024-Cathodic.pdf）");
  assert.equal(nextActionStepSlug("lit-notes"), "lit-notes");
  assert.equal(nextActionStepSlug("step 01/a"), "step_01_a");
});

test("synthesizeStepNextActions：各步骤未写 next-actions.json 时按真实台账确定性兜底", () => {
  // 1. 检索步
  const search = synthesizeStepNextActions({
    stepKind: "search",
    nextStepName: "文献精读与笔记",
    includedJsonText: JSON.stringify([
      { id: "W1", title: "A", decision: "included", reason: "ok" },
      { id: "W2", title: "B", decision: "pending", reason: "待确认" },
    ]),
    toFetchText: "# 待获取\n\n1. A — 10.1000/a\n",
    hasScreening: true,
  });
  assert.ok(search?.synthesized);
  assert.ok(search.optional.some((o) => o.action === "confirm_pending"));
  assert.ok(search.optional.some((o) => o.action === "fetch_pdf"));

  // 2. 精读步：自动从 handoff.md「不由下一步做」提取 @bibKey 并还原 DOI
  const notes = synthesizeStepNextActions({
    stepKind: "notes",
    nextStepName: "综述大纲",
    notesIndexText: JSON.stringify([
      { id: "W1", bibKey: "Rev2024", reviewStatus: "reviewed" },
      { id: "W2", bibKey: "Lu2024", reviewStatus: "pending", skimmed: true },
    ]),
    includedJsonText: JSON.stringify([
      { id: "W2", title: "Lu Paper", decision: "included", reason: "ok", url: "https://doi.org/10.1002/smll.202408571" },
    ]),
    handoffText: "# 交接\n\n## 写作约束\n- 无\n\n## 不由下一步做\n- 优先补齐 @Lu2024 全文（WB₂@WS₂ 不是键）。\n",
    hasAngles: true,
    hasExtraction: true,
  });
  assert.ok(notes);
  const fetchOpt = notes.optional.find((o) => o.action === "fetch_pdf");
  assert.deepEqual(fetchOpt?.priorityDois, ["10.1002/smll.202408571"]);
  assert.deepEqual(fetchOpt?.priorityKeys, ["Lu2024"]);

  // 3. 大纲步：自动从覆盖检查表抽出双栏补文献（找新文献 + 精读已有的）
  const outline = synthesizeStepNextActions({
    stepKind: "outline",
    nextStepName: "综述初稿",
    searchStepName: "文献检索与筛选",
    notesStepName: "文献精读与笔记",
    outlineText: [
      "# 大纲",
      "## 覆盖检查",
      "| 节 | 可写正文篇数 | 仅线索篇数 | 最新一篇年份 | 判断 | 建议 |",
      "|---|---|---|---|---|---|",
      "| 3.1 阴极重构 | 2 | 3 | 2024 | 薄 | 补检：阴极 operando Raman 论文 |",
      "| 3.2 活性位归属 | 1 | 4 | 2024 | 薄 | 补读：[@Lu2024] [@Du2024] |",
    ].join("\n"),
  });
  assert.ok(outline);
  const loopOpt = outline.optional.find((o) => o.action === "return_step");
  assert.ok(loopOpt, "大纲覆盖检查有薄节时应合成一键补文献项");
  assert.equal(loopOpt.targetStep, "文献检索与筛选");
  assert.match(loopOpt.topics ?? "", /3\.1/);
  assert.match(loopOpt.reads ?? "", /3\.2/);

  // 4. 定稿步
  const finalStep = synthesizeStepNextActions({
    stepKind: "final",
    manuscriptFile: "manuscript/final.md",
    hasPermissions: true,
    hasDeclarations: true,
  });
  assert.ok(finalStep);
  assert.equal(finalStep.optional.length, 3);

  // 5. 已保存步骤（saved: true）：措辞切为过去时，不再写「可直接评审保存」/「可先评审」
  const savedSearch = synthesizeStepNextActions({
    stepKind: "search",
    saved: true,
    nextStepName: "文献精读与笔记",
    includedJsonText: JSON.stringify([
      { id: "W1", title: "A", decision: "included", reason: "ok" },
    ]),
    toFetchText: "# 待获取\n\n1. A — 10.1000/a\n",
    hasScreening: true,
  });
  assert.ok(savedSearch);
  assert.match(savedSearch.summary, /已保存进项目/);
  assert.doesNotMatch(savedSearch.summary, /可直接评审保存|可先评审/);
  const savedFetch = savedSearch.optional.find((o) => o.action === "fetch_pdf");
  assert.ok(savedFetch);
  assert.doesNotMatch(savedFetch.label, /可先评审/);

  // 6. 跳过的待获取篇目不计入 priorityFetchProgress 总数与缺全文计数
  const skipped = new Set(["doi:10.1021/acs.chemrev.3c00005"]);
  const prog = priorityFetchProgress(
    [
      { line: 1, title: "Mega OER Review", url: "10.1021/acs.chemrev.3c00005", done: false },
      { line: 2, title: "Core HER Paper", url: "10.1002/smll.202408571", done: false },
    ],
    { 2: "Core HER Paper.pdf" },
    ["10.1021/acs.chemrev.3c00005", "10.1002/smll.202408571"],
    [],
    skipped,
  );
  assert.equal(prog.total, 1);
  assert.equal(prog.saved, 1);
  assert.deepEqual(prog.savedFiles, ["papers/Core HER Paper.pdf"]);
});

test("stepAfterSaveLabels 与 summarizePostSaveFollowup：汇总已保存步骤未处理后续建议与保存后可做", () => {
  assert.deepEqual(
    stepAfterSaveLabels({ workspaceName: "draft", skills: ["review-writing"] }),
    ["同步到文献库"],
  );
  assert.deepEqual(
    stepAfterSaveLabels({ workspaceName: "lit-notes", skills: ["lit-notes"] }),
    ["继续精读笔记"],
  );
  assert.deepEqual(
    stepAfterSaveLabels({ workspaceName: "outline", skills: ["review-framework"] }),
    [],
  );

  const actions = parseStepNextActions(
    JSON.stringify({
      readiness: "ready",
      summary: "初稿已成",
      optional: [
        { id: "pdf", label: "审阅渲染后的英文综述初稿 PDF", action: "open_file", file: "output/draft.pdf" },
        { id: "docx", label: "打开 DOCX 版初稿（含批注）", action: "open_file", file: "output/draft.docx" },
        { id: "figs", label: "人工逐图确认 12 张拼板与 5 张机理图", action: "open_file", file: "figures/sources.md" },
      ],
    }),
  )!;

  const full = summarizePostSaveFollowup({
    stepName: "综述初稿",
    nextActions: actions,
    doneIds: new Set(["pdf"]),
    afterSaveLabels: ["同步到文献库"],
  });
  assert.ok(full);
  assert.equal(full.pendingCount, 2);
  assert.equal(full.totalCount, 3);
  assert.deepEqual(full.pendingPreviews, ["打开 DOCX 版初稿", "人工逐图确认 12 张拼板与 5 张机理图"]);
  assert.match(full.summaryText, /2 项后续建议/);
  assert.match(full.summaryText, /同步到文献库/);

  // 全部勾选且无保存后可做时返回 null，不打扰下一步
  const empty = summarizePostSaveFollowup({
    stepName: "综述大纲",
    nextActions: actions,
    doneIds: new Set(["pdf", "docx", "figs"]),
    afterSaveLabels: [],
  });
  assert.equal(empty, null);

  // spot_check 带着 file（如初稿误把查图清单写成 spot_check + figures/README.md）自动归并为 open_file；不带 file 保留 spot_check
  const normalized = parseStepNextActions(
    JSON.stringify({
      readiness: "ready",
      summary: "待核对图表",
      optional: [
        { id: "figs", label: "逐图确认", action: "spot_check", buttonText: "查图清单", file: "figures/README.md" },
        { id: "notes", label: "抽查 3 篇笔记", action: "spot_check" },
      ],
    }),
  )!;
  assert.equal(normalized.optional[0].action, "open_file");
  assert.equal(normalized.optional[0].file, "figures/README.md");
  assert.equal(normalized.optional[1].action, "spot_check");
});
