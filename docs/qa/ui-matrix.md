# Mesa 跨平台 UI 验收矩阵

本矩阵是可执行验收清单，不把 macOS 的本地结果冒充 Windows/Linux 结果。每个平台的真实桌面验收必须在对应 Tauri dev 窗口完成，并记录截图或录屏路径。
按批次的具体点验项另列（当前：`docs/qa/acceptance-2026-10.md`），本文件只放跨批次长期要点的面。

## 锚点

- 开发窗口：`npm run tauri:dev`，标题 `Mesa Dev - 热更新`，端口 17575。
- Windows/Linux 多实例必须使用仓库约定的端口配置，验收记录同时写仓库路径、窗口标题、devUrl。
- 失败项记录：平台、页面、操作、期望、实际、诊断包路径。

## 矩阵

| 平台 | 页面/流程 | 操作 | 期望 | 证据 |
|---|---|---|---|---|
| macOS | 配置 | 刷新网关目录、切换模型 | 状态/绑定同步，失败可重试 | 截图 + audit-evidence.json |
| macOS | 项目/工作台 | 打开项目、重试局部分区 | 其他分区仍可用 | 截图 |
| macOS | 终端/对话 | 启动、暂停、恢复 | 原因与恢复记录可见 | 终端日志 |
| macOS | 预览 | PDF/DOCX/XLSX/图片失败后重试 | 统一失败态，不白屏 | 截图 |
| Windows | 配置/终端 | 同上，含 cmd/PowerShell | 不闪窗、状态一致 | 截图 + 诊断包 |
| Windows | 项目/预览 | 同上 | WebView2 下可重试、无白块 | 截图 + 诊断包 |
| Linux | 配置/终端 | 同上 | GTK/WebKit 下状态一致 | 截图 |
| Linux | 项目/预览 | 同上 | 统一失败态与路径提示 | 截图 |

## 记录格式

```text
platform:
repo:
window:
devUrl:
case:
result: pass | fail | blocked
evidence:
notes:
```

单元测试和 `npm run build` 只能证明逻辑/编译通过，不能替代三平台桌面验收。
