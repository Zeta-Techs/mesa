import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import LitWatchCard from "./LitWatchCard";
import ScheduleSection from "./ScheduleSection";
import { confirmDialog } from "./ConfirmDialog";
import { normalizeWorkMode } from "../work-mode";
import type { ProjectConfigDto, ProjectDto } from "../types";


/** 项目「定时任务」页：文献雷达（科研）+ 本项目全部定时任务 + 底部其他项目的只读总览。 */
export default function ProjectSchedulesView({
  project,
  focusToken = null,
  onFocusHandled,
  onError,
}: {
  project: ProjectDto;
  focusToken?: number | null;
  onFocusHandled?: () => void;
  onError?: (msg: string) => void;
}) {
  const research = normalizeWorkMode(project.workMode) === "research";
  const [cfg, setCfg] = useState<ProjectConfigDto | null>(null);
  const [core, setCore] = useState<{ enabled: boolean; running: boolean } | null>(null);
  const [coreBusy, setCoreBusy] = useState(false);
  // 后台可能中途挂掉或被桌面重新拉起：开着的页面每 15 秒重读一次，状态不停在打开那一刻
  useEffect(() => {
    let alive = true;
    const load = () => invoke<{ enabled: boolean; running: boolean }>("background_core_status")
      .then((next) => { if (alive) setCore(next); })
      .catch((error) => { if (alive) onError?.(String(error)); });
    void load();
    const timer = window.setInterval(() => { void load(); }, 15000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);
  /** 任务列表增删改的版本号：新建/删除不发 scheduler-run-done（那只管跑完），
   *  雷达卡的空态行与「立即跑」靠这座桥就地翻新，不用切页回来 */
  const [schedulesVersion, setSchedulesVersion] = useState(0);
  /** 订阅保存后让巡检行重读关键词数：没关键词时「立即运行」禁用 */
  const [subsVersion, setSubsVersion] = useState(0);
  const scheduleRef = useRef<HTMLDivElement>(null);

  function reloadCfg() {
    if (!research) {
      setCfg(null);
      return;
    }
    invoke<{ config: ProjectConfigDto }>("read_project_config", {
      path: project.path,
    })
      .then((read) => setCfg(read.config))
      .catch((reason) => {
        setCfg(null);
        onError?.(`项目配置读取失败：${String(reason)}`);
      });
  }

  useEffect(() => {
    reloadCfg();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.path, research]);

  useEffect(() => {
    if (focusToken == null) return;
    onFocusHandled?.();
  }, [focusToken, onFocusHandled]);

  return (
    <div className="space-y-6">
      {core && <label className="flex items-start gap-2 text-xs text-l2">
        <input type="checkbox" checked={core.enabled} disabled={coreBusy} onChange={async (event) => {
          const enabled = event.target.checked;
          if (!enabled) {
            // 关后台会停掉它正在跑的任务：先说清停几条、停了会怎样，人点头才关
            const active = await invoke<{ id: string }[]>("background_core_active_runs").catch(() => []);
            if (active.length > 0) {
              const ok = await confirmDialog(
                `独立后台里有 ${active.length} 个定时任务正在运行。\n\n现在关闭会中断它们，这一轮记为结果不明并暂停跟进，需要你去核对后再继续。`,
                { danger: true, confirmText: "仍然关闭", focusCancel: true },
              );
              if (!ok) return;
            }
          }
          setCoreBusy(true);
          try { setCore(await invoke("background_core_set", { enabled })); }
          catch (error) { onError?.(`独立后台切换失败：${String(error)}`); }
          finally { setCoreBusy(false); }
        }} />
        <span>独立后台：退出桌面后继续运行已授权的定时任务。{core.running ? "后台正在运行。" : core.enabled ? "后台没在运行，Mesa 开着时由桌面接着跑定时任务，并会自动重新拉起后台。" : ""}电脑关机或睡眠时不运行；交互对话不在此范围，成果仍回桌面评审。</span>
      </label>}
      {research && cfg && (
        <LitWatchCard
          projectRoot={project.path}
          cfg={cfg}
          focusToken={focusToken}
          schedulesVersion={schedulesVersion}
          onConfigChanged={reloadCfg}
          onSubscriptionsChanged={() => setSubsVersion((v) => v + 1)}
        />
      )}
      <div ref={scheduleRef}>
        <ScheduleSection
          projectRoot={project.path}
          layout="card"
          subsVersion={subsVersion}
          onSchedulesChanged={() => setSchedulesVersion((v) => v + 1)}
          workMode={project.workMode}
        />
      </div>
    </div>
  );
}
