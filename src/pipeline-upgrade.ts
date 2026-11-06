import type { PipelineTemplateDef } from "./pipeline-presets";
import type { ProjectStepDto } from "./types";
import { canonicalStep } from "./pipeline-step-draft.ts";

/** 参与比较的字段（资源绑定是项目自己的，不比） */
export const UPGRADE_FIELDS = ["brief", "expectedArtifacts", "inputs", "optionalInputs", "anyOfInputs", "acceptanceCriteria", "run", "skills", "requiredSkills", "humanTasks", "decisionMode", "decisions", "fanOut", "role"] as const;
export type UpgradeField = (typeof UPGRADE_FIELDS)[number];

/** 匹配仅用于提出更新候选，不自动改写已有项目。名称与工作区必须同时一致。
 *  两边都先按编辑器保存口径归一化（canonicalStep）再比：项目里的步骤是保存过的样子（验收条件按分号拆开、
 *  人工事项补了空落点、决策暂停策略补了缺省值），模板是原样，直接比会把写法差异全报成更新（2026-11-06 HER 实证）。
 *  current / proposed 给归一化后的两边，界面按字段列差异 */
export function pipelineUpgradeCandidates(current: ProjectStepDto[], template: PipelineTemplateDef) {
  return current.flatMap((raw, index) => {
    const tpl = template.steps.find((s) => s.name === raw.name && s.workspaceName === raw.workspaceName);
    if (!tpl) return [];
    const step = canonicalStep(raw, index);
    const proposed = canonicalStep(tpl, index);
    const fields = UPGRADE_FIELDS.filter(
      (key) => JSON.stringify(step[key] ?? null) !== JSON.stringify(proposed[key] ?? null),
    );
    return fields.length ? [{ index, current: step, proposed, template: tpl, fields }] : [];
  });
}

/** 项目像哪套内置模板：按「步骤名 + 工作区名」都一致的步数取最多的，至少两步对上才算（项目不记模板 id）。 */
export function bestTemplateMatch(current: ProjectStepDto[], templates: PipelineTemplateDef[]): PipelineTemplateDef | null {
  let best: PipelineTemplateDef | null = null;
  let bestHits = 1;
  for (const t of templates) {
    const hits = current.filter((s) => t.steps.some((p) => p.name === s.name && p.workspaceName === s.workspaceName)).length;
    if (hits > bestHits) {
      best = t;
      bestHits = hits;
    }
  }
  return best;
}

/** 模板步骤按本项目的研究工具设置换算成保存时的样子（编辑器保存前都过 withResearchTools）；
 *  提示与编辑器里的「检查更新」共用，两边才列出同一批差异。换算失败的步骤保持原样 */
export function normalizedTemplate(
  template: PipelineTemplateDef,
  normalize?: (step: ProjectStepDto) => ProjectStepDto,
): PipelineTemplateDef {
  if (!normalize) return template;
  return {
    ...template,
    steps: template.steps.map((s) => {
      try {
        return normalize(s);
      } catch {
        return s;
      }
    }),
  };
}

/** 已有项目的「内置模板有更新」提示（综述回路三期 §13-6：提示升级，人点了才改）。
 *  normalize 把模板步骤按本项目的研究工具设置换算成保存时的样子（编辑器保存前都过 withResearchTools），
 *  否则每个项目都会被误报。signature 用于「不用了」之后同一批更新不再提示。 */
export function templateUpdateNotice(
  current: ProjectStepDto[],
  templates: PipelineTemplateDef[],
  normalize?: (step: ProjectStepDto) => ProjectStepDto,
): { templateId: string; templateName: string; steps: string[]; signature: string } | null {
  const t = bestTemplateMatch(current, templates);
  if (!t) return null;
  const changes = pipelineUpgradeCandidates(current, normalizedTemplate(t, normalize));
  if (changes.length === 0) return null;
  const text = JSON.stringify(changes.map((c) => [c.current.name, c.proposed]));
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return {
    templateId: t.id,
    templateName: t.name,
    steps: changes.map((c) => c.current.name),
    signature: `${t.id}:${h.toString(36)}`,
  };
}

/** 差异给人看（2026-11-06 用户看了编辑器「整个 UI」：原来是英文字段名 + 两栏 JSON）：中文字段名，
 *  单值写「原来 → 新版」，清单写去掉 / 新增几条，简报按行比只列改了的行（前后各带一行） */
export const UPGRADE_FIELD_LABELS: Record<UpgradeField, string> = {
  brief: "简报",
  expectedArtifacts: "预期产物",
  inputs: "必需输入",
  optionalInputs: "可选输入",
  anyOfInputs: "任一输入",
  acceptanceCriteria: "验收条件",
  run: "渲染脚本",
  skills: "技能",
  requiredSkills: "必需技能",
  humanTasks: "人工事项",
  decisionMode: "决策暂停策略",
  decisions: "开工前拍板项",
  fanOut: "分路精读",
  role: "谁来做",
};

