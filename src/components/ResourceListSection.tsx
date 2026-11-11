import { useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { LucideIcon } from "lucide-react";
import { FileText } from "lucide-react";
import {
  FoldMark,
  projectWellClass,
  rowActionClass,
  searchFieldClass,
} from "./PageFrame";
import { FileTypeGlyph } from "./FileTypeMark";
import { RESOURCE_TYPE_LABELS } from "../pipeline-presets";
import { officePreviewMode } from "../work-mode";
import { absoluteResourcePath } from "./ArtifactChecklist";
import { showProjectFile } from "../project-file-open";
import {
  displayFileTitle,
  ledgerFileDisplayName,
  LIST_PREVIEW_CAP,
  LIT_STATUS_FILTERS,
  litReadState,
  litRowMatches,
  paperIsAccumulated,
  type LitReadState,
} from "../lit-list";
import { buildFolderTree } from "../folder-groups";
import FolderGroupedList, { useFolderChrome } from "./FolderGroupedList";
import {
  noteLinkForPaper,
  paperIsIncluded,
  type IncludedEntryDto,
  type PaperNoteLink,
} from "../lit-watch";
import type { ProjectResourceDto } from "../types";

const statusPill =
  "inline-flex shrink-0 rounded-full px-1.5 py-px text-micro";
const actionBtn = `${rowActionClass} shrink-0 whitespace-nowrap`;

function isPdf(path: string): boolean {
  return /\.pdf$/i.test(path);
}

export default function ResourceListSection({
  projectPath,
  resources,
  heading = true,
  title = "文献",
  emptyLabel = "文献 · 还没有登记",
  icon: Icon = FileText,
  emptyActions,
  collapsible = false,
  defaultOpen = true,
  onImmerse,
  onAskAi,
  onMenu,
  showLitStatus = false,
  stripPrefix,
}: {
  projectPath: string;
  resources: ProjectResourceDto[];
  heading?: boolean;
  title?: string;
  emptyLabel?: string;
  icon?: LucideIcon;
  emptyActions?: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  onImmerse?: (r: ProjectResourceDto) => void;
  onAskAi?: (
    r: ProjectResourceDto,
    e?: { metaKey: boolean; ctrlKey: boolean },
  ) => void;
  onMenu?: (r: ProjectResourceDto, el: HTMLElement) => void;
  /** 文献行显示精读/已读，并提供打开对应笔记 */
  showLitStatus?: boolean;
  /** 分组时剥掉的默认目录（文献 papers、数据 data），避免整表套一层默认夹 */
  stripPrefix?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [noteLinks, setNoteLinks] = useState<PaperNoteLink[]>([]);
  const [included, setIncluded] = useState<IncludedEntryDto[]>([]);
  const [readingList, setReadingList] = useState<IncludedEntryDto[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | LitReadState>("all");
  const folders = useFolderChrome(
    `${stripPrefix ?? title}:${projectPath}`,
  );
  const empty = resources.length === 0;
  const showBody = !collapsible || empty || open;

  useEffect(() => {
    if (!showLitStatus) return;
    let cancelled = false;
    Promise.all([
      invoke<PaperNoteLink[]>("list_paper_notes", {
        projectRoot: projectPath,
      }).catch(() => [] as PaperNoteLink[]),
      invoke<IncludedEntryDto[]>("list_included_entries", {
        projectRoot: projectPath,
      }).catch(() => [] as IncludedEntryDto[]),
      invoke<IncludedEntryDto[]>("list_reading_list_entries", {
        projectRoot: projectPath,
      }).catch(() => [] as IncludedEntryDto[]),
    ]).then(([links, rows, readingRows]) => {
      if (cancelled) return;
      setNoteLinks(links);
      setIncluded(rows);
      setReadingList(readingRows);
    });
    return () => {
      cancelled = true;
    };
  }, [showLitStatus, projectPath, resources.length]);

  const rows = useMemo(() => {
    return resources
      .map((r) => {
        const note = showLitStatus
          ? noteLinkForPaper(r.path, noteLinks)
          : null;
        const includedHit =
          showLitStatus && isPdf(r.path) && paperIsIncluded(r.path, included);
        const accumulatedHit =
          showLitStatus &&
          isPdf(r.path) &&
          paperIsAccumulated(r.path, readingList);
        const state = showLitStatus
          ? litReadState(!!note, accumulatedHit, includedHit)
          : "unread";
        const title =
          ledgerFileDisplayName(r.path) ?? displayFileTitle(r.name);
        return { r, note, includedHit, accumulatedHit, state, title };
      })
      .filter((row) =>
        litRowMatches(
          row.title,
          row.r.path,
          row.state,
          query,
          showLitStatus ? statusFilter : "all",
        ),
      );
  }, [
    resources,
    noteLinks,
    included,
    readingList,
    query,
    statusFilter,
    showLitStatus,
  ]);

  const tree = useMemo(
    () => buildFolderTree(rows, (row) => row.r.path, stripPrefix),
    [rows, stripPrefix],
  );

  // 「查看」「笔记」开在项目页右侧文件栏（2026-11-11 用户拍板项目页文件统一从侧边打开）；清单顺序给栏头 ↑↓
  function openPreview(r: ProjectResourceDto) {
    const abs = absoluteResourcePath(projectPath, r.path);
    if (officePreviewMode(abs) === "external") {
      void invoke("open_in_system", { path: abs, root: projectPath });
      return;
    }
    const list = rows
      .map((row) => ({ path: absoluteResourcePath(projectPath, row.r.path), name: row.r.name }))
      .filter((f) => officePreviewMode(f.path) !== "external");
    void showProjectFile({
      projectRoot: projectPath,
      path: abs,
      name: r.name,
      list,
      from: title,
      askAi: onAskAi
        ? (p) => {
            const hit = rows.find((row) => absoluteResourcePath(projectPath, row.r.path) === p)?.r;
            if (hit) onAskAi(hit);
          }
        : undefined,
    });
  }

  return (
    <section>
      {heading && (
        <div className="mb-2.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="flex min-w-0 items-center gap-2 text-left"
            onClick={() => collapsible && !empty && setOpen((v) => !v)}
            aria-expanded={collapsible ? showBody : undefined}
          >
            {collapsible && !empty && <FoldMark open={open} boxed />}
            <Icon size={14} strokeWidth={1.8} className="text-l4" />
            <h2 className="text-xs font-medium text-l2">
              {title}
              {!empty ? `（${resources.length}）` : ""}
            </h2>
          </button>
          {showBody && !empty && (
            <>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索标题"
                className={`${searchFieldClass} ml-auto w-44`}
                aria-label={`搜索${title}`}
              />
              {showLitStatus && (
                <div
                  className="flex flex-wrap gap-1"
                  role="radiogroup"
                  aria-label="阅读状态"
                >
                  {LIT_STATUS_FILTERS.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      role="radio"
                      aria-checked={statusFilter === f.id}
                      className={`${rowActionClass} ${
                        statusFilter === f.id ? "border-cta-bd text-l1" : ""
                      }`}
                      onClick={() => setStatusFilter(f.id)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
      {empty ? (
        <div className="flex flex-wrap items-center gap-2 px-1 py-2">
          <p className="text-xs text-l4">{emptyLabel}</p>
          {emptyActions}
        </div>
      ) : showBody ? (
        <div className={heading ? projectWellClass : undefined}>
        {rows.length === 0 ? (
          <p className="px-1 py-2 text-xs text-l4">没有匹配</p>
        ) : (
        <FolderGroupedList
          tree={tree}
          searching={!!query.trim()}
          expanded={folders.expanded}
          onToggle={folders.toggle}
          cap={LIST_PREVIEW_CAP}
          revealed={folders.revealed}
          onReveal={folders.reveal}
          rowKey={(row) => row.r.path}
          renderRow={({ r, note, state, title }) => {
            const previewable =
              officePreviewMode(absoluteResourcePath(projectPath, r.path)) !==
              "external";
            const typeLabel =
              r.type && r.type !== "paper"
                ? (RESOURCE_TYPE_LABELS[r.type] ?? r.type)
                : null;
            return (
              <li
                className="group grid min-h-10 grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2.5 hover:bg-hover"
              >
                <span aria-hidden="true" className="flex w-8 shrink-0 justify-center">
                  <FileTypeGlyph path={r.path} />
                </span>
                <button
                  type="button"
                  className="min-w-0 truncate text-left text-sm text-l2"
                  onClick={() => openPreview(r)}
                  title={r.name}
                >
                  {title}
                </button>
                <span className="flex shrink-0 items-center justify-end gap-2">
                  <span className="flex gap-1">
                    {typeLabel && (
                      <span className={`${statusPill} bg-canvas text-l4`}>
                        {typeLabel}
                      </span>
                    )}
                    {showLitStatus && state === "read" && (
                      <span className={`${statusPill} bg-inset text-l3`}>
                        已读
                      </span>
                    )}
                    {showLitStatus && state === "queued" && (
                      <span
                        className={`${statusPill} border border-field bg-canvas text-l2`}
                      >
                        已在清单
                      </span>
                    )}
                    {showLitStatus && state === "accumulated" && (
                      <span className={`${statusPill} bg-canvas text-l4`}>
                        已积累
                      </span>
                    )}
                  </span>
                  <span className="flex gap-1">
                    {(onImmerse || onAskAi || onMenu) && (
                      <span className="hidden gap-1 group-hover:flex group-focus-within:flex">
                        {isPdf(r.path) && onImmerse && (
                          <button
                            type="button"
                            className={actionBtn}
                            onClick={() => onImmerse(r)}
                          >
                            ⛶ 沉浸阅读
                          </button>
                        )}
                        {onAskAi && (
                          <button
                            type="button"
                            className={actionBtn}
                            title="⌘ / Ctrl + 点可重选 Agent 和配置"
                            onClick={(e) => onAskAi(r, e)}
                          >
                            ◈ 问 AI
                          </button>
                        )}
                        {onMenu && (
                          <button
                            type="button"
                            className={actionBtn}
                            aria-label={`资源操作：${r.name}`}
                            onClick={(e) => onMenu(r, e.currentTarget)}
                          >
                            ⋯
                          </button>
                        )}
                      </span>
                    )}
                    {previewable && (
                      <button
                        type="button"
                        className={actionBtn}
                        onClick={() => openPreview(r)}
                      >
                        查看
                      </button>
                    )}
                    {note && (
                      <button
                        type="button"
                        className={actionBtn}
                        onClick={() =>
                          void showProjectFile({ projectRoot: projectPath, path: note.notePath, from: "精读笔记" })
                        }
                      >
                        笔记
                      </button>
                    )}
                  </span>
                </span>
              </li>
            );
          }}
        />
        )}
        </div>
      ) : null}
    </section>
  );
}
