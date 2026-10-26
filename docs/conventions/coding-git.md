# 编程项目 Git + GitHub 操作系统

| 字段 | 值 |
|---|---|
| 作者 | Mesa |
| 日期 | 2026-09-03 |
| 状态 | Accepted（v3.202） |
| 范围 | `work_mode = coding` 的项目页（`CodingProjectView` + `coding.rs`），不改科研工作区库 |
| 前置决策 | 架构 v3.179 / v3.180 / v3.190：编程 = git 原语工作树台，**不做转换、不做任意 git 命令框** |
| 上层对象 | 工作树仍是 Git 事实来源。人声明的并行（「再开一条」、Lane 主题分组）是覆盖层，规格见 `docs/conventions/agent-workbench.md` 第 0/2 期；**不**把本文件的树并进科研 `workspaces` 表 |

---

## Overview

编程页今天已经能从基准拉出「新分支 + 独立工作树」、fetch/push/pull、本地合并进基准、在终端改动面板里暂存/逐 hunk/提交。用户仍然觉得「没有从 main 建分支」，GitHub Desktop 看不到 Agent 的改动，页上也不知道仓库有没有连上远程。根因不是缺 `git branch`，而是 **心智模型与外部工具绑的是「一个文件夹的当前检出」**，而 Mesa 用的是 **共享 `.git` 的多工作副本**。

本设计把编程页收成一条职业级、但刻意不做成 Git 客户端的闭环：

**从基准拉分支并开工 → Agent 只在该工作树目录里改 → 改动面板提交 → 推到远程 → 用 `gh --web` 或 compare URL 开 PR。**

提交与第一次 `push -u` 发生在 **`GitPanel`（`git_commit` / `git_push`）**，不是项目页那组「拉取·推送」。项目页负责工作树生命周期、远程身份、以及「打开 Pull Request」常驻入口。次路径：把远程上已有的分支检出为一棵工作树继续。GitHub Desktop / 访达始终作为外部工具：Mesa 只把 **那一棵工作树的绝对路径** 交给 **文档化的 `github` CLI**（不是已删除的 URL 协议，也不是 Windows 下给 exe 传路径）。

---

## Background & Motivation

### 当前实现（2026-09-03 快照；命令注册表现以本节开头 2026-10-26 核对清单为准——origin URL / PR / Desktop 三缺口已由 `coding_add_origin` / `coding_open_pr` / `coding_open_desktop` 落地）

后端单一入口 `src-tauri/src/coding.rs`，命令在 `src-tauri/src/lib.rs` 注册：`coding_overview` / `coding_create_worktree` / `coding_remove_worktree` / `coding_fetch` / `coding_pull` / `coding_push` / `coding_merge_into_base` / `coding_delete_branch` / `coding_add_origin` / `coding_open_desktop` / `coding_open_pr` / `coding_upsert_lane`，另有 `git_is_repo`（2026-10-26 核对）。科研工作区（`workspaces.rs` 的 `ccode/<name>` 分支、端口、TASK.md、评审 PR）保持另一条库，禁止合并。

现有写命令全部是 `Result<String, String>`（或 `Result<CodingWorktreeDto, String>`）。前端已有用 `msg.includes("未合入")` 探测字符串的先例（删分支），**v1 新写操作不再扩这种通道**。

| 能力 | 实现要点 |
|---|---|
| 工作树事实来源 | `git worktree list --porcelain`（`parse_worktree_list`） |
| 本地分支 | `for-each-ref refs/heads`，**不读 `refs/remotes`** |
| 基准 | `workspaces::detect_base_branch`：`origin/HEAD` → `origin/main\|master` → 本地 `main\|master` → 当前 HEAD |
| 新建 | `create_at`：本地 **已有** 该分支 → `worktree add <dest> <branch>`（**静默挂载，不从基准建新线**）；否则 `worktree add -b <branch> <dest> <base>`。落点 `~/ccode/worktrees/<repoName>/<sanitize 后的分支路径>` |
| 推送（项目页） | `coding_push`：先 `push`，stderr 含 `no upstream` / `set-upstream` 时重试 `push -u origin <HEAD>` |
| 推送（改动面板，主路径真实入口） | `GitPanel` → `git_commit`（可选连带 push）/ `git_push`；`git_info::do_push` 同样无上游时 `push -u origin`。用户提交后停在终端，**不会**回到项目页点「推送」 |
| 拉取 | **仅** `pull --ff-only` |
| 合并 | 合进 **已检出基准的那棵工作树**；基准脏则拒；找不到 `is_base` 工作树时现文案是「请先把主仓切回 {base}，或为基准分支建一棵工作树」（**第一条与 v1 不切主仓检出打架**） |
| 空仓 | `ensure_initial_commit` **只在 `create_at` 里调用**；返回值被 `let _ =` 丢掉。`overview_at` **每次**写死 `created_initial_commit: false`。前端 `initNote` 读 overview 旗标，**实际上不会亮** |
| 取消合并 | 项目页走 `git_abort_merge`（`GitPanel` 同源）；`coding_abort_merge` 已按下方清理待办删除，只留一条 |
| 远程身份 | **DTO 无 origin URL、无远程分支、无 PR、无 gh、无 Desktop** |

前端 `src/components/CodingProjectView.tsx`（v3.190）：左工作树右会话。主 CTA 文案是「**创建工作树**」，placeholder `feature/login`。工作树行：进入 / 查看改动 / 拉取·推送 / `⋯`（fetch、复制路径、`revealItemInDir`、删除）。芯片来自 `codingFactChips`（`src/work-mode.ts`）：仅 `key/label/tone`，无 `tip`；`↑N` / `↓N` / 未推送 / 无上游。`FactChips` 只渲染 span。

改动面板 `GitPanel.tsx` + `git_info.rs`：按 **标签 cwd** 轮询 porcelain，ahead/behind 相对 **上游**；含暂存、逐 hunk、提交、`git_push`。`GitCommitResultDto` 已有 `committed/pushed/failedPhase`。项目页不得再做第二套提交 UI。

**改动面板收口（2026-10-23 用户：diff 查看器怎么完善）**：①`workspace_diff` / `workspace_file_diff` 的「Run 评审」回落只认 `git worktree add` 出来的树（`is_linked_worktree`）——项目里开的聊天也登记 Run（隔离路径 = 项目根），只按路径找 Run 会把主仓面板误当 Run 评审（头部「相对主分支 HEAD」、勾选框消失、提交数对不上，本机实测 28 条 Ccode 交互 Run 命中）；非 git 目录也不再白读全部 Run。②diff 长行折行、前缀悬挂（不再每块一条横向滚动条）；块头写「第 N 行 · 上下文」，git 原样 `@@` 放悬停；成对删加行标出改动段（`diff-intraline.ts`，去同头同尾、改动超七成不标、条数不等不配）。③「提交并推送」改次要描边钮，去掉绿色渐变——推送是往外发的那一步，不当默认动作，「提交」保持唯一实心主钮。④Run 隔离树基准为 HEAD 时头部写「未提交的改动」；工作区模式提交行写「这次提交 N 个未提交的文件」（列表是累计改动，两数不同是正常的）。⑤窄栏（面板 < 640px，`SPLIT_MIN_WIDTH`，ResizeObserver 量自己）diff 在文件行下面就地展开、往下滑看，不切成右侧文件列（窄了两栏都看不下，同日用户）；够宽才主从分栏，右侧文件列可收起（文件头 PanelRightClose / Open，记 `ccode.gitPanel.listCollapsed`）。⑥状态栏「提交…」的门只拦 Agent **正在干活**（attention working / confirm），不拦进程开着——原先按 `running`（进程活着）拦，开着对话就永远提交不了（同日用户截图）。⑦改动面板 `git_status` 与 `workspace_diff` 并发查，切标签 / 接着聊时分支与改动第一时间出来。⑧聊天变体底栏的 git 只留「分支 + 增删」一项（点开改动面板），文件数、↑↓ 进悬停，**不放「提交…」与提交设置**——聊天层管对话，提交只在改动面板一处做；终端变体的提交胶囊保留（同日用户：这些信息都要放在聊天层吗）。

### 三个真实痛点

**Pain A — 「没有从主分支创建分支」。**  
`create_at` 在分支名尚不存在时已经从 `detect_base_branch()` 的 main/master 拉新分支。用户来自 GitHub / GitHub Desktop，词汇是「New branch from main」，不是「工作树」。主按钮叫「创建工作树」。**同名本地分支会静默挂载**，改文案成「从 main 开工」而不改后端会骗人。另外合法开工方式（挂已有本地分支、挂 `origin/foo`）没有入口。无目录的裸分支不该做——Agent 需要 cwd。

**Pain B — 与远程脱节。**  
典型仓：`origin = git@github.com:org/repo.git` 或 HTTPS。页上不显示 origin、不知道 `gh` 是否登录、push 第一次 `-u` 没有人话、push 之后没有开 PR 的下一步。`coding_fetch` 藏在 `⋯` 且标签仍是英文 `fetch`。远程-only 分支无法「检出为工作树」。非 GitHub 远程（Gitee/GitLab）仍应能 fetch/push，但不能把所有远程都叫「GitHub」。

