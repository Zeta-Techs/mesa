import type { HumanTaskDto, ProjectStepDto } from "./types";
import {
  DRAFT_EVIDENCE_DEFAULT,
  KEEP_WORKING_CLAUSE,
} from "./step-decisions.ts";

/**
 * 内置流水线模板库（§11.3 机制二、§11.4 P1b 首启引导轻量版）：
 * 步骤是写在 project.toml 里的可编辑预设，引擎不识别「文献/论文」语义。
 * 六套内置模板覆盖综述/科研论文/数据处理/毕业论文/投稿与返修/LaTeX 论文，新增场景 = PIPELINE_TEMPLATES 加一项；
 * 用户另存的模板由后端 list/save/delete_pipeline_template 管理，选择器中与本库合并展示。
 *
 * 简报写作约定（低风险准备可继续，科研决定不得以沉默代替同意）：
 * - 输入写死：明确引用上一步产物路径（合并进 main 后新工作区自带），不让 Agent 猜；
 * - 决策分层：可逆整理给默认值；问题、证据、口径、授权由人确认，未知允许阻塞。
 * - 交付写死：产物路径、格式、完成标准逐项列出，与 expectedArtifacts 对应。
 * v1 只写模板骨架；演示数据与示例 PDF 属完整版首启引导，本批不做。
 */
export interface PipelineTemplateDef {
  id: string;
  name: string;
  description: string;
  steps: ProjectStepDto[];
  /** 这套流程带给 Agent 的纪律。按模板内容写，不与工作方式默认条混用。 */
  projectRules?: string[];
  /** 全局设定的建议项（v3.89）：贯穿全程的决定——应用模板时预填进项目层，
   *  而不是塞进某一步的决策项（那属层级错配：它们决定后面每一步）。
   *  没填的保留「名称：（提示）」占位，人在项目设置里改，或让商量时的 Agent 问完再改。
   *  占位不写进 TASK.md。 */
  projectSettings?: string[];
}

/** 应用模板时写入 settings：本模板纪律 + 全局设定。没填的保留模板里的占位行。 */
export function settingsForTemplateApply(
  tpl: Pick<PipelineTemplateDef, "projectRules" | "projectSettings">,
  filled?: readonly (string | undefined)[],
): string[] {
  const rules = (tpl.projectRules ?? [])
    .map((line) => line.trim())
    .filter(Boolean);
  const globals: string[] = [];
  for (const [i, line] of (tpl.projectSettings ?? []).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const answer = filled?.[i]?.trim();
    const sep = trimmed.indexOf("：") >= 0 ? "：" : trimmed.indexOf(":") >= 0 ? ":" : "";
    const q = sep ? trimmed.slice(0, trimmed.indexOf(sep)).trim() : trimmed;
    if (!q) continue;
    globals.push(answer ? `${q}：${answer}` : trimmed);
  }
  return [...rules, ...globals];
}

export type SubmissionMode = "initial" | "revision";

const LIT_SEARCH_ARTIFACTS = [
  "papers/screening.md",
  "papers/included.md",
  "papers/included.json",
  "papers/to-fetch.md",
  "papers/to-fetch.ris",
  "papers/endnote-import.ris",
  "papers/zotero-sync.md",
];

const MANUSCRIPT_FINALS = [
  "manuscript/paper-final.md",
  "manuscript/review-final.md",
  "manuscript/thesis-final.md",
];


/** 初稿正文字体：开工时问，写在本步工作区。商量会话只改任务书，不能写这些文件。 */
const DRAFT_TYPEFACE =
  "正文字体在第一次渲染前问人一次：默认英文 Times New Roman、中文宋体，人可以改这两个名字。这是一次决定，不要另开话题。按回答运行 {skill:quarto-render} 技能的 scripts/manuscript_font.py，写入 YAML 的 mainfont 和 CJKmainfont，并生成 manuscript/reference.docx 与 manuscript/typeface.md。不要先渲完再重渲。PDF 用 xelatex。Word 必须加 --reference-doc manuscript/reference.docx。本机没有这套字体就停下来说明，不要改用别的字体。";

/** 科研质量门复用文字，不增加编排层；报告状态不替代人的验收。 */
const QUALITY_STATUS =
  "验收摘要放在本步主要报告开头（不另建报告）：① 回答了什么；② 关键证据/复现入口；③ 尚未验证；④ 影响结论的未决问题；⑤ 需要人决定什么。摘要引用正文位置，不抄长报告。质量状态与未决事项统一在此维护：已生成待审 / 有条件接受（仅可准备）/ 证据通过（限定范围）/ 阻塞；问题记责任人、影响、处置证据和复核人。Agent 不能代填人工批准；文件、Git 合并、final 名称不等于质量通过。关键真实性/方法/引用支持/授权缺口不能仅移入局限放行。数据/方法/来源改变时在原报告记失效文件、版本与重验结果，未经重验不得复用旧结论；无变化写无。重要结论必须指向本步要读的文件；对不上标 [待核实]、[待补实验]、[待确认]、[推测] 或「仅摘要」，不得补成已验证事实。后一步不得把前一步的推测写成已证实结论。做完只记「已生成待审」，证据通过只由人写下。\n";

/** 分析结果里可被后文引用的结论。状态只有人能改成已认可。 */
const CLAIM_ENTRIES =
  "主要结论另写固定小节「## 结论条目」，每条一行：`- C001 | 结论一句话 | 来源：路径或 [@键] 或原文位置 | 强度：支持/部分支持/不足 | 状态：待审`。编号稳定，不重排已有编号。状态只有人改成「已认可」或「撤回」。后文只能使用「已认可」；对不上的句子标 [待核实] 或 [待补实验]。\n";

/** 人拍板后的问题与范围，供后续任务书引用。 */
const APPROVED_QUESTION =
  "在本步主报告写固定小节「## 已批准问题与范围」：问题一句话、纳入范围、明确不纳入、批准状态（已批准或未批准）。人还没拍板就写未批准。没有该节，或状态不是已批准，后文不得把候选写成已定问题。\n";

/** 假设、主指标、停止规则收成可引用条目。 */
const APPROVED_DESIGN =
  "在 design.md 写固定小节「## 已批准设计」：假设编号（H1 起）、主指标、停止规则、批准状态（已批准或未批准）。执行和分析只对着这些编号。未批准的假设保持候选。\n";

/** 一份稿上的章节状态和允许集，不拆成多个写作步骤。 */
const SECTION_STATUS =
  "动笔前写 manuscript/section-status.md，不另建章节任务。文首「## 允许集」列出 references.bib 的键、状态为已认可的结论编号、结果表里出现过的数字。每一节再写：要回答什么、用哪些材料或结论编号、还缺什么、审核状态（已生成待审 / 有条件接受 / 证据通过（限定范围） / 阻塞）。正文新出现的键、结论或数字必须在允许集中，否则标 [待核实] 或 [待补实验]。\n";

/** 会改已有成稿的步骤：先报告，人决定后才改。 */
const REVIEW_FIRST =
  "本步分两轮，禁止边查边改已有成稿。第一轮只写审查报告，不改稿件正文。报告用三节：## 严重问题、## 一般问题、## 建议。每条从 R001 编号，单独成段，写明位置、问题、类别（事实/引用/逻辑/数据/写作）。没有的节写无。人在步骤上逐条点接受、拒绝或修改，写在该条末尾一行「决定：接受」「决定：拒绝」或「决定：修改：<说明>」。看不到这些决定就停止，不写出定稿。第二轮只改接受或要求修改的条目。数字、因果、样本、结论范围的改动写入 changelog 的「科学改动」；措辞另列。未接受的条目不得改科学内容。\n";

/** 定稿步怎么问引用样式。三套稿共用这一句，避免论文/学位论文又写回「没有就问刊名」。
 *  人没换样式就按初稿编号渲；只有确认了期刊才写 submission/target-journal.md。 */
const STYLE_AT_FINAL =
  "开工先问引用格式：沿用初稿的编号制，还是改成目标期刊。已有 submission/target-journal.md 且写了刊名就报出刊名；沿用编号就不要写这份文件。人要换期刊再问刊名，确认后才写入 submission/target-journal.md，不要自行假定，也不要为了交付检查写一份空的。换期刊时读该刊作者须知，并从 references.bib 取该刊最近 2–3 篇综述，核对正文引用和文末文献表；库里没有就写明，须知和这几篇不一致就停下来问。";

/** 人在 EndNote 里改过的 Word，由 Agent 读回，确认后才改源稿。 */
const ENDNOTE_SYNC =
  "人在 EndNote 里改过 output/endnote.docx 或 manuscript/source.docx 之后，运行 {skill:endnote-bridge} 的 scripts/sync_docx.py，只写 papers/endnote-sync-report.md。人把每条决定写成接受或拒绝。接受的删除才从源稿去掉对应 [@键]；接受的新文献才追加进 references.bib，缺字段标待补。正文要补的引用等人指出位置再写。Export Traveling Library 在 Word 的 EndNote 菜单里，把这篇的文献抄进自己的库；Agent 不代点。\n";

function styleChoiceTask(): HumanTaskDto {
  return {
    title: "更换引用样式",
    // 空落点 = 纯脑力事项：形式在流程线行内选，不交文件。
    target: "",
    guidance:
      "开工先问：沿用初稿的编号制，还是改成目标期刊。沿用编号就不要写 submission/target-journal.md。换期刊时读该刊作者须知，并从 references.bib 取该刊最近 2–3 篇综述核对实际排法；库里没有就写明。确认了期刊才写入 submission/target-journal.md，不要为了交付检查写一份空的。选定后重渲 PDF 和普通 Word，并重新生成 output/endnote.docx 与 output/zotero.docx。LaTeX 不生成这两份。",
    timing: "after",
    completion: "manual",
  };
}

function endnoteSyncTask(): HumanTaskDto {
  return {
    title: "决定 EndNote 同步项",
    // guidance 是人看的人工事项文案，不走 renderTaskMd 的占位解析——
    // 先把 {skill:锚名} 解析成锚名可读形态（同 resolveSkillRefs 的空缺兜底语义）
    guidance: ENDNOTE_SYNC.trim().replace(/\{skill:([a-z0-9-]+)\}/g, "$1"),
    target: "papers/endnote-sync-report.md",
    timing: "after",
    optional: true,
    completion: "manual",
  };
}

function reviewDecisionTask(target: string): HumanTaskDto {
  return {
    title: "逐条决定审查报告",
    guidance:
      "报告写出来后，在这一行逐条点接受、拒绝或修改。点完会回到原来的对话，按决定继续改稿。拒绝的不改。",
    target,
    timing: "after",
    completion: "decisions_cleared",
  };
}

/** 精读步 TASK 合同。写法细节以 lit-notes 技能为准；此处堵住「每篇都有文件=完成」。 */
const LIT_NOTES_WRITE =
  "写法见 {skill:lit-notes} 技能。叙述用中文，材料名/离子/电解液/方法缩写/图表编号等惯用英文原词保留，不强翻。" +
  "禁止整段粘贴英文摘要或 PDF 抽取原文。未读完只在 notes/index.json 记 reviewStatus=pending、notePath 可空，禁止生成八段占位文件（文件存在会被标成已读）。" +
  "可逆准备只含 PDF 改名、index 骨架、bib 对账、合法 OA 尝试，不包括批量生成笔记正文。" +
  "「按摘要记」= 根据摘要消化来写并标「仅摘要」，不是贴英文。" +
  "分批读写时每批已读的写真笔记、可中途 git 提交；提交后立刻继续：先写完已确认核心篇（有 PDF 的写精读），再按摘要写完非核心，不要每批停下来等人。" +
  "有全文的笔记在可引用点末列可引用图（Fig./Table 编号｜画了什么｜可拼或仅引用）。图号和图注以 PDF 文本层为准，不要求把页面渲成图片再看。仅摘要写无可引用图，不臆造图号。" +
  "pending 只留给待确认、或摘要和题录都不足以写笔记的篇，不是「先写一批再汇报」的许可。\n";

const LIT_NOTES_INDEX_RECORDS =
  "machine:records:notes/index.json::id,bibKey,fulltextStatus,reviewStatus";

const QUESTION_GATE =
  "G1 问题与可行性：在候选报告中比较回答后改变什么认识、最邻近证据/反例、可区分解释、资料依赖、总预算和最小可回答范围、继续/缩题/停止判据。允许负结果与证据不足，不以热点/gap 数量选题。先给决策摘要：待决问题→可行方案→推荐及证据位置→代价/不确定性→等待边界；无合理备选也说明，不凑选项。未回复只做可逆摸底，不锁定问题；不会判断交导师/方法专家。\n";

const DESIGN_GATE =
  "G2 设计与分析计划：design.md 固定版本/日期与已看过的数据/结果，写分析单元、主比较/指标、有意义效应或精度、样本量/对照、缺失剔除、停止规则、风险与备选方案。预设与探索分开；预测研究所有拟合型预处理仅在训练折学习，按个体/时间/机构划分评价边界，不以测试结果选模型；因果研究写识别假设和替代解释，其他形态使用相应规范。\n" +
  "设计摘要给方案、推荐证据、总成本/依赖及待人批准的版本/范围；必要伦理/许可注明依据或不适用理由。换数据、指标、清洗、样本、矩阵、停止规则先记已见结果和影响，获人批准才改；{skill:stats-check} 关键问题未关闭不得正式运行。\n";

const EXECUTION_GATE =
  "G3 数据与实现：最小试验先核对样本单位、数据流、指标已知答案或独立实现、基线和泄漏，不只测速；results/implementation-check.md 记录命令、预期/实测、容差及修复。未通过不扩规模，裁剪回 G2，不按易完成/结果好坏挑组合。\n" +
  "results/run-manifest.json 每个计划 id 一条，含 dataHash、codeVersion、environment（锁定依赖/硬件）、command（配置/随机种子）、status、outputs（路径/哈希或失败日志）、运行时间与重试；未运行/取消记 not-run 和批准依据，不伪造命令/结果。results/matrix.json 与计划全部 id 对账；新增先改计划。每次输出独立目录，不覆盖旧运行；非 Git 材料记版本、备份/恢复与可迁移路径。交付 experiments/reproduce.py：项目专用入口，明确 --input/--output；前 40 行声明 # MESA_REPRODUCE: {\"interpreter\":\"python\",\"outputPlacement\":\"independent\",\"resultFile\":\"verification.json\"}；输出 verification.json 含 ok 布尔值、checks 数组（逐项 expected/actual/tolerance/passed）及 inputVersion，未验证不得写 ok=true；从冻结输出重建主要结果，核对 manifest 哈希和已接受参考值/容差，失败非零退出；先实际执行，再在 implementation-check.md 记录命令。入口不自动重跑昂贵/需授权的实验，环境与重跑限制说明。\n";

const EVIDENCE_GATE =
  "G4 证据与结论：核对计划/运行/结果覆盖，从冻结输出重建主表图；关键指标至少用手算样例/独立实现复算，统计报告记命令、输入/代码/环境版本、预期/实测、容差与未覆盖范围。同脚本重跑只证计算复现。按设计检查合理替代分析、异常处理影响与适用边界；发现于同一数据的关系不得仅补 p 值就升级确证，不足则保留探索性。\n" +
  "findings/结果章维护主要论断—证据表：论断→原始输出或文献原文位置→支持范围/强度→反证/未决。事实/假设/推测/结论分开，不显著不证明无效，摘要-only 不支撑摘要外细节。必要独立检查由人指定，从原始材料核对、不先看第一份答案；分歧凭证据由人裁决，不多数投票。\n";

const RELEASE_GATE =
  "G5 投稿就绪：主要论断必须有支持性核验，核对关键复算和授权；仅标记问题不算关闭，补证据/经人确认撤回或缩窄主张/阻塞。复用上游有效检查，只复核变更及缺口，不重做无变化劳动。人核对最终版本、共同作者同意/贡献、利益资助、AI 使用披露、数据代码可用性和期刊政策；不得代签/自动发布。现有终审清单附归档：计划偏离、数据代码环境、复现入口、稿件图表哈希、备份恢复、访问限制和实际回执（未提交如实记）。发表后重要错误交人决定更正/撤回，不静默替换。\n";

function mcpLitSearchTask(): HumanTaskDto {
  return {
    title: "配置学术检索 MCP",
    guidance:
      "Consensus 在 MCP 页填 API 密钥即可，不必自己设环境变量。本机已配置时可跳过。Undermind 要先在终端登录，授权后新开检索会话；点「开始」会直接检索。不配也能用 OpenAlex。标准档不把 Semantic Scholar 当发现库。",
    target: "",
    timing: "before",
    optional: true,
    completion: "manual",
  };
}

function pendingConfirmTask(): HumanTaskDto {
  return {
    title: "核对待确认篇目",
    guidance:
      "展开后上面是待确认，下面是已纳入。待确认点纳入或排除；已纳入不想要就点移出。移出只改这一步的清单、纳入行和待获取，笔记与引文留着。没有待确认可跳过。",
    target: "",
    timing: "after",
    optional: true,
    completion: "manual",
  };
}

function paywallPdfTask(timing: "after" | "during" = "after"): HumanTaskDto {
  return {
    title: "下载付费墙文献全文",
    // 首句动作导向（2026-09-15 用户实测原首句「拿到全文后…」让人不知从哪下手）：
    // 第一步是看清单，入口就挂在本行（StepFlow 的「待获取」折叠就地展开）
    guidance:
      "只补已纳入、缺 PDF 的篇目，落到项目根 papers/。待确认先拍板，不要先下。不想补可跳过——下一篇按摘要记。",
    target: "papers/*.pdf",
    timing,
    optional: true,
  };
}

function litSearchHumanTasks(): HumanTaskDto[] {
  return [mcpLitSearchTask(), pendingConfirmTask(), paywallPdfTask("after")];
}

