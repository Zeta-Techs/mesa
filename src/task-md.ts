import { litSourceSectionLines } from "./task-md-sections.ts";
import { decisionPolicyBlock } from "./step-decisions.ts";
import { RESOURCE_TYPE_LABELS } from "./pipeline-presets.ts";
import {
  effectiveProjectRules,
  isSettingPlaceholder,
  uniqueRuleLines,
} from "./project-context.ts";
import { stripOptionalTitlePrefix } from "./step-flow.ts";
import { resolveSkillRefs, type SkillProvides } from "./skill-slots.ts";
import type {
  ArtifactEntryDto,
  ProjectConfigDto,
  ProjectStepDto,
} from "./types.ts";

/** 只有 bash 才认的写法（quarto render 这类单条命令两边都能跑，不提示） */
function looksPosixShell(command: string): boolean {
  return /(?:&&|\|\||\bmkdir -p\b|\bcommand -v\b|\$\(|\bthen\b|\bfi\b|\bexport\b|>\s*\/dev\/null)/.test(command);
}

/** TASK.md 拼装单一出处：弹层预览与开工落盘共用。纯函数，不碰文件系统。
 *  isWindows 显式传参（纯逻辑模块不读平台）：只影响「本步骤脚本」给哪种写法 */
export function renderTaskMd(
  step: ProjectStepDto,
  cfg: ProjectConfigDto,
  projectPath: string,
  artifacts?: ArtifactEntryDto[],
  skillMeta?: Record<string, string>,
  providesByName?: SkillProvides,
  decisions?: { q: string; answer: string }[],
  isWindows = false,
): string {
  const projectRoot = projectPath.replace(/[\\/]+$/, "");
  const lines = [`# ${step.name}`, "", `项目根：\`${projectRoot}\``, ""];
  const topic = cfg.topic?.trim();
  if (topic) {
    lines.push("## 课题主题", topic, "");
  }
  const globals = effectiveProjectRules(
    cfg.settings,
    cfg.workMode,
    cfg.rulesOwned,
  );
  if (globals.length > 0) {
    lines.push("## 项目规则", ...globals.map((x) => `- ${x}`), "");
  }
  const pending = uniqueRuleLines(cfg.settings ?? []).filter((line) =>
    isSettingPlaceholder(line),
  );
  if (pending.length > 0) {
    lines.push(
      "## 待确认的全局设定",
      ...pending.map((line) => `- ${line}`),
      "这些还没有由人确定。先逐项问人，说明括号里可以怎么填。人确定一项后，把 .ccode/project.toml 的 settings 里对应那一行改成「名称：答案」，再按答案做。确定之前不得把括号里的提示当成已经决定的口径，也不得写进正文。",
      "",
    );
  }
  const litLines = litSourceSectionLines(cfg.litSource);
  if (litLines) {
    lines.push(...litLines, "");
  }
  if (decisions && decisions.length > 0) {
    lines.push(
      "## 已定方向",
      ...decisions.map((d) => `- ${d.q}：${d.answer}`),
      "",
      "以上为人已拍板的口径，按此执行；与简报冲突时以本节为准。",
      "",
    );
  }
  lines.push("## 决策暂停策略", decisionPolicyBlock(step), "");
  const inputs = (step.inputs ?? []).map((x) => x.trim()).filter(Boolean);
  const optionalInputs = (step.optionalInputs ?? [])
    .map((x) => x.trim())
    .filter(Boolean);
  const anyOfInputs = (step.anyOfInputs ?? [])
    .map((group) => group.map((x) => x.trim()).filter(Boolean))
    .filter((group) => group.length > 0);
  if (inputs.length > 0 || optionalInputs.length > 0 || anyOfInputs.length > 0) {
    lines.push(
      "## 本步骤输入",
      ...inputs.map((input) => `- 必需：${input}`),
      ...optionalInputs.map((input) => `- 可选：${input}`),
      ...anyOfInputs.map((group) => `- 任一：${group.join(" 或 ")}`),
      "按上述规则读取上游产物或项目资源；必需输入缺失时先在 .ccode/help-wanted.md 说明，不要猜测替代输入；可选输入缺失可继续，任一组满足一项即可。",
      "",
    );
  }
  const watched = [...inputs, ...optionalInputs, ...anyOfInputs.flat()];
  if (
    watched.some((path) =>
      /(?:^|\/)(?:gap-analysis|proposal|design)\.md$/.test(path.replace(/\\/g, "/")),
    )
  ) {
    lines.push(
      "## 已批准范围",
      "若上游有「## 已批准问题与范围」或「## 已批准设计」，只按其中状态为已批准的句子执行。没有该节，或状态不是已批准，候选问题与候选假设保持候选，不得写成已经确定。",
      "",
    );
  }
  lines.push(
    // {skill:锚名} 占位在此解析成实际挂载的技能名：换技能后正文指令跟随，
    // 不再与本步骤技能段打架；空缺锚保留原样（开工弹层的校验会提醒）
    resolveSkillRefs(
      step.brief.trim(),
      step.skills,
      providesByName,
    ).text ||
      "（在 .ccode/project.toml 的 steps.brief 中补充本步骤任务简报）",
  );
  if (step.expectedArtifacts.length > 0) {
    lines.push(
      "",
      "## 预期产物",
      ...step.expectedArtifacts.map((a) => `- ${a}`),
    );
  }
  // 简报点名的 run 脚本（「用本步骤 run 脚本 render-pdf」）在 Windows 上给出能跑的写法：脚本是 bash 写法，
  // 命令工具是 PowerShell 的 Agent（Codex 等）照抄会失败。macOS / Linux 的 Agent 本就在 bash/zsh 里，
  // 照旧从 .ccode/settings.toml 读，不占任务书篇幅
  const runScripts = isWindows
    ? (step.run ?? []).filter(
        (r) => r.name.trim() && r.command.trim() && step.brief.includes(r.name.trim()),
      )
    : [];
  if (runScripts.length > 0) {
    lines.push("", "## 本步骤脚本（Windows）", "简报里说「run 脚本 <名字>」时按下面的命令执行，在本工作区根目录运行：");
    for (const r of runScripts) {
      const win = r.commandWindows?.trim();
      if (win) {
        lines.push(
          `- ${r.name}`,
          `  - 命令工具是 PowerShell 时：\`${win}\``,
          `  - 命令工具是 Git Bash 时：\`${r.command.trim()}\``,
        );
      } else {
        lines.push(`- ${r.name}：\`${r.command.trim()}\``);
      }
    }
    if (runScripts.some((r) => !r.commandWindows?.trim() && looksPosixShell(r.command))) {
      lines.push(
        "没有给 PowerShell 写法的条目是 bash 写法，PowerShell 与 cmd 跑不了：用 Git Bash 执行（Git for Windows 自带，一般在 C:\\Program Files\\Git\\bin\\bash.exe），不要自己改写成别的写法。",
      );
    }
  }
  // Mesa 补的 PYTHONIOENCODING 遇 -I / -E 失效（隔离模式忽略全部 PYTHON* 环境变量），
  // 中文系统回落 GBK，打印 Č、² 即 UnicodeEncodeError（2026-10-22 实测：Claude Code 读外部数据时习惯加 -I）
  if (isWindows) {
    lines.push(
      "",
      "## 本机 Python（Windows）",
      "- 命令名用 `python`，不要用 `python3`（Windows 上的 `python3` 是应用商店占位程序，一运行就失败）。",
      "- 加了 `-I` 或 `-E` 时，Python 会忽略 Mesa 设好的 UTF-8 输出，打印中文或 Č、² 这类字符就报 `'gbk' codec can't encode`：这时同时加 `-X utf8`。它也会把 `open()` 的默认编码改成 UTF-8，读 GBK 文件要显式写 `encoding=\"gbk\"`。",
    );
  }
  if ((step.decisions?.length ?? 0) > 0) {
    lines.push(
      "",
      "## 决策摘要（先看方案，再由人决定）",
      "已有上游决策摘要则直接引用，不再抄写。缺少时在现有报告补：待决问题、可行方案、推荐及证据位置、代价/不确定性、等待边界。推荐不是批准；人可选方案、改范围或要求补证据，答案注明版本。",
      "仅探索/待补的决定不授权正式实验或强结论；不要让人凭空写保证。",
    );
  }
  const acceptanceCriteria = (step.acceptanceCriteria ?? [])
    .map((x) => x.trim())
    .filter(Boolean);
  if (acceptanceCriteria.length > 0) {
    lines.push(
      "",
      "## 验收条件",
      ...acceptanceCriteria.map((criterion) => `- ${criterion}`),
      "报告已生成与问题已解决分开；逐项核对，未核验如实记录，人工批准不得由 Agent 代填。",
    );
  }
  const humanTasks = step.humanTasks ?? [];
  if (humanTasks.length > 0) {
    lines.push("", "## 人工事项（由人完成，不要代做）");
    for (const h of humanTasks) {
      const when =
        h.timing === "before"
          ? "开始前"
          : h.timing === "after"
            ? "收尾"
            : "进行中";
      lines.push(
        `- [${when}] ${h.optional ? stripOptionalTitlePrefix(h.title) : h.title}${h.target ? ` → 交付落点 \`${h.target}\`` : ""}` +
          `${h.optional ? "（可选）" : "（必办）"}` +
          ` · 完成判定：${
            h.completion === "manual"
              ? "人工确认"
              : h.completion === "all"
                ? `全部目标满足${h.expectedCount != null ? `（${h.expectedCount} 项）` : ""}`
                : h.completion === "no_placeholders"
                  ? "清除占位后完成"
                  : h.completion === "decisions_cleared"
                    ? h.title.includes("审查报告")
                      ? "逐条决定后完成"
                      : "逐条裁决后完成"
                    : "落点出现"
          }`,
      );
    }
    lines.push(
      "上述事项由人完成；有文件不代表已获批准。缺少必要人工确认时暂停受影响操作，只可推进无依赖、可逆的准备。",
      "执行中若另需人协助，把请求逐条写进 .ccode/help-wanted.md（每条一行「- 」开头）；是否继续严格遵守本任务书的「决策暂停策略」。",
    );
  }
  if (step.skills.length > 0) {
    const required = new Set(step.requiredSkills ?? step.skills);
    lines.push("", "## 本步骤技能");
    for (const name of step.skills) {
      const prefix = required.has(name) ? "必需" : "可选";
      if (!skillMeta) {
        lines.push(`- ${prefix}：${name}`);
      } else if (name in skillMeta) {
        const desc = skillMeta[name];
        lines.push(desc ? `- ${prefix}：${name}：${desc}` : `- ${prefix}：${name}`);
      } else {
        lines.push(`- ${prefix}：${name}（未安装，可在技能页新建或导入）`);
      }
    }
    lines.push(
      "必需技能缺失时先记录帮助请求；可选技能缺失可继续，但不得假装已执行其检查。",
      "技能正文里的读取/产出路径若与本文件（预期产物、项目资源、验收条件）不一致，一律以本文件为准。",
      "写作红线以写作/渲染技能为准，即使本文件简报写了相反的话：不凑字数；禁止把「待绘制」当图；G1 不准进稿件；摘要不准出现 [待核实]；摘要级来源必须在句中降级；PDF 首页必须可读。不得把大纲或项目「目标篇幅」改写成必须凑到的词数，也不得把「文件非空」当成渲染通过。",
    );
  }
  const boundPaths = step.resources ?? [];
  const resources =
    boundPaths.length > 0
      ? cfg.resources.filter((r) => boundPaths.includes(r.path))
      : cfg.resources;
  if (resources.length > 0) {
    lines.push("", "## 项目资源（只读引用，勿复制到本工作区）");
    for (const r of resources) {
      const abs = /^([a-zA-Z]:[\\/]|\/)/.test(r.path)
        ? r.path
        : `${projectRoot}/${r.path}`;
      const label = RESOURCE_TYPE_LABELS[r.type] ?? r.type;
      lines.push(
        `- [${label}] ${r.name}：${abs}${r.readonly ? "（只读）" : ""}`,
      );
    }
  }
  const inputPatterns = [
    ...(step.inputs ?? []),
    ...(step.optionalInputs ?? []),
    ...((step.anyOfInputs ?? []).flat()),
  ]
    .map((x) => x.trim().replace(/\\/g, "/"))
    .filter(Boolean);
  const wildcardMatches = (value: string, pattern: string) => {
    if (pattern.endsWith("/")) {
      const dir = pattern.replace(/\/+$/, "");
      return value === dir || value.startsWith(`${dir}/`);
    }
    const escaped = pattern.replace(/[.+^${}()|[\\]\\\\]/g, "\\$&");
    return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`).test(value);
  };
  const scopedArtifacts =
    inputPatterns.length === 0
      ? artifacts ?? []
      : (artifacts ?? []).filter((artifact) => {
          const path = artifact.path.replace(/\\/g, "/");
          const root = projectRoot.replace(/\\/g, "/");
          const relative = path.startsWith(`${root}/`)
            ? path.slice(root.length + 1)
            : path;
          const base = relative.split("/").pop() ?? relative;
          return inputPatterns.some(
            (pattern) =>
              wildcardMatches(relative, pattern) || wildcardMatches(base, pattern),
          );
        });
  if (scopedArtifacts && scopedArtifacts.length > 0) {
    lines.push("", "## 上一步产物（提货单）");
    for (const a of scopedArtifacts) {
      lines.push(
        `- ${a.name}：${a.path}（md5 ${a.hash.slice(0, 8)}，来自「${a.producedBy}」）`,
      );
    }
    lines.push(
      "产物文件按路径直接读取，勿复制；新产物请通过改动面板登记进提货单。",
    );
  }
  if (cfg.artifactDir?.trim()) {
    const artifactRel = cfg.artifactDir.replace(/^[/\\]+/, "").replace(/[/\\]+$/, "");
    lines.push(
      "",
      "## 产物目录",
      `大型派生产物（清洗后数据、实验原始结果、渲染成品）写入本工作区的 \`${artifactRel}/\` 或 \`output/\`（相对路径），不进 git；评审合并进主仓时自动带到项目根同名目录。`,
      `文献 PDF 是外部获取的原始资料，直接写入 \`${projectRoot}/papers/\`（项目根绝对路径），不进 git。`,
      "清单/摘要里记录产物一律用项目根相对路径（如 artifacts/xxx.csv），不要写本工作区绝对路径。本工作区只提交源稿、脚本与清单。",
      // 2026-10-22 实证：检索步把 14 个脚本写进 artifacts/，收尾提交不了又整体搬家
      `要提交、能重跑出产物的脚本放简报指定的位置，简报没指定就放 \`scripts/\`（进 git）；\`${artifactRel}/\` 不进 git，只放一次性调试脚本和接口缓存。`,
    );
  }
  lines.push(
    "",
    "## 收尾",
    "达到完成标准后再把剩余源稿、脚本与清单全部提交——不提交，系统会认为这一步仍在进行中。中途提交只存档，停工门见上文「决策暂停策略」。",
    "派生产物只写本工作区产物目录（评审合并后自动进项目根对应目录）；文献 PDF 写项目根 papers/。绕开这两条（例如派生产物直写项目根）的产物属于未验收产物，不保证保留。",
  );
  return `${lines.join("\n")}\n`;
}