**Pain C — GitHub Desktop 只显示它打开的那个文件夹的当前检出。**  
这是 Desktop 的正确行为，不是 Mesa 的 bug：

- Desktop 绑定 **一份工作副本**。该文件夹里的 `git status` = 那一份的 HEAD。
- Agent 写在 `~/ccode/worktrees/<仓>/feature/login`，与主仓共享 `.git`，但是 **第二份工作副本**。
- 用户若把 Desktop 开在项目根（主仓仍在 `master` 且干净），Agent 的文件不可见。
- 若把功能分支 **检出到主仓文件夹**，Desktop 能看见——同时第二个 Agent / 主线工作会撞车。这正是 v3.179 选择 worktree 的原因。

Mesa 不得去改 GitHub Desktop 内部 LevelDB，也不得取代它。正确动作是：用 **Desktop 文档化的 CLI** 打开 **那一棵工作树路径**，并在可点击入口旁用一句话说清。

当前 Desktop 源码（desktop/desktop `parse-app-url.ts`，development）只处理 `oauth` 与 `openrepo`（远程 GitHub URL）。`openLocalRepo` 已从 **URL 协议处理器** 删除（desktop#19733）：网页暴露面缩小后，本机打开只走 CLI。`x-github-client://openLocalRepo/...` 仍可能把 Desktop **启动起来**，但动作被当成 unknown **静默忽略**——比 fail-loud 更糟。Windows 把路径传给 `GitHubDesktop.exe` **不会切换仓库**（desktop#8646），只会打开上次的仓库（通常是主仓），正好强化 Pain C。

---

## 验收版本与补账（2026-09-10）

- 新合并必须带已审 SHA，Git 只合并该提交；基准在另一工作树检出时，接受版本取那棵基准树的 HEAD，禁止改项目根检出。
- 补账只重放原接受凭证；不重新计算最新 HEAD/diff，不把工作分支后来增加的提交一起合并。无可信凭证时明示缺失，不伪造历史。
- 已合并后的补账不要求基准目录再次干净；真正新合并仍保护用户改动。仅未跟踪的验收账本/锁不计入阻塞改动，已跟踪文件照常处理。

## Goals & Non-Goals

### Goals（v1）

1. 心智模型一条带：主仓 · 基准分支 · 远程 · 工作树 = 给 Agent 的独立目录。
2. 主路径：**从基准拉出新分支并建工作树**。按钮文案「从 &lt;base&gt; 开工」与 `fromBase` fail-loud **同一 PR 落地**（不得先改文案、后端仍静默 attach）。
3. 次路径：为已有本地分支、已有远程分支各建一棵工作树；已占用分支禁用。
4. 远程身份：origin 缩略（文案按 `hostKind` 分支）、fetch 人话、首次 `push -u` 人话、相对上游的领先/落后（今天 `upstream_unpushed` 丢掉了 `@{u}` 的 behind）。
5. 按工作树路径用 `github` CLI 打开 GitHub Desktop；访达继续 `revealItemInDir`。
6. 「打开 Pull Request」常驻在 **github.com + 已有上游** 的工作树卡上；终端 `GitPanel` 经可选 `onOpenPr` 露出同一动作，门控用 `coding_overview.worktrees[].path`（含 `~/ccode/worktrees/…`），**不是** `pathWithin(cwd, project.path)`。算法见 §9。
7. 提交/hunk 继续只在终端改动面板。
8. 保护基准：主仓在基准上时，「进入」先警告；基准无处检出时 **给基准建工作树**，不切主仓。

### Non-Goals

- 不做任意 git 命令框（v3.179 硬约束）。
- 不做 GitHub 客户端：Issues、Actions、PR 评论、Fork sync、CI 灯。
- 不取代 GitHub Desktop，不解析其仓库数据库，不走已删除的 `openLocalRepo` 协议，Windows **不**给 `GitHubDesktop.exe` 传路径。
- 不把编程项目并进科研 `workspaces` 表。
- v1 不切主仓检出（不在主文件夹上 `checkout` 功能分支或切回基准）。基准不在任何工作树时，恢复路径是 `source=local` 给基准建树。
- v1 不提供「只建分支、不建工作树」。
- v1 不引入应用内 GitHub OAuth；认证继续用本机 `git` / `gh`。
- v1 不改 `pull --ff-only` 为 rebase/merge pull。
- v1 不做第二远程编辑；overview 只下发 `origin`，不下发 `remotes[]`。
- 永不做：交互 rebase GUI、cherry-pick 文件选择器、submodule 管理器、LFS UI、git-crypt。

---

## Proposed Design

### 1. 对象模型

编程页操作的是 **一个 git 对象库 + 多份工作副本**，不是「一个文件夹里切分支」。

```mermaid
flowchart TB
  subgraph repo ["git 对象库（主仓 .git，被所有工作树共享）"]
    objects["commits / trees / blobs"]
    heads["refs/heads/*"]
    remotes["refs/remotes/origin/*"]
  end

  origin["origin\ngithub.com/org/repo 或其它 host"]
  remotes --- origin

  subgraph copies ["工作副本（各有独立索引与工作区文件）"]
    primary["主仓文件夹\n例: ~/Documents/网页设计\nHEAD = main\nisPrimary"]
    feature["功能工作树\n~/ccode/worktrees/网页设计/feature/login\nHEAD = feature/login"]
    other["其它工作树\n…/hotfix"]
  end

  objects --- primary
  objects --- feature
  objects --- other
  heads --- primary
  heads --- feature

  agent["Agent 终端 cwd = 功能工作树"]
  feature --> agent

  desktop["GitHub Desktop\n只看见被打开的那一份副本的 HEAD"]
  primary -.->|"用户若打开主仓：只见 main，干净"| desktop
  feature -->|"github CLI: github + 工作树绝对路径"| desktop
```

术语（界面白话，标识符保持英文）：

| 界面 | 标识符 | 含义 |
|---|---|---|
| 主仓 | `isPrimary` | `path_key(worktree.path) == path_key(repoPath)` 的那一份，通常是用户打开 Desktop / Finder 的文件夹 |
| 基准 | `baseBranch` / `isBase` | `detect_base_branch` 的结果，默认合入目标 |
| 远程 | `origin` | `git remote get-url origin`；没有则「还没连上远程」 |
| 工作树 | `CodingWorktreeDto` | Agent 的 cwd；新树落 `~/ccode/worktrees/<仓>/<分支路径>` |
| 未检出 | 分支行 `worktreePath == null` | 本地有引用、没有目录，不能开 Agent |

### 2. 主路径与次路径

```mermaid
sequenceDiagram
  actor User
  participant Page as CodingProjectView
  participant Rust as coding.rs
  participant Git as git
  participant Panel as GitPanel
  participant GH as GitHub / gh

  User->>Page: 填 feature/login，点「从 main 开工」
  Page->>Rust: coding_create_worktree source=FromBase
  alt 本地已有同名分支
    Rust-->>Page: ok=false code=branch_exists
    Page->>User: 改为给它建工作树？
  else 新分支
    Rust->>Git: worktree add -b feature/login dest main
    Note over Git: dest = ~/ccode/worktrees/<仓>/feature/login<br/>主仓 HEAD 仍是 main
  end
  User->>Page: 进入
  Note over User,Panel: 终端 cwd = 工作树；提交发生在 GitPanel
  User->>Panel: 勾选 / hunk / 提交（可选连带推送）
  Panel->>Git: git_commit / git_push（无上游则 -u origin）
  Note over Panel: 仅 TerminalPage 在 coding 工作树传入 onOpenPr 时<br/>toast 才有「打开 Pull Request」
  Panel->>User: toast「推送成功」（可选 PR 动作）
  User->>Page: 或点工作树卡常驻「打开 Pull Request」
  Page->>Rust: coding_open_pr(repo_path, cwd)
  alt gh 已登录
    Rust->>GH: gh pr view --web 否则 gh pr create --web
  else 无 gh / 未登录
    Panel->>GH: 前端 openUrl compare URL
  end
```

次路径：CTA 下方「从已有分支开工」→ 列出 **未被任何工作树占用** 的本地分支 + `origin/*` 尚无本地指针的分支 → `worktree add`（远程见 §6 argv）。已占用行禁用。

### 3. 为什么 Desktop 看不见 Agent（一等公民，不是脚注）

```mermaid
flowchart LR
  subgraph folderA ["Desktop 打开的文件夹 = 主仓"]
    Afiles["工作区文件 = main 的树"]
    Ahead["HEAD = main"]
  end
  subgraph folderB ["Agent 正在写的文件夹 = 工作树"]
    Bfiles["工作区文件 = feature/login 的树 + 未提交"]
    Bhead["HEAD = feature/login"]
  end
  gitdir[".git 对象库（共享）"]
  folderA --- gitdir
  folderB --- gitdir
  Desktop["GitHub Desktop"] -->|git status -C 主仓| Afiles
  Desktop -.->|不会自动扫其它 worktree| Bfiles
```

界面约束（`docs/conventions/design-system.md`：一个操作最多一句话，≤20 字左右）：

