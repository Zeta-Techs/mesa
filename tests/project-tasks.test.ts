import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptedGoalOutputs,
  canSaveDeclaredGoal,
  canSubmitDeclaredTask,
  continueGoalPrompt,
  declaredTaskKindsForMode,
  goalBucket,
  goalDisplayName,
  nextGoalHint,
  goalRevisionLabel,
  goalTimeline,
  goalTimelineLabel,
  goalTimelinePath,
  groupGoalsByBucket,
  markForProjectFile,
  isDeclaredTask,
  isDeclaredTaskName,
  isTaskMaterialNoise,
  joinRunPath,
  parseProtectedPathDraft,
  pathCoveredBySelection,
  pathIsProtected,
  protectableEntries,
  folderProtectLocked,
  toggleProtectedFolder,
  pruneNestedPaths,
  relativeProjectPath,
  selectedChangePaths,
  suggestProtectedPaths,
  taskChangeKindLabel,
  taskFileBadge,
  taskInputLabel,
  taskOutputLabel,
  taskPathsForScope,
  taskStatusLabel,
  toggleTaskMaterialPath,
  visibleDeclaredTasks,
  archivedDeclaredTasks,
} from "../src/project-tasks.ts";

test("write tasks do not silently default to the whole project", () => {
  assert.deepEqual(taskPathsForScope("none", [], "write_tree"), {
    inputPaths: [],
    outputPaths: ["."],
    error: null,
  });
  assert.deepEqual(taskPathsForScope("whole", ["notes"], "write_tree"), {
    inputPaths: ["."],
    outputPaths: ["."],
    error: null,
  });
  assert.deepEqual(taskPathsForScope("selected", [], "write_tree").error, "请勾选要带给这个目标的文件或文件夹");
  assert.deepEqual(taskPathsForScope("selected", ["notes/a.md", "notes"], "write_tree"), {
    inputPaths: ["notes"],
    outputPaths: ["."],
    error: null,
  });
  assert.deepEqual(taskPathsForScope("selected", ["papers/a.pdf"], "discuss"), {
    inputPaths: ["papers/a.pdf"],
    outputPaths: [],
    error: null,
  });
});

test("pruneNestedPaths keeps the parent and drops children", () => {
  assert.deepEqual(pruneNestedPaths(["notes/a.md", "notes", "notes/b.md"]), ["notes"]);
  assert.deepEqual(pruneNestedPaths([".", "notes"]), ["."]);
  assert.deepEqual(pruneNestedPaths(["papers/a.pdf", "notes"]), ["notes", "papers/a.pdf"]);
});

test("toggleTaskMaterialPath selects a folder without keeping nested files", () => {
  assert.deepEqual(
    toggleTaskMaterialPath(["notes/a.md", "papers/a.pdf"], "notes", true),
    ["notes", "papers/a.pdf"],
  );
  assert.deepEqual(toggleTaskMaterialPath(["notes", "papers/a.pdf"], "notes", false), [
    "papers/a.pdf",
  ]);
  assert.deepEqual(toggleTaskMaterialPath(["notes"], "notes/a.md", true), ["notes"]);
});

test("pathCoveredBySelection treats selected folders as covering descendants", () => {
  assert.equal(pathCoveredBySelection("notes/a.md", ["notes"]), true);
  assert.equal(pathCoveredBySelection("notes", ["notes"]), true);
  assert.equal(pathCoveredBySelection("src/main.ts", ["notes"]), false);
  assert.equal(pathCoveredBySelection("notes/a.md", ["."]), true);
});

