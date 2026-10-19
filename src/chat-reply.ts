/** 聊天层对长回复和待确认的整理。不改会话原文。 */

export interface ReplySection {
  title: string;
  body: string;
}

const MD_HEADING = /^#{1,3}\s+\S/;
/** 冒号收尾的独立短行（「验收摘要：」「尚未验证：」这类报告小节）。
 *  句子里带句读、列表项、加粗开头的都是正文里的引子（「想象你去餐厅吃饭：」「它做的事是：」），
 *  当小标题会把下面的列表折走（2026-10-17 用户截图：解释 API 的回答被折成一串空标题）。 */
const COLON_HEADING = /^[^\s#>*\-+\d`|][^。！？.!?，,；;]{1,17}[：:]$/;

/** 回复够长才分节可折：短回答整段照常排版，折叠只帮长报告理结构 */
export const REPLY_FOLD_MIN_CHARS = 1500;

/** colonTitles = 冒号行也算小标题。回复里已经用 # 标题分节时不算：那时冒号行是正文里引出下文的话
 *  （2026-10-19 用户实测排版题：「标注语言的代码块示例如下：」被折成一节，把后面的代码块和引用收了进去） */
function isHeadingLine(line: string, colonTitles: boolean): boolean {
  const t = line.trim();
  if (MD_HEADING.test(t)) return t.length <= 64;
  return colonTitles && COLON_HEADING.test(t);
}

/** 长回复按小标题分节（两个以上才分）；短回复或标题不够返回 null，整段照常显示。 */
export function splitReplySections(text: string): ReplySection[] | null {
  if (text.length < REPLY_FOLD_MIN_CHARS) return null;
  const lines = text.split("\n");
  const sections: ReplySection[] = [];
  let title = "";
  let body: string[] = [];
  let fenced = false;
  const flush = () => {
    if (!title && body.every((line) => !line.trim())) return;
    sections.push({ title: title || "正文", body: body.join("\n").trim() });
    body = [];
  };
  let inFence = false;
  const hasMdHeading = lines.some((line) => {
    if (/^[ \t]*(?:```|~~~)/.test(line)) inFence = !inFence;
    return !inFence && MD_HEADING.test(line.trim());
  });
  for (const line of lines) {
    // 围栏代码块（``` / ~~~，含列表里缩进 ≥4 空格的围栏）里的行不是小标题：
    // def foo():、YAML 键、# 注释都会误判
    if (/^[ \t]*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      body.push(line);
      continue;
    }
    if (!fenced && isHeadingLine(line, !hasMdHeading)) {
      flush();
      title = line.trim().replace(/^#{1,3}\s+/, "");
      continue;
    }
    body.push(line);
  }
  flush();
  const titled = sections.filter((section) => section.title !== "正文");
  if (titled.length < 2) return null;
  return sections.filter((section) => section.title === "正文" ? section.body : true);
}

const FILE_MENTION =
  /(?:^|[\s`'"(（])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,8})/g;

/** 正文里像项目文件的相对路径。绝对路径和网址不算。 */
export function mentionedProjectFiles(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(FILE_MENTION)) {
    const raw = match[1];
    if (!raw || raw.startsWith("http")) continue;
    // git 状态里的路径没有 ./ 前缀，对齐后再比对
    found.add(raw.replace(/^\.\//, ""));
  }
  return [...found];
}

export interface ConfirmChoice {
  key: "y" | "n" | "esc";
  label: string;
}

/** 确认条上的按钮。登录/信任/菜单类提示不是批准题：不猜 y/n，去终端里自己选。
 *  词表保持克制——「选择」这类常见词会把真 y/n 确认题也误伤掉（2026-10-11 复核）。 */
export function confirmChoices(detail: string | null | undefined): ConfirmChoice[] {
  const text = detail ?? "";
  if (
    /登录|login|trust|信任|菜单|menu|select\b/i.test(text) &&
    !/permission|批准|权限|allow/i.test(text)
  ) {
    return [];
  }
  return [
    { key: "y", label: "批准" },
    { key: "n", label: "拒绝" },
  ];
}