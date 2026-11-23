# 多官方账号、用量卡多号展示与无缝换号接力设计方案

> **状态**：已拍板落地（2026-11-21）
> **范围**：连接页多官方账号模型（6 家目录隔离：Claude Code / Codex / Grok Build / Kimi Code / Gemini CLI / CodeBuddy + Antigravity CLI 托管快照）、用量页订阅余量卡（含新增 Grok Build / Kimi Code 官方额度）与网关余额卡的多号区分与轻量筛选/排序、对话内按会话选不同官方号、满额轻提示条与同厂跨官方号无缝接力、Antigravity 托管凭证快照库与单活防串号护栏。

---

## 1. 背景与原则

1. **账号唯一真相在连接页，用量页只做映射与展示偏好**：不在用量卡里维护独立密钥/登录副本；连接页加好号，用量卡自动呈现，启动栏/步骤卡/换号菜单同步可选。
2. **保留本机默认槽位，零破坏迁移**：老用户的默认目录（`~/.claude`、`~/.codex`、`~/.grok`、`~/.kimi-code`、`~/.gemini`、`~/.codebuddy`）始终对应 `OfficialAccountMode::Default`，不搬迁原有登录与历史数据；新增的官方账号使用独立身份。
3. **按各家 CLI 真实机制隔离**：
   - **6 家目录隔离并发（均坚持凭据只读、绝不刷新/回写）**：
     - **Claude Code**：`CLAUDE_CONFIG_DIR`（含官方额度卡）
     - **Codex**：`CODEX_HOME`（含官方额度卡 + 按号重置卡）
     - **Grok Build**：`GROK_HOME`（含 SuperGrok 官方额度卡）
     - **Kimi Code**：`KIMI_CODE_HOME` + `KIMI_SHARE_DIR`（含 Kimi 官方 OAuth 额度卡）
     - **Gemini CLI**：`GEMINI_CLI_HOME`（顶替家目录，配置在其下 `.gemini/`）
     - **CodeBuddy**：`CODEBUDDY_CONFIG_DIR`
   - **Antigravity CLI (`agy`)**：官方登录写死全局唯一系统钥匙串项（`service=gemini, account=antigravity`），不支持多官方号同时并发；由 Mesa 维护本地 `0600` 凭证快照库（`official-accounts/agy-accounts.json`），支持多号收录、独立查余量、切号前必收回、以及运行时单活并发护栏。
   - **不开放官方多号的 3 家**：**Qwen Code**（官方 OAuth 免费档已于 2026-04-15 停用，多账号应配多条阿里云 Coding Plan / API Key 连接）、**Cursor**（凭据写死 `~/.cursor`，环境变量不搬迁登录态）、**OpenCode**（无官方账号语义，直接配多条网关连接）。
4. **维持简洁卡片口径**：用量卡收起态保持纯左右滑动（不堆按钮），展开态展示区分名与轻量「筛选/排序」；限额满时不自动偷换号，仅给轻提示条由人点选触发接力。

---

## 2. 数据模型与目录布局

### 2.1 `Binding` / `Profile` 扩展

`Binding` 新增可选字段 `official_ref: Option<OfficialAccountRef>`（旧数据缺失时按 `OfficialAccountMode::Default` 解析）：

- `OfficialAccountMode`：`Default` | `IsolatedDir` | `ManagedSnapshot`
- `OfficialAccountRef`：
  - `mode`: `OfficialAccountMode`
  - `local_dir_id`: `Option<String>`（仅相对短 ID，防绝对路径外泄）
  - `snapshot_id`: `Option<String>`（仅 `agy` 托管快照键）
  - `account_hint`: `Option<String>`（非敏感展示副标题，如邮箱/组织名）

同一 `agent` 仅限制最多 1 条 `Default` 官方绑定，允许任意多条 `IsolatedDir` / `ManagedSnapshot` 绑定，每条可自定义 `name`（例如「个人 Max」「团队号」）。

