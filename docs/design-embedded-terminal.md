# 内嵌终端几何合同与使用体验优化

| 项 | 值 |
|---|---|
| 作者 | （待填） |
| 日期 | 2026-09-24 |
| 状态 | Draft |
| 范围 | Mesa 内嵌终端（展示名 Mesa，内部身份 `ccode`）的几何、滚动、输入、第一眼、渲染与九家 CLI 差异 |
| 第一刀 | 「输入行停在半截」：进程看到的第一帧尺寸 = 用户真正看见的那块终端 |

本文只定合同与落地顺序，不改仓库源码。实现时同步改 `docs/conventions/terminal.md`、`docs/architecture.md` §10、以及入口/文案变化对应的 `docs/guide/user-guide.md`。

---

## Overview

2026-09-24 用户截图里，Claude Code 全屏 TUI（Ink）的输入行 `>` 和它自己的状态行（模型、token、bypass permissions、Update available、Image in clipboard）停在画面中部，下面是大块空白。那不是 Mesa 的 `TerminalStatusBar`。Ink 在回合中（截图是 Unfurling）收到 SIGWINCH **不会重排**；输入行留在它上次按当时行数画下的最后一行。所以空白只有在「进程起来之后，Mesa 把 xterm 容器垫高，再发了一次 resize」时才成立。空闲展开主栏和收缩行同高，**不能**把「启动成功后 `setBarExpanded(false)`」一律当成这次高度差。

「退回修改」更不是这条。`WorkspaceReviewView.returnToAgent(false)` 把意见放进 `buildWorkspaceTerminalRequest`，但 `TerminalPage` 消费 `pendingTerminal` 时，`pt.resume` 会把 `initialPrompt` 从标签种子里拿掉，改由 `pendingChatInjectRef` 在 `running || alive` 之后 `sendMessage`。新标签的 `advancedLaunchOpen` 保持 `false`，`barExpanded` 初始就是 `false`（`useState(!restored)` 只对重启占位为 false；这条新标签不是 `restored`）。测量前再收一次栏，行数不变。`pty.rs` 在有 `resume_session_id` 时也不注入 `initial_prompt`。

会在测量时真的垫高的，是**非 resume** 且高级选项还开着的启动：用户点开「高级启动选项」，或开工 / 「按意见重写」/ goal run 把 `initialPrompt` 传进 `TerminalView`（`useState(!!presetPrompt)`）。那一条才在 `fittedPtySize` 之后收栏、再经 150ms `pty_resize` 把格子变高。新会话不重放旧 transcript，所以它修的是半截输入行，不是 80 列双份滚动记录。

上一刀（同日，「审阅退回不再先按 80 列重放」）禁止「先 24×80 再拉宽」。本设计守住它：会重放 transcript 的 spawn 量不到格子就**不启动**，禁止把 `null` 交给 `pty_size_from` 回落 80×24。进程起来之后，`attach` 和 150ms `onResize` 都不得对「与 spawn 尺寸差 ≤1」再发 `pty_resize`。哪些 chrome 允许 SIGWINCH、哪些必须在 `openpty` 之前完成，写成同一份几何合同。后面几刀补滚动语义、输入缺口、运行中「修改」不再撑高、渲染缺口。不推翻 macOS DOM / Windows WebGL。

---

## Background & Motivation

### 眼前的故障链（已对代码，按路径拆开）

`launch()`（以及 `openShell`、自定义 Runtime、脚本标签的 `shell_spawn` / `pty_spawn_custom`）的公共顺序是：

1. `fittedPtySize` 在 `setBarExpanded(false)` **之前**。它先 `fit()` 再读 `term.cols` / `term.rows`；`fit()` 抛错（容器 0×0）则返回 `null`。
2. `cols` / `rows` 传给 spawn。`pty_size_from` 把合法值交给 `openpty`；**缺省或非法回落 24×80**。这正是 2026-09-24 要停掉的窄帧。
3. `spawn_tracked` 在 `pty_spawn` 返回之前就已经起了读线程。子进程可以在 `attach` 的两次 `await listen` 期间，按 openpty 尺寸画出第一帧（Ink）或重放 transcript（Codex / Claude resume）。
4. `attach()` 再 `fit()` 并**立即** `pty_resize`。这是第二次几何事件，不是「和 spawn 同一瞬间」。
5. 成功路径随后 `setBarExpanded(false)`（kimi `promptDropped` 则改为撑开高级选项）。`barExpanded` effect 在 paint 之后再挂一个 rAF `fit()`。xterm `onResize` **无条件** 武装 150ms `pty_resize`，不和 spawn 尺寸比较。容器上的 `ResizeObserver` 同样走这条防抖。

空闲展开主栏与收缩行同高，收起本身是 0 行差：

- 展开主栏：`mb-1`（4px）+ 分段条 `p-0.5`（4px）+ 控件 `h-7`（1.75rem = 28px，高度含在控件内）= **36px**。
- 收缩行：`mt-1 mb-1`（8px）+ `h-7`（28px）= **36px**。不要把 `h-7` 再加一遍 28px。

会把展开态垫得比收缩行更高的，只有主栏**下面**的额外块：

| 额外块 | 何时在测量时存在 | 大约高度 |
|---|---|---|
| 高级启动选项 | `advancedLaunchOpen`。用户点开，或 `initialPrompt` **真的传进了 TerminalView** | 井 `py-2` + 标题行 `h-7`；首条指令再加一行 `mt-2` + `h-8` |
| 模型异常提示 | `modelKept` / 空模型 / 不像模型名 | `.terminal-workbench .text-micro` 是 12px / `line-height: 1rem`（不是令牌 11px / `leading-4`），整行 `order-last w-full` |
| 「请先为该 agent 创建配置」 | `autoStart` 且 profile 不在列表 | `mb-2 text-sm` 一行 |
| `showBarMeta` | 错误、目录问题、端口段、shell / 已退出 | `mb-1` + `.terminal-workbench .text-xs`（13px / 1.15rem） |

`compactBarUrgent` 只看 `error` 或 `cwdIssue`。端口段、shell、已退出在 `showBarMeta` 里，**不会**把已隐藏的收缩行强制拉回来。

#### 路径 R — 「退回修改」（resume，高级栏不参与）

`returnToAgent(false)` → `buildWorkspaceTerminalRequest(..., { autoStart: true, resumeSession: true })`。消费 effect（`TerminalPage.tsx` 约 4921–4935 行）：

- `initialPrompt: pt.resume ? undefined : pt.initialPrompt`。新标签 `presetPrompt` 是 `undefined`，`advancedLaunchOpen` 与 `showPrompt` 都是 `false`。
- 意见进 `pendingChatInjectRef`，等 `st.running || st.alive` 才 `sendMessage`。注入不改终端高度。
- 新标签 `restored` 不是 true，`barExpanded` 初始 `false`。成功后的 `setBarExpanded(false)` 不改变高度，`barExpanded` effect 不会因为这次赋值再跑（state 没变）。
- `pty_spawn` 看到 `resume_session_id` 就把 `initial_prompt` 丢掉。

因此：**不能把方案 B「先关掉高级选项再量」写成这条路径的修复。** 在这条路径上它是空操作，验收会假绿，截图仍没有解释。

这条路径上 Mesa 仍可能在进程起来之后改高度，但不是启动栏收起：

- 复用已有标签时 `actions.modify` 不会自动调用；人在回合中点「修改」会 `setBarExpanded(true)` 且 `setAdvancedLaunchOpen(true)`（约 2970 行）。盒子变高。PR1 **不**为此 `pty_resize`。
- 查找条在 xterm 宿主上方文档流里（`mb-1`，`py-1`，输入 `h-7` 量级）。打开它盒子变矮。PR1 **不**为此 `pty_resize`。
- `resumeKick` 的 `launch()` **没有** `visible && everVisible` 守卫（autoStart effect 有）。聊天层 `sendMessage` 可以在终端层 `absolute inset-0` 被盖住、或 pane `hidden`（`display: none`）时 resume。0×0 上 `fit()` 抛错 → `null` → 24×80，然后再被拉宽。这会把上一刀刚修掉的窄副本写回来。
- 同一 Run 已有活 PTY 时，`pty_id_for_run` 在 `openpty` 之前就返回（`pty.rs` 约 682–690 行）。返回值和新建共用 `SpawnResult`：`ptyId`、`sessionHint`、`promptDropped`、`model`、`runId`。收养分支把 `prompt_dropped` **写死 false**，所以它不是信号。`pty_spawn_custom` 不走这条，它先 `claim_interactive_start` 再 `spawn_tracked`。前端今天分不出「新建」和「交回旧进程」。先收栏再发现是收养，会在已经画过的进程上改高度，150ms 后 SIGWINCH。

截图若来自路径 R，空白要么是上面某一条**事后**高度变化，要么是 Ink 自己的视口（输入行不在最后一行）而 Mesa 盒子没变。本设计禁止探测 Ink 帧，所以**没有量到 Mesa 盒子变高之前，不得把路径 R 写成「启动栏垫高」**。PR1 对路径 R 的交付是：不引入 24×80，也不在 spawn 之后用无意义 resize 去「纠正」一个没变过的栏。

#### 路径 N — 非 resume，测量时高级栏开着（本次半截输入行的真实高度差）

开工、`returnToAgent(true)`（按意见重写）、goal run，以及用户在空闲标签上手动打开高级选项再点运行。`initialPrompt` 进 `TerminalView`，`advancedLaunchOpen` 初始为 true。`fittedPtySize` 量到矮格子；spawn 之后才 `setAdvancedLaunchOpen(false)` + `setBarExpanded(false)`。高度掉下去，150ms 后 SIGWINCH。新会话不重放旧 transcript，但 Ink 若已经按矮高度画了第一帧（尤其带首条指令、回合已开始），输入行留在旧的最后一行。回合结束贴底、拖窗口重排，都不是修复。

`attach` 里那次 `pty_resize` 发生在收栏之前，尺寸与 spawn 相同，取消不了收栏之后的防抖 resize。

