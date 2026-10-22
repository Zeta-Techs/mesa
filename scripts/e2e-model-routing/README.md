# 各家 CLI 模型路由端到端核对

用 Mesa 生成的**真实启动计划**拉起本机装着的各家 CLI（非交互问一句），看假网关收到的请求：打到哪个路径、带的什么模型。
HOME 换成临时目录，但拷入用户真实的 CLI 配置文件——「用户全局配置会不会盖过 Mesa 的注入」一并验到，又不往用户的会话目录写东西。
不用任何真实密钥（计划里的密钥是 `sk-e2e-test`），请求只到本机假网关。

```bash
python3 -I scripts/e2e-model-routing/gateway.py 18950 /tmp/e2e-gw.log &
cd src-tauri && E2E_BASE=http://127.0.0.1:18950 E2E_OUT=/tmp/e2e-plans.json \
  cargo test --lib e2e_dump_launch_plans -- --ignored
cd .. && python3 -I scripts/e2e-model-routing/drive.py /tmp/e2e-plans.json /tmp/e2e-gw.log
# 只跑几家：在末尾加 agent id，如 claude-code codex
# Claude 子 agent 也要核对：E2E_PROMPT="TRIGGER_SUBAGENT please"（假网关回一个 Agent 工具调用）
# 生成计划时可加：E2E_EFFORT=high（看各家思考档在线上的形态，假网关日志 params 字段）、
#                 E2E_SMALL=e2e-default（看「模型分工」的后台小模型是否用于标题 / 摘要）
```

通过标准：每家的请求都带 `e2e-picked`（绑定名单第二个、即「这次选的」模型），路径符合该家协议
（Claude `/v1/messages`、Codex `/v1/responses`、其余 `/v1/chat/completions`、Gemini `/v1beta/models/<模型>:streamGenerateContent`）。
2026-10-17 首次运行的结论见 docs/architecture.md §10 当日「各家 CLI 模型配置端到端核对」与「连接加模型分工」两条。

CLI 金丝雀（`scripts/cli-canary/`，2026-10-21）复用这里的三件：假网关设 `E2E_DUMP=<文件>` 另记每个请求的完整请求体与少数请求头；
`chat-capture.py` 设 `CLEAN_HOME=1` 不拷本机配置；`e2e_channel` 设 `E2E_CLEAN_HOME=1` 同理，`E2E_KEEP=<目录>` 留下会话原件、
Mesa 解析结果与旁路状态（channel.json）。

## 内嵌终端按键核对（2026-10-17）

按 Mesa 的真实应答口径（DA1 / XTVERSION / kitty 查询 / DECRQM，同 `src/terminal-protocols.ts`）拉起各家，在输入框里实际按键看效果。
依赖 pyte（终端画面模拟）：`pip install --target /tmp/pyte pyte`，运行时设 `PYTE_DIR=/tmp/pyte`。计划文件同上（`E2E_OUT` 生成的那份）。

```bash
# ⌥← / ⌘← / ⌘→ / ⌘⌫：mesa = 改写前的字节，ctrl = macLineEditKey 改写后（应全部生效）
PYTE_DIR=/tmp/pyte python3 -I scripts/e2e-model-routing/terminal-keys.py /tmp/e2e-plans.json codex ctrl
# Shift+Enter 是否换行：第三个参数取「Mesa 现在发的」「ESC+CR」「Ctrl+J」「CSI-u Shift+Enter」
PYTE_DIR=/tmp/pyte python3 -I scripts/e2e-model-routing/terminal-newline.py /tmp/e2e-plans.json grok "ESC+CR"
```

脚本会自动关掉复制来的配置触发的一次性对话框（Claude 的默认权限迁移、Kimi / CodeBuddy 的信任菜单）。

## 聊天层逐家抓屏（2026-10-18 第三期）

`chat-capture.py` 按聊天层权限四档的启动参数（计划里的 `permission`）拉起一家，跑三幕并逐帧记下画面：
发 `TRIGGER_SLOW`（假网关慢慢流出 10 行，看实时预览）→ 发 `TRIGGER_TOOL`（假网关回一个「跑命令」工具调用，看这一档问不问、
审批菜单长什么样；工作目录里出现 `mesa_probe.txt` 就是放行了）→ 发切换命令（可选，看确认菜单与读回）。

