# 约定：终端与工作台

> 适用范围：TerminalPage、PTY 生命周期、评审/冲突覆盖层、收件箱与注意力标记、改动面板、键盘流、会话关联。从 AGENTS.md 迁入（原文照录，未做语义改动）。

## 审计后的可靠性合同（2026-09-08）

- 输入只在查找句柄时取 PTY 表锁；按请求到达顺序进每终端队列，队列写入/等待不占其它标签的锁，异常显示在终端错误区。正文+提交作为一个队列请求保留 60ms TUI 消化间隔。
- 诊断输出副本不参与终端回显热路径，拥堵可丢诊断副本但不能影响实际终端；数据库输出事件有保留上限，不把它视为完整会话日志。
- “停止运行”与应用退出都回收原生进程；后台任务入口在设置诊断区。新建/恢复的只讨论权限一致，缺能力不能降级成可写。
- 文件树达到 2000 项上限必须提示“部分文件未列出”，保留搜索和子目录导航；编程工作树仍有活跃 Run/PTY 时不得删除。

## 终端行为（用户明确要求；配色 = VS Code Dark+ 调色板，集中在 `TerminalPage.tsx` 的 `theme` 一处）

- **Run 与标签（v3.221 / v3.223 / v3.225）**：终端标签是一次 Run 的视图，不是身份。同一 `reuseKey` 只留一个活标签；标题先任务名（工作区/分支/文档）后 Agent（Agent 只在进程起来后的状态栏）。交互 `pty_spawn` 必先登记 `runs` 行（登录标签除外）；无头标 `internal` 不进工作台。启动入口用 `permission`（`discuss` / `write_tree`），旧 `readonly` 仅回落。重启白名单含 `runId`，仍禁 PTY/密钥/env。关标签后按 `runId` 恢复。会话恢复自动启动必须可取消（开发态 StrictMode 假卸载），失败不得写成「进程已退出」。细则 `docs/conventions/agent-workbench.md`。
- **运行页上下文分工（v3.127）**：左栏「项目与工作区」只负责切换终端上下文；目录浏览、搜索、钻取和返回由「文件树」独立负责。文件树悬停「进入」才改变浏览根，不改变 Agent 实际运行目录；单击文件夹只原地展开/收起。两者不一致时必须显示「正在浏览 … · 终端仍在 …」并提供「回到当前目录」。Agent 运行中点击项目/工作区不得静默失败，改为在新标签打开目标上下文并给出短提示。
- **聊天/终端按标签隔离（v3.127）**：每个终端标签独立保存显示层（聊天或终端），切换标签不继承另一标签的显示选择；两种显示层仍共享同一 PTY、会话文件和 TerminalView。
- **项目区问 AI（v3.186）**：第一次选 Agent / 配置 / 模型，可设为默认（`ccode.askAi`）；未设默认不沿用 `lastLaunch` / 快速开聊。默认面是终端不是聊天；`previewPath` 打开右栏预览，PDF 与「查看」一样撑开。⌘/Ctrl 点问 AI 强制重选。指定了 `profileId` 时启动栏不得用上次留下的模型。
- **顶部终端标签（v3.135 / v3.153 / v3.177）**：终端标签名与「＋」放进同一个 Ghostty 式轻量圆角胶囊；显示层、成果面板、分屏、查找不并入标签胶囊。聊天/终端是同一位置的单击切换（图标显示当前层，再点切到另一层）；成果面板是标签栏右侧常驻按钮（与左侧文件树按钮对仗）；分屏对照与查找终端输出同样是标签栏右侧 lucide 图标（与聊天/终端、成果面板同一套描边），不再经过布局菜单。标签栏右侧到查找为止，不放 `⋯`。没有「专注终端」入口：需要干净画布时收起左边工作树。
- **标签「生成中」虚线圆（2026-09-13）**：只表示这一轮正在出字，不是进程还活着。用户提交（聊天发送 / 回车）后才允许点亮；**启动或恢复会话不转圈**（TUI 启动/回放画面不是生成回答；只有新会话带了首条指令才点亮）。带指令的新启动同时拉起聊天「等回复」（`pendingReply`）：从终端切到聊天要立刻有「正在回复」和发送钮「进行中」，不能等会话文件落盘或用户再发一条。TUI 开屏算出字，但等回复未结束时不得因 PTY 静默熄灭转圈。PTY 有输出才续命。会话窗口最后一条已是助手正文（无待执行工具）或尾部 `done`/`confirm` 立刻停转——不等 PTY 静默、也不让会话文件 sticky `working` 续命；**但 PTY 还在出字时（`ptyLive`，8s）不得被 Codex 中途 `agent_message` / 助手正文把转圈掐掉**（2026-09-18：长工具回合标签与聊天层无运行态）。回合结束后的 TUI 残帧不得从 `done` 再点亮。**收尾被 ptyLive 推迟必须保证重试（2026-09-19）**：推迟后若会话文件再无新写入，5s 轮询的签名门会让收尾判定永远不再执行、转圈冻结（综述大纲跑完实测）——`scheduleSettleRetry` 在 `PTY_LIVE_MS+1s` 强制重判一次；**armed 静默硬上限 120s（2026-09-19）**：真实思考/执行期间 TUI 动画仍在出字，整轮完全无声超上限只可能是回合已结束或链路冻结——熄灭转圈但保留 armed（PTY 再出字立即复亮，不重演 2026-09-15 的「再也点不亮」）。样子是 12px、`text-l2`、`strokeWidth=3` 的虚线圆沿圆周爬，不上强调色。动画走合成器相位闪 opacity，禁止 CSS `rotate`（WKWebView 圆心会晃），也禁 dashoffset 关键帧。纯逻辑 `src/tab-working.ts`。
- **终端菜单分工（v3.136 / v3.153 / v3.177）**：启动栏 `⋯` 只保留当前标签的启动动作（打开 Shell、高级启动选项、转为项目）。标签栏不设 `⋯`：停止走展开启动栏「停止」，恢复走空态「恢复任务」，接力/对话页走对话页。查找、分屏是标签栏图标；「修改启动配置」只留收缩状态行的「修改」。已有 PTY 时该钮改成「本次」，只开浮层，不把整条栏撑开（2026-10-10）；`⋯` 里的高级选项同样改成「查看本次启动」。未启动仍展开整条栏。不设布局菜单。**收缩状态行在会话运行中必须保持可见（2026-10-08 修复回归）**：`activePtyId` 一挂就把整条底栏（展开栏与收缩行）藏掉，`⋯`/修改/插入在会话存活期全部不可达，快速开聊的「转为项目…」出口随之消失。底栏高度归零是 design-embedded-terminal.md 方案 C（PR4）的形态，portal 与底栏身份补偿没做之前不得提前隐藏。
- **收缩行提示与错误分家（2026-10-09）**：只陈述事实、不需要用户动手的消息（「已接回正在跑的进程，画面大小先不动」）走独立的 notice 态——灰字、不进 `compactBarUrgent`、进程退出即清。**禁止塞进 `error`**：error 会把收缩行强制顶出来（用户点「收起此行」永远收不起来，2026-10-09 实测）且飘红冒充故障，还会经 `error ?? "恢复会话失败…"` 兜底把接回提示错报成发送失败原因。需要用户动手的（「该 CLI 不支持启动注入：指令已复制」）才允许走 error 拦隐藏。
- **启动栏窄宽度防覆盖（v3.137）**：Agent/连接/模型配置组允许收缩，控件宽度按窗口响应式钳制；技能/MCP/运行/更多动作保持独立不覆盖，恢复任务与 `⋯` 使用稳定间距。标签栏和启动栏不共享绝对定位或负边距，窄窗口只允许换行/截断，不允许按钮互相覆盖。
- **启动栏层级间距（v3.138）**：启动配置条与顶部终端标签之间保留明确的垂直留白（TerminalView 上内边距），恢复态的技能/MCP/运行/更多状态行不再贴住上一栏下边框；Agent、连接、模型选择器使用较窄的响应式宽度，不因窗口变宽而放大到挤压动作区。
- **启动配置条内容宽度（v3.139）**：Codex/连接/模型外层容器按内容宽度收缩，不再用 flex 增长占满整行；仅在窄窗口时允许收缩/换行。恢复态动作行额外保留上间距，避免视觉上盖住标签栏下边框。
- **启动栏右侧动作组（v3.140）**：技能、MCP、运行/恢复和更多按钮统一组成右侧固定动作组，由 `ml-auto` 推到最右；模型异常提示独占下一行，不再挤压或覆盖动作按钮。
- **启动栏选择菜单向下展开（2026-09-22）**：Agent / 配置不用系统 `<select>`。系统菜单把当前项对齐按钮，Grok 在名单末尾时整单往窗口标题上方长。应用内菜单从按钮下沿向下展开（`placeDownMenu`），右侧放不下只左移，下方不够只限高滚动，不翻到锚点上方。收起时只显示当前值，角色词在清单顶上，避免窄宽截成「Agent G」。按下即展开。模型仍是可输可点的组合框，清单同样向下。停用配置仍在清单底部「已停用（可手选）」分组。
- **聊天资源入口不自动发送（v3.130）**：聊天 composer 的技能/MCP 菜单点击只插入提示文本并保留焦点，用户可继续补充后按 Enter 发送；不得直接调用发送链路。终端启动栏的技能/MCP 入口继续只写入 PTY 输入缓冲、不自动回车。全局命令面板/页面快捷键忽略 `input`、`textarea`、`select`、`contenteditable` 和 IME 组合输入。
- **项目 rail 图标语义（v3.129）**：主项目使用 `FolderOpen`；绑定研究流程的工作区使用两位流程序号（01、02…），让步骤先后可扫读；未绑定流程的手动工作区使用 `GitBranch`。不使用抽象斜线或重复 Unicode 符号冒充步骤图标。

- **外部终端安全临时复现（2026-08-21；2026-08-31 Windows 收口）**：外部恢复/提炼接力不得把 profile 密钥拼进命令、剪贴板、前端 IPC 或普通日志。前端只传明确选中的 `profileId`、模型、provider、会话 ID/提示词等非敏感元数据；缺少 `profileId` 时后端必须 fail-closed，不能静默取第一个配置。后端从 `ProfileStore` 读取密钥，复用 `agents::launch_plan`/`prepare_launch` 生成一次性 wrapper。Unix wrapper 存于 `<config>/ccode/external-launch/`（目录 0700、文件 0600，通过 `/bin/sh` 按路径执行），启动首行自删，失败立即清理，60 秒兜底删除。Windows 由设置页二选一（立即生效）：**cmd**（默认）走 `start "Mesa" /D <cwd> cmd.exe /K <binary> <args>`，密钥在父进程环境块经 start 继承、不写 ps1（命令行超过约 7000 字才写无密钥的 `.cmd`——批处理必须单字节编码：前两行 ASCII + `chcp 65001` 后按 UTF-8 读，禁 UTF-16/带 BOM）；**powershell** 走一次性 UTF-8 BOM 的 `.ps1` wrapper + `start powershell.exe -NoExit -File`。两条都经 **`background_command("cmd")` + `raw_arg` 直投 start**。五个坑都别改回去：① 预加引号的复合命令不能走 `Command::args`（Rust 加壳成 `\"`，cmd 对 /C 后文本不认反斜杠转义，start 把 `\"\"` 当程序名）；② 不能直接 spawn powershell/cmd + CREATE_NEW_CONSOLE（dev 实例从 npm/Git Bash 链路继承的 std 句柄是管道不是控制台，会遗传给子进程——TUI 写进管道、读不到键盘，新窗口只剩黑屏光标、agent 随即退出，grok 实测复现；start 经 ShellExecute 拉起时子进程 std 才挂到自己的新控制台）；③ 启动热路径不要同步 icacls（`%APPDATA%\ccode` 默认 ACL 已是当前用户）；④ **start 的窗口标题必须非空**（空标题下 GetConsoleTitleW 返回 0，旧版 libuv <1.52 的 uv_get_process_title 会 assert(process_title) 直接 abort——kimi 这类内嵌旧运行时的 CLI 必崩，win/util.c:412，实测复现）；⑤ **拉起后不能 output()/pipe 收尾**（start 的子进程继承 cmd 的管道句柄，read-to-EOF 会阻塞到用户关掉外部窗口，同步 command 堵死、整个应用未响应；start 立即返回，只 spawn+wait 收外层 cmd，毫秒级）。外层 cmd CREATE_NO_WINDOW 不可见，可见窗口由 start 创建——这是「用户明确打开外部终端」例外。Ghostty 运行中实例使用其原生 AppleScript `new surface configuration`/`new window`：工作目录单独写入 `initial working directory`，先启动 `/bin/sh`，再经 `initial input` 发送带 shell 引号的 wrapper 路径；不能把 `Application Support` 等带空格路径直接放进 `command`。该路径不依赖 System Events 辅助功能权限或剪贴板；未运行实例使用 `open -na`。iTerm/Terminal.app 只接收不含密钥的启动命令。复制命令继续保持全局配置模式，不自动携带 profile 密钥；Windows 复制的是 PowerShell 方言。

