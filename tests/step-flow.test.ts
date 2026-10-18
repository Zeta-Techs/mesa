import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStepFlow,
  countToFetchEntries,
  demoReadPaperResource,
  discussChatLabel,
  doiFromToFetchUrl,
  formatZoteroAttachSummary,
  formatEndnoteOpenPrompt,
  formatZoteroDuplicatePrompt,
  isEndnoteTaskTitle,
  isPaywallTaskTitle,
  missingToFetchCount,
  parseToFetchItems,
  reviewActionVisible,
  pickDiscussResume,
  stepHasDiscussSession,
  stripOptionalTitlePrefix,
  recalledToFetchDone,
  rememberToFetchDone,
  toFetchPaperRel,
  toFetchSavedCount,
} from "../src/step-flow.ts";
import type { HumanTaskStateDto, ProjectStepDto } from "../src/types.ts";

function ht(partial: Partial<HumanTaskStateDto>): HumanTaskStateDto {
  return {
    step: "检索筛选",
    title: "事项",
    guidance: "",
    target: "",
    timing: "during",
    detected: false,
    manual: false,
    explicitCancel: false,
    done: false,
    ...partial,
  };
}

function step(partial: Partial<ProjectStepDto>): ProjectStepDto {
  return {
    name: "检索筛选",
    workspaceName: "lit",
    brief: "",
    expectedArtifacts: [],
    skills: [],
    run: [],
    ...partial,
  };
}

test("节点顺序：种子 → before → agent → during → after → 评审", () => {
  const flow = buildStepFlow({
    step: step({ discussionSeeds: ["角度怎么收？"] }),
    states: [
      ht({ title: "补文献", timing: "before" }),
      ht({ title: "补检索词", timing: "during" }),
      ht({ title: "下载付费", timing: "after" }),
    ],
    hasDraft: false,
    runStatus: "pending",
  });
  assert.deepEqual(
    flow.nodes.map((n) => `${n.kind}:${n.label}`),
    [
      "discuss:先定几件事",
      "human:补文献",
      "agent:AI 干活：检索筛选",
      "human:补检索词",
      "human:下载付费",
      "review:你核对后，保存进项目",
    ],
  );
  // 当前节点 = 第一个未完成（种子未聊）
  assert.equal(flow.currentKey, "discuss");
});

test("无决策项/种子的步骤：不生成 discuss 节点（v3.89）", () => {
  const states = [ht({ title: "补文献", timing: "before", done: true })];
  const flow = buildStepFlow({
    step: step({}),
    states,
    hasDraft: false,
    runStatus: "active",
  });
  // 没东西要定就不占流程线一格——只剩一个「跟 AI 商量」按钮的空节点
  // 白占位置还让人以为漏了什么（用户实测反馈「有点空」）
  assert.deepEqual(
    flow.nodes.map((n) => n.kind),
    ["human", "agent", "review"],
  );
  assert.equal(flow.currentKey, "agent", "before 事项已完成、agent 进行中 → 当前是 agent 节点");
});

test("Blender/库交付沉到可选区，不挡在步骤工作前面", () => {
  const extra = buildStepFlow({
    step: step({}),
    states: [],
    hasDraft: false,
    runStatus: "pending",
    toolAsks: [{ key: "illustration", label: "结构 / 装置示意" }, { key: "libraryExport", label: "文献库交付" }],
  });
  assert.equal(extra.nodes[0]?.kind, "agent");
  assert.deepEqual(extra.nodes.filter((n) => n.section === "optional").map((n) => n.key), ["tool:illustration", "tool:libraryExport"]);
  assert.equal(extra.currentKey, "agent");
  const carrier = buildStepFlow({
    step: step({}),
    states: [],
    hasDraft: false,
    runStatus: "pending",
    toolAsks: [{ key: "manuscript", label: "稿件载体" }],
  });
  assert.equal(carrier.nodes[0]?.key, "tool:manuscript");
  assert.equal(carrier.nodes[0]?.section, "main");
  assert.equal(carrier.currentKey, "agent");
});

test("去评审：待评审必给；进行中只在出字时藏，回合结束仍给", () => {
  assert.equal(reviewActionVisible("pending"), false);
  assert.equal(reviewActionVisible("active"), true);
  assert.equal(reviewActionVisible("active", true), false);
  assert.equal(reviewActionVisible("review"), true);
  assert.equal(reviewActionVisible("review", true), true);
  assert.equal(reviewActionVisible("done"), false);
});

