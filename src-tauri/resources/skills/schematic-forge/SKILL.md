---
name: schematic-forge
description: 科研示意图规范：机理图、装置 / 实验流程示意、技术路线图、概念图、图形摘要（TOC 图）、组会大图，以及把几张图拼成 (a)(b)(c) 组图、把已有图复刻成可编辑版。先写立意和事实，再写图纸 figure.json，由随包脚本渲成可编辑的 PPTX + SVG（文字是真文字）和 PNG 预览，出图模型只画不带字的图标。数据曲线 / 统计图归 figure-forge，照片级三维归 blender-research，从文献 PDF 裁图拼板归 review-figures。
outputs: [figures/]
provides: [schematic-forge]
---

# 科研示意图（schematic-forge）

交给人的是**能改的源文件**：`figures/<图名>/<图名>.pptx`（PowerPoint / WPS / Keynote 里改）、`.svg`（Illustrator / Inkscape 里改）、`.png`（预览），外加生成它们的图纸 `figure.json`。文字永远是真文字，图标才用出图模型画。

> 命令里的 `python3` 指本机 Python 3：**Windows 上改用 `python`**。脚本都在本技能目录的 `scripts/` 下（下文写 `scripts/…`，运行时写全路径），在项目 / 工作区根目录运行。

## 0. 先确认能用

- `python3 -c "import PIL, pptx"`：缺 python-pptx 时请用户在 Mesa「设置 → 依赖」装，或 `python3 -m pip install python-pptx`。
- `$MESA_FIGURE_TOOL` 不为空：PNG / PDF 由它从 SVG 转；为空时脚本退用 LibreOffice，都没有就只出 SVG / PPTX——照实告诉用户。

## 1. 定档（第一句回复就写，不先问）

一行写清你按什么定的：用途（`journal` 期刊示意图 / `graphical-abstract` 图形摘要 / `roadmap` 技术路线 / `slide` 组会 / `poster`；**用户给了物理尺寸就按尺寸选**：183 / 89 mm 这类栏宽用 graphical-abstract 或 journal，`slide` 只配 16:9 整页，它的字号下限是 14 pt）、成品尺寸（单栏 89 mm、双栏 183 mm、16:9 幻灯片 254×143 mm、期刊 TOC 规格按作者指南）、语言、深度（**草稿**：一个构思、检查通过即交；**标准**：2–3 个构思让人挑、加冷读与事实逐条核对；用户没说按标准）、风格参照（用户给的图，或项目里已有的图——有 `figures/style-profile.json` 就照它）。

## 2. 立意 `figures/<图名>/brief.md`

- 一句话要点（读者看完带走什么）；3–6 条要点（用户原话优先，照抄）；**不能暗示什么**；范围。
- 规格卡：尺寸；主角（哪个元素最显眼）；面板（各自职责与占比）；元素表——标签原文、外观、**来源**（画 / 由数据算 / 取自项目文件 / 查实物参考 / 出图模型，附理由；形状由数据决定的元素必须算出来或取真实数据）；关系；约定（颜色含义、线型）；不能出现什么。

## 3. 事实 `figures/<图名>/facts.md`

每个要画的东西：是什么、顺序、方向、数量、谁作用于谁，**每条带出处**（笔记 / 论文 [@键] / 用户原话 / 项目文件路径）。没出处的写「不确定」：要么问用户，要么故意画模糊（数量写 N 或省略号）。

- **图上要出现的每段文字都先写进 brief.md 或 facts.md**——检查脚本逐段比对，找不到原文的拦下。
- 连线关系一行一条：`- 关系：<元素 id 或框里原文> → <元素 id 或框里原文>（出处）`，检查脚本核对图上有没有这条箭头、方向对不对。
- 画这项工作的具体实例，不画教科书通用版；只画手上有的数字；示意曲线结构要对、精度不能高过实际，图注写明是示意。

## 4. 构思

- 草稿档一个，标准档 2–3 个**布局真不一样**的方案：各写一份 `figures/<图名>/concepts/c1.json`（图纸格式同下，可先只放框和关键字；`name` 各写成 `<图名>-c1`、`-c2`…，同名会互相覆盖），`python3 scripts/render_figure.py figures/<图名>/concepts/c1.json --formats svg,png --no-record` 出缩略图，把几张 PNG 路径一起给用户，**停下等用户挑一个**（这是本技能唯一的停点）。
- 用户想先看风格时，才用出图模型出 1–2 张「效果参考图」（按 image-gen 技能），明确说「只看风格，字不算数」，**永远不当成品交付**。

## 5. 图纸 `figures/<图名>/figure.json`

