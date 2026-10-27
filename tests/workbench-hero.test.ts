import assert from "node:assert/strict";
import test from "node:test";
import type { RunOverviewInput } from "../src/run-overview.ts";
import {
  continueWorkbenchTarget,
  resolveWorkbenchDestination,
  firstOpenStepName,
  openStepProgress,
  stepProgressLabel,
  goalCaptureTargets,
  inboxItemProjectRoot,
  lastUserInstruction,
  latestProjectSession,
  namedSessionTitle,
  pickWorkbenchHero,
  pickWorkbenchNow,
  taskLabelForRun,
  workbenchNowSubtitle,
  workbenchRecentRows,
  WORKBENCH_RECENT_LIMIT,
  type WorkbenchHero,
  type WorkbenchProject,
  type WorkbenchRepo,
  type WorkbenchWorkspaceRef,
} from "../src/workbench-hero.ts";

function run(partial: Partial<RunOverviewInput>): RunOverviewInput {
  return {
    tabId: "t1",
    title: "终端",
    agentId: "claude-code",
    model: "sonnet",
    cwd: "/repo/ccode",
    running: false,
    shell: false,
    attention: null,
    ...partial,
  };
}

const demo: WorkbenchProject = {
  path: "/Users/me/Documents/Ccode 示例课题",
  name: "示例课题（演示）",
};
const ccode: WorkbenchProject = {
  path: "/Users/me/Documents/Ccode",
  name: "Ccode",
};
const repos: WorkbenchRepo[] = [
  { path: "/Users/me/Documents/Ccode", name: "Ccode" },
  { path: "/Users/me/Documents/Ccode 示例课题", name: "Ccode 示例课题" },
  { path: "/Users/me/other", name: "学习" },
];

const demoWs: WorkbenchWorkspaceRef = {
  repoPath: demo.path,
  worktreePath: "/Users/me/Documents/Ccode 示例课题/.ccode/worktrees/lit-notes",
  name: "lit-notes",
  status: "active",
  mergedAt: null,
};

test("前缀路径不会把 /repo/ccode2 归到 /repo/ccode", () => {
  const hero = pickWorkbenchHero({
    projects: [
      { path: "/repo/ccode", name: "Ccode" },
      { path: "/repo/ccode2", name: "Ccode2", workMode: "coding" },
    ],
    recentRepos: [],
    workspaces: [],
    runs: [run({ running: true, cwd: "/repo/ccode2/src" })],
    contextName: null,
  });
  assert.equal(hero?.path, "/repo/ccode2");
  assert.equal(hero?.name, "Ccode2");
  assert.equal(hero?.workMode, "coding");
});

test("运行中的标签赢过上次选中的项目，名称用注册名", () => {
  const hero = pickWorkbenchHero({
    projects: [demo, ccode],
    recentRepos: repos,
    workspaces: [demoWs],
    runs: [run({ running: true, cwd: "/Users/me/Documents/Ccode" })],
    contextName: "示例课题（演示）",
  });
  assert.equal(hero?.path, "/Users/me/Documents/Ccode");
  assert.equal(hero?.name, "Ccode");
  assert.equal(hero?.source, "running");
  assert.equal(hero?.tabId, "t1");
  assert.equal(hero?.runningCount, 1);
  assert.equal(hero?.agentId, "claude-code");
});

test("工作树里的运行归到项目根，继续工作带该标签", () => {
  const hero = pickWorkbenchHero({
    projects: [demo, ccode],
    recentRepos: repos,
    workspaces: [demoWs],
    runs: [
      run({
        tabId: "ws",
        running: true,
        attention: "working",
        cwd: "/Users/me/Documents/Ccode 示例课题/.ccode/worktrees/lit-notes/notes",
      }),
    ],
    contextName: null,
  });
  assert.equal(hero?.path, demo.path);
  assert.equal(hero?.name, "示例课题（演示）");
  assert.equal(hero?.registered, true);
  assert.equal(hero?.tabId, "ws");
  assert.equal(hero?.attention, "working");
});

