/**
 * 科研工作区评审：把任务改动写入项目主线的白话。
 * 不是编程「合进基准」，也不是「科研验收决定」。
 */

export function reviewSavePrimaryLabel(input: {
  hasUncommitted: boolean;
  hasCommitted: boolean;
  mergedAt?: string | null;
}): string {
  if (input.hasUncommitted) return "提交并保存进项目";
  if (input.hasCommitted) return "保存进项目";
  if (input.mergedAt) return "已保存进项目";
  return "无待保存提交";
}

export function historyWorkspaceSaveTitle(stepOrWorkspace: string): string {
  return `保存进项目：${stepOrWorkspace}`;
}

export const REVIEW_SAVE = {
  action: "保存进项目",
  commitThenSave: "提交并保存进项目",
  done: "已保存进项目",
  keepWorkspace: "保存进项目（保留工作区）",
  saveAndArchive: "保存进项目并归档",
  finishConflict: "完成解决并保存进项目",
  localOnlyHint: "默认只保存进本地项目并保留工作区；不会自动推送远程",
  footerReady: "从右上角提交或保存进项目",
  confirmSave: (willCommit: boolean, archive: boolean) =>
    `${willCommit ? "将提交当前全部改动，然后" : "将"}保存进项目${
      archive ? "并归档工作区" : "（保留工作区）"
    }。继续？`,
  cannotSaveYet: (reasons: string) =>
    `提交已完成，但尚不可保存进项目：${reasons || "健康检查未通过"}`,
  readonlyRun: "定时 Run 只能只读评审，不能在此提交、保存进项目或归档",
  needDelivery: "非 Git 产物尚未完成评审，请先刷新并查看后再保存进项目",
  ledgerPending: "文件已进入项目，产物接收或验收记录尚未完成",
  reviewNodeLabel: "你核对后，保存进项目",
  // 讲按钮没说的两件事：保存后流程线自己跳到下一步；不满意怎么退（2026-11-05 用户「跑完了一个节点就不会弄了」）
  reviewHintReady: "核对改动与产物，满意就保存进项目，流程线随即跳到下一步；不满意在评审里写上意见、退回修改，AI 按意见接着改",
  reviewHintActive: "AI 提交产出后，回来核对并保存进项目",
  workspaceReady: "已有提交，可在评审中保存进项目。",
  workspaceDone: "已保存进项目；有新提交后可再次评审。",
  workspaceIdle: "当前没有待提交或待保存进项目的改动。",
  artifactRootMerged: "主文件夹（已保存进项目）",
} as const;
