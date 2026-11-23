---
name: schematic-forge
description: 科研示意图规范：机理图、装置 / 实验流程示意、技术路线图、概念图、图形摘要（TOC 图）、组会大图，以及把几张图拼成 (a)(b)(c) 组图、把已有图复刻成可编辑版。支持顶刊「三明治图层架构」（AI 无字 2.5D 主视觉底图 hero_panel + 归一化锚点矢量叠层）、弯曲贝塞尔与耦合反应箭头、自由能台阶/火山线/DOS 科学曲线、3D 径向高光原子球与晶格阵列、胶囊卡片与圆点引出线。先写立意和事实，再写图纸 figure.json，渲成可编辑 PPTX + SVG（文字是真文字）和 PNG 预览。数据曲线 / 统计图归 figure-forge，照片级三维归 blender-research，从文献 PDF 裁图拼板归 review-figures。
outputs: [figures/]
provides: [schematic-forge]
---

# 科研示意图（schematic-forge）

交给人的是**能改的源文件**：`figures/<图名>/<图名>.pptx`（PowerPoint / WPS / Keynote 里改）、`.svg`（Illustrator / Inkscape 里改）、`.png`（预览），外加生成它们的图纸 `figure.json`。文字永远是真文字，出图模型只画**无字主视觉底图**或**无字局部图标**。

> 命令里的 `python3` 指本机 Python 3：**Windows 上改用 `python`**。脚本都在本技能目录的 `scripts/` 下（下文写 `scripts/…`，运行时写全路径），在项目 / 工作区根目录运行。

## 0. 先确认能用

- `python3 -c "import PIL, pptx"`：缺 python-pptx 时请用户在 Mesa「设置 → 依赖」装，或 `python3 -m pip install python-pptx`。
- `$MESA_FIGURE_TOOL` 不为空：PNG / PDF 由它从 SVG 转；为空时脚本退用 LibreOffice，都没有就只出 SVG / PPTX——照实告诉用户。

## 1. 定档、期刊合规与视觉架构选型（第一句回复就写）

一行写清你按什么定的：用途（`journal` 期刊示意图 / `graphical-abstract` 图形摘要 / `roadmap` 技术路线 / `slide` 组会 / `poster`；**用户给了物理尺寸就按尺寸选**：183 / 89 mm 这类栏宽用 `journal` 或 `graphical-abstract`，`slide` 只配 16:9 整页，字号下限 14 pt）、成品尺寸（单栏 89 mm、双栏 183 mm、16:9 幻灯片 254×143 mm）、语言、配色方案（`theme.palette`）、像素来源（零 AI 像素 / 允许生图）、架构模式与深度（**草稿**：一个构思、检查+冷读通过即交；**标准**：2–3 个构思让人挑、加冷读与事实逐条核对；用户没说按标准）。

**期刊 AI 图像合规红线（动笔前先查 `TASK.md` 去向 / 目标期刊）**：
- 凡 `TASK.md` 写明「去向：投期刊」或目标期刊属于 Springer Nature（含 Nature Portfolio / EER）、Elsevier（含 Cell / Joule / Chem）、ACS、RSC、Wiley、Science 等明确限制/禁止生成式 AI 图像进科研成品的期刊，**默认禁止使用 `$MESA_IMAGE_TOOL` 生成成品 `hero_panel` 或图标**（`schematic_check.py` 会直接拦截 `AI-POLICY`）。
- 正式投稿一律走**零 AI 像素管线**：三维装置/界面/晶体结构用 `blender-research` 技能渲染透明底插画 PNG 并自动导出 `.png.json` 像素锚点，嵌入 `hero_panel` 后由本技能叠加真矢量箭头与标注；二维机制/决策树/路线图用纯矢量原语（`polygon` / `path` / `lattice` / `sphere` / `lib:*` / `energy_steps` / `volcano_curve` / `dos_lobe`）完成。
- 仅在非正式投稿（组会 PPT / 海报 / 科普封面概念稿）或用户已核实目标期刊允许并批准（图纸顶层写 `"ai_policy_confirmed": true`）时，才可用 `$MESA_IMAGE_TOOL` 出无字底图。

