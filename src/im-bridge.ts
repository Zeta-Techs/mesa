/**
 * 飞书通道的前端桥（2026-11-06 docs/design-assistant-dispatch-desk.md §3；2026-11-15 完善卡片原地流转、引用回复、进度秒看与完成提醒）：
 * 后端 feishu.rs 管长连接收发与卡片 PATCH；这里接住 feishu-message / feishu-card-action，先回执看门狗 feishu_ack_inbound，
 * 再交给总助手路由（im-route.ts）→ 思考占位卡片 → askProjectAssistant（流式刷新状态，答完原地换成正式卡片）。
 * 支持左滑「引用回复」卡片直达对应会话 / 人工请求，按钮点过后原地置为已完成防误触重按。
 * 主动推送：派活回音、新人工请求、定时授权请求、卡住提醒、步骤/目标完成与出错（支持夜间免打扰与桌宠勿扰联动）。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "./store";
import { IS_WINDOWS } from "./hotkeys";
import { pathWithin, samePath } from "./path-utils";
import { askProjectAssistant, gatherBriefInput, type AssistantTurn } from "./project-assistant-run";
import {
  actionLabel,
  guardClaims,
  localReply,
  parseAssistantAnswer,
  parseClarify,
  parseRemember,
  parseReworkOrder,
  parseWorkOrder,
} from "./project-assistant";
import { reviewPrereadFocus, reviewPrereadQuestion } from "./assistant-brief";
import { actionOp, opAllowed } from "./assistant-ops";
import { dispatchWorkOrder, resumeDispatchedGoal, type DispatchRecord } from "./assistant-dispatch";
import { addProjectKnowledge, answerGrant, answerTrust, loadDesk, replyDesk } from "./assistant-desk";
import {
  IM_HELP_TEXT,
  isCancelReply,
  isImQuietHour,
  isMetaCommand,
  isStatusQuery,
  parseStepReplyPrefix,
  quickIntent,
  routeMessage,
  type RouteProject,
} from "./im-route";
import {
  answerCard,
  askErrorCard,
  deskCard,
  echoCard,
  milestoneCard,
  phoneText,
  projectListCard,
  projectPickCard,
  projectStatusCard,
  replyPickCard,
  selfTestDoneCard,
  thinkingCard,
  type CardValue,
  type DeskItemSettled,
  type ReplyTargetChoice,
} from "./im-cards";
import { PET_DND_KEY, petItemsFromBrief } from "./desk-pet";
import type { DeskItem } from "./assistant-queue";
import type { OpenDispatch } from "./assistant-echo";
import { helpNotDismissed, optionAnswer } from "./help-requests";
import { loadHelpDismissed } from "./inbox";
import { toast } from "./toast";
import type { HelpRequestDto, ProjectConfigReadDto, ProjectDto, ScheduleDto, TaskDto, WorkspaceDto } from "./types";

export interface FeishuConfig {
  enabled: boolean;
  appId: string;
  hasSecret: boolean;
  boundUser: string | null;
  status: string;
  lastError: string | null;
  notifyMilestones?: boolean;
  quietNight?: boolean;
  pairingCode?: string | null;
  pairingLeftSecs?: number | null;
}

const CURRENT_KEY = "ccode.imCurrentProject";
const PUSHED_KEY = "ccode.imPushedHelp";
const PUSHED_GRANT_KEY = "ccode.imPushedGrant";
const PUSHED_MILESTONE_KEY = "ccode.imPushedMilestones";
const CARD_INDEX_KEY = "ccode.imCardIndex";
const MAX_TRACKED_CARDS = 80;
const REPLY_TARGET_TTL_MS = 10 * 60_000;

interface StoredCardEntry {
  messageId: string;
  kind: "desk" | "answer";
  projectPath?: string;
  turnAt?: string;
  targets?: ReplyTargetChoice[];
}

interface AnswerCardRecord {
  input: Parameters<typeof answerCard>[0];
  settled: { clarify: string | null; dispatched: string | null; remembered: Set<number> };
}

interface DeskCardRecord {
  groups: { project: RouteProject; items: DeskItem[] }[];
  settled: Map<string, DeskItemSettled>;
}

type MiscCardRecord =
  | { kind: "pick"; projects: RouteProject[]; question: string }
  | { kind: "list"; projects: { path: string; name: string; waiting?: number }[]; currentPath: string | null }
  | { kind: "echo"; project: RouteProject; turnAt: string; text: string; resumable: boolean }
  | { kind: "reply_pick"; choices: ReplyTargetChoice[]; replyBody: string };

const answerCards = new Map<string, AnswerCardRecord>();
const deskCards = new Map<string, DeskCardRecord>();
const miscCards = new Map<string, MiscCardRecord>();

let pendingReplyTarget: {
  projectPath: string;
  projectName: string;
  key: string;
  where: string;
  sourceCardId: string | null;
  expiresAt: number;
} | null = null;

function putBounded<V>(map: Map<string, V>, key: string, value: V): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > MAX_TRACKED_CARDS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function loadCardIndex(): StoredCardEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(CARD_INDEX_KEY) ?? "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveCardIndexEntry(entry: StoredCardEntry): void {
  try {
    const list = loadCardIndex().filter((x) => x.messageId !== entry.messageId);
    list.push(entry);
    localStorage.setItem(CARD_INDEX_KEY, JSON.stringify(list.slice(-MAX_TRACKED_CARDS)));
  } catch {
    /* 记不下只影响重启后的引用回复回溯 */
  }
}

function findCardIndexEntry(messageId: string): StoredCardEntry | null {
  return loadCardIndex().find((x) => x.messageId === messageId) ?? null;
}

function readCurrent(): string | null {
  try {
    return localStorage.getItem(CURRENT_KEY);
  } catch {
    return null;
  }
}

function writeCurrent(path: string): void {
  try {
    localStorage.setItem(CURRENT_KEY, path);
  } catch {
    /* 记不下只是下次再选 */
  }
}

let projectsCache: { at: number; list: ProjectDto[] } | null = null;
async function projects(): Promise<ProjectDto[]> {
  if (projectsCache && Date.now() - projectsCache.at < 30_000) return projectsCache.list;
  const list = await invoke<ProjectDto[]>("list_projects").catch(() => [] as ProjectDto[]);
  projectsCache = { at: Date.now(), list };
  return list;
}

