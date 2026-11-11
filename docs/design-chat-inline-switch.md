# 聊天层：会话内换权限 / 思考档，斜杠命令不被吞（设计稿，2026-11-11）

> 状态（2026-11-11）：用户拍板「按照设计稿执行」。第一件实测结论在 matrix「会话内换权限 / 思考档」节；2.C、2.B、2.A、2.D 均已落地。以第 4 节实测结论为准，前面各节是实测前的方案。

起因：用户在 HER 综述「综述大纲」步骤用 Kimi Code 2.5.3 实测——
① 终端里 `/permission` 能切到 Never Ask，聊天层 AI 回复期间权限菜单点不了；
② 聊天层发 `/permission` 并选了一项，聊天里什么都没留下，像被吞了。

本稿分两件：**第一件实测**（结论写进 matrix），**第二件按结论改**（只对「会话内能换、且不写全局配置」的家）。
第二件的每一处都以第一件的结论为前提；结论不支持的家维持现状（重开接回），菜单里写明原因。

---

## 0. 现状（已读代码确认）

| 位置 | 现在怎么做 | 问题 |
|---|---|---|
| `ChatPermissionBadge.tsx` | 开聊后换档 = 确认「会重开」→ `live.onRestart()`；`interactive = !live.busy` | 生成中不能点；能会话内换的家也要重开 |
| 同上 `selectedOnly` | 除 Claude Code 外标签前缀「已选 ·」 | 读不到 CLI 实际档位 |
| `sessions.rs session_permission_mode` | 只认 `claude-code`，读 `permission-mode` 行 | Kimi 的 `permission.set_mode` 没读 |
| `TerminalView.tsx` 约 4850 行 | 权限跟随只在 `agentId === "claude-code"` 时查；首读为基线、变了才上报 | — |
| `TerminalPage.tsx` 约 760 行 | `claudeModeTier(sw.mode)` 映射后改标签的 `permissionMode` | 映射表只有 Claude；Kimi 的 `auto` 含义正相反（= Mesa 完全访问） |
| `chat-handoff.ts slashSettledLocally` | 斜杠命令发出 ≥1.5 秒且终端静 ≥1 秒才收成「命令 + 结果」 | AI 一直输出时永远不静；这一轮收尾时 `pendingUsersRef` 被清，命令直接丢 |
| `switch-strategy.ts inSessionSwitchCommand` | 只有 Codex ≥0.164 | Kimi 2.5 的 `/effort` 是否还写 config.toml 未复核 |
| `tui-menu.ts answerMenu / menuReadyToConfirm` | 挪高亮 → 再读屏核对 → 才回车 | 可直接复用，是「选错档」事故后的防线 |
| `chat-capture.py` | 三幕：慢回复 / 工具审批 / 一轮结束后发切换命令并比对配置 | **没有「生成中发命令」**，也没有读会话文件事件 |

---

## 1. 第一件：实测协议

### 1.1 脚手架补两处（脚本改动，不进应用）

`scripts/e2e-model-routing/chat-capture.py` 加一个可选的第四幕 **mid**（环境变量 `MID_CMD="/permission"`，可带 `MID_PICK="Never Ask"`）：

1. 发 `TRIGGER_SLOW`，等屏上出现第一行流式正文；
2. 生成中写入 `MID_CMD`（Kimi 走 CSI-u 回车，同 Mesa），逐帧录屏 3 秒：
   - 被拒（屏上拒绝文案）/ 进了排队 / 弹出选择器，三者择一记录；
3. 弹出选择器且给了 `MID_PICK`：按 Mesa 同法挪高亮、读屏核对、回车，录结果行；
4. 这一轮结束后发 `TRIGGER_TOOL`，看审批行为是否已经是新档（判「这一轮立刻生效」还是「下一轮生效」，见 1.3）；
5. 比对：
   - 临时 HOME 下**整棵配置目录**（不只现有 COPY 清单）切换前后的文件哈希，列出变动文件与变动键——防止写进没想到的状态文件；
   - 会话文件切换后新增的行，原样存进输出 JSON（`session_events_after`）。

