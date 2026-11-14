import { test } from "node:test";
import assert from "node:assert/strict";
import { briefLines, goalReviewPrereadFocus, hasKnowledgeSources, quickAsks, reviewPrereadFocus, reviewRoundFocus, reviewingStep, setReviewingStep, type BriefInput } from "../src/assistant-brief.ts";

const base: BriefInput = { hasFlow: true, steps: [], goals: [], since: null };

test("没有要看的事、也没有变化：不出卡", () => {
  assert.deepEqual(briefLines({ ...base, steps: [{ n: 1, name: "检索", state: "saved", mergedAt: "2026-11-01T00:00:00Z", needsHuman: 0 }] }), []);
});

test("出错、等确认、待评审、目标待验收都列出，并带跳转或追问", () => {
  const lines = briefLines({
    ...base,
    steps: [
      { n: 1, name: "检索", state: "failed", failure: "未找到命令（退出码 127）", needsHuman: 0 },
      { n: 2, name: "精读", state: "confirm", needsHuman: 0 },
      { n: 3, name: "大纲", state: "review", needsHuman: 2 },
    ],
    goals: [{ name: "组会汇报", status: "pending_review", updatedAt: "2026-11-08T00:00:00Z" }],
  });
  assert.equal(lines[0].text, "第 1 步「检索」出错了：未找到命令（退出码 127）");
  assert.equal(lines[0].ask?.question, "第 1 步「检索」为什么出错？我该怎么办？");
  assert.equal(lines[1].action?.kind, "step");
  assert.equal(lines[2].action?.kind, "review");
  // 同一步的「核验待判断」与「待评审」指向同一处评审，只留一行
  assert.equal(lines.filter((l) => l.action?.kind === "review" && l.action.step === 3).length, 1);
  assert.ok(lines.some((l) => l.text === "目标「组会汇报」做完了，等你验收"));
});

test("「上次打开以来」只列 since 之后保存 / 完成的；第一次打开不列变化", () => {
  const input: BriefInput = {
    ...base,
    since: "2026-11-05T00:00:00Z",
    steps: [
      { n: 1, name: "检索", state: "saved", mergedAt: "2026-11-06T00:00:00Z", needsHuman: 0 },
      { n: 2, name: "精读", state: "saved", mergedAt: "2026-11-01T00:00:00Z", needsHuman: 0 },
    ],
    goals: [{ name: "周报", status: "completed", updatedAt: "2026-11-07T00:00:00Z" }],
  };
  assert.deepEqual(briefLines(input).map((l) => l.text), ["第 1 步「检索」已保存进项目", "目标「周报」已验收完成"]);
  assert.deepEqual(briefLines({ ...input, since: null }), []);
});

test("常用问题按状态换：出错与待评审排前，评审那句带只读重点", () => {
  const asks = quickAsks({ ...base, steps: [{ n: 2, name: "精读", state: "failed", needsHuman: 0 }, { n: 3, name: "大纲", state: "review", needsHuman: 0 }] });
  assert.equal(asks.length, 3);
  assert.equal(asks[0].q, "第 2 步「精读」为什么出错？");
  assert.equal(asks[1].q, "第 3 步交的东西，我评审时该重点看哪几处？");
  assert.deepEqual(asks[1].focus, reviewPrereadFocus(3, "大纲"));
  assert.match(asks[1].focus!.detail, /不判断能不能通过/);
});

test("没流程没目标的新项目问「想做什么」，不问「到哪了」", () => {
  const asks = quickAsks({ ...base, hasFlow: false });
  assert.ok(!asks.some((a) => a.q === "现在到哪了？"));
  assert.ok(asks.some((a) => a.q === "我想做一件事，帮我理清怎么做"));
  assert.equal(quickAsks({ ...base, hasFlow: false, goals: [{ name: "x", status: "running", updatedAt: "" }] })[0].q, "目标都做到哪了？");
  assert.equal(quickAsks(base)[0].q, "现在到哪了？");
});