### 2.2 本机文件布局

```text
<Mesa 配置根>/
└── official-accounts/
    ├── claude/<local_dir_id>/    # 独立 CLAUDE_CONFIG_DIR（0700）
    ├── codex/<local_dir_id>/     # 独立 CODEX_HOME（0700）
    ├── grok/<local_dir_id>/      # 独立 GROK_HOME（0700）
    ├── kimi/<local_dir_id>/      # 独立 KIMI_CODE_HOME（0700，旧版 legacy/ 同步隔离）
    ├── gemini/<local_dir_id>/    # 独立 GEMINI_CLI_HOME（0700，内含 .gemini/）
    ├── codebuddy/<local_dir_id>/ # 独立 CODEBUDDY_CONFIG_DIR（0700）
    └── agy-accounts.json         # 0600，仅收录多个 agy 官方号时写入，绝不进诊断包/导出
```

---

## 3. 核心机制

1. **启动注入（`agents.rs`）**：
   - Claude `IsolatedDir` 注入 `CLAUDE_CONFIG_DIR=<dir>`；
   - Codex `IsolatedDir` 注入 `CODEX_HOME=<dir>` + `-c model_provider="openai"`；
   - Antigravity `ManagedSnapshot` 启动前校验钥匙串是否已切到该快照，且检查单活注册表无冲突运行中的异号 `agy` 会话。
2. **会话扫描与恢复（`sessions.rs`）**：
   - `SessionRoots` 额外收录全部 Claude / Codex 附加隔离目录（只读扫描 + 删除白名单放行）；
   - 恢复落在附加隔离目录里的历史会话时，自动回注对应 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`。
3. **多号用量与定向重置卡（`official_quota.rs` / `subscription_quota.rs`）**：
   - `PlanQuotaDto` 增加 `binding_id`、`account_hint`、`is_active_slot`；
   - `official_rows(force)` 并发查询默认槽位 + 全部官方绑定（Claude 各隔离目录钥匙串 / `.credentials.json`、Codex 各 `CODEX_HOME/auth.json`、Antigravity 当前槽位 + 托管副本直查 `daily-cloudcode-pa` 仅收 Gemini 自家桶）；
   - `use_codex_reset_card(gateway_id)` 按具体行 ID 定位对应 `CODEX_HOME` 消费。
4. **对话内无缝换号路由（`ChatModelMenu` / `TerminalView` / `relay`）**：
   - 同目录连接切换（如网关 A → 网关 B）继续走 `switchConnection` 原会话接回；
   - 跨官方账号切换（Claude / Codex 跨隔离目录、或 Antigravity 跨账号快照）统一走 `relay_prepare` 写交接简报，在同一标签页无缝续接并在侧栏按 `relay_links` 合为同一段对话；
   - 检测到本轮限额报错或当前号窗口已满 `100%` 且存在同厂另一可用账号时，输入框上方给出轻提示条，一键挂好接力目标（或把刚才被挡住的句子原样重发）。
5. **Antigravity 单活防串号护栏（`official_accounts.rs`）**：
   - 进程内追踪每个运行中的 `agy` 官方会话与其 `snapshot_id`；
   - 启动或切到异号 `agy` 前先查冲突，有冲突则弹窗列出正在运行的异号会话，待用户确认停掉后再切换钥匙串，绝不静默串号。

---

## 4. 安全边界声明

- Claude Code 与 Codex 的全部官方账号（含隔离号）严格保持**只读、绝不刷新、绝不回写**；
- 仅对用户主动收录的 Antigravity (`agy`) 托管账号，允许写 `0600` 本地快照库、在用户触发切号时回写系统钥匙串（写入前必收回当前钥匙串防丢号），并在查非激活号余量时于本地副本刷新 Google access token（不写钥匙串）；
- 令牌绝不出站到 DTO、日志、诊断包、导出配置；切号与消费重置卡一律由人显式触发。
