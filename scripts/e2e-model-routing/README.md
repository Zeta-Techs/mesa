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

## 聊天层结构化旁路（2026-10-20）

设计与结论见 docs/design-chat-structured-channels.md。两层核对，都只打本机假网关、临时 HOME：

**一、Mesa 自己的实现（推荐）**：Rust 端到端测试走真实的 `chat_channel::prepare` / 旁路读取 / 审批回复，看快照里会话、回合、审批对不对。

```bash
python3 -I scripts/e2e-model-routing/gateway.py 18950 /tmp/e2e-gw.log &
cd src-tauri && E2E_BASE=http://127.0.0.1:18950 E2E_OUT=/tmp/e2e-plans.json cargo test --lib e2e_dump_launch_plans -- --ignored
# E2E_AGENT 取 claude-code / codebuddy / qwen / opencode / codex；生成计划后马上跑（Claude 的 --settings 文件 60 秒后会被清）
MESA_E2E_REAL_CLI=1 E2E_PLANS=/tmp/e2e-plans.json E2E_AGENT=codex cargo test --lib e2e_channel -- --ignored --nocapture
# 可加：E2E_CLEAR=1（走完再发 /clear，看会话跟随）、E2E_RESUME=1（停掉后按 Mesa 的恢复参数接回再跑一轮）、
#       E2E_TIER=auto|full（换权限档）、MESA_CHANNEL_DEBUG=1（打印 Codex app-server 收到的每条消息）
```

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
