/**
 * 依赖一键安装的共享管线（设置页诊断区 / GitPanel / 连接页共用，照设置页 installFont 模式）：
 * 先挂 agent-update-output-dep-<tool> / agent-update-done-dep-<tool> 两事件再 invoke，
 * 结果以 done 事件为准、invoke 返回值兜底；Err（invoke reject）不发 done，直接落失败结果。
 */
import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DepTool, UpdateResultDto } from "./dep-check";
import { isGitMissingError } from "./dep-check";
import { useAppStore } from "./store";
import { toast } from "./toast";
import { collapseCarriageReturns } from "./stream-text";

export interface DepInstallEntry {
  running: boolean;
  output: string;
  result: UpdateResultDto | null;
}

const IDLE: DepInstallEntry = { running: false, output: "", result: null };

export function useDepInstall(
  onDone?: (tool: DepTool, res: UpdateResultDto) => void,
) {
  const [entries, setEntries] = useState<Record<DepTool, DepInstallEntry>>({
    git: IDLE,
    node: IDLE,
    quarto: IDLE,
    tex: IDLE,
    pymupdf: IDLE,
    pillow: IDLE,
  });
  // onDone 走 ref：调用方回调常捕获组件态，不为它重建 install
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const patch = useCallback((tool: DepTool, part: Partial<DepInstallEntry>) => {
    setEntries((prev) => ({ ...prev, [tool]: { ...prev[tool], ...part } }));
  }, []);

  // 进行中禁重复点击（ref 判定在 invoke 之前，不靠渲染态）
  const runningRef = useRef<Set<DepTool>>(new Set());
  const install = useCallback(
    async (tool: DepTool) => {
      if (runningRef.current.has(tool)) return;
      runningRef.current.add(tool);
      patch(tool, { running: true, output: "", result: null });
      const unOut = await listen<string>(
        `agent-update-output-dep-${tool}`,
        (e) =>
          setEntries((prev) => ({
            ...prev,
            [tool]: { ...prev[tool], output: prev[tool].output + e.payload },
          })),
      );
      let doneArrived = false;
      const unDone = await listen<UpdateResultDto>(
        `agent-update-done-dep-${tool}`,
        (e) => {
          doneArrived = true;
          patch(tool, { result: e.payload });
          onDoneRef.current?.(tool, e.payload);
        },
      );
      try {
        const res = await invoke<UpdateResultDto>("install_dependency", {
          tool,
        });
        if (!doneArrived) {
          patch(tool, { result: res });
          onDoneRef.current?.(tool, res);
        }
      } catch (e) {
        // Err 分支（无渠道/未知 tool）后端不发 done：直接落失败结果
        if (!doneArrived)
          patch(tool, {
            result: {
              ok: false,
              output: String(e),
              method: "",
              versionBefore: null,
              versionAfter: null,
            },
          });
      } finally {
        unOut();
        unDone();
        runningRef.current.delete(tool);
        patch(tool, { running: false });
      }
    },
    [patch],
  );

  return { entries, install };
}

/** 安装进行/结果的共用展示块（流式输出 + ✓/✗ 结果尾），样式对齐设置页字体安装 */
export function DepInstallLog({ entry }: { entry: DepInstallEntry }) {
  if (!entry.running && !entry.result) return null;
  return (
    <div className="mt-2">
      {entry.running && (
        <pre
          // callback ref：每次渲染都把滚动条钉在底部，跟随输出自动滚动
          ref={(el) => {
            if (el) el.scrollTop = el.scrollHeight;
          }}
          className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-inset p-2 font-mono text-xs text-l3"
        >
          {collapseCarriageReturns(entry.output) || "安装中，等待输出…"}
        </pre>
      )}
      {!entry.running && entry.result && (
        <div className="rounded-sm bg-strip p-2 text-xs text-l2">
          <span className={entry.result.ok ? "text-ok-text" : "text-err-text"}>
            {entry.result.ok ? "✓ 安装完成" : "✗ 安装失败"}
          </span>
          {entry.result.versionAfter && (
            <span className="ml-2 text-l4">{entry.result.versionAfter}</span>
          )}
          {/* 后端只回传尾部 ~30 行，直接展示不折叠 */}
          {entry.result.output && (
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-l3">
              {entry.result.output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** 「用到时再装」的 Git 出口：错误是「找不到 git 可执行文件」时，就地给一键安装 + 安装日志。
 *  改动面板、科研步骤「历史」浮层、开步失败的项目页报错共用，免得普通用户被一句
 *  「请先安装 git」打发去设置页找入口。装好后刷新依赖体检并交给调用方重试 */
export function GitInstallOffer({
  error,
  onInstalled,
  retryHint = "Git 装好了，可以继续了",
}: {
  error: string | null | undefined;
  onInstalled?: () => void;
  retryHint?: string;
}) {
  const refreshDepCheck = useAppStore((s) => s.refreshDepCheck);
  const depInstall = useDepInstall((_tool, res) => {
    if (!res.ok) return;
    // Mac 无 Homebrew 时只是弹出系统安装窗口（Xcode 命令行工具），此刻还没装好
    if (res.method === "xcode") {
      toast("已打开系统安装窗口，装完后再试一次", "info");
      return;
    }
    void refreshDepCheck();
    toast(retryHint, "success");
    onInstalled?.();
  });
  if (!error || !isGitMissingError(error)) return null;
  const entry = depInstall.entries.git;
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => void depInstall.install("git")}
        disabled={entry.running}
        className="rounded-sm bg-strip px-2 py-1 text-xs text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
      >
        {entry.running ? "安装中…" : "一键安装 Git"}
      </button>
      <DepInstallLog entry={entry} />
    </div>
  );
}