test("runStatus 映射：review/done 都算 agent 节点完成；评审节点只在 done 完成", () => {
  const review = buildStepFlow({
    step: step({}),
    states: [],
    hasDraft: true,
    runStatus: "review",
  });
  assert.equal(review.nodes.find((n) => n.kind === "agent")?.done, true);
  assert.equal(review.nodes.find((n) => n.kind === "review")?.done, false);
  assert.equal(review.currentKey, "review");
  const done = buildStepFlow({
    step: step({}),
    states: [],
    hasDraft: true,
    runStatus: "done",
  });
  assert.equal(done.currentKey, null, "全部完成时无当前节点");
});

test("确定文献来源：默认检索开工后算交代过，当前不再钉在这一行（2026-10-17 用户截图）", () => {
  const lit = step({ asksLitSource: true });
  const before = buildStepFlow({ step: lit, states: [], hasDraft: false, runStatus: "pending", litSource: "" });
  assert.equal(before.currentKey, "input", "还没开工、来源没交代：先问来源");
  for (const runStatus of ["active", "review", "done"] as const) {
    const flow = buildStepFlow({ step: lit, states: [], hasDraft: false, runStatus, litSource: "search" });
    assert.equal(flow.nodes.find((n) => n.key === "input")?.done, true, runStatus);
  }
  const review = buildStepFlow({ step: lit, states: [], hasDraft: false, runStatus: "review", litSource: "" });
  assert.equal(review.currentKey, "review", "AI 交付后当前是去评审，不是来源");
  const picked = buildStepFlow({ step: lit, states: [], hasDraft: false, runStatus: "pending", litSource: "zotero" });
  assert.equal(picked.currentKey, "agent");
});

test("after 事项未完成时卡在 after 节点（评审之前）", () => {
  const flow = buildStepFlow({
    step: step({}),
    states: [ht({ title: "下载付费", timing: "after" })],
    hasDraft: true,
    runStatus: "review",
  });
  assert.equal(flow.currentKey, "human:下载付费");
});

test("EndNote 交差在精读开工前就列出，不挡开工、不靠项目设置", () => {
  const pending = buildStepFlow({
    step: step({}),
    states: [],
    hasDraft: false,
    runStatus: "pending",
    endnoteExport: true,
  });
  const early = pending.nodes.find((n) => n.key === "endnote-export");
  assert.equal(early?.section, "optional");
  assert.equal(early?.skipCurrent, true);
  const done = buildStepFlow({
    step: step({}),
    states: [],
    hasDraft: true,
    runStatus: "done",
    endnoteExport: true,
  });
  const endnote = done.nodes.find((n) => n.key === "endnote-export");
  assert.equal(endnote?.label, "同步到文献库");
  assert.equal(endnote?.section, "optional");
  assert.ok(
    done.nodes.findIndex((n) => n.kind === "review") <
      done.nodes.findIndex((n) => n.key === endnote?.key),
  );
});

test("继续精读笔记在 EndNote 底下，开工前也列出，不挡开工", () => {
  const pending = buildStepFlow({
    step: step({ skills: ["lit-notes"] }),
    states: [],
    hasDraft: false,
    runStatus: "pending",
    endnoteExport: true,
    continueNotes: true,
  });
  assert.equal(pending.nodes.find((n) => n.key === "continue-notes")?.section, "optional");
  const done = buildStepFlow({
    step: step({ skills: ["lit-notes"] }),
    states: [],
    hasDraft: true,
    runStatus: "done",
    endnoteExport: true,
    continueNotes: true,
  });
  const keys = done.nodes.filter((n) => n.section === "optional").map((n) => n.key);
  assert.deepEqual(keys.slice(0, 2), ["endnote-export", "continue-notes"]);
  assert.equal(done.nodes.find((n) => n.key === "continue-notes")?.skipCurrent, true);
});

test("可选 after 事项进主干但不抢「当前节点」（v3.97）", () => {
  const flow = buildStepFlow({
    step: step({}),
    states: [ht({ title: "下载付费", timing: "after", optional: true })],
    hasDraft: true,
    runStatus: "review",
  });
  // 进主干：出现在评审之前（用户拍板：可选项不该沉到分隔线下像不存在）
  const kinds = flow.nodes.map((n) => `${n.kind}:${n.section}`);
  assert.deepEqual(kinds, [
    "agent:main",
    "human:main",
    "review:main",
  ]);
  // 但它不做也能跑完——当前节点跳过它直奔评审
  assert.equal(flow.currentKey, "review");
});