#### 路径 K — kimi，非 resume，有首条指令

`PromptInject::Unsupported`，后端 `prompt_dropped`。今天成功后保持栏展开并复制指令。这条路径**没有**「量完再收起」的高度跳变。前端不能只凭 agent id 在一切 `fittedPtySize` 调用上保持展开：resume 的意见不在高级栏里，shell / 自定义 Runtime / 退出回落 shell 根本不注入 prompt。

### 上一刀为什么不能撤

`docs/architecture.md` 2026-09-24：「审阅退回不再先按 80 列重放」。PTY 固定 24×80 时，Claude 在第一帧按 80 列把整段对话写进滚动记录；随后 fit 再拉宽，同一段按实际宽度再写一份。`docs/guide/user-guide.md`「接回原来那条对话」已写明：更早那份窄画面清不掉，右键「清屏」只能整段清 xterm 缓冲，会话正文在聊天层。

路径 R 的第一帧合同因此是：**量到的格子原样 `openpty`；量不到就不要 spawn。** 不是「先把本来就收起的栏再收一次」。路径 N 才要在 `openpty` 之前去掉会在成功后消失的高级选项，让第一帧等于用户接着要看的那块。两条都不允许先 80 列再 resize，也不靠「等 Claude 贴底」。

### 已经核实、设计里当事实用的几何

- **审阅覆盖层不改终端几何。** `WorkspaceReviewView`（以及 `WatchRunReview`）是 `absolute inset-0 z-30`，盖在终端页上。底下 `TerminalView` 保持挂载，容器像素尺寸不变。开合评审不得、也不会发 SIGWINCH。
- **聊天 / 终端切层不改行列。** 两层都是 `absolute inset-0`（聊天层 `z-20`）。`TerminalStatusBar` 在 pane 里、xterm 容器之外，设置页「底部状态栏」两层同进退（`h-8` + `mb-2` = 40px）。切层不 fit。`docs/conventions/terminal.md`「聊天层拉起终端」已写死。
- **拉起终端会 SIGWINCH 一次，这是既有代价。** `CHAT_PEEK_RATIO = 0.32`，底栏 `min-h-[7.5rem]`（120px）再按 32% 取高。注释写明不能只裁全高 xterm 的底部：Codex 主对话是 inline viewport，内容靠上，裁底是白板。默认关；confirm、8 秒无会话文件、`/model` 无参 / `/models` / `/login`、聊天层点 picker 时自动打开。用户手动收起后本轮不再自动打开。
- **分屏 pane 小头是 32px**（`h-8`），只在分屏时插入。进出分屏、拖分隔条都会改宽（和高，因为小头挤占）。`onResize` 150ms trailing 防抖是为 Codex reflow 减次数，不是为了取消这次 SIGWINCH。
- **阅读区是 DOM 搬移。** `data-terminal-host` / `data-statusbar-host` 被 `appendChild` 进 `ReaderOverlay` 槽位，槽位更窄。搬进和搬回都在 `pty_resize` 名单里：盒子稳定后由搬移处理函数发一次，再记 `measured`。不靠 `onResize` 自动发。
- **字号 / 字体变化会 SIGWINCH。** 设置 effect 在容器像素没变时手动 `fit()`，因为 `ResizeObserver` 看不见字号。这是用户改显示的显式变化。
- **macOS 默认 DOM、Windows 默认 WebGL**（2026-09-19 / 2026-09-21）。不在本设计里改默认。
  （2026-10-22 起自动档两个平台都走 WebGL，见 conventions/terminal.md「终端渲染器」。）

### 两类 TUI，同一套 chrome 不能用同一套补救

| 类 | 谁 | 尺寸变化时做什么 | Mesa 能做什么 |
|---|---|---|---|
| Ink 全屏 | claude-code、cursor（主画面原地重绘，不留 scrollback 副本） | 回合中收到 SIGWINCH **不重排**；回合结束通常贴底 | 进程起来之前把稳定高度给够。起来之后 Mesa 自己不要再改高度 |
| Inline viewport + reflow | codex 主对话（alt screen 只用于 `/model` 等覆盖层） | 每次 SIGWINCH 把 transcript 按新宽度重放，旧帧留在 scrollback。上游 reflow 恒开 | 第一帧就用最终宽度，避免「窄一份 + 宽一份」。之后能不发 SIGWINCH 就不发。禁止开 `tui.terminal_resize_reflow_max_rows` |
| Inline、闪烁 | gemini（qwen 同源） | 高度超过行数会整区重绘。官方缓解是用户自己的 `ui.useAlternateBuffer` | 不替用户写该设置。减少 Mesa 造成的 resize 就是减少闪烁 |
| 其余 | opencode、kimi、codebuddy、grok | 不逐家解析菜单，也不假设它们会在回合中重排 | 与 Ink 同一条「第一帧即稳定高度」。个别家的键盘差异已在 `terminal-input.ts` / `agent-caps.ts`，保持 |

---

## Goals & Non-Goals

### Goals

1. 会重放 transcript 的 spawn（resume，以及任何第一帧按 PTY 尺寸画整段的 CLI）只用 `fittedPtySize` 量到的格子 `openpty`。量不到就不 spawn，绝不把 `null` 变成 24×80。
2. 非 resume 且成功后会关掉的 chrome（高级选项、因此变高的展开栏）必须在 `openpty` 之前关掉，第一帧等于关掉之后的格子。空闲主栏与收缩行同高，收起本身不是修复。
3. `openpty` 之后，在下一次用户几何手势之前，不发 `pty_resize`。`attach` 与 150ms `onResize` 共用同一把锁。差 ≥2 行则不要启动，而不是启动后再纠正。
4. 写明每种 chrome：允许 SIGWINCH，还是必须在进程起来之前完成。Ink 与 Codex 的失败形态分开写。
5. 运行中「修改」不再撑高 xterm。PR1 不假装已经做到；那是 PR4。PR1 的验收不含这条。
6. 滚动、清屏、重复帧与聊天层正文对齐：不假装能手术删除已写入的 scrollback。
7. 输入缺口只补还缺的；已经够用的标保持。PR 可独立合并。PR1 只修「第一帧尺寸错了」：路径 N 的半截输入行，加上路径 R 禁止退回 24×80。

### Non-Goals

- 不自动拆任务，不改科研流水线、评审、采纳、工作区语义。
- 不把 Codex reflow 关掉，不预设 `tui.terminal_resize_reflow_max_rows`，不假设官方旋钮可以不丢历史。
- 不把 macOS 默认渲染器改成 WebGL，不引入 xterm canvas addon（只声明支持 xterm 5）。
- 不解析九家 TUI 菜单，不为一家的 Ink 布局写补丁（不探测「输入行是不是最后一行」再发重绘序列）。
- 不靠「回合结束 Claude 会自己贴底」或「让用户拖一下窗口」当修复。错误行不得写「拖一下窗口」。拖窗口对 Codex 会再留一份 scrollback。
- 不手术删除 scrollback 里已经写下的窄/宽副本。`Terminal.clear()` 只清显示缓冲，不动 CLI 会话文件。
- 密钥不进终端日志、诊断副本、滚动缓冲导出。前端遮盖不是安全边界（现有出站脱敏合同不变）。
- UI 文案保持中文。三平台都要考虑；unix 专属行为的测试继续 `#[cfg(unix)]`。
- 不改 PTY 帧合并（50ms）、可见性 backlog、bracketed-paste 粘性检测的后端语义，除非某一刀明确写到。
- 本文不实现。不改 `src/`、`src-tauri/`、测试或用户文档；那些是 PR 的事。

---

## Proposed Design

### 1. 几何稳定合同

**稳定几何**的定义：某一标签在「将要启动」这一刻，若启动成功且不是 `promptDropped`，启动栏处于运行态（见第 5 节；PR1 的运行态仍是今天的收缩行），高级启动选项关闭，查找条关闭，聊天/终端层、拉起、分屏、左右栏、状态栏开关、字号都保持用户当前选择。xterm 容器在这份布局下 `fit()` 得到的 `cols`/`rows`，就是该进程的第一帧尺寸。

允许与禁止：

| 变化 | 合同 | 理由 |
|---|---|---|
| 启动成功后收起启动栏、关掉高级选项 | **禁止在进程起来之后发生。** 测量前布局必须已经是运行态 | 这就是本次 bug。Ink 回合中不重排；Codex 会把第一帧重放进 scrollback |
| 切聊天 / 终端（不拉起） | **禁止 SIGWINCH。** 两层都铺满同一容器，状态栏两层同在或同不在 | 已落地，保持 |
| 拉起终端开合 | **在名单里。** 开或关各一次：盒子稳定后处理函数 `pty_resize` 一次，再记 `measured` | 不拉起就看不见 TUI。Codex 可能重放。`onResize` 不代发 |
| 审阅 / 冲突 / 定时历史评审覆盖层 | **禁止 SIGWINCH。** `absolute inset-0`，不改终端盒 | 已是事实，写进合同防止以后改成挤占布局 |
| 沉浸阅读区搬移宿主 | **在名单里。** 搬进槽位和搬回各一次，规则与文件树 / 右栏相同 | 槽位更窄。不是查找，也不是运行中「修改」 |
| 分屏开合、拖分隔条、pane 小头出现 | **在名单里。** 开合一次；拖动 150ms trailing 收成一次，由处理函数发 | Codex 连续 reflow 的既有缓解。不是 `onResize` 自动发 |
| 右栏 / 工作树开合、拖右栏宽度 | **在名单里。** 开合一次；拖宽度 trailing 一次，由处理函数发 | 用户改了中带宽度 |
| 底部状态栏设置开关 | **在名单里。** 设置变化、两层一起出现或消失、盒子稳定后，处理函数发一次 | 切聊天 / 终端不因此发。与查找不同：这是提交过的布局 |
| 字号、字体、行高 | **在名单里。** 设置生效并 `fit()` 之后，处理函数发一次 | `ResizeObserver` 看不见字号 |
| 窗口 resize | **在名单里。** 拖动 trailing 一次，由处理函数发 | 用户改了窗口 |
| 隐藏标签、聊天层盖住、pane `display:none` | **禁止 spawn。** `fit()` 抛错则 `fittedPtySize` 为 null。会重放 transcript 的 spawn 见到 null **失败关闭**，不调用 `pty_spawn`，从而不落到 `pty_size_from` 的 24×80。`launch` / `resumeKick` / 聊天里触发的 resume 都要 `visible && everVisible` 且 `fit()` 成功，与 autoStart effect 对齐 | 0×0 再拉宽会把窄 transcript 写进 scrollback。Codex reflow 和 Claude 第一帧重放都留得住那份窄的 |
| 空态卡、菜单、粘贴提示 | **禁止改变文档流高度。** 空态卡已是 `absolute inset-0`；菜单 portal 到 body；`inputNote` 绝对定位 | 这些不是终端格子的一部分 |
| 查找条 | **PR1 不 `pty_resize`。** 在叠层那一刀落地前，打开或关闭会改 xterm 盒子高度。行数差留下，直到名单里的手势，或下次 spawn 时这条不在稳定布局里 | 不进手势名单。查找开着时输入行可以不到底。Ink 不用 SIGWINCH 去追。叠在画面上是已定的后续 PR，不进 PR1 的 latch；落地后本行的高度差消失 |
| 运行中点「修改」 | **PR1 不 `pty_resize`。** `actions.modify` 把栏和高级选项打开，盒子变高。行数差留下，直到名单里的手势，或 PR4 让这块离开文档流 | 不进手势名单。栏摊开时输入行可以不到底。这是接受的。PR4 才去掉这块高度 |
| kimi 非 resume 且有待粘贴的首条指令 | **测量前保持当前展开高度，成功后也不要再撑开或收起。** 见路径 K | 先按收起高度启动再展开，等于路径 N 反过来 |

