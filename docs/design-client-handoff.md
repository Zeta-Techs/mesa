# 客户端接力（Client Handoff）整体设计

> 状态：**P1 + P2 已实现**（2026-10-18，用户「按推荐做」）；真机点验清单见文末 §11。决策已沉淀进 architecture §10 当日条目，调研事实见 matrix §13。**与本稿原方案的差异**：①后端文件名 `client_open.rs`（避免与既有 `handoff.rs` 跨 Agent 接力混淆）；②命令是 `client_open_list / client_open_plan / client_open_launch`，launch 无 plan_token，每次现算；③P2 的「VS Code 扩展作第二客户端」**没做**（见 §7）。
> 事实来源：本机 ChatGPT.app 26.1013 / Claude.app 2.42304 的 app.asar 源码、本机 `~/.codex/state_5.sqlite`、七家 CLI 的官方文档与源码调研（标注 V=已核实 / I=推断）。

## 0. 结论

1. **九家不可能全部「无缝打开对话」。** 只有 Codex、Claude 两家能精确定位到某一条对话；Kimi、OpenCode 只能打开项目；其余四家没有可用的客户端。强行给九家画同一个按钮，只会多出九种报错。
2. **「有时候出错」的根因是预检缺失。** 客户端那边的报错（Model provider not found、请先登录、对话找不到）都由客户端自己弹，Mesa 发出深链之后一无所知。`openUrl` 只要系统里有处理程序就算成功。所以所有判断必须在发深链**之前**做。
3. **「配置绕」的根因是修复动作放错了地方。** 现在要去连接页「注册到客户端」，再回对话页等按钮解禁。应改为点「在客户端打开」时，Mesa 当场预检、当场给出一键修复、修完直接打开。
4. **环境变量注入对 GUI 客户端无效。** Mesa 默认用环境变量零污染注入渠道，所有 GUI 客户端都是不带这些变量启动的。能带过去的只有写进磁盘的配置（Codex 的 provider 定义块、「设为全局默认」）。所以「继续时用哪个渠道」必须在打开前讲清楚，这是设计的第二条主线。

## 1. 九家能力分档

| 档 | 含义 | agent | 客户端与入口 | 共享会话存储 |
|---|---|---|---|---|
| A 对话级 | 精确打开某条会话 | codex | ChatGPT.app 内嵌 Codex：`codex://threads/<id>`（V，源码核实仍有效） | 是（`state_5.sqlite`） |
| A 对话级 | 同上 | claude | Claude 桌面版：`claude://resume?session=<uuid>` 把 CLI 会话**导入**桌面版 Code 标签（V，源码）；另有 VS Code 扩展 `vscode://anthropic.claude-code/open?session=<id>`（V） | 是（`~/.claude/projects`） |
| B 项目级 | 只能以目录开新会话，旧对话要在客户端里自己点 | codex | `codex://threads/new?path=<绝对路径>`（V） | 是 |
| B 项目级 | 同上 | claude | `claude://code/new?folder=<路径>&q=<提示>`（V） | 是 |
| B 项目级 | 同上 | kimi | Kimi Code 桌面版 ≥1.1.0：`kimi-code://open?root=<路径>&new=1`（V，`kimi app` 即用它）。`session` 参数**不存在**（V） | 是（`~/.kimi-code/sessions`） |
| B 项目级 | 同上 | opencode | 桌面版（Electron，beta）：`opencode://open-project?directory=` / `opencode://new-session?directory=&prompt=`（V，v1.19.3 源码；**本机未装，版本待实测**） | 是（I：桌面版内置 CLI 服务共用 `opencode.db`） |
| C 需起服务 | 共享存储，但入口是本机 Web 服务，要管进程与令牌 | qwen | `qwen serve --open`，`/session/<id>?workspace=`（V，实验性，cwd 不匹配报 400） | 是 |
| C 需起服务 | 同上 | codebuddy | `codebuddy --serve --open`（V） | 是 |
| D 无客户端 | 没有可接力的 GUI | gemini | 无会话级客户端；Antigravity 是另一套存储，不读 Gemini CLI 会话（V） | 不适用 |
| D 无客户端 | 同上 | cursor | Cursor IDE 未见读 CLI 会话（I：存储分离）；CLI 只认 Cursor 自家账号，不能用第三方网关（V） | 否 |
| D 无客户端 | 同上 | grok | 无（V）。本机 Grok Bot.app 是 Cursor/SpaceXAI 的云电脑产品，**不是** Grok Build 的客户端 | 不适用 |

