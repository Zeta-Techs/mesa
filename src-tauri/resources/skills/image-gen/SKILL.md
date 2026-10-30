---
name: image-gen
description: 用 Mesa 连接页里配好的出图模型生成图片或在已有图上改（gpt-image、Gemini、Grok、豆包 Seedream、通义万相、CogView 等各家都可）。用户要插图、示意图、封面、配图、海报、图标草图等「按描述画一张图」，或发来一张图要求「在这张图上改」（换颜色、去背景、加减东西、换风格）时使用；数据图表、统计图不用它（交给 figure-forge / data-eda 用脚本画），不生成冒充实验结果的图像。
outputs: [figures/]
---

# 出图（Mesa 出图模型）

Mesa 启动你时在环境变量 `MESA_IMAGE_TOOL` 里放了出图工具的路径。它用用户在 Mesa 连接页最下方「出图模型」选的网关和模型，密钥由工具自己取——**你看不到也不需要密钥，不要去找、不要打印任何密钥**。

## 先确认能用

- macOS / Linux：`"$MESA_IMAGE_TOOL" image --list`
- Windows PowerShell：`& $env:MESA_IMAGE_TOOL image --list`

输出第一行是默认出图模型，后面是各网关目录里能出图的模型。`MESA_IMAGE_TOOL` 为空：说明不是在 Mesa 里启动的，或这版 Mesa 还没带出图工具——停下告诉用户，不要改用别的方式绕过。第一行说「还没配置出图模型」：请用户到 Mesa 连接页最下方「出图模型」里选一个，或者用户指定了模型时加 `--model`。

## 动笔前先定三件事

1. **用途**：草图 / 看方向、正文示意图、图形摘要（TOC graphic）、封面、图标。用途决定画幅、分辨率和风格，用户没说就按下表取默认，交付时说明取了什么。
2. **画幅**：`--size` 写宽高，比如方图 `1024x1024`、横版 `1536x1024`、竖版封面 `1024x1536`。期刊对图形摘要有尺寸要求时按期刊要求的比例写。
3. **清晰度**：看方向用默认就行；要放进稿件、要打印的才加 `--resolution` / `--quality`（见下文），它们更慢、更贵。

| 用途 | 画幅 | 清晰度 | 风格默认 |
|---|---|---|---|
| 草图、看方向 | 默认 | 默认，可加 `--n 2` 多出几张让用户挑 | 按用户说的 |
| 正文示意图 | 按版面，常用横版 | `--resolution 2k` | 扁平矢量风、白底、线条清楚、少装饰 |
| 图形摘要 | 按期刊要求 | `--resolution 2k` | 同上，一眼看懂一个主要信息 |
| 封面 | 竖版 | `--resolution 2k` 或 `4k` | 可以写实或艺术化，留出放标题的空白 |
| 图标、贴纸 | 方图 | `--transparent` | 简单图形、粗轮廓、透明底 |

## 描述怎么写

描述用英文写，效果通常更稳；用户说中文时由你翻译。按这个顺序写成一段话，每项一两个短语，不要堆砌形容词：

1. **主体**：画什么，数量和相互位置写清（「three cells in a row, the middle one larger」）。
2. **构图**：视角、主体在画面哪里、留白（「centered, top-down view, generous white space on the right」）。
3. **风格**：flat vector illustration / isometric diagram / watercolor / photorealistic 等，挑一个，不要混写。
4. **配色与光线**：给两三个具体颜色或色系（「muted blue and orange palette」），写实图再写光线。
5. **不要什么**：「no text, no watermark, no extra objects」——这样写比单独列一串负面词更管用。

科研示意图的写法示例：

```text
A clean flat vector diagram of a lipid nanoparticle delivering mRNA into a cell:
the nanoparticle on the left, the cell membrane in the middle, mRNA strands released
inside the cytoplasm on the right. Side view, left-to-right flow, white background,
thin dark outlines, muted blue and coral palette, no text, no labels.
```

描述超过一两行、带引号或换行时，写进文件用 `--prompt-file`。

## 图里的文字

出图模型写短标题多数能写对，但仍会重字、漏字、拼错，还会自己编出没要的小字；字越多越长越容易错。