Ink 策略：第一帧即最终格子。进程活着之后，只有名单里的手势处理函数发 `pty_resize`。查找条和运行中「修改」可以改盒子高度，但不发。输入行可以因此停在半截，直到下一次名单内的手势，或这块 chrome 在下次 spawn 前离开文档流。不发送重绘键，不解析 Ink 帧。回合中不重排是上游事实，不是 Mesa 的补救手段。

Codex 策略：同样要求第一帧即最终格子，避免恢复时窄/宽两份。用户手势仍会 reflow；那一次 `pty_resize` 由手势处理函数发出，150ms 只合并拖拽中的多次 fit。`onResize` 自己不发。不延迟启动，不开 reflow 旋钮。

**openpty 之后的锁（所有会 `pty_resize` 的路径，不只 `attach`）：**

子进程在 `pty_spawn` 返回前就可能按 openpty 尺寸画完第一帧。`attach` 要等两个 `listen`，那段时间里 Ink 已经画了、Codex 已经重放了。所以「`attach` 里尺寸相同就跳过」不够：`barExpanded` effect 和 `ResizeObserver` 的 `fit()` 仍会进 `term.onResize`，150ms 后照样 `pty_resize`。

```text
latch = unset                        // 每个标签。unset 不是「允许 resize」
// 新进程，且 openpty 用的是收栏之后的格子：
latch = measured { cols, rows }      // 就是那次 openpty 的尺寸
// 收养已有进程（在 attach 之前）：
latch = frozen                       // 没有 cols/rows。探测只返回 pty id
// attach 与 150ms onResize 都问 allowPtyResize：
//   unset：仅当本标签没有活 PTY 时允许
//   frozen：一律不允许
//   measured：一律不允许。差 0、1、2 行以上都是 false
```

`unset` 不能当成允许。`measured` 也不能因为差得大就返回 true。`attach` 和 150ms `onResize` 在进程活着之后都只问这个函数，所以它们**永远不**调用 `pty_resize`。今天 `attach` 在两个 `listen` 之后无条件 `pty_resize`（约 2042–2049 行），`onResize`（约 1736 行）150ms 后再发一次，而且不知道 fit 是谁触发的。差 ≥2 若从这里放行，错误行、`barExpanded` effect、`ResizeObserver` 都会把 SIGWINCH 送回活进程。那是方案 D。

150ms 只合并同一次拖拽里的多次 fit。它不是「差得够大就 resize」的许可证。

差 ≥2 行若发生在 **新进程 spawn 之前**（提交 chrome 之后 `fit()` 仍对不上）：不要 spawn。spawn 之后的差距只报告或忽略，不纠正。

spawn 之后唯一的 `pty_resize` 就是下面这一份名单，后文不再另写一份短的：**拖窗口、拖分隔、改字号或字体、显式开关文件树 / 右栏 / 拉起 / 分屏、阅读区宿主搬进和搬回、设置里开关底部状态栏。** 查找条和运行中「修改」不在这份名单里，PR1 不加进去。手势处理函数自己调用一次（拖拽可用 150ms trailing 收成一次），**然后**把 latch 写成这次 fit 的 `measured`。已经是 `measured` 的再拖一次也走这条，不限于解开 `frozen`。不要先改 latch 再问 `allowPtyResize`——函数对 `measured` 恒为 false，问了也发不出去。收养不是这个手势。查找或「修改」把盒子垫高或压矮时，**不** `pty_resize`。行数差留下，输入行可以不到底。Ink 不会被 SIGWINCH 追着贴底。差留到下一次名单内的手势，或这块 chrome 离开文档流（查找的叠层 PR 落地后打开不再占高度；「修改」要等 PR4）。PR1 在叠层落地前仍按「占高度、不 `pty_resize`」验收查找。

错误行只说明「这次没能按画面大小启动」或「已接回正在跑的进程，画面大小先不动」。不写「拖一下窗口」。

纯逻辑测三态，不把像素差换算成行数。见 API 节。没有 `rowsAfterCollapse`。

### 2. 眼前 bug 的修法（第一刀）

先分路径，再写顺序。路径 R 与路径 N 不是同一个 bug。

#### 方案比较

**方案 A — 用像素差换算行数（未选，也不做断言）**

`fit()` 之后用 `term.rows + round(deltaPx / cellHeight)` 当作 spawn rows。换行、`lineHeight`、DPR 会算错；算错一行 Ink 仍然停在半截。cell 高度不是公开稳定 API。**不实现 `rowsAfterCollapse`，单元测试也不构造 `extraRows`。** spawn 尺寸只有 `fittedPtySize` 在布局提交之后读到的 `cols`/`rows`。

**方案 B — 仅在「成功后 chrome 会变矮」的启动上，测量前先提交那份矮布局（选定，只覆盖路径 N）**

适用条件由 `launchChromeBeforeMeasure` 给出，不是「凡是 launch 都收栏」：

- `resume === true`（路径 R）：**不改** `barExpanded` / `advancedLaunchOpen`。意见不在高级栏里。测量的就是当前已经显示的格子。
- 非 resume、有首条指令、且 `promptInject !== "unsupported"`（claude / codex / gemini / qwen / opencode / codebuddy / cursor / grok 的开工与「按意见重写」）：测量前 `advancedOpen = false`，`barExpanded = false`。
- 非 resume、`promptInject === "unsupported"`、prompt 非空（路径 K，今天是 kimi）：**保持** 调用前的展开状态，不收高级选项。
- `openShell`、脚本标签、自定义 Runtime、`onPtyExit` 回落 shell：没有 prompt chrome。**不要**为了统一而收栏再 fit。栏已经在运行布局时再收一次是空操作；若 `fit()` 抛错，旧逻辑会把本来能用的尺寸换成 24×80。这些入口只遵守「null 不 spawn」和 spawn 尺寸锁。

提交布局的信号只有一个，写死，不用双 rAF：

`barExpanded` effect 在 **paint 之后**才排队自己的 rAF。从 `launch` 里数两帧，与那个 `fit()` 并行，不是在它之后。合同里不再有「两帧够不够」。

`pty_spawn` 的收养在 `openpty` 之前返回，但前端在 `invoke` 回来之前不知道。今天 `launch()` 开头就 `await cleanupPty()`，把 `ptyIdRef` 置空并 `pty_kill`。所以：

- 不能用「返回的 `ptyId === ptyIdRef.current`」当收养信号。`cleanupPty` 已经把 ref 清掉；若这次杀的就是 `pty_id_for_run` 指着的那个进程，后端随后会走新建，不再是收养。
- 不能靠 `promptDropped`。收养分支把它写成 `false`（`pty.rs` 687 行），新建的 kimi 才会是 `true`。
- 热更新或另一标签丢了 id 时，本组件的 `ptyIdRef` 本来就是 null，但 Run 上仍有活 PTY。这个调用者需要返回的 `ptyId`，不能因为 ref 为空就跳过 `pty_spawn`。

`pty_spawn` 不能拿来探测。未命中 `pty_id_for_run` 时，`spawn_tracked` 仍用这次传入的 cols/rows 做 `openpty`（约 697–705 行）。读线程在 `pty_spawn` 返回前就启动。按高级栏还开着的行数 openpty，再收栏 `pty_resize`，就是方案 D：Ink 不重排，Codex 留下矮的那一份。开工 / goal run / 按意见重写经常带着 `runId`，这条不是边角。

PR1 两处 IPC，都不改 `pty_size_from`：

```rust
pub struct SpawnResult {
    // 既有字段不变
    pub adopted: bool, // 仅 pty_id_for_run 提前返回为 true；spawn_tracked 成功路径为 false
}

// 只读。转调 PtyManager::pty_id_for_run（pty.rs 约 97 行，已有 pub(crate)）。
// 空 run_id 返回 None。不 openpty，不 pty_resize，不 claim。
#[tauri::command]
fn pty_id_for_run(manager: State<PtyManager>, run_id: String) -> Option<String>;
```

`pty_spawn_custom` 没有收养分支，`adopted` 固定 `false`。它内部的 `has_run` 只决定 claim 失败，不交回旧 PTY。探测命令对它同样只读；若探测已有 id，不要再 `pty_spawn_custom`（会去抢已经在跑的 Run）。serde camelCase，前端读 `adopted`。命令在 `lib.rs` 里和 `pty_spawn` 一起登记。

