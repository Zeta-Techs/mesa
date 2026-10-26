import { WORK_MODE_LABEL, normalizeWorkMode } from "./work-mode.ts";
import { readableResearchToolSetting } from "./research-tool-fields.ts";

export type ContextPackEntry = {
  name: string;
  isDir: boolean;
};

export type AcceptedGoalPack = {
  name: string;
  outputs?: readonly string[];
  note?: string | null;
};

/** 项目技能在上下文包里的条目：digest = 库目录内容摘要（版本记录，审计 §4.9）。 */
export type ProjectSkillPack = {
  name: string;
  description?: string;
  digest?: string | null;
  inputs?: readonly string[];
  outputs?: readonly string[];
  /** true = 项目名单里有但技能库里没有（被删/未导入），如实标注不静默省略 */
  missing?: boolean;
  /** true = 本目标点名要用（新建目标时勾选）；false/缺省 = 项目技能池成员（可用但默认不用） */
  named?: boolean;
};

/** 有研究步骤的科研项目：技能以步骤挂载为准，不用项目技能池。
 *  无流程科研 / 办公 / 编程：池 + 目标点名。 */
export function projectUsesSkillPool(
  workMode?: string | null,
  stepCount = 0,
): boolean {
  return !(normalizeWorkMode(workMode) === "research" && stepCount > 0);
}

/** 「写回时跳过」是普通目标验收写回的合同。有研究步骤走评审合并，编程走工作树，界面都不展示。 */
export function projectShowsProtectedPaths(
  workMode?: string | null,
  stepCount = 0,
): boolean {
  const mode = normalizeWorkMode(workMode);
  if (mode === "coding") return false;
  return projectUsesSkillPool(mode, stepCount);
}

/** session = 项目页对话 / 问 AI（项目根，跟用户走）；goal = 隔离副本里的目标（验收后写回）。 */
export type ContextPackKind = "session" | "goal";

export function isGoalContextPack(
  kind?: ContextPackKind | null,
  writeReview?: boolean,
): boolean {
  return writeReview === true || kind !== "session";
}

export type ProjectContextInput = {
  name: string;
  path: string;
  workMode?: string | null;
  topic?: string | null;
  settings?: readonly string[];
  rulesOwned?: boolean;
  topLevel: readonly ContextPackEntry[];
  goal?: string | null;
  writeReview?: boolean;
  /** 缺省按目标包；会话入口必须显式传 session。验收后写入视为目标包。 */
  kind?: ContextPackKind;
  accepted?: readonly (string | AcceptedGoalPack)[];
  openGoals?: readonly string[];
  protectedPaths?: readonly string[];
  feedback?: string | null;
  /** 项目长期知识（.ccode/memory.md 全文；只含人确认过的结论） */
  memory?: string | null;
  skills?: readonly ProjectSkillPack[];
  /** Windows 上补「本机 Python」提示（纯模块不读平台，调用方显式传） */
  isWindows?: boolean;
};

/** Windows 本机 Python 的两条提示：开工任务书（task-md）与项目说明共用这一处。
 *  Mesa 补的 PYTHONIOENCODING 遇 -I / -E 失效，中文系统回落 GBK（2026-10-22 实测）。 */
export const WINDOWS_PYTHON_HINTS: readonly string[] = [
  "命令名用 `python`，不要用 `python3`（Windows 上的 `python3` 是应用商店占位程序，一运行就失败）。",
  "加了 `-I` 或 `-E` 时，Python 会忽略 Mesa 设好的 UTF-8 输出，打印中文或 Č、² 这类字符就报 `'gbk' codec can't encode`：这时同时加 `-X utf8`。它也会把 `open()` 的默认编码改成 UTF-8，读 GBK 文件要显式写 `encoding=\"gbk\"`。",
];

