import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RotateCw } from "lucide-react";
import {
  normalizeSessionInjectionMode,
  type SessionInjectionMode,
} from "../project-context";
import { loadProjectContextPack } from "../project-context-load";
import type { ProjectConfigReadDto } from "../types";
import {
  FoldMark,
  Toggle,
  ghostActionClass,
} from "./PageFrame";

/** 新对话附带项目背景（原「项目说明」三态模板，2026-11-16 简化为自动开关 + 全文预览）：
 *  在项目里开对话时附在第一句前面的背景说明（目录、课题主题/简介、项目规则、长期知识、已验收成果）。
 *  开启 = 自动按当前数据拼装（首行固定，聊天自动折成「已附项目说明」）；关闭 = 只发用户输入。
 *  开工任务书 / 验收写入 / 编程目标包不受这里控制。 */
export default function ProjectInjectionPanel({
  projectPath,
  projectName,
  workMode,
  compact = false,
  defaultOpen = false,
  onSaved,
  onError,
}: {
  projectPath: string;
  projectName: string;
  workMode?: string | null;
  compact?: boolean;
  defaultOpen?: boolean;
  onSaved?: () => void;
  onError?: (message: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [mode, setMode] = useState<SessionInjectionMode>("auto");
  const [templateDraft, setTemplateDraft] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewSeqRef = useRef(0);
  const touchedRef = useRef(false);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const lastEnqueuedRef = useRef<{ mode: SessionInjectionMode; template: string } | null>(null);

  const loadPreview = useCallback(
    async (nextMode: SessionInjectionMode, nextTemplate: string) => {
      const seq = ++previewSeqRef.current;
      setPreviewLoading(true);
      try {
        const value = await loadProjectContextPack({
          name: projectName,
          path: projectPath,
          workMode,
          kind: "session",
          sessionOverride: { mode: nextMode, template: nextTemplate },
        });
        if (seq !== previewSeqRef.current) return;
        setPreview(value);
        setError(null);
      } catch (reason) {
        if (seq !== previewSeqRef.current) return;
        setPreview(null);
        const message = `读取背景预览失败：${String(reason)}`;
        setError(message);
        onError?.(message);
      } finally {
        if (seq === previewSeqRef.current) setPreviewLoading(false);
      }
    },
    [onError, projectName, projectPath, workMode],
  );

  useEffect(() => {
    let stale = false;
    touchedRef.current = false;
    invoke<ProjectConfigReadDto>("read_project_config", { path: projectPath })
      .then((read) => {
        if (stale || touchedRef.current) return;
        setMode(normalizeSessionInjectionMode(read.config.sessionInjectionMode));
        setTemplateDraft(read.config.sessionInjectionTemplate ?? "");
      })
      .catch((reason) => {
        if (!stale) {
          const message = `读取项目背景设置失败：${String(reason)}`;
          setError(message);
          onError?.(message);
        }
      });
    return () => {
      stale = true;
    };
  }, [onError, projectPath]);

  useEffect(() => {
    if (!open || !previewOpen) return;
    void loadPreview(mode, templateDraft);
  }, [open, previewOpen, mode, templateDraft, loadPreview]);

  function save(nextMode: SessionInjectionMode, nextTemplate: string) {
    touchedRef.current = true;
    const attempt = { mode: nextMode, template: nextTemplate };
    lastEnqueuedRef.current = attempt;
    saveChainRef.current = saveChainRef.current
      .then(async () => {
        if (attempt !== lastEnqueuedRef.current) return;
        try {
          await invoke("project_set_session_injection", {
            path: projectPath,
            mode: nextMode,
            template: nextTemplate,
          });
          setError(null);
          setSaved(true);
          window.setTimeout(() => setSaved(false), 2000);
          onSaved?.();
        } catch (reason) {
          const message = `保存项目背景设置失败：${String(reason)}`;
          setError(message);
          onError?.(message);
        }
      })
      .catch(() => {});
  }

  const enabled = mode !== "off";
  const summaryLabel = !enabled ? "不附带" : mode === "custom" ? "开启（旧模板）" : "自动附带";

  function handleToggle(nextChecked: boolean) {
    const nextMode: SessionInjectionMode = nextChecked ? "auto" : "off";
    setMode(nextMode);
    setTemplateDraft("");
    save(nextMode, "");
  }

  return (
    <section className={`text-xs ${compact ? "" : "space-y-3"}`} aria-label="新对话附带项目背景">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-left"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <FoldMark open={open} />
        <span className="font-medium text-l3">新对话附带项目背景</span>
        <span className="min-w-0 flex-1 truncate text-micro text-l4">
          {summaryLabel}
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-2.5">
          <div className="flex items-start justify-between gap-3">
            <p className="min-w-0 flex-1 text-micro leading-5 text-l3">
              在项目里新建对话时，自动在首句前附带目录、主题、规则与长期知识；聊天里折成一行「已附项目说明」，开工任务书不受影响。
            </p>
            <Toggle
              checked={enabled}
              label="新对话自动附带项目背景"
              onChange={handleToggle}
            />
          </div>
          {mode === "custom" && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md ccode-well px-2.5 py-1.5 text-micro text-l3">
              <span>当前沿用旧版自定义模板；切换为自动生成可随最新规则与知识实时更新。</span>
              <button
                type="button"
                className={ghostActionClass}
                onClick={() => handleToggle(true)}
              >
                切为自动生成
              </button>
            </div>
          )}
          <div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="flex min-h-7 flex-1 items-center gap-1.5 text-left"
                onClick={() => setPreviewOpen((v) => !v)}
                aria-expanded={previewOpen}
              >
                <FoldMark open={previewOpen} />
                <span className="font-medium text-l2">预览 AI 拿到的全文</span>
                {previewLoading && (
                  <span className="text-micro text-l4">渲染中…</span>
                )}
              </button>
              {previewOpen && (
                <button
                  type="button"
                  className={ghostActionClass}
                  onClick={() => void loadPreview(mode, templateDraft)}
                  title="规则、长期知识等改动后，点这里按项目当前内容重新读取"
                  aria-label="重新读取预览"
                >
                  <RotateCw size={12} strokeWidth={1.8} />
                </button>
              )}
            </div>
            {previewOpen && preview !== null && (
              <div className="mt-1">
                {preview.trim() ? (
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md ccode-well p-2 text-micro leading-5 text-l2">
                    {preview}
                  </pre>
                ) : (
                  <p className="rounded-md ccode-well p-2 text-micro text-l3">
                    （已关闭：新建对话只发送你输入的内容）
                  </p>
                )}
              </div>
            )}
          </div>
          {(saved || error) && (
            <div className="flex items-center gap-2 text-micro">
              {saved && <span className="text-ok-text">✓ 已保存</span>}
              {error && <span className="text-err-text">{error}</span>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