- **定时历史评审（2026-09-07）**：有 watch Run 身份时先打开冻结产物对照，三列是执行前主仓、执行前隔离目录、本次结果；
  仅四类台账可在这里采纳。另点「查看当前工作目录」才进既有只读 Git 评审，标题明确不是历史快照，该视图不得保留旧的直接采纳按钮。
  无证据/失败任务不开放自动采纳，内容以纯文本显示；保留返回与当前目录入口，不影响底层 PTY 挂载。
- 「停止」或 agent 退出后必须**自动回落用户登录 shell**（`$SHELL -l`，同 cwd），不死在最终画面；手动 `exit` 不自动
  重开；回落 shell 不带 profile env；agent/shell 共用 `pty.rs` 的 `spawn_tracked`，退出事件按 PTY 类型区分。
  同一次会话：第一条真正的用户问题出现后先无头写临时标题；Agent 退出后再只用用户原话（首条意图 / 中途纠正 / 最后定题）校正一次，不送助手回复。格式 `MMDD|类型|主题`（创建日上海时区），主题 8–28 字、至少 4 个汉字、对象+动作；已占用的「类型|主题」不得重复。写入 `session_meta.custom_title` 且 `title_source=auto`，不写回 CLI 源文件。人手改过的标题（`title_source=user`）不覆盖；内部会话、内容不足或没有创建日则跳过。失败静默，不挡回落 shell。
- **重启只恢复标签元数据，不恢复 PTY**：白名单限 label/cwd/agent/profile/model/sessionId，禁存 PTY id/scrollback/密钥/
  env/run 脚本；重开后为「上次任务，可恢复」占位，点击才建新 PTY；目录/profile 失效留在可编辑启动栏提示，禁自动换目标。
- **预览版本与编辑缓冲（2026-09-07）**：文件预览和产物内联编辑均使用后端读取快照的 `revision` 保存，冲突时保留
  当前编辑并提示用户另存/复制后重开对比，不自动强制覆盖。文件由外部增长至超过 256 KB 时立即只读；编码不支持和根外
  symlink 同样只读。外部刷新晚返回不能覆盖已变脏的编辑器；保存确认返回只承认实际提交文本，保存中新增输入不得清 dirty。
  只读状态变动用 Monaco `updateOptions`，不重建旧文本实例。文档 HTML 安全口径见 safety.md。
- **预览编辑器不映射同名文件**：切项目/工作区/标签 cwd/树根时清空旧预览，由用户在新根重选，禁自动打开新根同相对路径
  文件；有未保存改动先确认，取消则不切根；主仓库文件保存按钮警示色 + 二次确认。
- **`.ccode` 目录对「默认隐藏」豁免**：文件树 `list_dir` 在 `showHidden=false` 时仍显示 `.ccode`（任务书草稿
  drafts/、help-wanted 等是用户要找的内容，预览关掉后只能从这里找回）；同一理由 `fs_noise_skip` 也豁免
  `/.ccode/`——AI 改草稿必须能触发预览实时重载。其余点开头条目/隐藏目录照旧隐藏。
- **文件树搜索与隐藏目录（v3.157）**：`search_files` 不再一律跳过所有 `.` 开头目录（否则 `.kimi-code` /
  `.claude` 配置永远搜不到）。噪声目录（`.git` / `node_modules` / `target` / `dist` / `Library`）仍始终跳过；
  `.ccode` 恒进。其余隐藏目录在三种情况下进入：工作树开了「显示隐藏文件」、查询以 `.` 开头、或目录名本身命中查询。
  点搜索结果若落在隐藏路径上，自动打开「显示隐藏文件」以便树内定位。根下隐藏**文件**（如 `.env`）本来就能搜到。
- **空白运行标签默认家目录（v3.163，改 v3.159）**：无 `initialCwd` 的新标签（第一次进运行、关最后标签、「＋」）目录是 `~`，不预填当前项目主仓，也不继承 `ccode.lastLaunch.cwd`（那常是 lit-search 等工作树）。点项目 / 工作区才「真进入」该目录。已恢复的任务标签仍用自己记下的 cwd。
- **Excel 宽表预览（v3.164 / v3.211）**：`.xlsx`/`.xls`/`.ods` 只读网格（列字母 + 行号冻结、横滑看全列；点格子顶栏显示全文）。后端 `read_sheet_preview` 最多 200 行 × 256 列并回 `totalRows`/`totalCols`；xlsx 带合并区（`merges`，前端 `rowSpan`/`colSpan`）。办公弹层表格用更宽窗口、网格自己滚动（不要外层 `overflow-auto` 把表撑破再裁切）。多工作表底栏切换。复杂公式/图/宏仍以 Excel 为准。
- **文件树按后缀搜（v3.158）**：`pdf` / `.pdf` / `*.pdf` 按扩展名匹配（大小写不敏感）；`doc` 同时覆盖 `.doc`/`.docx`
  （ppt/xls/jpg/htm/md 同组）。`.pdf` 与 `*.pdf` 只返回该后缀，避免 `pdf-notes.md` 凑数。后缀命中单独成桶、排在
  文件名包含匹配前面，避免 50 条上限被「名字里有 pdf 的 md」挤掉真正的 PDF。
- **文件树折叠钮与双击进入分离（v3.157 / v3.209）**：单击文件夹名或折叠箭头只在原地展开/收起。箭头连点也要能开合
  （勿用 `e.detail > 1` 吞第二次点击）。进入此文件夹（只改浏览根）走悬停「进入」，不要靠第二次单击/双击——
  两次单击会被系统合成双击，表现为「点一次展开、再点就进去了」。
- **任务审阅 = 终端全宽覆盖层**：工作区行「评审」与终端「改动 → 审阅」同一视图。检索/精读/大纲在基础检查旁切清单或笔记/稿件／过程／文件，Git 对照只在「文件」；冲突模式仍连续浏览累计 diff。可「提交并保存进项目 /
  仅提交 / 保存进项目并归档」；底下终端标签与 PTY 保持挂载。默认只保存进本地项目并保留工作区，不自动推送；原「提交 /
  提交并推送」与工作区行 PR/归档/会话操作保留。`merged_at && ahead == 0` 时按钮禁用显示「已保存进项目」，`ahead > 0` 恢复。
- **冲突审阅与普通审阅共用同一覆盖层**：冲突模式读 Git index stage 2/3，任务/基准分支按文件连续双栏，右侧冲突清单可
  定位，逐文件/全部选边与 ◈ AI 建议同屏；禁第二套冲突解决器；入口用「开始解决冲突」任务语言。全部选边默认串联「提交
  解决结果 → 健康检查 → 合并（保留工作区）」，另保留「仅保存解决结果」；提交成功而合并失败必须提示部分成功，不自动
  重做 merge commit。「解决冲突」后干净工作区必须自动以**当前基准 tip** 准备两侧（完成前禁以 merge-base diff 冒充）；
  处理中基准前进立即停止展示和选边，经用户确认 `merge --abort` 后重新同步。评审入口以 intent 区分
  （`WorkspaceReviewRequest.action`：pr/archive/resolve-conflict）：仅 `resolve-conflict` 允许自动同步基准、准备冲突两侧。
- **评审覆盖层以代码为中心**：顶部固定任务/分支/增删统计与唯一主动作，提交信息和批量冲突操作在第二工具行；右侧文件目录默认收起，顶栏「文件列表 / 收起文件」开关，窄窗口仍是抽屉。对照长行换行，不再按 720px 硬撑；左右分栏只在 xl 及以上，更窄时上下叠。diff 连续浏览、标题吸顶、长段未修改折叠，目录打开时选中随主区滚动同步；冲突选边用文件标题下
  紧凑双侧控件，AI 理由单行展示、用户显式执行。**提交信息可留空（v3.97，面向不懂编程的用户）**：留空走
  `defaultCommitMessage` 本地规则默认信息（chore: 更新 N 个文件），不调 AI、不拦提交——评审与归档弹层同口径，
  与改动面板「留空 = 快速提交」、主仓快速提交面板的先例一致；想写更好的点 ◈。
- **改动面板识别合并冲突（v3.180）**：`git_status` 读 `MERGE_HEAD` 下发 `merging`；porcelain 冲突码归 `U`，
  文件列表单独「冲突的」组。条头提供「取消合并」（`git_abort_merge`）。编程页冲突引导去**终端**改动面板
  （页名不用「运行页」），并同样给取消合并出口。
- **改动面板跟随左栏文件树的根，而非终端标签 cwd**（v3.82，用户拍板）：「我在看哪个目录，改动就显示哪个」——
  FileTree 根切换（钻取/上级/项目区切根）成功后经 `onRootNavigated` 上报 TerminalPage（`treeRoot`），GitPanel 吃
  `treeRoot ?? activeCwd`；切标签/分屏焦点变化时 TerminalPage 主动清空分叉回落标签 cwd（树未挂载时无人上报，必须兜底）。
  对话页签不跟随（对话天然属于终端会话），文件预览沿用 `preview.root ?? activeCwd` 不变。
- **标签条只放标签管理 + 布局图标（v3.88 减负，v3.177 再收口）**：原先一行同时挂着
  注意力点/标题/可恢复/◧/×/＋/git 芯片/✓保存/可合并 pill/◧分屏/◫工作台/⤢专注/⋯。按职责三分：
  ① **标签管理**（点/标题/可恢复/◧/×/＋）留原位；② **布局图标**（聊天/终端切换、成果面板、
  分屏对照 `Columns2`、查找 `Search`，同一套 lucide 描边、选中 `bg-seg-sel`）；标签栏不放 `⋯`。
  ③ **状态镜像下移**到中带底部状态条（见下条）。不设「专注终端」入口。
  **标签支持拖拽排序（v3.93，用户提出；Ghostty 式跟手拖动）**：pointer 事件自实现（按下超 6px
  横移进拖拽态，window 级 move/up/cancel 监听）——**不能用 HTML5 DnD**（`draggable`/`onDragStart`）：
  Tauri 原生文件拖放（`dragDropEnabled` 默认开）会拦截 WKWebView 的拖拽手势，dragstart 根本不触发；
  全站拖文件走的都是 `onDragDropEvent` 原生事件而非 HTML5 DnD。拖拽手感：进拖拽态时测量各槽位
  `getBoundingClientRect`（拖拽期间 `tabs` 顺序不变，测量值才有效）；源标签 `translateX` 跟手
  （钳制在标签条内容范围内、relative + z-10 浮起 + `bg-raised`），原位置与目标槽位之间的标签各
  退/进一个槽位（150ms transform transition 滑动让位，位移用相邻槽位测量差而非假设等宽）；
  松手先让源标签 transition 吸附到目标槽位、动画结束才 `moveTab` 重排清态（避免瞬移跳变），
  落定后吞掉紧随的 click 防误切换。钳制与目标槽位判定抽在 `src/tab-drag.ts`
  （tests/tab-drag.test.ts）——**目标判定必须 `>=` 中线**：钳制上限恰好让源中心到达末槽中线
  （等宽槽位等号成立），严格 `>` 会让「拖到最右」永远差一个无穷小、末槽永远不让位（两标签时
  左拖右 100% 复现）。顺序即 `tabs` 数组顺序，重启持久化本就按数组存，顺序自动带过去。
- **中带底部状态条（v3.88）**：git 芯片 `⑂ 分支 +N -M`、`✓ 保存`、`● N 个可合并` 从标签条下移至此。
  理由：它们是**结果不是入口**，放顶部与标签抢注意力；状态栏是 VS Code / Codex 的通行心智，
  `✓ 保存` 在底部误触概率也更低。**v3.83 的行为语义一字未改**（点数字开改动页签、
  `✓保存` 走 defaultCommitMessage 全量快速提交、隐藏 GitPanel 实例继续轮询喂数据），只是换了位置；
  工作树收起时同样保留。整条在非仓库且无可合并时不渲染。
  **v3.90（用户拍板）**：芯片在「工作区干净但有未推送提交」时也要出现——`GitSummary` 增
  ahead/behind 字段，芯片渲染条件从 `files>0` 放宽为 `files>0 || ahead>0`；芯片行内新增
  `↑N`/`↓N`（悬浮白话解释）与「⇧ 推送」按钮——走与改动面板同一个 `git_push` 命令
  （含无上游自动 `push -u`），只在 `ahead>0` 时渲染（没提交可推时摆着只会误点）；
  行内反馈（推送中/已推送/失败 2.5s）与 ✓保存 同口径、独立计时器。
- **右栏头部低频动作 hover 才现（v3.88，历史）**：「⇱ 专注内容」「× 收起工作台」与「↺ 完整回放」（v3.91 起
  由文字钮改图标钮）均挂 `hoverRevealClass`（头部行挂 `group`）；双击页签 = 专注内容的语义不变。
  **v3.91–v3.92 的对话底条规则已由 v3.125 主工作区聊天层取代**；完整回放仍可从聊天头部「↺ 历史」进入，右栏不再承载实时会话。
- **从其他页面进入终端页，右栏默认收起（v3.90，用户拍板）**：`visible` 假→真跃迁时检查交接——
  有 previewReq / pendingTerminal.rightTab / pendingTerminal.previewPath（资源面板「查看」、
  主仓改动提醒、问 AI 带文件）才开右栏；用户曾用成果面板按钮钉开（`ccode.terminal.rightOpen=1`）则保持打开，
  否则 `setRightOpen(false)` 只剩终端。判定用
  `useAppStore.getState()` 现查（交接与切页是同一批 store 更新），不依赖 effect 顺序；页内动作
  （单击文件树文件、◫ 工作台、对话联动）照常展开，不受影响。