假网关加一个触发词 `TRIGGER_SLOW_TOOL`：先慢慢流 6 行正文，再回一个跑命令的工具调用。用它判「生成中换的档，对**同一轮**后面的工具调用是否已生效」。

思考档同法：`MID_CMD="/effort high"`，看假网关日志里**下一次请求**的 effort 字段（`E2E_EFFORT` 那套已有的 params 记录）。

### 1.2 每家要答的四问

| # | 问题 | 怎么判 |
|---|---|---|
| 1 | 会话里能不能换权限档：命令或按键、有哪几档、与 Mesa 四档怎么对 | 先在二进制里查命令表与档位文案（同 Kimi 那次 `strings` 法），再实跑一轮一轮结束后的切换；**不凭印象写命令名** |
| 2 | 生成中能不能换：立刻 / 下一轮 / 被拒 | 第四幕 + `TRIGGER_SLOW_TOOL` |
| 3 | 换了是否写回全局配置 | 整棵配置目录哈希比对 |
| 4 | 思考档命令的同样三问 | `MID_CMD="/effort …"`（或该家的命令）+ 假网关日志 |

附带记：会话文件里有没有换档事件、事件长什么样（字段、带不带时间戳）、启动参数定下的档会不会在会话开头写一条。

### 1.3 「立刻 / 下一轮」的判定

- 立刻：生成中切到「完全访问」后，同一轮里 `TRIGGER_SLOW_TOOL` 的工具调用不再弹审批；
- 下一轮：同一轮仍弹、下一轮不弹；
- 被拒：屏上出现拒绝文案，或命令回显后无任何变化且会话文件无事件；
- 排队：命令在这一轮结束后才执行（结果行出现在收尾之后）。排队按「下一轮」处理，但要单独记，因为聊天层的「命令 + 结果」记录时机不同。

### 1.4 覆盖范围与写法

- 一等三家（Claude Code 2.1.311、Codex、Kimi 2.5.3）必须做全；其余六家（Qwen 0.26.7、Gemini 0.68.0、Grok 1.0.77、OpenCode、CodeBuddy 2.182.0、Cursor CLI）能测就测，
  测不了在表里写「未实证」并写原因（没有该命令 / 起不来 / 需要真账号）。
- Kimi 2.5.3 的 `/effort` 是否还写 `config.toml` 的 thinking，重新证；`/permission` 不写全局配置，用临时 HOME 再证一遍。
- 结论写进 `docs/agent-integration-matrix.md` 新增一节「会话内换权限 / 思考档（2026-11 实测）」，一张总表：

  | 家 · 版本 | 换权限的命令 / 按键 | 档位 ↔ Mesa | 生成中 | 写全局 | 会话文件事件 | 思考档命令 | 生成中 | 写全局 |
  |---|---|---|---|---|---|---|---|---|

  原 §6「中途切换会写回全局配置」那段与 Kimi 行「2.5 待转正后看」按新结论改，旧版本结论保留并注明版本。
- 这一步只改文档 + 脚本，单独一个提交（不跑基线）。

---

## 2. 第二件：改法（按结论启用，逐家开）

总原则：**哪一家走哪条路由一张按版本门控的表决定**（`switch-strategy.ts`），界面不硬编码家名。表里没登记的家、读不到版本的，一律维持重开接回。

### 2.C 斜杠命令不被吞（先做，不依赖实测结论以外的东西）

改 `chat-handoff.ts` + `TerminalView.tsx` 收尾路径。

**收尾条件**：对不把斜杠命令写进会话文件的家（即 `RECORDS_SLASH_COMMANDS` 以外），一条待落盘的斜杠命令在下列**任一**发生时收成「命令 + 结果」，不再要求终端静下来：

1. **选择器答完**：`runTuiCommand` / 聊天发出的斜杠命令弹出的菜单，经 `answerMenu` 答完（`onDone` 已调）。
   菜单与命令配对：发出斜杠命令时记 `slashMenuOwnerRef = { sent, at }`，窗口内认出的菜单归它；答完后等一次扫屏（≤800ms）抓结果行再收。
   结果写成：命令 + 「选了：<选项原文>」+ 结果行（若有）。
