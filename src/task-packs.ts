/**
 * 任务包（2026-11-03 第一期，design-task-packs.md）前端纯逻辑：
 * - applyStepParams：拼任务书 / 显示时把文字里的 `{param:键}` 换成取值；
 * - parameterize：另存为我的任务时把选中步骤文字里的具体值改成 `{param:键}`；
 * 替换范围与后端 task_packs.rs `step_texts` 一致：简报、验收条件（`machine:` 行不动）、讨论种子、决策问题、人工事项标题与说明。
 */
import type { PackTriggerDto, ProjectStepDto, StepCheckDto, StepParamDto, TaskPackDto } from "./types.ts";

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

/** 任务包核验的结果文件（research_record 认 pack- 开头：检查器记成文件名、「通过」降为待你判断） */
export function packCheckFile(pack: string | undefined, name: string): string {
  return `.ccode/checks/pack-${pack || "local"}-${name}.jsonl`;
}

/** 按脚本后缀给出怎么跑；Windows 上 Python 用 python（python3 是应用商店占位） */
export function checkCommand(check: StepCheckDto, pack: string | undefined, isWindows: boolean): string {
  const script = `<技能 ${check.skill} 的目录>/${check.script}`;
  const ext = check.script.split(".").pop()?.toLowerCase() ?? "";
  const runner =
    ext === "py" ? (isWindows ? "python" : "python3") : ext === "r" ? "Rscript" : ext === "sh" ? "bash" : ext === "js" || ext === "mjs" ? "node" : "";
  return `${runner ? `${runner} ` : ""}${script} --root <工作目录> --out ${packCheckFile(pack, check.name)}`;
}

/** 任务书「本步核验」整段；没有核验返回空 */
export function checkSectionLines(step: ProjectStepDto, isWindows: boolean): string[] {
  const checks = step.checks ?? [];
  if (checks.length === 0) return [];
  return [
    "## 本步核验",
    ...checks.map((c) => `- ${c.description || c.name}：\`${checkCommand(c, step.pack, isWindows)}\``),
    "",
    "这些核验脚本来自「我的任务」，交付前必须**真的运行**上面每条命令（<工作目录> 换成当前工作目录的绝对路径），不要读脚本代码自己判断结果。脚本会把结果一行一条写进 --out 文件（status 只有 passed / blocked / needs_human），不要删它、不要手改它。",
    "先跑、看结果，再动手：拦下（blocked）的先回头改再交，改完再跑一遍；脚本跑不起来就在本步报告里写明报错，不要手写结果冒充。",
    "",
  ];
}

const WEEKDAYS = ["", "一", "二", "三", "四", "五", "六", "日"];

/** 触发的一句话（加进项目时给人看） */
export function triggerSummary(t: PackTriggerDto): string {
  const name = t.name ? `「${t.name}」` : "";
  if (t.kind === "schedule") {
    const at = `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
    const when =
      t.frequency === "daily"
        ? `每天 ${at}`
        : t.frequency === "weekdays"
          ? `工作日 ${at}`
          : t.frequency === "weekly"
            ? `每周${WEEKDAYS[t.weekday ?? 1] ?? ""} ${at}`
            : t.frequency === "hourly"
              ? `每 ${t.intervalHours ?? 1} 小时`
              : "仅手动";
    return `定时任务${name}：${when}跑技能 ${t.skill}`;
  }
  const what =
    t.kind === "folder"
      ? `${t.folder || "（目录）"}/ 有新文件${t.exts.length ? `（${t.exts.join("、")}）` : ""}时`
      : t.kind === "radar"
        ? "文献雷达采纳之后"
        : "手机文件放进项目之后";
  return `事件规则${name}：${what}用技能 ${t.skill}，${t.mode === "run" ? "直接跑" : "先只记录"}`;
}

/** 默认要不要一并建：只记录的事件规则不花钱，默认勾；定时任务和直接跑的要花钱，默认不勾 */
export function triggerDefaultOn(t: PackTriggerDto): boolean {
  return t.kind !== "schedule" && t.mode !== "run";
}

/**
 * 导入的包第一次加进项目前再问一次（第四期，design-task-packs §7.2「来自别人的脚本首次运行前再提示一次」）：
 * 返回要问的话；不是导入的、或没带文件返回 null。人点了确认才带 scriptsReviewed 去加，加成后后端去掉导入标记
 */
export function importedScriptsNote(pack: Pick<TaskPackDto, "name" | "imported" | "scripts">): string | null {
  if (!pack.imported || pack.scripts.length === 0) return null;
  const list = pack.scripts.slice(0, 8).map((s) => `· ${s.replace(/^skills\//, "")}`);
  if (pack.scripts.length > 8) list.push(`· …共 ${pack.scripts.length} 个`);
  return `「${pack.name}」是从别人那里导入的，带着这些文件：\n${list.join("\n")}\n\n加进流程后，AI 会在工作副本里按任务书运行它们。导入时看过全文、信得过再继续；这个提示只出现这一次。`;
}
