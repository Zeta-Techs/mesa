import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Checkbox, FoldMark } from "./PageFrame";
import {
  activeProfileGroups,
  filterProfilePapers,
  suggestionReason,
  type ProfilePaper,
  type ProfileSuggestion,
  type ResearchProfileDto,
} from "../research-profile";

/** 设置「研究档案」分区：跨项目的研究背景（只收你确认的条目）+ 跨项目文献总表 */
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

  return (
    <div className="space-y-3 text-xs">
      <p className="leading-5 text-l3">
        跨项目积累你的研究背景：方向、常用方法、数据处理习惯、写作偏好、导师反复提过的意见、试过并放弃的方向。
        开新项目或新对话时，Agent 会带上这些，不用每次从头交代。只收你确认过的条目，每条要写依据；作废和替换都留着原条目，可以随时整份带走（本机文件，不上传）。
      </p>
      <Checkbox
        checked={profile.settings.inject}
        onChange={async (on) => {
          try {
            await invoke("research_profile_set_inject", { inject: on });
            await load();
          } catch (e) {
            setError(String(e));
          }
        }}
        label={<span className="text-xs text-l2">开对话时把研究档案附进项目说明（标明是偏好与历史，不是事实依据）</span>}
      />

      {groups.length === 0 ? (
        <p className="text-l4">还没有条目。在下面写第一条，或在项目设置「项目长期知识」里把适用于所有项目的条目提升过来。</p>
      ) : (
        <div className="space-y-2">
          {groups.map((group) => (
            <div key={group.category}>
              <h4 className="mb-1 text-micro font-medium text-l3">{group.category}</h4>
              <ul className="space-y-1">
                {group.entries.map((entry) => (
                  <li key={entry.meta.id} className="rounded-md px-1.5 py-1 hover:bg-hover">
                    {editing?.id === entry.meta.id ? (
                      <div className="space-y-1">
                        <textarea
                          value={editing.text}
                          onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                          rows={2}
                          className="w-full rounded-sm border border-field bg-canvas px-2 py-1 text-xs text-l2 outline-none focus:border-l4"
                        />
                        <input
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          placeholder="为什么改（必填）"
                          className="w-full rounded-sm border border-field bg-canvas px-2 py-1 text-xs text-l2 outline-none focus:border-l4"
                        />
                        <div className="flex gap-1.5">
                          <button
                            type="button"
                            disabled={busy || !editing.text.trim() || !reason.trim()}
                            onClick={() => void update("replace", entry.meta.id, editing.category, editing.text, reason)}
                            className="rounded-md bg-cta px-2 py-0.5 text-micro text-cta-text disabled:opacity-50"
                          >
                            保存修改
                          </button>
                          <button type="button" onClick={() => setEditing(null)} className="rounded-md px-2 py-0.5 text-micro text-l3 hover:bg-hover">
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex min-w-0 items-baseline gap-2">
                        <span className="min-w-0 flex-1 text-l2" title={`依据：${entry.meta.reason}`}>
                          {entry.text}
                        </span>
                        <button
                          type="button"
                          className="shrink-0 text-micro text-l4 hover:text-l1"
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
                          className="shrink-0 text-micro text-l4 hover:text-err-text"
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
                      <div className="mt-1 flex gap-1.5">
                        <input
                          value={reason}
                          autoFocus
                          onChange={(e) => setReason(e.target.value)}
                          placeholder="为什么作废（必填）"
                          className="min-w-0 flex-1 rounded-sm border border-field bg-canvas px-2 py-1 text-xs text-l2 outline-none focus:border-l4"
                        />
                        <button
                          type="button"
                          disabled={busy || !reason.trim()}
                          onClick={() => void update("revoke", entry.meta.id, "", "", reason)}
                          className="shrink-0 rounded-md px-2 py-0.5 text-micro text-err-text hover:bg-hover disabled:opacity-50"
                        >
                          作废
                        </button>
                        <button type="button" onClick={() => setRevoking(null)} className="shrink-0 rounded-md px-2 py-0.5 text-micro text-l3 hover:bg-hover">
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
        <div>
          <button
            type="button"
            aria-expanded={suggestOpen}
            onClick={() => setSuggestOpen((v) => !v)}
            className="flex items-center gap-1.5 font-medium text-l3 hover:text-l1"
          >
            <FoldMark open={suggestOpen} />
            建议记下
            <span className="font-normal text-l4">{suggestions.length}</span>
          </button>
          {suggestOpen && (
            <p className="mt-1 text-micro text-l4">在你几个项目里反复出现的意见。只是建议：点「记下」会填进下面的新增栏，你改好、写好依据再记。</p>
          )}
          {suggestOpen && (
            <ul aria-label="建议记下" className="mt-1.5 space-y-1">
              {suggestions.map((s) => (
                <li key={s.id} className="rounded-md px-1.5 py-1 hover:bg-hover">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="min-w-0 flex-1 text-l2">{s.text}</span>
                    <button
                      type="button"
                      className="shrink-0 text-micro text-l3 hover:text-l1"
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
                      className="shrink-0 text-micro text-l4 hover:text-l1"
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
                  </div>
                  <p className="text-micro text-l4">{suggestionReason(s)}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="space-y-1.5 rounded-md border border-hairline p-2">
        <div className="flex gap-1.5">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            aria-label="分类"
            className="rounded-sm border border-field bg-canvas px-1.5 py-1 text-xs text-l2"
          >
            {profile.categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="例如：缺失值超过 20% 的变量直接剔除，不插补"
            className="min-w-0 flex-1 rounded-sm border border-field bg-canvas px-2 py-1 text-xs text-l2 outline-none focus:border-l4"
          />
        </div>
        <div className="flex gap-1.5">
          <input
            value={editing || revoking ? "" : reason}
            disabled={!!editing || !!revoking}
            onChange={(e) => setReason(e.target.value)}
            placeholder="依据（必填）：例如「导师在组会上要求」"
            className="min-w-0 flex-1 rounded-sm border border-field bg-canvas px-2 py-1 text-xs text-l2 outline-none focus:border-l4"
          />
          <button
            type="button"
            disabled={busy || !!editing || !!revoking || !text.trim() || !reason.trim()}
            onClick={() => void update("add", null, category, text, reason)}
            className="shrink-0 rounded-md bg-cta px-2 py-1 text-xs text-cta-text disabled:opacity-50"
          >
            记下
          </button>
        </div>
      </div>

      <div>
        <button
          type="button"
          aria-expanded={papersOpen}
          onClick={() => setPapersOpen((v) => !v)}
          className="flex items-center gap-1.5 font-medium text-l3 hover:text-l1"
        >
          <FoldMark open={papersOpen} />
          跨项目文献总表
          {papers && <span className="font-normal text-l4">{papers.length}</span>}
        </button>
        {papersOpen && (
          <div className="mt-1.5 space-y-1.5">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="按题名、DOI 或项目名筛"
              className="w-full rounded-sm border border-field bg-canvas px-2 py-1 text-xs text-l2 outline-none focus:border-l4"
            />
            {papers === null ? (
              <p className="text-l4">读取中…</p>
            ) : shown.length === 0 ? (
              <p className="text-l4">没有符合的文献（只汇总各项目已纳入的文献）。</p>
            ) : (
              <ul className="max-h-72 space-y-0.5 overflow-auto">
                {shown.slice(0, 300).map((paper) => (
                  <li key={(paper.doi || paper.title) + paper.projects.join()} className="flex min-w-0 items-baseline gap-2 px-1">
                    <span className="min-w-0 flex-1 truncate text-l2" title={paper.doi || paper.title}>
                      {paper.title}
                      {paper.year && <span className="text-l4"> · {paper.year}</span>}
                    </span>
                    {paper.hasNote && <span className="shrink-0 text-micro text-l3">有笔记</span>}
                    <span className="shrink-0 text-micro text-l4">{paper.projects.join("、")}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      {error && <p className="text-micro text-err-text">{error}</p>}
    </div>
  );
}