test("declared tasks hide path-named conversation wrappers", () => {
  assert.equal(isDeclaredTaskName("整理筛选清单"), true);
  assert.equal(isDeclaredTaskName("/Users/me/proj/综述文献"), false);
  assert.equal(isDeclaredTaskName("C:\\Users\\me\\proj"), false);
  assert.equal(isDeclaredTaskName("~\\ccode\\scratch"), false);
  assert.equal(isDeclaredTask({ declared: true, name: "/tmp/x" }), true);
  assert.equal(isDeclaredTask({ declared: false, name: "整理筛选清单" }), false);
  assert.equal(isDeclaredTask({ name: "/Users/me/proj" }), false);
  assert.deepEqual(
    visibleDeclaredTasks(
      [
        { kind: "free_research", name: "整理筛选清单", declared: true },
        { kind: "free_research", name: "/Users/me/proj", declared: false },
        { kind: "office_doc", name: "改周报", declared: true },
        { kind: "pipeline_step", name: "文献精读", declared: true },
        {
          kind: "free_research",
          name: "已归档综述",
          declared: true,
          archivedAt: "2026-09-09T00:00:00Z",
        },
      ],
      new Set(["free_research", "office_doc"]),
    ).map((task) => task.name),
    ["整理筛选清单", "改周报"],
  );
  assert.deepEqual(
    archivedDeclaredTasks(
      [
        { kind: "free_research", name: "整理筛选清单", declared: true },
        {
          kind: "free_research",
          name: "已归档综述",
          declared: true,
          archivedAt: "2026-09-09T00:00:00Z",
        },
        { kind: "office_doc", name: "改周报", declared: true, archivedAt: null },
      ],
      new Set(["free_research", "office_doc"]),
    ).map((task) => task.name),
    ["已归档综述"],
  );
});

test("declaredTaskKindsForMode only office and lite research use declared tasks", () => {
  assert.deepEqual([...declaredTaskKindsForMode("office")], ["office_doc"]);
  assert.deepEqual([...declaredTaskKindsForMode("research")], ["free_research"]);
  assert.equal(declaredTaskKindsForMode("coding").size, 0);
  assert.equal(taskStatusLabel("pending_review"), "待验收");
  assert.equal(taskStatusLabel("pending"), "尚未开始");
  assert.equal(goalBucket("pending"), "open");
  assert.equal(goalBucket("failed"), "stuck");
});

test("canSaveDeclaredGoal does not require an Agent yet", () => {
  assert.equal(
    canSaveDeclaredGoal({
      name: "写综述",
      scope: "whole",
      selectedPaths: [],
      permission: "write_tree",
    }),
    true,
  );
  assert.equal(
    canSaveDeclaredGoal({
      name: "",
      scope: "whole",
      selectedPaths: [],
      permission: "write_tree",
    }),
    false,
  );
});

test("canSubmitDeclaredTask requires a name, profile, and explicit materials", () => {
  assert.equal(
    canSubmitDeclaredTask({
      name: "整理筛选清单",
      scope: "selected",
      selectedPaths: ["papers/included.md"],
      profileId: "p1",
      permission: "write_tree",
    }),
    true,
  );
  assert.equal(
    canSubmitDeclaredTask({
      name: "整理筛选清单",
      scope: "selected",
      selectedPaths: [],
      profileId: "p1",
      permission: "write_tree",
    }),
    false,
  );
  assert.equal(
    canSubmitDeclaredTask({
      name: "空副本起草",
      scope: "none",
      selectedPaths: [],
      profileId: "p1",
      permission: "write_tree",
    }),
    true,
  );
});

test("task labels stay human for scoped materials and discuss", () => {
  assert.equal(taskInputLabel(["."]), "整个项目");
  assert.equal(taskInputLabel([]), "不带入现有文件");
  assert.equal(taskInputLabel(["notes", "papers/a.pdf"]), "notes、papers/a.pdf");
  assert.equal(taskOutputLabel(["."], true), "验收后写入项目");
  assert.equal(taskOutputLabel(["."], true, "office"), "验收后写入文档");
  assert.equal(taskOutputLabel([], false), "只讨论，不改项目文件");
  assert.equal(taskChangeKindLabel("added"), "新增");
  assert.equal(taskChangeKindLabel("modified"), "修改");
});

test("isTaskMaterialNoise skips VCS, Ccode, and dependency directories", () => {
  assert.equal(isTaskMaterialNoise(".git"), true);
  assert.equal(isTaskMaterialNoise("Library", true), true);
  assert.equal(isTaskMaterialNoise("artifacts.yaml"), true);
  assert.equal(isTaskMaterialNoise("notes"), false);
});

