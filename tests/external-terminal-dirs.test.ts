import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRecentExternalProjects,
  parseExternalRecentDirs,
  recordExternalRecentDir,
  resolveDefaultExternalCwd,
  resolveProjectDirFromCwd,
} from "../src/external-terminal-dirs.ts";

const projects = [
  { path: "/u/demo", name: "示例课题（演示）", lastOpenedAt: "2026-11-10T10:00:00Z" },
  { path: "/u/chat-test", name: "聊天层测试", lastOpenedAt: "2026-11-09T10:00:00Z" },
  { path: "/u/her-review", name: "HER催化综述", lastOpenedAt: "2026-11-08T10:00:00Z" },
];

const workspaces = [
  {
    repoPath: "/u/her-review",
    worktreePath: "/u/ccode/workspaces/HER催化综述-step1",
  },
];

test("手动选择打开的目录：下次外部打开默认是它，且出现在最近项目首位", () => {
  let recent = recordExternalRecentDir(
    [],
    "/u/Documents/Ccode/",
    "2026-11-14T15:00:00Z",
    workspaces,
  );
  // 即使之后 Mesa 内部流水线把 lastLaunch.cwd 改成了隔离 worktree，外部默认仍保持上次打开的项目
  const defaultCwd = resolveDefaultExternalCwd({
    externalRecent: recent,
    projects,
    workspaces,
    legacyLastLaunchCwd: "/u/ccode/workspaces/HER催化综述-step1",
    homeDir: "/u",
  });
  assert.equal(defaultCwd, "/u/Documents/Ccode");

  const chips = buildRecentExternalProjects({
    externalRecent: recent,
    projects,
    workspaces,
    homeDir: "/u",
  });
  assert.deepEqual(
    chips.map((c) => c.name),
    ["Ccode", "示例课题（演示）", "聊天层测试", "HER催化综述"],
  );
  assert.equal(chips[0].path, "/u/Documents/Ccode");

  // 再打开已注册项目时：该项目置顶并保留注册名称，原先手动打开的目录仍留在最近项目里
  recent = recordExternalRecentDir(
    recent,
    "/u/her-review",
    "2026-11-14T16:00:00Z",
    workspaces,
  );
  assert.equal(
    resolveDefaultExternalCwd({ externalRecent: recent, projects, workspaces, homeDir: "/u" }),
    "/u/her-review",
  );
  assert.deepEqual(
    buildRecentExternalProjects({ externalRecent: recent, projects, workspaces, homeDir: "/u" }).map(
      (c) => c.name,
    ),
    ["HER催化综述", "Ccode", "示例课题（演示）", "聊天层测试"],
  );
});

test("弹窗内点浏览手动选目录：未点启动前也立即显示在最近项目首位", () => {
  const chips = buildRecentExternalProjects({
    pickedDirs: ["/u/Desktop/临时数据/"],
    externalRecent: [],
    projects,
    workspaces,
    homeDir: "/u",
  });
  assert.equal(chips[0].path, "/u/Desktop/临时数据");
  assert.equal(chips[0].name, "临时数据");
});

test("尚无外部打开记录时：过滤内部 worktree / scratch，优先取最近活动的项目或仓库", () => {
  const defaultCwd = resolveDefaultExternalCwd({
    externalRecent: [],
    projects,
    recentRepos: [{ path: "/u/Documents/Ccode", name: "Ccode", lastActive: "2026-11-14T15:50:00Z" }],
    workspaces,
    legacyLastLaunchCwd: "/u/ccode/workspaces/HER催化综述-step1",
    homeDir: "/u",
  });
  assert.equal(defaultCwd, "/u/Documents/Ccode");

  // 无项目与仓库时，worktree 折回主项目，未登记的隔离目录与 scratch 不冒充项目
  assert.equal(
    resolveProjectDirFromCwd("/u/ccode/workspaces/HER催化综述-step1", workspaces, "/u"),
    "/u/her-review",
  );
  assert.equal(
    resolveProjectDirFromCwd("/u/ccode/workspaces/orphan-wt", workspaces, "/u"),
    "",
  );
  assert.equal(resolveProjectDirFromCwd("/u/ccode/scratch", workspaces, "/u"), "");
  assert.equal(resolveProjectDirFromCwd("/u", workspaces, "/u"), "");
});

test("持久化解析与 Windows 路径跨方言去重", () => {
  const parsed = parseExternalRecentDirs(
    JSON.stringify([
      { path: "D:\\Work\\MyApp\\", openedAt: "2026-11-14T10:00:00Z" },
      { path: "d:/work/myapp", openedAt: "2026-11-14T12:00:00Z" },
      { path: "C:\\Users\\a\\ccode\\workspaces\\wt-1", openedAt: "2026-11-14T13:00:00Z" },
    ]),
    true,
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].openedAt, "2026-11-14T12:00:00Z");

  const chips = buildRecentExternalProjects({
    externalRecent: parsed,
    projects: [{ path: "D:\\Work\\MyApp", name: "我的应用", lastOpenedAt: "2026-11-01" }],
    isWindows: true,
  });
  assert.deepEqual(chips, [{ path: "D:\\Work\\MyApp", name: "我的应用" }]);
});
