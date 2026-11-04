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

/**
 * 问题分流（2026-11-04 用户：「问怎么换模型也要看项目记录吗」）：本地按字面先判一次，不多调一次 AI。
 * - howto 怎么用 Mesa（在哪设置、怎么换模型、某个词什么意思）：只翻说明书，带一点项目概况，不拼项目快照；
 * - project 问这个项目（进度、出错、下一步、第几步）：拼项目快照（原来的做法）；
 * - mixed 两样都沾（「第 3 步保存不进项目怎么办」）或判不出：快照 + 说明书都带；
 * - chat 打招呼、道谢：什么都不带，一两句回。
 * 「问问为什么」带着某次运行进来的一律按 project。
 */
export type AssistantIntent = "howto" | "project" | "mixed" | "chat";

const CHAT_RE = /^(你好|您好|嗨|哈喽|hi|hello|hey|谢谢|多谢|感谢|thanks|thank you|好的|好|ok|okay|收到|在吗|在不在|辛苦了|早|早上好|晚安|拜拜|再见)[呀啊哦了吧！!。.~～，, ]*$/i;
const PROJECT_RE =
  /第\s*[一二三四五六七八九十\d]+\s*步|这一步|这个项目|本项目|项目里|进度|到哪|走到|还剩|下一步|接下来|卡住|卡在|出错|报错|失败|错误|没成|不成功|保存不进|没保存|评审|核验|退回|人工请求|留话|怎么回事|在跑|跑完|做完|产物|交了|花了多少|多少钱|哪里出问题/;
const HOWTO_RE =
  /怎么|如何|怎样|在哪|能不能|可不可以|可以.{0,12}吗|是什么|什么意思|啥意思|设置|切换|更换|跟换|换(个|成|一个|一下)?(模型|连接|主题|agent|配置|账号)|快捷键|入口|按钮|教程|用法/i;

export function classifyQuestion(question: string, hasFocus = false): AssistantIntent {
  if (hasFocus) return "project";
  const q = question.trim();
  if (q.length <= 12 && CHAT_RE.test(q)) return "chat";
  const project = PROJECT_RE.test(q);
  const howto = HOWTO_RE.test(q);
  if (project && howto) return "mixed";
  if (project) return "project";
  if (howto) return "howto";
  return "mixed";
}

/** 等的时候那一行写什么 */
export const INTENT_WAITING: Record<AssistantIntent, string> = {
  howto: "正在翻说明书…",
  project: "正在看这个项目的记录…",
  mixed: "正在看项目记录、翻说明书…",
  chat: "在想…",
};

const ACTION_MARKS = `你不能动手：不能改文件、不能开工、不能传话。要用户动手时，在回答末尾写动作标记，用户点了才发生。可用的标记（N 是第几步，从 1 数）：
   [[看这一步:N]]  打开这一步的详情（里面有去终端、去评审、继续等按钮）
   [[去评审:N]]  打开这一步的评审
   [[项目页]]  [[Agent分工]]  [[连接页]]  [[设置]]
   [[留话:N|要留的话]]  给正在做第 N 步的 AI 留一句话（只填草稿，发不发用户定）
   [[拆分|一句话说要做什么]]  把一件大事拆成几路并行（只填需求，方案要用户批准）
   [[商量|要商量的问题]]  课题内容上的问题（方法怎么写、数据怎么处理）交给能看文件的 AI 对话去聊
   [[报告|一句话标题]]  判断是 Mesa 的问题时，报告给开发者（预填反馈表，用户看过再发）
   一次最多三个，只写用得上的；用不上就不写。`;

const IDENTITY = `你是 Mesa 里这个项目的「项目助手」（形象是一张活过来的小工作台「小桌」）。Mesa 是一个科研工作台：AI 负责干活，Mesa 负责管活，人负责拍板。`;

const STYLE = `说人话：先一句结论（单独成段），再说依据和怎么做，最后才是动作标记。不用表格，不堆术语，三五段以内；界面上的按钮、页面名照原文加粗写。`;

/** 问这个项目：只依据快照 */
export const PROJECT_RULES = `${IDENTITY}
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
4. ${ACTION_MARKS}
5. ${STYLE}
6. 用户问的是课题内容本身（这段方法怎么写、这批数据怎么清），你看不到文件，回答要点并给 [[商量|…]]。
7. 附了「说明书摘录」时，讲到怎么操作照摘录说，摘录没写的操作不要编。`;