const asRoute = (p: ProjectDto): RouteProject => ({ path: p.path, name: p.name });

async function sendText(text: string): Promise<void> {
  await invoke("feishu_send_text", { text }).catch(() => {});
}

async function sendCardWithId(card: object): Promise<string | null> {
  try {
    return await invoke<string>("feishu_send_card", { card });
  } catch {
    await sendText("（卡片没发出去）");
    return null;
  }
}

async function sendCard(card: object): Promise<boolean> {
  return (await sendCardWithId(card)) !== null;
}

/** 优先 PATCH 原地更新那张消息卡片；卡片过久或失败时退回发新消息，保证反馈不丢 */
async function patchOrFallback(messageId: string | null | undefined, card: object, fallbackText?: string): Promise<boolean> {
  if (messageId) {
    try {
      await invoke("feishu_update_card", { messageId, card });
      return true;
    } catch {
      /* 超过 14 天或无法更新时走降级 */
    }
  }
  if (fallbackText) {
    await sendText(fallbackText);
    return true;
  }
  return sendCard(card);
}

let configCache: { at: number; cfg: FeishuConfig | null } | null = null;

async function getImConfig(): Promise<FeishuConfig | null> {
  if (!configCache || Date.now() - configCache.at > 30_000) {
    const cfg = await invoke<FeishuConfig>("feishu_config_get").catch(() => null);
    configCache = { at: Date.now(), cfg };
  }
  return configCache.cfg;
}

/** 判定此刻主动推送是否应静音：夜间免打扰（23:00–08:00）或桌宠勿扰中 */
export function isImQuietNow(cfg: FeishuConfig | null, now = new Date(), dndUntil = 0): boolean {
  return isImQuietHour(cfg?.quietNight, now, dndUntil);
}

function readDndUntil(): number {
  try {
    return Number(localStorage.getItem(PET_DND_KEY) ?? "0") || 0;
  } catch {
    return 0;
  }
}

/** 连上了、绑定过才可用 */
export async function imReady(): Promise<boolean> {
  const cfg = await getImConfig();
  return !!cfg?.enabled && !!cfg.boundUser && cfg.status === "online";
}

/** 主动后台推送门控：连上且不在免打扰时段 */
async function imPushAllowed(): Promise<FeishuConfig | null> {
  const cfg = await getImConfig();
  if (!cfg?.enabled || !cfg.boundUser || cfg.status !== "online") return null;
  if (isImQuietNow(cfg, new Date(), readDndUntil())) return null;
  return cfg;
}

export function forgetImConfig(): void {
  configCache = null;
}

let lastAutoReconnectAt = 0;

/** 电脑合盖唤醒或网络重连时：若飞书通道开着，立即重连长连接（10 秒防抖防抖动） */
export async function reconnectImIfNeeded(): Promise<void> {
  const now = Date.now();
  if (now - lastAutoReconnectAt < 10_000) return;
  const cfg = await getImConfig();
  if (!cfg?.enabled) return;
  lastAutoReconnectAt = now;
  forgetImConfig();
  await invoke("feishu_reconnect").catch(() => {});
}

/** 推一句文字到手机（派活回音用）；没连上或在免打扰就算了 */
export async function imPushText(text: string): Promise<void> {
  if (await imPushAllowed()) await sendText(text);
}

async function stepCount(path: string): Promise<number> {
  const read = await invoke<ProjectConfigReadDto>("read_project_config", { path }).catch(() => null);
  return read?.config.steps.length ?? 0;
}

function buildAnswerInputFromTurn(
  project: ProjectDto,
  turn: AssistantTurn,
  steps: number,
): Parameters<typeof answerCard>[0] {
  const memo = parseRemember(turn.answer);
  const clar = parseClarify(memo.text);
  const rework = parseReworkOrder(clar.text, steps);
  const order = parseWorkOrder(rework.text, steps);
  const parsed = parseAssistantAnswer(order.text, steps);
  const desktopOnly = parsed.actions.filter((a) => !opAllowed(actionOp(a.kind), "phone")).map((a) => actionLabel(a.kind, a.step));
  if (rework.rework && !opAllowed("rework", "phone")) {
    desktopOnly.push(`补料单（退回第 ${rework.rework.toStep} 步）：在桌面的项目助手里点「退回去补」`);
  }
  const codingGoalBlocked = project.workMode === "coding" && order.order?.target === "goal";
  if (codingGoalBlocked) desktopOnly.push("编程项目按分支开工：回桌面的项目页从基准开一条分支来做");
  return {
    project: asRoute(project),
    turnAt: turn.at,
    text: phoneText(guardClaims(parsed.text).text),
    ask: clar.ask,
    order: codingGoalBlocked ? null : order.order,
    remembers: memo.remembers,
    desktopOnly,
  };
}

function recordDeskCard(messageId: string, groups: { project: RouteProject; items: DeskItem[] }[]): void {
  putBounded(deskCards, messageId, { groups, settled: new Map() });
  const targets: ReplyTargetChoice[] = [];
  for (const g of groups) {
    for (const i of g.items) {
      if (i.kind === "help" || i.kind === "question") {
        targets.push({
          projectPath: g.project.path,
          projectName: g.project.name,
          key: i.key,
          where: i.where,
          question: i.question,
        });
      }
    }
  }
  saveCardIndexEntry({ messageId, kind: "desk", targets });
}

async function sendTrackedDeskCard(groups: { project: RouteProject; items: DeskItem[] }[]): Promise<boolean> {
  const msgId = await sendCardWithId(deskCard(groups));
  if (!msgId) return false;
  recordDeskCard(msgId, groups);
  return true;
}

