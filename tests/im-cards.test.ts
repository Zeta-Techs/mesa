import assert from "node:assert/strict";
import test from "node:test";
import {
  answerCard,
  askErrorCard,
  deskCard,
  echoCard,
  milestoneCard,
  phoneText,
  projectListCard,
  projectPickCard,
  projectStatusCard,
  replyPickCard,
  selfTestDoneCard,
  thinkingCard,
} from "../src/im-cards.ts";

const project = { path: "/p/a", name: "药物毒性" };
const buttons = (card: any) => card.elements.filter((e: any) => e.tag === "action").flatMap((e: any) => e.actions);

test("手机正文：去掉动作标记和 ::: 块，太长截断", () => {
  assert.equal(phoneText("做完了。[[项目页]]\n\n:::派活\n交给：新目标\n要做：x\n:::"), "做完了。");
  assert.match(phoneText("字".repeat(3100)), /太长了/);
});

test("所有卡片均带 update_multi，便于 PATCH 原地更新状态", () => {
  const t: any = thinkingCard(project, "现在到哪了");
  assert.equal(t.config.update_multi, true);
  assert.match(JSON.stringify(t), /正在只读查看项目状态/);
  const err: any = askErrorCard(project, "现在到哪了", "连接超时");
  assert.equal(err.header.template, "red");
  assert.match(JSON.stringify(err), /连接超时/);
  assert.equal((selfTestDoneCard() as any).header.template, "green");
});

test("回答卡片：追问选项、派活单、记下各成按钮，点过后原地变成已完成状态且不影响其余按钮", () => {
  const card: any = answerCard({
    project,
    turnAt: "2026-11-06T10:00:00+08:00",
    text: "可以。",
    ask: { question: "讲多长时间？", options: ["10 分钟", "20 分钟"] },
    order: { target: "goal", step: null, title: "组会", task: "做组会", done: "有出处", schedule: "每周五" },
    remember: "组会都讲 15 分钟",
    desktopOnly: ["去项目页"],
  });
  assert.equal(card.header.title.content, "项目助手 · 药物毒性");
  const values = buttons(card).map((b: any) => b.value);
  assert.deepEqual(values.map((v: any) => v.op), ["clarify", "clarify", "dispatch", "remember"]);
  assert.deepEqual(values[1], { op: "clarify", p: "/p/a", t: "2026-11-06T10:00:00+08:00", v: "20 分钟" });
  const text = JSON.stringify(card);
  assert.match(text, /建成定时任务要在电脑上点/);
  assert.match(text, /在电脑上还可以：去项目页/);

  // 派活单点过后：派出去按钮变成 ✓ 备注，未点的 remember 仍可点
  const settled: any = answerCard({
    project,
    turnAt: "2026-11-06T10:00:00+08:00",
    text: "整理好了。",
    ask: null,
    order: { target: "step", step: 2, title: "补检索", task: "补近两年", done: "入库" },
    remembers: ["规矩一", "规矩二"],
    desktopOnly: [],
    settled: { dispatched: "已派给第 2 步", remembered: new Set([0]) },
  });
  assert.deepEqual(
    buttons(settled).map((b: any) => b.value),
    [{ op: "remember", p: "/p/a", t: "2026-11-06T10:00:00+08:00", v: "1" }],
  );
  assert.match(JSON.stringify(settled), /✓ 已派给第 2 步/);
  assert.match(JSON.stringify(settled), /✓ 已记进项目知识/);
});

test("等你的事卡片：超过 4 个选项全展示 + 支持自定义回答，非步骤对话不再出现『回第 ? 步』，已处理可顺手记进知识", () => {
  const sixOptions = ["A", "B", "C", "D", "E", "F"].map((k) => ({ key: k, label: `方案${k}`, effect: null }));
  const card: any = deskCard([
    {
      project,
      items: [
        {
          key: "help:/w:h1",
          kind: "help",
          step: 2,
          where: "第 2 步「分析」",
          question: "选哪个方案？",
          options: sixOptions,
          recommend: "A",
          detail: ["样本含离群值"],
          siblingPendingCount: 2,
        },
        {
          key: "question:r1:abc",
          kind: "question",
          step: null,
          where: "对话「组会目标」",
          question: "需要把附表也放进去吗？",
          options: [],
          recommend: null,
          detail: [],
        },
        {
          key: "confirm:t1",
          kind: "confirm",
          step: null,
          where: "对话「x」",
          question: "AI 停下来等你确认一条命令",
          options: [],
          recommend: null,
          detail: [],
        },
      ],
    },
  ]);
  assert.equal(card.header.title.content, "等你的事 3 件");
  const btns = buttons(card);
  assert.deepEqual(btns[0].value, { op: "desk", p: "/p/a", k: "help:/w:h1", v: "A：方案A" });
  assert.match(btns[0].text.content, /（建议）/);
  // 6 个选项 + 1 个自定义回答 + 1 个非步骤对话『写一句回它』= 8 个按钮
  assert.equal(btns.length, 8);
  const raw = JSON.stringify(card);
  assert.doesNotMatch(raw, /回第 \? 步/);
  assert.match(raw, /同处还有 2 题待答/);
  assert.match(raw, /确认命令要回到电脑上/);
  assert.match(JSON.stringify(deskCard([])), /现在没有等你回的事/);

  // 人工请求答完后原地置结果，并给出「同时记进项目知识」按钮
  const doneMap = new Map([["help:/w:h1", { status: "已答：A（方案A）", rememberLine: "选哪个方案？ → A（方案A）" }]]);
  const afterCard: any = deskCard(
    [{ project, items: [{ key: "help:/w:h1", kind: "help", step: 2, where: "第 2 步", question: "选哪个？", options: sixOptions, recommend: null, detail: [] }] }],
    doneMap,
  );
  assert.equal(afterCard.header.template, "green");
  assert.deepEqual(buttons(afterCard).map((b: any) => b.value.op), ["remember_help"]);

  const pick: any = projectPickCard([project], "出周报");
  assert.deepEqual(buttons(pick)[0].value, { op: "project", p: "/p/a", q: "出周报" });
});

