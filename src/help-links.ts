/** 仓库与使用手册外链（仓库转 org 时与 tauri.conf updater endpoint、README 一起改，见 AGENTS.md 推送条） */
export const REPO_URL = "https://github.com/Zeta-Techs/mesa";

/** 使用手册某一节；anchor 按 GitHub 标题锚点规则写（如 8.1 聊天 / 终端 → 81-聊天--终端） */
export function userGuideUrl(anchor?: string): string {
  const base = `${REPO_URL}/blob/main/docs/guide/user-guide.md`;
  return anchor ? `${base}#${encodeURIComponent(anchor)}` : base;
}
