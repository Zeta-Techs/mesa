/**
 * 飞书通道的前端桥（2026-11-06 docs/design-assistant-dispatch-desk.md §3）：
 * 后端 feishu.rs 只管长连接收发；这里接住 feishu-message / feishu-card-action，交给总助手路由（im-route.ts）→
 * 项目助手问一次（与桌面同一条 askProjectAssistant、记进同一份问答记录）→ 回答拼成卡片（im-cards.ts）发回手机。
 * 卡片按钮按动作分级（assistant-ops.ts）执行：手机上只做「你点一下就生效」那一档。
 * 推送：派活回音、新出现的人工请求（同一件只推一次）。只有绑定过、连上了才推。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "./store";
import { IS_WINDOWS } from "./hotkeys";
import { pathWithin, samePath } from "./path-utils";
import { askProjectAssistant, type AssistantTurn } from "./project-assistant-run";
import {
  actionLabel,
  parseAssistantAnswer,
  parseClarify,
  parseRemember,
  parseWorkOrder,
} from "./project-assistant";
import { actionOp, opAllowed } from "./assistant-ops";
import { dispatchWorkOrder, type DispatchRecord } from "./assistant-dispatch";
import { addProjectKnowledge, loadDesk, replyDesk } from "./assistant-desk";
import { IM_HELP_TEXT, routeMessage, type RouteProject } from "./im-route";
import { answerCard, deskCard, phoneText, projectPickCard, type CardValue } from "./im-cards";
import type { DeskItem } from "./assistant-queue";
import type { HelpRequestDto, ProjectConfigReadDto, ProjectDto, WorkspaceDto } from "./types";

export interface FeishuConfig {
  enabled: boolean;
  appId: string;
  hasSecret: boolean;
  boundUser: string | null;
  status: string;
  lastError: string | null;
}

const CURRENT_KEY = "ccode.imCurrentProject";
const PUSHED_KEY = "ccode.imPushedHelp";

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
  if (projectsCache && Date.now() - projectsCache.at < 60_000) return projectsCache.list;
  const list = await invoke<ProjectDto[]>("list_projects").catch(() => [] as ProjectDto[]);
  projectsCache = { at: Date.now(), list };
  return list;
}

const asRoute = (p: ProjectDto): RouteProject => ({ path: p.path, name: p.name });

async function sendText(text: string): Promise<void> {
  await invoke("feishu_send_text", { text }).catch(() => {});
}

async function sendCard(card: object): Promise<void> {
  await invoke("feishu_send_card", { card }).catch(() => sendText("（卡片没发出去）"));
}

let configCache: { at: number; cfg: FeishuConfig | null } | null = null;
/** 连上了、绑定过才推送（30 秒内不重复问后端） */
export async function imReady(): Promise<boolean> {
  if (!configCache || Date.now() - configCache.at > 30_000) {
    const cfg = await invoke<FeishuConfig>("feishu_config_get").catch(() => null);
    configCache = { at: Date.now(), cfg };
  }
  const cfg = configCache.cfg;
  return !!cfg?.enabled && !!cfg.boundUser && cfg.status === "online";
}

export function forgetImConfig(): void {
  configCache = null;
}

/** 推一句文字到手机（派活回音用）；没连上就算了 */
export async function imPushText(text: string): Promise<void> {
  if (await imReady()) await sendText(text);
}

async function stepCount(path: string): Promise<number> {
  const read = await invoke<ProjectConfigReadDto>("read_project_config", { path }).catch(() => null);
  return read?.config.steps.length ?? 0;
}

