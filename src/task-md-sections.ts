import { isSettingPlaceholder, uniqueRuleLines } from "./project-context.ts";

/** TASK.md「文献来源」段的单一出处：模板拼装（renderTaskMd）与就地同步（upsert）共用。
 *  独立成纯模块（不依赖 tauri API），供 node --test 直接覆盖。 */

/** 「文献来源」段的正文行。search/空 = 无此段（从零系统检索是默认行为，不必写进 TASK.md）。
 *  文献来自已有库时检索步骤的性质变了——不是「去检索」而是「盘点 + 查漏」，
 *  放在简报之前，让 Agent 先知道前提再读步骤简报（模板简报本身不必为此写两套） */
export function litSourceSectionLines(
  litSource: string | undefined,
): string[] | null {
  const v = litSource?.trim();
  if (v !== "zotero" && v !== "endnote" && v !== "folder") return null;
  const body =
    v === "zotero"
      ? "本项目的文献来自用户已有的 Zotero 库。导入：用「从 Zotero 导入」，PDF 留在原处，导入清单落 papers/imports/。同步：待获取清单上的「同步到 Zotero」。定稿同时交 output/endnote.docx 与 output/zotero.docx。"
      : v === "endnote"
        ? "本项目的文献来自用户已有的 EndNote 库。导入：把 EndNote 导出的 XML 或 RIS 放入 papers/imports/，开工时解析，不读 .enl。同步：待获取清单上的「同步到 EndNote」。定稿同时交 output/endnote.docx 与 output/zotero.docx。"
        : "本项目的文献来自用户已有的本地文件夹（见「项目资源」段）。EndNote 导出的 XML/RIS 也走这条，放入 papers/imports/ 后按题录解析。定稿同时交 output/endnote.docx 与 output/zotero.docx。";
  return [
    "## 文献来源",
    body,
    "因此涉及文献检索的步骤按「盘点 + 查漏补缺」执行，而不是从零系统检索：",
    "1. 先通读已有导入条目（papers/imports/ 与项目资源里的引文），全部并入 papers/included.json（不合适的标 pending、理由写「建议排除：…」交人定，不由 Agent 直接排除）；",
    "2. 只针对明显缺口做补充检索（近一年新工作、标准里要求但库中没有的方向），不重复已有条目；",
    "3. 题录在检索步经 scripts/lit_records.py enrich 统一补齐（无 DOI 或库里确无的字段标「待补」）；精读步再由同一脚本生成或补全 references.bib，已有条目不覆盖。",
  ];
}

/** 已存任务书里的「待确认的全局设定」跟着项目规则走。带括号或冒号后为空的留下，已填的删掉。 */
export function upsertPendingSettingsSection(
  text: string,
  settings: readonly string[],
): string {
  const pending = uniqueRuleLines(settings).filter((line) =>
    isSettingPlaceholder(line),
  );
  const section =
    pending.length === 0
      ? null
      : [
          "## 待确认的全局设定",
          ...pending.map((line) => `- ${line}`),
          "这些还没有由人确定。先逐项问人，说明括号里可以怎么填。开工前商量时人确定一项后，把项目根 .ccode/project.toml 的 settings 里对应那一行改成「名称：答案」；已开工的步骤工作区里经 .ccode/help-wanted.md 问人并在本步报告写明已定口径（不要在工作区直接改 .ccode/project.toml 免得合并冲突）。确定之前不得把括号里的提示当成已经决定的口径，也不得写进正文。",
        ];
  return replaceSection(text, "## 待确认的全局设定", section, [
    "## 文献来源",
    "## 上游已定方向",
    "## 已定方向",
    "## 决策暂停策略",
    "## 本步骤输入",
  ]);
}

