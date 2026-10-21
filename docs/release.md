# 发版与签名

发版的日常流程（版本号三处同步、CHANGELOG 先写、推 tag、确认 Release 草稿再发布）见 `AGENTS.md`「构建与运行」「本机环境档案」两节，本文只记安装包签名与各平台包的口径。

## 出哪些包

tag `v*` 触发 `.github/workflows/build.yml` 的 `package` 任务，三个包并行打：

| 包 | runner | 说明 |
|---|---|---|
| macOS Apple 芯片 `Mesa_x.y.z_aarch64.dmg` | macos-latest | 本机架构 |
| macOS Intel `Mesa_x.y.z_x64.dmg` | macos-latest | `--target x86_64-apple-darwin` 交叉编译（2026-10-20 起）；`mesa_helper` 由 `scripts/stage-sidecar.mjs` 按目标三元组编 |
| Windows `Mesa_x.y.z_x64-setup.exe` | windows-latest | 只出 NSIS（不出 MSI，原因见 workflow 注释） |

三个任务各自把更新包并进同一份 `latest.json`。`verify-release` 任务逐项核对 `windows-x86_64`、`darwin-aarch64`、`darwin-x86_64` 三个键都在、都带签名、两个 macOS 键不指向同一个包。两个 macOS 任务几乎同时收尾时，可能后写的覆盖先写的（`latest.json` 是读改写）：校验失败报「darwin-x86_64 缺失」或「darwin-aarch64 缺失」时，重跑缺的那个 `package` 任务即可，它会把自己的键并回去。

## macOS 签名公证（流程已接好，等开发者账号）

没签名的包首次打开会提示「已损坏」，用户要自己跑 `xattr -cr /Applications/Mesa.app`。签名公证后这一步就没了。

workflow 里有一步「macOS 签名公证」：六个 secrets **全部**配齐才启用，缺任何一个就照旧出未签名包（不会失败）。要启用：

1. 加入 Apple Developer Program（个人或公司，年费）。公司身份发布用公司账号，证书上的名字就是 Mesa 对外的发布者。
2. 在 Xcode 或 developer.apple.com 生成 **Developer ID Application** 证书，导入钥匙串后导出为 `.p12`（设一个导出密码）。
3. 在 appleid.apple.com 为发布用的 Apple ID 生成一个 **App 专用密码**。
4. 在 GitHub 仓库 Settings → Secrets and variables → Actions 加六个 secrets：

| secret | 值 |
|---|---|
| `APPLE_CERTIFICATE` | `.p12` 文件的 base64（`base64 -i cert.p12 \| pbcopy`） |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设的密码 |
| `APPLE_SIGNING_IDENTITY` | 证书全名，如 `Developer ID Application: 公司名 (TEAMID)`（`security find-identity -v -p codesigning` 可查） |
| `APPLE_ID` | 发布用的 Apple ID 邮箱 |
| `APPLE_PASSWORD` | 第 3 步的 App 专用密码（不是 Apple ID 登录密码） |
| `APPLE_TEAM_ID` | 开发者账号的 Team ID（10 位） |

5. 推一个 tag 打包，看「macOS 签名公证」那一步输出「已启用 macOS 签名公证」，打包步骤会多出签名与公证日志（公证要等苹果服务器，常见几分钟）。下载 dmg 装到一台没装过 Mesa 的 Mac 上，双击能直接打开、不再提示「已损坏」才算通过。
6. 通过后改 README「安装」里的 macOS 注意与「现在不做」、说明书「装不上」一节，去掉 `xattr` 的说法。

## Windows 代码签名（未做）

安装包没签名，首次运行 `setup.exe` 会被 SmartScreen 拦一下（点「更多信息」→「仍要运行」），README 与说明书已写明。要去掉这一步需要代码签名证书（OV / EV，或 Azure Trusted Signing），证书与账号确定后再接进 workflow。应用内更新走 Tauri updater 自己的签名，不受影响。

## 应用内更新的国内镜像（流程已接好，配齐就启用）

用户拍板（2026-10-20）：托管在**公司自己的对象存储 + CDN**（阿里云 OSS 一类，域名用公司的），不用第三方 GitHub 加速域名（随时会失效，
也能返回旧清单）。镜像只换下载地址：`latest.json` 里每个平台的 `signature` 原样保留，应用照旧用内置公钥校验安装包，镜像改不了包。

**怎么生效**

- 应用侧：打包时（`build.yml` 的「更新镜像地址」一步）仓库变量 `UPDATE_MIRROR_BASE` 配了，就把 `<UPDATE_MIRROR_BASE>/latest.json`
  加到 `tauri.conf.json` 的 updater 地址最前面，GitHub 排第二——Tauri 按顺序试，镜像连不上再试 GitHub。没配就只有 GitHub，
  源码里不写死任何域名。**只对配好之后打出的版本生效**：已经装在用户电脑上的旧版本仍只问 GitHub，要靠它先升到带镜像地址的版本。
- 同步：`.github/workflows/mirror-release.yml` 在 Release **正式发布（published）** 时触发（草稿阶段不同步，免得镜像先于正式发布宣布新版本），
  也能手动触发补同步某个 tag。它从 Release 取 `latest.json`，用 `scripts/mirror-latest-json.mjs` 把下载地址改成
  `<UPDATE_MIRROR_BASE>/<tag>/<文件名>`，下载这些更新包，先传包、最后传 `latest.json`，再从镜像读回核对版本号与每个包可读。
  配置不齐就跳过并在日志里写缺什么，不让发版失败。

**开通步骤**

1. 建桶：在对象存储（阿里云 OSS、腾讯云 COS 等支持 S3 兼容接口的都行）建一个桶，读权限设「公共读」，或私有桶 + CDN 回源鉴权。
2. 绑域名：用公司域名建 CDN 加速域名回源到这个桶，开 HTTPS（Tauri 正式版只认 https）。记下对外地址，比如
   `https://dl.公司域名/mesa`——这就是 `UPDATE_MIRROR_BASE`，地址里的路径（`mesa`）就是桶里的对象前缀（工作流按它算），
   CDN 要把域名根映射到桶根。`latest.json` 设成不缓存或很短（工作流上传时已带 `Cache-Control: no-cache`，CDN 侧也要遵从源站）。
3. 建一个只给这个桶写权限的 RAM 子账号 / 子用户，生成访问密钥。
4. 在 GitHub 仓库 Settings → Secrets and variables → Actions 配：

| 类型 | 名字 | 值（阿里云 OSS 举例，以厂商的 S3 兼容文档为准） |
|---|---|---|
| 变量 | `UPDATE_MIRROR_BASE` | `https://dl.公司域名/mesa` |
| 变量 | `UPDATE_MIRROR_S3_ENDPOINT` | `https://oss-cn-hangzhou.aliyuncs.com` |
| 变量 | `UPDATE_MIRROR_S3_REGION` | `oss-cn-hangzhou` |
| 变量 | `UPDATE_MIRROR_BUCKET` | 桶名 |
| secret | `UPDATE_MIRROR_ACCESS_KEY_ID` | 第 3 步的 AccessKey ID |
| secret | `UPDATE_MIRROR_ACCESS_KEY_SECRET` | 第 3 步的 AccessKey Secret |

5. 验收：手动跑一次 `mirror release`（填已发布的 tag），看摘要里列出的镜像地址都能打开；之后打一个新版本，装到一台连不上 GitHub
   的电脑上，**帮助 → 检查更新** 应能查到并装上新版本。这几步做完前，工作流与镜像地址都没在真实对象存储上跑过。
