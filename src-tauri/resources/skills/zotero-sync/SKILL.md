---
name: zotero-sync
description: Zotero 文献库同步规范。当用户明确要求把检索结果写入 Zotero，或按需从 Zotero 导出项目文献时使用。内核 zotero_import 仍是只读进料口。Zotero 7–9 本地 /api/ 只读，进库走 RIS/BibTeX 原生导入（清单「同步到 Zotero」或拖文件），禁止 POST 假装写库。不可用时回落纯文件口径，不阻塞文献流程。
outputs: [papers/zotero-sync.md, output/zotero.docx, papers/zotero-cite-report.md]
provides: [zotero-sync]
---

# Zotero 文献库同步（zotero-sync）

> 命令里的 `python3` 指本机 Python 3：**Windows 上改用 `python`**（Windows 的 `python3` 是应用商店占位程序，一运行就失败）；macOS / Linux 用 `python3`。

本技能是可选的项目 ↔ Zotero **规范与报告**，不是清单上的「同步到 Zotero」按钮。

- 按钮：尚无 `references.bib` 时打开 `papers/to-fetch.ris`；已有 `references.bib` 时按引文库生成 `papers/zotero-library.xml`（及备用 `papers/zotero-library.ris`），把保留 `<style face="subscript|superscript">` 真上下标的 XML 转交 Zotero 原生导入（Zotero 自动转为标题里的 `<sub>`/`<sup>`）。
- 内核「从 Zotero 导入」：只读 sqlite 快照进项目，绝不写回个人库。
- 本技能：检索时盘点已有库，定稿时把 `[@键]` 写成带 Zotero 域的 Word（`output/zotero.docx`）。不点 Zotero 的 Word 插件。`zotero_rtf.py` 只留给旧的 RTF Scan 稿，定稿不再交 RTF。

## 何时使用

- `lit_source = zotero`：用户已用内核「从 Zotero 导入」把库落到项目；本技能只盘点并补检索缺口，禁止覆盖已有 `references.bib`
- `lit_source = search`（默认）：Zotero 仅是可选导出目标；用户未明确要求进库时只交付文件
- `lit_source = folder`：只处理项目文件，禁止访问或写入 Zotero
- 用户明确要求把清单写入 Zotero

## 前置检测（开工先做）

- 探活：`curl -i --max-time 3 http://127.0.0.1:23119/api/users/0/items?limit=1`（不要用 `/api` 根路径，无尾斜杠会 404）
- 连接失败 = Zotero 未运行；HTTP 403 = 未开本机通信。两者都不得假装已写库
- GET 通不等于能写。Zotero 7–9 的 `/api/` **只读**（POST 回纯文本 `Endpoint does not support method`）。**禁止 POST `/api/users/0/items`**，禁止对着非 JSON 正文 `.json()`
- Better BibTeX 不是进库前提，也挂不了 PDF。未装不得当成失败
- **回落口径**：通道不可用或用户未要求进库时，只产出 `papers/to-fetch.ris` 等文件；这是正常分支，不是失败

## 操作规范

### 1. 进库（项目 → Zotero，必须用户明确要求）

- 交付 `papers/to-fetch.ris`（RIS 2004，CRLF，与 to-fetch.md 同序）。这一份只给 Zotero：一位作者一条 `AU`（`姓, 名`），期刊全称只写 `T2`，缩写只写 `J2`。再写 `PY`、`VL`、`IS`、`SP`、`EP`、`SN`、`DO`、`KW`、`AB`、`UR`。不要写 `JO`（Zotero 会把它放进期刊缩写）、不要写 `N1`（会进笔记）。EndNote 用另一份 `papers/endnote-import.ris`，起始页码是 `M2`、文章类型是 `M3`。检索时一次查全；人纳入后按 Zotero 标签追加，不再另查。Zotero 原生导入 RIS/BibTeX/CSL JSON，不需要插件
- 告诉用户用清单「同步到 Zotero」或把 RIS 拖进 Zotero。不要另开一条 API/BBT 写库
- 期刊缩写与 EndNote 份同一套（JabRef 表 + Mesa 兜底）；按 LTWA 算的 ISO 4 写法和主缩写不同时写 `M2  - ISO 4 abbreviation: …`，Zotero 收进「其他」。题名开头人手加的编号导出时去掉。
- 需要 Zotero 7 及以上：Zotero 6 读不了自动更新来的新版格式转换器，导入 RIS / BibTeX 一律报「不支持所选文件的格式」，遇到就请人升级，不要改文件格式去迁就。
- 不要代点按钮、不要循环导入。库里已有同一 DOI 的条目也照样导入（Mesa 的题录字段全），界面提示有几条重复，人导入后在「重复条目」里挑着合并
- **PDF：** 同步只交 RIS，不打开目录。人点「打开 papers」打开课题根里的 PDF，再拖进库。重复项合并时主记录选 RIS 那一条。关掉「自动重命名附件文件」。禁止声称 Mesa 已自动挂上附件或代为合并。
- 未明确要求进库：只留 RIS，报告写明「未进库，文件已交」

### 2. 出库（Zotero → 项目，仅精读/用户明确要求时）