test("可选事项标题去掉「（可选）」前缀，分区已经标明", () => {
  assert.equal(stripOptionalTitlePrefix("（可选）配置学术检索 MCP"), "配置学术检索 MCP");
  const flow = buildStepFlow({
    step: step({}),
    states: [
      ht({
        title: "（可选）配置学术检索 MCP",
        timing: "before",
        optional: true,
      }),
    ],
    hasDraft: false,
    runStatus: "pending",
  });
  const node = flow.nodes.find((n) => n.kind === "human");
  assert.equal(node?.section, "optional");
  assert.equal(node?.label, "配置学术检索 MCP");
});

test("决策项未拍板完：discuss 节点不算完成，即使草稿已存在", () => {
  const s = step({
    discussionSeeds: [],
    decisions: [
      { q: "综述角度怎么收", options: ["领域全景铺开", "聚焦子问题"] },
      { q: "纳入标准定多严", options: ["只要顶刊", "含预印本"] },
    ],
  });
  // 只答了一条：草稿已存在，但还剩 1 件没拍板
  const partial = buildStepFlow({
    step: s,
    states: [],
    hasDraft: true,
    runStatus: "pending",
    pendingDecisions: 1,
  });
  const d1 = partial.nodes.find((n) => n.key === "discuss")!;
  assert.equal(d1.done, false, "还有没答的题就不该打勾");
  assert.match(d1.label, /还有 1 件/);
  assert.equal(partial.currentKey, "discuss", "当前节点应停在定方向");

  // 全部拍板完
  const all = buildStepFlow({
    step: s,
    states: [],
    hasDraft: true,
    runStatus: "pending",
    pendingDecisions: 0,
  });
  assert.equal(all.nodes.find((n) => n.key === "discuss")!.done, true);
  assert.equal(all.currentKey, "agent", "定方向做完，当前节点推进到 agent");
});

test("只有决策项、没有讨论种子：discuss 节点照常出现", () => {
  const flow = buildStepFlow({
    step: step({
      discussionSeeds: [],
      decisions: [{ q: "算力怎么排", options: ["本机跑", "上集群"] }],
    }),
    states: [],
    hasDraft: false,
    runStatus: "pending",
    pendingDecisions: 1,
  });
  assert.ok(flow.nodes.some((n) => n.key === "discuss"));
});

test("EndNote 交差事项按标题识别", () => {
  assert.equal(isEndnoteTaskTitle("导入到 EndNote"), true);
  assert.equal(isPaywallTaskTitle("导入到 EndNote"), false);
});

test("既无决策项也无种子：不生成 discuss 节点，当前直接落 agent（v3.89）", () => {
  const flow = buildStepFlow({
    step: step({ discussionSeeds: [], decisions: [] }),
    states: [],
    hasDraft: false,
    runStatus: "pending",
  });
  assert.equal(
    flow.nodes.find((n) => n.key === "discuss"),
    undefined,
    "没东西要定就不生成该节点（想法区改挂 agent 节点，见 StepFlow.tsx hasDiscussNode）",
  );
  assert.equal(flow.currentKey, "agent");
});

test("有种子但无决策项：discuss 节点仍在（种子就是要聊的东西）", () => {
  const flow = buildStepFlow({
    step: step({ discussionSeeds: ["范式锚点：借哪篇的结构？"], decisions: [] }),
    states: [],
    hasDraft: false,
    runStatus: "pending",
  });
  assert.ok(
    flow.nodes.find((n) => n.key === "discuss"),
    "配了种子 = 模板认为这一步有东西要商量",
  );
});

const paper = { type: "paper", path: "papers/demo.pdf" };
const demoSteps = [
  step({ name: "文献检索与筛选", seedComplete: true, skills: ["lit-search"] }),
  step({ name: "文献精读与笔记", skills: ["lit-notes"] }),
];

test("开读这一篇：普通模板即使有 PDF 也不出按钮", () => {
  const templateSteps = [
    step({ name: "文献检索与筛选", skills: ["lit-search"] }),
    step({ name: "文献精读与笔记", skills: ["lit-notes"] }),
  ];
  assert.equal(
    demoReadPaperResource({
      steps: templateSteps,
      focusStepName: "文献精读与笔记",
      resources: [paper],
    }),
    undefined,
  );
  assert.equal(
    demoReadPaperResource({
      steps: templateSteps,
      focusStepName: "文献检索与筛选",
      resources: [paper],
    }),
    undefined,
  );
});

