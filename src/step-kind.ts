/**
 * 步骤属于哪一类活（2026-11-06 流程贯通推到其余科研步骤）：回头 / 跟进时各类该怎么改不一样——
 * 清洗改规则重跑、实验只重跑受影响的组合、分析由脚本重出数和图、写作只改受影响的段……
 * 引擎不认模板：只按技能槽（provides）与步骤交的产物认。补料轮 / 跟进轮开场话、补料链默认勾选、补料链那一行的说法共用这一份。
 * 纯逻辑，配 tests/step-kind.test.ts。
 */
import { stepFillsAnySlot, type SkillProvides } from "./skill-slots.ts";

export type StepKind = "search" | "notes" | "outline" | "clean" | "design" | "experiment" | "analysis" | "writing" | "final" | "other";

function hasArtifact(step: { expectedArtifacts?: readonly string[] }, rel: string): boolean {
  return (step.expectedArtifacts ?? []).some((a) => a.replace(/\\/g, "/").replace(/^\.\//, "") === rel);
}

/** 顺序有讲究：先认文献两步，再按专属产物认（交 outline.md 的综述大纲、交运行清单的实验、交 design.md 的设计），最后按技能认 */
export function stepKind(
  step: { skills?: readonly string[]; expectedArtifacts?: readonly string[] },
  provides: SkillProvides,
): StepKind {
  const has = (anchors: string[]) => stepFillsAnySlot(step.skills, anchors, provides);
  if (has(["lit-search"])) return "search";
  if (has(["lit-notes"])) return "notes";
  if (hasArtifact(step, "outline.md")) return "outline";
  if (has(["data-clean"])) return "clean";
  if (hasArtifact(step, "results/run-manifest.json")) return "experiment";
  if (hasArtifact(step, "design.md")) return "design";
  if (has(["figure-forge", "data-eda", "origin-plot"])) return "analysis";
  // 定稿类：引用核对 + 渲染一起（LaTeX 章节写作只有引用核对，算写作）
  if (has(["bib-check"]) && has(["quarto-render"])) return "final";
  if (has(["research-writing", "review-writing", "proposal-writer", "rebuttal-crafter"]) || has(["bib-check"])) return "writing";
  return "other";
}

/**
 * 退回到 / 跟进这一类步骤时，开场话里补的一句做法（文献两步另有专门写法，不走这里）。
 * 只写这一类活回头时最容易做错的那一点，细则仍在任务书与技能里。
 */
export const ROUND_CLAUSE: Record<StepKind, string> = {
  search: "",
  notes: "",
  outline: "改大纲时在「定框架记录」里记一行改了哪一问、为什么；章节变了，覆盖检查、用图计划和表计划跟着改，别留着对不上的旧行。",
  clean:
    "清洗的改动一律走规则：先改 cleaning/rules.md（每条注明依据，新规则没批准就标阻塞、不应用），再从原始数据重跑清洗脚本，不手改清洗后的数据；" +
    "在 cleaning-report.md 记这一轮每条规则影响的行数（前 → 后），更新 cleaned-data-manifest.md 的 hash 与行列数。",
  design:
    "改 design.md 时写明改了什么、为什么、是在看到结果之前还是之后；不为了结果改主指标或停止规则；experiments/matrix.json 同步改，已有组合不改 id，新增先进计划。",
  experiment:
    "只重跑受上游改动影响的组合，新输出放独立目录、不覆盖旧运行；results/run-manifest.json 与 results/matrix.json 逐 id 对账（取消的记 not-run 和依据）；" +
    "results/summary.md 标出这一轮重跑了哪些 id。要超出已批准的资源预算时先问用户。",
  analysis:
    "数和图都由脚本重新生成：在新的输入上重跑分析与出图脚本（reproduce.py、figures/ 的生成脚本），不手改图和表里的数；" +
    "变了的数在本轮记录里列「旧 → 新」，结论因此要改的明说，不悄悄改口。",
  writing:
    "正文只改受上游影响的段落，用户确认过的段落不重写；数字一律从分析结果（results.json、numbers.json 一类）取，变了的逐处改，在章节状态里标「本轮改过」。",
  final: "上游改了，引用核对、统计核对和渲染都按新稿重跑一遍，旧的核对报告不沿用。",
  other: "",
};

/** 补料链默认不勾的：重跑实验花时间、花算力，要人自己勾上才自动跟进 */
export function chainDefaultOff(kind: StepKind): boolean {
  return kind === "experiment";
}
