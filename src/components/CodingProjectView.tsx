import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ArrowDownToLine,
  ArrowUpToLine,
  CloudOff,
  Copy,
  Download,
  FileDiff,
  FolderOpen,
  GitBranch,
  GitCompare,
  GitPullRequest,
  RefreshCw,
  Terminal,
  Upload,
} from "lucide-react";
import { confirmDialog } from "./ConfirmDialog";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";
import { HoverTip, useHoverTip } from "./HoverTip";
import {
  compactPrimaryActionClass,
  fieldClass,
  FoldMark,
  ghostActionClass,
  primaryActionClass,
  projectWellClass,
  rowActionClass,
  secondaryActionClass,
} from "./PageFrame";
import { useAppStore } from "../store";
import { pathWithin } from "../path-utils";
import { IS_MAC, IS_WINDOWS } from "../hotkeys";
import {
  nextLaneBranchName,
  parseGitRemoteUrl,
  remotePickerRows,
  shouldWarnEnterPrimaryBase,
} from "../coding-git";
import {
  groupLanesByTheme,
  laneActivityLabel,
  lastLaneTheme,
  overlayLanes,
  type LaneOverlay,
} from "../coding-lanes";
import { loadAskAiRemembered } from "../ask-ai";
import { codingTerminalLaunch } from "../kickoff-launch";
import { toast } from "../toast";
import { projectAgentPrefs } from "../project-agents";
import { loadProjectContextPack } from "../project-context-load";
import { absTime, relTime } from "../rel-time";
import { imeBlocksEnter } from "../ime-guard";
import {
  codingDivergenceBar,
  codingDivergenceLabel,
  codingDivergenceTip,
  codingFactChips,
  type CodingFactChip,
  type CodingFactMark,
} from "../work-mode";
import { codingStatusLine } from "../project-status";


import ProjectSettingsDrawer from "./ProjectSettingsDrawer";
import PortsSection from "./PortsSection";
import { AGENTS } from "../types";
import type {
  CodingMergeDto,
  CodingOpDto,
  CodingOverviewDto,
  CodingWorktreeDto,
  CustomRuntimeDto,
  ProjectDto,
} from "../types";
import {
  gitAdmissionPayload,
  mergeAdmissionText,
} from "../acceptance-log";


const overviewCache = new Map<string, CodingOverviewDto>();

const iconBtnClass =
  "flex h-7 w-7 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1 disabled:cursor-not-allowed disabled:opacity-50";

export function prefetchCodingOverview(repoPath: string) {
  if (overviewCache.has(repoPath)) return;
  invoke<CodingOverviewDto>("coding_overview", { repoPath })
    .then((dto) => overviewCache.set(repoPath, dto))
    .catch(() => {});
}

export async function loadCodingOverview(
  repoPath: string,
): Promise<CodingOverviewDto> {
  const hit = overviewCache.get(repoPath);
  if (hit) return hit;
  const dto = await invoke<CodingOverviewDto>("coding_overview", { repoPath });
  overviewCache.set(repoPath, dto);
  return dto;
}

function chipToneClass(tone: CodingFactChip["tone"]): string {
  if (tone === "ok") return "text-ok-text";
  if (tone === "warn") return "text-warn-text";
  return "text-l4";
}

function revealFolderLabel(): string {
  if (IS_MAC) return "在访达中显示";
  if (IS_WINDOWS) return "在资源管理器中显示";
  return "在文件管理器中显示";
}

function BranchLabel({
  name,
  detached,
}: {
  name: string;
  detached?: boolean;
}) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1 font-mono text-xs text-l2">
      <GitBranch size={12} strokeWidth={1.8} className="shrink-0 text-l4" />
      <span className="truncate">
        {detached ? "游离 HEAD" : name || "（无分支）"}
      </span>
    </span>
  );
}

function FactMarkIcon({ mark }: { mark: CodingFactMark }) {
  const props = { size: 12, strokeWidth: 1.8, className: "shrink-0" as const };
  if (mark === "dirty") return <FileDiff {...props} />;
  if (mark === "unpushed") return <Upload {...props} />;
  if (mark === "upstreamBehind") return <Download {...props} />;
  return <CloudOff {...props} />;
}

function FactChipView({ chip }: { chip: CodingFactChip }) {
  const ref = useRef<HTMLSpanElement>(null);
  const { tip, show, hide } = useHoverTip(ref);
  return (
    <span
      ref={ref}
      onMouseEnter={show}
      onMouseLeave={hide}
      className={`inline-flex items-center gap-0.5 rounded-full bg-raised px-1.5 py-px text-micro ${chipToneClass(chip.tone)}`}
    >
      <FactMarkIcon mark={chip.mark} />
      <span className="tabular-nums">{chip.label}</span>
      <HoverTip tip={tip} text={chip.tip} />
    </span>
  );
}

function DivergenceBar({
  ahead,
  behind,
  baseBranch,
}: {
  ahead: number;
  behind: number;
  baseBranch: string;
}) {
  const bar = codingDivergenceBar(ahead, behind);
  const ref = useRef<HTMLSpanElement>(null);
  const { tip, show, hide } = useHoverTip(ref);
  if (!bar) return null;
  const left = `${Math.max(bar.behindShare * 50, bar.behind > 0 ? 4 : 0)}%`;
  const right = `${Math.max(bar.aheadShare * 50, bar.ahead > 0 ? 4 : 0)}%`;
  return (
    <span
      ref={ref}
      onMouseEnter={show}
      onMouseLeave={hide}
      className="inline-flex min-w-0 max-w-full items-center gap-1"
    >
      <span
        aria-hidden="true"
        className="relative h-1.5 w-9 shrink-0 overflow-hidden rounded-full bg-inset"
      >
        <span className="absolute left-1/2 top-0 h-full w-px bg-hairline" />
        <span
          className="absolute right-1/2 top-0 h-full rounded-l-full bg-warn-text"
          style={{ width: left }}
        />
        <span
          className="absolute left-1/2 top-0 h-full rounded-r-full bg-ok-text"
          style={{ width: right }}
        />
      </span>
      <span className={`min-w-0 break-words text-micro ${bar.behind > 0 ? "text-warn-text" : "text-ok-text"}`}>
        {codingDivergenceLabel(bar.ahead, bar.behind, baseBranch)}
      </span>
      <HoverTip
        tip={tip}
        text={codingDivergenceTip(bar.ahead, bar.behind, baseBranch)}
      />
    </span>
  );
}

