import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirmDialog } from "./ConfirmDialog";
import { compactFieldClass, compactPrimaryActionClass, inlineActionClass } from "./PageFrame";
import { mergeStepParams, nextParamKey, PARAM_KIND_LABEL, paramValueProblem, parameterize } from "../task-packs";
import { issueLine, splitIssues } from "../task-pack-author";
import type { PackIssueDto, ProjectStepDto, StepParamDto, TaskPackDto } from "../types";

/**
 * 另存为我的任务（任务包第一期，2026-11-03）：选这条流程里的一步或几步，把每次会变的值（期刊名、阈值、数据目录）改成参数，
 * 存进「我的任务」库；步骤挂的用户技能由后端一并快照进包。加进别的项目时在流程编辑器「＋ 从模板追加 → 我的任务」里按参数填表。
 */
export default function SavePackForm({
  steps,
  onSaved,
  onCancel,
}: {
  steps: ProjectStepDto[];
  onSaved: (message: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [picked, setPicked] = useState<Set<number>>(() => new Set(steps.map((_, i) => i)));
  // 已经来自某个包的步骤：它的参数原样带进来（简报里已是 {param:键}）；几个包同键不同义的换新键（mergeStepParams）
  const merged = useMemo(() => mergeStepParams(steps), [steps]);
  const [params, setParams] = useState<StepParamDto[]>(() => merged.params.map((p) => ({ ...p })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = useMemo(() => merged.steps.filter((_, i) => picked.has(i)), [merged, picked]);
  const preview = useMemo(() => parameterize(chosen, params), [chosen, params]);

  function setParam(index: number, patch: Partial<StepParamDto>) {
    setParams((list) => list.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || chosen.length === 0) return;
    const usable = params.filter((p) => p.label.trim() && p.value.trim());
    // 原文就是默认值：选了数字 / 是否 / 文件夹 / 文件的，默认值得合这个类型，不然存进去会被清空
    const wrong = usable.find((p) => paramValueProblem(p.kind, p.value));
    if (wrong) {
      setError(`参数「${wrong.label.trim()}」的原文「${wrong.value.trim()}」${paramValueProblem(wrong.kind, wrong.value)}；换个类型，或改成文字`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const existing = await invoke<TaskPackDto[]>("list_task_packs").catch(() => [] as TaskPackDto[]);
      const same = existing.find((p) => p.name === trimmed);
      if (same && !(await confirmDialog(`已有同名的我的任务「${trimmed}」，保存会覆盖成新版本。继续？`, { danger: true }))) return;
      const { steps: packSteps } = parameterize(chosen, usable);
      // 机器检查（第二期）：拦下的不存；提醒列给人看，问要不要照存
      const issues = await invoke<PackIssueDto[]>("check_task_pack", {
        name: trimmed,
        params: usable,
        steps: packSteps,
      });
      const { blocks, warns } = splitIssues(issues);
      if (blocks.length > 0) {
        setError(`先改这些再存：${blocks.map(issueLine).join("；")}`);
        return;
      }
      if (
        warns.length > 0 &&
        !(await confirmDialog(`检查有 ${warns.length} 条提醒：\n${warns.map((w) => `· ${issueLine(w)}`).join("\n")}\n\n仍然存吗？`, {
          confirmText: "照存",
        }))
      )
        return;
      const saved = await invoke<TaskPackDto>("save_task_pack", {
        id: same?.id ?? null,
        name: trimmed,
        description,
        params: usable.map((p) => ({ ...p, label: p.label.trim(), value: p.value.trim() })),
        steps: packSteps,
      });
      onSaved(
        `已存进「我的任务」：${saved.name}（${saved.steps.length} 步${saved.params.length ? `、${saved.params.length} 个参数` : ""}${
          saved.skills.length ? `，带上技能 ${saved.skills.join("、")}` : ""
        }）。在别的项目的流程编辑器里点「＋ 从模板追加」就能加进来。`,
      );
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="ccode-well mb-2 space-y-2 rounded-lg p-3 text-xs">
      <p className="text-l3">
        把这条流程里调顺的一步或几步存成「我的任务」，以后在别的项目里直接加进来。每次会变的值（期刊名、阈值、数据目录）改成参数，加进来时再填。
      </p>
      <div className="flex flex-wrap gap-1">
        <input
          className={compactFieldClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="任务名，如 单细胞数据质控"
          autoFocus
          required
        />
        <input
          className={`${compactFieldClass} min-w-0 flex-1`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="说明（可选）：解决什么、产出什么"
        />
      </div>
      <fieldset>
        <legend className="mb-1 text-l3">存哪几步</legend>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {steps.map((s, i) => (
            <label key={`${s.name}-${i}`} className="inline-flex items-center gap-1 text-l2">
              <input
                type="checkbox"
                checked={picked.has(i)}
                onChange={(e) =>
                  setPicked((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(i);
                    else next.delete(i);
                    return next;
                  })
                }
              />
              {s.name}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-1 text-l3">参数（可选）：左边写参数名，右边写它在简报里的原文</legend>
        {params.map((p, i) => (
          <div key={p.key} className="mb-1 flex items-center gap-1">
            <input
              className={`${compactFieldClass} w-36`}
              value={p.label}
              onChange={(e) => setParam(i, { label: e.target.value })}
              placeholder="参数名，如 目标期刊"
            />
            <input
              className={`${compactFieldClass} min-w-0 flex-1`}
              value={p.value}
              onChange={(e) => setParam(i, { value: e.target.value })}
              placeholder="简报里的原文，如 Nature"
            />
            <select
              className={`${compactFieldClass} w-20 shrink-0`}
              value={p.kind ?? ""}
              aria-label="参数类型"
              title="加进项目时给什么样的填写框；文件夹 / 文件只收项目里的相对路径"
              onChange={(e) => setParam(i, { kind: e.target.value })}
            >
              {Object.entries(PARAM_KIND_LABEL).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
            <span
              className={`w-20 shrink-0 ${p.value.trim() && !preview.hits[p.key] && !(chosen.some((s) => (s.params ?? []).some((x) => x.key === p.key))) ? "text-warn-text" : "text-l4"}`}
            >
              {p.value.trim() ? `命中 ${preview.hits[p.key] ?? 0} 处` : ""}
            </span>
            <button
              type="button"
              className={inlineActionClass}
              aria-label={`删除参数 ${p.label || i + 1}`}
              onClick={() => setParams((list) => list.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className={inlineActionClass}
          onClick={() =>
            setParams((list) => [...list, { key: nextParamKey(list), label: "", value: "", help: "", options: [] }])
          }
        >
          ＋ 加参数
        </button>
      </fieldset>
      {error && <p className="text-err-text">{error}</p>}
      <div className="flex justify-end gap-1">
        <button type="button" className={inlineActionClass} onClick={onCancel}>
          取消
        </button>
        <button type="submit" className={compactPrimaryActionClass} disabled={busy || chosen.length === 0 || !name.trim()}>
          {busy ? "保存中…" : "存进我的任务"}
        </button>
      </div>
    </form>
  );
}
