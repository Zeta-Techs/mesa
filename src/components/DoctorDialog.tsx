import { useEffect, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { primaryActionClass, secondaryActionClass } from "./PageFrame";
import { confirmDialog } from "./ConfirmDialog";
import {
  gotoHint,
  isBlocked,
  orderFindings,
  recentlyPassed,
  rememberPass,
  type DoctorFinding,
  type DoctorIntent,
  type DoctorReport,
} from "../project-doctor";

interface GateRequest {
  workspaceId: string;
  intent: DoctorIntent;
  stepName: string;
  report: DoctorReport;
  resolve: (ok: boolean) => void;
}

// 模块级单请求（同 ConfirmDialog）：宿主经 useSyncExternalStore 订阅
let current: GateRequest | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

function settle(ok: boolean) {
  const req = current;
  current = null;
  emit();
  req?.resolve(ok);
}

/** 入口动手前的体检。返回 true 可以接着做；false 人在体检框里取消了。体检本身失败不挡（照旧往下，原来的报错兜底） */
export async function doctorGate(workspaceId: string, intent: DoctorIntent, stepName: string): Promise<boolean> {
  if (recentlyPassed(workspaceId, intent)) return true;
  let report: DoctorReport;
  try {
    report = await invoke<DoctorReport>("workspace_doctor", { id: workspaceId, intent });
  } catch {
    return true;
  }
  if (!isBlocked(report)) {
    rememberPass(workspaceId, intent);
    return true;
  }
  current?.resolve(false);
  return new Promise<boolean>((resolve) => {
    current = { workspaceId, intent, stepName, report, resolve };
    emit();
  });
}

/** 宿主：在 App 根部挂一次；z-60（评审内弹层档）压过评审覆盖层、在确认框（z-70）之下——出口要确认时确认框盖在它上面 */
export function DoctorDialogHost() {
  const req = useSyncExternalStore(subscribe, () => current);
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReport(req?.report ?? null);
    setNotes(req?.report.fixed ?? []);
    setError(null);
    setBusy(null);
  }, [req]);

  if (!req || !report) return null;

  async function recheck() {
    if (!req) return;
    const next = await invoke<DoctorReport>("workspace_doctor", { id: req.workspaceId, intent: req.intent });
    setNotes((prev) => [...prev, ...next.fixed]);
    setReport(next);
    if (!isBlocked(next)) {
      rememberPass(req.workspaceId, req.intent);
      settle(true);
    }
  }

  async function runFix(f: DoctorFinding) {
    if (!req || !f.fix || f.fix.kind !== "click") return;
    if (f.fix.confirm && !(await confirmDialog(f.fix.confirm, { confirmText: f.fix.label }))) return;
    setBusy(f.code);
    setError(null);
    try {
      const said = await invoke<string>("workspace_doctor_fix", { id: req.workspaceId, code: f.code });
      setNotes((prev) => [...prev, said]);
      await recheck();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  }

  const findings = orderFindings(report.findings);
  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/40 p-6 ccode-fade">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="ccode-doctor-title"
        className="flex max-h-full w-full max-w-[32rem] flex-col rounded-lg border border-hairline ccode-float-surface p-5"
      >
        <h2 id="ccode-doctor-title" className="text-sm font-semibold leading-6 text-l1">
          「{req.stepName}」继续之前，先处理这几件事
        </h2>
        <div className="mt-3 min-h-0 space-y-2 overflow-y-auto text-sm leading-6 text-l2">
          {notes.map((note, i) => (
            <p key={i} className="flex gap-2 text-xs leading-5 text-l3">
              <CircleCheck size={13} strokeWidth={1.8} className="mt-1 shrink-0 text-ok-text" aria-hidden="true" />
              <span className="min-w-0 break-words">已替你处理：{note}</span>
            </p>
          ))}
          {findings.map((f) => (
            <div key={f.code} className="rounded-md ccode-well px-3 py-2">
              <p className="flex gap-2">
                <TriangleAlert
                  size={14}
                  strokeWidth={1.8}
                  className={`mt-1 shrink-0 ${f.blocks ? "text-warn-text" : "text-l4"}`}
                  aria-hidden="true"
                />
                <span className="min-w-0 break-words text-l1">{f.text}</span>
              </p>
              {f.fix?.kind === "click" && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void runFix(f)}
                  className={`${secondaryActionClass} mt-2`}
                >
                  {busy === f.code ? "处理中…" : f.fix.label}
                </button>
              )}
              {f.fix?.kind === "goto" && (
                <p className="mt-1 text-xs leading-5 text-l3">{gotoHint(f.fix, req.stepName)}</p>
              )}
            </div>
          ))}
          {error && <p className="text-xs text-err-text">{error}</p>}
        </div>
        <div className="mt-5 flex shrink-0 justify-end gap-2">
          <button type="button" onClick={() => settle(false)} className={`${secondaryActionClass} min-w-16`}>
            取消
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void recheck().catch((reason) => setError(String(reason)))}
            className={`${primaryActionClass} min-w-16`}
          >
            处理好了，继续
          </button>
        </div>
      </section>
    </div>
  );
}