**按图型与学科选架构（顶刊无框极简，告别「满屏彩色套框 / PPT 流程图」）**：
- **双学科视觉预设**：
  - **`nature-minimal`（物理 / 方法 / 器件默认）**：纯白底 + 0.45 pt 细灰分割线 + 留白分组 + 极简底基线谱图；
  - **`chem-review-pastel`（化学 / 材料 / 能源综述默认）**：**无外框全出血淡彩渐变分幕底（`@6`–`@10`，`role: "backdrop"`）+ 左侧 1.2–1.6 mm（约 3 pt）深色竖条 + 渐变实心短导向箭头 + 圆形微阴影放大视窗（zoom medallion）**，替代笨重套框 `header_card` 与深色 `chevron` 横幅。
- **构图拓扑决策表（按阶段数硬绑定，杜绝 5 窄列硬挤与伪因果）**：
  - `2–3` 个带 3D/复杂结构图的阶段 → 单行左向右；
  - `4` 个阶段 → `2×2` 或「左 2+2 双轨并行 → 右汇流」；
  - `5` 个阶段 → **禁止 5 窄列横排**，也**禁止 3+2 上下居中画单支向下箭头（会视觉误连第 2 步 → 第 5 步）**；强制采用「**左 3+2 双轨并行 → 右侧通高裁决/汇流塔**」或连续 U 型蛇形回环；
  - 183 mm 双栏图中，单个 3D 主视觉宽度建议 **≥ 32 mm（≥ 17% 栏宽）**，低于 28 mm 必须减少同行节点数或拆图。
- **机理图 / 综述总结图 / TOC 图** → 用**「三明治图层架构」**：
  1. **底层（Canvas / Clean Partition）**：纯白画布为主，仅用极浅衬底（`@6`–`@10`，`role: "backdrop"`）或 0.45 pt 细分割线划分区域，不给每个小元素套实线外框；
  2. **中层（Visual Hero，占主面板面积 60%–75%）**：正式期刊投稿用 `blender-research` 输出的透明底 3D 插画 PNG（带同名 `.png.json` 自动锚点）或纯矢量 `lattice` + `sphere` + `lib:*` 组合；非投稿/已批准场景才用 `$MESA_IMAGE_TOOL` 生成无字 2.5D 底图；
  3. **顶层（Vector Overlay）**：全部由 `figure.json` 精确控制的 `callout`（0.45–0.75 pt 圆点引出线）、`bend` 弯曲反应弧线、`coupled_in`/`coupled_out` 分叉耦合箭头、真文字分子式上下标，以及 `energy_steps` / `volcano_curve` / `dos_lobe` / `spectrum` 定量示意子面板。
- **标注与物理指代红线（每张图必守）**：
  - **零双写文字**：每个阶段的核心信息只在视觉图元旁标一次，严禁「图上 callout + 图下 `✓` 清单」重复书写同一短语；文字密度控制在 `0.20–0.45 words/cm²`（`> 0.50` 告警、`> 0.70` 直接拦下）；
  - **引线只指真实物理实体**：带圆点 `callout` 只能指向画面里真实存在的物理构件/位点（如电极、晶格键、电解液采样瓶 `sample_vial`）；非实体条件（如 `iR compensation`、`Blank control`、`Inert UHV transfer`）放模块下方或标题旁作无引线短注，**禁止强拉引线指到无关的钢壳、水底或晶胞角**；
  - **禁止重复编号**：用了面板字母 `a–f` 就不再叠加彩色圆圈 `①–⑤`；
  - **禁止多层嵌套细边框**：外层用了白色裁决塔/淡彩分幕时，内部结果块只用「淡彩底 + 左侧 1.2–1.6 mm 粗色条」，**去掉上/右/下三边细边框**，杜绝“大框套小边框卡”的 UI 感；
  - **多轨视觉均衡与复合模块居中**：左 3+2 双轨并行时，下轨 2 格通过适度加宽主视觉或均衡列距填满节奏，不留大片死白再用勉强的过渡短语硬填；同一格内含多个并列实体（如 UHV 腔 + 采样瓶）时，底部判据与红叉按**整格多实体合集中心**对齐并涵盖全部实体，不偏挂在单一左侧构件下；
  - **圆形放大视窗（Zoom Medallion）留足弧边呼吸感**：圆框内顶部/底部标题与谱峰边缘距圆环内壁保持 **≥ 2.5 mm**（`schematic_check.py` 的 `ELLIPSE-MARGIN` 会自动检测贴边）；
  - **禁止底部跨列梳状总线**：全局反馈统一改用画布外缘单条外拱虚线弧，且**反馈弧必须回到审核节点或上游流程重验，严禁跳过审核直接指向通过态**；
  - `chevron` 与 `header_card` 仅限组会幻灯片（`slide`）或用户明确点名要卡片式路线图时使用。

