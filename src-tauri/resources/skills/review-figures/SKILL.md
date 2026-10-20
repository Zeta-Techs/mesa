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

## 缺计划就停

大纲没有「用图：拼 / 仅引用」行 → 不扫笔记自行拼图，在报告里写缺计划。笔记未登记该 Fig.n、仅摘要、无 PDF → 该板改「仅引用 [@键] Fig.n」。

## 裁切（fail-closed）

技能目录 `scripts/extract_figure.py`：

```bash
python3 scripts/extract_figure.py --pdf <来源PDF> --fig 3 --out figures/src/<bibKey>-fig3.png
python3 scripts/extract_figure.py --pdf <来源PDF> --fig 2 --panel f --out figures/src/<bibKey>-fig2f.png
```

题注认**单独成行、并且以题注开头**的那一行：`Figure n` / `Fig. n` / `图 n`。题注常和上一行正文粘在同一个文本块里，所以不要求整块开头就是题注。行内「Figure n shows」不算。裁切只取该行同一栏、直到相邻题注为止、离题注更近那一侧的**嵌入图像对象**（图可能在题注上，也可能在题注下），再按这些矩形的外沿渲图。过窄的页眉行不当题注。页面上的正文不在图像矩形里，不会进 PNG。没有图像对象的矢量图退出码 5，该板改「见 [@键] Fig.n」，不改回「题注上方切一条页面」。用图计划点名某一块（如 Fig.2f）时必须加 `--panel f`。退出码 6 = 这张多联图切不出那一块，正文改成「见 [@键] Fig.n(f)」，禁止把整张十几联图放进拼板、图注却写只引用了其中一块。退出码 3 = 无题注，4 = 图像对象接近整页。缺 PyMuPDF 则打印安装提示后停裁，不假装已裁。

禁止：摘要网页截图；整页当 panel；上采样假装分辨率变高。

## 排版

≥2 块都裁到才组图，否则正文只写「见 [@键] Fig. n」。

```bash
python3 scripts/assemble_panels.py --out figures/fig2.png --width-cm 8.5 --inputs figures/src/a.png figures/src/b.png
```

默认：白底、300 dpi、间隙 2.5 mm。宽度用 figure-forge 的通用投稿规格（单栏约 8.5 cm / 双栏约 17 cm）。同一行按各图宽高比分这块栏宽，字母写在图上方，不压在曲线上。不再把每张图拉成一样高后再整页缩小。一行最多 4 块；第 5 块起改 `--rows "a.png b.png c.png" "d.png e.png"`。文献拼板**不做 hero 放大某一篇**。脚本不得改源图像素里的曲线或数值。

每张图先写一句论点（这张拼图让读者看见什么），写不出就不要拼。图注进 `figures/figN.md`，并且写明**实际放进拼板的是哪一块**：只用了 Fig.2(f) 就写 `Adapted from Fig. 2(f) of [@key]`。用图计划要整张时才写整张 Fig. n。论断进图注，不进图内。

## 写进初稿与复查

- 拼成：`![...](../figures/figN.png)`，图注用 `figN.md`
- 仅引用：不插图，写「见 [@key] Fig. n」
- **禁止**在稿里写「Figure N（待绘制）」充产出。计划是「拼」但裁失败 → 降级为仅引用并记 `figures/README.md`，不要留空占位。
- `figures/README.md` 一行一张：拼成 / 降级原因 / **待人工确认**。Agent 读 PNG 经常只拿到地址、看不全一批图，不得把「已目检」写进完成标准。人没看过 PNG，拼图就还是待确认。

## 完成标准

计划里每条「拼」要么有可重跑的 `figN.png` + 源清单，要么已降级并写原因。裁错比漏裁有害。人没看过 PNG 不得把拼图标成定稿。

- 写作约定：不使用彩色 emoji；强调标记用「注意：」或单色 ⚠（U+26A0 U+FE0E）。

---

理念参考：Yuan1z0825/nature-skills（Apache-2.0）nature-figure 的「先立论点 / 多面板对齐 / 人眼终检」；K-Dense-AI/scientific-agent-skills（MIT）scientific-visualization 的「不改数据像素、保留原图、不上采样装细节」；figure-forge 的投稿栏宽与 dpi（本技能不重复那张规格表）。内容按 Mesa 综述裁拼流程重写，不生成他人实验图。