```json
{"name": "rads-strategy",
 "canvas": {"width_mm": 183, "height_mm": 100, "purpose": "graphical-abstract", "background": "#FFFFFF"},
 "theme": {"base_pt": 7, "line_pt": 0.75, "font": ["Arial"], "font_cjk": ["Source Han Sans SC", "PingFang SC", "Microsoft YaHei"],
           "colors": {"primary": "#1F4E79", "accent": "#C55A11"}},
 "elements": [
  {"id": "title", "type": "text", "x": 0, "y": 2, "w": 183, "h": 7, "text": "…", "pt": 10, "bold": true, "align": "center"},
  {"id": "s1", "type": "box", "x": 4, "y": 14, "w": 40, "h": 46, "fill": "primary@12", "stroke": "primary", "radius_mm": 2,
   "text": "**策略一：载体改性**\n引入 Al_{2}O_{3} 提高 Ni 分散度", "valign": "top", "pt": 6.5},
  {"id": "s1-icon", "type": "image", "x": 12, "y": 34, "w": 24, "h": 22, "src": "assets/zno-support.png",
   "source": {"kind": "image-model", "model": "gpt-image-1.5", "prompt_file": "assets/sheet.prompt.txt"}},
  {"id": "core", "type": "ellipse", "x": 70, "y": 30, "w": 40, "h": 40, "fill": "accent@20", "stroke": "accent", "text": "Ni/ZnO"},
  {"id": "a1", "type": "arrow", "from": "s1", "to": "core", "stroke": "primary", "stroke_pt": 1, "label": "分散"}
 ]}
```

- 坐标、宽高一律**毫米**，按成品尺寸写；字号、线宽用 pt。叠放按列表顺序（后画的在上）。`name` 只用英文、数字、`-`。
- `box` / `ellipse`：`fill`、`stroke`、`stroke_pt`、`dash`（`dash` / `dot`）、`radius_mm`；可带 `text`（框内文字，默认居中，`align` / `valign` / `pad_mm` 可改）。`text`：无框文字（默认左上对齐）。
- 文字写法：`\n` 分段，`**粗体**`、`_{下标}`、`^{上标}`（Al_{2}O_{3}、mg g^{-1}，粗体里可以套：`**NiFeB_{0.33}-700**`）；`pt`、`bold`、`italic`、`color`。换行由脚本按本机字体量好写死（上下标、收尾标点不会单独成行），不用自己断；标记没成对会原样印出来，检查会拦下。
- 颜色：`#RRGGBB`、`theme.colors` 里的名字、`名字@15`（15% 浓度的浅色衬底）。一个实体一种颜色贯穿全图，饱和色只给主角。
- `image`：`src` 是相对图纸目录的 png / jpg / svg，或内置图元 `lib:名字`（`colors: {"C1": "#…"}` 改色）；出图模型画的必须写 `source`。
- `arrow` / `line`：`from` / `to` 写元素 id（自动从相对的两条边中点连，`from_side` / `to_side` 可指定 top / bottom / left / right）或 `[x, y]`；`head`（end / start / both / none）；`route: "elbow"` 走横—竖—横直角线（只用于左右边进出）；`label` + `label_w`。`polyline`：`points` 折线。
- 期刊示意图：标签 2–4 词名词短语、贴着所指的东西，解释进图注；一个面板一个想法；三维只给几何上有意义的主角。图形摘要、组会大图可以多写字，但同级文字字号统一。

## 6. 素材（图标位按顺序取）

1. **内置图元**：`scripts/icons/index.json` 按中文名 / 关键词找（通用实验、化学催化、材料、能源、生物、光学、工程、流程符号共 73 个），`"src": "lib:beaker"`；`python3 scripts/render_figure.py --list-icons` 列名字。默认色是蓝 / 橙 / 深灰，少数自带自然色（火焰、叶子、警示）——同一张图里用 `colors: {"C1": "#…", "C2": "#…"}` 统一到 theme 配色。
2. **项目里已有的素材**（用户给的、`figures/library/` 里的）。
3. **出图模型画**——一张素材板出全部图标，风格一致、只调一次模型：
   `python3 scripts/asset_sheet.py prompt --names "a,b" --subjects "English description,…" > figures/<图名>/assets/sheet.prompt.txt`（主体描述用英文，与 image-gen 一致）→
   `"$MESA_IMAGE_TOOL" image --prompt-file figures/<图名>/assets/sheet.prompt.txt --size 1536x1024 --resolution 2k --out figures/<图名>/assets/sheet.png` →
   `python3 scripts/asset_sheet.py split figures/<图名>/assets/sheet.png --grid 2x1 --names "a,b" --out-dir figures/<图名>/assets --model <实际模型>`。
   素材板优先用按画幅出图的模型（gpt-image-1.5、gemini-3-pro-image、豆包 seedream；gpt-image-2 / 2.5 不按 `--size` 出），画幅不对也能切——按实际出的图写 `--grid`。切不干净（空格、碰格边、图里有穿透孔或边缘发粉）脚本会拒绝：描述里强调实心、不透底后重出，边缘还发粉可把 `--tolerance`（默认 40）调到 60；或量好像素写 `--boxes`，不要硬切。split 的 `note:` 给出该写进图纸 `source` 的 `prompt_file`。不画看起来像实验数据的东西（显微照片、谱图、条带）。