/** 待获取 RIS 分两份。Zotero 与 EndNote 认的标签不同，不要写成同一套。
 *  接在「把 to-fetch.md 转成」后面，所以开头必须是两份 RIS 的文件名，不能以「题录」起句。 */
const TO_FETCH_RIS =
  "两份 RIS（papers/to-fetch.ris 与 papers/endnote-import.ris）。" +
  "同一批已纳入、缺全文的篇目，题录写入 included.json；pending 只留 included.json，不进这两份 RIS，也不进 to-fetch.md。" +
  "有 DOI 时先向 Crossref 取正式字段。标题用 Crossref 的 title，里面的 <sub> <sup> 收成 Unicode 再写入；不要用 OpenAlex 的 display_name 覆盖。摘要和关键词没有再问 OpenAlex。期刊缩写用 ISO 4、每个缩写词后加句点（Adv. Mater.），按期刊全称查，不要用 NLM 的 ISSN 结果（不带句点，还会对错刊）。表里没有、或现有缩写是全称、缺句点、对不上全称的，写成「待补」，再按期刊官网或 ISO 4 补上；一词刊名（Nature、Small）不缩。不要自己编。纳入时不再另查。" +
  "papers/to-fetch.ris 给 Zotero，RIS 2004、CRLF，与 to-fetch.md 同序。每篇 TY - JOUR，AU 每位作者单独一行（姓, 名）。" +
  "期刊全称只写 T2，缩写与全称不同才写 J2。再写 PY、VL、IS、SP 起始页、EP 结束页、SN、DO、KW 每个关键词一行、AB、UR。" +
  "不要写 JO、JF、JA、N1、N2、M1。Zotero 会把 JO 放进期刊缩写，把 N1 放进笔记。" +
  "papers/endnote-import.ris 给 EndNote 2025 的 RefMan RIS，同一批篇目、CRLF。期刊全称只写 T2，缩写写 J2。" +
  "页写 SP，起始页码另写一条 M2（与 SP 同值），结束页写 EP，文章类型写 M3（没有就写 Journal Article）。" +
  "再写 PY、DA、ET、VL、IS、SN、DO、KW、AB、LA、UR。不要写 JO、JF、JA、M1、N1、N2。" +
  "两份都不写筛选日期、候选来源、出版商、关键词来自哪个库。登记库没有的标签不写，不编造，不拿卷或页去填空着的期。";

/** 检索步：pending 必须先经人确认，才能进 to-fetch / 下载全文。 */
const LIT_PENDING_BEFORE_FETCH =
  "全文获取只针对 decision=included：开放获取下载到项目根 papers/；付费墙写入 to-fetch.md / to-fetch.ris。" +
  "**禁止把 pending 写入 to-fetch.md，也不得下载其全文。**" +
  "pending 的 venue 与 included 一样写期刊全称：有 DOI 先向 Crossref 取 container-title，没有再问 OpenAlex；书章没有期刊才写「待补」。不得因未拍板就把 venue、doi、url 留空。" +
  "若 included.json 仍有 pending：把待确认篇目（标题+理由）写入 .ccode/help-wanted.md 请人逐篇纳入或排除" +
  "（未回复不把 pending 当已纳入、不进待获取），只推进已纳入篇目的全文获取。pending 经人改成 included 后才允许补进 to-fetch。" +
  "开放获取只下接口已经给出 PDF 直链的已纳入篇目；连续 3 次 403 即停，其余写入 to-fetch.md，不要换链重试。";

/** 标准档发现阶段不做重复劳动（2026-10-09）。字段补全与两套 RIS 仍按 TO_FETCH_RIS。 */
const LIT_SEARCH_NO_WASTE =
  "发现阶段只查 OpenAlex 一条主检索式（概念块 2–4 个，块内 OR、块间 AND；单复数与近义词不另开一条）。" +
  "先取命中数，再取回这一条式子的记录；命中多也不要拆成十几条近义式重抓。" +
  "已配置的 Consensus / Undermind 各跑一轮并进候选池，不替代 OpenAlex。" +
  "标准档不用 Semantic Scholar、Crossref 标题检索、arXiv 做发现；429 或失败记一行覆盖缺口后继续，不重试。" +
  "来源级别允许预印本时才查 arXiv。Crossref 只按 DOI 补字段，不当发现库。" +
  "标准档不做引文扩展；人明确要求或全局设定为严格检索档才做。" +
  "期刊缩写与两套 RIS 只给最终纳入和待确认各做一次，排除的不补字段。";

/** 英文综述（review）：文献检索 → 精读笔记 → 大纲 → 初稿 → 润色定稿。
 *  示例课题直接用这份模板（src-tauri/resources/pipeline-review.json）。
 *  改这里之后跑：node --experimental-strip-types scripts/export-review-template.ts */
const REVIEW_STEPS: ProjectStepDto[] = [
  {
    name: "文献检索与筛选",
    role: "both",
    workspaceName: "lit-search",
    brief:
      "输入：课题主题（见上方「课题主题」段；未填写时只能提出候选主题写入 papers/screening.md「检索主题假设」，等待人确认后正式筛选；期间只做可逆摸底）。全程按 {skill:lit-search} 技能执行。全局设定若写了「综述深度：严格档」，按技能严格档（引用扩展强制、screening 末尾 PRISMA-S 最小披露）；未写或标准档则按技能默认标准档。方法类型先按叙述性/范围/系统综述确认；严格检索不是完整系统综述。单人/人工或 Agent 复核范围在 Methods 如实声明，系统综述需完整方案与对应质量评价。\n" +
      "1. 制定纳入/排除标准（年份、语言、来源级别、相关性口径），写进 papers/screening.md。" +
      "**先粗检一轮报数再定标准**：用主题词在 OpenAlex 粗查命中量，把「命中约 N 篇」与你建议的标准写进 " +
      ".ccode/help-wanted.md 问用户一句（附兜底：未回复只做试检，不冻结标准或正式筛选），写完仅推进无依赖、可逆的准备。" +
      "正式标准按问题制定，不为凑篇数或结果而改；\n" +
      "2. 先解析人工导入的题录（RIS/BibTeX/CSV），三处都要看：① 本文件「项目根」下 papers/imports/；② 工作区内 papers/imports/；③ 「项目资源」段类型为「引文」的条目、以及「上一步产物（提货单）」段中来自「人工交付」的条目——后两类给绝对路径，按路径直读、勿复制。都没有才跳过。解析后按 {skill:lit-search} 技能口径去重合并进候选池，每条保留来源标注；\n" +
      "3. 检索候选文献。" + LIT_SEARCH_NO_WASTE +
      "检索式、检索日期与命中数记入 papers/screening.md；WoS/SerpAPI 等付费 key 一律用 $VAR 环境变量引用，禁止写进任何文件；末尾写覆盖缺口声明（哪些库没检，含按上面停手跳过的库）；\n" +
      "4. 按标准逐条筛选，每篇给出纳入/排除及理由；拿不准相关性的一律保留为 pending 候选并标注「待确认」，不冒充已决纳入，不允许自行裁掉；\n" +
      "5. 纳入清单写入 papers/included.md（一行一篇：标题 — 作者, 年份 — 来源 — 链接/DOI），并同步写入 papers/included.json（每篇一条，至少含稳定唯一字符串 id、title、decision（included/pending）、reason；与 md 记录一一对应）；\n" +
      "6. " + LIT_PENDING_BEFORE_FETCH +
      "开放获取（arXiv/PMC/开放期刊/作者主页 preprint）直接下载到**项目根 papers/**（见上方「项目根」，文件名规范化：作者年份-短标题.pdf），不要下载到本工作区；付费墙不得尝试绕过，在 included.md 该行末尾标注「需自行获取」，并汇总写入 papers/to-fetch.md（编号清单，见 {skill:lit-search} 产出格式）等用户提供全文，同时把 to-fetch.md 转成" + TO_FETCH_RIS + " 已有 references.bib 只补空着的卷、期、页、ISSN、摘要、关键词和期刊缩写，不覆盖、不改键。不在这一步默认写同步文件。文献来源或文献库选了 Zotero / EndNote 时，才按对应技能做导入和同步。已有 references.bib 不得覆盖。\n" +
      "完成标准：papers/screening.md、papers/included.md、papers/to-fetch.md、papers/to-fetch.ris、papers/endnote-import.ris 均存在（两份 RIS 允许有效空文件，其他文件非空；无付费文献则 to-fetch.md 说明无待获取，两份 RIS 保留合法零条目空文件），每条记录无空缺字段（未知则标「待补」），筛选记录含检索日期与覆盖缺口、能让第三人按标准复现每条判定。\n" +
      QUESTION_GATE + QUALITY_STATUS,
    optionalInputs: ["references.bib"],
    expectedArtifacts: LIT_SEARCH_ARTIFACTS.filter((path) => path !== "papers/zotero-sync.md"),
    acceptanceCriteria: [
      "machine:file:papers/screening.md",
      "machine:file:papers/included.md",
      "machine:file:papers/to-fetch.md",
      "machine:optional-empty:papers/to-fetch.ris",
      "machine:optional-empty:papers/endnote-import.ris",
      "machine:contains:papers/screening.md::检索日期",
      "machine:records-allow-empty:papers/included.json::id,title,decision,reason",
    ],
    skills: ["lit-search"],
    requiredSkills: ["lit-search"],
    asksLitSource: true,
    run: [],
    humanTasks: litSearchHumanTasks(),
    decisions: [],
  },
  {
    name: "文献精读与笔记",
    role: "both",
    workspaceName: "lit-notes",
    brief:
      "输入：上一步产物 papers/included.md 与 papers/to-fetch.md（已随 main 合并在本工作区内）。全程按 {skill:lit-notes} 技能执行。\n" +
      LIT_NOTES_WRITE +
      "篇数以 papers/included.json 的 decision 为准。included.md 开头若写着「终判纳入 N 篇 / 待确认 M 篇」而和 json 不一致，那是检索时的旧句子，人在 Mesa 里改过判定后以 json 为准，改掉那一句再继续，不要因此停步。\n" +
      "若后续提交把 included.json 从「纳入+待确认」改成「纳入+排除」、并把部分行移出 included.md，那是人在 Mesa 里做的筛选，不是定稿被退回。help-wanted.md 里列出的待确认是提问当时的名单，json 里已经没有 pending 就不要再当成未决。\n" +
      "to-fetch.md 是还没拿到全文的名单。项目根 papers/ 里已有的 PDF 按 DOI 对上后勾掉对应行，对不上的保持待获取。references.bib 没有就从纳入篇的 DOI 建，不要把缺库当成检索失败。\n" +
      "1. 先整理项目根 papers/ 里的 PDF（见上方「项目根」，含未进本工作区的文件，按绝对路径读）。已经登记成项目资源、但文件就在这个 papers/ 里的，仍按这里改名。命名不符「作者年份-短标题.pdf」的，对照 included.md/to-fetch.md 判定归属后重命名，并在 to-fetch.md 勾掉已补行；拿不准归属的不改名、标注「待确认」。路径不在项目根 papers/ 下的已登记 PDF 不改名。然后按 included.md 处理已确认纳入项（清单缺失或为空时在报告中说明并停止，不要自行换题或自行补清单）；\n" +
      "2. 有全文 PDF 的全部按八段精读，不另提一份核心篇名单等人拍板。没有 PDF 的按摘要写短记并标「仅摘要·待全文」；摘要也拿不到的标「题录·待全文」，不编正文。\n" +
      "3. 全文来源优先级（写死）：项目资源里、路径不在项目根 papers/ 的 PDF（如 Zotero 附件，只读，不改名、不复制）→ 项目根 papers/ 已有 PDF（含已登记的长标题，按第 1 步改名）→ 开放获取补下到项目根 papers/（arXiv/PMC/作者主页 preprint）→ 仍缺按摘要写笔记并标注「仅摘要·待全文」，不得装作读过全文；\n" +
      "4. 上下文写不下可分批，提交后立刻继续，直到有 PDF 的都写成精读、没有 PDF 的都写成短记。index pending 只留给待确认或题录都不足以写的篇。有实际 PDF 时笔记开头记来源锚点行「> 来源 PDF：<项目内相对路径或已登记只读资源绝对路径>.pdf」，无 PDF 改记 DOI/URL，不造虚假路径。笔记、index、references.bib 写在本工作区；临时脚本和接口缓存放本工作区 artifacts/，不写项目根。\n" +
      "5. 每篇先按 DOI/版本/键匹配 references.bib，缺失才追加一条 BibTeX。有 DOI 就用 Crossref 补全作者全名（姓, 名）、年份、标题、期刊、卷、期、页、出版日期、网络出版日期、ISSN、摘要、关键词。期刊缩写用 ISO 4、每个缩写词后加句点，按期刊全称查 JabRef，没有再用 Mesa 兜底表。两处都没有才按期刊官网或 ISO 4 补进 journalabbreviation，一词刊名的缩写就写全称，不要留空。OpenAlex 只补 Crossref 没有的摘要。缺的标「待补」，没对过 Crossref 的标「待核」，不得编造，不得用卷或页填空着的期。已有条目只补空字段，不改键、不覆盖人改过的作者和标题；\n" +
      "6. 收尾前复查：notes/ 中「仅摘要」笔记对应的全文若已出现在项目根 papers/（人工补投），重读全文并更新该笔记、去掉标记；仍未补的保持标注并在报告末尾计数说明。\n" +
      "7. 写 notes/handoff.md，只给下一步用。两节：\n" +
      "「## 写作约束」：仅摘要或题录的 bib 键（下游不得写成已确立）；库内要并列的机制分歧；图只核对了文本层图注、拼图时再核；期刊缩写留空的刊名。每条一行，没有就写无。\n" +
      "「## 不由下一步做」：补全文、登录、授权。这些留在 .ccode/help-wanted.md，不写进大纲任务。\n" +
      "8. 项目根 papers/ 里已对上 DOI 的 PDF，读首页和摘要页。标题、化学式上下标、摘要与 Crossref 纯文本不一致时，以 PDF 为准改 references.bib 的 title 和 abstract。抽不出字或对不上 DOI 的保持原字段。不在这一步重写 RIS。人点「同步到文献库」时，Mesa 按这份 references.bib 生成导入文件。\n" +
      "完成标准：notes/index.json 与 included.json 全部 id 对齐（仅待确认或无法按摘要写的篇 notePath 可空）；已写笔记符合 {skill:lit-notes} 写法；确认过的核心篇未写完、或已确认要按摘要记的非核心还没写完，则不得结束本轮等人，验收摘要写明剩余篇数，质量状态不得高于已生成待审。清单全有文件不等于完成。\n" +
      QUALITY_STATUS,
    inputs: ["papers/included.md", "papers/included.json", "papers/to-fetch.md"],
    optionalInputs: ["papers/*.pdf"],
    expectedArtifacts: ["notes/*.md", "notes/index.json", "references.bib", "papers/to-fetch.md", "notes/handoff.md"],
    acceptanceCriteria: [
      "machine:count:notes/*.md>=1",
      "machine:file:references.bib",
      "machine:contains:notes/handoff.md::写作约束",
      "machine:contains:papers/included.md::—",
      LIT_NOTES_INDEX_RECORDS,
      "machine:same-ids:papers/included.json::notes/index.json",
    ],
    skills: ["lit-notes"],
    run: [],
    // 「继续精读笔记」不再是人工事项（2026-09-19 撤主干收尾）。保存进项目后，
    // 可选区在「同步到文献库」旁边给出入口（2026-09-20），进沉浸阅读；改完开大纲走未存进历史软门。
    // 「精读力度怎么分」卡片已移除（v3.97，用户拍板）：力度要看到清单规模和全文到位率才定得了，
    // 开工前点卡片等于让人盲猜——与 v3.89 移除「纳入标准定多严」同一道理。
    // 改为 agent 粗读清单后带着数字经 help-wanted.md 按需问（见上方简报第 2 条）。
    decisions: [],
  },
  {
    name: "综述大纲",
    role: "you",
    workspaceName: "outline",
    brief:
      "输入：notes/ 全部笔记、notes/handoff.md、papers/included.md 与 references.bib（已随 main 合并在本工作区内）。先读 handoff 的「写作约束」：仅摘要不得写成已确立，机制分歧并列，图按笔记锚点再核。「不由下一步做」不要接手。框架构造全程按 {skill:review-framework} 技能执行（空白清单 → 范式卡片 → 融合）：\n" +
      "1. 提炼研究空白清单：通读 notes/ 各笔记的「局限」与「可引用点」，最新一批精读文献回到原文前言核对作者自述的 gap（是待检主张，须用最邻近工作与反例核验）；每条空白标注来源笔记/bib 键，多条指向同一空白时合并；仅凭单篇文献主观抱怨的标「孤证」；\n" +
      "2. 拆解范式卡片：从 papers/included.md 选择足以比较候选框架的综述（篇数按问题，不凑数量）（问题相关性与方法透明度优先；期刊/被引仅为发现线索，不作证据权重；清单里没有综述类文献时如实说明并跳过本步，不虚构范式），每篇拆「结构逻辑 / 详略配比 / 论证顺序」三项；\n" +
      "3. **先报候选再融合**：把拆出的范式卡片连同「我建议以哪篇为骨架（按核心问题、证据分歧与读者需求给理由）+ 建议的综述卖点（想让读者读完记住的一句话）」写进 .ccode/help-wanted.md 问用户一句（附兜底：未回复仅保留候选框架，不锁定论证），写完仅推进无依赖、可逆的准备。；\n" +
      "4. 融合构造框架：以最能回答核心问题、解释证据分歧且适合读者的范式做骨架（用户已拍板时从用户选择），核心空白落到具体章节，其余说明未覆盖理由；范式冲突时选更符合核心问题与证据结构的，落选范式的局部优点吸收为节内参考；必要背景/方法/综合章说明其对回答问题的作用，不强迫每章挂 gap；空白无处安放时允许新增章节并在该节标注「空白驱动新增」；\n" +
      "5. 产出 outline.md：章节结构（引言 / 背景 / 主题各节 / 讨论 / 结论），每节给必要要点、拟引用 bib 键及章节作用（适用时回应空白编号）；拟引用必须分「可写正文 / 仅线索」，初稿按这个等级写。有小节则每小节、否则每章写用图计划（能拼则列出源 [@键] Fig.n，不能拼则仅引用一篇的图号）；禁止写「初稿待绘制」。源图只来自笔记可引用图；G 编号只出现在「框架推演」，不要让初稿把 G1 写进正文。篇幅数字只是读者预期，旁注「不是初稿必须凑到的词数」。末尾固定附「## 框架推演」段（空白清单 / 范式卡片 / 融合理由三块）；\n" +
      "6. 在 outline.md 附证据综合表：研究对象/设计/结果/局限/支持强度/分歧/原文位置；核心论断逐项做支持性核验，不数赞成论文投票。摘要-only 只可支持摘要实际报告的信息；核心全文未得则收窄结论或阻塞。不得把研究作者的 gap 宣传当已证实事实；记录最邻近反例与检索边界。\n" +
      "7. 只引用 references.bib 中存在的键，不为大纲新造引用。\n" +
      "完成标准：outline.md 结构完整，每节要点/引用键/章节作用齐全，「框架推演」段三块内容齐备；每章拟引用分可写正文与仅线索，可写键均在证据综合表且非题录级；表内论断编号全部定义；图表占位写明已有数据来源（无现成数据则改示意图，禁止空许诺计数）；每章/小节有用图计划（拼或仅引用）。质量状态在拟引用未分档、论断编号未闭集或用图计划缺源时不得高于已生成待审。\n" +
      QUESTION_GATE + QUALITY_STATUS,
    expectedArtifacts: ["outline.md"],
    inputs: ["notes/", "notes/handoff.md", "papers/included.md", "papers/included.json", "references.bib"],
    skills: ["review-framework"],
    run: [],
    humanTasks: [],
    // 讨论种子已移除（用户拍板，与 v3.89 检索步移除决策项同一道理）：范式锚点/卖点
    // 要看到候选范式卡片才定得了，开工前点卡片等于盲猜；且只读想法卡聊完要手动
    // 「◈ 沉淀」、只追加草稿末尾，对「定任务书参数」类问题是绕路。改为简报第 3 条
    // 带候选经 help-wanted 按需问；「跟 AI 商量一下」开场本就逐条问拿不准的点。
  },
  {
    name: "综述初稿",
    workspaceName: "draft",
    brief:
      "输入：outline.md（含「框架推演」段）、notes/、references.bib（已随 main 合并在本工作区内）。写作规范全程按 {skill:review-writing} 技能执行。\n" +
      `写作范围由你按笔记判断：${DRAFT_EVIDENCE_DEFAULT}。人在审阅初稿时拍板，开工前不再问范围。\n` +
      "1. 按 outline.md 用规范学术英文撰写综述初稿，产出 manuscript/draft.md。**词数不是完成标准**（项目/大纲里的篇幅数字是读者预期，禁止改写成「以 N 词为目标」）。某节薄只回 notes/ 对应笔记的方法/结果/可引用点；笔记有来源 PDF 且非仅摘要时打开该 PDF 核对原文位置再补一句可定位证据；没有更多证据就保持短并标 [待核实]。禁止同义复述、空转场、防御性套话为凑字数。中心论点引言一次、结论一次。标题不要手写序号（Quarto 会再编号）；空白编号 G1 不准进稿件。全局设定为严格档时，Methods 须写检索策略（库、日期、式、筛选流程），并如实声明方法类型、单人筛选及实际复核范围，不把严格检索当作系统综述质量证明；\n" +
      "2. 引用一律用 [@bib键] 形式，且只能引用 references.bib 中已存在的键——严禁编造文献、严禁新造键。大纲「仅线索」/摘要级来源：定量句必须 [待核实] 或改成「摘要报告了」；不得把方法段的「32 篇全文」当许可，把其余文献写成已确立。\n" +
      "3. 对照表用 markdown 真表。先读 outline.md 每一条用图计划，再按 {skill:review-figures} 出图，写正文之前做完。计划写「拼」：从全文 PDF 裁源图，题注块必须以 Figure N. 开头，至少两块裁到才拼成 figures/figN.png，一行最多 4 块，第 5 块起用 --rows 分行。图注写 Adapted from，正文插入该图。只裁到一块、题注对不上、或会裁成整页：不猜，正文改成「见 [@键] Fig.n」，并在 figures/README.md 写原因。计划写「仅引用」的不插图。禁止「待绘制」「Figure N（待绘制）」和空的图片占位。撑主论点的图没有数据就改口。不臆造图号、不把整页当图、不非等比拉伸。Agent 读图不能代替人看 PNG。\n" +
      "4. 没有文献支撑的论断不得下。摘要只放全文撑得住的主张，禁止摘要里出现 [待核实] 或未测的近端动作（operando/软包等放 outlook 并标明是建议）。范围点名的主题后文必须展开，否则从范围删除。结论只写本综述论证了什么。\n" +
      "5. 用本步骤 run 脚本先渲 docx、再渲 PDF（环境检查、编号引用 YAML、产物登记按 {skill:quarto-render} 技能）。**初稿固定用编号制（方括号 [1]）渲，不要问人要哪种引用格式**：YAML 写 `csl: citation.csl` 并放随包的 ieee.csl。引用格式到定稿步再问：沿用这份编号，或改成目标期刊。" + DRAFT_TYPEFACE + "PDF 若 lualatex 无日志空转，按技能停掉改 xelatex，不要空等。产物写入本工作区 output/（评审合并后进项目根）。\n" +
      "6. 交稿前自检：打开 output/draft.pdf 第一页，必须能读出英文标题和段落；乱码、空心方框、目录页码变成字母 = 渲染失败，质量状态不得高于已生成待审，docx 仍交人审。引用键先对 references.bib，笔误键改正文不删句；材料名里的 @ 写成 \\@。正文数字若与笔记不符，按原文改稿并回写该笔记，记入 section-status.md。图裁不到就改成「见 [@键] Fig.n」，禁止用「待绘制」充产出。正文不得留 G1/任务编号、内部清单号。作者「待补」写进验收摘要等人填，不假装齐套。\n" +
      SECTION_STATUS +
      "完成标准：manuscript/draft.md 覆盖大纲全部章节；引用键全部可在 references.bib 中解析；扩写能回溯到笔记或原文；不以词数判定完成。用图计划里每一条「拼」要么有 figures/figN.png 且正文插了这张图，要么已改成「见 [@键] Fig.n」并在 figures/README.md 写明原因；正文不得出现「待绘制」。PDF 首页可读或已如实报渲染失败；人尚未审阅初稿前不得进入润色。\n" +
      QUALITY_STATUS,
    inputs: ["outline.md", "notes/", "references.bib"],
    optionalInputs: ["papers/*.pdf"],
    skills: ["review-writing", "review-figures", "quarto-render"],
    expectedArtifacts: ["manuscript/draft.md", "manuscript/section-status.md", "manuscript/typeface.md", "manuscript/reference.docx", "figures/README.md", "output/draft.pdf", "output/draft.docx"],
    acceptanceCriteria: [
      "machine:contains:manuscript/section-status.md::要回答",
      "machine:contains:manuscript/section-status.md::允许集",
      "machine:file:figures/README.md",
      "machine:not-contains:manuscript/draft.md::待绘制",
    ],
    run: [
      { name: "export-docx", command: "quarto render manuscript/draft.md --to docx --output-dir output", default: true },
      { name: "render-draft", command: "quarto render manuscript/draft.md --to pdf --output-dir output", default: true },
    ],
    humanTasks: [],
  },
  {
    name: "润色与定稿",
    role: "you",
    workspaceName: "polish",
    brief:
      "输入：manuscript/draft.md、manuscript/section-status.md 与 references.bib（已随 main 合并在本工作区内）。上一步「去评审」里人退回过时，本步先修退回项（乱码 PDF、待绘制充图、内部编号、摘要里的 [待核实]、摘要级未降级、凑字数），不要当定稿润色。\n" +
      REVIEW_FIRST +
      "定稿同时交两份带引用域的 Word：output/endnote.docx（EndNote 的 ADDIN EN.CITE）和 output/zotero.docx（Zotero 的 ADDIN ZOTERO_ITEM）。Quarto 的 review-final.docx 只给阅读，换不了这两个软件的样式。未匹配的 [@键] 哪一份都不交。LaTeX 载体不交这两份。\n" +
      "审查报告写 manuscript/review-report.md。第一轮同时按 {skill:bib-check} 写 manuscript/citation-check.md，两份都只读不改稿。\n" +
      "第二轮才改稿：未解析引用键改为 references.bib 中正确键或补条目（补条目缺字段标「待补」）；「疑似编造」不得自行删除对应论断，句末标 [待核实] 并记入「科学改动」；「未引用条目」只列出、不删。语言润色只改表达：语法、用词、句式与段落衔接；去掉防御性套话、空转场和重复立论；对照大纲把摘要级定量句降级或补 [待核实]；删正文 G 编号；摘要清掉 [待核实]。发现内容性错误标 [待核实]，不得自行改写事实。\n" +
      "4. 产出 manuscript/review-final.md 候选定稿（文末文献表按稿子里已在用的样式生成，不要手写 References；人还没换样式时沿用初稿编号，不因没有 citation-style.md 停渲）与 manuscript/changelog.md（逐条列出主要修改点及对应 citation-check.md 条目；未补的「待绘制」占位列入 changelog，不得假装已绘）。" + STYLE_AT_FINAL + "\n" +
      "5. 收尾再按 {skill:bib-check} 复核 review-final.md，结论追加进 citation-check.md；\n" +
      "5b. 写 manuscript/verification-decisions.md：把 review-final.md 里每条 [待核实] 与 citation-check.md 里每条「疑似编造/元数据存疑」各列一行，格式 `- V001 | 位置：文件:行 | 原文摘要：…… | 来源：[@键] | 裁决：待裁决 | 依据：`。你只负责把清单列全、编号给上，**「裁决」与「依据」两栏一律留空或写「待裁决」，不得代填**——只有人能对照原始文献拍板。清单里的条数必须与稿子里实际剩余的 [待核实] 处数一致，漏列等于把未决项藏起来。\n" +
      "6. 用本步骤 run 脚本渲染 PDF/docx（按 {skill:quarto-render} 技能：人还没在流程线「更换引用样式」里换形式时，沿用初稿编号制渲，不因没选样式停渲）。正文字体沿用初稿 manuscript/typeface.md，不要另选字体，也不要重问。Word 加 --reference-doc manuscript/reference.docx。同一次再生成 output/endnote.docx 与 output/zotero.docx。产物写入本工作区 output/（评审合并后进项目根）。\n" +
      "完成标准：review-final.md 无语法硬伤、引用键全部可解析；citation-check.md 如实报告；verification-decisions.md 已列全、裁决栏为空等人填；核心支持性缺口未关闭时仅交待审稿，不标通过；changelog.md 已提交；run 脚本渲染通过。人未逐条裁决前，这一稿不得当定稿。\n" +
      RELEASE_GATE + QUALITY_STATUS,
    expectedArtifacts: [
      "manuscript/review-report.md",
      "manuscript/review-final.md",
      "manuscript/changelog.md",
      "manuscript/citation-check.md",
      "manuscript/verification-decisions.md",
      "output/review-final.pdf",
      "output/review-final.docx",
      "output/endnote.docx",
      "output/zotero.docx",
      "papers/endnote-cite-report.md",
      "papers/zotero-cite-report.md",
    ],
    acceptanceCriteria: ["machine:contains:manuscript/review-report.md::严重问题"],
    inputs: ["manuscript/draft.md", "manuscript/section-status.md", "manuscript/typeface.md", "manuscript/reference.docx", "outline.md", "notes/", "references.bib"],
    skills: ["review-writing", "bib-check", "quarto-render", "endnote-bridge", "zotero-sync"],
    run: [
      { name: "export-docx", command: "quarto render manuscript/review-final.md --to docx --output-dir output --output review-final.docx", default: true },
      { name: "render-final", command: "quarto render manuscript/review-final.md --to pdf --output-dir output --output review-final.pdf", default: true },
    ],
    humanTasks: [
      styleChoiceTask(),
      reviewDecisionTask("manuscript/review-report.md"),
      {
        title: "逐条裁决 [待核实] 与存疑条目",
        guidance:
          "只处理定稿里还标着「待核实」的句子，以及引用检查里疑似编造、元数据存疑的条目。没有这些就勾上跳过。接受表示这句话先留着，拒绝删掉这句，修改按你写的说明改。",
        target: "manuscript/verification-decisions.md",
        timing: "after",
        completion: "decisions_cleared",
      },
    ],
  },
];

