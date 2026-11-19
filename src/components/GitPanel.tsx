import { memo, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ClipboardCheck,
  FileText,
  FolderOpen,
  GitBranch,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  RotateCcw,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";
import type {
  ArtifactEntryDto,
  GitCommitResultDto,
  GitFileDto,
  WorkspaceDiffDto,
} from "../types";
import {
  Checkbox,
  compactPrimaryActionClass,
  EmptyState,
  fieldClass,
  FoldMark,
  hoverRevealClass,
  LoadingRows,
  InlineNotice,
  primaryActionClass,
  secondaryActionClass,
} from "./PageFrame";
import { confirmDialog } from "./ConfirmDialog";
import ImagePairView, { isImagePath } from "./ImagePairView";
import { useAppStore } from "../store";
import { defaultCommitMessage } from "../git-commit-message";
import { GitInstallOffer } from "../dep-install";
import { FileTypeGlyph } from "./FileTypeMark";
import { groupFilesByStatus, statusBadgeTitle } from "../git-status-groups";
import { IS_MAC, IS_WINDOWS } from "../hotkeys";
import { createImeLock } from "../ime-guard";
import { revealFolderLabel } from "../path-utils";
import { fileExt } from "../project-files";
import { diffLineNumbers, hunkLabel, pairIntraline, parseHunkHeader } from "../diff-intraline";
import { usePolling } from "../polling";

/** 提货单里 Mesa 可直接预览的文件后缀（除压缩包/未知二进制外均可就地看） */
const PREVIEWABLE_ARTIFACT_EXTS = new Set([
  "pdf", "docx", "xlsx", "xlsm", "xls", "ods", "csv", "tsv",
  "pptx", "pptm", "ppsx", "potx", "ipynb",
  "png", "jpg", "jpeg", "gif", "webp", "svg",
  "md", "markdown", "qmd", "txt", "json", "yaml", "yml", "toml", "xml", "html", "htm", "tex", "bib",
  "mp3", "wav", "m4a", "mp4", "mov", "webm",
]);

function isArtifactPreviewable(path: string): boolean {
  return PREVIEWABLE_ARTIFACT_EXTS.has(fileExt(path));
}

function joinRepoPath(cwd: string, rel: string): string {
  const base = cwd.replace(/[\\/]+$/, "");
  const cleanRel = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  return `${base}/${cleanRel}`;
}

function fileChangeSig(f: GitFileDto | undefined): string {
  return f ? `${f.status}|${f.additions ?? ""}|${f.deletions ?? ""}` : "";
}

interface GitStatusDto {
  isRepo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  files: GitFileDto[];
  totalAdd: number;
  totalDel: number;
  merging?: boolean;
}

interface GitFileDiffDto {
  text: string;
  binary: boolean;
  truncated: boolean;
}

/** 逐 hunk 验收 v1：未提交改动的单块补丁（含完整文件头，后端可直接 git apply） */
interface GitHunkDto {
  index: number;
  header: string;
  patch: string;
}

interface GitFileHunksDto {
  hunks: GitHunkDto[];
  staged: boolean;
}

/** hunk patch 去掉文件头与 @@ 行，只留展示用内容行；空新文件无 @@ 时返回空数组 */
function hunkBodyLines(patch: string): string[] {
  const lines = patch.split("\n");
  const at = lines.findIndex((l) => l.startsWith("@@"));
  if (at < 0) return [];
  const body = lines.slice(at + 1);
  if (body.length > 0 && body[body.length - 1] === "") body.pop();
  return body;
}

/**
 * diff 正文（2026-10-26 对照 Claude 桌面版重排）：每行 = 左缘色条 · 行号 · +/- 标记 · 正文四列，
 * 增删只铺淡底 + 左缘一道语义色，正文保持阅读色；长行折行（窄栏里每块各带一条横向滚动条没法读，2026-10-23 用户），
 * 折下来的行对齐正文列；行号与标记不进复制；成对的删加行标出改了的那一段（diff-intraline.ts pairIntraline）。
 * start 给了是逐块正文（@@ 已去掉），不给是整段 diff 文本
 */
function DiffBody({ lines, start }: { lines: readonly string[]; start?: { oldStart: number; newStart: number } }) {
  const marks = pairIntraline(lines);
  const numbers = diffLineNumbers(lines, start);
  const digits = Math.max(2, ...numbers.map((n) => (n == null ? 0 : String(n).length)));
  return (
    <div className="py-1 font-mono text-xs leading-5">
      {lines.map((line, index) => {
        const key = `${index}:${line.slice(0, 24)}`;
        const n = numbers[index];
        if (n == null) {
          // 文件头 / 「\ No newline」等：整行弱化，不占行号列
          const hunk = line.startsWith("@@") ? hunkLabel(line) : null;
          return (
            <div
              key={key}
              className={`whitespace-pre-wrap pr-2 pl-[calc(0.5rem+3px)] [overflow-wrap:anywhere] ${hunk ? "bg-inset text-l3" : "text-l4"}`}
              title={hunk ? line : undefined}
            >
              {hunk ? (hunk.context ? `${hunk.line} · ${hunk.context}` : hunk.line) : line || " "}
            </div>
          );
        }
        const kind = line[0] === "+" ? "add" : line[0] === "-" ? "del" : "ctx";
        const text = line.slice(1);
        const mark = marks.get(index);
        return (
          <div
            key={key}
            className={`flex ${kind === "add" ? "bg-diff-add-bg" : kind === "del" ? "bg-diff-del-bg" : ""}`}
          >
            <span
              aria-hidden="true"
              className={`w-[3px] shrink-0 ${kind === "add" ? "bg-add" : kind === "del" ? "bg-del" : ""}`}
            />
            <span
              className="shrink-0 select-none pr-2 pl-1.5 text-right text-l4 tabular-nums"
              style={{ width: `calc(${digits}ch + 0.875rem)` }}
            >
              {n}
            </span>
            <span
              aria-hidden="true"
              className={`w-[2ch] shrink-0 select-none ${kind === "add" ? "text-add" : kind === "del" ? "text-del" : ""}`}
            >
              {kind === "add" ? "+" : kind === "del" ? "-" : ""}
            </span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap pr-2 text-l2 [overflow-wrap:anywhere]">
              {mark ? (
                <>
                  {text.slice(0, mark[0])}
                  <span className={kind === "add" ? "ccode-diff-hl-add" : "ccode-diff-hl-del"}>
                    {text.slice(mark[0], mark[1])}
                  </span>
                  {text.slice(mark[1])}
                </>
              ) : (
                text || " "
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** 面板宽到这么多才把文件列放到 diff 右边（左 diff 至少四百来像素 + 右列 w-44） */
const SPLIT_MIN_WIDTH = 640;

/** 看 diff 时右边文件列收起与否（localStorage） */
const LIST_COLLAPSED_KEY = "ccode.gitPanel.listCollapsed";

/** 状态 → 文件名单色（v3.92 起替代独立 M/?? 徽标块：状态色直接上到文件名，
    前缀只剩勾选框 + 类型图标，更清爽；黄=修改 绿=新增 红=删除） */
const STATUS_TEXT: Record<string, string> = {
  M: "text-warn-text",
  A: "text-ok-text",
  "??": "text-ok-text",
  D: "text-err-text",
  R: "text-l3",
};

/** 路径分级：目录段弱化、文件名加粗（扫视找文件名不费力） */
function PathLabel({ path, status }: { path: string; status: string }) {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dir = idx >= 0 ? path.slice(0, idx + 1) : "";
  const base = idx >= 0 ? path.slice(idx + 1) : path;
  return (
    <span className="min-w-0 flex-1 truncate font-mono">
      <span className="text-l4">{dir}</span>
      <span className={`font-medium ${STATUS_TEXT[status] ?? "text-l1"}`}>
        {base}
      </span>
    </span>
  );
}

/** 内联 diff 渲染行数上限：超出只渲染前 N 行并提示，防超大 diff 的全量 span 拖垮面板 */
const DIFF_LINE_CAP = 2000;

/** 产物大小的人类可读格式（与 ProjectGroup 的 formatSize 同规则） */
function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** 文件类型线条图标（固定识别色，不随主题；与 FileTypeMark 同一套） */
function FileTypeBadge({ path }: { path: string }) {
  return (
    <span aria-hidden="true" className="flex h-4 w-4 shrink-0 items-center justify-center">
      <FileTypeGlyph path={path} size={13} />
    </span>
  );
}

/** 改动面板上报给终端页的状态摘要：标签条变更芯片（改动数 + 分支 + 快速保存）与页签徽标共用 */
export interface GitSummary {
  add: number;
  del: number;
  isRepo: boolean;
  branch: string;
  /** 领先/落后远程的提交数（状态条「⇧ 推送」按 ahead 决定是否出现） */
  ahead: number;
  behind: number;
  /** 任务工作区视图（提交时 paths 传 null 全量提交，与面板「保存到历史」同口径） */
  inWorkspace: boolean;
  files: GitFileDto[];
}

/**
 * 改动面板：活动标签 cwd 的 git 状态（8s 轮询）+ 提交/推送。
 * 输入提交信息时直接使用；留空点击则用本地规则生成默认信息。显式点击即视为用户同意，不再二次确认。
 */
function GitPanel({
  cwd,
  visible,
  refreshKey,
  onTotals,
  onOpenFile,
  onOpenReview,
  onOpenPr,
  readOnly = false,
}: {
  cwd: string;
  /** 页面可见时轮询；不可见时暂停轮询 */
  visible: boolean;
  /** 外部刷新信号（如 fs-changed 文件监听事件），变化时立即刷新 */
  refreshKey?: number;
  onTotals: (t: GitSummary) => void;
  /** 从改动行打开文件到右侧文件查看面板；缺省时回落 previewReq */
  onOpenFile?: (absPath: string) => void;
  /** 工作区任务进入全宽审阅；普通仓库不显示入口。 */
  onOpenReview?: (cwd: string, runId?: string | null) => void;
  /** 编程工作树推送成功后打开 PR；缺省不渲染。GitPanel 不识别 GitHub。 */
  onOpenPr?: (cwd: string) => void | Promise<void>;
  /** 会话页只展示当前项目状态，不允许从历史上下文提交或推送。 */
  readOnly?: boolean;
}) {
  const [status, setStatus] = useState<GitStatusDto | null>(null);
  /** 活动标签 cwd 落在工作区里时为任务累计 diff（W3），否则为 null */
  const [wsDiff, setWsDiff] = useState<WorkspaceDiffDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState<"commit" | "push" | "abort" | null>(
    null,
  );
  const [output, setOutput] = useState<{
    phase: "push" | "error";
    text: string;
  } | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // 提货单（§11.3 机制五）：仅工作区任务视图加载；产物本体不进 git，清单随提交传递
  const [artifacts, setArtifacts] = useState<ArtifactEntryDto[]>([]);
  const [registering, setRegistering] = useState(false);
  // 提货单产物「查看」：复用文件预览链路
  const setPreviewReq = useAppStore((s) => s.setPreviewReq);
  const setPage = useAppStore((s) => s.setPage);
  const diffFocusReq = useAppStore((s) => s.diffFocusReq);
  const setDiffFocusReq = useAppStore((s) => s.setDiffFocusReq);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const diffPathRef = useRef<string | null>(null);
  diffPathRef.current = diffPath;
  const diffFileSigRef = useRef<string>("");
  const [imageRev, setImageRev] = useState(0);
  // 面板够宽才分左右两栏（右栏宽度可拖，量自己）
  const rootRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setWide(el.clientWidth >= SPLIT_MIN_WIDTH);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // 看 diff 时右边那列文件名可收起，让 diff 占满整栏（2026-10-23 用户）；记住上次的选择
  const [listCollapsed, setListCollapsed] = useState(
    () => typeof localStorage !== "undefined" && localStorage.getItem(LIST_COLLAPSED_KEY) === "1",
  );
  function toggleList() {
    setListCollapsed((v) => {
      try {
        localStorage.setItem(LIST_COLLAPSED_KEY, v ? "0" : "1");
      } catch {}
      return !v;
    });
  }
  const [diffDetail, setDiffDetail] = useState<GitFileDiffDto | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  // 逐 hunk 验收 v1：展开内容优先拉 hunk（可按块操作）；null = 走只读文本 diff
  const [hunks, setHunks] = useState<GitHunkDto[] | null>(null);
  const [hunksStaged, setHunksStaged] = useState(false);
  const [hunkBusy, setHunkBusy] = useState(false);
  const diffRequestRef = useRef(0);
  const refreshReqRef = useRef(0);
  const commitImeRef = useRef(createImeLock());
  // 成功 toast（主题 CTA 绿，右下角浮出 2.5s 自动淡出）；失败仍走 output 红字详情
  const [toast, setToast] = useState<{
    text: string;
    hiding: boolean;
    afterPush?: boolean;
  } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [prOpening, setPrOpening] = useState(false);

  function showToast(text: string, afterPush = false) {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ text, hiding: false, afterPush });
    toastTimerRef.current = setTimeout(() => {
      setToast((t) => (t ? { ...t, hiding: true } : t));
      toastTimerRef.current = setTimeout(() => setToast(null), 300);
    }, 2200);
  }

  /** ◈ AI 生成提交信息：填入输入框由用户审阅后再提交（不自动提交） */
  async function genMessage() {
    const paths = wsDiff?.inWorkspace
      ? null
      : (status?.files ?? [])
          .filter((file) => selectedPaths.has(file.path))
          .map((file) => file.path);
    setAiBusy(true);
    try {
      const text = await invoke<string>("ai_commit_message", { cwd, paths });
      setMessage(text.trim());
      setError(null);
    } catch (e) {
      setError(`${e}（检查设置页「AI 专用配置」是否可用，或换更快的模型）`);
    } finally {
      setAiBusy(false);
    }
  }

  const loadExpandedDiffRef = useRef<
    (file: GitFileDto, opts?: { silent?: boolean; wsOverride?: boolean }) => Promise<void>
  >(async () => {});

  const refresh = useCallback(
    async (opts?: { forceDiff?: boolean; showSpinner?: boolean }) => {
      const req = ++refreshReqRef.current;
      if (opts?.showSpinner) setRefreshing(true);
      try {
        // 两个查询同时发（原先串行：工作区探测慢时分支 / 改动要等它一起才出来，2026-10-23 用户：接着聊时不会一下显示）
        const diffReq = invoke<WorkspaceDiffDto>("workspace_diff", { worktreePath: cwd }).catch(
          () => null,
        );
        let s: GitStatusDto | null = null;
        try {
          s = await invoke<GitStatusDto>("git_status", { cwd });
          if (req !== refreshReqRef.current) return null;
          setStatus(s);
          setError(null);
        } catch (e) {
          if (req !== refreshReqRef.current) return null;
          setStatus(null);
          setError(String(e));
        }
        // 工作区探测：cwd 落在 worktree 里时切任务 diff 视图；失败/非工作区保持普通视图
        const diff = await diffReq;
        if (req !== refreshReqRef.current) return null;
        const d: WorkspaceDiffDto | null = diff?.inWorkspace ? diff : null;
        setWsDiff(d);
        // 提货单：工作区根的 artifacts.yaml（未提交也可见，提交后才随分支传递）
        if (d) {
          try {
            const list = await invoke<ArtifactEntryDto[]>("read_artifacts_manifest", {
              repoPath: cwd,
            });
            if (req !== refreshReqRef.current) return null;
            setArtifacts(list);
          } catch {
            if (req !== refreshReqRef.current) return null;
            setArtifacts([]);
          }
        } else {
          setArtifacts([]);
        }
        if (d) {
          setSelectedPaths(new Set());
        } else if (s) {
          const current = new Set(s.files.map((file) => file.path));
          setSelectedPaths((selected) =>
            new Set([...selected].filter((path) => current.has(path))),
          );
        }
        const nextFiles = d ? d.files : (s?.files ?? []);
        onTotals({
          add: d ? d.totalAdd : (s?.totalAdd ?? 0),
          del: d ? d.totalDel : (s?.totalDel ?? 0),
          isRepo: s?.isRepo ?? false,
          branch: s?.branch ?? "",
          ahead: s?.ahead ?? 0,
          behind: s?.behind ?? 0,
          inWorkspace: d !== null,
          files: nextFiles,
        });
        // 已展开的 diff / 图片对比随磁盘或轮询变化静默刷新，不停在旧快照
        const curDiffPath = diffPathRef.current;
        if (curDiffPath) {
          const hit = nextFiles.find((file) => file.path === curDiffPath);
          const nextSig = fileChangeSig(hit);
          if (hit && (opts?.forceDiff || nextSig !== diffFileSigRef.current)) {
            diffFileSigRef.current = nextSig;
            if (isImagePath(hit.path)) {
              setImageRev((n) => n + 1);
            } else {
              void loadExpandedDiffRef.current(hit, {
                silent: true,
                wsOverride: d !== null,
              });
            }
          }
        }
        return { files: nextFiles, inWs: d !== null };
      } finally {
        if (opts?.showSpinner && req === refreshReqRef.current) {
          setRefreshing(false);
        }
      }
    },
    [cwd, onTotals],
  );

  // git 缺失时的一键安装出口见 GitInstallOffer（与设置页诊断区共用 dep-install 管线）

  // 仅 cwd 变化时清空旧仓库状态与展开 diff，切页（visible 变化）保留勾选与展开状态
  useEffect(() => {
    refreshReqRef.current += 1;
    diffRequestRef.current += 1;
    diffFileSigRef.current = "";
    setStatus(null);
    setWsDiff(null);
    setArtifacts([]);
    setError(null);
    setOutput(null);
    setMessage("");
    setSelectedPaths(new Set());
    setDiffPath(null);
    setDiffDetail(null);
    setHunks(null);
    setHunksStaged(false);
    setDiffError(null);
    setDiffLoading(false);
    void refresh();
  }, [cwd, refresh]);

  // 切回页面（visible 假→真）只静默刷新最新状态，不清空勾选和展开的 diff
  const prevVisibleRef = useRef(visible);
  useEffect(() => {
    const was = prevVisibleRef.current;
    prevVisibleRef.current = visible;
    if (visible && !was) {
      void refresh({ forceDiff: true });
    }
  }, [visible, refresh]);

  usePolling(() => refresh(), visible ? 8000 : null);

  // 外部刷新信号（fs-changed 文件监听等）：刷新列表并静默更新已展开的 diff/图片对比
  useEffect(() => {
    if (!refreshKey) return;
    void refresh({ forceDiff: true });
  }, [refreshKey, refresh]);

  // 卸载时清理 toast 定时器与 IME 锁
  useEffect(() => {
    const ime = commitImeRef.current;
    return () => {
      ime.dispose();
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  async function abortMerge() {
    if (running || readOnly) return;
    if (
      !(await confirmDialog("取消这次合并？未解决的冲突会丢弃。", {
        danger: true,
        confirmText: "取消合并",
      }))
    ) {
      return;
    }
    setRunning("abort");
    setOutput(null);
    try {
      const text = await invoke<string>("git_abort_merge", { cwd });
      setOutput({ phase: "push", text: text || "已取消合并" });
      await refresh();
    } catch (reason) {
      setOutput({ phase: "error", text: String(reason) });
    } finally {
      setRunning(null);
    }
  }

  async function doCommit(push: boolean) {
    const selectedFiles = wsDiff?.inWorkspace
      ? (status?.files ?? [])
      : (status?.files ?? []).filter((file) => selectedPaths.has(file.path));
    const commitMessage = message.trim() || defaultCommitMessage(selectedFiles);
    setRunning(push ? "push" : "commit");
    setOutput(null);
    // Git 阶段失败时保留本地生成结果，用户可直接重试或编辑。
    if (!message.trim()) setMessage(commitMessage);
    try {
      const out = await invoke<GitCommitResultDto>("git_commit", {
        cwd,
        message: commitMessage,
        push,
        paths: wsDiff?.inWorkspace ? null : selectedFiles.map((file) => file.path),
      });
      // 提交输出首行形如 [branch abc1234] msg，提取出来让 toast 带提交号
      const bracket = out.output.match(/\[([^\]]+)\]/)?.[1];
      const title = commitMessage.split(/\r?\n/, 1)[0];
      setMessage("");
      setSelectedPaths(new Set());
      if (out.failedPhase === "push") {
        setOutput({ phase: "push", text: `${out.message}\n${out.output}`.trim() });
      } else {
        showToast(
          `${out.message}${bracket ? ` · ${bracket}` : ""} · ${title}`,
          push,
        );
      }
    } catch (e) {
      setOutput({ phase: "error", text: String(e) });
    } finally {
      setRunning(null);
      void refresh();
    }
  }

  /** 提交已成功但 push 失败时，只重试 push，避免再次提交。 */
  async function retryPush() {
    setRunning("push");
    setOutput(null);
    try {
      await invoke<string>("git_push", { cwd });
      showToast("推送成功", true);
      setError(null);
    } catch (e) {
      setOutput({ phase: "push", text: `推送仍未完成：${e}` });
    } finally {
      setRunning(null);
      void refresh();
    }
  }

  /** 登记产物：系统对话框选文件 → 写入工作区根 artifacts.yaml（同路径重复登记会更新条目） */
  async function registerArtifact() {
    const selected = await open({
      multiple: false,
      directory: false,
      title: "选择要交给下一步的文件",
    });
    if (typeof selected !== "string") return;
    setRegistering(true);
    setOutput(null);
    try {
      const name = selected.split(/[\\/]/).pop() ?? selected;
      const entry = await invoke<ArtifactEntryDto>("register_artifact", {
        worktreePath: cwd,
        name,
        artifactPath: selected,
      });
      showToast(`已加入「${entry.name}」`);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setRegistering(false);
      void refresh();
    }
  }

  const hasChanges = (status?.files.length ?? 0) > 0;
  const inWs = wsDiff?.inWorkspace === true;
  const files = inWs ? wsDiff!.files : (status?.files ?? []);
  const selectedFiles = inWs
    ? (status?.files ?? [])
    : (status?.files ?? []).filter((file) => selectedPaths.has(file.path));
  const canCommit = selectedFiles.length > 0 && running === null && !aiBusy;
  const allSelected = !inWs && files.length > 0 && selectedPaths.size === files.length;

  useEffect(() => {
    if (!diffPath || files.some((file) => file.path === diffPath)) return;
    diffRequestRef.current += 1;
    setDiffPath(null);
    setDiffDetail(null);
    setHunks(null);
    setHunksStaged(false);
    setDiffError(null);
    setDiffLoading(false);
  }, [diffPath, files]);

  function togglePath(path: string, checked: boolean) {
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (checked) next.add(path);
      else next.delete(path);
      return next;
    });
  }

  function openFileInPane(relPath: string) {
    const abs = joinRepoPath(cwd, relPath);
    if (onOpenFile) {
      onOpenFile(abs);
      return;
    }
    const cleanRel = relPath.replace(/\\/g, "/");
    setPreviewReq({ path: abs, name: cleanRel.split("/").pop() ?? cleanRel, root: cwd });
  }

  /** 展开内容加载：未提交文件优先拉 hunk（按块丢弃/暂存）；hunk 不可用或为空时回落只读文本 diff */
  async function loadExpandedDiff(
    file: GitFileDto,
    opts?: { silent?: boolean; wsOverride?: boolean },
  ) {
    const request = ++diffRequestRef.current;
    const isWs = opts?.wsOverride ?? inWs;
    diffFileSigRef.current = fileChangeSig(file);
    setDiffPath(file.path);
    if (!opts?.silent) {
      setDiffDetail(null);
      setHunks(null);
      setHunksStaged(false);
      setDiffError(null);
    }
    // 图片文件不走文本 diff，展开区改渲染双栏对比（ImagePairView 自行取数）
    if (isImagePath(file.path)) {
      setDiffLoading(false);
      return;
    }
    if (!opts?.silent) setDiffLoading(true);
    try {
      // 只读场景（会话页）不拉 hunk；其余让后端白名单裁决——
      // 工作区视图里只含已提交改动的文件会被拒绝，自然回落只读累计 diff
      if (!readOnly) {
        try {
          const dto = await invoke<GitFileHunksDto>("git_file_hunks", {
            cwd,
            path: file.path,
          });
          if (request !== diffRequestRef.current) return;
          setHunksStaged(dto.staged);
          if (dto.hunks.length > 0) {
            setHunks(dto.hunks);
            setDiffDetail(null);
            setDiffError(null);
            return;
          }
          // hunks 为空（如改动已全部暂存）→ 走只读文本展示
        } catch {
          // 二进制/过大/非 UTF-8/不在未提交清单 → 回落只读文本
        }
      }
      const detail = isWs
        ? {
            text: await invoke<string>("workspace_file_diff", {
              worktreePath: cwd,
              path: file.path,
            }),
            binary: file.additions === null && file.deletions === null,
            truncated: false,
          }
        : await invoke<GitFileDiffDto>("git_file_diff", {
            cwd,
            path: file.path,
          });
      if (request === diffRequestRef.current) {
        setHunks(null);
        setDiffDetail(detail);
        setDiffError(null);
      }
    } catch (e) {
      if (request === diffRequestRef.current) setDiffError(String(e));
    } finally {
      if (request === diffRequestRef.current) setDiffLoading(false);
    }
  }
  loadExpandedDiffRef.current = loadExpandedDiff;

  /** 按块操作：暂存（git apply --cached）/ 丢弃（git apply -R 工作树）。
   *  成功后一律重新拉取 hunks 与 status，不保留旧 hunk 索引。 */
  async function applyHunk(hunk: GitHunkDto, mode: "stage" | "discard") {
    if (!diffPath || hunkBusy) return;
    if (
      mode === "discard" &&
      !(await confirmDialog("丢弃这块改动？不可恢复（除非已提交）", {
        danger: true,
      }))
    )
      return;
    const path = diffPath;
    setHunkBusy(true);
    setDiffError(null);
    try {
      const s = await invoke<GitStatusDto>("apply_hunk", {
        cwd,
        path,
        patch: hunk.patch,
        mode,
      });
      setStatus(s);
      showToast(
        mode === "stage"
          ? "已暂存这块改动；勾选该文件点「提交」时只提交已暂存的块"
          : "已丢弃这块改动",
      );
    } catch (e) {
      setDiffError(String(e));
    } finally {
      setHunkBusy(false);
      const latest = await refresh();
      if (diffPathRef.current === path && latest) {
        const hit = latest.files.find((f) => f.path === path);
        if (hit) {
          await loadExpandedDiff(hit, { silent: true, wsOverride: latest.inWs });
        }
      }
    }
  }

  /** 取消指定文件的暂存状态（工作树修改原样保留） */
  async function unstageFile(path: string) {
    if (hunkBusy || readOnly) return;
    setHunkBusy(true);
    setDiffError(null);
    try {
      const s = await invoke<GitStatusDto>("git_unstage_file", { cwd, path });
      setStatus(s);
      showToast("已取消暂存，修改保留在工作区");
    } catch (e) {
      setDiffError(String(e));
    } finally {
      setHunkBusy(false);
      const latest = await refresh();
      if (diffPathRef.current === path && latest) {
        const hit = latest.files.find((f) => f.path === path);
        if (hit) {
          await loadExpandedDiff(hit, { silent: true, wsOverride: latest.inWs });
        }
      }
    }
  }

  /** 丢弃整文件的未提交改动（已跟踪还原到 HEAD，新文件移入系统回收站） */
  async function discardFile(file: GitFileDto) {
    if (hunkBusy || readOnly) return;
    const isNew = file.status === "??";
    const prompt = isNew
      ? `丢弃新文件「${file.path}」？文件将移入系统回收站。`
      : `丢弃「${file.path}」的全部未提交改动？将还原到最近一次提交，无法恢复。`;
    if (!(await confirmDialog(prompt, { danger: true, confirmText: "丢弃改动" }))) {
      return;
    }
    setHunkBusy(true);
    setDiffError(null);
    try {
      const s = await invoke<GitStatusDto>("git_discard_file", {
        cwd,
        path: file.path,
      });
      setStatus(s);
      showToast(isNew ? "已将新文件移入回收站" : "已丢弃该文件的改动");
    } catch (e) {
      setError(String(e));
    } finally {
      setHunkBusy(false);
      const latest = await refresh();
      if (diffPathRef.current === file.path && latest) {
        const hit = latest.files.find((f) => f.path === file.path);
        if (hit) {
          await loadExpandedDiff(hit, { silent: true, wsOverride: latest.inWs });
        }
      }
    }
  }

  const focusSeen = useRef<string | null>(null);
  useEffect(() => {
    if (!diffFocusReq) {
      focusSeen.current = null;
      return;
    }
    if (diffFocusReq.cwd !== cwd) return;
    // status 还没加载完：等它（deps 里有 status?.files，就绪后自动重跑）。
    // 抢先判「不在改动里」会把目标 diff 误回落成纯文本预览（2026-10-11 复核）。
    if (!status) return;
    const mark = `${diffFocusReq.cwd}:${diffFocusReq.path}`;
    if (focusSeen.current === mark) return;
    focusSeen.current = mark;
    const file = (status.files ?? []).find((item) => item.path === diffFocusReq.path);
    setDiffFocusReq(null);
    focusSeen.current = null;
    if (!file) {
      // 确实不在本次改动里：回落成文件预览——点了总得有反应，不能静默吞掉
      openFileInPane(diffFocusReq.path);
      return;
    }
    void loadExpandedDiff(file);
  }, [cwd, diffFocusReq, setDiffFocusReq, status]);

  async function toggleDiff(file: GitFileDto) {
    if (diffPath === file.path) {
      diffRequestRef.current += 1;
      diffFileSigRef.current = "";
      setDiffPath(null);
      setDiffDetail(null);
      setHunks(null);
      setHunksStaged(false);
      setDiffError(null);
      return;
    }
    await loadExpandedDiff(file);
  }

  // 宽栏（≥ SPLIT_MIN_WIDTH）：选中文件后左栏 diff 主区 + 右栏紧凑文件列；
  // 窄栏（终端页右栏这类）：diff 就在那一行下面展开，往下滑接着看（2026-10-23 用户：窄了两栏都看不下）
  const diffFile = diffPath
    ? (files.find((f) => f.path === diffPath) ?? null)
    : null;
  const split = Boolean(diffFile) && wide;

  /** 文件在当前 status 里是否有未提交改动（工作区模式下仅未提交文件支持整文件丢弃） */
  const uncommittedSet = new Set((status?.files ?? []).map((file) => file.path));

  /** 全宽模式文件行：去格子化圆角行（h-8）+ 勾选 + 类型图标 + 路径 + 增删数 + hover 快捷操作 */
  function renderFullRow(f: GitFileDto) {
    const expanded = diffPath === f.path;
    const canOpen = f.status !== "D";
    const canDiscard = !readOnly && uncommittedSet.has(f.path);
    return (
      <div key={`${f.status}:${f.path}`} className="mb-0.5 last:mb-0">
        <div
          className={`group flex h-8 items-center gap-1 rounded-md px-1.5 text-xs transition-colors ${
            expanded ? "bg-inset/75" : "hover:bg-hover"
          }`}
        >
          {!inWs && !readOnly && (
            <Checkbox
              checked={selectedPaths.has(f.path)}
              onChange={(checked) => togglePath(f.path, checked)}
              label={<span className="sr-only">选择 {f.path}</span>}
            />
          )}
          <button
            type="button"
            onClick={() => void toggleDiff(f)}
            title={`${expanded ? "收起" : "查看"} ${f.path} 的 diff`}
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
          >
            <FoldMark open={expanded} />
            <span title={statusBadgeTitle(f.status)} className="contents">
              <FileTypeBadge path={f.path} />
            </span>
            <PathLabel path={f.path} status={f.status} />
            {(f.additions !== null || f.deletions !== null) && (
              <span className="shrink-0 font-mono text-micro tabular-nums">
                {f.additions !== null && (
                  <span className="text-add">+{f.additions}</span>
                )}
                {f.additions !== null && f.deletions !== null && f.deletions > 0 ? " " : ""}
                {f.deletions !== null && f.deletions > 0 && (
                  <span className="text-del">-{f.deletions}</span>
                )}
              </span>
            )}
          </button>
          <span className={`${hoverRevealClass} flex shrink-0 items-center gap-0.5`}>
            {canOpen && (
              <button
                type="button"
                onClick={() => openFileInPane(f.path)}
                title="在文件面板打开查看 / 编辑"
                aria-label={`打开 ${f.path}`}
                className="flex size-6 items-center justify-center rounded-md text-l4 transition-colors hover:bg-hover hover:text-l1"
              >
                <FileText size={13} strokeWidth={1.8} aria-hidden="true" />
              </button>
            )}
            {canDiscard && (
              <button
                type="button"
                disabled={hunkBusy}
                onClick={() => void discardFile(f)}
                title={f.status === "??" ? "将新文件移入回收站" : "丢弃这个文件的未提交改动"}
                aria-label={`丢弃 ${f.path} 的改动`}
                className="flex size-6 items-center justify-center rounded-md text-l4 transition-colors hover:bg-hover hover:text-warn-text disabled:opacity-40"
              >
                <RotateCcw size={13} strokeWidth={1.8} aria-hidden="true" />
              </button>
            )}
          </span>
        </div>
        {expanded && !wide && <div className="mt-1 mb-2 pl-1 pr-0.5">{renderDiffContent(f, true)}</div>}
      </div>
    );
  }

  /** 分栏模式右栏紧凑行：状态色文件名（全路径进 title），选中行圆角高亮 */
  function renderCompactRow(f: GitFileDto) {
    const active = diffPath === f.path;
    return (
      <div key={`${f.status}:${f.path}`} className="mb-0.5 flex items-center gap-1 last:mb-0">
        {!inWs && !readOnly && (
          <Checkbox
            checked={selectedPaths.has(f.path)}
            onChange={(checked) => togglePath(f.path, checked)}
            label={<span className="sr-only">选择 {f.path}</span>}
          />
        )}
        <button
          type="button"
          onClick={() => void toggleDiff(f)}
          title={f.path}
          className={`flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left transition-colors ${
            active ? "bg-seg-sel text-l1" : "hover:bg-hover"
          }`}
        >
          <span title={statusBadgeTitle(f.status)} className="contents">
            <FileTypeBadge path={f.path} />
          </span>
          <span
            className={`min-w-0 flex-1 truncate font-mono text-xs font-medium ${STATUS_TEXT[f.status] ?? "text-l2"}`}
          >
            {f.path.split(/[\\/]/).pop()}
          </span>
        </button>
      </div>
    );
  }

  /** 左栏 diff 主区：精致代码卡片 + 文件头 + 逐 hunk / 只读文本 / 图片对比 */
  function renderDiffContent(f: GitFileDto, inline = false) {
    const diffLines = diffDetail ? diffDetail.text.split("\n") : null;
    const canOpen = f.status !== "D";
    return (
      <div className="overflow-hidden rounded-lg border border-hairline bg-canvas">
        {/* 行内展开时路径就在上面那一行，文件头只在有「二进制 / 已截断」要说时出现 */}
        {(!inline || diffDetail?.binary || diffDetail?.truncated) && (
        <div className="flex h-8 items-center gap-1.5 border-b border-hairline bg-strip px-2.5 text-micro text-l4">
          <span className="min-w-0 flex-1 truncate font-mono text-l2" title={f.path}>
            {inline ? "" : f.path}
          </span>
          {diffDetail?.binary && (
            <span className="rounded-md bg-inset px-1.5 py-0.5 text-l3">二进制</span>
          )}
          {diffDetail?.truncated && (
            <span className="rounded-md bg-warn/20 px-1.5 py-0.5 text-warn-text">已截断</span>
          )}
          {!inline && canOpen && (
            <button
              type="button"
              onClick={() => openFileInPane(f.path)}
              title="在文件面板打开查看 / 编辑"
              aria-label="打开文件"
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-l3 transition-colors hover:bg-hover hover:text-l1"
            >
              <FileText aria-hidden="true" size={13} strokeWidth={1.8} />
            </button>
          )}
          {!inline && canOpen && (
            <button
              type="button"
              onClick={() =>
                void revealItemInDir(joinRepoPath(cwd, f.path)).catch((e) => setError(String(e)))
              }
              title={revealFolderLabel(IS_MAC, IS_WINDOWS)}
              aria-label={revealFolderLabel(IS_MAC, IS_WINDOWS)}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-l3 transition-colors hover:bg-hover hover:text-l1"
            >
              <FolderOpen aria-hidden="true" size={13} strokeWidth={1.8} />
            </button>
          )}
          {!inline && (
          <button
            type="button"
            onClick={toggleList}
            title={listCollapsed ? "展开右边的文件列表" : "收起右边的文件列表，diff 占满整栏"}
            aria-label={listCollapsed ? "展开文件列表" : "收起文件列表"}
            aria-pressed={listCollapsed}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-l3 transition-colors hover:bg-hover hover:text-l1"
          >
            {listCollapsed ? (
              <PanelRightOpen aria-hidden="true" size={13} strokeWidth={1.8} />
            ) : (
              <PanelRightClose aria-hidden="true" size={13} strokeWidth={1.8} />
            )}
          </button>
          )}
          {!inline && (
          <button
            type="button"
            onClick={() => void toggleDiff(f)}
            title="收起 diff，回到全宽文件列表"
            aria-label="收起 diff"
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-l3 transition-colors hover:bg-hover hover:text-l1"
          >
            <X aria-hidden="true" size={13} strokeWidth={1.8} />
          </button>
          )}
        </div>
        )}
        {isImagePath(f.path) ? (
          <ImagePairView cwd={cwd} path={f.path} revision={imageRev} />
        ) : diffLoading ? (
          <div className="p-2">
            <LoadingRows compact />
          </div>
        ) : hunks && hunks.length > 0 ? (
          // 逐 hunk 验收：未暂存改动按块展示，块头右侧「丢弃 / 暂存」
          <div>
            {diffError && (
              <InlineNotice tone="err" size="micro" className="border-b border-hairline px-2 py-1">{diffError}</InlineNotice>
            )}
            {hunksStaged && !inWs && (
              <div className="flex items-center gap-2 border-b border-hairline bg-warn/25 px-2.5 py-1.5 text-micro text-warn-text">
                <span className="min-w-0 flex-1">
                  该文件已有部分内容暂存；勾选后点「提交」只提交已暂存的块，下方未暂存的块留在工作区
                </span>
                {!readOnly && (
                  <button
                    type="button"
                    disabled={hunkBusy}
                    onClick={() => void unstageFile(f.path)}
                    className="shrink-0 rounded-md border border-current/35 px-2 py-0.5 transition-colors hover:bg-hover disabled:opacity-50"
                  >
                    取消暂存
                  </button>
                )}
              </div>
            )}
            {hunks.map((h) => {
              const body = hunkBodyLines(h.patch);
              return (
                <div
                  key={`${h.index}:${h.header}`}
                  className="border-b border-hairline/60 last:border-b-0"
                >
                  <div className="flex items-center gap-1 border-b border-hairline/60 bg-strip px-2.5 py-1">
                    {/* 块头白话「第 340 行 · 小标题」，git 原样的 @@ 头放悬停 */}
                    <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-micro" title={h.header}>
                      <span className="shrink-0 font-medium text-l3">{hunkLabel(h.header).line}</span>
                      {hunkLabel(h.header).context && (
                        <span className="min-w-0 truncate text-l4">{hunkLabel(h.header).context}</span>
                      )}
                    </span>
                    {!readOnly && (
                      <>
                        <button
                          type="button"
                          disabled={hunkBusy}
                          onClick={() => void applyHunk(h, "discard")}
                          title="丢弃这块改动，恢复到暂存区状态（不可恢复，除非已提交）"
                          className="shrink-0 rounded-md px-2 py-0.5 text-micro text-warn-text transition-colors hover:bg-hover disabled:opacity-50"
                        >
                          丢弃
                        </button>
                        {!inWs && (
                          <button
                            type="button"
                            disabled={hunkBusy}
                            onClick={() => void applyHunk(h, "stage")}
                            title="把这块改动放进暂存区；勾选此文件点「提交」时只提交已暂存的块"
                            className="shrink-0 rounded-md px-2 py-0.5 text-micro text-l3 transition-colors hover:bg-hover hover:text-l1 disabled:opacity-50"
                          >
                            暂存
                          </button>
                        )}
                      </>
                    )}
                  </div>
                  {body.length === 0 ? (
                    <p className="px-2 py-1.5 text-micro text-l4">空文件</p>
                  ) : (
                    <DiffBody
                      lines={body.slice(0, DIFF_LINE_CAP)}
                      start={parseHunkHeader(h.header) ?? { oldStart: 1, newStart: 1 }}
                    />
                  )}
                  {body.length > DIFF_LINE_CAP && (
                    <p className="flex items-center justify-between gap-2 border-t border-hairline px-2 py-1 text-micro text-l4">
                      <span>
                        仅渲染前 {DIFF_LINE_CAP} 行（共 {body.length} 行）
                        {inWs && onOpenReview ? "，完整内容见审阅视图" : ""}
                      </span>
                      {canOpen && (
                        <button
                          type="button"
                          onClick={() => openFileInPane(f.path)}
                          className="shrink-0 text-l3 underline-offset-2 hover:text-l1 hover:underline"
                        >
                          打开完整文件
                        </button>
                      )}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        ) : diffError ? (
          <p className="p-2 text-xs text-err-text">{diffError}</p>
        ) : diffLines ? (
          <>
            {hunksStaged && !inWs && (
              <div className="flex items-center gap-2 border-b border-hairline bg-strip px-2.5 py-1.5 text-micro text-l3">
                <span className="min-w-0 flex-1">改动已全部暂存；勾选后点「提交」将提交这些内容</span>
                {!readOnly && (
                  <button
                    type="button"
                    disabled={hunkBusy}
                    onClick={() => void unstageFile(f.path)}
                    className="shrink-0 rounded-md border border-field px-2 py-0.5 text-l2 transition-colors hover:bg-hover hover:text-l1 disabled:opacity-50"
                  >
                    取消暂存
                  </button>
                )}
              </div>
            )}
            <DiffBody lines={diffLines.slice(0, DIFF_LINE_CAP)} />
            {diffLines.length > DIFF_LINE_CAP && (
              <p className="flex items-center justify-between gap-2 border-t border-hairline px-2 py-1 text-micro text-l4">
                <span>
                  仅渲染前 {DIFF_LINE_CAP} 行（共 {diffLines.length} 行）
                  {inWs && onOpenReview ? "，完整内容见审阅视图" : ""}
                </span>
                {canOpen && (
                  <button
                    type="button"
                    onClick={() => openFileInPane(f.path)}
                    className="shrink-0 text-l3 underline-offset-2 hover:text-l1 hover:underline"
                  >
                    打开完整文件
                  </button>
                )}
              </p>
            )}
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      {/* 头部（次工具条 h-8 bg-strip，与预览/版本工具条同规格）：分支 / 任务基准 / 总增删 / 去评审 / 刷新 */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-hairline bg-strip px-3 text-xs">
        {status?.isRepo ? (
          inWs ? (
            <>
              <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-l1">
                <GitBranch size={13} strokeWidth={1.8} className="shrink-0 text-l3" aria-hidden="true" />
                <span className="truncate">{status.branch}</span>
              </span>
              <span
                className="shrink-0 rounded-md bg-inset px-1.5 py-0.5 text-micro text-l3"
                title={
                  wsDiff!.baseBranch === "HEAD"
                    ? "隔离运行的改动：相对这棵树最近一次提交，加上还没跟踪的新文件"
                    : `merge-base：任务改动是相对主分支 ${wsDiff!.baseBranch} 的共同起点（${wsDiff!.mergeBase.slice(0, 7)}）计算的`
                }
              >
                {/* Run 隔离树的基准是 HEAD，写「相对主分支 HEAD」读不通 */}
                {wsDiff!.baseBranch === "HEAD" ? "未提交的改动" : `相对主分支 ${wsDiff!.baseBranch}`}
              </span>
              {(wsDiff!.totalAdd > 0 || wsDiff!.totalDel > 0) && (
                <span className="ml-auto shrink-0 font-mono text-micro tabular-nums">
                  <span className="text-add">+{wsDiff!.totalAdd}</span>{" "}
                  <span className="text-del">-{wsDiff!.totalDel}</span>
                </span>
              )}
              {onOpenReview && (
                <button
                  type="button"
                  onClick={() => onOpenReview(cwd)}
                  title="打开工作区评审（查看完整改动、核验并合并回主项目）"
                  className={`${wsDiff!.totalAdd > 0 || wsDiff!.totalDel > 0 ? "" : "ml-auto"} inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-field bg-canvas px-2 text-xs font-medium text-l1 transition-colors hover:bg-hover`}
                >
                  <ClipboardCheck aria-hidden="true" size={13} strokeWidth={1.8} />
                  去评审
                </button>
              )}
            </>
          ) : (
            <>
              <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-l1">
                <GitBranch size={13} strokeWidth={1.8} className="shrink-0 text-l3" aria-hidden="true" />
                <span className="truncate">{status.branch}</span>
              </span>
              {(status.ahead > 0 || status.behind > 0) && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-inset px-1.5 py-0.5 font-mono text-micro tabular-nums text-l3">
                  {status.ahead > 0 && (
                    <span className="inline-flex items-center gap-0.5">
                      <ArrowUp size={11} strokeWidth={2} aria-hidden="true" />
                      {status.ahead}
                    </span>
                  )}
                  {status.behind > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-warn-text">
                      <ArrowDown size={11} strokeWidth={2} aria-hidden="true" />
                      {status.behind}
                    </span>
                  )}
                </span>
              )}
              {(status.totalAdd > 0 || status.totalDel > 0) && (
                <span className="ml-auto shrink-0 font-mono text-micro tabular-nums">
                  <span className="text-add">+{status.totalAdd}</span>{" "}
                  <span className="text-del">-{status.totalDel}</span>
                </span>
              )}
            </>
          )
        ) : (
          <span className="inline-flex items-center gap-1.5 text-l4">
            <GitBranch size={13} strokeWidth={1.8} aria-hidden="true" />
            git
          </span>
        )}
        <button
          type="button"
          onClick={() => void refresh({ forceDiff: true, showSpinner: true })}
          disabled={refreshing}
          title="刷新改动状态与当前 diff"
          aria-label="刷新改动"
          className={`${
            status?.isRepo &&
            ((inWs && (wsDiff!.totalAdd > 0 || wsDiff!.totalDel > 0 || Boolean(onOpenReview))) ||
              (!inWs && (status.totalAdd > 0 || status.totalDel > 0)))
              ? ""
              : "ml-auto"
          } flex size-6 shrink-0 items-center justify-center rounded-md text-l3 transition-colors hover:bg-hover hover:text-l1 disabled:opacity-40`}
        >
          <RefreshCw
            size={13}
            strokeWidth={1.8}
            aria-hidden="true"
            className={refreshing ? "animate-spin" : undefined}
          />
        </button>
      </div>
      {status?.merging && !readOnly && (
        <div className="mx-2.5 mt-2 flex shrink-0 items-center gap-2 rounded-lg border border-warn-text/25 bg-warn/20 px-3 py-2 text-xs text-warn-text">
          <TriangleAlert size={14} strokeWidth={1.8} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            正在合并，有冲突。解决后提交，或取消合并。
          </span>
          <button
            type="button"
            className="shrink-0 rounded-md border border-field bg-strip px-2.5 py-1 text-xs text-l2 transition-colors hover:bg-hover hover:text-l1 disabled:opacity-50"
            disabled={running !== null}
            onClick={() => void abortMerge()}
          >
            {running === "abort" ? "取消中…" : "取消合并"}
          </button>
        </div>
      )}

      {/* 改动主从视图：未选中全宽文件列表；选中后左栏 diff 主区 + 右栏紧凑文件列 */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {error ? (
          <div className="p-3">
            <p className="text-xs text-err-text">{error}</p>
            {/* git 缺失（后端固定错误串，见 dep-check.ts）：错误行旁给一键安装出口 */}
            <GitInstallOffer error={error} onInstalled={() => void refresh()} />
          </div>
        ) : !status ? (
          <div className="p-3"><LoadingRows compact /></div>
        ) : !status.isRepo ? (
          <div className="p-3">
            <EmptyState title="不是 git 仓库" detail={cwd} />
          </div>
        ) : files.length === 0 ? (
          <div className="p-3">
            <EmptyState
              title="没有未提交的改动"
              detail={inWs ? "可以继续下一步。" : "工作区很干净。"}
            />
          </div>
        ) : (
          // 白话分组：组名给中文，状态字母保留为文件名前的小号 mono 徽标（悬浮 title 双语义）
          <div className="flex h-full">
            {split && diffFile && (
              <div className="min-w-0 flex-1 overflow-auto p-2.5">
                {renderDiffContent(diffFile)}
              </div>
            )}
            {!(split && listCollapsed) && (
            <div
              className={
                split
                  ? "w-48 shrink-0 overflow-auto border-l border-hairline p-1.5"
                  : "min-w-0 flex-1 overflow-auto p-2"
              }
            >
              {groupFilesByStatus(files).map((group) => (
                <div key={group.key} className="mt-2.5 first:mt-0">
                  <div
                    className={`mb-1 flex items-center gap-1.5 px-1.5 text-micro ${
                      group.key === "unmerged" ? "text-warn-text" : "text-l4"
                    }`}
                  >
                    {group.key === "unmerged" && (
                      <TriangleAlert size={11} strokeWidth={2} aria-hidden="true" />
                    )}
                    <span className="font-medium">{group.label}</span>
                    <span className="rounded-full bg-inset px-1.5 py-px tabular-nums text-l3">
                      {group.files.length}
                    </span>
                  </div>
                  {group.files.map((f) =>
                    split ? renderCompactRow(f) : renderFullRow(f),
                  )}
                </div>
              ))}
            </div>
            )}
          </div>
        )}
      </div>

      {/* 交给下一步的文件（内部叫提货单 artifacts.yaml，仅工作区任务视图）：产物本身不进 git，
          清单随提交传递，下一步开工时列进任务书。界面不露 md5 / 工作区名，收进悬停 */}
      {inWs && (
        <div className="shrink-0 border-t border-hairline px-3 py-2.5">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-l3">交给下一步的文件</span>
            {!readOnly && (
              <button
                type="button"
                onClick={() => void registerArtifact()}
                disabled={registering}
                className="shrink-0 rounded-md px-2 py-1 text-xs text-l2 transition-colors hover:bg-hover hover:text-l1 disabled:opacity-50"
              >
                {registering ? "加入中…" : "加入文件…"}
              </button>
            )}
          </div>
          {artifacts.length === 0 ? (
            <p className="text-xs leading-relaxed text-l4">
              PDF、Word 等成品不在上面的改动里，加到这里下一步的 AI 才读得到
            </p>
          ) : (
            <ul className="max-h-32 space-y-0.5 overflow-auto">
              {artifacts.map((a) => (
                <li
                  key={a.path}
                  title={`${a.path}\n${formatSize(a.size)} · 来自工作区「${a.producedBy}」 · 校验值 ${a.hash.slice(0, 8)}`}
                  className="rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-hover"
                >
                  <div className="flex items-center gap-1.5">
                    <FileTypeBadge path={a.path} />
                    <span className="min-w-0 flex-1 truncate text-l2">{a.name}</span>
                    <span className="shrink-0 text-micro tabular-nums text-l4">{formatSize(a.size)}</span>
                    {isArtifactPreviewable(a.path) && (
                      <button
                        type="button"
                        onClick={() => {
                          if (onOpenFile) {
                            onOpenFile(a.path);
                          } else {
                            setPreviewReq({ path: a.path, name: a.name });
                            setPage("terminal");
                          }
                        }}
                        title="在 Mesa 里预览这份文件"
                        className="shrink-0 rounded-md px-1.5 py-0.5 text-l3 transition-colors hover:bg-hover hover:text-l1"
                      >
                        查看
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        void revealItemInDir(a.path).catch((e) => setError(String(e)))
                      }
                      className="shrink-0 rounded-md px-1.5 py-0.5 text-l3 transition-colors hover:bg-hover hover:text-l1"
                    >
                      {revealFolderLabel(IS_MAC, IS_WINDOWS)}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 提交区：干净且无待推送提交/无报错时收起，不留一整块灰色禁用死栏 */}
      {status?.isRepo && !readOnly && (hasChanges || status.ahead > 0 || output !== null) && (
        <div className="shrink-0 border-t border-hairline bg-strip/60 p-2.5">
          {hasChanges && (
            <div className="mb-2 flex items-center justify-between text-xs text-l3">
              <span className="tabular-nums">
                {/* 工作区模式上面列的是累计改动，提交的只是还没提交的那部分：写清楚，免得和列表条数对不上 */}
                {inWs
                  ? `这次提交 ${selectedFiles.length} 个未提交的文件`
                  : `${selectedFiles.length} / ${files.length}`}
              </span>
              {!inWs && (
                <button
                  type="button"
                  onClick={() =>
                    setSelectedPaths(allSelected ? new Set() : new Set(files.map((file) => file.path)))
                  }
                  className="rounded-md px-1.5 py-0.5 text-xs text-l3 transition-colors hover:bg-hover hover:text-l1"
                >
                  {allSelected ? "清空" : "全选"}
                </button>
              )}
            </div>
          )}
          {!hasChanges && status.ahead > 0 ? (
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-xs text-l3">
                本地有 {status.ahead} 个提交未推送到远程
              </span>
              <button
                type="button"
                onClick={() => void retryPush()}
                disabled={running !== null}
                title="git push：推送本地未推送的提交到远程"
                className={`${primaryActionClass} shrink-0`}
              >
                {running === "push" ? "推送中…" : `推送 ↑${status.ahead}`}
              </button>
            </div>
          ) : hasChanges ? (
            <>
              <div className="mb-2 flex items-center gap-1.5">
                <input
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onCompositionStart={commitImeRef.current.onCompositionStart}
                  onCompositionEnd={commitImeRef.current.onCompositionEnd}
                  onKeyDown={(e) => {
                    if (commitImeRef.current.blocksKey(e)) return;
                    // Enter / ⌘Enter 都是「快速提交」（按钮上标注 ⌘Enter 是熟手提示）
                    if (e.key === "Enter" && canCommit) void doCommit(false);
                  }}
                  placeholder="说明（可空）"
                  disabled={running !== null || aiBusy}
                  className={`${fieldClass} h-8 disabled:opacity-50`}
                />
                <button
                  type="button"
                  onClick={genMessage}
                  disabled={!canCommit || aiBusy || running !== null}
                  aria-label="AI 生成提交说明"
                  title="生成 Commit Message（AI 分析 diff 后填入输入框，可再改；速度取决于模型）"
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-field bg-strip text-l2 transition-colors hover:bg-inset hover:text-l1 disabled:cursor-not-allowed disabled:opacity-45 ${
                    aiBusy ? "animate-pulse text-cta" : ""
                  }`}
                >
                  <Sparkles size={14} strokeWidth={1.8} aria-hidden="true" />
                </button>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void doCommit(false)}
                  disabled={!canCommit}
                  title={`git commit：把勾选的改动提交到当前分支（${IS_MAC ? "⌘" : "Ctrl+"}Enter）`}
                  className={`${primaryActionClass} flex-1`}
                >
                  {running === "commit" ? "提交中…" : "提交"}
                </button>
                <button
                  type="button"
                  onClick={() => void doCommit(true)}
                  disabled={!canCommit}
                  title="git commit + push：提交到当前分支并推送到远程"
                  className={`${secondaryActionClass} flex-1`}
                >
                  {running === "push" ? "推送中…" : "提交并推送"}
                </button>
              </div>
            </>
          ) : null}
          {output && (
            <div className="mt-2 rounded-lg ccode-well p-2.5 text-xs">
              <pre
                className={`max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono ${
                  output.phase === "push" ? "text-warn-text" : "text-err-text"
                }`}
              >
                {output.text}
              </pre>
              {output.phase === "push" && (
                <button
                  type="button"
                  onClick={() => void retryPush()}
                  disabled={running !== null}
                  className={`${compactPrimaryActionClass} mt-2`}
                >
                  {running === "push" ? "推送中…" : "重试推送"}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {/* 提交/推送成功 toast：主题 CTA 绿，右下角浮出，2.5s 自动淡出 */}
      {toast && (
        <div
          className={`ccode-float-surface fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-lg border border-cta-bd bg-cta px-3.5 py-2 text-xs font-medium text-cta-text transition-all duration-300 ${
            toast.hiding ? "translate-y-1 opacity-0" : "translate-y-0 opacity-100"
          }`}
        >
          <Check size={14} strokeWidth={2.2} aria-hidden="true" />
          <span>{toast.text}</span>
          {toast.afterPush && onOpenPr && (
            <button
              type="button"
              className="ml-1 underline decoration-cta-text/50 underline-offset-2 hover:decoration-cta-text disabled:no-underline disabled:opacity-80"
              disabled={prOpening}
              onClick={() => {
                if (prOpening) return;
                if (toastTimerRef.current) {
                  clearTimeout(toastTimerRef.current);
                  toastTimerRef.current = null;
                }
                setPrOpening(true);
                void Promise.resolve(onOpenPr(cwd)).finally(() => {
                  setPrOpening(false);
                  setToast((t) => (t ? { ...t, hiding: true } : t));
                  toastTimerRef.current = setTimeout(() => setToast(null), 300);
                });
              }}
            >
              {prOpening ? "打开中…" : "打开 Pull Request"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** memo：父级重渲染不级联到 git 面板（其内部轮询/状态自更新不受影响） */
export default memo(GitPanel);
