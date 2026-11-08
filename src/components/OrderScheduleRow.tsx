// 派活单「定时」一键建成定时任务，默认不启用（2026-11-08，docs/design-autonomy-roadmap.md §8）。
// Mesa 按单子生成技能说明（不调 AI）、建好先不跑；人看过「要做的事」点「启用」才开始。项目助手自己不建、不启用。
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { ghostActionClass } from "./PageFrame";
import { cadenceLabel, parseOrderCadence } from "../order-schedule";

interface ScheduleLite {
  id: string;
  name: string;
  enabled: boolean;
}

interface PausedScheduleDto {
  schedule: ScheduleLite;
  skillName: string;
  skillText: string;
}

interface Saved {
  id: string;
  skillName: string;
  skillText: string;
}

function readSaved(key: string): Saved | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

export default function OrderScheduleRow({
  projectPath,
  title,
  intent,
  scheduleText,
  storageKey,
  onOpenSchedules,
}: {
  projectPath: string;
  title: string;
  intent: string;
  scheduleText: string;
  /** 同一张单子建过就认回（项目 + 派出时刻） */
  storageKey: string;
  onOpenSchedules: () => void;
}) {
  const cadence = parseOrderCadence(scheduleText);
  const [saved, setSaved] = useState<Saved | null>(() => readSaved(storageKey));
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!saved) return;
    let stale = false;
    void invoke<ScheduleLite[]>("list_schedules").then(
      (list) => {
        if (stale) return;
        const hit = list.find((s) => s.id === saved.id);
        if (!hit) {
          // 在定时任务页删掉了：卡片回到能再建的样子
          localStorage.removeItem(storageKey);
          setSaved(null);
        } else setEnabled(hit.enabled);
      },
      () => {},
    );
    return () => {
      stale = true;
    };
  }, [saved, storageKey]);

  async function create() {
    setBusy(true);
    setErr(null);
    try {
      const dto = await invoke<PausedScheduleDto>("create_paused_schedule", {
        input: {
          projectRoot: projectPath,
          name: title,
          intent,
          frequency: cadence.frequency,
          weekday: cadence.weekday,
          intervalHours: cadence.intervalHours,
          hour: cadence.hour,
          minute: cadence.minute,
        },
      });
      const next = { id: dto.schedule.id, skillName: dto.skillName, skillText: dto.skillText };
      localStorage.setItem(storageKey, JSON.stringify(next));
      setSaved(next);
      setEnabled(dto.schedule.enabled);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function setOn(on: boolean) {
    if (!saved) return;
    setBusy(true);
    setErr(null);
    try {
      const s = await invoke<ScheduleLite>("update_schedule", { id: saved.id, patch: { enabled: on } });
      setEnabled(s.enabled);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    if (!saved) return;
    setBusy(true);
    setErr(null);
    try {
      await invoke("delete_schedule", { id: saved.id });
      localStorage.removeItem(storageKey);
      setSaved(null);
      setEnabled(null);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  const when = cadenceLabel(cadence);
  if (!saved) {
    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          className={ghostActionClass}
          disabled={busy}
          onClick={() => void create()}
          title={`按「${when}」建好定时任务，先不启用；你看过要做的事再点「启用」`}
        >
          {busy ? "建定时任务…" : "建成定时任务（先不启用）"}
        </button>
        {err && <p className="break-words text-xs text-err-text">{err}</p>}
      </div>
    );
  }
  return (
    <div className="mt-2 w-full min-w-0 rounded-md border border-hairline p-2 text-xs leading-5">
      <p className="text-l2">
        定时任务「{title}」：{when} · {enabled === true ? <span className="text-ok-text">已启用</span> : "还没启用"}
      </p>
      <p className="text-l3">在隔离副本里跑，结果经你评审才进项目；连接用定时任务的默认连接。</p>
      {cadence.guessed && (
        <p className="text-warn-text">
          没认出「{scheduleText}」是多久一次，先按 {when} 建的；启用前点「改一改」改周期。
        </p>
      )}
      {saved.skillText && (
        <details className="mt-1">
          <summary className="cursor-pointer text-l3 hover:text-l1">看每次要做的事（技能 {saved.skillName}）</summary>
          <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-hover/40 p-1.5 font-mono text-micro text-l2">
            {saved.skillText}
          </pre>
        </details>
      )}
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {enabled ? (
          <button type="button" className={ghostActionClass} disabled={busy} onClick={() => void setOn(false)}>
            停用
          </button>
        ) : (
          <button type="button" className={ghostActionClass} disabled={busy} onClick={() => void setOn(true)}>
            启用
          </button>
        )}
        <button type="button" className={ghostActionClass} disabled={busy} onClick={onOpenSchedules}>
          改一改
        </button>
        <button type="button" className={ghostActionClass} disabled={busy} onClick={() => void undo()} title="删掉这个定时任务（技能留在技能库里）">
          撤销
        </button>
      </div>
      {err && <p className="break-words text-err-text">{err}</p>}
    </div>
  );
}
