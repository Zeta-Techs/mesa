// 代下全文（2026-11-08，docs/design-autonomy-roadmap.md §6）的界面零件。
// 设置 → 网络「文献全文」按设置页规范一行一件事：SettingsPage 用 Row 排，这里只给数据钩子和行里的小块；
// 待获取清单顶上的 PaperFetchBar 是次要动作（步骤主按钮只有一个，step-panel R6）。
// 限速、熔断、范围检查都在后端（paper_fetch.rs），这里只展示与转达人的点击。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { canShowCoachTip, markCoachTipShown, markCoachTipSeen } from "../coach-tips";
import CoachTip from "./CoachTip";
import {
  fetchableItems,
  logResultLabel,
  statusLabel,
  summarizeJobs,
  viaLabel,
  type PaperFetchJob,
  type PaperFetchLogEntry,
  type PaperFetchOverview,
} from "../paper-fetch";

const linkBtn = "text-xs text-l3 underline decoration-dotted underline-offset-2 hover:text-l1 disabled:opacity-50";

function hasTauri(): boolean {
  return !!(globalThis as { __TAURI_INTERNALS__?: { transformCallback?: unknown } }).__TAURI_INTERNALS__
    ?.transformCallback;
}

/** 代下状态：听后端广播，另 15 秒拉一次（扩展与 AI 在别的进程里写队列） */
export function usePaperFetchOverview(projectRoot?: string) {
  const [data, setData] = useState<PaperFetchOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setData(await invoke<PaperFetchOverview>("paper_fetch_overview", { projectRoot: projectRoot ?? null }));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [projectRoot]);
  useEffect(() => {
    if (!hasTauri()) return;
    void reload();
    const un = listen("paper-fetch-changed", () => void reload());
    const timer = window.setInterval(() => void reload(), 15000);
    return () => {
      window.clearInterval(timer);
      void un.then((f) => f());
    };
  }, [reload]);
  return { data, error, reload };
}