test("项目知识还是空的：卡上提议起草几条，按「项目」类问、带只读重点，不编", async () => {
  const { KNOWLEDGE_DRAFT_QUESTION } = await import("../src/assistant-brief.ts");
  const lines = briefLines({ ...base, knowledgeEmpty: true });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, "knowledge-draft");
  assert.equal(lines[0].ask?.question, KNOWLEDGE_DRAFT_QUESTION);
  assert.equal(lines[0].ask?.label, "起草几条");
  assert.equal(lines[0].ask?.intent, "project");
  assert.match(lines[0].ask!.focus.detail, /最多五块/);
  assert.match(lines[0].ask!.focus.detail, /不要编/);
  assert.deepEqual(briefLines({ ...base, knowledgeEmpty: false }), []);
});

test("聊够十轮才提议整理；派活进展不算；整理或「不用」以后重新数", async () => {
  const { summaryDue, summaryFocus } = await import("../src/assistant-brief.ts");
  const turns = Array.from({ length: 12 }, (_, i) => ({ at: `2026-11-08T00:${String(i).padStart(2, "0")}:00Z`, question: `问${i}`, answer: `答${i}\n:::记下\nx\n:::` }));
  assert.equal(summaryDue(turns.slice(0, 9), null), false);
  assert.equal(summaryDue([...turns.slice(0, 9), { at: "2026-11-08T01:00:00Z", echoOf: "x" }], null), false);
  assert.equal(summaryDue(turns, null), true);
  assert.equal(summaryDue(turns, turns[5].at), false, "上次整理之后只有 6 轮");
  const f = summaryFocus(turns, turns[1].at);
  assert.match(f.detail, /最近 10 轮/);
  assert.ok(!f.detail.includes(":::记下\nx"), "旧回答里的标记块不带进去");
});

test("hasKnowledgeSources：项目根有 README / CLAUDE / AGENTS / 写作规范一类才提议起草项目知识", () => {
  // HER 实测：只有文献与笔记，没有约定文件，不提议
  assert.equal(hasKnowledgeSources([".gitignore", "references.bib"]), false);
  assert.equal(hasKnowledgeSources([]), false);
  assert.equal(hasKnowledgeSources(["README.md"]), true);
  assert.equal(hasKnowledgeSources(["readme"]), true);
  assert.equal(hasKnowledgeSources(["CLAUDE.md"]), true);
  assert.equal(hasKnowledgeSources(["AGENTS.md"]), true);
  assert.equal(hasKnowledgeSources(["style-sheet.md"]), true);
  assert.equal(hasKnowledgeSources(["写作规范.docx"]), true);
  // 名字里带这些词但不是约定文件的不算
  assert.equal(hasKnowledgeSources(["readme-figures.png", "agents-notes.txt"]), false);
});

test("reviewPrereadFocus：给出工作副本与要看的交付物，脚本生成的清单 / RIS 点名不读", () => {
  const f = reviewPrereadFocus(1, "文献检索与筛选", {
    worktree: "/w/lit-search",
    artifacts: ["papers/screening.md", "papers/included.md", "papers/included.json", "papers/to-fetch.md", "papers/to-fetch.ris", "papers/endnote-import.ris"],
  });
  assert.match(f.detail, /工作副本（\/w\/lit-search）/);
  assert.match(f.detail, /只看 papers\/screening\.md、papers\/included\.json，/);
  assert.match(f.detail, /papers\/included\.md、papers\/to-fetch\.md、papers\/to-fetch\.ris、papers\/endnote-import\.ris 由脚本从清单生成，不读/);
  assert.match(f.detail, /最多打开 5 个文件/);
});

test("reviewRoundFocus：带上这一步的核验项（拦下在前、标来源），要它解释、给下一步、起草派活单和评审意见", () => {
  const f = reviewRoundFocus(
    3,
    "综述大纲",
    { worktree: "/w/outline", artifacts: ["outline.md", "manuscript/sections.json", "references.bib"] },
    [
      { id: "a", kind: "outline-coverage", status: "needs_human", title: "覆盖检查「3.1」篇数对不上", target: { file: "outline.md", line: 137 }, checker: "mesa", evidence: { detail: "Mesa 数 3 / 5" } },
      { id: "b", kind: "outline-cite", status: "blocked", title: "引了已排除的文献 @Zed2023", target: { file: "outline.md", line: 4 }, checker: "mesa" },
      { id: "c", kind: "x", status: "passed", title: "通过的不列" },
    ],
  );
  assert.equal(f.title, "这一轮怎么样：第 3 步「综述大纲」");
  assert.match(f.detail, /工作副本（\/w\/outline）里的主要产物（outline\.md、manuscript\/sections\.json）/);
  assert.ok(f.detail.indexOf("@Zed2023") < f.detail.indexOf("3.1"), "拦下的在前");
  assert.match(f.detail, /- \[拦下·Mesa 核对\] 引了已排除的文献 @Zed2023（outline\.md:4）/);
  assert.match(f.detail, /\[待你判断·Mesa 核对\] 覆盖检查「3\.1」篇数对不上（outline\.md:137）：Mesa 数 3 \/ 5/);
  assert.doesNotMatch(f.detail, /通过的不列/);
  assert.match(f.detail, /派活单/);
  assert.match(f.detail, /引用块/);
  assert.match(f.detail, /不替人选/);
  const none = reviewRoundFocus(2, "精读", { worktree: "/w/n" }, []);
  assert.match(none.detail, /没有拦下或待你判断的核验项/);
});