/** 交给某个项目的项目助手问一次：先发思考占位卡片，流式刷新进展，答完原地换成正式卡片 */
async function ask(
  project: ProjectDto,
  question: string,
  focus: { title: string; detail: string } | null = null,
  prePlaceholderId: string | null = null,
): Promise<void> {
  writeCurrent(project.path);
  const q = question.trim();
  if (!focus) {
    const canned = localReply(q, new Date().getHours());
    if (canned) {
      await invoke("assistant_log_append", { projectRoot: project.path, question: q, answer: canned }).catch(() => {});
      useAppStore.getState().bumpAssistantEchoTick();
      const input: Parameters<typeof answerCard>[0] = {
        project: asRoute(project),
        turnAt: new Date().toISOString(),
        text: canned,
        ask: null,
        order: null,
        remembers: [],
        desktopOnly: [],
      };
      await patchOrFallback(prePlaceholderId, answerCard(input));
      return;
    }
  }
  const placeholderId =
    prePlaceholderId ?? (await sendCardWithId(thinkingCard(asRoute(project), q)));
  if (prePlaceholderId) {
    void invoke("feishu_update_card", {
      messageId: prePlaceholderId,
      card: thinkingCard(asRoute(project), q),
    }).catch(() => {});
  }
  const history = (await invoke<AssistantTurn[]>("assistant_log_read", { projectRoot: project.path }).catch(() => [] as AssistantTurn[])).filter(
    (t) => !t.echoOf,
  );
  let lastProgressAt = 0;
  let lastStepText = "";
  let turn: AssistantTurn;
  try {
    turn = await askProjectAssistant({
      projectPath: project.path,
      project,
      question: q,
      history,
      focus,
      where: "手机（飞书）",
      onStream: (u) => {
        if (!placeholderId || !u.step || u.step === lastStepText) return;
        const now = Date.now();
        if (now - lastProgressAt < 3500) return;
        lastProgressAt = now;
        lastStepText = u.step;
        void invoke("feishu_update_card", {
          messageId: placeholderId,
          card: thinkingCard(asRoute(project), q, `正在查看：${u.step}`),
        }).catch(() => {});
      },
    });
  } catch (reason) {
    const errText = String(reason instanceof Error ? reason.message : reason);
    await patchOrFallback(placeholderId, askErrorCard(asRoute(project), q, errText), `没问成：${errText}`);
    return;
  }
  useAppStore.getState().bumpAssistantEchoTick();
  const steps = await stepCount(project.path);
  const input = buildAnswerInputFromTurn(project, turn, steps);
  const settledState = { clarify: null, dispatched: null, remembered: new Set<number>() };
  if (placeholderId) {
    const patched = await invoke("feishu_update_card", {
      messageId: placeholderId,
      card: answerCard(input),
    })
      .then(() => true)
      .catch(() => false);
    if (patched) {
      putBounded(answerCards, placeholderId, { input, settled: settledState });
      saveCardIndexEntry({ messageId: placeholderId, kind: "answer", projectPath: project.path, turnAt: turn.at });
      return;
    }
  }
  const sentId = await sendCardWithId(answerCard(input));
  if (sentId) {
    putBounded(answerCards, sentId, { input, settled: settledState });
    saveCardIndexEntry({ messageId: sentId, kind: "answer", projectPath: project.path, turnAt: turn.at });
  }
}

/** 有事等你的项目（开着工作副本、有人工请求、有终端在等确认，或有活跃目标的），最多 8 个 */
async function busyProjects(list: ProjectDto[]): Promise<ProjectDto[]> {
  const [workspaces, help, tasks] = await Promise.all([
    invoke<WorkspaceDto[]>("list_workspaces").catch(() => [] as WorkspaceDto[]),
    invoke<HelpRequestDto[]>("list_help_requests")
      .catch(() => [] as HelpRequestDto[])
      .then((l) => helpNotDismissed(l, loadHelpDismissed())),
    invoke<TaskDto[]>("task_list", { projectRoot: null, includeArchived: false }).catch(() => [] as TaskDto[]),
  ]);
  const live = useAppStore.getState().terminalRunInputs;
  const hot = new Set(["running", "pending_review", "failed", "stopped"]);
  return list
    .filter(
      (p) =>
        workspaces.some((w) => w.status !== "archived" && samePath(w.repoPath, p.path, IS_WINDOWS)) ||
        help.some((h) => samePath(h.repoPath, p.path, IS_WINDOWS)) ||
        live.some((r) => (r.attention === "confirm" || !!r.blocker) && pathWithin(r.cwd, p.path, IS_WINDOWS)) ||
        tasks.some((t) => hot.has(t.status) && !!t.projectRoot && samePath(t.projectRoot, p.path, IS_WINDOWS)),
    )
    .slice(0, 8);
}

async function sendStatus(project: ProjectDto): Promise<void> {
  writeCurrent(project.path);
  const [brief, desk] = await Promise.all([
    gatherBriefInput(project.path, null).catch(() => ({ hasFlow: false, steps: [], goals: [], since: null })),
    loadDesk(project.path).catch(() => [] as DeskItem[]),
  ]);
  await sendCard(projectStatusCard(asRoute(project), brief, desk.length));
}

async function sendProjectList(list: ProjectDto[], current: ProjectDto | null): Promise<void> {
  if (!list.length) return sendText("Mesa 里还没有项目。");
  const busy = await busyProjects(list);
  const counts = new Map<string, number>();
  await Promise.all(
    busy.map(async (p) => {
      const items = await loadDesk(p.path).catch(() => [] as DeskItem[]);
      if (items.length) counts.set(p.path, items.length);
    }),
  );
  const rows = list.map((p) => ({ path: p.path, name: p.name, waiting: counts.get(p.path) ?? 0 }));
  const currentPath = current?.path ?? null;
  const msgId = await sendCardWithId(projectListCard(rows, currentPath));
  if (msgId) putBounded(miscCards, msgId, { kind: "list", projects: rows, currentPath });
}

async function markDeskCardSettled(
  cardMessageId: string | null | undefined,
  itemKey: string,
  settled: DeskItemSettled,
): Promise<boolean> {
  if (!cardMessageId) return false;
  const rec = deskCards.get(cardMessageId);
  if (!rec) return false;
  rec.settled.set(itemKey, settled);
  return invoke("feishu_update_card", {
    messageId: cardMessageId,
    card: deskCard(rec.groups, rec.settled),
  })
    .then(() => true)
    .catch(() => false);
}

