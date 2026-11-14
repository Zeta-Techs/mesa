/**
 * 飞书卡片（2026-11-06 docs/design-assistant-dispatch-desk.md §3）：项目助手的回答、等你的事、选项目，拼成飞书消息卡片 JSON
 * （msg_type interactive，卡片 v1 结构）。按钮的 value 回传到 feishu-card-action，由 im-bridge.ts 按动作分级执行。
 * 只放给人看的文字：先脱敏过的回答、问题原文；不放文件正文、路径以外的细节。纯逻辑，配 tests/im-cards.test.ts。
 */
import type { ClarifyAsk, WorkOrder } from "./project-assistant";
import type { DeskItem } from "./assistant-queue";
import type { RouteProject } from "./im-route";

/** 按钮回传值：op 动作、p 项目根、t 那一轮的时间、k 等你的事的键、v 选中的值、q 待问的话 */
export interface CardValue {
  op: "clarify" | "dispatch" | "remember" | "desk" | "project" | "trust" | "resume" | "grant";
  p: string;
  t?: string;
  k?: string;
  v?: string;
  q?: string;
}

const ANSWER_MAX = 3000;

/** 回答正文给手机看：去掉动作标记与 ::: 块（它们变成按钮或另起卡片），截短 */
export function phoneText(answer: string): string {
  const t = answer
    .replace(/(?:^[ \t]*依据[:：][ \t]*[^\n]+\n)?:::[\s\S]*?\n\s*:::/gm, "")
    .replace(/\[\[[^\]\n]{1,600}\]\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return t.length > ANSWER_MAX ? `${t.slice(0, ANSWER_MAX)}…（太长了，完整的在电脑上的项目助手里）` : t;
}

const plain = (content: string) => ({ tag: "plain_text", content });

function button(text: string, value: CardValue, primary = false) {
  return { tag: "button", text: plain(text.slice(0, 40)), type: primary ? "primary" : "default", value };
}

function card(title: string, elements: unknown[], template = "orange") {
  return { config: { wide_screen_mode: true }, header: { template, title: plain(title.slice(0, 60)) }, elements };
}

function note(text: string) {
  return { tag: "note", elements: [plain(text)] };
}

/** 项目助手的一次回答：正文 + 追问选项 / 派活单 / 记下 / 只能在电脑上做的动作提示 */
export function answerCard(input: {
  project: RouteProject;
  turnAt: string;
  text: string;
  ask: ClarifyAsk | null;
  order: WorkOrder | null;
  remember?: string | null;
  remembers?: readonly string[];
  /** 回答里只能在电脑上点的按钮（跳页、商量、报告…）的名字 */
  desktopOnly: readonly string[];
}): object {
  const p = input.project.path;
  const els: unknown[] = [];
  if (input.text) els.push({ tag: "markdown", content: input.text });
  if (input.ask) {
    els.push({ tag: "hr" }, { tag: "markdown", content: `**${input.ask.question}**` });
    if (input.ask.options.length) {
      els.push({ tag: "action", actions: input.ask.options.map((o) => button(o, { op: "clarify", p, t: input.turnAt, v: o })) });
    }
    els.push(note("点一个选项，或者直接回一句"));
  }
  if (input.order) {
    const o = input.order;
    const lines = [
      `**派活单 · ${o.title}**（交给${o.target === "step" ? `第 ${o.step} 步的 AI` : "新目标"}）`,
      o.task,
      o.inputs?.length ? `依据材料：${o.inputs.join("、")}` : "",
      o.deliver ? `交付物：${o.deliver}` : "",
      o.done ? `怎样算做完：${o.done}` : "",
      o.assumptions ? `先定下的假设：${o.assumptions}` : "",
      o.schedule ? `想定期做：${o.schedule}（建成定时任务要在电脑上点）` : "",
    ].filter(Boolean);
    els.push({ tag: "hr" }, { tag: "markdown", content: lines.join("\n") });
    els.push({ tag: "action", actions: [button("派出去", { op: "dispatch", p, t: input.turnAt }, true)] });
    els.push(note("点了才开工；做完要回到电脑上评审 / 验收"));
  }
  const remembers = input.remembers ?? (input.remember ? [input.remember] : []);
  remembers.forEach((line, idx) => {
    const val: CardValue = remembers.length === 1 ? { op: "remember", p, t: input.turnAt } : { op: "remember", p, t: input.turnAt, v: String(idx) };
    els.push({ tag: "hr" }, { tag: "markdown", content: `**以后照这样办${remembers.length > 1 ? `（${idx + 1}/${remembers.length}）` : ""}**\n${line}` });
    els.push({ tag: "action", actions: [button("记进项目知识", val)] });
  });
  if (input.desktopOnly.length) els.push(note(`在电脑上还可以：${input.desktopOnly.join("、")}`));
  return card(`项目助手 · ${input.project.name}`, els.length ? els : [{ tag: "markdown", content: "（没有回答内容）" }]);
}

/** 等你的事（一个或几个项目）：人工请求给选项按钮，对话里的问题提示直接回一句，等确认的提示回电脑 */
export function deskCard(groups: readonly { project: RouteProject; items: readonly DeskItem[] }[]): object {
  const els: unknown[] = [];
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  if (total === 0) return card("等你的事", [{ tag: "markdown", content: "现在没有等你回的事。" }], "green");
  for (const g of groups) {
    if (!g.items.length) continue;
    if (els.length) els.push({ tag: "hr" });
    els.push({ tag: "markdown", content: `**${g.project.name}**` });
    for (const item of g.items.slice(0, 8)) {
      const kind =
        item.kind === "help" ? "人工请求" : item.kind === "question" ? "AI 在问你" : item.kind === "trust" ? "等你信任文件夹" : item.kind === "blocked" ? "卡住了" : item.kind === "grant" ? "要扩大授权" : "等你确认";
      els.push({
        tag: "markdown",
        content: `${item.where} · ${kind}\n${item.question}${item.kind === "grant" && item.detail.length ? `\n被拦下：${item.detail.join("；")}` : ""}`,
      });
      if (item.kind === "help" && item.options.length) {
        els.push({
          tag: "action",
          actions: item.options.slice(0, 4).map((o) =>
            button(`${o.key}：${o.label}${item.recommend === o.key ? "（建议）" : ""}`, { op: "desk", p: g.project.path, k: item.key, v: `${o.key}：${o.label}` }),
          ),
        });
      } else if (item.kind === "grant") {
        // 只放宽这一次（点一下就生效档）；以后都放宽回电脑改定时任务的授权
        els.push({
          tag: "action",
          actions: [
            button("放宽重跑这一次", { op: "grant", p: g.project.path, k: item.key, v: "once" }, true),
            button("不用", { op: "grant", p: g.project.path, k: item.key, v: "no" }),
          ],
        });
      } else if (item.kind === "trust") {
        // 只有你经项目助手派出去的活，手机上才给信任按钮（2026-11-06 用户拍板）；其余回电脑
        if (item.trust?.dispatched) {
          els.push({
            tag: "action",
            actions: [
              button("信任并继续", { op: "trust", p: g.project.path, k: item.key, v: "yes" }, true),
              button("不信任", { op: "trust", p: g.project.path, k: item.key, v: "no" }),
            ],
          });
        } else {
          els.push(note("这件不是经项目助手派出去的，信任文件夹要回到电脑上点"));
        }
      } else if (item.kind === "confirm") {
        els.push(note("确认命令要回到电脑上的对话里做"));
      } else if (item.kind === "blocked") {
        els.push(note("回到电脑上处理"));
      } else {
        els.push(note(`回一句「${g.project.name}：回第 ${item.step ?? "?"} 步 你的话」，原话送进那段对话`));
      }
    }
    if (g.items.length > 8) els.push(note(`还有 ${g.items.length - 8} 件，在电脑上的项目助手里看`));
  }
  return card(`等你的事 ${total} 件`, els);
}

/** 派活进展（停了 / 失败带「接着做」，2026-11-06） */
export function echoCard(project: RouteProject, turnAt: string, text: string, resumable: boolean): object {
  const els: unknown[] = [{ tag: "markdown", content: text }];
  if (resumable) {
    els.push({ tag: "action", actions: [button("接着做", { op: "resume", p: project.path, t: turnAt }, true)] });
    els.push(note("接回上次的隔离副本和对话接着做；也可以直接回一句「接着做」"));
  }
  return card(`派活进展 · ${project.name}`, els, resumable ? "orange" : "green");
}

/** 说不清是哪个项目：列项目按钮，点了把这句话交给它 */
export function projectPickCard(projects: readonly RouteProject[], question: string): object {
  return card("交给哪个项目？", [
    { tag: "markdown", content: question ? `你说的是：${question.slice(0, 200)}` : "选一个默认项目" },
    { tag: "action", actions: projects.slice(0, 12).map((p) => button(p.name, { op: "project", p: p.path, q: question.slice(0, 500) })) },
    note("以后直接说事就交给这个项目；换项目说「切到 项目名」"),
  ]);
}