/** 科研论文（research-paper）：检索筛选 → 精读与研究空白 → 实验设计 → 实验执行 → 结果分析 → 初稿 → 投稿准备 */
const RESEARCH_PAPER_STEPS: ProjectStepDto[] = [
  {
    name: "文献检索与筛选",
    role: "both",
    workspaceName: "lit-survey-search",
    brief:
      "输入：英文综述模板的 notes/ 与 references.bib（接自上游模板时随仓库合并自带；独立启动本项目时，先把上游产物放入对应目录，或在资源面板绑定上游项目目录）。\n" +
      "若项目根已有 notes/ 或 papers/included.md：检查检索日期、问题/标准与原文版本，有效则复用；按本课题实证问题补检索、补纳入，保留人写内容并更新失效笔记。没有上游产物时按下面流程全量检索。\n" +
      "围绕课题主题（见上方「课题主题」段；未填写时只提出候选主题记入 papers/screening.md，待人确认后正式筛选；只可先试检摸底）执行：\n" +
      "1. 检索与筛选按 {skill:lit-search} 技能：**先粗检一轮报数再定标准**（OpenAlex 命中约 N 篇与建议标准写入 .ccode/help-wanted.md，未回复仅做无依赖、可逆准备）；" + LIT_SEARCH_NO_WASTE + "产出 papers/screening.md（标准 + 各库检索式、检索日期与命中数 + 每篇判定理由；拿不准相关性的一律保留为 pending 候选并标注「待确认」，不冒充已决纳入）与 papers/included.md；用户导入的检索结果先解析去重——看项目根 papers/imports/、工作区 papers/imports/、以及「项目资源」「提货单」里的绝对路径；\n" +
      "2. " + LIT_PENDING_BEFORE_FETCH +
      "开放获取直接下载到**项目根 papers/**（文件名：作者年份-短标题.pdf），不要下载到本工作区；付费墙不得绕过，汇总写入 papers/to-fetch.md，并转成" + TO_FETCH_RIS + " 清单落盘后按 {skill:zotero-sync} 记录通道并写 papers/zotero-sync.md；未明确要求进库则不写用户 Zotero 库，通道不可用则只留 RIS/bib。已有 references.bib 时不得覆盖，只补空着的卷、期、页、ISSN、摘要、关键词和期刊缩写。\n" +
      "完成标准：检索交付件均已提交（无付费文献则 to-fetch.md 说明无待获取，to-fetch.ris 与 endnote-import.ris 保留合法零条目空文件；未启用或回落时 zotero-sync.md 写明原因），筛选记录含检索日期与覆盖缺口、可复现。\n" +
      QUESTION_GATE + QUALITY_STATUS,
    optionalInputs: ["notes/", "references.bib", "papers/included.md"],
    expectedArtifacts: [...LIT_SEARCH_ARTIFACTS],
    acceptanceCriteria: [
      "machine:file:papers/screening.md",
      "machine:file:papers/included.md",
      "machine:file:papers/to-fetch.md",
      "machine:optional-empty:papers/to-fetch.ris",
      "machine:optional-empty:papers/endnote-import.ris",
      "machine:file:papers/zotero-sync.md",
      "machine:contains:papers/screening.md::检索日期",
      "machine:records-allow-empty:papers/included.json::id,title,decision,reason",
    ],
    skills: ["lit-search", "zotero-sync"],
    requiredSkills: ["lit-search"],
    asksLitSource: true,
    run: [],
    humanTasks: litSearchHumanTasks(),
    decisions: [],
  },
  {
    name: "精读与研究空白",
    role: "both",
    workspaceName: "lit-survey-gap",
    brief:
      "输入：上一步的 papers/included.md、papers/to-fetch.md 与 references.bib。按 {skill:lit-notes} 技能完成精读与笔记。\n" +
      LIT_NOTES_WRITE +
      "先整理项目根 papers/ 里的人工补投并更新 to-fetch.md；已有 notes/ 先核对原文版本、全文状态和问题范围；有效则复用，变化则保留人写内容并更新受影响项。全文缺失时按摘要写笔记并标注「仅摘要·待全文」。\n" +
      "**先粗读 included.md 全部条目的标题与摘要，把「共 N 篇、全文到位 M 篇、我建议核心精读 K 篇」写进 .ccode/help-wanted.md 问用户一句**（未回复仅做可逆准备，不含批量生成笔记）。用户确认的核心篇有 PDF 的读正文写精读；其余按摘要写短记。index pending 只留给待确认或无法按摘要写的篇。\n" +
      "在已写笔记基础上按主题归纳研究现状写入 survey/literature.md，提炼有实质差别的候选研究问题（无合理备选可只留一个）并逐一分析现有工作的 gap，写入 survey/gap-analysis.md。先把候选、每个 gap 的证据与我建议的研究问题写入 .ccode/help-wanted.md 问用户一句（未回复只保留候选，不替人确定研究问题），写完只做无依赖、可逆的准备。摘要-only 不得支撑需要全文的 gap。\n" +
      "已对上 DOI 的 PDF 读首页和摘要页。标题、化学式上下标、摘要与 Crossref 纯文本不一致时，以 PDF 为准改 references.bib 的 title 和 abstract。抽不出字或对不上 DOI 的保持原字段。不在这一步重写 RIS。人点「同步到文献库」时，Mesa 按这份 references.bib 生成导入文件。\n" +
      APPROVED_QUESTION +
      "完成标准：notes/index.json 与 included.json 全部 id 对齐（仅待确认或无法按摘要写的篇 notePath 可空）；已写笔记符合 {skill:lit-notes} 写法；survey/literature.md 与 survey/gap-analysis.md 齐全；研究问题的候选/人批准状态与取舍理由可追溯。确认过的核心篇未写完、或已确认要按摘要记的非核心还没写完，则不得结束本轮等人，质量状态不得高于已生成待审。\n" +
      QUESTION_GATE + QUALITY_STATUS,
    inputs: ["papers/included.md", "papers/included.json", "papers/to-fetch.md"],
    optionalInputs: ["references.bib", "papers/*.pdf", "notes/"],
    expectedArtifacts: [
      "notes/*.md",
      "notes/index.json",
      "survey/literature.md",
      "survey/gap-analysis.md",
      "references.bib",
      "papers/to-fetch.md",
    ],
    acceptanceCriteria: [LIT_NOTES_INDEX_RECORDS, "machine:same-ids:papers/included.json::notes/index.json", "machine:contains:survey/gap-analysis.md::已批准问题与范围"],
    skills: ["lit-notes"],
    run: [],
    humanTasks: [
      {
        title: "确认研究问题",
        guidance: "按 G1 核对 survey/gap-analysis.md：回答会改变什么认识？能区分哪些解释？最小可回答范围与预算是什么？确认问题/范围/版本后再设计；不会判断交导师或方法专家。",
        target: "",
        timing: "after",
        completion: "manual",
      },
    ],
    decisions: [
    ],
  },
  {
    name: "实验设计",
    role: "both",
    workspaceName: "exp-design",
    decisionMode: "hard_pause",
    brief:
      "输入：survey/gap-analysis.md 经人确认的研究问题、notes/ 文献笔记与 references.bib（已随 main 合并在本工作区内）。本模板默认计算实验（脚本、矩阵、算力）；全局设定若写了其他研究形态，先由具备相应方法经验的人确认采集、设计和验证规范，再调整执行步；不能只把矩阵改名，不要假装跑了没做的计算。\n" +
      "1. 产出 design.md，逐项写死：可检验问题/假设（预设主结局；确需共同主结局时给出多重性策略）、研究方法（技术路线与关键假设）、数据来源（名称/规模/获取方式）、对比基线（按研究问题选择必要且公平的对照，说明选择与配置依据，不凑数量）、评价指标（主指标+辅指标，给出计算公式或出处）、实验矩阵（能回答问题的预先选定组合表；不强制全因子穷举）、停止规则（什么情况下不再加实验、不改主指标）；\n" +
      "2. 每个设计决策给出依据（文献支撑处引用 notes/ 笔记或 bib 键）；依赖的资源不可获取时提出替代品及研究对象/结论范围变化，待人批准后才替换；未批准标阻塞；\n" +
      "3. 估算每项实验和全项目的计算开销，超出本机条件的组合在矩阵中标注「待批准裁剪」并说明对研究问题/对照公平性的影响；\n" +
      "4. design.md 末尾附风险清单：最可能失败的环节与备选方案；伦理批件/数据许可若需要，列入人工事项，不编造已获批；\n" +
      "5. 统计设计自查（按 {skill:stats-check} 技能的实验设计口径）：主要结局及比较明确（共同主结局须说明多重性策略）、样本量有功效/精度或对应研究类型的依据、剔除标准事先定义；涉及统计检验的实验在 design.md 中写明检验方法与多重比较校正口径；问题清单写入 analysis/stats-check-design.md。\n" +
      APPROVED_DESIGN +
      "完成标准：design.md 覆盖假设/方法/数据/基线/指标/实验矩阵/停止规则，关键未决项已处理或明确阻塞，不以猜测填满；同步写 experiments/matrix.json，每个组合一条稳定唯一字符串 id、configuration、status 记录；analysis/stats-check-design.md 各节齐全；实验矩阵可逐项直接执行。\n" +
      DESIGN_GATE + QUALITY_STATUS,
    expectedArtifacts: ["design.md", "analysis/stats-check-design.md", "experiments/matrix.json"],
    acceptanceCriteria: [
      "machine:file:design.md",
      "machine:contains:design.md::已批准设计",
      "machine:file:analysis/stats-check-design.md",
      "machine:records:experiments/matrix.json::id,configuration,status",
    ],
    inputs: ["survey/gap-analysis.md", "notes/", "references.bib"],
    optionalInputs: ["analysis-report.md", "artifacts/"],
    skills: ["stats-check"],
    run: [],
    humanTasks: [
      {
        title: "审阅实验设计",
        guidance:
          "按 G2 核对 design.md：独立样本是什么？哪些数据已看过？何种结果不支持假设？验证/停止规则、预算、权限和统计问题是否明确？在下一步写出批准版本与依据。",
        target: "",
        timing: "after",
      },
    ],
    decisions: [{ q: "确认的研究问题与范围（填写 G1 评阅依据和批准版本）", options: [] }],
    discussionSeeds: [
      "主指标测到什么：它是否回答研究问题，何种差异有实际意义，什么结果不支持假设？",
    ],
  },
  {
    name: "实验执行",
    workspaceName: "exp-run",
    decisionMode: "hard_pause",
    brief:
      "输入：design.md 的实验矩阵（已随 main 合并在本工作区内）。\n" +
      "1. 按 design.md 实现实验代码，放入 experiments/（脚本可重复执行，参数集中在文件头或配置文件）。先在已获授权的资料范围内做最小试验，未通过 G3 不扩规模；试跑一组估算单次耗时与显存/内存占用，若整个矩阵在本机跑不完（超过批准的总资源预算或内存不足；8 小时仅本机估算提示，不是科学停止规则），把估算值与建议写进 .ccode/help-wanted.md 问用户要不要上集群（未回复只保留试跑和估算，不启动未经批准的矩阵子集）；\n" +
      "2. 逐项跑实验矩阵；仅经人批准取消的组合跳过并在结果记录中保留 id、理由与批准依据；\n" +
      "3. 原始结果与日志写入本工作区产物目录（见上方「产物目录」，相对路径），不进 git，评审合并后自动进项目根同名目录；工作区内只提交代码与 results/summary.md（每行一项实验：配置、主指标数值、产物的项目根相对路径）；\n" +
      "4. 失败的实验不删除日志：在 results/summary.md 标注「失败」与原因，按 design.md 风险清单的备选方案重跑一次，仍失败则记录后继续下一项。遵守 design.md 的停止规则，不得看到结果后改主指标。\n" +
      "完成标准：矩阵中每项都有明确结果或失败记录；同步写 results/matrix.json，每个组合一条稳定唯一字符串 id、configuration、status 记录；experiments/ 与 results/summary.md 已提交，原始数据全部落在本工作区产物目录（评审合并后进项目根）。\n" +
      EXECUTION_GATE + QUALITY_STATUS,
    // experiments/ 是实现目录，不作为完成证明；summary.md 才是矩阵逐项结果的唯一入口。
    expectedArtifacts: ["results/summary.md", "results/matrix.json", "results/implementation-check.md", "results/run-manifest.json", "experiments/reproduce.py"],
    acceptanceCriteria: [
      "machine:file:results/summary.md",
      "machine:contains:results/summary.md::配置",
      "machine:records:results/matrix.json::id,configuration,status",
      "machine:records:results/run-manifest.json::id,dataHash,codeVersion,environment,command,status,outputs",
      "machine:same-ids:experiments/matrix.json::results/matrix.json",
      "machine:same-ids:experiments/matrix.json::results/run-manifest.json",
    ],
    inputs: ["experiments/matrix.json", "design.md"],
    optionalInputs: ["analysis-report.md", "artifacts/"],
    skills: [],
    run: [],
    humanTasks: [
      {
        title: "准备数据集与算力访问",
        guidance:
          "design.md 所列数据集/模型若需申请或登录（公开数据集协议、机构集群账号等），开工前完成授权",
        target: "",
        timing: "before",
      },
      {
        title: "确认伦理/数据许可适用性与批准依据",
        guidance:
          "涉及人/动物/敏感数据时，把批件或许可说明放到项目目录并在 design.md 记录编号；不需要时也说明不适用依据，需许可但未获得时不得运行",
        target: "",
        timing: "before",
        completion: "manual",
      },
    ],
    decisions: [{ q: "批准运行的设计版本、范围及必要授权依据（未获批不得填写为已批准）", options: [] }],
  },
  {
    name: "结果分析",
    role: "both",
    workspaceName: "exp-analysis",
    brief:
      "输入：results/summary.md 与产物目录中的原始结果（项目根相对路径见 summary.md 逐行记录，按项目根绝对路径读取）。\n" +
      "1. 汇总各实验主指标，与基线逐项对比，产出 analysis/results-table.md（表格：方法 × 指标，同时报告不确定性；最优值不等于重要或显著）；\n" +
      "2. 关键对比生成图表写入 figures/（出图按 {skill:figure-forge} 技能：可复现脚本、主交付 SVG 或 PNG 以便进 git，投稿用 PDF 副本写入本工作区 output/figures/（合并后进项目根）；色盲友好、图题含指标与实验条件）；\n" +
      "3. 逐项解读：哪些结果支持、不支持或尚不能判断假设、与基线差异的可能原因；下结论只用表格中的数字，没有数据支撑的解读标 [推测]；涉及统计显著性的表述按 {skill:stats-check} 技能口径报告（p 值给具体值、附效应量与置信区间）；统计审查问题另写入 analysis/stats-check-results.md。\n" +
      "4. 异常结果（失败/离群）单独一节说明，不删除不美化；结果不如预期时，先基于实际异常、补实验成本与 design.md 的停止规则写入 .ccode/help-wanted.md 问用户，不得事后改主指标；\n" +
      "5. 分析结论写入 analysis/findings.md：按实际证据列出，可少于 3 条或结论为证据不足；每条对应 results-table.md 中的具体数字。\n" +
      CLAIM_ENTRIES +
      "完成标准：analysis/results-table.md、analysis/findings.md、analysis/stats-check-results.md 与 figures/ 均存在，每条结论可回溯到表格数字。\n" +
      EVIDENCE_GATE + QUALITY_STATUS,
    inputs: ["experiments/reproduce.py", "results/run-manifest.json", "results/matrix.json", "results/implementation-check.md", "design.md", "results/summary.md"],
    optionalInputs: ["artifacts/"],
    expectedArtifacts: [
      "analysis/results-table.md",
      "analysis/findings.md",
      "analysis/stats-check-results.md",
      "figures/*",
    ],
    acceptanceCriteria: ["machine:contains:analysis/findings.md::结论条目"],
    skills: ["stats-check", "figure-forge"],
    run: [],
    humanTasks: [
      {
        title: "审阅结论条目再开大纲",
        guidance:
          "按 G4 核对 findings 的结论条目：关键数字能否复算？哪条证据支持或反驳？探索是否冒充确证？把认可的条目状态改成已认可。不合意回分析。",
        target: "",
        timing: "after",
      },
    ],
    decisions: [],
  },
  {
    name: "论文大纲",
    role: "you",
    workspaceName: "paper-outline",
    brief:
      "输入：survey/gap-analysis.md 的已批准问题、design.md 的已批准设计、analysis/findings.md 的结论条目、analysis/results-table.md、figures/、references.bib。\n" +
      "1. 只产出 manuscript/outline.md，不写正文。按 Introduction、Methods、Results、Discussion、Conclusion、Abstract 分节。每节写要回答的问题、绑定的已认可结论编号、表或图、拟引用键。\n" +
      "2. 没有已认可条目时，只列出待审编号并写明不得写成定论。不新造数据、文献或图表。缺证据的节标 [待核实] 或 [待补实验]。\n" +
      "3. Abstract 只列已有条目撑得住的主张。\n" +
      "完成标准：outline.md 覆盖上述各节，每节有问题、结论编号或明确缺口、图表与引用键。\n" +
      QUALITY_STATUS,
    inputs: [
      "survey/gap-analysis.md",
      "design.md",
      "analysis/findings.md",
      "analysis/results-table.md",
      "references.bib",
    ],
    optionalInputs: ["figures/*", "notes/"],
    expectedArtifacts: ["manuscript/outline.md"],
    acceptanceCriteria: ["machine:contains:manuscript/outline.md::Introduction"],
    skills: ["research-writing"],
    run: [],
    humanTasks: [
      {
        title: "审阅论文大纲再开初稿",
        guidance:
          "核对每节要回答的问题、已认可结论和图表是否对得上。不合意退回本步，不要开初稿。",
        target: "",
        timing: "after",
        completion: "manual",
      },
    ],
  },
  {
    name: "论文初稿",
    workspaceName: "paper-draft",
    brief:
      "输入：manuscript/outline.md、survey/、notes/、design.md、analysis/、figures/、references.bib（已随 main 合并在本工作区内）。\n" +
      `写作范围由你按笔记与分析结果判断：${DRAFT_EVIDENCE_DEFAULT}。人在审阅初稿时拍板，开工前不再问范围。\n` +
      SECTION_STATUS +
      "1. 按 manuscript/outline.md 与项目语种（未设时英文）撰写初稿，产出 manuscript/draft.md：Introduction、Methods、Results、Discussion。篇幅跟证据走，不为凑字数扩写；某节薄只回 analysis/、notes/ 或原文补可定位证据，没有就保持短并标 [待核实]/[待补实验]。论断直接说，必要局限写一次，去掉防御性套话；\n" +
      "2. 引用一律用 [@bib键] 形式，且只能引用 references.bib 中已存在的键——严禁编造文献；\n" +
      "3. 数字与结论必须与 analysis/results-table.md 一致，不得新造实验结果；缺少的数据在文中标 [待补实验]；\n" +
      "4. 图表引用已有 figures/ 文件（「Figure 1: …」），图片文件不复制进 manuscript/；缺图用占位并在文中标明待补；\n" +
      "5. 用本步骤 run 脚本渲染 PDF/docx（按 {skill:quarto-render} 技能）。**初稿固定用编号制（方括号 [1]）渲，不要问人要哪种引用格式**：YAML 写 `csl: citation.csl` 并放随包的 ieee.csl。引用格式到「润色与投稿准备」再问：沿用这份编号，或改成目标期刊。" + DRAFT_TYPEFACE + "产物写入本工作区 output/（评审合并后进项目根）。\n" +
      "完成标准：manuscript/draft.md 覆盖大纲各节，引用键全部可在 references.bib 解析，数字与结论条目、results-table.md 一致，run 脚本渲染通过。\n" +
      QUALITY_STATUS,
    inputs: [
      "manuscript/outline.md",
      "survey/",
      "notes/",
      "design.md",
      "analysis/results-table.md",
      "analysis/findings.md",
      "analysis/stats-check-results.md",
      "figures/*",
      "references.bib",
    ],
    expectedArtifacts: ["manuscript/draft.md", "manuscript/section-status.md", "manuscript/typeface.md", "manuscript/reference.docx", "output/draft.pdf", "output/draft.docx"],
    acceptanceCriteria: ["machine:contains:manuscript/section-status.md::要回答", "machine:contains:manuscript/section-status.md::允许集"],
    skills: ["research-writing", "quarto-render"],
    discussionSeeds: [
      "卖点怎么讲：贡献如何简洁陈述且不超过证据，Introduction 往哪个方向带？",
    ],
    humanTasks: [],
    // Quarto 可再生产物统一写入 output/，源稿仍留在 manuscript/；
    // RX4a 追加 export-docx：同一份 md 导出 draft.docx，与 render-draft 并存互不冲突
    run: [
      {
        name: "export-docx",
        command: "quarto render manuscript/draft.md --to docx --output-dir output",
        default: true,
      },
      {
        name: "render-draft",
        command: "quarto render manuscript/draft.md --to pdf --output-dir output",
        default: true,
      },
    ],
  },
  {
    name: "润色与投稿准备",
    role: "you",
    workspaceName: "research-paper-polish",
    brief:
      "输入：manuscript/draft.md、manuscript/section-status.md、analysis/results-table.md、references.bib（已随 main 合并在本工作区内）。\n" +
      REVIEW_FIRST +
      ENDNOTE_SYNC +
      "审查报告写 manuscript/review-report.md。第一轮按 {skill:bib-check} 写 manuscript/citation-check.md，并按 {skill:stats-check} 把统计问题写入 analysis/stats-check.md；这三份只列问题，不改稿。核对：每个论断有引用、未用 bib 条目只列出、图表编号连续、数字与 results-table.md 和已认可结论条目一致。\n" +
      "第二轮才改稿：语言只改表达。发现内容性错误标 [待核实]，不得自行改写事实。产出 manuscript/paper-final.md 与 manuscript/changelog.md。\n" +
      "投稿前清单写入 submission/pre-submission-checklist.md：目标期刊/会议（按主题匹配给出 2-3 个候选及理由）、cover letter 要点、图表源文件清单、代码/数据可用性占位、作者信息与利益声明占位；未知信息一律占位「待填」，不编造。\n" +
      STYLE_AT_FINAL + "用本步骤 run 脚本渲染 PDF/docx（按 {skill:quarto-render} 技能：人还没在流程线「更换引用样式」里换形式时，沿用初稿编号制渲，不因没选样式停渲）。正文字体沿用初稿 manuscript/typeface.md，不要另选字体，也不要重问。Word 加 --reference-doc manuscript/reference.docx。同一次再生成 output/endnote.docx 与 output/zotero.docx。产物写入本工作区 output/（评审合并后进项目根）。\n" +
      "完成标准：paper-final.md 引用闭环；manuscript/citation-check.md 与 analysis/stats-check.md 各节齐全，问题逐条处置；阻塞项未关闭时只交草稿，预清单注明不可投稿；changelog.md 与 submission/pre-submission-checklist.md 已提交；[待补实验] 不得仅删除标记；有证据补齐或经人确认撤回/缩窄对应主张，否则阻塞。\n" +
      RELEASE_GATE + QUALITY_STATUS,
    expectedArtifacts: [
      "manuscript/review-report.md",
      "manuscript/paper-final.md",
      "manuscript/citation-check.md",
      "output/paper-final.pdf",
      "output/paper-final.docx",
      "output/endnote.docx",
      "output/zotero.docx",
      "papers/endnote-cite-report.md",
      "papers/zotero-cite-report.md",
      "analysis/stats-check.md",
      "submission/pre-submission-checklist.md",
      "manuscript/changelog.md",
    ],
    acceptanceCriteria: ["machine:contains:manuscript/review-report.md::严重问题"],
    inputs: ["manuscript/draft.md", "manuscript/section-status.md", "manuscript/typeface.md", "manuscript/reference.docx", "manuscript/outline.md", "design.md", "analysis/results-table.md", "analysis/findings.md", "analysis/stats-check-results.md", "results/run-manifest.json", "notes/", "references.bib"],
    skills: ["bib-check", "stats-check", "quarto-render", "endnote-bridge", "zotero-sync"],
    humanTasks: [
      styleChoiceTask(),
      endnoteSyncTask(),
      reviewDecisionTask("manuscript/review-report.md"),
      {
        title: "核对 G5 证据就绪、作者信息与投稿目标",
        guidance:
          "submission/pre-submission-checklist.md 中的作者信息/利益声明「待填」占位逐条补齐；目标期刊候选 2-3 个已附理由，可改选",
        target: "submission/pre-submission-checklist.md",
        timing: "after",
        completion: "manual",
      },
    ],
    decisions: [
      
    ],
    // P4 quarto 渲染：定稿 paper-final.md → paper-final.pdf；RX4a 追加 export-docx → paper-final.docx
    run: [
      {
        name: "export-docx",
        command: "quarto render manuscript/paper-final.md --to docx --output-dir output",
        default: true,
      },
      {
        name: "render-final",
        command: "quarto render manuscript/paper-final.md --to pdf --output-dir output",
        default: true,
      },
    ],
  },
];

