import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  Copy,
  FolderOpen,
  ShieldAlert,
  ShieldCheck,
  SquareArrowOutUpRight,
} from "lucide-react";
import { useAppStore } from "../store";
import { toast } from "../toast";
import { IS_WINDOWS } from "../hotkeys";
import { samePath } from "../path-utils";
import {
  EXTERNAL_TERMINAL_DIRS_KEY,
  buildRecentExternalProjects,
  cleanDirPath,
  isInternalWorktreeOrScratch,
  parseExternalRecentDirs,
  recordExternalRecentDir,
  resolveDefaultExternalCwd,
  type ExternalRecentDir,
} from "../external-terminal-dirs";
import {
  AGENTS,
  type ComboSurfaceDto,
  type Profile,
  type ProjectDto,
  type WorkspaceDto,
} from "../types";
import { Modal } from "./Modal";
import {
  InlineNotice,
  fieldClass,
  ghostActionClass,
  primaryActionClass,
  secondaryActionClass,
} from "./PageFrame";

export type ExternalTerminalTarget =
  | {
      kind: "new";
      profile: Profile;
      initialEffort?: string | null;
      initialFullAccess?: boolean;
    }
  | {
      kind: "resume";
      agentId: string;
      sessionId: string;
      title: string;
      initialCwd: string;
      profile: Profile | null;
      initialModel: string | null;
      initialEffort?: string | null;
      provider: string | null;
      baseUrl: string | null;
      initialFullAccess?: boolean;
    };

function readLegacyLastLaunchCwd(): string {
  try {
    const parsed = JSON.parse(localStorage.getItem("ccode.lastLaunch") ?? "{}") as Record<
      string,
      unknown
    >;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return typeof parsed.cwd === "string" ? parsed.cwd.trim() : "";
    }
  } catch {
    /* 损坏的本地记忆不阻断外部启动 */
  }
  return "";
}

function loadExternalRecentDirs(): ExternalRecentDir[] {
  try {
    return parseExternalRecentDirs(localStorage.getItem(EXTERNAL_TERMINAL_DIRS_KEY), IS_WINDOWS);
  } catch {
    return [];
  }
}

function agentDisplayName(agentId: string): string {
  return AGENTS.find((a) => a.id === agentId)?.label ?? agentId;
}

/**
 * 外部终端启动与续聊统一弹窗：
 * 集中完成工作文件夹选择（最近项目一键选 + 系统文件夹浏览）、模型选择与「完全访问权限」切换
 *（各家 CLI 对话内部按 Shift+Tab 无法切到完全访问档，必须在启动时传入）。
 */
