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

/** 选项下的白话说明与整题的小字注（按问题名；没有的不显示） */
export const SETTING_NOTES: Record<string, { options?: Record<string, string>; footnote?: string }> = {
  综述深度: {
    options: {
      标准档: "一条主检索式检索、筛选，不做引文扩展；多数综述够用",
      严格检索档: "另做引文扩展、分层筛选，并写检索披露，耗时明显更长",
    },
    footnote: "严格检索档仍不等于系统综述：系统综述要另定完整方法方案",
  },
  目标篇幅: {
    footnote: "这是读者预期，不是初稿必须凑到的词数",
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
