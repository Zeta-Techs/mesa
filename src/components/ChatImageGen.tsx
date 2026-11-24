// 聊天里的「出图」模式（2026-11-24 用户拍板，纯逻辑在 chat-image-gen.ts）：
// - 输入框里「+」旁边一个小胶囊「图标 模型 ⌄ ×」（2026-11-24 用户选：收进输入框，不在框上方另起一条）：点模型换一个，
//   只管这个对话（后端 image_gen_chat.rs 按标签记，出图工具每次现读，顺序 --model > 本对话选的 > 连接页默认）；
//   选回连接页默认那个 = 跟着默认走。胶囊发完留着，× 退回普通对话
// - 发之前查：没出图工具 / 没模型拦下，这家没开 image-gen 只提醒并给「打开」——只在有问题时框里多一行小字
// - 几个模型对比（2026-11-24 用户要）：选择框里「对比几个」进多选（最多 4），胶囊写「N 个模型对比」，那一行点名全部、技能每个各出一版；
//   点其中一张结果的「改图」，胶囊回到出这张的那个模型（producerOf 查调用记录），对比只在前端、不进 image_gen_chat 记录；
//   勾着的几个按标签存 localStorage（重启接回这个标签仍是对比）
// - 出图进度（2026-11-24 用户：生图过程中聊天层没有状态）：生成中每 2 秒读一次调用记录，开始了没出完的每个画一条估算进度，
//   估算用本机以往耗时（与连接页「试出与对比」共用 ccode.imageGen.durations），不依赖这家 Agent 报不报状态
// - 发出去由 Mesa 在描述前写一行固定写法（技能认它就必须调出图工具）；这一轮结束时出图工具一次没被调用，框上方说一声
// - 出图工具每次调用记一条，聊天里的图下面写是哪个模型出的
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, X } from "lucide-react";
import ImageModelPicker from "./ImageModelPicker";
import ImageModelMark from "./ImageModelMark";
import type { ComposerImageGen, ComposerNotice } from "./ChatComposer";
import {
  IMAGE_GEN_SKILL,
  MAX_COMPARE,
  calledSince,
  captionsByPath,
  finishedDurations,
  inflightCalls,
  waitedText,
  imageGenBlocks,
  imageGenDirective,
  imageGenIssue,
  producerOf,
  type ImageGenCall,
  type ImageGenIssue,
} from "../chat-image-gen";
import type { MesaCommand } from "../composer-assist";
import {
  estimateSeconds,
  gatewayLabel,
  itemKey,
  progressAt,
  pushRecent,
  recordDuration,
  type ImageModelItem,
} from "../image-models";
import { IS_WINDOWS } from "../hotkeys";
import { PROFILES_PANE_REQ_KEY } from "../profiles-pane";
import { useAppStore } from "../store";
import type { SkillDto } from "../types";

type Choice = { gatewayId: string; model: string };
type CandidateGroup = { gatewayId: string; gatewayName: string; models: string[] };

/** 与连接页出图模型一块共用「最近用过」与各模型耗时 */
const LS_RECENT = "ccode.imageGen.recent";
const LS_DURATIONS = "ccode.imageGen.durations";
/** 这个标签勾着对比的几个（itemKey 列表） */
const lsCompare = (tabId: string) => `ccode.imageGen.compare.${tabId}`;
/** 生成中多久读一次调用记录（画进度用） */
const POLL_MS = 2000;
/** 一轮结束后再等一会儿再查：有的 Agent 结束标记比最后一条命令早到 */
const SETTLE_MS = 2500;

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(LS_RECENT);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 存不了只影响估时与重启后的对比 */
  }
}

function writeRecent(list: string[]) {
  try {
    localStorage.setItem(LS_RECENT, JSON.stringify(list));
  } catch {
    /* 存不了只影响「最近用过」排序 */
  }
}

/** 本次启动里读过的出图工具状态（各标签共用一份，不每个标签都去探一次） */
let helperReadyCache: boolean | null = null;

