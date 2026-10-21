/**
 * 聊天层「AI 还在干活时又发一句」：各家 CLI 收到这句后怎么处理、怎么让它「立即处理」（2026-10-22）。
 * 聊天层发送就是往终端写正文 + 回车，排不排、何时交给模型都是 CLI 自己的事——这里只把各家的真实行为写成表，
 * 排队气泡写准「什么时候处理」，「立即发送」按的就是这家终端里提示的那个键。
 *
 * 依据：本机假网关逐家实测（scripts/e2e-model-routing/chat-capture.py 的 QUEUE_* 一幕，看那句出现在哪个请求里），
 * 版本与结论记在 docs/agent-integration-matrix.md「生成中再发一句」。CLI 升级改了行为，改这张表。
 *   - next_step：它做完手头这一步（工具调用）就看到这句，插进这一轮；这一轮没有下一步（纯文字回复）时等说完再处理
 *   - after_turn：排到这一轮说完之后，当下一轮的提问
 */

export type MidTurnDelivery = "next_step" | "after_turn" | "unknown";

export interface MidTurnSendNow {
  /** 写进终端的键 */
  keys: string;
  /** 气泡下按钮上的字 */
  label: string;
  title: string;
  /** 输入框里的快捷说法（⌘↩ 后面那半句） */
  hint: string;
}

export interface MidTurnSpec {
  delivery: MidTurnDelivery;
  sendNow: MidTurnSendNow | null;
}

const ESC_NOW: MidTurnSendNow = {
  keys: "\x1b",
  label: "立即发送",
  title: "停下手头这一步，马上处理这句（等于在终端里按 Esc）",
  hint: "立即发送",
};

/**
 * agentId → 这家的规矩。csiU = 终端开了 kitty 键盘（Kimi 起来就开，Ctrl+S 要按 CSI-u 写）。
 * 没核实过的家（Cursor）delivery = unknown、不给「立即发送」
 */
export function midTurnSpec(agentId: string | null | undefined, opts: { csiU: boolean }): MidTurnSpec {
  switch (agentId) {
    // Claude 2.1.292：回车 = 排上（「Press up to edit queued messages」），下一步工具调用结束时一起交给模型；
    // Esc / Ctrl+Enter 都是打断并马上发
    case "claude-code":
    // Codex 0.163：回车 = steer（「Messages to be submitted after next tool call」），Esc = 打断并马上发
    case "codex":
    // CodeBuddy 2.170：同 Codex 的提示与行为
    case "codebuddy":
      return { delivery: "next_step", sendNow: ESC_NOW };
    // Qwen 0.25：回车 = steer；Esc 是取消这一轮，排着的那句不发——没有「立即发送」
    case "qwen":
    // OpenCode 1.19：QUEUED，下一步工具结果回来时一起交；Esc 要按两次才打断，打断后发不发没核实
    case "opencode":
      return { delivery: "next_step", sendNow: null };
    // Gemini 0.65：「Queued (press ↑ to edit)」，这一轮说完再发；Esc 取消这一轮并马上发排着的那句
    case "gemini":
      return {
        delivery: "after_turn",
        sendNow: { ...ESC_NOW, title: "停下这一轮，马上处理这句（等于在终端里按 Esc）" },
      };
    // Grok 1.0.62：「Queued · Enter to send now」，输入框空着再按回车 = 马上交给它（正在跑的命令照常跑完）
    case "grok":
      return {
        delivery: "after_turn",
        sendNow: {
          keys: "\r",
          label: "立即发送",
          title: "马上交给它，不用等这一轮说完；正在跑的命令照常跑完（等于在终端里再按一次回车）",
          hint: "立即发送",
        },
      };
    // Kimi 2.2：排到这一轮之后；Ctrl+S「steer immediately」= 插进这一轮（下一步就看到），不打断
    case "kimi":
      return {
        delivery: "after_turn",
        sendNow: {
          keys: opts.csiU ? "\x1b[115;5u" : "\x13",
          label: "插进这一轮",
          title: "不等这一轮说完，它做完手头这一步就会看到这句（等于在终端里按 Ctrl+S）",
          hint: "插进这一轮",
        },
      };
    default:
      return { delivery: "unknown", sendNow: null };
  }
}

/** 排队气泡下那一行 */
export function queuedNote(spec: MidTurnSpec): { text: string; title: string } {
  switch (spec.delivery) {
    case "next_step":
      return {
        text: "下一步时交给它",
        title: "它做完手头这一步（比如正在跑的命令）就会看到这句，不用等这一轮说完；这一轮没有下一步时，等它说完再处理",
      };
    case "after_turn":
      return {
        text: "排队中 · 这一轮结束后处理",
        title: "已经交给 AI，它这一轮说完就接着处理；要撤回请到终端里改掉排着的那条",
      };
    default:
      return { text: "排队中 · 它空下来就处理", title: "已经交给 AI，由它自己决定什么时候处理" };
  }
}

/** 生成中输入框的占位字；mod = 输入框认「立即发送」快捷键时的平台修饰键写法（Mac「⌘」、Windows「Ctrl+」），不认传 null */
export function runningPlaceholder(spec: MidTurnSpec, mod: string | null): string {
  const base =
    spec.delivery === "next_step"
      ? "还在回复；现在发的话它下一步就会看到"
      : "还在回复；现在发的话会排队，这一轮结束后处理";
  return spec.sendNow && mod ? `${base}，${mod}↩ ${spec.sendNow.hint}…` : `${base}…`;
}
