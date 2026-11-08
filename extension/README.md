# Mesa 文献下载扩展（通道 C）

真实浏览器干浏览器的事：扩展在文献页加「存到 Mesa」按钮，用**真实登录会话**在页内
fetch PDF 字节，经 native messaging 送给 Mesa 的 helper 落进当前项目 `papers/`。
出版商看到的是正常登录用户的正常请求，不触发任何风控分支——不需要逐家适配。

## 安装（一次性）

1. Mesa 设置 → 网络 → 学校图书馆 → 其他方式 → **安装浏览器桥**（写入 NativeMessagingHosts 清单）。
2. Chrome/Edge 打开 `chrome://extensions` → 开「开发者模式」→「加载已解压的扩展程序」
   → 选本目录（`extension/`）。扩展 ID 固定为 `dmjplopfhbdamkihimfllomdmkfainnn`（manifest 内置 key），
   浏览器桥的 allowed_origins 只信任这个 ID。
3. 在浏览器里完成机构登录（CARSI/EZproxy，Mesa 设置页「学校图书馆」点「登录学校账号」）。

## 使用

两个入口：

- **文献页的「存到 Mesa」按钮**（有 `citation_doi` 的页面，或浏览器原生 PDF 查看器页）：
  页内 fetch 取字节（带真实会话）→ `%PDF-` 魔数校验 → native messaging → helper
  按当前项目落 papers/。地址取法：`citation_pdf_url` → 唯一 PDF 链接 → 内嵌阅读器
  地址 → ScienceDirect 三级（#pdfLink / 内嵌 JSON token 直链 / PII 构造 pdfft）。
- **工具栏图标**：有页内「存到 Mesa」按钮时点图标等同按按钮（页内 fetch 带真实
  会话）。不要对 PDF 页直接走浏览器下载——出版商对下载式请求常回 HTML
  （ScienceDirect 型），完成后扩展会删掉垃圾文件，看起来像「已删除」。
  没有内容脚本时（Chrome 内置 PDF 查看器）才回落 downloads，由通道 A 收货。
  浏览到 PDF 文档页时图标仍亮「PDF」角标。
  **前置条件**：通道 A 只收 Mesa「在浏览器打开」后 ±90 秒内落的下载——先用
  Mesa 待获取清单/雷达卡里的「在浏览器打开」调起浏览器，再点图标下载，下载
  才有人认领；自己另开标签页下的文件 Mesa 不会动。**扩展自己触发的下载**
  （图标点击、>40MB 大文件改道）会在完成后把最终落盘路径经 helper 直报
  Mesa——浏览器的下载位置改到别的文件夹也能收进；普通页面自带按钮的下载
  仍要求落在系统默认下载文件夹。超过 60MB 的文件超过 Mesa 收货上限，扩展会
  如实提示留在下载文件夹、需手动放进项目 papers/。

- 「当前项目」= 最近 24 小时内在 Mesa 里用「浏览器打开」打开过文献的项目
  （Mesa 写 helper-context.json 告知 helper：macOS 在
  `~/Library/Application Support/ccode/`，Windows 在 `%APPDATA%\ccode\`，
  Linux 在 `~/.config/ccode/`）。语境超过 24 小时过期——扩展回执会提示先回
  Mesa 对目标项目点一次「浏览器打开」，防止隔几天点的文件静默落进旧项目；
  每次收货在 `ccode/helper-receipts.jsonl`（0600）追加一条回执供报障归因。

## 代下队列（0.1.3 起）

Mesa 的「代下全文」（`src-tauri/src/paper_fetch.rs`）把要用真浏览器才取得到的文献排在队里。扩展每分钟经
native messaging 问一次（`mesa-poll-jobs`），有就在**后台标签**打开那篇的落地页，页内脚本按上面同一套取链规则取 PDF，
带任务号交回（`mesa-save-pdf` + `jobId`，入那件任务自己的项目，不看 helper-context）；取不到时报回原因
（`mesa-job-report`：captcha / login / blocked / no_pdf 附同源候选链接 / error），标签随即关掉。
一次只做一篇；间隔、每天上限、熔断都由 Mesa 定，扩展不自己重试，**不解人机验证、不填任何表**。
升级后在 `chrome://extensions` 点一次「重新加载」，新加的 alarms 权限才生效。