2. **终端出现结果行**：按家按命令登记结果行特征（实测得来，如 Kimi `/permission` → `^Permission mode (?:changed|unchanged)`）。
   只在命令回显之后的屏上找，只取匹配的那一两行，**不取流式正文**——生成中屏上后面全是 AI 的字，原来的「回显之后 80 行」会把正文抄进记录。
3. **会话文件出现对应事件**：如 Kimi `/permission` ↔ `permission.set_mode`（时间在发出之后；无时间戳就以「发出后首次读到的新事件」为准）。
4. **兜底**：现有的静 1 秒规则保留，覆盖没登记特征的命令（Codex `/status` 这类）。

**这一轮收尾时不丢**：`pendingUsersRef` 被清（回合确定结束）那一处，把仍未收尾、未落盘的斜杠命令全部收成记录；
拿不到结果的写「命令已发给 <家>，结果以终端为准」，不留空。

**数据形状**：`localCommandRecord(sent, screen)` 增加一个只收显式输出行的变体（或加参数），2/3 两条路只传匹配到的行。

纯逻辑放 `chat-handoff.ts`（新函数如 `slashResultLines(agentId, command, lines)`、`slashSettledBy(...)`），配 `tests/chat-handoff.test.ts` 用屏幕样本（来自第一件录屏）测；
登记表与其余家的读屏特征同处，不另起文件。限制照旧：这类记录只在这次打开的聊天里有，重开后看不到（文件头已写）。

### 2.B 徽标显示真实档位

- **后端**：`session_permission_mode` 从「只认 Claude」改成按家分发：
  - `claude-code`：不变；
  - `kimi`：读 `wire.jsonl` 尾部最后一条 `permission.set_mode` 的 `mode`；
  - 其余家：第一件查到有事件的再接，没有返回 None。
  只读、只取尾部，与现有同口径。Rust 测试仿 `claude_permission_mode_reads_latest_switch` 加 Kimi 用例（样本来自实测会话文件，去敏）。
- **前端映射按家分表**：`claudeModeTier` 推广为 `sessionModeTier(agentId, mode)`（`chat-handoff.ts`）：
  - Claude：同现表；
  - Kimi：`manual` → 请求批准（Always Ask），`yolo` → 帮我批准（Ask When Needed），`auto` → 完全访问（Never Ask）。
    **Kimi 的 `auto` ≠ Mesa 的「帮我批准」**，这是最容易写反的一处，测试要专门钉住；
  - 对不上的（plan 等）返回 null、不动徽标，同现在。
- **跟随范围**：`TerminalView` 里 `ctx.agentId === "claude-code"` 改成「这家这个版本读得到会话档位」（表驱动）。
  基线规则：会话文件里在**本次启动之前**的事件不覆盖本次启动参数（接回旧会话时，旧事件代表的是上次的档）；
  若实测发现 Kimi 启动时会把启动档写成一条事件，则直接以最后一条为准，基线规则可去掉——按实测定。
- **「已选 ·」**：`selectedOnly` 改为「这家读不到会话档位」；读得到的家不加前缀，悬停说明也去掉「以终端为准」那句。
  终端里手改（`/permission`、⇧Tab）同样落成事件，徽标随之更新，无需另做。

### 2.A 换权限不重开、生成中也能换

**表**：`switch-strategy.ts` 新增

```ts
inSessionPermissionSwitch(agentId, version) → {
  command: string;            // 如 "/permission"（若实测带参数可直切，优先带参数、不弹菜单）
  optionLabels: Partial<Record<"ask" | "auto" | "full", string>>; // 屏上选项原文，如 Kimi { ask: "Always Ask", auto: "Ask When Needed", full: "Never Ask" }
  midTurn: "now" | "next" | "refused";
} | null
```

- 只登记第一件里「会话内能换 + 不写全局配置」的家；「先出方案」档不走这条（计划模式各家入口不同），仍重开。
- `midTurn: "refused"` 的家（如 Codex 若实测仍拒收斜杠命令）：生成中徽标仍不可点，悬停写「<家> 生成中不收命令，这一轮结束再换」。

**徽标**：`ChatPermissionBadge` 的 `live` 增加 `inline: { midTurn } | null` 与 `onInline(tier)`：

