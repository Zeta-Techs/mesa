---
name: quarto-render
description: Quarto 稿件渲染规范。当用户要求把 manuscript/ 下的 .md/.qmd 渲染为 PDF/docx/html，或论文流水线中「渲染成稿」一步时使用。先 quarto check 确认环境，渲染产物写入产物目录（不进 git），缺依赖按序引导安装，报错按归属处理并走修复-验证闭环，渲染成功后验收产物并在 Mesa 改动面板「登记产物」记入提货单。
outputs: [output/]
provides: [quarto-render]
---

# Quarto 稿件渲染

本技能规定 `manuscript/` 下的 `.md`/`.qmd` 稿件渲染成稿的操作规范与产出格式。渲染产物（PDF/docx/html）体积大且可再生，**一律写入产物目录、不进 git**；git 里只保留源稿与配置。

拿不准的语法或选项，以本机 `quarto --version` 对应版本的 quarto.org 官方文档为准，不要凭记忆写过时选项。

## 何时使用

- 用户要求把 `manuscript/` 下的 `.md`/`.qmd` 渲染为 PDF、docx 或 html
- 论文流水线中「渲染成稿」一步（简报会指向本技能）
- 渲染失败需要排查环境与依赖问题时

## 操作规范

### 1. 先确认环境

动手渲染前先跑：

```bash
quarto check
```

逐项确认 quarto、pandoc 与目标格式引擎（PDF 需要 tinytex 或其他 LaTeX 发行版）都就绪。任何一项缺失或版本异常，**先按第 3 节引导安装，再继续**——不要带病渲染。

### 2. 渲染命令与产物路径约定

```bash
quarto render manuscript/<稿件>.md --to docx --output-dir ../output
quarto render manuscript/<稿件>.md --to pdf --output-dir ../output
```

- **`--output-dir` 写 `../output`，不是 `output`**（2026-10-21 Windows + Quarto 1.10.19 实测）：没有 `_quarto.yml` 时 Quarto 把稿件所在目录当项目根，`--output-dir` 相对它解析——写 `output` 会落到 `manuscript/output/`，而且下一次渲染（先 docx 后 PDF）会把上一份清掉，只剩最后一个格式。`../output` 才是工作区根 `output/`，docx 与 PDF 可共存。稿件在 `submission/` 下同理。
- **不要加 `--output <文件名>`**：和 `--output-dir` 同用时 Quarto 会把成品丢到工作区根（`../review-final.docx`），不进 `output/`。默认文件名就是稿件同名，不需要它。
- **项目根不要放 `_quarto.yml`**：有它时 `../output` 会越出项目、写到工作区外面。需要项目配置时放在 `manuscript/_quarto.yml`（项目根就是 `manuscript/`，`../output` 仍然对）。
- **先 docx 后 PDF**：docx 不走 LaTeX，能先交出可审稿。
- **引用样式按人在流程线上选定的具体形式**。人选定后才换样式重渲：方括号编号 `[1]`、上标编号 `¹`、作者-年 `(Author, Year)` 或 `(Author Year)`，或某一本期刊的作者须知。按这一句改稿子的 csl 再渲。人还没换时，沿用稿子里已经在用的样式（初稿是编号制）照常渲，不因没选样式、也没有 `citation-style.md` 而停渲。只有人确认了目标期刊，才写 `submission/target-journal.md`；沿用编号不要写这份文件，也不要写一份空的去应付交付检查。YAML 写：
  ```yaml
  bibliography: ../references.bib
  csl: citation.csl
  link-citations: true
  ```
  项目配置只写在稿件自己的 YAML 头里（或 `manuscript/_quarto.yml`，路径同上），不放项目根。换形式按流程线上那一句改 csl 再重渲。不要手写文末文献表。源稿仍写 `[@bib键]`。
