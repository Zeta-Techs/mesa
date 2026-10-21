import assert from "node:assert/strict";
import test from "node:test";
import { pickerRows } from "../src/chat-project-picker.ts";

const projects = [
  { path: "/u/code/ccode", name: "ccode", workMode: "coding", lastOpenedAt: "2026-10-20" },
  { path: "/u/res/gut", name: "肠道菌群综述", workMode: "research", defaultAgent: "codex", lastOpenedAt: "2026-10-21" },
  { path: "/u/office/weekly", name: "部门周报", workMode: "office", lastOpenedAt: "2026-10-01" },
];

test("不搜：按最近活动排，近期活动表优先于 lastOpenedAt，带类型与项目默认", () => {
  const { rows, fixed } = pickerRows({
    projects,
    recentRepos: [{ path: "/u/code/ccode", name: "Ccode", lastActive: "2026-10-22" }],
    cwd: "/u/code/ccode/",
    home: "/u",
    query: "",
  });
  assert.deepEqual(rows.map((r) => r.label), ["Ccode", "肠道菌群综述", "部门周报"]);
  assert.equal(rows[0].current, true);
  assert.equal(rows[0].workMode, "coding");
  assert.equal(rows[1].defaultAgent, "codex");
  assert.deepEqual(fixed.map((f) => f.label), ["随手聊", "主目录"]);
  assert.equal(fixed[0].path, "/u/ccode/scratch");
});

test("搜：按名字或文件夹名包含，固定两行只在名字对得上时出现", () => {
  const r = pickerRows({ projects, cwd: "~", home: "/u", query: "Week" });
  assert.deepEqual(r.rows.map((x) => x.label), ["部门周报"]);
  assert.equal(r.fixed.length, 0);
  const s = pickerRows({ projects, cwd: "~", home: "/u", query: "随手" });
  assert.deepEqual(s.fixed.map((f) => f.kind), ["scratch"]);
  const home = pickerRows({ projects, cwd: "~", home: "/u", query: "" });
  assert.equal(home.fixed.find((f) => f.kind === "home")?.current, true, "~ 认作主目录");
});
