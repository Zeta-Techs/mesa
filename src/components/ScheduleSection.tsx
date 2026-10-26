import {
  MessageSquarePlus,
  NotebookPen,
  Pencil,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ContextMenu from "./ContextMenu";
import { Modal } from "./Modal";
import { confirmDialog } from "./ConfirmDialog";
import {
  fieldClass,
  FoldMark,
  hoverRevealClass,
  iconActionClass,
  inlineActionClass,
  primaryActionClass,
  projectWellClass,
  secondaryActionClass,
  Toggle,
  InlineNotice,
  NoticeBar,
} from "./PageFrame";
import { useAppStore } from "../store";
import { IS_WINDOWS } from "../hotkeys";
import { absTime, relTime } from "../rel-time";
import {
  INTERVAL_HOURS,
  SCHEDULE_FREQUENCIES,
  TIMEOUT_CHOICES,
  frequencyLabel,
  hhmm,
  lastRunAction,
  lastRunBrief,
  nextRunLabel,
  otherProjectSchedules,
  scheduleStatusMark,
  schedulesForProject,
  skipHint,
  slotLabel,
  summaryPreview,
  triggerTag,
} from "../schedule-tasks";
import { baseName } from "../session-filter";
import { normalizeWorkMode } from "../work-mode";
import {
  LIT_WATCH_SKILL,
  buildWatchSkillSeedPrompt,
  defaultScheduleKind,
  defaultScheduleName,
  scheduleExamples,
  type ScheduleExample,
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
import CodexWinSandboxNotice from "./CodexWinSandboxNotice";
import { toast } from "../toast";
import { usePolling } from "../polling";

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

/** 周期表单值：time 恒为 HH:MM（每 N 小时只用它的分钟） */
interface CadenceValue {
  frequency: string;
  weekday: number;
  intervalHours: number;
  time: string;
}

const DEFAULT_CADENCE: CadenceValue = {
  frequency: "daily",
  weekday: 1,
  intervalHours: 1,
  time: "09:00",
};

function cadenceOf(s: {
  frequency: string;
  weekday?: number | null;
  intervalHours?: number | null;
  hour: number;
  minute: number;
}): CadenceValue {
  return {
    frequency: SCHEDULE_FREQUENCIES.some((f) => f.id === s.frequency) ? s.frequency : "daily",
    weekday: s.weekday ?? 1,
    intervalHours: s.intervalHours ?? 1,
    time: hhmm(s.hour, s.minute),
  };
}

/** 表单值 → 后端字段；时间不合法返回错误文案 */
function cadencePayload(v: CadenceValue):
  | {
      frequency: string;
      weekday: number | null;
      intervalHours: number | null;
      hour: number;
      minute: number;
    }
  | string {
  const [hour, minute] = v.time.split(":").map((x) => parseInt(x, 10));
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return "时间格式不正确";
  return {
    frequency: v.frequency,
    weekday: v.frequency === "weekly" ? v.weekday : null,
    intervalHours: v.frequency === "hourly" ? v.intervalHours : null,
    hour,
    minute,
  };
}

const WEEKDAY_NAMES = ["一", "二", "三", "四", "五", "六", "日"];

/** 周期一行：每天 / 工作日 / 每周（星期）/ 每隔几小时（间隔 + 在第几分）/ 仅手动 */
function CadenceFields({
  value,
  onChange,
}: {
  value: CadenceValue;
  onChange: (next: CadenceValue) => void;
}) {
  const set = (patch: Partial<CadenceValue>) => onChange({ ...value, ...patch });
  const [hh, mm] = value.time.split(":");
  const timed = ["daily", "weekdays", "weekly"].includes(value.frequency);
  return (
    <div className="mb-3 flex flex-wrap gap-2">
      <label className="block min-w-40 flex-1 text-sm">
        <span className="mb-1 block text-xs text-l3">周期</span>
        <select
          className={fieldClass}
          value={value.frequency}
          onChange={(e) => set({ frequency: e.target.value })}
        >
          {SCHEDULE_FREQUENCIES.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      {value.frequency === "weekly" && (
        <label className="block flex-1 text-sm">
          <span className="mb-1 block text-xs text-l3">星期</span>
          <select
            className={fieldClass}
            value={value.weekday}
            onChange={(e) => set({ weekday: Number(e.target.value) })}
          >
            {WEEKDAY_NAMES.map((d, i) => (
              <option key={d} value={i + 1}>
                周{d}
              </option>
            ))}
          </select>
        </label>
      )}
      {value.frequency === "hourly" && (
        <>
          <label className="block flex-1 text-sm">
            <span className="mb-1 block text-xs text-l3">间隔</span>
            <select
              className={fieldClass}
              value={value.intervalHours}
              onChange={(e) => set({ intervalHours: Number(e.target.value) })}
            >
              {INTERVAL_HOURS.map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? "每小时" : `每 ${n} 小时`}
                </option>
              ))}
            </select>
          </label>
          <label className="block flex-1 text-sm">
            <span className="mb-1 block text-xs text-l3">在第几分</span>
            <input
              className={fieldClass}
              type="number"
              min={0}
              max={59}
              value={Number(mm) || 0}
              onChange={(e) => {
                const m = Math.min(59, Math.max(0, Number(e.target.value) || 0));
                set({ time: `${hh || "00"}:${String(m).padStart(2, "0")}` });
              }}
            />
          </label>
        </>
      )}
      {timed && (
        <label className="block flex-1 text-sm">
          <span className="mb-1 block text-xs text-l3">时间</span>
          <input
            className={fieldClass}
            type="time"
            required
            value={value.time}
            onChange={(e) => set({ time: e.target.value })}
          />
        </label>
      )}
      {value.frequency === "manual" && (
        <p className="w-full text-micro text-l4">不定时，只在你点「立即运行」时跑。</p>
      )}
    </div>
  );
}

