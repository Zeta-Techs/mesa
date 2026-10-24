import { DEFAULT_RESEARCH_TOOLS, researchToolsFromSettings, settingsWithResearchTools, withResearchTools } from "../research-tools";
import { confirmDialog } from "./ConfirmDialog";
import { conflictingTemplateSteps, renameConflictingSteps } from "../pipeline-append";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  PIPELINE_TEMPLATES,
  pipelineStepsForTemplate,
  settingsForTemplateApply,
  UNTESTED_TEMPLATE_BADGE,
  UNTESTED_TEMPLATE_HINT,
  type PipelineTemplateDef,
  type SubmissionMode,
} from "../pipeline-presets";
import type { AppendStepsResultDto, ProjectConfigReadDto } from "../types";
import {
  fieldClass,
  primaryActionClass,
  quietActionClass,
  secondaryActionClass,
  NoticeBar,
} from "./PageFrame";
import { Modal } from "./Modal";

/**
 * 添加项目注册成功后的研究流程模板选择层（v3.79）：
 * 选项 = 内置六套模板（名称 + 一句话说明 + 步骤数），选中即把模板步骤追加进
 * project.toml（append_pipeline_steps：重名跳过、全跳过不落盘、顺带清 pipeline_opt_out）；
 * 「不使用研究流程」= 显式写 pipeline_opt_out = true（记住选择，不再显示模板引导），
 * 课题主题只在本层顶部填（科研流程开工才写进 TASK.md），不在「添加项目」弹窗。
 * 「稍后再选」= 只关闭不留痕；两条路事后都可从项目组 ⋯ 或编辑器「＋ 从模板追加」补。
 *
 * v3.90 第二屏「全局设定」：模板带 projectSettings（贯穿全程的决定）时，
 * 选中模板先进入填写屏——注册当下正是人最有耐心的时刻，只预填空答案等人
 * 自己去项目设置抽屉里发现，等于没引导（用户实测反馈）。全部可留空跳过。
 * 留空仍写入「名称：（提示）」占位，人在项目设置的规则里改，或让「跟 AI 商量一下」逐项问完再改。占位不进 TASK.md。
 * 2026-09-14：设定屏只填全局设定。稿件载体问在会换正式稿的步骤；库交付/Origin/Blender 问在用得上的那一步。
 */
