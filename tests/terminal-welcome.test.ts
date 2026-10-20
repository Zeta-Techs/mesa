import assert from "node:assert/strict";
import test from "node:test";
import {
  collapseHomeTreeOnce,
  idleTabTitle,
  isTerminalIdle,
  welcomeCwdActionLabel,
  welcomeCwdLine,
  welcomeCwdShown,
  welcomeDirChoices,
  cwdChipLabel,
} from "../src/terminal-welcome.ts";

test("无 PTY 或尚未上报都算未启动", () => {
  assert.equal(isTerminalIdle(null), true);
  assert.equal(isTerminalIdle(undefined), true);
  assert.equal(isTerminalIdle({ ptyId: null }), true);
  assert.equal(isTerminalIdle({ ptyId: "" }), true);
  assert.equal(isTerminalIdle({ ptyId: "pty-1" }), false);
});

test("空态目录短名：空串和裸 ~ 都显示 ~，家目录折 ~", () => {
  assert.equal(welcomeCwdShown("", "/Users/me"), "~");
  assert.equal(welcomeCwdShown("  ", "/Users/me"), "~");
  assert.equal(welcomeCwdShown("~", "/Users/me"), "~");
  assert.equal(welcomeCwdShown("/Users/me", "/Users/me"), "~");
  assert.equal(welcomeCwdShown("/Users/me/src", "/Users/me"), "~/src");
  assert.equal(welcomeCwdShown("/opt/app", "/Users/me"), "/opt/app");
  assert.equal(welcomeCwdShown("/Users/me/src", ""), "/Users/me/src");
  assert.equal(
    welcomeCwdShown("C:\\Users\\me\\proj", "C:\\Users\\me", true),
    "~/proj",
  );
});

test("未启动且目录是 ~ 时标签写成未启动", () => {
  assert.equal(idleTabTitle("~", true), "未启动");
  assert.equal(idleTabTitle("", true), "未启动");
  assert.equal(idleTabTitle("/Users/me/src", true), null);
  assert.equal(idleTabTitle("/Users/me/ccode/scratch", true), "未启动");
  assert.equal(idleTabTitle("C:\\Users\\me\\ccode\\scratch", true), "未启动");
  assert.equal(idleTabTitle("~", false), null);
});

test("空态目录行：启动与恢复各一句", () => {
  assert.equal(
    welcomeCwdActionLabel("/Users/me", "/Users/me", false),
    "将在 ~ 启动",
  );
  assert.equal(
    welcomeCwdActionLabel("/Users/me/src", "/Users/me", true),
    "将在 ~/src 恢复",
  );
  assert.equal(welcomeCwdLine("/Users/me", "/Users/me", "启动"), "将在 ~ 启动");
});

test("主目录文件树：已经开着才自动收一次，人点开的保持打开", () => {
  assert.deepEqual(collapseHomeTreeOnce(true, true, false), {
    open: false,
    handled: true,
  });
  assert.deepEqual(collapseHomeTreeOnce(true, true, true), {
    open: true,
    handled: true,
  });
  assert.deepEqual(collapseHomeTreeOnce(true, false, false), {
    open: false,
    handled: false,
  });
  assert.deepEqual(collapseHomeTreeOnce(false, true, true), {
    open: true,
    handled: false,
  });
});

test("welcomeDirChoices：随手聊 → 最近项目 → 主目录，标出当前", () => {
  const choices = welcomeDirChoices({
    cwd: "~",
    home: "/Users/me",
    projectPaths: ["/Users/me/a", "/Users/me/b", "/Users/me/c"],
    recentRepos: [
      { path: "/Users/me/b", name: "乙项目", lastActive: "2026-10-17T00:00:00Z" },
      { path: "/Users/me/a", name: "甲项目", lastActive: "2026-10-01T00:00:00Z" },
    ],
    limit: 2,
  });
  assert.deepEqual(
    choices.map((c) => [c.label, c.kind, c.current]),
    [
      ["随手聊", "scratch", false],
      ["乙项目", "project", false],
      ["甲项目", "project", false],
      ["主目录", "home", true],
    ],
  );
  assert.equal(choices[0]!.path, "/Users/me/ccode/scratch");
  const inProject = welcomeDirChoices({
    cwd: "~/c",
    home: "/Users/me/",
    projectPaths: ["/Users/me/c"],
  });
  assert.equal(inProject.find((c) => c.current)?.label, "c");
  assert.deepEqual(welcomeDirChoices({ cwd: "~", home: "", projectPaths: [] }), []);
});

test("cwdChipLabel：项目名 / 随手聊 / 主目录 / 文件夹名", () => {
  const base = { home: "/Users/u", projectPaths: ["/work/a"], recentRepos: [{ path: "/work/a", name: "测试项目" }] };
  assert.equal(cwdChipLabel({ ...base, cwd: "~" }), "主目录");
  assert.equal(cwdChipLabel({ ...base, cwd: "/Users/u/" }), "主目录");
  assert.equal(cwdChipLabel({ ...base, cwd: "/Users/u/ccode/scratch" }), "随手聊");
  assert.equal(cwdChipLabel({ ...base, cwd: "/work/a" }), "测试项目");
  assert.equal(cwdChipLabel({ ...base, cwd: "/tmp/some-folder" }), "some-folder");
});
