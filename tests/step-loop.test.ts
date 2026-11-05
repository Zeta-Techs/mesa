import assert from "node:assert/strict";
import test from "node:test";
import {
  followupFiles,
  followupPrompt,
  followupScale,
  notesFollowupIds,
  parseTopics,
  reworkPrompt,
  reworkTargets,
  roundCauseLabel,
} from "../src/step-loop.ts";

test("parseTopics：一行一条，去掉列表记号与空行", () => {
  assert.deepEqual(parseTopics("- §3.2 失活机理\n\n2. 原位表征\n* 动力学\n  "), ["§3.2 失活机理", "原位表征", "动力学"]);
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
  assert.doesNotMatch(search, /线索|规模/);
  const other = reworkPrompt({ ...rework, clues: "Zhang 2024", scale: 8 }, { isSearch: false, projectRoot: "C:\\p", date: "11-05" });
  assert.match(other, /线索：Zhang 2024/);
  assert.match(other, /不超过 8 篇/);
  assert.match(other, /人确认过的内容不推翻/);
  assert.match(other, /C:\\p\\\.ccode\\rework\\1-lit-search\.json/);
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
    "| 节 | 可写正文的键 | 仅线索 | 最新一篇年份 | 判断 | 建议 |",
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
  assert.match(b!.text, /到「精读」点「跟进上游的新增」/);
  // 精读在跟进（进行中），大纲已完成 → 指精读
  assert.equal(loopHint(steps, [{ key: "done" }, { key: "active" }, { key: "done", staleUpstream: "检索" }, { key: "pending" }])?.index, 1);
});
