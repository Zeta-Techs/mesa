# 约定：安全与数据防护

> 适用范围：密钥、会话/配置读写、文件与仓库的删除/提交、诊断包、CLI 安装更新。从 AGENTS.md 迁入（原文照录，未做语义改动）。

- **审计收口规则（2026-09-08）**：生产 CSP 禁止内联脚本、JS eval、frame/object、base 和表单提交；只开放本地脚本、IPC、图片、字体与 worker 所需来源，开发策略仅额外允许热更新脚本和本机 WebSocket。DOMPurify 仍是内容清洗边界，CSP 不能替代它。Vite dev/build/preview 必须显式 `--config vite.config.ts`，不能被历史生成的 JS 配置遮蔽。
- **配置持久化（2026-09-08）**：profiles/keys/settings、schedules 和全局 CLI 配置分别在读改写全程持进程内锁与 OS 文件锁；取锁失败报错，不无锁继续。唯一同目录临时文件创建即 0600（Unix），通用写入保留原文件 mode，私有写入强制 0600；替换失败不得先删原件。Windows 只读属性仅临时放开，失败恢复属性。官方账号绑定不得嵌套获取同一把 profiles 锁。
- **迁移与损坏（2026-09-08）**：拆层迁移先存 `gateway-split.pending.json`（私有恢复日志），所有文件和引用更新成功才删除；任何阶段可重放，保持日志中的 ID 不变。旧版半迁移只按仍有 key_hint 的网关与保留 binding ID 恢复密钥引用，不猜端点、不覆盖已有新密钥。损坏 keys/settings 保留原件并拒绝写入，不以默认值覆盖；密钥脱敏读取没有改名副作用，暂时失败沿用上次成功快照。
- **权限诚实性（2026-09-08）**：新建与恢复都执行 discuss 参数约束；无只读/计划模式参数的 Agent 拒绝 discuss，不仅靠提示词。不把 CLI 计划模式称作 OS 级沙箱。定时任务显式连接失效时停下报错，不在无人确认时更换供应商；无头缺密钥拒绝启动。
- **本机原生权限档（2026-10-17；同日收成四档）**：聊天权限菜单的「请求批准 ask / 帮我批准 auto / 完全访问 full」只经 `pty_spawn.permissionMode` 加在本次命令行
  （`agent_specs.permission_args`，`agents::permission_launch_args`），不写任何 CLI 配置；这家没有该档 → 拒绝启动、不静默退回本机默认。
  Run 的权限政策仍只有 discuss / write_tree。运行中换权限一律「停下再按原会话恢复」，不在进程里偷切；确认框必须写明会重开。**完全访问必须二次确认**（confirmDialog danger），且不进标签持久化白名单——重启后
  恢复的标签不得自动带着完全访问再起。Claude Code 的 `/model`、`/effort` 会自己写 `~/.claude/settings.json` 的 model / effortLevel
  （CLI 行为，非 Mesa 写入）：聊天芯片弹层必须明说，不得暗中替用户改回。本机设置探查（`cli_permission.rs`）只报**实际生效**的：
  Mesa 启动 Codex 一律带 `-s workspace-write`，本机 `sandbox_mode` 被盖掉，不得据它报「完全访问」（只看 `approval_policy`）。
  **沉浸阅读会话固定请求批准（2026-10-18）**：阅读区自动开的会话带 `permissionMode: "ask"`（这家没有 ask 档才按本机设置，
  不能因此拒绝启动），本机设完全访问也收窄；Claude Code 再按 `reuse_key` 前缀 `reader:` 追加 `--allowedTools Edit(./notes/**)`，
  只预放行项目 `notes/` 下的编辑。这条放行只跟着阅读会话走，不扩到别的会话、不写任何 CLI 配置。
- **终端输入/输出（2026-09-08）**：每 PTY 独立有界队列（16 项，单次最多 1 MB），入队后后台等待，不能持全局表锁阻塞写入；聊天正文和延迟提交键是一项请求，不能交错。超时明确告知可能仍在写入，禁止自动重发。PTY 实际输出不等数据库：诊断副本经有界队列每 500ms 批量落盘、复用连接，每 Run 最多 100 条、全局最多 10000 条输出事件，不清除生命周期事件；尾部未闭合 token 不持久化，先脱敏后截尾。
- **取消和退出（2026-09-08）**：无头任务有取消信号；定时行和设置→诊断均有停止入口。原生退出阶段拒绝新启动，并限时回收捕获进程与 PTY，不只依赖 React 卸载。Windows 受管理捕获命令先挂起创建，再加入 kill-on-close Job Object 后恢复，失败不无保护继续；打开 GitHub Desktop/浏览器的启动器不进入该 Job，也不继承输出管道，以免关闭用户打开的窗口。Windows 全应用/界面仍需实机验收。
- **出站/预算（2026-09-08）**：普通日志查看、复制、导出与诊断包统一后端脱敏；模型目录响应最多 16 MB，公共模型库/期刊 CSV 最多 32 MB，按实际解压字节累计，不能只相信 Content-Length。配置读取失败不清空上次成功列表，必须提供原因与重试。

- **文档预览不是可信 HTML（2026-09-07）**：Markdown、DOCX、任务书、产物预览和聊天最终 HTML 均经
  `src/document-html.ts` 的 DOMPurify 文档白名单清洗后才进入 DOM；路径白名单不代表内容可信。
  禁止脚本、事件属性、嵌入页面、表单、内联样式及危险 URL；仅保留文档排版、脚注、图片、公式占位和禁用的任务复选框。
  图片字符串重写必须在清洗前完成；清洗后仅允许受控 DOM 图片水合与 KaTeX（默认不信任命令），不得拼接未经清洗的 HTML。
  DOM 安全回归测试使用 jsdom 30（仅开发依赖）；Node 22 环境需至少 22.22.2，构建产物不包含 jsdom。
- **文本预览保存带版本（2026-09-07）**：`read_file_preview` 返回内容摘要 `revision`，仅完整可写 UTF-8 文件有版本；
  `save_file_preview` 必须携带 `expectedRevision`，保存前重新读取核对，外部变更、文件增长超限或编码不支持时拒绝覆盖。
  前端外部刷新必须同步只读/截断状态；保存期间新增编辑继续保持未保存。`../` 路径拒绝；从树中预览根外 symlink 的既有
  功能保留，但明确只读，不授予写入权限。该版本检查是乐观并发保护，不宣称能锁住不遵循 Mesa 锁的外部写入进程。

- **受管理后台命令的等待边界（2026-09-07）**：AI 无头调用、CLI 预检、工作区 Git/钩子、编程辅助命令统一走
  `process::capture_command`；deadline 同时覆盖父进程退出与 stdout/stderr EOF，禁止父进程退出后无限 join。
  Unix 仅捕获命令建立独立进程组；Windows 杀树命令本身限时。输出分别有界（AI/编程 8 MB、预检 1 MB、工作区 32 MB），
  超限排空但不将截断数据当作完整结果；超时保留已收输出。无头 API Profile 缺密钥必须在 spawn 前拒绝，登记 Run 失败也不得启动。
  PTY 成功 spawn 后登记失败必须回收，停止的同步等待有界。Windows 捕获命令的 Job 约束见 2026-09-08 规则；PTY 作业控制与外部程序自行脱离进程组仍需实机验证，进程管理不是文件系统沙箱。
