---
name: image-gen
description: 用 Mesa 设置里配好的出图模型生成图片（gpt-image、Gemini、Grok、豆包 Seedream、通义万相、CogView 等各家都可）。用户要插图、示意图、封面、配图、海报、图标草图等「按描述画一张图」时使用；数据图表、统计图不用它（交给 figure-forge / data-eda 用脚本画），不生成冒充实验结果的图像。
outputs: [figures/]
---

# 出图（Mesa 出图模型）

Mesa 启动你时在环境变量 `MESA_IMAGE_TOOL` 里放了出图工具的路径。它用用户在 Mesa「设置 → AI 与 Agent → 出图模型」选的网关和模型，密钥由工具自己取——**你看不到也不需要密钥，不要去找、不要打印任何密钥**。

## 先确认能用

- macOS / Linux：`"$MESA_IMAGE_TOOL" image --list`
- Windows PowerShell：`& $env:MESA_IMAGE_TOOL image --list`

输出第一行是默认出图模型，后面是各网关目录里能出图的模型。`MESA_IMAGE_TOOL` 为空：说明不是在 Mesa 里启动的，或这版 Mesa 还没带出图工具——停下告诉用户，不要改用别的方式绕过。第一行说「还没配置出图模型」：请用户到上述设置里选一个，或者用户指定了模型时加 `--model`。

## 出图

```bash
"$MESA_IMAGE_TOOL" image --prompt "英文描述效果通常更稳" --out figures/cover.png
```

Windows PowerShell：`& $env:MESA_IMAGE_TOOL image --prompt "…" --out figures/cover.png`

可选参数：

- `--model <模型名>`：用户点名某家（如 `grok-imagine-image`、`gemini-3-pro-image`、`doubao-seedream-4-0-250828`）时才加；工具会去有这个模型的网关找。
- `--size 1536x1024`：画幅。OpenAI 系按尺寸，Gemini 系换成最接近的宽高比；有的模型会按自己支持的尺寸出。
- `--n 2`：一次几张（1–4），文件名自动加 `-1`、`-2`。
- `--prompt-file 描述.txt`：描述很长或带引号、换行时写进文件再传，避开命令行转义。

一张图常要 20 秒到 3 分钟，耐心等，别重复提交。在带沙箱的 Agent 里（如 Codex 的 workspace-write），命令联网会被拦、报「连不上网关」：按你自己的提权流程申请联网重跑这一条，不要改用别的方式。成功时每张图输出一行 `saved: 绝对路径`——**以这一行为准**：扩展名会按实际格式改（模型回 JPEG 就存成 .jpg），同名文件已存在时自动加 `-2`，不覆盖。

## 放哪、怎么交代

- 研究项目放 `figures/`，编程项目放用户指定的位置（没说就问）；文件名用英文短词。
- 把用到的描述原文记下来（同目录 `<图名>.prompt.txt`），方便重画。
- 交付时说清：用的哪个模型、存在哪、这是 AI 生成的示意图。

## 边界

- 不生成冒充实验观测、显微照片、电泳条带、病理切片、仪器截图等「看起来像真实数据」的图；用户要的话说明风险，只做明确标注为示意的版本。
- 数据驱动的图（曲线、柱状图、统计图）用脚本画，不用出图模型。
- 失败时照实转述工具的报错（网关没开通这个模型、额度不足、内容被拒等），不要换个模型偷偷重试；可以建议用户换哪个模型。
