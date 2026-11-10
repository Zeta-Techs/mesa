//! 聊天里换一家 Agent 接着做（docs/design-chat-relay.md）的前端纯逻辑（tests/chat-relay.test.ts）。
//!
//! 接力抬头由后端拼（relay_brief.rs full_framing / delta_framing），这里只拆：聊天里那一句的抬头不当人话显示，
//! 画成一张「前面由谁做 / 你离开期间谁做了几轮」的卡。两端共读 tests/fixtures/relay-prompts.json。

import { splitLaunchPrompt } from "./project-context.ts";

export const RELAY_HEAD = "〔Mesa 接力";
const RELAY_DELTA_HEAD = "〔Mesa 接力 · 补充〕";

export interface RelayPrompt {
  /** `.ccode/` 下的简报文件名 */
  briefName: string | null;
  /** 换回原来那家时的补充简报 */
  delta: boolean;
  /** 「----」之后人说的话（对话页入口没有人话时为空） */
  said: string;
  /** 整份交接：前面是谁做的（「Codex」） */
  from: string | null;
  /** 补充：离开后谁做了几轮（「Codex 做了 2 轮、Kimi Code 做了 1 轮」） */
  roundsBy: string | null;
}

function briefNameIn(text: string): string | null {
  const m = /handoff-[A-Za-z0-9-]+\.md/.exec(text);
  return m ? m[0] : null;
}

/** 一句话的接力抬头拆开（先剥项目说明）；不是接力的那句返回 null */
export function splitRelayPrompt(text: string): RelayPrompt | null {
  const { said: afterPack } = splitLaunchPrompt(text);
  const t = afterPack.trimStart();
  if (!t.startsWith(RELAY_HEAD)) return null;
  const sep = /\n[ \t]*----[ \t]*\r?\n/.exec(t);
  const head = sep ? t.slice(0, sep.index) : t;
  const said = sep ? t.slice(sep.index + sep[0].length).trim() : "";
  const delta = head.startsWith(RELAY_DELTA_HEAD);
  const from = delta ? null : (/之前由 (.+?)（会话 /.exec(head)?.[1] ?? null);
  const roundsBy = delta ? (/你离开后，(.+?)，补充简报在/.exec(head)?.[1] ?? null) : null;
  return { briefName: briefNameIn(head), delta, said, from, roundsBy };
}

/** 一句话里人说的部分：剥掉项目说明与接力抬头（只有抬头没人话为空） */
export function userSaid(text: string): string {
  return splitRelayPrompt(text)?.said ?? splitLaunchPrompt(text).said;
}

/** 发送时拼：抬头 +「----」+ 人这句话 */
export function composeRelayPrompt(framing: string, words: string): string {
  return `${framing}\n----\n${words.trim()}`;
}

/** 接力卡上的一行字 */
export function relayCardText(p: RelayPrompt): string {
  if (p.delta) return p.roundsBy ? `你离开期间 ${p.roundsBy}` : "你离开期间别家接着做了几轮";
  return p.from ? `前面由 ${p.from} 做` : "前面由另一家 Agent 做";
}

/** 换配置层里选中的接力目标 */
export interface RelayTarget {
  agentId: string;
  profileId: string;
  model: string;
  /** new：新开一段整份交接；resume：接回这家原来那段，只补离开后的 */
  mode: "new" | "resume";
  resumeSession: string | null;
}

/** 后端 relay_options：这家在这段接力对话里已有的那段 */
export interface RelayOptionDto {
  agent: string;
  priorSession: string;
  priorFile: string | null;
  deltaRounds: number;
  roundsBy: string;
  resumable: boolean;
  recommendNew: boolean;
  reason: string | null;
}

export interface RelayProfile {
  id: string;
  agent: string;
  name: string;
  models: string[];
}

/** 接力那组第一层：一家一行 */
export interface RelayAgentRow {
  agentId: string;
  label: string;
  /** 这家在这段接力对话里用过（能接回原来那段）；没用过为 null */
  used: RelayOptionDto | null;
  /** 能用的连接，上次用的在前 */
  profiles: RelayProfile[];
}

/**
 * 换配置层「换一家接着做」第一层（2026-11-10 用户：先列 Agent，点进去再选连接和模型，一次全摊开太长）：
 * 别的已装、有可用连接的几家，一家一行，按 AGENTS 顺序；这段接力对话里用过的那家标出来
 */
export function relayAgentRows(input: {
  currentAgent: string;
  agents: { id: string; label: string; installed: boolean }[];
  profiles: RelayProfile[];
  hiddenProfiles: string[];
  options: RelayOptionDto[];
  /** 这家上次用的连接（ccode.lastProfile.<agent>） */
  lastProfile: (agent: string) => string | null;
}): RelayAgentRow[] {
  const rows: RelayAgentRow[] = [];
  for (const a of input.agents) {
    if (a.id === input.currentAgent || !a.installed) continue;
    const usable = input.profiles.filter((p) => p.agent === a.id && !input.hiddenProfiles.includes(p.id));
    if (usable.length === 0) continue;
    const last = input.lastProfile(a.id);
    const profiles = [...usable.filter((p) => p.id === last), ...usable.filter((p) => p.id !== last)];
    rows.push({ agentId: a.id, label: a.label, used: input.options.find((o) => o.agent === a.id) ?? null, profiles });
  }
  return rows;
}

/** 第二层「怎么接」：用过的那家才有。默认接回在前；建议新开时新开在前并带原因；接不回只给新开 */
export interface RelayModeRow {
  mode: "new" | "resume";
  label: string;
  note: string | null;
}

export function relayModeRows(used: RelayOptionDto): RelayModeRow[] {
  const resume: RelayModeRow = {
    mode: "resume",
    label: used.deltaRounds > 0 ? `接回原来那段（补 ${used.deltaRounds} 轮）` : "接回原来那段",
    note: null,
  };
  const fresh: RelayModeRow = {
    mode: "new",
    label: "新开一段（整份交接）",
    note: used.recommendNew ? used.reason : null,
  };
  if (!used.resumable) return [fresh];
  return used.recommendNew ? [fresh, resume] : [resume, fresh];
}

/** 输入框上那枚「接力给 …」 */
export function relayChipText(t: RelayTarget, agentLabel: string): string {
  return t.mode === "resume"
    ? `接回 ${agentLabel} 原来那段 · 发送时补上它离开后的内容`
    : `接力给 ${agentLabel} · 发送时带上前面的内容`;
}