export function projectHomeHint(
  workMode?: string | null,
  kind: ContextPackKind = "goal",
): string[] {
  const mode = normalizeWorkMode(workMode);
  if (kind === "session") {
    // 「按用户这次说的做」归技能纪律一句说，这里只写环境事实和新文件放哪
    // （2026-10-26 实证：没交代放哪，Agent 翻了四个目录才决定总结图落点）
    const place =
      mode === "research"
        ? ["新生成的文件放进项目里已有的对应目录（如图放 figures/、分析放 analysis/），没有合适的就放 output/；不要散在项目根。"]
        : mode === "office"
          ? ["新生成的文件和项目里同类文件放在一起。"]
          : [];
    return ["这是项目里的对话，工作目录就是当前目录，不是隔离副本，改动直接生效。", ...place];
  }
  if (mode === "office") {
    return [
      "按项目里已有的文档风格写。",
      "产出放到目标指定的路径；验收后才进项目。",
      "如交付 PPT/PPTX 等幻灯，同时输出同名 PDF 供版式核对；如工具不支持，明确说明，不得冒称已完成预览验证。",
    ];
  }
  if (mode === "coding") {
    return ["只改当前工作树。", "不要切回主仓文件夹去改。"];
  }
  return [
    "按项目里已有的材料做。",
    "产出经人验收后才进项目。",
  ];
}

export function settingParts(line: string): { q: string; answer: string } {
  const src = line.trim();
  const i = src.indexOf("：");
  const j = i >= 0 ? i : src.indexOf(":");
  if (j < 0) return { q: src, answer: "" };
  return { q: src.slice(0, j).trim(), answer: src.slice(j + 1).trim() };
}

/** 「综述角度：（领域全景 / …）」这种空表格，不是已定规则。 */
export function isSettingPlaceholder(line: string): boolean {
  const { q, answer } = settingParts(line);
  if (q === line.trim()) return false;
  return (
    !answer ||
    (answer.startsWith("（") && answer.endsWith("）")) ||
    (answer.startsWith("(") && answer.endsWith(")"))
  );
}

function isFilledSettingLine(line: string): boolean {
  const { q, answer } = settingParts(line);
  return q !== line.trim() && !!answer && !isSettingPlaceholder(line);
}

/** Pack 里的「项目规则」：人改过就用档案卡；否则只带默认之外的设定。 */
export function packRuleLines(
  settings?: readonly string[] | null,
  workMode?: string | null,
  rulesOwned?: boolean,
): string[] {
  const saved = uniqueRuleLines(settings ?? []).filter(
    (line) => !isSettingPlaceholder(line),
  );
  const defaults = new Set(rulesOwned ? [] : defaultContextRules(workMode));
  return readableRuleLines(saved.filter((line) => !defaults.has(line)));
}

/** 给 AI 看的规则：档案卡机器键（科研工具/…）换成界面说法，认不出的工具键不带。
 *  只管渲染；规则面板编辑的仍是档案卡原文。 */
export function readableRuleLines(lines: readonly string[]): string[] {
  return uniqueRuleLines(
    lines.flatMap((line) => {
      const text = readableResearchToolSetting(line.trim());
      return text ? [text] : [];
    }),
  );
}

const MODE_RULES: Record<string, string[]> = {
  research: [
    "优先使用项目里已有的文件。",
    "不要改用户没让动的文件。",
  ],
  office: ["不要删除已有文件。", "按项目里已有的文档风格写。"],
  coding: ["只改当前工作目录。", "不要切回主仓文件夹去改。"],
};

export function defaultContextRules(workMode?: string | null): string[] {
  return MODE_RULES[normalizeWorkMode(workMode)] ?? MODE_RULES.research;
}

export function uniqueRuleLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const text = line.trim();
    if (!text || out.includes(text)) continue;
    out.push(text);
  }
  return out;
}

/** 人改过规则就只用档案卡；没改过则：有流程纪律用流程的，没有才用工作方式默认条。
 *  空表格（「问题：（选项）」）不进 TASK.md / 环境包。 */