- **文件树默认可收起（用户拍板）**：首次进入不展开文件树；收起后不留窄条（与项目页项目列表同款），
  「显示文件树」放在最左标签胶囊内部，不在标签行左侧单占一列（否则标签胶囊与下方启动栏胶囊左缘错开；把启动栏缩进则按钮下留空）。显式开关写入 `ccode.terminal.treeOpen`。
  目录是主目录且树已经开着时自动收起一次（不改偏好）。人点开的当次必须保持打开，不能点第一下被收掉、第二下才留下。家目录还没解析到时不补收。离开主目录后可以再自动收一次。
  快速开聊 `pt.clean` 收起工作树（`persistTreeOpen(false)`）并关上右栏，不另造专注态。
- **成果面板常驻按钮（v3.153）**：标签栏右侧「显示成果面板」与左侧文件树按钮对仗；点按切换并写入
  `ccode.terminal.rightOpen`。打开后同一按钮变为「隐藏成果面板」（选中态）。页内点文件或交接请求仍可临时打开右栏。
- **标签条变更芯片（v3.83，Codex 式，用户拍板）**：标签条右侧常驻镜像改动面板摘要（`⑂ 分支 +N -M`，仅当前目录
  是仓库且有未提交改动时出现）；点数字 = 打开右栏「改动」页签，「✓ 保存」= 全量快速提交（message 走
  defaultCommitMessage 本地生成，工作区视图 paths 传 null——与面板「快速保存到历史」完全同口径，行内
  保存中/已保存/失败 2.5s 反馈）。数据源是 GitPanel 上报的 GitSummary（onTotals 扩展）；**右栏关闭时
  改动面板随右栏卸载，须挂 display:none 的隐藏 GitPanel 实例持续轮询**（与面板实例互斥永不同存），否则芯片无数据。
- **改动面板空信息走本地快速提交**：非空原样提交；为空按文件状态/数量即时生成中性默认信息直接执行 `git_commit`，不
  为此启动 AI；失败保留默认信息供重试；◈ 按钮与手动输入保留，仅主动点 ◈ 才调 AI。
- **终端右栏统一称“对话”，有界实时视图（历史）**：仅最近 50 条；该实时视图已在 v3.125 移到主工作区聊天层，右栏只保留文件与改动。
- **同会话双界面（v3.126 / v3.153 / v3.168）**：主工作区默认显示终端（2026-09-02 起，此前默认聊天；默认值单一出处 `DEFAULT_SURFACE_MODE`，TerminalPage.tsx），模式切换收进终端标签栏同一个单击按钮（图标显示当前层，再点切到另一层），不再单独占用一行、也不再并排两个按钮。两者共享同一个 TerminalView、xterm、PTY 和会话文件；聊天层隐藏终端画面但不卸载，切回终端不重建进程、不丢滚动缓冲。进入聊天模式自动退出分屏，切回终端不自动恢复分屏；聊天模式隐藏完整 TerminalStatusBar，必要上下文移到聊天头部与 composer，终端模式保留状态栏；该显示策略只存运行态，不增加持久化设置。右侧工作台只保留「文件 / 改动」，不再显示重复的对话面板。
- **聊天层拉起终端（v3.168 / v3.177）**：聊天与终端仍是同一 PTY 的两层，不是两个会话。拉起 = 底栏真实分栏（约 32% 高度），终端按此高度 fit，TUI 才能画进可见区域。不能只裁全高 xterm 的底部——Codex 主对话是 inline viewport，内容靠上、底下是空行，裁底就是白板。切聊天/终端仍铺满同一容器、行列数不变；**只有拉起开合**会 SIGWINCH 一次（Codex 可能重放历史，这是能看见 TUI 的代价）。默认关；`attention === confirm`、8 秒无会话文件、斜杠 `/model` 无参 / `/models` / `/login`、以及聊天层点 picker 模型时自动打开。用户手动收起后本轮不再自动打开。开关只在聊天头部（「拉起终端」/「收起终端」），不在标签栏菜单重复。不复制九家 TUI 菜单解析器；交接表在 `src/chat-handoff.ts`（chat_ok / peek / must_switch）。
- **聊天等待态与历史窗（v3.168）**：发送后的加载文案按交接表区分「已送出 / 正在写盘 / 正在用 {工具} / 会话文件还没出现」。工具块一旦进会话文件立即渲染，不必等 assistant 正文才结束等待。聊天主区展示会话文件尾窗（后端 192KB 分页），可「加载更早的消息」；完整回放仍走对话页。压缩会话（zstd）没有更早一页。JSONL 超长行（Codex 工具输出常 >192KB）必须整行跳过，且空窗在同一请求里继续往前，禁止把 cursor 钉在行尾。
- **聊天空态（v3.214）**：未开始时头部不写「等待会话文件」（`chatHeaderStatus`：没跑、也没消息则空着；可恢复占位除外）。画布不写「从一个问题开始」、**不加点阵**。输入框占位「问一个问题…」，目录短句收进 composer 底栏「将在 … 开始」（点选目录，`welcomeCwdLine`）。＋新建 / 历史等会话建立后才出现。模型芯片未启动不做成假下拉。
- **聊天层模型/思考档与拖入（v3.168）**：头部模型菜单与状态栏同一套 `modelSwitch`/`effort`（直切写 PTY 命令；picker 写命令并窥视）。拖入文件进聊天输入框（一行一个路径），盖住终端的坐标不再写 PTY。Kimi 的 CSI-u Enter / Ctrl+V 序列集中在 `terminal-input.ts`（`KIMI_CSI_U_ENTER` / `KIMI_CSI_U_CTRL_V`）。
- **表层默认（2026-09-02 起终端为默认）**：默认面层改为终端后，「落终端」不再是需要列举的例外；明确聊天意图的入口（分叉聊天等）仍显式落聊天层。纯 shell/脚本标签（官方账号登录、CLI 自更新、run 脚本——shellOnly/prefillCommand）创建时仍显式置终端面，守住「默认值再变也不回到 chat 盖住登录输出」的口径；agent 启动被会话前确认卡住（信任此目录/登录菜单，attention 门控要求 sessionFile 存在、管不到这段）时，聊天空态 8 秒无会话文件即显示「终端里可能有待处理的确认」+「打开终端处理」出口（8s 延迟防正常启动误闪现）。
- **聊天资源入口（v3.126，v3.130 修订）**：聊天 composer 与 TerminalView 复用当前 Agent 的技能/MCP 清单。点技能或 MCP 只把提示插入聊天输入框，不自动调用发送链路；用户补充后按 Enter 才写入当前 PTY（未启动时沿用自动启动/首条 prompt 语义），MCP 菜单可跳转 MCP 管理页；不复制终端专属 TUI 菜单解析器。
- **聊天发送链路（v3.125）**：Enter 发送、Shift+Enter 换行；运行中的 Agent 直接写当前 PTY，已结束会话自动 resume，未启动标签自动启动并把首条消息作为启动 prompt。Kimi 等不支持启动注入的 CLI 自动切到终端并保留/复制待发送文本；终端专属确认、登录和选择器统一提示「需要终端操作」，不复制脆弱菜单解析器。
- **聊天输入法 Enter（v3.168）**：组词未上屏时的回车只确认候选，不发送。WKWebView 上确认候选的 Enter 在 compositionend 之后、`isComposing` 已是 false，只看 `isComposing` 会误发——组词锁 + keyCode 229 + compositionend 后再留一帧（`ime-guard.ts`）。
- **聊天回复反馈（v3.131）**：发送成功后先显示本地用户消息并展示「Agent 正在处理…」加载状态；会话文件刷新时保留尚未落盘的本地消息，只有检测到发送之后的真实 assistant 消息才结束加载。等待回复期间使用约 700ms 的短兜底刷新，防止单次 watcher 事件丢失导致回复永远不进入聊天层；回复到达后立即停止该兜底刷新。2026-08-24 起本地消息从单条改为队列（pendingUsersRef）：连发多条全部保留，已落盘的逐条移出，全部落盘且等到新回复才结束等待；兜底轮询有 3 分钟超时。
- **聊天层审批卡片与暂停（2026-08-24；2026-09-13 停止与发送同体）**：注意力 confirm 时横幅升级为审批卡片——详情文案来自 hooks 日志 payload 的 `message`/`tool_name`/`title`（`session_confirm_detail` command，与 state_for_session_file 同一套门控；payload schema 各家未文档化，取不到回通用文案）；✓ 批准 / ✗ 拒绝 / Esc 取消三个按键经 `writePty` 写单字符（y/n/\x1b），是保守热键集，各家审批菜单形态未调研、按键无效引导「打开终端」，不复制菜单解析器（v3.125 决策不变）。独立「⏹ 打断」已删：正在生成时发送钮变「进行中」符号钮，点击写 `\x1b`（Esc 暂停当前回合，会话保留；不是 `\x03` 硬中断）。暂停后清掉「等待回复」，发送钮变回发送，下一句仍写进同一 PTY（和 Codex 按 Esc 再继续一样）。只在 `attention === working` 或等待回复时出现，进程活着但停在提示符时仍是发送；审批 confirm 时 Esc 归审批卡。
- **聊天写入 PTY（v3.133）**：聊天发送必须取 `TerminalView` 当前 `ptyIdRef/ptyKindRef` 作为目标，不依赖异步状态镜像；文本和提交键通过后端 `pty_write_submit` 写入，文本先遵守 bracketed-paste 规则。2026-08-24 起正文与提交键分两次写、中间留 60ms（spawn_blocking + thread::sleep，不占主线程）——背靠背写入时开了 bracketed paste 的 TUI 来不及把粘贴内容收进输入框，回车会被吞掉；恢复会话路径发送前再额外等 1.2s（进程引导/会话回放/信任提示期写入会落在未就绪的 TUI 上）。普通 CLI 使用 `\r`，Kimi 继续使用 CSI-u Enter。
- **聊天层常驻挂载（2026-08-24）**：ChatSurface 不再随 chat⇄terminal 切换卸载（display:contents/none 仅隐藏），输入框草稿、滚动位置、ConversationView 展开状态切层不丢；ChatComposer 的一次性 autofocus 改为 `focusWhen` 可见性信号（隐藏态 focus() 被浏览器忽略，不会抢终端焦点）。AI 正文经 ChatMarkdown 渲染 Markdown（安全口径见 safety.md），超长未展开仍保持截断纯文本 + 展开按钮。
- **会话同步（v3.125 / v3.168）**：关联成功后优先注册专用 session watcher，普通 JSONL 监听目标文件目录，OpenCode 监听数据库与 WAL；事件短防抖后通知前端，前端用会话文件尾窗替换最新一页并与已向前翻页的旧窗去重拼接。签名轮询保留为 watcher 失败或丢事件时的兜底，并以请求代次防止旧读取覆盖新消息。同步状态显式区分识别中、已监听、等待文件、兜底轮询。
- **分叉聊天（v3.125）**：新建聊天只在已有 session 文件和 session ID 时启用；复用结构化接力简报与 handoff 链，不复制完整原始历史。新标签继承 Agent/连接/模型/目录，默认聊天模式、自动启动、只读；不支持原生只读参数的 CLI 标注「提示约束」。点击「允许修改」确认风险后停止只读 PTY，以同一摘要和配置重启可写会话，原会话保持不变。
- **启动栏与状态栏分工（v3.91 / v3.213）**：启动栏主流程 Agent → 配置 → 模型 → 启动，技能/MCP 胶囊右对齐在启动行末端；
  工作目录不占启动栏。未启动时：空态卡写「将在 … 启动/恢复」（点击选文件夹）；底栏只留状态点 + 目录胶囊
  （点开浮层可键入路径，支持 `~`）。运行/shell 中 cwd 由 pty_get_cwd 4s 回写跟随，shell 里 `cd` 即可；
  底栏此时才显示 agent · 配置 · 模型芯片 / git / token。
  **空态卡（v3.93 收敛 + v3.213 去重）**：无顶部图标盒、无说明小字、**无 agent/配置身份行**
  （同一事实只说一次，身份归启动栏）。卡片 `w-80` 走 `.ccode-well` + 极浅勾边，不加投影/毛玻璃；
  画布垫 18px 点阵。主按钮宽 `min-w-40 px-5` 自适应内容——勿按比例（w-2/3）随卡片宽缩放。
  纯逻辑 `src/terminal-welcome.ts`。
- **文件树系统目录置灰（v3.91）**：`list_dir` 对家目录直下命中平台清单的目录（macOS：Library/Applications；
  Windows：AppData 等）标 `isSystem`，前端行 opacity-50 + title 注「系统目录」；普通用户目录不置灰，交互不变。
- **终端左栏两段化（v3.42 / v3.208）**：常驻 = 项目区（ProjectRail）+ 文件树；「打开的标签」折叠区已删除（runInputs 镜像保留）；
  「最近项目」收进文件树搜索行 ⌄ 浮层（真进入/↗ 新标签语义不变）；区间靠留白分层。**文件树一次只跟当前标签一棵**。
  **项目区**列出：科研活跃工作区所在仓 ∪ 正在跑/等确认的已添加项目（含编程工作树、办公目录归属）∪ 当前标签所属项目；
  当前项置顶标「当前」。不铺编程工作树/办公文档。纯逻辑 `src/project-rail.ts`。行内交互（真进入/悬浮/size-2 状态点）不变。
