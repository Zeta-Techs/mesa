/**
 * 协调对话与拆分方案（2026-11-03 项目内协作三期，docs/design-project-coordination.md）前端纯逻辑：
 * - buildCoordinatorPrompt：协调对话的开场指令（不自己干活；看一眼答进展；人要拆分时按固定格式写方案，等人批准）；
 * - parseSplitPlan：读 `.ccode/split-plan.md`（Rust split_plan.rs 只管读与留底）；
 * - planIssues：拦下 / 提醒两档（与任务包检查同一口径：拦下的不让开）；
 * - laneGoalText：一路变成一条目标的要求原文。
 * 并行三层第二层：方案由 AI 起草，人批准一次才一起开；Mesa 不按它自动开工、不自动选模型。
 */

export const PLAN_REL = ".ccode/split-plan.md";
/** 一次最多拆这么多路 */
export const MAX_LANES = 6;

export interface PlanLane {
  name: string;
  todo: string;
  reads: string;
  delivers: string;
  shared: string;
  budget: string;
  /** 要等哪几路做完才能开（不用等为空）：批准时这一路只记下、不开工 */
  waits: string;
  /** 不认识的「名称：内容」行原样留着，写进目标要求 */
  notes: string[];
}

export interface SplitPlan {
  title: string;
  /** 按什么拆（拆分本身是科研判断时写明） */
  basis: string;
  /** 共享文件谁写 */
  sharedFiles: string;
  lanes: PlanLane[];
}

export interface PlanIssue {
  level: "block" | "warn";
  lane: string | null;
  message: string;
}

type TextField = "todo" | "reads" | "delivers" | "shared" | "budget" | "waits";
const FIELD: Record<string, TextField> = {
  要做: "todo",
  读: "reads",
  交: "delivers",
  写共享文件: "shared",
  预算: "budget",
  // 2026-11-03 Codex 干跑实证：汇总那一路自己写了「依赖：」——等前几路做完才能开，几种叫法都认
  等: "waits",
  依赖: "waits",
  前置: "waits",
  等待: "waits",
};

function field(line: string): [string, string] | null {
  const m = /^[-*]?\s*([^：:]{1,8})[：:]\s*(.*)$/.exec(line.trim());
  return m ? [m[1].trim(), m[2].trim()] : null;
}

export function parseSplitPlan(text: string): SplitPlan {
  const plan: SplitPlan = { title: "", basis: "", sharedFiles: "", lanes: [] };
  let lane: PlanLane | null = null;
  let last: TextField | "note" | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h1 = /^#\s+(.*)$/.exec(line);
    if (h1) {
      plan.title = h1[1].replace(/^拆分方案[：:]\s*/, "").trim();
      continue;
    }
    const h2 = /^##\s+(?:\d+[.、]\s*)?(.*)$/.exec(line);
    if (h2) {
      lane = { name: h2[1].trim(), todo: "", reads: "", delivers: "", shared: "", budget: "", waits: "", notes: [] };
      plan.lanes.push(lane);
      last = null;
      continue;
    }
    const f = field(line);
    if (!lane) {
      if (f?.[0] === "按什么拆") plan.basis = f[1];
      else if (f?.[0] === "共享文件") plan.sharedFiles = f[1];
      continue;
    }
    if (f && FIELD[f[0]]) {
      last = FIELD[f[0]];
      lane[last] = f[1];
    } else if (f) {
      // 不认识的字段：单独记一条，不混进上一个字段（否则「依赖：」会被当成「写共享文件」的续行误报）
      lane.notes.push(`${f[0]}：${f[1]}`);
      last = "note";
    } else if (last && line.trim()) {
      // 字段写成多行：接在上一个字段后面
      if (last === "note") lane.notes[lane.notes.length - 1] += `\n${line.trim()}`;
      else lane[last] = `${lane[last]}\n${line.trim()}`.trim();
    }
  }
  return plan;
}

const NONE = /^(无|没有|不写|不等|-|—)?$/;

/** 这一路要先等别的几路做完（批准时只记下、不开工） */
export function laneWaits(lane: Pick<PlanLane, "waits">): boolean {
  return Boolean(lane.waits.trim()) && !NONE.test(lane.waits.trim());
}

