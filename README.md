# Mesa

<p>
  <img src="src-tauri/icons/icon.png" width="96" alt="Mesa icon" />
</p>

<p>
  <a href="https://github.com/Zeta-Techs/mesa/actions/workflows/build.yml"><img src="https://github.com/Zeta-Techs/mesa/actions/workflows/build.yml/badge.svg" alt="Build" /></a>
  <a href="https://github.com/Zeta-Techs/mesa/releases/latest"><img src="https://img.shields.io/github/v/release/Zeta-Techs/mesa?label=release" alt="Release" /></a>
  <img src="https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Windows-blue" alt="Platforms" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache_2.0-green" alt="License: Apache-2.0" /></a>
</p>

**AI 科研工作台**（桌面应用，Tauri v2 + React/TS + Rust）。底层是九个终端 Agent 的统一控制台（启动器 + 配置中心 + 会话监控台），表面是科研、编程、工作三条流水线：读文献 → 整数据 → 做图 → 写论文。**AI 负责干活，Mesa 负责管环境和验收，人负责拍板。**

为 Claude Code、Codex、Gemini CLI、Qwen Code、OpenCode、Kimi Code、CodeBuddy Code、Cursor CLI、Grok Build 管理多套 API 配置（端点 / 密钥 / 模型）与官方账号登录，内嵌终端一键拉起，并解析各 CLI 本地会话文件做可视化浏览。

产品对象按 **Project → Task → Run** 管理：Task 是人声明的工作单元，Run 是一次执行，终端标签只是 Run 的视图。需要写盘的任务默认在隔离工作树中运行，完成后由人查看改动并决定是否写回项目。

展示名 **Mesa**；内部身份仍是 `ccode`（bundle ID `com.ccode.dev`、项目 `.ccode/`、本机 `~/ccode/`、Codex provider `ccode`）。数据和配置位置不随展示名改动。

## 界面

侧栏从上到下 **工作入口 → 项目 → 资源与管理**，启动默认进入工作台。对话挂在侧栏里各自的项目下面（随手聊、置顶各一节），点一下就进运行页接着聊；行尾的小光标报状态（灰色一明一暗 = 在干活，琥珀 = 等你确认）：

| 组 | 页面 | 做什么 |
|---|---|---|
| 工作 | **工作台** | 等你拍板（所有项目等你决定的事，行内处理、键盘、撤销）、每个项目一张卡（步骤 / 分支 / 目标 / 定时）、点任务看右侧任务面板；关标签后按运行身份找回 |
| 工作 | **新对话** | 按钮（不是页面，`⌘N`）：不建项目直接开一段空白对话 |
| 工作 | **运行** | 一次摆一段对话，聊天 / 终端是同一会话两种看法：输入框里直接切模型、思考档和权限四档；文件树、改动面板、沉浸阅读。侧栏里没有这一行：点侧栏里的对话就进来；侧栏收成图标或隐藏时，悬停或 `⌘0` 把项目树探出来，隐藏时顶部岛上也能切对话 |
| 工作 | **对话管理** | 打开对话页：九家 CLI 本地会话的搜索、结构化回放、自动起名、归档 / 导出 / 接力；可交给 Codex 客户端、Claude 桌面版接着做 |
| 项目 | **项目** | 科研 / 编程 / 工作。四个页签：任务、定时任务、文件、Agents（任务页分别叫科研任务、编程任务、工作任务）；项目的对话在侧栏它下面 |
| 资源与管理 | **连接** | 网关 × 绑定；默认启动注入环境变量（零污染），可选「写入 CLI 全局默认」 |
| 资源与管理 | **技能** | Skills 统一库，分发到各 CLI；内置 20 个科研技能 + 出图技能 |
| 资源与管理 | **MCP** | 统一清单，一键分发到各 CLI（Grok 只读） |
| 资源与管理 | **用量** | token 与费用（官方账号显示「订阅」），按项目 / 模型 / 任务归因；活跃度热力图可点格下钻 |
| 资源与管理 | **设置** | 十四套主题 + 自定义、应用图标（深浅随系统）、字体 / 调色板、通知、更新、数据与存储、诊断、关于（版本 / 开源许可） |

快捷键：`⌘K` / `Ctrl+K` 命令面板，`⌘N` / `Ctrl+N` 新对话，`⌘0` / `Ctrl+0` 把光标放进侧栏选对话，`⌘⇧T` / `Ctrl+Shift+T` 在聊天和终端之间来回切，`⌘1`–`⌘8` / `Ctrl+1`–`Ctrl+8` 切页（顺序同上表，新对话和运行不占编号），都能在设置里改。

## 功能