## 7. 渲染、检查、冷读

1. `python3 scripts/render_figure.py figures/<图名>/figure.json --pdf output/figures/<图名>.pdf` → `.svg` `.pptx` `.png`、`render.json`，并登记进 `figures/manifest.json`。`note:` 行必须读并转告（字体回落、缺工具、AI 元素）。
2. `python3 scripts/schematic_check.py figures/<图名>/figure.json` → 结果进 Mesa 评审页核验清单。**拦下的逐条改到没有**（只改出问题的那一处，已通过的素材不重画；重试前必须改了输入或条件）；「待你判断」的能改就改，不改的写明为什么保留。
3. **冷读**（标准档；能看图才做）：只看 PNG，先写「这张图在说什么」一句，再对 brief.md 的一句话；再按 facts.md 逐条对数量、方向、顺序、连接。不能看图的模型照实说没做，这两项交人。检查全过不等于图对。

## 8. 交付

回复里写：PNG 的完整路径（Mesa 聊天会直接显示）、PPTX / SVG 路径、用了什么字体、检查结果（拦下 0、待你判断几条及处理）、哪里拿不准；图注草稿（写明 schematic / 示意，自含）；有出图模型元素时给 AI 使用说明一句（模型名、哪些元素），提醒查目标期刊对 AI 图像的政策。PPTX 里图标挂了 SVG 原件，PowerPoint 2016+ 可右键「转换为形状」再改。

## 9. 人改过之后（铁律）

render.json 记着每次输出的哈希。人在 PPT / Illustrator 里改过后：**只在那份文件上局部改**，不从图纸重新生成——渲染器会拒绝覆盖（退出码 4）。
`python3 scripts/pptx_edit.py list|set-text|move|style|image|delete|add-text|preview figures/<图名>/<图名>.pptx --shape <名字> …`（形状名就是图纸里的元素 id；每次改前自动备份到 `.history/`）。用户明说「推倒重来」才 `render_figure.py … --force`。

Mesa 聊天里点这张 PNG「接着改」发来的消息带 `原图：` `图纸：` `可编辑文件：` 三行（标过还有 `标注图：`，①② 对应消息里的话）：先看 render.json 判断 PPTX / SVG 人改过没有——没改过就改图纸重渲，改过就用 pptx_edit 在那份上改；标注图只用来看位置。

## 10. 组图（拼版）

把数据图、示意图、照片拼成一张 (a)(b)(c)：图纸里每块写 `{"id": "pa", "type": "figure", "x": …, "y": …, "w": …, "h": …, "src": "../fig2-ablation.svg", "label": "a"}`；顶层 `"panel_labels": {"pt": 8, "bold": true}` 统一面板字母。检查脚本会按缩放后的尺寸查每块里最小字号、同排字母是否在一条线上。照片块只许整体缩放、`crop: [x, y, w, h]`（像素）裁切，不改像素。画布宽按目标期刊栏宽。
单张数据图要进组会 PPT：`python3 scripts/render_figure.py --wrap figures/fig2.svg`（出 `figures/fig2-slide/`，SVG 嵌在 PPTX 里、标题和图注是文本框）。

## 11. 复刻：把已有图拆成可编辑（用户给一张图要「拆开能改」）

只有能看图的模型才做，看不了图就直接说做不了。
1. `python3 scripts/measure_text.py <原图.png> --width-mm <成品宽>` 量出每行文字的位置、字号（按墨迹高度换算，同级聚成一组统一字号）→ `figures/<图名>/measure.json`；文字内容由你看图读出，填进图纸。
2. 图标：`asset_sheet.py` 的思路——让出图模型改图「把原图里的图标原样摆到品红底素材板上，不美化、不加字」，再 split；纯色 / 渐变背景用框重建，不调模型。
3. 渲染后 `python3 scripts/overlay.py <原图.png> figures/<图名>/<图名>.png` 出叠图对比与偏差最大的区域，只修对不上的那几处。
4. 复刻别人已发表的图只作风格参考或附出处，不当原创交付。

## 12. 课题组风格

`python3 scripts/style_profile.py figures/ --out figures/style-profile.json` 从项目已有的图（SVG / PNG）归纳常用配色、字体、字号、线宽，写成可直接放进 `theme` 的一块。拿给用户确认；用户觉得对，可以在 Mesa 里把它记进项目知识「已定」——你不能自己写项目知识。

## 红线

- 出图模型不写字；文字、标注、图例一律是图纸里的真文字。不生成冒充实验数据的图。
- 不打总分、不用模型给图评分当门槛；检查只分通过 / 拦下 / 待你判断。
- 人改过的文件为准；不把 PNG 当唯一交付；不在 Mesa 外另找编辑器装插件。
