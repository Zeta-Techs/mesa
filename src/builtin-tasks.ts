/**
 * 内置科研任务（2026-11-05，docs/design-assistant-intake.md §5）：组会汇报、进展周报、实验规划；
 * 2026-11-08 加审改已有稿件（Word / EndNote），引文域只体检不改写（architecture §10 同日条）。
 *
 * 不是流程模板（选中会把整条流程换成一步），也不另做按钮或页面：项目助手起草派活单时按名点用
 * （「按任务：组会汇报」），新建目标时可选来当模板。做法写成一段通用的任务说明，具体时间范围、讲给谁听等
 * 由项目助手问清楚后写进单子。共同的科研通则见 project-assistant.ts RESEARCH_ORDER_RULES，这里不重复。
 * 纯数据 + 拼文字，配 tests/builtin-tasks.test.ts。
 */

export interface BuiltinTask {
  id: string;
  name: string;
  /** 能力清单里的一句：什么时候用 */
  summary: string;
  /** 起草前项目助手要问清的事（问不清写成假设） */
  clarify: string[];
  /** 做法 */
  method: string[];
  /** 交付物（相对项目根） */
  deliverables: string[];
  /** 怎样算做完 */
  done: string[];
  /** 点名的内置技能（技能库里没有的派出时跳过） */
  skills: string[];
}

