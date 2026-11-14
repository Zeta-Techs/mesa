import { useState } from "react";
import { compactFieldClass, fieldClass } from "./PageFrame";
import { RESEARCH_TOOL_FIELDS, type ResearchToolField, type ResearchTools } from "../research-tools";

export default function ResearchToolFields({
  value, onChange, disabled = false, fields = RESEARCH_TOOL_FIELDS, collapsible = true, defaultOpen = false,
}: {
  value: ResearchTools; onChange: (next: ResearchTools) => void; disabled?: boolean;
  fields?: readonly ResearchToolField[]; collapsible?: boolean;
  /** 仅折叠态：已选过非默认交付时展开，避免把既有选择藏起来 */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (fields.length === 0) return null;
  const selects = fields.map((field) =>
    <label key={field.key} className="block">
      <span className={collapsible ? "text-l3" : "mb-1 block text-xs text-l2"}>{field.label}</span>
      <select disabled={disabled} value={value[field.key]} onChange={(e) => onChange({ ...value, [field.key]: e.target.value })} className={collapsible ? `mt-1 w-full ${compactFieldClass}` : fieldClass}>
        {field.options.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
    </label>);
  if (!collapsible) return <>{selects}</>;
  const hasManuscript = fields.some((field) => field.key === "manuscript");
  return <details className="rounded-xl ccode-well px-4 py-3 text-xs" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
    <summary className="cursor-pointer text-sm font-medium text-l2" title="文献从哪来在检索步骤选。Zotero 和 EndNote 都能导入、同步和交稿。">
      {hasManuscript ? "稿件载体与外部工具（按需选择）" : "按需补齐交付"}
    </summary>
    <p className="my-2 leading-5 text-l3">文献库选 Zotero 或 EndNote。导入和同步在检索步，交稿在定稿。两个都能做这三件事，一篇交稿只选一个。</p>
    <div className="grid gap-2.5 sm:grid-cols-2">{selects}</div>
  </details>;
}
