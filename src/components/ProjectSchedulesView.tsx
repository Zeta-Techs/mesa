import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import LitWatchCard from "./LitWatchCard";
import ScheduleSection from "./ScheduleSection";
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
          showOthers
          workMode={project.workMode}
        />
      </div>
    </div>
  );
}
