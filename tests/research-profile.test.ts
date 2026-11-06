import assert from "node:assert/strict";
import test from "node:test";
import { activeProfileGroups, filterProfilePapers, profileStatus, suggestionReason, type ResearchProfileDto } from "../src/research-profile.ts";

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
    context: "",
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

test("建议记下的出处说明：跨项目写项目名，同一处写次数", () => {
  const base = { id: "x", text: "摘要不写 novel", category: "写作偏好" };
  assert.equal(
    suggestionReason({ ...base, count: 2, sources: [{ project: "甲", kind: "审查决定" }, { project: "乙", kind: "审查决定" }] }),
    "在「甲」「乙」2 个项目的审查决定里都出现过",
  );
  assert.equal(
    suggestionReason({ ...base, count: 3, sources: [{ project: "甲", kind: "逐条裁决依据" }] }),
    "在「甲」的逐条裁决依据里出现了 3 次",
  );
});

test("研究档案状态：没有有效条目算空，有条目看开关", () => {
  const make = (inject: boolean, states: string[]): ResearchProfileDto => ({
    doc: { revision: "x", legacyText: "", entries: states.map((st, i) => entry(String(i), "其他", st)) },
    settings: { inject },
    categories: ["其他"],
    context: "",
  });
  assert.deepEqual(profileStatus(make(true, ["revoked"])), { tone: "empty", count: 0 });
  assert.deepEqual(profileStatus(make(true, ["active", "active"])), { tone: "on", count: 2 });
  assert.deepEqual(profileStatus(make(false, ["active"])), { tone: "off", count: 1 });
});