- **定时采纳安全（2026-09-07）**：采纳只使用冻结文本，不从可复用工作树即时拷贝；检查全部文件基线、项目保护路径及 symlink，
  原子替换前先保存整批恢复材料。采纳与冻结持跨进程锁，历史无证据、任务失败、源文件删除、版本冲突时 fail-closed。
  Unix 快照/备份临时文件创建即 0600；不在替换失败时先删原文件。外部编辑器仍是乐观并发，不承诺跨文件崩溃原子性。
- **普通目标采纳（2026-09-08）**：科研/办公目标写回主仓不得逐文件 `fs::copy` 后无法回滚。采纳持跨进程锁，先持久化原件备份，
  写入前再读基线；后一文件失败必须回滚已写文件。保护路径、symlink、目录目标 fail-closed。与定时冻结是同一类安全，不是同一套文件名单。
- **任务书草稿保存（2026-09-08）**：`read_task_draft` 返回内容 `revision`；`write_task_draft` 必须带 `expectedRevision`（新建为 null）。
  磁盘已变则拒绝覆盖。决策落盘、弹层保存、播种、文献来源同步同一口径。保存期间继续输入保持 dirty，不把后输入标成已保存。
- **配置多文件与密钥失败（2026-09-08）**：创建/修改连接先写网关再写绑定，第二份失败回退第一份；密钥写入失败回退清单。
  `delete_key` 读写失败必须返回错误，调用方不得在失败后清除「有密钥」提示。这是成对回退，不是崩溃原子事务。
- **用户档案卡（project.toml 等注册项目数据）禁止 agent 用正则/文本工具手改**（2026-09-16 踩坑：正则删测试残留只删了块头、留下孤儿字段行，duplicate key 令整卡解析失败、项目从列表消失）。清理/修数据必须走 projects 的读-改-原子写原语，或至少 toml 解析→改对象→重序列化的整份回写，改完 tomllib 校验通过才算完。

- **Run 结束登记（2026-09-08）**：终态事务成功与否都释放存活锁；失败写诊断。禁止只 `let _ = close` 而不记录，留下进程已退出、账本仍运行。

- **密钥绝不回显/进 shell**：存 0600 `keys.json`，只在拉起瞬间注入子进程 env；`profiles.json` 只存尾号 key_hint；
  `NO_COLOR` 必须 `env_remove`；`TERM=xterm-256color`/`COLORTERM=truecolor`/`TERM_PROGRAM=Mesa` 必须显式设置。
  **外部恢复/复制恢复命令不携带 profile env**（`agents::resume_command_line`，⇗/⧉ 共用）；⇗ 拉起：CLI 用绝对路径
  （`resolve_binary`，⧉ 复制命令才用裸名）、shell 必须 `-l -i` 交互登录（非交互不加载 `.zshrc` 的安装器 PATH）。
  **Ghostty** 走 AppleScript（`open -n` 堆实例、不带 `-n` 不投递 `--args`）：激活 → ⌘N → 剪贴板粘贴命令 + 回车
  （用后还原；首次需用户授权自动化）。
- **出图工具的密钥边界（2026-10-23，image_gen.rs / bin/mesa_helper.rs）**：Agent 出图走随包 `mesa_helper image …`，
  helper 出图时自己从 keys.json 取网关密钥，只在本进程里发请求，**不打印、不写日志、不进 Agent 环境变量**；Mesa 给 PTY 只注入
  `MESA_IMAGE_TOOL`（helper 路径）。厂商回的图片下载地址（签名 URL）**不带任何鉴权头**，直连不通才走设置的出网代理；网关报错原文
  经 `redact_sensitive_text` 脱敏再回给 Agent / 前端。`image_gen::Target` 带 Header 值，不得派生 Debug。浏览器桥与 hook 模式仍不读密钥。
  技能 image-gen 要求不生成冒充实验观测的图、失败照实报不换模型偷偷重试。
- **机构访问会话罐（2026-09-16，inst_access.rs）**：登录窗 Cookie 存 0600 `inst-session.json`（与 keys.json 同
  纪律：原子写、私有临时文件、值绝不出站——状态 DTO 只给域名/条数/时间，不进诊断包/生效配置快照）；损坏保留
  原件报错，不当空罐继续。**绝不存机构账号密码、绝不做无人值守自动登录**（MFA 过不去；脚本式批量下载会被
  出版商风控识别并连坐全校 IP）——只有用户在独立登录窗里自己完成的 SSO 会话可复用，且只由人在 UI 上逐篇触发
  下载，scheduler/无头 Run 不携带该会话。会话只在请求头按域名匹配注入（`cookie_header_for`），不写进任何
  agent env、不进 shell。
- **聊天层旁路的秘密与边界（2026-10-20，chat_channel.rs）**：OpenCode 服务口令、Codex app-server 能力令牌每标签随机生成，
  **只经环境变量**交给 CLI（Codex 的 app-server 参数里只有令牌的 SHA-256），不落盘、不进 Run 记录 / 日志 / 诊断包；两者都只监听
  127.0.0.1，无口令 / 错令牌一律 401（已实测）。旁路目录 0700、事件 / 输入文件 0600，标签退出即删。hooks 日志每条 payload 截到 64KB
  （PostToolUse 2KB，带整份工具结果），截断记录按字段名兜底取事件名与会话 id；审批卡的命令 / 差异 / 实时文字出站前过
  `redact_sensitive_text`。hook 只记录不决策，不阻塞 TUI；回复审批只在用户点按钮后发生，不做「免确认自动选第一项」。
  **程序状态（OSC 7501，2026-10-22，program_status.rs）**：终端流里谁都能写这串，当不可信输入——整条序列 ≤4096 字节、msg 是 base64 的
  UTF-8（≤2048 字节）、解出来含控制字符或超限整条丢；只认根记录；msg 当「现状一句」出站前过 `redact_sensitive_text`，截到 240 字。
  探询只对用这条旁路的标签答，不写任何配置。
