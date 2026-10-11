---
name: origin-plot
description: 用 Origin（OriginLab）驱动出图的规范。当用户在 Windows 上要求用 Origin 处理数据、绘制图表，或流水线出图步骤指定用 Origin 出图时使用。外部 Python 经 originpro 包（COM 自动化）为主路、LabTalk 命令行隐藏批处理为备路；图型选择与期刊规格决策归 figure-forge 技能，本技能只管 Origin 驱动机制与产物落盘。两者同挂时由本技能驱动出图，figure-forge 只定规格，不再跑 matplotlib；`figures/` 冲突警告是分工提醒，不是停工条件。仅适用 Windows + 已安装 Origin 2021 及以上。
outputs: [analysis/, figures/]
provides: [origin-plot]
---

# Origin 驱动出图（origin-plot）

本技能规定「项目数据 → Origin → 图表产物」的驱动机制：agent 在终端里用脚本驱动 Origin 完成出图，全程无人值守、可复现。图型选择、论点契约、期刊规格（尺寸/分辨率/字体）**不在本技能射程**，一律按 figure-forge 技能定好后再用本技能落地。两者同挂时由本技能驱动出图，figure-forge 只定规格，不再跑 matplotlib；`figures/` 冲突警告是分工提醒，不是停工条件。

## 何时使用

- 用户明确要求用 Origin 出图或处理数据（常见于需要 Origin 专精分析/拟合，或投稿要求 Origin 工程文件的场景）
- 流水线「结果分析/探索性分析」步骤的出图环节，用户已把本技能挂为推荐技能
- 用户没有要求 Origin 时不要主动选用：Python/matplotlib 路线（figure-forge + data-eda）是默认主路

## 前置检测（开工先做，不过则停）

- 平台必须是 Windows 且本机安装 Origin 2021+：按 `C:\Program Files\OriginLab\Origin *\Origin*_64.exe`  glob 找到可执行文件（exe 名随版本变），找不到即停止
- 主路检测按顺序尝试 `py -3`、`python`、Origin 自带 Python 执行 `import originpro`；都找不到时才转备路。缺包时只报告安装指引，不未经确认修改 Python 环境
- 检测不过时在报告中写明缺什么、怎么补，然后停止；**不得静默改用 matplotlib 充数**（用户指定 Origin 通常因为有 Origin 工程/格式要求，偷换工具等于没做）

## 随包驱动脚手架

`scripts/plot_origin.py --probe` 只检查平台与 originpro 模块，不验证许可证、不启动 Origin。
复制到项目 analysis/ 后按 figure-forge 规格和已批准列定义修改；显式 `--execute --input data.csv --output <新目录>` 才执行。
脚本交付图、工程、数值输入、版本/哈希清单；默认散点仅脚手架，不保证符合期刊规格。失败非零退出，finally 关闭本次实例。
把 manifest 登记为 figures/origin-manifest.json；大工程留在 TASK.md 指定产物目录。必须 Windows 实机重开/复算/看图后才能宣称已验收。

## 操作规范

### 1. 主路：外部 Python + originpro（COM 自动化）

- 骨架（示意，函数签名以实机 `help(originpro.xxx)` 与官方 API 文档为准，动手前先核对实机版本）：

  ```python
  import originpro as op        # 首次调用即拉起 Origin 实例（COM）
  try:
      op.set_show(False)
      wks = op.new_sheet('w')
      wks.from_file(DATA_CSV)
      gp = op.new_graph(template='scatter')
      gp[0].add_plot(wks, coly=1, colx=0)
      gp.save_fig(str(OUT_PNG))
  finally:
      op.exit()                  # 无论中途如何失败都退出，避免隐藏残留实例
  ```

- 需要 Origin 专精能力（拟合/分析 X-Function）时，Python 里用 `op.lt_exec('LabTalk 命令')` 直送 LabTalk
- 出图风格参数（字号/配色/线宽/尺寸）按 figure-forge 已定的规格集中定义为脚本顶部常量，全图共享

### 2. 备路：LabTalk 命令行隐藏批处理

- 无 Python 环境时用：写 `<脚本>.ogs`（含 `[main]` 段，段尾必须 `exit`），命令行拉起；exe 使用前置 glob 找到的实际路径，不写死版本目录：

  ```
  "<前置 glob 找到的 Origin*_64.exe>" -hs -rs run.section("C:\abs\plot.ogs", main)
  ```

- `-hs` 连脚本窗也不弹（官方注明供计划任务可靠运行）；脚本内用 `impASC` 导数据、`expGraph` 导出图（X-Function 参数以实机 `expGraph -d` 对话框口径为准）
- 脚本报错不弹窗不挂起：出口处把结果/错误写进日志文件，agent 读日志判定成败

### 3. 数据与产物口径

- 原始数据**只读**：从项目数据文件/产物目录导入 worksheet，不改源文件一个字节
- 脚本放 `analysis/`：一图一函数、`main()` 入口、路径集中为模块顶部常量，从 `main` 重跑产出相同图片（沿用 data-eda 约定）
- 图表写入 `figures/`，文件名与报告/TASK.md 引用一一对应；位图 ≥ 300 dpi，矢量（EMF/PDF）按 figure-forge 规格
- 在科研模板选择 Origin 后工程是必需交付，按 TASK.md 写到工作区产物目录 `origin/project.opju`；独立调用未要求工程时才可选，不把大工程默认放入 Git
- 产物完成后按项目惯例登记提货单 artifacts.yaml（路径 + 生成命令）

### 4. 失败口径

- COM 实例起不来、版本不符、授权未激活：报错写明原因并停止，不绕路、不降级冒充
- 单张图导出失败不静默跳过：记录失败图名与原因，其余继续，收尾统一汇报
- 大批量出图（>20 张）先把「共 N 张、预计耗时」写进 .ccode/help-wanted.md 报数（附兜底：未回复按全量跑），不停工

## 产出格式

- `analysis/<出图脚本>`：可复现，`main()` 入口，顶部常量集中路径与风格参数
- `figures/`：全部图表产物，命名与引用一一对应；模板要求的产物目录 `origin/project.opju` 工程留档
- 报告内逐图一行：产物文件名 + 驱动方式（originpro / LabTalk）+ 状态；「待人工确认」的视觉项如实标注（agent 读图不可靠，目检归人）

## 完成标准

前置检测通过记录存在；`analysis/` 脚本从 `main` 重跑产出与 `figures/` 一致的图；Origin 实例全部正常退出无残留；失败项逐条有原因；产物已登记提货单。

- 写作约定：不使用彩色 emoji；强调标记用「注意：」或单色 ⚠（U+26A0 U+FE0E）。

---

接口依据：OriginLab 官方文档——COM Automation（originlab.com/doc/COM）、Python 双通道与 originpro 包（originlab.com/doc/en/Python）、命令行开关表（docs.originlab.com/origin-help/startup-adjustbycomline/，-h/-hs/-rs）、无头批处理 FAQ-656。内容为按 Ccode 科研工作流编写。