/** 数据处理（data-processing）：登记检查 → 清洗整理 → 探索性分析 → 分析报告 */
const DATA_PROCESSING_STEPS: ProjectStepDto[] = [
  {
    name: "数据登记与检查",
    role: "both",
    workspaceName: "data-inspect",
    brief:
      "输入：项目已登记的数据资源（见下方「项目资源」段；无登记资源时扫描项目目录中的 CSV/parquet/JSON 等数据文件，并把扫描依据写进报告）。全程只读：原始数据一个字节都不改；未有数据使用/外传授权时仅查看字段名、字典和非敏感聚合，不向模型或外部服务发送敏感行。\n" +
      "1. 逐数据集记录：来源、获取时间、规模（行数/大小）、格式与编码、字段清单，写入 data-dictionary.md；\n" +
      "2. 字段逐个标注类型/含义/取值范围/缺失比例；含义不明的字段标「待确认」，不猜测含义；\n" +
      "3. 质量问题单列一节：缺失、重复、异常取值、口径不一致，逐项给出样例行号或计数；\n" +
      "4. 敏感字段单列清单：疑似个人标识/隐私的字段只列字段名与判断依据，不复制内容样例；脱敏口径不写死，留人拍板（开工前的讨论种子已就此提问）；\n" +
      "5. 数据不可读或格式损坏时在报告中说明并停止，不自行修复原始数据。\n" +
      "完成标准：data-dictionary.md 覆盖全部数据集与字段；同步写 data/fields.json，每个字段一条稳定唯一字符串 id、name、type、status 记录；质量问题逐项有证据（行号/计数），敏感字段清单无内容样例。\n" +
      QUALITY_STATUS,
    expectedArtifacts: ["data-dictionary.md", "data/fields.json"],
    decisionMode: "hard_pause",
    acceptanceCriteria: [
      "machine:file:data-dictionary.md",
      "machine:contains:data-dictionary.md::字段",
      "machine:records:data/fields.json::id,name,type,status",
    ],
    skills: [],
    run: [],
    humanTasks: [
      {
        title: "解答「待确认」字段的业务含义",
        guidance:
          "data-dictionary.md 中标注「待确认」的字段逐条回复含义与口径；可直接改文件，或在对话中说明",
        target: "data-dictionary.md",
        timing: "after",
        completion: "manual",
      },
    ],
    decisions: [
      {
        q: "敏感字段怎么处理",
        options: ["先脱敏再分析", "无敏感字段，照常处理", "敏感字段整列排除"],
      },
    ],
    discussionSeeds: [
      "数据口径以哪份为准：多来源数据冲突时听谁的？",
    ],
  },
  {
    name: "清洗与整理",
    workspaceName: "data-clean",
    decisionMode: "hard_pause",
    brief:
      "输入：data-dictionary.md（已随 main 合并在本工作区内；其中「待确认」字段若已由人补全口径，以补全值为准）。全程按 {skill:data-clean} 技能执行：规则先行、原始数据只读。\n" +
      "1. **先报数再定规则**：统计各字段缺失率、重复行数、表间关系与行数量级，把「缺失率 Top5 字段 / 建议的处理方式 / 建议的分析粒度 / 要不要合表」写进 .ccode/help-wanted.md 问用户一句（附兜底：未回复只画像和生成规则草案，不应用影响主分析的待确认规则），写完仅推进无依赖、可逆的准备。；\n" +
      "2. 清洗规则逐项写死再动手：缺失值处理（删除/填充及填充值）、去重键、异常值边界、类型转换，写入 cleaning/rules.md，每条规则注明依据，不允许含糊执行规则；未批准的规则标阻塞且不得应用；\n" +
      "3. 清洗脚本放入 cleaning/（可重复执行；输入只读原始数据，不原地修改）；\n" +
      "4. 处理后的数据写入本工作区产物目录（见上方「产物目录」，相对路径），不进 git，评审合并后自动进项目根同名目录；同时产出 cleaning/cleaned-data-manifest.md，记录源文件、字节数/hash、输出文件的项目根相对路径、行列数与生成命令；\n" +
      "5. 清洗报告 cleaning/cleaning-report.md：每条规则影响的行数、丢弃数据的清单与原因、清洗前后规模对比，[待确认] 规则单列一节。\n" +
      "完成标准：rules.md 执行规则明确，关键待确认项未批准则阻塞；同步写 cleaning/fields.json，每个源字段保留 data/fields.json 的 id，记录 name/rule/status，删除或排除也留一条；新增派生字段另列在报告不混入源字段对账；脚本可重复跑通，manifest 与报告数字和产物目录结果一致，原始数据字节级未被改动；清洗入口交付 cleaning/clean.py，支持 --input/--output，manifest 中记录完整运行命令。\n" +
      QUALITY_STATUS,
    expectedArtifacts: [
      "cleaning/rules.md",
      "cleaning/cleaning-report.md",
      "cleaning/cleaned-data-manifest.md",
      "cleaning/fields.json",
      "cleaning/clean.py",
    ],
    acceptanceCriteria: [
      "machine:file:cleaning/rules.md",
      "machine:file:cleaning/cleaning-report.md",
      "machine:file:cleaning/cleaned-data-manifest.md",
      "machine:contains:cleaning/rules.md::依据",
      "machine:records:cleaning/fields.json::id,name,rule,status",
      "machine:same-ids:data/fields.json::cleaning/fields.json",
    ],
    inputs: ["data-dictionary.md", "data/fields.json"],
    skills: ["data-clean"],
    run: [],
    humanTasks: [
      {
        title: "拍板 [待确认] 清洗规则",
        guidance:
          "cleaning/rules.md 与 cleaning-report.md 中标注 [待确认] 的条目（多为粒度/合并与拿不准的填充值）逐条拍板；可直接改 rules.md，agent 会按新口径重跑清洗",
        target: "",
        timing: "after",
      },
    ],
    decisions: [{ q: "已确认的字段口径、分析单元和敏感数据处理依据（未知项列明不可处理范围）", options: [] }],
  },
  {
    name: "探索性分析",
    role: "both",
    workspaceName: "data-eda",
    decisionMode: "hard_pause",
    decisions: [{ q: "批准用于分析的清洗规则与数据版本（影响主分析的待确认规则必须先解决）", options: [] }],
    brief:
      "输入：cleaning/cleaned-data-manifest.md 与 cleaning/rules.md（已随 main 合并在本工作区内）、项目根产物目录中清洗后的数据（按 manifest 的项目根相对路径读取）。全程按 {skill:data-eda} 技能执行：分布/相关/异常全覆盖不挑选、图表可复现、发现可回溯。\n" +
      "1. 分析与出图脚本放入 analysis/，交付 analysis/reproduce.py（明确 --input/--output；前 40 行声明 # MESA_REPRODUCE: {\"interpreter\":\"python\",\"outputPlacement\":\"independent\",\"resultFile\":\"verification.json\"}；结果 verification.json 含 ok/checks/inputVersion，未验证不得写 ok=true；只读冻结数据，核对输入版本、重建主要表图/数字并比较参考值和容差；失败非零退出）；实际运行命令和结果写 stats-check-eda.md，缺环境则标未验证；\n" +
      "2. 分布分析：按变量类型选择图/摘要，ID 不强画分布；高维数据可分组并列未逐项覆盖范围，不按结果好看与否挑选；图表写入 figures/（英文标注，文件名与报告引用一一对应）；\n" +
      "3. 相关分析：按变量类型和问题选择相关/关联分析，排除 ID、无序类别等不适用字段并说明；报告选择口径、比较范围和多重性，不以固定 |r| 阈值筛选发现；\n" +
      "4. 异常分析：按 rules.md 的口径复查残留异常，新发现的异常标 [待确认] 并给出样例行号；\n" +
      "5. 在 analysis/stats-check-eda.md 记录主要数字从原始输出的复算命令、版本、容差和结果；同数据探索后做检验仍是探索，不因通过 {skill:stats-check} 变确证。\n" +
      "6. 结论写入 eda-report.md：按证据报告可用于后续决策的发现（允许零条或证据不足，不凑数量），每条附对应图表或统计量；含统计检验/显著性表述的结论先按 {skill:stats-check} 技能口径自查（检验方法与数据匹配、p 值给具体值、附效应量与置信区间）；问题清单写入 analysis/stats-check-eda.md。\n" +
      CLAIM_ENTRIES +
      "完成标准：analysis/ 脚本、analysis/stats-check-eda.md、figures/ 与 eda-report.md 均存在，每条发现可回溯到具体图表/数字，无主观臆断。\n" +
      QUALITY_STATUS,
    expectedArtifacts: ["analysis/stats-check-eda.md", "analysis/reproduce.py", "figures/*", "eda-report.md"],
    acceptanceCriteria: ["machine:contains:eda-report.md::结论条目"],
    inputs: ["cleaning/rules.md", "cleaning/cleaned-data-manifest.md"],
    optionalInputs: ["artifacts/"],
    skills: ["data-eda", "stats-check"],
    run: [],
  },
  {
    name: "分析报告",
    workspaceName: "data-report",
    brief:
      "输入：eda-report.md、figures/、data-dictionary.md（已随 main 合并在本工作区内）。\n" +
      "1. 围绕课题主题（见上方「课题主题」段；未填写时仅给描述性摘要，不从结果倒推事先研究问题）组织结论；\n" +
      "2. 产出 analysis-report.md：背景与数据口径 → 主要发现（引用 eda-report.md 条目）→ 结论 → 可执行建议（每条建议对应一条发现，优先级按确定规则排序：有直接数据支撑的排前，间接推断的排后并注明）；\n" +
      "3. 数字一律引用 eda-report.md 中的值，并引用「## 结论条目」的编号；不重新计算、不引入新数据。状态不是已认可的不得写成确证；证据不足的结论标 [待验证]；\n" +
      "4. 局限单列一节：数据质量、样本偏差、方法局限，不回避。\n" +
      "完成标准：analysis-report.md 结构完整，建议与发现一一对应且优先级有据；探索发现只作为待验证假设；[待验证] 不因列入局限就升级为结论。清洗步残留的 [待确认] 不在本步清除。\n" +
      QUALITY_STATUS,
    expectedArtifacts: ["analysis-report.md"],
    inputs: ["eda-report.md", "figures/*", "data-dictionary.md", "cleaning/cleaned-data-manifest.md", "cleaning/rules.md", "analysis/stats-check-eda.md", "analysis/reproduce.py"],
    skills: [],
    run: [],
    decisions: [],
  },
];

