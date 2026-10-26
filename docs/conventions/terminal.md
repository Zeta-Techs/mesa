# 约定：终端与工作台

> 适用范围：TerminalPage、PTY 生命周期、评审/冲突覆盖层、收件箱与注意力标记、改动面板、键盘流、会话关联。从 AGENTS.md 迁入（原文照录，未做语义改动）。

## 审计后的可靠性合同（2026-09-08）

- 输入只在查找句柄时取 PTY 表锁；按请求到达顺序进每终端队列，队列写入/等待不占其它标签的锁，异常显示在终端错误区。正文+提交作为一个队列请求保留 60ms TUI 消化间隔。
- 诊断输出副本不参与终端回显热路径，拥堵可丢诊断副本但不能影响实际终端；数据库输出事件有保留上限，不把它视为完整会话日志。
- “停止运行”与应用退出都回收原生进程；后台任务入口在设置诊断区。新建/恢复的只讨论权限一致，缺能力不能降级成可写。
- 文件树达到 2000 项上限必须提示“部分文件未列出”，保留搜索和子目录导航；编程工作树仍有活跃 Run/PTY 时不得删除。
- **会等待的命令不占主线程（2026-10-21）**：不带 `async` 的 Tauri 命令在主线程上执行，而 Rust 往网页推终端输出（每个事件 =
  在网页里执行一段脚本）也要排主线程的队——同步命令里等一秒，所有标签的输出和按键就停一秒。凡会等子进程或外部应用（osascript /
  open / start）、等端口就绪、走回收站、删拷目录树、冻结评审快照的命令，一律 `async fn` + `tauri::async_runtime::spawn_blocking`，
  需要的 State 在闭包里经 `app.state()` 取。已挪出：`pty_spawn` / `shell_spawn` / `pty_spawn_custom` / `pty_kill`、三个外部终端命令、
  `run_close`、`delete_schedule` / `schedule_run_delete` / `adopt_watch_run`、`save_clipboard_image`（pty.rs `waiting_commands_stay_off_main_thread` 钉住）、
  `run_find`（侧栏点开对话要等它，2026-10-24）、`pty_get_cwd`（macOS 上起 lsof 实测 25–50ms，原先还在 PTY 全局锁里跑，连 `pty_ack` / `pty_write` 一起挡住；现在锁内只取 pid，2026-10-24）、`task_list` / `run_list` / `run_get` / `list_schedules`（页面轮询 / 挂载时调，要开 app.db，2026-10-24；Rust 内部调用走 `run_get_sync` / `run_list_sync`，别回头调 async 版）；
  2026-10-26 一批收齐写 app.db 或扫目录的：目标与 Run 的增删改查（`task_create` / `task_update` / `task_delete` / `task_unarchive` /
  `task_purge_archived` / `task_set_launch` / `task_get` / `run_events` / `task_goal_events` / `run_open` / `run_open_custom` /
  `run_attach_session` / `run_cancel`）、对话元数据（`set_session_meta` / `unpin_session` / `assign_session_task` /
  `set_session_profile_command` / 两个 `claim_next_session_for_*`）、`mark_handoff` / `handoff_targets`、自定义运行时三件、
  `profile_usage_refs`、`model_db_status`、`read_project_status`（打开项目顺带回放 PDF 登记）/ `read_acceptance_log`、`run_artifacts`、
  雷达技能草稿的列 / 提交与 `ensure_schedule_skill_distributed`（拷技能目录）、`cancel_schedule_run`、`font_status`（扫字体目录）。
  写法统一为 async 外壳 + 同名 `_sync` 本体；**新增写 app.db 的命令默认就照这样写**，并补进守卫测试名单。
  **app.db 的轮询读不得申请写锁**：`runs::db()` 每次调用都过 `ensure_schema`，其中项目归属回填的 UPDATE 命中 0 行也要写锁，所以必须先用只读 EXISTS 判断有无可回填行
  （`ensure_schema_needs_no_write_lock_when_nothing_to_backfill` 钉住）；新增每次开库都跑的迁移同口径，没事可做就不写。`journal_mode=WAL` 由 `sessions::ensure_wal_mode` 在进程内第一次开库时尝试，
  写进库文件：对 app.db 做文件级备份要连 `-wal` / `-shm` 一起拷，或先 checkpoint。
  三种拉起之间用 `SPAWN_LOCK` 保持逐个进行——原先靠主线程天然串行，Run 认领、会话预登记、启动前文件准备都按这个前提写。挪出后
  命令之间**不再按调用顺序串行**：停止后要按同一 Run 重新拉起的调用方必须 await `pty_kill`（`cleanupPty` 已是），否则这边
  随后的 Run 收尾会关掉新进程认领的 Run。只碰内存、读写一两个小文件的命令（`pty_resize` / `pty_set_visible` / 配置读写等）
  留在同步，不为挪而挪。**大块二进制不按 JSON 数字数组传**：IPC 请求在主线程上解析，5MB 截图编成数组是 18.7MB 的 JSON，
  网页和 Rust 两边各编解一遍；请求体直接给 `Uint8Array`、元数据放请求头，命令收 `tauri::ipc::Request`（先例
  `saveClipboardImage` / `save_clipboard_image`，自定义协议不通时 Tauri 退回 postMessage、请求体变回 JSON 数组，两种都要收）。
- **前端定时刷新走 `src/polling.ts`（2026-10-26）**：拉后端数据的轮询一律 `usePolling(tick, ms | null)` 或在已有 effect 里
  `pollEvery(tick, ms)`，不再裸写 `setInterval`——窗口隐藏时停、回前台立刻补一次，上一次没回来不叠下一次。例外只有两类：
  驱动通知 / 回合判定的计时器（终端页 `linkTick`、PTY 静默、空闲收标签、回放快照保存），窗口藏着时也得照常跑；
  纯界面计时（倒计时、动画、相对时间刷新）。新增轮询先想有没有事件可听（`fs-changed`、`goal-review-ready` 等），没有再轮询。
- **终端页里按标签画的组件不陪跑重画（2026-10-26）**：`TerminalPage` 在一个组件里给每个标签画聊天层、状态栏，回调都是内联闭包，
  `sessionByTab` 任何一个标签变（实时预览约 300ms 一次）整页重画。按标签画的重组件一律经 `memoWithLatestFunctions`
  （`src/stable-props.ts`）包一层（现有 `StableChatSurface` / `StableTerminalStatusBar`）；props 里嵌着函数的对象 / 对象数组要在
  `depths` 里写明深度，否则那个 prop 每次都算变了。**不要**改用 `memo` + 忽略函数的比较器：跳过重画后子组件手里是旧闭包。
  新加给这两个组件的 prop 若是每次渲染现算的对象（`(() => ({...}))()` 这类），同样补进 `depths`。
  **藏着的标签传 `frozen`（2026-10-26）**：没在看、也不在阅读区右栏的标签，聊天层与状态栏收到 `frozen` 就不重画（记录照常刷新、通知照常判断），
  露出来那一下按最新的画一次。实测四段藏着的对话原先每 0.7 秒各白画一遍、各跑一次贴底。

## 终端行为（用户明确要求；配色 = VS Code Dark+ 调色板，集中在 `TerminalPage.tsx` 的 `theme` 一处）

- **Run 与标签（v3.221 / v3.223 / v3.225）**：终端标签是一次 Run 的视图，不是身份。同一 `reuseKey` 只留一个活标签；标题先任务名（工作区/分支/文档）后 Agent（Agent 只在进程起来后的状态栏）。交互 `pty_spawn` 必先登记 `runs` 行（登录标签除外）；无头标 `internal` 不进工作台。启动入口用 `permission`（`discuss` / `write_tree`），旧 `readonly` 仅回落。重启白名单含 `runId` 与工作区复用键（只留 `ws:` 前缀，2026-10-22），仍禁 PTY/密钥/env。关标签后按 `runId` 恢复。会话恢复自动启动必须可取消（开发态 StrictMode 假卸载），失败不得写成「进程已退出」。细则 `docs/conventions/agent-workbench.md`。
- ~~**运行页上下文分工（v3.127）**~~（2026-10-24 左栏重做后作废：项目区删了、文件树不再钻取换根，见下文「左栏只剩这段对话的文件」）：左栏「项目与工作区」只负责切换终端上下文；目录浏览、搜索、钻取和返回由「文件树」独立负责。文件树悬停「进入」才改变浏览根，不改变 Agent 实际运行目录；单击文件夹只原地展开/收起。两者不一致时必须显示「正在浏览 … · 终端仍在 …」并提供「回到当前目录」。Agent 运行中点击项目/工作区不得静默失败，改为在新标签打开目标上下文并给出短提示。
- **聊天/终端按标签隔离（v3.127）**：每个终端标签独立保存显示层（聊天或终端），切换标签不继承另一标签的显示选择；两种显示层仍共享同一 PTY、会话文件和 TerminalView。
- **项目区问 AI（v3.186）**：第一次选 Agent / 配置 / 模型，可设为默认（`ccode.askAi`）；未设默认不沿用 `lastLaunch` / 快速开聊。先显示哪一层跟设置「打开对话时先显示」（见下「表层默认」）；`previewPath` 打开右栏预览，PDF 与「查看」一样撑开。⌘/Ctrl 点问 AI 强制重选。指定了 `profileId` 时启动栏不得用上次留下的模型。
- **顶部终端标签（v3.135 / v3.153 / v3.177）**：终端标签名与「＋」放进同一个 Ghostty 式轻量圆角胶囊；显示层、成果面板、分屏、查找不并入标签胶囊。聊天/终端是同一位置的单击切换（图标显示当前层，再点切到另一层）；成果面板是标签栏右侧常驻按钮（与左侧文件树按钮对仗）；分屏对照与查找终端输出同样是标签栏右侧 lucide 图标（与聊天/终端、成果面板同一套描边），不再经过布局菜单。标签栏右侧到查找为止，不放 `⋯`。没有「专注终端」入口：需要干净画布时收起左边工作树。
- **标签「生成中」虚线圆（2026-09-13）**：只表示这一轮正在出字，不是进程还活着。用户提交（聊天发送 / 回车）后才允许点亮；**启动或恢复会话不转圈**（TUI 启动/回放画面不是生成回答；只有新会话带了首条指令才点亮）。带指令的新启动同时拉起聊天「等回复」（`pendingReply`）：从终端切到聊天要立刻有「正在回复」和发送钮「进行中」，不能等会话文件落盘或用户再发一条。TUI 开屏算出字，但等回复未结束时不得因 PTY 静默熄灭转圈。PTY 有输出才续命。会话窗口最后一条已是助手正文（无待执行工具）或尾部 `done`/`confirm` 立刻停转——不等 PTY 静默、也不让会话文件 sticky `working` 续命；**但 PTY 还在出字时（`ptyLive`，8s）不得被 Codex 中途 `agent_message` / 助手正文把转圈掐掉**（2026-09-18：长工具回合标签与聊天层无运行态）。回合结束后的 TUI 残帧不得从 `done` 再点亮。**收尾被 ptyLive 推迟必须保证重试（2026-09-19）**：推迟后若会话文件再无新写入，5s 轮询的签名门会让收尾判定永远不再执行、转圈冻结（综述大纲跑完实测）——`scheduleSettleRetry` 在 `PTY_LIVE_MS+1s` 强制重判一次；**armed 静默硬上限 120s（2026-09-19）**：真实思考/执行期间 TUI 动画仍在出字，整轮完全无声超上限只可能是回合已结束或链路冻结——熄灭转圈但保留 armed（PTY 再出字立即复亮，不重演 2026-09-15 的「再也点不亮」）。样子是 12px、`text-l2`、`strokeWidth=3` 的虚线圆沿圆周爬，不上强调色。动画走合成器相位闪 opacity，禁止 CSS `rotate`（WKWebView 圆心会晃），也禁 dashoffset 关键帧。纯逻辑 `src/tab-working.ts`。
- **终端菜单分工（v3.136 / v3.153 / v3.177）**：启动栏 `⋯` 只保留当前标签的启动动作（打开 Shell、高级启动选项、转为项目）。标签栏不设 `⋯`：停止走展开启动栏「停止」，恢复走空态「恢复任务」，接力/对话页走对话页。查找、分屏是标签栏图标；「修改启动配置」只留收缩状态行的「修改」。已有 PTY 时该钮改成「本次」，只开浮层，不把整条栏撑开（2026-10-10）；`⋯` 里的高级选项同样改成「查看本次启动」。未启动仍展开整条栏。不设布局菜单。**收缩状态行在会话运行中必须保持可见（2026-10-08 修复回归）**：`activePtyId` 一挂就把整条底栏（展开栏与收缩行）藏掉，`⋯`/修改/插入在会话存活期全部不可达，快速开聊的「转为项目…」出口随之消失。底栏高度归零是 design-embedded-terminal.md 方案 C（PR4）的形态，portal 与底栏身份补偿没做之前不得提前隐藏。
- **启动信任菜单在聊天层代答（2026-10-17）**：聊天发首条会带着 prompt 拉起 Agent；Claude Code 在没信任过的目录（主目录最典型）
  先弹「是否信任这个目录」，会话文件要等选完才出现，聊天层原先停在「已送出 / 等待会话文件」且菜单藏在终端里（用户截图）。
  TerminalView 在会话文件接上之前，每帧输出后防抖 250ms 读 xterm 可视区文本，`parseTrustPrompt`（`src/trust-prompt.ts`）只认
  明确问「信任」且选项以 Yes / No 开头的菜单，上报 `SessionLinkState.trustPrompt`；聊天层顶部给「信任此目录 / 不信任，退出 /
  打开终端」，代答按当前高亮算方向键再回车（`trustAnswerKeys`，**每个键单独写、隔 80ms**——Ink 一次只认一个键；新版 Claude
  默认高亮在 No，不能盲按回车）。认不出（Gemini 的 Trust folder、Codex 的免审批问题）返回 null，走原出口。**原出口修正**：
  8 秒无会话文件的判定原要求 `messages.length === 0`，而聊天发送会先乐观显示用户那条，导致首条消息场景永不触发；改为
  「除了自己刚发的用户消息没有别的」。**扫描窗口以「启动阶段」为界（2026-10-21）**：原先会话文件一接上就停扫，可 Claude Code /
  CodeBuddy 的每次注入 hooks 在进程一起来就报了会话文件，信任菜单还在后头，聊天层看不到（用户：CodeBuddy 发第一条，终端弹出是否信任，
  聊天层不显示）。现在见过这家的输入框（`terminalHasInputBox`）或旁路报了回合开始才算启动阶段过了；认不得画面又没有旁路的家
  照旧以会话接上为界（`trustScanSettled`）。
- **切换命令后的确认菜单在聊天层给按钮（2026-10-17）**：聊天「模型 · 思考」芯片与底栏的切换命令都走标签动作
  `runTuiCommand`（写命令 + Enter，按 submitCsiU 分派），**写之前记屏上已有的「像菜单」内容为基线**，之后 5 秒内每帧输出防抖
  250ms 扫可视区（`parseTuiMenu`，`src/tui-menu.ts`），认出与基线不同的菜单才上报 `SessionLinkState.menuPrompt`；菜单挂着时继续扫到
  它消失（用户在终端里自己选了也会清）。平时不扫——对话正文里「❯」开头的行不能当菜单；回显的 `/命令` 与 `⎿` 续行也排除。
  聊天对话末尾的确认卡（`ChatDecisionCard`，2026-10-17 第一期由顶部横条改来）列出问句与全部选项，`answerMenu` 同信任菜单口径（方向键逐个、隔 80ms、再回车），选完再开 3 秒窗口接连续确认；
  不替用户选默认项。只能在 CLI 选择器里选的（picker 型模型 / 无档表 effort）同时露出下方终端。
  **启动后 20 秒也盯**（完全访问启动时 Claude 先弹「WARNING: Bypass Permissions mode」，默认高亮 No）。为防把对话记录里的
  多行提问认成菜单，必须带序号 / 下方有按键提示（Enter to confirm…，该行本身不算选项）/ 上方有边框三者之一。
  菜单问句取选项上方那段说明（到 ▔/─ 边框为止）的第一行，其余进 `detail`（Claude 2.1.292 实录「Switch model? / Your next
  response will be slower…」；本机假 API + PTY 抓屏得来，样本在 tests/tui-menu.test.ts）。
  **Claude 的提问表单（AskUserQuestion，2026-10-22）按表单读、按表单答**（`src/tui-ask.ts`）：扫菜单时 Claude 先试 `parseClaudeAsk`，
  认出就以 `askMenu` 摘要顶 `menuPrompt`、表单挂在 `menuPrompt.ask` 上，卡片照表单画（`ChatDecisionCard` 的 AskCard），答走
  `answerAsk` → `askAnswerKeys`。认法：表单上沿横线下一行是题签（一题「 ☐ 颜色」，多题「←  ☒ 颜色  ☐ 水果  ✔ Submit  →」，☒ = 答过，
  **当前题只靠底色标**——读那一行的格子样子 `screen-cells.ts`，认不出就不给切题）→ 问句 → 带序号的选项（多选是「[ ]/[✔]」）与缩进说明 →
  最后一项永远是「自己写」（光标停上去直接打字，字写在那一行；多选打字自动勾上、回车反而取消勾）→ 多选另有不带序号的「Submit」行
  → 下沿横线 → 「Chat about this」；确认页是「Review your answers / ● 问句 / → 答案 / Submit answers · Cancel」（Cancel = 整组不答、
  这一轮停）。表单开头滚出屏、底下没收口、光标不在任何一行上时不认，回落通用读法。↑↓ 在可停的行之间一行一行走、←→ 换题。
  **输入框里发出的话在表单开着时就是答案**：写进「自己写」再交（多选再往下一行按 Submit）——原样打进终端的话回车会选中光标停着那项；
  确认页没处写字，发送被拦下并提示先提交或取消。按键排队写（`queuePtyKeys`，隔 80ms，连点不交错）；多选勾选 / 写字表单还是这一题，
  先照 `askAfter` 预测画、从预测的光标算下一次键；多题里换题的动作先把卡标 `pending`（按钮停用），键没按完之前扫屏不拿半路的画面
  覆盖卡片。**交卷（`askFinishes`：最后一道没答的题选定 / 交这一题 / 写了答案交，或确认 / 整组不答 / 先不答）卡片当场收起**，之后 1.5 秒
  扫到的表单不拿回来（过了还在就照常出卡，按键没生效时人还能接着答）；**卡片上交过卷又到了确认页（只有一道多选题也会过这一页），
  替人按「Submit answers」**，确认页只在人自己点到「提交」、或还有题没答（带提醒）时出卡（2026-10-22 用户：为什么还有确认提交、点了卡住几秒）。
  **扫菜单节流、不防抖**：生成中转圈每一两百毫秒出一帧，原先每帧重新计时的 250ms 防抖要等这一轮说完才读得到屏，答过的卡片一直挂着。
  扫菜单与实时预览一样等同步输出那一帧画完再读（不然表单下半截缺一截、卡片闪没）。
