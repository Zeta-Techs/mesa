# 聊天层结构化升级：从读屏推断到读 CLI 自己给的结构化事件

| 项 | 值 |
|---|---|
| 日期 | 2026-10-19 |
| 状态 | **已实现（2026-10-20，用户「按推荐的来，一次性做完」）**；实施结果与偏差见文末「实施记录」 |
| 范围 | 运行页聊天层的数据来源：会话归属、回合状态、对话条目、工具调用、审批、实时预览、增量推送 |
| 前置 | `docs/design-chat-layer.md`（聊天层一至三期，界面与控件已定稿，本方案不改界面布局） |
| 参照 | Qwen Code Dual Output、slopus/happy、BloopAI/vibe-kanban、Agent Client Protocol（ACP）规格、Codex app-server 协议、OpenCode server API、iOfficeAI/AionUi 的 ACP 产品需求文档；快照在 `.reference/`（§2） |

---

## 0. 结论

**运行方式不变**：CLI 的 TUI 仍跑在 PTY 里，终端仍是事实来源，聊天与终端仍是同一进程的两层。

**变的是聊天层从哪里取信息**。现在主要靠三样：读会话文件、读终端画面、（用户手动开了才有的）全局 hooks 日志。本方案让每家 CLI 用**它自己提供的结构化旁路**把事件交给 Mesa，统一成一种对话条目模型，由 Rust 里一个回合状态机给出唯一的「这一轮在哪一步」，再增量推给前端。读屏退为没有旁路时的兜底，不删。

各家能用的旁路差别很大，所以是逐家接，不是一刀切：

| 档 | CLI | 旁路 | 本机核实（2026-10-19） |
|---|---|---|---|
| 一 | Qwen Code 0.25.2 | 官方 Dual Output：`--json-file` 事件流 + `--input-file` 反向命令，专为「终端 + 聊天双界面同步」设计 | ✓ PTY 内握手成功（§8.1） |
| 一 | OpenCode 1.19.3 | TUI 自带本机 HTTP 服务：`--port` + SSE `/event` + 审批回复接口 | ✓ 服务、SSE、接口清单（§8.2） |
| 二 | Claude Code 2.1.292 | 每次启动用 `--settings` 注入 hooks（不写用户配置），hook 进程继承 PTY 环境变量 | ✓ SessionStart 带标签号回传（§8.3） |
| 二 | Gemini / Kimi / Grok / CodeBuddy | 现有 hooks 桥接（用户手动开）+ 标签号；逐次注入方式待核实 | 部分（§8.4） |
| 三 | Codex 0.163 | 私有 app-server + TUI `--remote` 连同一服务，Mesa 作为第二个客户端 | 只核实了协议清单，需单独试验（§8.5） |
| — | Cursor | 无旁路，维持会话文件 + 读屏 | — |

ACP 在本方案里的位置：**借它的数据模型**（工具调用的 kind / status / locations / diff、计划、停止原因），**不拿它替换 PTY**（§11）。

---

## 1. 现状诊断（读代码得出，按影响排序）

| # | 问题 | 代码位置 | 后果（历史实证） |
|---|---|---|---|
| 1 | **回合状态由多个弱信号拼出来**：会话尾部 `session_tail_state` + PTY 出字（8 秒 `PTY_LIVE_MS`）+ armed 静默上限 120 秒 + 收尾推迟重试 + hooks 日志 10 分钟 TTL | `src/tab-working.ts:58` `applyTailAttention`；`TerminalPage.tsx:3770-3822` | 「正在回复」不灭 / 提前灭反复出现：conventions/terminal.md 记了 09-13、09-18、09-19、10-17、10-18 五次修补 |
| 2 | **会话归属靠排他声明猜**：同 agent、同目录的新会话按启动时间排队认领；`--session-id` 只有三家支持 | `sessions.rs:5504` `claim_session_for` | 同目录同 agent 开两个标签时有认错风险；`/clear`、`/compact` 换了会话文件，聊天层仍盯着旧文件（斜杠面板提供 `/clear`，但没有跟随逻辑） |
| 3 | **刚发出的消息靠正文「包含」匹配** | `TerminalPage.tsx:3664-3681` | 注释里已记录残留草稿拼接导致精确匹配失败；重复发同一句时靠「必须出现新回复」第二道闸兜底 |
| 4 | **审批靠认屏 + 写按键**；「在等什么」只来自 hooks Notification 的一句 message | `src/tui-menu.ts`；`hooks.rs:783` `session_confirm_detail` | 卡片上看不到完整命令或要改的差异；每个 CLI 新版本都要重抓屏验证菜单形态 |
| 5 | **每次文件变动整页重解析、整页重传**；DTO 没有条目 id | `get_session_conversation_page`（`sessions.rs:6084`）；`ConversationView.tsx` 以下标做 key；`TerminalPage.tsx:3718` 用 `JSON.stringify(blocks)` 当消息身份 | 长对话每次刷新代价随长度增长；无法表达「这条工具调用状态变了」，只能整页替换 |
| 6 | **工具调用没有 id 和状态**：`BlockDto` 只有 kind / text / toolName / isError | `src/types.ts:636` | 调用与结果按顺序配对；「进行中 / 等批准 / 被拒 / 已中断」都靠推断 |
| 7 | **实时预览靠逐家画面布局** | `src/live-reply.ts` | CodeBuddy、OpenCode 读不出；每次 TUI 改版都可能失效 |
| 8 | **Claude 的 hooks 默认关** | `hooks.rs` 写 `~/.claude/settings.json` | 因为要写用户全局配置，只能让用户逐家手动开；最常用的一家拿不到精确事件 |

共同根因：**状态是猜出来的，不是 CLI 告诉我们的。** 而九家里有多家其实已经提供了「边跑 TUI 边吐结构化事件」的官方机制，Mesa 没有用上。

---

## 2. 参照项目：学什么、不学什么

借鉴原则沿用 AGENTS.md：学机制和取舍，不抄代码；与 `docs/architecture.md` 冲突时以它为准（会话解析只读、不走本地代理主线）。

