import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import ProjectAssistantPanel from "./ProjectAssistantPanel";
import { useAppStore } from "../store";
import { samePath } from "../path-utils";
import { IS_WINDOWS } from "../hotkeys";
import { toast } from "../toast";
import { runAssistantAction } from "../assistant-actions";
import { dispatchWorkOrder } from "../assistant-dispatch";
import {
  ASSISTANT_WIDTH_KEY,
  assistantWhere,
  canDockAssistant,
  clampAssistantWidth,
} from "../assistant-dock";
import { readProjectSurfaceTab } from "../project-surface";
import { ECHO_POLL_MS, pollAssistantEchoes, seeAssistantEchoes } from "../assistant-echo-watch";
import { pushNewGrants, pushNewHelp, pushStuck, startImBridge } from "../im-bridge";
import { startDeskPetHost } from "../desk-pet-host";
import type { ProjectConfigReadDto, ProjectDto } from "../types";

function savedWidth(): number {
  try {
    const raw = localStorage.getItem(ASSISTANT_WIDTH_KEY);
    return clampAssistantWidth(raw ? Number(raw) : -1);
  } catch {
    return clampAssistantWidth(-1);
  }
}

/**
 * 项目助手的唯一宿主（2026-11-04 改成全局，App 挂一份）：工作台项目头、项目页、步骤「出错了」、红色报错提示的「问问为什么」
 * 都经 store.openAssistant 叫它出来。这里补齐它要的项目信息（项目条目、步骤数），按钮与派活交给 assistant-actions / assistant-dispatch。
 * 2026-11-05 用户拍板「右侧常驻侧栏」：窗口够宽时放进 App 主区右边的 #ccode-assistant-dock（页面让出宽度、照常能点，
 * 切页签 / 换页都留着，在项目页换到别的项目就跟着切），不够宽仍是浮层抽屉；宽度可拖、记在本机。
 */
