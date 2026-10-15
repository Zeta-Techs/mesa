import { useEffect, useRef, useState } from "react";
import { FolderOpen } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { AGENTS } from "../types";
import { KIMI_CSI_U_ENTER } from "../terminal-input";
import { isTerminalIdle } from "../terminal-welcome";
import type { ComboSurfaceDto, DetectResult, GitCommitResultDto, SessionUsageDto } from "../types";
import type { GitSummary } from "./GitPanel";
import type { TabStatus } from "../pages/TerminalPage";

/**
 * 终端底部状态栏（胶囊化）：32px 固置于终端 pane 内部下缘，与终端同底同色。
 * 未启动（无 PTY）只留状态点 + 目录胶囊——agent/配置/模型与启动栏去重，切模型芯片
 * 启动后才出现（未启动点了也无效）。进程存活后：
 * 左区 = 状态圆点 + agent · 配置 · 模型（可点切）+ 思考强度 step 滑块；
 * 中区 = git 连体胶囊（分支/变更 + Commit & Push：AI 生成提交信息→提交并推送→Toast 预览）；
 * 右区 = 运行时长 · 本会话 token（等宽小字）。
 * 切换类控件只写 TUI 命令、不回读 CLI 内部状态——模型名按用户切的选择显示（内存态）。
 * chat 变体（2026-09-13）：聊天页（非 peek）不再沿用「与 xterm 同底」的终端语言——
 * 底色改涂 var(--color-canvas) 与聊天画布同源（消除两套深色相接的色差缝），
 * 内容与输入卡同一条 max-w-4xl 中轴，模型胶囊统一成目录胶囊的灰调（蓝色强调只留给状态点）；
 * 几何不变（32px 恒定，切层不改终端行列数），终端模式完全不动。
 */

/** 状态栏配色（取自建端主题的 buildXtermTheme 结果，与终端画面同底同色） */
export interface StatusBarColors {
  background: string;
  foreground: string;
  green: string;
  red: string;
  yellow: string;
  blue: string;
}

/** token 计数紧凑格式化（状态栏与右栏会话底条共用） */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
    : `${m}:${String(ss).padStart(2, "0")}`;
}

