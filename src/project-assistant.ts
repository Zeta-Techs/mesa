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
      return "拆成几个目标同时做…";
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
    // 动作标记写成了派活单那样的块（「:::商量|…\n:::」，2026-11-05 Codex 干跑实证）：认识的种类按标记收，不把原文露给人
    .replace(/:::[ \t]*([^\n]{1,600}?)[ \t]*\n\s*:::/g, (whole, body: string) =>
      KIND_WORDS[body.split(/[|:：]/)[0].replace(/\s+/g, "")] ? `[[${body}]]` : whole,
    )
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
 * - mixed 两样都沾（「第 3 步保存不进项目怎么办」）：快照 + 说明书都带；
 * - chat 打招呼、道谢：什么都不带，一两句回；
 * - general 判不出的（「现在几点」「这是什么」）：只带一点项目概况和当前时间，直接答；要查记录或说明书才答得了的，
 *   请用户问得具体些（2026-11-04 用户截图：问「现在几点」也去看项目记录、翻说明书）。
 * - request 要做事（2026-11-05，docs/design-assistant-intake.md）：交代一件要产出或改动文件的事（整理、画图、写报告、准备组会、规划实验…），
 *   带快照、项目地图、能力清单，起草前可只读查看文件，问清楚后起草派活单；上一轮刚问过它一个问题时，这一轮按 request 接着走。
 * 「问问为什么」带着某次运行进来的一律按 project。
 */
export type AssistantIntent = "howto" | "project" | "mixed" | "chat" | "general" | "request";

const CHAT_RE = /^(你好|您好|嗨|哈喽|hi|hello|hey|谢谢|多谢|感谢|thanks|thank you|好的|好|ok|okay|收到|在吗|在不在|辛苦了|早|早上好|晚安|拜拜|再见)[呀啊哦了吧！!。.~～，, ]*$/i;
const PROJECT_RE =
  /第\s*[一二三四五六七八九十\d]+\s*步|这一步|这个项目|本项目|项目里|进度|到哪|走到|还剩|下一步|接下来|卡住|卡在|出错|报错|失败|错误|没成|不成功|保存不进|没保存|评审|核验|退回|人工请求|留话|怎么回事|在跑|跑完|做完|产物|交了|花了多少|多少钱|哪里出问题/;
const HOWTO_RE =
  /怎么|如何|怎样|在哪|能不能|可不可以|可以.{0,12}吗|是什么|什么意思|啥意思|设置|切换|更换|跟换|换(个|成|一个|一下)?(模型|连接|主题|agent|配置|账号)|快捷键|入口|按钮|教程|用法/i;

/** 交代要做的事：「帮我 / 给我 / 我要…」或以动作开头；问出错原因的（含「为什么」「报错」）不算，那是查错 */
const REQUEST_RE =
  /帮我|给我|替我|麻烦你?|请你|我要|我想要|我需要|^(请)?(整理|总结|汇总|画|做|写|准备|规划|设计|分析|统计|生成|对比|合并|改|重画|重做|列|起草|汇报)|(准备|做|出).{0,8}(组会|汇报|答辩|周报|月报|报告|幻灯片|PPT|海报)/i;

/** 以后都要照办的偏好或决定（记忆，2026-11-05） */
const PREFERENCE_RE = /以后|今后|往后|每次都|一律|我们组|课题组|导师(要|要求|喜欢|习惯)|不要再|别再|记住/;

/** 只说了「帮我看看」「处理一下」、没说做什么的：判不出，请他说具体（不当成要做事去翻文件） */
const VAGUE_RE = /^(请|麻烦)?你?(帮我|给我|替我)?(看看|看一下|瞧瞧|弄一下|处理一下|搞一下)[吧呗。.!！?？~～]*$/;

export interface PreviousTurnHint {
  /** 上一轮回答里问了用户一个问题（:::问） */
  asked: boolean;
  /** 上一轮回答里起草了派活单、还没派 */
  drafted: boolean;
}

/** 从上一轮回答看要不要接着按「要做事」走 */
export function previousTurnHint(answer: string | undefined, dispatched = false): PreviousTurnHint {
  const a = answer ?? "";
  return { asked: CLARIFY_BLOCK.test(a), drafted: ORDER_BLOCK.test(a) && !dispatched };
}