- **从手机添加（2026-10-20；2026-10-21 加「记住这台手机」；phone_drop.rs；设计 docs/design-phone-drop.md）**：这是 Mesa 唯一在非回环地址上监听的口子，
  守住八条：①两种监听，都随应用退出即关（lib.rs ExitRequested 调 `phone_drop::shutdown`）：**主动接收**只在人点了「从手机添加」后开，
  出二维码、可配新手机，停止 / 30 分钟无新内容即结束；**常驻等候**（2026-10-21 用户拍板「手机直接传，Mesa 弹窗」）只在配对簿开着
  「随时接收」（缺省开、弹窗可关）且至少配对了一台时随应用开着，**只认设备地址、配对路由关闭**（`/p/` 一律 404），不因空闲停，
  网卡变了就换绑（Win/Linux 系统通知 + 20 秒兜底，macOS 4 秒轮询；全无地址不算变）；主动接收结束且该等候就自动转回常驻等候。没配对过手机、或关了开关，就没有任何常开监听；②只绑局域网网卡的私网 IPv4（`if-addrs` 列网卡，排除回环、169.254、虚拟网卡名；代理 TUN 的 198.18/15、
  组网工具的 100.64/10 不是私网段天然排除；几张都绑同一端口，电脑名解析到哪张都接得住），不绑 0.0.0.0、不绑 IPv6；
  端口第一次由系统挑、记进配对簿后固定（被占就这次临时换并提示，记下的不改）；③两种令牌都在 URL 路径里、定长比较：扫码地址
  `/p/<配对令牌>/` 每次开始接收新开、只在本次有效，打开即可配对；配对发长期设备令牌（两段 uuid v4），手机跳到 `/d/<设备令牌>/`
  加主屏——**设备令牌原文只在手机上，配对簿 `<配置根>/phone-devices.json`（0600，进程锁 + 文件锁 + 原子写）只存 SHA-256**，
  界面与日志不显示；最多 8 台；配对只走 `/p/`，`/d/` 上的 pair 一律 404；设备页「移除」即删记录、立刻失效；配对簿损坏改名留证、按空簿继续
  （所有手机重扫，失败即收紧）；配对本身永远要人点开始接收（常驻等候不放出二维码）。错令牌、未知路径、方法不对、Host 头不在
  「绑定 IP:端口 / 电脑名:端口」之内（防 DNS 重绑定）一律同一个 404；④**只收不出**：路由只有手机页静态文件（页面 / 脚本 / 样式 /
  manifest / 图标）、状态、配对、上传文件、上传文字——禁止新增列目录、下载、读暂存区、列已配对手机的路由；⑤响应头 `no-store` / `no-referrer` / `nosniff` + 严格 CSP，
  手机页脚本与样式同源单独文件、不写内联；⑥上限：单文件 100 MB、24 小时窗口合计 1 GB（没收完的退回额度）、文字 2 万字、同时进行的上传 3 个
  （120 秒没进展的不占名额，卡死连接不能把服务堵成永久 503）；上传必须带 Content-Length，超限读正文前就拒；边收边写 `.part`、
  收满才改名，断了删半截；文件名只取最后一段 + `sanitize_fs_name` + 限长，原名只当显示；⑦暂存区 `<配置根>/phone-inbox/`
  目录 0700 / 文件 0600，索引走进程锁 + OS 文件锁 + 原子写（损坏改名留证、从空表继续——暂存区不是配置），7 天清理；进
  `pdf::read_whitelisted_sync` 读取白名单（附到对话的图片出缩略图），不进诊断包；令牌不进日志 / 诊断包 / Run 记录，应用日志只记
  开始 / 停止接收、配对了一台手机。⑧电脑名用系统的 mDNS 名（macOS `scutil --get LocalHostName`，Windows `COMPUTERNAME`，
  Linux `/etc/hostname`），只收 `[A-Za-z0-9-]` 的合法名、否则不提供；macOS 默认用它，Windows / Linux 默认 IP（手机能否解析待实测）。收到的东西不执行、不自动打开；**进项目只由人点、只走已有入口**（PDF `save_paper_bytes`、图片
  `reader::write_notes_asset`、文字 `projects::append_clip_at`），编程项目与其他文件不写项目。明文 HTTP 如实写在界面上，不上自签 HTTPS。
- **会话文本出站前必须在 Rust 层脱敏**：标题/摘要、结构化回放、AI 摘要、Markdown 导出均不得把已保存密钥或常见密钥前缀
  送到 React；只作用于 DTO/导出副本，不得回写会话源文件；前端遮盖不是安全边界。**AI 提交信息（ai_commit_message）
  的 git status/numstat/diff 同样先过 redact_sensitive_text 再进 prompt**（v3.92 补齐——diff 可能含误提交的 .env/密钥）。
- **Profile 的 extra_env 排在 adapter 内置 env 之后注入**，供用户覆盖内置值（CommandBuilder 后者生效）。
- **RequestPolicy 先声明、后适配**：temperature/topP/maxOutputTokens/reasoningEffort/Header 引用先保存并校验，
  只有 AgentSpec 能力表明确支持时才允许后续注入；未知/不支持字段不得伪造 HTTP 请求体，必须在验证结果中提示。
  Header 只保存环境变量名引用，不保存 Header 密文。
  **拆层已落地**（`docs/conventions/profiles.md`）：Header 跟网关，思考档/温度/输出上限跟网关内每个模型；
  启动按选中模型求交后注入。
- **跨平台文本换行统一**：仓库文本文件以 LF 存储，由 `.gitattributes` 固定 `eol=lf`；Windows 工作区可因
  `core.autocrlf` 显示为 CRLF，但不得提交仅由换行转换造成的全文件差异。
- **普通仓库与工作区提交语义分开**：普通仓库默认不选文件，`git_commit(paths)` 与 AI 提交信息只处理用户勾选且仍在当前
  status 的安全相对路径（literal pathspec）；工作区任务始终提交全部任务改动，禁止把选择提交扩散到 worktree 流程。
- **Git 改动列表的单文件 diff 必须安全且可展开**：普通仓库只读当前 status 中经安全校验的相对路径，工作区只读当前累计
  任务 diff 中的路径；未跟踪文件按全新增展示，二进制只提示，单次读取/展示设上限并明确截断。对话页只读展示“当前项目
  改动”，必须声明它不是历史快照，禁止提交或推送。紧凑 diff 增删行**整行铺语义深底**（bg-ok/bg-err，v3.36 定稿），hunk
  标题 inset 底。**改动面板主从分栏（v3.36）**：点文件行 = 左栏 diff 主区 + 右栏紧凑文件列（右栏保持勾选框与状态徽标）；
  WKWebView 不显示 title 悬浮，操作入口用可见提示（hover 才现小字）。
- **逐 hunk 验收只覆盖未提交改动，hunks 一律取未暂存 diff（工作树 vs 暂存区）**：丢弃 = `git apply -R` 回工作树、暂存 =
  `git apply --cached` 上暂存区（`git_file_hunks`/`apply_hunk`，白名单同单文件 diff；补丁必须再经
  `patch_targets_single_file` 校验只指向该文件）；已提交的累计 diff（评审 merge-base diff）禁止逐 hunk。新文件整个算一个
  块（暂存 = 跟踪，丢弃 = 删文件）。**勾选提交遇部分暂存文件必须走临时索引提交**（`commit_selected_with_index`：
  `commit -- paths` 是工作树语义会把未暂存块一起带走；提交成功后按路径 `git reset -q HEAD --` 同步真实索引消幻影 MM），
  未暂存块保持未暂存，未勾选文件的暂存内容不得被波及。
- **应用内自动 merge/commit 必须绕过用户全局 `commit.gpgsign` 且带超时**：无头环境调 gpg 会卡住或失败。
  `workspaces` 的 merge/sync_base/finish_merge 与 `coding.rs` 的 merge/push/空仓初始提交同一口径：
  `-c commit.gpgsign=false` + `run_git` 超时（短操作 20s，merge/push/worktree 60s）。禁止再写裸 `git merge`。
- **`git branch -d` 失败不得静默回落 `-D`**：未合入基准的提交必须向用户说明；强删只在用户确认 `force` 后执行。
  删工作树时若勾了「同时删分支」，`-d` 失败要把「树已删、分支还在」说清楚，不得吞错。
- **多阶段 Git 操作必须返回结构化阶段结果**：commit/push、merge/archive、push/PR 任一后阶段失败时，前阶段成功事实必须
  保留并明示；UI 只重试失败阶段，禁止把部分成功显示成整体失败或诱导重复提交、重复合并。
