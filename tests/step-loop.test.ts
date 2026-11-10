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
  assert.match(other, /人确认过的内容不推翻/);
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
    "| 3.4 成本 | 0 | 1 | 2019 | 薄·不补：不是本综述重点 | 补检：技术经济分析 |",
    "| 4 展望 | 6 | 2 | 2025 | 够 | |",
    "## 框架推演",
    "| 3.9 | 0 | 0 | 2000 | 薄 | 补检：不在本节 |",
  ].join("\n");
  const drafts = coverageReworkDrafts(outline);
  assert.deepEqual(drafts.map((d) => d.target), ["search", "read"]);
  assert.equal(drafts[0].topic, "3.2 失活机理：近三年原位表征工作");
  assert.match(drafts[0].reason, /可写正文 2 篇、仅线索 3 篇，最新一篇 2020/);
  assert.deepEqual(groupCoverageDrafts(drafts, "read"), { topics: "3.3 动力学：[@Wu2023] [@Li2024]", reason: drafts[1].reason });
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
  ].join("\n");
  const drafts = coverageReworkDrafts(outline);
  assert.equal(drafts.find((d) => d.target === "other")?.topic, "3.5 稳定性：找课题组要数据");
  assert.deepEqual(unplacedCoverageDrafts(drafts, { search: true, read: true }), [
    "3.5 稳定性：找课题组要数据（这一节可写正文 1 篇、仅线索 1 篇，最新一篇 2022）",
  ]);
  assert.equal(unplacedCoverageDrafts(drafts, { search: true, read: false }).length, 2);
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
  assert.match(one, /人确认过的内容不推翻/);
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

test("catchUpPrompt：点名篇与全文文件，在原笔记上续写、人写的原样保留、收尾改 fulltextStatus", () => {
  const text = catchUpPrompt([
    { probe: { id: "b", bibKey: "B2021", notePath: "notes/b.md", title: "Paper B", url: "" }, pdf: "Paper B.pdf" },
  ]);
  assert.match(text, /有 1 篇原来没有全文/);
  assert.match(text, /B2021（b，笔记 notes\/b\.md）：全文 papers\/Paper B\.pdf/);
  assert.match(text, /在原笔记上续写（没有笔记的按技能新写），不另起平行笔记/);
  assert.match(text, /「我的想法」与人手写的内容原样保留/);
  assert.match(text, /fulltextStatus 改成 fulltext/);
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
