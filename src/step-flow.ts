import type { HumanTaskStateDto, ProjectStepDto } from "./types";
import { REVIEW_SAVE } from "./review-save-copy.ts";
import { isCitationStyleTask } from "./citation-style-choice.ts";

/** 步骤内协同流程线（v3.71）的纯逻辑：把「这一步里人和 agent 的动作」按先后排成有序节点链，
 *  全部状态派生（无状态机）。节点顺序 = 讨论种子 → before 人工事项 → agent 执行
 *  → during 人工事项（并行段） → after 人工事项（v3.97 起一律进主干——收尾项是流程的一步，
 *  沉到可选分隔线下会让用户以为它不存在） → 评审保存进项目。
 *  「当前节点」= 第一个未完成节点（currentNodeKey），组件高亮并就地展开其操作区；
 *  **可选人工事项不参与当前节点判定**——不做也能跑完，让它当「当前」会把指示卡死。
 *  例外：agent 节点的「开始/恢复工作区/去终端看看」不受当前节点门控——开始始终可用，
 *  讨论种子与开始前事项只提醒不拦（同 KickoffConfirmDialog 口径）。 */

/** 步骤执行状态的外部输入（由调用方从工作区派生：ProjectGroup 的 deriveStepStatus 口径） */
export type StepRunStatus =
  | "pending" // 未开始（无工作区或已归档）
  | "active" // agent 进行中
  | "review" // agent 做完了待评审（含阻塞——阻塞也走评审入口）
  | "done"; // 已保存进项目

/**
 * 「去评审」：待评审必给；进行中只在 Agent 正在出字/等确认时藏起来。
 * CLI 收完这一轮后进程还坐在提示符上，步骤仍是进行中——精读/大纲就是这样给入口的。
 */
export function reviewActionVisible(
  runStatus: StepRunStatus,
  agentBusy = false,
): boolean {
  if (runStatus === "review") return true;
  if (runStatus === "active") return !agentBusy;
  return false;
}

export interface StepFlowNode {
  key: string;
  kind: "discuss" | "input" | "human" | "agent" | "review";
  /** 版式分区：main = 主干（必须发生的先后链）；optional = 可选补充（沉到分隔线下）。
   *  可选项不进主干还有个要紧的副作用——它们不再抢「当前节点」：
   *  一个永远不打勾的可选项会把当前指示卡死在那儿，后面的节点永远轮不到 */
  section: "main" | "optional";
  label: string;
  /** 引导小字（落点说明/时机说明） */
  hint?: string;
  done: boolean;
  /** 显示在主干但不抢当前节点（默认即有效答案：稿件载体 Markdown、Blender 不需要） */
  skipCurrent?: boolean;
  /** human 节点对应的人工事项（勾选/提交产物回传用） */
  human?: HumanTaskStateDto;
}

export interface StepFlow {
  nodes: StepFlowNode[];
  /** 第一个未完成节点的 key；全部完成为 null */
  currentKey: string | null;
}

function isPaperPdfPath(path: string): boolean {
  return path.replace(/\\/g, "/").toLowerCase().endsWith(".pdf");
}

/**
 * 「开读这一篇」只给示例课题的精读步（检索步 `seedComplete` + 当前步挂 lit-notes + 已有 PDF）。
 * 普通模板即使登记了文献，流程线也只显示「开始」——不得按「有 PDF」给所有步骤挂这个按钮。
 */
export function demoReadPaperResource<T extends { type: string; path: string }>(args: {
  steps: Array<{ name: string; seedComplete?: boolean; skills: string[] }>;
  focusStepName?: string | null;
  resources: T[];
  /** 名字→provides 映射（缺省回落名字匹配：内置 lit-notes 行为不变） */
  providesByName?: Record<string, string[]>;
}): T | undefined {
  if (!args.focusStepName) return undefined;
  if (!args.steps.some((s) => s.seedComplete)) return undefined;
  const focus = args.steps.find((s) => s.name === args.focusStepName);
  if (!stepFillsAnySlot(focus?.skills, ["lit-notes"], args.providesByName)) return undefined;
  return args.resources.find((r) => r.type === "paper" && isPaperPdfPath(r.path));
}

/** 可选分区已经标明「可选」，标题里再写「（可选）」是重复。 */
import { stepFillsAnySlot } from "./skill-slots.ts";

export function stripOptionalTitlePrefix(title: string): string {
  return title.replace(/^（可选）\s*/, "");
}

