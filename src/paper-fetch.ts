// 全文代下队列的前端纯逻辑（后端 src-tauri/src/paper_fetch.rs，设计稿 docs/design-autonomy-roadmap.md §6）。
// 状态与出版商限速都在后端；这里只管人话文案、从待获取清单挑出能交的 DOI、汇总一行进度。

export interface PaperFetchLimits {
  perPublisherDaily: number;
  totalDaily: number;
  minGapSecs: number;
  maxGapSecs: number;
}

export interface PaperFetchCandidate {
  url: string;
  text: string;
}

export interface PaperFetchJob {
  id: string;
  doi: string;
  projectRoot: string;
  title: string;
  runId?: string | null;
  requester: "agent" | "human" | string;
  status: string;
  stage: string;
  createdAt: number;
  updatedAt: number;
  saved?: string | null;
  via?: string | null;
  error?: string | null;
  candidates: PaperFetchCandidate[];
  waiting?: string | null;
}

export interface PaperFetchPublisher {
  key: string;
  name: string;
  count: number;
  blockedUntil?: number | null;
  blockedReason: string;
}

export interface PaperFetchOverview {
  limits: PaperFetchLimits;
  ceiling: PaperFetchLimits;
  totalToday: number;
  publishers: PaperFetchPublisher[];
  paused?: string | null;
  sessionExpired: boolean;
  extensionAlive: boolean;
  jobs: PaperFetchJob[];
}

export interface PaperFetchLogEntry {
  at: number;
  doi: string;
  publisher: string;
  level: string;
  result: string;
  runId?: string | null;
  project: string;
}

const STATUS_LABEL: Record<string, string> = {
  needs_approval: "等你确认",
  queued: "排队中",
  browser: "等浏览器下载",
  needs_pick: "等 AI 选链接",
  done: "已下载",
  failed: "需要你自己下",
  cancelled: "已取消",
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

const VIA_LABEL: Record<string, string> = {
  oa: "开放获取",
  institutional: "学校账号",
  browser: "浏览器",
};

export function viaLabel(via: string | null | undefined): string {
  return via ? (VIA_LABEL[via] ?? via) : "";
}

const RESULT_LABEL: Record<string, string> = {
  ok: "下载成功",
  fallback: "改在浏览器里下",
  throttled: "出版商限流",
  session_expired: "学校登录已过期",
  save_failed: "存进项目失败",
  captcha: "要人机验证",
  blocked: "被出版商拒绝",
  login: "浏览器没登录学校账号",
  no_pdf: "页面上没找到 PDF",
  error: "出错",
};

export function logResultLabel(result: string): string {
  return RESULT_LABEL[result] ?? result;
}

/** 规整成小写裸 DOI；不像 DOI 返回 null（与后端 normalize_doi 同口径的子集） */
export function normalizeDoi(raw: string): string | null {
  let t = raw.trim();
  t = t.replace(/^(https?:\/\/)?(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "");
  t = t.replace(/[.,;)\]}]+$/, "").toLowerCase();
  return /^10\.\d{4,9}\/\S+$/.test(t) ? t : null;
}

/** 待获取清单里还没存、带 DOI 的条目：人点「让 Mesa 代下这批」时交这些 */
export function fetchableItems(
  items: { title: string; url: string; done: boolean; line: number }[],
  savedLines: Record<number, string>,
): { doi: string; title: string }[] {
  const seen = new Set<string>();
  const out: { doi: string; title: string }[] = [];
  for (const it of items) {
    if (it.done || savedLines[it.line]) continue;
    const doi = normalizeDoi(it.url);
    if (!doi || seen.has(doi)) continue;
    seen.add(doi);
    out.push({ doi, title: it.title });
  }
  return out;
}

/** 一行进度：「排队 3 · 已下载 5 · 需要你自己下 1 · 等你确认 2」；没有就空串 */
export function summarizeJobs(jobs: PaperFetchJob[]): string {
  const count = (pred: (j: PaperFetchJob) => boolean) => jobs.filter(pred).length;
  const parts: string[] = [];
  const active = count((j) => ["queued", "browser", "needs_pick"].includes(j.status));
  const done = count((j) => j.status === "done");
  const failed = count((j) => j.status === "failed");
  const approval = count((j) => j.status === "needs_approval");
  if (active) parts.push(`排队 ${active}`);
  if (done) parts.push(`已下载 ${done}`);
  if (failed) parts.push(`需要你自己下 ${failed}`);
  if (approval) parts.push(`等你确认 ${approval}`);
  return parts.join(" · ");
}

/** 人改上限：只能在后端给的天花板以内（后端也会再夹一次） */
export function clampLimits(l: PaperFetchLimits, ceiling: PaperFetchLimits): PaperFetchLimits {
  const minGap = Math.min(600, Math.max(ceiling.minGapSecs, Math.round(l.minGapSecs) || ceiling.minGapSecs));
  return {
    perPublisherDaily: Math.min(ceiling.perPublisherDaily, Math.max(1, Math.round(l.perPublisherDaily) || 1)),
    totalDaily: Math.min(ceiling.totalDaily, Math.max(1, Math.round(l.totalDaily) || 1)),
    minGapSecs: minGap,
    maxGapSecs: Math.min(1800, Math.max(minGap, Math.round(l.maxGapSecs) || minGap)),
  };
}
