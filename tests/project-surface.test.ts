import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeProjectSurfaceTab,
  projectSurfaceStorageKey,
  projectTaskLabel,
  projectSurfaceTabsForMode,
  readProjectSurfaceTab,
} from "../src/project-surface.ts";

test("projectTaskLabel keeps the user-facing mode names", () => {
  assert.equal(projectTaskLabel("research"), "科研任务");
  assert.equal(projectTaskLabel("office"), "工作任务");
  assert.equal(projectTaskLabel("coding"), "编程任务");
});

test("project surface tabs normalize damaged values to tasks", () => {
  assert.equal(normalizeProjectSurfaceTab("files"), "files");
  assert.equal(normalizeProjectSurfaceTab("agents"), "agents");
  // 「对话」页签已撤（对话挂进侧栏项目树），旧值回落默认
  assert.equal(normalizeProjectSurfaceTab("chats"), "tasks");
  assert.equal(normalizeProjectSurfaceTab("schedules"), "schedules");
  assert.equal(normalizeProjectSurfaceTab("unknown"), "tasks");
  assert.equal(normalizeProjectSurfaceTab(null), "tasks");
});

test("all work modes put tasks, schedules, files, and agents in that order", () => {
  assert.deepEqual(projectSurfaceTabsForMode("office"), [
    "tasks",
    "schedules",
    "files",
    "agents",
  ]);
  assert.deepEqual(projectSurfaceTabsForMode("research"), [
    "tasks",
    "schedules",
    "files",
    "agents",
  ]);
  assert.deepEqual(projectSurfaceTabsForMode("coding"), [
    "tasks",
    "schedules",
    "files",
    "agents",
  ]);
  assert.equal(normalizeProjectSurfaceTab("files", "office"), "files");
  assert.equal(
    readProjectSurfaceTab("/repo/a", {
      getItem() {
        return "files";
      },
    }, "office"),
    "files",
  );
});

test("project surface selection is per project and storage failures are safe", () => {
  const values = new Map<string, string>([
    [projectSurfaceStorageKey("/repo/a"), "files"],
  ]);
  const storage = {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
  };
  assert.equal(readProjectSurfaceTab("/repo/a", storage), "files");
  assert.equal(readProjectSurfaceTab("/repo/b", storage), "tasks");
  assert.equal(
    readProjectSurfaceTab("/repo/a", {
      getItem() {
        throw new Error("unavailable");
      },
    }),
    "tasks",
  );
});
