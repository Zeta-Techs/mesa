import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { HelpItemDto, HelpRequestDto } from "../types";
import { helpCategoryTag, optionAnswer } from "../help-requests";
import { InlineNotice } from "./PageFrame";

/**
 * 人工请求卡片（2026-11-02）：Agent 写的「票拟」——问题、建议、选项与后果、不回时怎么办；人点一下就是批红。
 * 回答立刻写回 help-wanted.md 的「已答：」行；交给 Agent 由外层按钮统一做（同「让 Agent 按决定继续」）。
 */
export default function HelpRequestCards({
  request,
  onAnswered,
  onRemembered,
}: {
  request: HelpRequestDto;
  /** 回答写进文件后：外层据此刷新列表 */
  onAnswered: (item: HelpItemDto) => void;
  /** 这一条记进了项目知识（交给 Agent 时告诉它） */
  onRemembered: (id: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [remember, setRemember] = useState<Record<string, "已定" | "不做" | undefined>>({});
  // 这次弹层里已经记进项目知识的（改答不再重复记）
  const [recorded, setRecorded] = useState<Record<string, "已定" | "不做">>({});
  const items = request.items.filter((item) => item.sent == null);

  async function answer(item: HelpItemDto, text: string) {
    const value = text.trim();
    if (!value) return;
    setBusy(item.id);
    setError(null);
    try {
      const kind = remember[item.id];
      const saved = await invoke<HelpItemDto>("help_request_answer", {
        root: request.root,
        itemId: item.id,
        answer: value,
        remember: kind ?? null,
      });
      if (kind) {
        onRemembered(item.id);
        setRecorded((prev) => ({ ...prev, [item.id]: kind }));
        setRemember((prev) => ({ ...prev, [item.id]: undefined }));
      }
      setDrafts((prev) => ({ ...prev, [item.id]: "" }));
      onAnswered(saved);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0) {
    return <p className="text-sm text-l3">这里的问题都已交给 Agent。</p>;
  }

  return (
    <div className="space-y-3">
      {error && <InlineNotice tone="err">{error}</InlineNotice>}
      <ol className="space-y-3">
        {items.map((item, index) => {
          const tag = helpCategoryTag(item.category);
          const disabled = busy != null;
          const draft = drafts[item.id] ?? "";
          return (
            <li key={item.id} className={index > 0 ? "border-t border-hairline pt-3" : undefined}>
              <p className="text-sm leading-6 text-l1">
                {tag && (
                  <span className="mr-1.5 rounded-sm bg-warn px-1 py-px text-micro text-warn-text">
                    {tag}
                  </span>
                )}
                {item.question}
              </p>
              {item.detail.map((line, i) => (
                <p key={i} className="text-xs leading-5 text-l3">
                  {line}
                </p>
              ))}
              {item.options.length > 0 && (
                <div className="mt-2 grid gap-1.5">
                  {item.options.map((option) => {
                    const value = optionAnswer(option.key, option.label);
                    const chosen = item.answer === value;
                    const recommended = item.recommend === option.key;
                    return (
                      <button
                        key={option.key}
                        type="button"
                        disabled={disabled}
                        aria-pressed={chosen}
                        onClick={() => void answer(item, value)}
                        className={`flex items-baseline gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors disabled:opacity-50 ${
                          chosen
                            ? "border-cta-bd bg-cta text-cta-text"
                            : "border-field bg-strip text-l2 hover:bg-inset hover:text-l1"
                        }`}
                      >
                        {/* 全站 button { font: inherit } 会吞掉按钮上的字号，字号写在内层 */}
                        <span className="text-xs font-medium">{option.key}</span>
                        <span className="min-w-0 flex-1 text-xs leading-5">
                          {option.label}
                          {option.effect && (
                            <span className={chosen ? "opacity-80" : "text-l4"}>　{option.effect}</span>
                          )}
                        </span>
                        {recommended && (
                          <span className={`shrink-0 text-micro ${chosen ? "opacity-80" : "text-l4"}`}>建议</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
              {/* 输入框同样 font: inherit：字号放在父层让它继承 */}
              <div className="mt-1.5 flex items-center gap-1.5 text-xs">
                <input
                  value={draft}
                  aria-label="自己写回答"
                  disabled={disabled}
                  onChange={(event) => setDrafts((prev) => ({ ...prev, [item.id]: event.target.value }))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void answer(item, draft);
                    }
                  }}
                  placeholder={item.options.length > 0 ? "都不合适就写一句" : "写下你的回答"}
                  className="h-7 min-w-0 flex-1 rounded-md border border-field bg-transparent px-2 text-xs text-l2 outline-none placeholder:text-l4"
                />
                <button
                  type="button"
                  disabled={disabled || !draft.trim()}
                  onClick={() => void answer(item, draft)}
                  className="inline-flex h-7 items-center rounded-md border border-field bg-strip px-2.5 text-xs text-l2 hover:bg-inset hover:text-l1 disabled:opacity-50"
                >
                  <span className="text-xs">{busy === item.id ? "记下中…" : "记下"}</span>
                </button>
              </div>
              {(item.fallback || item.refs) && (
                <p className="mt-1 text-micro leading-5 text-l4">
                  {item.fallback && <>不回时：{item.fallback}</>}
                  {item.fallback && item.refs && "　"}
                  {item.refs && <>依据：{item.refs}</>}
                </p>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-l3">
                {item.answer ? (
                  <span className="text-ok-text">已答：{item.answer}</span>
                ) : null}
                {recorded[item.id] ? (
                  <span className="text-l3">已记进项目知识（{recorded[item.id]}）</span>
                ) : (
                <label className="inline-flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={remember[item.id] != null}
                    disabled={disabled}
                    onChange={(event) =>
                      setRemember((prev) => ({ ...prev, [item.id]: event.target.checked ? "已定" : undefined }))
                    }
                  />
                  以后同类照此办
                </label>
                )}
                {remember[item.id] && !recorded[item.id] && (
                  <span className="inline-flex items-center gap-1">
                    记为
                    {(["已定", "不做"] as const).map((kind) => (
                      <button
                        key={kind}
                        type="button"
                        disabled={disabled}
                        aria-pressed={remember[item.id] === kind}
                        onClick={() => setRemember((prev) => ({ ...prev, [item.id]: kind }))}
                        className={`rounded-sm border px-1 py-px ${
                          remember[item.id] === kind ? "border-cta-bd text-l1" : "border-field text-l3"
                        }`}
                      >
                        <span className="text-micro">{kind}</span>
                      </button>
                    ))}
                    <span className="text-l4">（答的时候一并记进项目知识）</span>
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
