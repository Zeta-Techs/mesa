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
import { AGENTS, type Profile, type ProjectDto } from "../types";
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
      provider: string | null;
      baseUrl: string | null;
      initialFullAccess?: boolean;
    };

function readLastLaunch(): { raw: Record<string, unknown>; cwd: string } {
  try {
    const parsed = JSON.parse(localStorage.getItem("ccode.lastLaunch") ?? "{}") as Record<
      string,
      unknown
    >;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        raw: parsed,
        cwd: typeof parsed.cwd === "string" ? parsed.cwd.trim() : "",
      };
    }
  } catch {
    /* 损坏的本地记忆不阻断外部启动 */
  }
  return { raw: {}, cwd: "" };
}

function saveLastLaunchCwd(cwd: string) {
  const trimmed = cwd.trim();
  if (!trimmed) return;
  try {
    const { raw } = readLastLaunch();
    localStorage.setItem("ccode.lastLaunch", JSON.stringify({ ...raw, cwd: trimmed }));
  } catch {
    /* 存储受限不阻断外部启动 */
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
  const defaultFull = Boolean(settings?.externalTerminalFullAccess);

  const [cwd, setCwd] = useState("");
  const [cwdEdited, setCwdEdited] = useState(false);
  const [selectedModel, setSelectedModel] = useState("");
  const [fullAccess, setFullAccess] = useState(false);
  const [rememberDefault, setRememberDefault] = useState(false);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!target) return;
    setBusy(false);
    setError(null);
    setRememberDefault(false);
    setCwdEdited(false);
    setFullAccess(target.initialFullAccess ?? defaultFull);

    if (target.kind === "new") {
      const { cwd: lastCwd } = readLastLaunch();
      setCwd(lastCwd);
      setSelectedModel(target.profile.models[0] ?? "");
    } else {
      setCwd(target.initialCwd.trim());
      setSelectedModel(target.initialModel ?? target.profile?.models[0] ?? "");
    }

    let cancelled = false;
    invoke<ProjectDto[]>("list_projects")
      .then((list) => {
        if (cancelled) return;
        setProjects(list);
        if (target.kind === "new" && !readLastLaunch().cwd && list[0]?.path) {
          setCwd((prev) => (prev.trim() ? prev : list[0].path));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [target, defaultFull]);

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

  const recentProjects = useMemo(() => projects.slice(0, 6), [projects]);

  async function pickDirectory() {
    const trimmed = cwd.trim();
    const picked = await openFileDialog({
      directory: true,
      multiple: false,
      ...(trimmed ? { defaultPath: trimmed } : {}),
    });
    if (typeof picked === "string" && picked.trim()) {
      setCwd(picked.trim());
      setCwdEdited(true);
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
    const finalCwd = cwd.trim();
    if (!finalCwd) {
      setError("请先选择或输入工作文件夹");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await persistDefaultIfChecked();
      if (target.kind === "new") {
        saveLastLaunchCwd(finalCwd);
        await invoke("new_external_terminal", {
          agentId: target.profile.agent,
          cwd: finalCwd,
          profileId: target.profile.id,
          model: selectedModel.trim() || target.profile.models[0] || null,
          fullAccess,
        });
      } else {
        if (cwdEdited) saveLastLaunchCwd(finalCwd);
        await invoke("resume_external_terminal", {
          agentId: target.agentId,
          sessionId: target.sessionId,
          cwd: finalCwd,
          profileId: target.profile?.id ?? null,
          model: selectedModel.trim() || null,
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
    const finalCwd = cwd.trim();
    if (!finalCwd) {
      setError("请先选择或输入工作文件夹");
      return;
    }
    setError(null);
    try {
      await persistDefaultIfChecked();
      if (target.kind === "new") {
        saveLastLaunchCwd(finalCwd);
        const cmd = await invoke<string>("profile_terminal_command", {
          profileId: target.profile.id,
          fullAccess,
          cwd: finalCwd,
          model: selectedModel.trim() || null,
        });
        await navigator.clipboard.writeText(cmd);
        toast(
          fullAccess
            ? "已复制终端启动命令（含文件夹与完全访问参数；经 mesa_helper 现取密钥，不落明文）"
            : "已复制终端启动命令（含文件夹；经 mesa_helper 现取密钥，不落明文）",
          "success",
        );
      } else {
        const cmd = await invoke<string>("session_resume_command", {
          agentId: target.agentId,
          sessionId: target.sessionId,
          cwd: finalCwd,
          baseUrl: target.baseUrl,
          provider: target.provider,
          profileId: target.profile?.id ?? null,
          fullAccess,
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
                  const active = cwd.trim() === p.path;
                  return (
                    <button
                      key={p.path}
                      type="button"
                      title={p.path}
                      onClick={() => {
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