**本机无 Blender 探测与风格路线选择（绝不因缺 Blender 卡死）**：
- 需要三维装置/界面主视觉时，先静默一行探测本机是否装了 Blender（macOS `which blender` 或 `/Applications/Blender.app/Contents/MacOS/blender`；Windows `where blender` 或 `C:\Program Files\Blender Foundation\Blender*\blender.exe`；Linux `which blender`）。**绝不要假设本机一定有 Blender，也不要把缺 Blender 当报错停工。**
- **独立对话作图（没有 `TASK.md` 或非 `auto_continue`）**：定档后把「绘图路线 + 风格参照」合并成**一句清晰选择**问用户（并如实告知本机是否检测到 Blender）：
  - 本机**有 Blender**：A. 零 AI 像素 Blender 3D 插画 + 矢量叠层（正式投稿最稳，推荐） / B. 零 AI 像素纯矢量极简风（`polygon`/`path`/`lattice`/`sphere`/`lib:*`/`spectrum`/`energy_steps`） / C. 出图模型无字底图 + 矢量叠层（适合组会/海报或已确认期刊允许）；可顺带指定参照图或内置配色（如 `nature-reviews` / `chem-rev-mineral`）。
  - 本机**未装 Blender**：只给现实可选方案——A. 零 AI 像素纯矢量极简风（直接可出、100% 符合期刊 AI 政策，推荐） / B. 出图模型无字底图 + 矢量叠层（需确认目标期刊政策） / C. 先安装免费 Blender 后再出 3D 插画；同样可指定参照图或配色。
- **在流水线 `TASK.md` 且 `decision_mode = auto_continue` 中执行时（如综述初稿批量出图）**：
  - 若 `TASK.md`「已定方向」（通常在开工前「与 AI 商量一下」已问过）已写明自绘风格或路线，严格照办；
  - 若未提前定，**免除**「缺风格参照」和 §4「出 2–3 个构思停下等人挑」停点：有 `figures/style-profile.json` 照它，没有按内置 `nature-reviews` 无框极简风出图；正式投期刊若本机**未装 Blender**，自动回落为**纯矢量无框极简风（0% AI 像素）**直接交付，并在验收摘要/交付说明里如实注明「本机未检测到 Blender，已按纯矢量零 AI 像素风完成；如需 3D 装置质感，安装免费 Blender 后可在评审或对话里指定单张重渲」（同一篇的几张示意图共用同一套 `theme`）。

## 2. 立意 `figures/<图名>/brief.md`

- 一句话要点（读者看完带走什么）；3–6 条要点（用户原话优先，照抄）；**不能暗示什么**；范围。
- 规格卡：尺寸；视觉主角（Hero 是什么、占哪块面板 60%–75%）；面板分工与占比；元素表——标签原文、外观、**来源**（矢量原语 / 内置图元 / 出图模型无字底图 / 真实数据算，附理由）；关系；颜色与箭头语义约定（直角折线表流程编排，弯曲弧线表电子转移/物种溢流/循环反馈，分叉耦合表反应物汇入与副产物脱附）；不能出现什么。

## 3. 事实 `figures/<图名>/facts.md`

每个要画的东西：是什么、顺序、方向、数量、谁作用于谁，**每条带出处**（笔记 / 论文 [@键] / 用户原话 / 项目文件路径）。没出处的写「不确定」：要么问用户，要么故意画模糊（数量写 N 或省略号）。