/**
 * 人工事项在流程线上的标签。引用样式只有一种形态「更换」——
 * 旧档案里还可能是「填写引用样式」，按同一件事显示。
 */
export function humanTaskLabel(h: { title: string; optional?: boolean }): string {
  if (isCitationStyleTask(h.title)) return "更换引用样式";
  return h.optional ? stripOptionalTitlePrefix(h.title) : h.title;
}

export function buildStepFlow(args: {
  step: ProjectStepDto;
  /** 本步骤的人工事项派生状态（已按步骤过滤） */
  states: HumanTaskStateDto[];
  /** 本步骤任务书草稿已起草（.ccode/drafts/<步骤>.md，讨论种子节点的完成口径） */
  hasDraft: boolean;
  /** 项目当前的文献来源（input 节点完成口径）：非空且非 search = 已交代清楚 */
  litSource?: string;
  runStatus: StepRunStatus;
  /** 还没拍板的决策项数量（草稿「已定方向」小节回填后算出）：
   *  只要还有没答的，本节点就不算完事——只写了一条答案草稿就存在了，
   *  拿 hasDraft 当完成口径会在还剩几题没答时就打勾 */
  pendingDecisions?: number;
  /** 本步要问的科研工具。稿件载体是开工前提，排在 agent 前；其余不挡主动作，沉到可选区。 */
  toolAsks?: Array<{ key: string; label: string }>;
  /** 精读保存后出现文献库同步。检索步的 RIS 还不齐，不在那里同步。 */
  endnoteExport?: boolean;
  /** 精读步：保存进项目之后，EndNote 底下出现「继续精读笔记」，进沉浸阅读。不是人工事项。 */
  continueNotes?: boolean;
}): StepFlow {
  const { step, states, hasDraft, runStatus } = args;
  const pendingDecisions = args.pendingDecisions ?? 0;
  const nodes: StepFlowNode[] = [];
  const humans = (timing: string) => states.filter((s) => s.timing === timing);

  // 0.5 输入准备：文献从哪来（模板声明 asksLitSource 的步骤才有）。
  //     独立成节点、排在 agent 之前——它是**开工的前提**（决定 AI 要不要去检索），
  //     挂在 agent 节点内容区会让「开始」按钮出现在它上方，变成「先出发再问路」（用户实测）。
  //     完成口径：选了非默认来源，或这一步已经开工——开工即按当时的来源执行了。
  //     默认「让 agent 检索」不落值，旧口径只认非 search，AI 跑完待评审了「当前」
  //     竖线还钉在这一行，真正该做的「去评审」反而不是当前（2026-10-17 用户截图）。
  if (step.asksLitSource) {
    nodes.push({
      key: "input",
      kind: "input",
      section: "main",
      label: "确定文献来源",
      hint: undefined,
      done:
        ((args.litSource ?? "").trim() !== "" && args.litSource !== "search") ||
        runStatus !== "pending",
    });
  }
  // 0.6 稿件载体会换本步正式稿，是开工前提，排在 agent 前（与「确定文献来源」同形）。
  //     Origin / Blender / 库交付不是这一步的主工作，不插在步骤前面。
  for (const ask of (args.toolAsks ?? []).filter((item) => item.key === "manuscript")) {
    nodes.push({
      key: `tool:${ask.key}`,
      kind: "input",
      section: "main",
      label: ask.label,
      done: false,
      skipCurrent: true,
    });
  }
  // 1. 「先定几件事」：**有东西要定才出现**（v3.89 修，用户反馈「有点空」）。
  //    v3.89 把整篇级决策移到项目层、把要看数据才能定的改为按需问之后，
  //    检索这类步骤的开工前决策项归零——节点只剩一个「跟 AI 商量」按钮，
  //    白占流程线一格还让人以为漏了什么。
  //    判定用**声明**（decisions/seeds 是否配置）而非「是否答完」：答完就消失会让
  //    流程线在你眼前少一格，比空着更让人不安。
  //    想法区（discussContent）随之改挂 agent 节点——它本来就是「开工前想清楚要干嘛」，
  //    贴着 agent 节点比单独占一格更贴切。
  const decisions = step.decisions ?? [];
  const seeds = step.discussionSeeds ?? [];
  const hasSomethingToSettle = decisions.length > 0 || seeds.length > 0;
  if (hasSomethingToSettle) {
    nodes.push({
      key: "discuss",
      kind: "discuss",
      section: "main",
      label:
        pendingDecisions > 0
          ? `先定几件事（还有 ${pendingDecisions} 件）`
          : "先定几件事",
      done: hasDraft && pendingDecisions === 0,
    });
  }
  // 2. before 人工事项
  for (const h of humans("before")) {
    nodes.push({
      key: `human:${h.title}`,
      kind: "human",
      section: h.optional ? "optional" : "main",
      label: humanTaskLabel(h),
      hint: undefined,
      done: h.done,
      human: h,
    });
  }
  // 3. agent 执行：完成 = 有待评审产出或已合并
  nodes.push({
    key: "agent",
    kind: "agent",
    section: "main",
    label: `AI 干活：${step.name}`,
    hint: undefined,
    done: runStatus === "review" || runStatus === "done",
  });
  // 4. during 人工事项（与 agent 并行段）
  for (const h of humans("during")) {
    nodes.push({
      key: `human:${h.title}`,
      kind: "human",
      section: h.optional ? "optional" : "main",
      label: humanTaskLabel(h),
      hint: undefined,
      done: h.done,
      human: h,
    });
  }
  // 5. after 人工事项（agent 干完才轮到人）。
  //    付费墙这类收尾进主干、排在评审前（v3.97：沉到可选区会让人以为不存在）。
  //    EndNote 交差依赖「保存进项目」后的 xml，排在评审后、可选区，免得开工前像要先勾。
  const afterMain: typeof states = [];
  const afterEndnote: typeof states = [];
  for (const h of humans("after")) {
    if (h.optional && isEndnoteTaskTitle(h.title)) afterEndnote.push(h);
    else afterMain.push(h);
  }
  for (const h of afterMain) {
    nodes.push({
      key: `human:${h.title}`,
      kind: "human",
      section: "main",
      label: humanTaskLabel(h),
      hint: undefined,
      done: h.done,
      human: h,
    });
  }
  // 6. 评审保存（护城河：每步成果人工核对后才写入项目）
  nodes.push({
    key: "review",
    kind: "review",
    section: "main",
    label: REVIEW_SAVE.reviewNodeLabel,
    hint:
      runStatus === "review"
        ? REVIEW_SAVE.reviewHintReady
        : runStatus === "active"
          ? REVIEW_SAVE.reviewHintActive
          : undefined,
    done: runStatus === "done",
  });
  for (const h of afterEndnote) {
    if (runStatus === "pending") continue;
    nodes.push({
      key: `human:${h.title}`,
      kind: "human",
      section: "optional",
      label: stripOptionalTitlePrefix(h.title),
      hint: runStatus === "done"
        ? "保存进项目之后，打开导入文件。"
        : "先保存进项目，才会有导入文件。",
      done: h.done,
      human: h,
    });
  }
  if (args.endnoteExport && afterEndnote.length === 0) {
    nodes.push({
      key: "endnote-export",
      kind: "human",
      section: "optional",
      label: "同步到文献库",
      hint: runStatus === "done"
        ? "按引文库重写后打开。已有同一 DOI 的不要再导入。PDF 拖到库里那一条上。"
        : "先保存进项目，才可以同步。",
      done: false,
      skipCurrent: true,
    });
  }
  if (args.continueNotes) {
    nodes.push({
      key: "continue-notes",
      kind: "human",
      section: "optional",
      label: "继续精读笔记",
      hint: runStatus === "done"
        ? "到文件页打开 notes/。点一篇笔记进沉浸阅读；开大纲前没存进历史的改动会再问你一次。"
        : "先保存进项目，笔记才会进主文件夹。",
      done: false,
      skipCurrent: true,
    });
  }
  for (const ask of (args.toolAsks ?? []).filter((item) => item.key !== "manuscript")) {
    nodes.push({
      key: `tool:${ask.key}`,
      kind: "input",
      section: "optional",
      label: ask.label,
      done: false,
      skipCurrent: true,
    });
  }

  // 当前节点只在主干里找，且跳过可选项：可选人工事项不做也能跑完这一步，
  // 让它当「当前」会把指示卡死在那儿，后面的节点永远轮不到
  const current = nodes.find(
    (n) =>
      n.section === "main" &&
      !n.done &&
      !n.skipCurrent &&
      !(n.kind === "human" && n.human?.optional),
  );
  return { nodes, currentKey: current?.key ?? null };
}

