/**
 * 飞书卡片（2026-11-06 docs/design-assistant-dispatch-desk.md §3；2026-11-15 完善原卡流转、状态秒看与完成提醒）：
 * 项目助手的回答、思考占位、等你的事、项目切换与状态速览、里程碑通知，拼成飞书消息卡片 JSON（msg_type interactive，卡片 v1 结构，
 * 开启 update_multi 以便点击后经 PATCH 原地更新状态）。按钮 value 回传到 feishu-card-action，由 im-bridge.ts 按动作分级执行。
 * 只放给人看的文字：先脱敏过的回答、问题原文；不放文件正文、路径以外的细节。纯逻辑，配 tests/im-cards.test.ts。
 */
import type { ClarifyAsk, WorkOrder } from "./project-assistant";
import type { DeskItem } from "./assistant-queue";
import type { BriefInput, BriefStep } from "./assistant-brief";
import type { PetItem } from "./desk-pet";
import type { RouteProject } from "./im-route";

/** 按钮回传值：op 动作、p 项目根、t 那一轮的时间、k 等你的事的键、v 选中的值、q 待问/待回的话 */
export interface CardValue {
  op:
    | "clarify"
    | "dispatch"
    | "remember"
    | "remember_help"
    | "desk"
    | "reply_target"
    | "reply_pick"
    | "project"
    | "trust"
    | "resume"
    | "grant"
    | "preread"
    | "show_queue"
    | "self_test";
  p?: string;
  t?: string;
  k?: string;
  v?: string;
  q?: string;
}

export interface AnswerCardSettled {
  clarify?: string | null;
  dispatched?: string | null;
  remembered?: ReadonlySet<number>;
}

export interface DeskItemSettled {
  status: string;
  /** 人工请求答完后可顺手点「同时记进项目知识」的一句；记过或无需记则为 null */
  rememberLine?: string | null;
}

export interface ReplyTargetChoice {
  projectPath: string;
  projectName: string;
  key: string;
  where: string;
  question: string;
}

const ANSWER_MAX = 3000;
const ACTIONS_PER_ROW = 5;

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

function actionRows(btns: unknown[]): unknown[] {
  const rows: unknown[] = [];
  for (let i = 0; i < btns.length; i += ACTIONS_PER_ROW) {
    rows.push({ tag: "action", actions: btns.slice(i, i + ACTIONS_PER_ROW) });
  }
  return rows;
}

function card(title: string, elements: unknown[], template = "orange") {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template, title: plain(title.slice(0, 60)) },
    elements,
  };
}

function note(text: string) {
  return { tag: "note", elements: [plain(text)] };
}

function quoteLine(question: string): string {
  const clean = question.trim().replace(/\s+/g, " ");
  if (!clean) return "";
  return `> ${clean.length > 120 ? `${clean.slice(0, 120)}…` : clean}\n\n`;
}

/** 提问后的思考占位卡片：答完或出错后经 PATCH 原地换成正式卡片，不再刷「收到，稍等」文字 */
export function thinkingCard(project: RouteProject, question: string, statusText?: string | null): object {
  return card(
    `项目助手 · ${project.name}`,
    [
      { tag: "markdown", content: `${quoteLine(question)}${statusText || "正在只读查看项目状态并思考，稍等…"}` },
      note("答完后这张卡片会自动更新成正式回答"),
    ],
    "blue",
  );
}

/** 提问出错时原地替换占位卡片 */
export function askErrorCard(project: RouteProject, question: string, reason: string): object {
  return card(
    `项目助手 · ${project.name}`,
    [{ tag: "markdown", content: `${quoteLine(question)}没问成：${reason}` }],
    "red",
  );
}

