import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, CornerDownLeft, PenLine } from "lucide-react";
import type { DecisionPreview } from "../chat-channel";
import { IS_MAC } from "../hotkeys";
import type { AskAction, AskQuestion, AskReview, ClaudeAsk } from "../tui-ask";
import ChatMarkdown from "./ChatMarkdown";
import { DiffView, OutputView } from "./ConversationView";
import { primaryActionClass, quietActionClass, secondaryActionClass } from "./PageFrame";

export interface DecisionOption {
  label: string;
  /** primary = 推荐 / CLI 当前高亮那项（主按钮）；其余是次按钮 */
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
  /** Claude 计划模式的方案确认（plan-approval.ts）：有它时画整篇方案 + 开工 / 改方案，不用 options */
  plan?: PlanDecision | null;
}

export interface PlanDecision {
  /** 方案原文（Markdown）；没写方案文件时为 null */
  text: string | null;
  /** 方案是从终端屏上读的（旁路、会话文件都给不出）：终端排过版、可能只有屏上那一截，按原样分行显示 */
  fromScreen?: boolean;
  /** 方案文件路径（标题下灰字） */
  path: string | null;
  cwd?: string | null;
  /** 开工的几项（照终端顺序），primary = 终端当前高亮那项 */
  go: Array<DecisionOption & { description?: string | null }>;
  /** 其余不开工的项（「先不开工」「结束计划模式，先不开工」） */
  others: DecisionOption[];
  /** 「接着改方案」：意见写进终端那一行再回车；这一屏没有能打字的那一行时为 null */
  onRevise: ((text: string) => void) | null;
}

/** 主按钮的键帽：Mac ⌘↵，其余 Ctrl ↵ */
const PRIMARY_KEY = IS_MAC ? "⌘↵" : "Ctrl ↵";

/**
 * 「等你决定」卡片（docs/design-chat-layer.md §5，2026-10-17 第一期）：信任目录、切换 / 启动警告的确认菜单、
 * 工具审批、提问表单、终端提示 / 面板、连接出错都是这一张，贴在对话流最末尾、紧挨输入框。只摆 CLI 自己给的选项，不替用户选；
 * 右上角总有「露出终端 / 打开终端」兜底。
 *
 * 2026-10-25 视觉统一（用户：提问 / 批准照 Claude 客户端那两张图，其余弹出卡片都用一种视觉）：同一个外壳
 * （浮层表面 + 标题区 + 右上角终端链接 + 底栏），底栏按 Mesa 按钮三档——次按钮在左，主按钮（CTA）在最右并带 ⌘↵；
 * 选项多或长时（Claude 审批菜单「Yes, and don't ask again for …」）改成整行列表，和提问卡的选项行同一种画法。
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
  if (decision.plan) {
    return (
      <PlanCard
        title={decision.title}
        hint={decision.hint}
        plan={decision.plan}
        onOpenTerminal={onOpenTerminal}
        onPeek={onPeek}
      />
    );
  }
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
  const primary = decision.options.find((o) => o.primary) ?? null;
  const asRows = decision.options.length > 3 || decision.options.some((o) => labelWidth(o.label) > 28);
  return (
    <CardShell
      label={decision.title}
      title={decision.title}
      detail={decision.detail}
      hint={decision.hint}
      onOpenTerminal={onOpenTerminal}
      onPeek={onPeek}
      onPrimary={primary ? primary.onClick : null}
      footer={
        !asRows && decision.options.length > 0 ? (
          <>
            {decision.options
              .filter((o) => o !== primary)
              .map((opt, i) => (
                <button
                  key={`${i}-${opt.label}`}
                  type="button"
                  onClick={opt.onClick}
                  title={opt.title}
                  className={`${secondaryActionClass} max-w-[18rem] ${!primary && i === 0 ? "ml-auto" : ""}`}
                >
                  <span className="truncate">{opt.label}</span>
                </button>
              ))}
            {primary && (
              <PrimaryButton className="ml-auto" title={primary.title} onClick={primary.onClick}>
                {primary.label}
              </PrimaryButton>
            )}
          </>
        ) : null
      }
    >
      {decision.preview && (
        <div className="px-4 pb-3">
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
      {asRows && (
        <div role="list">
          {decision.options.map((opt, i) => (
            <OptionRow
              key={`${i}-${opt.label}`}
              mark={<NumberMark index={i} on={Boolean(opt.primary)} />}
              label={opt.label}
              title={opt.title}
              trailing={opt.primary ? <KeyCap>{PRIMARY_KEY}</KeyCap> : null}
              onClick={opt.onClick}
            />
          ))}
        </div>
      )}
    </CardShell>
  );
}

/** 估一行字有多宽（中日韩字算两格）：决定选项摆成一排按钮还是整行列表 */
function labelWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += /[⺀-鿿＀-￯]/.test(ch) ? 2 : 1;
  return w;
}