**有 `runId`：先探测，栏不动，不 `pty_resize`。** 探测期间禁止 `cleanupPty`：它会 `pty_kill` 掉 `pty_id_for_run` 正要交回的进程，并把 `ptyIdRef` 清空。

```text
existing = pty_id_for_run(runId)          // 只读，chrome 不变
if existing != null:
  result = pty_spawn(...)                 // 只为收养；cols/rows 被后端忽略
  // adopted 必须为 true
  attach(result.ptyId)
  latch = frozen                         // 在 attach 之前。没有行列
  attach(result.ptyId)                   // allowPtyResize(frozen) 为 false，不 pty_resize
  onResize 同样是 false
  不收栏，不把栏动画回去
  return
// 没有活 PTY。路径 N 现在才收栏，然后按收起后的格子 openpty。
apply(collapse)                           // 路径 R / K 不进这里
size = await waitForPostFitSize()
if size == null:
  restore(snapshot)
  return                                  // 不 spawn
pty_spawn(size)                           // openpty 用 size，不是收栏前的行数
latch = measured(size)                     // 只在这次新 openpty 之后
attach()                                   // 差 ≤1，不 pty_resize
onResize 同样看 measured                   // 也不补一次
```

没有活进程时，收栏不会 SIGWINCH 任何人。`openpty` 的行数就是收栏之后的 `term.rows`。之后不允许再为这次收栏发 `pty_resize`。

探测到活 PTY 时：`attach` 之前 latch 设为 `frozen`。进程保持它自己的行数。本标签即使盒子和那个进程不一致，输入行也可能暂时不到底，直到该 CLI 自己整屏重画，或用户做出第 1 节那种几何手势。收养本身不发 SIGWINCH。把栏收起或再展开都是在活进程上改高度，禁止。

没有 `runId`：不探测。路径 N 先收栏，`waitForPostFitSize`，再 `pty_spawn(size)`，latch 设为 `measured(size)`。同样没有事后纠正性 `pty_resize`。这种调用不会命中 `pty_id_for_run`。`shell_spawn` 不返回 `SpawnResult`，也没有收养分支。

`waitForPostFitSize`：对 `containerRef` 的 `ResizeObserver`（或把现有 observer 的回调接出来）在下一次 `fit()` 成功后 resolve `{cols, rows}`。若这次 setState 没有改变高度（路径 R，或路径 N 的栏本来就收着），resolver 在当前帧 `fit()` 成功后立即返回，不等一个不会来的 resize。超时 **200ms** 仍无成功 `fit()`：resolve `null`，走失败关闭。禁止用两个裸 `requestAnimationFrame` 代替这个信号。

失败还原：

- **还没有活 PTY**（目录不可用、官方账号取消、探测之后 `waitForPostFitSize` 为 null、invoke 抛错）：chrome 回到 snapshot。探测命中活 PTY 时根本没收栏，不要再展开。路径 N 若已经收了栏但还没 `pty_spawn`，把两个 flag 设回 snapshot，并且不 spawn。用户本来收着的栏不要被失败弹开。
- **探测命中活 PTY**：不收栏，不 `restore`。latch 在 `attach` 之前设为 `frozen`。这次 `attach` 和 150ms `onResize` 都不 `pty_resize`。进程行数保持原样。
- **新进程 `attach` 失败或卸载**：不要再动画栏。留下 `measured`。不补 `pty_resize`。
- **后端仍返回 `promptDropped`（前端漏判，且 `adopted === false`）**：高度保持 compact（已经按 compact openpty）。不要再 `setAdvancedLaunchOpen(true)`。指令文本留在错误行，收缩行在 `error` 时会被 `compactBarUrgent` 强制显示；错误行旁保留今天的复制钮（「复制指令」）。只写「错误文案留在收缩行」不够，复制入口必须还在。收养路径的 `promptDropped` 恒为 false，不要据此收栏。

路径 N 成功顺序（claude 带首条指令，**不是**「退回修改」）。有 `runId` 和无 `runId` 的 **openpty 行数都是收栏之后的格子**。

```text
有 runId:
  existing = pty_id_for_run(runId)         // 栏不动
  if existing:
    pty_spawn 只为收养
    latch = frozen                       // attach 之前
    不收栏，不 resize
    return
  setAdvancedLaunchOpen(false); setBarExpanded(false)
  size = await waitForPostFitSize()
  if size == null: restore(snapshot); return
  pty_spawn(size)                          // 这就是 openpty 的行数
  latch = measured(size)                   // 之后没有纠正性 pty_resize

无 runId:
  先收栏
  size = await waitForPostFitSize()
  if size == null: restore(snapshot); return
  pty_spawn(size)
  latch = measured(size)
```

`cleanupPty` 今天在 `fittedPtySize` 之前，且会 `pty_kill`。探测结果还没出来时禁止 `cleanupPty`。探测为 null 之后，本标签上别的死 PTY 可以清，再按收栏后的 size spawn。无 `runId` 的新建可以先 cleanup，再收栏、再量。若 cleanup 挪到测量之后，必须重测量。

不要用「先按高栏 openpty，收栏后再 `pty_resize`」代替上面的顺序。那就是这次 Ink bug。也不要在探测命中之后把栏收起或再展开。

路径 R 成功顺序：

```text
不碰 barExpanded / advancedLaunchOpen
if !visible || !everVisible: 不 spawn，栏保持原样
size = await waitForPostFitSize()  // 当前布局，不先收栏
if size == null: 不 spawn，不把 cols/rows 传成 null
pty_spawn(size)
latch = measured(size)
意见仍走 pendingChatInject → sendMessage，不改高度
```

**方案 C — 运行中启动栏移出文档流（PR4，不是 PR1）**

未启动编辑条留在终端列上方；运行后顶部高度 0，身份只在底栏，「修改」走 portal。这从结构上去掉路径 N 的高度跳变，也去掉运行中「修改」的 SIGWINCH。信息架构单独审查，不塞进 PR1。PR4 之后路径 N 的「先收再量」变成无操作，顺序保留。

**方案 D — spawn 之后再 resize，指望 TUI 重排（否决）**

今天的 `attach` + 防抖 `onResize` 在收栏之后就是这个。Ink 回合中不重排。Codex 多一份 transcript。否决。差 ≥2 行时用它「补救」同样否决。

#### PR1 验收

PR1 **不**声称运行中的栏和查找条已经不占高度。点「修改」或打开查找条时，盒子可以变高或变矮，**不**调用 `pty_resize`。输入行可以停在不到底的位置。这是接受的，验收不要求它们把进程行数拉齐。

- **路径 N：** Claude 新会话，高级选项和首条指令在点击运行前是展开的。第一屏输入行和 Claude 自己的状态行贴着 Mesa 状态栏上沿，中间没有大块空白。不需要等回合结束。**openpty 的 rows** 等于收起高级选项之后的 `term.rows`（差 ≤1），不是收栏前的行数，也不是之后某次 `pty_resize`。latch 期间没有 `pty_resize`。goal run / 开工 / 按意见重写即使带了 `runId`，只要探测时没有活 PTY，也按这一条在 **openpty** 上验收。
- **路径 R：** 「退回修改」新标签上，`advancedLaunchOpen === false` 且 `barExpanded === false` 贯穿 `fittedPtySize` 与 `pty_spawn`。rows 在这两点之间不因收栏而变化。隐藏标签或 `fit()` 失败时 **没有** `pty_spawn`。可见且 fit 成功时，openpty 尺寸等于当时格子，不是 80×24。不要求这条路径「因为收起高级栏而多出几行」——那几行本来就不存在。
- **路径 K：** 非 resume 的 kimi 带首条指令。栏保持展开，格子等于展开态。若后端仍 `promptDropped`，栏高不变，错误行能看见指令并复制。
- **收养：** 探测 `pty_id_for_run` 已有 id 时，栏高不变，再 `pty_spawn` 只为接回。`attach` 之前把 latch 设为 `frozen`。这次 `attach` 不调用 `pty_resize`，150ms `onResize` 也不调用。探测只有 pty id，不能把 frozen 实现成「latch 等于当前 `term.rows`」。进程行数不变。新标签盒子若不一致，输入行可以暂时不到底，直到 CLI 自己重画，或用户做出名单里的手势（拖窗口、拖分隔、改字号或字体、开关文件树 / 右栏 / 拉起 / 分屏、阅读区搬进或搬回、设置里开关底部状态栏）。验收包含「同一 Run 再启动一次：没有 `pty_resize`，启动栏不收起」。
- **失败且未创建 PTY：** chrome 回到 snapshot，不是强制展开。
- **单元：** 只测 `launchChromeBeforeMeasure`，以及 `allowSpawn` / `allowPtyResize` 的三态。`frozen` 对任何 next 都是 false。`measured` 对差 0、1、≥2 都是 false。`unset` 且本标签已有活 PTY 也是 false。不测像素，不发明 `extraRows`。
- **明确不验成「行数跟着变」：** 运行中点「修改」、打开或关闭查找条。要验的是它们**没有** `pty_resize`。输入行不到底是预期。用户指南不写「不再按摊开的工具栏的矮屏幕来画」——路径 R 的工具栏本来就没摊开。PR1 不改那句说明书；路径 N 的说明若要写，放在实现确认测量差之后，用「带首条指令的新启动」而不是「接回原来那条对话」。

### 3. 滚动与历史

保持，不改行为：

- 触控板合帧：`src/terminal-wheel-scroll.ts`。`term.element` capture 阶段截住，rAF 合并 deltaY，派回原始 target。备用屏、鼠标上报、修饰键、横向、`deltaMode ≠ 0` 不合帧。
- DOM 行挪位：`src/terminal-row-reuse.ts`。平移不到一整屏且行文字一致才挪节点；WebGL 无行节点则空操作。`smoothScrollDuration` 保持 0（Ink 整屏重绘叠动画会闪）。
- `onResize` 150ms trailing 保持。它减少 Codex 拖拽期间的重放次数，不承担「把错误的第一帧改正」。
- 右键「清屏」保持 `term.clear()`。语义是清 **xterm 显示缓冲**，不是删 CLI 会话，也不是只删重复帧。`docs/guide/user-guide.md` 已写对。