export function classifyQuestion(question: string, hasFocus = false, prev?: PreviousTurnHint): AssistantIntent {
  if (hasFocus) return "project";
  const q = question.trim();
  // 上一轮问了它一个问题：这一句多半是在回答（「20 分钟」「上周的」），接着起草
  if (prev?.asked && !(q.length <= 12 && CHAT_RE.test(q))) return "request";
  if (q.length <= 12 && CHAT_RE.test(q)) return "chat";
  if (REQUEST_RE.test(q) && !INSPECT_RE.test(q) && !VAGUE_RE.test(q)) return "request";
  // 说的是以后都要照办的偏好（「以后组会都讲 15 分钟」「导师要 Word 版」）：按问项目走，快照里带着已记的知识，好判断要不要记
  if (PREFERENCE_RE.test(q) && !HOWTO_RE.test(q)) return "project";
  const project = PROJECT_RE.test(q);
  const howto = HOWTO_RE.test(q);
  if (project && howto) return "mixed";
  if (project) return "project";
  if (howto) return "howto";
  // 刚起草了派活单、这句又看不出别的意思（「交付改成 pptx」「再加上第二批数据」）：接着改单子
  if (prev?.drafted) return "request";
  return "general";
}

/**
 * 要不要让它只读查看项目文件（2026-11-04 用户拍板）：问「为什么出错 / 哪里卡住」这类要找具体原因的、或带着某次运行进来的，
 * 才在项目里只读跑一次去打开脚本、日志、产物核对；问进度、问下一步只看记录（快，便宜）。
 */
const INSPECT_RE = /出错|报错|错误|失败|为什么|怎么回事|卡住|卡在|没成|不成功|保存不进|跑不|不对|异常|bug|问题出在|原因/i;

export function wantsInspect(question: string, intent: AssistantIntent, hasFocus = false): boolean {
  // 要做事：起草前打开相关文件看一眼，单子才写得出依据（2026-11-05 放宽，原来只用于查错）
  if (intent === "request") return true;
  if (intent !== "project" && intent !== "mixed") return false;
  return hasFocus || INSPECT_RE.test(question);
}

/** 目前能只读查看项目文件的 Agent：不落盘 + 进程级只读两样都有的（后端 ai::inspect_readonly_args 同口径） */
export const INSPECT_AGENTS: readonly string[] = ["claude-code", "codex"];

/** 等的时候那一行写什么 */
export const INTENT_WAITING: Record<AssistantIntent, string> = {
  howto: "正在翻说明书…",
  project: "正在看这个项目的记录…",
  mixed: "正在看项目记录、翻说明书…",
  chat: "在想…",
  general: "在想…",
  request: "正在看项目里有什么，想想怎么做…",
};

export const INSPECT_WAITING = "正在打开项目里的文件核对…（只读，不会改动）";

const ACTION_MARKS = `你不能动手：不能改文件、不能开工、不能传话。要用户动手时，在回答末尾写动作标记，用户点了才发生。可用的标记（N 是第几步，从 1 数）：
   [[看这一步:N]]  打开这一步的详情（里面有去终端、去评审、继续等按钮）
   [[去评审:N]]  打开这一步的评审
   [[项目页]]  [[Agent分工]]  [[连接页]]  [[设置]]
   [[留话:N|要留的话]]  给正在做第 N 步的 AI 留一句话（只填草稿，发不发用户定）
   [[拆分|一句话说要做什么]]  把一件大事拆成几个目标同时做（只填需求，方案要用户批准）
   [[商量|要商量的问题]]  课题内容上的问题（方法怎么写、数据怎么处理）交给能看文件的 AI 对话去聊
   [[报告|一句话标题]]  判断是 Mesa 的问题时，报告给开发者（预填反馈表，用户看过再发）
   一次最多三个，只写用得上的；用不上就不写。`;

const IDENTITY = `你是 Mesa 里这个项目的「项目助手」（形象是一张活过来的小工作台「小桌」）。Mesa 是一个科研工作台：AI 负责干活，Mesa 负责管活，人负责拍板。
你只会说话：不能派活、不能开工、不能让任何 AI 接着做、不能替用户点按钮。用户说「派出去」「接着做」「开始吧」时，绝不能说「已经派出去了 / 已经让它接着做了」，
要告诉他点哪个按钮（派活单上的「派出去」、进展下面的「接着做」，或项目页的「重试」）；记录里看不到的结果不要说成发生了。`;

const STYLE = `说人话：先一句结论（单独成段），再说依据和怎么做，最后才是动作标记。不用表格，不堆术语，三五段以内；界面上的按钮、页面名照原文加粗写。`;