export function planIssues(plan: SplitPlan): PlanIssue[] {
  const out: PlanIssue[] = [];
  if (plan.lanes.length === 0) out.push({ level: "block", lane: null, message: "方案里没有任何一路（每路用「## 名字」开头）" });
  if (plan.lanes.length > MAX_LANES) out.push({ level: "block", lane: null, message: `一次最多拆 ${MAX_LANES} 路，写了 ${plan.lanes.length} 路` });
  if (!plan.basis.trim()) out.push({ level: "warn", lane: null, message: "没写「按什么拆」：拆法本身若是科研判断，要写出来给人看" });
  const names = new Set<string>();
  for (const l of plan.lanes) {
    const name = l.name || "（没名字）";
    if (!l.name) out.push({ level: "block", lane: null, message: "有一路没写名字" });
    else if (names.has(l.name)) out.push({ level: "block", lane: name, message: "名字重复" });
    names.add(l.name);
    if (!l.todo.trim()) out.push({ level: "block", lane: name, message: "没写「要做」" });
    if (!l.delivers.trim() || NONE.test(l.delivers.trim())) out.push({ level: "warn", lane: name, message: "没写「交」什么：做完拿什么验收" });
    if (l.shared.trim() && !NONE.test(l.shared.trim())) {
      out.push({ level: "warn", lane: name, message: `要写共享文件（${l.shared.trim()}）：几路同时写会打架，确认只有这一路写` });
    }
  }
  return out;
}

/** 一路变成一条目标：名字 + 要求原文（读什么交什么写进去，Agent 看得到） */
export function laneGoalText(plan: SplitPlan, lane: PlanLane): string {
  const lines = [lane.todo.trim()];
  if (lane.reads.trim() && !NONE.test(lane.reads.trim())) lines.push(`读：${lane.reads.trim()}`);
  if (lane.delivers.trim() && !NONE.test(lane.delivers.trim())) lines.push(`交：${lane.delivers.trim()}`);
  if (lane.shared.trim() && !NONE.test(lane.shared.trim())) lines.push(`共享文件：${lane.shared.trim()}`);
  else lines.push("不写共享文件（别的几路同时在做，只写自己这一路的产物）。");
  if (lane.budget.trim()) lines.push(`预算：${lane.budget.trim()}`);
  if (laneWaits(lane)) lines.push(`开工前提：${lane.waits.trim()}（那几路的产物评审采纳进项目后再做；缺了先报缺什么，不要自己重做）`);
  lines.push(...lane.notes);
  if (plan.title) lines.push(`这是拆分方案「${plan.title}」里的一路；同时开着的其他几路可用 "$MESA_PEEK_TOOL" peek agents 看，需要通气用 tell。`);
  return lines.join("\n");
}

export function buildCoordinatorPrompt(projectName: string, isWindows: boolean): string {
  const tool = isWindows ? "& $env:MESA_PEEK_TOOL" : '"$MESA_PEEK_TOOL"';
  return [
    `你是项目「${projectName}」的协调对话。你不自己动手做项目里的活，只做三件事：`,
    `1. 人问进展时，用 \`${tool} peek agents\` / \`peek runs --worker 名字\` / \`peek changes --worker 名字\` / \`peek mail\` 看清再答，说人话，不贴原始输出。`,
    `2. 需要转告某一段工作时，用 \`${tool} tell --to 名字 "要说的话"\`。`,
    `3. 人要你把一件事拆成几路同时做时，写方案到项目根 \`${PLAN_REL}\`（覆盖旧的），格式如下，写完告诉人「去工作台看拆分方案并批准」。Mesa 在人批准后一次开齐，你不要自己开工。`,
    "",
    "```markdown",
    "# 拆分方案：一句话说这次总共要做成什么",
    "按什么拆：按主题 / 按数据集 / 按章节……；拆法本身是科研判断时写清依据",
    "共享文件：哪些文件几路都会用到、由哪一路写（没有写「无」）",
    "",
    "## 第一路的名字",
    "要做：这一路要做成什么（一两句，能验收）",
    "读：要读的文件或目录（没有写「无」）",
    "交：做完交什么文件（写路径）",
    "写共享文件：不写 / 写哪个、为什么",
    "等：要等哪几路做完才能开（不用等写「不等」；要等的这一路批准时只记下，人等前面做完再开）",
    "预算：可省，如「不超过 20 篇」「一小时内」",
    "",
    "## 第二路的名字",
    "…",
    "```",
    "",
    `规矩：一次最多 ${MAX_LANES} 路；每路只写自己的产物，共享文件只让一路写；拆不开的就别拆，直接告诉人「这件事按顺序做更好」。`,
    "AI 写的人工请求（help-wanted）不要替人回答；不改别人工作副本里的文件；不建议换模型。",
    "",
    "先用 peek agents 看一眼项目现在有哪些工作开着，再等人说要做什么。",
  ].join("\n");
}