test("信任文件夹与授权请求卡片", () => {
  const trustItem = (dispatched: boolean) => ({
    key: "trust:t1",
    kind: "trust" as const,
    step: null,
    where: "对话「周报」",
    question: "停在信任",
    options: [],
    recommend: null,
    detail: [],
    tabId: "t1",
    trust: { yes: "Yes", no: "No", path: null, dispatched },
  });
  const yes: any = deskCard([{ project, items: [trustItem(true)] }]);
  assert.deepEqual(buttons(yes).map((b: any) => b.value), [
    { op: "trust", p: "/p/a", k: "trust:t1", v: "yes" },
    { op: "trust", p: "/p/a", k: "trust:t1", v: "no" },
  ]);
  const no: any = deskCard([{ project, items: [trustItem(false)] }]);
  assert.equal(buttons(no).length, 0);
  assert.match(JSON.stringify(no), /信任文件夹要回到电脑上点/);

  const grantCard: any = deskCard([
    {
      project,
      items: [
        {
          key: "grant:s1:2026-11-08T10:00:00",
          kind: "grant" as const,
          step: null,
          where: "定时任务「文献雷达」",
          question: "上次运行被授权范围拦下，要放宽重跑这一次吗？",
          options: [],
          recommend: null,
          detail: ["example.com 想下一篇全文"],
          scheduleId: "s1",
        },
      ],
    },
  ]);
  assert.deepEqual(buttons(grantCard).map((b: any) => b.value), [
    { op: "grant", p: "/p/a", k: "grant:s1:2026-11-08T10:00:00", v: "once" },
    { op: "grant", p: "/p/a", k: "grant:s1:2026-11-08T10:00:00", v: "no" },
  ]);
});

test("项目切换卡、零 Token 状态卡、里程碑通知卡与多目标选择卡", () => {
  const listCard: any = projectListCard(
    [
      { path: "/p/a", name: "药物毒性", waiting: 2 },
      { path: "/p/b", name: "单细胞综述", waiting: 0 },
    ],
    "/p/a",
  );
  assert.equal(buttons(listCard).length, 2);
  assert.match(JSON.stringify(listCard), /当前默认/);
  assert.match(JSON.stringify(listCard), /2 件等你/);

  const status: any = projectStatusCard(
    project,
    {
      hasFlow: true,
      steps: [
        { n: 1, name: "检索", state: "saved", needsHuman: 0, pendingUpstream: true },
        { n: 2, name: "精读", state: "review", needsHuman: 1, pendingUpstream: true, staleUpstream: "检索" },
      ],
      goals: [{ name: "整理附表", status: "running", updatedAt: "2026-11-15T10:00:00Z" }],
      since: null,
    },
    1,
  );
  assert.deepEqual(buttons(status).map((b: any) => b.value.op), ["show_queue", "preread", "clarify"]);
  assert.match(JSON.stringify(status), /不消耗模型额度/);
  assert.match(JSON.stringify(status), /「检索」有更新待跟进/);
  assert.doesNotMatch(JSON.stringify(status), /第 1 步「检索」（[^）]*待跟进/);

  const mile: any = milestoneCard([
    {
      key: "/p/a|step-review:2:精读",
      kind: "review",
      projectPath: "/p/a",
      projectName: "药物毒性",
      where: "第 2 步「精读」",
      text: "第 2 步「精读」做完了，等你评审",
      detail: null,
      options: [],
      recommend: null,
      tap: null,
      open: { kind: "assistant", projectPath: "/p/a" },
    },
  ]);
  assert.equal(mile.header.template, "green");
  assert.deepEqual(buttons(mile)[0].value, { op: "preread", p: "/p/a", v: "2" });

  const pickReply: any = replyPickCard(
    [{ projectPath: "/p/a", projectName: "药物毒性", key: "question:r1:1", where: "对话「周报」", question: "放附表吗？" }],
    "放进去",
  );
  assert.deepEqual(buttons(pickReply)[0].value, { op: "reply_pick", p: "/p/a", k: "question:r1:1", q: "放进去" });

  const echo: any = echoCard(project, "t0", "停下了", true);
  assert.deepEqual(buttons(echo)[0].value, { op: "resume", p: "/p/a", t: "t0" });
  assert.equal(buttons(echoCard(project, "t0", "停下了", true, "已接回继续做")).length, 0);
});
