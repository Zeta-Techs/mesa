# 聊天层能做到哪一步：分档、按版本降级、读屏债

| 项 | 值 |
|---|---|
| 日期 | 2026-10-22 |
| 状态 | 已实现（用户：聊天层标测试版，五条设计都做） |
| 代码 | `src/chat-fidelity.ts`（分档单一出处）、`src/cli-verified.ts`（已核对版本）、`src/components/ChatBetaBadge.tsx` |
| 前置 | `docs/design-chat-structured-channels.md`（旁路）、`scripts/cli-canary/README.md`（金丝雀） |

## 0. 结论

聊天层是同一个终端会话的另一种看法，终端是事实来源。它能接近上游到什么程度，取决于数据从哪来：
CLI 官方的结构化通道最准、变得慢、坏了是明着坏（握不上手就退回）；会话文件次之；读终端画面最容易随 CLI 改版**悄悄**失效。
所以不追求九家一样，按档承诺，把维护力气放在用户多、通道好的几家上；读屏只做锦上添花，认不准就交给终端。

## 1. 分档（`CHAT_FIDELITY`）

| 档 | CLI | 状态 / 审批 / 正在写的字从哪来 | 承诺 |
|---|---|---|---|
| 1 接近完整 | Codex、Qwen Code、OpenCode | 官方结构化通道；审批能从聊天直接回 | 聊天里基本不用回终端 |
| 2 常用的事都能做 | Claude Code、Grok | 回合与审批来自注入的 hooks / 程序状态；正在写的字、菜单、提问表单靠读屏 | 常用的在聊天，其余回终端 |
| 3 简化 | Gemini、Kimi、CodeBuddy | 不开全局 hooks 就靠读屏推断（CodeBuddy 有 hooks 但没有边写边显示） | 同上，回终端更常见 |
| 4 简化版 | Cursor | 只有会话文件与读屏，没有「等你确认」信号 | 确认菜单在终端里操作 |

输入框左下的小标签点开就是这一张表里当前这家的一行。标签写什么（`fidelityBadge`）：`beta: true` 写「测试版」（第一、二档现在都是）；
第三、四档写「简化」；第一、二档摘了测试版就不标，但 CLI 比核对过的新时标「未核对」。新增一家或某家换了通道，改 `CHAT_FIDELITY` 一处（测试钉住九家都在）。

**平台差异**（`CHAT_FIDELITY_WINDOWS`，`chatFidelity(agent, isWindows)` 显式传平台）：Windows 上 Grok 降到第 3 档——程序状态（OSC 7501）
过不了 ConPTY，后端不接这条旁路（2026-10-25 本机实测，matrix「程序状态 OSC 7501」），和 Gemini、Kimi 一样靠读屏。只有两平台真不一样的家才写进这张表。

## 2. 五条设计规则

1. **关键状态只认精确来源**：回合在不在跑、在不在等确认，以旁路为准，读屏只兜底；边写边显示、菜单按钮原文可以靠读屏，前提是认不出时退到「露出终端」。
2. **读屏宁可认不出，也不认错**：解析只认完整对得上的画面；**替人按键**（点菜单项、交表单、自动交卷）只在高把握时做。显示错一行字可以接受，按错一项不行。
   落地：菜单项与信任菜单先挪高亮、读屏核对停对了才回车（`menuReadyToConfirm` / `trustReadyToConfirm`），对不上不按、卡片重画。
3. **按版本降级**：已核对到的版本取金丝雀基线（`scripts/cli-canary/baseline/<平台>/<agent>.json` 的 `version`，构建时只把这个字段读进包）；
   本平台没有就取别的平台里最新的。用户装的比它新（`versionTrust = newer`）时照常能用，但：不替人自动按任何一步（Claude 提问表单的自动交卷停掉）、
   菜单卡提示「这版 CLI Mesa 还没核对过」、小标签带一个点。读不到版本不降级（没有依据说它变了）。
   CI 金丝雀全绿而只是版本前进时，自己把核对版本前移并提交回 main（`--accept-unchanged`），基线不会一直落后。
4. **先于用户发现**：金丝雀每天装九家最新版跑请求 / 旁路 / 会话 / 画面四层指纹（2026-10-22 从两家扩到九家，macOS 基线九家齐；
   Windows 基线 2026-10-25 补齐九家，抓屏语料库同日补上 Windows 样本）；抓屏语料库（`tests/fixtures/screens/`）把各家各版本的
   画面留作回归样本；「转到终端」计数按 CLI 版本分开记，某家升级后「卡上认不出菜单」突然变多就是读屏坏了。
   扩到九家第一次跑就抓到两处：CodeBuddy 2.172 的工具调用（`function_call` / `function_call_result`）Mesa 一直没读；Qwen 的「有新版本」提示框被当成回复贴进预览。
5. **读屏是债**：见 §3。上游一出结构化通道就换掉对应的读屏（2026-10-22 Claude / Grok 的程序状态就是这样换的）。

## 3. 读屏债清单（还靠读终端画面的能力）

| 能力 | 靠读屏的家 | 代码 | 有望替换的上游通道 |
|---|---|---|---|
| 边写边显示 | Claude Code、Gemini、Grok、Kimi（Codex / Qwen / OpenCode 走旁路） | `live-reply.ts` | Claude hooks 不带文字增量；关注 Claude 的流式事件 / 程序状态 msg |
| 确认菜单的选项原文与按键 | 除能从旁路回复的三家外都靠读屏 | `tui-menu.ts` | 各家 hooks 的 PermissionRequest 只给内容不给选项；程序状态只给「卡住」 |
| Claude 提问表单 | Claude Code | `tui-ask.ts` | AskUserQuestion 的 hook 只给题目，交卷仍要按键 |
| 启动信任目录 | 九家 | `trust-prompt.ts` | Grok 程序状态报 `blocked`（只说在等，不给选项） |
| 「猜的下一句」、生成中 token 数、面板 / 通知识别 | Claude Code | `prompt-suggestion.ts`、`live-reply.ts`、`tui-panel.ts` | 无 |
| 在不在等你（没开全局 hooks 时） | Gemini、Kimi | `tab-working.ts` 推断 + 读屏菜单 | 两家都没有每次注入 hooks 的口子（matrix §14） |

每修一次读屏问题，把那次的原始画面存进抓屏语料库（见 `tests/fixtures/screens/README.md`），以后改解析不会改回去。

## 4. 什么时候摘「测试版」

按家摘，不整体摘。条件：连续两周金丝雀全绿（这家没报红），且设置「诊断 → 聊天层转到终端」里这家的「等确认，聊天卡上认不出菜单」
「等确认，这家没有精确状态」基本为 0。达标就把 `CHAT_FIDELITY` 里这一家的 `beta` 改成 `false`，同步说明书 §聊天 那句。
第一档会先达标；第二档要等边写边显示、菜单不再主要靠读屏。
