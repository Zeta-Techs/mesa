/**
 * 各 CLI 的多模型注入能力表 + 启动栏提示纯逻辑（v3.88）。
 *
 * 背景：这张表原本只活在 ProfilesPage 的「新建配置」表单里，用户在**启动栏**换模型
 * 发现没生效时看不到任何解释——「有时候配置了无法切换模型」的主要来源。
 * 表移到这里作单一出处，启动栏与配置页共用。
 *
 * 纯逻辑、无 DOM，node --test 直接测。
 */

export interface ModelSwitchInfo {
  /** 能进该 CLI 模型选择器的最大个数；null = 不限 */
  max: number | null;
  /** 配置页表单里的详细说明 */
  hint: string;
}

export const MODEL_SWITCH: Record<string, ModelSwitchInfo> = {
  "claude-code": {
    max: 5,
    hint: "前 4 个占 SONNET/OPUS/HAIKU/FABLE 别名槽，第 5 个占自定义槽；超出的只能 /model <id> 手输",
  },
  codex: {
    max: null,
    hint: "启动时生成模型 catalog，/model 选择器列出全部已配置模型",
  },
  gemini: {
    max: 1,
    hint: "CLI 无多模型注入机制，多模型只能在 TUI 里 /model set 手动切换",
  },
  qwen: {
    max: 1,
    hint: "多模型需「⋯ → 设为全局」写入配置后才能在 /model 里切换",
  },
  opencode: { max: null, hint: "全部已配置模型都会注册，可在 TUI 自由切换" },
  kimi: { max: 1, hint: "多模型需「⋯ → 设为全局」写入配置后才能在模型页切换" },
  cursor: {
    max: null,
    hint: "模型经 --model 参数注入，启动后不能在会话内换模型",
  },
  grok: {
    max: null,
    hint: "启动时注入全部已配置模型，运行中可用 /model 或模型选择器切换",
  },
};

/**
 * 启动栏模型下拉底部的一句话：只在「这个 agent 确实有坑」时出现，说人话。
 * modelCount = 当前 profile 配了几个模型。
 */
export function launchModelNote(
  agentId: string,
  modelCount: number,
): string | null {
  const info = MODEL_SWITCH[agentId];
  if (!info) return null;
  if (info.max === 1) {
    return "这个 CLI 只认一个模型：启动后想换，得在 CLI 里自己切（/model）。";
  }
  if (agentId === "codex") {
    return "改了配置里的模型列表要停下 AI 再接着聊才生效——模型目录只在 CLI 启动那一下读一次。";
  }
  if (agentId === "cursor") {
    return "模型是启动参数，启动后不能在会话里换；换模型 = 停下 AI、换好再接着聊。";
  }
  if (info.max !== null && modelCount > info.max) {
    return `这个 CLI 的选择器只放得下 ${info.max} 个，第 ${info.max + 1} 个起要在 CLI 里手输 /model <id>。`;
  }
  return null;
}

/**
 * 手填模型名的软校验：只在明显不像模型 id 时提示，**不拦截**——
 * 中转厂商的模型名千奇百怪，拦下来的误伤远大于收益。
 * 判定放得很松：含分隔符（- . / :）或数字即认为像模型名。
 */
export function looksLikeModelId(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  return /[-./:]/.test(v) || /\d/.test(v);
}

/** 官方账号禁止把中转/国产网关模型名跟着注入（否则 Codex 会 -m deepseek 还带 service_tier=priority）。
 *  与 agents.rs official_model_allowed 双端镜像。 */
export function officialModelAllowed(agent: string, model: string): boolean {
  const m = model.trim().toLowerCase();
  if (!m) return false;
  const foreign = [
    "deepseek",
    "qwen",
    "glm-",
    "glm/",
    "moonshot",
    "kimi-",
    "doubao",
    "hunyuan",
    "yi-",
    "ernie",
    "baichuan",
    "minimax",
    "spark-",
  ];
  if (
    foreign.some((p) => {
      if (agent === "kimi" && (p === "kimi-" || p === "moonshot")) return false;
      return m.includes(p);
    })
  ) {
    return false;
  }
  if (agent === "codex") {
    return (
      m.startsWith("gpt-") ||
      m.startsWith("o1") ||
      m.startsWith("o3") ||
      m.startsWith("o4") ||
      m.includes("codex")
    );
  }
  return true;
}

/**
 * 换 profile 时模型输入怎么处理（v3.88 修「静默清空」）：
 * 原实现无条件把模型重置为新 profile 的 models[0]，用户手填的模型被悄悄丢掉。
 * 新口径：手填值若不在新 profile 的模型表里，**保留**并由界面给一行说明；
 * 空值或本来就取自旧 profile 预设的值才落到新 profile 的首个模型。
 */
export function modelOnProfileSwitch(
  current: string,
  prevModels: readonly string[],
  nextModels: readonly string[],
): { model: string; kept: boolean } {
  const cur = current.trim();
  if (!cur) return { model: nextModels[0] ?? "", kept: false };
  // 已经在新表里：原样留着
  if (nextModels.includes(cur)) return { model: cur, kept: false };
  // 来自旧 profile 的预设值（不是用户手打的）：跟着换到新 profile 的默认
  if (prevModels.includes(cur)) return { model: nextModels[0] ?? "", kept: false };
  // 用户手填且新表里没有：保留，界面提示「仍会按原样注入」
  return { model: cur, kept: true };
}

/**
 * 运行中能不能用命令切模型：DetectResult.modelSwitch 按 CLI 定，这里再按连接收窄。
 * Kimi 用 Mesa 的接口连接启动时只经环境变量带一个模型，`/model 别名` 只认它自己配置文件里的别名——
 * 2026-10-18 聊天层第三期 PTY 实录：切到连接里的另一个模型报「Error: Unknown model alias」。
 * 把连接「设为全局」写进 Kimi 配置后才能在它的模型页里换；官方账号照常用命令切。
 */
export function runtimeModelSwitch<T>(
  modelSwitch: T | null,
  agentId: string | null | undefined,
  accountType: "api" | "official" | null | undefined,
): T | null {
  if (agentId === "kimi" && accountType !== "official") return null;
  return modelSwitch;
}