- **全局配置写入/恢复按 agent 整批事务处理**：先生成并验证全部目标内容，再为同批目标建清单备份、写完并同步全部临时文件，
  最后替换；中途失败自动回滚整批。恢复分两档：「恢复备份」选最近一个完整批次（每 tag 轮换留 5 份），恢复前先备份当前状态、
  不得移动/消耗原恢复点；「恢复初始状态」走 `backups/<agent>/original/` 永久快照（首次 apply 时落、不参与轮换——
  轮换窗口会被连续写入烧穿，见架构 v3.146），快照里不存在的文件恢复即删除。
  **Codex 例外（v3.249 / v3.250）**：「设为全局」与注册只写 `config.toml`，禁止写 `auth.json`。密钥落
  `experimental_bearer_token`（ChatGPT 自带 Codex 认这个字段）。禁止把 MCP 的 `http_headers` 写进 provider 块。
- **Profile“保存成功”不等于“可用”**：验证固定三层——本地字段/活配置解析、CLI doctor/启动预检、最小 API 请求；密钥仅在
  Rust 层参与验证，结果统一脱敏。「设为全局」成功后必须自动执行本地与 CLI 配置复检。Codex `doctor --json` 只把
  `config`/`auth` 失败算 CLI 预检失败；中转探测、桌面 CDN、会话库等本机项不株连，连通性看 API 层。
- **官方账号 profile 只读检测 + env 净化**：CLI auth 文件只读探测「已连接」，断开引导用户用 CLI 自己的 logout；官方账号
  拉起不注入 API env，且必须 `env_remove` 同协议残留 API 密钥变量（防静默覆盖账号登录）；统计页官方账号显示「订阅」不计费。
  **API Key 模式不算官方账号**：凭证字段表只认 OAuth token 字段；`OfficialAccountSpec.api_key_fields`（codex =
  `OPENAI_API_KEY`）命中时显示「API Key 配置」而非「已连接」——官方 `--api-key` 与第三方中转（cc-switch 等）写出的
  auth.json 形状相同，文件层面无法区分，不得冒充官方账号。
- **各 CLI 会话/配置目录一律只读**；例外仅限用户显式操作：
  1. 「设为全局默认」（写前必须备份）；
  2. **精确注意力标记开关**（2026-10-20 起只剩 Gemini / Kimi / Grok 三家给开关：其余五家在 Mesa 里启动时用启动参数 / CLI 自带通道
     注入、不写用户配置，以前写过的由 `hooks::migrate_launch_injected` 启动时收回（同一套「只删 marker 条目 + 写前备份」）；
     开着 Gemini 开关、Mesa 条目还没有 `name` 的，`hooks::refresh_gemini_hook_name` 启动时按当前写法重写一次（同口径写前备份，
     只多一个 name 字段；2026-10-21 真实配置核对：hooks 以外的键逐字不变）；
     下列七家配置路径与防护口径不变）（hooks.rs 按 agent 写七家 hooks 配置——claude `~/.claude/settings.json`、
     qwen `~/.qwen/settings.json`、codebuddy `~/.codebuddy/settings.json`、gemini `~/.gemini/settings.json`
     （qwen/gemini 走 JSONC 容错读）、kimi `~/.kimi-code/config.toml`（`[[hooks]]` 表，toml_edit 保格式）、
     grok `~/.grok/hooks/ccode.json`、codex `~/.codex/hooks.json`；统一防护口径：写前备份（同前缀留 10 份）+
     原子写、只动 hooks 键/段、已有 hooks 追加不覆盖、关闭只删含 `hooks-state/<tag>-hooks.jsonl` marker 的条目
     并回收空壳键、配置损坏拒绝写；**grok 为整文件形态特例**——该文件整份归 Mesa（开启=写文件、关闭=删文件），
     不含 marker 的外来文件拒绝覆盖；开关走 `set_hooks_attention(agent, enabled)` 单命令（先改各家配置，
     成功后才落应用设置 hooks_attention map 逐键），失败回滚，禁前端单独 patch `hooksAttention`）；
  3. 会话删除（delete_session/delete_project_sessions：canonicalize 根校验 + **已知会话数据子目录 + 会话后缀白名单**，
     同根 auth.json/settings.json 等一律拒绝；源文件走系统回收站 `trash::delete`（可从回收站找回），与工作树删除同口径；
     **Cursor 不走目录级白名单**（~/.cursor 与 IDE 共享），由 `cursor_deletable`
     限定 `projects/*/agent-transcripts/**/*.jsonl`；OpenCode 事务删库行且 db 必须是已知候选路径之一
     （Windows 含 `%LOCALAPPDATA%\opencode`，库行删除无法进回收站）；Codex resume 链、Grok 继续链、Claude 接续链删除
     连带成员文件；Claude 成员只认与代表同目录、文件名为 uuid 的 `<id>.jsonl`）；
  4. 工作树文件删除（限定树当前根 + 重要路径黑名单：系统目录/关键用户目录/CLI 配置/.git 一律拒绝；黑名单 canonicalize
     双校验堵 symlink 绕过）；
  6. **内部对话保留期清理**（2026-10-17，`internal_sessions.rs`）：设置「数据与存储」的自动清理开关（默认开、保留 30 天）
     或「立即清理」即用户授权。目标三条件同时成立：provenance/会话 meta 标为 internal、cwd 是 `ccode-ai-<uuid>`
     临时目录或定时雷达隔离 worktree 根下、未 pin；时间不明 / 源文件已不在（只剩快照）一律不删。删除复用会话删除的
     白名单校验（`deletable_session_file`），但**永久删除**（`delete_source_file_mode(.., true)`）——成千上万条逐个进
     回收站既慢又塞满回收站；session_meta 与搜索索引随删，用量行刻意保留。另扫 `~/.claude/projects` 下名字以
     `ccode-ai-<uuid>` 结尾、无任何 .jsonl、一天内未改动的空壳目录。2026-10-17 在真实数据副本（HOME 指向 /tmp 拷贝）
     完整跑过：Codex 654 条删掉、用户会话 253→253、内部用量行 1061→1061；路径不在副本会话目录内的被白名单拒删。
  5. **会话导入**（`session_transfer.rs`：用户显式选 zip 并确认目标目录后，才把会话文件写入各 CLI 会话数据目录）。防护：
     zip 解压防 zip-slip（`enclosed_name` + 禁 `..` / 绝对路径，条目只允许 `manifest.json` 与 `sessions/`）；单文件 200MB / 整包解压 512MB / 条目数 2 万上限；
     目标路径必须落在 `session_data_dirs_at` 白名单内（cursor 另限 `projects/*/agent-transcripts/**/*.jsonl`）；
     额外放行的索引写点仅 `~/.kimi-code/session_index.jsonl`、`~/.kimi/kimi.json`、gemini `.project_root`、grok 组目录 `.cwd`（codex `config.toml` 走现有注册命令，不经本模块直写）；
     已存在同 agent 同 sessionId 一律跳过不覆盖（Claude 的 id 以文件名为准、与会话列表同口径——接续文件开头的 sessionId 是上游的，校验与查重都按文件名认；旧包记的上游 id 照旧接受）；写入走 `atomic_write_bytes`（tmp+rename）；索引类读-改-写。
     **Claude 附属目录**（2026-10-21）：导出带 `<id>/` 下的 subagents、tool-results、custom-title.json（单文件 32MB / 合计 128MB 封顶，超的不带；导出途中消失的附属文件跳过），
     打包遍历**不跟符号链接**（会话目录里的链接可能指到目录外）；导入侧附属文件尽力而为（失败不回头判整条失败、已存在不覆盖），仍只落在会话数据目录白名单内，
     只重写 `cwd` 类键与「…/projects/<slug>/<本会话id>/tool-results/」形状的路径（`remap_tool_result_paths`），文本其余部分与坏行原样保留。
     导出是只读拷贝：会话原文进包（可能含密钥），弹层明示「分享前请自查」；密钥/网关/profile 不进包；B 机浏览仍过 `redact_sensitive_text`。
  7. **会话瘦身**（2026-10-19，`session_slim.rs`：仅 Claude Code。用户在弹层点确认才写；撞网关 413 的根因与取舍见 architecture §10 当日条目）。
     **原地**把较早的 base64 截图/文档附件换成文字占位、只留最近 6 张，没动的行逐字节原样。防护：路径 canonicalize 后必须落在
     `~/.claude/projects` 内且过会话文件白名单；写前**完整备份**到 `<配置目录>/ccode/backups/session-slim/<会话id>-<时间>.jsonl`
     （目录 0700、文件 0600、同会话留最近 3 份；备份失败即中止、写失败即删备份与临时文件）；文件最近 60 秒有写入拒绝，写完前复核源文件
     长度与 mtime 没变；同目录 `.ccode-slim-<uuid>.tmp`（0600）+ `sync_all` + `storage::replace` 原子替换，并把 mtime 还原成原值；
     同一时刻只跑一次；Mesa 自己的终端标签里正在运行该会话时前端拒绝。只检测不写盘的 `session_slim_inspect` 对小于 8 MB 的文件免扫描。
     测试走 `*_at(home, …)` 注入假 home，真实数据干跑用被忽略的 `real_data_dry_run`（环境变量 `CCODE_SLIM_DRYRUN_FILE` 指向副本）。
  6. **卸载 Mesa**（`uninstall.rs`：设置 → 数据与存储。两次确认，第二次须输入「卸载」）。
     只把 Mesa 独占目录移入回收站：平台配置目录 `ccode/`、主目录 `~/ccode/`（含用户自定义过的工作副本家目录 `<所选>/ccode`，取 `ccode_home::all_roots`）、本机数据目录
     `ccode/`（目标副本），以及打包身份 `com.ccode.dev` 的网页数据（macOS 的
     `~/Library/WebKit/<身份>`、Caches、Saved Application State；Windows 的
     `%LOCALAPPDATA%\<身份>\EBWebView`）。进程退出前的最后一次写入可能把网页数据再建出来。
     浏览器收货桥清单走 `browser_bridge::native_host_dirs` 同一份目录（Windows 再删对应
     HKCU 注册表键）。前端在调用卸载命令前同步清掉 WebView localStorage 里的 `ccode.*`
     界面记忆键，兜住进程退出前的最后一次写入。课题文件夹、论文、各 CLI 的配置与会话
     一律不动。应用本体不在这里删。
