import assert from "node:assert/strict";
import test from "node:test";
import {
  catchUpProbes,
  catchUpPrompt,
  followupFiles,
  followupPrompt,
  followupScale,
  followupConfirmText,
  readableDiff,
  roundChangeLabel,
  isLedgerFile,
  catchUpConfirmText,
  notesFollowupIds,
  notesDroppedIds,
  parseTopics,
  reworkPrompt,
  latestNote,
  withLatestNote,
  reworkTargets,
  roundCauseLabel,
} from "../src/step-loop.ts";

test("parseTopics：一行一条，去掉列表记号与空行", () => {
  assert.deepEqual(parseTopics("- §3.2 失活机理\n\n2. 原位表征\n* 动力学\n  "), ["§3.2 失活机理", "原位表征", "动力学"]);
});

test("parseTopics：节号不是序号——「3.2 失活机理」原样保留；「3. x」「3、x」「3）x」照去", () => {
  assert.deepEqual(parseTopics("3.2 失活机理\n3. 原位表征\n4、动力学\n5）成本\n6) 展望\n12.3.1 细节\n• 机理"), [
    "3.2 失活机理",
    "原位表征",
    "动力学",
    "成本",
    "展望",
    "12.3.1 细节",
    "机理",
  ]);
});

test("reworkPrompt：补料单原文进指令；检索步与其他步写法不同；线索、规模可选", () => {
  const rework = {
    fromStep: "综述大纲",
    topics: ["§3.2 失活机理"],
    reason: "可写正文只有 2 篇",
    clues: "",
    scale: null,
    relPath: ".ccode/rework/1-lit-search.json",
  };
  const search = reworkPrompt(rework, { isSearch: true, projectRoot: "/p/proj/", date: "11-05" });
  assert.match(search, /「综述大纲」退回来的/);
  assert.match(search, /1\. §3\.2 失活机理/);
  assert.match(search, /不重筛、不改判定/);
  assert.match(search, /补料单原件：\/p\/proj\/\.ccode\/rework\/1-lit-search\.json/);
  assert.doesNotMatch(search, /线索：|规模/);
  assert.match(search, /先看单上这些节在大纲里要写什么.*按这些去找/);
  assert.match(search, /按技能「引用扩展」/);
  const other = reworkPrompt({ ...rework, clues: "Zhang 2024", scale: 8 }, { isSearch: false, projectRoot: "C:\\p", date: "11-05" });
  assert.match(other, /线索：Zhang 2024/);
  assert.match(other, /不超过 8 篇/);
  assert.match(other, /用户确认过的内容不推翻/);
  assert.match(other, /C:\\p\\\.ccode\\rework\\1-lit-search\.json/);
  assert.doesNotMatch(other, /outline\.md|引用扩展/, "退回大纲 / 初稿等不加文献类的指引");
  assert.match(other, /这是一轮修改.*只改下面列的/);
  assert.match(other, /要改：\n1\. §3\.2 失活机理/);
  assert.match(other, /「## 修改轮（11-05）」/);
  assert.doesNotMatch(other, /补料轮|只补/);
  assert.match(search, /这是一轮补料/);
});

test("reworkPrompt：退回精读的点名篇写成完整笔记，不照任务书只速读；不提主要报告", () => {
  const notes = reworkPrompt(
    { fromStep: "综述大纲", topics: ["3.3 动力学：[@Wu2023] [@Li2024]"], reason: "薄", clues: "", scale: null, relPath: ".ccode/rework/2.json" },
    { isSearch: false, isNotes: true, projectRoot: "/p", date: "11-05" },
  );
  assert.match(notes, /完整精读笔记/);
  assert.match(notes, /reviewStatus=reviewed/);
  assert.match(notes, /去掉 skimmed/);
  assert.match(notes, /对这几篇不适用/);
  assert.doesNotMatch(notes, /主要报告/);
  assert.match(notes, /按这些去读/);
  assert.doesNotMatch(notes, /引用扩展/);
  assert.match(notes, /写作约束按新笔记改到现在成立的样子（新补的约束加上，不再成立的删掉），不记改动经过/);
});

test("notesFollowupIds：纳入里索引还没有的（上游新加的）；索引记了 pending 的留待按章节读、不算；排除与待确认不算", () => {
  const included = JSON.stringify([
    { id: "a", decision: "included" },
    { id: "b", decision: "include" },
    { id: "c", decision: "pending" },
    { id: "d", decision: "excluded" },
    { id: "e", decision: "included" },
  ]);
  const index = JSON.stringify([{ id: "a", reviewStatus: "reviewed" }, { id: "e", reviewStatus: "pending" }]);
  assert.deepEqual(notesFollowupIds(included, index), ["b"]);
  assert.deepEqual(notesFollowupIds(included, null), ["a", "b", "e"]);
  assert.equal(notesFollowupIds("{坏", index), null);
});

test("notesDroppedIds：检索后来排除、精读这边索引或引文库里还留着的篇", () => {
  const included = JSON.stringify([
    { id: "a", decision: "included" },
    { id: "10.1021/acs.chemrev.3c00005", doi: "10.1021/acs.chemrev.3c00005", decision: "excluded" },
    { id: "W9", doi: "https://doi.org/10.1002/X.1", decision: "excluded" },
    { id: "gone", decision: "excluded" },
  ]);
  const index = JSON.stringify([{ id: "a" }, { id: "gone" }]);
  const bib = "@article{Kawashima2023,\n  doi = {10.1021/acs.chemrev.3c00005},\n}\n@article{X,\n  doi = {10.1002/x.1}\n}\n";
  assert.deepEqual(notesDroppedIds(included, index, bib), ["10.1021/acs.chemrev.3c00005", "W9", "gone"]);
  assert.deepEqual(notesDroppedIds(included, index, null), ["gone"]);
  assert.deepEqual(notesDroppedIds(included, null, ""), []);
  assert.deepEqual(notesDroppedIds("{坏", index, bib), []);
});

test("跟进时撤下排除的篇：写作约束、可写点、索引撤掉，引文库交 bib 移出，笔记留着；只有排除也开一轮", () => {
  const both = followupPrompt({ upstream: "文献检索与筛选", notesIds: ["n1"], droppedIds: ["d1"], files: [] });
  assert.match(both, /新加了 1 篇/);
  assert.match(both, /后来排除了 1 篇，精读这边还留着：d1/);
  assert.match(both, /handoff\.md 写作约束里提到它们的条目删掉或改写/);
  assert.match(both, /笔记文件留着不删/);
  assert.match(both, /收尾跑 lit_records\.py bib/);
  assert.match(both, /只留现在仍成立的写作约束/);
  const onlyDropped = followupPrompt({ upstream: "x", notesIds: [], droppedIds: ["d1", "d2"], files: [] });
  assert.doesNotMatch(onlyDropped, /新加了/);
  assert.match(onlyDropped, /后来排除了 2 篇/);
  assert.match(followupScale({ upstream: "x", notesIds: [], droppedIds: ["d1"], files: [] }), /后来排除 1 篇/);
  assert.equal(followupScale({ upstream: "x", notesIds: [], droppedIds: [], files: [] }), "");
  assert.equal(
    followupConfirmText({ notesIds: [], droppedIds: ["d1"], files: [], unsaved: false }),
    "撤下后来排除的 1 篇？\n\nAI 把它们从写作约束和引文库撤掉，笔记留着。",
  );
  assert.match(followupConfirmText({ notesIds: ["a"], droppedIds: ["d1"], files: [], unsaved: false }), /^跟进新纳入的 1 篇、撤下后来排除的 1 篇？/);
  // 按文件跟进时不管排除
  assert.match(followupConfirmText({ notesIds: null, droppedIds: ["d1"], files: ["x.md"], unsaved: false }), /^跟进上游改过的 1 个文件？/);
});

test("followupFiles：Mesa 过程文件与积累台账不算上游新增", () => {
  assert.deepEqual(
    followupFiles([".ccode/project.toml", "notes/01.md", "papers/reading-list.md", "notes/inbox.md", "papers/watch-seen.md", "outline.md"]),
    ["notes/01.md", "outline.md"],
  );
});

test("followupPrompt / followupScale：精读按篇、其他按文件；超长截断", () => {
  const ids = Array.from({ length: 45 }, (_, i) => `p${i}`);
  const notes = followupPrompt({ upstream: "文献检索与筛选", notesIds: ids, files: [] });
  assert.match(notes, /新加了 45 篇/);
  assert.match(notes, /等 45 篇/);
  assert.match(notes, /已有笔记和速读行一字不动/);
  const files = Array.from({ length: 33 }, (_, i) => `notes/${i}.md`);
  const outline = followupPrompt({ upstream: "文献精读与笔记", notesIds: null, files });
  assert.match(outline, /另有 3 个/);
  assert.match(outline, /本轮改了什么/);
  assert.match(outline, /本轮之前没做完的.*照 TASK\.md 接着做/);
  assert.equal(followupScale({ upstream: "x", notesIds: [], files: [] }), "");
  assert.match(followupScale({ upstream: "x", notesIds: ["a"], files: [] }), /只处理这 1 篇/);
  assert.match(followupScale({ upstream: "x", notesIds: null, files: ["a.md"] }), /1 个文件/);
});

test("reworkTargets：本步之前有工作区的步骤，近的在前", () => {
  const steps = [{ name: "检索", workspaceName: "s" }, { name: "无", workspaceName: "" }, { name: "精读", workspaceName: "n" }, { name: "大纲", workspaceName: "o" }];
  assert.deepEqual(reworkTargets(steps, 3).map((s) => s.name), ["精读", "检索"]);
  assert.deepEqual(reworkTargets(steps, 0), []);
});

test("roundCauseLabel", () => {
  assert.equal(roundCauseLabel("first"), "首轮");
  assert.equal(roundCauseLabel("rework"), "补料轮");
  assert.equal(roundCauseLabel("manual"), "接着改");
});

test("coverageReworkDrafts：只取没处理的薄节，补检 / 补读分到检索 / 精读；按目标分组预填", async () => {
  const { coverageReworkDrafts, groupCoverageDrafts } = await import("../src/step-loop.ts");
  const outline = [
    "# 大纲",
    "## 覆盖检查",
    "| 节 | 可写正文篇数 | 仅线索篇数 | 最新一篇年份 | 判断 | 建议 |",
    "|---|---|---|---|---|---|",
    "| 3.2 失活机理 | 2 | 3 | 2020 | 薄 | 补检：近三年原位表征工作 |",
    "| 3.3 动力学 | 1 | 0 | 2023 | 薄 | 补读：[@Wu2023] [@Li2024] |",
    "| 3.5 界面 | 2（@Huang2027 @Hong2025） | 5（@Su2025 @Xu2019） | 2027 | 薄 | 补读：[@Su2025] |",
    "| 3.4 成本 | 0 | 1 | 2019 | 薄·不补：不是本综述重点 | 补检：技术经济分析 |",
    "| 4 展望 | 6 | 2 | 2025 | 够 | |",
    "## 框架推演",
    "| 3.9 | 0 | 0 | 2000 | 薄 | 补检：不在本节 |",
  ].join("\n");
  const drafts = coverageReworkDrafts(outline);
  assert.deepEqual(drafts.map((d) => d.target), ["search", "read", "read"]);
  assert.equal(drafts[0].topic, "3.2 失活机理：近三年原位表征工作");
  assert.match(drafts[0].reason, /可写正文 2 篇、仅线索 3 篇，最新一篇 2020/);
  assert.match(drafts[2].reason, /可写正文 2 篇、仅线索 5 篇，最新一篇 2027$/, "篇数格里括号列的键不进原因");
  assert.deepEqual(groupCoverageDrafts(drafts, "read"), {
    topics: "3.3 动力学：[@Wu2023] [@Li2024]\n3.5 界面：[@Su2025]",
    reason: "大纲覆盖检查里这 2 节是薄的：3.3、3.5",
  });
  assert.equal(groupCoverageDrafts(drafts, "other"), null);
  assert.deepEqual(coverageReworkDrafts("# 没有覆盖检查"), []);
});

test("unplacedCoverageDrafts：建议没写补检 / 补读的、或对应上游步骤没有的薄节单列，不悄悄丢掉", async () => {
  const { coverageReworkDrafts, unplacedCoverageDrafts } = await import("../src/step-loop.ts");
  const outline = [
    "## 覆盖检查",
    "| 节 | 可写正文篇数 | 仅线索篇数 | 最新一篇年份 | 判断 | 建议 |",
    "|---|---|---|---|---|---|",
    "| 3.2 失活 | 2 | 3 | 2020 | 薄 | 补检：原位表征 |",
    "| 3.5 稳定性 | 1 | 1 | 2022 | 薄 | 找课题组要数据 |",
    "| 3.3 动力学 | 1 | 0 | 2023 | 薄 | 补读：[@Wu2023] |",
    "| 6 讨论 | 5 | 5 | 2027 | 薄 | 补读同 3.3（不重复计） |",
  ].join("\n");
  const drafts = coverageReworkDrafts(outline);
  assert.equal(drafts.find((d) => d.target === "other")?.topic, "3.5 稳定性：找课题组要数据");
  assert.equal(drafts.at(-1)?.target, "read");
  assert.equal(drafts.at(-1)?.topic, "6 讨论：同 3.3（不重复计）");
  assert.deepEqual(unplacedCoverageDrafts(drafts, { search: true, read: true }), [
    "3.5 稳定性：找课题组要数据（这一节可写正文 1 篇、仅线索 1 篇，最新一篇 2022）",
  ]);
  assert.equal(unplacedCoverageDrafts(drafts, { search: true, read: false }).length, 3);
});

test("loopHint：前面在补一轮先指它；否则指第一个待跟进；正常往下走时不出", async () => {
  const { loopHint } = await import("../src/step-loop.ts");
  const steps = [{ name: "检索" }, { name: "精读" }, { name: "大纲" }, { name: "初稿" }];
  // 正常推进：前面都完成、当前在做，不提示
  assert.equal(loopHint(steps, [{ key: "done" }, { key: "done" }, { key: "active" }, { key: "pending" }]), null);
  // 检索在补料、后面已完成
  const a = loopHint(steps, [{ key: "review" }, { key: "done" }, { key: "done" }, { key: "pending" }]);
  assert.equal(a?.index, 0);
  assert.match(a!.text, /「检索」：这一轮做完了，去评审/);
  // 检索保存了，精读、大纲待跟进 → 先指精读
  const b = loopHint(steps, [{ key: "done" }, { key: "done", staleUpstream: "检索" }, { key: "done", staleUpstream: "检索" }, { key: "pending" }]);
  assert.equal(b?.index, 1);
  assert.match(b!.text, /到「精读」点「跟进更新」/);
  // 精读在跟进（进行中），大纲已完成 → 指精读
  assert.equal(loopHint(steps, [{ key: "done" }, { key: "active" }, { key: "done", staleUpstream: "检索" }, { key: "pending" }])?.index, 1);
});

test("latestNote：并进来的新内容附在开场指令后；没有就原样；超过 30 个只列前 30", () => {
  assert.equal(latestNote([]), "");
  assert.equal(withLatestNote("接着做", []), "接着做");
  const one = withLatestNote("接着做", ["outline.md", "notes/12-wang.md"]);
  assert.match(one, /^接着做\n\n项目里有这一步还没用上的新内容/);
  assert.match(one, /- outline\.md\n- notes\/12-wang\.md/);
  assert.match(one, /用户确认过的内容不推翻/);
  const many = latestNote(Array.from({ length: 33 }, (_, i) => `notes/${i}.md`));
  assert.match(many, /- notes\/29\.md\n- …另有 3 个/);
  assert.doesNotMatch(many, /notes\/30\.md/);
});

test("chainNext / chainWhere：上一步开了之后又保存过才轮到下一步；skipped 不算上一步；停掉不再往下", async () => {
  const { chainNext, chainWhere } = await import("../src/step-loop.ts");
  const base = { toStep: "检索", sentAt: "2026-11-06T01:00:00Z", chain: ["精读", "大纲"] };
  const saved: Record<string, string> = {};
  const at = (s: string) => saved[s] ?? null;
  // 检索还没在补料后保存：等检索
  saved["检索"] = "2026-11-05T00:00:00Z";
  assert.equal(chainNext({ ...base, chainState: { started: [], stopped: false } }, at), null);
  assert.deepEqual(chainWhere({ ...base, chainState: { started: [], stopped: false } }, at), { kind: "waiting", step: "检索" });
  // 检索保存了：轮到精读
  saved["检索"] = "2026-11-06T02:00:00Z";
  assert.deepEqual(chainNext({ ...base }, at), { step: "精读", prev: "检索", savedAt: "2026-11-06T02:00:00Z" });
  // 精读开了还没保存：等精读
  const s1 = { started: [{ step: "精读", at: "2026-11-06T02:01:00Z" }], stopped: false };
  assert.equal(chainNext({ ...base, chainState: s1 }, at), null);
  assert.deepEqual(chainWhere({ ...base, chainState: s1 }, at), { kind: "waiting", step: "精读" });
  // 精读保存了：轮到大纲
  saved["精读"] = "2026-11-06T03:00:00Z";
  assert.equal(chainNext({ ...base, chainState: s1 }, at)?.step, "大纲");
  // 精读没有要跟进的（skipped）：大纲看检索那次保存，直接轮到
  delete saved["精读"];
  const s2 = { started: [{ step: "精读", at: "2026-11-06T02:01:00Z", skipped: true }], stopped: false };
  assert.deepEqual(chainNext({ ...base, chainState: s2 }, at), { step: "大纲", prev: "检索", savedAt: "2026-11-06T02:00:00Z" });
  // 停掉：不再往下
  assert.equal(chainNext({ ...base, chainState: { ...s1, stopped: true } }, at), null);
  assert.deepEqual(chainWhere({ ...base, chainState: { ...s1, stopped: true } }, at), { kind: "stopped" });
  // 都开过、最后一步也保存了：走完
  saved["精读"] = "2026-11-06T03:00:00Z";
  saved["大纲"] = "2026-11-06T05:00:00Z";
  const s3 = { started: [{ step: "精读", at: "2026-11-06T02:01:00Z" }, { step: "大纲", at: "2026-11-06T03:01:00Z" }], stopped: false };
  assert.deepEqual(chainWhere({ ...base, chainState: s3 }, at), { kind: "done" });
  assert.deepEqual(chainWhere({ toStep: "检索", sentAt: "x", chain: [] }, at), { kind: "none" });
});

test("回头 / 跟进开场话按步骤类型补一句做法；文献两步不加", async () => {
  const { reworkPrompt, followupPrompt } = await import("../src/step-loop.ts");
  const rework = { fromStep: "结果分析", topics: ["缺失值改成删除"], reason: "插补让组间差异虚高", clues: "", scale: null, relPath: ".ccode/rework/1.json" };
  const clean = reworkPrompt(rework, { isSearch: false, projectRoot: "/p", date: "11-06", clause: "先改 cleaning/rules.md。" });
  assert.match(clean, /这是一轮修改.*\n[\s\S]*「## 修改轮（11-06）」一节，写清改了什么、改了哪些文件。先改 cleaning\/rules\.md。/);
  const search = reworkPrompt(rework, { isSearch: true, projectRoot: "/p", date: "11-06", clause: "不该出现" });
  assert.doesNotMatch(search, /不该出现/);
  const follow = followupPrompt({ upstream: "清洗与整理", notesIds: null, files: ["cleaning/rules.md"], clause: "重跑脚本，不手改。" });
  assert.match(follow, /「## 本轮改了什么」[^\n]*\n重跑脚本，不手改。/);
  assert.doesNotMatch(followupPrompt({ upstream: "x", notesIds: ["a"], files: [], clause: "重跑脚本" }), /重跑脚本/, "精读按篇跟进不加");
});

test("searchRefreshHint：定稿类还没保存、检索保存超过 14 天才提示；检索在补、定稿已保存不提示", async () => {
  const { searchRefreshHint, searchRefreshDraft } = await import("../src/step-loop.ts");
  const steps = [{ name: "检索" }, { name: "精读" }, { name: "初稿" }, { name: "定稿" }];
  const kinds = ["search", "notes", "writing", "final"];
  const saved = (n: string) => (n === "检索" ? "2026-10-01T00:00:00Z" : null);
  const now = Date.parse("2026-11-07T00:00:00Z");
  assert.deepEqual(searchRefreshHint(steps, kinds, ["done", "done", "done", "pending"], saved, 3, now), { step: "检索", savedAt: "2026-10-01T00:00:00Z", days: 37 });
  assert.equal(searchRefreshHint(steps, kinds, ["done", "done", "done", "done"], saved, 3, now), null, "定稿已保存");
  assert.equal(searchRefreshHint(steps, kinds, ["active", "done", "done", "pending"], saved, 3, now), null, "检索正在补");
  assert.equal(searchRefreshHint(steps, kinds, ["done", "done", "done", "pending"], saved, 2, now), null, "不是定稿类");
  assert.equal(searchRefreshHint(steps, kinds, ["done", "done", "done", "pending"], () => "2026-11-01T00:00:00Z", 3, now), null, "不到 14 天");
  const d = searchRefreshDraft("2026-10-01T08:00:00Z");
  assert.match(d.topics, /^更新检索：2026-10-0[12] 以来新发表的文献/);
  assert.match(d.reason, /投稿前/);
});

test("意见回流：处理意见的开场话；按「去向：退回」归成补料单预填", async () => {
  const { commentsPrompt, commentReworkDrafts, roundCauseLabel } = await import("../src/step-loop.ts");
  const p = commentsPrompt("manuscript/comments/20261107-稿.md", 3, "11-07");
  assert.match(p, /导入了 3 条 Word 批注.*manuscript\/comments\/20261107-稿\.md/);
  assert.match(p, /不自己改上游交的文件/);
  assert.match(p, /「## 意见处理（11-07）」/);
  assert.equal(roundCauseLabel("comments"), "意见轮");
  const sheet = [
    "| 编号 | 批注人 | 原文 | 意见 | 类别 | 去向 | 处理 |",
    "|---|---|---|---|---|---|---|",
    "| C001 | 王老师 | MoS2 | 补近三年原位表征 | 补文献 | 退回：文献检索与筛选 | 补 2023 年后原位 Raman / XAS |",
    "| C002 | 王老师 | η10 | 数对不上 | 改文字 | 本步 | 已改 §3.2 |",
    "| C003 | 李 | 机理 | 这几篇要精读 | 补文献 | 退回：「文献精读与笔记」 |  |",
    "| C004 | 李 | x | y | 补分析 | 退回：不存在的步 | z |",
  ].join("\n");
  const drafts = commentReworkDrafts(sheet, ["文献精读与笔记", "文献检索与筛选"]);
  assert.deepEqual(Object.keys(drafts).sort(), ["文献检索与筛选", "文献精读与笔记"]);
  assert.equal(drafts["文献检索与筛选"].topics, "C001 补 2023 年后原位 Raman / XAS");
  assert.equal(drafts["文献精读与笔记"].topics, "C003 这几篇要精读", "处理空着用意见");
  assert.match(drafts["文献检索与筛选"].reason, /C001/);
});

test("catchUpProbes：只挑索引里 abstract-only 的篇，带上纳入清单的标题与 DOI；读不懂给 null", () => {
  const included = JSON.stringify([
    { id: "a", title: "Paper A", doi: "10.1/a", decision: "included" },
    { id: "b", title: "Paper B", doi: "https://doi.org/10.1/B", decision: "included" },
    { id: "c", title: "Paper C", url: "https://x.org/c", decision: "included" },
  ]);
  const index = JSON.stringify([
    { id: "a", bibKey: "A2020", fulltextStatus: "fulltext", notePath: "notes/a.md" },
    { id: "b", bibKey: "B2021", fulltextStatus: "abstract-only", notePath: "notes/b.md" },
    { id: "c", bibKey: "C2022", fulltextStatus: "unavailable", notePath: "notes/c.md" },
  ]);
  assert.deepEqual(catchUpProbes(included, index), [
    { id: "b", bibKey: "B2021", notePath: "notes/b.md", title: "Paper B", url: "https://doi.org/10.1/B" },
    { id: "c", bibKey: "C2022", notePath: "notes/c.md", title: "Paper C", url: "https://x.org/c" },
  ]);
  assert.equal(catchUpProbes("{", index), null);
  assert.deepEqual(catchUpProbes(included, JSON.stringify({ records: [] })), []);
});

test("catchUpPrompt：点名篇与全文文件，在原笔记上续写、用户写的原样保留、收尾改 fulltextStatus", () => {
  const text = catchUpPrompt([
    { probe: { id: "b", bibKey: "B2021", notePath: "notes/b.md", title: "Paper B", url: "" }, pdf: "Paper B.pdf" },
  ]);
  assert.match(text, /有 1 篇原来没有全文/);
  assert.match(text, /B2021（b，笔记 notes\/b\.md）：全文 papers\/Paper B\.pdf/);
  assert.match(text, /在原笔记上续写（没有笔记的按技能新写），不另起平行笔记/);
  assert.match(text, /「我的想法」与用户手写的内容原样保留/);
  assert.match(text, /fulltextStatus 改成 fulltext/);
  // 交棒只留现行约束：删掉「仅摘要」那条，不记补读经过；精读不跑 write
  assert.match(text, /handoff\.md 写作约束里这几篇「仅摘要 \/ 题录」的那条删掉/);
  assert.doesNotMatch(text, /记一句补读了哪几篇/);
  assert.match(text, /lit_records\.py pdfs/);
  assert.doesNotMatch(text, /lit_records\.py write/);
});

test("跟进 / 补读确认框：问句标题 + 一两句后果；上一轮没保存只加一条注意", () => {
  const t = followupConfirmText({ notesIds: ["a", "b"], files: [], unsaved: false });
  assert.equal(t, "跟进新纳入的 2 篇？\n\nAI 只读这 2 篇，已有笔记不动。");
  const u = followupConfirmText({ notesIds: ["a", "b"], files: [], unsaved: true });
  assert.match(u, /\n\n注意：上一轮还没保存，两轮会一起评审，不能只退回其中一轮。$/);
  assert.match(followupConfirmText({ notesIds: null, files: ["x.md"], unsaved: false }), /^跟进上游改过的 1 个文件？/);
  assert.equal(catchUpConfirmText(["Kim2025", "Li2018"]), "补读 2 篇新到的全文？\n\nAI 在原笔记上续写：Kim2025、Li2018。别的篇不动。");
});

test("看这一轮：差异去掉文件头、段头换分隔、增删去掉 +/-；台账文件与标签", () => {
  const diff = [
    "diff --git a/notes/a.md b/notes/a.md",
    "index 1690b6b..5d35784 100644",
    "--- a/notes/a.md",
    "+++ b/notes/a.md",
    "@@ -1,3 +1,3 @@",
    " # 标题",
    "-旧的一句",
    "+新的一句",
    "@@ -10,2 +10,2 @@",
    "--- 删掉的分隔线",
    " 末尾",
    "",
  ].join("\n");
  assert.deepEqual(readableDiff(diff), [
    { kind: "ctx", text: "# 标题" },
    { kind: "del", text: "旧的一句" },
    { kind: "add", text: "新的一句" },
    { kind: "gap", text: "" },
    { kind: "del", text: "-- 删掉的分隔线" },
    { kind: "ctx", text: "末尾" },
  ]);
  assert.equal(roundChangeLabel("added"), "新加");
  assert.equal(roundChangeLabel(""), "");
  assert.ok(isLedgerFile("papers/to-fetch.md"));
  assert.ok(!isLedgerFile("papers/screening.md"));
});

test("litOrder：有找新文献退回检索、精读几条随单走并锁进链；只精读退回精读；两栏空不发", async () => {
  const { litOrder } = await import("../src/step-loop.ts");
  const chainOptions = { 检索: ["精读", "大纲"], 精读: ["大纲"] };
  const base = { search: "检索", notes: "精读", chainOptions };
  assert.deepEqual(litOrder({ ...base, searchRows: ["4.3 新工作"], readRows: ["4.3：[@Su2025]"], picked: ["大纲"] }), {
    target: "检索", topics: ["4.3 新工作"], reads: ["4.3：[@Su2025]"], chain: ["精读", "大纲"],
  });
  // 精读那一步不在可选链里（还没保存）也要带上，排在最前
  assert.deepEqual(litOrder({ ...base, chainOptions: { 检索: ["大纲"] }, searchRows: ["a"], readRows: ["b"], picked: [] })?.chain, ["精读"]);
  // 只找新文献：链只留人勾的
  assert.deepEqual(litOrder({ ...base, searchRows: ["a"], readRows: [], picked: [] }), { target: "检索", topics: ["a"], reads: [], chain: [] });
  assert.deepEqual(litOrder({ ...base, searchRows: [], readRows: ["b"], picked: ["大纲"] }), { target: "精读", topics: ["b"], reads: [], chain: ["大纲"] });
  assert.equal(litOrder({ ...base, searchRows: [], readRows: [], picked: [] }), null);
  // 上游没有精读：精读那栏不随单走
  assert.deepEqual(litOrder({ search: "检索", chainOptions, searchRows: ["a"], readRows: ["b"], picked: [] })?.reads, []);
});

test("chainTurns：链上正轮到这一步的补料单；检索还没保存、已开过、停掉的不算", async () => {
  const { chainTurns } = await import("../src/step-loop.ts");
  const r = { id: "r1", toStep: "检索", sentAt: "2026-11-11T01:00:00Z", chain: ["精读"], reads: ["4.3：[@Su2025]"] };
  const saved: Record<string, string> = {};
  const at = (s: string) => saved[s] ?? null;
  assert.deepEqual(chainTurns([r], "精读", at), [], "检索还没保存");
  saved["检索"] = "2026-11-11T03:00:00Z";
  assert.deepEqual(chainTurns([r], "精读", at).map((x) => x.id), ["r1"]);
  assert.deepEqual(chainTurns([{ ...r, reads: [] }], "精读", at).length, 1, "没带精读几条的也算（手动跟进同样要记链已开）");
  assert.deepEqual(chainTurns([r], "大纲", at), []);
  assert.deepEqual(chainTurns([{ ...r, chainState: { started: [{ step: "精读", at: "2026-11-11T04:00:00Z" }], stopped: false } }], "精读", at), []);
  assert.deepEqual(chainTurns([{ ...r, chainState: { started: [], stopped: true } }], "精读", at), []);
});

test("为大纲补检来的新篇：精读跟进列出节、研究论文也写完整笔记、记 forSections；规模话写明", () => {
  const p = followupPrompt({ upstream: "文献检索与筛选", notesIds: ["n1", "n2"], files: [], sections: ["4.3 界面稳定性：2024 年以后"] });
  assert.match(p, /这些篇是大纲为下面几节补检来的：\n1\. 4\.3 界面稳定性/);
  assert.match(p, /研究论文也直接写成完整精读笔记/);
  assert.match(p, /forSections/);
  assert.doesNotMatch(p, /就在 notes\/skim\.md 补行/);
  assert.match(followupPrompt({ upstream: "检索", notesIds: ["n1"], files: [] }), /就在 notes\/skim\.md 补行/, "不是大纲来的照旧速读");
  assert.match(followupScale({ upstream: "检索", notesIds: ["n1"], files: [], sections: ["4.3"] }), /新纳入 1 篇是为大纲补检来的，AI 把它们都写成完整笔记/);
});

test("精读跟进带上补文献单的精读几条：开场列出、写完整笔记；没有新篇也照样开；确认框与规模写明", () => {
  const p = followupPrompt({ upstream: "文献检索与筛选", notesIds: ["n1"], files: [], reads: ["4.3：[@Su2025]"] });
  assert.match(p, /纳入清单里新加了 1 篇/);
  assert.match(p, /补文献单上还点名精读这些（和上面新纳入的一起做）：\n1\. 4\.3：\[@Su2025\]/);
  assert.match(p, /写成完整精读笔记/);
  assert.match(p, /「研究论文只速读、不写单篇笔记」对这几篇不适用/);
  const only = followupPrompt({ upstream: "文献检索与筛选", notesIds: [], files: [], reads: ["4.3：[@Su2025]"] });
  assert.doesNotMatch(only, /纳入清单里新加了/);
  assert.match(only, /补文献单上还点名精读这些/);
  assert.match(followupScale({ upstream: "检索", notesIds: [], files: [], reads: ["a", "b"] }), /补文献单上点名精读 2 条/);
  assert.equal(followupScale({ upstream: "检索", notesIds: [], files: [] }), "");
  assert.match(followupConfirmText({ notesIds: [], files: [], unsaved: false, reads: ["a"] }), /^精读补文献单上点名的 1 条？/);
  assert.match(followupConfirmText({ notesIds: ["n1"], files: [], unsaved: false, reads: ["a"] }), /跟进新纳入的 1 篇？[\s\S]*点名精读的 1 条也一起做/);
});

test("退回检索的补料轮：单上有精读几条时说明不在这一轮做", () => {
  const rework = { fromStep: "综述大纲", topics: ["4.3 新工作"], reason: "薄", clues: "", scale: null, relPath: ".ccode/rework/x.json", reads: ["4.3：[@Su2025]"] };
  assert.match(reworkPrompt(rework, { isSearch: true, projectRoot: "/p", date: "11-11" }), /单上另有 1 条要精读已有的文献，不在这一轮做/);
  assert.doesNotMatch(reworkPrompt({ ...rework, reads: [] }, { isSearch: true, projectRoot: "/p", date: "11-11" }), /单上另有/);
});

test("为大纲补检来的新篇：补检那行没写节号时，叫 AI 按纳入理由和大纲判断", () => {
  const p = followupPrompt({ upstream: "检索", notesIds: ["n1"], files: [], sections: ["背景再找5篇文献"] });
  assert.match(p, /没写节号的，按 papers\/included\.json 里这几篇的纳入理由和大纲判断它撑哪几节/);
  assert.doesNotMatch(followupPrompt({ upstream: "检索", notesIds: ["n1"], files: [], sections: ["4.3：新工作"] }), /没写节号的/);
});

test("reworkWaiting：发单的步骤在退回目标补完、链走完之前算等补料；链停掉只看目标补完没有", async () => {
  const { reworkWaiting } = await import("../src/step-loop.ts");
  const r = { fromStep: "大纲", toStep: "检索", sentAt: "2026-11-11T02:28:01Z", chain: ["精读"] };
  const saved: Record<string, string> = {};
  const at = (s: string) => saved[s] ?? null;
  assert.equal(reworkWaiting([r], "大纲", at), true, "检索还没补完");
  assert.equal(reworkWaiting([r], "精读", at), false, "只认发单的那一步");
  saved["检索"] = "2026-11-11T02:54:38Z";
  assert.equal(reworkWaiting([r], "大纲", at), true, "链还等精读开、评审保存");
  const started = { started: [{ step: "精读", at: "2026-11-11T02:56:28Z" }], stopped: false };
  assert.equal(reworkWaiting([{ ...r, chainState: started }], "大纲", at), true);
  saved["精读"] = "2026-11-11T04:00:00Z";
  assert.equal(reworkWaiting([{ ...r, chainState: started }], "大纲", at), false, "精读保存了：补料到了");
  assert.equal(reworkWaiting([{ ...r, chainState: { started: [], stopped: true } }], "大纲", at), false, "链停了、目标已补完");
  assert.equal(reworkWaiting([{ ...r, chain: [] }], "大纲", at), false);
});

test("reworkPath：退回目标 → 链上各步 → 发起步，各走到哪；补完且链走完不列", async () => {
  const { reworkPath } = await import("../src/step-loop.ts");
  const saved: Record<string, string> = {};
  const keys: Record<string, string> = { 检索: "active", 精读: "done", 大纲: "review" };
  const at = (s: string) => saved[s] ?? null;
  const key = (s: string) => keys[s];
  const r = { fromStep: "大纲", toStep: "检索", sentAt: "2026-11-11T02:28:01Z", chain: ["精读"] };
  const show = (p: ReturnType<typeof reworkPath>) => p?.steps.map((s) => `${s.name}:${s.note}`).join(" → ");
  assert.equal(show(reworkPath(r, at, key)), "检索:在做 → 精读:之后跟进 → 大纲:之后点继续");
  saved["检索"] = "2026-11-11T02:54:38Z";
  keys["检索"] = "done";
  assert.equal(show(reworkPath(r, at, key)), "检索:✓ → 精读:轮到跟进 → 大纲:之后点继续");
  const started = { started: [{ step: "精读", at: "2026-11-11T02:56:28Z" }], stopped: false };
  keys["精读"] = "review";
  const waiting = reworkPath({ ...r, chainState: started }, at, key)!;
  assert.equal(show(waiting), "检索:✓ → 精读:等你评审 → 大纲:之后点继续");
  assert.equal(waiting.chainActive, true);
  saved["精读"] = "2026-11-11T04:00:00Z";
  assert.equal(reworkPath({ ...r, chainState: started }, at, key), null, "补完、链走完：不列");
  // 只退回精读、没有链：精读在做，大纲之后点继续；精读保存后不列
  const read = { fromStep: "大纲", toStep: "精读", sentAt: "2026-11-11T05:00:00Z", chain: [] };
  keys["精读"] = "active";
  assert.equal(show(reworkPath(read, at, key)), "精读:在做 → 大纲:之后点继续");
  assert.equal(reworkPath(read, at, key)!.chainActive, false);
  // 链停了、目标没补完：只剩目标和发起步
  delete saved["检索"];
  keys["检索"] = "review";
  assert.equal(show(reworkPath({ ...r, chainState: { started: [], stopped: true } }, at, key)), "检索:等你评审 → 大纲:之后点继续");
});