- **连接**：Agent × 网关 × 绑定；API 配置与官方账号双轨；密钥 0600 本地存储、绝不回显；CLI 安装 / 更新一键完成
- **项目**：科研六套研究流程模板（综述 / 论文 / 数据 / 毕业论文 / 投稿返修 / LaTeX）+ 一键开步；不使用研究流程的科研项目，以及「工作」项目，用「新建目标」（隔离副本，人验收后写回）；编程用独立工作树，合进基准或开 PR
- **运行**：默认聊天层，像常见的 AI 客户端——模型 · 思考单菜单、权限四档（先出方案 / 请求批准 / 帮我批准 / 完全访问，按各家 CLI 的原生参数；先出方案在多数家是计划模式，方案看过点头就开工）、对话末尾的确认卡；底下仍是真实终端，两者是同一会话。聊天层优先取各 CLI 自带的结构化事件（hook、Codex app-server 等），不改你的 CLI 配置，取不到就回落读会话文件。xterm.js 终端；空闲 30 分钟没在看的对话自动停、点开发一句就接回；Agent 退出回落 shell、会话可恢复；Monaco 预览 / 编辑（⌘S、改动撞车时左右对比合并、GBK 等编码照原样保存）；PDF / docx / pptx / 表格 / 图片 / Jupyter 笔记本 / 音视频内嵌预览，跟着磁盘变化自动刷新，装了 LibreOffice 可看 Office 原样；选段「◈ 问 AI」；⛶ 沉浸阅读（笔记｜PDF｜终端，高亮批注记进笔记）
- **对话**：解析九个 CLI 本地会话（含外部终端里跑的）；按项目 / 步骤整理；pin 快照、标签、归档、批量删除、◈ 摘要、Markdown 导出、会话包换机导入；Claude Code 对话被截图撑爆请求体（413）时一键「瘦身」并续聊；Mesa 自己的后台对话按保留期自动清理
- **客户端接力**：对话 / 项目一键交给 Codex 客户端、Claude 桌面版接着做。打开前先预检（客户端装没装、渠道客户端认不认、对话文件还在不在、是否仍在 Mesa 终端里运行），缺 Codex 渠道定义时当场「写入并打开」。目前只有这两家有可接的客户端，其余七家不显示入口
- **技能 / MCP**：技能四路导入（目录 / ZIP / GitHub / 收编）与 ZIP 导出；MCP 预设含 Consensus、Undermind、Blender
- **科研配套**：文献雷达（定时巡检新文献）、积累清单、期刊指标徽章、引用检查、复现运行记录（与 Git 合并分开）
- **工作台体验**：第一次打开有「上手引导」（装 Agent → 建网关 → 加连接 → 开对话 → 建项目，按电脑实际情况自动打勾，帮助菜单可再打开）；收件箱聚合待确认 / 冲突 / 依赖 / 文献新命中等十一类；「新对话」随手聊（不建项目直接聊）；`⌘K` 命令面板；长任务 OS 通知；应用内自动更新

## 安装

从 [Releases](../../releases) 下载，按你的平台选择：

| 平台 | 选哪个 | 说明 |
|---|---|---|
| macOS（Apple 芯片 M1/M2/M3/M4） | `Mesa_x.x.x_aarch64.dmg` | |
| macOS（Intel 芯片） | `Mesa_x.x.x_x64.dmg` | |
| Windows | `Mesa_x.x.x_x64-setup.exe` | 批量部署用静默安装 `setup.exe /S` |

暂不提供 Linux 安装包。

其余 `.sig`、`latest.json`、`.app.tar.gz` 是应用内自动更新用的签名文件，**不用手动下载**。

不确定自己的芯片？macOS：屏幕左上角苹果菜单 → 关于本机，看「芯片」一栏；Windows：设置 → 系统 → 关于，看「系统类型」（基本都是 x64）。

> **macOS 注意**：应用暂未做 Apple 签名公证，首次打开如提示「已损坏」，终端执行：
> ```bash
> xattr -cr /Applications/Mesa.app
> ```

> **Windows 注意**：安装包暂未做代码签名，双击 `setup.exe` 时可能弹出蓝色的「Windows 已保护你的电脑」（SmartScreen）。
> 点 **更多信息**，再点 **仍要运行** 即可继续安装。以后应用内更新不会再弹这个提示。

之后的版本更新：打开应用后若有新版本，顶栏「待处理」会出现提醒，也可在「设置 → 更新」查看说明并一键下载安装（完成后自动重启）。

## 文档

- [docs/guide/tutorial.md](docs/guide/tutorial.md) — 使用教程（第一次上手；英文综述按步骤走完）
- [docs/guide/user-guide.md](docs/guide/user-guide.md) — 产品说明书（查某个按钮、某种状态、某个页面；需要后补的图和视频已标位）
- [CHANGELOG.md](CHANGELOG.md) — 版本更新日志
- [docs/architecture.md](docs/architecture.md) — 架构设计与决策记录
- [docs/agent-integration-matrix.md](docs/agent-integration-matrix.md) — 九个 CLI 的 env / 配置 / 会话格式调研，以及各家桌面客户端的深链与会话存储调研（§13）
- [docs/design-client-handoff.md](docs/design-client-handoff.md) — 客户端接力设计稿（能力分档、预检模型、真机点验清单）
- [docs/design-chat-layer.md](docs/design-chat-layer.md) — 聊天层设计稿
- [docs/design-chat-structured-channels.md](docs/design-chat-structured-channels.md) — 聊天层结构化旁路设计与实测
- [AGENTS.md](AGENTS.md) — 开发约定与踩坑记录