/**
 * 所有卡片同一个外壳：标题区（小标签 / 标题 / 说明 / 提示 + 右上角翻页与终端链接）、正文、底栏。
 * onPrimary：卡片显示着时按 ⌘↵（Ctrl+Enter）= 主按钮；光标在写了字的输入框里时不抢（那是要发的话 / 写的答案）
 */
function CardShell({
  label,
  eyebrow,
  title,
  detail,
  hint,
  meta,
  busy,
  onOpenTerminal,
  onPeek,
  onPrimary,
  footer,
  children,
}: {
  label: string;
  eyebrow?: ReactNode;
  title: string;
  detail?: string | null;
  hint?: string | null;
  meta?: ReactNode;
  busy?: boolean;
  onOpenTerminal: () => void;
  onPeek?: () => void;
  onPrimary?: (() => void) | null;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const primaryRef = useRef(onPrimary);
  primaryRef.current = onPrimary;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Enter" || e.shiftKey || e.altKey || !(IS_MAC ? e.metaKey : e.ctrlKey)) return;
      const run = primaryRef.current;
      const card = ref.current;
      if (!run || !card) return;
      // 只认焦点在这张卡所在的聊天区里（输入框或卡片上）：分屏时两边的卡都显示着，别的标签页里的卡藏着
      const scope = card.closest("[data-chat-host]") ?? card.parentElement ?? card;
      const active = document.activeElement;
      if (!active || !scope.contains(active)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT") && (t as HTMLInputElement).value.trim()) return;
      e.preventDefault();
      e.stopPropagation();
      run();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  return (
    <section
      ref={ref}
      role="group"
      aria-label={label}
      aria-busy={busy || undefined}
      className="ccode-float-surface mb-3 overflow-hidden rounded-xl border border-field"
    >
      <header className="flex items-start gap-3 px-4 pb-3 pt-3.5">
        <div className="min-w-0 flex-1">
          {eyebrow}
          <div className="break-words text-sm font-medium leading-6 text-l1">{title}</div>
          {detail && <div className="mt-0.5 whitespace-pre-line break-words text-xs leading-5 text-l3">{detail}</div>}
          {hint && <div className="mt-1 break-words text-micro leading-4 text-l4">{hint}</div>}
        </div>
        {/* 全站 button { font: inherit } 会吞掉按钮自己的 text-*：字号挂在外层 */}
        <div className="-mr-1.5 -mt-0.5 flex shrink-0 items-center gap-0.5 text-xs">
          {meta}
          {onPeek && (
            <button
              type="button"
              onClick={onPeek}
              title="露出下方终端，对照原样"
              className="h-7 rounded-md px-2 text-l3 transition-colors hover:bg-hover hover:text-l1"
            >
              露出终端
            </button>
          )}
          <button
            type="button"
            onClick={onOpenTerminal}
            title="选项更多或按键没反应时，去终端里直接操作"
            aria-label="打开终端"
            className="h-7 rounded-md px-2 text-l3 transition-colors hover:bg-hover hover:text-l1"
          >
            打开终端
          </button>
        </div>
      </header>
      {children}
      {footer && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-hairline px-4 py-3 text-xs">{footer}</footer>
      )}
    </section>
  );
}

function KeyCap({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-current px-1 font-sans text-micro leading-4 opacity-60">{children}</kbd>
  );
}

/** 主按钮：CTA，最右，带 ⌘↵ 键帽 */
function PrimaryButton({
  children,
  onClick,
  title,
  disabled,
  className = "",
}: {
  children: ReactNode;
  onClick: () => void;
  title?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`${primaryActionClass} max-w-[20rem] gap-2 ${className}`}
    >
      <span className="truncate">{children}</span>
      <KeyCap>{PRIMARY_KEY}</KeyCap>
    </button>
  );
}

