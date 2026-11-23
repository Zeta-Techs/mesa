/**
 * 步骤收尾「下一步建议」完整引擎（.ccode/next-actions.json + 确定性台账兜底 + 持久化）：
 * 1. 有 Agent 写的 .ccode/next-actions.json（或合并后镜像在项目根 .ccode/step-next/<slug>.json）时优先展示；
 * 2. Agent 漏写时按本步真实台账（included.json / notes/index.json / handoff.md / outline.md 覆盖检查 / 稿件与核验）
 *    确定性合成同一套三档建议卡（零 AI 成本），任何步骤跑完都不再空白；
 * 3. 支持全流程动作：去评审 / 去下一步 / 跟进更新 / 核对待确认 / 优先补全文（含实时已补进度 + 补完一键重读）/
 *    补文献双栏与退回修改预填 / 记进项目知识 / 看文件 / 去抽查 / 回对话。
 */

import { coverageReworkDrafts, groupCoverageDrafts } from "./step-loop.ts";
import { parseIncludedRecords } from "./screening-review.ts";
import {
  isEndnoteTaskTitle,
  isToFetchSkipped,
  missingToFetchCount,
  stripOptionalTitlePrefix,
} from "./step-flow.ts";
import { isFieldDocRefreshTitle } from "./step-node-actions.ts";
import { stepFillsAnySlot } from "./skill-slots.ts";

export type StepNextActionKind =
  | "review"
  | "next_step"
  | "follow_upstream"
  | "confirm_pending"
  | "fetch_pdf"
  | "reread_pdfs"
  | "return_step"
  | "remember"
  | "open_file"
  | "spot_check"
  | "continue_chat";

export interface StepNextOption {
  id: string;
  label: string;
  detail?: string;
  action: StepNextActionKind;
  buttonText?: string;
  /** return_step 用：目标步骤、找新文献/修改主题、精读已有的（补文献双栏）、原因 */
  targetStep?: string;
  topics?: string;
  reads?: string;
  reason?: string;
  /** fetch_pdf 用：优先补全文的 DOI 或键/标题关键词 */
  priorityDois?: string[];
  priorityKeys?: string[];
  /** remember 用：记进项目知识「已定 / 不做」的一句话 */
  memoryText?: string;
  /** open_file 用：相对路径（如 notes/angles.md） */
  file?: string;
}

export interface StepNextActions {
  readiness: "ready" | "blocked";
  summary: string;
  primaryAction?: StepNextActionKind;
  optional: StepNextOption[];
  handedOff?: string;
  /** true = 未找到 .ccode/next-actions.json，由 Mesa 从本步台账确定性合成 */
  synthesized?: boolean;
}

const VALID_ACTIONS = new Set<StepNextActionKind>([
  "review",
  "next_step",
  "follow_upstream",
  "confirm_pending",
  "fetch_pdf",
  "reread_pdfs",
  "return_step",
  "remember",
  "open_file",
  "spot_check",
  "continue_chat",
]);

function asAction(raw: unknown): StepNextActionKind | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim() as StepNextActionKind;
  return VALID_ACTIONS.has(v) ? v : undefined;
}

