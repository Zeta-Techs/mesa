/**
 * 把做成过一次的活存成「我的任务」（2026-11-05 接活三期，docs/design-assistant-intake.md §5）：
 * 派活单验收后「存成我的任务…」、内置科研任务「另存为我的版本…」都先变成一步步骤合同，再交给已有的另存表单（SavePackForm）
 * 让人起名、改参数、过机器检查后存。每次会变的部分（日期、时间范围、时长、这次用的文件）先按字面挑出来预填成参数，人可删可改。
 * 纯逻辑，配 tests/work-order-pack.test.ts。
 */
import type { BuiltinTask } from "./builtin-tasks";
import type { WorkOrder } from "./project-assistant";
import type { ProjectStepDto, StepParamDto } from "./types";

/** 交付物一栏里像路径的部分（output/x/slides.html、slides/、report.md）；认不出就空着，让人在另存后的流程编辑器里补 */
export function artifactPaths(text: string | undefined): string[] {
  if (!text) return [];
  // 前面紧挨着 / 或 . 的不算开头（/etc/a.md 不截成 etc/a.md）
  const re = /(?<![\w./])(?:[A-Za-z0-9_.\-<>{}]+(?:\/[A-Za-z0-9_.\-<>{}]*)+|[A-Za-z0-9_\-<>{}]+\.[A-Za-z][A-Za-z0-9]{0,4}\b)/g;
  const out: string[] = [];
  for (const m of text.replace(/`/g, " ").matchAll(re)) {
    const p = m[0].replace(/^\.\//, "");
    if (/^v?\d+(\.\d+)*$/.test(p) || p.split("/").includes("..")) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out.slice(0, 8);
}

function criteria(text: string | undefined): string[] {
  return (text ?? "")
    .split(/[；;\n]/)
    .map((x) => x.replace(/^[-*+•]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 10);
}

/** 派活单 → 一步步骤合同（做法正文随单子交出过，按任务来的这里一并写进简报） */
export function workOrderToStep(order: WorkOrder, opts: { method?: string | null; extraSkills?: readonly string[] } = {}): ProjectStepDto {
  const brief = [
    order.task.trim(),
    order.inputs?.length ? `依据材料：\n${order.inputs.map((p) => `- ${p}`).join("\n")}` : "",
    order.deliver ? `交付物：${order.deliver}` : "",
    order.assumptions ? `先定下的假设（不对就先停下来问我）：${order.assumptions}` : "",
    order.mustAsk ? `做的时候遇到这些要先停下来问我：${order.mustAsk}` : "",
    opts.method ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    name: order.title.trim() || order.task.trim().slice(0, 20),
    workspaceName: "assistant-task",
    brief,
    expectedArtifacts: artifactPaths(order.deliver),
    acceptanceCriteria: criteria(order.done),
    skills: [...new Set([...(order.skills ?? []), ...(opts.extraSkills ?? [])])],
    run: [],
  };
}

/** 内置科研任务 → 一步步骤合同（「另存为我的版本」：存成我的任务后照自己组的格式改） */
export function builtinTaskStep(task: BuiltinTask): ProjectStepDto {
  return {
    name: task.name,
    workspaceName: task.id,
    brief: [
      task.summary,
      `开工前先写清：${task.clarify.join("；")}。`,
      task.method.map((m, i) => `${i + 1}. ${m}`).join("\n"),
      `交付：${task.deliverables.join("；")}`,
    ].join("\n\n"),
    expectedArtifacts: task.deliverables.map((d) => d.replace(/（.*?）/g, "").trim()),
    acceptanceCriteria: [...task.done],
    skills: [...task.skills],
    run: [],
  };
}

const RANGE_RE = /\d{4}-\d{1,2}-\d{1,2}\s*(?:到|至|~|～|—|-)\s*\d{4}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2}\s*(?:到|至|~|～|—)\s*\d{1,2}-\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*日\s*(?:到|至|~|～|—|-)\s*\d{1,2}\s*月?\s*\d{1,2}\s*日/g;
const DATE_RE = /\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*日/g;
const DURATION_RE = /\d+\s*(?:分钟|小时)/g;
const MAX_SUGGESTED = 8;

/**
 * 每次会变的值按字面先挑出来：时间范围、单个日期、时长、依据材料里的每个文件（文件 / 文件夹类型）。
 * 只是预填，人在表单里可删可改；同一个值只出一次，最多 8 个。
 */
export function suggestPackParams(step: Pick<ProjectStepDto, "brief">, inputs: readonly string[] = []): StepParamDto[] {
  const out: StepParamDto[] = [];
  const add = (label: string, value: string, kind = "") => {
    const v = value.trim();
    if (!v || out.length >= MAX_SUGGESTED || out.some((p) => p.value === v || p.value.includes(v))) return;
    out.push({ key: `p${out.length + 1}`, label, value: v, help: "", options: [], ...(kind ? { kind } : {}) });
  };
  // 文件路径里的日期（lab/2026-11-02.md）归到文件参数，不另算一个日期
  const text = inputs.reduce((t, p) => t.split(p).join(" "), step.brief);
  for (const m of text.matchAll(RANGE_RE)) add("时间范围", m[0]);
  for (const m of text.matchAll(DATE_RE)) add("日期", m[0]);
  for (const m of text.matchAll(DURATION_RE)) add("时长", m[0]);
  inputs.forEach((p, i) => add(inputs.length > 1 ? `依据材料 ${i + 1}` : "依据材料", p, /\.[A-Za-z0-9]{1,6}$/.test(p) ? "file" : "path"));
  return out;
}

/** 「建成定时任务（先不启用）」时写进技能说明的那段：要做什么、交什么、怎样算做完、多久一次（Mesa 照抄进 SKILL.md，不经 AI 改写） */
export function workOrderScheduleIntent(order: WorkOrder, method?: string | null): string {
  return [
    order.task.trim(),
    order.deliver ? `每次交付：${order.deliver}（文件名里带上日期，别覆盖上一次的）` : "",
    order.done ? `怎样算做完：${order.done}` : "",
    order.inputs?.length ? `每次从这些看起：${order.inputs.join("、")}（按时间范围只看新增的）` : "",
    method ?? "",
    order.schedule ? `多久一次：${order.schedule}` : "",
    "没有新内容时不要改任何文件。",
  ]
    .filter(Boolean)
    .join("\n");
}
