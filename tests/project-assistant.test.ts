import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantErrorText,
  basisGuideHeadings,
  basisText,
  buildAssistantPrompt,
  classifyQuestion,
  guideAnchor,
  historyBlock,
  parseAssistantAnswer,
} from "../src/project-assistant.ts";
import { buildProjectSnapshot, type SnapshotInput } from "../src/project-snapshot.ts";

test("动作标记：只认白名单，按钮文字由前端生成，最多三个", () => {
  const { text, actions } = parseAssistantAnswer(
    "第 2 步启动失败，是环境的问题。\n\n[[看这一步:2]] [[设置]] [[去评审:9]] [[删库|x]] [[留话:2|先停一下]] [[报告|启动失败]]",
    3,
  );
  assert.equal(text, "第 2 步启动失败，是环境的问题。");
  assert.deepEqual(
    actions.map((a) => [a.kind, a.step, a.label]),
    [
      ["step", 2, "看第 2 步"],
      ["settings", null, "去设置"],
      ["mail", 2, "给第 2 步留话"],
    ],
    "越界的步骤、不认识的种类丢掉，超过三个不要",
  );
  assert.equal(actions[2].text, "先停一下");
});

test("动作标记：缺内容的不要，同一种只留一个，全角冒号也认", () => {
  const { actions } = parseAssistantAnswer("[[留话:1]] [[商量|方法段怎么写]] [[商量|另一个]] [[看这一步：1]]", 2);
  assert.deepEqual(actions.map((a) => a.kind), ["discuss", "step"]);
});