const DECISION_MODE_LABELS: Record<string, string> = {
  auto_continue: "一般问题可按可逆兜底继续",
  soft_pause: "软暂停",
  hard_pause: "硬暂停",
};
const ROLE_LABELS: Record<string, string> = { "": "主要交给 AI", you: "主要靠你", both: "你和 AI 一起定" };

export type UpgradeLine = { kind: "same" | "del" | "add" | "gap"; text: string };
export type UpgradeFieldDiff =
  | { field: UpgradeField; label: string; kind: "value"; before: string; after: string }
  | { field: UpgradeField; label: string; kind: "list"; removed: string[]; added: string[]; changed: string[] }
  | { field: UpgradeField; label: string; kind: "text"; lines: UpgradeLine[] };

function listItems(field: UpgradeField, step: ProjectStepDto): string[] {
  switch (field) {
    case "anyOfInputs":
      return (step.anyOfInputs ?? []).map((g) => g.join(" | "));
    case "run":
      return step.run.map((r) => `${r.name}：${r.command}`);
    case "decisions":
      return (step.decisions ?? []).map((d) => (d.options.length ? `${d.q}（${d.options.join(" / ")}）` : d.q));
    default:
      return ((step[field as keyof ProjectStepDto] as string[] | undefined) ?? []).map(String);
  }
}

/** 按行求最长公共子序列，只留改动行与前后各一行上下文，中间省略记 gap */
export function lineDiff(before: string, after: string, context = 1): UpgradeLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const all: UpgradeLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      all.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) {
      // 同长时先列删掉的行，再列新行（读起来是「原来 → 新版」）
      all.push({ kind: "del", text: a[i++] });
    } else {
      all.push({ kind: "add", text: b[j++] });
    }
  }
  const keep = all.map((l, k) =>
    l.kind !== "same" || all.slice(Math.max(0, k - context), k + context + 1).some((x) => x.kind !== "same"),
  );
  const out: UpgradeLine[] = [];
  all.forEach((l, k) => {
    if (keep[k]) out.push(l);
    else if (out.length === 0 || out[out.length - 1].kind !== "gap") out.push({ kind: "gap", text: "" });
  });
  return out;
}

export function describeUpgradeField(field: UpgradeField, current: ProjectStepDto, proposed: ProjectStepDto): UpgradeFieldDiff {
  const label = UPGRADE_FIELD_LABELS[field];
  if (field === "brief") return { field, label, kind: "text", lines: lineDiff(current.brief, proposed.brief) };
  if (field === "role")
    return { field, label, kind: "value", before: ROLE_LABELS[current.role ?? ""] ?? current.role ?? "", after: ROLE_LABELS[proposed.role ?? ""] ?? proposed.role ?? "" };
  if (field === "decisionMode") {
    const show = (m?: string) => DECISION_MODE_LABELS[m ?? "auto_continue"] ?? m ?? "";
    return { field, label, kind: "value", before: show(current.decisionMode), after: show(proposed.decisionMode) };
  }
  if (field === "fanOut") {
    const show = (f: ProjectStepDto["fanOut"]) =>
      f ? `按 ${f.items}${f.filter ? `（${f.filter}）` : ""} 分路，每路 ${f.per} 篇，最多 ${f.max} 路` : "不分路";
    const before = show(current.fanOut);
    const after = show(proposed.fanOut);
    // 分路的口径一样、只改了每路说明时，值上看不出差别
    return { field, label, kind: "value", before, after: before === after ? `${after}（改了每路与收尾的说明）` : after };
  }
  if (field === "humanTasks") {
    const cur = current.humanTasks ?? [];
    const next = proposed.humanTasks ?? [];
    const curTitles = new Set(cur.map((t) => t.title));
    const nextTitles = new Set(next.map((t) => t.title));
    return {
      field,
      label,
      kind: "list",
      removed: cur.filter((t) => !nextTitles.has(t.title)).map((t) => t.title),
      added: next.filter((t) => !curTitles.has(t.title)).map((t) => t.title),
      changed: next
        .filter((t) => {
          const old = cur.find((c) => c.title === t.title);
          return old && JSON.stringify(old) !== JSON.stringify(t);
        })
        .map((t) => t.title),
    };
  }
  const before = listItems(field, current);
  const after = listItems(field, proposed);
  const added = after.filter((x) => !before.includes(x));
  const removed = before.filter((x) => !after.includes(x));
  // 只是换了顺序
  return { field, label, kind: "list", removed, added, changed: added.length || removed.length ? [] : ["顺序调整"] };
}
