import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ContextMenu from "./ContextMenu";
import { Modal } from "./Modal";
import { confirmDialog } from "./ConfirmDialog";
import {
  FoldMark,
  hoverRevealClass,
  iconActionClass,
  inlineActionClass,
  projectWellClass,
  Toggle,
  fieldClass,
} from "./PageFrame";
import { useAppStore } from "../store";
import { IS_WINDOWS } from "../hotkeys";
import { absTime, relTime } from "../rel-time";
import {
  frequencyLabel,
  scheduleStatusMark,
  schedulesForProject,
  summaryPreview,
} from "../schedule-tasks";
import {
  LIT_WATCH_SKILL,
  buildWatchSkillSeedPrompt,
  defaultScheduleName,
  followSkillName,
  isLitWatchSkill,
  scheduleSkillOptions,
  scheduleSkillOptionsForEdit,
} from "../schedule-skill";
import { beginAskAi } from "./AskAiModal";
import { AGENTS, type AgentCapabilitiesDto } from "../types";
import type {
  RunRecordDto,
  ScheduleDto,
  SchedulerRunDonePayload,
  SkillDto,
  WatchSkillDraftDto,
} from "../types";
import { SubscriptionsModal } from "./LitWatchCard";
import type { WatchSubscriptionDto } from "../lit-watch";
import { headlessWriteBlocked, headlessWriteCaution, headlessWriteNote } from "../agent-caps";
import { toast } from "../toast";

const NEW_WATCH = "__new__";

function useAgentCaps(): Record<string, AgentCapabilitiesDto> {
  const [caps, setCaps] = useState<Record<string, AgentCapabilitiesDto>>({});
  useEffect(() => {
    let stale = false;
    invoke<AgentCapabilitiesDto[]>("agent_capabilities")
      .then((list) => {
        if (stale) return;
        setCaps(Object.fromEntries(list.map((c) => [c.agent, c])));
      })
      .catch(() => toast("Agent 能力读取失败，定时任务配置可能不完整", "warning"));
    return () => {
      stale = true;
    };
  }, []);
  return caps;
}

function profileScheduleMeta(
  p: { agent: string; name: string },
  caps: Record<string, AgentCapabilitiesDto>,
): { label: string; disabled: boolean; blockReason: string | null } {
  const cap = caps[p.agent]?.headlessWrite;
  const blocked = headlessWriteBlocked(cap);
  const note = headlessWriteNote(cap);
  const agent = AGENTS.find((a) => a.id === p.agent)?.label ?? p.agent;
  let label = `${p.name}（${agent}）`;
  if (blocked) label += ` · ${blocked}`;
  else if (note) label += ` · ${note}`;
  return { label, disabled: Boolean(blocked), blockReason: blocked };
}