test("selectedChangePaths keeps list order and drops unchecked rows", () => {
  assert.deepEqual(
    selectedChangePaths(
      [{ path: "notes/a.md" }, { path: "notes/b.md" }, { path: "notes/c.md" }],
      new Set(["notes/c.md", "notes/a.md"]),
    ),
    ["notes/a.md", "notes/c.md"],
  );
});

test("relativeProjectPath strips the project root across separators", () => {
  assert.equal(
    relativeProjectPath("/Users/me/proj", "/Users/me/proj/notes/a.md"),
    "notes/a.md",
  );
  assert.equal(
    relativeProjectPath("C:\\Users\\me\\proj", "C:\\Users\\me\\proj\\notes\\a.md"),
    "notes/a.md",
  );
});

test("taskFileBadge only marks specific outputs, not whole-project scope", () => {
  assert.equal(taskFileBadge(["."], "notes/a.md"), null);
  assert.equal(taskFileBadge(["notes/a.md"], "notes/a.md"), "notes/a.md");
  assert.equal(taskFileBadge(["notes"], "notes/a.md"), "notes");
  assert.equal(taskFileBadge(["notes/a.md"], "src/main.ts"), null);
});

test("goalRevisionLabel only appears from the second execution", () => {
  assert.equal(goalRevisionLabel(0), null);
  assert.equal(goalRevisionLabel(1), null);
  assert.equal(goalRevisionLabel(2), "第 2 版");
});

test("continueGoalPrompt keeps the goal and appends review notes", () => {
  assert.equal(continueGoalPrompt("写综述", ""), "写综述");
  assert.match(continueGoalPrompt("写综述", "引用太少"), /上一版的修改意见/);
  assert.match(continueGoalPrompt("写综述", "引用太少"), /引用太少/);
});

test("markForProjectFile flags pending review files under a goal", () => {
  const marks = [
    { relative: "论文/综述.md", goalName: "写综述", pending: true },
  ];
  assert.deepEqual(markForProjectFile("论文/综述.md", marks), {
    goalName: "写综述",
    pending: true,
  });
  assert.equal(markForProjectFile("notes/a.md", marks), null);
});

test("joinRunPath keeps isolation files addressable", () => {
  assert.equal(
    joinRunPath("/tmp/task-runs/abc", "notes/a.md"),
    "/tmp/task-runs/abc/notes/a.md",
  );
  assert.equal(joinRunPath("/tmp/task-runs/abc/", ""), "/tmp/task-runs/abc");
});

test("goalTimeline is generate → notes → revision → accepted", () => {
  const items = goalTimeline({
    status: "completed",
    runs: [
      { id: "r1", status: "completed", createdAt: "2026-09-01T00:00:00Z" },
      { id: "r2", status: "completed", createdAt: "2026-09-02T00:00:00Z" },
    ],
    events: [
      {
        runId: "r1",
        eventType: "task.review_notes",
        payload: JSON.stringify({ feedback: "引用太少" }),
        createdAt: "2026-09-01T01:00:00Z",
      },
    ],
  });
  assert.equal(goalTimelineLabel(items), "生成 → 意见：引用太少 → 第 2 版 → 已接受");
  assert.equal(goalTimelinePath(items), "生成 → 意见 → 第 2 版 → 已接受");
  // 详情里每一版、每条意见都带时间；接受没有可靠时间不填
  assert.deepEqual(items.map((item) => item.at ?? null), [
    "2026-09-01T00:00:00Z",
    "2026-09-01T01:00:00Z",
    "2026-09-02T00:00:00Z",
    null,
  ]);
});

test("groupGoalsByBucket splits open / running / review / done", () => {
  const groups = groupGoalsByBucket([
    { status: "pending", name: "设计实验" },
    { status: "stopped", name: "优化表格" },
    { status: "running", name: "写综述" },
    { status: "pending_review", name: "整理数据" },
    { status: "completed", name: "研究问题" },
  ]);
  assert.deepEqual(
    groups.open.map((item) => item.name),
    ["设计实验"],
  );
  assert.deepEqual(
    groups.stuck.map((item) => item.name),
    ["优化表格"],
  );
  assert.deepEqual(
    groups.running.map((item) => item.name),
    ["写综述"],
  );
  assert.deepEqual(
    groups.review.map((item) => item.name),
    ["整理数据"],
  );
  assert.deepEqual(
    groups.done.map((item) => item.name),
    ["研究问题"],
  );
});

