/**
 * 聊天层「等你决定」卡片的纯逻辑部分（ChatDecisionCard 渲染；tests/chat-decision.test.ts）。
 */
import type { ChatDecision } from "./components/ChatDecisionCard";
import type { ConnIssueState } from "./pages/TerminalPage";

/** 没有可换的连接时，按错误种类给的另一条路 */
const NO_ALT_TAIL: Record<ConnIssueState["kind"], string> = {
  quota: "或等额度恢复后再接着聊",
  rate_limit: "或稍等一会儿再发",
  auth: "或检查这条连接的钥匙",
  timeout: "或稍后再试",
  network: "或检查网络后再发",
  model_missing: "或在输入框右下换一个模型",
  other: "或稍后再试",
};

/**
 * Grok 官方登录过期卡住发消息的确认卡（2026-10-26，grok_login.rs）：用 API 连接启动的 Grok 也会先去续期本地存着的
 * xAI 官方登录，这台电脑连不上登录服务器就每条消息卡半分钟以上。退出官方登录后改用连接里的钥匙，接回原对话。
 */
export function grokLoginDecision(actions: { onLogout: () => void; onDismiss: () => void }): ChatDecision {
  return {
    key: "grok-login-stuck",
    title: "Grok 卡在续期官方登录上，消息发不出去",
    detail: "这台电脑存着一个已过期的 xAI 官方登录，Grok 每发一条消息前都要先去 auth.x.ai 续期，现在连不上",
    hint: "退出官方登录后 Grok 改用这条连接的钥匙，会停下再接回这段对话，聊过的不丢。以后要用官方账号，开着代理重新登录就行",
    options: [
      {
        label: "退出官方登录，接着这段对话",
        primary: true,
        title: "停下 Grok，运行 grok logout，再接回原来这段对话",
        onClick: actions.onLogout,
      },
      { label: "先不管", title: "这次启动不再提示（比如你要开代理让它续上）", onClick: actions.onDismiss },
    ],
  };
}

/**
 * 连接出问题的确认卡（2026-10-18，与「Mesa内嵌终端优化」会话的终端顶栏同一份 connIssue）：标题是给人看的一句话，
 * 说明是网关原文；按钮把同家其他连接逐个摆出来，点了 = 停下 AI、换连接、按原会话接回（聊过的不丢）。
 * 没有可换的连接时只给「去添加连接」；「先不换」= 这条错误记作看过，同一个错误不再提示。
 */
export function connIssueDecision(
  issue: ConnIssueState,
  agent: string,
  actions: {
    onSwitch: (profileId: string) => void;
    onDismiss: () => void;
    onOpenProfiles?: () => void;
    /** 去「设置 → 网络」填出网代理（只有官方账号启动才吃这份代理，网络不通的卡才给） */
    onOpenNetwork?: () => void;
  },
): ChatDecision {
  // 卡片只摆前三条（同家连接多时一行排不下）；更多的在终端顶栏 / 启动栏里换
  const alts = issue.alternatives.slice(0, 3);
  const network = issue.kind === "network";
  const hint = network
    ? `官方账号要直接联网，国内常连不上：到「设置 → 网络」填出网代理，保存后重新启动这个标签；${
        alts.length ? `也可以换到别的连接接着聊（会停下 ${agent} 再接回，聊过的不丢）` : "现在没有别的连接可换"
      }`
    : alts.length
    ? `换连接会停下 ${agent}，再用新连接接回这段对话，聊过的内容不会丢${
        issue.retrying ? `；不换的话 ${agent} 会自己再试几次` : ""
      }`
    : `${agent} 没有别的可用连接${issue.retrying ? "，它还在自己重试" : ""}；可以去「连接」页添加一条，${NO_ALT_TAIL[issue.kind]}`;
  return {
    key: `conn:${issue.sig}`,
    title: issue.text,
    detail: issue.detail || issue.message || null,
    hint,
    options: [
      ...(network && actions.onOpenNetwork
        ? [{ label: "去设置出网代理", primary: true, title: "打开 设置 → 网络，填好后重新启动这个标签", onClick: actions.onOpenNetwork }]
        : []),
      ...alts.map((a, i) => ({
        label: `换到 ${a.label}，接着这段对话`,
        primary: i === 0 && !(network && actions.onOpenNetwork),
        title: `停下 ${agent}，换成「${a.label}」后接回原来这段对话`,
        onClick: () => actions.onSwitch(a.profileId),
      })),
      ...(alts.length === 0 && !network && actions.onOpenProfiles
        ? [{ label: "去添加连接", primary: true, onClick: actions.onOpenProfiles }]
        : []),
      { label: "先不换", title: "这条错误记作看过，同一个错误不再提示", onClick: actions.onDismiss },
    ],
  };
}