- **图上要出现的科学主张、核心术语与定量数值都写进 brief.md 或 facts.md**——检查脚本按关键词 + 定量数值覆盖核对，不必把 `facts.md` 写成逐字拷贝的字符串罗列（`≤ 4` 字符微标签/角标如 `+e^{-}`、`(a)`、`0D`，纯化学分子式/离子/反应式如 `H_{2}O`、`OH^{-}`、`H^{*}`，标准坐标轴物理量，阶段序号如 `Stage I`，以及标 `"decorative": true` 的纯视觉辅助元素自动放行；无出处的科学主张或数字一律拦下）。
- 连线关系一行一条：`- 关系：<元素 id 或框/标题原文> → <元素 id 或框/标题原文>（出处）`，检查脚本核对图上有没有这条箭头、方向对不对。
- 画这项工作的具体实例，不画教科书通用版；只画手上有的数字；示意曲线结构要对、精度不能高过实际，图注写明是示意。

## 4. 构思

- **独立对话作图**：草稿档一个，标准档 2–3 个**布局真不一样**的方案：各写一份 `figures/<图名>/concepts/c1.json`（`name` 各写成 `<图名>-c1`、`-c2`…），`python3 scripts/render_figure.py figures/<图名>/concepts/c1.json --formats svg,png --no-record` 出缩略图，把几张 PNG 路径一起给用户，**停下等用户挑一个**（除定档时缺风格参照那一问外，这是本技能唯一的停点）。
- **流水线 `TASK.md` 且 `decision_mode = auto_continue`**：跳过多构思停点，直接写主图纸 `figures/<图名>/figure.json` 并走 §7 渲染、核验与冷读闭环。
- 用户想先看风格时，才用出图模型出 1–2 张「效果参考图」，明确说「只看风格，字不算数」，**永远不当成品交付**。

## 5. 图纸 `figures/<图名>/figure.json` 与科研原语

**范例 A（顶刊零 AI 像素机理图：Blender 3D 底图 + 自动 `.png.json` 锚点 + 极简无框叠层）**：

```json
{
  "name": "her-mechanism",
  "canvas": {"width_mm": 183, "height_mm": 100, "purpose": "journal", "background": "#FFFFFF"},
  "theme": {"palette": "nature-reviews", "base_pt": 6.8, "line_pt": 0.6},
  "elements": [
    {"id": "p-hero", "type": "hero_panel", "x": 3, "y": 4, "w": 112, "h": 92,
     "src": "assets/interface_illus.png", "fill": "none", "stroke": "none",
     "hero_margin_mm": [8, 4, 8, 6],
     "source": {"kind": "blender", "script": "analysis/build_scene.py"}},
    {"id": "lbl-a", "type": "text", "x": 4, "y": 4, "w": 80, "h": 5, "pt": 7.5, "align": "left",
     "text": "**a**  Interfacial H_{2}O cleavage & H^{*} spillover"},
    {"id": "sp-arrow", "type": "arrow", "from": "p-hero@mo_site", "to": "p-hero@ni_site",
     "bend": 0.28, "stroke": "accent", "stroke_pt": 1.0, "label": "H^{*} spillover",
     "coupled_in": [{"label": "H_{2}O + e^{-}", "t": 0.22, "side": -1, "stroke": "primary"}],
     "coupled_out": [{"label": "OH^{-}", "t": 0.42, "side": -1, "stroke": "secondary"}]},
    {"id": "c-mo", "type": "callout", "x": 6, "y": 82, "w": 38, "h": 8, "target": "p-hero@mo_site",
     "stroke": "primary", "stroke_pt": 0.55, "text": "**MoO_{2} terrace**\nH_{2}O cleavage", "pt": 6.2},
    {"id": "div-v", "type": "line", "from": [117, 6], "to": [117, 94], "stroke": "#D5DBE0", "stroke_pt": 0.45},
    {"id": "p-dg", "type": "energy_steps", "x": 120, "y": 4, "w": 60, "h": 46, "fill": "none", "box_stroke": "none",
     "title": "**b**  Free-energy profile", "ylabel": "ΔG (eV)", "xlabel": "Reaction coordinate",
     "step_labels": ["H_{2}O^{*}", "TS", "H^{*}", "1/2 H_{2}"], "smooth_ts": true,
     "series": [
       {"label": "MoO_{2}", "levels": [0, 0.86, -0.38, 0], "color": "muted", "dash": "dash"},
       {"label": "Ni/MoO_{2}", "levels": [0, 0.34, -0.09, 0], "color": "accent"}
     ],
     "barrier": {"series": 1, "step": 1, "text": "0.34 eV"}}
  ]
}
```