function asStr(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function asStrList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items = raw
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export function defaultActionButtonText(action: StepNextActionKind): string {
  switch (action) {
    case "review":
      return "去评审";
    case "next_step":
      return "去下一步";
    case "follow_upstream":
      return "跟进更新";
    case "confirm_pending":
      return "去核对";
    case "fetch_pdf":
      return "补全文";
    case "reread_pdfs":
      return "重读已补全文";
    case "return_step":
      return "退回处理";
    case "remember":
      return "记进项目知识";
    case "open_file":
      return "查看文件";
    case "spot_check":
      return "去抽查";
    case "continue_chat":
      return "回对话处理";
  }
}

/** 与 Rust persist_step_next_actions 完全一致的目录名清洗，用于合并后按步骤读 .ccode/step-next/<slug>.json */
export function nextActionStepSlug(workspaceName: string | null | undefined): string {
  return (workspaceName ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** 宽容解析 .ccode/next-actions.json（允许外层 ```json 围栏），格式非法或空 summary 返回 null。 */
export function parseStepNextActions(raw: string): StepNextActions | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const summary = asStr(obj.summary);
  if (!summary) return null;
  const readiness = obj.readiness === "blocked" ? "blocked" : "ready";
  const primaryAction = asAction(obj.primaryAction);
  const handedOff = asStr(obj.handedOff) || undefined;
  const rawOpts = Array.isArray(obj.optional) ? obj.optional : [];
  const optional: StepNextOption[] = [];
  for (let i = 0; i < rawOpts.length && optional.length < 6; i += 1) {
    const entry = rawOpts[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const label = asStr(rec.label);
    const rawAction = asAction(rec.action);
    if (!label || !rawAction) continue;
    const file = asStr(rec.file) || undefined;
    // spot_check 专指精读步「抽查 3 篇笔记」面板（不带 file）；
    // 实测初稿 Agent 会把「人工逐图确认 → 打开 figures/README.md」误写成 spot_check + file，
    // 带 file 时归并成 open_file，点按钮直接打开该核对清单，不再误弹「请在下方抽查 3 篇笔记」
    const action: StepNextActionKind =
      rawAction === "spot_check" && file ? "open_file" : rawAction;
    const id = asStr(rec.id) || `opt-${i + 1}`;
    optional.push({
      id,
      label,
      detail: asStr(rec.detail) || undefined,
      action,
      buttonText: asStr(rec.buttonText) || undefined,
      targetStep: asStr(rec.targetStep) || undefined,
      topics: asStr(rec.topics) || undefined,
      reads: asStr(rec.reads) || undefined,
      reason: asStr(rec.reason) || undefined,
      priorityDois: asStrList(rec.priorityDois),
      priorityKeys: asStrList(rec.priorityKeys),
      memoryText: asStr(rec.memoryText) || undefined,
      file,
    });
  }
  return { readiness, summary, primaryAction, optional, handedOff };
}

/** 按当前步骤真实状态算出主线按钮（有跟进更新提示时让位，守住一屏一主动作） */
export function resolveStepNextPrimary(
  plan: StepNextActions,
  ctx: {
    runStatus: "pending" | "active" | "done";
    hasNextStep: boolean;
    nextStepName?: string | null;
    reviewConflict?: boolean;
    hasFollowNudge?: boolean;
  },
): { action: StepNextActionKind; label: string; emphasize: boolean; optionId?: string } | null {
  if (ctx.hasFollowNudge) {
    // 顶部「跟进更新」已经是唯一强调色主动作，卡内不重复放第二个抢焦点的主按钮
    return null;
  }
  if (ctx.runStatus === "done") {
    if (!ctx.hasNextStep) return null;
    const name = ctx.nextStepName?.trim();
    return {
      action: "next_step",
      label: name ? `去下一步：${name}` : "去下一步",
      emphasize: true,
    };
  }
  if (ctx.reviewConflict) {
    return { action: "review", label: "去处理冲突", emphasize: false };
  }
  if (plan.readiness === "blocked" || plan.primaryAction === "continue_chat") {
    // 阻塞在等待退回上游补料/补文献（如大纲第⑥问选补读）：卡面主按钮直连该补料动作，不再误导回本步对话
    const returnOpt =
      plan.readiness === "blocked"
        ? plan.optional.find((o) => o.action === "return_step")
        : undefined;
    if (returnOpt) {
      return {
        action: "return_step",
        label: returnOpt.buttonText?.trim() || "去退回补料",
        emphasize: true,
        optionId: returnOpt.id,
      };
    }
    return { action: "continue_chat", label: "回对话补完", emphasize: false };
  }
  // active 态下下方「你核对后」节点已带强调色「去评审」，卡内主按钮保持次级线框，守住一屏一主动作
  return { action: "review", label: "去评审", emphasize: false };
}

function normToken(s: string): string {
  return s.toLowerCase().replace(/^@/, "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").trim();
}

/** 待获取清单行是否命中「本步优先补全文」列表（按 DOI 或作者年份/键匹配） */
export function matchesPriorityFetch(
  item: { title: string; url?: string; doi?: string },
  priorityDois: readonly string[],
  priorityKeys: readonly string[],
): boolean {
  if (priorityDois.length === 0 && priorityKeys.length === 0) return false;
  const hayUrl = normToken(item.doi || item.url || "");
  if (hayUrl) {
    for (const d of priorityDois) {
      const nd = normToken(d);
      if (nd && (hayUrl === nd || hayUrl.includes(nd))) return true;
    }
  }
  const hayTitle = item.title.toLowerCase();
  for (const rawKey of priorityKeys) {
    const key = normToken(rawKey);
    if (!key) continue;
    if (hayUrl.includes(key) || hayTitle.includes(key)) return true;
  }
  return false;
}

export interface PriorityFetchProgress {
  total: number;
  saved: number;
  savedTitles: string[];
  savedFiles: string[];
}

/** 实时核算某条 fetch_pdf 建议的真实补齐进度（对照 to-fetch.md 与 papers/ 扫描结果；跳过/仅摘要的篇不计入待补总数） */
export function priorityFetchProgress(
  items: readonly { line: number; title: string; url: string; done: boolean; skipped?: boolean }[],
  toFetchDone: Readonly<Record<number, string>>,
  priorityDois: readonly string[],
  priorityKeys: readonly string[],
  skippedKeys?: ReadonlySet<string>,
): PriorityFetchProgress {
  const matched =
    priorityDois.length > 0 || priorityKeys.length > 0
      ? items.filter((item) => matchesPriorityFetch(item, priorityDois, priorityKeys))
      : [...items];
  const savedTitles: string[] = [];
  const savedFiles: string[] = [];
  let activeTotal = 0;
  for (const item of matched) {
    const file = toFetchDone[item.line];
    if (item.done || file) {
      activeTotal += 1;
      savedTitles.push(item.title);
      if (file) savedFiles.push(`papers/${file}`);
    } else if (!isToFetchSkipped({ ...item, venue: "" }, skippedKeys)) {
      activeTotal += 1;
    }
  }
  return {
    total: activeTotal,
    saved: savedTitles.length,
    savedTitles,
    savedFiles,
  };
}

/** 用户补齐优先 PDF 后「重读已补全文」发给精读步的精准提示 */
export function rereadPdfsTopics(savedTitles: readonly string[], savedFiles: readonly string[]): string {
  const lines = savedTitles.map((title, i) => {
    const file = savedFiles[i];
    return file ? `${title}（${file}）` : title;
  });
  return lines.join("\n");
}

// ---------- 按步骤持久化已处理的顺手项 / 展开态 / 上一步提醒收起（localStorage） ----------

const CHECK_STORE_PREFIX = "ccode.stepNextChecks.v1:";
const NEXT_OPEN_PREFIX = "ccode.stepNextOpen.v1:";
const PREV_FOLLOWUP_DISMISS_PREFIX = "ccode.prevFollowupDismiss.v1:";

export function readNextActionChecks(projectPath: string, stepName: string): Set<string> {
  try {
    const raw = localStorage.getItem(`${CHECK_STORE_PREFIX}${projectPath}\n${stepName}`);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeNextActionChecks(
  projectPath: string,
  stepName: string,
  ids: ReadonlySet<string>,
): void {
  try {
    localStorage.setItem(
      `${CHECK_STORE_PREFIX}${projectPath}\n${stepName}`,
      JSON.stringify([...ids]),
    );
  } catch {
    /* 隐私模式或空间满时静默退化 */
  }
}

/** 读取用户对某步「后续建议」的手动展开/收起选择；null 表示跟随自动策略（有未勾项展开、全处理完收起） */
export function readNextActionsOpen(projectPath: string, stepName: string): boolean | null {
  try {
    const raw = localStorage.getItem(`${NEXT_OPEN_PREFIX}${projectPath}\n${stepName}`);
    return raw === "1" ? true : raw === "0" ? false : null;
  } catch {
    return null;
  }
}

export function writeNextActionsOpen(
  projectPath: string,
  stepName: string,
  open: boolean | null,
): void {
  try {
    const key = `${NEXT_OPEN_PREFIX}${projectPath}\n${stepName}`;
    if (open === null) localStorage.removeItem(key);
    else localStorage.setItem(key, open ? "1" : "0");
  } catch {
    /* 静默退化 */
  }
}

export function readPrevFollowupDismissed(projectPath: string, prevStepName: string): string | null {
  try {
    return localStorage.getItem(`${PREV_FOLLOWUP_DISMISS_PREFIX}${projectPath}\n${prevStepName}`);
  } catch {
    return null;
  }
}

export function writePrevFollowupDismissed(
  projectPath: string,
  prevStepName: string,
  stamp: string,
): void {
  try {
    localStorage.setItem(`${PREV_FOLLOWUP_DISMISS_PREFIX}${projectPath}\n${prevStepName}`, stamp);
  } catch {
    /* 静默退化 */
  }
}

/** 与 StepFlow 同一口径：该步骤是否有「同步到文献库」保存后可做行 */
export function isEndnoteExportStep(step: {
  workspaceName?: string;
  humanTasks?: Array<{ title: string }>;
}): boolean {
  const ws = step.workspaceName ?? "";
  return (
    ws === "draft" ||
    ws === "paper-draft" ||
    ws === "thesis-draft" ||
    ws === "journal-format" ||
    ws === "submission-materials" ||
    /^rebuttal-r\d+$/.test(ws) ||
    (step.humanTasks ?? []).some((h) => isFieldDocRefreshTitle(h.title))
  );
}

/** 计算某一步保存后才解锁的「保存后可做」标签列表（单一出处，评审完成条与下一步提醒共用） */
export function stepAfterSaveLabels(
  step: {
    workspaceName?: string;
    skills?: string[];
    humanTasks?: Array<{ title: string; timing?: string; optional?: boolean }>;
  },
  skillProvides?: Record<string, string[]>,
): string[] {
  const labels: string[] = [];
  const afterEndnote = (step.humanTasks ?? []).filter(
    (h) => (h.timing ?? "after") === "after" && h.optional && isEndnoteTaskTitle(h.title),
  );
  for (const h of afterEndnote) {
    const label = stripOptionalTitlePrefix(h.title).trim();
    if (label && !labels.includes(label)) labels.push(label);
  }
  if (isEndnoteExportStep(step) && afterEndnote.length === 0) {
    labels.push("同步到文献库");
  }
  if (stepFillsAnySlot(step.skills, ["lit-notes"], skillProvides)) {
    labels.push("继续精读笔记");
  }
  return labels;
}

export interface PostSaveFollowupSummary {
  stepName: string;
  pendingCount: number;
  pendingPreviews: string[];
  afterSaveLabels: string[];
  totalCount: number;
  /** 可直接展示在保存成功条或下一步顶部的紧凑一句说明 */
  summaryText: string;
}

/** 汇总已保存步骤尚未处理的「后续建议」与「保存后可做」；全为空时返回 null（不打扰） */
export function summarizePostSaveFollowup(input: {
  stepName: string;
  nextActions: StepNextActions | null;
  doneIds: ReadonlySet<string>;
  afterSaveLabels: readonly string[];
}): PostSaveFollowupSummary | null {
  const pendingOptions = (input.nextActions?.optional ?? []).filter(
    (o) => !input.doneIds.has(o.id),
  );
  const pendingPreviews = pendingOptions
    .slice(0, 2)
    .map((o) => o.label.replace(/（[^）]*）/g, "").replace(/\([^)]*\)/g, "").trim())
    .filter(Boolean);
  const afterSave = [...new Set(input.afterSaveLabels.map((s) => s.trim()).filter(Boolean))];
  const pendingCount = pendingOptions.length;
  const totalCount = pendingCount + afterSave.length;
  if (totalCount === 0) return null;

  const parts: string[] = [];
  if (pendingCount > 0) {
    const preview = pendingPreviews.length > 0 ? `（${pendingPreviews.join(" · ")}${pendingCount > 2 ? "…" : ""}）` : "";
    parts.push(`${pendingCount} 项后续建议${preview}`);
  }
  if (afterSave.length > 0) {
    parts.push(`「保存后可做」（${afterSave.join("、")}）`);
  }
  return {
    stepName: input.stepName,
    pendingCount,
    pendingPreviews,
    afterSaveLabels: afterSave,
    totalCount,
    summaryText: `还有 ${parts.join(" 与 ")}`,
  };
}

// ---------- 确定性兜底合成（Agent 未写 .ccode/next-actions.json 时从台账直接算） ----------

export interface SynthesizeStepNextInput {
  stepKind: "search" | "notes" | "outline" | "draft" | "final" | "other";
  /** 本步骤是否已经评审并保存进项目（done）：为真时用过去时态，不再说「可直接评审保存」 */
  saved?: boolean;
  nextStepName?: string | null;
  searchStepName?: string | null;
  notesStepName?: string | null;
  includedJsonText?: string | null;
  toFetchText?: string | null;
  toFetchDone?: Readonly<Record<number, string>>;
  toFetchSkipped?: ReadonlySet<string>;
  notesIndexText?: string | null;
  handoffText?: string | null;
  hasAngles?: boolean;
  hasExtraction?: boolean;
  hasScreening?: boolean;
  outlineText?: string | null;
  manuscriptFile?: string | null;
  hasPermissions?: boolean;
  hasDeclarations?: boolean;
  firstExistingArtifact?: string | null;
}

/** 从 notes/handoff.md「## 不由下一步做」里提取 @bibKey（跳过材料/化学写法里的 @） */
function extractHandoffKeys(handoffText: string): string[] {
  const sec = handoffText.split(/^##\s+不由下一步做(?:\s|$)/m)[1] ?? "";
  if (!sec) return [];
  const body = sec.split(/^##\s+/m)[0] ?? sec;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of body.matchAll(/(?<![\p{L}\p{N}_@.\\)\]\}/₀-₉⁰-⁹⁺⁻])@([A-Za-z][A-Za-z0-9_:-]{2,})/gu)) {
    const k = m[1];
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

export function synthesizeStepNextActions(input: SynthesizeStepNextInput): StepNextActions | null {
  const saved = Boolean(input.saved);
  const nextSuffix = input.nextStepName ? `后进入「${input.nextStepName}」` : "";
  const savedNextSuffix = input.nextStepName ? `，可直接进入「${input.nextStepName}」` : "";

  if (input.stepKind === "search") {
    const records = input.includedJsonText ? parseIncludedRecords(input.includedJsonText) : [];
    const pending = records.filter((r) => r.decision === "pending").length;
    const missing = input.toFetchText
      ? missingToFetchCount(input.toFetchText, input.toFetchDone ?? {}, input.toFetchSkipped)
      : 0;
    if (records.length === 0 && !input.hasScreening) return null;
    const optional: StepNextOption[] = [];
    if (pending > 0) {
      optional.push({
        id: "synth-confirm-pending",
        label: `核对 ${pending} 篇待确认篇目（可批量纳入或移出）`,
        action: "confirm_pending",
        buttonText: "核对待确认",
      });
    }
    if (missing > 0) {
      optional.push({
        id: "synth-fetch-pdf",
        label: saved
          ? `补齐 ${missing} 篇缺全文 PDF（随时可补）`
          : `下载 ${missing} 篇缺全文 PDF（可先评审，后续随时补）`,
        action: "fetch_pdf",
        buttonText: "打开待获取",
      });
    }
    if (input.hasScreening) {
      optional.push({
        id: "synth-open-screening",
        label: "查看检索式与筛选记录",
        detail: "papers/screening.md",
        action: "open_file",
        buttonText: "看筛选报告",
        file: "papers/screening.md",
      });
    }
    return {
      readiness: "ready",
      summary: saved
        ? `本步检索成果已保存进项目${savedNextSuffix}${missing > 0 ? "（缺全文随时可补）" : ""}。`
        : pending > 0
          ? `还有 ${pending} 篇待确认，核完即可评审保存${nextSuffix}。`
          : `筛选清单已就绪${missing > 0 ? "（缺全文可后续再补）" : ""}，可直接评审保存${nextSuffix}。`,
      optional,
      handedOff: saved
        ? "纳入清单、待获取与两份 RIS 已进入项目，下游步骤自动读取。"
        : "纳入清单、待获取与两份 RIS 已就绪，保存后精读步会自动读取。",
      synthesized: true,
    };
  }

  if (input.stepKind === "notes") {
    let reviewed = 0;
    let skimmed = 0;
    let pendingCount = 0;
    const keyToId = new Map<string, string>();
    if (input.notesIndexText) {
      try {
        const rows = JSON.parse(input.notesIndexText);
        if (Array.isArray(rows)) {
          for (const r of rows) {
            if (!r || typeof r !== "object") continue;
            const rec = r as Record<string, unknown>;
            if (typeof rec.bibKey === "string" && typeof rec.id === "string") {
              keyToId.set(rec.bibKey, rec.id);
            }
            if (rec.reviewStatus === "reviewed") reviewed += 1;
            else if (rec.skimmed === true) skimmed += 1;
            else pendingCount += 1;
          }
        }
      } catch {
        /* 索引损坏时不崩 */
      }
    }
    if (reviewed === 0 && skimmed === 0 && !input.handoffText) return null;
    const optional: StepNextOption[] = [];
    const handoffKeys = input.handoffText ? extractHandoffKeys(input.handoffText) : [];
    const priorityDois: string[] = [];
    if (handoffKeys.length > 0 && input.includedJsonText) {
      const byId = new Map(
        parseIncludedRecords(input.includedJsonText).map((r) => [r.id, r]),
      );
      for (const k of handoffKeys) {
        const rec = byId.get(keyToId.get(k) ?? "");
        const url = rec?.url ?? "";
        const m = url.match(/10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/i);
        if (m) priorityDois.push(m[0]);
      }
    }
    const missingTotal = input.toFetchText
      ? missingToFetchCount(input.toFetchText, input.toFetchDone ?? {}, input.toFetchSkipped)
      : 0;
    if (priorityDois.length > 0 || missingTotal > 0) {
      optional.push({
        id: "synth-notes-fetch",
        label:
          priorityDois.length > 0
            ? `优先补齐 ${priorityDois.length} 篇核心缺全文 PDF`
            : `补充 ${missingTotal} 篇缺全文 PDF（可留到大纲点名后再补）`,
        detail: handoffKeys.length > 0 ? `${handoffKeys.slice(0, 4).join("、")}${handoffKeys.length > 4 ? " 等" : ""}` : undefined,
        action: "fetch_pdf",
        buttonText: priorityDois.length > 0 ? "优先补全文" : "打开待获取",
        priorityDois: priorityDois.length > 0 ? priorityDois : undefined,
        priorityKeys: handoffKeys.length > 0 ? handoffKeys : undefined,
      });
    }
    if (input.hasAngles) {
      optional.push({
        id: "synth-open-angles",
        label: "查看可写点与已有综述时效对照",
        detail: "notes/angles.md",
        action: "open_file",
        buttonText: "看可写点",
        file: "notes/angles.md",
      });
    }
    if (input.hasExtraction) {
      optional.push({
        id: "synth-open-extraction",
        label: "查看文献数据抽取表",
        detail: "notes/extraction.md",
        action: "open_file",
        buttonText: "看抽取表",
        file: "notes/extraction.md",
      });
    }
    optional.push({
      id: "synth-spot-check",
      label: "抽查 3 篇笔记对照原文（沉浸阅读）",
      action: "spot_check",
      buttonText: "去抽查",
    });
    const parts = [
      reviewed > 0 ? `精读 ${reviewed} 篇` : "",
      skimmed > 0 ? `速读 ${skimmed} 篇` : "",
      pendingCount > 0 ? `待补 ${pendingCount} 篇` : "",
    ].filter(Boolean);
    return {
      readiness: "ready",
      summary: saved
        ? `本步笔记已保存进项目${savedNextSuffix}。`
        : `${parts.length ? `${parts.join("、")}已就绪` : "精读笔记已就绪"}，可直接评审保存${nextSuffix}。`,
      optional,
      handedOff: input.handoffText
        ? saved
          ? "写作约束与交接清单已进入项目（notes/handoff.md），下游步骤自动读取。"
          : "写作约束与交接清单已写入 notes/handoff.md，下一步会自动读取。"
        : undefined,
      synthesized: true,
    };
  }

  if (input.stepKind === "outline" && input.outlineText) {
    const drafts = coverageReworkDrafts(input.outlineText);
    const searchDraft = groupCoverageDrafts(drafts, "search");
    const readDraft = groupCoverageDrafts(drafts, "read");
    const optional: StepNextOption[] = [];
    if (searchDraft || readDraft) {
      const target = searchDraft
        ? (input.searchStepName || input.notesStepName || "")
        : (input.notesStepName || input.searchStepName || "");
      const pieces = [
        searchDraft ? "找新文献" : "",
        readDraft ? "精读已有的核心篇" : "",
      ].filter(Boolean);
      if (target) {
        optional.push({
          id: "synth-outline-lit-loop",
          label: `按大纲覆盖检查补齐文献（${pieces.join(" + ")}）`,
          detail: "已从大纲自动提取薄节与点名篇目",
          action: "return_step",
          buttonText: "一键补文献",
          targetStep: target,
          topics: searchDraft?.topics ?? (readDraft && !searchDraft ? readDraft.topics : ""),
          reads: searchDraft && readDraft ? readDraft.topics : undefined,
          reason: [searchDraft?.reason, readDraft?.reason].filter(Boolean).join("；"),
        });
      }
    }
    optional.push({
      id: "synth-open-outline",
      label: "通读大纲框架与用图计划",
      detail: "outline.md",
      action: "open_file",
      buttonText: "看大纲",
      file: "outline.md",
    });
    return {
      readiness: "ready",
      summary: saved
        ? `大纲已保存${savedNextSuffix}${searchDraft || readDraft ? "（也可随时点「一键补文献」补强薄节）" : ""}。`
        : searchDraft || readDraft
          ? `大纲已成稿，覆盖检查标出了可补强的文献；可先「一键补文献」，也可直接评审保存${nextSuffix}。`
          : `大纲骨架与用图计划已齐，可直接评审保存${nextSuffix}。`,
      optional,
      handedOff: saved
        ? "大纲结构、各节论点与用图计划已进入项目，初稿步会自动读取。"
        : "大纲结构、各节论点与用图计划保存后将自动交给初稿步。",
      synthesized: true,
    };
  }

  if (input.stepKind === "draft" && input.manuscriptFile) {
    const optional: StepNextOption[] = [
      {
        id: "synth-open-draft",
        label: "浏览初稿正文与核验标注",
        detail: input.manuscriptFile,
        action: "open_file",
        buttonText: "看初稿",
        file: input.manuscriptFile,
      },
    ];
    return {
      readiness: "ready",
      summary: saved
        ? `初稿已保存${savedNextSuffix}。`
        : `初稿已生成，评审确认无关键缺口后即可保存${nextSuffix}。`,
      optional,
      handedOff: saved
        ? "初稿正文、图表清单与引文库已进入项目，润色与定稿步会自动读取。"
        : "初稿正文、图表清单与引文库保存后将自动带入润色与定稿。",
      synthesized: true,
    };
  }

  if (input.stepKind === "final") {
    const optional: StepNextOption[] = [];
    if (input.manuscriptFile) {
      optional.push({
        id: "synth-open-final",
        label: "核对最终定稿正文",
        detail: input.manuscriptFile,
        action: "open_file",
        buttonText: "看定稿",
        file: input.manuscriptFile,
      });
    }
    if (input.hasPermissions) {
      optional.push({
        id: "synth-open-perms",
        label: "查看转载许可与原图替换清单",
        detail: "submission/figure-permissions.md",
        action: "open_file",
        buttonText: "看许可清单",
        file: "submission/figure-permissions.md",
      });
    }
    if (input.hasDeclarations) {
      optional.push({
        id: "synth-open-decl",
        label: "核对作者、基金与投稿声明",
        detail: "submission/declarations.md",
        action: "open_file",
        buttonText: "看投稿声明",
        file: "submission/declarations.md",
      });
    }
    if (optional.length === 0) return null;
    return {
      readiness: "ready",
      summary: saved
        ? "润色与定稿已保存进项目，可随时核对转载许可与投稿声明。"
        : "润色与定稿产物已就绪，核对许可与投稿声明后即可保存交付。",
      optional,
      synthesized: true,
    };
  }

  if (input.firstExistingArtifact) {
    return {
      readiness: "ready",
      summary: saved
        ? `本步已保存${savedNextSuffix}。`
        : `本步产物已生成，评审核对后即可保存${nextSuffix}。`,
      optional: [
        {
          id: "synth-open-main",
          label: "查看本步主要产物",
          detail: input.firstExistingArtifact,
          action: "open_file",
          buttonText: "查看产物",
          file: input.firstExistingArtifact,
        },
      ],
      synthesized: true,
    };
  }

  return null;
}