- **Claude「猜你下一句」进聊天输入框（2026-10-22，`src/prompt-suggestion.ts`）**：一轮做完 Claude 另发一次请求猜你接下来想说什么，
  灰着字放进它的输入框（Tab 填入、空着回车直接发）；会话文件、hooks 都不记，只能读屏。输入框那一行 = 顶格「❯」且上一行是整条横线；
  占位字整句 SGR 2 灰、终端有焦点时第一个字反色当光标，自己打的字不灰——有一个字不灰就不算。同一位置的固定提示按原文排除
  （`Try "…"`、`Press up/Enter…`、`Message @…`）。出字时节流 400ms 读（等同步输出画完），发出一句 / 进程重开时清；聊天层只在它停在
  输入框、没有等你决定的事时给输入框（生成中那一行是排队提示）。聊天输入框空着时当占位字灰着显示，右上「Tab 填入」，Tab / → 填进来
  再改再发；**空着回车不替你发**（终端里会直接发出这句猜的话，聊天层不照搬）。只认 Claude Code：开关在服务端，假网关下要
  `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=1`；第二轮起才猜；终端失焦（聊天层盖住终端时 xterm 发 ESC[O）之后照样出（2.1.306 实测）。
- **实时预览（2026-10-17；2026-10-18 第三期扩到六家）**：Agent 出字时节流 300ms 读可视区，`extractLiveReply`（`src/live-reply.ts`）
  按每家「画面布局」读（输入框位置、回显、助手行首、续行缩进、工具 / 转圈 / 提示行）：Claude Code、Codex、Qwen、Gemini、Grok、Kimi。
  CodeBuddy（生成中屏上只有转圈）与 OpenCode（分栏整屏重绘）不认，仍给「看实时输出」。新增一家必须先用 `chat-capture.py`
  抓屏、样本进 `tests/live-reply.test.ts`，不凭帮助文字或印象加。
  **Grok 提问续行与去重锚点（2026-10-21）**：Grok 回复长过一屏后把提问钉在屏顶（sticky header，长提问折成三行、末行「… …」），
  下面跟一行「▲」滚动提示——续行缩进到回显正文那一列（7），回复只缩进 5，`echoStart` 按这一列跳过续行，「▲ / ▼」进 skip。
  `unsyncedTail` 以「最后一行够长（≥8 字）且已落盘的」为锚，锚之前的一律算过去：开头混进一行非回复（续行、工具输出），
  原口径从第一行没落盘的算起，会把聊天层已画出的段落整段再画一遍（用户截图：第 4 / 5 步画两遍，下面一份是灰字）。
  **2026-10-21 用户 Windows 实测补四条**：①读屏前去掉字形后的变体选择符（U+FE0E / FE0F）——Qwen 0.25.3 画「◆︎ 正文」「∴︎ Thought…」，
  xterm 把它并进前一格，行首符号认不出，思考折叠行连同上一轮回复一起进了预览；②Kimi 2.3 等首字时转月相「🌑 · Tip: …」，进 skip
  （用户截图：🌕Kimi 叠在「正在回复」上面）；③Gemini 0.65 输入框上方的提示按权限档变字（「auto-accept edits  Shift+Tab to manual」）、
  MCP 后面跟技能数、粘贴多行后回显下多一行「Press Ctrl+O to expand pasted text」，一并进 skip；④**刚发的这句还没画出来时不读上一轮**：
  `writeChatMessage` 记下发送前屏上最后一条回显，读到的这一截仍挂在那条回显后面、又不像刚发的话（`staleEcho`）就不当这一轮的预览，
  读到新回显后解除——原先发出后到 CLI 画出回显之间，预览把上一段回复整段又显示一遍（用户 Qwen 实测；旁路家在回合开始前同样读屏）。
  **必须看得见输入框**（启动信任菜单、登录页没有输入框，原先退回整屏，把「Accessing workspace / Quick safety check」当回复画进聊天层，
  用户截图）；**这一轮没见过开头（回显 / ⏺）时续行不预览**；有「等你决定」卡时不预览
  画面——最后一条「❯ 回显」之后、输入框上边框之前，去掉工具摘要（Read 1 file…）、⎿ 结果与提示（折行的续行一并去掉，`wrapSkip`：
  转圈下的「⎿  Tip: …」长过一行时第二行没有符号，原先一直挂在预览里，2026-10-20 用户实测）、转圈与「· /effort」提示行；
  确认菜单挂着时不出。Claude 另读转圈行里的「↓ N tokens」上报 `liveTokens`，没有逐字预览时在生成中那一行显示「已生成 N token」（Windows 上 Claude 整条收完才画，2026-10-21 抓屏）。上报 `SessionLinkState.liveReply`，聊天层用 `unsyncedTail` 剔掉会话文件已有的行（只比字母数字汉字，
  渲染过的 Markdown 对得上）。别家返回 null，仍给「看实时输出」。**长回复**（同日用户：显示一半后就没了）：回复长过一屏时
  回显与「⏺」都滚出可视区，读到的是续行（`anchored: false`），`mergeLiveReply` 接到上一次后面；
  一时读不出保留上一次，用户发下一句时清空重攒（实录：Claude 流式时可视区只剩续行段落）。
  **接法按位置对齐，不要求尾巴逐字相同（2026-10-22 用户：Claude Code 长回复预览一遍遍重贴整屏）**：生成中 CLI 会重画正在写的
  那一块——列表项先画「-」再出字、「4.」后才跟内容、表格每多一格列宽和行都重排、「**加粗**」收尾前后两样。原口径「上次结尾 =
  这次开头」逐字相同才算重合，尾巴一变就整屏接在后面，每 300ms 重贴一遍（回放实录：Claude 重复 158 行、Kimi 1150 行、Gemini 1123 行）。
  现口径：只比字母数字汉字（空行、表格边框、光有「-」的行不参与），在上一次里找屏顶第一行，从那儿起连续对上两行以上（或一直对到
  上一次结尾，末行可只写了半截）就从那儿起换成屏上这一截；对不上时屏上大半已有就不接，大半是新的才接（滚过了一整屏）。
  **读屏避开半帧**：同步输出 `?2026h` 还没收尾（Claude 每帧都包、一帧常分两块到）时不读，50ms 后再看，连等 20 次照读
  （`scanLiveReplyNow`）。改接法或某家画面后用 `scripts/e2e-model-routing/live-replay.ts` 回放抓屏核对（见其 README）。
  **同日回放补三条**：①Gemini 输入框行首按状态换字（「>」/ 完全访问「*」/ shell「!」/ 翻历史「(r:)」），四种都认——只认「>」时完全访问下
  `terminalHasInputBox` 恒假，预览不出、生成中「esc to cancel」被认成开着面板；②表格与工具框按框角分：连续一段框线里有「直角 + 横线」
  （┌── ├── └──）的是表格、照常进预览，圆角 ╭ ╰ 的是工具框（Gemini 两者行首都是 │）；③回显下面隔空行是这家的「上面还有」提示
  （`scrolledHint`，Grok 的「▲」）时回显是钉住的提问，读成一截接到上一次后面；**看得见回显也可能缺开头**（卷动过渡帧：头两行已裁、
  提示还没画），屏上没有上一次的第一行、屏顶又对得上上一次中段时保留上一次的开头。读屏记下回显，换了一条就从头攒（终端里直接发的
  下一句不经聊天发送、不会清预览，不能拿上一轮的开头补这一轮）。
  **预览长一行就当帧贴底**（同日用户：Claude 长回复时「下一行显示上去前，在原来那一行闪一下」）：聊天原先只在消息列表变化时贴底，
  生成中靠 700ms 一次的会话轮询，预览新出的行先落在底部留白和渐隐里、下一次轮询才整段上跳。现在 `ChatSurface` 在预览文字变化的
  同一次提交里把贴着底的视图拉到底（`useLayoutEffect`，往上翻着时不动）。Claude Code 的段落本来就是整行整行画（表格按字画，
  2.1.304 抓屏：115 次读屏只有 2 次末行是半截，Kimi / Gemini / Grok 是逐字），聊天里一行一行出是它的样子，不是读屏慢。
- **聊天分页首屏至少 6 条（2026-10-17）**：`plain_conversation_page` 原「解析出一条就停」，Claude 2.1.x 每轮写一行几百 KB 的
  `prompt_snapshot` 附件，192KB 窗常只剩最后一句提问，聊天层只剩「加载更早的消息」+ 一个气泡（用户截图）。现在攒够
  `CONVERSATION_PAGE_MIN_MESSAGES` 条或扫到上限 / 文件头才停。
- **回放往上翻自动加载（2026-10-21 用户：对话页、聊天层看对话要一直点「加载更早」）**：一页至少 40 条（工具调用也算条数），
  凑不够时窗口从 192KB 逐次翻倍、单步封顶 1.5MB、一次请求最多扫约 7.5MB；超长行跳过的门槛仍按 192KB。对话页、项目「对话」、
  聊天层三处共用 `useAutoLoadOlder`（`src/auto-load-older.ts`）：只认用户的滚动 / 向上滚轮（离顶三屏内，下限 360px）触发，**禁止挂载时按
  scrollTop 判断**（首屏先在顶部渲染、下一帧才滚到底，会被误判成翻到顶一路拉完）；内容不满一屏时自动补页。
  **顶部不放按钮、不放加载提示、不留占位**（同日用户：按钮滑动时闪 → 要无缝衔接）：靠提前量在滑到顶之前接好，
  占位行在到达对话开头时消失也会让内容跳一下。**拉回来的页先攒着，手停了（140ms 无滚动事件）才写进列表**（`settle` /
  `canCommitNow`；离顶不到半屏就不等）：滑动途中前插要同步改 scrollTop，WebKit 里会打断惯性并整列重排，同日用户实测「一瞬间的顿挫」。
  **还有更早一页时，开头被分页切断的半轮不显示**（`firstCompleteTurnIndex`，从第一条真正的提问开始画；整页都在一轮里、或搜索
  命中落在半轮里时照常全显示）：否则收起行「已工作 X 分 · 运行 N 条命令」在加载更早一页后变长变多（同日用户截图）。
  列表状态仍存全量，只在交给 ConversationView 时切；聊天层前插判定也按切后的列表算。
  **阅读位置一律自己锚（2026-10-24 用户复查「往上滑无缝」；`src/reading-anchor.ts` `useReadingAnchor`，对话页与聊天层共用）**：
  滚动时记下眼睛正看着的那一块（每层取第一个底边越过视口顶线的子元素，跨线就往里找一层）和它离顶边多远，内容尺寸一变
  （ResizeObserver，绘制前）就把它挪回原处——前插更早一页、视野上方图片晚到撑高、窗口变宽重排都走这一条。滚动容器必须
  `[overflow-anchor:none]`：WKWebView 与 WebView2 现在都自带滚动锚定，滚到最顶时不管，和「按 scrollHeight 差值补偿」叠在一起会补两遍
  （同日两边实测：前插一页，阅读位置多往下跳一整页）。**禁止再按 scrollHeight 差值补偿，也禁止把锚定交回浏览器**（老系统的 WebKit 有没有说不准）。
  聊天层跟着底部时内容变高改为贴底，但人刚在聊天区点过 / 按过键（800ms 内，多半是展开了什么）先锚住、再按离底远近重算跟不跟。
  聊天层仍用 `wasPrepended`（原首条在新列表里往后挪了）区分前插与最新窗后滑，前插那次不亮「有新消息」。
  **自动接更早一页时还贴着底就继续贴底（2026-10-26）**：`loadOlder` 只在离底超过 56px 时才把「跟着底部」关掉——最新一页不满三屏，
  刚打开就会自动接更早的，原先一律关掉跟随，切到一段对话先在底部闪一下、接上后停在上面。选锚时整块在顶线以下的元素若是这一层
  **唯一**的子元素（纯包装层，如聊天的栏宽容器）要往里找：往它开头插内容它自己不挪，锚它等于没锚（停在最顶上时一接上就整屏换成更早的）。
  **「只认用户的滚动」按输入事件判（2026-10-26）**：贴底、锚点挪回这些程序改 scrollTop 也会发 scroll 事件，原先照样触发接更早一页——
  一打开对话就多接一页、整段重排一次。现在滚动区里有过滚轮 / 拖滚动条 / 触摸 / 按键之后 1.2 秒内的滚动才算（`scrollIsUsers`）；不满一屏的补页照旧。
- **整段一次取齐，分页只做兜底（2026-10-26 用户：切一段对话往上划不丝滑、滚动条由长一下变短，要 Claude 客户端那样）**：
  首屏照旧先拿最近一页（快、能先摆出来），随即调 `get_session_conversation_rest(agent, filePath, before = 首屏 cursor)` 在后台把更早的一次接齐
  （普通 jsonl 直接读 [0, before) 解析一遍；OpenCode / Grok 的 cursor 不是字节偏移，后端按页往前接到头），接齐后 cursor 置空、不再分页。
  聊天层（TerminalView `loadRestOfConversation`）与对话页回放（`openSession`）都这样；接的期间 `loadingOlder` 为真，聊天层自己不翻页，刚打开的遮罩也等它（最多 600ms）。
  `conversationRestFor`（quick-chat-launch.ts）按「会话 + cursor」缓存最近 8 段：[0, cursor) 写完就不再变，来回切同几段对话不再重读、重传整段（2026-10-26）。
  读不出时留着 cursor，往上翻照旧一页页接。**开着的对话已有「更早」时，每次刷新先把滑出最新一页的那几条并进「更早」**（`slidOutOfWindow`）：
  原先最新一页往后挪、「更早」不动，对话一长中间那段会从画面消失。只看不接转接回同一份文件时，已接齐的「更早」原样带过去（`carryOlderRef`），不再缩回一页重接。
- **刚摆出的对话排好再露（2026-10-26 用户：每切到这段对话，上方文字都会抖动两下；`src/chat-veil.ts` `useSettleVeil`，聊天层与对话页回放共用）**：
  对话区从没内容到有内容的那一刻起只把内容根设成透明（不动排版，选锚、贴底照常算），尺寸 120ms 不再变、也没在接更早一页时淡入（150ms，
  减弱动态效果时不过渡），最多遮 600ms。逐帧实测贴底时的后到改动有：表格套壳、行内文件链接与引用胶囊（要问后端）、代码高亮、公式、
  图片、输入框上方那排芯片挪进状态栏、程序滚动误触发的补页——逐个堵堵不完，这一层兜住第一屏。已经开着的对话切回来不重摆、不遮；
  **新对话里人刚发的第一句不遮**（等回复中，或列表里只有人说的话，`useSettleVeil` 的 `skip`）：那不是摆出来的记录，遮了等于自己发的话晚半秒才出现；
  新加「上屏后再改 DOM」的装饰，能用缓存在第一帧前套上的就先查缓存（文件链接核实结果记 5 分钟，不是文件的只记 15 秒）。
- **运行中换权限（2026-10-17 用户：发完消息权限就改不了了）**：各家权限都在启动参数里，换 = 父级先写标签 permission /
  permissionMode，下一拍调标签动作 `restartWithPermission`：停下 Agent，回落 shell 后 effect 用最新 props
  `launch(lastResume)` 按原会话恢复，对话不丢；**接回期间置 `keepPreviewConvRef`**，`launch` 开头的 `resetLink` 不清聊天，接上后会话文件刷新整份替换（换模型 / 换连接同口径；原先先清空再出现，用户看着像整页刷新，2026-10-25）。权限徽标确认框写明「会重开」，正在生成时只显示不可点。
  **重开另开一条 Run（`freshRun`，2026-10-21）**：旧 Run 刚被 pty_kill 关掉，权限（只讨论 ↔ 可改文件）又是 Run 身份的一部分，
  沿用旧 Run 会被 `open_at` 拒（「此 Run 不支持恢复」「Run 身份与启动目标不一致」）。另：**轮询 / 旁路回调里读 Run 一律用 `runIdRef`**——
  闭包是 launch 那一轮捕获的，读 state 是旧值，`lockLink` 曾因此从不给 Gemini / Kimi / OpenCode 的交互 Run 登记会话；
  存量没登记的 Run 由 `open_at` 在首次带会话恢复时认下（同「首次登记为准」）。
- **屏上读回模型（2026-10-17；2026-10-18 补 Gemini「Model set to X」、Codex 底栏「<模型> <档位> · <目录>」，CodeBuddy 中途换不了不再读）**：
  与思考档同一帧扫描，`detectModelInOutput` 按家认（Claude「Set model to X」，屏上无反引号），上报
  `TabStatus.modelSeen`；芯片与底栏以它为真值，切换待确认记录按 ptyId 存模块级表。**不认「X with LEVEL effort」**——思考中的
  转圈行「thinking with high effort」同句式，曾把 thinking 当模型名显示（同日用户截图，测试钉住）。
  **整行底栏只从画好的屏上读**（`detectModelOnScreen`，节流 500ms 读可视区、自下往上取第一行）：Codex 差量重绘只重画变了的格子，
  输出流里档位前面不一定是模型名（2026-10-18 用户截图：芯片显示「[14;5H好」＝输入框回显「你好」的光标定位 + 字）。
  所有读回的名字须像模型名（可见 ASCII、不以「[」开头）；拼帧尾巴走 `outputTail`，不从转义序列中间开始。
- **抓屏语料库（2026-10-22，`tests/fixtures/screens/`）**：读屏解析器（`live-reply.ts` / `tui-menu.ts` / `trust-prompt.ts`）的改动要过语料库回归
  （`tests/screen-corpus.test.ts`）。修一个读屏问题就把那一屏存进来、expect 写成修好后的样子；老版本样本不删（用户可能还在用）。
  金丝雀出了新画面用 `scripts/screen-corpus/add-from-capture.ts` 挑三屏（审批菜单 / 边写边显示 / 回到输入框），先 `--dry` 看读得对不对。
  Qwen 的顶格圆角框（`╭…╰`，「有新版本」提示）不是回复（`Layout.noticeBox`），表格是方角不受影响。
- **替人选菜单项认准了再回车（2026-10-22，`tui-menu.ts` `menuReadyToConfirm` / `trust-prompt.ts` `trustReadyToConfirm`）**：聊天卡上点了菜单项 /
  信任 / 不信任，先只按方向键挪高亮，读一遍屏（等同步输出画完，最多再等三拍 150ms）：还是同一个菜单、高亮停在要选的那项上才按回车；对不上就不按，
  卡片按屏上现在的样子重画，人再点一次（高亮已在那项时直接回车）。核对期间扫屏不把挪到一半的菜单拿回来当卡片（`askKeysDoneAtRef` /
  `trustAnsweringUntilRef`）。原先照算好的格数直接回车，读屏把说明行算成选项时会选中另一项（Kimi /permission 实例）。新加替人按键的动作照这个口径。
- **聊天层标「测试版」与按版本降级（2026-10-22 用户，设计 `docs/design-chat-fidelity.md`）**：输入框左下 `ChatBetaBadge`（字由 `fidelityBadge` 定：
  `beta` 的写「测试版」、第三四档「简化」、摘了测试版的只在 CLI 更新时写「未核对」；按家摘测试版的条件见设计 §4）点开说当前这家的档
  （`chat-fidelity.ts` `CHAT_FIDELITY` 单一出处，九家各一行）与要回终端做的事。已核对版本 = 金丝雀基线的 `version`（`cli-verified.ts`
  构建时 `import.meta.glob` 只取这个字段；本平台没有就取别的平台最新的）。用户的 CLI 更新时（`useCliNewer`）：**不替人自动按任何一步**
  （Claude 提问表单交卷后的自动「Submit answers」停掉）、菜单卡提示「这版 CLI Mesa 还没核对过」、徽标带点；读不到版本不降级。
  新加「替人按键」的自动动作必须同样看 `cliNewerRef`。esbuild 打包组件的测试里没有 `import.meta.glob`，`cli-verified.ts` 用 try 兜成空表。
- **实时预览匀速显示（2026-10-22，`src/text-reveal.ts`，借 Paseo 的 paced reveal）**：预览一块一块到（读屏 400ms、旁路 150ms），到一块贴一块看着一顿一顿。
  到达只改目标，每帧放出积压量 × 帧长 / 220ms（至少一个字），追得快但不跳；**第一次见到的文字整段显示，只有接着原文往后长的才匀速放**
  （预览被会话文件追上换了一段、读屏重排都当新文字）；不在生成了一次放完；切口不切开代理对、组合符、零宽连接的表情。只节流显示，贴底按显示出来的那一截算。
  时间常数要跟到达间隔同一量级：太短两块之间停住，太长一轮结束前追不上（结束时一次放完）。测试禁对时长下断言，只看「前缀、只增不减、最后放完」。
- **聊天层收尾与卡住判定（2026-10-17 用户截图两处）**：①「正在回复」永不熄灭——Claude 回合结束后 TUI 仍有状态行 / 计时重绘，
  PTY 一直出字，原口径「会话说 done 但 PTY 8 秒内出过字就继续转圈」永远等不到静默。Claude 每轮结束写 `system/turn_duration`，
  `claude_tail_state` 见到它（且其后没有新的 user）返回 **`settled`**＝确定收尾：`applyTailAttention` 不再看 ptyLive 直接 done，
  且刚发的用户消息都已落盘时一并结束 pendingReply。普通 `done`（无标记、Codex 中途正文）仍按原口径等 PTY 静下来。
  **2026-10-18 扩到所有写了确定收尾标记的来源**（用户截图：Codex 回答早已落盘，聊天层仍「正在回复」）：Codex `task_complete` /
  `turn_aborted`、Kimi wire `turn.ended`、Cursor `turn_ended`，以及 hooks 精确注意力的 `Stop` / `AfterAgent`（hooks 开着时
  事件日志优先于会话尾部，原先映射成 `done`，文件里的收尾标记被盖掉）都返回 `settled`。Gemini / Qwen / CodeBuddy / Grok
  会话文件里没有回合级标记，仍按 `done` + PTY 静止收尾。
  ②正常开聊也弹出半屏终端——「8 秒无会话文件就拉起终端」须再加 **PTY 静止 ≥4 秒**（`SessionLinkState.ptyQuiet`）：
  模型慢时转圈动画一直在出字，那不是卡在菜单上。只在判定卡住的上升沿拉起一次；自动拉起的终端在会话接上后自动收回，
  人手拉起的不动。
- **读屏认出的菜单也是「等你确认」（2026-10-18 用户：终端里等你确认时 Mesa 不提醒，要做就九家都做）**：TerminalView 上报
  `TabStatus.attention` 时，`menuPrompt`（工具审批 / 切换确认）或 `trustPrompt` 在就报 `confirm`——下游标签黄点、收件箱
  「待确认」、系统通知、项目点、对话页 / 侧栏项目树对话行黄点（`terminalRunInputs` 里 confirm 的标签）全部沿用，不新造提醒通道。
  原先 confirm 只来自 hooks 精确注意力（逐家手动开，Claude 默认关）或会话尾部推断，没开 hooks 的家在等批准时全链路静默。
  hooks 仍有用：更准，且能认出 Mesa 之外的终端里的对话（读屏只看得见 Mesa 自己的标签）。聊天层在屏上认出菜单时不再自动拉起终端
  （已有按原文给按钮的卡），审批 y/n 卡在 menuPrompt / trustPrompt 都没有时才出。
- **运行中换模型 / 思考档：会写回 CLI 全局配置的改走重开接回（2026-10-18，`switch-strategy.ts`）**：逐家实测 Claude /model 写
  settings.json model、/effort 写该模型 effortLevel；Codex 选择器写 config.toml model 与 model_reasoning_effort（而且列的是官方模型）；
  Grok /model 写 config.toml default；Qwen /effort 写 settings.json reasoningEffort；Kimi /effort 写 thinking enabled。这几样改成
  标签动作 `relaunchWith({model|effort})`：先写启动栏 state / 标签 effort，下一拍走 `restartWithPermission` 的停下 → 回落 shell →
  按原会话带新参数接回。思考档要这个组合 `injectEffortAllowed` 才能走；注不进去的退回命令并在菜单底部写明会存成默认。生成中
  （attention working）不让换（重开会打断这一轮）。Gemini /model set、Grok /effort 不写配置，照旧中途切。Codex 模型不再唤它的选择器，
  Mesa 自己列连接里的模型。`chat-capture.py` 带 `ANSWER_MENU=1` 跑第三幕会比对临时 HOME 里的配置文件，新 CLI 版本先这样复核。
- **信任菜单不走通用确认菜单（2026-10-18 用户：点完信任后同一个画面又出现一次）**：启动 20 秒的菜单扫描与这一轮的审批扫描都会把
  启动信任菜单认成通用菜单；点完信任、按键还没生效的那一两帧，信任卡撤了、通用卡顶上来。扫描时屏上是信任菜单（`parseTrustPrompt`）
  或选项与见过的信任菜单相同就不报；`answerTrust` 同时撤掉 menuPrompt。
- **旁路审批与读屏菜单只出一张卡（2026-10-21 用户：Codex 先中文后英文两张、Qwen 连着两张）**：能从聊天层答审批的旁路
  （Codex / Qwen / OpenCode）一轮进行中时，屏上的审批菜单归旁路的卡（`channelOwnsMenu`）：旁路有卡 → 读屏不另报；旁路的卡刚撤
  （答过了，终端菜单还没撤的那一下）3 秒内不认；读屏先认出、旁路事件还没到 → 先等 1.2 秒；等过了旁路仍没有才按屏上原文出卡（兜底）。
  旁路侧（`chat_channel.rs` Tracker）：带请求 id 的审批只认「已处理」事件、它自己那个工具结束、这一轮结束才撤——同一回复里并行的
  别的工具开始 / 结束不撤（用户 Codex 实录：跑命令要提权的同时调了 MCP，MCP 一结束旁路卡就没了，读屏又出一张英文的）；
  后到的审批排队，前一张答完再出，不顶掉没答的那张。没有请求 id 的（hooks 推断）照旧「下一个工具开始 = 已答」。
- **终端层与聊天层同步（2026-10-18 用户「全部都做」）**：①启动栏补「思考」「权限」两格（`LaunchMenu`，选项 `hint` / `tone: warn`），
  与聊天输入框写同一份标签级选择（父级 `patchTabLaunch` → TerminalView `onPatchLaunch`）；权限四档名与确认话术共用
  `ChatPermissionBadge` 导出的 `PERMISSION_TIERS` / `confirmPermissionChoice`（完全访问二次确认、运行中换档说明「会重开」）。
  原先聊天里选的档终端点运行照样生效却看不见。②**「本次」按钮删掉，身份那一行字就是入口**：有进程时开「这次启动」卡（Agent / 连接
  指纹 / 模型（读回优先）/ 思考 / 权限 / 目录 / 附加变量名），卡里「换权限」（`restartWithPermission`，生成中置灰）与「换连接接着聊」
  （`switchConnection`，有会话才给）；没进程时展开启动栏。原卡首句「这次进程不会改。要换，先停止」已不成立，删。③⋯ 菜单补「对话操作」
  分组，内容来自父级 `getConversationActions`（= `mesaCommandsFor` 去掉 /fork、/terminal，补「切到聊天」），⋯ 打开时现取。
  ④底栏右区补上下文用量圆环 + 百分比（`ContextRing`，xterm 调色板色，≥80% 用 yellow），只在终端变体画，聊天变体在输入框里画。
- **聊天层第二期（2026-10-18）**：①**排队**：生成中（`pendingReply` 或 attention working）发出的话照常写进 PTY、由 CLI 排队，
  乐观消息带前端专用标记 `ChatMessageDto.queued`，气泡标「排队中 · 这一轮结束后处理」、无撤回钮；会话文件记下后由解析结果替换。
  **发送先清空、气泡先出（2026-10-25）**：`ChatComposer.submit` 点发送即清空输入框与附件，`onSend` 报错再放回（人已接着打字不覆盖）；
  Agent 在跑时 `sendMessage` 先 `showOptimisticUserMessage` 再 `writeChatMessage`，没写进去用 `retractOptimisticUserMessage` 撤掉并恢复发送前的「等回复」。
  要先启动 / 接回的三支（回落 shell 后接回、恢复占位、新开）走 `showEarlyBubble`：气泡先出，`launch` 期间置 `keepPreviewConvRef` 不让 `resetLink` 清掉，
  回来立刻重新登记待确认（`resetLink` 清了 `pendingUsersRef`）；启动失败 / 终端已换（原先静默返回、这句丢了）都撤掉气泡并报错，输入框放回原话。
  原先两者都等写进 PTY（等 CLI 能收键 + 多行粘贴后 0.65 秒）才动，字在框里停一下（用户：不够丝滑）。
  **2026-10-22 起气泡写法与「立即发送」按各家实测走 `mid-turn-send.ts`**（下一步就交 / 这一轮说完再交；Esc / 回车 / Ctrl+S 各家不同，
  依据 matrix §14「生成中再发一句」）——CLI 升级改了行为改那张表，别在组件里各写一份；按键经 `writePty` 原样写，不加回车。
  ②**乐观消息放回位置**（`placePendingUsers`，chat-handoff.ts）：排队中的接末尾；其余插在「发送那一刻还没有的第一条回复」前
  （`pendingAssistantKeysRef`）。原口径插在整页第一条回复前，长对话里刚发的那句会跳到页顶。
  **认「已落盘」不逐字比（2026-10-21）**：`userTextRecorded` 包含即算，再去空白与 BMP 外字符宽松比（Windows 上 Codex 吞 emoji，
  逐字比永远落空 → 同句画两遍、「正在生成回复」不收）；旁路报回合结束时 `pendingAfterTurn` 把这一轮开始前发出的乐观消息一律
  当已收下（排队的须早于回合开始），不靠原文。③**标签条 ⋯「对话操作」**
  与斜杠面板 Mesa 组同一份 `mesaCommandsFor(tabId)`，只在聊天层活动标签显示，父级 `ContextMenu`。④**从这里分叉**：
  `forkChat(tabId, untilText)` → `build_handoff_brief(untilText)` 按正文截到那条回复。⑤**连接出问题**：终端会话产出的
  `SessionLinkState.connIssue` 在聊天层渲染成确认卡（`chat-decision.ts`），按钮调标签动作 `switchConnection` / `dismissConnIssue`。
  ⑥**终端选中文字交给对话**：`onConversationInsert(tabId, text, {send})` 由父级按 `surfaceModeRef` 分派（聊天层 `externalInsert`
  进输入框或直接发；终端层 bracketed paste / sendMessage）。
- **恢复前核验会话已落盘（2026-10-17）**：claude-code / codebuddy 用 `--session-id` 预分配 id，但第一条消息前不落盘——
  启动后没聊就停、启动即崩时，Run 上记着 id、盘上没有这段对话，按 id 恢复只会报「No conversation found」退出 1
  （测试项目实测：同一条 Run 连续五次恢复失败）。`pty_spawn` 收到恢复请求先查 `sessions::fixed_id_session_exists`：
  确定没有就丢掉恢复、开新 `--session-id`，并 `runs::replace_unwritten_session` 把 Run 的会话换成新 id（Run 当前会话是旧 id、
  或同样没落盘才换，绑着真实对话的不碰），回传 `resumeUnwritten` 让终端提示一句。判不了的家（布局未核实）返回 None 照常恢复，
  宁可放过不误判；配置目录搬迁变量（CLAUDE_CONFIG_DIR 等）与默认目录都查。
- **收缩行提示与错误分家（2026-10-09）**：只陈述事实、不需要用户动手的消息（「已接回正在跑的进程，画面大小先不动」）走独立的 notice 态——灰字、不进 `compactBarUrgent`、进程退出即清。**禁止塞进 `error`**：error 会把收缩行强制顶出来（用户点「收起此行」永远收不起来，2026-10-09 实测）且飘红冒充故障，还会经 `error ?? "恢复会话失败…"` 兜底把接回提示错报成发送失败原因。需要用户动手的（「该 CLI 不支持启动注入：指令已复制」）才允许走 error 拦隐藏。
- **启动栏窄宽度防覆盖（v3.137）**：Agent/连接/模型配置组允许收缩，控件宽度按窗口响应式钳制；技能/MCP/运行/更多动作保持独立不覆盖，恢复任务与 `⋯` 使用稳定间距。标签栏和启动栏不共享绝对定位或负边距，窄窗口只允许换行/截断，不允许按钮互相覆盖。
- **启动栏层级间距（v3.138）**：启动配置条与顶部终端标签之间保留明确的垂直留白（TerminalView 上内边距），恢复态的技能/MCP/运行/更多状态行不再贴住上一栏下边框；Agent、连接、模型选择器使用较窄的响应式宽度，不因窗口变宽而放大到挤压动作区。
- **启动配置条内容宽度（v3.139）**：Codex/连接/模型外层容器按内容宽度收缩，不再用 flex 增长占满整行；仅在窄窗口时允许收缩/换行。恢复态动作行额外保留上间距，避免视觉上盖住标签栏下边框。
- **启动栏右侧动作组（v3.140）**：技能、MCP、运行/恢复和更多按钮统一组成右侧固定动作组，由 `ml-auto` 推到最右；模型异常提示独占下一行，不再挤压或覆盖动作按钮。
- **启动栏选择菜单向下展开（2026-09-22）**：Agent / 配置不用系统 `<select>`。系统菜单把当前项对齐按钮，Grok 在名单末尾时整单往窗口标题上方长。应用内菜单从按钮下沿向下展开（`placeDownMenu`），右侧放不下只左移，下方不够只限高滚动，不翻到锚点上方。收起时只显示当前值，角色词在清单顶上，避免窄宽截成「Agent G」。按下即展开。模型仍是可输可点的组合框，清单同样向下。停用配置仍在清单底部「已停用（可手选）」分组。
- **聊天资源入口不自动发送（v3.130）**：聊天 composer 的技能/MCP 菜单点击只插入提示文本并保留焦点，用户可继续补充后按 Enter 发送；不得直接调用发送链路。终端启动栏的技能/MCP 入口继续只写入 PTY 输入缓冲、不自动回车。全局命令面板/页面快捷键忽略 `input`、`textarea`、`select`、`contenteditable` 和 IME 组合输入。
- **项目 rail 图标语义（v3.129）**：主项目使用 `FolderOpen`；绑定研究流程的工作区使用两位流程序号（01、02…），让步骤先后可扫读；未绑定流程的手动工作区使用 `GitBranch`。不使用抽象斜线或重复 Unicode 符号冒充步骤图标。

- **外部终端安全临时复现（2026-08-21；2026-08-31 Windows 收口）**：外部恢复/提炼接力不得把 profile 密钥拼进命令、剪贴板、前端 IPC 或普通日志。前端只传明确选中的 `profileId`、模型、provider、会话 ID/提示词等非敏感元数据；缺少 `profileId` 时后端必须 fail-closed，不能静默取第一个配置。后端从 `ProfileStore` 读取密钥，复用 `agents::launch_plan`/`prepare_launch` 生成一次性 wrapper。Unix wrapper 存于 `<config>/ccode/external-launch/`（目录 0700、文件 0600，通过 `/bin/sh` 按路径执行），启动首行自删，失败立即清理，60 秒兜底删除。Windows 由设置页二选一（立即生效）：**cmd**（默认）走 `start "Mesa" /D <cwd> cmd.exe /K <binary> <args>`，密钥在父进程环境块经 start 继承、不写 ps1（命令行超过约 7000 字才写无密钥的 `.cmd`——批处理必须单字节编码：前两行 ASCII + `chcp 65001` 后按 UTF-8 读，禁 UTF-16/带 BOM）；**powershell** 走一次性 UTF-8 BOM 的 `.ps1` wrapper + `start powershell.exe -NoExit -File`。两条都经 **`background_command("cmd")` + `raw_arg` 直投 start**。五个坑都别改回去：① 预加引号的复合命令不能走 `Command::args`（Rust 加壳成 `\"`，cmd 对 /C 后文本不认反斜杠转义，start 把 `\"\"` 当程序名）；② 不能直接 spawn powershell/cmd + CREATE_NEW_CONSOLE（dev 实例从 npm/Git Bash 链路继承的 std 句柄是管道不是控制台，会遗传给子进程——TUI 写进管道、读不到键盘，新窗口只剩黑屏光标、agent 随即退出，grok 实测复现；start 经 ShellExecute 拉起时子进程 std 才挂到自己的新控制台）；③ 启动热路径不要同步 icacls（`%APPDATA%\ccode` 默认 ACL 已是当前用户）；④ **start 的窗口标题必须非空**（空标题下 GetConsoleTitleW 返回 0，旧版 libuv <1.52 的 uv_get_process_title 会 assert(process_title) 直接 abort——kimi 这类内嵌旧运行时的 CLI 必崩，win/util.c:412，实测复现）；⑤ **拉起后不能 output()/pipe 收尾**（start 的子进程继承 cmd 的管道句柄，read-to-EOF 会阻塞到用户关掉外部窗口，同步 command 堵死、整个应用未响应；start 立即返回，只 spawn+wait 收外层 cmd，毫秒级）。外层 cmd CREATE_NO_WINDOW 不可见，可见窗口由 start 创建——这是「用户明确打开外部终端」例外。Ghostty 运行中实例使用其原生 AppleScript `new surface configuration`/`new window`：工作目录单独写入 `initial working directory`，先启动 `/bin/sh`，再经 `initial input` 发送带 shell 引号的 wrapper 路径；不能把 `Application Support` 等带空格路径直接放进 `command`。该路径不依赖 System Events 辅助功能权限或剪贴板；未运行实例使用 `open -na`。iTerm/Terminal.app 只接收不含密钥的启动命令。复制命令继续保持全局配置模式，不自动携带 profile 密钥；Windows 复制的是 PowerShell 方言。
  **2026-10-17 外部终端补三条**：①应用探测认 `/Applications` 与 `~/Applications`（`mac_app_installed`，免管理员装的 iTerm / Ghostty 在后者）；
  ②iTerm 写进 `create window` 返回的那个窗口（`iterm_script`），不写 `current window`（焦点在别的窗口时会打进用户正在用的窗口）；
  iTerm 未运行时等它自己开的窗口（≤3 秒）再用，不另建第二个——本机未装 iTerm2，AppleScript 只有文本单测，**未实机验收**；
  ③复制恢复命令的文案不得写「粘贴即可」：它用终端的全局配置，Claude 会换到全局网关 / 模型、Mesa 连接开的 Codex 对话缺
  `CODEX_API_KEY` 接不上（toast 点名），要原连接走「在外部终端继续」。**外部终端里正在跑的对话**（`SessionMetaDto.live`：
  文件一分钟内有写入、Mesa 没开这个标签）在 Mesa 里点继续先 `confirmDialog`（默认焦点取消），防两个进程交错写同一段记录。

- **定时历史评审（2026-09-07）**：有 watch Run 身份时先打开冻结产物对照，三列是执行前主仓、执行前隔离目录、本次结果；
  仅四类台账可在这里采纳。另点「查看当前工作目录」才进既有只读 Git 评审，标题明确不是历史快照，该视图不得保留旧的直接采纳按钮。
  无证据/失败任务不开放自动采纳，内容以纯文本显示；保留返回与当前目录入口，不影响底层 PTY 挂载。
- 「停止」或 agent 退出后必须**自动回落用户登录 shell**（`$SHELL -l`，同 cwd），不死在最终画面；手动 `exit` 不自动
  重开；回落 shell 不带 profile env；agent/shell 共用 `pty.rs` 的 `spawn_tracked`，退出事件按 PTY 类型区分。
  同一次会话：第一条真正的用户问题出现后先无头写临时标题（只给还没标题的会话，重开旧对话不重起）；用户说到第 3、第 8 句（`autoTitleMilestone`）与 Agent 退出时再只用用户原话（首条意图 / 中途纠正 / 最后定题）校正，不送助手回复；第一条回复出现时不再校正（材料与临时标题相同）。步骤 / 工作区会话另附背景（项目名、步骤名、TASK.md 一级标题与「课题主题」，`ai.rs title_background`），普通对话不附。材料指纹记 `session_meta.title_basis`，同样的材料不再问 AI；`ai_auto_title_session` 返回 None = 不用起（前端不重试），Err = 问了 AI 没拿到合格标题（前端 8 秒后重试，最多三次）。格式 `MMDD|类型|主题`（创建日上海时区），主题 8–28 字、至少 4 个汉字、对象+动作；已占用的「类型|主题」不得重复。写入 `session_meta.custom_title` 且 `title_source=auto`，不写回 CLI 源文件。人手改过的标题（`title_source=user`）不覆盖；内部会话、内容不足或没有创建日则跳过。失败静默，不挡回落 shell。
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
- **空白运行标签默认家目录（v3.163，改 v3.159）**：无 `initialCwd` 的新标签（第一次进运行、关最后标签）目录是 `~`，不预填当前项目主仓，也不继承 `ccode.lastLaunch.cwd`（那常是 lit-search 等工作树）。点项目 / 工作区才「真进入」该目录。已恢复的任务标签仍用自己记下的 cwd。
  **「＋」例外（2026-10-18 用户拍板）**：「＋」＝在当前项目里再开一个 Agent，目录跟当前标签走（`newTabCwd`）；当前标签在 `~` 或 Mesa 隔离目录（`ccode/workspaces|worktrees|watch-worktrees`）时仍是 `~`——隔离目录各有自己的入口和 Run 身份，v3.163 防的正是误入工作树。
- **Excel 宽表预览（v3.164 / v3.211）**：`.xlsx`/`.xls`/`.ods` 只读网格（列字母 + 行号冻结、横滑看全列；点格子顶栏显示全文）。后端 `read_sheet_preview` 最多 200 行 × 256 列并回 `totalRows`/`totalCols`；xlsx 带合并区（`merges`，前端 `rowSpan`/`colSpan`）。办公弹层表格用更宽窗口、网格自己滚动（不要外层 `overflow-auto` 把表撑破再裁切）。多工作表底栏切换。复杂公式/图/宏仍以 Excel 为准。
- **文件树按后缀搜（v3.158）**：`pdf` / `.pdf` / `*.pdf` 按扩展名匹配（大小写不敏感）；`doc` 同时覆盖 `.doc`/`.docx`
  （ppt/xls/jpg/htm/md 同组）。`.pdf` 与 `*.pdf` 只返回该后缀，避免 `pdf-notes.md` 凑数。后缀命中单独成桶、排在
  文件名包含匹配前面，避免 50 条上限被「名字里有 pdf 的 md」挤掉真正的 PDF。
- **文件树折叠钮与双击进入分离（v3.157 / v3.209）**：单击文件夹名或折叠箭头只在原地展开/收起。箭头连点也要能开合
  （勿用 `e.detail > 1` 吞第二次点击）。~~进入此文件夹（只改浏览根）走悬停「进入」~~（2026-10-24 悬停「进入」撤掉，树不再换根），
  不要靠第二次单击/双击做任何事——两次单击会被系统合成双击。
- **任务审阅 = 终端全宽覆盖层**：工作区行「评审」与终端「改动 → 审阅」同一视图。检索/精读/大纲在基础检查旁切清单或笔记/稿件／过程／文件，Git 对照只在「文件」；冲突模式仍连续浏览累计 diff。可「提交并保存进项目 /
  仅提交 / 保存进项目并归档」；底下终端标签与 PTY 保持挂载。默认只保存进本地项目并保留工作区，不自动推送；原「提交 /
  提交并推送」与工作区行 PR/归档/会话操作保留。`merged_at && ahead == 0` 时按钮禁用显示「已保存进项目」，`ahead > 0` 恢复。
- **冲突审阅与普通审阅共用同一覆盖层**：冲突模式读 Git index stage 2/3，任务/基准分支按文件连续双栏，右侧冲突清单可
  定位，逐文件/全部选边与 ◈ AI 建议同屏；禁第二套冲突解决器；入口用「开始解决冲突」任务语言。全部选边默认串联「提交
  解决结果 → 健康检查 → 合并（保留工作区）」，另保留「仅保存解决结果」；提交成功而合并失败必须提示部分成功，不自动
  重做 merge commit。「解决冲突」后干净工作区必须自动以**当前基准 tip** 准备两侧（完成前禁以 merge-base diff 冒充）；
  处理中基准前进立即停止展示和选边，经用户确认 `merge --abort` 后重新同步。评审入口以 intent 区分
  （`WorkspaceReviewRequest.action`：pr/archive/resolve-conflict）：仅 `resolve-conflict` 允许自动同步基准、准备冲突两侧。
- **评审关掉回发起页（2026-10-23）**：`setWorkspaceReviewRequest` 在 store 层自动记 `fromPage`（同 `readerReq`，调用方不写）；
  关评审（返回、保存进项目后归档）时显式 `returnTo` 优先（定时任务回项目的定时页签），否则回 `fromPage`，运行页自己的入口
  （改动面板）不带回跳。关之前已交出终端请求的（退回修改 / 按意见重写 / 看复现日志，`pendingTerminal` 非空）留在运行页。
- **评审覆盖层以代码为中心**：顶部固定任务/分支/增删统计与唯一主动作，提交信息和批量冲突操作在第二工具行；右侧文件目录默认收起，顶栏「文件列表 / 收起文件」开关，窄窗口仍是抽屉。对照长行换行，不再按 720px 硬撑；左右分栏只在 xl 及以上，更窄时上下叠。diff 连续浏览、标题吸顶、长段未修改折叠，目录打开时选中随主区滚动同步；冲突选边用文件标题下
  紧凑双侧控件，AI 理由单行展示、用户显式执行。**提交信息可留空（v3.97，面向不懂编程的用户）**：留空走
  `defaultCommitMessage` 本地规则默认信息（chore: 更新 N 个文件），不调 AI、不拦提交——评审与归档弹层同口径，
  与改动面板「留空 = 快速提交」、主仓快速提交面板的先例一致；想写更好的点 ◈。
- **改动面板识别合并冲突（v3.180）**：`git_status` 读 `MERGE_HEAD` 下发 `merging`；porcelain 冲突码归 `U`，
  文件列表单独「冲突的」组。条头提供「取消合并」（`git_abort_merge`）。编程页冲突引导去**终端**改动面板
  （页名不用「运行页」），并同样给取消合并出口。
- **改动面板跟随文件树的根，而非终端标签 cwd**（v3.82，用户拍板；2026-10-24 起树根恒等于正看着的对话目录，两者一致）：「我在看哪个目录，改动就显示哪个」——
  FileTree 根切换（切对话）成功后经 `onRootNavigated` 上报 TerminalPage（`treeRoot`），GitPanel 吃
  `treeRoot ?? activeCwd`；切标签/分屏焦点变化时 TerminalPage 主动清空分叉回落标签 cwd（树未挂载时无人上报，必须兜底）。
  对话页签不跟随（对话天然属于终端会话），文件预览沿用 `preview.root ?? activeCwd` 不变。
- （2026-10-24 起标签条退场，本条只剩②布局图标与③状态镜像有效，标签管理与拖拽排序随标签条撤掉，见下文「标签条退场」；`tab-drag.ts` 只剩侧栏项目树在用）
  **标签条只放标签管理 + 布局图标（v3.88 减负，v3.177 再收口）**：原先一行同时挂着
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
  主仓改动提醒、问 AI 带文件）才开右栏；~~用户曾用成果面板按钮钉开（`ccode.terminal.rightOpen=1`）则保持打开~~（2026-10-24 右栏不再钉开），
  否则 `setRightOpen(false)` 只剩终端。判定用
  `useAppStore.getState()` 现查（交接与切页是同一批 store 更新），不依赖 effect 顺序；页内动作
  （单击文件树文件、◫ 工作台、对话联动）照常展开，不受影响。
- ~~**文件树默认可收起（用户拍板）**~~（2026-10-24 文件树并进右栏文件窗格后作废：不再有单占一列的树、`ccode.terminal.treeOpen` / `ccode.terminal.treeWidth` 弃用、「主目录树自动收一次」`collapseHomeTreeOnce` 删除；右栏本就不跨重启、默认收起）。快速开聊 `pt.clean` 只关右栏，不另造专注态。
- **对话头右上角四个与两块宽度（2026-10-24，用户贴 Claude 客户端那一排；「文件、改动是分开的」「可以，改吧」）**：
  右上角是 **>_ 终端**（亮着 = 正看着这段对话的终端）、**± 改动**（`FileDiff`，右栏改动窗格，有改动右上角一个小点、文件数放悬停——那是整个文件夹没提交的数，写大数字像是这段对话改的）、
  **文件**（`FolderTree`，右栏文件窗格）、**⋯ 更多**（分屏对照 / 查找终端输出 / 显示启动配置行〔被收起时〕；原「打开文件预览」项取消，文件钮就是它）。
  **右栏一次只显示一个窗格，没有「文件 | 改动」标签条**：± 与文件两钮互斥亮；亮着的再点 = 收起右栏，点另一个 = 不关栏直接换窗格。右栏**不跨重启恢复**（`rightOpen` 初值恒 false）。
  **文件窗格头 = 固定的「树」标签（图标）+ 点开文件后出现的斜体预览标签**（`FilesView = "tree" | "preview"`，`filesViewPref` 记停在哪个，没有预览时一律显示树）：
  树里单击文件（`openPreview`）= 替换预览标签并切过去；预览标签 × 关掉回树（有未保存改动先确认）；「↑ ↓ 同夹上一个 / 下一个」「未保存 ●」随预览标签。
  **左右并排（同日用户追加）**：文件窗格头右侧的 `Columns2` 钮（`filesSplit`，记 `ccode.terminal.filesSplit`）开了以后，点开文件时左树右预览同时显示（`filesSideBySide = filesSplit && 有预览`，没有预览仍是整栏树）；树栏宽度可拖（`ccode.terminal.filesTreeWidth`，默认 220、最窄 160，预览栏至少留 240），打开开关时右栏还窄就顺手 `expandRight()`。关掉回到「一次看一个」。
  **一期只有一个预览标签**——`preview` 仍是单状态，`previewFiles` 只是同夹兄弟列表（↑↓ 用），不是多标签；多个固定标签是二期，要先把 `preview` 改成列表。
  树与预览都保持挂载、用 `hidden` 切换（树的展开状态、预览编辑器的撤销栈不因切换丢；树不挂载则 `treeRoot` 没人上报，改动窗格会停在旧目录）。树栏头仍有「显示隐藏文件 / 刷新」，不再有「收起文件树」。改动窗格头只写「改动」+ 汇总徽标，内容不动。
  **两块宽度**（纯逻辑 `run-layout.ts`）：对话 ≥ 360px（主角，正文另由 `.ccode-chat-column` 封顶约 52 字、居中）；右栏默认 460px、最窄 360、拖、记 `ccode.terminalRightWidth`。偏好不随窗口被改写，实际宽度每次现算；地方不够时只压右栏。
  「专注内容」＝右栏拉到窗口宽约六成（`expandRight()`；PDF 自动进入也走它），不再有「文件树收起」这回事，树与预览仍是互斥显示、默认不并排（并排会让 PDF 阅读区变窄），要并排用上面的并排钮。
- ~~**成果面板常驻按钮（v3.153）**~~（2026-10-24 取消，见上条）：标签栏右侧「显示成果面板」与左侧文件树按钮对仗；点按切换并写入
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
- **聊天层拉起终端（v3.168 / v3.177）**：聊天与终端仍是同一 PTY 的两层，不是两个会话。拉起 = 底栏真实分栏（约 32% 高度），终端按此高度 fit，TUI 才能画进可见区域。不能只裁全高 xterm 的底部——Codex 主对话是 inline viewport，内容靠上、底下是空行，裁底就是白板。切聊天/终端仍铺满同一容器、行列数不变；**只有拉起开合**会 SIGWINCH 一次（Codex 可能重放历史，这是能看见 TUI 的代价）。默认关；`attention === confirm`、8 秒无会话文件、斜杠 `/model` 无参 / `/models` / `/login`、以及聊天层点 picker 模型时自动打开。**确认态例外（2026-10-20）**：聊天卡上能答的不拉——旁路经官方通道能答（`channelCanAnswer`：Codex / Qwen / OpenCode）、或屏上认出了菜单 / 信任菜单；确认态出现后先等 1.5 秒再判（旁路的审批事件比屏上画出菜单早到，读屏还有 250ms 防抖），过了仍答不了才拉起。用户手动收起后本轮不再自动打开。开关只在聊天头部（「拉起终端」/「收起终端」），不在标签栏菜单重复。不复制九家 TUI 菜单解析器；交接表在 `src/chat-handoff.ts`（chat_ok / peek / must_switch）。
- **聊天层转到终端要记数（2026-10-22 用户「你来做」）**：聊天层的目标是把高频的事做到比 TUI 好用、低频的明确交给终端，补哪一项按真实次数排。
  凡是「聊天层接不住、露出或切到终端」的入口都要调 `recordChatHandoff`（`src/chat-handoff-log.ts`）：自动的只在**真要露出**时记（已露着 / 用户本轮手动收起过不记），
  手动的只在打开方向记（收起不记）。原因是闭集、前后端同名（`chat_handoff_log.rs` REASONS，测试钉住），细分只给短标识（确认卡种类等），
  **不得把屏上文字、命令、路径塞进细分**。新增露出 / 切终端的入口必须同步选一个原因或加新原因（两端 + 说法 + user-guide §13.9）。
  分屏、查找终端输出、上手引导切终端、恢复占位看离开时的画面不算（那是终端自己的功能，不是聊天层接不住）。查看在设置「诊断」，诊断包附同一份计数。
- **聊天等待态与历史窗（v3.168；2026-10-21 改写）**：生成中那一行不再按「已送出 / 正在生成回复 / 正在用 {工具}」分阶段说，改说这一轮在做的事（`chat-status.ts`，规则见 design-system「生成中那一行」）；取数先用旁路快照的 `activity`（正在跑的工具，chat_channel.rs 按工具开始 / 结束登记，开始写正文或一轮结束清空）与 `thinking`（Codex 推理摘要、Qwen / OpenCode 思考增量；工具开始或正文开始清空），没有旁路的家用会话文件里还没回结果的调用与计划。卡住 8 秒无会话文件仍写「会话文件还没出现」（`CHAT_NO_SESSION_TEXT`）。「看实时输出」（露出终端：聊天层按会话文件一段一段同步，终端是逐字的）只给没有实时预览的家、且安静满 10 秒才给。工具块一旦进会话文件立即渲染，不必等 assistant 正文才结束等待。聊天主区展示会话文件尾窗（后端 192KB 分页），可「加载更早的消息」；完整回放仍走对话页。压缩会话（zstd）没有更早一页。JSONL 超长行（Codex 工具输出常 >192KB）必须整行跳过，且空窗在同一请求里继续往前，禁止把 cursor 钉在行尾。
- **聊天空态（v3.214）**：未开始时头部不写「等待会话文件」（`chatHeaderStatus`：没跑、也没消息则空着；可恢复占位除外）。画布不写「从一个问题开始」、**不加点阵**。输入框占位「问一个问题…」，目录短句收进 composer 底栏「将在 … 开始」（点选目录，`welcomeCwdLine`）。＋新建 / 历史等会话建立后才出现。模型芯片未启动不做成假下拉。画布内容见 design-system「聊天空态内容」（2026-10-17：最近在这个目录 + 试试，贴输入框上方）。
- **只看不接（2026-10-23 侧栏挂对话第一期）**：列表里点一段对话（侧栏项目树、工作台「最近对话」、对话页「继续」，统一 `openConversation`）
  派 `pendingTerminal.resume` + **`resumeLazy`**：新标签 `autoStart=false`、标 `preview`；切到已有标签时不 kick（不重启）。`TerminalView` 对
  「带 resumeSessionId、没起进程、linkState=idle」的标签按本机会话列表里的 `filePath` 读一页 `get_session_conversation_page` 摆出来
  （`launchPick.preview` = loading / shown；只在标签可见时读，重启后一排占位不一次全读；读不出退回「这段对话还没接回」一行），往上翻走同一份文件。
  **发第一句才接回**：走恢复占位同一分支（launch + 1.2s 后写入）；接回途中 `resetLink` 不清摆着的记录（`keepPreviewConvRef`），接上后由
  SessionLink 整份替换，不闪回空态。聊天层左下写「发一句就接着聊」（2026-10-24 起；原「发一句就用 〈连接〉 接着聊」），
  **底部照常摆权限与「模型 · 思考」芯片、能改**（`launchPick.resumePick`：只看不接、没起进程；ChatModelMenu launch 形态但 Agent 锁定、不列「最近用过」，
  底部说明「发第一句时按这里的选择接回」），默认就是这段对话上次的：连接 `resumeProfileChoice`（会话自己的 `session_meta.profile_id` → 原 Run → 项目「对话」槽 / 默认），
  模型与思考档 `session_resume_config`（模型取会话文件最后一轮实际用的，复用用量提取器；思考档 Codex 取 rollout 每轮 turn_context.effort，别家用 Mesa 启动时记的
  `session_meta.launch_model / launch_effort`——`lockLink` 连同连接一起记）。源文件不在的不进运行页，去对话页看快照。
  **「别的终端在写」误报**（2026-10-24 实证：关掉刚起的 Codex 标签，一分钟内从侧栏点它就弹）：Mesa 里有标签持着这段（`liveSessions` 或 `terminalRunInputs`
  的 sessionId，含还没登记完的、只看不接的）直接切过去；最后一笔不晚于 Mesa 停掉它的 Run 收尾 + 5s（`lastWriteIsMesas`）不算外部在写。
  发过第一句、Agent 起来后清掉 `Tab.preview`，Agent 之后退出也不会被当成看了没说的收掉。
  **丢弃型标签**（`isThrowawayTab`）：只看没说的 preview 标签、还没说过话的空白随手聊标签，输入框没字没附件（`ChatComposer onDraftChange`
  上报），从列表点开别的对话或经 `focusTab` 跳到别的标签后收掉（`dropBlankAfterOpenRef`，等新标签到前台再关；分屏右栏那个不收）。
  运行页正看着的标签镜像进 `terminalActiveTabId`，`RunOverviewInput.sessionId` 带上标签接着的会话（含要接的），侧栏据此亮点、认选中。
- **标签条退场（2026-10-24 侧栏挂对话第二期，用户「按计划开修」）**：运行页不再画标签条，标签只是运行时容器，**开着的东西列在侧栏**
  （design-system「侧栏挂对话」第二期）。顶上是对话头，只写 `focusedId` 那段；关标签只剩两条路：侧栏开着的行 ×（新对话 / 终端）、对话 ⋯「停下 Agent」——
  都经 store `closeTabReq` 交给运行页 `requestCloseTab`（在跑的照旧确认；对话头 × 同日三改撤掉）。
  **项目说明附在第一句前**（同日三改，用户：「这个项目说明就是对话注入吧，相应的设置是不是要改」）：发第一句才启动的那条路（`sendMessage` 末段）
  按当时的 cwd 现查——是已添加的项目就按它的「项目说明」三态（原对话注入，`loadProjectContextPack` kind session）拼好附在第一句前；项目行 ＋、新对话在输入框里换到项目
  一视同仁，不再由入口预先塞包（`launchPack` 撤掉）。切换：侧栏点行 / `focusTab`、⌃Tab / ⌃⇧Tab（MRU，capture 阶段拦在 xterm 之前）。
  分屏：`pendingTerminal.split`（对话 ⋯「在右侧分屏打开」）——正看着的留左 pane、这段放右 pane，两边都不按丢弃型收。
  **空闲自动收**（用户拍板 A，`idle-stop.ts`）：每分钟一检；普通对话（新对话入口、`resume:` 接回、无复用键；有 `stepName / taskId / customRuntimeId` 或
  ws/lane/reader/login 等键的各有收尾，不收）Agent 在跑、注意力不是 working / confirm、不是活跃 / 分屏右栏、输入框没字，连续空闲满 30 分钟 → 收掉标签
  （等于关标签：PTY 结束、Run 记「用户主动停止」）并 toast 一句；一次收一个。纯终端一律不收（可能跑着开发服务）。
  **重启只回到上次那段**：恢复占位仍按存档建出来，挂载后除活跃那个外逐个 `pty_id_for_run` 查进程，不在的（应用重启过）收掉、drop 回放；
  网页重载（开发热更新）时进程还活着的照旧 adopt。
- **聊天层模型/思考档与拖入（v3.168）**：头部模型菜单与状态栏同一套 `modelSwitch`/`effort`（直切写 PTY 命令；picker 写命令并窥视）。拖入文件进聊天输入框（一行一个路径），盖住终端的坐标不再写 PTY。Kimi 的 CSI-u Enter / Ctrl+V 序列集中在 `terminal-input.ts`（`KIMI_CSI_U_ENTER` / `KIMI_CSI_U_CTRL_V`）。
- **表层默认（2026-10-22 起由设置决定，`tab-surface.ts`；2026-10-17 起聊天为默认，此前 09-02–10-17 为终端）**：设置「外观 → 打开对话时先显示」（`openSurface`，缺省与未知值 = chat）。pendingTerminal 落标签时经 `launchSurface` 定层：纯 shell / 预填命令（登录、更新、run 脚本）恒终端；入口写死 `surface` 的照写——只许两类：「新对话」固定 chat（选 Agent / 模型在聊天空态），没有对话可看的固定 terminal（MCP 登录、自定义运行时、「去终端看看」）；**切回已开着的标签不动它当前的层**（人切过的算数）；新开的按设置并当场钉住，之后改设置不翻正在用的标签（不经 pendingTerminal 开的「＋」、重启恢复的标签不钉，跟当前设置）。凡进入 Agent 对话的入口（问 AI、开始、跟 AI 商量一下、聊想法、继续、对话页接着聊、接力、精读）**禁止再写死 surface**——10-17 改默认时商量 / 聊想法 / 继续因写死终端漏改，用户看到「有的跳聊天有的跳终端」。恢复占位标签在聊天层由空态「这个标签上次的对话」给接着聊 / 看离开时的画面，直接发送会先按原会话恢复、等 1.2s 再写入（恢复启动忽略首条注入，不能带 prompt 启动）。纯 shell/脚本标签（官方账号登录、CLI 自更新、run 脚本——shellOnly/prefillCommand）创建时仍显式置终端面，守住「默认值再变也不回到 chat 盖住登录输出」的口径；agent 启动被会话前确认卡住（信任此目录/登录菜单，attention 门控要求 sessionFile 存在、管不到这段）时，聊天空态 8 秒无会话文件即显示「终端里可能有待处理的确认」+「打开终端处理」出口（8s 延迟防正常启动误闪现）。
- **聊天资源入口（v3.126，v3.130 修订）**：聊天 composer 与 TerminalView 复用当前 Agent 的技能/MCP 清单。点技能或 MCP 只把提示插入聊天输入框，不自动调用发送链路；用户补充后按 Enter 才写入当前 PTY（未启动时沿用自动启动/首条 prompt 语义），MCP 菜单可跳转 MCP 管理页；不复制终端专属 TUI 菜单解析器。
- **聊天发送链路（v3.125）**：Enter 发送、Shift+Enter 换行；运行中的 Agent 直接写当前 PTY，已结束会话自动 resume，未启动标签自动启动并把首条消息作为启动 prompt。Kimi 等不支持启动注入的 CLI（2026-10-20 改）不再切到终端、不复制、不报错：先不带指令启动、启动栏照常收起，等输入框就绪（`waitAgentInputReady`）后把首条消息当普通消息写进 PTY，与之后每句同一条路（「重启为可写」的分叉摘要同理）；终端启动栏「启动」与任务卡等其它入口仍走「指令已复制、手动发送」；终端专属确认、登录和选择器统一提示「需要终端操作」，不复制脆弱菜单解析器。
- **聊天输入法 Enter（v3.168）**：组词未上屏时的回车只确认候选，不发送。WKWebView 上确认候选的 Enter 在 compositionend 之后、`isComposing` 已是 false，只看 `isComposing` 会误发——组词锁 + keyCode 229 + compositionend 后再留一帧（`ime-guard.ts`）。
- **聊天回复反馈（v3.131）**：发送成功后先显示本地用户消息并展示「Agent 正在处理…」加载状态；会话文件刷新时保留尚未落盘的本地消息，只有检测到发送之后的真实 assistant 消息才结束加载。等待回复期间使用约 700ms 的短兜底刷新，防止单次 watcher 事件丢失导致回复永远不进入聊天层；回复到达后立即停止该兜底刷新。2026-08-24 起本地消息从单条改为队列（pendingUsersRef）：连发多条全部保留，已落盘的逐条移出，全部落盘且等到新回复才结束等待；兜底轮询有 3 分钟超时。
- **聊天层审批卡片与暂停（2026-08-24；2026-09-13 停止与发送同体）**：注意力 confirm 时横幅升级为审批卡片——详情文案来自 hooks 日志 payload 的 `message`/`tool_name`/`title`（`session_confirm_detail` command，与 state_for_session_file 同一套门控；payload schema 各家未文档化，取不到回通用文案）；✓ 批准 / ✗ 拒绝 / Esc 取消三个按键经 `writePty` 写单字符（y/n/\x1b），是保守热键集，按键无效引导「打开终端」。
  **2026-10-18 第三期修订**：七家审批菜单逐家抓屏后，这一轮没结束前（armed / pendingReply）一直扫屏认菜单（`parseTuiMenu`，排除用户刚发的
  编号清单回显 `menuEchoesText`；**比对的原文在写进 PTY 之前就记下**——多行正文粘进输入框到按提交之间要等 0.65 秒，Grok 的输入框画着方框、回显行首是 ❯，正好是菜单的样子，原先拿上一句比对，七步清单在输入框里时出了一张「终端里在等你选一项」，2026-10-21 用户截图；终端窄时截断补「…」的行去掉「…」再比；**启动参数带进去的开场话也记进比对原文**，2026-10-25 Claude 2.1.308 把它留在输入框里、折行被认成五个选项；没有序号、上下紧贴两条横线的「❯ 块」是输入框草稿，直接不认），认出来就按菜单原文给按钮、`answerMenu` 方向键 + 回车代选；y / n 两键只在认不出菜单时兜底——
  Claude 2.1.292 按 y 没反应（实测），各家都只保证回车 / 方向键 / 序号。独立「⏹ 打断」已删：正在生成时发送钮变「进行中」符号钮，点击写 `\x1b`（Esc 暂停当前回合，会话保留；不是 `\x03` 硬中断）。暂停后清掉「等待回复」，发送钮变回发送，下一句仍写进同一 PTY（和 Codex 按 Esc 再继续一样）。只在 `attention === working` 或等待回复时出现，进程活着但停在提示符时仍是发送；审批 confirm 时 Esc 归审批卡。
- **Windows 清屏补清回滚区（2026-10-21）**：Ink 系 CLI 用的 ansi-escapes `clearTerminal` 在 Windows 是 `ESC[2J ESC[0f`，不带 macOS 的 `ESC[3J`；
  Gemini 回复超过一屏时进「整屏重画」（清屏 + 全部历史 + 动态区）每帧一次，回滚区就叠出一份份历史（ConPTY 原样转出；实录一段 60 行回复重画 251 次，
  xterm 回放：修前横幅 252 份 / 8944 行，修后 1 份 / 85 行）。`terminal-protocols.ts consumeHostSequences` 把这对序列补成 `ESC[2J ESC[3J ESC[0f`，
  切在两帧之间先扣住再补；与 macOS 同效果，不分平台（macOS 上不出现这对写法）。
- **聊天写入 PTY（v3.133）**：聊天发送必须取 `TerminalView` 当前 `ptyIdRef/ptyKindRef` 作为目标，不依赖异步状态镜像；文本和提交键通过后端 `pty_write_submit` 写入，文本先遵守 bracketed-paste 规则。2026-08-24 起正文与提交键分两次写、中间留间隔（spawn_blocking + thread::sleep，不占主线程）——背靠背写入时开了 bracketed paste 的 TUI 来不及把粘贴内容收进输入框，回车会被吞掉。**间隔不得低于 150ms，现取 250ms（`pty_input::SUBMIT_GAP`）**：Codex 把连着到达的字当粘贴，粘贴后 120ms 内的回车只换行不发送（2026-10-20 Windows 实测：原 60ms 下聊天层发给 Codex 的话留在输入框里；`E2E_SUBMIT_GAP_MS` 可在 chat_channel e2e 复核）。**正文是粘贴包（多行）时提交间隔取 650ms（`PASTE_SUBMIT_GAP`，2026-10-21）**：Qwen Code 在 Windows 上开着 pasteWorkaround，粘贴后 500ms 内的回车一律吞掉（InputPrompt `recentPasteTime`），250ms 时多行消息停在输入框没发（ConPTY 探针 250ms 复现、600ms 通过）；单行不包粘贴，照旧 250ms。恢复会话路径发送前再额外等 1.2s（进程引导/会话回放/信任提示期写入会落在未就绪的 TUI 上）。**发出后核对交没交出去**（2026-10-24 HER 润色实证：Mesa 重启后步骤上「让 Agent 按决定继续」，接回的 Claude 输入框画出来 1 秒内就写进去，回车被吞，整段意见留在框里）：有画面布局表的家，这句末尾一段连着 1.6 秒还在输入框里就再补一次提交键，最多补两次（`live-reply.ts sentTextStuckInBox`，TerminalPage `confirmSubmitted`）；多行粘贴显示成占位的认不出，不补。同日二次实证（接回后先写「※ recap」，输入框画出 2 秒就写入，开头丢一截，之后人按回车也只多一行、出「ctrl+g 编辑」提示——CLI 停在粘贴状态）：刚起来的 20 秒里输入框要安静 1.5 秒才算就绪；补提交前先补一个粘贴结束标记 `ESC[201~` 把它拉出粘贴状态，最多补三次。普通 CLI 使用 `\r`，Kimi 继续使用 CSI-u Enter。**多行正文的换行**（2026-10-20 Windows 八家逐个实测）：ConPTY 会转出 `?2004h`，粘贴包照常包；包里的换行默认写 LF（Claude / Qwen / Gemini / Kimi / CodeBuddy / OpenCode 都保留成换行，2026-10-21 复测），**Windows 上的 Grok 改写 CR**（LF 会被它丢掉、两行连成一行；`pty_write_submit` 的 `paste_newline`，pty.rs `chat_paste_body`），**Windows 上的 Codex 改送 Shift+Enter 按键记录**（`paste_newline: "shift-enter"`，pty.rs `shift_enter_pieces`；2026-10-21 Codex 0.163 复测：LF 被丢、几行连成一行，CR 拆成几条消息各自发出，Shift+Enter / Ctrl+J 记录三行原样——10-20「Codex 保留 LF」已不成立）——不得统一改 CR：CodeBuddy / OpenCode 会把字写错位。macOS 不改。
- **聊天层常驻挂载（2026-08-24）**：ChatSurface 不再随 chat⇄terminal 切换卸载（display:contents/none 仅隐藏），输入框草稿、滚动位置、ConversationView 展开状态切层不丢；ChatComposer 的一次性 autofocus 改为 `focusWhen` 可见性信号（隐藏态 focus() 被浏览器忽略，不会抢终端焦点）。AI 正文经 ChatMarkdown 渲染 Markdown（安全口径见 safety.md），超长未展开仍保持截断纯文本 + 展开按钮。
- **会话同步（v3.125 / v3.168）**：关联成功后优先注册专用 session watcher，普通 JSONL 监听目标文件目录，OpenCode 监听数据库与 WAL；事件短防抖后通知前端，前端用会话文件尾窗替换最新一页并与已向前翻页的旧窗去重拼接。签名轮询保留为 watcher 失败或丢事件时的兜底，并以请求代次防止旧读取覆盖新消息。同步状态显式区分识别中、已监听、等待文件、兜底轮询。
- **分叉聊天（v3.125）**：新建聊天只在已有 session 文件和 session ID 时启用；复用结构化接力简报与 handoff 链，不复制完整原始历史。新标签继承 Agent/连接/模型/目录，默认聊天模式、自动启动、只读；不支持原生只读参数的 CLI 标注「提示约束」。点击「允许修改」确认风险后停止只读 PTY，以同一摘要和配置重启可写会话，原会话保持不变。
- **启动栏与状态栏分工（v3.91 / v3.213）**：启动栏主流程 Agent → 配置 → 模型 → 启动，技能/MCP 胶囊右对齐在启动行末端；
  工作目录不占启动栏。未启动时：空态卡写「将在 … 启动/恢复」（点击弹目录菜单：随手聊 → 最近已添加项目 ≤6 → 主目录 → 选择文件夹…，当前项打勾，`welcomeDirChoices`；2026-10-17 起，原为直接弹系统选目录窗）；底栏只留状态点 + 目录胶囊
  （点开浮层可键入路径，支持 `~`）。运行/shell 中 cwd 由 pty_get_cwd 4s 回写跟随，shell 里 `cd` 即可；
  底栏此时才显示 agent · 配置 · 模型芯片 / git / token。
  **空态卡（v3.93 收敛 + v3.213 去重）**：无顶部图标盒、**无 agent/配置身份行**
  （同一事实只说一次，身份归启动栏）。唯一一行说明是「在聊天里发出第一句时自动运行」，主按钮「现在运行」
  （2026-10-18 用户：快速开聊落到聊天层，切到终端像没启动的坏标签；恢复占位不写这行、按钮仍是「恢复任务」）。卡片 `w-80` 走 `.ccode-well` + 极浅勾边，不加投影/毛玻璃；
  画布垫 18px 点阵。主按钮宽 `min-w-40 px-5` 自适应内容——勿按比例（w-2/3）随卡片宽缩放。
  纯逻辑 `src/terminal-welcome.ts`。
- **文件树系统目录置灰（v3.91）**：`list_dir` 对家目录直下命中平台清单的目录（macOS：Library/Applications；
  Windows：AppData 等）标 `isSystem`，前端行 opacity-50 + title 注「系统目录」；普通用户目录不置灰，交互不变。
- **左栏只剩这段对话的文件（2026-10-24 用户「左侧的这个上下文重新做一下，没必要的就删了」）**：栏头一行就是**目录名**
  （随手聊写「随手聊」、主目录写「主目录」；在工作区分支里标「分支」，主仓库是常态不标），行尾显示隐藏文件 / 刷新 / 收起；下面搜索框与树。**树根恒等于正看着的那段对话的目录**，
  切对话才换根。撤掉：项目区 `ProjectRail`（与侧栏项目树重复，连同 `project-rail.ts` 删除）、搜索行「最近项目」⌄、悬停「进入」钻取、「← 上一级」、
  「回到当前目录 / 正在浏览…」、主项目 ⇄ 分支互切、悬停 ↗。搜索命中改为从根逐级展开到那一项并亮一下（不换根）。
  「在此打开新终端」（树右键、项目 ⋯「在终端打开」、项目文件页、步骤 ⋯「在终端打开工作区」）一律开**纯终端**（`shellOnly`），不再借 `enterCwdReq`
  去改正在聊的那段；`enterCwdReq` 只剩「进这个目录」：正看着的是空白新对话就挪过去，否则另开一段。
- ~~**终端左栏两段化（v3.42 / v3.208）**~~（被上条取代）：常驻 = 项目区（ProjectRail）+ 文件树；「打开的标签」折叠区已删除（runInputs 镜像保留）；
  「最近项目」收进文件树搜索行 ⌄ 浮层（真进入/↗ 新标签语义不变）；区间靠留白分层。**文件树一次只跟当前标签一棵**。
  **项目区**列出：科研活跃工作区所在仓 ∪ 正在跑/等确认的已添加项目（含编程工作树、办公目录归属）∪ 当前标签所属项目；
  当前项置顶标「当前」。不铺编程工作树/办公文档。纯逻辑 `src/project-rail.ts`。行内交互（真进入/悬浮/size-2 状态点）不变。
- **右栏可调分栏，不新增普通内容全屏路由**：左缘拖拽调宽并记忆；**宽度上限不写死像素**（v3.60 前曾限 820px），
  随窗口自由拉宽、只给中带终端保留 340px 最小宽度（`TERMINAL_MIN_RESERVE`），下限 360px；宽屏动作暂隐工作树但保留终端，再执行恢复，双击
  对话/预览/改动页签同义；宽度变化必须触发 xterm 重新 fit；任务评审仍用全宽覆盖层。
- **终端渲染器：自动档两个平台都走 WebGL（2026-10-22 用户拍板，取代 2026-09-19「Mac 默认 DOM」）**：设置页
  「终端 → 终端渲染」只剩两档——「自动（WebGL）」（默认）与「兼容（DOM）」；旧设置里的 `webgl` 与自动同义（显示成自动，
  后端闭集仍收），`dom` 显示为兼容。单一出处 `src/terminal-renderer.ts`（`wantsWebglRenderer(setting)`，不再看平台和 agent，
  原 Mac 上 Gemini 例外随之取消）。选择在**新开的终端**生效；WebGL 仍过 `isSoftwareWebGL` 探针（软件渲染闪烁时退回 DOM），
  上下文丢失时退回 DOM 并重挂滚动按行挪位，窗口重新聚焦 / 可见时预算重试 ≤3 次。canvas 渲染器 addon 只声明支持 xterm 5，不引入。
  **为什么改**：2026-09 判 WebGL 在 WKWebView 里偏软（图集按整数设备像素取整单元格，字宽 7.8 压成 7.5）。2026-10-21 复测
  （xterm 6.0 + addon-webgl 0.19，macOS 27 WKWebView，JetBrains Mono 13px）同一段文字锐度量化持平（梯度/墨迹：浅色 DOM 0.880 /
  WebGL 0.893，深色 0.819 / 0.829；半调像素占比同为 0.71–0.74），「偏软」已复现不出；DOM 反而在行高 1.2 下把框线（─ │ ┌）
  画成虚线、半格方块（▄ ▀）留缝，滚动时逐行建 / 拆 DOM 也更慢。剩下的差别只有单元格宽：addon-webgl 按
  `floor(字宽 × 像素比) + round(letterSpacing)` 取整，Retina 上 7.79 → 7.5（窄 3.8%），1 倍外接屏 7.79 → 7（窄 10%）。
  `webglLetterSpacing` 在小数部分 ≥ 0.5 时补 1 个设备像素改成就近取整（两种屏都是 8.0，宽 2.6%），只在 WebGL 生效时设、
  退回 DOM 回 0；字号字体、像素比变化与字体加载完都重算。DOM 的好处只剩字宽按实际排、带字体连写（`=>` 画成箭头）。
  复测脚手架：Swift 起 WKWebView（关窗口遮挡检测才有 rAF）截图 + 逐像素量锐度，见 architecture §10 当日条目。
  **别把「触控板合帧」说成提速**——合帧只砍同一帧内的重复位置写入，每帧重绘次数不变。
- **聊天层盖住时终端停画（2026-10-21）**：聊天模式且没拉起终端时，聊天层整片盖在 xterm 上，但 xterm 照样每帧重画。
  xterm 按 IntersectionObserver 判断画面可见、看不见就停画并在重新可见时整屏重画一次——给 xterm 宿主加
  `content-visibility: hidden`（`coveredByChat`）即可让它停；`visibility: hidden` 停不了（WKWebView 实测：盖住期间 20 次写入，
  visibility 照画 19 帧，content-visibility 与移出视口都是 0 帧，揭开后内容一致，DOM 与 WebGL 两种渲染器同）。
  尺寸不变、行列数不变，**缓冲照常解析**——信任菜单、实时回复、连接错误、模型读回都读缓冲不读画面，不受影响。
  被盖住的 xterm 不可聚焦，`term.focus()` 成为空操作，不再从聊天输入框抢焦点。不要改成移出视口：
  `focus()` 会把 overflow 容器滚过去，揭开后画面错位。
- **盖住且不自动启动的标签晚一帧建终端（2026-10-26）**：侧栏点开只看的对话、重启恢复的占位标签，首次可见时被聊天层盖着、
  也不自动拉起 Agent，xterm（含 WebGL）推到画完一帧之后再建（`deferTerminal`）。开发版实测每次点开新对话第一帧卡约 140ms，
  其中建终端约 30ms（开发版 StrictMode 再建一次），对话记录要等它建完才上屏；推迟后记录先出、终端下一帧再建。
  切到终端层或要自动启动的照旧当场建；依赖 `everVisible` 的启动类 effect 必须把它放进依赖，否则推迟期间到的触发会丢。
  **同日改为用到才建**：只看不接、被聊天层盖着的标签不建 xterm——切到终端层 / 窥视时建，发第一句接回时 `launch` 先 `ensureTerminal()`
  现建（等它挂好再等一帧让 fit 量到真实大小，最多等 2 秒）。原先第一帧之后照样建，每点一段只看的对话仍白建一个、切完紧跟一次约 30ms 长任务。
  有 `resumeKick` 的不推迟（要立刻拉起）；恢复占位标签的目录检查不再等终端建好。
- **终端输出走通道 + 流控（2026-10-21）**：PTY 输出不再走 `pty-output-<id>` 事件（JSON 拼进一段脚本执行），改由前端 attach 时
  新建 `Channel` 交给 `pty_subscribe`：小于 8KB 的帧仍按 JSON 字符串直接执行，≥8KB 的帧发原始字节（Tauri 用 fetch 取回，
  不转义、不拼脚本），前端用 `TextDecoder` 解码。后端 sink（`OutputSink`）把通道与隐藏期 backlog 放同一把锁：没接上通道或不可见
  都进 backlog，接上 / 翻成可见当场补发，补发严格先于实时块。**流控照 VS Code**：前端每帧在 `term.write` 回调里计数，攒满
  5000 字（`OUTPUT_ACK_CHUNK`，必须 ≤ 后端 `FLOW_LOW`）发一次 `pty_ack`；后端已发未确认超过 10 万字（`FLOW_HIGH`）读线程停读，
  降到 5000 以下再读——子进程写不出去自然减速，刷屏时 Ctrl+C 立刻见效。计数单位两端都是 UTF-16 码元（`string.length` /
  `encode_utf16`）。隐藏标签进 backlog 不计数；换通道、转后台清零；关标签 / 退出 `close` 放行；停读期间 5 秒没收到任何确认
  视为前端失联，记一条警告后放行，不让子进程卡死在写上。**记账必须先于发送**（`send_counted`，发送失败再退账）：前端收到帧立刻确认，确认可能在 `channel.send` 返回前就到，先发后记会让确认落在 0 上被吃掉，随后记上的字数永远没人抵消、读线程白等 5 秒。`pty-exit` 与后台标签的 `pty-signal` 仍是事件。
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
  **合成事件必须显式带 `wheelDeltaY: -deltaY`（2026-10-21）**：Chromium / WebView2 给合成 `WheelEvent` 填的旧字段
  `wheelDeltaY` 与 deltaY **同号**（真事件反号），xterm 的 `StandardWheelEvent` 先读它——Windows 上鼠标滚轮全是像素模式、
  每一格都走合帧，于是普通缓冲里的滚轮整个反向（Edge CDP 实测：合帧前正确、合帧后反向、补字段后正确）。WebKit 默认就是
  -deltaY，macOS 不变；别改成累加真事件的 `wheelDeltaY`（WebKit 约是 -3×deltaY，Mac 会快三倍）。
  **清回滚区重画保住阅读位置**：输出帧带 `ESC[3J`（Ink 超一屏的整屏重画；Windows 由 consumeHostSequences 补上）且用户
  正往上翻时，写完按原行号 `scrollToLine` 放回——不放回的话 xterm 每帧把视口钉到新历史最顶端，往下滚被拽回去。
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

- **聊天层结构化旁路（2026-10-20，`chat_channel.rs` + `src/chat-channel.ts`；设计与实测 docs/design-chat-structured-channels.md）**：
  运行方式不变（PTY + TUI，终端是事实来源），`pty_spawn` 起进程前按家改启动参数接 CLI 自带的结构化旁路，快照以
  `chat-channel-<tabId>` 推给前端（150ms 合并）；**任一旁路起不来就照旧启动、不接**，聊天层退回会话文件 + 读屏。逐家：
  Claude Code / CodeBuddy = `--settings` 带 hooks（`hooks::launch_hooks_value`，与用户 hooks 合并）；Qwen = Dual Output；
  OpenCode = `--port` + `OPENCODE_SERVER_PASSWORD`；Codex = 私有 app-server（ws + 能力令牌）+ TUI `--remote`；开了全局开关的
  Gemini / Kimi / Grok = 同一份状态日志按标签号过滤；**没有别的旁路、CLI 支持程序状态的家 = OSC 7501（2026-10-22，`program_status.rs`，
  旁路 kind `program-status`）**：Grok ≥1.0.60（没开全局 hooks 时）、Claude Code ≥2.1.295（hooks 起不来时）；**Windows 不接**
  （2026-10-25：ConPTY 两个方向都吞 OSC，同下文「OSC 底色握手」那条——本机 Grok 1.0.67 经 ConPTY 的输出里只剩 OSC 0 / 12，探询与报告都过不来，
  接了只是一条永远空着的旁路；Windows 上 Grok 退回读屏，聊天层说明见 `chat-fidelity.ts` 的 Windows 表）。PTY 读线程只对这类标签答
  `OSC 7501 ; ?`（`term_query::QueryScanner::new(true)`，排在 DA1 应答之前——Claude 拿 DA1 当探询哨兵；答了 Claude 不再往窗口标题写转圈符号，
  所以有别的旁路的标签不答），读到的根记录交 `chat_channel::program_status_report`：working 开一轮（同一轮里只更新现状一句 `statusLine`）、
  blocked 只在一轮进行中当审批（启动时的信任目录 / 登录由读屏认，**不为它们开一轮**，守住「启动不转圈」）、done / idle 收、error 按失败收。
  审批与 hooks 同口径（`channelInfersApproval`：卡片只有 CLI 那一句，按钮从屏上菜单来，屏上回到输入框算答过）。不带会话 id，会话照旧认领。
  继承了 `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` 的 Claude 不问（从 Claude Code 会话里起 Mesa Dev 时会遇到）。PTY 一律注入 `CCODE_TAB_ID`（hook 命令记进日志第二段，旧格式无此段照读）。
  **规则**：①同一事实取精度最高的来源：旁路有回合状态时，`applyTailAttention`、PTY 出字点亮、PTY 静默熄灭都让位（不删兜底）；
  ②hook 一律不阻塞、不输出决定，审批只在用户点按钮后经官方通道回（Qwen input 文件 / OpenCode 接口 / Codex JSON-RPC），
  其余家照旧按菜单原文写按键；「先答者算」，卡片等 CLI 回「已处理」才撤。只能在终端菜单里答的 hooks 家（Claude Code）CLI 不报「已答」，
  旁路要等那个工具跑完（PostToolUse）才撤——批准后工具跑多久「等你确认」就挂多久（WebFetch 实测 14 秒，菜单英文卡之后又冒一张中文兜底卡）：
  **屏上回到输入框、没有菜单 = 已答**（`hooksApprovalAnswered`，标签注意力回 working、不出兜底卡；旁路报「等批准」时补扫一次屏；
  读屏认不出输入框的家照旧等旁路）；Claude 在审批菜单里被拒绝 / 按 Esc 打断时**不触发 Stop hook**，回合靠会话文件收：
  会话尾部判成收尾时前端调 `chat_channel_settle_from_transcript`，后端只认这一轮开始之后的打断标记 / turn_duration
  （`sessions::claude_turn_end_after`），按 interrupted 收掉（2026-10-21 用户实测：拒绝后聊天层 1 分半仍「正在回复」）；
  **旁路回合开着时 `fetchConversation` 不走签名门、过了门才占请求序号**（2026-10-25 用户：提问被 Esc 后终端已结束、聊天层一直「还在回复」——
  被签名门挡掉的轮询先占了号，让正在等后端的那次读取作废，收尾检查与这次调用都没做，之后文件不变就再没人查）；
  ③会话跟随：旁路给了文件路径就锁定（文件未落盘先记 id），
  `sessionSeq` 增大且路径变了（/clear、恢复别的会话）就 `relinkTo` 改盯新文件并在对话流记一行；④实时文字有旁路的家（Qwen / OpenCode /
  Codex）不再读屏；⑤Codex 恢复时远程 TUI 拒收权限参数，`split_codex_args` 改成 app-server 的 `-c` 配置，新开会话仍由 TUI 带；
  新线程 rollout 未落盘前 `thread/resume` 会失败，线程转 active 时再订；⑥旁路目录 `<config>/ccode/chat-channels/<pid>-<tab>-<随机>/`
  0700，标签退出即删，启动只清进程已不在的（打包版与 Mesa Dev 共用配置目录）；Codex app-server 自成进程组，随 PTY 退出 /
  应用退出一并杀。改任一家旁路前先跑 `scripts/e2e-model-routing/README.md`「聊天层结构化旁路」两层核对。
  **Windows 口径（2026-10-20 实测后定，macOS / Linux 行为不变）**：⑦hook 命令是起一个 PowerShell 跑共用脚本，每次 0.9–1.2 秒
  （Claude 记的 Stop hook 1241ms）——同步挂着时每个工具调用前后各卡一秒，所以**只在 Windows、只给 Claude Code**带
  `"async": true`（`hooks::launch_hooks_async`），另挂 `PermissionRequest`（payload 自带工具名与参数）；后台 hook 先后不可信，
  `Tracker::async_hooks` 只按身份对账：审批卡内容只认带内容的事件或随后到的工具、不拿上一个工具充数，对上之前别的工具开始 /
  结束都不撤卡（同步模式那套「上一个工具充数、下一个工具开始 = 已答」不动）。CodeBuddy 没核实认 async，仍同步。
  ⑧共用脚本只删回车换行（同 unix `tr -d '\r\n'`），**不得折叠 `\s+`**（会吃掉命令 / 差异里的缩进）；写日志撞上别的 hook 进程
  （AppendAllText 独占写，12 并发实测丢 1 条）重试约 1.5 秒；改正文后启动时 `migrate_legacy_windows_hooks` 替换旧脚本。
  ⑨官方账号（没有网关覆盖文件）的 Claude / CodeBuddy 不内联 `--settings` JSON，写进旁路目录的 settings.json 传路径
  （原因见 environment.md「.cmd shim」）。⑩Codex app-server 用 `spawn_tied_to_app` 挂进「Mesa 一退就全杀」的任务组
  （Mesa 崩溃 / 被强杀不留孤儿，实测强杀后 0 残留）；收旁路时先杀进程树再删目录（进程开着的文件删不掉），应用退出等它最多 3 秒。
  ⑪Codex 恢复会话给的 rollout 路径带 `\\?\`，进快照前 `strip_verbatim`。端到端在 Windows 同一份测试跑（`e2e_channel`，README）。
  ⑫**原生 hook 程序（2026-10-20 二批）**：⑦的 PowerShell 只在找不到随包的 `mesa_helper`（`hook` 模式）时用；找到就用它写日志
  （Claude Stop hook 实测 87–109ms），Claude 不再带 async、也不另挂 PermissionRequest，回到同步规则——`launch_hooks_async`
  返回 false，Tracker 自动走同步对账。命令是带双引号的 exe 路径：Claude 在 Git Bash、CodeBuddy 在 cmd 里跑 hook，两边都认。
  写全局配置的三家（Gemini / Kimi / Grok）用拷到 hooks-state 的 `ccode-hook.exe`、程序路径不加引号（Gemini 的 PowerShell 宿主不认
  双引号开头的命令；不加引号的正斜杠路径三种宿主都认），路径有空格等退回 `.ps1`（`hooks::global_hook_command`）；Gemini 实跑 hooks 照常记录。
  **Gemini 的 hook 条目带 `name`（2026-10-21，三平台）**：Gemini 跑 hook 时转圈行写「Executing Hook: <name>」，没有 name 就把整条命令
  （hook 程序与日志的绝对路径）摆在终端里（用户：取消会话时屏上一串 C:/Users/…/AppData/…）；现在写「Mesa 状态同步」。
  已开开关的旧条目启动时补一次（`hooks::refresh_gemini_hook_name`，apply_hooks_at 写前备份；已有 name 不动）。⑬**读屏兜底的 Windows 字形**（ConPTY 抓屏实测，`chat-capture.py` Windows 分支 +
  `capture-check.ts`）：Claude 正文行首是 `●`（不是 `⏺`）；Grok 回显 / 输入框 `>`、工具 `♦`、代码块标签 `○`、单选选中点 `•`；
  四家（Claude / Gemini / Kimi / Grok）的审批菜单与实时预览在 ConPTY 下都认得出。屏顶是没缩进的字（启动横幅、排队中的提问）
  且找不到回显与行首时不预览（两平台同一条）。

- **内置终端 shell 与跟随 cd（2026-10-20）**：普通 shell 标签用设置 `terminal_shell`（自动 / 本机找得到的几种），run 脚本不受影响
  （Windows 固定 Git Bash）。文件树 / Git 面板跟随 shell 里的 `cd` 靠 `pty_get_cwd`：macOS lsof、Linux /proc；Windows 由 shell 每次出提示符
  把当前目录写进 `<config>/ccode/pty-cwd/<uuid>.txt`（PowerShell 包一层 prompt 函数，保留用户 profile 的提示符；Git Bash 用
  PROMPT_COMMAND `pwd -W`），cmd 没有提示符钩子、读进程 PEB。前端往 shell 写 cd 一律走 `pty_cd`（按标签的 shell 方言），不得自己拼
  `cd '…'`——cmd 不认单引号、跨盘还要 `/d`。

- **精确注意力标记（hooks 桥接，七家；2026-10-20 起 Claude Code / CodeBuddy / Qwen / OpenCode / Codex 改为 Mesa 里启动时自动带上，
  设置页只给 Gemini / Kimi / Grok 开关，见上条）**：`session_tail_state` 对设置页已开启（或启动时自动注入）的 agent 优先读 hooks 事件日志
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
  + 终端注意力（仅待确认），固定顺序 冲突 > 待确认 > 依赖 > 更新 > 文献 > 可合并 > 待核验 > 待发送 > 技能 > 配置失效 > 人工请求（`INBOX_CATEGORIES`），为空整块不渲染；条目为可序列化 `InboxItem`（action 描述非闭包），
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

- ⌘K 命令面板（过滤与排序纯逻辑在 `command-palette.ts`；默认列表只放高频入口，设置分区/单个主题/较早项目标 `searchOnly`
  只在搜索时出现——新增命令先想清楚是常驻还是只供搜索，别让默认列表再被一类条目刷屏；面板内 Enter 必须过 `imeBlocksEnter`）、页切（顺序同侧栏；
  清单单一出处 `hotkeys.ts` PAGE_HOTKEY_DEFS，默认 mod+1..8，`hotkeyPages` map 按页覆盖、整组总开关 `hotkeyPageSwitch` 保留）、
  ⌘\ 执行态隐藏侧栏（`chromeHidden`，session 级）；⌘F 已被终端搜索占用。主题清单单一出处 `src/themes.ts`。绑定可自定义（设置页录制，
  `hotkeys.ts` 组合串，空串=禁用，settings.json 四字段；录制冲突判定对全部在用绑定互判）。通知动作 `ccode.attention` → 聚焦窗口 + 聚焦对应终端标签，
  无 extra 回首页收件箱；通知 extra 带 tabId/cwd（v3.60 起通知只有「待确认」一种，原「已回复直达评审覆盖层」链路随 done 通知一并移除）；
  收件箱经 `session_tail_state` 直查外部 live 会话（≤10 条）。
- **运行页里要「光标在终端里也接」的快捷键**（⌃Tab、聊天 / 终端 `hotkeyToggleSurface` 默认 mod+shift+t，2026-10-25）：只在运行页可见时挂，
  window 捕获阶段 `preventDefault` + `stopPropagation`，先于 xterm 拿到；默认组合必须避开 CLI 会用的键（Windows 上不带 Shift 的 Ctrl+字母多半有用，Ctrl+J 是换行）。
  换层时管好焦点：切回聊天先 blur 被盖住的 xterm（否则接着打的字进 PTY），切到整块终端时 `term.focus()`。
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
  松开/重复（bit 2，Grok 实证：答应了发不出，Enter 会交两次）。**只有查询 `CSI ? u` 回话，推栈 / 弹栈一律不回**
  （kitty 规范；2026-10-22 实证：原先推栈也回 `CSI ? flags u`，Gemini 每次重挂键盘层都推 `>1u`，没人等的应答被当成按键，
  输入框里多出「1u」跟着下一条发出去）。**编码形态按 kitty 规范**
  （首版把无修饰功能键也编成 CSI-u 且用了 57417-57426 小键盘编号，gemini-cli 的映射表没有这段，
  方向键/Home/End/Insert/Delete/PageUp/Down 全部打私用区乱码——复核实证后修正）：
  无修饰功能键一律保持 xterm 传统序列，**只有 Esc 改写 `CSI 27u`**（消歧义档的本意）；
  带修饰的方向/Home/End 用 `CSI 1;mod A-H/F` 字母形、PageUp/Down/Insert/Delete 用 `CSI 5/6/2/3;mod ~`；
  带修饰的 Enter/Tab/Backspace 走 CSI-u（kimi 的 Enter 特判兜底在宿主键盘路径，协议未推时也生效；**这条改写也要
  `preventDefault`**——只 return false 时浏览器照发 keypress，xterm 再补一个 `\r`，Kimi 选择器刚弹出就被它选中当前项关掉，
  2026-10-22 用户：`/` 后方向键选 `/permission` 回车，屏上只剩「Permission mode unchanged」）；
  Ctrl/Alt/Cmd+可打印字符走 CSI-u，纯 Shift 可打印留给 xterm/输入法。**编码后写进 PTY 的 Tab / ⇧Tab 要 `preventDefault`**（`keyNeedsPreventDefault`）：这条路 return false，xterm 不接手也不替我们拦，Tab 的默认动作是挪焦点——Claude 推了协议后⇧Tab 切完一次权限焦点就跳到界面按钮上（2026-10-22 用户）；⌘ 组合不拦（WKWebView 里拦了应用菜单快捷键失灵）。弹栈认带层数形式
  （`CSI < 1 u`，crossterm/grok 实发）；push 省略 flags 按 0（= 恢复传统）；进程退出即解除 armed
  （TUI 崩溃没弹栈也不能让 shell 的 Ctrl+C 变垃圾）。不把 `TERM_PROGRAM` 改成 Ghostty 或 Kitty。
  **启动查询应答**：DA1 回 `CSI ?1;2c`（kimi 哨兵）；XTVERSION 两种问法（`CSI > q` 裸式为 gemini/qwen
  实发形式、`CSI > 0 q`）统一回 DCS `>|Mesa (xterm.js 6.0.0) ST`——带上 xterm.js 字样是如实自述，
  OpenCode 的超链接能力表明确收录 "xterm.js"（同日调研实证，靠它启用 OSC 8/OSC 52）；
  XTGETTCAP（`DCS + q`）问到 Ms（4d73）时回 terminfo Ms 能力值，OpenCode 据此开 OSC 52 剪贴板。
  **应答在后端读线程当场写回（2026-10-21）**：`term_query.rs` 与 `terminal-protocols.ts replyToTerminalQuery` 双端镜像同一张表，
  前端只剥掉查询、跟踪 Kitty 推栈，**不得再回写**。原因：前端要等输出事件到了才答，后台标签的输出进 backlog、切回才补发，
  应答晚于 CLI 的探测窗口（Gemini 只等 1 秒）就被当成按键打进输入框，跟着下一条消息发出去
  （实证：Gemini 第二条消息开头带「5u>|Mesa (xterm.js 6.0.0)」；ConPTY 探针推迟 4 秒应答可稳定复现）。改应答表两边同改。
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
  **2026-10-17 按 Mesa 应答口径逐家 PTY 实测（假网关 + 应答 DA1 / XTVERSION / kitty 查询 / DECRQM）**：Claude 2.1.292 在 Mesa 里
  会推 kitty（flags 5）并开同步输出（其调试日志「Terminal capabilities: …kittyKeyboard=yes, synchronizedOutput=yes」），
  所以上面的旧改写对 Claude 只在协议推上来之前生效；Codex / Qwen / OpenCode / Kimi 同样推 kitty，Shift+Enter 走协议编码均换行。
  **Grok、CodeBuddy 不推 kitty，Shift+Enter 原先发 `\r` 直接发送**——两家都认 `ESC+CR`（Grok 底栏自写「Opt+Enter:newline」），
  已并入 `ptyShiftEnterRewrite`。Gemini（本机 Google 账号登录挡住）、Cursor（第三方网关拒绝启动）未实测。
  **⌘← / ⌘→ / ⌘⌫（iTerm2「自然文本编辑」）**：xterm.js 对 ⌘+方向键不发任何字节、⌘⌫ 只发 DEL；kitty 推上来后编成 super
  修饰，只有 Claude / OpenCode 认。`macLineEditKey` 在 kitty 编码之前改写为 Ctrl+A / Ctrl+E / Ctrl+U（kitty 已推时用
  `CSI 97;5u` / `101;5u` / `117;5u`），同一测法下 Claude、Codex、Qwen、OpenCode、Kimi、Grok、CodeBuddy 七家全部生效；只管 macOS。
  ⌥← / ⌥→ 走 xterm 自带的 `CSI 1;3D/C`，七家本就按词跳。
  **选中终端文字交给对话（2026-10-17 用户选定）**：选区浮条与右键菜单在 Agent 运行时多「引用 / 问 AI」，调父级
  `onConversationInsert(tabId, text, { send })`（父级分派归「聊天层」会话：聊天层进输入框、终端层 bracketed paste 写 TUI 输入行）；
  排版在 `src/terminal-quote.ts`（每行「> 」、去行尾空格、压空行、超 12000 字截断并注明）。普通 Shell 不给。「存进笔记」写项目根
  `notes/clips.md`（`append_project_clip`，与文献摘录 `excerpts.md` 分开，不进精读并稿），只在科研 / 办公项目显示。
  **连接出问题换连接接着聊（同日）**：`src/conn-issue.ts` 按各家实录形态扫可视区（只认带固定上下文的错误行，正文聊到 429 不算），
  分类 quota / rate_limit / auth / timeout / model_missing / other；基线按次数记「已看过」的错误（关提示、换连接、发下一句、
  新进程接上时记入），倒计时重绘不算新错误；还在重试的那条从屏上消失即撤提示。上报 `SessionLinkState.connIssue`
  （含 text / detail / alternatives），终端画面顶上 absolute 提示条（不改行数），聊天层画成对话末尾确认卡；动作
  `switchConnection(profileId)`：先换标签连接与模型（新连接名单有原模型就留），再停 Agent，回落 shell 后按原会话接回；
  Codex 跨连接（provider 名不同）接回已用假网关实测可行。Qwen 重试期静默，认不出。
  **代答菜单的回车**：Kimi 开 kitty 后只认 CSI-u 回车，`answerTrust` / `answerMenu` 的 `\r` 按 `submitCsiU` 换成 `KIMI_CSI_U_ENTER`。
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
  **收起/展开是平滑滑动不是卸载**（2026-10-14）：栏块（栏 + 分隔条）常挂载，收起用负 margin 整块滑出窗口外
  （滑动量 `readerPanelSlideMargin`＝栏宽＋分隔条热区 `READER_SPLITTER_PX`，过渡配方 `ccode-reader-panel`
  200ms——**只在滑动窗口挂类**（点击起 260ms 兜底/transitionend 提前收口）：收起态下栏宽随窗口缩放或
  对侧分隔条拖拽逐帧变时若过渡常开，margin 从插值中点重定向会让收起侧整段过程外宽≠0、露出空底），栏体宽度全程不变——笔记 Monaco 与右栏 xterm 宿主零重排零搬移、展开零冷启动；visibility 参与
  过渡（收起滑完才隐、展开起点即显，收起态不可聚焦）。PDF 栏随之伸缩，适配宽度重算在 PdfContinuousView
  侧做停稳防抖（`FIT_SETTLE_MS` 150ms）——动画期间零重排，停稳后一次重算，位图另由 use-pdf-zoom 的
  120ms 去抖追平、且经 render-gate（限并发 2 的 FIFO 槽闸，
  PdfPageView 排队逐页错开）补渲——换挡补渲不再挤同一帧顿挫，等闸页 textLayer 先藏、旧位图 CSS 拉伸兜底
  （分隔条拖拽同享这套收口；停稳换挡前的过渡窗内页盒仍按旧宽渲染，栏变窄方向会有短暂的横向溢出/页缘裁切，停稳即收——这是防抖的既定代价，勿为消除它退回逐帧重算）；禁止改回条件卸载（收起卸 Monaco、右栏卸槽位是当年卡顿根源）；
  翻译面板两档摆位（2026-10-14，当日三批改为悬浮球+整窗坐标）：表头「钉住/回栏」切换——原位 = 右栏 xterm 上方
  （布局流，% 高度/底缘拖拽只在这档有意义）；钉住 = **可拖动「译」悬浮球**（`ReaderTlFloat`：点球在球旁展开
  同一张译文卡，×/再点收回球；拖球换位记 `ccode.readerTlBall` 百分比坐标（0–100 归一，可贴边），位移 <4px 判点击）。
  **球与卡挂覆盖层根（fixed inset-0），坐标域是 PDF 栏**（2026-10-23 用户：球脱出了 PDF、压在右栏上；修订 10-14
  的「整窗可拖」）：百分比 = 球在 PDF 栏里的位置，渲染与卡的锚定共用 `readerTlBallOffset`（reader.ts：栏外距离 +
  `clamp(18px, (100% − 两侧栏外距离) × pct, …)` 按球半径兜在栏内），拖动按 PDF 栏宽高换算；`floatBounds` 量
  PDF 栏离覆盖层四边（含顶栏/抽查条），量到之前不出球。仍挂覆盖层根不挂进 PDF 栏——挂栏内会被栏内滚动/裁剪挡住。
  卡的锚定 left/right 用与球同一份偏移（裸百分比锚位在贴边时压球，默认 xp=100 实测压 14px），宽度再按锚定侧可用
  空间限幅（锚定边与宽度受 PDF 栏边界约束：卡不盖笔记栏/对话栏，卡顶不越过 PDF 栏顶）；卡顶/卡高共用同一活钳 min()（窗口变小后存档高被压缩，卡顶按裸存档算会探出窗顶、表头不可点）。
  拖动状态留在球组件内不惊动三栏树。悬浮卡 absolute 锚在球旁（右半区贴左展开/左半区贴右，宽 ≤26rem、高 60% 封顶 min() 钳底）、
  默认只看译文（原文要点开对照）、历史抽屉按球位上下弹、× 直接收球不落「一行动作条」、
  表头没有「只折正文」chevron（点球/× 已是完全收起，纯标识行，窄卡时表头折行）。
  **2026-10-23 用户「1–4 都做」四处修订**：①**原文段常驻标出 + 卡避让**——面板经 `onDisplay` 报上正文区摆着的条目
  （收起/×/在途/卸载报 null），ReaderOverlay 据此给 PdfContinuousView `sourceMark`（PdfPageMark kind `source`，
  `.ccode-mark-source` 淡蓝底 + 下划线，复用标记的摘句重定位）；悬浮档在换条目/开卡后 120ms、500ms 量
  `[data-mark-id="tl-source"]` 的外框（只算露在 PDF 栏里的行，**不跟滚动**），`readerTlCardAvoid`（reader.ts）只按横向
  是否压到判定（上下换位不改横向范围，判定不来回翻），压到就摆到原文段下方或上方（下方够 160px 或比上方大放下方，
  两边都不足 120px 不避让）；②**表头收成 原文 / 存进笔记 / 复制 / ⋯ / ×**，钉位（菜单文案「钉在 PDF 上（悬浮球）」/
  「回到右栏」）、问这段、历史收进「⋯」（Esc / 点外关，capture 相）；③悬浮卡译文 `text-xs`（工作台内 13px）行高 1.7（原位档仍 text-sm；字号走令牌，禁 text-[Npx]）；
  ④正文区下面还有字时 mask 渐隐卡底 28px（scroll + RO 判定）。
  从看得见的卡点「钉住」球先展开接续（卡搬家，不是缩成球）；兜底档（收起右栏自动出球）收着球起步。悬浮卡可**自由改形**：球对侧
  下角角柄拖宽高（`clampReaderTlCard` 240×140 下限、窗内空间上限，显式尺寸记 `ccode.readerTlCard`，
  双击角柄复位自适应——「拖过 = 显式记忆」与右栏高度条同款口径；角柄与球同款 4px 位移阈值——1px 抖动不得
  把自适应卡锁成显式尺寸/矮卡跳到 140 下限，基值取当前渲染尺寸而非存档）。历史抽屉弹出方向/最大高/宽在开抽屉
  时按卡与窗的实际空隙量得（固定方向会探出窗顶/窗底，固定 w-96 在窄卡/窄栏横向越界）。钉位记
  `ccode.readerTlPinned`。**兜底**：右栏收起/极端窄窗让位时未钉住也出球（收着终端也能看译文），展开即回原位。「回栏」/悬浮卡
  「问这段」在右栏收起时点击都**带滑入过渡**顺手展开右栏（问这段注入看不见的终端＝动作看似失灵）——
  setRightOpen 必须与 setRightSlide 成对，否则瞬跳。新翻译**落地或失败**球自动展开（失败也要弹，球关着时
  错误静默等于失灵；信号只认递进不认存量，StrictMode 记值式哨兵）；用户在途翻译期间手动收球则压掉下一次
  自动展开（刚合上别又被顶开）。
  悬浮与原位是同一组件两处渲染（内部 UI 态随摆位切换重置，可接受）。
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
  写项目根 `notes/excerpts.md`，不要求 lit-notes 步骤（2026-10-17 由 notes/inbox.md 改名：那是雷达收件箱）。
- **指定笔记入口（v3.98，精读笔记产物）**：`readerReq`/阅读区 state 增加可选 `notePath`——`notePath` 非空时
  ReaderOverlay **跳过 ensure_paper_note 建档**、笔记栏直接编辑这份 md（否则会按 PDF slug 再建一份模板笔记，
  与 lit-notes 的 `<序号-短标题>.md` 并存打架）。md 入口三处：产物核验清单 md 就地预览弹层「⛶ 沉浸阅读」、
  终端页文件树 md 右键、终端页 md 预览工具条「⛶ 沉浸阅读」（read 态；缺省仍是 FilePreviewEditor 自带单栏沉浸层）。
  三处统一走 `reader_for_note`（reader.rs）一次给齐归属项目根 + 配对 PDF + 实际笔记路径：归属反查 = 注册项目根
  canonical 前缀直含 → 工作区 worktree 包含则映射主仓副本（主仓还没有 = 未合并，明确报错「评审合并后再进」）；
  配对 = 笔记 stem 与 project.toml `type="paper"` 资源的文件 stem 做 `normalize_title`（lit_watch.rs，已提
  pub(crate) 复用）**互相包含**（与前端 lit-watch.ts `paperResourceFor` 同口径），多命中取规范化最长者，
  无命中报错透出。另有根已知的变体 `pdf_for_note`（返回 Option，供已知 projectRoot 的调用方）。
- **抽查核对档（2026-10-23 用户拍板「都按推荐做」）**：精读步人工事项「抽查 3 篇笔记」点一篇 → `readerReq.spotCheck`
  （`src/spot-check.ts SpotCheckSession`：三篇、index.json 所在根 base、步骤名/事项标题、工作区）→ 阅读区不跳运行页、
  退出回流程页。**pdfPath/notePath 由阅读区按篇经 `spot_check_item`（reader.rs）解析**：笔记限 base/notes 内；
  base 是本项目某工作区时 `readOnly`（工作区归属查 workspaces 表，repo 必须是本项目根）——**不走 reader_for_note**
  （它把工作区笔记映射回主仓副本，抽查要看的恰是待评审那份）；PDF 先按来源行/文件名在**项目根**配对（原始资料
  直写项目根 papers/），再看 included.json 的 `pdf` 字段；题名/摘要取 included.json（「待补」「待核」不算）。
  只读档：FilePreviewEditor `readOnly`、标注增删 / 圈选插笔记 / 译段存笔记 / 让 AI 起草全收；无 PDF 时中栏
  `SpotAbstractPane` 摆摘要。**核对档不派阅读会话**（readerKey 置空）：阅读会话在项目根、`Edit(./notes/**)`
  预放行改的是主仓笔记，会改错地方。右栏 = `SpotCheckPanel` 问题单：笔记划选走 FilePreviewEditor `onAnnotate` +
  `annotateCopy`、PDF 划选走 `onAskAi` + `askAs`（不出「直接发送」），都记「记成问题」；问题单按 base 记
  localStorage（Esc 退出不丢，发出/勾上清）。「发给这一步的 AI」= `buildWorkspaceTerminalRequest(ws, prompt,
  {autoStart, resumeSession})`（与决策后续跑同链：活会话认回标签注入、否则 resume），关阅读区留运行页、事项不勾；
  「N 篇都没问题」三篇都看过才可点 → `set_human_task_check` + store `bumpHumanTasks`（useHumanTasks 见 tick 重取）
  → 回来源页。索引读自项目根（已保存进项目）时 ws 为空：笔记可改、问题单只记不发。
  栏宽另记一套（`ccode.spotSplitL/R`，缺省笔记 34% / 问题单 18%，同日用户「问题单窄一点、左侧保留阅读宽度」），
  拖动不影响平时三栏；窗口放不下时 `readerColumnWidths(…, keepLeft)` 先把问题单压到 240px 保底，笔记栏最后才让；
  ReaderOverlay 以 `key` 区分两档，换档重挂才按各自记忆读宽度。
- **右栏可切「聊天 / 终端」（2026-10-18 用户要求补上聊天层切换）**：对话卡标题行右侧分段钮切阅读会话标签的
  surface（与终端页同一份 `surfaceModeByTab`，不走 switchSurface——它按焦点标签改、切聊天会退出分屏）。
  2026-10-22 起不再单独记 `ccode.readerSurface`：进入时跟设置「打开对话时先显示」，右栏里切只管这一次的会话。
  TerminalPage 把 pane 里的聊天层宿主（`data-chat-host`，包着 ChatSurface）与 xterm 宿主一起搬进同一个槽位：
  聊天层 `absolute inset-0 z-20` 叠在 xterm 之上（终端几何不变，不触发 SIGWINCH 重放）；露出终端（peek）时聊天层宿主
  改 `relative order-1 flex-1`，终端画面靠槽位属性 `data-reader-surface="peek"` 的 App.css 规则排到下方占 32%
  （TerminalView 的节点类名动不了）；终端画面档聊天层宿主 hidden。开屏遮面只给终端画面档（聊天层有自己的连接态）。
  注入路由（injectToReader）：「放进输入框不发送」在聊天层进聊天输入框（`chatInsertByTab`），终端档写终端输入行；
  直接发送（简报/让 AI 起草）两层都走 PTY，出错能报回。**焦点在右栏里时 Esc 一律归右栏**（xterm 本就就地消化；
  聊天输入框/菜单里的 Esc 关阅读区会连带关掉阅读会话），阅读区开着时按 focusedId 把阅读会话拉成焦点
  （分屏时焦点在右 pane 也拉回：聊天层发送/打断/审批都发给焦点标签）。
- **右栏的终端画面 = 阅读会话标签的 xterm**（2026-08-18 用户拍板：右栏从结构化对话视图改为真实终端，
  用户看着终端直接敲；2026-10-18 起与聊天层可切换，见上条）：TerminalPage 用 `useLayoutEffect` 把该标签的 xterm 宿主节点（TerminalView 容器 div，
  `data-terminal-host=<tabId>`）appendChild 进覆盖层右栏槽位（槽位经回调 ref + state 上报；右栏收起不卸槽位——
  栏块滑出隐藏、宿主尺寸不变，effect 只在覆盖层开/关、标签更替时搬），关闭时插回原槽位最前——FilePreviewEditor 的 Monaco 宿主移动同款先例，PTY/xterm/scrollback
  不重建不丢；容器上既有 ResizeObserver 在尺寸变化时自动 fit，无需额外触发。阅读区打开时该标签被提到活跃。
  没有独立的对话视图与输入框：「◈ 问 AI」/圈选截图注入仍写该标签 PTY（`injectToReader`），文字出现在终端
  输入行里正好可见。无配置引导卡、标签被关的「重新启动会话」卡片行为保留。标签的 ⌘F 搜索条与粘贴反馈小条
  留在终端页原区域（阅读区里看不见，退出后可用；阅读区里 ⌘F 归 PDF 查找，见下）。**同日拍板：不做扩展性功能，只做场景必需**——快捷 chips
  （图导游/总结这页/帮我改笔记）与「✦ 工具」页签（译历史/生词本表格/大纲三段）砍掉待需求，
  `ReaderToolsPanel` 已删；⌘+点击段落对照的结果改在点击位置旁的选区同款浮卡呈现（可保存译段）。
  **2026-10-18 用户点名补齐九项（「全部都做」，见下方「查找/目录/标注/互跳」各条）**——属场景必需，不是恢复上面砍掉的扩展件。
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
- **Agent 上下文简报**：note 就绪、`agentStatus.running` 为真**且开屏遮面已撤**（会话联动到 ≈ TUI 已开屏，
  8s 兜底）时，ReaderOverlay 自动向阅读会话**直发**一行简报（「【阅读上下文】在读 PDF：<pdfPath>；配套笔记：<note.path>…」）。
  **先占位再发**（briefedRef 记 note.path，失败才撤）、换会话标签（重启）清占位——2026-10-18 修「简报打两遍、
  还落在 CLI 开屏之前」：进程活着不等于 CLI 能收输入；回包才记账会让 effect 重跑时同一段进两次。
  已知竞态：send=true 会把用户输入行未发完的文字一起带出，窗口极小，接受（注释在 ReaderOverlay 同效应处）。
- **PDF 查找 / 目录 / 跳页（2026-10-18）**：PdfContinuousView 自带，所有宿主都有工具条放大镜，⌘/Ctrl+F 只在
  `findHotkey` 接线宿主（阅读区）生效——window capture 相拦截并 stopPropagation（终端页对活跃标签也挂了 ⌘F，
  会呼出阅读区里看不见的终端搜索条），焦点在 `.monaco-editor` / `.xterm` 里不拦。检索走 `src/pdf-search.ts`
  一套归一口径：文本项原样拼接、行尾补一个空格、行尾「字母+连字符」断词复原（en/em dash 不并字）、大小写/弯引号/
  各式短横线/连字归一——**页级计数（getTextContent 文本项）与页内高亮（textLayer 的 span/br[role=presentation]）
  同一套组装，第 k 处在两边是同一处**，勿各写一套。文字索引首次查找时逐页取、按文档缓存；全文抽不出字明说
  「扫描件」。目录 = PDF 自带书签（`flattenPdfOutline` 三层 300 条），没有书签不出按钮；落点高度按 XYZ/FitH/FitR
  换算到页内偏移。页码可点输入跳页。查找条/跳页输入/下拉/高亮小卡的 Esc 都在 capture 相先收自己，不连带关阅读区。
- **页内高亮层（PdfPageView `marks`）**：查找命中 / 标注 / 跳转一闪共用——标记只存**摘句**不存坐标，textLayer
  落地后按 pdf-search 口径重定位、Range.getClientRects 量矩形（同行碎盒 `mergeLineRects` 合并，WebKit 一片两盒），
  换算成**页内百分比**画在文本层之前（pointer-events:none，选字/复制不变；缩放未停稳时与文本层同进退）。
  标注/一闪的摘句按候选写法依次试（见下条），查找命中只认原样（第 k 处要与页级计数对齐）。标记数组按页 memo、内容键比较，同内容换引用不重算。
- **标注 = 笔记「## 标注」小节（2026-10-18）**：高亮/批注不另存坐标库、不进 localStorage——一行一条
  `- p.3 「摘句」` / `- p.3 「摘句」 —— 批注`，写在当前笔记里（随笔记走 git、跨机器在、Agent 读得到）。
  格式契约 `src/reader-note.ts` ↔ `reader.rs`（`annotation_quote`/`parse_annotation_line`）双端镜像：摘句行尾
  「字母-换行」接回同一行且**保留连字符**（断词还是复合词分不清，照原样读；当晚真笔记干跑见过「argonfilled」）、
  空白折叠、「」换“”、500 字上限；页内重定位按 `quoteSearchCandidates` 依次试原样 → 去词内连字符 → 前 60 字；解析只认「## 标注」小节内的行，「」定界取「后面只跟 —— 或行尾的」那个 」。
  小节不存在时建在「## 译段」之前（机管两节保持收尾），列表紧凑不留空行；同页同摘句再标只更新批注；删到空连标题删。
  写入门槛同译段（项目已登记 + 笔记在 notes/ 内，canonical 双校验，原子写）。点 PDF 高亮出小卡（批注 /
  在笔记里看 / 删掉高亮），工具条「标注 N」列全部。lit-notes 技能与精读步合同把「标注」与「译段」「我的想法」
  并列为用户笔记原样保留。阅读区另订一份笔记 watcher（FilePreviewEditor 编辑态 dirty 会停订，高亮不能跟着停）。
- **笔记 ↔ PDF 互跳**：笔记栏（只在显示本篇笔记时）阅读态把 `p.3 / pp. 3–5 / 第 3 页 / page 3 / Fig. 2 / Figure 2a /
  图 2 / Table 1 / 表 1` 包成 `.md-pdf-ref`（`md-pdf-refs.ts`，每次布局幂等重扫，跳过 a/code/pre/公式）；页码在
  标注行或译段引用块里时带上那段原文，跳过去闪一下。图表编号走 `locateFigure`：行首图注优先，其次第一次提及。
  反向：PDF 高亮「在笔记里看」→ `focusText`（阅读态滚到含该行的块并闪，编辑态 Monaco 选中居中）。
- **让 AI 起草**：`noteDraftEmpty`（八小节标题出现过且都没有正文）时笔记栏顶一行入口，直发 `buildNoteDraftPrompt`
  给阅读会话（lit-notes 写法、原地编辑、来源行与三节机管小节不动）；会话没开好（running 且遮面已撤）给 toast 不发。
- **阅读会话权限（2026-10-18）**：dispatchReaderSession 带 `permissionMode: "ask"`（这家 CLI 的 permissionModes 有 ask
  才带，否则按本机设置）——本机设完全访问也收窄成先问。Claude Code 另由 pty_spawn 识别 `reuse_key` 前缀 `reader:`
  在 ask 档追加 `--allowedTools Edit(./notes/**)`（cwd=项目根），改笔记不必逐次批准、改别处照常先问。
  PendingTerminal / addTab 因此透传 `permissionMode`（仍只进内存不进持久化白名单）。
- **阅读区里的状态栏不出 git 胶囊**：阅读会话的 TerminalStatusBar 整个搬进右栏，Commit & Push 在读文献时只会误点——
  TerminalPage 对 `reader && readerTabId === t.id` 的标签传 `git=null`。
- **状态栏与聊天输入框的窄栏排法（2026-10-18 阅读区截图：模型芯片与目录胶囊叠字）**：TerminalStatusBar 量自己的宽度，
  窄于 560px（`STATUS_BAR_NARROW_PX`）收掉连接名 / 思考档 / token，模型与目录限宽截断——各段 nowrap 不能收缩，
  放不下就互相盖住（左区不能 overflow-hidden：模型菜单从这里往上弹）。聊天输入框左下角的状态注记
  （「等待会话文件」等）同理改为可截断。阅读区笔记栏首个块右侧让出浮动「目录」钮的宽度。
- **顶栏题名**：`reader_paper_title`（reader.rs `paper_title_for`）在题录里找真实题名——配对笔记 H1（不是文件名本身时）
  → notes/index.json → papers/included.json（fulltext 字段写着这个文件名的优先）→ included.md / reading-list.md →
  雷达收件箱；匹配 = `normalize_title` 相等，或文件名规范化后 ≥24 字且是题名前缀（雷达限长截断）。新建档笔记的
  H1 同口径。悬浮译文卡与「译」球只在 PDF 栏里（`floatBounds` = PDF 栏离覆盖层四边的 px，RO 按帧合并）；
  笔记栏 md 用 `compact` 排版（标题收一档）。
- **注入单一内核 `injectToTab(tabId, data, send)`**：原 `injectToActiveAgent` 抽成按 tabId 的共用内核，
  右栏选段（活跃标签）与阅读区注入（阅读会话标签）走同一条链路（缺省只写输入行不回车）；选段「◈ 问 AI」/
  「↵ 直接发送」/圈选「发给 agent」/阅读区简报/让 AI 起草全部经此。**`send=true` 必须走标签的 `sendMessage`**
  （`pty_write_submit`：正文按粘贴写入、提交键单独补写，同聊天层发送）——**禁止把正文和 `\r` 一次 `pty_write`**：
  Claude Code 把整段连同回车当成粘贴，字躺在输入行里没发出去，聊天层却已记成「正在回复」一直转
  （2026-10-18 阅读区简报实测；此前「简报两段」的另一半就是这个）。**拉起后的第一次发送要等 CLI 能收键**
  （TerminalView `waitAgentInputReady`；之后的发送不等）：
  进程刚起来时写进去的字先被终端行规程回显，回车成了开屏前预输入的一部分，字落进输入框没提交、聊天层却记成已发出。
  假网关 PTY 实测：Claude Code 拉起后 50ms 内写入必现，等就绪后 3/3 正常。**认得画面布局的几家（live-reply.ts）等屏上画出输入框、
  再安静 300ms（2026-10-21）**：Kimi 2.3 一起来先发一个终端查询、隔一秒多才画界面，原口径「出过字后安静 400ms」在查询之后 0.5 秒
  就写了，字全丢（ConPTY 探针旧口径 3/3 丢、新口径 3/3 到；用户：发「你好」终端没有输入，8 秒后终端被拉起来，Mac 同样）。
  屏上是信任菜单时一直等（写进回车等于替用户选），别的认不出输入框的情形最多 20 秒；认不得布局的家与后台标签照旧
  （画出过字——剥掉终端查询后还有内容——后安静 400ms，一直没画的等满 3 秒，最多 8 秒）。阅读区遮面以会话联动为撤除条件，
  Claude 拉起即预登记会话 id、联动几乎立刻就有，不能当「能收键」用。
- **阅读会话 reuseKey 口径**：进入阅读区自动起一个阅读会话标签（项目根 + autoStart，快速开聊同款
  机制），`reuseKey = reader:<projectRoot>`（`src/reader.ts readerReuseKey` 单一出处）——退出再进找回同一标签
  接着聊；恢复出的占位标签不带 reuseKey 不参与复用；用户手动关掉标签后不连环重建（一次性标记，栏内给
  「重新启动」入口）；无可用配置时右栏给引导卡跳配置页，不自动起会话。启动配置解析
  （resolveReaderLaunch，异步）：项目 Agents「专属绑定 · 沉浸阅读对话」显式槽优先
  （project.taskBindings.reader，经 get_project_agent_binding 现读；agent 跟随绑定连接
  所属 CLI 且可带模型，停用项照常尊重，连接被删/读失败按未绑定回落）> 启动栏上次 agent
  的默认配置 > 上次使用 > 首个可见。专属绑定是项目级槽位机制（projects 表 task_bindings
  列，槽位白名单见 PROJECT_AGENT_BINDING_SLOTS，set/get_project_agent_binding 写读，
  clear_project_default_profile 删连接时连带清理），首个槽位 reader，后续任务槽位按需入列。
  阅读翻译不受此槽影响——走 ai_prompt fnKey="translate" 的 AI 按功能配置（设置页「翻译」行），
  与 agent 各用各的模型。
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
  **双击段落跳源码行（2026-10-14 拍板，同批 md 编辑态开折行）**：阅读态双击任意段落 → 切编辑态
  并把光标定位到该块源码行。映射在 `md-block-map.ts`：marked 18 token 无行号，lexer raw 前缀累积
  自算（**lexer 必须无参调用**，带 options 会整体替换 defaults 丢 md-math 扩展）；标记不烘进 HTML
  （DOMPurify 白名单剥自造 data-*），双击时惰性配对 `.md-body` 顶层子节点 ↔ 块 token
  （div.md-code / div.md-mermaid 归一 pre），配对失败回落纯切编辑态。定位走 {line, nonce} 通道
  （modeTick 先例）防同值不重触发，reveal 等一帧再居中（隐藏态高度未定）。双击排除
  a/img/button/input/.md-code-bar（不抢链接/图片/复制/复选框原语义），先清选区防划选浮条
  闪帧；批注草稿表单开着时不跳（护住已输入意见，防卸载阅读态丢稿）；只读/截断态不接线。
  **⌘E 在编辑器内失效的坑（2026-10-14 修）**：Monaco 把 mod+E 默认绑成「用所选内容查找」
  （findController StartFindWithSelectionAction，mac 默认 CtrlCmd+KeyE），焦点在编辑器里时
  窗口级 ⌘E 监听收不到键——FilePreviewEditor 在编辑器 DOM 上 capture 拦截（同粘贴图片模式），
  仅 modeTick 接线宿主（阅读区）生效并 stopPropagation 防二次翻转，其他宿主保留 Monaco 原生查找。
  **md 编辑格式行与快捷键（同日补齐）**：编辑态 md 自带格式行（B/I/S/`/•/☑/❝/<a>）与
  ⌘B/⌘I/⌘⇧X/⌘⇧C 行内标记切换（已包裹→解除），回车续列表（任务清单重置未勾选、空项退出），
  md 缩进 2 空格；纯逻辑在 src/md-edit.ts，按钮与快捷键同源。键接线走编辑器 DOM 的 capture
  监听（与 ⌘E 同模式）——**不用 addCommand**：它挂在全局单例 keybinding 服务上，无 when 子句
  会跨编辑器串扰（别的预览 Enter 被吞）、编辑器销毁不清理（每切一次文件泄漏一批绑定）、还压掉
  查找控件输入框里的原生 Enter，三坑当晚全量审查源码实证。Enter 只在单光标且光标行为列表项时
  接管，组词/多光标/非列表行回落原生；IME 锁（ime-guard 的 imeBlocksEnter + compositionend
  后一帧）防确认候选的 Enter 穿透（WKWebView 时序档案见 ime-guard.ts 头注释）。undo 前后双
  止点隔离格式化操作。TerminalStatusBar 评审相位的 window capture Enter 加 monaco 目标守卫
  （编辑器里的回车不当「立即执行」，防一次按键双动作）。
  **Monaco 悬停提示整体隐藏（2026-10-14 用户拍板「显示不了就去掉」）**：查找控件按钮的提示
  走 monaco hoverService（非原生 title），浮层渲染在 overflow-guard 裁切上下文内、控件贴编辑器
  顶边时被裁出残影；Mesa 各编辑器无值得保留的内容悬停，App.css 以 `#root .monaco-hover
  { display:none }` 整体不放；哪天真需要编辑器内悬停（如接入语言服务）先摘掉这行。查找控件
  窄栏溢出已由 App.css 适配（max-width + 换行收缩）。
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
- **Windows：emoji 等 BMP 以外的字改送只按下的 win32 按键记录（2026-10-21 实测）**。ConPTY 把写进来的 UTF-8
  emoji 拆成「高位按下、高位抬起、低位按下、低位抬起」四条按键事件；Codex 用的 crossterm（openai-oss-forks 版
  `windows/parse.rs handle_surrogate`）把抬起也当代理对的一半去拼，两次都拼不成字，**整个 emoji 被丢掉**
  （聊天层发「"引号" 😀」，Codex 会话落成「"引号" 」；真 Codex 0.163 输入框实测 `X 😀 Y` → `X  Y`）。
  `pty_write` / `pty_write_submit` 在 Windows 上经 `conpty_input_pieces`（pty.rs）把每个 BMP 外的字换成高、低两条
  只按下的记录（`win32_input_records` 按 UTF-16 码元出），其余字节原样、粘贴包照包，按段写、段间隔 2ms
  （`pty_input` 分段请求，回执等待随段数加长）。已核：crossterm 收到完整字；不开 VT 输入的读法（Node / .NET /
  prompt_toolkit 只看按下）收到的不变；开 VT 输入的程序在粘贴包里照样收到原字、包首尾不变。macOS 不走这条。

- **聊天层标签条不放 ⋯ 与 ✦（2026-10-21 用户拍板）**：⋯「对话操作」与聊天态 ✦「插入技能 / MCP」都与输入框重复（`/` 面板 Mesa 组、＋ 菜单），标签条只留名称、进度、关闭。终端层的 ✦ 保留（那里没有输入框 ＋）；启动行的「更多终端操作」⋯ 不动。