- **「设为全局」/MCP 写入/技能分发的各家支持面统一查 AgentSpec 能力表**（agent_specs.rs 的 set_global/mcp_write/
  skill_dist 三字段，fail-loud：不支持必须带用户可见原因，后端报错与前端置灰同源），不再散写硬编码名单
  （mcp.rs 的 grok 只读、skills.rs 的 allow_symlink_for 等旧硬编码均已改查表）。
- **codex 默认沙箱**：交互启动注入 `-s workspace-write`（只能写当前目录）+ `-c sandbox_workspace_write.network_access=true`
  （沙箱内放开联网——默认拦网会导致文献检索/查资料每次都弹提权确认；定时任务 headless 无人可批，不开网必失败），
  AI 无头调用 `-s read-only`；用户可用 extra_env/参数覆盖。
- **诊断 unhandledrejection 跳过 monaco CancellationError**（`name` 与 `message` 均为 `"Canceled"`）：WKWebView 下 monaco 剪贴板 workaround 每次点击/按键会取消上一次 `clipboard.write`，属预期取消。上报层 `preventDefault` 且不写 `log_event`；预打包再用 Vite/esbuild 插件在 cancel 前接住 DeferredPromise。不得把这类拒绝当故障刷开发态 stderr。
- **诊断包是脱敏的有界快照**：设置页一键导出到 `~/Downloads/ccode-exports/`，包含 Windows/WebView2/GPU/WebGL、
  语言与输入法、当前功能开关、应用日志、聊天层转到终端的计数（`chat-handoffs.json`，只有 agent / 原因 / 次数 / 版本 / 日期，
  不记屏上文字与会话内容，2026-10-22）及自应用启动后的子进程生命周期；进程记录为内存环形缓冲，不读取环境变量，命令参数
  与日志在导出前必须经 Rust 层脱敏。ZIP 内只放 UTF-8 JSON/TXT，保证从 Windows 带回 macOS 后无需 Mesa 或 Windows 工具
  即可离线分析。系统级活动只额外观察 CTF/TextInputHost，禁止借诊断之名采集无关应用的命令行。
  **诊断包随反馈出站（2026-10-17）**：反馈表单（邮箱直发 / 公司端点）只把诊断包**路径**交给后端，后端经
  `feedback::checked_diagnostics_path` 过闸后自读——只认 `diagnostics::bundle_dir()` 里、名为 `ccode-diagnostics-*.zip`
  的普通文件（`symlink_metadata` 判定，不跟链接）且 ≤20MB；新增任何「把本地文件随反馈寄出」的入口都走这道闸，
  禁止前端读文件转 Base64 上送，也禁止放宽成任意路径（否则反馈通道就是一条任意文件外发通道）。
- **「是否 git 仓库」探测带 30s 负缓存**（`git_info::probe_is_work_tree`）：轮询入口（git_status/git_status_map）对非仓库
  cwd 不得每轮真 spawn git（诊断包实测 Windows 安装版 85 秒 73 次同目录探测）；只缓存否定结果，应用内 `git init` 成功后
  必须调 `invalidate_repo_probe` 主动失效。**跨来源路径比较一律走 `paths::path_key` 口径**（same_path/path_within，
  前端 `src/path-utils.ts` 同函数）：Windows 上同一路径有 verbatim（`\\?\C:\x`）与普通两种写法、分隔符与大小写都可能
  不同，字符串直接比较会静默失效（删除防护名单、recent_repos 的 home 排除、worktree 归属都曾因此被绕过）；落库与显示
  先 `strip_verbatim`。仅「同一路径判等」可用 canonicalize，且要双校验防 symlink 逃逸。
- **npm 更新用与目标二进制同目录的 npm（`updater::npm_for`）**（用错 npm 会把包装进另一个 prefix）；brew 安装的 CLI 一律
  走 `brew upgrade`。
- **交互式 TUI 自更新不走 run_streaming_pty**：kimi/opencode 的 `upgrade` 是方向键选择界面，行输入无法应答——规格标
  `PackagingSpec.interactive_tui`，`check_agent_updates` 按与 update_agent 同一套渠道判定（`updater::interactive_self_update`）
  带出预填命令；配置页「新版/更新」命中时改走 `setPendingTerminal`（shellOnly + prefillCommand，同官方账号登录机制）开
  完整终端让用户方向键操作，普通渠道零变化。
