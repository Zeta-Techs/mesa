import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import SplitPlanDialog from "./SplitPlanDialog";
import { compactFieldClass, inlineActionClass } from "./PageFrame";
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
 * 工作台项目分组下的「拆成几路做」（2026-11-03 用户拍板，取代协调对话）：写一句要做什么，Mesa 在后台调用一次 AI 写拆分方案；
 * 方案在的时候这一行写「拆分方案待你批准（N 路）」，点开批准才一起开工。只有能一次开几路的项目才画这一行
 */
export default function SplitPlanRow({ projectPath, projectName }: { projectPath: string; projectName: string }) {
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

  if (!eligible && !plan && batches.length === 0) return null;
  const lanes = plan ? parseSplitPlan(plan).lanes.length : 0;
  return (
    <div className="pb-1 pl-[calc(1.5rem+6px+0.75rem)] pr-4 text-xs">
      {batches.map(({ batch, progress }) => (
        <div key={batch.id} className="mb-1 min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              className={`min-w-0 truncate text-left hover:underline ${BATCH_TONE[progress.tone]}`}
              title="点开看每一路"
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
          <span className="text-xs">拆分方案待你批准（{lanes} 路）</span>
        </button>
      ) : asking ? (
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
      ) : (
        <button
          type="button"
          className="text-l3 hover:text-l1"
          title="写一句要做什么，AI 起草拆成几路同时做的方案；你看过、批准一次才开"
          onClick={() => {
            setAsking(true);
            setNotice(null);
          }}
        >
          <span className="text-xs">拆成几路做…</span>
        </button>
      )}
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
  );
}