test("开读这一篇：示例课题只在精读步且已有 PDF 时才出", () => {
  assert.equal(
    demoReadPaperResource({
      steps: demoSteps,
      focusStepName: "文献检索与筛选",
      resources: [paper],
    }),
    undefined,
  );
  assert.equal(
    demoReadPaperResource({
      steps: demoSteps,
      focusStepName: "文献精读与笔记",
      resources: [{ type: "paper", path: "papers/notes.md" }],
    }),
    undefined,
  );
  assert.equal(
    demoReadPaperResource({
      steps: demoSteps,
      focusStepName: "文献精读与笔记",
      resources: [paper],
    }),
    paper,
  );
});

test("商量入口：能接回上次会话才叫继续讨论", () => {
  assert.equal(discussChatLabel(false), "跟 AI 商量一下");
  assert.equal(discussChatLabel(true), "继续讨论");
  const old = {
    agent: "codex",
    sessionId: "s-old",
    stepName: "文献检索与筛选",
    archived: false,
    internal: false,
    live: false,
    updatedAt: "2026-09-01T00:00:00Z",
  };
  const newer = {
    ...old,
    sessionId: "s-new",
    updatedAt: "2026-09-14T00:00:00Z",
  };
  assert.equal(pickDiscussResume([old, newer], "文献检索与筛选")?.sessionId, "s-new");
  assert.equal(
    pickDiscussResume([{ ...newer, live: true }, old], "文献检索与筛选")?.sessionId,
    "s-new",
  );
  assert.equal(pickDiscussResume([{ ...newer, archived: true }], "文献检索与筛选"), null);
  assert.equal(pickDiscussResume([{ ...newer, internal: true }], "文献检索与筛选"), null);
  assert.equal(stepHasDiscussSession([newer], "文献检索与筛选"), true);
  assert.equal(stepHasDiscussSession([newer], "文献精读与笔记"), false);
});

test("付费墙任务判定与待获取清单计数", () => {
  assert.equal(isPaywallTaskTitle("下载付费墙文献全文"), true);
  assert.equal(isPaywallTaskTitle("配置学术检索 MCP"), false);
  // 列表条目计数：markdown 列表行算，标题/说明/空行不算
  const md = [
    "# 待获取清单",
    "",
    "以下文献缺全文：",
    "- Paper A (doi:10.1/x)",
    "- Paper B",
    "1. Paper C",
    "",
    "说明文字一行",
  ].join("\n");
  assert.equal(countToFetchEntries(md), 3);
  assert.equal(countToFetchEntries(""), 0);
  // 裸行清单（老项目格式）也计入——此前只数带符号行显示「缺 0 篇」（2026-09-16）
  assert.equal(
    countToFetchEntries(
      "# 待获取全文\n\n说明行不算。\n\n标题一 — 10.1002/a\n标题二 — 10.1002/b\n没尾巴的裸行不算\n",
    ),
    2,
  );
});

test("parseToFetchItems：编号条目行解析（标题 — DOI，✓ 记已补齐）", () => {
  const md = [
    "# 待获取清单",
    "",
    "以下文献缺全文，补齐后编号后打 ✓：",
    "1. Deep Learning for Materials — 10.1002/adma.202304268",
    "2. ✓ Graph Neural Networks Survey — 10.1109/TPAMI.1",
    "3. 无链接的条目",
    "4. 落地链接条目 — https://www.sciencedirect.com/science/article/pii/X",
    "- 不是编号行的列表条目",
  ].join("\n");
  const items = parseToFetchItems(md);
  assert.equal(items.length, 5);
  assert.deepEqual(items[0], {
    line: 4,
    title: "Deep Learning for Materials",
    url: "10.1002/adma.202304268",
    done: false,
    venue: "",
  });
  assert.equal(items[1].done, true);
  assert.equal(items[1].title, "Graph Neural Networks Survey");
  assert.equal(items[2].url, "");
  assert.equal(items[3].url, "https://www.sciencedirect.com/science/article/pii/X");
  // 旧列表符号行：无链接也保留（url 空占位）
  assert.equal(items[4].title, "不是编号行的列表条目");
  assert.equal(items[4].url, "");
  assert.equal(parseToFetchItems("").length, 0);
  // 单段条目（没有 — 分隔）：标题即全文，url 留空不误吞
  const single = parseToFetchItems("1. Just A Title");
  assert.equal(single[0].title, "Just A Title");
  assert.equal(single[0].url, "");
});