- 可点击的 Desktop 入口落地时（PR 4），非主仓路径行 **一句**：`用 GitHub Desktop 打开这一目录`（16 字）。主仓不写。
- 主仓卡片若 `isBase`：「进入」时用 `confirmDialog` 警告。
- 不在身份段写「为什么用 worktree」。
- **PR 1 不上这句文案**（当时还没有可点击入口，预告句会变成无法执行的操作指导）。

### 4. 界面：一条主路径，控件分级不变

**展示收口（2026-09-11，优先于下方 v1 布局草案）：**

- 工作树为主、未检出分支为辅（2026-10-18 起同在分支地图里，见下）；主仓常态两行，进入用文字 ghost，查看改动/拉取/推送进 ⋯，基准保护确认不变。只在 `isBase` 为真时标基准。
- 功能工作树保留「进入」次按钮与改动/拉取/推送图标；GitHub PR 入口仍常显并按上游状态禁用。目录与最近提交时间同一行，复制路径/Desktop/分组/再开一条进 ⋯；顶部不再重复 ＋。
- Agent 运行状态独立展示（无活 Agent = 空闲）；Git 基准差异写「比 <基准> 领先 N · 落后 M 个提交」（2026-10-18 起取代短条 + 多/少），文件未提交与远程提交数用图标 + 文字，不用孤立状态点/裸数字。`hasUpstream=false` 只表示未关联远程分支，不能推断没有推送过或远程没有同名分支。
- **分支地图（2026-10-18）**：工作树与本地分支合成一棵以基准为根的树（`arrangeBranchMap`，`src/coding-lanes.ts`）。根 = 检出基准的那棵树；基准未检出时根是轻行并带「建工作树」（= 下文身份段「为 &lt;base&gt; 建工作树」与「主仓不在基准」芯片的新位置）。已检出分支只出现在它的工作树卡上；未检出的收在末尾「未检出的分支 N」折叠头下（≤3 默认展开），保留状态与建工作树入口。「合并进 &lt;base&gt;」在工作树卡 ⋯ 与未检出行 ⋯；删除分支只在未检出行（有树的先删树）。原合并/删除/冲突入口与安全确认不变。视觉规格见 design-system.md。

v3.190 的按钮层级保留：主色只留给「从基准开工」（**该文案随 PR 3 与后端 fail-loud 一起改**；PR 1 期间按钮仍叫「创建工作树」），进入次级，查看改动 ghost，拉取/推送组合，危险进 `⋯`。同屏仍最多两条横向带（身份一行 + 列表块）。不造身份仪表盘、不用彩色 emoji。

**身份段溢出策略：** 现有已是路径行 + pill/基准/状态/刷新。远程缩略与动作挤进 **同一行右簇**，不另起第三带。

```
网页设计
~/Documents/网页设计                    [复制] [显示]
编程 · 基准 main · org/repo · 3 个工作树 · 1 个待合并
                              [从 GitHub 更新][刷新]
```

- 远程缩略过长时身份段只显示 `org/repo`（`hostKind==github`）或 host 后的 path 尾段（`other`）；完整 `display` / 剥过 userinfo 的 URL 放 HoverTip，点击复制 URL。
- 「从 GitHub 更新」与「刷新」**共用右簇**（`ml-auto` 一组），窄宽度优先缩远程字，不折成第三行。
- 文案按 `hostKind`：

| 条件 | 身份缩略 | 更新按钮 | 无远程 |
|---|---|---|---|
| 无 origin | — | 隐藏 | `还没连上远程` + ghost「连接远程」 |
| `hostKind==github` | `org/repo`（前缀 GitHub 可省略以省宽） | `从 GitHub 更新` | — |
| `hostKind==other` | `display`（如 `gitlab.com/g/r`） | `从远程更新` | — |

- 「更新」= 现有 `coding_fetch`（`fetch --all --prune`）；与「刷新」（只重读本地）分开。
- 不在身份段解释 Desktop。
- 没有任何工作树 `isBase` 时，给出「为 &lt;base&gt; 建工作树」（`source=local`，主仓不动）。这是合并与「主仓不在基准」的 **唯一恢复路径**。2026-10-18 起它不在身份段，而是分支地图根行（基准未检出）上的「建工作树」。

**主 CTA（PR 3 才替换「创建工作树」）：**

```
[ feature/login          ]  [从 main 开工]
从已有分支开工
```

- 按钮文案用当前 `baseBranch`：`从 main 开工` / `从 master 开工`。
- 输入框 `aria-label`：`新分支名（从基准拉出）`。placeholder 仍 `feature/login`。
- 输入框下 **最多一句**：`从基准拉出新分支，在独立目录里给 Agent 改。`
- 「从已有分支开工」是文字按钮，打开小选择层。选择层不是第二主 CTA。

**行为收口（有意不同于今天的静默挂载）：**  
主 CTA 语义 = **一定从基准建新分支**。`refs/heads/<branch>` 已存在 → `ok=false, code=branch_exists`，人话「本地已有 feature/login。改为给它建工作树？」。确认后 `source=Local`。不得在「从 main 开工」文案下静默 attach。

**工作树卡：**

| 位置 | 内容 |
|---|---|
| 标题 | `主仓` / `工作树` + 分支名（现有 `BranchLabel`） |
| 主操作 | 进入 / 查看改动 / 拉取·推送 / `⋯`（冲突行仍是「去解决」） |
| 芯片 | 见 §5 |
| 路径行 | 相对时间 · 缩略路径 · PathActions（复制 / 显示）· Desktop 按钮（PR 4） |
| Desktop 按钮 | lucide `AppWindow`（不要 `Github` 品牌标），`aria-label="在 GitHub Desktop 打开"` |
| 一句 | 仅非主仓且 PR 4 已可点：`用 GitHub Desktop 打开这一目录` |
| PR | `hostKind==github && hasUpstream`：ghost「打开 Pull Request」常驻卡上（不进 `⋯`、不依赖刚推送的 toast）。`!hasUpstream`：同一按钮 **禁用**，HoverTip「先推送才能开 PR」。非 github 或无 origin：**不渲染** |

`⋯` 收敛：取消合并（仅冲突，invoke `git_abort_merge`，**不用** `coding_abort_merge`）、删除工作树（非主仓）。复制/显示从 `⋯` 挪到路径行。fetch 升到身份段后，行内 `⋯` 不再放 fetch。~~删除未使用的 `coding_abort_merge` 命令（或令其转调 `git_abort_merge` 后去掉重复注册）在落地 PR 里一并做，项目页与改动面板只留一条~~（✅ 已删，2026-10-26 核对：lib.rs 已无该注册）。

**推送按钮 `title`（项目页组合钮，次要入口）：**

- `hasUpstream == false`：`第一次会推到 origin 并设上游`
- 已有上游：`推送到 origin/<branch>`

**拉取失败（非快进）人话：**  
`无法快进拉取。进入终端，在改动面板处理后再试。` `code=ff_only`。不在项目页提供 rebase/merge pull。

**分支列表：** 保留。未挂工作树的行增加 ghost「建工作树」（= `source=Local`）。已挂工作树的分支不出现该按钮。远程-only 不进这个本地列表，进「从已有分支开工」选择层。

### 5. 芯片：相对基准 vs 相对远程

今天 `overview_at`：

- `ahead` / `behind` = `rev-list --left-right --count <base>...HEAD`（**相对基准**）
- `unpushed` = `@{u}...HEAD` 的右侧计数；**左侧 behind 被丢掉**（`upstream_unpushed` 里 `_behind_up` 未使用）
- 改动面板 `GitPanel` 的 ahead/behind 则是 porcelain **相对上游**

同一屏幕两套坐标，芯片还写成 `↑2`，Desktop 用户会读成「比 GitHub 超前 2」。

`CodingFactChip` 增加 `tip: string`。`codingFactChips` 签名：

```ts
export interface CodingFactChip {
  key: string;
  label: string;
  tone: CodingFactTone;
  tip: string;
}

export function codingFactChips(facts: {
  dirty: boolean;
  dirtyCount?: number | null;
  ahead: number;
  behind: number;
  unpushed: number;
  hasUpstream: boolean;
  upstreamBehind?: number;
  baseBranch: string;
  hostKind?: "github" | "other" | null;
}): CodingFactChip[]
```

- `upstreamBehind` 缺省当 0（PR 1 可先于 overview 字段落地）。
- `hostKind==="github"` 时 tip 用「GitHub」，否则用「远程」（PR 1 尚无 origin 时传 `null` →「远程」）。
- `FactChips` 用 `HoverTip` 渲染 `chip.tip`，**禁止** WKWebView `title`。
- `tests/work-mode.test.ts` 锁 **label 和 tip**。

| key | 条件 | 标签 | tip（`hostKind==github` / 其它） |
|---|---|---|---|
| `dirty` | dirty | `N 个文件未提交` / `有未提交改动` | `N 个文件有未提交改动` / `有未提交的改动` |
| 基准短条 | ahead>0 / behind>0 | `比 <base> 多 N 个提交` / `比 <base> 少 N 个提交` / 两者同显 | 相对基准的差异，不是远程同步数量 |
| `remote` | !hasUpstream | `未关联远程分支` | 未设置上游不代表远程没有同名分支；首次推送尝试关联 origin |
| `remote` | unpushed>0 | `N 个提交待推送` | `未推送：比 GitHub 上该分支多 N 个提交` / `未推送：比远程该分支多 N 个提交` |
| `upstreamBehind` | upstreamBehind>0 | `GitHub有 N 个新提交` / `远程有 N 个新提交` | `GitHub 上该分支有 N 个新提交，可拉取` / `远程该分支有 N 个新提交，可拉取` |