function TipWrap({
  text,
  up = true,
  children,
}: {
  text: string;
  up?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const { tip, show, hide } = useHoverTip(ref, up);
  return (
    <span
      ref={ref}
      onMouseEnter={show}
      onMouseLeave={hide}
      className="inline-flex"
    >
      {children}
      <HoverTip tip={tip} text={text} up={up} />
    </span>
  );
}

function FactChips({
  facts,
  baseBranch,
  hostKind,
  cleanLabel = false,
}: {
  facts: {
    dirty: boolean;
    dirtyCount?: number | null;
    ahead: number;
    behind: number;
    unpushed: number;
    hasUpstream: boolean;
    upstreamBehind?: number;
  };
  baseBranch: string;
  hostKind?: "github" | "other" | null;
  cleanLabel?: boolean;
}) {
  const chips = codingFactChips({
    ...facts,
    baseBranch,
    hostKind,
  });
  const bar = codingDivergenceBar(facts.ahead, facts.behind);
  if (chips.length === 0 && !bar) {
    return cleanLabel ? <span className="text-micro text-l4">无未提交改动</span> : null;
  }
  return (
    <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
      <DivergenceBar
        ahead={facts.ahead}
        behind={facts.behind}
        baseBranch={baseBranch}
      />
      {chips.map((chip) => (
        <FactChipView key={chip.key} chip={chip} />
      ))}
    </span>
  );
}

function IconBtn({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <TipWrap text={label}>
      <button
        type="button"
        className={iconBtnClass}
        disabled={disabled}
        aria-label={label}
        onClick={onClick}
      >
        {children}
      </button>
    </TipWrap>
  );
}

function PathActions({
  path,
  onError,
}: {
  path: string;
  onError: (msg: string) => void;
}) {
  return (
    <span className="inline-flex shrink-0 items-center">
      <IconBtn
        label="复制路径"
        onClick={() => {
          void navigator.clipboard.writeText(path).catch(() => onError("复制路径失败"));
        }}
      >
        <Copy size={13} strokeWidth={1.8} />
      </IconBtn>
      <IconBtn
        label={revealFolderLabel()}
        onClick={() => {
          void revealItemInDir(path).catch((e) => onError(String(e)));
        }}
      >
        <FolderOpen size={13} strokeWidth={1.8} />
      </IconBtn>
    </span>
  );
}

type LaneTree = CodingWorktreeDto & { lane: LaneOverlay };

export default function CodingProjectView({
  project,
  repoPath,
  chromeReq,
  onChromeConsumed,
  onError,
  onNotice,
}: {
  project: ProjectDto | null;
  repoPath: string;
  homeDir: string;
  chromeReq?: { action: string; token: number } | null;
  onChromeConsumed?: () => void;
  onError: (msg: string) => void;
  onNotice: (msg: string) => void;
}) {
  const setPage = useAppStore((s) => s.setPage);
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const profiles = useAppStore((s) => s.profiles);
  const hiddenProfiles = useAppStore((s) => s.settings?.hiddenProfiles ?? []);
  const branchInputRef = useRef<HTMLInputElement>(null);
  const [ov, setOv] = useState<CodingOverviewDto | null>(
    () => overviewCache.get(repoPath) ?? null,
  );
  const [loading, setLoading] = useState(() => !overviewCache.has(repoPath));
  const [branchName, setBranchName] = useState("");
  const [customRuntimes, setCustomRuntimes] = useState<CustomRuntimeDto[]>([]);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [initNote, setInitNote] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const chromeConsumed = useRef<number | null>(null);
  useEffect(() => {
    if (!chromeReq || !project) return;
    if (chromeConsumed.current === chromeReq.token) return;
    if (chromeReq.action !== "settings") return;
    chromeConsumed.current = chromeReq.token;
    setSettingsOpen(true);
    onChromeConsumed?.();
  }, [chromeReq, project, onChromeConsumed]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [groupingPath, setGroupingPath] = useState<string | null>(null);
  const [groupingTheme, setGroupingTheme] = useState("");
  const [pickerQuery, setPickerQuery] = useState("");
  const [originOpen, setOriginOpen] = useState(false);
  const [originUrl, setOriginUrl] = useState("");
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);
  const terminalRunInputs = useAppStore((s) => s.terminalRunInputs);
  const composingLockRef = useRef(false);
  const composingFrameRef = useRef<number | null>(null);
  const reviewedHeadRef = useRef<Record<string, string>>({});
  const [ledgerPendingBranch, setLedgerPendingBranch] = useState<string | null>(
    null,
  );
  const [ledgerBusy, setLedgerBusy] = useState(false);

  async function reload(opts?: { silent?: boolean }) {
    if (!opts?.silent && !overviewCache.has(repoPath)) setLoading(true);
    try {
      const next = await invoke<CodingOverviewDto>("coding_overview", {
        repoPath,
      });
      overviewCache.set(repoPath, next);
      setOv(next);
      setLedgerPendingBranch(next.worktrees.find((tree) => tree.ledgerPending)?.branch ?? null);
      try {
        setCustomRuntimes(await invoke<CustomRuntimeDto[]>("list_custom_runtimes"));
      } catch {
        /* 自定义运行时列表失败不挡工作树 */
      }
    } catch (e) {
      onError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const cached = overviewCache.get(repoPath);
    if (cached) {
      setOv(cached);
      setLoading(false);
      void reload({ silent: true });
    } else {
      setOv(null);
      setLoading(true);
      void reload();
    }
    reviewedHeadRef.current = {};
    setLedgerPendingBranch(null);
    function onVis() {
      if (document.visibilityState === "visible") void reload({ silent: true });
    }
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      if (composingFrameRef.current != null) {
        cancelAnimationFrame(composingFrameRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath]);

  const extraRoots = useMemo(
    () => (ov?.worktrees ?? []).map((w) => w.path),
    [ov],
  );

  const trees = useMemo(() => {
    const list = ov?.worktrees ?? [];
    const merging = ov?.mergingCwd;
    return [...list].sort((a, b) => {
      const am = merging && a.path === merging ? 0 : 1;
      const bm = merging && b.path === merging ? 0 : 1;
      return am - bm;
    });
  }, [ov]);

  const laneGroups = useMemo(
    () => groupLanesByTheme(overlayLanes(trees, ov?.lanes ?? [], IS_WINDOWS)),
    [trees, ov],
  );

  /** C2a（拍板②推荐形态）：进入/建树默认仍即点即拉起；但解析出的连接已停用或
   *  已删时降为预填不自动拉起——停用想规避的问题（过期密钥、旧供应商计费）不该
   *  在无交互的路径上复现。选择权留在启动栏（「本次用 X」事实回执由启动栏自持）。 */
  function gateCodingAutoStart<
    T extends { profileId: string; autoStart: boolean },
  >(launch: T | null): T | null {
    if (!launch || !launch.autoStart) return launch;
    const ok = profiles.some(
      (p) => p.id === launch.profileId && !hiddenProfiles.includes(p.id),
    );
    if (ok) return launch;
    toast("原配置已停用或失效：已预填启动栏，选好连接再启动。", "warning");
    return { ...launch, autoStart: false };
  }

  async function enterTree(w: CodingWorktreeDto, title: string) {
    const primaryPath = trees.find((t) => t.isPrimary)?.path ?? repoPath;
    const runningOnPrimary = terminalRunInputs.some(
      (t) => t.running && pathWithin(t.cwd, primaryPath, IS_WINDOWS),
    );
    const warn = shouldWarnEnterPrimaryBase({
      isPrimary: w.isPrimary,
      isBase: w.isBase,
      runningOnPrimary,
    });
    if (warn.warn) {
      const ok = await confirmDialog(
        warn.kind === "agent"
          ? "主仓里已有 Agent 在跑。再开一个会改同一份目录。"
          : `主仓正停在基准分支上。Agent 会直接改 ${w.branch || "基准"}。建议先从基准拉出工作树。`,
        { confirmText: "仍要进入" },
      );
      if (!ok) return;
    }
    const prefs = projectAgentPrefs(project);
    const launch = gateCodingAutoStart(
      codingTerminalLaunch(
        profiles,
        loadAskAiRemembered(),
        prefs.preferredAgent,
        prefs.preferredProfile,
        prefs.preferredModel,
      ),
    );
    const pack = await loadProjectContextPack({
      name: project?.name ?? title,
      path: repoPath,
      workMode: "coding",
      kind: "session",
    });
    setPendingTerminal({
      cwd: w.path,
      extraEnv: {},
      title,
      reuseKey: `lane:${w.path}`,
      ...launch,
      initialPrompt: pack,
    });
    setPage("terminal");
  }

  async function startCustomRuntime(
    cwd: string,
    runtime?: CustomRuntimeDto,
    title?: string,
  ) {
    try {
      let r = runtime;
      if (!r) {
        const list =
          customRuntimes.length > 0
            ? customRuntimes
            : await invoke<CustomRuntimeDto[]>("list_custom_runtimes");
        if (list.length === 0) {
          useAppStore.getState().setSettingsSectionReq("storage");
          useAppStore.getState().setPage("settings");
          onNotice("还没有自定义运行时，已打开设置页「数据与存储」。");
          return;
        }
        r = list[0]!;
      }
      const reuseKey = `custom:${r.id}:${cwd}`;
      const run = await invoke<{ id: string }>("run_open_custom", {
        cwd,
        reuseKey,
        runId: null,
        customRuntimeId: r.id,
      });
      setPendingTerminal({
        cwd,
        extraEnv: r.env ?? {},
        title: title?.trim() || r.name,
        customRuntimeId: r.id,
        reuseKey,
        runId: run.id,
        surface: "terminal",
      });
      setPage("terminal");
    } catch (e) {
      onError(String(e));
    }
  }

  function openGit(path: string, title: string) {
    const tree = trees.find((item) => item.path === path);
    if (tree?.head && tree.branch) {
      reviewedHeadRef.current[tree.branch] = tree.head;
    }
    setPendingTerminal({
      cwd: path,
      extraEnv: {},
      title,
      reuseKey: `lane:${path}`,
      rightTab: "git",
      surface: "terminal",
    });
    setPage("terminal");
  }

  async function createTree(
    name: string,
    source: { kind: "fromBase" } | { kind: "local" } | { kind: "remote"; remote: string },
  ) {
    const branch = name.trim();
    if (!branch || creating) return;
    setCreating(true);
    try {
      let req = source;
      for (;;) {
        const r = await invoke<CodingOpDto>("coding_create_worktree", {
          repoPath,
          branch,
          source: req,
        });
        if (!r.ok && r.code === "branch_exists") {
          const ok = await confirmDialog(r.message, {
            confirmText: "给它建工作树",
          });
          if (!ok) return;
          req = { kind: "local" };
          continue;
        }
        if (!r.ok) {
          onError(r.message);
          return;
        }
        if (r.createdInitialCommit) setInitNote(true);
        setBranchName("");
        setPickerOpen(false);
        onNotice(r.message);
        await reload();
        if (r.worktree) {
          const name = r.worktree.branch;
          const prefs = projectAgentPrefs(project);
          const launch = gateCodingAutoStart(
            codingTerminalLaunch(
              profiles,
              loadAskAiRemembered(),
              prefs.preferredAgent,
              prefs.preferredProfile,
              prefs.preferredModel,
            ),
          );
          const pack = await loadProjectContextPack({
            name: project?.name ?? name,
            path: repoPath,
            workMode: "coding",
            goal: name || r.worktree.branch || branch,
            kind: "goal",
          });
          setPendingTerminal({
            cwd: r.worktree.path,
            extraEnv: {},
            title: name || r.worktree.branch || branch,
            reuseKey: `lane:${r.worktree.path}`,
            ...(launch ?? {}),
            initialPrompt: `${pack}\n\n----\n\n先读 TASK.md 再动手`,
          });
          setPage("terminal");
        }
        return;
      }
    } catch (e) {
      onError(String(e));
    } finally {
      setCreating(false);
    }
  }

  async function removeTree(w: CodingWorktreeDto) {
    if (w.isPrimary) return;
    const delBranch = await confirmDialog(
      w.dirty
        ? "有未提交改动。强制删除工作树？可同时删除分支。"
        : "删除这棵工作树？可同时删除分支。",
      { confirmText: "删除工作树", danger: true },
    );
    if (!delBranch) return;
    const also = await confirmDialog("连分支一起删？", {
      confirmText: "同时删分支",
    });
    setBusy(w.path);
    try {
      await invoke("coding_remove_worktree", {
        repoPath,
        worktreePath: w.path,
        deleteBranch: also,
        force: w.dirty,
      });
      await reload();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function runRemote(
    cmd: "coding_fetch" | "coding_pull" | "coding_push",
    cwd: string,
    label: string,
  ) {
    setBusy(cwd + cmd);
    try {
      if (cmd === "coding_pull") {
        const r = await invoke<CodingOpDto>(cmd, { cwd });
        if (!r.ok) onError(r.message);
        else onNotice(r.message || label);
      } else {
        const msg = await invoke<string>(cmd, { cwd });
        onNotice(msg || label);
      }
      await reload();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function openDesktop(path: string) {
    try {
      const r = await invoke<CodingOpDto>("coding_open_desktop", {
        repoPath,
        path,
      });
      if (!r.ok) onError(r.message);
      else onNotice(r.message);
    } catch (e) {
      onError(String(e));
    }
  }

  async function openPr(cwd: string) {
    if (busy) return;
    setBusy(`pr:${cwd}`);
    try {
      const r = await invoke<CodingOpDto>("coding_open_pr", {
        repoPath,
        cwd,
      });
      if (r.method === "compare-url" && r.url) {
        await openUrl(r.url);
        onNotice(r.message);
        return;
      }
      if (!r.ok) onError(r.message);
      else onNotice(r.message);
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function addOrigin() {
    const parsed = parseGitRemoteUrl(originUrl);
    if (!parsed.ok) {
      onError("远程地址不合法");
      return;
    }
    if (parsed.hasUserinfo) {
      const ok = await confirmDialog(
        "URL 含密码，会写入 .git/config。仍要添加？",
        { danger: true, confirmText: "仍要添加" },
      );
      if (!ok) return;
    }
    setBusy("origin");
    try {
      const r = await invoke<CodingOpDto>("coding_add_origin", {
        repoPath,
        url: originUrl.trim(),
      });
      if (!r.ok && r.failedPhase === "fetch") {
        onNotice(r.message);
        setOriginOpen(false);
        await reload();
        return;
      }
      if (!r.ok) {
        onError(r.message);
        return;
      }
      setOriginOpen(false);
      setOriginUrl("");
      onNotice(r.message);
      await reload();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function mergeBranch(name: string, retry = false) {
    if (
      !retry &&
      !(await confirmDialog(`把「${name}」合并进 ${ov?.baseBranch ?? "基准"}？`))
    )
      return;
    setBusy(`merge:${name}`);
    if (retry) setLedgerBusy(true);
    try {
      const tree = trees.find((item) => item.branch === name);
      const reviewed =
        reviewedHeadRef.current[name] ?? tree?.head ?? null;
      const r = await invoke<CodingMergeDto>("coding_merge_into_base", {
        repoPath,
        branch: name,
        ...gitAdmissionPayload({ retry, reviewedSha: reviewed }),
      });
      if (r.code === "base_not_checked_out") {
        onNotice(r.message);
        await reload();
        return;
      }
      if (r.conflict) {
        setLedgerPendingBranch(null);
        onNotice(r.message);
        openGit(r.cwd, "解决冲突");
      } else if (r.merged && r.ledgerWritten === false) {
        setLedgerPendingBranch(name);
        onError(mergeAdmissionText({ ledgerWritten: false }));
      } else {
        setLedgerPendingBranch(null);
        onNotice(
          mergeAdmissionText({
            ledgerWritten: r.ledgerWritten !== false,
            versionId: r.versionId,
          }),
        );
      }
      await reload();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(null);
      setLedgerBusy(false);
    }
  }

  async function deleteBranch(name: string, force = false) {
    if (
      !(await confirmDialog(
        force
          ? `强制删除分支 ${name}？未合入的提交会丢掉。`
          : `删除分支 ${name}？`,
        { danger: true, confirmText: force ? "强制删除" : "删除" },
      ))
    )
      return;
    setBusy(`br:${name}`);
    try {
      await invoke("coding_delete_branch", { repoPath, branch: name, force });
      await reload();
    } catch (e) {
      const msg = String(e);
      if (!force && msg.includes("未合入")) {
        setBusy(null);
        await deleteBranch(name, true);
        return;
      }
      onError(msg);
    } finally {
      setBusy(null);
    }
  }

  async function saveLane(w: LaneTree, theme: string) {
    setBusy(`lane:${w.path}`);
    try {
      await invoke("coding_upsert_lane", {
        repoPath,
        worktreePath: w.path,
        branch: w.branch || "",
        name: w.lane.name || w.branch,
        theme: theme.trim() || null,
        id: w.lane.id,
      });
      setGroupingPath(null);
      await reload();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(null);
    }
  }

  function beginGroup(w: LaneTree) {
    setGroupingPath(w.path);
    setGroupingTheme(w.lane.theme ?? lastLaneTheme(ov?.lanes ?? []) ?? "");
  }

  async function abortMerge() {
    const cwd = ov?.mergingCwd;
    if (!cwd) return;
    if (!(await confirmDialog("取消这次合并？未解决的冲突会丢弃。"))) return;
    setBusy("abort");
    try {
      await invoke("git_abort_merge", { cwd });
      onNotice("已取消合并");
      await reload();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(null);
    }
  }

  function lockIme() {
    if (composingFrameRef.current != null) {
      cancelAnimationFrame(composingFrameRef.current);
      composingFrameRef.current = null;
    }
    composingLockRef.current = true;
  }

  function unlockImeAfterFrame() {
    composingLockRef.current = true;
    composingFrameRef.current = requestAnimationFrame(() => {
      composingLockRef.current = false;
      composingFrameRef.current = null;
    });
  }

  function openMenu(e: MouseEvent<HTMLButtonElement>, items: ContextMenuItem[]) {
    const rect = e.currentTarget.getBoundingClientRect();
    setMenu({ x: rect.right, y: rect.bottom + 4, items });
  }

  const branches = ov?.branches ?? [];
  const base = ov?.baseBranch ?? "";
  const statusLine = ov
    ? codingStatusLine({
        worktrees: ov.worktrees,
        merging: ov.merging,
      })
    : "";
  const origin = ov?.origin ?? null;
  const hostKind = (origin?.hostKind === "github" ? "github" : origin ? "other" : null) as
    | "github"
    | "other"
    | null;
  const hasBaseTree = trees.some((w) => w.isBase);
  const primaryOffBase = trees.some((w) => w.isPrimary && !w.isBase);
  const pickerRows = remotePickerRows(
    branches.map((b) => ({ name: b.name, occupiedPath: b.worktreePath })),
    ov?.remoteBranches ?? [],
    pickerQuery,
  );

  return (
    <div className="space-y-5">
      <div className="min-w-0 space-y-5">
        <section>
          <p className="flex flex-wrap items-center gap-2 text-xs text-l3">
            {base && (
              <span className="inline-flex items-center gap-1 text-l4">
                基准
                <BranchLabel name={base} />
              </span>
            )}
            {origin ? (
              <span
                className="truncate font-mono text-micro text-l3"
                title={origin.url}
              >
                {hostKind === "github"
                  ? origin.display.replace(/^(?:ssh\.)?github\.com\//, "")
                  : origin.display}
              </span>
            ) : (
              ov?.isRepo && (
                <button
                  type="button"
                  className={ghostActionClass}
                  onClick={() => setOriginOpen(true)}
                >
                  还没连上远程 · 连接远程
                </button>
              )
            )}
            {statusLine && <span className="text-micro text-l4">{statusLine}</span>}
            {primaryOffBase && (
              <TipWrap
                text={`主仓不在 ${base}。给基准建一棵工作树再合并，不要把主仓切回去。`}
              >
                <button
                  type="button"
                  className="rounded-full bg-raised px-2 py-0.5 text-micro text-l4"
                  onClick={() => void createTree(base, { kind: "local" })}
                >
                  主仓不在基准
                </button>
              </TipWrap>
            )}
            <span className="ml-auto flex items-center gap-1">
              <PathActions path={repoPath} onError={onError} />
              {origin && (
                <IconBtn
                  label={hostKind === "github" ? "从 GitHub 更新" : "从远程更新"}
                  disabled={loading || !!busy}
                  onClick={() =>
                    void runRemote("coding_fetch", repoPath, "已更新引用")
                  }
                >
                  <ArrowDownToLine size={13} strokeWidth={1.8} />
                </IconBtn>
              )}
              <IconBtn
                label="刷新"
                disabled={loading || !!busy}
                onClick={() => {
                  setLoading(true);
                  void reload();
                }}
              >
                <RefreshCw size={13} strokeWidth={1.8} />
              </IconBtn>
            </span>
          </p>
          {!hasBaseTree && ov?.isRepo && base && (
            <button
              type="button"
              className={`${ghostActionClass} mt-1`}
              disabled={creating || !!busy}
              onClick={() => void createTree(base, { kind: "local" })}
            >
              为 {base} 建工作树
            </button>
          )}
          {initNote && (
            <p className="mt-2 text-xs text-l3">
              这个仓库还没有提交，已自动写了一条空的初始提交，才能建工作树。
            </p>
          )}
        </section>

        {loading && !ov && <p className="text-xs text-l4">读取工作树…</p>}
        {ov && !ov.isRepo && (
          <p className="text-sm text-l3">还不是 git 仓库。</p>
        )}

        {ov?.isRepo && (
          <>
            <section>
              <div className="mb-2.5 flex items-center gap-2">
                <GitBranch size={14} strokeWidth={1.8} className="text-l4" />
                <h2 className="text-xs font-medium text-l2">工作树</h2>
              </div>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <input
                  ref={branchInputRef}
                  className={`${fieldClass} h-8 min-w-32 flex-1 py-0`}
                  value={branchName}
                  placeholder="新分支名，如 feature/login"
                  aria-label="新分支名（从基准拉出）"
                  onChange={(e) => setBranchName(e.target.value)}
                  onCompositionStart={lockIme}
                  onCompositionUpdate={lockIme}
                  onCompositionEnd={unlockImeAfterFrame}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    if (
                      imeBlocksEnter({
                        isComposing: e.nativeEvent.isComposing,
                        keyCode: e.nativeEvent.keyCode,
                        composingLock: composingLockRef.current,
                      })
                    ) {
                      return;
                    }
                    e.preventDefault();
                    void createTree(branchName, { kind: "fromBase" });
                  }}
                />
                <button
                  type="button"
                  className={`${primaryActionClass} shrink-0`}
                  disabled={creating || !branchName.trim()}
                  onClick={() =>
                    void createTree(branchName, { kind: "fromBase" })
                  }
                >
                  {creating ? "…" : `从 ${base || "基准"} 开工`}
                </button>
                <button
                  type="button"
                  className={`${ghostActionClass} shrink-0`}
                  aria-expanded={pickerOpen}
                  onClick={() => setPickerOpen((v) => !v)}
                >
                  已有分支
                </button>
              </div>
              {pickerOpen && (
                <div className="mb-3 rounded-lg ccode-well p-2">
                  <input
                    className={`${fieldClass} mb-2 h-8 py-0`}
                    value={pickerQuery}
                    placeholder="搜索分支"
                    onChange={(e) => setPickerQuery(e.target.value)}
                  />
                  <ul className="max-h-48 space-y-0.5 overflow-auto">
                    {pickerRows.length === 0 ? (
                      <li className="px-2 py-1 text-xs text-l4">没有可开工的分支</li>
                    ) : (
                      pickerRows.map((row) => (
                        <li key={row.key}>
                          <button
                            type="button"
                            disabled={row.disabled || creating}
                            title={
                              row.occupiedPath
                                ? `已在 ${row.occupiedPath} 检出`
                                : undefined
                            }
                            className="flex h-8 w-full items-center rounded-md px-2 text-left text-xs text-l2 hover:bg-hover disabled:opacity-40"
                            onClick={() =>
                              void createTree(
                                row.name,
                                row.source === "remote"
                                  ? {
                                      kind: "remote",
                                      remote: row.remote ?? "origin",
                                    }
                                  : { kind: "local" },
                              )
                            }
                          >
                            {row.label}
                          </button>
                        </li>
                      ))
                    )}
                  </ul>
                </div>
              )}
              <ul className="flex flex-col gap-2">
                {laneGroups.flatMap((group) => {
                  const head =
                    group.label === "主仓" ? null : (
                      <li
                        key={`theme:${group.label}`}
                        className="px-0.5 pt-1 text-micro font-medium text-l4"
                      >
                        {group.label}
                      </li>
                    );
                  const rows = group.items.map((w) => {
                  const label = w.detached
                    ? "游离 HEAD"
                    : w.branch || "（无分支）";
                  const displayName = w.isPrimary
                    ? "主仓"
                    : w.lane.name || label;
                  const activity = laneActivityLabel(
                    w.path,
                    terminalRunInputs,
                    IS_WINDOWS,
                  );
                  const activityText =
                    activity === "空闲"
                      ? "空闲"
                      : (AGENTS.find((a) => a.id === activity)?.label ??
                        activity);
                  const merging = !!ov?.merging && ov.mergingCwd === w.path;
                  const moreItems: ContextMenuItem[] = [];
                  if (w.isPrimary && !merging) {
                    moreItems.push(
                      { label: "查看改动", onSelect: () => openGit(w.path, label) },
                      {
                        label: "拉取",
                        disabled: !!busy,
                        onSelect: () => void runRemote("coding_pull", w.path, "已拉取"),
                      },
                      {
                        label: "推送",
                        disabled: !!busy,
                        onSelect: () => void runRemote("coding_push", w.path, "已推送"),
                      },
                    );
                  }
                  if (merging) {
                    moreItems.push({
                      label: "取消合并",
                      onSelect: () => void abortMerge(),
                    });
                  }
                  if (!w.isPrimary && !w.detached) {
                    moreItems.push({
                      label: "再开一条",
                      onSelect: () => {
                        const next = nextLaneBranchName(
                          w.branch || "feature/work",
                        );
                        if (!next) return;
                        setBranchName(next);
                        branchInputRef.current?.focus();
                        branchInputRef.current?.scrollIntoView({
                          block: "nearest",
                        });
                      },
                    });
                  }
                  moreItems.push({
                    label: "复制路径",
                    onSelect: () => {
                      void navigator.clipboard
                        .writeText(w.path)
                        .catch(() => onError("复制路径失败"));
                    },
                  });
                  moreItems.push({
                    label: revealFolderLabel(),
                    onSelect: () => {
                      void revealItemInDir(w.path).catch((e) =>
                        onError(String(e)),
                      );
                    },
                  });
                  moreItems.push({
                    label: w.isPrimary
                      ? "在 GitHub Desktop 打开主仓这一目录"
                      : "用 GitHub Desktop 打开这一目录",
                    onSelect: () => void openDesktop(w.path),
                  });
                  if (customRuntimes.length === 0) {
                    moreItems.push({
                      label: "用自定义运行时…",
                      onSelect: () =>
                        void startCustomRuntime(
                          w.path,
                          undefined,
                          w.lane.name || label,
                        ),
                    });
                  } else {
                    for (const r of customRuntimes) {
                      moreItems.push({
                        label: `运行「${r.name}」`,
                        onSelect: () =>
                          void startCustomRuntime(
                            w.path,
                            r,
                            w.lane.name || label,
                          ),
                      });
                    }
                  }
                  if (!w.isPrimary) {
                    moreItems.push({ separator: true });
                    moreItems.push({
                      label: w.lane.theme ? "改分组…" : "分组…",
                      onSelect: () => beginGroup(w),
                    });
                    if (w.lane.theme) {
                      moreItems.push({
                        label: "取消分组",
                        onSelect: () => void saveLane(w, ""),
                      });
                    }
                    moreItems.push({
                      label: "删除工作树",
                      danger: true,
                      disabled: !!busy,
                      onSelect: () => void removeTree(w),
                    });
                  }
                  return (
                    <li
                      key={w.path}
                      aria-label={w.isPrimary ? `主仓 ${label}` : `工作树 ${displayName}`}
                      className={projectWellClass}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <p
                            className="flex min-w-0 items-center gap-2 text-sm font-medium text-l1"
                            title={w.path}
                          >
                            <span className="min-w-0 truncate">{displayName}</span>
                            {!w.isPrimary &&
                              w.lane.branch &&
                              w.lane.branch !== displayName && (
                                <BranchLabel
                                  name={w.lane.branch}
                                  detached={w.detached}
                                />
                              )}
                            {w.isPrimary && (
                              <BranchLabel name={label} detached={w.detached} />
                            )}
                            {w.isBase && (
                              <span className="shrink-0 rounded bg-inset px-1 text-micro font-normal text-l4">
                                基准
                              </span>
                            )}
                            {(!w.isPrimary || activity !== "空闲") && (
                              <span className="shrink-0 text-micro font-normal text-l4">
                                {activityText}
                              </span>
                            )}
                            {merging && (
                              <span className="text-xs text-warn-text">
                                有冲突
                              </span>
                            )}
                          </p>
                        </div>
                        <div className="ml-auto flex shrink-0 flex-wrap items-center gap-0.5">
                          {merging ? (
                            <button
                              type="button"
                              className={compactPrimaryActionClass}
                              onClick={() => openGit(w.path, "解决冲突")}
                            >
                              去解决
                            </button>
                          ) : (
                            <>
                              <button
                                type="button"
                                className={`${w.isPrimary ? ghostActionClass : rowActionClass} gap-1`}
                                onClick={() => void enterTree(w, w.lane.name || label)}
                              >
                                <Terminal size={13} strokeWidth={1.8} />
                                进入
                              </button>
                              {!w.isPrimary && (
                                <>
                                  <IconBtn
                                    label="查看改动"
                                    onClick={() => openGit(w.path, label)}
                                  >
                                    <GitCompare size={13} strokeWidth={1.8} />
                                  </IconBtn>
                                  <IconBtn
                                    label="拉取"
                                    disabled={!!busy}
                                    onClick={() =>
                                      void runRemote("coding_pull", w.path, "已拉取")
                                    }
                                  >
                                    <ArrowDownToLine size={13} strokeWidth={1.8} />
                                  </IconBtn>
                                  <IconBtn
                                    label={
                                      w.hasUpstream
                                        ? `推送到 origin/${w.branch || "HEAD"}`
                                        : "第一次会推到 origin 并设上游"
                                    }
                                    disabled={!!busy}
                                    onClick={() =>
                                      void runRemote("coding_push", w.path, "已推送")
                                    }
                                  >
                                    <ArrowUpToLine size={13} strokeWidth={1.8} />
                                  </IconBtn>
                                </>
                              )}
                            </>
                          )}
                          {hostKind === "github" && (
                            <IconBtn
                              label={w.hasUpstream
                                ? busy === `pr:${w.path}` ? "打开中…" : "打开 Pull Request"
                                : "先推送才能开 PR"}
                              disabled={!!busy || !w.hasUpstream}
                              onClick={() => void openPr(w.path)}
                            >
                              <GitPullRequest size={13} strokeWidth={1.8} />
                            </IconBtn>
                          )}
                          {moreItems.length > 0 && (
                            <button
                              type="button"
                              className={iconBtnClass}
                              aria-label={`更多操作：${label}`}
                              title="更多操作"
                              onClick={(e) => openMenu(e, moreItems)}
                            >
                              ⋯
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-micro">
                        <FactChips
                          facts={w}
                          baseBranch={base}
                          hostKind={hostKind}
                          cleanLabel={w.isPrimary && !merging}
                        />
                        {w.isPrimary && (
                          <TipWrap text={absTime(w.lastCommitAt ?? null)} up={false}>
                            <span className="text-l4">
                              {w.lastCommitAt ? `最近提交 ${relTime(w.lastCommitAt)}` : "还没有提交"}
                            </span>
                          </TipWrap>
                        )}
                      </div>
                      {groupingPath === w.path && (
                        <form
                          className="mt-2 flex gap-2"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void saveLane(w, groupingTheme);
                          }}
                        >
                          <input
                            className={`${fieldClass} h-8 min-w-0 flex-1 py-0`}
                            value={groupingTheme}
                            placeholder="分组名，例如登录"
                            aria-label="主题分组"
                            autoFocus
                            onChange={(e) => setGroupingTheme(e.target.value)}
                          />
                          <button
                            type="submit"
                            className={rowActionClass}
                            disabled={!!busy}
                          >
                            分组
                          </button>
                          <button
                            type="button"
                            className={ghostActionClass}
                            onClick={() => setGroupingPath(null)}
                          >
                            取消
                          </button>
                        </form>
                      )}
                      {!w.isPrimary && (
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-micro text-l4">
                          <TipWrap text={absTime(w.lastCommitAt ?? null)} up={false}>
                            <span>
                              {w.lastCommitAt ? `最近提交 ${relTime(w.lastCommitAt)}` : "还没有提交"}
                            </span>
                          </TipWrap>
                          <TipWrap text={w.path}>
                            <button
                              type="button"
                              className={`${ghostActionClass} gap-1`}
                              aria-label={`打开工作树目录：${label}`}
                              onClick={() => void revealItemInDir(w.path).catch((e) => onError(String(e)))}
                            >
                              <FolderOpen size={12} strokeWidth={1.8} />
                              目录
                            </button>
                          </TipWrap>
                        </div>
                      )}
                    </li>
                  );
                  });
                  return head ? [head, ...rows] : rows;
                })}
              </ul>
            </section>

            <section>
              <button
                type="button"
                className="mb-2.5 flex w-full items-center gap-2 text-xs font-medium text-l2 hover:text-l1"
                aria-label="本地分支"
                aria-expanded={branchesOpen}
                onClick={() => setBranchesOpen((open) => !open)}
              >
                <FoldMark open={branchesOpen} />
                本地分支
                <span className="font-normal text-l4">{branches.length}</span>
                {branches.length > 0 && (
                  <span className="ml-auto text-micro font-normal text-l4">
                    {branches.some((b) => !b.worktreePath)
                      ? `${branches.filter((b) => !b.worktreePath).length} 个未检出`
                      : "均已检出"}
                  </span>
                )}
              </button>
              {branchesOpen &&
                (branches.length === 0 ? (
                <p className="py-4 text-sm text-l3">还没有本地分支。</p>
              ) : (
                <ul className="space-y-0.5">
                  {branches.map((b) => {
                    return (
                      <li
                        key={b.name}
                        aria-label={`本地分支 ${b.name}`}
                        className="flex min-h-10 items-center gap-2 rounded-md px-2.5 hover:bg-hover"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <BranchLabel name={b.name} />
                            {b.isBase && (
                              <span className="text-micro text-l4">基准</span>
                            )}
                            <TipWrap text={b.worktreePath || "尚未创建工作树"} up={false}>
                              <span className="shrink-0 text-micro text-l4">
                                {b.worktreePath ? (b.isPrimary ? "主仓" : "已建工作树") : "未检出"}
                              </span>
                            </TipWrap>
                          </div>
                          {!b.worktreePath && (
                            <p className="mt-0.5 flex flex-wrap items-center gap-1.5">
                              <FactChips facts={b} baseBranch={base} hostKind={hostKind} />
                            </p>
                          )}
                        </div>
                        {!b.worktreePath && (
                          <button
                            type="button"
                            className={ghostActionClass}
                            disabled={creating || !!busy}
                            onClick={() =>
                              void createTree(b.name, { kind: "local" })
                            }
                          >
                            建工作树
                          </button>
                        )}
                        <button
                          type="button"
                          className="flex h-7 w-7 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1"
                          aria-label={`更多操作：${b.name}`}
                          title="更多操作"
                          onClick={(e) =>
                            openMenu(e, [
                              {
                                label: "合并进基准",
                                disabled: !!busy || b.isBase,
                                title: b.isBase
                                  ? "基准分支不能合并进自己"
                                  : undefined,
                                onSelect: () => void mergeBranch(b.name),
                              },
                              {
                                label: "删除分支",
                                danger: true,
                                disabled:
                                  !!busy || b.isBase || !!b.worktreePath,
                                title: b.isBase
                                  ? "基准分支不能删"
                                  : b.worktreePath
                                    ? "先删工作树再删分支"
                                    : undefined,
                                onSelect: () => void deleteBranch(b.name),
                              },
                            ])
                          }
                        >
                          ⋯
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ))}
            </section>
            {ledgerPendingBranch && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-err-text">
                <span className="min-w-0 flex-1">
                  {mergeAdmissionText({ ledgerWritten: false })}
                </span>
                <button
                  type="button"
                  className={secondaryActionClass}
                  disabled={ledgerBusy || !!busy}
                  onClick={() => void mergeBranch(ledgerPendingBranch, true)}
                >
                  {ledgerBusy ? "记录中…" : "再记录验收"}
                </button>
              </div>
            )}
            <PortsSection roots={[repoPath, ...extraRoots]} />
          </>
        )}
      </div>
      {project && (
        <ProjectSettingsDrawer
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          projectPath={project.path}
          workMode="coding"
          onError={onError}
        />
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          alignRight
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      )}

      {originOpen && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
          onClick={() => setOriginOpen(false)}
        >
          <div
            className="ccode-float-surface w-full max-w-[500px] rounded-lg border border-field p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm font-medium text-l1">连接远程</p>
            <p className="mt-1 text-xs text-l4">远程名固定 origin</p>
            <input
              className={`${fieldClass} mt-3`}
              value={originUrl}
              placeholder="https://github.com/org/repo.git"
              onChange={(e) => setOriginUrl(e.target.value)}
              autoFocus
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className={ghostActionClass}
                onClick={() => setOriginOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className={primaryActionClass}
                disabled={!originUrl.trim() || !!busy}
                onClick={() => void addOrigin()}
              >
                添加
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
