---
name: review-figures
description: 综述文献图拼板。当综述初稿按大纲用图计划需要从论文 PDF 裁源图、组 panel，或不能拼时改为引用 Fig.n 时使用。裁切 fail-closed；排版用随包脚本，不改源图数据含义。
inputs: [outline.md, notes/, papers/]
outputs: [figures/]
provides: [review-figures]
---

# 综述文献图拼板

> 命令里的 `python3` 指本机 Python 3：**Windows 上改用 `python`**（Windows 的 `python3` 是应用商店占位程序，一运行就失败）；macOS / Linux 用 `python3`。

把别人论文里的图变成综述用图：**先裁准，再排齐**。裁哪一块只认大纲用图计划 + 笔记可引用图。美观用随包脚本（对齐、panel 字母、留白），不重绘曲线、不拉伸比例尺。

## 何时使用

- 综述初稿按 `outline.md` 用图计划出图
- 用户要求从已有 PDF 组文献对比图 / 机制拼图

实验结果图走 figure-forge；三维示意走 blender-research。禁止用文生图重画别人的数据图（当示意图草稿可以，不能当定量 panel）。

## 一张拼图 = 一个论点（2026-10-23 用户拍板）

综述拼图是给**一个论点**（一个逻辑段 / 小节要说的那一件事）找证据：从几篇文献里各取**撑这个论点的那一块子图**，拼成一张图。不是把两篇的整张多联图并排——整张六联图里大半与论点无关，缩到栏宽后字也看不清，原图的 a–f 和新编号还叠在一起（2026-10-23 HER 初稿实证：一张拼图塞进 10 个子图）。

- 一张拼图至少 2 块、至少来自两篇；块数**不设死上限**，系统综述一段论述拼 9 块（3×3）很常见。上限由印出来读不读得清决定：双栏 17 cm 一行放 3 块左右、单栏 8.5 cm 一行 1–2 块，每块印出宽度不少于 3.5 cm，整张不高过 23 cm（还要留图注的位置）。放不下就按子论点拆成两张图，各自一句论点，不要硬挤。每块是一个子图（Fig. 2c、Scheme 1 里的一部分），整张本身就是一幅示意图 / 照片时才用整张。
- 同一篇可以出两块，但要各自撑论点的不同侧面；只靠一篇撑的论点不拼，正文写「见 [@键] Fig. n」。
- 大纲用图计划的写法：`拼 图N（论点一句话）= (a) [@键1] Fig.2c + (b) [@键2] Fig.3a + (c) [@键3] Fig.4d`。新编号按计划顺序 (a)(b)(c)，与原图字母无关。

## 缺计划就停

大纲没有「用图：拼 / 仅引用」行 → 不扫笔记自行拼图，在报告里写缺计划。笔记未登记该子图、仅摘要、无 PDF → 这一块去掉；剩不到两块 → 整张改「仅引用 [@键] Fig.n」。旧大纲只写整张（`[@键] Fig.2 + [@键] Fig.4`）时，按笔记可引用图和论点自己挑子图，挑法写进 `figures/README.md`。

## 裁切（fail-closed）

技能目录 `scripts/extract_figure.py`：

```bash
python3 scripts/extract_figure.py --pdf <来源PDF> --fig 3 --out figures/src/<bibKey>-fig3.png
python3 scripts/extract_figure.py --pdf <来源PDF> --fig 2 --panel f --out figures/src/<bibKey>-fig2f.png
python3 scripts/extract_figure.py --pdf <来源PDF> --fig 2 --grid --out artifacts/<bibKey>-fig2-grid.png
python3 scripts/extract_figure.py --pdf <来源PDF> --fig 2 --box 0.505,0,1,0.49 --erase 0,0,0.11,0.1 --out figures/src/<bibKey>-fig2b.png
```

**裁子图的顺序**：

1. `--panel c`：按白缝把整张切成格子、按行数第几块。子图之间没有白缝（坐标轴贴着）就切不出，退出码 6。切出来也要打开看一眼是不是那一块——排版不规整时行优先的顺序和原图字母对不上。
2. 切不出或切错：`--grid` 出一张叠了 0–1 坐标格的整图预览（红线每 0.1 一条，带刻度），看图读出这一块的左上、右下坐标，用 `--box x0,y0,x1,y1` 裁。裁完**打开看**：带进了邻块的坐标轴或字母、截掉了自己的轴标题，就微调坐标再裁，直到干净。
3. 原图的子图字母（左上角的 (b)、e）用 `--erase` 抹白（相对这一块的坐标，只许在左上 / 右上角的小框，超过 2% 面积脚本拒绝；邻块字母的残边被带进来时可以再给一个 `--erase`）。拼图只留新编号 (a)(b)(c)。抹之前放大看清字母的范围，别抹到刻度数字和框线。字母压在坐标轴里抹不掉就保留，图注写清新旧对应。
4. 题注认不出（矢量图退出码 5、扫描版没有文本层退出码 3）：`--page <页码> --grid` 看整页，`--box` 框出那一块（框住大半页会被拒绝）。
5. 读坐标读不准、反复裁不干净：这一块去掉，别把整张塞进来。

**脚本替你查框（2026-10-23）**：`--box` 的四条边先各自挪到附近的空白缝上（略微读偏的框自动对正，先往框外找，不截掉自己的轴标题），打印「实际裁框」——把这组数记进 README。挪完某条边还切在曲线 / 文字上（墨迹比例超过 0.08），脚本退出码 7、不出图：框没对准这一块，回 `--grid` 重读；两三次还是 7 就去掉这一块。贴着整张图外沿的边不挪也不查。自动挪边把邻块的字母带进来、或往里挪截掉了自己的轴标题时，加 `--no-snap` 按你给的边裁（仍查边）。**不要为了过检查把框缩到子图中间的空白里**——那样裁出来的是半块图。