/** 项目助手的一次回答：正文 + 追问选项 / 派活单 / 记下 / 只能在电脑上做的动作提示（支持点过后原地更新状态） */
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
  settled?: AnswerCardSettled;
}): object {
  const p = input.project.path;
  const els: unknown[] = [];
  if (input.text) els.push({ tag: "markdown", content: input.text });
  if (input.ask) {
    els.push({ tag: "hr" }, { tag: "markdown", content: `**${input.ask.question}**` });
    if (input.settled?.clarify) {
      els.push(note(`✓ 已回：${input.settled.clarify}`));
    } else {
      if (input.ask.options.length) {
        els.push(...actionRows(input.ask.options.map((o) => button(o, { op: "clarify", p, t: input.turnAt, v: o }))));
      }
      els.push(note("点一个选项，或者左滑「引用回复」这张卡片直接写一句"));
    }
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
    if (input.settled?.dispatched) {
      els.push(note(`✓ ${input.settled.dispatched}`));
    } else {
      els.push({ tag: "action", actions: [button("派出去", { op: "dispatch", p, t: input.turnAt }, true)] });
      els.push(note("点了才开工；做完要回到电脑上评审 / 验收"));
    }
  }
  const remembers = input.remembers ?? (input.remember ? [input.remember] : []);
  remembers.forEach((line, idx) => {
    const val: CardValue = remembers.length === 1 ? { op: "remember", p, t: input.turnAt } : { op: "remember", p, t: input.turnAt, v: String(idx) };
    els.push({ tag: "hr" }, { tag: "markdown", content: `**以后照这样办${remembers.length > 1 ? `（${idx + 1}/${remembers.length}）` : ""}**\n${line}` });
    if (input.settled?.remembered?.has(idx)) {
      els.push(note("✓ 已记进项目知识"));
    } else {
      els.push({ tag: "action", actions: [button("记进项目知识", val)] });
    }
  });
  if (input.desktopOnly.length) els.push(note(`在电脑上还可以：${input.desktopOnly.join("、")}`));
  return card(`项目助手 · ${input.project.name}`, els.length ? els : [{ tag: "markdown", content: "（没有回答内容）" }]);
}

/** 等你的事（一个或几个项目）：人工请求给全部选项 + 自定义回答，对话里的问题支持一键回复与引用回复 */
export function deskCard(
  groups: readonly { project: RouteProject; items: readonly DeskItem[] }[],
  settled?: ReadonlyMap<string, DeskItemSettled>,
): object {
  const els: unknown[] = [];
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  if (total === 0) return card("等你的事", [{ tag: "markdown", content: "现在没有等你回的事。" }], "green");
  for (const g of groups) {
    if (!g.items.length) continue;
    if (els.length) els.push({ tag: "hr" });
    els.push({ tag: "markdown", content: `**${g.project.name}**` });
    for (const item of g.items.slice(0, 8)) {
      const kind =
        item.kind === "help"
          ? "人工请求"
          : item.kind === "question"
            ? "AI 在问你"
            : item.kind === "trust"
              ? "等你信任文件夹"
              : item.kind === "blocked"
                ? "卡住了"
                : item.kind === "grant"
                  ? "要扩大授权"
                  : "等你确认";
      const extraLines: string[] = [];
      if (item.kind === "grant" && item.detail.length) {
        extraLines.push(`被拦下：${item.detail.join("；")}`);
      } else if (item.kind === "help" && item.detail.length) {
        extraLines.push(...item.detail.slice(0, 3).map((d) => `· ${d}`));
      }
      if (item.siblingPendingCount && item.siblingPendingCount > 0) {
        extraLines.push(`（同处还有 ${item.siblingPendingCount} 题待答）`);
      }
      els.push({
        tag: "markdown",
        content: [`${item.where} · ${kind}`, item.question, ...extraLines].join("\n"),
      });
      const done = settled?.get(item.key);
      if (done) {
        els.push(note(`✓ ${done.status}`));
        if (done.rememberLine) {
          els.push({
            tag: "action",
            actions: [
              button("同时记进项目知识", {
                op: "remember_help",
                p: g.project.path,
                k: item.key,
                v: done.rememberLine.slice(0, 300),
              }),
            ],
          });
        }
        continue;
      }
      if (item.kind === "help") {
        const btns = item.options.map((o) =>
          button(
            `${o.key}：${o.label}${item.recommend === o.key ? "（建议）" : ""}`,
            { op: "desk", p: g.project.path, k: item.key, v: `${o.key}：${o.label}` },
            item.recommend === o.key,
          ),
        );
        btns.push(button("写一句自定回答", { op: "reply_target", p: g.project.path, k: item.key }));
        els.push(...actionRows(btns));
        els.push(note("点选项直接答；要自己写说明可点「写一句自定回答」，或左滑引用回复本卡片"));
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
        els.push({
          tag: "action",
          actions: [button("写一句回它", { op: "reply_target", p: g.project.path, k: item.key }, true)],
        });
        els.push(
          note(
            item.step !== null
              ? `点「写一句回它」、左滑引用回复本卡片，或发「${g.project.name}：回第 ${item.step} 步 你的话」`
              : "点「写一句回它」或左滑「引用回复」本卡片，原话送进那段对话",
          ),
        );
      }
    }
    if (g.items.length > 8) els.push(note(`还有 ${g.items.length - 8} 件，在电脑上的项目助手里看`));
  }
  const allSettled =
    settled &&
    total > 0 &&
    groups.every((g) => g.items.slice(0, 8).every((i) => settled.has(i.key) || i.kind === "confirm" || i.kind === "blocked" || (i.kind === "trust" && !i.trust?.dispatched)));
  return card(`等你的事 ${total} 件`, els, allSettled ? "green" : "orange");
}

