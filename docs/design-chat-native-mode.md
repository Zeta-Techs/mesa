# 聊天层原生模式：第 0 步探针记录（2026-11-26）

> 状态：**2026-11-26 用户已拍板**（§4 建议全部采纳，§6 待拍板四条按建议定），决策正文见 `conventions/product-decisions.md`「聊天层原生模式」；第 1 期 Codex 原生模式实施记录见文末。
> 背景：现在的聊天层是「终端是事实来源，聊天是同一进程的另一层」（`design-chat-structured-channels.md` §0），
> 读屏的家永远做不到「原生消息、原生审批卡、绝不按错」。原生模式 = CLI 跑在协议模式（没有 TUI），聊天层是这段会话的主人；
> 终端模式保留，两种模式按对话选、在空闲时经同一份会话记录互相接续。这次只验三家：Claude Code、Kimi、Antigravity CLI（agy），
> Codex 已有私有 app-server，不在这次。全部只连假网关，没碰真账号、没花模型调用。

## 0. 结论

| | Claude Code 2.1.326 | Kimi 2.7.3（中途自更新到 2.8.0） | agy 1.5.17 |
|---|---|---|---|
| 协议 | `-p` 双向 stream-json（SDK 的控制协议） | ACP（`kimi acp`） | ACP（`agy acp`） |
| 原生审批卡 | ✓ `can_use_tool`，带「总是允许」建议规则 | ✓ 允许一次 / 本会话总是允许 / 拒绝 | ✓ 只有允许 / 拒绝 |
| 提问表单 | ✓ 答案经 `updatedInput.answers` 回，不用按键 | — | — |
| 计划模式「要不要开工」 | ✓ `ExitPlanMode` 走审批，带方案全文与方案文件路径 | plan 模式下跑命令仍发审批（宿主要拒） | 有 plan 模式（未细测） |
| 边写边显示 | ✓ 加 `--include-partial-messages`，逐块 `text_delta` | ✓ 逐块 `agent_message_chunk` | ✓ 逐块 `agent_message_chunk` |
| 斜杠命令 | ✓ `/context` 等 48 条，结果直接回 | ✓ `available_commands_update` 列出 | ✓ 同左 |
| Mesa 的连接注入 | ✓ `--settings` / `--model` 原样生效 | ✓ `KIMI_MODEL_*` 环境变量生效 | ✗ **第三方自定义模型进不去**（§3.3） |
| 权限四档 | 四档都对得上 | 对得上，但模式名与 CLI 旗标错位（§3.2） | **缺「帮我批准」**；「完全访问」只能起进程时定 |
| 协议 → 终端接续 | ✓ 同一会话 id、同一份 jsonl | ✓ | ✓（但型号会变，§3.3） |
| 终端 → 协议接续 | ✓ | ✓ `session/load` 先回放历史再续 | ✓ |

一句话：**Claude 技术上最完整，但被订阅登录条款卡住（§1）；Kimi 可以直接做；agy 在第三方网关下暂时做不了。**

## 1. Claude 订阅登录的条款（2026-11-26 查）

- Agent SDK 概览页（code.claude.com/docs/en/agent-sdk/overview）：未经事先批准，第三方开发者不得为自己的产品提供 claude.ai 登录或订阅额度，
  点名「基于 Claude Agent SDK 搭的 Agent」，改用 API 密钥。
- 法律与合规页（code.claude.com/docs/en/legal-and-compliance）：不允许第三方把 Claude.ai 登录放进自己的应用，也不得收集、存储或中转
  Claude.ai 凭据与会话令牌；**用户在原样的 Claude Code 程序里用自己的订阅登录是允许的，平台托管 Claude Code 的情况也算**。例外只写了「联系销售」。
- 对 Mesa 的含义：
  - 终端模式（用户自己的 `claude`、自己登录）：明确允许，维持现状。
  - 原生模式：Mesa 当宿主、经 SDK 的控制协议驱动 `claude -p`。`-p` 没被点名，但用的正是 SDK 那套协议，**按保守口径视同 SDK 产品**：
    Claude 原生模式只对 API 密钥 / 中转网关连接开放，官方订阅账号的 Claude 对话只走终端模式。要放开需 Anthropic 书面同意。

## 2. 各家实测细节

### 2.1 Claude Code（`claude -p` 双向 stream-json）

- 启动：`claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompts host --permission-prompt-tool stdio`
  `[--include-partial-messages]`，后面接 Mesa 现有的 `--settings` / `--model` / `--permission-mode`。
- **`--permission-prompt-tool stdio` 是必需的隐藏参数**：`--help` 不单列它，只在 `--permission-prompts` 的说明里提到。不带它，
  要审批的工具一律被拒（`system:permission_denied`，工具结果写「needs approval」），宿主收不到请求。