| 项目（许可） | 和 Mesa 的关系 | 借 | 不借 |
|---|---|---|---|
| **Qwen Code Dual Output**（Apache-2.0）<br>`.reference/qwen-code/docs/users/features/dual-output.md` | 文档第一个用例就是「桌面聊天界面在 PTY 里跑 TUI，同时用结构化事件流画并行的对话视图」，和 Mesa 的结构一致 | 旁路事件流 + 反向命令文件；审批「哪边先答算哪边」；旁路失败绝不影响 TUI；握手事件带协议版本与能力清单，按能力探测而不是按版本号猜 | FIFO 方案（Windows 不可用，统一用普通文件） |
| **slopus/happy**（MIT）<br>`.reference/happy/` | 手机端控制 Claude / Codex；本地模式就是「TUI 照跑 + 盯 JSONL」 | `sessionScanner.ts`：按条目 uuid 去重、新会话出现后旧文件继续盯（CLI 可能还在往旧文件补写）、文件未出现时盯父目录；`generateHookSettings.ts` / `startHookServer.ts`：用每次启动的 `--settings` 注入 SessionStart hook，让 CLI 直接告诉「这个进程现在是哪个会话」（其注释明说文件监听在多进程时有竞态）；回合状态机（`docs/plans/generic-acp-runner.md`：开始 / 结束幂等、每轮一个 id） | 本地 ⇄ 远程切换要杀进程重开（Mesa 两层共用一个 PTY，切层不能重启）；`claudeLocal.ts` 用自带 launcher 拦截 fetch 判断「在思考」——侵入 CLI 运行时，绕过 `resolve_binary` |
| **BloopAI/vibe-kanban**（Apache-2.0，Rust）<br>`.reference/vibe-kanban/crates/executors/src/` | 多家 agent 的无头执行器，每家一个 `normalize_logs` | `logs/mod.rs` 的 `NormalizedEntry`：`ToolStatus`（Created / Success / Failed / Denied / PendingApproval / TimedOut）、`ActionType`（FileRead / FileEdit{changes} / CommandRun{result, category} / Search / WebFetch / TodoManagement / AskUserQuestion…）；`shell_command_parsing.rs` 把 shell 命令再分读 / 搜 / 改 / 取网；`patch.rs` 按条目下标发 add / replace 的增量补丁 | 交互对话走无头 stream-json（会丢掉 TUI） |
| **ACP 规格**（Apache-2.0）<br>`.reference/agent-client-protocol/docs/protocol/v1/` | 编辑器与 agent 之间的标准协议；registry 收录了 Mesa 的九家 | `tool-calls.mdx`：toolCallId、kind（read / edit / delete / move / search / execute / think / fetch / switch_mode / other）、status（pending / in_progress / completed / failed）、locations（路径 + 行）、diff（path / oldText / newText）、权限选项四种 kind；`agent-plan.mdx`：计划整表替换语义；`prompt-turn.mdx`：stopReason（end_turn / max_tokens / max_turn_requests / refusal / cancelled）、`usage_update`（used / size / cost）、按 id 定位的压缩条目、`messageId` | 用 ACP 运行时替换 PTY（§11） |
| **Codex app-server 协议**（Apache-2.0）<br>本机 `codex app-server generate-json-schema` 生成 | Codex 官方客户端共用的服务协议 | thread → turn → item 三层；审批是服务端发来的**请求**（`item/commandExecution/requestApproval` 等），解决后另发 `serverRequest/resolved` 让各端撤卡；`turn/started` / `turn/completed` 明确回合边界 | 现阶段直接改用 app-server 驱动对话（先试验，§8.5） |
| **OpenCode server API**（MIT） | OpenCode TUI 本身就是本机 HTTP 服务的客户端 | SSE 事件（`permission.asked` / `session.idle` / 文本增量 / `todo.updated`）+ 回复接口 + `/tui/submit-prompt` | — |
| **iOfficeAI/AionUi**（Apache-2.0）<br>`.reference/AionUi/docs/prds/conversations/acp/` | 纯 ACP 的多 CLI 聊天客户端，产品形态最接近 | PRD 写法（每个功能点：用户故事 / 正常流程 / 异常 / 各家差异 / 验收标准），本方案 §13 照此写；「回复超时不计工具执行与等审批的时间」；「同一轮计划复用同一块展示区」；「多个审批按顺序展示」 | 免确认模式下「自动选第一个选项」（违反 Mesa「不替用户回答任何确认菜单」）；只走 ACP、不留终端 |
| winfunc/opcode、siteboon/claudecodeui、batrachianai/toad | 同类产品 | 不读源码 | **AGPL-3.0**，与 Mesa 的 Apache-2.0 不兼容，不引入任何实现 |

快照说明：网络慢，未做整仓克隆，只按需取了上面引用到的文件，放在 `.reference/<项目>/` 同名路径下（`.reference/` 已在 .gitignore）。需要更多文件时按同样方式补取。

---

## 3. 总体结构

```
用户按键 ──────────────────────────────┐
                                        ▼
                     PTY：CLI 的 TUI（事实来源，不变）
          ┌───────────┬───────────────┼──────────────┬───────────────┐
          ▼           ▼               ▼              ▼               ▼
   [A] 结构化旁路  [B] 逐次注入的   [C] 会话文件   [D] 终端画面     （PTY 出字时刻）
   Qwen 事件文件    hooks（带标签号）  追加读取       菜单 / 实时预览
   OpenCode SSE
   Codex app-server
          └───────────┴───────┬───────┴──────────────┴───────────────┘
                              ▼
               Rust：每个标签一份 chat_stream
       归一化 → 对话条目表（按 id）+ 回合状态机 + 待决定事项
                              ▼  事件 chat-patch-<tabId>（增量）
                         ChatSurface 渲染
```

**同一件事有多个来源时，取精度最高的那个；低的只补空缺。** 优先级 A > B > C > D。每条事实带 `source` 字段，界面不显示，诊断包里可见，便于回答「这次为什么判断错」。

必须守住的约束（都是已有规则，本方案不放宽）：

1. **终端是事实来源**：旁路事件全部是 CLI 自己吐的，Mesa 不合成；审批要么走 CLI 官方的回复通道，要么照旧写按键进 TUI；用户在终端里直接答也一样生效。
2. **零污染**：旁路一律用启动参数 / 环境变量 / Mesa 自己目录下的临时文件，不写用户的 CLI 配置。现有的全局 hooks 写入仍是用户手动开的那条路，用于「Mesa 之外的终端」。
3. **会话文件只读**：不变。
4. **密钥**：旁路文件放 `<config>/ccode/chat-channels/<tabId>/`，0600，标签关闭即删；事件进前端前走与会话文本相同的 Rust 层脱敏；OpenCode 服务口令只在拉起瞬间注入环境变量，不落盘、不回显。
5. **三平台**：不用 FIFO；只用普通文件 + 字节偏移追加读取。Codex 的 unix socket 在 Windows 上是否可用列为试验项。
6. **任一旁路失败就退回今天的行为**，功能不减。旁路是增益，不是前提。

