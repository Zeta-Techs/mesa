# 本机环境档案（踩坑记录）

> 2026-09-22 自 AGENTS.md「本机环境档案」迁入（原文未改）。
> **涉网络下载、跨平台行为、构建异常、装依赖、开第二开发实例前必读**。
> git/CI 提交纪律与 dev 端口规则留在 AGENTS.md（每会话都要用）。


- **网络：访问 GitHub/raw/formulae.brew.sh 很慢**。必须用镜像：crates → rsproxy（已配）；rustup → TUNA；brew 元数据 → `HOMEBREW_API_DOMAIN` 指 TUNA（仍有效）；brew bottle → **平铺镜像已死**（TUNA/中科大/腾讯/阿里 2026-09-19 实测 403/404，`HOMEBREW_BOTTLE_DOMAIN` 形同虚设），改 `HOMEBREW_ARTIFACT_DOMAIN=https://ghcr.nju.edu.cn`（南大 ghcr 代理，bottle 实测 6.7MB/s vs ghcr 直连 73KB/s；非 ghcr URL 代理 404 后 brew 自动回落原地址，已在 updater.rs 内置）；npm 如变慢 → `registry.npmmirror.com`。ghcr/GitHub Release 直连仅 ~73KB/s，tap/cask 大包（如 opencode 46MB）直连仍要十几分钟——注意：**CLI 子进程（curl/brew/npm）不读 macOS 系统代理，只认环境变量**，Mesa 下载侧已按设置页「出网代理」注入（`download_proxy_env`），镜像主机进 NO_PROXY 直连；更新超时改「10 分钟无输出闲置判死 + 30 分钟硬上限」（PTY 实测慢下载时 curl 进度条持续出字，不会误杀活下载）。
- **brew 异常先 `brew doctor`**，别先怀疑应用代码。
- **macOS 钥匙串对未签名开发构建会因 cdhash 失配丢条目**——密钥存储弃用钥匙串，改 0600 `keys.json`（勿改回）。
- **管道输出块缓冲**：brew/npm 检测到非 TTY 会块缓冲导致"无输出"假象——安装/更新命令必须在 PTY 里跑（别退回管道）。
- **Homebrew 7 安装默认问 `[y/n]`**（2026-09-30 实证：诊断页装 tectonic 停在 “Do you want to proceed?”）。应用内 brew 一律设 `HOMEBREW_NO_ASK=1`，等价 `--yes`。pip 安装加 `--no-input`。诊断页那一行没有输入框。若环境变量没盖住、日志里仍出现 `[y/n]`，安装读端再自动写一次 `y`，最多 5 次。Git、Node、Quarto、TeX、字体和 CLI 更新走同一条 brew 管线。PyMuPDF 与 Pillow 走 pip。winget 本来就带 `--disable-interactivity`。
- **诊断页一键安装**（2026-09-30）：Quarto 走 `brew install --cask quarto` / winget `Posit.Quarto`。TeX 装 tectonic（`brew install tectonic` / winget `TectonicTypesetting.Tectonic`），已有 xelatex 或 pdflatex 不再装。PyMuPDF 与 Pillow 走 `python3 -m pip install`，碰到 externally-managed-environment 再加 `--user`，不使用 `--break-system-packages`。Linux 只给 apt 或官网指引，不代跑 sudo。
- **GUI 应用 PATH 很短**：打包应用可能找不到 npm 装的 CLI（开发模式不受影响）；统一经 `agents::resolve_binary` 候选目录兜底解析。
- **Windows 正式版没有父控制台**：后台 `git/cmd/netstat/tasklist/CLI --version` 等若直接 `Command::new` 会反复创建
  `conhost.exe` 闪窗；所有不需要独立可见窗口的命令必须走 `process::background_command`，统一加 `CREATE_NO_WINDOW`
  并在 spawn/wait 边界登记脱敏参数与生命周期。该包装和 250ms 进程扫描只在 Windows 生效；macOS/Linux 直接返回标准
  `Command`、不启动诊断监控线程。只有用户明确打开的外部终端允许保留可见窗口。
  Windows 外部终端由设置页二选一：`cmd`（默认）走 `start cmd.exe /K <binary> <args>`，密钥在父进程
  环境块经 start 继承，不经 PowerShell；`powershell` 走 `start powershell.exe -NoExit -File wrapper`。
  复合 start 行必须 `raw_arg` 直投。启动热路径禁止同步跑 icacls。
