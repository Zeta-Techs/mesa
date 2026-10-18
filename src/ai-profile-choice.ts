/** 设置页「AI 专用配置」：一条配置的每个模型各占一个选项。 */

export interface AiProfileChoiceSource {
  id: string;
  name: string;
  agent: string;
  models: string[];
}

export interface AiProfileChoice {
  value: string;
  label: string;
  profileId: string;
  model: string;
}

/** 配置 id 与模型名之间的分隔。两边都可能含普通标点，用不可见分隔符。 */
const SEP = "\u001f";

/** agentLabel：把内部 id（claude-code）换成展示名（Claude Code）；不传则原样显示 id */
export function aiProfileChoices(
  profiles: AiProfileChoiceSource[],
  agentLabel: (agentId: string) => string = (id) => id,
): AiProfileChoice[] {
  const out: AiProfileChoice[] = [];
  for (const profile of profiles) {
    const models = profile.models.map((m) => m.trim()).filter(Boolean);
    const agent = agentLabel(profile.agent);
    const head = profile.name.trim()
      ? `${profile.name.trim()}（${agent}`
      : `（${agent}`;
    if (models.length === 0) {
      out.push({
        value: profile.id,
        label: `${head}）`,
        profileId: profile.id,
        model: "",
      });
      continue;
    }
    for (const model of models) {
      out.push({
        value: `${profile.id}${SEP}${model}`,
        label: `${head} · ${model}）`,
        profileId: profile.id,
        model,
      });
    }
  }
  return out;
}

export function parseAiProfileChoice(value: string): {
  profileId: string;
  model: string;
} {
  const at = value.indexOf(SEP);
  if (at < 0) return { profileId: value, model: "" };
  return { profileId: value.slice(0, at), model: value.slice(at + SEP.length) };
}

/** 下拉当前值。配置还没加载到时保留已存的 id/模型，避免闪成「自动」。 */
export function selectedAiProfileChoice(
  profileId: string | null | undefined,
  model: string | null | undefined,
  profiles: AiProfileChoiceSource[],
): string {
  if (!profileId) return "";
  const choices = aiProfileChoices(profiles.filter((p) => p.id === profileId));
  if (choices.length === 0) {
    const kept = model?.trim() ?? "";
    return kept ? `${profileId}${SEP}${kept}` : profileId;
  }
  const wanted = model?.trim() ?? "";
  return (choices.find((c) => c.model === wanted) ?? choices[0]).value;
}
