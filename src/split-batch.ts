/**
 * 拆成几路做的回报（2026-11-04，补 qa G9「按方案开的几路做完时没有汇总回报」）：批准方案时记下这一批开了哪几条目标、哪几条在等，
 * 工作台「拆成几路做」那一行按目标状态写进度；开了的几路都收场后写一句汇总（各路结果 + 等着的那路可以开了），弹一次提示，人点「知道了」才收。
 * 存 localStorage（与分路收尾同口径）：只是界面上的回报，丢了不影响目标本身。纯逻辑，配 tests/split-batch.test.ts。
 */
export interface SplitBatchLane {
  taskId: string;
  name: string;
  /** 方案里写了「等」：只记下没开 */
  waits: boolean;
  /** 批准时真开起来了（没开起来的当没开，等人在项目里点开始） */
  started: boolean;
}

export interface SplitBatch {
  id: string;
  title: string;
  createdAt: number;
  lanes: SplitBatchLane[];
  /** 「都做完了」提示弹过了 */
  reported?: boolean;
}

export const SPLIT_BATCH_PREFIX = "ccode.splitBatch.";
/** 一个项目最多记几批（新的在前） */
const KEEP = 3;
/** 一周还没收场的不再盯 */
export const SPLIT_BATCH_EXPIRE_MS = 7 * 24 * 3600 * 1000;

const FINISHED = new Set(["pending_review", "completed", "failed", "stopped"]);

const LANE_LABEL: Record<string, string> = {
  pending: "还没开工",
  queued: "排队中",
  running: "在做",
  pending_review: "待验收",
  completed: "已验收",
  failed: "失败",
  stopped: "停了",
};

export interface BatchProgress {
  /** 开了的几路 */
  started: number;
  /** 开了的里面已收场的 */
  finished: number;
  done: boolean;
  /** 一句进度 / 汇总 */
  text: string;
  tone: "live" | "done" | "fail";
  /** 每路一行：名字 · 状态 */
  lines: { name: string; label: string }[];
}

export function batchProgress(batch: SplitBatch, status: (taskId: string) => string | null): BatchProgress {
  const lines = batch.lanes.map((l) => {
    const s = status(l.taskId);
    return { name: l.name, label: s == null ? "目标找不到了" : (LANE_LABEL[s] ?? s), status: s, lane: l };
  });
  const startedLines = lines.filter((x) => x.lane.started);
  const finishedLines = startedLines.filter((x) => x.status == null || FINISHED.has(x.status));
  const started = startedLines.length;
  const finished = finishedLines.length;
  const done = started > 0 && finished === started;
  const count = (st: string) => startedLines.filter((x) => x.status === st).length;
  const parts = [
    count("running") + count("queued") ? `${count("running") + count("queued")} 个在做` : "",
    count("pending_review") ? `${count("pending_review")} 个待验收` : "",
    count("completed") ? `${count("completed")} 个已验收` : "",
    count("failed") ? `${count("failed")} 个失败` : "",
    count("stopped") ? `${count("stopped")} 个停了` : "",
  ].filter(Boolean);
  const waiting = lines.filter((x) => !x.lane.started && (x.status === "pending" || x.status === null)).map((x) => `「${x.name}」`);
  const bad = count("failed") + count("stopped") > 0;
  const head = batch.title ? `「${batch.title}」` : "拆的";
  const text = done
    ? `${head}拆成的 ${started} 个目标都结束了：${parts.join("、") || "都找不到了"}${
        waiting.length ? `；${waiting.join("")}在等，前面验收后在项目里点开始` : ""
      }`
    : `${head}拆成的 ${started} 个目标：${parts.join("、") || "还没动"}${waiting.length ? `；${waiting.join("")}在等` : ""}`;
  return {
    started,
    finished,
    done,
    text,
    tone: done ? (bad ? "fail" : "done") : "live",
    lines: lines.map(({ name, label }) => ({ name, label })),
  };
}

/** 把新的一批放在最前，只留 KEEP 批 */
export function pushBatch(list: readonly SplitBatch[], batch: SplitBatch): SplitBatch[] {
  return [batch, ...list.filter((b) => b.id !== batch.id)].slice(0, KEEP);
}

/** 过期的不再盯 */
export function liveBatches(list: readonly SplitBatch[], nowMs: number): SplitBatch[] {
  return list.filter((b) => nowMs - b.createdAt < SPLIT_BATCH_EXPIRE_MS);
}

export function readBatches(projectPath: string): SplitBatch[] {
  try {
    const raw = localStorage.getItem(`${SPLIT_BATCH_PREFIX}${projectPath}`);
    const parsed = raw ? (JSON.parse(raw) as SplitBatch[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeBatches(projectPath: string, list: readonly SplitBatch[]): void {
  try {
    if (list.length === 0) localStorage.removeItem(`${SPLIT_BATCH_PREFIX}${projectPath}`);
    else localStorage.setItem(`${SPLIT_BATCH_PREFIX}${projectPath}`, JSON.stringify(list));
  } catch {
    /* 存不下只是少一行回报 */
  }
}