`deriveCodingKind` 的坐标 **保持相对基准**（`behind>0 → 需同步`，`ahead>0 → 等待合并`）。不要改成相对 origin，否则「已推送但未合入 main」会从「等待合并」掉成「未开始」。

### 6. 创建工作树的三种 source

全部落在 `coding.rs`，继续 `git_long` + `check-ref-format` + `default_worktree_path` + 失败 `remove_dir_all`。

```rust
#[derive(Deserialize, Default)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CreateWorktreeSource {
    #[default]
    FromBase,
    Local,
    Remote { remote: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorktreeReq {
    pub repo_path: String,
    pub branch: String,
    #[serde(default)]
    pub source: CreateWorktreeSource,
}
```

缺省 `FromBase`。未知 `kind`：反序列化失败，命令返回 `Err`，人话「开工方式无法识别」（不要静默当 FromBase）。`Remote.remote` 空则默认 `"origin"`。

写命令返回 `CodingOpDto`（见 API）。成功时填 **`worktree`**（`CodingWorktreeDto`）+ **`createdInitialCommit`**（`ensure_initial_commit` 的真实返回值，不再 `let _ =`）。不要另造 `data` 字段。

| source | git argv（写死） | 前置 |
|---|---|---|
| `FromBase` | `worktree add -b <branch> -- <dest> <base>` | 本地 `refs/heads/<branch>` 必须不存在；存在 → `code=branch_exists`，前端确认后改 `Local` |
| `Local` | `worktree add -- <dest> <branch>` | 本地必须存在；已被任一 worktree 占用 → `code=worktree_busy`，人话「已在 &lt;路径&gt; 检出」 |
| `Remote` | ① `fetch -- <remote> refs/heads/<branch>:refs/remotes/<remote>/<branch>`（不要每次 `--all`）② `worktree add --track -b <branch> -- <dest> <remote>/<branch>` | 本地 **同名已存在**：不要静默改 Local、不要重置。返回 `code=branch_exists`，人话「本地已有 foo，给它建工作树？（不会重置成 origin/foo）」。确认后走 `Local`。远程 ref fetch 失败：`failedPhase="fetch"`，不建树 |

**明确不做：** `git checkout -b` 在主仓上建分支；只建 ref 不建目录。

选择层数据来自 `remoteBranches`（`for-each-ref refs/remotes`，去掉 `*/HEAD`）+ 本地未占用分支。

- 展示名 `origin/foo`，内部 `name=foo`。
- **已挂工作树的分支不进入选择层可点集合**：`occupiedPath != null` 的行禁用，HoverTip `已在 <缩略路径> 检出`。
- 远程列表 UI **上限 200** + 本地过滤输入；DTO 可返回全量，但选择层必须可搜、默认先渲染 200。短查询仍 20s。
- 远程「已有本地」且未占用：点下去走与 `branch_exists` 相同确认，然后 `Local`。

### 7. 远程身份与「连接远程」表单

overview 增加只读 `origin: CodingRemoteDto | null`（git 配置，不含密钥；URL 出站剥 userinfo）：

```text
git remote get-url origin
git for-each-ref refs/remotes
```

v1 **不下发** `remotes[]`（没有第二远程 UI，少测一个字段）。

无 origin 时身份段 CTA「连接远程」打开窄弹层（约 500px，唯一主按钮「添加」）：

- 字段：远程 URL（必填）；远程名固定 `origin`
- 提交走 `coding_add_origin(repo_path, url)` → `git remote add -- origin <url>`，然后 `fetch --all --prune`
- 阶段：add 成功、fetch 失败 → `ok=false, code=git_failed, failedPhase="fetch"`。**origin 保留**，UI 只重试 fetch（`coding_fetch`），不显示「添加失败」、**不** `remote remove`。其它 git 失败（目录已存在、磁盘、非 `worktree_busy` 的 stderr）同样 `code=git_failed`，`message` = 已脱敏 stderr。
- 已有 origin：表单不出现；改 URL 请到终端。

含 userinfo（`user:token@`）：先 `confirmDialog`「URL 含密码，会写入 .git/config。仍要添加？」；取消则不写。DTO 出站剥 userinfo。git/gh stderr 出站前过 `redact_sensitive_text`（`coding.rs` 今天没有，落地时补上）。

合法 / 非法与 `hostKind` 见 Security。Gitee / GitLab **可以** add/fetch/push；PR / compare / 「打开 Pull Request」/「从 GitHub 更新」仅 `hostKind==github`（host **大小写不敏感精确等于** `github.com` 或 `ssh.github.com`）。`www.github.com`、`gist.github.com`、`github.com.evil.com` 均为 `other`。自建 GitHub Enterprise 第一版不做。

### 8. 打开这一份工作副本

**访达 / 资源管理器 / 文件管理器：** 继续前端 `revealItemInDir`。

**GitHub Desktop：** `coding_open_desktop(repo_path, path)`，**只走 Rust**（对齐 `fs_tree::open_in_system`：不给 WebView `opener:allow-open-path`，也 **不** 申请 `x-github-client://` 的 opener 权限）。

门槛（前端 overview 缓存 **不算** 已校验）：

1. `canonicalize_plain` + `strip_verbatim`
2. 对 **现场** `git worktree list`（或 `overview_at`）做 `paths::same_path`，`path` 必须是 **该 `repo_path`** 的一棵 worktree
3. 按下面顺序尝试；命令返回实际用了哪一档；失败列出已尝试项。

探测顺序（v1 **没有** URL 协议，**没有** Windows `GitHubDesktop.exe <path>`，**不对 `github` 二进制传 `--cli-open`**，**不跑 `github --help`**）：

1. `agents::resolve_binary("github")`，没有则用应用捆绑的 CLI（macOS：`GitHub Desktop.app/Contents/Resources/app/static/github.sh`，不必先在 Desktop 菜单里「Install Command Line Tool」）。候选目录另加 Windows `%LOCALAPPDATA%\GitHubDesktop\bin`。argv **锁死**为 `[absPath]`。**不要**把 `--cli-open=` 交给 `github` / `github.bat` / `github.sh`（那是 Desktop **应用**的内部参数；CLI 自己会转）。
2. macOS 捆绑 CLI 也没有：`open -n <GitHub Desktop.app 绝对路径> --args --cli-open=<abs>`（与官方 `cli.js` 同款）。**不要** `open -a "GitHub Desktop"` 且不加 `-n`：已在运行时只激活窗口，`--args` 被丢掉，看起来「跳进软件但没切仓库」。**不要** `open -a GitHub Desktop <path>`。
3. Windows：找不到 `github` → fail-loud `请在 GitHub Desktop 菜单里安装命令行工具，再打开这一棵工作树。` **不要**启动 `GitHubDesktop.exe` 并传路径。
4. Linux：官方没有 Desktop。不探测第三方 fork。`Linux 没有官方 GitHub Desktop。请用「显示」打开这个目录，或继续用 Mesa 改动面板。`

成功标准：

- `github` CLI：**退出码 0** 即 `ok`（官方入口；不声称能证实 Desktop UI 已切到那棵树）。
- `open -a`：**best-effort**。`open` 成功只表示应用被拉起；旧版 Desktop 可能忽略未知 `--args`。不得把「进程启动了」当成「已经打开该工作树」。若用户反馈没切过去，人话仍引导安装/使用 CLI。macOS 连 `open -a` 也失败：`没有 GitHub Desktop。安装后用命令行工具打开这一棵工作树，不要打开主仓文件夹。`

`github.bat` / `.cmd`：走 `process::background_command`（Windows `CREATE_NO_WINDOW`）。**短超时 8–20s**，只看 spawn + 退出码（`github /PATH` 正常立刻返回）。GUI 子进程由 Desktop 自己拉起。不要把「可见 GUI 例外」套到 bat 上。`open -a` 同样短超时。**不要**用 `git_long`（60–120s）跑 CLI。

返回 `CodingOpDto`：`ok`、失败 `code=desktop_missing`、`method: "github-cli" | "macos-open"`、`tried: string[]`。

**禁止：** 写 Desktop 的 LevelDB；`x-github-client://openLocalRepo`；Windows exe+路径。打开后 Desktop 自己可能询问是否加入列表，这就够。

VS Code / Cursor：**later**。v1 不散落第三颗图标。

### 9. 「打开 Pull Request」（最小 GitHub 环）

不把科研 `workspaces::pr_impl` / `create_pr` 接到编程页：那条链绑工作区 id、会再 `push -u`、用 `--title/--body` 直接建 PR。编程页标题应在浏览器里填。

**入口（不要只挂在项目页 `coding_push` toast 上）：**

1. 工作树卡（编码页）：`origin.hostKind==github && hasUpstream` 常驻 ghost「打开 Pull Request」；`!hasUpstream` 禁用（禁止生成会 404 的 compare URL）；非 github / 无 origin 不渲染。
2. 编程工作树的终端 `GitPanel`：见下方门控。用户提交后停在终端，必须能在这里点。
3. 项目页 `coding_push` 成功后同样可点，但是 **第三入口**，不是主路径。