test("提示词按分流带材料：问项目带快照，问怎么用带说明书与概况，打招呼什么都不带", () => {
  const history = [{ question: "到哪了", answer: "第 2 步" }];
  const project = buildAssistantPrompt({ intent: "project", snapshot: "# 项目快照", history, question: "哪里出错了" });
  assert.match(project, /先分清是谁的问题/);
  assert.match(project, /# 项目快照/);
  assert.match(project, /用户：到哪了\n你：第 2 步/);
  assert.match(project, /## 这次的问题\n哪里出错了$/);
  assert.doesNotMatch(project, /## 说明书摘录/);

  const howto = buildAssistantPrompt({
    intent: "howto",
    guide: [{ heading: "8.1 聊天 / 终端", text: "**换 Agent、模型和思考强度**：……" }],
    context: "项目：综述",
    history,
    question: "如何换模型",
  });
  assert.match(howto, /Mesa 怎么用/);
  assert.match(howto, /### 8\.1 聊天 \/ 终端/);
  assert.match(howto, /## 项目概况\n项目：综述/);
  assert.doesNotMatch(howto, /项目快照/);
  assert.match(buildAssistantPrompt({ intent: "howto", guide: [], history: [], question: "x" }), /说明书里没翻到/);

  const chat = buildAssistantPrompt({ intent: "chat", history, question: "谢谢" });
  assert.match(chat, /打个招呼/);
  assert.doesNotMatch(chat, /项目快照|## 说明书摘录/);

  const many = Array.from({ length: 10 }, (_, i) => ({ question: `q${i}`, answer: "a" }));
  assert.ok(!historyBlock(many).includes("q3") && historyBlock(many).includes("q4"));
});

test("问题分流：怎么用 / 问项目 / 两样都沾 / 打招呼", () => {
  assert.equal(classifyQuestion("如何跟换模型"), "howto");
  assert.equal(classifyQuestion("在哪设置快捷键？"), "howto");
  assert.equal(classifyQuestion("MCP 是什么意思"), "howto");
  assert.equal(classifyQuestion("现在到哪了？"), "project");
  assert.equal(classifyQuestion("哪里出问题了？"), "project");
  assert.equal(classifyQuestion("我下一步该做什么？"), "project");
  assert.equal(classifyQuestion("第 3 步为什么一直保存不进项目？"), "project");
  assert.equal(classifyQuestion("第3步出错了怎么办"), "mixed");
  assert.equal(classifyQuestion("你好"), "chat");
  assert.equal(classifyQuestion("谢谢！"), "chat");
  assert.equal(classifyQuestion("综述写得怎么样"), "howto");
  assert.equal(classifyQuestion("帮我看看"), "general");
  assert.equal(classifyQuestion("现在几点"), "general", "判不出的不去看项目记录、翻说明书");
  assert.equal(classifyQuestion("你好", true), "project", "带着某次运行进来的一律问项目");
});

test("依据一行：说明书哪几节 + 项目记录；小节能拆出来做链接", () => {
  const b = basisText("mixed", ["8.1 聊天 / 终端", "8.1 聊天 / 终端", "9.7 思考档位"]);
  assert.equal(b, "说明书「8.1 聊天 / 终端」「9.7 思考档位」 · 这个项目的记录");
  assert.deepEqual(basisGuideHeadings(b), ["8.1 聊天 / 终端", "9.7 思考档位"]);
  assert.equal(basisText("howto", []), "说明书里没翻到相关段落");
  assert.equal(basisText("chat", []), "");
  assert.equal(guideAnchor("8.1 聊天 / 终端"), "81-聊天--终端");
  assert.equal(guideAnchor("9.2 加一条连接（中转 / API 密钥）"), "92-加一条连接中转--api-密钥");
});

test("没问成：超时、找不到 Agent 译成白话，其余照原文", () => {
  assert.match(assistantErrorText("AI 调用超时（120s）。"), /两分钟还没答完/);
  assert.match(assistantErrorText("未找到 claude（PATH 与常见安装目录均无）"), /找不到/);
  assert.equal(assistantErrorText("Error: something odd"), "something odd");
});

function input(over: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    now: "2026-11-04T10:00:00+08:00",
    mesaVersion: "0.2.0",
    platform: "macOS",
    project: {
      name: "综述",
      path: "/p/review",
      workMode: "research",
      topic: "固态电池",
      settings: [],
      hasPipeline: true,
      defaultAgent: "codex",
    },
    steps: [
      {
        index: 0,
        name: "文献检索",
        brief: "检索文献",
        expectedArtifacts: ["papers/included.md"],
        acceptanceCriteria: [],
        state: "出错了",
        worktreePath: "/w/s1",
        failure: "PTY 启动失败",
        checks: [{ id: "c1", kind: "cite", status: "blocked", title: "引用缺 DOI" }],
        reviewNotes: "图 2 标注不清",
      },
    ],
    goals: [],
    runs: [
      {
        id: "r1",
        isolationPath: "/w/s1",
        internal: false,
        createdAt: "2026-11-04T09:00:00Z",
        closedAt: null,
        status: "failed",
        exitCode: null,
        closeReason: "应用上次异常退出，Run 未能正常收尾",
        agent: "codex",
        taskKind: "step",
        where: "第 1 步",
      },
    ],
    focus: null,
    failedRunEvents: [],
    helpItems: [],
    pendingMail: [],
    mesaErrors: [
      { at: "2026-11-04T09:30:00+08:00", firstAt: "", count: 2, source: "invoke", command: "save_step", message: "nothing added", version: "0.2.0" },
    ],
    appLog: [],
    deps: [{ name: "Git", status: "ok", version: "2.4" }],
    agents: [{ id: "codex", installed: true, version: "0.166" }],
    decided: [],
    ...over,
  };
}

test("快照写清每步状态、出错原因、核验、退回意见与 Mesa 出错", () => {
  const text = buildProjectSnapshot(input());
  assert.match(text, /### 第 1 步「文献检索」：出错了\n最近一次运行出错：PTY 启动失败/);
  assert.match(text, /\[拦下\] 引用缺 DOI/);
  assert.match(text, /评审退回意见：\n图 2 标注不清/);
  assert.match(text, /Mesa 上次异常退出.*Mesa 的问题，不是这一步的/);
  assert.match(text, /save_step 失败（10 分钟内 2 次）/);
  assert.match(text, /- Git：已就绪 2\.4/);
});

test("快照超长时先砍事件和日志，最后硬截", () => {
  const big = input({
    failedRunEvents: [{ where: "第 1 步", events: Array.from({ length: 50 }, () => "x".repeat(200)) }],
    appLog: Array.from({ length: 20 }, () => ({ ts: "t", level: "error", source: "s", message: "y".repeat(200) })),
  });
  const full = buildProjectSnapshot(big, 100000);
  assert.match(full, /出错那次的最后几条事件/);
  const cut = buildProjectSnapshot(big, 3000);
  assert.ok(cut.length <= 3000 + 10);
  assert.ok(!cut.includes("出错那次的最后几条事件"));
  assert.match(cut, /第 1 步「文献检索」/);
});

test("只读查看项目文件：只在问出错原因、或带着某次运行进来时", async () => {
  const { wantsInspect, basisText, inspectRules, buildAssistantPrompt } = await import("../src/project-assistant.ts");
  assert.equal(wantsInspect("第 2 步为什么出错", "project"), true);
  assert.equal(wantsInspect("第3步出错了怎么办", "mixed"), true);
  assert.equal(wantsInspect("现在到哪了？", "project"), false);
  assert.equal(wantsInspect("我下一步该做什么？", "project"), false);
  assert.equal(wantsInspect("现在到哪了？", "project", true), true, "带着某次运行进来的要查");
  assert.equal(wantsInspect("为什么换模型没生效", "howto"), false, "问怎么用不进项目文件");
  assert.equal(basisText("project", [], true), "这个项目的记录与文件（只读查看）");
  const rules = inspectRules("/p/x", ["/w/s1"]);
  assert.match(rules, /只读/);
  assert.match(rules, /- \/w\/s1/);
  assert.match(rules, /不读 \.env/);
  const prompt = buildAssistantPrompt({ intent: "project", snapshot: "# 快照", inspect: rules, history: [], question: "为什么出错" });
  assert.match(prompt, /## 这次可以只读查看项目文件/);
});

test("派活单：从回答里取出来，去处只认第 N 步 / 新目标，没写要做什么的不要", async () => {
  const { parseWorkOrder, workOrderMessage, workOrderGoalText, buildAssistantPrompt } = await import("../src/project-assistant.ts");
  const answer = [
    "是课题的问题：清洗脚本取了不存在的列。",
    "",
    ":::派活",
    "交给：第 2 步",
    "标题：修正清洗脚本列名",
    "要做：scripts/clean.py 第 3 行把 sample_id 改成 id，",
    "  并重跑清洗。",
    "怎样算做完：output/clean.csv 生成、行数与原始一致",
    ":::",
  ].join("\n");
  const { text, order } = parseWorkOrder(answer, 3);
  assert.equal(text, "是课题的问题：清洗脚本取了不存在的列。");
  assert.equal(order?.target, "step");
  assert.equal(order?.step, 2);
  assert.equal(order?.title, "修正清洗脚本列名");
  assert.match(order?.task ?? "", /sample_id 改成 id，\n\s*并重跑清洗。/);
  assert.match(order?.done ?? "", /行数与原始一致/);
  assert.match(workOrderMessage(order!), /^【项目助手起草、我在 Mesa 工作台批准的一件活】\n要做：/);
  assert.match(workOrderGoalText(order!), /怎样算做完：/);

  const goal = parseWorkOrder(":::派活\n交给：新目标\n要做：补一份数据说明\n:::", 0);
  assert.equal(goal.order?.target, "goal");
  assert.equal(goal.order?.title, "补一份数据说明");
  assert.equal(parseWorkOrder(":::派活\n交给：第 9 步\n要做：x\n:::", 3).order, null, "越界的步骤不要");
  assert.equal(parseWorkOrder(":::派活\n交给：第 1 步\n标题：空的\n:::", 3).order, null, "没写要做什么不要");
  assert.equal(parseWorkOrder(":::派活\n交给：隔壁\n要做：x\n:::", 3).order, null, "不认识的去处不要");
  assert.equal(parseWorkOrder("没有派活单", 3).order, null);

  assert.match(buildAssistantPrompt({ intent: "project", snapshot: "s", history: [], question: "q" }), /:::派活/);
  assert.doesNotMatch(buildAssistantPrompt({ intent: "howto", history: [], question: "q" }), /:::派活/);
});

test("提速：寒暄本地回、按类型压低思考档", async () => {
  const { localReply, intentEffort } = await import("../src/project-assistant.ts");
  assert.match(localReply("你好", 15) ?? "", /^你好！/);
  assert.match(localReply("你好呀", 8) ?? "", /^早！/);
  assert.match(localReply("hi", 23) ?? "", /这么晚/);
  assert.equal(localReply("谢谢！", 10), "不客气，有事再叫我。");
  assert.equal(localReply("你好，第 3 步为什么出错", 10), null, "带了正事的交给 AI");
  assert.equal(localReply("现在几点", 10), null);
  assert.equal(intentEffort("chat"), "low");
  assert.equal(intentEffort("howto"), "low");
  assert.equal(intentEffort("general"), "low");
  assert.equal(intentEffort("project"), null);
  assert.equal(intentEffort("mixed"), null);
});