/** 引用回复或「回：…」遇到多条可回事项时：点一下选送给哪一处 */
export function replyPickCard(choices: readonly ReplyTargetChoice[], replyBody: string, settledNote?: string | null): object {
  const els: unknown[] = [{ tag: "markdown", content: `你要回的话：${replyBody.slice(0, 240)}` }];
  if (settledNote) {
    els.push(note(`✓ ${settledNote}`));
  } else {
    els.push(
      ...actionRows(
        choices.slice(0, 10).map((c) =>
          button(`${c.projectName} · ${c.where}`, {
            op: "reply_pick",
            p: c.projectPath,
            k: c.key,
            q: replyBody.slice(0, 500),
          }),
        ),
      ),
    );
    els.push(note("点一下就按原话送过去"));
  }
  return card("这句话回给哪一处？", els, settledNote ? "green" : "blue");
}

/** 派活进展（停了 / 失败带「接着做」，2026-11-06；点后可原地置为已接回） */
export function echoCard(project: RouteProject, turnAt: string, text: string, resumable: boolean, settledNote?: string | null): object {
  const els: unknown[] = [{ tag: "markdown", content: text }];
  if (settledNote) {
    els.push(note(`✓ ${settledNote}`));
  } else if (resumable) {
    els.push({ tag: "action", actions: [button("接着做", { op: "resume", p: project.path, t: turnAt }, true)] });
    els.push(note("接回上次的隔离副本和对话接着做；也可以直接回一句「接着做」"));
  }
  return card(`派活进展 · ${project.name}`, els, resumable && !settledNote ? "orange" : "green");
}

/** 说不清是哪个项目：列项目按钮，点了把这句话交给它 */
export function projectPickCard(projects: readonly RouteProject[], question: string, settledProject?: string | null): object {
  const els: unknown[] = [{ tag: "markdown", content: question ? `你说的是：${question.slice(0, 200)}` : "选一个默认项目" }];
  if (settledProject) {
    els.push(note(`✓ 已交给「${settledProject}」`));
  } else {
    els.push(...actionRows(projects.slice(0, 12).map((p) => button(p.name, { op: "project", p: p.path, q: question.slice(0, 500) }))));
    els.push(note("以后直接说事就交给这个项目；换项目发「项目」或「切到 项目名」"));
  }
  return card("交给哪个项目？", els, settledProject ? "green" : "orange");
}

/** 发「项目」时的交互切换卡片：标出当前项目与待处理件数，点一下即切换 */
export function projectListCard(
  projects: readonly { path: string; name: string; waiting?: number }[],
  currentPath: string | null,
  settledProject?: string | null,
): object {
  if (projects.length === 0) {
    return card("项目列表", [{ tag: "markdown", content: "Mesa 里还没有项目。" }], "blue");
  }
  const lines = projects.map((p) => {
    const cur = currentPath === p.path ? "（当前默认）" : "";
    const wait = p.waiting ? ` · ${p.waiting} 件等你` : "";
    return `· **${p.name}**${cur}${wait}`;
  });
  const els: unknown[] = [{ tag: "markdown", content: lines.join("\n") }];
  if (settledProject) {
    els.push(note(`✓ 已切到「${settledProject}」，接下来直接说事就交给它`));
  } else {
    els.push(
      ...actionRows(
        projects.slice(0, 15).map((p) =>
          button(
            `${p.name}${p.waiting ? ` (${p.waiting})` : ""}`,
            { op: "project", p: p.path },
            currentPath === p.path,
          ),
        ),
      ),
    );
    els.push(note("点项目名切换默认项目；发「进展」秒看当前项目状态"));
  }
  return card("项目列表", els, settledProject ? "green" : "blue");
}

function formatStepLine(s: BriefStep): string {
  const stateMap: Record<BriefStep["state"], string> = {
    saved: "✓ 已保存",
    review: "⏳ 做完了，待回电脑评审",
    working: "● 正在运行",
    confirm: "⏸ 等你确认",
    failed: `✕ 出错了${s.failure ? `（${s.failure.slice(0, 50)}）` : ""}`,
    open: "◐ 已开启工作副本",
    idle: "○ 未开始",
  };
  const extras: string[] = [];
  if (s.staleUpstream || (s.pendingUpstream && s.n > 1)) {
    extras.push(s.staleUpstream ? `「${s.staleUpstream}」有更新待跟进` : "上游有更新待跟进");
  }
  if (s.needsHuman > 0 && s.state !== "saved") extras.push(`核验 ${s.needsHuman} 条待判断`);
  return `${stateMap[s.state]} · 第 ${s.n} 步「${s.name}」${extras.length ? `（${extras.join("，")}）` : ""}`;
}

