# Agent 绑定功能：应有的样子 vs 当前问题

> 2026-10-15 收口：下面问题 1、问题 2 已按代码修掉。任务卡「继续」出现在当前步骤卡「AI 干活」行（新会话，步骤绑定 > 问 AI 槽 > 项目默认，不接回旧 Agent）。「去终端看看」在没有正在跑的会话、且这一步绑的是另一家 Agent 时，不再接回历史会话，启动栏改用绑定。正在跑的会话仍只切回去。验收看用户指南 §4.3。

## 应该是什么样

### 你在 Agents 页绑了什么

项目 → Agents → 专属绑定 → 科研步骤，给「综述大纲」这一步选了 Codex · 某连接 · 某模型。

### 各入口应该的表现

| 入口 | 应该用什么 | 为什么 |
|---|---|---|
| **开工弹层**（点「开始」） | 你绑的那套（预选显示，可改） | 绑定=预填默认 |
| **任务卡「继续」** | 你绑的那套（自动启动） | 继续是执行——同一步不换模型 |
| **「跟 AI 商量一下」** | 项目默认（**不用**你绑的） | 商量是聊天，与步骤任务类型无关 |
| **问 AI / ＋新对话 / 聊想法** | discuss 槽（没绑=项目默认） | 同上 |
| **「去终端看看」** | 已有会话→原会话的 agent；无会话→你绑的那套 | 回到那个对话优先 |

### 一句话

**你绑了哪步，哪步的开工和继续就用你绑的；聊天商量类全走项目默认，不吃步骤绑定。**

---

## 当前有什么问题

### 问题 1：任务卡「继续」不用绑定的配置

**现象**：你在 Agents 页给某步绑了 Codex，回到任务卡点「继续」，终端打开后启动栏显示的是之前用过的配置（比如 Claude），不是你绑的 Codex。

**代码上应该走的路**：
```
点「继续」→ onContinue(card) → 查数据库拿 step:步骤名 的绑定 → 用绑定的连接+模型开终端
```

**实际结果**：终端显示旧配置。我改了三轮（props 链 → DB 兜底 → DB 优先），你说还是旧的。

**我目前不确定断在哪**，可能的原因：
- `onContinue` 里的异步 DB 读取（`await invoke`）可能没执行到或被静默吞掉
- 终端页面可能在某个地方覆盖了传入的 agentId/profileId
- `card.step`（卡片上存的步骤名）和 Agents 页保存时用的步骤名可能不一致，导致数据库查不到绑定

### 问题 2：「去终端看看」不用绑定的配置

**现象**：步进器上点「去终端看看」，如果工作区没有活着的会话，新开的终端用旧配置。

**原因已确认**：我在撤商量类绑定时把这条路径的步骤绑定也误删了，后来补上了 DB 直查，但你可能还没刷新验证。

### 问题 3：技能预检在切换 Agent 后消失

**现象**：开工弹层里「所选 Agent 的技能与工具」区块，切到没有连接的 Agent 后整块消失。

**原因已确认**：原来挂在 `launch` 下（必须选了连接才显示），我改成了跟随弹层当前选的 `agentId`，这个应该已修好。

---

## 我改了什么（全部改动清单）

### 后端（Rust）
- `projects.rs`：`task_bindings` 列（槽位→{profile, model}）；`set/get_project_agent_binding` 命令；步骤重名校验
- `runs.rs`：tasks 表 `model` 列（追加末尾）
- `scheduler.rs`：Schedule 加 `model` 字段；执行链模型解析+失效披露
- `ai.rs`：`FN_WATCH_EXPLAIN` 常量

### 前端（React/TS）
- `project-agents.ts`：7 个纯函数（slotPrefs/taskBindingLaunch/resolveStepLaunch/resolveTaskModel/workspaceLaunchChain/stepSlotKey/DISCUSS_BINDING_SLOT）
- `kickoff-launch.ts`：kickoffLast 记忆（与 askAi 分键）
- `pipeline-start.ts`：buildWorkspaceTerminalRequest 加 stepLaunch 参；resolveStepLaunchByWorkspace
- `KickoffConfirmDialog.tsx`：步骤绑定预选、两态勾选「存为本步骤默认」、kickoffLast
- `TaskCardsSection.tsx`：discussLaunch/stepLaunchFor 派生、onContinue DB 直查、claimForCard 参数化
- `StepFlow.tsx`：商量类撤步骤绑定（用户拍板）；goTerminal 加 DB 直查
- `WorkspaceReviewView.tsx` / `WorkspacesPage.tsx` / `TerminalPage.tsx`：执行面注入点
- `ProjectAgentsView.tsx`：专属绑定区 UI（SlotCard 卡片+步骤符号+科研步骤组）
- `ProjectUserTasksView.tsx` / `AskAiModal.tsx`：目标模型
- `ScheduleSection.tsx` / `LitWatchCard.tsx` / `SettingsPage.tsx`：日程模型+雷达解读
- 5 处 discuss 调用点换 slotPrefs

### 测试
- 前端 1483 全绿；后端 1360 全过

---

## 下一步需要做什么

**核心未解决问题**：任务卡「继续」不用绑定的配置。

我需要在你的环境里实际看一下 `onContinue` 执行时 DB 读到了什么。你方便的话：
1. 刷新页面
2. 打开浏览器控制台（右键→检查→Console）
3. 点「继续」
4. 把控制台里出现的 `[继续]` 开头的那行字发给我

如果控制台里什么都没出，说明 `onContinue` 根本没执行到 DB 读取那步，我就知道断在更上游。
