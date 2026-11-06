/**
 * 研究流程编辑器的步骤草稿与写回口径（从 PipelineEditor 拆出）：toDraft 把步骤摊成编辑态，toStep 按保存时的口径收回
 * （验收条件按换行与分号切开、人工事项补空落点与完成判定、决策暂停策略缺省 auto_continue 等）。
 * canonicalStep = 两者来回一趟：模板更新比较两边都先过它，只剩真改动，不把写法差异报成更新。
 */
import { normalizeCompletion } from "./human-task-completion.ts";
import type { HumanTaskDto, ProjectStepDto, ProjectStepRunDto, StepCheckDto, StepFanOutDto, StepParamDto } from "./types";

/** 与后端 sanitize 一致：非 [A-Za-z0-9-] → -，去掉首尾 - */
export function sanitizeWsName(name: string): string {
  return name.replace(/[^A-Za-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
}

/** 编辑器内的步骤草稿：预期产物/输入依赖用逗号分隔文本编辑，保存时再归一化为数组 */
export type StepDraft = {
  name: string;
  workspaceName: string;
  brief: string;
  artifactsText: string;
  acceptanceText: string;
  decisionMode: string;
  inputsText: string;
  optionalInputsText: string;
  /** 每行一组，组内用 | 分隔，表示任一项满足即可 */
  anyOfInputsText: string;
  skills: string[];
  requiredSkills: string[];
  run: ProjectStepRunDto[];
  /** 勾选中的资源绑定（path）；空 = 不绑定 = 使用项目全部资源 */
  resources: string[];
  /** 人工事项编辑态（人机分工清单） */
  humanTasks: HumanTaskDto[];
  /** 讨论种子编辑态：每行一条 */
  discussionSeeds: string[];
  /** 决策项编辑态：options 用逗号分隔的文本（同 artifactsText 口径） */
  decisions: { q: string; optionsText: string }[];
  /** 这一步要先拍板文献从哪来（流程线「定方向」出现输入准备块） */
  asksLitSource: boolean;
  seedComplete: boolean;
  /** 任务包溯源与参数（2026-11-03）：编辑器只改取值，保存时原样带回，免得一保存就丢 */
  pack: string;
  params: StepParamDto[];
  /** 任务包核验（第三期）：编辑器只展示、原样带回 */
  checks: StepCheckDto[];
  /** 人机角色（you / both，空 = AI 做）与按数据分路：编辑器不改，原样带回——
   *  2026-11-06 前漏带，一保存就丢（HER 实证：角色徽标与精读分路都没了） */
  role: string;
  fanOut: StepFanOutDto | null;
};

export function toDraft(s: ProjectStepDto): StepDraft {
  return {
    name: s.name,
    workspaceName: s.workspaceName,
    brief: s.brief,
    artifactsText: s.expectedArtifacts.join(", "),
    acceptanceText: (s.acceptanceCriteria ?? []).join("\n"),
    decisionMode: s.decisionMode ?? "auto_continue",
    inputsText: (s.inputs ?? []).join(", "),
    optionalInputsText: (s.optionalInputs ?? []).join(", "),
    anyOfInputsText: (s.anyOfInputs ?? []).map((group) => group.join(" | ")).join("; "),
    skills: [...s.skills],
    // 旧配置没有 required_skills 时，挂载技能沿用历史“全部执行”语义。
    requiredSkills: [...(s.requiredSkills ?? s.skills)],
    run: s.run.map((r) => ({ ...r })),
    resources: [...(s.resources ?? [])],
    humanTasks: (s.humanTasks ?? []).map((t) => ({ ...t })),
    discussionSeeds: [...(s.discussionSeeds ?? [])],
    decisions: (s.decisions ?? []).map((d) => ({
      q: d.q,
      optionsText: d.options.join(", "),
    })),
    asksLitSource: s.asksLitSource ?? false,
    seedComplete: s.seedComplete ?? false,
    pack: s.pack ?? "",
    params: (s.params ?? []).map((p) => ({ ...p, options: [...p.options] })),
    checks: (s.checks ?? []).map((c) => ({ ...c })),
    role: s.role ?? "",
    fanOut: s.fanOut ? { ...s.fanOut } : null,
  };
}

/** 草稿 → 写回的步骤：名称去空白、工作区名留空时按步骤名派生、产物按中英文逗号切分、run 丢弃缺名称/命令的行、
 *  人工事项丢弃标题空白的行并 trim 各字段 */
export function toStep(d: StepDraft, index: number): ProjectStepDto {
  const name = d.name.trim();
  return {
    name,
    workspaceName:
      d.workspaceName.trim() || sanitizeWsName(name) || `step-${index + 1}`,
    brief: d.brief,
    decisionMode: d.decisionMode,
    expectedArtifacts: d.artifactsText
      .split(/[,，]/)
      .map((x) => x.trim())
      .filter(Boolean),
    acceptanceCriteria: d.acceptanceText
      .split(/[\n；;]/)
      .map((x) => x.trim())
      .filter(Boolean),
    inputs: d.inputsText
      .split(/[,，]/)
      .map((x) => x.trim())
      .filter(Boolean),
    optionalInputs: d.optionalInputsText
      .split(/[,，]/)
      .map((x) => x.trim())
      .filter(Boolean),
    anyOfInputs: d.anyOfInputsText
      .split(/[;；\n]/)
      .map((group) =>
        group
          .split("|")
          .map((x) => x.trim())
          .filter(Boolean),
      )
      .filter((group) => group.length > 0),
    skills: d.skills,
    requiredSkills: d.requiredSkills.filter((name) => d.skills.includes(name)),
    run: d.run
      .filter((r) => r.name.trim() && r.command.trim())
      .map((r) => ({ ...r, name: r.name.trim(), command: r.command.trim() })),
    resources: [...d.resources],
    humanTasks: d.humanTasks
      .filter((t) => t.title.trim())
      .map((t) => ({
        title: t.title.trim(),
        guidance: t.guidance.trim(),
        // 落点可省：行内处理的事项（如「更换引用样式」）没有 target 字段。
        target: (t.target ?? "").trim(),
        timing: t.timing,
        // optional 必须透传：内置模板用它标「不做也能跑」的事项，漏掉会让编辑器一保存
        // 就把这些事项静默升级为必办（v3.85 修）
        optional: t.optional ?? false,
        completion: normalizeCompletion(t.target, t.completion),
        expectedCount:
          t.expectedCount != null && Number.isFinite(t.expectedCount)
            ? Math.max(0, Math.floor(t.expectedCount))
            : undefined,
        manifestPath: t.manifestPath?.trim() || undefined,
      })),
    discussionSeeds: d.discussionSeeds.map((x) => x.trim()).filter(Boolean),
    // 与后端一致：空选项保留为需手写依据的决策，不能静默删掉硬暂停条件。
    decisions: d.decisions
      .map((x) => ({
        q: x.q.trim(),
        options: x.optionsText
          .split(/[,，]/)
          .map((o) => o.trim())
          .filter(Boolean),
      }))
      .filter((x) => x.q),
    asksLitSource: d.asksLitSource,
    seedComplete: d.seedComplete,
    ...(d.pack ? { pack: d.pack } : {}),
    ...(d.params.length ? { params: d.params.map((p) => ({ ...p, value: p.value.trim() })) } : {}),
    ...(d.checks.length ? { checks: d.checks } : {}),
    ...(d.role ? { role: d.role } : {}),
    ...(d.fanOut ? { fanOut: d.fanOut } : {}),
  };
}

/** 按保存口径归一化一步（比较用） */
export function canonicalStep(s: ProjectStepDto, index = 0): ProjectStepDto {
  return toStep(toDraft(s), index);
}
