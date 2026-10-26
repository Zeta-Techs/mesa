import { useState } from "react";
import type { SkillFrontField } from "../skill-preview";

/** 收起时最多露几行；再多的收在「其余 N 项」里 */
const FOLD_AT = 6;

/**
 * Markdown 开头 YAML 头的阅读态小卡（md-render.splitMdFrontmatter 拆出来的字段）：
 * qmd 稿件的 title / author / format / bibliography、SKILL.md 的 name / description。
 * 只展示、不改文件；双击回到编辑态第 1 行（与正文双击段落跳源码行同一手势）。
 */
export default function MdFrontmatterCard({
  fields,
  className = "",
  onDoubleClick,
}: {
  fields: SkillFrontField[];
  className?: string;
  onDoubleClick?: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!fields.length) return null;
  const shown = open ? fields : fields.slice(0, FOLD_AT);
  const hidden = fields.length - shown.length;
  return (
    <div className={className}>
      <div
        className="rounded-md border border-hairline bg-inset px-3 py-2 text-xs"
        onDoubleClick={onDoubleClick}
        title={onDoubleClick ? "文档信息（YAML 头）；双击到编辑态改它" : "文档信息（YAML 头）"}
      >
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5">
          {shown.map((f, i) => (
            <div key={`${f.key}-${i}`} className="contents">
              <dt className="font-mono text-micro leading-5 text-l4">{f.key}</dt>
              <dd
                className={`min-w-0 break-words leading-5 ${
                  f.key === "title" ? "font-medium text-l1" : "text-l2"
                }`}
              >
                {f.value || <span className="text-l4">（多行内容，在编辑态看）</span>}
              </dd>
            </div>
          ))}
        </dl>
        {(hidden > 0 || open) && fields.length > FOLD_AT && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mt-1 text-micro text-l3 hover:text-l1"
          >
            {open ? "收起" : `其余 ${hidden} 项`}
          </button>
        )}
      </div>
    </div>
  );
}
