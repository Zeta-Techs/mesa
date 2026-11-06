import TemplateUpgradePanel from "./TemplateUpgradePanel";
import { sanitizeWsName, toDraft, toStep, type StepDraft } from "../pipeline-step-draft";
import ResearchToolFields from "./ResearchToolFields";
import { researchToolsFromSettings, settingsWithResearchTools, withResearchTools } from "../research-tools";
import { conflictingTemplateSteps, renameConflictingSteps } from "../pipeline-append";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Checkbox,
  compactFieldClass,
  compactPrimaryActionClass,
  EmptyState,
  FoldMark,
  inlineActionClass,
  secondaryActionClass,
} from "./PageFrame";
import { confirmDialog } from "./ConfirmDialog";
import StepSkillsChips from "./StepSkillsChips";
import {
  completionOptionsForTarget,
  HUMAN_COMPLETION_LABELS,
  isCompletionCompatible,
  normalizeCompletion,
} from "../human-task-completion";
import {
  PIPELINE_TEMPLATES,
  pipelineStepsForTemplate,
  RESOURCE_TYPE_LABELS,
  settingsForTemplateApply,
  UNTESTED_TEMPLATE_BADGE,
  UNTESTED_TEMPLATE_HINT,
  type SubmissionMode,
} from "../pipeline-presets";
import type {
  AppendStepsResultDto,
  HumanTaskDto,
  ProjectConfigDto,
  ProjectConfigReadDto,
  ProjectStepDto,
  SkillDto,
  TaskPackDto,
} from "../types";
import { useAppStore } from "../store";
import { importedScriptsNote, packMcpNote, triggerDefaultOn, triggerSummary } from "../task-packs";
import { addPackToProject } from "../pack-add";
import PackParamInput from "./PackParamInput";

const actionBtn = inlineActionClass;
const ctaSm = compactPrimaryActionClass;
const field = compactFieldClass;
/** 多行框：compactFieldClass 带 h-7 定高，套在 textarea 上会把十行的简报压成一行（2026-11-06 用户截图） */
const area = `${compactFieldClass.replace("h-7 ", "")} resize-y py-1.5 leading-relaxed`;

/** 人工事项时机选项（值与后端 before/during/after 对应） */
const TIMING_OPTIONS: { value: string; label: string }[] = [
  { value: "before", label: "开始前" },
  { value: "during", label: "进行中" },
  { value: "after", label: "收尾" },
];

/**
 * 研究流程编辑器（全宽覆盖层）：项目研究流程的唯一编辑入口。
 * 每个步骤一张卡片（名称/工作区名/简报/预期产物/验收条件/输入依赖/run 脚本/资源绑定），卡片可排序与增删；
 * 「保存」把全部步骤整体写回 project.toml（write_project_config 由父组件执行），「取消」放弃草稿，
 * 有未保存改动时关闭需确认。
 */
