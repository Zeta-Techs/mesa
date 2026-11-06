/**
 * 一件活「卡在哪」的唯一出处（2026-11-06 用户「我不可能一个个修」，根源二）：终端页里十几个各自为政的判断
 * （等确认、信任菜单、选项菜单、等待屏、启动失败、登录、连接问题、十分钟没出字、说完一轮在等人…）在这里归成一个状态，
 * 写清卡在什么、手机上能不能回。调度台、收件箱、手机推送只读它；以后新增一种卡法只改这里。纯逻辑，配 tests/run-blocker.test.ts。
 */

export type BlockerKind = "launch_failed" | "trust" | "login" | "conn" | "confirm" | "menu" | "wait" | "stalled" | "idle";

export interface RunBlocker {
  kind: BlockerKind;
  /** 给人看的一句：卡在什么、要你做什么 */
  text: string;
  /** 手机上：answer = 能直接点（只有信任文件夹，且还要是经项目助手派出去的活，由调用方再核对）；notify = 只提醒回电脑 */
  phone: "answer" | "notify";
  /** 信任菜单两项原文（kind = trust） */
  trust?: { yes: string; no: string; path: string | null };
}

export interface BlockerInput {
  running: boolean;
  shell: boolean;
  attention: "done" | "working" | "confirm" | null;
  /** 这个标签是一件目标（goal）的运行：说完一轮也算在等人（目标要验收或接着交代） */
  isGoal: boolean;
  trust: { yes: string; no: string; path: string | null } | null;
  /** 屏上的选项菜单（切模型确认、工具审批等）的标题 */
  menuQuestion: string | null | undefined;
  hasMenu: boolean;
  /** 终端在等你的那一屏的标题 */
  waitTitle: string | null | undefined;
  /** 启动就退出了：退出码 */
  launchFailureCode: number | null | undefined;
  /** 登录 / 存密钥一类的特殊屏 */
  loginScreen: string | null;
  connIssue: boolean;
  stalled: boolean;
}

/** 按要紧程度取一个：没起来 > 信任 > 登录 > 连接 > 等确认 / 菜单 > 等待屏 > 十分钟没出字 > 目标说完一轮 */
export function runBlocker(i: BlockerInput): RunBlocker | null {
  if (i.launchFailureCode != null) {
    return { kind: "launch_failed", text: `AI 没起来（退出码 ${i.launchFailureCode}），这件活没在做`, phone: "notify" };
  }
  if (!i.running || i.shell) return null;
  if (i.trust) {
    return {
      kind: "trust",
      text: `AI 刚启动，停在「是否信任这个文件夹」${i.trust.path ? `（${i.trust.path}）` : ""}，不选它就一直不干活`,
      phone: "answer",
      trust: i.trust,
    };
  }
  if (i.loginScreen) return { kind: "login", text: `AI 停在登录 / 密钥这一屏（${i.loginScreen}），要回电脑处理`, phone: "notify" };
  if (i.connIssue) return { kind: "conn", text: "这条连接出了问题（额度、网络或密钥），AI 停着；回电脑换连接或重试", phone: "notify" };
  if (i.attention === "confirm" || i.hasMenu) {
    const q = i.menuQuestion?.trim();
    return { kind: i.hasMenu ? "menu" : "confirm", text: q ? `AI 停下来等你确认：${q}` : "AI 停下来等你确认一条命令", phone: "notify" };
  }
  if (i.waitTitle?.trim()) return { kind: "wait", text: `终端在等你：${i.waitTitle.trim()}`, phone: "notify" };
  if (i.stalled) return { kind: "stalled", text: "在跑，但十分钟没有任何输出，可能卡住了；回电脑看看终端", phone: "notify" };
  if (i.isGoal && i.attention === "done") {
    return { kind: "idle", text: "AI 这一轮说完了，在等你看或回话（目标不会自己收尾）", phone: "notify" };
  }
  return null;
}

/** 登录类特殊屏的叫法 */
export function loginScreenLabel(special: { kind: string } | null | undefined, grokLoginStuck: boolean): string | null {
  if (grokLoginStuck) return "Grok 登录";
  if (!special) return null;
  if (special.kind === "cursor-login") return "Cursor 登录";
  if (special.kind === "gemini-key-store") return "Gemini 存密钥";
  return special.kind;
}