/** 毕业论文（thesis）：检索 → 精读 → 开题与综述 → 研究方法 → 实验 → 分析 → 初稿 → 定稿 */
const THESIS_STEPS: ProjectStepDto[] = [
  {
    name: "文献检索与筛选",
    role: "both",
    workspaceName: "lit-search",
    brief:
      "输入：课题主题（见上方「课题主题」段；未填写时提出候选主题写进 papers/screening.md，等待人确认后正式筛选）。接自上游英文综述/科研论文时 notes/ 与 included.md 随仓库自带，按日期/范围/版本检查后查漏补缺，保留人写内容，不把旧笔记存在当作仍然有效；没有上游时全量检索。全程按 {skill:lit-search} 技能。\n" +
      "1. **先粗检一轮报数再定标准**：OpenAlex 命中约 N 篇与建议标准写入 .ccode/help-wanted.md（未回复仅做无依赖、可逆准备）；纳入/排除标准（年份、语言、来源级别、相关性）写入 papers/screening.md；\n" +
      "2. 解析人工导入题录（项目根 papers/imports/、工作区 papers/imports/、项目资源与提货单绝对路径），去重进候选池；\n" +
      "3. 检索候选并逐条判定。" + LIT_SEARCH_NO_WASTE + "产出 papers/screening.md、papers/included.md 和 papers/included.json（每项稳定唯一字符串 id/title/decision/reason，与 md 一一对应）；拿不准一律保留为 pending 候选并标「待确认」，不冒充已决纳入；检索日期与覆盖缺口写入 screening.md；\n" +
      "4. " + LIT_PENDING_BEFORE_FETCH +
      "开放获取全文下载到**项目根 papers/**；付费墙写入 papers/to-fetch.md，并转成" + TO_FETCH_RIS + " 清单落盘后按 {skill:zotero-sync} 记录通道并写 papers/zotero-sync.md；未明确要求进库则不写用户 Zotero 库，通道不可用则只留 RIS/bib。已有 references.bib 时不得覆盖，只补空着的卷、期、页、ISSN、摘要、关键词和期刊缩写。\n" +
      "零结果也交付 included.json=[] 与说明，禁止造条目；没有可精读证据时后续只允许准备，不宣称完成研究。\n" +
      "完成标准：检索交付件存在（无付费文献则 to-fetch.md 说明无待获取，to-fetch.ris 与 endnote-import.ris 保留合法零条目空文件；未启用或回落时 zotero-sync.md 写明原因），每条记录无空缺字段，筛选可复现。\n" + QUESTION_GATE + QUALITY_STATUS,
    optionalInputs: ["notes/", "references.bib", "papers/included.md"],
    expectedArtifacts: [...LIT_SEARCH_ARTIFACTS],
    acceptanceCriteria: [
      "machine:file:papers/screening.md",
      "machine:file:papers/included.md",
      "machine:file:papers/to-fetch.md",
      "machine:optional-empty:papers/to-fetch.ris",
      "machine:optional-empty:papers/endnote-import.ris",
      "machine:file:papers/zotero-sync.md",
      "machine:contains:papers/screening.md::检索日期",
      "machine:records-allow-empty:papers/included.json::id,title,decision,reason",
    ],
    skills: ["lit-search", "zotero-sync"],
    requiredSkills: ["lit-search"],
    asksLitSource: true,
    run: [],
    humanTasks: litSearchHumanTasks(),
    decisions: [
      { q: "检索年限", options: ["近五年", "近十年", "不限年限"] },
      { q: "文献语言", options: ["中英文都要", "只要英文"] },
      { q: "预印本要不要纳入", options: ["纳入并标注", "不纳入"] },
    ],
  },
  {
    name: "文献精读与笔记",
    role: "both",
    workspaceName: "lit-notes",
    brief:
      "输入：papers/included.md 与 papers/to-fetch.md。全程按 {skill:lit-notes} 技能。已有 notes/ 先核对原文版本、全文状态和问题范围；有效则复用，变化则保留人写内容并更新受影响项。\n" +
      LIT_NOTES_WRITE +
      "1. 整理项目根 papers/ 人工补投并更新 to-fetch.md；\n" +
      "2. **先报清单规模与全文到位率，建议核心精读篇目**，写入 .ccode/help-wanted.md（未回复仅做可逆准备，不含批量生成笔记）；\n" +
      "3. 用户确认的核心篇有 PDF 的读正文按技能八段写笔记；其余按摘要写短记。全文未得按摘要写并标「仅摘要·待全文」。index pending 只留给待确认或无法按摘要写的篇。\n" +
      "4. 已对上 DOI 的 PDF 读首页和摘要页。标题、化学式上下标、摘要与 Crossref 纯文本不一致时，以 PDF 为准改 references.bib 的 title 和 abstract。抽不出字或对不上 DOI 的保持原字段。不在这一步重写 RIS。人点「同步到文献库」时，Mesa 按这份 references.bib 生成导入文件。\n" +
      "完成标准：notes/index.json 保留 included.json 的全部 id（仅待确认或无法按摘要写的篇 notePath 可空）；已写笔记符合 {skill:lit-notes} 写法。确认过的核心篇未写完、或已确认要按摘要记的非核心还没写完，则不得结束本轮等人，质量状态不得高于已生成待审。\n" + QUALITY_STATUS,
    inputs: ["papers/included.md", "papers/included.json", "papers/to-fetch.md"],
    optionalInputs: ["papers/*.pdf", "notes/", "references.bib"],
    expectedArtifacts: ["notes/*.md", "notes/index.json", "references.bib", "papers/to-fetch.md"],
    acceptanceCriteria: [LIT_NOTES_INDEX_RECORDS, "machine:same-ids:papers/included.json::notes/index.json"],
    skills: ["lit-notes"],
    run: [],
    decisions: [],
  },
  {
    name: "开题报告与综述",
    role: "both",
    workspaceName: "proposal",
    brief:
      "输入：notes/、papers/included.md 与 references.bib（已随 main 合并在本工作区内）。\n" +
      "1. 产出 proposal/proposal.md 开题报告（按 {skill:proposal-writer} 技能）：选题依据、研究内容、研究目标与创新点、技术路线、可行性与进度安排，引用只用 references.bib 已有键；\n" +
      APPROVED_QUESTION +
      "2. 产出 chapters/literature-review.md 综述章节草稿：框架构造按 {skill:review-framework} 技能（空白清单 → 范式卡片 → 融合），只引用 references.bib 中存在的键，不为综述新造引用。\n" +
      "完成标准：proposal.md 五节齐全；literature-review.md 引用键全部可解析，含框架推演或等价取舍说明。\n" +
      QUESTION_GATE + QUALITY_STATUS,
    inputs: ["notes/", "papers/included.md", "papers/included.json", "references.bib"],
    expectedArtifacts: ["proposal/proposal.md", "chapters/literature-review.md"],
    acceptanceCriteria: ["machine:contains:proposal/proposal.md::已批准问题与范围"],
    skills: ["proposal-writer", "review-framework"],
    run: [],
    humanTasks: [
      {
        title: "开题报告送导师评阅",
        guidance:
          "proposal/proposal.md 可直接发导师；导师意见自行记录，可追加到该文件末尾供后续步骤参考",
        target: "",
        timing: "after",
        optional: true,
        completion: "manual",
      },
      {
        title: "开题答辩（如培养方案有）",
        guidance:
          "有开题答辩的把评委意见记进 proposal/proposal.md 末尾；培养方案没有这一环就跳过",
        target: "",
        timing: "after",
        optional: true,
        completion: "manual",
      },
    ],
    discussionSeeds: [
      "研究问题聚焦到哪：导师给的大方向里，切哪一块是你真能做完的？",
    ],
  },
  {
    name: "研究方法",
    role: "both",
    workspaceName: "methodology",
    decisionMode: "hard_pause",
    brief:
      "输入：proposal/proposal.md 的研究内容与技术路线、chapters/literature-review.md（已随 main 合并在本工作区内）。\n" +
      "1. 产出 chapters/methodology.md 方法章节草稿：方法原理、实现步骤、数据来源与预处理、评价指标，逐节对应开题报告的研究内容；\n" +
      "2. 产出 design.md 实验设计，并写 experiments/matrix.json（每项稳定唯一字符串 id、configuration、status，禁止省略经批准取消项）：对比基线（注明出处）、实验矩阵（按问题预先选定组合，不强制全因子穷举）、预期结果与分析方式；统计设计按 {skill:stats-check} 技能的实验设计口径自查（主要结局及比较明确（共同主结局须说明多重性策略）、样本量有依据、剔除标准事先定义），涉及统计检验的写明检验方法与多重比较校正口径，问题清单写入 analysis/methodology-stats-check.md；\n" +
      "3. 每个方法选择给出依据；与开题报告不一致的改动在 methodology.md 末尾「变更说明」记录原因，不静默改方案；\n" +
      "4. 依赖的资源不可获取时提出替代品及研究对象/结论范围变化，待人批准后才替换；未批准标阻塞。\n" +
      APPROVED_DESIGN +
      "完成标准：methodology.md 覆盖开题全部研究内容，design.md 实验矩阵可直接执行；analysis/methodology-stats-check.md 各节齐全，关键未决项已处理或明确阻塞，不以猜测填满。\n" +
      DESIGN_GATE + QUALITY_STATUS,
    expectedArtifacts: ["chapters/methodology.md", "design.md", "analysis/methodology-stats-check.md", "experiments/matrix.json"],
    acceptanceCriteria: ["machine:records:experiments/matrix.json::id,configuration,status", "machine:contains:design.md::已批准设计"],
    inputs: ["proposal/proposal.md", "chapters/literature-review.md"],
    skills: ["stats-check"],
    run: [],
    humanTasks: [
      {
        title: "与导师确认方法与技术路线",
        guidance:
          "methodology.md 与开题报告不一致的改动见文末「变更说明」，逐条与导师过一遍再开实验",
        target: "",
        timing: "after",
      },
    ],
    decisions: [{ q: "确认的研究问题与范围（填写 G1 评阅依据和批准版本）", options: [] }],
    discussionSeeds: [
      "基线与评价指标怎么定：跟谁比、比到什么程度算达到预期？",
    ],
  },
  {
    name: "实验执行",
    workspaceName: "thesis-exp-run",
    decisionMode: "hard_pause",
    brief:
      "输入：design.md 的实验矩阵、chapters/methodology.md（已随 main 合并在本工作区内）。\n" +
      "1. 实验代码放入 experiments/（可重复执行，参数集中在文件头或配置文件），逐项跑实验矩阵；\n" +
      "2. 原始结果与日志写入本工作区产物目录（见上方「产物目录」，相对路径），不进 git，评审合并后自动进项目根同名目录；results/summary.md 逐项记录：配置、指标数值、产物的项目根相对路径；\n" +
      "3. 失败实验在 summary.md 标注原因并按 design.md 的备选方案重跑一次，仍失败则记录后继续；\n" +
      "完成标准：同步写 results/matrix.json，每个计划 id 一条 configuration/status；矩阵每项都有结果或失败记录，experiments/ 与 results/summary.md 已提交，原始结果全部落在本工作区产物目录（评审合并后进项目根）。\n" +
      EXECUTION_GATE + QUALITY_STATUS,
    expectedArtifacts: ["results/summary.md", "results/matrix.json", "results/implementation-check.md", "results/run-manifest.json", "experiments/reproduce.py"],
    acceptanceCriteria: [
      "machine:file:results/summary.md",
      "machine:contains:results/summary.md::配置",
      "machine:records:results/matrix.json::id,configuration,status",
      "machine:records:results/run-manifest.json::id,dataHash,codeVersion,environment,command,status,outputs",
      "machine:same-ids:experiments/matrix.json::results/matrix.json",
      "machine:same-ids:experiments/matrix.json::results/run-manifest.json",
    ],
    inputs: ["experiments/matrix.json", "design.md", "chapters/methodology.md"],
    skills: [],
    run: [],
    humanTasks: [
      {
        title: "确认伦理/数据许可适用性与批准依据",
        guidance: "在 design.md 记录是否适用及核验依据；需要的许可未获得时不得采集/运行，不以勾选代替批准。",
        target: "",
        timing: "before",
        completion: "manual",
      },
      {
        title: "准备数据集与算力访问",
        guidance:
          "design.md 所列数据集/模型若需申请或登录（公开数据集协议、机构集群账号等），开工前完成授权",
        target: "",
        timing: "before",
      },
    ],
    decisions: [{ q: "批准运行的设计版本、范围及必要授权依据（未获批不得填写为已批准）", options: [] }],
  },
  {
    name: "结果分析与章节",
    role: "both",
    workspaceName: "thesis-exp-analysis",
    brief:
      "输入：上一步 results/summary.md 与项目根产物目录中的原始结果（项目根相对路径见 summary.md，按项目根绝对路径读取）。\n" +
      "1. 汇总各实验主指标，与基线逐项对比，产出 chapters/results.md：表格（方法 × 指标，同时报告不确定性；最优值不等于重要或显著）+ 关键图表（figures/ 主交付 SVG 或 PNG，投稿用 PDF 副本写本工作区 output/figures/（合并后进项目根），出图按 {skill:figure-forge} 技能）+ 逐项解读；\n" +
      "2. 只用 summary.md 中的数字下结论，推测性内容标 [推测]；失败/离群结果单独说明，不删除不美化；涉及统计显著性的表述按 {skill:stats-check} 技能口径（p 值给具体值、附效应量与置信区间），问题清单写入 analysis/thesis-results-stats-check.md；\n" +
      "3. 对照 proposal/proposal.md 的创新点：哪些被结果支撑、哪些要降级或改口，写进 chapters/results.md 末尾；结果不如预期时，先基于实际异常、补实验成本与 design.md 的停止规则写入 .ccode/help-wanted.md 问用户；不得在看到结果前预设换方向。\n" +
      CLAIM_ENTRIES +
      "完成标准：chapters/results.md、analysis/thesis-results-stats-check.md、figures/ 已提交，每条结论可追溯到 summary.md 的数字。\n" +
      EVIDENCE_GATE + QUALITY_STATUS,
    inputs: ["experiments/reproduce.py", "results/run-manifest.json", "results/matrix.json", "results/implementation-check.md", "design.md", "results/summary.md", "proposal/proposal.md"],
    optionalInputs: ["artifacts/"],
    expectedArtifacts: ["chapters/results.md", "analysis/thesis-results-stats-check.md", "figures/*"],
    acceptanceCriteria: ["machine:contains:chapters/results.md::结论条目"],
    skills: ["figure-forge", "stats-check"],
    run: [],
    decisions: [],
  },
  {
    name: "论文初稿",
    workspaceName: "thesis-draft",
    brief:
      "输入：chapters/ 各章草稿、references.bib、figures/、proposal/proposal.md（已随 main 合并在本工作区内）。\n" +
      `写作范围由你按笔记与各章草稿判断：${DRAFT_EVIDENCE_DEFAULT}。人在审阅初稿时拍板，开工前不再问范围。\n` +
      SECTION_STATUS +
      "1. 按学校论文模板结构（封面/摘要/目录/正文各章/参考文献/致谢；项目内无模板文件时用通用学位论文结构、语种默认中文，并在 manuscript/README.md 注明所依据的结构）组装全文初稿 manuscript/thesis-draft.md；学校要求独立讨论章则保留讨论章，不要并进结论；\n" +
      "2. 补齐缺失章节：引言（研究背景+问题+贡献，对应开题报告）、结论与展望（对应结果章节）；\n" +
      "3. 统一各章术语、符号与图表编号；引用一律 [@bib键] 且只能引用 references.bib 已有键——严禁编造文献；\n" +
      "4. 图表引用占位（「图 3-1：…」），数字与 chapters/results.md 一致，不一致处以结果章节为准并在修订记录标注；\n" +
      "5. 产出 manuscript/revision-notes.md：组装过程中的取舍与待确认项；\n" +
      "6. 渲染验证：用本步骤 run 脚本渲染 PDF/docx（环境检查、编号引用 YAML、产物登记按 {skill:quarto-render} 技能）。**初稿固定用编号制（方括号 [1]）渲，不要问人要哪种引用格式**：YAML 写 `csl: citation.csl` 并放随包的 ieee.csl。引用格式到「格式与定稿」再问：沿用这份编号，或改成目标期刊。" + DRAFT_TYPEFACE + "中文稿的中文用宋体。渲染报错先按技能指引补依赖，不绕路。\n" +
      "完成标准：thesis-draft.md 章节齐全、引用闭环、revision-notes.md 已提交、run 脚本渲染通过。\n" +
      QUALITY_STATUS,
    expectedArtifacts: [
      "manuscript/thesis-draft.md",
      "manuscript/section-status.md",
      "manuscript/revision-notes.md",
      "manuscript/typeface.md",
      "manuscript/reference.docx",
      "output/thesis-draft.pdf",
      "output/thesis-draft.docx",
    ],
    acceptanceCriteria: ["machine:contains:manuscript/section-status.md::要回答", "machine:contains:manuscript/section-status.md::允许集"],
    inputs: ["chapters/", "analysis/thesis-results-stats-check.md", "references.bib", "figures/*", "proposal/proposal.md"],
    skills: ["quarto-render"],
    discussionSeeds: [
      "章节权重怎么分：哪几章是答辩老师最看重、要重点打磨的？",
      "学校的字数与章节要求是什么：有没有硬性模板要对齐？",
    ],
    humanTasks: [
      {
        title: "放入学校格式规范与论文模板",
        guidance:
          "学校官网/研究生院下载的格式规范与模板文件，放到项目目录即可；没有时 agent 按通用学位论文规范执行并注明依据。越早放入，初稿结构越少返工。初稿固定按编号制渲，引用格式在「格式与定稿」的「更换引用样式」里定。",
        target: "",
        timing: "before",
      },
    ],
    // Quarto 渲染：源稿留在 manuscript/，PDF/DOCX 统一落到 output/。
    run: [
      {
        name: "export-docx",
        command: "quarto render manuscript/thesis-draft.md --to docx --output-dir output",
        default: true,
      },
      {
        name: "render-draft",
        command: "quarto render manuscript/thesis-draft.md --to pdf --output-dir output",
        default: true,
      },
    ],
  },
  {
    name: "格式与定稿",
    role: "you",
    workspaceName: "thesis-final",
    brief:
      "输入：manuscript/thesis-draft.md、manuscript/section-status.md、references.bib（已随 main 合并在本工作区内）。\n" +
      REVIEW_FIRST +
      ENDNOTE_SYNC +
      "审查报告写 manuscript/review-report.md。第一轮只核对，不改正文：格式问题写入 manuscript/format-check.md；引用闭环按 {skill:bib-check} 写入 manuscript/citation-check.md；查重降重建议写入 manuscript/plagiarism-advice.md，只给改写建议，不直接代写。\n" +
      "第二轮才产出 manuscript/thesis-final.md 与 manuscript/changelog.md。语言只改表达；内容性错误标 [待核实]。同时交 output/endnote.docx 与 output/zotero.docx 两份带引用域的 Word。\n" +
      "6. " + STYLE_AT_FINAL + "渲染验证：用本步骤 run 脚本渲染 PDF/docx（环境检查、编号引用 YAML、产物登记按 {skill:quarto-render} 技能：人还没在流程线「更换引用样式」里换形式时，沿用初稿编号制渲，不因没选样式停渲）。正文字体沿用初稿 manuscript/typeface.md，不要另选字体，也不要重问。Word 加 --reference-doc manuscript/reference.docx。同一次再生成 output/endnote.docx 与 output/zotero.docx。\n" +
      "完成标准：format-check.md 与 citation-check.md 问题逐条有处理结论，thesis-final.md 引用闭环，changelog.md 已提交，run 脚本渲染通过。\n" +
      RELEASE_GATE + QUALITY_STATUS,
    expectedArtifacts: [
      "manuscript/review-report.md",
      "manuscript/thesis-final.md",
      "manuscript/citation-check.md",
      "manuscript/format-check.md",
      "manuscript/plagiarism-advice.md",
      "manuscript/changelog.md",
      "output/thesis-final.pdf",
      "output/thesis-final.docx",
      "output/endnote.docx",
      "output/zotero.docx",
      "papers/endnote-cite-report.md",
      "papers/zotero-cite-report.md",
    ],
    acceptanceCriteria: ["machine:contains:manuscript/review-report.md::严重问题"],
    inputs: ["manuscript/thesis-draft.md", "manuscript/section-status.md", "manuscript/typeface.md", "manuscript/reference.docx", "chapters/results.md", "analysis/thesis-results-stats-check.md", "results/run-manifest.json", "notes/", "references.bib"],
    skills: ["bib-check", "quarto-render", "endnote-bridge", "zotero-sync"],
    humanTasks: [
      styleChoiceTask(),
      endnoteSyncTask(),
      reviewDecisionTask("manuscript/review-report.md"),
      {
        title: "按 G5 核验证据、送导师审阅并完成学校要求",
        guidance:
          "thesis-final.md 渲染后送导师；查重渠道以学校要求为准，高重复风险段落见 manuscript/plagiarism-advice.md；查重目标见项目层全局设定",
        target: "",
        timing: "after",
      },
    ],
    decisions: [],
    // Quarto 渲染：定稿源稿留在 manuscript/，PDF/DOCX 统一落到 output/。
    run: [
      {
        name: "export-docx",
        command: "quarto render manuscript/thesis-final.md --to docx --output-dir output",
        default: true,
      },
      {
        name: "render-final",
        command: "quarto render manuscript/thesis-final.md --to pdf --output-dir output",
        default: true,
      },
    ],
  },
];