export function effectiveProjectRules(
  settings?: readonly string[] | null,
  workMode?: string | null,
  rulesOwned?: boolean,
): string[] {
  const saved = uniqueRuleLines(settings ?? []).filter(
    (line) => !isSettingPlaceholder(line),
  );
  if (rulesOwned) return saved;
  const globals = saved.filter(isFilledSettingLine);
  const custom = saved.filter((line) => !isFilledSettingLine(line));
  const base = custom.length ? custom : defaultContextRules(workMode);
  return uniqueRuleLines([...base, ...globals]);
}

export function formatAcceptedGoalLine(goal: string | AcceptedGoalPack): string {
  if (typeof goal === "string") return `- ${goal}（已接受）`;
  const name = goal.name.trim();
  const outputs = (goal.outputs ?? [])
    .map((item) => item.trim())
    .filter((item) => item && item !== ".");
  const note = goal.note?.trim() ?? "";
  if (!name && !outputs.length) return "";
  let line = name || outputs.join("、");
  if (name && outputs.length) line = `${name} → ${outputs.join("、")}`;
  line += "（已接受）";
  if (note) line += `；意见：${note}`;
  return `- ${line}`;
}

/** 同一扩展名的文件达到这个数就折成一行：根目录散着几十篇 PDF 时，逐个列会把
 *  references.bib、outline.md 挤出上限（2026-10-26 实证：93 篇 PDF 列了 18 篇，bib 被挤掉）。 */
const FOLD_SAME_EXT_AT = 6;

function fileExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function formatTopLevelMap(
  entries: readonly ContextPackEntry[],
  limit = 24,
): string[] {
  const visible = entries.filter(
    (entry) =>
      entry.name !== ".git" &&
      entry.name !== ".ccode" &&
      entry.name !== "node_modules" &&
      entry.name !== "target",
  );
  const extCount = new Map<string, number>();
  for (const entry of visible) {
    const ext = entry.isDir ? "" : fileExt(entry.name);
    if (ext) extCount.set(ext, (extCount.get(ext) ?? 0) + 1);
  }
  const folded = (entry: ContextPackEntry) =>
    !entry.isDir && (extCount.get(fileExt(entry.name)) ?? 0) >= FOLD_SAME_EXT_AT;
  // 目录在前，再列不折叠的文件；折叠的同类文件各占一行计数，不占上限
  const listed = [
    ...visible.filter((entry) => entry.isDir),
    ...visible.filter((entry) => !entry.isDir && !folded(entry)),
  ];
  const shown = listed.slice(0, limit);
  const lines = shown.map((entry) =>
    entry.isDir ? `- ${entry.name}/` : `- ${entry.name}`,
  );
  if (listed.length > shown.length) {
    lines.push(`- … 还有 ${listed.length - shown.length} 项`);
  }
  for (const [ext, count] of extCount) {
    if (count >= FOLD_SAME_EXT_AT) {
      lines.push(`- 另有 ${count} 个 ${ext.toUpperCase()} 文件（未逐个列出）`);
    }
  }
  return lines.length ? lines : ["- （顶层还没有文件）"];
}

const GOAL_SKILL_DISCIPLINE =
  "技能纪律：只做目标要求的事，范围以目标为准。只有「本目标点名要用的技能」才按其规范执行；项目技能池和其他技能只是可用工具，目标不需要就一个都不用。简单任务直接做完，不要自行引入额外流程、模板或重型技能（如文献检索/精读/综述流程）。";

const SESSION_SKILL_DISCIPLINE =
  "技能纪律：按用户这次说的做，没说的不要自己开工。技能是可用工具，没点名就不用；不要自行套文献检索、精读或综述流程。";

/** 各段独立成块（含段头，空段为 ""）；自动包与自定义模板共用同一出处。
 *  字段顺序即包内版式，renderProjectContextPack / renderSessionInjection 都从这里取材。 */
