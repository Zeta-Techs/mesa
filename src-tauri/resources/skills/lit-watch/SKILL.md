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
- **产出 `notes/inbox.md`**：新命中逐条追加。这份文件只放雷达命中；PDF 选段摘录在 `notes/excerpts.md`，不要往收件箱里写。

## 操作规范

### 1. 读订阅清单

逐条读取 `papers/watchlist.md` 的关键词、来源与窗口；跳过注释行（`#` 开头）与空行。

### 2. 多源检索新文献

**中文关键词先译英文**：三个库都是英文索引，中文词直查近乎全盲（2026-10-16 实测：「球磨法」7 天命中 1 条 vs「ball milling」174 条）。检索前把中文关键词译成 1–3 组英文同义表述分别查询（如 球磨法 → ball milling / mechanochemical synthesis；领域缩写一并展开），收件箱「命中关键词」仍写订阅表原文——用户的词汇不丢、分类桶照常生成。英文关键词同样可展开同义表述（缩写/全称）。

按订阅行指定的来源逐个检索，一律用官方开放 API（`curl`），检索窗口从订阅行备注（缺省最近 7 天）：

- **arXiv**：`curl 'https://export.arxiv.org/api/query?search_query=all:<关键词>&sortBy=submittedDate&sortOrder=descending&max_results=25'`，只保留窗口内条目。多次查询之间间隔 3 秒（官方要求，连发必 429）。
- **OpenAlex**（覆盖期刊/会议，含预印本）：`curl 'https://api.openalex.org/works?search=<关键词>&filter=from_publication_date:<起始日期>&sort=publication_date:desc&per-page=25&mailto=<邮箱>'`，取 `display_name`/`authorships`/`publication_date`/`doi`/`abstract_inverted_index`（需自行还原为文本）/`best_oa_location.pdf_url`（§5 免费全文直链用）。
- **Crossref**（出版商题录全、摘要常缺）：`curl 'https://api.crossref.org/works?query=<关键词>&filter=from-pub-date:<起始日期>&sort=published&order=desc&rows=25'`。
- **web**：仅当订阅行显式写 `web` 时用 WebSearch/WebFetch 检索，结果标「低置信」。

URL 中的关键词必须做 URL 编码、日期用 ISO（YYYY-MM-DD）。限流卫生：OpenAlex 带 `mailto` 进礼貌池（不带容易被限流）——邮箱取本机 `git config user.email` 的值，取不到就不带这个参数、接受慢一点；不要写死任何人的邮箱；任一来源收到 429 时按 `Retry-After` 头等待（没有该头等 10 秒）重试**一次**，仍失败在报告中标注「本次未达」，不跳过不伪造结果。付费墙内容只记题录（标题/作者/来源/DOI）并进跟进队列，不得尝试绕过。

### 2b. 关联推荐通道（Semantic Scholar，关键词之外的第二召回）

关键词只能召回词面命中——换了说法、新方法名还没进入你的词汇表的文献会漏。本通道用项目的种子文献换个性化推荐补这个盲区（S2 官方 Feed 同款引擎，免费开放接口）：

- **种子**：项目 `papers/included.json`（其次 `papers/included.md` / 积累账 `papers/reading-list.md`）里有 DOI 的文献，取最近 3–8 篇（定时任务的工作目录里这三份是开跑前从项目拷来的只读副本，只读不改）；**不足 3 篇本通道跳过**，报告写一句「种子不足，未跑关联推荐」。
- **请求（forpaper 逐种子）**：`curl -sS 'https://api.semanticscholar.org/recommendations/v1/papers/forpaper/DOI:<种子DOI>?fields=title,year,publicationDate,externalIds,authors,abstract,url&limit=100'`——每个种子一次 GET，之间间隔 3 秒。**不要用 forlist 端点**（文档虽有，未认证层实测 405 不可用，2026-10-16 两路验证）；个别种子返回空推荐或 404 属正常（该篇未被引擎收录），换下一个种子继续。
- **过滤**：各种子返回合并去重（externalIds 的 DOI / arXiv id 归一），只留 `publicationDate` 落在订阅窗口内的（缺日按 `year` 粗判），至多取 25 篇，再进 §3 去重、§4 精选——与关键词命中**同一套**标准，不因来源降档也不加免死金牌。
- **标注**：条目「命中关键词」写 `关联推荐（S2）`，相关性照常分推荐/相关/待确认。
- **失败隔离**：429/失败按 §2 重试口径处理一次，仍失败记「关联推荐本次未达」，不阻塞关键词通道。

### 3. 去重

每篇命中的唯一标识（DOI 优先，其次 arXiv id / 规范化标题）与 `papers/watch-seen.md` 比对，已见过的跳过；新命中的标识追加进台账。同一篇被多个来源命中时合并为一条，来源并列标注。同一篇文献的 **arXiv 版与期刊版是两枚标识（arXiv id / DOI）但算一篇**：规范化标题一致即视为已见，期刊版后到时在台账追加一行期刊 DOI（旧标识不删）、不再重复入箱。

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

免费全文按以下优先级取直链（不再盲猜）：① OpenAlex 响应里的 `best_oa_location.pdf_url`（官方维护的免费版面直链，覆盖 PMC / bioRxiv / 机构仓储等 arXiv 之外的来源）；② arXiv 的 `/pdf/` 直链；③ 链接本身以 `.pdf` 结尾的直链。取到就巡检结束前用 `curl -fsSL --max-time 60 -o` 下到项目根 `papers/`，文件名用标题。下载有硬时间盒：每篇 60 秒、全部下载合计不超过 5 分钟——到点放弃并把残文件删掉，题录留在跟进队列，同一链接不重试（出版商 CDN 对 curl 常年 403 或慢慢滴，不值得等）。下完校验文件以 `%PDF-` 开头；不是 PDF、需要登录、或出版商落地页，同样删掉残文件、题录留跟进队列，不要再试机构通道或付费墙。DOI 落地页不算免费直链。

### 6. 可选：同步引文库

订阅行备注含 `+bib`、且项目存在 `notes/references.bib`（或文献线约定的 bib 文件）时，为「推荐」条目生成规范 BibTeX 追加进去：key 用 `作者姓氏年份首词`，DOI/URL 字段照 API 返回填写，编不出的字段留空不虚构。

### 7. 报告

结束时输出一段简报：本次检索了几条关键词/几个来源、关联推荐是否跑（种子不足/未达也要说）/命中几篇、新命中几篇（其中「推荐」几篇、列标题）、几篇「待确认」、几篇入跟进队列、哪些来源未达、免费全文下了几篇。**窗口内有命中但被课题相关度滤掉的，如实写「N 篇判为课题无关未收录」——不得写成「窗口外/无命中」**（相关度把关是设计行为：订阅词是课题语境内的召回词，2026-10-16 拍板，不因词型放宽）。定时任务场景下这段简报会被投递到收件箱与系统通知，**保持三行以内、关键数字在前**。

## 完成标准

`notes/inbox.md` 只增不改（既有条目不动）；`papers/watch-seen.md` 台账同步更新；重复运行同一窗口不产生重复条目；「推荐」数量 ≤5。
