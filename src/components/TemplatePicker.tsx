import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirmDialog } from "./ConfirmDialog";
import { compactPrimaryActionClass, inlineActionClass } from "./PageFrame";
import {
  PIPELINE_TEMPLATES,
  pipelineStepsForTemplate,
  UNTESTED_TEMPLATE_BADGE,
  UNTESTED_TEMPLATE_HINT,
  type SubmissionMode,
} from "../pipeline-presets";
import type { PipelineTemplateDto, ProjectStepDto } from "../types";

const actionBtn = inlineActionClass;
const ctaSm = compactPrimaryActionClass;

/** 选择器向外抛出的模板：内置与用户模板同构，父组件只关心 steps */
export interface TemplatePickItem {
  id?: string;
  name: string;
  steps: ProjectStepDto[];
  projectRules?: string[];
  projectSettings?: string[];
  mode?: SubmissionMode;
  round?: number;
}

/**
 * 研究流程模板选择器（内联面板）：内置模板（pipeline-presets）+ 用户模板（list_pipeline_templates）。
 * 后端命令未注册（旧版本）时优雅降级为仅内置模板，不报错也不影响其他功能；
 * 选中只抛出 steps，写回 project.toml（含覆盖确认/保留 topic 与 resources）由父组件负责。
 */
export default function TemplatePicker({
  applying,
  onApply,
  onError,
}: {
  applying: boolean;
  onApply: (item: TemplatePickItem) => void;
  onError: (msg: string) => void;
}) {
  const [userTemplates, setUserTemplates] = useState<PipelineTemplateDto[]>([]);
  const [backendMissing, setBackendMissing] = useState(false);
  const [submissionMode, setSubmissionMode] =
    useState<SubmissionMode>("initial");
  const [submissionRound, setSubmissionRound] = useState(1);

  useEffect(() => {
    let stale = false;
    invoke<PipelineTemplateDto[]>("list_pipeline_templates")
      .then((list) => {
        if (!stale) setUserTemplates(list);
      })
      .catch(() => {
        // 后端未就绪：只展示内置模板，并在「我的模板」区给出提示
        if (!stale) setBackendMissing(true);
      });
    return () => {
      stale = true;
    };
  }, []);

  async function removeTemplate(t: PipelineTemplateDto) {
    if (
      !(await confirmDialog(`删除模板「${t.name}」？已应用的研究流程不受影响。继续？`, {
        danger: true,
      }))
    )
      return;
    try {
      await invoke("delete_pipeline_template", { id: t.id });
      setUserTemplates((list) => list.filter((x) => x.id !== t.id));
    } catch (reason) {
      onError(String(reason));
    }
  }

  function renderRow(
    t: {
      id?: string;
      name: string;
      description: string;
      steps: ProjectStepDto[];
      projectRules?: string[];
      projectSettings?: string[];
      fieldTested?: boolean;
    },
    key: string,
    onDelete?: () => void,
  ) {
    const stepPreview = t.steps.map((s) => s.name).join(" → ");
    return (
      <li key={key} className="rounded-sm ccode-well p-2">
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-xs font-medium text-l1">{t.name}</span>
          <span className="shrink-0 rounded-sm bg-strip px-1.5 py-0.5 text-xs text-l3">
            {t.steps.length} 步
          </span>
          {!onDelete && !t.fieldTested && (
            <span
              className="shrink-0 rounded-sm bg-strip px-1.5 py-0.5 text-xs text-l3"
              title={UNTESTED_TEMPLATE_HINT}
            >
              {UNTESTED_TEMPLATE_BADGE}
            </span>
          )}
          {onDelete && (
            <span className="shrink-0 rounded-sm bg-strip px-1.5 py-0.5 text-xs text-l3">
              我的
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {onDelete && (
              <button type="button" className={actionBtn} onClick={onDelete}>
                删除
              </button>
            )}
            <button
              type="button"
              className={ctaSm}
              disabled={applying}
              onClick={() => {
                const mode =
                  t.id === "submission-rebuttal" ? submissionMode : undefined;
                const round = Math.max(1, Math.floor(submissionRound));
                onApply({
                  id: t.id,
                  name: t.name,
                steps:
                    t.id === "submission-rebuttal"
                      ? pipelineStepsForTemplate(
                          t as (typeof PIPELINE_TEMPLATES)[number],
                          mode ?? "initial",
                          round,
                        )
                      : t.steps,
                  projectRules: t.projectRules,
                  projectSettings: t.projectSettings,
                  mode,
                  round: mode === "revision" ? round : undefined,
                });
              }}
            >
              {applying ? "写入中…" : "使用"}
            </button>
          </div>
        </div>
        {t.description && (
          <p className="mt-1 text-xs text-l3">{t.description}</p>
        )}
        {t.id === "submission-rebuttal" && (
          <div className="mt-2 flex items-center gap-2 text-xs text-l2">
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="template-submission-mode"
                checked={submissionMode === "initial"}
                onChange={() => setSubmissionMode("initial")}
              />
              首投
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="template-submission-mode"
                checked={submissionMode === "revision"}
                onChange={() => setSubmissionMode("revision")}
              />
              返修
            </label>
            {submissionMode === "revision" && (
              <label className="flex items-center gap-1">
                第
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={submissionRound}
                  onChange={(e) =>
                    setSubmissionRound(
                      Math.max(1, Number.parseInt(e.target.value, 10) || 1),
                    )
                  }
                  className="w-14 rounded-sm border border-field bg-inset px-1 py-0.5 text-xs"
                />
                轮
              </label>
            )}
          </div>
        )}
        <p className="mt-1 truncate text-xs text-l4" title={stepPreview}>
          <span className="mr-1 text-l4">完整步骤：</span>
          {stepPreview}
        </p>
      </li>
    );
  }

  return (
    <div>
      <ul className="space-y-1.5">
        {PIPELINE_TEMPLATES.map((t) => renderRow(t, t.id))}
      </ul>
      {(userTemplates.length > 0 || backendMissing) && (
        <>
          <p className="mb-1 mt-3 text-xs text-l3">我的模板</p>
          {backendMissing ? (
            <p className="text-xs text-l4">
              模板存储需要更新版本的后端支持，当前仅可使用内置模板。
            </p>
          ) : (
            <ul className="space-y-1.5">
              {userTemplates.map((t) =>
                renderRow(t, t.id, () => void removeTemplate(t)),
              )}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