/** 投稿与返修（submission-rebuttal）：期刊格式适配 → 投稿材料 → 审稿意见逐条回复 */
const SUBMISSION_INITIAL_STEPS: ProjectStepDto[] = [
  {
    name: "期刊格式适配",
    role: "both",
    workspaceName: "journal-format",
    brief:
      "输入：manuscript/paper-final.md 或 manuscript/review-final.md 或 manuscript/thesis-final.md、references.bib（接自上游模板时随仓库合并自带；独立启动本项目时，先把上游成稿与 references.bib 放入对应目录，或在资源面板绑定上游项目目录；项目工具选择 LaTeX 时用 manuscript/main.tex，选择 Word 时用 manuscript/source.docx：保留原件与插件域，不用 Markdown 往返覆盖；formatted.md 仅作适配说明，正式交付沿用原生格式并在清单写路径。已选原生稿件不得假装普通 docx 含引用域。这些稿件都不存在时在报告中说明并停止，不自行改用其他草稿）。\n" +
      REVIEW_FIRST +
      ENDNOTE_SYNC +
      "审查报告写 submission/review-report.md，引用问题同时写入 submission/citation-check.md。这两份先写完并等人决定，再做下面的适配。\n" +
      "1. 确定目标期刊：项目根已有 submission/target-journal.md 且写了期刊名时直接沿用，不再另给候选；没有则按课题主题给出 2-3 个候选期刊及理由，写入 submission/target-journal.md，等用户确认再做期刊专属适配；未确认只整理通用材料；\n" +
      "2. 获取目标期刊官方作者指南（WebFetch 期刊官网 Guide for Authors；获取失败时只做通用草稿并记录无法核验官方要求，不声称期刊格式通过）；\n" +
      "3. 人决定审查报告之后，按指南逐项适配：章节结构、引用与文献列表格式、图表规范、字数与摘要长度；产出 submission/formatted.md，只改格式与表达，不改学术观点与数据。若相对上游成稿改了数字或结论，必须在 submission/format-notes.md 逐条点名位置、旧值、新值和原因；只改格式与措辞的不写入该节；\n" +
      "4. 字数或摘要超限时不得自行删内容：在 formatted.md 原位标注超出量，把可选裁剪方案（砍哪节、砍多少）逐条写进 submission/format-notes.md 由用户定夺；\n" +
      "5. 引用完整性自查（按 {skill:bib-check} 技能）：报告写入 submission/citation-check.md；并把需要用户处理的摘要同步写入 submission/format-notes.md；\n" +
      "6. 作者单位/基金号/通讯邮箱等未知信息一律占位「待填」，不编造；所有未决项汇总进 submission/format-notes.md；\n" +
      "7. 换期刊时读该刊作者须知，并从 references.bib 取该刊最近 2–3 篇综述核对实际排法；库里没有就写明，两边不一致就停下来问。用本步骤 run 脚本渲染 PDF/docx（按 {skill:quarto-render} 技能：人在流程线「更换引用样式」选定具体形式后再按其重渲），产物写入本工作区 output/formatted.pdf 与 formatted.docx（评审合并后进项目根）。同一次从 submission/formatted.md 重新生成 output/endnote.docx 与 output/zotero.docx。\n" +
      "完成标准：submission/formatted.md、submission/target-journal.md、submission/citation-check.md 与 submission/format-notes.md 均已提交；format-notes.md 逐项给出处理结论；run 脚本渲染通过。\n" +
      "格式适配只核对期刊要求及记录证据缺口，引用上游有效审查；不重复复算或代替 G5。未解决项交下一步投稿材料统一关闭。\n" + QUALITY_STATUS,
    expectedArtifacts: [
      "submission/review-report.md",
      "submission/formatted.md",
      "submission/target-journal.md",
      "submission/format-notes.md",
      "submission/citation-check.md",
      "output/formatted.pdf",
      "output/formatted.docx",
      "output/endnote.docx",
      "output/zotero.docx",
      "papers/endnote-cite-report.md",
      "papers/zotero-cite-report.md",
    ],
    acceptanceCriteria: ["machine:contains:submission/review-report.md::严重问题"],
    inputs: ["references.bib"],
    optionalInputs: ["notes/", "analysis/", "results/", "design.md", "outline.md", "submission/pre-submission-checklist.md"],
    anyOfInputs: [MANUSCRIPT_FINALS],
    skills: ["bib-check", "quarto-render", "endnote-bridge", "zotero-sync"],
    run: [
      {
        name: "export-docx",
        command:
          "quarto render submission/formatted.md --to docx --output-dir output --output formatted.docx",
        default: true,
      },
      {
        name: "render-formatted",
        command:
          "quarto render submission/formatted.md --to pdf --output-dir output --output formatted.pdf",
        default: true,
      },
    ],
    humanTasks: [
      {
        title: "放入成稿与 references.bib",
        guidance:
          "独立启动本模板时，把上游成稿（manuscript/paper-final.md、review-final.md 或 thesis-final.md）与 references.bib 放入项目对应目录；接自上游模板时随仓库合并自带，可跳过",
        target: "manuscript/",
        timing: "before",
      },
      {
        title: "写下已定目标期刊（如已确定）",
        guidance:
          "已确定期刊时在 submission/target-journal.md 写明刊名与理由；没有则 agent 会给 2-3 个候选并标注「待用户确认」",
        target: "submission/target-journal.md",
        timing: "before",
        optional: true,
      },
      styleChoiceTask(),
      endnoteSyncTask(),
      {
        ...reviewDecisionTask("submission/review-report.md"),
        guidance:
          "报告写出来后，在这一行逐条点接受、拒绝或修改。点完会回到原来的对话，按决定继续改稿。改过数字或结论的，在 format-notes.md 能点到名。",
      },
      {
        title: "拍板目标期刊、字数裁剪方案并补齐「待填」信息",
        guidance:
          "期刊候选与字数超限裁剪方案（如有）见 submission/target-journal.md 与 format-notes.md；作者单位/基金号/通讯邮箱等占位在 formatted.md 与 format-notes.md 中汇总",
        target: "",
        timing: "after",
        completion: "manual",
      },
    ],
    // 「目标期刊怎么选」提到项目层（它是这条流程的前提，不是第 1 步的战术问题）；
    // 「字数超标先砍哪部分」改按需问——得先知道超了多少（见简报）
    decisions: [
    ],
  },
  {
    name: "投稿材料",
    role: "you",
    workspaceName: "submission-materials",
    brief:
      "输入：submission/formatted.md、submission/target-journal.md（已随 main 合并在本工作区内）。\n" +
      "1. 产出 submission/cover-letter.md：编辑称呼占位、研究问题与有证据支持的亮点（不凑数量）、与期刊读者群的契合点、原创性与未一稿多投声明（占位「待填」处不编造）；\n" +
      "2. 产出 submission/highlights.md：按目标期刊要求与实际贡献写 highlights（目标期刊无此要求时在该文件注明并跳过）；\n" +
      "3. 投稿前自查 formatted.md（模拟审稿人视角逐项过）：摘要与结论自洽、正文数字与表格一致、图表 standalone 可读、方法节可复现、局限有交代；问题按 CRITICAL（不处理大概率被拒，如数据不一致）/ MAJOR（影响评审印象）/ MINOR（措辞格式）三级写入 submission/pre-review.md。每条末尾写「决定：待定」。只有人改成接受、拒绝或修改，该条才算已处理；不得代填决定。CRITICAL/MAJOR 还要有修正证据或经人确认撤回受影响主张；无法解决则阻塞，不以说明理由代替解决，MINOR 列出即可；\n" +
      "4. 产出 submission/checklist.md 投稿清单：投稿系统入口（未知标「待填」）、需上传文件清单、作者信息与利益声明占位、推荐审稿人 2-4 位（只给研究领域与选择理由，具体姓名标「待填」）。\n" +
      "完成标准：cover-letter.md、highlights.md、pre-review.md、checklist.md 均已提交；pre-review.md 中 CRITICAL/MAJOR 全部有复核证据；未关闭时就绪度为阻塞，不能提交。\n" +
      RELEASE_GATE + QUALITY_STATUS,
    expectedArtifacts: [
      "submission/cover-letter.md",
      "submission/highlights.md",
      "submission/pre-review.md",
      "submission/checklist.md",
    ],
    inputs: ["submission/formatted.md", "submission/target-journal.md", "submission/citation-check.md", "submission/format-notes.md"],
    optionalInputs: ["notes/", "analysis/", "results/", "design.md"],
    skills: [],
    run: [],
    humanTasks: [
      {
        title: "按 G5 确认无阻塞问题、补齐声明并决定是否提交",
        guidance:
          "checklist.md 中投稿系统入口、作者信息与利益声明逐条补齐；推荐审稿人只给了研究领域与选择理由，具体姓名由你定",
        target: "submission/checklist.md",
        timing: "after",
        completion: "manual",
      },
    ],
    discussionSeeds: [
      "给编辑说明什么：哪些贡献有直接证据，为什么适合期刊读者？",
      "推荐审稿人怎么圈：避开利益冲突又要懂行，从哪些组里挑？",
    ],
  },
];

