import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Copy, RefreshCw, ScrollText, SquareTerminal, X } from "lucide-react";
import { stripAnsiLog } from "../tab-surface";
import { toast } from "../toast";

/**
 * 纯协议原生运行时（ACP / Claude -p 双向 stream-json）的纯文本「运行日志」抽屉。
 * 读取后端 64 KB UTF-8 环形缓冲（pty_native_log），彻底替代原先切到黑屏 xterm 终端页的做法。
 */
export default function NativeLogDrawer({
  open,
  ptyId,
  title,
  running,
  onClose,
  onOpenInTerminalMode,
}: {
  open: boolean;
  ptyId: string | null;
  title: string;
  running: boolean;
  onClose: () => void;
  /** 可选：「改用终端模式打开」（空闲停进程按会话接回） */
  onOpenInTerminalMode?: () => void;
}) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLPreElement>(null);
  const pinnedBottomRef = useRef(true);

  const loadLog = useCallback(async () => {
    if (!ptyId) {
      setText("");
      return;
    }
    setLoading(true);
    try {
      const raw = await invoke<string>("pty_native_log", { ptyId });
      setText(stripAnsiLog(raw ?? ""));
    } catch {
      setText("");
    } finally {
      setLoading(false);
    }
  }, [ptyId]);

  useEffect(() => {
    if (!open) return;
    pinnedBottomRef.current = true;
    void loadLog();
    if (!running || !ptyId) return;
    const timer = window.setInterval(() => {
      void loadLog();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [open, ptyId, running, loadLog]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!open || !el || !pinnedBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [open, text]);

  if (!open) return null;

  async function copyLog() {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast("复制失败", "error");
    }
  }

  return (
    <div
      role="dialog"
      aria-label="协议运行日志"
      className="absolute inset-0 z-30 flex justify-end bg-black/20"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex h-full w-full max-w-xl flex-col border-l border-hairline bg-canvas shadow-lg">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hairline bg-strip px-3">
          <ScrollText size={14} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-l3" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-l1">
            运行日志 · {title}
          </span>
          {onOpenInTerminalMode && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenInTerminalMode();
              }}
              className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-field bg-inset px-2 text-xs text-l2 hover:bg-hover hover:text-l1"
              title="空闲时停下当前协议进程，按这段对话接回成终端模式"
            >
              <SquareTerminal size={12} strokeWidth={1.8} aria-hidden="true" className="text-l3" />
              改用终端模式打开
            </button>
          )}
          <button
            type="button"
            onClick={() => void loadLog()}
            disabled={!ptyId || loading}
            title="刷新运行日志"
            aria-label="刷新运行日志"
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1 disabled:opacity-40"
          >
            <RefreshCw size={13} strokeWidth={1.8} className={loading ? "animate-spin" : undefined} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => void copyLog()}
            disabled={!text}
            title="复制日志"
            aria-label="复制日志"
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1 disabled:opacity-40"
          >
            {copied ? (
              <Check size={13} strokeWidth={1.8} className="text-ok-text" aria-hidden="true" />
            ) : (
              <Copy size={13} strokeWidth={1.8} aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            title="关闭（Esc）"
            aria-label="关闭运行日志"
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1"
          >
            <X size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
        <div className="flex shrink-0 items-center justify-between border-b border-hairline bg-canvas px-3 py-1.5 text-micro text-l4">
          <span>对话、审批与提问均在聊天中进行；此处仅显示最近 64 KB 协议桥运行日志（纯文本）。</span>
        </div>
        <pre
          ref={bodyRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinnedBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 28;
          }}
          className="min-h-0 flex-1 select-text overflow-auto whitespace-pre-wrap break-words bg-inset px-3.5 py-3 font-mono text-xs leading-5 text-l2"
        >
          {text.trim()
            ? text
            : ptyId
              ? "暂无运行日志输出。"
              : "当前对话尚未启动协议进程，发出消息后会在这里显示运行日志。"}
        </pre>
      </div>
    </div>
  );
}
