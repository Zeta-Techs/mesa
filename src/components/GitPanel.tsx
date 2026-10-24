import { memo, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { File, Maximize2, PanelRightClose, PanelRightOpen } from "lucide-react";
import type {
  ArtifactEntryDto,
  GitCommitResultDto,
  GitFileDto,
  WorkspaceDiffDto,
} from "../types";
import {
  Checkbox,
  EmptyState,
  fieldClass,
  FoldMark,
  hoverRevealClass,
  LoadingRows,
  InlineNotice,
} from "./PageFrame";
import { confirmDialog } from "./ConfirmDialog";
import ImagePairView, { isImagePath } from "./ImagePairView";
import { useAppStore } from "../store";
import { defaultCommitMessage } from "../git-commit-message";
import { GitInstallOffer } from "../dep-install";
import { fileTypeIcon } from "../file-icons";
import { groupFilesByStatus, statusBadgeTitle } from "../git-status-groups";
import { IS_MAC } from "../hotkeys";
import { hunkLabel, pairIntraline } from "../diff-intraline";

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

/** hunk patch 去掉文件头与 @@ 行，只留展示用内容行 */
function hunkBodyLines(patch: string): string[] {
  const lines = patch.split("\n");
  const at = lines.findIndex((l) => l.startsWith("@@"));
  const body = at >= 0 ? lines.slice(at + 1) : lines;
  if (body.length > 0 && body[body.length - 1] === "") body.pop();
  return body;
}

/**
 * diff 正文：长行折行（窄栏里每块各带一条横向滚动条没法读，2026-10-23 用户），前缀 +/- 悬在左边、折下来的行对齐正文；
 * 成对的删加行标出改了的那一段（diff-intraline.ts pairIntraline）
 */
function DiffBody({ lines, lineClass }: { lines: readonly string[]; lineClass: (line: string) => string }) {
  const marks = pairIntraline(lines);
  return (
    <pre className="py-1 font-mono text-xs leading-5">
      {lines.map((line, index) => {
        const mark = marks.get(index);
        const hl = line.startsWith("+") ? "ccode-diff-hl-add" : "ccode-diff-hl-del";
        return (
          <span
            key={`${index}:${line.slice(0, 24)}`}
            className={`block whitespace-pre-wrap pr-2 pl-[calc(0.5rem+1ch)] [overflow-wrap:anywhere] ${lineClass(line)}`}
            style={{ textIndent: "-1ch" }}
          >
            {mark ? (
              <>
                {line.slice(0, 1 + mark[0])}
                <span className={hl}>{line.slice(1 + mark[0], 1 + mark[1])}</span>
                {line.slice(1 + mark[1])}
              </>
            ) : (
              line || " "
            )}
          </span>
        );
      })}
    </pre>
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

/** 文件类型小徽标（固定识别色，不随主题）；未收录类型画通用文件图标（与 FileTypeMark 同口径） */
function FileTypeBadge({ path }: { path: string }) {
  const icon = fileTypeIcon(path);
  if (!icon) {
    return (
      <span aria-hidden="true" className="flex h-4 min-w-4 shrink-0 items-center justify-center text-l4">
        <File size={13} strokeWidth={1.6} />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-sm px-0.5 font-mono text-micro leading-4"
      style={{ color: icon.color, backgroundColor: `${icon.color}26` }}
    >
      {icon.label}
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
  onOpenReview,
  onOpenPr,
  readOnly = false,
}: {
  cwd: string;
  /** 右侧面板打开且页面可见；不可见时暂停轮询 */
  visible: boolean;
  /** 外部刷新信号（如 fs-changed 文件监听事件），变化时立即刷新 */
  refreshKey?: number;
  onTotals: (t: GitSummary) => void;
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
  // 提货单（§11.3 机制五）：仅工作区任务视图加载；产物本体不进 git，清单随提交传递
  const [artifacts, setArtifacts] = useState<ArtifactEntryDto[]>([]);
  const [registering, setRegistering] = useState(false);
  // PDF 产物「查看」：复用 P2a 预览链路（previewReq → 终端页 PdfPreview）
  const setPreviewReq = useAppStore((s) => s.setPreviewReq);
  const setPage = useAppStore((s) => s.setPage);
  const diffFocusReq = useAppStore((s) => s.diffFocusReq);
  const setDiffFocusReq = useAppStore((s) => s.setDiffFocusReq);
  const [diffPath, setDiffPath] = useState<string | null>(null);
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

  const refresh = useCallback(async () => {
    // 两个查询同时发（原先串行：工作区探测慢时分支 / 改动要等它一起才出来，2026-10-23 用户：接着聊时不会一下显示）
    const diffReq = invoke<WorkspaceDiffDto>("workspace_diff", { worktreePath: cwd }).catch(() => null);
    let s: GitStatusDto | null = null;
    try {
      s = await invoke<GitStatusDto>("git_status", { cwd });
      setStatus(s);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
    // 工作区探测：cwd 落在 worktree 里时切任务 diff 视图；失败/非工作区保持普通视图
    const diff = await diffReq;
    const d: WorkspaceDiffDto | null = diff?.inWorkspace ? diff : null;
    setWsDiff(d);
    // 提货单：工作区根的 artifacts.yaml（未提交也可见，提交后才随分支传递）
    if (d) {
      try {
        setArtifacts(
          await invoke<ArtifactEntryDto[]>("read_artifacts_manifest", {
            repoPath: cwd,
          }),
        );
      } catch {
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
    onTotals({
      add: d ? d.totalAdd : (s?.totalAdd ?? 0),
      del: d ? d.totalDel : (s?.totalDel ?? 0),
      isRepo: s?.isRepo ?? false,
      branch: s?.branch ?? "",
      ahead: s?.ahead ?? 0,
      behind: s?.behind ?? 0,
      inWorkspace: d !== null,
      files: d ? d.files : (s?.files ?? []),
    });
  }, [cwd, onTotals]);

  // git 缺失时的一键安装出口见 GitInstallOffer（与设置页诊断区共用 dep-install 管线）

  // cwd / 可见性变化：重置勾选与展开的 diff 并立即刷新；可见时每 8s 轮询
  useEffect(() => {
    diffRequestRef.current += 1;
    setSelectedPaths(new Set());
    setDiffPath(null);
    setDiffDetail(null);
    setHunks(null);
    setHunksStaged(false);
    setDiffError(null);
    void refresh();
    if (!visible) return;
    const timer = setInterval(() => void refresh(), 8000);
    return () => clearInterval(timer);
  }, [refresh, visible]);

  // 外部刷新信号（fs-changed 文件监听等）：只刷新数据，不动勾选与展开的 diff；
  // refresh 自身会把已失效的勾选安全剪枝
  useEffect(() => {
    if (!refreshKey) return;
    void refresh();
  }, [refreshKey, refresh]);

  // 卸载时清理 toast 定时器，避免组件销毁后 setState
  useEffect(
    () => () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    },
    [],
  );

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
      title: "选择要登记的产物文件",
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
      showToast(`已登记产物「${entry.name}」`);
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

  /** 展开内容加载：未提交文件优先拉 hunk（按块丢弃/暂存）；hunk 不可用或为空时回落只读文本 diff */
  async function loadExpandedDiff(file: GitFileDto) {
    const request = ++diffRequestRef.current;
    setDiffPath(file.path);
    setDiffDetail(null);
    setHunks(null);
    setHunksStaged(false);
    setDiffError(null);
    // 图片文件不走文本 diff，展开区改渲染双栏对比（ImagePairView 自行取数）
    if (isImagePath(file.path)) {
      setDiffLoading(false);
      return;
    }
    setDiffLoading(true);
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
            return;
          }
          // hunks 为空（如改动已全部暂存）→ 走只读文本展示
        } catch {
          // 二进制/过大/非 UTF-8/不在未提交清单 → 回落只读文本
        }
      }
      const detail = inWs
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
      if (request === diffRequestRef.current) setDiffDetail(detail);
    } catch (e) {
      if (request === diffRequestRef.current) setDiffError(String(e));
    } finally {
      if (request === diffRequestRef.current) setDiffLoading(false);
    }
  }

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
          ? "已暂存这块改动，勾选该文件保存到任务分支时提交"
          : "已丢弃这块改动",
      );
    } catch (e) {
      setDiffError(String(e));
    } finally {
      setHunkBusy(false);
      await refresh();
      // hunk 索引可能已变：展开状态还在就重拉（文件已消失时由剪枝 effect 清理）
      if (diffPath === path) {
        const file = files.find((f) => f.path === path) ?? {
          path,
          status: "M",
          additions: null,
          deletions: null,
        };
        await loadExpandedDiff(file);
      }
    }
  }

  const focusSeen = useRef<string | null>(null);
  useEffect(() => {
    if (!diffFocusReq || diffFocusReq.cwd !== cwd) return;
    // status 还没加载完：等它（deps 里有 status?.files，就绪后自动重跑）。
    // 抢先判「不在改动里」会把目标 diff 误回落成纯文本预览（2026-10-11 复核）。
    if (!status) return;
    const mark = `${diffFocusReq.cwd}:${diffFocusReq.path}`;
    if (focusSeen.current === mark) return;
    focusSeen.current = mark;
    const file = (status.files ?? []).find((item) => item.path === diffFocusReq.path);
    if (!file) {
      // 确实不在本次改动里：回落成文件预览——点了总得有反应，不能静默吞掉
      const rel = diffFocusReq.path.replace(/\\/g, "/");
      const abs = `${cwd.replace(/[\\/]$/, "")}/${rel}`;
      setDiffFocusReq(null);
      setPreviewReq({ path: abs, name: rel.split("/").pop() ?? rel, root: cwd });
      return;
    }
    setDiffFocusReq(null);
    void loadExpandedDiff(file);
  }, [cwd, diffFocusReq, setDiffFocusReq, status]);

  async function toggleDiff(file: GitFileDto) {
    if (diffPath === file.path) {
      diffRequestRef.current += 1;
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

  /** 全宽模式文件行：勾选 + 状态徽标 + 路径 + 增删数 + hover diff 提示 */
  function renderFullRow(f: GitFileDto) {
    const expanded = diffPath === f.path;
    return (
      <div
        key={`${f.status}:${f.path}`}
        className="border-b border-hairline/60 last:border-b-0"
      >
        <div className="flex items-center gap-1 px-1 py-0.5 text-xs">
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
            className="group flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 py-1 text-left hover:bg-hover"
          >
            <FoldMark open={expanded} />
            <span title={statusBadgeTitle(f.status)} className="contents">
              <FileTypeBadge path={f.path} />
            </span>
            <PathLabel path={f.path} status={f.status} />
            {(f.additions !== null || f.deletions !== null) && (
              <span className="shrink-0 font-mono">
                {f.additions !== null && (
                  <span className="text-add">+{f.additions}</span>
                )}{" "}
                {f.deletions !== null && f.deletions > 0 && (
                  <span className="text-del">-{f.deletions}</span>
                )}
              </span>
            )}
            {/* WKWebView 不显示 title 悬浮：diff 入口用可见的 hover 提示代替 */}
            <span
              className={`${hoverRevealClass} shrink-0 rounded-sm px-1 text-micro text-l4`}
            >
              {expanded ? "收起" : "diff"}
            </span>
          </button>
        </div>
        {expanded && !wide && <div className="pb-2 pl-1 pr-0.5">{renderDiffContent(f, true)}</div>}
      </div>
    );
  }

  /** 分栏模式右栏紧凑行：状态徽标 + 文件名（全路径进 title），选中行浅填充 */
  function renderCompactRow(f: GitFileDto) {
    const active = diffPath === f.path;
    return (
      <div key={`${f.status}:${f.path}`} className="flex items-center gap-1">
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
          className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1.5 py-1 text-left ${
            active ? "bg-inset text-l1" : "hover:bg-hover"
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

  /** 左栏 diff 主区：文件头（路径 + 二进制/截断标记 + 收起）+ 逐 hunk / 只读文本 / 图片对比 */
  function renderDiffContent(f: GitFileDto, inline = false) {
    const diffLines = diffDetail ? diffDetail.text.split("\n") : null;
    return (
      <div className="overflow-hidden rounded-md bg-strip">
        {/* 行内展开时路径就在上面那一行，文件头只在有「二进制 / 已截断」要说时出现 */}
        {(!inline || diffDetail?.binary || diffDetail?.truncated) && (
        <div className="flex items-center gap-2 border-b border-hairline px-2 py-1 text-micro text-l4">
          <span className="min-w-0 flex-1 truncate font-mono">{inline ? "" : f.path}</span>
          {diffDetail?.binary && <span>二进制</span>}
          {diffDetail?.truncated && (
            <span className="text-warn-text">已截断</span>
          )}
          {!inline && (
          <button
            type="button"
            onClick={toggleList}
            title={listCollapsed ? "展开右边的文件列表" : "收起右边的文件列表，diff 占满整栏"}
            aria-label={listCollapsed ? "展开文件列表" : "收起文件列表"}
            aria-pressed={listCollapsed}
            className="shrink-0 rounded-sm p-0.5 text-l3 hover:bg-hover hover:text-l1"
          >
            {listCollapsed ? (
              <PanelRightOpen aria-hidden="true" className="h-3.5 w-3.5" />
            ) : (
              <PanelRightClose aria-hidden="true" className="h-3.5 w-3.5" />
            )}
          </button>
          )}
          {!inline && (
          <button
            type="button"
            onClick={() => void toggleDiff(f)}
            title="收起 diff，回到全宽文件列表"
            className="shrink-0 rounded-sm px-1 text-l3 hover:bg-hover hover:text-l1"
          >
            ×
          </button>
          )}
        </div>
        )}
        {isImagePath(f.path) ? (
          <ImagePairView cwd={cwd} path={f.path} />
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
            {hunksStaged && (
              <InlineNotice tone="warn" size="micro" className="border-b border-hairline px-2 py-1">该文件已有部分内容暂存；勾选它「保存到任务分支」时只提交已暂存的块，下方的块留在工作区</InlineNotice>
            )}
            {hunks.map((h) => {
              const body = hunkBodyLines(h.patch);
              return (
                <div
                  key={`${h.index}:${h.header}`}
                  className="border-b border-hairline/60 last:border-b-0"
                >
                  <div className="flex items-center gap-1 border-b border-hairline/60 bg-inset px-2 py-0.5">
                    {/* 块头白话「第 340 行 · 小标题」，git 原样的 @@ 头放悬停 */}
                    <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-micro" title={h.header}>
                      <span className="shrink-0 text-l3">{hunkLabel(h.header).line}</span>
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
                          className="shrink-0 rounded-sm px-1.5 py-0.5 text-micro text-warn-text hover:bg-hover disabled:opacity-50"
                        >
                          丢弃
                        </button>
                        <button
                          type="button"
                          disabled={hunkBusy}
                          onClick={() => void applyHunk(h, "stage")}
                          title="把这块改动放进暂存区；勾选此文件「保存到历史」时只提交已暂存的块"
                          className="shrink-0 rounded-sm px-1.5 py-0.5 text-micro text-l3 hover:bg-hover hover:text-l1 disabled:opacity-50"
                        >
                          暂存
                        </button>
                      </>
                    )}
                  </div>
                  <DiffBody lines={body.slice(0, DIFF_LINE_CAP)} lineClass={diffLineClass} />
                  {body.length > DIFF_LINE_CAP && (
                    <p className="border-t border-hairline px-2 py-1 text-micro text-l4">
                      仅渲染前 {DIFF_LINE_CAP} 行（共 {body.length}{" "}
                      行），完整内容见审阅视图
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
            {hunksStaged && (
              <p className="border-b border-hairline px-2 py-1 text-micro text-l3">
                改动已全部暂存；勾选后「保存到任务分支」将提交这些内容
              </p>
            )}
            <DiffBody lines={diffLines.slice(0, DIFF_LINE_CAP)} lineClass={diffLineClass} />
            {diffLines.length > DIFF_LINE_CAP && (
              <p className="border-t border-hairline px-2 py-1 text-micro text-l4">
                仅渲染前 {DIFF_LINE_CAP} 行（共 {diffLines.length}{" "}
                行），完整内容见审阅视图
              </p>
            )}
          </>
        ) : null}
      </div>
    );
  }

  // 增删整行铺语义底色（diff-add/del 令牌）：用户拍板「可以铺」，比细边更清晰；
  // 深色主题深底浅字，浅色主题由 App.css 覆写为浅底深字（GitHub 式）；
  // 正文保持中性阅读色（text-l2），与审阅视图 DiffSide 同口径——整文件新增不染成绿字墙
  function diffLineClass(line: string): string {
    if (line.startsWith("@@")) return "bg-inset text-link";
    if (line.startsWith("+") && !line.startsWith("+++"))
      return "bg-diff-add-bg text-l2";
    if (line.startsWith("-") && !line.startsWith("---"))
      return "bg-diff-del-bg text-l2";
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("---") ||
      line.startsWith("+++")
    )
      return "text-l4";
    return "text-l2";
  }

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      {/* 头部：分支 / 上游差距（工作区模式：任务基准）/ 总增删 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-2 text-xs">
        {status?.isRepo ? (
          inWs ? (
            <>
              <span className="font-medium text-l1">⑂ {status.branch}</span>
              <span
                className="text-l3"
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
                <span className="ml-auto font-mono">
                  <span className="text-add">+{wsDiff!.totalAdd}</span>{" "}
                  <span className="text-del">-{wsDiff!.totalDel}</span>
                </span>
              )}
              {onOpenReview && (
                <button
                  type="button"
                  onClick={() => onOpenReview(cwd)}
                  title="展开任务审阅"
                  className={`${wsDiff!.totalAdd > 0 || wsDiff!.totalDel > 0 ? "" : "ml-auto"} flex h-7 items-center gap-1 rounded-sm px-1.5 text-l2 hover:bg-hover hover:text-l1`}
                >
                  <Maximize2 aria-hidden="true" className="h-3.5 w-3.5" />
                  审阅
                </button>
              )}
            </>
          ) : (
            <>
              <span className="font-medium text-l1">⑂ {status.branch}</span>
              {(status.ahead > 0 || status.behind > 0) && (
                <span className="text-l3">
                  {status.ahead > 0 && `↑${status.ahead}`}
                  {status.behind > 0 && ` ↓${status.behind}`}
                </span>
              )}
              {(status.totalAdd > 0 || status.totalDel > 0) && (
                <span className="ml-auto font-mono">
                  <span className="text-add">+{status.totalAdd}</span>{" "}
                  <span className="text-del">-{status.totalDel}</span>
                </span>
              )}
            </>
          )
        ) : (
          <span className="text-l4">git</span>
        )}
      </div>
      {status?.merging && !readOnly && (
        <div className="flex shrink-0 items-center gap-2 border-b border-hairline bg-warn px-3 py-2 text-xs text-warn-text">
          <span className="min-w-0 flex-1">
            正在合并，有冲突。解决后提交，或取消合并。
          </span>
          <button
            type="button"
            className="shrink-0 rounded-md border border-field bg-strip px-2 py-1 text-xs text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
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
          <div className="p-2"><LoadingRows compact /></div>
        ) : !status.isRepo ? (
          <p className="p-3 text-sm text-l4">
            不是 git 仓库
            <span className="block text-xs text-l4" title={cwd}>
              {cwd}
            </span>
          </p>
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
              <div className="min-w-0 flex-1 overflow-auto px-2 py-1.5">
                {renderDiffContent(diffFile)}
              </div>
            )}
            {!(split && listCollapsed) && (
            <div
              className={
                split
                  ? "w-44 shrink-0 overflow-auto border-l border-hairline p-1"
                  : "min-w-0 flex-1 overflow-auto p-2"
              }
            >
              {groupFilesByStatus(files).map((group) => (
                <div key={group.key}>
                  <p
                    className={`px-1 pb-0.5 pt-1.5 text-micro ${
                      group.key === "unmerged" ? "text-warn-text" : "text-l4"
                    }`}
                  >
                    {group.label} {group.files.length}
                  </p>
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

      {/* 产物区（提货单，仅工作区任务视图）：产物本身不进 git，清单 artifacts.yaml 会随提交传递 */}
      {inWs && (
        <div className="shrink-0 border-t border-hairline p-2">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-xs text-l3">产物（提货单）</span>
            {!readOnly && (
              <button
                type="button"
                onClick={() => void registerArtifact()}
                disabled={registering}
                className="shrink-0 rounded-sm px-2 py-1 text-xs text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
              >
                {registering ? "登记中…" : "登记产物"}
              </button>
            )}
          </div>
          {artifacts.length === 0 ? (
            <p className="text-xs text-l4">
              暂无登记产物；产物本身不进 git，清单 artifacts.yaml 会随提交传递
            </p>
          ) : (
            <ul className="max-h-32 overflow-auto">
              {artifacts.map((a) => (
                <li
                  key={a.path}
                  title={`${a.path}\nmd5 ${a.hash} · ${formatSize(a.size)} · 来自「${a.producedBy}」`}
                  className="px-1 py-0.5 text-xs"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-l2">{a.name}</span>
                    {/\.pdf$/i.test(a.path) && (
                      <button
                        type="button"
                        onClick={() => {
                          setPreviewReq({ path: a.path, name: a.name });
                          setPage("terminal");
                        }}
                        title="在终端页内嵌预览该 PDF"
                        className="shrink-0 rounded-sm px-1.5 py-0.5 text-l3 hover:bg-hover hover:text-l1"
                      >
                        查看
                      </button>
                    )}
                    <span className="shrink-0 font-mono text-l4">
                      {a.hash.slice(0, 8)}
                    </span>
                    <span className="shrink-0 text-l4">{formatSize(a.size)}</span>
                    <span className="shrink-0 text-l4">← {a.producedBy}</span>
                  </div>
                  <div className="truncate font-mono text-micro text-l4">{a.path}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 提交区 */}
      {status?.isRepo && !readOnly && (
        <div className="shrink-0 border-t border-hairline p-2">
          {hasChanges && (
            <div className="mb-2 flex items-center justify-between text-xs text-l3">
              <span>
                {/* 工作区模式上面列的是累计改动，提交的只是还没提交的那部分：写清楚，免得和列表条数对不上 */}
                {inWs
                  ? `这次提交 ${selectedFiles.length} 个未提交的文件`
                  : `${selectedFiles.length} / ${files.length}`}
              </span>
              {!inWs && (
                <span className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedPaths(allSelected ? new Set() : new Set(files.map((file) => file.path)))
                    }
                    className="text-l3 hover:text-l1"
                  >
                    {allSelected ? "清空" : "全选"}
                  </button>
                </span>
              )}
            </div>
          )}
          <div className="mb-2 flex items-center gap-1.5">
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                // Enter / ⌘Enter 都是「快速提交」（按钮上标注 ⌘Enter 是熟手提示）
                if (e.key === "Enter" && canCommit) void doCommit(false);
              }}
              placeholder="说明（可空）"
              disabled={running !== null || aiBusy}
              className={`${fieldClass} disabled:opacity-50`}
            />
            <button
              onClick={genMessage}
              disabled={!canCommit || aiBusy || running !== null}
              title="生成 Commit Message（AI 分析 diff 后填入输入框，可再改；速度取决于模型）"
              className={`shrink-0 rounded-sm px-2 py-1.5 text-sm text-l2 hover:bg-hover disabled:opacity-50 ${
                aiBusy ? "animate-pulse" : ""
              }`}
            >
              {aiBusy ? "◈…" : "◈"}
            </button>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => void doCommit(false)}
              disabled={!canCommit}
              title={`git commit：把勾选的改动提交到任务分支（${IS_MAC ? "⌘" : "Ctrl+"}Enter）`}
              className={`flex-1 rounded-sm border px-3 py-1.5 text-sm disabled:opacity-50 ${
                canCommit
                  ? "border-cta-bd bg-cta text-cta-text hover:brightness-110"
                  : "border-field bg-inset text-l4"
              }`}
            >
              {running === "commit" ? "提交中…" : "提交"}
            </button>
            <button
              onClick={() => void doCommit(true)}
              disabled={!canCommit}
              title="git commit + push：提交到任务分支并推送到远程"
              // 次要钮（2026-10-23）：原来绿色渐变与「提交」两颗实心大钮抢主次，渐变也违反设计规范；
              // 推送是往外发的那一步，不当默认动作
              className={`flex-1 rounded-sm border px-3 py-1.5 text-sm disabled:opacity-50 ${
                canCommit
                  ? "border-field text-l2 hover:bg-hover hover:text-l1"
                  : "border-field bg-inset text-l4"
              }`}
            >
              {running === "push" ? "推送中…" : "提交并推送"}
            </button>
          </div>
          {output && (
            <div className="mt-2 rounded-sm ccode-well p-2 text-xs">
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
                  className="mt-2 rounded-sm border border-cta-bd bg-cta px-2 py-1 text-cta-text hover:brightness-110 disabled:opacity-50"
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
          className={`fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-md border border-cta-bd bg-cta px-3 py-2 text-sm text-cta-text transition-all duration-300 ${
            toast.hiding ? "translate-y-1 opacity-0" : "translate-y-0 opacity-100"
          }`}
        >
          <span>✓</span>
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