export const BUILTIN_TASKS: readonly BuiltinTask[] = [
  {
    id: "group-meeting",
    name: "组会汇报",
    summary: "把一段时间的实验记录、数据和图整理成组会幻灯片与讲稿",
    clarify: ["讲哪段时间的工作", "讲多长时间", "讲给谁听（课题组内部 / 合作方 / 导师单独）", "重点想讨论的问题"],
    method: [
      "先读这段时间的实验记录和数据，列出做了什么、看到了什么、哪里没想通，再定故事线：背景一页、进展三到五页、问题与下一步一页。",
      "每页一个结论，结论下面写依据：哪条记录、哪个数据文件、哪张图。",
      "图只用项目里已有的，或用脚本从数据现画（脚本一起交）；不重画、不美化已有图的数据。",
      "专门留一页「想请大家讨论的问题」，把没想通的写成具体问题。",
      "讲稿写在每页的备注里，按讲的时长控制页数（大约一分半到两分钟一页）。",
    ],
    deliverables: ["output/group-meeting/<日期>/slides.html（或 .pptx）", "output/group-meeting/<日期>/sources.md（每页结论的出处清单）"],
    done: ["每页结论都能在 sources.md 里找到出处", "页数与时长相符", "有一页讨论问题"],
    skills: ["slides-deck", "figure-forge"],
  },
  {
    id: "progress-report",
    name: "进展周报",
    summary: "按时间段汇总实验记录与数据变化，写成给导师或自己看的进展报告",
    clarify: ["汇总哪段时间", "写给谁看（导师 / 自己 / 合作方）", "有没有固定格式要照着写"],
    method: [
      "只写这段时间里有记录的事：做了哪些实验、得到什么结果、出了什么异常、下一步打算。",
      "结果里的数字由脚本从数据算出（脚本一起交），不从记录里抄数字、不估算。",
      "异常和失败如实写，写清当时的条件和已知的可能原因，不下结论的标「待查」。",
      "最后列出需要导师或自己拍板的事。",
    ],
    deliverables: ["output/reports/<日期>-progress.md", "output/reports/<日期>-progress-scripts/（算数字的脚本）"],
    done: ["每条结果标出处（记录文件或数据文件）", "数字都能由交付的脚本重算出来", "有「需要拍板的事」一节（没有就写没有）"],
    skills: ["data-eda"],
  },
  {
    id: "experiment-plan",
    name: "实验规划",
    summary: "根据已有结果和问题，给出下一轮实验的几个候选方案供人选",
    clarify: ["要回答的问题是什么", "有哪些限制（设备、样本、经费、时间、伦理审批）", "已经排除了哪些做法"],
    method: [
      "先写清现在知道什么、不知道什么（引用记录和数据），以及这一轮要回答的问题。",
      "给两到三个候选方案，每个写：要改变的变量与控制条件、对照怎么设、需要的样本量（写明按什么效应量和检验估的）、要多久、主要风险。",
      "写明每个方案依赖的假设，哪些假设已有依据、哪些还没验证。",
      "列出需要人定的变量，不替人选方案，不写「建议采用」。",
    ],
    deliverables: ["output/plans/<日期>-experiment-plan.md"],
    done: ["至少两个候选方案", "每个方案有样本量依据和风险", "单列「需要你来定的」"],
    skills: ["stats-check"],
  },
  {
    id: "manuscript-revision",
    name: "审改已有稿件",
    summary: "在导师改过、合作者发来或自己以前写的 Word 稿上接着改：读出标黄、修订和批注，按要求改文字；EndNote 引文只体检、出修改清单，不动引文域",
    clarify: [
      "交付哪种形式（修订模式加批注 / 直接改并把改动标黄）",
      "改哪些部分、改到什么程度（只改标黄处 / 通改语言 / 也查逻辑和数字）",
      "修订和文档属性里署谁的名字",
      "要投哪本期刊（决定拼写、格式和篇幅）",
    ],
    method: [
      "先用 endnote-bridge 的 `audit_docx.py marks <稿件>` 读出标黄、修订、批注和文档里留下的名字，列成待改清单；同目录有 `~$` 开头的锁文件说明稿件正在 Word 里打开，提醒人先关掉。",
      "原稿只读：改动另存成新文件（原文件名加版本号），不覆盖原稿，也不覆盖人在 Word 里开着的那份。",
      "引文只体检：跑 `audit_docx.py cites <稿件>`，点名作者对不上、域数据损坏、混用两个库、编号要 Update 的写进「在 EndNote 里怎么改」清单；引文域原样留在原位，不重编号、不增删引文、不改参考文献表，换文献由人在 EndNote 里做。",
      "改文字按 review-writing 阶段三（实证论文按 research-writing）：只改表达不改观点；补写一段后回读前后两段；带数字的句子回原文核对，没有全文先查开放摘要，还说不清就列出论文标题和 DOI 请人给 PDF，不凭印象补数。",
      "按约定的形式交付：修订模式时每条修订署约定的名字、批注写清理由；直接改时改过的文字标黄，原有的标黄保留。",
      "交付前对新文件再跑一次 `marks` 和 `cites`：直接改的版本修订、批注为 0，文档属性和署名里没有别人或 AI 工具的名字；引文域与原稿一致、没有新增拦下；再转成 PDF 翻一遍版面。",
    ],
    deliverables: [
      "output/revised/<原文件名>-v<版本号>.docx（改好的新版本，原稿不动）",
      "output/endnote-audit.md（在 EndNote 里怎么改）",
      "output/revised/revision-notes.md（改了哪些地方、核过哪些数字、哪些等你定）",
    ],
    done: [
      "原稿没有任何改动，改动都在新版本里",
      "引文域与原稿一致，`cites` 体检没有新增拦下",
      "交付形式与约定一致：修订署名正确，或改动全部标黄且没有残留修订和批注",
      "EndNote 清单每条都写明在哪一段、改成什么",
    ],
    skills: ["endnote-bridge", "review-writing", "bib-check"],
  },
  {
    id: "rebuttal",
    name: "审稿意见回复",
    summary: "把审稿意见逐条编号分级，起草回复信（Response Letter）与修改对照表；未经明确要求不直接改原稿",
    clarify: [
      "审稿意见原件在项目里的哪个文件（或直接贴在消息里）",
      "这次是大修还是小修、返修截止日期",
      "有没有明确不能补做或准备礼貌反驳的条目",
      "本轮先只出回复信草稿与修改对照表，还是同步改一份稿件副本",
    ],
    method: [
      "先把全部审稿人与编辑意见逐条编号（R1-1、R1-2…）并按类别和严重度分级，一条不漏，先定大修/小修应对策略。",
      "每条明确归为「接受修改 / 部分接受 / 礼貌反驳」三型之一；审稿人漏看的按正文呈现不够清晰处理，不带情绪，反驳只用项目已有数据与文献证据。",
      "产出逐条修改对照表与 Response Letter 草稿，核对回复信里的每一句承诺与对照表双向一致，写清需要改动的原稿章节与具体改法。",
      "除非用户明确要求同步改稿，否则不直接修改项目原稿；若需新增引用，先查实并记进 references.bib，收尾跑引用闭环检查。",
    ],
    deliverables: [
      "output/rebuttal/<日期>-response-letter.md（逐条回复信草稿）",
      "output/rebuttal/<日期>-revision-matrix.md（审稿意见分级与修改对照表）",
    ],
    done: [
      "所有审稿人及编辑意见逐条编号覆盖，无遗漏",
      "回复信承诺与修改对照表逐条双向核对一致",
      "未擅自改动项目原稿，反驳与补充依据均可回溯到项目文件或引文库",
    ],
    skills: ["rebuttal-crafter", "review-writing", "bib-check"],
  },
  {
    id: "submission-pack",
    name: "换刊适配与投稿材料",
    summary: "基于项目已有终稿，按目标期刊要求整理 Cover Letter、Highlights、投稿声明与格式核对清单，不覆盖原稿",
    clarify: [
      "目标期刊名称（及字数、图表数、摘要或参考文献格式限制）",
      "基于项目里哪一份终稿来整理",
      "通讯作者、基金号、利益冲突或推荐审稿人有哪些要补进去",
      "要不要同时按新期刊样式另导出阅读版 PDF / Word",
    ],
    method: [
      "先核对已有终稿的字数、摘要长度、图表数量、引用格式与目标期刊要求之间的差距，列成逐项投稿核对清单。",
      "基于终稿内容起草 Cover Letter 与 Highlights（每条卖点和数字均回对终稿与数据，不夸大、不编造新结果）。",
      "整理作者、单位、基金、利益冲突、数据与 AI 使用声明等投稿必备材料；项目里还没填的真实信息显式标 `[待填]`，不代填。",
      "原稿只读：如需按新期刊调整格式或重渲，另存到 `output/submission/` 下，并做一次引用与参考文献闭环核对。",
    ],
    deliverables: [
      "output/submission/<期刊>-cover-letter.md",
      "output/submission/<期刊>-highlights.md",
      "output/submission/<期刊>-checklist.md（格式差距与投稿前待办清单）",
    ],
    done: [
      "Cover Letter 与 Highlights 中的数字与核心结论和终稿一致",
      "缺失的作者/基金/许可信息明确标 `[待填]`，无编造内容",
      "项目原稿未被覆盖，格式与篇幅差距逐条列出",
    ],
    skills: ["review-writing", "bib-check", "quarto-render"],
  },
];