- 默认请用户用内核「从 Zotero 导入」（文献与数据）。检索步骤不得写 `references.bib`
- 不要默认调用 Better BibTeX `autoexport.add`，不得悄然修改用户 BBT 配置
- 已有 bib 键一律不改；与 lit-notes 冲突时保留既有键并在报告列出

### 3. 定稿域稿（与 EndNote 域稿同一位置，两份都交）

定稿、学位论文格式与定稿、期刊格式适配都交两份带域的 Word。Zotero 这一份：

```bash
python3 <技能目录>/scripts/zotero_docx.py \
  --input manuscript/review-final.md \
  --bib references.bib \
  --output output/zotero.docx \
  --report papers/zotero-cite-report.md
```

科研论文改 `manuscript/paper-final.md`，学位论文用 `manuscript/thesis-final.md`，期刊格式用 `submission/formatted.md`。同一份源稿再跑 endnote-bridge 的 `cite_docx.py`，写出 `output/endnote.docx`。

- 每个 `[@键]` 写成一条 Word 域：`ADDIN ZOTERO_ITEM CSL_CITATION`。域里带 `citationID`、`formattedCitation`、`plainCitation`、`noteIndex`。**不预置空的 `ZOTERO_BIBL` 域**：Refresh 会把预置的空文献表域直接删掉（2026-10-10 集成日志实证 `getCode BIBL → removeCode`），文末只放 References 标题加一个空段做锚点。可见文字用 `(Author, year)`。正文里的 `{#键}`：键在 bib 里就写成同一条域，不在就只留键名。`Figure @fig-`、`Table @tbl-`、`{#fig-}`、`{#tbl-}` 收成编号，中间有括号也收。对不上的只留键名。
- 生成时只读当前默认 Zotero 配置里 `extensions.zotero.dataDir` 指明的 `zotero.sqlite`（换库用 `--zotero-db`；从项目根跑时带 `--project-root`）。配置不止一个、没有默认、或没写数据目录时不猜。只查用户库，不查群组库。DOI 去掉网址前缀、空白和末尾句点后必须整段相同，并且库里只有一条未删除条目时直接把 `http://zotero.org/users/.../items/<条目键>` 写进域；多课题共用库导致同一 DOI 有多条副本时，若存在与当前课题同名（含 Zotero 重导追加的时间戳后缀如 `<课题名> YYYY/MM/DD HH:MM:SS`）的最新非空分类且分类内恰好一条，按该课题分类精确绑定；同分类内仍多条、库里没有或无匹配分类时不猜，报告「库绑定」点名，但域内 `citationItems` **必须仍写入带确定性占位 URI（`embed000…`）与完整 `itemData`（标题含 `<sub>`/`<sup>` 富文本标记、剔除 `待补` 占位符）的嵌入条目**——**严禁写空的 `"citationItems": []`**（Zotero `integration.js` 见空数组会在点 Refresh 时把整条引注当 `DELETE` 删光，随后点 Add/Edit Bibliography 必报「执行本操作前您需要插入引注。」；2026-11-15 HER 实证）。RIS 的 `ID` 导入时不进库，不能用来对。
- 未匹配键 **fail-closed**：写报告、不写 docx、退出码非 0。
- 图注和表题本身是正文流里的普通 `<w:p>` 段落（不是 Word 浮动文本框），其中的 `[@键]` 同样写出真正的 `ADDIN ZOTERO_ITEM` 引文域（首句加粗仅作用 `<w:t>`），换样式后与正文同步更新并自动进入参考文献表。
- 不点 Zotero 插件。人的三步（都写进报告）：打开 `output/zotero.docx` → Zotero 工具栏 **Refresh**（首次会弹引用样式选择框，属正常、一次性；文档首选项存在 docx 的 `docProps/custom.xml` ZOTERO_PREF 属性里，不是 Word 域）→ 光标点进 References 标题下面那个空段本身（⚠ 点在标题行上会把参考文献表插到标题上方、继承标题大字号；插错就 Ctrl+Z 撤销，光标点对再点一次），点 **Add/Edit Bibliography** 插入参考文献表。换样式用 Document Preferences 后再 Refresh。刷新前重启 Zotero 和 Word、关掉所有弹窗（旧实例的 AppleScript 通道堵死会报「遇到一个错误」；macOS Word 经 AppleScript 逐域更新，几百处引文叠加高清大图首次刷新常需 1–3 分钟，切到 Word「视图 → 草稿」可显著提速，期间别在 Word 里点）。
- `zotero_rtf.py` 只留给旧的 RTF Scan 稿，定稿不再交 `output/zotero.rtf`。

### 4. 边界与报告

- 不删除、合并重复或批量改用户库
- 报告 `papers/zotero-sync.md`：模式（search/zotero/folder）、Zotero 是否在跑、进库方式（按钮/拖 RIS/未进库）、RIS 路径、未挂 PDF 的说明、键冲突

## 完成标准

检测结果记录在案；未要求进库或写不了时交付 RIS 并如实报告；检索步骤不写 `references.bib`；已有 bib 不覆盖、不改键；不把只读 API 或未装插件写成故障。

- 写作约定：不使用彩色 emoji；强调标记用「注意：」或单色 ⚠（U+26A0 U+FE0E）。

---

接口依据：Zotero 原生导入格式（RIS/BibTeX/CSL JSON）与官方本地 API 只读边界。方法与参数必须先对实机。