```bash
python3 -I scripts/e2e-model-routing/gateway.py 18950 /tmp/e2e-gw.log &
cd src-tauri && E2E_BASE=http://127.0.0.1:18950 E2E_OUT=/tmp/e2e-plans.json cargo test --lib e2e_dump_launch_plans -- --ignored && cd ..
PYTE_DIR=/tmp/pyte python3 -I scripts/e2e-model-routing/chat-capture.py /tmp/e2e-plans.json claude-code ask /tmp/cap/claude-ask.json "/model e2e-default"
# 审批停住时替你按键（| 分开的每个键单独写，同 Mesa answerMenu）：看哪种按法能选中
APPROVE_KEYS='\x1b[B|\r' PYTE_DIR=/tmp/pyte python3 -I scripts/e2e-model-routing/chat-capture.py /tmp/e2e-plans.json grok ask /tmp/cap/grok.json
# Codex 沙箱里的命令不问人，要申请出沙箱才走审批：
TOOL_PROMPT="TRIGGER_TOOL TRIGGER_ESC 跑一下" PYTE_DIR=/tmp/pyte python3 -I scripts/e2e-model-routing/chat-capture.py /tmp/e2e-plans.json codex ask /tmp/cap/codex.json /model
# 比一屏还长的回复（60 行，看开头滚出屏后预览接不接得上）：第一幕换成 TRIGGER_LONG、拍久一点
REPLY_PROMPT="TRIGGER_LONG 写长一点" REPLY_SECS=25 PYTE_DIR=/tmp/pyte python3 -I scripts/e2e-model-routing/chat-capture.py /tmp/e2e-plans.json codex ask /tmp/cap/codex-long.json
```

**生成计划后马上跑**：Claude 的连接全在计划里的 `--settings` 文件中，Mesa 会清理 external-launch 下的旧文件；文件不在时脚本直接停下。
不能退回去掉这个参数——那样会落回拷进临时 HOME 的本机 `~/.claude/settings.json`，请求打到真实网关、用的是真钥匙（2026-10-18 踩过一次）。
Gemini 的临时 HOME 里会把登录方式改成 API Key（Mesa 只在这种情况下放行第三方连接）。逐帧结果是 JSON（`scenes.<幕>[].lines`），
结论与样本见 docs/agent-integration-matrix.md「聊天层第三期逐家抓屏」、tests/tui-menu.test.ts、tests/live-reply.test.ts。

切换会不会写回 CLI 的全局配置：第三幕带 `ANSWER_MENU=1`（Codex 选择器要连按两次用 `ANSWER_MENU=2`），脚本会在弹确认时按回车选默认项，
最后比对临时 HOME 里各家配置文件切换前后的差异（`config_changed`，也打印到屏上）。2026-10-18 的结论见 src/switch-strategy.ts 文件头。

**生成中再发一句（2026-10-22）**：设 `QUEUE_PROMPT` 走另一幕——先发 `QUEUE_FIRST`（默认 `TRIGGER_TOOL 跑一下`），过 `QUEUE_AFTER` 秒打这句、
按 `QUEUE_KEY`（默认回车；Codex 的 Tab 写 `\t`），设了 `QUEUE_THEN` 再隔 `QUEUE_THEN_AFTER` 秒按一个键（「立即发送」：Esc 写 `\x1b`，kitty 下
`\x1b[27u`；Claude 的 Ctrl+Enter `\x1b[13;5u`），拍 `QUEUE_SECS` 秒。假网关起的时候设 `E2E_PROBE_CMD="sleep 9; echo mesa > mesa_probe.txt"`
让工具跑久一点、`E2E_DUMP=<文件>` 记完整请求，看这句落在哪个请求里（和工具结果同一个 = 插进这一轮）。Qwen 拒绝独立的 `sleep`，用
`QUEUE_FIRST="TRIGGER_SLOW 讲一段"`。结论见 docs/agent-integration-matrix.md §14「生成中再发一句」。

