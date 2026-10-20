---
name: blender-research
description: 用户明确需要科研结构、装置或机制三维示意时使用 Blender。把已确认尺寸、源数据和科学范围变成可重建场景、图和来源清单；不替代统计图，不生成伪实验图，不对重要个人工程操作。
outputs: [analysis/build_scene.py, figures/blender-manifest.json]
provides: [blender-research]
---

# 科研 Blender 示意

> 命令里的 `python3` 指本机 Python 3：**Windows 上改用 `python`**（Windows 的 `python3` 是应用商店占位程序，一运行就失败）；macOS / Linux 用 `python3`。

## 科学与授权边界

先确认图要说明什么、数据或结构来源、单位、比例、素材许可和哪些部分仅为示意。
没有真实尺寸时明确“非按比例”，没有原子坐标/网格时不可凭视觉合理性虚构分子或仿真结构。
不自动拆工；使用当前步骤或用户声明的子任务。复杂结构须专用脚本和领域人员核对。

MCP 仅用于用户明确许可的交互调整。官方 MCP 执行模型代码无 OS 沙箱；仅连接新的受控工程，
先核对 Blender 实例、工程路径与对象，禁止默认对个人打开的场景执行。Git worktree 不等于 OS 沙箱。

## 可重建交付

- 简单示意可从随包 `scripts/build_scene.py` 开始，复制至项目 `analysis/build_scene.py` 并按已批准参数调整。
- 参数 JSON 必含 kind=schematic、units、provenance、limitations，以及每个对象的 shape/location/scale。
- 先 `python3 analysis/build_scene.py --params scene.json --validate`，这仅验证参数，不表示科研内容正确。
- 确认后用 `--params scene.json --blender <绝对路径> --output <新的工作区产物目录>` 后台运行；脚本使用新进程、factory startup、offline mode、Python 异常非零退出，不接管现有 GUI 场景。
- 交付脚本、冻结参数、scene.blend、schematic.png、日志和 blender-manifest.json（来源、单位、版本、哈希、待人工项）。
- 工程和大二进制放 TASK.md 产物目录，小成图与 manifest 放 figures/ 并登记提货单；不覆盖旧运行。
- 人工核对结构/标尺/图注/素材来源，确认“示意”标签及与稿件论断一致，再记科研验收。

复跑验证参数和关键几何关系；不同渲染器/硬件不承诺逐像素一致。未跑成功或未审图如实记未验证。