type PackSections = {
  header: string;
  topLevel: string;
  topic: string;
  home: string;
  rules: string;
  protectedPaths: string;
  namedSkills: string;
  poolSkills: string;
  discipline: string;
  goal: string;
  memory: string;
  accepted: string;
  openGoals: string;
  feedback: string;
  permission: string;
  python: string;
};

function packSections(input: ProjectContextInput): PackSections {
  const mode = normalizeWorkMode(input.workMode);
  const isGoal = isGoalContextPack(input.kind, input.writeReview);
  const topic = input.topic?.trim();
  const home = projectHomeHint(mode, isGoal ? "goal" : "session");
  const rules = packRuleLines(input.settings, mode, input.rulesOwned);
  const protectedPaths = isGoal
    ? uniqueRuleLines(input.protectedPaths ?? [])
    : [];
  const skills = isGoal ? (input.skills ?? []) : [];
  const namedSkills = skills.filter((skill) => skill.named);
  const poolSkills = skills.filter((skill) => !skill.named);
  const renderSkill = (skill: (typeof skills)[number]) => {
    if (skill.missing) {
      return `- ${skill.name}（未安装，可在技能页新建或导入）`;
    }
    const version = skill.digest ? `（版本 ${skill.digest.slice(0, 8)}）` : "";
    const desc = skill.description?.trim();
    const contract = [
      skill.inputs?.length ? `读取 ${skill.inputs.join("、")}` : "",
      skill.outputs?.length ? `产出 ${skill.outputs.join("、")}` : "",
    ]
      .filter(Boolean)
      .join("；");
    return `- ${skill.name}${version}${desc ? `：${desc}` : ""}${contract ? `（${contract}）` : ""}`;
  };
  const memory = input.memory?.trim();
  const accepted = (input.accepted ?? [])
    .map((item) => formatAcceptedGoalLine(item))
    .filter(Boolean);
  const goal = isGoal ? input.goal?.trim() : undefined;
  const openGoals = isGoal
    ? uniqueRuleLines(input.openGoals ?? []).slice(0, 8)
    : [];
  const feedback = isGoal ? input.feedback?.trim() : undefined;
  return {
    header: [
      `你正在项目「${input.name.trim() || "未命名"}」中工作。`,
      `工作方式：${WORK_MODE_LABEL[mode]}`,
      `项目目录：${input.path}`,
    ].join("\n"),
    topLevel: ["项目里现有（顶层）：", ...formatTopLevelMap(input.topLevel)].join("\n"),
    topic: topic ? `课题主题：\n${topic}` : "",
    home: home.length
      ? ["工作环境：", ...home.map((line) => `- ${line}`)].join("\n")
      : "",
    rules: rules.length
      ? ["项目规则：", ...rules.map((rule, index) => `${index + 1}. ${rule}`)].join("\n")
      : "",
    protectedPaths: protectedPaths.length
      ? ["写回时跳过：", ...protectedPaths.map((path) => `- ${path}`)].join("\n")
      : "",
    namedSkills: namedSkills.length
      ? [
          "本目标点名要用的技能（按其规范执行；开工时记录内容版本）：",
          ...namedSkills.map(renderSkill),
        ].join("\n")
      : "",
    poolSkills: poolSkills.length
      ? [
          "项目技能池（可用工具，列出 ≠ 要用；本目标没点名的默认不用）：",
          ...poolSkills.map(renderSkill),
        ].join("\n")
      : "",
    // 技能分发在 CLI 全局目录里撤不掉；会话不列技能名单，只留一句别自行开工。
    discipline: isGoal ? GOAL_SKILL_DISCIPLINE : SESSION_SKILL_DISCIPLINE,
    goal: goal ? `当前目标：\n${goal}` : "",
    memory: memory
      ? [
          "项目长期知识（人确认过的结论，保持一致，不要与之矛盾）：",
          memory.length > 6000
            ? `${memory.slice(0, 6000)}\n…（已按最新有效知识优先；其余见 .ccode/memory.md，不应自行恢复已作废条目）`
            : memory,
        ].join("\n")
      : "",
    accepted: accepted.length
      ? ["已经验收过：", ...accepted.slice(0, 8)].join("\n")
      : "",
    openGoals: openGoals.length
      ? ["尚未完成：", ...openGoals.map((item) => `- ${item}`)].join("\n")
      : "",
    feedback: feedback ? `上一版的修改意见：\n${feedback}` : "",
    permission: input.writeReview
      ? "权限：只改当前工作目录。完成后不要修改项目原目录；改动会交给人验收再写回。"
      : "",
    python: input.isWindows
      ? ["本机 Python（Windows）：", ...WINDOWS_PYTHON_HINTS.map((line) => `- ${line}`)].join("\n")
      : "",
  };
}

