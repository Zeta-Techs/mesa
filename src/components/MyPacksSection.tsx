import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { confirmDialog } from "./ConfirmDialog";
import ImportPackDialog from "./ImportPackDialog";
import { compactPrimaryActionClass, inlineActionClass } from "./PageFrame";
import { builtinKey, builtinUpdate, fieldLabel, mergeBuiltinUpdate, rebased, type BuiltinUpdate } from "../pack-builtin";
import type { PackImportPreviewDto, ProjectStepDto, TaskPackDto } from "../types";

/** 把一步里变了的字段摊成可读文字（并排看旧版 → 新版用） */
function fieldsText(step: ProjectStepDto | undefined, fields: string[]): string {
  if (!step) return "（没有这一步）";
  return fields
    .map((f) => {
      const v = step[f as keyof ProjectStepDto];
      const body = typeof v === "string" ? v : JSON.stringify(v ?? null, null, 2);
      return `【${fieldLabel(f)}】\n${body}`;
    })
    .join("\n\n");
}

/**
 * 模板库里的「我的任务」一栏（任务包第四期）：使用（整条流程用它）、导出 zip、删除、导入 zip；
 * 内置另存的「我的版本」在内置升级后标「内置有更新」，展开逐步看旧版 → 新版，勾选要换成新版的步骤。
 */