/** 「带附言运行」：只进这一轮的任务说明，不改任务本身 */
function RunWithNoteModal({
  schedule,
  onClose,
  onRun,
}: {
  schedule: ScheduleDto;
  onClose: () => void;
  onRun: (note: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <FloatLayer>
      <Modal open title={`带附言运行：${schedule.name}`} onClose={onClose} size="md">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            void onRun(note.trim()).finally(() => setBusy(false));
          }}
        >
          <p className="mb-2 text-xs text-l3">
            这句话只加进这一次的任务说明，不改任务和技能。例如「这次重点看 MoE 路由」「只查上周五以后的」。
          </p>
          <textarea
            className={`${fieldClass} min-h-24 resize-y py-2`}
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            placeholder="这一次要特别注意什么"
          />
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={onClose} className={secondaryActionClass}>
              取消
            </button>
            <button type="submit" disabled={busy || !note.trim()} className={primaryActionClass}>
              {busy ? "启动中…" : "立即运行"}
            </button>
          </div>
        </form>
      </Modal>
    </FloatLayer>
  );
}

/** 跨轮记忆：通用巡检每轮开头读、结束前更新的那份笔记（.ccode/watch/<任务id>/memory.md） */
function MemoryModal({
  schedule,
  onClose,
}: {
  schedule: ScheduleDto;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [source, setSource] = useState<string>("project");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let stale = false;
    invoke<{ text: string; source: string; exists: boolean }>("schedule_memory_read", {
      id: schedule.id,
    })
      .then((m) => {
        if (stale) return;
        setText(m.text);
        setSource(m.exists ? m.source : "none");
        setLoaded(true);
      })
      .catch((e) => {
        if (!stale) setError(String(e));
      });
    return () => {
      stale = true;
    };
  }, [schedule.id]);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await invoke("schedule_memory_write", { id: schedule.id, text });
      onClose();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <FloatLayer>
      <Modal open title={`跨轮记忆：${schedule.name}`} onClose={onClose} size="lg">
        <form onSubmit={save}>
          <p className="mb-2 text-xs text-l3">
            巡检每轮开头读它、结束前更新：处理过的条目、对比用的基线、还要跟进的事。改了保存，下一轮从你改过的接着记。
            {source === "isolation" && " 下面是最近一轮巡检记的（还没采纳进项目）。"}
            {source === "none" && " 还没有内容：第一次跑完后会出现。"}
          </p>
          <textarea
            className={`${fieldClass} min-h-64 resize-y py-2 font-mono text-xs`}
            value={text}
            disabled={!loaded}
            onChange={(e) => setText(e.target.value)}
          />
          {error && <NoticeBar tone="err" className="mt-2">{error}</NoticeBar>}
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={onClose} className={secondaryActionClass}>
              取消
            </button>
            <button type="submit" disabled={busy || !loaded} className={primaryActionClass}>
              {busy ? "保存中…" : "保存"}
            </button>
          </div>
        </form>
      </Modal>
    </FloatLayer>
  );
}

/** 新建巡检技能时任务名的默认值 */
const NEW_TASK_NAME = "新的定时任务";

/** 「＋ 新建定时任务」弹层：文献雷达 / 已有巡检技能 / 新建巡检技能（跟 AI 写 SKILL.md，确认才落盘）。
 *  种类默认按项目类型：科研默认文献雷达，其他项目默认新建巡检技能，且不列文献雷达（雷达卡只在科研项目出现）。
 *  运行配置与模型收在「更多设置」里：绝大多数任务跟随项目默认就够了。 */
