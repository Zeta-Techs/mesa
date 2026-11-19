import { useEffect, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Check, ExternalLink, GripVertical, RotateCw } from "lucide-react";
import { FoldMark, iconActionClass } from "./PageFrame";
import FileTypeMark from "./FileTypeMark";
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

/** 常见科研流程产物的简短用途标签（4–8 字），帮用户扫一眼区分 10+ 个英文文件名 */
function artifactRoleHint(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower === "endnote.docx") return "EndNote 引文域版";
  if (lower === "zotero.docx") return "Zotero 引文域版";
  if (lower.endsWith("-final.pdf") || lower === "manuscript.pdf") return "排版定稿";
  if (lower.endsWith("-final.docx") || lower === "manuscript.docx") return "纯文本引文版";
  if (lower.endsWith("-final.md") || lower === "manuscript.md") return "定稿源文";
  if (lower === "declarations.md") return "作者与投稿声明";
  if (lower === "figure-permissions.md") return "配图版权核对";
  if (lower === "changelog.md") return "返修修改对照";
  if (lower === "review-report.md") return "定稿自查报告";
  if (lower === "citation-check.md") return "引文闭环核查";
  if (lower === "verification-decisions.md") return "核验人工裁决";
  if (lower === "evidence.json") return "核验台账";
  if (lower === "final-check.md") return "定稿前核查";
  if (lower === "endnote-cite-report.md") return "EndNote 域体检";
  if (lower === "zotero-cite-report.md") return "Zotero 域体检";
  if (lower === "screening.md") return "筛选记录";
  if (lower === "included.md" || lower === "included.json") return "纳入清单";
  if (lower === "to-fetch.md" || lower === "to-fetch.ris") return "待获取清单";
  if (lower === "references.bib") return "BibTeX 库";
  if (lower === "outline.md") return "大纲正文";
  return null;
}

function deliverableFormatBadge(name: string): { code: string; cls: string } {
  const lower = name.toLowerCase();
  if (lower === "endnote.docx") {
    return { code: "EN", cls: "bg-cta/12 text-cta" };
  }
  if (lower === "zotero.docx") {
    return { code: "ZOT", cls: "bg-ok text-ok-text" };
  }
  if (lower.endsWith(".pdf")) {
    return { code: "PDF", cls: "bg-err text-err-text" };
  }
  if (lower.endsWith(".docx")) {
    return { code: "DOCX", cls: "bg-cta-pill text-cta-pill-text" };
  }
  if (lower.endsWith(".pptx")) {
    return { code: "PPTX", cls: "bg-warn text-warn-text" };
  }
  return { code: "HTML", cls: "bg-inset text-l2" };
}

function isFinalDeliverableFile(name: string): boolean {
  return /\.(pdf|docx|pptx|html)$/i.test(name);
}

function isAuditArtifactFile(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === "citation-check.md" ||
    lower === "verification-decisions.md" ||
    lower === "evidence.json" ||
    lower === "review-report.md" ||
    lower === "final-check.md" ||
    lower.endsWith("-cite-report.md") ||
    lower.endsWith("-lint.jsonl")
  );
}

export interface ArtifactChecklistMeta {
  produced: number;
  total: number;
  loading: boolean;
}

/**
 * 步骤产物核验清单（RX2b → v3.45 起挂在任务行下）：挂载时拉取一次 + 手动刷新，不进轮询。
 * 步骤从 project.toml 按 workspaceName 反查；定位根由调用方按状态给定——已合并读项目根（main），其余读工作树。
 */
