/**
 * 定稿步「AI 写好、人来填」两份文件的结构化读写（2026-10-24 用户：打开清单、打开填写很不方便）。
 * 原先就地打开 Markdown 编辑：许可清单是 8 列表格，改一块状态要在竖线里找格子；投稿声明要自己认小标题。
 * 这里把它们拆成一行一块 / 一节一框，改完按原格式写回，AI 读到的还是同一份 Markdown。
 */

export const PERMISSION_STATUSES = ["待申请", "已申请", "已获许可", "无需申请"] as const;

export interface PermissionRow {
  /** 在文件里的行号（写回用） */
  line: number;
  figure: string;
  /** 原文（去掉 DOI 链接后的引文） */
  paper: string;
  doiUrl: string | null;
  label: string;
  publisher: string;
  licence: string;
  need: string;
  credit: string;
  status: string;
}

const LINK = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;

function cells(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|") || !t.endsWith("|")) return null;
  return t.slice(1, -1).split("|").map((c) => c.trim());
}

/** 许可清单表格逐行拆出来；认表头「| 图 | … | 状态 |」，表头和分隔行之后到表格结束 */
export function parsePermissionRows(text: string): PermissionRow[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const head = lines.findIndex((l) => {
    const c = cells(l);
    return c != null && c[0] === "图" && c[c.length - 1] === "状态";
  });
  if (head < 0) return [];
  const rows: PermissionRow[] = [];
  for (let i = head + 2; i < lines.length; i++) {
    const c = cells(lines[i]);
    if (!c) break;
    if (c.length < 8 || c[0] === "—") continue;
    const doiUrl = [...c[1].matchAll(LINK)].find((m) => m[2].includes("doi.org"))?.[2] ?? null;
    rows.push({
      line: i,
      figure: c[0],
      paper: c[1].replace(LINK, "").replace(/\s+/g, " ").trim(),
      doiUrl,
      label: c[2],
      publisher: c[3],
      licence: c[4].replace(LINK, "$1"),
      need: c[5],
      credit: c[6],
      status: c[c.length - 1],
    });
  }
  return rows;
}

/** 改一块的「状态」，只动那一行最后一格 */
export function setPermissionStatus(text: string, line: number, status: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const c = cells(lines[line] ?? "");
  if (!c) return text;
  c[c.length - 1] = status.trim();
  lines[line] = `| ${c.join(" | ")} |`;
  return lines.join(eol);
}

export interface DeclarationSection {
  heading: string;
  /** 给人看的中文名 */
  label: string;
  /** 空 = 还没填（文件里写的是「待填」） */
  body: string;
  /** 「待填（…）」括号里的填写提示 */
  hint: string;
}

const LABELS: Record<string, string> = {
  authors: "作者与单位",
  funding: "基金",
  "conflicts of interest": "利益冲突",
  "author contributions (credit)": "作者贡献（CRediT）",
  "ai use declaration": "AI 使用声明",
};

const PENDING = /^待填(?:[（(]([^）)]*)[）)])?\s*$/;

/** 投稿声明按「## 小标题」拆节；文件开头的说明不算一节 */
export function parseDeclarations(text: string): DeclarationSection[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: DeclarationSection[] = [];
  let cur: { heading: string; body: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const body = cur.body.join("\n").trim();
    const pending = PENDING.exec(body);
    out.push({
      heading: cur.heading,
      label: LABELS[cur.heading.toLowerCase()] ?? cur.heading,
      body: pending ? "" : body,
      hint: pending?.[1] ?? "",
    });
  };
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      cur = { heading: m[1], body: [] };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  flush();
  return out;
}

/** 按节写回：空的写「待填」（原来有提示的带上提示），其余原样；开头说明与小标题不动 */
export function writeDeclarations(text: string, sections: readonly DeclarationSection[]): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const first = lines.findIndex((l) => /^##\s+/.test(l));
  const preamble = (first < 0 ? lines : lines.slice(0, first)).join("\n").replace(/\s+$/, "");
  const parts = sections.map((s) => {
    const body = s.body.trim() || (s.hint ? `待填（${s.hint}）` : "待填");
    return `## ${s.heading}\n\n${body}`;
  });
  return [preamble, ...parts].join("\n\n").concat("\n").replace(/\n/g, eol);
}