/** 记忆（2026-11-05）：用户说出以后都要照办的偏好时，起草一句交给人确认后记进项目知识 */
export const REMEMBER_RULES = `记住：用户说出以后都要照办的偏好或决定（「以后组会都讲 15 分钟」「导师要 Word 版」「不要再用某个方法」），在回答末尾加一块（一次最多一块）：
:::记下
一句话写清以后怎么办，脱离这段对话也看得懂
:::
用户点了才记进项目知识「已定 / 不做」，以后干活的 AI 和你都会照着办。快照「已定」里已经有的不再记；一次性的要求（只管这一次）不记；要定期做的事（「每周五出周报」）不记，那走派活单的「定时」一栏。`;

/** 问这个项目：只依据快照 */
export const PROJECT_RULES = `${IDENTITY}
用户看不懂进度、不知道哪里出错、不知道下一步做什么时来问你。下面附了 Mesa 整理好的项目快照，你只能依据它回答。

规矩：
1. 只答这个项目。快照里没有的不要猜：这次能只读查看文件就去文件里核对，不能就直说「记录里看不到」，并告诉用户去哪里能看到。
2. 问到出错或卡住时，第一句先分清是谁的问题，三选一：
   - 课题 / AI 干活的问题（AI 跑出错、核验拦下、评审退回、产物不对）；
   - 环境的问题（缺 Git / Python / Quarto、CLI 没装或版本不对、连接失效、网络）；
   - Mesa 的问题（「Mesa 自己在这个项目上出的错」里有记录、Mesa 异常退出、Mesa 的操作失败或状态对不上）。
   是 Mesa 的问题就如实说，给能绕过去的办法（有的话），并给「报告」按钮。
   Mesa 出错记录里没写「你看到的提示」的，是后台静默失败，可能只是例行查询没读到，不要单凭它断定 Mesa 坏了。
3. 只解释、只建议，不替用户拍板：人工请求、开工前的决定、评审采纳一律只讲清选项和后果，不替他选。
4. ${ACTION_MARKS}
5. ${STYLE}
6. 用户问的是课题内容本身（这段方法怎么写、这批数据怎么清），那不归你做，回答要点并给 [[商量|…]]。
7. 附了「说明书摘录」时，讲到怎么操作照摘录说，摘录没写的操作不要编。
8. ${REMEMBER_RULES}`;

/** 只读查看项目文件时多给的一段（跑在项目根，工作副本另列） */
export function inspectRules(projectRoot: string, worktrees: readonly string[], purpose: "debug" | "intake" = "debug"): string {
  const head = `这次你在项目文件夹里，可以**只读**查看文件：读、搜索、列目录。不能改文件、不能运行命令，也不要试。
项目根：${projectRoot}${worktrees.length ? `\n各步骤的工作副本（AI 实际干活的地方${purpose === "debug" ? "，出错多半在这里" : ""}）：\n${worktrees.map((w) => `- ${w}`).join("\n")}` : ""}`;
  if (purpose === "intake") {
    return `${head}
怎么看：先在项目地图里找和这件事相关的数据、记录、以前的产出，打开几个看清内容（记录怎么写的、数据有哪些列、时间范围），
够写清依据和范围就停；最多看十来个文件，大数据文件只看开头几十行，不读 PDF 正文，不读 .env、密钥一类文件。
派活单里的路径只写你在地图或文件里确实看到的。`;
  }
  return `${head}
怎么查：先从快照里找可疑处（出错的那一步、出错那次的事件、核验拦下的、退回意见），再去打开相关的脚本、日志、任务书（TASK.md）、产物核对；
最多看十来个文件，不读大数据文件和 PDF 正文，不读 .env、密钥一类文件。回答里写清你看了哪个文件、哪一行，看到了什么；没找到就直说没找到。`;
}

/** 怎么用 Mesa：只依据说明书摘录 */
export const HOWTO_RULES = `${IDENTITY}
用户这次问的是 Mesa 怎么用。下面附了说明书里和问题最相关的几段，以及这个项目的一点概况。

规矩：
1. 只依据说明书摘录回答：在哪个页面、点哪个按钮、一步一步怎么做；同一件事有几个地方能做（比如开聊前换、聊到一半换、给项目固定一个），分开说清各自管什么。
2. 摘录里没写到的不要编，直接说「说明书里没找到这一条」，建议去哪里看或换个说法问。
3. 和这个项目有关时（比如项目默认用哪家 Agent），结合概况说一句。
4. ${ACTION_MARKS}
5. ${STYLE}`;

