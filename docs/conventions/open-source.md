# 开源、许可与署名

> 2026-10-12 拍板（公司身份对外发布），2026-10-26 从 AGENTS.md「已确认的产品决策」迁入。**改许可文件、署名、服务商图标、
> 预设表、依赖、「关于」页或帮助菜单前读本文件。** 硬约束摘要留在 AGENTS.md。

## 许可与署名

- Mesa 按 **Apache-2.0** 开源（LICENSE/NOTICE/package.json/Cargo.toml/README/CONTRIBUTING/关于页同步）。
- **版权落款 `泽塔前沿科技（杭州）有限公司`**——七处署名：LICENSE/NOTICE/Cargo authors/tauri.conf publisher/关于页版权行/
  macOS About 面板/gen 脚本随包清单头。中文注册名即主体名，无官方英文名不写英文。
- 仓库在公司组织 `Zeta-Techs/mesa`（2026-10-27 从个人仓库 `hongtongzhou-design/ccode` 转入）；仓库链接、updater endpoint、各处 User-Agent 一律用新地址，旧地址只靠 GitHub 跳转（见 AGENTS.md「git 推送」）。
- 贡献要求 DCO 签署。
- **名称与图标使用规则在仓库根 `TRADEMARKS.md`（2026-10-26）**：对外发布修改版须换名换图标，PR 不收图标改动。

## 预设与服务商图标

- **商业中转预设不进开源默认表**（ZetaTechs 预设已移除，恢复 architecture §10 2026-09-20 口径，`tests/presets.test.ts` 钉住）。
- 服务商小图标（`src/assets/vendor-icons/` 14 个，2026-10-28 加 Gemini、Cursor（官方账号行用；Cursor 取自 lobe-icons npm 包 `@lobehub/icons-static-svg`），2026-10-20 扩到网关库与连接行，2026-10-21 加 New API 平台标）按 lobe-icons（MIT）
  + cc-switch（MIT）署名，并附两份 MIT 全文进 `docs/licenses/THIRD-PARTY.md`。
  - **增删图标同步该节与 `npm run gen:notices`**。
  - **只给官方域名配厂商图标**（`vendor-icon.ts` 后缀表）。
  - New API 标只标「平台软件」（命中 `WALLET_HOSTS` 或配了钱包），不给任何中转站品牌做图标；其余第三方中转站 / 自建网关一律首字占位。

## 随包第三方许可清单

- 由 `npm run gen:notices` 生成：`src-tauri/resources/third-party-notices.md` 提交进仓、进 bundle.resources、`about.rs` 嵌二进制。
- **改动依赖后必须再生成**。

## 「关于」、帮助菜单与反馈

- 设置页「关于」承载版本/构建信息/版权/开源许可浮层/致谢/数据来源/隐私/反馈（文案改动同步 user-guide §13.11）。
- macOS 菜单 About 面板在 `lib.rs` setup（**编辑子菜单必须保留**，否则文本框复制粘贴失灵）。
- 顶栏「? 帮助」菜单三组入口（外链 ↗ / 应用内弹窗：反馈、诊断与日志、检查更新、关于——不跳设置页，弹窗内留去完整页的出口；
  文案改动同步 user-guide §1.6）。
- 「反馈与提需求」公司端点 `feedback.rs FEEDBACK_ENDPOINT` 配置后只走端点，未配置时由用户选发送方式（邮件应用 / 网页邮箱 / 邮箱直发）；
  诊断包随反馈出站只走后端路径白名单（safety.md）。
