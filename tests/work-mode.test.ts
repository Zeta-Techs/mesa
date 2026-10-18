import assert from "node:assert/strict";
import test from "node:test";
import {
  codingFactChips,
  codingDivergenceLabel,
  codingDivergenceTip,
  deriveCodingKind,
  isOfficeInProgress,
  isOfficePreviewable,
  officeFileInProgress,
  officeFileReuseKey,
  officeProjectReuseKey,
  projectChatReuseKey,
  lockWorkModeFromConfig,
  normalizeWorkMode,
  headerShowsTopic,
  officeDocKind,
  officeDocMatchesQuery,
  officePreviewMode,
  WORK_MODE_LABEL,
  RAIL_WORK_MODE_LABEL,
  groupByWorkMode,
} from "../src/work-mode.ts";

test("缺省与非法值都归科研", () => {
  assert.equal(normalizeWorkMode(undefined), "research");
  assert.equal(normalizeWorkMode(null), "research");
  assert.equal(normalizeWorkMode(""), "research");
  assert.equal(normalizeWorkMode("Research"), "research");
  assert.equal(normalizeWorkMode("coding"), "coding");
  assert.equal(normalizeWorkMode("office"), "office");
  assert.equal(WORK_MODE_LABEL.research, "科研");
});

test("顶栏课题主题：科研项目都展示（含无流程科研），编程/办公/未添加不展示", () => {
  // 有流程与无流程科研同一判定：可见性只看注册态与工作方式，不看 pipelineOptOut
  assert.equal(headerShowsTopic({ registered: true, workMode: "research" }), true);
  assert.equal(headerShowsTopic({ registered: true, workMode: undefined }), true);
  assert.equal(headerShowsTopic({ registered: true, workMode: "coding" }), false);
  assert.equal(headerShowsTopic({ registered: true, workMode: "office" }), false);
  assert.equal(headerShowsTopic({ registered: false, workMode: "research" }), false);
});

test("项目栏按科研/编程/办公分段，未添加沉底，空组不出现", () => {
  const items = [
    { id: "a", mode: "office" },
    { id: "b", mode: "research" },
    { id: "c", mode: "office" },
    { id: "d", mode: "coding" },
    { id: "e", mode: undefined },
    { id: "f", mode: "unregistered" },
  ];
  const grouped = groupByWorkMode(items, (x) => x.mode);
  assert.deepEqual(
    grouped.map((g) => [g.mode, g.items.map((i) => i.id)]),
    [
      ["research", ["b", "e"]],
      ["coding", ["d"]],
      ["office", ["a", "c"]],
      ["unregistered", ["f"]],
    ],
  );
  assert.equal(RAIL_WORK_MODE_LABEL.unregistered, "未添加");
  assert.deepEqual(
    groupByWorkMode([], () => "research"),
    [],
  );
});

test("已注册或档案卡已落盘则锁定工作方式，空档案卡不锁", () => {
  assert.deepEqual(
    lockWorkModeFromConfig({ existingMode: "coding" }),
    { mode: "coding", locked: true },
  );
  assert.deepEqual(
    lockWorkModeFromConfig({ fileMode: "office" }),
    { mode: "office", locked: true },
  );
  assert.deepEqual(
    lockWorkModeFromConfig({ fileMode: "research", stepCount: 2 }),
    { mode: "research", locked: true },
  );
  assert.deepEqual(
    lockWorkModeFromConfig({ pipelineOptOut: true }),
    { mode: "research", locked: true },
  );
  assert.deepEqual(
    lockWorkModeFromConfig({ fileMode: "research", stepCount: 0 }),
    { mode: "research", locked: false },
  );
});

test("编程状态：落后优先于脏工作区", () => {
  assert.equal(
    deriveCodingKind({
      isBase: false,
      isPrimary: false,
      dirty: true,
      ahead: 2,
      behind: 3,
      hasWorktree: true,
    }),
    "sync",
  );
});

test("编程状态：干净领先 = 等待合并；主仓基准 = 基准", () => {
  assert.equal(
    deriveCodingKind({
      isBase: false,
      isPrimary: false,
      dirty: false,
      ahead: 4,
      behind: 0,
      hasWorktree: true,
    }),
    "ready",
  );
  assert.equal(
    deriveCodingKind({
      isBase: true,
      isPrimary: true,
      dirty: false,
      ahead: 0,
      behind: 0,
      hasWorktree: true,
    }),
    "base",
  );
});