- **右栏可调分栏，不新增普通内容全屏路由**：左缘拖拽调宽并记忆；**宽度上限不写死像素**（v3.60 前曾限 820px），
  随窗口自由拉宽、只给中带终端保留 340px 最小宽度（`TERMINAL_MIN_RESERVE`），下限 360px；宽屏动作暂隐工作树但保留终端，再执行恢复，双击
  对话/预览/改动页签同义；宽度变化必须触发 xterm 重新 fit；任务评审仍用全宽覆盖层。
- **渲染器按平台分流 + 用户可切（2026-09-19 起设「终端渲染」，勿回退默认）**：macOS 默认不走 WebGL——
  xterm 的字形图集→GPU 纹理采样在 WKWebView 里整体偏软发糊（A/B 截屏实测 DOM 渲染明显更锐利，
  Safari 同引擎复现一致；2026-09-21 复测到量化证据：图集按整数设备像素取整单元格（DPR 2 即 0.5px 步进），
  同一字体同一字号实测字宽 7.8 被压成 7.5（−3.8%，字形横向压缩并对齐到更粗的栅格）），故 macOS 默认用
  xterm 默认 DOM 渲染器；Windows 默认 WebGL 加速。
  滚动流畅度是另一面的真实诉求（DOM 渲染器滚动时要逐行建/拆 DOM，体感不如原生终端）——
  设置页「终端 → 终端渲染」提供 auto（默认，平台分流如上）/ webgl（流畅，Mac 上文字可能略软）/
  dom（清晰）；选择在**新开的终端**生效，选 webgl 仍过 `isSoftwareWebGL` 探针（TerminalPage.tsx）
  并在上下文丢失时自动退回默认渲染器。canvas 渲染器 addon 只声明支持 xterm 5（截至 0.8.0-beta.48），
  不引入。**别把「触控板合帧」说成清晰与流畅兼得**——合帧只砍同一帧内的重复位置写入，每帧重绘次数不变。
- **终端字体链单一出处 `src/terminal-font.ts`（2026-09-21 修）**：xterm 的 `fontFamily` 就是一段 CSS 字体列表。
  以前 TerminalPage 手拼一份、App.css `--font-mono` 另一份——手拼那份缺 `ui-monospace` 且重复 `'SF Mono'`，
  设置页选「SF Mono（macOS）」永远落 Menlo。现统一走 `terminalFontStack(族名, monoFallbackStack())`：
  族名排最前，其余取 App.css `--font-mono` 的 computed 值（`tests/terminal-font.test.ts` 逐字比对防漂移），
  设置页下拉清单也由 `TERMINAL_FONT_CHOICES` 单点供给。
  macOS 事实（13px，WKWebView 实测）：公开族名 `SF Mono` **不存在**（`SFNSMono.ttf` 的 family 是私有名
  `.SF NS Mono`），只有 CSS 关键字 `ui-monospace` 能拿到它（advance = narrow = 8.036）；`Menlo` 7.827；
  内嵌 JetBrains Mono webfont 7.8。**判定口径：窄字步进 == 宽字步进才算真拿到等宽字体**——族名不存在会
  静默回退成比例字体（实测 `"SF Mono"` 未装时 narrow 3.61 vs advance 10.11）；`document.fonts.check()`
  不可信（对不存在的族名也返回 true）。**Ghostty 空配置默认是 JetBrains Mono 13px**
  （`ghostty +show-face --string=Mesa` 实测解析即它），**不是 SF Mono**——要对齐 Ghostty 观感就选内置
  JetBrains Mono。
- **触控板滚动合帧（`src/terminal-wheel-scroll.ts`，2026-09-21）**：真正滚动的节点是 `.xterm-scrollable-element`
  及其子节点（实测 `term.element` 与 `.xterm-viewport` 命中数都是 0），所以 `attachCustomWheelEventHandler`
  拿到事件时位置已经写过了；必须在 `term.element` 上用 **capture 阶段** `preventDefault + stopPropagation`
  截住，累计到 `requestAnimationFrame` 才把合并后的 deltaY 用合成 `WheelEvent` 派回**原始深层 target**
  （不要缓存 `.xterm-rows` 子节点——DOM 渲染器每次重绘都重建它们，缓存目标会变成游离节点；派发期间
  `dispatching=true` 防自递归）。抖动来自「一帧内多次位置写入 + 多次 onScroll/滚动条更新」，不是重绘次数——
  实测 420 个事件（24px/个、3972 行可滚）：DOM 位置写入 240→143、WebGL 240→142（约 −40%），
  滚动距离 240→235 行（<3%），帧 p95 两者都 9–10ms、无长帧，渲染次数不变。
  决策纯函数 `shouldCoalesceTrackpadWheel`：备用屏（alternate buffer）／鼠标上报模式（mouseTrackingMode
  ≠ none）／任何修饰键／deltaMode ≠ 0／deltaX ≠ 0 一律放行不合帧（TUI 自身滚轮语义与横向滚动原样透传）。
  纯逻辑与假 DOM 时序断言在 `tests/terminal-wheel-scroll.test.ts`。
  **鼠标滚轮同一条重绘账**（2026-09-22）：一格通常只有一枚 wheel，合帧省不掉整屏
  `replaceChildren`。`src/terminal-row-reuse.ts` 在 DOM 渲染器上包住 `renderRows`：
  视口平移不到一整屏、且还留在屏幕上的行文字与缓冲区一致时，把现成行节点挪到新位置，
  只重画新进入的行。文字对不上、行数变了、平移超过一屏、或只是局部重画（光标行）
  则整屏/原范围重画，避免旧内容留在屏幕上。WebGL 没有逐行 DOM，探测不到行节点则空操作。
  `smoothScrollDuration` 仍为 0（Ink 整屏重绘叠平滑动画会闪），滚轮一格仍按行跳，
  去掉的是这一格的整屏重建。测试 `tests/terminal-row-reuse.test.ts`。
- **弱字亮度兜底 `minimumContrastRatio: 4.5`**（VS Code 终端同款默认值）：暗色主题下 brightBlack 灰字、
  dim 修饰文本对比度不足发暗，xterm 自动提亮不达标的颜色；只作用于显示，不改调色板定义。
- **运行中会话关联排他 + 复合键**：固定 session id 的 CLI 精确锁定；其余 CLI 启动前按 agent+归并后项目登记 claim，同批
  并发统一排序分配，已分配会话进程内不得转给另一标签；前端 live/open 一律以 agent+sessionId 为键，完整回放跳转前先刷新索引。

## 收件箱与注意力

- **精确注意力标记（hooks 桥接，七家）**：`session_tail_state` 对设置页已开启的 agent 优先读 hooks 事件日志
  （`<config>/ccode/hooks-state/<tag>-hooks.jsonl`，尾部窗口读取），日志缺失或超 10 分钟无更新回落尾部文本推断——
  TTL 与回落语义不变，消费侧（终端注意力点/运行中聚合/OS 通知/收件箱）零改动。事件映射：用户提交→working /
  轮次结束→done / 等待确认→confirm；各家原生事件名与 matcher 以 hooks.rs 的 BRIDGE_SPECS 为单一出处
  （调研结论录 matrix §12），日志解析兼容 snake_case/camelCase 双信封、事件名去下划线小写归一、
  grok Stop 只认 reason=end_turn（teardown 会以 shutdown/channel_closed 重发，跳过）、会话归属双键匹配
  （session_id==会话文件主名 或 transcript_path==完整路径）。支持 claude/qwen/codebuddy/gemini/kimi/grok/codex
  七家；cursor（无「等待确认」等价事件）与 opencode（无 shell hooks 形态）未接入。**两个生效条件**：codex 非托管
  hook 首次需在其 TUI /hooks 面板人工信任后才执行（按 hook 定义 hash 记信任，改命令失效需重审——不自动 bypass，
  安全优先，UI 备注引导）；codebuddy 启动时快照 hooks 配置，已运行的会话需重启后生效。
- **收件箱条目通用忽略（v3.88）**：`filterDismissed`/`dismissInboxItem`（inbox.ts）把原先只有 `help:`
  才有的屏蔽能力推广到全部类别。签名口径同 help——`text|actionLabel` 变化即视为新事件、旧忽略自动失效，
  所以「忽略」不会真的漏掉事情。生产端（WorkspacesPage）在写入 store 前过滤；应用更新条目由
  `visibleInboxItems` 现算合并后再滤一遍（换版本签名变，旧忽略自动失效）。
- **应用更新进收件箱（2026-09-04）**：有可用更新走 `update:` 类别（「更新」，排在依赖之后），动作「去安装」
  跳设置页更新分区。不造顶部横幅、侧栏不挂徽标。检查失败不得写成「未发现新版本」。开发预览不检查。
- **顶栏 = 全局上下文栏（v3.88）**：macOS 自绘标题栏从「只有收件箱胶囊」升级为
  左「当前项目 · 步骤」（`store.contextLabel`，WorkspacesPage 唯一写入方，只读消费不新增轮询）
  + 中「搜索与命令 ⌘K」+ 右「运行中计数 + 收件箱胶囊」。**与 v3.38 否决的「全局顶栏」不冲突**：
  那条否决的是新增垂直占用，而这条栏在 Overlay 模式下恒占 40px 且不可省（红绿灯靠 `pl-[78px]` 让位），
  这里是利用既有空间。`chromeHidden` 执行态下左中两段隐藏，只留让位与收件箱。
- **首页「待你处理」收件箱（v3.39；v3.42 起横跨项目导航与详情两栏之上；v3.59 起文档流单行 strip + macOS 收进自绘标题栏；v3.60 扩四类新来源）**：聚合工作区冲突/可合并
  + 终端注意力（仅待确认），排序 冲突 > 待确认 > 可合并 > 待核验 > 待发送 > 配置失效，为空整块不渲染；条目为可序列化 `InboxItem`（action 描述非闭包），
  由 WorkspacesPage 签名去抖镜像进 store（唯一写入方），点击统一走 `runInboxAction` 派发（review/tab/session/digest/artifacts/profiles 都走 store 一次性请求）。
  **v3.60 新来源（全部过「是否阻塞人的决策」闸）**：**产物待核验**（后端 `pending_artifact_checks`：活跃工作区绑定步骤的
  expectedArtifacts 全部产出且 mtime ≥ 工作区创建时间，可合并/冲突已覆盖的不重复报——产物多为 gitignore 的 *.pdf，git 状态看不见，
  不提醒就是黑洞；action `artifacts` → 选中项目 + 展开任务行产物清单）；**接力待发送**（digestJob ready 未消费）；**配置失效**
  （`profileIssues`：只镜像用户触发的三层验证/设为全局复检失败，验证通过或 profile 删除即摘除，**不新增后台网络轮询**）；
  **冲突升级文案**：`WsHealthDto.stale_base`（MERGE_HEAD ≠ 基准 tip，health_impl 内仅 merge 进行中多一次 rev-parse）命中时
  冲突条目改「基准已前进——需重新同步」，动作仍走 resolve-conflict（评审层自动以当前基准 tip 重备两侧）。
  **macOS：标题栏自绘（tauri.conf `titleBarStyle: Overlay` + `hiddenTitle`，capabilities 加 `core:window:allow-title` 与
  `core:window:allow-start-dragging`——缺后者 `data-tauri-drag-region` 拖拽静默失效），窗口标题不在界面渲染
  （用户拍板：纯拖拽区即可，标题字符串保留在配置里供自动化定位窗口），收件箱 =
  栏上的 Ghostty 式胶囊 + 下拉明细，页内 strip 不渲染；**chromeHidden 执行态下标题栏体仍必须保留**（窗口态 Overlay 红绿灯靠 `pl-[78px]` 让位；全屏收起三个按钮则取消让位，否则左边空一块。整条隐藏会丢胶囊），只省略底部分隔线**；Windows/Linux 保留原生标题栏 + 页内 strip（32px 一行，展开明细为悬浮下拉，
  遮罩/Esc 收起——整体悬浮 pill 遮挡内容被用户否决）。终端运行状态经 `terminalRunInputs` 镜像进 store 跨页
  只读（TerminalPage 唯一写入方，不新增轮询）；跳终端激活标签走一次性 `focusTabReq`（已关闭标签静默忽略）。
  **注意力信噪比总规则（v3.60，用户拍板全链路清理）**：「已回复」（done = 回合结束）**在全链路无任何视觉标记**——不进收件箱、标签/项目区
  工作区行不打点、OS 通知不发、`run-overview` 不占排序档，done 态仅剩会话尾部推断的内部状态；理由 = 每回合结束都会亮，噪音 > 信号
  （同 v3.59 步进器绿点否决）。同批口径：**纯状态不用语义色**（分组头「进行中/待评审」计数降灰点，仅「阻塞」用 err 色；项目导航行副行只留
  「M 个待处理」，活跃任务数删除）；**瞬态反馈自动消退**（「✓ 工作区已创建」横幅 10s 自收，setup 失败除外）；**常驻 pill 降裸字**
  （标签「可恢复」、启动栏「端口段已注入/上次任务」去底色去 link 蓝）；**无限脉冲禁留**（标签「工作中」与项目区同用有界
  `animate-pulse-brief`）；端口「N 个监听中」只在展开后显示；产物清单「刚更新」标记删除。新状态指示进界面前先过「是否阻塞人的决策」闸。
  **项目列表绿点只认此刻还在跑的 Agent**（2026-09-29）：`projectRailStatus` 看 `terminalRunInputs` 里 `running && !shell`、cwd 落在该课题根或工作树内；未归档工作区、回合结束、回落 shell 不亮。黄点仍是待处理，优先于绿点。
  **v3.59 起导航行「待处理」与收件箱同口径按项目摊开**：终端待确认与外部 live 待确认按 cwd 最长前缀归属项目根/
  工作树（`run-overview.ts attributeToProject` 纯逻辑，段边界防误中），收件箱给总数、导航行给分布。同批：收件箱条目数
  镜像进 store（`inboxCount`，WorkspacesPage 唯一写入方）。**侧栏不挂任何徽标**（终端运行数、工作区待处理全部取消，
  三平台统一——数字胶囊突兀、size-2 圆点与项目行状态点撞语义、9px 裸数字用户仍嫌吵，三轮均被否决；计数只在悬浮
  title 与 macOS 标题栏胶囊/页内 strip 出现）——收件箱仍为空不渲染，发现性由标题栏胶囊（mac）与页内 strip（Win/Linux）承担。

