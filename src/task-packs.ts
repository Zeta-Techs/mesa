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
    return p && p.value.trim() && !paramValueProblem(p.kind, p.value) ? p.value.trim() : unfilled(p, key);
  });
}

/** 参数类型（2026-11-04 补齐）：空 = 文字 / 下拉；与后端 projects.rs PARAM_KINDS 同一张表 */
export const PARAM_KIND_LABEL: Record<string, string> = {
  "": "文字",
  number: "数字",
  bool: "是 / 否",
  path: "文件夹",
  file: "文件",
};

/** 取值哪里不对（空值不算错）。与后端 projects.rs param_value_problem 同口径，改一边两边同改 */
export function paramValueProblem(kind: string | undefined, value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  switch (kind) {
    case "number":
      // 与 Rust str::parse::<f64> 同口径（不认 0x10、Infinity 这类 JS 才认的写法）
      return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v) ? null : "要填数字";
    case "bool":
      return v === "是" || v === "否" ? null : "只能是「是」或「否」";
    case "path":
    case "file": {
      const rel = v.replace(/\\/g, "/").replace(/\/+$/, "");
      const ok = rel !== "" && !rel.includes(":") && !rel.startsWith("/") && rel.split("/").filter(Boolean).every((seg) => seg !== "." && seg !== "..");
      return ok ? null : "要写项目里的相对路径，如 data/raw（不能是绝对路径、不能带 ..）";
    }
    default:
      return null;
  }
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

/** 这一步还没填（或填得不合规）的参数（开工前提醒） */
export function missingParams(step: ProjectStepDto): StepParamDto[] {
  return (step.params ?? []).filter((p) => !p.value.trim() || paramValueProblem(p.kind, p.value));
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
  // 先换成私用区单字符占位、全部换完再落成 {param:键}：直接写 {param:p1} 的话，后面短的值（如阈值「1」）
  // 会被换进前面写好的占位里，变成 {param:p{param:p2}}（2026-11-03 自查实测）。原文里已有的 {param:…} 也先藏起来不动
  const keep: string[] = [];
  const hide = (t: string) => t.replace(/\{param:[A-Za-z0-9_-]+\}/g, (m) => String.fromCharCode(0xf000 + keep.push(m) - 1));
  const out = steps.map((step) =>
    mapTexts(step, (text) => {
      let t = hide(text);
      order.forEach((p, i) => {
        const v = p.value.trim();
        hits[p.key] += countIn(t, v);
        t = t.split(v).join(String.fromCharCode(0xe000 + i));
      });
      return t
        .replace(/[\ue000-\ue0ff]/g, (c) => `{param:${order[c.charCodeAt(0) - 0xe000].key}}`)
        .replace(/[\uf000-\uf8ff]/g, (c) => keep[c.charCodeAt(0) - 0xf000]);
    }),
  );
  return { steps: out, hits };
}

/** 另存时把选中步骤自带的参数并成一份：两个包都用了 p1 但意思不同（名字或取值不同）时，后来的那个换成新键，
 *  并把它那几步文字里的 {param:p1} 一起改掉（2026-11-03 自查：原先同键只留第一个，另一个包的步骤悄悄换了含义） */
export function mergeStepParams(steps: readonly ProjectStepDto[]): { steps: ProjectStepDto[]; params: StepParamDto[] } {
  const params: StepParamDto[] = [];
  const outSteps = steps.map((step) => {
    const renames: Record<string, string> = {};
    for (const p of step.params ?? []) {
      const same = params.find((x) => x.key === p.key);
      if (!same) {
        params.push({ ...p });
        continue;
      }
      if (same.label === p.label && same.value === p.value) continue;
      const twin = params.find((x) => x.label === p.label && x.value === p.value);
      const key = twin?.key ?? nextParamKey(params);
      if (!twin) params.push({ ...p, key });
      renames[p.key] = key;
    }
    if (Object.keys(renames).length === 0) return step;
    return mapTexts(step, (t) => t.replace(PARAM_RE, (m, k: string) => (renames[k] ? `{param:${renames[k]}}` : m)));
  });
  return { steps: outSteps, params };
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
export function importedScriptsNote(pack: Pick<TaskPackDto, "name" | "imported" | "scripts"> & { steps?: readonly Pick<ProjectStepDto, "run">[] }): string | null {
  // 步骤自带的运行命令也算（2026-11-03 自查：只带 run 命令、没有脚本文件的导入包原先不再问）
  const runs = (pack.steps ?? []).flatMap((s) => (s.run ?? []).map((r) => `运行命令：${r.command}`));
  const all = [...pack.scripts.map((s) => s.replace(/^skills\//, "")), ...runs];
  if (!pack.imported || all.length === 0) return null;
  const list = all.slice(0, 8).map((s) => `· ${s}`);
  if (all.length > 8) list.push(`· …共 ${all.length} 项`);
  return `「${pack.name}」是从别人那里导入的，带着这些文件和命令：\n${list.join("\n")}\n\n加进流程后，AI 会在工作副本里按任务书运行它们。导入时看过全文、信得过再继续；这个提示只出现这一次。`;
}
