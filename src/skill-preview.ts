/**
 * 技能页预览面板：SKILL.md 拆成「frontmatter 字段 + 正文」，正文按 Markdown 渲染。
 * 原先整份文件塞进一个等宽 <pre>，YAML 头和正文挤在一起、标题列表全是原始符号。
 * 只做展示拆分，不校验、不改写文件。
 */
export interface SkillFrontField {
  key: string;
  value: string;
}

/** 顶层 `key: value`；缩进续行、`|`/`>` 块和 `- item` 列表并进上一个键（空格连接）。 */
export function splitSkillFrontmatter(text: string): {
  fields: SkillFrontField[];
  body: string;
} {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (!m) return { fields: [], body: normalized };
  const fields: SkillFrontField[] = [];
  for (const line of m[1]!.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (top) {
      fields.push({ key: top[1]!, value: cleanValue(top[2]!) });
      continue;
    }
    const last = fields[fields.length - 1];
    if (!last) continue;
    const part = cleanValue(line.trim().replace(/^-\s+/, ""));
    if (part) last.value = last.value ? `${last.value} · ${part}` : part;
  }
  return { fields, body: normalized.slice(m[0].length).replace(/^\n+/, "") };
}

function cleanValue(raw: string): string {
  const v = raw.trim();
  if (v === "|" || v === ">" || v === "|-" || v === ">-") return "";
  // YAML 行内数组「[a, b]」展示成「a · b」（截图实例：outputs [analysis/, figures/, …]）
  const flow = /^\[([\s\S]*)\]$/.exec(v);
  if (flow) {
    return flow[1]!
      .split(",")
      .map((item) => unquote(item.trim()))
      .filter(Boolean)
      .join(" · ");
  }
  return unquote(v);
}

function unquote(v: string): string {
  const quoted = /^(["'])([\s\S]*)\1$/.exec(v);
  return quoted ? quoted[2]! : v;
}
