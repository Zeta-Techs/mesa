import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { AGENTS } from "../types";
import type { HandoffBriefDto, HandoffTargetDto } from "../types";
import type { HandoffSource } from "./HandoffPicker";
import { relativeUnder } from "../path-utils";
import { IS_WINDOWS } from "../hotkeys";
import { hoverRevealClass } from "./PageFrame";

function agentLabel(id: string): string {
  return AGENTS.find((a) => a.id === id)?.label ?? id;
}

/**
 * 「◈ 提炼接力…」目标选择器：AI 把全会话蒸馏成紧凑的结构化简报，
 * 新会话只读简报续作（不带旧上下文，非完整记忆）。单页流程：
 * brief ready 后同页显示「AI 初稿编辑框（可改）+ 发送目标列表」——
 * 点目标发送/暂不发送前比对编辑框与初稿原文，有改动先 finalize_digest_brief
 * 写回 handoff-*.md 再继续，零改动直接用；任务书沉淀统一走草稿（append_step_draft），
 * 本弹窗不再落 brief-*.md 钉卡。
 * 三路径消费：内部同 Agent 新会话 / 内部其他 Agent / 外部（⧉ 复制命令、⇗ 外部终端）。
 * 骨架与 HandoffPicker 一致；目前仅 kimi 无启动注入参数，走手动发送停留态。
 * 生成走 store.digestJob 后台任务（v3.60）：关闭本弹窗不中断、重开复用结果不重复提炼；
 * ready 未消费时收件箱挂「待发送」条目。
 */