test("编程状态：有工作树的 0/0 是未开始，没工作树是可清理", () => {
  const zero = {
    isBase: false,
    isPrimary: false,
    dirty: false,
    ahead: 0,
    behind: 0,
  };
  assert.equal(deriveCodingKind({ ...zero, hasWorktree: true }), "idle");
  assert.equal(deriveCodingKind({ ...zero, hasWorktree: false }), "prune");
});

test("办公类型与预览白名单", () => {
  assert.equal(officeDocKind("notes/a.md"), "doc");
  assert.equal(officeDocKind("t.xlsx"), "sheet");
  assert.equal(officeDocKind("x.pptx"), "slide");
  assert.equal(officeDocKind("p.PDF"), "pdf");
  assert.equal(officeDocKind("a.png"), "image");
  assert.equal(officeDocKind("src/main.rs"), "other");
  assert.equal(isOfficePreviewable("a.docx"), true);
  assert.equal(isOfficePreviewable("a.pptx"), false);
  assert.equal(isOfficePreviewable("a.doc"), false);
  assert.equal(isOfficePreviewable("a.csv"), true);
  assert.equal(officePreviewMode("a.csv"), "xlsx");
  assert.equal(officePreviewMode("a.tsv"), "xlsx");
  assert.equal(officePreviewMode("a.docx"), "docx");
  assert.equal(officePreviewMode("a.DOC"), "external");
  assert.equal(officePreviewMode("REPORT.PDF"), "pdf");
});

test("办公搜索：文件名或相对路径，空查询全过", () => {
  assert.equal(officeDocMatchesQuery("纪要.docx", "docs/纪要.docx", ""), true);
  assert.equal(
    officeDocMatchesQuery("纪要.docx", "docs/纪要.docx", "  纪要  "),
    true,
  );
  assert.equal(
    officeDocMatchesQuery("Minutes.docx", "docs/q1/Minutes.docx", "Q1"),
    true,
  );
  assert.equal(
    officeDocMatchesQuery("a.docx", "folder\\sub\\a.docx", "folder/sub"),
    true,
  );
  assert.equal(officeDocMatchesQuery("a.docx", "docs/a.docx", "xyz"), false);
});

test("工作台办公卡进行中：运行标签或七日内会话/打开", () => {
  const now = Date.parse("2026-09-02T12:00:00Z");
  assert.equal(
    isOfficeInProgress({
      hasLiveTab: true,
      lastSessionAt: null,
      lastOpenedAt: null,
      nowMs: now,
    }),
    true,
  );
  assert.equal(
    isOfficeInProgress({
      hasLiveTab: false,
      lastSessionAt: "2026-08-28T12:00:00Z",
      lastOpenedAt: null,
      nowMs: now,
    }),
    true,
  );
  assert.equal(
    isOfficeInProgress({
      hasLiveTab: false,
      lastSessionAt: "2026-08-20T12:00:00Z",
      lastOpenedAt: null,
      nowMs: now,
    }),
    false,
  );
});

test("办公文件行进行中：只认这份文件的活标签", () => {
  const file = officeFileReuseKey("/p", "流畅阅读/效果演示/演示1.gif");
  assert.equal(
    officeFileReuseKey("/p", "流畅阅读\\效果演示\\演示1.gif"),
    file,
  );
  assert.equal(
    officeFileInProgress(file, [file]),
    true,
  );
  assert.equal(
    officeFileInProgress(file, [officeProjectReuseKey("/p")]),
    false,
  );
  assert.equal(officeFileInProgress(file, [undefined, "office:/p:other.md"]), false);
  assert.equal(officeFileInProgress(file, []), false);
});

test("项目新对话复用键按工作方式分开", () => {
  assert.equal(projectChatReuseKey("office", "/p"), "office:/p:project");
  assert.equal(projectChatReuseKey("coding", "/p"), "coding:/p:project");
  assert.equal(projectChatReuseKey("research", "/p"), "research:/p:project");
  assert.equal(officeProjectReuseKey("/p"), "office:/p:project");
});

