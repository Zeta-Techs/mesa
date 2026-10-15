---
name: lit-watch
description: 文献监控规范。当用户要求跟踪某个课题的最新文献、订阅 arXiv/期刊关键词、做每日/每周新文献巡检，或流水线中配置了文献监控步骤时使用。按 papers/watchlist.md 的关键词检索新文献，去重、精选后把命中追加到 notes/inbox.md。
outputs: [notes/inbox.md]
provides: [lit-watch]
---

# 文献监控（lit-watch）

本技能规定「订阅关键词 → 多源检索 → 去重 → 精选 → 落成笔记收件箱」的操作规范。目标是让新文献主动汇到 `notes/inbox.md`，而不是每次从零检索。

## 何时使用

- 用户要求「跟踪/盯一下某方向的最新论文」「每天看看有没有新命中」
- 项目流水线中配置了文献监控步骤，或被定时任务触发（简报会指向本技能）

## 输入与文件约定

- **订阅清单 `papers/watchlist.md`**：一行一条，格式 `关键词 — 来源 — 备注`。来源取值：`arxiv` / `openalex` / `crossref` / `web`（可逗号分隔多个，缺省 `arxiv,openalex,crossref` 三库全查——订阅界面不再让用户挑库，限定库属手写源文件的高级用法）；备注可写时间窗口（如「每周」「近 3 天」，缺省 7 天）与 `+bib`（命中同步进引文库）。文件缺失时在报告中提示用户先建清单并停止，不自行编造关键词。
- **已见记录 `papers/watch-seen.md`**：本技能维护的去重台账，一行一条已处理文献的唯一标识（arXiv id / DOI），首次运行时创建。
- **跟进队列 `papers/watch-followup.md`**：无摘要或付费墙文献的待办清单（题录 + 缺失原因），供用户后续人工获取全文，首次需要时创建。
- **产出 `notes/inbox.md`**：新命中逐条追加，格式与「整理为笔记」链路兼容。

## 操作规范

### 1. 读订阅清单

逐条读取 `papers/watchlist.md` 的关键词、来源与窗口；跳过注释行（`#` 开头）与空行。

### 2. 多源检索新文献

按订阅行指定的来源逐个检索，一律用官方开放 API（`curl`），检索窗口从订阅行备注（缺省最近 7 天）：

- **arXiv**：`curl 'https://export.arxiv.org/api/query?search_query=all:<关键词>&sortBy=submittedDate&sortOrder=descending&max_results=25'`，只保留窗口内条目。
- **OpenAlex**（覆盖期刊/会议，含预印本）：`curl 'https://api.openalex.org/works?search=<关键词>&filter=from_publication_date:<起始日期>&sort=publication_date:desc&per-page=25'`，取 `display_name`/`authorships`/`publication_date`/`doi`/`abstract_inverted_index`（需自行还原为文本）。
- **Crossref**（出版商题录全、摘要常缺）：`curl 'https://api.crossref.org/works?query=<关键词>&filter=from-pub-date:<起始日期>&sort=published&order=desc&rows=25'`。
- **web**：仅当订阅行显式写 `web` 时用 WebSearch/WebFetch 检索，结果标「低置信」。

URL 中的关键词必须做 URL 编码、日期用 ISO（YYYY-MM-DD）。检索失败的来源在报告中标注「本次未达」，不跳过不伪造结果。付费墙内容只记题录（标题/作者/来源/DOI）并进跟进队列，不得尝试绕过。

### 3. 去重

每篇命中的唯一标识（DOI 优先，其次 arXiv id / 规范化标题）与 `papers/watch-seen.md` 比对，已见过的跳过；新命中的标识追加进台账。同一篇被多个来源命中时合并为一条，来源并列标注。

### 4. 精选排序（Top-N）

对本窗口全部新命中按「相关度 × 期刊档次」双因子排序：先按相关度分档（标题命中关键词 > 摘要命中 > 仅主题相关），同档之内期刊档次高者居前。期刊档次参考名单（宁缺毋滥，不在名单里的不降级、只作加分项）：

- 综合顶刊：Nature、Science 及其子刊（Nature Energy、Nature Materials、Science Advances 等）
- Cell 系（Cell、Joule、Matter、Chem 等）
- 材料/化学/能源主流刊：JACS、Angewandte Chemie、Advanced Materials、Energy & Environmental Science、ACS Nano 等
- 物理主流刊：Physical Review Letters、Physical Review B 等
- 医学顶刊：Lancet、NEJM 等；本领域公认的旗舰会议同此待遇

**期刊档次只影响排序，不影响收录**：拿不准的一律收录并标「待确认」，不允许自行丢弃。排序后选出 **Top 3–5** 标为「推荐」，其余标「相关」。新命中总数 ≤5 时全部标「推荐」。

### 5. 落成收件箱

每次巡检先写一行批次标记（本地日期，上海时区），再追加本次条目；条目归属最近的批次标记。漏写这一行时，雷达无法把命中归到周里，近 8 周趋势整段不画。已有批次标记的旧条目不要改：

```
<!-- watch-run: YYYY-MM-DD -->
```

每条新命中追加到 `notes/inbox.md`，固定结构：

```
## <标题>
- 来源：<arxiv/期刊/会议> — <发表日期（arXiv 发布日/期刊出版日，YYYY-MM-DD）> — <链接或 DOI>
- 作者：<前 3 位 et al.>
- 摘要首句：<原文第一句（英文原文，不翻译不截断到只剩半句）；OpenAlex/Crossref 有 abstract 就必须带出；两个来源都没有才写「（无摘要，已入跟进队列）」并进跟进队列>
- 命中关键词：<watchlist 中的关键词>
- 相关性：推荐 / 相关 / 待确认
- 期刊：<期刊名或来源刊>
- 中文一句话：<标题与核心的中文一句话>
```

「中文一句话」每条必写；「期刊」能确定就写，确定不了可省略该行，不得编造。

无摘要或付费墙的条目同时追加题录到 `papers/watch-followup.md`。

能免费直接拿到 PDF 的（arXiv 的 `/pdf/` 直链，或链接本身以 `.pdf` 结尾），巡检结束前用 `curl -fsSL -o` 下到项目根 `papers/`，文件名用标题。下完校验文件以 `%PDF-` 开头；不是 PDF、需要登录、或出版商落地页，删掉残文件，题录留在跟进队列，不要再试机构通道或付费墙。DOI 落地页不算免费直链。

### 6. 可选：同步引文库

订阅行备注含 `+bib`、且项目存在 `notes/references.bib`（或文献线约定的 bib 文件）时，为「推荐」条目生成规范 BibTeX 追加进去：key 用 `作者姓氏年份首词`，DOI/URL 字段照 API 返回填写，编不出的字段留空不虚构。

### 7. 报告

结束时输出一段简报：本次检索了几条关键词/几个来源、新命中几篇（其中「推荐」几篇、列标题）、几篇「待确认」、几篇入跟进队列、哪些来源未达。定时任务场景下这段简报会被投递到收件箱与系统通知，**保持三行以内、关键数字在前**。

## 完成标准

`notes/inbox.md` 只增不改（既有条目不动）；`papers/watch-seen.md` 台账同步更新；重复运行同一窗口不产生重复条目；「推荐」数量 ≤5。