export default function MyPacksSection({
  packs,
  currents,
  reload,
  applying,
  onApplyPack,
  onError,
  onNotice,
}: {
  packs: TaskPackDto[];
  /** 现在的内置步骤（经后端归一），按 builtinKey */
  currents: Record<string, ProjectStepDto[]>;
  reload: () => Promise<void>;
  applying: boolean;
  onApplyPack: (pack: TaskPackDto) => void;
  onError: (msg: string) => void;
  onNotice: (msg: string) => void;
}) {
  const [importing, setImporting] = useState<PackImportPreviewDto | null>(null);
  const [updateOpen, setUpdateOpen] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  async function pickImport() {
    try {
      const path = await open({ multiple: false, filters: [{ name: "ZIP", extensions: ["zip"] }] });
      if (!path || Array.isArray(path)) return;
      setImporting(await invoke<PackImportPreviewDto>("preview_task_pack_import", { zipPath: path }));
    } catch (reason) {
      onError(String(reason));
    }
  }

  async function exportPack(p: TaskPackDto) {
    try {
      const dest = await save({ defaultPath: `${p.name}.zip`, filters: [{ name: "ZIP", extensions: ["zip"] }] });
      if (!dest) return;
      await invoke("export_task_pack", { id: p.id, destPath: dest });
      onNotice(`已导出「${p.name}」：${dest}。对方在模板库「我的任务 → 导入」里选这个 zip，看过内容再装。`);
    } catch (reason) {
      onError(String(reason));
    }
  }

  async function removePack(p: TaskPackDto) {
    if (!(await confirmDialog(`删除我的任务「${p.name}」？会移到回收站；已经用它建的流程不受影响。`, { danger: true, confirmText: "删除" }))) return;
    try {
      await invoke("delete_task_pack", { id: p.id });
      await reload();
    } catch (reason) {
      onError(String(reason));
    }
  }

  /** 保留我的 / 按勾选更新：都把对照点挪到现在的内置，这一版不再提示 */
  async function applyUpdate(p: TaskPackDto, update: BuiltinUpdate, choose: Set<string>) {
    if (!p.basedOn) return;
    setBusy(true);
    try {
      await invoke<TaskPackDto>("save_task_pack", {
        id: p.id,
        name: p.name,
        description: p.description,
        params: p.params,
        steps: mergeBuiltinUpdate(p.steps, update, choose),
        basedOn: rebased(p.basedOn, update.current),
      });
      setUpdateOpen(null);
      onNotice(choose.size > 0 ? `「${p.name}」已换上新版的 ${choose.size} 步，其余保留你的。` : `「${p.name}」保留你的版本，这次内置更新不再提示。`);
      await reload();
    } catch (reason) {
      onError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  function renderUpdate(p: TaskPackDto, update: BuiltinUpdate) {
    return (
      <div className="mt-2 space-y-2 rounded-sm bg-canvas p-2 text-xs">
        <p className="text-l3">
          内置「{update.templateName}」更新了 {update.changes.length} 处。勾上的换成内置新版，不勾的保留你的；一个都不勾就是保留你的版本。已经用它建好的流程不受影响。
        </p>
        {update.changes.map((c) => (
          <details key={`${c.kind}-${c.name}`} className="rounded-sm ccode-well p-2">
            <summary className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={picked.has(c.name)}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) =>
                  setPicked((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(c.name);
                    else next.delete(c.name);
                    return next;
                  })
                }
              />
              <span className="text-l1">{c.name}</span>
              <span className="text-l3">
                {c.kind === "added"
                  ? "内置新加的一步（勾上加进来）"
                  : c.kind === "removed"
                    ? "内置去掉了这一步（勾上也从你的版本里去掉）"
                    : `改了 ${c.fields.map(fieldLabel).join("、")}`}
              </span>
              {c.mineEdited && c.kind !== "added" && <span className="text-warn-text">你改过这一步</span>}
            </summary>
            {c.kind === "changed" && (
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div>
                  <p className="mb-1 text-l4">内置旧版</p>
                  <pre className="max-h-56 overflow-auto whitespace-pre-wrap font-mono text-micro text-l2">{fieldsText(c.old, c.fields)}</pre>
                </div>
                <div>
                  <p className="mb-1 text-l4">内置新版</p>
                  <pre className="max-h-56 overflow-auto whitespace-pre-wrap font-mono text-micro text-l2">{fieldsText(c.next, c.fields)}</pre>
                </div>
                {c.mineEdited && c.mine && (
                  <div className="col-span-2">
                    <p className="mb-1 text-l4">你的版本（勾上会被新版替换）</p>
                    <pre className="max-h-56 overflow-auto whitespace-pre-wrap font-mono text-micro text-l2">{fieldsText(c.mine, c.fields)}</pre>
                  </div>
                )}
              </div>
            )}
          </details>
        ))}
        <div className="flex justify-end gap-1">
          <button type="button" className={inlineActionClass} disabled={busy} onClick={() => void applyUpdate(p, update, new Set())}>
            保留我的
          </button>
          <button type="button" className={compactPrimaryActionClass} disabled={busy || picked.size === 0} onClick={() => void applyUpdate(p, update, picked)}>
            按勾选更新
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 text-xs">
      <div className="mb-1 flex items-center gap-2">
        <p className="text-xs text-l3">我的任务</p>
        <button type="button" className={`${inlineActionClass} ml-auto`} onClick={() => void pickImport()} title="选别人导出的 zip，先看清内容再装">
          导入…
        </button>
      </div>
      {packs.length === 0 && (
        <p className="text-xs text-l4">还没有。内置模板点「另存为我的版本」，或在项目设置里「另存为我的任务」「跟 AI 写我的任务」。</p>
      )}
      <ul className="space-y-1.5">
        {packs.map((p) => {
          const update = p.basedOn ? builtinUpdate(p, currents[builtinKey(p.basedOn)]) : null;
          return (
            <li key={p.id} className="rounded-sm ccode-well p-2">
              <div className="flex items-center gap-2">
                <span className="min-w-0 truncate text-xs font-medium text-l1">{p.name}</span>
                <span className="shrink-0 rounded-sm bg-strip px-1.5 py-0.5 text-xs text-l3">
                  {p.steps.length} 步{p.params.length > 0 ? ` · ${p.params.length} 个参数` : ""}
                </span>
                {p.imported && (
                  <span className="shrink-0 rounded-sm bg-strip px-1.5 py-0.5 text-xs text-l3" title="从别人的 zip 导入；第一次加进项目前会再问一次">
                    导入
                  </span>
                )}
                {update && (
                  <button
                    type="button"
                    className="shrink-0 rounded-sm bg-strip px-1.5 py-0.5 text-xs text-warn-text"
                    onClick={() => {
                      setPicked(new Set());
                      setUpdateOpen((cur) => (cur === p.id ? null : p.id));
                    }}
                  >
                    内置有更新
                  </button>
                )}
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  <button type="button" className={inlineActionClass} onClick={() => void exportPack(p)}>
                    导出
                  </button>
                  <button type="button" className={inlineActionClass} onClick={() => void removePack(p)}>
                    删除
                  </button>
                  <button type="button" className={compactPrimaryActionClass} disabled={applying} onClick={() => onApplyPack(p)}>
                    {applying ? "写入中…" : "使用"}
                  </button>
                </div>
              </div>
              <p className="mt-1 truncate text-xs text-l4" title={p.steps.map((s) => s.name).join(" → ")}>
                {p.basedOn ? `基于内置「${p.basedOn.templateName}」 · ` : ""}
                {p.description || p.steps.map((s) => s.name).join(" → ")}
              </p>
              {update && updateOpen === p.id && renderUpdate(p, update)}
            </li>
          );
        })}
      </ul>
      {importing && (
        <ImportPackDialog
          preview={importing}
          onClose={() => setImporting(null)}
          onInstalled={(saved) => {
            setImporting(null);
            onNotice(`已装进我的任务：${saved.name}。点「使用」或在流程编辑器「＋ 从模板追加」里加进来。`);
            void reload();
          }}
        />
      )}
    </div>
  );
}