export function useChatImageGen({
  tabId,
  sessionId,
  agentId,
  skills,
  generating,
  attention,
}: {
  tabId: string | null;
  sessionId: string | null;
  agentId: string | null;
  skills: readonly SkillDto[];
  generating: boolean;
  attention: "done" | "working" | "confirm" | null;
}) {
  const defaultModel = useAppStore((s) => s.settings?.imageGenModel?.trim() || "");
  const defaultGateway = useAppStore((s) => s.settings?.imageGenGatewayId?.trim() || "");
  const [on, setOn] = useState(false);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [groups, setGroups] = useState<CandidateGroup[] | null>(null);
  const [helperReady, setHelperReady] = useState<boolean | null>(helperReadyCache);
  const [skillJustEnabled, setSkillJustEnabled] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [calls, setCalls] = useState<ImageGenCall[]>([]);
  const [missed, setMissed] = useState<{ sentAt: number; said: string } | null>(null);
  const [pickOpen, setPickOpen] = useState(false);
  // 对比：选中的几个（null = 只用一个）；pickMulti = 选择框正处在多选
  const [compare, setCompare] = useState<ImageModelItem[] | null>(null);
  const [pickMulti, setPickMulti] = useState(false);
  const pendingRef = useRef<{ sentAt: number; said: string } | null>(null);

  // 这个对话选过的出图模型：标签开着就按标签找；标签是从侧栏重开的，按会话找回来（后端顺手记到新标签上）
  useEffect(() => {
    if (!tabId) return;
    let stale = false;
    void invoke<Choice | null>("image_gen_chat_sync", { tabId, sessionId })
      .then((c) => {
        if (!stale) setChoice(c && c.model ? { gatewayId: c.gatewayId, model: c.model } : null);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [tabId, sessionId]);

  const loadCalls = useCallback(async () => {
    if (!tabId) return [] as ImageGenCall[];
    const list = await invoke<ImageGenCall[]>("image_gen_chat_calls", { tabId, sinceMs: null }).catch(() => null);
    if (Array.isArray(list)) setCalls(list);
    return Array.isArray(list) ? list : [];
  }, [tabId]);
  useEffect(() => {
    void loadCalls();
  }, [loadCalls]);

  // 开出图模式时才去读候选目录与工具状态（不开的对话一次不读）
  useEffect(() => {
    if (!on) return;
    if (groups === null) {
      void invoke<CandidateGroup[]>("image_gen_candidates").then(
        (r) => setGroups(Array.isArray(r) ? r : []),
        () => setGroups([]),
      );
    }
    if (helperReadyCache === null) {
      void invoke<{ helperReady: boolean }>("image_gen_status").then(
        (r) => {
          helperReadyCache = Boolean(r?.helperReady);
          setHelperReady(helperReadyCache);
        },
        () => setHelperReady(false),
      );
    }
  }, [on, groups]);

  const items = useMemo<ImageModelItem[]>(
    () => (groups ?? []).flatMap((g) => g.models.map((model) => ({ gatewayId: g.gatewayId, gatewayName: g.gatewayName, model }))),
    [groups],
  );
  const model = choice?.model || defaultModel || null;
  const followsDefault = !choice && Boolean(defaultModel);
  const skillEnabled = skillJustEnabled || skills.some((s) => s.name === IMAGE_GEN_SKILL);
  const issue = imageGenIssue({
    helperReady,
    model,
    candidates: groups ? items.length : null,
    skillEnabled,
  });

  const pick = useCallback(
    (item: ImageModelItem) => {
      const backToDefault = item.model === defaultModel && item.gatewayId === defaultGateway;
      const next = backToDefault ? null : { gatewayId: item.gatewayId, model: item.model };
      setChoice(next);
      writeRecent(pushRecent(readRecent(), itemKey(item)));
      if (!tabId) return;
      void invoke("image_gen_chat_set", {
        tabId,
        sessionId,
        gatewayId: next?.gatewayId ?? null,
        model: next?.model ?? null,
      }).catch(() => undefined);
    },
    [defaultGateway, defaultModel, sessionId, tabId],
  );

  // 对比跟着标签：选择框读回来后按存的 key 还原（还原在前、写在后，同一次渲染里先读到旧值）
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!tabId || groups === null || restoredRef.current) return;
    restoredRef.current = true;
    const keys = readJson<string[]>(lsCompare(tabId), []);
    const list = keys.map((k) => items.find((i) => itemKey(i) === k)).filter((i): i is ImageModelItem => Boolean(i));
    if (list.length > 1) setCompare(list);
  }, [tabId, groups, items]);
  useEffect(() => {
    if (!tabId || !restoredRef.current || pickMulti) return;
    writeJson(lsCompare(tabId), compare && compare.length > 1 ? compare.map(itemKey) : null);
  }, [tabId, compare, pickMulti]);

  // 生成中（或还有没出完的）每 2 秒读一次调用记录，画进度
  const inflight = useMemo(() => inflightCalls(calls), [calls]);
  const polling = generating || inflight.length > 0;
  useEffect(() => {
    if (!polling || !tabId) return;
    const t = window.setInterval(() => void loadCalls(), POLL_MS);
    return () => window.clearInterval(t);
  }, [polling, tabId, loadCalls]);
  // 新出完的几次记进耗时（下次估得更准）；挂上时已有的不重记
  const timedRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const done = finishedDurations(calls);
    if (timedRef.current === null) {
      timedRef.current = new Set(done.map((d) => d.id));
      return;
    }
    const fresh = done.filter((d) => !timedRef.current!.has(d.id));
    if (fresh.length === 0) return;
    let store = readJson<Record<string, number[]>>(LS_DURATIONS, {});
    for (const d of fresh) {
      timedRef.current.add(d.id);
      store = recordDuration(store, d.model, d.ms);
    }
    writeJson(LS_DURATIONS, store);
  }, [calls]);

  const singleKey = choice
    ? itemKey(choice)
    : defaultModel
      ? itemKey({ gatewayId: defaultGateway, model: defaultModel })
      : null;
  const comparing = compare !== null && compare.length > 1;

  /** 「对比几个」：从现在这个模型起步进多选 */
  function startCompare() {
    const current = singleKey ? items.find((i) => itemKey(i) === singleKey) : undefined;
    setCompare(current ? [current] : []);
    setPickMulti(true);
  }
  function toggleCompare(item: ImageModelItem) {
    setCompare((cur) => {
      const list = cur ?? [];
      const k = itemKey(item);
      if (list.some((i) => itemKey(i) === k)) return list.filter((i) => itemKey(i) !== k);
      return list.length >= MAX_COMPARE ? list : [...list, item];
    });
  }
  /** 多选收起：选了两个以上才算对比；只剩一个就当换成它；一个没选回到原来的 */
  function settleCompare() {
    if (compare && compare.length === 1) pick(compare[0]);
    if (!compare || compare.length < 2) setCompare(null);
    setPickMulti(false);
  }
  /** 「只用一个」：留第一个，选择框回到单选 */
  function singleOnly() {
    if (compare && compare.length > 0) pick(compare[0]);
    setCompare(null);
    setPickMulti(false);
  }

  async function enableSkill() {
    if (!agentId || enabling) return;
    setEnabling(true);
    try {
      const lib = await invoke<SkillDto[]>("list_skills");
      const skill = lib.find((s) => s.name === IMAGE_GEN_SKILL);
      if (!skill) throw new Error("技能库里还没有 image-gen，重启 Mesa 后自动加入");
      await invoke("apply_skill", { id: skill.id, agent: agentId, enabled: true });
      setSkillJustEnabled(true);
    } catch {
      /* 打不开就留着提示，人可以去技能页 */
    } finally {
      setEnabling(false);
    }
  }

  // 一轮结束（生成中 → 停下，且不是停在等你确认）时：刷新「哪张图是哪个模型出的」；
  // 这一轮是出图模式发的、出图工具却一次没被调用，框上方说一声
  // 定时器只在又开始生成时取消（结束后 attention 还会再变一两次，不能因此丢掉这次检查）
  const wasGeneratingRef = useRef(generating);
  const settleRef = useRef<number | null>(null);
  useEffect(() => {
    const was = wasGeneratingRef.current;
    wasGeneratingRef.current = generating;
    if (generating) {
      if (settleRef.current !== null) window.clearTimeout(settleRef.current);
      settleRef.current = null;
      return;
    }
    if (!was || attention === "confirm") return;
    const pending = pendingRef.current;
    settleRef.current = window.setTimeout(() => {
      settleRef.current = null;
      void loadCalls().then((list) => {
        if (!pending || pendingRef.current !== pending) return;
        pendingRef.current = null;
        if (!calledSince(list, pending.sentAt)) setMissed(pending);
      });
    }, SETTLE_MS);
  }, [generating, attention, loadCalls]);
  useEffect(
    () => () => {
      if (settleRef.current !== null) window.clearTimeout(settleRef.current);
    },
    [],
  );

  const captions = useMemo(() => captionsByPath(calls, IS_WINDOWS), [calls]);

  const defaultGatewayName = items.find((i) => i.gatewayId === defaultGateway)?.gatewayName;
  const defaultText = defaultModel
    ? defaultGatewayName
      ? `${defaultModel}（${gatewayLabel(defaultGatewayName)}）`
      : defaultModel
    : null;

  const composer: ComposerImageGen = {
    on,
    model,
    setOn: (next) => {
      setOn(next);
      if (!next) setMissed(null);
    },
    // 点图「改图」：打开出图；对比后挑中其中一张（是对比里某个模型出的），胶囊回到那个模型
    onEditImage: (path) => {
      setOn(true);
      if (!comparing) return;
      const made = producerOf(calls, path, IS_WINDOWS);
      if (!made || !compare!.some((i) => i.model === made.model)) return;
      const item =
        compare!.find((i) => i.model === made.model && i.gatewayName === made.gatewayName) ??
        compare!.find((i) => i.model === made.model);
      if (item) pick(item);
      setCompare(null);
    },
    directive: (text, edit) => {
      if (!text.trim()) return { error: edit ? "写一句要怎么改" : "写一句要画什么" };
      if (imageGenBlocks(issue)) return { error: issueText(issue!) };
      return { line: imageGenDirective(comparing ? compare!.map((i) => i.model) : model!, edit) };
    },
    onSent: (said) => {
      setMissed(null);
      pendingRef.current = { sentAt: Date.now(), said };
    },
    pill: (
      <ImageGenPill
        model={model}
        selectedKey={singleKey}
        compare={comparing ? compare : null}
        compareKeys={(compare ?? []).map(itemKey)}
        pickMulti={pickMulti}
        onStartCompare={startCompare}
        onToggleCompare={toggleCompare}
        onSettleCompare={settleCompare}
        onSingleOnly={singleOnly}
        followsDefault={followsDefault}
        defaultText={defaultText}
        items={items}
        loading={groups === null}
        pickOpen={pickOpen}
        onPickOpen={setPickOpen}
        onPick={pick}
        onClose={() => {
          setOn(false);
          setPickOpen(false);
          setPickMulti(false);
          setCompare(null);
          setMissed(null);
        }}
      />
    ),
    issue: issue ? (
      <ImageGenIssueLine
        issue={issue}
        enabling={enabling}
        onEnableSkill={() => void enableSkill()}
        onPickModel={() => setPickOpen(true)}
      />
    ) : null,
  };

  const command: MesaCommand = {
    cmd: "/image",
    label: "画图",
    hint: on ? "已在出图模式，点胶囊上的 × 退出" : "用出图模型画，胶囊上能换模型",
    run: () => setOn(true),
  };

  /** 框上方那一行：没调用出图工具。retry = 把那句话放回输入框（不替人发） */
  function missedNotice(retry: (said: string) => void): ComposerNotice | null {
    if (!missed) return null;
    return {
      text: "这一轮没有调用出图工具",
      title: "这句是按出图模式发的，但这一轮结束时出图工具一次也没被调用：AI 可能用代码自己画了，或者回答说画不了。放回输入框后检查一下再发。",
      actions: [
        {
          label: "放回输入框",
          primary: true,
          onClick: () => {
            setMissed(null);
            setOn(true);
            retry(missed.said);
          },
        },
        { label: "不用了", onClick: () => setMissed(null) },
      ],
    };
  }

  const progress: ReactNode = inflight.length > 0 ? <ImageGenProgress calls={inflight} /> : null;

  return { composer, command, captions, missedNotice, progress };
}

