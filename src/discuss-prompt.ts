/**
 * 「跟 AI 商量一下」的开场指令（2026-11-05 用户拍板：苏格拉底式提问）。
 * 目的是把人自己的想法问出来写进任务书，让成稿贴合他的判断；不是逐条核对模板流程。
 * 规矩：一次只问一个；先开放再追问；答不上来给 2–3 个选项并推荐；答得清楚的直接写进去、同一条消息接着问下一个
 *（2026-11-09 用户：每答一个都要再确认一遍太慢，原「每定一件复述确认再写」作废），只有自己补了解读的才先问；
 * 模板已定的流程细节（检索库、文件格式、脚本、产物清单）不拿来问人。
 * 各步该往哪问按步骤工作区名给方向（只进开场指令，不在步骤卡上摆话头，免得界面变乱）。
 */

/** 按步骤工作区名给的提问方向（内置英文综述五步；没有的步骤走通用方向） */
export const DISCUSS_FOCUS: Record<string, string[]> = {
  "lit-search": [
    "这篇综述最想回答的一个问题是什么，读完的人应该带走哪个判断",
    "边界在哪：哪些对象、方法、年份一定要，哪些明确不要",
    "你已经知道、必须出现的关键论文或课题组有哪些",
    "有没有你怀疑或想挑战的主流说法",
  ],
  "lit-notes": [
    "读每篇时你最想抽出什么（关键指标、机制证据、实验条件……）",
    // 项目规则「文献数据抽取表：让 AI 提议列」时，列在这里定：写进已定方向，开工后简报照用、不再发人工请求（2026-11-10 HER：商量里聊过、开工又问一遍）
    "项目规则里「文献数据抽取表」是「让 AI 提议列」的：按课题提议 6–10 列（含单位与测试条件）请我增删，定了写进「已定方向」一行「文献数据抽取表的列：…」",
    "哪些数字要统一条件或单位才能横向比较",
    "什么样的结果你会觉得可疑，需要特别标出来",
  ],
  outline: [
    "全文的中心论点用一句话怎么说",
    "希望读者按什么顺序理解：按对象、按机制，还是按待解决的问题，为什么",
    "哪里是领域还没共识、你想重点展开的",
  ],
  draft: [
    "引言要让读者相信哪件事值得关心",
    "哪几处你有自己的判断，要写成观点而不是罗列文献",
    "结论和展望里你最想推的方向是什么",
  ],
  polish: [
    "目标期刊对篇幅、结构和语气有什么硬要求",
    "你最担心审稿人挑哪一处",
    "哪些地方的说法你还拿不准，需要再收紧或加限定",
  ],
};

const GENERIC_FOCUS = [
  "这一步交出的东西你打算拿来做什么，做到什么程度算好",
  "有哪些你已经有的想法、材料或偏好，AI 应该照着来",
  "有没有明确不想要的做法或结果",
];

export function discussFocus(workspaceName: string | null | undefined): string[] {
  return DISCUSS_FOCUS[workspaceName ?? ""] ?? GENERIC_FOCUS;
}

export function discussOpeningPrompt(input: {
  stepName: string;
  relPath: string;
  workspaceName?: string | null;
  /** 项目规则里还没定的全局设定行（「名称：（提示）」） */
  openSettings?: readonly string[];
  /** 模板给这一步的讨论种子（有就并进提问方向） */
  seeds?: readonly string[];
}): string {
  const open = (input.openSettings ?? []).map((l) => l.trim()).filter(Boolean);
  const focus = [...(input.seeds ?? []).map((s) => s.trim()).filter(Boolean), ...discussFocus(input.workspaceName)];
  return (
    `我们一起敲定「${input.stepName}」这一步的任务书（${input.relPath}）。` +
    `它现在是 TASK.md 的默认拼装（步骤简报、预期产物等都在里面），定稿后会原样落成工作区的 TASK.md。\n` +
    `这次请用苏格拉底式提问帮我把自己的想法想清楚，而不是逐条核对流程：\n` +
    `1. 先通读任务书。检索库、文件格式、脚本、产物清单这些模板已经定好，不要拿来问我；只问会改变结果、而且只有我能回答的事。\n` +
    `2. 一次只问一个问题，等我回答再问下一个。先问开放的问题（想回答什么、为什么），再顺着我的回答追问：请我举例、划边界、说反例，或指出我前后不一致的地方。\n` +
    `3. 我答不上来时，给 2–3 个具体选项，说清各自会带来什么结果、你推荐哪个、为什么。\n` +
    `4. 我答清楚了就直接写进这份任务书的「## 已定方向」小节（一行一条：问题：结论），正文里相应的说法也一起改；在同一条回复里用一句话说记下了什么，紧接着问下一个，不要停下来等我确认，我觉得不对会直接说。只有我的回答含糊、或你在我的话之外补了自己的解读时，才先问一句再写。\n` +
    `5. 一般问 5–8 个问题就收住，我说「够了」也停。最后列出已定的几条，没定下来的记到「## 待拍板」小节，并告诉我可以回 Mesa 点「开始」（照原样写「开始」带书名号，Mesa 会把它变成能点的入口）。\n` +
    `这一步可以从这些方向问起（按我的回答取舍，不必全问）：${focus.join("；")}。\n` +
    (open.length
      ? `项目规则里还有没定的全局设定，也在提问中问到：我确定一项，就把 .ccode/project.toml 的 settings 里对应那一行从「名称：（提示）」改成「名称：我的答案」，不要改这个文件的其他内容。还没定的是：${open.join("；")}。\n`
      : "") +
    `只允许新建/修改这份任务书，以及上面点名的项目规则行，其他文件一律不要动。` +
    // 2026-10-24 HER 润色：商量时把「导入 EndNote 库、写库路径」写成了域稿的硬前置，AI 做好的 docx 又撤下
    `不要把模板里的可选事项改成开工前必须办的前置，也不要因为某个可选设置没办就让某份产物不交，除非我明确这么说。`
  );
}

// ===== 商量对话的标签复用键（2026-11-12：回复里的「开始」可点，见 discuss-step-start.ts） =====

const DISCUSS_KEY_PREFIX = "discuss:";
/** 任务书草稿恒在这个目录下（projects.rs draft_rel_path 单一出处）；Windows 项目根自带「C:」，按它切 */
const DRAFT_DIR = ".ccode/drafts/";

/** 同一步骤的任务书商量是同一个对话：StepFlow 开聊时用它当复用键，随标签持久化 */
export function discussReuseKey(projectRoot: string, relPath: string): string {
  return `${DISCUSS_KEY_PREFIX}${projectRoot}:${relPath}`;
}

export function parseDiscussReuseKey(key: string | null | undefined): { projectRoot: string; relPath: string } | null {
  if (!key?.startsWith(DISCUSS_KEY_PREFIX)) return null;
  const rest = key.slice(DISCUSS_KEY_PREFIX.length);
  const cut = rest.lastIndexOf(`:${DRAFT_DIR}`);
  if (cut <= 0) return null;
  return { projectRoot: rest.slice(0, cut), relPath: rest.slice(cut + 1) };
}
