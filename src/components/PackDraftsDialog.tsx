import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Modal } from "./Modal";
import { confirmDialog } from "./ConfirmDialog";
import { beginAskAi } from "./AskAiModal";
import {
  compactFieldClass,
  InlineNotice,
  primaryActionClass,
  quietActionClass,
  secondaryActionClass,
} from "./PageFrame";
import { buildPackAuthorPrompt, buildPackFixPrompt, issueLine, splitIssues } from "../task-pack-author";
import { triggerSummary } from "../task-packs";
import { addPackToProject } from "../pack-add";
import { renderTaskMd } from "../task-md";
import { IS_WINDOWS } from "../hotkeys";
import { toast } from "../toast";
import type {
  PackDraftCheckDto,
  PackDraftDto,
  ProjectConfigDto,
  TaskPackDto,
} from "../types";

/**
 * 跟 AI 写我的任务（任务包第二期，2026-11-03）。
 * new：起个名字、写一句要做什么 → 建草稿（.ccode/pack-drafts/<id>/，不进 git）→ 开对话让 AI 按格式写 pack.toml 与技能；
 * list：草稿逐个检查（机器校验，拦下的装不进）、预览任务书 → 装进我的任务，或装进后直接加到这个项目试跑
 * （试跑就是普通开工：在工作副本里做、评审后才进项目，不另造一套）。
 */
export default function PackDraftsDialog({
  mode,
  projectPath,
  config,
  onClose,
  onAddedToProject,
}: {
  mode: "new" | "list";
  projectPath: string;
  config: ProjectConfigDto;
  onClose: () => void;
  /** 装进并加到这个项目后：父组件重读档案卡 */
  onAddedToProject: () => void;
}) {
  if (mode === "new") return <NewDraft projectPath={projectPath} onClose={onClose} />;
  return <DraftList projectPath={projectPath} config={config} onClose={onClose} onAddedToProject={onAddedToProject} />;
}

