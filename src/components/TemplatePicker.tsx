import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirmDialog } from "./ConfirmDialog";
import MyPacksSection from "./MyPacksSection";
import { compactPrimaryActionClass, inlineActionClass } from "./PageFrame";
import { basedOnFor, builtinKey, builtinUpdate, currentBuiltinSteps, rebased } from "../pack-builtin";
import {
  PIPELINE_TEMPLATES,
  pipelineStepsForTemplate,
  settingsForTemplateApply,
  UNTESTED_TEMPLATE_BADGE,
  UNTESTED_TEMPLATE_HINT,
  type SubmissionMode,
} from "../pipeline-presets";
import type { ProjectStepDto, TaskPackDto } from "../types";

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
 * 研究流程模板选择器（内联面板）：内置模板（pipeline-presets）+ 我的任务（任务包，list_task_packs）。
 * 内置模板选中只抛出 steps，写回 project.toml（含覆盖确认/保留 topic 与 resources）由父组件负责；
 * 我的任务抛出整个包，由父组件经 add_task_pack_to_project 写入（2026-11-03 第四期：旧「我的模板」并进我的任务）。
 * 内置可「另存为我的版本」（记 based_on）；打开时把一步都没改过的我的版本直接跟上内置新版。
 */
export default function TemplatePicker({
  applying,
  onApply,
  onApplyPack,
  onError,
}: {
  applying: boolean;
  onApply: (item: TemplatePickItem) => void;
  onApplyPack: (pack: TaskPackDto) => void;
  onError: (msg: string) => void;
}) {
  const [packs, setPacks] = useState<TaskPackDto[]>([]);
  // 现在的内置步骤（经后端归一，与包里读出来的同一个样子），按 builtinKey 存
  const [currents, setCurrents] = useState<Record<string, ProjectStepDto[]>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [submissionMode, setSubmissionMode] =
    useState<SubmissionMode>("initial");
  const [submissionRound, setSubmissionRound] = useState(1);

  /** 读我的任务，并把它们基于的内置按现在的样子归一一遍 */
  const load = useCallback(async () => {
    const list = await invoke<TaskPackDto[]>("list_task_packs").catch(() => [] as TaskPackDto[]);
    const next: Record<string, ProjectStepDto[]> = {};
    for (const p of list) {
      if (!p.basedOn || builtinKey(p.basedOn) in next) continue;
      const raw = currentBuiltinSteps(p.basedOn);
      if (!raw) continue;
      const norm = await invoke<ProjectStepDto[]>("normalize_pack_steps", { steps: raw }).catch(() => null);
      if (norm) next[builtinKey(p.basedOn)] = norm;
    }
    return { list, currents: next };
  }, []);

  const reload = useCallback(async () => {
    const { list, currents: next } = await load();
    setPacks(list);
    setCurrents(next);
  }, [load]);

  useEffect(() => {
    let stale = false;
    (async () => {
      const { list, currents: next } = await load();
      // 没改过的我的版本自动跟内置新版（design-task-packs §6）；改过的留给人在「内置有更新」里挑
      const followed: string[] = [];
      for (const p of list) {
        const update = p.basedOn ? builtinUpdate(p, next[builtinKey(p.basedOn)]) : null;
        if (!update?.untouched || !p.basedOn) continue;
        try {
          await invoke("save_task_pack", {
            id: p.id,
            name: p.name,
            description: p.description,
            params: p.params,
            steps: update.current,
            basedOn: rebased(p.basedOn, update.current),
          });
          followed.push(p.name);
        } catch {
          /* 跟不上就留着「内置有更新」让人处理 */
        }
      }
      const fresh = followed.length ? await invoke<TaskPackDto[]>("list_task_packs").catch(() => list) : list;
      if (stale) return;
      setPacks(fresh);
      setCurrents(next);
      if (followed.length) setNotice(`你没改过的「${followed.join("」「")}」已跟上内置新版。`);
    })();
    return () => {
      stale = true;
    };
  }, [load]);

  /** 内置另存为我的版本：步骤原样存进我的任务，记基于哪个内置（投稿模板按当前选的分支） */
  async function saveAsMine(t: (typeof PIPELINE_TEMPLATES)[number]) {
    const basedOn = basedOnFor(t.id, submissionMode, submissionRound);
    if (!basedOn) return;
    const name = `${t.name}（我的版本）`;
    const same = packs.find((p) => p.name === name);
    if (same && !(await confirmDialog(`已有「${name}」，再存一次会把它换回内置原样，你在上面的改动会丢。继续？`, { danger: true }))) return;
    try {
      await invoke<TaskPackDto>("save_task_pack", {
        id: same?.id ?? null,
        name,
        description: t.description,
        params: [],
        steps: basedOn.steps,
        basedOn,
        // 内置模板的项目规则与全局设定（「名称：（提示）」空位）一并带上，用它建流程时和直接选内置一样写进项目设置
        projectSettings: settingsForTemplateApply(t),
      });
      await reload();
      setNotice(
        `已另存为我的任务「${name}」。要改内容：先用它建流程，在「编辑研究流程」里改好，再用项目设置「另存为我的任务」同名存回；内置以后升级，这里会标「内置有更新」。`,
      );
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
  ) {
    const stepPreview = t.steps.map((s) => s.name).join(" → ");
    return (
      <li key={key} className="rounded-sm ccode-well p-2">
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-xs font-medium text-l1">{t.name}</span>
          <span className="shrink-0 rounded-sm bg-strip px-1.5 py-0.5 text-xs text-l3">
            {t.steps.length} 步
          </span>
          {!t.fieldTested && (
            <span
              className="shrink-0 rounded-sm bg-strip px-1.5 py-0.5 text-xs text-l3"
              title={UNTESTED_TEMPLATE_HINT}
            >
              {UNTESTED_TEMPLATE_BADGE}
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              className={actionBtn}
              title="把这套内置复制成「我的任务」，在你的版本上改；内置以后升级时会提示差异"
              onClick={() => void saveAsMine(t as (typeof PIPELINE_TEMPLATES)[number])}
            >
              另存为我的版本
            </button>
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
    // 字号放容器上：全站 button { font: inherit } 会吞掉按钮上的 text-xs
    <div className="text-xs">
      <ul className="space-y-1.5">
        {PIPELINE_TEMPLATES.map((t) => renderRow(t, t.id))}
      </ul>
      {notice && <p className="mt-2 text-xs text-l3">{notice}</p>}
      <MyPacksSection
        packs={packs}
        currents={currents}
        reload={reload}
        applying={applying}
        onApplyPack={onApplyPack}
        onError={onError}
        onNotice={setNotice}
      />
    </div>
  );
}