---

## 4. 统一对话条目模型（借 ACP + vibe-kanban）

### 4.1 字段

在现有 `ChatMessageDto` / `BlockDto` 上**只加字段、不改旧字段**（嵌套结构整体 camelCase，见 AGENTS.md 的 serde 规则），对话页回放与项目对话预览不受影响：

```text
ChatMessageDto
  id            来源给的稳定 id：Claude uuid / Codex item id / Qwen uuid / OpenCode message id；
                来源没有时用「文件路径 + 行起始字节偏移」
  turnId        属于哪一轮（回合状态机分配，§5）
  source        sidecar | hook | file | screen
  …原字段不变

BlockDto
  …原字段不变
  callId        工具调用 id（Claude tool_use.id / Codex call_id / Qwen tool_use_id / OpenCode callID）；
                tool_use 与 tool_result 按它配对，不再按顺序
  status        pending | awaiting_approval | in_progress | completed | failed | denied | cancelled
  kind          ACP ToolKind：read | edit | delete | move | search | execute | think | fetch | switch_mode | other
                ＋ Mesa 扩展：ask | task | todo | skill | mcp（与 tool-activity.ts 现有 ActivityKind 对齐）
  locations     [{ path, line? }]
  diff          [{ path, oldText?, newText }]（Claude Edit 的 old_string/new_string、Codex apply_patch、Qwen edit…）
  command       { text, category: read|search|edit|fetch|other, exitCode? }
  plan          [{ content, status: pending|in_progress|completed, priority? }]（只在计划块上有）
```

### 4.2 分工

- **身份与生命周期**（id / callId / status / turnId）只能由后端给：它看得到原始记录与旁路事件。
- **怎么说给人听**（动词、目标、目录折叠、差异行）留在前端 `tool-activity.ts`，它已经按九家工具名做了归类，不搬家。来源本身带 kind 时（旁路、ACP 形态的 Grok 会话）优先用来源的，认不出再走名字表。
- **shell 命令再分类**（借 vibe-kanban `CommandCategory`）：`cat / head / tail / ls / sed（无 -i）` 算读取，`grep / rg / find / awk` 算搜索，带文件重定向、`sed -i`、`rm / mv / cp / chmod / tee` 算修改，`curl / wget` 算取网。Codex 几乎所有动作都是 `exec_command`，有了这一步，「已工作」摘要才能说「读了 3 个文件、改了 2 个、跑了 1 条命令」，而不是「运行 6 次」。
- **计划**：Claude `TodoWrite`、Codex `update_plan`、Qwen `todo_write`、OpenCode `todowrite` 统一成计划块；每轮只有一块，后来的整表替换前面的（ACP plan 语义；AionUi「同一轮复用同一展示区」）。

---

## 5. 回合状态机（借 happy 的幂等回合 + ACP stopReason + Codex turn 边界）

新模块 `src-tauri/src/chat_turn.rs`，每个标签一份，取代前端散在 `pendingReply` / `attention` / `armed` / `settleRetry` 几处的判断。

```text
idle ──提交──▶ submitted ──开始干活──▶ running ⇄ awaiting_approval
                                          │
                     ┌────────────────────┼─────────────────────┐
                     ▼                    ▼                     ▼
                 completed            failed / refused      cancelled / interrupted
                （带 stopReason）
```

| 转移 | A 旁路 | B hooks | C 会话文件 | D 终端（兜底） |
|---|---|---|---|---|
| 提交 | Qwen `user`；OpenCode `session.next.prompted`；Codex `turn/started` | `UserPromptSubmit`（带 prompt 原文） | 文件里出现这条 user | 写 PTY 那一刻（今天的乐观消息） |
| 等批准 | Qwen `control_request`；OpenCode `permission.asked`；Codex `…/requestApproval` | `Notification(permission_prompt)` / `PermissionRequest` | — | `tui-menu.ts` 认出菜单 |
| 批准结束 | Qwen `control_response`；OpenCode `permission.replied`；Codex `serverRequest/resolved` | 下一个 `PreToolUse` / `PostToolUse` | 工具结果落盘 | 菜单从屏上消失 |
| 结束 | Qwen `result`；OpenCode `session.idle`；Codex `turn/completed` | `Stop` / `AfterAgent`（grok 只认 `end_turn`） | 收尾标记（Claude `turn_duration`、Codex `task_complete`、Kimi `turn.ended`、Cursor `turn_ended`） | 今天的 `applyTailAttention` 整套（只在 A/B/C 都没有时启用） |

规则：

1. **幂等**：重复的「开始」不开新轮，没开始的「结束」忽略，重复的「结束」只算一次。
2. **高精度来源出现后，低精度来源只补空缺**：例如 Qwen 有了 `result`，PTY 还在重绘也不再续转圈。这正是 10-17 / 10-18 两次修补想要但只能逐家打补丁实现的效果。
3. **超时不计等批准和工具执行的时间**（AionUi F-RELIABILITY-02）；120 秒静默上限只在兜底模式下生效。
4. **乐观消息对齐**：hooks `UserPromptSubmit` 和旁路 `user` 事件都带原文与时间，用它们确认「这条已被 CLI 收下」，正文包含匹配降为兜底。
5. 前端只渲染回合状态，不再自己推断；`tab-working.ts` 的标签转圈规则（不上强调色、启动不转圈等）不变，输入从「几个信号自己拼」换成「状态机给的状态」。

---

## 6. 会话归属与跟随（借 happy 的 SessionStart hook + Qwen 握手事件）

1. **PTY 环境加 `CCODE_TAB_ID`**（另加 `CCODE_RUN_ID`，没有就不设）。不含任何密钥。hook 子进程会继承它——已在 Claude 2.1.292 上核实（§8.3）。
2. **会话 id 由 CLI 直接告诉 Mesa**：

   | CLI | 来源 | 覆盖的情形 |
   |---|---|---|
   | Claude Code | 逐次注入的 `SessionStart`，payload 有 `session_id`、`transcript_path`、`source`（startup / resume / clear / compact） | 新开、恢复、`/clear`、`/compact` |
   | Qwen | 旁路第一条事件 `system/session_start` | 新开、恢复 |
   | OpenCode | SSE `session.created` / `tui.session.select` | 新开、切换 |
   | Codex（试验后） | `thread/started` | 新开、恢复、分叉 |
   | Gemini / Kimi / Grok / CodeBuddy | 用户开了全局 hooks 时，hook 命令多记一个 `$CCODE_TAB_ID` 前缀 → 能按标签归属 | 视各家事件 |
   | 其余 | 现有 `--session-id` 预分配 / `claim_session_for` | 不变 |

