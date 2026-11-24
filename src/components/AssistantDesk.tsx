import { useCallback, useEffect, useState } from "react";
import { compactFieldClass, ghostActionClass, secondaryActionClass } from "./PageFrame";
import { useAppStore } from "../store";
import { toast } from "../toast";
import { optionAnswer } from "../help-requests";
import { deskSummary, dismissDeskQuestion, type DeskItem } from "../assistant-queue";
import { answerGrant, answerTrust, focusConfirm, loadDesk, replyDesk } from "../assistant-desk";
import { absTime, relTime } from "../rel-time";
import type { BriefLine } from "../assistant-brief";
import type { AssistantAction } from "../project-assistant";

const BRIEF_TONE: Record<BriefLine["tone"], string> = {
  err: "bg-err-text",
  warn: "bg-mesa-amber",
  ok: "bg-ok-text",
};
/** 上次打开离现在不到这么久就不写「上次打开是…」（刚刚 / 几分钟前不带信息） */
const BRIEF_SINCE_QUIET_MS = 30 * 60 * 1000;

/**
 * 项目助手顶部唯一的状态条（合并「等你的事」调度台与「现在的情况」简报，2026-11-24 简化）：
 * - 有必须你回应的事（人工请求、AI 发问、等确认、信任文件夹、卡住、扩权）或项目动态（出错、待评审、待跟进、待验收、刚保存）时，
 *   收成顶部一行紧凑摘要，不占用对话区；没事时整块隐藏。
 * - 点「展开」后分区处理：上半区原话转达回复，下半区查看项目动态与一键跳转/追问。
 */