/** 按 item.key 送达一条人工请求或对话回复；可选原地更新来源卡片 */
async function deliverDeskReply(
  projectPath: string,
  itemKey: string,
  rawAnswer: string,
  sourceCardId?: string | null,
  alsoSendText = false,
): Promise<void> {
  const items = await loadDesk(projectPath);
  const item = items.find((i) => i.key === itemKey);
  if (!item) {
    await sendText("这件事已经处理过了，或者不在了。");
    return;
  }
  let normalized = rawAnswer.trim();
  if (item.kind === "help") {
    const matchedOpt = item.options.find((o) => `${o.key}：${o.label}` === normalized || o.key === normalized);
    if (matchedOpt) normalized = optionAnswer(matchedOpt.key, matchedOpt.label);
  }
  try {
    const resultMsg = await replyDesk(projectPath, item, normalized);
    const rememberLine = item.kind === "help" ? `${item.question} → ${normalized}` : null;
    const updated = await markDeskCardSettled(sourceCardId, item.key, {
      status: `${normalized}（${resultMsg}）`,
      rememberLine,
    });
    if (!updated || alsoSendText) {
      await sendText(resultMsg);
    }
  } catch (reason) {
    await sendText(`没送出去：${String(reason instanceof Error ? reason.message : reason)}`);
  }
}

/** 处理左滑「引用回复」某张卡片的消息：命中则返回 true */
async function tryHandleQuotedReply(text: string, parentId: string, list: ProjectDto[], prePlaceholderId: string | null): Promise<boolean> {
  const memDesk = deskCards.get(parentId);
  const indexed = findCardIndexEntry(parentId);
  if (memDesk || indexed?.kind === "desk") {
    const rawChoices: ReplyTargetChoice[] = memDesk
      ? memDesk.groups.flatMap((g) =>
          g.items
            .filter((i) => i.kind === "help" || i.kind === "question")
            .map((i) => ({
              projectPath: g.project.path,
              projectName: g.project.name,
              key: i.key,
              where: i.where,
              question: i.question,
            })),
        )
      : (indexed?.targets ?? []);
    const stepPrefix = parseStepReplyPrefix(text);
    const body = stepPrefix ? stepPrefix.body : text.trim();
    const filtered = stepPrefix
      ? rawChoices.filter((c) => c.where.startsWith(`第 ${stepPrefix.step} 步`))
      : rawChoices;
    const candidates = filtered.length ? filtered : rawChoices;
    if (candidates.length === 1) {
      await deliverDeskReply(candidates[0].projectPath, candidates[0].key, body, parentId, true);
      return true;
    }
    if (candidates.length > 1) {
      const msgId = await sendCardWithId(replyPickCard(candidates, body));
      if (msgId) putBounded(miscCards, msgId, { kind: "reply_pick", choices: candidates, replyBody: body });
      return true;
    }
  }
  // 引用了某张回答卡片（例如回答它上面的追问）：直接交给那张卡片所属项目
  const memAns = answerCards.get(parentId);
  const ansProjectPath = memAns?.input.project.path ?? (indexed?.kind === "answer" ? indexed.projectPath : undefined);
  if (ansProjectPath) {
    const proj = list.find((p) => samePath(p.path, ansProjectPath, IS_WINDOWS));
    if (proj) {
      if (memAns && memAns.input.ask && !memAns.settled.clarify) {
        memAns.settled.clarify = text.trim();
        void invoke("feishu_update_card", {
          messageId: parentId,
          card: answerCard({ ...memAns.input, settled: memAns.settled }),
        }).catch(() => {});
      }
      await ask(proj, text, null, prePlaceholderId);
      return true;
    }
  }
  return false;
}

async function handleMessage(textRaw: string, parentId?: string | null, prePlaceholderId: string | null = null): Promise<void> {
  const text = textRaw.trim();
  if (!text) return;
  const list = await projects();

  // 1. 左滑引用回复某张已发出的卡片：直接对位转达或归属到原卡片所在项目
  if (parentId && (await tryHandleQuotedReply(text, parentId, list, prePlaceholderId))) {
    return;
  }

  // 2. 点过「写一句回它 / 写一句自定回答」后的下一句：免前缀直接送达
  if (pendingReplyTarget && Date.now() < pendingReplyTarget.expiresAt) {
    if (isCancelReply(text)) {
      pendingReplyTarget = null;
      return sendText("已取消回复。");
    }
    if (isMetaCommand(text)) {
      pendingReplyTarget = null;
    } else {
      const target = pendingReplyTarget;
      pendingReplyTarget = null;
      await deliverDeskReply(target.projectPath, target.key, text, target.sourceCardId, true);
      return;
    }
  } else if (pendingReplyTarget) {
    pendingReplyTarget = null;
  }

  const current = list.find((p) => samePath(p.path, readCurrent() ?? "", IS_WINDOWS)) ?? null;
  const route = routeMessage(text, list.map(asRoute), current ? asRoute(current) : null);
  const byPath = (path: string) => list.find((p) => samePath(p.path, path, IS_WINDOWS))!;
  switch (route.kind) {
    case "help":
      return sendText(IM_HELP_TEXT);
    case "list":
      return sendProjectList(list, current);
    case "status":
      return sendStatus(byPath(route.project.path));
    case "unknown_project":
      return sendText(`没找到叫「${route.name}」的项目（或者有好几个都像），发「项目」点按钮选。`);
    case "switch":
      writeCurrent(route.project.path);
      return sendText(`已切到「${route.project.name}」，接下来直接说事就交给它；发「进展」秒看状态。`);
    case "pick": {
      const msgId = await sendCardWithId(projectPickCard(list.map(asRoute), route.text));
      if (msgId) putBounded(miscCards, msgId, { kind: "pick", projects: list.map(asRoute), question: route.text });
      return;
    }
    case "queue": {
      const groups = await Promise.all(
        (await busyProjects(list)).map(async (p) => ({ project: asRoute(p), items: await loadDesk(p.path).catch(() => [] as DeskItem[]) })),
      );
      await sendTrackedDeskCard(groups);
      return;
    }
    case "reply": {
      const items = (await loadDesk(route.project.path)).filter((i) => i.kind === "help" || i.kind === "question");
      if (route.step !== null) {
        const item = items.find((i) => i.step === route.step);
        if (!item) return sendText(`「${route.project.name}」第 ${route.step} 步现在没有在问你的事。发「等我的」看看有什么。`);
        return deliverDeskReply(route.project.path, item.key, route.text, null, true);
      }
      if (items.length === 0) {
        return sendText(`「${route.project.name}」现在没有在等你回答的问题或请求。发「等我的」看看所有项目。`);
      }
      if (items.length === 1) {
        return deliverDeskReply(route.project.path, items[0].key, route.text, null, true);
      }
      const choices: ReplyTargetChoice[] = items.map((i) => ({
        projectPath: route.project.path,
        projectName: route.project.name,
        key: i.key,
        where: i.where,
        question: i.question,
      }));
      const msgId = await sendCardWithId(replyPickCard(choices, route.text));
      if (msgId) putBounded(miscCards, msgId, { kind: "reply_pick", choices, replyBody: route.text });
      return;
    }
    case "ask": {
      const project = byPath(route.project.path);
      // 「派出去」「接着做」照字面办：交给 AI 只会被说成「已经派出去了」（它自己做不了动作）
      const quick = quickIntent(route.text);
      if (quick === "dispatch") return dispatchLatest(project);
      if (quick === "resume") return resumeLatest(project);
      return ask(project, route.text, null, prePlaceholderId);
    }
  }
}

