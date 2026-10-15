import type { StepDecisionDto } from "./types";

/** 决策项答案的落点：任务书草稿 `.ccode/drafts/<工作区名>.md` 里的固定小节。
 *
 *  为什么落草稿而不是单独存一份状态：草稿就是开工合同（开工弹层草稿优先于模板拼装），
 *  人和 agent 读的是同一份文件。答案单独存别处就又多一层要对齐的中间态——
 *  §11.3 机制三的口径是「草稿是源，TASK.md 是开工那一刻的产物快照」，这里不破例。
 *
 *  纯函数 + 可测：解析与写入都不碰 IO，落盘由调用方走 write_task_draft。 */
export const DECISIONS_HEADING = "## 已定方向";

/** 小节内的答案行：`- 问题：答案`（全角冒号，与模板文案同一套标点） */
const ANSWER_LINE = /^-\s*(.+?)：(.*)$/;

/** 决定状态与说明分开；标签是闭集，不从「同意／拒绝」等自由文本猜测授权。
 *  落盘仍用这些词；界面用 DECISION_STATUS_ASK。 */
export const DECISION_STATUS = {
  approve: "批准指定范围",
  prepare: "仅允许准备",
  wait: "待补证据",
  reject: "不批准",
} as const;

export type DecisionStatus = keyof typeof DECISION_STATUS;

/** 界面短标签：同一闭集，不另造状态。 */
export const DECISION_STATUS_ASK: Record<DecisionStatus, string> = {
  approve: "可以写",
  prepare: "只准备，先不写正文",
  wait: "证据还不够",
  reject: "先别做这步",
};

/** 初稿证据范围：技能里已是这条默认；卡片一键记下，不必每次手写。 */
export const DRAFT_EVIDENCE_DECISION_Q =
  "写作依据的已评阅证据与结论范围（仅探索/待补时明确草稿边界）";
export const DRAFT_EVIDENCE_DEFAULT =
  "按已精读笔记写，没全文的只写到摘要";

/** 合同口吻的题 → 界面上的人话。存草稿仍用原题，避免改文案丢答案。 */
const DECISION_ASK: Record<string, string> = {
  [DRAFT_EVIDENCE_DECISION_Q]:
    "初稿可以依据哪些已经评过的笔记？结论能写到哪一步？",
};

export function decisionAsk(q: string): string {
  const t = q.trim();
  return DECISION_ASK[t] ?? t;
}

export interface DecisionRecord {
  q: string;
  /** 旧纯文本没有状态，不能当成已批准。 */
  status: DecisionStatus | "legacy";
  note: string;
  boundRevision: string | null;
}

const STATUS_MARK = new RegExp(
  `^\\[(${Object.values(DECISION_STATUS).join("|")})\\](?: 绑定:([0-9a-fA-F.]{8,64}))?(?:\\s+(.*))?$`,
);

const MARK_TO_STATUS = Object.fromEntries(
  (Object.entries(DECISION_STATUS) as [DecisionStatus, string][]).map(([k, v]) => [v, k]),
) as Record<string, DecisionStatus>;

export function formatDecisionAnswer(
  status: DecisionStatus,
  note: string,
  boundRevision?: string | null,
): string {
  const bind = boundRevision?.trim() ? ` 绑定:${boundRevision.trim()}` : "";
  const text = note.trim();
  return `[${DECISION_STATUS[status]}]${bind}${text ? ` ${text}` : ""}`;
}

export function parseDecisionAnswer(answer: string): Omit<DecisionRecord, "q"> {
  const raw = answer.trim();
  const match = STATUS_MARK.exec(raw);
  if (!match) return { status: "legacy", note: raw, boundRevision: null };
  return {
    status: MARK_TO_STATUS[match[1]],
    boundRevision: match[2] ?? null,
    note: (match[3] ?? "").trim(),
  };
}

export function parseDecisionRecords(draft: string): Map<string, DecisionRecord> {
  const out = new Map<string, DecisionRecord>();
  for (const [q, answer] of parseDecisions(draft)) {
    out.set(q, { q, ...parseDecisionAnswer(answer) });
  }
  return out;
}