export default function TerminalStatusBar({
  status,
  fallbackCwd,
  profileId,
  profileName,
  profileModels,
  launchModel,
  modelSwitch,
  effort,
  git,
  mergeReady,
  gitCwd,
  /** TUI 的 Enter 要 CSI-u 形式（kitty 键盘协议；kimi） */
  submitCsiU,
  onOpenGit,
  onGenerateMsg,
  onCommitPush,
  onCwdChange,
  onTermLog,
  colors,
  variant = "terminal",
}: {
  /** null = 终端尚未上报（刚挂载）：显示 cwd + 未启动占位 */
  status: TabStatus | null;
  fallbackCwd: string;
  profileId: string | null;
  profileName: string | null;
  profileModels: string[];
  /** 启动时注入的模型；求交不跟 CLI 内 /model */
  launchModel: string | null;
  modelSwitch: DetectResult["modelSwitch"];
  effort: DetectResult["effort"];
  git: GitSummary | null;
  mergeReady: string[];
  /** git 胶囊操作的目标目录（gitPanelCwd：跟随文件树的根） */
  gitCwd: string;
  submitCsiU: boolean;
  onOpenGit: () => void;
  /** Commit & Push 流程第一步：AI 生成提交信息（style = 分割菜单的风格偏好，空串 = 默认） */
  onGenerateMsg: (style: string) => Promise<string>;
  /** Commit & Push 流程第二步：以确认的信息提交 + 推送，返回结果（hash 用于成功态显示） */
  onCommitPush: (msg: string) => Promise<GitCommitResultDto>;
  /** 浮层改工作目录（仅未启动时可用；运行/shell 中由 pty_get_cwd 回写跟随） */
  onCwdChange?: (cwd: string) => void;
  /** 往终端画面写一行浅灰日志（防黑盒：Commit & Push 流程的每步都回显） */
  onTermLog: (line: string) => void;
  colors: StatusBarColors;
  /** terminal（默认）= 与 xterm 画布同底无缝卡；chat = 聊天页原生变体（画布同色 + 居中列 + 灰调胶囊） */
  variant?: "terminal" | "chat";
}) {
  const agentLabel = status
    ? (AGENTS.find((a) => a.id === status.agentId)?.label ?? status.agentId)
    : null;
  const fg = colors.foreground;
  const dim = `${fg}99`; // 60% 弱化
  const faint = `${fg}66`; // 40% 最弱
  const chat = variant === "chat";
  // 浮层底：终端变体沿用 xterm 底色（与画面同源）；chat 变体走主题 raised 令牌（与聊天浮层同语言）
  const floatBg = chat ? "var(--color-raised)" : colors.background;

  // 模型显示名：用户经状态栏切换后的内存态覆盖（CLI 内部状态 Mesa 不回读）
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const tabKey = status
    ? `${status.agentId}:${status.profileId}:${status.cwd}`
    : "";
  const lastTabKey = useRef(tabKey);
  if (lastTabKey.current !== tabKey) {
    lastTabKey.current = tabKey;
    setModelOverride(null);
  }
  const shownModel = modelOverride ?? status?.model ?? "";

  // 运行时长：运行中每秒走时，退出后定格
  const [now, setNow] = useState(() => Date.now());
  const running = status?.running ?? false;
  const startedAt = status?.startedAt ?? null;
  useEffect(() => {
    if (!running || startedAt == null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running, startedAt]);

  // 本会话 token：60s 轮询 + 注意力跃迁时即刷；无会话关联不显示
  const [usage, setUsage] = useState<SessionUsageDto | null>(null);
  const sessionId = status?.sessionId ?? null;
  const attention = status?.attention ?? null;
  const usageAgent = status?.agentId ?? "";
  useEffect(() => {
    if (!sessionId) {
      setUsage(null);
      return;
    }
    let stale = false;
    const pull = () => {
      invoke<SessionUsageDto>("session_usage", {
        agent: usageAgent,
        sessionId,
      })
        .then((u) => {
          if (!stale) setUsage(u);
        })
        .catch(() => {});
    };
    pull();
    const t = setInterval(pull, 60_000);
    return () => {
      stale = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, usageAgent, attention]);

  function writeCmd(cmd: string) {
    if (status?.ptyId) {
      // Enter 形式按各家 TUI 键盘协议分派：kimi 开了 kitty 协议只认 CSI-u（\x1b[13u），
      // 其余认 \r（与 injectToActiveAgent 的「send 补 \r」同口径）
      const enter = submitCsiU ? KIMI_CSI_U_ENTER : "\r";
      invoke("pty_write", { ptyId: status.ptyId, data: `${cmd}${enter}` }).catch(
        () => {},
      );
    }
  }

  function pickModel(m: string) {
    setModelMenuOpen(false);
    if (!modelSwitch || modelSwitch.kind !== "direct") return;
    // kimi 的 /model 参数是 config.toml 的 [models.*] 别名（非法字符清洗为 _，
    // 与 global_config.rs 的 kimi_model_alias 同规则）；别家直接吃模型 id
    const arg =
      status?.agentId === "kimi" ? m.replace(/[^A-Za-z0-9_-]/g, "_") : m;
    writeCmd(modelSwitch.command.replace("{model}", arg));
    setModelOverride(m);
  }

  const [combo, setCombo] = useState<ComboSurfaceDto | null>(null);
  const [comboReady, setComboReady] = useState(false);
  useEffect(() => {
    if (!profileId || !launchModel) {
      setCombo(null);
      setComboReady(true);
      return;
    }
    let cancelled = false;
    setComboReady(false);
    invoke<ComboSurfaceDto>("combo_surface", {
      profileId,
      model: launchModel,
    })
      .then((c) => {
        if (!cancelled) {
          setCombo(c);
          setComboReady(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCombo(null);
          setComboReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [profileId, launchModel]);
  // 未确认不显示：combo 未加载或求交明确不允许时藏 /effort
  const effortLive =
    comboReady && combo?.showNativeEffort === true ? effort : null;

  // 思考强度 step 滑块：隐形原生 range 负责拖动/键盘，自定义轨道负责视觉；松手才写命令
  const levels =
    combo?.effortLevels && combo.effortLevels.length > 0
      ? combo.effortLevels
      : (effortLive?.levels ?? []);
  const [effortIdxRaw, setEffortIdx] = useState(() =>
    Math.min(1, Math.max(0, levels.length - 1)),
  );
  // 切到档位更少的 agent 后旧下标可能越界：渲染/写命令一律用钳制值
  const effortIdx = Math.min(effortIdxRaw, Math.max(0, levels.length - 1));
  function commitEffort() {
    if (effortLive && levels[effortIdx]) {
      writeCmd(effortLive.command.replace("{level}", levels[effortIdx]));
    }
  }

  // ===== Commit & Push 状态机：idle → generating → review(倒计时) → pushing → success =====
  type CpPhase = "idle" | "generating" | "review" | "pushing" | "success";
  const [phase, setPhase] = useState<CpPhase>("idle");
  const [msg, setMsg] = useState(""); // 生成的提交信息（review 里可改）
  const [editMsg, setEditMsg] = useState(""); // ✎ 编辑中的副本
  const [editing, setEditing] = useState(false);
  const [countPct, setCountPct] = useState(100); // review 倒计时进度（100→0）
  const [paused, setPaused] = useState(false); // hover 气泡暂停倒计时
  const [mode, setMode] = useState<"auto" | "dry">(() =>
    typeof localStorage !== "undefined" &&
    localStorage.getItem("ccode.commitPushMode") === "dry"
      ? "dry"
      : "auto",
  );
  const [stylePref, setStylePref] = useState(() =>
    typeof localStorage !== "undefined"
      ? (localStorage.getItem("ccode.commitStyle") ?? "")
      : "",
  );
  const [splitOpen, setSplitOpen] = useState(false);
  const [successHash, setSuccessHash] = useState<string | null>(null);
  const [errToast, setErrToast] = useState<string | null>(null);
  const snapRef = useRef({ files: 0, add: 0, del: 0 }); // 生成时的变更快照（气泡摘要）

  function switchMode(m: "auto" | "dry") {
    setMode(m);
    try {
      localStorage.setItem("ccode.commitPushMode", m);
    } catch {}
  }
  function saveStyle(s: string) {
    setStylePref(s);
    try {
      localStorage.setItem("ccode.commitStyle", s);
    } catch {}
  }

  function reset() {
    setPhase("idle");
    setEditing(false);
    setSplitOpen(false);
  }

  async function startGenerate() {
    if (phase !== "idle" || !git) return;
    snapRef.current = { files: git.files.length, add: git.add, del: git.del };
    setPhase("generating");
    onTermLog("[Agent] Analyzing git diff…");
    try {
      const m = await onGenerateMsg(stylePref);
      setMsg(m);
      setEditMsg(m);
      onTermLog(`[Agent] Commit message: "${m.split("\n")[0]}"`);
      setCountPct(100);
      setPaused(false);
      setPhase("review");
    } catch (e) {
      setErrToast(`生成提交信息失败：${String(e)}`);
      setPhase("idle");
    }
  }

  async function execute() {
    setPhase("pushing");
    onTermLog(`[Agent] Executing: git commit && git push`);
    try {
      const res = await onCommitPush(editMsg);
      if (res.failedPhase === "push") {
        // 提交已成、推送失败：不算成功态，红 Toast 告知可直接用「⇧ 推送」重试
        setErrToast("提交已完成，但推送失败——状态栏「⇧ 推送」可直接重试");
        onTermLog("[Agent] 提交完成，推送失败（可单独重试推送）");
        setPhase("idle");
        return;
      }
      setSuccessHash(res.hash);
      setPhase("success");
      onTermLog(`[Agent] ${res.message}${res.hash ? ` [${res.hash}]` : ""}`);
      setTimeout(reset, 2000);
    } catch (e) {
      setErrToast(`提交/推送失败：${String(e)}`);
      onTermLog(`[Agent] 失败：${String(e)}`);
      setPhase("idle");
    }
  }

  // review 倒计时（auto 模式 3s）：hover 气泡或编辑提交信息时暂停；Dry Run 模式停在预览不自动执行
  useEffect(() => {
    if (phase !== "review" || mode !== "auto" || paused || editing) return;
    const started = Date.now();
    const from = countPct;
    const t = setInterval(() => {
      const left = from - ((Date.now() - started) / 3000) * 100;
      if (left <= 0) {
        clearInterval(t);
        void execute();
      } else {
        setCountPct(left);
      }
    }, 50);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // editing 必须在依赖里：否则进入编辑态后旧闭包里的倒计时继续跑，到点提交旧文案
  }, [phase, mode, paused, editing]);

  // Esc 取消（generating/review）、Enter 立即执行（review）
  useEffect(() => {
    if (phase !== "generating" && phase !== "review") return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (editing) {
          // 焦点在编辑框里：交给输入框自己处理（退出编辑、还原原文），不取消整个流程；
          // 焦点已不在编辑框（点了别处）：Esc 退出编辑态，保留已改文案
          const t = e.target as HTMLElement | null;
          if (t && t.tagName === "INPUT") return;
          setEditing(false);
          return;
        }
        e.stopPropagation();
        reset();
      } else if (e.key === "Enter" && phase === "review" && !editing) {
        // 焦点在 md 预览编辑器（monaco）里：Enter 是换行/续列表的编辑键，
        // 不当「立即执行」评审动作（一次按键双动作，2026-10-14 审查补守卫）
        const t = e.target as HTMLElement | null;
        if (t && t.closest(".monaco-editor")) return;
        e.preventDefault();
        void execute();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, editing, editMsg]);

  // 纯推送（无改动有 ahead）与错误 Toast 的自动消隐
  const [pushBusy, setPushBusy] = useState(false);
  async function pushOnly() {
    if (pushBusy) return;
    setPushBusy(true);
    onTermLog("[Agent] git push");
    try {
      await invoke<string>("git_push", { cwd: gitCwd });
      onTermLog("[Agent] 已推送到远程");
    } catch (e) {
      setErrToast(`推送失败：${String(e)}`);
    } finally {
      setPushBusy(false);
    }
  }
  useEffect(() => {
    if (!errToast) return;
    const t = setTimeout(() => setErrToast(null), 4000);
    return () => clearTimeout(t);
  }, [errToast]);

  const dotColor = !status
    ? faint
    : attention === "confirm"
      ? colors.yellow
      : attention === "working" || status.running
        ? colors.blue
        : attention === "done"
          ? colors.green
          : faint;
  const dotTitle = !status
    ? "未启动"
    : attention === "confirm"
      ? "待确认"
      : attention === "working" || status.running
        ? "工作中"
        : attention === "done"
          ? "完成"
          : status.shell
            ? startedAt != null
              ? "Agent 已退出（Shell 运行中）"
              : "Shell 运行中"
            : "已退出";

  const hasGit = !!(git?.isRepo && (git.files.length > 0 || git.ahead > 0));
  // Agent 还在本标签干活时禁用提交段（与改动面板 running === null 门控同口径）：
  // 中途提交会把半成品存进历史，还可能与 Agent 自己的收尾提交相撞；
  // 此前只看「有没有改动」，Agent 工作中按钮照常亮着（用户实测误以为「可提交」）
  const agentBusy = status?.running === true;
  const hasCommittable = !!git?.isRepo && git.files.length > 0;
  // 无未提交改动但有未推送提交时，右段退化为纯推送（同改动面板「保存并推送」的推送半段）
  const canPushOnly = !hasCommittable && !!git?.isRepo && git.ahead > 0;
  const cwdRaw = status?.cwd ?? fallbackCwd;
  const cwdBase =
    cwdRaw.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? cwdRaw;
  // 目录浮层改路径：仅未启动可编辑；进程存活期间 cwd 由 pty_get_cwd 回写跟随（shell 里 cd 即可）
  const cwdLocked = !!status?.ptyId;
  const idle = isTerminalIdle(status);
  const [cwdMenuOpen, setCwdMenuOpen] = useState(false);
  const [cwdDraft, setCwdDraft] = useState("");

  return (
    <div
      className={`relative h-8 shrink-0 overflow-visible rounded-b-xl text-micro whitespace-nowrap select-none ${
        // chat 变体通栏涂画布色（上方 ChatSurface 同为 bg-canvas，接缝消失），
        // px-4 + 内层 max-w-4xl 与 ChatComposer 同构，内容与输入卡同一左缘。
        // 终端变体用 xterm 同源底色，下圆角和画面的上圆角拼成一张卡。
        chat ? "w-full bg-canvas px-4" : "w-full px-3"
      }`}
      style={{
        background: chat ? "var(--color-canvas)" : colors.background,
        color: fg,
      }}
    >
      <div
        className={`flex h-full min-w-0 items-center gap-2.5 ${
          chat ? "mx-auto w-full max-w-4xl" : ""
        }`}
      >
      {/* 左区：状态圆点 + agent · 配置 · 模型 + 思考滑块 */}
      <span
        className="flex min-w-0 items-center gap-2 font-mono"
        style={{ color: dim }}
      >
        <span
          className="inline-block size-2 shrink-0 rounded-full"
          style={{
            background: dotColor,
            boxShadow: status?.running ? `0 0 5px 1px ${dotColor}88` : "none",
          }}
          title={dotTitle}
        />
        {!idle && agentLabel && <span style={{ color: fg }}>{agentLabel}</span>}
        {!idle && profileName && (
          <span className="truncate">· {profileName}</span>
        )}
        {!idle && shownModel &&
          (modelSwitch && profileModels.length > 0 ? (
            modelSwitch.kind === "picker" ? (
              /* picker 档（codex /model、opencode /models）不摆模型菜单：
                 两家 CLI 的切换命令都不吃参数（codex 源码 supports_inline_args
                 不含 Model；opencode run 无参），点哪个模型都只是唤选择器——
                 菜单长得像直选却是假的。点芯片直接唤，少一跳也不误导 */
              <button
                type="button"
                onClick={() => writeCmd(modelSwitch.command)}
                disabled={!status?.ptyId}
                title={
                  status?.ptyId
                    ? "在终端打开模型选择器（这家 CLI 不支持带参直切，模型去选择器里选）"
                    : "启动终端后可切换模型"
                }
                className="rounded-full border-0 px-2 py-0.5 font-mono"
                style={{
                  color: chat ? dim : colors.blue,
                  background: `${fg}0f`,
                  opacity: status?.ptyId ? 1 : 0.5,
                  cursor: status?.ptyId ? "pointer" : "default",
                }}
              >
                {shownModel}
              </button>
            ) : (
              <span className="relative">
                <button
                  type="button"
                  onClick={() => setModelMenuOpen((v) => !v)}
                  disabled={!status?.ptyId}
                  title={
                    status?.ptyId
                      ? "切换模型（写入终端执行）"
                      : "启动终端后可切换模型"
                  }
                  aria-expanded={modelMenuOpen}
                  className="rounded-full border-0 px-2 py-0.5 font-mono"
                  style={{
                    // chat 变体去掉蓝色强调：与目录胶囊同一套灰调语法（蓝色只留给状态点）
                    color: chat ? dim : colors.blue,
                    background: chat && modelMenuOpen ? `${fg}1a` : `${fg}0f`,
                    opacity: status?.ptyId ? 1 : 0.5,
                    cursor: status?.ptyId ? "pointer" : "default",
                  }}
                >
                  {shownModel} ▾
                </button>
                {modelMenuOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-40"
                      onClick={() => setModelMenuOpen(false)}
                    />
                    <ul
                      className="absolute bottom-full left-0 z-50 mb-1 max-h-56 w-56 overflow-auto rounded-md border p-1"
                      style={{
                        background: floatBg,
                        borderColor: `${fg}33`,
                      }}
                    >
                      {profileModels.map((m) => (
                        <li key={m}>
                          <button
                            type="button"
                            onClick={() => pickModel(m)}
                            className="flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left font-mono text-micro"
                            style={{ color: m === shownModel ? fg : dim }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.background = `${fg}1a`;
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.background = "transparent";
                            }}
                          >
                            {m}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </span>
            )
          ) : (
            <span className="truncate">· {shownModel}</span>
          ))}
        {/* 思考强度：档位表 ≥2 = step 滑块直切（claude）；空档位表 = chip 唤 TUI 选择器（kimi） */}
        {!idle && combo?.mixedModelsNote && (
          <span className="ml-1 truncate" style={{ color: faint }} title={combo.mixedModelsNote}>
            换模请重开
          </span>
        )}
        {effortLive && running && levels.length > 1 && (
          <span
            className="ml-1 flex items-center gap-1.5 rounded-full px-2 py-0.5"
            style={{ background: `${fg}0f` }}
            title={`思考档位：${levels[effortIdx]}（${levels.join(" / ")}；松手即写入终端生效）`}
          >
            <span style={{ color: faint }}>◈</span>
            <span className="relative block h-5 w-24">
              {/* 轨道 */}
              <span
                className="absolute top-1/2 left-0 h-1 w-full -translate-y-1/2 rounded-full"
                style={{ background: `${fg}26` }}
              />
              {/* 已选段蓝紫渐变 */}
              <span
                className="absolute top-1/2 left-0 h-1 -translate-y-1/2 rounded-full"
                style={{
                  width: `${(effortIdx / (levels.length - 1)) * 100}%`,
                  background: "linear-gradient(90deg, #3b82f6, #8b5cf6)",
                }}
              />
              {/* 档位节点：选中带微光 */}
              {levels.map((lv, i) => (
                <span
                  key={lv}
                  className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
                  style={{
                    left: `${(i / (levels.length - 1)) * 100}%`,
                    width: i === effortIdx ? 9 : 6,
                    height: i === effortIdx ? 9 : 6,
                    background: i <= effortIdx ? "#8b5cf6" : `${fg}4d`,
                    boxShadow:
                      i === effortIdx
                        ? "0 0 6px 1px rgba(139, 92, 246, 0.65)"
                        : "none",
                  }}
                />
              ))}
              {/* 隐形原生滑块：拖动/键盘无障碍全包 */}
              <input
                type="range"
                min={0}
                max={levels.length - 1}
                step={1}
                value={effortIdx}
                onChange={(e) => setEffortIdx(Number(e.target.value))}
                onPointerUp={commitEffort}
                onKeyUp={commitEffort}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                aria-label="思考档位"
              />
            </span>
            <span className="font-mono" style={{ color: colors.blue }}>
              {levels[effortIdx]}
            </span>
          </span>
        )}
        {effortLive && running && levels.length <= 1 && (
          <button
            type="button"
            onClick={() => writeCmd(effortLive.command)}
            title="切换思考档位（在终端里打开选择器）"
            className="ml-1 cursor-pointer border-0 bg-transparent p-0 font-mono"
            style={{ color: colors.blue }}
          >
            ◈ 思考 ▾
          </button>
        )}
      </span>

      {/* 中区：目录胶囊常驻（点击浮层改目录，仅未启动可编辑）+ git 连体胶囊（有改动/未推送时）。
          终端内 TUI 自己那行状态是字符流删不掉，底栏侧把路径做出辨识度即是冗余的解 */}
      <span className="relative">
        <button
          type="button"
          onClick={() => {
            if (cwdLocked || !onCwdChange) return;
            setCwdDraft(cwdRaw);
            setCwdMenuOpen((v) => !v);
          }}
          title={
            cwdLocked
              ? `${cwdRaw}\n运行中不能改目录（shell 里 cd 即可）`
              : `${cwdRaw}\n点击修改工作目录`
          }
          className="flex items-center gap-1 rounded-full px-2 py-0.5 font-mono"
          style={{
            background: cwdMenuOpen ? `${fg}1a` : `${fg}0f`,
            color: dim,
            cursor: cwdLocked || !onCwdChange ? "default" : "pointer",
          }}
        >
          <FolderOpen aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          {cwdBase}
        </button>
        {cwdMenuOpen && !cwdLocked && onCwdChange && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setCwdMenuOpen(false)}
            />
              <div
                className="ccode-float-surface absolute bottom-full left-0 z-50 mb-1 w-72 rounded-md border p-2"
                style={{
                  borderColor: `${fg}33`,
                  background: floatBg,
                }}
              >
              <div className="mb-1" style={{ color: faint }}>
                工作目录（启动前生效，支持 ~）
              </div>
              <input
                autoFocus
                value={cwdDraft}
                onChange={(e) => setCwdDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const v = cwdDraft.trim();
                    if (v) onCwdChange(v);
                    setCwdMenuOpen(false);
                  }
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setCwdMenuOpen(false);
                  }
                }}
                placeholder="如 ~/work/myproject"
                className="w-full rounded-sm border bg-transparent px-1.5 py-1 font-mono text-micro outline-none"
                style={{ borderColor: `${fg}33`, color: fg }}
              />
            </div>
          </>
        )}
      </span>
      {!idle && hasGit && (
        /* 外包一层 relative 给浮层做锚（菜单右对齐 ▾、气泡左对齐胶囊左缘）；
           内层胶囊保持 overflow-hidden 裁圆角；min-w-0 允许窄窗时收缩防溢出右栏 */
        <span className="relative min-w-0">
        <span
          className="flex items-stretch overflow-hidden rounded-full font-mono"
          style={{ border: `1px solid ${fg}22` }}
        >
          <button
            type="button"
            onClick={onOpenGit}
            title="git 状态，点击查看改动面板"
            className="flex min-w-0 cursor-pointer items-center gap-1 border-0 px-2.5 py-1 font-mono"
            style={{ background: `${fg}12`, color: fg }}
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <circle cx="5" cy="3.5" r="2" />
              <circle cx="5" cy="12.5" r="2" />
              <circle cx="11" cy="6.5" r="2" />
              <path d="M5 5.5v5M11 8.5c0 2-2 2.5-4 2.7" />
            </svg>
            <span className="min-w-0 truncate">{git!.branch || "HEAD"}</span>
            {git!.files.length > 0 && (
              <>
                {" "}
                <span style={{ color: colors.green }}>+{git!.add}</span>{" "}
                <span style={{ color: colors.red }}>-{git!.del}</span>
              </>
            )}
            {git!.ahead > 0 && (
              <span title={`比远程多出 ${git!.ahead} 个提交`}>
                {" "}
                ↑{git!.ahead}
              </span>
            )}
            {git!.behind > 0 && (
              <span title={`远程新增 ${git!.behind} 个提交`}>
                {" "}
                ↓{git!.behind}
              </span>
            )}
          </button>
          {hasCommittable && (
            <>
              {/* 分割按钮主区：随状态机换文案/配色；generating 时点击 = 取消（同 Esc）；
                  Agent 还在干活时禁用——中途提交会存下半成品（见上方 agentBusy 注释） */}
              <button
                type="button"
                onClick={() =>
                  phase === "generating" || phase === "review"
                    ? reset()
                    : void startGenerate()
                }
                disabled={phase === "pushing" || agentBusy}
                title={
                  agentBusy
                    ? "Agent 还在工作；完成后再来保存——中途提交会把半成品存进历史"
                    : phase === "idle"
                      ? "AI 生成提交信息 → 预览倒计时 → 自动提交推送（Esc 随时取消）"
                      : phase === "generating"
                        ? "生成中…点击或 Esc 取消"
                        : phase === "review"
                          ? "点击停止自动提交（信息留在预览里）"
                          : undefined
                }
                className="flex min-w-0 cursor-pointer items-center gap-1 border-0 px-2.5 py-1 font-mono font-medium disabled:cursor-wait"
                style={{
                  background:
                    phase === "idle"
                      ? `linear-gradient(90deg, ${colors.green}cc, #10b981)`
                      : phase === "review"
                        ? `${colors.yellow}cc`
                        : phase === "pushing"
                          ? `${colors.blue}cc`
                          : `${colors.green}55`,
                  color: colors.background,
                  boxShadow:
                    phase === "generating"
                      ? `0 0 8px 1px ${colors.green}66`
                      : "none",
                }}
              >
                {phase === "generating" ? (
                  <>
                    <span className="inline-block animate-spin">◌</span>
                    Analyzing Diff…
                  </>
                ) : phase === "review" ? (
                  // 倒计时秒数实时反馈：剩余时间 = countPct/100 × 3s，点击即 Stop
                  `(${Math.max(1, Math.ceil((countPct / 100) * 3))}) Stop`
                ) : phase === "pushing" ? (
                  <>
                    <span className="inline-block animate-spin">⚙</span>{" "}
                    Pushing…
                  </>
                ) : phase === "success" ? (
                  `✓ Pushed${successHash ? ` [${successHash}]` : ""}`
                ) : (
                  <>
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.1"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M9 16.5 L5.5 16.5 A2.5 2.5 0 1 1 6.03 11.55 A6 6 0 1 1 17.97 11.55 A2.5 2.5 0 1 1 18.5 16.5 L15 16.5" />
                      <polyline points="9.5 13.5 12 11 14.5 13.5" />
                      <line x1="12" y1="11" x2="12" y2="19.5" />
                    </svg>
                    <span className="min-w-0 truncate">
                      {`Commit & Push${git!.files.length > 0 ? ` (+${git!.files.length})` : ""}`}
                    </span>
                  </>
                )}
              </button>
              {/* 分割下拉：模式与风格偏好 */}
              <button
                type="button"
                onClick={() => setSplitOpen((v) => !v)}
                disabled={phase !== "idle" || agentBusy}
                title="Commit & Push 设置"
                aria-expanded={splitOpen}
                className="flex cursor-pointer items-center border-0 px-1.5 font-mono disabled:opacity-50"
                style={{
                  background: `linear-gradient(90deg, #10b981, ${colors.green}cc)`,
                  color: colors.background,
                }}
              >
                ▾
              </button>
            </>
          )}
          {canPushOnly && (
            <button
              type="button"
              onClick={() => void pushOnly()}
              disabled={pushBusy}
              title="推送到远程（无上游分支时自动建立跟踪）"
              className="flex cursor-pointer items-center gap-1 border-0 px-2.5 py-1 font-mono font-medium disabled:cursor-wait"
              style={{
                background: pushBusy ? `${colors.blue}55` : `${colors.blue}cc`,
                color: colors.background,
              }}
            >
              {pushBusy ? (
                <>
                  <span className="inline-block animate-spin">◌</span> 推送中…
                </>
              ) : (
                "⇧ 推送"
              )}
            </button>
          )}
        </span>
      {/* 分割菜单：模式（Auto-Push / Dry Run）+ 风格偏好 */}
      {splitOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setSplitOpen(false)}
          />
          <div
            className="absolute right-0 bottom-full z-50 mb-2 w-72 rounded-md border p-2 font-mono text-micro whitespace-normal"
            style={{
              background: floatBg,
              borderColor: `${fg}33`,
              boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
            }}
          >
            {/* 指向 ▾ 的 caret 小三角：旋转方块，底/右边用菜单边框色 */}
            <span
              className="absolute -bottom-[5px] right-4 block size-2 rotate-45 border-r border-b"
              style={{ background: floatBg, borderColor: `${fg}33` }}
            />
            {(
              [
                ["auto", "Auto-Push（默认）：生成 → 3s 倒计时 → 自动提交推送"],
                ["dry", "Dry Run：只生成并停在预览，不自动执行"],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                onClick={() => switchMode(m)}
                className="flex w-full items-start gap-1.5 rounded-md px-1.5 py-1 text-left leading-snug whitespace-normal"
                style={{
                  color: mode === m ? fg : dim,
                  // CSS 化 radio：选中 = 微绿浅框 + 实心点，未选中 = 浅底 + 空点
                  background: mode === m ? `${colors.green}1a` : `${fg}08`,
                  border: `1px solid ${mode === m ? `${colors.green}55` : "transparent"}`,
                }}
              >
                <span
                  className="mt-0.5 inline-block size-2 shrink-0 rounded-full"
                  style={{ background: mode === m ? colors.green : `${fg}33` }}
                />
                {label}
              </button>
            ))}
            <div
              className="mt-1.5 border-t pt-1.5"
              style={{ borderColor: `${fg}1a` }}
            >
              <div className="mb-1" style={{ color: faint }}>
                提交信息风格偏好（留空 = 默认）
              </div>
              <input
                autoFocus
                value={stylePref}
                onChange={(e) => saveStyle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setSplitOpen(false); // Enter 保存并收起
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setSplitOpen(false);
                  }
                }}
                placeholder="如：全英文，带 emoji"
                className="w-full rounded-sm border bg-transparent px-1.5 py-1 font-mono text-micro outline-none"
                style={{ borderColor: `${fg}33`, color: fg }}
              />
            </div>
          </div>
        </>
      )}
      {/* review 气泡：预览确认（倒计时 + Esc 取消 + Enter 立即执行 + ✎ 改信息） */}
      {phase === "review" && (
        <div
          className="absolute bottom-full z-50 mb-2 w-84 overflow-hidden rounded-md border p-3 pb-4 font-mono text-micro"
          style={{
            background: floatBg,
            borderColor: `${fg}33`,
            left: 0,
            boxShadow: `0 4px 16px rgba(0,0,0,0.35), 0 0 8px ${colors.yellow}22`,
          }}
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
        >
          <div className="mb-1.5 flex items-center justify-between">
            <span style={{ color: colors.yellow }}>
              {mode === "dry" ? "预览（Dry Run · 不自动执行）" : "预览确认"}
            </span>
            {!editing && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                title="修改提交信息"
                className="cursor-pointer border-0 bg-transparent p-0 font-mono"
                style={{ color: colors.blue }}
              >
                ✎ 修改
              </button>
            )}
          </div>
          {editing ? (
            <input
              autoFocus
              value={editMsg}
              onChange={(e) => setEditMsg(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setEditing(false);
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setEditing(false);
                  setEditMsg(msg);
                }
              }}
              className="mb-1.5 w-full rounded-sm border bg-transparent px-1.5 py-1 outline-none"
              style={{ borderColor: colors.blue, color: fg }}
            />
          ) : (
            <div className="mb-1.5 whitespace-pre-wrap" style={{ color: fg }}>
              {editMsg}
            </div>
          )}
          <div className="mb-2" style={{ color: faint }}>
            {snapRef.current.files} files modified, +{snapRef.current.add} -
            {snapRef.current.del}
          </div>
          {mode === "auto" && (
            /* 绿色消融条贴气泡底缘（2px）：hover 暂停时定格 */
            <div
              className="absolute inset-x-0 bottom-0 h-[2px]"
              style={{ background: `${fg}1a` }}
              title={paused ? "已暂停（鼠标在气泡上）" : "倒计时结束自动提交推送"}
            >
              <div
                className="h-full"
                style={{
                  width: `${countPct}%`,
                  background: paused ? faint : colors.green,
                }}
              />
            </div>
          )}
          <div className="flex items-center gap-2" style={{ color: faint }}>
            <span
              className="rounded-sm border px-1.5 py-0.5"
              style={{ borderColor: `${fg}33`, color: colors.green }}
            >
              [Enter] Push Now
            </span>
            <span
              className="rounded-sm border px-1.5 py-0.5"
              style={{ borderColor: `${fg}33` }}
            >
              [Esc] Cancel
            </span>
          </div>
        </div>
      )}
        </span>
      )}
      {!idle && mergeReady.length > 0 && (
        <span
          style={{ color: colors.green }}
          title={`可合并的工作区：${mergeReady.join("、")}（从「改动」页签进入评审合并）`}
        >
          ● {mergeReady.length > 1 ? `${mergeReady.length} 个可合并` : "可合并"}
        </span>
      )}

      {/* 右区：时长 · token（等宽小字） */}
      <span
        className="ml-auto flex min-w-0 items-center gap-3 overflow-hidden font-mono"
        style={{ color: faint }}
      >
        {/* 时长只在 agent 运行中显示：退出回落 shell 后 alive 仍为 true，
            定格的旧时长挂在底栏会误导（远看像还在计时） */}
        {startedAt != null && running && (
          <span title="本次启动的运行时长">{fmtDuration(now - startedAt)}</span>
        )}
        {usage && (usage.input > 0 || usage.output > 0) && (
          <span title="本会话累计 token（随索引节奏更新，约 1 分钟粒度）">
            {fmtTokens(usage.input)}↑ {fmtTokens(usage.output)}↓
            {usage.priced && ` · $${usage.costUsd.toFixed(3)}`}
          </span>
        )}
      </span>


      </div>

      {/* 错误 Toast：红色，4s 自动消失 / 点击关闭 */}
      {errToast && (
        <button
          type="button"
          onClick={() => setErrToast(null)}
          className="absolute right-2 bottom-full z-50 mb-1 block max-w-md cursor-pointer rounded-md border px-3 py-2 text-left font-mono text-micro"
          style={{
            background: floatBg,
            borderColor: `${colors.red}66`,
            color: fg,
            boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
          }}
        >
          <span style={{ color: colors.red }}>✕ </span>
          <span style={{ color: dim }}>{errToast}</span>
        </button>
      )}
    </div>
  );
}