## 键盘流与分屏（v3.40/v3.41；v3.58 起页切逐页可自定义）

- ⌘K 命令面板（过滤纯逻辑在 `command-palette.ts`）、页切（顺序同侧栏；
  清单单一出处 `hotkeys.ts` PAGE_HOTKEY_DEFS，默认 mod+1..8，`hotkeyPages` map 按页覆盖、整组总开关 `hotkeyPageSwitch` 保留）、
  ⌘\ 执行态隐藏侧栏（`chromeHidden`，session 级）；⌘F 已被终端搜索占用。主题清单单一出处 `src/themes.ts`。绑定可自定义（设置页录制，
  `hotkeys.ts` 组合串，空串=禁用，settings.json 四字段；录制冲突判定对全部在用绑定互判）。通知动作 `ccode.attention` → 聚焦窗口 + 聚焦对应终端标签，
  无 extra 回首页收件箱；通知 extra 带 tabId/cwd（v3.60 起通知只有「待确认」一种，原「已回复直达评审覆盖层」链路随 done 通知一并移除）；
  收件箱经 `session_tail_state` 直查外部 live 会话（≤10 条）。
- **终端分屏（SplitView）只是显隐与排序变化**：全部标签仍在同一容器保持挂载，靠 flex order 把活跃标签（左）与对照标签
  （右）排到分隔条两侧，禁止把标签移进第二棵子树（会重挂载杀 PTY）；右栏/文件树/改动跟随「活跃 pane」（点击切换，
  focusedId），分屏时两个 pane 的 PTY 都推流；分屏状态不进持久化白名单，仅分隔比例本地记忆。
- **关标签/关窗进程守卫**：仅 `running && ptyId` 的 agent 标签弹确认（shell/已退出一律不弹），存活判定以后端
  `pty_has_running_process` 为准，命令不存在/报错时静默跳过不阻塞关闭；关窗前对全部在跑标签统一确认一次，确认后放行
  （allowWindowCloseRef 防 onCloseRequested 重入）。Tauri 的 `onCloseRequested` 前端封装最终调用 `window.destroy()`，且确认后
  会调用 `window.close()`；`src-tauri/capabilities/default.json` 必须同时保留 `core:window:allow-destroy` 与
  `core:window:allow-close`，否则进入终端页挂载监听后窗口无法关闭。

## 输入侧：图片粘贴 / 文件拖入 / 右键菜单 / 链接点击（2026-08-17）

- **九家 CLI 图片输入的通吃口径 = 绝对路径文本写进 PTY**（各家升级行为分两派，明细见 matrix §11）；
  macOS 直读剪贴板键是 Ctrl+V。机制明细：前端纯逻辑在 `src/terminal-input.ts`（`escapeShellPath`/`joinDroppedPaths`/
  `firstImageItem`/`imageExtFromMime`/反馈文案，tests/terminal-input.test.ts），落盘在 `src-tauri/src/clipboard.rs`。
- **paste 事件拦图片**：capture 阶段挂在 xterm 容器上，`clipboardData.items` 含 `image/*` 才
  preventDefault + stopPropagation（拦掉 xterm 默认文本粘贴），落盘后把**转义绝对路径**写 PTY（不补换行、
  不自动发送）；无图片一律不干预。终端未启动时提示「终端未启动，无法粘贴」，不落盘。
- **macOS Ctrl+V 透传**：`attachCustomKeyEventHandler` 里拦 `keydown + 仅 ctrl + v` → `pty_write("\x16")`，
  return false（网页侧 Ctrl+V 在 WKWebView 不产生 paste 事件也到不了 PTY；CLI 收到 \x16 自读系统剪贴板）。
  **Kitty 键盘协议（2026-10-10 首版，同日按规范修正，`src/terminal-protocols.ts`）**：输出流里的
  `CSI ? u` / `CSI > n u` / `CSI < n u` 由前端应答，只宣布 flags 5（消歧义 1 + 备用键 4），不宣布
  松开/重复（bit 2，Grok 实证：答应了发不出，Enter 会交两次）。**编码形态按 kitty 规范**
  （首版把无修饰功能键也编成 CSI-u 且用了 57417-57426 小键盘编号，gemini-cli 的映射表没有这段，
  方向键/Home/End/Insert/Delete/PageUp/Down 全部打私用区乱码——复核实证后修正）：
  无修饰功能键一律保持 xterm 传统序列，**只有 Esc 改写 `CSI 27u`**（消歧义档的本意）；
  带修饰的方向/Home/End 用 `CSI 1;mod A-H/F` 字母形、PageUp/Down/Insert/Delete 用 `CSI 5/6/2/3;mod ~`；
  带修饰的 Enter/Tab/Backspace 走 CSI-u（kimi 的 Enter 特判兜底在宿主键盘路径，协议未推时也生效）；
  Ctrl/Alt/Cmd+可打印字符走 CSI-u，纯 Shift 可打印留给 xterm/输入法。弹栈认带层数形式
  （`CSI < 1 u`，crossterm/grok 实发）；push 省略 flags 按 0（= 恢复传统）；进程退出即解除 armed
  （TUI 崩溃没弹栈也不能让 shell 的 Ctrl+C 变垃圾）。不把 `TERM_PROGRAM` 改成 Ghostty 或 Kitty。
  **启动查询应答**：DA1 回 `CSI ?1;2c`（kimi 哨兵）；XTVERSION 两种问法（`CSI > q` 裸式为 gemini/qwen
  实发形式、`CSI > 0 q`）统一回 DCS `>|Mesa (xterm.js 6.0.0) ST`——带上 xterm.js 字样是如实自述，
  OpenCode 的超链接能力表明确收录 "xterm.js"（同日调研实证，靠它启用 OSC 8/OSC 52）；
  XTGETTCAP（`DCS + q`）问到 Ms（4d73）时回 terminfo Ms 能力值，OpenCode 据此开 OSC 52 剪贴板。
  **OSC 8 / OSC 52 / 贴图**：OSC 8 只打开 http(s) 与 mailto（URL 含换行不认）。OSC 52 从输出抽走，
  base64 上限约 256KB，写入系统剪贴板。Kitty 图形（`ESC _ G`）拆出右下角预览：MIME 按文件头判定
  （PNG/JPEG/GIF/WEBP，RIFF 四字符不是 WEBP 的不算）、支持 m=1 分块拼装（>4KB 的图 kitty 客户端
  惯例分块，续块只带 m/q 键）、新进程/重置清掉、可手动关。Sixel 不解码：DCS 由 xterm 自己静默吞掉
  （Mesa 不另写剥离逻辑）。Grok / Codex 按终端身份决定发不发贴图，序列没来就没有预览。
  **路径、通知、回放（2026-10-10，2026-10-11 复核修正）**：绝对/相对路径（可带 `:行` 或 `:行:列`）可点，
  进右侧预览并滚到该行（cwd 之外的路径 root 传文件所在目录，不中「超出项目根」守卫）；链接坐标
  **逐格自算**「字符→单元格列号」（getNullCell 复用格 + getWidth/getChars——src 版 translateToString
  的 outColumns 参数在 6.0.0 编译产物里不存在，靠它曾整体失效）；中文/emoji 宽字符占 2 格，字符串
  下标当列号会整体错位；句尾标点不吞进路径；边界集含中文弯引号与《「『开括号、全角冒号；候选正则的
  **零宽匹配保护必须在循环体第一行**——行首是空格/引号/分号/全角标点的缩进行曾原地死循环冻结
  整窗（P0，回归锚在 tests/terminal-links.test.ts）。
  OSC 9 / 777 抽出标题发系统通知：**OSC 9;4 是 ConEmu 进度序列不是通知**（kimi 每秒发、grok/codebuddy
  每轮发，当通知会刷屏；畸形形态同吞），静默吞掉、进度值经 `parseOsc9Progress` 直通标签徽章
  （state 1 带百分比、2 错误显 !、3/4 显 …、0 清除；进程退出/重启即清）；OSC 777 只认 `notify;title;body`
  三段式（currentdirectory 等其他子命令静默）；claude-code 的通知通道是 **BEL**（不发 OSC 9/777），
  `term.onBell` 只对 agent PTY 转 notice。通知走与注意力通知同一套门：设置开关、前台当前标签不打扰、
  按标签限频；序列断帧走与贴图/OSC 52 同一条 pending 管线（半截判定锚定帧尾——帧尾**完整**的短序列
  不得扣住，kimi 的 8 字符进度帧曾因此卡死终点）。**后台标签**：正文进 backlog，但含 OSC 9/777/BEL
  的帧由 Rust `gated_emit` 带外照发 `pty-signal-<id>`，前端只喂通知/进度解析不写画面——通知与进度
  徽章的主场景就是后台标签，等切回补发就废了；补发重复由限频/幂等消化。
  **粘贴**：右键粘贴出口在子进程开了 bracketed paste（DECSET 2004，claude 常开）时包
  `\x1b[200~…\x1b[201~` 标记，让「大段粘贴确认」生效、多行粘贴不被逐行当回车。
  **粘贴防线与文件粘贴（2026-10-10 二批，`src/paste-guard.ts`）**：所有粘贴出口统一走
  `handleTerminalTextPaste`——普通缓冲一律剪收尾回车（防「粘贴即执行」）；shell 标签的
  多行粘贴先经确认框（agent 标签不拦，TUI 自己消化）；备用屏原样写入。Cmd+V 的 paste
  事件在 capture 阶段整体接管（图/文本/文件三分发）：无文本无图时探原生剪贴板
  （`read_clipboard_files`：mac NSPasteboard / win CF_HDROP / linux 空回落），Finder/资源管理器
  复制的文件粘贴成引号路径（复用 joinDroppedPaths 的 escapeShellPath）。
  **相对路径链接（同日）**：terminal-links 认带 `/` 的相对候选（`~/`、`./`、`../` 前缀，
  或带 `:行号` 或扩展名），点击时经 `terminal_link_target`（pty.rs）按标签 cwd 拼 + `~` 展开
  + canonicalize 存在性校验后打开，误报词点了提示「没找到」；一次点击一次 stat，不做整屏校验。
  **查找升级（同日）**：搜索条加正则/全词/大小写三开关 + 命中计数（`onDidChangeResults`），
  输入 250ms 防抖增量高亮（`incremental: true`）；非法正则即时提示不当掉搜索。
  **标签进度（同日）**：OSC 9;4 进度不再只是吞掉——`parseOsc9Progress` 解出后经
  `onProgress` 直通标签条徽章（state 1 带百分比，其余算「…」，state 0 清除；进程退出即清）。
  **崩溃收口（同日，2026-10-11 修正口径）**：横幅只认 `code > 0`——负数（-1 等）是
  pty_kill/丢弃/等待超时共用的「原因未知」哨兵（exit-code.ts），手动「停止」正是走它，
  `code≠0` 会把每次停止都误报成崩溃；横幅写在 `term.write` 的回调里再快照（同步快照读不到
  异步解析中的字节）。死因随画面持久，弹窗一关就丢的问题不再。
  **渲染与尺寸**：Windows 声明 `windowsPty: conpty`（portable-pty 即现代 ConPTY，满宽行
  回绕补偿）；WebGL 上下文丢失不再永久退 DOM——窗口聚焦/可见时预算重试 ≤3 次（带
  「已加载且健康」守卫与软件渲染探针缓存，否则每次聚焦都重建 renderer 新开上下文）；resize/容器
  变化统一 rAF 合帧 + trailing（拖分屏把手不再每次事件全量重排）。
  **「本次」浮层带配置指纹**：网关名（id 是 uuid 读不出）· 密钥尾号 · 附加变量名（值不显示）——
  托盘切了全局默认后，跑着的终端吃的哪碗饭在这里可见。
  **粘贴去重与键位**：writePtyPaste 同内容 80ms 去重（mac ⌘V 键盘路径与原生 paste 事件
  可能各到一次）；armed 分支对 Ctrl/⌘+V 只放行不编码（否则 CSI-u 与粘贴文本双发）。
  **Unicode11**：addon 注册后必须显式 `term.unicode.activeVersion = "11"` 才激活（首版漏了，
  宽度表一直是 Unicode 6——2026-10-10 核查发现并修正）。
  **回放**：快照式存档，存点 = 进程退出时 + 页面隐藏（pagehide/visibilitychange）+ **30 秒周期快照** +
  Rust 侧关窗拦截（`mesa:flush-before-close` 事件，lib.rs `FLUSH_CLOSE`——2026-10-11 实机探针实证
  前端 `onCloseRequested` 在红绿灯关窗时不执行，连既有 agent 关窗确认守卫也是死代码；周期快照兜住
  任何死亡方式）；**不在卸载时存**（应用退出不触发卸载，首版因此整条链路失效）。
  全屏 TUI 挂在备用屏时普通缓冲往往是空屏，改拍备用屏可视行（claude 整场在 1049）。关标签即 drop；
  启动恢复完成后 `prune_terminal_replays` 只留当前标签集合，清崩溃残留。全屏 TUI 不另画滚动条：
  它接管滚轮后，xterm 自带滑块不显示。
  **kimi 特判发 CSI-u `\x1b[118;5u`**（kitty 协议，v=118 + ctrl 修饰位 5，与同函数 Enter→`\x1b[13u` 同模式，
  **待实机验证**）。非 mac 不拦：Windows 各家贴图用 Alt+V（本就透传为 ESC+v），Ctrl+V 保留文本粘贴语义。
  **Codex/Cursor Shift+Enter 换行**：xterm.js 对 Shift+Enter 仍发 `\r`，被 TUI 当成发送。宿主拦 shift+Enter
  （keydown/keypress）改写为 kitty CSI-u `\x1b[13;2u`（Codex composer 与 Cursor 的解析器都认这个形式，
  两家都不查询/推送 kitty 协议，走未 arm 的旧改写路径），并吞掉随后 80ms 内 onData 的 `\r`（空输入时 Codex 不提交，
  看起来像换行；有内容时这记 `\r` 会直接发送）。不点亮「生成中」。
  **claude-code Shift+Enter 换行（2026-10-10 补）**：claude 官方 terminal-setup 给别家终端装的正是
  `ESC+CR`（Alacritty 键位表 `chars="\u001B\r"` / iTerm2 映射同款），它从不 push kitty 协议——
  改写为 `\x1b\r`（`CLAUDE_SHIFT_ENTER`），同挂点同吞 `\r` 哨兵。Ctrl+J（0x0A）本就可用。
  **Shift+标点丢字**：xterm 的 keydown 只发送 `keyCode ≥ 48` 的单个字符。WKWebView 上 Shift+`/`
  实测报 **229**（不是 191），这一下 xterm 走 composition 的 `setTimeout(…, 0)` 分支、读到的
  textarea 还没被 `input` 事件写长 → 不发 → 第一下丢字，再按一下才出来。`printableKeyFallback`：
  keyCode 0 当场补发 `e.key`。keyCode 229 且按着 Shift 时，按物理键补美式键盘
  的那个符号（Digit1→`!`、Digit3→`#`、Slash→`?` 等）：中文输入法下 `key` 常是
  `"Process"`，只认 Slash 会让 Shift+1 没反应，Shift+3 则第一下靠 xterm、第二下组词
  收尾再写一遍变成 `##`。补发后 `return false` 拦住 xterm，回声按次数吞
  （`armPrintableEcho` / `takePrintableEcho`，400ms）。汉字上屏的 `code` 不在这张表，不补。
  带 Ctrl/Alt/⌘ 不补。正常 keyCode（≥48）不补，避免和 xterm 各写一次。
  **⌘V**：Mac 上先读剪贴板。有图片就走落盘路径，没有再当文本粘贴。Ctrl+V 仍是 `\x16`，让 CLI 自己读系统剪贴板。