/** 发「进展 / 状态」时的零 Token 秒回卡片：直接按本机记录列出步骤、目标与待办 */
export function projectStatusCard(project: RouteProject, brief: BriefInput, deskCount: number): object {
  const sections: string[] = [];
  if (brief.steps.length > 0) {
    sections.push(`**流程步骤**\n${brief.steps.map(formatStepLine).join("\n")}`);
  }
  const activeGoals = brief.goals.filter((g) => ["running", "pending_review", "failed", "stopped"].includes(g.status));
  if (activeGoals.length > 0) {
    const goalLabel = (st: string) =>
      st === "running" ? "● 进行中" : st === "pending_review" ? "⏳ 待回电脑验收" : st === "failed" ? "✕ 没做成" : "⏸ 已停下";
    sections.push(`**目标**\n${activeGoals.slice(0, 6).map((g) => `${goalLabel(g.status)} · ${g.name}`).join("\n")}`);
  }
  if (brief.uncertainSchedules?.length) {
    sections.push(`**定时任务**\n${brief.uncertainSchedules.map((u) => `⚠ 「${u.name}」上次后台跟进结果不明，已暂停等你核对`).join("\n")}`);
  }
  if (deskCount > 0) {
    sections.push(`**等你的事**：当前有 **${deskCount}** 件待你处理`);
  }
  if (sections.length === 0) {
    sections.push("当前还没有套流程或正在跑的目标。直接发一句想做的事即可起草派活单。");
  }
  const btns: unknown[] = [];
  if (deskCount > 0) {
    btns.push(button(`查看等我的事（${deskCount}）`, { op: "show_queue", p: project.path }, true));
  }
  const reviewStep = brief.steps.find((s) => s.state === "review");
  if (reviewStep) {
    btns.push(button(`先帮我看一遍第 ${reviewStep.n} 步`, { op: "preread", p: project.path, v: String(reviewStep.n) }));
  }
  btns.push(button("详细问项目助手", { op: "clarify", p: project.path, v: "现在到哪了？我下一步该做什么？" }));
  return card(
    `项目进展 · ${project.name}`,
    [{ tag: "markdown", content: sections.join("\n\n") }, ...actionRows(btns), note("由 Mesa 按本机记录即时汇总，不消耗模型额度")],
    deskCount > 0 ? "orange" : "blue",
  );
}

/** 步骤 / 目标做完待评审或出错的主动提醒卡片（复用桌宠 PetItem 取数，只报信 + 可让项目助手只读预审 / 查错） */
export function milestoneCard(items: readonly PetItem[]): object {
  const hasFailed = items.some((i) => i.kind === "failed");
  const els: unknown[] = [];
  for (const item of items.slice(0, 6)) {
    if (els.length) els.push({ tag: "hr" });
    const detail = item.detail ? `\n${item.detail.slice(0, 180)}` : "";
    els.push({ tag: "markdown", content: `**${item.projectName}** · ${item.text}${detail}` });
    const stepReviewMatch = item.key.match(/\|step-review:(\d+):/);
    if (stepReviewMatch) {
      els.push({
        tag: "action",
        actions: [button("先让项目助手看一遍", { op: "preread", p: item.projectPath, v: stepReviewMatch[1] })],
      });
    } else if (item.kind === "failed") {
      els.push({
        tag: "action",
        actions: [button("问问为什么出错", { op: "clarify", p: item.projectPath, v: `${item.where}为什么出错或停下了？我该怎么办？` })],
      });
    }
  }
  els.push(note("评审采纳、写回项目请回到电脑上的 Mesa 处理"));
  return card(hasFailed ? "运行异常提醒" : "步骤 / 目标已完成", els, hasFailed ? "red" : "green");
}

/** 设置页「发测试卡片」点完按钮后的原地完成卡 */
export function selfTestDoneCard(): object {
  return card(
    "通道自检通过 · Mesa",
    [{ tag: "markdown", content: "✓ **收发消息、卡片回传回调、原卡状态更新** 已全部打通，可以放心在手机上用了。" }],
    "green",
  );
}
