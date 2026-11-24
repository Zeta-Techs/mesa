//! 聊天里的「出图」模式纯逻辑（2026-11-24，tests/chat-image-gen.test.ts）。
//! 输入框上的「出图」胶囊选的出图模型只管这一个对话（后端 image_gen_chat.rs 按标签记、出图工具每次现读）；
//! 发出去时 Mesa 在描述前加一行固定写法，技能 image-gen 认这一行就必须调出图工具，不靠人怎么措辞；
//! 聊天里这一行画成小胶囊，不当人话（Rust sessions.rs strip_image_gen_directive 镜像，列表标题同样剥掉）。

import { pathKey } from "./path-utils.ts";

export const IMAGE_GEN_SKILL = "image-gen";
/** 对比时最多几个模型（同连接页「试出与对比」） */
export const MAX_COMPARE = 4;

/** 固定写法的行首（Rust sessions.rs IMAGE_GEN_DIRECTIVE_HEADS 镜像） */
const HEAD = "使用 image-gen 技能";
const DIRECTIVE = /^使用 image-gen 技能(出图|改图)（出图模型 ([^\s，,）)]+)[^）)]*[）)][：:]\s*$/;

/**
 * 发出去的第一行：点名出图模型，并写明经 MESA_IMAGE_TOOL 调用（技能没装上时 Agent 也知道该调哪个工具）。
 * 几个模型对比（2026-11-24）：「出图模型 A、B、C 各出一版对比」，技能按它每个模型各调一次
 */
export function imageGenDirective(models: string | readonly string[], edit: boolean): string {
  const list = (typeof models === "string" ? [models] : [...models]).map((m) => m.trim()).filter(Boolean);
  const named = list.length > 1 ? `${list.join("、")} 各出一版对比` : (list[0] ?? "");
  return `${HEAD}${edit ? "改图" : "出图"}（出图模型 ${named}，用 $MESA_IMAGE_TOOL 出图工具）：`;
}

/** 输入框里写的话前面加上固定写法那一行 */
export function withImageGenDirective(text: string, models: string | readonly string[], edit: boolean): string {
  return `${imageGenDirective(models, edit)}\n${text}`;
}

/** 一条消息是不是出图模式发的：是就拆出点名的模型（对比时几个）与人说的话 */
export function splitImageGenDirective(
  text: string,
): { model: string; models: string[]; compare: boolean; edit: boolean; said: string } | null {
  if (!text.trimStart().startsWith(HEAD)) return null;
  const body = text.trimStart();
  const nl = body.indexOf("\n");
  const first = nl < 0 ? body : body.slice(0, nl);
  const m = DIRECTIVE.exec(first.trim());
  if (!m) return null;
  const models = m[2].split("、").filter(Boolean);
  if (models.length === 0) return null;
  return {
    edit: m[1] === "改图",
    model: models[0],
    models,
    compare: models.length > 1,
    said: nl < 0 ? "" : body.slice(nl + 1).trim(),
  };
}

/** 去掉固定写法那一行，只留人说的（取回历史、列表标题用） */
export function stripImageGenDirective(text: string): string {
  return splitImageGenDirective(text)?.said ?? text;
}

export type ImageGenIssue =
  /** 这版 Mesa 没找到随包的出图工具：发不了 */
  | { kind: "no-helper" }
  /** 对话里没选、连接页也没设默认：发不了；candidates = 各网关目录里一共有几个出图模型（null = 还没读回来） */
  | { kind: "no-model"; candidates: number | null }
  /** 这家 Agent 没打开技能 image-gen：能发（那一行写明了工具），提醒打开 */
  | { kind: "no-skill" };

/** 发之前查一遍：哪一条不满足就说哪一条（只报最要紧的一条） */
export function imageGenIssue(input: {
  helperReady: boolean | null;
  model: string | null;
  candidates: number | null;
  skillEnabled: boolean;
}): ImageGenIssue | null {
  if (input.helperReady === false) return { kind: "no-helper" };
  if (!input.model?.trim()) return { kind: "no-model", candidates: input.candidates };
  if (!input.skillEnabled) return { kind: "no-skill" };
  return null;
}

/** 这条问题拦不拦发送：没工具、没模型拦；没开技能只提醒 */
export function imageGenBlocks(issue: ImageGenIssue | null): boolean {
  return issue?.kind === "no-helper" || issue?.kind === "no-model";
}

/** 出图工具每调用一次记一条（后端 image_gen_chat.rs ImageCall） */
export interface ImageGenCall {
  id: string;
  at: number;
  phase: "start" | "done" | "failed";
  model: string;
  gatewayName: string;
  paths: string[];
}

/** 发出那一刻之后有没有调过出图工具（开始就算，图要几分钟才回来；留 2 秒给两边时钟与落盘的先后） */
export function calledSince(calls: readonly ImageGenCall[], sentAt: number): boolean {
  return calls.some((c) => c.at >= sentAt - 2000);
}

/** 这张图是哪一次调用出的（对比后点其中一张接着改：胶囊回到出这张的那个模型）；记录里没有为 null */
export function producerOf(calls: readonly ImageGenCall[], path: string, isWindows = false): ImageGenCall | null {
  const key = pathKey(path, isWindows);
  let hit: ImageGenCall | null = null;
  for (const c of calls) {
    if (c.phase !== "done" || !c.paths.some((p) => pathKey(p, isWindows) === key)) continue;
    if (!hit || c.at >= hit.at) hit = c;
  }
  return hit;
}

/** 还在出的（开始了、还没出完也没失败）：聊天里画进度条用。同一次调用的几行按 id 对上 */
export function inflightCalls(calls: readonly ImageGenCall[]): ImageGenCall[] {
  const ended = new Set(calls.filter((c) => c.phase !== "start").map((c) => c.id));
  return calls.filter((c) => c.phase === "start" && !ended.has(c.id));
}

/** 出完的几次各用了多久（开始 → 出完，毫秒）：喂给进度条的耗时估算（image-models.ts estimateSeconds） */
export function finishedDurations(calls: readonly ImageGenCall[]): { id: string; model: string; ms: number }[] {
  const starts = new Map(calls.filter((c) => c.phase === "start").map((c) => [c.id, c.at]));
  const out: { id: string; model: string; ms: number }[] = [];
  for (const c of calls) {
    const begun = starts.get(c.id);
    if (c.phase === "done" && begun !== undefined && c.at > begun) out.push({ id: c.id, model: c.model, ms: c.at - begun });
  }
  return out;
}

/** 已等多久的写法：「45 秒」「2 分 05 秒」 */
export function waitedText(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, "0")} 秒`;
}

/** 出好的图 → 用的哪个模型（键 = pathKey；同一路径后出的覆盖先出的） */
export function captionsByPath(calls: readonly ImageGenCall[], isWindows = false): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of [...calls].sort((a, b) => a.at - b.at)) {
    if (c.phase !== "done") continue;
    for (const p of c.paths) out.set(pathKey(p, isWindows), c.model);
  }
  return out;
}