/** 整行选项：左边标记（序号 / 单选圈 / 多选框），中间名字与说明，细线分隔 */
function OptionRow({
  mark,
  label,
  description,
  title,
  trailing,
  disabled,
  checkbox,
  checked,
  onClick,
}: {
  mark: ReactNode;
  label: string;
  description?: string | null;
  title?: string;
  trailing?: ReactNode;
  disabled?: boolean;
  checkbox?: boolean;
  checked?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role={checkbox ? "checkbox" : "listitem"}
      aria-checked={checkbox ? Boolean(checked) : undefined}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="group flex w-full items-start gap-3 border-t border-hairline px-4 py-2.5 text-left transition-colors enabled:hover:bg-hover disabled:opacity-60"
    >
      {mark}
      <span className="min-w-0 flex-1">
        <span className="block break-words text-sm leading-5 text-l1">{label}</span>
        {description && <span className="mt-0.5 block break-words text-xs leading-5 text-l3">{description}</span>}
      </span>
      {trailing && <span className="mt-0.5 shrink-0 text-l3">{trailing}</span>}
    </button>
  );
}

/** 通用菜单的序号；on = CLI 当前高亮 / 推荐那项（⌘↵ 选它） */
function NumberMark({ index, on }: { index: number; on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex size-5 shrink-0 items-center justify-center rounded-md border text-micro tabular-nums transition-colors ${
        on ? "border-cta-bd bg-cta text-cta-text" : "border-field text-l3 group-hover:border-l4 group-hover:text-l1"
      }`}
    >
      {index + 1}
    </span>
  );
}

/** 单选：空心圈（点一下就选，终端光标停在哪不画——那不是推荐）；多选：方框，勾上用 CTA 色 */
function ChoiceMark({ multi, checked }: { multi: boolean; checked: boolean }) {
  if (multi) {
    return (
      <span
        aria-hidden="true"
        className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border transition-colors ${
          checked ? "border-cta-bd bg-cta text-cta-text" : "border-l4 group-hover:border-l2"
        }`}
      >
        {checked && <Check size={12} strokeWidth={2.4} />}
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="mt-0.5 size-4 shrink-0 rounded-full border border-l4 transition-colors group-hover:border-cta"
    />
  );
}

/**
 * 方案确认卡（2026-10-26）：标题下整篇方案照 Markdown 排（长了在框里滚），下面几行开工选项各带「开工后怎么问你」，
 * 最后一行直接写意见 = 接着改方案；底栏左边「先不开工」，主按钮是终端当前高亮的那项开工。
 */