分档的判据（以后新增 CLI 照此归档）：①客户端是否读同一份会话存储；②能否用 URL / 命令定位到会话或目录；③渠道（API 配置）能否带过去。三条缺一，降一档。

## 2. 设计原则

1. **先预检再发链接，发出去之后不再负责。** 客户端侧的失败 Mesa 看不见，所以只能在发前尽量排除，并在界面上如实写「打开后如果客户端提示登录，先在客户端登录再点一次」。
2. **按钮文案如实反映能打开到哪一层。** A 档写「在 Codex 打开这条对话」；B 档写「在 Kimi 桌面版打开项目」并附一行小字「只打开项目，不会定位到这条对话」。不许 B 档冒充 A 档。
3. **修复就地完成，且可撤销、说清代价。** 要写磁盘配置的修复（Codex 注册 provider）在同一个浮层里确认，写明改哪个文件、含不含密钥、怎么撤销；沿用现有备份/原子写/事务回滚。
4. **没有客户端的 agent 不显示按钮。** D 档不放灰按钮（灰按钮只会引出「为什么点不了」）。原因写在对话页「⋯」菜单的一行说明里即可。

## 3. 统一模型

**数据（`agent_specs.rs`，一个 CLI 一张声明式规格，加 `clients: &[ClientSpec]`）**

```
ClientSpec {
  id            // "codex-desktop" | "claude-desktop" | "claude-vscode" | "kimi-desktop" | "opencode-desktop"
  display       // 「Codex 客户端」「Claude 桌面版」…
  detect        // 各平台：应用路径候选 + URL scheme 是否已注册 + 最低版本
  session_url   // Option<模板>：有 = A 档
  project_url   // Option<模板>：B 档
  channel       // 渠道如何到达客户端：RegisteredProvider(codex) | OwnAccount(claude) | GlobalConfig(kimi/opencode)
}
```

**三个后端命令（新文件 `client_open.rs`，取代前端 `codex-client.ts` 里的深链拼接；`codex-client.ts` 已删）**

- `client_open_list()`：全部客户端及本机安装情况（30 秒缓存）。
- `client_open_plan(client_id, target)`：target = 会话（session_id）或项目（绝对路径）。只读、几十毫秒，返回
  `{ level: session | project, url, verdict: ready | needs_fix | blocked, checks: [{id, status: ok|note|warn|fix|block, text, fix?}] }`。
- `client_open_launch(client_id, target, fix?)`：**重新预检**（不信任前端回传的计划）→ 被拦或还欠修复就拒绝 → 执行用户选定的修复（只能选预检给出的候选连接）→ 在 Rust 侧发起系统打开 → 写一条不含路径与密钥的日志事件（来源 `client-open`，进「诊断与日志」）。

前端只留一个钩子 `useClientOpen`（`ClientOpenDialog.tsx`），复用于对话页底部条与右键菜单（会话级）、工作台主卡与最近项目行悬停（项目级）；项目级装了多家客户端时先弹一层问用哪个。项目页头部入口本期未加。

## 4. 预检清单（各客户端）

| 检查 | 条件不满足时 | codex | claude 桌面版 | kimi | opencode |
|---|---|---|---|---|---|
| 客户端已装、scheme 已注册、版本够新 | block + 下载入口 | ✓ | ✓ | ✓（≥1.1.0） | ✓（版本待测） |
| 目录存在 | block | ✓ | ✓ | ✓ | ✓ |
| 对话在客户端侧可找到 | block / warn | threads 表只读查询，缺失 warn | transcript 文件存在，缺失 block（对应桌面版 `transcript_missing`） | — | — |
| 渠道客户端认得 | fix / note | **provider 定义块不在 config.toml → fix「写入并打开」**；残留 `http_headers` → fix「迁移」 | **note：桌面版用自己的账号继续，不是这条对话原来的网关**；首次需用户勾选知悉 | note：只认写盘的全局配置 | 同左 |
| 对话正在 Mesa 终端里活跃 | warn：两边同时写同一份记录 | ✓ | ✓ | ✓ | ✓ |
| 登录态 / 工作区信任 | note（不可读，不拦） | — | 登录过期、工作区未信任由桌面版自己弹 | — | — |