async function logOf(projectPath: string): Promise<AssistantTurn[]> {
  return invoke<AssistantTurn[]>("assistant_log_read", { projectRoot: projectPath }).catch(() => [] as AssistantTurn[]);
}

/** 派出最近一张还没派的单子 */
async function dispatchLatest(project: ProjectDto): Promise<void> {
  const log = (await logOf(project.path)).filter((t) => !t.echoOf);
  const last = [...log].reverse().find((t) => t.answer.includes(":::派活"));
  if (!last || last.dispatched) return sendText("现在没有还没派的单子。先说要做什么，项目助手起草好单子再派。");
  const msg = await dispatchTurnCore(project, last);
  await sendText(msg);
}

/** 让最近一件停了 / 失败的派出去的目标接着做 */
async function resumeLatest(project: ProjectDto): Promise<void> {
  const log = await logOf(project.path);
  const last = [...log].reverse().find((t) => t.dispatched?.mode === "goal" && t.dispatched.taskId && (t.dispatched.echoed === "stopped" || t.dispatched.echoed === "failed"));
  if (!last?.dispatched?.taskId) return sendText("没有停下的、经项目助手派出去的活。要看进展发「进展」。");
  try {
    return sendText(await resumeDispatchedGoal(project.path, project, last.dispatched.taskId));
  } catch (reason) {
    return sendText(`没接上：${String(reason)}`);
  }
}

async function dispatchTurnCore(project: ProjectDto, turn: AssistantTurn): Promise<string> {
  if (turn.dispatched) return `这张单已经派过了：${turn.dispatched.note}`;
  const steps = await stepCount(project.path);
  const order = parseWorkOrder(parseReworkOrder(parseClarify(parseRemember(turn.answer).text).text, steps).text, steps).order;
  if (!order) return "那一轮里没有能派的单子。";
  // 手机上派：并入前要确认的（工作副本有没提交的文件）不在手机上问，报回去让人回桌面处理
  const result = await dispatchWorkOrder({ order, projectPath: project.path, project, confirm: null });
  const record: DispatchRecord = {
    at: new Date().toISOString(),
    target: order.target,
    step: order.step,
    title: order.title,
    mode: result.mode,
    mailId: result.mailId ?? null,
    taskId: result.taskId ?? null,
    worktreePath: result.worktreePath ?? null,
    note: result.note,
    baseAhead: result.baseAhead ?? null,
  };
  await invoke("assistant_mark_dispatched", { projectRoot: project.path, turnAt: turn.at, record }).catch(() => {});
  useAppStore.getState().bumpAssistantEchoTick();
  return `${result.note}。做完了我会告诉你。`;
}

/** 派活进展推到手机：停了 / 失败的目标带「接着做」 */
export async function imPushEcho(projectRoot: string, turnAt: string, text: string, resumable: boolean): Promise<void> {
  if (!(await imPushAllowed())) return;
  const list = await projects();
  const p = list.find((x) => samePath(x.path, projectRoot, IS_WINDOWS));
  const route = p ? asRoute(p) : { path: projectRoot, name: projectRoot.split(/[\\/]/).filter(Boolean).pop() ?? projectRoot };
  const clean = phoneText(text);
  const msgId = await sendCardWithId(echoCard(route, turnAt, clean, resumable));
  if (msgId) putBounded(miscCards, msgId, { kind: "echo", project: route, turnAt, text: clean, resumable });
}

async function turnAnswer(projectPath: string, turnAt: string | undefined): Promise<AssistantTurn | null> {
  if (!turnAt) return null;
  const log = await invoke<AssistantTurn[]>("assistant_log_read", { projectRoot: projectPath }).catch(() => [] as AssistantTurn[]);
  return log.find((t) => t.at === turnAt) ?? null;
}

async function ensureAnswerRecord(
  openMessageId: string | undefined,
  project: ProjectDto,
  turnAt: string | undefined,
): Promise<AnswerCardRecord | null> {
  if (openMessageId && answerCards.has(openMessageId)) return answerCards.get(openMessageId)!;
  const turn = await turnAnswer(project.path, turnAt);
  if (!turn) return null;
  const steps = await stepCount(project.path);
  const input = buildAnswerInputFromTurn(project, turn, steps);
  const rec: AnswerCardRecord = {
    input,
    settled: { clarify: null, dispatched: turn.dispatched ? `${turn.dispatched.note}` : null, remembered: new Set() },
  };
  if (openMessageId) putBounded(answerCards, openMessageId, rec);
  return rec;
}

