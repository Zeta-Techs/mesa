/**
 * 总助手的路由（2026-11-06 docs/design-assistant-dispatch-desk.md §1 第 6 条、§3）：手机上的一句话交给哪个项目助手。
 * 只认你点名、「切到」过的、或上一次说的项目，不靠 AI 猜；跨项目不搬数据，只汇总「等你的事」。纯逻辑，配 tests/im-route.test.ts。
 */

export interface RouteProject {
  path: string;
  name: string;
}

export type ImRoute =
  | { kind: "help" }
  | { kind: "list" }
  | { kind: "queue" }
  | { kind: "status"; project: RouteProject }
  | { kind: "switch"; project: RouteProject }
  | { kind: "ask"; project: RouteProject; text: string }
  /** 「回第 2 步 …」或「回：…」：原话送进那处正在问你的对话或人工请求（调度台转达；step=null 按当前唯一待回项或弹选择卡） */
  | { kind: "reply"; project: RouteProject; step: number | null; text: string }
  /** 说不清是哪个项目：给项目按钮让人点，点了再办这句 */
  | { kind: "pick"; text: string }
  | { kind: "unknown_project"; name: string };

const HELP_RE = /^(帮助|help|\?|？|怎么用)$/i;
const LIST_RE = /^(项目|有哪些项目|项目列表|列出项目|切换项目|换项目|切项目|切到)$/;
const QUEUE_RE = /^(等我的|有什么等我|等我处理的|待办|待处理|等我的事)$/;
const STATUS_RE = /^(状态|进展|进度|现在什么情况|现在的情况|项目状态|项目进展)[？?。.]?$/;
const SWITCH_RE = /^(?:切到|切换到|换到|进入)\s+(.+)$|^(?:切换到|换到|进入)(.+)$|^切到([^\s].*)$/;
const CANCEL_RE = /^(取消|算了|不回了)[。！!.]?$/;

export function isStatusQuery(text: string): boolean {
  return STATUS_RE.test(text.trim());
}

export function isCancelReply(text: string): boolean {
  return CANCEL_RE.test(text.trim());
}

export function isMetaCommand(text: string): boolean {
  const t = text.trim();
  return HELP_RE.test(t) || LIST_RE.test(t) || QUEUE_RE.test(t) || STATUS_RE.test(t) || SWITCH_RE.test(t);
}

/** 判定此刻主动推送是否应静音：夜间免打扰（23:00–08:00）或桌宠勿扰倒计时中 */
export function isImQuietHour(quietNight: boolean | undefined, now: Date, dndUntil = 0): boolean {
  if (dndUntil > now.getTime()) return true;
  if (!quietNight) return false;
  const h = now.getHours();
  return h >= 23 || h < 8;
}

function norm(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

/** 名字对项目：先全名、再唯一的包含；对不上或不唯一为 null */
export function findProject(name: string, projects: readonly RouteProject[]): RouteProject | null {
  const key = norm(name);
  if (!key) return null;
  const exact = projects.filter((p) => norm(p.name) === key);
  if (exact.length === 1) return exact[0];
  const partial = projects.filter((p) => norm(p.name).includes(key));
  return partial.length === 1 ? partial[0] : null;
}

const REPLY_STEP_RE = /^回第\s*(\d{1,2})\s*步[\s：:，,]*([\s\S]+)$/;
const REPLY_DIRECT_RE = /^回(?:复)?[：:]\s*([\s\S]+)$/;

export function parseStepReplyPrefix(text: string): { step: number; body: string } | null {
  const m = text.trim().match(REPLY_STEP_RE);
  return m ? { step: Number(m[1]), body: m[2].trim() } : null;
}

function toProject(project: RouteProject, text: string): ImRoute {
  if (STATUS_RE.test(text)) return { kind: "status", project };
  const stepReply = parseStepReplyPrefix(text);
  if (stepReply) return { kind: "reply", project, step: stepReply.step, text: stepReply.body };
  const directReply = text.match(REPLY_DIRECT_RE);
  if (directReply && directReply[1].trim()) return { kind: "reply", project, step: null, text: directReply[1].trim() };
  return { kind: "ask", project, text };
}

export function routeMessage(textRaw: string, projects: readonly RouteProject[], current: RouteProject | null): ImRoute {
  const text = textRaw.trim();
  if (HELP_RE.test(text)) return { kind: "help" };
  if (LIST_RE.test(text)) return { kind: "list" };
  if (QUEUE_RE.test(text)) return { kind: "queue" };
  const sw = text.match(SWITCH_RE);
  if (sw) {
    const rawName = (sw[1] ?? sw[2] ?? sw[3] ?? "").trim();
    const project = findProject(rawName, projects);
    return project ? { kind: "switch", project } : { kind: "unknown_project", name: rawName };
  }
  // 「课题A：内容」「@课题A 内容」点名项目
  const named = text.match(/^@?([^：:\s][^：:]{0,40}?)\s*[：:]\s*([\s\S]+)$/) ?? text.match(/^@(\S{1,40})\s+([\s\S]+)$/);
  if (named) {
    const project = findProject(named[1], projects);
    if (project) return toProject(project, named[2].trim());
  }
  if (current) return toProject(current, text);
  if (projects.length === 1) return toProject(projects[0], text);
  return { kind: "pick", text };
}

/** 明说要派 / 要接着做的短句：照字面办，不交给 AI 理解（AI 自己做不了动作，交给它只会被说成「已经派出去了」，2026-11-06 实证） */
const DISPATCH_RE = /^(派出去|派吧|派|发出去|开工|就这样派|确认派出|派出去吧)[。！!.]?$/;
const RESUME_RE = /^(让(他|它)?接着做|接着做|继续做|继续|接着干|让(他|它)继续)[吧。！!.]?$/;

export type QuickIntent = "dispatch" | "resume";

export function quickIntent(text: string): QuickIntent | null {
  const t = text.trim();
  if (DISPATCH_RE.test(t)) return "dispatch";
  if (RESUME_RE.test(t)) return "resume";
  return null;
}

export const IM_HELP_TEXT = [
  "我是你电脑上 Mesa 的项目助手。电脑上的 Mesa 开着时，我才收得到。",
  "· 直接说事：交给当前项目的项目助手（第一次会让你选项目）",
  "· 「进展」：秒看当前项目各步与目标状态（不调 AI、零等待）",
  "· 「项目」：点按钮切换默认项目；「课题A：…」：点名交给某个项目",
  "· 「等我的」：所有项目里等你回的事；左滑「引用回复」卡片或点「写一句回它」即可原话送达（也可发「回：你的话」或「回第 2 步 你的话」）",
  "· 「派出去」：派出刚起草的那张单；「接着做」：让停下的活接着做",
  "确认命令、评审采纳、写回项目要回到电脑上做。",
].join("\n");
