/**
 * 桌宠的主窗口一侧（2026-11-09；设计稿 docs/design-desk-pet.md）：
 * - 取数：每 20 秒（小窗刚开时立刻）跨项目收「等你的事」与「现在的情况」，拼成清单发给桌宠小窗（desk-pet:feed）；
 *   取数函数与项目助手、手机通道同一份（loadDesk / gatherBriefInput），不另判。
 * - 转达：小窗上点的选项 / 写的一句 / 放宽授权 / 信任菜单（desk-pet:act）在这里按「等你的事」原路办，办完回一句（desk-pet:act-done）。
 * - 去看看：Rust desk_pet_open 叫回主窗口后发 desk-pet:open，这里跳到那个地方。
 * - 问小桌（第二期）：小窗发 desk-pet:ask，这里交给那个项目的项目助手（同手机 askProjectAssistant，问答照常记进那个项目），
 *   边想边回 desk-pet:ask-progress，答完回 desk-pet:ask-done；起草了派活单 / 补料单 / 规矩的只说一句、带去 Mesa 里看。
 * 主窗口关着时只是藏到后台，这里照常跑；退出 Mesa 时桌宠一起走。
 */
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "./store";
import { IS_WINDOWS } from "./hotkeys";
import { pathWithin, samePath } from "./path-utils";
import { answerGrant, answerTrust, loadDesk, replyDesk } from "./assistant-desk";
import { gatherBriefInput } from "./project-assistant-run";
import { runAssistantAction } from "./assistant-actions";
import { helpNotDismissed, optionAnswer } from "./help-requests";
import { loadHelpDismissed } from "./inbox";
import { askProjectAssistant, type AssistantTurn } from "./project-assistant-run";
import { dispatchWorkOrder, resumeDispatchedGoal, type DispatchRecord } from "./assistant-dispatch";
import { quickIntent } from "./im-route";
import { guardClaims, localReply, parseAssistantAnswer, parseClarify, parseRemember, parseReworkOrder, parseWorkOrder } from "./project-assistant";
import { briefWorking, deskOnlyNotes, petItemsFromBrief, petItemsFromDesk, type PetFeed, type PetItem, type PetOpen } from "./desk-pet";
import type { DeskItem } from "./assistant-queue";
import type { HelpRequestDto, ProjectDto, TaskDto, WorkspaceDto } from "./types";

const PET_LABEL = "desk-pet";
const FEED_MS = 20_000;
/** 跨项目一次最多看几个（同手机「等我的」）：有事的项目优先，不把每个项目都读一遍 */
const MAX_PROJECTS = 8;

export interface PetAct {
  reqId: string;
  projectPath: string;
  key: string;
  /** reply：value 是选项键或写的一句；grant / trust：accept */
  tap: "reply" | "grant" | "trust";
  value?: string;
  /** 选项按钮：带上选项文字，写进文件是「B（期刊 + 顶会）」 */
  optionLabel?: string;
  accept?: boolean;
}

function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  return p.then((v) => v ?? fallback).catch(() => fallback);
}

/** 有事的项目：开着工作副本、有人工请求、有终端在等确认，或有目标在跑 / 等验收 / 没做完 */
async function activeProjects(): Promise<ProjectDto[]> {
  const [projects, workspaces, help, tasks] = await Promise.all([
    safe(invoke<ProjectDto[]>("list_projects"), []),
    safe(invoke<WorkspaceDto[]>("list_workspaces"), []),
    safe(invoke<HelpRequestDto[]>("list_help_requests"), []).then((list) => helpNotDismissed(list, loadHelpDismissed())),
    safe(invoke<TaskDto[]>("task_list", { projectRoot: null, includeArchived: false }), []),
  ]);
  const live = useAppStore.getState().terminalRunInputs;
  const hot = new Set(["running", "pending_review", "failed", "stopped"]);
  return projects
    .filter(
      (p) =>
        workspaces.some((w) => w.status !== "archived" && samePath(w.repoPath, p.path, IS_WINDOWS)) ||
        help.some((h) => samePath(h.repoPath, p.path, IS_WINDOWS)) ||
        live.some((r) => r.attention === "confirm" && pathWithin(r.cwd, p.path, IS_WINDOWS)) ||
        tasks.some((t) => hot.has(t.status) && !!t.projectRoot && samePath(t.projectRoot, p.path, IS_WINDOWS)),
    )
    .slice(0, MAX_PROJECTS);
}