- **默认不让模型画文字**：描述里写 `no text, no labels`。标注、图例、标题交给后面一步：示意图用脚本（Python matplotlib 叠字）或让用户在 PPT、Illustrator 里加，图形摘要在排版时加。
- 用户确实要图里带字（海报标题、标牌）：字越少越好，原文写进引号，比如 `a title that reads "OPEN LAB"`、`标题写着“开放日”`。2026-10-30 用一中一英两个短标题实测：gpt-image-1.5 / 2.5、gemini-3-pro-image、qwen-image-2.0-pro、wan2.6-t2i 都写对了；豆包 seedream-4 把「细胞信号实验室」写成了「细胞信号实验验室」；gemini-3.1-flash-image 标题对，却自己编了日期、地点等小字。要字时优先用写对的那几家，描述里加 `no other text`。
- 长句、小字、公式、图例，任何模型都不可靠，不要让模型画。
- 画完必须逐字核对（见「画完自检」），错一个字就不能当成品交。

## 出图

```bash
"$MESA_IMAGE_TOOL" image --prompt "…" --size 1536x1024 --out figures/mechanism.png
```

Windows PowerShell：`& $env:MESA_IMAGE_TOOL image --prompt "…" --out figures/mechanism.png`

可选参数：

- `--model <模型名>`：用户点名某家（如 `gemini-3-pro-image`、`doubao-seedream-4-0-250828`）或下表说该换模型时才加；工具会去有这个模型的网关找。
- `--size 1536x1024`：画幅。OpenAI 系按尺寸，Gemini 系换成最接近的宽高比；有的模型只出自己支持的尺寸。
- `--resolution 1k|2k|4k`：分辨率档位，按 `--size` 的比例把长边放到 1024 / 2048 / 4096 像素。4K 一张常要 2 到 4 分钟。
- `--quality low|medium|high`：画质档位。`low` 出草图快，`high` 用于定稿。
- `--transparent`：透明背景（png）。
- `--n 2`：一次几张（1–4），文件名自动加 `-1`、`-2`；Gemini 系几张同时出，不会多等几倍时间。
- `--prompt-file 描述.txt`：从文件读描述。

一张图常要 20 秒到 3 分钟，耐心等，别重复提交。在带沙箱的 Agent 里（如 Codex 的 workspace-write），命令联网会被拦、报「连不上网关」：按你自己的提权流程申请联网重跑这一条，不要改用别的方式。

### 输出怎么读

成功时每张图输出两行：

- `saved: 绝对路径`——**以这一行为准**：扩展名会按实际格式改（模型回 JPEG 就存成 .jpg），同名文件已存在时自动加 `-2`，不覆盖；
- `size: 宽x高`——实际出了多大。

可能还有一行 `note:`，**必须读，并转告用户**。网关收下参数不等于模型照做，所以工具出完图会按实际的图核对：

- 不支持的选项（比如给 Gemini 加 `--transparent`）说明没生效；
- 网关拒收某个选项时，去掉它自动重出一次，并说明去掉了什么；
- 画幅和 `--size` 对不上、分辨率没到 `--resolution` 那档、要了透明底但图里没有透明像素，都会写明。

`note:` 说没达到要求，这张图就不能当成按要求交付的成品：要么换模型重出（用户同意后加 `--model`），要么交给用户时讲清差在哪。

### 各家能做到什么

2026-10-30 在一个中转网关上实测。用户的网关可能不同，**以 `size:` 和 `note:` 为准**，这张表只用来提前挑模型：

| 模型 | 按 `--size` 出画幅 | 能到多大 | `--quality` | `--transparent` |
|---|---|---|---|---|
| gpt-image-1.5、gpt-image-1-mini | 只有 1024×1024、1536×1024、1024×1536 三种 | 1536 | 有效 | 有效 |
| gpt-image-2、gpt-image-2.5 | **不按**：不管要什么都出接近方形、约 1250 像素见方的图 | 约 1250 | 网关接受 | 有效 |
| gemini-3-pro-image、gemini-3.1-flash-image、gemini-nano-banana-2.1 | 按（取最接近的宽高比） | 2K、4K | 不支持 | 不支持 |
| gemini-3.1-flash-lite-image、gemini-2.5-flash-image | 按 | 只出 1K | 不支持 | 不支持 |
| 豆包 doubao-seedream-4-0 | 按 | 4K | 不支持 | 不支持 |
| 通义 wan2.5 / wan2.6-t2i、qwen-image-2.0-pro | 按 | 未测大图 | 不支持 | 不支持 |

所以：

- 要横版、竖版：别用 gpt-image-2 / 2.5，换 gpt-image-1.5、Gemini 或豆包。
- 要 2K / 4K：换 gemini-3-pro-image 或豆包 seedream-4。
- 要透明底：用 gpt-image 系。
- 默认模型做不到时，告诉用户换哪个、为什么，用户同意了再加 `--model`。
- `wan2.6-image` 这类只能改图，文生图要用 `wan2.6-t2i`。
- 豆包默认会在右下角打「AI生成」水印，工具已经替你关了。
- Grok 的图要从 x.ai 下载，国内直连常下不动，工具会报「连不上 imgen.x.ai」，请用户到 Mesa 设置 → 网络填出网代理。

