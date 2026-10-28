/** 官方账号模型别名的显示（2026-10-28 用户：Claude 官方账号要看到具体模型名，且别靠写死的对照表）。纯逻辑，tests/official-model-names.test.ts。
 *  对照表由后端按本机 CLI 版本实测（model_aliases.rs：本机假接口记下 `claude -p --model opus` 实际请求的型号），
 *  CLI 升级后自动重测；这里只负责显示。启动时照旧传别名，由 CLI 自己换算。没测出来就原样显示别名，不猜 */

/** {agent: {别名: 完整型号}}，后端 official_model_aliases 给 */
export type OfficialAliasTable = Record<string, Record<string, string>>;

/** 模型列显示什么、悬停说什么 */
export function officialModelLabel(
  agent: string,
  model: string,
  aliases: OfficialAliasTable,
): { text: string; tip: string } {
  if (agent === "claude-code" && model === "default") {
    return { text: "CLI 默认", tip: "default：不指定模型，用 Claude Code 按你的账号选的默认模型" };
  }
  const full = aliases[agent]?.[model];
  if (!full) return { text: model, tip: model };
  return {
    text: full,
    tip: `${full}（启动时传简称 ${model}，由 CLI 换成当时最新的型号；本机这一版 CLI 实测）`,
  };
}