Agent 看不了图（模型只拿到地址、或经第三方看图工具转述）时不要猜坐标：只用 `--panel`，切不出的块去掉，并在 README 写明。2026-10-23 HER 实证：经看图工具读坐标格，子图在 0.505–1.0 读成 0.30–0.60，五张拼图全裁错，README 却写「逐块核验内容正确」。**README 不写「已核验」「内容正确」**，只写裁法和「待人工确认」。

题注认**单独成行、并且以题注开头**的那一行：`Figure n` / `Fig. n` / `图 n`。题注常和上一行正文粘在同一个文本块里，所以不要求整块开头就是题注。行内「Figure n shows」不算。裁切只取该行同一栏、直到相邻题注为止、离题注更近那一侧的**嵌入图像对象**（图可能在题注上，也可能在题注下），再按这些矩形的外沿渲图。过窄的页眉行不当题注。页面上的正文不在图像矩形里，不会进 PNG。没有图像对象的矢量图退出码 5，该板改「见 [@键] Fig.n」，不改回「题注上方切一条页面」。用图计划点名某一块（如 Fig.2f）时只裁那一块（`--panel` 或 `--grid` + `--box`），禁止把整张十几联图放进拼板、图注却写只引用了其中一块。退出码 3 = 无题注，4 = 图像对象接近整页。缺 PyMuPDF 则打印安装提示后停裁，不假装已裁。

禁止：摘要网页截图；整页当 panel；上采样假装分辨率变高。

## 排版

≥2 块都裁到才组图，否则正文只写「见 [@键] Fig. n」。

```bash
python3 scripts/assemble_panels.py --out figures/fig2.png --width-cm 8.5 --inputs figures/src/a.png figures/src/b.png
```

默认：白底、300 dpi、间隙 2.5 mm。宽度用 figure-forge 的通用投稿规格（单栏约 8.5 cm / 双栏约 17 cm）。同一行按各图宽高比分这块栏宽，字母写在图上方，不压在曲线上。不再把每张图拉成一样高后再整页缩小。一行最多 4 块；第 5 块起改 `--rows "a.png b.png c.png" "d.png e.png" "g.png h.png i.png"`（9 块排 3×3），字母跨行连续。脚本按 `--width-cm` 查可读性：哪一块印出来不到 3.5 cm 宽、或整张高过 23 cm，退出码 3、不出图——一行少放几块，或按子论点拆成两张。文献拼板**不做 hero 放大某一篇**。脚本不得改源图像素里的曲线或数值。

每张图先写一句论点（这张拼图让读者看见什么），写不出就不要拼。图注进 `figures/figN.md`：先一句论点，再**逐块**写画了什么和来源，写明实际放进拼板的是哪一块——`(a) η₁₀ and η₅₀ of Ru@Ni–B/NF versus controls in 1 M KOH. Adapted from Fig. 2b of [@key1]. (b) … Adapted from Fig. 2e of [@key2].` 用了整张才写整张 Fig. n。论断进图注，不进图内。

## 自绘示意图

计划要自绘的概念图（设计准则框架、流程示意）用可重跑脚本生成，不含任何实验数字，图注写 schematic。文字多的图最容易互相压住：画完先程序化检查**任意两段文字的外框不相交**，并且都在各自的框里，不过就调字号、换行或挪位置再画（只查「文字在框内」不够——2026-10-23 HER 图 7 斜体标注仍压在正文上）。matplotlib 写法：

```python
fig.canvas.draw()
r = fig.canvas.get_renderer()
texts = [t for t in fig.findobj(matplotlib.text.Text) if t.get_visible() and t.get_text().strip()]
boxes = [(t, t.get_window_extent(r).expanded(1.02, 1.05)) for t in texts]
clash = [(a.get_text(), b.get_text()) for i, (a, ba) in enumerate(boxes) for b, bb in boxes[i + 1:] if ba.overlaps(bb)]
assert not clash, clash
```

## 写进初稿与复查

- 拼成：`![...](../figures/figN.png)`，图注用 `figN.md`
- 仅引用：不插图，写「见 [@key] Fig. n」
- **禁止**在稿里写「Figure N（待绘制）」充产出。计划是「拼」但裁失败 → 降级为仅引用并记 `figures/README.md`，不要留空占位。
- `figures/README.md` 一张图一节：论点一句；每块一行（新编号｜来源 [@键] Fig.n 子图｜裁法：`--panel` / `--box` 坐标 / `--erase`）；去掉的块和原因；**待人工确认**。Agent 读 PNG 经常只拿到地址、看不全一批图，不得把「已目检」写进完成标准。人没看过 PNG，拼图就还是待确认。

## 完成标准

计划里每条「拼」要么有可重跑的 `figN.png` + 源清单，要么已降级并写原因。裁错比漏裁有害。人没看过 PNG 不得把拼图标成定稿。

- 写作约定：不使用彩色 emoji；强调标记用「注意：」或单色 ⚠（U+26A0 U+FE0E）。

---

理念参考：Yuan1z0825/nature-skills（Apache-2.0）nature-figure 的「先立论点 / 多面板对齐 / 人眼终检」；K-Dense-AI/scientific-agent-skills（MIT）scientific-visualization 的「不改数据像素、保留原图、不上采样装细节」；figure-forge 的投稿栏宽与 dpi（本技能不重复那张规格表）。内容按 Mesa 综述裁拼流程重写，不生成他人实验图。
