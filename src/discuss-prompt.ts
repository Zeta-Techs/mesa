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
    "项目规则里「文献数据抽取表」是「让 AI 提议列」的：按课题提议总计 6–10 列（含末两列固定「来源 [@键]」「页码／图表」，即业务列 4–8 列，并写清默认基准与缺失值规则）请我增删，定了写进「已定方向」一行「文献数据抽取表的列：…」",
    "哪些数字要统一条件或单位才能横向比较",
    "什么样的结果你会觉得可疑，需要特别标出来",
  ],
  outline: [
    "核心问题与中心论点：对照上游已定问题，全文中心论点与希望读者读完带走的一句判断怎么说（对应正式执行定框架第①、③问）",
    "角度取舍：结合 notes/angles.md 的候选角度，选哪几个作主轴、哪些并入或舍弃（对应第②问）",
    "骨架与推进顺序：是否借用某篇已有综述的骨架，或按对象／机制／问题自搭顺序（对应第④问；章节草图与薄节补料第⑤、⑥问留待正式执行）",
    "哪里是领域还没共识、你想重点展开的争议与核心图表方向",
  ],
  draft: [
    "引言要让读者相信哪件事值得关心",
    "哪几处你有自己的判断，要写成观点而不是罗列文献",
    "结论和展望里你最想推的方向是什么",
    "自绘示意图风格与路线（若大纲含自绘图）：零 AI 像素纯矢量极简风 / Blender 3D 插画风（需本机有 Blender，没装自动回落纯矢量） / 允许生图模型无字底图（需核目标期刊 AI 政策），以及是否指定参照图或配色",
  ],
  polish: [
    "去向（目标期刊 / 学位论文 / 课程）对篇幅、结构和语气有什么硬要求",
    "你最担心审稿人挑哪一处",
    "哪些地方的说法你还拿不准，需要再收紧或加限定",
    "是否指定项目库内 1–2 篇目标期刊综述作行文风格参照（生成轻量 manuscript/voice-profile.md），以及非核心仅摘要引用是降级保留还是定稿移出",
  ],
};

const GENERIC_FOCUS = [
  "这一步交出的东西你打算拿来做什么，做到什么程度算好",
  "有哪些你已经有的想法、材料或偏好，AI 应该照着来",
  "有没有明确不想要的做法或结果",
];

/** 商量开场前建议一并通读的上游关键汇总文件（存在就先读，让提问落在真实文献证据与分歧上） */
export const DISCUSS_READ_FIRST: Record<string, string[]> = {
  "lit-notes": ["papers/screening.md", "papers/included.md"],
  outline: ["notes/angles.md", "notes/handoff.md"],
  draft: ["outline.md", "notes/handoff.md"],
  polish: ["outline.md", "manuscript/ 已有草稿"],
};

export function discussFocus(workspaceName: string | null | undefined): string[] {
  return DISCUSS_FOCUS[workspaceName ?? ""] ?? GENERIC_FOCUS;
}

export function discussOpeningPrompt(input: {
  stepName: string;
  relPath: string;
  workspaceName?: string | null;
  /** 项目规则里还没定的全局设定行（「名称：（提示）」） */
  openSettings?: readonly string[];
  /** 项目规则里现有的全部全局设定（人想改已填的去向 / 篇幅 / 角度 / 抽取表时也能同步写回） */
  projectSettings?: readonly string[];
  /** 模板给这一步的讨论种子（有就并进提问方向） */
  seeds?: readonly string[];
}): string {
  const open = (input.openSettings ?? []).map((l) => l.trim()).filter(Boolean);
  const settings = (input.projectSettings ?? []).map((l) => l.trim()).filter(Boolean);
  const focus = [...(input.seeds ?? []).map((s) => s.trim()).filter(Boolean), ...discussFocus(input.workspaceName)];
  const readFirst = DISCUSS_READ_FIRST[input.workspaceName ?? ""] ?? [];
  const readFirstNote = readFirst.length
    ? `若项目里已有 ${readFirst.join("、")}，也先一并通读再提第一个问题，让提问落在真实证据和分歧上。`
    : "";
  return (
    `我们一起敲定「${input.stepName}」这一步的任务书（${input.relPath}）。` +
    `它现在是 TASK.md 的默认拼装（步骤简报、预期产物等都在里面），定稿后会落成工作区的 TASK.md。\n` +
    `【当前为开工前商量阶段，不是正式执行】任务书里给正式执行准备的「决策暂停策略」（要求写 .ccode/help-wanted.md）、「收尾」（提交 git）及产出结果文件条款此时一律不执行；所有问题只在对话里问，定下来的写进本任务书「## 已定方向」，未决项写进「## 待拍板」。\n` +
    `这次请用苏格拉底式提问帮我把自己的想法想清楚，而不是逐条核对流程：\n` +
    `1. 先通读任务书。${readFirstNote}检索库、文件格式、脚本、产物清单这些模板已经定好，不要拿来问我；只问会改变结果、而且只有我能回答的事。\n` +
    `2. 一次只问一个问题，等我回答再问下一个。先问开放的问题（想回答什么、为什么），再顺着我的回答追问：请我举例、划边界、说反例，或指出我前后不一致的地方。\n` +
    `3. 我答不上来或单题说「按你推荐」时，给 2–3 个具体选项，说清各自会带来什么结果、你推荐哪个、为什么；若我明确全权委托（「所有问题按你推荐」「剩下的你定」），不再逐轮反问，一次性把剩余核心决策按你的推荐写入「## 已定方向」、须等正式执行数据才能定的项写入「## 待拍板」，并在回复里逐条汇总供我纠偏。\n` +
    `4. 我答清楚了就直接写进这份任务书的「## 已定方向」小节（一行一条：\`- 问题：结论\`），有针对本步的额外细则可写进「## 本步补充要求」；不要手工改写「项目规则」「文献来源」「项目知识」「本步骤脚本」「上一步产物」等由 Mesa 自动同步的小节。在同一条回复里用一句话说记下了什么，紧接着问下一个，不要停下来等我确认，我觉得不对会直接说。只有我的回答含糊、或你在我的话之外补了自己的解读时，才先问一句再写。\n` +
    `5. 一般收在 5–8 个决策点（含追问）就收住，达到上限后把剩余次要项合并记进「## 待拍板」即可收尾；我说「够了」也立刻停。最后列出已定的几条，没定下来的记到「## 待拍板」小节，需要跨步骤长期遵守的口径提醒我可以在界面点「记进项目知识」（不要自己改 .ccode/memory.md），并告诉我可以回 Mesa 点「开始」（照原样写「开始」带书名号，Mesa 会把它变成能点的入口）。\n` +
    `这一步可以从这些方向问起（按我的回答取舍，不必全问）：${focus.join("；")}。\n` +
    (settings.length ? `当前项目规则：${settings.join("；")}。\n` : "") +
    (open.length
      ? `项目规则里还有没定的全局设定，也在提问中问到：我确定一项（或明确推翻/调整已有全局设定），就同步把 .ccode/project.toml 的 settings 里对应那条改成定下来的话（「名称：我的答案」），不要改这个文件的其他内容。还没定的是：${open.join("；")}。\n`
      : settings.length
        ? `若我在讨论中明确调整或推翻了项目全局设定（如去向、目标篇幅、综述角度、文献数据抽取表等），请同步把 .ccode/project.toml 的 settings 里对应那条改成定下来的话（「名称：我的答案」），不要改这个文件的其他内容。\n`
        : "") +
    `只允许新建/修改这份任务书，以及上面允许的项目全局设定行，其他文件一律不要动。` +
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
