/**
 * 内置模板「另存为我的版本」与「内置有更新」（任务包第四期，design-task-packs.md §6）。
 * 我的版本记 based_on：基于哪个内置、当时的内置步骤。三份步骤（我的版本、当时的内置、现在的内置）都经后端同一套归一
 * （task_packs.rs normalize_steps：档案卡写出读回、缺省值补齐）才拿来比——前端不另抄一份缺省值。内置升级后：
 * - 拿当时的内置和现在的内置逐步比，变了的列出来，并标这一步我改没改过；
 * - 我一步都没改过的，直接跟上新版（「没改过的内置自动跟新版」）；
 * - 改过的由人逐步勾：勾了用新版，不勾保留我的；一个都不勾就是「保留我的」，这一版不再提示。
 */
import { PIPELINE_TEMPLATES, pipelineStepsForTemplate, type SubmissionMode } from "./pipeline-presets.ts";
import type { PackBasedOnDto, ProjectStepDto, TaskPackDto } from "./types.ts";

/** 比较的步骤字段：决定任务书内容的合同本体（与编辑器「检查内置模板更新」同一批，加人工事项以外的讨论种子与核验） */
export const COMPARED_FIELDS = [
  "brief",
  "expectedArtifacts",
  "inputs",
  "optionalInputs",
  "anyOfInputs",
  "acceptanceCriteria",
  "run",
  "skills",
  "requiredSkills",
  "humanTasks",
  "decisionMode",
  "decisions",
  "discussionSeeds",
  "role",
  "fanOut",
] as const;

const FIELD_LABELS: Record<(typeof COMPARED_FIELDS)[number], string> = {
  brief: "简报",
  expectedArtifacts: "预期产物",
  inputs: "输入",
  optionalInputs: "可选输入",
  anyOfInputs: "任一输入",
  acceptanceCriteria: "验收条件",
  run: "运行命令",
  skills: "技能",
  requiredSkills: "必需技能",
  humanTasks: "人工事项",
  decisionMode: "暂停方式",
  decisions: "决策项",
  discussionSeeds: "讨论种子",
  role: "角色",
  fanOut: "分路",
};

/** 去掉「没写」的各种写法（undefined / null / 空串 / 空数组 / false），键排序：档案卡读回来的和前端原样的才比得上 */
export function normValue(v: unknown): unknown {
  if (v === undefined || v === null || v === false) return null;
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (Array.isArray(v)) {
    const items = v.map(normValue);
    return items.length === 0 ? null : items;
  }
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      const n = normValue((v as Record<string, unknown>)[key]);
      if (n !== null) out[key] = n;
    }
    return Object.keys(out).length === 0 ? null : out;
  }
  return v;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(normValue(a)) === JSON.stringify(normValue(b));
}

/** 两步合同不同的字段 */
export function changedFields(a: ProjectStepDto | undefined, b: ProjectStepDto | undefined): string[] {
  return COMPARED_FIELDS.filter((f) => !same(a?.[f], b?.[f]));
}

export function fieldLabel(f: string): string {
  return FIELD_LABELS[f as (typeof COMPARED_FIELDS)[number]] ?? f;
}

/** 同一个内置对照（模板 + 分支 + 轮次）的键：现在的内置按它批量归一 */
export function builtinKey(basedOn: Pick<PackBasedOnDto, "template" | "mode" | "round">): string {
  return `${basedOn.template}|${basedOn.mode || ""}|${basedOn.round || 0}`;
}

/** 内置现在的步骤（原样，未归一）；内置已经没有这个模板了返回 null */
export function currentBuiltinSteps(basedOn: Pick<PackBasedOnDto, "template" | "mode" | "round">): ProjectStepDto[] | null {
  const tpl = PIPELINE_TEMPLATES.find((t) => t.id === basedOn.template);
  if (!tpl) return null;
  return pipelineStepsForTemplate(tpl, (basedOn.mode || "initial") as SubmissionMode, basedOn.round || 1);
}

/** 另存为我的版本时记的 based_on */
export function basedOnFor(templateId: string, mode?: SubmissionMode, round?: number): PackBasedOnDto | null {
  const tpl = PIPELINE_TEMPLATES.find((t) => t.id === templateId);
  if (!tpl) return null;
  const submission = tpl.id === "submission-rebuttal";
  const m = submission ? (mode ?? "initial") : "";
  const r = submission && m === "revision" ? Math.max(1, Math.floor(round ?? 1)) : 0;
  return {
    template: tpl.id,
    templateName: tpl.name,
    mode: m,
    round: r,
    steps: pipelineStepsForTemplate(tpl, (m || "initial") as SubmissionMode, r || 1),
  };
}

