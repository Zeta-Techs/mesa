import assert from "node:assert/strict";
import test from "node:test";
import { answerCard, deskCard, phoneText, projectPickCard } from "../src/im-cards.ts";

const project = { path: "/p/a", name: "药物毒性" };
const buttons = (card: any) => card.elements.filter((e: any) => e.tag === "action").flatMap((e: any) => e.actions);

test("手机正文：去掉动作标记和 ::: 块，太长截断", () => {
  assert.equal(phoneText("做完了。[[项目页]]\n\n:::派活\n交给：新目标\n要做：x\n:::"), "做完了。");
  assert.match(phoneText("字".repeat(3100)), /太长了/);
});

test("回答卡片：追问选项、派活单、记下各成按钮，按钮回传值带项目与那一轮", () => {
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
});

test("等你的事卡片：人工请求给选项按钮，等确认只提示回电脑；没有事时说没有", () => {
  const card: any = deskCard([
    {
      project,
      items: [
        { key: "help:/w:h1", kind: "help", step: 2, where: "第 2 步「分析」", question: "保留还是剔除？", options: [{ key: "A", label: "保留", effect: null }], recommend: "A", detail: [] },
        { key: "confirm:t1", kind: "confirm", step: null, where: "对话「x」", question: "AI 停下来等你确认一条命令", options: [], recommend: null, detail: [] },
      ],
    },
  ]);
  assert.equal(card.header.title.content, "等你的事 2 件");
  assert.deepEqual(buttons(card)[0].value, { op: "desk", p: "/p/a", k: "help:/w:h1", v: "A：保留" });
  assert.match(buttons(card)[0].text.content, /（建议）/);
  assert.match(JSON.stringify(card), /确认命令要回到电脑上/);
  assert.match(JSON.stringify(deskCard([])), /现在没有等你回的事/);
  const pick: any = projectPickCard([project], "出周报");
  assert.deepEqual(buttons(pick)[0].value, { op: "project", p: "/p/a", q: "出周报" });
});

test("信任文件夹卡片：你派的活给两个按钮，别的只提示回电脑", () => {
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
});

test("派活进展卡片：停了的目标带「接着做」", async () => {
  const { echoCard } = await import("../src/im-cards.ts");
  const card: any = echoCard(project, "t0", "停下了", true);
  assert.deepEqual(buttons(card)[0].value, { op: "resume", p: "/p/a", t: "t0" });
  assert.equal(buttons(echoCard(project, "t0", "做完了", false)).length, 0);
});