export default function AssistantDesk({
  projectPath,
  briefLines = [],
  briefSince = null,
  assistantBusy = false,
  onBriefAction,
  onBriefAsk,
  onDismissBrief,
  onDismissKnowledgeDraft,
}: {
  projectPath: string;
  briefLines?: readonly BriefLine[];
  briefSince?: string | null;
  assistantBusy?: boolean;
  onBriefAction?: (action: AssistantAction) => void;
  onBriefAsk?: (line: BriefLine) => void;
  onDismissBrief?: () => void;
  onDismissKnowledgeDraft?: () => void;
}) {
  const [items, setItems] = useState<DeskItem[]>([]);
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [remembers, setRemembers] = useState<Record<string, "已定" | "不做" | undefined>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const echoTick = useAppStore((s) => s.assistantEchoTick);
  const helpTick = useAppStore((s) => s.helpRefreshTick);

  useEffect(() => {
    setOpen(false);
  }, [projectPath]);

  const load = useCallback(() => {
    void loadDesk(projectPath)
      .then(setItems)
      .catch(() => {});
  }, [projectPath]);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 20_000);
    return () => window.clearInterval(timer);
  }, [load, echoTick, helpTick]);

  async function reply(item: DeskItem, text: string) {
    setBusy(item.key);
    try {
      const note = await replyDesk(projectPath, item, text, item.kind === "help" ? (remembers[item.key] ?? null) : null);
      toast(note, "success");
      setDrafts((d) => ({ ...d, [item.key]: "" }));
      setRemembers((r) => {
        const next = { ...r };
        delete next[item.key];
        return next;
      });
      setItems((list) => list.filter((x) => x.key !== item.key));
      window.setTimeout(load, 1500);
    } catch (reason) {
      toast(`没送出去：${String(reason)}`, "error");
    } finally {
      setBusy(null);
    }
  }

  const hasDesk = items.length > 0;
  const hasBrief = briefLines.length > 0;
  if (!hasDesk && !hasBrief) return null;

  const hasErr = briefLines.some((l) => l.tone === "err");
  const hasWarn = hasDesk || briefLines.some((l) => l.tone === "warn");
  const dotClass = hasErr ? "bg-err-text" : hasWarn ? "bg-mesa-amber" : "bg-ok-text";
  const summaryText = hasDesk
    ? hasBrief
      ? `${deskSummary(items)} · 另有 ${briefLines.length} 条动态`
      : deskSummary(items)
    : briefLines.length === 1
      ? briefLines[0].text
      : `项目动态 ${briefLines.length} 条：${briefLines[0].text}`;

  return (
    <section className="border-b border-hairline bg-canvas px-5 py-2" aria-label="项目状态与待办">
      <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-l1" title={summaryText}>
          {summaryText}
        </span>
        <span className="shrink-0 text-xs text-l4">{open ? "收起" : "展开"}</span>
      </button>
      {open && (
        <div className="mt-2 max-h-[48vh] space-y-3 overflow-auto pb-1">
          {hasDesk && (
            <ol className="space-y-3">
              {items.map((item) => {
            const draft = drafts[item.key] ?? "";
            const disabled = busy !== null;
            return (
              <li key={item.key} className="border-t border-hairline pt-2.5">
                <p className="text-xs text-l3">
                  {item.where} · {item.kind === "help" ? "人工请求" : item.kind === "question" ? "AI 在对话里问你" : item.kind === "trust" ? "等你信任文件夹" : item.kind === "blocked" ? "卡住了" : item.kind === "grant" ? "要扩大授权" : "等你确认"}
                  {(item.siblingPendingCount ?? 0) > 0 ? ` · 同处还有 ${item.siblingPendingCount} 题待答` : ""}
                </p>
                <p className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-6 text-l1">{item.question}</p>
                {item.detail.length > 0 && <p className="text-xs leading-5 text-l3">{item.detail.join("；")}</p>}
                {item.kind === "trust" && item.trust ? (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      className={secondaryActionClass}
                      title={`在终端菜单里选「${item.trust.yes}」`}
                      onClick={() => {
                        answerTrust(item, true);
                        setItems((list) => list.filter((x) => x.key !== item.key));
                      }}
                    >
                      信任并继续
                    </button>
                    <button type="button" className={ghostActionClass} title={`在终端菜单里选「${item.trust.no}」`} onClick={() => answerTrust(item, false)}>
                      不信任
                    </button>
                    <button type="button" className={ghostActionClass} onClick={() => focusConfirm(item)}>
                      去终端看看
                    </button>
                  </div>
                ) : item.kind === "grant" ? (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      className={secondaryActionClass}
                      title="只下一次联网不限，跑完回到原来的授权"
                      onClick={() => {
                        void answerGrant(item, true).then(
                          (msg) => {
                            toast(msg, "success");
                            setItems((list) => list.filter((x) => x.key !== item.key));
                          },
                          (e) => toast(String(e), "warning"),
                        );
                      }}
                    >
                      放宽重跑这一次
                    </button>
                    <button
                      type="button"
                      className={ghostActionClass}
                      onClick={() => {
                        void answerGrant(item, false).then(
                          () => setItems((list) => list.filter((x) => x.key !== item.key)),
                          (e) => toast(String(e), "warning"),
                        );
                      }}
                    >
                      不用
                    </button>
                  </div>
                ) : item.kind === "confirm" || item.kind === "blocked" ? (
                  <button type="button" className={`${secondaryActionClass} mt-1.5`} onClick={() => focusConfirm(item)}>
                    {item.kind === "confirm" ? "去对话里确认" : "去终端看看"}
                  </button>
                ) : (
                  <>
                    {item.options.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {item.options.map((o) => (
                          <button
                            key={o.key}
                            type="button"
                            className={secondaryActionClass}
                            disabled={disabled}
                            title={o.effect ?? undefined}
                            onClick={() => void reply(item, optionAnswer(o.key, o.label))}
                          >
                            {o.key}：{o.label}
                            {item.recommend === o.key ? "（建议）" : ""}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="mt-1.5 flex items-end gap-1.5">
                      <textarea
                        className={`${compactFieldClass} min-h-8 min-w-0 flex-1 resize-y py-1`}
                        rows={1}
                        value={draft}
                        placeholder={item.options.length ? "或者写一句" : "写一句回它，原话送进那段对话"}
                        onChange={(e) => setDrafts((d) => ({ ...d, [item.key]: e.target.value }))}
                      />
                      <button type="button" className={ghostActionClass} disabled={disabled || !draft.trim()} onClick={() => void reply(item, draft)}>
                        {busy === item.key ? "送出中…" : "送过去"}
                      </button>
                      {item.kind === "question" && (
                        <button
                          type="button"
                          className={ghostActionClass}
                          disabled={disabled}
                          title="这句只是客套结尾或不用回答，收起不再提示"
                          onClick={() => {
                            dismissDeskQuestion(item.key);
                            setItems((list) => list.filter((x) => x.key !== item.key));
                          }}
                        >
                          不用回
                        </button>
                      )}
                    </div>
                    {item.kind === "help" && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-l3">
                        <label className="inline-flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={remembers[item.key] != null}
                            disabled={disabled}
                            onChange={(e) =>
                              setRemembers((prev) => ({ ...prev, [item.key]: e.target.checked ? "已定" : undefined }))
                            }
                          />
                          以后同类照此办
                        </label>
                        {remembers[item.key] && (
                          <span className="inline-flex items-center gap-1">
                            记为
                            {(["已定", "不做"] as const).map((kind) => (
                              <button
                                key={kind}
                                type="button"
                                disabled={disabled}
                                aria-pressed={remembers[item.key] === kind}
                                onClick={() => setRemembers((prev) => ({ ...prev, [item.key]: kind }))}
                                className={`rounded-sm border px-1 py-px ${
                                  remembers[item.key] === kind ? "border-cta-bd text-l1" : "border-field text-l3"
                                }`}
                              >
                                <span className="text-micro">{kind}</span>
                              </button>
                            ))}
                            <span className="text-l4">（答的时候一并记进项目知识）</span>
                          </span>
                        )}
                      </div>
                    )}
                  </>
                )}
              </li>
            );
          })}
            </ol>
          )}
          {hasBrief && (
            <div className="border-t border-hairline pt-2.5" aria-label="现在的情况">
              <div className="mb-1.5 flex items-baseline gap-2">
                <span className="text-xs font-medium text-l3" title="Mesa 按项目记录整理，不经 AI">
                  现在的情况
                </span>
                <span className="min-w-0 flex-1 truncate text-micro text-l4" title={briefSince ? absTime(briefSince) : undefined}>
                  {briefSince && Date.now() - Date.parse(briefSince) > BRIEF_SINCE_QUIET_MS ? `上次打开是${relTime(briefSince)}` : ""}
                </span>
                {onDismissBrief && (
                  <button
                    type="button"
                    className="shrink-0 text-l4 hover:text-l2"
                    onClick={() => {
                      onDismissBrief();
                      if (!hasDesk) setOpen(false);
                    }}
                  >
                    <span className="text-micro">知道了</span>
                  </button>
                )}
              </div>
              <ul className="space-y-1.5">
                {briefLines.map((line) => (
                  <li key={line.text} className="flex items-start gap-2 text-xs leading-5">
                    <span className={`mt-2 size-1.5 shrink-0 rounded-full ${BRIEF_TONE[line.tone]}`} aria-hidden="true" />
                    <span className="min-w-0 flex-1 break-words text-l1">
                      {line.text}
                      {(line.action || line.ask || line.kind === "knowledge-draft") && (
                        <span className="mt-0.5 flex flex-wrap gap-x-3">
                          {line.action && onBriefAction && (
                            <button
                              type="button"
                              className="shrink-0 text-l3 underline decoration-dotted underline-offset-2 hover:text-l1"
                              onClick={() => {
                                setOpen(false);
                                onBriefAction(line.action!);
                              }}
                            >
                              <span className="text-xs">{line.action.label}</span>
                            </button>
                          )}
                          {line.ask && onBriefAsk && (
                            <button
                              type="button"
                              className="shrink-0 text-l3 underline decoration-dotted underline-offset-2 hover:text-l1 disabled:opacity-50"
                              disabled={assistantBusy}
                              onClick={() => {
                                setOpen(false);
                                onBriefAsk(line);
                              }}
                            >
                              <span className="text-xs">{line.ask.label ?? "问问为什么"}</span>
                            </button>
                          )}
                          {line.kind === "knowledge-draft" && onDismissKnowledgeDraft && (
                            <button
                              type="button"
                              className="shrink-0 text-l4 hover:text-l2"
                              title="这个项目不再提议起草；以后照样可以在回答下面点「记进项目知识」"
                              onClick={onDismissKnowledgeDraft}
                            >
                              <span className="text-xs">不用了</span>
                            </button>
                          )}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