**GitPanel 不要自己知道 GitHub。** 它是终端/会话共享件（`cwd` only；科研工作区、普通仓、SessionsPage 只读同一块）。科研已有 `workspaces::create_pr`；编程工作树在面板里是普通仓视图（`inWorkspace` 只标科研 worktree），不能用它区分。

```ts
// GitPanel.tsx — 可选；缺省不渲染 PR 动作
onOpenPr?: (cwd: string) => void
```

**前端何时传入 `onOpenPr`（锁死，与 `WorkbenchPage` 的 `codingByPath[p.path].worktrees` 同源）：**

功能工作树在 `~/ccode/worktrees/<仓>/<分支>`，**不在**注册项目根下面。`pathWithin(cwd, project.path)` 对「进入 → 终端提交」这条主路径 **恒为假**，禁止当主公式。`CodingProjectView` 的本地 `extraRoots` **不**在 `TerminalPage`，终端不得依赖它。

```ts
// src/coding-git.ts — isWindows 显式入参；单测覆盖主仓 + ~/ccode/worktrees/feature/login
export function cwdIsCodingWorktree(
  cwd: string,
  overviews: ReadonlyArray<{ worktrees: ReadonlyArray<{ path: string }> }>,
  isWindows: boolean,
): boolean {
  const extraRoots = overviews.flatMap((ov) => ov.worktrees.map((w) => w.path));
  // extraRoots 含主仓路径与 ~/ccode/worktrees/…，与 WorkbenchPage extraRoots 同口径
  return extraRoots.some(
    (root) => samePath(cwd, root, isWindows) || pathWithin(cwd, root, isWindows),
  );
}
```

`TerminalPage` **自己** 对每个已注册且 `work_mode===coding` 的项目 `invoke("coding_overview", { repoPath: p.path })`（可缓存；可复用 `prefetchCodingOverview`，与 `WorkbenchPage` 的 `codingByPath` 同源）。**科研 `list_workspaces` 的 worktreePath 不得进入这张表。** SessionsPage、未注册普通仓不拉 overview、不传回调。

传入时：`onOpenPr={(cwd) => invoke("coding_open_pr", { repoPath: cwd, cwd })}`（后端允许 `repo_path === cwd`）。GitPanel 不 import 该命令。

两种 push 的 `-u` 重试已经分叉（`coding_push` vs `do_push`），**PR 后续只走 `coding_open_pr`**，不再分叉。

`coding_open_pr(repo_path, cwd)`：

- 编码页传入项目根 `repoPath` + 工作树 `cwd`。
- GitPanel/终端往往只有 cwd：允许 **`repo_path` 等于 `cwd`**。后端 **不要** 把 `rev-parse --show-toplevel` 当成主仓（在工作树里它就是**该工作树根**）。
- 后端：canonicalize `cwd`；从该 git **现场** `git worktree list`，`cwd` 必须是列表中一员（`same_path`）；origin **现场** `git remote get-url`，走与 `abbrevGitRemoteUrl` **同一解析器**。`github.com.evil.com` 解析为 `hostKind=other`，入口走 `not_github`，不是 `invalid_url`。
- 不得把前端缓存的 URL 拿来拼 compare。

锁死算法：

1. 无 origin 或 `hostKind != github` → 不显示入口；若仍被调用 → `code=not_github` / `no_origin`。
2. `!hasUpstream` → 入口禁用；调用 → `code=no_upstream`，**禁止** compare URL。
3. 入口点下去立刻「打开中…」（禁用防连点）。不先跑 `gh auth status`（会空等数秒，点完像没反应）。
4. 有 `gh` 时短超时（5s）试 `gh pr view --web`（已有 PR 则 gh 自己开浏览器）。失败或未安装 → 立刻返回 `method="compare-url"`，前端 `openUrl`。不再等 `pr create --web`（比较页即可创建）。
5. `githubCompareUrl`：host 仅 `github.com`；path 用解析出的 `owner/repo`；`base`/`head` **按路径分段 encode**（单测 `feature/login`、含 `#` 的畸形名）。https 由前端 `openUrl`（`opener:default` 已放行 https）。Desktop 自定义协议不要走前端 opener。

不在 overview 里跑 `gh`。

### 10. 保护基准与「基准无处检出」

`进入` 在 `w.isPrimary && w.isBase` 时弹 `confirmDialog`：

> 主仓正停在基准分支上。Agent 会直接改 main。建议先从基准拉出工作树。

`confirmText: "仍要进入"`。v1 不扩展第三键。

`runningOnPrimary` **只认 Agent 在跑的标签**，空 shell 不算：

```ts
export function shouldWarnEnterPrimaryBase(input: {
  isPrimary: boolean;
  isBase: boolean;
  runningOnPrimary: boolean;
}): { warn: boolean; kind: "base" | "agent" | null }

// 调用方：
const runningOnPrimary = terminalRunInputs.some(
  (t) => t.running && pathWithin(t.cwd, primaryPath, IS_WINDOWS),
);
```

纯逻辑在 `src/coding-git.ts`，`isWindows` 显式入参（禁止模块内隐式读平台），单测覆盖。`t.running` = Agent 在跑（`RunOverviewInput.running`）；`t.shell` 为真但 `running` 为假的空壳不警告。

主仓 `HEAD != base`：~~身份段 muted 芯片 `主仓不在基准`~~（2026-10-18 收进分支地图：主仓挂在基准根下、根行写「未检出」已说明这件事）。HoverTip 文案保留在根行「建工作树」上：`主仓不在 <base>。给基准建一棵工作树再合并，不要把主仓切回去。`

**改 `merge_at` 人话，删除「请先把主仓切回」。** 找不到 `is_base` 工作树时（仍返回 **`CodingMergeDto`**，不塞进 `CodingOpDto`）：

- `merged=false, conflict=false, code=base_not_checked_out`
- message：`没有检出「{base}」的工作树。请先为基准建一棵工作树再合并。`
- 前端：同一「为基准建工作树」按钮（`source=Local, branch=baseBranch`）。建树成功后再 `merge_into_base`。主仓 HEAD 不动。
- 冲突仍用现有字段 `conflict=true` + `cwd`（改动面板）。

v1 **不提供** 主仓 `checkout`。

### 11. 拉取策略（v1 维持 ff-only）

`coding_pull` 保持 `pull --ff-only`。分歧 → `code=ff_only` + 人话去终端。

`merge_into_base` 仍然只合本地、**不自动 push 基准**。GitHub 上的默认合入路径是 PR。

### 12. 进程与超时

新 git/gh/`github` 一律：

- 可执行文件：`agents::resolve_binary`，禁止裸 `Command::new("gh")`
- 后台 git/gh/`github.bat`：`process::background_command`（Windows `CREATE_NO_WINDOW`）
- 超时：短查询 / `gh auth status` / **`github <absPath>`** / **`open -a`** = **8–20s**（只看 spawn + 退出码）。`fetch` / `push` / `worktree add` / `gh pr * --web` = 60–120s。**不**跑 `github --help`。**不要**把 `github` CLI 放进 `git_long`。
- 参数数组，无 shell 拼接；`remote add` 与 `worktree add` 使用 `--` 挡 option
- 超时杀树：`kill_process_tree` + `join_with_timeout`

---

## API / Interface Changes

### 结构化写结果（拍板，禁止字符串前缀）

与 `GitCommitResultDto` / `WorkspacePrResultDto` 对齐：业务结果走结构体。Tauri `Err` **只**留给 spawn/join **以及** 请求反序列化失败（未知 `source.kind`）。闭集（含 catch-all）：

```ts
export type CodingOpCode =
  | "ok"
  | "branch_exists"
  | "worktree_busy"
  | "invalid_url"
  | "no_origin"
  | "not_github"
  | "no_upstream"
  | "not_worktree"
  | "ff_only"
  | "desktop_missing"
  | "gh_unauth"
  | "git_failed"; // catch-all：脱敏后的 git/gh stderr（fetch 失败、dest 已存在、磁盘等）

export type CodingOpPhase = "add" | "fetch" | "push" | "pr" | "open" | null;

export interface CodingOpDto {
  ok: boolean;
  code: CodingOpCode;
  failedPhase: CodingOpPhase;
  message: string;
  setUpstream?: boolean;
  createdInitialCommit?: boolean;
  method?: "github-cli" | "macos-open" | "gh-view" | "gh-create-web" | "compare-url";
  url?: string | null;
  tried?: string[];
  worktree?: CodingWorktreeDto | null;
}
```

禁止 `set-upstream:` 这类前缀，禁止再用 `msg.includes("未合入")` 扩到新命令。`branch_exists` 是可恢复业务态：`ok=false` 且 invoke 成功，前端确认后换 `source`。

`coding_add_origin`：add 成功 fetch 失败 → `ok=false, code=git_failed, failedPhase="fetch"`，origin 已存在，UI 重试 `coding_fetch`。

**合并不走 `CodingOpDto`。** 保留现有 `CodingMergeDto`，只加 `code`：