合同（写进 `terminal.md`，PR2 只加测试与文案核对，不改算法，除非下面缺口成立）：

| 事实 | 合同 |
|---|---|
| 已写入 scrollback 的窄副本、Codex reflow 旧帧 | **不能手术删除。** 不提供「去掉重复帧」按钮，不扫缓冲做字符串替换 |
| 会话正文 | **聊天层**（会话文件尾窗 + 「加载更早的消息」）和对话页回放。终端画布是 TUI 现场，不是档案 |
| 清屏 | 只清现场。清完之后 CLI 仍在；聊天层消息还在。文案保持「清屏」，不要写成「清除对话」 |
| 备用屏（Ink 全屏、gemini alternate buffer） | 滚轮交给 TUI，不合帧、不挪行去伪造历史。Ink 本来就没有这份 scrollback |
| 用户向上滚动时的新输出 | **保持 xterm 默认。** 不在本设计里做「锁住视口 / 回到底部」按钮。Ink 全屏不存在视口锁定；inline 的「回到底」若要做，单列后续，不进前四个 PR |
| 隐藏标签的输出 | 保持 `pty_set_visible` backlog。不要为了滚动顺滑改掉不可见标签不往 xterm 写的门控 |

体验缺口（PR2，可做可不做满）：

- 右键「清屏」的菜单项加一行 title：「只清终端画面，对话还在聊天层」。避免用户以为审阅退回的会话被删了。这是文案，不是新命令。
- 不增加「导出终端缓冲」。缓冲里可能有 TUI 回显的密钥形态；导出要走现有会话导出脱敏，超出本设计。

### 4. 输入

| 能力 | 决定 |
|---|---|
| 焦点 | **保持。** 主动 `attach` 聚焦；退出回落 shell `focus: false`。聊天层隐藏不卸载，`focusWhen` 可见才聚焦 composer |
| IME | **保持。** 聊天：`ime-guard.ts`（组词锁 + keyCode 229 + compositionend 后再留一帧）。终端：xterm 隐藏 textarea，不另做一套 |
| 粘贴图片 | **保持。** capture 阶段拦 `image/*`，落盘后写转义绝对路径，不补换行、不自动发送。macOS Ctrl+V → `\x16`（kimi CSI-u）。Windows Alt+V 透传 |
| 拖文件 | **保持。** 命中终端 rect 才写路径；盖住终端的聊天坐标不写 PTY。多路径空格拼接、不换行 |
| Bracketed paste | **保持。** 后端粘性检测 `ESC[?2004h`；`pty_write_submit` 包裹；正文与提交键间隔 60ms；resume 后再等 1.2s |
| 聊天发送 vs 终端输入 | **保持。** Enter 发送、Shift+Enter 换行；运行中写当前 PTY；已退出则 resume；未启动则当首条 prompt。Kimi 无注入则切终端并复制。不解析 TUI 菜单 |
| 审批键 | **保持。** y / n / Esc 写单字符。无效时引导「打开终端」。Grok 不渲染 Esc 停止（`escInterruptSafe`） |
| 终端内 IME 上屏进 PTY | **保持 xterm 默认。** 不拦截 composition。已知缺口是「组词预编辑和 TUI 光标叠在一起」，不在本设计修：各家 TUI 光标协议不同，修一层会破另一家 |
| 查找条打开时的键盘 | **保持** Cmd/Ctrl+F 拦在 xterm 外。PR1 不改 |
| 等待 `waitForPostFitSize` 期间的键盘 | **保持** `interactiveLaunchLocks`：同一次启动没结束前不第二次 spawn。不要把按键写进尚未存在的 PTY。等待的是 ResizeObserver / 当前 fit，不是固定两帧 |

还缺、且不进 PR1 的两条：

- **运行中「修改」会撑高盒子。** `actions.modify` 把栏和高级选项打开（约 2970 行），控件 `disabled={running}`。PR1 不改这个 UI，也不把它加进手势名单，撑高不 `pty_resize`。行数差留下。PR4 让它离开文档流。
- **查找条会压矮盒子，直到叠层那一刀。** 今天在 xterm 上方文档流里（`mb-1`，`py-1`）。PR1 不改它，也不把它加进手势名单。叠层是单独的 PR：绝对定位盖在画面上，打开和关闭不改变 `term.rows`。那一刀之前，输入行可以不到底。验收不要求这两下之后进程行数跟着变。

### 5. 第一眼与状态

今天的分工（保持到 PR4 之前）：

- 未启动：空态卡只写「将在 … 启动/恢复」+ 运行 + 打开 Shell。身份只在启动栏。底栏只留状态点 + 目录胶囊。
- 运行后：启动栏收成一行（Agent · 配置 · 模型 · 目录名 + 插入 / 修改 / ⋯ / 收起）。底栏才出现 agent、模型、git、token。
- 收缩行可整体隐藏（localStorage `ccode.terminal.compactBar`，不是 settings schema），标签栏召回。`compactBarUrgent` 只在 `error` 或 `cwdIssue` 时强制再显示。端口段、shell、已退出属于 `showBarMeta`，不把隐藏的收缩行拉回来。

结构问题：路径 N 的高级选项在文档流里，成功后才拆掉。运行中「修改」会把同一块再撑开。空闲主栏和收缩行同高，不是这次高度差的来源。PR4 去掉这两处，不在 PR1 做。

**决定（PR4）：运行中顶部不再有会变高的启动栏。**

- 未启动：保持现在的分段工具条（Agent → 配置 → 模型）和空态卡。这是唯一需要整条编辑器的时刻。高度在「还没有 PTY」时随便变。
- 运行中：顶部 **0 行启动栏**。身份（agent · 配置 · 模型）只在底部状态栏，目录也只在那里——收缩行今天把目录又写一遍，删掉。
- 「插入」（技能 / MCP）放在**标签栏右侧**，与成果、分屏、查找同一组。底栏只留状态，不放入口。点击仍只写入 PTY 输入缓冲、不回车。不新造一条 28px 的行，也不放在底栏。
- 「修改」在运行中打开的是**浮层**（portal，与 `LaunchMenu` 一样不占文档流）：只读展示本次启动的 Agent / 配置 / 模型 / 目录，文案写「这次进程不会改。要换，先停止」。不提供运行中热切。停止之后浮层关闭，顶部回到未启动编辑条（此时没有全屏 TUI，高度变化无害）。
- 「⋯」（Shell、高级选项、转为项目）同样进浮层或底栏菜单，不占终端高度。
- 错误 / 目录问题：底栏状态点旁一行，或画布上沿的绝对定位条（`pointer-events` 按需），**不增加文档流高度**。若做不到绝对定位，就接受「错误出现时一次 SIGWINCH」，但默认路径（无错误）顶部高度恒为 0。
- 高级选项里的首条指令只存在于未启动。运行中不渲染那个输入框。

未选「运行中常驻一行 h-7」：那一行和底栏重复身份。「修改」一点就从 36px 涨到展开态。PR1 不再为此 SIGWINCH，但输入行会离开底部，所以常驻一行仍不值得留。PR4 用浮层去掉这段高度。

未选「完全不要顶部、未启动也只靠底栏」：空态要一次看清 Agent/配置/模型再点运行，底栏 32px 装不下三段选择器。未启动没有 TUI，顶部变高是安全的。

空态卡、点阵、DECTCEM 藏光标、卡片上不重复身份：保持。`docs/conventions/design-system.md` 终端卡与「身份只活在启动栏」在 PR4 改成「未启动活在启动栏，运行后活在底栏」。

注意力点：保持「只标阻塞人的决策」。done 不亮。不把「输入行不在底部」做成注意力点——那是几何 bug，不是待确认。

### 6. 渲染

不推翻：

- `auto`：macOS DOM，Windows WebGL。软件 WebGL（`isSoftwareWebGL`）和 context loss 退回 DOM。
- 清晰度根因保持记录：WKWebView 里 WebGL 字形图集按整数设备像素取整，DPR 2 把字宽 7.8 压成 7.5。Mac 默认不走 WebGL。
- 用户可在设置里切 webgl / dom，**新开的终端**生效。
- 字体链只走 `terminalFontStack`。默认字号 14。`minimumContrastRatio: 4.5`。`cursorStyle: "bar"`。

缺口（写进设计，不改默认）：

| 缺口 | 合同 |
|---|---|
| Mac 上 DOM 滚动仍比原生终端重 | 已有合帧 + 行挪位。再要流畅，用户显式选 webgl，接受发糊。不把 auto 改成 webgl |
| WebGL 在 Mac 上的字宽压缩 | 不在 xterm 外另缩放 canvas 去「补」3.8%。那会和 fit 的格子不一致，SIGWINCH 尺寸会错 |
| `letterSpacing: 0`、`lineHeight: 1.2` | 保持。改 lineHeight 会改变同一像素高度能放的行数，等于另一次全局 SIGWINCH，要单列决策 |
| scrollback 默认 5000 | 保持。只对新终端生效。不在本次改成更大——内存和 DOM 行数是 Mac 滚动成本的一部分 |
| 渲染器切换不重建已开终端 | 保持。设计里写明：改设置不会修已经画歪的 Ink 布局，下一标签才换渲染器 |

若将来有人提议「Mac 默认 WebGL」：必须单独记 `architecture.md` §10，附同一字体同一字号的字宽测量，并说明 Ink 清晰度回退。本设计不包含该决策。

### 7. 多 CLI

不增加 TUI 种类枚举来驱动布局。几何合同对九家相同：第一帧用 `fittedPtySize` 量到的格子；量不到则不 spawn。之后只有这一份名单才 `pty_resize`：拖窗口、拖分隔、改字号或字体、显式开关文件树 / 右栏 / 拉起 / 分屏、阅读区宿主搬进和搬回、设置里开关底部状态栏。查找条和运行中「修改」改高度，不发 SIGWINCH。见第 1 节。