function replaceSection(
  text: string,
  heading: string,
  section: string[] | null,
  insertBefore: string[],
): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  let end = -1;
  if (start >= 0) {
    end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].startsWith("## ")) {
        end = i;
        break;
      }
    }
  }
  if (!section) {
    if (start < 0) return text;
    lines.splice(start, end - start);
    return lines.join("\n");
  }
  if (start >= 0) {
    lines.splice(start, end - start, ...section, "");
    return lines.join("\n");
  }
  let at = lines.findIndex((line) =>
    insertBefore.some((marker) => line.startsWith(marker)),
  );
  if (at < 0) at = lines.length;
  lines.splice(at, 0, ...section, "");
  return lines.join("\n");
}

/** 把「文献来源」段就地同步进已有 TASK.md 内容（v3.90）：内容文件一旦被编辑/播种就是快照，
 *  项目配置里改文献来源不再自动反映——这段是改变检索步骤性质的硬前提，必须跟着配置走。
 *  有段替换、无段插入（优先「已定方向」/「预期产物」之前，与 renderTaskMd 相对位置一致；都没有则补到末尾）、
 *  search 时删除该段。无变化时原样返回（调用方据此判断是否写盘）。 */
export function upsertLitSourceSection(text: string, litSource: string): string {
  return replaceSection(text, "## 文献来源", litSourceSectionLines(litSource), [
    "## 上游已定方向",
    "## 已定方向",
    "## 预期产物",
  ]);
}

function extractH2Section(text: string, heading: string): string[] | null {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  while (end > start + 1 && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end);
}

const DYNAMIC_SECTION_ANCHORS: readonly {
  heading: string;
  insertBefore: string[];
}[] = [
  {
    heading: "## 项目规则",
    insertBefore: [
      "## 待确认的全局设定",
      "## 文献来源",
      "## 上游已定方向",
      "## 已定方向",
      "## 决策暂停策略",
      "## 步骤简报",
      "## 预期产物",
    ],
  },
  {
    heading: "## 待确认的全局设定",
    insertBefore: [
      "## 文献来源",
      "## 上游已定方向",
      "## 已定方向",
      "## 决策暂停策略",
      "## 本步骤输入",
      "## 预期产物",
    ],
  },
  {
    heading: "## 文献来源",
    insertBefore: [
      "## 上游已定方向",
      "## 已定方向",
      "## 决策暂停策略",
      "## 预期产物",
    ],
  },
  {
    heading: "## 上游已定方向",
    insertBefore: [
      "## 已定方向",
      "## 本步补充要求",
      "## 项目知识",
      "## 决策暂停策略",
      "## 预期产物",
    ],
  },
  {
    heading: "## 项目知识",
    insertBefore: [
      "## 研究档案（跨项目）",
      "## 决策暂停策略",
      "## 外部资料",
      "## 本步骤输入",
      "## 预期产物",
    ],
  },
  {
    heading: "## 研究档案（跨项目）",
    insertBefore: [
      "## 决策暂停策略",
      "## 外部资料",
      "## 本步骤输入",
      "## 预期产物",
    ],
  },
  {
    heading: "## 本步骤脚本",
    insertBefore: [
      "## 项目资源",
      "## 上一步产物（提货单）",
      "## 产物目录",
      "## 收尾",
    ],
  },
  {
    heading: "## 上一步产物（提货单）",
    insertBefore: ["## 产物目录", "## 收尾", "## 上游验收引用"],
  },
];

/** 把已有全文任务书草稿里的系统动态小节（项目规则、文献来源、上游已定方向、项目知识、研究档案、脚本、提货单）
 *  与最新模板拼装对齐，同时原样保留人在「已定方向」「本步补充要求」「待拍板」及简报里的编辑。
 *  assembled 不含二级标题时（如单测占位串）原样返回 draft。 */
export function syncDynamicTaskSections(
  draft: string,
  assembled: string,
): string {
  if (!/(?:^|\n)##\s+/.test(assembled)) return draft;
  let next = draft;
  for (const { heading, insertBefore } of DYNAMIC_SECTION_ANCHORS) {
    const fresh = extractH2Section(assembled, heading);
    next = replaceSection(next, heading, fresh, [...insertBefore]);
  }
  return next;
}
