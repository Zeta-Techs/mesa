import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Modal } from "./Modal";
import { confirmDialog } from "./ConfirmDialog";
import { InlineNotice, primaryActionClass, secondaryActionClass } from "./PageFrame";
import { issueLine, splitIssues } from "../task-pack-author";
import { triggerSummary } from "../task-packs";
import type { PackImportPreviewDto, TaskPackDto } from "../types";

const SKILL_STATUS: Record<string, string> = {
  new: "会装进技能库（不分发给任何 Agent，要用时去「技能」页打开）",
  same: "库里已有，内容一样",
  differs: "库里已有同名技能、内容不一样：用库里那份，包里这份不装",
};

/**
 * 导入我的任务（任务包第四期，design-task-packs.md §7.2）：zip 先只读解到暂存区，这里列出会装的技能、
 * 随包每个文件的全文（SKILL.md 是写给 Agent 的指令，脚本会在工作副本里跑，都要人看过）、参数与检查结果；
 * 人点「装进我的任务」才装。装好的标「导入」，第一次加进项目前还会再问一次。
 */
export default function ImportPackDialog({
  preview,
  onClose,
  onInstalled,
}: {
  preview: PackImportPreviewDto;
  onClose: () => void;
  onInstalled: (pack: TaskPackDto) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(preview.files.find((f) => !f.path.endsWith("/SKILL.md"))?.path ?? preview.files[0]?.path ?? null);
  const { blocks, warns } = splitIssues(preview.issues);
  const pack = preview.pack;
  const file = preview.files.find((f) => f.path === openFile) ?? null;

  async function discard() {
    await invoke("discard_task_pack_import", { token: preview.token }).catch(() => {});
    onClose();
  }

  async function install() {
    setBusy(true);
    setError(null);
    try {
      const existing = await invoke<TaskPackDto[]>("list_task_packs").catch(() => [] as TaskPackDto[]);
      const same = existing.find((p) => p.name === pack.name);
      if (same && !(await confirmDialog(`已有同名的我的任务「${pack.name}」，导入会覆盖成这一份。继续？`, { danger: true }))) return;
      const saved = await invoke<TaskPackDto>("install_task_pack_import", { token: preview.token, overwrite: same?.id ?? null });
      onInstalled(saved);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      size="lg"
      title={`导入我的任务：${pack.name || "（没名字）"}`}
      description="先看清这份任务会带进来什么，确认了再装。别人写的脚本会在工作副本里由 AI 运行，看不懂的先别装。"
      onClose={() => void discard()}
      footer={
        <>
          <button type="button" className={secondaryActionClass} disabled={busy} onClick={() => void discard()}>
            不装
          </button>
          <button type="button" className={primaryActionClass} disabled={busy || blocks.length > 0} onClick={() => void install()}>
            {busy ? "装进中…" : "装进我的任务"}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {error && <InlineNotice tone="err">{error}</InlineNotice>}
        <p className="text-xs text-l3">
          {pack.steps.length} 步：{pack.steps.map((s) => s.name).join(" → ")}
          {pack.description && <span className="block">{pack.description}</span>}
        </p>
        {pack.params.length > 0 && (
          <p className="text-xs text-l3">参数：{pack.params.map((p) => `${p.label}（默认 ${p.value || "空"}）`).join("、")}</p>
        )}
        {pack.trigger && <p className="text-xs text-l3">带触发：{triggerSummary(pack.trigger)}（加进项目时你勾选才建）</p>}
        {pack.basedOn && <p className="text-xs text-l3">基于内置模板「{pack.basedOn.templateName}」改的版本</p>}
        {blocks.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium text-err-text">拦下 {blocks.length} 条（装不进）</p>
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
        {preview.skills.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium text-l2">随包技能</p>
            <ul className="space-y-0.5 text-xs text-l3">
              {preview.skills.map((s) => (
                <li key={s.name}>
                  <span className="font-mono text-l2">{s.name}</span>：
                  <span className={s.status === "differs" ? "text-warn-text" : ""}>{SKILL_STATUS[s.status] ?? s.status}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {preview.files.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium text-l2">随包文件（{preview.files.length} 个，点开看全文）</p>
            <div className="flex flex-wrap gap-1">
              {preview.files.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  aria-pressed={f.path === openFile}
                  className={`rounded-sm border px-1.5 py-0.5 ${f.path === openFile ? "border-cta-bd text-l1" : "border-field text-l3"}`}
                  onClick={() => setOpenFile(f.path)}
                >
                  <span className="font-mono text-xs">{f.path.replace(/^skills\//, "")}</span>
                </button>
              ))}
            </div>
            {file && (
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-canvas p-3 font-mono text-micro leading-5 text-l2">
                {file.text ?? `（${file.size} 字节，不是文本或太大，这里不显示；不认识就别装）`}
              </pre>
            )}
          </div>
        )}
        {preview.ignored > 0 && <p className="text-xs text-l4">zip 里另有 {preview.ignored} 个文件不属于任务包，没解开。</p>}
      </div>
    </Modal>
  );
}
