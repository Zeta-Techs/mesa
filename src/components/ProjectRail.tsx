import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FolderOpen, GitBranch } from "lucide-react";
import type {
  CodingOverviewDto,
  ProjectConfigReadDto,
  ProjectDto,
  WorkspaceDto,
} from "../types";
import { FoldMark, InlineNotice } from "./PageFrame";
import { IS_WINDOWS } from "../hotkeys";
import { pathWithin } from "../path-utils";
import { normalizeWorkMode } from "../work-mode";
import {
  buildProjectRailSections,
  type RailCodingTree,
  type RailTabSummary,
} from "../project-rail";

export type { RailTabSummary };

function basenameOf(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * 左栏「项目」区：科研活跃工作区 ∪ 正在跑/等确认的已添加项目 ∪ 当前标签所属项目。
 * 当前项置顶标「当前」。点击切终端上下文；编程工作树/办公文档不在这里铺开。
 */
function ProjectRail({
  cwd,
  pageVisible,
  refreshKey,
  agentRunning,
  tabs,
  onEnter,
  onOpenNewTab,
}: {
  /** 活动标签 cwd（项目归属与高亮判定的锚点） */
  cwd: string;
  /** 终端页可见性：从别页回来时重新拉取工作区列表 */
  pageVisible: boolean;
  /** 左栏 ⟳ 刷新键（与文件树共用） */
  refreshKey: number;
  /** 活动标签 agent 运行中：切换目标改为新标签，不打断当前会话 */
  agentRunning: boolean;
  /** 全部终端标签的状态摘要（工作区行的注意力点） */
  tabs: RailTabSummary[];
  /** 复用 enterCwd「真进入」链路 */
  onEnter: (path: string) => void;
  /** 当前标签运行中时，在新标签打开目标上下文，避免打断正在运行的 Agent */
  onOpenNewTab: (path: string) => void;
}) {
  // 项目区整体折叠：默认展开
  const [collapsed, setCollapsed] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceDto[]>([]);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [codingTrees, setCodingTrees] = useState<RailCodingTree[]>([]);
  /** 仓库根 →（工作区名 → 流水线步骤名），按小节分别读 project.toml（best-effort） */
  const [stepNames, setStepNames] = useState<Record<string, Record<string, string>>>({});
  /** 仓库根 →（工作区名 → 流程顺序），仅用于项目 rail 的低噪声序号 */
  const [stepOrders, setStepOrders] = useState<Record<string, Record<string, number>>>({});
  const [hint, setHint] = useState<string | null>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    },
    [],
  );

  // 工作区列表：进入终端页拉一次；⟳、回到本页、工作区归档事件时刷新
  const reload = useCallback(() => {
    invoke<WorkspaceDto[]>("list_workspaces")
      .then(setWorkspaces)
      .catch(() => {});
    invoke<ProjectDto[]>("list_projects")
      .then(setProjects)
      .catch(() => {});
  }, []);
  useEffect(() => {
    reload();
  }, [reload, refreshKey, pageVisible]);
  useEffect(() => {
    let un: (() => void) | undefined;
    listen("ws-archived", () => reload()).then((u) => (un = u));
    return () => un?.();
  }, [reload]);

  useEffect(() => {
    const coding = projects.filter(
      (p) => normalizeWorkMode(p.workMode) === "coding",
    );
    if (coding.length === 0) {
      setCodingTrees([]);
      return;
    }
    let cancelled = false;
    void Promise.all(
      coding.map((p) =>
        invoke<CodingOverviewDto>("coding_overview", { repoPath: p.path })
          .then((ov) =>
            ov.worktrees.map((t) => ({ repoPath: p.path, path: t.path })),
          )
          .catch(() => [] as RailCodingTree[]),
      ),
    ).then((rows) => {
      if (!cancelled) setCodingTrees(rows.flat());
    });
    return () => {
      cancelled = true;
    };
  }, [projects, refreshKey, pageVisible]);

  const sections = useMemo(
    () =>
      buildProjectRailSections({
        cwd,
        projects,
        workspaces,
        codingTrees,
        tabs,
        isWindows: IS_WINDOWS,
      }),
    [cwd, projects, workspaces, codingTrees, tabs],
  );

  // 步骤名映射：逐小节仓库读一次 project.toml（失败则只显示工作区名）
  useEffect(() => {
    let cancelled = false;
    for (const sec of sections) {
      invoke<ProjectConfigReadDto>("read_project_config", { path: sec.repo })
        .then((read) => {
          if (cancelled) return;
          const map: Record<string, string> = {};
          const orders: Record<string, number> = {};
          for (const [index, s] of read.config.steps.entries()) {
            if (s.workspaceName) {
              map[s.workspaceName] = s.name;
              orders[s.workspaceName] = index + 1;
            }
          }
          setStepNames((prev) => ({ ...prev, [sec.repo]: map }));
          setStepOrders((prev) => ({ ...prev, [sec.repo]: orders }));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [sections]);

  /** 项目/工作区点击 = 切换终端上下文；Agent 运行中改为新标签打开 */
  function enter(path: string) {
    if (agentRunning) {
      onOpenNewTab(path);
      setHint(`当前 Agent 正在运行，已在新标签打开「${basenameOf(path)}」`);
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      hintTimerRef.current = setTimeout(() => setHint(null), 3000);
      return;
    }
    onEnter(path);
  }

  if (sections.length === 0) return null;

  /** 主文件夹：当前项且不在科研工作树里时高亮；活标签点打在主上（工作树上的点仍在工作区行） */
  function renderMainRow(sec: (typeof sections)[number]) {
    const wsActive = sec.ws.some((w) =>
      pathWithin(cwd, w.worktreePath, IS_WINDOWS),
    );
    const mainActive = sec.current && !wsActive;
    const mainDot =
      sec.mainLive === "confirm"
        ? "bg-warn-text"
        : sec.mainLive === "working"
          ? "bg-ok-text animate-pulse-brief"
          : sec.mainLive === "running"
            ? "bg-ok-text"
            : null;
    return (
      <div>
        <div
          className={`mx-1 flex items-center gap-1 rounded-md py-1.5 pr-2 text-xs transition-colors ${
            mainActive ? "bg-rail-sel text-l1" : "hover:bg-hover"
          }`}
          style={{ paddingLeft: 6 }}
        >
          <FolderOpen
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-l4"
            strokeWidth={1.8}
          />
          <span
            onClick={() => enter(sec.repo)}
            title={`${sec.repo}\n点击切到项目文件夹`}
            className="min-w-0 flex-1 cursor-pointer truncate font-medium text-l2 hover:text-l1"
          >
            {sec.name}
          </span>
          {sec.ws.length > 0 && (
            <span className="shrink-0 text-micro text-l4">主</span>
          )}
          {mainDot && (
            <span
              className={`size-2 shrink-0 rounded-full ${mainDot}`}
              title={sec.mainLive === "confirm" ? "待确认" : "工作中"}
            />
          )}
        </div>
      </div>
    );
  }

  /** 活跃工作区行（交互、悬浮信息、状态点与原实现一致） */
  function renderWsRow(sec: (typeof sections)[number], w: (typeof sections)[number]["ws"][number]) {
    const wsActive = pathWithin(cwd, w.worktreePath, IS_WINDOWS);
    const tab = tabs.find((t) => pathWithin(t.cwd, w.worktreePath, IS_WINDOWS));
    // 「已回复」不打点（回合结束每轮都发生，不是待办）；只留 待确认 > 工作中 > 运行中
    const dot =
      tab?.attention === "confirm"
        ? "bg-warn-text"
        : tab?.attention === "working"
          ? "bg-ok-text animate-pulse-brief"
          : tab?.running
            ? "bg-ok-text"
            : null;
    const stepName = stepNames[sec.repo]?.[w.name];
    return (
      <div key={w.id}>
        <div
          className={`mx-1 flex items-center gap-1 rounded-md py-1.5 pr-2 text-xs transition-colors ${
            wsActive ? "bg-rail-sel text-l1" : "hover:bg-hover"
          }`}
          style={{ paddingLeft: 18 }}
        >
          {stepName ? (
            <span
              className="flex h-4 min-w-5 shrink-0 items-center justify-center rounded-sm bg-inset px-1 font-mono text-micro leading-none text-l4"
              title={`研究流程第 ${stepOrders[sec.repo]?.[w.name] ?? ""} 步`}
            >
              {String(stepOrders[sec.repo]?.[w.name] ?? "·").padStart(2, "0")}
            </span>
          ) : (
            <GitBranch
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 text-l4"
              strokeWidth={1.8}
            />
          )}
          <span
            onClick={() => enter(w.worktreePath)}
            title={`${w.worktreePath}\n分支 ${w.branch}，点击切到该工作区`}
            className="min-w-0 flex-1 cursor-pointer truncate text-l2 hover:text-l1"
          >
            {w.name}
            {stepName && (
              <span className="text-l4"> · {stepName}</span>
            )}
          </span>
          {dot && (
            <span
              className={`size-2 shrink-0 rounded-full ${dot}`}
              title={tab?.attention === "confirm" ? "待确认" : "工作中"}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="shrink-0">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center gap-1 px-2 py-2 text-left text-micro text-l4 hover:text-l2"
      >
        <FoldMark open={!collapsed} boxed />
        <span>项目</span>
      </button>
      {!collapsed && (
        <div className="max-h-56 overflow-auto pb-1">
          <p className="px-2 pb-1 text-micro text-l4">
            进行中的项目
          </p>
          {sections.map((sec) => (
            <div key={sec.repo}>
              {/* 多小节时组头标仓库名；当前项目标注「当前」（单小节保持原样，不加噪音） */}
              {sections.length > 1 && (
                <p
                  className={`truncate px-2 pb-0.5 pt-1.5 text-micro ${sec.current ? "text-l2" : "text-l4"}`}
                  title={sec.repo}
                >
                  {sec.name}
                  {sec.current && " · 当前"}
                </p>
              )}
              {renderMainRow(sec)}
              {sec.ws.map((w) => renderWsRow(sec, w))}
              {sec.current &&
                sec.ws.length === 0 &&
                sec.workMode !== "coding" &&
                sec.workMode !== "office" && (
                <p className="py-0.5 text-micro text-l4" style={{ paddingLeft: 18 }}>
                  暂无活跃工作区
                </p>
              )}
            </div>
          ))}
          {hint && <InlineNotice tone="warn" size="micro" className="px-2 py-0.5">{hint}</InlineNotice>}
        </div>
      )}
    </div>
  );
}

export default memo(ProjectRail);