/** 怎么用 Mesa：只依据说明书摘录 */
export const HOWTO_RULES = `${IDENTITY}
用户这次问的是 Mesa 怎么用。下面附了说明书里和问题最相关的几段，以及这个项目的一点概况。

规矩：
1. 只依据说明书摘录回答：在哪个页面、点哪个按钮、一步一步怎么做；同一件事有几个地方能做（比如开聊前换、聊到一半换、给项目固定一个），分开说清各自管什么。
2. 摘录里没写到的不要编，直接说「说明书里没找到这一条」，建议去哪里看或换个说法问。
3. 和这个项目有关时（比如项目默认用哪家 Agent），结合概况说一句。
4. ${ACTION_MARKS}
5. ${STYLE}`;

/** 打招呼、道谢 */
export const CHAT_RULES = `${IDENTITY}
用户只是打个招呼或道个谢。用一两句自然地回应，顺带说一句你能帮什么（问进度、查哪里出错、问 Mesa 怎么用）。不要罗列清单，不要写动作标记。`;

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

export interface AssistantMaterials {
  intent: AssistantIntent;
  /** 项目快照（project / mixed） */
  snapshot?: string | null;
  /** 说明书摘录（howto / mixed） */
  guide?: readonly { heading: string; text: string }[];
  /** 一点项目概况（howto：项目名、工作方式、默认 Agent、项目助手用的连接） */
  context?: string | null;
}

export function buildAssistantPrompt(
  input: AssistantMaterials & { history: readonly AssistantHistoryTurn[]; question: string },
): string {
  const rules = input.intent === "howto" ? HOWTO_RULES : input.intent === "chat" ? CHAT_RULES : PROJECT_RULES;
  const history = historyBlock(input.history, input.intent === "chat" ? 2 : 6);
  const guide = input.guide?.length
    ? `## 说明书摘录（Mesa 产品说明书，按问题挑的几段）\n${input.guide.map((g) => `### ${g.heading}\n${g.text}`).join("\n\n")}`
    : input.intent === "howto"
      ? "## 说明书摘录\n（说明书里没翻到和这个问题相关的段落）"
      : "";
  return [
    rules,
    input.context ? `---\n## 项目概况\n${input.context}` : "",
    input.snapshot ? `---\n${input.snapshot}` : "",
    guide ? `---\n${guide}` : "",
    history ? `---\n## 之前的问答（最近几轮）\n${history}` : "",
    `---\n## 这次的问题\n${input.question.trim()}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** 回答下面那行「依据」：说明书哪几节 / 这个项目的记录 */
export function basisText(intent: AssistantIntent, guideHeadings: readonly string[]): string {
  const parts: string[] = [];
  if (intent === "howto" || intent === "mixed") {
    const heads = [...new Set(guideHeadings)].slice(0, 3);
    parts.push(heads.length ? `说明书${heads.map((h) => `「${h}」`).join("")}` : "说明书里没翻到相关段落");
  }
  if (intent === "project" || intent === "mixed") parts.push("这个项目的记录");
  return parts.join(" · ");
}

/** 从「依据」里拆出说明书小节（面板上做成链接） */
export function basisGuideHeadings(basis: string): string[] {
  const m = basis.match(/说明书((?:「[^」]+」)+)/);
  return m ? [...m[1].matchAll(/「([^」]+)」/g)].map((x) => x[1]) : [];
}

/** GitHub 标题锚点（说明书外链跳到那一节）：小写、去标点、空格变连字符，「8.1 聊天 / 终端」→「81-聊天--终端」 */
export function guideAnchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
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

/** 没问成时给人看的话：常见几类译成白话 + 怎么办，其余照原文（不吞原因） */
export function assistantErrorText(reason: string): string {
  const r = reason.replace(/^Error:\s*/, "").trim();
  if (/AI 调用超时/.test(r)) {
    return "等了两分钟还没答完，多半是这条连接太慢或网络不稳。可以再问一次，或在 Agent 分工 → 专属绑定 → 项目助手 换一条快一点的连接。";
  }
  if (/未找到 .+（PATH/.test(r)) return `这条连接对应的 Agent 在这台电脑上找不到：${r}。去连接页装好，或给项目助手换一条连接。`;
  if (/不支持无头调用/.test(r)) return "这条连接所属的 Agent 不能后台问答，给项目助手换一条连接（Agent 分工 → 专属绑定 → 项目助手）。";
  if (/密钥|api key|401|403|unauthorized|forbidden/i.test(r)) return `连接的密钥或登录不对：${r}。去连接页检查这条连接。`;
  if (/network|connect|ENOTFOUND|ECONNREFUSED|网络/i.test(r)) return `网络没连上：${r}。检查网络或代理后再问一次。`;
  return r;
}
