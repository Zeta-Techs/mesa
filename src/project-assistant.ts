/**
 * 项目助手的提示词与回答里的动作按钮（2026-11-04，docs/design-project-assistant.md §6）。纯逻辑，配 tests/project-assistant.test.ts。
 *
 * 项目助手只解释、只建议：要动手时在回答里写动作标记，前端只认白名单里的几种，渲染成按钮，**人点了才跳到原有入口**。
 * 按钮文字由前端按种类生成，AI 写不了任意按钮；带内容的（留话草稿、拆分需求、商量的问题、反馈标题）只是预填，发不发人定。
 */

export type AssistantActionKind =
  | "step"
  | "review"
  | "project"
  | "agents"
  | "profiles"
  | "settings"
  | "mail"
  | "split"
  | "discuss"
  | "report";

export interface AssistantAction {
  kind: AssistantActionKind;
  /** 第几步（从 1 数）；只有 step / review / mail 用 */
  step: number | null;
  /** 预填内容：留话草稿 / 拆分需求 / 商量的问题 / 反馈标题 */
  text: string;
  label: string;
}

/** 标记里写的中文词 → 种类 */
const KIND_WORDS: Record<string, AssistantActionKind> = {
  看这一步: "step",
  去评审: "review",
  项目页: "project",
  Agent分工: "agents",
  连接页: "profiles",
  设置: "settings",
  留话: "mail",
  拆分: "split",
  商量: "discuss",
  报告: "report",
};

const NEEDS_STEP = new Set<AssistantActionKind>(["step", "review", "mail"]);
const NEEDS_TEXT = new Set<AssistantActionKind>(["mail", "split", "discuss", "report"]);
export const MAX_ACTIONS = 3;

export function actionLabel(kind: AssistantActionKind, step: number | null): string {
  switch (kind) {
    case "step":
      return `看第 ${step} 步`;
    case "review":
      return `去评审第 ${step} 步`;
    case "project":
      return "去项目页";
    case "agents":
      return "去 Agent 分工";
    case "profiles":
      return "去连接页";
    case "settings":
      return "去设置";
    case "mail":
      return `给第 ${step} 步留话`;
    case "split":
      return "拆成几路做…";
    case "discuss":
      return "去跟 AI 商量";
    case "report":
      return "报告给开发者";
  }
}

const MARK = /\[\[([^\]\n]{1,600})\]\]/g;