/** 启动注入用的项目环境说明。纯函数；有流程开工的 TASK.md 仍走 renderTaskMd。 */
export function renderProjectContextPack(input: ProjectContextInput): string {
  const s = packSections(input);
  return [
    s.header,
    s.topLevel,
    s.topic,
    s.home,
    s.rules,
    s.protectedPaths,
    s.namedSkills,
    s.poolSkills,
    s.discipline,
    s.goal,
    s.memory,
    s.accepted,
    s.openGoals,
    s.feedback,
    s.permission,
    s.python,
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

// ===== 对话注入（2026-10-16 拍板）：＋新对话 / 问 AI 的 session 包可配置 =====

export type SessionInjectionMode = "auto" | "custom" | "off";

export const SESSION_INJECTION_MODES: readonly SessionInjectionMode[] = [
  "auto",
  "custom",
  "off",
];

/** 垃圾值一律回落 auto（现状行为），不阻断开对话。 */
export function normalizeSessionInjectionMode(
  value?: string | null,
): SessionInjectionMode {
  return SESSION_INJECTION_MODES.includes(value as SessionInjectionMode)
    ? (value as SessionInjectionMode)
    : "auto";
}

/** 自定义模板的占位符清单（设置面板插条与文档的单一出处）。
 *  块占位符渲染整段（含段头），对应段为空时整段省略。 */
export const SESSION_TEMPLATE_VARS: readonly {
  token: string;
  hint: string;
}[] = [
  { token: "{{项目名}}", hint: "项目显示名" },
  { token: "{{工作方式}}", hint: "科研 / 编程 / 工作" },
  { token: "{{项目目录}}", hint: "项目根绝对路径" },
  { token: "{{文件地图}}", hint: "顶层文件清单（上限 24 项）" },
  { token: "{{课题主题}}", hint: "档案卡课题主题，未填则整段省略" },
  { token: "{{工作环境}}", hint: "项目对话的环境提示" },
  { token: "{{项目规则}}", hint: "档案卡规则（编号）" },
  { token: "{{技能纪律}}", hint: "不自行套流程的纪律句" },
  { token: "{{长期知识}}", hint: "人确认过的结论（超长自动截断）" },
  { token: "{{已验收}}", hint: "已验收目标（上限 8 条）" },
];

/** 撤掉的占位符：旧模板里还写着，认得、渲染为空，但不再给插入/勾选。
 *  「人的决定」从没有数据来源（会话包、目标包都不传），2026-10-26 撤。 */
export const RETIRED_SESSION_TEMPLATE_KEYS: readonly string[] = ["人的决定"];

/** 占位符已知判定单一出处：渲染端替换与面板「未识别」点名共用，键先 trim
 *  （{{ 课题主题 }} 与 {{课题主题}} 同判）。只认清单内的键——顺带挡住普通对象
 *  查表命中 Object.prototype 原型链（{{constructor}} 一类）的坑。 */
export function isSessionTemplateKey(key: string): boolean {
  const trimmed = key.trim();
  return (
    RETIRED_SESSION_TEMPLATE_KEYS.includes(trimmed) ||
    SESSION_TEMPLATE_VARS.some((item) => item.token === `{{${trimmed}}}`)
  );
}

/** 默认模板 = 自动包版式的占位符表达；「填入默认模板」与 auto 渲染共用分块出处。 */
export const DEFAULT_SESSION_TEMPLATE = [
  "你正在项目「{{项目名}}」中工作。",
  "工作方式：{{工作方式}}",
  "项目目录：{{项目目录}}",
  "",
  "{{文件地图}}",
  "",
  "{{课题主题}}",
  "",
  "{{工作环境}}",
  "",
  "{{项目规则}}",
  "",
  "{{技能纪律}}",
  "",
  "{{长期知识}}",
  "",
  "{{已验收}}",
].join("\n");

/** 自定义会话注入：已知占位符按项目当时数据填入（goal 专属段不进占位符表），
 *  未知 {{…}} 原样保留（预览可见，不静默吞），空段消隐后连续空行折叠为一段。 */
/** 每个占位符在当前项目下填进去的内容（空段为 ""）。模板渲染与设置面板分段编辑器的
 *  逐段摘要共用这一出处，面板上看到的「这一段是什么」与实际注入不会分叉。 */
export function sessionTemplateValues(input: ProjectContextInput): Record<string, string> {
  const mode = normalizeWorkMode(input.workMode);
  const s = packSections(input);
  return {
    项目名: input.name.trim() || "未命名",
    工作方式: WORK_MODE_LABEL[mode],
    项目目录: input.path,
    文件地图: s.topLevel,
    课题主题: s.topic,
    工作环境: s.home,
    项目规则: s.rules,
    人的决定: "",
    技能纪律: s.discipline,
    长期知识: s.memory,
    已验收: s.accepted,
  };
}

/** 自定义模板同样在末尾带上 Windows 本机提示：这是平台必需的环境事实，不是可选段。 */
export function renderSessionInjection(
  template: string,
  input: ProjectContextInput,
): string {
  const blocks = sessionTemplateValues(input);
  const body = template
    .replace(/\{\{([^{}\n]+)\}\}/g, (whole, raw: string) => {
      const key = raw.trim();
      // 只换清单内的键：未知占位符原样保留，也不给原型链属性（constructor 等）开口子
      // （hasOwn 需要 ES2022 lib，这里用可移植写法）
      return isSessionTemplateKey(key) &&
        Object.prototype.hasOwnProperty.call(blocks, key)
        ? blocks[key]
        : whole;
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const python = packSections(input).python;
  return python ? (body ? `${body}\n\n${python}` : python) : body;
}

/** 上下文包与用户第一句话之间的分隔（工作台「上次停在」据此只取人话，改这里两边一起变） */
export const LAUNCH_PROMPT_SEPARATOR = "\n\n----\n\n";
/** 默认上下文包的开头（模板首行）：工作台据此认出「这条用户消息是 Mesa 自己塞的」 */
export const PROJECT_PACK_HEAD = "你正在项目「";

export function composeLaunchPrompt(
  pack: string,
  userPrompt?: string | null,
): string {
  const body = userPrompt?.trim() ?? "";
  if (!pack.trim()) return body;
  if (!body) return pack;
  return `${pack}${LAUNCH_PROMPT_SEPARATOR}${body}`;
}

/** 把第一句话里 Mesa 塞的项目上下文包和人说的话分开（聊天气泡、工作台「上次停在」只认人说的，2026-10-24 用户）。
 *  以默认包头开头才认：有分隔（单独一行 ----）取后面那段，没有分隔就整条都是包（只发了包）。
 *  自定义模板的包头认不出，照旧当人话——宁可偶尔显示包，不误删人话 */
export function splitLaunchPrompt(text: string): { pack: string | null; said: string } {
  if (!text.startsWith(PROJECT_PACK_HEAD)) return { pack: null, said: text };
  const sep = /\n[ \t]*----[ \t]*\r?\n/.exec(text);
  if (!sep) return { pack: text.trim(), said: "" };
  return {
    pack: text.slice(0, sep.index).trim(),
    said: text.slice(sep.index + sep[0].length).trim(),
  };
}
