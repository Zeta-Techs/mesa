//! 聊天里的「出图」模式纯逻辑（2026-11-24，tests/chat-image-gen.test.ts）。
//! 输入框上的「出图」胶囊选的出图模型只管这一个对话（后端 image_gen_chat.rs 按标签记、出图工具每次现读）；
//! 发出去时 Mesa 在描述前加一行固定写法，技能 image-gen 认这一行就必须调出图工具，不靠人怎么措辞；
//! 聊天里这一行画成小胶囊，不当人话（Rust sessions.rs strip_image_gen_directive 镜像，列表标题同样剥掉）。

import { pathKey } from "./path-utils.ts";

export const IMAGE_GEN_SKILL = "image-gen";

/** 固定写法的行首（Rust sessions.rs IMAGE_GEN_DIRECTIVE_HEADS 镜像） */
const HEAD = "使用 image-gen 技能";
const DIRECTIVE = /^使用 image-gen 技能(出图|改图)（出图模型 ([^\s，,）)]+)[^）)]*[）)][：:]\s*$/;

/** 发出去的第一行：点名出图模型，并写明经 MESA_IMAGE_TOOL 调用（技能没装上时 Agent 也知道该调哪个工具） */
export function imageGenDirective(model: string, edit: boolean): string {
  return `${HEAD}${edit ? "改图" : "出图"}（出图模型 ${model.trim()}，用 $MESA_IMAGE_TOOL 出图工具）：`;
}

/** 输入框里写的话前面加上固定写法那一行 */
export function withImageGenDirective(text: string, model: string, edit: boolean): string {
  return `${imageGenDirective(model, edit)}\n${text}`;
}

/** 一条消息是不是出图模式发的：是就拆出点名的模型与人说的话 */
export function splitImageGenDirective(text: string): { model: string; edit: boolean; said: string } | null {
  if (!text.trimStart().startsWith(HEAD)) return null;
  const body = text.trimStart();
  const nl = body.indexOf("\n");
  const first = nl < 0 ? body : body.slice(0, nl);
  const m = DIRECTIVE.exec(first.trim());
  if (!m) return null;
  return { edit: m[1] === "改图", model: m[2], said: nl < 0 ? "" : body.slice(nl + 1).trim() };
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

/** 出好的图 → 用的哪个模型（键 = pathKey；同一路径后出的覆盖先出的） */
export function captionsByPath(calls: readonly ImageGenCall[], isWindows = false): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of [...calls].sort((a, b) => a.at - b.at)) {
    if (c.phase !== "done") continue;
    for (const p of c.paths) out.set(pathKey(p, isWindows), c.model);
  }
  return out;
}
