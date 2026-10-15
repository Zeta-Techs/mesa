import ResearchEvidencePanel from "./ResearchEvidencePanel";
import ResearchReproductionPanel from "./ResearchReproductionPanel";
import ResearchAcceptancePanel from "./ResearchAcceptancePanel";
import ScreeningReviewPanel from "./ScreeningReviewPanel";
import { researchReportPatterns, reproductionEntrypoints } from "../research-report";
import {
  blockerPrimaryText,
  groupReviewFiles,
  isScreeningReviewFile,
  sortReviewPaths,
} from "../screening-review";
import {
  deliveryContentPaths,
  deliveryProcessPaths,
  groupDeliveryFiles,
  isManuscriptScaffold,
  preferredDeliveryPath,
  sortDeliveryPaths,
} from "../review-file-groups";
import { resolveStepReviewProfile, reviewPaneTabs, type ReviewPane } from "../step-review";
import {
  appendReviewAnnotation,
  scanWritingReview,
  writingReturnPrompt,
  writingScanSourcePath,
  type WritingReviewHit,
} from "../draft-review";
import { buildWorkspaceTerminalRequest } from "../pipeline-start";
import ProjectFilePreview from "./ProjectFilePreview";
import { REVIEW_SAVE, reviewSavePrimaryLabel } from "../review-save-copy";
import WatchRunReview from "./WatchRunReview";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  File,
  FolderClosed,
  FolderOpen,
  GitBranch,
  RefreshCw,
  Search,
} from "lucide-react";
import ContextMenu from "./ContextMenu";
import { confirmDialog } from "./ConfirmDialog";
import ImagePairView, { isImagePath } from "./ImagePairView";
import { loadArtifactRows } from "./ArtifactChecklist";
import { Checkbox, LoadingRows, secondaryActionClass } from "./PageFrame";
import {
  freezeReviewedSha,
  reviewedShaAfterCommit,
  gitAdmissionPayload,
  mergeAdmissionText,
  deliveryFollowupText,
} from "../acceptance-log";
import { defaultCommitMessage } from "../git-commit-message";
import { userDirtyFiles } from "../git-status-groups";
import {
  absUnderRoot,
  blockerList,
  blockerText,
  buildChangeTree,
  fileDiffCacheKey,
  foldContextRows,
  parseDiff,
  reviewFileChip,
  type ChangeTreeNode,
  type DiffLine,
} from "../diff-view";
import { useAppStore } from "../store";
import type {
  CitationHealthDto,
  GitCommitResultDto,
  GitFileDto,
  HumanTaskStateDto,
  ProjectConfigDto,
  ProjectConfigReadDto,
  ProjectStepDto,
  RunArtifactDto,
  RunDto,
  WorkspaceDiffDto,
  WorkspaceDeliverableReviewDto,
  WorkspaceDto,
  WorkspaceHealthDto,
  WorkspaceMergeResultDto,
  WorkspacePrResultDto,
} from "../types";

const OfficePreviewModal = lazy(() => import("./OfficePreviewModal"));

interface GitStatusDto {
  isRepo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  files: GitFileDto[];
  totalAdd: number;
  totalDel: number;
}

interface UnmergedDto {
  merging: boolean;
  files: string[];
  staleBase: boolean;
}

interface ConflictContentDto {
  ours: string | null;
  theirs: string | null;
  diff: string;
  truncated: boolean;
}

interface ConflictAdviceDto {
  path: string;
  choice: "ours" | "theirs" | "manual";
  reason: string;
}

type ConflictChoice = "ours" | "theirs";

type FinishMode = "commit" | "merge" | "merge-archive" | "archive";

const STATUS_STYLE: Record<string, string> = {
  M: "text-warn-text",
  A: "text-add",
  "??": "text-add",
  D: "text-del",
  R: "text-l2",
};

const fileDiffCache = new Map<string, { text: string; rows: DiffLine[] }>();

/** 健康检查拦截项：key 用于给「主仓脏」挂快速提交入口，text 为面向用户的白话文案 */
function DiffSide({
  lineNo,
  text,
  kind,
}: {
  lineNo: number | null;
  text: string;
  kind: "context" | "add" | "delete" | "blank";
}) {
  // 增删行只铺语义底色，正文保持中性阅读色（text-l2），绿/红收进行号槽——
  // 整文件新增时不再是一面绿字墙（GitHub/VS Code 同手法，约定见 design-system.md）
  const tone =
    kind === "add"
      ? "bg-diff-add-bg"
      : kind === "delete"
        ? "bg-diff-del-bg"
        : kind === "blank"
          ? "bg-inset/40"
          : "";
  const noTone =
    kind === "add" || kind === "delete"
      ? kind === "add"
        ? "text-diff-add-fg"
        : "text-diff-del-fg"
      : "text-l4";
  return (
    <div
      className={`grid min-w-0 grid-cols-[44px_minmax(0,1fr)] ${tone}`}
    >
      <span
        className={`select-none border-r border-hairline px-2 text-right ${noTone}`}
      >
        {lineNo ?? ""}
      </span>
      <span className="min-w-0 whitespace-pre-wrap break-words px-2 text-l2 [overflow-wrap:anywhere]">{text || " "}</span>
    </div>
  );
}

