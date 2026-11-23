---
name: blender-research
description: 用户明确需要科研结构、装置或机制三维示意、或正式期刊投稿需零生成式 AI 像素三维主视觉底图时使用 Blender。内置顶刊插画着色管线（4 阶平涂漫反射 + 按栏宽换算的 Freestyle 轮廓描边）、高频科研构件库与自动像素锚点导出（.png.json 直接对接 schematic-forge）。不替代统计图，不生成伪实验图，不对重要个人工程操作。
outputs: [analysis/build_scene.py, figures/blender-manifest.json]
provides: [blender-research]
---

# 科研 Blender 示意（零 AI 像素 3D + 顶刊插画管线）

> 命令里的 `python3` 指本机 Python 3：**Windows 上改用 `python`**（Windows 的 `python3` 是应用商店占位程序，一运行就失败）；macOS / Linux 用 `python3`。

## 科学与授权边界

- 先确认图要说明什么、数据或结构来源、单位、比例、素材许可和哪些部分仅为示意。
- 没有真实尺寸时明确「非按比例」（`units: "NONE"`），没有原子坐标/网格时不可凭视觉合理性虚构分子或仿真结构。
- 不自动拆工；使用当前步骤或用户声明的子任务。复杂结构须专用脚本和领域人员核对。
- **MCP 与无头 CLI 回落策略**：MCP 仅用于用户明确许可的交互调整，官方 MCP 执行模型代码无 OS 沙箱，禁止默认对个人打开的场景执行。**若 Blender MCP（`localhost:9876`）未启动或连接失败，不要反复重试，立即静默回落无头 CLI 执行**，且**始终**带上 `--background --factory-startup --offline-mode --python-exit-code 1`（绝不接管现有 GUI 场景）。

## 顶刊插画着色管线与科研构件库（随包 `scripts/`）

正式期刊投稿（如 Springer Nature / EER / Elsevier 等限制生成式 AI 图像的期刊）需要三维装置/结构/界面主视觉时，优先走本技能的 **`illustration` 顶刊插画管线** 产出零 AI 像素透明底 PNG，再交给 `schematic-forge` 的 `hero_panel` 叠加真矢量文字、圆点引出线与反应箭头：

1. **插画渲染管线（`scripts/scene_illus.py`）**：
   - `style: "illustration"`：4 阶平涂漫反射（EEVEE / EEVEE_NEXT 原生 `ShaderToRGB` + `CONSTANT` 阶梯色，无 GPU 环境自动回退哑光 Cycles）+ 按印刷栏宽 `fig_width_mm` 自动换算像素宽的 Freestyle 随色轮廓描边（缩印到 183 / 89 mm 栏宽仍保持 0.6–0.8 pt 清晰线稿）+ 透明底 + 标准色彩管理（不洗灰）。
   - **成片自检**：渲染完自动用 Pillow 查空图（有效主体 < 0.2%）与四边裁切风险（`edge_clipped`），结果记入 `blender-manifest.json`。
2. **高频科研构件库（`scripts/apparatus_kit.py`）**：
   - 内置 7 类纯 `bmesh` 参数化构件，全部自动返回命名 3D 锚点：
     - `three_electrode_cell`（三电极电解池：`we_tip`、`ce_tip`、`re_tip`、`electrolyte_surface`、`bubbles`）
     - `flow_cell`（流动池 / AEMWE 膜电极展开堆叠：`anode_plate`、`membrane`、`catalyst_layer`、`cathode_plate`、`inlet`、`outlet`）
     - `vacuum_chamber`（CF 法兰原位表征腔体：`chamber_core`、`cf_flange_top`、`optical_window`、`uhv_transfer`、`sample_stage`）
     - `sample_vial`（电解液取样瓶 / ICP 进样瓶：`vial_body`、`liquid`、`cap`，配合电化学/ICP 溶出检测物理指代）
     - `layered_stack`（多层异质结/核壳阶梯剖面，自定义 `options.layers`，自动输出各层与界面锚点）
     - `electrode_interface`（固-液催化界面 + 表面活性位 + 吸附物种：`substrate`、`active_site`、`adsorbate`、`electrolyte`）
     - `crystal_lattice`（三维周期球棍晶格，支持 `nx`/`ny`/`nz`、`vacancies`、`dopants`）
3. **自动像素锚点交接（无缝对接 `schematic-forge`）**：
   - 渲染完成后，脚本调用 `world_to_camera_view` 自动把所有构件锚点与自定义 `anchors` 投影为左上角原点 `[0..1]` 归一化坐标，写出同目录 `<图名>.png.json`（格式 `{"anchors": {"site": [nx, ny], ...}}`）。
   - 在 `schematic-forge` 的 `figure.json` 中把 `hero_panel.src` 指向该 PNG（且同目录带着 `<图名>.png.json`）后，**无需手读坐标网格**，连线和 `callout` 可直接写 `"p-hero@we_tip"` 精准锁点。
4. **多图复用批量资产清单（`assets` 数组）**：
   - 当一篇论文有多张示意图共用一批 3D 部件时，在参数 JSON 里用顶层 `"assets": [{"name": "cell", "objects": [...], "anchors": {...}, "camera": {...}}, ...]` 一次批量产出多张透明底 `<name>.png`、配对 `<name>.png.json` 与 `<name>.blend`，统一登记到同一份 `blender-manifest.json`。

## Blender 4.x / 5.x 避坑规范（手写自定义脚本时必守）

- 剖切/挖槽**禁止**叠加 `SOLIDIFY` + `BOOLEAN`（Blender 5.x 布尔静默失效且易产生非流形破面），一律改用纯 `bmesh` 删面、半圆柱/阶梯层构造。
- 调用 `bpy.ops.object.modifier_apply` 前必须先绑定 `bpy.context.view_layer.objects.active = obj` 并选中该对象（直接复用 `apparatus_kit.apply_modifier_safe(obj, mod_name)`）。
- 环境光**禁止**使用 `ShaderNodeTexWave` 等条纹程序纹理（会在金属和玻璃表面产生斑马纹反射伪影），统一用纯浅灰均匀背景光 + 三点柔和面光/日光。
- 相机优先使用 `scene_illus.frame_camera(..., ortho=True, margin=0.16)` 按包围盒自动留白构图，杜绝主体裁边。

## 可重建交付

- 简单示意或多部件批量资产可从随包 `scripts/build_scene.py`（搭配 `scene_illus.py`、`apparatus_kit.py`）开始，复制至项目 `analysis/` 并按已批准参数调整。
- 参数 JSON 必含 `kind="schematic"`、`units`（`METRIC`/`IMPERIAL`/`NONE`）、`provenance`、`limitations`，以及单场景 `objects` 或批量 `assets`。
- 先 `python3 analysis/build_scene.py --params scene.json --validate`，这仅验证参数结构，不表示科研内容正确。
- 确认后用 `--params scene.json --blender <绝对路径> --output <新的工作区产物目录>` 后台运行；不覆盖旧运行目录。
- 交付脚本、冻结参数、`.blend`、`.png`、`.png.json`（锚点）、`render.log` 和 `blender-manifest.json`（来源、单位、版本、哈希、边缘裁切自检与待人工项）。
- 工程和大二进制放 `TASK.md` 产物目录，小成图、锚点文件与 `blender-manifest.json` 放 `figures/` 并登记提货单。
- 人工核对结构/标尺/图注/素材来源，确认「示意」标签及与稿件论断一致，再记科研验收。

复跑验证参数和关键几何关系；不同渲染器/硬件不承诺逐像素一致。未跑成功或未审图如实记未验证。
