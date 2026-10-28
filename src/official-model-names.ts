/** 官方账号模型别名 → 当前对应的完整型号（2026-10-28 用户：Claude 官方账号要看到具体模型名）。纯逻辑，tests/official-model-names.test.ts。
 *  只用于显示：启动时照旧传别名，由 CLI 自己换成当时最新的型号，这张表随 CLI 升级可能过时。
 *  实测口径：Claude Code 2.1.308，假网关收到的 model 字段（opus / sonnet / haiku / fable / default 各起一次）。
 *  default 随账号与套餐变，不给完整型号。CLI 升级后照此重测，改这张表。 */

const ALIASES: Record<string, Record<string, string>> = {
  "claude-code": {
    fable: "claude-fable-5-1",
    opus: "claude-opus-5-5",
    sonnet: "claude-sonnet-5-5",
    haiku: "claude-haiku-5-5",
  },
};

/** 模型列显示什么、悬停说什么。没收录的原样显示 */
export function officialModelLabel(agent: string, model: string): { text: string; tip: string } {
  if (agent === "claude-code" && model === "default") {
    return { text: "CLI 默认", tip: "default：不指定模型，用 Claude Code 按你的账号选的默认模型" };
  }
  const full = ALIASES[agent]?.[model];
  if (!full) return { text: model, tip: model };
  return {
    text: full,
    tip: `${full}（启动时传简称 ${model}，由 CLI 换成当时最新的型号；CLI 升级后可能变）`,
  };
}