export interface PetAsk {
  reqId: string;
  projectPath: string;
  question: string;
}

async function askFromPet(a: PetAsk, progress: (text: string) => void): Promise<{ text: string; clarify: { question: string; options: string[] } | null; deskOnly: string[] }> {
  const projects = await safe(invoke<ProjectDto[]>("list_projects"), []);
  const project = projects.find((p) => samePath(p.path, a.projectPath, IS_WINDOWS)) ?? null;
  if (!project) throw new Error("这个项目已经不在 Mesa 里了");
  const q = a.question.trim();
  const fullLog = await safe(invoke<AssistantTurn[]>("assistant_log_read", { projectRoot: project.path }), []);
  const read = await safe(invoke<{ config: { steps: unknown[] } } | null>("read_project_config", { path: project.path }), null);
  const steps = read?.config.steps.length ?? 0;
  // 与桌面面板、手机通道一致：「派出去」「接着做」按字面办，寒暄本地直接回，不白调一次 AI
  const quick = quickIntent(q);
  if (quick === "dispatch") {
    const last = [...fullLog].reverse().find((t) => !t.echoOf && t.answer.includes(":::派活"));
    const order = last ? parseWorkOrder(parseReworkOrder(parseClarify(parseRemember(last.answer).text).text, steps).text, steps).order : null;
    if (!last || !order || last.dispatched) {
      return { text: "现在没有还没派的单子。先说要做什么，起草好单子再派。", clarify: null, deskOnly: [] };
    }
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
    };
    await invoke("assistant_mark_dispatched", { projectRoot: project.path, turnAt: last.at, record }).catch(() => {});
    useAppStore.getState().bumpAssistantEchoTick();
    return { text: result.note, clarify: null, deskOnly: [] };
  }
  if (quick === "resume") {
    const last = [...fullLog].reverse().find(
      (t) => t.dispatched?.mode === "goal" && t.dispatched.taskId && (t.dispatched.echoed === "stopped" || t.dispatched.echoed === "failed"),
    );
    if (!last?.dispatched?.taskId) {
      return { text: "没有停下的、经项目助手派出去的活。", clarify: null, deskOnly: [] };
    }
    return { text: await resumeDispatchedGoal(project.path, project, last.dispatched.taskId), clarify: null, deskOnly: [] };
  }
  const canned = localReply(q, new Date().getHours());
  if (canned) {
    await invoke("assistant_log_append", { projectRoot: project.path, question: q, answer: canned }).catch(() => {});
    useAppStore.getState().bumpAssistantEchoTick();
    return { text: canned, clarify: null, deskOnly: [] };
  }
  const history = fullLog.filter((t) => !t.echoOf);
  const turn = await askProjectAssistant({
    projectPath: project.path,
    project,
    question: q,
    history,
    focus: null,
    where: "桌面上的小桌（桌宠）",
    onStream: (u) => {
      if (u.step) progress(u.step);
    },
  });
  useAppStore.getState().bumpAssistantEchoTick();
  const memo = parseRemember(turn.answer);
  const clar = parseClarify(memo.text);
  const rework = parseReworkOrder(clar.text, steps);
  const order = parseWorkOrder(rework.text, steps);
  const parsed = parseAssistantAnswer(order.text, steps);
  return {
    text: guardClaims(parsed.text).text,
    clarify: clar.ask,
    deskOnly: deskOnlyNotes({ order: !!order.order, rework: !!rework.rework, remember: memo.remembers.length, actions: parsed.actions.length }),
  };
}

export async function buildPetFeed(): Promise<PetFeed> {
  const list = await activeProjects();
  const now = new Date();
  const parts = await Promise.all(
    list.map(async (p) => {
      const [desk, brief] = await Promise.all([
        loadDesk(p.path).catch(() => [] as DeskItem[]),
        gatherBriefInput(p.path, null).catch(() => null),
      ]);
      const project = { path: p.path, name: p.name };
      return {
        items: [...petItemsFromDesk(project, desk), ...(brief ? petItemsFromBrief(project, brief, now) : [])],
        working: brief ? briefWorking(brief) : false,
      };
    }),
  );
  const live = useAppStore.getState().terminalRunInputs;
  const working = parts.some((p) => p.working) || live.some((r) => r.running && !r.shell && r.attention === "working");
  // 问小桌时可选的项目：有事的排前面，其余按 Mesa 里的顺序
  const all = await safe(invoke<ProjectDto[]>("list_projects"), []);
  const askProjects = [...list, ...all.filter((p) => !list.some((q) => samePath(q.path, p.path, IS_WINDOWS)))].map((p) => ({ path: p.path, name: p.name }));
  return { working, items: parts.flatMap((p) => p.items), projects: askProjects };
}