已知差异只影响**失败时用户看见什么**，不影响 Mesa 发不发 SIGWINCH：

| id | 画面 | Mesa 额外行为（已有，保持） |
|---|---|---|
| claude-code | Ink 全屏，回合中不重排 | 无菜单解析。恢复走 `--resume` / 固定 session id |
| cursor | Ink，同类 | 同 claude，不单独修 |
| codex | inline + 恒开 reflow | 只减次数，不开 `terminal_resize_reflow_max_rows` |
| gemini / qwen | inline，超高闪烁 | 不写 `ui.useAlternateBuffer` |
| opencode | TUI，`--prompt` 可注入 | 无特殊几何 |
| kimi | 无交互 prompt 注入；CSI-u Enter / Ctrl+V | **仅非 resume、prompt 非空**时保持展开。resume 的意见走聊天注入，不因此撑开高级栏 |
| codebuddy | 与 claude 同族注入 | 无特殊几何 |
| grok | Esc 会退出确认 | 停止钮继续隐藏。几何无特殊 |

不读各家状态行当 Mesa 状态栏。截图里的 glm / tok / bypass permissions 永远是 CLI 画的。Mesa 底栏继续只显示自己知道的 agent、配置、模型、git、token 统计。

---

## API / Interface Changes

### 前端纯函数（PR1，新）

放在 `src/terminal-resume.ts`（已是启动尺寸的家）或同目录新文件 `src/terminal-geometry.ts`。若新文件，补 `docs/code-structure.md` 一行。

```ts
export type PromptInjectMode = "positional" | "flag" | "unsupported" | "none";

/**
 * 测量前要不要改启动栏。resume 永远不改（意见不在高级栏）。
 * unsupported + 非 resume + prompt 非空：保持调用方当前的展开态（返回 keepAsIs）。
 * 其余非 resume 且 prompt 非空：收起栏并关掉高级选项。
 * prompt 为空、或 mode 为 none（shell / 回落 shell / 自定义 Runtime）：keepAsIs。
 */
export function launchChromeBeforeMeasure(input: {
  resume: boolean;
  prompt: string;
  promptInject: PromptInjectMode;
}): { kind: "keep" } | { kind: "collapse" };

/** null = 没量到。resume 与任何 agent spawn 都不许把 null 交给 pty_spawn。 */
export function allowSpawn(size: { cols: number; rows: number } | null): boolean;

export type ResizeLatch =
  | { kind: "unset" }
  | { kind: "frozen" }
  | { kind: "measured"; cols: number; rows: number };

/**
 * unset：还没有这次 spawn。本标签没有活 PTY 才允许（fit 一个空 xterm）。
 *   已有活 PTY 时不允许。unset 不是「允许」的同义词。
 * frozen：这次 attach 收养了已在跑的进程。一律 false。
 *   探测只给 pty id，没有行列，不能记成 measured = 当前 term.rows。
 * measured：新进程 openpty 的尺寸（收栏之后）。任何差距都是 false，
 *   包括差 ≥2。spawn 之后的差距不由这个函数纠正。
 * attach 与 150ms onResize 都走这个函数，因此它们在进程活着之后不调用 pty_resize。
 * 用户手势的那一次 pty_resize 在手势处理函数里，不经过本函数返回 true。
 */
export function allowPtyResize(
  latch: ResizeLatch,
  next: { cols: number; rows: number },
  livePty: boolean,
): boolean;
```

`promptInject` 由调用方从已有 agent 规格映射：kimi = `unsupported`，shell 类入口 = `none`，其余按 `PromptInject`。不要在这个函数里写死 agent id 名单，避免 resume 的 kimi 被当成「保持展开」。

`fittedPtySize` / `launchPtySize` 签名不变。不在后端猜「稳定行数」。没有 `rowsAfterCollapse`。

### 前端调用顺序（PR1）

路径 N 的收栏永远在 **openpty 之前**，有没有 `runId` 都一样。有 `runId` 时先读 `pty_id_for_run`：有活 PTY 则不收栏，`pty_spawn` 只收养；没有才收栏、`waitForPostFitSize`、再 `pty_spawn(size)`。没有 `runId` 时不探测，直接收栏再量再 spawn。`waitForPostFitSize` 仍是 ResizeObserver 或当前帧已成功的 `fit()`，超时 200ms → null。null 则恢复 snapshot，不 spawn。

`openShell`、脚本 effect、自定义 Runtime、`onPtyExit` 的 `shell_spawn` 传入 `promptInject: "none"`，不收栏。它们仍拒绝 null 尺寸。回落 shell 发生时栏已是运行布局，禁止为了「统一」再 fit 一次把好尺寸换成 24×80。

`launch`、`resumeKick`、聊天触发的 resume：`visible && everVisible` 为 false 时不 spawn。

新进程在 openpty 之后把 latch 设为 `measured`（收栏之后量到的那个 size）。`attach` 和 `term.onResize` 都经 `allowPtyResize`，对 `measured` 得到 false，所以不调用 `pty_resize`。没有「按收栏前的行数 openpty，再 resize 到收栏后」，也没有「差 ≥2 就从 onResize 补一次」。`adopted === true`：在 `attach` 之前设 `frozen`，这次 `attach` 和 150ms 回调都不调用 `pty_resize`。禁止用 `ptyId === ptyIdRef.current` 推断收养，禁止用当前 `term.rows` 充当冻结尺寸。

拖窗口、拖分隔、改字号或字体、显式开关文件树 / 右栏 / 拉起 / 分屏、阅读区宿主搬进和搬回、设置里开关底部状态栏：手势处理函数在盒子稳定后显式 `pty_resize` 一次，再把 latch 写成这次的 `measured`。latch 原先是 `frozen` 还是 `measured` 都一样。收养不是这个手势。运行中「修改」不在名单里。PR1 不改它的 UI，栏仍可能变高，但不变进程行数。PR4 才去掉这块高度。PR1 不把变高写成 SIGWINCH。

### IPC

`pty_spawn` / `shell_spawn` / `pty_spawn_custom` 的 `cols` / `rows` 不变。`pty_size_from` 不变。

`SpawnResult` 增加 `adopted: bool`（serde camelCase，前端 `adopted`）。只有 `pty.rs` 里 `pty_id_for_run` 那个提前 `return Ok(SpawnResult { ... })` 设 `true`。`spawn_tracked` 成功路径和 `pty_spawn_custom` 设 `false`。旧前端忽略未知字段；新前端把缺字段当成 `false`。

另加只读命令 `pty_id_for_run(run_id) -> Option<String>`，实现就是 `PtyManager::pty_id_for_run`（约 97 行）。不 spawn，不 resize。`pty_spawn` 仍然会在未命中时 openpty，所以不能用它代替这次探测。

PR4 不新增 Tauri command。浮层只用现有 profile / agent 状态。

### 设置

无新设置项。不把「启动前收起栏」做成开关——错误尺寸不是可选项。

---

## Data Model Changes

无 schema、无迁移、无 localStorage 新键。

`ccode.terminal.compactBar` 是 localStorage 键，不是 settings schema。PR4 之后运行中顶部没有收缩行：读时忽略这个键，不删除用户机器上的旧值。这只是和设置页弃用旧键一样的处理方式，不是同一个存储。PR4 的说明书写一句：运行中不再有那一行，「收起启动配置行」入口消失。

重启恢复的标签元数据白名单不变（仍不含 PTY id、scrollback、密钥、env）。

---

## Alternatives Considered

1. **先 80 列再 fit（已否决，2026-09-24）。** 恢复会话第一帧按窄宽重放，scrollback 留两份。`fittedPtySize` 返回 null 再交给 `pty_size_from` 就是这条。路径 R 必须失败关闭。
2. **方案 A，用像素差换算行数。** 换行和亚像素会算错。也不做「断言用」的 `rowsAfterCollapse`，避免 spawn 路径在等待布局不稳时改去用它。
3. **spawn 之后发 Ctrl+L / 空写 / SIGWINCH 两次，逼 Ink 重排。** 不可靠，且 Codex 每次都会再留一份 transcript。否决。
4. **检测「光标不在最后一行」再补 resize。** 那是在解析 TUI。Ink 状态行、备用屏、鼠标上报都会让「最后一行」不是输入行。Non-Goal。
5. **运行中常驻一行 h-7。** 身份和底栏重复。点「修改」仍会把行撑高。PR1 不为此发 SIGWINCH，输入行会离开底部。见第 5 节。PR4 用浮层去掉这段高度。
6. **Mac 改默认 WebGL 换滚动。** 清晰度回退已量化。不在本次。
7. **打开 Codex `tui.terminal_resize_reflow_max_rows`。** 上游注明 resume 可能丢历史。不预设。

---

## Security & Privacy Considerations

- 几何修复不碰 `ProfileStore`、不把密钥写入 PTY 尺寸、日志或错误字符串。`pty_spawn` 失败信息保持现状（后端已有的用户可见错误），不要把 env dump 进「尺寸未对齐」提示。
- `prepareStableLaunchChrome` 只改 React 布局状态，不读 `keys.json`。
- 清屏与滚动缓冲：不新增「把 scrollback 上传 / 写入诊断包」的路径。诊断副本继续不走回显热路径（`terminal.md` 审计合同）。
- 运行中「修改」浮层只显示配置名、模型名、目录，不显示 key、key_hint 以外的材料。key_hint 也不需要出现在这个浮层。
- 图片粘贴仍落 `<config>/ccode/tmp/paste-*`（已有 7 天清理、50MB、扩展名白名单）。本设计不改。
- 外部终端 wrapper、OSC 回报、Windows win32-input-mode 配色通道都不在本设计改动范围内。PR 不得顺手把 OSC 10/11 再写进 xterm handler（ConPTY 双向封死，`terminal.md` 已记）。

威胁模型无新攻击面。风险是实现时把「还原启动栏」写成把 prompt 文本打进日志——禁止。

---

## Observability