- `interactive = (inline && inline.midTurn !== "refused") || !live.busy`；
- 走会话内换的档：不再弹「会重开」确认；**完全访问照旧二次确认**（`confirmPermissionChoice` 去掉 restartNote 即可）；
- 菜单底部一句：会话内能换的家写「只管这一段对话，不改 <家> 的设置。」，`midTurn: "next"` 时生成中补「这一轮结束后生效」；
  走重开的家写原因，如「<家> 在会话里换权限会改它的全局设置，所以要重开接回」——一句话，不出现内部词。

**执行**（`TerminalView` 新动作 `switchPermissionInSession(tier)`）：

1. `runTuiCommand(command)`，同时登记「期待的菜单」：`{ labels: 全部 optionLabels, target: optionLabels[tier] }`；
2. 扫屏认出菜单后，**先核对再按**：
   - 菜单选项必须包含这家登记的全部档位原文（防止把生成中弹出的工具审批菜单当成权限选择器答掉）；
   - 目标原文在选项里**恰好命中一项**（规范化空白后全等，不做包含匹配——「Ask When Needed」与「Always Ask」都含 Ask）；
   - 两条都满足才调 `answerMenu(index)`（内部已有挪高亮 → 再读屏 → `menuReadyToConfirm` → 回车）；
   - 任一不满足：不按任何键，菜单照常以卡片形式交给人点，卡片上方加一句「没认准要选哪一项，请你点」。
3. 确认生效：以 2.B 的会话档位事件或 2.C 的结果行为准，**不乐观改徽标**；徽标在等待期显示「正在换成 X…」，
   8 秒内没有确认就恢复原档并提示「没换成，以终端为准」。
4. 这一步发出的 `/permission` 同样按 2.C 收成「命令 + 结果」记录，聊天里能看见换过。

这一条依赖 2.B（确认生效）与 2.C（记录），所以排在它们之后。

### 2.D 思考档

- 第一件查出会话内能切、又不写全局配置的家（含生成中下一轮生效的），加进 `inSessionSwitchCommand`，带版本门槛，与 Codex 0.164 同法（常量 `<家>_SESSION_SWITCH_MIN`）。
- `midTurn` 同样登记：生成中能收的家放开 `effortWaitsForTurn` / `modelWaitsForTurn` 对它的限制，芯片说明写「下一轮生效」；拒收的维持等这一轮结束。
- 写全局的家维持重开，`SWITCH_PERSISTS` 与文件头注释按新版本号更新（保留旧版本结论）。
- 模型切换同理，但只在实测明确时一起开；Kimi 用 Mesa 接口连接时 `/model` 只认配置别名（matrix 已记），这条限制若仍在，模型切换不开。

---

## 3. 提交拆分与验证

| 序 | 主题 | 改动面 | 基线 | 同步文档 |
|---|---|---|---|---|
| 1 | 实测结论 | `chat-capture.py`、`gateway.py`、matrix | 不跑 | matrix；README（脚本用法） |
| 2 | 斜杠命令不被吞（2.C） | 前端 | `npm test` + `npm run build` | CHANGELOG 未发布段；terminal.md 本机斜杠命令条 |
| 3 | 徽标显示真实档位（2.B） | Rust + 前端 | 三样全跑 | 说明书聊天层权限一节；CHANGELOG；terminal.md |
| 4 | 会话内换权限（2.A） | 前端 | `npm test` + `npm run build` | 说明书；CHANGELOG；terminal.md；architecture §10（属用户拍板的规则：会话内能换且不写全局的家不重开） |
| 5 | 会话内切思考档（2.D） | 前端 | `npm test` + `npm run build` | CHANGELOG；terminal.md 中途切换条；matrix 已在 1 写 |

无新源文件则不动 code-structure；若 2.C 的读屏特征表大到要拆文件，再补一行。

测试：`tests/switch-strategy.test.ts`（新表与版本门槛）、`tests/chat-handoff.test.ts`（结果行、按家映射、收尾不丢）、
`tests/tui-menu.test.ts`（用实测录到的 Kimi 选择器屏：期待菜单核对通过 / 工具审批菜单不被误答 / 目标原文歧义时不按）、Rust `sessions/tests.rs`（Kimi 档位事件）。

