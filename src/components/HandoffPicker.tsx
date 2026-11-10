import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { AGENTS } from "../types";
import type { HandoffBriefDto, HandoffTargetDto } from "../types";
import { InlineNotice } from "./PageFrame";
import { IS_WINDOWS } from "../hotkeys";
import { relativeUnder } from "../path-utils";

/** 接力来源会话（终端标签 / 对话页回放共用） */
export interface HandoffSource {
  agent: string;
  sessionId: string;
  filePath: string;
  cwd: string;
  title: string | null;
}

function agentLabel(id: string): string {
  return AGENTS.find((a) => a.id === id)?.label ?? id;
}

/**
 * 「◈ 接力到…」目标选择器（P3 机制四）：从当前会话生成结构化简报落成文件，
 * 新 Agent 带简报启动——是简报接力，不是记忆转移。
 * 已安装且支持启动注入的优先；目前仅 kimi 无交互注入参数，标注需手动发送。
 */
export default function HandoffPicker({
  source,
  onClose,
}: {
  source: HandoffSource;
  onClose: () => void;
}) {
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setPage = useAppStore((s) => s.setPage);
  const profiles = useAppStore((s) => s.profiles);
  const [targets, setTargets] = useState<HandoffTargetDto[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<HandoffTargetDto[]>("handoff_targets")
      .then(setTargets)
      .catch((e) => setError(String(e)));
  }, []);

  // Escape 关闭（同 ContextMenu 语义）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** 简报路径相对项目目录（默认落 cwd/.ccode/ 下），指令里用相对路径 */
  function relPath(filePath: string): string {
    return relativeUnder(filePath, source.cwd, IS_WINDOWS);
  }

  /** 开新终端标签预填启动（同 cwd、目标 agent、接力指令为首条 prompt） */
  function goTerminal(target: HandoffTargetDto, prompt: string) {
    const profileId =
      localStorage.getItem(`ccode.lastProfile.${target.id}`) ??
      profiles.find((p) => p.agent === target.id)?.id;
    setPendingTerminal({
      cwd: source.cwd,
      extraEnv: {},
      title: `接力 → ${agentLabel(target.id)}`,
      agentId: target.id,
      profileId,
      initialPrompt: prompt,
    });
    setPage("terminal");
    onClose();
  }

  async function pick(t: HandoffTargetDto) {
    setBusy(t.id);
    setError(null);
    try {
      // 换一家：relay_prepare 写交接简报并按简报文件名记接力关系；同一家另开照旧（不算接力）
      let prompt: string;
      if (t.id !== source.agent) {
        const prepared = await invoke<{ framing: string | null }>("relay_prepare", {
          source: {
            agent: source.agent,
            sessionId: source.sessionId,
            filePath: source.filePath,
            cwd: source.cwd,
            title: source.title,
          },
          targetAgent: t.id,
          resumeSession: null,
          withWords: false,
        });
        if (!prepared.framing) throw new Error("没能写出交接简报");
        prompt = prepared.framing;
      } else {
        const brief = await invoke<HandoffBriefDto>("build_handoff_brief", {
          agent: source.agent,
          sessionId: source.sessionId,
          filePath: source.filePath,
          cwd: source.cwd,
          title: source.title,
          targetPath: null,
        });
        await invoke("mark_handoff", {
          targetAgent: t.id,
          targetCwd: source.cwd,
          fromAgent: source.agent,
          fromSessionId: source.sessionId,
        });
        prompt = `读 ${relPath(brief.filePath)} 接力简报，按这份简报接着做`;
      }
      // 没有启动注入参数的（Kimi）由终端等输入框就绪后自动写进去，不再停在这里让人复制
      goTerminal(t, prompt);
    } catch (e) {
      setError(String(e));
      setBusy(null);
    }
  }

  // 排序：已安装优先 → 未安装（禁用）；同组保持 AGENTS 声明顺序
  const sorted = (targets ?? [])
    .slice()
    .sort(
      (a, b) =>
        Number(b.installed) - Number(a.installed) ||
        AGENTS.findIndex((x) => x.id === a.id) -
          AGENTS.findIndex((x) => x.id === b.id),
    );

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div
        className="absolute top-1/4 left-1/2 w-80 -translate-x-1/2 rounded-sm border border-field ccode-float-surface py-2 text-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 pb-2">
          <p className="font-medium text-l1">◈ 接力到…</p>
          <p className="mt-1 text-xs text-l4">
            选中后才生成交接简报。要 AI 先提炼结论，用「提炼接力」。
          </p>
        </div>
        {error && <InlineNotice tone="err" className="px-3 pb-1">{error}</InlineNotice>}
        <div className="pb-1">
          {targets === null && !error && (
            <p className="px-3 py-1 text-xs text-l4">检测目标 Agent…</p>
          )}
          {sorted.map((t) => (
            <button
              key={t.id}
              disabled={!t.installed || busy !== null}
              title={
                !t.installed
                  ? "未安装"
                  : "启动后自动发送接力指令"
              }
              onClick={() => void pick(t)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-l2 hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="min-w-0 flex-1 truncate">
                {busy === t.id ? "生成简报…" : agentLabel(t.id)}
              </span>
              {!t.installed && (
                <span className="shrink-0 text-xs text-l4">未安装</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