test("运行计数只算这张卡所属项目，不算别的仓库", () => {
  const hero = pickWorkbenchHero({
    projects: [demo, ccode],
    recentRepos: repos,
    workspaces: [demoWs],
    runs: [
      run({
        tabId: "a",
        running: true,
        attention: "confirm",
        cwd: "/Users/me/Documents/Ccode",
      }),
      run({
        tabId: "b",
        running: true,
        agentId: "codex",
        cwd: demo.path,
      }),
    ],
    contextName: null,
  });
  assert.equal(hero?.path, "/Users/me/Documents/Ccode");
  assert.equal(hero?.runningCount, 1);
  assert.equal(hero?.tabId, "a");
  assert.equal(hero?.attention, "confirm");
});

test("没有运行时用上次选中的已添加项目，目录名回落到注册名", () => {
  const hero = pickWorkbenchHero({
    projects: [{ ...demo, workMode: "office" }, ccode],
    recentRepos: repos,
    workspaces: [],
    runs: [run({ cwd: "/Users/me/Documents/Ccode", running: false })],
    contextName: "Ccode 示例课题",
  });
  assert.equal(hero?.path, demo.path);
  assert.equal(hero?.name, "示例课题（演示）");
  assert.equal(hero?.source, "context");
  assert.equal(hero?.tabId, null);
  assert.equal(hero?.runningCount, 0);
  assert.equal(hero?.workMode, "office");
});

test("没有上下文时取时间序里最近的已添加项目，不把旧注册项抬到最前", () => {
  const hero = pickWorkbenchHero({
    projects: [demo, ccode],
    recentRepos: repos,
    workspaces: [],
    runs: [],
    contextName: null,
  });
  assert.equal(hero?.path, ccode.path);
  assert.equal(hero?.source, "recent-registered");
});

test("未匹配任何项目的运行目录仍作为当前工作", () => {
  const hero = pickWorkbenchHero({
    projects: [demo],
    recentRepos: repos,
    workspaces: [],
    runs: [run({ tabId: "x", running: true, cwd: "/tmp/scratch" })],
    contextName: "示例课题（演示）",
  });
  assert.equal(hero?.path, "/tmp/scratch");
  assert.equal(hero?.registered, false);
  assert.equal(hero?.source, "running");
  assert.equal(hero?.tabId, "x");
});

test("Windows 路径大小写与工作树前缀仍能归到项目", () => {
  const hero = pickWorkbenchHero({
    isWindows: true,
    projects: [{ path: "C:\\Users\\me\\Demo", name: "演示" }],
    recentRepos: [{ path: "C:\\Users\\me\\Demo", name: "Demo" }],
    workspaces: [
      {
        repoPath: "C:\\Users\\me\\Demo",
        worktreePath: "C:\\Users\\me\\Demo\\.ccode\\worktrees\\search",
        name: "search",
        status: "active",
        mergedAt: null,
      },
    ],
    runs: [
      run({
        running: true,
        cwd: "c:/users/me/demo/.ccode/worktrees/search",
      }),
    ],
    contextName: null,
  });
  assert.equal(hero?.name, "演示");
  assert.equal(hero?.registered, true);
});

test("继续工作：有标签去终端，已添加去项目详情，否则真进入", () => {
  const running: WorkbenchHero = {
    name: "Ccode",
    path: ccode.path,
    registered: true,
    tabId: "t9",
    agentId: "codex",
    model: "",
    attention: "working",
    runningCount: 1,
    runs: [
      {
        tabId: "t9",
        agentId: "codex",
        attention: "working",
        taskLabel: "Ccode",
      },
    ],
    source: "running",
  };
  assert.deepEqual(continueWorkbenchTarget(running), {
    kind: "terminal",
    tabId: "t9",
  });
  assert.deepEqual(
    continueWorkbenchTarget({
      ...running,
      runs: [{ ...running.runs[0]!, runId: "run-1" }],
    }),
    { kind: "terminal", tabId: "t9", runId: "run-1" },
  );
  assert.deepEqual(
    continueWorkbenchTarget({ ...running, tabId: null, source: "context" }),
    { kind: "project", path: ccode.path },
  );
  assert.deepEqual(
    continueWorkbenchTarget({
      ...running,
      tabId: null,
      registered: false,
      path: "/tmp/scratch",
      source: "recent",
    }),
    { kind: "enter-cwd", path: "/tmp/scratch" },
  );
});