export function evidenceFingerprint(
  reports: { path: string; revision: string | null }[],
): string | null {
  const parts = reports
    .filter((r) => r.revision)
    .map((r) => `${r.path}:${r.revision}`)
    .sort();
  if (!parts.length) return null;
  const joined = parts.join("|");
  let hash = 2166136261;
  for (let i = 0; i < joined.length; i++) {
    hash ^= joined.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** 定位已定方向小节的行区间 [start, end)；start = -1 表示草稿里还没有这个小节。
 *
 *  小节的结束 = 第一个「既不是空行、也不是答案行」的行。不能图省事写成「下一个 ## 标题或文件末尾」：
 *  小节后面跟的若是没有标题的自由正文，那种写法会把正文一并算进小节，
 *  于是 upsertDecisions 重写小节时把人写的正文删掉（真丢数据），
 *  isDecisionsOnly 也会把有正文的草稿误判成「只有拍板结果」。 */
function locateSection(lines: string[]): { start: number; end: number } {
  const start = lines.findIndex((l) => l.trim() === DECISIONS_HEADING);
  if (start < 0) return { start: -1, end: lines.length };
  let end = lines.length;
  for (let j = start + 1; j < lines.length; j++) {
    const t = lines[j].trim();
    if (t === "" || ANSWER_LINE.test(t)) continue;
    end = j;
    break;
  }
  return { start, end };
}

/** 读出小节内的答案（保序）：问题 → 答案 */
function readAnswers(lines: string[]): {
  order: string[];
  map: Map<string, string>;
} {
  const order: string[] = [];
  const map = new Map<string, string>();
  for (const line of lines) {
    const m = ANSWER_LINE.exec(line.trim());
    if (!m) continue;
    const q = m[1].trim();
    const answer = m[2].trim();
    if (!q || !answer) continue;
    if (!map.has(q)) order.push(q);
    map.set(q, answer);
  }
  return { order, map };
}

/** 从草稿正文解析已定答案：问题 → 答案。
 *  只认「已定方向」小节内的行——小节外正文里同形的句子不算数，避免把 agent 写的散文吃进来 */
export function parseDecisions(draft: string): Map<string, string> {
  const lines = draft.split(/\r?\n/);
  const { start, end } = locateSection(lines);
  if (start < 0) return new Map();
  return readAnswers(lines.slice(start + 1, end)).map;
}

/** 写入/更新答案，返回新草稿全文。
 *  批量入参是为了「全部用推荐值」只写一次盘（也少一次和 agent 并发改草稿的窗口）。
 *  小节已存在 = 原地替换（保留小节外的全部内容）；不存在 = 新建，插在首个一级标题之后，
 *  草稿通常以「# 任务书草稿：<步骤>」开头，已定方向紧随其后是这份合同里最该先被读到的部分。 */
export function upsertDecisions(
  draft: string,
  answers: { q: string; answer: string }[],
): string {
  const clean = answers
    .map((a) => ({ q: a.q.trim(), answer: a.answer.trim() }))
    .filter((a) => a.q && a.answer);
  if (clean.length === 0) return draft;

  const lines = draft.split(/\r?\n/);
  const { start, end } = locateSection(lines);
  const { order, map } =
    start >= 0
      ? readAnswers(lines.slice(start + 1, end))
      : { order: [] as string[], map: new Map<string, string>() };

  for (const { q, answer } of clean) {
    if (!map.has(q)) order.push(q);
    map.set(q, answer);
  }
  const section = [
    DECISIONS_HEADING,
    "",
    ...order.map((q) => `- ${q}：${map.get(q)}`),
    "",
  ];

  if (start >= 0) {
    return [...lines.slice(0, start), ...section, ...lines.slice(end)].join(
      "\n",
    );
  }
  const headIdx = lines.findIndex((l) => l.startsWith("# "));
  const at = headIdx >= 0 ? headIdx + 1 : 0;
  const before = lines.slice(0, at);
  // 标题与小节之间留一个空行，不贴着写
  const pad =
    before.length > 0 && before[before.length - 1].trim() !== "" ? [""] : [];
  return [...before, ...pad, ...section, ...lines.slice(at)].join("\n");
}

/** 开工表单逐项编辑；清空时真正撤掉该答案，不保留旧批准，也不修改其他正文。 */
export function setDecisionAnswer(draft: string, question: string, answer: string): string {
  if (answer.trim()) return upsertDecisions(draft, [{ q: question, answer }]);
  const lines = draft.split(/\r?\n/);
  const { start, end } = locateSection(lines);
  if (start < 0) return draft;
  return lines.filter((line, index) => {
    if (index <= start || index >= end) return true;
    const match = ANSWER_LINE.exec(line.trim());
    return !match || match[1].trim() !== question.trim();
  }).join("\n");
}

/** 去掉「已定方向」小节后的剩余正文（trim 后） */
export function stripDecisions(draft: string): string {
  const lines = draft.split(/\r?\n/);
  const { start, end } = locateSection(lines);
  if (start < 0) return draft.trim();
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n").trim();
}

/** append_step_draft 写的评审沉淀小节标题。
 *  完整形如「## 上一步（lit-search）评审沉淀（2026-09-18T08:18:13Z）」；
 *  测试与旧调用也可能不带工作区名。`.+?` 非贪婪，避免把时间戳括号吞进去。 */
const REVIEW_DISTILL_HEADING = /^##\s+上一步(?:（.+?）)?评审沉淀/;

function isAtxHeading(line: string): boolean {
  return /^#{1,6}\s/.test(line.trim());
}

function isH2(line: string): boolean {
  return /^##\s+/.test(line.trim());
}

/** 草稿里所有评审沉淀小节（标题+正文），多段之间空行分隔。 */
export function reviewDistillSections(draft: string): string {
  const lines = draft.split(/\r?\n/);
  const out: string[] = [];
  let capturing = false;
  const chunk: string[] = [];
  const flush = () => {
    const text = chunk.join("\n").trim();
    if (text) out.push(text);
    chunk.length = 0;
  };
  for (const line of lines) {
    const t = line.trim();
    if (REVIEW_DISTILL_HEADING.test(t)) {
      if (capturing) flush();
      capturing = true;
      chunk.push(line);
      continue;
    }
    if (capturing) {
      if (isH2(t) && !REVIEW_DISTILL_HEADING.test(t)) {
        flush();
        capturing = false;
      } else {
        chunk.push(line);
      }
    }
  }
  if (capturing) flush();
  return out.join("\n\n").trim();
}

/** 去掉已定方向、评审沉淀和纯标题行后的剩余正文。空串 = 没有可执行任务书。 */
export function stripTaskMdChrome(draft: string): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of stripDecisions(draft).split(/\r?\n/)) {
    const t = line.trim();
    if (REVIEW_DISTILL_HEADING.test(t)) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (isH2(t) && !REVIEW_DISTILL_HEADING.test(t)) {
        skipping = false;
      } else {
        continue;
      }
    }
    if (!t || isAtxHeading(t)) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

/** 这份草稿还没有可执行任务书正文。
 *
 *  空文件、只剩标题、只点了决策项、评审「沉淀到下一步」新建的小节——都不是任务书。
 *  开工/预览/播种若把它们当全文，会把模板简报、预期产物、技能、人工事项整份顶掉。 */
export function isTaskMdStub(draft: string): boolean {
  if (!draft.trim()) return true;
  return stripTaskMdChrome(draft).length === 0;
}

/** 模板拼装后面接上草稿里的评审沉淀（已有同样段落不重复）。 */
export function withReviewDistill(
  assembled: string,
  draft: string | null | undefined,
): string {
  const sections = reviewDistillSections(draft ?? "");
  if (!sections) return assembled;
  if (assembled.includes(sections)) return assembled;
  return `${assembled.trimEnd()}\n\n${sections}\n`;
}

/** 开工弹层 / 预览 / 播种共用：有可执行正文用文件全文；否则模板拼装并接上评审沉淀。 */
export function resolveTaskMdSource(
  draft: string | null | undefined,
  assembled: string,
): string {
  const raw = draft?.trim() ?? "";
  if (raw && !isTaskMdStub(raw)) return draft ?? assembled;
  return withReviewDistill(assembled, raw);
}

/** 草稿是不是「只有拍板结果、没有正文」。
 *
 *  这个判定是给开工用的：开工弹层的规则是「草稿非空则草稿全文顶掉模板拼装」（v3.72），
 *  那条规则的前提是草稿里有人/agent 写出来的实质内容。只点了几个选项就生成的草稿
 *  不该把整份简报顶掉——那样 agent 会拿到一份没有任务的任务书。
 *  这种草稿走模板拼装（拼装里已经带上「已定方向」段），只有真写了正文才走草稿全文。
 *
 *  只剩标题行（如 append_step_draft 建的「# 任务书草稿：<步骤>」）也算没有正文。
 *  开工/预览/播种的完整闸门是 isTaskMdStub（还覆盖空文件与评审沉淀 stub）。 */
export function isDecisionsOnly(draft: string): boolean {
  if (!draft.trim()) return false;
  if (parseDecisions(draft).size === 0) return false;
  const rest = stripDecisions(draft)
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^#{1,6}\s/.test(l.trim()));
  return rest.length === 0;
}

/** 已定方向按模板顺序排成 TASK.md 用的数组（模板里没有的问题排在后面，不丢人手写的条目） */
export function orderedAnswers(
  decisions: StepDecisionDto[],
  answered: Map<string, string>,
): { q: string; answer: string }[] {
  const out: { q: string; answer: string }[] = [];
  const seen = new Set<string>();
  for (const d of decisions) {
    const q = d.q.trim();
    const answer = answered.get(q);
    if (answer) {
      out.push({ q, answer });
      seen.add(q);
    }
  }
  for (const [q, answer] of answered) {
    if (!seen.has(q)) out.push({ q, answer });
  }
  return out;
}

/** 还没拍板的决策项（顺序同模板）：节点标题的「N 件事」与「全部用推荐值」都按它算 */
export function unansweredDecisions(
  decisions: StepDecisionDto[],
  answered: Map<string, string>,
): StepDecisionDto[] {
  return decisions.filter((d) => !answered.has(d.q.trim()));
}

export type DecisionGapReason = "unanswered" | "legacy" | "stale" | "wait" | "reject";

function gapReason(
  record: DecisionRecord | undefined,
  currentRevision: string | null,
): DecisionGapReason | null {
  if (!record) return "unanswered";
  if (record.status === "legacy") return "legacy";
  if (record.status === "wait") return "wait";
  if (record.status === "reject") return "reject";
  if ((record.status === "approve" || record.status === "prepare") && !record.note) {
    return "unanswered";
  }
  if (
    currentRevision &&
    record.boundRevision &&
    (record.status === "approve" || record.status === "prepare") &&
    record.boundRevision !== currentRevision
  ) {
    return "stale";
  }
  return null;
}

/** 开工门禁认决定状态，不把非空说明或「同意／拒绝」关键词当成授权。
 *  旧纯文本必须重新确认。证据版本变化后，已绑定的批准／准备失效。 */
export function decisionGate(
  step: { decisionMode?: string; decisions?: StepDecisionDto[] },
  draft: string,
  currentRevision?: string | null,
) {
  const mode = step.decisionMode === "hard_pause" || step.decisionMode === "soft_pause"
    ? step.decisionMode : "auto_continue";
  const records = parseDecisionRecords(draft);
  const gaps: { q: string; reason: DecisionGapReason }[] = [];
  let prepareOnly = false;
  for (const d of step.decisions ?? []) {
    const q = d.q.trim();
    const record = records.get(q);
    const reason = gapReason(record, currentRevision ?? null);
    if (reason) gaps.push({ q, reason });
    else if (record?.status === "prepare") prepareOnly = true;
  }
  const missing = gaps.map((g) => g.q);
  const blocked = mode === "hard_pause" && gaps.length > 0;
  const needsAck =
    (mode === "soft_pause" && gaps.length > 0) ||
    (mode === "hard_pause" && !blocked && prepareOnly);
  return { mode, missing, gaps, blocked, needsAck, prepareOnly };
}

/** 决策暂停策略才是停工门：批次提交/进度汇报不是。开步首条与「继续」共用。 */
export const KEEP_WORKING_CLAUSE =
  "一批工作、一次 git 提交或进度汇报不是停工理由；未达完成标准且不必拍板时，用户没说停就继续。";

/** 卡片「继续」预填：接回已有步骤，不是新开一轮。 */
export const CONTINUE_STEP_PROMPT =
  `阅读 TASK.md 并继续做到完成标准。停哪些见「决策暂停策略」。${KEEP_WORKING_CLAUSE}`;

/** 换 Agent 继续：先读接力简报，再按完成标准往下做。简报不是原会话。 */
export function continueWithBriefPrompt(briefRel: string): string {
  return `读 ${briefRel} 接力简报，按这份简报接着做。${CONTINUE_STEP_PROMPT}`;
}

export function decisionPolicyText(mode: string | undefined): string {
  if (mode === "hard_pause") {
    return "hard_pause：遇到新的待拍板问题，写入 .ccode/help-wanted.md 并暂停本步骤，等待人明确答复后继续；不得自行采用推荐值或「未回复即继续」。";
  }
  if (mode === "soft_pause") {
    return "soft_pause：遇到待拍板问题，写入 .ccode/help-wanted.md 并暂停受影响的操作；只可推进无依赖、可逆的部分，等待人明确答复后恢复受影响的操作。";
  }
  return "auto_continue：一般问题写入 .ccode/help-wanted.md 并附可逆兜底方案，可按兜底继续；涉及目标/对象范围、关键处理规则、结论范围、隐私、伦理、合规、主指标或不可逆操作时必须等待人明确授权，不得默认同意。";
}

type WaitStep = {
  name?: string;
  workspaceName?: string;
  brief?: string;
  decisionMode?: string;
  decisions?: { q: string }[];
  humanTasks?: { title: string; timing?: string; optional?: boolean }[];
};

function humanTitle(title: string): string {
  return title.replace(/^（可选）\s*/, "").trim();
}

function isLayoutProofStep(step: WaitStep): boolean {
  const n = `${step.name ?? ""} ${step.workspaceName ?? ""}`;
  return /格式适配|期刊格式|journal-format|latex-final/.test(n);
}

/** 从本步已有合同派生必须停的事项：拍板题、先报再问、开工前/执行中人工、排版样张。 */
export function stepWaitItems(step: WaitStep): { during: string[]; after: string[] } {
  const during: string[] = [];
  const after: string[] = [];
  const mode = step.decisionMode === "hard_pause" || step.decisionMode === "soft_pause"
    ? step.decisionMode : "auto_continue";
  for (const d of step.decisions ?? []) {
    const q = d.q.trim();
    if (!q) continue;
    if (mode === "hard_pause") during.push(`拍板后再锁范围：${q}`);
    else if (mode === "soft_pause") during.push(`未答则只做无依赖准备：${q}`);
  }
  const brief = step.brief ?? "";
  if (/help-wanted\.md/.test(brief) && /问用户/.test(brief)) {
    during.push(
      "简报里「先报依据再问」的那一项：写入 .ccode/help-wanted.md；问完按该条兜底做无依赖准备，未答不得锁死标准、核心篇目、大纲骨架或目标期刊",
    );
  }
  for (const h of step.humanTasks ?? []) {
    if (h.optional) continue;
    const title = humanTitle(h.title);
    if (!title) continue;
    if (h.timing === "before") during.push(`开工前等你做完：${title}`);
    else if (h.timing === "during") during.push(`执行中等你交付：${title}`);
    else if (h.timing === "after") after.push(`完成后交给你：${title}`);
  }
  if (isLayoutProofStep(step)) {
    after.push("渲染出样张后停下来让你看版式与裁剪，不要未经你看就当排版通过");
  }
  return { during, after };
}

/** 写入 TASK.md 的整段：模式说明 + 本步停哪些 + 其余做到做完。 */
export function decisionPolicyBlock(step: WaitStep): string {
  const lines = [decisionPolicyText(step.decisionMode)];
  const { during, after } = stepWaitItems(step);
  if (during.length === 0) {
    lines.push("本步中途没有必须等人拍板的事项。");
  } else {
    lines.push("本步必须停下来等你：");
    for (const item of during) lines.push(`- ${item}`);
  }
  if (after.length > 0) {
    lines.push("达到完成标准后交给你（不要自行宣称已通过）：");
    for (const item of after) lines.push(`- ${item}`);
  }
  lines.push(KEEP_WORKING_CLAUSE);
  return lines.join("\n");
}

/** 「全部用推荐值」要写入的答案：未答项取首个选项（模板里首项即推荐值）；
 *  已答的一律不动——用户显式选过的不该被一键覆盖 */
export function recommendedAnswers(
  decisions: StepDecisionDto[],
  answered: Map<string, string>,
): { q: string; answer: string }[] {
  return unansweredDecisions(decisions, answered)
    .filter((d) => d.options.length > 0)
    .map((d) => ({ q: d.q.trim(), answer: formatDecisionAnswer("approve", d.options[0]) }));
}