**范例 B（顶刊无框极简路线/判据图：淡底左色条 + 细分割线，零重框卡片）**：

```json
{
  "name": "evidence-protocol",
  "canvas": {"width_mm": 183, "height_mm": 64, "purpose": "journal", "background": "#FFFFFF"},
  "theme": {"palette": "nature-reviews", "base_pt": 6.8, "line_pt": 0.6},
  "elements": [
    {"id": "z1", "type": "box", "role": "backdrop", "x": 4, "y": 10, "w": 54, "h": 48, "fill": "primary@6", "stroke": "none"},
    {"id": "bar1", "type": "box", "decorative": true, "x": 4, "y": 10, "w": 1.4, "h": 48, "fill": "primary", "stroke": "none"},
    {"id": "t1", "type": "text", "x": 8, "y": 13, "w": 47, "h": 6, "pt": 7.4, "align": "left", "text": "**01  Baseline & Cell**"},
    {"id": "b1", "type": "text", "x": 8, "y": 21, "w": 47, "h": 34, "pt": 6.4, "align": "left",
     "text": "Non-Pt counter\n85% iR correction\nAr^{+} depth XPS"},
    {"id": "z2", "type": "box", "role": "backdrop", "x": 65, "y": 10, "w": 54, "h": 48, "fill": "secondary@6", "stroke": "none"},
    {"id": "bar2", "type": "box", "decorative": true, "x": 65, "y": 10, "w": 1.4, "h": 48, "fill": "secondary", "stroke": "none"},
    {"id": "t2", "type": "text", "x": 69, "y": 13, "w": 47, "h": 6, "pt": 7.4, "align": "left", "text": "**02  Operando State**"},
    {"id": "arr12", "type": "arrow", "from": "z1:right", "to": "z2:left", "stroke": "primary", "stroke_pt": 0.75}
  ]
}
```

### 核心语法与科研专属原语

- **单位与叠放**：坐标、宽高一律**毫米**；字号、线宽用 pt；列表后画的在上。富文本支持 `\n` 分段、`**粗体**`、`_{下标}`、`^{上标}`（粗体里可套上下标）。
- **5 套顶刊验证配色（`theme.palette`）**：
  - `nature-reviews`（深海蓝 `#1B4F72` + 珊瑚橙 `#D35400` + 鼠尾草绿 `#2E8B57` + 暖灰底 `#F7F9FA`）
  - `chem-rev-mineral`（岩青 `#2C3E50` + 琥珀金 `#D4AC0D` + 绛紫 `#7D3C98` + 青瓷 `#148F77`）
  - `jacs-vibrant`、`cell-pastel`、`science-clean`（`python3 scripts/style_profile.py --list-palettes` 查看详情，`--preset <名>` 可导出）。颜色支持 `primary@12`（12% 浅色衬底）；大面积背板只用 8%–15% 淡色，高饱和色留给活性中心与主反应流。
- **三明治主视觉面板（`hero_panel`）**：
  - 支持纯白无框嵌入或柔和圆角背板 + 居中留边嵌入无字底图 `src`（`hero_margin_mm` 留出四周标注空白）。
  - `anchors` 定义底图上的 `0.00..1.00` 归一化位点坐标（按图片实际落点换算毫米坐标）；若同目录存在伴生锚点文件 `<src>.json`（例如 `blender-research` 自动导出的 `assets/cell.png.json`），脚本自动合入其中的 `anchors`（图纸内手写同名键优先）。