export default function PipelineEditor({
  projectName,
  projectPath,
  config,
  warnings,
  saving,
  taskBindings,
  focusStep,
  initialUpgradeTemplate,
  onSave,
  onClose,
  onConfigReload,
}: {
  projectName: string;
  /** 项目根路径：「从模板追加」直接写 project.toml 用 */
  projectPath: string;
  config: ProjectConfigDto;
  /** read_project_config 的 warnings（含资源绑定校验），原样展示 */
  warnings: string[];
  saving: boolean;
  /** 步骤专属绑定（改名/删步骤保存时点名受影响条数；undefined = 调用方没有该数据） */
  taskBindings?: Record<string, { profile: string; model?: string | null }> | null;
  /** 从步骤 ✎ 进入时定位的步骤序号：滚动到该卡片并聚焦简报输入框 */
  focusStep?: number | null;
  /** 从项目页「内置模板有更新 · 去看看」进来：展开模板更新一节并选好这套模板 */
  initialUpgradeTemplate?: string;
  /** 保存成功与关闭覆盖层由父组件负责 */
  onSave: (steps: ProjectStepDto[], settings?: string[]) => void;
  onClose: () => void;
  /** 从模板追加成功后回推重读的配置（父组件同步 cfg/warnings，保持脏检查基准一致） */
  onConfigReload: (read: ProjectConfigReadDto) => void;
}) {
  const [tools, setTools] = useState(() => researchToolsFromSettings(config.settings));
  const [drafts, setDrafts] = useState<StepDraft[]>(() =>
    config.steps.map(toDraft),
  );
  const [error, setError] = useState<string | null>(null);
  // 「从模板追加」：内联模板列表 + 追加结果行内提示
  const [appendOpen, setAppendOpen] = useState(false);
  const [appending, setAppending] = useState(false);
  const [appendResult, setAppendResult] = useState<AppendStepsResultDto | null>(
    null,
  );
  const [submissionAppend, setSubmissionAppend] = useState<{
    template: (typeof PIPELINE_TEMPLATES)[number];
    mode: SubmissionMode;
    round: number;
  } | null>(null);
  // 我的任务（任务包，2026-11-03）：追加面板里一栏；有参数的先填表再加
  const [packs, setPacks] = useState<TaskPackDto[]>([]);
  const [packForm, setPackForm] = useState<{
    pack: TaskPackDto;
    values: Record<string, string>;
    /** 包带触发时：要不要一并建定时任务 / 事件规则 */
    withTrigger: boolean;
  } | null>(null);
  const [packNote, setPackNote] = useState<string | null>(null);
  const resources = config.resources;
  // 技能库（推荐技能 chip 的展示元数据与「＋ 添加技能」候选）：挂载时读一次，失败降级为不可编辑 chip
  const [skillLib, setSkillLib] = useState<SkillDto[] | null>(null);
  const providesByName = useMemo(
    () => (skillLib ? Object.fromEntries(skillLib.map((s) => [s.name, s.provides ?? []])) : undefined),
    [skillLib],
  );
  // 模板更新：草稿按保存口径收成步骤，模板步骤按本项目研究工具换算（与项目页提示同一口径）
  const draftSteps = useMemo(() => drafts.map(toStep), [drafts]);
  const normalizeTemplateStep = useCallback(
    (s: ProjectStepDto) => withResearchTools(s, tools, config.artifactDir, config.litSource, providesByName),
    [tools, config.artifactDir, config.litSource, providesByName],
  );
  const skillMeta = useMemo(
    () =>
      skillLib
        ? Object.fromEntries(skillLib.map((s) => [s.name, s.description]))
        : undefined,
    [skillLib],
  );
  // 折叠区展开态：键为 `${卡片序号}:${区块}`，一律默认收起，这里只记用户的显式覆盖。
  // 序号在排序/删除后会错位，但折叠态是纯瞬时视图状态，不影响数据。
  const [folds, setFolds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let stale = false;
    invoke<SkillDto[]>("list_skills")
      .then((lib) => {
        if (!stale) setSkillLib(lib);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, []);

  // 展开模板列表时拉一次我的任务（旧「我的模板」2026-11-03 并进我的任务）
  useEffect(() => {
    if (!appendOpen) return;
    let stale = false;
    invoke<TaskPackDto[]>("list_task_packs")
      .then((list) => {
        if (!stale) setPacks(list);
      })
      .catch(() => {
        if (!stale) setPacks([]);
      });
    return () => {
      stale = true;
    };
  }, [appendOpen]);

  /** 从我的任务追加：后端补装库里缺的随包技能，再按模板追加同一条原子写入；成功后同 appendTemplate 重读 */
  async function appendPack(pack: TaskPackDto, values: Record<string, string>, withTrigger = false) {
    if (appending) return;
    if (
      dirty &&
      !(await confirmDialog(
        "追加会丢掉还没保存的改动，继续？",
        { danger: true },
      ))
    )
      return;
    // 导入的包第一次加进项目：再确认一次随包文件（后端也会拦）
    const scriptsNote = importedScriptsNote(pack);
    if (scriptsNote && !(await confirmDialog(scriptsNote, { confirmText: "看过了，继续" }))) return;
    setAppending(true);
    setAppendResult(null);
    setPackNote(null);
    setError(null);
    try {
      const res = await addPackToProject({
        projectPath,
        pack,
        values: Object.fromEntries(pack.params.map((p) => [p.key, values[p.key] ?? p.value])),
        withTrigger,
        scriptsReviewed: Boolean(scriptsNote),
      });
      const read = await invoke<ProjectConfigReadDto>("read_project_config", { path: projectPath });
      setDrafts(read.config.steps.map(toDraft));
      setTools(researchToolsFromSettings(read.config.settings));
      onConfigReload(read);
      setAppendResult({ appended: res.appended, skipped: res.skipped, renamed: res.renamed });
      const notes = [
        ...(res.skillsAdded.length > 0
          ? [`新装了技能 ${res.skillsAdded.join("、")}：还没分发给任何 Agent，去「技能」页为要用的 Agent 打开。`]
          : []),
        ...(res.triggerNote ? [res.triggerNote] : []),
      ];
      if (notes.length > 0) setPackNote(notes.join(" "));
      setPackForm(null);
      setAppendOpen(false);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setAppending(false);
    }
  }

  async function deletePack(pack: TaskPackDto) {
    if (
      !(await confirmDialog(
        `删除我的任务「${pack.name}」？会移到回收站；已经加进项目的步骤不受影响。`,
        { danger: true, confirmText: "删除" },
      ))
    )
      return;
    try {
      await invoke("delete_task_pack", { id: pack.id });
      setPacks((list) => list.filter((p) => p.id !== pack.id));
    } catch (reason) {
      setError(String(reason));
    }
  }

  // 挂载时定位一次（仅 ✎ 入口带 focusStep；卡片内第一个 textarea 即简报框）
  useEffect(() => {
    if (focusStep == null) return;
    const card = document.querySelector(`[data-step-card="${focusStep}"]`);
    card?.scrollIntoView({ block: "center" });
    card?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 初始快照按写回口径归一化后序列化，作为脏检查基准（与编辑器保存的结果同构）
  const initialJson = useMemo(
    () => JSON.stringify(config.steps.map((s, i) => toStep(toDraft(s), i))),
    [config.steps],
  );
  const dirty = JSON.stringify(drafts.map(toStep)) !== initialJson || JSON.stringify(tools) !== JSON.stringify(researchToolsFromSettings(config.settings));

  function patch(index: number, patchPart: Partial<StepDraft>) {
    setDrafts((list) =>
      list.map((d, i) => (i === index ? { ...d, ...patchPart } : d)),
    );
  }

  function move(index: number, delta: -1 | 1) {
    setDrafts((list) => {
      const target = index + delta;
      if (target < 0 || target >= list.length) return list;
      const next = [...list];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function toggleResource(index: number, path: string, checked: boolean) {
    const bound = new Set(drafts[index].resources);
    if (checked) bound.add(path);
    else bound.delete(path);
    patch(index, { resources: [...bound] });
  }

  function patchHumanTask(
    index: number,
    ti: number,
    part: Partial<HumanTaskDto>,
  ) {
    patch(index, {
      humanTasks: drafts[index].humanTasks.map((t, x) =>
        x === ti
          ? {
              ...t,
              ...part,
              ...(part.target !== undefined
                ? {
                    completion: normalizeCompletion(
                      part.target,
                      t.completion,
                    ),
                  }
                : {}),
            }
          : t,
      ),
    });
  }

  function inputSuggestions(index: number): string[] {
    const upstream = drafts
      .slice(0, index)
      .flatMap((step) =>
        step.artifactsText
          .split(/[,，]/)
          .map((x) => x.trim())
          .filter(Boolean),
      );
    return [...new Set([...upstream, ...resources.map((r) => r.path)])];
  }

  async function tryClose() {
    if (
      dirty &&
      !(await confirmDialog("研究流程有未保存的改动，确定放弃并关闭？", {
        danger: true,
      }))
    )
      return;
    onClose();
  }

  async function save() {
    const missing = drafts.findIndex((d) => !d.name.trim());
    if (missing >= 0) {
      setError(`第 ${missing + 1} 步还没有填写步骤名`);
      return;
    }
    // 步骤重名防御（步骤专属绑定按步骤名做键，重名会错乱；后端 write_project_config 同拦）
    const names = drafts.map((d) => d.name.trim());
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) {
      setError(`步骤名重复：${dup}；步骤专属绑定按步骤名匹配，重名会错乱`);
      return;
    }
    // 改名/删步骤的影响面披露（M6 修复）：步骤名同时是 step: 槽键（SQLite）与
    // project.toml tasks[].step（任务卡）的软外键，写侧无迁移——保存前点名
    // 「多少绑定悬空、多少张卡降级为想法卡」，把悬空从事后发现（Agents 页坏行）
    // 变成显式决定。与换模板路径的警示句式同款。
    const oldNames = new Set(config.steps.map((s) => s.name));
    const newNames = new Set(names);
    const gone = [...oldNames].filter((n) => !newNames.has(n));
    if (gone.length > 0) {
      let cards: { step: string | null }[] = [];
      try {
        cards = (await useAppStore.getState().loadTaskCards(projectPath)) ?? [];
      } catch {
        cards = [];
      }
      const boundGone = gone.filter((n) => taskBindings?.[`step:${n}`]).length;
      const cardGone = cards.filter((c) => c.step !== null && gone.includes(c.step)).length;
      const impacts = [
        ...(boundGone > 0 ? [`${boundGone} 条步骤专属绑定将失效（「Agent 分工」页签可清）`] : []),
        ...(cardGone > 0 ? [`${cardGone} 张任务卡将脱离本步骤，转为想法卡（「继续/开工」入口随之消失）`] : []),
      ];
      if (impacts.length > 0) {
        const okToSave = await confirmDialog(
          `删掉或改名了步骤：${gone.join("、")}，仍要保存？\n\n${impacts.join("；")}。`,
          { danger: true, confirmText: "仍要保存" },
        );
        if (!okToSave) return;
      }
    }
    setError(null);
    try {
      onSave(drafts.map(toStep).map((s) => withResearchTools(s, tools, config.artifactDir, config.litSource, providesByName)), settingsWithResearchTools(config.settings ?? [], tools));
    } catch (reason) { setError(String(reason)); }
  }

  /** 从模板追加：步骤直接写入 project.toml，成功后重读配置刷新卡片。 */
  async function appendTemplate(
    tpl: {
      name: string;
      steps: ProjectStepDto[];
      id?: string;
      projectRules?: string[];
      projectSettings?: string[];
    },
    mode: SubmissionMode = "initial",
    round = 1,
  ) {
    if (appending) return;
    if (
      dirty &&
      !(await confirmDialog(
        "追加模板会丢掉还没保存的改动，继续？",
        { danger: true },
      ))
    )
      return;
    setAppending(true);
    setAppendResult(null);
    setError(null);
    try {
      let submissionSteps =
        tpl.id === "submission-rebuttal"
          ? pipelineStepsForTemplate(
              tpl as (typeof PIPELINE_TEMPLATES)[number],
              mode,
              round,
            )
          : tpl.steps;
      const current = await invoke<ProjectConfigReadDto>("read_project_config", { path: projectPath });
      const savedTools = researchToolsFromSettings(current.config.settings);
      submissionSteps = submissionSteps.map((s) => withResearchTools(s, savedTools, current.config.artifactDir, current.config.litSource, providesByName));
      const conflicts = conflictingTemplateSteps(current.config.steps, submissionSteps);
      if (conflicts.length) {
        if (!(await confirmDialog(`已有同名步骤：${conflicts.join("、")}。保留旧的，新的改名追加？`, { confirmText: "改名追加" }))) return;
        submissionSteps = renameConflictingSteps(current.config.steps, submissionSteps, tpl.name);
      }
      const res = await invoke<AppendStepsResultDto>(
        "apply_pipeline_template",
        {
          projectRoot: projectPath,
          steps: submissionSteps,
          projectSettings: settingsWithResearchTools(settingsForTemplateApply(tpl), savedTools),
          strategy: "append",
          topic: null,
          submissionMode: tpl.id === "submission-rebuttal" ? mode : null,
          submissionRound:
            tpl.id === "submission-rebuttal" && mode === "revision"
              ? Math.max(1, round)
              : null,
        },
      );
      // 刷新编辑器步骤列表：与保存后同一口径重读配置，本地草稿与父组件状态一起更新
      const read = await invoke<ProjectConfigReadDto>("read_project_config", {
        path: projectPath,
      });
      setDrafts(read.config.steps.map(toDraft));
      setTools(researchToolsFromSettings(read.config.settings));
      onConfigReload(read);
      setAppendResult(res);
      setAppendOpen(false);
      setSubmissionAppend(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setAppending(false);
    }
  }

  /**
   * 步骤卡的折叠区（v3.85 字段分档）：常驻只留「步骤名 / 简报 / 预期产物 / 输入依赖 / 推荐技能」——
   * 这五项决定 TASK.md 的全部内容，是步骤的合同本体；其余按「人机分工」与「高级」两档收起。
   * 字段一个没删（模板要用、向后兼容），只是默认不占视线：一屏从放不下一张卡变成放得下三张。
   *
   * **一律默认收起**：曾按「已填就展开」处理，结果模板步骤个个都填了 workspace_name 与
   * human_tasks，两档在每张卡上全是展开的，等于没折叠。workspace_name 是保存时自动派生的
   * 机械字段、human_tasks 是模板带的内容，都不算「用户自己配过的东西」；
   * 标题上的明细计数已经足够告诉人里面有什么，不需要靠默认展开来保证可发现性。
   */
  function fold(
    index: number,
    id: string,
    title: string,
    parts: { label: string; n: number }[],
    note: string,
    body: ReactNode,
  ) {
    const key = `${index}:${id}`;
    const filled = parts.filter((p) => p.n > 0);
    const open = folds[key] ?? false;
    return (
      <div className="mb-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setFolds((m) => ({ ...m, [key]: !open }))}
          className="flex w-full items-center gap-1.5 rounded-sm py-1 text-left text-xs text-l3 hover:text-l1"
        >
          <FoldMark open={open} boxed />
          {title}
          <span className="min-w-0 truncate text-micro text-l4">
            {filled.length
              ? filled
                  .map((p) => (p.n > 1 ? `${p.label} ${p.n}` : p.label))
                  .join(" · ")
              : "未设置"}
          </span>
        </button>
        {open && (
          <div className="pl-4">
            {/* 「这些改了会不会显示在流程里」是编辑时最常问的一句，直接写在区首 */}
            <p className="mb-1.5 text-micro leading-4 text-l4">{note}</p>
            {body}
          </div>
        )}
      </div>
    );
  }

  function renderCard(d: StepDraft, i: number) {
    // 绑定里引用了已移除资源的失效条目：保留展示并可勾选移除，不静默丢弃
    const stale = d.resources.filter(
      (p) => !resources.some((r) => r.path === p),
    );
    // 链路校验供给侧：上游步骤产物与其技能 outputs + 本步骤声明输入 + 项目资源
    // （inputSuggestions 已含上游产物与资源；文本框按全部分隔符粗切，供给是集合，过切无害）
    const chainSupply = [
      ...inputSuggestions(i),
      ...[d.inputsText, d.optionalInputsText, d.anyOfInputsText].flatMap(
        (t) =>
          t
            .split(/[,，;；\n|]/)
            .map((x) => x.trim())
            .filter(Boolean),
      ),
      ...drafts
        .slice(0, i)
        .flatMap((s2) =>
          s2.skills.flatMap(
            (n) => skillLib?.find((x) => x.name === n)?.outputs ?? [],
          ),
        ),
    ];
    const expectedArtifacts = d.artifactsText
      .split(/[,，]/)
      .map((x) => x.trim())
      .filter(Boolean);
    return (
      <div
        key={i}
        data-step-card={i}
        className="rounded-md ccode-well p-3"
      >
        <div className="mb-2 flex items-center gap-2">
          <span className="shrink-0 text-xs text-l4">#{i + 1}</span>
          <input
            className={`${field} min-w-0 flex-1`}
            value={d.name}
            onChange={(e) => patch(i, { name: e.target.value })}
            placeholder="步骤名，如 文献综述"
          />
          {/* 工作区名移进「高级」：99% 的步骤用派生值，不该常年占一格。
              这里只回显最终会用的名字，不展开也能确认 */}
          <span
            className="shrink-0 truncate font-mono text-micro text-l4"
            title="绑定的工作区名（在「高级」里可改）"
          >
            {d.workspaceName.trim() ||
              sanitizeWsName(d.name) ||
              `step-${i + 1}`}
          </span>
          <div className="flex shrink-0 items-center">
            <button
              type="button"
              className={actionBtn}
              disabled={i === 0}
              title="上移"
              aria-label={`上移步骤：${d.name || i + 1}`}
              onClick={() => move(i, -1)}
            >
              ↑
            </button>
            <button
              type="button"
              className={actionBtn}
              disabled={i === drafts.length - 1}
              title="下移"
              aria-label={`下移步骤：${d.name || i + 1}`}
              onClick={() => move(i, 1)}
            >
              ↓
            </button>
            <button
              type="button"
              className={actionBtn}
              title="删除该步骤（不影响已创建的工作区；保存后才生效）"
              onClick={() =>
                setDrafts((list) => list.filter((_, x) => x !== i))
              }
            >
              删除
            </button>
          </div>
        </div>

        <label className="mb-2 block">
          <span className="mb-1 block text-xs text-l3">决策暂停策略</span>
          <select className={field} value={d.decisionMode} onChange={(e) => patch(i, { decisionMode: e.target.value })}>
            <option value="auto_continue">一般问题可按可逆兜底继续</option>
            <option value="soft_pause">软暂停：未答需二次确认，只推进无依赖工作</option>
            <option value="hard_pause">硬暂停：结构化决策全部回答后开工</option>
          </select>
        </label>
        <label className="mb-2 block">
          <span className="mb-1 block text-xs text-l3">
            简报（开始这一步时写成任务书 TASK.md）
          </span>
          <textarea
            className={`${area} w-full`}
            rows={12}
            value={d.brief}
            onChange={(e) => patch(i, { brief: e.target.value })}
            placeholder="本步骤的目标、背景与交付物要求"
          />
        </label>

        <label className="mb-2 block">
          <span className="mb-1 block text-xs text-l3">
            预期产物（逗号分隔，如 notes/, references.bib）
          </span>
          <input
            className={`${field} w-full`}
            value={d.artifactsText}
            onChange={(e) => patch(i, { artifactsText: e.target.value })}
            placeholder="notes/, references.bib"
          />
        </label>

        <label className="mb-2 block">
          <span className="mb-1 block text-xs text-l3">
            内容级验收条件（每行一条；仅文件存在不等于通过）
          </span>
          <textarea
            className={`${area} w-full font-mono text-xs`}
            rows={Math.min(10, Math.max(3, d.acceptanceText.split("\n").length))}
            value={d.acceptanceText}
            onChange={(e) => patch(i, { acceptanceText: e.target.value })}
            placeholder="如：每条引用键都能在 references.bib 解析\n如：脚本从 main 重跑结果一致"
          />
        </label>

        <label className="mb-2 block">
          <span className="mb-1 block text-xs text-l3">
            必需输入（逗号分隔；缺失会提示）
          </span>
          <input
            className={`${field} w-full font-mono text-xs`}
            value={d.inputsText}
            onChange={(e) => patch(i, { inputsText: e.target.value })}
            placeholder="如 survey/gap-analysis.md, references.bib"
            title="填写本步骤实际要读取的上游产物或项目资源路径"
            list={`step-input-suggestions-${i}`}
          />
          <datalist id={`step-input-suggestions-${i}`}>
            {inputSuggestions(i).map((path) => (
              <option key={path} value={path} />
            ))}
          </datalist>
          {inputSuggestions(i).length > 0 && (
            <span className="mt-0.5 block text-micro text-l4">
              可从上游产物或项目资源建议中选择
            </span>
          )}
          <div className="mt-1">
            <span className="mb-0.5 block text-micro text-l4">
              可选输入（缺失不阻断）
            </span>
            <input
              className={`${field} w-full font-mono text-xs`}
              value={d.optionalInputsText}
              onChange={(e) => patch(i, { optionalInputsText: e.target.value })}
              placeholder="如 supplementary.csv"
              title="可选输入缺失不阻断本步骤"
            />
          </div>
          <div className="mt-1">
            <span className="mb-0.5 block text-micro text-l4">
              任一输入（每组用 | 分隔）
            </span>
            <input
              className={`${field} w-full font-mono text-xs`}
              value={d.anyOfInputsText}
              onChange={(e) => patch(i, { anyOfInputsText: e.target.value })}
              placeholder="paper-final.md | review-final.md；多组用分号或换行分隔"
              title="每组用 | 分隔，组内任一输入满足即可；多组用分号或换行分隔"
            />
          </div>
          <span className="mt-0.5 block text-micro text-l4">
            每组满足其中一个即可；多组之间用分号或换行分隔
          </span>
        </label>

        {/* 推荐技能：常驻第 5 项。与另外四项一起构成 TASK.md 的全部内容，是「合同」本体。
            这里改的是草稿，随整份 steps 一起保存（不走 update_step_skills 的单步写回）。 */}
        <div className="mb-2">
          <StepSkillsChips
            skills={d.skills}
            requiredSkills={d.requiredSkills}
            brief={d.brief}
            skillMeta={skillMeta}
            available={skillLib?.map((s) => s.name)}
            mcpRecommended={skillLib
              ?.filter((s) => s.mentionsMcp)
              .map((s) => s.name)}
            skillLib={skillLib}
            chainSupply={chainSupply}
            expectedArtifacts={expectedArtifacts}
            onChange={(next) =>
              patch(i, {
                skills: next,
                // 新挂载技能默认必需；已有技能可通过芯片上的必需/可选切换单独调整。
                requiredSkills: [
                  ...d.requiredSkills.filter((name) => next.includes(name)),
                  ...next.filter((name) => !d.skills.includes(name)),
                ],
              })
            }
            onRequiredChange={(next) =>
              patch(i, {
                requiredSkills: next.filter((name) => d.skills.includes(name)),
              })
            }
          />
        </div>

        {d.checks.length > 0 && (
          <p className="mb-2 text-xs text-l3">
            核验（来自我的任务，任务书里会叫 AI 交付前跑）：{d.checks.map((c) => c.description || c.name).join("、")}
          </p>
        )}
        {d.params.length > 0 && (
          // 来自「我的任务」的参数：只改取值；简报等文字里的 {param:键} 拼任务书时换成这里的值
          <div className="mb-2">
            <span className="mb-1 block text-xs text-l3">参数（来自我的任务，简报里的 {"{param:…}"} 拼任务书时换成这里的值）</span>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {d.params.map((p, pi) => (
                <label key={p.key} className="block text-xs">
                  <span className="mb-0.5 block text-l3" title={p.help || undefined}>
                    {p.label}
                  </span>
                  <PackParamInput
                    param={p}
                    value={p.value}
                    fieldClass={field}
                    allowUnlisted
                    onChange={(value) => patch(i, { params: d.params.map((x, xi) => (xi === pi ? { ...x, value } : x)) })}
                  />
                </label>
              ))}
            </div>
          </div>
        )}

        {fold(
          i,
          "human",
          "人机分工",
          [
            { label: "人工事项", n: d.humanTasks.length },
            { label: "决策项", n: d.decisions.length },
            { label: "讨论种子", n: d.discussionSeeds.length },
          ],
          "这三项都会显示在流程线上。",
          <>
        <div className="mb-2">
          <span className="mb-1 block text-xs text-l3">
            人工事项（人必须参与的事项清单；标题空白行保存时丢弃）
          </span>
          {d.humanTasks.map((t, ti) => (
            <div key={ti} className="mb-1 rounded-sm ccode-well p-1.5">
              <div className="mb-1 flex items-center gap-1">
                <input
                  className={`${field} min-w-0 flex-1`}
                  value={t.title}
                  onChange={(e) =>
                    patchHumanTask(i, ti, { title: e.target.value })
                  }
                  placeholder="一句话说明，如 下载付费墙文献全文"
                />
                <input
                  className={`${field} w-44 shrink-0 font-mono text-xs`}
                  value={t.target}
                  onChange={(e) =>
                    patchHumanTask(i, ti, { target: e.target.value })
                  }
                  placeholder="落点，如 papers/ 或 papers/*.pdf"
                  title="交付落点：目录（结尾 /）、精确文件或「目录/通配」；留空 = 纯脑力事项"
                />
                <select
                  className={`${field} w-24 shrink-0`}
                  value={t.timing}
                  onChange={(e) =>
                    patchHumanTask(i, ti, { timing: e.target.value })
                  }
                  title="时机：开始前 / 进行中 / 收尾"
                >
                  {/* 旧配置里出现未知 timing 值时保留原值可选，不静默改写 */}
                  {!TIMING_OPTIONS.some((o) => o.value === t.timing) && (
                    <option value={t.timing}>{t.timing}</option>
                  )}
                  {TIMING_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className={`${actionBtn} shrink-0`}
                  aria-label={`删除人工事项：${t.title || ti + 1}`}
                  onClick={() =>
                    patch(i, {
                      humanTasks: d.humanTasks.filter((_, x) => x !== ti),
                    })
                  }
                >
                  删除
                </button>
              </div>
              <div className="flex items-center gap-2">
                <textarea
                  className={`${area} min-w-0 flex-1 text-xs`}
                  rows={2}
                  value={t.guidance}
                  onChange={(e) =>
                    patchHumanTask(i, ti, { guidance: e.target.value })
                  }
                  placeholder="引导说明（可选）：渠道选项等，只告知不推荐"
                />
                {/* 「可选」以前只能由模板写、界面上没有开关，编辑器一保存还会把它抹掉（v3.85 补） */}
                <span className="shrink-0">
                  <Checkbox
                    checked={t.optional ?? false}
                    onChange={(checked) =>
                      patchHumanTask(i, ti, { optional: checked })
                    }
                    label={
                      <span
                        className="text-micro text-l3"
                        title="可选事项：不做也不影响这一步跑完，流程线上标「可选」且不计入待办数"
                      >
                        可选
                      </span>
                    }
                  />
                </span>
                <select
                  className={`${field} w-36 shrink-0 text-xs`}
                  value={t.completion ?? "exists"}
                  onChange={(e) =>
                    patchHumanTask(i, ti, {
                      completion: e.target.value as HumanTaskDto["completion"],
                    })
                  }
                  title="完成判定：文件出现、必须人工确认、通配目标全部满足或清除占位"
                >
                  {!isCompletionCompatible(
                    t.target,
                    t.completion ?? "exists",
                  ) && (
                    <option value={t.completion}>
                      当前配置：
                      {HUMAN_COMPLETION_LABELS[
                        t.completion as NonNullable<HumanTaskDto["completion"]>
                      ] ?? t.completion}
                    </option>
                  )}
                  {completionOptionsForTarget(t.target).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              {(t.completion ?? "exists") === "all" && (
                <div className="mt-1 flex items-center gap-2">
                  <input
                    className={`${field} w-32 font-mono text-xs`}
                    type="number"
                    min={0}
                    step={1}
                    value={t.expectedCount ?? ""}
                    onChange={(e) =>
                      patchHumanTask(i, ti, {
                        expectedCount:
                          e.target.value.trim() === ""
                            ? undefined
                            : Math.max(0, Number.parseInt(e.target.value, 10) || 0),
                      })
                    }
                    placeholder="目标数量"
                    title="all 的目标总数；不填时 papers/*.pdf 可从 to-fetch.md 推导"
                  />
                  <input
                    className={`${field} min-w-0 flex-1 font-mono text-xs`}
                    value={t.manifestPath ?? ""}
                    onChange={(e) =>
                      patchHumanTask(i, ti, { manifestPath: e.target.value })
                    }
                    placeholder="或清单路径，如 papers/to-fetch.md"
                    title="每行一个目标；空行和 # 注释行不计数"
                  />
                </div>
              )}
              {!isCompletionCompatible(
                t.target,
                t.completion ?? "exists",
              ) && (
                <p className="mt-0.5 text-micro text-warn-text">
                  当前落点不支持该判定；保存时会改为「出现即检测」
                </p>
              )}
            </div>
          ))}
          <button
            type="button"
            className={actionBtn}
            onClick={() =>
              patch(i, {
                humanTasks: [
                  ...d.humanTasks,
                  {
                    title: "",
                    guidance: "",
                    target: "",
                    timing: "before",
                    optional: false,
                    completion: "manual",
                    expectedCount: undefined,
                    manifestPath: "",
                  },
                ],
              })
            }
          >
            ＋ 添加人工事项
          </button>
        </div>

        <div className="mb-2">
          <span className="mb-1 block text-xs text-l3">
            决策项（有选项可点选，首项为推荐值；留空选项则必须手写依据，不提供默认批准）
          </span>
          {d.decisions.map((dec, di) => (
            <div key={di} className="mb-1 flex items-center gap-1">
              <input
                className={`${field} min-w-0 flex-1`}
                value={dec.q}
                onChange={(e) =>
                  patch(i, {
                    decisions: d.decisions.map((x, xi) =>
                      xi === di ? { ...x, q: e.target.value } : x,
                    ),
                  })
                }
                placeholder="问题，如 纳入标准定多严"
              />
              <input
                className={`${field} min-w-0 flex-[2]`}
                value={dec.optionsText}
                onChange={(e) =>
                  patch(i, {
                    decisions: d.decisions.map((x, xi) =>
                      xi === di ? { ...x, optionsText: e.target.value } : x,
                    ),
                  })
                }
                placeholder="选项以逗号分隔；需人填写批准依据时留空"
              />
              <button
                type="button"
                className={`${actionBtn} shrink-0`}
                aria-label={`删除决策项：${dec.q || di + 1}`}
                onClick={() =>
                  patch(i, {
                    decisions: d.decisions.filter((_, x) => x !== di),
                  })
                }
              >
                删除
              </button>
            </div>
          ))}
          <button
            type="button"
            className={actionBtn}
            onClick={() =>
              patch(i, {
                decisions: [...d.decisions, { q: "", optionsText: "" }],
              })
            }
          >
            ＋ 添加决策项
          </button>
        </div>

        <div className="mb-2">
          <span className="mb-1 block text-xs text-l3">
            讨论种子（答案不可枚举、需要来回聊的开放问题；点击即开会话）
          </span>
          {d.discussionSeeds.map((s, si) => (
            <div key={si} className="mb-1 flex items-center gap-1">
              <input
                className={`${field} min-w-0 flex-1`}
                value={s}
                onChange={(e) =>
                  patch(i, {
                    discussionSeeds: d.discussionSeeds.map((x, xi) =>
                      xi === si ? e.target.value : x,
                    ),
                  })
                }
                placeholder="如 纳入排除标准定多严：只要 RCT 还是观察性研究也要？"
              />
              <button
                type="button"
                className={`${actionBtn} shrink-0`}
                aria-label={`删除讨论种子：${s || si + 1}`}
                onClick={() =>
                  patch(i, {
                    discussionSeeds: d.discussionSeeds.filter(
                      (_, x) => x !== si,
                    ),
                  })
                }
              >
                删除
              </button>
            </div>
          ))}
          <button
            type="button"
            className={actionBtn}
            onClick={() =>
              patch(i, { discussionSeeds: [...d.discussionSeeds, ""] })
            }
          >
            ＋ 添加讨论种子
          </button>
        </div>
          </>,
        )}

        {fold(
          i,
          "adv",
          "高级",
          [
            // 只把「和派生值不同」算作自定义——模板步骤的 workspace_name 恒等于派生值，
            // 一律算已填会让这一档在每张卡上都显示有内容
            {
              label: "自定义工作区名",
              n:
                d.workspaceName.trim() &&
                d.workspaceName.trim() !== sanitizeWsName(d.name)
                  ? 1
                  : 0,
            },
            { label: "run 脚本", n: d.run.length },
            { label: "资源绑定", n: d.resources.length },
            { label: "先问文献来源", n: d.asksLitSource ? 1 : 0 },
          ],
          "这些不显示在流程线上，幕后生效。",
          <>
        <div className="mb-2">
          <Checkbox
            checked={d.asksLitSource}
            onChange={(checked) => patch(i, { asksLitSource: checked })}
            label={
              <span
                className="text-xs text-l2"
                title="流程线「定方向」里会出现文献来源选择与导入入口；答案写进项目配置，与只写草稿的决策项不是一类"
              >
                这一步先问「文献从哪来」
              </span>
            }
          />
        </div>

        <label className="mb-2 block">
          <span className="mb-1 block text-xs text-l3">
            工作区名（英文；留空按步骤名自动派生）
          </span>
          <input
            className={`${field} w-full font-mono text-xs`}
            value={d.workspaceName}
            onChange={(e) => patch(i, { workspaceName: e.target.value })}
            placeholder={sanitizeWsName(d.name) || `step-${i + 1}`}
            title="绑定工作区名（英文）；留空保存时按步骤名自动派生"
          />
        </label>

        <div className="mb-2">
          <span className="mb-1 block text-xs text-l3">
            run 脚本（开始这一步时写入项目 .ccode/settings.toml，可在工作区「运行脚本」菜单执行）
          </span>
          {d.run.map((r, ri) => (
            <div key={ri} className="mb-1 flex items-center gap-1">
              <input
                className={`${field} w-40 shrink-0 text-xs`}
                value={r.name}
                onChange={(e) =>
                  patch(i, {
                    run: d.run.map((x, xi) =>
                      xi === ri ? { ...x, name: e.target.value } : x,
                    ),
                  })
                }
                placeholder="名称，如 render-draft"
              />
              <input
                className={`${field} min-w-0 flex-1 font-mono text-xs`}
                value={r.command}
                onChange={(e) =>
                  patch(i, {
                    run: d.run.map((x, xi) =>
                      xi === ri ? { ...x, command: e.target.value } : x,
                    ),
                  })
                }
                placeholder="命令，如 quarto render manuscript/draft.md --to pdf"
              />
              <button
                type="button"
                className={`${actionBtn} shrink-0`}
                aria-label={`删除脚本：${r.name || ri + 1}`}
                onClick={() =>
                  patch(i, { run: d.run.filter((_, xi) => xi !== ri) })
                }
              >
                删除
              </button>
            </div>
          ))}
          <button
            type="button"
            className={actionBtn}
            onClick={() =>
              patch(i, {
                run: [...d.run, { name: "", command: "", default: false }],
              })
            }
          >
            ＋ 添加脚本
          </button>
        </div>

        <div>
          <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
            <span className="text-xs text-l3">资源绑定</span>
            <span className="text-xs text-l4">
              {d.resources.length === 0
                ? `不绑定 = 本步骤使用项目全部资源（${resources.length} 项）`
                : `已绑定 ${d.resources.length} 项；全部取消勾选即恢复为使用全部资源`}
            </span>
          </div>
          {resources.length === 0 && stale.length === 0 ? (
            <p className="text-xs text-l4">
              项目还没有登记资源，可在项目「资源」面板扫描登记。
            </p>
          ) : (
            <ul className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
              {resources.map((r) => (
                <li key={r.path} className="min-w-0">
                  <Checkbox
                    checked={d.resources.includes(r.path)}
                    onChange={(checked) => toggleResource(i, r.path, checked)}
                    label={
                      <span className="flex min-w-0 items-center gap-2 text-xs">
                        <span className="shrink-0 rounded-sm bg-inset px-1 py-0.5 text-l3">
                          {RESOURCE_TYPE_LABELS[r.type] ?? "其他"}
                        </span>
                        <span className="min-w-0 truncate text-l2" title={r.name}>
                          {r.name}
                        </span>
                        <span
                          className="min-w-0 truncate font-mono text-l4"
                          title={r.path}
                        >
                          {r.path}
                        </span>
                      </span>
                    }
                  />
                </li>
              ))}
              {stale.map((p) => (
                <li key={p} className="min-w-0">
                  <Checkbox
                    checked
                    onChange={(checked) => toggleResource(i, p, checked)}
                    label={
                      <span className="flex min-w-0 items-center gap-2 text-xs">
                        <span className="shrink-0 rounded-sm bg-inset px-1 py-0.5 text-warn-text">
                          失效
                        </span>
                        <span
                          className="min-w-0 truncate font-mono text-l4"
                          title="该资源已从项目资源清单移除，取消勾选可清理绑定"
                        >
                          {p}
                        </span>
                      </span>
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
          </>,
        )}
      </div>
    );
  }

  return (
    <div data-surface="canvas" className="fixed inset-0 z-30 flex flex-col bg-canvas">
      {/* 覆盖层头部统一（P3）：strip 底 + hairline 下缘，标题 + 副题 + 唯一主动作（保存） */}
      <div className="flex shrink-0 items-center gap-3 border-b border-hairline bg-strip px-8 py-3">
        <h2 className="shrink-0 text-base font-semibold text-l1">
          编辑研究流程
        </h2>
        <span className="min-w-0 truncate text-xs text-l3">
          {projectName} · {drafts.length} 个步骤
        </span>
        {error && <span className="shrink-0 text-xs text-err-text">{error}</span>}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            className={secondaryActionClass}
            onClick={tryClose}
          >
            取消
          </button>
          <button
            type="button"
            className={ctaSm}
            disabled={saving}
            onClick={save}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-3xl space-y-3 px-8 py-4">
          <ResearchToolFields value={tools} onChange={setTools} disabled={saving || appending} />
          <TemplateUpgradePanel
            steps={draftSteps}
            normalize={normalizeTemplateStep}
            initialTemplate={initialUpgradeTemplate}
            onLoad={(picked) =>
              setDrafts((old) =>
                old.map((draft, index) => {
                  const hit = picked.find((p) => p.index === index);
                  return hit ? toDraft({ ...hit.step, resources: draft.resources }) : draft;
                }),
              )
            }
          />
          {warnings.length > 0 && (
            <div className="rounded-sm ccode-well p-2 text-xs">
              <p className="mb-1 text-warn-text">
                ! project.toml 有 {warnings.length} 条提示
              </p>
              <ul className="space-y-0.5 text-l3">
                {warnings.map((w) => (
                  <li key={w}>• {w}</li>
                ))}
              </ul>
            </div>
          )}
          {drafts.length === 0 && (
            <EmptyState
              title="还没有研究步骤"
              detail="点下方「＋ 添加步骤」逐张填写，保存即写入项目。"
            />
          )}
          {drafts.map(renderCard)}
          <div className="flex gap-2">
            <button
              type="button"
              className="flex-1 rounded-md ccode-well p-3 text-sm text-l3 hover:bg-hover hover:text-l1"
              onClick={() =>
                setDrafts((list) => [
                  ...list,
                  {
                    name: "",
                    workspaceName: "",
                    brief: "",
                    artifactsText: "",
                    acceptanceText: "",
                    decisionMode: "auto_continue",
                    inputsText: "",
                    optionalInputsText: "",
                    anyOfInputsText: "",
                    skills: [],
                    requiredSkills: [],
                    run: [],
                    resources: [],
                    humanTasks: [],
                    discussionSeeds: [],
                    decisions: [],
                    asksLitSource: false,
                    seedComplete: false,
                    pack: "",
                    params: [],
                    checks: [],
                    role: "",
                    fanOut: null,
                  },
                ])
              }
            >
              ＋ 添加步骤
            </button>
            <button
              type="button"
              className="flex-1 rounded-md ccode-well p-3 text-sm text-l3 hover:bg-hover hover:text-l1 disabled:opacity-40"
              disabled={appending}
              title="把模板的步骤追加到当前流程末尾；同名且交付相容才跳过；交付不同需确认改名追加"
              onClick={() => setAppendOpen((v) => !v)}
            >
              ＋ 从模板追加
            </button>
          </div>
          {appendResult && (
            <p className="text-xs">
              <span className="text-ok-text">
                已追加 {appendResult.appended} 步
              </span>
              {appendResult.skipped.length > 0 && (
                <span className="text-warn-text">
                  {"；跳过 "}
                  {appendResult.skipped.length}
                  {" 步（同名）："}
                  {appendResult.skipped.join("、")}
                </span>
              )}
              {appendResult.renamed?.length > 0 && (
                <span className="text-warn-text">
                  {"；工作区名冲突已自动改名："}
                  {appendResult.renamed
                    .map((r) => `${r.name}（${r.from}→${r.to}）`)
                    .join("、")}
                </span>
              )}
            </p>
          )}
          {packNote && <p className="text-xs text-warn-text">{packNote}</p>}
          {appendOpen && (
            <div className="rounded-md ccode-well p-3">
              <p className="mb-2 text-xs text-l3">
                选择模板，把它的步骤追加到当前流程末尾（同名交付不同需确认改名；工作区名冲突会自动加后缀）：
              </p>
              {packForm ? (
                <div className="rounded-sm ccode-well p-3">
                  <p className="text-xs font-medium text-l1">
                    {packForm.pack.name}
                    {packForm.pack.params.length > 0 ? "：填参数" : ""}
                  </p>
                  <div className="mt-2 space-y-2">
                    {packForm.pack.params.map((p) => (
                      <label key={p.key} className="block text-xs">
                        <span className="mb-1 block text-l3">{p.label}</span>
                        <PackParamInput
                          param={p}
                          value={packForm.values[p.key] ?? p.value}
                          fieldClass={field}
                          onChange={(value) => setPackForm((f) => (f ? { ...f, values: { ...f.values, [p.key]: value } } : f))}
                        />
                        {p.help && <span className="mt-0.5 block text-micro text-l4">{p.help}</span>}
                      </label>
                    ))}
                  </div>
                  {packMcpNote(packForm.pack) && <p className="mt-2 text-micro text-l4">{packMcpNote(packForm.pack)}</p>}
                  {packForm.pack.trigger && (
                    <label className="mt-3 flex items-start gap-2 text-xs">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={packForm.withTrigger}
                        onChange={(e) => setPackForm((f) => (f ? { ...f, withTrigger: e.target.checked } : f))}
                      />
                      <span>
                        <span className="block text-l2">一并建：{triggerSummary(packForm.pack.trigger)}</span>
                        <span className="block text-micro text-l4">
                          建好在项目的定时任务页能看到、能改能关。只记录的不叫 AI、不花钱；定时和直接跑的会按时叫 AI。
                        </span>
                      </span>
                    </label>
                  )}
                  <div className="mt-3 flex justify-end gap-2">
                    <button type="button" className={actionBtn} disabled={appending} onClick={() => setPackForm(null)}>
                      取消
                    </button>
                    <button
                      type="button"
                      className={ctaSm}
                      disabled={appending}
                      onClick={() => void appendPack(packForm.pack, packForm.values, packForm.withTrigger)}
                    >
                      加进流程
                    </button>
                  </div>
                </div>
              ) : submissionAppend ? (
                <div className="rounded-sm ccode-well p-3">
                  <p className="text-xs font-medium text-l1">投稿与返修分支</p>
                  <div className="mt-2 space-y-1.5 text-xs text-l2">
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        checked={submissionAppend.mode === "initial"}
                        onChange={() =>
                          setSubmissionAppend((s) =>
                            s ? { ...s, mode: "initial" } : s,
                          )
                        }
                      />
                      首投：期刊格式适配 → 投稿材料
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        checked={submissionAppend.mode === "revision"}
                        onChange={() =>
                          setSubmissionAppend((s) =>
                            s ? { ...s, mode: "revision" } : s,
                          )
                        }
                      />
                      返修：按轮次生成回复信、修订稿与再投稿清单
                    </label>
                    {submissionAppend.mode === "revision" && (
                      <label className="flex items-center gap-2 pl-6">
                        返修轮次
                        <input
                          type="number"
                          min={1}
                          step={1}
                          value={submissionAppend.round}
                          onChange={(e) =>
                            setSubmissionAppend((s) =>
                              s
                                ? {
                                    ...s,
                                    round: Math.max(
                                      1,
                                      Number.parseInt(e.target.value, 10) || 1,
                                    ),
                                  }
                                : s,
                            )
                          }
                          className={`${field} w-20`}
                        />
                      </label>
                    )}
                  </div>
                  <div className="mt-3 flex justify-end gap-2">
                    <button
                      type="button"
                      className={actionBtn}
                      disabled={appending}
                      onClick={() => setSubmissionAppend(null)}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className={ctaSm}
                      disabled={appending}
                      onClick={() =>
                        void appendTemplate(
                          submissionAppend.template,
                          submissionAppend.mode,
                          submissionAppend.round,
                        )
                      }
                    >
                      追加此分支
                    </button>
                  </div>
                </div>
              ) : (
                <ul className="space-y-1.5">
                {PIPELINE_TEMPLATES.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      className="w-full rounded-sm ccode-well p-2 text-left hover:bg-hover disabled:opacity-40"
                      disabled={appending}
                      onClick={() =>
                        t.id === "submission-rebuttal"
                          ? setSubmissionAppend({
                              template: t,
                              mode: "initial",
                              round: 1,
                            })
                          : void appendTemplate(t)
                      }
                    >
                      <span className="text-xs font-medium text-l1">
                        {t.name}
                      </span>
                      <span className="ml-2 rounded-sm bg-strip px-1.5 py-0.5 text-xs text-l3">
                        {t.steps.length} 步
                      </span>
                      {!t.fieldTested && (
                        <span
                          className="ml-1 rounded-sm bg-strip px-1.5 py-0.5 text-xs text-l3"
                          title={UNTESTED_TEMPLATE_HINT}
                        >
                          {UNTESTED_TEMPLATE_BADGE}
                        </span>
                      )}
                      <span className="mt-1 block truncate text-xs text-l4">
                        {t.steps.map((s) => s.name).join(" → ")}
                      </span>
                    </button>
                  </li>
                ))}
                {packs.length > 0 && (
                  <li className="pt-1 text-xs text-l3">我的任务</li>
                )}
                {packs.map((p) => (
                  <li key={p.id} className="group relative">
                    <button
                      type="button"
                      className="w-full rounded-sm ccode-well p-2 pr-8 text-left hover:bg-hover disabled:opacity-40"
                      disabled={appending}
                      title={p.description || undefined}
                      onClick={() =>
                        p.params.length > 0 || p.trigger
                          ? setPackForm({
                              pack: p,
                              values: Object.fromEntries(p.params.map((x) => [x.key, x.value])),
                              withTrigger: p.trigger ? triggerDefaultOn(p.trigger) : false,
                            })
                          : void appendPack(p, {})
                      }
                    >
                      <span className="text-xs font-medium text-l1">{p.name}</span>
                      <span className="ml-2 rounded-sm bg-strip px-1.5 py-0.5 text-xs text-l3">
                        {p.steps.length} 步{p.params.length > 0 ? ` · ${p.params.length} 个参数` : ""}
                      </span>
                      <span className="mt-1 block truncate text-xs text-l4">
                        {p.description || p.steps.map((s) => s.name).join(" → ")}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="absolute right-1.5 top-1.5 rounded-sm px-1 text-xs text-l4 opacity-0 hover:text-err-text focus:opacity-100 group-hover:opacity-100"
                      aria-label={`删除我的任务：${p.name}`}
                      title="删除这个我的任务（进回收站）"
                      onClick={() => void deletePack(p)}
                    >
                      ✕
                    </button>
                  </li>
                ))}
                </ul>
              )}
              {appending && (
                <p className="mt-2 text-xs text-l3">追加中…</p>
              )}
            </div>
          )}
          <div className="flex justify-end gap-2 pb-4">
            <button
              type="button"
              className={secondaryActionClass}
              onClick={tryClose}
            >
              取消
            </button>
            <button
              type="button"
              className={ctaSm}
              disabled={saving}
              onClick={save}
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
