/**
 * 研讨（2026-11-11，docs/design-group-consult.md）纯逻辑：成员候选、默认挑法、按模型族起名、对照条、第一轮何时亮。
 * 后端是 src-tauri/src/consult.rs（调度、记录、解析尾段与依据核对都在那边，这里只排给人看）。
 * 两条口径（2026-11-11 用户追问后定）：成员的差别看**模型族**，不看 CLI；能不能看项目看 **CLI 外壳**，不看模型。
 */
import { reviewerOptions, type ReviewerProfile } from "./cross-review.ts";
import type { VendorId } from "./vendor-icon.ts";

/** 能看项目的 CLI 外壳（与后端 consult.rs INSPECT_AGENTS 镜像）：进程级只读已实证的两家 */
export const INSPECT_AGENTS: readonly string[] = ["claude-code", "codex"];
export const MIN_MEMBERS = 2;
export const MAX_MEMBERS = 4;
export const MAX_MATERIALS = 8;
export const DEFAULT_CROSS_ROUNDS = 1;
export const DEFAULT_RELAY_LIMIT = 2;

// ── 与后端 DTO 同形（camelCase） ──

export interface ConsultMember {
  id: string;
  name: string;
  family: string | null;
  agent: string;
  profileId: string;
  model: string;
  canReadProject: boolean;
}

export interface ConsultMaterial {
  path: string;
  range: string;
}

export interface ConsultRef {
  raw: string;
  path: string;
  loc: string;
  state: "ok" | "missing" | "unseen";
}

export interface ConsultMessage {
  id: string;
  at: string;
  role: "user" | "member" | "system";
  member: string | null;
  phase: "r1" | "cross" | "chat";
  round: number;
  text: string;
  conclusion: string | null;
  refs: ConsultRef[];
  unsure: string | null;
  pass: boolean;
  /** interrupted：Mesa 中途关掉时还没答完（后端出线时由占位换来） */
  status: "ok" | "error" | "timeout" | "stopped" | "interrupted";
  error: string | null;
  mentions: string[];
  costUsd: number | null;
  durationMs: number | null;
}

export interface ConsultMeta {
  id: string;
  title: string;
  titleSource: string;
  createdAt: string;
  question: string;
  materials: ConsultMaterial[];
  members: ConsultMember[];
  crossRounds: number;
  relayLimit: number;
  /** 成员读文件的地方（评审页发起时是工作副本）；空 = 项目根 */
  readRoot?: string | null;
  readLabel?: string | null;
}

export interface ConsultRecord {
  meta: ConsultMeta;
  messages: ConsultMessage[];
}

export interface ConsultRunning {
  msgId: string;
  member: string;
  phase: string;
  startedAt: string;
}

export interface ConsultDto {
  consult: ConsultRecord;
  running: ConsultRunning[];
  busy: boolean;
}

export interface ConsultListItem {
  id: string;
  projectRoot: string;
  title: string;
  members: ConsultMember[];
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  busy: boolean;
}

export interface ConsultEvent {
  consultId: string;
  kind: "started" | "step" | "text" | "done" | "idle";
  msgId?: string;
  member?: string;
  phase?: string;
  text?: string;
  step?: string;
}

// ── 成员候选与默认挑法 ──

/** 模型族的显示名：成员按它起名（Claude、GPT…），不按 CLI */
const FAMILY_NAME: Partial<Record<VendorId, string>> = {
  anthropic: "Claude",
  openai: "GPT",
  gemini: "Gemini",
  xai: "Grok",
  zhipu: "GLM",
  alibaba: "Qwen",
  tencent: "混元",
  kimi: "Kimi",
  minimax: "MiniMax",
  deepseek: "DeepSeek",
  doubao: "豆包",
  cursor: "Cursor",
};

export function familyName(family: string | null | undefined): string | null {
  return family ? (FAMILY_NAME[family as VendorId] ?? null) : null;
}