- **本机 CLI 安装情况**：claude/codex/gemini/qwen/opencode/codebuddy 均已装（brew 或 npm，检测见 updater.rs 报告）；kimi 为新版（~/.kimi-code）。
- **macOS 的 `/usr/bin/git` 是 CLT stub**：没装 Xcode 命令行工具时 which 也能命中它，直接跑会弹系统安装窗、
  还会被版本探测的 5s 超时杀掉——判定必须先用 `xcode-select -p`（background_command）探 CLT 在不在，
  stub 场景禁跑 `git --version`（dep_check.rs 的 clt_stub 三态就是这么来的，别退回直接探测）。
- **Xcode 许可未同意会让热更新窗口消失**：`xcode-select -p` 指向 `/Applications/Xcode.app` 时，未 `sudo xcodebuild -license` 则 `xcrun --sdk macosx --show-sdk-path` 失败、Rust 链接退出 69，`tauri:dev` 只剩 Vite 占 17575、Mesa Dev 窗口没了。本机已装 CLT 时开发编译改 `DEVELOPER_DIR=/Library/Developer/CommandLineTools`，不要改端口、不要另起配置外实例。用户同意 Xcode 许可后可去掉该变量。
- **Windows npm 系 CLI 是 .cmd 批处理 shim**：CreateProcess/ConPTY 直接起报 os error 193；同目录还有同名无扩展名
  shell 脚本，`find_in_dirs` 必须 exe/cmd 优先于裸名（裸名只兜底）。且 ConPTY 里 npm 会发 DSR 光标位置查询
  （ESC[6n）并读 stdin 等回答，无人应答永久挂起——`run_streaming_pty` 的 reader 代答 ESC[24;120R。
  shim 深化（解析 JS 入口改 node 直启）统一在 `process.rs`：`pty_command`（PTY）与 `background_command`（后台）
  双入口同一口径，npm.cmd 自身走固定布局 special case。
- **Windows 硬化规则（2026-10-19 全量排查定稿）**：
  - 路径：`fs::canonicalize` 在 Windows 产出 `\\?\` 前缀，存库 / 回给前端 / 写进给 Agent 的指令前一律走
    `paths::canonicalize_plain`；跨来源比较一律 `paths::same_path` / `path_within`；前端相对化用 `path-utils.relativeUnder`。
  - 删工作区：Windows 不能删除正被进程当作 cwd 的目录（`git worktree remove --force` 会删一半），有任何终端
    （含普通 shell）开在工作树里先拒绝并点名，不强删（`pty::ensure_workspace_free`）。
  - 原子写：`storage::replace` 只对 os error 5/32/33（杀毒、索引、OneDrive 短暂占用）有限重试；git 调用一律带
    `core.longpaths=true`（`git_info::PLATFORM_GIT_CONFIG`）。
  - 命令输出：禁止按本地化文案判断成败（中文 Windows 是 GBK），用退出码；PowerShell 脚本开头先切 UTF-8；
    `clip.exe` 写 UTF-16LE+BOM；每个 Python 子进程带 `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8`；netstat 按列位置解析且
    同时查 `tcp` 与 `tcpv6`；Windows 上结束进程一律 `kill_process_tree` / `taskkill /T /F`。
  - 写进 CLI 配置的 Windows hooks 不得含内联 PowerShell、`$` 或单引号（会被 bash / PowerShell / cmd 宿主吞掉），
    逻辑放 `.ps1`、命令只带双引号路径；读任何 CLI 配置（JSON / TOML）先 `mcp::strip_bom`；读失败报错，不得当文件不存在。
  - 外部 cmd 拉起用 `/S /K "<整行>"` + 外层 `^` 转义；带 `%` 或换行的参数走 `.cmd` 包装，只有包装里才把 `%` 翻倍。
  - 内嵌终端的 PowerShell 带 `-ExecutionPolicy Bypass`（仅本进程）；复制给用户粘贴的命令写 `.exe` / `.cmd` 绝对路径，
    不写裸名（裸名先命中 npm 的 `.ps1`，被 Restricted 策略拦）；往 shell 写命令以 `\r` 结尾、单引号用 `''` 转义。
  - 界面：自绘标题栏恒在最上，页内全屏层与 z≥40 遮罩在 Windows 从标题栏下沿起铺，要整窗覆盖的层（沉浸阅读）
    加 `ccode-covers-titlebar` 且自带拖拽区与 `WindowControls`；WebView2 的刷新 / 打印 / 查找 / 后退快捷键与默认右键
    由 `windows-shell.ts` 收口；Windows 10 无 Mica 时 `data-material=none` 回实心底。
- **Windows PDF 预览白屏**：WebView2 + 全局 `color-scheme:dark` 下，pdf.js 默认不透明 2d canvas 与
  `.textLayer { color-scheme:only light }` 会合成整页白块；经典滚动条改 clientWidth 再叠加
  `key={renderKey}` 会拆掉 canvas 振荡闪白。渲染前必须先绑 `alpha:true` 上下文，页宿主锁定 light
  color-scheme，适配宽度走 `nextFitScale` + `scrollbar-gutter: stable`，Windows 关掉 ImageDecoder。
  细则见 `docs/conventions/terminal.md`，勿退回 `page.render({ canvas })` 不预绑上下文、勿把
  ResizeObserver 当强制重挂信号。
- **conda 里的 quarto 在 Apple 芯片上跑不起来**（2026-10-17 本机实证）：miniconda base 装的 quarto 1.9.38 只带
  x86_64 的 deno（`bin/tools/aarch64/deno` 缺失），`quarto --version` 退出码 0 却不输出版本，`quarto pandoc`
  直接报错——综述/论文的渲染与字体脚本都会失败，`tests/manuscript-font.test.ts` 也会红。conda base 在 PATH 前面时
  它会盖过官方版。用官方 pkg（`brew install --cask quarto`，要管理员密码）并 `conda remove quarto` 去掉这个壳；
  依赖体检对它报「跑不起来」（`dep_check::quarto_status`），不再只看文件在不在。
  **官方 pkg 的 PATH 链接可能静默缺失**（2026-10-18 实证）：pkg 往 `/usr/local/bin` 建 `quarto` 链接，Apple 芯片
  机器上这个目录常不存在，装完 PATH 上找不到 quarto（本体在 `/Applications/quarto/bin`）。Mesa 解析已把该目录
  列进候选（`agent_specs::binary_candidate_dirs`），但终端里的 Agent 只认 PATH——开工工具检查会报「不在 PATH 上」；
  本机已 `ln -s /Applications/quarto/bin/quarto ~/.local/bin/quarto`。**brew 下 GitHub Release 大包要带代理**：
  本机系统代理在 127.0.0.1:10808，终端里的 brew/curl 不读系统代理，直连 GitHub 18MB 就断（HTTP/2 PROTOCOL_ERROR），
  `https_proxy=http://127.0.0.1:10808 http_proxy=… brew install --cask quarto` 秒下。
  **卸掉 conda 版 quarto 后要从新终端重启 Mesa**：conda 的激活脚本导出过 `QUARTO_SHARE_PATH`、`QUARTO_DENO`
  等十来个变量，卸载后已经在跑的进程（`tauri dev` 和它拉起的 Mesa、Mesa 里开的终端与 Agent）仍带着，官方版
  quarto 认这些变量，`--version` 读不到、渲染也会失败。依赖体检会点名这些残留变量（`dep_check::stale_quarto_env`）。
- **dev 端口为 17575**（`vite.config.ts` + `tauri.conf.json` devUrl 两处同步；勿改回 1420——Codex 桌面版 NetworkService 占用）。vite 撞已占端口静默退出；**stdin EOF 也自杀**——后台拉起必须 `tail -f /dev/null | npm run tauri:dev`。
  **agent 不得自行改端口、加 `--port`/`--strictPort` 参数或另起配置外的 dev 实例**；17575 被占时先报出占用方（Windows 用
  `netstat -ano | findstr :17575`）交用户处理，不静默换端口。
  **双 clone 并行开发的第二实例**：已入库 `src-tauri/tauri.dev.17576.conf.json`（`npm run tauri:dev:17576`，devUrl
  127.0.0.1:17576，窗口标题带「 :17576」后缀；identifier 与主实例相同、共享配置目录）。验收三锚点缺一不可：
  用户指定的**仓库路径**（两个 clone 内容相同，开工先 `git rev-parse --show-toplevel` 自报并与用户指定路径对照）+
  **窗口标题**（17575 实例 = 「Mesa Dev - 热更新」，17576 实例 = 「Mesa Dev - 热更新 :17576」）+ **devUrl 端口**。
  用户指定了哪个实例就只核验哪个，其余窗口不算数；还要第三实例时照此加 conf 文件（端口连续顺延），不即兴改配置。
