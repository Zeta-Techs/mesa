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
  | { kind: "switch"; project: RouteProject }
  | { kind: "ask"; project: RouteProject; text: string }
  /** 「回第 2 步 …」：原话送进那一步正在问你的对话（调度台转达） */
  | { kind: "reply"; project: RouteProject; step: number; text: string }
  /** 说不清是哪个项目：给项目按钮让人点，点了再问这句 */
  | { kind: "pick"; text: string }
  | { kind: "unknown_project"; name: string };

const HELP_RE = /^(帮助|help|\?|？|怎么用)$/i;
const LIST_RE = /^(项目|有哪些项目|项目列表|列出项目)$/;
const QUEUE_RE = /^(等我的|有什么等我|等我处理的|待办|待处理|等我的事)$/;
const SWITCH_RE = /^(?:切到|切换到|换到|进入)\s*(.+)$/;

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

const REPLY_RE = /^回第\s*(\d{1,2})\s*步[\s：:，,]*([\s\S]+)$/;

function toProject(project: RouteProject, text: string): ImRoute {
  const reply = text.match(REPLY_RE);
  return reply ? { kind: "reply", project, step: Number(reply[1]), text: reply[2].trim() } : { kind: "ask", project, text };
}

export function routeMessage(textRaw: string, projects: readonly RouteProject[], current: RouteProject | null): ImRoute {
  const text = textRaw.trim();
  if (HELP_RE.test(text)) return { kind: "help" };
  if (LIST_RE.test(text)) return { kind: "list" };
  if (QUEUE_RE.test(text)) return { kind: "queue" };
  const sw = text.match(SWITCH_RE);
  if (sw) {
    const project = findProject(sw[1], projects);
    return project ? { kind: "switch", project } : { kind: "unknown_project", name: sw[1].trim() };
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

export const IM_HELP_TEXT = [
  "我是你电脑上 Mesa 的项目助手。电脑上的 Mesa 开着时，我才收得到。",
  "· 直接说事：交给当前项目的项目助手（第一次会让你选项目）",
  "· 「课题A：帮我准备下周组会」：点名交给某个项目",
  "· 「切到 课题B」：换默认项目",
  "· 「等我的」：所有项目里等你回的事；「回第 2 步 你的话」：原话送进那一步在问你的对话",
  "· 「项目」：列出项目",
  "确认命令、评审采纳、写回项目要回到电脑上做。",
].join("\n");
