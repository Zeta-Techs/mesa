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
 * closed = 只能在给定选项里选（下游按选项原文判断，如检索步认「严格检索档」），不给「其他…」。
 */
export const SETTING_NOTES: Record<string, { options: Record<string, string>; closed?: boolean }> = {
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
  },
};

/** 选了这个选项时追问的一项（可不填）；填了并进同一行答案，如「投期刊（目标期刊：Chemical Reviews）」 */
export const SETTING_FOLLOW_UPS: Record<string, { option: string; label: string; placeholder: string }> = {
  去向: {
    option: "投期刊",
    label: "目标期刊（可选）",
    placeholder: "如 Chemical Reviews；AI 会对照它的篇幅与格式要求",
  },
};

export function answerWithFollowUp(q: string, answer: string, followUp: string): string {
  const fu = SETTING_FOLLOW_UPS[q];
  const extra = followUp.trim();
  if (!fu || answer.trim() !== fu.option || !extra) return answer;
  return `${answer.trim()}（目标期刊：${extra}）`;
}