/** 能接回本步上次商量会话时改「继续讨论」，否则「跟 AI 商量一下」。 */
export function discussChatLabel(discussed: boolean): string {
  return discussed ? "继续讨论" : "跟 AI 商量一下";
}

/** 付费墙补充任务（检索步 after 事项）：就地挂「待获取清单」展开入口。
 *  判定与 isAcademicMcpTaskTitle 同款按标题关键词——模板任务名「下载付费墙文献全文」。 */
export function isPaywallTaskTitle(title: string): boolean {
  return title.includes("付费");
}

/**
 * 「核对待确认篇目」——文献筛选的 pending 判定入口。
 *
 * 判据是**裸词**「待确认」，不能只看 substring：数据类模板把这三个字当正文术语用
 * （「解答「待确认」字段的业务含义」「拍板 [待确认] 清洗规则」，都是必办事项），
 * 它们要的是普通引导文案，不是文献篇目核对入口。旧实现 `title.includes("待确认")`
 * 会把这两条也判进来，给它们挂上「逐篇纳入或排除」的提示与清单面板。
 * 区分点是形态：包在引号/方括号里的「待确认」是内容术语，裸露的才是这件事本身。
 */
const QUOTED_PENDING = /[「『\[【]待确认[」』\]】]/;
export function isPendingConfirmTaskTitle(title: string): boolean {
  return title.includes("待确认") && !QUOTED_PENDING.test(title);
}