- **连线端点与端口语法（`from` / `to` / `target`）**：
  - `元素 id`（如 `"z1"`）：自动选最近边中点；
  - `元素 id:side`（如 `"z1:bottom"` / `"z1:top"` / `"z1:left"` / `"z1:right"` / `"z1:center"`）：指定连接该元素某条边中点或中心（等效于 `from_side`/`to_side`）；
  - `hero_id@锚点名` 或 `["hero_id", nx, ny]`：精准指向 `hero_panel` / `image` 底图上的原子、界面或气泡位点；
  - `[x, y]`：直接毫米坐标。
- **弯曲贝塞尔与反应耦合箭头（`arrow` / `coupled_arrow` / `curve`）**：
  - `"bend": 0.25`（或 `"curve": 0.25`）：二次贝塞尔弧线（正数向上/左拱起，负数向下/右弯曲；也可显式给控制点 `"via": [cx, cy]`），用于电子转移、中间体溢流、催化循环与闭环反馈；独立曲线元素 `"type": "curve"` 可接 `from`/`to` 或 `points`（3 点二次贝塞尔、4 点三次贝塞尔、≥5 点平滑样条，配 `"head": "end"` 可带箭头）；
  - `"coupled_in"` / `"coupled_out"`：在主反应箭头 `t`（`0..1`）处按切向顺滑汇入反应物或分叉脱附副产物，每项可配 `label`、`t`、`side`（`1` 或 `-1` 选分叉侧）、`len_mm`、`stroke`。
- **闭合多边形与任意矢量路径（`polygon` / `path`）**：
  - `"type": "polygon"`：给 `"points": [[x1, y1], [x2, y2], ...]`（毫米，`x/y/w/h` 可省），支持 `fill`、`gradient`、`shading: "radial"`、`stroke`、`shadow`，适合画晶胞切面、多面体晶面与能带填充区；
  - `"type": "path"`：给标准 SVG `"d": "M ... C ... Q ... A ... Z"`（毫米坐标，`x/y/w/h` 可省），支持 `fill`、`gradient`、`stroke`、`dash`、`head`，渲染时 SVG 出 `<path>`、PPTX 自动转为原生可编辑 `<a:custGeom>` Freeform 自由曲线（可用数学公式精确生成火山曲线、电子云包络面与势能面）。
- **科学函数曲线与谱峰（`energy_steps` / `volcano_curve` / `dos_lobe` / `spectrum`，或 `sci_curve` + `kind`）**：
  - `energy_steps`：传 `series: [{"label": "...", "levels": [0, 0.42, -0.1, 0], "color": "accent", "ts_peaks": {"0": 0.65}}]`；设 `smooth_ts: true` 自动生成三次贝塞尔平滑过渡态钟形峰，`barrier` 自动画半透明能垒阴影带与数值标注；
  - `volcano_curve`：传 `points`（或左右支斜率）自动生成平滑样条火山曲线，支持曲线下方渐变填充 `fill_under: "primary@16"` 与 3D 径向高光催化剂散点 `markers`；
  - `dos_lobe` / `spectrum`：传高斯或洛伦兹峰 `peaks`（或 `lobes`）：`[{"center": 0.35, "width": 0.08, "amp": 0.72, "shape": "gaussian"|"lorentzian", "color": "accent", "label": "BO_{x}"}]`；`spectrum` 默认极简无纵轴底基线（`minimal: true`、无费米线），直接绘制 *Nature* 风格 XPS / UPS / Raman 谱峰并在 SVG 与 PPTX 双端可编辑；`dos_lobe` 支持费米能级虚线 `ef_x` 与带中心标尺 `d_centers`。
- **3D 径向高光球体与晶格阵列（`sphere` / `shading: "radial"` / `lattice`）**：
  - `ellipse` 加 `"shading": "radial"` 或直接用 `"type": "sphere"` 生成左上高光 3D 立体球（SVG `<radialGradient>` + PPTX 原生径向渐变形状）；
  - `"type": "lattice"`：`"mode": "grid"` 一行铺出 2.5D 周期晶格基底（`nx`, `ny`, `species`, `vacancies`, `dopants`, `bonds: true`），`"mode": "cluster"` 铺出非晶纳米团簇（`count`, `seed`, `bonds: true`）。