要点：只有**确定能判断**的才 block/fix，不确定的一律 note，不假装能预知。

## 5. 失败分类与话术（界面统一用这一张表）

| 类别 | 怎么发现 | 用户看到什么 |
|---|---|---|
| 没装 / 协议没注册 | detect | 「没找到 Claude 桌面版」+ 下载链接 |
| 版本太旧 | 读 Info.plist / 注册表版本 | 「Kimi 桌面版需要 1.1.0 以上」 |
| 对话在客户端找不到 | 查 threads 表 / transcript 文件 | 「这条对话文件已不在，无法在客户端打开」 |
| 渠道客户端不认识 | config.toml 无定义块 | 浮层「Codex 客户端不认识『xxx』这条连接。写入后可继续（含密钥，可在连接页撤销）」[写入并打开] [在 Mesa 里继续] |
| 渠道会变 | claude 恒有 | 「客户端会用它自己的账号继续，不会走『xxx』网关」 |
| 双写冲突 | liveSessions | 「这条对话还在 Mesa 终端里运行，两边同时写会错乱。先结束它？」 |
| 客户端侧失败（登录/网络） | **不可发现** | 浮层底部固定一行：「打开后若客户端提示登录或网络问题，在客户端处理后再点一次」 |

## 6. 各家具体做法

**Codex（A 档，先做，修现有痛点）**
- 现有 `codex_register_client_provider` 等后端函数原样复用，只是触发点从连接页搬进预检浮层；连接页保留「已注册渠道」管理与「移除注册」，不再是必经之路。
- 查 `state_5.sqlite` 的 `threads` 表（只读）确认对话在客户端注册表里。本机现状：1811 条 thread，其中 1395 条活跃对话的原文已被压成 `.zst`，所以**不能用「rollout 文件在不在」判断**，必须查表。
- 可选后续（**未实测**）：本机 Codex 0.163 的 provider 支持 `command` 取令牌（字段 `command / timeout_ms / refresh_interval_ms / cwd`）。若 ChatGPT 内嵌客户端认它，可让密钥不再明文落 `config.toml`。需单独起一个验证小任务，不进首批。

**Claude（A 档）**
- 会话：`claude://resume?session=<uuid>`；项目：`claude://code/new?folder=<abs>`。
- 桌面版导入失败只会在它自己界面弹 toast（类别：auth_expired / network / transcript_missing / other），所以 Mesa 只能预检 transcript 存在与否。
- 导入后桌面版是「接管」还是「另起一份」会决定双写是否有风险，**实施前必须实测**（见 §8）。

**Kimi / OpenCode（B 档）**
- 只做项目级。按钮文案带「项目」二字和小字提示。共享存储，所以在客户端里续写的对话回到 Mesa 会自然出现。
- Kimi：CLI 与桌面版没有跨进程锁，不要同时跑同一会话（文档原话，V）→ 同样复用「双写冲突」预检。

## 7. 分期

| 期 | 内容 | 价值 |
|---|---|---|
| P1 | `ClientSpec` + `client_open.rs` + `useClientOpen` 钩子与确认层；Codex 迁入（含预检浮层、就地注册）；删掉对话页「灰按钮 + 去连接页」的绕路；诊断日志事件 | 直接解决你说的两个痛点，同时是后面所有家的骨架 |
| P2 | Claude 桌面版会话级 + 项目级 | 九家里第二个能精确定位对话的。**VS Code 扩展不做**：`vscode://anthropic.claude-code/open?session=` 落在最前面的 VS Code 窗口，按该窗口工作目录 `--resume`，窗口目录与对话项目不同就找不到，Mesa 控制不了落哪个窗口 |
| P3 | Kimi、OpenCode 项目级（含版本门槛） | 补全 B 档 |
| 暂不做 | C 档 Qwen/CodeBuddy 本机 Web 服务（要管进程、端口、令牌）；D 档三家 | 成本高于价值，等官方出稳定入口再说 |

