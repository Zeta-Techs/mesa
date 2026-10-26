# 代码地图（源码逐文件注释）

> 2026-09-22 自 AGENTS.md「代码结构」整节迁入（原文未改）。
> **改任何源文件前先查它的条目**——条目里是职责边界、红线和双端镜像口径，不是目录装修。
> 迁移新文件进本图时保持在 AGENTS.md 时代的老规矩：一行职责 + 只在非显而易见处写注释。


```
docs/                        # 架构方案 + 九 CLI 适配参考（规格）
  conventions/               # 主题化约定细则（改动对应领域前必读，见「关键约定」索引）
src/                         # 前端 React + TS + Tailwind v4（vite 插件接入）
  pages/                     # 侧栏九页：工作台▣ 项目⛁（workspaces，v3.92 起 UI 页名「项目」） 运行⌨（terminal） 对话◔ 连接⇄（profiles） 技能✦ MCP⌗ 用量◫（stats） 设置⛭
                             # 定时任务不是侧栏页（2026-09-13 用户移除）：只是项目「定时任务」页签；
                             #   页切快捷键（hotkeys.ts PAGE_HOTKEY_DEFS）、设置页「启动时进入」与 settings.rs KNOWN_PAGES 同为九页清单，
                             #   全局 page id schedules 仅作旧值重定向（App.tsx 转项目定时任务页签），SchedulesPage.tsx 已删
  components/                # WorkspaceReviewView、PipelineEditor（含「＋ 从模板追加」）、ProjectGroup、ArtifactChecklist（文本类产物就地预览层；pdf/docx/表格/图同页弹层 +
                             # md 笔记「⛶ 沉浸阅读」入口（v3.98：pdf_for_note 配对后发 readerReq 带 notePath 进阅读区）+
                             # 拖出手柄（GripVertical）经 tauri-plugin-drag 做 OS 级文件拖出——WebView HTML5 拖拽出不了窗口）、TaskCardsSection、FileTree、
                             # FilePreviewEditor、PdfPreview/DocxPreview/XlsxPreview/ImagePreview、ImagePairView、GitPanel、HandoffPicker/DigestPicker、SessionSlimDialog（会话瘦身确认弹层：先讲清动什么、结果页给备份位置与「客户端里需归档再恢复」提醒；提示条与菜单项在 SessionsPage 回放头部）、
                             #   PDF 字节模块级 LRU 缓存（loadPdfBytes，上限 8 份）：预览⇄阅读区重挂载不再重走
                             #   read_pdf_bytes IPC+atob+解析三程，骨架期只剩 pdf.js 解析一程；PdfPageView 页内标记层 marks
                             #   （查找/标注/跳转一闪：按摘句重定位、页内百分比矩形、文本层之前不接指针，scrollTo nonce 居中）、
                             # KickoffConfirmDialog（开工确认弹层：TASK.md 预览/编辑（草稿优先）+ 旧简报并入兜底 + 技能区（含 MCP 归处标记）+ 人工事项区 + 主仓提醒 +
                             # 上一步收尾软门：紧邻上一步非可选 after 事项未勾 → 「确认开始」二击变「仍要开工」才开，只确认不阻断）+
                             # 未存进历史软门（2026-09-20）：未提交改动与本步 inputs 相交（相交判定 src/kickoff-dirty-gate.ts）→ 列文件 +
                             # 就地「存进历史」（git_commit 只提交命中子集）/二击开工；不相交仍只是主仓提醒行（想法期实验改动留在主仓合法）；
                             # 2026-10-17 版式：KickoffRow 标签列（读入/产出/执行/思考档/技能/权限/任务书）同列对齐，按钮字号靠容器继承；
                             # 上游未保存软门：unsavedUpstream（ProjectGroup 按步进器状态算）置顶 + 「去评审」，与收尾软门共用二击；
                             # 工作区名在标题行，不挂弹层 title（会悬浮压正文））、
                             # ResearchToolPreflight（开工技能/工具只读预检：全部就绪只出一行「已启用到 X」，有缺口才展开带分发/重测的块）、
                             # FigureVisionNotice（开工弹层「技能」行下：步骤挂 review-figures 而所选模型能力库查到不能看图 / 查不到时提醒一行，文案在 figure-vision.ts）、
                             # StepSkillsChips（步骤推荐技能 chip 区：只读/可编辑两态 + 产物冲突/跨步骤链路 ⚠ 警告行；bare = 不画标题行，供开工弹层标签列用）、
                             # HumanTasksList（人工事项清单 + useHumanTasks 共享逻辑；待确认清完且未手动取消才自动勾）、StepFlow（步骤内协同流程线；付费墙行已登录显示「已登录」，未登录才是「登录学校账号」（直接调起浏览器，点「登录好了」记本机标记，见 inst-access）；拖进待获取清单按文件名、DOI、PDF 元数据里的 DOI 和 PDF 内标题对条目）、
                             # ScheduleSection（定时任务：唯一挂载点是项目「定时任务」页签 ProjectSchedulesView；
                             #   onSchedulesChanged = 任务集变更回调，定时任务页里喂 ProjectSchedulesView 的版本号桥；
                             #   2026-10-23：CadenceFields 五种周期（每天/工作日/每周/每 N 小时/仅手动）三个弹层共用；行内「下次 …」、
                             #   已自动暂停 + 重新打开；历史行跳过 ↷ / 无新内容淡显不给去评审 / 补跑·手动小标 / 看过程（setOpenSessionReq）；
                             #   ⋯ 带附言运行（RunWithNoteModal）、跨轮记忆（MemoryModal，仅非雷达）；编辑弹层管积压闸门与单次上限；
                             #   落盘弹层预填 AI 周期建议；showOthers = 底部「其他项目的定时任务」只读总览，只 ProjectSchedulesView 开；
                             #   同日使用收口：workMode 定新建默认种类（非科研不列文献雷达）与空态示例；行上去掉技能名和连接下拉，
                             #   第二行「上次 …」带去评审 / 看过程；运行配置收进「更多设置」；新建 / 落盘后 trialFor 提示试跑）、
                             # LitWatchCard（「◔ 文献雷达」卡片：近 8 周趋势（全部缺巡检日时可按巡检日补记）+
                             #   命中固定两行（标题一行；第二行摘要+徽章+日期+加入积累，解读/来源/⋯ 悬停才现；无获取全文）+
                             #   书标三态：加入积累只写账不跳转；已积累点击＝展开「积累 N」抽屉定位该篇（移出只走抽屉 ✕）；
                             #   仅在正典（不在积累账）点击＝打开已存全文或说明去处——精读/笔记/全文入口统一在抽屉，
                             #   「精读」有笔记（list_paper_notes×noteLinkForPaper）显「继续精读」+
                             #   待人工下载：官网/等待收货+取消/关联/✓已存/打开 papers/ +
                             #   新命中默认两行对齐精读清单密度（摘要点开才见）+
                             #   期刊徽章（IF/中科院分区/TOP，数据源 journal_metrics.rs）+ 新命中按日期/按关键词分组切换 +
                             #   卡头期刊指标表入口常驻（未装=↓下载 / 已装=↻重下即更新）+ 卡头「筛选」弹层
                             #   （litWatchFilter：IF/分区/TOP 三条件，被筛掉条目「查看全部」临时态），唯一挂载点 ProjectSchedulesView（项目「定时任务」页签，仅科研工作方式渲染）；
                             #   空态入口只认有任务的卡（2026-10-12）：没订阅时若有雷达巡检出「还没订阅读+订阅关键词」，
                             #   连雷达巡检都没有则整块不渲染——订阅无任务不跑，定时任务页只留「＋ 定时巡检」主路；
                             #   schedulesVersion prop = 同页任务列表增删改的桥（新建/删除不发 scheduler-run-done，靠它重拉））、
                             # ReaderTlFloat（译文「译」悬浮球：可拖动（位置记 readerTlBall），点球在球旁展开译文卡、
                             #   × 收回球，新翻译落地自动展开；钉住档与右栏收起兜底档的载体）、
                             # ReaderOverlay（沉浸阅读区全屏覆盖层，v3.96：三栏「笔记｜PDF｜Agent 终端」，fixed inset-0 z-40，
                             #   左右栏收起＝栏块常挂载负 margin 滑出（ccode-reader-panel，宽度不变：Monaco/xterm 零重排零搬移，
                             #   PDF 适配重算在 PdfContinuousView 停稳防抖收口；禁止改回条件卸载），
                             #   Esc 退出级联最优先（焦点在右栏时归右栏），底下终端/PTY 保持挂载；右栏 = 阅读会话标签的 xterm 宿主
                             #   与聊天层宿主（data-chat-host）一起搬进同一槽位，标题行「聊天/终端」切 surface（ccode.readerSurface 记忆，
                             #   peek 靠槽位 data-reader-surface 的 App.css 规则摆位），注入由 TerminalPage 供给（聊天层时不发送的进聊天输入框）；
                             #   跨页进入的退出回来源页（setReaderReq 在 store 层自动记 fromPage、closeReader 回跳）+
                             #   退出同时直接关阅读会话标签、不弹确认（正在生成的回应一并中断；requestCloseTab 的「进程活着」
                             #   判定对常驻交互式 CLI 恒真、每次退出都会弹，故不走它；2026-09-20 用户拍板）+
                             #   进入启动占位：标签派出前不闪「未在运行」卡、CLI 开屏前 xterm 黑底用遮面盖住（PDF 栏加载给页形骨架；
                             #   遮面重启触发器 = agentTabId——关掉旧标签重进后旧 startedAt 会原样带回来，
                             #   以它为触发器不重新挂遮面会露裸黑 xterm））+
                             #   PdfContinuousView（连续滚动 PDF 栏：±2 页虚拟化懒渲染、选段浮动条（译/高亮/◈问 AI/＋生词/⋯ 批注·直接发送）、▦ 圈选截图、
                             #   ⌘+点击段落对照（结果进同款浮卡）、进度记忆/护眼反色/术语淡高亮、
                             #   ⌘/Ctrl+滚轮与触控板双指捏合对准指针缩放；2026-10-18：查找条（findHotkey 接线才拦 ⌘F，
                             #   capture 相止传播）/目录（PDF 自带书签）/页码点击跳页/标注列表与高亮小卡/外部 jumpReq（页码·图表）/
                             #   页内标记 marks 按页 memo 交 PdfPageView）、
                             #   阅读区 2026-10-18 补齐：笔记 watcher 自订一份（标注高亮与「让 AI 起草」显隐看盘上笔记）、
                             #   reader_paper_title 顶栏真实题名、标注增删/在笔记里看/笔记→PDF 跳转接线、悬浮译文卡 floatBounds（PDF 栏边界）、
                             #   spotCheck prop = 精读步抽查核对档（2026-10-23：pdfPath/notePath 按篇由 spot_check_item 解析，工作区笔记只读，
                             #   右栏换问题单、不派阅读会话；口径 terminal.md「抽查核对档」）、
                             # SpotCheckPanel（抽查核对档的部件：useSpotCheck 状态 hook（当前篇/已看/解析缓存/问题单）、
                             #   SpotCheckStrip 顶栏下切篇条、SpotAbstractPane 无 PDF 时中栏摘要、SpotCheckPanel 右栏问题单与两个收尾按钮）、
                             # TemplatePickModal（科研项目注册成功后的研究流程模板选择层：顶部课题主题 +
                             # 六套内置模板 + 「不使用研究流程」（写 pipeline_opt_out 标记；只读文献走这条）/
                             # 「稍后再选」（不留痕，已填主题仍落盘）两出口）、
                             # CodingProjectView（编程左分支地图右会话可收：基准作根、工作树/未检出分支经轨道挂主干；工作树事后分组、行内图标动作）、
                             # FuseDraftModal（「◈ 融合进任务书」预览编辑弹层：AI 融合稿可改后确认才写草稿）、
                             # TerminalStatusBar（终端底部常驻状态栏：未启动只留状态点 + 📂 目录胶囊；
                             #   进程起来后才有模型/思考档可点切 + git 芯片/保存/推送 + 时长/token；阅读区搬进右栏时不出 git 胶囊；
                             #   窄于 560px 自动收掉连接名/思考档/token、模型与目录截断，防叠字；
                             #   聊天变体留左右两格 chatMetaRef 给 ChatSurface portal 挂「权限 · 项目 | 模型」，2026-10-23） 等
  App.tsx                    # 应用壳：标题栏（收件箱/帮助/命令面板）、三段式侧栏（快速入口/项目树/系统段）、主区 page 驱动挂载、
                             #   全局快捷键、启动过渡、跨实例同步、通知、确认框宿主。侧栏纵向间距收紧（2026-10-25 用户：品牌区到导航、导航到「项目」嫌松）：品牌区 h-[34px]、导航区 pt-1、项目区 pt-1.5。侧栏（2026-10-16 定稿）：品牌区下是快速入口
                             #   （工作台 ⌘1 / 新对话 / 运行（常驻）/ 搜对话），中段项目树（ProjectTree，课题下挂对话），
                             #   底部资源段（连接/技能/MCP/用量/设置：展开态平时连接、设置 + › 记号，悬停这一排抽屉滑出技能 / MCP / 用量（RAIL_MORE_PAGES，`.ccode-rail-drawer`，2026-10-25）、图标态竖排五个）；收起态=图标条（项目树不可用，展开后才有）。
                             #   主区：page==="workbench" 显示工作台概览、page==="workspaces" 显示选中课题详情（选中经 selectProjectReq
                             #   一次性请求由项目页消费——与收件箱/对话页/统计页跳转同一条链，禁再拿它当持久选中态渲染）。
                             #   壳与标题栏/侧栏/缝透明，桌面磨砂从窗口底透上来；
                             #   顶栏帮助菜单（HELP_MENU：命令面板左侧 ? 钮，分组下拉，关闭范式同收件箱；首项「上手引导」）；
                             #   侧栏系统段上方「上手引导」行（useOnboardingRail，引导进行中才渲染，data-onboarding-anchor 供清单定位）
  components/ImageGenPanel.tsx # 出图模型一块（连接页最下方，唯一编辑处；设置页只显示现状跳过来）：组头 + 一行与连接行同列模板
                             #   （gridClass 由连接页传入）；更换走 ImageModelPicker；「试出与对比」自写描述、1–4 个模型并行出图、
                             #   估算进度条、「用这个」；最近用过 / 各模型耗时存 localStorage；setImageGenModel 供连接行「改作出图模型」
  components/ImageModelPicker.tsx # 出图模型选择浮层：搜索 → 最近用过 → 推荐（各家最新）→ 按家族折叠；下方放不下翻到上方
  components/InternalSessionsCard.tsx # 设置「数据与存储」→ Mesa 内部对话：条数/体积/最早、自动清理开关、保留天数、立即清理
  components/InsertMenuItems.tsx # 「插入技能/MCP」菜单条目：运行页收缩行、标签栏 ✦（仅终端层）、聊天输入框 ＋ 三处共用（只画 <li>，浮层由调用方定位）
  components/ConversationView.tsx # 对话渲染（聊天层 / 对话页回放 / 项目对话预览共用）：气泡与正文、一轮过程收在「已工作 X 分 Y 秒」下，
                             #   展开为动作行（点行看差异 / 命令输出 / 思考），回答露在外面；working 由聊天层传（进行中不收起）；
                             #   AI 回复不截断、用户长消息 UserText 量行收起；字号走聊天阶梯类（design-system「聊天正文排版」）
  components/ChatMarkdown.tsx # AI 回复 Markdown（独立 Marked 实例、原始 HTML 转义）：长回复分节小标题按级别排、ChatCodeBlock（用户气泡里的
                             #   围栏代码同一套）、上屏后 useChatDecorations 跑表格壳 / 代码高亮 / 公式 / 引用胶囊 / 文件链接，音频播放条、图片卡
                             #   （图片卡点击：聊天层经 ChatImageEditContext 进输入框标注台接着改；只读视图有工作目录走右栏预览，随手聊弹 ChatImageViewer）
  components/MergeConflictView.tsx # 保存撞车的对比合并：Monaco diff 左磁盘只读、右我的可改，保存右边以磁盘版本为基线，再撞车刷新左边
  components/SlidesPreview.tsx # PowerPoint 逐页大纲（标题 / 要点 / 第一张图 / 备注 / 首页缩略图）+ 看原样（PDF）
  components/OfficePdfView.tsx # Word / 幻灯经 LibreOffice 转出的 PDF 视图（原文件改了重转）
  components/NotebookPreview.tsx # Jupyter 笔记本按单元预览（Markdown / 高亮代码 / 输出文字图表格报错），「源码」切回编辑器
  components/MediaPreview.tsx # 音视频预览：grant_media_url 放行后经 asset 协议流式播放，放不了的编码提示系统打开
  components/UnsupportedPreview.tsx # 本来就不在 Mesa 里预览的文件（二进制 / 旧版 doc、rtf）：中性说明 + 系统打开 / 在文件夹中显示
  components/MdFrontmatterCard.tsx # md 阅读态开头 YAML 头小卡（只展示，超 6 项折叠，双击回编辑态第 1 行）
  components/ChatImageViewer.tsx # 对话图片看大图弹层（Modal + ImagePreview 可缩放）：随手聊没有右栏预览时用
  components/ChatImageStage.tsx # 输入框上方的看图标注台（design-chat-layer §4.7）：盖住对话区、不挡输入框；
                             #   意见框 / 画笔 / 箭头 / 打码 / 裁剪 + 撤销清空，标注存原图坐标交回输入框；
                             #   onQuickText 给了 = 从对话里点进来接着改的图：改图提示 + 「移除背景 / 调整画幅」写进输入框（不直接发）；
                             #   MarkupLayer = 标注的 SVG 画法（标注台与缩略图共用，几何与导出同源 image-markup.ts）
  components/ProjectTree.tsx # 侧栏项目树（展开态）：「项目」标签行（计数＋放大镜＋添加入口）+ 一节一节平铺的随手聊与课题；
                             #   放大镜开 RailSearchPalette（对话和项目一起搜，料由 searchSources 现组：置顶 / 随手聊 / 各课题的全部对话，
                             #   不受「展开更多」限额），树本身不再就地筛。树滚动区顶 6px / 底 12px 渐隐（底部留 12px 内边距），分节标签（项目 / 置顶 / 其他打开的）左缘对齐导航图标左缘 16px（2026-10-25）。`liftCurrent`（只 App 里探出层传）时正聊着的课题（currentKey 对应行）整块提到随手聊上面、不参与拖动排序；展开侧栏不提（2026-10-25 用户）。分三层（2026-10-24）：分节标签 RAIL_SECTION_LABEL / 课题行最前
                             #   renderFolderToggle（文件夹图标，悬停换箭头，点它开合）+ 课题名 xs l4 分组标题 / 对话 pl-2 不缩进（2026-10-25）
                             #   工作区清单（课题的工作副本）在开着的对话出现认不出归属的目录时重读一次（reposTick；开步刚建的副本），
                             #   重读后仍认不出的签名不变、不反复读
  components/RailSearchPalette.tsx # 「搜索对话和项目」弹层（2026-10-24 照 Claude 客户端）：只管列和选，打开由宿主回调；排序筛选在 rail-search.ts
  rail-search.ts             # 搜索弹层纯逻辑：空查询=最近对话 50 段；有查询=命中项目在前、命中对话在后（标题命中先于只命中文件夹名），多词全中
                             #   （2026-10-23 照 Claude 客户端侧栏，不再按工作方式分组；置顶 / 课题 / 未添加三段，段内可拖动排序）
                             #   （注册项目 + list_workspaces 推导的「未添加」仓库段；重拉触发=store.projectsVersion 管理动作代数
                             #   与 projectPaths 签名变化）。行点击=onSelect(repoPath)（App 侧 setSelectProjectReq+setPage）；
                             #   行右键=重命名/复制路径/从 Mesa 移除/清除痕迹/删除目录，动作自持（invoke+confirmDialog+toast），
                             #   完成后 loadProjects+bumpProjectsVersion 通知本树与项目页重拉；
                             #   2026-10-23 挂对话（纯逻辑 sidebar-chats.ts）：最上面「随手聊」、节头名字后的箭头开合对话（默认只展开运行页
                             #   正看着的那个，人手开关记 ccode.projectTreeChats）、展开按侧栏空位列（至少 5 段）+ 「还有 N 段 / 收起」，行尾运行状态光标（RunCaret，收着也报）；
                             #   点对话 openConversation（只看不起进程）；点课题名进项目页并展开它的对话（10-24）；行尾悬停 ＋（startProjectChat / openQuickChat）与 ⋯ 平时不占宽；
                             #   对话行尾 ⋯ 与右键：在右侧分屏打开 / 停下 Agent（开着在跑才有）/ 重命名 / 归档 / 在对话页查看；会话列表自己保鲜（展开拉一次、看得见时每分钟）；拖动按整块（tabDragShift）；
                             #   2026-10-24 第二期（运行页标签条退场）：开着、列表里还没有的挂在文件夹最上面（openTabRows，带 ×，经 store.requestCloseTab 关），
                             #   不在任何项目里的单列「其他打开的」（展开态没有「运行」行了，在跑靠各行行尾的光标 + 折起项目头上的光标）
                             #   （2026-10-17）根节点 flex-1 吃满父 flex 列（否则长列表被 aside overflow-hidden 裁掉不滚动）；
                             #   搜索框 .ccode-rail-search 玻璃薄雾、课题 >5 个才出；active=page 是项目页才铺选中底，
                             #   否则当前课题只加粗；分组折叠记 localStorage ccode.projectTreeGroups；
                             #   同文件 TitlebarProjectChip（顶栏项目芯片）+ useProjectSwitch + ProjectSwitchPanel 专用面板（不用 ContextMenu：
                             #   自动聚焦搜索、>8 个先列「最近」5 个、分组可折叠且与树共用 GROUPS_KEY、搜索态扁平结果+命中加亮+
                             #   方式标签、↑↓/回车/Esc、限高内滚、视口钳制）
                             #   （projectRailStatus 复用），待处理黄点归顶栏收件箱不在此算。选中高亮吃 contextLabel.projectPath
                             #   （项目页唯一写入方的当前项目镜像，单一事实源）。「＋ 添加项目」经 store.addProjectOpenReq
                             #   一次性请求交项目页（完整注册流程在那里），同时 setPage("workspaces") 保证消费方已挂载。
  components/RenameProjectModal.tsx # 重命名项目弹窗（register_project 幂等 upsert）：从 WorkspacesPage 拆出（页面是懒加载 chunk，
                             #   侧栏树在主 chunk，静态引入会把整页拖进主包），树右键与页面共用同一份
  navigation.ts              # 导航清单单一出处（九页全量）。侧栏本身不按本表渲染（App.tsx 自排三段），本表供隐藏态导航胶囊
                             #   （TopNavCapsule）、设置页「岛上显示的入口」勾选消费——删页会静默弄坏这两处；顺序与字同图标态侧栏
                             #   （2026-10-24：工作台 · 运行 · 搜对话 · 项目；新对话不是页，岛上插在工作台后；page = 停在这一页时报的页名）；
                             #   「运行」只留给岛上休眠面报页名，不是任何地方的入口（同日撤出图标态侧栏、岛、快捷键）
  App.css                    # 主题令牌与壳层样式。侧栏罩色：展开 42%、图标态 28%、选中行 88%；Linux 与减少透明度回落实心
  feedback.ts                # 反馈与提需求纯逻辑：类型闭集/环境行/正文与主题拼装/mailto 与网页邮箱链接/端点负载/截图常量（≤3 张 ≤2MB）/发送方式闭集与默认（记本机 ccode.feedback.channel）/附件注记（tests/feedback.test.ts）
  components/FeedbackModal.tsx # 反馈表单弹层（帮助菜单、诊断弹窗「附到反馈」、设置→关于三入口）：端点已配只走端点，否则用户选发送方式（邮件应用/网页邮箱/邮箱直发）；附件=截图缩略图+诊断包（表单内现导出或 attachDiagnostics 带入，后端按路径白名单自读）；邮件类通道附件落盘+交接提示（清空/保留草稿由人定）；邮箱直发配置视图（保存并测试、结果就地显示、首存失败回滚授权码）
  components/UpdateNotes.tsx # 更新说明渲染（Markdown→浅底框，原始 HTML 转义、链接/图片只留文字）；设置→更新卡片与帮助「检查更新」弹窗共用
  components/ChatHandoffStatsPanel.tsx # 设置「诊断」→ 聊天层转到终端：按 agent + 原因 + 细分的次数排序、近 30 天 / 全部、清空
  components/ChatBetaBadge.tsx # 聊天层「测试版」说明（useChatBeta + ChatBetaNotes）：2026-10-23 起在模型菜单底部一行的二级页，说这一家的档与要回终端的事，CLI 比核对过的新时芯片带点并提醒
  components/HelpDialogs.tsx # 帮助菜单三个内容弹窗：诊断与日志（日志按级别筛/计数/复制 + 导出诊断包 → 附到反馈）、检查更新（打开即查；状态/更新说明/下载进度/安装，安装走 useAppUpdateInstall）、关于（图标/版本复制/更新状态只读 store/仓库与许可入口，许可页同弹窗切换）；快捷键速查曾短暂存在后按「不与命令面板/设置/说明书重复」删除（2026-10-12）
  components/ThirdPartyNotices.tsx # 「开源许可与致谢」内容区（帮助→关于、设置→关于共用）：致谢与数据来源（Markdown 阅读版式，许可全文收进 details，链接交系统浏览器）/ 组件许可（可搜索）两页签；清单读一次进程内缓存
  third-party-notices.ts     # 随包许可清单解析纯逻辑：依赖表拆组拆行（跳过代码块里的 ##、丢弃文件头生成说明）+ 按名字/许可搜索（tests/third-party-notices.test.ts 含真文件格式守卫）
  components/MesaMark.tsx    # Mesa 光标标志的字标版（去底板，M 跟文字色、光标品牌琥珀 + 深色底余辉，viewBox 裁到图形、底边即基线）；聊天空态问候在用
  components/MesaThinkingDots.tsx # 聊天「回到最新」浮钮生成中的三枚琥珀光标：每 3.2s 随机换队形（jump-formations.ts），位置走 CSS translate 过渡，呼吸在 App.css .ccode-jump-dots；减弱动态效果时不换队
  components/CommandPalette.tsx # ⌘K 面板：默认列表 快速操作/最近项目（list_projects 前 5）/页面（快捷键跟随设置）/外观/帮助；设置分区（SETTINGS_SEARCH_INDEX）、单个主题、较早项目、外链只在搜索时出现；「切换主题…」进主题网格（与设置页主题卡同长相、7 列深浅上下对齐、方向键四向移动、当前打勾；色样懒加载 App.css?raw；跟随系统只列与系统同深浅的一排并走 followedTheme）；输入法组词 Enter 不执行、↑↓ 循环、键盘移动跟随滚动；帮助类动作经 onHelp 交 App 的同一批弹窗（「上手引导」直接调 openOnboardingGuide）
  money-format.ts            # 金额千分位两位小数 groupedMoney（用量页费用、网关余额共用；币种与 ≥ ~ 前缀由调用方拼）
  project-tree.ts            # 侧栏项目树置顶与组内顺序纯逻辑：togglePin / splitPinned（置顶段按先后、移出原分组）/ parsePins（坏数据当空表）/ applyOrder + reorderGroup（拖动排序，只比同组相对先后）；
                             #   localStorage ccode.projectTreePins；tests/project-tree.test.ts
  usage-dist.ts              # 用量页分布区纯逻辑：shareOf/barWidthPct/sharePctLabel、visibleDistRows（先露 10 行、≤12 行不折）、
                             #   toTsv（复制表格，格内换行/制表符压空格）；tests/usage-dist.test.ts。StatsPage 的 DistList 统一渲染六个页签
  phone-drop.ts              # 从手机添加纯逻辑（docs/design-phone-drop.md）：条目动作可用性（其他文件不放进项目）、放进哪个项目
                             #   （对话目录所在科研/办公项目最长匹配，否则最近打开；编程不放）、状态/收件箱/停止原因文案、
                             #   已配对手机的「上次用」行（tests/phone-drop.test.ts）
  phone-drop-store.ts        # 从手机添加界面状态（独立 zustand）：接收状态、收到的列表、弹层、目标输入框；后端三事件只在
                             #   usePhoneDropEvents（App 挂一次）里接，输入框只从 deliveries 取自己那份（防多监听器各改各的）；
                             #   starting 期间丢弃旧会话迟到的「已停止」事件；openForComposer：有已配对手机就直接开始接收不弹窗；
                             #   没有目标输入框时收到东西自动弹窗（onArrive 交 App 发系统通知）
  components/ProjectFilePicker.tsx # 聊天输入框「＋ → 引用项目文件」弹层：list_recent_files 最近改过的在前、search_files 搜整个项目（只留文件）、
                             #   每次打开是列表（可换网格）、滚到看得见才画缩略图（file-thumb.ts）、点行多选、双击直接添加；添加 = ChatComposer addPathAttachments（同「文件或图片」）
  components/PhoneDropDialog.tsx # 从手机添加弹层（App 全局一处；入口：聊天输入框「+」/ ⌘K / 收件箱「手机」）：二维码（后端 SVG，
                             #   data: URL 进 img）+ 地址复制 + 换地址（电脑名 / 各网卡 IP）+ 「扫了打不开？」；有已配对手机时顶上是状态卡、
                             #   二维码收进「配对新手机」、已配对的手机折叠（移除）；收到的列表带 96px 缩略图（读一次画小图只留小图，
                             #   模块级缓存）、点开走 OfficePreviewModal（displayName 用原名、↑↓ 翻、右下一个后续动作）、文字就地展开；
                             #   从输入框打开的「收起」接收继续，⌘K 打开的「完成」即停止
  components/ClientOpenDialog.tsx # useClientOpen 钩子 + 确认层：对话页底栏/右键菜单与工作台项目行共用；预检全过直接打开，有 note/warn/fix/block 才弹层（Codex 缺渠道「写入并打开」可选连接，Claude 渠道会变提示，被拦只给原因/下载入口）
  components/FileTypeMark.tsx # 文件类型线条图标：FileTypeGlyph（Lucide 线条 + 识别色经 --file-glyph 传入，浅色主题由 .ccode-file-glyph 压暗；
                             #   附件卡 / 文件选择窗 / 资源列表 / 改动面板按 size 复用）+ FileTypeMark（14px 槽，与文件夹图标同宽对齐）
  components/ConfirmDialog.tsx # 全局确认/提示框（confirmDialog/alertDialog，126 处共用）：语气图标 + 结构化正文（标题/对照表/注意条，
                             #   解析在 confirm-dialog.ts）+ 危险钮 dangerActionClass、按钮动词推断、危险默认焦点给取消
  components/ContextMenu.tsx # 全站右键 / ⋯ 菜单（25 处共用）：fixed 全屏遮罩 + 视口钳制浮层、图标列按需、danger 沉底、
                             #   键盘导航；条目形状与分组整理在 context-menu.ts（口径见 design-system「右键 / ⋯ 菜单统一口径」）
  shell-context.ts           # 顶栏左侧/灵动岛分工（shellContextPlacement：按侧栏形态定项目芯片与活动落点；侧栏无项目树时芯片常驻）+ 运行摘要
                             #   runActivitySummary（shell 不算、待确认排首、外部 live 会话回落计数；tests/shell-context.test.ts）
  components/RunCaret.tsx    # 运行状态光标（M▁ 那一道，样式 App.css .ccode-run-caret）；place row / inline / free，decorative 不念
  components/RunActivity.tsx # 活动芯片/岛胶囊 RunActivityButton（titlebar / island；展开侧栏「运行」行尾那份 10-24 随该行撤掉）+ agent 列表浮层（portal 到 body，点行直达那段对话）；useRunActivity 供岛上休眠面（图标态「运行」图标 2026-10-24 撤掉）
  context-menu.ts            # ContextMenuItem 类型 + normalizeMenuItems（危险项自动补分隔、收首尾/连续分隔线；tests/context-menu.test.ts）
  components/LaunchMenu.tsx  # 启动栏下拉菜单组件：portal 到 body、分组标题、键盘导航，替代原生 select
                             # （Agent/配置/模型三段共用；隐藏配置沉「已停用（可手选）」组）
  components/StepEvidenceChip.tsx # 步骤卡证据徽标：读当前步骤报告，显示质量状态与未决标记计数（解析在 step-evidence.ts）
  components/ReviewDecisionList.tsx # 步骤上的审查/待核实清单：逐条接受、拒绝、修改，写回报告后再接回对话
  components/HandbackPanels.tsx # 定稿步「打开清单 / 打开填写」展开的面板：许可清单一篇一行（文章页、状态下拉即存、原图文件夹），投稿声明一节一框离开即存
  components/PendingConfirmList.tsx # 检索步文献清单：待确认纳入/排除、已纳入移出、已排除恢复；行上现查 IF/分区/TOP；
                             #   指标表状态与排序跟在「纳入所选 / 排除所选」右侧，没有待确认时单独靠右
  components/ProjectFilesView.tsx # 项目面「文件」页：左目录树右预览（v3.231 三态合一）。watch_dir/fs-changed 自动跟上
                             # Agent 产物（与终端树同一套，监听失败退回手动刷新）；刷新 = 根 + 已展开目录全部重读；
                             # 预览三宿主（侧栏/窄屏/窗口弹层）同屏只挂一份（窗口态侧栏不双挂）；未保存编辑在换文件/
                             # 关预览/关窗口前经 confirmLoseDirty 确认（dirtyRef 由 ProjectFilePreview.onDirtyChange 上报）；
                             # 右键菜单（打开终端/新建文件夹/复制路径/删除走回收站 fs_delete_path）、「最近」视图（officeDocs
                             # 后端已按修改时间降序）、搜索/筛选态预览头「定位」退回树视图展开父链；2000/400 截断点名；
                             # 多选（只选文件，⌘/Ctrl 加减 + Shift 连选，批量条 问 AI / 加入积累 / 移动 / 删除，右键选中行出批量菜单）、
                             # PDF 行阅读状态（pdfLitState，三份清单 1.5s 防抖重读）、收起文件夹行尾数量（list_dir withCounts）
  components/CloseoutPack.tsx # 项目卡「完结文件」：按脉络列出已写出的文件，点开到文件页
  internal-sessions.ts       # 设置页「Mesa 内部对话」卡片纯逻辑：保留天数档、体积白话、立即清理确认文案（tests/internal-sessions.test.ts）
  notice-text.ts             # 提示条 / 浮动提示正文分层（首句=结果标题，其余按句成说明行）+ 停留时长（tests/notice-text.test.ts）
  toast.ts                   # 右下角浮动提示总线：toast(msg, tone, { actions, sticky, key }) / dismissToast(key)；带动作按钮、
                             #   常驻不自动消失、同 key 顶替旧的（上手引导「下一步」只留一条）。ToastHost 渲染，满员先挤会自动消失的
  onboarding.ts              # 上手引导纯逻辑（2026-10-20）：七步步骤表与文案、完成判定（全由数据现算，只有「切到终端看看」
                             #   「认识对话标题」「官方账号跳过网关」靠确认——终端那步运行页真切过一次也记，store.ackOnboarding）、进度/当前步、新完成集合、首次判定（有连接=老用户收起）、
                             #   「结果 + 下一步」提示文案、localStorage ccode.onboarding 存取（tests/onboarding.test.ts）
  components/OnboardingGuide.tsx # 上手引导界面：OnboardingHost（App 根部；首屏数据齐后首次判定、步骤完成跃迁弹 sticky 「下一步」
                             #   toast、欢迎页 Modal、清单浮层——贴侧栏 data-onboarding-anchor 行向右展开，侧栏全隐藏时挂帮助下方）+
                             #   useOnboardingRail / OnboardingRing（App 侧栏行用）+ OnboardingPageStrip（连接页页头下方当前步引导条）+
                             #   openOnboardingGuide（帮助菜单 / ⌘K）。各步动作走既有一次性请求（gatewayLibraryReq / profileModalReq /
                             #   newProjectOpenReq / settingsSectionReq / openQuickChat），不自己开弹窗
  skill-preview.ts           # 技能页预览：SKILL.md 拆 frontmatter 字段 + 正文（正文 marked 渲染）（tests/skill-preview.test.ts）
  reasoning-effort.ts        # 网关思考档：逗号多选 + @开场默认；单词旧值=单档；状态栏当前档 currentEffort（屏上 > 本次覆盖 > 开场档）
                             # 与 PTY 输出认档 detectEffortInOutput（Claude Code 三种成句形态）；读回模型 detectModelInOutput（回显句）/
                             # detectModelOnScreen（整行底栏只从可视区读，Codex 差量重绘）；拼帧尾巴 outputTail（tests/reasoning-effort.test.ts）
  vendor-icon.ts             # 端点主机 → 厂商标识（官方域名后缀表，不认第三方中转；localhost:11434=Ollama），网关取槽顺序首个命中；
                             # 单色图标集合（currentColor 的要 mask 渲染）；tests/vendor-icon.test.ts
  components/VendorIcon.tsx  # 厂商小图标：单色用 mask 按文字色画、彩色用 img、认不出给首字占位；素材 assets/vendor-icons/（署名见 THIRD-PARTY）
  components/GatewayLibrary.tsx # 连接页网关库：五槽/密钥/获取模型/按槽体检/逐模型策略三态；
                             # 思考档勾多档，开场默认单选（reasoning-effort.ts）
                             # Base URL 主输入（2026-08-31）：空槽与仍等于旧主值的槽跟随主输入、手改即脱离；
                             # 全部测速按 URL 去重（同址只探一次，摘要前端镜像给同址槽）
                             # 头部（标题/关闭/错误与结果提示）吸顶（2026-10-20：保存钮在长表单底下，提示原先看不见）；
                             # initialNew = 打开即进新建表单；新建保存后「Agent 配置」滚进视野，改已有网关保存弹 toast
  components/HoverTip.tsx      # 应用内 tooltip 共享件（v3.93 提取自 ProjectGroup）：useHoverTip + HoverTip，
                             # portal 到 body（免疫祖先 opacity/transform 的 fixed 包含块问题）、滚动/缩放即关、
                             # up 参数支持锚点上方弹出（行内动作栏 tooltip 专用）；PageFrame 的 RowAction 内置上方 tooltip
  components/ProjectSettingsDrawer.tsx # 项目设置抽屉（三方式共用，2026-10-16 统一）：SettingsDrawerShell 外壳
                             #   （ccode-sheet-right 滑入/退场 + Esc/Tab 焦点圈闭 + role=dialog + 遮罩 mousedown
                             #   靶命中关闭，头带项目名副题）+ SettingsRulesSection「规则与验收」分区（规则/
                             #   验收记录/对话注入，验收账本自取）；默认导出=编程/工作组装（再加项目长期知识）
  components/SessionTemplateEditor.tsx # 对话注入「自定义」勾选编辑器（2026-10-17 用户三轮拍板：原文模板、可排序段落清单都嫌不便）：
                             #   「带上哪些项目信息」9 枚开关标签（悬停看本项目此刻内容，勾着为空标「（空）」）+「我的补充」文本框；
                             #   标签即存、补充失焦存；补充框自持原文（回流模板会裁空白）；放不进勾选形状的手工版式给
                             #   「编辑源文本 / 改用勾选」两条出路（tests/session-template-editor-ui.test.ts）
  components/ProjectInjectionPanel.tsx # 项目设置抽屉「对话注入」面板（2026-10-16）：三态 SegTabs（自动/自定义/不注入）+
                             #   模板编辑（切到自定义且模板空 → 直接填默认版式并保存；恢复默认模板覆盖前确认；「插入」占位符小标签、
                             #   未知占位符/单独 ---- 行点名、人清空时的不生效提示）+
                             #   展开式预览（loadProjectContextPack + sessionOverride 按面板未保存的档位/草稿 400ms 防抖重渲，所见即所得，
                             #   ↻ 手动按项目当前内容重读，previewSeq 序号守卫防并发旧读覆盖）；保存合并的最后一次入队放 ref（不得用每次渲染重置的 let）；
                             #   保存走 project_set_session_injection（projects.rs 配置锁内单键读改写，不整卡——
                             #   同分区规则面板等写者互不覆盖）+ 前端 saveChain 串行化保落盘顺序；touchedRef 防
                             #   迟到的挂载读档覆盖用户刚改的表单；
                             #   挂载三处共用 SettingsRulesSection「规则与验收」分区（科研抽屉与编程/工作抽屉
                             #   同一份），影响一切 session 入口（＋新对话/问 AI/编程「进入」/定时巡检开聊）
  components/ActivityHeatmap.tsx  # 用量页「活跃度」热力图区块（2026-10-12）：真 table role=grid + CSS 格子（几何全在
                             #   App.css .ccode-heat*，档位色 --heat-1..4 令牌）；去年同月 1 日到今天、与 range 解耦；
                             #   单模布局（2026-10-16）：胶囊全在卡头一行（标题后、窗口范围前），网格吃满卡宽；
                             #   格子边长 11–28 整数、28 封顶后卡片 hug 内容宽；统计行+少多色阶常驻网格下方；
                             #   布局观察满宽哨兵（禁止观察 hug 主区，防抖动）
                             #   挂在 StatsPage empty 三元之外（页面空态是 range 口径）；共享单例 tooltip
                             #   （pointerover 委托 + 键盘焦点同款触发）+ roving tabindex 方向键漫游；
                             #   二期同日实装：点格/回车下钻日详情浮层（usage_day_detail 按日缓存、内滚不关、
                             #   z-60 弹层档；会话行直跳结构化会话视图、日期出口 sessionScopeReq kind:day）+
                             #   按 agent 筛选胶囊（usage_activity_agents 年矩阵一次拉、切胶囊纯前端过滤，
                             #   分档/活跃/峰值/连续随胶囊重算，streak 限所选年）；
                             #   数据自持（usage_activity 全历史非零日，refreshKey 由页级刷新驱动）
  pipeline-presets.ts        # 内置流水线模板 PIPELINE_TEMPLATES（六套，含 v3.97「LaTeX 论文」）；
                             #   每套 projectRules 纪律不同，settingsForTemplateApply 不落空表格
  lit-project.ts             # 文献-only 项目：建议添加目录 / 家目录禁入 / 「整理为笔记」摘录落点（notesExcerptTarget：
                             #   lit-notes 工作区名或挂 lit-notes 技能的步骤；工作区没在跑时调用方写项目根 notes/excerpts.md）
  task-md.ts                 # TASK.md 拼装纯函数（项目根/产物目录绝对路径）；pipeline-start 再导出
  pipeline-start.ts          # 一键开步共享链路（renderTaskMd/gatherTaskMdExtras 单一出处，弹层预览与落盘共用）；
                             # 工作区→终端交接单一出处 buildWorkspaceTerminalRequest（reuseKey 找回同工作区标签 +
                             # 无 prompt 时 resume 最近会话；步骤绑定换了 Agent 则不接回，见 keepWorkspaceResume）
  goal-run.ts                # 普通目标/「验收后写入」共享启动链（审计 §4.10）：prepareGoalRun 先拼上下文
                             # （packGoal/goalLine 可覆盖）再 task_prepare_run（contextText 冻结快照）；
                             # goalRunTerminalFields 出终端请求公共字段；页面只补 model/预览等自有字段
  workspace-resume.ts        # 「去终端」resume 挑选纯逻辑（workspace 名 + 仓库路径匹配，排除归档/内部/live；
                             # keepWorkspaceResume：步骤绑定是另一家 Agent 时不接回；
                             # workspaceCarrySource：换 Agent 继续时要不要问带简报。tests/workspace-resume.test.ts）
  presets.ts                 # 端点预设表（provider 级一份多槽：PROVIDER_PRESETS 各协议槽端点 + 推荐模型 ≤3 + 适用 Agent；
                             #   presetsForAgent 按 Agent 协议槽派生下拉；加供应商 = 加一条；仍只收官方/公开端点——
                             #   商业中转不进默认表，2026-10-12 拍板，tests/presets.test.ts 钉住）
  preset-flow.ts             # 一键接入纯逻辑：推荐模型与目录求交（intersectCatalog，不整目录预填）、「同时绑到」
                             #   协议兼容目标推导（extraBindTargets，复用 apiKindOf；多协议 Agent 优先 openai）、
                             #   多 Agent 槽位拼装（gatewayDraftSlots：主槽=表单地址，预设分槽值优先于同址回落）
                             #   （tests/preset-flow.test.ts；约定见 conventions/profiles.md「一键接入」）
  mcp-presets.ts             # MCP 内置预设表（加预设 = 加一条；密钥一律 ${VAR} 引用；
                             #   remote 填 url/headers，stdio 填 command/args，`{home}` 打开表单时展开为家目录；
                             #   需本机安装的用 setup 步骤引导，不代装）
  mcp-display.ts             # MCP 页展示纯逻辑：协议徽章固定识别色（stdio 紫/remote 蓝）+ 命令路径智能缩略
                             # （家目录折 ~、段数>3 且 >28 字符才砍中段留首尾）+ 收编条目判定与删除影响面
                             # （isAdoptedMcp/mcpDeleteImpact/mcpOriginLabel，tests/mcp-display.test.ts）+
                             # 分发状态徽标 mcpDistBadge（modified/missing/disabled_externally 三异常态文案与识别色）+
                             # 命令路径告警徽标 mcpCmdPathBadge（relative/missing）与收编解析附注 mcpPathResolveNote
  run-overview.ts            # 运行中聚合视图纯逻辑（按「要你管」排序）+ 项目列表状态点 projectRailStatus
                             # + tabRunInput（标签折成 terminalRunInputs 一行；没上报状态先用开标签时的 Agent / 目录 / 要接的会话，侧栏不闪「新对话」）
  run-model.ts               # Project→Task→Run 前端镜像：inferTaskKind / 工作台白名单 isWorkbenchSurfaceRun
                             # （登录/无头/空闲 shell 不进「正在进行」；阅读标签还开着则进）/
                             # pickRecoverableRun 找回可恢复 Run（排除 internal/login/watch/reader——阅读关掉就离开，
                             # 不进找回链）/ isRunProcessLive 活进程判定（保留标签不算运行中）（tests/run-model.test.ts）
  project-tasks.ts           # 人声明任务：资料范围（不带入/勾选/整个项目）/ 嵌套路径剪枝 /
                             # 声明步骤过滤（不含会话自动登记）/ 审核回流文案 / 目标短名 goalShortTitle 与全文 goalFullText /
                             # 保护文件夹勾选（验收写回保持原样，不是另存副本；tests/project-tasks.test.ts）
  project-agents.ts          # 项目 Agents 名册：每家默认配置 / 项目选用的模型 / 项目默认 / 声明步骤归属
                             # （不自动分派；tests/project-agents.test.ts）
  project-context.ts         # 项目环境包：名称/规则/顶层文件地图（启动注入）；包与第一句的拼接 composeLaunchPrompt / 拆开 splitLaunchPrompt
                             #   （气泡折「已附项目说明」、↑ 取回、工作台「上次停在」只认人话；Rust 镜像 sessions.rs strip_mesa_launch_pack）；
                             #   会话包 = 身份+目录+规则+跟用户走；目标包才带当前目标/技能/尚未完成/验收写回；
                             #   空表格不进规则，有流程用模板纪律、无流程用工作方式默认条；
                             #   段落先拼成命名分块（packSections，空块为 ""）再拼版式——自动包与对话注入自定义模板
                             #   （DEFAULT_SESSION_TEMPLATE + renderSessionInjection，{{课题主题}} 等占位符开对话时填入、
                             #   未知占位符原样保留、空块消隐）共用同一出处，三态只管 session 包（2026-10-16 拍板）；
                             #   文件地图同类文件 ≥6 个折成一行、规则机器键换白话、撤掉的占位符渲染为空、
                             #   Windows 本机 Python 提示 WINDOWS_PYTHON_HINTS 与 task-md 共用（2026-10-26）
                             # （tests/project-context.test.ts）
  coding-lanes.ts            # 编程车道覆盖层：有树无行按分支现算、theme 分组、空闲/Agent；
                             # arrangeBranchMap 分支地图（基准作根 / 其余树分组 / 未检出分支单列）
                             # （tests/coding-lanes.test.ts）
  agent-caps.ts              # 能力表前端消费：定时任务禁选未验证无头；Grok 标「会批准全部操作」
                             #   （Windows 上 Codex 的沙箱提示与「了解并开启」在 components/CodexWinSandboxNotice.tsx：说明文字单一出处，
                             #   确认才写设置 codexWinSandboxConsent；定时任务弹层与设置页共用）
                             # （tests/agent-caps.test.ts）
  work-mode.ts               # 项目工作方式（科研/编程/办公）与编程状态归类、办公文档类型/预览形态；
                             # 文件行「进行中」只认 officeFileReuseKey 对上的活标签（仓级仍 isOfficeInProgress）；
                             # 顶栏课题主题可见性 headerShowsTopic（科研项目含无流程都展示，身份四件套之一）
                             # （lockWorkModeFromConfig / codingFactChips / codingDivergenceLabel（领先·落后文案） /
                             #   groupByWorkMode 项目栏分段（projectSwitchRows 收起态切换菜单行已随 2026-10-16 拆栏删除）；tests/work-mode.test.ts）
  session-title.ts           # 会话列表展示标题清洗（去 URL/绝对路径/中断/resume/未命名，取首句；不写回源文件）；
                             # autoTitleMilestone = 聊天中途校正标题的节点（用户第 3、第 8 句，TerminalPage 触发）
                             # （tests/session-title.test.ts）
  project-status.ts          # 项目页状态行 / 工作区要你管排序 / 笔记过滤 / 办公继续上次与问 AI 建议
                             # / 本项目会话过滤（filterProjectSessions，排除无头 AI / 问 AI / 阅读注入 / 已归档；默认全部列出）
                             # （tests/project-status.test.ts）
  mac-titlebar.ts            # macOS Overlay 顶栏左边距：窗口态红绿灯让 78pt（按界面缩放反算成 calc(78px / var(--ccode-ui-zoom))），全屏取消
  ui-zoom.ts                 # 界面缩放档位（80–150%，两端与 ui_zoom.rs 常量对齐）/ ⌘= ⌘- 判键 / 归档；没有复位键（⌘0 是光标移到侧栏）（tests/ui-zoom.test.ts）
  device-pixel-ratio.ts      # 像素比变化统一监听：媒体查询 + resize 两路（WKWebView 缩放不发媒体查询 change）；useDevicePixelRatio 共用一份监听（终端补位、PDF 页重画用）
                             # （macOverlayPadClass / useMacFullscreen；tests/mac-titlebar.test.ts）；
                             # useMacFullscreenState 另给「全屏动画中」：原生预告先翻状态，onResized 查询经 resolveFullscreen 对账
  folder-groups.ts           # 项目页分级文件夹树（本层文件与子夹并列；可剥 papers/notes/data）
                             # 展开路径 persist（默认全收起，跟随上次；tests/folder-groups.test.ts）
  workbench-hero.ts          # 工作台主卡纯逻辑：当前工作按运行标签归属（注册名优先；隔离目标副本按
                             # runId/taskId 归属表归回真实项目，不按 cwd 拆卡；同名项目按 contextPath 路径选，名字只作唯一命中回落）、
                             # 步骤取流水线第一个未合并步（openStepProgress / stepProgressLabel 写「进行到：X（第 i / n 步）」，
                             #   lastSaidStepTag：「上次停在」那段对话归在别的步骤时标出）、「继续工作」有标签则聚焦，否则按 runId 找回原 Run，再回落进项目/真进入；
                             # pickWorkbenchNow = 正在进行列表（大卡 + 紧凑行）；runningCount 只算活进程
                             # （isRunProcessLive，已退出/未启动的保留标签留在 runs 里可继续但不冒充「正在工作」）；
                             # 副行优先待验收/进行中目标；最近对话先按可见范围过滤（归档/内部无头/问 AI/阅读注入不列，
                             # 与 filterProjectSessions 同口径）再与项目侧栏同一套清洗，未命名不列；
                             # workbenchRecentRows = 已添加项目 ∪ 会话扫仓库（办公/新建无会话也列出），
                             # 与最近对话默认最多 10 条；「上次停在」latestProjectSession + lastUserInstruction
                             # （跳工具结果/系统注入，不按首句切）；待处理行归项目 inboxItemProjectRoot；
                             # 「记下目标」可选项目 goalCaptureTargets（与 ProjectGroup liteResearch / 办公目标视图
                             # 双端同口径）；加载失败合一条 workbenchLoadFailureMessage（tests/workbench-hero.test.ts）
  lit-watch.ts               # 文献雷达纯逻辑：日分组/关键词分组（groupEntriesByKeyword，取 keywordsHit 首词、
                             # 未分类恒末）/趋势/直链转换/全文可得性分流（fulltextLinkFor：arxiv abs 与 .pdf 直链=可下载，
                             # DOI/落地页=来源，不再摆禁用下载钮）/已读判定/雷达筛选（entryPassesFilter
                             # 与 lit_watch.rs 双端镜像，指标未知放行不误伤；快筛解读 watchExplainPrompt /
                             # parseWatchExplain 五节学术口径；卡片展开按项目记忆（默认收起）；
                             # tests/lit-watch.test.ts）
  md-image-hydrate.ts        # md 阅读/聊天图片占位水合：每次 layout 扫 data-md-src，本地图走 image-cache
  md-pdf-refs.ts             # md 阅读视图里把 p.3/第 3 页/Fig. 2/Table 1 包成可点引用（每次布局幂等重扫，跳过 a/code/公式；
                             # 标注行/译段引用块带上原文）+ 点中取跳转请求 + focusMdText（滚到含某段文字的块并闪）；
                             # 只在阅读区笔记栏接线（FilePreviewEditor onPdfRef/focusText）（tests/reader-note.test.ts）
  doc-thumb.ts               # 聊天附件文件卡：哪些能出预览（docThumbKind）、类型字（docTypeLabel）、HTML 排进一张纸出 SVG foreignObject 图片地址（htmlPageThumb）、表格前几行（read_sheet_preview）；
                             #   docThumb 按类型分派，pdf.js / mammoth 各自动态 import
  docx-thumb.ts              # Word（docx）附件首页预览：read_docx_bytes → mammoth → sanitizeDocumentHtml → htmlPageThumb
  pdf-thumb.ts               # 聊天附件卡的 PDF 首页缩略图（read_pdf_bytes + pdf.js 画第一页出 data URL，按像素比出图封顶 3 倍，失败 null）；输入框按需动态 import，不进主包
  pdf-search.ts              # PDF 文本检索纯逻辑（2026-10-18）：页文本组装与归一（文本项原样拼、行尾补空格、断词复原、
                             # 大小写/弯引号/短横线/连字）——页级计数与页内高亮同一口径；命中→文本项分段、同行碎矩形合并、
                             # 标注重定位候选 quoteSearchCandidates（原样→去词内连字符→前 60 字）、图表定位 locateFigure（行首图注优先）、
                             # 目录拍平与落点高度（tests/pdf-search.test.ts）
  note-pdf-pair.ts           # md 笔记配不配得上本篇 PDF（reader_for_note 结果按路径缓存 30 秒、同路径并发只问一次 + useNotePaired）：
                             # 「沉浸阅读」入口只给配得上的——FilePreviewEditor 预览右上角、ProjectFilesView 文件行悬停、FileTree 右键（2026-10-25；tests/note-pdf-pair.test.ts）
  reader-note.ts             # 笔记 ↔ PDF 纯逻辑（2026-10-18）：「## 标注」行格式与解析（与 reader.rs 双端镜像，改动需同步）、
                             # 八小节是否全空（让 AI 起草入口）与起草指令、页码/图表引用识别、标注 toast 口径（tests/reader-note.test.ts）
  agent-binding 体系（2026-10-15 定稿，全文 docs/conventions/agent-binding.md）：
  project-agents.ts          # 绑定纯逻辑单一出处：slotPrefs（discuss 槽>项目默认）/ taskBindingLaunch /
                             #   resolveStepLaunch（步骤槽>discuss）/ resolveTaskModel（目标三档回落）/
                             #   goalDefaultProfile（未绑目标开工用哪条，新建目标弹层摘要同源）/
                             #   workspaceLaunchChain（手选>步骤>wsLast 三链）/ stepSlotKey /
                             #   projectResumeProfileId / sessionProjectResumeProfileId（接回旧对话按所属项目预填连接，各入口同口径）/
                             #   CHAT_BINDING_SLOT（项目对话）/ DISCUSS_BINDING_SLOT（问 AI·聊想法）
  render-gate.ts            # 通用并发槽 RenderGate（限并发 + FIFO + 槽位直接移交）：PDF 位图重渲过闸逐页错开，
                             # 停稳换挡后的补渲不再挤同一帧（tests/render-gate.test.ts）
  reader.ts                  # 沉浸阅读区纯逻辑：分栏钳制与像素换算（含收起滑动量 readerPanelSlideMargin，栏宽不变负 margin 滑出）/
                             # 圈选命中与 canvas 映射/截图注入格式/
                             # glossary 表格契约（与 reader.rs 双端镜像，改动需同步）/段落边界提取/术语匹配/
                             # 进度与护眼存储键/翻译面板高度键（readerSplitT，未拖过不落键 = 内容自适应）/译文卡钉位键（readerTlPinned）与悬浮球位键（readerTlBall，PDF 栏百分比 0–100、渲染层按球半径贴边兜底）/悬浮卡尺寸键（readerTlCard，240×140 下限、拖过才落键）/
                             # PDF 适配宽度 nextFitScale（亚像素门槛，防滚动条槽振荡闪白）/
                             # 手势缩放 clampPdfScale、pdfWheelZoomFactor（组件绑定共享在
                             # components/use-pdf-zoom.ts：布局倍率即时重排、渲染倍率 renderScale 延迟重绘、
                             # 锚点实测修正不用公式，连续滚动与单页预览同一套；对齐官方 pdf.js viewer，
                             # 勿退回整层 transform 跟手）/
                             # 画布像素上限 pdfCanvasOutputScale（tests/reader.test.ts）
  draft-review.ts            # 写作步评审机械红线（摘要待核实/G编号/待绘制/叠号）、划选批注追加与退回提示词
  md-path.ts                 # 阅读版式覆盖的 md 族（md/markdown/mdx/qmd）与 html 判定
  md-toc.ts                  # md 浮动目录：≥3 标题才出、slug/展开 details
  md-code-chrome.ts          # 阅读态代码块语言名 + 复制（lucide Copy 图标）；mermaid 围栏打标；decorateMdTables 聊天表格横滚壳 + 数字列
                             # （isNumericCell，只给聊天用：笔记双击定位按 table 节点配对）
  md-block-map.ts            # md 渲染块→源码行映射（阅读态双击段落跳编辑态定位）：lexer raw
                             # 累积算行（无参调用，带 options 丢 md-math 扩展）+ 上屏 DOM 惰性
                             # 配对（md-code/md-mermaid 归一 pre），失败回落纯切换
                             # （tests/md-block-map.test.ts，含 parse→清洗→装饰全链路）
  md-edit.ts                 # md 行内/行级格式编辑纯逻辑：加粗/斜体/删除线/行内代码标记切换、
                             # 列表·任务·引用前缀整组切换、回车续列表、链接包裹；
                             # 编辑器格式行与 ⌘B 等快捷键同一套（tests/md-edit.test.ts）
  mermaid-blocks.ts          # mermaid 围栏检测（无围栏不加载 chunk）
  mermaid-sanitize.ts        # mermaid SVG 二次清洗（strict + 剥脚本/链接）
  html-preview.ts            # html 沙箱预览：stylesheet 内联 / 本地图 / srcdoc
  md-find.ts                 # md 阅读态页内查找：按块拼文字找、跨行内元素逐节点包 mark、清除复原；跳过 .md-cite（tests/md-find.test.ts）
  editor-font.ts             # 文件预览编辑器字号（本机存储 + CustomEvent 广播，10–22 一档一像素）（tests/editor-font.test.ts）
  md-render.ts               # 文档版 md 渲染：splitMdFrontmatter 拆 YAML 头（画成 MdFrontmatterCard）、脚注扩展只在 withDocMode 内生效，
                             # renderMarkdownDocument / lexMarkdownDocument 渲染与块映射同口径（tests/md-render.test.ts）
  md-math.ts                 # md 阅读版式公式渲染（批次 E）：marked 扩展按 Pandoc 口径切分 $/$$
                             # （边界规则/转义/代码块不渲染/货币不误判）+ renderMathInto 懒加载
                             # katex+CSS（独立 chunk 不进主包，失败回落原文，tests/md-math.test.ts）；mathExtensions 全局注册，
                             # chatMathExtensions 另认 \( \) / \[ \]（只给聊天 Marked 实例，占位一律写成 $ 形式）
  task-cards.ts              # 任务卡纯逻辑：按步骤分桶/卡片排序/会话按卡分组/卡片 kind（idea 想法卡 / draft 讨论卡）过滤；
                             # 「＋ 话题」占位按当前步骤给例子（ideaTopicPlaceholder，综述大纲不写对照实验）
                             # （tests/task-cards.test.ts）
  step-flow.ts               # 步骤内协同流程线纯逻辑：种子→before→agent→during→after→评审节点链
                             # （v3.97 起 after 档一律进主干，可选项带徽标但不抢当前节点；
                             #   「确定文献来源」= 选了非默认来源或这一步已开工（默认检索开工后不再钉住当前）；
                             #   demoReadPaperResource：「开读这一篇」仅示例课题精读步，普通模板只显示「开始」；
                             #   tests/step-flow.test.ts）
  skill-conflicts.ts         # 技能接口对账纯逻辑：产物冲突（skillOutputConflicts，outputs 两两相交）+
                             # 跨步骤链路（skillChainWarnings：inputs 找供给/outputs 对账预期产物，
                             # 支持 * 通配与目录/文件互含，推断接口打标；tests/skill-conflicts.test.ts）
  schedule-tasks.ts          # 定时任务纯逻辑：周期白话/相对时间/按 projectRoot 过滤（tests/schedule-tasks.test.ts）；
                             # 2026-10-23：周期闭集与间隔/上限选项、slotLabel/nextRunLabel、跳过白话与悬停提示、补跑小标、
                             # 无新内容不通知（shouldNotifyRunDone）、补跑通知文案、待处理「定时任务」候选（scheduleInboxCandidates：
                             # 其他巡检待评审只认 noop===false 的新记录 + 自动暂停）、其他项目总览过滤；
                             # lastRunBrief / lastRunAction：任务行「上次 …」一句话与入口；
                             # workbenchScheduleRows：工作台右栏「定时任务」摘要（在跑 / 上次失败未暂停 / 24h 内前三条，WorkbenchPage 消费）
  schedule-skill.ts          # 定时巡检种类：文献雷达 + 分类「巡检」的技能；新建种子 prompt / 草稿路径
                             # （给了 scheduleRelPath 时种子请 AI 顺带写周期建议 JSON，2026-10-23）；
                             # defaultScheduleKind / scheduleExamples：按工作方式给新建默认种类与空态示例
                             # （value 用目录名不是 UUID；tests/schedule-skill.test.ts）
  inbox.ts                   # 收件箱分类胶囊纯逻辑：key 前缀→类别、分组、help dismiss 签名、人工请求通知 edge-trigger（tests/inbox.test.ts）；
                             #   sched: = 「定时任务」类（其他巡检待评审 / 自动暂停，不进一键已读；2026-10-23）；
                             #   phone: 类别（从手机添加还没处理的）与 update: 一样由 store.ts visibleInboxItems 现算合并
  app-update.ts              # 应用自更新展示纯逻辑：收件箱字段/合并、检查失败文案、http(s) 代理、下载进度
  app-update-install.ts      # 「下载并安装」hook（设置→更新与帮助菜单更新弹窗共用）：先查后台任务要人点头、进度累计、成功 relaunch；模块级闸防双下载
  diagnostics.ts             # 前端诊断：WebGL 探针/软件渲染判定、monaco 取消拒绝识别、诊断包前端采集；应用日志展示纯逻辑（UTC→本机时间、错误/警告短标、计数、复制文本）（tests/diagnostics.test.ts）
                             # （tests/app-update.test.ts）；真正 check()/安装在 store.ts
  chat-handoff-log.ts        # 聊天层转到终端记数（2026-10-22，tests/chat-handoff-log.test.ts）：原因闭集 HANDOFF_REASONS（与 chat_handoff_log.rs
                             # REASONS 同名同序，测试钉住）、说法、确认卡种类 decisionKind、同家同原因 3 秒去重；记录失败静默。
                             # 记数点：TerminalPage 等确认自动露出 / 标签栏与 /terminal 切终端，ChatSurface 卡住自动露出、选择器、卡片与「看实时输出」按钮；
                             # 查看在 components/ChatHandoffStatsPanel.tsx（设置「诊断」）
  chat-handoff.ts            # 聊天⇄终端交接表：chat_ok / peek / must_switch、卡住时的一句话 CHAT_NO_SESSION_TEXT、斜杠是否要窥视 TUI、
                             # 聊天头状态 chatHeaderStatus（未开始不写「等待会话文件」，tests/chat-handoff.test.ts）；
                             # 本地乐观消息放回解析结果的位置 placePendingUsers（排队中的接末尾，其余插在发送后的第一条新回复前）；
                             # messageKey / chatMessageKey 有来源 id 用 id；HOOKS_AGENTS 键是 agent id（2026-10-20 改正 claude-code）
  chat-status.ts             # 生成中那一行「这一轮在做什么」（2026-10-21，规则见 design-system「生成中那一行」）：旁路 activity / thinking
                             # > 会话里还没回结果的调用（已有那一行就不重复）/ 计划进行中一项（activeForm）/ 刚落盘的思考
                             # > CLI 自己报的现状 statusLine（程序状态旁路，只等于「在等 / 在想」的不用）> 「思考中」；
  chat-fidelity.ts           # 聊天层对九家能做到哪一步（2026-10-22，tests/chat-fidelity.test.ts，docs/design-chat-fidelity.md）：CHAT_FIDELITY 分档
                             # 单一出处、parseVersion / verifiedVersion（本平台基线优先）/ versionTrust（比核对过的新 = newer）
  cli-verified.ts            # 已核对 CLI 版本：构建时 import.meta.glob 读金丝雀基线的 version（测试里兜成空表）；useCliNewer 给降级用
  text-reveal.ts             # 聊天实时预览匀速显示（2026-10-22，tests/text-reveal.test.ts）：revealStep 按积压放字、shownAfterRetarget
                             # 「接着长才匀速、换了一段整段」、safeCut 不切开字形、useRevealedText（rAF + 兜底节拍）；ChatSurface 消费
                             # thinkingHeadline 取 `**小标题**` 或第一句（tests/chat-status.test.ts）；ChatSurface 消费
  chat-channel.ts            # 结构化旁路快照的前端纯逻辑：回合状态 → 注意力、会话跟随（lock / switch / hint）、实时文字、
                             # 审批卡标题 / 预览（命令 / 差异）/ 可回复的按钮、hooks 审批「屏上回到输入框 = 已答」（hooksApprovalAnswered）
                             # （tests/chat-channel.test.ts）；TerminalView 的 applyChannel 消费
  slash-commands.ts          # 聊天斜杠命令保守常用集（未全量调研的 agent 只给 /help；tests/slash-commands.test.ts）
  ime-guard.ts               # 聊天 Enter 是否处于输入法组词（WKWebView 确认候选时 isComposing 已假；tests/ime-guard.test.ts）
  notify.ts                  # 长任务 OS 通知（仅「待确认」跃迁 + 未聚焦 + 30s 去抖；「已回复」不通知）；
                             #   注意：通知插件桌面端无动作按钮/正文点击回调（App.tsx registerActionTypes/onAction 仅移动端生效，
                             #   2026-09-15 核对插件源码）——桌面点通知只激活窗口，「待确认」跳转由 App.tsx 窗口获焦时的
                             #   右下角提醒条补位（点「去处理」直达终端标签，按待确认集合去重）
  git-status-groups.ts       # 改动列表状态分组/白话双层纯逻辑（含冲突 unmerged 组）；userDirtyFiles（剔台账，评审提交面板用）/
                             #   userWorkDirtyFiles（再剔 Mesa 自有档案 .ccode/·.gitignore，项目页提醒与开工弹层用）
  file-icons.ts              # 文件类型图标纯逻辑：扩展名 → 图形种类（FileGlyph）+ 固定识别色（另按整名认点开头配置文件、按 .bak 段认备份副本）；
                             # 未收录返回 null，画通用文件图标，不留空槽；图形到 Lucide 的映射与渲染在 components/FileTypeMark.tsx；
                             # isPreviewableImagePath（png/jpg/gif/webp/svg，tests/file-icons.test.ts）
  project-files.ts           # 文件页纯逻辑：预览形态分流 / 类型筛选（recent 是视图不参与类型收窄）/
                             # folderCountLabel（文件夹行数量）/ rangeSelect（Shift 连选）/ batchAskPrompt（多选问 AI 开场白）/
                             # 展开链 ancestorDirsToReveal / 上下文件步进 / 沉浸阅读判据唯一落点 /
                             # inTypingContext（方向键只在非打字焦点接管，Monaco/输入框放行；tests/project-files.test.ts）
  sheet-preview.ts           # Excel 预览纯逻辑：列字母 / 单元格引用 / 截断文案 /
                             #   合并区 clipSheetMerge / sheetCellHidden（tests/sheet-preview.test.ts）；
                             #   排序 compareSheetCells / sortedRowOrder、框选 normRange / rangeTsv（tests/sheet-sort.test.ts）
  editor-languages.ts        # monaco 语言注册（批次 E）：monaco-editor 0.56 ESM 不带 latex，
                             # 自带紧凑 Monarch 定义覆盖 .tex/.sty/.cls/.bib（tests/editor-languages.test.ts）
  workspace-visibility.ts    # 聚焦步骤工作区可见性过滤纯逻辑（不匹配任何步骤的手动工作区始终可见，
                             # tests/workspace-visibility.test.ts）
  git-commit-message.ts      # 空提交信息的本地默认信息生成
  diff-intraline.ts          # 改动面板（GitPanel）diff 纯逻辑：块头白话「第 N 行 · 上下文」、每行行号（加行与上下文取新行号、删行取旧行号）、成对删加行的行内高亮区间（去同头同尾，整句重写不标）；评审页 diff 解析在 diff-view.ts
  main-history-save.ts       # 科研步骤卡一键「存进历史」：冲突拦截 / 白话说明 / 路径（tests/main-history-save.test.ts）
  text-fences.ts             # 纯文本消息（用户气泡）的围栏代码拆分 splitFenced：只认行首的 ``` / ~~~，行中间的三个反引号是行内写法不开围栏（旧实现按任意位置切会吞掉后面整段）；未收尾按代码到结尾（tests/text-fences.test.ts）
  chat-image.ts              # 消息里的图片行（tests/chat-image.test.ts）：整行图片路径 imagePathFromLine、改图的「原图：」「标注图：」行
                             # labeledImageFromLine / attachmentLines（Claude Code 只把单独一行的路径升级成图片附件，带前缀不升级）、
                             # 要不要模型看图 composerImageKind（plain / marks / null，ChatModelMenu 据此出看不了图的提示）
  chat-reply.ts              # 聊天长回复按小标题分段（带级别；识别代码围栏；有 ## 时冒号行不当标题）、正文里像文件路径的段（fileRefPath /
                             # findFileRefs，真假由 existing_files 核实）与本机音频（mentionedAudioFiles → ChatMarkdown 播放条）、本机图片（mentionedImageFiles → 正文下图片卡，读不到不出卡）、
                             # 确认按钮是否给出（tests/chat-reply.test.ts）
  mid-turn-send.ts           # 生成中再发一句：各家 CLI 把这句插进这一轮还是排到轮后、「立即发送」按哪个键（Esc / 回车 / Ctrl+S），
                             # 排队气泡与占位字的写法；依据 matrix §14「生成中再发一句」逐家实测（tests/mid-turn-send.test.ts）
  chat-cite.ts               # 聊天回复里的 [@key] 引用段（与 citation.rs extract_cite_keys 同口径）、胶囊字样 citeLabel、cite_lookup 30 秒缓存
  chat-inline-refs.ts        # 回复上屏后的就地加工：文件路径 → .md-file-link（existing_files 核实、15 秒缓存）、引用键 → .md-cite-item
                             # （先键名占位再换作者年份）；只动 DOM，sanitize 之后做（tests/chat-inline-refs.test.ts）
  code-highlight.ts          # 代码块语法高亮：highlight.js 核心 + 二十几种语言按需 import，只认围栏写明的语言；颜色在 App.css .hljs-*
  paste-guard.ts             # 终端粘贴防线：剪收尾回车、shell 多行先确认、备用屏原样（tests/paste-guard.test.ts）
  terminal-links.ts          # 终端行绝对/相对路径与行列号（`:行:列`、句尾标点不吞、lookbehind 起点
                             # 让行首边界字符后的路径也命中；相对候选点击时经 terminal_link_target 终审）
                             # ＋ hitCellRange 把字符下标换算成单元格列号（逐格自算，宽字符不错位）（tests/terminal-links.test.ts）
  terminal-notify.ts         # OSC 9 / 777 通知标题（777 三段式取标题）与 OSC 9;4 进度解析
                             # （parseOsc9Progress → 标签条徽章），从画面文字里抽走（tests/terminal-notify.test.ts）
  terminal-replay.ts         # 重启回放取缓冲尾部纯文本（tests/terminal-replay.test.ts）
  terminal-protocols.ts      # 内嵌终端协议：Kitty 键盘查询识别与剥离（应答由后端 term_query.rs 写回；只宣布 flags 5；无修饰功能键保持传统
                             # 序列、只改写 Esc；带修饰方向键走 CSI 1;mod 字母形）、弹栈认层数、
                             # XTVERSION 两问法统一 DCS 应答、XTGETTCAP 答 Ms、OSC 52 限长写剪贴板、
                             # Kitty 贴图按文件头认 MIME 且支持 m=1 分块、通知/贴图/剪贴板共用
                             断帧 pending 管线（tests/terminal-protocols.test.ts）
  clipboard-image.ts         # 图片落盘的唯一前端入口 saveClipboardImage：终端 / 聊天输入框 / 文件预览 / 沉浸阅读截图四处共用，
                             # 字节作请求体原样走 IPC、扩展名放请求头（禁回 JSON 数字数组，5MB 截图要编出 18.7MB JSON）
  terminal-input.ts          # 终端输入侧纯逻辑：shell 路径转义 escapeShellPath、拖入多路径拼接 joinDroppedPaths、
                             # dropHitsRect、Kimi CSI-u 序列、
                             # Shift+标点补发（229 只补 ASCII 标点，中文上屏不补，避免一字两遍）、
                             # Shift+Enter 换行改写 ptyShiftEnterRewrite（Claude/Grok/CodeBuddy ESC+CR，Codex/Cursor CSI-u）、
                             # ⌘←/⌘→/⌘⌫ 照 iTerm 改写成 Ctrl+A/E/U 的 macLineEditKey、
                             # 剪贴板图片条目判定/MIME→扩展名/粘贴反馈文案（tests/terminal-input.test.ts）
  terminal-welcome.ts        # 终端未启动空态：isTerminalIdle / 卡上「将在 … 启动」目录文案 / 点开的目录菜单 welcomeDirChoices
                             # （tests/terminal-welcome.test.ts）
  terminal-wheel-scroll.ts    # 触控板/滚轮合帧：capture 阶段截住 wheel，同帧多枚合成一枚再派回深层 target
                             # （滚动卡顿修复 2026-09-21，拍板记录 architecture.md §10；tests/terminal-wheel-scroll.test.ts）
  terminal-row-reuse.ts       # DOM 渲染器滚动按行挪位：视口平移不到一屏且行文字未变时挪已有节点、只重画新进行
                             # （滚轮卡顿修复 2026-09-22，WebGL 无逐行 DOM 自动空操作；tests/terminal-row-reuse.test.ts）
  launch-menu.ts              # 启动栏下拉菜单视口定位 placeDownMenu：只从锚点下沿向下长，空间不够缩短高度
                             # （tests/launch-menu.test.ts）
  tab-working.ts             # 终端标签「生成中」虚线圆：PTY 出字才转；启动注入等回复期间 TUI 开屏不熄灭；会话已落完助手正文；PTY 仍出字时 Codex 中途 done 不得停转圈
                             # 立刻停，sticky working 不得续命；armed 回合不因 PTY 2s 静默熄灭（推理思考间隙≠回合结束，
                             # armed 只由会话层收尾/确认/退出清，未 armed 的 working 仍 2s 静默熄灭兜底——2026-09-15 修正
                             # 「终端还在出字、标签与聊天层却无运行态」）；完全静默 120s 硬上限熄灭转圈但保留 armed（PTY
                             # 再出字即复亮，2026-09-19：思考/执行期间 TUI 动画仍在出字，完全无声=回合已结束或链路冻结）；
                             # 收尾判定被 ptyLive（8s 窗）推迟时 scheduleSettleRetry 保证 PTY_LIVE_MS+1s 后强制重判一次
                             # ——否则会话文件再无新写入时签名门拦住轮询、转圈永久冻结（2026-09-19 综述大纲跑完实测）；
                             # 出字时间戳记任意 agent 输出（焦点重绘抑制窗内也记，
                             # 防切聊天瞬间被静默计时器误杀）；动画禁 CSS rotate（WKWebView 转轴圆心晃）、也禁 dashoffset
                             # 关键帧（主线程重绘，xterm 出字满载时一卡一卡）——8 段虚线按相位差闪 opacity（合成器线程，
                             # 2026-09-15 实测重做）（tests/tab-working.test.ts）
  terminal-tab-persistence.ts # 终端标签重启恢复白名单（不含 PTY/密钥/env）
  tab-drag.ts                # 标签条拖拽排序纯逻辑：位移钳制 + 目标槽位判定（>= 中线守末槽边界）+ 高矮不一的块的让位 / 吸附
                             # （tabDragShift / tabDragSettleDx，侧栏项目树展开对话后用；tests/tab-drag.test.ts）
  tab-surface.ts             # 打开对话先显示聊天还是终端（2026-10-22，tests/tab-surface.test.ts）：设置 openSurface 默认值 +
                             # pendingTerminal 落标签定层（shell 恒终端 / 写死照写 / 复用不动 / 新开跟设置）；进对话的入口禁写死 surface
  terminal-palettes.ts       # 终端调色板共享表（设置页与终端同源）：四套深色 + 四套配对浅色 twin，
                             # ANSI 16 色 + 光标 + 选区全在表内；resolvePaletteId 按主题亮暗自动换 twin；
                             # 没选过 / "auto" = 跟随主题（themeDefaultPalette：深色 One Dark、暮紫 Catppuccin、浅色 Light+）
                             # （新增调色板须同步 settings.rs KNOWN_PALETTES，否则被静默丢弃，tests/terminal-palettes.test.ts）
  upstream-note.ts           # brew 最新但上游 npm 更高版本的提示
  trust-prompt.ts            # 启动「是否信任这个目录」菜单识别（读 xterm 可视区文本；认 Claude / Kimi / CodeBuddy 方框 / Gemini 四种形态，信任只选范围最窄的那项）+ 代答按键序列（方向键挪到目标项再回车）；认不出返回 null 走 8 秒拉起终端的出口
  chat-style.ts              # 聊天层阅读体验：字号档 / 字体 / 行内代码强调色 / 滚动条四张表（与 settings.rs KNOWN_CHAT_* 逐表镜像）+ 壳上内联变量 chatStyleVars（标准/系统档不写变量）；
                             # 颜色与滚动条行为都在 App.css（data-chat-accent / data-chat-scrollbar / .ccode-chat-scroll / .ccode-chat-user，tests/chat-style.test.ts）
  profile-connection-ui.ts   # 连接页行状态列（profileStatusCell：只说例外与测试通过）、未测试给「测试」入口（profileNeedsProbe）、同组重名（duplicateNameIds）、「同步目录」是否出现
  chat-empty-start.ts        # 聊天空态纯逻辑：按目录类型的起手提示表（STARTER_PROMPTS）+ 通用目录的「接着做〈项目〉」（recentProjectStarters）+ 时段问候（chatGreeting）；输入框目录芯片文字在 terminal-welcome.ts cwdChipLabel，UI 在 components/ChatEmptyStart.tsx（不列旧对话：10-23 起挂在侧栏项目树；输入框居中版式在 ChatSurface）；输入框右下「模型 · 思考」菜单在 components/ChatModelMenu.tsx（开聊前 / 运行中 / 接着聊同一个单栏菜单），左下权限四档在 components/ChatPermissionBadge.tsx，对话末尾「等你决定」卡在 components/ChatDecisionCard.tsx（所有弹出卡片一个骨架 CardShell，主按钮 ⌘↵；口径 design-system.md 对话页 ③，设计稿 docs/design-chat-layer.md）
  model-caps-label.ts        # 模型菜单每行右侧的能力灰字（200K · 思考 · 看图），数据来自 model_capabilities
  （scripts/e2e-model-routing/：假网关 + 驱动，用 agents.rs 的 e2e_dump_launch_plans 生成的真实启动计划拉起各家 CLI，核对请求里的模型与路径；
   chat-capture.py 按权限四档拉起、发 TRIGGER_SLOW / TRIGGER_TOOL / 切换命令逐帧抓屏，聊天层第三期逐家核实用（2026-10-20 起
   Windows 走 ConPTY / pywinpty；TRIGGER_ASK / TRIGGER_ASK2 回 Claude 提问表单、APPROVE_KEYS 每按一键记一帧，假网关认 SUGGESTION MODE 回猜的下一句）；capture-check.ts 把抓屏交给 tui-menu / live-reply 解析器看读不读得出；live-replay.ts 用真 xterm.js
   回放抓屏的原始输出（CAP_RAW=1）、逐块读屏接预览，数重复 / 漏行；见其 README）
  （scripts/cli-canary/：CLI 金丝雀——canary.py 串起假网关 E2E_DUMP、chat_channel 的 e2e_channel（E2E_CLEAN_HOME / E2E_KEEP 留会话原件与
   解析结果）、chat-capture 抓屏，抽指纹与 baseline/<平台>/<agent>.json 比，报告附两版之间更新日志的相关条目；
   .github/workflows/cli-canary.yml 每天在 macOS / Windows 跑；2026-10-22 起九家：有旁路的六家跑旁路端到端，Gemini / Kimi 只抓屏，
   Cursor 连不上假网关只记版本；基线 version 随包进应用（src/cli-verified.ts）；见其 README）
  （docs/agent-skills/：维护 Mesa 仓库本身的 Agent 技能（不随应用分发）；mesa-cli-canary = 金丝雀日常维护，装法见其 README）
  （scripts/screen-corpus/：抓屏语料库——corpus.ts 读一屏（菜单 / 信任 / 实时预览 / 输入框）、add-from-capture.ts 从抓屏挑三屏存进
   tests/fixtures/screens/<agent>/，tests/screen-corpus.test.ts 逐份重读；规则见 tests/fixtures/screens/README.md）
  （scripts/mirror-latest-json.mjs：应用内更新国内镜像——把 Release 的 latest.json 下载地址改写成镜像地址，签名原样、缺签名拒绝；
   .github/workflows/mirror-release.yml 在 Release 发布时调用，build.yml 打包时按仓库变量 UPDATE_MIRROR_BASE 把镜像加到 updater 地址最前；
   开通步骤 docs/release.md）
  composer-assist.ts         # 聊天输入框的纯逻辑：@ 引用（mentionQueryAt / applyMention，带空格加引号）、斜杠面板 Mesa 组（MesaCommand / filterMesaCommands）、
                             # ↑ 一路往回翻（userTextHistory；lastUserText 保留）、上下文圆环数据（lastContextTokens / contextUsage）；Mesa 组的内容由 TerminalPage mesaCommandsFor 组装，
                             # ↑ 取回跳过项目上下文包（splitLaunchPrompt）（tests/composer-assist.test.ts）
  notebook.ts                # .ipynb 解析（nbformat 4）：单元 / 输出归一、相邻流合并、svg 转图、traceback 去 ANSI（tests/notebook.test.ts）
  pdf-organize.ts            # PDF 选段「整理为笔记」：写 notes/excerpts.md，精读步在跑时写工作区并预填终端（运行页与项目文件页共用）
  office-convert.ts          # LibreOffice 转换器探测（进程内只问一次）/ 转 PDF / docxDroppedSummary（tests/office-convert.test.ts）
  file-ops.ts                # 文件页 / 文件树文件操作：名字输入行（新建文件 / 文件夹 / 重命名）、复制一份、移动到…（系统选文件夹）、拖入复制与落点判定（tests/file-ops.test.ts）
  file-watch.ts              # 预览跟随磁盘变化：fileStamp（file_stamp 大小+修改时间）/ stampKey / useFileVersion（watch_file 单文件监听，改一次加一）（tests/file-watch.test.ts）
  image-view.ts              # 图片预览纯计算：imageFitScale（适应窗口，小图不放大）/ formatBytes（tests/image-view.test.ts）
  file-draft-handoff.ts      # 预览换宿主（侧栏 ⇄ 窗口 ⇄ 窄屏）带上没保存的修改：arm 5 秒内卸载才寄存，取一次即清（tests/image-view.test.ts）
  image-cache.ts             # 读过的本地图按路径缓存成 blob URL（条数 + 字节双上限 LRU，淘汰即 revoke；同路径读取去重），
                             # 聊天图片卡与 md 内嵌图共用，切回会话首帧就有图；带磁盘戳，revalidateImageUrl 后台核戳换新图（tests/image-cache.test.ts）
  image-markup.ts            # 输入框图片标注纯逻辑：标注类型（原图像素坐标）、线宽 / 徽标 / 箭头几何、意见框编号与消息圈码、
                             # 裁剪范围、paintMarkup 导出绘制（与 MarkupLayer 预览同源）、exportMarkup 生成新图字节（tests/image-markup.test.ts）
  chat-permission.ts         # 输入框权限菜单纯逻辑（2026-10-22）：按项目类型拿一件事说明四档（permissionExample）、⇧Tab 轮换跳过没有的档（nextPermissionTier）；
                             # 只讨论按家分说法（PLAN_FIRST_AGENTS：只有 Claude Code 写「先出方案，你点头再…」，2026-10-26）；
                             # 符号「界线」在 components/ChatPermissionBadge.tsx PermissionGlyph（tests/chat-permission.test.ts）
  plan-approval.ts           # 计划模式方案确认那一屏（2026-10-26，Claude / CodeBuddy / Gemini / Kimi / Qwen / OpenCode，tests/plan-approval.test.ts + fixtures/plan-screens.json）：
                             # 认屏（isPlanMenu：旁路结束计划工具、屏上标题或问句）、选项说成中文并标开工后哪一档（planChoice：go / revise / stay / leave / other，
                             # 认不出照原文；openFirst = Kimi Revise 先回车）、方案原文三级来源（旁路 > latestPlanText 会话里写进 plans/ 的调用 > screenPlan 屏上）；
                             # 卡片是 ChatDecisionCard PlanCard，按键走 TerminalPage answerMenu(index, MenuAnswer)，开工后 onPlanLeft 改标签权限；
                             # planCardChoices：只讨论的目标 / 聊想法（PendingTerminal.discussOnly → ChatSurface planStartBlocked）不给开工
  file-thumb.ts              # 任意项目文件的缩略图（「引用项目文件」网格）：图片读原图、PDF / Word 走 doc-thumb 整页、表格 / CSV / 文字排 4:3 小纸；
                             #   键带修改时间的缓存、同时最多画三张；画不出返回 null 由调用方画类型色块（tests/file-thumb.test.ts）
  project-file-pick.ts       # 「引用项目文件」弹层纯逻辑：行内日期（fileDateLabel）、所在文件夹、搜索结果去文件夹、勾选顺序（tests/project-file-pick.test.ts）
  chat-project-picker.ts     # 输入框项目弹层纯逻辑：最近 6 个 / 搜索 12 个、类型与项目默认、随手聊 / 主目录固定行（pickerRows）；UI 在 components/ChatProjectPicker.tsx，
                             # 选了项目带项目默认由 TerminalPage pickDir 做（chat 槽 > 项目默认，project-agents.ts projectChatLaunch）（tests/chat-project-picker.test.ts）
  jump-formations.ts         # 聊天「回到最新」浮钮三枚光标（MesaThinkingDots）的队形表（一行 / 三角 / 倒三角 / 一摞 / 台阶 / 竖排圆点 / 折行）+ 随机挑下一个（不重复）+ 按总路程最短分配格子（换队不交叉）（tests/jump-formations.test.ts）
  launch-combos.ts           # 模型菜单「最近在这个项目用过」：按工作目录记 Agent + 连接 + 模型 + 思考档，最多 3 套，localStorage 只存 id（tests/launch-combos.test.ts）
  effort-depth.ts            # 思考档深度 0..1 与一句白话（effortDepth / effortGloss / effortValleyY）；小 M 画在 components/EffortMark.tsx（tests/effort-depth.test.ts）
  token-format.ts            # 聊天变体状态栏的 token 中文计数（千分位 / 万 / 亿，fmtTokensZh）；终端变体仍用 k / M（tests/token-format.test.ts）
  chat-decision.ts           # 「等你决定」卡的纯逻辑：连接出问题 → 卡片（connIssueDecision：同家连接最多三个「换到 X」按钮 / 去添加连接 / 先不换，提示按错误种类给另一条路）；方案确认卡的认屏与选项在 plan-approval.ts
  role-models.ts             # 连接的「模型分工」（后台小模型 / 子 Agent）：哪些 Agent 有、各角色说明、保存前归一、Claude 别名指向（与 agents.rs claude_model_env 同规则）
  help-links.ts              # 仓库与使用手册外链（REPO_URL / userGuideUrl）；仓库转 org 时与 updater endpoint、README 同步改
  popover-side.ts            # 聊天输入框小弹层往哪边开（pickPopoverSide：下面放得下就往下，贴底时往上）
  client-open.ts             # 客户端接力前端纯逻辑：目标 DTO、needsDialog（全部通过才免弹层）、检查项排序、主按钮文案、按钮/弹层标题措辞（项目级写「打开项目」）；预检与深链全在后端 client_open.rs
  switch-strategy.ts         # 运行中换模型 / 思考档走命令还是重开接回：SWITCH_PERSISTS 记哪几家的切换命令会写回自己的全局配置（实测表），
                             # 会写回且启动时注得进的改走 relaunchWith（runtime-model-effort.ts 消费；tests/switch-strategy.test.ts）
  components/ContextRing.tsx # 上下文用量圆环：模型芯片右边（状态栏在时由状态栏聊天变体画）与终端底栏右区共用（终端底栏传 xterm 调色板颜色）；悬停可加 extra 行（本段 token · 经连接）；点开是上下文浮层
                             # （总量 + 分类色横条 + 分类列表 + 离自动压缩还有多少 + 压缩上下文），同一轮的分类明细模块级缓存
  context-breakdown.ts       # 上下文浮层纯逻辑：哪几家能读分类（breakdownSupported）、标签状态 → 读取参数（breakdownRequest）、
                             # 分类中文名、行与横条（contextView：四大类各一色、小类同灰、顺序固定；配色 SERIES 经 dataviz 校验器验过，改色先重验）
  runtime-model-effort.ts    # 运行中切模型 / 思考档的共用 hook（useRuntimeModelEffort）：终端底栏与聊天「模型 · 思考」芯片同用一份；切过的模型名按 ptyId 存模块级表，两处实例同步
  conn-issue.ts              # 认终端画面里的连接错误（额度 / 限流 / 钥匙 / 服务 / 模型）：七家实录形态的 detectConnIssues、按次数判新错误的 newestConnIssue、给人看的 connIssueText
  terminal-quote.ts          # 终端选中文字交给对话 / 存笔记的排版：quoteForChat（每行「> 」）、askAboutText、clipNoteEntry（notes/clips.md 小节）
  live-reply.ts              # 聊天实时预览：按每家画面布局（LAYOUTS：Claude / Codex / Qwen / Gemini / Grok / Kimi，第三期抓屏定的）抽出这一轮正在写的段落
                             # （extractLiveReply）+ 长回复滚出屏后按屏顶位置接到上一次后面（mergeLiveReply，不要求尾巴逐字相同）+ 剔掉会话文件已有的行（unsyncedTail）+ 屏上有没有输入框（terminalHasInputBox）+ Claude 转圈行已生成 token 数（claudeOutputTokens，聊天层「正在回复」后显示）；
                             # CodeBuddy / OpenCode / Cursor 返回 null。新增一家先抓屏、样本进测试
  menu-key-nav.ts            # 聊天输入框小弹层的键盘操作（useMenuKeyNav：打开聚焦当前项、↑↓/Home/End、关闭还焦点）
  auto-load-older.ts         # 回放往上翻自动加载更早一页（useAutoLoadOlder：对话页 / 项目对话 / 聊天层共用；只认用户滚动，
                             # 不满一屏自动补页）+ wasPrepended（聊天层前插判定，最新窗后滑不算）
  progressive-rows.ts        # 长列表分段渲染（useProgressiveRows：先画 150 行，离底三屏接下一段，换筛选回第一段；选中项在后面画到它）；对话页列表在用
  run-caret.ts               # 运行状态光标三态（working 灰色呼吸 / idle 淡灰 / confirm 琥珀）：注意力 → 光标、几个合成取最要紧；
                             # 凡说「这段对话的 Agent 现在怎样」都用它，不再画绿点 / 黄点（组件 components/RunCaret.tsx）
  reading-anchor.ts          # 阅读位置自己锚（useReadingAnchor：对话页 / 聊天层；滚动时记眼睛看着的那块，内容变尺寸就挪回；
                             # 红线：滚动容器 [overflow-anchor:none]，不按 scrollHeight 差值补，不交回浏览器自带锚定）
  model-history.ts           # 「这份连接能选哪些模型」：连接名单 + 按 Agent+连接记的手填历史；开聊前选择器、启动栏、模型芯片同源
  image-models.ts            # 出图模型的家族归类、「最新在前」排序、各家推荐、耗时估算与进度（到结果前不满格）；纯逻辑
  model-kinds.ts             # 模型分类（出图/视频/向量/重排/语音/审核 = 不能对话）+ isImageGenModel；与 image_gen.rs 镜像，
                             #   两侧测试共读 tests/fixtures/model-kinds.json。连接目录面板隐藏、对话菜单置灰、启动栏过滤都用它
  tui-menu.ts                # 认屏上的 TUI 选择菜单（parseTuiMenu / menuAnswerKeys / sameTuiMenu / menuEchoesText）：切换命令后 5 秒、启动后 20 秒、
                             # 以及这一轮没结束前都扫屏，切换确认与七家工具审批按原文给按钮；剥方框边与滚动条、Grok 单选改写成序号行、
                             # 没有 ❯、当前项只靠序号颜色的编号菜单（OpenCode，colorMarkedMenu，要有按键提示且恰好一行颜色不同）、
                             # 折行并回上一项、问句取贴着选项的发问行；回显的 /命令、⎿ 续行、用户刚发的编号清单、上下被横线夹住的输入框草稿都不算菜单
  tui-ask.ts                 # Claude 提问表单（AskUserQuestion）按表单读（parseClaudeAsk：题签 / 当前题靠底色 / 问句 / 选项与说明 / 勾选 / 「自己写」 / Submit（多题未完时写 Next） 行 /
                             # Chat about this / 确认页）、要按的键（askAnswerKeys）、哪一下算交卷（askFinishes：卡片当场收起、到确认页替人确认）、多选先照按键结果画（askAfter）、给通用菜单流程的摘要（askMenu）；
                             # 卡片在 components/ChatDecisionCard.tsx AskCard（tests/tui-ask.test.ts）
  prompt-suggestion.ts       # Claude「猜你下一句」：输入框那一行除第一个字外全是灰字才算（readPromptSuggestion），排除 Try "…" 等固定提示；
                             # 聊天输入框空着时当占位字显示、Tab 填入（tests/prompt-suggestion.test.ts）
  screen-cells.ts            # xterm 一行转成每个字的样子（灰 / 反色 / 底色 / 字色，lineCells）：只看文字认不出的读屏用（猜的下一句、提问表单当前题、Kimi 选择器的说明行）
  tui-panel.ts               # parseTuiNotice：没有输入框 + 「Enter to continue」= 要按回车才继续的通知（Claude 中途弹的计费说明），
                             #   聊天层给「继续」卡（回车），认出时不再当面板；
                             # 认「终端里开着一个面板」（parseTuiPanel：没有该家输入框 + Esc to cancel/close 一类关闭提示；/cost、/usage 的 Settings 面板）：
                             # 与菜单同一次扫屏，认出菜单时不算面板；聊天层给「结果在终端面板里」卡，不再挂「正在生成回复」（tests/tui-panel.test.ts）
  sidebar-chats.ts           # 侧栏项目树挂对话纯逻辑（2026-10-23）：每个文件夹列哪几段（projectChats / scratchChats：按最近活动，
                             # 归档 / 内部 / 源文件不在的不列）、对话与文件夹的运行状态（chatDot / folderDot / scratchDot：run-caret 三态，文件夹取最要紧的）、
                             # 正在看的标签归哪个文件夹（currentFolderKey，工作树归主仓）、展开默认（folderOpen）、短标题去「MMDD|类型|」
                             # （sidebarChatTitle）、各文件夹列几段（chatQuotas / chatSlots：至少 5 段、按侧栏空位补满；expandedExtra：
                             # 「还有 N 段」在眼下段数上多 10 段）、开着但列表里还没有的标签挂到哪（openTabRows，10-24）、
                             # 置顶对话（CHAT_PINS_KEY / parseChatPins / toggleChatPin / pinnedChats，10-24，localStorage，与「保留」快照无关）、
                             # 侧栏键盘走（railNavIndex，10-24）
                             # （tests/sidebar-chats.test.ts；界面 ProjectTree，tests/project-tree-chats-ui.test.ts）
  chat-unread.ts             # 跑完了没看的对话（2026-10-24）：注意力 working → done 那一刻没在看就记，看到即消；会话键优先、标签键认出会话后挪
                             # （nextUnread；App 维护 store.unreadChats，ProjectTree 把那一行标题亮到 l1；tests/chat-unread.test.ts）
  rail-width.ts              # 应用侧栏宽度（2026-10-24）：14–26rem、默认 18rem、窗口小时上限收到窗宽 40%，localStorage 记偏好（tests/rail-width.test.ts）
  start-page.ts              # 「启动时进入」四种去处（2026-10-24）：工作台 / 上次的对话 / 上次的项目 / 新对话，旧存值当工作台；与 settings.rs KNOWN_START_PAGES 同步；上次的项目 = 最后看的那段对话所在的项目（projectOfCwd 取最深的项目根），App 在运行页正看着时写 localStorage ccode.lastProject（tests/start-page.test.ts）
  run-layout.ts              # 运行页两块宽度（2026-10-24，文件树并进右栏后由三块变两块）：对话 ≥ 360、右栏默认 460 / ≥ 360，偏好与实际分开，不够时只压右栏
                             # （runLayout；tests/run-layout.test.ts）
  idle-stop.ts               # 空闲对话的后台进程自动收（2026-10-24 用户拍板 A）：普通对话（isPlainChatTab）Agent 回完话、没在看、输入框没字，
                             # 满 30 分钟（IDLE_STOP_MS）该收哪些（idleStopPass 维护开始空闲时刻）；纯终端 / 步骤 / 车道 / 阅读 / 自定义运行时不收
                             # （tests/idle-stop.test.ts；TerminalPage 每分钟一检）
  quick-chat.ts              # 快速开聊纯逻辑：默认选择 pickQuickChatDefault（记住的 → 同家另一条 → 上次启动 → 装了的第一家）、
                             # 空白标签 isBlankChatTab（再点只复用没说过话的）、新对话入口的复用键 isNewChatKey（quickchat: / 项目 ＋ 的 <类型>:<项目>:project:<uuid>）、
                             # Windows 上 Codex 在主目录启动前要不要确认 codexSandboxCoversHome（完全访问不提醒）、
                             # 连接页「新对话」chatChoiceForProfile（点哪条用哪条，模型取名单第一个，不看记住的默认）、
                             # 随手聊目录 isScratchCwd、从列表点开对话时能顺手收掉的标签 isThrowawayTab（只看没说 / 空白新对话、输入框没字）
                             # （tests/quick-chat.test.ts；随手聊历史列表 10-23 撤，挂进侧栏 sidebar-chats.ts）
  quick-chat-launch.ts       # 快速开聊派发入口 openQuickChat（不弹窗，四个入口共用；每个标签自带 quickchat:<uuid> 复用键 + reuseBlank）、
                             # openChatWithProfile（连接页行上「新对话」：同一落点但点名要这条连接，reseedBlank 把已有空白标签的输入框改过去）、
                             # saveQuickChatChoice（随手聊发第一句后记 Agent/连接/模型/思考档，不记文件夹和权限）、
                             # openConversation（列表里点一段对话：侧栏项目树 / 工作台 / 对话页「继续」——resumeLazy 只看不起进程、
                             # 发第一句才接回，源文件不在的去对话页；split = 右侧分屏）、resumeSessionInTerminal（接着聊一段旧对话的底层派发：
                             # Mesa 标签持着就切过去；连接 / 模型 / 思考档用这段对话上次的（session_resume_config）；Mesa 自己最后写的不弹外部终端提醒）、
                             # prefetchConversation / conversationPageFor（侧栏对话行悬停就预取接回身份与记录页，缓存规则在 conversation-prefetch.ts）、
                             # openProjectChat（项目 ＋ 新对话，10-24：空白对话、发第一句才启动、每次新开，项目说明在 TerminalView 发第一句时按目录现拼附在第一句前）
  conversation-prefetch.ts   # 点开对话前的预取缓存（2026-10-24 切对话卡顿）：接回身份 OneShotPrefetch 用一次就扔、10 秒过期（Run 发第一句后才登记，
                             #   留久了会分裂出新 Run）；记录页 VersionedCache 按会话 updatedAt 认，24 段 LRU（tests/conversation-prefetch.test.ts）
  confirm-dialog.ts          # 确认框键盘语义：Esc 取消，Enter 激活当前焦点钮；设为全局挡路可 focusCancel（tests/confirm-dialog.test.ts）
  custom-runtime.ts          # 自定义运行时默认 cwd：仅空目录/scratch 启用（tests/custom-runtime.test.ts）
  unbind-impact.ts           # 解绑/删网关前「会怎样」文案（定时任务/项目/目标；连接页解绑与网关库「解绑并删除」共用，tests/unbind-impact.test.ts）
  gateway-slot.ts            # Agent→协议槽与目录刷新优先槽（与 slot_for_agent 双端镜像，tests/gateway-slot.test.ts）
  gateway-option.ts          # 网关选择器行（主机/协议槽/模型数，同名同址补尾号）+ addConnectionDefaults（「＋ 添加连接」默认：
                             #   没有连接在用的网关取最后建的、预选「选用已有网关」；Agent 挑已装且网关填了其协议槽的，
                             #   有 Claude Code 先选它）（tests/gateway-option.test.ts）
  command-palette.ts         # 命令面板过滤与排序纯逻辑：searchOnly 默认不列、得分（标题全等/开头/「前缀：名字」开头/包含 > 别名 > 散字兜底）、组按最高分排且组内连续、matchedKeyword（tests/command-palette.test.ts）
  stats-insight.ts           # 统计页花费环比 / 会话标题回落纯逻辑；compact/fmtCost 统计页统一数字方言（tests/stats-insight.test.ts）
  usage-activity.ts          # 活跃度热力图纯逻辑：周一开头滚动网格（去年同月 1 日到今天，不翻年；整年网格
                             #   buildYearGrid/yearBounds/future 标记随 2026-10-15 时间窗改口移除）/ 月份标签避让 /
                             #   非零天四分位分档（GitHub 同构）/ streaks（今天宽限，跨年不断档）/ yearStats / 中文日期短语 /
                             #   布局：heatCellPx 11–28 夹紧（2026-10-16 单模，rail/wide 三档判定已撤销）；
                             #   口径铁律：着色、活跃、streak 恒只算非 internal（official 计入），着色量=四类合计（tests/usage-activity.test.ts）
  gateway-balance.ts         # 网关余额卡纯逻辑：主机命中 / 站点币种金额 / 已用百分比 /
                             #   大数字拆币种符号 splitBalanceAmount（整串 2xl 头重脚轻、tokens 更长）/
                             #   同站账户合并 groupWalletAccounts（**分组键 = origin + account，不能只按
                             #   origin**：同站两个账户必须分开；认不出账户的行并进本站第一组不丢行）+
                             #   walletAccountTitle（单网关用网关名，多网关/并排时标「站点 · 账户」）+
                             #   walletTokenQuota（三条分支合一：token 数据 > billing 提升值 > null；
                             #   **回落提升值必须带 source !== "wallet"**，否则拿钱包余额冒充密钥额度）+
                             #   walletExpirySoon（只有临近/已过期才在卡面露到期，0 = 无到期不算 1970）+
                             #   walletUnlimitedLine（不限额度也要把已用说出来）+
                             #   walletUnlimitedFill（开口条：同卡已用的 log1p 比，最长停在 95，已用 ≤ 0 不画）
                             #   （tests/gateway-balance.test.ts；与 gateway_balance.rs WALLET_HOSTS 双端镜像）
  plan-quota.ts              # 订阅余量卡纯逻辑（用量页，与 gateway-balance.ts 并排的第二张卡）：
                             #   供应商显示名/切换标签/窗口名/重置倒计时/重置卡；
                             #   **双窗同构**（2026-09-21）：最紧的窗口走大数字 + 通栏粗条，另一窗收成一行
                             #   （名称 + 随行拉长的条 + 百分比贴条尾 + 绝对值 + 倒计时；条与密钥行共用，见 StatsPage SecondaryUsageTrack），
                             #   最紧的窗口排第一（planWindowsByTightness / planPrimaryWindowIndex，并列取靠前者）——
                             #   本机实测 5 小时 0%、周 100%，固定锚 5 小时会把爆掉的周额度藏住；
                             #   planResetRemain：卡面只写「还有 28 小时 51 分」，时刻放悬停（formatResetPoint）；
                             #   quotaTone：分档 → 条/数字同一套颜色令牌（正常档**不着色**，一片彩字反而看不出该管哪个）；
                             #   绝对值走 formatQuotaPoints（手写千分位）+ planAbsoluteQuotaPair（百分比旁；
                             #   已用超过总量时按总量封顶，140,023 显示成 140,000 / 140,000；解析层仍如实；
                             #   MiniMax 只回百分比就不显示）；
                             #   重置卡两列平铺不套内卡（auto-fit），名称「5 小时重置卡 / 周重置卡」，
                             #   张数做微型胶囊；期限卡面只写日期，时刻悬停；3 天内/已过期标黄；
                             #   planResetCardHighlight：只给最紧且 ≥90% 的那张按钮上强调色，**不禁用**另一张；
                             #   planWindowUnused：窗口一点没用（0%）**只劝退，不禁用按钮**——用户拍板 2026-09-21
                             #   「看着劝退吧 不拦截」。落地：①确认框写已用 X% ②0% 确认按钮改「仍要用」；
                             #   **重置卡里不写「已用 X%」**（用量已经在上面两个窗口）；
                             #   planLevelLabel 全小写等级首字母大写（智谱实测回 level:"max"）
                             #   （tests/plan-quota.test.ts）
  hotkeys.ts                 # 快捷键组合串纯逻辑 + 页切清单 PAGE_HOTKEY_DEFS（顺序 / 字同侧栏，10-24 重排）+ 新对话 / 在侧栏里选对话 / 聊天↔终端默认绑定
                             # + globalHotkeyAllowed（Win / Linux 焦点在终端里不抢 Ctrl+N 等）+ FIXED_HOTKEYS（设置页只读列出）
  themes.ts                  # 主题清单单一出处 + isLightTheme() 亮暗判定单一出处 + DEFAULT_THEME_ID（首装琥珀，与 settings.rs 同步）（禁另造判定；
                             #   custom / custom-light 不进十四套清单）
  theme-follow.ts            # 主题跟随系统深浅：同名 twin（xxx ↔ xxx-light）换算；store 在设置读写后与系统
                             #   外观变化时调用，把 theme 写成生效值；自定义配色不跟随（tests/theme-follow.test.ts）
  theme-swatch.ts            # 设置页主题色卡预览色：从 App.css 源文本抽 rail/canvas/cta/l1，
                             #   禁止临时切 data-theme 再 getComputedStyle（tests/theme-swatch.test.ts）
  custom-theme.ts            # 自定义主题：三色种子派生全套令牌 + 另存色卡列表
                             # （tests/custom-theme.test.ts）
  profile-copy.ts            # profile 跨 agent 复制纯逻辑
  resume-profile.ts          # 恢复会话的 profile 挑选纯逻辑：codex 内联 provider 会话（rollout 记
                             # model_provider="ccode" 或派生名 ccode-<网关短id>）按网关挑绑定；
                             # openai→官方账号（未登录改网关）；其他名字（客户端 custom 等）只挑网关、不掉进官方；
                             # 软停用（hiddenProfiles）跳过停用项——wishedId 指向停用项同样跳过，全停用时回落含停用项池不拦死
                             # （tests/resume-profile.test.ts）
  combo-field.ts             # 网关库逐模型策略三态（edit/readonly/hidden）纯逻辑（tests/combo-field.test.ts）
  ask-ai.ts                  # 项目区「问 AI」：选 Agent/配置/模型，可设为默认（tests/ask-ai.test.ts）
  ai-profile-choice.ts       # 设置页「AI 专用配置」选项拼装：一条配置的每个模型各占一项，value 用
                             # 不可见分隔符拼 profile id 与模型名；agentLabel 把内部 id 换展示名（tests/ai-profile-choice.test.ts）
  settings-storage.ts        # 设置「本机占用」卡纯逻辑：按归属分组（Mesa 数据 / 工作副本）、组根 ~ 折叠、相对名、
                             #   总计与「≥」下限标记、快照清理确认文案（tests/settings-storage.test.ts）
  conversation-tools.ts      # 对话按「轮」整理：助手一轮的过程（思考 / 工具调用+结果配对 / 中途说明）收成 turn 段、过程后的正文切成回答；
                             #   连着的读/搜并成「查阅」，最后一轮进行中（working 或有没回结果的调用）不切回答；时长、收起摘要（tests 同名）
                             # 2026-10-20：调用与结果按 callId 配对（没有 id 退回先后）；turnPlan / planEntries = 计划卡（各家待办参数收成一份，一轮取最后一次）
  tool-activity.ts           # 一次工具调用 → 一行动作（编辑 文件 目录 +N −M / 运行 命令 / 搜索 …）：九家工具名归类、常见参数键取对象、
                             #   Codex 补丁拆文件与脚本模式取 cmd、行级差异 lineDiff、结果状态只看开头（tests/tool-activity.test.ts）
                             # 2026-10-20：commandCategory（借 vibe-kanban）——只读命令（cat / sed -n / rg / ls …）归进查阅，改文件 / 取网页 / 其余照旧算运行；
                             #   unwrapPowerShell 剥 Windows 上 Codex 的 `pwsh.exe -Command '…'` 外壳（chat-channel displayCommand 共用），
                             #   完整 cmdlet 名（Get-Content …）任何时候认、别名（gc / type …）只在确认是 PowerShell 时认
  dep-check.ts               # 依赖体检前端镜像：DTO 判定与 DOM/Tauri 解耦（tests 同名）
  dep-install.tsx            # 依赖一键安装管线 useDepInstall + 日志块 DepInstallLog + 缺 Git 就地安装出口
                             #   GitInstallOffer（改动面板 / 历史浮层 / 开步报错条共用）
  stream-text.ts             # 流式命令输出的 \r 展开（镜像 updater.rs collapse_cr）：后端保留 \r 原样推，
                             #   前端存原文、显示前对全文展开；依赖安装 / CLI 更新 / 字体安装三处日志共用
  windows-shell.ts           # Windows WebView2 默认行为收口纯判定（刷新/打印/查找/后退快捷键、鼠标侧键、默认右键、
                             #   Win11 判定）；挂载在 main.tsx，仅 Windows
  gateway-draft.ts           # 网关库槽位纯逻辑：effectiveSlotUrl 主输入跟随/脱离、slotsFollowMaster、firstProbeableSlot
  goal-review.ts             # 目标验收弹层分组与文案：科研按文献/笔记/数据/论文、工作按文档/表格/幻灯（tests/goal-review.test.ts）
  history-view.ts            # 历史时间线白话翻译层（✓保存进项目/⚙自动保存/◔保存，hash/分支名降为二级）
  step-review.ts             # 科研步骤评审档案闭集 screening/files/acceptance/default；一张审阅壳按类型拼区块（tests/step-review.test.ts）
  step-evidence.ts           # 步骤卡证据徽标纯逻辑：从报告文本解析质量状态与 [待核实]/[待确认] 计数
                             #   （stepEvidenceSummaryOf：未决标记只数稿件正文，审查报告/改动记录里「描述」的不算）
                             # （报告自述，不是系统认证；tests/step-evidence.test.ts）
  review-save-copy.ts        # 科研保存链白话：保存进项目；不是编程合进基准、不是科研验收决定
  kickoff-inputs.ts          # 开步确认弹层「上一步接到的输入」芯片；isDeclaredStepInput 排除已声明输入，不进未登记列表；
                             #   unsavedUpstreamSteps：前面哪些步骤（进行中/待评审/有冲突）的产物与本步必读输入重叠、还没保存进项目
                             #   （模式按首个 * 前缀互相覆盖判定，宁多认；tests/kickoff-upstream.test.ts）
  lit-list.ts                # 无流程科研文献/笔记列表：展示名、编号、状态与过滤纯逻辑；pdfLitState + LIT_STATE_LABELS（文件页 PDF 行与资源列表同一套状态词）
  model-switch.ts            # 各 CLI 多模型注入能力表 + 启动栏提示纯逻辑（对应 agent_specs.model_switch）；
                             # runtimeModelSwitch 按连接收窄运行中切模型（Kimi 接口连接只带一个模型，/model 别名换不了）
  components/TopNavCapsule.tsx # 隐藏侧栏时的灵动岛：休眠面＝状态（当前页标签 + RunActivityStatus 只读活动 + 只读播报，当前页格聚焦/点击只展开岛）；
                             #   展开面＝操作（恢复侧栏居首 + 对话切换器 + 导航 + 可点活动胶囊 + 可点播报）。休眠面控件指针够不着，只放展示；不挂导航角标；
                             #   运行页上休眠面写正看着的对话名（ChatSwitcher.useCurrentChatLabel）；「运行」不上岛（nav-capsule 可见判定拦掉）
  components/ChatSwitcher.tsx # 灵动岛对话切换器（2026-10-24 A+D+E 的 D）：按钮写正看着那段 / 「打开的对话 N」，点开弹打开的对话（sidebar-chats.paletteOpenChats，
                             #   portal 到 body 同活动面板）+ 搜对话…；活动胶囊管「谁在跑」，这里管「切到哪段」
  components/RailPeek.tsx    # 探出整栏（2026-10-24 A+E）：图标态 / 完全隐藏时把同一棵 ProjectTree 盖在内容上滑出（App 挂、store.railPeekOpen）；
                             #   鼠标离开、Esc、点外面收，去了别处（换页 / 换正看着的标签 / 选项目）时鼠标还在里面不收、不在里面（⌘0 键盘选的）才立刻收（2026-10-25）；开着菜单或在改名时离开不收；useRailPeekTrigger 管悬停触发
                             #   （图标栏中段空白 0.12 秒、隐藏态左边缘 8px 0.32 秒），⌘0 也开。ProjectTree 的 focusRailReq 只认挂载后的新请求，探出层挂上不抢焦点；
                             #   动画是 data-shown 驱动的 CSS 过渡（App.css .ccode-rail-peek，可半路改向），收起由 App 的 useExitRender(180) 多挂一会儿
  nav-capsule.ts             # 侧栏可配置胶囊入口（恢复侧栏始终保留，不在此列）
  components/WindowControls.tsx # Windows 自绘窗口按钮（最小化/最大化-还原/关闭，46px 宽、关闭悬停红）；仅 Windows 渲染，
                             #   App 标题栏与 ReaderOverlay 顶栏（盖住标题栏）各挂一份；对应 Rust lib.rs setup 的 set_decorations(false)
  session-template-blocks.ts # 对话注入模板 ↔ 勾选模型：[项目基本信息] → 勾中的内容段（固定标准顺序）→ 我的补充；
                             #   parseSimpleTemplate（放不进返回 null）/ serializeSimpleTemplate / coerceSimpleTemplate（只丢顺序不丢字）/
                             #   sectionSummary；盘上仍是同一份模板文本（tests/session-template-blocks.test.ts）
  acceptance-log.ts          # 验收账本文案：kind → 人话（进主仓 ≠ 科学验收）；acceptanceEntryRow = 设置抽屉验收记录一行
                             #   （lit-watch→文献雷达、版本短号进悬浮、系统备注「定时巡检采纳」不重复；AcceptanceLogList 渲染）
  project-context-load.ts    # 启动环境说明拼装：读档案卡和顶层目录，失败仍返回能用的短包；
                             #   session 包按档案卡对话注入三态分叉（off=空串 / custom=模板 / 其余=自动，空模板 fail-open 自动）；
                             #   sessionOverride 只给设置面板预览用（按未保存草稿渲染），开对话一律读盘；
                             #   loadSessionTemplateValues = 每个占位符此刻的内容（project-context.ts sessionTemplateValues，与渲染同一出处）
  notes-progress.ts          # 精读进度：notes/index.json 按 reviewStatus=reviewed（旧索引的 done/read 同义）数已写笔记、按 fulltextStatus 分全文/仅摘要，
                             #   StepFlow 精读步「AI 干活」行下一行进度（工作区优先、项目根兜底）；spotCheckPicks =
                             #   「抽查 3 篇笔记」三篇候选（全文/仅摘要各取中间一篇再从尾部补，确定性，带 included.json id；tests/notes-progress.test.ts）；
                             #   excludedIncludedIds：included.json 里 decision=excluded 的篇不进进度分母
  spot-check.ts              # 抽查核对档纯逻辑：SpotCheckSession（readerReq.spotCheck 外形）、问题单按 base 记 localStorage、
                             #   spotCheckFocus 每篇要看什么、buildSpotCheckPrompt 交回这一步 AI 的消息（按篇分组带出处，tests/spot-check.test.ts）
  stepper-status.ts          # 步进器圆下状态小字的文案与色（待开始/检查中不写，进行中按终端注意力细分等你确认/等你查看；
                             #   ProjectGroup 状态带唯一出处，tests/stepper-status.test.ts）
  research-report.ts         # 研究报告节抽取/相对路径解析（只认显式报告节，不认 TASK 指令或推断结论）
  research-report-load.ts    # 研究文件读取：readResearchFile（256 KB 预览通道）/ readResearchLedger·saveResearchLedger
                             #   （纳入清单、待获取、RIS、笔记索引、引文库整份读写，见 fs_tree.rs 台账白名单）+ 报告扫描
  screening-review.ts        # 检索/筛选评审主面：计数/待拍板/筛选决定、表默认 pending、文件分组；included.md/json 不与表并列摊 diff；
                             #   displayCitationTitle 只改清单显示（苹果字符、拆开的化学式），不回写 json
                             # 移出：removeToFetchEntry 不重排编号、removeRisRecord 按 DOI/标题删整条、notePathForRecord / bibMentionsRecord 只提示不删；
                             # 接口缓存、脚本、.gitignore 进「过程」，不进非 Git 产物清单；
                             # pendingConfirmCleared = 有篇且无 pending，步骤卡据此自动勾「核对待确认篇目」（tests/screening-review.test.ts）
                             # risBody / includedMdLine 与检索步脚本 lit_records.py 的 ris_block / md_line 同一拼法（双端镜像，
                             #   tests/lit-records.test.ts 逐条比对）；「待补」不进任何 RIS 标签（filled）
  review-file-groups.ts      # 精读/写作评审文件分组：笔记/稿件/引文/待获取/过程（tests/review-file-groups.test.ts）
  closeout-pack.ts           # 项目卡完结清单：最终稿 / 源稿 / 图 / 文献 / 核对 / 笔记（tests/closeout-pack.test.ts）；
                             #   索引里没有的笔记（沉浸阅读建的）按 list_paper_notes 来源行配 PDF、题名取 PDF 文件名
  research-tool-fields.ts    # 科研工具字段表 / 默认值 / 档案卡键读写与 readableResearchToolSetting（机器键→界面说法）；纯模块不引
                             #   React / Tauri，上下文包从这里取，research-tools.ts 原样转出
  research-tools.ts          # 科研工具注入 withResearchTools；定稿步同时挂 output/endnote.docx 与 output/zotero.docx（LaTeX 不挂）；
  skill-slots.ts             # 技能位单一出处：{skill:锚名} 占位解析（provides 优先、名字兜底）、行为键判定、provides 映射 hook；锚名闭集见 pipeline.md（tests/skill-slots.test.ts）
                             # 域稿不再挂成定稿步人工事项（入口在完结文件，2026-10-24）；老档案的域稿行不挂文献库同步按钮；来源只认 lit_source
  review-decisions.ts        # 审查报告 R/S 与待核实 V 的拆条、接受/拒绝/修改写回、点完后的继续提示
  handback-tasks.ts          # AI 写好、人来填再交回的人工事项（转载许可清单、投稿声明）：按标题认，给「打开」「交给 AI」与交回的话
  handback-files.ts          # 上面两份文件的结构化读写：许可清单表格逐行拆、只改状态格；投稿声明按 ## 分节，空节写回「待填」
                             # （tests/review-decisions.test.ts）
  academic-mcp.ts            # 检索步「配置学术检索 MCP」：预设名、登录注入；登录态由 academic_mcp_login_status 回一句现状（tests/academic-mcp.test.ts）
  session-filter.ts          # 对话页筛选纯逻辑 + 列表行项目名 sessionProjectLabel（Claude 编码目录名经 claudeProjectDirName 认回项目；tests/session-filter.test.ts）；
                             #   PROJECT_SESSION_EXCLUDE_HINTS = 侧栏 / 工作台 / 任务卡不列的按钮拉起会话（问 AI、沉浸阅读），接力简报 2026-10-24 起照列
  session-search.ts          # 对话搜索纯逻辑：分词、元数据即时过滤、正文命中合并排序
  session-slim.ts            # 会话瘦身纯逻辑（撞网关 413）：提示条/菜单项出现条件、拦路原因（Mesa 终端在跑 / 最近一分钟有写入）、瘦身后体积预告、结果文案（tests/session-slim.test.ts）
  session-transfer.ts        # 会话导入向导纯逻辑：状态文案、目标目录预填、可否执行
  step-decisions.ts          # 决策项：答案落任务书草稿固定小节；isTaskMdStub = 空/仅决策/仅评审沉淀不算可执行正文，resolveTaskMdSource 走模板拼装并接沉淀（decisionGate/orderedAnswers/parseDecisions，tests/step-decisions.test.ts）
  terminal-resume.ts         # 终端会话恢复的标签复用与配置挑选纯逻辑（2026-09-08 审计修复）；接着聊用会话自己的连接 resumeProfileChoice、
                             # 模型在连接名单里才带 resumeModelChoice、最近一分钟的写入是不是 Mesa 自己刚停掉的 lastWriteIsMesas（2026-10-24）
  terminal-geometry.ts       # 启动前收不收栏、没量到格子就不起进程、起来之后谁可以改行列
  terminal-renderer.ts       # 用哪种渲染器：设置「终端渲染」（自动 = WebGL，两个平台同；只有「兼容（DOM）」不走）；
                             # webglLetterSpacing = WebGL 单元格宽就近取整的补位（tests/terminal-renderer.test.ts）
  store.ts                   # zustand 状态。applyTheme 同步原生窗口外观；Windows 上同时把整窗 Mica 切到 micaDark/micaLight
