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

test("notesFollowupIds：纳入里没写完笔记的；排除与待确认不算，坏 JSON 返回 null", () => {
  const included = JSON.stringify([
    { id: "a", decision: "included" },
    { id: "b", decision: "include" },
    { id: "c", decision: "pending" },
    { id: "d", decision: "excluded" },
    { id: "e", decision: "included" },
  ]);
  const index = JSON.stringify([{ id: "a", reviewStatus: "reviewed" }, { id: "e", reviewStatus: "pending" }]);
  assert.deepEqual(notesFollowupIds(included, index), ["b", "e"]);
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
  assert.match(notes, /还有 45 篇没有写完笔记/);
  assert.match(notes, /等 45 篇/);
  assert.match(notes, /已有笔记一字不动/);
  const files = Array.from({ length: 33 }, (_, i) => `notes/${i}.md`);
  const outline = followupPrompt({ upstream: "文献精读与笔记", notesIds: null, files });
  assert.match(outline, /另有 3 个/);
  assert.match(outline, /本轮改了什么/);
  assert.equal(followupScale({ upstream: "x", notesIds: [], files: [] }), "");
  assert.match(followupScale({ upstream: "x", notesIds: ["a"], files: [] }), /只读这 1 篇/);
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
