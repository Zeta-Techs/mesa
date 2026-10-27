/**
 * 「怎样算做完」给人看的写法（2026-10-27 工作台任务面板）：步骤的验收条件里混着 Mesa 自动核对的 `machine:` 条目
 * （语法见 workspaces.rs machine_acceptance_satisfied），原样摆出来是 `machine:count:notes/*.md>=1` 这类内部写法。
 * 这里把它们翻成一句白话、和人工条件分开；认不出的 machine 条目去掉前缀照写，不猜意思。
 */
export interface CriterionText {
  /** true = Mesa 自动核对的；false = 要人看的 */
  machine: boolean;
  text: string;
}

export function criterionText(raw: string): CriterionText {
  const c = raw.trim();
  if (!c.startsWith("machine:")) return { machine: false, text: c };
  const rule = c.slice("machine:".length);
  const [head, ...rest] = rule.split("::");
  const tail = rest.join("::");
  let m: RegExpMatchArray | null;
  if ((m = /^count:(.+?)>=(\d+)$/.exec(head))) {
    const except = /^except=(.+)$/.exec(tail)?.[1];
    return { machine: true, text: `${m[1]} 至少 ${m[2]} 个${except ? `（不算 ${except.split(",").join("、")}）` : ""}` };
  }
  if ((m = /^file:(.+)$/.exec(head))) return { machine: true, text: `有 ${m[1]}` };
  if ((m = /^glob:(.+)$/.exec(head))) return { machine: true, text: `有符合 ${m[1]} 的文件` };
  if ((m = /^contains:(.+)$/.exec(head))) {
    return { machine: true, text: !tail || tail === "—" ? `${m[1]} 不是空的` : `${m[1]} 里写了「${tail}」` };
  }
  if ((m = /^not-contains:(.+)$/.exec(head))) return { machine: true, text: `${m[1]} 里没有「${tail}」` };
  if ((m = /^records:(.+)$/.exec(head))) {
    return { machine: true, text: `${m[1]} 每一条都有 ${tail.split(",").join("、")}` };
  }
  if ((m = /^same-ids:(.+)$/.exec(head))) return { machine: true, text: `${m[1]} 与 ${tail} 的条目一一对应` };
  return { machine: true, text: rule };
}

/** 任务书里的 `{skill:lit-notes}` 占位写成「lit-notes 技能」 */
export function readableBrief(text: string): string {
  return text.replace(/\{skill:([\w-]+)\}(\s*技能)?/g, "「$1」技能");
}
