import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronsUpDown } from "lucide-react";
import ContextMenu from "./ContextMenu";
import { confirmDialog } from "./ConfirmDialog";
import {
  compactFieldClass,
  inlineActionClass,
} from "./PageFrame";
import { abbrevHome } from "../path-utils";
import { IS_WINDOWS } from "../hotkeys";
import { normalizeWorkMode, WORK_MODE_LABEL, headerShowsTopic } from "../work-mode";
import type { ProjectConfigDto, ProjectConfigReadDto, ProjectDto } from "../types";

export type ProjectChromeAction =
  | "settings"
  | "editor"
  | "history"
  | "rename"
  | "topic";

export default function ProjectIdentityHeader({
  project,
  repoPath,
  repoName,
  homeDir,
  refreshToken,
  leading,
  chromeReq,
  onOpenProjectSwitch,
  onRegisterProject,
  onRefresh,
  onError,
  onChromeAction,
}: {
  project: ProjectDto | null;
  repoPath: string;
  repoName: string;
  homeDir: string;
  refreshToken: number;
  leading?: ReactNode;
  chromeReq?: { action: ProjectChromeAction; token: number } | null;
  /** 项目栏收起时传入：课题名变成切换下拉的入口，锚点坐标由这里报给调用方弹菜单 */
  onOpenProjectSwitch?: (anchor: { x: number; y: number }) => void;
  onRegisterProject: (repoPath: string) => void;
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
  onChromeAction: (action: ProjectChromeAction) => void;
}) {
  const registered = project !== null;
  const displayName = project?.name ?? repoName;
  const workMode = normalizeWorkMode(project?.workMode);
  const [cfg, setCfg] = useState<ProjectConfigDto | null>(null);
  const [cfgWarnings, setCfgWarnings] = useState<string[]>([]);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [editingTopic, setEditingTopic] = useState(false);
  const [topicDraft, setTopicDraft] = useState("");
  const [warnOpen, setWarnOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!project) {
      setCfg(null);
      setCfgWarnings([]);
      return;
    }
    let stale = false;
    invoke<ProjectConfigReadDto>("read_project_config", { path: project.path })
      .then((read) => {
        if (stale) return;
        setCfg(read.config);
        setCfgWarnings(read.warnings);
      })
      .catch(() => {
        if (!stale) setCfg(null);
      });
    return () => {
      stale = true;
    };
  }, [project, refreshToken]);

  useEffect(() => {
    if (chromeReq?.action === "rename") {
      setNameDraft(project?.name ?? "");
      setRenaming(true);
    }
    if (chromeReq?.action === "topic") {
      setTopicDraft(cfg?.topic ?? "");
      setEditingTopic(true);
    }
  }, [chromeReq, cfg?.topic, project?.name]);

  const liteResearch =
    registered &&
    workMode === "research" &&
    !!cfg?.pipelineOptOut &&
    (cfg.steps?.length ?? 0) === 0;
  const showTopic = headerShowsTopic({
    registered,
    workMode: project?.workMode,
  });
  const showMenu = registered;
  const topicText = cfg?.topic?.trim() ?? "";

  async function submitRename(event: FormEvent) {
    event.preventDefault();
    if (!project) return;
    try {
      await invoke("register_project", {
        path: project.path,
        name: nameDraft.trim(),
      });
      setRenaming(false);
      await onRefresh();
    } catch (reason) {
      onError(String(reason));
    }
  }

  async function submitTopic(event: FormEvent) {
    event.preventDefault();
    if (!project || !cfg) return;
    const topic = topicDraft.trim();
    try {
      await invoke("write_project_config", {
        path: project.path,
        config: { ...cfg, topic: topic || null },
      });
      setCfg({ ...cfg, topic: topic || null });
      setEditingTopic(false);
    } catch (reason) {
      onError(String(reason));
    }
  }

  async function removeRegistration() {
    if (!project) return;
    if (
      !(await confirmDialog(
        `只移除「${project.name}」的项目注册，不删除磁盘目录；项目内工作区保留。继续？`,
      ))
    )
      return;
    try {
      await invoke("remove_project", { path: project.path });
      await onRefresh();
    } catch (reason) {
      onError(String(reason));
    }
  }

  return (
    <header className="ccode-page-header sticky top-0 z-20 mb-4 py-1.5">
      <div className="flex min-h-9 min-w-0 items-center gap-2">
        {leading}
        {renaming ? (
          <form onSubmit={submitRename} className="flex min-w-0 items-center gap-1">
            <input
              className={compactFieldClass}
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              autoFocus
              required
            />
            <button type="submit" className={inlineActionClass}>
              确定
            </button>
            <button
              type="button"
              className={inlineActionClass}
              onClick={() => setRenaming(false)}
            >
              取消
            </button>
          </form>
        ) : onOpenProjectSwitch ? (
          // 项目栏收起态：课题名即切换入口（常驻 ⇅ 示意可点），点击把锚点报给页面弹菜单；
          // 展开态不传该 prop，课题名仍是纯标题——列表本身就是切换器，不重复摆第二个
          <h1 className="shrink-0 text-base font-semibold tracking-tight text-l1">
            <button
              type="button"
              aria-label={`切换课题，当前：${displayName}`}
              title="点击切换课题"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                onOpenProjectSwitch({ x: rect.left, y: rect.bottom + 4 });
              }}
              className="-ml-1.5 flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-hover"
            >
              {displayName}
              <ChevronsUpDown
                aria-hidden="true"
                size={14}
                strokeWidth={1.8}
                className="shrink-0 text-l4"
              />
            </button>
          </h1>
        ) : (
          <h1 className="shrink-0 text-base font-semibold tracking-tight text-l1">
            {displayName}
          </h1>
        )}
        {registered && (
          <span className="shrink-0 rounded-full bg-strip px-2 py-0.5 text-micro text-l2">
            {WORK_MODE_LABEL[workMode]}
          </span>
        )}
        {showTopic &&
          (topicText ? (
            <button
              type="button"
              className="min-w-0 max-w-[16rem] truncate text-left text-sm text-l3 hover:text-l1"
              title={topicText}
              onClick={() => {
                setTopicDraft(topicText);
                setEditingTopic(true);
              }}
            >
              {topicText}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setTopicDraft("");
                setEditingTopic(true);
              }}
              className="shrink-0 text-xs text-l4 hover:text-l2"
              title="课题主题会写进每次开工的 TASK.md"
            >
              ＋ 写一句课题主题
            </button>
          ))}
        {!registered && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-inset px-1.5 py-0.5 text-xs text-l3">
            <span className="size-2 rounded-full bg-l4" />
            未添加
          </span>
        )}
        {cfgWarnings.length > 0 && (
          <span className="relative shrink-0">
            <button
              type="button"
              aria-expanded={warnOpen}
              title="查看全部校验提示"
              className="rounded-sm px-1 text-xs text-warn-text hover:bg-hover"
              onClick={() => setWarnOpen((open) => !open)}
            >
              ! {cfgWarnings.length}
            </button>
            {warnOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setWarnOpen(false)}
                />
                <ul className="absolute left-0 z-50 mt-1 w-72 space-y-1.5 rounded-md border border-hairline p-2 ccode-float-surface">
                  {cfgWarnings.map((warning, index) => (
                    <li key={index} className="break-words text-xs text-l2">
                      {warning}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </span>
        )}
        <span
          className="min-w-0 flex-1 truncate font-mono text-micro text-l4"
          title={repoPath}
        >
          {abbrevHome(repoPath, homeDir, IS_WINDOWS)}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {!registered && (
            <button
              type="button"
              className={inlineActionClass}
              title="添加到 Mesa"
              onClick={() => onRegisterProject(repoPath)}
            >
              添加到 Mesa
            </button>
          )}
          {showMenu && (
            <button
              type="button"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setMenu({ x: rect.right, y: rect.bottom + 4 });
              }}
              title="项目操作"
              aria-label={`项目操作：${displayName}`}
              className="flex h-7 w-7 items-center justify-center rounded-sm text-sm text-l3 hover:bg-hover hover:text-l1"
            >
              ⋯
            </button>
          )}
        </div>
      </div>
      {editingTopic && cfg && (
        <form onSubmit={submitTopic} className="mt-1 flex items-center gap-1">
          <input
            className={`${compactFieldClass} min-w-0 flex-1`}
            value={topicDraft}
            onChange={(event) => setTopicDraft(event.target.value)}
            placeholder="课题主题：一键开步时写进 TASK.md；留空清除"
            autoFocus
          />
          <button type="submit" className={inlineActionClass}>
            保存
          </button>
          <button
            type="button"
            className={inlineActionClass}
            onClick={() => setEditingTopic(false)}
          >
            取消
          </button>
        </form>
      )}
      {menu && project && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          alignRight
          onClose={() => setMenu(null)}
          items={[
            ...(workMode === "research" && !liteResearch
              ? [
                  {
                    label: "编辑研究流程",
                    disabled: !cfg,
                    title: cfg
                      ? "编辑步骤名称、简报、预期产物和脚本"
                      : "project.toml 尚未加载完成",
                    onSelect: () => onChromeAction("editor"),
                  },
                ]
              : []),
            {
              label: "项目设置…",
              title: "规则、验收记录和项目低频项",
              onSelect: () => onChromeAction("settings"),
            },
            ...(workMode === "research" && !liteResearch
              ? [
                  {
                    label: "历史",
                    title: "项目的白话保存时间线（只读）",
                    onSelect: () => onChromeAction("history"),
                  },
                ]
              : []),
            {
              label: "从 Mesa 移除",
              title:
                "只把项目从 Mesa 列表里摘掉，不动磁盘文件；清除痕迹与删除目录在左侧项目栏右键菜单里",
              onSelect: () => void removeRegistration(),
            },
          ]}
        />
      )}
    </header>
  );
}