3. **跟随换文件**（借 happy `onNewSession`）：同一标签收到新的会话 id → 聊天层切到新文件，旧文件继续盯一段时间（CLI 可能还在补写）；对话流插一行灰字「已开始新对话（/clear）」或「上下文已压缩」。
4. **认领逻辑不删**：没有任何精确来源的家照旧用它；有精确来源时它不参与。

---

## 7. 增量推送（借 happy 的按 id 去重 + vibe-kanban 的增量补丁）

1. 后端为每个标签记「已读到的字节偏移 + 已出现的条目 id」。文件变动时只解析新追加的部分（JSONL 天然按行追加）。
2. 推送事件 `chat-patch-<tabId>`，三种操作：`add`（新条目）、`replace`（同 id 的条目更新，例如工具调用 pending → completed）、`reset`（见下）。
3. 以下情形回退为整页重读并发 `reset`：文件变短或被替换（偏移失效）、压缩格式（Codex 归档 .zst）、OpenCode SQLite（第三期改用它的 API）。
4. 前端以条目 id 做 React key，`JSON.stringify(blocks)` 当身份的写法退役。
5. 「加载更早的消息」分页机制不变（仍用现有 cursor）。

---

## 8. 各家旁路细则

### 8.1 Qwen Code：Dual Output（第一档，先做）

- **启动**：`qwen … --json-file <channels>/<tab>/events.jsonl --input-file <channels>/<tab>/input.jsonl`，两个文件 Mesa 先建好、0600。
- **得到**：
  - `system/session_start`：会话 id、cwd、`protocol_version`、`supported_events`。
  - `stream_event`：文本增量，替代 Qwen 的读屏实时预览。
  - `user` / `assistant`：带 uuid，assistant 带 usage。
  - `control_request{subtype: can_use_tool, tool_name, tool_use_id, input}`：审批，内容是结构化的。
  - `control_response`：无论在 TUI 里答还是外部答，各端都收到最终结果。
  - `result`：回合结束，带用时与用量。
- **审批回复**：在 `input.jsonl` 追加 `{"type":"confirmation_response","request_id":…,"allowed":true|false}`；哪边先答算哪边，晚到的被丢弃并回一条 error，不会出错。卡片收到 `control_response` 才撤。
- **发送消息**：可用 `{"type":"submit","text":…}`（CLI 忙时自动排到下一轮，与第二期「由 CLI 排队」口径一致；轮询间隔 500ms）。是否把 Qwen 的发送从写 PTY 改成写命令文件，列为 §14 第 3 项待定。
- **能力探测**：按 `supported_events` 判断，不按版本号；旧版不认参数时 CLI 会报错退出，所以启动前用 `qwen --help` 探测一次是否有 `--json-file`（同 `codex_modern()` 的做法）。
- **本机核实**：PTY 内启动、未发消息，首行为
  `{"type":"system","subtype":"session_start",…,"data":{"protocol_version":2,"version":"0.25.2","supported_events":["system","user","assistant","stream_event","result","control_request","control_response"]}}`。
- **待核实**：发一句话后的完整事件序列（需要真实调用）；`--resume` 时是否重放历史。

### 8.2 OpenCode：TUI 内置服务（第一档）

- **启动**：`opencode --port <随机空闲端口>`，环境变量 `OPENCODE_SERVER_PASSWORD=<每标签随机值>`（二进制里有该变量，鉴权方式待核实）。
- **得到**：订阅 `/event`（SSE）。事件包括：
  - `message.part.delta` / `session.next.text.delta`：实时预览，补上 OpenCode 现在读屏读不出的 ✗。
  - `permission.asked` / `permission.replied`、`question.asked`：审批与提问。
  - `session.idle` / `session.status`：回合边界。
  - `todo.updated`：计划。
  - `session.created`：会话归属。
- **审批回复**：`POST /permission/{requestID}/reply`（另有 v2 `/api/session/{id}/permission/{requestID}/reply`，接入时只选一套并钉版本）。
- **发送**：`/tui/submit-prompt` 可替代往 PTY 粘贴（同 §14 第 3 项）。
- **历史**：仍可读 SQLite；第三期可改走 `/session/{id}/message`，绕开数据库结构随版本变化。
- **本机核实**：PTY 内启动后，`/session` 返回会话列表，`/doc` 返回 OpenAPI（含上述接口），`/event` 首条 `server.connected`。
- **风险**：本机端口对同机其他进程可见——必须带口令，且口令不得写进 Run 记录、日志或诊断包（safety.md 增补）。

### 8.3 Claude Code：逐次注入 hooks（第二档，收益最大的一家）

- **启动**：现有 `--settings` 覆盖 JSON（`agents.rs:861`，网关连接时已经在用）里并入 `hooks` 段；官方账号启动同样带一份只含 hooks 的 `--settings`。hook 命令把「标签号 + 时间 + payload」追加到 `<channels>/<tab>/hooks.jsonl`。
- **挂的事件**：

  | 事件 | 用途 |
  |---|---|
  | `SessionStart` | 会话归属与跟随（§6） |
  | `UserPromptSubmit` | 回合开始、乐观消息对齐 |
  | `PreToolUse` | 审批卡内容：`tool_input` 里的完整命令、`file_path` + `old_string` / `new_string`，卡片上能直接看差异 |
  | `Notification(permission_prompt)` | 进入等批准 |
  | `Stop` | 回合结束 |
  | `PreCompact` | 压缩提示 |

- **hook 一律不阻塞、不输出决定**（立即 exit 0），审批仍由 TUI 菜单决定，聊天层照旧按菜单原文给按钮、写按键。原因是 `PermissionRequest` / `PreToolUse` 若阻塞等 Mesa 回复，TUI 会被冻住，用户在终端里答不了，违背「终端是事实来源」。
- **效果**：Claude 不再需要用户去设置页开「精确注意力」才有精确事件，也不碰 `~/.claude/settings.json`。全局 hooks 开关保留，只用于 Mesa 外部的终端。
- **本机核实**：在仓库目录用 `claude --settings '{"hooks":{"SessionStart":…}}'` 拉起、不发消息，hook 收到
  `CCODE_TAB_ID=probe-tab-1` 与 `{"session_id":…,"transcript_path":…,"source":"startup","model":"glm-5.3-flash"}`。