function PlanCard({
  title,
  hint,
  plan,
  onOpenTerminal,
  onPeek,
}: {
  title: string;
  hint?: string | null;
  plan: PlanDecision;
  onOpenTerminal: () => void;
  onPeek?: () => void;
}) {
  const [draft, setDraft] = useState("");
  const primary = plan.go.find((o) => o.primary) ?? null;
  function sendDraft() {
    const text = draft.trim();
    if (!text || !plan.onRevise) return;
    plan.onRevise(text);
    setDraft("");
  }
  return (
    <CardShell
      label={title}
      title={title}
      detail={plan.path ? `方案文件：${plan.path}` : null}
      hint={hint}
      onOpenTerminal={onOpenTerminal}
      onPeek={onPeek}
      onPrimary={primary ? primary.onClick : null}
      footer={
        <>
          {plan.onRevise && <span className="mr-auto text-micro text-l4">也可以在下面的输入框里说要改哪里</span>}
          {plan.others.map((opt, i) => (
            <button
              key={`${i}-${opt.label}`}
              type="button"
              onClick={opt.onClick}
              title={opt.title}
              className={`${secondaryActionClass} ${!plan.onRevise && i === 0 ? "mr-auto" : ""}`}
            >
              {opt.label}
            </button>
          ))}
          {primary && (
            <PrimaryButton className={plan.onRevise || plan.others.length ? "" : "ml-auto"} title={primary.title} onClick={primary.onClick}>
              {primary.label}
            </PrimaryButton>
          )}
        </>
      }
    >
      {plan.text && (
        <div className="mx-4 mb-3 max-h-[min(24rem,45vh)] overflow-y-auto rounded-lg border border-hairline px-3 py-2 ccode-chat-scroll">
          {plan.fromScreen ? (
            <>
              <div className="whitespace-pre-wrap break-words text-sm leading-6 text-l2">{plan.text}</div>
              <div className="mt-1 text-micro text-l4">照终端里显示的抄下来；方案长时这里只有屏上那一截，全文点「露出终端」看</div>
            </>
          ) : (
            <ChatMarkdown text={plan.text} cwd={plan.cwd} />
          )}
        </div>
      )}
      <div role="list">
        {plan.go.map((opt, i) => (
          <OptionRow
            key={`${i}-${opt.label}`}
            mark={<NumberMark index={i} on={Boolean(opt.primary)} />}
            label={opt.label}
            description={opt.description}
            title={opt.title}
            trailing={opt.primary ? <KeyCap>{PRIMARY_KEY}</KeyCap> : null}
            onClick={opt.onClick}
          />
        ))}
      </div>
      {plan.onRevise && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendDraft();
          }}
          className="flex items-center gap-3 border-t border-hairline px-4 py-1.5 transition-colors focus-within:bg-hover"
        >
          <span className="flex size-5 shrink-0 items-center justify-center text-l4" aria-hidden="true">
            <PenLine size={13} strokeWidth={1.8} />
          </span>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="接着改方案：写下要改哪里"
            placeholder="接着改方案：写下要改哪里，先不开工"
            className="h-8 min-w-0 flex-1 bg-transparent text-sm text-l1 outline-none placeholder:text-l4"
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            title="把意见交回去，它照着改方案"
            aria-label="把意见交回去，它照着改方案"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-l3 transition-colors enabled:hover:bg-hover enabled:hover:text-l1 disabled:opacity-40"
          >
            <CornerDownLeft size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </form>
      )}
    </CardShell>
  );
}

