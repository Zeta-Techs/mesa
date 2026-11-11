import { useEffect, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { ExternalLink, GripVertical } from "lucide-react";
import { rowActionClass } from "./PageFrame";
import type { DirEntryDto } from "./FileTree";
import { absTime, relTime } from "../rel-time";
import { useAppStore } from "../store";
import type { ProjectConfigReadDto } from "../types";
import { samePath } from "../path-utils";
import { showProjectFile } from "../project-file-open";
import { IS_MAC, IS_WINDOWS } from "../hotkeys";

/** 拖出会话的悬浮图标（48×48 文档形 PNG，生成脚本见 git 历史；只是拖拽时的视觉反馈，不要求精美） */
const DRAG_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAi0lEQVR4nO3WPQqAMBBE4Rw7pcdL43GCpWIhiPizxGJ24C28fr5uS+GSXq3TmqVhQO+LvNZmX8A+3hZwjLcEnMfbAa7jrQB3420AT+MtAG/j0wO+xqcGRManBUTHpwVEs/+FAKgDoA6AOgDqAKgDoA6AOgDqAKgDoA6AOgDqAKgDoO4XIEtDAI6L3QY0A9vXVQwJnAAAAABJRU5ErkJggg==";

/** 产物文件 OS 级拖出（v3.97）：WebView 的 HTML5 拖拽出不了窗口，必须经 tauri-plugin-drag
 *  开系统拖拽会话——才能把 to-fetch.ris / PDF 直接拖进 Zotero 等外部应用。
 *  必须在 mousedown 里同步发起（macOS 要求拖拽会话挂在鼠标按下事件上），
 *  所以拖出手柄独占一个小图标，不与「点击预览」抢手势。失败静默：拖拽没起来就当没拖 */
function startOsFileDrag(path: string) {
  const onEvent = new Channel<unknown>();
  void invoke("plugin:drag|start_drag", {
    item: [path],
    image: DRAG_ICON_DATA_URL,
    onEvent,
  }).catch(() => {});
}

/** 行内「外部打开」：交给系统默认应用（PDF 阅读器、Word、图片查看器……）。阻止冒泡，不触发行点击预览。
 *  走 open_in_system：路径必须在这一步的根目录内，类型限文档 / 表格 / 图片 / 文本（2026-10-24 用户：本步文件加外部打开） */
function OpenExternalHandle({ path, root, onError }: { path: string; root: string; onError: (msg: string) => void }) {
  return (
    <span
      role="button"
      aria-label="用系统应用打开"
      title="用系统默认应用打开（PDF 阅读器、Word 等）"
      className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-l4 hover:bg-hover hover:text-l2"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void invoke("open_in_system", { path, root }).catch((reason) => onError(String(reason)));
      }}
    >
      <ExternalLink size={13} strokeWidth={1.8} aria-hidden="true" />
    </span>
  );
}

/** 行内拖出手柄：mousedown 即起系统拖拽；阻止冒泡避免触发行点击预览 */
function DragOutHandle({ path }: { path: string }) {
  return (
    <span
      role="button"
      aria-label="拖出到其他应用"
      title={`按住拖进其他应用（如 Zotero、${IS_MAC ? "Finder" : IS_WINDOWS ? "资源管理器" : "文件管理器"}）`}
      className="flex size-5 shrink-0 cursor-grab select-none items-center justify-center rounded-sm text-l4 hover:bg-hover hover:text-l2"
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        startOsFileDrag(path);
      }}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <GripVertical size={13} strokeWidth={1.8} aria-hidden="true" />
    </span>
  );
}

function wildcardMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`).test(value);
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** 资源/产物登记的路径多为相对根目录；拼成绝对路径，绝对路径原样返回 */
export function absoluteResourcePath(root: string, resourcePath: string): string {
  if (resourcePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(resourcePath)) {
    return resourcePath;
  }
  return `${root.replace(/[\\/]+$/, "")}/${resourcePath}`;
}

/** 产物核验清单的一行：一个预期产物条目的定位结果 */
interface ArtifactRow {
  /** 预期产物条目原文（相对根的路径） */
  entry: string;
  files: DirEntryDto[];
}

/** 预期产物条目逐个在 root 下定位——文件单列自身；
 *  目录列一层文件（只列文件不递归）；找不到返回空 files（UI 显示「尚未产出」）。
 *  list_dir 无根目录约束（只读列举），直接传绝对路径；仅在面板打开/手动刷新时调用，不进轮询。
 *  评审覆盖层的「产物 X/Y 已产出」摘要也复用本函数（同一数据机制，不另造请求）。 */
export async function loadArtifactRows(
  entries: string[],
  root: string,
): Promise<ArtifactRow[]> {
  return Promise.all(
    entries.map(async (raw) => {
      const entry = raw.replace(/[\\/]+$/, "");
      const abs = absoluteResourcePath(root, entry);
      // 通配条目：只允许最后一段带 *，列出父目录中的命中文件。
      if (entry.includes("*")) {
        const idx = Math.max(abs.lastIndexOf("/"), abs.lastIndexOf("\\"));
        if (idx > 0 && !abs.slice(0, idx).includes("*")) {
          try {
            const siblings = await invoke<DirEntryDto[]>("list_dir", {
              path: abs.slice(0, idx),
              showHidden: false,
            });
            const pattern = abs.slice(idx + 1);
            return {
              entry,
              files: siblings.filter(
                (s) => !s.isDir && wildcardMatch(pattern, s.name),
              ),
            };
          } catch {
            return { entry, files: [] };
          }
        }
      }
      // 目录条目：list_dir 成功即列一层文件
      try {
        const children = await invoke<DirEntryDto[]>("list_dir", {
          path: abs,
          showHidden: false,
        });
        return { entry, files: children.filter((c) => !c.isDir) };
      } catch {
        /* 非目录或不存在，走父目录匹配 */
      }
      // 文件条目：列父目录按名称匹配，区分「文件存在」与「尚未产出」
      const idx = Math.max(abs.lastIndexOf("/"), abs.lastIndexOf("\\"));
      if (idx > 0) {
        try {
          const siblings = await invoke<DirEntryDto[]>("list_dir", {
            path: abs.slice(0, idx),
            showHidden: false,
          });
          const hit = siblings.find((s) => s.name === abs.slice(idx + 1));
          if (hit && !hit.isDir) return { entry, files: [hit] };
        } catch {
          /* 父目录也不存在 */
        }
      }
      return { entry, files: [] };
    }),
  );
}

/**
 * 步骤产物核验清单（RX2b → v3.45 起挂在任务行下）：挂载时拉取一次 + 手动 ⟳ 刷新，不进轮询。
 * 步骤从 project.toml 按 workspaceName 反查；定位根由调用方按状态给定——已合并读项目根（main），其余读工作树。
 */
export default function ArtifactChecklist({
  projectPath,
  workspaceName,
  root,
  rootLabel,
}: {
  /** 读 project.toml 找绑定步骤（注册项目路径） */
  projectPath: string;
  /** 绑定步骤 = steps[].workspaceName 匹配工作区名 */
  workspaceName: string;
  /** 产物定位根目录（工作树或项目根） */
  root: string;
  /** 根来源小字：「工作区」/「主文件夹（已保存进项目）」 */
  rootLabel: string;
}) {
  // 正在文件栏里看的那个：清单里同一行标浅底（2026-11-11 文件统一开在项目页右侧文件栏）
  const activePath = useAppStore((s) => s.projectFilePane?.path ?? null);
  const [rows, setRows] = useState<ArtifactRow[] | null>(null);
  const [stepName, setStepName] = useState<string | null>(null);
  // 步骤反查失败（未注册项目/未绑定步骤/读取失败）时给明确提示而非空清单
  const [stepFound, setStepFound] = useState(true);
  const [loading, setLoading] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    void (async () => {
      try {
        const read = await invoke<ProjectConfigReadDto>("read_project_config", {
          path: projectPath,
        });
        const step = read.config.steps.find(
          (s) => s.workspaceName === workspaceName,
        );
        if (!step) {
          if (!stale) {
            setStepFound(false);
            setStepName(null);
            setRows([]);
          }
          return;
        }
        const loaded = await loadArtifactRows(step.expectedArtifacts, root);
        if (!stale) {
          setStepFound(true);
          setStepName(step.name);
          setRows(loaded);
        }
      } catch {
        if (!stale) {
          setStepFound(false);
          setRows([]);
        }
      } finally {
        if (!stale) setLoading(false);
      }
    })();
    return () => {
      stale = true;
    };
  }, [projectPath, workspaceName, root, refreshTick]);

  return (
    <div className="mt-2 rounded-md ccode-well p-2">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs text-l2">
          「{stepName ?? workspaceName}」本步文件
        </span>
        <span
          className="min-w-0 truncate font-mono text-micro text-l4"
          title={root}
        >
          {rootLabel}
        </span>
        <button
          type="button"
          className={`${rowActionClass} ml-auto shrink-0`}
          disabled={loading}
          onClick={() => setRefreshTick((v) => v + 1)}
        >
          ⟳ 刷新
        </button>
      </div>
      {loading || !rows ? (
        <p className="text-xs text-l4">读取中…</p>
      ) : !stepFound ? (
        <p className="text-xs text-l4">
          未找到绑定该任务的研究步骤，暂无预期产物可核验。
        </p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-l4">
          该步骤未登记预期产物，可在「编辑研究流程」中补充。
        </p>
      ) : (
        <>
        <ul className="space-y-0.5">
          {rows.map((row) => {
            const produced = row.files.length > 0;
            // 单文件产物：行本身可点击预览；目录产物：行只表状态，文件逐个列在下方
            const single = row.files.length === 1 ? row.files[0] : null;
            // 一律开在项目页右侧文件栏（2026-11-11 用户拍板）：不弹窗、不跳对话页；清单顺序给栏头 ↑↓
            const openFile = (f: DirEntryDto) => {
              void showProjectFile({
                projectRoot: projectPath,
                root,
                path: f.path,
                name: f.name,
                list: (rows ?? []).flatMap((r) => r.files.map((x) => ({ path: x.path, name: x.name }))),
                from: `${stepName ?? workspaceName} · 本步文件`,
              });
            };
            const isActive = (f: DirEntryDto) =>
              !!activePath && samePath(activePath, f.path, IS_WINDOWS);
            const fileMeta = (f: DirEntryDto) => (
              <>
                <span
                  className="shrink-0 text-micro text-l4"
                  title={absTime(f.modified)}
                >
                  {relTime(f.modified)}
                </span>
                <span className="shrink-0 text-micro text-l4">
                  {formatSize(f.size)}
                </span>
              </>
            );
            const fileTitle = (f: DirEntryDto) => `在右侧打开 ${f.path}`;
            return (
              <li key={row.entry}>
                {!produced ? (
                  <div className="flex h-7 items-center gap-2 rounded-sm px-1 text-xs">
                    <span className="shrink-0 text-l4">—</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-l4">
                      {row.entry}
                    </span>
                    <span className="shrink-0 text-l4">尚未产出</span>
                  </div>
                ) : single ? (
                  <button
                    type="button"
                    className={`flex h-7 w-full items-center gap-2 rounded-sm px-1 text-left text-xs hover:bg-hover hover:text-l1 ${isActive(single) ? "bg-hover text-l1" : "text-l2"}`}
                    aria-current={isActive(single) || undefined}
                    title={fileTitle(single)}
                    onClick={() => openFile(single)}
                  >
                    <span className="shrink-0 text-done">✓</span>
                    <span className="min-w-0 flex-1 truncate font-mono">
                      {single.name}
                    </span>
                    <OpenExternalHandle path={single.path} root={root} onError={setOpenError} />
                    <DragOutHandle path={single.path} />
                    {fileMeta(single)}
                  </button>
                ) : (
                  <>
                    <div className="flex h-7 items-center gap-2 rounded-sm px-1 text-xs">
                      <span className="shrink-0 text-done">✓</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-l2">
                        {row.entry}
                      </span>
                      <span className="shrink-0 text-micro text-l4">
                        {row.files.length} 个文件
                      </span>
                    </div>
                    <ul className="pl-5">
                      {row.files.map((f) => (
                        <li key={f.path}>
                          <button
                            type="button"
                            className={`flex h-7 w-full items-center gap-2 rounded-sm px-1 text-left text-xs hover:bg-hover hover:text-l1 ${isActive(f) ? "bg-hover text-l1" : "text-l2"}`}
                            aria-current={isActive(f) || undefined}
                            title={fileTitle(f)}
                            onClick={() => openFile(f)}
                          >
                            <span className="min-w-0 flex-1 truncate font-mono">
                              {f.name}
                            </span>
                            <OpenExternalHandle path={f.path} root={root} onError={setOpenError} />
                            <DragOutHandle path={f.path} />
                            {fileMeta(f)}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </li>
            );
          })}
        </ul>
        {openError && <p className="mt-1 px-1 text-micro text-err-text">{openError}</p>}
        </>
      )}
    </div>
  );
}
