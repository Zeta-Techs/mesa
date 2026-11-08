// 全文代下（2026-11-08，docs/design-autonomy-roadmap.md §6）：
// - PaperFetchPanel：设置 → 网络「代下全文」——今天经学校身份下了多少、哪家暂停了、等你放行 / 交还给你的、调上限、出门日志
// - PaperFetchBar：待获取清单顶上「让 Mesa 代下这批」与一行进度
// 限速、熔断、范围检查都在后端（paper_fetch.rs），这里只展示与转达人的点击。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { primaryActionClass } from "./PageFrame";
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
} from "../paper-fetch";

const smallBtn =
  "rounded-sm border border-field px-1.5 py-0.5 text-xs text-l1 hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50";

function hasTauri(): boolean {
  return !!(globalThis as { __TAURI_INTERNALS__?: { transformCallback?: unknown } }).__TAURI_INTERNALS__
    ?.transformCallback;
}

function useOverview(projectRoot?: string) {
  const [data, setData] = useState<PaperFetchOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await invoke<PaperFetchOverview>("paper_fetch_overview", { projectRoot: projectRoot ?? null }));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [projectRoot]);
  useEffect(() => {
    if (!hasTauri()) return;
    void load();
    const un = listen("paper-fetch-changed", () => void load());
    // 扩展领活、AI 交活都在别的进程里写队列，后台线程不一定有变化可广播：慢一点再拉一次
    const timer = window.setInterval(() => void load(), 15000);
    return () => {
      window.clearInterval(timer);
      void un.then((f) => f());
    };
  }, [load]);
  return { data, error, reload: load };
}

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function JobRow({ job, onDone }: { job: PaperFetchJob; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function act(cmd: string) {
    setBusy(true);
    setErr(null);
    try {
      await invoke(cmd, { id: job.id });
      onDone();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }
  const name = job.title.trim() || job.doi;
  return (
    <li className="flex min-w-0 flex-col gap-0.5 py-1">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
        <span className="shrink-0 text-l4">{statusLabel(job.status)}</span>
        <span className="min-w-0 flex-1 truncate text-l2" title={`${name}\n${job.doi}`}>
          {name}
        </span>
        {job.requester === "agent" && <span className="shrink-0 text-micro text-l4">AI 交的</span>}
        {job.status === "needs_approval" && (
          <>
            <button type="button" className={smallBtn} disabled={busy} onClick={() => void act("paper_fetch_approve")}>
              放行
            </button>
            <button type="button" className={smallBtn} disabled={busy} onClick={() => void act("paper_fetch_cancel")}>
              不下
            </button>
          </>
        )}
        {(job.status === "failed" || job.status === "needs_pick") && (
          <button type="button" className={smallBtn} disabled={busy} onClick={() => void act("paper_fetch_retry")}>
            重试
          </button>
        )}
        {["queued", "browser"].includes(job.status) && (
          <button type="button" className={smallBtn} disabled={busy} onClick={() => void act("paper_fetch_cancel")}>
            取消
          </button>
        )}
      </div>
      {job.status === "done" && job.saved && (
        <p className="text-micro text-l4">
          papers/{job.saved} · 经{viaLabel(job.via)}
        </p>
      )}
      {job.waiting && ["queued", "browser"].includes(job.status) && (
        <p className="text-micro text-l4">{job.waiting}</p>
      )}
      {job.error && job.status !== "done" && <p className="text-micro text-l4">{job.error}</p>}
      {job.status === "needs_approval" && (
        <p className="text-micro text-l4">这篇不在项目的文献清单里，AI 要下需要你点放行</p>
      )}
      {err && <p className="text-micro text-err-text">{err}</p>}
    </li>
  );
}

/** 设置 → 网络「代下全文」 */
export function PaperFetchPanel() {
  const { data, error, reload } = useOverview();
  const [limits, setLimits] = useState<PaperFetchLimits | null>(null);
  const [bridge, setBridge] = useState<string[] | null>(null);
  const [log, setLog] = useState<PaperFetchLogEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [actErr, setActErr] = useState<string | null>(null);

  useEffect(() => {
    if (data && !limits) setLimits(data.limits);
  }, [data, limits]);

  async function run(cmd: string, args?: Record<string, unknown>) {
    setBusy(true);
    setActErr(null);
    try {
      await invoke(cmd, args);
      await reload();
    } catch (e) {
      setActErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveLimits() {
    if (!data || !limits) return;
    const next = clampLimits(limits, data.ceiling);
    setBusy(true);
    try {
      setLimits(await invoke<PaperFetchLimits>("paper_fetch_set_limits", { limits: next }));
      await reload();
    } catch (e) {
      setActErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="text-micro text-err-text">代下状态读不到：{error}</p>;
  if (!data) return <p className="text-micro text-l4">加载中…</p>;

  const open = data.jobs.filter((j) => !["done", "cancelled"].includes(j.status));
  const recentDone = data.jobs.filter((j) => j.status === "done").slice(0, 5);
  const numField =
    "h-7 w-16 rounded-md border border-field bg-transparent px-1.5 text-xs text-l1 focus:outline-none focus:ring-1 focus:ring-cta-bd";

  return (
    <div className="flex max-w-[34rem] flex-col gap-2">
      <p className="text-micro text-l4">
        AI 和你都可以把待获取的文献交给 Mesa，它按出版商限速逐篇去取：先找开放获取版本，再走学校通道，最后在你的浏览器里取。
        遇到验证码或被拒，这家停 24 小时并交还给你；连续 3 篇没取到，整条暂停。
      </p>

      {data.paused && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-err-text">
          <span>已暂停：{data.paused}</span>
          <button type="button" className={smallBtn} disabled={busy} onClick={() => void run("paper_fetch_resume")}>
            继续
          </button>
        </div>
      )}
      {data.sessionExpired && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-l2">
          <span>学校会话过期，学校通道先停用（浏览器那一级照常）。重新登录后点</span>
          <button type="button" className={smallBtn} disabled={busy} onClick={() => void run("paper_fetch_resume")}>
            已重新登录
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-xs text-l2">
        <span>
          浏览器扩展：{data.extensionAlive ? <span className="text-done">在线</span> : "最近 5 分钟没来领活"}
        </span>
        {!data.extensionAlive && (
          <button
            type="button"
            className={smallBtn}
            disabled={busy}
            onClick={() => {
              void invoke<string[]>("install_browser_bridge").then(setBridge, (e) => setBridge([`✗ ${String(e)}`]));
            }}
          >
            安装浏览器桥
          </button>
        )}
      </div>
      {bridge && (
        <div className="text-micro text-l4">
          {bridge.map((line) => (
            <p key={line} className="break-all">
              {line}
            </p>
          ))}
          <p>
            然后在 Chrome / Edge 打开 chrome://extensions，开「开发者模式」，点「加载已解压的扩展程序」，选上面写的 extension
            文件夹；已装过的点一次「重新加载」。浏览器开着、登录过学校账号，扩展每分钟来领一篇。
          </p>
        </div>
      )}

      <div className="text-xs text-l2">
        今天经学校身份 {data.totalToday} / {data.limits.totalDaily} 篇
        {data.publishers.length > 0 && "："}
        <ul className="mt-0.5 flex flex-col gap-0.5">
          {data.publishers.map((p) => (
            <li key={p.key} className="flex flex-wrap items-center gap-1.5">
              <span>
                {p.name} {p.count} / {data.limits.perPublisherDaily}
              </span>
              {p.blockedUntil && (
                <>
                  <span className="text-micro text-l4">
                    暂停到 {fmtTime(p.blockedUntil)}（{p.blockedReason}）
                  </span>
                  <button
                    type="button"
                    className={smallBtn}
                    disabled={busy}
                    title="确认这家没有拦学校的访问再解除"
                    onClick={() => void run("paper_fetch_unblock", { publisher: p.key })}
                  >
                    解除
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>

      {limits && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-l2">
          <label className="flex items-center gap-1">
            每家每天
            <input
              type="number"
              className={numField}
              value={limits.perPublisherDaily}
              max={data.ceiling.perPublisherDaily}
              min={1}
              onChange={(e) => setLimits({ ...limits, perPublisherDaily: Number(e.target.value) })}
            />
            篇
          </label>
          <label className="flex items-center gap-1">
            总共每天
            <input
              type="number"
              className={numField}
              value={limits.totalDaily}
              max={data.ceiling.totalDaily}
              min={1}
              onChange={(e) => setLimits({ ...limits, totalDaily: Number(e.target.value) })}
            />
            篇
          </label>
          <label className="flex items-center gap-1">
            同一家间隔
            <input
              type="number"
              className={numField}
              value={limits.minGapSecs}
              min={data.ceiling.minGapSecs}
              onChange={(e) => setLimits({ ...limits, minGapSecs: Number(e.target.value) })}
            />
            –
            <input
              type="number"
              className={numField}
              value={limits.maxGapSecs}
              min={limits.minGapSecs}
              onChange={(e) => setLimits({ ...limits, maxGapSecs: Number(e.target.value) })}
            />
            秒
          </label>
          <button type="button" className={smallBtn} disabled={busy} onClick={() => void saveLimits()}>
            保存
          </button>
          <span className="w-full text-micro text-l4">
            可以调低；调高最多每家 {data.ceiling.perPublisherDaily} 篇、总共 {data.ceiling.totalDaily} 篇，间隔不少于{" "}
            {data.ceiling.minGapSecs} 秒
          </span>
        </div>
      )}

      {open.length > 0 && (
        <div>
          <p className="text-xs text-l2">还没结束的（{summarizeJobs(open)}）</p>
          <ul className="max-h-72 overflow-auto">
            {open.map((j) => (
              <JobRow key={j.id} job={j} onDone={() => void reload()} />
            ))}
          </ul>
        </div>
      )}
      {recentDone.length > 0 && (
        <div>
          <p className="text-xs text-l2">最近取到的</p>
          <ul>
            {recentDone.map((j) => (
              <JobRow key={j.id} job={j} onDone={() => void reload()} />
            ))}
          </ul>
        </div>
      )}

      <div>
        <button
          type="button"
          className="text-micro text-l4 underline decoration-dotted underline-offset-2 hover:text-l2"
          onClick={() => {
            if (log) setLog(null);
            else void invoke<PaperFetchLogEntry[]>("paper_fetch_log", { limit: 200 }).then(setLog, () => setLog([]));
          }}
        >
          {log ? "收起出门记录" : "出门记录（每次去取都记一行）"}
        </button>
        {log && (
          <ul className="mt-1 max-h-60 overflow-auto font-mono text-micro text-l4">
            {log.length === 0 && <li>还没有记录</li>}
            {log.map((e, i) => (
              <li key={`${e.at}-${i}`} className="truncate" title={e.doi}>
                {fmtTime(e.at)} · {viaLabel(e.level)} · {e.publisher} · {logResultLabel(e.result)} · {e.doi}
                {e.runId ? " · AI" : ""}
              </li>
            ))}
          </ul>
        )}
      </div>
      {actErr && <p className="text-micro text-err-text">{actErr}</p>}
    </div>
  );
}

/** 待获取清单顶上：「让 Mesa 代下这批」与一行进度 */
export function PaperFetchBar({
  projectPath,
  items,
  savedLines,
}: {
  projectPath: string;
  items: { title: string; url: string; done: boolean; line: number }[];
  savedLines: Record<number, string>;
}) {
  const { data, reload } = useOverview(projectPath);
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
      setNote(`已交给 Mesa ${n} 篇，按出版商限速逐篇取，取到的会自动标成已存`);
      await reload();
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!hasTauri() || (toSend.length === 0 && !summary)) return null;
  return (
    <div className="mb-1 flex flex-wrap items-center gap-2 text-micro text-l4">
      {toSend.length > 0 && (
        <button
          type="button"
          className={`${primaryActionClass} h-7 px-2`}
          disabled={busy}
          title="先找开放获取版本，再走学校通道，最后在你的浏览器里取；按出版商限速，不会连累学校的访问"
          onClick={() => void send()}
        >
          {busy ? "交给 Mesa…" : `让 Mesa 代下这批（${toSend.length} 篇）`}
        </button>
      )}
      {summary && <span title="细节在 设置 → 网络 → 代下全文">代下：{summary}</span>}
      {note && <span>{note}</span>}
    </div>
  );
}