- 不新增指标系统、不打点到网络。
- **失败可见性（PR1）**：`waitForPostFitSize` 得到 null 时，`setError("终端还没排好，没有启动")`，不 spawn。spawn 前若提交 chrome 之后的格子与刚量到的差 ≥2 行，同样不 spawn，错误行说明这次没启动。spawn 之后无论差 0、1 还是 ≥2，`allowPtyResize` 都是 false，**不** `pty_resize`。差 ≥2 可以写一行「画面和启动时的大小不一致，这次不改进程」；差 0–1 不提示。这些句子都不写「拖一下窗口」。差距被报告或忽略，不被纠正。
- 后端 `pty_resize` 失败今天 `.catch(() => {})`。PR1 不改这个吞掉——尺寸错误要在前端比对数，而不是靠 resize 抛错。
- 不记录每次 SIGWINCH 的行列到诊断日志（噪声，且无告警接收端）。若以后要做，只在「差 ≥2」时记一行 cols/rows，不记画面内容。

---

## Rollout Plan

无 feature flag。PR1 合入后，新的路径 N spawn 在关掉高级选项之后量格子；路径 R 量不到就不启动。已在跑的 PTY 不会热修。文档不把「拖一下窗口」或「等回合结束」写成修复方法。

回滚：还原 `launch()` 的测量顺序、null 失败关闭和 resize latch。不涉及数据迁移。回滚会让路径 N 的半截输入行回来，也会让隐藏标签 resume 再次可能 24×80。纯代码回退。

文档与版本叙事：

- 行为变化写 `docs/conventions/terminal.md`（几何合同：路径 R / N / K，null 失败关闭，resize latch）。
- 决策写 `docs/architecture.md` §10（实现日；写明「退回修改」不靠收起高级栏）。
- `docs/guide/user-guide.md`「接回原来那条对话」**PR1 不改**。不要写「不再先按摊开的工具栏来画」——路径 R 的工具栏没有摊开。路径 N 若要给使用者一句，用「带首条指令的新启动按收起高级选项后的画面来画」，并且等实现量到行数差再写。
- PR2 只加右键「清屏」的 title，不改「接回」那段的机制句。
- PR4 改按钮时再改设计系统里「收缩启动行」那几句，并改说明书里的「修改启动配置」。
- `CHANGELOG.md` 仅在发版时写。本设计不改它。

三平台：等待信号是 ResizeObserver / 当前 `fit()`，不是裸 rAF 次数。不写死 macOS 像素。测试用 chrome 决策和 allowSpawn / allowPtyResize，不用截图像素。unix 专属 PTY 测试保持 `#[cfg(unix)]`。不改 `pty_size_from` 的默认值——前端不再把 null 传进来。PR1 的 Rust 是 `SpawnResult.adopted` 加上只读命令 `pty_id_for_run`。

---

## Open Questions

1. **仍未决：路径 R 的截图若在「栏高没变」时仍出现半截空白。** 那不是高级栏。本设计不探测 Ink。查找条（叠层落地前）或运行中「修改」若开着，盒子变了但 PR1 不发 SIGWINCH，输入行停在旧的最后一行，这是接受的。若这两者都没开、窗口也没拖，空白才可能是 Ink 自己的视口。Mesa 不发纠正性 SIGWINCH。不把这个未知改回「先收栏」。
2. **已决：运行中「插入」放标签栏右侧。** 与成果、分屏、查找同一组。底栏只留状态，不放技能 / MCP 入口。PR4 按此实现，不再二选一。
3. **已决：查找条改为叠在终端画面上。** 不占文档流，打开和关闭不改变 `term.rows`。单独一刀，不进 PR1 的 latch，也不加入 `pty_resize` 名单。PR1 在那一刀落地之前，查找仍可以占高度且不 `pty_resize`。
4. **隐藏标签。** `autoStart` 已有 `visible && everVisible`。`resumeKick` 和聊天 resume 对齐这条，不在 `display:none` 里预热 spawn。这不是未决项。

---

## Risks

| 风险 | 严重度 | 缓解 |
|---|---|---|
| 路径 R 被实现成「先收高级栏」 | 高（验收假绿，截图还在） | `launchChromeBeforeMeasure` 在 `resume: true` 时返回 `keep`。验收看 flag 没变，不看「多了几行」 |
| 等布局的方式又退回双 rAF，和 effect 里的 rAF 赛跑 | 高 | 合同只有 `waitForPostFitSize`。审查拒绝裸 `requestAnimationFrame` 计数 |
| null 尺寸仍传给 `pty_spawn`，变回 24×80 | 高（窄 transcript） | `allowSpawn(null) === false`。隐藏标签、聊天盖住、回落 shell 的 `fit()` 抛错都走这里 |
| 收养后不设 latch，第一次 attach 仍 `pty_resize` | 高（活进程上的 SIGWINCH） | `frozen` 在 `attach` 之前设好，`allowPtyResize` 返回 false。150ms `onResize` 同一函数。不用当前行数冒充 measured |
| 有 runId 时按高栏 openpty，收栏后再 resize | 高（就是这次 Ink bug） | 先只读 `pty_id_for_run`。没有活 PTY 才收栏，再按那个 size openpty。禁止事后纠正性 `pty_resize` |
| 探测命中仍收栏，或用 `ptyIdRef` 猜收养 | 高（活进程上的 SIGWINCH） | 命中则不收栏、不 resize。`cleanupPty` 不得杀即将交回的进程。新标签盒子不一致也不补 SIGWINCH |
| 失败时把用户本来收起的栏强制展开 | 中 | 只恢复 snapshot，且仅当没有活 PTY |
| kimi resume 被保持展开，或非 resume 被收起后又撑开 | 中 | 决策输入是 `{resume, prompt, promptInject}`。`promptDropped` 后保持 compact，错误行带复制 |
| 收起被做成 spawn 之后 | 高 | 路径 N 的 setState 在 `pty_spawn` 之前。审查看调用顺序 |
| 实现者按验收给查找或「修改」补上 `pty_resize` | 高（又是纠正性 SIGWINCH） | 几何表、§4、PR1 验收都写「改高度，不调用 `pty_resize`」。不把这两项写进手势名单 |
| PR4 删收缩行，打断肌肉记忆 | 低 | 说明书与设计系统同 PR 改 |
| 有人为了修 Ink 去解析备用屏 | 高 | Non-Goal。审查拒绝 CSI 探测 |
| 用户指南写成路径 R 的工具栏曾经摊开 | 中 | PR1 不改「接回原来那条对话」 |

---

## Key Decisions

1. **会重放的 spawn 只用量到的格子；量不到就不启动。** 上一刀禁止先 80 列再拉宽。`null` → `pty_size_from` → 24×80 就是把那一刀撤掉。路径 R（「退回修改」）不靠收起高级栏，因为那栏本来没开。
2. **路径 N 在 `openpty` 之前关掉高级选项。有 `runId` 和没有 `runId` 都一样，只要这次不是收养。** 有 `runId` 时先只读 `pty_id_for_run`；没有活 PTY 才收栏、`waitForPostFitSize`、再 openpty。没有 `runId` 时不探测，直接收栏再 openpty。空闲主栏和收缩行同高（各 36px）。真正垫高的是高级选项。等待信号是 `waitForPostFitSize`（200ms 超时 → null），不是双 rAF。禁止按收栏前的行数 openpty。
3. **chrome 决策看 `{resume, prompt, promptInject}`，不看 agent id alone。** resume 保持现状。`unsupported` 且非 resume 且 prompt 非空才保持展开（今天是 kimi）。shell / 回落 shell 不收栏。
4. **`openpty` 之后，`attach` 和 150ms `onResize` 不再调用 `pty_resize`。** latch 三态：`unset`（还没 spawn，仅无活 PTY 才允许）、`frozen`（收养，一律不允许）、`measured`（新进程的 openpty 尺寸，**任何差距都不允许**，包括 ≥2）。spawn 之后的差距只报告或忽略，不纠正。唯一的事后 `pty_resize` 在手势处理函数里：拖窗口、拖分隔、改字号或字体、显式开关文件树 / 右栏 / 拉起 / 分屏、阅读区宿主搬进和搬回、设置里开关底部状态栏。函数在盒子稳定后发一次，再把 latch 写成新的 `measured`。已经是 `measured` 再拖也如此。收养在 `attach` 之前进入 `frozen`。探测没有行列，不能记成当前 `term.rows`。收养不是手势。差 ≥2 行发生在新进程 spawn 前则不 spawn（方案 D 已否决）。没有「收栏后再 resize 一次」，也没有「差 ≥2 就从 onResize 放行」。错误文案不写「拖一下窗口」。切聊天/终端和审阅覆盖层继续 0 次 SIGWINCH。拉起保持约 32% 的一次，且拉起是手势处理函数里的那一次 resize。新标签盒子若和被收养进程不同，输入行可以暂时不到底。查找条和运行中「修改」不在这份名单里。PR1 里它们可以撑高或压矮盒子，但不 `pty_resize`；输入行可以不到底，直到名单里的下一次手势，或这块 chrome 在下次 spawn 前离开文档流。PR4 才让「修改」离开文档流。PR1 不声称运行中的栏已经不动。
5. **运行中启动栏的终态（PR4）是顶部高度 0，身份只在底栏，修改走浮层。** 「插入」在标签栏右侧，与成果、分屏、查找并列；底栏只留状态。未启动编辑条保留。查找改成画面叠层是另一刀，不进 PR1：落地前查找仍可能占高度且不 `pty_resize`。
6. **不手术删除 scrollback，不解析 TUI，不开 Codex reflow 旋钮，不改 macOS DOM 默认。** 聊天层才是会话正文。
7. **差 ≥2 行：spawn 前放弃启动；spawn 后不纠正。** `measured` 对任何差距都让 `allowPtyResize` 返回 false，所以 `attach` 和 `onResize` 不会补 SIGWINCH。差 0–1 不提示；差 ≥2 可以提示「这次不改进程」，不写拖窗口。用 SIGWINCH 去补更大的差，Ink 不会重排，Codex 会多一份。这包括「有 runId、探测为空、按高栏 openpty 再收栏 resize」，以及「差 ≥2 就从 onResize 返回 true」。两条都已删除。用户手势的 resize 在手势函数里显式发出，不靠这个返回值。