- **待核实**：与用户全局 hooks 是否合并执行（两份都应触发）；Windows 下 PowerShell hook 的启动耗时（每次工具调用都会触发 PreToolUse，必要时 Windows 只挂 SessionStart / UserPromptSubmit / Stop 三个）。

### 8.4 Gemini / Kimi / Grok / CodeBuddy（第二档，逐家核实后接）

- 已有全局 hooks 桥接（matrix §12）。先做两件不需要核实的事：
  - hook 命令多记 `$CCODE_TAB_ID`（Windows `$env:CCODE_TAB_ID`），让日志能按标签归属。
  - 现有三事件之外补 `PreToolUse` 等价事件（Gemini `BeforeTool`、Kimi / CodeBuddy `PreToolUse`），给审批卡结构化内容。
- 逐次注入方式待核实：
  - CodeBuddy 与 Claude 同源，`--help` 未列 `--settings`，需实测。
  - Gemini 是否有类似系统设置路径的环境变量，需查 0.64 源码。
  - Kimi 是否有指定配置文件的参数，需查。
  - Grok 的 hooks 文件本来就整份归 Mesa，不涉及污染。
- Grok 的 `updates.jsonl` 本身就是 ACP 通知流：若核实为边生成边写入，Grok 的实时预览可以改读文件、不读屏。
- Grok 1.0.62 有 `grok agent leader`（「供其他客户端共享的主进程」）与 `grok agent serve`：若 TUI 能连到共享主进程，就是与 Codex 同类的多客户端旁路，与 §8.5 一起试验。

### 8.5 Codex：私有 app-server（第三档，先做试验）

- **设想**：
  - 每个标签拉一个 `codex app-server --listen unix://<channels>/<tab>/codex.sock`，带上 Mesa 现有的 `-c` 注入与环境变量。
  - TUI 用 `codex --remote unix://<同一 socket>` 连上去。
  - Mesa 作为第二个客户端连同一 socket，`thread/loaded/list` → `thread/resume` 加入同一线程，收 `item/*`、`turn/*`、审批请求与 `serverRequest/resolved`。
- **为什么有希望**：协议里有 `thread/unsubscribe`、`serverRequest/resolved`、`thread/loaded/list`，happy 的调研记录写到 Codex 测试覆盖了「加入正在运行的线程」「恢复时重放待审批」。
- **试验必须回答**：
  1. 两个客户端同时连接时，审批请求发给谁，另一端能否收到解决通知。
  2. 网关注入放在 app-server 进程上是否完全生效（provider、`experimental_bearer_token`）。
  3. 与 0.163 的共享后台服务、`--no-daemon` 是否冲突（`agents.rs:1776` 的注释）。
  4. Windows 上 `unix://` 是否可用。
  5. 进程回收：两个进程要一起停。
- **失败就不做**，Codex 保持「rollout 文件 + hooks + 读屏」。

### 8.6 Cursor

无旁路，维持现状。`cursor-agent acp` 只在 §11 的无头场景考虑。

---

## 9. 「等你决定」卡升级

界面形态沿用设计稿 §5：对话末尾一张卡，优先级不变。变的是内容与回复路径：

1. **内容结构化**：
   - 工具类型图标（按 kind）。
   - 完整命令（不截断，可展开）。
   - 文件路径 + 差异预览（Edit 的旧 / 新文本，复用 `tool-activity.ts` 的 DiffLine 渲染）。
   - MCP 工具名 + 参数。
   - 来源是读屏时，照旧显示菜单原文。
2. **选项**：旁路给了选项就用旁路的（ACP 四种 kind：允许一次 / 总是允许 / 拒绝一次 / 总是拒绝；Qwen 是 allowed 真假）；否则照旧用菜单原文。
3. **回复**：
   - 有官方回复通道（Qwen、OpenCode，Codex 试验通过后）的走通道。
   - 其余写按键进 TUI。
   - 卡片收到「已解决」事件才撤；N 秒未解决给「打开终端」。
4. **多个审批同时到达按顺序排队**，一次只显示一张（AionUi F-PERM-01）。
5. **等批准时按停止**：回复 cancelled / 写 Esc，再中断。
6. **不变的底线**：不替用户回答任何确认；不做「免确认模式自动选第一项」；完全访问仍是 CLI 自己的启动参数。

---

## 10. 实时预览

取数优先级：

1. 旁路增量：Qwen `stream_event`、OpenCode 文本增量、Codex `item/agentMessage/delta`。
2. 会话文件增量：Grok，待核实。
3. 读屏：`live-reply.ts`，Claude / Gemini / Kimi 仍走这条。

旁路接上的家，`live-reply.ts` 里对应的画面布局保留作退路，不删。

---

## 11. ACP 放在哪里

**不进交互聊天层。** ACP 是「编辑器 ↔ agent」协议：agent 以 ACP 子进程运行，就没有 TUI 画面。这与「聊天与终端是同一进程两层」「终端是事实来源」两条已拍板的决策直接冲突。

**现在就借的**：§4 的数据模型（kind / status / locations / diff / plan / stopReason / usage）。以后若真接 ACP，渲染层不用改。

**以后可选（需拍板，不在本方案三期内）**：把**无头 Runtime**（定时雷达、一次性调用）换成 ACP。

- 本机核实 7 家原生支持：gemini `--acp`、qwen `--acp`、opencode `acp`、kimi `acp`、codebuddy `--acp`、cursor-agent `acp`、grok `agent stdio`。
- 好处：用的是同一个二进制，Mesa 的环境变量注入照常；权限请求结构化，可在 Mesa 侧强制「只准写隔离树」。
- 代价：Claude 与 Codex 需要额外的适配包（npm `@agentclientprotocol/claude-agent-acp`、`codex-acp`），不是原生二进制，违背 `resolve_binary` 单一来源的口径。这两家应保持现有无头路径。

---

## 12. 明确不借的