async function handleCard(value: CardValue, openMessageId?: string): Promise<void> {
  if (value.op === "self_test") {
    toast("手机已点自检按钮，飞书全链路正常", "info");
    await patchOrFallback(openMessageId, selfTestDoneCard(), "✓ 飞书收发与卡片回传自检通过！");
    return;
  }
  const list = await projects();
  if (value.op === "show_queue") {
    const groups = await Promise.all(
      (await busyProjects(list)).map(async (p) => ({ project: asRoute(p), items: await loadDesk(p.path).catch(() => [] as DeskItem[]) })),
    );
    await sendTrackedDeskCard(groups);
    return;
  }
  const project = list.find((p) => samePath(p.path, value.p ?? "", IS_WINDOWS));
  if (!project) return sendText("那个项目在 Mesa 里找不到了。");

  switch (value.op) {
    case "project": {
      writeCurrent(project.path);
      const misc = openMessageId ? miscCards.get(openMessageId) : undefined;
      if (misc?.kind === "list") {
        await patchOrFallback(
          openMessageId,
          projectListCard(misc.projects, project.path, project.name),
          `已切到「${project.name}」。`,
        );
      } else if (misc?.kind === "pick") {
        void invoke("feishu_update_card", {
          messageId: openMessageId,
          card: projectPickCard(misc.projects, misc.question, project.name),
        }).catch(() => {});
      } else if (!value.q?.trim()) {
        await sendText(`已切到「${project.name}」。`);
      }
      const pendingQ = value.q?.trim() ?? "";
      if (!pendingQ) return;
      if (isStatusQuery(pendingQ)) return sendStatus(project);
      return ask(project, pendingQ);
    }
    case "clarify": {
      const rec = await ensureAnswerRecord(openMessageId, project, value.t);
      if (rec && openMessageId && value.t) {
        rec.settled.clarify = value.v ?? "";
        void invoke("feishu_update_card", {
          messageId: openMessageId,
          card: answerCard({ ...rec.input, settled: rec.settled }),
        }).catch(() => {});
      }
      return ask(project, value.v ?? "");
    }
    case "preread": {
      const stepNo = Number(value.v);
      const [read, workspaces] = await Promise.all([
        invoke<ProjectConfigReadDto>("read_project_config", { path: project.path }).catch(() => null),
        invoke<WorkspaceDto[]>("list_workspaces").catch(() => [] as WorkspaceDto[]),
      ]);
      const step = Number.isInteger(stepNo) && stepNo >= 1 ? read?.config.steps[stepNo - 1] : undefined;
      if (!step) return sendText(`第 ${value.v ?? "?"} 步找不到了。`);
      const ws = workspaces.find((w) => w.status !== "archived" && samePath(w.repoPath, project.path, IS_WINDOWS) && w.name === step.workspaceName);
      return ask(
        project,
        reviewPrereadQuestion(stepNo),
        reviewPrereadFocus(stepNo, step.name, { worktree: ws?.worktreePath, artifacts: step.expectedArtifacts }),
      );
    }
    case "remember": {
      const turn = await turnAnswer(project.path, value.t);
      const listRem = turn ? parseRemember(turn.answer).remembers : [];
      const idx = value.v !== undefined ? Number(value.v) : 0;
      const line = Number.isInteger(idx) && idx >= 0 ? (listRem[idx] ?? null) : null;
      if (!line) return sendText("那一句找不到了（问答记录可能清空了）。");
      try {
        await addProjectKnowledge(project.path, line);
        const rec = await ensureAnswerRecord(openMessageId, project, value.t);
        if (rec && openMessageId) {
          rec.settled.remembered.add(idx);
          const ok = await invoke("feishu_update_card", {
            messageId: openMessageId,
            card: answerCard({ ...rec.input, settled: rec.settled }),
          })
            .then(() => true)
            .catch(() => false);
          if (ok) return;
        }
        return sendText(`已记进「${project.name}」的项目知识：${line}`);
      } catch (reason) {
        return sendText(`没记上：${String(reason)}`);
      }
    }
    case "remember_help": {
      const line = (value.v ?? "").trim();
      if (!line) return;
      try {
        await addProjectKnowledge(project.path, line);
        if (openMessageId && value.k) {
          const prev = deskCards.get(openMessageId)?.settled.get(value.k);
          const ok = await markDeskCardSettled(openMessageId, value.k, {
            status: `${prev?.status ?? "已答"} · 已记进项目知识`,
            rememberLine: null,
          });
          if (ok) return;
        }
        return sendText(`已记进「${project.name}」的项目知识：${line}`);
      } catch (reason) {
        return sendText(`没记上：${String(reason)}`);
      }
    }
    case "dispatch": {
      const turn = await turnAnswer(project.path, value.t);
      if (!turn) return sendText("那张派活单找不到了（问答记录可能清空了）。");
      try {
        const note = await dispatchTurnCore(project, turn);
        const rec = await ensureAnswerRecord(openMessageId, project, value.t);
        if (rec && openMessageId) {
          rec.settled.dispatched = note;
          const ok = await invoke("feishu_update_card", {
            messageId: openMessageId,
            card: answerCard({ ...rec.input, settled: rec.settled }),
          })
            .then(() => true)
            .catch(() => false);
          if (ok) return;
        }
        return sendText(note);
      } catch (reason) {
        return sendText(`没派出去：${String(reason instanceof Error ? reason.message : reason)}`);
      }
    }
    case "resume": {
      const turn = await turnAnswer(project.path, value.t);
      const taskId = turn?.dispatched?.taskId;
      if (!taskId) return sendText("那件活找不到了（问答记录可能清空了）。");
      try {
        const msg = await resumeDispatchedGoal(project.path, project, taskId);
        const misc = openMessageId ? miscCards.get(openMessageId) : undefined;
        if (misc?.kind === "echo" && openMessageId) {
          const ok = await invoke("feishu_update_card", {
            messageId: openMessageId,
            card: echoCard(misc.project, misc.turnAt, misc.text, misc.resumable, msg),
          })
            .then(() => true)
            .catch(() => false);
          if (ok) return;
        }
        return sendText(msg);
      } catch (reason) {
        return sendText(`没接上：${String(reason)}`);
      }
    }
    case "trust": {
      const item = (await loadDesk(project.path)).find((i) => i.key === value.k && i.kind === "trust");
      if (!item?.trust) return sendText("它已经不在信任菜单上了（可能你在电脑上点过了）。");
      if (!item.trust.dispatched) return sendText("这件不是经项目助手派出去的，信任文件夹要回到电脑上点。");
      const accept = value.v === "yes";
      answerTrust(item, accept);
      const msg = accept ? `已在电脑上替你选了「${item.trust.yes}」，${item.where}接着干` : `已在电脑上替你选了「${item.trust.no}」，它会退出`;
      if (!(await markDeskCardSettled(openMessageId, item.key, { status: msg }))) {
        await sendText(`${msg}。`);
      }
      return;
    }
    case "grant": {
      // 只放宽这一次（点一下就生效档，assistant-ops.ts grant_once）；以后都放宽回电脑改
      if (!opAllowed("grant_once", "phone")) return sendText("这件要回到电脑上处理。");
      const item = (await loadDesk(project.path)).find((i) => i.key === value.k && i.kind === "grant");
      if (!item) return sendText("这件已经处理过了（可能你在电脑上点过了）。");
      try {
        const msg = await answerGrant(item, value.v === "once");
        if (!(await markDeskCardSettled(openMessageId, item.key, { status: msg }))) {
          await sendText(msg);
        }
      } catch (reason) {
        await sendText(`没办成：${String(reason)}`);
      }
      return;
    }
    case "reply_target": {
      const items = await loadDesk(project.path);
      const item = items.find((i) => i.key === value.k);
      if (!item) return sendText("这件事已经处理过了，或者不在了。");
      pendingReplyTarget = {
        projectPath: project.path,
        projectName: project.name,
        key: item.key,
        where: item.where,
        sourceCardId: openMessageId ?? null,
        expiresAt: Date.now() + REPLY_TARGET_TTL_MS,
      };
      return sendText(`请直接发你要回给「${project.name} · ${item.where}」的话（10 分钟内有效，发「取消」放弃）。`);
    }
    case "reply_pick": {
      const body = (value.q ?? "").trim();
      if (!body || !value.k) return;
      const misc = openMessageId ? miscCards.get(openMessageId) : undefined;
      await deliverDeskReply(project.path, value.k, body, null, false);
      if (misc?.kind === "reply_pick" && openMessageId) {
        const picked = misc.choices.find((c) => c.key === value.k);
        await patchOrFallback(
          openMessageId,
          replyPickCard(misc.choices, misc.replyBody, `已送给「${picked ? `${picked.projectName} · ${picked.where}` : project.name}」`),
        );
      } else {
        await sendText("已原话送出。");
      }
      return;
    }
    case "desk": {
      if (!value.k) return;
      return deliverDeskReply(project.path, value.k, value.v ?? "", openMessageId, false);
    }
  }
}