## 8. 实施前必须实测（动用户真实数据，按 AGENTS「先干跑」纪律）

1. `claude://resume` 导入一条**走第三方网关**的会话：导入成功与否、续聊走哪个账号/模型、桌面版是否改写或复制原 jsonl。会往你的 Claude 桌面版里新增一条会话记录，需要你同意再做。
2. Codex：对话不在 threads 表时客户端的实际表现；`codex://threads/new?path=` 对未登记目录的表现（是否弹工作区信任）。
3. Windows 上 `codex://`、`claude://` 的注册表项位置与版本读取方式（本机是 macOS，Windows 全靠文档，须在 Windows 机器上验）。
4. OpenCode 桌面版真机：scheme 与 `open-project` 路由在当前发行版是否仍有效。

## 9. 测试与验收

- 预检逻辑做成纯函数（输入：spec + 本机探测快照；输出：plan），用夹具 config.toml / 夹具 sqlite 单测，不碰真实客户端。
- 深链拼接单测在 `client_open.rs`（含中文路径、Windows 反斜杠路径、空格、非法会话 id / 块名）；前端纯逻辑在 `tests/client-open.test.ts`。
- 打开动作本身无法自动化（会真的拉起用户的客户端）。界面验收只在 Mesa Dev 热更新窗口里列清单交给你点：每个客户端三种情形（已就绪 / 需修复 / 被拦下）。

## 10. 需要你拍板

1. **分档方案**：认可「A 档对话级 / B 档项目级 / C、D 不做」，以及 D 档不显示按钮？
2. **Claude 渠道语义**：桌面版继续时用它自己的账号，不走 Mesa 里选的网关，接受这个「渠道会变」的提示式处理？（如果要求必须走同一网关，桌面版接力对网关会话就不成立，只能保留「在 Mesa 里继续」。）
3. **范围**：先做 P1 + P2，P3 视反馈再定？

## 11. 真机点验清单（交给你点；打开动作会真的拉起你的客户端，自动化不了）

用 `npm run tauri:dev` 的 Mesa Dev 热更新窗口。先备好：一条 Codex 官方 / 无渠道记录的对话、一条用 Mesa 的 API 连接开的 Codex 对话（provider 形如 `ccode-xxxx`）、一条 Claude Code 对话。

1. **Codex 直通**：对话页选一条官方渠道的 Codex 对话 → 点底部「在 Codex 客户端打开」。应直接拉起，右下角提示「已交给 Codex 客户端」，无弹层。
2. **Codex 缺渠道**：选 `ccode-xxxx` 那条 → 点同一按钮。应弹层说明要写入 `~/.codex/config.toml`，点「写入并打开」后客户端打开该对话且不再报 Model provider not found；再点一次应直接拉起、不再弹层；连接页那条连接行尾「移除 Codex 客户端注册」能撤销。
3. **Claude 桌面版**：选一条 Claude Code 对话 → 点「在 Claude 桌面版打开」。用 Mesa 连接开的会先弹「会换账号」提示；点「打开」后桌面版 Code 标签应出现这条对话（**这会往你的桌面版新增一条会话记录**）。回来看 Mesa 的回放是否同步。
4. **双写提示**：对一条正在 Mesa 终端里跑的对话点按钮，应出现「还在终端里运行」警告和「仍然打开」。
5. **被拦**：对一条已被 CLI 清掉源文件、又没保留的 Claude 对话点按钮，应只显示原因、没有主按钮。
6. **项目级**：工作台最近项目行悬停出现外开图标 → 点。两家客户端都装了时先问用哪个，选后在该目录新开对话；只装一家时直接走。
7. **右键菜单**：对话列表右键一条 Codex / Claude 对话，「继续」组里应有对应的「在 … 打开」。
8. **没装的情形**：（可选）临时改名 `/Applications/Claude.app` 后重进对话页，Claude 对话不应再出现按钮。