- 解析各 CLI 内部格式时**防御式**：跳过未知类型、容忍缺字段、容忍末行截断（格式随版本漂移）。
- **系统打开文档（办公「系统打开」/无法内嵌预览的 ppt·doc·rtf）**：禁止给 WebView 开 `opener:allow-open-path`（任意路径可被默认应用执行）。只走 `fs_tree::open_in_system`：`canonicalize_plain` + `path_within` 锁在调用方给出的项目根内，扩展名必须在办公白名单（与 `list_office_docs` 同源），再由 Rust 调 `tauri_plugin_opener::open_path`。目录不打开（请用「显示」）。
- **编程页添加 origin**：只接受 https / ssh（含 scp `user@host:path`），拒绝 `file://`、`ext::`、`git://`、host 以 `-` 开头、换行与控制字符。`git remote add -- origin <url>`（argv 数组，禁止拼进 shell）。HTTPS userinfo 须用户确认后才写；出站 DTO 剥 userinfo，stderr 过 `redact_sensitive_text`。fetch 失败不回滚 origin（`code=git_failed, failedPhase=fetch`）。
- **GitHub Desktop 只走文档化 CLI**：`coding_open_desktop(repo_path, path)` 现场 `git worktree list` + `same_path`，只打开本仓工作树。argv 锁死 `github <absPath>`（`resolve_binary`，没有则用应用捆绑的 `github.sh` / Windows `%LOCALAPPDATA%\GitHubDesktop\bin`）；不对 CLI 传 `--cli-open`，不走已删除的 `x-github-client://openLocalRepo`，Windows **不**给 `GitHubDesktop.exe` 传路径。macOS 再回落必须 `open -n <GitHub Desktop.app> --args --cli-open=<path>`（与官方 cli.js 相同；`open -a` 不加 `-n` 只激活窗口不切仓）。禁止给 WebView 开 `opener:allow-open-path` 或自定义协议。`gh` / `github.bat` 走 `background_command`（Windows `CREATE_NO_WINDOW`）。
- **PDF 预览（P2a）**：pdf.js 渲染器必须随 PdfPreview 组件动态 import 拆独立 chunk（禁进主包）；`read_pdf_bytes` 只放行五类
  白名单（注册项目登记资源/注册项目根/工作区·仓库根/终端标签 cwd hint/Mesa 自管剪贴板图片目录 `<config>/ccode/tmp`
  ——paste-* 写入侧已有扩展名白名单 + 50MB 上限 + 7 天清理），外加「用户亲手交来的文件」精确路径（2026-10-23，
  `attach_grants.rs`：只认原生拖放事件与 Rust 侧弹的附件选择器 `pick_attachment_files`，进程内、只收文件、不落盘；
  **禁止加「前端传路径就登记」的命令**，那等于取消白名单），canonicalize 后判定，传输用 base64 字符串（macOS
  Raw 响应会退化为逐字节 JSON 数组，禁改 raw bytes）；选段问 AI 只 pty_write 注入活跃标签输入框，不自动回车。
- **聊天区 Markdown 渲染（ChatMarkdown）**：会话内容可能含联网抓取文本，按不可信处理——独立 Marked 实例，
  原始 HTML 一律转义（raw `<img>`/`<script>` 是追踪/注入通道）；http(s) 图片不加载只显示文本，本地图片经
  `read_image_bytes` 白名单换 data URL，不新增任何读取通道。
- **Mesa 自有档案不催人提交（2026-10-17）**：`.ccode/`（台账除外）与 `.gitignore`＝后端 `BOOTSTRAP_PATHS`。项目页「N 处改动
  未存入历史」与开工弹层提醒用 `userWorkDirtyFiles`（剔除档案路径）；评审打开时若主仓脏，先调 `commit_project_bootstrap`
  （同开工前一步、同提交信息，每次打开每主仓只试一次），剩下的才交提交面板。评审提交面板仍用 `userDirtyFiles`——挡合并的
  一切都要能看见能提交。设置页改规则/选文献来源等写档案卡的动作不各自提交（避免一次点击一个提交）。
- **雷达订阅清单只有「保存」才整表写（2026-10-17）**：`.ccode/watch/<任务id>/watchlist.md` 的整表覆盖写只允许来自订阅弹层的
  「保存」（当前编辑行）。「编辑源文件」前只准走 `ensure_watch_subscriptions_file`（不存在才建空模板，存在一个字节不动）；
  禁止拿弹层的 `initial` 或任何异步未落定的状态写回——从巡检行打开时 initial 恒为空，曾一点就把已有关键词清光（实证）。
- **科研台账整份读写（2026-10-17，fs_tree.rs）**：`read_research_ledger` / `save_research_ledger` 只放行固定相对路径白名单
  （`papers/` 下 included.json、included.md、to-fetch.md、to-fetch.ris、endnote-import.ris、screening.md，`notes/index.json`，
  `references.bib`），canonicalize 后必须落在调用方给的项目根或工作区根内（`..` 与外链拒绝）；上限 16 MB；保存必须带读取时
  的版本，磁盘已变即拒（与预览保存共用 `PREVIEW_SAVE_LOCK` + `config_lock("preview-save")`）。新增要整份读写的台账先加白名单，
  不得为此放宽 256 KB 预览通道；台账读写也不得回落预览通道（截断会被当成「文件不存在」）。
- **引用健康检查（v3.63，citation.rs）**：`check_citation_health` 只读扫描 .md 与 references.bib，目标目录沿用同一
  白名单口径（注册项目根 + 工作区工作树/主仓，canonicalize 后前缀判定，无 cwd hint 来源）；扫描有界（≤200 个 md、单文件 ≤1MB）。
  聊天引用胶囊的 `cite_lookup`（2026-10-21）同一白名单：会话目录不在白名单内一律当「没有 bib」，不读；只读 bib（≤8MB、≤100 键），不改。
  聊天里文件路径就地可点的 `existing_files` 只看元数据：路径规范化后必须落在会话目录内且是文件，`..` 越界、目录、不存在都不回。