/** 新出现的人工请求推到手机（同一条只推一次，记在本机）；派活回音由 assistant-echo-watch 推 */
export async function pushNewHelp(): Promise<void> {
  if (!(await imPushAllowed())) return;
  const help = helpNotDismissed(
    await invoke<HelpRequestDto[]>("list_help_requests").catch(() => [] as HelpRequestDto[]),
    loadHelpDismissed(),
  );
  let pushed: string[] = [];
  try {
    pushed = JSON.parse(localStorage.getItem(PUSHED_KEY) ?? "[]");
  } catch {
    pushed = [];
  }
  const fresh = help.filter((h) => h.items.some((i) => !i.answer && !i.sent && !pushed.includes(`${h.root}:${i.id}`)));
  if (!fresh.length) return;
  const list = await projects();
  const groups = await Promise.all(
    list
      .filter((p) => fresh.some((h) => samePath(h.repoPath, p.path, IS_WINDOWS)))
      .map(async (p) => ({ project: asRoute(p), items: (await loadDesk(p.path).catch(() => [] as DeskItem[])).filter((i) => i.kind === "help") })),
  );
  if (!groups.some((g) => g.items.length)) return;
  if (!(await sendTrackedDeskCard(groups))) return;
  for (const g of groups) {
    for (const i of g.items) {
      if (i.helpRoot && i.helpItemId) pushed.push(`${i.helpRoot}:${i.helpItemId}`);
    }
  }
  try {
    localStorage.setItem(PUSHED_KEY, JSON.stringify([...new Set(pushed)].slice(-500)));
  } catch {
    /* 记不下最多重推一次 */
  }
}

/** 定时任务被授权范围拦下：推到手机（同一次请求只推一次，记在本机），带「放宽重跑这一次 / 不用」 */
export async function pushNewGrants(): Promise<void> {
  if (!(await imPushAllowed())) return;
  const schedules = await invoke<ScheduleDto[]>("list_schedules").catch(() => [] as ScheduleDto[]);
  let pushed: string[] = [];
  try {
    pushed = JSON.parse(localStorage.getItem(PUSHED_GRANT_KEY) ?? "[]");
  } catch {
    pushed = [];
  }
  const fresh = schedules.filter((s) => s.grantRequest && !pushed.includes(`${s.id}:${s.grantRequest.at}`));
  if (!fresh.length) return;
  const list = await projects();
  const groups = await Promise.all(
    list
      .filter((p) => fresh.some((s) => samePath(s.projectRoot, p.path, IS_WINDOWS)))
      .map(async (p) => ({ project: asRoute(p), items: (await loadDesk(p.path).catch(() => [] as DeskItem[])).filter((i) => i.kind === "grant") })),
  );
  if (!groups.some((g) => g.items.length)) return;
  if (!(await sendTrackedDeskCard(groups))) return;
  for (const s of fresh) {
    if (groups.some((g) => samePath(g.project.path, s.projectRoot, IS_WINDOWS))) {
      pushed.push(`${s.id}:${s.grantRequest!.at}`);
    }
  }
  try {
    localStorage.setItem(PUSHED_GRANT_KEY, JSON.stringify([...new Set(pushed)].slice(-200)));
  } catch {
    /* 记不下最多重推一次 */
  }
}