/** 判不出是问项目还是问怎么用：只给概况和时间，直接答 */
export const GENERAL_RULES = `${IDENTITY}
这一问不像是问项目进度，也不像是问 Mesa 怎么用。下面只附了项目概况和当前时间。

规矩：
1. 能直接答的就直接答，一两句（比如问时间就照「当前时间」说）。
2. 要看项目记录或说明书才答得了的，不要猜，告诉用户换个问法（比如「第 3 步为什么出错」「怎么换模型」），你就会去查。
3. 课题内容本身的问题（方法怎么写、数据怎么处理）不归你做，回答要点并给 [[商量|…]]。
4. ${STYLE}`;

/** 打招呼、道谢 */
export const CHAT_RULES = `${IDENTITY}
用户只是打个招呼或道个谢。用一两句自然地回应，顺带说一句你能帮什么（问进度、查哪里出错、问 Mesa 怎么用）。不要罗列清单，不要写动作标记。`;

export interface AssistantHistoryTurn {
  question: string;
  answer: string;
  /** 这一轮的时间（项目地图据此标「上次问以来新出现或改过」） */
  at?: string;
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
  /** 只读查看项目文件时的那段说明（inspectRules） */
  inspect?: string | null;
  /** 用户此刻在看哪（2026-11-05）：「这个提示」「这里」指的是这一页上的东西 */
  where?: string | null;
  /** 项目地图（request，project-map.ts renderProjectMap） */
  map?: string | null;
  /** 能力清单（request）：内置任务、我的任务、已装技能 */
  catalog?: string | null;
}