test("parseToFetchItems：旧格式裸行（无编号无符号）也出条目，说明文字不误收", () => {
  const md = [
    "# 待获取全文",
    "",
    "以下为已纳入但项目资源未见对应 PDF 的文献；开放获取自动下载结果见 papers/screening.md。",
    "",
    "Scalable synthesis of ferroelectric HfO2 films — 10.1002/adfm.202300001",
    "",
    "1Tb/Si composite thin films — 10.1063/5.0123456",
    "有破折号的说明行 — 但尾巴不是链接",
  ].join("\n");
  const items = parseToFetchItems(md);
  // 两行裸条目认出；说明行/无链接尾巴的行不收
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Scalable synthesis of ferroelectric HfO2 films");
  assert.equal(items[0].url, "10.1002/adfm.202300001");
  assert.equal(items[1].line, 7);
  // 标题内含「 — 」：最后一段才当链接，其余归标题
  const titled = parseToFetchItems("A study — of two parts — 10.1002/x.1");
  assert.equal(titled[0].title, "A study — of two parts");
  assert.equal(titled[0].url, "10.1002/x.1");
});

test("parseToFetchItems：DOI 后面的刊名和标记不吞进链接", () => {
  const line =
    "1. Boride review — 10.1002/adfm.201906481 — Advanced Functional Materials〔缩写：Adv. Funct. Mater.〕〔OA〕";
  const [item] = parseToFetchItems(line);
  assert.equal(item.url, "10.1002/adfm.201906481");
  assert.equal(item.venue, "Advanced Functional Materials");
  assert.equal(item.title, "Boride review");
  const marked = parseToFetchItems("2. [已补] Paper — https://doi.org/10.1016/j.cej.2021.1 — 全文 papers/a.pdf");
  assert.equal(marked[0].url, "https://doi.org/10.1016/j.cej.2021.1");
  const checkbox = parseToFetchItems(
    "1. [ ] Novel 2D Material of MBenes — 10.1002/smll.202405870 — Small",
  );
  assert.equal(checkbox[0].title, "Novel 2D Material of MBenes");
  assert.equal(checkbox[0].done, false);
  assert.equal(checkbox[0].url, "10.1002/smll.202405870");
  assert.equal(checkbox[0].venue, "Small");
});


test("missingToFetchCount：折起态计数去掉已勾与已存（2026-09-17 审计）", () => {
  // ✓ 紧跟编号（parseToFetchItems 的口径：`N. ✓ 标题`）
  const md = [
    "1. ✓ Paper One — 10.1/a",
    "2. Paper Two — 10.1/b",
    "3. Paper Three — 10.1/c",
    "4. ✓ Paper Four — 10.1/d",
  ].join("\n");
  // 都没对照 papers/：缺 2（两条已勾 ✓ 不算）
  assert.equal(missingToFetchCount(md, {}), 2);
  // 行 2 已对照上 papers/（to_fetch_progress 的行号映射）：只缺行 3
  assert.equal(missingToFetchCount(md, { 2: "Paper Two.pdf" }), 1);
  // 全部处理完：0
  assert.equal(
    missingToFetchCount(md, { 2: "Paper Two.pdf", 3: "Paper Three.pdf" }),
    0,
  );
  assert.equal(missingToFetchCount("", {}), 0);
});

test("toFetchSavedCount：已勾与对照 papers/ 都算已存", () => {
  const items = parseToFetchItems(
    ["1. ✓ Paper One — 10.1/a", "2. Paper Two — 10.1/b", "3. Paper Three — 10.1/c"].join(
      "\n",
    ),
  );
  assert.equal(toFetchSavedCount(items, {}), 1);
  assert.equal(toFetchSavedCount(items, { 2: "Paper Two.pdf" }), 2);
  assert.equal(toFetchSavedCount([], {}), 0);
});

test("rememberToFetchDone：切走再回来第一帧能拿到已存对照", () => {
  rememberToFetchDone("/p", { 2: "Paper Two.pdf", 5: "Paper Five.pdf" });
  assert.deepEqual(recalledToFetchDone("/p"), {
    2: "Paper Two.pdf",
    5: "Paper Five.pdf",
  });
  assert.deepEqual(recalledToFetchDone("/other"), {});
  const a = recalledToFetchDone("/p");
  a[2] = "mutated.pdf";
  assert.equal(recalledToFetchDone("/p")[2], "Paper Two.pdf");
});

