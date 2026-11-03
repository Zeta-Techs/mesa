/**
 * 跟 AI 写我的任务（任务包第二期，design-task-packs.md §7.1）：开对话的种子提示词与检查结果的纯逻辑。
 * 包格式写在提示词里（不另装作者技能：格式只有一处真源，跟着这份文件走），规则与 task_packs.rs check_pack 对齐。
 */
import type { PackIssueDto } from "./types.ts";

export function buildPackAuthorPrompt(input: {
  name: string;
  intent: string;
  dirRel: string;
  packRel: string;
  anchors: readonly string[];
  userSkills: readonly string[];
}): string {
  const intent = input.intent.trim() || "（用户没写，先问清楚这件任务要解决什么、产出什么）";
  const userSkills = input.userSkills.length ? input.userSkills.join("、") : "（没有）";
  return `请帮我把一件课题组反复要做的科研任务写成 Mesa 的「我的任务」（任务包）草稿。

【任务名】${input.name}
【要做什么】
${intent}

先读懂我的意图和项目里现有的文件；我附的 SOP、方法学论文、样例数据如果在项目里，先读它们。拿不准的地方（研究范围、数据怎么取舍、要不要对外发送）先问我，一次只问一个，给建议。

【写在哪】只写草稿目录 \`${input.dirRel}/\`：
- \`${input.packRel}\`：任务包本体（格式见下）。文件里已有 [pack] 段，name 不要改。
- 需要专门的做法说明时，在 \`${input.dirRel}/skills/<技能名>/SKILL.md\` 写技能（YAML frontmatter 含 name、description；正文写何时用、读什么、做什么、完成标准）。技能名用小写英文和连字符。
不要改草稿目录以外的任何文件，不要安装技能，不要开工去做这件任务本身。

【pack.toml 格式】TOML，只能用下面这些字段：
\`\`\`toml
[pack]
id = "（已填，别改）"
name = "（已填，别改）"
description = "一句话：解决什么、产出什么"

[[params]]              # 每次会变的值，加进项目时人再填；没有就不写这段
key = "journal"         # 字母数字下划线连字符
label = "目标期刊"
value = "Nature"        # 默认值
help = "一句话说明"     # 可省
options = ["Nature", "Cell"]   # 有固定选项才写

[[steps]]               # 一步一段，按先后顺序
name = "数据质控"
workspace_name = "qc"   # 小写英文，可省
brief = """这一步交给 AI 的简报。会变的值写成 {param:journal}。点名内置技能写 {skill:data-clean}。"""
inputs = ["data/raw/counts.csv"]            # 必需输入（项目内相对路径）
optional_inputs = []                         # 有就读、没有也能做
expected_artifacts = ["analysis/qc.md"]      # 能证明这一步做完的入口文件，先写具体文件
acceptance_criteria = ["报告写明每个阈值和剔除的细胞数"]   # 评审时按什么看
decision_mode = "auto_continue"              # auto_continue / soft_pause / hard_pause
skills = ["data-clean"]                      # 这一步要用的技能
required_skills = ["data-clean"]

[[steps.decisions]]                          # 开工前就能拍板的选项题；第一个选项是推荐值
q = "细胞类型注释用哪个参考库"
options = ["CellTypist", "SingleR"]

[[steps.human_tasks]]                        # 只有人能做的事
title = "把测序原始数据放进 data/raw/"
target = "data/raw/"
timing = "before"                            # before / during / after

[[steps.checks]]                             # 可选：交付前要跑的核验脚本，脚本放在随包技能的 scripts/ 里
name = "qc-thresholds"                       # 小写英文、数字、连字符
skill = "sc-qc"                              # 脚本所在的技能
script = "scripts/qc_check.py"               # 技能目录里的相对路径
description = "阈值是否都写进报告、剔除数是否对得上"

[trigger]                                    # 可选：要不要按时间或有事时自动跑一个技能；不需要就别写
name = "新数据质控"
kind = "folder"      # schedule 按时间 / folder 目录落新文件 / radar 文献雷达采纳后 / phone 手机文件放进项目后
skill = "sc-qc"
folder = "{param:inbox}"   # 只有 folder 写；可以用参数
exts = ["h5"]
mode = "record"      # 事件先写 record（只记录、不叫 AI）。schedule 改写 frequency（daily/weekdays/weekly/hourly/manual）、hour、minute，weekly 加 weekday（1–7）
\`\`\`

【写好简报的规则】（Mesa 装库前会机器检查，违反的装不进去）
- 路径一律写项目内相对路径，不写绝对路径、不写 ..、不碰 .git 和 .ccode。
- 每一步都要有简报、具体的预期产物文件、至少一条验收条件。第二步起的必需输入最好是前面步骤的产物。
- 简报写清输入、做什么、交付什么；一步的文字控制在几千字内，细则放进技能。
- {skill:…} 只能写这些内置技能名：${input.anchors.join("、")}。本机已有的用户技能：${userSkills}（可以直接写进 skills）。
- 开工前就能定的选项写成 decisions；干到一半才知道要问的，简报里写明「写进 .ccode/help-wanted.md 问人」。研究范围、原始数据、合规、对外发送、花钱、改人写的内容、保护路径这七类必须停下来问人，简报不能叫 AI 跳过。
- 不写密钥、口令；不写要 Mesa 运行的代码。要跑的脚本放进技能目录，由 AI 在工作副本里跑。
- 核验脚本只做机器判得了的事（数字对不对得上、文件在不在、阈值有没有写进报告）；要读懂内容才判得了的（论断成不成立）别写成脚本。
  脚本接受 \`--root <工作目录> --out <结果文件>\`，结果一行一个 JSON：
  {"id":"Q1","kind":"qc","status":"blocked","title":"一句话","target":{"file":"analysis/qc_report.md","line":12},"evidence":{"detail":"依据"},"checker":"script:qc-thresholds","at":"<ISO 时间>"}。
  status 只有 passed / blocked / needs_human；Mesa 会把你脚本的 passed 显示成「待你判断」，blocked 进逐条裁决。脚本要能在 Windows 上跑（不用 bash 专有写法；Python 用标准库优先）。

写完告诉我写了哪些文件，等我在 Mesa 里点「检查」看结果、确认后装进我的任务。不要说已经装好。`;
}

/** 检查结果的一行说法：「质控：没有验收条件」 */
export function issueLine(issue: PackIssueDto): string {
  return issue.step ? `「${issue.step}」${issue.message}` : issue.message;
}

export function splitIssues(issues: readonly PackIssueDto[]): { blocks: PackIssueDto[]; warns: PackIssueDto[] } {
  return {
    blocks: issues.filter((i) => i.level === "block"),
    warns: issues.filter((i) => i.level === "warn"),
  };
}

/** 回对话接着改时发的话：把检查结果原样告诉 AI */
export function buildPackFixPrompt(packRel: string, issues: readonly PackIssueDto[], parseError: string | null): string {
  const lines = [
    ...(parseError ? [`- ${parseError}`] : []),
    ...issues.map((i) => `- ${i.level === "block" ? "【拦下】" : "【提醒】"}${issueLine(i)}`),
  ];
  return `Mesa 检查了 \`${packRel}\`：\n${lines.join("\n") || "- 没有问题"}\n请按这些改：拦下的必须改；提醒的按你的判断改或说明为什么不改。只改草稿目录里的文件，改完告诉我。`;
}