function CreateScheduleModal({
  projectRoot,
  research,
  initial,
  onClose,
  onCreated,
  onDraftStarted,
}: {
  projectRoot: string;
  research: boolean;
  /** 空态示例点进来时的预填 */
  initial?: ScheduleExample | null;
  onClose: () => void;
  onCreated: (warning?: string, createdId?: string) => Promise<void>;
  onDraftStarted: () => void;
}) {
  const profiles = useAppStore((s) => s.profiles);
  const caps = useAgentCaps();
  const initialKind = initial?.kind ?? defaultScheduleKind(research);
  const [name, setName] = useState(
    initial?.name ?? (initialKind === "lit" ? "文献雷达" : NEW_TASK_NAME),
  );
  const [skill, setSkill] = useState(initialKind === "lit" ? LIT_WATCH_SKILL : NEW_WATCH);
  const [skills, setSkills] = useState<SkillDto[]>([]);
  const [intent, setIntent] = useState(initial?.intent ?? "");
  const [moreOpen, setMoreOpen] = useState(false);
  const [cadence, setCadence] = useState<CadenceValue>(DEFAULT_CADENCE);
  const [profileId, setProfileId] = useState("");
  const [modelId, setModelId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 关键词跟着任务走：新建时还没有任务 id，订阅在建好后从任务行打开。

  const isNew = skill === NEW_WATCH;
  const kindOptions = [
    ...scheduleSkillOptions(skills).filter((o) => research || o.id !== LIT_WATCH_SKILL),
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
          ? NEW_TASK_NAME
          : cur,
      );
    } else {
      setName((cur) =>
        followSkillName(
          cur === NEW_TASK_NAME ? "" : cur,
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
    // 新建巡检技能的周期由 AI 按描述建议、落盘时再定；这里先按默认（每天 09:00）占位
    const fields = cadencePayload(isNew ? DEFAULT_CADENCE : cadence);
    if (typeof fields === "string") {
      setError(fields);
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
            name: name.trim() || NEW_TASK_NAME,
            projectRoot,
            intent: intent.trim(),
            ...fields,
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
            scheduleRelPath: draft.scheduleRelPath,
            skillName: draft.skillName,
            scheduleName: draft.name,
          }),
          preview: false,
        });
        onDraftStarted();
        return;
      }
      const created = await invoke<ScheduleDto>("create_schedule", {
        input: {
          name: name.trim() || undefined,
          projectRoot,
          skill,
          ...fields,
          profileId: profileId || null,
          model: modelId || null,
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
      await onCreated(undefined, created?.id);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FloatLayer>
    <Modal open title="新建定时任务" onClose={onClose} size="md">
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
            建好后在这一行点「关键词」添加。每条雷达用自己的关键词，互不影响。
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
        {isNew ? (
          <p className="mb-3 text-xs text-l3">
            周期：AI 写技能时按你的描述给个建议（比如「工作日早上」「每 6 小时」），确认落盘时你再定。
          </p>
        ) : (
          <CadenceFields value={cadence} onChange={setCadence} />
        )}
        <button
          type="button"
          className="mb-3 flex items-center gap-1 text-xs text-l3 hover:text-l1"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((v) => !v)}
        >
          <FoldMark open={moreOpen} /> 更多设置
          {!moreOpen && (
            <span className="text-micro text-l4">
              {profileId
                ? `· ${profiles.find((p) => p.id === profileId)?.name ?? "已选连接"}`
                : "· 运行配置跟随项目默认"}
            </span>
          )}
        </button>
        {moreOpen && (
          <div className="mb-1">
          <label className="mb-4 block text-sm">
            <span className="mb-1 block text-xs text-l3">运行配置（可选）</span>
            <span className="mb-1 block text-micro text-l4">
              文献雷达选 Codex。没有后缀的只在课题目录里写。写着「会批准全部操作」的不要用于定时任务。
            </span>
            <select
              className={fieldClass}
              value={profileId}
              onChange={(e) => {
                setProfileId(e.target.value);
                setModelId("");
              }}
            >
              <option value="">跟随项目默认</option>
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
          <label className="mb-4 block text-sm">
            <span className="mb-1 block text-xs text-l3">模型（可选）</span>
            <select
              className={fieldClass}
              value={modelId}
              disabled={!profileId}
              onChange={(e) => setModelId(e.target.value)}
            >
              <option value="">
                {profileId ? "默认（名单第一个）" : "跟随执行时解析"}
              </option>
              {profileId &&
                (profiles.find((p) => p.id === profileId)?.models ?? []).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
            </select>
          </label>
          {profileId &&
            (() => {
              const p = profiles.find((x) => x.id === profileId);
              const caution = p
                ? headlessWriteCaution(caps[p.agent]?.headlessWrite)
                : null;
              // Windows 上的 Codex：没开沙箱时给「了解并开启」（确认后才生效），开着的可关
              if (p?.agent === "codex") return <CodexWinSandboxNotice agent={p.agent} fallback={caution} />;
              return caution ? (
                <p className="mb-3 text-xs text-warn-text">⚠ {caution}</p>
              ) : null;
            })()}
          </div>
        )}
        {error && <NoticeBar tone="err" className="mb-3">{error}</NoticeBar>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className={secondaryActionClass}
          >
            取消
          </button>
          <button
            type="submit"
            disabled={busy || (isNew && !intent.trim())}
            className={primaryActionClass}
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
  onOpenSession,
}: {
  record: RunRecordDto;
  onReview?: (record: RunRecordDto) => void;
  /** 删除这条运行历史（runId 缺失的旧记录没有删除入口） */
  onDelete?: (record: RunRecordDto) => void;
  /** 打开这次的后台对话（只读回放） */
  onOpenSession?: (agent: string, sessionId: string) => void;
}) {
  // 行内单行截断只给预览（hover title 有全文但不易发现）；点击切换全文展开
  const [open, setOpen] = useState(false);
  const mark = scheduleStatusMark(record.status);
  const skipped = record.status === "skipped";
  const tag = triggerTag(record);
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
      {tag && (
        <span
          className="shrink-0 self-center text-micro text-l4"
          title={
            record.trigger === "catchup"
              ? "到点时 Mesa 没开或电脑在睡眠，打开后补跑了这一次；Agent 知道原定时刻"
              : "你点「立即运行」跑的这一次"
          }
        >
          {tag}
        </span>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`min-w-0 flex-1 cursor-pointer text-left text-xs ${
          skipped || record.noop ? "text-l4" : "text-l3"
        } ${open ? "break-words whitespace-pre-wrap" : "truncate"}`}
        title={skipped ? skipHint(record.skipReason) : open ? "收起" : "展开全文"}
      >
        {open && !skipped ? (
          <span className="block">
            <span>{record.summary || "（无简报）"}</span>
            {record.noop && <span className="mt-1 block text-l4">这一轮没有新内容，所以没有通知你。</span>}
            {record.note && <span className="mt-1 block text-l4">附言：{record.note}</span>}
            {record.scheduledFor && (
              <span className="mt-1 block text-l4">原定 {slotLabel(record.scheduledFor)}</span>
            )}
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
      {record.agent && record.sessionId && onOpenSession && (
        <button
          type="button"
          className={`${actionBtn} shrink-0`}
          title="打开这次的后台对话，只读看 Agent 做了什么"
          onClick={() => onOpenSession(record.agent!, record.sessionId!)}
        >
          看过程
        </button>
      )}
      {record.isolationPath && onReview && !record.adopted && !record.noop && (
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
              : skipped
                ? "删除这条跳过记录"
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
  /** B3：模型下拉要读名单，扩 models 字段（调用方传的是 store 全量 Profile） */
  profiles: { id: string; name: string; agent: string; models?: string[] }[];
  onClose: () => void;
  onSaved: (warning?: string) => Promise<void>;
}) {
  const [name, setName] = useState(schedule.name);
  const [skill, setSkill] = useState(schedule.skill);
  const [skills, setSkills] = useState<SkillDto[]>([]);
  const [cadence, setCadence] = useState<CadenceValue>(cadenceOf(schedule));
  const [skipIfUnreviewed, setSkipIfUnreviewed] = useState(
    schedule.skipIfUnreviewed ?? !isLitWatchSkill(schedule.skill),
  );
  const [timeoutMinutes, setTimeoutMinutes] = useState(schedule.timeoutMinutes ?? 30);
  const [profileId, setProfileId] = useState(schedule.profileId ?? "");
  const [modelId, setModelId] = useState(schedule.model ?? "");
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
    const fields = cadencePayload(cadence);
    if (typeof fields === "string") {
      setError(fields);
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
          ...fields,
          skipIfUnreviewed,
          timeoutMinutes,
          // 清空运行配置/模型必须发空串：后端 Option<Option> 语义下显式 null ≡ 缺失 ≡ 不改，
          // 发 null 会让「选回自动」静默失效（行内改口径早已是空串，这里对齐）
          profileId,
          model: modelId,
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
        <CadenceFields value={cadence} onChange={setCadence} />
        <label className="mb-3 block text-sm"><span className="mb-1 block text-xs text-l3">运行配置</span><span className="mb-1 block text-micro text-l4">文献雷达选 Codex。没有后缀的只在课题目录里写。</span><select className={fieldClass} value={profileId} onChange={(e) => { setProfileId(e.target.value); setModelId(""); }}><option value="">跟随项目默认</option>{profiles.map((p) => { const meta = profileScheduleMeta(p, caps); return <option key={p.id} value={p.id} disabled={meta.disabled}>{meta.label}</option>; })}</select></label>
        <label className="mb-3 block text-sm"><span className="mb-1 block text-xs text-l3">模型</span><select className={fieldClass} value={modelId} disabled={!profileId} onChange={(e) => setModelId(e.target.value)}><option value="">{profileId ? "默认（名单第一个）" : "跟随执行时解析"}</option>{profileId && (profiles.find((p) => p.id === profileId)?.models ?? []).map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
        {profileId && (() => { const p = profiles.find((x) => x.id === profileId); const caution = p ? headlessWriteCaution(caps[p.agent]?.headlessWrite) : null; if (p?.agent === "codex") return <CodexWinSandboxNotice agent={p.agent} fallback={caution} />; return caution ? <InlineNotice tone="warn" className="mb-3">{caution}</InlineNotice> : null; })()}
        <label className="mb-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={skipIfUnreviewed}
            onChange={(e) => setSkipIfUnreviewed(e.target.checked)}
          />
          <span>
            <span className="block text-xs text-l2">上一轮还没评审时，跳过这一轮</span>
            <span className="block text-micro text-l4">
              免得没看的产物越攒越多；跳过的会记在历史里。文献雷达默认不跳（几次没采纳也能分别采纳）。
            </span>
          </span>
        </label>
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-xs text-l3">单次上限</span>
          <select
            className={fieldClass}
            value={timeoutMinutes}
            onChange={(e) => setTimeoutMinutes(Number(e.target.value))}
          >
            {TIMEOUT_CHOICES.map((m) => (
              <option key={m} value={m}>
                {m} 分钟{m === 30 ? "（默认）" : ""}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-micro text-l4">
            跑到上限就停下记「超时」。连续 3 次没跑成（失败或超时）会自动暂停。
          </span>
        </label>
        {error && <NoticeBar tone="err" className="mb-3">{error}</NoticeBar>}
        <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className={secondaryActionClass}>取消</button><button type="submit" disabled={busy} className={primaryActionClass}>{busy ? "保存中…" : "保存"}</button></div>
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
  onCommitted: (createdId?: string) => void;
}) {
  const [text, setText] = useState(draft.draftText ?? "");
  const [suggestion, setSuggestion] = useState(draft.suggestion ?? null);
  // 周期：AI 按描述给了建议就预填建议，否则用建草稿时的默认；人可改
  const [cadence, setCadence] = useState<CadenceValue>(
    cadenceOf(draft.suggestion ?? draft),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let stale = false;
    invoke<WatchSkillDraftDto>("read_watch_skill_draft", {
      projectRoot,
      id: draft.id,
    })
      .then((d) => {
        if (stale) return;
        if (d.draftText) setText(d.draftText);
        if (d.suggestion && !suggestion) {
          setSuggestion(d.suggestion);
          setCadence(cadenceOf(d.suggestion));
        }
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
    const schedule = cadencePayload(cadence);
    if (typeof schedule === "string") {
      setError(schedule);
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
      const created = await invoke<ScheduleDto>("commit_watch_skill_draft", {
        projectRoot,
        id: draft.id,
        draftText: text,
        schedule,
      });
      onCommitted(created?.id);
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
        <p className="mb-1 text-xs text-l3">
          {suggestion
            ? `AI 按你的描述建议：${frequencyLabel(suggestion.frequency, suggestion.weekday ?? null, suggestion.hour, suggestion.minute, suggestion.intervalHours)}${suggestion.reason ? `（${suggestion.reason}）` : ""}。可以改。`
            : "AI 没给周期建议，先按每天 09:00 填好了。可以改。"}
        </p>
        <CadenceFields value={cadence} onChange={setCadence} />
        <textarea
          className={`${fieldClass} min-h-64 flex-1 resize-y py-2 font-mono text-xs`}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {error && <NoticeBar tone="err" className="mt-2">{error}</NoticeBar>}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={secondaryActionClass}>
            取消
          </button>
          <button
            type="submit"
            disabled={busy || !text.trim()}
            className={primaryActionClass}
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
        {error && <NoticeBar tone="err" className="mt-2">{error}</NoticeBar>}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={secondaryActionClass}>
            取消
          </button>
          <button
            type="submit"
            disabled={busy || !text.trim()}
            className={primaryActionClass}
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
  showOthers = false,
  workMode,
}: {
  projectRoot: string;
  /** 项目工作方式：决定新建时的默认种类和空态示例；不传按科研（旧调用点） */
  workMode?: string | null;
  /** card = 办公侧栏常驻卡片，不折叠 */
  layout?: "fold" | "card";
  /** 同页保存订阅后的版本号：重读关键词数，文献雷达的立即跑跟着解禁 */
  subsVersion?: number;
  /** 增删改（含启停/改运行配置）成功后调用：同页兄弟组件（雷达卡）靠它感知任务集变化。
   *  新建/删除不发 scheduler-run-done（那只管跑完），没有这座桥雷达空态行要切页才翻新。 */
  onSchedulesChanged?: () => void;
  /** 底部折叠列出其他项目的定时任务（只读总览，点一行去那个项目）；只在项目「定时任务」页签开 */
  showOthers?: boolean;
}) {
  const isCard = layout === "card";
  const mode = workMode ? normalizeWorkMode(workMode) : "research";
  const research = mode === "research";
  const [open, setOpen] = useState(isCard);
  /** 空态示例点进来时给新建弹层的预填 */
  const [createInitial, setCreateInitial] = useState<ScheduleExample | null>(null);
  /** 刚建好的任务：行下提示「现在试跑一次？」，跑过或点「不用」就收起 */
  const [trialFor, setTrialFor] = useState<string | null>(null);
  const [schedules, setSchedules] = useState<ScheduleDto[] | null>(null);
  const [drafts, setDrafts] = useState<WatchSkillDraftDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** 行上只在钉了连接时写连接名（改连接去编辑弹层）：profile 列表从 store 取 */
  const profiles = useAppStore((s) => s.profiles);
  const setPage = useAppStore((s) => s.setPage);
  const setWorkspaceReviewRequest = useAppStore(
    (s) => s.setWorkspaceReviewRequest,
  );
  const setOpenSessionReq = useAppStore((s) => s.setOpenSessionReq);
  const setSelectProjectReq = useAppStore((s) => s.setSelectProjectReq);
  const setProjectFocusReq = useAppStore((s) => s.setProjectFocusReq);
  const [others, setOthers] = useState<ScheduleDto[]>([]);
  const [othersOpen, setOthersOpen] = useState(false);
  const [noteFor, setNoteFor] = useState<ScheduleDto | null>(null);
  const [memoryFor, setMemoryFor] = useState<ScheduleDto | null>(null);
  /** 手动「立即跑」中的任务 id：靠 scheduler-run-done 事件清除并触发重拉 */
  const [running, setRunning] = useState<Set<string>>(new Set());
  /** 全部项目里正在跑的雷达数（排队中 tooltip 用：排队的原因是它们占着闸门） */
  const [runningCount, setRunningCount] = useState(0);
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
  /** 同一份订阅的关键词原文：只有 1 个时行内直接显示内容（2026-10-16 优化计划 2b），其余回计数 */
  const [subKeywords, setSubKeywords] = useState<Record<string, string[]>>({});
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
      setOthers(otherProjectSchedules(list, projectRoot, IS_WINDOWS));
      setRunningCount(list.filter((t) => t.runningRunId).length);
      const counts = await Promise.all(
        mine
          .filter((s) => isLitWatchSkill(s.skill))
          .map(async (s) => {
            try {
              const subs = await invoke<WatchSubscriptionDto[]>(
                "list_watch_subscriptions",
                { projectRoot, scheduleId: s.id },
              );
              return [s.id, subs.length, subs.map((x) => x.keyword)] as const;
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
      setSubKeywords((cur) => {
        const next = { ...cur };
        for (const item of counts) {
          if (item) next[item[0]] = item[2];
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
    // tick/手动拉起即刷新：排队中的卡要能翻成运行中（不发这条事件的旧后端无此刷新）
    let unlistenStarted: (() => void) | undefined;
    listen("scheduler-run-started", onDone)
      .then((u) => (unlistenStarted = u))
      .catch(() => {});
    let unlistenAdopt: (() => void) | undefined;
    listen("watch-run-adopted", onDone)
      .then((u) => (unlistenAdopt = u))
      .catch(() => {});
    return () => {
      stale = true;
      unlisten?.();
      unlistenAdopt?.();
      unlistenStarted?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot]);

  useEffect(() => {
    if (!subsVersion) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subsVersion]);

  const waitingDraft = drafts.some((d) => !d.hasDraft);
  usePolling(() => load(), waitingDraft ? 4000 : null);
  usePolling(() => load(), open ? 5000 : null);

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

  async function runNow(s: ScheduleDto, note?: string) {
    setRunning((cur) => new Set(cur).add(s.id));
    setError(null);
    try {
      await invoke("run_schedule_now", note ? { id: s.id, note } : { id: s.id });
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
      message += "这条雷达的关键词一起删除，其他雷达不受影响。";
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

  /** 总览一行点进去：选中那个项目并切到它的「定时任务」页签 */
  function goProjectSchedules(root: string) {
    setSelectProjectReq?.(root);
    setProjectFocusReq?.({ projectRoot: root, focus: "schedule", token: Date.now() });
    setPage("workspaces");
  }

  function otherStatus(o: ScheduleDto): string {
    if (o.runningRunId) return "运行中";
    if (!o.enabled) return o.pausedReason ? "已自动暂停" : "已停用";
    return nextRunLabel(o) ?? "仅手动";
  }

  /** 打开某次运行的评审（历史行与「上次」行共用） */
  function openReview(rec: RunRecordDto) {
    if (!rec.isolationPath) return;
    setWorkspaceReviewRequest({
      worktreePath: rec.isolationPath,
      runId: rec.runId ?? null,
      requestId: crypto.randomUUID(),
      returnTo: { projectRoot, surface: "schedules" },
      locked: !!rec.adopted,
    });
    setPage("terminal");
  }

  function openProcess(agent: string, sessionId: string) {
    setOpenSessionReq({ agent, sessionId });
    setPage("sessions");
  }

  function openCreate(initial: ScheduleExample | null = null) {
    setCreateInitial(initial);
    setCreateOpen(true);
  }

  const count = (schedules?.length ?? 0) + drafts.length;
  const addBtn = (
    <button
      type="button"
      className={actionBtn}
      title={research ? "新建定时任务（默认文献雷达，也可以选巡检技能或新建一个）" : "新建定时任务（让 AI 按你的描述写一个巡检技能）"}
      onClick={() => openCreate()}
    >
      ＋ 新建定时任务
    </button>
  );

  return (
    <div className={isCard ? projectWellClass : "mb-2"}>
      {isCard ? (
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-xs font-medium text-l2">
            定时任务{count > 0 ? `（${count}）` : ""}
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
            ◔ 定时任务{count > 0 ? `（${count}）` : ""}
          </button>
          {addBtn}
        </div>
      )}
      {(isCard || open) && (
        <div className={isCard ? "" : "mt-1 rounded-md ccode-well p-2"}>
          {error && <InlineNotice tone="err" className="py-1">{error}</InlineNotice>}
          {schedules !== null && schedules.length === 0 && drafts.length === 0 && (
            <div className="text-xs text-l3">
              <p>
                还没有定时任务。Agent 按你定的周期在后台跑，结果先放在隔离目录，你评审后才进项目。
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-micro text-l4">试试：</span>
                {scheduleExamples(mode).map((ex) => (
                  <button
                    key={ex.label}
                    type="button"
                    className="rounded-full border border-hairline px-2.5 py-0.5 text-micro text-l2 hover:bg-hover hover:text-l1"
                    title={ex.intent ?? "按周期查新文献，新命中先待你评审"}
                    onClick={() => openCreate(ex)}
                  >
                    {ex.label}
                  </button>
                ))}
              </div>
            </div>
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
                              scheduleRelPath: d.scheduleRelPath,
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
                const last = s.history[0];
                const lastBrief = last ? lastRunBrief(last, isLitWatchSkill(s.skill)) : null;
                const lastAction = last ? lastRunAction(last) : null;
                const pinned = s.profileId
                  ? profiles.find((p) => p.id === s.profileId) ?? null
                  : null;
                const isRunning = Boolean(s.runningRunId) || running.has(s.id);
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
                      title={isLitWatchSkill(s.skill) ? s.name : `${s.name} · 巡检技能 ${s.skill}`}
                    >
                      {s.name}
                    </span>
                    {!s.enabled && s.pausedReason && (
                      <span className="shrink-0 text-micro text-warn-text" title={s.pausedReason}>
                        已自动暂停
                      </span>
                    )}
                    {s.queued && !s.runningRunId && !running.has(s.id) && !needsKeywords && (
                      <span
                        className="shrink-0 text-micro text-l3"
                        title={`到点了，正在排队：${runningCount > 0 ? `${runningCount} 个雷达在跑` : "上一条还没收尾"}，空出来就自动接上（同一项目一次只跑一条）`}
                      >
                        排队中
                      </span>
                    )}
                    <span
                      className="shrink-0 text-micro text-l4"
                      title={s.nextRunAt ? `下一次：${slotLabel(s.nextRunAt)}` : undefined}
                    >
                      {frequencyLabel(s.frequency, s.weekday, s.hour, s.minute, s.intervalHours)}
                      {nextRunLabel(s) ? ` · ${nextRunLabel(s)}` : ""}
                    </span>
                    {isLitWatchSkill(s.skill) && (
                      <button
                        type="button"
                        className={actionBtn}
                        title={
                          subCounts[s.id] === 1 && subKeywords[s.id]?.[0]
                            ? `唯一关键词：${subKeywords[s.id][0]}（点击管理）`
                            : "管理这条巡检的关键词"
                        }
                        onClick={() => setKeywordFor(s)}
                      >
                        {subCounts[s.id] === 1 && subKeywords[s.id]?.[0]
                          ? subKeywords[s.id][0]
                          : `关键词${subCounts[s.id] != null ? ` ${subCounts[s.id]}` : ""}`}
                      </button>
                    )}
                    {s.profileId && (
                      <span
                        className={`min-w-0 max-w-52 truncate text-micro ${pinned ? "text-l4" : "text-warn-text"}`}
                        title={
                          pinned
                            ? "这条任务钉了这条连接，不跟随项目默认；在「编辑任务」里改"
                            : "钉住的连接已删除，下次运行会失败并自动暂停；在「编辑任务」里换一条"
                        }
                      >
                        {pinned ? pinned.name : "原连接已删除"}
                      </span>
                    )}
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
                  {isRunning ? (
                    <p className="mt-0.5 pl-11 text-micro text-l3">正在跑…结果出来会通知你</p>
                  ) : (
                    last &&
                    lastBrief && (
                      <p className="mt-0.5 flex min-w-0 items-center gap-1.5 pl-11 text-micro">
                        <span className={scheduleStatusMark(last.status).className}>
                          {scheduleStatusMark(last.status).glyph}
                        </span>
                        <span className="shrink-0 text-l4" title={absTime(last.at)}>
                          上次 {relTime(last.at)}
                        </span>
                        <span
                          className={`min-w-0 truncate ${
                            lastBrief.tone === "err"
                              ? "text-err-text"
                              : lastBrief.tone === "warn"
                                ? "text-warn-text"
                                : lastBrief.tone === "muted"
                                  ? "text-l4"
                                  : "text-l3"
                          }`}
                          title={last.status === "skipped" ? skipHint(last.skipReason) : last.summary}
                        >
                          {lastBrief.text}
                        </span>
                        {lastAction === "review" && (
                          <button
                            type="button"
                            className={`${actionBtn} h-auto shrink-0 px-1`}
                            onClick={() => openReview(last)}
                          >
                            去评审
                          </button>
                        )}
                        {lastAction === "process" && last.agent && last.sessionId && (
                          <button
                            type="button"
                            className={`${actionBtn} h-auto shrink-0 px-1`}
                            title="打开这次的后台对话，只读看 Agent 做了什么"
                            onClick={() => openProcess(last.agent!, last.sessionId!)}
                          >
                            看过程
                          </button>
                        )}
                      </p>
                    )
                  )}
                  {trialFor === s.id && !isRunning && (
                    <p className="mt-1 flex flex-wrap items-center gap-1.5 pl-11 text-micro text-l3">
                      {needsKeywords
                        ? "建好了。先点「关键词」订阅，再试跑一次，看看第一轮跑不跑得通。"
                        : "建好了。现在试跑一次，看看第一轮跑不跑得通？技能没分发、连接不能写盘这类问题当场就能看到。"}
                      {!needsKeywords && (
                        <button
                          type="button"
                          className={`${actionBtn} h-auto px-1.5 text-micro`}
                          onClick={() => {
                            setTrialFor(null);
                            void runNow(s);
                          }}
                        >
                          试跑一次
                        </button>
                      )}
                      <button
                        type="button"
                        className={`${actionBtn} h-auto px-1.5 text-micro`}
                        onClick={() => setTrialFor(null)}
                      >
                        不用
                      </button>
                    </p>
                  )}
                  {!s.enabled && s.pausedReason && (
                    <p className="mt-0.5 pl-11 text-micro text-warn-text">
                      {s.pausedReason}
                      <button
                        type="button"
                        className={`${actionBtn} ml-1 h-auto px-1`}
                        onClick={() => void toggleEnabled(s)}
                      >
                        重新打开
                      </button>
                    </p>
                  )}
                  {s.history.length > 0 && historyOpen === s.id && (
                    <ul className="mt-0.5 divide-y divide-hairline border-l border-white/5 pl-11">
                      {s.history.slice(0, HISTORY_PREVIEW).map((r, i) => (
                        <RunHistoryItem
                          key={`${r.at}-${i}`}
                          record={r}
                          onReview={openReview}
                          onOpenSession={openProcess}
                          onDelete={(rec) => {
                            // 启动即失败 / 跳过的记录没有 runId，走（任务 id + 记录时间）定位
                            void (async () => {
                              if (
                                !(await confirmDialog(
                                  rec.runId
                                    ? `删除 ${relTime(rec.at)} 这条运行记录？历史行、冻结证据和运行账目一起删除；已采纳进项目的产物不受影响。`
                                    : rec.status === "skipped"
                                      ? `删除 ${relTime(rec.at)} 这条跳过记录？只删历史行。`
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
              icon: Pencil,
              label: "编辑任务",
              onSelect: () => {
                const s = schedules.find((t) => t.id === menu.id);
                if (s) setEditSchedule(s);
              },
            },
            ...(() => {
              const s = schedules.find((t) => t.id === menu.id);
              if (!s) return [];
              const blocked =
                running.has(s.id) || (isLitWatchSkill(s.skill) && subCounts[s.id] === 0);
              return blocked
                ? []
                : [
                    {
                      icon: MessageSquarePlus,
                      label: "带附言运行…",
                      onSelect: () => setNoteFor(s),
                    },
                  ];
            })(),
            ...(() => {
              const s = schedules.find((t) => t.id === menu.id);
              if (!s || isLitWatchSkill(s.skill)) return [];
              const items = [
                {
                  icon: NotebookPen,
                  label: "跨轮记忆",
                  onSelect: () => setMemoryFor(s),
                },
              ];
              const sk = skills.find((x) => x.name === s.skill);
              if (!sk) return items;
              return [
                ...items,
                {
                  icon: Sparkles,
                  label: "编辑技能",
                  onSelect: () => setEditSkill({ id: sk.id, name: sk.name }),
                },
              ];
            })(),
            {
              icon: Trash2,
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
          research={research}
          initial={createInitial}
          onClose={() => setCreateOpen(false)}
          onCreated={async (warning, createdId) => {
            setCreateOpen(false);
            setOpen(true);
            await load();
            onSchedulesChanged?.();
            if (warning) setError(warning);
            else if (createdId) setTrialFor(createdId);
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
          onCommitted={(createdId) => {
            setCommitDraft(null);
            if (createdId) setTrialFor(createdId);
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
      {noteFor && (
        <RunWithNoteModal
          schedule={noteFor}
          onClose={() => setNoteFor(null)}
          onRun={async (note) => {
            const s = noteFor;
            setNoteFor(null);
            await runNow(s, note);
          }}
        />
      )}
      {memoryFor && (
        <MemoryModal schedule={memoryFor} onClose={() => setMemoryFor(null)} />
      )}
      {showOthers && others.length > 0 && (
        <div className="mt-3 border-t border-hairline pt-2">
          <button
            type="button"
            className="flex items-center gap-1 text-micro text-l3 hover:text-l1"
            aria-expanded={othersOpen}
            onClick={() => setOthersOpen((v) => !v)}
          >
            <FoldMark open={othersOpen} /> 其他项目的定时任务（{others.length}）
          </button>
          {othersOpen && (
            <ul className="mt-1 space-y-0.5">
              {others.map((o) => {
                const mark = o.lastStatus ? scheduleStatusMark(o.lastStatus) : null;
                return (
                  <li key={o.id}>
                    <button
                      type="button"
                      className="flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left text-xs hover:bg-hover"
                      title="去这个项目的定时任务页"
                      onClick={() => goProjectSchedules(o.projectRoot)}
                    >
                      <span className="min-w-0 max-w-40 shrink truncate text-l2">
                        {baseName(o.projectRoot)}
                      </span>
                      <span className="min-w-0 truncate text-l3">{o.name}</span>
                      <span className="shrink-0 text-micro text-l4">
                        {frequencyLabel(o.frequency, o.weekday, o.hour, o.minute, o.intervalHours)}
                      </span>
                      <span className="ml-auto flex shrink-0 items-center gap-1 text-micro text-l4">
                        {mark && (
                          <span className={mark.className} title={`上次：${mark.label}`}>
                            {mark.glyph}
                          </span>
                        )}
                        {otherStatus(o)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
