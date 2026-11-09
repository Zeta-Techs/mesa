// 代下全文（2026-11-08，docs/design-autonomy-roadmap.md §6）的界面零件。
// 设置 → 网络「文献全文」按设置页规范一行一件事：SettingsPage 用 Row 排，这里只给数据钩子和行里的小块；
// 待获取清单顶上的 PaperFetchBar 是次要动作（步骤主按钮只有一个，step-panel R6）。
// 限速、熔断、范围检查都在后端（paper_fetch.rs），这里只展示与转达人的点击。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import {
  clampLimits,
  fetchableItems,
  logResultLabel,
  statusLabel,
  summarizeJobs,
  viaLabel,
  type PaperFetchJob,
  type PaperFetchLimits,
  type PaperFetchLogEntry,
  type PaperFetchOverview,
  type PaperFetchPublisher,
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

/** 两个数字框，失焦或回车即存（设置页口径：不另放「保存」）；超过上限按上限存 */
export function LimitPair({
  data,
  pair,
  inputClass,
  onSaved,
}: {
  data: PaperFetchOverview;
  pair: "daily" | "gap";
  inputClass: string;
  onSaved: () => void;
}) {
  const keys: [keyof PaperFetchLimits, keyof PaperFetchLimits] =
    pair === "daily" ? ["perPublisherDaily", "totalDaily"] : ["minGapSecs", "maxGapSecs"];
  const [draft, setDraft] = useState<[string, string]>([String(data.limits[keys[0]]), String(data.limits[keys[1]])]);
  useEffect(() => {
    setDraft([String(data.limits[keys[0]]), String(data.limits[keys[1]])]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.limits[keys[0]], data.limits[keys[1]]]);
  async function save() {
    const next = clampLimits({ ...data.limits, [keys[0]]: Number(draft[0]), [keys[1]]: Number(draft[1]) }, data.ceiling);
    if (next[keys[0]] === data.limits[keys[0]] && next[keys[1]] === data.limits[keys[1]]) {
      setDraft([String(next[keys[0]]), String(next[keys[1]])]);
      return;
    }
    try {
      await invoke("paper_fetch_set_limits", { limits: next });
    } finally {
      onSaved();
    }
  }
  const field = (i: 0 | 1, label: string, title: string) => (
    <input
      className={`${inputClass} w-16 text-center tabular-nums`}
      inputMode="numeric"
      aria-label={label}
      title={title}
      value={draft[i]}
      onChange={(e) => {
        const v = e.target.value.replace(/[^0-9]/g, "");
        setDraft(i === 0 ? [v, draft[1]] : [draft[0], v]);
      }}
      onBlur={() => void save()}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
  return pair === "daily" ? (
    <span className="flex items-center gap-1.5 text-sm text-l2">
      每家{field(0, "每家出版商每天", `最多 ${data.ceiling.perPublisherDaily} 篇`)}篇
      <span className="ml-2">共</span>
      {field(1, "每天总共", `最多 ${data.ceiling.totalDaily} 篇`)}篇
    </span>
  ) : (
    <span className="flex items-center gap-1.5 text-sm text-l2">
      {field(0, "最短间隔", `不少于 ${data.ceiling.minGapSecs} 秒`)}–{field(1, "最长间隔", "两次之间在这个范围里随机等")}秒
    </span>
  );
}

/** 暂停的出版商：一家一行，解除按钮跟在原因后面 */
export function BlockedPublishers({
  publishers,
  buttonClass,
  onChanged,
}: {
  publishers: PaperFetchPublisher[];
  /** 与设置页其他行内动作同一个细边按钮 */
  buttonClass: string;
  onChanged: () => void;
}) {
  return (
    <ul className="space-y-1.5 text-sm">
      {publishers.map((p) => (
        <li key={p.key} className="flex flex-wrap items-center gap-x-2 text-l2">
          <span className="text-l1">{p.name}</span>
          <span className="text-xs text-l3">
            {p.blockedReason}，{fmtTime(p.blockedUntil!)} 后恢复
          </span>
          <button
            type="button"
            className={buttonClass}
            title="确认学校的访问没被拦，再提前恢复"
            onClick={() => void invoke("paper_fetch_unblock", { publisher: p.key }).finally(onChanged)}
          >
            提前恢复
          </button>
        </li>
      ))}
    </ul>
  );
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

/** 待获取清单顶上：次要动作「让 Mesa 代下这批」与一行进度（主按钮仍是这一步的开始 / 评审） */
export function PaperFetchBar({
  projectPath,
  items,
  savedLines,
}: {
  projectPath: string;
  items: { title: string; url: string; done: boolean; line: number }[];
  savedLines: Record<number, string>;
}) {
  const { data, reload } = usePaperFetchOverview(projectPath);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const pending = fetchableItems(items, savedLines);
  const activeDois = new Set(
    (data?.jobs ?? []).filter((j) => ["queued", "browser", "needs_pick"].includes(j.status)).map((j) => j.doi),
  );
  const toSend = pending.filter((p) => !activeDois.has(p.doi));
  const summary = summarizeJobs((data?.jobs ?? []).filter((j) => j.status !== "cancelled"));

  async function send() {
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
    <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-micro text-l3">
      {toSend.length > 0 && (
        <button
          type="button"
          className="rounded-sm border border-field px-1.5 py-0.5 hover:bg-hover hover:text-l1 disabled:opacity-50"
          disabled={busy}
          title="Mesa 逐篇下载：先找开放获取版本，再经学校订阅，最后在你的浏览器里下；按出版商限速，下到的自动标已存"
          onClick={() => void send()}
        >
          <span className="text-xs">{busy ? "交给 Mesa…" : `让 Mesa 代下这批（${toSend.length} 篇）`}</span>
        </button>
      )}
      {summary && <span title="细节在 设置 → 网络 → 代下全文">{summary}</span>}
      {note && <span>{note}</span>}
    </div>
  );
}