test("firstOpenStepName 取第一个未合并步骤，全完成回末步", () => {
  const steps = [
    { name: "文献检索与筛选", workspaceName: "lit-search" },
    { name: "精读与研究空白", workspaceName: "lit-notes" },
  ];
  assert.equal(firstOpenStepName(steps, []), "文献检索与筛选");
  assert.equal(
    firstOpenStepName(steps, [
      {
        name: "lit-search",
        status: "active",
        mergedAt: "2026-09-01",
      },
    ]),
    "精读与研究空白",
  );
  assert.equal(
    firstOpenStepName(steps, [
      { name: "lit-search", status: "active", mergedAt: "a" },
      { name: "lit-notes", status: "active", mergedAt: "b" },
    ]),
    "精读与研究空白",
  );
  assert.equal(firstOpenStepName([], []), null);
  assert.equal(
    firstOpenStepName(
      [
        {
          name: "文献检索与筛选",
          workspaceName: "lit-search",
          seedComplete: true,
        },
        { name: "文献精读与笔记", workspaceName: "lit-notes" },
      ],
      [],
    ),
    "文献精读与笔记",
  );
});

test("namedSessionTitle 丢掉未命名对话", () => {
  assert.equal(namedSessionTitle({ customTitle: "方向", title: "hi" }), "方向");
  assert.equal(namedSessionTitle({ customTitle: null, title: "  " }), null);
  assert.equal(namedSessionTitle({ customTitle: null, title: null }), null);
  assert.equal(namedSessionTitle({ customTitle: null, title: "未命名对话" }), null);
  assert.equal(
    namedSessionTitle({
      customTitle: null,
      title: "https://example.com/a",
      summary: "网页美观度对标顶尖AI网站",
    }),
    "网页美观度对标顶尖AI网站",
  );
});

test("workbenchNowSubtitle prefers pending review over step fallback", () => {
  assert.deepEqual(
    workbenchNowSubtitle({
      tasks: [{ name: "整理数据", status: "pending_review" }],
      fallback: "文献检索",
    }),
    { subtitle: "整理数据待验收", needsYou: true },
  );
  assert.deepEqual(
    workbenchNowSubtitle({
      tasks: [{ name: "写周报", status: "running" }],
      fallback: "最近有文档对话",
    }),
    { subtitle: "写周报进行中", needsYou: true },
  );
  assert.deepEqual(
    workbenchNowSubtitle({
      tasks: [{ name: "记下", status: "pending" }],
      fallback: "文献检索",
    }),
    { subtitle: "文献检索", needsYou: false },
  );
});

test("最近项目：已添加用注册名，外部仓库标未添加", () => {
  const rows = workbenchRecentRows({
    recentRepos: [
      { path: "/Users/me/Documents/Ccode", name: "Ccode", lastActive: "2026-09-03" },
      { path: "/Users/me/codex-playground", name: "codex-playground", lastActive: "2026-09-02" },
      { path: "/Users/me/Documents/Ccode 示例课题", name: "Ccode 示例课题" },
    ],
    projects: [ccode, { ...demo, name: "示例课题（演示）" }],
    excludePaths: [ccode.path],
  });
  assert.deepEqual(
    rows.map((r) => ({ name: r.name, registered: r.registered, path: r.path })),
    [
      {
        name: "codex-playground",
        registered: false,
        path: "/Users/me/codex-playground",
      },
      {
        name: "示例课题（演示）",
        registered: true,
        path: "/Users/me/Documents/Ccode 示例课题",
      },
    ],
  );
});