---

## References

- `src/pages/TerminalPage.tsx`：`launch`、`attach`（两个 `listen` 之后才 `pty_resize`）、`openShell`、`onPtyExit` 回落 shell、`resumeKick`、`barExpanded`、`advancedLaunchOpen`、`actions.modify`、`onResize` 150ms、`pendingChatInjectRef`、消费 `pendingTerminal` 时 `pt.resume` 丢掉 `initialPrompt`（约 4921–4935 行）、`CHAT_PEEK_RATIO`、收缩行、`compactBarUrgent`
- `src/terminal-resume.ts`：`fittedPtySize`、`launchPtySize`
- `src/terminal-wheel-scroll.ts`、`src/terminal-row-reuse.ts`
- `src-tauri/src/pty.rs`：`PtyManager::pty_id_for_run`（约 97 行，只读，PR1 暴露成命令）、`SpawnResult`（PR1 加 `adopted`）、`pty_size_from`（null → 24×80）、`spawn_tracked` 在未命中时仍用本次 cols/rows openpty（约 697 行）、`pty_resize`、`pty_spawn` 里「恢复会话不注入初始 prompt」、约 682 行提前返回且 `prompt_dropped: false`、`pty_spawn_custom` 不收养
- `src-tauri/src/agent_specs.rs`：`PromptInject`（kimi = `Unsupported`）
- `src/components/WorkspaceReviewView.tsx`：`returnToAgent`（`resumeSession: !rewrite`）、覆盖层 `absolute inset-0 z-30`
- `src/pipeline-start.ts`：`buildWorkspaceTerminalRequest` 只组装 payload，不决定 TerminalView 的栏是否展开
- `src/draft-review.ts`：`writingReturnPrompt`
- `src/components/TerminalStatusBar.tsx`：`h-8`，两层同进退
- `docs/conventions/terminal.md`：渲染器、合帧、行挪位、Codex reflow、状态栏、聊天拉起、输入侧
- `docs/conventions/design-system.md`：终端卡、空态、收缩行、状态栏 32px
- `docs/architecture.md` 2026-09-24「审阅退回不再先按 80 列重放」；2026-09-22 DOM 行挪位；2026-09-21 清晰度与合帧；2026-09-19 渲染器可切
- `docs/guide/user-guide.md`「接回原来那条对话」
- `docs/agent-integration-matrix.md`：gemini `useAlternateBuffer`、各家 prompt 注入（实现以 `agent_specs.rs` 为准）
- 测试：`tests/terminal-resume.test.ts`、`tests/terminal-wheel-scroll.test.ts`、`tests/terminal-row-reuse.test.ts`

---

## PR Plan

### PR1 — 第一帧只用量到的格子，路径 N 在开进程前收起高级选项

- **标题：** fix: 终端按量到的格子启动；带首条指令的新会话先收起高级选项
- **文件：** `src/terminal-geometry.ts`（新）+ `docs/code-structure.md` 一行、`src/pages/TerminalPage.tsx`（`launch` / `resumeKick` / `openShell` / 自定义 Runtime / 脚本自动启动 / `onPtyExit` / `attach` / `onResize`）、`src-tauri/src/pty.rs`（`SpawnResult.adopted` + 只读 `pty_id_for_run` 命令）、`src-tauri/src/lib.rs`（登记该命令）、`tests/terminal-geometry.test.ts`、`docs/conventions/terminal.md`、`docs/architecture.md` §10
- **不改：** `docs/guide/user-guide.md`「接回原来那条对话」。不改 `pty_size_from`。不改运行中「修改」的 UI。
- **依赖：** 无。可单独合并
- **改动：** 第 2 节。路径 R：不收栏；`visible && everVisible`；`waitForPostFitSize` 为 null 则不 spawn。路径 N：无论有没有 `runId`，openpty 都用收栏后的格子。有 `runId` 时先只读 `pty_id_for_run`；有活 PTY 则不收栏，`pty_spawn` 只收养；没有才收栏、再量、再 spawn，且不再 `pty_resize`。无 `runId` 不探测，先收再 spawn。路径 K：不收。shell / 回落 shell：不收，但 null 不 spawn。探测完成前禁止 `cleanupPty`。新进程 latch 为 `measured(openpty 尺寸)`，`allowPtyResize` 对它恒为 false。收养在 `attach` 前设 `frozen`。`attach` 和 150ms `onResize` 在进程活着之后都不 `pty_resize`。事后 resize 只在列出的手势处理函数里。未创建 PTY 的失败恢复 snapshot。`promptDropped` 仅在新进程上保持 compact，错误行带复制。差 ≥2 在 openpty 前放弃启动。单元测试覆盖 `launchChromeBeforeMeasure` / `allowSpawn` / `allowPtyResize`，外加 `adopted` 只在提前返回分支为 true、`pty_id_for_run` 命令不 spawn。
- **验收：** 见第 2 节「PR1 验收」。点「修改」或打开查找条可以改变盒子高度，并且没有 `pty_resize`。不把这两项加进手势名单。不声称运行中的栏已经不占高度。

### PR2 — 把滚动与清屏语义写进约定和菜单说明

- **标题：** docs: 终端清屏只清画面，重复滚动记录不单独删除
- **文件：** `docs/conventions/terminal.md`、`docs/guide/user-guide.md`（只加清屏怎么理解，**不改**「接回原来那条对话」的机制句）、`src/pages/TerminalPage.tsx` 右键「清屏」的 `title`
- **依赖：** 无。可与 PR1 并行。不碰 PR1 那一段说明书，所以没有合并冲突
- **改动：** 第 3 节。合帧与行挪位保持。已写入的副本不能手术删除。聊天层是正文。清屏 title：「只清终端画面，对话还在聊天层」。不改滚动算法。

### PR3 — 用现有组件测试锁住「这些层不改变 xterm 盒子」

- **标题：** test: 审阅层和聊天层不挤占终端格子
- **文件：** 现有组件测试（`tests/` 里 esbuild 打包 tsx 的那类，与 `research-*-ui.test.ts` 同一口径）、必要时只读断言 `WorkspaceReviewView` / `TerminalPage` 的 className 字符串
- **依赖：** 无。不依赖 PR1 的 latch。**不要**等一个没有调用点的枚举。
- **改动：** 断言审阅覆盖层与 `WatchRunReview` 是 `absolute inset-0`；聊天层与终端层在非 peek 时是 `absolute inset-0`；状态栏在 xterm host 之外且两层共用。不新增 `resizeIsUserGeometryChange`。若断言只能靠源码字符串、组件测试挂不上，就删掉本 PR，把这三句留在 `terminal.md`（PR1 已经要改那个文件）。空枚举不合并。

### PR4 — 运行中去掉会变高的启动栏

- **标题：** fix: 运行中启动配置改到不占终端高度的浮层
- **文件：** `src/pages/TerminalPage.tsx`（含 `actions.modify`，以及标签栏右侧的「插入」）、`src/components/TerminalStatusBar.tsx`（仅错误条若落在底栏；**不**放「插入」）、`docs/conventions/design-system.md`、`docs/conventions/terminal.md`、`docs/guide/user-guide.md`（「修改启动配置」、收缩行、召回钮）、`docs/architecture.md` §10
- **依赖：** PR1（latch 与路径 N 已在）。**不**依赖 PR3。
- **改动：** 第 5 节。这是「进程活着时 Mesa 自己不再撑高」的那一刀。未启动编辑条保留。运行中顶部高度 0；身份只在底栏；底栏只留状态。「插入」在标签栏右侧，与成果、分屏、查找并列，只写入 PTY、不回车。修改是只读浮层，不占文档流。`ccode.terminal.compactBar` 读时忽略，不删 localStorage 旧值。错误条不增加默认路径的文档流高度。不改九家注入，不改空态卡上「身份不重复」的结构。不改查找条的文档流（那是下一刀）。

### PR6 — 查找条改为叠在终端画面上

- **标题：** fix: 查找条盖在终端画面上，打开不再改变行数
- **文件：** `src/pages/TerminalPage.tsx`（查找条从 xterm 宿主上方的文档流改为画面内绝对定位）、`docs/conventions/terminal.md`、`docs/conventions/design-system.md`、`docs/guide/user-guide.md`（若写了查找条占一行）
- **依赖：** 排在 PR1 之后，只为验收时自动 `pty_resize` 已经关掉。叠层本身不改 latch，不把查找加入 `pty_resize` 名单，不碰探测和路径 R。可与 PR4 并行。
- **改动：** 查找输入条 `absolute` 盖在终端画面上（沿用现有查找逻辑：Cmd/Ctrl+F、Enter / Shift+Enter、Esc）。打开和关闭都不改变 xterm 容器高度。
- **验收：** 进程已在跑时打开查找，再关掉，`term.rows` 两次相同，且没有 `pty_resize`。查找控件看得见、能输入，不把输入行往上顶。

### PR5 — 渲染缺口只记录、不改默认

- **标题：** docs: 终端渲染默认保持 macOS DOM / Windows WebGL
- **文件：** `docs/conventions/terminal.md`、`docs/architecture.md` §10（若要把「本次不改默认」记成否决）
- **依赖：** 无
- **改动：** 第 6 节。无代码则并进 PR2，本 PR 取消。有代码变化就不属于本设计。

顺序：PR1 先合并，单独可审。PR2 / PR5 是文档。PR3 只在真有 DOM 断言时存在。PR6 在 PR1 之后把查找改成叠层，可与 PR4 并行。PR4 收掉运行中「修改」的高度，并把「插入」放到标签栏右侧。每个 PR 保持 `npm test`、`npm run build`、`cargo test` 全绿。PR1 的 Rust 是 `SpawnResult.adopted` 和只读命令 `pty_id_for_run`。`pty_size_from` 的 24×80 默认留着给旧前端，新前端不再传入 null。