| 做法 | 出处 | 不借的原因 |
|---|---|---|
| 切换界面就杀进程、换模式重开 | happy 本地 ⇄ 远程 | Mesa 两层共用一个 PTY，切层不重启 |
| 自带 launcher 拦截 CLI 的 fetch 判断「在思考」 | happy `claudeLocal.ts` | 侵入 CLI 运行时，CLI 升级即失效，绕过 `resolve_binary` |
| 交互对话改走无头 stream-json | vibe-kanban、opcode | 丢掉 TUI，违背双层决策 |
| 交互对话改走 ACP | AionUi | 同上（§11） |
| 免确认模式下自动选第一个选项 | AionUi F-PERM-03 | 违反「不替用户回答任何确认菜单」 |
| hook 阻塞等外部决定 | Claude `PermissionRequest` 的决定式用法 | 冻住 TUI，终端里答不了 |
| 默认把 hooks 写进用户全局配置 | — | 零污染；改为逐次注入 |
| 任何 AGPL 项目的实现 | opcode、claudecodeui、toad | 许可不兼容 |

---

## 13. 分期与验收

每期：一个主题一个提交，三条基线全绿（`npm test` / `cargo test` / `npm run build`）；新增夹具进测试；结束时用户在 Mesa Dev 窗口按清单点一遍。

### 第 0 期：地基（约 0.5 天）

- PTY 环境加 `CCODE_TAB_ID` / `CCODE_RUN_ID`。
- `<config>/ccode/chat-channels/` 目录管理：0600、标签关闭删除、启动时清孤儿（同 `prune_terminal_replays`）。
- **夹具库**（借 happy `__fixtures__` 的做法）：每家一组脱敏的真实会话片段，按情形命名——重复的助手回复、审批中被中断、`/clear` 换文件、压缩、子任务、超长工具输出行。之后所有归一化改动都对夹具跑金样测试。

### 第 1 期：身份、增量、会话跟随（约 2 天）

- DTO 加 id / callId / status / turnId / source（各家解析器逐个补，拿不到的留空）。
- 追加读取 + `chat-patch` 增量推送；前端按 id 做 key。
- Claude 逐次注入 SessionStart / UserPromptSubmit / Stop（§8.3）。
- **验收**：
  - [ ] Claude 里打 `/clear` 后，聊天层切到新对话，并显示「已开始新对话」。
  - [ ] 同一目录同时开两个 Claude 标签各说一句，两边对话不串。
  - [ ] 300 轮的长对话，生成中滚动不卡；新回复只追加，不整页闪动。
  - [ ] 用户 `~/.claude/settings.json` 前后逐字节不变。

### 第 2 期：回合状态机、审批卡、Qwen 旁路（约 3 天）

- `chat_turn.rs` 接管回合状态；前端改为只渲染。
- Claude `PreToolUse` 进审批卡；工具调用 status 生命周期；shell 命令再分类；计划块。
- Qwen Dual Output 全接：会话、增量、审批回复、回合结束。
- **验收**：
  - [ ] Claude 请求运行命令时，卡片上能看到完整命令；请求改文件时能看到差异。
  - [ ] Qwen 审批在聊天层点「允许」生效；先在终端里答，聊天层的卡片自动消失。
  - [ ] 九家各跑一轮「读文件 → 改文件 → 回答」，回答结束 2 秒内「正在回复」熄灭，中途不提前熄灭。
  - [ ] 等批准期间放置 3 分钟，不被判超时。

### 第 3 期：OpenCode 服务、Codex 试验、其余各家核实（约 3 天，Codex 视试验结果）

- OpenCode `--port` + 口令 + SSE + 审批回复；实时预览从 ✗ 变 ✓。
- Codex app-server 试验（§8.5 五问），通过才接。
- Gemini / Kimi / Grok / CodeBuddy 逐次注入与 Grok 文件实时性核实，结论进 matrix。
- **验收**：
  - [ ] OpenCode 生成中聊天层逐段出字。
  - [ ] OpenCode 审批在聊天层可答。
  - [ ] 诊断包、Run 记录、日志里搜不到 OpenCode 口令。

### 第 4 期（可选，需另行拍板）

无头 Runtime 改 ACP（§11）。

---

## 14. 需要你拍板的事

1. **方向**：保留 PTY + 逐家接旁路（本方案），而不是改走 ACP / 无头。（推荐）
2. **Claude 默认带逐次注入的 hooks**：Mesa 标签里的 Claude 默认有精确事件，不再要求用户去设置页开；全局开关保留给 Mesa 外的终端。（推荐）
3. **Qwen / OpenCode 的发送是否改走官方命令通道**（`input-file submit` / `/tui/submit-prompt`），而不是往 PTY 粘贴回车。
   - 好处：不再有「字躺在输入行没发出去」这一类问题。
   - 代价：Qwen 最多约 0.5 秒延迟；两家与其余七家发送路径不同。
   - 推荐：先只用于审批回复，发送仍走 PTY；第 2 期后看实测再定。
4. **OpenCode 以带口令的本机服务方式启动**（端口对同机进程可见，靠口令防护）。
5. **Codex app-server 试验**是否值得投入（约 1 天，可能得出「不可行」）。
6. **第 4 期 ACP 无头 Runtime** 是否立项。

---

## 15. 风险与待核实汇总

| 项 | 影响 | 核实方式 |
|---|---|---|
| Claude 逐次注入的 hooks 与用户全局 hooks 是否都执行 | 用户自己的 hooks 被吞 | 本机两份同事件 hook 各写一个文件 |
| Windows hook 用 PowerShell 的启动耗时 | 每次工具调用多一次进程启动 | Windows 实测；必要时少挂事件 |
| Qwen 发消息后的完整事件序列、`--resume` 是否重放 | 重复条目 | 真实调用一轮，按 id 去重兜底 |
| OpenCode 口令的鉴权方式、v1 / v2 两套接口 | 接口选错 | 读 1.19 源码 + 实测 |
| Codex 双客户端（§8.5 五问） | 整个 Codex 方案 | 试验 |
| 旁路文件增长 | 磁盘 | 每次启动新文件、关闭即删；单文件超限（如 50MB）停写回退 |
| CLI 升级改了旁路格式 | 解析失败 | 握手的 protocol_version 与 supported_events 探测；失败回退，绝不影响 TUI |

---

## 16. 落地时需同步的文档