**长回复实时预览回放（2026-10-22）**：用户说 Claude Code 长回复时聊天层预览一遍遍重贴整屏。假网关起的时候设
`E2E_LONG_FILE=<Markdown 文件>`（`TRIGGER_LONG` 改为流出这份文件，带标题、列表、表格、代码块才看得出 CLI 重画）、
`E2E_LONG_CHUNK=6`（按字数切块流出，像真模型那样先出半行）、`E2E_LONG_DELAY=0.03`（每块间隔秒数）；抓屏加 `CAP_RAW=1`
记下终端原始输出（`CAP_COLS` / `CAP_ROWS` 改终端大小，默认 120×40；Claude 拿拷来的配置起时推「全屏渲染」，脚本默认选 Not now，
`CAP_FULLSCREEN=1` 选 Yes）。再用真 xterm.js 回放、每写完一块按 Mesa 的口径读一次屏接一次（比 Mesa 300ms 一读更密）：

```bash
E2E_LONG_FILE=/tmp/reply.md E2E_LONG_CHUNK=6 E2E_LONG_DELAY=0.03 python3 -I scripts/e2e-model-routing/gateway.py 18950 /tmp/e2e-gw.log &
CAP_RAW=1 CAP_COLS=100 CAP_ROWS=32 REPLY_PROMPT="TRIGGER_LONG 写长一点" REPLY_SECS=30 TOOL_SECS=1 PYTE_DIR=/tmp/pyte \
  python3 -I scripts/e2e-model-routing/chat-capture.py /tmp/e2e-plans.json claude-code full /tmp/cap/claude-long.json
node --experimental-strip-types scripts/e2e-model-routing/live-replay.ts /tmp/cap/claude-long.json /tmp/reply.md
# 输出 duplicated（比原文多出的行）/ missing（原文有、预览没有的行）；LR=<旧版 live-reply.ts> 换接法对比，SHOW=1 打印预览
```

2026-10-22 结论（Claude 2.1.304 / Kimi 2.2 / Gemini 0.65 / Grok 1.0.62，100×32）：旧接法重复 158 / 1150 / 1123 行，新接法都是 0；逐块读时约四成落在
同步输出半帧上（Mesa 读屏改为等这一帧画完）。同日回放还修了三处：Gemini 完全访问（YOLO）时输入框是「*」、原先认不出，预览整轮不出；
Gemini 的表格行以「│」开头被当成工具框跳过；Grok 长回复把提问钉在屏顶，原先读成「看得见开头」，预览只剩最后一屏。修完五份抓屏
（Claude、Gemini 两档、Kimi、Grok）都是重复 0、漏 0。

**Windows（2026-10-20，ConPTY）**：同一脚本走 pywinpty（`pip install --target <目录> pywinpty pyte`，`PYTE_DIR` 与 `PYWINPTY_DIR` 都指向它），
npm 的 `.cmd` 垫片按 Mesa 同口径直启。在 Git Bash 里跑，路径用 `cygpath -w` 转；Python 要用安装目录下的 `python.exe` 并加 `-X utf8`
（`-I` 会忽略 PYTHONUTF8，计划文件按 GBK 读会报错）；Gemini 的工具幕可能要 `TOOL_SECS=25`（本机全局 hooks、MCP 初始化拖慢审批菜单）：

```bash
PYTE_DIR=$(cygpath -w /tmp/pywin) PYWINPTY_DIR=$(cygpath -w /tmp/pywin) \
  "/c/Users/<你>/AppData/Local/Programs/Python/Python313/python.exe" -I -X utf8 \
  scripts/e2e-model-routing/chat-capture.py "$(cygpath -w /tmp/e2e-plans.json)" claude-code ask "$(cygpath -w /tmp/cap/claude-ask.json)"
# 用 Mesa 自己的解析器读抓屏：实时预览读到多少行、审批菜单认没认出来（macOS 抓的也能读，用来比两平台）
node --experimental-strip-types scripts/e2e-model-routing/capture-check.ts "$(cygpath -w /tmp/cap/claude-ask.json)"
```

