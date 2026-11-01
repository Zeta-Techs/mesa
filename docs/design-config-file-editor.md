# 连接页「编辑配置文件」设计（2026-11-01）

用户（2026-11-01，对照 cc-switch 的供应商编辑页）：「每一家这种详细的配置文件，是否可以放在 Mesa 的连接里，作为更多操作项」。

## 要解决什么

连接页能「设为全局」，但用户想顺手改 CLI 配置里 Mesa 不管的部分（权限、MCP 之外的开关、上下文窗口、通知……），只能自己去翻
`~/.codex/config.toml`、`~/.claude/settings.json`。这一项把各家 Agent 的全局配置文件搬进连接页：看得见、改得了、改坏了能撤销。

## 入口与界面

- Agent 节标题（及左栏单家视图）的 `⋯` 菜单：**编辑配置文件…**。这家没有可编辑的文件（Cursor）时不出现。
- 打开是一个大弹层：顶部 `编辑配置文件 · <Agent>`，下面按文件分页签（只有一个文件时不画页签），每页显示文件的完整路径。
  正文是 Monaco 编辑器（JSON / TOML / .env 着色，跟随应用主题）。底部左边一行说明，右边「格式化」（仅 JSON）「取消」「保存」。
- 文件还不存在：编辑器为空，说明行写「文件还不存在，保存后新建」。
- 关掉前有没保存的改动：先确认。

## 文件清单（与「设为全局」同一份，认搬迁变量）

| Agent | 文件 |
|---|---|
| Claude Code | `settings.json` |
| Codex | `config.toml`（**不含 `auth.json`**：里面是登录令牌，手改只会把登录改坏；Mesa 也从不写它） |
| Gemini | `settings.json`、`.env` |
| Qwen | `settings.json` |
| CodeBuddy | `settings.json`、`models.json` |
| OpenCode | `opencode.json` / `opencode.jsonc`（存在哪个列哪个，都没有列 `opencode.json`） |
| Kimi | `config.toml`；旧版 kimi-cli 的 `config.toml` 存在时另列 |
| Grok | `config.toml` |
| Cursor | 无（`cli-config.json` 里没有连接相关的内容，Mesa 不写） |

## 密钥：Rust 层可还原占位

配置文件里常有明文密钥，而硬约束是「密钥绝不回显、前端遮盖不是安全边界」。所以：

- **读**：Rust 找出文件里的密钥值，换成占位 `«已隐藏密钥 ···<末4位> #<8位哈希>»` 再交给前端。认法三条，任一命中即算：
  ① 结构上键名像密钥（含 `key` / `token` / `secret` / `password` / `bearer` / `credential`，不分大小写）且值是长度 ≥ 8 的字符串——
  排除纯数字、环境变量名（`OPENAI_API_KEY` 这种全大写名）、`${VAR}` / `$VAR` / `{env:…}` / `{file:…}` 引用；
  ② 等于 Mesa 保存的任一把密钥（`profiles::stored_secrets`）；
  ③ .env 按 `KEY=VALUE` 套用①。
- **存**：重读磁盘，用同样的方法收集密钥（再加上 Mesa 保存的那些），按哈希把占位换回原值。占位对不上（被改了半截、来自别的文件）就拒绝保存并说明；
  用户把占位整个换成新值 = 换密钥，照写。
- 前端拿不到原值，也不提供「显示密钥」。

## 写入：与「设为全局」同一套防护

- 同一把进程锁 + 跨进程文件锁（`GLOBAL_CONFIG_MUTEX` + `config_lock("global-config")`），同一套批次事务（`transact`，写前备份、
  原子替换、失败回滚，首次写入落原始快照）。所以写错了用同一菜单里的「撤销上次写入」/「恢复初始状态」回退。
- 乐观并发：读时带回磁盘原文的哈希（`revision`），保存时磁盘哈希变了就拒绝，提示重新载入（CLI 自己、cc-switch、别的会话都可能改它）。
- 保存前校验格式：JSON（`.jsonc` 与 Gemini / Qwen 的 settings 容许注释）根必须是对象；TOML 能解析；.env 每行 `KEY=VALUE` 或注释、值不含换行。
  校验不过不写，报出错位置。内容没变不写。
- 保存后照常走漂移判定：改了 Mesa 设为全局写过的键，连接页会显示「外部改过」，这是对的。

## 不做

- 不做 cc-switch 那种「隐藏 AI 署名 / 禁用自动升级」快捷勾选（每家键名不同、随版本漂移，先给原文编辑；要做另立一项）。
- 不按连接存一份配置片段在启动时注入（那是另一个功能：连接级附加配置，需要逐家确认能注入的层）。
- 不编辑 MCP、技能、hooks 的专属文件（各有专页管理）。

---

# 编辑连接的「配置」视图（2026-11-01 第二部分）