- 正文字体在初稿开工时问人一次，写在本步工作区。默认英文 Times New Roman、中文宋体。用 `scripts/manuscript_font.py` 写入 YAML 的 `mainfont` / `CJKmainfont`，并生成 `manuscript/reference.docx` 与 `manuscript/typeface.md`。商量任务书的会话只改任务书，不要在那里写这两份。PDF 用 `pdf-engine: xelatex`，并加载 `booktabs`，表格是三线表。正文首行缩进 `2em`，节后第一段也缩进。脚本同时把 `reference-doc` 写进 YAML 的 `format.docx`（路径相对稿件所在目录），所以无论流程线的 run 脚本还是手敲的 `quarto render`，出 Word 都自动套 `manuscript/reference.docx`；Word 出来是 Quarto 默认的等线，就是 YAML 里少了这一行，补上再渲。这份参考文档同时带标题 1–3 的字号和段前段后、正文行距。EndNote 与 Zotero 域稿的表格同样只有顶线、表头下横线和底线，没有竖线。本机没有指定字体就停，不改用别的。Quarto 见到 Mg²⁺ 这类 Unicode 会自己改走 lualatex，Mac 上 luaotfload 扫字体常卡死；xelatex 不嵌字体则整页乱码。定稿读初稿留下的 `manuscript/typeface.md`，按里面的字体名渲，不要另选字体，也不要重问；第一次渲染就用这套字，不要先用默认字体渲完再重渲。
- **参考文献表由过滤器整理（2026-10-23）**：`manuscript_font.py` 同时把 `scripts/references.lua` 拷到源稿旁边、写进 YAML 的 `filters`。渲染时它读引文库交给 citeproc：标题整体加保护（Pandoc 读 BibTeX 会把英文标题改成句首大写，Ru、Ni-Mo-B 变小写），去掉题名前人手加的编号（【74】、19~.），「待补」「待核」「无期号」字段不印进文献表，稿子里没有 `::: {#refs}` 时文末补不编号的 References 标题。引文库本身不改。旧稿 YAML 里没有这一项就重跑一次脚本再渲。验收时看一眼文献表：元素符号大小写对、没有【n】和「待补」。
- `number-sections: true` 时，markdown 标题写 `## Introduction`，不要自带 `## 1.`。
- 渲染产物统一写入 **本工作区 `output/`**（相对路径；评审合并进主仓时自动带到项目根同名目录）；该目录必须在 `.gitignore` 中，**产物不进 git**。
- 缺产物目录时先建 `output/` 并补 `.gitignore`，再渲染。

### 3. 缺失依赖的安装引导顺序

依赖缺失时按以下顺序引导（逐条执行，装完一条再验一条）：

1. quarto CLI 缺失时，安装成功只认 `quarto check` 逐项通过。`brew install quarto` 退出码 0 仍可能没装上（cask 要 sudo，无密码会被清掉）。conda-forge 的 quarto 在 Apple 芯片上可能只有 x86_64 工具且缺 `share/editor`，这种包装上也不用。改用 GitHub Release 的 `quarto-<版本>-macos.tar.gz` 解压到用户目录，把 `bin` 放进 PATH，再跑 `quarto check`。
2. pandoc 缺失 → quarto 通常自带；单独缺失时 `brew install pandoc`。
3. PDF 引擎缺失 → `quarto install tinytex`（优先 tinytex，轻量可自动补 LaTeX 包）；tinytex 不可用时再引导完整 TeX Live / MacTeX。

### 4. 常见报错处理

总原则：**环境/依赖类问题直接修**；**内容类问题（引用键、交叉引用、源稿语法）修源稿本身，不在命令行上加参数掩盖**；拿不准归属的标注后报告，不静默跳过。

- **YAML 头错**（解析失败、缩进错乱）：打开对应源稿修 YAML front matter 本身，不要在命令行上加参数掩盖。
- **引用键缺失**（`citation not found: @xxx`）：回 `references.bib` 补条目或改源稿中的引用键，**不得删除引用来消错**。
- **LaTeX 包缺失**（`! LaTeX Error: File 'xxx.sty' not found`）：用 `tlmgr install xxx`（tinytex）或让 tinytex 自动补装，**先装不绕路**——禁止删图表、改格式、去掉公式来回避报错。
- **lualatex 卡死**（CPU 很高、对应 `.log` 仍 0 字节、`luatex-cache` 空）：是 luaotfload 扫字体，不是正常首次编译。**超过 3 分钟无日志就停掉**，YAML 设 `pdf-engine: xelatex` 再渲。不要空等，也不要删公式/改正文符号来躲。
- **首次渲 PDF 很慢**（Windows 实测约 2.5 分钟）：TinyTeX 会现装缺的宏包（如 `xecjk`，终端里能看到 `installing xecjk`），期间看起来没动静。看到 `updating tlmgr` / `installing …` 就是在装，**不要中断**；装完同一台机器上再渲只要几秒。这和上一条 lualatex 空转不同：那条是日志 0 字节、没有任何安装输出。
- **中文缺字/豆腐块**（PDF 里中文乱码或方框）：用 `fc-list :lang=zh family` 找本机中文字体，在 YAML 设 `mainfont`/`CJKmainfont`；缺字靠设字体，不靠换引擎。
- **英文标题里的缺字**：`references.bib` 标题中的 U+2010 连字符在 xelatex + Times New Roman 下会变成缺字。渲染前把标题和作者字段里的 U+2010 / U+2011 换成 ASCII `-`，重渲后再数 PDF 里的缺字，不为 0 不算通过。
- **正文 `@` 被当成引用**（`citation polymer not found` 这类）：材料名里的 `@` 写成 `\@`。子图写成 `@fig-2(a–c)`，Quarto 只认整图标签。
- **图注和交叉引用**：图片写成 `![说明](../figures/figN.png){#fig-N out-width="100%"}`，表题末尾写 `{#tbl-N}`。正文交叉引用只写 `@fig-N`、`@tbl-N`，不要再加 `Figure` 或 `Table`，否则 PDF 和普通 Word 会显示 `Figure Figure 1`。阅读稿按 Quarto 所选样式排图注、表题和文献表。两份域稿另交，引用保持作者-年，等人在 EndNote 或 Zotero 里换样式。
- **成品没在根 `output/`**：落到 `manuscript/output/` 是 `--output-dir` 写成了 `output`；落到 `output/manuscript/` 是项目根有 `_quarto.yml`；落到工作区根是加了 `--output`。改回上面的命令重渲，不要手动搬文件；已落错的把成品移到 `output/`、删掉带过来的脚手架目录。`keep-tex` 写在 YAML 里，不是命令行旗标。
- **xelatex 跑满 9 轮**：图注、表题里有 Ω、α 这类希腊字母时，unicode-math 会让标签每轮都判「可能已变」。`manuscript_font.py` 会在 YAML 的 `include-in-header` 里写一段 `\@testdef`（标签按字面比较），YAML 里没有这段就重跑一次字体脚本，不要删希腊字母。有这段仍跑满，先查 PDF 有没有 `??` 和未解析引用。没有就记入渲染说明，不要为消这句警告改稿。