export function ExternalTerminalDialog({
  target,
  onClose,
  onLaunched,
}: {
  target: ExternalTerminalTarget | null;
  onClose: () => void;
  onLaunched?: (info: { fullAccess: boolean; cwd: string }) => void;
}) {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const agents = useAppStore((s) => s.agents);
  const storeRecentRepos = useAppStore((s) => s.recentRepos);
  const loadRecentRepos = useAppStore((s) => s.loadRecentRepos);
  const contextProjectPath = useAppStore((s) => s.contextLabel?.projectPath ?? null);
  const defaultFull = Boolean(settings?.externalTerminalFullAccess);

  const [cwd, setCwd] = useState("");
  const [cwdEdited, setCwdEdited] = useState(false);
  const cwdEditedRef = useRef(false);
  const [externalRecent, setExternalRecent] = useState<ExternalRecentDir[]>(() =>
    loadExternalRecentDirs(),
  );
  const [pickedDirs, setPickedDirs] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedEffort, setSelectedEffort] = useState("");
  const [effortSurface, setEffortSurface] = useState<{
    allowed: boolean;
    levels: string[];
    launchEffort: string | null;
  }>({ allowed: false, levels: [], launchEffort: null });
  const [fullAccess, setFullAccess] = useState(false);
  const [rememberDefault, setRememberDefault] = useState(false);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [workspaces, setWorkspaces] = useState<
    Pick<WorkspaceDto, "repoPath" | "worktreePath">[]
  >([]);
  const [homeDir, setHomeDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!target) return;
    setBusy(false);
    setError(null);
    setRememberDefault(false);
    setCwdEdited(false);
    cwdEditedRef.current = false;
    setPickedDirs([]);
    const extRecent = loadExternalRecentDirs();
    setExternalRecent(extRecent);
    void loadRecentRepos();
    setFullAccess(target.initialFullAccess ?? defaultFull);
    setSelectedEffort(target.initialEffort?.trim().toLowerCase() ?? "");

    if (target.kind === "new") {
      setCwd(
        resolveDefaultExternalCwd({
          externalRecent: extRecent,
          projects,
          recentRepos: useAppStore.getState().recentRepos,
          workspaces,
          contextProjectPath,
          legacyLastLaunchCwd: readLegacyLastLaunchCwd(),
          homeDir,
          isWindows: IS_WINDOWS,
        }),
      );
      setSelectedModel(target.profile.models[0] ?? "");
    } else {
      setCwd(target.initialCwd.trim());
      setSelectedModel(target.initialModel ?? target.profile?.models[0] ?? "");
    }

    let cancelled = false;
    Promise.all([
      invoke<ProjectDto[]>("list_projects").catch(() => [] as ProjectDto[]),
      invoke<Pick<WorkspaceDto, "repoPath" | "worktreePath">[]>("list_workspaces").catch(
        () => [] as Pick<WorkspaceDto, "repoPath" | "worktreePath">[],
      ),
      invoke<string>("home_dir").catch(() => ""),
    ]).then(([projList, wsList, home]) => {
      if (cancelled) return;
      setProjects(projList);
      setWorkspaces(wsList);
      if (home) setHomeDir(home);
    });
    return () => {
      cancelled = true;
    };
  }, [target, defaultFull]);

  useEffect(() => {
    if (!target || target.kind !== "new" || cwdEditedRef.current) return;
    const resolved = resolveDefaultExternalCwd({
      externalRecent,
      projects,
      recentRepos: storeRecentRepos,
      workspaces,
      contextProjectPath,
      legacyLastLaunchCwd: readLegacyLastLaunchCwd(),
      homeDir,
      isWindows: IS_WINDOWS,
    });
    if (resolved) setCwd(resolved);
  }, [
    target,
    externalRecent,
    projects,
    storeRecentRepos,
    workspaces,
    contextProjectPath,
    homeDir,
  ]);

  const activeProfile = target ? target.profile : null;
  const activeAgentId = target ? (target.kind === "new" ? target.profile.agent : target.agentId) : "";

  useEffect(() => {
    if (!target) {
      setEffortSurface({ allowed: false, levels: [], launchEffort: null });
      return;
    }
    const detLevels = agents.find((a) => a.id === activeAgentId)?.effort?.levels ?? [];
    if (!activeProfile) {
      // 未匹配到连接卡的外部历史会话续聊：对官方/本机默认 CLI 按 Agent 与模型给出思考档位
      const m = selectedModel.trim().toLowerCase();
      if (activeAgentId === "agy") {
        const nonGemini =
          m && !m.startsWith("gemini-") && !m.startsWith("gpt-oss");
        if (nonGemini) {
          setEffortSurface({ allowed: false, levels: [], launchEffort: null });
        } else {
          const levels = m.includes("gemini-4-hydrogen")
            ? ["low", "medium", "high", "xhigh"]
            : m.includes("gemini-3.1-pro")
              ? ["low", "high"]
              : ["low", "medium", "high"];
          setEffortSurface({ allowed: true, levels, launchEffort: null });
        }
      } else if (activeAgentId === "claude-code" || activeAgentId === "codex") {
        setEffortSurface({
          allowed: true,
          levels: detLevels.length > 0 ? detLevels : ["low", "medium", "high"],
          launchEffort: null,
        });
      } else {
        setEffortSurface({ allowed: false, levels: [], launchEffort: null });
      }
      return;
    }

    let stale = false;
    invoke<ComboSurfaceDto>("combo_surface", {
      profileId: activeProfile.id,
      model: selectedModel.trim() || null,
    })
      .then((c) => {
        if (stale) return;
        const allowed = c.injectEffortAllowed === true;
        const levels =
          c.effortLevels && c.effortLevels.length > 0
            ? c.effortLevels
            : detLevels.length > 0
              ? detLevels
              : ["low", "medium", "high"];
        setEffortSurface({
          allowed,
          levels: allowed ? levels : [],
          launchEffort: c.launchEffort ?? null,
        });
        if (allowed) {
          setSelectedEffort((prev) => (prev && !levels.includes(prev) ? "" : prev));
        } else {
          setSelectedEffort("");
        }
      })
      .catch(() => {
        if (!stale) setEffortSurface({ allowed: false, levels: [], launchEffort: null });
      });
    return () => {
      stale = true;
    };
  }, [target, activeProfile, activeAgentId, selectedModel, agents]);

  const modelOptions = useMemo(() => {
    if (!target) return [];
    const out: string[] = [];
    const pushUnique = (m: string | null | undefined) => {
      const v = m?.trim();
      if (v && !out.includes(v)) out.push(v);
    };
    if (target.kind === "new") {
      for (const m of target.profile.models) pushUnique(m);
    } else {
      pushUnique(target.initialModel);
      for (const m of target.profile?.models ?? []) pushUnique(m);
    }
    return out;
  }, [target]);

  const recentProjects = useMemo(
    () =>
      buildRecentExternalProjects({
        pickedDirs,
        externalRecent,
        projects,
        recentRepos: storeRecentRepos,
        workspaces,
        homeDir,
        isWindows: IS_WINDOWS,
      }),
    [pickedDirs, externalRecent, projects, storeRecentRepos, workspaces, homeDir],
  );

  function rememberExternalDir(rawPath: string) {
    const next = recordExternalRecentDir(
      loadExternalRecentDirs(),
      rawPath,
      new Date().toISOString(),
      workspaces,
      IS_WINDOWS,
    );
    setExternalRecent(next);
    try {
      localStorage.setItem(EXTERNAL_TERMINAL_DIRS_KEY, JSON.stringify(next));
    } catch {
      /* 存储受限不阻断外部启动 */
    }
  }

  async function pickDirectory() {
    const trimmed = cwd.trim();
    const picked = await openFileDialog({
      directory: true,
      multiple: false,
      ...(trimmed ? { defaultPath: trimmed } : {}),
    });
    if (typeof picked === "string" && picked.trim()) {
      const cleaned = cleanDirPath(picked);
      if (!cleaned) return;
      cwdEditedRef.current = true;
      setCwd(cleaned);
      setCwdEdited(true);
      setPickedDirs((prev) => [
        cleaned,
        ...prev.filter((p) => !samePath(p, cleaned, IS_WINDOWS)),
      ]);
      setError(null);
    }
  }

  async function persistDefaultIfChecked() {
    if (rememberDefault && fullAccess !== defaultFull) {
      await updateSettings({ externalTerminalFullAccess: fullAccess }).catch(() => {});
    }
  }

  async function handleLaunch() {
    if (!target) return;
    const finalCwd = cleanDirPath(cwd);
    if (!finalCwd) {
      setError("请先选择或输入工作文件夹");
      return;
    }
    const finalEffort =
      effortSurface.allowed && selectedEffort && effortSurface.levels.includes(selectedEffort)
        ? selectedEffort
        : null;
    setBusy(true);
    setError(null);
    try {
      await persistDefaultIfChecked();
      if (target.kind === "new") {
        rememberExternalDir(finalCwd);
        await invoke("new_external_terminal", {
          agentId: target.profile.agent,
          cwd: finalCwd,
          profileId: target.profile.id,
          model: selectedModel.trim() || target.profile.models[0] || null,
          effort: finalEffort,
          fullAccess,
        });
      } else {
        if (cwdEdited || !isInternalWorktreeOrScratch(finalCwd, workspaces, IS_WINDOWS)) {
          rememberExternalDir(finalCwd);
        }
        await invoke("resume_external_terminal", {
          agentId: target.agentId,
          sessionId: target.sessionId,
          cwd: finalCwd,
          profileId: target.profile?.id ?? null,
          model: selectedModel.trim() || null,
          effort: finalEffort,
          provider: target.provider,
          baseUrl: target.baseUrl,
          title: target.title,
          fullAccess,
        });
      }
      onLaunched?.({ fullAccess, cwd: finalCwd });
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleCopyCommand() {
    if (!target) return;
    const finalCwd = cleanDirPath(cwd);
    if (!finalCwd) {
      setError("请先选择或输入工作文件夹");
      return;
    }
    const finalEffort =
      effortSurface.allowed && selectedEffort && effortSurface.levels.includes(selectedEffort)
        ? selectedEffort
        : null;
    setError(null);
    try {
      await persistDefaultIfChecked();
      if (target.kind === "new") {
        rememberExternalDir(finalCwd);
        const cmd = await invoke<string>("profile_terminal_command", {
          profileId: target.profile.id,
          fullAccess,
          cwd: finalCwd,
          model: selectedModel.trim() || null,
          effort: finalEffort,
        });
        await navigator.clipboard.writeText(cmd);
        toast(
          fullAccess
            ? "已复制终端启动命令（含文件夹与完全访问参数；经 mesa_helper 现取密钥，不落明文）"
            : "已复制终端启动命令（含文件夹；经 mesa_helper 现取密钥，不落明文）",
          "success",
        );
      } else {
        if (cwdEdited || !isInternalWorktreeOrScratch(finalCwd, workspaces, IS_WINDOWS)) {
          rememberExternalDir(finalCwd);
        }
        const cmd = await invoke<string>("session_resume_command", {
          agentId: target.agentId,
          sessionId: target.sessionId,
          cwd: finalCwd,
          baseUrl: target.baseUrl,
          provider: target.provider,
          profileId: target.profile?.id ?? null,
          fullAccess,
          model: selectedModel.trim() || null,
          effort: finalEffort,
        });
        await navigator.clipboard.writeText(cmd);
        const needsCodexKey = target.agentId === "codex" && Boolean(target.baseUrl);
        const agyViaHelper =
          target.agentId === "agy" &&
          Boolean(target.profile && target.profile.accountType !== "official") &&
          cmd.includes("mesa_helper");
        const needsAgyEnv =
          target.agentId === "agy" &&
          Boolean(target.profile && target.profile.accountType !== "official") &&
          !agyViaHelper;
        toast(
          needsCodexKey
            ? "已复制继续命令。这段对话走的是 Mesa 的连接，终端里要先设好 CODEX_API_KEY 才能接上；直接点「在外部终端继续」更省事"
            : agyViaHelper
              ? "已复制继续命令（运行时经 mesa_helper 现取密钥与 --settings，不落明文，粘贴到终端即可继续）"
              : needsAgyEnv
                ? "已复制继续命令。这段对话走的是 Mesa 的 API 连接，终端直接运行缺 --settings 与 GEMINI_API_KEY；直接点「在外部终端继续」更省事"
                : "已复制继续命令，粘贴到终端即可运行",
          needsCodexKey || needsAgyEnv ? "warning" : "success",
        );
      }
      onClose();
    } catch (e) {
      setError(`复制失败：${String(e)}`);
    }
  }

  const agentId = target ? (target.kind === "new" ? target.profile.agent : target.agentId) : "";
  const agentName = agentId ? agentDisplayName(agentId) : "";
  const modalTitle = !target
    ? ""
    : target.kind === "new"
      ? `在外部终端打开：${target.profile.name}`
      : "在外部终端继续";
  const modalDesc = !target
    ? undefined
    : target.kind === "new"
      ? `${agentName} · 按这条连接注入配置并在系统外部终端新开对话`
      : `${agentName} · ${target.title || target.sessionId}${
          target.profile ? `（连接：${target.profile.name}）` : ""
        }`;

  const modal = (
    <Modal
      open={target != null}
      title={modalTitle}
      description={modalDesc}
      size="md"
      dismissOnBackdrop={!busy}
      initialFocusRef={confirmBtnRef}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        target ? (
          <div className="flex w-full items-center justify-between gap-2">
            <button
              type="button"
              className={ghostActionClass}
              disabled={busy || !cwd.trim()}
              onClick={() => void handleCopyCommand()}
              title="复制带文件夹与权限参数的命令，粘贴到已打开的任意终端窗口运行"
            >
              <Copy size={13} aria-hidden="true" />
              {target.kind === "new" ? "复制启动命令" : "复制继续命令"}
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={ghostActionClass}
                disabled={busy}
                onClick={onClose}
              >
                取消
              </button>
              <button
                ref={confirmBtnRef}
                type="button"
                className={primaryActionClass}
                disabled={busy || !cwd.trim()}
                onClick={() => void handleLaunch()}
              >
                <SquareArrowOutUpRight size={13} aria-hidden="true" />
                {busy
                  ? "正在打开…"
                  : target.kind === "new"
                    ? "打开外部终端"
                    : "在外部终端继续"}
              </button>
            </div>
          </div>
        ) : null
      }
    >
      {target && (
        <div className="flex flex-col gap-4">
          {/* 1. 工作文件夹 */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-l1">工作文件夹</label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                className={`${fieldClass} min-w-0 flex-1 font-mono text-xs`}
                value={cwd}
                placeholder="选择或输入工作目录路径…"
                onChange={(e) => {
                  cwdEditedRef.current = true;
                  setCwd(e.target.value);
                  setCwdEdited(true);
                  if (error) setError(null);
                }}
              />
              <button
                type="button"
                className={`${secondaryActionClass} shrink-0`}
                disabled={busy}
                onClick={() => void pickDirectory()}
              >
                <FolderOpen size={14} aria-hidden="true" />
                浏览…
              </button>
            </div>
            {recentProjects.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                <span className="text-micro text-l3">最近项目：</span>
                {recentProjects.map((p) => {
                  const active =
                    Boolean(cwd.trim()) && samePath(cwd.trim(), p.path, IS_WINDOWS);
                  return (
                    <button
                      key={p.path}
                      type="button"
                      title={p.path}
                      onClick={() => {
                        cwdEditedRef.current = true;
                        setCwd(p.path);
                        setCwdEdited(true);
                        if (error) setError(null);
                      }}
                      className={`max-w-[11rem] truncate rounded-full border px-2.5 py-0.5 text-micro transition-colors ${
                        active
                          ? "border-field bg-seg-sel font-medium text-l1"
                          : "border-hairline text-l2 hover:border-field hover:bg-hover hover:text-l1"
                      }`}
                    >
                      {p.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* 2. 模型选择 */}
          {modelOptions.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-l1">启动模型</label>
              {modelOptions.length > 1 ? (
                <select
                  className={`${fieldClass} font-mono text-xs`}
                  value={selectedModel}
                  disabled={busy}
                  onChange={(e) => setSelectedModel(e.target.value)}
                >
                  {modelOptions.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="rounded-md border border-hairline bg-inset px-2.5 py-1.5 font-mono text-xs text-l2">
                  {modelOptions[0]}
                </div>
              )}
            </div>
          )}

          {/* 2.5 思考档位 */}
          {effortSurface.allowed && effortSurface.levels.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <label className="text-xs font-medium text-l1">思考档位</label>
                <span className="text-micro text-l3">
                  {agentId === "agy"
                    ? "进入终端后也可输 /effort 或 /model 切换"
                    : effortSurface.launchEffort
                      ? `默认按连接策略（${effortSurface.launchEffort}）`
                      : "不选则按连接或 CLI 默认"}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {[
                  {
                    value: "",
                    label: effortSurface.launchEffort
                      ? `默认（${effortSurface.launchEffort}）`
                      : "默认",
                  },
                  ...effortSurface.levels.map((lv) => ({ value: lv, label: lv })),
                ].map((opt) => {
                  const active = selectedEffort === opt.value;
                  return (
                    <button
                      key={opt.value || "__default__"}
                      type="button"
                      disabled={busy}
                      onClick={() => setSelectedEffort(opt.value)}
                      className={`rounded-md border px-2.5 py-1 font-mono text-xs transition-colors ${
                        active
                          ? "border-field bg-seg-sel font-medium text-l1"
                          : "border-hairline text-l2 hover:border-field hover:bg-hover hover:text-l1"
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* 3. 启动权限 */}
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-medium text-l1">启动权限</span>
              <span className="text-micro text-l3">
                CLI 对话内部 Shift+Tab 无法切到完全访问
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setFullAccess(false)}
                className={`flex flex-col items-start gap-1 rounded-md border p-2.5 text-left transition-colors ${
                  !fullAccess
                    ? "border-field bg-seg-sel text-l1"
                    : "border-hairline text-l2 hover:border-field hover:bg-hover"
                }`}
              >
                <span className="flex items-center gap-1.5 text-xs font-medium">
                  <ShieldCheck size={14} className="shrink-0" aria-hidden="true" />
                  默认权限
                </span>
                <span className="text-micro leading-4 text-l3">
                  常规确认模式，对话内可按 Shift+Tab 切换常规档
                </span>
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setFullAccess(true)}
                className={`flex flex-col items-start gap-1 rounded-md border p-2.5 text-left transition-colors ${
                  fullAccess
                    ? "border-caution-text/50 bg-seg-sel text-l1"
                    : "border-hairline text-l2 hover:border-field hover:bg-hover"
                }`}
              >
                <span
                  className={`flex items-center gap-1.5 text-xs font-medium ${
                    fullAccess ? "text-caution-text" : ""
                  }`}
                >
                  <ShieldAlert size={14} className="shrink-0" aria-hidden="true" />
                  完全访问
                </span>
                <span className="text-micro leading-4 text-l3">
                  跳过操作确认，启动即带完全访问参数
                </span>
              </button>
            </div>

            {fullAccess && (
              <InlineNotice tone="warn">
                这次外部终端会话里 {agentName} 删文件、装软件不会先问你；不确定请选「默认权限」。
              </InlineNotice>
            )}

            {fullAccess !== defaultFull && (
              <label className="flex cursor-pointer items-center gap-2 pt-0.5 text-xs text-l2 select-none">
                <input
                  type="checkbox"
                  checked={rememberDefault}
                  onChange={(e) => setRememberDefault(e.target.checked)}
                  className="rounded border-field"
                />
                <span>
                  以后外部终端默认都用「{fullAccess ? "完全访问" : "默认权限"}」（可在「设置 → 终端」改回）
                </span>
              </label>
            )}
          </div>

          {error && <InlineNotice tone="err">{error}</InlineNotice>}
        </div>
      )}
    </Modal>
  );
  return typeof document !== "undefined" ? createPortal(modal, document.body) : modal;
}