/** 交给某个项目的项目助手问一次，把回答拼成卡片发回 */
async function ask(project: ProjectDto, question: string): Promise<void> {
  writeCurrent(project.path);
  await sendText(`收到，交给「${project.name}」的项目助手，稍等。`);
  const history = (await invoke<AssistantTurn[]>("assistant_log_read", { projectRoot: project.path }).catch(() => [] as AssistantTurn[])).filter(
    (t) => !t.echoOf,
  );
  let turn: AssistantTurn;
  try {
    turn = await askProjectAssistant({ projectPath: project.path, project, question, history, focus: null, where: "手机（飞书）" });
  } catch (reason) {
    await sendText(`没问成：${String(reason)}`);
    return;
  }
  useAppStore.getState().bumpAssistantEchoTick();
  const steps = await stepCount(project.path);
  const memo = parseRemember(turn.answer);
  const clar = parseClarify(memo.text);
  const order = parseWorkOrder(clar.text, steps);
  const parsed = parseAssistantAnswer(order.text, steps);
  const desktopOnly = parsed.actions.filter((a) => !opAllowed(actionOp(a.kind), "phone")).map((a) => actionLabel(a.kind, a.step));
  await sendCard(
    answerCard({
      project: asRoute(project),
      turnAt: turn.at,
      text: phoneText(parsed.text),
      ask: clar.ask,
      order: order.order,
      remember: memo.remember,
      desktopOnly,
    }),
  );
}

/** 有事等你的项目（开着工作副本、有人工请求、有终端在等确认的），最多 8 个：「等我的」只看这些，不把每个项目的对话都读一遍 */
async function busyProjects(list: ProjectDto[]): Promise<ProjectDto[]> {
  const [workspaces, help] = await Promise.all([
    invoke<WorkspaceDto[]>("list_workspaces").catch(() => [] as WorkspaceDto[]),
    invoke<HelpRequestDto[]>("list_help_requests").catch(() => [] as HelpRequestDto[]),
  ]);
  const live = useAppStore.getState().terminalRunInputs;
  return list
    .filter(
      (p) =>
        workspaces.some((w) => w.status !== "archived" && samePath(w.repoPath, p.path, IS_WINDOWS)) ||
        help.some((h) => samePath(h.repoPath, p.path, IS_WINDOWS)) ||
        live.some((r) => r.attention === "confirm" && pathWithin(r.cwd, p.path, IS_WINDOWS)),
    )
    .slice(0, 8);
}

async function handleMessage(text: string): Promise<void> {
  const list = await projects();
  const current = list.find((p) => samePath(p.path, readCurrent() ?? "", IS_WINDOWS)) ?? null;
  const route = routeMessage(text, list.map(asRoute), current ? asRoute(current) : null);
  const byPath = (path: string) => list.find((p) => samePath(p.path, path, IS_WINDOWS))!;
  switch (route.kind) {
    case "help":
      return sendText(IM_HELP_TEXT);
    case "list":
      return sendText(
        list.length
          ? `${list.map((p) => `· ${p.name}${current && samePath(p.path, current.path, IS_WINDOWS) ? "（当前）" : ""}`).join("\n")}\n说「切到 项目名」换默认项目。`
          : "Mesa 里还没有项目。",
      );
    case "unknown_project":
      return sendText(`没找到叫「${route.name}」的项目（或者有好几个都像），说「项目」看列表。`);
    case "switch":
      writeCurrent(route.project.path);
      return sendText(`已切到「${route.project.name}」，接下来直接说事就交给它。`);
    case "pick":
      return sendCard(projectPickCard(list.map(asRoute), route.text));
    case "queue": {
      const groups = await Promise.all(
        (await busyProjects(list)).map(async (p) => ({ project: asRoute(p), items: await loadDesk(p.path).catch(() => [] as DeskItem[]) })),
      );
      return sendCard(deskCard(groups));
    }
    case "reply": {
      const items = await loadDesk(route.project.path);
      const item = items.find((i) => i.step === route.step && i.kind !== "confirm");
      if (!item) return sendText(`「${route.project.name}」第 ${route.step} 步现在没有在问你的事。说「等我的」看看有什么。`);
      try {
        return sendText(await replyDesk(route.project.path, item, route.text));
      } catch (reason) {
        return sendText(`没送出去：${String(reason)}`);
      }
    }
    case "ask":
      return ask(byPath(route.project.path), route.text);
  }
}

