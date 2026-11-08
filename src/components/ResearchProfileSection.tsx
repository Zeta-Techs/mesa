import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FoldMark, Toggle, fieldClass, paneOutlineButtonClass, primaryActionClass } from "./PageFrame";
import {
  activeProfileGroups,
  CATEGORY_EXAMPLES,
  filterProfilePapers,
  profileStatus,
  suggestionReason,
  type ProfilePaper,
  type ProfileSuggestion,
  type ResearchProfileDto,
} from "../research-profile";

/** 设置页的输入框口径：细边、透明底、32px（同 SettingsPage 的 fieldFixed / selectSm） */
const fieldFixed = fieldClass
  .replace("w-full ", "")
  .replace("rounded-md", "rounded-lg")
  .replace("bg-canvas", "bg-transparent")
  .replace("py-1.5", "h-8");
const selectSm = `${fieldFixed} w-40 max-w-full`;
/** 小折叠（同设置页低频折叠）：chevron + 小灰字 */
//（全站 button { font: inherit } 会吞掉按钮上的 text-* / font-*，字号字重写在内层 span）
const foldLinkClass = "-ml-1 inline-flex items-center text-l4 hover:text-l2";
/** 可折叠的节标题（同设置页 Card 头：粗体标题，下面一句说明） */
const foldHeadClass = "-ml-1 inline-flex items-center gap-0.5 text-l1";

/** 设置「研究档案」分区：跨项目的研究背景（只收你确认的条目）+ 跨项目文献总表。
 *  外形同设置页其他分区（2026-11-08）：状态一行 + 开关、条目按分类成组、行间细线，不套卡；按钮细边、输入框同设置页 */