- **文件拖入转路径**：`getCurrentWebviewWindow().onDragDropEvent`（HumanTasksList 同款），只处理 `drop` 且
  坐标命中本终端容器 rect（devicePixelRatio 两口径都试）；隐藏标签 rect 全 0 天然不响应；**只在自己 rect 内响应，
  不 return 掉人工事项导入等其它监听**（按坐标域区分共存）。多路径 shell 转义后空格拼接，不换行防误执行。
- **右键菜单**：容器 `onContextMenu` → 复用 `ContextMenu` 组件（复制按打开时选区裁剪 / 粘贴先试
  `navigator.clipboard.read()` 找图片、回落 readText / 全选 / 清屏 / 查找输出）。**链接点击** =
  `@xterm/addon-web-links`（0.12.0 配 xterm 6），点击 handler 走 `@tauri-apps/plugin-opener` 的 `openUrl`
  （capabilities 已有 `opener:default`，与技能页同源，不另引入机制）。
- **查找输出（⌘F / 标签栏 `Search`）**：`@xterm/addon-search` 盖在画面上，↑↓ 或 Enter/Shift+Enter 走
  `findNext`/`findPrevious`（单行输入框里 ↑ 没有编辑语义，拿来做上一条匹配）。**备用屏没有回滚缓冲**
  （`buffer.hasScrollback === false` → `viewportY`/`baseY` 恒 0）：查找范围只剩当前一屏，↑↓ 只在屏内打转。
  此时搜索条出一行提示说明缘由（由 `buffer.onBufferChange` 驱动，开关搜索条时按 `buffer.active.type`
  补一次初始值——订阅只在翻转时触发，已经身处全屏程序里时看不到事件）。这是终端语义不是缺陷：真要在
  TUI 里搜历史得在宿主机侧另存 PTY 原始输出，未做。
- **临时图片生命周期**：`save_clipboard_image(bytes, ext)` 落 `<config>/ccode/tmp/paste-<时间戳>-<随机>.<ext>`
  （ext 白名单 png/jpg/jpeg/gif/webp，非法归 png；上限 50MB），每次调用顺带清理 7 天前 `paste-*`；**不加
  arboard 依赖**（读剪贴板在前端 paste 事件完成，Rust 只收字节）。

## 沉浸阅读区（v3.96；批次 B1/B2/B3）

