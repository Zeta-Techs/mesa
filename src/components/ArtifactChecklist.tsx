import { previewSaveCompletion, type FilePreviewSnapshot } from "../file-preview";
import { sanitizeDocumentHtml } from "../document-html";
import { useEffect, useMemo, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { marked } from "marked";
import { renderMathInto } from "../md-math";
import {
  primaryActionClass,
  rowActionClass,
  secondaryActionClass,
} from "./PageFrame";
import { Modal } from "./Modal";
import { confirmDialog } from "./ConfirmDialog";
import type { DirEntryDto } from "./FileTree";
import { absTime, relTime } from "../rel-time";
import { useAppStore } from "../store";
import type { ProjectConfigReadDto } from "../types";
import { artifactPreviewSurface } from "../project-files";
import ProjectFilePreview from "./ProjectFilePreview";

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

/** 行内拖出手柄：mousedown 即起系统拖拽；阻止冒泡避免触发行点击预览 */
function DragOutHandle({ path }: { path: string }) {
  return (
    <span
      role="button"
      aria-label="拖出到其他应用"
      title="按住拖进其他应用（如 Zotero、Finder）"
      className="shrink-0 cursor-grab select-none px-0.5 text-micro text-l4 hover:text-l2"
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
      ⠿
    </span>
  );
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
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
  const setPreviewReq = useAppStore((s) => s.setPreviewReq);
  const setReaderReq = useAppStore((s) => s.setReaderReq);
  const setPage = useAppStore((s) => s.setPage);
  const [rows, setRows] = useState<ArtifactRow[] | null>(null);
  const [stepName, setStepName] = useState<string | null>(null);
  // 步骤反查失败（未注册项目/未绑定步骤/读取失败）时给明确提示而非空清单
  const [stepFound, setStepFound] = useState(true);
  const [loading, setLoading] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  // 文本类产物就地预览（v3.97）：不再跳终端页。弹层形式与 TASK.md 预览/编辑同款——
  // 标题栏 + 预览/编辑切换 + 底部「在终端页打开 / 取消 / 保存」；读盘走 read_file_preview
  // （根白名单 + 256KB 上限，截断则只读），保存走 save_file_preview 原子写
  const [inlinePreview, setInlinePreview] = useState<{
    path: string;
    name: string;
    /** 打开时读到的原文，判断未保存改动用 */
    origin: string;
    text: string;
    edit: boolean;
    truncated: boolean;
    revision: string | null;
    readOnlyReason: string | null;
    saving: boolean;
    error: string | null;
  } | null>(null);
  const [mediaPreview, setMediaPreview] = useState<{
    path: string;
    name: string;
  } | null>(null);

  async function openInlinePreview(f: DirEntryDto) {
    setInlinePreview({
      path: f.path,
      name: f.name,
      origin: "",
      text: "",
      edit: false,
      truncated: false,
      revision: null,
      readOnlyReason: null,
      saving: false,
      error: null,
    });
    try {
      const r = await invoke<FilePreviewSnapshot>(
        "read_file_preview",
        { path: f.path, root },
      );
      setInlinePreview((s) =>
        s && s.path === f.path
          ? { ...s, ...r, origin: r.text }
          : s,
      );
    } catch (reason) {
      setInlinePreview((s) =>
        s && s.path === f.path ? { ...s, error: String(reason) } : s,
      );
    }
  }

  async function saveInlinePreview() {
    if (!inlinePreview || inlinePreview.saving || !inlinePreview.revision) return;
    setInlinePreview({ ...inlinePreview, saving: true, error: null });
    try {
      const revision = await invoke<string>("save_file_preview", {
        path: inlinePreview.path,
        root,
        text: inlinePreview.text,
        expectedRevision: inlinePreview.revision,
      });
      setInlinePreview((current) => {
        if (!current || current.path !== inlinePreview.path) return current;
        const saved = previewSaveCompletion(inlinePreview.text, current.text, revision);
        return saved.dirty
          ? { ...current, origin: saved.snapshot.text, revision, saving: false }
          : null;
      });
      setRefreshTick((v) => v + 1);
    } catch (reason) {
      setInlinePreview((s) =>
        s && s.path === inlinePreview.path ? { ...s, saving: false, error: String(reason) } : s,
      );
    }
  }

  /** 关闭前守一道：有未保存改动时确认（与 TASK.md 弹层同口径） */
  async function closeInlinePreview() {
    if (!inlinePreview || inlinePreview.saving) return;
    if (
      inlinePreview.text !== inlinePreview.origin &&
      !(await confirmDialog("有未保存的改动，确定放弃？", {
        danger: true,
        confirmText: "放弃",
      }))
    ) {
      return;
    }
    setInlinePreview(null);
  }

  /** md 笔记「⛶ 沉浸阅读」：reader_for_note 一次给齐归属项目根 + 配对 PDF + 实际笔记路径
      （工作区里的笔记自动映射回主仓副本；未合并/无配对/未登记等失败原因就地在弹层报错） */
  const [immersiveBusy, setImmersiveBusy] = useState(false);
  async function openImmersive() {
    if (!inlinePreview || immersiveBusy) return;
    setImmersiveBusy(true);
    try {
      const r = await invoke<{
        projectRoot: string;
        pdfPath: string;
        notePath: string;
      }>("reader_for_note", { notePath: inlinePreview.path });
      setReaderReq({
        pdfPath: r.pdfPath,
        projectRoot: r.projectRoot,
        notePath: r.notePath,
      });
      setPage("terminal");
      setInlinePreview(null);
    } catch (reason) {
      setInlinePreview((s) => (s ? { ...s, error: String(reason) } : s));
    } finally {
      setImmersiveBusy(false);
    }
  }

  // Esc 关闭预览弹层（有改动时同样先确认）
  useEffect(() => {
    if (!inlinePreview) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        void closeInlinePreview();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inlinePreview?.text, inlinePreview?.origin]);

  const isMd = inlinePreview
    ? ["md", "markdown"].includes(extOf(inlinePreview.name))
    : false;
  const previewHtml = useMemo(
    () =>
      inlinePreview && isMd
        ? sanitizeDocumentHtml(
            marked.parse(inlinePreview.text, {
              gfm: true,
              breaks: false,
              async: false,
            }) as string,
          )
        : "",
    [inlinePreview, isMd],
  );
  // 产物内联预览的公式升级（与文件预览阅读版式同一口径；无公式不加载 katex）
  const previewHtmlRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (previewHtmlRef.current) void renderMathInto(previewHtmlRef.current);
  }, [previewHtml]);

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
            // 文本类就地预览（TASK.md 同款弹层）；pdf/docx/表格/图同页弹层；其余才跳运行页
            const openFile = (f: DirEntryDto) => {
              const surface = artifactPreviewSurface(f.path);
              if (surface === "text") {
                void openInlinePreview(f);
                return;
              }
              if (surface === "media") {
                setMediaPreview({ path: f.path, name: f.name });
                return;
              }
              setPreviewReq({ path: f.path, name: f.name, root });
              setPage("terminal");
            };
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
            const fileTitle = (f: DirEntryDto) =>
              artifactPreviewSurface(f.path) === "jump"
                ? `在运行页预览 ${f.path}`
                : `预览 ${f.path}`;
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
                    className="flex h-7 w-full items-center gap-2 rounded-sm px-1 text-left text-xs text-l2 hover:bg-hover hover:text-l1"
                    title={fileTitle(single)}
                    onClick={() => openFile(single)}
                  >
                    <span className="shrink-0 text-done">✓</span>
                    <span className="min-w-0 flex-1 truncate font-mono">
                      {single.name}
                    </span>
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
                            className="flex h-7 w-full items-center gap-2 rounded-sm px-1 text-left text-xs text-l2 hover:bg-hover hover:text-l1"
                            title={fileTitle(f)}
                            onClick={() => openFile(f)}
                          >
                            <span className="min-w-0 flex-1 truncate font-mono">
                              {f.name}
                            </span>
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
        </>
      )}
      {/* 文本类产物就地预览弹层（v3.97）：与 TASK.md 预览/编辑同款——标题栏 +
          预览/编辑切换 + 底部「在终端页打开 / 取消 / 保存」。背景点击/Esc 关闭，
          有未保存改动先确认。截断文件（>256KB）只读，不给编辑 */}
      {inlinePreview && (
        <Modal
          open
          title={inlinePreview.name}
          onClose={() => void closeInlinePreview()}
          size="lg"
          panelClassName="z-50 h-[70vh]"
          contentClassName="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="mb-3 flex shrink-0 items-baseline gap-2">
              <h2 className="min-w-0 truncate text-base font-semibold text-l1">
                {inlinePreview.name}
              </h2>
              <span
                className="min-w-0 truncate font-mono text-micro text-l4"
                title={inlinePreview.path}
              >
                {inlinePreview.path}
              </span>
              {inlinePreview.revision && (
                <button
                  type="button"
                  onClick={() =>
                    setInlinePreview((s) => (s ? { ...s, edit: !s.edit } : s))
                  }
                  title={inlinePreview.edit ? "看渲染后的排版" : "编辑原文"}
                  className="ml-auto shrink-0 self-center rounded-sm border border-field px-1.5 py-0.5 text-xs text-l3 hover:bg-hover hover:text-l1"
                >
                  {inlinePreview.edit ? "预览" : "编辑"}
                </button>
              )}
            </div>
            {inlinePreview.edit ? (
              <textarea
                value={inlinePreview.text}
                onChange={(e) =>
                  setInlinePreview((s) =>
                    s ? { ...s, text: e.target.value } : s,
                  )
                }
                spellCheck={false}
                className="min-h-0 flex-1 resize-none rounded-md border border-field bg-canvas p-3 font-mono text-xs leading-5 text-l2 outline-none focus:border-cta-bd"
              />
            ) : isMd ? (
              <div className="min-h-0 flex-1 overflow-auto rounded-md border border-field bg-canvas">
                <div
                  ref={previewHtmlRef}
                  className="md-body px-4 py-3"
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                />
              </div>
            ) : (
              <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-md border border-field bg-canvas p-3 font-mono text-xs leading-5 text-l2">
                {inlinePreview.text}
              </pre>
            )}
            <p className="mt-2 shrink-0 text-micro text-l4">
              {inlinePreview.readOnlyReason
                ? inlinePreview.readOnlyReason
                : "改动保存后直接写回该文件。"}
            </p>
            <div className="mt-3 flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setPreviewReq({
                    path: inlinePreview.path,
                    name: inlinePreview.name,
                    root,
                  });
                  setPage("terminal");
                }}
                title="改用终端页打开（要看改动对比或用编辑器时）"
                className="rounded-sm px-2 py-1.5 text-micro text-l4 hover:bg-hover hover:text-l2"
              >
                在终端页打开
              </button>
              {isMd && (
                <button
                  type="button"
                  onClick={() => void openImmersive()}
                  disabled={immersiveBusy}
                  title="找到这篇笔记对应的 PDF，进沉浸阅读区（笔记｜PDF｜Agent 三栏，笔记可直接编辑）"
                  className="rounded-sm px-2 py-1.5 text-micro text-l4 hover:bg-hover hover:text-l2 disabled:opacity-50"
                >
                  {immersiveBusy ? "查找 PDF…" : "⛶ 沉浸阅读"}
                </button>
              )}
              {inlinePreview.error && (
                <span className="min-w-0 flex-1 truncate text-micro text-err-text">
                  {inlinePreview.error}
                </span>
              )}
              <div className="ml-auto flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => void closeInlinePreview()}
                  className={secondaryActionClass}
                >
                  取消
                </button>
                {inlinePreview.revision && (
                  <button
                    type="button"
                    disabled={
                      inlinePreview.saving ||
                      inlinePreview.text === inlinePreview.origin
                    }
                    onClick={() => void saveInlinePreview()}
                    title={
                      inlinePreview.text === inlinePreview.origin
                        ? "没有改动"
                        : "保存改动"
                    }
                    className={primaryActionClass}
                  >
                    {inlinePreview.saving ? "保存中…" : "保存"}
                  </button>
                )}
              </div>
            </div>
          </div>
        </Modal>
      )}
      {mediaPreview && (
        <Modal
          open
          title={mediaPreview.name}
          onClose={() => setMediaPreview(null)}
          size="xl"
          overflow="hidden"
          panelClassName="z-50 h-[80vh]"
          contentClassName="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="mb-2 flex shrink-0 items-baseline gap-2">
              <h2 className="min-w-0 truncate text-base font-semibold text-l1">
                {mediaPreview.name}
              </h2>
              <span
                className="min-w-0 truncate font-mono text-micro text-l4"
                title={mediaPreview.path}
              >
                {mediaPreview.path}
              </span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-field">
              <ProjectFilePreview
                path={mediaPreview.path}
                root={root}
              />
            </div>
            <div className="mt-3 flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setPreviewReq({
                    path: mediaPreview.path,
                    name: mediaPreview.name,
                    root,
                  });
                  setPage("terminal");
                  setMediaPreview(null);
                }}
                title="改用运行页打开"
                className="rounded-sm px-2 py-1.5 text-micro text-l4 hover:bg-hover hover:text-l2"
              >
                在运行页打开
              </button>
              <button
                type="button"
                onClick={() => setMediaPreview(null)}
                className="ml-auto rounded-sm px-3 py-1.5 text-sm text-l2 hover:bg-hover"
              >
                关闭
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