export default function ProjectAssistantHost() {
  const req = useAppStore((s) => s.assistantReq);
  const closeAssistant = useAppStore((s) => s.closeAssistant);
  const openAssistant = useAppStore((s) => s.openAssistant);
  const page = useAppStore((s) => s.page);
  const contextLabel = useAppStore((s) => s.contextLabel);
  const [project, setProject] = useState<ProjectDto | null>(null);
  const [stepCount, setStepCount] = useState(0);
  const path = req?.path ?? null;

  // 派活回音（2026-11-05）：应用开着就每分钟看一次派出去的活，做完 / 失败 / 停了在问答里补一条、进收件箱
  // 飞书通道（2026-11-06）：收手机消息与卡片按钮；新出现的人工请求推到手机。没配飞书时这些都是空转
  useEffect(() => {
    void pollAssistantEchoes();
    void pushNewHelp();
    void pushNewGrants();
    const timer = window.setInterval(() => {
      void pollAssistantEchoes();
      void pushNewHelp();
      void pushNewGrants();
    }, ECHO_POLL_MS);
    // 卡住了（信任文件夹 / 等确认）要早点说：20 秒看一次，不跟回音同频
    const stuckTimer = window.setInterval(() => void pushStuck(), 20_000);
    let stop: (() => void) | null = null;
    let cancelled = false;
    void startImBridge().then((off) => {
      if (cancelled) off();
      else stop = off;
    });
    // 桌宠（2026-11-09）：给桌面上的小桌供清单、办它那边点的事；没开桌宠时只听不取
    let stopPet: (() => void) | null = null;
    void startDeskPetHost().then((off) => {
      if (cancelled) off();
      else stopPet = off;
    });
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.clearInterval(stuckTimer);
      stop?.();
      stopPet?.();
    };
  }, []);
  const echoTick = useAppStore((s) => s.assistantEchoTick);
  useEffect(() => {
    if (path) seeAssistantEchoes(path);
  }, [path, echoTick]);

  useEffect(() => {
    if (!path) return;
    let stale = false;
    void invoke<ProjectDto[]>("list_projects")
      .then((list) => {
        if (!stale) setProject(list.find((p) => samePath(p.path, path, IS_WINDOWS)) ?? null);
      })
      .catch(() => {});
    void invoke<ProjectConfigReadDto>("read_project_config", { path })
      .then((read) => {
        if (!stale) setStepCount(read.config.steps.length);
      })
      .catch(() => {
        if (!stale) setStepCount(0);
      });
    return () => {
      stale = true;
    };
  }, [path]);

  // 在项目页换到别的项目：开着的项目助手跟过去（只认「变了」，不拿上次看过的项目顶掉从工作台叫出来的那个）
  const lastViewed = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const viewing = contextLabel?.projectPath ?? null;
    const before = lastViewed.current;
    lastViewed.current = viewing;
    if (before === undefined || !viewing || !req || page !== "workspaces") return;
    if (before && samePath(before, viewing, IS_WINDOWS)) return;
    if (samePath(req.path, viewing, IS_WINDOWS)) return;
    openAssistant(viewing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextLabel?.projectPath]);

  // 常驻还是浮层：量主区（连同侧栏现在占的宽），够宽才常驻
  const [width, setWidth] = useState(savedWidth);
  const widthRef = useRef(width);
  widthRef.current = width;
  const [dockEl, setDockEl] = useState<HTMLElement | null>(null);
  const [roomy, setRoomy] = useState(false);
  useEffect(() => {
    const dock = document.getElementById("ccode-assistant-dock");
    const main = document.querySelector<HTMLElement>(".ccode-app-main");
    setDockEl(dock);
    if (!dock || !main || typeof ResizeObserver === "undefined") return;
    const measure = () => setRoomy(canDockAssistant(main.clientWidth + dock.clientWidth, width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(main);
    ro.observe(dock);
    return () => ro.disconnect();
  }, [width]);
  const docked = !!req && roomy && !!dockEl;
  const setAssistantDocked = useAppStore((s) => s.setAssistantDocked);
  useEffect(() => {
    setAssistantDocked(docked);
  }, [docked, setAssistantDocked]);

  const viewing = contextLabel
    ? { project: contextLabel.project, samePath: !!path && !!contextLabel.projectPath && samePath(contextLabel.projectPath, path, IS_WINDOWS), step: contextLabel.step }
    : null;
  const where = path
    ? assistantWhere({
        page,
        assistantProject: project?.name ?? path.split(/[\\/]/).filter(Boolean).pop() ?? "",
        viewing,
        tab: page === "workspaces" && viewing?.samePath ? readProjectSurfaceTab(path, undefined, project?.workMode) : null,
        workMode: project?.workMode,
      })
    : "";

  const panel = (
    <ProjectAssistantPanel
      open={!!req}
      onClose={closeAssistant}
      projectPath={path}
      projectName={project?.name ?? path?.split(/[\\/]/).filter(Boolean).pop() ?? ""}
      project={project}
      stepCount={stepCount}
      where={where}
      hideProjectName={docked && !!viewing?.samePath}
      docked={
        docked
          ? {
              width,
              onResize: (w) => setWidth(clampAssistantWidth(w)),
              onResizeEnd: () => {
                try {
                  localStorage.setItem(ASSISTANT_WIDTH_KEY, String(widthRef.current));
                } catch {
                  /* 存不下只是下次回默认宽 */
                }
              },
            }
          : null
      }
      ask={req?.question ? { question: req.question, focus: req.focus ?? null, nonce: req.nonce } : null}
      onAction={(action, turn) => {
        if (path) void runAssistantAction(action, turn, { path, project });
      }}
      onDispatch={async (order) => {
        if (!path) throw new Error("项目助手已经关了");
        const result = await dispatchWorkOrder({ order, projectPath: path, project });
        toast(result.note, "success");
        return result;
      }}
    />
  );
  return docked && dockEl ? createPortal(panel, dockEl) : panel;
}