/**
 * Claude 提问表单（2026-10-22 起按表单读，2026-10-25 照 Claude 客户端的样子画）：问句是标题，右上角翻页「‹ 2 / 4 ›」，
 * 当前题签是问句上方的小标签；选项整行、细线分隔，最后一行直接写自己的答案；底栏「先不答，直接聊」+ 主按钮。
 * 多题答完（或翻到最后）是确认页：列出每题答案，「整组不答」/「提交回答」。
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
  const tab = form.current !== null ? form.tabs[form.current] : form.tabs.length === 1 ? form.tabs[0] : null;
  const multi = form.kind === "question" && form.multiSelect;
  const canSubmit = form.kind === "question" && multi && form.rows.some((r) => r.kind === "submit");
  // 只剩这一题没答（或只有一题）：交了就到确认页 / 交卷；否则是「下一题」
  const lastOpen =
    form.tabs.length <= 1 ||
    (form.current !== null && form.tabs.every((t, i) => i === form.current || t.answered));
  const primary =
    form.kind === "review"
      ? { label: "提交回答", run: () => onAction({ kind: "confirm" }) }
      : canSubmit
        ? { label: lastOpen ? "提交这一题" : "下一题", run: () => onAction({ kind: "submit" }) }
        : null;
  return (
    <CardShell
      label={title}
      busy={pending}
      eyebrow={
        form.kind === "question" && tab ? (
          <div className="mb-0.5 flex items-center gap-1.5 text-micro leading-4 text-l4">
            {tab.answered && <Check size={11} strokeWidth={2.2} aria-hidden="true" />}
            <span className="truncate">{tab.label}</span>
            {multi && <span>· 可多选</span>}
          </div>
        ) : null
      }
      title={title}
      meta={<AskPager form={form} pending={pending} onAction={onAction} />}
      onOpenTerminal={onOpenTerminal}
      onPeek={onPeek}
      onPrimary={primary && !pending ? primary.run : null}
      footer={
        <>
          {form.kind === "question" && (
            <span className="mr-auto text-micro text-l4">也可以在下面的输入框里写答案</span>
          )}
          {form.kind === "question" && form.rows.some((r) => r.kind === "chat") && (
            <button
              type="button"
              disabled={pending}
              onClick={() => onAction({ kind: "chat" })}
              title="这几题先不答（终端里的「Chat about this」）：它会接着往下说，你再在输入框里聊"
              className={quietActionClass}
            >
              先不答，直接聊
            </button>
          )}
          {form.kind === "review" && (
            <button
              type="button"
              disabled={pending}
              onClick={() => onAction({ kind: "cancel" })}
              title="整组都不答（终端里的「Cancel」）：这一轮会停下"
              className={secondaryActionClass}
            >
              整组不答
            </button>
          )}
          {primary && (
            // 提问页左边已有提示占住 mr-auto，主按钮紧跟「先不答」靠右；确认页左边是「整组不答」，主按钮自己推到最右
            <PrimaryButton className={form.kind === "review" ? "ml-auto" : ""} disabled={pending} onClick={primary.run}>
              {primary.label}
            </PrimaryButton>
          )}
        </>
      }
    >
      {form.kind === "question" ? (
        <AskQuestionBody form={form} pending={pending} onAction={onAction} />
      ) : (
        <AskReviewBody form={form} />
      )}
    </CardShell>
  );
}

/** 多题时右上角翻页：‹ 2 / 4 ›，翻过最后一题是确认页；认不出当前在哪题时不给翻 */
function AskPager({ form, pending, onAction }: { form: ClaudeAsk; pending: boolean; onAction: (a: AskAction) => void }) {
  const n = form.tabs.length;
  if (n < 2) return null;
  const cur = form.current;
  const canSwitch = cur !== null && !pending;
  const go = (index: number) => onAction({ kind: "tab", index });
  const arrow = "flex size-7 items-center justify-center rounded-md text-l3 transition-colors enabled:hover:bg-hover enabled:hover:text-l1 disabled:opacity-40";
  return (
    <span className="mr-1 flex items-center">
      <button type="button" aria-label="上一题" disabled={!canSwitch || cur === 0} onClick={() => go(cur! - 1)} className={arrow}>
        <ChevronLeft size={14} strokeWidth={1.8} aria-hidden="true" />
      </button>
      <span className="min-w-[3.25rem] text-center tabular-nums text-l3" aria-live="polite">
        {cur === null ? `共 ${n} 题` : cur >= n ? "确认" : `${cur + 1} / ${n}`}
      </span>
      <button type="button" aria-label="下一题" disabled={!canSwitch || cur! >= n} onClick={() => go(cur! + 1)} className={arrow}>
        <ChevronRight size={14} strokeWidth={1.8} aria-hidden="true" />
      </button>
    </span>
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
    <div>
      {form.options.map((opt, i) => (
        <OptionRow
          key={`${i}-${opt.label}`}
          mark={<ChoiceMark multi={multi} checked={Boolean(opt.checked)} />}
          label={opt.label}
          description={opt.description}
          disabled={pending}
          checkbox={multi}
          checked={Boolean(opt.checked)}
          onClick={() => onAction({ kind: "pick", index: i })}
        />
      ))}
      {/* 最后一项「自己写」：字写在终端那一行里，单选写完就交，多选写进去自动勾上 */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          sendDraft();
        }}
        className="flex items-center gap-3 border-t border-hairline px-4 py-1.5 transition-colors focus-within:bg-hover"
      >
        {multi && form.freeText ? (
          <ChoiceMark multi checked={Boolean(form.freeChecked)} />
        ) : (
          <span className="flex size-4 shrink-0 items-center justify-center text-l4" aria-hidden="true">
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
          className="h-8 min-w-0 flex-1 bg-transparent text-sm text-l1 outline-none placeholder:text-l4 disabled:opacity-60"
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
  );
}

function AskReviewBody({ form }: { form: AskReview }) {
  return (
    <div>
      {form.warning && (
        <div className="px-4 pb-2 text-xs text-warn-text">
          {/^You have not answered all questions/i.test(form.warning) ? "还有题没答，没答的会空着交上去" : form.warning}
        </div>
      )}
      {form.answers.map((a, i) => (
        <div key={i} className="border-t border-hairline px-4 py-2.5">
          <div className="break-words text-xs leading-5 text-l3">{a.question}</div>
          <div className="break-words text-sm leading-5 text-l1">{a.answer || "（没答）"}</div>
        </div>
      ))}
    </div>
  );
}