/** 投稿模板的返修分支：每一轮都使用轮次化输入/产物，避免第二轮覆盖第一轮的证据链。 */
function submissionRevisionSteps(round: number): ProjectStepDto[] {
  const r = Math.max(1, Math.floor(round));
  const previous = r === 1 ? "manuscript/paper-final.md" : `manuscript/revised-r${r - 1}.md`;
  const previousLabel =
    r === 1
      ? "submission/formatted.md，否则 manuscript/paper-final.md / review-final.md / thesis-final.md"
      : previous;
  const previousInputs =
    r === 1
      ? ["submission/formatted.md", ...MANUSCRIPT_FINALS]
      : [previous];
  return [
    {
      name: `审稿意见回复（第${r}轮）`,
      role: "you",
      workspaceName: `rebuttal-r${r}`,
      brief:
        `输入：reviews/round-${r}.md 审稿意见全文（用户把编辑来信保存为该文件；缺失时提示用户提供并停止，不得编造审稿意见）；${previousLabel}（上一版成稿）。\n` +
        "全程按 {skill:rebuttal-crafter} 技能执行。只允许在本步骤 TASK.md 明确的上一版稿件上修改，并将每处修改绑定审稿意见编号。若用户撤回授权，则只生成回复信和对照表，不改正文。\n" +
        `科学改动（数字、因果、样本、结论范围）先写入 rebuttal/review-report-r${r}.md。报告用 ## 严重问题、## 一般问题、## 建议，条目用 S001，避免和审稿意见编号混用。人把每条写成接受、拒绝或修改之前，不得把这些改动写进修订稿。revisions 表把科学改动单列，措辞另列。\n` +
        ENDNOTE_SYNC +
        "1. 逐条拆分审稿意见并编号（R1.1、R1.2…，多位审稿人分节，编辑意见单列 E.1…），不遗漏任何一条；\n" +
        `2. 产出 rebuttal/response-letter-r${r}.md，逐条回应：意见摘要 → 回应（接受修改 / 部分接受并说明限制 / 礼貌反驳并给依据）→ 稿件修改位置；拿不准的一律标 [待确认]；\n` +
        `3. 审查报告里的科学改动已有人的决定后，才在 ${previousLabel} 基础上修改，产出 manuscript/revised-r${r}.md，并在修改处标注对应意见编号；需要补实验/补数据的只写可执行计划并标 [待补实验]，不开空头支票；\n` +
        `4. 产出 rebuttal/revisions-r${r}.md：每条意见 → 修改点 → revised-r${r}.md 位置，逐条可核对；\n` +
        `5. 按 {skill:bib-check} 技能核对 revised-r${r}.md 与 references.bib，报告写入 rebuttal/citation-check-r${r}.md；\n` +
        `6. 产出 submission/resubmission-checklist-r${r}.md：上传文件、回复信/修订稿版本、逐项确认项与未决事项；提交前由人核对，不能把「已生成」当作「已提交」。\n` +
        `换期刊时读该刊作者须知，并从 references.bib 取该刊最近 2–3 篇综述核对实际排法；库里没有就写明，两边不一致就停下来问。用本步骤 run 脚本渲染修订清稿 PDF/docx（按 {skill:quarto-render} 技能：人在流程线「更换引用样式」选定具体形式后再按其重渲），并重新生成 output/endnote.docx 与 output/zotero.docx。改动按 revisions-r${r}.md 核验，期刊要求标改稿时另行按官方格式制作并登记，未制作不写已交付。\n` +
        `完成标准：round-${r} 的回复信、修改对照表、citation-check 报告、修订稿、再投稿清单均存在且一一对应；[待确认]/[待补实验] 在清单末尾汇总。涉及补研究须先回到设计→执行→分析→复算，使用本轮独立产物并更新所有受影响数字与主张；只有计划时维持阻塞，不写已完成。\n` + RELEASE_GATE + QUALITY_STATUS,
      inputs: [`reviews/round-${r}.md`, "references.bib"],
      anyOfInputs: [previousInputs],
      optionalInputs: ["notes/", "analysis/", "results/", "design.md", "submission/pre-review.md"],
      expectedArtifacts: [
        `rebuttal/review-report-r${r}.md`,
        `rebuttal/response-letter-r${r}.md`,
        `rebuttal/revisions-r${r}.md`,
        `rebuttal/citation-check-r${r}.md`,
        `manuscript/revised-r${r}.md`,
        `output/revised-r${r}.pdf`,
        `output/revised-r${r}.docx`,
        `submission/resubmission-checklist-r${r}.md`,
      ],
      acceptanceCriteria: [`machine:contains:rebuttal/review-report-r${r}.md::严重问题`],
      skills: ["rebuttal-crafter", "bib-check", "quarto-render"],
      run: [
        { name: `export-revised-r${r}`, command: `quarto render manuscript/revised-r${r}.md --to docx --output-dir output`, default: true },
        { name: `render-revised-r${r}`, command: `quarto render manuscript/revised-r${r}.md --to pdf --output-dir output`, default: true },
      ],
      humanTasks: [
        styleChoiceTask(),
        endnoteSyncTask(),
        {
          ...reviewDecisionTask(`rebuttal/review-report-r${r}.md`),
          guidance: `报告写出来后，在这一行逐条点接受、拒绝或修改。点完会回到原来的对话。没有决定之前，科学改动不会进修订稿。`,
        },
        {
          title: `保存第${r}轮审稿意见全文`,
          guidance: `把编辑来信/审稿意见保存为 reviews/round-${r}.md；缺该文件 agent 会停止`,
          target: `reviews/round-${r}.md`,
          timing: "before",
        },
        {
          title: "确认 [待确认] 回应口径并安排补实验",
          guidance:
            `response-letter-r${r}.md 中标注 [待确认]/[待补实验] 的条目逐条拍板；处理结论写回再投稿清单`,
          target: "",
          timing: "after",
          completion: "manual",
        },
        {
          title: `返修第${r}轮定稿后提交`,
          guidance: `用 submission/resubmission-checklist-r${r}.md 逐项核对后，到投稿系统上传修订稿与回复信`,
          target: "",
          timing: "after",
          completion: "manual",
        },
      ],
      decisions: [
        {
          q: "回复策略怎么定",
          options: ["意见尽量接受修改", "该反驳的坚决反驳"],
        },
      ],
      discussionSeeds: [
        "补实验的底线在哪：审稿人要的新实验哪些做哪些拒，时间与资源预算卡在哪？",
      ],
    },
  ];
}

/** 选择模板实际要追加的步骤；投稿模板必须先选首投/返修分支。 */
export function pipelineStepsForTemplate(
  template: PipelineTemplateDef,
  mode: SubmissionMode = "initial",
  round = 1,
): ProjectStepDto[] {
  if (template.id !== "submission-rebuttal") return contractizeSteps(template.steps);
  return mode === "revision"
    ? researchQualitySteps(submissionRevisionSteps(round))
    : researchQualitySteps(SUBMISSION_INITIAL_STEPS);
}

/** LaTeX 论文（latex-paper）：搭建骨架 → 章节写作 → 编译与排错 → 定稿导出（批次 E）。
 *  编译脚本 render-pdf 四步共用：优先 tectonic（轻量、自动下载宏包），缺则 latexmk，
 *  都没有则非零退出并打印安装引导——应用内不做安装器，检测引导就放在脚本里 */
const LATEX_RENDER_PDF_CMD =
  'mkdir -p output && (cd manuscript && if command -v tectonic >/dev/null 2>&1; then tectonic --keep-logs --outdir ../output main.tex; ' +
  'elif command -v latexmk >/dev/null 2>&1; then engine=-pdf; if grep -Eq "ctex|xeCJK|fontspec" main.tex; then engine=-xelatex; fi; ' +
  'latexmk "$engine" -interaction=nonstopmode -outdir=../output -auxdir=../output main.tex; ' +
  'else echo "未检测到 LaTeX 编译环境：安装 tectonic 或 TeX Live/MiKTeX 获得 latexmk"; exit 1; fi) > output/compile.log 2>&1; status=$?; cat output/compile.log; (exit "$status")';