/** 精读步「抽查 3 篇笔记」：就地挂三篇候选（StepFlow SpotCheckPicks）。按标题关键词识别，
 *  与付费墙/待确认同款口径（模板常量 SPOT_CHECK_TASK_TITLE）。 */
export function isSpotCheckTaskTitle(title: string): boolean {
  return title.includes("抽查");
}

export function isEndnoteTaskTitle(title: string): boolean {
  return title.includes("EndNote");
}

/** to-fetch.md 的条目计数——与 parseToFetchItems 同一口径（单一出处）：
 *  编号/列表行无链接也算，裸行须带「 — DOI/链接」尾巴。2026-09-16 修正：
 *  旧实现只数带符号的行，老项目裸行清单显示「缺 0 篇」而面板里条目明明在。 */
export function countToFetchEntries(text: string): number {
  return parseToFetchItems(text).length;
}

/** 还缺几篇：条目里去掉已勾 ✓ 的、去掉已对照上 papers/ 的（to_fetch_progress
 *  的行号 → 文件名映射；面板没开过时映射为空，只按 ✓ 算）。2026-09-17 审计：
 *  折叠按钮旧口径显示全部条目数，清单补了一大半后还写「缺 12 篇」，与展开
 *  面板的「已存 X/Y」自相矛盾 */
export function missingToFetchCount(
  text: string,
  doneByLine: Record<number, string>,
): number {
  return parseToFetchItems(text).filter((i) => !i.done && !doneByLine[i.line]).length;
}

/** 已存篇数：清单勾 ✓ 或对照上 papers/ 的都算。 */
export function toFetchSavedCount(
  items: ToFetchItem[],
  doneByLine: Record<number, string>,
): number {
  return items.filter((i) => i.done || Boolean(doneByLine[i.line])).length;
}

/** 已存条目对应的项目内相对路径。文件名来自 to_fetch_progress，只取末段。 */
export function toFetchPaperRel(fileName: string): string {
  const name = fileName.replace(/\\/g, "/").split("/").pop()?.trim() ?? "";
  return name ? `papers/${name}` : "";
}

/** 切走文件页会卸掉任务页：已存对照先记在进程内，回来第一帧不要全变成未获取。 */
const toFetchDoneMemo = new Map<string, Record<number, string>>();

export function rememberToFetchDone(
  root: string,
  map: Record<number, string>,
): void {
  toFetchDoneMemo.set(root, { ...map });
}

export function recalledToFetchDone(root: string): Record<number, string> {
  const hit = toFetchDoneMemo.get(root);
  return hit ? { ...hit } : {};
}