- `docs/guide/user-guide.md` §8.1（审批卡能看到命令和差异、Claude 精确状态不用再开开关）
- `docs/conventions/terminal.md`（回合状态机取代收尾判定那几条；旁路目录规则）
- `docs/conventions/safety.md`（旁路文件 0600 与删除时机、OpenCode 口令、`CCODE_TAB_ID`）
- `docs/agent-integration-matrix.md`（新增「结构化旁路」一节，逐家写核实版本与证据）
- `docs/architecture.md` §10（拍板结果）
- `docs/code-structure.md`（`chat_turn.rs`、旁路模块）
- AGENTS.md「参考实现」：拍板后把 happy / vibe-kanban / ACP / qwen-code 补进长期参考列表

---

## 附：本机核实记录（2026-10-19，均未发送任何消息、未产生模型调用）

1. **Qwen 0.25.2**：`python3 pty.fork` 拉起 `qwen --json-file ev.jsonl --input-file in.jsonl`，12 秒后结束。`ev.jsonl` 首行即 §8.1 所列 `session_start`。
2. **OpenCode 1.19.3**：PTY 拉起 `opencode --port 47123`：
   - `GET /session` 返回会话数组；`GET /doc` 返回 OpenAPI 3.1；`GET /event` 首条 `server.connected`。
   - OpenAPI 中有 `/permission/{requestID}/reply`、`/tui/submit-prompt`、`/session/{id}/abort` 等接口与 94 个事件模式。
   - 二进制含 `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME`。
3. **Claude Code 2.1.292**：仓库目录内 PTY 拉起 `claude --settings '<只含 SessionStart hook 的 JSON>'`，环境带 `CCODE_TAB_ID=probe-tab-1`。hook 输出：`probe-tab-1 {"session_id":"…","transcript_path":"…/.jsonl","cwd":"…","hook_event_name":"SessionStart","source":"startup","model":"glm-5.3-flash"}`。
4. **各家 ACP / 旁路参数**（`--help`）：
   - gemini 0.64.0 `--acp`；qwen 0.25.2 `--acp`、`--json-fd`、`--json-file`、`--input-file`。
   - opencode 1.19.3 `acp`、`attach`、`serve`、`--port`；kimi 2.2.0 `acp`。
   - codebuddy 2.169.0 `--acp`、`--acp-transport`、`--serve`；grok 1.0.62 `--output-format streaming-json`（「one ACP session update per line」）。
   - codex 0.163.0 `app-server --listen unix://…`、TUI `--remote`。
   - cursor-agent 2026.10.16：顶层帮助未列，但 `cursor-agent acp --help` 存在（「Start the Cursor Agent as an ACP server」）。
   - grok 1.0.62：`grok agent stdio` 存在；同组还有 `serve`（WebSocket 服务）与 `leader`（「供其他客户端共享的主进程」），可能是与 Codex 同类的多客户端旁路，列入 §8.4 待查。
5. **Codex app-server 协议**：`codex app-server generate-json-schema` 离线生成，ClientRequest 105 个方法、ServerNotification 85 个、ServerRequest 10 个（含 `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`）。

---

## 实施记录（2026-10-20）

用户拍板：§14 全按推荐——方向取 PTY + 逐家旁路；Claude 默认带每次注入的 hooks；发送仍走 PTY、官方通道只用于审批回复；
OpenCode 带口令的本机服务；Codex 先试验（通过，已接入）；第 4 期 ACP 无头 Runtime 不立项。

### 「默认带上每次注入的 hooks 都可以做吗、设置页还要不要开关」的核实

逐家用 `scripts/e2e-model-routing/channel-probe.py` 在假网关前实跑一轮「跑命令」核实（用户自己的 hooks 照常触发 = 合并而非覆盖）：

| CLI | 不写用户配置、默认接上？ | 走法 | 依据 |
|---|---|---|---|
| Claude Code 2.1.292 | ✓ | `--settings` 并入 hooks | 七个事件全到，用户 hook 照常触发 |
| CodeBuddy 2.169.0 | ✓ | `--settings <JSON>`（帮助里没列，二进制里有） | 同上 |
| Qwen 0.25.2 | ✓ | Dual Output（hooks 走系统默认设置路径也通，没用） | 审批经 input 文件答通 |
| OpenCode 1.19.3 | ✓ | `--port` + `OPENCODE_SERVER_PASSWORD` | 无口令 401、带口令 200；审批经接口答通 |
| Codex 0.163.0 | ✓ | 私有 app-server（本机 WebSocket + 能力令牌）+ TUI `--remote` | `-c hooks` 每次都要在 /hooks 面板审核，不可用 |
| Gemini 0.64.0 | ✗ | 只能全局 | 系统设置 / 系统默认设置文件必须属 root（`isFileAndDirectorySecureSync`） |
| Kimi 2.2.0 | ✗ | 只能全局 | 没有指定配置文件的参数或环境变量 |
| Grok 1.0.62 | ✗ | 只能全局 | `GROK_CONFIG` 覆盖层按白名单收键，不收 hooks |
| Cursor | ✗ | — | 没有「等待确认」等价事件 |

结论：设置页开关不能全撤。五家不再给开关（卡上一行说明）；Gemini / Kimi / Grok 保留开关；以前给那五家开过的，启动时替用户收回
Mesa 写进全局配置的条目（只删含状态日志路径的条目，写前备份，`hooks::migrate_launch_injected`）。

### 端到端核实（Mesa 自己的实现，`chat_channel::e2e::e2e_channel`）

| CLI | 会话认出 | 回合 | 审批 | 实时文字 | 其它 |
|---|---|---|---|---|---|
| Claude Code | ✓ 直接给文件路径 | running → awaiting_approval → completed | 内容 ✓（命令原文），终端菜单答 | — | `/clear` 后报出新会话 ✓；接回 ✓ |
| CodeBuddy | ✓ | 同上 | 内容 ✓（REPL 代码），终端菜单答 | — | |
| Qwen | ✓（只给 id） | 同上 | 聊天层答 ✓ | ✓ | 接回 ✓ |
| OpenCode | ✓（只给 id） | running → completed | （默认放行；问的情形在 probe 里答通） | ✓ | |
| Codex | ✓ 直接给 rollout 路径 | 同上 | 聊天层答 ✓ | ✓ | 接回 ✓（见下） |

### 与方案的偏差

1. **Codex 恢复会话**：远程 TUI 恢复时拒收权限参数（「Permission overrides are not supported when resuming a remote task」）。
   恢复时把 `-s / -a / --approve-for-me / --dangerously-bypass-approvals-and-sandbox` 改成 app-server 的 `-c sandbox_mode / approval_policy /
   approvals_reviewer` 配置；新开会话仍由 TUI 带参数（两条都端到端验过）。新线程第一条消息前没有 rollout，`thread/resume` 会报错——
   等线程转为 active 时再订一次（resume 会重放挂着的审批）。
