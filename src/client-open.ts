/**
 * 客户端接力的前端纯逻辑（后端是 client_open.rs；设计见 docs/design-client-handoff.md）。
 * 深链拼接与预检全在后端，这里只管：目标怎么传、预检结果要不要弹确认层、弹层里怎么排序和用什么文案。
 */

export type ClientOpenTarget =
  | {
      kind: "session";
      agent: string;
      sessionId: string;
      filePath: string | null;
      provider: string | null;
      profileId: string | null;
      liveInMesa: boolean;
    }
  | { kind: "project"; path: string };

export interface ClientInfoDto {
  clientId: string;
  agent: string;
  display: string;
  installed: boolean;
  version: string | null;
  canSession: boolean;
  canProject: boolean;
  downloadUrl: string | null;
  reason: string | null;
}

export type CheckStatus = "ok" | "note" | "warn" | "fix" | "block";

export interface HandoffCheckDto {
  id: string;
  status: CheckStatus;
  text: string;
}

export interface HandoffCandidateDto {
  profileId: string;
  name: string;
  keyHint: string | null;
}

export interface HandoffFixDto {
  kind: string;
  blockName: string;
  candidates: HandoffCandidateDto[];
}

export interface HandoffPlanDto {
  clientId: string;
  display: string;
  level: "session" | "project";
  verdict: "ready" | "needsFix" | "blocked";
  checks: HandoffCheckDto[];
  fix: HandoffFixDto | null;
  downloadUrl: string | null;
}

export function sessionTarget(
  s: {
    agent: string;
    sessionId: string;
    filePath?: string | null;
    provider?: string | null;
    profileId?: string | null;
  },
  liveInMesa: boolean,
): ClientOpenTarget {
  return {
    kind: "session",
    agent: s.agent,
    sessionId: s.sessionId,
    filePath: s.filePath ?? null,
    provider: s.provider ?? null,
    profileId: s.profileId ?? null,
    liveInMesa,
  };
}

/** 只有「全部通过」才免弹层直接打开；任何要让用户知道的事（提示/警告/修复/拦截）都先展示 */
export function needsDialog(plan: HandoffPlanDto): boolean {
  return plan.verdict !== "ready" || plan.checks.some((c) => c.status !== "ok");
}

const STATUS_ORDER: Record<CheckStatus, number> = {
  block: 0,
  fix: 1,
  warn: 2,
  note: 3,
  ok: 4,
};

/** 弹层里的检查项顺序：拦截 > 待修复 > 警告 > 提示 > 通过，同级保持后端给的顺序 */
export function sortChecks(checks: HandoffCheckDto[]): HandoffCheckDto[] {
  return checks
    .map((c, i) => ({ c, i }))
    .sort((a, b) => STATUS_ORDER[a.c.status] - STATUS_ORDER[b.c.status] || a.i - b.i)
    .map((x) => x.c);
}

export interface PrimaryAction {
  label: string;
  /** false = 没有可执行的主动作（只能关闭 / 去下载） */
  enabled: boolean;
}

/** 弹层主按钮：被拦下没有主动作；要修复写明会写盘；只有警告才用「仍然打开」 */
export function primaryAction(plan: HandoffPlanDto): PrimaryAction {
  if (plan.verdict === "blocked") return { label: "", enabled: false };
  if (plan.verdict === "needsFix") return { label: "写入并打开", enabled: true };
  if (plan.checks.some((c) => c.status === "warn"))
    return { label: "仍然打开", enabled: true };
  return { label: "打开", enabled: true };
}

export function dialogTitle(plan: HandoffPlanDto): string {
  return plan.level === "session"
    ? `在 ${plan.display}打开这条对话`
    : `在 ${plan.display}打开项目`;
}

/** 按钮文案：项目级写明只开项目，不冒充能定位到对话 */
export function openButtonLabel(
  client: Pick<ClientInfoDto, "display">,
  level: "session" | "project",
): string {
  return level === "session"
    ? `在 ${client.display}打开`
    : `在 ${client.display}打开项目`;
}

/** 客户端发起后 Mesa 看不到它那边的失败，弹层里固定提醒这一句 */
export function afterOpenHint(display: string): string {
  return `打开后如果 ${display}提示登录或网络问题，在它里面处理完再点一次；客户端那边的报错 Mesa 看不到。`;
}