src-tauri/
  build.rs                   # 构建脚本：mesa_helper 占位、extension-src 预拷贝、tauri-build；MSVC 下应用 manifest 改由链接器嵌进
                             #   所有链接产物（含 lib 测试 exe，否则 cargo test 报 0xc0000139），别退回 tauri_build::build()
  windows-app-manifest.xml   # Windows 应用 manifest（Common-Controls 6.0，与 tauri-build 默认相同），build.rs 交给链接器
src-tauri/src/
  agent_specs.rs             # AgentSpec 中央注册表：一个 CLI 一张规格（detect/launch_plan/env/技能分发/安装更新/官方账号 login/readonly_args 只读模式参数/permission_args 原生权限档（聊天权限徽标，agents::permission_launch_args）/
                             #   model_switch 运行中切模型（claude/gemini/kimi/grok 带参直切；codex/opencode 唤选择器——两家 CLI 无带参直切：
                             #   codex /model 无内联参数（源码 supports_inline_args 不含 Model）、opencode /models run 无参，2026-09-15 实证；
                             #   状态栏 picker 档点芯片即唤选择器、不摆模型假菜单）与
                             #   effort_levels 思考档槽位（claude /effort 五档、kimi on/off、qwen 0.22.0
                             #   /effort 五档实证；codex 待实机）；
                             #   能力表三字段 fail-loud（原因即用户可见文案，后端报错与前端置灰同源）：
                             #   set_global（cursor 不支持）/ mcp_write（grok 只读，请用 grok mcp add）/
                             #   skill_dist（cursor/grok 强制 copy）——global_config/mcp.rs/skills.rs 全部改查表，
                             #   前端经 agent_capabilities command 读表置灰）；
                             #   请求策略通道表 request_policy_support（逐字段按入口记账：
                             #   inject=启动注入 / persist=仅设为全局 / tui=仅会话内命令 / unsupported / unknown；
                             #   只认二进制/配置 schema 实证，调研录 matrix §9 第 8 条；agents.rs
                             #   apply_request_policy_env 按表注入启动 env，未实证一律不注）；
                             #   resolve_binary 兜底候选目录 binary_candidate_dirs 同在本模块（macOS 含 /Library/TeX/texbin、/Applications/quarto/bin；Linux /opt/quarto/bin；Windows Program Files\Quarto\bin）
  agents.rs                  # 适配器分发入口 + resolve_binary 二进制解析（GUI 短 PATH 兜底；resolve_binary_all 列全部候选给占位程序场景）+ readonly_launch_args（聊想法只读注入）；
                             # 官方账号 Codex：apply_official_inject 必带 -c model_provider="openai"（内置 ChatGPT 渠道；磁盘
                             #   config.toml 的网关默认会盖过订阅，不得省略；只影响本进程、不写 model_providers 块）；
                             #   login_cmd = login --device-auth（CLI 自带设备码，不抄 cc-switch 的 in-app OAuth）；
                             # codex 内联 provider 参数 codex_inline_provider_args 单一出处（启动注入与外部恢复命令共用：
                             #   新会话 provider 名 ccode-<网关短id>；旧 rollout 仍记 model_provider="ccode"，外部恢复缺 -c 定义报 provider not found；定义只含
                             #   base_url/env_key 引用不含密钥）；
                             #   网关启动另加 -c web_search="disabled" 与 service_tier="auto"（盖 ChatGPT
                             #   登录默认；官方账号不注；不写 config.toml）；不注 features.apps=false（0.154 会把
                             #   Consensus/Undermind 收成 mcp__<名> 占位，unsupported call）；内置 codex_apps 改关
                             #   plugins.codex-app-tools@openai-bundled.enabled=false（mcp_servers.codex_apps.enabled=false
                             #   报 invalid transport）；禁止 enable_mcp_apps；
                             # grok GROK_CONFIG overlay 单一出处 grok_config_overlay：白名单（grok-build OVERLAY_ALLOW_PATHS，
                             #   fail-closed）只放行 [models] 全局块——allowed_models 收敛 + 请求策略五项全局默认（headers 走
                             #   $VAR 引用不落密文）+ 有启动模型时写 default（1.0.34 实证：开会话前先拿 config.toml 的
                             #   [models].default 比对 allowed_models，不匹配直接拒启动，GROK_DEFAULT_MODEL 偏好在这道门之后才
                             #   生效——全局 default 常是别家绑定「设为全局默认」留下的，故必须覆盖；memory：2026-09-20）；
                             #   [model.<id>] 不在白名单，api_backend/context_window 由中转 /models 目录
                             #   条目 apiBackend/contextWindow 或 config.toml 提供（调研录 matrix §9 第 8 条）；
                             # 选择器显示名统一「配置名 · 模型」（claude _NAME 槽 / codex catalog display_name /
                             #   kimi KIMI_MODEL_DISPLAY_NAME / opencode provider+models name）；
                             # claude 不写 CLAUDE_CODE_SUBAGENT_MODEL（保留 Task 参数/frontmatter/inherit 原生选择链），
                             #   用 --settings 只覆盖本次连接的非敏感模型选择；
                             # claude 非 Claude 模型写 ENABLE_TOOL_SEARCH=false（弱模型拿 ToolSearch 搜内置工具、搜不到就不干活）
                             #   与 CLAUDE_CODE_ENABLE_TODO_TOOLS=1（新版只给自家老模型发任务清单工具）；
                             # claude 长上下文声明 CLAUDE_CODE_MAX_CONTEXT_TOKENS + CLAUDE_CODE_AUTO_COMPACT_WINDOW
                             #   同值成对（启动注入与设为全局同键同条件；注册链确知 >200K 才注，防第三方模型被按 200K 提前 compact）；
                             # codex catalog 的 base_instructions = 本机 Codex 对未登记模型的默认提示词原文：按版本取一次缓存到
                             #   <配置根>/catalogs/codex-base-instructions-<版本>.md（一次性 CODEX_HOME 跑 codex exec、密钥变量故意不给，
                             #   会话首行 session_meta 取原文、发请求前就退出，不联网）；取不到用随包 codex_base_instructions.md 兜底；
                             #   不得换回一句话占位：模型会不知道 apply_patch，改文件全走 Set-Content / 重定向，没有差异；
                             #   Windows 另拼 codex_windows_patch_note.md（只认整条 bash heredoc 的 apply_patch）
  codex_base_instructions.md # Codex 0.163 默认系统提示词原文（Apache-2.0，THIRD-PARTY 有条目），只在取不到本机原文时兜底
  codex_windows_patch_note.md # Windows 上 apply_patch 的调用口径（Mesa 自写，英文给模型看）
  model_registry.rs          # 模型能力注册表：逐字段查询链 = 用户覆盖 > 网关实测缓存（fetch_models 顺带沉淀
                             # OpenRouter 风格 /models 元数据）> 公共能力库（配置页 ⋯ 下载，models.dev 优先
                             # OpenRouter 回落，download_model_db/model_db_status）> 内置前缀表 > 关键词兜底；
                             # 字段 thinking/context/output/vision 全 Option（这层不知道就继续向下找，
                             # 显式 false 只在数据源如实给出时生效）；kimi capabilities/max_context_size、
                             # codex catalog、opencode reasoning/limit/modalities 全从这条链出；
                             # limit.output 兜底 8192（1.18 起 schema 必填）；宁缺毋滥（收错比漏报有害）；
                             # **声明层访问器（2026-09-26）**：model_context_size_declared_for /
                             #   model_output_limit_declared_for / model_supports_vision_declared_for /
                             #   model_thinking_declared_for——只认链上显式值，兜底层（fallback_context_size、
                             #   关键词 thinking、内置表确知多模态清单）不算。写进别人家 CLI 配置的值一律走这批，
                             #   分流：可省略的未知就不写（codex catalog 三键、codex -c 两键、kimi env 上下文），
                             #   必填的写保守下限（kimi config.toml max_context_size、opencode limit.*）；
                             #   确知多模态清单已收进 BUILTIN_CAPS（capsv），「不在表里」= 不知道而非纯文本；
                             # 字段新增 api_backend（grok 目录 apiBackend，闭集只收 chat_completions/responses/
                             #   messages；仅权威层有值，model_api_backend_for 供预览说实话）；
                             # fetch 沉淀解析兼容 grok 目录别名（contextWindow/context_window/_meta.totalContextTokens）；
                             # 文件型加载器 cfg!(test) 下不读本机真实缓存（链语义由 chain_field 单测覆盖）；
                             # model_context_size_authoritative_for = 仅权威层（用户覆盖+网关实测）的 context
                             #   访问器——grok 设为全局写 [model.*].context_window 专用（估值层不配覆盖中转目录）；
                             # 用户覆盖层有写入通道（2026-09-19）：网关库模型行「能力声明」编辑 →
                             #   set/clear/list_model_capability_override（原子写、前缀归一小写、api_backend
                             #   不进 UI 但往返保留；细则 conventions/profiles.md §6.1）；
                             # 下载公共库顺带提取定价（models.dev cost / OpenRouter pricing → 条目 cost 字段），
                             #   db_price_table 供 usage.rs 定价链消费
  capability_manifest.rs     # 能力写入清单（**不驱动写入**，只做记账与机器检查）：全表 WRITES 记「哪个 agent ×
                             #   哪个目标键 × 该键的 requiredness/completeness/harm × 依据强度」，
                             #   未知时动作**不存**、由 action() 从三个属性推——存下来会与属性漂移，
                             #   而漂移的表比没有表更坏。三档动作：Omit（可选就整个不写）/
                             #   ConservativeFloor（必填未知也写，但写下限并说清是下限）/
                             #   UnionWithDefault（完备声明 + 写少更坏 ⇒ 只加不减）。
                             # 为什么要有它：注册链前四层答「确知吗」、兜底层只答「给个数」，
                             #   把估值当声明写进别人家配置会**压低**真实能力（codex -c model_context_window
                             #   是硬覆盖，1M 窗口被按 128K 提前压缩）；更隐蔽的是完备声明键，
                             #   少写一个成员 = 断言「不支持」——kimi env KIMI_MODEL_CAPABILITIES 缺省集
                             #   ["image_in","thinking"] **不含 tool_use**，旧代码「非思考模型就不写」
                             #   静默剥夺了工具能力（根因：把「不知道」当成「假」；memory：2026-09-26）。
                             # 免除名单 NO_CAPABILITY_WRITES 带**理由**（NoConfigSurface / PolicyOnly），
                             #   不用裸字符串——空理由等于没记账；coverage_* 五条测试：
                             #   every_agent_is_accounted_for（新增第十家 CLI 时红，逼一次显式决策）/
                             #   no_stale_excuses / no_orphan_rows /
                             #   conservative_floor_is_never_used_for_a_complete_declaration /
                             #   kimi_env_capabilities_must_union_with_the_cli_default
  capability_golden.rs       # 能力写入的黄金样本测试装置（数据在 src-tauri/tests/golden/capability_writes.json）：
                             #   断的不是「某函数返回了什么」而是**用户可见的最终形态**——启动 env 表与
                             #   写盘的 toml/json 文本；单测各断自己那一段（agents.rs 断 env、global_config.rs
                             #   断 toml）互相不知道对方存在，kimi 那条错的注释正是这样活下来的。
                             # 放 crate 内而非 tests/ 目录：写入点私有/pub(crate)，集成测试够不到；
                             #   tests/golden/ 只是**数据**的位置约定，Cargo 只认 .rs 不会多出空 target。
                             # 期望值人工核对过二进制（不是跑一遍录下来）；golden_file_is_self_consistent
                             #   要求 id 唯一、why 非空、至少一条期望——防「加了一例但什么都没断」。
  profiles.rs                # 网关+绑定：gateways.json / bindings.json；keys.json 键=网关 id（0600）；
                             # list 物化成 Profile 视图（binding id 复用旧 profile id）；删除绑定=解绑不清密钥；
                             # 绑定级 api_backend 字段（grok 专用，仅设为全局写 [model.*] 消费；闭集校验 +
                             #   导出/导入 v2 随绑定走、非 grok 导入丢弃）；
                             # 有绑定的网关禁删；导出/导入 v2；见 docs/conventions/profiles.md
                             # 认证变量闭集 AUTH_BEARING_ENV 单一出处（无密钥校验 auth_bearing_env_name 与
                             #   导出剔除 sensitive_env_name 同源，防两处名单漂移；OPENCODE_CONFIG_CONTENT
                             #   这类内嵌整份凭据、名字无 KEY/TOKEN 的项只能靠闭集兜住）；
                             # 解绑清 settings 五字段（含 default_profiles / hidden_profiles）；schedules 的
                             #   profile_id 不置空——运行时硬 pin 拒绝静默换供应商，前端解绑前列受影响任务；
                             # §2 唯一约束单一入口 has_duplicate_binding(…, skip_id, candidate)：新建/复制/编辑/
                             #   导入 v2 四条路同一判据（编辑排除自身；选择没动时放行 update_selection_conflicts，
                             #   防历史重复对连改名都存不了——别当冗余删掉），漏一条就能「改一次模型」绕过；
                             #   导入另过 validate_profile_fields（agent 白名单/协议闭集/apiBackend/extraEnv 名），
                             #   不合格进 skippedSlots 原文列出，脏模型列表归一后才落盘
  combo.rs                   # Agent×模型×槽×体检求交器，DTO 下发；网关库走多 Agent 并集；
                             # 逐字段通道种类 channel_*（inject>persist>tui>unsupported>unknown 并集）随 DTO 下发，
                             #   inject_*_allowed 只认 inject，apply_to_profile 保留 persist 字段（设为全局要写）；
                             #   协议维度门控 channel_status_for（kimi effort 仅 kimi 协议通道，非 kimi 协议绑定按 unknown 计）；
                             #   混注提示覆盖思考与采样两种不一致（换模不重注）；
                             # policy_channel_note 通道形态说明（qwen 仅设为全局 / grok overlay 边界）随 DTO 下发
  drift.rs                   # 全局配置漂移：只比对 Mesa 写入键的子集，无关字段不算漂移
  gateway_store.rs           # 网关/绑定落盘与迁移；materialize 单一漏斗把绑定+网关物化成 Profile（gemini/claude-code
                             #   剥槽位末尾版本段——两家 CLI 自拼 /v1beta、/v1/messages，口径见 profiles.md §2 归一段）；
                             #   每槽体检摘要 latest-per-slot（摘要可按槽，绑定状态徽标
                             #   必须按「绑定默认模型 + URL/密钥指纹」取体检，禁「该槽最近一条」株连，§8）
  provider_id.rs             # provider 名 ccode-<网关短id> 单一出处；LEGACY="ccode" 仅旧 rollout
  tray.rs                    # 系统托盘：按 Agent 列绑定一键设为全局；选中态 dry-run 子集比对；不改启动栏默认；cc-switch 挡路时不写盘，发 `tray:set-global` 让连接页弹确认
  profile_validation.rs      # profile 三层验证：本地解析 → CLI 预检 → 最小 API 请求（脱敏）；
                             # 网关体检探针 probe_gateway（绕过 CLI 直连端点发 max_tokens=16 最小请求：
                             # 基础鉴权/裸流式 SSE 检测/带策略参数对比降级定位/自定义 Header 接受度，
                             # matrix §9 第 8 条）；请求策略字段校验（范围、claude effort 闭集、
                             # Header 名禁引号冒号、环境变量名 POSIX 字符集）
  client_open.rs             # 客户端接力（设计 docs/design-client-handoff.md）：Mesa 的一条对话/一个项目交给该 agent 的 GUI 客户端接着做。
                             # 探测（macOS 读 Info.plist 的 URL scheme + 版本，Windows 查 HKCR 的 scheme、版本取当前用户应用包仓库的
                             #   MSIX 包全名（两家 Windows 客户端都是 MSIX，2026-10-20 本机核实），30 秒缓存）→ 纯函数 build_plan 预检
                             #   （ok/note/warn/fix/block；Codex 查 state_<N>.sqlite 的 threads 表与 config.toml 的 provider 定义块，
                             #   Claude 查 transcript 文件与连接是否网关）→ client_open_list / client_open_plan / client_open_launch。
                             #   红线：客户端侧失败看不见，判断全在发深链前；launch 每次现算、修复只能选预检候选；会话 id / 块名后端校验后才进 URL / TOML；
                             #   读不到就不假装知道（Unknown 不出检查项）；深链模板与客户端规格数据在 agent_specs.rs 的 ClientSpec
  global_config.rs           # 「设为全局默认」：agent 级事务批次写入（备份/回滚/恢复）；写成功即记
                             # settings.active_global_profiles（配置页「全局生效」徽标数据源），恢复后清除；
                             # 恢复分两档——撤销上次写入（UI 名；最近批次，每 tag 轮换留 5 份）与恢复初始状态
                             #   （backups/<agent>/original/ 永久快照，首次 apply 时落、不参与轮换，
                             #   has_original_backup/restore_original_backup）；
                             # codex 渠道定义块补写 register_codex_client_provider_named（客户端接力「写入并打开」与会话导入调用；连接页入口 2026-10-19 已删）：只写 config.toml provider 定义块
                             #   （顶层 model_provider/model 不动、不记 active_global）；认证与「设为全局」
                             #   共用 experimental_bearer_token（ChatGPT 自带 Codex 的 ModelProviderInfo 认这个字段），
                             #   **不写 auth.json**，也不写 http_headers（MCP 字段，写在 provider 上客户端加载失败报 not found）；
                             #   requires_openai_auth = false；写块时清掉旧 env_key / http_headers；
                             #   逆操作只删定义块；codex_client_registered_profiles 供连接页菜单同位状态化；
                             # gemini 双文件：.env 之外必须加写 settings.json 的 selectedType=gemini-api-key
                             #   （v3.147 审计：缺它 gemini ≥0.46 headless auth 报错起不来，JSONC 容错读），
                             #   并登记 modelConfigs.modelDefinitions 让自定义模型进 /model 选择器
                             #   （experimental.dynamicModelConfiguration 开关，requiresRestart，只写不删）；
                             # qwen 条目级 generationConfig.samplingParams（snake_case 线格式，逐模型取值；
                             #   配了就跳过 CLI 的 max_tokens 自动钳制）；
                             # kimi 的 [models.*] 随写 display_name（配置名·模型，选择器 label 优先它）
                             # 与 capabilities（补集写入：恒含 tool_use，保留缺省里未被声明为假的成员；
                             #   未确知不猜——完备声明语义见 conventions/profiles.md 硬规则）；
                             # grok（2026-09-01 起）写 ~/.grok/config.toml：顶层 api_key + [endpoints].models_base_url +
                             #   [models].default 与请求策略全局默认（通用键只设不删，防误清用户手写值）；
                             #   每个绑定模型写 [model.<id>]（name；段键自动加引号）；有「API 后端」或
                             #   权威层上下文再写 api_backend/context_window——api_backend 在 Mesa 侧的唯一通道
                             #   （overlay 白名单不放行 [model.*]）。同段补推理菜单（1.0.40）：
                             #   supports_reasoning_effort + reasoning_efforts（value/label/description，
                             #   四档对齐内置 grok-4.6；已有菜单不覆盖）。中转目录把模型标成
                             #   supports_reasoning_effort=false 时改回 true，否则菜单写了也不出。
                             #   中转目录不带 reasoning_efforts 时不写这段则 /effort 不出
  projects.rs                # 项目档案卡（§11.3）：project.toml 读写、注册、资源登记/发现、一键开步、append_workspace_inbox、
                             # 摘记 append_project_clip（notes/clips.md，与文献摘录 excerpts.md 共用写入内核 append_notes_file_at；
                             #   手机文字走 append_clip_at；新建文件头 2026-10-20 起为通用「摘记」）、
                             #   槽位专属绑定（task_bindings 列：reader=沉浸阅读对话，set/get_project_agent_binding；删连接时连带清理）、
                             # 稳定项目身份（档案卡顶层 `id` 跟随文件夹；register_at 同一 id 新路径 = 移动重连
                             # 改路径不建新行；write_config_at 保证卡片带 id；list 回填旧行）、
                             # update_step_skills（步骤推荐技能读-改-原子写）、append_pipeline_steps（从模板追加：重名跳过、全跳过不落盘、
                             # 追加成功自动清 pipeline_opt_out）、set_pipeline_opt_out（「不使用研究流程」显式标记读-改-原子写）、
                             # 任务书草稿（read_task_draft/append_step_draft，
                             # .ccode/drafts/）、旧简报一次性并入草稿（list_legacy_briefs）、
                             # 任务卡 kind（idea/draft，旧卡按 step 推断）、fuse_card_into_draft（想法卡会话 ×
                             # 当前步骤草稿 → AI 融合稿，出站 redact_and_cap 不写盘）+ write_task_draft（确认后整份落盘）、
                             # update_lit_watch_filter（雷达筛选读-改-原子写，全空归一 None）、
                             # 验收接受账本（.ccode/acceptance-log.jsonl append-only，按 run_id 去重幂等；
                             #   目标页只读展示最近若干条；task_list 默认不含归档，task_unarchive 恢复）
                             # project-status.json 只是其「最近摘要」投影；目标删除不动账本与摘要）、
                             # 项目移除三档（移除注册 / purge_project_traces 清除 Mesa 痕迹保留文件夹 / delete_project_dir）；
                             # 2026-10-13 双台账：科研 .gitignore 模板直带积累台账面（reading-list/inbox/watch-seen/
                             # watch-followup/watch-explains/pending-registrations/acceptance-log×2/.ccode/watch/）；
                             # 迁移命令曾实现后按「未发布无用即删」移除（存量已手工迁完，重建序列见 pipeline.md）
  project_memory.rs          # 项目知识 .ccode/memory.md：结构化块只记人工确认（revision 比对 + active/superseded/revoked 状态机；
                             # 作废/替代条目不注入，Agent 结论不自动采纳；原文历史保留并留备份）
  pty.rs                     # PtyManager：spawn_tracked 公共拉起，agent/shell 复用；
                             #   开 PTY 用前端传入的 cols/rows（缺省 24×80），避免 resume 先窄后宽把旧帧留进滚动记录；
                             # terminal_link_target = 终端相对路径点击的终审（cwd 拼 + ~ 展开 + 存在性）；
                             # pty_report_terminal_colors = Windows 底色告知（win32-input-mode 记录逐条投递，
                             #   条间 2ms；ConPTY 双向吞 OSC 的实测结论见 conventions/terminal.md，别改回 OSC）
                             # pty_spawn / shell_spawn / pty_spawn_custom / pty_kill 是 async 命令、在后台线程干活（*_sync 是原体），
                             #   三种拉起经 SPAWN_LOCK 逐个进行（2026-10-21，conventions/terminal.md「会等待的命令不占主线程」）；
                             # 输出：发送线程 route_output → OutputSink（前端 pty_subscribe 交来的 Channel + 隐藏期 backlog，同锁）；
                             #   ≥8KB 的帧发原始字节；FlowGate 流控（pty_ack 确认，未确认超 10 万字读线程停读，5 秒失联放行）；
                             # 内置终端 shell 可选（2026-10-20，设置 terminal_shell）：shell_candidates 只列本机找得到的
                             #   （Windows PowerShell / PowerShell 7 / Git Bash / cmd；macOS zsh / bash / fish），interactive_shell 选不上回落
                             #   login_shell_argv；run 脚本不走这里（script_shell_argv）。Windows 跟随 cd：attach_cwd_tracking 给
                             #   PowerShell 包 prompt、给 Git Bash 设 PROMPT_COMMAND，把当前目录写进 <config>/ccode/pty-cwd/<uuid>.txt，
                             #   process_cwd 先读它、没有再读进程 PEB（cmd）；文件随标签退出删、启动清残留；pty_cd 按标签的 shell 方言写 cd
                             # conpty_input_pieces = Windows 输入里的 emoji 改送只按下的 win32 记录（Codex 的 crossterm 拼不了
                             #   ConPTY 的按下+抬起代理对，会整个丢字；2026-10-21，见 conventions/terminal.md）
  term_query.rs              # 终端能力查询（DA1 / XTVERSION / Kitty / modifyOtherKeys / XTGETTCAP）在 PTY 读线程当场应答，
                             #   跨块半截续扫；应答表与 terminal-protocols.ts 双端镜像（前端只剥查询不回写）；Kitty 推栈 / 弹栈不应答；
                             #   OSC 7501 探询只后端答、只对 program-status 旁路的标签答（QueryScanner::new(true)）
  program_status.rs          # OSC 7501 程序状态（2026-10-22）：探询应答串、报告解析（只认根记录，msg base64 限长去控制字符）、
                             #   跨块扫描 ReportScanner；pty.rs 读线程用，映射成旁路事件在 chat_channel::map_program_status
  pty_input.rs               # 每个终端独立的有界输入队列：一个不读 stdin 的 CLI 不得占住 PTY 全局锁；
                             #   一个请求可分段写（段间 2ms，回执等待随段数加长）
  context_breakdown.rs       # 上下文分类明细（2026-10-20）：用标签同一套启动参数在后台跑 CLI 自带的 /context（Claude Code `-p --resume --no-session-persistence`，
                             # 关 hooks；Qwen `-p --resume`），解析分类表；不调用模型、不改会话文件。只有这两家能无头跑，其余家前端只显示总量
  chat_handoff_log.rs        # 聊天层转到终端的计数（2026-10-22）：app.db chat_handoff_events（日 × agent × CLI 版本 × 原因 × 细分），
                             #   原因闭集、细分只收短标识、留 180 天；summary_for_bundle 进诊断包 chat-handoffs.json。只计数不记文字
  chat_channel.rs            # 聊天层结构化旁路（2026-10-20，docs/design-chat-structured-channels.md）：pty_spawn 起进程前
                             #   prepare 按家改参数（Claude / CodeBuddy --settings hooks、Qwen Dual Output、OpenCode --port + 口令、
                             #   Codex 私有 app-server + TUI --remote，split_codex_args 恢复时把权限参数改成服务配置），
                             #   start 起读取线程（状态日志 / 事件文件追加读、OpenCode SSE、Codex ws 客户端，手写最小 WebSocket），
                             #   Tracker = 回合状态机（幂等开始 / 结束、审批、实时文字、会话跟随），快照推 chat-channel-<tabId>；
                             #   快照另带 activity（正在跑的工具，track_activity 按开始 / 结束登记，参数 slim_input 截断脱敏）与 thinking
                             #   （Codex item/reasoning/summaryTextDelta、Qwen thinking_delta、OpenCode reasoning part）；出站 outbound 脱敏实时文字与思考；
                             #   审批 DTO 由 approval_from_tool 统一出（ExitPlanMode 另给 plan 方案原文与方案文件路径，2026-10-26）；
                             #   chat_channel_reply 经官方通道回审批；chat_channel_settle_from_transcript（Claude 被拒绝 / Esc 打断不发 Stop，
                             #   按会话文件里这一轮之后的收尾标记收回合）；close_for_pty 随 PTY 退出收旁路；e2e::e2e_channel（ignored）=
                             #   真 CLI + 假网关端到端（scripts/e2e-model-routing/README.md，三平台同一份）；
                             #   Windows 专属（terminal.md 旁路条⑦–⑪）：官方账号 hooks 写 settings.json 传路径、Claude hooks 后台跑时
                             #   Tracker::async_hooks 按身份对账（apply_async_tool）、app-server spawn_tied_to_app、收旁路先杀后删
  terminal_replay.rs         # 终端画面回放：<config>/ccode/terminal-replay/replay-<标签>.txt，
                             # 单份 256KB、出站先 redact_sensitive_text、0600；重启占位标签读回，不是会话档案；
                             # prune_terminal_replays 启动后只留当前标签集合（清崩溃残留孤儿）
  clipboard.rs               # 剪贴板图片落盘（save_clipboard_image）：<config>/ccode/tmp/paste-* 白名单扩展名 +
                             # 50MB 上限 + 每次顺带清理 7 天前残留（机制约定见 conventions/terminal.md「输入侧」）；
                             # 字节是请求体原样（tauri::ipc::Request，postMessage 退路收 JSON 数组）、扩展名在 x-image-ext 头，后台线程落盘；
                             # read_clipboard_files = 文件管理器复制文件的粘贴（mac NSPasteboard / win CF_HDROP / linux 空）
  sessions.rs                # 会话浏览：九 agent 会话扫描/解析（Codex .zst、OpenCode SQLite/JSON）、session_meta、pin 快照、
                             # 会话连接与启动模型 / 思考档记录（set_session_profile，launch_model / launch_effort 列）与接着聊默认配置
                             #   session_resume_config（模型取文件最后一轮、Codex 思考档取 rollout，读不到用启动记录，2026-10-24）、
                             # 列表标题与起名去掉 Mesa 塞的项目上下文包（strip_mesa_launch_pack）、
                             # Codex 归档 zst 懒解压（read_head_only：列表只要头窗元数据、头窗满即停，
                             #   归档 token_usage 宁缺毋滥给 None，2026-10-16）+
                             # 会话删除、注意力分类（session_tail_state）、步骤名映射（RX3a）、
                             # Claude 接续链（merge_claude_chains，2026-10-21）：id 取文件名，直线接续并成链尾一条、
                             #   真分叉单列 forked_from；被并掉的成员进 ScanResult.hidden_members 供用量逐文件算、
                             # Claude 斜杠命令 / ! 命令及本地输出拆成 command / command_output 块（claude_command_block，
                             #   剥 ANSI；本地输出行在尾态里算 settled，2026-10-17）、
                             # codex rollout 元信息 model_provider 记进 SessionMetaDto.provider（恢复按它挑兼容 profile，
                             #   前端 pickResumeProfile 单一出处：ccode 或 ccode-<短id> 前缀按网关挑绑定）、
                             # sessions_for_card（融合进任务书的按卡取会话：与列表同一归属口径）；
                             # 标签认领会话（register_session_claim / claim_session_for）；claim_session_successor：没有旁路报换会话的家
                             #   （Gemini / Kimi / Grok 默认）/clear 后另开新文件，同 agent 同目录只有这一个标签登记时改认更新、启动前没有、
                             #   没人认领过的会话（多个标签不猜），前端 linkTick 在无旁路会话时每轮问一次；
                             # Grok 回放优先读 chat_history.jsonl（parse_grok_history）：文字 + tool_calls → tool_use 块（带 call_id）+
                             #   tool_result 并进发起调用的助手消息；updates.jsonl 回落（parse_grok）只取文字；
                             # 无头 AI 按 session id 标 session_meta.internal（雷达解读/定时巡检不进本项目会话，
                             # 禁止把项目路径写入 usage_provenance.internal）
  session_search.rs          # 会话正文搜索：多关键词按「命中多少 + 落在哪」打分、同分按更新时间；正文不进前端；
                             #   索引 session_search_doc（用户/回复分列、全文不截断、脱敏后存）+ FTS5 trigram detail=column
                             #   （长词拆三元组 AND、一两字走 LIKE，候选再按原文核对）；建不完的交后台线程，结果带 pending；
                             #   单字词有更长词时不驱动候选（SEARCH_INDEX_VER 变更即整表重建）；
                             #   摘录锚点 best_anchor：整句 > 驱动词窗内种数最多 > 任一词首现；命中位置不在搜索时算，
                             #   打开结果时 locate_session_matches 现算整段对话全部命中（只认已列出的对话文件，前端
                             #   上一处/下一处按 around 重新取页）；搜索语法 parse_query（引号整句必须出现、agent/role/
                             #   after/before 及中文键，前端 session-search.ts parseSearchQuery 双端镜像，改一边必须改另一边）
  session_slim.rs            # 会话瘦身（仅 Claude Code，撞网关 413 Request body too large）：inspect 只读估算下次请求体大小与较早截图数（<8MB 免扫描，
                             #   压缩边界之前不算）；apply 原地把较早的 base64 截图/文档换文字占位、留最近 6 张，没动的行逐字节原样，写前完整备份
                             #   到 <配置目录>/ccode/backups/session-slim/、最近 60 秒有写入拒绝、复核源文件未变、tmp+rename 保持 mtime；
                             #   不另存副本（会撞 sessionId、用量重复计）；安全口径 safety.md 例外清单第 7 条；干跑用 ignored 的 real_data_dry_run
  session_transfer.rs        # 会话包导出/导入（.ccode-sessions.zip，八家不含 opencode）：原文打包装、导入时改写 cwd（含子目录前缀，
                             #   分隔符按目标机方言重接）并按 B 机目录重建落位；zip-slip/大小/后缀/白名单；同 id 跳过不覆盖（导出同会话去重；Claude id 按文件名，同 sessions.rs）；
                             #   Mesa 元数据写 app.db；Claude 附属目录 <id>/（subagents/tool-results/custom-title.json，32MB/128MB 封顶，
                             #   不跟符号链接，导入尽力而为 + tool-results 路径重映射）；各家目录名规则以 CLI 源码为准：
                             #   claude/qwen 非字母数字→- 按 UTF-16 码元、codebuddy compressWorkspacePathName、cursor workspace-paths、
                             #   kimi 新版 wd_<slug>_<sha256(斜杠化路径)[:12]> + wire.jsonl workspaceId 同步 + session_index.jsonl、
                             #   gemini 先查 projects.json 已登记 slug、grok URL 编码 cwd；cursor 续聊靠自家 store.db，导入只给提示
  skills.rs                  # 技能库（§6.13）：SSOT 库 + symlink/copy 分发（cursor/grok 固定 copy）、四路导入、ZIP 导出、卸载备份、
                             # 漂移检测 resync、create_skill/update_skill_content；provides 解析（frontmatter 闭集位声明，
                             #   compose_skill_md 重写链保留——曾在这里剥过字段）；「AI 优化另存」两阶段命令
                             #   （optimize_skills_draft 多源合成出稿不写盘 + create_user_skill 权威名落库带 derivedFrom 溯源）；
                             #   apps 表是创建时快照，
                             #   list 时现算补齐注册表新 agent 的缺键（否则一键应用永远漏新 agent，不写盘）；
                             #   contentDigest = 库目录清单哈希（与漂移检测同口径），项目上下文/执行快照按它记技能版本；内置技能种子（seed_builtin_skills：
                             # include_str! 内嵌 src-tauri/resources/skills/ 21 个技能（含 image-gen），启动幂等播种，不覆盖/不复活用户改动；
                             #   删除内置技能先落逐技能墓碑 .builtin-skill-tombstones（删除失败也不留「删了没记」），
                             #   种子版本升级补播跳过墓碑项——墓碑机制前的老删除靠 skill-backups 同名备份回填墓碑）、
                             # 内置技能更新（check_builtin_skill_updates 种子逐字节比对 + apply_builtin_skill_update
                             # 覆盖前备份 SKILL.md.bak-<yyyymmdd> 后原子写入；2026-10-16 一次性数据收口：存量库早期
                             # 以 local 进库的 14 个内置技能翻回 builtin 标签（备份 skills.json.bak-source-flip-*，
                             # 逐条验证过内容即种子血统），source 单一口径成立——归组/更新检测/更新应用/删除墓碑
                             # 全只认 source=builtin，local 同名＝用户自有豁免；quarto-render 随包 ieee.csl）、
                             # 技能接口契约（frontmatter inputs/outputs
                             # 解析进 SkillDto，list 时现算；外部技能未声明时 infer_interface_from_body 正文推断兜底、
                             #   打 interface_inferred 标不回写；前端 skill-conflicts.ts 判定产物冲突 + 跨步骤链路
                             #   （skillChainWarnings：inputs 找供给/outputs 对账预期产物）+ StepSkillsChips 警告行）；
                             # ◈ 适配到流水线（adapt_skill_to_pipeline 出稿 FN_DISTILL + build_adapt_prompt 规范路径表
                             #   单一出处 → write_skill_md 确认落盘，name 强制沿用库中条目；update_content_impl
                             #   interface=None 时保留已声明 inputs/outputs 不静默丢弃）；
                             # 技能内容红线（2026-08-20 社区对标批量升级后确立）：单文件轻量规范（~100 行内，禁脚本/JSON 中间件/lint 体系）、
                             #   产出文件名与流水线接口（TASK.md 内联口径）不动、升级后同步 cp 进技能库（种子改完库不追平，见种子更新机制）；
                             # 删除保护（2026-09-03）：来源口径 = source 字段单一出处（builtin/ccode/local/zip/github/discovered，
                             #   ccode 为 create_skill 后加，旧自建记 local 无法区分、前端 fail-safe 按非自建提示）；
                             #   删除弹层（SkillsPage DeleteSkillModal）列影响面 + 内置不复活警告 + 导入来源，
                             #   delete_impl 先备份库目录进 skill-backups（留 5 份）再卸载；纯逻辑在 src/skill-delete.ts
                             #   （tests/skill-delete.test.ts）
  mcp_blender.rs             # Blender 官方 MCP 本机安装探测（只读：Blender 版本/插件文件/uv/仓库/TCP 9876）
  mcp.rs                     # MCP 清单与分发（§6.15，规格 matrix §10）：统一模型→八家映射（grok 只读）、读-改-写一个键/段 + 备份 +
                             # 原子写 + 读回校验、JSONC 容错读、密钥引用转写（不落明文；引用值可存 mcp-keys.json，启动/体检注入）、stdio 裸命令名 resolve_binary
                             #   绝对化 + node shim 深化、相对路径命令拒写（跨 agent 必挂，报错引导改绝对路径）；
                             #   全局启用开关（enabled 字段：停用=移除各 agent 条目但保留 apps 映射，重开按原样重投；
                             #   停用期间编辑/拨开单 agent 开关只更新清单记意图，不动 agent 配置）+
                             #   连通性检测 check_mcp_server（stdio 拉起 initialize 握手 / remote POST 探活，每次尝试 8s 上限；
                             #   stdio 帧格式自适应：先发规范的 NDJSON 换行帧，server 秒退/首帧非法/超时再换
                             #   Content-Length 头帧重试一次，回包读取器两种帧都认；
                             #   env/header 的 $VAR 引用检测时先查 mcp-keys.json 再查宿主环境（scan_env_refs 整值+内嵌同口径）；
                             #   结果带 status 细分闭集 handshake/reachable/auth/not_found/error——401/403/404 判失败）；
                             #   明文密钥安全闸（审计收口 2026-09-08）：保存/粘贴导入/分发一律拒绝，只接受 $VAR 引用，
                             #   历史明文条目不删不崩但编辑/分发被拦至改成引用，移除方向不拦；
                             #   重命名受保护迁移（新名写好后移除各 agent 旧名条目）；
                             #   codex stdio env 改名引用（TARGET=${SOURCE}）明确拒写；
                             #   origin 来源标记（ccode/imported:<agent>/imported:json，空串=未知按收编对待；
                             #   收编条目删除默认仅从清单移除 keep_agent_configs，不动 agent 配置）；
                             #   外部状态同步 mcp_distribution_status 五态（off/ok/modified/missing/disabled_externally，只读、
                             #   探测失败按 ok 不报警；disabled_externally 仅 codex/grok 的 enabled 键与 codebuddy
                             #   disabledMcpServers 三家实证产出，codebuddy 分发/移除时顺带自清名单本条目）；
                             #   批量体检 check_all_mcp_servers（分波并发每波 4 个、一次性返回）+ 结果沉淀 last_check
                             #   （读-改-写只动该字段、编辑保留旧值）+ stdio 启动超时 startup_timeout_ms
                             #   （clamp 8s–30s 只被体检消费，收编 codex/grok startup_timeout_sec 带入）+
                             #   $VAR 预检 mcp_missing_env_refs（只读，前端保存/分发前非阻断警告）；
                             #   相对路径命令（./ ../ 开头）先解后拦（resolve_relative_candidates：基准序 = 条目绝对
                             #   cwd → 来源 agent 配置家目录 → 实证插件目录（仅 codex computer-use/plugins），收编/导入
                             #   命中存绝对路径 + cwd 规范化、不命中 fail-open 收进清单，分发试解失败才拒写）+
                             #   命令路径探测 mcp_command_path_status（ok/relative/missing 闭集，$VAR 引用不判）+
                             #   resolve_mcp_command_fix 一键修复候选（origin 推断来源 agent）
  internal_sessions.rs       # Mesa 内部对话保留期清理：统计 / 立即清理 / 开机后台每日一次；只删 internal + ccode-ai 临时目录或雷达隔离目录 + 未保留
                             # + 定时历史没引用（scheduler::referenced_sessions，「看过程」要用；2026-10-23），
                             # 永久删除、用量行保留；顺扫 ~/.claude/projects 下 ccode-ai 空壳目录（2026-10-17）
  usage.rs                   # 用量统计（§6.11）：usage 事件提取、usage_daily 按天聚合、任务成本归因、订阅口径、
                             # 复用提取器给接着聊取会话最后一轮的模型 last_session_model / Codex 思考档 last_codex_effort（2026-10-24）、
                             # rebuild_locked 进程互斥（DELETE→upsert 非事务，并发双跑会 ON CONFLICT 累加翻倍，
                             #   四个调用点 session_usage/rebuild_usage_index/get_usage_stats 首跑/usage_activity 全走它）；
                             # usage_activity 活跃度热力图：全历史非零日序列（day×agent×model 聚合 +
                             #   day×model 走 Bucket::cost 计价），先增量 rebuild 再查询、失败 stale=true 回落；
                             #   冷启动兜底（2026-10-15）：rebuild 超 USAGE_REBUILD_BUDGET_MS 先出旧数（refreshing=true），
                             #   后台刷完（USAGE_REBUILD_IN_FLIGHT 单飞）发 usage-activity-refreshed 前端补拉一次——
                             #   事件只在「等的人超时离开」时发，前端每周期最多自动补拉一回，三闸防事件→补拉自激环；
                             #   二期：usage_day_detail 单日明细（总量+按 agent 分解+会话列表，internal 沉底、
                             #   标题过 redact_sensitive_text，不触发 rebuild）+ usage_activity_agents
                             #   年矩阵（day×agent 四类合计，胶囊筛选用）；
                             # session_usage 单会话聚合（终端状态栏 token 段，先增量索引再按 session_id 汇总）；
                             # usage_trend / top_sessions：花费折线与最贵会话均跟随页顶范围，官方账号与 internal 不计费不进榜，
                             # 自定义标题出站前过 redact_sensitive_text；总额卡与折线/榜单同一计费范围，
                             # 官方/internal 的 token 量单列展示不计费（v3.255）；
                             # provenance v7 起按会话级登记（official 用启动 hint/恢复目标写 session_id 行，
                             #   启动时不知 id 的 agent 由重建索引按 session_meta.profile_id 解析认证方式兜底；
                             #   旧项目级行只回填 created_at 之前已存在的会话，不粘住新会话）；
                             #   session_meta.internal（无头 AI/定时巡检按会话 id 登记）纳入用量索引；
                             # 定价链 PriceChain 三层：用户 pricing.json > 公共能力库 cost > 内置表 BUILTIN_PRICING
                             #   （高层任意前缀命中即胜、同层最长前缀优先——用户写短前缀即覆盖低层细分代；
                             #   内置表口径 2026-08-31 各官方页，跨代改价给新代加更长前缀、旧价留给老会话归属）
  subscription_quota.rs      # 订阅余量查询（用量页「订阅余量」卡，多供应商一张卡可切换，2026-09-19）：
                             #   智谱 / Kimi For Coding / MiniMax 三家（火山方舟未接——控制面 OpenAPI 需 IAM AK/SK
                             #   签名，与网关单密钥模型不符，待网关加 AK/SK 字段后单批做）。
                             #   智谱额度 GET /api/monitor/usage/quota/limit（limits[] type∈TOKENS_LIMIT|CREDIT_LIMIT、
                             #   unit 3=5h/6=周锚定禁按重置时间排序、percentage=已用；cc-switch/CodingPlanQuota 口径）+
                             #   重置卡 GET|POST /api/biz/customer-package-reset/{list,use}（OmniRoute 口径：信封
                             #   success+code∈{0,200} fail-closed、双桶截断不当 0 张、code 1001=密钥失效、
                             #   卡条目多别名 + status consumed/redeemed/… 不可用 + 无时区时间戳分区域：bigmodel.cn 北京时间 +8（用户官网比对实测修正）、z.ai UTC；
                             #   DTO 暴露每类最早过期时间（临期提示 + use 优先消费最早过期的卡））；
                             #   Kimi GET api.kimi.com/coding/v1/usages（limits[] 多模型 5h 窗取 utilization 最紧、
                             #   usage=周窗、used=limit-remaining）；MiniMax GET /v1/api/openplatform/coding_plan/remains
                             #   （general 条目、字段是剩余百分比要反转、周桶仅 current_weekly_status==1）；
                             #   窗口 DTO 除 used_percent/resets_at 外另有 used/total 绝对值（2026-09-21）：
                             #   智谱 limits[].currentValue/usage 就是已用/总量积分（实测周窗 140023/140000 超发
                             #   如实透传不在解析层钳），Kimi limit/remaining 是配额点数，MiniMax 只回百分比 → None；
                             #   **只有字段真的给了才带**（缺 limit 不拿兜底 1.0 当总量），前端两个都有值才显示；
                             #   parse_zhipu_quota 用 PlanWindow 直接装中间态——它自带 window 字段，
                             #   归周窗时**必须改窗名**（旧版是 push 时才贴标签，漏改会让两根条都写「5 小时」）；
                             #   智谱 5h 窗实测不回 nextResetTime → 认 None 不编时间；
                             #   重置卡仅智谱支持（DTO reset_cards_supported，其余家不渲染该行）；
                             #   团队版 = 网关 headerEnv 带 bigmodel-organization/project 隐式识别（?type=2 + 两头）；
                             #   Bearer 鉴权（裸 key 亦通，智谱两者都认）；密钥只在 Rust 层出 keys.json 绝不进 DTO；
                             #   用卡（plan_use_reset_card）是消费性写操作——显式命令 + 前端确认弹窗，成功作废缓存；
                             #   2 分钟进程内缓存（对齐用量页可见期自动轮询，页面不可见即停）+ 瞬时失败回落上次成功值
                             #   标 fromCache；无后台轮询；不注出网代理；
                             #   复用 reqwest Client（连接池，勿退回每请求新建 Client = 每次重新握手）；
                             #   plan_quota_overview 多网关并发（spawn 全部再按序收），等待 ≈ 最慢一家不是相加
  gateway_balance.rs         # 网关余额查询（用量页「网关余额」卡，与订阅余量并列，2026-09-20）：
                             #   New API 兼容预付钱包，出卡零配置（槽 URL 主机命中 zetatechs.com 即出；加站点 = WALLET_HOSTS 加一条）；
                             #   公开 GET {origin}/api/status 取 quota_display_type / quota_per_unit；
                             #   钱包优先：keys.json `{id}#wallet` 系统访问令牌（cc-switch PAT，不是推理 sk-）打
                             #   GET {origin}/api/user/self，带 New-Api-User 等兼容头（all-api-hub 口径）；
                             #   无令牌再试推理密钥（多数站 401 不当成密钥失效）→ /api/usage/token/ → billing；
                             #   source=wallet|token；不限额度且无钱包数字时改口去网关库填令牌；
                             #   DTO 带 account（/api/user/self 的 display_name→username，**绝不取 email**）与
                             #   token_name（/api/usage/token 的 name）：account 是前端「同站合并成一张卡」的分组键，
                             #   同站两个账户必须分成两张卡，拆掉它就会把两个账户的余额混一张；
                             #   「去钱包」={origin}/wallet；密钥只出 keys.json 不进 DTO；2 分钟缓存 + 瞬时失败回落；
                             #   不注出网代理；不做 usage script / 探测全部网关
                             #   **等待结构（2026-09-21 用户实测「刷新很慢、不如智谱那个快」后重做，勿退回）**：
                             #   多网关并发 spawn 再按序收（三网关顺序 ≈2.1s → 并发 ≈0.66s，本机实测中位）；
                             #   /api/status 按 origin 进程缓存 10 分钟（同源多网关只打一次，失败回落旧值再回落内置默认）；
                             #   「密钥额度」端点写尾斜杠 /api/usage/token/——不带斜杠该站 301，跟一跳白多一个 RTT；
                             #   改等待结构前先量单请求 TTFB（本机 status ≈1.0–1.5s / self ≈0.8s / token ≈0.7–2.0s），
                             #   慢的是串行 × 网关数，不是某一路慢
  pricing.rs                 # pricing.json 读写与校验（定价链最高层，原子写）
  cli_permission.rs          # 各家 CLI 本机默认权限的只读探查（cli_default_permission：Claude permissions.defaultMode、Codex approval_policy/sandbox_mode → 白话一句），返回 {tier, short, detail}（tier = 对应权限菜单哪一档；Codex 因 Mesa 强制 workspace-write 只看 approval_policy），聊天权限菜单标「本机设置」用；不改任何 CLI 设置
  app_icon.rs                # 设置 → 外观「应用图标」：跟随系统 / 深色 / 浅色，只换运行中的程序坞（NSApp）、主窗与托盘图标；图像由 scripts/gen-icons.mjs 生成在 icons/runtime/，打包图标不归这里管
  about.rs                   # 「关于」分区后端：read_third_party_notices（include_str! 嵌随包许可清单）+ build_info（平台/架构/渠道）；清单由 scripts/gen-third-party-notices.mjs 生成，改依赖后必须 npm run gen:notices 再提交
  feedback.rs                # 反馈通道后端：FEEDBACK_ENDPOINT 常量（None=mailto 回落，公司端点上线改这一行）+ submit_feedback（POST JSON，15s 超时，表单+环境行+截图 Base64）+ save_feedback_images（邮件通道截图落盘 Downloads/ccode-exports/mesa-feedback-<时间>/）+ 邮箱直发（send_feedback_smtp：lettre+rustls，截图与诊断包真实附件；授权码经 profiles::set_shared_key 存 keys.json 键 feedback-smtp，0600 持锁；配置存 settings feedbackSmtp）。诊断包附件只收路径、后端经 checked_diagnostics_path 白名单（导出目录 + ccode-diagnostics-*.zip + 非链接 + ≤20MB）自读。端点启用前需验证 8MB 级 JSON 的 IPC 与超时
  settings.rs                # 应用设置（settings.json）：字体/scrollback/渲染器（terminal_renderer：auto/dom/webgl，Mac 默认清晰、Windows 默认流畅，读时闭集过滤）/汇率/镜像/主题/OS 通知/精确注意力
                             # （hooks_attention 按 agent map，旧 claude_hooks_attention 仅反序列化兼容迁移）
                             # /会话自动命名开关（auto_title_sessions 默认开，关 = ai.rs 起名/补名命令全停；
                             #   闸门读 auto_title_sessions_enabled）
                             # /底部状态栏统一开关（status_bar 默认开，终端/聊天两层同进退；关 = 都不渲染，
                             #   切层不改终端行列数，invisible 占位机制退役；旧 status_bar_in_chat=false 读时迁移为关）；
                             # terminal_color_report 默认开（Windows：ConPTY 吞掉 OSC 底色查询，浅色主题下
                             # 主动把前景/底色推给 gemini/qwen；白名单外的 agent 推了会变输入框乱码，
                             # 见 docs/conventions/terminal.md）；
                             # hidden_profiles = 软停用（自动路径跳过、手动可用；v3.142 起不再是纯展示偏好）；
                             # active_global_profiles = 「设为全局」追踪（agent→profile id，record/clear_active_global
                             # 维护、不走 patch、clear_profile_refs 同步清引用；只代表「上次由 Mesa 写入」非绝对生效态）；
                             # outbound_proxy = 出网代理（注入官方账号启动与组头登录；2026-09-19 起下载侧同源注入——
                             #   agent 安装/更新、依赖安装、字体下载走 download_proxy_env（大小写成对，curl 只认小写 http_proxy），
                             #   更新检查的 npm view/brew info 同注；国内镜像主机（TUNA/南大 ghcr）并入 NO_PROXY 直连不绕代理；
                             #   用户环境已带任一代理变量时不覆盖。网关启动仍不走；extra_env 同名键覆盖；校验 http(s)/socks5，空串清除）
  hooks.rs                   # 精确注意力标记（七家 hooks 桥接）：BRIDGE_SPECS 每 agent 一张桥接规格（claude/qwen/
                             # codebuddy/gemini/kimi/grok/codex；cursor 无「等待确认」等价事件、opencode 无 shell hooks
                             #   形态，两家未接入），写各家 hooks 配置（备份留 10 份 + 原子写 + marker 合并/移除 +
                             #   损坏拒写；grok 整文件归 Mesa、外来文件拒覆盖），机制调研录 matrix §12；
                             # 事件日志解析双信封（snake_case/camelCase）+ 事件名去下划线小写归一 + grok Stop 只认
                             #   reason=end_turn + 会话归属双键匹配（session_id==文件主名 或 transcript_path==完整路径），
                             #   10 分钟 TTL 回落尾部推断不变；Stop / AfterAgent 判 settled（确定收尾，同会话文件
                             #   turn_duration / task_complete）；settings 字段 hooks_attention: map<agent,bool>
                             #   （旧 claude_hooks_attention 仅保留反序列化兼容迁移）；
                             #   session_confirm_detail（2026-08-24）：confirm 时从 payload 提取「在等什么」摘要
                             #   （message/tool_name/title 尽力而为），聊天层审批卡片用；
                             # 2026-10-20：hook 命令整行一次写入、记 CCODE_TAB_ID（日志第二段，旧格式照读）、payload 截 64KB
                             # 2026-10-20 二：Windows 上每次启动注入的两家（Claude / CodeBuddy）有原生 hook 程序就用它——
                             #   native_hook_exe 找随包的 mesa_helper（hook 模式，开发态在 target/debug/deps/），试跑 --probe 确认；
                             #   找到就同步跑（launch_hooks_async 返回 false），找不到照旧 PowerShell 脚本 + 后台；写全局配置的三家
                             #   用 global_hook_command：helper 拷成 hooks-state/ccode-hook.exe、路径不加引号（三种宿主都认），不行退回 .ps1
                             #   （PostToolUse 2KB，截断按字段名兜底）；launch_hooks_value = Claude / CodeBuddy 每次启动注入的 hooks；
                             #   launch_injected 五家设置页不给开关、precise_enabled 门控；migrate_launch_injected 启动收回以前写的全局条目；
                             #   launch_hooks_async（只 Windows 的 Claude Code：hooks 带 async + 另挂 PermissionRequest）；
                             #   Windows 共用脚本 ccode-hook.ps1 只删回车换行、写日志撞车重试，正文改了启动时替换；
                             #   状态日志 / 备份目录走 storage::config_root（测试可重定向）；
                             #   real_data_dry_run_migrate（ignored）= 对真实配置的拷贝干跑
  inst_access.rs             # 机构访问通道（2026-09-16）：人登录一次、系统复用会话——登录窗（Tauri WebviewWindow
                             #   label=inst-login）Cookie 落 0600 inst-session.json（值绝不出站，状态 DTO 只有
                             #   域名/条数/时间）；EZproxy/OpenAthens 前缀 ?url= 改写（settings institutional_prefix，
                             #   书签式前缀自动剥尾部 url=）；DOI→合法开放副本查证（Unpaywall best_oa_location
                             #   .url_for_pdf 优先、OpenAlex 回落）；落地页 citation_pdf_url meta + 常见 PDF 链接
                             #   形态提取；fetch_via_session 手动逐跳跟重定向（每跳按 host 重算 Cookie 头）。
                             #   硬边界：不存机构账号密码/不做无人值守自动登录；scheduler/无头不携带会话；
                             #   只由人 UI 逐篇触发（lit_watch::fetch_paper_fulltext 阶梯调用），不做批量。
                             #   登录窗轮询走独立线程（Windows cookie API 在主线程同步调用会死锁）。
                             #   窗内 PDF 落盘走**单一下载漏斗**（2026-09-16 终局，勿再加拦截层/页→本机回传）：
                             #   builder 注册 on_download（Requested 把落点改写 <config>/ccode/tmp/inst-dl/、
                             #   Finished 按 url→落点 map 对账读文件 → %PDF- 魔数校验 → 多槽暂存（唯一文件名，
                             #   inst-pdf-relayed → App 层 inst_save_relayed_pdf 落 papers/）；页侧 LOGIN_INIT_SCRIPT
                             #   常驻 ⤓ 胶囊（2s 周期重检直链）+ __mesaGrab（a[download] 按钮 → 合成
                             #   a[download] 走 WKDownload → fetch 魔数校验）；点 /doi/pdf/ 拦住改保存
                             #   （WKWebView 内联 PDF 无保存入口）；/doi/epdf/ 放行（Wiley/ACS 阅读页）；
                             #   直链存成网页则改开阅读页。on_navigation 拦 pdfish 后 Rust 用窗口会话直拉（绕过
                             #   页内 CORS，MDPI 的 mdpi-res.com 等 CDN），失败再回落页侧 grab；about:blank
                             #   document-start 刷浅底防开窗黑屏。wry：download 属性走下载委托、application/pdf
                             #   主框架导航被内联渲染——结论记 pipeline.md「机构访问通道」。
                             #   ScienceDirect（2026-09-16 晚）：不放 citation_pdf_url、PDF 链接是 PII 路径不含
                             #   DOI（通用探测两条路全落空）、View PDF 是 JS 弹层按钮——mesaSdPdfUrl 三级
                             #   （#pdfLink href → 内嵌 JSON pdfDownload.urlMetadata token 直链 → 按 PII 构造
                             #   /pdfft?download=true）；**SD 终局（三形态实测 + wry 源码）**：下载式请求
                             #   （a[download]/WKDownload action）被回 HTML、普通导航被 wry 内联渲染白屏
                             #   （wry navigation_policy_response 只看 canShowMIMEType、无视 Content-Disposition）、
                             #   blob 下载 Finished 挂起——唯一通道 = 页内 fetch 取字节 + mesaChunkRelay
                             #   分片回传（块长 61440=3 的倍数——65536 时非末块 btoa 自带 == 填充、拼接
                             #   解码必挂；先 mesa-chunk://b/{total} begin 握手、Rust 只收握手后 60s 内
                             #   块数吻合的分片，逐块解码；mesa-chunk://c/{seq}/{total}/{b64} 合成锚点导航，
                             #   Rust on_navigation 收片取消导航，不受 CSP/混合内容限制；收齐解码校验走既有
                             #   inst-pdf-relayed 入库链；Zotero Connector 页内取字节带外送回的 webview 等价物）；
                             #   胶囊创建即上文案（空胶囊=黑圈）；View PDF 命中后 closest('a[href]') 沿祖先找
                             #   href、未检出直链 1.5s 宽限重测。SD 交互终态（用户拍板「进 View PDF 再下载」）：
                             #   SD 页面不拦 View PDF（mesaIsSdPage）、grab 不点站方下载控件——让站方阅读器
                             #   打开，mesaPdfUrl 内嵌扫描（iframe/object/embed）取 PDF 地址走分片回传。
                             #   页侧通用分型层（同日深夜，按清单出版商收口，只加失败救援不动已通路）：
                             #   mesaVerifiedGrab 验证式抓取（同源 pdfish 先 fetch 验明正身，验明后对真实 URL
                             #   合成 a[download] 走 WKDownload——**禁 blob→a[download] 落盘**：macOS 上
                             #   Requested 后 Finished 挂死（20:33 实测），__mesaDownloading 有 90s 看门狗；
                             #   HTML 中间页由 mesaIntermediaryNext 解析 meta refresh/redirect-message/
                             #   iframe·embed·object 内嵌 pdfish 再取，≤3 跳；Wiley/ACS 型 /doi/pdf/ 经
                             #   mesaViewerUrl 非空跳过）；mesaPdfUrl 第二遍单链采用（RSC articlepdf 只带
                             #   DOI 后缀/IEEE arnumber 不含 DOI 前缀——文章页全页唯一 PDF 链才用）；
                             #   Rust got-html 回救 __mesaGrabVerified（拿到网页时页侧解析重试，Wiley 型仍走 epdf）。
                             #   出版商分型纪律（用户指令，勿顾此失彼）：每家期刊 PDF 供给形态不同（已实证
                             #   通用meta/DOI内链/Wiley-epdf/MDPI-CDN直拉/编号链(RSC·IEEE)/中间页(SD·IEEE)/
                             #   SD复合/签名直链八型），为一家修问题只动该家命中的最窄分支、禁改通用路径，
                             #   收尾逐一回归各型——细则见 pipeline.md「机构访问通道」⑦。
                             #   收货通道 A/B/C（同日深夜用户定稿「让真实浏览器干浏览器的事」，Mesa 只收货）：
                             #   A download_inbox.rs 监听系统下载目录 + Chrome/Edge/Firefox 自定义默认下载目录收 PDF，另读 Chromium 系 History 库的下载记录补「另存到别处」（只在有登记时、副本只读即删，见 safety.md）（inst_browser_open 调起系统浏览器
                             #   + 登记归属，六层过滤链收货进既有入库链——高置信命中收完进回收站、
                             #   兜底关联（文件名没对上号）原件留在下载夹并弹 inst-pdf-attention 横幅；
                             #   终端只印启动/失败/收货结果，不去重跳过刷屏——macOS 一次落盘连发多条
                             #   FSEvent）；B 浏览器会话复用
                             #   （设置页「学校图书馆」主路径「登录学校账号」，内嵌窗留回落）；C extension/（MV3，ID 固定
                             #   dmjplopfhbdamkihimfllomdmkfainnn）+ bin/mesa_helper.rs（native messaging，读 helper-context.json
                             #   当前项目+打开篇标题/DOI 调 ccode_lib::helper_ingest；PDF 阅读器空标题不得落 paper-5.pdf；
                             #   工具栏图标优先走页内「存到 Mesa」，chrome.downloads 只作无 content script 末路；
                             #   2026-10-20 起另有 `hook <日志> <截断字节>` 模式：Windows 上给 CLI hooks 写状态日志，只用标准库，见 hooks.rs；
                             #   2026-10-23 起另有 `image …` 出图模式：调 ccode_lib::helper_image，唯一会读 keys.json 的模式，见 image_gen.rs）
                             #   + browser_bridge.rs（装 NativeMessagingHosts
                             #   清单）。内嵌窗漏斗保留为过渡，通道 C 稳定后退役——细则见 pipeline.md ⑧
  fonts.rs                   # 终端字体打包与 brew 一键安装（Maple/Sarasa/Iosevka）
  ai.rs                      # 无头 AI 调用层（一次性调用对 claude/codex 不落盘 + JSON 记账：headless_oneshot_args / parse_oneshot_output）：一次性 prompt + 提交信息/摘要/PR 描述/冲突建议/提炼接力简报/评审沉淀起草（只写下一步还没有的约束，无新约束返回空）；
                             # 会话自动起名：先判手改/临时标题再读对话；材料指纹 title_basis 没变不问 AI；步骤 / 工作区会话附背景
                             #   （title_background：项目名、步骤名、TASK.md 标题与课题主题）；去重参照 pick_reference_titles（相近优先、最近补满）；
                             # resolve_profile_from 最近使用回落跳过官方账号（OAuth 过期会甩 CLI 日志；显式/专用仍尊重）；
                             # 失败走 summarize_headless_error，不把 stderr 整段回给前端；401 invalid_api_key 按
                             #   「报错 URL host × 绑定 base_url host」细分：发去 api.openai.com 而配置是网关 = 渠道路由错
                             #   （引导重设全局默认），网关自己拒 = 密钥错（引导重填），该判定必须先于 401+unauthorized
                             #   归官方账号失效的笼统分支；
                             # headless_task_args/run_agent_task 供 scheduler 复用（定时任务要写项目文件，codex 用 -s workspace-write）；
                             #   run_agent_task 收尾时把会话 id（锁定的 --session-id 或输出里抠到的）记到 Run 上（定时历史「看过程」用）；
                             # 会话自动命名（ai_auto_title_session early/final + ai_retitle_all_sessions 补名去重）：
                             #   settings::auto_title_sessions_enabled 关 = 两命令入口直接跳过（最终闸门在此，前端跳过只为省白跑），
                             #   补名批循环逐轮复查闸门（中途关掉即停）；retitle impl 闸门收进参数是关停语义的单测锚点
  scheduler.rs               # 定时雷达（v3.75；v3.79 起技能可选；v3.218 新建巡检技能：草稿 .ccode/drafts/watch-*，确认才入库分发）：
                             # 2026-10-20：Windows 上 Codex 用非提权沙箱时任务说明追加「读写文件用绝对路径」（codex_win_unelevated_note）；
                             #   沙箱覆盖参数本身由 ai.rs codex_win_sandbox_for_run 加（用户确认过、自己没配才加），判定在 agent_specs.rs
                             # schedules.json（每日/每周+时分，本地时区）、60s tick + 启动补跑
                             # （漏跑 coalesce 只补一次）、执行模型 2026-10-16 起跨项目并行（due 各自 spawn；同项目 project_lock 互斥防并行写坏追加台账，tick 在跑 ≤2 防启动尖峰；手动立即跑不占额度但受同项目互斥；拉起发 scheduler-run-started、ScheduleDto.queued 支撑「排队中」；锁序恒 任务锁→项目锁、sched_lock 恒叶子）、
                             # 无头拉起 agent 在任务隔离 worktree 跑技能（每轮先从主仓播种：收件箱/跟进/引文与只读种子 included.*/reading-list 镜像、watch-seen 取并集——seed_watch_isolation，2026-10-17 取代「没有才拷」；项目根只用于归属与采纳；非 Git 项目明确失败；显式 sentinel 才允许主仓写入；人点「采纳进项目」才把本轮新增并进主仓——watch_review::adopt_at 按条目追加、watch_path_denied 硬排除流程正典、lit_watch::adopt_watch_pdfs 只拷本轮新下未排除的 PDF；未钉连接按项目默认取连接（pick_project_default）；2026-10-13 起：已采纳记录明确拒绝重采纳（find_run_record）、run_marked_adopted 是 decide 的后端闸门；历史行可删（schedule_run_delete：账行/事件/历史行/冻结证据），删任务/移项目必级联（purge_schedule_side_effects，worktree 走回收站）；默认 lit-watch，prompt 按技能分派（lit-watch 文案明锁不写 included/index/references.bib）：
                             # lit-watch 专用文案不动、其他技能通用模板，非 lit-watch 跑前检查已分发，30 分钟超时（2026-10-03 由 600s 提高））、
                             # 历史留 20 条、跑完发 scheduler-run-done 事件（App.tsx 全局监听弹 OS 通知，复用长任务通知开关）；
                             # RunRecord.newEntries 新命中计数；2026-09-29 起界面不再写关联步骤，保存时清掉旧 linkedStep
                             # （跑 lit-watch 前后数 inbox.md `## ` 标题数取差，超时/失败不记；项目配了雷达筛选时
                             # 前后各数一次过滤后条目取差，推送/收件箱胶囊只算符合筛选的）
                             # 2026-10-23 运行管理（细则 pipeline.md「定时雷达 · 运行管理」）：Cadence/latest_slot/next_slot 五种周期；
                             # last_slot_at + apply_skip 跳过记账（同因合并、同刻幂等）；classify_trigger 准点/补跑（应用没开、电脑睡过）+
                             # missed_before 只数 7 天；run_context_prompt 把原定时刻/上次成功/附言写进任务说明；RunRecord 记 agent+session_id
                             # （referenced_sessions 给内部对话清理豁免）、noop、trigger、note；gate_reason 积压闸门（只认带 trigger 的新记录）；
                             # apply_run_record 定时触发连续 3 次失败 / 钉的连接被删 → 自动暂停，reenable 清原因并把已处理拨到当前；
                             # AwakeGuard 运行期间防空闲睡眠（macOS caffeinate -w / Windows SetThreadExecutionState）；
                             # 跨轮记忆 .ccode/watch/<id>/memory.md（seed_memory 新者为准、adopt_memory 采纳带回、schedule_memory_read/write）；
                             # run_schedule_now(note)；每任务 timeout_minutes；草稿 .schedule.json 周期建议（read_schedule_suggestion 闭集校验，
                             # commit_watch_skill_draft 收人确认的周期）
  lit_watch.rs               # 文献雷达应用层（v3.95）：巡检产物解析 DTO（notes/inbox.md 有效文献块含 watch-run 批次标记日期、上限 500 条；
                             # 漏写批次时 stamp_undated_inbox 只插入标记行：冻结前按本次完成日、打开雷达时按最近已采纳成功巡检；
                             # repair_watch_batch_dates 供空态「按巡检日补记」，已有任一条带日期则不写；
                             # papers/watch-followup.md 付费墙待办、watchlist.md 订阅读写整表写回保留注释行（整表写只来自弹层「保存」；「编辑源文件」前走 ensure_watch_subscriptions_file，存在不动）、included.md 精读清单
                             # 增删去重）+ download_paper_pdf 白名单下载（仅 http/https、60MB 流式上限、%PDF- 魔数校验、
                             # adopt_watch_pdfs：采纳时把隔离树 papers/ 里主仓没有的 %PDF- 拷进项目根并登记，同名不覆盖；
                             # drop_inbox_entries：采纳过滤用，按行范围整段删被排除条目并清悬空批次标记；
                             # 落 papers/ 自动登记 project.toml 资源）+ attach_paper_pdf 关联本地 PDF（付费墙手动下载后
                             # 一步复制进 papers/ 并登记，源文件同口径校验、复制非移动）；门槛 = 注册项目根 + canonicalize + 读-改-原子写；
                             # 雷达筛选判定 metrics_pass_filter / count_inbox_entries_matching（scheduler 推送计数用，
                             # 口径见 conventions/pipeline.md「雷达筛选」）；
                             # 快筛解读落 `.ccode/watch-explains.json`（规范化标题去重，list 出口挂 WatchEntryDto.explain，
                             # 不写 inbox.md）；2026-10-13 双台账：papers/reading-list.md 积累账（list/add/remove_reading_list_entry，
                             # 行格式与 included.md 同构、去重域=两账并集）+ freeze_reading_list_intake 开工冻结为工作区
                             # .ccode/handoff-lit-intake.md（best-effort、agent 读定格副本不回写活文件）+ PDF 资源登记相位感知
                             # （register_pdf 遇 active/creating 工作区不写 project.toml，改记 .ccode/pending-registrations.json
                             # 按 path 覆盖去重；replay_pending_registrations 在项目打开/工作区归档时回放登记）
  journal_metrics.rs         # 期刊指标表（雷达徽章数据源）：config_dir/ccode/journal-metrics/ 下 JCR2025-UTF8.csv +
                             # FQBJCR2025-UTF8.csv（来源 github.com/hitfyd/ShowJCR，用户本机下载、禁内置分发）合并成
                             # HashMap（normalize_title 规范化精确匹配，miss 时剥末尾出版商括号尾巴（「(Wiley)」「（ACS）」可多级）
                             # 重试，仍 miss = None 不虚构；前端 lit-watch.ts sourceDisplayName 同口径剥尾，两处同步），RwLock 进程内缓存；
                             # list_watch_entries 出口 enrichment 进 WatchEntryDto.metrics（展示时现算不落 inbox.md，
                             # 旧条目装表即生效）；lookup_journal_metrics 给检索清单按刊名优先、ISSN 兜底批量现查（不写项目文件）；
                             # download_journal_metrics（jsDelivr→raw 回落、.tmp 原子落盘、完清缓存）+
                             # journal_metrics_status（含 downloadedAt：两份 CSV 取较新 mtime）+ check_journal_metrics_update
                             # （GitHub commits API 按数据目录查最近 commit，与本地 mtime 比对出 hasUpdate，前端静默失败）
  research_quality.rs        # 科研复现运行记录与验收决定：独立输出 ~/ccode/reproductions/；验收写 .ccode/research-acceptance.json，不替代 Git 合并
  （技能脚本）lit-search/scripts/lit_records.py  # 题录固定脚本：enrich（Crossref 为准 + OpenAlex 关键词 + ISO 4，接口缓存在系统临时目录）/
                             #   fetch（开放获取只取正式版或已录用稿，预印本服务器按来源级别）/ write（included.md、to-fetch.md、两份 RIS 只从 json 出）/
                             #   check / bib（精读步从 json 写 references.bib，不另查）。依赖同目录 bridge.py（endnote-bridge 那一份）与
                             #   journal-abbreviations.csv；skills.rs BUILTIN_SUPPORT 给 lit-search 与 lit-notes 各放一份
  endnote.rs                 # EndNote 出库：references.bib 经 endnote-bridge/scripts/bridge.py 生成
                             # library_match.py：定稿域稿只读本机 .enl / zotero.sqlite，DOI 唯一才写入记录号或条目地址
                             # papers/endnote-import.xml、.ris、.enw。RIS 作者一人一行，期刊/缩写/卷/期/页/日期/ISSN/摘要/关键词
                             # 随 bib 字段写入；没有的不编造。按钮「同步到 EndNote」把 RIS 放到下载并 open -a 交给 EndNote。
                             # endnote_library_choices：「选这个 EndNote 库」的候选（Windows 读 EndNote 最近打开的库登记、macOS 问 Spotlight 家目录里的 .enl（打开过的按上次打开排前）+ 文稿/桌面顶层 .enl），只列不挑
  research_tools.rs          # 科研外部工具开工 preflight（research_tool_preflight）：Zotero 本地只读接口（只管 AI 现查库，导入与「同步到 Zotero」不走它）/ Origin 平台门槛
                             #   （只做 Windows 实机，非 Windows 必需技能=阻塞）/ Blender 探测 / EndNote 桥 /
                             #   Quarto 能否真跑（quarto-render 步骤预报，不阻塞，dep_check::probe_quarto）；
                             #   只探测，不安装、不写个人库、不启动 GUI
  reader.rs                  # 沉浸阅读区后端（v3.96）：ensure_paper_note 建档 notes/<slug>.md（精读八小节对齐 lit-notes 技能口径 + 机管「译段」「我的想法」两节（「标注」首次高亮时建），已存在不覆盖；
                             # 建档前先扫 notes/ 头部「来源行」配对已有精读笔记，命中即复用不另建，空模板 slug 笔记顺带清回收站
                             # （锚点相对/绝对都认：agent 实测几乎全写成项目根绝对路径，配对统一解析成 canonical 再比，2026-09-20）；
                             # pdf_for_note 笔记→配对 PDF（来源行锚点优先；无锚点回落笔记 stem ×「type=paper 资源 + papers/ 顶层 PDF」
                             # 做 normalize_title 互相包含（2026-09-20 起 papers/ 直扫：agent 直下全文没走登记通道也能配），多命中取最长，无命中返回 None；lit_watch.rs normalize_title 提 pub(crate) 复用）+
                             # reader_for_note 归属反查版（注册项目根直含 / 工作区 worktree 映射主仓副本，未合并明确报错）+
                             # spot_check_item 抽查核对档一篇（2026-10-23：笔记限 base/notes，base 为本项目工作区即只读——不映射主仓；
                             # PDF 项目根配对优先、再看 included.json pdf 字段；题名/摘要取 included.json，「待补」「待核」不算）+
                             # read_image_bytes 图片通道（png/jpg/jpeg/gif/webp/svg、20MB，白名单判定复用 pdf.rs 内核）+
                             # read_audio_bytes 聊天层音频通道（mp3/wav/m4a/aac/aiff/flac/ogg、20MB、文件头校验，同一套白名单）+
                             # save_reader_capture 圈选截图落 notes/assets/（PNG 魔数 + 同秒重名 -2/-3；写入内核 write_notes_asset
                             #   与 phone_drop 共用）/ append_note_image
                             # （追加进「我的想法」小节）+ 生词本 notes/glossary.md（list/append 术语小写去重/remove）+
                             # append_note_translation（「译段」小节）+ append/remove_note_annotation（「标注」小节：一行一条高亮/批注，
                             # 建在「译段」前、同处再标只更新批注、删空连标题删；格式与 src/reader-note.ts 双端镜像）+
                             # reader_paper_title（paper_title_for：配对笔记 H1→index.json→included.json→included.md/reading-list→雷达收件箱，
                             # 截断文件名按 ≥24 字前缀认；新建档笔记标题同口径）；门槛 = gated_root 注册项目根 + canonicalize + 原子写
  citation.rs                # 引用健康检查：.md 引用键（[@key]/多键/[-@key]）对照 references.bib（白名单同 pdf.rs 口径）；
                             # cite_lookup：聊天引用胶囊按键取作者姓 / 年份 / 题名（会话目录往上到白名单根找 bib，只读，8MB 上限）
  handoff.rs                 # 接力（§11.3 机制四）：简报生成（脱敏+64KB）、提炼接力（build_session_digest AI 蒸馏全会话 +
                             # finalize_digest_brief 初稿写回）、handoff_links 接力链登记/固化；
                             # build_handoff_brief 的 until_text = 聊天层「从这里分叉」，按正文截到那条助手回复（cut_messages_at，认不出报错不给全文）
  runs.rs                    # 一次干活身份（app.db runs 表）：交互 pty_spawn 必有 id，无头 internal；
                             # 关标签不删行；收件箱 action.run 可恢复；登录标签不建行；
                             # Run 可以没有 Goal（2026-09-09，§4.7）：scratch/reader/办公文件闲聊
                             # task_id 落 NULL，不再 ensure_task_at 强制登记；自动登记只留
                             # pipeline_step/coding_lane/watch（run_needs_task）；
                             # 普通目标开工写评审基线（写失败即开工失败）、收尾触发冻结、
                             # 预览/采纳绑定冻结快照（失败清理只删本次新建目录 cleanup_failed_prepare）
                             # 新建/编辑目标共用 normalize_goal_scope / normalize_goal_launch；task_update 只改未跑过的 pending 目标
  runs/goal_storage.rs       # 普通目标副本的显式清理：归档、项目成果与接受账本不在删除范围（两步各需确认）
  task_review.rs             # 普通目标评审证据（规格 conventions/review-freeze.md）：开工基线哈希、
                             # 收尾冻结 payload 副本（拒绝改写）、采纳三向判定（项目现读 vs 基线 vs 冻结内容，
                             # 删除永不写回、>64MB 不自动采纳）；纯文件事实不碰数据库，编排在 runs.rs
  review_contract.rs         # 评审契约纯逻辑（本文件禁 git/文件拷贝/merge）：四条写回链 kind 常量（goal_adopt/
                             # pipeline_merge/coding_merge/watch_adopt）、seq/SHA 断言、apply_lock 项目锁、
                             # pending 恢复单（write/read/clear + recover_fact 补账只重放原事实不编造）、
                             # result_readiness 派生可审；2026-10-13 起承载合并闸门台账豁免 is_untracked_ledger_file
                             # （reading-list/watch-explains/pending-registrations 只豁免 ??；notes/*.md（index.json 除外）、
                             # notes/assets/（沉浸阅读截图，2026-10-17）、inbox/watch-seen/watch-followup/acceptance-log×2 双态全豁免）——workspaces 合并闸门与
                             # 开工脏文件点名、coding 改动计数、projects 迁移前置四处共用
  custom_runtime.rs          # 自定义 Runtime：用户登记命令，直接在已校验的隔离目录中运行；相对路径拒写；无密钥/会话/MCP；不支持恢复
  coding.rs                  # 编程项目 git 原语：worktree list / 从基准或已有本地·远程分支建树（~/ccode/worktrees）、
                             # origin 身份 + 相对上游 behind、fetch / pull --ff-only / push、合并进基准、
                             # Desktop CLI 打开该树 / gh --web 开 PR（CodingOpDto；不走科研工作区库）；overview 按树/分支并行 git
  workspaces.rs              # 任务工作区（§6.10）：worktree + ccode/<name> 分支 CRUD、files-to-copy、CCODE_PORT、
                             # setup/archive 钩子、评审合并（health/merge/PR）、artifacts.yaml、
                             # 人工事项状态（human_task_checks 勾选 + human_target_hit 落点检测 + human_target_count 命中计数/to-fetch 清单计数——
                             # 计数口径与前端 step-flow.ts parseToFetchItems 双端镜像：编号/列表行都算，裸行须带「 — DOI」尾巴，说明行与「待补」不算）、import_human_deliverable
                             # 交付导入（复制落点 + 登记提货单；v3.74 起 step/title 可选 + target_override 固定落点，
                             # 无步骤语境 = papers/imports/ 检索结果导入落主仓）、list_help_requests（.ccode/help-wanted.md 人工请求扫描）
                             # 非 Git 产物冻结/带回（workspace_review_deliverables / apply_delivery_review）；workspace_delivery_skip 逐个勾掉不带回
                             # （skipped.json 按 SHA-256 记，归档守卫对勾掉的同一版放行，见 pipeline.md）
  portwatch.rs               # 端口监控：LISTEN 列表、归属标注（cwd 最长前缀，回落 CCODE_PORT 段）、校验后 SIGTERM
  ws_settings.rs             # .ccode/settings.toml 三层合并（用户→仓库→local）；开步自动写 quarto 渲染脚本
  git_info.rs                # git 状态/累计 diff/逐 hunk/勾选提交临时索引；
                             # MERGE_HEAD → merging + git_abort_merge；porcelain 冲突码归 U
  fs_tree.rs                 # 文件树与文件操作（删除走系统回收站 trash；重要路径删除保护，canonicalize 双校验；
                             # list_dir 可选 withCounts：文件夹带 child_count（同一套隐藏规则，数到 1000 封顶，默认不数）；
                             # existing_files：聊天回复里提到的路径哪些是 cwd 内的文件（只看元数据，返回原样路径 + 规范化绝对路径）；
                             # list_recent_files：项目里最近改过的文件（不限类型，跳过点开头与依赖 / 构建目录，扫 2 万个后按修改时间取前 300；只读元数据），
                             #   与 list_office_docs 共用 office_walk（exts=None 不限类型）；
                             # drop_ris_record / drop_fetch_line：移出时整份改写超过 256 KB 的 RIS 与 to-fetch.md（to-fetch.md 开头「还没有全文的 N 篇」按剩下没打 ✓ 的行重算）
                             # read_research_ledger / save_research_ledger：科研台账整份读写（16 MB 上限，白名单
                             #   papers/included.json|included.md|to-fetch.md|to-fetch.ris|endnote-import.ris|screening.md、
                             #   notes/index.json、references.bib；带版本防覆盖，与预览保存同锁）——预览通道 256 KB 截断，
                             #   两百篇带摘要的纳入清单就超；台账读写禁止回落预览通道
                             #   家目录直下系统目录标 isSystem 供前端置灰）
                             # fs_create_file / fs_rename_path / fs_move_path / fs_duplicate_path / fs_import_paths：与删除同口径的文件操作，
                             #   拖入只复制 attach_grants::user_supplied 登记过的源
                             # read_file_preview 非 UTF-8 用 chardetng 认编码（UTF-16 认 BOM），save_file_preview 按 encoding 写回、表示不了的字拒绝；台账通道不认编码
                             # watch_file：单文件监听（非递归盯所在文件夹、只认这个文件名，300ms 防抖），预览跟随磁盘变化
  office_view.rs             # Office 预览补强：docx_features（mammoth 丢掉的公式 / 修订 / 批注 / 页眉页脚计数）、slides_outline（pptx 逐页大纲）、
                             #   office_converter / office_to_pdf（LibreOffice 转 PDF 到 config tmp，白名单内，超时杀树）
  pdf.rs                     # PDF/docx 字节读取：read_pdf_bytes 白名单 + canonicalize + 上限，base64 传输
                             #   （白名单根含 ccode/tmp 粘贴图与 phone_drop 暂存区，精确路径含 attach_grants 登记的文件）；
                             #   grant_media_url：白名单通过后 asset_protocol_scope().allow_file 只放行这一个音视频文件；
                             #   collect_whitelist / whitelisted_target 供只要路径的调用方复用；file_stamp = 大小 + 修改毫秒（预览缓存换版判定）
  attach_grants.rs           # 用户亲手交来的文件（拖进窗口的原生事件 / pick_attachment_files 选择器）进程内登记，供读取白名单按精确路径放行；
                             #   拖进来的文件夹另登记一张表，user_supplied 供「拖进文件页 = 复制」判定；
                             #   前端传来的路径不登记（红线）
  phone_drop.rs              # 从手机添加（2026-10-20，docs/design-phone-drop.md；安全口径 safety.md 同名条）：人点了才在各张局域网
                             #   网卡的私网 IPv4 上同端口起 tiny_http 收件服务（单线程轮询；令牌在路径、Host 校验、错令牌/未知路径同一个 404、只收不出），
                             #   2026-10-21 记住这台手机：/p/<配对令牌>/ 扫码即配对（pair）→ /d/<设备令牌>/ 主屏网页；配对簿
                             #   phone-devices.json 只存令牌 SHA-256、最多 8 台、可移除，另记固定端口与地址偏好；电脑 mDNS 名
                             #   （mdns_hostname）作二维码主机，start_with 可注入网卡/电脑名/暂存区/配对簿供测试，
                             #   同日常驻等候：配对簿 standby 开且有配对手机时 ensure_standby 随 Mesa 开着只认 /d/，主动接收结束自动转回，
                             #   比网卡换绑（Win/Linux 变更通知 + 兜底轮询，macOS 4 秒轮询）；命令 phone_drop_sync / phone_drop_set_standby，
                             #   停止 / 30 分钟无新内容 / 退出（lib.rs ExitRequested）即关；手机页 resources/phone-drop/ 三文件 include_str!；
                             #   收到的落 <配置根>/phone-inbox/（索引 items.json 进程锁+文件锁+原子写，7 天清理，.part 1 小时）；
                             #   place_into 只走已有入口（PDF save_paper_bytes / 图片 reader::write_notes_asset / 文字 projects::append_clip_at，
                             #   编程项目与其他文件拒）；事件 phone-drop-state / -incoming / -item；ignored 测试 live_lan_session 供真机点验
  sheet_preview.rs           # Excel/ODS 预览：同一套白名单读字节，calamine 抽指定工作表（200×256）+
                             #   xlsx 合并区（load_merged_regions，裁进窗口）
  ccode_home.rs              # 工作副本家目录（默认 ~/ccode，可在设置换到别的盘，实际根 <所选>/ccode）：current()
                             #   只管新建落点，all_roots()/all_sub() 管「是不是 Mesa 自己的」判定；进程内缓存，
                             #   测试态恒默认；validate_base 校验、next_history 维护曾用根。红线见 architecture §10 2026-10-18
  storage.rs                 # 本机文件持久化原语：跨进程读改写锁、私有临时文件（0600）、安全替换
  ui_zoom.rs                 # 界面缩放 + 最小窗口尺寸：webview 原生 zoom（改 devicePixelRatio，画布重画才清楚，不用 CSS zoom）；最小尺寸 = 网页 720×480 × 缩放，封顶最小屏可用区 90%；update_settings 带 uiZoom 时与开机 setup 调
  uninstall.rs               # 一键卸载：Mesa 独占目录（配置 ccode/、~/ccode/、本机数据 ccode/、
                             #   com.ccode.dev 的网页数据）移入回收站；浏览器桥清单与 Windows
                             #   注册表键复用 browser_bridge 的目录表。课题文件夹与各 CLI 数据不动
  updater.rs                 # CLI 安装/更新（brew TUNA、npm_for 同目录 npm、Windows winget 渠道：claude/codex/opencode/kimi/grok 五家有官方包）+ 应用自身 Tauri updater；
                             #   run_streaming_pty/run_streaming/emit_done/winget_args 为 pub(crate)，dep_check 复用同一管线
  watch_review.rs            # 定时巡检产物评审：工作目录可复用，但评审和采纳只读每次执行冻结的副本
                             #   （freeze_at 返回这轮改动数＝契约文件变化 + 新 PDF，0 = 无新内容；2026-10-23）
                             #   （2026-10-13 起：new_hits_of 评审只列该次新命中=after−initial；watch_run_decide 校验冻结证据并对已采纳运行拒绝；
                             #   决定存隔离树 .ccode/watch-review.json，文件损坏时写入 fail-closed）
                             #   **采纳按条目追加合并**（2026-10-17）：四类台账 ledger_merge＝主仓当前 + 本轮新增
                             #   （收件箱/跟进的切块在 lit_watch inbox_append_delta / followup_append_delta，已见逐行并集、
                             #   引文按键），排除只对本轮新命中生效；自定义契约产出仍整文件写入并查冲突；流程正典
                             #   （scheduler::watch_path_denied）展开与采纳都跳过；pdfsInitial/pdfsAfter 记本轮新下的 PDF
                             #   （基线文件 + 技能产出契约，与 task_review.rs 同构不合并）
  dep_check.rs               # 依赖体检 + 一键安装（git/node/quarto/tex/pymupdf/pillow）：check_dependencies（git 三态
                             #   ok/missing/clt_stub，quarto 要 --version 有版本号才 ok、否则 broken，TeX 认 xelatex/tectonic/pdflatex 任一，
                             #   拼图库问 python 能否导入）
                             #   + install_dependency（quarto 走 brew --cask / winget Posit.Quarto；tex 装 tectonic；
                             #   pymupdf/pillow 走 python -m pip，externally-managed 再加 --user；Linux 只给指引）；
                             #   缺 git 走收件箱 dep: 类别常驻提醒（不造横幅）；
                             #   2026-10-20：macOS 没有 Homebrew 时 Node.js / Python / Quarto 走官方 .pkg（mac_pkg_url 从各家版本索引挑
                             #   地址，curl 下载后 osascript「with administrator privileges」跑 installer，Mesa 碰不到密码）；
                             #   TeX 两平台都可由 Quarto 装 TinyTeX（install_tex_via_quarto，Windows 写 PATH、macOS 不写）
  win_snap.rs                # Windows 11 贴靠布局：自绘最大化按钮悬停够久，替用户按一次 Win+Z（只在 Win11、Mesa 在前台时）
  logbuf.rs                  # 诊断日志环形缓冲
  mac_fullscreen.rs          # macOS 订阅 NSWindow 将进 / 将出全屏通知，emit window:fullscreen-will-change（只报不改；前端壳底色借此跟系统动画淡变）
  diagnostics.rs             # 诊断包：系统/WebView/GPU/输入法、功能开关、日志、进程生命周期采集与 ZIP 导出；bundle_dir/BUNDLE_FILE_PREFIX 是反馈附件闸门的同一出处
  config_dump.rs             # 生效配置自省（只读，不建/不改任何用户配置文件）：dump_effective_config /
                             # export_effective_config（落 ~/Downloads/ccode-exports/ccode-effective-config-<时间戳>.json）——
                             # 快照含 generatedAt/appVersion/appSettings（with_defaults 完整 DTO）/profiles（仅 keyHint 尾号、
                             # 剔除 extra_env，绝无密钥）/hooksAttention/capabilities（复用 agent_capabilities）/
                             # workspaceSettings（传 root 时 ws_settings 三层合并终值 + 每键来源层标注）；
                             # 整份出站前过 sessions::redact_sensitive_text；设置页「诊断」区「生效配置快照」卡片消费
  process.rs                 # 后台子进程统一创建（Windows CREATE_NO_WINDOW 防 conhost 闪窗；三平台都删掉继承的 PWD——
                             #   opencode run 按 PWD 取目录，2026-10-20；PTY 那边 spawn_tracked 把 PWD 设成工作目录）+
                             # pty_command（Windows .cmd/.bat shim 深化：npm 系 CLI 解析出 JS 入口改 node 直启，
                             #   npm.cmd 走固定布局 special case；指向原生 exe 的 shim（npm 装的 Claude Code / OpenCode）
                             #   exe_from_cmd_shim 直启、无扩展名 node 脚本（CodeBuddy）认 shebang 后 node 直启——
                             #   Agent 参数不得过 cmd（2026-10-20，environment.md）；Cursor CLI 的 Windows 启动器 cursor-agent.cmd
                             #   （转手 PowerShell 脚本挑最新版本目录）由 cursor_entry_from_launcher 照同一挑法直启自带 node.exe + index.js；
                             #   解析失败才回落 cmd /c call；updater 与终端拉起共用）+
                             # BackgroundCommand::spawn_tied_to_app（Windows：挂进 app_lifetime_job「句柄关即全杀」任务组，
                             #   聊天层 Codex app-server 用，Mesa 崩溃不留孤儿）
  models.rs                  # fetch_models 拉目录（候选链 model_list_candidates：gemini 先剥版本段再拼 /v1beta/models，
                             #   strip_trailing_version_segment / ends_with_version_segment 版本段判据单一出处）+ 目录缓存 + 共享 DTO
  image_gen.rs               # 出图模型：model_kind 分类（与 src/model-kinds.ts 镜像）+ non_chat_launch_error（启动闸，
                             #   agents::validate_launch_compatibility 调）+ 按模型选接口出图（Gemini 原生→退对话接口 / 其余
                             #   OpenAI 出图接口）+ 改图 --image（Seedream 出图接口带 image / 其余 /images/edits 手拼 multipart，
                             #   不认再退带 image；Gemini inlineData）+ 设置页命令（image_gen_candidates/status/test）+ helper 入口 helper_image_cli；
                             #   红线：密钥只在本进程用、下载图片地址不带鉴权头、Target 不派生 Debug；helper_exe 试跑
                             #   `image --probe` 通过才把路径作 MESA_IMAGE_TOOL 注入 PTY（pty.rs spawn_tracked）
  lib.rs                     # 模块与 Tauri command 注册
```