- **胶囊标题卡片、渐变、微阴影与色带横幅（`header_card` / `gradient` / `shadow` / `chevron`）**：
  - `box` 或 `header_card` 支持 `"header": {"text": "Stage I", "fill": "primary", "h": 6}`、线性渐变 `"gradient": ["primary@12", "#FFFFFF"]`（或 `{"from": ..., "to": ..., "angle": 90}`）及柔和投影 `"shadow": "soft"`；
  - `"type": "chevron"`：阶段时间线与流程横幅箭头（首块设 `"lead_in": false` 左端平齐，后续块自动带燕尾凹槽互锁）。
- **45° 圆点引出线（`callout`）**：图元居中、文字放四周空白处，给定文字框 `x, y, w, h` 与目标点 `target`（`[tx, ty]` 或 `"hero@site"`），自动绘制白晕圆点锚头 + 45° 斜线 + 水平托线（`●───╱─── Label`）。

## 6. 素材与无字 2.5D 主视觉底图工作流

1. **多层半透明科研图元库（89 个内置 `lib:*`）**：先查 `scripts/icons/index.json` 或 `python3 scripts/render_figure.py --list-icons`：
   - **晶体与表面**：`lib:crystal-slab`、`lib:core-shell-cutaway`、`lib:porous-sponge`、`lib:ni-foam-mesh`、`lib:mof-octahedron`、`lib:single-atom-vacancy`、`lib:catalyst-surface`、`lib:adsorption-site`、`lib:crystal-lattice`、`lib:layered-structure`；
   - **反应与物理场**：`lib:h2o-molecule`、`lib:oh-species`、`lib:h2-dimer`、`lib:bubble-cluster`、`lib:built-in-efield`、`lib:electron-arc`、`lib:orbital-hybrid`、`lib:molecule-ball-stick`；
   - **装置与表征**：`lib:three-electrode-cell`、`lib:mea-exploded`、`lib:operando-raman-cone`、`lib:fuel-cell`、`lib:reactor`、`lib:fixed-bed-reactor`、`lib:beaker`。
   同一张图里用 `colors: {"C1": "#…", "C2": "#…", "C3": "#…"}` 统一到 `theme` 配色。
2. **无字 2.5D 主视觉底图（Hero Illustration）**：
   - **正式期刊投稿优先走 `blender-research`（零 AI 像素）**：渲染透明底插画 PNG 并自动输出同名 `.png.json` 像素锚点文件，直接填入 `hero_panel.src`，免人工读网格坐标且完全符合主流期刊合规红线。
   - **仅非正式投稿（组会 / 海报 / 科普）或经人确认期刊允许（`"ai_policy_confirmed": true`）时用 `$MESA_IMAGE_TOOL`**：
     - 生成提示词：`python3 scripts/asset_sheet.py hero --subject "English 2.5D description of catalyst interface, lattice step, adsorbed molecules, electron cloud glow..." --palette nature-reviews > figures/<图名>/assets/hero.prompt.txt`
     - 调生图工具：`"$MESA_IMAGE_TOOL" image --prompt-file figures/<图名>/assets/hero.prompt.txt --size 1536x1024 --resolution 2k --out figures/<图名>/assets/hero.png`
     - 叠归一化坐标网格读点：`python3 scripts/asset_sheet.py grid figures/<图名>/assets/hero.png --out figures/<图名>/assets/hero-grid.jpg`，**用看图工具打开 `hero-grid.jpg` 读出各原子/界面/气泡位点的 `(nx, ny)` 坐标**，填进 `hero_panel.anchors`，并在 `hero_panel.source` 记录模型与 `prompt_file`。
3. **局部小图标素材板（多枚独立图标一次出齐）**：
   `python3 scripts/asset_sheet.py prompt --names "a,b" --subjects "English description,…" > figures/<图名>/assets/sheet.prompt.txt` →
   `"$MESA_IMAGE_TOOL" image --prompt-file figures/<图名>/assets/sheet.prompt.txt --size 1536x1024 --resolution 2k --out figures/<图名>/assets/sheet.png` →
   `python3 scripts/asset_sheet.py split figures/<图名>/assets/sheet.png --grid 2x1 --names "a,b" --out-dir figures/<图名>/assets --model <实际模型>`。
   切不干净脚本会 fail-closed 退出 3，按提示重出或写 `--boxes`。绝不画冒充真实实验数据的显微照片、谱图或电泳条带。