export default function ArtifactChecklist({
  projectPath,
  workspaceName,
  root,
  rootLabel,
  embedded = false,
  frameless = false,
  refreshNonce = 0,
  onMeta,
}: {
  /** 读 project.toml 找绑定步骤（注册项目路径） */
  projectPath: string;
  /** 绑定步骤 = steps[].workspaceName 匹配工作区名 */
  workspaceName: string;
  /** 产物定位根目录（工作树或项目根） */
  root: string;
  /** 根来源小字：「工作区」/「主文件夹（已保存进项目）」 */
  rootLabel: string;
  /** 嵌在工作区卡内时不重复套外层标题与同底色盒 */
  embedded?: boolean;
  /** 由外层工作区卡头统一承载标题、完成度胶囊与刷新按钮，彻底去双层套娃 */
  frameless?: boolean;
  /** 外层卡头触发刷新的递增序号 */
  refreshNonce?: number;
  /** 回传已产出数 / 总数 / 加载态给外层卡头 */
  onMeta?: (meta: ArtifactChecklistMeta) => void;
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
  const [auditOpen, setAuditOpen] = useState(false);

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
  }, [projectPath, workspaceName, root, refreshTick, refreshNonce]);

  const producedCount = rows ? rows.filter((r) => r.files.length > 0).length : 0;
  const totalCount = rows ? rows.length : 0;

  useEffect(() => {
    onMeta?.({ produced: producedCount, total: totalCount, loading });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [producedCount, totalCount, loading]);

  return (
    <div
      className={
        frameless
          ? "mt-2.5 border-t border-hairline/70 pt-2.5 text-xs"
          : embedded
            ? "mt-3 rounded-lg bg-canvas/45 px-3 py-2.5 text-xs"
            : "mt-2 rounded-lg ccode-well p-3 text-xs"
      }
    >
      {!frameless && (
        <div className="mb-2 flex items-center gap-2">
          <span className="font-medium text-l2">
            {embedded ? "本步产出" : `「${stepName ?? workspaceName}」本步文件`}
          </span>
          {rows && totalCount > 0 && (
            <span className="font-mono text-micro tabular-nums text-l4">
              {producedCount}/{totalCount}
            </span>
          )}
          <span
            className="min-w-0 truncate rounded-sm bg-inset/75 px-1.5 py-0.5 font-mono text-micro text-l4"
            title={root}
          >
            {rootLabel}
          </span>
          <button
            type="button"
            className={`${iconActionClass} ml-auto`}
            disabled={loading}
            title="刷新本步文件"
            aria-label="刷新本步文件"
            onClick={() => setRefreshTick((v) => v + 1)}
          >
            <RotateCw
              size={13.5}
              strokeWidth={1.8}
              className={loading ? "animate-spin" : undefined}
              aria-hidden="true"
            />
          </button>
        </div>
      )}
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
      ) : (() => {
        // 一律开在项目页右侧文件栏（2026-11-11 用户拍板）：不弹窗、不跳对话页；清单顺序给栏头 ↑↓
        const allFilesList = rows.flatMap((r) =>
          r.files.map((x) => ({ path: x.path, name: x.name })),
        );
        const openFile = (f: DirEntryDto) => {
          void showProjectFile({
            projectRoot: projectPath,
            root,
            path: f.path,
            name: f.name,
            list: allFilesList,
            from: `${stepName ?? workspaceName} · 本步文件`,
          });
        };
        const isActive = (f: DirEntryDto) =>
          !!activePath && samePath(activePath, f.path, IS_WINDOWS);
        const fileTitle = (f: DirEntryDto) => `在右侧打开 ${f.path}`;

        // 成稿交付物（单文件 .pdf / .docx / .pptx / .html）置顶卡片化；核验与引文检查在条目较多时归组折叠
        const deliverableRows = rows.filter(
          (r) => r.files.length === 1 && isFinalDeliverableFile(r.files[0].name),
        );
        const deliverableEntries = new Set(deliverableRows.map((r) => r.entry));
        const restProduced = rows.filter(
          (r) => r.files.length > 0 && !deliverableEntries.has(r.entry),
        );
        const auditCandidates = restProduced.filter(
          (r) => r.files.length === 1 && isAuditArtifactFile(r.files[0].name),
        );
        const shouldFoldAudit =
          producedCount >= 4 && auditCandidates.length >= 2;
        const auditRows = shouldFoldAudit ? auditCandidates : [];
        const auditEntries = new Set(auditRows.map((r) => r.entry));
        const mainRows = restProduced.filter((r) => !auditEntries.has(r.entry));
        const missingRows = rows.filter((r) => r.files.length === 0);

        const renderFileLine = (f: DirEntryDto, showCheck: boolean) => {
          const hint = artifactRoleHint(f.name);
          return (
            <button
              type="button"
              className={`group/file flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left text-xs transition-colors hover:bg-hover hover:text-l1 ${
                isActive(f) ? "bg-hover font-medium text-l1" : "text-l2"
              }`}
              aria-current={isActive(f) || undefined}
              title={fileTitle(f)}
              onClick={() => openFile(f)}
            >
              {showCheck ? (
                <Check size={12} strokeWidth={2.2} className="shrink-0 text-done" aria-hidden="true" />
              ) : (
                <FileTypeMark path={f.name} />
              )}
              <span className="min-w-0 truncate font-mono">{f.name}</span>
              {hint && (
                <span className="shrink-0 rounded-sm bg-inset/75 px-1.5 py-0.5 text-micro text-l3">
                  {hint}
                </span>
              )}
              <span aria-hidden="true" className="min-w-0 flex-1" />
              <span className="flex shrink-0 items-center gap-0.5 md:hidden md:group-hover/file:flex group-focus-within/file:flex">
                <OpenExternalHandle path={f.path} root={root} onError={setOpenError} />
                <DragOutHandle path={f.path} />
              </span>
              <span className="flex shrink-0 items-center gap-2 font-mono text-micro tabular-nums text-l4">
                <span
                  className="md:group-hover/file:hidden group-focus-within/file:hidden"
                  title={absTime(f.modified)}
                >
                  {relTime(f.modified)}
                </span>
                <span>{formatSize(f.size)}</span>
              </span>
            </button>
          );
        };

        const renderStandardRow = (row: ArtifactRow) => {
          const single = row.files.length === 1 ? row.files[0] : null;
          return (
            <li key={row.entry}>
              {single ? (
                renderFileLine(single, true)
              ) : (
                <>
                  <div className="flex h-7 items-center gap-2 rounded-md px-1.5 text-xs">
                    <Check size={12} strokeWidth={2.2} className="shrink-0 text-done" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate font-mono text-l2">
                      {row.entry}
                    </span>
                    <span className="shrink-0 text-micro text-l4">
                      {row.files.length} 个文件
                    </span>
                  </div>
                  <ul className="space-y-0.5 pl-5">
                    {row.files.map((f) => (
                      <li key={f.path}>{renderFileLine(f, false)}</li>
                    ))}
                  </ul>
                </>
              )}
            </li>
          );
        };

        return (
          <div className="space-y-2.5">
            {deliverableRows.length > 0 && (
              <div>
                <div className="mb-1.5 px-1 text-micro font-medium text-l4">
                  {deliverableRows.length >= 2
                    ? "成稿交付 · 可直接外发或拖进引文库"
                    : "成稿交付"}
                </div>
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {deliverableRows.map((row) => {
                    const f = row.files[0];
                    const hint = artifactRoleHint(f.name);
                    const badge = deliverableFormatBadge(f.name);
                    return (
                      <button
                        key={row.entry}
                        type="button"
                        onClick={() => openFile(f)}
                        aria-current={isActive(f) || undefined}
                        title={fileTitle(f)}
                        className={`group/file flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                          embedded && !frameless ? "ccode-well" : "bg-canvas/55"
                        } ${
                          isActive(f)
                            ? "ring-1 ring-cta-bd text-l1"
                            : "text-l1 hover:bg-hover"
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className={`flex size-7 shrink-0 items-center justify-center rounded-md font-mono text-micro font-semibold tracking-tight ${badge.cls}`}
                        >
                          {badge.code}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate font-mono text-xs font-medium text-l1">
                              {f.name}
                            </span>
                          </div>
                          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-micro text-l3">
                            {hint && <span>{hint}</span>}
                            {hint && <span className="text-l4">·</span>}
                            <span className="font-mono tabular-nums text-l4">
                              {formatSize(f.size)}
                            </span>
                            <span className="text-l4">·</span>
                            <span
                              className="font-mono tabular-nums text-l4"
                              title={absTime(f.modified)}
                            >
                              {relTime(f.modified)}
                            </span>
                          </div>
                        </div>
                        <span className="flex shrink-0 items-center gap-0.5">
                          <OpenExternalHandle path={f.path} root={root} onError={setOpenError} />
                          <DragOutHandle path={f.path} />
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {mainRows.length > 0 && (
              <div>
                {(deliverableRows.length > 0 || auditRows.length > 0) && (
                  <div className="mb-1 px-1 text-micro font-medium text-l4">
                    {deliverableRows.length > 0 ? "源稿与投稿材料" : "核心清单与产物"}
                  </div>
                )}
                <ul
                  className={
                    frameless || deliverableRows.length > 0
                      ? "space-y-0.5 rounded-lg bg-canvas/40 p-1"
                      : "space-y-0.5"
                  }
                >
                  {mainRows.map(renderStandardRow)}
                </ul>
              </div>
            )}
            {auditRows.length > 0 && (
              <div>
                <button
                  type="button"
                  aria-expanded={auditOpen}
                  onClick={() => setAuditOpen((v) => !v)}
                  className="flex h-7 w-full items-center gap-1.5 rounded-lg bg-canvas/35 px-2.5 text-xs text-l3 transition-colors hover:bg-hover hover:text-l1"
                >
                  <FoldMark open={auditOpen} />
                  <span>
                    核验与引文检查报告（{auditRows.length} 份均已产出 · {auditOpen ? "点击收起" : "点击展开"}）
                  </span>
                  <span aria-hidden="true" className="ml-auto text-micro text-ok-text">
                    ✓
                  </span>
                </button>
                {auditOpen && (
                  <ul className="mt-1 space-y-0.5 rounded-lg bg-canvas/40 p-1 pl-2">
                    {auditRows.map(renderStandardRow)}
                  </ul>
                )}
              </div>
            )}
            {missingRows.length > 0 && (
              <ul className="space-y-0.5">
                {missingRows.map((row) => (
                  <li key={row.entry}>
                    <div className="flex h-7 items-center gap-2 rounded-md px-1.5 text-xs">
                      <span className="shrink-0 text-l4">—</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-l4">
                        {row.entry}
                      </span>
                      <span className="shrink-0 text-micro text-l4">尚未产出</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {openError && (
              <p className="mt-1 px-1 text-micro text-err-text">{openError}</p>
            )}
          </div>
        );
      })()}
    </div>
  );
}
