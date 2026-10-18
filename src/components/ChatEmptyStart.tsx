import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { AGENTS, type ProjectDto, type SessionMetaDto } from "../types";
import { IS_WINDOWS } from "../hotkeys";
import { resolveChatCwd, STARTER_PROMPTS, starterContextFor } from "../chat-empty-start";
import { isScratchCwd, pickQuickChatHistory, sessionDisplayTitle } from "../quick-chat";
import { agentBrand } from "../agent-colors";
import { relTime } from "../rel-time";

/**
 * 聊天空态里输入框下方的那一组（纯逻辑在 chat-empty-start.ts）：一排起手提示；
 * 恢复占位标签再加一行「上次的对话还没接回」。
 * 2026-10-17 五轮收敛（用户：输入框下面的噪声信息可以不要）：「N 段对话 · 接着上一段」也拿掉——
 * 找旧对话是工作台 / 对话页的事；这里只留「这一段怎么开始」和「这个标签自己的状态」。
 * 2026-10-18 例外（用户拍板快速开聊改成直达空白对话、弹层去掉）：文件夹是「随手聊」时列最近 5 条随手聊，
 * 原弹层下半「继续上次」挪到这里；换成项目文件夹就不列（项目的旧对话在项目页 / 对话页）。
 */
const RECENT_LIMIT = 5;
export default function ChatEmptyStart({
  cwd,
  homeDir,
  onPickPrompt,
  resumeSessionId = null,
  onRestore,
  onShowScreen,
  onPickRecent,
}: {
  cwd: string | null | undefined;
  homeDir: string;
  onPickPrompt: (text: string) => void;
  /** 恢复占位标签：上次的会话还没接回 */
  resumeSessionId?: string | null;
  onRestore?: () => void;
  /** 看上次离开时的画面（切到终端层的回放） */
  onShowScreen?: () => void;
  /** 点最近一条随手聊：接着聊它（不给就不列） */
  onPickRecent?: (s: SessionMetaDto) => void;
}) {
  const projectsVersion = useAppStore((s) => s.projectsVersion);
  const [projects, setProjects] = useState<ProjectDto[]>([]);

  useEffect(() => {
    let cancelled = false;
    invoke<ProjectDto[]>("list_projects")
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      // 读不到项目表只是起手提示退回通用那一套，不打扰用户
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectsVersion]);

  const dir = resolveChatCwd(cwd, homeDir);
  const prompts = STARTER_PROMPTS[starterContextFor(dir, projects, IS_WINDOWS)];
  const sessions = useAppStore((s) => s.sessions);
  const projectPaths = useAppStore((s) => s.projectPaths);
  const liveSessions = useAppStore((s) => s.liveSessions);
  const showRecent = Boolean(onPickRecent) && !resumeSessionId && isScratchCwd(dir ?? "", IS_WINDOWS);
  const recent = useMemo(
    () =>
      showRecent
        ? pickQuickChatHistory(sessions ?? [], projectPaths ?? [], liveSessions ?? {}, IS_WINDOWS, RECENT_LIMIT)
        : [],
    [showRecent, sessions, projectPaths, liveSessions],
  );
  const link =
    "rounded-sm px-1 text-l3 underline decoration-dotted underline-offset-2 hover:text-l1";

  return (
    <div className="flex flex-col gap-3 px-1 pt-3">
      <div className="flex flex-wrap gap-2">
        {prompts.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => onPickPrompt(p.text)}
            title={`填进输入框：${p.text.trim()}`}
            className="rounded-full border border-hairline px-3 py-1.5 text-xs text-l3 transition-colors hover:border-field hover:bg-hover hover:text-l1"
          >
            {p.label}
          </button>
        ))}
      </div>
      {resumeSessionId && onRestore && (
        <p className="flex flex-wrap items-center gap-x-1 text-xs text-l4">
          <span>上次的对话还没接回</span>
          <span aria-hidden="true">·</span>
          <button type="button" onClick={onRestore} className={link}>
            接着聊
          </button>
          {onShowScreen && (
            <>
              <span aria-hidden="true">·</span>
              <button type="button" onClick={onShowScreen} className={link}>
                看离开时的画面
              </button>
            </>
          )}
        </p>
      )}
      {recent.length > 0 && onPickRecent && (
        <div className="mt-3">
          <div className="px-1 pb-1 text-micro text-l4">最近的随手聊</div>
          <ul>
            {recent.map((s) => {
              const agent = AGENTS.find((a) => a.id === s.agent)?.label ?? s.agent;
              return (
                <li key={`${s.agent}:${s.sessionId}`}>
                  <button
                    type="button"
                    onClick={() => onPickRecent(s)}
                    title={`${sessionDisplayTitle(s)}\n${agent}\n点按接着聊`}
                    className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-hover"
                  >
                    {/* 品牌点代替整枚 agent 胶囊：胶囊宽度随名字变，标题列对不齐 */}
                    <span
                      aria-hidden="true"
                      className="size-2 shrink-0 rounded-full"
                      style={{ background: agentBrand(s.agent) }}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-l2">{sessionDisplayTitle(s)}</span>
                    <span className="shrink-0 text-micro text-l4">
                      {agent} · {relTime(s.updatedAt)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