界面手感交给用户在 Mesa Dev（17575）验，收尾附核对清单：Kimi 生成中切三档各一次、完全访问弹二次确认、
聊天发 `/permission` 选一项后看「命令 + 结果」记录、终端里手改后徽标跟上、某个维持重开的家菜单底部写明原因。

---

## 4. 实测结论对方案的影响（2026-11-11，全表见 matrix「会话内换权限 / 思考档」节）

**2.A 会话内换权限，按家定：**

| 家 | 走法 | 生成中 | 备注 |
|---|---|---|---|
| Kimi 2.5.3 | `/permission` 选择器，按原文选 Always Ask / Ask When Needed / Never Ask | 这一轮生效 | 每项下面有一行说明，格数按原文算 |
| Codex ≥0.166（版本门槛以实测为准） | `/permissions` 选择器，按原文选；完全访问还要答「Enable full access? › Yes, continue anyway」 | 下一轮生效 | 第二层确认由 Mesa 的二次确认替代，人点过才替他按 |
| Qwen 0.26.7 | `/approval-mode <default\|auto\|yolo>` 带参数直切，不弹菜单 | 排队，这一轮结束后执行 | 最稳的一家：没有选择器竞态 |
| Claude / Gemini / Grok / CodeBuddy | 只有 ⇧Tab 轮换或开关命令 | — | 维持重开接回。轮换要从当前档推格数：CodeBuddy 第二档就是 bypass，Grok / Gemini 的开关对已在的档会切回去；Claude 轮换会途经 plan |
| OpenCode / Cursor | 无会话内权限档 / 未实证 | — | 维持重开接回 |

- **竞态是硬约束**：实跑里权限选择器开着时工具审批菜单顶上来，按错一格的回车批准了工具调用。2.A 的「核对原文 → 挪 → 再读屏 → 才回车，对不上就 Esc」不是可选项。
- 原「4.1 生成中能否收命令」已有答案：Kimi、Codex 收；Qwen 排队。

**2.B 徽标：**
- Kimi：读 `wire.jsonl` 最后一条 `permission.set_mode`，**不需要「本次启动之前的不算」这条基线规则**——不带参数接回旧会话时 Kimi 沿用会话里存的档、不再写一条，最后一条就是真实档位。
- Codex：会话文件 `thread_settings_applied.thread_settings.approval_policy`（与 sandbox）可读，可一起接上。
- **现有问题**：Mesa 用「请求批准」（Kimi 不带权限参数）接回一段切过 Never Ask 的 Kimi 对话，实际仍是 Never Ask，徽标却写请求批准。2.B 接上后徽标会如实显示；是否在接回后替人发一次 `/permission` 改回所选档，单独拍板。

**2.D 思考档：**
- Kimi 2.5.3：`/effort` 不带参数 → ←→ 挪到目标 → **Alt+S**（只改本段，下一轮生效）。Alt+S 要写 kitty 的 CSI-u `\x1b[115;3u`，与回车同法（`submit_csi_u`）；带参数或回车会写 config.toml，禁用。
- Codex ≥0.166：`/model --reasoning` 生成中也收，`effortWaitsForTurn` 对它放开（terminal.md「Codex 生成中不收斜杠命令」一条随 2.D 提交改正）。
- Claude 2.1.311 `/effort`、Qwen 0.26.7 `/effort` 仍写全局，维持重开。Grok、OpenCode 的思考档未实证，维持现状。

**2.C 结果行特征**（只在命令回显之后找）：Kimi `^Permission mode(?: unchanged)?: ` 与 `^Thinking set to `；Codex `^• Model changed to `；其余家先只靠「选择器答完」与兜底。

## 5. 不做

- 不替人敲任何会写回 CLI 全局配置的命令（含为了「更快」）。
- 不在读屏没认准时猜着按键；没认准一律交卡片。
- 「先出方案」档不做会话内切换。
- 不为维护级六家补专门的读屏特征，除非实测顺手确认；它们照旧重开接回，菜单写明原因。
