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
      ? "本项目的文献来自用户已有的 Zotero 库。导入：用「从 Zotero 导入」，首次题录见 references.bib，PDF 留在原处。同步：待获取清单上的「同步到 Zotero」。定稿同时交 output/endnote.docx 与 output/zotero.docx。"
      : v === "endnote"
        ? "本项目的文献来自用户已有的 EndNote 库。导入：把 EndNote 导出的 XML 或 RIS 放入 papers/imports/，开工时解析，不读 .enl。同步：待获取清单上的「同步到 EndNote」。定稿同时交 output/endnote.docx 与 output/zotero.docx。"
        : "本项目的文献来自用户已有的本地文件夹（见「项目资源」段）。EndNote 导出的 XML/RIS 也走这条，放入 papers/imports/ 后按题录解析。定稿同时交 output/endnote.docx 与 output/zotero.docx。";
  return [
    "## 文献来源",
    body,
    "因此涉及文献检索的步骤按「盘点 + 查漏补缺」执行，而不是从零系统检索：",
    "1. 先通读已有条目，按本步骤的纳入/排除标准逐条判定，产出筛选记录；",
    "2. 只针对明显缺口做补充检索（近一年新工作、标准里要求但库中没有的方向），不重复已有条目；",
    "3. 已有条目的元数据以 references.bib 为准，不要重新编造；缺字段标「待补」。",
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
          "这些还没有由人确定。先逐项问人，说明括号里可以怎么填。人确定一项后，把 .ccode/project.toml 的 settings 里对应那一行改成「名称：答案」，再按答案做。确定之前不得把括号里的提示当成已经决定的口径，也不得写进正文。",
        ];
  return replaceSection(text, "## 待确认的全局设定", section, [
    "## 文献来源",
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
    "## 已定方向",
    "## 预期产物",
  ]);
}