- **覆盖层形态**：`ReaderOverlay` 挂在终端页内（`fixed inset-0 z-40` 页面模态档，与评审覆盖层同思路），
  三栏「笔记｜PDF｜Agent 终端」，**不要底部终端**（用户拍板）；底下终端/PTY/右栏全程保持挂载，退出即回原样。
  覆盖层会盖住 App 自绘标题栏，**覆盖层自带顶栏必须自担两件事**：可拖动 + macOS 红绿灯让位（窗口态 `pl-[78px]`，全屏取消）
  （口径同 App.tsx 顶栏）。拖拽用**手动 `startDragging`**（mousedown 落在按钮/链接等交互元素上才放行）——
  `data-tauri-drag-region` 属性版只认落点元素本尊，顶栏几乎全被子元素占满，实测拖不动（v3.99 教训）。
  任何 inset-0 覆盖层同理，漏了就是按钮重合 + 窗口拖不动。
  分隔条拖拽记宽度（localStorage `ccode.readerSplitL/R`，钳制与像素换算在 `src/reader.ts`），左右栏可收起；
  右栏内「翻译面板 × 终端」的底缘横分割条同样可拖记高度（`ccode.readerSplitT`，% 右栏总高、12–70 钳制，
  未拖过 = 内容自适应 40% 封顶不落键，双击复位自适应；拖拽为增量式——自适应态起点取当前渲染高度占比，不跳变）；
  右栏底部还有终端状态栏——TerminalStatusBar 节点随 xterm 宿主一并 DOM 搬移（`data-statusbar-host` 标记，
  槽位缺席时留在原 pane，两槽位挂载时机不同步故 host/bar 独立判定）。
  **建档配对（v3.99）**：`ensure_paper_note` 建档前先扫 notes/*.md 头部的「来源行」（lit-notes 的
  `> 来源 PDF：<相对路径>` 或建档模板的 `> 来源：<path> · 开始阅读`）——命中即打开该笔记不另建 slug 笔记，
  此前误建的空模板 slug 笔记顺带清进回收站；反向 `pair_pdf_at` 同样来源行优先、标题互相包含兜底。
  v1 单窗全屏，结构上预留 v2 独立弹窗能力（未做）。入口三处统一走 store 一次性请求
  `readerReq: { pdfPath, projectRoot }`：PDF 预览工具条「⛶ 沉浸阅读」、文献雷达精读清单「开读」、文件树 PDF 右键。
  **未归属项目**：`pdf_owner_project` 未命中时，询问是否把 PDF 所在文件夹（若在当前终端目录内则用该目录）
  添加为项目并 `pipeline_opt_out`，随后直接进阅读区；家目录/盘符根拒绝。无研究流程时「整理为笔记」
  写项目根 `notes/inbox.md`，不要求 lit-notes 步骤。
- **指定笔记入口（v3.98，精读笔记产物）**：`readerReq`/阅读区 state 增加可选 `notePath`——`notePath` 非空时
  ReaderOverlay **跳过 ensure_paper_note 建档**、笔记栏直接编辑这份 md（否则会按 PDF slug 再建一份模板笔记，
  与 lit-notes 的 `<序号-短标题>.md` 并存打架）。md 入口三处：产物核验清单 md 就地预览弹层「⛶ 沉浸阅读」、
  终端页文件树 md 右键、终端页 md 预览工具条「⛶ 沉浸阅读」（read 态；缺省仍是 FilePreviewEditor 自带单栏沉浸层）。
  三处统一走 `reader_for_note`（reader.rs）一次给齐归属项目根 + 配对 PDF + 实际笔记路径：归属反查 = 注册项目根
  canonical 前缀直含 → 工作区 worktree 包含则映射主仓副本（主仓还没有 = 未合并，明确报错「评审合并后再进」）；
  配对 = 笔记 stem 与 project.toml `type="paper"` 资源的文件 stem 做 `normalize_title`（lit_watch.rs，已提
  pub(crate) 复用）**互相包含**（与前端 lit-watch.ts `paperResourceFor` 同口径），多命中取规范化最长者，
  无命中报错透出。另有根已知的变体 `pdf_for_note`（返回 Option，供已知 projectRoot 的调用方）。
- **右栏 = 阅读会话标签的 xterm 终端画面**（2026-08-18 用户拍板：右栏从结构化对话视图改为真实终端，
  用户看着终端直接敲）：TerminalPage 用 `useLayoutEffect` 把该标签的 xterm 宿主节点（TerminalView 容器 div，
  `data-terminal-host=<tabId>`）appendChild 进覆盖层右栏槽位（槽位经回调 ref + state 上报，右栏收起槽位卸载时
  自动回搬），关闭时插回原槽位最前——FilePreviewEditor 的 Monaco 宿主移动同款先例，PTY/xterm/scrollback
  不重建不丢；容器上既有 ResizeObserver 在尺寸变化时自动 fit，无需额外触发。阅读区打开时该标签被提到活跃。
  没有独立的对话视图与输入框：「◈ 问 AI」/圈选截图注入仍写该标签 PTY（`injectToReader`），文字出现在终端
  输入行里正好可见。无配置引导卡、标签被关的「重新启动会话」卡片行为保留。标签的 ⌘F 搜索条与粘贴反馈小条
  留在终端页原区域（阅读区里看不见，退出后可用）。**同日拍板：不做扩展性功能，只做场景必需**——快捷 chips
  （图导游/总结这页/帮我改笔记）与「✦ 工具」页签（译历史/生词本表格/大纲三段）砍掉待需求，
  `ReaderToolsPanel` 已删；⌘+点击段落对照的结果改在点击位置旁的选区同款浮卡呈现（可保存译段）。
- **Esc 级联阅读区最优先**：阅读区自己的 keydown 监听带 `isComposing` 守卫（中文输入法组词中按 Esc 是取消候选）；
  TerminalPage 的专注/右栏全宽 Esc 在阅读区打开期间直接放行不拦（`if (reader) return`）；圈选模式内的 Esc 用
  capture 相 + stopPropagation 抢在关阅读区之前（先退圈选，再退阅读区）。**焦点在右栏 xterm 里时 Esc 被 xterm
  就地消化（打断生成/vim），不冒泡、不关阅读区**（与终端页专注模式同一口径）——此时退出用「← 返回」或先点别处再 Esc。
- **⌘E 翻转笔记栏阅读/编辑**（组合串 `READER_MODE_HOTKEY` 在 hotkeys.ts，mod = ⌘/Ctrl）：ReaderOverlay
  全局 keydown 命中后经 `modeTick` 信号递进通知 FilePreviewEditor（tick/signal 先例：readerAgentTick），
  变化即翻转、初挂载不动作；**焦点在右栏 xterm 时不拦**（`rightColRef.contains(e.target)` 判定，
  Ctrl+E 是 readline 行尾——与 Esc 级联「键归终端」同语义）。切换按钮 title 只在接线（modeTick 存在）时
  才带快捷键提示。
- **保存译段/插入笔记的反馈口径**：成功 = 浮卡按钮变 ✓ + ReaderOverlay 右下角 toast + 笔记栏 watcher 自动
  回显；**唯一不回显的场景是笔记栏停在编辑态且有未保存改动**（dirty 时 watcher 停订）——此时 toast 必须
  明说「笔记栏有未保存改动，保存后可见」（dirty 状态经 FilePreviewEditor `onDirtyChange` 上报 ReaderOverlay，
  文案口径纯函数 `translationSavedToast` 在 reader.ts，tests/reader.test.ts 锚定）；失败一律 loud
  （PDF 栏顶部 hint 条 + toast ✗）。
- **Agent 上下文简报**：note 就绪且 `agentStatus.running` 为真时，ReaderOverlay 自动向阅读会话**直发**一行
  简报（「【阅读上下文】在读 PDF：<pdfPath>；配套笔记：<note.path>…」），按 note.path 去重一次性
  （换 PDF 后 note.path 变 → 重新简报；发送失败不标记，下次 running 跃迁重试）。已知竞态：send=true 会把
  用户输入行未发完的文字一起带出，running 守门后窗口极小，接受（注释在 ReaderOverlay 同效应处）。
- **注入单一内核 `injectToTab(tabId, data, send)`**：原 `injectToActiveAgent` 抽成按 tabId 的共用内核，
  右栏选段（活跃标签）与阅读区注入（阅读会话标签）走同一条链路，行为口径不变（缺省不自动回车、`send=true`
  一次拼接 `\r`）；选段「◈ 问 AI」/「↵ 直接发送」/圈选「发给 agent」全部经此。
- **阅读会话 reuseKey 口径**：进入阅读区自动起一个阅读会话标签（项目根 + 默认配置 + autoStart，快速开聊同款
  机制），`reuseKey = reader:<projectRoot>`（`src/reader.ts readerReuseKey` 单一出处）——退出再进找回同一标签
  接着聊；恢复出的占位标签不带 reuseKey 不参与复用；用户手动关掉标签后不连环重建（一次性标记，栏内给
  「重新启动」入口）；无可用配置时右栏给引导卡跳配置页，不自动起会话。
- **圈选截图两个去向**（裁好的 PNG 由 PdfContinuousView 交来）：「◈ 发给 agent」= 走 `save_clipboard_image`
  落**临时图**（终端粘贴图片同一命令/口径），路径 + 预填 prompt 写进终端输入行**不自动发送**（图是临时产物，
  不进项目目录）；「＋ 插入笔记」= 走 `save_reader_capture` 落 `notes/assets/`（PNG 魔数校验 + 同秒重名 -2/-3）
  并 `append_note_image` 追加进笔记「## 我的想法」小节（笔记栏经 watcher 自动刷新可见）。
- **md 阅读版式图片与相对链接后处理**（批次 B2，FilePreviewEditor；v3.160 / v3.161）：渲染前把待加载
  `<img>` 换成带 `data-md-src` 的 `md-img-pending` 占位 span——不能留无 src 的 img（WKWebView 会画问号裂图），
  也不能把相对路径或 `/Users/...` 绝对路径留在 src 上（会被当成 `localhost` 地址 404）。本地 png/jpg/gif/webp/svg
  经 `read_image_bytes`（白名单 + 魔数校验，20MB）转 data URL；marked 对中文路径的百分号编码由
  `mdImageAbsPath` / `stripMdHrefSuffix` 解码。**本机打开的 md 允许显示 https 图**（README
  徽章/演示 gif）；`http://` 仍不加载。聊天消息里的 md 仍不加载外链图。相对链接在阅读区笔记栏
  **原地打开** + 顶栏「← 回笔记」退回。
  **文件树点开图片**（v3.161）：png/jpg/gif/webp/svg 走 `ImagePreview`，与 md 内嵌图同一 `read_image_bytes`
  通道，不进文本预览的 NUL 二进制拒绝。
  图片水合每次 layout 都扫剩余 `[data-md-src]`（`hydrateMdImages`）：父级重绘若把
  `dangerouslySetInnerHTML` 盖回占位、而 html deps 没变，旧 effect 不重跑就会永远停在「图片加载中」。
  一进来先摘属性防重复读取；本地图结果缓存 32 张，盖回后同步换上。`renderMathInto`（md-math.ts）
  在 await 前快照 TeX 源码，重跑幂等。
  **编辑→阅读同步（同日修复）**：编辑期间 `text` 状态不随键入更新（dirty 时 watcher 停订、保存又只动
  lastSavedRef），直接切回阅读会停在旧盘稿（删除/新增都看不见）——`switchMode("read")` 时把
  `editorRef.getValue()`（含未保存改动）setText 进去，阅读态 = 当前缓冲的预览；反向不走这条路
  （external-reload effect 遇模型相同自行跳过）。
- **笔记编辑态粘贴图片**：项目内 md（有 projectRoot 语境）落 `notes/assets/` 并在光标处插 `![](相对路径)`；
  非项目内文件回落临时图路径文本（终端粘贴同口径），不混用两条通道。
- **术语淡高亮实现约束**：textLayer 落地后对**文本节点**跑整词匹配（`findGlossaryMatches`，大小写不敏感），
  命中处包 `<span class="ccode-gloss">`（点状下划线；悬停释义由 PdfContinuousView 事件代理命中 `.ccode-gloss`
  出 HoverTip，禁原生 title）；cleanup 先还原旧高亮再重包（`replaceWith(childNodes)` + `normalize()`），
  幂等可重入——**不得破坏 textLayer 文档流**（选区/复制行为不能变）。护眼反色只反 canvas 层
  （CSS filter，不动 canvas 数据），进度/护眼均按文件记忆（localStorage `ccode.readerProgress.`/`ccode.readerDark.`）。
- **生词本/译段落盘契约**：`notes/glossary.md` 表格（`| 术语 | 释义 | 出处 |`）是机管文件，表外内容保留；
  格式契约与 `src/reader.ts` 双端镜像（前端不直接写文件，那组函数是格式的单一可读规格 + 测试锚点，
  改动需同步）；翻译结果 v2 起直接进顶部翻译面板（在途骨架/失败重试同承载，选区旁浮卡已取消），
  「存进笔记」才经 `append_note_translation` 写进笔记「## 译段」小节（✓ = 历史条目的持久 saved 标记）。
- **翻译面板（右栏终端上方）+ 历史抽屉（v2 结构定稿）**：翻译默认**不进笔记**——选段浮动条「译」/
  ⌘+点击段落只负责触发（PdfContinuousView 的 `onTranslate` 回调上送原文+页码），状态机与面板全部在
  ReaderOverlay（`runTranslate`：`tlPending` 在途态 → 纯文本翻译 → 成功入历史；× 时递增 `tlReqRef`
  作废在途结果）。面板 = 独立组件 `ReaderTranslatePanel`（右栏状态行之下、xterm/引导卡之上，占布局流；
  右栏整体收起随终端一起不见；无 agent 标签的引导卡/重启分支照常可用——历史/存进笔记不依赖会话）。
  **块级对照（唯一形态，无对照开关）**：原文整段弱色小字（text-xs/l4）在上、译文整段正文（text-sm/leading-6）
  在下，两块均 `text-justify` 两端对齐、间距 mt-1；表头「原文」开关控制原文块显隐（默认显示）。
  **原文/译文渲染与「存进笔记」前都先过 `reflowBlockText`**（reader.ts 纯函数：PDF 文本层的硬换行与
  断词是排版产物——`-\n` 断词接回、段内单换行英文转空格/中文直连、连续空行压成单换行、行首尾 trim；
  原文按 `{cjk:false}`、译文按 `{cjk:true}` 口径；抽屉两行摘要同样过）。封顶 40% 栏高、
  超出内部滚动（% max-h 挂栏根 flex 子级才解析定高；拖过底缘分割条后改显式 % 高，
  仅正文展开时套用，chevron/× 收起回归自适应）。chevron 只折正文留表头
  （组件内 state 不持久化、新翻译自动展开）；× = 面板整体消失本轮不再弹出（记当前显示条 at），收起态留
  一行动作条让「历史 N」抽屉随时可开。**历史抽屉点行 = 载入主面板**（`viewingAt` 按条目 at 标识当前
  显示条，不碰 latest 语义；新翻译进来自动回最新）；行内只留译文摘要（两行 clamp，第 N 页/相对时间已
  拿掉）+「存进笔记」收到摘要下方（动作不占正文宽度）；「复制」挪到主面板表头小图标钮（复制当前显示条
  的纯译文）。在途提示 = ◌ animate-spin +「正在翻译…」。**bilingual 逐句对照
  prompt 已下线**（原文整段由条目 original 字段承担）：`buildReaderTranslatePrompt` 回到单参纯文本；
  `parseBilingual`/`plainFromBilingual` 保留为**旧条目兼容 shim**（bilingual 期存的带标记 raw 在渲染/
  复制/存进笔记时转纯译文，新条目永不命中），测试保留。「存进笔记」走 saveTranslation 既有链路
  （toast/dirty 口径不变），存后条目标记持久 saved。数据源 localStorage `ccode.readerTlHistory:<pdfPath>`
  （键不变），封顶 50 先进先出，同原文重翻 = 替换置顶且保留已存标记；纯逻辑在 reader.ts，
  tests/reader.test.ts 锚定；写盘在 setState updater 里（StrictMode 双跑写同内容，幂等）。
  **生词卡是带输入框的表单，浮卡保留**；其释义预填走 `onRequestTranslate` 纯文本 + 独立 `glossReqRef`。
- **PDF 选区高亮 = pdf.js v6 DrawLayer 自绘**（v3.99 修正，PdfPageView）：原生 `::selection` 在 scaleX 变换的
  textLayer 文本片上溢出/错位，官方 viewer 因此默认 `enableSelectionRendering`——textLayer 挂
  `selectionRendering` 类（pdf_viewer.css 把原生高亮透明化），`pdfjs.DrawLayer`（`pageIndex` + textLayer 元素，
  `setParent(页宿主)`，cleanup 必须 `destroy()`）按 selectionchange 把选区画成整页 div + SVG clip-path 贴字形；
  该 div 的样式在 pdf_viewer.css 里 scoped 于 `.pdfViewer .canvasWrapper`，我们 DOM 没有这两个类，App.css
  照抄一份 `[data-page-num] > .selection`。**WebKit 还有个坑（同日实测修复）**：`range.getClientRects()` 对同一行
  会返回 span 边框盒（高 = line-height）与字形 A+D 内容盒两个错位矩形，DrawLayer 取并集 → 高亮比字形胖一截
  压住邻行（Chrome 只返回一个，官方 viewer 无感）；App.css 给 `.textLayer span` 设 `line-height: normal`
  （边框盒 = 字体自身 A+D，与内容盒重合，并集收敛成单盒，WKWebView 探针实测验证）——span 均绝对定位且
  文字透明，此改动只影响选区几何。另对齐 viewer 两件套：textLayer 渲染完追加 `endOfContent` 页尾捕手
  + mousedown 挂 `selecting` 类（拖过末行仍能扩到页尾；DrawLayer 的 MutationObserver 也靠它感知重渲染重算选区）；
  `--total-scale-factor` 取 `viewport.scale × viewport.userUnit`（官方 = scale-factor × user-unit，userUnit≠1
  的 PDF 才不等价于名义倍率）。**缩放/圈选控件是 PDF 栏顶部常驻细工具条**（Zotero 式：图标钮 28px 热区 +
  页码居中 grid 三列 + ▦ 圈选右置）——不再是滚动层内 sticky 浮块（实测挡正文与圈选画面）；
  **三栏顶条统一 h-8 + 底部 hairline**（FilePreviewEditor 工具条同步改成这个规格，栏间才严丝合缝）；
  圈选 Esc/手势语义不变。
  **阅读中缩放不必点顶栏**（v3.205）：⌘/Ctrl+滚轮与触控板双指捏合对准指针改倍率，范围 0.25–4。
  未按修饰键的滚轮仍翻页。**鼠标平移 = 中键拖动**（pointerdown 拦 WebView2 中键自动滚动，
  左键永远留给文本选择；Shift+滚轮横向走 WebView 原生，不另接）。顶栏「适配宽度」退出手势缩放、回到跟随栏宽。**普通单页预览
  （PdfPreview）与连续滚动同一套**（2026-09-04 重设计）：绑定共享在
  `src/components/use-pdf-zoom.ts`（usePdfGestureZoom），宿主只供滚动层 ref + 布局倍率 +
  onCommit。**机制对齐官方 pdf.js viewer（Firefox 阅读器 drawingDelay/prevCanvas 同款），
  不做整层 CSS transform 跟手**（巨型 layer 逐帧重栅格化 + 手写 scroll 补偿浮点累积 =
  晃动源，已否决）：① 倍率输入立即提交 React，页盒按布局倍率即时重排（纯 div 尺寸，
  便宜）；② canvas/textLayer 按 renderScale 停稳 ~120ms 才重绘（PdfPageView 双倍率拆分：
  scale=布局 / renderScale=渲染），期间旧位图 CSS 拉伸跟手、textLayer 暂时隐藏（旧坐标
  已错位），定格时布局零变化只换清晰位图——不闪不跳；③ 锚点用实测不用公式：输入时记
  「指针落在哪个页盒（anchorSelector）的哪个相对位置 + 指针视口坐标」，重排后量出该点
  新位置修正 scroll——页间分隔行/padding/水平居中/取整误差都不随倍率缩放，纯公式换算
  必错位（已踩）；React 批处理连发时锚点按目标倍率链式沿用。钳制到顶/底后不记锚点
  （防滞留误跳）。④ pinch 双路事件防叠倍：
  pinchActive 挡 gesture 期间的 ctrl+wheel，gestureend 后 300ms 冷却
  （`PDF_GESTURE_WHEEL_COOLDOWN_MS`）挡惯性尾随。滚轮连续指数
  （`PDF_WHEEL_ZOOM_HALVE_PX`）。`wheel`/`gesture*` 均 `{passive:false, capture:true}`。
  PdfPreview 的「回到顶部」只在翻页时触发（scale 不得进 deps）。
  **宿主约束（2026-09-04 弹层黑屏/错位实证）**：PdfContinuousView 只准放进有界 flex 容器
  （`flex min-h-0 flex-1 flex-col` + 外层 `overflow-hidden`），**禁用 `overflow-auto` 包裹**——
  双层滚动会让内层滚动容器撑到整篇文档高度、自身永不滚动：缩放锚点修正写进不滚的容器 =
  错位，整篇超高内容还会触发 WKWebView 瓦片黑屏（OfficePreviewModal 曾踩，pdf 与 xlsx
  同口径处理）。锚点命中快路径 `elementFromPoint`，页间缝隙才回落最近页盒扫描。
  **窄宿主限深**：`maxFitMultiplier` prop（缩放上限 = 适配倍率 × 倍数，纯函数 `pdfZoomCap`，
  手势与顶栏按钮同一钳制）——OfficePreviewModal 传 1.5（页宽 ≈ 1.5× 弹层宽，深阅读引导去
  沉浸阅读区）；阅读区/终端右栏不传，维持全局 4×。
  **高倍缩放不得撑爆画布**：`pdfCanvasOutputScale` 夹到 4096² / 单边 8192。
- **PDF 画布不得在深色 color-scheme 下走不透明 2d**（v3.154，Windows WebView2 实测白屏）：pdf.js 默认
  `getContext("2d", { alpha:false })`，Chromium 在 `:root { color-scheme: dark }` 下把不透明 canvas 合成白块；
  pdf_viewer.css 的 `.textLayer { color-scheme: only light; inset: 0 }` 再给盖住 canvas 的层铺 Canvas 白底。
  渲染前必须先以 `{ alpha: true, willReadFrequently: true }` 绑定上下文（后续 getContext 忽略新属性），
  页宿主 `[data-page-num]` 锁定 `color-scheme: only light`，`.textLayer` 保持透明底。Windows 另关
  `isImageDecoderSupported`（ImageDecoder 会把部分 JPEG/JBIG2 解成空白位图）；macOS 保持默认加速。
  **适配宽度禁止拿 ResizeObserver 当强制重挂信号**：经典滚动条出现会让 `clientWidth` 跳约 17px，
  `key` 绑 renderKey 会拆掉 canvas 振荡闪白。scale 变化已足够触发重绘；新 scale 换算回页面宽度差不到半像素
  保持原值（`nextFitScale`，`src/reader.ts`）；滚动容器加 `scrollbar-gutter: stable`。勿把 renderKey 写进
  React `key`，勿在 RO 回调里无条件 bump。

## 其余终端工作台条目

- **产物核验清单（v3.42；v3.45 起从胶囊移到任务行；v3.61 起第二入口为步骤 ⋯ 菜单）**：共享组件 `src/components/ArtifactChecklist.tsx`（步骤按 workspaceName 反查
  project.toml，定位根由调用方给：已合并读项目根/main，其余读工作树）；任务行「产物」按钮（hover 才现，与 ⌨ 终端同档）在行下方
  就地手风琴展开，展开态按工作区 id 记忆在 WorkspacesPage、切项目清空；步进器圆后小方块在 strip 下方就地展开，展开态记步骤 index（单开）；面板 = 已产出 ✓/未产出 — + mtime 相对时间
  + 手动 ⟳ 刷新（打开时拉取一次，不进轮询；v3.60 起无「刚更新」标记——文件新旧不是待办）；选段反馈浮动条带「↵ 直接发送」（pty_write 一次拼接 \r，同帧到达防半截输入）。
- **沉淀为技能（v3.42）**：md/PDF 选段浮动条「✦ 沉淀为技能」→ `ai_distill_skill`（脱敏 + 8KB 截断 + JSON 容错解析）→
  `skillDraftReq` 一次性请求 → 技能页新建弹窗预填，保存走既有 create_skill（重名拒绝）。
- **模型 combo-box（v3.42）**：启动栏模型 = 可输可选（profile 预设 + `ccode.modelHistory.<agent>` 历史去重，上限 10 条），
  启动成功即记历史；「新增模型」不再是配置概念。
- **评审一键开下一步（v3.42；v3.97 改向）**：评审覆盖层合并成功且保留工作区时，成功横幅
  给出「→ 去下一步：步骤名」——下一步 = 同名步骤之后第一个无同名工作区（含已归档）的步骤；无下一步/未注册/无流水线
  只显示合并成功横幅；「合并并归档」成功即关覆盖层，不出此入口。**v3.97 起不再直接开步跳终端**
  （用户拍板：直接开步会把不熟流程的用户扔进黑窗）——改为 `selectProjectReq` + 跳项目页，
  聚焦逻辑自动落在刚解锁的下一步（第一个未完成步骤），流程线/TASK.md/人工事项先看再自己点「开始」。
- **Codex TUI resize 重绘属上游行为（2026-08-24 实证，本端只能减次数）**：codex 主对话区是 inline viewport
  （alt screen 只用于 /model 等覆盖层），PTY resize（开合聊天层/拖分屏/改字号）触发 SIGWINCH 后 resize reflow
  会把整个 transcript 按新宽度重放，旧帧留在 scrollback，表现为每条消息成对出现（截断版 + 完整版）。
  上游 issue 簇 openai/codex#38839/#38479/#25622 全部 open，原 reflow 开关已移除（恒开），
  唯一官方旋钮 `tui.terminal_resize_reflow_max_rows` 有 resume 丢历史的副作用（#21635/#26570），不预设。
  本端缓解：拖拽的多次 fit 仍用 150ms 收成一次，但 `onResize` 与 `attach` 在进程活着之后
  不再自己 `pty_resize`（`allowPtyResize`：`measured` 与 `frozen` 一律 false）。
  拉起时按当前 xterm 格子开 PTY。带首条指令、且这家能注入的新会话，先收起高级选项再量格子
  （`launchChromeBeforeMeasure`）。「退回修改」不收栏：意见是起来之后再写进去的。
  量不到格子就不起进程，不把 null 交给 `pty_size_from` 的 24×80。
  有 `runId` 时先问只读的 `pty_id_for_run`：已经在跑就不收栏、不改行列。
  起来之后只有这些操作通知进程一次：拖窗口、拖分隔、改字号或字体、开关文件树 / 右栏 /
  拉起 / 分屏、阅读区搬进和搬回、设置里开关底部状态栏。查找和运行中点「修改」可以改画面高度，
  不通知进程。已经写进历史的旧副本清不掉。
  底部状态栏跨聊天/终端模式常驻渲染（聊天页默认也显示模型/目录/git/token）——设置页「底部状态栏」
  统一开关两层同进退（2026-09-19，settings 字段 status_bar 默认 true，旧 status_bar_in_chat=false
  读时迁移），无论开关，切层时栏的存在与否不变化 → 终端行列数稳定、不触发 SIGWINCH，
  切层闪烁与 scrollback 副本同消；关掉后新 fit 的终端约多两行（曾经的 invisible 占位机制随统一开关退役）。
  同类问题非 codex 独有：gemini 整区重绘闪烁（缓解 = settings `ui.useAlternateBuffer: true`，注入模式不动用户配置故不设）；
  Ink 系（claude/cursor）原地重绘不留 scrollback 副本。
  另实证：聊天层「等待回复」滞留的根因是 TUI 输入框残留草稿与发送文本拼接落盘（yyyyyy前缀案例），
  isRecorded 已放宽为包含匹配（TerminalPage fetchConversation）。
- **TUI 配色只在启动时探测终端底色（2026-08-24 实证，codex 0.149.1 源码级）**：codex 启动时经 OSC 10/11
  查询终端默认前/背景色（terminal_probe.rs，仅启动一次，xterm.js 会如实应答当前主题色），据此选定
  浅/深配色并用显式 RGB 画出用户消息行与输入框行（style.rs user_message_style_for(terminal_bg)）。
  Mesa 运行时切主题 → xterm 默认背景即时翻转，但显式 RGB 单元格保持旧色，且进程收不到「调色板变了」
  的推送（终端协议无此机制，DEC 2031 明暗通知 codex 未订阅）→ 运行中会话滞留旧配色，重启会话才一致。
  codex 的 /theme 只是代码块语法高亮主题，不解决。对策 = 设置页主题区与 ⌘K 命令面板主题命令
  **无条件常驻**说明（设置页主题区一行；⌘K 命令面板「外观」组头下一行，不逐行挂 hint）——曾按 liveSessions
  门控，但页面 ⌘R 重载后标签恢复为占位、登记清空，提示恰好缺席（2026-08-24 实测教训），故不设门控；
  不造全局 toast、不拦截切换；gemini/claude 等自适应终端底色的 TUI 同理。
- **Windows：OSC 底色握手被 ConPTY 双向封死，改走 win32-input-mode 主动告知（2026-08-29 实测，
  portable-pty 0.9 + Windows 11 26200 复现工程）**。上一条的「xterm.js 会如实应答」只在 macOS/Linux 成立。
  实测三条结论，**改这块前先看这里，别再往 xterm 层写 OSC handler**：
  1. 子进程发出的 `ESC]11;?` **到不了宿主终端** —— PTY 输出流里完全没有这串字节，
     `term.parser.registerOscHandler(10|11, …)` 永远不触发（曾按这个思路写过一版，是不可达代码，已删）。
  2. 把成形的 OSC 回报写进 PTY 输入**也到不了子进程** —— ConPTY 输入侧会整段剥掉（ST / BEL 收尾一样），
     子进程收到空串；同一时刻写纯文本 `HELLO` 却能原样送达，所以不是通道不通，是 OSC 被识别后吞了。
  3. 唯一通道 = ConPTY 启动时用 `ESC[?9001h` 宣告的 **win32-input-mode**：把回报按
     `ESC [ Vk;Sc;Uc;Kd;Cs;Rc _` 逐字符编码成 key-down 记录，ConPTY 会在输入侧还原成原始字节。
     **条与条之间必须留间隔**（`WIN32_INPUT_RECORD_GAP` = 2ms）——一次性灌进去时输入解析器会丢同步，
     把中间某条记录原样漏成可见文本（无间隔实测：`\x1b]11;rgb:fdfd/fdf` + 字面记录 + `/fefe\x1b\\`）。
  所以 Windows 下不等查询、attach 后主动推一次：`pty_report_terminal_colors`（pty.rs）起后台线程
  逐条投递，每条单独取放 `entries` 锁（`PtyEntry.writer` 只受整表锁保护，攥满全程会卡住其它标签的按键）。
  网关判定 `shouldReportTerminalColors`（terminal-input.ts）：**仅 Windows + 仅浅色主题 +
  仅 `TERMINAL_BG_PROBING_AGENTS` 白名单内的 agent + 设置开关开**。
  **白名单是硬约束，不是保守起见**（2026-08-29 实机回归教训）：曾按「所有 agent 都推」上线，
  结果 codex 输入框直接吐出可见乱码——没人消费的字节会原样落进 TUI 输入框。逐个核过各 CLI 实现：
  - **gemini 0.57.0 ✅** `TerminalCapabilityManager.detectCapabilities`，OSC 11 查询 + 1s 超时，
    回报进 onData 后被消费；`pickDefaultThemeName(terminalBackground, …)` 只在用户主题仍是默认值时才自动切。
  - **qwen 0.22.2 ✅**（gemini-cli fork）`detectOsc11Theme` 同款消费；它额外还认 `COLORFGBG`。
  - **codex 0.150.1 ❌ → 0.162 ✅（2026-10-10 二进制复查）**：0.150 一度移除探测（乱码教训来自那个版本）；
    0.162 的 `tui/src/terminal_probe/terminal_identity.rs` 重新引入 `]10;?` / `]11;?` 探测（无 termbg/colorsaurus，
    自实现）。codex 已加入 `TERMINAL_BG_PROBING_AGENTS` 白名单。**注意版本窗口**：更老的 codex（≤0.155 的
    不探测版本）在 Windows 浅色主题下会收到没人消费的回报——设置开关 `terminal_color_report`（默认开）
    是兜底刹车；若实测出现乱码，按启动栏已知版本门控（<0.156 不推）。`[tui] theme` 仍是语法高亮主题名。
  - **claude-code ❌ 不探测**：走 `~/.claude/settings.json` 的 theme 配置。
  - **opencode/kimi 等**：2026-10-10 调研未观察到探测消费，不在白名单；OpenCode 的通知协议经
    `OPENTUI_NOTIFICATION_PROTOCOL=osc777`（launch_plan 注入，extra_env 可覆盖）打通。
  只推浅色是因为深色本就是 agent 探测失败的回落值；不推 shell 是因为它不做这个探测。
  设置页开关 `terminal_color_report`（默认开）留作白名单内 CLI 换实现时的兜底。
  注入早于子进程读 stdin 也不会丢（ConPTY 会缓冲；300ms 注入 vs 2000ms 才挂监听，实测完整收到）。
  这条只解决**启动**取色，运行中切主题仍是上一条的老问题（重启会话才一致），两条口径不冲突。