export default function DigestPicker({
  source,
  onClose,
}: {
  source: HandoffSource;
  onClose: () => void;
}) {
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setPage = useAppStore((s) => s.setPage);
  const profiles = useAppStore((s) => s.profiles);
  const digestJob = useAppStore((s) => s.digestJob);
  const startDigestJob = useAppStore((s) => s.startDigestJob);
  const consumeDigestJob = useAppStore((s) => s.consumeDigestJob);
  const [targets, setTargets] = useState<HandoffTargetDto[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  // AI 初稿全文（可编辑）；draft 原文用于比对是否有改动，写回后同步推进
  const [draft, setDraft] = useState<string | null>(null);
  const [draftOrigin, setDraftOrigin] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // 确实写回过 handoff 文件后显示「✓ 已写回 →」状态行
  const [writtenBack, setWrittenBack] = useState(false);
  // 外部命令/指令的已复制反馈（按目标 agent 区分）
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // kimi 无启动注入：简报就绪后停留展示手动发送提示
  const [ready, setReady] = useState<{
    target: HandoffTargetDto;
    prompt: string;
  } | null>(null);

  // 依赖原始字段而非 source 对象：调用方在 JSX 里内联构造 source，
  // 父级任何重渲染都会换新对象身份，若按对象依赖会反复重新提炼
  const { agent, sessionId, filePath, cwd, title } = source;
  // 本弹窗对应的任务：同会话复用（含 picker 关闭期间在后台跑完的结果）
  const job =
    digestJob &&
    digestJob.agent === agent &&
    digestJob.sessionId === sessionId &&
    digestJob.filePath === filePath
      ? digestJob
      : null;
  const generating = job?.status !== "ready" && job?.status !== "error";
  const brief = job?.status === "ready" ? (job.brief ?? null) : null;
  const error = localError ?? (job?.status === "error" ? (job.error ?? null) : null);

  useEffect(() => {
    startDigestJob({ agent, sessionId, filePath, cwd, title });
    invoke<HandoffTargetDto[]>("handoff_targets")
      .then(setTargets)
      .catch((e) => setLocalError(String(e)));
  }, [agent, sessionId, filePath, cwd, title, startDigestJob]);

  // 编辑框底本：读 AI 初稿全文进编辑框（原文另存 draftOrigin，供发送前比对改动）
  const draftPath = brief ? brief.filePath : null;
  useEffect(() => {
    if (!draftPath) return;
    let stale = false;
    invoke<{ text: string; truncated: boolean }>("read_file_preview", {
      path: draftPath,
      root: cwd,
    })
      .then((p) => {
        if (!stale) {
          setDraft(p.text);
          setDraftOrigin(p.text);
        }
      })
      .catch((e) => {
        if (!stale) setLocalError(String(e));
      });
    return () => {
      stale = true;
    };
  }, [draftPath, cwd]);

  /** 编辑框内容相对 AI 初稿原文有改动：finalize_digest_brief 写回 handoff-*.md
   *  （.ccode 内 + handoff- 前缀校验、脱敏截断、原子覆盖都在后端），零改动直接跳过 */
  async function writeBackIfChanged(): Promise<void> {
    if (!brief || draft === null || draft === draftOrigin) return;
    await invoke("finalize_digest_brief", {
      path: brief.filePath,
      content: draft,
    });
    // 写回成功后原文基线推进到当前内容，避免同一会话内重复写
    setDraftOrigin(draft);
    setWrittenBack(true);
  }

  /** 遮罩点击/Esc 关闭：有改动先写回（与「暂不发送」同一写回口径），但不摘除收件箱条目 */
  async function closeKeepingJob() {
    if (saving) return;
    setSaving(true);
    setLocalError(null);
    try {
      await writeBackIfChanged();
      onClose();
    } catch (e) {
      setLocalError(String(e));
    } finally {
      setSaving(false);
    }
  }
  // Esc 监听是挂载期闭包，经 ref 调最新的 closeKeepingJob（避免拿到旧 draft）
  const closeKeepingJobRef = useRef(closeKeepingJob);
  closeKeepingJobRef.current = closeKeepingJob;

  // Escape 关闭（同 HandoffPicker 语义）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void closeKeepingJobRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** 简报路径相对项目目录（默认落 cwd/.ccode/ 下），指令里用相对路径 */
  function relPath(filePath: string): string {
    return relativeUnder(filePath, source.cwd, IS_WINDOWS);
  }

  function promptFor(b: HandoffBriefDto): string {
    return `读 ${relPath(b.filePath)} 接力简报，按这份简报接着做`;
  }

  function targetProfile(target: HandoffTargetDto) {
    const remembered = localStorage.getItem(`ccode.lastProfile.${target.id}`);
    return (
      profiles.find((p) => p.agent === target.id && p.id === remembered) ??
      profiles.find((p) => p.agent === target.id) ??
      null
    );
  }

  function targetModel(target: HandoffTargetDto, profileId: string) {
    try {
      const last = JSON.parse(localStorage.getItem("ccode.lastLaunch") ?? "null") as
        | { agentId?: string; profileId?: string; model?: string }
        | null;
      if (
        last?.agentId === target.id &&
        last.profileId === profileId &&
        last.model?.trim()
      )
        return last.model.trim();
    } catch {
      /* 损坏的本地记忆不阻断外部接力 */
    }
    return profiles.find((p) => p.id === profileId)?.models[0] ?? null;
  }

  /** 开新终端标签预填启动（同 cwd、目标 agent、读简报指令为首条 prompt） */
  function goTerminal(target: HandoffTargetDto, prompt: string) {
    const profileId =
      localStorage.getItem(`ccode.lastProfile.${target.id}`) ??
      profiles.find((p) => p.agent === target.id)?.id;
    setPendingTerminal({
      cwd: source.cwd,
      extraEnv: {},
      title: `提炼接力 → ${agentLabel(target.id)}`,
      agentId: target.id,
      profileId,
      initialPrompt: prompt,
    });
    setPage("terminal");
    onClose();
  }

  /** 内部启动：有改动先把编辑框内容写回简报文件，登记接力链（⇄ 接自 badge 沿用）后按注入能力分流 */
  async function pick(t: HandoffTargetDto) {
    if (!brief) return;
    setBusy(t.id);
    setLocalError(null);
    try {
      await writeBackIfChanged();
      await invoke("mark_handoff", {
        targetAgent: t.id,
        targetCwd: source.cwd,
        fromAgent: source.agent,
        fromSessionId: source.sessionId,
      });
      const prompt = promptFor(brief);
      // 已选定发送目标：简报任务标记已消费，收件箱「待发送」摘除
      consumeDigestJob();
      if (t.promptSupported) {
        goTerminal(t, prompt);
      } else {
        // 无交互注入参数（目前仅 kimi）：复制指令文本，停留展示提示，由用户确认后前往
        await navigator.clipboard.writeText(prompt).catch(() => {});
        setReady({ target: t, prompt });
        setBusy(null);
      }
    } catch (e) {
      setLocalError(String(e));
      setBusy(null);
    }
  }

  /** ⧉ 复制外部续作命令；Unsupported 目标复制指令文本（启动后手动粘贴）。
      外部读的也是简报文件，发送前同样先写回改动 */
  async function copyExternal(t: HandoffTargetDto) {
    if (!brief) return;
    try {
      await writeBackIfChanged();
      const prompt = promptFor(brief);
      const text = t.promptSupported
        ? await invoke<string>("session_digest_command", {
            agentId: t.id,
            cwd: source.cwd,
            prompt,
          })
        : prompt;
      await navigator.clipboard.writeText(text);
      setCopiedId(t.id);
      window.setTimeout(() => setCopiedId(null), 1500);
    } catch (e) {
      setLocalError(String(e));
    }
  }

  /** ⇗ 在外部终端以「读简报续作」开新会话（仅支持注入的目标） */
  async function openExternal(t: HandoffTargetDto) {
    if (!brief) return;
    try {
      await writeBackIfChanged();
      const profile = targetProfile(t);
      if (!profile) {
        setLocalError(`${agentLabel(t.id)} 没有可用的 Mesa 配置`);
        return;
      }
      await invoke("digest_external_terminal", {
        agentId: t.id,
        cwd: source.cwd,
        prompt: promptFor(brief),
        profileId: profile.id,
        model: targetModel(t, profile.id),
      });
    } catch (e) {
      setLocalError(String(e));
    }
  }

  /** 暂不发送：有改动先写回简报文件再关；零改动直接摘除收件箱条目并关闭 */
  async function dismiss() {
    if (saving) return;
    setSaving(true);
    setLocalError(null);
    try {
      await writeBackIfChanged();
      consumeDigestJob();
      onClose();
    } catch (e) {
      setLocalError(String(e));
    } finally {
      setSaving(false);
    }
  }

  // 排序：来源 agent 置顶（同 Agent 新会话），其余按 已安装+支持注入 → 已安装需手动 → 未安装
  const sorted = (targets ?? [])
    .slice()
    .sort(
      (a, b) =>
        Number(b.id === source.agent) - Number(a.id === source.agent) ||
        Number(b.installed) - Number(a.installed) ||
        Number(b.promptSupported) - Number(a.promptSupported) ||
        AGENTS.findIndex((x) => x.id === a.id) -
          AGENTS.findIndex((x) => x.id === b.id),
    );

  return (
    <div className="fixed inset-0 z-50" onClick={() => void closeKeepingJob()}>
      <div
        className={`absolute top-[12%] left-1/2 -translate-x-1/2 rounded-sm border border-field ccode-float-surface py-2 text-sm ${
          brief ? "w-[36rem]" : "w-96"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 pb-2">
          <p className="font-medium text-l1">◈ 提炼接力…</p>
          <p className="mt-1 text-xs text-l4">
            AI 把全会话提炼成紧凑简报（非完整记忆），新会话读简报续作，不带旧上下文。
          </p>
          <p className="mt-1.5 text-xs">
            {generating ? (
              <span className="text-l4">
                ⏳ 正在后台提炼会话…可关闭本窗口，完成后在「待你处理」出现
              </span>
            ) : writtenBack && brief ? (
              <span className="text-ok-text">
                ✓ 已写回 → {relPath(brief.filePath)}
              </span>
            ) : null}
          </p>
        </div>
        {error && (
          <div className="px-3 pb-1">
            <p className="text-xs text-err-text">{error}</p>
            {!generating && !brief && (
              <button
                className="mt-1 rounded-sm px-2 py-0.5 text-xs text-l3 hover:bg-hover hover:text-l1"
                onClick={() =>
                  startDigestJob({ agent, sessionId, filePath, cwd, title }, true)
                }
              >
                重试
              </button>
            )}
          </div>
        )}
        {/* 单页：AI 初稿进编辑框可直接改；发送或「暂不发送」前有改动才写回简报文件 */}
        {brief && (
          <div className="px-3 pb-2">
            <p className="pb-1.5 text-xs text-l4">
              AI 初稿，可直接改；有改动会在发送/关闭前写回简报文件
            </p>
            <textarea
              className="h-72 w-full resize-none rounded-md border border-field bg-inset px-2 py-1.5 text-sm leading-relaxed text-l2 outline-none placeholder:text-l4 focus:border-l4"
              value={draft ?? ""}
              disabled={draft === null || saving || busy !== null}
              placeholder={draft === null ? "读取初稿中…" : ""}
              onChange={(e) => setDraft(e.target.value)}
            />
            {!ready && (
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  disabled={saving || busy !== null}
                  onClick={() => void dismiss()}
                  title="不发送；有改动会先写回简报文件，收件箱「待发送」摘除"
                  className="rounded-sm px-2.5 py-1 text-xs text-l3 hover:bg-hover hover:text-l1 disabled:opacity-50"
                >
                  {saving ? "写回中…" : "暂不发送"}
                </button>
              </div>
            )}
          </div>
        )}
        {/* 发送目标：brief ready 即显示，一律发送简报文件本身（有改动发送前已写回） */}
        {brief &&
          (ready ? (
          <div className="px-3 pb-1">
            <p className="text-xs text-warn-text">
              {agentLabel(ready.target.id)}{" "}
              不支持启动注入：简报指令已复制，启动后请手动发送（终端启动栏会保留该指令文本）。
            </p>
            <div className="mt-2 flex gap-2">
              <button
                className="rounded-sm border border-cta-bd bg-cta px-2.5 py-1 text-xs text-cta-text hover:brightness-110"
                onClick={() => goTerminal(ready.target, ready.prompt)}
              >
                前往终端启动
              </button>
              <button
                className="rounded-sm px-2.5 py-1 text-xs text-l3 hover:bg-hover hover:text-l1"
                onClick={onClose}
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <div className="pb-1">
            {targets === null && !error && (
              <p className="px-3 py-1 text-xs text-l4">检测目标 Agent…</p>
            )}
            {sorted.map((t) => (
              <div
                key={t.id}
                role="button"
                tabIndex={0}
                aria-disabled={!t.installed || busy !== null}
                onClick={() => {
                  if (t.installed && busy === null) void pick(t);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && t.installed && busy === null)
                    void pick(t);
                }}
                className="group flex w-full items-center gap-2 px-3 py-1.5 text-left text-l2 hover:bg-hover aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              >
                <span className="min-w-0 flex-1 truncate">
                  {busy === t.id ? "登记接力…" : agentLabel(t.id)}
                  {t.id === source.agent && (
                    <span className="ml-1.5 text-xs text-l4">
                      同 Agent · 新会话
                    </span>
                  )}
                </span>
                {!t.installed && (
                  <span className="shrink-0 text-xs text-l4">未安装</span>
                )}
                {t.installed && !t.promptSupported && (
                  <span className="shrink-0 text-xs text-l4">需手动发送</span>
                )}
                {t.installed && (
                  <span className={`flex shrink-0 items-center gap-1 ${hoverRevealClass} focus-within:opacity-100`}>
                    <button
                      className="rounded-sm px-1 py-0.5 text-xs text-l4 hover:bg-white/10 hover:text-l1"
                      title={
                        t.promptSupported
                          ? IS_WINDOWS
                            ? "复制 PowerShell 续作命令（粘贴到 PowerShell，不要粘到 cmd；新会话读简报，非恢复旧会话）"
                            : "复制外部终端续作命令（新会话读简报，非恢复旧会话）"
                          : "该 CLI 无启动注入参数：复制简报指令，外部启动后手动粘贴"
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        void copyExternal(t);
                      }}
                    >
                      {copiedId === t.id
                        ? IS_WINDOWS && t.promptSupported
                          ? "✓ 已复制（PowerShell）"
                          : "✓ 已复制"
                        : "⧉"}
                    </button>
                    {t.promptSupported && (
                      <button
                        className="rounded-sm px-1 py-0.5 text-xs text-l4 hover:bg-white/10 hover:text-l1"
                        title="在外部终端以「读简报续作」开新会话"
                        onClick={(e) => {
                          e.stopPropagation();
                          void openExternal(t);
                        }}
                      >
                        ⇗
                      </button>
                    )}
                  </span>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
