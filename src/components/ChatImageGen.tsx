// 聊天里的「出图」模式（2026-11-24 用户拍板，纯逻辑在 chat-image-gen.ts）：
// - 输入框里「+」旁边一个小胶囊「图标 模型 ⌄ ×」（2026-11-24 用户选：收进输入框，不在框上方另起一条）：点模型换一个，
//   只管这个对话（后端 image_gen_chat.rs 按标签记，出图工具每次现读，顺序 --model > 本对话选的 > 连接页默认）；
//   选回连接页默认那个 = 跟着默认走。胶囊发完留着，× 退回普通对话
// - 发之前查：没出图工具 / 没模型拦下，这家没开 image-gen 只提醒并给「打开」——只在有问题时框里多一行小字
// - 发出去由 Mesa 在描述前写一行固定写法（技能认它就必须调出图工具）；这一轮结束时出图工具一次没被调用，框上方说一声
// - 出图工具每次调用记一条，聊天里的图下面写是哪个模型出的
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import ImageModelPicker from "./ImageModelPicker";
import ImageModelMark from "./ImageModelMark";
import type { ComposerImageGen, ComposerNotice } from "./ChatComposer";
import {
  IMAGE_GEN_SKILL,
  calledSince,
  captionsByPath,
  imageGenBlocks,
  imageGenDirective,
  imageGenIssue,
  type ImageGenCall,
  type ImageGenIssue,
} from "../chat-image-gen";
import type { MesaCommand } from "../composer-assist";
import { gatewayLabel, itemKey, pushRecent, type ImageModelItem } from "../image-models";
import { IS_WINDOWS } from "../hotkeys";
import { PROFILES_PANE_REQ_KEY } from "../profiles-pane";
import { useAppStore } from "../store";
import type { SkillDto } from "../types";

type Choice = { gatewayId: string; model: string };
type CandidateGroup = { gatewayId: string; gatewayName: string; models: string[] };

/** 与连接页出图模型一块共用「最近用过」 */
const LS_RECENT = "ccode.imageGen.recent";
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
    directive: (text, edit) => {
      if (!text.trim()) return { error: edit ? "写一句要怎么改" : "写一句要画什么" };
      if (imageGenBlocks(issue)) return { error: issueText(issue!) };
      return { line: imageGenDirective(model!, edit) };
    },
    onSent: (said) => {
      setMissed(null);
      pendingRef.current = { sentAt: Date.now(), said };
    },
    pill: (
      <ImageGenPill
        model={model}
        selectedKey={
          choice ? itemKey(choice) : defaultModel ? itemKey({ gatewayId: defaultGateway, model: defaultModel }) : null
        }
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

  return { composer, command, captions, missedNotice };
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

/** 输入框里「+」旁边的小胶囊：图标 + 模型名（点开选择框）+ ×（退出出图） */
function ImageGenPill({
  model,
  selectedKey,
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
  const title = model
    ? `出图：这一句用 ${model} 画（${followsDefault ? "连接页默认" : "这个对话选的"}）。点这里换一个，只管这个对话`
    : "出图：还没选出图模型，点这里选一个";
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
        <ImageModelMark model={model} className="text-l2" />
        <span className={`min-w-0 truncate font-mono ${model ? "" : "text-l3"}`}>{model ?? "选出图模型"}</span>
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
        onClose={() => onPickOpen(false)}
        items={items}
        recent={recent}
        selected={selectedKey ? [selectedKey] : []}
        note={`只管这个对话 · 连接页默认：${defaultText ?? "还没设"}`}
        onPick={onPick}
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
