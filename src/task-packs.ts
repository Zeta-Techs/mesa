/**
 * 任务包（2026-11-03 第一期，design-task-packs.md）前端纯逻辑：
 * - applyStepParams：拼任务书 / 显示时把文字里的 `{param:键}` 换成取值；
 * - parameterize：另存为我的任务时把选中步骤文字里的具体值改成 `{param:键}`；
 * 替换范围与后端 task_packs.rs `step_texts` 一致：简报、验收条件（`machine:` 行不动）、讨论种子、决策问题、人工事项标题与说明。
 */
import type { ProjectStepDto, StepParamDto } from "./types.ts";

const PARAM_RE = /\{param:([A-Za-z0-9_-]+)\}/g;

/** 没填的参数在任务书里写成这样，Agent 一眼看出缺什么 */
function unfilled(p: StepParamDto | undefined, key: string): string {
  return `（参数「${p?.label || key}」未填）`;
}

function fill(text: string, params: readonly StepParamDto[]): string {
  return text.replace(PARAM_RE, (_, key: string) => {
    const p = params.find((x) => x.key === key);
    return p && p.value.trim() ? p.value.trim() : unfilled(p, key);
  });
}

function mapTexts(step: ProjectStepDto, f: (text: string) => string): ProjectStepDto {
  return {
    ...step,
    brief: f(step.brief),
    acceptanceCriteria: step.acceptanceCriteria?.map((c) => (c.trim().startsWith("machine:") ? c : f(c))),
    discussionSeeds: step.discussionSeeds?.map(f),
    decisions: step.decisions?.map((d) => ({ ...d, q: f(d.q) })),
    humanTasks: step.humanTasks?.map((h) => ({ ...h, title: f(h.title), guidance: f(h.guidance) })),
  };
}

/** 把 `{param:键}` 换成取值；没有参数的步骤原样返回 */
export function applyStepParams(step: ProjectStepDto): ProjectStepDto {
  const params = step.params ?? [];
  if (params.length === 0 && !/\{param:/.test(step.brief)) return step;
  return mapTexts(step, (t) => fill(t, params));
}

/** 这一步还没填的参数（开工前提醒） */
export function missingParams(step: ProjectStepDto): StepParamDto[] {
  return (step.params ?? []).filter((p) => !p.value.trim());
}

/** 参数键：按顺序 p1、p2……（人看的是 label，键只给占位用） */
export function nextParamKey(existing: readonly { key: string }[]): string {
  let n = existing.length + 1;
  while (existing.some((p) => p.key === `p${n}`)) n += 1;
  return `p${n}`;
}

function countIn(text: string, needle: string): number {
  return needle ? text.split(needle).length - 1 : 0;
}

/**
 * 另存为我的任务：把选中步骤文字里的具体值（如「Nature」「20%」）换成 `{param:键}`，值本身成为默认值。
 * 长的值先换，免得「Nature Medicine」被「Nature」拆开。返回改好的步骤和每个参数命中几处（0 处的提醒人）
 */
export function parameterize(
  steps: readonly ProjectStepDto[],
  params: readonly StepParamDto[],
): { steps: ProjectStepDto[]; hits: Record<string, number> } {
  const hits: Record<string, number> = Object.fromEntries(params.map((p) => [p.key, 0]));
  const order = [...params].filter((p) => p.value.trim()).sort((a, b) => b.value.trim().length - a.value.trim().length);
  const out = steps.map((step) =>
    mapTexts(step, (text) => {
      let t = text;
      for (const p of order) {
        const v = p.value.trim();
        hits[p.key] += countIn(t, v);
        t = t.split(v).join(`{param:${p.key}}`);
      }
      return t;
    }),
  );
  return { steps: out, hits };
}
