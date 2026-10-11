/** 聊天层对长回复和待确认的整理。不改会话原文。 */

export interface ReplySection {
  title: string;
  body: string;
}

const HEADING = /^(#{1,3} .+|[^\n]{2,48}[：:])\s*$/;

/** 有两个以上小标题才折叠。否则整段照常显示。 */
export function splitReplySections(text: string): ReplySection[] | null {
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
  for (const line of lines) {
    // 围栏代码块（``` / ~~~，含列表里缩进 ≥4 空格的围栏）里的行不是小标题：
    // def foo():、YAML 键、# 注释都会误判
    if (/^[ \t]*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      body.push(line);
      continue;
    }
    if (!fenced && HEADING.test(line.trim()) && line.trim().length <= 48) {
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