test("toFetchPaperRel：只取文件名落到 papers/", () => {
  assert.equal(toFetchPaperRel("Paper Two.pdf"), "papers/Paper Two.pdf");
  assert.equal(toFetchPaperRel("sub/Paper Two.pdf"), "papers/Paper Two.pdf");
  assert.equal(toFetchPaperRel("C:\\\\tmp\\\\Paper Two.pdf"), "papers/Paper Two.pdf");
  assert.equal(toFetchPaperRel("  "), "");
  assert.equal(toFetchPaperRel(""), "");
});

test("doiFromToFetchUrl：裸 DOI、doi.org、无 DOI", () => {
  assert.equal(doiFromToFetchUrl("10.1021/abc"), "10.1021/abc");
  assert.equal(doiFromToFetchUrl("doi:10.1021/ABC."), "10.1021/abc");
  assert.equal(doiFromToFetchUrl("https://doi.org/10.1021/abc"), "10.1021/abc");
  assert.equal(doiFromToFetchUrl("https://example.com/article"), null);
  assert.equal(doiFromToFetchUrl(""), null);
});

test("formatZoteroDuplicatePrompt：没开或 0 命中不出确认", () => {
  assert.equal(
    formatZoteroDuplicatePrompt({ reachable: false, present: 0, total: 10 }),
    null,
  );
  assert.equal(
    formatZoteroDuplicatePrompt({ reachable: true, present: 0, total: 10 }),
    null,
  );
  const line = formatZoteroDuplicatePrompt({
    reachable: true,
    present: 21,
    total: 89,
  });
  assert.ok(line?.includes("21"));
  assert.ok(line?.includes("89"));
  const endnote = formatEndnoteOpenPrompt(12);
  assert.match(endnote, /12/);
  assert.match(endnote, /仍要打开/);
  assert.match(formatEndnoteOpenPrompt(0), /endnote-import\.ris/);
});

test("formatZoteroAttachSummary：界面只留一句，失败明细另放", () => {
  const empty = formatZoteroAttachSummary({
    attached: [],
    created: [],
    skipped: [],
    missing: [],
    unmatched: [],
  });
  assert.equal(empty.line, "没有新东西可同步");
  assert.equal(empty.detail, undefined);

  const mixed = formatZoteroAttachSummary({
    attached: ["a"],
    created: ["b", "c"],
    skipped: [],
    missing: ["d", "e", "f"],
    unmatched: [],
    failed: ["Paper A：error decoding", "Paper B：timeout", "Paper C：x", "Paper D：y"],
  });
  assert.equal(mixed.line, "挂上 1 篇 · 新建 2 篇 · 还没拿到全文 3 篇 · 失败 4 篇");
  assert.equal(
    mixed.detail,
    "Paper A：error decoding；Paper B：timeout；Paper C：x 等",
  );
});

test("parseToFetchItems：「[已补 …]」前缀记已补齐、标题不带它；分隔线后的线索段不算待获取", () => {
  const md = [
    "# 待获取清单",
    "",
    "1. A Bismuth-Based Protective Layer — https://doi.org/10.1021/acsenergylett.1c01243",
    "2. [已补 2026-09-24] An artificial interphase — https://doi.org/10.1016/j.cej.2021.130751 — 全文 papers/x.pdf",
    "3. [已补·全文已在项目根 2026-09-24] A practical perspective — 10.1039/D2EE04121A",
    "",
    "---",
    "",
    "## 精读中发现的待跟进引用",
    "- Zhang J. et al., Energy Environ. Sci. 2023 — 界面钝化起源",
    "- Gao T. et al., ACS AMI 2018 — XPS 证据",
  ].join("\n");
  const items = parseToFetchItems(md);
  assert.equal(items.length, 3);
  assert.equal(items[1].title, "An artificial interphase");
  assert.equal(items[1].done, true);
  assert.equal(items[2].title, "A practical perspective");
  assert.equal(items[2].done, true);
  assert.equal(items[0].done, false);
  // 条目开始前的分隔线不截断
  assert.equal(parseToFetchItems("说明\n\n---\n\n1. T — 10.1/x\n").length, 1);
});