test("评审页开着的那一步：打开设、关掉清", () => {
  setReviewingStep({ projectRoot: "/p", n: 3, name: "综述大纲", worktree: "/w/outline", artifacts: ["outline.md"] });
  assert.equal(reviewingStep()?.n, 3);
  setReviewingStep(null);
  assert.equal(reviewingStep(), null);
});

test("待验收目标常用问题：带上隔离副本与只读预读重点，失败目标也带工作副本路径", () => {
  const asks = quickAsks({
    ...base,
    hasFlow: false,
    goals: [
      {
        name: "第三批数据汇总",
        status: "pending_review",
        updatedAt: "2026-11-10T00:00:00Z",
        isolationPath: "/iso/goal-1",
        outputPaths: ["output/summary.md", "references.bib"],
      },
    ],
  });
  assert.equal(asks[0].q, "目标「第三批数据汇总」做得怎么样，我验收时看哪？");
  assert.deepEqual(
    asks[0].focus,
    goalReviewPrereadFocus("第三批数据汇总", { isolationPath: "/iso/goal-1", outputs: ["output/summary.md", "references.bib"] }),
  );
  assert.match(asks[0].focus!.detail, /隔离副本（\/iso\/goal-1）/);
  assert.match(asks[0].focus!.detail, /优先看 output\/summary\.md，/);
  assert.match(asks[0].focus!.detail, /references\.bib 由脚本从清单生成，不读/);
  assert.match(asks[0].focus!.detail, /不判断能不能验收通过/);

  const lines = briefLines({
    ...base,
    hasFlow: false,
    goals: [{ name: "重算误差", status: "failed", updatedAt: "2026-11-10T00:00:00Z", isolationPath: "/iso/goal-2" }],
  });
  assert.match(lines[0].ask!.focus.detail, /\/iso\/goal-2/);
});

test("步骤待跟进与定时任务后台跟进不明都进「现在的情况」，且与目标待验收互不顶掉", () => {
  const lines = briefLines({
    ...base,
    steps: [
      { n: 2, name: "精读", state: "open", needsHuman: 0, pendingUpstream: true },
      { n: 3, name: "大纲", state: "review", needsHuman: 0, pendingUpstream: true },
    ],
    goals: [{ name: "图表核对", status: "pending_review", updatedAt: "2026-11-12T00:00:00Z" }],
    uncertainSchedules: [{ id: "sch-1", name: "每周前沿雷达" }],
  });
  const pendingStep = lines.find((l) => l.text === "第 2 步「精读」有前面步骤新保存的内容待跟进");
  assert.ok(pendingStep);
  assert.deepEqual(pendingStep.action, { kind: "step", step: 2, text: "", label: "看第 2 步" });
  assert.ok(!lines.some((l) => l.text === "第 3 步「大纲」有前面步骤新保存的内容待跟进"), "已在待评审的步骤不重复挂待跟进");

  const uncertain = lines.find((l) => l.text === "定时任务「每周前沿雷达」上次后台跟进结果不明已暂停，等你核对");
  assert.ok(uncertain);
  assert.deepEqual(uncertain.action, { kind: "project", step: null, text: "schedule", label: "去定时任务核对" });
  assert.ok(lines.some((l) => l.text === "目标「图表核对」做完了，等你验收"), "同为 project 动作但 text 不同，不会互相去重吃掉");
});
