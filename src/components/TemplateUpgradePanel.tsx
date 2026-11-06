import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Checkbox, compactFieldClass, secondaryActionClass } from "./PageFrame";
import { confirmDialog } from "./ConfirmDialog";
import { PIPELINE_TEMPLATES } from "../pipeline-presets";
import {
  describeUpgradeField,
  normalizedTemplate,
  pipelineUpgradeCandidates,
  UPGRADE_FIELD_LABELS,
  type UpgradeFieldDiff,
} from "../pipeline-upgrade";
import type { ProjectStepDto } from "../types";

/**
 * 研究流程编辑器里的「内置模板更新」（综述回路三期 §13-6：提示升级，人点了才改）。
 * 2026-11-06 用户看了这块「整个 UI」后重做：中文字段名、按字段列「原来 → 新版」与简报改了的行，代替两栏 JSON；
 * 勾选 → 「换成新版」只改编辑中的草稿，保存才写进项目。比较口径与项目页提示同一个（pipeline-upgrade.ts）。
 */
export default function TemplateUpgradePanel({
  steps,
  normalize,
  initialTemplate,
  onLoad,
}: {
  /** 编辑中的草稿，按保存口径收成步骤 */
  steps: ProjectStepDto[];
  /** 模板步骤按本项目研究工具换算（编辑器保存前同一道） */
  normalize: (step: ProjectStepDto) => ProjectStepDto;
  /** 从项目页「去看看」进来时预选的模板 */
  initialTemplate?: string;
  /** 把勾选的步骤换成模板新版（index 为草稿下标） */
  onLoad: (picked: { index: number; step: ProjectStepDto }[]) => void;
}) {
  const [templateId, setTemplateId] = useState(initialTemplate ?? "");
  const [selected, setSelected] = useState<number[]>([]);
  const [expanded, setExpanded] = useState<number[]>([]);
  const [loaded, setLoaded] = useState<string[]>([]);
  const changes = useMemo(() => {
    const raw = PIPELINE_TEMPLATES.find((t) => t.id === templateId);
    return raw ? pipelineUpgradeCandidates(steps, normalizedTemplate(raw, normalize)) : null;
  }, [templateId, steps, normalize]);
  const picked = (changes ?? []).filter((c) => selected.includes(c.index));
  const allPicked = !!changes?.length && picked.length === changes.length;

  async function load() {
    if (picked.length === 0) return;
    const ok = await confirmDialog(
      `把勾选的 ${picked.length} 步换成新版？\n\n这几步里你自己改过的简报、验收条件等会被新版盖掉；资源绑定保留。只改编辑中的草稿，点「保存」前还能取消。`,
      { confirmText: "换成新版" },
    );
    if (!ok) return;
    onLoad(picked.map((c) => ({ index: c.index, step: c.template })));
    setLoaded(picked.map((c) => c.current.name));
    setSelected([]);
  }

  return (
    <details open={initialTemplate ? true : undefined} className="rounded-md ccode-well p-3 text-xs">
      <summary className="cursor-pointer text-sm text-l2">
        内置模板更新
        {changes && changes.length > 0 && <span className="ml-2 text-xs text-l3">{changes.length} 步可以换成新版</span>}
      </summary>
      <p className="mt-2 text-l3">
        只比名称和工作区都一样的步骤。换成新版只改这一步的设定，资源绑定保留；已经写出来的文件、已开工那一轮的任务书都不动。
      </p>
      <label className="mt-2 flex items-center gap-2">
        <span className="shrink-0 text-l3">对照模板</span>
        <select
          className={compactFieldClass}
          value={templateId}
          onChange={(e) => {
            setTemplateId(e.target.value);
            setSelected([]);
            setExpanded([]);
            setLoaded([]);
          }}
        >
          <option value="">选择这个项目用的模板</option>
          {PIPELINE_TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>

      {loaded.length > 0 && (
        <p className="mt-2 text-ok-text">
          已换进草稿：{loaded.join("、")}。点右上角「保存」才写进项目，不想要就点「取消」。
        </p>
      )}
      {changes && changes.length === 0 && loaded.length === 0 && (
        <p className="mt-2 text-l3">和模板一致，没有要换的。改过名的步骤对不上模板，需要自己对照。</p>
      )}
      {changes && changes.length > 0 && (
        <>
          <div className="mt-3 flex items-center border-b border-hairline pb-1.5">
            <Checkbox
              checked={allPicked}
              onChange={(on) => setSelected(on ? changes.map((c) => c.index) : [])}
              label={<span className="text-l3">全选</span>}
            />
          </div>
          <ul>
            {changes.map((c) => {
              const open = expanded.includes(c.index);
              return (
                <li key={c.index} className="border-b border-hairline py-1.5 last:border-b-0">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={selected.includes(c.index)}
                      onChange={(on) =>
                        setSelected((old) => (on ? [...old, c.index] : old.filter((i) => i !== c.index)))
                      }
                      label={<span className="text-l1">{c.current.name}</span>}
                    />
                    <span className="min-w-0 flex-1 truncate text-l3">
                      改了 {c.fields.map((f) => UPGRADE_FIELD_LABELS[f]).join("、")}
                    </span>
                    <button
                      type="button"
                      className="flex shrink-0 items-center gap-0.5 text-l3 hover:text-l1"
                      aria-expanded={open}
                      onClick={() =>
                        setExpanded((old) => (open ? old.filter((i) => i !== c.index) : [...old, c.index]))
                      }
                    >
                      <ChevronRight size={12} className={open ? "rotate-90" : ""} />
                      {open ? "收起" : "看差异"}
                    </button>
                  </div>
                  {open && (
                    <div className="mt-1.5 space-y-2 pl-6">
                      {c.fields.map((f) => (
                        <FieldDiff key={f} diff={describeUpgradeField(f, c.current, c.proposed)} />
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="mt-2 flex items-center gap-2">
            <button type="button" className={secondaryActionClass} disabled={picked.length === 0} onClick={() => void load()}>
              把勾选的 {picked.length || ""} 步换成新版
            </button>
            <span className="text-l4">换进草稿后点「保存」才生效</span>
          </div>
        </>
      )}
    </details>
  );
}

function FieldDiff({ diff }: { diff: UpgradeFieldDiff }) {
  return (
    <div>
      <p className="mb-0.5 text-l3">{diff.label}</p>
      {diff.kind === "value" && (
        <p className="leading-relaxed">
          <span className="text-l4 line-through">{diff.before}</span>
          <span className="mx-1.5 text-l4">→</span>
          <span className="text-l1">{diff.after}</span>
        </p>
      )}
      {diff.kind === "list" && (
        <ul className="space-y-0.5 leading-relaxed">
          {diff.removed.map((x) => (
            <li key={`-${x}`} className="text-del">
              − {x}
            </li>
          ))}
          {diff.added.map((x) => (
            <li key={`+${x}`} className="text-add">
              ＋ {x}
            </li>
          ))}
          {diff.changed.map((x) => (
            <li key={`~${x}`} className="text-l2">
              {x === "顺序调整" ? "顺序调整" : `改了说明：${x}`}
            </li>
          ))}
        </ul>
      )}
      {diff.kind === "text" && (
        <div className="max-h-72 space-y-0.5 overflow-auto rounded-sm bg-canvas p-2 leading-relaxed">
          {diff.lines.map((l, k) =>
            l.kind === "gap" ? (
              <p key={k} className="text-l4">
                ⋯
              </p>
            ) : (
              <p
                key={k}
                className={`whitespace-pre-wrap ${l.kind === "del" ? "text-del line-through" : l.kind === "add" ? "text-add" : "text-l3"}`}
              >
                {l.kind === "del" ? "− " : l.kind === "add" ? "＋ " : ""}
                {l.text || " "}
              </p>
            ),
          )}
        </div>
      )}
    </div>
  );
}