function DiffTable({
  rows,
  unified = false,
}: {
  rows: DiffLine[];
  unified?: boolean;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const displayRows = useMemo(
    () => foldContextRows(rows, expanded),
    [expanded, rows],
  );

  useEffect(() => {
    setExpanded(new Set());
  }, [rows]);

  return (
    <div className="bg-canvas font-mono text-xs leading-6">
      {displayRows.map((row, index) => {
        if (row.kind === "fold") {
          return (
            <button
              key={row.id}
              type="button"
              onClick={() =>
                setExpanded((current) => {
                  const next = new Set(current);
                  next.add(row.id);
                  return next;
                })
              }
              className="flex h-7 w-full items-center justify-center border-y border-hairline bg-inset text-l4 hover:bg-seg-sel hover:text-l2"
            >
              展开 {row.rows.length} 行未修改内容
            </button>
          );
        }
        if (row.kind === "hunk") {
          return (
            <div
              key={`${row.header}-${index}`}
              className="flex h-6 items-center border-y border-hairline bg-inset px-3 text-l4"
            >
              {row.header}
            </div>
          );
        }
        if (unified) {
          return (
            <div key={index} className="min-w-0">
              <DiffSide
                lineNo={row.newNo ?? row.oldNo}
                text={row.newKind === "blank" ? row.oldText : row.newText}
                kind={row.newKind === "blank" ? row.oldKind : row.newKind}
              />
            </div>
          );
        }
        return (
          <div
            key={index}
            className="grid min-w-0 grid-cols-1 divide-y divide-hairline xl:grid-cols-2 xl:divide-x xl:divide-y-0"
          >
            <div className="min-w-0 overflow-hidden">
              <DiffSide
                lineNo={row.oldNo}
                text={row.oldText}
                kind={row.oldKind}
              />
            </div>
            <div className="min-w-0 overflow-hidden">
              <DiffSide
                lineNo={row.newNo}
                text={row.newText}
                kind={row.newKind}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DiffFileSection({
  file,
  worktreePath,
  revision,
  register,
  unified = false,
  cached,
}: {
  file: GitFileDto;
  worktreePath: string;
  revision: number;
  register: (path: string, element: HTMLElement | null) => void;
  unified?: boolean;
  cached?: { text: string; rows: DiffLine[] } | null;
}) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(true);
  const [text, setText] = useState<string | null>(cached?.text ?? null);
  const [rows, setRows] = useState<DiffLine[]>(cached?.rows ?? []);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = sectionRef.current;
    if (!element) return;
    register(file.path, element);
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
      },
      { rootMargin: "500px 0px" },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      register(file.path, null);
    };
  }, [file.path, register, worktreePath]);

  useEffect(() => {
    if (cached?.text) {
      setText(cached.text);
      setRows(cached.rows);
    }
  }, [cached]);

  useEffect(() => {
    // 图片文件不取文本 diff，渲染期交给 ImagePairView 双栏对比
    if (!visible || isImagePath(file.path) || cached?.text) return;
    let cancelled = false;
    setError(null);
    invoke<string>("workspace_file_diff", { worktreePath, path: file.path })
      .then((value) => {
        if (cancelled) return;
        const parsed = parseDiff(value);
        fileDiffCache.set(fileDiffCacheKey(worktreePath, file.path, revision), {
          text: value,
          rows: parsed,
        });
        setText(value);
        setRows(parsed);
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [cached?.text, file.path, revision, visible, worktreePath]);

  const image = isImagePath(file.path);
  return (
    <section
      ref={(element) => {
        sectionRef.current = element;
      }}
      className="border-b-4 border-strip bg-canvas"
    >
      <div className="sticky top-0 z-1 flex h-10 items-center gap-2 border-b border-hairline bg-strip px-3 text-xs">
        <span className={`font-mono ${STATUS_STYLE[file.status] ?? "text-l3"}`}>
          {file.status === "??" ? "U" : file.status}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono font-medium text-l1">
          {file.path}
        </span>
        {file.additions !== null && (
          <span className="font-mono text-add">+{file.additions}</span>
        )}
        {file.deletions !== null && file.deletions > 0 && (
          <span className="font-mono text-del">-{file.deletions}</span>
        )}
      </div>
      {image ? (
        visible ? (
          <ImagePairView cwd={worktreePath} path={file.path} revision={revision} />
        ) : (
          <div className="min-h-28 px-4 py-3">
            <LoadingRows compact />
          </div>
        )
      ) : !visible || text === null ? (
        <div className="min-h-28 px-4 py-3">
          {error ? (
            <p className="text-xs text-err-text">{error}</p>
          ) : (
            <LoadingRows compact />
          )}
        </div>
      ) : rows.length === 0 ? (
        <p className="px-4 py-5 text-xs text-l4">无可显示的文本差异</p>
      ) : (
        <DiffTable rows={rows} unified={unified} />
      )}
    </section>
  );
}

function ChangeTree({
  nodes,
  onSelect,
  activePath,
  depth = 0,
}: {
  nodes: ChangeTreeNode[];
  onSelect: (path: string) => void;
  activePath: string | null;
  depth?: number;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  return (
    <>
      {nodes.map((node) => {
        const isDir = node.children.length > 0;
        const isClosed = collapsed.has(node.path);
        return (
          <div key={node.path}>
            <button
              type="button"
              onClick={() => {
                if (isDir) {
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(node.path)) next.delete(node.path);
                    else next.add(node.path);
                    return next;
                  });
                } else {
                  onSelect(node.path);
                }
              }}
              title={node.path}
              className={`flex h-7 w-full items-center gap-1.5 border-l-2 pr-2 text-left text-xs hover:bg-hover ${
                !isDir && activePath === node.path
                  ? "border-cta bg-rail-sel text-l1"
                  : "border-transparent text-l2"
              }`}
              style={{ paddingLeft: 8 + depth * 14 }}
            >
              {isDir ? (
                <>
                  {isClosed ? (
                    <ChevronRight
                      aria-hidden="true"
                      className="h-3 w-3 shrink-0 text-l4"
                    />
                  ) : (
                    <ChevronDown
                      aria-hidden="true"
                      className="h-3 w-3 shrink-0 text-l4"
                    />
                  )}
                  {isClosed ? (
                    <FolderClosed
                      aria-hidden="true"
                      className="h-3.5 w-3.5 shrink-0 text-l3"
                    />
                  ) : (
                    <FolderOpen
                      aria-hidden="true"
                      className="h-3.5 w-3.5 shrink-0 text-l3"
                    />
                  )}
                </>
              ) : (
                <>
                  <span className="w-3 shrink-0" />
                  <File
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0 text-l3"
                  />
                </>
              )}
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              {node.file && (
                <>
                  <span
                    className={`font-mono ${STATUS_STYLE[node.file.status] ?? "text-l3"}`}
                  >
                    {node.file.status === "??" ? "U" : node.file.status}
                  </span>
                  <span className="h-1.5 w-1.5 rounded-full bg-warn-text" />
                </>
              )}
            </button>
            {isDir && !isClosed && (
              <ChangeTree
                nodes={node.children}
                onSelect={onSelect}
                activePath={activePath}
                depth={depth + 1}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function DeliveryReviewPane({
  root,
  paths,
  activePath,
  onSelect,
  empty,
  onAnnotate,
}: {
  root: string;
  paths: readonly string[];
  activePath: string | null;
  onSelect: (path: string) => void;
  empty: string;
  /** 划选文字追加到审阅意见。只在还能退回时传入。 */
  onAnnotate?: (
    text: string,
    fileName: string,
    comment: string,
  ) => string | null;
}) {
  const [query, setQuery] = useState("");
  const [listOpen, setListOpen] = useState(true);
  const current =
    (activePath && paths.includes(activePath) ? activePath : paths[0]) ?? null;
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? paths.filter((path) => reviewFileChip(path).toLowerCase().includes(needle))
    : paths;
  if (!current) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-8 text-sm text-l4">
        {empty}
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {paths.length > 1 && listOpen && (
        <aside className="flex w-56 shrink-0 flex-col border-r border-hairline">
          <div className="flex h-8 shrink-0 items-center gap-1 border-b border-hairline px-2">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="找笔记"
              className="min-w-0 flex-1 rounded-sm border border-field bg-inset px-2 py-0.5 text-xs text-l1"
            />
            <button
              type="button"
              onClick={() => setListOpen(false)}
              className="shrink-0 text-micro text-l3 hover:text-l1"
            >
              收起
            </button>
          </div>
          <ul className="min-h-0 flex-1 overflow-auto px-1 pb-2">
            {shown.map((path) => (
              <li key={path}>
                <button
                  type="button"
                  onClick={() => onSelect(path)}
                  title={path}
                  className={`w-full truncate rounded-sm px-2 py-1 text-left text-xs ${
                    current === path ? "bg-rail-sel text-l1" : "text-l3 hover:text-l1"
                  }`}
                >
                  {reviewFileChip(path)}
                </button>
              </li>
            ))}
            {shown.length === 0 && (
              <li className="px-2 py-1 text-xs text-l4">没有匹配的笔记。</li>
            )}
          </ul>
        </aside>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden overscroll-none">
        <ProjectFilePreview
          key={current}
          path={absUnderRoot(root, current)}
          root={root}
          leading={
            paths.length > 1 && !listOpen ? (
              <button
                type="button"
                onClick={() => setListOpen(true)}
                title="展开笔记列表"
                aria-label="展开笔记列表"
                className="-ml-1 shrink-0 px-1 text-micro text-l3 hover:text-l1"
              >
                ›
              </button>
            ) : null
          }
          onAnnotate={onAnnotate}
        />
      </div>
    </div>
  );
}

function GroupedReviewFiles({
  groups,
  onSelect,
  activePath,
  expandAll = false,
}: {
  groups: { id: string; label: string; files: GitFileDto[] }[];
  onSelect: (path: string) => void;
  activePath: string | null;
  expandAll?: boolean;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(["machine"]),
  );
  return (
    <>
      {groups.map((group) => {
        const closed = !expandAll && collapsed.has(group.id);
        return (
          <div key={group.id} className="mb-1">
            <button
              type="button"
              onClick={() => {
                setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(group.id)) next.delete(group.id);
                  else next.add(group.id);
                  return next;
                });
              }}
              className="flex h-7 w-full items-center gap-1.5 px-3 text-left text-micro text-l4 hover:bg-hover"
            >
              {closed ? (
                <ChevronRight aria-hidden="true" className="h-3 w-3 shrink-0" />
              ) : (
                <ChevronDown aria-hidden="true" className="h-3 w-3 shrink-0" />
              )}
              <span>{group.label}</span>
              <span className="ml-auto">{group.files.length}</span>
            </button>
            {!closed &&
              group.files.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => onSelect(file.path)}
                  title={file.path}
                  className={`flex h-7 w-full items-center gap-1.5 border-l-2 pr-2 text-left text-xs hover:bg-hover ${
                    activePath === file.path
                      ? "border-cta bg-rail-sel text-l1"
                      : "border-transparent text-l2"
                  }`}
                  style={{ paddingLeft: 22 }}
                >
                  <File aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-l3" />
                  <span className="min-w-0 flex-1 truncate">{file.path.split("/").pop()}</span>
                  <span className={`font-mono ${STATUS_STYLE[file.status] ?? "text-l3"}`}>
                    {file.status === "??" ? "U" : file.status}
                  </span>
                </button>
              ))}
          </div>
        );
      })}
    </>
  );
}

function ConflictFileSection({
  path,
  content,
  contentError,
  branch,
  baseBranch,
  unresolved,
  choice,
  advice,
  busy,
  register,
  onChoose,
  onRetry,
}: {
  path: string;
  content: ConflictContentDto | null;
  contentError: string | undefined;
  branch: string;
  baseBranch: string;
  unresolved: boolean;
  choice: ConflictChoice | undefined;
  advice: ConflictAdviceDto | undefined;
  busy: boolean;
  register: (path: string, element: HTMLElement | null) => void;
  onChoose: (path: string, choice: ConflictChoice) => void;
  onRetry: (path: string) => void;
}) {
  const rows = useMemo(
    () => (content ? parseDiff(content.diff) : []),
    [content],
  );
  return (
    <section
      ref={(element) => register(path, element)}
      className="border-b-4 border-strip bg-canvas"
    >
      <div className="sticky top-0 z-2 border-b border-hairline bg-strip">
        <div className="flex h-10 items-center gap-2 px-3 text-xs">
          <span
            className={`font-mono ${unresolved ? "text-err-text" : "text-ok-text"}`}
          >
            {unresolved ? "U" : "✓"}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono font-medium text-l1">
            {path}
          </span>
          {choice && (
            <span className="rounded-sm bg-inset px-2 py-0.5 text-l2">
              已选 {choice === "ours" ? "任务版" : baseBranch}
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 divide-x divide-hairline border-t border-hairline text-xs">
          <div
            className={`flex min-w-0 items-center gap-2 border-t-2 px-3 py-1.5 ${
              choice === "ours"
                ? "border-cta bg-cta-pill"
                : "border-transparent"
            }`}
          >
            <span className="min-w-0 flex-1 truncate text-l2">
              任务分支 · {branch}
            </span>
            <button
              type="button"
              onClick={() => onChoose(path, "ours")}
              disabled={!content || !unresolved || busy}
              className={`rounded-sm border px-2 py-0.5 disabled:opacity-50 ${
                choice === "ours"
                  ? "border-cta-bd bg-cta text-cta-text"
                  : "border-field bg-inset text-l2 hover:bg-seg-sel hover:text-l1"
              }`}
            >
              {choice === "ours" ? "已选" : "选用"}
            </button>
          </div>
          <div
            className={`flex min-w-0 items-center gap-2 border-t-2 px-3 py-1.5 ${
              choice === "theirs"
                ? "border-cta bg-cta-pill"
                : "border-transparent"
            }`}
          >
            <span className="min-w-0 flex-1 truncate text-l2">
              主分支 · {baseBranch}
            </span>
            <button
              type="button"
              onClick={() => onChoose(path, "theirs")}
              disabled={!content || !unresolved || busy}
              className={`rounded-sm border px-2 py-0.5 disabled:opacity-50 ${
                choice === "theirs"
                  ? "border-cta-bd bg-cta text-cta-text"
                  : "border-field bg-inset text-l2 hover:bg-seg-sel hover:text-l1"
              }`}
            >
              {choice === "theirs" ? "已选" : "选用"}
            </button>
          </div>
        </div>
        {advice && (
          <div className="flex min-h-8 items-center gap-2 border-t border-hairline bg-inset px-3 py-1 text-xs">
            <span className="shrink-0 text-l1">◈</span>
            <span className="shrink-0 text-l2">
              {advice.choice === "ours"
                ? "建议任务版"
                : advice.choice === "theirs"
                  ? `建议 ${baseBranch}`
                  : "建议手选"}
            </span>
            <span
              className="min-w-0 flex-1 truncate text-l4"
              title={advice.reason}
            >
              {advice.reason}
            </span>
            {unresolved &&
              (advice.choice === "ours" || advice.choice === "theirs") && (
                <button
                  type="button"
                  onClick={() =>
                    onChoose(path, advice.choice as ConflictChoice)
                  }
                  disabled={busy}
                  className="shrink-0 rounded-sm px-2 py-0.5 text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
                >
                  按建议
                </button>
              )}
          </div>
        )}
      </div>

      {contentError ? (
        <div className="min-h-36 px-4 py-5 text-xs text-err-text">
          <p>加载两侧内容失败：{contentError}</p>
          <button
            type="button"
            onClick={() => onRetry(path)}
            className={`mt-2 ${secondaryActionClass}`}
          >
            重试加载
          </button>
        </div>
      ) : !content ? (
        <div className="min-h-36 px-4 py-4">
          <LoadingRows compact />
        </div>
      ) : rows.length === 0 ? (
        <div className="grid min-h-36 grid-cols-2 divide-x divide-hairline font-mono text-micro leading-5">
          <pre className="overflow-auto whitespace-pre p-3 text-l2">
            {content.ours ?? "（此侧已删除）"}
          </pre>
          <pre className="overflow-auto whitespace-pre p-3 text-l2">
            {content.theirs ?? "（此侧已删除）"}
          </pre>
        </div>
      ) : (
        <DiffTable rows={rows} />
      )}
      {content?.truncated && (
        <div className="border-t border-hairline bg-inset px-3 py-2 text-xs text-warn-text">
          文件较大，当前只显示前 512
          KB；需要逐行编辑时请在预览编辑器中打开该文件。
        </div>
      )}
    </section>
  );
}

/**
 * 主仓脏拦截的内联快速提交面板（评审覆盖层内，不跳转）：
 * 列主仓库改动，默认不勾选；提交信息留空走本地中性默认信息（不调 AI）。
 */
function MainRepoCommitPanel({
  repoPath,
  onCommitted,
  onCancel,
}: {
  repoPath: string;
  onCommitted: () => void;
  onCancel: () => void;
}) {
  const [status, setStatus] = useState<GitStatusDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<GitStatusDto>("git_status", { cwd: repoPath })
      .then((value) => {
        if (!cancelled) setStatus(value);
      })
      .catch((reason) => {
        if (!cancelled) setLoadError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  // 台账类（雷达/积累面）从面板剔除：它们不进 git，列出来只会引导把积累面提交进主线
  const files = userDirtyFiles(status?.files ?? []);
  const selectedFiles = files.filter((file) => selectedPaths.has(file.path));
  const allSelected = files.length > 0 && selectedPaths.size === files.length;

  async function commit() {
    if (selectedFiles.length === 0) return;
    const commitMessage =
      message.trim() || defaultCommitMessage(selectedFiles);
    setCommitting(true);
    setError(null);
    // Git 阶段失败时保留本地生成的默认信息，用户可直接重试或编辑
    if (!message.trim()) setMessage(commitMessage);
    try {
      const out = await invoke<GitCommitResultDto>("git_commit", {
        cwd: repoPath,
        message: commitMessage,
        push: false,
        paths: selectedFiles.map((file) => file.path),
      });
      if (!out.committed) throw new Error(out.message);
      onCommitted();
    } catch (reason) {
      setError(String(reason));
      setCommitting(false);
    }
  }

  return (
    <div className="mt-1.5 rounded-md ccode-well p-2 text-l2">
      <p className="mb-2 text-micro text-l4">
        提交 = 把改动保存到任务分支。保存进项目后才会进入项目主线历史；文件本身不会丢。
      </p>
      {loadError ? (
        <p className="text-xs text-err-text">{loadError}</p>
      ) : !status ? (
        <LoadingRows compact />
      ) : files.length === 0 ? (
        <p className="text-xs text-l4">主文件夹当前没有未保存的改动</p>
      ) : (
        <>
          <div className="mb-1 flex items-center justify-between text-micro text-l4">
            <span>
              将提交 {selectedFiles.length} / {files.length} 个文件
            </span>
            <button
              type="button"
              onClick={() =>
                setSelectedPaths(
                  allSelected
                    ? new Set()
                    : new Set(files.map((file) => file.path)),
                )
              }
              className="text-l3 hover:text-l1"
            >
              {allSelected ? "清空" : "全选"}
            </button>
          </div>
          <ul className="mb-2 max-h-40 overflow-auto">
            {files.map((file) => (
              <li
                key={`${file.status}:${file.path}`}
                className="flex items-center gap-1.5 py-0.5 text-xs"
              >
                <Checkbox
                  checked={selectedPaths.has(file.path)}
                  onChange={(checked) =>
                    setSelectedPaths((current) => {
                      const next = new Set(current);
                      if (checked) next.add(file.path);
                      else next.delete(file.path);
                      return next;
                    })
                  }
                  label={<span className="sr-only">选择 {file.path}</span>}
                />
                <span
                  className={`shrink-0 font-mono ${STATUS_STYLE[file.status] ?? "text-l3"}`}
                >
                  {file.status === "??" ? "U" : file.status}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-l2">
                  {file.path}
                </span>
                {file.additions !== null && (
                  <span className="font-mono text-add">+{file.additions}</span>
                )}
                {file.deletions !== null && file.deletions > 0 && (
                  <span className="font-mono text-del">-{file.deletions}</span>
                )}
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-1.5">
            <input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && selectedFiles.length > 0)
                  void commit();
              }}
              disabled={committing}
              placeholder="提交信息（可选，留空快速提交）"
              className="min-w-0 flex-1 rounded-sm border border-field bg-strip px-2 py-1 text-xs text-l2 outline-none placeholder:text-l4 focus:border-l4 disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => void commit()}
              disabled={committing || selectedFiles.length === 0}
              className="shrink-0 rounded-sm border border-cta-bd bg-cta px-3 py-1 text-xs text-cta-text hover:brightness-110 disabled:opacity-50"
            >
              {committing ? "提交中…" : message.trim() ? "提交" : "快速提交"}
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={committing}
              className="shrink-0 rounded-sm px-2 py-1 text-xs text-l3 hover:bg-hover hover:text-l1 disabled:opacity-50"
            >
              取消
            </button>
          </div>
          {error && <p className="mt-1.5 text-xs text-err-text">✗ {error}</p>}
        </>
      )}
    </div>
  );
}

export default function WorkspaceReviewView(props: Parameters<typeof LiveWorkspaceReviewView>[0]) {
  const [resolved, setResolved] = useState<{ id: string; run: RunDto | null; error?: string } | null>(null);
  useEffect(() => {
    if (!props.runId) return;
    let cancelled = false;
    const id = props.runId;
    invoke<RunDto | null>("run_get", { id })
      .then((run) => { if (!cancelled) setResolved({ id, run }); })
      .catch((reason) => { if (!cancelled) setResolved({ id, run: null, error: String(reason) }); });
    return () => { cancelled = true; };
  }, [props.runId]);
  if (props.runId) {
    if (resolved?.id !== props.runId) return <div className="absolute inset-0 z-30 bg-canvas p-4 text-sm text-l3">正在读取运行记录…<button type="button" onClick={props.onClose} className="ml-3 text-l2">返回</button></div>;
    if (resolved.error || !resolved.run) return <div className="absolute inset-0 z-30 bg-canvas p-4 text-sm text-err-text">
      <p>{resolved.error ?? "运行记录不存在，无法核验历史证据"}</p>
      <button type="button" onClick={props.onClose} className="mt-2 text-l2">返回</button>
    </div>;
    if (resolved.run.taskKind === "watch") return <WatchRunReview key={props.runId} run={resolved.run} locked={props.reviewLocked} onClose={props.onClose}
      currentDirectory={<LiveWorkspaceReviewView {...props} runId={null} />} />;
  }
  return <LiveWorkspaceReviewView {...props} />;
}

function LiveWorkspaceReviewView({
  worktreePath,
  runId = null,
  initialAction = null,
  initialActionKey = null,
  onClose,
}: {
  worktreePath: string;
  /** 运行身份；存在时评审证据以该 Run 的隔离树和状态为准。 */
  runId?: string | null;
  /** 定时巡检已采纳：评审只查看。 */
  reviewLocked?: boolean;
  /** pr/archive 定位对应弹层；resolve-conflict 表示「解决冲突」入口，允许自动准备冲突两侧。 */
  initialAction?: "pr" | "archive" | "resolve-conflict" | null;
  /** 同一工作区的重复“更多操作”请求也必须重新打开相应弹层。 */
  initialActionKey?: string | null;
  onClose: () => void;
}) {
  const [diff, setDiff] = useState<WorkspaceDiffDto | null>(null);
  const [researchContext, setResearchContext] = useState<{ root: string; workspace: WorkspaceDto; step: ProjectStepDto; artifactDir: string; hasReproduction: boolean } | null>(null);
  const [researchRunId, setResearchRunId] = useState<string | null>(null);
  const [researchError, setResearchError] = useState<string | null>(null);
  const [status, setStatus] = useState<GitStatusDto | null>(null);
  const [health, setHealth] = useState<WorkspaceHealthDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);
  const signatureRef = useRef("");
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  const reviewMainRef = useRef<HTMLElement | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const autoConflictRef = useRef<string | null>(null);
  const prTitleInitRef = useRef<string | null>(null);
  // 点击树定位后短暂抑制滚动同步，避免 smooth 滚动途中 activePath 被改回
  const suppressTrackRef = useRef(false);
  const suppressTrackTimerRef = useRef<number | null>(null);
  const [mergedAt, setMergedAt] = useState<string | null>(null);
  // 合并成功（保留工作区）后的「开始下一步」衔接：横幅入口只挂在本次评审的合并成功态上
  const [mergeDone, setMergeDone] = useState(false);
  const [ledgerPending, setLedgerPending] = useState(false);
  const [mergeVersionId, setMergeVersionId] = useState<string | null>(null);
  const reviewedShaRef = useRef<string | null>(null);
  const [deliveryReview, setDeliveryReview] = useState<WorkspaceDeliverableReviewDto | null>(null);
  const deliveryReviewRef = useRef<WorkspaceDeliverableReviewDto | null>(null);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [deliveryPreview, setDeliveryPreview] = useState<string | null>(null);
  const [deliveryFollowup, setDeliveryFollowup] = useState("");
  const [nextStep, setNextStep] = useState<{
    step: ProjectStepDto;
    cfg: ProjectConfigDto;
    projectPath: string;
  } | null>(null);
  // 「沉淀到下一步」：评审结论写进下一步步骤的任务书草稿（不存在则新建）
  const [distillOpen, setDistillOpen] = useState(false);
  const [distillText, setDistillText] = useState("");
  const [distillBusy, setDistillBusy] = useState(false);
  const [distillMsg, setDistillMsg] = useState<string | null>(null);
  // 「◈ AI 起草」：ai_distill_review（功能键复用 digest）填初稿，人定稿后才落盘
  const [distillDrafting, setDistillDrafting] = useState(false);
  const [distillDraftError, setDistillDraftError] = useState<string | null>(null);
  // 可信度证据（进评审一次性读取，不轮询；失败静默降级为不显示）：
  // 引用健康（.md 引用键 vs references.bib）+ 产物核验摘要（复用 ArtifactChecklist 的定位机制）
  const [citations, setCitations] = useState<CitationHealthDto | null>(null);
  const [citeExpanded, setCiteExpanded] = useState(false);
  const [artifacts, setArtifacts] = useState<{
    produced: number;
    total: number;
  } | null>(null);
  // 人工事项收尾提醒（同一次性读取口径）：本步骤 timing=after 且未完成的事项标题
  const [humanClosing, setHumanClosing] = useState<string[] | null>(null);
  const [wsRow, setWsRow] = useState<WorkspaceDto | null>(null);
  const [writingHits, setWritingHits] = useState<WritingReviewHit[]>([]);
  const [reviewNotes, setReviewNotes] = useState("");
  const [returnBusy, setReturnBusy] = useState(false);
  // 上游漂移提醒：上游步骤晚于本步最后推进时间合并 → 产物可能过期（list_workspaces 顺带取回）
  const [staleUpstream, setStaleUpstream] = useState<string | null>(null);
  const setPage = useAppStore((s) => s.setPage);
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setSelectProjectReq = useAppStore((s) => s.setSelectProjectReq);
  const setFilePreviewReq = useAppStore((s) => s.setFilePreviewReq);
  const [reviewPane, setReviewPane] = useState<ReviewPane>("content");
  const [opening, setOpening] = useState(true);
  const [message, setMessage] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [finishMenu, setFinishMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [showBlockers, setShowBlockers] = useState(false);
  // 主仓脏拦截的内联快速提交：repoPath 取工作区所属主仓库，面板不跳转页面
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [mainCommitOpen, setMainCommitOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [prOpen, setPrOpen] = useState(false);
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [prBusy, setPrBusy] = useState(false);
  const [prDrafting, setPrDrafting] = useState(false);
  const [prPushed, setPrPushed] = useState(false);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [prCopied, setPrCopied] = useState(false);
  const [reviewRailOpen, setReviewRailOpen] = useState(false);
  const initialActionRef = useRef<string | null>(null);
  const [unmerged, setUnmerged] = useState<UnmergedDto | null>(null);
  const [conflictFiles, setConflictFiles] = useState<string[]>([]);
  const [conflictContents, setConflictContents] = useState<
    Record<string, ConflictContentDto>
  >({});
  const [conflictContentErrors, setConflictContentErrors] = useState<
    Record<string, string>
  >({});
  const [conflictChoices, setConflictChoices] = useState<
    Record<string, ConflictChoice>
  >({});
  const [conflictAdvice, setConflictAdvice] = useState<
    Record<string, ConflictAdviceDto>
  >({});
  const [conflictBusy, setConflictBusy] = useState(false);
  const [adviceBusy, setAdviceBusy] = useState(false);
  const [fileQuery, setFileQuery] = useState("");
  const [activePath, setActivePath] = useState<string | null>(null);
  const readOnlyRunReview = diff?.reviewOnly === true;

  const refresh = useCallback(
    async (quiet = false) => {
      if (!quiet) setRefreshing(true);
      try {
        const [nextDiff, nextStatus] = await Promise.all([
          invoke<WorkspaceDiffDto>("workspace_diff", { worktreePath }),
          invoke<GitStatusDto>("git_status", { cwd: worktreePath }),
        ]);
        if (!nextDiff.inWorkspace) throw new Error("该目录不属于活动工作区或 Run 隔离树");
        const [nextHealth, nextUnmerged] = nextDiff.reviewOnly
          ? [null, { merging: false, files: [], staleBase: false } as UnmergedDto]
          : await Promise.all([
              invoke<WorkspaceHealthDto>("workspace_health", {
                id: nextDiff.workspaceId,
              }),
              invoke<UnmergedDto>("workspace_unmerged_files", {
                id: nextDiff.workspaceId,
              }),
            ]);
        if (!nextDiff.reviewOnly && (!quiet || !deliveryReviewRef.current)) {
          try {
            const review = await invoke<WorkspaceDeliverableReviewDto>("workspace_review_deliverables", { id: nextDiff.workspaceId });
            deliveryReviewRef.current = review; setDeliveryReview(review); setDeliveryError(null);
          } catch (reason) {
            deliveryReviewRef.current = null; setDeliveryReview(null); setDeliveryError(String(reason));
          }
        }
        const signature = JSON.stringify({
          files: nextDiff.files,
          status: nextStatus.files,
          health: nextHealth,
        });
        if (signature !== signatureRef.current) {
          signatureRef.current = signature;
          setRevision((value) => value + 1);
        }
        setDiff(nextDiff);
        setStatus(nextStatus);
        setHealth(nextHealth);
        setLedgerPending(nextHealth?.ledgerPending === true);
        reviewedShaRef.current = freezeReviewedSha(
          reviewedShaRef.current,
          nextHealth?.worktreeHead,
          !quiet,
        );
        setUnmerged(nextUnmerged);
        if (nextUnmerged.merging && nextUnmerged.files.length > 0) {
          setConflictFiles((current) =>
            current.length > 0 ? current : nextUnmerged.files,
          );
        }
        if (!quiet) setError(null);
      } catch (reason) {
        // 静默轮询失败不覆盖用户正在看的错误，避免留下清不掉的粘性横幅
        if (!quiet) setError(String(reason));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [worktreePath],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    signatureRef.current = "";
    autoConflictRef.current = null;
    prTitleInitRef.current = null;
    suppressTrackRef.current = false;
    if (suppressTrackTimerRef.current !== null) {
      window.clearTimeout(suppressTrackTimerRef.current);
      suppressTrackTimerRef.current = null;
    }
    sectionRefs.current.clear();
    setMergedAt(null);
    setOpening(true);
    setResearchContext(null);
    setResearchError(null);
    setMergeDone(false);
    setLedgerPending(false);
    setMergeVersionId(null);
    reviewedShaRef.current = null;
    deliveryReviewRef.current = null; setDeliveryReview(null); setDeliveryError(null); setDeliveryPreview(null); setDeliveryFollowup("");
    setNextStep(null);
    setCitations(null);
    setCiteExpanded(false);
    setArtifacts(null);
    setWsRow(null);
    setWritingHits([]);
    setReviewNotes("");
    setStaleUpstream(null);
    setDistillDraftError(null);
    setUnmerged(null);
    setConflictFiles([]);
    setConflictContents({});
    setConflictContentErrors({});
    setConflictChoices({});
    setConflictAdvice({});
    setFileQuery("");
    setActivePath(null);
    setRepoPath(null);
    setMainCommitOpen(false);
    initialActionRef.current = null;
  }, [worktreePath]);

  // merged_at 不在 diff/health DTO 上，按工作区单独取一次，用于「已合并」按钮态；
  // 顺带取所属主仓库路径（主仓脏拦截的内联快速提交）与上游漂移提醒（staleUpstream）
  useEffect(() => {
    const workspaceId = diff?.workspaceId;
    if (!workspaceId || diff?.reviewOnly) return;
    invoke<WorkspaceDto[]>("list_workspaces")
      .then((list) => {
        const workspace = list.find((entry) => entry.id === workspaceId);
        setMergedAt(workspace?.mergedAt ?? null);
        setRepoPath(workspace?.repoPath ?? null);
        setStaleUpstream(workspace?.staleUpstream ?? null);
        setWsRow(workspace ?? null);
      })
      .catch(() => {});
  }, [diff?.workspaceId, diff?.reviewOnly]);

  // 可信度证据：进评审一次性读取（不轮询）。引用健康扫工作树；产物按绑定步骤的
  // 预期清单在工作树定位（同 ArtifactChecklist 机制）。任一路失败静默降级（行不显示）。
  useEffect(() => {
    const workspaceId = diff?.workspaceId;
    if (!workspaceId) return;
    let stale = false;
    invoke<CitationHealthDto>("check_citation_health", { path: worktreePath })
      .then((value) => {
        if (!stale) setCitations(value);
      })
      .catch(() => {});
    void (async () => {
      try {
        if (runId) {
          const rows = await invoke<RunArtifactDto[]>("run_artifacts", { runId }).catch(() => []);
          if (!stale) {
            const expectedRows = rows.filter((row) => row.expected);
            setArtifacts({
              produced: expectedRows.filter((row) => row.reviewStatus !== "not_started").length,
              total: expectedRows.length,
            });
          }
        }
        if (diff?.reviewOnly) return;
        const list = await invoke<WorkspaceDto[]>("list_workspaces");
        const workspace = list.find((entry) => entry.id === workspaceId);
        if (!workspace || workspace.worktreePath !== worktreePath) return;
        const read = await invoke<ProjectConfigReadDto>("read_project_config", {
          path: workspace.repoPath,
        });
        const step = read.config.steps.find(
          (s) => s.workspaceName === workspace.name,
        );
        if (!stale) {
          setResearchError(null);
          setResearchContext(step ? { root: worktreePath, workspace, step, artifactDir: read.config.artifactDir || "artifacts", hasReproduction: reproductionEntrypoints(step).length > 0 || step.run.some((s) => /reproduc|复现|复算/i.test(s.name)) } : null);
          setOpening(false);
        }
        if (step) {
          invoke<{ run: { name: string }[] }>("workspace_settings", { repoPath: workspace.repoPath }).then((settings) => {
            if (!stale && settings.run.some((s) => /reproduc|复现|复算/i.test(s.name))) {
              setResearchContext((context) => context?.root === worktreePath ? { ...context, hasReproduction: true } : context);
            }
          }).catch(() => { if (!stale) setResearchError("复现配置读取失败，请重新打开评审后重试。"); });
        }
        // 人工事项收尾提醒：步骤声明了人工事项才查（after 档未完成才提醒，同只提醒不阻断口径）
        if (step && (step.humanTasks?.length ?? 0) > 0) {
          invoke<HumanTaskStateDto[]>("list_human_task_states", {
            projectRoot: workspace.repoPath,
          })
            .then((states) => {
              if (stale) return;
              setHumanClosing(
                states
                  .filter(
                    (s) =>
                      s.step === step.name &&
                      s.timing === "after" &&
                      !s.done &&
                      !s.optional,
                  )
                  .map((s) => s.title),
              );
            })
            .catch(() => {});
        }
        if (!runId && step && step.expectedArtifacts.length > 0) {
          const rows = await loadArtifactRows(step.expectedArtifacts, worktreePath);
          if (!stale) {
            setArtifacts({
              produced: rows.filter((row) => row.files.length > 0).length,
              total: rows.length,
            });
          }
        }
      } catch (reason) {
        if (!stale && !diff?.reviewOnly) setResearchError(`科研报告上下文读取失败：${String(reason)}`);
      }
    })();
    return () => {
      stale = true;
    };
  }, [diff?.workspaceId, diff?.reviewOnly, runId, worktreePath]);

  useEffect(() => {
    const rel = writingScanSourcePath((diff?.files ?? []).map((file) => file.path));
    let stale = false;
    if (rel) {
      invoke<{ text: string }>("read_file_preview", {
        path: absUnderRoot(worktreePath, rel),
        root: worktreePath,
      })
        .then((preview) => {
          if (stale) return;
          setWritingHits(
            scanWritingReview(preview.text, {
              allowGapIds: /(^|\/)outline\.md$/i.test(rel.replace(/\\/g, "/")),
            }),
          );
        })
        .catch(() => {
          if (!stale) setWritingHits([]);
        });
    } else {
      setWritingHits([]);
    }
    return () => {
      stale = true;
    };
  }, [diff, worktreePath]);

  // 上次退回意见只在打开这一步时读一次。文件列表刷新不得把正在删的字填回去。
  useEffect(() => {
    let stale = false;
    setReviewNotes("");
    void invoke<{ text: string }>("read_file_preview", {
      path: `${worktreePath.replace(/[\\/]+$/, "")}/.ccode/review-notes.md`,
      root: worktreePath,
    })
      .then((preview) => {
        if (!stale) setReviewNotes(preview.text);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [worktreePath]);

  // 合并成功后定位流水线下一步：当前步 = 与本工作区同名的步骤；
  // 下一步 = 其后第一个尚未开步的步骤（同仓库存在同名工作区 = 已开过，含已归档）。
  // 项目未注册/无流水线/当前步未绑定/无下一步时入口不显示
  useEffect(() => {
    if (!mergeDone || !diff) return;
    let stale = false;
    void (async () => {
      try {
        const list = await invoke<WorkspaceDto[]>("list_workspaces");
        const current = list.find((w) => w.id === diff.workspaceId);
        if (!current) throw new Error("工作区记录缺失");
        const read = await invoke<ProjectConfigReadDto>("read_project_config", {
          path: current.repoPath,
        });
        const steps = read.config.steps;
        const index = steps.findIndex(
          (s) => s.workspaceName === current.name,
        );
        const taken = new Set(
          list
            .filter((w) => w.repoPath === current.repoPath)
            .map((w) => w.name),
        );
        const next =
          index >= 0
            ? steps.slice(index + 1).find((s) => !taken.has(s.workspaceName))
            : undefined;
        if (!stale) {
          setNextStep(
            next
              ? { step: next, cfg: read.config, projectPath: current.repoPath }
              : null,
          );
        }
      } catch {
        if (!stale) setNextStep(null);
      }
    })();
    return () => {
      stale = true;
    };
  }, [mergeDone, diff]);

  /** 「→ 去下一步」（v3.97 改向）：合并成功后**不直接开步**，而是把用户带到项目页——
   *  聚焦自动落在第一个未完成步骤（即刚解锁的下一步），先看流程线/TASK.md/人工事项，
   *  准备好了自己点「开始」。直接开步跳终端会把非编程用户扔进黑窗（用户拍板） */
  async function goNextStep() {
    if (!nextStep) return;
    const heading = `上一步（${diff?.workspaceName ?? "未知步骤"}）评审沉淀`;
    // 只有人在沉淀框里留下的字才写进下一步。空框表示没有新约束，不自动再起草。
    const content = distillText.trim();
    if (content) {
      try {
        await invoke("append_step_draft", {
          projectRoot: nextStep.projectPath,
          stepName: nextStep.step.name,
          heading,
          content,
        });
      } catch {
        /* 草稿写失败不挡去下一步 */
      }
    }
    setSelectProjectReq(nextStep.projectPath);
    setPage("workspaces");
    setNextStep(null);
  }

  /** 「◈ AI 起草」：对照下一步任务书和已验收产物，只起草还没有的约束。
   *  模型判定没有新约束时返回空，留在框里提示，不写盘。 */
  async function draftDistill() {
    if (!diff || !nextStep || distillDrafting) return;
    setDistillDrafting(true);
    setDistillDraftError(null);
    try {
      const draft = await invoke<string>("ai_distill_review", {
        id: diff.workspaceId,
        stepName: nextStep.step.name,
      });
      const text = draft.trim();
      if (!text) {
        setDistillText("");
        setDistillDraftError(
          "没有下一步还缺的约束。这一步不必沉淀，直接去下一步即可。",
        );
        return;
      }
      setDistillText(text);
    } catch (reason) {
      setDistillDraftError(`${reason}（检查设置页「AI 专用配置」是否可用）`);
    } finally {
      setDistillDrafting(false);
    }
  }

  /** 「沉淀到下一步」（v3.72 起改落任务书草稿）：评审结论定稿追加进下一步步骤的
   *  任务书草稿（.ccode/drafts/<步骤>.md，不存在则新建）——下一步开工弹层直接读到它，
   *  不再经「简报钉卡 → 开工拼装」中间层 */
  async function submitDistill(e: React.FormEvent) {
    e.preventDefault();
    if (!nextStep || distillBusy) return;
    const content = distillText.trim();
    if (!content) return;
    setDistillBusy(true);
    setDistillDraftError(null);
    try {
      const rel = await invoke<string>("append_step_draft", {
        projectRoot: nextStep.projectPath,
        stepName: nextStep.step.name,
        heading: `上一步（${diff?.workspaceName ?? "未知步骤"}）评审沉淀`,
        content,
      });
      setDistillOpen(false);
      setDistillText("");
      setDistillMsg(`已沉淀进下一步 TASK.md：${rel}`);
    } catch (reason) {
      setDistillDraftError(String(reason));
    } finally {
      setDistillBusy(false);
    }
  }

  /** 划选追加到意见框。不写盘，退回时才和手写意见一起落 review-notes。 */
  const addAnnotation = useCallback(
    (excerpt: string, fileName: string, comment: string) => {
      const quote = excerpt.trim();
      if (!quote) return "先划一段文字";
      setReviewNotes((notes) =>
        appendReviewAnnotation(notes, { fileName, excerpt: quote, comment }),
      );
      return null;
    },
    [],
  );

  async function returnToAgent(rewrite: boolean) {
    if (!wsRow || returnBusy) return;
    const notes = reviewNotes.trim();
    if (
      rewrite &&
      !(await confirmDialog("将新开一轮，按你写的意见重写本步稿件。继续？", {
        confirmText: "按意见重写",
      }))
    ) {
      return;
    }
    setReturnBusy(true);
    setError(null);
    try {
      const stored =
        notes ||
        writingHits.map((hit) => `- ${hit.label}`).join("\n") ||
        "按评审意见修改本步产物。";
      await invoke("write_review_notes", {
        worktreePath,
        content: stored,
      });
      setPendingTerminal(
        await buildWorkspaceTerminalRequest(
          wsRow,
          writingReturnPrompt({ notes: stored, hits: writingHits, rewrite }),
          { autoStart: true, resumeSession: !rewrite },
        ),
      );
      setPage("terminal");
      onClose();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setReturnBusy(false);
    }
  }

  // 沉淀成功提示是瞬态反馈：10s 自动消退（同工作区创建横幅口径）
  useEffect(() => {
    if (!distillMsg) return;
    const t = setTimeout(() => setDistillMsg(null), 10_000);
    return () => clearTimeout(t);
  }, [distillMsg]);

  // 工作区列表的“在评审中创建 PR / 归档”只负责定位到此处；真正执行仍要求在覆盖层内确认。
  useEffect(() => {
    if (!initialAction || !diff) return;
    const key = `${initialActionKey ?? initialAction}:${initialAction}:${diff.workspaceId}`;
    if (initialActionRef.current === key) return;
    initialActionRef.current = key;
    if (initialAction === "pr") setPrOpen(true);
    else if (initialAction === "archive") setArchiveOpen(true);
  }, [diff, initialAction, initialActionKey]);

  // PR 标题只按工作区初始化一次，之后允许用户清空重写
  useEffect(() => {
    if (!diff || prTitleInitRef.current === diff.workspaceId) return;
    prTitleInitRef.current = diff.workspaceId;
    setPrTitle(diff.workspaceName);
  }, [diff]);

  // 「解决冲突」本身就是明确操作：工作区干净时直接准备最新基准两侧，
  // 不先展示容易被误认为当前 main 的普通 merge-base diff。
  // 自动准备只绑定「解决冲突」入口；普通「审阅」入口不得仅因打开就把 worktree 置入 MERGING。
  useEffect(() => {
    if (
      initialAction !== "resolve-conflict" ||
      !diff ||
      health?.conflict !== true ||
      !status ||
      !unmerged ||
      unmerged.merging ||
      status.files.length > 0 ||
      busy ||
      conflictBusy
    ) {
      return;
    }
    if (autoConflictRef.current === diff.workspaceId) return;
    autoConflictRef.current = diff.workspaceId;
    void startConflictResolution(false);
  }, [busy, conflictBusy, diff, health?.conflict, initialAction, status, unmerged]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!busy && !conflictBusy) void refresh(true);
    }, 8000);
    return () => window.clearInterval(timer);
  }, [busy, conflictBusy, refresh]);

  useEffect(() => {
    if (!diff || !unmerged?.merging || unmerged.staleBase) return;
    const paths = conflictFiles.length > 0 ? conflictFiles : unmerged.files;
    const missing = paths.filter(
      (path) => !conflictContents[path] && !conflictContentErrors[path],
    );
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(
      missing.map(async (path) => {
        try {
          const content = await invoke<ConflictContentDto>(
            "workspace_conflict_content",
            {
              id: diff.workspaceId,
              path,
            },
          );
          return { path, content, error: null };
        } catch (reason) {
          return { path, content: null, error: String(reason) };
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      const entries = results
        .filter(
          (item): item is typeof item & { content: ConflictContentDto } =>
            !!item.content,
        )
        .map((item) => [item.path, item.content] as const);
      const errors = results
        .filter((item) => item.error)
        .map((item) => [item.path, item.error!] as const);
      if (entries.length > 0) {
        setConflictContents((current) => ({
          ...current,
          ...Object.fromEntries(entries),
        }));
      }
      if (errors.length > 0) {
        setConflictContentErrors((current) => ({
          ...current,
          ...Object.fromEntries(errors),
        }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [conflictContentErrors, conflictContents, conflictFiles, diff, unmerged]);

  // 主仓脏在外部被处理后（含本面板提交成功），收起内联快速提交面板
  useEffect(() => {
    if (mainCommitOpen && health && !health.mainDirty) setMainCommitOpen(false);
  }, [health, mainCommitOpen]);

  const blockers = blockerList(health);
  const conflictMode = unmerged?.merging === true;
  const staleBase = unmerged?.staleBase === true;
  const unresolvedFiles = unmerged?.files ?? [];
  const unresolvedSet = useMemo(
    () => new Set(unresolvedFiles),
    [unresolvedFiles],
  );
  const allConflictContentsLoaded =
    conflictFiles.length > 0 &&
    conflictFiles.every((path) => !!conflictContents[path]);
  const hasUncommitted = (status?.files.length ?? 0) > 0;
  const hasCommitted = (health?.ahead ?? 0) > 0;
  const hasTaskChanges = (diff?.files.length ?? 0) > 0;
  const hardBlocked = blockers.length > 0;
  // 约定：merged_at && ahead == 0 时按钮显示禁用的「已保存进项目」，
  // 新提交令 ahead > 0 后恢复「保存进项目」
  const primaryLabel = reviewSavePrimaryLabel({
    hasUncommitted,
    hasCommitted,
    mergedAt,
  });
  const canPrimary =
    !busy &&
    !hardBlocked && !deliveryError && !!deliveryReview &&
    // 提交信息可留空（v3.97）：finish 里留空走本地默认信息，按钮不再因空信息变灰
    (hasUncommitted || hasCommitted);
  const normalizedQuery = fileQuery.trim().toLocaleLowerCase();
  const reviewProfile = resolveStepReviewProfile(
    researchContext?.step ?? null,
    (diff?.files ?? []).map((file) => file.path),
  );
  const filteredFiles = useMemo(
    () =>
      (diff?.files ?? []).filter((file) => {
        if (reviewProfile.kind === "screening" && !isScreeningReviewFile(file.path)) return false;
        return (
          !normalizedQuery ||
          file.path.toLocaleLowerCase().includes(normalizedQuery)
        );
      }),
    [diff?.files, normalizedQuery, reviewProfile.kind],
  );
  const orderedFiles = useMemo(() => {
    if (!reviewProfile.groupFiles) return filteredFiles;
    const order =
      reviewProfile.kind === "screening"
        ? sortReviewPaths(filteredFiles.map((file) => file.path))
        : sortDeliveryPaths(filteredFiles.map((file) => file.path));
    const map = new Map(filteredFiles.map((file) => [file.path, file]));
    return order.map((path) => map.get(path)).filter((file): file is GitFileDto => !!file);
  }, [filteredFiles, reviewProfile.groupFiles, reviewProfile.kind]);
  const reviewFileGroups = useMemo(() => {
    if (!reviewProfile.groupFiles) return [];
    return reviewProfile.kind === "screening"
      ? groupReviewFiles(orderedFiles)
      : groupDeliveryFiles(orderedFiles);
  }, [orderedFiles, reviewProfile.groupFiles, reviewProfile.kind]);
  const tree = useMemo(() => buildChangeTree(filteredFiles), [filteredFiles]);
  const filteredConflictFiles = useMemo(
    () =>
      conflictFiles.filter(
        (path) =>
          !normalizedQuery ||
          path.toLocaleLowerCase().includes(normalizedQuery),
      ),
    [conflictFiles, normalizedQuery],
  );
  const displayedPaths = conflictMode
    ? filteredConflictFiles
    : orderedFiles.map((file) => file.path);
  const stackedFiles = useMemo(() => {
    if (conflictMode) return orderedFiles;
    if (reviewProfile.groupFiles) {
      const current = activePath
        ? orderedFiles.find((entry) => entry.path === activePath)
        : orderedFiles[0];
      return current ? [current] : [];
    }
    if (!reviewProfile.hideListDiffs) return orderedFiles;
    if (!activePath) return [];
    const file = orderedFiles.find((entry) => entry.path === activePath);
    return file ? [file] : [];
  }, [activePath, conflictMode, orderedFiles, reviewProfile.groupFiles, reviewProfile.hideListDiffs]);
  const [diffCacheTick, setDiffCacheTick] = useState(0);
  useEffect(() => {
    if (!diff || conflictMode) return;
    const prefix = `${worktreePath}\t`;
    const suffix = `\t${revision}`;
    for (const key of [...fileDiffCache.keys()]) {
      if (key.startsWith(prefix) && !key.endsWith(suffix)) fileDiffCache.delete(key);
    }
    let cancelled = false;
    const queue = diff.files.filter((file) => !isImagePath(file.path));
    let index = 0;
    const worker = async () => {
      while (index < queue.length && !cancelled) {
        const file = queue[index++];
        const key = fileDiffCacheKey(worktreePath, file.path, revision);
        if (fileDiffCache.has(key)) continue;
        try {
          const text = await invoke<string>("workspace_file_diff", {
            worktreePath,
            path: file.path,
          });
          if (cancelled) return;
          fileDiffCache.set(key, { text, rows: parseDiff(text) });
          setDiffCacheTick((tick) => tick + 1);
        } catch {
          /* 点开时再拉 */
        }
      }
    };
    void Promise.all([worker(), worker(), worker()]);
    return () => {
      cancelled = true;
    };
  }, [conflictMode, diff, revision, worktreePath]);
  const screeningReview = reviewProfile.kind === "screening";
  const paneTabs = reviewPaneTabs(
    reviewProfile.kind,
    (diff?.files ?? []).map((file) => file.path),
  );
  const contentReview = Boolean(paneTabs) && !conflictMode && !health?.conflict;
  const contentReady = !opening && contentReview && diff != null;
  const showGitFiles = contentReady && reviewPane === "files";
  const deliveryPaths =
    reviewPane === "process"
      ? deliveryProcessPaths(displayedPaths)
      : deliveryContentPaths(displayedPaths);
  /** 固定副本里剔掉稿件脚手架：它们随「保存进项目」一起带回，但不是给人看的产物。
   *  「非 Git 产物」那条清单按这份算，不能按 deliveryReview.files 原样算——
   *  否则会标出一个「0 项」的条，看着像坏了。 */
  const deliveryFiles = useMemo(
    () =>
      (deliveryReview?.files ?? []).filter(
        (file) => !isManuscriptScaffold(file.path),
      ),
    [deliveryReview],
  );

  useEffect(() => {
    if (displayedPaths.length === 0) return;
    if (reviewProfile.hideListDiffs) {
      if (activePath && !displayedPaths.includes(activePath)) setActivePath(null);
      return;
    }
    if (activePath && displayedPaths.includes(activePath)) return;
    const preferred =
      reviewProfile.kind === "files"
        ? preferredDeliveryPath(displayedPaths)
        : displayedPaths[0];
    setActivePath(preferred ?? displayedPaths[0]);
  }, [activePath, displayedPaths, reviewProfile.hideListDiffs, reviewProfile.kind]);

  const registerSection = useCallback(
    (path: string, element: HTMLElement | null) => {
      if (element) sectionRefs.current.set(path, element);
      else sectionRefs.current.delete(path);
    },
    [],
  );

  function selectFile(path: string) {
    setActivePath(path);
    suppressTrackRef.current = true;
    if (suppressTrackTimerRef.current !== null)
      window.clearTimeout(suppressTrackTimerRef.current);
    suppressTrackTimerRef.current = window.setTimeout(() => {
      suppressTrackRef.current = false;
      suppressTrackTimerRef.current = null;
    }, 600);
    if (!reviewProfile.groupFiles) {
      sectionRefs.current
        .get(path)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  const trackActiveFile = useCallback(() => {
    if (suppressTrackRef.current) return;
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const host = reviewMainRef.current;
      if (!host) return;
      const threshold = host.getBoundingClientRect().top + 56;
      let next: string | null = null;
      for (const [path, element] of sectionRefs.current) {
        const top = element.getBoundingClientRect().top;
        if (top <= threshold) next = path;
        else if (!next) {
          next = path;
          break;
        }
      }
      if (next) setActivePath((current) => (current === next ? current : next));
    });
  }, []);

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null)
        window.cancelAnimationFrame(scrollFrameRef.current);
      if (suppressTrackTimerRef.current !== null)
        window.clearTimeout(suppressTrackTimerRef.current);
    },
    [],
  );

  function retryConflictContent(path: string) {
    setConflictContentErrors((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    setConflictContents((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
  }

  async function startConflictResolution(restart = false) {
    if (!diff) return;
    if (
      restart &&
      !(await confirmDialog(
        `${diff.baseBranch} 已在冲突开始后更新。重新同步会放弃当前尚未提交的选边结果，并用最新 ${diff.baseBranch} 重新生成冲突。继续？`,
        { danger: true },
      ))
    ) {
      return;
    }
    setConflictBusy(true);
    setFinishMenu(null);
    setError(null);
    setResult(null);
    // 新一轮同步（restart，或从非 MERGING 状态首次进入）一律清掉上一轮
    // 选边与两侧内容，避免把上一轮的选边徽标带进新冲突
    if (restart || !unmerged?.merging) {
      setConflictFiles([]);
      setConflictContents({});
      setConflictContentErrors({});
      setConflictChoices({});
      setConflictAdvice({});
    }
    try {
      const output = await invoke<string>("workspace_sync_base", {
        id: diff.workspaceId,
        restart,
      });
      setResult(output);
    } catch (reason) {
      const state = await invoke<UnmergedDto>("workspace_unmerged_files", {
        id: diff.workspaceId,
      }).catch(() => null);
      if (!state?.merging) {
        setError(String(reason));
        return;
      }
      setUnmerged(state);
      setConflictFiles(state.files);
      setResult(
        `冲突已放在隔离工作区中，请逐个比较 ${diff.branch} 与 ${diff.baseBranch} 后选定版本`,
      );
    } finally {
      await refresh(true);
      setConflictBusy(false);
    }
  }

  async function chooseConflict(path: string, choice: ConflictChoice) {
    if (!diff) return;
    setConflictBusy(true);
    setError(null);
    try {
      const state = await invoke<UnmergedDto>("workspace_resolve_file", {
        id: diff.workspaceId,
        path,
        side: choice,
      });
      setUnmerged(state);
      setConflictChoices((current) => ({ ...current, [path]: choice }));
      await refresh(true);
    } catch (reason) {
      setError(String(reason));
      await refresh(true);
    } finally {
      setConflictBusy(false);
    }
  }

  async function chooseAll(choice: ConflictChoice) {
    if (!diff || unresolvedFiles.length === 0) return;
    if (
      choice === "theirs" &&
      !(await confirmDialog(
        `将全部冲突文件改为 ${diff.baseBranch} 版本，任务分支对应改动会被放弃。继续？`,
        { danger: true },
      ))
    )
      return;
    setConflictBusy(true);
    setError(null);
    try {
      let state = unmerged;
      for (const path of unresolvedFiles) {
        state = await invoke<UnmergedDto>("workspace_resolve_file", {
          id: diff.workspaceId,
          path,
          side: choice,
        });
        // 逐条更新选边，中途失败时已解决的文件仍保留徽标
        setConflictChoices((current) => ({ ...current, [path]: choice }));
      }
      setUnmerged(state);
      await refresh(true);
    } catch (reason) {
      setError(String(reason));
      await refresh(true);
    } finally {
      setConflictBusy(false);
    }
  }

  async function requestConflictAdvice() {
    if (!diff) return;
    setAdviceBusy(true);
    setError(null);
    try {
      const list = await invoke<ConflictAdviceDto[]>("ai_conflict_advice", {
        id: diff.workspaceId,
      });
      setConflictAdvice(
        Object.fromEntries(list.map((item) => [item.path, item])),
      );
    } catch (reason) {
      setError(`${reason}（AI 只给建议，不会自动选择版本）`);
    } finally {
      setAdviceBusy(false);
    }
  }

  async function applyConflictAdvice() {
    if (!diff) return;
    const choices = unresolvedFiles
      .map((path) => [path, conflictAdvice[path]?.choice] as const)
      .filter(
        (entry): entry is readonly [string, ConflictChoice] =>
          entry[1] === "ours" || entry[1] === "theirs",
      );
    if (choices.length === 0) return;
    setConflictBusy(true);
    setError(null);
    try {
      let state = unmerged;
      for (const [path, choice] of choices) {
        state = await invoke<UnmergedDto>("workspace_resolve_file", {
          id: diff.workspaceId,
          path,
          side: choice,
        });
        // 逐条更新选边，中途失败时已解决的文件仍保留徽标
        setConflictChoices((current) => ({ ...current, [path]: choice }));
      }
      setUnmerged(state);
      await refresh(true);
    } catch (reason) {
      setError(String(reason));
      await refresh(true);
    } finally {
      setConflictBusy(false);
    }
  }

  /** 健康复查 + 保存进项目（merge_workspace）+ 成功态收尾；失败抛错由调用方渲染。
   *  finish 与冲突解决共用这一个重发体。
   *  healthFail 把健康未过的原因包装成各入口自己的话术；committedHash 供 finish 在
   *  复查通过后冻结新评审基线（与旧内联顺序一致）。 */
  async function mergeIntoProject(
    archive: boolean,
    opts: {
      healthFail: (reasons: string) => string;
      committedHash?: string | null;
    },
  ): Promise<WorkspaceMergeResultDto> {
    if (!diff) throw new Error("工作区数据未加载");
    const latest = await invoke<WorkspaceHealthDto>("workspace_health", {
      id: diff.workspaceId,
    });
    if (!latest.readyToMerge) {
      const reasons = blockerText(latest);
      if (latest.uncommitted) reasons.unshift("任务里还有没保存的改动");
      throw new Error(opts.healthFail(reasons.join("；") || "健康检查未通过"));
    }
    if (opts.committedHash) {
      reviewedShaRef.current = reviewedShaAfterCommit(
        opts.committedHash,
        latest.worktreeHead,
      );
    }
    const merged = await invoke<WorkspaceMergeResultDto>("merge_workspace", {
      id: diff.workspaceId,
      archive,
      expectDeliveryToken: deliveryReviewRef.current?.token ?? null,
      ...gitAdmissionPayload({
        retry: false,
        reviewedSha:
          reviewedShaRef.current ??
          latest.worktreeHead ??
          health?.worktreeHead ??
          null,
      }),
    });
    setDeliveryFollowup(deliveryFollowupText(merged.salvage));
    if (merged.failedPhase) throw new Error(merged.message);
    if (merged.merged && merged.ledgerWritten === false) {
      setLedgerPending(true);
      setMergeDone(true);
      setMergeVersionId(merged.versionId ?? null);
      setError(null);
      setResult(null);
      return merged;
    }
    setLedgerPending(false);
    setMergeVersionId(merged.versionId ?? null);
    setResult(merged.message);
    setMergedAt(new Date().toISOString());
    setMergeDone(true);
    setConflictFiles([]);
    setConflictContents({});
    setConflictContentErrors({});
    setConflictChoices({});
    setConflictAdvice({});
    return merged;
  }

  async function finishConflict(mergeAfter: boolean) {
    if (!diff) return;
    if (mergeAfter && !deliveryReviewRef.current) { setError(REVIEW_SAVE.needDelivery); return; }
    if (unresolvedFiles.length > 0) {
      setError(`还有 ${unresolvedFiles.length} 个冲突文件未选择版本`);
      return;
    }
    if (
      mergeAfter &&
      !(await confirmDialog(
        `将提交冲突解决结果并保存进项目，工作区保留且不推送。继续？`,
      ))
    )
      return;
    setConflictBusy(true);
    setError(null);
    setResult(null);
    setMergeDone(false);
    let resolvedCommitted = false;
    try {
      await invoke<string>("workspace_finish_merge", { id: diff.workspaceId });
      resolvedCommitted = true;
      if (!mergeAfter) {
        setResult("冲突解决结果已提交，可稍后继续审阅并保存进项目");
        await refresh();
        return;
      }
      await mergeIntoProject(false, {
        healthFail: (reasons) => reasons,
      });
      await refresh();
    } catch (reason) {
      const raw = String(reason);
      const prefix = resolvedCommitted
        ? "解决结果已提交，但尚未保存进项目："
        : "";
      setError(`${prefix}${raw}`);
      await refresh(true);
    } finally {
      setConflictBusy(false);
    }
  }

  async function generateMessage() {
    setAiBusy(true);
    setError(null);
    try {
      setMessage(
        (
          await invoke<string>("ai_commit_message", { cwd: worktreePath })
        ).trim(),
      );
    } catch (reason) {
      setError(`${reason}（检查设置页「AI 专用配置」是否可用）`);
    } finally {
      setAiBusy(false);
    }
  }

  async function draftPr() {
    if (!diff) return;
    if (
      prBody.trim() &&
      !(await confirmDialog("将用 AI 起草覆盖当前 PR 描述，继续？", {
        danger: true,
      }))
    )
      return;
    setPrDrafting(true);
    setError(null);
    try {
      setPrBody(await invoke<string>("ai_draft_pr", { id: diff.workspaceId }));
    } catch (reason) {
      setError(`${reason}（检查设置页“AI 专用配置”是否可用）`);
    } finally {
      setPrDrafting(false);
    }
  }

  async function submitPr() {
    if (!diff || !prTitle.trim()) return;
    setPrBusy(true);
    setError(null);
    try {
      const created = await invoke<WorkspacePrResultDto>("create_pr", {
        id: diff.workspaceId,
        title: prTitle.trim(),
        body: prBody.trim() || null,
        skipPush: prPushed,
      });
      setPrPushed(created.pushed);
      if (created.prCreated && created.prUrl) {
        setPrUrl(created.prUrl);
        setResult("PR 已创建");
      } else {
        setError(created.message);
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPrBusy(false);
    }
  }

  function closePrDialog() {
    setPrOpen(false);
    setPrBody("");
    setPrPushed(false);
    setPrUrl(null);
    setPrCopied(false);
  }

  async function finish(mode: FinishMode) {
    if (readOnlyRunReview) {
      setError(REVIEW_SAVE.readonlyRun);
      return;
    }
    if (!diff || !status || !health) return;
    const shouldCommit = status.files.length > 0;
    const shouldMerge = mode === "merge" || mode === "merge-archive";
    if (shouldMerge && !deliveryReviewRef.current) { setError(REVIEW_SAVE.needDelivery); return; }
    const shouldArchive = mode === "archive";
    const archive = mode === "merge-archive";
    // 提交信息可留空（v3.97，面向不懂编程的用户）：留空走本地规则默认信息
    // （chore: 更新 N 个文件），与主仓快速提交面板同口径；想写更好的点输入框旁 ◈ 让 AI 起草
    const commitMessage =
      message.trim() || defaultCommitMessage(status.files);
    if (
      shouldMerge &&
      !(await confirmDialog(
        REVIEW_SAVE.confirmSave(shouldCommit, archive),
      ))
    ) {
      return;
    }
    if (
      shouldArchive &&
      !archiveOpen &&
      !(await confirmDialog(
        `${shouldCommit ? "将提交当前全部改动，然后" : "将"}归档工作区。worktree 会被移除，分支仍保留以便恢复。继续？`,
      ))
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    setMergeDone(false);
    let committed = false;
    let committedHash: string | null = null;
    try {
      if (shouldCommit) {
        const commitResult = await invoke<GitCommitResultDto>("git_commit", {
          cwd: worktreePath,
          message: commitMessage,
          push: false,
        });
        if (!commitResult.committed) throw new Error(commitResult.message);
        committed = true;
        committedHash = commitResult.hash;
        setMessage("");
      }
      if (shouldMerge) {
        const mergeResult = await mergeIntoProject(archive, {
          healthFail: (reasons) => REVIEW_SAVE.cannotSaveYet(reasons),
          committedHash: committed ? committedHash : null,
        });
        if (mergeResult.archived) {
          onClose();
          return;
        }
      } else if (shouldArchive) {
        await invoke("archive_workspace", { id: diff.workspaceId });
        setResult("工作区已归档，分支仍可恢复");
        onClose();
        return;
      } else {
        setResult("改动已提交，可继续审阅或稍后保存进项目");
      }
      await refresh();
    } catch (reason) {
      const raw = String(reason);
      const prefix =
        committed && !raw.includes("提交已完成") ? "提交已完成；" : "";
      setError(`${prefix}${raw}`);
      await refresh(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-surface="canvas" className="absolute inset-0 z-30 flex min-h-0 flex-col bg-canvas">
      <header className="shrink-0 border-b border-hairline bg-strip">
        <div className="flex h-12 items-center gap-3 px-3">
          <button
            type="button"
            onClick={onClose}
            title="返回"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-l3 hover:bg-hover hover:text-l1"
          >
            <ArrowLeft aria-hidden="true" className="h-4 w-4" />
          </button>
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-sm font-medium text-l1">
              {conflictMode || health?.conflict ? "解决冲突" : "审阅"}
            </span>
            <span className="text-l4">/</span>
            <span className="truncate text-sm text-l2">
              {diff?.workspaceName ?? "加载中"}
            </span>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setReviewRailOpen((open) => !open)}
              aria-expanded={reviewRailOpen}
              aria-label={reviewRailOpen ? "收起文件列表" : "打开文件列表"}
              className="flex h-8 items-center gap-1.5 rounded-sm px-2 text-xs text-l3 hover:bg-hover hover:text-l1"
            >
              <File aria-hidden="true" className="h-3.5 w-3.5" />
              {reviewRailOpen ? "收起文件" : "文件列表"}
            </button>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={refreshing || busy || conflictBusy}
              title="刷新审阅数据"
              className="flex h-8 w-8 items-center justify-center rounded-sm text-l3 hover:bg-hover hover:text-l1 disabled:opacity-50"
            >
              <RefreshCw
                aria-hidden="true"
                className={["h-4 w-4", refreshing ? "animate-spin" : ""].join(
                  " ",
                )}
              />
            </button>

            {diff && health?.conflict && !conflictMode ? (
              <button
                type="button"
                onClick={() =>
                  hasUncommitted
                    ? void finish("commit")
                    : void startConflictResolution()
                }
                disabled={
                  conflictBusy || busy || (hasUncommitted && !message.trim())
                }
                title="两边改了同一个地方，需要你逐个文件选一边"
                className="rounded-sm border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
              >
                {busy || conflictBusy
                  ? "处理中…"
                  : hasUncommitted
                    ? "先提交改动"
                    : "开始解决冲突"}
              </button>
            ) : conflictMode ? (
              staleBase ? (
                <button
                  type="button"
                  onClick={() => void startConflictResolution(true)}
                  disabled={conflictBusy}
                  className="rounded-sm border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
                >
                  {conflictBusy
                    ? "重新同步中…"
                    : `重新同步最新 ${diff?.baseBranch ?? "主分支"}`}
                </button>
              ) : (
                <div className="flex">
                  <button
                    type="button"
                    onClick={() => void finishConflict(true)}
                    disabled={conflictBusy || unresolvedFiles.length > 0}
                    className="min-w-36 rounded-l border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
                  >
                    {conflictBusy ? (
                      "处理中…"
                    ) : unresolvedFiles.length > 0 ? (
                      <>还剩 {unresolvedFiles.length} 个冲突</>
                    ) : (
                      REVIEW_SAVE.finishConflict
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      setFinishMenu({
                        x: rect.right - 190,
                        y: rect.bottom + 4,
                      });
                    }}
                    disabled={conflictBusy || unresolvedFiles.length > 0}
                    title="更多完成方式"
                    className="flex w-8 items-center justify-center rounded-r border-y border-r border-cta-bd bg-cta text-cta-text hover:brightness-110 disabled:opacity-50"
                  >
                    <ChevronDown aria-hidden="true" className="h-4 w-4" />
                  </button>
                </div>
              )
            ) : (
              <div className="flex">
                <button
                  type="button"
                  onClick={() => void finish("merge")}
                  disabled={!canPrimary}
                  title={hardBlocked ? blockerPrimaryText(blockers) : undefined}
                  className="min-w-32 rounded-l border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
                >
                  {busy ? "处理中…" : primaryLabel}
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setFinishMenu({ x: rect.right - 190, y: rect.bottom + 4 });
                  }}
                  disabled={busy}
                  title="更多完成方式"
                  className="flex w-8 items-center justify-center rounded-r border-y border-r border-cta-bd bg-cta text-cta-text hover:brightness-110 disabled:opacity-50"
                >
                  <ChevronDown aria-hidden="true" className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        </div>

        {diff && (
          <div className="flex min-h-9 items-center gap-3 border-t border-hairline px-3 py-1.5 text-xs">
            <div className="flex min-w-0 items-center gap-2 text-l3">
              {reviewProfile.headerHint ? (
                <span className="text-l2">
                  {reviewProfile.kind === "screening" ? filteredFiles.length : diff.files.length} 个文件 · {reviewProfile.headerHint}
                </span>
              ) : (
                <>
              <GitBranch aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              <span className="max-w-44 truncate font-mono text-l2">
                {diff.branch}
              </span>
              <span className="text-l4">→</span>
              <span className="max-w-32 truncate font-mono">
                {diff.baseBranch}
              </span>
              <span className="ml-1 text-l4">
                {reviewProfile.kind === "screening" ? filteredFiles.length : diff.files.length} 个文件
              </span>
              <span className="font-mono text-add">+{diff.totalAdd}</span>
              <span className="font-mono text-del">-{diff.totalDel}</span>
              {health && (health.ahead > 0 || health.behind > 0) && (
                <span
                  className="font-mono text-l4"
                  title={`相对主分支：领先 ${health.ahead} · 落后 ${health.behind}`}
                >
                  {health.ahead > 0 && `多出 ${health.ahead} 个保存点`}
                  {health.ahead > 0 && health.behind > 0 && " · "}
                  {health.behind > 0 && `主分支新增 ${health.behind} 个保存点`}
                </span>
              )}
                </>
              )}
            </div>

            {conflictMode ? (
              <div className="ml-auto flex shrink-0 flex-col gap-0.5">
                <div className="flex items-center gap-1.5">
                <span className="mr-1 text-l4">
                  {conflictFiles.length - unresolvedFiles.length}/
                  {conflictFiles.length} 已选择
                </span>
                <button
                  type="button"
                  onClick={() => void chooseAll("ours")}
                  disabled={
                    staleBase ||
                    conflictBusy ||
                    unresolvedFiles.length === 0 ||
                    !allConflictContentsLoaded
                  }
                  className="rounded-sm border border-field bg-inset px-2 py-1 text-l2 hover:bg-seg-sel hover:text-l1 disabled:opacity-50"
                >
                  全部任务版
                </button>
                <button
                  type="button"
                  onClick={() => void chooseAll("theirs")}
                  disabled={
                    staleBase ||
                    conflictBusy ||
                    unresolvedFiles.length === 0 ||
                    !allConflictContentsLoaded
                  }
                  className="rounded-sm border border-field bg-inset px-2 py-1 text-l2 hover:bg-seg-sel hover:text-l1 disabled:opacity-50"
                >
                  全部 {diff.baseBranch}
                </button>
                {/* ◈ AI 建议提级为主按钮：不确定选哪边时的推荐路径；逻辑不变，只提呈现层级 */}
                <button
                  type="button"
                  onClick={() => void requestConflictAdvice()}
                  disabled={
                    staleBase ||
                    adviceBusy ||
                    conflictBusy ||
                    unresolvedFiles.length === 0
                  }
                  className="rounded-sm border border-cta-bd bg-cta px-2 py-1 text-cta-text hover:brightness-110 disabled:opacity-50"
                >
                  {adviceBusy ? "◈ 分析中…" : "◈ AI 建议"}
                </button>
                {Object.keys(conflictAdvice).length > 0 && (
                  <button
                    type="button"
                    onClick={() => void applyConflictAdvice()}
                    disabled={
                      staleBase || conflictBusy || !allConflictContentsLoaded
                    }
                    className="rounded-sm border border-cta-bd bg-cta px-2 py-1 text-cta-text hover:brightness-110 disabled:opacity-50"
                  >
                    按建议选择
                  </button>
                )}
                </div>
                <span className="text-micro text-l4">
                  不确定选哪边时可让 AI 按上下文建议；仍可逐文件手动改选
                </span>
              </div>
            ) : hasUncommitted ? (
              <div className="ml-auto flex w-[360px] shrink-0 flex-col gap-0.5">
                <div className="flex items-center gap-1.5">
                  <input
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && canPrimary)
                        void finish("merge");
                    }}
                    disabled={busy}
                    placeholder="这次改了什么（可留空，自动写一句）"
                    className="min-w-0 flex-1 rounded-sm border border-field bg-canvas px-2 py-1 text-xs text-l2 outline-none placeholder:text-l4 focus:border-l4"
                  />
                  <button
                    type="button"
                    onClick={() => void generateMessage()}
                    disabled={aiBusy || busy}
                    title="让 AI 看改动内容写一句；不写也行——留空会自动写「更新 N 个文件」"
                    className="flex h-7 min-w-7 items-center justify-center rounded-sm px-1.5 text-l2 hover:bg-hover disabled:opacity-50"
                  >
                    {aiBusy ? "◈…" : "◈"}
                  </button>
                </div>
              </div>
            ) : (
              <span
                title={REVIEW_SAVE.localOnlyHint}
                className="ml-auto flex h-7 w-7 items-center justify-center rounded-sm text-l4"
              >
                ⓘ
              </span>
            )}
          </div>
        )}

        {/* 可信度行：引用解析（bib 对照）+ 产物核验摘要 + 人工事项收尾提醒。
            无 bib/全文无引用/无预期产物/无收尾事项时不渲染，不给非写作类项目添噪声；
            数据进评审时一次性读取，失败静默降级；收尾事项只提醒不阻断合并 */}
        {diff &&
          (contentReview ||
            (citations && citations.bibFound && citations.totalRefs > 0) ||
            (artifacts && artifacts.total > 0) ||
            (humanClosing && humanClosing.length > 0)) && (
            <div className="border-t border-hairline px-3 py-1.5 text-xs">
              <div className="flex min-h-6 items-center gap-3">
                <span className="shrink-0 text-l4" title="仅检查引用键和产物；不验证内容正确性或结论是否成立">基础检查</span>
                {citations && citations.bibFound && citations.totalRefs > 0 && (
                  <button
                    type="button"
                    disabled={citations.missing.length === 0}
                    onClick={() => setCiteExpanded((v) => !v)}
                    title={
                      citations.missing.length > 0
                        ? "点击查看缺失的引用键"
                        : "文中引用键均能在 references.bib 中找到"
                    }
                    className={`shrink-0 rounded-sm px-1 ${
                      citations.missing.length > 0
                        ? "text-warn-text hover:bg-hover"
                        : "text-l3"
                    } disabled:cursor-default`}
                  >
                    引用 {citations.resolved}/{citations.totalRefs} 可解析
                    {citations.missing.length > 0 &&
                      `（缺 ${citations.missing.length}）`}
                  </button>
                )}
                {artifacts && artifacts.total > 0 && (
                  <span
                    className={`shrink-0 ${
                      artifacts.produced < artifacts.total
                        ? "text-warn-text"
                        : "text-l3"
                    }`}
                  >
                    产物 {artifacts.produced}/{artifacts.total} 已产出
                  </span>
                )}
                {humanClosing && humanClosing.length > 0 && (
                  <span
                    className="min-w-0 truncate text-warn-text"
                    title={`收尾人工事项未完成：${humanClosing.join("、")}`}
                  >
                    收尾：{humanClosing.join("、")}
                  </span>
                )}
                {writingHits.length > 0 && (
                  <span
                    className="min-w-0 truncate text-warn-text"
                    title={writingHits.map((hit) => hit.label).join("；")}
                  >
                    审阅时核对：{writingHits.map((hit) => hit.label).join("；")}
                  </span>
                )}
                {contentReview && paneTabs && (
                  <div className="ml-auto flex shrink-0 gap-1">
                    {paneTabs.map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setReviewPane(tab.id)}
                        className={`rounded-sm px-2 py-0.5 ${
                          reviewPane === tab.id
                            ? "bg-rail-sel text-l1"
                            : "text-l3 hover:text-l1"
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {reviewProfile.showReportDisclaimer && (
              <p className="mt-1 text-micro text-l4">文件已产出、引用键可解析不代表内容已通过审查；接受改动前仍须核对证据与未决事项。</p>
              )}
              {citeExpanded && citations && citations.missing.length > 0 && (
                <p className="mt-1 break-all font-mono text-micro text-warn-text">
                  缺失引用键：{citations.missing.join("、")}
                </p>
              )}
              {contentReview && !mergeDone && (
                <div className="mt-2 border-t border-hairline pt-2">
                  <p className="mb-1 text-micro text-l4">
                    写下意见，或在稿件里划一段点「加进意见」。退回后交给 Agent。不会保存进项目。
                  </p>
                  <textarea
                    value={reviewNotes}
                    onChange={(e) => setReviewNotes(e.target.value)}
                    rows={3}
                    placeholder="例如：摘要去掉未核实句；删 G1；空图改成见 Fig.n；不要凑字数。"
                    className="w-full resize-y rounded-sm border border-field bg-canvas px-2 py-1.5 text-xs text-l2 outline-none placeholder:text-l4 focus:border-l4"
                  />
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={returnBusy || !wsRow}
                      onClick={() => void returnToAgent(false)}
                      className="rounded-sm border border-field px-2 py-1 text-xs text-l2 hover:bg-hover disabled:opacity-50"
                    >
                      {returnBusy ? "交接中…" : "退回修改"}
                    </button>
                    <button
                      type="button"
                      disabled={returnBusy || !wsRow}
                      onClick={() => void returnToAgent(true)}
                      className="rounded-sm border border-field px-2 py-1 text-xs text-l2 hover:bg-hover disabled:opacity-50"
                    >
                      按意见重写
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        {diff && !conflictMode && blockers.length > 0 && (
          <div className="border-t border-hairline bg-inset px-3 py-1.5 text-xs text-warn-text">
            <div className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn-text" />
              <span className="min-w-0 flex-1">{blockerPrimaryText(blockers)}</span>
              {blockers.some((b) => b.key === "main-dirty") && repoPath && (
                <button
                  type="button"
                  onClick={() => setMainCommitOpen((value) => !value)}
                  className="rounded-sm px-2 py-0.5 text-warn-text hover:bg-hover"
                >
                  {mainCommitOpen ? "收起提交面板" : "提交主文件夹的改动…"}
                </button>
              )}
              {blockers.length > 1 && (
                <button
                  type="button"
                  onClick={() => setShowBlockers((value) => !value)}
                  className="rounded-sm px-2 py-0.5 text-warn-text hover:bg-hover"
                >
                  {showBlockers ? "收起" : "全部"}
                </button>
              )}
            </div>
            {(showBlockers || mainCommitOpen) && (
              <div className="mt-1.5 border-t border-hairline pt-1.5 text-l3">
                {showBlockers && (
                  <ul className="space-y-1">
                    {blockers.map((blocker) => (
                      <li key={blocker.key}>• {blocker.text}</li>
                    ))}
                    {health?.conflict && health.conflictFiles.length > 0 && (
                      <li>• 冲突文件：{health.conflictFiles.join("、")}</li>
                    )}
                  </ul>
                )}
                {blockers.some((b) => b.key === "main-dirty") && (
                  <p className="text-micro text-l4">
                    提交 = 把主文件夹改动保存到项目主线历史；文件本身不会丢，保存后才能继续保存进项目。
                  </p>
                )}
                {mainCommitOpen && repoPath && (
                  <MainRepoCommitPanel
                    repoPath={repoPath}
                    onCommitted={() => {
                      setMainCommitOpen(false);
                      setResult("主文件夹的改动已保存到项目历史");
                      void refresh();
                    }}
                    onCancel={() => setMainCommitOpen(false)}
                  />
                )}
              </div>
            )}
          </div>
        )}
      </header>

      {!diff?.reviewOnly && deliveryError && <p role="alert" className="px-3 py-2 text-xs text-err-text">非 Git 产物未能冻结：{deliveryError}。请刷新评审后再保存进项目。</p>}
      {/* 固定副本清单：点条目看的就是「保存进项目」会带回的那一版。
          它有唯一的触发按钮（下面这条 button 的 onClick），删了这段预览弹窗就成死代码。
          可见口径按「哪些步骤整页显示、哪些只在『文件』页签里显示」定：
          检索/精读/写作一直是页签化的，贴在文件树上方看；没有页签的步骤整页显示。
          验收（acceptance）本来没有页签、整页显示，这次重构才给它加了「结果/过程/文件」——
          若按 showGitFiles 走，它会在打开时的「结果」页签上凭空消失，
          而「保存进项目」按钮在顶栏、每个页签都在，清单不该跟着页签隐掉。 */}
      {!diff?.reviewOnly && (showGitFiles || !paneTabs || reviewProfile.kind === "acceptance") && deliveryFiles.length > 0 && <section aria-label="非 Git 产物评审" className="max-h-48 shrink-0 overflow-auto border-b border-hairline px-3 py-2 text-xs">
        <h3 className="font-medium">非 Git 产物 · {deliveryFiles.length} 项</h3>
        <p className="text-micro text-l3">保存进项目只带回这版固定副本。看过后内容变化会要求重看；同名冲突不覆盖，未接收文件保留在工作区。</p>
        <ul>{deliveryFiles.map((file) => <li key={file.path} className="flex gap-2 py-0.5">
          <button type="button" className="min-w-0 flex-1 truncate text-left text-l2 hover:underline disabled:text-l4" disabled={file.disposition !== "copy"} onClick={() => setDeliveryPreview(file.path)}>{file.path}</button>
          <span className="shrink-0 text-micro text-l3">{file.disposition === "copy" ? `${(file.size / 1024).toFixed(1)} KB · ${file.sha256?.slice(0, 8)}` : file.disposition === "conflict" ? "同名存在，不覆盖" : file.disposition === "protected" ? "保护路径跳过" : file.disposition === "too_large" ? "超出冻结预算" : "随 Git 提交"}</span>
        </li>)}</ul>
      </section>}
      {deliveryPreview && deliveryReview && <Suspense fallback={<p className="px-3 py-2 text-xs text-l3">加载固定副本预览…</p>}><OfficePreviewModal path={`${deliveryReview.payloadDir}/${deliveryPreview}`} root={deliveryReview.payloadDir} onClose={() => setDeliveryPreview(null)} /></Suspense>}
      {!diff?.reviewOnly && researchError && <p role="alert" className="px-3 py-2 text-xs text-err-text">{researchError}</p>}
      {!diff?.reviewOnly && researchContext?.root === worktreePath && reviewProfile.kind === "acceptance" && reviewPane === "content" && <div className="max-h-[42vh] shrink-0 overflow-y-auto border-b border-hairline px-3">
        {reviewProfile.evidence === "report" && (
          <ResearchEvidencePanel root={worktreePath} patterns={researchReportPatterns(researchContext.step, "acceptance")} kind="acceptance" />
        )}
        {reviewProfile.showReproduction && researchContext.hasReproduction &&
          <ResearchReproductionPanel key={`${worktreePath}:${researchContext.workspace.id}`} workspace={researchContext.workspace} step={researchContext.step} artifactDir={researchContext.artifactDir} onLaunched={onClose} onRun={(record) => setResearchRunId(record.id)} />}
        {reviewProfile.acceptance === "default" && (
          <ResearchAcceptancePanel workspace={researchContext.workspace} step={researchContext.step} runId={researchRunId} />
        )}
      </div>}

      {/* 上游漂移提醒（启发式，只提醒不阻断）：上游步骤晚于本步最后推进时间合并，
          本步合并后（merged_at 推进）自然恢复新鲜 */}
      {staleUpstream && !mergeDone && (
        <div className="flex shrink-0 items-center gap-2 border-b border-hairline bg-inset px-3 py-1.5 text-xs text-warn-text">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn-text" />
          <span>上游「{staleUpstream}」有更新，产物可能过期</span>
        </div>
      )}

      {diff && conflictMode && staleBase && (
        <div className="flex shrink-0 items-center gap-2 border-b border-hairline bg-inset px-3 py-1.5 text-xs text-warn-text">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn-text" />
          <span>
            {diff.baseBranch}{" "}
            已在本次冲突开始后更新；旧的基准侧已停止显示，请从右上角重新同步。
            两边改了同一个地方，同步后逐个文件选一边即可。
          </span>
        </div>
      )}
      {readOnlyRunReview && (
        <div className="flex flex-wrap items-center gap-2 border-b border-hairline bg-inset px-3 py-2 text-xs text-l3">
          <span className="min-w-0 flex-1">
            这是定时 Run 的只读评审视图：可查看改动和产物证据；不自动写入主仓。
          </span>

        </div>
      )}
      {deliveryFollowup && <p role="status" className="border-b border-hairline px-3 py-2 text-xs text-warn-text">{deliveryFollowup}</p>}
      {ledgerPending && diff && (
        <div className="flex shrink-0 items-center gap-2 border-b border-hairline bg-inset px-3 py-1.5 text-xs text-err-text">
          <span className="min-w-0 truncate">
            ✗ {REVIEW_SAVE.ledgerPending}
          </span>
          <button
            type="button"
            className={secondaryActionClass}
            onClick={() => {
              void invoke<WorkspaceMergeResultDto>("merge_workspace", {
                id: diff.workspaceId,
                archive: false,
                ...gitAdmissionPayload({ retry: true }),
              }).then((merged) => {
                setDeliveryFollowup(deliveryFollowupText(merged.salvage));
                if (merged.ledgerWritten) {
                  setLedgerPending(false);
                  setError(null);
                  setMergeVersionId(merged.versionId ?? mergeVersionId);
                  setResult(merged.message);
                  setMergedAt(new Date().toISOString());
                } else {
                  setError(merged.message);
                }
              }).catch((reason) => setError(String(reason)));
            }}
          >
            继续接收 / 补记验收
          </button>
        </div>
      )}
      {result && !ledgerPending && (
        <div className="flex shrink-0 items-center gap-2 border-b border-hairline bg-inset px-3 py-1.5 text-xs text-ok-text">
          <span
            className="min-w-0 truncate"
            title={mergeDone ? result : undefined}
          >
            ✓ {mergeDone
              ? mergeAdmissionText({
                  ledgerWritten: true,
                  versionId: mergeVersionId,
                })
              : result}
          </span>
          {mergeDone && nextStep && (
            <button
              type="button"
              onClick={() => void goNextStep()}
              title={`到项目页看「${nextStep.step.name}」这一步：流程线、TASK.md、要补的东西都在那里，准备好了点「开始」`}
              className="inline-flex h-7 shrink-0 items-center justify-center rounded-md border border-cta-bd bg-cta px-2 text-xs text-cta-text hover:brightness-110 disabled:opacity-50"
            >
              → 去下一步：{nextStep.step.name}
            </button>
          )}
          {mergeDone && nextStep && (
            <button
              type="button"
              onClick={() => setDistillOpen((v) => !v)}
              title={`把本次评审结论写进「${nextStep.step.name}」的 TASK.md`}
              className="inline-flex h-7 shrink-0 items-center justify-center rounded-md px-2 text-xs text-l2 hover:bg-hover hover:text-l1"
            >
              沉淀到下一步
            </button>
          )}
        </div>
      )}
      {distillOpen && mergeDone && nextStep && (
        <form
          onSubmit={(e) => void submitDistill(e)}
          className="shrink-0 border-b border-hairline bg-inset px-3 py-2"
        >
          {/* AI 初稿供人改，提交才写进任务书草稿（与 DigestPicker「写回简报文件」同一口径） */}
          <div className="mb-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void draftDistill()}
              disabled={distillDrafting || distillBusy}
              title="对照下一步任务书和已验收产物，只起草下一步还没有的约束"
              className="inline-flex h-7 items-center justify-center rounded-md px-2 text-xs text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
            >
              {distillDrafting ? "◈ 起草中…模型还在写" : "◈ AI 起草"}
            </button>
            <span className="min-w-0 flex-1 truncate text-micro text-l4">
              只写下一步任务书里还没有的约束。没有就留空，改完才写进「{nextStep.step.name}」的 TASK.md
            </span>
          </div>
          {distillDraftError && (
            <p className="mb-1.5 text-xs text-err-text">
              ✗ {distillDraftError}
              <button
                type="button"
                onClick={() => void draftDistill()}
                className="ml-2 rounded-sm px-1.5 py-0.5 text-l3 hover:bg-hover hover:text-l1"
              >
                重试
              </button>
            </p>
          )}
          <textarea
            className="w-full rounded-md border border-field bg-canvas px-2 py-1.5 text-sm leading-relaxed text-l2 outline-none placeholder:text-l4 focus:border-l4"
            rows={4}
            placeholder={`只写「${nextStep.step.name}」照自己的任务会改错的决定，以及产物里还没由人确认的事项。没有就留空。`}
            value={distillText}
            onChange={(e) => setDistillText(e.target.value)}
            autoFocus
          />
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="submit"
              disabled={distillBusy || !distillText.trim()}
              className="inline-flex h-7 items-center justify-center rounded-md border border-cta-bd bg-cta px-2 text-xs text-cta-text hover:brightness-110 disabled:opacity-50"
            >
              {distillBusy ? "沉淀中…" : "写进下一步 TASK.md"}
            </button>
            <button
              type="button"
              onClick={() => setDistillOpen(false)}
              className="inline-flex h-7 items-center justify-center rounded-md px-2 text-xs text-l3 hover:bg-hover hover:text-l1"
            >
              取消
            </button>
          </div>
        </form>
      )}
      {distillMsg && (
        <div className="flex shrink-0 items-center gap-2 border-b border-hairline bg-inset px-3 py-1.5 text-xs text-ok-text">
          <span className="min-w-0 truncate">✓ {distillMsg}</span>
        </div>
      )}
      {error && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline bg-inset px-3 py-1.5 text-xs text-err-text">
          <span className="min-w-0 flex-1">✗ {error}</span>
        </div>
      )}

      {loading && !diff ? (
        <div className="mx-auto w-full max-w-3xl px-8 py-8">
          <LoadingRows />
        </div>
      ) : !diff ? (
        <div className="p-6 text-sm text-err-text">
          {error ?? "无法加载工作区审阅数据"}
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col">
        {opening && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-canvas text-sm text-l4">
            正在打开…
          </div>
        )}
        {contentReady && !showGitFiles && screeningReview && reviewPane === "process" && (
          <DeliveryReviewPane
            root={worktreePath}
            paths={["papers/screening.md"]}
            activePath="papers/screening.md"
            onSelect={() => {}}
            empty="还没有筛选记录。"
            onAnnotate={!mergeDone ? addAnnotation : undefined}
          />
        )}
        {contentReady && !showGitFiles && screeningReview && reviewPane !== "process" && researchContext?.root === worktreePath && (
          <div className="min-h-0 flex-1 overflow-auto">
            <ScreeningReviewPanel
              root={worktreePath}
              stepName={researchContext.step.name}
              projectRoot={researchContext.workspace.repoPath}
              onPendingCleared={() => {
                const step = researchContext.step.name;
                const projectRoot = researchContext.workspace.repoPath;
                const title = researchContext.step.humanTasks?.find((task) =>
                  task.title.includes("待确认"),
                )?.title;
                if (!title) return;
                void (async () => {
                  try {
                    const states = await invoke<HumanTaskStateDto[]>("list_human_task_states", {
                      projectRoot,
                    });
                    const task = states.find((row) => row.step === step && row.title === title);
                    if (task?.done || task?.explicitCancel) return;
                    await invoke("set_human_task_check", {
                      projectRoot,
                      step,
                      title,
                      checked: true,
                    });
                  } catch {
                    /* 勾不上时回到步骤卡仍可手勾 */
                  }
                })();
              }}
              pane="list"
              onOpenPdf={(path) => {
                const projectRoot = researchContext.workspace.repoPath;
                setSelectProjectReq(projectRoot);
                setFilePreviewReq({
                  projectRoot,
                  path,
                  token: Date.now(),
                });
                setPage("workspaces");
              }}
            />
          </div>
        )}
        {contentReady && !showGitFiles && reviewProfile.kind === "files" && (
          <DeliveryReviewPane
            root={worktreePath}
            paths={deliveryPaths}
            activePath={activePath}
            onSelect={setActivePath}
            empty={
              reviewPane === "process"
                ? "这一步没有需要看的过程记录。脚本和配置在「文件」。"
                : "没有稿件或笔记。"
            }
            onAnnotate={!mergeDone ? addAnnotation : undefined}
          />
        )}
        <div className={`flex min-h-0 flex-1 ${showGitFiles ? "" : "hidden"}`}>
          {reviewRailOpen && (
            <button
              type="button"
              aria-label="关闭文件列表"
              onClick={() => setReviewRailOpen(false)}
              className="ccode-review-rail-backdrop"
            />
          )}
          <main
            ref={reviewMainRef}
            onScroll={trackActiveFile}
            className="min-w-0 flex-1 overflow-auto bg-canvas"
          >
            {conflictMode ? (
              staleBase ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
                  <p className="text-sm text-l2">
                    当前冲突使用的是旧基准，已暂停展示两侧内容
                  </p>
                  <p className="max-w-xl text-xs text-l4">
                    重新同步后会基于最新 {diff.baseBranch} 生成新的任务版 /
                    基准版对照，避免看到一套内容、实际选择另一套内容。
                  </p>
                  <button
                    type="button"
                    onClick={() => void startConflictResolution(true)}
                    disabled={conflictBusy}
                    className="rounded-sm border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
                  >
                    {conflictBusy
                      ? "重新同步中…"
                      : `重新同步最新 ${diff.baseBranch}`}
                  </button>
                </div>
              ) : conflictFiles.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-l4">
                  正在读取冲突文件…
                </div>
              ) : filteredConflictFiles.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-l4">
                  没有匹配的冲突文件
                </div>
              ) : (
                filteredConflictFiles.map((path) => (
                  <ConflictFileSection
                    key={path}
                    path={path}
                    content={conflictContents[path] ?? null}
                    contentError={conflictContentErrors[path]}
                    branch={diff.branch}
                    baseBranch={diff.baseBranch}
                    unresolved={unresolvedSet.has(path)}
                    choice={conflictChoices[path]}
                    advice={conflictAdvice[path]}
                    busy={conflictBusy || staleBase}
                    register={registerSection}
                    onChoose={(file, choice) =>
                      void chooseConflict(file, choice)
                    }
                    onRetry={retryConflictContent}
                  />
                ))
              )
            ) : health?.conflict ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
                <p className="text-sm text-l2">
                  {hasUncommitted
                    ? "先提交任务改动，再准备最新主分支"
                    : conflictBusy
                      ? `正在同步最新 ${diff.baseBranch}…`
                      : error
                        ? "同步失败，请从右上角重试"
                        : `与 ${diff.baseBranch} 存在冲突，可从右上角开始解决`}
                </p>
                <p className="max-w-xl text-xs text-l4">两边改了同一个地方，需要你逐个文件选一边。</p>
              </div>
            ) : !hasTaskChanges ? (
              <div className="flex h-full items-center justify-center text-sm text-l4">
                当前任务相对 {diff.baseBranch} 没有改动
              </div>
            ) : orderedFiles.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-l4">
                没有匹配的改动文件
              </div>
            ) : stackedFiles.length === 0 ? (
              <div className="flex h-full items-center justify-center px-8 text-center text-sm text-l4">
                纳入清单见上方表格。右侧可打开筛选记录或待获取原文。
              </div>
            ) : (
              stackedFiles.map((file) => (
                <DiffFileSection
                  key={file.path}
                  file={file}
                  worktreePath={diff.worktreePath}
                  revision={revision}
                  register={registerSection}
                  unified={file.status === "A" || file.status === "??"}
                  cached={
                    diffCacheTick >= 0
                      ? fileDiffCache.get(fileDiffCacheKey(worktreePath, file.path, revision)) ?? null
                      : null
                  }
                />
              ))
            )}
          </main>

          <aside
            className={[
              "ccode-review-rail flex w-[292px] shrink-0 flex-col border-l border-hairline bg-rail2",
              reviewRailOpen ? "ccode-review-rail-open" : "hidden",
            ].join(" ")}
          >
            <div className="shrink-0 border-b border-hairline p-3">
              <div className="flex h-8 items-center gap-2 rounded-sm border border-field bg-canvas px-2">
                <Search
                  aria-hidden="true"
                  className="h-3.5 w-3.5 shrink-0 text-l4"
                />
                <input
                  value={fileQuery}
                  onChange={(event) => setFileQuery(event.target.value)}
                  placeholder="筛选文件…"
                  className="min-w-0 flex-1 bg-transparent text-xs text-l2 outline-none placeholder:text-l4"
                />
                {fileQuery && (
                  <button
                    type="button"
                    onClick={() => setFileQuery("")}
                    className="text-l4 hover:text-l2"
                    title="清除筛选"
                  >
                    ×
                  </button>
                )}
              </div>
              <div className="mt-2 flex items-center text-micro text-l4">
                <span>{conflictMode ? "冲突文件" : "改动文件"}</span>
                <span className="ml-auto">
                  {conflictMode
                    ? filteredConflictFiles.length
                    : filteredFiles.length}
                  /{conflictMode ? conflictFiles.length : reviewProfile.kind === "screening" ? filteredFiles.length : diff.files.length}
                </span>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto py-1">
              {conflictMode ? (
                filteredConflictFiles.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-l4">没有匹配文件</p>
                ) : (
                  filteredConflictFiles.map((path) => {
                    const unresolved = unresolvedSet.has(path);
                    const choice = conflictChoices[path];
                    return (
                      <button
                        key={path}
                        type="button"
                        onClick={() => selectFile(path)}
                        title={path}
                        className={[
                          "flex min-h-8 w-full items-center gap-2 border-l-2 px-3 py-1.5 text-left text-xs hover:bg-hover",
                          activePath === path
                            ? "border-cta bg-rail-sel"
                            : "border-transparent",
                        ].join(" ")}
                      >
                        <span
                          className={[
                            "font-mono",
                            unresolved ? "text-err-text" : "text-ok-text",
                          ].join(" ")}
                        >
                          {unresolved ? "U" : "✓"}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-l2">
                          {path}
                        </span>
                        {choice && (
                          <span className="shrink-0 text-l4">
                            {choice === "ours" ? "任务" : diff.baseBranch}
                          </span>
                        )}
                      </button>
                    );
                  })
                )
              ) : tree.length === 0 ? (
                <p className="px-3 py-2 text-xs text-l4">没有匹配文件</p>
              ) : reviewProfile.groupFiles ? (
                <GroupedReviewFiles
                  groups={reviewFileGroups}
                  onSelect={selectFile}
                  activePath={activePath}
                  expandAll={Boolean(normalizedQuery)}
                />
              ) : (
                <ChangeTree
                  nodes={tree}
                  onSelect={selectFile}
                  activePath={activePath}
                />
              )}
            </div>

            <div className="shrink-0 border-t border-hairline bg-strip px-3 py-2 text-micro text-l4">
              {conflictMode ? (
                <div className="flex items-center gap-2">
                  <span
                    className={[
                      "h-1.5 w-1.5 rounded-full",
                      staleBase
                        ? "bg-warn-text"
                        : unresolvedFiles.length
                          ? "bg-err-text"
                          : "bg-ok-text",
                    ].join(" ")}
                  />
                  <span>
                    {staleBase ? (
                      `${diff.baseBranch} 已更新，等待重新同步`
                    ) : unresolvedFiles.length ? (
                      <>还剩 {unresolvedFiles.length} 个文件未选择</>
                    ) : (
                      "全部冲突文件已选择"
                    )}
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span
                    className={[
                      "h-1.5 w-1.5 rounded-full",
                      hardBlocked ? "bg-warn-text" : "bg-ok-text",
                    ].join(" ")}
                  />
                  <span>
                    {hardBlocked ? blockerPrimaryText(blockers) : REVIEW_SAVE.footerReady}
                  </span>
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => setReviewRailOpen(false)}
              className="ccode-review-rail-close"
            >
              关闭文件列表
            </button>
          </aside>
        </div>
        </div>
      )}

      {finishMenu && !staleBase && (
        <ContextMenu
          x={finishMenu.x}
          y={finishMenu.y}
          onClose={() => setFinishMenu(null)}
          items={
            conflictMode
              ? [
                  {
                    label: "仅保存解决结果",
                    onSelect: () => void finishConflict(false),
                  },
                ]
              : [
                  ...(hasUncommitted
                    ? [
                        {
                          label: "仅提交",
                          onSelect: () => void finish("commit"),
                        },
                      ]
                    : []),
                  ...(!hardBlocked
                    ? [
                        {
                          label: REVIEW_SAVE.keepWorkspace,
                          onSelect: () => void finish("merge"),
                        },
                        {
                          label: REVIEW_SAVE.saveAndArchive,
                          onSelect: () => void finish("merge-archive"),
                        },
                      ]
                    : []),
                  ...(hasCommitted
                    ? [{ label: "创建 PR", onSelect: () => setPrOpen(true) }]
                    : []),
                  ...(!health?.conflict && !unmerged?.merging
                    ? [
                        {
                          label: "归档工作区",
                          onSelect: () => setArchiveOpen(true),
                        },
                      ]
                    : []),
                ]
          }
        />
      )}

      {prOpen && diff && (
        <div
          className="fixed inset-0 z-60 flex items-center justify-center bg-black/40 p-4 ccode-fade"
          onClick={() => {
            // 请求在途时不响应遮罩关闭，避免关框重开导致重复建 PR
            if (!prBusy) closePrDialog();
          }}
        >
          <form
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void submitPr();
            }}
            className="w-full max-w-[26rem] rounded-md border border-field ccode-float-surface p-5"
          >
            <h2 className="mb-1 text-base font-semibold text-l1">创建 PR</h2>
            <p
              className="mb-4 truncate font-mono text-xs text-l4"
              title={`${diff.branch} → ${diff.baseBranch}`}
            >
              {diff.branch} → {diff.baseBranch}
            </p>
            {prUrl ? (
              <div className="mb-4">
                <p className="mb-2 text-sm text-ok-text">✓ PR 已创建</p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void openUrl(prUrl)}
                    title={prUrl}
                    className="min-w-0 flex-1 truncate text-left text-sm text-l1 underline decoration-l4 underline-offset-2 hover:decoration-l1"
                  >
                    {prUrl}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(prUrl).then(() => {
                        setPrCopied(true);
                        window.setTimeout(() => setPrCopied(false), 1500);
                      });
                    }}
                    className="shrink-0 rounded-sm px-2 py-0.5 text-xs text-l2 hover:bg-hover"
                  >
                    {prCopied ? "已复制" : "复制"}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <label className="mb-3 block text-sm">
                  <span className="mb-1 block text-xs text-l3">标题</span>
                  <input
                    autoFocus
                    required
                    value={prTitle}
                    onChange={(event) => setPrTitle(event.target.value)}
                    className="w-full rounded-sm border border-field bg-canvas px-2 py-1.5 text-sm text-l2 outline-none placeholder:text-l4 focus:border-l4"
                  />
                </label>
                <label className="mb-4 block text-sm">
                  <span className="mb-1 flex items-center justify-between">
                    <span className="text-xs text-l3">描述</span>
                    <button
                      type="button"
                      onClick={() => void draftPr()}
                      disabled={prDrafting}
                      title="AI 起草 PR 描述"
                      className="rounded-sm px-2 py-0.5 text-xs text-l2 hover:bg-hover disabled:opacity-50"
                    >
                      {prDrafting ? "◈ 起草中…" : "◈ AI 起草"}
                    </button>
                  </span>
                  <textarea
                    value={prBody}
                    onChange={(event) => setPrBody(event.target.value)}
                    placeholder="留空自动生成提交摘要"
                    className="h-24 w-full resize-y rounded-sm border border-field bg-canvas px-2 py-1.5 text-sm text-l2 outline-none placeholder:text-l4 focus:border-l4"
                  />
                </label>
                {error && <p className="mb-3 text-xs text-err-text">{error}</p>}
              </>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={closePrDialog}
                className="rounded-sm px-3 py-1.5 text-sm text-l2 hover:bg-hover"
              >
                {prUrl ? "关闭" : "取消"}
              </button>
              {!prUrl && (
                <button
                  type="submit"
                  disabled={prBusy || !prTitle.trim()}
                  className="rounded-sm border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
                >
                  {prBusy ? "创建中…" : prPushed ? "重试创建 PR" : "创建 PR"}
                </button>
              )}
            </div>
          </form>
        </div>
      )}

      {archiveOpen && diff && (
        <div
          className="fixed inset-0 z-60 flex items-center justify-center bg-black/40 p-4 ccode-fade"
          onClick={() => {
            // 请求在途时不响应遮罩关闭，避免关框重开导致重复提交/归档
            if (!busy) setArchiveOpen(false);
          }}
        >
          <form
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void finish("archive");
            }}
            className="w-full max-w-[26rem] rounded-md border border-field ccode-float-surface p-5"
          >
            <h2 className="mb-2 text-base font-semibold text-l1">
              {hasUncommitted ? "提交并归档" : "归档工作区"}
            </h2>
            <p className="mb-4 text-xs text-l3">
              {hasUncommitted
                ? `先将改动提交到 ${diff.branch}，再移除工作树；分支仍保留以便恢复。`
                : "worktree 会被移除，分支仍保留以便恢复。"}
            </p>
            {hasUncommitted && (
              <label className="mb-4 block">
                <span className="mb-1 block text-xs text-l3">
                  这次改了什么（可留空，自动写一句）
                </span>
                <input
                  autoFocus
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  disabled={busy}
                  placeholder={`chore: 保存 ${diff.workspaceName}`}
                  className="w-full rounded-sm border border-field bg-canvas px-2 py-1.5 text-sm text-l2 outline-none placeholder:text-l4 focus:border-l4"
                />
              </label>
            )}
            {error && <p className="mb-3 text-xs text-err-text">✗ {error}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setArchiveOpen(false)}
                disabled={busy}
                className="rounded-sm px-3 py-1.5 text-sm text-l2 hover:bg-hover disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={busy}
                className="rounded-sm border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
              >
                {busy
                  ? "处理中…"
                  : hasUncommitted
                    ? "提交并归档"
                    : "归档工作区"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