```ts
export interface CodingMergeDto {
  merged: boolean;
  conflict: boolean;
  cwd: string;
  message: string;
  code: "ok" | "base_not_checked_out";
}
```

冲突：`conflict=true` + `cwd`（不要把冲突塞进 `CodingOpDto`）。找不到基准树：`code=base_not_checked_out`。其它 git 合并失败可继续 `Err(String)`（与今天一致）或日后把 `git_failed` 加进 `CodingMergeDto.code`；v1 **不**把 merge 折进 `CodingOpDto`。

### 扩展 overview DTO

```ts
export interface CodingRemoteDto {
  name: string;            // "origin"
  url: string;             // 出站已剥 userinfo
  display: string;         // "github.com/org/repo"
  hostKind: "github" | "other";
}

export interface CodingRemoteBranchDto {
  remote: string;
  name: string;
  hasLocal: boolean;
  occupiedPath: string | null; // 已被某 worktree 检出则为路径
}

export interface CodingOverviewDto {
  repoPath: string;
  baseBranch: string;
  isRepo: boolean;
  worktrees: CodingWorktreeDto[];
  branches: CodingBranchDto[];
  merging?: boolean;
  mergingCwd?: string | null;
  origin: CodingRemoteDto | null;
  remoteBranches: CodingRemoteBranchDto[];
  // 不再使用 createdInitialCommit：overview 恒假；改看 create 的 DTO
}

export interface CodingWorktreeDto {
  // …现有…
  upstreamBehind: number; // 无上游为 0
}
```

`CodingBranchDto` 同样加 `upstreamBehind`。Rust `upstream_unpushed` 改为 `(has_upstream, ahead, behind)`。`ahead_behind` 相对基准语义不变。

**不下发 `remotes[]`。**

### 新 / 改命令

| 命令 | 签名要点 | 返回 |
|---|---|---|
| `coding_create_worktree` | `CreateWorktreeReq`（枚举 source） | `CodingOpDto`（成功带 worktree + createdInitialCommit） |
| `coding_add_origin` | `repo_path, url` | `CodingOpDto`（`failedPhase=fetch` 可重试） |
| `coding_open_desktop` | `repo_path, path` | `CodingOpDto`（`method` + `tried`） |
| `coding_open_pr` | `repo_path, cwd` | `CodingOpDto`（`method` + `url`） |
| `coding_merge_into_base` | 现签名 | **保留 `CodingMergeDto`**，加 `code`（`ok` / `base_not_checked_out`）；冲突仍 `conflict`+`cwd`。文案不再建议切主仓 |
| `coding_push` / `coding_pull` / `coding_fetch` | 现签名可先留 `Result<String>` | 新失败码能放进 `CodingOpDto` 的，逐步迁；**不要**发明前缀。PR 后续不依赖 push 返回值 |

~~`coding_abort_merge`：删除或转调 `git_abort_merge`，UI 只调后者。~~（✅ 已删，2026-10-26 核对）

### 纯逻辑（`src/coding-git.ts` + `work-mode.ts`）

双端镜像（Rust 拒写，TS 表单即时提示），测例两边各一份：

- `parseGitRemoteUrl(url) -> { ok, host, ownerRepo, display, hostKind, hasUserinfo } | { ok:false }`
- `abbrevGitRemoteUrl` 基于上一函数
- `githubCompareUrl({ ownerRepo, base, head })` 分段 encode
- `codingFactChips`（`tip` + `baseBranch` + `upstreamBehind` + `hostKind`）
- `shouldWarnEnterPrimaryBase` + `runningOnPrimary` 由调用方用 `pathWithin(..., isWindows)` 算好再传入
- `cwdIsCodingWorktree(cwd, overviews, isWindows)`：`onOpenPr` 门控；根来自 `coding_overview.worktrees[].path`，禁止 `pathWithin(cwd, project.path)` 当主公式
- `remotePickerRows`：过滤占用、cap 200、搜索

合法 / 非法对照表（单测锁定）：

| URL | 结果 |
|---|---|
| `https://github.com/org/repo.git` | ok，`hostKind=github`，display `github.com/org/repo` |
| `https://github.com/org/repo` | 同上 |
| `git@github.com:org/repo.git` | 同上（scp 形；`git` 是 user 不是 scheme） |
| `ssh://git@github.com/org/repo.git` | 同上 |
| `https://gitlab.com/group/sub/repo.git` | ok，`hostKind=other`（多段 path 合法） |
| `git@gitlab.com:group/sub/repo.git` | ok，`other` |
| `https://user:token@github.com/org/repo.git` | 解析 ok，`hasUserinfo=true`，须 confirmDialog；DTO 剥 userinfo |
| `file:///tmp/repo` | 拒 |
| `ext::sh -c evil` | 拒 |
| `git://github.com/org/repo` | 拒（明文 `git://`） |
| `ssh://-oProxyCommand=evil/x` | 拒（host 以 `-` 开头） |
| `git@-oProxyCommand:foo` | 拒 |
| `https://github.com.evil.com/org/repo` | ok，`hostKind=other`（可 fetch/push；**不得**当成 github）。PR/compare 走 `not_github` |
| `https://www.github.com/org/repo` | `hostKind=other` |
| `https://gist.github.com/abc` | `hostKind=other` |
| `https://github.com/onlyone` | 拒（path 少于两段） |
| 含 `..` / 空白 / 控制字符 / 以 `-` 开头的整串 | 拒 |

规则闭集：

- scheme ∈ {`https`, `ssh`}，或 scp 形 `user@host:path`（user 通常 `git`，**不是** `git://` scheme）。
- host：非空、DNS 或 IPv4、不以 `-` 开头、不含 `@`。
- path：至少两段、无 `..`、无空白/控制字符；允许多段（GitLab）；可选 `.git` / 尾 `/`。
- `hostKind==github` **仅** `github.com` 与 `ssh.github.com`（大小写不敏感精确匹配）。
- 命令：`git remote add -- origin <url>`。

---

## Data Model Changes

无 SQLite / `project.toml` 新字段。远程与分支以 git 为事实来源，overview 每次现算。不把 origin 缓存进档案卡。

`settings.json` 不新增 feature flag。

`binary_candidate_dirs`（`agent_specs.rs`）Windows 增加 `%LOCALAPPDATA%\GitHubDesktop\bin`。这是为 `github` CLI，不是为 exe。

工作树目录规则不改。

空仓：不在 overview 浏览时自动提交。第一次成功的 `FromBase`/`Local` create 若触发了 `ensure_initial_commit`，用返回 DTO 的 `createdInitialCommit` 提示「这个仓库还没有提交，已自动写了一条空的初始提交，才能建工作树。」

---

## 能力矩阵

| 行业常见能力 | Mesa 今天 | v1 | later | never |
|---|---|---|---|---|
| 从默认分支建功能分支 | 有（文案不像；同名静默挂） | 主 CTA 人话 **与** fromBase fail-loud 同 PR | — | — |
| 并行 Agent 各一份工作副本 | worktree 已有 | 心智模型 + CLI 打开该树 | — | 改回主仓切分支 |
| 挂已有本地分支为工作树 | `create_at` 静默挂 | 显式选择层；占用则禁用 | — | — |
| 列出并检出远程-only 分支 | 无 `refs/remotes` | 选择层 + 定向 fetch + `--track`；同名确认 | — | — |
| 只建引用不建目录 | 无 | 不做 | — | Agent 无 cwd |
| 显示 origin | 无 | 身份段缩略；文案按 hostKind | 多远程编辑 | 命令框 |
| fetch --all --prune | `⋯` 里英文 fetch | 身份段「从 GitHub/远程 更新」 | — | — |
| push / 首次 -u origin | 项目页 + GitPanel 各一份 | 按钮 title；主路径承认 GitPanel | 两处 -u 抽公共函数 | — |
| pull | `--ff-only` | 保持；`ff_only` 人话 | rebase/merge pull 选项 | 静默非快进 |
| ahead/behind vs 基准 | `↑`/`↓` 无坐标 | `待合入` / `落后基准` + tip | — | — |
| ahead/behind vs 上游 | 只有 unpushed | 补 `远程有更新` | — | — |
| 暂存 / hunk / 提交 | GitPanel | 不搬到项目页 | — | 第二套提交 UI |
| 本地合并进基准 | 有；失败建议切主仓 | 改人话；缺基准树则建树 | — | 主仓 checkout |
| 冲突 | 改动面板 | 不变；abort 只留 `git_abort_merge` | — | 项目页 mergetool |
| 开 PR | 仅科研 `create_pr` | 卡上常驻 + GitPanel toast；`gh --web` 或 compare | 应用内填 title | OAuth、评论、CI |
| 在 Desktop 打开这一份副本 | 无 | `github` CLI / macOS `--cli-open` | VS Code | 协议、exe+路径、LevelDB |
| 主仓检出切换 | 无 | v1 不做 | 仅干净且无 Agent 切回基准 | 切到功能分支 |
| stash | 无 | — | 进入前暂存若真有需求 | stash 浏览器 |
| clone | 添加项目 = 已有目录 | — | 「克隆到…」表单 | — |
| 交互 rebase / cherry-pick / submodule / LFS | 无 | — | — | GUI |
| 任意 git 命令框 | 无 | — | — | v3.179 |
| Issues / Actions / 评审 PR 文件 | 无 | — | 看 CI 状态 | 做成 GitHub 客户端 |

