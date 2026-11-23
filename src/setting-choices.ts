/**
 * 模板全局设定的填写形态（2026-11-04 用户拍板：选择题改点选）。
 * 设定行仍是「问题：（A / B / C）」一行文字（项目规则里的空位、下游读法都不变）；
 * 括号里是几个短选项时，填写屏把它们画成可点的选项，另加「其他…」自填；
 * 括号里是说明或示例（含标点、以「如」开头）时照旧是输入框。
 */

export interface SettingField {
  q: string;
  hint: string;
  /** 可点选的选项；null = 自由填写 */
  options: string[] | null;
}

const MAX_OPTION_LEN = 12;

export function parseSettingLine(line: string): SettingField {
  const trimmed = line.trim();
  const i = trimmed.indexOf("：");
  if (i < 0) return { q: trimmed, hint: "", options: null };
  const q = trimmed.slice(0, i);
  const hint = trimmed.slice(i + 1).replace(/^（|）$/g, "");
  return { q, hint, options: choicesFromHint(hint) };
}

function choicesFromHint(hint: string): string[] | null {
  if (!hint || /^如/.test(hint)) return null;
  const parts = hint.split(" / ").map((p) => p.trim());
  if (parts.length < 2 || parts.length > 5) return null;
  if (parts.some((p) => !p || p.length > MAX_OPTION_LEN || /[；，。、;,]/.test(p))) return null;
  return parts;
}

/**
 * 选项卡片上的一行白话（按问题名；有说明的题画成带说明的卡片）。这里是给人看的，
 * 写「选了会怎样」，不写给 AI 的纪律（「篇幅不是凑数」「严格检索不是系统综述」在任务书和技能里）。
 * closed = 只能在给定选项里选（下游按选项原文判断，如检索步认「严格检索档」），不给自定义项。
 * custom = 非 closed 卡片题的通栏自定义卡片文案（如文献数据抽取表的「自己指定列…」）。
 */
export interface SettingNotesDef {
  options: Record<string, string>;
  closed?: boolean;
  custom?: { label: string; note?: string; placeholder?: string };
}

export const SETTING_NOTES: Record<string, SettingNotesDef> = {
  综述深度: {
    options: {
      标准档: "以一个主要文献库检索，逐篇筛选。适合大多数综述",
      严格检索档: "再顺着已选文献的参考文献和被引文献补查，并记下完整检索过程。适合要写检索方法的投稿，耗时明显更长",
    },
    closed: true,
  },
  文献数据抽取表: {
    options: {
      "让 AI 提议列": "精读开工时 AI 按课题提议 6–10 列（含单位与测试条件）问你一次，你定了才开始填。适合要做性能对照表的定量领域",
      不需要: "不建抽取表，对照表照旧回笔记里找数",
    },
    custom: {
      label: "自己指定列…",
      note: "直接写出要抽取的指标列，精读时照表逐篇填",
      placeholder: "如 催化剂、过电位@10 mA/cm²、Tafel 斜率、稳定性",
    },
  },
};

/** 点选「其他…」时按问题给的输入框提示（未列出的题回落到「写你自己的答案」） */
export const SETTING_CUSTOM_PLACEHOLDERS: Record<string, string> = {
  去向: "如 会议特邀综述 / 课题组内部报告",
  综述角度: "如 聚焦近五年原位表征在 HER 机制中的应用",
  读者与文风: "如 偏方法对比，兼顾刚进方向的研究生",
  目标篇幅: "如 约 5000 词 / 12 页双栏",
};

export function customPlaceholderFor(q: string): string {
  return SETTING_NOTES[q]?.custom?.placeholder ?? SETTING_CUSTOM_PLACEHOLDERS[q] ?? "写你自己的答案";
}

/** 选了这个选项时追问的一项（可不填）；填了按 tag 并进同一行答案，如「投期刊（目标期刊：Chemical Reviews）」 */
export interface SettingFollowUpDef {
  option: string;
  label: string;
  tag: string;
  placeholder: string;
}

export const SETTING_FOLLOW_UPS: Record<string, SettingFollowUpDef> = {
  去向: {
    option: "投期刊",
    label: "目标期刊（可选）",
    tag: "目标期刊",
    placeholder: "如 Chemical Reviews；AI 会对照它的篇幅与格式要求",
  },
  综述角度: {
    option: "聚焦某个子问题",
    label: "具体聚焦什么（可选）",
    tag: "具体",
    placeholder: "如 酸性介质下非贵金属催化剂的稳定性",
  },
};

export function answerWithFollowUp(q: string, answer: string, followUp: string): string {
  const fu = SETTING_FOLLOW_UPS[q];
  const extra = followUp.trim();
  if (!fu || answer.trim() !== fu.option || !extra) return answer;
  return `${answer.trim()}（${fu.tag}：${extra}）`;
}

/** 非期刊去向时隐藏「按期刊要求」，避免去向与目标篇幅冲突 */
const NON_JOURNAL_DESTINATIONS = new Set(["毕业论文一章", "课程作业"]);

export function isSettingOptionHidden(
  q: string,
  opt: string,
  answersByQ: Readonly<Record<string, string>>,
): boolean {
  if (q === "目标篇幅" && opt === "按期刊要求") {
    return NON_JOURNAL_DESTINATIONS.has((answersByQ["去向"] ?? "").trim());
  }
  return false;
}
