import { paramValueProblem } from "../task-packs";
import type { StepParamDto } from "../types";

/**
 * 任务包参数的一格（2026-11-04 补齐类型）：按类型给控件——下拉 / 数字 / 是否 / 项目内文件夹或文件（相对路径），
 * 填得不合规就地写一句（拼任务书时当没填，任务书写明缺这一项）。流程编辑器两处与「另存为我的任务」共用。
 */
export default function PackParamInput({
  param,
  value,
  onChange,
  fieldClass,
  allowUnlisted = false,
}: {
  param: StepParamDto;
  value: string;
  onChange: (value: string) => void;
  fieldClass: string;
  /** 下拉时，当前值不在选项里也列出来（编辑器里改旧值用） */
  allowUnlisted?: boolean;
}) {
  const kind = param.kind ?? "";
  const problem = paramValueProblem(kind, value);
  let control;
  if (!kind && param.options.length > 0) {
    control = (
      <select className={`${fieldClass} w-full`} value={value} onChange={(e) => onChange(e.target.value)}>
        {allowUnlisted && !param.options.includes(value) && <option value={value}>{value || "（未填）"}</option>}
        {param.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  } else if (kind === "bool") {
    control = (
      <select className={`${fieldClass} w-full`} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">（未填）</option>
        <option value="是">是</option>
        <option value="否">否</option>
      </select>
    );
  } else {
    control = (
      <input
        className={`${fieldClass} w-full`}
        type={kind === "number" ? "number" : "text"}
        inputMode={kind === "number" ? "decimal" : undefined}
        value={value}
        placeholder={
          kind === "path" ? "项目里的文件夹，如 data/raw" : kind === "file" ? "项目里的文件，如 data/meta.csv" : "未填时任务书会写明缺这一项"
        }
        aria-invalid={problem ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <>
      {control}
      {problem && <span className="mt-0.5 block text-micro text-err-text">{problem}</span>}
    </>
  );
}
