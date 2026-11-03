/**
 * 拆分方案（2026-11-03 项目内协作三期，docs/design-project-coordination.md）前端纯逻辑：
 * - buildSplitPrompt / readSplitReply：工作台「拆成几路做」无头调用一次 AI 的提示词与回话解读
 *   （同日用户拍板去掉协调对话：问进展、留话直接在工作台做，只有拆分要 AI 判断）；
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
/** 「不写；只写汇总目录内的文件」这类先说不、再补一句的也算没有（2026-11-03 Codex 实写） */
const NONE_LEAD = /^(无|没有|不写|不等)[；;，,。（(\s]/;

function isNone(value: string): boolean {
  const v = value.trim();
  return NONE.test(v) || NONE_LEAD.test(v);
}

/** 这一路要先等别的几路做完（批准时只记下、不开工） */
export function laneWaits(lane: Pick<PlanLane, "waits">): boolean {
  return Boolean(lane.waits.trim()) && !isNone(lane.waits);
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
    if (!l.delivers.trim() || isNone(l.delivers)) out.push({ level: "warn", lane: name, message: "没写「交」什么：做完拿什么验收" });
    if (l.shared.trim() && !isNone(l.shared)) {
      out.push({ level: "warn", lane: name, message: `要写共享文件（${l.shared.trim()}）：几路同时写会打架，确认只有这一路写` });
    }
  }
  return out;
}

/** 一路变成一条目标：名字 + 要求原文（读什么交什么写进去，Agent 看得到） */
export function laneGoalText(plan: SplitPlan, lane: PlanLane): string {
  const lines = [lane.todo.trim()];
  if (lane.reads.trim() && !isNone(lane.reads)) lines.push(`读：${lane.reads.trim()}`);
  if (lane.delivers.trim() && !isNone(lane.delivers)) lines.push(`交：${lane.delivers.trim()}`);
  if (lane.shared.trim() && !isNone(lane.shared)) lines.push(`共享文件：${lane.shared.trim()}`);
  else lines.push("不写共享文件（别的几路同时在做，只写自己这一路的产物）。");
  if (lane.budget.trim()) lines.push(`预算：${lane.budget.trim()}`);
  if (laneWaits(lane)) lines.push(`开工前提：${lane.waits.trim()}（那几路的产物评审采纳进项目后再做；缺了先报缺什么，不要自己重做）`);
  lines.push(...lane.notes);
  if (plan.title) lines.push(`这是拆分方案「${plan.title}」里的一路；同时开着的其他几路可用 "$MESA_PEEK_TOOL" peek agents 看，需要通气用 tell。`);
  return lines.join("\n");
}

const FORMAT = [
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
].join("\n");

/** 不拆时回话的开头 */
const NO_SPLIT = "不拆：";

/**
 * 「拆成几路做」的提示词：AI 在临时目录里跑、看不到项目，靠 context（split_plan_context：目录前两层 + 开着的工作）判断。
 * 「让它改」时带上一版方案与人的意见，整份重写
 */
export function buildSplitPrompt(input: {
  projectName: string;
  request: string;
  context: string;
  previous?: string;
  feedback?: string;
}): string {
  const lines = [
    `你在帮人把项目「${input.projectName}」里的一件事拆成几路，交给几个 AI 同时做。你只写方案，不动手做，也不开工；人在 Mesa 里看过、批准一次，Mesa 才一路记一条目标一起开，每路在隔离副本里做、验收后写回项目。`,
    "",
    "人要做的事：",
    input.request.trim(),
    "",
    input.context.trim(),
    "",
  ];
  if (input.previous?.trim()) {
    lines.push("上一版方案：", input.previous.trim(), "", "人对上一版的意见：", (input.feedback ?? "").trim(), "", "按意见整份重写。", "");
  }
  lines.push(
    "只输出方案本身（Markdown，不加代码块围栏、不加前言后记），格式：",
    "",
    FORMAT,
    "",
    `规矩：一次最多 ${MAX_LANES} 路；每路只写自己的产物，共享文件只让一路写；路径写项目里的相对路径，只用上面目录里有的或这一路自己要新建的；拿不准的地方写进那一路的「要做」，写成「需要你定：……」。`,
    `拆不开的（前后一步接一步、几路会改同一批文件、本来就很小）别硬拆：只回一行「${NO_SPLIT}理由」。`,
  );
  return lines.join("\n");
}

export type SplitReply = { kind: "plan"; text: string } | { kind: "no-split"; reason: string } | { kind: "bad"; raw: string };

/** 读 AI 的回话：去掉围栏和前言，从「# 拆分方案」那行开始算方案；「不拆：」开头是拒拆；都不是就当没按格式写 */
export function readSplitReply(raw: string): SplitReply {
  const text = raw.replace(/\r\n/g, "\n").trim();
  const noSplit = new RegExp(`^(?:\\*\\*)?${NO_SPLIT}`, "m").exec(text);
  const start = text.search(/^#\s+拆分方案/m);
  if (start < 0) {
    if (noSplit) return { kind: "no-split", reason: text.slice(noSplit.index + noSplit[0].length).split("\n")[0].replace(/\*\*/g, "").trim() };
    return { kind: "bad", raw: text };
  }
  const body = text
    .slice(start)
    .replace(/\n```\s*$/, "")
    .trim();
  return { kind: "plan", text: body };
}