function NewDraft({ projectPath, onClose }: { projectPath: string; onClose: () => void }) {
  const [name, setName] = useState("");
  const [intent, setIntent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const draft = await invoke<PackDraftDto>("start_task_pack_draft", {
        projectRoot: projectPath,
        name: name.trim(),
        description: intent,
      });
      beginAskAi({
        path: "",
        name: `我的任务：${draft.name}`,
        cwd: projectPath,
        root: projectPath,
        reuseKey: `pack-draft:${projectPath}:${draft.id}`,
        prompt: buildPackAuthorPrompt({ ...draft, name: draft.name, intent }),
        preview: false,
      });
      toast("AI 写好后，回项目设置 → 研究流程 →「我的任务草稿」点检查，确认后装进我的任务。", "info");
      onClose();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open size="md" title="跟 AI 写我的任务" onClose={onClose}>
      <form onSubmit={start} className="space-y-3 text-sm">
        <p className="text-xs text-l3">
          说清这件任务要解决什么、产出什么。AI 会读项目里的文件（组里的 SOP、方法学论文、样例数据可以先放进项目），拿不准的先问你，再写成一份草稿；
          草稿在 Mesa 里检查、预览，你确认了才装进「我的任务」。
        </p>
        <label className="block">
          <span className="mb-1 block text-xs text-l3">任务名</span>
          <input
            className={`${compactFieldClass} w-full`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如 单细胞数据质控"
            autoFocus
            required
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-l3">要做什么</span>
          <textarea
            className={`${compactFieldClass} min-h-28 w-full resize-y py-2`}
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            required
            placeholder="例如：拿到 10x 单细胞计数矩阵后，按组里 docs/qc-sop.md 做质控：线粒体比例、基因数阈值、双细胞去除，出一份带图的质控报告，剔除了多少细胞要写清楚。阈值每个课题不一样。"
          />
        </label>
        {error && <InlineNotice tone="err">{error}</InlineNotice>}
        <div className="flex justify-end gap-2">
          <button type="button" className={secondaryActionClass} onClick={onClose}>
            取消
          </button>
          <button type="submit" className={primaryActionClass} disabled={busy || !name.trim() || !intent.trim()}>
            {busy ? "正在开对话…" : "开对话让 AI 写"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DraftList({
  projectPath,
  config,
  onClose,
  onAddedToProject,
}: {
  projectPath: string;
  config: ProjectConfigDto;
  onClose: () => void;
  onAddedToProject: () => void;
}) {
  const [drafts, setDrafts] = useState<PackDraftDto[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [check, setCheck] = useState<PackDraftCheckDto | null>(null);
  const [previewStep, setPreviewStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload(keep?: string | null) {
    try {
      const list = await invoke<PackDraftDto[]>("list_task_pack_drafts", { projectRoot: projectPath });
      setDrafts(list);
      const next = list.find((d) => d.id === keep)?.id ?? list[0]?.id ?? null;
      setSelected(next);
      if (next) await runCheck(next);
      else setCheck(null);
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function runCheck(id: string) {
    setError(null);
    try {
      setCheck(await invoke<PackDraftCheckDto>("check_task_pack_draft", { projectRoot: projectPath, id }));
      setPreviewStep(0);
    } catch (reason) {
      setError(String(reason));
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const draft = drafts?.find((d) => d.id === selected) ?? null;
  const { blocks, warns } = splitIssues(check?.issues ?? []);
  const pack = check?.pack ?? null;
  const preview = useMemo(() => {
    const step = pack?.steps[previewStep];
    if (!pack || !step) return null;
    // 按默认参数拼出这一步在这个项目里的任务书（与开工同一份 renderTaskMd）
    return renderTaskMd({ ...step, params: pack.params }, config, projectPath, undefined, undefined, undefined, undefined, IS_WINDOWS);
  }, [pack, previewStep, config, projectPath]);

  async function install(addToProject: boolean) {
    if (!draft || !pack) return;
    setBusy(true);
    setError(null);
    try {
      const existing = await invoke<TaskPackDto[]>("list_task_packs").catch(() => [] as TaskPackDto[]);
      const same = existing.find((p) => p.name === pack.name);
      if (same && !(await confirmDialog(`已有同名的我的任务「${pack.name}」，装进去会覆盖成新版本。继续？`, { danger: true }))) return;
      const saved = await invoke<TaskPackDto>("install_task_pack_draft", {
        projectRoot: projectPath,
        id: draft.id,
        overwrite: same?.id ?? null,
      });
      if (addToProject) {
        const res = await addPackToProject({ projectPath, pack: saved });
        onAddedToProject();
        toast(
          `已装进我的任务，并把 ${res.appended} 步加到流程末尾${res.skipped.length ? `（同名跳过 ${res.skipped.join("、")}）` : ""}。点那一步的「开始」试跑：在工作副本里做，评审后才进项目。${
            res.skillsAdded.length ? `新装了技能 ${res.skillsAdded.join("、")}，去「技能」页为要用的 Agent 打开。` : ""
          }`,
          "success",
        );
      } else {
        toast(`已装进我的任务：${saved.name}。在流程编辑器「＋ 从模板追加」里能加进任何项目。`, "success");
      }
      await reload(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    if (!draft) return;
    if (!(await confirmDialog(`丢弃草稿「${draft.name || draft.id}」？草稿目录会移到回收站。`, { danger: true, confirmText: "丢弃" }))) return;
    try {
      await invoke("discard_task_pack_draft", { projectRoot: projectPath, id: draft.id });
      await reload(null);
    } catch (reason) {
      setError(String(reason));
    }
  }

  function backToChat() {
    if (!draft) return;
    beginAskAi({
      path: "",
      name: `我的任务：${draft.name}`,
      cwd: projectPath,
      root: projectPath,
      reuseKey: `pack-draft:${projectPath}:${draft.id}`,
      prompt: buildPackFixPrompt(draft.packRel, check?.issues ?? [], check?.parseError ?? null),
      preview: false,
    });
    onClose();
  }

  return (
    <Modal
      open
      size="lg"
      title="我的任务草稿"
      description="AI 写的草稿先在这里检查、预览，确认了才装进「我的任务」。拦下的要先改，提醒的看情况。"
      onClose={onClose}
      footer={
        draft ? (
          <>
            <button type="button" className={quietActionClass} onClick={() => void discard()} disabled={busy}>
              丢弃
            </button>
            <button type="button" className={secondaryActionClass} onClick={backToChat} disabled={busy}>
              回对话接着改
            </button>
            <button
              type="button"
              className={secondaryActionClass}
              disabled={busy || !pack || blocks.length > 0}
              onClick={() => void install(false)}
            >
              装进我的任务
            </button>
            <button
              type="button"
              className={primaryActionClass}
              disabled={busy || !pack || blocks.length > 0}
              title="装进我的任务，并按默认参数加到这个项目的流程末尾，点开始就是试跑"
              onClick={() => void install(true)}
            >
              装进并加到这个项目试跑
            </button>
          </>
        ) : undefined
      }
    >
      <div className="space-y-3 text-sm">
        {error && <InlineNotice tone="err">{error}</InlineNotice>}
        {drafts && drafts.length === 0 && <p className="text-xs text-l3">没有草稿。项目设置 → 研究流程 →「跟 AI 写我的任务」新建一份。</p>}
        {drafts && drafts.length > 1 && (
          <div className="flex flex-wrap gap-1">
            {drafts.map((d) => (
              <button
                key={d.id}
                type="button"
                aria-pressed={d.id === selected}
                className={`rounded-md border px-2 py-1 ${d.id === selected ? "border-cta-bd text-l1" : "border-field text-l3"}`}
                onClick={() => {
                  setSelected(d.id);
                  void runCheck(d.id);
                }}
              >
                <span className="text-xs">{d.name || d.id}</span>
              </button>
            ))}
          </div>
        )}
        {draft && (
          <div className="flex items-center gap-2 text-xs text-l3">
            <span className="min-w-0 flex-1 truncate font-mono">{draft.packRel}</span>
            <button type="button" className={quietActionClass} onClick={() => void runCheck(draft.id)} disabled={busy}>
              重新检查
            </button>
          </div>
        )}
        {check?.parseError && <InlineNotice tone="warn">{check.parseError}。AI 还没写完，或者写法不对：回对话让它接着改。</InlineNotice>}
        {blocks.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium text-err-text">拦下 {blocks.length} 条（改了才能装）</p>
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-l2">
              {blocks.map((b, i) => (
                <li key={i}>{issueLine(b)}</li>
              ))}
            </ul>
          </div>
        )}
        {warns.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium text-warn-text">提醒 {warns.length} 条</p>
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-l3">
              {warns.map((w, i) => (
                <li key={i}>{issueLine(w)}</li>
              ))}
            </ul>
          </div>
        )}
        {pack && blocks.length === 0 && warns.length === 0 && <p className="text-xs text-ok-text">检查通过，没有拦下和提醒。</p>}
        {pack && (
          <div className="space-y-2">
            <p className="text-xs text-l3">
              {pack.name}：{pack.steps.length} 步
              {pack.params.length > 0 && ` · 参数 ${pack.params.map((p) => `${p.label}（默认 ${p.value || "空"}）`).join("、")}`}
              {pack.skills.length > 0 && ` · 随包技能 ${pack.skills.join("、")}`}
            </p>
            {pack.trigger && (
              <p className="text-xs text-l3">
                带触发：{triggerSummary(pack.trigger)}（加进项目时勾选才建；「装进并加到这个项目试跑」不建）
              </p>
            )}
            {pack.steps.length > 0 && (
              <div className="flex flex-wrap items-center gap-1 text-xs">
                <span className="text-l3">预览任务书：</span>
                {pack.steps.map((s, i) => (
                  <button
                    key={`${s.name}-${i}`}
                    type="button"
                    aria-pressed={i === previewStep}
                    className={`rounded-sm border px-1.5 py-0.5 ${i === previewStep ? "border-cta-bd text-l1" : "border-field text-l3"}`}
                    onClick={() => setPreviewStep(i)}
                  >
                    <span className="text-xs">
                      {i + 1}. {s.name || "（没名字）"}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {preview && (
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-canvas p-3 font-mono text-micro leading-5 text-l2">
                {preview}
              </pre>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