export default function ResearchProfileSection() {
  const [profile, setProfile] = useState<ResearchProfileDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState("研究方向");
  const [text, setText] = useState("");
  const [reason, setReason] = useState("");
  const [editing, setEditing] = useState<{ id: string; category: string; text: string } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [papersOpen, setPapersOpen] = useState(false);
  const [papers, setPapers] = useState<ProfilePaper[] | null>(null);
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<ProfileSuggestion[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);

  const load = () =>
    invoke<ResearchProfileDto>("research_profile_read")
      .then((dto) => {
        setProfile(dto);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  const loadSuggestions = () =>
    invoke<ProfileSuggestion[]>("research_profile_suggestions")
      .then(setSuggestions)
      .catch(() => setSuggestions([]));
  useEffect(() => {
    void load();
    void loadSuggestions();
  }, []);
  useEffect(() => {
    if (!papersOpen || papers) return;
    invoke<ProfilePaper[]>("research_profile_papers")
      .then(setPapers)
      .catch((e) => setError(String(e)));
  }, [papersOpen, papers]);

  const groups = useMemo(() => (profile ? activeProfileGroups(profile) : []), [profile]);
  const shown = useMemo(() => filterProfilePapers(papers ?? [], query), [papers, query]);

  if (!profile) return error ? <p className="text-xs text-err-text">{error}</p> : null;

  const update = async (action: "add" | "replace" | "revoke", id: string | null, cat: string, body: string, why: string) => {
    setBusy(true);
    try {
      await invoke("research_profile_update", {
        expectedRevision: profile.doc.revision,
        id,
        action,
        category: cat,
        text: body,
        reason: why,
      });
      await load();
      void loadSuggestions();
      setText("");
      setReason("");
      setEditing(null);
      setRevoking(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const status = profileStatus(profile);
  const setInject = async (on: boolean) => {
    try {
      await invoke("research_profile_set_inject", { inject: on });
      await load();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div>
      {/* 生效状态：回答「AI 现在拿不拿得到、拿到的是什么」——一行设置项：状态 + 一句说明，开关靠右 */}
      <div className="mt-2 border-y border-hairline">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5 py-3.5">
          <div className="min-w-[12rem] flex-1">
            <div className="flex items-center gap-2 text-base text-l1">
              <span
                aria-hidden="true"
                className={`h-2 w-2 shrink-0 rounded-full ${status.tone === "on" ? "bg-ok-text" : "bg-l4"}`}
              />
              <span>
                {status.tone === "on"
                  ? `正在生效：${status.count} 条会附给 AI`
                  : status.tone === "off"
                    ? `已关：${status.count} 条都不会附给 AI`
                    : "还没有条目：AI 现在什么也拿不到"}
              </span>
            </div>
            <p className="mt-0.5 max-w-2xl text-sm leading-relaxed text-l3">开对话、流程步骤开工、项目助手都会带上，只当偏好参考</p>
          </div>
          <Toggle label="附给 AI" checked={profile.settings.inject} onChange={(on) => void setInject(on)} />
          {profile.context && (
            <div className="basis-full">
              <button
                type="button"
                aria-expanded={previewOpen}
                onClick={() => setPreviewOpen((v) => !v)}
                className={foldLinkClass}
              >
                <FoldMark open={previewOpen} />
                <span className="text-xs">看 AI 拿到的原文</span>
              </button>
              {previewOpen && (
                <pre className="mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-inset px-3 py-2 font-sans text-xs leading-5 text-l2">
                  {profile.context}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="mt-2">
        <button
          type="button"
          aria-expanded={compareOpen}
          onClick={() => setCompareOpen((v) => !v)}
          className={foldLinkClass}
        >
          <FoldMark open={compareOpen} />
          <span className="text-xs">和项目长期知识有什么不同</span>
        </button>
        {compareOpen && (
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 pl-4 text-xs leading-5">
            <dt className="text-l2">研究档案</dt>
            <dd className="text-l3">你的习惯，换个课题也成立</dd>
            <dt className="text-l2">项目长期知识</dt>
            <dd className="text-l3">只对一个项目成立的定论，在项目设置里记，可提升到这里</dd>
            <dt className="text-l2">项目说明</dt>
            <dd className="text-l3">开对话时附给 AI 的那段话，上面两样都在里面</dd>
          </dl>
        )}
      </div>

      {groups.length > 0 && (
        <div className="mt-6 space-y-5">
          {groups.map((group) => (
            <div key={group.category}>
              <h4 className="mb-1 text-xs font-medium text-l3">{group.category}</h4>
              <ul className="divide-y divide-hairline border-y border-hairline">
                {group.entries.map((entry) => (
                  <li key={entry.meta.id} className="py-2">
                    {editing?.id === entry.meta.id ? (
                      <div className="space-y-2">
                        <textarea
                          value={editing.text}
                          onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                          rows={2}
                          className={`${fieldFixed} h-auto w-full py-1.5`}
                        />
                        <div className="flex gap-2">
                          <input
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            placeholder="为什么改（必填）"
                            className={`${fieldFixed} min-w-0 flex-1`}
                          />
                          <button
                            type="button"
                            disabled={busy || !editing.text.trim() || !reason.trim()}
                            onClick={() => void update("replace", entry.meta.id, editing.category, editing.text, reason)}
                            className={`${primaryActionClass} shrink-0`}
                          >
                            保存修改
                          </button>
                          <button type="button" onClick={() => setEditing(null)} className={paneOutlineButtonClass}>
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex min-h-8 min-w-0 items-center gap-2">
                        <span className="min-w-0 flex-1 text-sm text-l1" title={`依据：${entry.meta.reason}`}>
                          {entry.text}
                        </span>
                        <button
                          type="button"
                          className={paneOutlineButtonClass}
                          onClick={() => {
                            setReason("");
                            setEditing({ id: entry.meta.id, category: entry.meta.goalName, text: entry.text });
                          }}
                        >
                          修改
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          className={paneOutlineButtonClass}
                          onClick={() => {
                            setReason("");
                            setEditing(null);
                            setRevoking(entry.meta.id);
                          }}
                        >
                          作废
                        </button>
                      </div>
                    )}
                    {revoking === entry.meta.id && (
                      <div className="mt-2 flex gap-2">
                        <input
                          value={reason}
                          autoFocus
                          onChange={(e) => setReason(e.target.value)}
                          placeholder="为什么作废（必填）"
                          className={`${fieldFixed} min-w-0 flex-1`}
                        />
                        <button
                          type="button"
                          disabled={busy || !reason.trim()}
                          onClick={() => void update("revoke", entry.meta.id, "", "", reason)}
                          className={`${paneOutlineButtonClass} text-err-text`}
                        >
                          作废
                        </button>
                        <button type="button" onClick={() => setRevoking(null)} className={paneOutlineButtonClass}>
                          取消
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {suggestions.length > 0 && (
        <div className="mt-7">
          <button
            type="button"
            aria-expanded={suggestOpen}
            onClick={() => setSuggestOpen((v) => !v)}
            className={foldHeadClass}
          >
            <FoldMark open={suggestOpen} />
            <span className="text-base font-semibold">建议记下</span>
            <span className="ml-1 text-sm font-normal text-l4">{suggestions.length}</span>
          </button>
          {suggestOpen && (
            <p className="mt-0.5 text-xs leading-5 text-l3">在你几个项目里反复出现的意见，只是建议；记之前可以改，依据要你写</p>
          )}
          {suggestOpen && (
            <ul aria-label="建议记下" className="mt-2 divide-y divide-hairline border-y border-hairline">
              {suggestions.map((s) => (
                <li key={s.id} className="flex min-h-12 min-w-0 items-center gap-2 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-l1">{s.text}</p>
                    <p className="mt-0.5 text-xs leading-4 text-l3">{suggestionReason(s)}</p>
                  </div>
                  <button
                    type="button"
                    className={paneOutlineButtonClass}
                    onClick={() => {
                      setEditing(null);
                      setRevoking(null);
                      setCategory(profile.categories.includes(s.category) ? s.category : "其他");
                      setText(s.text);
                      setReason(suggestionReason(s));
                    }}
                  >
                    记下
                  </button>
                  <button
                    type="button"
                    className={paneOutlineButtonClass}
                    onClick={async () => {
                      try {
                        await invoke("research_profile_ignore", { id: s.id });
                        setSuggestions((list) => list.filter((x) => x.id !== s.id));
                      } catch (e) {
                        setError(String(e));
                      }
                    }}
                  >
                    忽略
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 新增栏：不套框，上下细线收边（同设置页行组） */}
      <div className="mt-6 space-y-2 border-y border-hairline py-3">
        <div className="flex gap-2">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            aria-label="分类"
            className={`${selectSm} shrink-0`}
          >
            {profile.categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={CATEGORY_EXAMPLES[category] ?? "写一句"}
            className={`${fieldFixed} min-w-0 flex-1`}
          />
        </div>
        <div className="flex gap-2">
          <input
            value={editing || revoking ? "" : reason}
            disabled={!!editing || !!revoking}
            onChange={(e) => setReason(e.target.value)}
            placeholder="依据（必填）：为什么这么做，例如「导师在组会上要求」"
            className={`${fieldFixed} min-w-0 flex-1 disabled:opacity-50`}
          />
          <button
            type="button"
            disabled={busy || !!editing || !!revoking || !text.trim() || !reason.trim()}
            onClick={() => void update("add", null, category, text, reason)}
            className={`${primaryActionClass} shrink-0`}
          >
            记下
          </button>
        </div>
      </div>

      <div className="mt-7">
        <button
          type="button"
          aria-expanded={papersOpen}
          onClick={() => setPapersOpen((v) => !v)}
          className={foldHeadClass}
        >
          <FoldMark open={papersOpen} />
          <span className="text-base font-semibold">跨项目文献总表</span>
          {papers && <span className="ml-1 text-sm font-normal text-l4">{papers.length}</span>}
        </button>
        <p className="mt-0.5 text-xs leading-5 text-l3">各项目读过的文献合在一起，只给你查，不附给 AI</p>
        {papersOpen && (
          <div className="mt-2 border-t border-hairline pt-3">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="按题名、DOI 或项目名筛"
              className={`${fieldFixed} w-full`}
            />
            {papers === null ? (
              <p className="py-2 text-xs text-l4">读取中…</p>
            ) : shown.length === 0 ? (
              <p className="py-2 text-xs text-l4">没有符合的文献（只汇总各项目已纳入的文献）</p>
            ) : (
              <ul className="mt-2 max-h-72 divide-y divide-hairline overflow-auto border-y border-hairline">
                {shown.slice(0, 300).map((paper) => (
                  <li key={(paper.doi || paper.title) + paper.projects.join()} className="flex min-w-0 items-baseline gap-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-l1" title={paper.doi || paper.title}>
                      {paper.title}
                      {paper.year && <span className="text-l4"> · {paper.year}</span>}
                    </span>
                    {paper.hasNote && <span className="shrink-0 text-xs text-l3">有笔记</span>}
                    <span className="shrink-0 text-xs text-l4">{paper.projects.join("、")}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      {error && <p className="mt-2 text-xs text-err-text">{error}</p>}
    </div>
  );
}