## 开发

```bash
export PATH="$HOME/.cargo/bin:$PATH"   # Rust 不在默认 PATH 时

npm install
npm run tauri:dev      # 开发（独立窗口「Mesa Dev - 热更新」；前端 HMR + Rust 自动重启）
npm run build          # 前端构建（tsc + vite）
npm test               # 前端测试
cd src-tauri && cargo test
npm run tauri build    # 打包
```

想以「第一次打开」的状态体验或测试（空家目录、独立 bundle ID、端口 17577）：`scripts/dev-sandbox.sh`（`--reset` 清空重来）。

开发预览必须用 `npm run tauri:dev`（窗口标题 **Mesa Dev - 热更新**，bundle ID `com.ccode.dev.hmr`）。不要用 `/Applications/Mesa.app` 或旧打包前端做界面验收。

推到 main 会跑 macOS 与 Windows 的测试。tag `v*` 或手动 dispatch 打 macOS（Apple 芯片、Intel）与 Windows 的安装包，并创建 Release 草稿（含自动更新签名包）。应用内看到的「更新说明」取自 `CHANGELOG.md` 对应版本段（缺则 CI 失败），发版前先写好。仓库配齐六个 `APPLE_*` secrets 后，macOS 包自动签名公证；配好更新镜像的变量与 secrets 后，Release 一发布就同步到国内镜像、之后打的包先从镜像检查更新（两者都见 [docs/release.md](docs/release.md)）。

## 反馈与参与

遇到问题或有想法，用应用内的「**? 帮助 → 反馈与提需求**」表单直接提交（不需要 GitHub 账号），或到 [Issues](../../issues) 提出。缺陷请附应用内「设置 → 诊断」导出的日志。不要在反馈或 Issue 里贴 API 密钥或 token。

想改代码先看 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题的报告方式见 [SECURITY.md](SECURITY.md)。

## 现在不做

- macOS 安装包还没有 Apple 签名公证（发版流程已接好，等 Apple 开发者账号）。首次打开若提示「已损坏」，按上面的 `xattr` 命令处理。
- Windows 安装包还没有代码签名，首次安装会被 SmartScreen 拦一下，按上面的说明继续。
- 暂不提供 Linux 安装包。
- 不是系统综述工具，也不做 Meta 分析。
- 客户端接力目前只覆盖 Codex 客户端与 Claude 桌面版；其余七家要么没有读同一份会话存储的客户端，要么只能打开项目，暂不显示入口。
- 不在 PDF 文件本身上写批注（沉浸阅读的高亮批注记进笔记）；不做多人协作、SSH 远程执行、云端会话同步。

## 许可与商标

本项目按 [Apache-2.0](LICENSE) 发布，附带 [NOTICE](NOTICE)。Apache-2.0 不授予商标权：**"Mesa" 名称与图标归项目维护方，不随代码许可授权**。介绍、评测、原样转发可以直接用；对外发布修改版要换名换图标，细则见 [TRADEMARKS.md](TRADEMARKS.md)。Mesa 不是 Claude Code、Codex 等任何 CLI 的官方产品，各家名称与商标归其所有者；本项目与 [Mesa 3D 图形库](https://mesa3d.org/) 等同名项目无关联。

内嵌的 JetBrains Mono 与 KaTeX 字体按 SIL OFL 1.1 再分发；第三方组件清单见 [docs/licenses/THIRD-PARTY.md](docs/licenses/THIRD-PARTY.md)（随包版本由构建脚本生成，应用内「设置 → 关于 → 开源许可」可查看）。

## 致谢

Mesa 的机制设计参考了三个开源项目（学机制与取舍，未复制代码）：

- [cc-switch](https://github.com/farion1231/cc-switch)（MIT）— provider 预设、配置同步与订阅余量口径
- [waveterm](https://github.com/wavetermdev/waveterm)（Apache-2.0）— block/workspace 对象模型与注意力标记思路
- [VS Code](https://github.com/microsoft/vscode)（MIT）— 文件树、编辑器标签与面板布局

等宽字体 [JetBrains Mono](https://www.jetbrains.com/lp/mono/)（OFL 1.1）；平台标识图标来自 [lobe-icons](https://github.com/lobehub/lobe-icons)（MIT，经 cc-switch 引入），用于标明套餐 / 网关所属平台；许可全文见 [THIRD-PARTY.md](docs/licenses/THIRD-PARTY.md)。

## 技术栈

Tauri v2 · React 19 · TypeScript · Tailwind CSS v4 · zustand · xterm.js · Monaco Editor · Rust（rusqlite / portable-pty / notify）
