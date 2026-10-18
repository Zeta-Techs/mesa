import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { SESSION_TEMPLATE_VARS } from "../project-context";
import {
  SECTION_KEYS,
  coerceSimpleTemplate,
  parseSimpleTemplate,
  sectionSummary,
  serializeSimpleTemplate,
  type SectionKey,
  type SimpleTemplate,
} from "../session-template-blocks";
import { confirmDialog } from "./ConfirmDialog";

const HINT = Object.fromEntries(
  SESSION_TEMPLATE_VARS.map((item) => [item.token.slice(2, -2), item.hint]),
);

/** 对话注入「自定义」编辑器：勾选带哪些项目信息 + 补充一段话（2026-10-17 用户三轮拍板）。
 *  前两版——整份 `{{占位符}}` 原文、可排序的段落清单——都要人记名字或摆顺序；
 *  日常要的只是「带不带这段」和「再交代几句」。顺序固定为标准顺序，补充放最后；
 *  逐字控制版式走外层「编辑源文本」。手工改成勾选放不下的版式时，明说并给两条出路。 */
export default function SessionTemplateEditor({
  value,
  values,
  onChange,
  onEditSource,
}: {
  /** 模板文本（单一事实源在外层面板） */
  value: string;
  /** 每个占位符在这个项目下此刻的内容；null = 还在读 */
  values: Record<string, string> | null;
  /** commit = 勾选变化或补充失焦，外层据此保存；false 只同步草稿与预览 */
  onChange: (template: string, commit: boolean) => void;
  /** 手工版式放不进勾选时的另一条路：切到源文本 */
  onEditSource: () => void;
}) {
  const parsed = parseSimpleTemplate(value);
  // 补充框自己持有原文：拼回模板会裁首尾空白，打字时不能被回流的文本改掉光标后的空格
  const [extraDraft, setExtraDraft] = useState(parsed?.extra ?? "");
  const emitted = useRef(value);
  useEffect(() => {
    if (value === emitted.current) return;
    emitted.current = value;
    setExtraDraft(parseSimpleTemplate(value)?.extra ?? "");
  }, [value]);
  const extraRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = extraRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 52), 240)}px`;
  }, [extraDraft, parsed === null]);

  function emit(next: SimpleTemplate, commit: boolean) {
    const text = serializeSimpleTemplate(next);
    emitted.current = text;
    onChange(text, commit);
  }

  if (!parsed) {
    return (
      <div className="rounded-md ccode-well px-2.5 py-2">
        <p className="leading-5 text-l2">
          现在的模板是手工改过的版式（段落顺序调整过，或文字夹在中间），用勾选改不了。
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-micro">
          <button
            type="button"
            className="rounded-sm border border-field px-1.5 py-0.5 text-l2 hover:bg-hover hover:text-l1"
            onClick={onEditSource}
          >
            编辑源文本
          </button>
          <button
            type="button"
            className="rounded-sm px-1.5 py-0.5 text-l3 hover:bg-hover hover:text-l1"
            title="项目信息按固定顺序排列，其余文字按原次序并进「我的补充」，不会丢字"
            onClick={async () => {
              const ok = await confirmDialog(
                "改用勾选：项目信息按固定顺序排列，其余文字并进「我的补充」，不会丢字。继续？",
                { confirmText: "改用勾选" },
              );
              if (!ok) return;
              const next = coerceSimpleTemplate(value);
              setExtraDraft(next.extra);
              emit(next, true);
            }}
          >
            改用勾选
          </button>
        </div>
      </div>
    );
  }

  const current: SimpleTemplate = { ...parsed, extra: extraDraft };
  const chips: { id: "basics" | SectionKey; label: string; on: boolean; title: string; empty: boolean }[] = [
    {
      id: "basics",
      label: "项目基本信息",
      on: parsed.basics,
      title: "项目名、工作方式、项目目录",
      empty: false,
    },
    ...SECTION_KEYS.map((key) => {
      const summary = values ? sectionSummary(values[key], key) : null;
      return {
        id: key,
        label: key,
        on: parsed.sections.includes(key),
        title: summary ? `${HINT[key]}\n现在：${summary.text}` : HINT[key] ?? key,
        empty: summary?.empty ?? false,
      };
    }),
  ];

  function toggle(id: "basics" | SectionKey) {
    if (id === "basics") {
      emit({ ...current, basics: !current.basics }, true);
      return;
    }
    const sections = current.sections.includes(id)
      ? current.sections.filter((key) => key !== id)
      : [...current.sections, id];
    emit({ ...current, sections }, true);
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="mb-1.5 text-micro text-l4">带上哪些项目信息</p>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="带上哪些项目信息">
          {chips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              aria-pressed={chip.on}
              title={chip.title}
              onClick={() => toggle(chip.id)}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 transition-colors ${
                chip.on
                  ? "border-cta-bd bg-cta-pill text-cta-pill-text"
                  : "border-field bg-transparent text-l4 hover:text-l2"
              }`}
            >
              {chip.on && <Check size={11} strokeWidth={2.2} aria-hidden="true" />}
              {chip.label}
              {chip.on && chip.empty && <span className="text-micro opacity-70">（空）</span>}
            </button>
          ))}
        </div>
      </div>
      <label className="block">
        <span className="mb-1.5 block text-micro text-l4">我的补充（放在说明末尾）</span>
        <textarea
          ref={extraRef}
          value={extraDraft}
          onChange={(event) => {
            setExtraDraft(event.target.value);
            emit({ ...parsed, extra: event.target.value }, false);
          }}
          onBlur={() => emit({ ...parsed, extra: extraDraft }, true)}
          placeholder="例如：回答用中文；改代码前先列出计划。不写也行。"
          aria-label="我的补充"
          className="block w-full resize-none overflow-y-auto rounded-lg border border-field bg-strip px-2 py-1.5 leading-5 text-l1 outline-none placeholder:text-l4 focus:border-l4"
        />
      </label>
    </div>
  );
}
