import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Split } from "lucide-react";
import SplitPlanDialog from "./SplitPlanDialog";
import { compactFieldClass, ghostActionClass, inlineActionClass } from "./PageFrame";
import { parseSplitPlan } from "../split-plan";
import { draftSplitPlan, replyNotice, splitEligibility } from "../split-draft";
import { batchProgress, liveBatches, readBatches, writeBatches, type BatchProgress, type SplitBatch } from "../split-batch";
import { useAppStore } from "../store";
import { toast } from "../toast";
import type { ProjectDto, TaskDto } from "../types";

const BATCH_TONE: Record<BatchProgress["tone"], string> = {
  live: "text-l3",
  done: "text-ok-text",
  fail: "text-err-text",
};

/**
 * 工作台项目分组下的「拆成几个目标同时做」（2026-11-03 用户拍板，取代协调对话；2026-11-05 由「拆成几路做」改名、和「记下一个目标」并一行）：
 * 写一句要做什么，Mesa 在后台调用一次 AI 写拆分方案；方案在的时候写「AI 拆好了：N 个目标待你批准」，点开批准才一起开工。只有能一次开几个目标的项目才有这个入口
 */
export default function SplitPlanRow({
  projectPath,
  projectName,
  footer = null,
  footerExpanded = false,
}: {
  projectPath: string;
  projectName: string;
  /** 「＋ 记下一个目标」：和「拆成几个目标同时做」放同一行（2026-11-05 用户：拆几路没写清用途，单独一行像孤儿） */
  footer?: ReactNode;
  /** 记目标的输入框开着：这一行让给它，不再挤一个按钮 */
  footerExpanded?: boolean;
}) {
  const [plan, setPlan] = useState<string | null>(null);
  const [project, setProject] = useState<ProjectDto | null>(null);
  const [eligible, setEligible] = useState(false);
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** 批准过的几批与各自进度（split-batch.ts）：开了的几路都收场时回报一次，人点「知道了」才收 */
  const [batches, setBatches] = useState<{ batch: SplitBatch; progress: BatchProgress }[]>([]);
  const [batchOpen, setBatchOpen] = useState<string | null>(null);

  async function loadBatches() {
    const list = liveBatches(readBatches(projectPath), Date.now());
    if (list.length === 0) {
      setBatches([]);
      return;
    }
    const tasks = await invoke<TaskDto[]>("task_list", { projectRoot: projectPath, includeArchived: true }).catch(() => null);
    if (!tasks) return;
    const status = new Map(tasks.map((t) => [t.id, t.status]));
    let changed = false;
    const next = list.map((batch) => {
      const progress = batchProgress(batch, (id) => status.get(id) ?? null);
      if (progress.done && !batch.reported) {
        changed = true;
        toast(progress.text, progress.tone === "fail" ? "warning" : "success");
        return { batch: { ...batch, reported: true }, progress };
      }
      return { batch, progress };
    });
    if (changed) writeBatches(projectPath, next.map((x) => x.batch));
    setBatches(next);
  }

  function dismissBatch(id: string) {
    writeBatches(projectPath, readBatches(projectPath).filter((b) => b.id !== id));
    setBatches((cur) => cur.filter((x) => x.batch.id !== id));
  }

  async function load() {
    const got = await invoke<{ text: string } | null>("split_plan_read", { projectRoot: projectPath }).catch(() => null);
    setPlan(got?.text ?? null);
    await loadBatches();
  }

  useEffect(() => {
    let stale = false;
    void splitEligibility(projectPath).then((r) => {
      if (stale) return;
      setProject(r.project);
      setEligible(r.eligible);
    });
    void load();
    const timer = window.setInterval(() => void load(), 20_000);
    return () => {
      stale = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  async function draft() {
    if (!request.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      const reply = await draftSplitPlan({ projectPath, projectName, project, request });
      const note = replyNotice(reply);
      if (note) setNotice(note);
      else {
        setAsking(false);
        setRequest("");
        await load();
        setOpen(true);
      }
    } catch (reason) {
      setNotice(`没写成：${String(reason)}`);
    } finally {
      setBusy(false);
    }
  }

  const lanes = plan ? parseSplitPlan(plan).lanes.length : 0;
  const showTrigger = eligible && !plan && !asking && !footerExpanded;
  const footerRow =
    footer || showTrigger ? (
      <div className="flex flex-wrap items-center gap-1 pb-2 pl-[calc(1.5rem+6px+0.25rem)] pr-4">
        {footer}
        {showTrigger && (
          <button
            type="button"
            className={`${ghostActionClass} h-7 gap-1.5 px-2`}
            title="一件比较大的事交给 AI 拆开：它看过项目后起草拆成几个目标、各做什么交什么；你看过、批准一次才一起开工"
            onClick={() => {
              setAsking(true);
              setNotice(null);
            }}
          >
            <Split size={13} strokeWidth={1.8} aria-hidden="true" />
            <span className="text-micro">拆成几个目标同时做…</span>
          </button>
        )}
      </div>
    ) : null;
  if (!eligible && !plan && batches.length === 0 && !asking) return footerRow;
  return (
    <>
    <div className="pb-1 pl-[calc(1.5rem+6px+0.75rem)] pr-4 text-xs empty:hidden">
      {batches.map(({ batch, progress }) => (
        <div key={batch.id} className="mb-1 min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              className={`min-w-0 truncate text-left hover:underline ${BATCH_TONE[progress.tone]}`}
              title="点开看每个目标"
              onClick={() => setBatchOpen((cur) => (cur === batch.id ? null : batch.id))}
            >
              <span className="text-xs">{progress.text}</span>
            </button>
            {progress.done && (
              <>
                <button
                  type="button"
                  className={inlineActionClass}
                  onClick={() => {
                    const st = useAppStore.getState();
                    st.setSelectProjectReq(projectPath);
                    st.setPage("workspaces");
                  }}
                >
                  <span className="text-xs">去验收</span>
                </button>
                <button type="button" className={inlineActionClass} onClick={() => dismissBatch(batch.id)}>
                  <span className="text-xs">知道了</span>
                </button>
              </>
            )}
          </div>
          {batchOpen === batch.id && (
            <ul className="mt-1 space-y-0.5 text-l3">
              {progress.lines.map((l) => (
                <li key={l.name} className="truncate">
                  {l.name} · {l.label}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {plan ? (
        <button type="button" className="text-warn-text hover:underline" onClick={() => setOpen(true)}>
          <span className="text-xs">AI 拆好了：{lanes} 个目标待你批准</span>
        </button>
      ) : asking ? (
        <>
        <p className="mb-1 text-micro text-l4">
          写一件比较大的事，AI 看过项目后起草拆法：拆成几个目标、各做什么，能同时做的一起开；你批准后才开工。小事直接「记下一个目标」。
        </p>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void draft();
          }}
        >
          <input
            autoFocus
            className={`${compactFieldClass} min-w-0 flex-1`}
            placeholder="要做什么，比如：data/ 下三个批次各做一遍质控，最后出汇总"
            value={request}
            disabled={busy}
            onChange={(e) => setRequest(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setAsking(false);
            }}
          />
          <button type="submit" className={inlineActionClass} disabled={busy || !request.trim()}>
            <span className="text-xs">{busy ? "AI 在写方案…" : "出方案"}</span>
          </button>
          {!busy && (
            <button type="button" className={inlineActionClass} onClick={() => setAsking(false)}>
              <span className="text-xs">取消</span>
            </button>
          )}
        </form>
        </>
      ) : null}
      {notice && <p className="mt-1 text-l3">{notice}</p>}
      {open && plan && (
        <SplitPlanDialog
          projectPath={projectPath}
          projectName={projectName}
          text={plan}
          onClose={() => setOpen(false)}
          onRevised={load}
          onDone={() => {
            setOpen(false);
            void load();
          }}
        />
      )}
    </div>
    {footerRow}
    </>
  );
}