---

## Alternatives Considered

**A. 丢掉 worktree，像 Desktop 一样在主仓文件夹切分支。**  
否决。并行 Agent 会共用一份工作区与同一 HEAD。Pain C 若用 A「解决」，只是把碰撞换成两个 Agent 互踩。

**B. 做成完整 Git GUI。**  
否决。Mesa 是 Agent 启动器 + 工作树管理器。提交已在改动面板。

**C. 只改 CTA 文案，不做 GitHub 环、不做 Desktop CLI。**  
不足。且若只改文案、后端仍静默 attach，Pain A 会更糟。文案必须与 `fromBase` fail-loud 同 PR。

**D. 应用内 GitHub OAuth + 自建 PR API。**  
否决（v1）。本机已有 `gh` 与 `git` 凭证。

**E. 主仓一键切到功能分支 / 切回基准，方便 Desktop 与 merge。**  
否决为 v1。merge 找不到基准树时给基准 **建工作树**，不 `checkout` 主仓。切到功能分支永远不作为推荐路径。

**F. 用 `x-github-client://openLocalRepo` 或 Windows `GitHubDesktop.exe <path>`。**  
否决。协议处理器已删除该动作（启动≠打开该树）；exe 传路径不切仓（desktop#8646），会把用户送回主仓。

---

## Security & Privacy Considerations

| 威胁 | 缓解 |
|---|---|
| `git remote add` 注入（`file://`、`ext::`、`git://`、`-c`、host 以 `-` 开头的 SSH CVE、换行） | 闭集见 API 对照表；host 不以 `-` 开头；`git remote add -- origin <url>`；argv 数组 |
| HTTPS userinfo | `confirmDialog` 后才写；取消不写；DTO 剥 userinfo；stderr 过 `redact_sensitive_text` |
| 打开任意路径 | `coding_open_desktop(repo_path, path)` 现场 worktree 列表 + `same_path`；不开 `allow-open-path`；不注册自定义协议 opener |
| 钓鱼 compare URL | 同一解析器；`hostKind` 仅精确 `github.com`；不把用户粘贴串当 https 打开 |
| `gh` 来路不明 | `resolve_binary("gh")`；不把 `keys.json` 交给 gh；`gh auth status` stderr 不出站 |
| Windows conhost | git/gh/`github.bat` 走 `background_command`（保持 `CREATE_NO_WINDOW`）；**不**启动 `GitHubDesktop.exe` |

威胁模型按本地桌面应用：恶意 origin 与在终端里 `git remote add` 同类；校验把方案限制在 https/ssh，挡掉 `ext` / option / `-` host。

---

## Observability

不新建指标系统。

- 成功：`onNotice` toast
- 失败：`CodingOpDto.message`（已脱敏）；`tried` 用于 Desktop 失败列出已尝试项
- `gh auth` 失败只用人话「未登录 GitHub CLI」
- 远程选择层 200 cap；fetch 超时人话「更新引用超时，再试一次」
- 诊断包：现有子进程生命周期缓冲

---

## Rollout Plan

无 feature flag。增量发版，**按依赖图**，不宣称七条 PR 可乱序合并：

1. 芯片文案（不改 CTA）可单独上。
2. overview 新字段向后兼容：旧前端忽略；新前端缺字段当无 origin、`upstreamBehind=0`。
3. 回滚 = revert 对应 PR。无 `project.toml` 迁移。
4. 三平台同步发；Linux Desktop 按钮 fail-loud，其它能力不得裁剪。

手册在 PR 7：`docs/guide/user-guide.md`「编程项目」、架构 §10、`design-system.md` 编程主区、`safety.md` remote URL + Desktop CLI 门槛、`pipeline.md` 工作方式段、`Agents.md` `coding.rs` 一行。

---

## Open Questions

无阻塞项。默认：

1. **pull 保持 `--ff-only`。**
2. **v1 不切主仓检出。** 基准无处检出 → 给基准建工作树。
3. **PR 算法按 §9 锁死**（点下去先「打开中…」；短超时 `pr view --web`，否则立刻 compare URL；无上游不给 URL）。
4. **不提供无工作树的裸分支。**
5. **`hostKind==github` 仅精确 `github.com` 与 `ssh.github.com`（GitHub 官方 SSH 备机名）。** `www` / `gist` / 钓鱼 host 仍是 `other`。
6. **v1 不克隆。**
7. **主 CTA 从基准建新分支；同名 `branch_exists` 二次确认。** 与按钮文案同一 PR。
8. **空仓提示只在 create 返回 `createdInitialCommit` 时出现**，不在浏览 overview 时自动提交。

---

## Key Decisions

1. **编程页继续是 worktree 控制台，不是 GitHub 客户端，也不是 Desktop 替代品。**
2. **主路径实现仍是 `worktree add -b … <base>`，永不在主仓 `checkout` 功能分支。** 按钮文案「从 &lt;base&gt; 开工」与 fromBase fail-loud **同一 PR**；PR 1 不得先改 CTA。
3. **三种开工 source 用 serde 枚举（FromBase / Local / Remote）；禁止第四种「只有 ref」。** 远程遇本地同名与 fromBase 一样 `branch_exists` 确认，不静默改 Local、不重置。占用分支禁用。
4. **相对基准与相对上游分成两套芯片；`deriveCodingKind` 仍只看基准。** `CodingFactChip.tip` + `baseBranch` / `upstreamBehind` / `hostKind`。
5. **提交只留在 `GitPanel`。** 主路径的 push 是 `git_push` / `git_commit` 连带 push，不是项目页 `coding_push`。
6. **`pull --ff-only` 维持。**
7. **GitHub 环最小集。** 入口：编码页工作树卡常驻；终端仅当 `cwdIsCodingWorktree` 为真时给 `GitPanel` 传 `onOpenPr`。判定根 = 各 coding 项目 `coding_overview.worktrees[].path`（含 `~/ccode/worktrees/…`），**不是** `project.path`。TerminalPage 自己拉 overview，不依赖编程页。科研工作区路径不进表。GitPanel 本身不识别 GitHub。不复用 `create_pr`。无上游不生成 compare URL。
8. **Desktop = 文档化 CLI。** `github` argv 锁死 `[absPath]`（不对 CLI 传 `--cli-open`，不跑 `--help`）。超时 **8–20s**（spawn + 退出码），不要 `git_long`。macOS 无 CLI 才 `open -a "GitHub Desktop" --args --cli-open=<path>`（best-effort，同样短超时）。CLI 成功 = 退出码 0。不用 `openLocalRepo` 协议，不用 Windows exe+路径。返回 `method`/`tried`。签名必须有 `repo_path`，现场 worktree 列表校验。
9. **主仓+基准的「进入」要警告。** `runningOnPrimary` 只认 `t.running` + `pathWithin(..., isWindows)`。
10. **git/gh/`github.bat` 走 `background_command`（NO_WINDOW）。** 不对 bat 开可见窗口。
11. **科研 `create_pr` 不复用。**
12. **无应用内 GitHub token。**
13. **写操作返回 `CodingOpDto`，`code` 闭集含 catch-all `git_failed`，多阶段用 `failedPhase`。** 类型在 PR 2 引入。禁止字符串前缀。`remote add` 成功而 fetch 失败：`code=git_failed, failedPhase=fetch`，不回滚 origin。**合并不折进 `CodingOpDto`**：保留 `CodingMergeDto` + `code`。Tauri `Err` 仅 spawn/join 与反序列化失败。
14. **`hostKind` 驱动全部「GitHub」vs「远程」文案。** github 仅精确 `github.com` 与 `ssh.github.com`（官方 SSH 备机）；`www.github.com` / `gist.github.com` / `github.com.evil.com` 仍是 `other`。
15. **基准无处检出：给基准 `source=Local` 建工作树，并改掉 `merge_at`「请把主仓切回」的人话。**
16. **取消合并只留 `git_abort_merge`。**
17. **v1 overview 只下发 `origin`，不下发 `remotes[]`。**

---

## Risks

| 严重度 | 风险 | 缓解 |
|---|---|---|
| 高 | 用户仍把 Desktop 开在主仓 | CLI 打开的是 worktree；卡上一句 + AppWindow 按钮；手册 |
| 高 | 芯片坐标改名后短期不认 | `tip` 锁定在单测；手册对照 |
| 高 | 先改 CTA 文案、后端仍静默 attach | PR 1 禁止改按钮；文案在 PR 3 |
| 中 | `github` CLI 未装 | macOS `open -a … --cli-open` best-effort；Windows fail-loud 装 CLI；Linux 说明 |
| 中 | `gh` 未装或未登录 | 不阻断推送；已有上游才给 compare URL |
| 中 | `fromBase` 同名报错，旧习惯被打断 | `branch_exists` 确认；选择层列未占用分支 |
| 中 | fetch 大仓超时 / 远程分支过多 | 定向 fetch；UI cap 200 + 搜索 |
| 低 | Windows 路径长度 / 分支名 sanitize | 已有 `sanitize_fs_name` |
| 低 | 非 GitHub 用户找 PR / 「从 GitHub 更新」 | 文案按 hostKind 分支 |

