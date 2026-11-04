import assert from "node:assert/strict";
import test from "node:test";
import {
  attributeProject,
  mesaErrorLine,
  pathLikeArgs,
  recentMesaErrors,
  shouldRecordFailure,
} from "../src/mesa-errors.ts";

test("终端收发、插件与取消不算 Mesa 出错", () => {
  assert.equal(shouldRecordFailure("pty_write", "closed"), false);
  assert.equal(shouldRecordFailure("mesa_error_record", "x"), false);
  assert.equal(shouldRecordFailure("plugin:dialog|open", "x"), false);
  assert.equal(shouldRecordFailure("save_step", "已取消"), false);
  assert.equal(shouldRecordFailure("save_step", ""), false);
  assert.equal(shouldRecordFailure("save_step", new Error("nothing added to commit")), true);
});

test("参数里的路径只看两层、只认像路径的字符串", () => {
  assert.deepEqual(pathLikeArgs({ projectRoot: "/p/a", name: "x", input: { cwd: "~/b" } }), ["/p/a", "~/b"]);
  assert.deepEqual(pathLikeArgs({ a: { b: { c: { d: "/too/deep" } } } }), []);
  assert.deepEqual(pathLikeArgs({ p: "C:\\Users\\x" }), ["C:\\Users\\x"]);
});

test("按项目根或工作副本归属，取最具体的根", () => {
  const index = {
    roots: ["/p/a", "/p/a/sub"],
    worktrees: [{ path: "/w/a-step1", root: "/p/a" }],
  };
  assert.equal(attributeProject({ path: "/p/a/x.md" }, index), "/p/a");
  assert.equal(attributeProject({ path: "/p/a/sub/y" }, index), "/p/a/sub");
  assert.equal(attributeProject({ worktreePath: "/w/a-step1/.ccode" }, index), "/p/a");
  assert.equal(attributeProject({ path: "/elsewhere" }, index), null);
  assert.equal(attributeProject(undefined, index), null);
});

test("出错一行写清次数与用户看到的提示", () => {
  const line = mesaErrorLine({
    at: "2026-11-04T10:00:00+08:00",
    firstAt: "",
    count: 3,
    source: "invoke",
    command: "save_step",
    message: "nothing added",
    notice: "保存进项目失败：nothing added",
    version: "0.2.0",
  });
  assert.match(line, /save_step 失败（10 分钟内 3 次）：nothing added；你看到的提示：保存进项目失败/);
  const now = Date.parse("2026-11-05T09:00:00+08:00");
  const rows = [
    { at: "2026-11-04T10:00:00+08:00", firstAt: "", count: 1, source: "invoke", command: "a", message: "x", version: "" },
    { at: "2026-11-01T10:00:00+08:00", firstAt: "", count: 1, source: "invoke", command: "b", message: "y", version: "" },
  ];
  assert.deepEqual(recentMesaErrors(rows, now).map((r) => r.command), ["a"]);
});

test("例行的「没找到」认得出来（只在配上红色提示时才记）", async () => {
  const { isRoutineFailure } = await import("../src/mesa-errors.ts");
  assert.equal(isRoutineFailure("路径不可读: No such file or directory (os error 2)"), true);
  assert.equal(isRoutineFailure("读取目录失败: Not a directory (os error 20)"), true);
  assert.equal(isRoutineFailure("文件不存在或不可读: x"), true);
  assert.equal(isRoutineFailure("nothing added to commit"), false);
  assert.equal(isRoutineFailure("路径不在项目/登记资源/工作区/终端目录范围内，拒绝读取"), false);
});
