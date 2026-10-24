import { useState } from "react";
import { Check, CircleHelp, CornerDownLeft, PanelBottomOpen, PenLine, SquareTerminal } from "lucide-react";
import type { DecisionPreview } from "../chat-channel";
import type { AskAction, AskQuestion, AskReview, ClaudeAsk } from "../tui-ask";
import { DiffView, OutputView } from "./ConversationView";

export interface DecisionOption {
  label: string;
  /** primary = 推荐 / CLI 当前高亮那项（实心）；其余描边 */
  primary?: boolean;
  title?: string;
  onClick: () => void;
}

export interface ChatDecision {
  /** 稳定键：换了一个问题才重新滚到底 */
  key: string;
  title: string;
  detail?: string | null;
  hint?: string | null;
  /** 要你批准的是什么：命令原文 / 要改的差异 / 参数（结构化旁路给的，chat-channel.ts approvalPreview） */
  preview?: DecisionPreview | null;
  options: DecisionOption[];
  /** Claude 的提问表单（tui-ask.ts）：有它时照表单画——选项竖排带说明、能自己写答案、多选打勾，不用 options */
  ask?: {
    form: ClaudeAsk;
    /** 刚点过、终端还没换到新画面：按钮先停用，免得按键从旧光标位置算 */
    pending: boolean;
    onAction: (action: AskAction) => void;
  } | null;
}

/**
 * 「等你决定」卡片（docs/design-chat-layer.md §5，2026-10-17 第一期）：信任目录、切换 / 启动警告的确认菜单、
 * 工具审批三种原先是对话流上方的横条，眼睛要从底部输入框跳到顶部；现在合成一张卡，贴在对话流最末尾、
 * 紧挨输入框（Claude / Codex 客户端同做法）。只摆 CLI 自己给的选项，不替用户选；右侧总有「打开终端」兜底。
 */