## 画完自检

每张图交付前你自己先看：能读图就用读文件的工具打开 `saved:` 那张图（太大时先缩小一份再看，别把几十 MB 的原图直接读进来）。逐条对：

1. **要的东西都在**：主体、数量、位置、朝向和描述一致；没有多出来的手指、部件、物体。
2. **科学上没画错**：结构、方向、比例不违背常识（细胞膜是双层、箭头方向对、分子没有凭空多出来的键）。拿不准的点照实告诉用户，不要替用户判定「差不多」。
3. **文字**：要求无字的确实没字；有字的逐字核对（重字、漏字、错字），也要找模型自己编出来的小字（日期、地点、署名、假的说明文字），有一处就不合格。
4. **画面质量**：没有明显糊、拼接缝、变形；`size:` 的画幅和大小符合要求，`note:` 没说哪项没达到。

不合格就改描述再出，说清这次改了什么。最多重出三轮；三轮还不行就停下，把最好的一张交给用户，说明哪里还不对、建议换哪个模型或让人手工修。不能看图时直说「我看不了图，请你确认」，不要声称检查过。

## 在已有图上改

用户发来一张图并说怎么改时，带上原图改，不要只凭文字重画——重画会丢掉原图的构图和细节。要改的图在消息里是这几种写法：

- `原图：路径`：Mesa 聊天里点图「接着改」发来的，就是要改的那张，`--image` 用它；
- `标注图：路径`：同一张图上画了框、箭头、编号（①② 对应消息里的话），只用来看位置。你能看图就用读文件的工具看它，把位置写进描述；看不了图就只按文字改，**不要**把标注图传给 `--image`（框和编号会被画进新图）；
- 单独一行的图片路径：用户粘贴或拖进来的图，也是要改的那张。

```bash
"$MESA_IMAGE_TOOL" image --image 原图.jpg --prompt "Keep everything else the same, change the straw hat to a blue baseball cap" --out figures/cover-v2.png
```

- 描述只写要改的地方，并写明其余保持不变；用户说中文时照样可以翻成英文描述。
- 「去背景」「擦掉某处」「换画幅」也走这条：分别写成 remove the background / remove the … / extend to 16:9 等。要真正透明的底，用 gpt-image 系加 `--transparent`。
- 新图另存一个名字（`-v2`、`-blue-cap`），不覆盖原图；`--image` 最多 4 张（比如「把这两张合成一张」）。
- 改完同样走「画完自检」，额外核对没要改的地方确实没变。

## 用进论文时

- 期刊一般要求按成品尺寸 300 dpi：单栏宽约 8.5 cm，约 1000 像素；双栏宽约 17.5 cm，约 2100 像素。要进稿件的图至少 `--resolution 2k`，出不到就照实告诉用户这张只够当草图或预览。
- 出图模型不会把小图「变清晰」：不要拿放大、插值冒充高分辨率。
- 尺寸、字体、配色的期刊规格归 figure-forge 管；出图模型只出插画部分，规格对齐和叠字在后面一步做。
- 交付时提醒用户：AI 生成的示意图投稿时多数期刊要求在图注或方法里注明，并查目标期刊对 AI 生成图像的政策。

## 放哪、怎么交代

- 研究项目放 `figures/`，编程项目放用户指定的位置（没说就问）；文件名用英文短词。
- 把最终用的描述原文和参数记下来（同目录 `<图名>.prompt.txt`，第一行写模型和 `--size` / `--resolution` 等参数），方便重画。
- 交付时说清：用的哪个模型、什么画幅和分辨率、存在哪、自检看了什么、还有哪些拿不准；说明这是 AI 生成的示意图。回复里写出图片的完整路径——Mesa 聊天里会把它直接显示成图，用户点图就能接着标注、接着改。

## 边界

- 不生成冒充实验观测、显微照片、电泳条带、病理切片、仪器截图等「看起来像真实数据」的图；用户要的话说明风险，只做明确标注为示意的版本。
- 数据驱动的图（曲线、柱状图、统计图）用脚本画，不用出图模型。
- 失败时照实转述工具的报错（网关没开通这个模型、额度不足、内容被拒等），不要换个模型偷偷重试；可以建议用户换哪个模型。自检不合格时重出属于正常流程，不算偷偷重试，但要在交付时说重出了几次。