export function findBuiltinTask(name: string): BuiltinTask | null {
  const key = name.replace(/[「」『』"“”\s]/g, "").replace(/^内置任务/, "");
  return BUILTIN_TASKS.find((t) => t.name === key || t.id === key) ?? null;
}

/** 能力清单里这一类的几行 */
export function builtinTaskCatalogLines(): string[] {
  return BUILTIN_TASKS.map(
    (t) => `- 内置任务「${t.name}」：${t.summary}（起草前要问清：${t.clarify.join("、")}；交付默认放在 ${t.deliverables.join("、")}）`,
  );
}

/** 按内置任务做时，派活单里附上的做法 */
export function builtinTaskMethod(task: BuiltinTask): string {
  return [
    `按内置任务「${task.name}」的做法：`,
    ...task.method.map((m, i) => `${i + 1}. ${m}`),
    `交付：${task.deliverables.join("；")}`,
    `怎样算做完：${task.done.join("；")}`,
  ].join("\n");
}

/** 新建目标选它当模板时填进「要完成什么」的文字 */
export function builtinTaskGoalText(task: BuiltinTask): string {
  return [
    task.summary,
    "",
    `先写清：${task.clarify.join("；")}。`,
    "",
    builtinTaskMethod(task),
    "",
    `（按内置任务「${task.name}」记下）`,
  ].join("\n");
}