export function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function JobRow({ job, onChanged }: { job: PaperFetchJob; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  async function act(cmd: string) {
    setBusy(true);
    try {
      await invoke(cmd, { id: job.id });
    } finally {
      setBusy(false);
      onChanged();
    }
  }
  const name = job.title.trim() || job.doi;
  const note =
    job.status === "done" && job.saved
      ? `papers/${job.saved}（${viaLabel(job.via)}）`
      : job.status === "needs_approval"
        ? "还不在项目文献清单里，AI 要下需要你确认；这一步保存进项目后会自动开始"
        : ["queued", "browser"].includes(job.status)
          ? (job.waiting ?? "")
          : (job.error ?? "");
  return (
    <li className="py-1.5">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <span className="min-w-0 flex-1 truncate text-l1" title={`${name}\n${job.doi}`}>
          {name}
        </span>
        <span className="shrink-0 text-xs text-l3">{statusLabel(job.status)}</span>
        {job.status === "needs_approval" && (
          <>
            <button type="button" className={linkBtn} disabled={busy} onClick={() => void act("paper_fetch_approve")}>
              下载
            </button>
            <button type="button" className={linkBtn} disabled={busy} onClick={() => void act("paper_fetch_cancel")}>
              不下
            </button>
          </>
        )}
        {(job.status === "failed" || job.status === "needs_pick") && (
          <button type="button" className={linkBtn} disabled={busy} onClick={() => void act("paper_fetch_retry")}>
            重试
          </button>
        )}
        {["queued", "browser"].includes(job.status) && (
          <button type="button" className={linkBtn} disabled={busy} onClick={() => void act("paper_fetch_cancel")}>
            取消
          </button>
        )}
      </div>
      {note && <p className="truncate text-xs text-l3" title={note}>{note}</p>}
    </li>
  );
}

/** 还没结束的与最近下到的几篇 */
export function JobList({ jobs, onChanged }: { jobs: PaperFetchJob[]; onChanged: () => void }) {
  return (
    <ul className="max-h-72 divide-y divide-hairline overflow-auto">
      {jobs.map((j) => (
        <JobRow key={j.id} job={j} onChanged={onChanged} />
      ))}
    </ul>
  );
}

/** 下载记录：每次去下载一行 */
export function FetchLog() {
  const [log, setLog] = useState<PaperFetchLogEntry[] | null>(null);
  useEffect(() => {
    void invoke<PaperFetchLogEntry[]>("paper_fetch_log", { limit: 200 }).then(setLog, () => setLog([]));
  }, []);
  if (!log) return <p className="text-xs text-l3">读取中…</p>;
  if (log.length === 0) return <p className="text-xs text-l3">还没有下载过</p>;
  return (
    <ul className="max-h-60 overflow-auto text-xs leading-5 text-l3">
      {log.map((e, i) => (
        <li key={`${e.at}-${i}`} className="flex gap-2" title={e.doi}>
          <span className="shrink-0 tabular-nums">{fmtTime(e.at)}</span>
          <span className="shrink-0">{viaLabel(e.level)}</span>
          <span className="shrink-0 text-l2">{logResultLabel(e.result)}</span>
          <span className="min-w-0 truncate">
            {e.doi}
            {e.runId ? " · AI 交的" : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** 待获取清单顶上：次要动作「让 Mesa 找免费版」与一行进度（主按钮仍是这一步的开始 / 评审）。
 *  2026-11-09 用户拍板：浏览器后台自动下被出版商拦，「根本不可行」——Mesa 只找开放获取，付费墙由人点每篇「官网」 */
export function PaperFetchBar({
  projectPath,
  items,
  savedLines,
  overview,
}: {
  projectPath: string;
  items: { title: string; url: string; done: boolean; line: number }[];
  savedLines: Record<number, string>;
  /** 由清单所在的步骤卡取（每一行也要用它写 Mesa 走到哪） */
  overview: { data: PaperFetchOverview | null; reload: () => Promise<void> };
}) {
  const { data, reload } = overview;
  // 怎么下的一次性气泡（2026-11-09 用户：「用户点官网下和 Mesa 来下载得表现明白」）；例外于「不首次即弹」：清单第一次有可下的篇就出
  const [tipOpen, setTipOpen] = useState(() => canShowCoachTip("fetchWays", true));
  const closeTip = () => {
    markCoachTipSeen("fetchWays");
    setTipOpen(false);
  };
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const pending = fetchableItems(items, savedLines);
  const activeDois = new Set(
    (data?.jobs ?? []).filter((j) => ["queued", "browser", "needs_pick"].includes(j.status)).map((j) => j.doi),
  );
  const toSend = pending.filter((p) => !activeDois.has(p.doi));
  // 按钮已写「代下这批（N 篇）」：按钮能交的、正等你点的不再在进度里重复数（2026-11-09 用户：说明简洁一点）
  const sendable = new Set(toSend.map((p) => p.doi));
  const summary = summarizeJobs(
    (data?.jobs ?? []).filter((j) => j.status !== "cancelled" && !(j.status === "needs_approval" && sendable.has(j.doi))),
  );
  const failed = (data?.jobs ?? []).filter((j) => j.status === "failed" || j.status === "needs_pick").length;
  // 清单里还有没存的篇才出（真画出来才记「出过」）
  const showTip = tipOpen && pending.length > 0;
  useEffect(() => {
    if (showTip) markCoachTipShown("fetchWays", true);
  }, [showTip]);

  async function retryAll() {
    setBusy(true);
    setNote(null);
    try {
      const n = await invoke<number>("paper_fetch_retry_all", { projectRoot: projectPath });
      setNote(`重新排上 ${n} 篇`);
      await reload();
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    closeTip();
    setBusy(true);
    setNote(null);
    try {
      const n = await invoke<number>("paper_fetch_enqueue", { projectRoot: projectPath, items: toSend });
      setNote(`已交给 Mesa ${n} 篇`);
      await reload();
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!hasTauri() || (toSend.length === 0 && !summary)) return null;
  return (
    <div className="relative mb-1">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-micro text-l3">
      {toSend.length > 0 && (
        <button
          type="button"
          className="rounded-sm border border-field px-1.5 py-0.5 hover:bg-hover hover:text-l1 disabled:opacity-50"
          disabled={busy}
          title="Mesa 逐篇找合法的开放获取版本，找到就存进 papers/、标已存；找不到的写「没有免费版，点官网」。AI 交过的篇不点也行，这一步保存进项目后自动开始"
          onClick={() => void send()}
        >
          <span className="text-xs">{busy ? "交给 Mesa…" : `让 Mesa 找免费版（${toSend.length} 篇）`}</span>
        </button>
      )}
      {summary && <span title="细节在 设置 → 网络 → 代下全文">Mesa：{summary}</span>}
      {/* 气泡只自动出一次；之后随时点这里再看（2026-11-09 用户问「两种下载方式说清楚了吗」：热更新时气泡闪过即记已出，人没看到） */}
      {pending.length > 0 && !showTip && (
        <button type="button" className={linkBtn} onClick={() => setTipOpen(true)}>
          怎么下
        </button>
      )}
      {failed > 0 && (
        <button type="button" className={linkBtn} disabled={busy} title="没下到的这几篇让 Mesa 再找一遍免费版" onClick={() => void retryAll()}>
          全部重试（{failed}）
        </button>
      )}
      {note && <span>{note}</span>}
    </div>
    {showTip && (
      <CoachTip
        arrow="up"
        arrowAt={40}
        title="怎么下全文"
        onClose={closeTip}
        // 浮在清单上面，不占位置把清单挤下去（2026-11-09 用户）
        className="absolute top-full left-0 mt-2 w-[min(28rem,100%)] text-xs leading-5 shadow-lg"
        actions={[{ label: "知道了", onClick: closeTip }]}
      >
        <ul className="list-disc space-y-0.5 pl-4">
          <li>
            <b>让 Mesa 找免费版</b>：Mesa 去找合法的开放获取版本，找到就存进 papers/。
          </li>
          <li>
            找不到的（行尾写「没有免费版，点官网」）：点这一篇的 <b>官网</b>，在浏览器里下 PDF，存进「下载」文件夹会自动收进 papers/；存到别处的点 <b>关联</b>。
          </li>
        </ul>
      </CoachTip>
    )}
    </div>
  );
}