async function turnAnswer(projectPath: string, turnAt: string | undefined): Promise<AssistantTurn | null> {
  if (!turnAt) return null;
  const log = await invoke<AssistantTurn[]>("assistant_log_read", { projectRoot: projectPath }).catch(() => [] as AssistantTurn[]);
  return log.find((t) => t.at === turnAt) ?? null;
}

async function handleCard(value: CardValue): Promise<void> {
  const list = await projects();
  const project = list.find((p) => samePath(p.path, value.p ?? "", IS_WINDOWS));
  if (!project) return sendText("那个项目在 Mesa 里找不到了。");
  switch (value.op) {
    case "project":
      writeCurrent(project.path);
      if (value.q?.trim()) return ask(project, value.q);
      return sendText(`已切到「${project.name}」。`);
    case "clarify":
      return ask(project, value.v ?? "");
    case "remember": {
      const turn = await turnAnswer(project.path, value.t);
      const line = turn ? parseRemember(turn.answer).remember : null;
      if (!line) return sendText("那一句找不到了（问答记录可能清空了）。");
      try {
        await addProjectKnowledge(project.path, line);
        return sendText(`已记进「${project.name}」的项目知识：${line}`);
      } catch (reason) {
        return sendText(`没记上：${String(reason)}`);
      }
    }
    case "dispatch": {
      const turn = await turnAnswer(project.path, value.t);
      if (!turn) return sendText("那张派活单找不到了（问答记录可能清空了）。");
      if (turn.dispatched) return sendText(`这张单已经派过了：${turn.dispatched.note}`);
      const steps = await stepCount(project.path);
      const order = parseWorkOrder(parseClarify(parseRemember(turn.answer).text).text, steps).order;
      if (!order) return sendText("那一轮里没有能派的单子。");
      try {
        const result = await dispatchWorkOrder({ order, projectPath: project.path, project });
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
        };
        await invoke("assistant_mark_dispatched", { projectRoot: project.path, turnAt: turn.at, record }).catch(() => {});
        useAppStore.getState().bumpAssistantEchoTick();
        return sendText(`${result.note}。做完了我会告诉你。`);
      } catch (reason) {
        return sendText(`没派出去：${String(reason)}`);
      }
    }
    case "desk": {
      const items = await loadDesk(project.path);
      const item = items.find((i) => i.key === value.k);
      if (!item) return sendText("这件事已经处理过了，或者不在了。");
      try {
        return sendText(await replyDesk(project.path, item, value.v ?? ""));
      } catch (reason) {
        return sendText(`没送出去：${String(reason)}`);
      }
    }
  }
}

/** 新出现的人工请求推到手机（同一条只推一次，记在本机）；派活回音由 assistant-echo-watch 推 */
export async function pushNewHelp(): Promise<void> {
  if (!(await imReady())) return;
  const help = await invoke<HelpRequestDto[]>("list_help_requests").catch(() => [] as HelpRequestDto[]);
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
  await sendCard(deskCard(groups));
  for (const h of fresh) for (const i of h.items) pushed.push(`${h.root}:${i.id}`);
  try {
    localStorage.setItem(PUSHED_KEY, JSON.stringify(pushed.slice(-500)));
  } catch {
    /* 记不下最多重推一次 */
  }
}

let chain: Promise<void> = Promise.resolve();
/** 一条一条处理（手机上连发几句时按顺序答，不并发问 AI） */
function enqueue(job: () => Promise<void>): void {
  chain = chain.then(job).catch(() => {});
}

/** App 里挂一次：收手机消息与卡片按钮；返回取消函数 */
export async function startImBridge(): Promise<() => void> {
  const offMessage = await listen<{ text: string }>("feishu-message", (e) => enqueue(() => handleMessage(e.payload.text ?? "")));
  const offCard = await listen<{ value: CardValue }>("feishu-card-action", (e) => enqueue(() => handleCard(e.payload.value)));
  const offStatus = await listen("feishu-status", () => forgetImConfig());
  return () => {
    offMessage();
    offCard();
    offStatus();
  };
}