## 7. 渲染、检查、多模态冷读闭环（必做）

1. **渲染**：`python3 scripts/render_figure.py figures/<图名>/figure.json --pdf output/figures/<图名>.pdf` → `.svg` `.pptx` `.png`、`render.json`，登记进 `figures/manifest.json`。`note:` 行必须读并转告。
2. **脚本核验**：`python3 scripts/schematic_check.py figures/<图名>/figure.json` → 结果进 Mesa 评审页核验清单。**拦下的逐条改到 0**（含 `AI-POLICY` 期刊生成式 AI 图像拦截）；同时脚本会查文字密度（`> 0.55 words/cm²` 告警，顶刊建议 `0.20–0.45`）、重边框卡片拥挤（`BOX-CLUTTER`）、句子式标题/图注腔标签（`SENTENCE-*`）、引出线穿过无关图元（`CALLOUT-CROSS-*`），并在成品 PNG 旁自动伴生 **360 px 缩略图** `<图名>-thumb360.png`。
3. **多模态冷读闭环（Cold Read，能看图的模型每次渲染后强制执行）**：
   每次生成 `.png` 后，**必须自己用看图工具（`read_file`）同时检查成品 PNG 与 360 px 缩略图 `<图名>-thumb360.png`**，逐项自检并在必要时微调 `figure.json` 重渲：
   - **缩印可读性与文字密度**：缩到 360 px 宽度时标题与主标签是否仍清晰、是否塞了过多解释文字、满屏嵌套边框或图上/图下文字双写？
   - **视觉重心、轨道均衡与圆窗边距**：核心视觉主角是否饱满（双栏 ≥ 32 mm）、多轨并排中少格一轨是否无突兀大空白、多实体复合模块底部文字是否按整格居中、圆形放大视窗内文字是否距圆边留足 ≥ 2.5 mm 呼吸感？
   - **锚点、物理指代与反馈逻辑**：`callout` 的圆点是否精准指在对应真实物理实体上（非实体条件放下方不强拉引线）、连线有没有穿过其他图元、反馈弧是否回到审核/上游节点而非跳过审核直连通过态？
   - **科学事实**：只看图说出的意思是否与 `brief.md` 一致，`facts.md` 里的反应方向、物种化学计量、能垒数值是否丝毫不差？
   不能看图的模型照实声明未做冷读，交人核验。几何检查全过绝不等于图已经好看且准确。

## 8. 交付

回复里写：PNG 的完整路径（Mesa 聊天会直接显示）、PPTX / SVG 路径、用了什么配色与字体、检查结果（拦下 0、待你判断几条及处理）、多模态冷读结论；图注草稿（写明 schematic / 示意，自含）；含出图模型元素时给 AI 使用说明一句（模型名、哪些元素），提醒查目标期刊对 AI 图像的政策。PPTX 里所有曲线、渐变卡片、文本框均可直接编辑，内置图元挂了 SVG 原件可右键「转换为形状」。

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

`python3 scripts/style_profile.py figures/ --out figures/style-profile.json` 从项目已有的图（SVG / PNG）归纳常用配色、字体、字号、线宽，写成可直接放进 `theme` 的一块；也可 `python3 scripts/style_profile.py --preset nature-reviews --out figures/style-profile.json` 直接选用顶刊预设。拿给用户确认；用户觉得对，可以在 Mesa 里把它记进项目知识「已定」——你不能自己写项目知识。

## 红线

- 出图模型绝不写字、不画箭头和坐标轴；文字、公式上下标、引出线、科学曲线一律是图纸里的真矢量与真文字。不生成冒充实验数据的图。
- 不打总分、不用模型给图评分当门槛；检查只分通过 / 拦下 / 待你判断。
- 人改过的文件为准；不把 PNG 当唯一交付；不在 Mesa 外另找编辑器装插件。
