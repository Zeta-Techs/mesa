import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantErrorText,
  basisGuideHeadings,
  basisText,
  buildAssistantPrompt,
  classifyQuestion,
  guideAnchor,
  isReviewAsk,
  mentionedStep,
  wantsInspect as wantsInspectFn,
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
  assert.equal(classifyQuestion("综述写得怎么样"), "project", "问写得怎么样是要看这个项目的产物，不是问怎么用（2026-11-11）");
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
  assert.match(text, /\[拦下·核验脚本\] 引用缺 DOI/);
  assert.match(text, /评审退回意见：\n图 2 标注不清/);
  assert.match(text, /Mesa 上次异常退出.*Mesa 的问题，不是这一步的/);
  assert.match(text, /save_step 失败（10 分钟内 2 次）/);
  assert.match(text, /- Git：已就绪 2\.4/);
});

test("快照带研究档案、单独成段；关掉（空串）时不出现", () => {
  const text = buildProjectSnapshot(input({ profile: "研究者档案（跨项目…）：\n- 写作偏好：少用被动句" }));
  assert.match(text, /## 研究档案（[^\n]*不是本项目的事实）\n研究者档案/);
  assert.doesNotMatch(buildProjectSnapshot(input({ profile: "" })), /## 研究档案/);
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

test("换个查法：按依据给另一种，两样都看过 / 本地现答的不给", async () => {
  const { retryIntents } = await import("../src/project-assistant.ts");
  assert.deepEqual(retryIntents("说明书「9.7 思考档位」", "x").map((r) => r.intent), ["project"]);
  assert.deepEqual(retryIntents("这个项目的记录", "x").map((r) => r.intent), ["howto"]);
  assert.deepEqual(retryIntents("", "x").map((r) => r.intent), ["project", "howto"]);
  assert.deepEqual(retryIntents("说明书「x」 · 这个项目的记录", "x"), []);
  assert.deepEqual(retryIntents("", "本地直接回答（没调 AI）"), []);
});

test("提问时附上用户正在看哪一页；没有就不写这一段", async () => {
  const { buildAssistantPrompt } = await import("../src/project-assistant.ts");
  const withWhere = buildAssistantPrompt({ intent: "mixed", history: [], question: "这个提示什么意思", where: "项目页 · 「HER」 · 「定时任务」页签" });
  assert.match(withWhere, /## 用户提问时正在看\n项目页 · 「HER」 · 「定时任务」页签/);
  assert.doesNotMatch(buildAssistantPrompt({ intent: "mixed", history: [], question: "q" }), /正在看/);
});

// ===== 接活（2026-11-05，docs/design-assistant-intake.md）=====

test("接活分流：交代要做的事归 request；问出错原因仍是查错；上一轮问过一句、起草过单子时接着走", async () => {
  const { classifyQuestion, previousTurnHint, wantsInspect } = await import("../src/project-assistant.ts");
  for (const q of ["帮我把这周的实验记录整理成组会汇报", "整理一下 lab 里的记录", "下周要准备组会", "我需要一份下一轮实验的方案", "画一张剂量响应曲线"]) {
    assert.equal(classifyQuestion(q), "request", q);
  }
  assert.equal(classifyQuestion("帮我看看第 3 步为什么失败"), "project", "带「为什么」「失败」的是查错");
  assert.equal(classifyQuestion("怎么换模型"), "howto");
  const asked = previousTurnHint("先问一句。\n\n:::问\n问题：讲多长时间？\n选项：10 分钟｜20 分钟\n:::");
  assert.deepEqual(asked, { asked: true, drafted: false });
  assert.equal(classifyQuestion("20 分钟", false, asked), "request", "回答上一轮的问题");
  assert.equal(classifyQuestion("好的", false, asked), "chat", "寒暄照旧");
  const drafted = previousTurnHint("单子起好了。\n:::派活\n交给：新目标\n要做：x\n:::");
  assert.equal(classifyQuestion("交付改成 pptx", false, drafted), "request", "接着改单子");
  assert.equal(classifyQuestion("交付改成 pptx", false, previousTurnHint("单子\n:::派活\n交给：新目标\n要做：x\n:::", true)), "general", "派过的不再接着改");
  assert.equal(wantsInspect("帮我整理记录", "request"), true, "起草前只读查看");
});

test("派活单 v2：可省各栏、路径只收项目内相对路径、技能拆名", async () => {
  const { parseWorkOrder, parseOrderPaths } = await import("../src/project-assistant.ts");
  const answer = `准备好了。

:::派活
交给：新目标
标题：11 月第一周组会汇报
要做：把 11-01 到 11-05 的记录整理成 20 分钟组会
依据材料：
- lab/2026-11-01.md（周一）
- \`data/raw/batch3.csv\`
- /etc/passwd
- ../secret
交付物：output/group-meeting/2026-11-06/slides.html
怎样算做完：每页结论有出处
按任务：「组会汇报」
用到的技能：slides-deck、figure-forge
先定下的假设：只讲第三批
要停下来问的：无
:::`;
  const { text, order } = parseWorkOrder(answer, 0);
  assert.equal(text, "准备好了。");
  assert.deepEqual(order!.inputs, ["lab/2026-11-01.md", "data/raw/batch3.csv"], "绝对路径与 .. 去掉，括号说明与反引号去掉");
  assert.equal(order!.deliver, "output/group-meeting/2026-11-06/slides.html");
  assert.equal(order!.basedOn, "组会汇报");
  assert.deepEqual(order!.skills, ["slides-deck", "figure-forge"]);
  assert.equal(order!.assumptions, "只讲第三批");
  assert.equal(order!.mustAsk, undefined, "写「无」等于没写");
  assert.deepEqual(parseOrderPaths("a.csv、C:\\x\\y.csv、~/z、./b/c.md"), ["a.csv", "b/c.md"]);
  const old = parseWorkOrder(":::派活\n交给：第 1 步\n要做：改脚本\n怎样算做完：能跑\n:::", 2).order!;
  assert.equal(old.inputs, undefined, "旧四栏单子照旧解析");
});

test("派活单 v2：正文带依据、假设、做法与科研通则", async () => {
  const { workOrderGoalText, workOrderMessage, RESEARCH_ORDER_RULES } = await import("../src/project-assistant.ts");
  const order = {
    target: "goal" as const,
    step: null,
    title: "周报",
    task: "汇总本周进展",
    done: "数字可重算",
    inputs: ["lab/"],
    assumptions: "写给导师",
  };
  const goal = workOrderGoalText(order, { research: true, method: "按内置任务「进展周报」的做法：\n1. 只写有记录的事" });
  assert.match(goal, /依据材料（先从这些看起）：\n- lab\//);
  assert.match(goal, /先定下的假设（不对就先停下来问我）：写给导师/);
  assert.match(goal, /按内置任务「进展周报」的做法/);
  assert.ok(goal.includes(RESEARCH_ORDER_RULES), "科研项目带通则");
  assert.ok(!workOrderGoalText(order).includes("科研通则"), "非科研不带");
  assert.match(workOrderMessage({ ...order, target: "step", step: 1, basedOn: "我的周报" }), /按「我的周报」的做法来做/);
});

test("问清楚：一次一个问题，选项最多四个", async () => {
  const { parseClarify } = await import("../src/project-assistant.ts");
  const { text, ask } = parseClarify("要先问一句。\n\n:::问\n问题：讲多长时间？\n选项：10 分钟｜20 分钟|30 分钟｜45 分钟｜一小时\n:::");
  assert.equal(text, "要先问一句。");
  assert.deepEqual(ask, { question: "讲多长时间？", options: ["10 分钟", "20 分钟", "30 分钟", "45 分钟"] });
  assert.equal(parseClarify(":::问\n选项：a｜b\n:::").ask, null, "没写问题不要");
  assert.equal(parseClarify("没有问题").ask, null);
});

test("要做事的提示词：带接活规矩、项目地图与能力清单，多带两轮问答", async () => {
  const { buildAssistantPrompt } = await import("../src/project-assistant.ts");
  const history = Array.from({ length: 8 }, (_, i) => ({ question: `问${i}`, answer: `答${i}` }));
  const prompt = buildAssistantPrompt({
    intent: "request",
    snapshot: "## 项目快照",
    map: "共 2 个文件",
    catalog: "- 内置任务「组会汇报」",
    history,
    question: "帮我准备组会",
  });
  assert.match(prompt, /先判断这件事归哪种去向/);
  assert.match(prompt, /:::派活/);
  assert.match(prompt, /## 项目里有什么（项目地图/);
  assert.match(prompt, /## Mesa 能用的任务和技能（能力清单）\n- 内置任务「组会汇报」/);
  assert.ok(prompt.includes("问2") && !prompt.includes("问1"), "带最近 6 轮");
});

test("接活干跑实证：同一栏写好几行要累加；动作标记写成 ::: 块也认", async () => {
  const { parseWorkOrder, parseAssistantAnswer } = await import("../src/project-assistant.ts");
  const { order, text } = parseWorkOrder(
    "单子：\n:::派活\n交给：新目标\n要做：做汇报\n依据材料：data/a.csv\n依据材料：lab/b.md\n:::\n\n:::商量|1 µM 那两孔保留还是剔除\n:::",
    0,
  );
  assert.deepEqual(order!.inputs, ["data/a.csv", "lab/b.md"]);
  const parsed = parseAssistantAnswer(text, 0);
  assert.deepEqual(parsed.actions.map((a) => [a.kind, a.text]), [["discuss", "1 µM 那两孔保留还是剔除"]]);
  assert.equal(parsed.text, "单子：", "块原文不露给人");
  assert.match(parseAssistantAnswer(":::不认识\n:::", 0).text, /不认识/, "不认识的块照原文留着");
});

test("接活二期：规矩里写按干活的连接说能做到哪一步", async () => {
  const { REQUEST_RULES } = await import("../src/project-assistant.ts");
  assert.match(REQUEST_RULES, /按能力清单里「干活的连接」说能做到哪一步/);
  assert.match(REQUEST_RULES, /不要假装能做/);
});

test("记忆：以后都要照办的偏好按问项目走，回答里 :::记下 一句交人确认", async () => {
  const { classifyQuestion, parseRemember, buildAssistantPrompt, REQUEST_RULES } = await import("../src/project-assistant.ts");
  assert.equal(classifyQuestion("以后组会都讲 15 分钟"), "project");
  assert.equal(classifyQuestion("导师要求报告都交 Word 版"), "project");
  assert.equal(classifyQuestion("以后怎么换模型"), "howto", "问怎么用的不算");
  const { text, remember } = parseRemember("好的，记住了。\n\n:::记下\n组会汇报一律按 15 分钟准备，\n约 8 页。\n:::");
  assert.equal(text, "好的，记住了。");
  assert.equal(remember, "组会汇报一律按 15 分钟准备， 约 8 页。");
  assert.equal(parseRemember(":::记下\n\n:::").remember, null);
  const prompt = buildAssistantPrompt({ intent: "project", snapshot: "快照", history: [], question: "以后组会都讲 15 分钟" });
  assert.match(prompt, /:::记下/);
  assert.match(REQUEST_RULES, /:::记下/);
});

test("三期：派活单「定时」一栏", async () => {
  const { parseWorkOrder, REQUEST_RULES } = await import("../src/project-assistant.ts");
  const { order } = parseWorkOrder(":::派活\n交给：新目标\n要做：出周报\n定时：每周五 17:00\n:::", 0);
  assert.equal(order!.schedule, "每周五 17:00");
  assert.match(REQUEST_RULES, /建成定时任务（先不启用）/);
});

test("项目助手不能说自己做了动作（2026-11-06 实证：回「让他接着做」被说成已经派出去了）", async () => {
  const { PROJECT_RULES, REQUEST_RULES, GENERAL_RULES } = await import("../src/project-assistant.ts");
  for (const rules of [PROJECT_RULES, REQUEST_RULES, GENERAL_RULES]) assert.match(rules, /绝不能说「已经派出去了/);
});

test("话与事实分开：声称自己做了动作的句子换成如实说明，如实的话不动", async () => {
  const { guardClaims, CLAIM_NOTE } = await import("../src/project-assistant.ts");
  const a = guardClaims("好，就当你点了派出去——这个活已经派出去了，你先忙别的。\n\n材料都核对过。我会让它写完先出一份草稿。我已经帮你开工了。");
  assert.equal(a.flagged, true);
  assert.equal(a.text, `${CLAIM_NOTE}\n\n材料都核对过。${CLAIM_NOTE}`, "段落留着，连着两句只留一条说明");
  for (const ok of ["你上午派出去的周报停了，点「接着做」就能接着写。", "第 2 步的 AI 已经开工了，正在读文献。", "我去看了记录。"]) {
    assert.equal(guardClaims(ok).flagged, false, ok);
  }
});

test("补料单：退回到哪步、补什么、为什么都要有；退回目标要在「从」之前；正文去掉这一块", async () => {
  const { parseReworkOrder, buildAssistantPrompt } = await import("../src/project-assistant.ts");
  const answer = [
    "大纲第 3 节文献不够，建议回检索补一轮。",
    ":::补料",
    "退回到：第 1 步",
    "从：第 3 步",
    "要补：",
    "- §3.2 失活机理：近三年原位表征工作",
    "- §3.4 动力学",
    "为什么：这两节能写进正文的都不到 3 篇",
    "线索：顺着 [@Wang2023] 的参考文献找",
    "规模：约 10 篇",
    ":::",
  ].join("\n");
  const { text, rework } = parseReworkOrder(answer, 5);
  assert.equal(text, "大纲第 3 节文献不够，建议回检索补一轮。");
  assert.deepEqual(rework, {
    toStep: 1,
    fromStep: 3,
    topics: ["§3.2 失活机理：近三年原位表征工作", "§3.4 动力学"],
    reason: "这两节能写进正文的都不到 3 篇",
    clues: "顺着 [@Wang2023] 的参考文献找",
    scale: 10,
  });
  // 越界、退回目标不在「从」之前、缺为什么：不要这张单子（正文照样去掉这一块）
  const bad = (body: string) => parseReworkOrder(`说明\n:::补料\n${body}\n:::`, 5);
  assert.equal(bad("退回到：第 6 步\n要补：x\n为什么：y").rework, null);
  assert.equal(bad("退回到：第 3 步\n从：第 2 步\n要补：x\n为什么：y").rework, null);
  assert.equal(bad("退回到：第 1 步\n要补：x").rework, null);
  assert.equal(bad("退回到：第 1 步\n要补：x").text, "说明");
  // 没写「从」也行；规模可省
  assert.deepEqual(bad("退回到：第 2 步\n要补：改 §2 顺序\n为什么：读者看不懂").rework, {
    toStep: 2, fromStep: null, topics: ["改 §2 顺序"], reason: "读者看不懂", clues: "", scale: null,
  });
  // 规矩写进项目类与要做事两种提问
  for (const intent of ["project", "request"] as const) {
    assert.match(buildAssistantPrompt({ intent, snapshot: "", history: [], question: "x" }), /:::补料/);
  }
});

test("起草项目知识时一次可记多条：最多五块，去重，飞书卡片仍只用第一块", async () => {
  const { parseRemember } = await import("../src/project-assistant.ts");
  const blocks = ["引用一律 [@键]", "图上画原始数据点", "引用一律 [@键]", "不用方法 X", "术语 HER 首次写全称", "温度单位用 °C", "多出来的"]
    .map((t) => `依据：README.md\n:::记下\n${t}\n:::`)
    .join("\n\n");
  const r = parseRemember(`从 README 里找到这些：\n\n${blocks}`);
  assert.deepEqual(r.remembers, ["引用一律 [@键]", "图上画原始数据点", "不用方法 X", "术语 HER 首次写全称", "温度单位用 °C"]);
  assert.equal(r.remember, "引用一律 [@键]");
  assert.ok(!r.text.includes(":::"));
});

test("更早的相关问答：按词重合翻出，至少两个词、最多两轮，最近几轮不重复，闲聊不翻", async () => {
  const { recallOlderTurns, buildAssistantPrompt } = await import("../src/project-assistant.ts");
  const turn = (q: string, a: string, at = "2026-11-01T00:00:00Z") => ({ question: q, answer: a, at });
  const history = [
    turn("组会汇报讲多长时间合适？", "导师要求组会汇报控制在 15 分钟。"),
    turn("references.bib 里重复的条目怎么办？", "用 bib-check 查。"),
    turn("天气", "不知道"),
    ...Array.from({ length: 4 }, (_, i) => turn(`最近第 ${i} 问`, "答")),
  ];
  const got = recallOlderTurns(history, 4, "下周组会汇报准备几页？");
  assert.deepEqual(got.map((t) => t.question), ["组会汇报讲多长时间合适？"]);
  assert.deepEqual(recallOlderTurns(history, 4, "references.bib 又报重复了"), [history[1]]);
  assert.deepEqual(recallOlderTurns(history, 10, "组会汇报"), [], "都在最近几轮里时不重复带");
  const prompt = buildAssistantPrompt({ intent: "project", snapshot: "快照", history, question: "下周组会汇报准备几页？" });
  assert.match(prompt, /更早的相关问答[\s\S]*15 分钟/);
  assert.doesNotMatch(buildAssistantPrompt({ intent: "chat", history, question: "组会汇报" }), /更早的相关问答/);
});

test("问一轮怎么样（2026-11-11 大纲核对）：按问项目走、只读查看；说了要改的按要做事；问 Mesa 里怎么检查的两样都看", () => {
  assert.equal(classifyQuestion("大纲这轮怎么样"), "project");
  assert.equal(classifyQuestion("帮我看看有没有问题"), "project", "原来被「帮我」当成要做事");
  assert.equal(classifyQuestion("第 3 步合不合格"), "project");
  assert.equal(classifyQuestion("核对一下大纲"), "project");
  assert.equal(classifyQuestion("检查一下引用并改掉"), "request");
  assert.equal(classifyQuestion("怎么核对引用"), "mixed");
  assert.equal(classifyQuestion("帮我看看"), "general", "什么都没说的仍判不出");
  assert.equal(wantsInspectFn("大纲这轮怎么样", "project"), true);
  assert.equal(wantsInspectFn("帮我看看有没有问题", "project"), true);
  assert.equal(isReviewAsk("帮我看看"), true, "在评审页只说一句也算，看评审页开着的那一步");
  assert.equal(isReviewAsk("检查一下引用并改掉"), false);
  assert.equal(isReviewAsk("现在到哪了"), false);
});

test("问的是哪一步：第 N 步、步骤名、按类型的叫法（同类取最后一步）", () => {
  const steps = [
    { name: "文献检索与筛选", kind: "search" },
    { name: "文献精读与笔记", kind: "notes" },
    { name: "综述大纲", kind: "outline" },
    { name: "综述初稿", kind: "writing" },
  ];
  assert.equal(mentionedStep("第 2 步怎么样", steps), 2);
  assert.equal(mentionedStep("第三步合不合格", steps), 3);
  assert.equal(mentionedStep("第 9 步", steps), null);
  assert.equal(mentionedStep("综述初稿有没有问题", steps), 4);
  assert.equal(mentionedStep("大纲这轮怎么样", steps), 3);
  assert.equal(mentionedStep("笔记帮我看看", steps), 2);
  assert.equal(mentionedStep("这轮怎么样", steps), null);
});

test("快照里 Mesa 核对的项带位置和说明，拦下的排前面", () => {
  const text = buildProjectSnapshot(
    input({
      steps: [
        {
          index: 0,
          name: "综述大纲",
          state: "做完了等你评审、保存进项目",
          brief: "",
          expectedArtifacts: ["outline.md"],
          acceptanceCriteria: [],
          worktreePath: "/w/outline",
          failure: null,
          reviewNotes: null,
          checks: [
            { id: "a", kind: "outline-figure", status: "needs_human", title: "同一块子图用了两次", target: { file: "outline.md", line: 83 }, checker: "mesa", evidence: { detail: "第 45 行与第 83 行" } },
            { id: "b", kind: "outline-cite", status: "blocked", title: "引了已排除的文献 @Zed2023", target: { file: "outline.md", line: 4 }, checker: "mesa" },
            { id: "c", kind: "cite", status: "needs_human", title: "AI 说这句撑不住", target: { file: "outline.md", line: 9 }, checker: "agent" },
          ],
        },
      ],
    }),
  );
  const block = text.slice(text.indexOf("核验："));
  assert.ok(block.indexOf("@Zed2023") < block.indexOf("子图"), "拦下的在前");
  assert.match(block, /- \[拦下·Mesa 核对\] 引了已排除的文献 @Zed2023（outline\.md:4）/);
  assert.match(block, /\[待你判断·Mesa 核对\] 同一块子图用了两次（outline\.md:83）：第 45 行与第 83 行/);
  assert.match(block, /\[待你判断·AI 判断\] AI 说这句撑不住（outline\.md）/);
});
