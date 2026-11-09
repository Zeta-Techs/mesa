// 代下全文（2026-11-08，docs/design-autonomy-roadmap.md §6）的界面零件。
// 设置 → 网络「文献全文」按设置页规范一行一件事：SettingsPage 用 Row 排，这里只给数据钩子和行里的小块；
// 待获取清单顶上的 PaperFetchBar 是次要动作（步骤主按钮只有一个，step-panel R6）。
// 限速、熔断、范围检查都在后端（paper_fetch.rs），这里只展示与转达人的点击。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../store";
import { canShowCoachTip, markCoachTipShown, markCoachTipSeen } from "../coach-tips";
import CoachTip from "./CoachTip";
import {
  clampLimits,
  fetchableItems,
  logResultLabel,
  loginTargets,
  needsExtension,
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

/** 在浏览器里点开过登录的出版商（登录状态在浏览器里，按浏览器记、不分项目） */
const LOGIN_OPENED_KEY = "mesa.paperFetch.loginOpened";
function readLoginOpened(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(LOGIN_OPENED_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** 待获取清单顶上：次要动作「让 Mesa 代下这批」与一行进度（主按钮仍是这一步的开始 / 评审） */
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
  const setPage = useAppStore((s) => s.setPage);
  const setSettingsSectionReq = useAppStore((s) => s.setSettingsSectionReq);
  // 两种下法的一次性气泡（2026-11-09 用户：「用户点官网下和 Mesa 来下载得表现明白」）；例外于「不首次即弹」：清单第一次有可下的篇就出
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
  const noExtension = needsExtension(data?.jobs ?? [], data?.extensionAlive ?? false);
  // 第一次在浏览器里下之前，每家出版商要在浏览器里用学校账号登一次（2026-11-09 用户：「你也没给用户操作方式啊」）
  const logins = loginTargets(data?.jobs ?? []);
  const [loginOpened, setLoginOpened] = useState<string[]>(readLoginOpened);
  async function openLogin(t: { publisher: string; doi: string }) {
    setNote(null);
    try {
      await invoke("inst_browser_open", { url: `https://doi.org/${t.doi}`, projectRoot: projectPath, title: null, doi: t.doi });
      const next = Array.from(new Set([...loginOpened, t.publisher]));
      setLoginOpened(next);
      try {
        localStorage.setItem(LOGIN_OPENED_KEY, JSON.stringify(next));
      } catch {
        /* 存不下只是下次不打勾 */
      }
    } catch (e) {
      setNote(`打开浏览器失败：${String(e)}`);
    }
  }
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
          title="Mesa 逐篇下载：先找开放获取版本，再经学校订阅，最后在你的浏览器里下；按出版商限速，下到的自动标已存。AI 交过的篇不点也行，这一步保存进项目后自动开始"
          onClick={() => void send()}
        >
          <span className="text-xs">{busy ? "交给 Mesa…" : `让 Mesa 代下这批（${toSend.length} 篇）`}</span>
        </button>
      )}
      {summary && <span title="Mesa 代下到哪了；细节在 设置 → 网络 → 代下全文">Mesa：{summary}</span>}
      {/* 气泡只自动出一次；之后随时点这里再看（2026-11-09 用户问「两种下载方式说清楚了吗」：热更新时气泡闪过即记已出，人没看到） */}
      {pending.length > 0 && !showTip && (
        <button type="button" className={linkBtn} onClick={() => setTipOpen(true)}>
          两种下法
        </button>
      )}
      {failed > 0 && (
        <button type="button" className={linkBtn} disabled={busy} title="没下到的这几篇让 Mesa 从头再试一遍" onClick={() => void retryAll()}>
          全部重试（{failed}）
        </button>
      )}
      {note && <span>{note}</span>}
    </div>
    {logins.length > 0 && (
      <p className="mt-0.5 text-micro text-l3">
        要在浏览器里下的，先在浏览器里用学校账号登录这几家（每家一次）：
        {logins.map((t) => (
          <button
            key={t.publisher}
            type="button"
            className="ml-1.5 underline decoration-dotted underline-offset-2 hover:text-l1"
            title={`在浏览器里打开 ${t.publisher} 的一篇文章。页面上点「Institutional login / 机构登录」（Elsevier 写「Access through your institution」），选 CARSI 或你的学校，用学校账号登录；登好了这家以后不用再登。`}
            onClick={() => void openLogin(t)}
          >
            {t.publisher}
            {loginOpened.includes(t.publisher) ? " ✓" : ""}
          </button>
        ))}
        <span className="ml-1.5 text-l4">（文章页点「机构登录」→ CARSI → 你的学校）</span>
      </p>
    )}
    {noExtension && (
      <p className="mt-0.5 text-micro text-caution-text">
        浏览器扩展没连上：Wiley、Elsevier 这类要在浏览器里下的，等它连上才会接着下。
        <button
          type="button"
          className="ml-1 underline decoration-dotted underline-offset-2 hover:text-l1"
          onClick={() => {
            setSettingsSectionReq("network");
            setPage("settings");
          }}
        >
          去安装
        </button>
      </p>
    )}
    {showTip && (
      <CoachTip
        arrow="up"
        arrowAt={40}
        title="两种下法，可以一起用"
        onClose={closeTip}
        // 浮在清单上面，不占位置把清单挤下去（2026-11-09 用户）
        className="absolute top-full left-0 mt-2 w-[min(28rem,100%)] text-xs leading-5 shadow-lg"
        // 扩展没连上时主按钮直接跳去装（2026-11-09 用户：「去安装」放进气泡里直接跳转）
        actions={
          data?.extensionAlive
            ? [{ label: "知道了", onClick: closeTip }]
            : [
                { label: "知道了", onClick: closeTip },
                {
                  label: "去装扩展",
                  onClick: () => {
                    closeTip();
                    setSettingsSectionReq("network");
                    setPage("settings");
                  },
                },
              ]
        }
      >
        <ul className="list-disc space-y-0.5 pl-4">
          <li>
            <b>让 Mesa 代下这批</b>：Mesa 一篇篇去下——先找免费版，再经学校订阅，最后在你的浏览器里下（要装 Mesa 文献下载扩展{data?.extensionAlive ? "，已连接" : "，还没连上"}）。不用守着，每篇后面写它走到哪了。
          </li>
          <li>
            每篇的 <b>官网</b>：你自己去出版商网站下。PDF 存进「下载」文件夹，会自动收进 papers/；存到别处的点 <b>关联</b>。
          </li>
        </ul>
        <p className="mt-1 opacity-80">不管哪种下到的，这一篇都标「已存」。</p>
      </CoachTip>
    )}
    </div>
  );
}