test("最近项目 Windows 路径按同一仓库认已添加", () => {
  const rows = workbenchRecentRows({
    recentRepos: [{ path: "C:\\Users\\me\\Demo", name: "Demo" }],
    projects: [{ path: "c:/Users/me/Demo", name: "演示项目" }],
    isWindows: true,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.name, "演示项目");
  assert.equal(rows[0]?.registered, true);
});

test("最近项目包含没有会话的已添加项目，新建排在前面", () => {
  const rows = workbenchRecentRows({
    recentRepos: [
      { path: "/old-session", name: "old-session", lastActive: "2026-01-01T00:00:00Z" },
    ],
    projects: [
      {
        path: "/Users/me/Desktop/AI应用教程",
        name: "AI应用教程",
        lastOpenedAt: "2026-09-03T10:00:00Z",
      },
    ],
  });
  assert.deepEqual(
    rows.map((r) => ({ name: r.name, registered: r.registered })),
    [
      { name: "AI应用教程", registered: true },
      { name: "old-session", registered: false },
    ],
  );
});

test("最近项目默认最多 6 条", () => {
  assert.equal(WORKBENCH_RECENT_LIMIT, 6);
  const projects = Array.from({ length: 12 }, (_, i) => ({
    path: `/p/${String(i).padStart(2, "0")}`,
    name: `项目${i}`,
    lastOpenedAt: `2026-09-03T00:00:${String(i).padStart(2, "0")}Z`,
  }));
  const rows = workbenchRecentRows({ recentRepos: [], projects });
  assert.equal(rows.length, 6);
  assert.equal(rows[0]?.name, "项目11");
  assert.equal(rows[5]?.name, "项目6");
});

test("正在进行：确认优先，并行项目都在，安静项目不进", () => {
  const items = pickWorkbenchNow({
    seeds: [
      {
        path: demo.path,
        name: demo.name,
        registered: true,
        workMode: "research",
        subtitle: "文献检索",
        needsYou: true,
      },
      {
        path: ccode.path,
        name: ccode.name,
        registered: true,
        workMode: "coding",
        subtitle: "payment 需同步",
        needsYou: true,
        extraRoots: ["/Users/me/ccode/worktrees/Ccode/payment"],
      },
      {
        path: "/Users/me/docs",
        name: "材料",
        registered: true,
        workMode: "office",
        subtitle: null,
        needsYou: false,
      },
    ],
    runs: [
      run({
        tabId: "pay",
        running: true,
        attention: "confirm",
        cwd: "/Users/me/ccode/worktrees/Ccode/payment",
      }),
    ],
  });
  assert.equal(items.length, 2);
  assert.equal(items[0]?.path, ccode.path);
  assert.equal(items[0]?.tabId, "pay");
  assert.equal(items[0]?.workMode, "coding");
  assert.equal(items[1]?.path, demo.path);
  assert.equal(items[1]?.subtitle, "文献检索");
  assert.equal(items[0]?.runningCount, 1);
  assert.equal(items[0]?.attention, "confirm");
  assert.equal(items[0]?.runs.length, 1);
  assert.equal(items[0]?.runs[0]?.tabId, "pay");
});

test("正在进行：还开着的阅读标签算干活，无头不算", () => {
  const items = pickWorkbenchNow({
    seeds: [
      {
        path: demo.path,
        name: demo.name,
        registered: true,
        workMode: "research",
        subtitle: null,
        needsYou: false,
      },
    ],
    runs: [
      run({
        tabId: "read",
        reuseKey: `reader:${demo.path}`,
        running: false,
        shell: true,
        cwd: demo.path,
        title: "阅读 · paper",
      }),
      run({
        tabId: "watch",
        reuseKey: "watch:1:/p",
        running: true,
        cwd: demo.path,
      }),
    ],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.runs[0]?.tabId, "read");
});

test("正在进行：登录标签不算干活", () => {
  const items = pickWorkbenchNow({
    seeds: [
      {
        path: ccode.path,
        name: ccode.name,
        registered: true,
        workMode: "coding",
        subtitle: null,
        needsYou: false,
      },
    ],
    runs: [
      run({
        tabId: "login",
        reuseKey: "login:codex",
        running: true,
        cwd: ccode.path,
      }),
    ],
  });
  assert.equal(items.length, 0);
});

test("taskLabelForRun：占位「终端」回落到目录尾段", () => {
  assert.equal(
    taskLabelForRun({ title: "feature/login", cwd: "/repo/wt" }),
    "feature/login",
  );
  assert.equal(
    taskLabelForRun({ title: "终端", cwd: "/Users/me/ccode/worktrees/app/login" }),
    "login",
  );
});

test("正在进行：同一项目两次 Run 都挂在卡上，待确认排前面", () => {
  const items = pickWorkbenchNow({
    seeds: [
      {
        path: ccode.path,
        name: ccode.name,
        registered: true,
        workMode: "coding",
        subtitle: null,
        needsYou: false,
        extraRoots: [
          "/Users/me/ccode/worktrees/Ccode/login-ui",
          "/Users/me/ccode/worktrees/Ccode/login-api",
        ],
      },
    ],
    runs: [
      run({
        tabId: "ui",
        title: "feature/login-ui",
        agentId: "claude-code",
        running: true,
        attention: "working",
        cwd: "/Users/me/ccode/worktrees/Ccode/login-ui",
      }),
      run({
        tabId: "api",
        title: "feature/login-api",
        agentId: "codex",
        running: true,
        attention: "confirm",
        cwd: "/Users/me/ccode/worktrees/Ccode/login-api",
      }),
    ],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.runningCount, 2);
  assert.equal(items[0]?.tabId, "api");
  assert.equal(items[0]?.agentId, "codex");
  assert.equal(items[0]?.attention, "confirm");
  assert.deepEqual(
    items[0]?.runs.map((r) => r.tabId),
    ["api", "ui"],
  );
  assert.equal(items[0]?.runs[0]?.taskLabel, "feature/login-api");
});

test("正在进行：隔离目标副本按 runId/taskId 归到真实项目，不单独成卡", () => {
  const staging =
    "/Users/me/Library/Application Support/ccode/task-runs/task-1/9f9b0a-staging";
  const items = pickWorkbenchNow({
    seeds: [
      {
        path: ccode.path,
        name: ccode.name,
        registered: true,
        workMode: "coding",
        subtitle: null,
        needsYou: false,
      },
    ],
    runs: [
      run({
        tabId: "goal",
        running: true,
        attention: "working",
        cwd: staging,
        reuseKey: "task:task-1",
        runId: "run-1",
        taskId: "task-1",
      }),
    ],
    attribution: {
      runProjects: { "run-1": ccode.path },
      taskProjects: { "task-1": ccode.path },
    },
  });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.path, ccode.path);
  assert.equal(items[0]?.registered, true);
  assert.equal(items[0]?.runs[0]?.tabId, "goal");
});

test("正在进行：重启恢复的标签没有 reuseKey，按 runId 或 taskId 归属", () => {
  const staging = "/x/ccode/task-runs/task-2/uuid-staging";
  const seed = {
    path: ccode.path,
    name: ccode.name,
    registered: true,
    workMode: "coding" as const,
    subtitle: null,
    needsYou: false,
  };
  const byRunId = pickWorkbenchNow({
    seeds: [seed],
    runs: [run({ tabId: "r1", running: true, cwd: staging, runId: "run-2" })],
    attribution: { runProjects: { "run-2": ccode.path } },
  });
  assert.equal(byRunId.length, 1);
  assert.equal(byRunId[0]?.path, ccode.path);
  const byTaskId = pickWorkbenchNow({
    seeds: [seed],
    runs: [run({ tabId: "r2", running: true, cwd: staging, taskId: "task-2" })],
    attribution: { taskProjects: { "task-2": ccode.path } },
  });
  assert.equal(byTaskId.length, 1);
  assert.equal(byTaskId[0]?.path, ccode.path);
});

test("正在进行：归属表外的隔离目录仍按 cwd 单独成卡（不猜）", () => {
  const items = pickWorkbenchNow({
    seeds: [
      {
        path: ccode.path,
        name: ccode.name,
        registered: true,
        workMode: "coding",
        subtitle: null,
        needsYou: false,
      },
    ],
    runs: [run({ tabId: "x", running: true, cwd: "/tmp/scratch" })],
    attribution: { runProjects: {}, taskProjects: {} },
  });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.path, "/tmp/scratch");
  assert.equal(items[0]?.registered, false);
});

test("正在进行：已退出/未启动的保留标签留在卡上但不算运行数", () => {
  const items = pickWorkbenchNow({
    seeds: [
      {
        path: ccode.path,
        name: ccode.name,
        registered: true,
        workMode: "coding",
        subtitle: null,
        needsYou: false,
        extraRoots: ["/Users/me/ccode/worktrees/Ccode/login"],
      },
    ],
    runs: [
      run({
        tabId: "dead",
        reuseKey: "lane:/Users/me/ccode/worktrees/Ccode/login",
        running: false,
        shell: true,
        attention: null,
        cwd: "/Users/me/ccode/worktrees/Ccode/login",
      }),
    ],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.runs.length, 1);
  assert.equal(items[0]?.runs[0]?.live, false);
  assert.equal(items[0]?.runningCount, 0);
});

test("最近项目（交互口径）：纯定时项目不出现，按会话时间排序", () => {
  const projects = [
    { path: "/p/radar", name: "雷达课题", workMode: "research", lastOpenedAt: null, createdAt: "2026-10-13T00:00:00Z" },
    { path: "/p/dev", name: "开发课题", workMode: "research", lastOpenedAt: null, createdAt: "2026-09-01T00:00:00Z" },
    { path: "/p/old", name: "老会话课题", workMode: "research", lastOpenedAt: null, createdAt: "2026-09-01T00:00:00Z" },
  ];
  const interactive = new Map([
    ["/p/dev", "2026-10-12T10:00:00Z"],
    ["/p/old", "2026-09-20T10:00:00Z"],
  ]);
  const rows = workbenchRecentRows({ recentRepos: [], projects, interactiveLast: interactive });
  // 只有会话的项目入选；雷达项目（哪怕今天注册）不出现
  assert.deepEqual(rows.map((r) => r.path), ["/p/dev", "/p/old"]);
  // 排序按交互时间：dev(10-12) 在 old(09-20) 前；lastActive 取交互时间与注册时间较晚者
  assert.equal(rows[0].lastActive, "2026-10-12T10:00:00Z");
  // 不传 interactiveLast 时保持旧口径（全部项目，注册时间兜底）
  const legacy = workbenchRecentRows({ recentRepos: [], projects });
  assert.deepEqual(legacy.map((r) => r.path), ["/p/radar", "/p/dev", "/p/old"]);
});

test("主卡：保留标签不冒充运行数，进程活着就算", () => {
  const hero = pickWorkbenchHero({
    projects: [ccode],
    recentRepos: [],
    workspaces: [],
    runs: [
      run({
        tabId: "dead",
        reuseKey: "lane:/t",
        running: false,
        attention: null,
        cwd: ccode.path,
      }),
      run({
        tabId: "busy",
        running: true,
        attention: "working",
        cwd: ccode.path,
      }),
    ],
    contextName: null,
  });
  assert.equal(hero?.runs.length, 2);
  assert.equal(hero?.runningCount, 1);
  assert.equal(hero?.tabId, "busy");
});

test("同名项目：有上下文路径时按路径选，不按名字取首项", () => {
  const hero = pickWorkbenchHero({
    projects: [
      { path: "/a/demo", name: "演示" },
      { path: "/b/demo", name: "演示" },
    ],
    recentRepos: [],
    workspaces: [],
    runs: [],
    contextName: "演示",
    contextPath: "/b/demo",
  });
  assert.equal(hero?.path, "/b/demo");
  assert.equal(hero?.source, "context");
});

test("同名项目且无上下文路径：不猜首项，回落最近项目", () => {
  const hero = pickWorkbenchHero({
    projects: [
      { path: "/a/demo", name: "演示" },
      { path: "/b/demo", name: "演示" },
    ],
    recentRepos: [{ path: "/b/demo", name: "演示" }],
    workspaces: [],
    runs: [],
    contextName: "演示",
  });
  assert.equal(hero?.source, "recent-registered");
  assert.equal(hero?.path, "/b/demo");
});

test("唯一同名项目仍可按显示名命中上下文", () => {
  const hero = pickWorkbenchHero({
    projects: [
      { path: "/a/demo", name: "演示" },
      { path: "/b/other", name: "别的" },
    ],
    recentRepos: [],
    workspaces: [],
    runs: [],
    contextName: "演示",
  });
  assert.equal(hero?.path, "/a/demo");
  assert.equal(hero?.source, "context");
});

test("lastUserInstruction：取最后一条人说的话，跳过工具结果与系统注入", () => {
  const msg = (role: string, ...blocks: [string, string][]) => ({
    role,
    timestamp: "2026-10-17T01:00:00Z",
    blocks: blocks.map(([kind, text]) => ({ kind, text })),
  });
  const hit = lastUserInstruction([
    msg("user", ["text", "先读一下 /Users/me/proj/papers/a.pdf 再写笔记"]),
    msg("assistant", ["text", "好的"]),
    msg("user", ["tool_result", "ok"]),
    msg("user", ["text", "<system-reminder>ignore</system-reminder>"]),
    msg("user", ["text", "[Request interrupted by user]"]),
  ]);
  assert.equal(hit?.text, "先读一下 a.pdf 再写笔记");
  assert.equal(hit?.timestamp, "2026-10-17T01:00:00Z");
  // Grok 包裹拆掉后仍是人话
  assert.equal(
    lastUserInstruction([msg("user", ["text", "<user_query>把第三节改短</user_query>"])])?.text,
    "把第三节改短",
  );
  assert.equal(lastUserInstruction([msg("assistant", ["text", "x"])]), null);
  const long = lastUserInstruction([msg("user", ["text", "长".repeat(80)])]);
  assert.equal([...long!.text].length, 61);
  assert.equal(long!.full.length, 80);
});

test("lastUserInstruction：Mesa 塞在前面的项目上下文包不算人话", () => {
  const msg = (text: string) => ({
    role: "user",
    timestamp: "2026-10-22T01:00:00Z",
    blocks: [{ kind: "text", text }],
  });
  const pack = "你正在项目「测试项目」中工作。\n工作方式：科研\n项目目录：/u/test\n\n项目里现有（顶层）：\n- papers/";
  // 只发了包：整条跳过，往前找上一句人话
  assert.equal(
    lastUserInstruction([msg("先把检索式定下来"), msg(pack)])?.text,
    "先把检索式定下来",
  );
  assert.equal(lastUserInstruction([msg(pack)]), null);
  // 包 + 分隔 + 第一句话：只取分隔后面
  assert.equal(
    lastUserInstruction([msg(`${pack}\n\n----\n\n帮我筛一下待确认的篇目`)])?.text,
    "帮我筛一下待确认的篇目",
  );
  // 人话里自己写了分隔线不受影响
  assert.equal(
    lastUserInstruction([msg("第一段\n\n----\n\n第二段")])?.text,
    "第一段 ---- 第二段",
  );
});

test("latestProjectSession：同项目最近一次人参与的对话，内部/归档/失效不算", () => {
  const base = { title: "写综述", customTitle: null, alive: true, pinned: false };
  const picked = latestProjectSession(
    [
      { ...base, projectPath: "/p", updatedAt: "2026-10-16T01:00:00Z", sessionId: "old" },
      { ...base, projectPath: "/p", updatedAt: "2026-10-17T01:00:00Z", sessionId: "internal", internal: true },
      { ...base, projectPath: "/p", updatedAt: "2026-10-17T02:00:00Z", sessionId: "arch", archived: true },
      { ...base, projectPath: "/p", updatedAt: "2026-10-17T03:00:00Z", sessionId: "gone", alive: false },
      { ...base, projectPath: "/q", updatedAt: "2026-10-17T04:00:00Z", sessionId: "other" },
      { ...base, projectPath: "/p", updatedAt: "2026-10-16T05:00:00Z", sessionId: "new" },
    ],
    "/p",
  );
  assert.equal(picked?.sessionId, "new");
});

test("inboxItemProjectRoot：按动作类型归到已添加项目", () => {
  const ctx = {
    projectPaths: ["/p", "/q"],
    workspaces: [{ id: "w1", repoPath: "/p", worktreePath: "/wt/p-step" }],
    runProjects: { r1: "/q" },
    tabCwds: { t1: "/q/sub" },
    sessions: [{ agent: "codex", sessionId: "s1", projectPath: "/p" }],
  };
  assert.equal(inboxItemProjectRoot({ type: "review", worktreePath: "/wt/p-step" }, ctx), "/p");
  assert.equal(inboxItemProjectRoot({ type: "artifacts", workspaceId: "w1" }, ctx), "/p");
  assert.equal(inboxItemProjectRoot({ type: "run", runId: "r1" }, ctx), "/q");
  assert.equal(inboxItemProjectRoot({ type: "run", tabId: "t1" }, ctx), "/q");
  assert.equal(inboxItemProjectRoot({ type: "session", agent: "codex", sessionId: "s1" }, ctx), "/p");
  assert.equal(inboxItemProjectRoot({ type: "litWatch", projectRoot: "/q" }, ctx), "/q");
  assert.equal(inboxItemProjectRoot({ type: "settings", section: "diag" }, ctx), null);
  assert.equal(inboxItemProjectRoot({ type: "help", projectRoot: "/elsewhere" }, ctx), null);
});

test("goalCaptureTargets：办公 + 不用流程的科研，编程与有流程科研不进", () => {
  const targets = goalCaptureTargets(
    [
      { path: "/office", name: "周报", workMode: "office" },
      { path: "/lite", name: "读文献", workMode: "research" },
      { path: "/flow", name: "写论文", workMode: "research" },
      { path: "/fresh", name: "新课题", workMode: "research" },
      { path: "/code", name: "仓库", workMode: "coding" },
    ],
    {
      "/lite": { stepCount: 0, pipelineOptOut: true },
      "/flow": { stepCount: 5, pipelineOptOut: false },
      "/fresh": { stepCount: 0, pipelineOptOut: false },
    },
  );
  assert.deepEqual(
    targets.map((t) => [t.path, t.goalKind]),
    [
      ["/office", "office_doc"],
      ["/lite", "free_research"],
    ],
  );
});

test("流程进度：写明进行到第几步，全做完说都已完成；「上次停在」只在别的步骤时标", () => {
  const steps = [
    { name: "文献检索与筛选", workspaceName: "lit-search" },
    { name: "文献精读与笔记", workspaceName: "lit-notes" },
    { name: "综述大纲", workspaceName: "outline" },
  ];
  const merged = (name: string) => ({ name, status: "active", mergedAt: "2026-10-01T00:00:00Z" });
  assert.deepEqual(openStepProgress(steps, []), {
    name: "文献检索与筛选",
    index: 1,
    total: 3,
    done: false,
  });
  assert.equal(
    stepProgressLabel(openStepProgress(steps, [])),
    "进行到：文献检索与筛选（第 1 / 3 步）",
  );
  assert.equal(
    stepProgressLabel(openStepProgress(steps, [merged("lit-search")])),
    "进行到：文献精读与笔记（第 2 / 3 步）",
  );
  const all = [merged("lit-search"), merged("lit-notes"), merged("outline")];
  assert.equal(stepProgressLabel(openStepProgress(steps, all)), "3 步都已完成");
  assert.equal(stepProgressLabel(openStepProgress([steps[0]], [])), "进行到：文献检索与筛选");
  assert.equal(openStepProgress([], []), null);
  assert.equal(stepProgressLabel(null), null);
});


test("项目头文案与执行共用落点：活标签、可恢复 Run、项目与目录", () => {
  const recovered = { id: "old", internal: false, closedAt: "2026-10-27", taskKind: "office_doc", sessionId: "s", runtime: "cli", capabilities: { canResume: true }, projectRoot: "/p", isolationPath: "/p/.wt" } as const;
  assert.deepEqual(resolveWorkbenchDestination({ kind: "terminal", tabId: "t", runId: "live" }, [recovered], false), { kind: "conversation", label: "回到对话", tabId: "t", runId: "live" });
  assert.deepEqual(resolveWorkbenchDestination({ kind: "project", path: "/p" }, [recovered], false), { kind: "conversation", label: "回到对话", runId: "old" });
  assert.deepEqual(resolveWorkbenchDestination({ kind: "project", path: "/other" }, [recovered], false), { kind: "project", label: "打开项目", path: "/other" });
  assert.deepEqual(resolveWorkbenchDestination({ kind: "enter-cwd", path: "/other" }, [recovered], false), { kind: "directory", label: "打开目录", path: "/other" });
  assert.equal(resolveWorkbenchDestination({ kind: "enter-cwd", path: "/p" }, [recovered], false).label, "回到对话");
  assert.equal(resolveWorkbenchDestination({ kind: "project", path: "/p" }, [{ ...recovered, internal: true }], false).label, "打开项目");
  assert.equal(resolveWorkbenchDestination({ kind: "project", path: "c:/Work/P" }, [{ ...recovered, projectRoot: "C:\\work\\p" }], true).label, "回到对话");
});