2026-10-20 Windows 结论：Claude / Gemini / Kimi / Grok 的审批菜单与实时预览都读得出（Claude 正文行首在 Windows 上是 `●`、Grok 换了一套字形，
已补进 src/live-reply.ts / src/tui-menu.ts 与对应测试）。

**多行消息**：`REPLY_PROMPT` 里写 `\n`（字面两个字符）就发两行；子进程开了 bracketed paste（结果里 `bracketed_paste`）时照 Mesa 包成一次粘贴。

**Windows 上跑**（2026-10-20）：依赖装到临时目录 `python -m pip install --target <目录> pyte pywinpty`，`PYTE_DIR` / `PYWINPTY_DIR` 都指向它；
三个坑——①中文系统必须 `python -I -X utf8`（不加时读计划 JSON 按 GBK 报错；`-I` 会忽略 `PYTHONUTF8` 环境变量）；
②在 Git Bash 里带斜杠命令参数（`/model`）要 `MSYS_NO_PATHCONV=1`，否则变成 `C:/Program Files/Git/model` 被当成一句话发出去，
关了转换后脚本路径、计划路径都要写 `C:/...`；③`python3` 若是应用商店占位程序（退出码 49 / 9009），改用 `py -0p` 列出的真解释器。
2026-10-20 八家结论（Claude 2.1.304 / Codex 0.163 / Qwen 0.25.3 / Gemini 0.64 / Kimi 2.2 / CodeBuddy 2.170 / Grok 1.0.62 / OpenCode 1.19.3）：
ConPTY 转出 `?2004h`，读屏实时预览、审批菜单、信任提示与 macOS 同形；聊天层的答题键（回车 / Kimi CSI-u）七家都真放行（Gemini 菜单出得晚未测到）；
多行粘贴里的 LF 只有 Grok 丢换行（改写 CR 后正常，见 docs/conventions/terminal.md「聊天写入 PTY」）。

## 聊天层结构化旁路（2026-10-20）

设计与结论见 docs/design-chat-structured-channels.md。两层核对，都只打本机假网关、临时 HOME：

**一、Mesa 自己的实现（推荐）**：Rust 端到端测试走真实的 `chat_channel::prepare` / 旁路读取 / 审批回复，看快照里会话、回合、审批对不对。

```bash
python3 -I scripts/e2e-model-routing/gateway.py 18950 /tmp/e2e-gw.log &
cd src-tauri && E2E_BASE=http://127.0.0.1:18950 E2E_OUT=/tmp/e2e-plans.json cargo test --lib e2e_dump_launch_plans -- --ignored
# E2E_AGENT 取 claude-code / codebuddy / qwen / opencode / codex；生成计划后马上跑（Claude 的 --settings 文件 60 秒后会被清）
MESA_E2E_REAL_CLI=1 E2E_PLANS=/tmp/e2e-plans.json E2E_AGENT=codex cargo test --lib e2e_channel -- --ignored --nocapture
# 可加：E2E_CLEAR=1（走完再发 /clear，看会话跟随）、E2E_RESUME=1（停掉后按 Mesa 的恢复参数接回再跑一轮）、
#       E2E_TIER=auto|full（换权限档）、MESA_CHANNEL_DEBUG=1（打印 Codex app-server 收到的每条消息）、
#       E2E_DROP_SETTINGS=1（去掉网关的 --settings，模拟官方账号启动；同时去掉拷来的 settings.json 里的 env，只打假网关）、
#       E2E_ARG_PROMPT=1（Claude / CodeBuddy：首条消息带换行、引号、|、%变量% 放进启动参数，核对原样进会话）、
#       E2E_DELETE_SETTINGS=1（发消息前删掉网关的 --settings 覆盖文件，看 hooks 还到不到）、
#       E2E_RAW=<文件>（终端原始输出按时间逐块记下，聊天层答审批的时刻另记一行；用终端模拟器回放看「答过以后终端里还挂着什么」）、
#       E2E_REPLY_DELAY_MS=<毫秒>（审批卡出来后等这么久再从聊天层答，像人一样先看一会儿）
#       E2E_PROMPT="TRIGGER_TOOL TRIGGER_THINK 跑一下"（假网关先出一段思考：Responses 推理摘要 / Anthropic thinking 块 / Chat reasoning_content，
#       报告末尾「正在跑的工具」「思考摘要」两行核对聊天层生成中那一行的取数；Codex 照旧加 TRIGGER_ESC）
```