const LATEX_PAPER_STEPS: ProjectStepDto[] = [
  {
    name: "搭建骨架",
    role: "both",
    workspaceName: "latex-skeleton",
    brief:
      "输入：课题主题（见上方「课题主题」段）。若存在成稿（manuscript/paper-final.md、review-final.md、thesis-final.md 或 draft.md），本步是排版后端：按成稿转成 LaTeX 骨架与章节文件，**不改学术观点与数据**。没有成稿时可从 notes/ 与 references.bib 搭草稿骨架；没有证据库只能做空骨架，在 README 注明‘结构样稿，不是科研成稿’，不得补写研究结果。\n" +
      "1. 文档类按开工前定下的选择（见任务书草稿决策段；未选则按项目层「目标期刊或学校」推断：中文正文用 ctexart，Elsevier 系用 elsarticle，IEEE 用 IEEEtran，ACS 系用 achemso，学位论文用通用学位架；都套不上就用 article 并在 manuscript/README.md 说明依据）。elsarticle/IEEEtran/achemso/ctexart 这些类 TeXLive 自带，tectonic 也会按需自动下载，不要自己去找 .cls 文件；\n" +
      "2. 若 manuscript/template/ 目录存在（人工事项放入的期刊官方模板），先读其中的 README/说明与示例 .tex，以模板文件为底做适配（documentclass、宏包、章节命令都按模板口径），不要从零另起一套；\n" +
      "3. 产出 manuscript/main.tex（文档类 + 宏包 + \\input 各章）与 manuscript/chapters/ 下每章一个 .tex。有成稿时按成稿切章，每章放入对应正文；无成稿时每章先放节标题骨架与一句话要点；\n" +
      "4. 参考文献沿用 references.bib：natbib 或 biblatex 二选一（开工前决策；未选定则按文档类惯常搭配——elsarticle/IEEEtran 配 natbib 系，其余配 biblatex），在 main.tex 接好；已有 figures/ 时用 \\includegraphics 引用，不要把图复制进 manuscript/；\n" +
      "5. 冒烟编译：骨架必须能编译出 PDF（用本步骤 run 脚本 render-pdf；本机没装编译环境时把脚本打印的安装提示写进 .ccode/help-wanted.md 提醒用户，装好前不卡在等待）。\n" +
      "完成标准：manuscript/main.tex 与 chapters/ 各章文件存在且能编译出 PDF；references.bib 已接入；manuscript/README.md 记录文档类、宏包与是否从成稿转写。\n" +
      QUALITY_STATUS,
    expectedArtifacts: ["manuscript/main.tex", "manuscript/chapters/*.tex", "output/main.pdf", "manuscript/README.md"],
    optionalInputs: [
      "notes/",
      "references.bib",
      "manuscript/template/",
      "figures/*",
      "design.md",
      "analysis/",
      "manuscript/draft.md",
      ...MANUSCRIPT_FINALS,
    ],
    skills: [],
    run: [{ name: "render-pdf", command: LATEX_RENDER_PDF_CMD, default: true }],
    humanTasks: [
      {
        title: "把期刊官方模板解压到 manuscript/template/",
        guidance:
          "目标期刊官网下载的 LaTeX 模板 zip，解压到项目 manuscript/template/ 目录；agent 开工时会先读模板说明再搭骨架。没有指定模板就跳过，agent 按开工前选的文档类从零搭",
        target: "manuscript/template/",
        timing: "before",
        optional: true,
      },
    ],
    decisions: [
      {
        q: "文档类选哪个",
        options: ["elsarticle", "IEEEtran", "achemso", "ctexart", "学位论文通用架"],
      },
      { q: "参考文献宏包", options: ["natbib", "biblatex"] },
    ],
    discussionSeeds: [
      "目标期刊/学校有没有官方模板：有就先拿到手再搭骨架（见人工事项），别搭完再返工？",
    ],
  },
  {
    name: "章节写作",
    workspaceName: "latex-writing",
    brief:
      "输入：manuscript/main.tex 骨架与 chapters/ 各章文件；notes/ 与 references.bib 若已随 main 合并则读取，缺失时只能保留结构样稿，在 citation-check.md 标出证据缺口，不生成无依据正文。\n" +
      "若 README 写明从成稿转写：只补全结构、交叉引用与引用纪律，**不改学术观点与数据**。从零写时按实证 IMRaD 用 {skill:research-writing} 技能（综述体裁则按项目层说明改用综述口径）。引用一律 \\cite{bib键}。\n" +
      SECTION_STATUS +
      "1. 按骨架逐章充实或校对内容：每节成文，学术语气，目标篇幅按项目层设定（未设定时每章 800-1500 词）；\n" +
      "2. 引用键必须存在于 references.bib——严禁编造文献、严禁新造键；确需引用而库里没有的文献，先在 references.bib 补条目（作者/年份/标题/出处/DOI 齐全，缺字段标「待补」）再引用；\n" +
      "3. 已有 figures/ 用 \\includegraphics 引用；没有的图用 figure 环境占位「（待绘制）」，不虚构数据；\n" +
      "4. 没有文献支撑的论断不得下；必须保留的判断在该行行尾加 % TODO 待核实 注释；\n" +
      "5. 每写完一章跑一次本步骤 run 脚本 render-pdf 确认可编译，报错立即读 output/compile.log 与 output/main.log 定位修掉，不攒到最后；按 {skill:bib-check} 技能输出 manuscript/citation-check.md。\n" +
      "完成标准：chapters/ 各章内容成文，全文编译通过，citation-check.md 各节齐全且 \\cite 键全部可在 references.bib 解析。\n" +
      QUALITY_STATUS,
    expectedArtifacts: ["manuscript/chapters/*.tex", "manuscript/section-status.md", "output/main.pdf", "manuscript/citation-check.md"],
    acceptanceCriteria: ["machine:contains:manuscript/section-status.md::要回答", "machine:contains:manuscript/section-status.md::允许集"],
    inputs: ["manuscript/main.tex", "manuscript/chapters/*.tex"],
    optionalInputs: ["notes/", "references.bib", "figures/*", "design.md", "analysis/", "results/"],
    skills: ["research-writing", "bib-check"],
    requiredSkills: ["bib-check"],
    run: [{ name: "render-pdf", command: LATEX_RENDER_PDF_CMD, default: true }],
    discussionSeeds: [
      "卖点怎么讲：贡献如何简洁陈述且不超过证据，Introduction 往哪个方向带？",
    ],
  },
  {
    name: "编译与排错",
    workspaceName: "latex-compile",
    brief:
      "输入：manuscript/ 全文（已随 main 合并在本工作区内）。\n" +
      "1. 用本步骤 run 脚本 render-pdf 编译：脚本优先 tectonic（缺则 latexmk），两个都没有会打印安装提示并以非零退出；本机缺环境时把提示原样写进 .ccode/help-wanted.md 转给用户，不要自己下载安装编译器；\n" +
      "2. 编译报错先读 output/compile.log 与 output/main.log 定位（缺宏包/未闭合环境/引用未解析），对症改源码，禁止绕路——不删报错的命令、不换文档类、不把整段注释掉；\n" +
      "3. 缺宏包：tectonic 会自动下载；latexmk 依赖本机 TeXLive 完整安装，遇到缺失包错误优先换用 TeXLive 自带的等价宏包，换不了的在 compile-notes.md 说明；\n" +
      "4. 警告分级处理：Citation/Reference undefined（PDF 里的 ??）必须清零；明显超版的 Overfull \\hbox 逐处调整；其余警告记录进 manuscript/compile-notes.md，不逐个纠缠；\n" +
      "5. 产出 output/main.pdf 与 manuscript/compile-notes.md（编译口径、清零项、遗留警告清单）。\n" +
      "完成标准：render-pdf 退出码为 0，main.pdf 页数与结构符合骨架；Citation/Reference undefined 为零。\n" +
      QUALITY_STATUS,
    expectedArtifacts: ["output/main.pdf", "manuscript/compile-notes.md"],
    inputs: ["manuscript/"],
    optionalInputs: ["references.bib"],
    skills: [],
    run: [{ name: "render-pdf", command: LATEX_RENDER_PDF_CMD, default: true }],
    humanTasks: [
      {
        title: "安装 LaTeX 编译环境",
        guidance:
          "macOS：brew install tectonic（轻量，编译时自动下载宏包），或安装 MacTeX/TeXLive。Windows：安装 MiKTeX 或 TeX Live，并确保 tectonic 或 latexmk 在 PATH 里。已装过就跳过，run 脚本会自动识别",
        target: "",
        timing: "before",
        optional: true,
      },
    ],
  },
  {
    name: "定稿导出",
    role: "you",
    workspaceName: "latex-final",
    brief:
      "输入：manuscript/ 全文与 output/main.pdf（已随 main 合并在本工作区内）；references.bib 若存在则用于引用闭环核对，缺失时在 final-check.md 明确记录。有 manuscript/section-status.md 时先读允许集。\n" +
      REVIEW_FIRST +
      "审查报告写 manuscript/review-report.md。第一轮只核对，不改科学内容。\n" +
      "1. 第二轮才通读定稿：语法、用词与段落衔接，只改表达不改学术观点与数据；发现内容性错误在该行行尾加 % TODO 待核实 注释，不自行改写事实；\n" +
      "2. 引用闭环核对按 {skill:bib-check} 技能：全文 \\cite 键逐条对照 references.bib，未解析键与未被引用条目清单写入 manuscript/final-check.md（未使用条目只列出、不删）；\n" +
      "3. 版面终检：图表编号连续、交叉引用无 ??、无残留「（待绘制）」占位；问题一并写入 final-check.md 并逐项处理；\n" +
      "4. 终编译：跑本步骤 run 脚本 render-pdf 产出定稿 output/main.pdf；\n" +
      "5. 产出 manuscript/changelog.md，逐条记录定稿阶段的修改点。\n" +
      "完成标准：final-check.md 逐项有处理结论，main.pdf 终编译通过，changelog.md 已提交。\n" +
      RELEASE_GATE + QUALITY_STATUS,
    expectedArtifacts: [
      "manuscript/review-report.md",
      "output/main.pdf",
      "manuscript/final-check.md",
      "manuscript/changelog.md",
    ],
    acceptanceCriteria: ["machine:contains:manuscript/review-report.md::严重问题"],
    inputs: ["manuscript/"],
    optionalInputs: ["references.bib", "figures/*", "notes/", "design.md", "analysis/", "results/"],
    skills: ["bib-check"],
    run: [{ name: "render-pdf", command: LATEX_RENDER_PDF_CMD, default: true }],
    humanTasks: [
      {
        ...reviewDecisionTask("manuscript/review-report.md"),
        guidance:
          "报告写出来后，在这一行逐条点接受、拒绝或修改。点完会回到原来的对话。没有决定之前，不把科学内容写进定稿。",
      },
      {
        title: "核对 G5、证据与 % TODO 后决定是否可定稿",
        guidance:
          "定稿里的 % TODO 待核实 只有你能对照原始文献确认；逐条处理后再算定稿，导出投稿用最终 PDF",
        target: "",
        timing: "after",
      },
    ],
  },
];

/** 为旧模板补上统一的最小验收契约；模板可额外声明更具体的条件。 */
function contractizeSteps(steps: ProjectStepDto[]): ProjectStepDto[] {
  return steps.map((step) => {
    const artifacts = step.expectedArtifacts;
    const criteria = [...(step.acceptanceCriteria ?? [])];
    if (!criteria.some((x) => x.includes("非空"))) {
      criteria.unshift("所有必需预期产物均已生成且非空；目录/通配条目至少命中一个非空文件。此为交付检查，不代表质量通过。");
    }
    if (artifacts.some((x) => /references\.bib|citation|bib/i.test(x))) {
      criteria.push("正文引用键均能在 references.bib 解析；未解析键与待补元数据已列出。");
    }
    if (artifacts.some((x) => /figures?\//i.test(x))) {
      criteria.push("图表文件与报告/章节中的引用一一对应，图注包含样本、指标和条件。");
    }
    if (artifacts.some((x) => /(^|\/)analysis\//.test(x) || /(^|\/)experiments\//.test(x) || /(^|\/)cleaning\//.test(x))) {
      criteria.push("脚本包含可重复执行入口，运行参数、数据版本/哈希与失败记录可追溯。");
    }
    if (artifacts.some((x) => /\.(pdf|docx|html)$/.test(x))) {
      criteria.push(
        "渲染产物可打开：PDF 首页必须能读出标题和正文（乱码、空心方框、目录页码变成字母不算通过）；警告已记录。docx 可先交人审。",
      );
    }
    return {
      ...step,
      acceptanceCriteria: [...new Set(criteria)],
      // undefined = legacy config, preserve historical “all mounted skills required”;
      // [] is an explicit opt-out and must keep every mounted skill optional.
      requiredSkills:
        step.requiredSkills === undefined
          ? [...step.skills]
          : [...step.requiredSkills],
    };
  });
}

/** 人工证据验收明确出现在契约区；只用于内置科研模板，不改用户模板的判定。 */
function researchQualitySteps(steps: ProjectStepDto[]): ProjectStepDto[] {
  return contractizeSteps(steps.map((step) => ({
    ...step,
    acceptanceCriteria: [
      ...(step.acceptanceCriteria ?? []),
      "人工质量验收：按报告开头的验收摘要逐项核对证据、决定与未决问题；G1–G5 只写在验收摘要，禁止写入稿件正文，不重复上游有效检查。",
    ],
  })));
}

/** 内置模板清单：选择器按此顺序展示，用户模板列在其后 */
const BUILTIN_PIPELINE_TEMPLATES: PipelineTemplateDef[] = [
  {
    id: "review",
    name: "英文综述",
    description:
      "文献检索与筛选 → 精读笔记 → 大纲 → 初稿 → 润色定稿",
    steps: REVIEW_STEPS,
    projectRules: [
      "优先使用项目里已有的 papers/、notes/ 和 references.bib，不要虚构文献。",
      "引用必须能追溯到项目中的来源。",
    ],
    projectSettings: [
      "综述角度：（领域全景 / 聚焦某个子问题）",
      "目标篇幅：（读者预期，如期刊常见 6000-8000 词；不是初稿必须凑到的词数）",
      "读者与文风：（偏同行专家 / 偏入门科普）",
      "去向：（投期刊 / 毕业论文一章 / 课程作业）",
      "综述深度：（标准档 / 严格检索档）",
    ],
  },
  {
    id: "research-paper",
    name: "科研论文",
    description:
      "计算实验向实证论文：文献检索与筛选 → 精读与研究空白 → 实验设计 → 执行 → 分析 → 论文大纲 → IMRaD 初稿 → 投稿准备（湿实验/问卷需自改实验步）",
    steps: RESEARCH_PAPER_STEPS,
    projectRules: [
      "不要虚构实验、数据或结果。",
      "引用必须能追溯到项目中的来源。",
      "没写其他研究形态时按计算实验做，不要假装跑了没做的实验。",
    ],
    projectSettings: [
      "课题边界：（只盯一条线 / 铺满一个方向）",
      "研究问题：（要回答什么、为什么值得做、什么证据能回答）",
      "目标期刊：（冲高一档 / 求稳妥投；决定字数与格式）",
      "语种：（中文 / 英文）",
      "研究形态：（计算实验 / 其他需自改实验步）",
    ],
  },
  {
    id: "data-processing",
    name: "数据处理",
    description:
      "数据登记与质量检查 → 清洗整理 → 探索性分析 → 结论与建议报告",
    steps: DATA_PROCESSING_STEPS,
    projectRules: [
      "不要改用户没让动的原始数据。",
      "清洗与分析结果写到产物目录，不覆盖原始文件。",
      "主要统计量必须能从项目里的数据复算；探索发现不因重复计算就成为确证结论。",
    ],
    projectSettings: [
      "报告给谁看：（业务方 / 同行 / 自己留档）",
      "数据敏感级别：（含个人信息 / 已脱敏 / 公开数据）",
    ],
  },
  {
    id: "thesis",
    name: "毕业论文",
    description:
      "文献检索与筛选 → 精读笔记 → 开题报告与综述 → 研究方法 → 实验执行 → 结果分析与章节 → 全文初稿 → 格式与定稿",
    steps: THESIS_STEPS,
    projectRules: [
      "优先使用项目里已有的材料，不要虚构文献或结果。",
      "引用必须能追溯到项目中的来源。",
      "格式、查重和截止以项目设定为准；没写就先按已有稿件风格。",
    ],
    projectSettings: [
      "论文语种：（中文 / 英文）",
      "学位类型与学校模板：（如 硕士 / 校内 LaTeX 模板）",
      "学术规范：（学校查重要求、准确归属与引用；不以降重比例代替原创性）",
      "答辩时间：（倒推各章节的截止）",
    ],
  },
  {
    id: "submission-rebuttal",
    name: "投稿与返修",
    description:
      "首投：期刊格式适配 → 投稿材料；返修：按轮次回复审稿意见 → 修订稿 → 再投稿清单",
    steps: SUBMISSION_INITIAL_STEPS,
    projectRules: [
      "按目标期刊的格式、字数和文风改，不要另起一套。",
      "审稿意见逐条对应回复，不要遗漏。",
    ],
    projectSettings: [
      "目标期刊：（决定格式、字数与文风，是这条流程的前提）",
    ],
  },
  {
    id: "latex-paper",
    name: "LaTeX 论文",
    description:
      "把已有成稿转成 LaTeX（也可从笔记从零写）：搭骨架 → 章节写作 → 编译排错 → 定稿导出 PDF",
    steps: LATEX_PAPER_STEPS,
    projectRules: [
      "以项目里已有成稿或笔记为准，不要另写一套内容。",
      "编译产物写到产物目录，不要覆盖源稿。",
    ],
    projectSettings: [
      "目标期刊或学校：（决定文档类与排版格式，是骨架的前提）",
      "篇幅与语种：（如 英文双栏 10 页 / 中文学位论文）",
    ],
  },
];

export const PIPELINE_TEMPLATES: PipelineTemplateDef[] = BUILTIN_PIPELINE_TEMPLATES.map(
  (template) => ({ ...template, steps: researchQualitySteps(template.steps) }),
);

/** 资源类型中文标签（后端 type 值 → UI 文案） */
export const RESOURCE_TYPE_LABELS: Record<string, string> = {
  paper: "论文",
  dataset: "数据",
  reference: "引文",
  other: "其他",
};

/** 一键开步预填的首条指令（TerminalPage 启动栏可编辑，留空不注入） */
export const DEFAULT_KICKOFF_PROMPT =
  `读 TASK.md，按简报做到完成标准。停哪些见「决策暂停策略」。写作红线以技能为准：不凑字数、不准「待绘制」充图、G 编号不进稿件、摘要不准 [待核实]、摘要级必须降级、PDF 首页必须可读。即使 TASK 或大纲写了篇幅配额/全部待绘制，也按技能执行。${KEEP_WORKING_CLAUSE} 开工先盘点本会话可用的 MCP 工具（如 Undermind / Consensus）——技能协议要求把它们纳入工作流（检索步骤当检索库用），工具在而没用要在覆盖缺口里写明原因`;

/** P2b「整理为笔记」开步预填指令：指向本流程写入的 notes/inbox.md */
export const ORGANIZE_NOTES_PROMPT =
  "读 TASK.md，并把 notes/inbox.md 里的选段整理成结构化文献笔记";