/** 从 to-fetch 行的 DOI/链接抽出可对照的 DOI；没有则 null。 */
export function doiFromToFetchUrl(url: string): string | null {
  const t = url.trim().replace(/^doi:\s*/i, "");
  const fromOrg = /(?:dx\.)?doi\.org\/(10\.\d{4,9}\/\S+)/i.exec(t);
  const raw = fromOrg?.[1] ?? (/^(10\.\d{4,9}\/\S+)$/i.test(t) ? t : "");
  if (!raw) return null;
  const doi = raw.replace(/[?#].*$/, "").replace(/[.,;)]+$/g, "").toLowerCase();
  return /^10\.\d{4,9}\/\S+$/i.test(doi) ? doi : null;
}

/** 库里已有对照 DOI 时才出确认文案；Zotero 没开不拦。 */
export function formatZoteroDuplicatePrompt(m: {
  reachable: boolean;
  present: number;
  total: number;
}): string | null {
  if (!m.reachable || m.present <= 0 || m.total <= 0) return null;
  return `Zotero 库里已有 ${m.present} 篇（对照清单 ${m.total} 个 DOI）。再导入可能重复。仍要打开 to-fetch.ris？`;
}

/** EndNote 没有本机查重接口。打开前确认篇数，取消则不交给 EndNote。 */
export function formatEndnoteOpenPrompt(count: number): string {
  if (count > 0) {
    return `把 papers/endnote-import.ris 交给 EndNote，约 ${count} 篇。库里已有的可能重复。仍要打开？`;
  }
  return "把 papers/endnote-import.ris 交给 EndNote？库里已有的可能重复。";
}

/** 「同步到 Zotero」结果：界面只留一句摘要，失败明细进悬浮。 */
export function formatZoteroAttachSummary(r: {
  attached: string[];
  created: string[];
  skipped: string[];
  missing: string[];
  unmatched: string[];
  failed?: string[];
}): { line: string; detail?: string } {
  const parts: string[] = [];
  if (r.attached.length) parts.push(`挂上 ${r.attached.length} 篇`);
  if (r.created.length) parts.push(`新建 ${r.created.length} 篇`);
  if (r.skipped.length) parts.push(`已有附件 ${r.skipped.length}`);
  if (r.missing.length) parts.push(`还没拿到全文 ${r.missing.length} 篇`);
  if (r.unmatched.length) parts.push(`无 DOI ${r.unmatched.length}`);
  if (r.failed?.length) parts.push(`失败 ${r.failed.length} 篇`);
  const line = parts.length ? parts.join(" · ") : "没有新东西可同步";
  const failed = r.failed ?? [];
  const detail = failed.length
    ? `${failed.slice(0, 3).join("；")}${failed.length > 3 ? " 等" : ""}`
    : undefined;
  return { line, detail };
}

/** to-fetch.md 单条待获取条目（lit-search 技能口径：`N. [✓ ] 标题 — DOI`） */
export interface ToFetchItem {
  /** 行号（1 起，条目身份键） */
  line: number;
  title: string;
  /** 末段的 DOI/链接（能逐篇「获取全文」的条目才有值） */
  url: string;
  /** 已补齐（编号后有 ✓） */
  done: boolean;
  /** 行里写出的期刊全称。DOI 后面再挂刊名、缩写时从这里取，不进 url。 */
  venue: string;
}

/** 从一段里取出能打开的 DOI 或 http 链接。刊名、缩写、OA 标记留在后面。 */
export function linkTokenFromSegment(segment: string): string {
  const marked = segment.match(
    /(?:https?:\/\/\S+|doi:\s*10\.\d{4,9}\/\S+|10\.\d{4,9}\/\S+)/i,
  );
  if (!marked) return "";
  return marked[0]
    .replace(/^doi:\s*/i, "")
    .replace(/[.,;）)]+$/g, "")
    .trim();
}

/** DOI 后面紧跟的期刊全称。缩写和〔OA〕不拿来对指标表。 */
export function venueFromSegment(segment: string, link: string): string {
  let rest = segment;
  if (link) {
    const at = rest.indexOf(link);
    rest = at >= 0 ? rest.slice(at + link.length) : rest;
  }
  rest = rest.replace(/〔[^〕]*〕/g, " ").replace(/\[[^\]]*\]/g, " ");
  rest = rest.replace(/^[\s—–\-]+/, "").trim();
  const cut = rest.split(/〔|\[/)[0]?.trim() ?? "";
  return cut;
}

/** 解析 to-fetch.md 的条目行，兼容三代格式（2026-09-16 放宽：老项目清单是裸行，
 *  只认编号会让旧格式解析出 0 条、回落纯文本预览，按钮整个不出现）：
 *  - 新（2026-09-15 规范）：`N. [✓ ] 标题 — DOI` 连续编号；
 *  - 旧列表符号：`- 标题 — DOI`；
 *  - 旧裸行：`标题 — DOI`（无编号无符号——必须带「 — DOI/链接」尾巴才认，挡住说明文字）。
 *  ✓ 记 done；末段不像 DOI/http 链接则 url 留空（获取钮不摆）。
 *  全空时调用方回落原文预览 */
/** 精读步补齐后写在标题前的标记：`[已补 2026-09-24]`、`[已补·全文已在项目根 …]`、`【已补】` */
const TO_FETCH_DONE_PREFIX = /^(?:\[|【)\s*已补[^\]】]*(?:\]|】)\s*/;