export interface MemberOption {
  key: string;
  agentId: string;
  profileId: string;
  profileName: string;
  model: string;
  family: string | null;
  tier: 1 | 2;
  /** 外壳能看项目 */
  canRead: boolean;
}

export function memberOptions(profiles: readonly ReviewerProfile[], hidden: readonly string[]): MemberOption[] {
  return reviewerOptions(profiles, hidden, null).map((o) => ({
    key: `${o.profileId}::${o.model}`,
    agentId: o.agentId,
    profileId: o.profileId,
    profileName: o.profileName,
    model: o.model,
    family: o.family,
    tier: o.tier,
    canRead: INSPECT_AGENTS.includes(o.agentId),
  }));
}

/**
 * 默认挑法（设计稿 §4.1）：第一位是 firstKey（「问 AI / 聊想法」那条连接）；之后每位先保证模型族和已选的都不同，
 * 同族里优先外壳能看项目的、再一等、再按原顺序（最近用过的在前）；认不出模型族的不进默认。凑不满就少选，不拿同族的补
 */
export function pickDefaultMembers(options: readonly MemberOption[], firstKey: string | null, want = 3): MemberOption[] {
  const picked: MemberOption[] = [];
  const first = (firstKey ? options.find((o) => o.key === firstKey) : undefined) ?? null;
  if (first) picked.push(first);
  const ranked = options
    .map((o, i) => ({ o, i }))
    .sort((a, b) => Number(b.o.canRead) - Number(a.o.canRead) || a.o.tier - b.o.tier || a.i - b.i)
    .map((x) => x.o);
  for (const o of ranked) {
    if (picked.length >= Math.min(want, MAX_MEMBERS)) break;
    if (!o.family) continue;
    if (picked.some((p) => p.family === o.family || p.key === o.key)) continue;
    picked.push(o);
  }
  return picked;
}

/** 短模型名：Claude 取 Opus / Sonnet / Haiku / Fable，其余去掉厂商前缀后截短 */
export function shortModel(model: string): string {
  const m = model.trim();
  if (!m) return "默认";
  const tier = /\b(opus|sonnet|haiku|fable)\b/i.exec(m.replace(/[-_.]/g, " "));
  if (tier) return tier[1][0].toUpperCase() + tier[1].slice(1).toLowerCase();
  const tail = m.split("/").pop() ?? m;
  return tail.length > 18 ? `${tail.slice(0, 17)}…` : tail;
}

/** 成员名：模型族名；同族两位时加短模型名（Claude·Opus）；认不出模型族用连接名 */
export function memberNames(picked: readonly Pick<MemberOption, "family" | "model" | "profileName">[]): string[] {
  const base = picked.map((o) => familyName(o.family) ?? o.profileName.trim() ?? "成员");
  const names = base.map((b, i) => (base.filter((x) => x === b).length > 1 ? `${b}·${shortModel(picked[i].model)}` : b));
  // 还撞（同族同短名）就加序号
  return names.map((n, i) => (names.filter((x) => x === n).length > 1 ? `${n} ${names.slice(0, i + 1).filter((x) => x === n).length}` : n));
}

/** 同一模型族出现两次以上的族名：卡片上标「同一家模型，意见可能雷同」 */
export function sameFamilies(picked: readonly Pick<MemberOption, "family">[]): Set<string> {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const o of picked) {
    if (!o.family) continue;
    if (seen.has(o.family)) dup.add(o.family);
    seen.add(o.family);
  }
  return dup;
}

// ── 看记录 ──

/** 第一轮有没有亮：还有第一轮的成员在答就不亮（各答各的，免得先读的影响后读的） */
export function round1Revealed(running: readonly Pick<ConsultRunning, "phase">[]): boolean {
  return !running.some((r) => r.phase === "r1");
}

export function memberOf(record: ConsultRecord, id: string | null | undefined): ConsultMember | undefined {
  return id ? record.meta.members.find((m) => m.id === id) : undefined;
}