/** 弹层挂到 body：页头 sticky z-20 在 overflow 滚动容器里会盖住同树里的 fixed 遮罩，浅色下像顶部一条白。 */
function FloatLayer({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}

const actionBtn = inlineActionClass;

/** 历史条目最多展开显示条数（DTO 保留最近 20 条，行内只看最近几条） */
const HISTORY_PREVIEW = 5;

/** 「＋ 定时巡检」弹层：文献雷达 / 已有巡检技能 / 新建巡检技能（跟 AI 写 SKILL.md，确认才落盘） */
function CreateScheduleModal({
  projectRoot,
  onClose,
  onCreated,
  onDraftStarted,
}: {
  projectRoot: string;
  onClose: () => void;
  onCreated: (warning?: string) => Promise<void>;
  onDraftStarted: () => void;
}) {
  const profiles = useAppStore((s) => s.profiles);
  const caps = useAgentCaps();
  const [name, setName] = useState("文献雷达");
  const [skill, setSkill] = useState(LIT_WATCH_SKILL);
  const [skills, setSkills] = useState<SkillDto[]>([]);
  const [intent, setIntent] = useState("");
  const [frequency, setFrequency] = useState<"daily" | "weekly">("daily");
  const [weekday, setWeekday] = useState(1);
  const [time, setTime] = useState("09:00");
  const [profileId, setProfileId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isNew = skill === NEW_WATCH;
  const kindOptions = [
    ...scheduleSkillOptions(skills),
    { id: NEW_WATCH, name: "＋ 新建巡检技能" },
  ];

  useEffect(() => {
    let stale = false;
    invoke<SkillDto[]>("list_skills")
      .then((list) => {
        if (!stale) setSkills(list);
      })
      .catch(() => toast("巡检技能列表读取失败，可重新打开此弹层重试", "warning"));
    return () => {
      stale = true;
    };
  }, []);

  function onSkillChange(next: string) {
    if (next === NEW_WATCH) {
      setName((cur) =>
        cur.trim() === "" || cur === defaultScheduleName(skill, skills)
          ? "自定义巡检"
          : cur,
      );
    } else {
      setName((cur) =>
        followSkillName(
          cur === "自定义巡检" ? "" : cur,
          skill === NEW_WATCH ? LIT_WATCH_SKILL : skill,
          next,
          skills,
        ),
      );
    }
    setSkill(next);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const [hour, minute] = time.split(":").map((v) => parseInt(v, 10));
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      setError("时间格式不正确");
      return;
    }
    const picked = profiles.find((p) => p.id === profileId);
    if (picked) {
      const blocked = profileScheduleMeta(picked, caps).blockReason;
      if (blocked) {
        setError(blocked);
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      if (isNew) {
        const draft = await invoke<WatchSkillDraftDto>("start_watch_skill_draft", {
          input: {
            name: name.trim() || "自定义巡检",
            projectRoot,
            intent: intent.trim(),
            frequency,
            weekday: frequency === "weekly" ? weekday : null,
            hour,
            minute,
            profileId: profileId || null,
          },
        });
        beginAskAi({
          path: "",
          name: `巡检技能：${draft.name}`,
          cwd: projectRoot,
          root: projectRoot,
          reuseKey: `watch-skill:${projectRoot}:${draft.id}`,
          prompt: buildWatchSkillSeedPrompt({
            intent: draft.intent,
            draftRelPath: draft.draftRelPath,
            skillName: draft.skillName,
            scheduleName: draft.name,
          }),
          preview: false,
        });
        onDraftStarted();
        return;
      }
      await invoke<ScheduleDto>("create_schedule", {
        input: {
          name: name.trim() || undefined,
          projectRoot,
          skill,
          frequency,
          weekday: frequency === "weekly" ? weekday : null,
          hour,
          minute,
          profileId: profileId || null,
          linkedStep: null,
        },
      });
      if (!isLitWatchSkill(skill)) {
        try {
          await invoke("ensure_schedule_skill_distributed", {
            skill,
            profileId: profileId || null,
          });
        } catch (reason) {
          await onCreated(
            `定时任务已创建，但技能分发失败：${String(reason)}。请修复分发后再运行。`,
          );
          return;
        }
      }
      await onCreated();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FloatLayer>
    <Modal open title="定时巡检" onClose={onClose} size="md">
      <form onSubmit={submit}>
        <p className="mb-3 text-xs text-l3">
          {isNew
            ? "跟 AI 把巡检技能写出来，你确认后才保存并启用定时。"
            : isLitWatchSkill(skill)
              ? "按周期跑文献雷达，新命中追加到 notes/inbox.md。"
              : "按周期跑所选巡检技能，规范以该技能的 SKILL.md 为准。"}
        </p>
        {isLitWatchSkill(skill) && (
          <p className="-mt-2 mb-3 text-xs text-l3">
            建好后在这一行点「关键词」添加。每条巡检用自己的关键词，互不影响。
          </p>
        )}
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-xs text-l3">种类</span>
          <select
            className={fieldClass}
            value={skill}
            onChange={(e) => onSkillChange(e.target.value)}
          >
            {kindOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-xs text-l3">任务名</span>
          <input
            className={fieldClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="文献雷达"
          />
        </label>
        {isNew && (
          <label className="mb-3 block text-sm">
            <span className="mb-1 block text-xs text-l3">要做什么</span>
            <textarea
              className={`${fieldClass} min-h-24 resize-y py-2`}
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              required
              placeholder="例如：每天查各家服务商有没有上新模型、参数有没有变，对照项目里的表格列出差异。先写进待审核清单，不要直接改表。"
            />
          </label>
        )}
        <div className="mb-3 flex gap-2">
          <label className="block flex-1 text-sm">
            <span className="mb-1 block text-xs text-l3">周期</span>
            <select
              className={fieldClass}
              value={frequency}
              onChange={(e) =>
                setFrequency(e.target.value as "daily" | "weekly")
              }
            >
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
            </select>
          </label>
          {frequency === "weekly" && (
            <label className="block flex-1 text-sm">
              <span className="mb-1 block text-xs text-l3">星期</span>
              <select
                className={fieldClass}
                value={weekday}
                onChange={(e) => setWeekday(Number(e.target.value))}
              >
                {["一", "二", "三", "四", "五", "六", "日"].map((d, i) => (
                  <option key={d} value={i + 1}>
                    周{d}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block flex-1 text-sm">
            <span className="mb-1 block text-xs text-l3">时间</span>
            <input
              className={fieldClass}
              type="time"
              required
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </label>
        </div>
        <label className="mb-4 block text-sm">
          <span className="mb-1 block text-xs text-l3">运行配置（可选）</span>
          <span className="mb-1 block text-micro text-l4">
            文献雷达选 Codex。没有后缀的只在课题目录里写。写着「会批准全部操作」的不要用于定时巡检。
          </span>
          <select
            className={fieldClass}
            value={profileId}
            onChange={(e) => setProfileId(e.target.value)}
          >
            <option value="">自动（跟随默认解析）</option>
            {profiles.map((p) => {
              const meta = profileScheduleMeta(p, caps);
              return (
                <option key={p.id} value={p.id} disabled={meta.disabled}>
                  {meta.label}
                </option>
              );
            })}
          </select>
        </label>
        {profileId &&
          (() => {
            const p = profiles.find((x) => x.id === profileId);
            const caution = p
              ? headlessWriteCaution(caps[p.agent]?.headlessWrite)
              : null;
            return caution ? (
              <p className="mb-3 text-xs text-warn-text">⚠ {caution}</p>
            ) : null;
          })()}
        {error && <p className="mb-3 text-sm text-err-text">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm px-3 py-1.5 text-sm text-l2 hover:bg-hover"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={busy || !time || (isNew && !intent.trim())}
            className="rounded-sm border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
          >
            {busy
              ? isNew
                ? "正在开对话…"
                : "创建中…"
              : isNew
                ? "跟 AI 写技能"
                : "创建"}
          </button>
        </div>
      </form>
    </Modal>
    </FloatLayer>
  );
}

function RunHistoryItem({
  record,
  onReview,
  onDelete,
}: {
  record: RunRecordDto;
  onReview?: (record: RunRecordDto) => void;
  /** 删除这条运行历史（runId 缺失的旧记录没有删除入口） */
  onDelete?: (record: RunRecordDto) => void;
}) {
  // 行内单行截断只给预览（hover title 有全文但不易发现）；点击切换全文展开
  const [open, setOpen] = useState(false);
  const mark = scheduleStatusMark(record.status);
  return (
    <li className="flex min-w-0 items-start gap-2 py-1">
      <span className={`shrink-0 ${mark.className}`} title={mark.label}>
        {mark.glyph}
      </span>
      <span
        className="shrink-0 text-xs text-l4"
        title={absTime(record.at)}
      >
        {relTime(record.at)}
      </span>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`min-w-0 flex-1 cursor-pointer text-left text-xs text-l3 ${
          open ? "break-words whitespace-pre-wrap" : "truncate"
        }`}
        title={open ? "收起" : "展开全文"}
      >
        {open ? (
          <span className="block">
            <span>{record.summary || "（无简报）"}</span>
            {!!record.artifacts?.length && (
              <span className="mt-1 block text-l4">
                产物 {record.artifacts.length} 项：{record.artifacts.slice(0, 5).join("、")}
                {record.artifacts.length > 5 ? " …" : ""}
              </span>
            )}
          </span>
        ) : (
          summaryPreview(record) || "（无简报）"
        )}
      </button>
      {record.isolationPath && onReview && !record.adopted && (
        <button
          type="button"
          className={`${actionBtn} shrink-0`}
          onClick={() => onReview(record)}
        >
          去评审
        </button>
      )}
      {record.isolationPath && onReview && record.adopted && (
        <>
          <span className="shrink-0 self-center text-micro text-ok-text">已采纳</span>
          <button
            type="button"
            className={`${actionBtn} shrink-0`}
            title="这次运行的产物已经采纳进项目。这里只回看当时的新命中与你的留下/排除，不能再改。"
            onClick={() => onReview(record)}
          >
            查看
          </button>
        </>
      )}
      {onDelete && (
        <button
          type="button"
          className={`${iconActionClass} ${hoverRevealClass} shrink-0`}
          title={
            record.runId
              ? "删除这条运行记录（历史行、冻结证据和运行账目一起删；已采纳进项目的产物不受影响）"
              : "删除这条失败记录（启动即失败，没有运行账目与证据）"
          }
          aria-label={`删除运行记录：${record.at}`}
          onClick={() => onDelete(record)}
        >
          ✕
        </button>
      )}
    </li>
  );
}

function EditScheduleModal({
  schedule,
  profiles,
  onClose,
  onSaved,
}: {
  schedule: ScheduleDto;
  profiles: { id: string; name: string; agent: string }[];
  onClose: () => void;
  onSaved: (warning?: string) => Promise<void>;
}) {
  const [name, setName] = useState(schedule.name);
  const [skill, setSkill] = useState(schedule.skill);
  const [skills, setSkills] = useState<SkillDto[]>([]);
  const [frequency, setFrequency] = useState<"daily" | "weekly">(
    schedule.frequency === "weekly" ? "weekly" : "daily",
  );
  const [weekday, setWeekday] = useState(schedule.weekday ?? 1);
  const [time, setTime] = useState(`${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`);
  const [profileId, setProfileId] = useState(schedule.profileId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const caps = useAgentCaps();

  useEffect(() => {
    invoke<SkillDto[]>("list_skills")
      .then(setSkills)
      .catch(() => toast("巡检技能列表读取失败，可重新打开此弹层重试", "warning"));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const [hour, minute] = time.split(":").map((v) => parseInt(v, 10));
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      setError("时间格式不正确");
      return;
    }
    const picked = profiles.find((p) => p.id === profileId);
    if (picked) {
      const blocked = profileScheduleMeta(picked, caps).blockReason;
      if (blocked) {
        setError(blocked);
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      await invoke("update_schedule", {
        id: schedule.id,
        patch: {
          name: name.trim(),
          skill,
          frequency,
          weekday: frequency === "weekly" ? weekday : null,
          hour,
          minute,
          profileId: profileId || null,
          linkedStep: null,
        },
      });
      if (!isLitWatchSkill(skill)) {
        try {
          await invoke("ensure_schedule_skill_distributed", {
            skill,
            profileId: profileId || null,
          });
        } catch (reason) {
          await onSaved(
            `定时任务已保存，但技能分发失败：${String(reason)}。请修复分发后再运行。`,
          );
          return;
        }
      }
      await onSaved();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FloatLayer>
    <Modal open title="编辑定时任务" onClose={onClose} size="md">
      <form onSubmit={submit}>
        <label className="mb-3 block text-sm"><span className="mb-1 block text-xs text-l3">技能</span><select className={fieldClass} value={skill} onChange={(e) => setSkill(e.target.value)}>{scheduleSkillOptionsForEdit(skills, skill).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
        <label className="mb-3 block text-sm"><span className="mb-1 block text-xs text-l3">任务名</span><input className={fieldClass} required value={name} onChange={(e) => setName(e.target.value)} /></label>
        <div className="mb-3 flex gap-2">
          <label className="block flex-1 text-sm"><span className="mb-1 block text-xs text-l3">周期</span><select className={fieldClass} value={frequency} onChange={(e) => setFrequency(e.target.value as "daily" | "weekly")}><option value="daily">每天</option><option value="weekly">每周</option></select></label>
          {frequency === "weekly" && <label className="block flex-1 text-sm"><span className="mb-1 block text-xs text-l3">星期</span><select className={fieldClass} value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>{["一","二","三","四","五","六","日"].map((d, i) => <option key={d} value={i + 1}>周{d}</option>)}</select></label>}
          <label className="block flex-1 text-sm"><span className="mb-1 block text-xs text-l3">时间</span><input className={fieldClass} type="time" required value={time} onChange={(e) => setTime(e.target.value)} /></label>
        </div>
        <label className="mb-3 block text-sm"><span className="mb-1 block text-xs text-l3">运行配置</span><span className="mb-1 block text-micro text-l4">文献雷达选 Codex。没有后缀的只在课题目录里写。</span><select className={fieldClass} value={profileId} onChange={(e) => setProfileId(e.target.value)}><option value="">自动</option>{profiles.map((p) => { const meta = profileScheduleMeta(p, caps); return <option key={p.id} value={p.id} disabled={meta.disabled}>{meta.label}</option>; })}</select></label>
        {profileId && (() => { const p = profiles.find((x) => x.id === profileId); const caution = p ? headlessWriteCaution(caps[p.agent]?.headlessWrite) : null; return caution ? <p className="mb-3 text-xs text-warn-text">⚠ {caution}</p> : null; })()}
        {error && <p className="mb-3 text-sm text-err-text">{error}</p>}
        <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="rounded-sm px-3 py-1.5 text-sm text-l2 hover:bg-hover">取消</button><button type="submit" disabled={busy} className="rounded-sm border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text">{busy ? "保存中…" : "保存"}</button></div>
      </form>
    </Modal>
    </FloatLayer>
  );
}

function CommitWatchDraftModal({
  projectRoot,
  draft,
  onClose,
  onCommitted,
}: {
  projectRoot: string;
  draft: WatchSkillDraftDto;
  onClose: () => void;
  onCommitted: () => void;
}) {
  const [text, setText] = useState(draft.draftText ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let stale = false;
    invoke<WatchSkillDraftDto>("read_watch_skill_draft", {
      projectRoot,
      id: draft.id,
    })
      .then((d) => {
        if (!stale && d.draftText) setText(d.draftText);
      })
      .catch((reason) => {
        if (!stale) setError(`巡检草稿读取失败：${String(reason)}`);
      });
    return () => {
      stale = true;
    };
  }, [projectRoot, draft.id, draft.draftText]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) {
      setError("SKILL.md 还是空的");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await invoke("write_watch_skill_draft", {
        projectRoot,
        id: draft.id,
        text,
      });
      await invoke("commit_watch_skill_draft", {
        projectRoot,
        id: draft.id,
        draftText: text,
      });
      onCommitted();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FloatLayer>
    <Modal open title="确认落盘并启用定时" onClose={onClose} size="lg">
      <form onSubmit={submit}>
        <p className="mb-3 text-xs text-l3">
          预览技能「{draft.skillName}」。确认后写入技能库、分发到将要跑的 Agent，并创建定时任务「{draft.name}」。
        </p>
        <textarea
          className={`${fieldClass} min-h-64 flex-1 resize-y py-2 font-mono text-xs`}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {error && <p className="mt-2 text-sm text-err-text">{error}</p>}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-sm px-3 py-1.5 text-sm text-l2 hover:bg-hover">
            取消
          </button>
          <button
            type="submit"
            disabled={busy || !text.trim()}
            className="rounded-sm border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
          >
            {busy ? "保存中…" : "确认落盘"}
          </button>
        </div>
      </form>
    </Modal>
    </FloatLayer>
  );
}

function EditWatchSkillModal({
  skillId,
  skillName,
  onClose,
}: {
  skillId: string;
  skillName: string;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    invoke<string>("read_skill_md", { id: skillId })
      .then(setText)
      .catch((e) => setError(String(e)));
  }, [skillId]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await invoke("write_skill_md", { name: skillName, fullText: text });
      onClose();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FloatLayer>
    <Modal open title={`编辑技能：${skillName}`} onClose={onClose} size="lg">
      <form onSubmit={save}>
        <textarea
          className={`${fieldClass} min-h-64 flex-1 resize-y py-2 font-mono text-xs`}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {error && <p className="mt-2 text-sm text-err-text">{error}</p>}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-sm px-3 py-1.5 text-sm text-l2 hover:bg-hover">
            取消
          </button>
          <button
            type="submit"
            disabled={busy || !text.trim()}
            className="rounded-sm border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text disabled:opacity-50"
          >
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </Modal>
    </FloatLayer>
  );
}

/**
 * 项目分组内的「◔ 定时任务」区块（scheduler.rs）：只显示 projectRoot 命中本项目的任务。
 * 列表自取自刷：挂载时拉一次，scheduler-run-done 事件（全局通知在 App.tsx 另行监听）到达时重拉。
 */
export default function ScheduleSection({
  projectRoot,
  layout = "fold",
  subsVersion = 0,
  onSchedulesChanged,
}: {
  projectRoot: string;
  /** card = 办公侧栏常驻卡片，不折叠 */
  layout?: "fold" | "card";
  /** 同页保存订阅后的版本号：重读关键词数，文献雷达的立即跑跟着解禁 */
  subsVersion?: number;
  /** 增删改（含启停/改运行配置）成功后调用：同页兄弟组件（雷达卡）靠它感知任务集变化。
   *  新建/删除不发 scheduler-run-done（那只管跑完），没有这座桥雷达空态行要切页才翻新。 */
  onSchedulesChanged?: () => void;
}) {
  const isCard = layout === "card";
  const [open, setOpen] = useState(isCard);
  const [schedules, setSchedules] = useState<ScheduleDto[] | null>(null);
  const [drafts, setDrafts] = useState<WatchSkillDraftDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** 运行配置下拉（行内可改）：profile 列表从 store 取 */
  const profiles = useAppStore((s) => s.profiles);
  const setPage = useAppStore((s) => s.setPage);
  const setWorkspaceReviewRequest = useAppStore(
    (s) => s.setWorkspaceReviewRequest,
  );
  const caps = useAgentCaps();
  /** 手动「立即跑」中的任务 id：靠 scheduler-run-done 事件清除并触发重拉 */
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(
    null,
  );
  const [historyOpen, setHistoryOpen] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editSchedule, setEditSchedule] = useState<ScheduleDto | null>(null);
  const [commitDraft, setCommitDraft] = useState<WatchSkillDraftDto | null>(null);
  const [editSkill, setEditSkill] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [skills, setSkills] = useState<SkillDto[]>([]);
  /** 每条文献雷达自己的关键词数。缺这一项 = 还没拉到，不拦立即跑 */
  const [subCounts, setSubCounts] = useState<Record<string, number>>({});
  const [keywordFor, setKeywordFor] = useState<ScheduleDto | null>(null);

  async function load() {
    try {
      const [list, pending, skillList] = await Promise.all([
        invoke<ScheduleDto[]>("list_schedules"),
        invoke<WatchSkillDraftDto[]>("list_watch_skill_drafts", { projectRoot }).catch(
          () => [] as WatchSkillDraftDto[],
        ),
        invoke<SkillDto[]>("list_skills").catch(() => [] as SkillDto[]),
      ]);
      const mine = schedulesForProject(list, projectRoot, IS_WINDOWS);
      const counts = await Promise.all(
        mine
          .filter((s) => isLitWatchSkill(s.skill))
          .map(async (s) => {
            try {
              const subs = await invoke<WatchSubscriptionDto[]>(
                "list_watch_subscriptions",
                { projectRoot, scheduleId: s.id },
              );
              return [s.id, subs.length] as const;
            } catch {
              return null;
            }
          }),
      );
      setSchedules(mine);
      setDrafts(pending);
      setSkills(skillList);
      setSubCounts((cur) => {
        const next = { ...cur };
        for (const item of counts) {
          if (item) next[item[0]] = item[1];
        }
        return next;
      });
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  }

  useEffect(() => {
    let stale = false;
    const reload = () => {
      if (!stale) void load();
    };
    reload();
    let unlisten: (() => void) | undefined;
    const onDone = () => reload();
    listen<SchedulerRunDonePayload>("scheduler-run-done", (e) => {
      setRunning((cur) => {
        if (!cur.has(e.payload.scheduleId)) return cur;
        const next = new Set(cur);
        next.delete(e.payload.scheduleId);
        return next;
      });
      onDone();
    })
      .then((u) => (unlisten = u))
      .catch(() => toast("定时任务完成事件监听失败，列表可能不会自动刷新", "warning"));
    let unlistenAdopt: (() => void) | undefined;
    listen("watch-run-adopted", onDone)
      .then((u) => (unlistenAdopt = u))
      .catch(() => {});
    return () => {
      stale = true;
      unlisten?.();
      unlistenAdopt?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot]);

  useEffect(() => {
    if (!subsVersion) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subsVersion]);

  const waitingDraft = drafts.some((d) => !d.hasDraft);
  useEffect(() => {
    if (!waitingDraft) return;
    const t = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingDraft, projectRoot]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [open, projectRoot]);

  async function cancelSchedule(s: ScheduleDto) {
    try { await invoke("cancel_schedule_run", { id: s.id }); }
    catch (reason) { setError(String(reason)); }
  }

  async function toggleEnabled(s: ScheduleDto) {
    try {
      await invoke("update_schedule", {
        id: s.id,
        patch: { enabled: !s.enabled },
      });
      await load();
      onSchedulesChanged?.();
    } catch (reason) {
      setError(String(reason));
    }
  }

  /** 行内改运行配置：空串 = 清掉绑定回到「自动」（后端归一为 None，每次运行现解析） */
  async function changeProfile(s: ScheduleDto, profileId: string) {
    const picked = profiles.find((p) => p.id === profileId);
    if (picked) {
      const blocked = profileScheduleMeta(picked, caps).blockReason;
      if (blocked) {
        setError(blocked);
        return;
      }
    }
    try {
      await invoke("update_schedule", {
        id: s.id,
        patch: { profileId },
      });
      if (!isLitWatchSkill(s.skill)) {
        try {
          await invoke("ensure_schedule_skill_distributed", {
            skill: s.skill,
            profileId: profileId || null,
          });
        } catch (reason) {
          await load();
          // 配置已落盘（update_schedule 成功），任务集对兄弟组件仍是变更，桥不能漏
          onSchedulesChanged?.();
          setError(
            `运行配置已保存，但技能分发失败：${String(reason)}。请修复分发后再运行。`,
          );
          return;
        }
      }
      await load();
      onSchedulesChanged?.();
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function runNow(s: ScheduleDto) {
    setRunning((cur) => new Set(cur).add(s.id));
    setError(null);
    try {
      await invoke("run_schedule_now", { id: s.id });
      // 拉起失败会立即 reject；成功拉起后结果走 scheduler-run-done 事件
    } catch (reason) {
      setRunning((cur) => {
        const next = new Set(cur);
        next.delete(s.id);
        return next;
      });
      setError(String(reason));
    }
  }

  async function discardDraft(d: WatchSkillDraftDto) {
    if (
      !(await confirmDialog(`放弃巡检技能草稿「${d.name}」？`, {
        danger: true,
        confirmText: "放弃",
      }))
    )
      return;
    try {
      await invoke("discard_watch_skill_draft", {
        projectRoot,
        id: d.id,
      });
      await load();
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function removeSchedule(s: ScheduleDto) {
    let message = `删除定时任务「${s.name}」？历史记录一并删除。`;
    if (isLitWatchSkill(s.skill)) {
      message += "这条巡检的关键词一起删除，其他巡检不受影响。";
    }
    if (
      !(await confirmDialog(message, {
        danger: true,
        confirmText: "删除",
      }))
    )
      return;
    try {
      await invoke("delete_schedule", { id: s.id });
      await load();
      onSchedulesChanged?.();
    } catch (reason) {
      setError(String(reason));
    }
  }

  const count = (schedules?.length ?? 0) + drafts.length;
  const addBtn = (
    <button
      type="button"
      className={actionBtn}
      title="新建定时巡检（默认文献监控，可选其他技能）"
      onClick={() => setCreateOpen(true)}
    >
      ＋ 定时巡检
    </button>
  );

  return (
    <div className={isCard ? projectWellClass : "mb-2"}>
      {isCard ? (
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-xs font-medium text-l2">
            定时巡检{count > 0 ? `（${count}）` : ""}
          </h2>
          {addBtn}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-l3 hover:text-l1"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            <FoldMark open={open} boxed />
            ◔ 定时巡检{count > 0 ? `（${count}）` : ""}
          </button>
          {addBtn}
        </div>
      )}
      {(isCard || open) && (
        <div className={isCard ? "" : "mt-1 rounded-md ccode-well p-2"}>
          {error && <p className="py-1 text-xs text-err-text">{error}</p>}
          {schedules !== null &&
            schedules.length === 0 &&
            drafts.length === 0 &&
            !isCard && (
            <p className="text-xs text-l4">
              后台跑，不进正在进行。点「＋ 定时巡检」在这个项目里建。
            </p>
          )}
          {drafts.length > 0 && (
            <ul className="mb-1 space-y-0.5">
              {drafts.map((d) => (
                <li key={d.id} className="rounded-sm py-1.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate text-xs text-l2" title={d.name}>
                      {d.name}
                    </span>
                    <span className="shrink-0 text-micro text-l4">
                      {d.hasDraft ? "草稿待确认" : "正在写技能…"}
                    </span>
                    <span className="min-w-0 flex-1" />
                    {d.hasDraft ? (
                      <button
                        type="button"
                        className={actionBtn}
                        onClick={() => setCommitDraft(d)}
                      >
                        确认落盘
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={actionBtn}
                        onClick={() =>
                          beginAskAi({
                            path: "",
                            name: `巡检技能：${d.name}`,
                            cwd: projectRoot,
                            root: projectRoot,
                            reuseKey: `watch-skill:${projectRoot}:${d.id}`,
                            prompt: buildWatchSkillSeedPrompt({
                              intent: d.intent,
                              draftRelPath: d.draftRelPath,
                              skillName: d.skillName,
                              scheduleName: d.name,
                            }),
                            preview: false,
                          })
                        }
                      >
                        打开对话
                      </button>
                    )}
                    <button
                      type="button"
                      className={actionBtn}
                      onClick={() => void discardDraft(d)}
                    >
                      放弃
                    </button>
                  </div>
                  <p className="mt-0.5 truncate text-micro text-l4" title={d.intent}>
                    {d.intent}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {schedules !== null && schedules.length > 0 && (
            <ul className="space-y-0.5">
              {schedules.map((s) => {
                const needsKeywords =
                  isLitWatchSkill(s.skill) && subCounts[s.id] === 0;
                return (
                <li key={s.id} className="group rounded-sm py-1.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                    <Toggle
                      checked={s.enabled}
                      onChange={() => void toggleEnabled(s)}
                      label={`${s.enabled ? "停用" : "启用"}定时任务：${s.name}`}
                    />
                    <span
                      className="min-w-0 truncate text-xs text-l2"
                      title={s.name}
                    >
                      {s.name}
                    </span>
                    <span className="shrink-0 text-micro text-l4">
                      {frequencyLabel(s.frequency, s.weekday, s.hour, s.minute)}
                    </span>
                    <span aria-hidden="true" className="text-micro text-l4">·</span>
                    <span className="shrink-0 text-micro text-l4">{s.skill}</span>
                    {isLitWatchSkill(s.skill) && (
                      <button
                        type="button"
                        className={actionBtn}
                        onClick={() => setKeywordFor(s)}
                      >
                        关键词
                        {subCounts[s.id] != null ? ` ${subCounts[s.id]}` : ""}
                      </button>
                    )}
                    <span aria-hidden="true" className="text-micro text-l4">·</span>
                    <select
                      value={s.profileId ?? ""}
                      onChange={(e) => void changeProfile(s, e.target.value)}
                      title="运行配置：「自动」= 跟随默认解析（设置页 AI 专用配置 → 最近使用）；绑定配置被删会自动回落并在此标出"
                      className="min-w-0 max-w-52 shrink cursor-pointer truncate rounded-sm border border-transparent bg-transparent px-1 py-0.5 text-micro text-l4 outline-none hover:border-field hover:text-l2"
                    >
                      <option value="">自动</option>
                      {s.profileId &&
                        !profiles.some((p) => p.id === s.profileId) && (
                          <option value={s.profileId}>
                            原配置已删除（自动回落中）
                          </option>
                        )}
                      {profiles.map((p) => {
                        const meta = profileScheduleMeta(p, caps);
                        return (
                          <option
                            key={p.id}
                            value={p.id}
                            disabled={meta.disabled}
                          >
                            {meta.label}
                          </option>
                        );
                      })}
                    </select>
                    <span className="ml-auto flex shrink-0 items-center">
                      {s.history.length > 0 && (
                        <button
                          type="button"
                          className={`${actionBtn} inline-flex items-center gap-1`}
                          aria-expanded={historyOpen === s.id}
                          title="最近运行记录"
                          onClick={() =>
                            setHistoryOpen((v) => (v === s.id ? null : s.id))
                          }
                        >
                          <FoldMark open={historyOpen === s.id} /> 历史
                        </button>
                      )}
                      {s.runningRunId && (
                        <button
                          type="button"
                          className={actionBtn}
                          onClick={() => void cancelSchedule(s)}
                        >
                          停止运行
                        </button>
                      )}
                      <button
                        type="button"
                        className={`${iconActionClass} ${running.has(s.id) || needsKeywords ? "" : hoverRevealClass}`}
                        disabled={running.has(s.id) || needsKeywords}
                        title={
                          needsKeywords
                            ? "先在文献雷达里订阅关键词，再立即运行"
                            : "立即运行一次（结果走通知）"
                        }
                        aria-label={`立即运行：${s.name}`}
                        onClick={() => void runNow(s)}
                      >
                        {running.has(s.id) ? "◔" : "▶"}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          setMenu({ x: rect.right, y: rect.bottom + 4, id: s.id });
                        }}
                        title="任务操作"
                        aria-label={`任务操作：${s.name}`}
                        className={`${iconActionClass} ${hoverRevealClass}`}
                      >
                        ⋯
                      </button>
                    </span>
                  </div>
                  {s.history.length > 0 && historyOpen === s.id && (
                    <ul className="mt-0.5 divide-y divide-hairline border-l border-white/5 pl-11">
                      {s.history.slice(0, HISTORY_PREVIEW).map((r, i) => (
                        <RunHistoryItem
                          key={`${r.at}-${i}`}
                          record={r}
                          onReview={(rec) => {
                            if (!rec.isolationPath) return;
                            setWorkspaceReviewRequest({
                              worktreePath: rec.isolationPath,
                              runId: rec.runId ?? null,
                              requestId: crypto.randomUUID(),
                              returnTo: { projectRoot, surface: "schedules" },
                              locked: !!rec.adopted,
                            });
                            setPage("terminal");
                          }}
                          onDelete={(rec) => {
                            // 启动即失败的记录没有 runId，走（任务 id + 记录时间）定位
                            void (async () => {
                              if (
                                !(await confirmDialog(
                                  rec.runId
                                    ? `删除 ${relTime(rec.at)} 这条运行记录？历史行、冻结证据和运行账目一起删除；已采纳进项目的产物不受影响。`
                                    : `删除 ${relTime(rec.at)} 这条失败记录？它启动就失败了，只删历史行。`,
                                  { confirmText: "删除" },
                                ))
                              )
                                return;
                              try {
                                await invoke("schedule_run_delete", {
                                  runId: rec.runId,
                                  scheduleId: rec.runId ? undefined : s.id,
                                  at: rec.runId ? undefined : rec.at,
                                });
                                void load();
                              } catch (reason) {
                                setError(String(reason));
                              }
                            })();
                          }}
                        />
                      ))}
                    </ul>
                  )}
                </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      {menu && schedules && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          alignRight
          onClose={() => setMenu(null)}
          items={[
            {
              label: "编辑任务",
              onSelect: () => {
                const s = schedules.find((t) => t.id === menu.id);
                if (s) setEditSchedule(s);
              },
            },
            ...(() => {
              const s = schedules.find((t) => t.id === menu.id);
              if (!s || isLitWatchSkill(s.skill)) return [];
              const sk = skills.find((x) => x.name === s.skill);
              if (!sk) return [];
              return [
                {
                  label: "编辑技能",
                  onSelect: () => setEditSkill({ id: sk.id, name: sk.name }),
                },
              ];
            })(),
            {
              label: "删除任务",
              danger: true,
              onSelect: () => {
                const s = schedules.find((t) => t.id === menu.id);
                if (s) void removeSchedule(s);
              },
            },
          ]}
        />
      )}
      {keywordFor && (
        <SubscriptionsModal
          projectRoot={projectRoot}
          scheduleId={keywordFor.id}
          scheduleName={keywordFor.name}
          initial={[]}
          onClose={() => setKeywordFor(null)}
          onSaved={() => {
            setKeywordFor(null);
            void load();
          }}
        />
      )}
      {createOpen && (
        <CreateScheduleModal
          projectRoot={projectRoot}
          onClose={() => setCreateOpen(false)}
          onCreated={async (warning) => {
            setCreateOpen(false);
            setOpen(true);
            await load();
            onSchedulesChanged?.();
            if (warning) setError(warning);
          }}
          onDraftStarted={() => {
            setCreateOpen(false);
            setOpen(true);
            void load();
            onSchedulesChanged?.();
          }}
        />
      )}
      {editSchedule && (
        <EditScheduleModal
          schedule={editSchedule}
          profiles={profiles}
          onClose={() => setEditSchedule(null)}
          onSaved={async (warning) => {
            setEditSchedule(null);
            await load();
            onSchedulesChanged?.();
            if (warning) setError(warning);
          }}
        />
      )}
      {commitDraft && (
        <CommitWatchDraftModal
          projectRoot={projectRoot}
          draft={commitDraft}
          onClose={() => setCommitDraft(null)}
          onCommitted={() => {
            setCommitDraft(null);
            void load();
            // 落盘会 create_schedule 建任务（后端 commit_watch_skill_draft），
            // 这是桥最初要接的「新建」路径，漏了雷达卡要等别的事件才翻新
            onSchedulesChanged?.();
          }}
        />
      )}
      {editSkill && (
        <EditWatchSkillModal
          skillId={editSkill.id}
          skillName={editSkill.name}
          onClose={() => setEditSkill(null)}
        />
      )}
    </div>
  );
}