/** 从回答里取出动作标记：正文去掉标记，按钮最多三个、同种同步只留一个；不认识或缺参数的标记直接丢掉 */
export function parseAssistantAnswer(answer: string, stepCount: number): { text: string; actions: AssistantAction[] } {
  const actions: AssistantAction[] = [];
  const seen = new Set<string>();
  const text = answer
    .replace(MARK, (_, body: string) => {
      const [head, ...rest] = body.split("|");
      const payload = rest.join("|").trim();
      const [word, arg] = head.split(/[:：]/).map((s) => s.trim());
      const kind = KIND_WORDS[word.replace(/\s+/g, "")];
      if (!kind) return "";
      let step: number | null = null;
      if (NEEDS_STEP.has(kind)) {
        const n = Number.parseInt(arg ?? "", 10);
        if (!Number.isInteger(n) || n < 1 || n > stepCount) return "";
        step = n;
      }
      if (NEEDS_TEXT.has(kind) && !payload) return "";
      const key = `${kind}:${step ?? ""}`;
      if (seen.has(key) || actions.length >= MAX_ACTIONS) return "";
      seen.add(key);
      actions.push({ kind, step, text: payload.slice(0, 2000), label: actionLabel(kind, step) });
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, actions };
}

export const ASSISTANT_RULES = `你是 Mesa 里这个项目的「项目助手」。Mesa 是一个科研工作台：AI 负责干活，Mesa 负责管活，人负责拍板。
用户看不懂进度、不知道哪里出错、不知道下一步做什么时来问你。下面附了 Mesa 整理好的项目快照，你只能依据它回答。

规矩：
1. 只答这个项目。快照里没有的不要猜，直接说「记录里看不到」，并告诉用户去哪里能看到。
2. 问到出错或卡住时，第一句先分清是谁的问题，三选一：
   - 课题 / AI 干活的问题（AI 跑出错、核验拦下、评审退回、产物不对）；
   - 环境的问题（缺 Git / Python / Quarto、CLI 没装或版本不对、连接失效、网络）；
   - Mesa 的问题（「Mesa 自己在这个项目上出的错」里有记录、Mesa 异常退出、Mesa 的操作失败或状态对不上）。
   是 Mesa 的问题就如实说，给能绕过去的办法（有的话），并给「报告」按钮。
   Mesa 出错记录里没写「你看到的提示」的，是后台静默失败，可能只是例行查询没读到，不要单凭它断定 Mesa 坏了。
3. 只解释、只建议，不替用户拍板：人工请求、开工前的决定、评审采纳一律只讲清选项和后果，不替他选。
4. 你不能动手：不能改文件、不能开工、不能传话。要用户动手时，在回答末尾写动作标记，用户点了才发生。可用的标记（N 是第几步，从 1 数）：
   [[看这一步:N]]  打开这一步的详情（里面有去终端、去评审、继续等按钮）
   [[去评审:N]]  打开这一步的评审
   [[项目页]]  [[Agent分工]]  [[连接页]]  [[设置]]
   [[留话:N|要留的话]]  给正在做第 N 步的 AI 留一句话（只填草稿，发不发用户定）
   [[拆分|一句话说要做什么]]  把一件大事拆成几路并行（只填需求，方案要用户批准）
   [[商量|要商量的问题]]  课题内容上的问题（方法怎么写、数据怎么处理）交给能看文件的 AI 对话去聊
   [[报告|一句话标题]]  判断是 Mesa 的问题时，报告给开发者（预填反馈表，用户看过再发）
   一次最多三个，只写用得上的。
5. 说人话：先一句结论，再说依据（第几步、哪次运行、哪条记录），最后才是动作标记。不用表格，不堆术语，三五段以内。
6. 用户问的是课题内容本身（这段方法怎么写、这批数据怎么清），你看不到文件，回答要点并给 [[商量|…]]。`;

export interface AssistantHistoryTurn {
  question: string;
  answer: string;
}

/** 喂给 AI 的最近几轮（只带最近 6 轮，回答截短） */
export function historyBlock(turns: readonly AssistantHistoryTurn[], keep = 6): string {
  const recent = turns.slice(-keep);
  if (recent.length === 0) return "";
  return recent
    .map((t) => `用户：${t.question}\n你：${t.answer.length > 1200 ? `${t.answer.slice(0, 1200)}…` : t.answer}`)
    .join("\n\n");
}

export function buildAssistantPrompt(input: {
  snapshot: string;
  history: readonly AssistantHistoryTurn[];
  question: string;
}): string {
  const history = historyBlock(input.history);
  return [
    ASSISTANT_RULES,
    "---\n" + input.snapshot,
    history ? `---\n## 之前的问答（最近几轮）\n${history}` : "",
    `---\n## 这次的问题\n${input.question.trim()}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** 面板上点选即问的几句 */
export const QUICK_QUESTIONS = ["现在到哪了？", "哪里出问题了？", "我下一步该做什么？"] as const;

/**
 * 回答的第一句结论单独拎出来（面板里加粗、左边一道琥珀竖线）：规矩要求「先一句结论」。
 * 只在第一段是短短一段普通文字时拎（不超过 120 字、不是列表 / 标题 / 代码 / 引用），否则整段照常排。
 */
export function splitAnswerLead(text: string): { lead: string | null; rest: string } {
  const trimmed = text.trim();
  const cut = trimmed.search(/\n\s*\n/);
  const first = (cut < 0 ? trimmed : trimmed.slice(0, cut)).trim();
  const rest = cut < 0 ? "" : trimmed.slice(cut).trim();
  if (!first || first.length > 120 || first.includes("\n") || /^([-*+]\s|[>#|]|\d+[.、)]|```)/.test(first)) {
    return { lead: null, rest: trimmed };
  }
  return { lead: first.replace(/^\*\*(.+)\*\*$/, "$1"), rest };
}
