# 两端点验清单（2026-10）

代码与单测、端到端都过了，但下面这些**界面和真机行为**还没人点过。按 `AGENTS.md` 的口径：只在 `npm run tauri:dev` 的 **Mesa Dev - 热更新** 窗口里验，旧打包版不算数。每条写明在哪个平台点、怎么点、应该看到什么；点完在行尾记「✓ / ✗ + 一句现象」，✗ 的附 **设置 → 诊断** 导出的诊断包。

记录格式同 `docs/qa/ui-matrix.md`（平台 / 仓库路径 / 窗口标题 / devUrl / 结果 / 证据）。

## 一、本批改动（2026-10-20「两端完善批」，architecture §10 同名条）

### Windows

| # | 在哪、怎么点 | 应该看到 |
|---|---|---|
| W1 | 设置 → 终端 → **内置终端 shell**，依次选 Windows PowerShell、PowerShell 7、Git Bash、命令提示符，每次到运行页 **＋** 新开一个终端标签 | 下拉只列这台电脑装了的；新标签用选中的 shell 起来；鼠标停在行标题上能看到各 shell 的路径 |
| W2 | 每种 shell 里 `cd` 到另一个项目文件夹（含中文、空格），等 4 秒 | 右侧文件树与 Git 面板跟到新目录；关掉标签后 `%APPDATA%\ccode\pty-cwd\` 里对应的小文件被删 |
| W3 | 在 Git Bash / cmd 标签里，把这个标签所在的工作副本归档 | 标签自动 `cd` 回主仓（cmd 下跨盘也能回去），没有「语法不正确」 |
| W4 | 先 `cargo build --bin mesa_helper`，再开 Claude Code 对话，让它读一个文件、跑一条命令 | 聊天层「等你决定」卡与「已工作」摘要正常；没有每步一秒的停顿（与 Mac 手感接近） |
| W5 | 设置里打开 Gemini 的精确注意力，重启 Mesa，开 Gemini 对话让它跑一条命令 | 终端里不再一直挂「Executing Hook: powershell …」；`~/.gemini/settings.json` 里 Mesa 的条目变成 `…/hooks-state/ccode-hook.exe hook …`，`%APPDATA%\ccode\backups` 多一份改前备份 |
| W6 | 聊天层分别和 Claude Code、Grok 聊一段、让它跑命令 | 实时预览第一行不丢（Claude）、Grok 的审批卡按钮与终端里的选项一致 |
| W7 | Windows 11：鼠标停在顶栏最右的最大化按钮上约半秒 | 弹出系统的分屏布局菜单；鼠标移开或直接点按钮不弹；Mesa 不在前台时不弹 |
| W8 | 连接页 Cursor 卡片点 **安装**（没装过的电脑） | 确认框里是 `powershell … irm 'https://cursor.com/install?win32=true' \| iex`；装完卡片显示版本；新开 Cursor 标签能起来（登录要 Cursor 账号） |
| W9 | 连接页 / 对话页看 Codex 客户端、Claude 桌面版 | 版本号显示出来；点「在 … 打开」按 design-client-handoff §11 清单走一遍 |
| W10 | 聊天里让 AI 提到一个 Mac 上 `say -o` 存的 .aiff | 播放条能放 |
| W11 | LaTeX 论文模板开一步，看任务书 | 有「本步骤脚本（Windows）」一节，PowerShell 与 Git Bash 两种写法；让 Codex 照 PowerShell 写法跑 render-pdf 能出 PDF |
| W12 | 项目的定时任务选 Codex 作执行者（本机 `~/.codex/config.toml` 没有 `[windows] sandbox` 时；你本机配了 elevated，测时要临时注释掉那两行） | 弹层写「Codex 在 Windows 上没开沙箱…」与 **了解并开启**；点开是说明全文，取消不生效，确认后变成「已按你的确认开…」带 **关闭**；设置 → AI 与 Agent 的开关同步；立即运行一次雷达，Codex 的检索命令能跑、文件写进隔离副本 |
| W14 | 发版并配好镜像（docs/release.md 开通步骤）后：手动跑一次 `mirror release`，再在连不上 GitHub 的电脑上 **帮助 → 检查更新** | 摘要里的镜像地址都能打开；检查更新查到新版本、能下载安装 |
| W13 | 安装包（发版后）：在一台没装过 Mesa 的 Windows 上双击 `setup.exe` | 出现 SmartScreen 时按说明书「更多信息 → 仍要运行」能装上 |

### macOS

| # | 在哪、怎么点 | 应该看到 |
|---|---|---|
| M1 | **当前分支合并前**：照 `scripts/e2e-model-routing/README.md`「聊天层结构化旁路」在 Mac 上跑 `e2e_channel`，五家各一遍 | 与 10-20 的 Mac 结论一致（Windows 适配声称对 Mac 恒等，要在 Mac 上实跑确认） |
| M2 | Mac 上和 Claude Code 聊一段（聊天层），让它跑命令、答审批 | 审批答完卡片马上收起；实时预览里没有折下来的英文提示行；正文第一行在（`⏺` 照认） |
| M3 | 设置 → 终端 → 内置终端 shell 选 bash、fish（装了的话） | 新标签用选中的 shell；`cd` 后文件树跟随（原本就有，回归） |
| M4 | 一台**没有 Homebrew** 的 Mac（或临时把 `/opt/homebrew/bin/brew` 改名）：设置 → 诊断 → 依赖体检，依次一键装 Node.js、Quarto、TeX、PyMuPDF | 「安装渠道」写「无 Homebrew：…其余用官网安装包」；Node / Quarto / Python 下载后弹 macOS 密码框，装完「重新检测」打勾；TeX 装 TinyTeX（不要密码）；连接页缺 Node 时的「一键安装 Node.js」也能用 |
| M5 | 从终端 `npm run tauri:dev` 起 Mesa，开一个无头 OpenCode（会话摘要或定时任务） | 文件写在它的工作目录，不写进仓库 `src-tauri/src`（PWD 修复） |
| M6 | 发版后：Intel Mac 装 `Mesa_x.y.z_x64.dmg` | 能打开（未签名时按 xattr）；设置 → 关于 写 Intel；之后的版本能收到应用内更新 |
| M7 | 开通 Apple 开发者账号、配好六个 secrets 后打一次包 | 按 docs/release.md 第 5 步验收 |

## 二、早先批次留下的界面点验

| # | 来源（architecture §10 / 设计稿） | 平台 | 点什么 |
|---|---|---|---|
| H1 | 2026-10-20 新用户上手引导 | 两端 | 用新用户沙盒实例（17577）走欢迎页 → 侧栏进度行 → 清单浮层 → 连接页引导条 → 「下一步」提示 |
| H2 | 2026-10-18 客户端接力 | 两端 | design-client-handoff.md §11 的 8 条 |
| H3 | 2026-10-19 Windows 全量排查（当时锁屏没点） | Windows | 自绘标题栏与全屏页 / 遮罩的叠放、WebView2 快捷键与右键收口、PowerShell 复制命令、终端开在工作树里拒绝归档、Win10 实心底 |
| H4 | 2026-10-20 聊天层 Windows 适配 | Windows | 五家在 Mesa Dev 里逐家开对话、答一次审批、`/clear` 一次 |
| H5 | 2026-10-19 依赖一键安装（Git / Node 没在干净机器上装过） | 两端 | 见第三节 |
| H6 | 2026-10-20 上下文浮层、智谱预设拆分等当日界面改动 | 两端 | 各自条目末尾写的未验项 |

## 三、干净机器首装

本机已装好 Git / Node / Python / 各家 CLI，拆掉会断开发环境；新用户沙盒（17577）也隔离不了系统里已装的程序。要用**虚拟机**或**另建一个系统用户**（Windows 新用户看不到别的用户装在用户目录里的 CLI；系统级安装的 Git / Node 仍在，要彻底干净只能虚拟机）。

| 平台 | 走一遍 | 看什么 |
|---|---|---|
| Windows 11（虚拟机，Windows 沙盒也行） | 装 Mesa → 上手引导第 1 步装一个 Agent（会先缺 Node.js / Git）→ 依赖体检一键装 Git、Node.js、Quarto、TeX、PyMuPDF | 每一步的 UAC 提示与说明书一致；装完不重启 Mesa 也能认出来 |
| macOS（新用户 + 没有 Homebrew） | 同上，另走 M4 | Git 走系统安装窗口；其余走官网安装包 |

## 四、异常场景（audit-remediation §2 挂着的）

| # | 场景 | 怎么做 | 应该看到 |
|---|---|---|---|
| E1 | 两个实例同时改配置 | 17575 与 17576 两个窗口同时改同一条连接、同时保存 | 后保存的报冲突或排队，不出现半份配置 |
| E2 | 两个实例同时跑定时任务 | 两个窗口里同一项目的雷达同时点「立即运行」 | 同项目互斥（一个排队），不同时写同一个隔离副本 |
| E3 | 强杀后恢复 | 任务管理器 / `kill -9` 结束正在跑 Agent 的 Mesa，再打开 | 没有残留 Codex app-server、端口没被占；标签恢复、Run 状态收口为失败 / 停止 |
| E4 | 磁盘满 | 往一个小容量的 U 盘 / 虚拟盘上建项目，写满后再让 Agent 写文件、保存设置 | 报错写明空间不足，配置文件不被截成半份（原子写） |