export default function ChatDecisionCard({
  decision,
  onOpenTerminal,
  onPeek,
}: {
  decision: ChatDecision;
  onOpenTerminal: () => void;
  /** 露出下方终端（选项更多 / 按键无效时） */
  onPeek?: () => void;
}) {
  if (decision.ask) {
    return (
      <AskCard
        form={decision.ask.form}
        pending={decision.ask.pending}
        onAction={decision.ask.onAction}
        onOpenTerminal={onOpenTerminal}
        onPeek={onPeek}
      />
    );
  }
  return (
    <div
      role="group"
      aria-label={decision.title}
      className="mb-3 rounded-xl border border-field bg-raised px-3.5 py-3"
    >
      <div className="flex items-start gap-2">
        {/* 壳取标题的字号，图标对准标题那一行 */}
        <span className="ccode-icon-line text-sm">
          <CircleHelp size={15} strokeWidth={1.8} aria-hidden="true" className="text-warn-text" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="break-words text-sm text-l1">{decision.title}</div>
          {decision.detail && (
            <div className="mt-0.5 break-words text-xs leading-5 text-l3">{decision.detail}</div>
          )}
          {decision.hint && (
            <div className="mt-0.5 break-words text-micro leading-4 text-l4">{decision.hint}</div>
          )}
        </div>
      </div>
      {decision.preview && (
        <div className="mt-2 pl-[1.4rem]">
          {decision.preview.kind === "diff" ? (
            <DiffView lines={decision.preview.lines} />
          ) : (
            <OutputView
              command={decision.preview.kind === "command" ? decision.preview.text : null}
              text={decision.preview.kind === "text" ? decision.preview.text : undefined}
            />
          )}
        </div>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pl-[1.4rem]">
        {decision.options.map((opt, i) => (
          <button
            key={`${i}-${opt.label}`}
            type="button"
            onClick={opt.onClick}
            title={opt.title}
            className={`h-7 max-w-[22rem] truncate rounded-md px-3 text-xs transition-colors ${
              opt.primary
                ? "bg-seg-sel text-l1 hover:bg-hover"
                : "border border-hairline text-l2 hover:bg-hover hover:text-l1"
            }`}
          >
            {opt.label}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-1">
          {onPeek && (
            <button
              type="button"
              onClick={onPeek}
              className="h-7 rounded-md px-2 text-xs text-l3 hover:bg-hover hover:text-l1"
            >
              露出终端
            </button>
          )}
          <button
            type="button"
            onClick={onOpenTerminal}
            title="选项更多或按键无效时，去终端里直接操作"
            className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-l3 hover:bg-hover hover:text-l1"
          >
            <SquareTerminal size={13} strokeWidth={1.8} aria-hidden="true" />
            打开终端
          </button>
        </span>
      </div>
    </div>
  );
}

/**
 * Claude 提问表单（2026-10-22 用户：提问卡片的 UI 可以优化）。原先套通用菜单卡：选项名和说明挤成一个按钮（「红 选择红色」）、
 * 题签「☐ 颜色」当说明、「Type something.」当按钮（点了是空着回车）、底下一句「高亮的是终端当前默认的那一项」。
 * 现在照 Claude 客户端的样子：题签在上，问句加粗，选项竖排（序号 / 勾选框 + 名字 + 灰字说明），最后一行直接写自己的答案；
 * 多题时题签可点着切，答完到确认页列出每题的答案。终端光标停在哪项不画——那不是推荐，只是光标。
 */
function AskCard({
  form,
  pending,
  onAction,
  onOpenTerminal,
  onPeek,
}: {
  form: ClaudeAsk;
  pending: boolean;
  onAction: (action: AskAction) => void;
  onOpenTerminal: () => void;
  onPeek?: () => void;
}) {
  const title = form.kind === "question" ? form.question : "确认提交这些回答？";
  return (
    <div
      role="group"
      aria-label={title}
      aria-busy={pending || undefined}
      className="mb-3 rounded-xl border border-field bg-raised"
    >
      <div className="flex items-center gap-2 px-3.5 pt-3">
        <CircleHelp size={15} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-warn-text" />
        <AskTabs form={form} pending={pending} onAction={onAction} />
        <span className="ml-auto flex shrink-0 items-center">
          {onPeek && (
            <button
              type="button"
              onClick={onPeek}
              title="露出终端"
              aria-label="露出终端"
              className="flex size-7 items-center justify-center rounded-md text-l4 hover:bg-hover hover:text-l1"
            >
              <PanelBottomOpen size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onClick={onOpenTerminal}
            title="打开终端：按键没反应或想看原样时，去终端里直接操作"
            aria-label="打开终端"
            className="flex size-7 items-center justify-center rounded-md text-l4 hover:bg-hover hover:text-l1"
          >
            <SquareTerminal size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </span>
      </div>
      <div className="break-words px-3.5 pt-1 text-sm font-medium leading-6 text-l1">{title}</div>
      {form.kind === "question" ? (
        <AskQuestionBody form={form} pending={pending} onAction={onAction} />
      ) : (
        <AskReviewBody form={form} pending={pending} onAction={onAction} />
      )}
    </div>
  );
}

/** 题签：一题时只写题签名；多题时每题一个可点的签（答过的带勾），最后是「提交」页 */
function AskTabs({ form, pending, onAction }: { form: ClaudeAsk; pending: boolean; onAction: (a: AskAction) => void }) {
  if (form.tabs.length < 2) {
    return <span className="min-w-0 truncate text-xs text-l3">{form.tabs[0]?.label}</span>;
  }
  const canSwitch = form.current !== null && !pending;
  const tab = (key: string, index: number, label: string, answered: boolean) => {
    const on = form.current === index;
    return (
      <button
        key={key}
        type="button"
        role="tab"
        aria-selected={on}
        disabled={!canSwitch || on}
        onClick={() => onAction({ kind: "tab", index })}
        className={`flex h-6 max-w-[10rem] items-center gap-1 rounded-md px-2 transition-colors ${
          on ? "bg-seg-sel text-l1" : "text-l3 enabled:hover:bg-hover enabled:hover:text-l1"
        }`}
      >
        {answered && <Check size={12} strokeWidth={2} aria-hidden="true" className="shrink-0" />}
        <span className="truncate text-xs">{label}</span>
      </button>
    );
  };
  return (
    <div role="tablist" aria-label="问题" className="flex min-w-0 flex-wrap items-center gap-0.5">
      {form.tabs.map((t, i) => tab(`${i}-${t.label}`, i, t.label, t.answered))}
      {tab("submit", form.tabs.length, "提交", false)}
    </div>
  );
}

function AskQuestionBody({
  form,
  pending,
  onAction,
}: {
  form: AskQuestion;
  pending: boolean;
  onAction: (a: AskAction) => void;
}) {
  const [draft, setDraft] = useState("");
  const multi = form.multiSelect;
  function sendDraft() {
    const text = draft.trim();
    if (!text || pending) return;
    onAction({ kind: "text", text });
    setDraft("");
  }
  return (
    <>
      {multi && <div className="px-3.5 text-xs text-l4">可以选多项，选好点「提交这一题」</div>}
      <div className="px-1.5 pb-1.5 pt-1.5">
        {form.options.map((opt, i) => (
          <button
            key={`${i}-${opt.label}`}
            type="button"
            disabled={pending}
            role={multi ? "checkbox" : undefined}
            aria-checked={multi ? Boolean(opt.checked) : undefined}
            onClick={() => onAction({ kind: "pick", index: i })}
            className="group flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left transition-colors enabled:hover:bg-hover disabled:opacity-60"
          >
            <OptionMark index={i} multi={multi} checked={Boolean(opt.checked)} />
            <span className="min-w-0 flex-1">
              <span className="block break-words text-sm leading-5 text-l1">{opt.label}</span>
              {opt.description && (
                <span className="mt-0.5 block break-words text-xs leading-5 text-l3">{opt.description}</span>
              )}
            </span>
          </button>
        ))}
        {/* 最后一项「自己写」：字写在终端那一行里，单选写完就交，多选写进去自动勾上 */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendDraft();
          }}
          className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-sm transition-colors focus-within:bg-hover"
        >
          {multi && form.freeText ? (
            <OptionMark index={form.options.length} multi checked={Boolean(form.freeChecked)} />
          ) : (
            <span className="flex size-5 shrink-0 items-center justify-center text-l4" aria-hidden="true">
              <PenLine size={13} strokeWidth={1.8} />
            </span>
          )}
          <input
            value={draft}
            disabled={pending}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="自己写答案"
            placeholder={
              form.freeText
                ? `已写「${form.freeText}」，再写会替换`
                : multi
                  ? "还有别的？写上会自动勾上"
                  : "都不合适？写你自己的答案"
            }
            className="h-7 min-w-0 flex-1 bg-transparent text-l1 outline-none placeholder:text-l4 disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={pending || !draft.trim()}
            title={multi ? "写进去并勾上" : "就答这个"}
            aria-label={multi ? "写进去并勾上" : "就答这个"}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-l3 transition-colors enabled:hover:bg-hover enabled:hover:text-l1 disabled:opacity-40"
          >
            <CornerDownLeft size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </form>
      </div>
      {/* 全站 button { font: inherit } 会吞掉按钮自己的 text-*：字号挂在这一栏上 */}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-hairline px-3.5 py-2 text-xs">
        {multi && form.rows.some((r) => r.kind === "submit") && (
          <button
            type="button"
            disabled={pending}
            onClick={() => onAction({ kind: "submit" })}
            className="h-7 rounded-md bg-seg-sel px-3 text-l1 transition-colors enabled:hover:bg-hover disabled:opacity-60"
          >
            提交这一题
          </button>
        )}
        {form.rows.some((r) => r.kind === "chat") && (
          <button
            type="button"
            disabled={pending}
            onClick={() => onAction({ kind: "chat" })}
            title="这几题先不答（终端里的「Chat about this」）：它会接着往下说，你再在输入框里聊"
            className="h-7 rounded-md px-2 text-l3 transition-colors enabled:hover:bg-hover enabled:hover:text-l1 disabled:opacity-60"
          >
            先不答，直接聊
          </button>
        )}
        <span className="ml-auto text-micro text-l4">也可以在下面的输入框里写答案</span>
      </div>
    </>
  );
}

function AskReviewBody({
  form,
  pending,
  onAction,
}: {
  form: AskReview;
  pending: boolean;
  onAction: (a: AskAction) => void;
}) {
  return (
    <>
      {form.warning && (
        <div className="px-3.5 pt-1 text-xs text-warn-text">
          {/^You have not answered all questions/i.test(form.warning) ? "还有题没答，没答的会空着交上去" : form.warning}
        </div>
      )}
      {form.answers.length > 0 && (
        <ul className="px-3.5 pb-1 pt-2">
          {form.answers.map((a, i) => (
            <li key={i} className="py-1">
              <div className="break-words text-xs leading-5 text-l3">{a.question}</div>
              <div className="break-words text-sm leading-5 text-l1">{a.answer || "（没答）"}</div>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-1.5 border-t border-hairline px-3.5 py-2 text-xs">
        <button
          type="button"
          disabled={pending}
          onClick={() => onAction({ kind: "confirm" })}
          className="h-7 rounded-md bg-seg-sel px-3 text-l1 transition-colors enabled:hover:bg-hover disabled:opacity-60"
        >
          提交回答
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => onAction({ kind: "cancel" })}
          title="整组都不答（终端里的「Cancel」）：这一轮会停下"
          className="h-7 rounded-md px-2 text-l3 transition-colors enabled:hover:bg-hover enabled:hover:text-l1 disabled:opacity-60"
        >
          整组不答
        </button>
      </div>
    </>
  );
}

/** 单选：序号小方块；多选：勾选框 */
function OptionMark({ index, multi, checked }: { index: number; multi: boolean; checked: boolean }) {
  if (multi) {
    return (
      <span
        aria-hidden="true"
        className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border transition-colors ${
          checked ? "border-l1 bg-l1 text-canvas" : "border-l4 group-hover:border-l2"
        }`}
      >
        {checked && <Check size={12} strokeWidth={2.4} />}
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="flex size-5 shrink-0 items-center justify-center rounded-md border border-field text-micro tabular-nums text-l3 transition-colors group-hover:border-l4 group-hover:text-l1"
    >
      {index + 1}
    </span>
  );
}
