import assert from "node:assert/strict";
import test from "node:test";
import { activeProfileGroups, filterProfilePapers, type ResearchProfileDto } from "../src/research-profile.ts";

const entry = (id: string, goalName: string, state = "active", text = id) => ({
  meta: { id, createdAt: "2026-11-02", goalName, state, reason: "r" },
  text,
});

test("研究档案：只列有效条目，按后端分类顺序分组，组内新的在前", () => {
  const profile: ResearchProfileDto = {
    doc: {
      revision: "x",
      legacyText: "",
      entries: [entry("a", "写作偏好"), entry("b", "研究方向"), entry("c", "研究方向", "revoked"), entry("d", "研究方向")],
    },
    settings: { inject: true },
    categories: ["研究方向", "常用方法", "写作偏好"],
  };
  assert.deepEqual(
    activeProfileGroups(profile).map((g) => [g.category, g.entries.map((e) => e.meta.id)]),
    [["研究方向", ["d", "b"]], ["写作偏好", ["a"]]],
  );
});

test("跨项目文献总表：按题名、DOI、项目名筛，大小写不敏感", () => {
  const papers = [
    { title: "Single-Atom Catalysts", doi: "10.1/abc", year: "2020", projects: ["HER 综述"], hasNote: true },
    { title: "Perovskite stability", doi: "", year: "2021", projects: ["光伏"], hasNote: false },
  ];
  assert.equal(filterProfilePapers(papers, "").length, 2);
  assert.deepEqual(filterProfilePapers(papers, "single").map((p) => p.year), ["2020"]);
  assert.deepEqual(filterProfilePapers(papers, "10.1/ABC".toLowerCase()).map((p) => p.year), ["2020"]);
  assert.deepEqual(filterProfilePapers(papers, "光伏").map((p) => p.year), ["2021"]);
});