/** 步骤做完等评审 / 出错、非派活目标做完等验收 / 出错：复用桌宠取数推到手机（首次建基线不倒历史旧账） */
export async function pushMilestones(): Promise<void> {
  const cfg = await imPushAllowed();
  if (!cfg || cfg.notifyMilestones === false) return;
  const list = await projects();
  const active = await busyProjects(list);
  if (!active.length) return;
  const openDispatches = await invoke<OpenDispatch[]>("assistant_open_dispatches").catch(() => [] as OpenDispatch[]);
  const dispatchedGoalNames = new Set<string>();
  for (const d of openDispatches) {
    if (d.record.mode === "goal" && d.record.title) dispatchedGoalNames.add(`${d.projectRoot}|goal-${d.record.title}`);
  }
  const now = new Date();
  const currentItems = (
    await Promise.all(
      active.map(async (p) => {
        const brief = await gatherBriefInput(p.path, null).catch(() => null);
        return brief ? petItemsFromBrief(asRoute(p), brief, now) : [];
      }),
    )
  )
    .flat()
    .filter((item) => {
      // 经项目助手派出去的目标已有 imPushEcho 专门推送，这里不重复推第二次
      const goalMatch = item.key.match(/^(.+)\|goal-(?:review|failed):(.+)$/);
      if (goalMatch && dispatchedGoalNames.has(`${goalMatch[1]}|goal-${goalMatch[2]}`)) return false;
      return true;
    });

  let rawStored: string | null = null;
  try {
    rawStored = localStorage.getItem(PUSHED_MILESTONE_KEY);
  } catch {
    rawStored = null;
  }
  const currentKeys = new Set(currentItems.map((i) => i.key));
  if (rawStored === null) {
    // 第一次开启时不把存量待审一股脑全推过去，先记下当前基线
    try {
      localStorage.setItem(PUSHED_MILESTONE_KEY, JSON.stringify([...currentKeys].slice(-300)));
    } catch {
      /* ignore */
    }
    return;
  }
  let seen: Set<string>;
  try {
    const parsed = JSON.parse(rawStored);
    seen = new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    seen = new Set();
  }
  // 已经评审掉 / 不再处于 review|failed 的键清出集合，下一轮再完成时能正常再推
  const retained = new Set([...seen].filter((k) => currentKeys.has(k)));
  const arrivals = currentItems.filter((i) => !retained.has(i.key));
  if (arrivals.length > 0) {
    if (!(await sendCard(milestoneCard(arrivals)))) return;
    for (const a of arrivals) retained.add(a.key);
  }
  try {
    localStorage.setItem(PUSHED_MILESTONE_KEY, JSON.stringify([...retained].slice(-300)));
  } catch {
    /* ignore */
  }
}

/** 正在推着的「卡住了」（信任文件夹 / 等确认）：同一件只推一次，它不卡了再卡才再推 */
const stuckPushed = new Set<string>();

/** 派出去的活停在信任文件夹或等确认：推到手机（信任且是你派的活带按钮；等确认只提醒回电脑） */
export async function pushStuck(): Promise<void> {
  const live = useAppStore.getState().terminalRunInputs.filter((r) => !!r.blocker);
  const liveKeys = new Set(live.flatMap((r) => [`trust:${r.tabId}`, `confirm:${r.tabId}`, `blocked:${r.tabId}`]));
  for (const key of [...stuckPushed]) if (!liveKeys.has(key)) stuckPushed.delete(key);
  if (!live.length || !(await imPushAllowed())) return;
  const roots = new Set<string>();
  for (const r of live) {
    if (!r.runId) continue;
    const run = await invoke<{ projectRoot: string | null } | null>("run_get", { id: r.runId }).catch(() => null);
    if (run?.projectRoot) roots.add(run.projectRoot);
  }
  const list = await projects();
  const groups: { project: RouteProject; items: DeskItem[] }[] = [];
  for (const root of roots) {
    const p = list.find((x) => samePath(x.path, root, IS_WINDOWS));
    if (!p) continue;
    const items = (await loadDesk(p.path).catch(() => [] as DeskItem[])).filter(
      (i) => (i.kind === "trust" || i.kind === "confirm" || i.kind === "blocked") && !stuckPushed.has(i.key),
    );
    if (items.length) groups.push({ project: asRoute(p), items });
  }
  if (!groups.length) return;
  if (!(await sendTrackedDeskCard(groups))) return;
  for (const g of groups) for (const i of g.items) stuckPushed.add(i.key);
}

let chain: Promise<void> = Promise.resolve();
let pendingJobs = 0;

/** 一条一条处理（手机上连发几句时按顺序答，不并发问 AI） */
function enqueue(job: () => Promise<void>): void {
  pendingJobs += 1;
  chain = chain
    .then(job)
    .catch(() => {})
    .finally(() => {
      pendingJobs = Math.max(0, pendingJobs - 1);
    });
}

function ackInbound(ackId?: number | null): void {
  if (typeof ackId === "number") {
    void invoke("feishu_ack_inbound", { id: ackId }).catch(() => {});
  }
}

/** 排队时若需要调 AI，先在入队前发出「排上队了」占位卡片，进队后再原地换成回答卡片 */
async function prepareQueuedPlaceholder(textRaw: string, parentId?: string | null): Promise<string | null> {
  if (pendingJobs === 0) return null;
  const text = textRaw.trim();
  if (!text || isMetaCommand(text) || isCancelReply(text) || quickIntent(text)) return null;
  if (pendingReplyTarget && Date.now() < pendingReplyTarget.expiresAt) return null;
  if (parentId) {
    const memDesk = deskCards.get(parentId);
    const idx = findCardIndexEntry(parentId);
    if (memDesk || idx?.kind === "desk") return null;
  }
  const list = await projects();
  const current = list.find((p) => samePath(p.path, readCurrent() ?? "", IS_WINDOWS)) ?? null;
  const route = routeMessage(text, list.map(asRoute), current ? asRoute(current) : null);
  if (route.kind !== "ask" || localReply(route.text, new Date().getHours())) return null;
  return sendCardWithId(
    thinkingCard(route.project, route.text, `前面还有 ${pendingJobs} 条消息在处理，已排上队…`),
  );
}

/** App 里挂一次：收手机消息与卡片按钮；返回取消函数 */
export async function startImBridge(): Promise<() => void> {
  const offMessage = await listen<{ text: string; parentId?: string | null; ackId?: number | null }>("feishu-message", (e) => {
    ackInbound(e.payload.ackId);
    const text = e.payload.text ?? "";
    const parentId = e.payload.parentId ?? null;
    void prepareQueuedPlaceholder(text, parentId).then((placeholderId) => {
      enqueue(() => handleMessage(text, parentId, placeholderId));
    });
  });
  const offCard = await listen<{ value: CardValue; openMessageId?: string; ackId?: number | null }>("feishu-card-action", (e) => {
    ackInbound(e.payload.ackId);
    enqueue(() => handleCard(e.payload.value, e.payload.openMessageId));
  });
  const offStatus = await listen("feishu-status", () => forgetImConfig());
  return () => {
    offMessage();
    offCard();
    offStatus();
  };
}
