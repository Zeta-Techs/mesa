import { CircleHelp, SquareTerminal } from "lucide-react";

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
  options: DecisionOption[];
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
  return (
    <div
      role="group"
      aria-label={decision.title}
      className="mb-3 rounded-lg border border-field bg-raised px-3.5 py-3"
    >
      <div className="flex items-start gap-2">
        <CircleHelp
          size={15}
          strokeWidth={1.8}
          aria-hidden="true"
          className="mt-0.5 shrink-0 text-warn-text"
        />
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