export interface BuiltinStepChange {
  name: string;
  /** changed 内置改了这一步 | added 内置新加的步 | removed 内置去掉了这一步 */
  kind: "changed" | "added" | "removed";
  /** 内置旧版 → 新版变了哪些字段 */
  fields: string[];
  old?: ProjectStepDto;
  next?: ProjectStepDto;
  mine?: ProjectStepDto;
  /** 我的版本这一步和当时的内置不一样（我改过） */
  mineEdited: boolean;
}

export interface BuiltinUpdate {
  templateName: string;
  current: ProjectStepDto[];
  changes: BuiltinStepChange[];
  /** 我的版本跟当时的内置一模一样（步骤名、顺序、合同都没动）：直接跟新版 */
  untouched: boolean;
}

/** 这个我的版本的内置有没有更新。current = 现在的内置（经后端归一）；没有 based_on、内置已删、或内置没变返回 null */
export function builtinUpdate(pack: Pick<TaskPackDto, "steps" | "basedOn">, current: ProjectStepDto[] | null | undefined): BuiltinUpdate | null {
  const basedOn = pack.basedOn;
  if (!basedOn || !current) return null;
  const old = basedOn.steps ?? [];
  const sameSteps = (a: ProjectStepDto[], b: ProjectStepDto[]) =>
    a.length === b.length && a.every((s, i) => s.name === b[i].name && changedFields(s, b[i]).length === 0);
  if (sameSteps(old, current)) return null;
  const byName = (list: ProjectStepDto[], name: string) => list.find((s) => s.name === name);
  const changes: BuiltinStepChange[] = [];
  for (const next of current) {
    const was = byName(old, next.name);
    const mine = byName(pack.steps, next.name);
    if (!was) {
      changes.push({ name: next.name, kind: "added", fields: [], next, mine, mineEdited: Boolean(mine) });
      continue;
    }
    const fields = changedFields(was, next);
    if (fields.length > 0) {
      changes.push({ name: next.name, kind: "changed", fields, old: was, next, mine, mineEdited: !mine || changedFields(mine, was).length > 0 });
    }
  }
  for (const was of old) {
    if (!byName(current, was.name)) {
      const mine = byName(pack.steps, was.name);
      changes.push({ name: was.name, kind: "removed", fields: [], old: was, mine, mineEdited: !mine || changedFields(mine, was).length > 0 });
    }
  }
  return { templateName: basedOn.templateName, current, changes, untouched: sameSteps(pack.steps, old) };
}

/**
 * 按勾选合成新的步骤：changed 勾了换成新版那一步；added 勾了按内置的位置插进来（找它在内置里前一步的后面，找不到放末尾）；
 * removed 勾了从我的版本里拿掉。没勾的保留我的
 */
export function mergeBuiltinUpdate(mineSteps: readonly ProjectStepDto[], update: BuiltinUpdate, picked: ReadonlySet<string>): ProjectStepDto[] {
  let out = [...mineSteps];
  for (const c of update.changes) {
    if (!picked.has(c.name)) continue;
    if (c.kind === "changed" && c.next) {
      const at = out.findIndex((s) => s.name === c.name);
      if (at >= 0) out[at] = c.next;
      else out.push(c.next);
    } else if (c.kind === "removed") {
      out = out.filter((s) => s.name !== c.name);
    }
  }
  for (const c of update.changes) {
    if (c.kind !== "added" || !picked.has(c.name) || !c.next || out.some((s) => s.name === c.name)) continue;
    const idx = update.current.findIndex((s) => s.name === c.name);
    const prev = update.current.slice(0, idx).reverse().find((s) => out.some((o) => o.name === s.name));
    const at = prev ? out.findIndex((s) => s.name === prev.name) + 1 : out.length;
    out.splice(at, 0, c.next);
  }
  return out;
}

/** 新的 based_on：对照点挪到现在的内置（保留我的 / 按勾选更新之后，这一版不再提示） */
export function rebased(basedOn: PackBasedOnDto, current: ProjectStepDto[]): PackBasedOnDto {
  return { ...basedOn, steps: current };
}