test("编程事实芯片：干净已推送不占位，只亮异常", () => {
  assert.deepEqual(
    codingFactChips({
      dirty: false,
      dirtyCount: 0,
      ahead: 0,
      behind: 0,
      unpushed: 0,
      hasUpstream: true,
      baseBranch: "main",
    }),
    [],
  );
  assert.deepEqual(
    codingFactChips({
      dirty: true,
      dirtyCount: 1,
      ahead: 0,
      behind: 0,
      unpushed: 0,
      hasUpstream: true,
      baseBranch: "main",
      hostKind: "github",
    }),
    [
      {
        key: "dirty",
        label: "1 个文件未提交",
        mark: "dirty",
        tone: "warn",
        tip: "1 个文件有未提交改动",
      },
    ],
  );
  assert.deepEqual(
    codingFactChips({
      dirty: false,
      ahead: 2,
      behind: 1,
      unpushed: 3,
      hasUpstream: true,
      baseBranch: "main",
      hostKind: "github",
    }),
    [
      {
        key: "remote",
        label: "3 个提交待推送",
        mark: "unpushed",
        tone: "warn",
        tip: "未推送：比 GitHub 上该分支多 3 个提交",
      },
    ],
  );
  assert.equal(
    codingFactChips({
      dirty: false,
      ahead: 0,
      behind: 0,
      unpushed: 0,
      hasUpstream: false,
      baseBranch: "main",
    })[0]?.mark,
    "noUpstream",
  );
  assert.deepEqual(
    codingFactChips({
      dirty: false,
      ahead: 0,
      behind: 0,
      unpushed: 0,
      hasUpstream: true,
      upstreamBehind: 2,
      baseBranch: "main",
      hostKind: "github",
    }),
    [
      {
        key: "upstreamBehind",
        label: "GitHub 有 2 个新提交",
        mark: "upstreamBehind",
        tone: "warn",
        tip: "GitHub 上该分支有 2 个新提交，可拉取",
      },
    ],
  );
});

test("领先落后的悬停说明点名基准，并说明哪边有对方没有的提交", () => {
  assert.equal(
    codingDivergenceTip(2, 1, "main"),
    "领先基准 main 2 个提交（待合入），落后 1 个（main 上的新提交这里还没有）",
  );
  assert.equal(
    codingDivergenceTip(3, 0, "main"),
    "领先基准 main 3 个提交，待合入",
  );
  assert.equal(
    codingDivergenceTip(0, 4, "dev"),
    "落后基准 dev 4 个提交：dev 上的新提交这里还没有",
  );
});

test("基准差异有完整短文案，双向分叉与零值不混淆", () => {
  assert.equal(codingDivergenceLabel(0, 0, "main"), "");
  assert.equal(codingDivergenceLabel(-1, -2, "main"), "");
  assert.equal(codingDivergenceLabel(0, 1, "master"), "比 master 落后 1 个提交");
  assert.equal(codingDivergenceLabel(3, 0, "main"), "比 main 领先 3 个提交");
  assert.equal(codingDivergenceLabel(3, 2, "main"), "比 main 领先 3 · 落后 2 个提交");
  assert.equal(codingDivergenceLabel(1, 0, " "), "比 基准 领先 1 个提交");
});

test("无上游不推断从未推送，远程与未提交文件有独立文案", () => {
  const facts = {
    dirty: true, ahead: 0, behind: 1, unpushed: 0,
    hasUpstream: false, upstreamBehind: 0, baseBranch: "master",
  };
  const chips = codingFactChips(facts);
  assert.equal(chips[0]?.label, "有未提交改动");
  assert.equal(chips[1]?.label, "未关联远程分支");
  assert.match(chips[1]!.tip, /不代表远程没有同名分支/);
  assert.doesNotMatch(chips[1]!.tip, /还没推到/);
  assert.deepEqual(
    codingFactChips({ ...facts, dirty: false, hasUpstream: true, unpushed: 2, upstreamBehind: 3 })
      .map((chip) => chip.label),
    ["2 个提交待推送", "远程有 3 个新提交"],
  );
});