- **「整理为笔记」（P2b）**：归属判定只在后端 `pdf_owner_project`（登记资源 canonical 精确命中 → 项目根最长前缀命中，都未
  命中时前端询问是否把所在文件夹添加为项目并默认 `pipeline_opt_out`，家目录/盘符根拒绝；前端不做路径归属猜测）；
  写入只走 `append_notes_excerpt`——目标固定为该目录根内 `notes/excerpts.md`（不接受外部子路径），单次 ≤ 64KB、
  读-改-原子写、已存在文件 canonicalize 双校验防 symlink 逃逸；候选精读步由 `notesExcerptTarget` 决定（工作区名
  `lit-notes` 或挂了 lit-notes 技能的步骤；`pipeline_opt_out` 或没有精读步 → 项目根）。**该步工作区正在跑**才写进
  工作区并预填 ORGANIZE_NOTES_PROMPT；没在跑就写项目根，开工时随接驳（notes/*.md）带进工作区。
  2026-10-17 审查修复：①不再写 `notes/inbox.md`——那是文献雷达收件箱，被 gitignore（摘录进不了合并、
  删工作区即丢），主仓多出的行还会把雷达采纳卡死；②不再替人提前建精读工作区（旧口径绕开开工弹层、
  基线可能还没合并检索结果，之后正式开工撞「工作区已存在且未合并」）；③候选不再盲取流水线第二步。
- **MCP 分发（§6.15，规格 = matrix §10）**：Mesa 清单（<config>/ccode/mcp-servers.json）→ 八家用户级配置的映射写入（grok 首版只读不分发）。
  **只写用户级**（项目级各家都有审批闸）；目标文件多是混合状态文件，一律读-改-写一个键/段 + 写前备份 + 原子写 + 读回校验，
  绝不整文件覆盖；codex 走 toml_edit 保格式、gemini/qwen/opencode/codebuddy 走 JSONC 容错读；密钥一律用 `$VAR`/`${VAR}`
  引用形式，映射成各家间接引用字段（codex env_vars/bearer_token_env_var、opencode {env:VAR}、kimi bearerTokenEnvVar），
  不落明文；server 名取各家交集 [A-Za-z0-9-]（下划线禁：gemini policy 引擎按下划线切分）；claude 的 managed-mcp.json
  存在即拒写；cursor 的配置与 IDE 共享，分发同时影响 IDE。CLI 自带 mcp 命令不用于分发（各家语义不一：gemini 默认
  project scope、codebuddy 默认 local、codex add 命中 OAuth 会弹浏览器、kimi/cursor 没有可脚本化命令）。
  **收编/粘贴导入**：`discover_mcp_servers` 扫八家用户级配置列出清单外 server，`import_mcp_from_agent` 反向映射收编
  （各家字段→统一模型，引用语法逆向：`{env:VAR}`/`bearer_token_env_var` 等转回 `${VAR}`，收编即标记已分发到来源 agent）；
  `import_mcp_json` 解析 README 标准片段（剥 mcpServers/mcp/mcp_servers 包裹层，同名跳过）。
  **条目来源标记 origin 与收编条目删除分流**：清单条目带 `origin` 字段（`ccode` = 本应用新建 / `imported:<agent>` = 收编 /
  `imported:json` = 粘贴导入；旧清单无此字段 = 空串 = 来源未知）。编辑整结构替换时 origin 像 apps/enabled 一样保留旧值，
  前端传值一律忽略（新建后端强制写 `ccode`）。`delete_mcp_server` 按 `keep_agent_configs` 分流：
  true = 只从清单移除，跳过 EXTMOD 预检与逐 agent 移除循环，不碰任何 agent 配置文件；false = 维持完整行为。
  前端对 `origin != "ccode"`（含空串，fail-safe 宁可少删不可错删）的收编条目默认走「仅从清单移除」，
  「连同 agent 配置一起删除」是弹层里的 danger 次选；删除确认弹层对所有条目列出影响面（apps 为 true 的 agent 显示名）。
  收编条目分发开关由开拨关同样先确认（会把条目从该 agent 配置移除）；ccode 自建条目不加这道确认。
  **外部状态同步（只读）**：`mcp_distribution_status` 逐 server×agent 报五态——`off`（未分发）/`ok`（落盘一致）/
  `modified`（内容被外部改）/`missing`（apps 标已分发但磁盘无条目）/`disabled_externally`（agent 侧禁用，
  仅实证有 enabled 语义的三家产出：codex/grok 的 TOML `enabled` 键、codebuddy 的并列 `disabledMcpServers`
  名单；其余家宁缺毋滥不猜）。探测失败（配置损坏/读不到）按 `ok` 处理不报警。开关永远表达清单分发意图，
  状态只是事实展示，不做 watch、不回写清单；`missing` 时拨开开关先确认「将重新写入该条目」。
  codebuddy 分发/移除时会把本条目名从 `disabledMcpServers` 清掉（只动自己名下项、键保留）——
  与 codex 重写条目即丢 `enabled=false` 的「拨开 = 恢复启用」语义对齐。
  **安全闸**：清单文件 0600（对齐 keys.json）；env/header 命中常见密钥前缀（sk-/ghp_/AIza/AKIA…，复用
  `sessions::common_secret_token`）且非 `$VAR` 引用形式时，保存/粘贴导入/分发**一律拒绝**（审计收口 2026-09-08，
  不再有 `PLAINDETECT:` 二次确认放行），报错引导改用 `${VAR}` 引用；清单里的历史明文条目不删不崩、照常列出，
  但编辑与分发（`apply_to_agent` 安装方向）被同一闸拦住，直到改成引用——移除/停用/删除方向不拦。
  停用（`enabled=false`）条目的编辑与拨开单个 agent 开关只更新清单/记 apps 意图，不动任何 agent 配置，
  重开总开关才按 apps 重投。重命名是受保护迁移：新名条目全部写好后才把旧名条目从各 agent 配置移除
  （同一套读-改-写 + 备份 + 原子写 + 读回校验；旧名条目权属归 Mesa 清单，不另做 EXTMOD 预检；任一步失败不落库）。
  codex 的 stdio env 引用只支持同名转发（env_vars 白名单），改名引用（`TARGET=${SOURCE}`）明确拒写并引导改键名；
  预期产物构建不出的条目（如历史改名引用）在外部修改检测里按「被改过」保护，移除需确认。
  移除/删除前比对 agent 侧条目与当前映射产物，被外部改过报 `EXTMOD:` 确认后才强删（保护手调版本）；
  粘贴导入两阶段（`parse_mcp_json` 预览命令清单 → 确认才落库，stdio 命令=任意执行须明示）。
  **stdio 命令名落盘前深度解析**（`resolve_command_deep`）：裸名经 `resolve_binary` 落绝对路径（GUI 短 PATH）；
  node 系 shim（shebang `#!/usr/bin/env node` 的脚本/symlink，如 npx）再换成 node 绝对路径 + shim 真实路径首参——
  否则宿主 PATH 无 node 时照样 spawn ENOENT。kimi 的 MCP 只在会话启动时加载，分发后要新会话生效。
  **相对路径命令（`./` `../` 开头）先解后拦**（2026-09-03 起）：resolver（`resolve_relative_candidates`）按基准序
  条目绝对 cwd → 来源 agent 配置家目录 → 有实证的插件目录（仅 codex 的 `~/.codex/computer-use`、`~/.codex/plugins`）
  试 `base.join(command)` 命中已存在文件；收编/粘贴导入命中即存绝对路径并把相对 cwd 规范化为命中基准，
  全不命中 fail-open 照原样收进清单（收编不是写 agent 配置，存下来让用户看到再修比拒收好）；
  分发时以条目自己的 cwd 先试解，解不出才拒写（报错引导改绝对路径）。
  **命令路径健康探测（只读）**：`mcp_command_path_status` 对每条 stdio 报闭集 `ok`（绝对路径存在或裸名可解析，
  裸名合法不误报）/ `relative` / `missing`（绝对路径不存在或裸名解析不到），`$VAR` 引用式命令跳过不判；
  前端清单行打「相对路径命令 / 命令路径不存在」徽标，`resolve_mcp_command_fix` 给 relative 态出修复候选
  （唯一命中确认、多命中弹层选、无命中提示手工编辑；确认走现有保存链路，origin/apps/last_check 保留），
  missing 态只告警不提供自动修复。
  **连通性体检（check_mcp_server / check_all_mcp_servers，共用 check_one）**：批量分波并发每波 4 个、全部完成一次性
  返回（不走渐进事件）；结果沉淀进清单 `last_check` 字段（读-改-写只动该字段，编辑整结构替换保留旧值，落盘失败静默不拖垮
  检测）；stdio 每次尝试的等待上限 = `startup_timeout_ms` 按 clamp(8s, 30s) 生效（未声明 8s、remote 恒 8s），声明了仍超时的
  报错点明「已按此等待」。`startup_timeout_ms` 只被体检消费、不进分发映射；来源 = 收编 codex/grok 的 `startup_timeout_sec`
  （matrix §10.2 别家无实证等价字段不读）或编辑表单手调。**体检结果带 status 细分闭集**（McpHealthDto.status：
  handshake = initialize 握手成功 / reachable = 地址可达但握手未确认（remote 3xx·其他 4xx）/ auth = 认证失败
  （401/403）/ not_found = 路径错误（404）/ error = 其余失败——401/403/404 按「连通正常」报是假阳性，必须判失败）。
  **$VAR 引用预检**（`mcp_missing_env_refs`，只读）：与探测注入同一套引用口径（`scan_env_refs`，整值与
  `Bearer ${X}` 内嵌都算）先查 `mcp-keys.json`、再查宿主环境（空值算未设置），表单密钥栏未保存的草稿经
  `pending_secrets` 视为已填；前端在保存/拨开分发开关前给非阻断警告，同会话同一变量签名只提示一次。
  探测注入与 Agent 启动（`spawn_env_secrets`）按同一张表展开；任一未设置则整条不注入并在失败文案附提示。
  remote 401 若带 RFC 9728 `WWW-Authenticate: resource_metadata`（Undermind OAuth），文案改为「需要 OAuth 登录」，
  不与缺 API key 混为一谈；Mesa 探测不携带各 CLI 的 OAuth 令牌。
  **Codex 网关启动**：不要 `-c features.apps=false`（0.154 会把用户 HTTP MCP 收成 `mcp__<名>` 占位）。
  内置 ChatGPT apps 改 `-c plugins.codex-app-tools@openai-bundled.enabled=false`。禁止 `enable_mcp_apps`。
  远程 HTTP MCP 不要默认写长 `startup_timeout_sec`（Codex 恢复会等满超时才出画面；Consensus 握手挂死会黑屏数十秒）。
  **MCP 密钥栏**（`mcp-keys.json`，0600，键=POSIX 环境变量名）：表单粘贴明文只进此文件，清单与各 CLI 仍只留
  `${VAR}`。变量名看起来是密钥本身（`ak_` 长串 / 常见密钥前缀）拒存；Consensus 的
  `Authorization: Bearer ${ak_…}` 保存时改写为 `Bearer ${CONSENSUS_API_KEY}` 并把密钥收进此表。
- **技能同名导入不得静默跳过**：导入返回 added/updated/skipped/conflicts；覆盖前备份、另存为校验单段安全名称，ZIP 先
  staging，元数据保存失败回滚。GitHub 来源保存 repo/ref/subdir/revision；**一键应用更新**（`apply_skill_update`）按记录的
  repo/ref/subdir 重下并只覆盖同名技能（`import_zip_impl` 的 `only` 过滤，同仓库其他技能不新增不覆盖，走同一覆盖+备份
  路径），上游改名/移动时明确报错并引导手动重新导入；手动重新导入仍走冲突确认。新建/编辑
  走 `create_skill`/`update_skill_content`：重名拒绝并引导改用「编辑内容」；编辑经临时目录走既有覆盖路径（覆盖前备份、
  辅助文件保留、source/repo 不改写）；◈ 优化开终端让 Agent 直改库文件，备份兜底仍靠保存/覆盖路径。**内置技能更新**
  （`apply_builtin_skill_update`）= 先预览 SKILL.md 与随包脚本并绑定目录摘要，再持进程/OS 锁确认摘要未变；全部原件备份后写入，失败恢复本批文件。保留同目录 `.bak-<yyyymmdd>`（重名追加后缀）供人工恢复，辅助文件不能静默漏更新。
- **技能删除保护（与 MCP 同思路，语义不同）**：删除 = 删 SSOT 库条目 + 回收各 agent 已分发副本——没有 MCP 那种
  「保留 agent 侧」选项，因为分发出去的本就是 Mesa 管的链接/带标记副本（`remove_ours` 只动这两类，用户自放内容天然不碰）。
  删除确认走应用内弹层（`src/pages/SkillsPage.tsx` DeleteSkillModal，禁原生对话框）：所有技能列影响面
  （apps 已分发的 agent 显示名）；内置种子（`source == "builtin"`）额外警告「删除后不会随启动恢复」
  （播种只补缺失不复活）；外部导入提示来源渠道。删除前 `delete_impl` 必先把库目录 rename 进
  `<config>/ccode/skill-backups/<name>.<时间戳>`（每技能留 5 份）——这是唯一的恢复路径，弹层文案必须与此一致。
  **来源口径 = 持久字段 `source` 单一出处（不另加 origin 列）**：builtin=种子 / ccode=自建（v3.100 起
  `create_skill` 写入，更早的自建与本地导入同记 local 无法区分）/ local / zip / github / discovered；
  fail-safe 与 MCP 同向——旧 local 与未知值前端一律按「非自建」提示来源（`src/skill-delete.ts`，
  宁可多提示也不错删警告）。
- **技能接口声明（inputs/outputs）与产物冲突/链路检测**：技能 SKILL.md frontmatter 可声明 `outputs`（产物路径）与 `inputs`（读取路径）字段（YAML 列表，行内 `[a, b]` 与多行 `- a` 两种写法解析都容忍，缺字段 = 空数组；目录带尾斜杠、文件写全路径，只声明主要读写产物），`parse_skill_md` 解析进 `SkillDto.outputs/inputs`（list 时现算，不入库文件）。`compose_skill_md`/`update_content_impl` 支持写接口声明，普通编辑（interface=None）保留库中已声明的 inputs/outputs 不静默丢弃。外部技能未声明时由 `infer_interface_from_body` 从正文推断兜底（逐行找路径 token、按行内动词分类读入/产出、双侧动词不猜、每侧上限 8 条；推断只进 DTO 并打 `interface_inferred` 标，不回写 SKILL.md）。分发随目录走不受影响，CLI 端对未知 frontmatter 字段一律忽略。检测为纯逻辑（`src/skill-conflicts.ts`）：① `skillOutputConflicts`——同一步骤挂载技能的 outputs 两两比对，同一路径或两个目录互含才报冲突（目录与其中一份报告文件不算，避免 lit-search/zotero-sync、写作/bib-check 误报）；② `skillChainWarnings`——技能 inputs 对「上游步骤产物 + 本步骤声明输入 + 项目资源」（调用方汇总成 supply）逐条找供给，outputs 对本步骤 expectedArtifacts 对账（含 `*` 通配与目录/文件互含判定）；多阶段技能只要有一条产出对上本步产物，其余阶段产出不报；缺供给/本步完全对不上才报；推断接口照检但文案标「推断」。StepSkillsChips 警告行逐条提示——只提醒不拦截。
- **技能分类批量回填**：`backfill_skill_categories` 只给「GitHub 来源 + 无分类」的技能补仓库名分类（自动分类 #15 之前的存量导入），已有分类一律不动、幂等；入口在技能页顶部 ⋯。

- **科研工具读取边界（2026-09-11）**：Zotero SQLite 仅只读连接+在线备份到内存；取得一致快照失败不可退回裸复制。项目资源/文献来源写回与模板应用持项目配置进程锁+OS 锁；前端不得用导入前配置覆盖后端新增资源。阅读区对外部 PDF 只放行精确登记且 readonly 的 paper 资源，笔记仍只写项目 notes。Origin/Blender 执行不声称受工作树 OS 沙箱保护，默认新输出目录、显式执行、不碰个人已打开工程。
