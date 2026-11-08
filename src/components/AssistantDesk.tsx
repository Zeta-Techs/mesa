import { useCallback, useEffect, useState } from "react";
import { compactFieldClass, ghostActionClass, secondaryActionClass } from "./PageFrame";
import { useAppStore } from "../store";
import { toast } from "../toast";
import { optionAnswer } from "../help-requests";
import { deskSummary, type DeskItem } from "../assistant-queue";
import { answerTrust, focusConfirm, loadDesk, replyDesk } from "../assistant-desk";

/**
 * 项目助手顶上的「等你的事」（调度台，2026-11-06 docs/design-assistant-dispatch-desk.md §2）：
 * 人工请求、AI 在对话里问你的话、等你确认的命令，一个地方看齐、就地回；Mesa 原路原话转达，不经 AI 改写。
 * 等确认的命令只带路去对话里确认。没有等你的事时整块不出现。
 * 2026-11-08：钉在滚动区顶上的一条横条，默认收成「等你的事 N 件：…」一行，点开才展开（限高、内部滚动），不再把对话推到下面。
 */
export default function AssistantDesk({ projectPath }: { projectPath: string }) {
  const [items, setItems] = useState<DeskItem[]>([]);
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const echoTick = useAppStore((s) => s.assistantEchoTick);
  const helpTick = useAppStore((s) => s.helpRefreshTick);

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
      const note = await replyDesk(projectPath, item, text);
      toast(note, "success");
      setDrafts((d) => ({ ...d, [item.key]: "" }));
      setItems((list) => list.filter((x) => x.key !== item.key));
      window.setTimeout(load, 1500);
    } catch (reason) {
      toast(`没送出去：${String(reason)}`, "error");
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0) return null;
  return (
    // 滚动区有 px-5 pt-4：横条拉满宽、贴顶，背景与抽屉同色，滚动时对话从它下面过
    <section className="sticky top-0 z-10 -mx-5 -mt-4 mb-1 border-b border-hairline bg-canvas px-5 py-2" aria-label="等你的事">
      <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="h-2 w-2 shrink-0 rounded-full bg-warn-text" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-l1" title={deskSummary(items)}>{deskSummary(items)}</span>
        <span className="shrink-0 text-xs text-l4">{open ? "收起" : "展开"}</span>
      </button>
      {open && (
        <ol className="mt-2 max-h-[45vh] space-y-3 overflow-auto pb-1">
          {items.map((item) => {
            const draft = drafts[item.key] ?? "";
            const disabled = busy !== null;
            return (
              <li key={item.key} className="border-t border-hairline pt-2.5">
                <p className="text-xs text-l3">
                  {item.where} · {item.kind === "help" ? "人工请求" : item.kind === "question" ? "AI 在对话里问你" : item.kind === "trust" ? "等你信任文件夹" : item.kind === "blocked" ? "卡住了" : "等你确认"}
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
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
