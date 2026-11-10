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

export interface RelayMenuRow {
  key: string;
  target: RelayTarget;
  agentLabel: string;
  /** 连接名 · 模型 */
  detail: string;
  /** 「接回原来那段（补 3 轮）」/「新开一段（整份交接）」；这家还没用过为 null */
  mode: string | null;
  /** 建议新开的原因（只写在新开那一行下） */
  note: string | null;
}

export interface RelayProfile {
  id: string;
  agent: string;
  name: string;
  models: string[];
}

/**
 * 换配置层「换一家接着做」那组的行：别的已装、有可用连接的几家，每条连接一行；
 * 这段对话里已经用过的那家先给「接回原来那段」与「新开一段」两行（建议新开时新开在前），只用它常用的那条连接。
 */
export function relayMenuRows(input: {
  currentAgent: string;
  agents: { id: string; label: string; installed: boolean }[];
  profiles: RelayProfile[];
  hiddenProfiles: string[];
  options: RelayOptionDto[];
  /** 这家上次用的连接（ccode.lastProfile.<agent>） */
  lastProfile: (agent: string) => string | null;
}): RelayMenuRow[] {
  const rows: RelayMenuRow[] = [];
  for (const a of input.agents) {
    if (a.id === input.currentAgent || !a.installed) continue;
    const usable = input.profiles.filter((p) => p.agent === a.id && !input.hiddenProfiles.includes(p.id));
    if (usable.length === 0) continue;
    const preferred = usable.find((p) => p.id === input.lastProfile(a.id)) ?? usable[0];
    const detailOf = (p: RelayProfile) => [p.name, p.models[0]].filter(Boolean).join(" · ");
    const opt = input.options.find((o) => o.agent === a.id);
    if (opt) {
      const resume: RelayMenuRow = {
        key: `${a.id}:resume`,
        target: { agentId: a.id, profileId: preferred.id, model: preferred.models[0] ?? "", mode: "resume", resumeSession: opt.priorSession },
        agentLabel: a.label,
        detail: detailOf(preferred),
        mode: opt.deltaRounds > 0 ? `接回原来那段（补 ${opt.deltaRounds} 轮）` : "接回原来那段",
        note: null,
      };
      const fresh: RelayMenuRow = {
        key: `${a.id}:new`,
        target: { agentId: a.id, profileId: preferred.id, model: preferred.models[0] ?? "", mode: "new", resumeSession: null },
        agentLabel: a.label,
        detail: detailOf(preferred),
        mode: "新开一段（整份交接）",
        note: opt.recommendNew ? opt.reason : null,
      };
      if (!opt.resumable) rows.push(fresh);
      else if (opt.recommendNew) rows.push(fresh, resume);
      else rows.push(resume, fresh);
      continue;
    }
    for (const p of [preferred, ...usable.filter((x) => x.id !== preferred.id)]) {
      rows.push({
        key: `${a.id}:${p.id}`,
        target: { agentId: a.id, profileId: p.id, model: p.models[0] ?? "", mode: "new", resumeSession: null },
        agentLabel: a.label,
        detail: detailOf(p),
        mode: null,
        note: null,
      });
    }
  }
  return rows;
}

/** 输入框上那枚「接力给 …」 */
export function relayChipText(t: RelayTarget, agentLabel: string): string {
  return t.mode === "resume"
    ? `接回 ${agentLabel} 原来那段 · 发送时补上它离开后的内容`
    : `接力给 ${agentLabel} · 发送时带上前面的内容`;
}