export function buildAssistantPrompt(
  input: AssistantMaterials & { history: readonly AssistantHistoryTurn[]; question: string },
): string {
  const rules =
    input.intent === "request"
      ? REQUEST_RULES
      : input.intent === "project" || input.intent === "mixed"
      ? `${PROJECT_RULES}\n9. ${WORK_ORDER_RULES}`
      : input.intent === "howto"
      ? HOWTO_RULES
      : input.intent === "chat"
        ? CHAT_RULES
        : input.intent === "general"
          ? GENERAL_RULES
          : PROJECT_RULES;
  // 要做事要连着几轮问答（问了什么、答了什么）才起草得对，多带两轮
  const history = historyBlock(input.history, input.intent === "chat" || input.intent === "general" ? 3 : input.intent === "request" ? 6 : 4);
  const guide = input.guide?.length
    ? `## 说明书摘录（Mesa 产品说明书，按问题挑的几段）\n${input.guide.map((g) => `### ${g.heading}\n${g.text}`).join("\n\n")}`
    : input.intent === "howto"
      ? "## 说明书摘录\n（说明书里没翻到和这个问题相关的段落）"
      : "";
  return [
    rules,
    input.where ? `---\n## 用户提问时正在看\n${input.where}（问题里的「这个」「这里」多半指这一页上的东西）` : "",
    input.inspect ? `---\n## 这次可以只读查看项目文件\n${input.inspect}` : "",
    input.context ? `---\n## 项目概况\n${input.context}` : "",
    input.snapshot ? `---\n${input.snapshot}` : "",
    input.map ? `---\n## 项目里有什么（项目地图，只有文件名、大小、修改日期）\n${input.map}` : "",
    input.catalog ? `---\n## Mesa 能用的任务和技能（能力清单）\n${input.catalog}` : "",
    guide ? `---\n${guide}` : "",
    history ? `---\n## 之前的问答（最近几轮）\n${history}` : "",
    `---\n## 这次的问题\n${input.question.trim()}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** 回答下面那行「依据」：说明书哪几节 / 这个项目的记录 */
export function basisText(intent: AssistantIntent, guideHeadings: readonly string[], inspected = false): string {
  const parts: string[] = [];
  if (intent === "howto" || intent === "mixed") {
    const heads = [...new Set(guideHeadings)].slice(0, 3);
    parts.push(heads.length ? `说明书${heads.map((h) => `「${h}」`).join("")}` : "说明书里没翻到相关段落");
  }
  if (intent === "project" || intent === "mixed") parts.push(inspected ? "这个项目的记录与文件（只读查看）" : "这个项目的记录");
  if (intent === "request") parts.push(inspected ? "这个项目的记录、项目地图与文件（只读查看）" : "这个项目的记录与项目地图");
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
  // 只有一段的（寒暄、一句话回答）不拎：整段加粗带竖线像在强调，读着别扭（2026-11-04 用户截图）
  if (!rest || !first || first.length > 120 || first.includes("\n") || /^([-*+]\s|[>#|]|\d+[.、)]|```)/.test(first)) {
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

// ===== 派活单（2026-11-04 用户：「能不能像 Grok Bot 的子 bot 那样真正干活」→ 拍板「它起草、你点一下就派」）=====
// 项目助手自己仍不碰文件；要动手时起草一张派活单，人点「派出去」才开工：
// - 交给第 N 步：那一步自己的 AI 按单接着做（开着就留话，关着就接回那段对话带上单子）；
// - 新目标：记成一条目标，用项目默认 Agent 在隔离副本里做，做完照常验收。
// 一次回答最多一张；人工请求、拍板类事项不派活（Mesa 不替人回答）。

export interface WorkOrder {
  /** step = 交给某一步；goal = 另起一个目标 */
  target: "step" | "goal";
  /** 第几步（从 1 数），只有 step 用 */
  step: number | null;
  title: string;
  task: string;
  done: string;
  // ↓ 派活单 v2（2026-11-05，docs/design-assistant-intake.md §3.4）：与目标同一套合同字段，旧单子没有这些
  /** 依据材料：项目根下的相对路径（只读输入）；空 = 带整个项目 */
  inputs?: string[];
  /** 交付物：产出什么、写到哪里 */
  deliver?: string;
  /** 按哪个任务做（内置任务或我的任务的名字） */
  basedOn?: string;
  /** 点名的技能（派出时只留技能库里有的） */
  skills?: string[];
  /** 没问清、按默认处理的几条 */
  assumptions?: string;
  /** 做的时候遇到这些要停下来问 */
  mustAsk?: string;
  /** 想多久做一次（「常做」才有，如「每周五 17:00」）：卡片据此给「做成定时任务…」，人点了才去建（三期） */
  schedule?: string;
}

const ORDER_BLOCK = /:::\s*派活\s*\n([\s\S]*?)\n\s*:::/;
type OrderField = "target" | "title" | "task" | "done" | "inputs" | "deliver" | "basedOn" | "skills" | "assumptions" | "mustAsk" | "schedule";
const ORDER_FIELDS: [OrderField, RegExp][] = [
  ["target", /^交给[:：]\s*/],
  ["title", /^标题[:：]\s*/],
  ["task", /^要做[:：]\s*/],
  ["inputs", /^依据材料[:：]\s*/],
  ["deliver", /^交付物[:：]\s*/],
  ["done", /^怎样算做完[:：]\s*/],
  ["basedOn", /^按任务[:：]\s*/],
  ["skills", /^用到的技能[:：]\s*/],
  ["assumptions", /^先定下的假设[:：]\s*/],
  ["mustAsk", /^要停下来问的[:：]\s*/],
  ["schedule", /^定时[:：]\s*/],
];

const NONE_RE = /^(无|没有|不写|暂无|—|-|（?无）?)$/;

/** 依据材料一栏拆成路径：一行一个或顿号隔开；去掉列表符、反引号与括号里的说明；绝对路径、`..`、`~` 一律不要（不能带项目外的东西进隔离副本） */
export function parseOrderPaths(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\n|、|；|;|，/)) {
    const p = raw
      .trim()
      .replace(/^[-*+•]\s*/, "")
      .replace(/[（(][^）)]*[）)]\s*$/, "")
      .replace(/^`|`$/g, "")
      .trim()
      .replace(/^\.\//, "")
      .replace(/\\/g, "/");
    if (!p || NONE_RE.test(p)) continue;
    if (p.startsWith("/") || p.startsWith("~") || /^[a-zA-Z]:/.test(p) || p.split("/").includes("..")) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out.slice(0, 30);
}