用户随后指着 cc-switch 的「编辑供应商 · 配置 JSON」：要**按连接**编辑，「有的是 json 有的是 toml，每一家都要做」。
两处拍板：编辑的是**连接本身**（不是 CLI 附加配置）；片段里写了连接之外的 CLI 键 **拦下**，指去「⋯ 编辑配置文件」。

## 界面

编辑**已有**连接的弹层顶部多一对切换：**表单 / 配置**（新建连接仍只有表单：选网关、套预设、同时绑定多家都在表单里）。
「配置」是一个 Monaco 编辑框，按这家 CLI 自己的格式显示这条连接——就是「设为全局」会写进它配置文件的那几项；
原生格式放不下的连接字段放在 `mesa` 小节。切回表单或点保存时解析片段、写回表单字段，再走原来的保存。
解析不过（格式错、写了连接之外的键、默认模型不在名单里）留在「配置」页报错，不保存。

## 九家映射（`connection_snippet.rs`，渲染与解析同一张表）

| Agent | 格式 | 原生键 | 其余进 `mesa` |
|---|---|---|---|
| Claude Code | settings.json | `env.ANTHROPIC_BASE_URL` `env.ANTHROPIC_AUTH_TOKEN` `env.CLAUDE_CODE_MAX_OUTPUT_TOKENS` `model` `effortLevel` | 名单、温度、top_p … |
| CodeBuddy | settings.json | `env.CODEBUDDY_BASE_URL` `env.CODEBUDDY_API_KEY` `env.CODEBUDDY_CODE_MAX_OUTPUT_TOKENS` `model` | 思考档 … |
| Qwen | settings.json | `security.auth.selectedType`（协议）`env.OPENAI_*` / `env.ANTHROPIC_*`（地址、密钥）`model.name` | |
| Gemini | settings.json + .env | `model.name`；`env.GOOGLE_GEMINI_BASE_URL` `env.GEMINI_API_KEY`（实际在 .env） | |
| OpenCode | opencode.json | `model`（`mesa/<默认>`）`provider.mesa.options.baseURL / apiKey` `provider.mesa.models`（名单） | |
| Cursor | 环境变量 | `env.CURSOR_API_KEY` `env.CURSOR_API_ENDPOINT` `model` | |
| Codex | config.toml | `model` `model_reasoning_effort` `model_provider` `[model_providers.custom].base_url` | 密钥（Codex 配置里没有放明文的位置） |
| Kimi | config.toml | `default_model` `[providers.mesa]` `type`（协议）`base_url` `api_key` | |
| Grok | config.toml | `[models]` `default` `default_reasoning_effort` `temperature` `top_p` `max_completion_tokens`；`[model."<默认>"]` `base_url` `api_key` `api_backend` | |

`mesa` 小节通用键：`name`、`models`（第一个是默认；原生默认模型不在名单里报错，在就挪到第一个）、`temperature`、`top_p`、
`max_output_tokens`、`reasoning_effort`（这家没有原生键时）、`headers`（请求头 → 环境变量名）、`extra_env`、`no_auth`、`protocol`、
`role_models`。官方账号的连接不显示地址和密钥。渠道 / provider 名在片段里固定写 `custom` / `mesa`，只是展示用，解析时认任意一个名字。

## 打开真实文件（同日补）

用户看了「配置」视图问要不要加定位入口。片段是 Mesa 按连接拼的、不是文件原文，真实文件里还有别的渠道、MCP、全局键；
从这里去「⋯ 编辑配置文件」要先退回连接页。所以格式说明行右侧加「打开文件」：打开第一部分那个编辑弹层并定位到这家的主配置文件
（`connection-snippet.ts snippetFileTag`，Cursor 没有），弹层说明改成「这是文件原样，里面是现在全局生效的配置，不一定是你在编辑的
那条连接」。不走访达 / 外部编辑器：那里密钥是明文、改了不经 Mesa 备份。弹层叠在面板上，片段没保存的改动不受影响。

## 哪些字段在这里能改

编辑已有连接时后端只改连接自己的字段（`ProfileStore::update`：名称、协议、API 后端、模型名单、模型分工、附加环境变量）；
地址、密钥、无密钥、请求头、温度 / top_p / 输出上限 / 思考档属于网关，只走网关接口。片段里照样显示这些（与 CLI 实际配置一致），
改了就在解析时拦下，指去页头「网关库」（`connection-snippet.ts gatewayOwnedChanges`），不悄悄丢掉。

## 密钥

前端本来就拿不到已存的密钥。片段里显示 `«已保存密钥 ···末4位»`：保持不动 = 不改；换成别的字符串 = 换新密钥（随保存提交，和表单里填新密钥同一条路）；
删掉这一行也当不改（不能在片段里清空密钥）。
