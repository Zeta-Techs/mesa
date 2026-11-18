/**
 * 项目体检的前端口径（docs/design-project-doctor.md）：入口动手前先问后端 workspace_doctor，
 * 替人处理掉的说一句，还拦着的弹体检框让人点出口。纯逻辑在这里（有单测），弹框在 components/DoctorDialog.tsx。
 */

export type DoctorIntent = "review" | "save" | "round" | "archive" | "restore";

export interface DoctorFix {
  kind: "click" | "goto";
  label: string;
  confirm?: string;
  target?: string;
}

export interface DoctorFinding {
  code: string;
  text: string;
  blocks: boolean;
  fix?: DoctorFix;
}

export interface DoctorReport {
  fixed: string[];
  findings: DoctorFinding[];
}

/** 拦人的排前面；同为拦 / 不拦的保持后端给的顺序（后端按「先修地基再修上面」排） */
export function orderFindings(findings: readonly DoctorFinding[]): DoctorFinding[] {
  return [...findings.filter((f) => f.blocks), ...findings.filter((f) => !f.blocks)];
}

export function isBlocked(report: DoctorReport): boolean {
  return report.findings.some((f) => f.blocks);
}

/** goto 出口不在体检框里处理：告诉人去哪处理（框关掉后照这句提示） */
export function gotoHint(fix: DoctorFix, stepName: string): string {
  switch (fix.target) {
    case "review":
      return `到「${stepName}」这一步点「去评审」，在评审页「${fix.label}」。`;
    case "main-commit":
      return `到「${stepName}」这一步的评审页，点顶上的「提交项目文件夹的改动…」。`;
    case "workspaces":
      return "到侧栏「工作区」页，在这一步那一行点「重新定位」，选项目文件夹现在的位置。";
    default:
      return fix.label;
  }
}

/** 评审页自己已有处理入口的状态（冲突选边、提交面板、放弃 / 切回按钮），体检条不重复列 */
export const REVIEW_HANDLED_CODES: ReadonlySet<string> = new Set([
  "main_unfinished",
  "main_off_base",
  "main_dirty",
  "worktree_conflict",
]);

/** 同一入口刚体检过、什么都不拦时短时间内不再跑（开一轮的编排会连着经过两三处闸门） */
const PASS_TTL_MS = 5000;
const passed = new Map<string, number>();

export function recentlyPassed(workspaceId: string, intent: DoctorIntent, now = Date.now()): boolean {
  const at = passed.get(`${workspaceId}:${intent}`);
  return at !== undefined && now - at < PASS_TTL_MS;
}

export function rememberPass(workspaceId: string, intent: DoctorIntent, now = Date.now()): void {
  passed.set(`${workspaceId}:${intent}`, now);
}

export function forgetPasses(): void {
  passed.clear();
}