### 5. 修复-验证闭环

每轮修复后完整重渲染，并比较报错数量：

- 变少 → 继续修剩余问题；
- 不变 → **禁止重复同一修法**，换思路排查；
- 变多 → 回滚本轮改动，再换方案；
- 最多 3 轮仍不干净 → 停止，带剩余错误摘要与已试方案报告，不硬试。

注意假阳性：交叉引用与引用类 warning 常在补跑完整渲染后自愈，只有重渲后仍在的才当真错处理；`citation not found` 是要回 `references.bib` 处理的真错。

### 6. 报错看不懂时拿更多信息

- `quarto render --verbose` 看详细过程；
- `keep-tex: true`（或 `--to latex`）留中间 .tex，定位 LaTeX 层问题；
- `--keep-md` 看中间 markdown。

### 7. 渲染成功后验收与登记

先验收，再登记：

- 产物文件存在且非零字节；
- **打开 PDF 第一页**：必须能读出标题和正文。乱码、空心方框、目录页码变成字母 = 渲染失败，即使文件有体积也不算通过；改 `pdf-engine: xelatex` 重渲，或只交 docx 并在渲染说明写失败原因。
- **打开 docx**：引用样子与人在流程线上选定的形式一致。人还没换时，沿用稿子里已有的样式。
- 统计残留 undefined citation/reference 类 warning 条数，写进渲染说明。

验收通过后，建议用户经 **Mesa 改动面板「登记产物」** 把 PDF 记入工作区提货单（`artifacts.yaml`）——产物本体不进 git，清单随分支传给下一步。Agent 本身不直接改 `artifacts.yaml`。

## 产出格式

- **渲染产物**：产物目录下的 PDF/docx/html（路径明确、可打开）
- **渲染说明**（一句话级）：渲染命令、产物路径、警告摘要（`quarto check` 遗留警告、渲染 warning 条数与要点，含 undefined citation/reference 计数；无警告写明「无警告」）

## 完成标准

- **码位抽检**（2026-10-11 定稿审计实证：PDF 文本层 59 个分号全被映射成 U+037E 希腊问号，视觉不可辨但复制/检索/查重即坏）：渲完 PDF 跑 `python <技能目录>/scripts/check_pdf_text.py output/<稿件>.pdf`（macOS / Linux 用 `python3`；只读，依赖 PyMuPDF，不需要 pdftotext）。退出码 1 = 文本层有 U+037E / 缺字 / 私有区字符，按渲染管线缺陷处理，记录进报告，不静默放行。
  **修法**（2026-10-21 Windows + Times New Roman 实测，3 个分号 U+037E → U+003B）：xelatex 的 `include-in-header` 里要有 `\ifdefined\XeTeXgenerateactualtext\XeTeXgenerateactualtext=1\fi`。`manuscript_font.py` 开工时会写这一行，旧稿重跑一次脚本也会补；手工起草或脚本没跑过的稿子自己补上，重渲后再抽检，U+037E 为 0 才算过。

- 产物在产物目录且验收通过（存在、非零字节、残留 warning 已计数）；
- 渲染说明齐全（命令/路径/警告摘要）；
- 修复改动最小且可解释，不含任何删内容操作。