2. **Codex 传输**：方案写的是 unix socket；实际用本机 TCP WebSocket + 能力令牌（`--ws-auth capability-token`，app-server 参数里只有
   令牌的 SHA-256，令牌只经环境变量给 TUI），三平台同一条路；无令牌 / 错令牌都是 401（已核实）。
3. **增量推送（§7）**：没有另起 `chat-patch` 补丁协议。会话文件一条消息常跨多行（Claude 的同一回复分行写、Codex 条目先后到），
   按字节偏移只解析新增行会把正在写的消息切坏。改为：后端给每条消息 / 每个工具调用带来源 id（`ChatMessageDto.id`、`BlockDto.callId`），
   前端用 id 当身份（React key、分页去重、「发送时已有的回复」判定），工具调用与结果按 id 配对；读取仍是现有尾窗分页。
4. **回合状态机（§5）**：放在 Rust 的旁路快照里（`chat_channel.rs` Tracker），前端旁路有回合状态时以它为准，
   没有时照旧走 `applyTailAttention` 那一套（没删、没改）。
5. **§8.4 的「补 PreToolUse 等价事件」**（Gemini `BeforeTool` 等）没做：这三家只能写全局配置，开关打开时写的仍是原来三个事件；
   hook 命令都已带标签号，开着开关的家也接进聊天层旁路（状态、会话归属）。
6. Qwen 交互态不发 `result` 事件：「一次模型回复里没有工具调用」= 这一轮结束。

### 用户真实数据

启动迁移在本次开发中由 Mesa Dev 热重启**先于干跑**执行了一次：用户 `~/.codex/hooks.json` 里 Mesa 写的三条（PermissionRequest / Stop /
UserPromptSubmit）被收回成 `{}`，设置里 codex 开关置为关；写前备份在 `<配置目录>/ccode/backups/codex-hooks-settings-01792433585819246000.json`，
核对过备份里正是这三条、且只有这三条。之后补了干跑测试 `hooks::tests::real_data_dry_run_migrate`（`--ignored`）与同形状的单测。

### Windows 适配（2026-10-20，用户：「这些完善不要影响到 Mac 端」）

在 Windows 11 上把 `e2e_channel` 跑通五家（版本见 scripts/e2e-model-routing/README.md 文末），查出与改法（规则见 conventions/terminal.md
旁路条⑦–⑪、environment.md「.cmd shim」；决策见 architecture §10 同日条）：

| 问题（实测） | 后果 | 改法（只动 Windows） |
|---|---|---|
| claude.cmd / opencode.cmd 指向原生 exe、codebuddy.cmd 指向无扩展名 node 脚本，起进程回落 `cmd /c call` | 官方账号 Claude 的内联 `--settings` 里 `\|` 被 cmd 当管道，**Claude 起不来**；随启动带的首条消息多行截断、`%PATH%` 被展开 | shim 深化补两种（exe 直启 / node shebang）；官方账号的 hooks 写旁路目录 settings.json 传路径 |
| hook 起 PowerShell 每次 0.9–1.2 秒 | Claude 每个工具调用前后各卡约一秒，每轮结束再卡一秒 | Claude 的注入 hooks 带 `async: true`，另挂 PermissionRequest；Tracker 后台模式按身份对账 |
| 共用脚本折叠 `\s+` | 审批卡命令 / 差异丢缩进 | 只删回车换行 |
| 多个 hook 进程同时追加日志 | 12 并发丢 1 条；丢的是 Stop 时聊天层一直「在回复」 | 撞车重试约 1.5 秒 |
| Codex app-server 是独立后台进程 | Mesa 崩溃 / 强杀后成孤儿（占端口、占会话写锁）；收旁路时目录被它开着的日志锁住删不掉 | 挂进「句柄关即全杀」任务组；先杀后删 |
| Codex 恢复给的 rollout 路径带 `\\?\` | 与 Mesa 其余路径对不上 | 进快照前 strip_verbatim |
| 审批里是 `"…\pwsh.exe" -Command '…'` | 卡上露出外壳；「已工作」摘要不认 cmdlet，全算「运行」 | 前端认 PowerShell 外壳与常见 cmdlet |

未做：原生小程序代替 PowerShell 写日志（可保持同步、快一个数量级，要加 Windows 专属 sidecar）；CodeBuddy 是否认 `async`；Windows 上
读屏兜底（审批菜单 / 实时预览）在 ConPTY 下的抓屏核对；Mesa Dev 窗口逐家点验。

**同日二批补上（architecture §10「Windows / Mac 两端完善批」）**：原生小程序没加新 sidecar，用随包的 `mesa_helper` 的 `hook` 模式——启动注入的
Claude / CodeBuddy 用原路径（带引号）、同步跑，Stop hook 87–109ms；写全局配置的 Gemini / Kimi / Grok 用拷到 hooks-state 的 `ccode-hook.exe`、
路径不加引号（PowerShell / cmd / bash 三种宿主都认）。CodeBuddy 的 async 不再需要核实（不走后台了）。读屏兜底在 ConPTY 下核对了 Claude / Gemini /
Kimi / Grok 四家（`chat-capture.py` Windows 分支 + `capture-check.ts`），补了 Windows 字形（Claude `●`、Grok `>` `♦` `○` `•`）。
剩下：Mesa Dev 窗口逐家点验（docs/qa/acceptance-2026-10.md）。

### 补记（2026-10-22）：程序状态 OSC 7501 补上 Grok

借 Orca 的做法：CLI 自己把状态写进终端流（`OSC 7501`），终端答一次探询就开始报，不写任何配置。§0 表里 Grok 原先只能靠全局 hooks，
现在没开全局开关时走这条（旁路 kind `program-status`）；Claude Code 的 hooks 起不来时也退到它。回合、等批准、完成都有，没有会话 id、
没有工具参数（卡片只有 CLI 那一句，按钮仍从屏上菜单来）。额外得到一句「现状」（Grok 的 `Connection failed | Retrying (1/15)`），
聊天层生成中那一行在没别的可说时显示它。假网关端到端：`E2E_AGENT=grok`，回合 running → awaiting_approval → running → completed。
实时预览另加匀速显示（借 Paseo，`src/text-reveal.ts`，见 terminal.md 同名条）。