- 握手：宿主发 `control_request` `initialize`，回包带命令清单；随后 `system:init` 带会话 id、工具清单、斜杠命令、当前权限模式。
- 审批：`control_request` `can_use_tool`，字段有 `tool_name`、`input`、`permission_suggestions`（「总是允许」的建议规则，如
  `addRules Bash(echo mesa *)`、`addDirectories`）、`blocked_path`、`tool_use_id`、`description`。宿主回 `control_response`
  `{behavior: allow, updatedInput}` 后照常执行。
- 提问表单（AskUserQuestion）走同一个 `can_use_tool`：`updatedInput` 里加 `answers: {题目: 选项}`，工具结果即「题目 = 绿」，不用按任何键。
- 计划模式（Mesa「只讨论」= `--permission-mode plan`）：`ExitPlanMode` 走 `can_use_tool`，带 `plan` 全文与 `planFilePath`；允许即「User has approved your plan」。
  探针里随后反复调 `ExitPlanMode` 是假网关按工具结果计数的问题，不是 CLI 的。
- 权限档：ask（`default`）问宿主；auto 由分类器判（分类器请求经网关，与终端里一样），不问宿主；full（`bypassPermissions`）不问；discuss 见上。
- 斜杠命令：`/context` 在协议里直接回 Markdown 明细（Mesa 现在为它起无头进程校准，原生模式下可以直接拿）。
- 续接：协议会话 `--resume <id>` 到终端，终端第一条请求带着协议那几轮，并写回同一份 jsonl；终端续过的再用协议 `--resume`，请求带着终端那一轮。会话 id 不变。

### 2.2 Kimi（`kimi acp`）

- 模型取 Mesa 注入的 `KIMI_MODEL_*`：会话的 `configOptions.model` 当前值就是 Mesa 的 `__kimi_env_model__`（显示名对）。
- 能力：`loadSession`，会话 list / resume / close / delete / fork；登录走 terminal 认证（`kimi login`）。
- 审批：`session/request_permission`，选项 `approve_once` / `approve_always` / `reject`（kind 为 allow_once / allow_always / reject_once）；
  `toolCall.title` 是工具名，命令原文在 `content` 的文字里，没有 `rawInput`（卡片要自己拆）。
- 配置项：model、thinking（off / on）、mode（default / plan / auto / yolo）。
- 续接：ACP 会话就写在 `~/.kimi-code/sessions/wd_*/session_*/agents/main/wire.jsonl`，即 Mesa 现有解析器读的那份；`kimi -S <id>` 打开
  终端能看到 ACP 那几轮，`kimi -S <id> -p` 的请求带着 ACP 那一轮；反向 `session/load` 先把历史逐条回放成 `session/update`，再接着聊。

### 2.3 Antigravity CLI（`agy acp`）

- `agy acp` 没有 `--settings` / `--model`，只有 `--dangerously-skip-permissions`、`--sandbox`、`--add-dir` 等进程级参数。
- 审批：选项只有 `allow` / `deny`，没有「总是允许」；`toolCall` 带 `rawInput`（`CommandLine` 等），`title` 是命令本身。
- 配置项：model、thought_level、mode（default / accept-edits / plan）。
- 续接：ACP 的 `sessionId` 就是 `--conversation` 的 id，两向都通。

## 3. 发现的坑

1. **Claude 的审批参数是隐藏参数**（§2.1）。原生模式靠它，金丝雀必须盯：加一层「协议」指纹，核对 `can_use_tool` 的字段与 `--permission-prompt-tool stdio` 还在。
2. **Kimi 模式名与 CLI 旗标错位**：终端的 `--yolo` 是「Ask When Needed」（Mesa「帮我批准」），对应 ACP 的 `auto`；终端的 `--auto` 是
   「Never Ask」（Mesa「完全访问」），对应 ACP 的 `yolo`。照字面映射会把「帮我批准」开成全放行。另外 plan 模式下跑命令仍会发审批请求，
   「只讨论」档宿主必须拒，不能交给用户点。
3. **agy 的第三方模型进不去**：Mesa 给的 `customModelsConfig` 写进 `settings.json` 后 ACP 不读（日志「Setting default model override: Gemini 3.1 Pro (Low)」），
   `session/set_model` 与 `session/set_config_option` 都报 `Unknown model ID: mesa/e2e-picked`；请求仍打到 `GOOGLE_GEMINI_BASE_URL`，型号却是官方的。
   同一段对话从终端切回 ACP，型号从 Mesa 选的变成默认 Gemini。官方登录线不受影响。
4. **agy 缺「帮我批准」**：ACP 模式里没有 Mesa 现在用的 `--mode auto`；「完全访问」只能起进程时带 `--dangerously-skip-permissions`，会话里切不了。
5. **切换时型号要核对**：上面第 3 条说明「同一份会话记录」不等于「同一套设置」，切换后要比对模型、思考档、权限档，对不上就提示，不能默默换。

## 4. 对方案的影响（建议，待拍板）