Windows（2026-10-20 起同一份测试三平台都能跑）：在 Git Bash 里照上面执行，三处不同——
`python3` / `python` 在 PATH 上常先命中应用商店占位（退出码 49 / 9009），用 Python 安装目录下的 `python.exe` 起假网关；
`E2E_PLANS` / `E2E_OUT` 用 Windows 路径（`$(cygpath -w /tmp/e2e-plans.json)`）；测试自己设 USERPROFILE / CODEX_HOME 到临时目录，
Mesa 的状态日志与旁路目录走测试配置根，不碰真实 `%APPDATA%\ccode`。

**二、CLI 本身的机制（换版本时先跑这个）**：不经 Mesa，直接看每家旁路还在不在、形状变没变。

```bash
# hooks：每次启动注入（Claude / CodeBuddy 的 --settings，Qwen 的系统默认设置路径；Gemini 同法会被拒——系统设置文件必须属 root）
python3 -I scripts/e2e-model-routing/channel-probe.py /tmp/e2e-plans.json claude-code hooks /tmp/cp/claude.json
FULL_LOG=1 ...   # 记下整份 hook 日志，看各事件 payload
# Qwen Dual Output（审批从 input 文件答）
python3 -I scripts/e2e-model-routing/channel-probe.py /tmp/e2e-plans.json qwen dual /tmp/cp/qwen.json
# OpenCode 自带服务（OPENCODE_ASK=1 在 Mesa 注入的配置上加「跑命令先问」，不能整份覆盖 OPENCODE_CONFIG_CONTENT——会丢网关、打到真实服务）
OPENCODE_ASK=1 python3 -I scripts/e2e-model-routing/channel-probe.py /tmp/e2e-plans.json opencode opencode /tmp/cp/oc.json
# Codex：私有 app-server + TUI --remote + 第二个客户端；TRANSPORT=ws 走本机 TCP + 能力令牌（Mesa 用的就是这条）
TRANSPORT=ws python3 -I scripts/e2e-model-routing/codex-appserver-probe.py /tmp/e2e-plans.json /tmp/cp/codex.json
```

2026-10-20 结论：五家（Claude Code 2.1.292、CodeBuddy 2.169.0、Qwen 0.25.2、OpenCode 1.19.3、Codex 0.163.0）能不写用户配置地默认接上；
Gemini 0.64.0（系统设置文件须属 root）、Kimi 2.2.0（无指定配置的参数）、Grok 1.0.62（GROK_CONFIG 覆盖层不收 hooks）只能写全局配置；Cursor 无等价事件。
Codex 远程 TUI 恢复会话时拒收权限参数（Permission overrides are not supported when resuming a remote task），Mesa 改成 app-server 的 `-c` 配置。

2026-10-20 Windows 11 结论（Claude Code 2.1.304、CodeBuddy 2.170.0、Qwen 0.25.3、OpenCode 1.19.3、Codex 0.163.0，Mesa 的 `e2e_channel`）：
五家旁路全通（会话认出、回合 running → awaiting_approval → completed、审批内容、Qwen / Codex 聊天层答审批、/clear 跟随、接回）。
修之前不通的两处：官方账号的 Claude（内联 `--settings` 经 claude.cmd 包装被 cmd 拆坏，起不来）、带换行 / 引号 / `%` 的首条消息
（经 cmd 包装被截断 / 展开）——改为 shim 直启后 `E2E_DROP_SETTINGS=1 E2E_ARG_PROMPT=1` 通过。`E2E_DELETE_SETTINGS=1` 通过：
网关覆盖文件 60 秒后被清理不影响已启动的 Claude 继续触发 hooks。