---

## References

- `src-tauri/src/coding.rs`：`create_at`（481–488 行静默 attach）、`overview_at`（`created_initial_commit: false`）、`ahead_behind`、`upstream_unpushed`（丢掉 behind）、`coding_push` 的 `-u origin` 重试、`merge_at`（565–571 行建议切主仓）
- `src-tauri/src/workspaces.rs`：`detect_base_branch`、`ensure_initial_commit`、`run_git` / `git_long`、科研 `pr_impl`（**不要接到编程页**）
- `src-tauri/src/git_info.rs`：`GitCommitResultDto`、`do_push`；porcelain ahead/behind **相对上游**
- `src/components/CodingProjectView.tsx`（取消合并走 `git_abort_merge`）、`src/work-mode.ts`（芯片无 tip）、`src/components/GitPanel.tsx`（真实提交/推送入口）
- `src/path-utils.ts` `pathWithin(child, root, isWindows)`；`src/run-overview.ts` `RunOverviewInput.running`
- `src/components/HoverTip.tsx`、`src/components/ConfirmDialog.tsx`
- `docs/architecture.md` v3.179 / v3.180 / v3.190
- `docs/conventions/pipeline.md`、`design-system.md` 编程主区、`safety.md` 多阶段 Git / opener
- `docs/guide/user-guide.md`「编程项目」条
- GitHub Desktop：官方用户入口 `github /PATH/TO/REPOSITORY`（argv = 绝对路径，**不要**给 `github` 传 `--cli-open`）。`--cli-open=` 只用于 macOS `open -a "GitHub Desktop" --args --cli-open=...`（desktop#22150，内部投给应用）。`parse-app-url.ts` 现仅 `oauth`/`openrepo`；desktop#19733 从协议处理器移除 `openLocalRepo`；desktop#8646 Windows exe 传路径不切仓
- 办公页外部打开先例：`fs_tree::open_in_system`

---

## PR Plan

七刀可以切，但 **不是独立发布列车**。依赖：

```text
PR 1 芯片+tip
PR 2 overview DTO + CodingOpDto 类型（types.ts / coding.rs）
        ├─→ PR 3 source 枚举 + CTA 文案
        ├─→ PR 4 Desktop CLI
        ├─→ PR 5 origin 表单
        └─→ PR 6 PR 环（建议也依赖 PR 5）
PR 7 文档（1–6 之后）
```

PR 1 ∥ PR 2 可并行。**PR 4/5/6 依赖 PR 2**（共用 `CodingOpDto`，禁止谁先落地谁复制一份类型）。**禁止 PR 1 与 PR 3 乱序：PR 1 不得改主 CTA 文案。** PR 3 还依赖 PR 2 的 `remoteBranches`。PR 6 无 origin 时入口隐藏，要完整测「连接后再开 PR」需 PR 5 已入。

### PR 1 — 芯片坐标与 tip（不改 CTA、不上 Desktop 句）

- **标题：** 编程页芯片区分基准/远程，HoverTip 取代裸 ↑↓
- **影响文件：** `src/work-mode.ts`（`CodingFactChip.tip`、`codingFactChips` 增加 `baseBranch` / `upstreamBehind` / `hostKind`）、`tests/work-mode.test.ts`（锁 label **和** tip）、`src/components/CodingProjectView.tsx`（`FactChips` 接 `HoverTip`；主按钮文案 **不动**）
- **依赖：** 无
- **内容：** 标签 `待合入` / `落后基准`；无 origin 时 tip 用「远程」。不上「从 main 开工」，不上 Desktop 说明句。

### PR 2 — overview：origin、远程分支、@{u} behind

- **标题：** coding_overview：origin、remoteBranches、upstreamBehind
- **影响文件：** `src-tauri/src/coding.rs`、`src/types.ts`（**在此引入 `CodingOpDto` / `CodingOpCode` / `CodingOpPhase`**，含 `git_failed`；后续写命令复用）、coding.rs 单测、`CodingProjectView.tsx` 身份段（hostKind 文案、右簇「从 GitHub/远程 更新」+「刷新」、缩略溢出）、新建 `src/coding-git.ts` + `tests/coding-git.test.ts`（URL 表、`github.com.evil.com` → `other`、compare 分段 encode）
- **依赖：** 无（与 PR 1 并行；`upstreamBehind` 接上芯片）
- **内容：** 只下发 `origin`，不下发 `remotes[]`；出站剥 userinfo + stderr 脱敏；远程列表可全量，UI cap 在 PR 3 选择层。身份段不折第三带。`CodingOpDto` 本 PR 只加类型与空实现占位不必接线令；PR 3/4/5/6 rebase 复用，禁止再定义一份。

### PR 3 — 三种开工 source + CTA 文案 + 空仓旗标 + merge 人话

- **标题：** 创建工作树 FromBase/Local/Remote；从基准开工文案与 fail-loud 同船
- **影响文件：** `coding.rs`（枚举 source、create 返回已有的 `CodingOpDto`、`ensure_initial_commit` 不再丢掉 bool、`CodingMergeDto.code`、`merge_at` 人话）、`lib.rs`、`CodingProjectView.tsx`（CTA「从 &lt;base&gt; 开工」、选择层、占用禁用、为基准建树）、测试
- **依赖：** PR 2（`remoteBranches` + `CodingOpDto` 类型）
- **内容：** 同名 `branch_exists` 确认（fromBase 与 remote 相同）；定向 fetch argv 写死；选择层 200 + 搜索；取消合并只调 `git_abort_merge`，去掉重复命令。不在主仓 checkout。**不**把 merge 折进 `CodingOpDto`。

### PR 4 — GitHub Desktop CLI + 保护主仓进入

- **标题：** 按工作树用 github CLI 打开 Desktop；主仓基准进入警告
- **影响文件：** `coding.rs` `coding_open_desktop(repo_path, path)`、`lib.rs`、`agent_specs.rs` `binary_candidate_dirs`（Windows Desktop `\bin`）、`CodingProjectView.tsx`（`AppWindow` + 一句）、`src/coding-git.ts`（`shouldWarnEnterPrimaryBase`）、平台失败文案单测
- **依赖：** PR 2（`CodingOpDto`）。现场 `git worktree list`，不信前端缓存。
- **内容：** `github <absPath>`（不对 CLI 传 `--cli-open`、不探测 `--help`）；超时 8–20s。macOS 无 CLI 才 `open -a … --args --cli-open=`（best-effort，同样短超时）；Windows 无 exe 回落；Linux fail-loud。CLI 成功 = 退出码 0。返回 `method`+`tried`；`github.bat` 用 `background_command`。无协议。

### PR 5 — 连接 origin 表单

- **标题：** 编程页表单添加 origin（https/ssh 闭集校验）
- **影响文件：** `coding.rs` `coding_add_origin`、URL 校验单测（与 `coding-git.ts` 镜像）、弹层、`confirmDialog` userinfo
- **依赖：** PR 2（`CodingOpDto` + origin DTO）
- **内容：** `git remote add -- origin <url>`；fetch 失败 `code=git_failed, failedPhase=fetch` 不回滚。不是命令框。

### PR 6 — 打开 Pull Request

- **标题：** 工作树卡 + GitPanel：gh --web / compare URL
- **影响文件：** `coding.rs` `coding_open_pr(repo_path, cwd)`（允许 `repo_path === cwd`；现场 `worktree list` + `remote get-url`）、`CodingProjectView.tsx` 卡上常驻入口、`GitPanel.tsx` 仅加可选 `onOpenPr?: (cwd: string) => void`、`TerminalPage.tsx` 自己对 coding 项目拉 `coding_overview` 并用 `cwdIsCodingWorktree` 决定是否传回调、`src/coding-git.ts` + `tests/coding-git.test.ts`（主仓路径命中、`~/ccode/worktrees/…` 命中、科研 worktree 不命中、`pathWithin(project.path)` 对功能树为假）
- **依赖：** PR 2（`CodingOpDto` + origin + `coding-git.ts`）；建议 PR 5
- **内容：** §9 算法；门控根 = `worktrees[].path` 不是 `project.path`；科研/Sessions/普通仓不传 `onOpenPr`；不复用 `create_pr`；无上游禁用；非 github.com 不渲染；缺 gh 不阻断 push。不把 `--show-toplevel` 当主仓。

### PR 7 — 文档与约定同步

- **标题：** 编程 Git/GitHub 环：手册与约定
- **影响文件：** `docs/guide/user-guide.md`、`docs/architecture.md` §10、`docs/conventions/pipeline.md`、`design-system.md`、`safety.md`、`Agents.md`
- **依赖：** PR 1–6 行为稳定后
- **内容：** 从基准开工、芯片、Desktop 用 CLI 打开 **这一目录**、hostKind 文案、无 gh 降级。不写操作流水账。

### 运行中删除与外部启动器（2026-09-08）

编程工作树删除在后端核验活跃 PTY 与 Run；用户确认强删也不能跳过运行保护，先停止再删。GitHub Desktop/浏览器启动器是外部应用入口：空 stdin/stdout/stderr、有界等待直接子进程，不纳入 kill-on-close 捕获 Job，不因 Mesa 关闭而杀用户打开的外部窗口。