/** 第一轮回答，按成员顺序 */
export function round1Messages(record: ConsultRecord): ConsultMessage[] {
  const order = new Map(record.meta.members.map((m, i) => [m.id, i]));
  return record.messages
    .filter((m) => m.phase === "r1" && m.role === "member")
    .sort((a, b) => (order.get(a.member ?? "") ?? 9) - (order.get(b.member ?? "") ?? 9));
}

/** 第一轮之后的聊天流：交叉与追问，PASS 不显示 */
export function streamMessages(record: ConsultRecord): ConsultMessage[] {
  return record.messages.filter((m) => m.phase !== "r1" && !m.pass);
}

export interface ContrastRow {
  member: ConsultMember;
  /** 第一轮结论 */
  first: string | null;
  /** 之后改过的结论（与第一轮不同才给） */
  latest: string | null;
  /** 交叉里回了 PASS */
  crossPassed: boolean;
  /** 依据里找不到 / 没给它看的条数（全部回答合计） */
  missing: number;
  unseen: number;
  status: ConsultMessage["status"] | "pending";
}

/** 对照条：一行一位，原话照搬，不判谁对 */
export function contrastRows(record: ConsultRecord): ContrastRow[] {
  return record.meta.members.map((member) => {
    const mine = record.messages.filter((m) => m.member === member.id && m.role === "member");
    const r1 = mine.find((m) => m.phase === "r1");
    const later = mine.filter((m) => m.phase !== "r1" && m.status === "ok" && !m.pass && m.conclusion);
    const last = later.length ? later[later.length - 1].conclusion : null;
    const first = r1?.status === "ok" ? r1.conclusion : null;
    const refs = mine.flatMap((m) => m.refs);
    return {
      member,
      first,
      latest: last && last !== first ? last : null,
      crossPassed: mine.some((m) => m.phase === "cross" && m.pass) && !mine.some((m) => m.phase === "cross" && !m.pass),
      missing: refs.filter((r) => r.state === "missing").length,
      unseen: refs.filter((r) => r.state === "unseen").length,
      status: r1 ? r1.status : "pending",
    };
  });
}

/** 输入框里有没有 @ 到谁：没有就是问所有人（与后端 mentions 同口径的简化版，只用来写提示） */
export function mentionedNames(text: string, members: readonly Pick<ConsultMember, "name">[]): string[] {
  const sorted = [...members].sort((a, b) => b.name.length - a.name.length);
  const out: string[] = [];
  for (let i = text.indexOf("@"); i >= 0; i = text.indexOf("@", i + 1)) {
    const rest = text.slice(i + 1).toLowerCase();
    if (/^(所有人|大家|全体|all|everyone)/.test(rest)) return members.map((m) => m.name);
    const hit = sorted.find((m) => rest.startsWith(m.name.toLowerCase()));
    if (hit && !out.includes(hit.name)) out.push(hit.name);
  }
  return out;
}

export const STATUS_TEXT: Record<Exclude<ConsultMessage["status"], "ok">, string> = {
  error: "出错，没答",
  timeout: "超时，没答",
  stopped: "你停了",
  interrupted: "被打断了：Mesa 关掉时还没答完",
};

export const REF_NOTE: Record<Exclude<ConsultRef["state"], "ok">, string> = {
  missing: "找不到这处",
  unseen: "它没看到这份文件",
};

/** 研讨的材料：只收项目内相对路径（绝对路径在项目里的转相对，项目外的丢掉） */
export function toProjectRel(path: string, root: string): string | null {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const p = norm(path.trim());
  const r = norm(root);
  if (!p) return null;
  const isAbs = p.startsWith("/") || /^[a-z]:\//i.test(p);
  if (!isAbs) return p.startsWith("..") || p.startsWith("~") ? null : p.replace(/^\.\//, "");
  const lp = p.toLowerCase();
  const lr = r.toLowerCase();
  return lp.startsWith(`${lr}/`) ? p.slice(r.length + 1) : null;
}