export function parseToFetchItems(text: string): ToFetchItem[] {
  const out: ToFetchItem[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? "").trim();
    // 条目开始后的分隔线（---）之后是别的内容（如精读汇总的「待跟进引用线索」），不是待获取
    //（2026-10-18 实测：42 条待获取 + 66 条线索被数成 108）
    if (out.length > 0 && /^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) break;
    const item = parseToFetchLine(line, i);
    if (item) out.push(item);
  }
  return out;
}

function parseToFetchLine(line: string, i: number): ToFetchItem | null {
  if (!line || line.startsWith("#")) return null;
  let body = line;
  let done = false;
  const numbered = /^(\d+)[.、)]\s+(✓\s*)?(.+)$/.exec(line);
  const bulleted = /^[-*+]\s+(✓\s*)?(.+)$/.exec(line);
  if (numbered) {
    done = Boolean(numbered[2]);
    body = numbered[3] ?? "";
  } else if (bulleted) {
    done = Boolean(bulleted[1]);
    body = bulleted[2] ?? "";
  }
  body = body.trim().replace(/^(?:\[\s*\]|【\s*】)\s*/, "");
  // 「[已补 …]」前缀：已补齐，标题里不带这段（带着会对不上 papers/ 里的 PDF）
  const donePrefix = TO_FETCH_DONE_PREFIX.exec(body);
  if (donePrefix) {
    done = true;
    body = body.slice(donePrefix[0].length).trim();
  }
  if (!body) return null;
  const segs = body.split(/\s+—\s+|\s+--\s+/);
  let url = "";
  let venue = "";
  let linkAt = -1;
  for (let s = 1; s < segs.length; s += 1) {
    const token = linkTokenFromSegment(segs[s] ?? "");
    if (!token) continue;
    url = token;
    venue = venueFromSegment(segs[s] ?? "", token);
    const next = (segs[s + 1] ?? "").trim();
    if (!venue && next && !linkTokenFromSegment(next)) {
      venue = venueFromSegment(next, "");
    }
    linkAt = s;
    break;
  }
  if (linkAt < 1) {
    // 编号/列表行没链接也保留（url 空占位）；裸行必须带链接尾巴才算条目
    if (!numbered && !bulleted) return null;
    return { line: i + 1, title: body, url: "", done, venue: "" };
  }
  // 标题 = 链接段之前的全部（标题内含「 — 」不丢字）
  const title = segs.slice(0, linkAt).join(" — ").trim();
  return { line: i + 1, title, url, done, venue };
}

/** 本步上次商量会话：活着的优先，否则最近一条。归档 / 无头不计。 */
export function pickDiscussResume<
  T extends {
    stepName?: string | null;
    archived?: boolean;
    internal?: boolean;
    live?: boolean;
    updatedAt?: string | null;
    agent: string;
    sessionId: string;
  },
>(sessions: readonly T[], stepName: string): T | null {
  const name = stepName.trim();
  if (!name) return null;
  const hits = sessions.filter(
    (session) =>
      !session.archived &&
      !session.internal &&
      session.stepName === name,
  );
  if (hits.length === 0) return null;
  const live = hits.find((session) => session.live);
  if (live) return live;
  return [...hits].sort((a, b) =>
    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
  )[0] ?? null;
}

/** 本步是否已经商量过：认 session_meta.stepName（「跟 AI 商量」认领后固化）。 */
export function stepHasDiscussSession(
  sessions: readonly {
    stepName?: string | null;
    archived?: boolean;
    internal?: boolean;
    live?: boolean;
    updatedAt?: string | null;
    agent: string;
    sessionId: string;
  }[],
  stepName: string,
): boolean {
  return pickDiscussResume(sessions, stepName) != null;
}