export default function TemplatePickModal({
  projectPath,
  projectName,
  onClose,
  onOptOut,
  onApplied,
}: {
  projectPath: string;
  projectName: string;
  /** 「稍后再选」/遮罩点击：不写流程标记；已填的课题主题会落盘 */
  onClose: () => void;
  /** 「不使用研究流程」：已把 pipeline_opt_out = true 写进 project.toml，父级关闭并刷新 */
  onOptOut: () => void;
  /** 模板步骤追加成功：携带结果供页面刷新与成功提示 */
  onApplied: (result: AppendStepsResultDto, templateName: string) => void;
}) {
  // 追加中的模板 id（防连击，"__optout__" 为「不使用」写入中）；失败留在弹层内报错可换选/重试
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 第二屏：选中的带全局设定模板 + 逐条答案（下标对齐 tpl.projectSettings）
  const [settingsTpl, setSettingsTpl] = useState<PipelineTemplateDef | null>(
    null,
  );
  const [answers, setAnswers] = useState<string[]>([]);
  // 投稿与返修模板先选真实分支；返修轮次写入 project.toml，产物由轮次化步骤生成。
  const [submissionTpl, setSubmissionTpl] =
    useState<PipelineTemplateDef | null>(null);
  const [submissionMode, setSubmissionMode] =
    useState<SubmissionMode>("initial");
  const [submissionRound, setSubmissionRound] = useState(1);
  const [topic, setTopic] = useState("");
  const [tools, setTools] = useState({ ...DEFAULT_RESEARCH_TOOLS });

  useEffect(() => {
    let cancelled = false;
    invoke<ProjectConfigReadDto>("read_project_config", { path: projectPath })
      .then((read) => {
        if (cancelled) return;
        setTools(researchToolsFromSettings(read.config.settings));
        const t = read.config.topic?.trim();
        if (t) setTopic(t);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  async function persistTopicIfFilled() {
    const t = topic.trim();
    if (!t) return;
    try {
      const read = await invoke<ProjectConfigReadDto>("read_project_config", {
        path: projectPath,
      });
      if ((read.config.topic ?? "").trim() === t) return;
      await invoke("write_project_config", {
        path: projectPath,
        config: { ...read.config, topic: t },
      });
    } catch {
      /* 稍后仍可在项目头补 */
    }
  }

  async function closeLater() {
    if (busy) return;
    await persistTopicIfFilled();
    onClose();
  }

  /** 「问题：（提示）」拆成问题与提示（提示去掉括号做输入占位） */
  function splitSetting(line: string): { q: string; hint: string } {
    const i = line.indexOf("：");
    if (i < 0) return { q: line, hint: "" };
    return {
      q: line.slice(0, i),
      hint: line
        .slice(i + 1)
        .replace(/^（|）$/g, ""),
    };
  }

  /** 选中模板：有全局设定建议项先进填写屏，否则直接应用 */
  function pick(templateId: string) {
    const tpl = PIPELINE_TEMPLATES.find((t) => t.id === templateId);
    if (!tpl || busy) return;
    if (tpl.id === "submission-rebuttal") {
      setSubmissionTpl(tpl);
      setSubmissionMode("initial");
      setSubmissionRound(1);
      setError(null);
      return;
    }
    if (tpl.projectSettings?.length) {
      setSettingsTpl(tpl);
      setAnswers(tpl.projectSettings.map(() => ""));
      setError(null);
    } else {
      void apply(tpl);
    }
  }

  async function apply(tpl: PipelineTemplateDef, filled?: string[]) {
    if (busy) return;
    setBusy(tpl.id);
    setError(null);
    try {
      const mode = tpl.id === "submission-rebuttal" ? submissionMode : undefined;
      const round = Math.max(1, Math.floor(submissionRound));
      const submission = tpl.id === "submission-rebuttal";
      const projectSettings = settingsWithResearchTools(settingsForTemplateApply(tpl, filled), tools);
      const current = await invoke<ProjectConfigReadDto>("read_project_config", { path: projectPath });
      if (current.config.steps.length && JSON.stringify(researchToolsFromSettings(current.config.settings)) !== JSON.stringify(tools)) {
        throw new Error("已有流程的工具选择请在「编辑研究流程」统一修改，再追加模板；未改变现有步骤");
      }
      let steps = pipelineStepsForTemplate(tpl, mode ?? "initial", round).map((s) => withResearchTools(s, tools, current.config.artifactDir, current.config.litSource));
      const conflicts = conflictingTemplateSteps(current.config.steps, steps);
      if (conflicts.length) {
        if (!(await confirmDialog(`这些同名步骤的交付不同：${conflicts.join("、")}。保留旧步骤，按「${tpl.name}」改名追加？`, { confirmText: "改名追加" }))) { setBusy(null); return; }
        steps = renameConflictingSteps(current.config.steps, steps, tpl.name);
      }
      const res = await invoke<AppendStepsResultDto>(
        "apply_pipeline_template",
        {
          projectRoot: projectPath,
          steps,
          projectSettings,
          strategy: "append",
          topic: topic.trim() || null,
          submissionMode: submission ? mode ?? "initial" : null,
          submissionRound: submission && mode === "revision" ? round : null,
        },
      );
      onApplied(res, tpl.name);
    } catch (reason) {
      setError(String(reason));
      setBusy(null);
    }
  }

  /** 「不使用研究流程」：显式写 pipeline_opt_out = true（区别于「稍后再选」的不留痕关闭） */
  async function optOut() {
    if (busy) return;
    setBusy("__optout__");
    setError(null);
    try {
      await persistTopicIfFilled();
      await invoke("set_pipeline_opt_out", {
        projectRoot: projectPath,
        optOut: true,
      });
      onOptOut();
    } catch (reason) {
      setError(String(reason));
      setBusy(null);
    }
  }

  return (
    <Modal
      open
      title={
        submissionTpl
          ? "选择「投稿与返修」分支"
          : settingsTpl
            ? `「${settingsTpl.name}」的项目全局设定`
            : "选择研究流程模板"
      }
      onClose={() => void closeLater()}
      size="lg"
    >
        {submissionTpl ? (
          <>
            <p className="mb-4 text-xs text-l3">
              首投与返修不是同一条流水线；返修会按轮次生成独立的意见、回复信、修订稿和再投稿清单。
            </p>
            <div className="space-y-2">
              <label className="flex cursor-pointer items-start gap-2 rounded-sm ccode-well p-3">
                <input
                  type="radio"
                  name="submission-mode"
                  checked={submissionMode === "initial"}
                  onChange={() => setSubmissionMode("initial")}
                  className="mt-0.5"
                />
                <span>
                  <span className="block text-sm text-l1">首投</span>
                  <span className="mt-0.5 block text-xs text-l3">
                    期刊格式适配 → 投稿材料（cover letter、投稿前自查、投稿清单）
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 rounded-sm ccode-well p-3">
                <input
                  type="radio"
                  name="submission-mode"
                  checked={submissionMode === "revision"}
                  onChange={() => setSubmissionMode("revision")}
                  className="mt-0.5"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-l1">返修</span>
                  <span className="mt-0.5 block text-xs text-l3">
                    读取对应轮次审稿意见，生成轮次化回复信、修订稿与再投稿清单
                  </span>
                  {submissionMode === "revision" && (
                    <span className="mt-2 flex items-center gap-2 text-xs text-l2">
                      返修轮次
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
                        className={`${fieldClass} w-20`}
                      />
                    </span>
                  )}
                </span>
              </label>
            </div>
            {error && <NoticeBar tone="err" className="mt-3">{error}</NoticeBar>}
            <div className="mt-4 flex items-center justify-between">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  setSubmissionTpl(null);
                  setError(null);
                }}
                className={quietActionClass}
              >
                ‹ 换个模板
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  const tpl = submissionTpl;
                  setSubmissionTpl(null);
                  if (tpl.projectSettings?.length) {
                    setSettingsTpl(tpl);
                    setAnswers(tpl.projectSettings.map(() => ""));
                  } else {
                    void apply(tpl);
                  }
                }}
                className={`${primaryActionClass} disabled:opacity-50`}
              >
                下一步
              </button>
            </div>
          </>
        ) : settingsTpl ? (
          /* 第二屏只填全局设定。文献来源在检索步；稿件载体/库交付/Origin/Blender
             在用得上的那一步问，不挡在创建屏。 */
          <>
            <p className="mb-4 text-xs text-l3">
              这些设定会贯穿后续研究流程。填了的下次开工会写进任务书。留空也会在项目设置的规则里留出「综述角度：（…）」这样的空位，你可以把括号换成自己的答案，或稍后让 AI 逐项问你。
            </p>
            <div className="space-y-2.5">
              {settingsTpl.projectSettings!.map((line, i) => {
                const { q, hint } = splitSetting(line);
                const depth = q === "综述深度";
                return (
                  <label key={q} className="block">
                    <span className="mb-1 block text-xs text-l2">{q}</span>
                    <input
                      className={fieldClass}
                      value={answers[i] ?? ""}
                      placeholder={hint}
                      title={depth ? "系统综述要另定完整方法方案，不能只把检索升到严格档。" : undefined}
                      onChange={(e) =>
                        setAnswers((prev) =>
                          prev.map((a, j) => (j === i ? e.target.value : a)),
                        )
                      }
                    />
                    {depth && (
                      <span className="mt-1 block text-micro text-l4">
                        严格检索档不是系统综述
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
            {error && <NoticeBar tone="err" className="mt-3">{error}</NoticeBar>}
            <div className="mt-4 flex items-center justify-between">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  setSettingsTpl(null);
                  setError(null);
                }}
                className={quietActionClass}
              >
                ‹ 换个模板
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void apply(settingsTpl)}
                  title="空着的项会留在项目设置的规则里，带括号提示"
                  className={`${secondaryActionClass} disabled:opacity-50`}
                >
                  暂不填写，稍后补充
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void apply(settingsTpl, answers)}
                  className={`${primaryActionClass} disabled:opacity-50`}
                >
                  {busy === settingsTpl.id ? "写入中…" : "保存设定并应用模板"}
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <h2 className="mb-1 text-base font-semibold text-l1">
              选择研究流程模板
            </h2>
            <p className="mb-4 text-xs text-l3">
              「{projectName}」已添加。写论文请挑一套流程；只读文献、写笔记，选下面的「不使用研究流程」。
            </p>
            <label className="mb-4 block">
              <span
                className="mb-1 block text-xs text-l3"
                title="每次开工时写进 TASK.md，给 Agent 交代研究背景"
              >
                课题主题（可选）
              </span>
              <input
                className={fieldClass}
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="如 GLP-1 受体激动剂的心血管结局"
                autoFocus
              />
            </label>
            <ul className="space-y-1.5">
              {PIPELINE_TEMPLATES.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => pick(t.id)}
                    className="w-full rounded-sm ccode-well p-2.5 text-left hover:bg-hover disabled:opacity-50"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-l1">{t.name}</span>
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
                      {busy === t.id && (
                        <span className="ml-auto text-xs text-l3">写入中…</span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-l3">{t.description}</p>
                  </button>
                </li>
              ))}
            </ul>
            {error && <NoticeBar tone="err" className="mt-3">{error}</NoticeBar>}
            {/* 「不使用」显式写 pipeline_opt_out 标记（隐藏模板引导）；「稍后」只关闭不留痕，
                两者事后都可从项目组 ⋯「选择研究流程模板」/编辑器「＋ 从模板追加」补 */}
            <div className="mt-4 flex items-center justify-between">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void optOut()}
                title="不挂步进器，只把这个文件夹当文献库：沉浸阅读和笔记都写在这里（记住选择，不再显示模板引导）"
                className={quietActionClass}
              >
                {busy === "__optout__" ? "保存中…" : "不使用研究流程"}
              </button>
              <button
                type="button"
                onClick={() => void closeLater()}
                title="之后可从项目组 ⋯「选择研究流程模板」或编辑器「＋ 从模板追加」随时添加"
                className={secondaryActionClass}
              >
                稍后再选
              </button>
            </div>
          </>
        )}
    </Modal>
  );
}