async function act(a: PetAct): Promise<string> {
  const items = await loadDesk(a.projectPath);
  const item = items.find((i) => i.key === a.key);
  if (!item) throw new Error("这件事已经办过或不在了");
  if (a.tap === "reply") {
    const text = a.optionLabel ? optionAnswer(a.value ?? "", a.optionLabel) : (a.value ?? "");
    return replyDesk(a.projectPath, item, text);
  }
  if (a.tap === "grant") return answerGrant(item, !!a.accept);
  // 信任菜单只替你经项目助手派出去的活按（与手机同档）；其余回电脑上看
  if (!item.trust?.dispatched) throw new Error("这个文件夹要回到电脑上的终端里确认");
  answerTrust(item, !!a.accept);
  return a.accept ? "已信任，接着做" : "已选不信任";
}

async function openTarget(target: PetOpen | null): Promise<void> {
  if (!target) return;
  const st = useAppStore.getState();
  if (target.kind === "assistant") {
    st.openAssistant(target.projectPath);
    return;
  }
  if (target.kind === "tab") {
    st.setFocusTabReq(target.tabId);
    st.setPage("terminal");
    return;
  }
  const projects = await safe(invoke<ProjectDto[]>("list_projects"), []);
  const project = projects.find((p) => samePath(p.path, target.projectPath, IS_WINDOWS)) ?? null;
  await runAssistantAction(target.action, null, { path: target.projectPath, project });
}

/** App 里挂一次（ProjectAssistantHost）：返回取消函数 */
export async function startDeskPetHost(): Promise<() => void> {
  let busy = false;
  const push = async () => {
    if (busy || !useAppStore.getState().settings?.deskPetEnabled) return;
    busy = true;
    try {
      const feed = await buildPetFeed();
      await emitTo(PET_LABEL, "desk-pet:feed", feed).catch(() => {});
    } finally {
      busy = false;
    }
  };
  const offs = await Promise.all([
    listen("desk-pet:ready", () => {
      void push();
      void emitTo(PET_LABEL, "desk-pet:main-focus", document.hasFocus() && !document.hidden).catch(() => {});
    }),
    // Mesa 窗口在前台（你正看着）时小桌安静档不动：把前台 / 后台的变化告诉小窗
    getCurrentWindow().onFocusChanged(({ payload }) => void emitTo(PET_LABEL, "desk-pet:main-focus", payload).catch(() => {})),
    listen<PetAct>("desk-pet:act", (e) => {
      const a = e.payload;
      void act(a).then(
        (message) => emitTo(PET_LABEL, "desk-pet:act-done", { reqId: a.reqId, ok: true, message }),
        (reason) => emitTo(PET_LABEL, "desk-pet:act-done", { reqId: a.reqId, ok: false, message: String(reason instanceof Error ? reason.message : reason) }),
      ).finally(() => window.setTimeout(() => void push(), 1500));
    }),
    listen<PetOpen | { kind: "settings" } | null>("desk-pet:open", (e) => {
      const t = e.payload;
      if (t && t.kind === "settings") {
        const st = useAppStore.getState();
        st.setSettingsSectionReq("startup");
        st.setPage("settings");
        return;
      }
      void openTarget(t as PetOpen | null);
    }),
    listen<PetAsk>("desk-pet:ask", (e) => {
      const a = e.payload;
      void askFromPet(a, (text) => void emitTo(PET_LABEL, "desk-pet:ask-progress", { reqId: a.reqId, text })).then(
        (r) => emitTo(PET_LABEL, "desk-pet:ask-done", { reqId: a.reqId, ok: true, ...r }),
        (reason) =>
          emitTo(PET_LABEL, "desk-pet:ask-done", { reqId: a.reqId, ok: false, text: String(reason instanceof Error ? reason.message : reason), clarify: null, deskOnly: [] }),
      );
    }),
    // 桌宠右键「隐藏」、托盘开关：设置页跟着刷新
    listen("desk-pet:hidden", () => void useAppStore.getState().loadSettings()),
  ]);
  const timer = window.setInterval(() => void push(), FEED_MS);
  void push();
  return () => {
    window.clearInterval(timer);
    offs.forEach((off) => off());
  };
}

export type { PetItem };