test("suggestProtectedPaths only offers data or contract-like folders", () => {
  assert.deepEqual(
    suggestProtectedPaths("research", ["papers", "notes", "数据", "src"]),
    ["数据"],
  );
  assert.deepEqual(
    suggestProtectedPaths("office", ["合同", "Chatbox", "周报"]),
    ["合同"],
  );
  assert.deepEqual(suggestProtectedPaths("coding", ["src", "data"]), []);
});

test("protectableEntries lists top-level folders and files, data-like first", () => {
  const rows = protectableEntries(
    [
      { name: "papers", isDir: true },
      { name: "数据", isDir: true },
      { name: ".ccode", isDir: true },
      { name: "readme.md", isDir: false },
    ],
    ["notes/keep.md", "数据/raw"],
    "research",
  );
  assert.deepEqual(
    rows.map((row) => [row.path, row.isDir]),
    [
      ["数据", true],
      ["papers", true],
      ["readme.md", false],
      ["notes/keep.md", false],
    ],
  );
});

test("toggleProtectedFolder checks parent and locks children", () => {
  assert.deepEqual(toggleProtectedFolder(["数据/raw"], "数据", true), ["数据"]);
  assert.deepEqual(toggleProtectedFolder(["数据"], "数据", false), []);
  assert.equal(folderProtectLocked("数据/raw", ["数据"]), true);
  assert.equal(folderProtectLocked("数据", ["数据"]), false);
});

test("protected paths cover descendants and reject whole-project", () => {
  assert.equal(pathIsProtected("数据/raw/a.csv", ["数据/raw"]), true);
  assert.equal(pathIsProtected("论文/综述.md", ["数据/raw"]), false);
  assert.equal(parseProtectedPathDraft("数据/raw\n.\n").error, "保护路径不能是整个项目");
  assert.deepEqual(parseProtectedPathDraft("数据/raw\n数据/raw/a.csv").paths, [
    "数据/raw",
  ]);
});

test("nextGoalHint says what to do first", () => {
  assert.equal(nextGoalHint("research", []), "");
  assert.equal(nextGoalHint("office", []), "");
  assert.match(
    nextGoalHint("office", [
      { name: "1", status: "stopped", description: "优化表格" },
    ]),
    /没做完，点重试/,
  );
  assert.match(
    nextGoalHint("research", [{ name: "写综述", status: "pending_review" }]),
    /验收/,
  );
});

test("goalDisplayName prefers the longer description", () => {
  assert.equal(
    goalDisplayName({ name: "1", description: "优化表格" }),
    "优化表格",
  );
  assert.equal(goalDisplayName({ name: "写综述", description: "写综述" }), "写综述");
});

test("acceptedGoalOutputs prefers adopted files over whole-project scope", () => {
  assert.deepEqual(acceptedGoalOutputs(["."], ["论文/综述.md"]), ["论文/综述.md"]);
  assert.deepEqual(acceptedGoalOutputs(["notes"], []), ["notes"]);
});

test("目标短名取第一行、超长截断；完整要求不把短名和全文说两遍", async () => {
  const { goalShortTitle, goalFullText, scopeFromInputPaths } = await import("../src/project-tasks.ts");
  assert.equal(goalShortTitle("\n  写周报  \n细节"), "写周报");
  const long = "一".repeat(50);
  assert.equal(goalShortTitle(long), `${"一".repeat(40)}…`);
  assert.equal(goalFullText({ name: `${"一".repeat(40)}…`, description: long }), long);
  assert.equal(goalFullText({ name: "整理周报", description: "依据原始记录写周报" }), "整理周报\n\n依据原始记录写周报");
  assert.equal(goalFullText({ name: "整理周报", description: "" }), "整理周报");
  assert.deepEqual(scopeFromInputPaths(["."]), { scope: "whole", selected: [] });
  assert.deepEqual(scopeFromInputPaths([]), { scope: "none", selected: [] });
  assert.deepEqual(scopeFromInputPaths(["数据", "文档/a.md"]), { scope: "selected", selected: ["数据", "文档/a.md"] });
});