1. Codex 原生模式（复用私有 app-server）仍是第一步：成本最低，先把「原生审批卡 + 空闲切换」的体验跑通。
2. Kimi 可以排第二：协议齐全、连接注入照旧生效、会话文件与 Mesa 现有解析同一份。按 §3.2 修正模式映射。
3. Claude 技术上最完整，但只对 API 密钥 / 中转网关连接开放（§1）；同时给金丝雀加协议层（§3.1）。
4. agy 在第三方网关下先不做，只给官方登录线，或等上游修好自定义模型；upstream.json 的 agy `acp` 结论等拍板后再改。
5. 默认仍是终端模式，原生模式按家点亮、标「测试版」。切换只在回合空闲时做，并按 §3.5 核对设置。

## 5. 复现

```bash
PROBE_DIR=/tmp/native python3 -I scripts/native-probe/prepare.py 18931   # 起假网关、生成 plans.json、拷设置文件
cd /tmp/native
EXTRA="--permission-prompt-tool stdio" python3 <仓库>/scripts/native-probe/claude_probe.py ask c-tool tool   # 档：ask / auto / full / discuss
python3 <仓库>/scripts/native-probe/acp_probe.py kimi k-tool tool          # MODE=<模式> 先切模式；LOAD=<会话 id> 走 session/load
python3 <仓库>/scripts/native-probe/acp_probe.py agy a-tool tool           # SETMODEL=<型号> 试会话内换模型
python3 <仓库>/scripts/native-probe/tui_resume.py claude-code c-tool "--resume <会话 id>"   # 终端接回，看请求带不带旧轮
```

每次输出目录里有 `wire.log`（逐条收发）与 `report.json`。假网关按整段请求找触发词，同一会话里前一轮的 `TRIGGER_TOOL` 会盖过后面的
`TRIGGER_ASK` / `TRIGGER_SLOW`，这几种各开一个输出目录跑。`tui_resume.py` 在 Kimi 上送不进回车（Kimi 开了 kitty 键盘协议），
所以 Kimi / agy 的「协议 → 命令行」一项改用 `-S <id> -p` / `--conversation <id> -p` 验。

## 6. 没验到的，与待拍板

没验到：
- 切换时后台任务（Claude 的后台命令、子 Agent、Monitor）会不会被杀。按进程模型推断一定会，切换前要先查有没有后台任务在跑。
- 真模型、Windows、Codex 原生模式、其余六家的 ACP。

待拍板：
1. 是否推翻 §11「ACP 不进交互聊天层」与 §12「切换界面就杀进程不借」（`design-chat-structured-channels.md`）。
2. Claude 原生模式只开放 API 密钥 / 中转网关连接（§1）。
3. 默认模式（建议仍是终端）与首批点亮的家（建议 Codex → Kimi → Claude）。
4. agy 原生模式先不做，还是只开官方登录线。

## 第 1 期实施记录：Codex 原生模式（2026-11-26，分支 `feat/chat-native-codex`）

Codex 能双客户端：Mesa 的私有 app-server 照旧起、终端里的 TUI 照旧以 `--remote` 连上去，原生模式只改聊天层怎么发——
不往终端里打字，改由 Mesa 这个客户端经 `turn/start` 发起这一轮、经 `turn/interrupt` 停止，审批本来就经通道回。终端不重启、不断开。

先实测（codex 0.172，假网关，`chat_channel::e2e::e2e_channel` 加 `E2E_NATIVE=1`）：
- TUI 一起来就建好线程（`thread/loaded/list` 有），但第一轮之前没有 rollout，`thread/resume` 报「no rollout found」；
  第二个客户端发 `turn/start` 照样能跑，回包带回合 id，之后约 0.02 秒就能订阅上。所以发出后先在本地开回合，订阅由 `thread/status/changed` 补。
- 第二个客户端发起的回合终端里照样画出（用户那句、命令、回复），审批菜单也画出；从 Mesa 批准后终端菜单跟着撤。
- `turn/interrupt` 停的是这一轮，回合收成 cancelled，会话不退出；过期回合号被拒。

落地：
- 后端（`chat_channel.rs`）：`chat_channel_send`（async + spawn_blocking；Codex 通道连着、认出线程、这一轮没在跑才发）；
  `codex_request` 发请求等回包（`CodexState.waiters`，10 秒上限，出错用 CLI 原话并脱敏）；`CodexState.turn` 记当前回合 id；
  `chat_channel_interrupt` 放开 Codex。
- 前端：标签 `nativeMode`（按对话记、进重启白名单）；`TerminalView.sendMessage` 原生模式且 `canSendViaChannel` 时走 `chat_channel_send`，
  斜杠 / `!` 命令、还没认出对话的第一句、通道断了照旧打进终端；停止按钮原生模式经通道停；
  开关在模型菜单说明页（`ChatBetaNotes`），只对 `nativeModeAvailable` 的家出。
- 没做（留给后续期）：没有 TUI 的纯协议运行时（Kimi ACP、Claude `-p`）、空闲时切换模式、切换后核对设置、金丝雀的协议层指纹。