function issueText(issue: ImageGenIssue): string {
  switch (issue.kind) {
    case "no-helper":
      return "这版 Mesa 没找到随包的出图工具，暂时画不了";
    case "no-model":
      return issue.candidates === 0 ? "网关目录里没有出图模型" : "还没选出图模型";
    case "no-skill":
      return "这家 Agent 还没打开技能 image-gen";
  }
}

function openProfilesImagePane() {
  try {
    localStorage.setItem(PROFILES_PANE_REQ_KEY, "image");
  } catch {
    // 存不下就只跳到连接页
  }
  useAppStore.getState().setPage("profiles");
}

/** 聊天里正在出的图：每个模型一条，模型标识 + 名字 + 已等多久 + 估算进度（出图接口不报进度，按本机以往耗时估，出完前不满格） */
function ImageGenProgress({ calls }: { calls: ImageGenCall[] }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  const durations = readJson<Record<string, number[]>>(LS_DURATIONS, {});
  const now = Date.now();
  return (
    <div className="mb-2 flex flex-col gap-2" role="status" aria-live="polite">
      {calls.map((c) => {
        const elapsed = Math.max(0, (now - c.at) / 1000);
        const estimate = estimateSeconds(c.model, durations[c.model]);
        const pct = Math.round(progressAt(elapsed, estimate) * 100);
        return (
          <div key={c.id} className="max-w-sm">
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-l3">
              <ImageModelMark model={c.model} size={12} className="text-l2" />
              <span className="shrink-0">正在用</span>
              <span className="min-w-0 truncate font-mono text-l2">{c.model}</span>
              <span className="shrink-0">出图</span>
              <span className="ml-auto shrink-0 tabular-nums text-l4">已等 {waitedText(elapsed)}</span>
            </div>
            <div
              className="mt-1 h-1 overflow-hidden rounded-full bg-hairline"
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${c.model} 出图进度（估算）`}
            >
              <div className="h-full rounded-full bg-cta transition-[width] duration-500" style={{ width: `${Math.max(pct, 3)}%` }} />
            </div>
            <p className="mt-0.5 text-micro text-l4">
              {elapsed <= estimate ? `这个模型在你这里一般约 ${waitedText(estimate)}（估算）` : "比平常久，还在等"}
            </p>
          </div>
        );
      })}
    </div>
  );
}

/** 输入框里「+」旁边的小胶囊：图标 + 模型名（点开选择框）+ ×（退出出图） */
function ImageGenPill({
  model,
  selectedKey,
  compare,
  compareKeys,
  pickMulti,
  onStartCompare,
  onToggleCompare,
  onSettleCompare,
  onSingleOnly,
  followsDefault,
  defaultText,
  items,
  loading,
  pickOpen,
  onPickOpen,
  onPick,
  onClose,
}: {
  model: string | null;
  /** 选择框里打勾的那一项（网关 + 模型） */
  selectedKey: string | null;
  /** 正在对比的几个（两个以上；不对比为 null） */
  compare: ImageModelItem[] | null;
  /** 多选里勾着的（可能还不到两个） */
  compareKeys: string[];
  pickMulti: boolean;
  onStartCompare: () => void;
  onToggleCompare: (item: ImageModelItem) => void;
  onSettleCompare: () => void;
  onSingleOnly: () => void;
  followsDefault: boolean;
  /** 连接页默认「模型（某某网关）」；没设为 null */
  defaultText: string | null;
  items: ImageModelItem[];
  loading: boolean;
  pickOpen: boolean;
  onPickOpen: (open: boolean) => void;
  onPick: (item: ImageModelItem) => void;
  onClose: () => void;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [recent, setRecent] = useState<string[]>(readRecent);
  useEffect(() => {
    if (pickOpen) setRecent(readRecent());
  }, [pickOpen]);
  const title = compare
    ? `出图对比：${compare.map((i) => i.model).join("、")} 各出一版。点这里改选，或换回只用一个`
    : model
      ? `出图：这一句用 ${model} 画（${followsDefault ? "连接页默认" : "这个对话选的"}）。点这里换一个或对比几个，只管这个对话`
      : "出图：还没选出图模型，点这里选一个";
  const actionCls = "shrink-0 rounded px-1 text-micro text-l2 hover:bg-hover hover:text-l1";
  return (
    <span
      data-testid="image-gen-pill"
      aria-label="出图模式"
      className="inline-flex h-7 min-w-0 max-w-[13rem] items-center rounded-full border border-field text-xs text-l2"
    >
      <button
        ref={anchorRef}
        type="button"
        onClick={() => onPickOpen(!pickOpen)}
        aria-haspopup="listbox"
        aria-expanded={pickOpen}
        title={title}
        className="inline-flex h-full min-w-0 items-center gap-1 rounded-l-full pl-2 pr-1 hover:bg-hover hover:text-l1 focus-visible:outline-2 focus-visible:outline-cta"
      >
        {compare ? (
          <>
            <span className="flex shrink-0 items-center gap-0.5">
              {compare.map((i) => (
                <ImageModelMark key={itemKey(i)} model={i.model} size={12} className="text-l2" />
              ))}
            </span>
            <span className="min-w-0 truncate">{compare.length} 个模型对比</span>
          </>
        ) : (
          <>
            <ImageModelMark model={model} className="text-l2" />
            <span className={`min-w-0 truncate font-mono ${model ? "" : "text-l3"}`}>{model ?? "选出图模型"}</span>
          </>
        )}
        <ChevronDown size={12} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-l3" />
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label="退出出图"
        title="退出出图，回到普通对话"
        className="flex h-full w-6 shrink-0 items-center justify-center rounded-r-full text-l3 hover:bg-hover hover:text-l1 focus-visible:outline-2 focus-visible:outline-cta"
      >
        <X size={12} aria-hidden="true" />
      </button>
      <ImageModelPicker
        anchorRef={anchorRef}
        open={pickOpen && !loading}
        onClose={() => {
          onPickOpen(false);
          if (pickMulti) onSettleCompare();
        }}
        items={items}
        recent={recent}
        multi={pickMulti}
        maxSelected={pickMulti ? MAX_COMPARE : undefined}
        selected={pickMulti ? compareKeys : selectedKey ? [selectedKey] : []}
        note={pickMulti ? undefined : `只管这个对话 · 连接页默认：${defaultText ?? "还没设"}`}
        headerAction={
          pickMulti ? (
            <button type="button" className={actionCls} onClick={onSingleOnly} title="回到只用一个模型（留第一个）">
              只用一个
            </button>
          ) : (
            <button
              type="button"
              className={actionCls}
              onClick={onStartCompare}
              title={`勾 2–${MAX_COMPARE} 个模型，这一句每个各出一版，放在一起对比`}
            >
              对比几个
            </button>
          )
        }
        onPick={pickMulti ? onToggleCompare : onPick}
      />
    </span>
  );
}

/** 只在有问题时框里多一行小字：缺什么 + 一个处理按钮 */
function ImageGenIssueLine({
  issue,
  enabling,
  onEnableSkill,
  onPickModel,
}: {
  issue: ImageGenIssue;
  enabling: boolean;
  onEnableSkill: () => void;
  onPickModel: () => void;
}) {
  const action =
    issue.kind === "no-model"
      ? issue.candidates === 0
        ? { label: "去连接页", onClick: openProfilesImagePane }
        : { label: "选模型", onClick: onPickModel }
      : issue.kind === "no-skill"
        ? { label: enabling ? "正在打开…" : "打开", onClick: onEnableSkill }
        : null;
  return (
    <p
      role="status"
      className={`flex items-center gap-2 px-4 pt-2 text-micro ${imageGenBlocks(issue) ? "text-caution-text" : "text-l3"}`}
    >
      <ImageModelMark model={null} size={12} />
      <span className="min-w-0 flex-1">{issueText(issue)}</span>
      {action && (
        <button
          type="button"
          disabled={enabling}
          onClick={action.onClick}
          className="shrink-0 cursor-pointer rounded border border-field px-1.5 py-0.5 text-l1 hover:bg-hover disabled:opacity-50"
        >
          {action.label}
        </button>
      )}
    </p>
  );
}
