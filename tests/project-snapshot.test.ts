import assert from "node:assert/strict";
import test from "node:test";
import { buildProjectSnapshot, type SnapshotInput } from "../src/project-snapshot.ts";

function makeBase(): SnapshotInput {
  return {
    now: "2026-11-24T05:00:00Z",
    mesaVersion: "0.2.3",
    platform: "macOS",
    project: {
      name: "硼化物析氢",
      path: "/p/boride",
      workMode: "research",
      topic: "硼化物析氢",
      settings: ["去向：投期刊（目标期刊：EER）"],
      hasPipeline: true,
      defaultAgent: "agy",
    },
    steps: [
      {
        index: 4,
        name: "润色与定稿",
        brief: "完成终稿润色与核验",
        expectedArtifacts: ["output/review-final.pdf"],
        acceptanceCriteria: [],
        state: "已保存进项目",
        worktreePath: "/w/polish",
        failure: null,
        checks: [],
        reviewNotes: null,
        humanTasks: { done: 4, total: 5, pending: ["换原图与申请转载许可"], optionalPending: ["同步到 EndNote"] },
        pendingNextActions: ["办理 47 块子图转载许可"],
      },
    ],
    goals: [{ name: "组会汇报", status: "已完成", outputPaths: ["output/group-meeting/2026-11-24/slides.html"] }],
    runs: [],
    focus: null,
    failedRunEvents: [],
    helpItems: [],
    pendingMail: [],
    mesaErrors: [],
    appLog: [],
    deps: [],
    agents: [],
    decided: ["术语统一写 boride"],
    closeout: {
      finalFiles: ["定稿 PDF（output/review-final.pdf）", "EndNote 域稿（output/endnote.docx）"],
      targetJournal: "Electrochemical Energy Reviews",
      pendingChecks: ["转载许可清单（submission/figure-permissions.md）"],
    },
    schedules: [
      { name: "每周前沿雷达", enabled: true, trigger: "每周一 09:00", skill: "lit-watch", status: "上次 2026-11-23 09:00 · ok" },
    ],
    consults: [
      { title: "是否需要补做 DFT", updatedAt: "2026-11-23T12:00:00Z", summary: "问题「补不补 DFT」→ Claude：可先用已有文献数据" },
    ],
    recentChats: [{ where: "项目根对话", text: "刚才确认了图 3 配色改成蓝灰体系。" }],
  };
}

test("项目快照纳入人工事项、后续建议、完结产物、目标交付路径、定时任务、研讨与项目内其他对话", () => {
  const snap = buildProjectSnapshot(makeBase(), 14_000);
  assert.match(snap, /人工事项：已完成 4\/5；待做：换原图与申请转载许可；可选未勾：同步到 EndNote/);
  assert.match(snap, /未处理后续建议：办理 47 块子图转载许可/);
  assert.match(snap, /## 完结产物与投稿收尾/);
  assert.match(snap, /目标期刊：Electrochemical Energy Reviews/);
  assert.match(snap, /定稿 PDF（output\/review-final\.pdf）/);
  assert.match(snap, /组会汇报：已完成（交付：output\/group-meeting\/2026-11-24\/slides\.html）/);
  assert.match(snap, /## 定时任务与事件规则/);
  assert.match(snap, /每周前沿雷达（已启用 · 每周一 09:00 · 技能 lit-watch）/);
  assert.match(snap, /## 最近的多模型研讨/);
  assert.match(snap, /是否需要补做 DFT/);
  assert.match(snap, /## 项目内其他对话最近内容/);
  assert.match(snap, /图 3 配色改成蓝灰体系/);
});