function parseNames(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/、|，|,|\n|\s+/)
        .map((x) => x.replace(/^[-*+•]\s*/, "").replace(/[「」`]/g, "").trim())
        .filter((x) => x && !NONE_RE.test(x)),
    ),
  ].slice(0, 8);
}

function optional(text: string | undefined, cap: number): string | undefined {
  const t = (text ?? "").trim();
  return t && !NONE_RE.test(t) ? t.slice(0, cap) : undefined;
}

/** 从回答里取出派活单：正文去掉这一块；格式不对、去处不认识、没写要做什么的不要 */
export function parseWorkOrder(answer: string, stepCount: number): { text: string; order: WorkOrder | null } {
  const m = answer.match(ORDER_BLOCK);
  if (!m) return { text: answer, order: null };
  const text = answer.replace(m[0], "").replace(/\n{3,}/g, "\n\n").trim();
  const fields: Partial<Record<OrderField, string>> = {};
  let current: OrderField | null = null;
  for (const raw of m[1].split("\n")) {
    const line = raw.trimEnd();
    const hit = ORDER_FIELDS.find(([, re]) => re.test(line.trim()));
    if (hit) {
      current = hit[0];
      const value = line.trim().replace(hit[1], "");
      // 同一栏写了好几行（「依据材料：a」「依据材料：b」，2026-11-05 Codex 干跑实证）：接着往下记，不覆盖
      fields[current] = fields[current] ? `${fields[current]}\n${value}` : value;
    } else if (current) {
      fields[current] = `${fields[current]}\n${line}`.trim();
    }
  }
  const targetText = (fields.target ?? "").replace(/\s+/g, "");
  const stepMatch = targetText.match(/^第(\d+)步/);
  const target: WorkOrder["target"] | null = stepMatch ? "step" : /新目标|目标/.test(targetText) ? "goal" : null;
  const step = stepMatch ? Number(stepMatch[1]) : null;
  const task = (fields.task ?? "").trim();
  if (!target || !task || (target === "step" && (step === null || step < 1 || step > stepCount))) {
    return { text, order: null };
  }
  const order: WorkOrder = {
    target,
    step,
    title: (fields.title ?? "").trim().slice(0, 80) || task.split("\n")[0].slice(0, 40),
    task: task.slice(0, 4000),
    done: (fields.done ?? "").trim().slice(0, 2000),
  };
  const inputs = parseOrderPaths(fields.inputs ?? "");
  if (inputs.length) order.inputs = inputs;
  const skills = parseNames(fields.skills ?? "");
  if (skills.length) order.skills = skills;
  const deliver = optional(fields.deliver, 2000);
  if (deliver) order.deliver = deliver;
  const basedOn = optional(fields.basedOn?.replace(/[「」]/g, ""), 80);
  if (basedOn) order.basedOn = basedOn;
  const assumptions = optional(fields.assumptions, 2000);
  if (assumptions) order.assumptions = assumptions;
  const mustAsk = optional(fields.mustAsk, 2000);
  if (mustAsk) order.mustAsk = mustAsk;
  const schedule = optional(fields.schedule, 80);
  if (schedule) order.schedule = schedule;
  return { text, order };
}

/** 科研项目里每件派出去的活都带的通则（2026-11-05，design-assistant-intake §3.5）：不按场景写规矩，只写这一套 */
export const RESEARCH_ORDER_RULES = `科研通则（每件活都守）：
- 数字由脚本从数据算出，脚本留在交付物里；不手抄、不估算。
- 每条结论标出处：哪条记录、哪个数据文件、哪篇文献（bib 键）。
- 不编造数据，不生成冒充实验结果的图像。
- 规划类只给两到三个候选方案，各写依据、假设、风险和所需样本量，由我来选，不写「建议采用」。
- 原始资料只读；我改过的文件为准，在它上面局部改。`;

export interface OrderTextOptions {
  /** 科研项目：附科研通则 */
  research?: boolean;
  /** 按内置任务做时的做法（builtin-tasks.ts builtinTaskMethod） */
  method?: string | null;
}

/** 单子各栏拼成正文（留话、接回对话、记目标三处共用） */
function orderBody(order: WorkOrder, opts: OrderTextOptions): string[] {
  return [
    order.inputs?.length ? `依据材料（先从这些看起）：\n${order.inputs.map((p) => `- ${p}`).join("\n")}` : "",
    order.deliver ? `交付物：${order.deliver}` : "",
    order.done ? `怎样算做完：${order.done}` : "",
    order.assumptions ? `先定下的假设（不对就先停下来问我）：${order.assumptions}` : "",
    order.mustAsk ? `做的时候遇到这些要先停下来问我：${order.mustAsk}` : "",
    opts.method ?? (order.basedOn ? `按「${order.basedOn}」的做法来做。` : ""),
    opts.research ? RESEARCH_ORDER_RULES : "",
  ].filter(Boolean);
}

/** 交给某一步时送进那段对话的话（留话或接回时的第一句） */
export function workOrderMessage(order: WorkOrder, opts: OrderTextOptions = {}): string {
  return [
    "【项目助手起草、我在 Mesa 工作台批准的一件活】",
    `要做：${order.task}`,
    ...orderBody(order, opts),
    "按这一步原来的任务书和项目规则做；做完照常停下，等我评审、保存进项目。",
  ]
    .filter(Boolean)
    .join("\n");
}

/** 新目标的目标原文（要求写清、做完怎样算数） */
export function workOrderGoalText(order: WorkOrder, opts: OrderTextOptions = {}): string {
  return [order.task, ...orderBody(order, opts)].filter(Boolean).join("\n\n");
}

export const WORK_ORDER_RULES = `派活：真要动手（整理、分析、画图、写报告、改脚本、补产物、重做某一步的一部分）时，你自己不做，写一张派活单交给干活的 AI，用户点「派出去」才开工。格式（单独成块、放在回答末尾、一次最多一张；标了「可省」的栏没有就不写那一行）：
:::派活
交给：第 N 步   （或：新目标）
标题：一句话，十来个字
要做：具体做什么；写清依据（哪个文件哪一行、哪条记录）
依据材料：要读的文件或目录，项目根下的相对路径，一行一个（可省，省了就带整个项目）
交付物：产出什么、写到哪里（可省）
怎样算做完：能核对的标准
按任务：能力清单里的任务名（可省）
用到的技能：能力清单里的技能名，顿号隔开（可省）
先定下的假设：没问清、按默认处理的几条（可省）
要停下来问的：这件活做的时候遇到哪些情况必须先问用户（可省）
定时：用户要以后定期做时写多久一次，如「每周五 17:00」（可省；只说明意愿，你不建定时任务）
:::
交给第 N 步 = 那一步自己的 AI 在它的工作副本里按单接着做（问题出在某一步的产物时用这个）；新目标 = 另起一个目标在隔离副本里做，做完走验收（不属于任何一步的活用这个）。
只在确实需要动手、而且你说得清要做什么时才写；人工请求、开工前的决定、评审采不采纳这些要用户拍板的事不派活；Mesa 自己的毛病派不了活，给「报告」。`;

/** 从回答里取出要记进项目知识的那一句（:::记下 块）：正文去掉这一块；空的不要，截到 300 字 */
export function parseRemember(answer: string): { text: string; remember: string | null } {
  const m = answer.match(/:::\s*记下\s*\n([\s\S]*?)\n\s*:::/);
  if (!m) return { text: answer, remember: null };
  const text = answer.replace(m[0], "").replace(/\n{3,}/g, "\n\n").trim();
  const one = m[1].replace(/\s*\n\s*/g, " ").trim().slice(0, 300);
  return { text, remember: one || null };
}

// ===== 问清楚（2026-11-05，design-assistant-intake §3.3）：缺关键信息时一次问一个，给可点的选项 =====

export interface ClarifyAsk {
  question: string;
  options: string[];
}

const CLARIFY_BLOCK = /:::\s*问\s*\n([\s\S]*?)\n\s*:::/;

/** 从回答里取出要问用户的那一个问题：正文去掉这一块，选项最多四个，点了当作回答发回 */
export function parseClarify(answer: string): { text: string; ask: ClarifyAsk | null } {
  const m = answer.match(CLARIFY_BLOCK);
  if (!m) return { text: answer, ask: null };
  const text = answer.replace(m[0], "").replace(/\n{3,}/g, "\n\n").trim();
  const q = m[1].match(/问题[:：]\s*(.+)/)?.[1]?.trim() ?? "";
  const opts = (m[1].match(/选项[:：]\s*(.+)/)?.[1] ?? "")
    .split(/｜|\|/)
    .map((o) => o.trim().slice(0, 40))
    .filter(Boolean);
  if (!q) return { text, ask: null };
  return { text, ask: { question: q.slice(0, 200), options: [...new Set(opts)].slice(0, 4) } };
}

/** 要做事：判断去向 → 看材料 → 问清楚 → 起草派活单（2026-11-05，docs/design-assistant-intake.md §2–3） */
export const REQUEST_RULES = `${IDENTITY}
用户这次交代了一件要做的事。下面附了项目快照、项目地图（项目里有哪些文件）和能力清单（Mesa 能用的任务和技能）。

先判断这件事归哪种去向；一句话里混着几种就拆开，能答的先答：
- 问：快照、地图、文件里就答得了的，直接答。
- 做：要产出或改动项目里的文件（整理、分析、画图、写报告、做幻灯片、规划实验……），起草派活单。
- 定：要用户拍板的（选方案、答人工请求、评审采不采纳），只讲清选项和各自依据，不替他选。
- 常做：「以后每周都……」：先按一次起草派活单，单子里写「定时」一栏；告诉用户先看这一次的效果，满意了点单子上的「做成定时任务…」去建（会先让 AI 写一个巡检技能、他确认才落盘）。你不建。
- 改流程：要在流程里加减步骤，说明怎么改，给 [[项目页]]。
- 范围外：别的项目、电脑之外的动作（发邮件、订试剂、操作仪器、提交投稿系统）、修 Mesa 自己：说清做不了；能做到哪一步就派那一步（比如把邮件正文起草成文件，由用户自己发）。

起草派活单前：
1. 先看材料：从地图里找相关的数据、记录、以前的产出；这次能只读查看文件就打开看几个，依据写到具体文件。
2. 缺关键信息先问，不要猜。一次只问一个，放在回答末尾，格式：
:::问
问题：一句话
选项：选项一｜选项二｜选项三
:::
   选项两到四个（用户也可以自己打字答）。问过的不再问；已经问过三个还不清楚的，按最稳妥的做法起草，写进「先定下的假设」。
   你问的只是「要什么」（范围、对象、格式、时长、给谁看）；方法细节交给干活的 AI，它做的时候会问。
3. 能力清单里有合适的任务就写「按任务」，有合适的技能就写进「用到的技能」；只能写清单里有的名字，不要编。没有合适的就不写，干活的 AI 按通用做法做。
4. 一次回答里要么问一个问题，要么起草一张派活单，不要两样都有。动作标记只用 [[…]] 写法，不要写成 ::: 块。
5. 按能力清单里「干活的连接」说能做到哪一步：这条连接做不到的部分（看不了图、没配出图模型、不能在后台写文件所以建不了定时任务）在回答里直说，
   单子只派做得到的，做不到的写清要用户补什么（给文字版或数据文件、到连接页配出图模型、换一条连接）；不要假装能做。

${WORK_ORDER_RULES}

其他：
- ${ACTION_MARKS}
- ${STYLE}
- 只依据快照、地图和你看过的文件，不编文件名；看不到的直说。
- ${REMEMBER_RULES}`;

// ===== 提速（2026-11-04 用户：「为什么感觉回答很慢」，实测寒暄 8–19 秒、问怎么用 51–57 秒）=====

/** 按问题类型压低思考档：寒暄 / 判不出 / 问怎么用用低档，问项目、查出错照连接原档（后端只在连接本来就设了思考档时才改） */
export function intentEffort(intent: AssistantIntent): "low" | null {
  return intent === "chat" || intent === "general" || intent === "howto" ? "low" : null;
}

const GREETING_RE = /^(你好|您好|嗨|哈喽|hi|hello|hey|在吗|在不在|早|早上好|晚上好)[呀啊哦了吧！!。.~～，, ]*$/i;
const THANKS_RE = /^(谢谢|多谢|感谢|thanks|thank you|辛苦了|好的|好|ok|okay|收到|明白了|懂了)[呀啊哦了吧！!。.~～，, ]*$/i;
const BYE_RE = /^(拜拜|再见|晚安|bye)[呀啊哦了吧！!。.~～，, ]*$/i;

/** 纯寒暄本地直接回，不调 AI（瞬间回；其余一律交给 AI） */
export function localReply(question: string, hour: number): string | null {
  const q = question.trim();
  if (q.length > 12) return null;
  if (GREETING_RE.test(q)) {
    const lead = hour >= 22 || hour < 6 ? "这么晚还在忙呀。" : hour < 11 ? "早！" : "你好！";
    return `${lead}想问项目到哪了、哪一步出了错，还是想知道 Mesa 怎么用，直接说就行。`;
  }
  if (THANKS_RE.test(q)) return "不客气，有事再叫我。";
  if (BYE_RE.test(q)) return hour >= 22 || hour < 6 ? "晚安，早点休息。" : "回头见。";
  return null;
}

/** 喂给 AI 的材料上限（砍过一刀）：快照字数、说明书段数、最近几轮 */
export const SNAPSHOT_MAX_CHARS = 14_000;
export const GUIDE_LIMIT: Record<"howto" | "mixed", number> = { howto: 3, mixed: 2 };

/** 「换个查法」（分流靠字面会判错）：按这一轮的依据给出另一种查法，人点了按那一类重问；寒暄、本地现答的不给 */
export function retryIntents(basis: string | undefined, connection: string | undefined): { intent: AssistantIntent; label: string }[] {
  if (connection?.startsWith("本地")) return [];
  const b = basis ?? "";
  const guide = b.includes("说明书");
  const project = b.includes("项目的记录");
  const out: { intent: AssistantIntent; label: string }[] = [];
  if (!project) out.push({ intent: "project", label: "看项目记录重问" });
  if (!guide) out.push({ intent: "howto", label: "翻说明书重问" });
  return guide && project ? [] : out;
}
